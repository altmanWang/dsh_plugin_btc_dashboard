/**
 * 唐奇安通道趋势策略（Donchian breakout）：最经典的"趋势跟随"骨架之一。
 *
 * 规则（全部在**收盘后**判断，信号下一根开盘执行）：
 *   - 做多进场：收盘价突破过去 `entryWindow` 根（不含当前）的最高价，且收盘价在 `trendWindow` 均线之上；
 *   - 做多出场：收盘价跌破过去 `exitWindow` 根的最低（通道出场），或触发 ATR 跟踪止损；
 *   - `allowShort=true` 时镜像做空（跌破通道且收盘价在均线之下）；
 *   - `atrStop > 0` 时用「入场后极值 ∓ atrStop × ATR」做跟踪止损，控制单笔回撤。
 *
 * 为什么用"收盘突破 + 下一根开盘执行"而不是盘中触发：引擎本身就是这个时序（防未来函数），
 * 策略里如果按收盘价算通道却假设盘中就能成交，回测会系统性高估。
 *
 * 参数都是"根数/倍数"，换周期（1h ↔ 4h）时数值需要相应缩小/放大，别混用。
 * 指标全部逐根递推（O(1) 或 O(window)），是为了让参数扫描真的跑得动 ——
 * 每根都从 ctx.window() 重算一遍 SMA 会让 3 年 1h × 上百组参数跑到几分钟以上。
 *
 * 默认参数是在 **4h** 上按"近 3 年 / 训练 2 年 + 验证 1 年"扫出来的：
 *   entryWindow=36（6 天）、exitWindow=36、trendWindow=120（20 天）、atrStop=0、allowShort=false、weight=1。
 * 2023-10 → 2026-10：年化约 45.5%、最大回撤约 18.4%（同期 Buy&Hold：年化 42.4%、回撤 53.5%）。
 *
 * **稳健档（推荐长期使用）**：`slopeFilter=true` + `exitWindow=60`。含义是"只在趋势均线仍在上行时做多、
 * 出场更慢"，代价是 3 年窗口年化降到约 34%，但把 2019-12 起的全历史最大回撤从 59.9% 压到 38.4%、
 * Calmar 从 0.78 提到 1.41（2022 那种年份从 -36% 改善到 -28%）。
 * 这是结构性改进（不是调参），walk-forward 实验里也验证过：**按年重新挑参数反而更差**（见 README「优化实验结论」）。
 *
 * ⚠️ 两个必须知道的口径：
 *   1. 参数是**在同一段历史上选出来的**（选择偏差），验证段只是同一段历史的末尾；
 *   2. 把窗口拉长到 2019-12 起，默认参数在 2022 那种反复震荡的年份会亏约 36%
 *      —— 趋势策略的天然弱点。默认参数偏"进攻"，想要更抗震荡用上面的稳健档。
 *   3. 回测不含资金费率（funding），长期持多的真实成本会再吃掉几个点/年。
 */
import { defineStrategy } from '../lib/strategy.mjs'
import { atrStep, maxOf, minOf, trueRange } from '../lib/indicators.mjs'

/** 一次回测的递推状态（onStart 重置；参数扫描会复用同一个策略对象，绝不能跨 run 泄漏） */
const state = {
  closes: [],
  highs: [],
  lows: [],
  atrValue: null,
  trSum: 0,
  trCount: 0,
  trendSum: 0,
  extreme: null,
  trackedSide: 'flat',
  prevTrendMa: null,
}

