/**
 * 多周期双向趋势策略（multi-timeframe dual trend）：**4h 周期**、同时做多与做空。
 *
 * 设计动机（为什么不是"给唐奇安加个 allowShort"）：
 *   1. 4h 的唐奇安多空在 2020-2026 上只有 ~1166%（远低于只做多的稳健档 1520%）：4h 级别
 *      的假突破太多，空头被打脸的次数比它贡献的下跌段收益还多。所以**空头必须更严格**：
 *      只在"日线级别的下跌趋势已确认"时才开空，而且用比多头更短的通道快速离场（非对称出场）。
 *   2. 4h 的噪声需要"大级别"来过滤，但我们只能在 4h 数据内部聚合日线（不允许跨周期读未来）：
 *      每 6 根 4h 合成一根 UTC 日线，日线收盘在当天最后一根 4h（UTC 20:00）收盘那一刻就确定，
 *      用它算日线 MA 及其多日斜率作为 regime —— 更新只发生在"日线已收完"的时点，天然无未来函数。
 *   3. 1D 上的实验说明"日线趋势 + 做空"本身有价值；本策略把它拆成
 *      「日线 regime 定方向 / 4h 通道定触发」，于是既保留了 4h 的执行精度，
 *      又拿到了日线级别才有的趋势确认。
 *   4. 非对称出场：多头慢（4h 120 根 ≈ 20 天通道 + 趋势 MA 拐头才走，拿住趋势），
 *      空头快（4h 48 根 ≈ 8 天通道回补 + 4h MA 一拐头就走，避免被反弹/逼空打爆）。
 *      这和 1D 上"多头 15 日最低 / 空头 8 日最高"的结构是同一个思路。
 *   5. 波动率目标仓位是**可选**风控（volTarget>0 才启用；默认 0=固定满仓），
 *      因为 1x 下 weight∈[0,1] 只能减不能加，默认满仓可以和基线同口径直接对比。
 *
 * 规则（全部在**收盘后**判断，委托下一根开盘执行；引擎时序天然防未来函数）：
 *   - 日线 regime（由 4h 聚合，日线收盘后才更新）：
 *       bull = 日线收盘 > 日线 MA 且 MA 多日上行；bear = 日线收盘 < 日线 MA 且 MA 多日下行。
 *   - 做多进场：收盘突破过去 entryWindow 根 4h 最高价（不含当前）且 4h 收盘 > 4h 趋势 MA 且 MA 上行，
 *       且**日线 regime 不是熊市**（日线慢变量只用来禁止"在长期熊市里抄底"）。
 *   - 做多出场：收盘跌破过去 exitWindow 根 4h 最低价，或 4h 趋势 MA 拐头向下（慢速出场，吃满趋势）。
 *   - 做空进场（严格）：收盘跌破过去 shortWindow 根 4h 最低价 且 4h 收盘 < 趋势 MA 且 MA 下行
 *       且 **日线 regime 为熊**。空头不开在牛市的回调里，这是和 base 多空扫描最大的区别。
 *   - 做空出场（快速）：收盘突破 past shortExitWindow 根 4h 最高价、或 4h MA 拐头向上、
 *       或日线转牛、或（可选）触发 shortAtrStop × ATR 的跟踪止损。
 *   - 反手：多头出场时若空头条件同时成立→直接转空；空头出场时若多头条件同时成立→直接转多
 *       （引擎会把反手拆成平仓 + 开仓两笔，费用照收；这种情况很少，不会放大手续费）。
 *   - 仓位：默认 weight=1；volTarget>0 时 weight = min(1, volTarget / 已实现年化波动率) 并夹在
 *     [0.25, 1]。只在「方向变化」或「目标权重变化 ≥ 0.2」时才调 ctx.target，避免每根产生碎单。
 *
 * 参数都是"4h 根数 / 日线天数 / 倍数"，别和 1D 策略的参数混用（1 天 = 6 根 4h）。
 * 本策略**按 4h 对齐设计**（日线聚合假设 4h 按 UTC 整点对齐、每天 6 根）；在别的周期上跑
 * 日线因子会退化/失真，onStart 里会记一条警告。
 *
 * ⚠️ 诚实提醒（交付报告与 README 里也会写）：
 *   1. 默认参数是**只用训练段 2020-01-01 → 2024-10-02 排名选出来的**，验证段
 *      （2024-10-03 → now）只用来评估、没有参与选择；但整个策略结构是在看到过全历史后设计的，
 *      仍存在选择偏差，不等于真实样本外。
 *   2. 2022/2025 这种震荡年依然是趋势策略的弱点：2025 年该策略约 -1%（同一窗口基线 +7%）。
 *   3. 主力收益来自 2020/2021/2023/2024 的多头趋势 + 2022/2025-2026 的下跌段空头，
 *      高收益依赖"趋势还会再来"这个假设。
 */
