/**
 * 新增策略与指标工具的离线自检（不联网）。
 *
 * 覆盖三块：
 *   1. `backtest/lib/indicators.mjs`：SMA/EMA/ATR 的数学口径，递推版与全序列版必须一致；
 *   2. `donchian-trend` / `ema-regime` 两个策略在合成行情上的**行为**：
 *      趋势里能开多、震荡/下跌里能退出、allowShort 能开空、weight 能控制仓位、预热期不交易；
 *   3. 策略的**可复用性**：同一个策略对象连跑两次结果必须完全一致 —— 这专门抓
 *      "onStart 忘了重置模块级状态" 这类会让参数扫描悄悄算错的 bug；
 *   4. `backtest/tools/sweep.mjs` 的 grid 展开与参数解析（研究工具本身的正确性）。
 */
import { normalizeConfig } from '../backtest/lib/config.mjs'
import { ema, sma, atr, emaStep, atrStep, trueRange, maxOf, minOf } from '../backtest/lib/indicators.mjs'
import { loadStrategy, withResolvedParams } from '../backtest/lib/strategy.mjs'
import { runBacktest } from '../backtest/lib/engine.mjs'
import { computeMetrics } from '../backtest/lib/metrics.mjs'
import { expandGrid, parseArgs } from '../backtest/tools/sweep.mjs'

let failed = 0
function check(ok, label, detail) {
  const pass = ok === true
  console.log((pass ? 'ok   ' : 'FAIL ') + label + (detail === undefined || detail === '' ? '' : '  ' + detail))
  if (!pass) failed += 1
  return pass
}

const BAR_MS = 3_600_000
const START_T = Date.UTC(2024, 0, 1)

/** 由收盘价序列造 K 线（开盘=前收，high/low 给 0.2% 的影线）。 */
function makeBars(closes) {
  return closes.map((close, index) => {
    const prev = index === 0 ? close : closes[index - 1]
    return {
      t: START_T + index * BAR_MS,
      o: prev,
      h: Math.max(prev, close) * 1.002,
      l: Math.min(prev, close) * 0.998,
      c: close,
      v: 100,
    }
  })
}

/** 平台 → 上涨 → 下跌：足够让趋势策略既有开仓也有平仓。 */
function trendBars() {
  const closes = []
  for (let i = 0; i < 12; i += 1) closes.push(100)
  let price = 100
  for (let i = 0; i < 40; i += 1) { price *= 1.01; closes.push(price) }
  for (let i = 0; i < 40; i += 1) { price *= 0.985; closes.push(price) }
  return makeBars(closes)
}

function makeConfig(bars) {
  return normalizeConfig({
    bar: '1h',
    start: bars[0].t,
    end: bars[bars.length - 1].t + BAR_MS,
    initialCapital: 10000,
    leverage: 1,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
  })
}

function runStrategy(strategy, bars) {
  return runBacktest({ bars: bars, strategy: strategy, config: makeConfig(bars) })
}

// ---------------------------------------------------------------- 1) 指标数学

