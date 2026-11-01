// 回测引擎的离线自检：撮合顺序、手续费、杠杆、爆仓、资金曲线、ctx 防未来函数。
//
// 全部用合成 K 线，不联网、不读文件。断言口径对齐 backtest/SPEC.md §6（引擎语义）
// 与 §10（engine 测试覆盖清单）。运行：node tests/backtest-engine-test.mjs
import { normalizeConfig } from '../backtest/lib/config.mjs'
import { defineStrategy, resolveParams } from '../backtest/lib/strategy.mjs'
import { runBacktest } from '../backtest/lib/engine.mjs'

const HOUR = 3_600_000
const T0 = Date.UTC(2024, 0, 1) // 固定基准时间，测试可复现
const t = (i) => T0 + i * HOUR

let passed = 0
let failed = 0

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log('ok   ' + name)
  } else {
    failed += 1
    console.log('FAIL ' + name + (detail === '' ? '' : '：' + detail))
  }
}

function equal(name, actual, want) {
  ok(name, actual === want, '期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(actual))
}

/** 相对容差比较（大量算式里有除法，浮点不可能绝对相等）。 */
function close(name, actual, want, tol = 1e-6) {
  const good = typeof actual === 'number' && Number.isFinite(actual)
    && Math.abs(actual - want) <= tol * Math.max(1, Math.abs(want))
  ok(name, good, '期望 ≈' + want + '，实际 ' + actual)
}

function throws(name, fn, needle) {
  try {
    fn()
    ok(name, false, '没有抛错')
  } catch (error) {
    const message = String(error && error.message)
    ok(name, needle === undefined || message.includes(needle), '错误信息不含「' + needle + '」：' + message)
  }
}

// ---- 合成数据工具 -----------------------------------------------------------

/** rows: [open, high, low, close][]，按 1h 升序生成 Bar（v 填充一个无所谓的常数）。 */
function makeBars(rows) {
  return rows.map(([o, h, l, c], i) => ({ t: t(i), o, h, l, c, v: 100 + i }))
}

/** 用 normalizeConfig 造出真正的 Config（默认参数全走 config.mjs，不在测试里另立口径）。 */
function makeConfig(bars, overrides = {}) {
  return normalizeConfig({
    instId: 'BTC-USDT-SWAP',
    bar: '1h',
    start: T0,
    end: t(bars.length),
    initialCapital: 10000,
    leverage: 1,
    ...overrides,
  })
}

/** 跑一次回测（策略每次都新建，避免测试间串状态）。 */
function run(bars, onBar, options = {}) {
  const { config: configOverrides = {}, onStart, onEnd, params = {}, name = 'engine-test' } = options
  const config = makeConfig(bars, configOverrides)
  const strategy = defineStrategy({ name, params: { ...params }, onBar, onStart, onEnd })
  return { result: runBacktest({ bars, strategy, config }), config, strategy }
}

// ============================================================================
// 1) 基础形状：equityCurve 长度、空仓盯市、BacktestResult 字段
// ============================================================================
{
  const bars = makeBars([
    [100, 110, 90, 105],
    [105, 115, 95, 100],
    [100, 120, 80, 110],
  ])
  const { result, config } = run(bars, () => {})

  equal('基础：ok=true', result.ok, true)
  equal('基础：equityCurve 长度 === K 线根数', result.equityCurve.length, 3)
  equal('基础：range.bars', result.range.bars, 3)
  equal('基础：range.firstT = 第 0 根开盘时间', result.range.firstT, t(0))
  equal('基础：range.lastT = 最后一根开盘时间', result.range.lastT, t(2))
  equal('基础：range.start 取 config.start', result.range.start, config.start)
  equal('基础：range.end 取 config.end', result.range.end, config.end)
  equal('基础：initialEquity = 初始资金', result.initialEquity, 10000)
  equal('基础：空仓 finalEquity = 初始资金', result.finalEquity, 10000)
  ok('基础：空仓时每点 equity/cash 都是初始资金、qty=0',
    result.equityCurve.every((p) => p.equity === 10000 && p.cash === 10000 && p.qty === 0))
  ok('基础：equityCurve 每点都有 t/price 且价格=收盘价',
    result.equityCurve.every((p, i) => Number.isFinite(p.t) && p.t === bars[i].t && p.price === bars[i].c))
  equal('基础：无成交', result.fills.length, 0)
  equal('基础：无交易', result.trades.length, 0)
  equal('基础：无爆仓', result.liquidations.length, 0)
  equal('基础：无被拒委托', result.rejected.length, 0)
  equal('基础：手续费 total=0', result.fees.total, 0)
  equal('基础：手续费 count=0', result.fees.count, 0)
  equal('基础：logs 为空', result.logs.length, 0)
  equal('基础：result.strategy.name', result.strategy.name, 'engine-test')
  ok('基础：result.config 原样带回同一个对象', result.config === config)
  ok('基础：没有 NaN/Infinity', result.equityCurve.every((p) => Number.isFinite(p.equity)))
}

// ============================================================================
// 2) 市价单：taker 费率 + 买入滑点 + 收盘盯市（closeAtEnd=false）
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [200, 215, 195, 210],
    [210, 220, 205, 215],
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.market({ side: 'buy', qty: 1, reason: 'open' })
  }, { config: { slippageBps: 10, closeAtEnd: false } })

  equal('市价买入：成交 1 笔（期末不平仓）', result.fills.length, 1)
  const fill = result.fills[0]
  equal('市价买入：在下一根 K 线成交', fill.t, t(1))
  close('市价买入：成交价 = open*(1+10bp)', fill.price, 200 * 1.001)
  equal('市价买入：feeKind=taker', fill.feeKind, 'taker')
  equal('市价买入：kind=market', fill.kind, 'market')
  equal('市价买入：reason 透传', fill.reason, 'open')
  close('市价买入：taker 手续费 = qty*price*0.0005', fill.fee, 200.2 * 0.0005)
  equal('市价买入：positionAfter=1', fill.positionAfter, 1)
  close('市价买入：手续费从现金扣', result.equityCurve[0].cash, 10000)
  close('市价买入：第 1 根收盘权益 = 现金 + 浮盈', result.equityCurve[1].equity, 10000 - 0.1001 + (210 - 200.2))
  close('市价买入：第 2 根收盘权益', result.equityCurve[2].equity, 10000 - 0.1001 + (215 - 200.2))
  close('市价买入：finalEquity 按最后收盘价盯市', result.finalEquity, 10000 - 0.1001 + (215 - 200.2))
  equal('市价买入：持仓未平所以没有 trade', result.trades.length, 0)
  close('市价买入：fees.taker 合计', result.fees.taker, 0.1001)
  equal('市价买入：equityCurve[2].qty=1', result.equityCurve[2].qty, 1)
}