import { defineStrategy } from '../lib/strategy.mjs'
import { atrStep, maxOf, minOf, trueRange } from '../lib/indicators.mjs'

/** 一根 UTC 日 = 6 根 4h。 */
const DAY_MS = 86400000
/** ATR 周期固定（不再占参数名额：固定值便于与基线/研究结论对齐）。 */
const ATR_PERIOD = 14
/** 已实现波动率窗口（4h 根数，120 根 = 20 天）。 */
const VOL_WINDOW = 120
/** 波动率目标仓位的权重下限：太低的话在极端行情里仓位被压到没有意义。 */
const VOL_MIN_WEIGHT = 0.25
/** 目标权重变化超过这个幅度才重新调仓（控制调仓/手续费噪音）。 */
const REBALANCE_WEIGHT_STEP = 0.2
/** 4h 一年根数（24/7 市场）。 */
const BARS_PER_YEAR = 6 * 365

/**
 * 一次回测的递推状态（onStart 重置）。
 * 参数扫描会复用同一个策略对象，模块级状态绝不能跨 run 泄漏（见 donchian-trend.mjs 的教训）。
 */
const state = {
  // 4h 序列（只增不减，索引取窗口；每根 push 一次）
  closes: [],
  highs: [],
  lows: [],
  // ATR（Wilder 递推）
  atrValue: null,
  trSum: 0,
  trCount: 0,
  // 4h 趋势均线（递推窗口和）
  trendSum: 0,
  prevTrendMa: null,
  // 日线聚合：当前未收完的日线；收完后 dailyCloses 保存日线收盘
  daily: { dayKey: null, h: 0, l: 0, c: 0 },
  dailyCloses: [],
  dailySum: 0,
  dailyMa: null,
  // 日线 MA 的历史序列（用于算"多日斜率"，单日斜率太噪）
  dailyMaHistory: [],
  dailyRegimeUp: false,
  dailyRegimeDown: false,
  // 已实现波动率（4h 对数收益的增量求和，避免每根重算 120 个收益）
  returns: [],
  retSum: 0,
  retSumSq: 0,
  // 持仓跟踪（ATR 跟踪止损用）
  extreme: null,
  trackedSide: 'flat',
  // 上一次下发的目标（用来判断是否需要调仓）
  lastSide: 'flat',
  lastWeight: 0,
  // onStart 里算好的参数与预热长度
  plan: null,
}

/** 把模块级状态清空（每次回测从零开始）。 */
function resetState() {
  state.closes.length = 0
  state.highs.length = 0
  state.lows.length = 0
  state.atrValue = null
  state.trSum = 0
  state.trCount = 0
  state.trendSum = 0
  state.prevTrendMa = null
  state.daily = { dayKey: null, h: 0, l: 0, c: 0 }
  state.dailyCloses.length = 0
  state.dailySum = 0
  state.dailyMa = null
  state.dailyMaHistory.length = 0
  state.dailyRegimeUp = false
  state.dailyRegimeDown = false
  state.returns.length = 0
  state.retSum = 0
  state.retSumSq = 0
  state.extreme = null
  state.trackedSide = 'flat'
  state.lastSide = 'flat'
  state.lastWeight = 0
  state.plan = null
}

