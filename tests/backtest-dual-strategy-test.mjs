/**
 * 多空策略 `multi-tf-dual` 的离线自检（不联网）。
 *
 * 覆盖四块：
 *   1. 策略能被加载、默认参数齐全、默认允许做空；
 *   2. **行为**：单边上涨只做多；先涨后跌（日线 regime 转熊）能开出空头；
 *      allowShort=false 时只剩多头；预热期内不下单；
 *   3. **可复用性**：同一个策略对象连跑两次结果完全一致（抓 onStart 忘重置模块级状态的 bug）；
 *   4. **因果性**：把数据截断到 80% 重跑，截断前的成交与权益曲线必须与全量回测逐点一致
 *      （策略内部有 4h→日线聚合，这条专门防「日线因子偷看当天未收完的数据」）。
 *
 * 真实数据冒烟（最后一个用例）在缓存文件存在时跑默认参数，确认默认参数在真实行情上
 * 同时出现多单与空单；文件不存在则跳过，不算失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../backtest/lib/config.mjs'
import { loadStrategy, withResolvedParams } from '../backtest/lib/strategy.mjs'
import { runBacktest } from '../backtest/lib/engine.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_4H = resolve(HERE, '..', 'backtest', 'data', 'BTC-USDT-SWAP', '4h.json')

let failed = 0
function check(ok, label, detail) {
  const pass = ok === true
  console.log((pass ? 'ok   ' : 'FAIL ') + label + (detail === undefined || detail === '' ? '' : '  ' + detail))
  if (!pass) failed += 1
  return pass
}

const BAR_MS = 4 * 3_600_000
const START_T = Date.UTC(2024, 0, 1) // UTC 0 点，4h 对齐

/** 由收盘价序列造 4h K 线（开盘=前收，high/low 给 0.3% 影线）。 */
function makeBars(closes) {
  return closes.map((close, index) => {
    const prev = index === 0 ? close : closes[index - 1]
    return {
      t: START_T + index * BAR_MS,
      o: prev,
      h: Math.max(prev, close) * 1.003,
      l: Math.min(prev, close) * 0.997,
      c: close,
      v: 100,
    }
  })
}

function makeConfig(bars) {
  return normalizeConfig({
    bar: '4h',
    start: bars[0].t,
    end: bars[bars.length - 1].t + BAR_MS,
    initialCapital: 10000,
    leverage: 1,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    includeFunding: false,
  })
}

function runStrategy(strategy, bars) {
  return runBacktest({ bars: bars, strategy: strategy, config: makeConfig(bars) })
}

/** 合成行情：先涨再跌（足够长，让日线 regime 先转牛、再转熊）。 */
function riseThenFall() {
  const closes = []
  let price = 100
  for (let i = 0; i < 420; i += 1) { price *= 1.004; closes.push(price) } // ≈ +435%
  for (let i = 0; i < 380; i += 1) { price *= 0.992; closes.push(price) } // ≈ -95%（相对高点）
  return makeBars(closes)
}

function riseOnly() {
  const closes = []
  let price = 100
  // 每根 +1%：必须明显大于 makeBars 的 0.3% 影线，否则 close 永远突破不了过去 N 根的最高价
  for (let i = 0; i < 500; i += 1) { price *= 1.01; closes.push(price) }
  return makeBars(closes)
}

/** 缩短所有窗口，让 800 根合成 K 线也能触发完整的多空状态机。 */
const FAST_PARAMS = {
  entryWindow: 6,
  exitWindow: 24,
  trendWindow: 50,
  dailyWindow: 20,
  shortWindow: 6,
  shortExitWindow: 8,
  shortAtrStop: 0,
  regimeSlopeDays: 3,
  volTarget: 0,
  allowShort: true,
}

console.log('\n--- 1) 加载与默认参数 ---')
const base = await loadStrategy('multi-tf-dual')
check(base.name === 'multi-tf-dual', '能按名字加载 multi-tf-dual')
const EXPECTED_PARAMS = [
  'entryWindow', 'exitWindow', 'trendWindow', 'dailyWindow', 'shortWindow',
  'shortExitWindow', 'shortAtrStop', 'regimeSlopeDays', 'volTarget', 'allowShort',
]
const missing = EXPECTED_PARAMS.filter((key) => !Object.prototype.hasOwnProperty.call(base.params, key))
check(missing.length === 0, '默认参数齐全（10 个）', missing.length === 0 ? '' : '缺少 ' + missing.join(','))
check(base.params.allowShort === true, '默认允许做空（策略本身是双向的）')

console.log('\n--- 2) 行为：上涨只做多、先涨后跌能开空 ---')
const fast = withResolvedParams(base, FAST_PARAMS)
{
  const bars = riseOnly()
  const result = runStrategy(fast, bars)
  const sides = result.trades.map((trade) => trade.side)
  check(result.trades.length > 0, '单边上涨行情能开仓', 'trades=' + String(result.trades.length))
  check(sides.length > 0 && sides.every((side) => side === 'long'), '单边上涨行情只有多单', JSON.stringify(sides))
  check(result.trades.every((trade) => trade.pnl > 0), '单边上涨行情的多单全部盈利')
}

