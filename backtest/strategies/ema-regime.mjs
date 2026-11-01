/**
 * 均线趋势 + 大周期过滤 + ATR 跟踪止损（EMA regime）。
 *
 * 规则（收盘后判断，下一根开盘执行）：
 *   - 快线（EMA fast）上穿慢线（EMA slow）、且收盘在 `trendWindow` 均线之上 → 做多；
 *   - 快线下穿慢线、或跌破 trendWindow 均线、或触发 ATR 跟踪止损 → 平多；
 *   - `allowShort=true` 时镜像做空（下穿 + 收盘在均线之下）；
 *   - `trendWindow=0` 关闭大周期过滤（纯双均线，信号更多、假突破也更多）。
 *
 * 推荐周期 **4h**。默认参数（fast=10 / slow=100 / trendWindow=0 / atrStop=0 / allowShort=false）是
 * 在近 3 年上扫出来的备选档：年化约 43.7%、最大回撤约 29.4%（同期 Buy&Hold 年化 42.4%、回撤 53.5%）。
 * 它和 `donchian-trend` 是**同一个问题的两种实现**：EMA 交叉的进出比唐奇安更频繁，
 * 交易更多、回撤更大；默认不开空。参数同样是历史内选出来的，别把回测当承诺。
 */
import { defineStrategy } from '../lib/strategy.mjs'
import { atrStep, emaStep, trueRange } from '../lib/indicators.mjs'

const state = {
  closes: [],
  fast: null,
  slow: null,
  atrValue: null,
  trSum: 0,
  trCount: 0,
  trendSum: 0,
  extreme: null,
  trackedSide: 'flat',
}

function readParams(params) {
  return {
    fast: Math.max(2, Math.floor(Number(params.fast))),
    slow: Math.max(3, Math.floor(Number(params.slow))),
    trendWindow: Math.max(0, Math.floor(Number(params.trendWindow))),
    atrPeriod: Math.max(1, Math.floor(Number(params.atrPeriod))),
    atrStop: Math.max(0, Number(params.atrStop)),
    allowShort: params.allowShort === true,
    weight: Math.max(0, Math.min(1, Number(params.weight))),
  }
}

function resetState() {
  state.closes.length = 0
  state.fast = null
  state.slow = null
  state.atrValue = null
  state.trSum = 0
  state.trCount = 0
  state.trendSum = 0
  state.extreme = null
  state.trackedSide = 'flat'
}

export default defineStrategy({
  name: 'ema-regime',
  params: {
    fast: 10,
    slow: 100,
    trendWindow: 0,
    atrPeriod: 14,
    atrStop: 0,
    allowShort: false,
    weight: 1,
  },
  onStart(ctx) {
    resetState()
    const p = readParams(ctx.params)
    const warmup = Math.max(p.slow + 1, p.trendWindow + 1, p.atrPeriod + 2)
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

    // ---- EMA 递推（用前 fast/slow 根的 SMA 做种子，保证与 lib/indicators 全序列版一致）
    const n = state.closes.length
    if (n === p.fast) {
      let sum = 0
      for (let i = 0; i < p.fast; i += 1) sum += state.closes[i]
      state.fast = sum / p.fast
    } else if (n > p.fast) {
      state.fast = emaStep(state.fast, close, p.fast)
    }
    if (n === p.slow) {
      let sum = 0
      for (let i = 0; i < p.slow; i += 1) sum += state.closes[i]
      state.slow = sum / p.slow
    } else if (n > p.slow) {
      state.slow = emaStep(state.slow, close, p.slow)
    }

    // ---- ATR
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

    // ---- 大周期均线（递推窗口和）
    if (p.trendWindow > 0) {
      state.trendSum += close
      if (n > p.trendWindow) state.trendSum -= state.closes[n - 1 - p.trendWindow]
    }
    const trendMa = p.trendWindow > 0 && n >= p.trendWindow ? state.trendSum / p.trendWindow : null

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

    const up = state.fast > state.slow
    const down = state.fast < state.slow
    const aboveTrend = trendMa === null ? true : close > trendMa
    const belowTrend = trendMa === null ? true : close < trendMa

    let stopHit = false
    if (state.atrValue !== null && p.atrStop > 0 && state.extreme !== null) {
      if (side === 'long' && close < state.extreme - p.atrStop * state.atrValue) stopHit = true
      if (side === 'short' && close > state.extreme + p.atrStop * state.atrValue) stopHit = true
    }

    let want = side
    if (side === 'long') {
      if (stopHit) want = 'flat'
      else if (down || !aboveTrend) want = p.allowShort && down && belowTrend ? 'short' : 'flat'
    } else if (side === 'short') {
      if (stopHit) want = 'flat'
      else if (up || !belowTrend) want = up && aboveTrend ? 'long' : 'flat'
    } else {
      if (up && aboveTrend) want = 'long'
      else if (p.allowShort && down && belowTrend) want = 'short'
    }

    if (want !== side) {
      ctx.target({ side: want, weight: want === 'flat' ? 0 : p.weight, reason: 'ema-regime' })
    }
  },
})