console.log('\n--- 1) 指标口径 ---')
{
  const smaResult = sma([1, 2, 3, 4, 5], 3)
  check(JSON.stringify(smaResult) === JSON.stringify([null, null, 2, 3, 4]), 'sma 口径', JSON.stringify(smaResult))
  check(sma([1, 2], 3).every((value) => value === null), 'sma 数据不足时全 null')

  const emaResult = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)
  // 种子 = SMA(1,2,3)=2，之后 k=0.5 递推 → 3,4,5...
  const expectEma = [null, null, 2, 3, 4, 5, 6, 7, 8, 9]
  const emaOk = emaResult.every((value, index) => (value === null && expectEma[index] === null)
    || Math.abs(value - expectEma[index]) < 1e-9)
  check(emaOk, 'ema 口径（SMA 种子 + k=2/(p+1)）', JSON.stringify(emaResult))

  // 递推版必须和全序列版一致（策略里用的是递推版；不一致就意味着实盘/扫描会偷偷偏移）
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1)
  const emaFull = ema(closes, 7)
  let emaRunning = null
  let seedSum = 0
  let mismatch = 0
  for (let i = 0; i < closes.length; i += 1) {
    if (i < 7) {
      seedSum += closes[i]
      if (i === 6) emaRunning = seedSum / 7
    } else {
      emaRunning = emaStep(emaRunning, closes[i], 7)
    }
    if (i >= 6 && Math.abs(emaRunning - emaFull[i]) > 1e-9) mismatch += 1
  }
  check(mismatch === 0, 'emaStep 递推 == 全序列 ema', '不一致 ' + String(mismatch) + ' 处')

  // ATR：high-low 恒为 2、收盘不变 → TR=2 → ATR 恒为 2
  const flatBars = makeBars(Array.from({ length: 10 }, () => 100)).map((bar) => ({
    t: bar.t, o: 100, h: 101, l: 99, c: 100, v: 1,
  }))
  const atrResult = atr(flatBars, 3)
  check(atrResult[2] === null && Math.abs(atrResult[3] - 2) < 1e-9, 'atr 首值 = 前 p 个 TR 的均值', String(atrResult[3]))
  check(atrResult.every((value, index) => index < 3 || Math.abs(value - 2) < 1e-9), 'atr 恒定波动下恒为 2')
  let atrRunning = null
  let trSum = 0
  let trCount = 0
  let atrMismatch = 0
  for (let i = 0; i < flatBars.length; i += 1) {
    const prevClose = i === 0 ? null : flatBars[i - 1].c
    const tr = trueRange(flatBars[i], prevClose)
    if (tr === null) continue
    if (atrRunning === null) {
      trSum += tr
      trCount += 1
      if (trCount >= 3) atrRunning = trSum / 3
    } else {
      atrRunning = atrStep(atrRunning, tr, 3)
    }
    if (atrRunning !== null && Math.abs(atrRunning - atrResult[i]) > 1e-9) atrMismatch += 1
  }
  check(atrMismatch === 0, 'atrStep 递推 == 全序列 atr', '不一致 ' + String(atrMismatch) + ' 处')

  check(maxOf([3, 1, 5]) === 5 && minOf([3, 1, 5]) === 1, 'maxOf / minOf')
  check(maxOf([]) === null && minOf([]) === null, 'maxOf / minOf 空数组返回 null')
}

// ---------------------------------------------------------------- 2) donchian-trend 行为

console.log('\n--- 2) donchian-trend 行为 ---')
{
  const bars = trendBars()
  const base = await loadStrategy('donchian-trend')
  check(base.name === 'donchian-trend', '能按名字加载 donchian-trend')
  const params = Object.assign({}, base.params)
  check(params.entryWindow === 36 && params.exitWindow === 36 && params.trendWindow === 120,
    '默认参数是推荐档（36/36/120）', JSON.stringify(params))
  check(params.slopeFilter === false, '稳健档开关默认关（保持交付的进攻档行为）', String(params.slopeFilter))

  // 用小窗口参数让 92 根合成 K 线也能跑出信号
  const small = withResolvedParams(base, {
    entryWindow: 5, exitWindow: 3, trendWindow: 10, atrPeriod: 3, atrStop: 0, allowShort: false, weight: 1,
  })
  const longOnly = runStrategy(small, bars)
  check(longOnly.ok === true && longOnly.trades.length >= 1, '上涨段能开多并平仓',
    'trades=' + String(longOnly.trades.length))
  check(longOnly.trades.every((trade) => trade.side === 'long'), 'allowShort=false 时只有多单')
  check(longOnly.trades.every((trade) => trade.exitReason === 'donchian'), '平仓原因记为策略', String(longOnly.trades[0] && longOnly.trades[0].exitReason))
  check(longOnly.fills.length > 0 && longOnly.fills[0].t >= bars[0].t + 10 * BAR_MS,
    '预热期内不交易（第一笔在 warmup 之后）', 'firstFillT=' + String(longOnly.fills[0] && longOnly.fills[0].t))

  // 仓位控制：weight=0.5 时首笔名义约 5000（权益 10000 × 1 倍 × 0.5）
  const half = withResolvedParams(base, {
    entryWindow: 5, exitWindow: 3, trendWindow: 10, atrPeriod: 3, atrStop: 0, allowShort: false, weight: 0.5,
  })
  const halfResult = runStrategy(half, bars)
  const firstNotional = halfResult.fills.length > 0 ? halfResult.fills[0].notional : null
  check(Number.isFinite(firstNotional) && Math.abs(firstNotional / 10000 - 0.5) < 0.05,
    'weight=0.5 时首笔名义约为权益一半', 'notional=' + String(firstNotional) + ' 占比=' + String(firstNotional === null ? null : (firstNotional / 10000).toFixed(3)))

  // allowShort：下跌段应出现空单
  const shortBoth = withResolvedParams(base, {
    entryWindow: 5, exitWindow: 3, trendWindow: 10, atrPeriod: 3, atrStop: 0, allowShort: true, weight: 1,
  })
  const both = runStrategy(shortBoth, bars)
  check(both.trades.some((trade) => trade.side === 'short'), 'allowShort=true 时下跌段能开空',
    'sides=' + both.trades.map((trade) => trade.side).join(','))

  // 稳健档：均线斜率过滤（只做均线上行 / 拐头就退出）——参数要真的生效、且能重复跑
  const slope = withResolvedParams(base, {
    entryWindow: 5, exitWindow: 3, trendWindow: 10, atrPeriod: 3, atrStop: 0, allowShort: false, slopeFilter: true, weight: 1,
  })
  const slopeResult = runStrategy(slope, bars)
  check(slopeResult.ok === true, 'slopeFilter=true 能跑通')
  check(slopeResult.strategy.params.slopeFilter === true, 'result.strategy.params 带出 slopeFilter（参数透传）')
  check(slopeResult.trades.every((trade) => trade.side === 'long'), 'slopeFilter=true 且 allowShort=false 时仍只有多单')
  const slopeAgain = runStrategy(slope, bars)
  check(JSON.stringify(slopeAgain.trades) === JSON.stringify(slopeResult.trades), 'slopeFilter 策略连跑两次结果一致')
  // 跑完 slopeFilter 再跑回关闭状态：结果必须与之前完全一致（onStart 重置 + 参数隔离）
  const backToDefault = runStrategy(small, bars)
  check(JSON.stringify(backToDefault.trades) === JSON.stringify(longOnly.trades), '切换参数后结果可复现（策略状态无泄漏）')

  // 状态复用：同一策略对象连跑两次结果必须一致（onStart 重置是否生效）
  const again = runStrategy(small, bars)
  check(JSON.stringify(again.trades) === JSON.stringify(longOnly.trades)
    && again.finalEquity === longOnly.finalEquity, '同一策略对象连跑两次结果一致（状态已重置）')
}