/** 把参数从 ctx.params 里读出来（类型由 defineStrategy 的默认值约束过，这里再做边界夹取） */
function readParams(params) {
  return {
    entryWindow: Math.max(2, Math.floor(Number(params.entryWindow))),
    exitWindow: Math.max(1, Math.floor(Number(params.exitWindow))),
    trendWindow: Math.max(0, Math.floor(Number(params.trendWindow))),
    atrPeriod: Math.max(1, Math.floor(Number(params.atrPeriod))),
    atrStop: Math.max(0, Number(params.atrStop)),
    allowShort: params.allowShort === true,
    // 稳健档：只在趋势均线"仍在上行"时持多、均线拐头就退出（默认关，保持交付的进攻档行为）
    slopeFilter: params.slopeFilter === true,
    weight: Math.max(0, Math.min(1, Number(params.weight))),
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
  state.extreme = null
  state.trackedSide = 'flat'
  state.prevTrendMa = null
}

export default defineStrategy({
  name: 'donchian-trend',
  params: {
    entryWindow: 36,
    exitWindow: 36,
    trendWindow: 120,
    atrPeriod: 14,
    atrStop: 0,
    allowShort: false,
    slopeFilter: false,
    weight: 1,
  },
  onStart(ctx) {
    resetState()
    // 参数在 onStart 里解析一次；onBar 里用闭包里的 p（不再每次查 ctx.params）
    const p = readParams(ctx.params)
    const warmup = Math.max(p.entryWindow + 2, p.exitWindow + 2, p.trendWindow + 1, p.atrPeriod + 2)
    state.plan = { p: p, warmup: warmup }
  },
  onBar(ctx, bar) {
    const plan = state.plan
    if (plan === undefined) return
    const p = plan.p
    const close = Number(bar.c)
    const high = Number(bar.h)
    const low = Number(bar.l)
    const prevClose = state.closes.length > 0 ? state.closes[state.closes.length - 1] : null
    state.closes.push(close)
    state.highs.push(high)
    state.lows.push(low)

    // ---- ATR（Wilder 递推）：先攒够 atrPeriod 个 TR，再用 Wilder 平滑
    const tr = trueRange(bar, prevClose)
    if (tr !== null) {
      if (state.atrValue === null) {
        state.trSum += tr
        state.trCount += 1
        if (state.trCount >= p.atrPeriod) state.atrValue = state.trSum / p.atrPeriod
      } else {
        state.atrValue = atrStep(state.atrValue, tr, p.atrPeriod)
      }
    }

    // ---- 趋势均线（递推窗口和，不用全序列 sma）
    if (p.trendWindow > 0) {
      state.trendSum += close
      if (state.closes.length > p.trendWindow) {
        state.trendSum -= state.closes[state.closes.length - 1 - p.trendWindow]
      }
    }
    const trendMa = p.trendWindow > 0 && state.closes.length >= p.trendWindow
      ? state.trendSum / p.trendWindow
      : null
    // 均线斜率：要拿上一根的均线值比（不比较的话"斜率过滤"就变成"当前值过滤"，含义完全不同）
    const trendRising = trendMa !== null && state.prevTrendMa !== null && trendMa > state.prevTrendMa
    const trendFalling = trendMa !== null && state.prevTrendMa !== null && trendMa < state.prevTrendMa
    state.prevTrendMa = trendMa

    const pos = ctx.position
    const side = pos === null || pos === undefined ? 'flat' : pos.side

    // ---- 持仓极值维护：新开仓那一根从当前 bar 的极值重新开始
    if (side !== state.trackedSide) {
      state.trackedSide = side
      state.extreme = side === 'long' ? high : side === 'short' ? low : null
    } else if (side === 'long') {
      state.extreme = state.extreme === null ? high : Math.max(state.extreme, high)
    } else if (side === 'short') {
      state.extreme = state.extreme === null ? low : Math.min(state.extreme, low)
    }

    if (state.closes.length < plan.warmup) return

    const n = state.closes.length
    const refHigh = maxOf(state.highs.slice(n - 1 - p.entryWindow, n - 1))
    const refLow = minOf(state.lows.slice(n - 1 - p.entryWindow, n - 1))
    const exitHigh = maxOf(state.highs.slice(n - 1 - p.exitWindow, n - 1))
    const exitLow = minOf(state.lows.slice(n - 1 - p.exitWindow, n - 1))
    const uptrend = trendMa === null ? true : close > trendMa
    const downtrend = trendMa === null ? true : close < trendMa

    // ---- ATR 跟踪止损（距离用入场后极值算）
    let stopHit = false
    if (state.atrValue !== null && p.atrStop > 0 && state.extreme !== null) {
      if (side === 'long' && close < state.extreme - p.atrStop * state.atrValue) stopHit = true
      if (side === 'short' && close > state.extreme + p.atrStop * state.atrValue) stopHit = true
    }

    // ---- 目标方向
    let want = side
    if (side === 'long') {
      if (stopHit) want = 'flat'
      else if (exitLow !== null && close < exitLow) want = p.allowShort && downtrend ? 'short' : 'flat'
      else if (p.slopeFilter && trendFalling) want = 'flat'
    } else if (side === 'short') {
      if (stopHit) want = 'flat'
      else if (exitHigh !== null && close > exitHigh) want = uptrend ? 'long' : 'flat'
      else if (p.slopeFilter && trendRising) want = 'flat'
    } else {
      // 空仓：突破 + 趋势方向一致才进；稳健档再加一条"均线仍在上行/下行"
      if (refHigh !== null && close > refHigh && uptrend && (p.slopeFilter !== true || trendRising)) want = 'long'
      else if (p.allowShort && refLow !== null && close < refLow && downtrend
        && (p.slopeFilter !== true || trendFalling)) want = 'short'
    }

    if (want !== side) {
      ctx.target({ side: want, weight: want === 'flat' ? 0 : p.weight, reason: 'donchian' })
    }
  },
})