/** 从 ctx.params 读参数并做边界夹取（类型已由 defineStrategy 的默认值约束过）。 */
function readParams(params) {
  const int = (value, min) => Math.max(min, Math.floor(Number(value)))
  return {
    entryWindow: int(params.entryWindow, 2),
    exitWindow: int(params.exitWindow, 1),
    trendWindow: int(params.trendWindow, 2),
    dailyWindow: int(params.dailyWindow, 2),
    shortWindow: int(params.shortWindow, 2),
    shortExitWindow: int(params.shortExitWindow, 1),
    shortAtrStop: Math.max(0, Number(params.shortAtrStop)),
    // 日线 regime 的斜率确认天数：MA 要相对 N 天前更高/更低才算"上行/下行"。
    // 单日斜率在震荡市会来回翻，多日斜率才是"大级别趋势真的在走"的稳健口径（震荡过滤的一部分）。
    regimeSlopeDays: int(params.regimeSlopeDays, 1),
    volTarget: Math.max(0, Number(params.volTarget)),
    allowShort: params.allowShort === true,
  }
}

/**
 * 收完一根日线：把日线收盘推进 dailyCloses，更新日线 MA 与上一根的 MA（斜率用）。
 * 调用时机有两处（都在"该日所有 4h 已收盘"之后）：
 *   - 当天最后一根 4h（UTC 20:00 那根）收盘后；
 *   - 数据有缺口、跨日才发现上一根日线没收完时（降级为跨日收线，仍不使用未来）。
 */
function finalizeDay() {
  const daily = state.daily
  if (daily.dayKey === null) return
  const closes = state.dailyCloses
  closes.push(daily.c)
  state.dailySum += daily.c
  const window = state.plan.p.dailyWindow
  if (closes.length > window) {
    state.dailySum -= closes[closes.length - 1 - window]
  }
  state.dailyMa = closes.length >= window ? state.dailySum / window : null
  // 多日斜率：把日线 MA 推进历史序列，和 N 天前的值比较（N = regimeSlopeDays）
  const history = state.dailyMaHistory
  history.push(state.dailyMa)
  const lag = state.plan.p.regimeSlopeDays
  const refIndex = history.length - 1 - lag
  const refMa = refIndex >= 0 ? history[refIndex] : null
  state.dailyRegimeUp = state.dailyMa !== null && refMa !== null && state.dailyMa > refMa
  state.dailyRegimeDown = state.dailyMa !== null && refMa !== null && state.dailyMa < refMa
  // 标记"当前日已收完"：下一根 4h 要么属于新的一天（重新开始聚合），要么是缺口
  daily.dayKey = null
}