// ---------------------------------------------------------------- 3) ema-regime 行为

console.log('\n--- 3) ema-regime 行为 ---')
{
  const bars = trendBars()
  const base = await loadStrategy('ema-regime')
  check(base.name === 'ema-regime', '能按名字加载 ema-regime')
  const small = withResolvedParams(base, {
    fast: 3, slow: 6, trendWindow: 0, atrPeriod: 3, atrStop: 0, allowShort: false, weight: 1,
  })
  const result = runStrategy(small, bars)
  check(result.ok === true && result.trades.length >= 1, '上涨段能开多并平仓（EMA 交叉）',
    'trades=' + String(result.trades.length))
  check(result.trades.every((trade) => trade.side === 'long'), 'allowShort=false 时只有多单')
  const again = runStrategy(small, bars)
  check(JSON.stringify(again.trades) === JSON.stringify(result.trades), 'ema-regime 连跑两次结果一致')

  // 参数确实从 ctx.params 读：换 fast/slow 结果必须变（否则就是参数没生效）
  const other = runStrategy(withResolvedParams(base, {
    fast: 6, slow: 12, trendWindow: 0, atrPeriod: 3, atrStop: 0, allowShort: false, weight: 1,
  }), bars)
  check(JSON.stringify(other.fills) !== JSON.stringify(result.fills), '换参数后交易结果变化（参数生效）')
}

// ---------------------------------------------------------------- 4) ma-hysteresis 行为