// ============================================================================
// 3) 市价卖出滑点 + closeAtEnd 期末平仓（taker，reason=end）
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [200, 215, 195, 210],
    [210, 220, 205, 215],
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.market({ side: 'sell', qty: 1, reason: 'open-short' })
  }, { config: { slippageBps: 10 } })

  const openFill = result.fills[0]
  close('市价卖出：成交价 = open*(1-10bp)', openFill.price, 200 * 0.999)
  close('市价卖出：taker 手续费', openFill.fee, 199.8 * 0.0005)
  equal('市价卖出：positionAfter=-1', openFill.positionAfter, -1)

  equal('期末平仓：共 2 笔成交（开仓 + 平仓）', result.fills.length, 2)
  const endFill = result.fills[1]
  equal('期末平仓：reason=end', endFill.reason, 'end')
  equal('期末平仓：feeKind=taker', endFill.feeKind, 'taker')
  close('期末平仓：成交价 = 最后收盘价（不加滑点）', endFill.price, 215)
  equal('期末平仓：positionAfter=0', endFill.positionAfter, 0)

  const trade = result.trades[0]
  equal('期末平仓：trade.side=short', trade.side, 'short')
  equal('期末平仓：exitReason=end', trade.exitReason, 'end')
  close('期末平仓：trade.qty', trade.qty, 1)
  close('期末平仓：entryPrice', trade.entryPrice, 199.8)
  close('期末平仓：exitPrice', trade.exitPrice, 215)
  close('期末平仓：fees = 开仓费 + 平仓费', trade.fees, 199.8 * 0.0005 + 215 * 0.0005)
  const gross = 199.8 - 215 // 空头毛利 = (开仓价 - 平仓价) * 数量
  close('期末平仓：pnl = 毛利 - 手续费', trade.pnl, gross - trade.fees)
  close('期末平仓：pnlPct = pnl / 名义额 * 100', trade.pnlPct, ((gross - trade.fees) / 199.8) * 100)
  close('期末平仓：finalEquity = 现金', result.finalEquity, 10000 + gross - trade.fees)
  close('期末平仓：fees.total', result.fees.total, 199.8 * 0.0005 + 215 * 0.0005)
  ok('期末平仓：没有 NaN/Infinity',
    Number.isFinite(result.finalEquity) && result.equityCurve.every((p) => Number.isFinite(p.equity)))
}

// ============================================================================
// 4) 限价单：tradeThrough + maker 费率 + 成交价=限价
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 102, 96, 101], // low=96，没跌破 95
    [101, 103, 94, 102], // low=94 < 95 → 成交
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.limit({ side: 'buy', price: 95, qty: 1, reason: 'lp' })
  })

  equal('限价 tradeThrough：限价 + 期末共 2 笔成交', result.fills.length, 2)
  const limitFill = result.fills[0]
  equal('限价 tradeThrough：第 1 根 low=96 不成交，第 2 根才成交', limitFill.t, t(2))
  equal('限价 tradeThrough：feeKind=maker', limitFill.feeKind, 'maker')
  equal('限价 tradeThrough：kind=limit', limitFill.kind, 'limit')
  close('限价 tradeThrough：成交价 = 限价', limitFill.price, 95)
  close('限价 tradeThrough：maker 手续费 = qty*price*0.0002', limitFill.fee, 95 * 0.0002)
  equal('限价 tradeThrough：reason 透传', limitFill.reason, 'lp')
  close('限价 tradeThrough：fees.maker', result.fees.maker, 95 * 0.0002)
  equal('限价 tradeThrough：fees.count = 成交笔数', result.fees.count, 2)

  const trade = result.trades[0]
  close('限价 tradeThrough：trade.entryPrice=95', trade.entryPrice, 95)
  close('限价 tradeThrough：trade.exitPrice=期末收盘 102', trade.exitPrice, 102)
  close('限价 tradeThrough：finalEquity',
    result.finalEquity, 10000 + (102 - 95) - 95 * 0.0002 - 102 * 0.0005)
}

// ============================================================================
// 5) 限价单：tradeThrough 与 touch 的边界（穿越 vs 触碰）
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 102, 96, 101],
    [101, 103, 94, 102],
  ])
  const touchRun = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.limit({ side: 'buy', price: 96, qty: 1 })
  }, { config: { limitFill: 'touch' } })
  equal('touch：买单 low==限价即成交（第 1 根）', touchRun.result.fills[0].t, t(1))

  const throughRun = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.limit({ side: 'buy', price: 96, qty: 1 })
  }, { config: { limitFill: 'tradeThrough' } })
  equal('tradeThrough：买单 low==限价不算成交，第 2 根 low 更低才成交', throughRun.result.fills[0].t, t(2))

  // 卖单：HIGH 恰好等于限价时 tradeThrough 不成交（要求严格大于）
  const sellThrough = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.limit({ side: 'sell', price: 103, qty: 1 })
  }, { config: { limitFill: 'tradeThrough' } })
  equal('tradeThrough：卖单 high==限价不成交（到期末一直没成交）', sellThrough.result.fills.length, 0)
  ok('tradeThrough：未成交委托期末丢弃并记日志',
    sellThrough.result.logs.some((log) => log.message.includes('丢弃')))

  const sellTouch = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.limit({ side: 'sell', price: 103, qty: 1 })
  }, { config: { limitFill: 'touch' } })
  equal('touch：卖单 high==限价即成交', sellTouch.result.fills[0].t, t(2))
  close('touch：卖单成交价 = 限价', sellTouch.result.fills[0].price, 103)
}

