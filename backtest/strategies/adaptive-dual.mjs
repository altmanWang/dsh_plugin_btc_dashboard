/**
 * 自适应多空趋势策略（adaptive-dual，1D）：唐奇安通道骨架 + 非对称出场 + 空头熊市闸门，
 * 叠加波动率目标仓位与 ATR 跟踪止损。多空双向，默认 1D、1x，只通过 ctx.target 下单。
 *
 * 起点问题（donchian-trend 1D entryWindow=5 exitWindow=10 trendWindow=50 allowShort=true，
 * 不含 funding，2020-01-01→now）：
 *   - 总收益 +1639.7%，但空头累计净亏（2024 空头 -3.0 万 USDT、2025 多空各 8/7 笔反复反手几乎全小亏）；
 *   - 2025 年 -32.4%；2024-10 起的验证段独立启动年化 -11.8% —— 单点过拟合 / 结构失效的典型特征。
 *
 * 本策略的 4 个结构性改动（默认全部启用，没有「默认关闭」的结构件；不是调参）：
 *   ① **空头只在熊市（硬规则）**：做空要求「收盘 < 长期均线 longWindow」且「长期均线下行
 *      （或中期均线已死叉到长期均线下方）」（bearMode）。长期均线向上时禁止做空 —— 直接消掉
 *      2024 震荡上行里空头 -3 万那类亏损，把做空从随机对冲变成有制度的顺势空头。
 *   ② **非对称出场**：多头用更慢的 longExitWindow（拿住趋势），空头用更快的 shortExitWindow
 *      （熊市反弹又急又猛，空头落袋要快）。依据是 BTC「慢牛快熊」的分布特征。
 *   ③ **波动率目标仓位**：新开仓权重 = min(1, volTarget / 30 日实现波动率)，高波动自动减仓，
 *      把风险预算按波动率归一（volTarget=0 时退化为恒权重 1；默认 0.5 = 50% 年化波动率目标，
 *      这是全样本回撤从 47.0% 压到 36.1% 的主要来源，且对总收益几乎没有代价）。
 *   ④ **ATR 跟踪止损**：从入场后极值回撤 atrStop × ATR 平仓，给单笔亏损硬上限，同时让赢家
 *      在趋势里多拿一段（atrStop=0 时关闭，默认 5 为启用状态；主要改善 2025 震荡年的反复小亏）。
 *   另有 reversalMode（默认 'immediate' = 唐奇安原版「出场当根按方向条件反手」）：实测改成
 *   「先空仓等下一根重新确认」会把全样本从 3135% 打到 2160%，故保留原版反手语义。
 *
 * 时序：所有判断只用当前及历史 bar（收盘后计算），信号下一根开盘成交（引擎保证），无未来函数。
 * 指标逐根递推 O(1)，参数扫描跑得动。
 *
 * ===== 冻结版默认参数（10 个）与结果（1D、1x、maker 0.0200% / taker 0.0500%） =====
 *   entryWindow=5 longExitWindow=12 shortExitWindow=6 trendWindow=50 longWindow=200
 *   bearMode='slope' reversalMode='immediate' allowShort=true atrStop=5 volTarget=0.5
 *
 *   全样本 2020-01-01→now（不含 funding，主口径）：总收益 +3135.63%、年化 66.75%、
 *     最大回撤 36.09%、Calmar 1.85、50 笔、胜率 50.00%、盈利因子 2.52、曝露率 70.47%。
 *   含 funding（离线估算 0.01%/8h）：总收益 +2269.01%、年化 59.27%、最大回撤 37.33%、Calmar 1.59。
 *   验证段 2024-10-03→now：连续口径 +116.30%（年化 46.01%、回撤 29.73%）；
 *     独立启动口径 +90.71%（年化 37.20%、回撤 29.73%、18 笔、胜率 50.00%）；
 *     含 funding 的连续口径 +99.61%（年化 40.37%、回撤 32.02%）。
 *   分年度（不含 funding）：2020 +256.3% / 2021 +74.0% / 2022 +9.6% / 2023 +97.9%
 *     / 2024 +69.0% / 2025 -0.3% / 2026（到 10 月）+42.8%。
 *   对照（同口径）：breakout-hold 4h +2585.52%（年化 62.22%、回撤 34.50%、含 funding +1792.05%）；
 *     donchian-trend 4h 稳健档 +1520.47%（年化 50.61%、回撤 38.36%）；
 *     donchian-trend 1D 起点 +1639.73%（回撤 51.78%、2025 -32.4%）。
 *
 * ⚠️ 诚实提醒：
 *   1. 参数仍在同一段历史上选过（选择偏差）；训练/验证切分、参数邻域、逐结构件归因见
 *      backtest/reports/_scratch/dev-a/FINAL-report.md。
 *   2. 收益水平高度依赖 2020-2021 与 2023-2024 两轮大牛市；2022/2025 只是「不亏」，
 *      不是稳定盈利；含 funding 口径会吃掉约 870 个百分点（长期净多头要付资金费）。
 *   3. 2022 年初那段下跌吃到的不多：「空头熊市闸门」要等长期均线走坏才放行做空；这是用
 *      「宁可少赚、不在牛市里凭空做空」换稳定性的结构性取舍。
 */