console.log('\n--- 4) ma-hysteresis 行为（滞回带：拿住回调 / 跌破才走 / 站回再进）---')
{
  const base = await loadStrategy('ma-hysteresis')
  check(base.name === 'ma-hysteresis', '能按名字加载 ma-hysteresis')
  check(base.params.window === 240 && base.params.enterBuffer === 0.008 && base.params.exitBuffer === 0.008,
    '默认参数（240 根均线、±0.8% 滞回带）', JSON.stringify(base.params))

  // 单边上涨：进入后应该一直持有到期末（不会因为"没创新高"而踏空）
  const risingCloses = Array.from({ length: 80 }, (unused, index) => 100 * Math.pow(1.01, index))
  const risingBars = makeBars(risingCloses)
  const small = withResolvedParams(base, { window: 10, enterBuffer: 0.01, exitBuffer: 0.01, weight: 1 })
  const riseResult = runStrategy(small, risingBars)
  check(riseResult.trades.length === 1 && riseResult.trades[0].side === 'long',
    '单边上涨：只开一次多、持有到期末平仓', 'trades=' + String(riseResult.trades.length))
  check(riseResult.trades[0].bars > 50, '单边上涨期间没有中途被洗出去',
    '持有根数=' + String(riseResult.trades[0].bars))

  // 平台 → 上涨 → 站稳 → 回调（带内）→ 深跌破带 → 站回带内上方：应看到"持有-退出-再入场"
  const closes = []
  for (let i = 0; i < 20; i += 1) closes.push(100)          // 平台：收在均线上轨下方，不该开仓
  for (let i = 0; i < 20; i += 1) closes.push(100 + (i + 1) * 0.3) // 上涨到 106：站上均线 → 开多
  for (let i = 0; i < 60; i += 1) closes.push(106)          // 站稳：均线收敛到 106，仍远高于下轨 → 持有
  for (let i = 0; i < 8; i += 1) closes.push(105.2)         // 小回调（约 -0.75%，仍在带内）→ 不该出场
  for (let i = 0; i < 12; i += 1) closes.push(102)          // 深跌破下轨 → 出场
  for (let i = 0; i < 40; i += 1) closes.push(110)          // 重新站上上轨 → 再入场
  const scenarioBars = makeBars(closes)
  const scenario = runStrategy(small, scenarioBars)
  check(scenario.trades.length >= 2 && scenario.trades.every((trade) => trade.side === 'long'),
    '回调-再上涨场景：出现第二次做多入场（不是只抓第一次）',
    'trades=' + String(scenario.trades.length) + ' sides=' + scenario.trades.map((t) => t.side).join(','))
  const firstTrade = scenario.trades[0]
  check(firstTrade.entryT > scenarioBars[20].t,
    '平台期（价格在均线带下方）不会提前开仓', 'entryT=' + String(firstTrade.entryT))
  const secondTrade = scenario.trades[1]
  check(secondTrade !== undefined && secondTrade.entryT > scenarioBars[scenarioBars.length - 40].t
    && secondTrade.entryT < scenarioBars[scenarioBars.length - 1].t,
  '第二次入场发生在"站回上轨"之后', secondTrade === undefined ? 'null' : 'entryT=' + String(secondTrade.entryT))

  // 参数真的生效：把入场带拉到 50% → 永远进不去
  const never = withResolvedParams(base, { window: 10, enterBuffer: 0.5, exitBuffer: 0.5, weight: 1 })
  const neverResult = runStrategy(never, risingBars)
  check(neverResult.fills.length === 0, 'enterBuffer 极大时不会开仓（参数生效）', 'fills=' + String(neverResult.fills.length))

  // 可复用：同一策略对象连跑两次结果一致（onStart 重置）
  const again = runStrategy(small, risingBars)
  check(JSON.stringify(again.trades) === JSON.stringify(riseResult.trades), 'ma-hysteresis 连跑两次结果一致')
}

// ---------------------------------------------------------------- 5) breakout-hold 行为