// ============================================================================
// 6) target：执行时按权益换算目标数量（含杠杆与滑点）
// ============================================================================
{
  // 6a) 2 倍杠杆、weight=1：qtyTarget = equity * leverage / fillPrice
  const bars = makeBars([
    [100, 101, 99, 100],
    [200, 215, 195, 205],
    [205, 215, 200, 210],
  ])
  let seen = null
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'long', weight: 1 })
    if (i === 1) {
      seen = {
        side: ctx.position.side,
        qty: ctx.position.qty,
        entryPrice: ctx.position.entryPrice,
        notional: ctx.position.notional,
        unrealizedPnl: ctx.position.unrealizedPnl,
        equity: ctx.equity,
        cash: ctx.cash,
      }
      ctx.target({ side: 'flat' })
    }
  }, { config: { leverage: 2 } })

  equal('target：下一根开盘成交 2 笔（开 + 平）', result.fills.length, 2)
  close('target：qtyTarget = 权益*杠杆/成交价', result.fills[0].qty, 10000 * 2 / 200)
  close('target：成交价 = 开盘价', result.fills[0].price, 200)
  equal('target：kind=market', result.fills[0].kind, 'market')
  equal('target：feeKind=taker', result.fills[0].feeKind, 'taker')
  close('target：手续费', result.fills[0].fee, 100 * 200 * 0.0005)
  equal('target：ctx.position.side', seen && seen.side, 'long')
  close('target：ctx.position.qty 为有符号持仓', seen && seen.qty, 100)
  close('target：ctx.position.entryPrice', seen && seen.entryPrice, 200)
  close('target：ctx.position.notional', seen && seen.notional, 20000)
  close('target：ctx.position.unrealizedPnl', seen && seen.unrealizedPnl, 100 * (205 - 200))
  close('target：ctx.cash 已扣手续费', seen && seen.cash, 9990)
  close('target：ctx.equity = 现金 + 浮盈', seen && seen.equity, 10490)
  close('target flat：按下一根开盘价平掉', result.fills[1].price, 205)
  equal('target flat：positionAfter=0', result.fills[1].positionAfter, 0)
  const trade = result.trades[0]
  equal('target：trade.side=long', trade.side, 'long')
  close('target：trade.pnl = 毛利-手续费', trade.pnl, 100 * (205 - 200) - (10 + 100 * 205 * 0.0005))
  close('target：finalEquity', result.finalEquity, 10000 + 500 - (10 + 100 * 205 * 0.0005))

  // 6b) 1 倍杠杆、weight=0.5、10bp 滑点：换算与成交价都用滑点后的价格
  const slipBars = makeBars([
    [100, 101, 99, 100],
    [200, 215, 195, 205],
  ])
  const slipRun = run(slipBars, (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'long', weight: 0.5 })
  }, { config: { slippageBps: 10, closeAtEnd: false } })
  const fillPrice = 200 * 1.001
  const wantQty = 10000 * 1 * 0.5 / fillPrice
  close('target+滑点：成交价 = open*(1+10bp)', slipRun.result.fills[0].price, fillPrice)
  close('target+滑点：目标数量用滑点后价格换算', slipRun.result.fills[0].qty, wantQty)
  close('target+滑点：手续费', slipRun.result.fills[0].fee, wantQty * fillPrice * 0.0005)
}

// ============================================================================
// 7) 杠杆校验：超限拒绝、1 倍满仓允许、浮点容差
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ])
  const overRun = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.market({ side: 'buy', qty: 100.5, reason: 'too-big' })
  })
  equal('杠杆拒绝：没有成交', overRun.result.fills.length, 0)
  equal('杠杆拒绝：rejected 1 条', overRun.result.rejected.length, 1)
  const rejected = overRun.result.rejected[0]
  equal('杠杆拒绝：记录时间 = 执行那根 K 线', rejected.t, t(1))
  ok('杠杆拒绝：原因含「杠杆/保证金不足」', rejected.reason.includes('杠杆/保证金不足'), rejected.reason)
  equal('杠杆拒绝：order.kind=market', rejected.order.kind, 'market')
  equal('杠杆拒绝：order.side=buy', rejected.order.side, 'buy')
  close('杠杆拒绝：order.qty', rejected.order.qty, 100.5)
  equal('杠杆拒绝：没有产生 trade', overRun.result.trades.length, 0)
  close('杠杆拒绝：权益不变', overRun.result.finalEquity, 10000)

  // 1 倍下 qty*fillPrice 刚好等于权益：必须放行（这就是"满仓"）
  const fullRun = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.market({ side: 'buy', qty: 100 })
  })
  equal('杠杆：1 倍满仓做多允许', fullRun.result.fills.length, 2) // 开仓 + 期末平仓
  close('杠杆：满仓成交数量', fullRun.result.fills[0].qty, 100)
  equal('杠杆：满仓没有 rejected', fullRun.result.rejected.length, 0)

  // 目标仓位换算会引入除法，价值为整数时也可能差几个 ulp；1e-9 容差必须放过
  const oddBars = makeBars([
    [30000, 30100, 29900, 30000],
    [30000, 30100, 29900, 30000],
  ])
  const oddRun = run(oddBars, (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'long', weight: 1 })
  })
  equal('杠杆：目标满仓（除不尽的价格）浮点误差被容差放过', oddRun.result.rejected.length, 0)
  ok('杠杆：目标满仓确实成交', oddRun.result.fills.length >= 1)
}