import { defineStrategy } from '../lib/strategy.mjs'
import { atrStep, maxOf, minOf, trueRange } from '../lib/indicators.mjs'

/** 结构常量（不是可调参数：改它们等于换策略，不是调参） */
const VOL_WINDOW = 30 // 实现波动率的回看根数
const VOL_MIN_SCALE = 0.35 // 波动率目标减仓的下限（再高波动也至少留 35% 仓位）
const ATR_PERIOD = 14 // ATR 周期（Wilder）

/** 一次回测的递推状态（onStart 重置；参数扫描会复用同一个策略对象，绝不能跨 run 泄漏） */
const state = {
  closes: [],
  highs: [],
  lows: [],
  atrValue: null,
  trSum: 0,
  trCount: 0,
  trendSum: 0,
  longSum: 0,
  trendMas: [],
  longMas: [],
  rets: [],
  retSum: 0,
  retSqSum: 0,
  extreme: null,
  trackedSide: 'flat',
  plan: undefined,
}

/** 解析参数（类型由 defineStrategy 的默认值约束过，这里再做边界夹取） */
function readParams(params) {
  return {
    entryWindow: Math.max(2, Math.floor(Number(params.entryWindow))),
    longExitWindow: Math.max(2, Math.floor(Number(params.longExitWindow))),
    shortExitWindow: Math.max(2, Math.floor(Number(params.shortExitWindow))),
    trendWindow: Math.max(2, Math.floor(Number(params.trendWindow))),
    longWindow: Math.max(2, Math.floor(Number(params.longWindow))),
    bearMode: String(params.bearMode),
    reversalMode: String(params.reversalMode),
    allowShort: params.allowShort === true,
    atrStop: Math.max(0, Number(params.atrStop)),
    volTarget: Math.max(0, Number(params.volTarget)),
  }
}

function resetState() {
  state.closes.length = 0
  state.highs.length = 0
  state.lows.length = 0
  state.atrValue = null
  state.trSum = 0
  state.trCount = 0
  state.trendSum = 0
  state.longSum = 0
  state.trendMas.length = 0
  state.longMas.length = 0
  state.rets.length = 0
  state.retSum = 0
  state.retSqSum = 0
  state.extreme = null
  state.trackedSide = 'flat'
  state.plan = undefined
}

/** 实现波动率（年化，小数：0.55 = 55%）。样本不足返回 null。 */
function realizedVolatility() {
  const n = state.rets.length
  if (n < 2) return null
  const mean = state.retSum / n
  const variance = state.retSqSum / n - mean * mean
  if (!(variance > 0)) return null
  return Math.sqrt(variance) * Math.sqrt(365)
}

/** 新开仓权重：波动率目标缩放（volTarget<=0 关闭，恒 1）。 */
function entryWeight(p) {
  if (!(p.volTarget > 0)) return 1
  const vol = realizedVolatility()
  if (vol === null || !(vol > 0)) return 1
  return Math.max(VOL_MIN_SCALE, Math.min(1, p.volTarget / vol))
}

