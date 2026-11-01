/**
 * 突破入场 + 均线滞回出场（breakout-hold）。
 *
 * 这个策略是这轮"回调 / 二次上涨"研究的结论产物，把两种结构的优点拼在一起：
 *   - **入场用突破**：收盘价同时突破过去 `entryWindow` 根最高价 且 站上 `MA × (1 + enterBuffer)`
 *     —— 买在"真正走强"的地方，避免在均线附近来回摩擦时反复进场；
 *   - **出场用均线滞回**：只有收盘跌破 `MA × (1 - exitBuffer)` 才平仓
 *     —— 上涨途中的回调只要没跌破下轨就继续持有，所以"回调 + 二次上涨"不会被洗出去；
 *     也不需要再等一次 36 根新高才能回来（它本来就没出）。
 *
 * 为什么不是"两套策略按年份切换"：walk-forward 实测（2021-2026 每年用之前数据在
 * 唐奇安默认/唐奇安稳健/ma-hysteresis/breakout-hold 里挑一个策略，当年使用）累计 +289.8%，
 * 低于固定使用本策略的 +324.8% —— **策略切换本身就是在拟合历史，不如固定一个结构**。
 *
 * 实测（4h、1x、默认费率；entryWindow=36、MA240、±0.8%）：
 *   - 2019-12 → 2026-10（6.8 年）：年化 65.1% / 最大回撤 34.5% / Calmar 1.89
 *   - 2020 起：年化 62.2% / 回撤 34.5%
 *   - 近 3 年：年化 36.4% / 回撤 27.8% / Calmar 1.31
 *   - 分年度（2020 起）：2020 +223% / 2021 +45% / 2022 **-15%** / 2023 +54% / 2024 +75% / 2025 +11% / 2026 +19%
 *   ⚠️ 参数是历史内选的（24–48 根突破窗口 × 0.8–1.5% 带子是一片平台，不是单点）；
 *      2022 仍亏损；不含资金费率。详见 README「内置策略与推荐预设」。
 *
 * 参数：
 *   entryWindow  突破窗口（根；4h 下 36 ≈ 6 天）
 *   ma           出场均线窗口（根；4h 下 240 ≈ 40 天）
 *   enterBuffer  入场带：收盘 > MA × (1 + enterBuffer)（默认 0.8%）
 *   exitBuffer   出场带：收盘 < MA × (1 − exitBuffer) 才平仓（默认 0.8%）
 *   weight       仓位比例（0–1，默认 1）
 *   ⚠️ 换周期时把窗口按比例换算：1h ≈ entry 144 / ma 960；1D ≈ entry 6 / ma 40。
 */
import { defineStrategy } from '../lib/strategy.mjs'

const state = {
  closes: [],
  highs: [],
  sum: 0,
}

function readParams(params) {
  return {
    entryWindow: Math.max(2, Math.floor(Number(params.entryWindow))),
    ma: Math.max(3, Math.floor(Number(params.ma))),
    enterBuffer: Math.max(0, Number(params.enterBuffer)),
    exitBuffer: Math.max(0, Number(params.exitBuffer)),
    weight: Math.max(0, Math.min(1, Number(params.weight))),
  }
}

function resetState() {
  state.closes.length = 0
  state.highs.length = 0
  state.sum = 0
}

export default defineStrategy({
  name: 'breakout-hold',
  params: {
    entryWindow: 36,
    ma: 240,
    enterBuffer: 0.008,
    exitBuffer: 0.008,
    weight: 1,
  },
  onStart(ctx) {
    resetState()
    const p = readParams(ctx.params)
    state.plan = { p: p, warmup: Math.max(p.ma + 1, p.entryWindow + 2) }
  },
  onBar(ctx, bar) {
    const plan = state.plan
    if (plan === undefined) return
    const p = plan.p
    const close = Number(bar.c)
    state.closes.push(close)
    state.highs.push(Number(bar.h))
    const n = state.closes.length
    // 递推窗口和（O(1)）：参数扫描要跑几千次，不能每根重算 SMA
    if (n > p.ma) state.sum -= state.closes[n - 1 - p.ma]
    state.sum += close
    if (n < plan.warmup) return

    const ma = state.sum / p.ma
    const side = ctx.position === null || ctx.position === undefined ? 'flat' : ctx.position.side

    if (side === 'long') {
      // 出场只看均线下轨：回调不深就拿着（这是"抓二次上涨"的关键）
      if (close < ma * (1 - p.exitBuffer)) {
        ctx.target({ side: 'flat', weight: 0, reason: 'breakout-hold-exit' })
      }
      return
    }
    if (side !== 'flat') return

    // 入场：突破 N 根新高，且确实站在均线上轨之上
    const refHigh = Math.max(...state.highs.slice(n - 1 - p.entryWindow, n - 1))
    if (close > refHigh && close > ma * (1 + p.enterBuffer)) {
      ctx.target({ side: 'long', weight: p.weight, reason: 'breakout-hold-entry' })
    }
  },
})