// ============================================================================
// 8) 多 → 空反转：平仓 trade + 新开仓，手续费按平/开两段拆
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 111, 99, 110],
    [120, 121, 117, 118],
    [100, 101, 99, 100],
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'long', weight: 1 })
    if (i === 1) ctx.target({ side: 'short', weight: 1 })
    if (i === 2) ctx.target({ side: 'flat' })
  })

  // 反手那根开盘 120：权益 = 9995 + 100*(120-100) = 11995，目标空头 = -11995/120
  const equityBeforeReverse = 9995 + 100 * (120 - 100)
  const shortQty = equityBeforeReverse / 120
  const sellQty = 100 + shortQty
  const sellFee = sellQty * 120 * 0.0005
  const closeFeeShare = sellFee * (100 / sellQty) // 平仓部分手续费
  const openFeeShare = sellFee - closeFeeShare // 反手开仓部分手续费
  const buyFee = shortQty * 100 * 0.0005
  const trade1Fees = 5 + closeFeeShare
  const trade2Fees = openFeeShare + buyFee
  const finalCash = 10000 - 5 + 2000 - sellFee + shortQty * 20 - buyFee

  equal('反转：3 笔成交（开多、反手卖、平空）', result.fills.length, 3)
  equal('反转：2 笔 trade（多单平仓一笔 + 空单平仓一笔）', result.trades.length, 2)
  equal('反转：反手成交 side=sell', result.fills[1].side, 'sell')
  close('反转：反手成交数量 = 平多 100 + 开空数量', result.fills[1].qty, sellQty)
  close('反转：反手后 positionAfter = -空头数量', result.fills[1].positionAfter, -shortQty)
  close('反转：平空成交数量', result.fills[2].qty, shortQty)
  equal('反转：平空后 positionAfter=0', result.fills[2].positionAfter, 0)

  const trade1 = result.trades[0]
  equal('反转：第 1 笔 trade 是 long', trade1.side, 'long')
  close('反转：第 1 笔 trade qty=100（只记被平部分）', trade1.qty, 100)
  equal('反转：第 1 笔 entryT=开仓根', trade1.entryT, t(1))
  equal('反转：第 1 笔 exitT=反手根', trade1.exitT, t(2))
  close('反转：第 1 笔 pnl = 毛利 - 平仓段费用', trade1.pnl, 2000 - trade1Fees)
  close('反转：第 1 笔 fees 只含平仓段', trade1.fees, trade1Fees)

  const trade2 = result.trades[1]
  equal('反转：第 2 笔 trade 是 short', trade2.side, 'short')
  close('反转：第 2 笔 qty', trade2.qty, shortQty)
  equal('反转：第 2 笔 entryT=反手根', trade2.entryT, t(2))
  equal('反转：第 2 笔 exitT=平仓根', trade2.exitT, t(3))
  equal('反转：第 2 笔 bars=1', trade2.bars, 1)
  close('反转：第 2 笔 fees = 开空段 + 平空段', trade2.fees, trade2Fees)
  close('反转：第 2 笔 pnl', trade2.pnl, shortQty * 20 - trade2Fees)
  close('反转：finalEquity', result.finalEquity, finalCash)
}

// ============================================================================
// 9) 爆仓：10 倍多头 / 1 倍空头（公式见 SPEC §6.4）
// ============================================================================
{
  // 9a) 10 倍多头：爆仓价 = 均价*(1 - 1/10 + 0.005) = 90.5
  const longBars = makeBars([
    [100, 101, 90, 100],
    [100, 101, 89, 95], // low=89 穿过 90.5
    [95, 96, 94, 95],
  ])
  let liquidatedSeen = null
  const longRun = run(longBars, (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'long', weight: 1 })
    if (i === 1) liquidatedSeen = ctx.position.side
  }, { config: { leverage: 10 } })
  const longResult = longRun.result

  equal('爆仓（多）：10 倍满仓成交数量 = 1000', longResult.fills[0].qty, 1000)
  equal('爆仓（多）：共 2 笔成交（开仓 + 强平）', longResult.fills.length, 2)
  equal('爆仓（多）：liquidations 1 条', longResult.liquidations.length, 1)
  const liq = longResult.liquidations[0]
  equal('爆仓（多）：强平时间', liq.t, t(1))
  close('爆仓（多）：强平价 = 均价*(1-1/杠杆+维持保证金率)', liq.price, 100 * (1 - 1 / 10 + 0.005))
  close('爆仓（多）：强平数量', liq.qty, 1000)
  close('爆仓（多）：equityAfter = 现金',
    liq.equityAfter, 10000 - 50 - 1000 * (100 - 90.5) - 1000 * 90.5 * 0.0005)
  const longTrade = longResult.trades[0]
  equal('爆仓（多）：trade.exitReason=liquidation', longTrade.exitReason, 'liquidation')
  close('爆仓（多）：trade.exitPrice=爆仓价', longTrade.exitPrice, 90.5)
  close('爆仓（多）：trade.pnl 已扣开平手续费', longTrade.pnl,
    1000 * (90.5 - 100) - (50 + 1000 * 90.5 * 0.0005))
  equal('爆仓（多）：同一根开仓并爆仓，bars=0', longTrade.bars, 0)
  equal('爆仓（多）：爆仓后策略看到空仓', liquidatedSeen, 'flat')
  equal('爆仓（多）：爆仓后 positionAfter=0', longResult.fills[1].positionAfter, 0)
  close('爆仓（多）：finalEquity = 强平后现金', longResult.finalEquity, longResult.liquidations[0].equityAfter)
  close('爆仓（多）：爆仓后 equityCurve 最后一点 = 现金', longResult.equityCurve[2].equity, longResult.finalEquity)

  // 9b) 1 倍空头：爆仓价 = 均价*(1 + 1/1 - 0.005) ≈ 1.995 倍
  const shortBars = makeBars([
    [100, 101, 99, 100],
    [100, 201, 99, 150], // high=201 穿过 199.5
    [150, 151, 149, 150],
  ])
  const shortRun = run(shortBars, (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'short', weight: 1 })
  })
  const shortResult = shortRun.result
  equal('爆仓（空，1 倍）：liquidations 1 条', shortResult.liquidations.length, 1)
  close('爆仓（空，1 倍）：爆仓价 = 均价*(1+1/1-0.005)', shortResult.liquidations[0].price, 199.5)
  close('爆仓（空，1 倍）：强平后现金',
    shortResult.finalEquity, 10000 - 5 - 100 * (199.5 - 100) - 100 * 199.5 * 0.0005)
  equal('爆仓（空，1 倍）：trade.side=short', shortResult.trades[0].side, 'short')
  equal('爆仓（空，1 倍）：trade.exitReason=liquidation', shortResult.trades[0].exitReason, 'liquidation')
}

