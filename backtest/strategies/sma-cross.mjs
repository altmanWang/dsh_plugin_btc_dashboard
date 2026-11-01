/**
 * `sma-cross`：双均线交叉示例策略（SMA，简单移动平均）。
 *
 * 信号口径（写清楚，否则回测结果对不上会先怀疑引擎）：
 *   - `fast` / `slow` 的单位是 **K 线根数**，跟随 `--bar`；默认 20 / 60。
 *   - 均线用 SMA 而不是 EMA：参数含义直观、没有种子/预热歧义，手算能复核。
 *     想换 EMA 只需要改 `movingAverage()` 一个函数，信号逻辑不用动。
 *   - 快线在慢线上方 → 目标做多；下方 → `allowShort=true` 做空，否则目标空仓。
 *   - **只在目标方向变化时下单**：拿当前持仓（ctx.position）和目标方向比，一致就不动，
 *     不会每根 K 线重复下单；区间一开始信号就成立（没有等到"交叉那一刻"）也会先建仓，
 *     否则一段单边行情里会一直空仓 —— 这不是策略想要的。
 *   - 参数从 `ctx.params` 读（引擎会放进合并后的只读快照；不要用 this 或模块级变量）。
 *
 * 注意：内置策略都用市价单（ctx.target → 下一根开盘价、taker 费率）。如果在策略里改用
 * ctx.limit 挂单，成交价与费率会变成 maker，报告里会分开统计。
 */
import { defineStrategy } from '../lib/strategy.mjs'

/** 默认参数（`--param fast=10` 会按这里的类型转换并覆盖）。 */
const DEFAULT_PARAMS = Object.freeze({ fast: 20, slow: 60, allowShort: false })

/** 最近 period 个收盘价的简单平均；调用方保证 closes.length >= period。 */
function movingAverage(closes, period) {
  let sum = 0
  for (let index = closes.length - period; index < closes.length; index += 1) {
    sum += closes[index]
  }
  return sum / period
}

/**
 * 参数合法性检查。放在 onBar 里而不是 onStart：引擎保证每根都调 onBar，
 * 而写错参数（fast >= slow、0 或小数）必须在第一次能判断时就报清楚，不能静默跑出个怪结果。
 */
function readParams(raw) {
  const source = raw ?? DEFAULT_PARAMS
  const fast = Number(source.fast)
  const slow = Number(source.slow)
  const allowShort = source.allowShort === true
  if (!Number.isInteger(fast) || fast < 1) {
    throw new Error('sma-cross 参数 fast 必须是 >= 1 的整数（单位：K 线根数），收到：' + JSON.stringify(source.fast))
  }
  if (!Number.isInteger(slow) || slow < 2) {
    throw new Error('sma-cross 参数 slow 必须是 >= 2 的整数（单位：K 线根数），收到：' + JSON.stringify(source.slow))
  }
  if (fast >= slow) {
    throw new Error('sma-cross 的 fast 必须小于 slow（当前 fast=' + fast + '，slow=' + slow
      + '；例如 --param fast=10 --param slow=30）')
  }
  return { fast, slow, allowShort }
}

export default defineStrategy({
  name: 'sma-cross',
  params: DEFAULT_PARAMS,

  onBar(ctx) {
    const params = readParams(ctx.params)

    // 慢线需要 slow 根收盘价，不够就是预热期，什么也不做（ctx.closes 保证只看得到 0..i）。
    const closes = ctx.closes(params.slow)
    if (closes.length < params.slow) return

    const fastMa = movingAverage(closes, params.fast)
    const slowMa = movingAverage(closes, params.slow)

    let desired
    if (fastMa > slowMa) desired = 'long'
    else if (fastMa < slowMa) desired = params.allowShort ? 'short' : 'flat'
    else return // 两条线粘在一起时保持现状，别在临界点来回翻仓

    const current = ctx.position !== null && typeof ctx.position === 'object' ? ctx.position.side : 'flat'
    if (desired === current) return

    const reason = desired === 'long'
      ? 'sma-cross 金叉做多'
      : desired === 'short'
        ? 'sma-cross 死叉做空'
        : 'sma-cross 死叉平仓'
    ctx.log(reason + '：快线 ' + fastMa.toFixed(2) + ' / 慢线 ' + slowMa.toFixed(2)
      + '（fast=' + params.fast + ' slow=' + params.slow + '）')

    if (desired === 'flat') {
      ctx.target({ side: 'flat', weight: 0, reason })
    } else {
      // 满仓：多头 → 正数量、空头 → 负数量；方向翻转由引擎拆成「先平后反」两笔。
      ctx.target({ side: desired, weight: 1, reason })
    }
  },
})