export default defineStrategy({
  name: 'multi-tf-dual',
  params: {
    entryWindow: 36, // 多头突破窗口（4h 根，36 = 6 天），与基线稳健档同口径
    exitWindow: 120, // 多头通道出场窗口（4h 根，120 = 20 天）：慢出场，拿住趋势
    trendWindow: 200, // 4h 趋势均线（200 根 ≈ 33 天）：比基线 120 更慢，减少均线附近的来回摩擦
    dailyWindow: 225, // 日线 regime 均线（225 天 ≈ "MA200 熊市开关"，用邻域平台中心值而非尖峰）
    shortWindow: 24, // 空头破位窗口（4h 根，24 = 4 天，比多头更严格/更短）
    shortExitWindow: 48, // 空头回补窗口（4h 根，48 = 8 天）：非对称快出场，避免被反弹打爆
    shortAtrStop: 0, // 空头 ATR 跟踪止损倍数（0=关）；通道回补已经够快，ATR 止损反而增加反手次数
    regimeSlopeDays: 10, // 日线 MA 斜率确认天数（10 天）：单日斜率太噪，多日才算"大级别在走"
    volTarget: 0, // 年化波动率目标（0=固定满仓；>0 时按 target/已实现波动率减仓，见参数敏感性）
    allowShort: true, // 是否允许做空（消融实验用）
  },

  onStart(ctx) {
    resetState()
    const p = readParams(ctx.params)
    // 预热：4h 各个窗口都要够，ATR 也要攒够种子 TR。
    // 日线 MA 的预热**不阻塞开仓**：日线 regime 未就绪时只禁止做空、允许做多
    // （否则 2020 年 1-4 月的行情会被 100 天日线预热整段浪费掉）。
    const warmup = Math.max(
      p.entryWindow + 2,
      p.exitWindow + 2,
      p.trendWindow + 1,
      p.shortWindow + 2,
      p.shortExitWindow + 2,
      ATR_PERIOD + 2,
    )
    state.plan = { p: p, warmup: warmup }
    // 日线聚合依赖 4h 按 UTC 整点对齐、每天 6 根；别的周期跑会失真，如实提醒而不是假装能跑
    if (ctx.config !== null && ctx.config !== undefined && ctx.config.bar !== undefined && ctx.config.bar !== '4h') {
      ctx.log('multi-tf-dual 按 4h 设计（日线=6 根 4h 聚合）；当前周期 ' + String(ctx.config.bar) + '，日线因子会失真')
    }
  },

  onBar(ctx, bar) {
    const plan = state.plan
    if (plan === null) return
    const p = plan.p
    const close = Number(bar.c)
    const high = Number(bar.h)
    const low = Number(bar.l)
    const prevClose = state.closes.length > 0 ? state.closes[state.closes.length - 1] : null

    // ---- 4h 序列 ----
    state.closes.push(close)
    state.highs.push(high)
    state.lows.push(low)
    const n = state.closes.length

    // ---- ATR（Wilder：先攒够 ATR_PERIOD 个 TR 取简单平均，之后递推）----
    const tr = trueRange(bar, prevClose)
    if (tr !== null) {
      if (state.atrValue === null) {
        state.trSum += tr
        state.trCount += 1
        if (state.trCount >= ATR_PERIOD) state.atrValue = state.trSum / ATR_PERIOD
      } else {
        state.atrValue = atrStep(state.atrValue, tr, ATR_PERIOD)
      }
    }

    // ---- 4h 趋势均线（递推窗口和）----
    state.trendSum += close
    if (n > p.trendWindow) state.trendSum -= state.closes[n - 1 - p.trendWindow]
    const trendMa = p.trendWindow > 0 && n >= p.trendWindow ? state.trendSum / p.trendWindow : null
    const trendRising = trendMa !== null && state.prevTrendMa !== null && trendMa > state.prevTrendMa
    const trendFalling = trendMa !== null && state.prevTrendMa !== null && trendMa < state.prevTrendMa
    state.prevTrendMa = trendMa

    // ---- 已实现波动率（4h 对数收益，增量求和）----
    if (prevClose !== null && prevClose > 0 && close > 0) {
      const ret = Math.log(close / prevClose)
      state.returns.push(ret)
      state.retSum += ret
      state.retSumSq += ret * ret
      if (state.returns.length > VOL_WINDOW) {
        const old = state.returns.shift()
        state.retSum -= old
        state.retSumSq -= old * old
      }
    }
    let realizedVol = null
    if (state.returns.length >= 30) {
      const count = state.returns.length
      const mean = state.retSum / count
      const variance = state.retSumSq / count - mean * mean
      realizedVol = Math.sqrt(Math.max(0, variance)) * Math.sqrt(BARS_PER_YEAR)
    }

    // ---- 日线聚合：把 4h 拼成 UTC 日线，只在"日线收完"后更新 regime ----
    const dayKey = Math.floor(bar.t / DAY_MS)
    if (state.daily.dayKey !== null && dayKey !== state.daily.dayKey) {
      // 理论上每天最后一根 4h 已经收过线；走到这里说明有缺口，降级为"跨日收线"
      finalizeDay()
    }
    if (state.daily.dayKey === null) {
      state.daily = { dayKey: dayKey, h: high, l: low, c: close }
    } else {
      state.daily.h = Math.max(state.daily.h, high)
      state.daily.l = Math.min(state.daily.l, low)
      state.daily.c = close
    }
    // 当天最后一根 4h = UTC 20:00 那根；它收盘时当天日线才算收完（此时只知道 0..i 的数据）
    const utcHour = Math.floor((bar.t % DAY_MS) / 3600000)
    if (utcHour === 20) finalizeDay()

    const dailyClose = state.dailyCloses.length > 0 ? state.dailyCloses[state.dailyCloses.length - 1] : null
    const dailyMaReady = state.dailyMa !== null && dailyClose !== null
    const dailySlopeUp = dailyMaReady && state.dailyRegimeUp === true
    const dailySlopeDown = dailyMaReady && state.dailyRegimeDown === true
    const dailyBull = dailyMaReady && dailyClose > state.dailyMa && dailySlopeUp
    const dailyBear = dailyMaReady && dailyClose < state.dailyMa && dailySlopeDown

    // ---- 持仓极值维护（ATR 跟踪止损用）：新开仓那根从当根极值重新开始 ----
    const pos = ctx.position
    const side = pos === null || pos === undefined ? 'flat' : pos.side
    if (side !== state.trackedSide) {
      state.trackedSide = side
      state.extreme = side === 'long' ? high : side === 'short' ? low : null
    } else if (side === 'long') {
      state.extreme = state.extreme === null ? high : Math.max(state.extreme, high)
    } else if (side === 'short') {
      state.extreme = state.extreme === null ? low : Math.min(state.extreme, low)
    }

    if (n < plan.warmup) return

    // ---- 通道 / 条件 ----
    // 窗口都**不含当前根**：用"过去的极值"判断当前收盘是否突破（与 donchian-trend 同口径）
    const refHigh = maxOf(state.highs.slice(n - 1 - p.entryWindow, n - 1))
    const exitLow = minOf(state.lows.slice(n - 1 - p.exitWindow, n - 1))
    const shortRefLow = minOf(state.lows.slice(n - 1 - p.shortWindow, n - 1))
    const shortExitHigh = maxOf(state.highs.slice(n - 1 - p.shortExitWindow, n - 1))

    const uptrend4h = trendMa !== null && close > trendMa
    const downtrend4h = trendMa !== null && close < trendMa

    // 多头只在"日线非熊"时开仓（日线 MA 还没就绪时视为非熊，保证 2020 年初能正常做多）
    const longEntryHit = dailyBear !== true
      && refHigh !== null && close > refHigh && uptrend4h && trendRising
    // 空头必须同时满足：熊市开关（日线 MA 下行且价格在其下方）+ 4h 破位 + 4h 趋势向下
    const shortEntryHit = p.allowShort && dailyBear === true
      && shortRefLow !== null && close < shortRefLow && downtrend4h && trendFalling

    // 空头 ATR 跟踪止损：从入场后的最低点回撤 shortAtrStop × ATR 就回补（比多头更快，防逼空）
    let shortStopHit = false
    if (state.atrValue !== null && p.shortAtrStop > 0 && state.extreme !== null) {
      if (side === 'short' && close > state.extreme + p.shortAtrStop * state.atrValue) shortStopHit = true
    }
    const shortCoverHit = side === 'short' && (
      shortStopHit === true
      || (shortExitHigh !== null && close > shortExitHigh)
      || trendRising === true
      || dailyBull === true
    )

    // ---- 目标方向（状态机；多空条件是互斥的，反手很少见）----
    let want = side
    let reason = ''
    if (side === 'long') {
      const exitHit = (exitLow !== null && close < exitLow) || trendFalling === true
      if (exitHit) {
        if (shortEntryHit) { want = 'short'; reason = 'long→short 反手' } else { want = 'flat'; reason = '多头出场' }
      }
    } else if (side === 'short') {
      if (shortCoverHit) {
        if (longEntryHit) { want = 'long'; reason = 'short→long 反手' } else { want = 'flat'; reason = '空头回补' }
      }
    } else {
      if (longEntryHit) { want = 'long'; reason = '多头突破' }
      else if (shortEntryHit) { want = 'short'; reason = '空头破位' }
    }

    // ---- 目标权重：波动率目标（1x 下只能减仓；volTarget=0 退化为满仓）----
    let weight = 1
    if (p.volTarget > 0 && realizedVol !== null && realizedVol > 0) {
      weight = Math.max(VOL_MIN_WEIGHT, Math.min(1, p.volTarget / realizedVol))
    }
    const targetWeight = want === 'flat' ? 0 : weight

    if (want !== side) {
      ctx.target({ side: want, weight: targetWeight, reason: reason })
      state.lastSide = want
      state.lastWeight = targetWeight
    } else if (side !== 'flat' && Math.abs(targetWeight - state.lastWeight) >= REBALANCE_WEIGHT_STEP) {
      // 方向没变、但波动率目标要求明显加减仓：一次性调到位（引擎按差值单执行）
      ctx.target({ side: want, weight: targetWeight, reason: '波动率调仓' })
      state.lastWeight = targetWeight
    }
  },
})