// ============================================================================
// 10) closeAtEnd：期末按收盘价 taker 平仓，并更新 equityCurve 最后一点
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 111, 99, 110],
    [110, 121, 109, 120],
  ])
  const strategyOf = (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'long', weight: 1 })
  }

  const endRun = run(bars, strategyOf) // closeAtEnd 默认 true
  const endResult = endRun.result
  equal('closeAtEnd：2 笔成交（开仓 + 期末平仓）', endResult.fills.length, 2)
  equal('closeAtEnd：期末平仓 reason=end', endResult.fills[1].reason, 'end')
  close('closeAtEnd：期末平仓价 = 最后收盘价', endResult.fills[1].price, 120)
  close('closeAtEnd：finalEquity = 已实现现金',
    endResult.finalEquity, 10000 - 5 + (120 - 100) * 100 - 6)
  const lastPoint = endResult.equityCurve[endResult.equityCurve.length - 1]
  close('closeAtEnd：equityCurve 最后一点 equity = 现金', lastPoint.equity, endResult.finalEquity)
  close('closeAtEnd：equityCurve 最后一点 cash = 现金', lastPoint.cash, endResult.finalEquity)
  equal('closeAtEnd：equityCurve 最后一点 qty=0', lastPoint.qty, 0)
  close('closeAtEnd：最后一点 price 仍是收盘价', lastPoint.price, 120)
  const endTrade = endResult.trades[0]
  equal('closeAtEnd：trade.exitReason=end', endTrade.exitReason, 'end')
  equal('closeAtEnd：trade.bars=1（bar1 开仓、bar2 平仓）', endTrade.bars, 1)
  close('closeAtEnd：trade.fees = 开仓 5 + 平仓 6', endTrade.fees, 11)
  close('closeAtEnd：trade.pnl', endTrade.pnl, 2000 - 11)

  const openRun = run(bars, strategyOf, { config: { closeAtEnd: false } })
  const openResult = openRun.result
  equal('closeAtEnd=false：没有期末平仓成交', openResult.fills.length, 1)
  equal('closeAtEnd=false：持仓保留到最后', openResult.equityCurve[2].qty, 100)
  close('closeAtEnd=false：finalEquity 按收盘价盯市', openResult.finalEquity, 9995 + 100 * (120 - 100))
  equal('closeAtEnd=false：没有 trade', openResult.trades.length, 0)
}

// ============================================================================
// 11) 防未来函数 + ctx 副本隔离 + ctx 字段/只读快照
// ============================================================================
{
  const bars = makeBars([
    [100, 105, 95, 101],
    [101, 107, 99, 103],
    [103, 109, 100, 108],
    [108, 110, 102, 104],
  ])
  let startSeen = null
  const seen = []
  const result = runBacktest({
    bars,
    config: makeConfig(bars, { leverage: 2, makerFeeRate: 0.0003, takerFeeRate: 0.0007 }),
    strategy: defineStrategy({
      name: 'engine-test',
      params: {},
      onStart(ctx) {
        startSeen = {
          index: ctx.index,
          time: ctx.time,
          bar: ctx.bar,
          windowLen: ctx.window(10).length,
          closesLen: ctx.closes(10).length,
          equity: ctx.equity,
          cash: ctx.cash,
          positionSide: ctx.position.side,
        }
      },
      onBar(ctx, bar, i) {
        const window = ctx.window(1000)
        const closes = ctx.closes(1000)
        const snapshot = {
          i,
          index: ctx.index,
          time: ctx.time,
          barT: bar.t,
          barC: bar.c,
          windowLen: window.length,
          closesLen: closes.length,
          lastWindowT: window.length > 0 ? window[window.length - 1].t : null,
          lastWindowC: window.length > 0 ? window[window.length - 1].c : null,
          lastClose: closes.length > 0 ? closes[closes.length - 1] : null,
          closes1: ctx.closes(1)[0],
          barCopyC: ctx.bar.c,
          configFrozen: Object.isFrozen(ctx.config),
        }
        // 篡改拿到的副本：引擎内部数据 / 下一次读取都不应受影响
        if (window.length > 0) {
          window[window.length - 1].c = -1
          window.push({ t: -1, o: -1, h: -1, l: -1, c: -1, v: 0 })
        }
        if (closes.length > 0) closes[0] = -12345
        const barCopy = ctx.bar
        barCopy.c = -777
        snapshot.afterMutateClose = ctx.closes(1)[0]
        snapshot.afterMutateBar = ctx.bar.c
        snapshot.config = {
          instId: ctx.config.instId,
          bar: ctx.config.bar,
          leverage: ctx.config.leverage,
          makerFeeRate: ctx.config.makerFeeRate,
          takerFeeRate: ctx.config.takerFeeRate,
          initialCapital: ctx.config.initialCapital,
        }
        seen.push(snapshot)
      },
    }),
  })

  // onStart 阶段：没有当前 bar，window/closes 必须为空（不能看到第 0 根）
  equal('ctx：onStart 的 index=-1', startSeen.index, -1)
  equal('ctx：onStart 的 time=null', startSeen.time, null)
  equal('ctx：onStart 的 bar=null', startSeen.bar, null)
  equal('ctx：onStart 的 window 为空', startSeen.windowLen, 0)
  equal('ctx：onStart 的 closes 为空', startSeen.closesLen, 0)
  equal('ctx：onStart 的 equity=初始资金', startSeen.equity, 10000)
  equal('ctx：onStart 的 cash=初始资金', startSeen.cash, 10000)
  equal('ctx：onStart 的 position=flat', startSeen.positionSide, 'flat')

  let allNoFuture = true
  let allCopyIsolated = true
  let allConfigOk = true
  for (const item of seen) {
    if (item.index !== item.i
      || item.time !== item.barT
      || item.windowLen !== item.i + 1 // window 只能看到 0..i
      || item.closesLen !== item.i + 1
      || item.lastWindowT !== item.barT
      || item.lastWindowC !== item.barC
      || item.lastClose !== item.barC
      || item.closes1 !== item.barC
      || item.barCopyC !== item.barC) {
      allNoFuture = false
    }
    if (item.afterMutateClose !== item.barC || item.afterMutateBar !== item.barC) allCopyIsolated = false
    if (!item.configFrozen
      || item.config.instId !== 'BTC-USDT-SWAP'
      || item.config.bar !== '1h'
      || item.config.leverage !== 2
      || item.config.makerFeeRate !== 0.0003
      || item.config.takerFeeRate !== 0.0007
      || item.config.initialCapital !== 10000) {
      allConfigOk = false
    }
  }
  ok('ctx：window/closes 只能看到 0..i（无未来数据）', allNoFuture,
    JSON.stringify(seen.map((item) => [item.i, item.windowLen, item.lastClose, item.barC])))
  ok('ctx：window/closes/bar 返回副本，策略篡改不影响引擎', allCopyIsolated)
  ok('ctx：config 快照字段正确且被冻结（只读）', allConfigOk)

  // 上面那次回测里策略反复篡改 window/closes/bar 的副本，最终结果仍应是真实收盘价
  ok('ctx：回测结果本身的 equityCurve 未被策略篡改',
    result.equityCurve.every((point, i) => point.price === bars[i].c && point.t === bars[i].t))
}

