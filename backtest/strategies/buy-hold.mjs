/**
 * `buy-hold`：最朴素的基线策略 —— 第一根 K 线就满仓做多，一直持有到期末。
 *
 * 它存在的意义是当「参照物」：任何策略如果连它都跑不过，先别怀疑参数，
 * 先看看回测的费率、区间、数据是不是搞错了。
 *
 * 两个口径要分清（报告里两个都有，别混）：
 *   - 本策略走引擎的真实撮合：第 1 根 onBar 决策 → 第 2 根开盘价成交（taker 手续费），
 *     期末按最后收盘价平仓（closeAtEnd，taker）；杠杆生效，可能被强平。
 *   - 报告里的 Buy&Hold 基准（metrics.buyHold*）是「首根收盘买入、末根收盘卖出」的现货口径，
 *     不计手续费、不加杠杆。两者数值接近但不等，这是正常的。
 *
 * 持仓/记账都交给引擎（ctx.target 只表达目标仓位），策略不自己数钱。
 */
import { defineStrategy } from '../lib/strategy.mjs'

export default defineStrategy({
  name: 'buy-hold',
  params: {},

  onBar(ctx, _bar, index) {
    if (index !== 0) return
    // weight=1 → 目标名义 = 权益 × 杠杆 × 1，即满仓。引擎会在下一根开盘价换算成数量。
    ctx.target({ side: 'long', weight: 1, reason: 'buy-hold 建仓' })
  },
})