let fallResult = null
{
  const bars = riseThenFall()
  fallResult = runStrategy(fast, bars)
  const longCount = fallResult.trades.filter((trade) => trade.side === 'long').length
  const shortCount = fallResult.trades.filter((trade) => trade.side === 'short').length
  check(longCount > 0, '先涨后跌行情出现多单', 'long=' + String(longCount))
  check(shortCount > 0, '日线 regime 转熊后出现空单', 'short=' + String(shortCount))
  check(fallResult.trades.every((trade) => trade.entryT >= bars[0].t), '所有成交都在回测区间内')

  // allowShort=false：只剩多单（消融参数生效）
  const longOnly = runStrategy(withResolvedParams(base, Object.assign({}, FAST_PARAMS, { allowShort: false })), bars)
  const onlyLong = longOnly.trades.every((trade) => trade.side === 'long')
  check(onlyLong, 'allowShort=false 时没有空单', 'sides=' + JSON.stringify(longOnly.trades.map((trade) => trade.side)))

  // 预热期不下单：第一笔成交时间不早于 warmup 那一根
  const warmup = Math.max(
    FAST_PARAMS.entryWindow + 2, FAST_PARAMS.exitWindow + 2, FAST_PARAMS.trendWindow + 1,
    FAST_PARAMS.shortWindow + 2, FAST_PARAMS.shortExitWindow + 2, 16,
  )
  check(fallResult.trades.length > 0 && fallResult.trades[0].entryT >= bars[warmup].t,
    '预热期内不下单', 'firstEntryT=' + String(fallResult.trades[0] === undefined ? null : fallResult.trades[0].entryT)
      + ' warmupBarT=' + String(bars[warmup].t))
}

console.log('\n--- 3) 可复用性：连跑两次结果一致 ---')
{
  const bars = riseThenFall()
  const first = runStrategy(fast, bars)
  const second = runStrategy(fast, bars)
  check(JSON.stringify(first.trades) === JSON.stringify(second.trades), '同一策略对象连跑两次交易完全一致')
  check(JSON.stringify(first.equityCurve) === JSON.stringify(second.equityCurve), '同一策略对象连跑两次权益曲线完全一致')
}

console.log('\n--- 4) 因果性：截断数据重跑，截断前必须逐点一致 ---')
{
  const bars = riseThenFall()
  const cutIndex = Math.floor(bars.length * 0.8)
  const cutBars = bars.slice(0, cutIndex)
  const full = runStrategy(fast, bars)
  const cut = runStrategy(fast, cutBars)

  // 截断回测会在最后一根收盘强制平仓（closeAtEnd 的 'end' 成交），那不是信号差异：
  // 比较时排除截断点之后（含最后一根）的成交，只比「截断时刻之前已经发生的成交」。
  const cutEndT = cutBars[cutBars.length - 1].t
  const fullFillsPrefix = full.fills.filter((fill) => fill.t < cutEndT)
  const cutFills = cut.fills.filter((fill) => fill.t < cutEndT)
  const fillsEqual = fullFillsPrefix.length === cutFills.length
    && fullFillsPrefix.every((fill, index) => fill.t === cutFills[index].t && fill.side === cutFills[index].side
      && Math.abs(fill.price - cutFills[index].price) < 1e-9
      && Math.abs(fill.qty - cutFills[index].qty) < 1e-12
      && Math.abs(fill.positionAfter - cutFills[index].positionAfter) < 1e-12)
  check(fillsEqual, '截断前成交逐笔一致（无未来函数 / 无跨 run 状态泄漏）',
    'full=' + String(fullFillsPrefix.length) + ' cut=' + String(cutFills.length))

  const fullPrefix = full.equityCurve.filter((point) => point.t < cutBars[cutBars.length - 1].t)
  const cutPrefix = cut.equityCurve.filter((point) => point.t < cutBars[cutBars.length - 1].t)
  const equityEqual = fullPrefix.length === cutPrefix.length
    && fullPrefix.every((point, index) => point.t === cutPrefix[index].t
      && Math.abs(point.equity - cutPrefix[index].equity) < 1e-9)
  check(equityEqual, '截断前权益曲线逐点一致', 'points=' + String(fullPrefix.length))
}

console.log('\n--- 5) 真实数据冒烟（缓存存在时）---')
if (!existsSync(DATA_4H)) {
  console.log('skip 没有本地 4h 缓存，跳过真实数据冒烟')
} else {
  const parsed = JSON.parse(readFileSync(DATA_4H, 'utf8'))
  const all = parsed.bars.map((row) => ({ t: row[0], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }))
  const start = Date.parse('2020-01-01T00:00:00+08:00')
  const end = Date.parse('2022-01-01T00:00:00+08:00')
  const bars = all.filter((bar) => bar.t >= start && bar.t < end)
  check(bars.length > 1000, '真实数据区间 K 线足够', 'bars=' + String(bars.length))
  if (bars.length > 1000) {
    const result = runBacktest({ bars: bars, strategy: base, config: makeConfig(bars) })
    const longCount = result.trades.filter((trade) => trade.side === 'long').length
    const shortCount = result.trades.filter((trade) => trade.side === 'short').length
    check(result.trades.length > 0, '默认参数在真实行情上产生交易', 'trades=' + String(result.trades.length))
    check(longCount > 0 && shortCount > 0, '默认参数在真实 2020-2021 行情上同时出现多单与空单',
      'long=' + String(longCount) + ' short=' + String(shortCount))
    check(result.equityCurve.length === bars.length, '权益曲线长度 == K 线根数')
  }
}

console.log('')
if (failed > 0) {
  console.log('── ' + String(failed) + ' 项失败')
  process.exitCode = 1
} else {
  console.log('全部通过')
}