// ============================================================================
// 12) ctx.params：只读参数快照（CLI 的 --param 覆盖值要能看到）
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ])
  let captured = null
  let capturedFrozen = false
  const base = defineStrategy({
    name: 'params-strategy',
    params: { fast: 3, allowShort: false },
    onBar(ctx) {
      captured = ctx.params
      capturedFrozen = Object.isFrozen(ctx.params)
    },
  })
  const merged = resolveParams(base, { fast: 5 }) // 模拟 CLI 的 --param fast=5
  const strategy = defineStrategy({ ...base, params: merged })
  const result = runBacktest({ bars, strategy, config: makeConfig(bars) })

  equal('ctx.params：--param 覆盖值生效（fast=5）', captured && captured.fast, 5)
  equal('ctx.params：未覆盖参数保留默认值（allowShort=false）', captured && captured.allowShort, false)
  equal('ctx.params：被冻结（只读快照）', capturedFrozen, true)
  equal('ctx.params：result.strategy.name', result.strategy.name, 'params-strategy')
  equal('ctx.params：result.strategy.params.fast', result.strategy.params.fast, 5)
  equal('ctx.params：result.strategy.params.allowShort', result.strategy.params.allowShort, false)
  ok('ctx.params：result.strategy.params 原样引用 strategy.params', result.strategy.params === strategy.params)
}

// ============================================================================
// 13) 手续费：maker/taker 汇总、逐笔合计、count
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 105, 89, 100], // 市价买在开盘 100；限价买 90 被 low=89 吃掉
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) {
      ctx.market({ side: 'buy', qty: 1 })
      ctx.limit({ side: 'buy', price: 90, qty: 2 })
    }
  })
  equal('手续费：3 笔成交（市价开 + 限价加 + 期末平）', result.fills.length, 3)
  const makerSum = result.fills.filter((f) => f.feeKind === 'maker').reduce((sum, f) => sum + f.fee, 0)
  const takerSum = result.fills.filter((f) => f.feeKind === 'taker').reduce((sum, f) => sum + f.fee, 0)
  close('手续费：fees.maker = maker 成交手续费之和', result.fees.maker, makerSum)
  close('手续费：fees.taker = taker 成交手续费之和', result.fees.taker, takerSum)
  close('手续费：fees.total = maker + taker', result.fees.total, makerSum + takerSum)
  equal('手续费：fees.count = 成交笔数', result.fees.count, result.fills.length)
  close('手续费：maker 费率 0.0002', result.fees.maker, 2 * 90 * 0.0002)
  close('手续费：taker 费率 0.0005', result.fees.taker, 1 * 100 * 0.0005 + 3 * 100 * 0.0005)
  const trade = result.trades[0]
  close('手续费：trade.fees 含建仓全部手续费', trade.fees, makerSum + takerSum)
  close('手续费：trade.pnl 已扣全部手续费',
    trade.pnl, 3 * (100 - (1 * 100 + 2 * 90) / 3) - (makerSum + takerSum))
}

// ============================================================================
// 14) 部分平仓：每次平仓各记一条 trade，建仓手续费按比例分摊
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 111, 99, 110],
    [120, 121, 117, 118],
    [100, 101, 99, 100],
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.market({ side: 'buy', qty: 100 })
    if (i === 1) ctx.market({ side: 'sell', qty: 40 })
    if (i === 2) ctx.target({ side: 'flat' })
  })

  equal('部分平仓：3 笔成交', result.fills.length, 3)
  equal('部分平仓：2 条 trade', result.trades.length, 2)
  equal('部分平仓：第 1 笔平仓后 qty=60', result.equityCurve[2].qty, 60)

  const first = result.trades[0]
  equal('部分平仓：第 1 条 side=long', first.side, 'long')
  close('部分平仓：第 1 条 qty=40（只记被平部分）', first.qty, 40)
  equal('部分平仓：第 1 条 entryT=开仓根', first.entryT, t(1))
  equal('部分平仓：第 1 条 exitT=第一次平仓根', first.exitT, t(2))
  equal('部分平仓：第 1 条 bars=1', first.bars, 1)
  close('部分平仓：第 1 条 pnl', first.pnl, 40 * (120 - 100) - (2 + 40 * 120 * 0.0005))
  // 建仓手续费 5 中 40/100 分给第一笔，剩 3 留给第二笔
  close('部分平仓：第 1 条 fees = 分摊的建仓费 + 平仓费', first.fees, 2 + 2.4)

  const second = result.trades[1]
  close('部分平仓：第 2 条 qty=60', second.qty, 60)
  equal('部分平仓：第 2 条 entryT 仍是开仓根', second.entryT, t(1))
  equal('部分平仓：第 2 条 exitT=最后平仓根', second.exitT, t(3))
  equal('部分平仓：第 2 条 bars=2', second.bars, 2)
  close('部分平仓：第 2 条 fees = 剩余建仓费 + 平仓费', second.fees, 3 + 3)
  close('部分平仓：第 2 条 pnl', second.pnl, 0 - (3 + 3))
  close('部分平仓：finalEquity', result.finalEquity, 10000 - 5 + 800 - 2.4 - 3)
}