export default defineStrategy({
  name: 'adaptive-dual',
  params: {
    entryWindow: 5,
    longExitWindow: 12,
    shortExitWindow: 6,
    trendWindow: 50,
    longWindow: 200,
    bearMode: 'slope',
    reversalMode: 'immediate',
    allowShort: true,
    atrStop: 5,
    volTarget: 0.5,
  },
  onStart(ctx) {
    resetState()
    const p = readParams(ctx.params)
    // warmup 只依赖真正用到的短窗口（与 donchian-trend 一致）：长期均线未就绪时只是禁止做空、
    // 中期均线未就绪时不做方向过滤 —— 不应该让「均线攒数据」阻止做多，否则独立启动的回测
    // 会白白错过开头 50 根里的趋势（2024-10 起跑就漏掉整个 11 月行情）。
    const warmup = Math.max(
      p.entryWindow + 2,
      p.longExitWindow + 2,
      p.shortExitWindow + 2,
    )
    state.plan = { p: p, warmup: warmup }
  },
  onBar(ctx, bar) {
    const plan = state.plan
    if (plan === undefined) return
    const p = plan.p
    const close = Number(bar.c)
    const high = Number(bar.h)
    const low = Number(bar.l)
    const n = state.closes.length
    const prevClose = n > 0 ? state.closes[n - 1] : null

    // ---- 递推原始序列 ----
    state.closes.push(close)
    state.highs.push(high)
    state.lows.push(low)
    if (prevClose !== null) {
      // 实现波动率：最近 VOL_WINDOW 个对数收益的均值 / 平方均值
      const ret = Math.log(close / prevClose)
      state.rets.push(ret)
      state.retSum += ret
      state.retSqSum += ret * ret
      if (state.rets.length > VOL_WINDOW) {
        const old = state.rets.shift()
        state.retSum -= old
        state.retSqSum -= old * old
      }
    }

    // ---- ATR（Wilder 递推） ----
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

    // ---- 中期趋势均线（trendWindow）与长期均线（longWindow，熊市闸门） ----
    state.trendSum += close
    if (n >= p.trendWindow) state.trendSum -= state.closes[n - p.trendWindow]
    const trendMa = n + 1 >= p.trendWindow ? state.trendSum / p.trendWindow : null
    state.trendMas.push(trendMa)

    state.longSum += close
    if (n >= p.longWindow) state.longSum -= state.closes[n - p.longWindow]
    const longMa = n + 1 >= p.longWindow ? state.longSum / p.longWindow : null
    state.longMas.push(longMa)

    const total = state.closes.length
    const trendPrev = total >= 2 ? state.trendMas[total - 2] : null
    const longPrev = total >= 2 ? state.longMas[total - 2] : null
    const longFalling = longMa !== null && longPrev !== null && longMa < longPrev

    const pos = ctx.position
    const side = pos === null || pos === undefined ? 'flat' : pos.side

    // ---- 持仓极值维护（ATR 跟踪止损用）：新开仓那一根从当前 bar 的极值重新开始 ----
    if (side !== state.trackedSide) {
      state.trackedSide = side
      state.extreme = side === 'long' ? high : side === 'short' ? low : null
    } else if (side === 'long') {
      state.extreme = state.extreme === null ? high : Math.max(state.extreme, high)
    } else if (side === 'short') {
      state.extreme = state.extreme === null ? low : Math.min(state.extreme, low)
    }

    if (total < plan.warmup) return

    // ---- 参考通道（不含当前 bar，防未来函数） ----
    const refHigh = maxOf(state.highs.slice(total - 1 - p.entryWindow, total - 1))
    const refLow = minOf(state.lows.slice(total - 1 - p.entryWindow, total - 1))
    // 非对称出场：多头慢（longExitWindow 根最低）、空头快（shortExitWindow 根最高）
    const longExitLow = minOf(state.lows.slice(total - 1 - p.longExitWindow, total - 1))
    const shortExitHigh = maxOf(state.highs.slice(total - 1 - p.shortExitWindow, total - 1))

    // ---- 趋势方向 / 突破信号 ----
    const uptrend = trendMa === null ? true : close > trendMa
    const downtrend = trendMa === null ? true : close < trendMa
    const breakoutUp = refHigh !== null && close > refHigh
    const breakoutDown = refLow !== null && close < refLow

    // ---- ① 空头熊市闸门（硬规则）：长期均线未就绪时保守地禁止做空 ----
    const bearPrice = longMa !== null && close < longMa
    const bearSlope = bearPrice && longFalling
    const bearCross = bearPrice && trendMa !== null && trendMa < longMa
    let shortGate
    if (p.bearMode === 'price') shortGate = bearPrice
    else if (p.bearMode === 'cross') shortGate = bearCross
    else if (p.bearMode === 'either') shortGate = bearPrice && (longFalling || (trendMa !== null && trendMa < longMa))
    else if (p.bearMode === 'off') shortGate = false
    else shortGate = bearSlope // 'slope'（默认）：只在长期均线明确下行时做空
    const shortAllowed = p.allowShort && shortGate

    // ---- ⑤ ATR 跟踪止损 ----
    const stopHit = state.atrValue !== null && p.atrStop > 0 && state.extreme !== null
      && ((side === 'long' && close < state.extreme - p.atrStop * state.atrValue)
        || (side === 'short' && close > state.extreme + p.atrStop * state.atrValue))

    // ---- ③ 反手许可（reversalMode）：唐奇安原版在出场当根就把「方向」反手；
    //      'immediate' = 两种反手都允许；'none' = 一律先空仓，等下一根重新确认；
    //      'long-only' / 'short-only' = 只允许其中一个方向立即反手。
    const reverseLongOk = p.reversalMode === 'immediate' || p.reversalMode === 'long-only'
    const reverseShortOk = p.reversalMode === 'immediate' || p.reversalMode === 'short-only'

    // ---- 目标方向 ----
    let want = side
    if (side === 'long') {
      if (stopHit) want = 'flat'
      else if (longExitLow !== null && close < longExitLow) {
        want = reverseShortOk && shortAllowed && downtrend ? 'short' : 'flat'
      }
    } else if (side === 'short') {
      if (stopHit) want = 'flat'
      else if (shortExitHigh !== null && close > shortExitHigh) {
        want = reverseLongOk && uptrend ? 'long' : 'flat'
      }
    } else {
      if (breakoutUp && uptrend) want = 'long'
      else if (shortAllowed && breakoutDown && downtrend) want = 'short'
    }

    if (want === side) return
    if (want === 'flat') {
      ctx.target({ side: 'flat', weight: 0, reason: 'adaptive-exit' })
    } else {
      ctx.target({ side: want, weight: entryWeight(p), reason: 'adaptive-entry' })
    }
  },
})
