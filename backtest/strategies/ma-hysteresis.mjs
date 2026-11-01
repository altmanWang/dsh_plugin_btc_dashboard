/**
 * 均线滞回带策略（MA hysteresis）：价格站上均线上轨就持有，跌破下轨才平仓。
 *
 * 为什么做这个策略（针对唐奇安"回调后二次上涨抓不住"的问题）：
 *   唐奇安要求"突破 N 根新高"才入场，所以一波上涨后的回调 → 二次上涨，必须等价格再创新高
 *   才能重新上车，中间那段经常吃不到。这个策略换了个更朴素的规则：
 *     - 只要价格在均线上轨之上，就一直持有（回调只要没跌破下轨就拿着，天然吃到二次上涨）；
 *     - 跌破下轨才平仓（避免假跌破被洗出去）；
 *     - 平仓后价格重新站上上轨就立刻再入场（不用等新高）。
 *   上下轨之间是"滞回带"（hysteresis），用来过滤均线附近的来回摩擦。
 *
 * 实测（4h、1 倍杠杆、默认费率；窗口 240 根 = 40 天、滞回带 ±0.8%）：
 *   - 2019-12 → 2026-10：年化 66.8% / 最大回撤 32.4% / Calmar 2.06（唐奇安默认档：46.5% / 59.9% / 0.78）
 *   - 2020 起：年化 62.4% / 回撤 32.4%（唐奇安稳健档：50.6% / 38.4%）
 *   - 近 3 年：年化 33.4% / 回撤 31.4%（唐奇安默认档更好：45.5% / 18.4%）
 *   ⚠️ 参数仍是历史内选的；2022 那种单边熊市依然会亏；不含资金费率。见 README「内置策略」一节。
 *
 * 参数：
 *   window       均线窗口（根数；4h 下 240 ≈ 40 天）
 *   enterBuffer  入场阈值：收盘 > MA × (1 + enterBuffer) 才买（默认 0.008 = 0.8%）
 *   exitBuffer   出场阈值：收盘 < MA × (1 - exitBuffer) 才卖（默认 0.008 = 0.8%）
 *   weight       仓位比例（0–1，默认 1）
 *   ⚠️ 换周期时 window 要按比例改：1h 约 ×4（960），1D 约 ÷6（40）。
 */
import { defineStrategy } from '../lib/strategy.mjs'

const state = {
  closes: [],
  sum: 0,
}

function readParams(params) {
  return {
    window: Math.max(3, Math.floor(Number(params.window))),
    enterBuffer: Math.max(0, Number(params.enterBuffer)),
    exitBuffer: Math.max(0, Number(params.exitBuffer)),
    weight: Math.max(0, Math.min(1, Number(params.weight))),
  }
}

function resetState() {
  state.closes.length = 0
  state.sum = 0
}

export default defineStrategy({
  name: 'ma-hysteresis',
  params: {
    window: 240,
    enterBuffer: 0.008,
    exitBuffer: 0.008,
    weight: 1,
  },
  onStart(ctx) {
    resetState()
    const p = readParams(ctx.params)
    // 预热 = window + 1：第一根有完整窗口的均线之后再开始判断
    state.plan = { p: p, warmup: p.window + 1 }
  },
  onBar(ctx, bar) {
    const plan = state.plan
    if (plan === undefined) return
    const p = plan.p
    const close = Number(bar.c)
    state.closes.push(close)
    const n = state.closes.length
    // 递推窗口和：O(1)，参数扫描才能跑得动
    if (n > p.window) state.sum -= state.closes[n - 1 - p.window]
    state.sum += close
    if (n < plan.warmup) return

    const ma = state.sum / p.window
    const side = ctx.position === null || ctx.position === undefined ? 'flat' : ctx.position.side
    const enterOk = close > ma * (1 + p.enterBuffer)
    const holdOk = close > ma * (1 - p.exitBuffer)

    let want = side
    if (side === 'long') {
      if (!holdOk) want = 'flat'
    } else if (side === 'flat') {
      if (enterOk) want = 'long'
    }
    if (want !== side) {
      ctx.target({ side: want, weight: want === 'flat' ? 0 : p.weight, reason: 'ma-hysteresis' })
    }
  },
})