// ============================================================================
// 15) onStart 下单排到第 1 根；onEnd 不允许下单；onStart 日志时间戳
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [200, 215, 195, 210],
  ])
  const startRun = run(bars, () => {}, {
    config: { closeAtEnd: false },
    onStart(ctx) {
      ctx.market({ side: 'buy', qty: 1, reason: 'from-start' })
    },
  })
  equal('onStart：委托排到第 1 根成交', startRun.result.fills.length, 1)
  equal('onStart：成交时间 = 第 1 根', startRun.result.fills[0].t, t(1))
  equal('onStart：reason 透传', startRun.result.fills[0].reason, 'from-start')

  // onStart 里 log：还没有当前 bar，但日志时间戳用第一根开盘时间（保持毫秒数）
  const logRun = run(bars, () => {}, {
    onStart(ctx) {
      ctx.log('启动')
    },
  })
  equal('onStart：日志时间戳 = 第 0 根开盘时间', logRun.result.logs[0].t, t(0))
  equal('onStart：日志内容', logRun.result.logs[0].message, '启动')

  throws('onEnd：下单抛错（不允许成交）', () => run(bars, () => {}, {
    onEnd(ctx) {
      ctx.market({ side: 'buy', qty: 1 })
    },
  }), 'onEnd')

  let endSeen = null
  const endRun = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.target({ side: 'long', weight: 1 })
  }, {
    onEnd(ctx) {
      endSeen = { index: ctx.index, time: ctx.time, side: ctx.position.side, cash: ctx.cash }
    },
  })
  equal('onEnd：被调用一次', endSeen === null ? 0 : 1, 1)
  equal('onEnd：期末平仓在 onEnd 之前完成（策略看到空仓）', endSeen.side, 'flat')
  equal('onEnd：时间=最后一根开盘时间', endSeen.time, t(1))
  equal('onEnd：index=最后一根下标', endSeen.index, 1)
  equal('onEnd：cash=最终现金（已含期末平仓手续费）', endSeen.cash, endRun.result.finalEquity)
  equal('onEnd：期末平仓确实发生过', endRun.result.fills.length, 2)
}

// ============================================================================
// 16) 策略异常：onBar 抛错原样上抛 + ctx 参数校验
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ])
  const boom = new Error('策略故意炸了')
  let caught = null
  try {
    run(bars, () => {
      throw boom
    })
  } catch (error) {
    caught = error
  }
  ok('策略异常：onBar 抛出的错误对象原样上抛', caught === boom, String(caught && caught.message))

  throws('ctx 参数校验：target side 非法抛错', () => run(bars, (ctx) => {
    ctx.target({ side: 'up', weight: 1 })
  }), 'side')
  throws('ctx 参数校验：target weight 超范围抛错', () => run(bars, (ctx) => {
    ctx.target({ side: 'long', weight: 1.5 })
  }), 'weight')
  throws('ctx 参数校验：market 同时给 qty 和 notional 抛错', () => run(bars, (ctx) => {
    ctx.market({ side: 'buy', qty: 1, notional: 100 })
  }), 'qty')
  throws('ctx 参数校验：limit price 非法抛错', () => run(bars, (ctx) => {
    ctx.limit({ side: 'buy', price: -1, qty: 1 })
  }), 'price')
  throws('ctx 参数校验：window(0) 抛错', () => run(bars, (ctx) => {
    ctx.window(0)
  }), 'n')
}

// ============================================================================
// 17) 限价单：reduceOnly 数量不超过持仓 / 无持仓作废 / 同根按提交顺序
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 111, 99, 110],
    [110, 121, 109, 120],
  ])
  let ids = null
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.market({ side: 'buy', qty: 2 })
    if (i === 1) {
      // 持仓 2：reduceOnly 卖 5 应被截到 2；做多时 reduceOnly 买 1 应直接作废
      ids = {
        sell: ctx.limit({ side: 'sell', price: 110, qty: 5, reduceOnly: true }),
        buy: ctx.limit({ side: 'buy', price: 115, qty: 1, reduceOnly: true }),
      }
    }
  })
  equal('reduceOnly：共 2 笔成交（开仓 + reduceOnly 平仓）', result.fills.length, 2)
  close('reduceOnly：成交数量 = 当前持仓 2', result.fills[1].qty, 2)
  equal('reduceOnly：方向正确的委托成交', result.fills[1].side, 'sell')
  ok('reduceOnly：返回的两张委托都有 id', typeof ids.sell === 'number' && typeof ids.buy === 'number')

  // 无持仓时 reduceOnly 直接作废：即便价格条件满足也不该有成交
  const flatBars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ])
  let id = null
  const flatRun = run(flatBars, (ctx) => {
    id = ctx.limit({ side: 'sell', price: 90, qty: 1, reduceOnly: true })
  })
  equal('reduceOnly：无持仓时委托直接作废（仍返回 id）', typeof id, 'number')
  equal('reduceOnly：作废的委托不会成交', flatRun.result.fills.length, 0)

  // 同一根里多张限价单：按提交顺序撮合，不按价格排序
  const orderBars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 98, 100],
  ])
  const orderRun = run(orderBars, (ctx, bar, i) => {
    if (i === 0) {
      ctx.limit({ side: 'buy', price: 99, qty: 1 })
      ctx.limit({ side: 'buy', price: 99.5, qty: 1 })
    }
  })
  equal('限价顺序：两张都成交（含期末平仓共 3 笔）', orderRun.result.fills.length, 3)
  close('限价顺序：第一张（先提交的 99）先成交', orderRun.result.fills[0].price, 99)
  close('限价顺序：第二张（后提交的 99.5）后成交', orderRun.result.fills[1].price, 99.5)
  equal('限价顺序：两张都在第 1 根成交', orderRun.result.fills[1].t, t(1))
}