console.log('\n--- 5) breakout-hold 行为（突破入场 + 均线滞回出场）---')
{
  const base = await loadStrategy('breakout-hold')
  check(base.name === 'breakout-hold', '能按名字加载 breakout-hold')
  check(base.params.entryWindow === 36 && base.params.ma === 240
    && base.params.enterBuffer === 0.008 && base.params.exitBuffer === 0.008,
  '默认参数（突破 36 根 / MA240 / ±0.8%）', JSON.stringify(base.params))

  const small = withResolvedParams(base, { entryWindow: 5, ma: 10, enterBuffer: 0.01, exitBuffer: 0.01, weight: 1 })

  // 单边上涨：突破入场后一直持有
  const risingBars = makeBars(Array.from({ length: 80 }, (unused, index) => 100 * Math.pow(1.01, index)))
  const riseResult = runStrategy(small, risingBars)
  check(riseResult.trades.length === 1 && riseResult.trades[0].side === 'long',
    '单边上涨：只开一次多、持有到期末', 'trades=' + String(riseResult.trades.length))
  check(riseResult.trades[0].bars > 50, '单边上涨期间没有中途被洗出去', '持有根数=' + String(riseResult.trades[0].bars))

  // 平台 → 突破上涨 → 站稳 → 带内小回调（持有）→ 跌破下轨（出场）→ 再次突破（二次入场）
  const closes = []
  for (let i = 0; i < 20; i += 1) closes.push(100)
  for (let i = 0; i < 20; i += 1) closes.push(100 + (i + 1) * 0.3)
  for (let i = 0; i < 60; i += 1) closes.push(106)
  for (let i = 0; i < 8; i += 1) closes.push(105.2)
  for (let i = 0; i < 12; i += 1) closes.push(102)
  for (let i = 0; i < 40; i += 1) closes.push(110)
  const scenarioBars = makeBars(closes)
  const scenario = runStrategy(small, scenarioBars)
  check(scenario.trades.length >= 2 && scenario.trades.every((trade) => trade.side === 'long'),
    '回调后再次突破：能二次入场做多（不是只抓第一次）',
    'trades=' + String(scenario.trades.length) + ' sides=' + scenario.trades.map((t) => t.side).join(','))
  check(scenario.trades[0].entryT > scenarioBars[20].t, '平台期（未突破）不会提前开仓',
    'entryT=' + String(scenario.trades[0].entryT))
  const second = scenario.trades[1]
  check(second !== undefined && second.entryT > scenarioBars[scenarioBars.length - 40].t
    && second.entryT < scenarioBars[scenarioBars.length - 1].t,
  '二次入场发生在重新突破之后', second === undefined ? 'null' : 'entryT=' + String(second.entryT))

  // 参数生效：入场带 50% → 永远进不去
  const never = runStrategy(withResolvedParams(base, { entryWindow: 5, ma: 10, enterBuffer: 0.5, exitBuffer: 0.01, weight: 1 }), risingBars)
  check(never.fills.length === 0, 'enterBuffer 极大时不会开仓（参数生效）', 'fills=' + String(never.fills.length))

  // 可复用：同一策略对象连跑两次结果一致
  const again = runStrategy(small, risingBars)
  check(JSON.stringify(again.trades) === JSON.stringify(riseResult.trades), 'breakout-hold 连跑两次结果一致')
}

// ---------------------------------------------------------------- 6) sweep 工具

console.log('\n--- 6) sweep 工具（grid 展开 / 参数解析）---')
{
  const grid = expandGrid('fast=3,6;allowShort=true,false')
  check(grid.axes.length === 2 && grid.combos.length === 4, 'grid 展开成笛卡尔积', '组合=' + String(grid.combos.length))
  const first = grid.combos[0]
  check(typeof first.fast === 'number' && typeof first.allowShort === 'boolean',
    'grid 值按 true/false/数字 自动转类型', JSON.stringify(first))
  let threw = false
  try { expandGrid('bad') } catch (error) { threw = true }
  check(threw, '非法 grid 片段会报错')
  let threw2 = false
  try { expandGrid('a=1,2') } catch (error) { threw2 = false }
  check(threw2 === false, '正常 grid 不报错')

  const parsed = parseArgs(['--strategy', 'donchian-trend', '--grid', 'a=1', '--walk', '0.7', '--json'])
  check(parsed.strategy === 'donchian-trend' && parsed.walk === '0.7' && parsed.json === true, 'parseArgs 解析值/开关选项')
  let threw3 = false
  try { parseArgs(['--nope', '1']) } catch (error) { threw3 = true }
  check(threw3, '未知参数报错（不静默忽略）')
  let threw4 = false
  try { parseArgs(['--strategy']) } catch (error) { threw4 = true }
  check(threw4, '缺少值报错')
}

// ---------------------------------------------------------------- 7) 指标与报告一致性

console.log('\n--- 7) 指标一致性 ---')
{
  const bars = trendBars()
  const strategy = withResolvedParams(await loadStrategy('donchian-trend'), {
    entryWindow: 5, exitWindow: 3, trendWindow: 10, atrPeriod: 3, atrStop: 0, allowShort: true, weight: 1,
  })
  const result = runStrategy(strategy, bars)
  const metrics = computeMetrics(result)
  check(Number.isFinite(metrics.totalReturnPct) && Number.isFinite(metrics.maxDrawdownPct), 'computeMetrics 能直接吃策略结果')
  check(metrics.tradeCount === result.trades.length, 'metrics 交易数 == 引擎交易数')
  check(metrics.feesTotal !== undefined && Math.abs(metrics.feesTotal - result.fees.total) < 1e-9, 'metrics 费用合计 == 引擎费用')
}

console.log('')
if (failed > 0) {
  console.log('── ' + String(failed) + ' 项失败')
  process.exitCode = 1
} else {
  console.log('全部通过')
}