// ============================================================================
// 18) 第 0 根 K 线不撮合（只有盯市 + onBar）
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 90, 100], // 若错误地在第 0 根就撮合，105 的买单会在这里成交
    [100, 101, 99.5, 100],
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.limit({ side: 'buy', price: 105, qty: 1 })
  })
  equal('第 0 根：限价单最早第 1 根才成交', result.fills[0].t, t(1))
  close('第 0 根：成交价 = 限价', result.fills[0].price, 105)
}

// ============================================================================
// 19) notional 在提交时按当前收盘价折成数量
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [200, 215, 195, 210],
  ])
  const marketRun = run(bars, (ctx, bar, i) => {
    if (i === 0) ctx.market({ side: 'buy', notional: 500 })
  }, { config: { closeAtEnd: false } })
  close('notional 市价单：qty = notional / 提交时收盘价', marketRun.result.fills[0].qty, 5)
  close('notional 市价单：成交价仍是下一根开盘价', marketRun.result.fills[0].price, 200)

  const limitBars = makeBars([
    [100, 101, 99, 100],
    [100, 105, 89, 100],
  ])
  const limitRun = run(limitBars, (ctx, bar, i) => {
    if (i === 0) ctx.limit({ side: 'buy', price: 90, notional: 400 })
  }, { config: { closeAtEnd: false } })
  close('notional 限价单：qty = notional / 提交时收盘价', limitRun.result.fills[0].qty, 4)
  close('notional 限价单：成交价 = 限价', limitRun.result.fills[0].price, 90)
}

// ============================================================================
// 20) 日志：正常保留；上限 5000，超出丢最早并记说明
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ])
  const smallRun = run(bars, (ctx, bar, i) => {
    if (i !== 0) return // 只记一次，否则每根 onBar 都会重复记
    ctx.log('一')
    ctx.log('二')
    ctx.log('三')
  })
  equal('日志：正常条目全部保留', smallRun.result.logs.length, 3)
  equal('日志：内容顺序', smallRun.result.logs.map((log) => log.message).join(','), '一,二,三')
  equal('日志：时间戳 = 当前 bar 开盘时间', smallRun.result.logs[0].t, t(0))

  const hugeRun = run(bars, (ctx, bar, i) => {
    if (i !== 0) return // 只刷一轮 6000 条，避免每根 K 线重复叠加
    for (let n = 1; n <= 6000; n += 1) ctx.log('第' + n + '条')
  })
  const hugeLogs = hugeRun.result.logs
  equal('日志上限：最多 5000 条', hugeLogs.length, 5000)
  ok('日志上限：最后一条是截断说明', hugeLogs[hugeLogs.length - 1].message.includes('日志超过 5000 条上限'), hugeLogs[hugeLogs.length - 1].message)
  ok('日志上限：说明里带丢弃条数（6000-4999=1001）', hugeLogs[hugeLogs.length - 1].message.includes('1001'), hugeLogs[hugeLogs.length - 1].message)
  equal('日志上限：最新一条真实日志仍在（第6000条）', hugeLogs[hugeLogs.length - 2].message, '第6000条')
  equal('日志上限：截断说明时间 = 最后一根开盘时间', hugeLogs[hugeLogs.length - 1].t, t(1))
}

// ============================================================================
// 21) 期末未成交委托丢弃（市价单 / 限价单都算）
// ============================================================================
{
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ])
  const { result } = run(bars, (ctx, bar, i) => {
    if (i === 1) {
      // 最后一根的决策：市价单 + 限价单都来不及成交
      ctx.market({ side: 'buy', qty: 1 })
      ctx.limit({ side: 'buy', price: 90, qty: 1 })
    }
  })
  equal('期末丢弃：没有成交', result.fills.length, 0)
  ok('期末丢弃：log 里说明丢弃 2 张委托',
    result.logs.some((log) => log.message.includes('丢弃 2 张未成交委托')),
    JSON.stringify(result.logs))
}

// ============================================================================
// 22) 输入校验：非法 bars / strategy / config 抛中文错误
// ============================================================================
{
  const validBars = makeBars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ])
  const config = makeConfig(validBars)
  const strategy = defineStrategy({ name: 'x', onBar() {} })

  throws('输入校验：bars 为空', () => runBacktest({ bars: [], strategy, config }), 'K 线')
  throws('输入校验：bars 不是数组', () => runBacktest({ bars: 'oops', strategy, config }), 'bars')
  throws('输入校验：K 线乱序', () => runBacktest({ bars: [validBars[1], validBars[0]], strategy, config }), '升序')
  throws('输入校验：K 线价格<=0', () => runBacktest({
    bars: [{ t: t(0), o: 0, h: 1, l: 0, c: 1, v: 1 }], strategy, config,
  }), '价格')
  throws('输入校验：缺策略', () => runBacktest({ bars: validBars, config }), '策略')
  throws('输入校验：策略缺 onBar', () => runBacktest({ bars: validBars, strategy: { name: 'x' }, config }), 'onBar')
  throws('输入校验：config 不是对象', () => runBacktest({ bars: validBars, strategy, config: null }), '配置')
  throws('输入校验：杠杆 < 1', () => runBacktest({ bars: validBars, strategy, config: { ...config, leverage: 0.5 } }), '杠杆')
  throws('输入校验：limitFill 非法', () => runBacktest({ bars: validBars, strategy, config: { ...config, limitFill: 'foo' } }), 'limitFill')
}

// ---- 汇总 -------------------------------------------------------------------
console.log('')
if (failed > 0) {
  process.exitCode = 1
  console.log(failed + ' 项失败（共 ' + (passed + failed) + ' 项断言）')
} else {
  console.log('全部通过（' + passed + ' 项断言）')
}
