/**
 * metrics.mjs / report.mjs 的离线自检（SPEC §10 metrics 行）。
 *
 * 为什么这么测：
 *   1. 指标口径只能靠“手工算得出来”的 fixture 校验 —— 拿引擎输出对拍很容易两处一起错；
 *      这里的收益、回撤、Sharpe、盈亏因子、连赢连亏都是能手算的整数/简单小数。
 *   2. 报告是最后一道门：null 必须变 `—`、不能出现 NaN/Infinity/undefined、控制台不能有颜色码、
 *      HTML 不能有外链且必须转义 —— 这些在端到端测试里看不出来，只能单测钉死。
 *   3. 全离线：不联网、不 spawn、只写 mkdtemp 临时目录并在 finally 清理。
 *
 * 运行：node tests/backtest-metrics-test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

import { normalizeConfig } from '../backtest/lib/config.mjs'
import { computeMetrics } from '../backtest/lib/metrics.mjs'
import { buildHtmlReport, buildJsonReport, formatConsole, writeReports } from '../backtest/lib/report.mjs'

const HOUR = 3_600_000
const DAY = 86_400_000
/** fixture 的起点：2024-01-01T00:00:00Z = 北京时间 2024-01-01 08:00。 */
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0)
const NOW = T0 + 10 * DAY

let passed = 0
let failed = 0

function record(ok, name, detail) {
  if (ok) {
    passed += 1
    console.log('ok   ' + name + (detail === undefined ? '' : '  ' + detail))
  } else {
    failed += 1
    console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail))
  }
}

/** 布尔断言（condition 必须严格 === true，避免“真值”混过）。 */
function check(name, condition, detail) {
  record(condition === true, name, detail)
}

/** 相等断言（用于整数/字符串/时间戳）。 */
function equal(name, actual, expected) {
  record(actual === expected, name, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected))
}

/** 浮点近似断言（默认 1e-9，够紧；手算值都是精确小数或同一个公式）。 */
function near(name, actual, expected, tolerance = 1e-9) {
  const ok = typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
  record(ok, name, 'got=' + String(actual) + ' want≈' + String(expected))
}

// ───────────────────────────── fixture 工具 ─────────────────────────────

/** 归一化配置：默认 1h、10000 USDT、1 倍杠杆、默认费率（与 CLI 默认一致）。 */
function makeConfig(overrides = {}) {
  return normalizeConfig({
    bar: '1h',
    start: T0,
    end: T0 + 240 * HOUR,
    initialCapital: 10000,
    now: NOW,
    ...overrides,
  })
}

const BASE_CONFIG = makeConfig()

/** 资金曲线上的一个点：`t` 由下标推出，price 默认 100（Buy&Hold 基准用）。 */
function point(index, equity, qty = 0, price = 100, t = T0 + index * HOUR) {
  return { t, equity, cash: equity, qty, price }
}

/** 按 SPEC §4.1 构造假 BacktestResult（engine 还没参与，测试完全自给自足）。 */
function makeResult(overrides = {}) {
  const config = overrides.config ?? BASE_CONFIG
  const equityCurve = overrides.equityCurve ?? []
  const firstT = equityCurve.length > 0 ? equityCurve[0].t : null
  const lastT = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].t : null
  return {
    ok: true,
    config,
    strategy: { name: 'buy-hold', params: {} },
    range: { start: config.start, end: config.end, bars: equityCurve.length, firstT, lastT },
    initialEquity: 10000,
    finalEquity: equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : 10000,
    equityCurve,
    fills: [],
    trades: [],
    fees: { maker: 0, taker: 0, total: 0, count: 0 },
    liquidations: [],
    rejected: [],
    logs: [],
    ...overrides,
  }
}

/** 交易明细工厂（pnlPct 默认按 notional=1000 换算，便于手算）。 */
function makeTrade(index, pnl, overrides = {}) {
  const notional = overrides.notional ?? 1000
  return {
    seq: index + 1,
    side: pnl < 0 ? 'short' : 'long',
    qty: 1,
    entryT: T0 + index * HOUR,
    entryPrice: 100,
    exitT: T0 + (index + 1) * HOUR,
    exitPrice: 100,
    notional,
    fees: 0,
    pnl,
    pnlPct: (pnl / notional) * 100,
    bars: 1,
    exitReason: 'strategy',
    ...overrides,
  }
}

/** SPEC §7 的全部字段（顺序也照契约；测试据此发现“少字段/多字段”）。 */
const METRICS_KEYS = [
  'bars', 'firstT', 'lastT', 'days',
  'initialEquity', 'finalEquity', 'totalReturnPct', 'annualizedReturnPct',
  'maxDrawdownPct', 'maxDrawdownPeakT', 'maxDrawdownTroughT',
  'volatilityPct', 'sharpe', 'sortino', 'calmar',
  'tradeCount', 'winningTrades', 'losingTrades', 'winRatePct',
  'profitFactor', 'avgWin', 'avgLoss', 'payoffRatio', 'avgTradePnl', 'avgTradePct', 'expectancy',
  'maxConsecutiveWins', 'maxConsecutiveLosses',
  'feesMaker', 'feesTaker', 'feesTotal', 'feesPctOfCapital',
  // 资金费率（funding，v1.7 追加；total 为净支出，负值=净收入）
  'fundingPaid', 'fundingReceived', 'fundingTotal', 'fundingCount',
  'fundingEstimatedCount', 'fundingPctOfCapital', 'totalCostPctOfCapital',
  'exposurePct', 'liquidations',
  'buyHoldReturnPct', 'buyHoldMaxDrawdownPct', 'buyHoldFinalEquity',
]

/** 字段齐全 + 绝不出现 NaN/Infinity/undefined（SPEC 的硬要求）。 */
function checkMetricsShape(label, metrics) {
  const keys = Object.keys(metrics)
  const missing = METRICS_KEYS.filter((key) => !keys.includes(key))
  const extra = keys.filter((key) => !METRICS_KEYS.includes(key))
  check(label + '：字段与 SPEC §7 一一对应', missing.length === 0 && extra.length === 0,
    'missing=' + JSON.stringify(missing) + ' extra=' + JSON.stringify(extra))
  const bad = []
  for (const key of keys) {
    const value = metrics[key]
    if (value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) bad.push(key + '=' + String(value))
  }
  check(label + '：指标里没有 NaN/Infinity/undefined', bad.length === 0, bad.join(' '))
}

// ───────────────────────────── 1. 手工可算的收益/回撤/Sharpe ─────────────────────────────

const CURVE_A = [
  point(0, 10000, 0.1, 100),
  point(1, 10200, 0.1, 102),
  point(2, 10098, 0, 96),
]
const TRADES_A = [{
  seq: 1,
  side: 'long',
  qty: 1,
  entryT: T0,
  entryPrice: 100,
  exitT: T0 + 2 * HOUR,
  exitPrice: 96,
  notional: 10000,
  fees: 3,
  pnl: 98,
  pnlPct: 0.98,
  bars: 2,
  exitReason: 'end',
}]
const RESULT_A = makeResult({
  equityCurve: CURVE_A,
  trades: TRADES_A,
  fills: [
    { t: T0, side: 'buy', qty: 1, price: 100, notional: 100, fee: 1, feeKind: 'maker', kind: 'limit', reason: 'entry', positionAfter: 1 },
    { t: T0 + 2 * HOUR, side: 'sell', qty: 1, price: 96, notional: 96, fee: 2, feeKind: 'taker', kind: 'market', reason: 'end', positionAfter: 0 },
  ],
  fees: { maker: 1, taker: 2, total: 3, count: 2 },
  rejected: [
    { t: T0, reason: '杠杆/保证金不足', order: { side: 'buy', qty: 100 } },
    { t: T0 + HOUR, reason: '杠杆/保证金不足', order: { side: 'buy', qty: 100 } },
  ],
})
const METRICS_A = computeMetrics(RESULT_A)

{
  checkMetricsShape('A 基础 fixture', METRICS_A)

  // 收益：10000 → 10098（+0.98%）
  equal('A 根数 = 3', METRICS_A.bars, 3)
  equal('A firstT = 首根时间', METRICS_A.firstT, T0)
  equal('A lastT = 末根时间', METRICS_A.lastT, T0 + 2 * HOUR)
  near('A days = (2h+1h)/24h = 0.125', METRICS_A.days, 0.125)
  near('A 总收益 = +0.98%', METRICS_A.totalReturnPct, 0.98)
  equal('A 不足 1 天时年化收益 = null', METRICS_A.annualizedReturnPct, null)

  // 回撤：峰值 10200（第 2 根），谷值 10098（第 3 根）→ 1 - 10098/10200 = 1%
  near('A 最大回撤 = 1%', METRICS_A.maxDrawdownPct, 1)
  equal('A 最大回撤峰值时间', METRICS_A.maxDrawdownPeakT, T0 + HOUR)
  equal('A 最大回撤谷值时间', METRICS_A.maxDrawdownTroughT, T0 + 2 * HOUR)

  // 收益率序列 = [+2%, -1%]：均值 0.005、总体标准差 0.015、年化因子 sqrt(8760)
  // Sharpe = 0.005/0.015*sqrt(8760)；Sortino = 0.005/sqrt(mean(min(r,0)^2))*sqrt(8760)
  const ppY = (365 * 24 * 3600 * 1000) / HOUR
  const sqrtPpY = Math.sqrt(ppY)
  near('A 波动率 = 0.015*sqrt(8760)*100', METRICS_A.volatilityPct, 0.015 * sqrtPpY * 100)
  near('A Sharpe = 0.005/0.015*sqrt(8760)', METRICS_A.sharpe, (0.005 / 0.015) * sqrtPpY)
  near('A Sortino = 0.005/sqrt(0.00005)*sqrt(8760)', METRICS_A.sortino, (0.005 / Math.sqrt(0.0001 / 2)) * sqrtPpY)
  equal('A Calmar = null（年化算不出）', METRICS_A.calmar, null)

  // 交易统计：1 笔盈利、无亏损
  equal('A 交易数 = 1', METRICS_A.tradeCount, 1)
  equal('A 盈利交易数 = 1', METRICS_A.winningTrades, 1)
  equal('A 亏损交易数 = 0', METRICS_A.losingTrades, 0)
  near('A 胜率 = 100%', METRICS_A.winRatePct, 100)
  equal('A 无亏损交易时 profitFactor = null', METRICS_A.profitFactor, null)
  near('A avgWin = 98', METRICS_A.avgWin, 98)
  equal('A 无亏损交易时 avgLoss = null', METRICS_A.avgLoss, null)
  equal('A 无亏损交易时 payoffRatio = null', METRICS_A.payoffRatio, null)
  near('A avgTradePnl = 98', METRICS_A.avgTradePnl, 98)
  near('A avgTradePct = 0.98', METRICS_A.avgTradePct, 0.98)
  near('A expectancy = 98（与 avgTradePnl 同口径）', METRICS_A.expectancy, 98)
  equal('A 最大连赢 = 1', METRICS_A.maxConsecutiveWins, 1)
  equal('A 最大连亏 = 0', METRICS_A.maxConsecutiveLosses, 0)

  // 费用：1 maker + 2 taker = 3；占初始资金 0.03%
  near('A feesMaker = 1', METRICS_A.feesMaker, 1)
  near('A feesTaker = 2', METRICS_A.feesTaker, 2)
  near('A feesTotal = 3', METRICS_A.feesTotal, 3)
  near('A feesPctOfCapital = 0.03%', METRICS_A.feesPctOfCapital, 0.03)

  // 曝露率：3 个点里 2 个有持仓（第 3 个已平仓）
  near('A exposurePct = 2/3*100', METRICS_A.exposurePct, (2 / 3) * 100)
  equal('A 爆仓次数 = 0', METRICS_A.liquidations, 0)

  // Buy&Hold：首根收盘 100 买入、末根收盘 96 → -4%，期末权益 9600；
  // 合成曲线 10000 → 10200 → 9600，最大回撤 1 - 9600/10200
  near('A buyHoldReturnPct = -4%', METRICS_A.buyHoldReturnPct, -4)
  near('A buyHoldMaxDrawdownPct = 600/10200', METRICS_A.buyHoldMaxDrawdownPct, (600 / 10200) * 100)
  near('A buyHoldFinalEquity = 9600', METRICS_A.buyHoldFinalEquity, 9600)
}

// ───────────────────────────── 2. 年化（满 1 天）与“0 方差 → null” ─────────────────────────────

{
  // 24 根 1h = 覆盖 24 小时 = 正好 1 天；权益线性涨到 10010（+0.1%）。
  const curve = Array.from({ length: 24 }, (unused, index) => point(index, 10000 + (10 * index) / 23))
  const result = makeResult({ equityCurve: curve })
  const metrics = computeMetrics(result)
  checkMetricsShape('B 年化 fixture', metrics)
  equal('B days 正好 = 1（首根开盘到末根收盘）', metrics.days, 1)
  near('B 年化收益 = (1.001^365 - 1)*100', metrics.annualizedReturnPct, (Math.pow(1.001, 365) - 1) * 100, 1e-6)
  near('B 总收益 = 0.1%', metrics.totalReturnPct, 0.1, 1e-9)
  // 收益率不完全相同 → 波动率/Sharpe 都是有限数字；全程没有负收益 → 下行偏差为 0 → Sortino null
  check('B 波动率是有限数字', typeof metrics.volatilityPct === 'number' && Number.isFinite(metrics.volatilityPct))
  check('B Sharpe 是有限数字', typeof metrics.sharpe === 'number' && Number.isFinite(metrics.sharpe))
  equal('B 没有负收益 → 下行偏差为 0 → Sortino null', metrics.sortino, null)
  equal('B 最大回撤为 0 → Calmar null', metrics.calmar, null)
}

// ───────────────────────────── 3. 无交易时交易类指标全 null ─────────────────────────────

{
  const flatCurve = [point(0, 10000), point(1, 10000)]
  const result = makeResult({ equityCurve: flatCurve })
  const metrics = computeMetrics(result)
  checkMetricsShape('C 无交易 fixture', metrics)
  equal('C tradeCount = 0', metrics.tradeCount, 0)
  equal('C winningTrades = 0', metrics.winningTrades, 0)
  equal('C losingTrades = 0', metrics.losingTrades, 0)
  equal('C maxConsecutiveWins = 0', metrics.maxConsecutiveWins, 0)
  equal('C maxConsecutiveLosses = 0', metrics.maxConsecutiveLosses, 0)
  const nullKeys = ['winRatePct', 'profitFactor', 'avgWin', 'avgLoss', 'payoffRatio', 'avgTradePnl', 'avgTradePct', 'expectancy']
  const notNull = nullKeys.filter((key) => metrics[key] !== null)
  check('C 无交易时比率/均值类指标全 null', notNull.length === 0, 'notNull=' + notNull.join(','))
  equal('C 总收益 = 0', metrics.totalReturnPct, 0)
  equal('C 波动率 = null（无波动）', metrics.volatilityPct, null)
  equal('C 最大回撤 = 0', metrics.maxDrawdownPct, 0)
  equal('C 曝露率 = 0', metrics.exposurePct, 0)
  equal('C 费用合计 = 0', metrics.feesTotal, 0)
  equal('C 费用占资金 = 0', metrics.feesPctOfCapital, 0)
  equal('C Buy&Hold 收益 = 0', metrics.buyHoldReturnPct, 0)
  equal('C Buy&Hold 期末权益 = 10000', metrics.buyHoldFinalEquity, 10000)
}

// ───────────────────────────── 4. 连赢连亏 / 盈亏因子 / 盈亏比 ─────────────────────────────

{
  // pnl 序列刻意插入 0：0 盈亏“不计入也不打断”连击（SPEC §7 明确要求）。
  const pnls = [10, 20, 0, 30, -5, -15, 0, -25, -8]
  const trades = pnls.map((pnl, index) => makeTrade(index, pnl))
  const result = makeResult({ equityCurve: [point(0, 10000), point(1, 10000)], trades })
  const metrics = computeMetrics(result)
  checkMetricsShape('D 连赢连亏 fixture', metrics)

  equal('D 交易数 = 9', metrics.tradeCount, 9)
  equal('D 盈利 3 / 亏损 4 / 平价 2', metrics.winningTrades * 100 + metrics.losingTrades, 304)
  near('D 胜率 = 3/9*100', metrics.winRatePct, (3 / 9) * 100)
  // 盈利和 60，亏损和 53 → 盈亏因子 60/53
  near('D profitFactor = 60/53', metrics.profitFactor, 60 / 53)
  near('D avgWin = 20', metrics.avgWin, 20)
  near('D avgLoss = -13.25（存负值）', metrics.avgLoss, -13.25)
  near('D payoffRatio = 20/13.25', metrics.payoffRatio, 20 / 13.25)
  near('D avgTradePnl = 7/9', metrics.avgTradePnl, 7 / 9)
  near('D avgTradePct = 0.7/9', metrics.avgTradePct, 0.7 / 9)
  near('D expectancy = 7/9', metrics.expectancy, 7 / 9)
  equal('D 最大连赢 = 3（跨过 0 盈亏）', metrics.maxConsecutiveWins, 3)
  equal('D 最大连亏 = 4（0 盈亏不打断连亏）', metrics.maxConsecutiveLosses, 4)
}

// ───────────────────────────── 5. 曝露率（含空头持仓）─────────────────────────────

{
  const curve = [point(0, 10000, -1), point(1, 10000, 0), point(2, 10000, 1), point(3, 10000, 0), point(4, 10000, 2)]
  const metrics = computeMetrics(makeResult({ equityCurve: curve }))
  near('E 曝露率：qty≠0 的点数占比 = 3/5*100', metrics.exposurePct, 60)
}

// ───────────────────────────── 6. 基准兜底 / 负权益 / 宽容入参 ─────────────────────────────

{
  // 价格 0 是非法行情 → Buy&Hold 整组给 null，而不是 NaN
  const result = makeResult({ equityCurve: [point(0, 10000, 0, 0), point(1, 9000, 0, 100)] })
  const metrics = computeMetrics(result)
  checkMetricsShape('F1 价格非法 fixture', metrics)
  equal('F1 首根价格非法 → buyHoldReturnPct null', metrics.buyHoldReturnPct, null)
  equal('F1 首根价格非法 → buyHoldFinalEquity null', metrics.buyHoldFinalEquity, null)
  equal('F1 首根价格非法 → buyHoldMaxDrawdownPct null', metrics.buyHoldMaxDrawdownPct, null)
}

{
  // 期末权益为负（1 倍空头被拉爆）：总收益照实算（可以 < -100%），年化没有实数定义 → null
  const result = makeResult({ equityCurve: [point(0, 10000), point(1, -5000, 0, 50)] })
  const metrics = computeMetrics(result)
  checkMetricsShape('F2 负权益 fixture', metrics)
  near('F2 总收益 = -150%', metrics.totalReturnPct, -150)
  equal('F2 期末权益 ≤ 0 时年化收益 null', metrics.annualizedReturnPct, null)
  near('F2 最大回撤 = 150%', metrics.maxDrawdownPct, 150)
  near('F2 Buy&Hold 收益 = -50%', metrics.buyHoldReturnPct, -50)
}

{
  // 宽容入参：报告绝不能因为 result 字段缺失而崩（引擎/CLI 的契约校验由别的测试负责）
  let threw = false
  let metrics = null
  try {
    metrics = computeMetrics({})
  } catch (error) {
    threw = true
  }
  check('G 空 result 不抛错', threw === false)
  if (metrics !== null) {
    checkMetricsShape('G 空 result', metrics)
    equal('G bars = null', metrics.bars, null)
    equal('G tradeCount = 0', metrics.tradeCount, 0)
    equal('G 总收益 = null（没有初始资金）', metrics.totalReturnPct, null)
  }
  let threwNull = false
  try {
    computeMetrics(null)
  } catch (error) {
    threwNull = true
  }
  check('G computeMetrics(null) 不抛错', threwNull === false)
}

{
  // 未知周期：ppY 退化用资金曲线相邻点间隔推断，仍然算得出年化波动率
  const config = makeConfig({ bar: '1h' })
  const badConfig = { ...config, bar: '2h' } // 故意给个不存在的周期 id
  const curve = [point(0, 10000), point(1, 10100), point(2, 10000)]
  const metrics = computeMetrics(makeResult({ config: badConfig, equityCurve: curve }))
  checkMetricsShape('H 未知周期 fixture', metrics)
  check('H 未知周期时仍能算出波动率', typeof metrics.volatilityPct === 'number' && Number.isFinite(metrics.volatilityPct))
}

{
  // result.fees 缺失时从 fills 反推手续费汇总（报告不该因为少一个汇总字段就显示 null）
  const fills = [
    { t: T0, fee: 1.5, feeKind: 'maker' },
    { t: T0 + HOUR, fee: 2.5, feeKind: 'taker' },
  ]
  const result = makeResult({ equityCurve: [point(0, 10000), point(1, 10000)], fills })
  delete result.fees
  const metrics = computeMetrics(result)
  near('I 缺 fees 汇总时从 fills 反推 maker', metrics.feesMaker, 1.5)
  near('I 缺 fees 汇总时从 fills 反推 taker', metrics.feesTaker, 2.5)
  near('I 缺 fees 汇总时从 fills 反推 total', metrics.feesTotal, 4)
}

{
  // 爆仓次数 / 被拒委托数
  const result = makeResult({
    equityCurve: [point(0, 10000), point(1, 10000)],
    liquidations: [{ t: T0, price: 1, qty: 1, equityAfter: 0 }, { t: T0, price: 1, qty: 1, equityAfter: 0 }],
    rejected: [{ t: T0, reason: '杠杆/保证金不足', order: {} }],
  })
  const metrics = computeMetrics(result)
  equal('J 爆仓次数 = liquidations.length', metrics.liquidations, 2)
}

// ───────────────────────────── 7. formatConsole ─────────────────────────────

{
  const text = formatConsole(RESULT_A, METRICS_A, BASE_CONFIG)
  const needles = [
    '配置', '绩效', '交易', '费用', '基准', '爆仓', '被拒',
    '总收益', '年化收益', '最大回撤', 'Sharpe', 'Sortino', 'Calmar', '波动率',
    '胜率', '盈亏比', '最大连亏', 'maker', 'taker', '合计',
    'Buy & Hold', 'BTC-USDT-SWAP', '1h', 'buy-hold',
  ]
  const missing = needles.filter((needle) => !text.includes(needle))
  check('K 控制台摘要含全部关键字', missing.length === 0, 'missing=' + JSON.stringify(missing))
  check('K 金额千分位（10,000.00 / 10,098.00）', text.includes('10,000.00') && text.includes('10,098.00'))
  check('K 百分比两位（+0.98%）', text.includes('+0.98%'))
  check('K 时间用 UTC+8 格式化（2024-01-01 08:00 UTC+8）', text.includes('2024-01-01 08:00 UTC+8'))
  check('K 无值显示 —', text.includes('—'))
  check('K 无亏损交易时盈利因子显示 ∞', text.includes('∞'))
  check('K 不使用 ANSI 颜色码', !/\x1b\[/.test(text))
  const dirty = ['NaN', 'Infinity', 'undefined'].filter((needle) => text.includes(needle))
  check('K 控制台无 NaN/Infinity/undefined', dirty.length === 0, dirty.join(','))
  const secrets = /(api[_-]?key|secret|passphrase|access[_-]?token)/i.test(text)
  check('K 控制台不含任何密钥类字段', secrets === false)
  // 中文对齐的副产物：每行都不该夹带首尾多余空格之外的制表符
  check('K 控制台没有制表符（等宽对齐用空格实现）', !text.includes('\t'))
}

{
  const emptyResult = makeResult({ equityCurve: [] })
  const emptyMetrics = computeMetrics(emptyResult)
  let threw = false
  let text = ''
  try {
    text = formatConsole(emptyResult, emptyMetrics, BASE_CONFIG)
  } catch (error) {
    threw = true
  }
  check('L 空结果也能打印控制台摘要', threw === false && text.length > 0)
  check('L 空结果用 — 占位', text.includes('—'))
  check('L 空结果无 NaN/Infinity', !text.includes('NaN') && !text.includes('Infinity'))
}

// ───────────────────────────── 8. JSON 报告 ─────────────────────────────

{
  const report = buildJsonReport({
    result: RESULT_A,
    metrics: METRICS_A,
    config: BASE_CONFIG,
    strategy: RESULT_A.strategy,
    generatedAt: NOW,
  })
  equal('M JSON 顶层字段恰好 6 个', Object.keys(report).sort().join(','), 'config,framework,generatedAt,metrics,result,strategy')
  equal('M framework 标识', report.framework, 'btc-dashboard/backtest')
  equal('M generatedAt 原样保留（毫秒）', report.generatedAt, NOW)
  equal('M strategy.name 正确', report.strategy.name, 'buy-hold')
  equal('M result 全量带上：资金曲线点数', report.result.equityCurve.length, 3)
  equal('M result 全量带上：交易数', report.result.trades.length, 1)
  equal('M metrics 原样引用', report.metrics, METRICS_A)

  let parseOk = true
  let parsed = null
  try {
    const raw = JSON.stringify(report, null, 2)
    check('M JSON.stringify 不含 NaN/Infinity 字符串', !/NaN|Infinity/.test(raw))
    parsed = JSON.parse(raw)
  } catch (error) {
    parseOk = false
  }
  check('M JSON 可解析', parseOk === true)
  if (parsed !== null) {
    equal('M 解析后 framework 一致', parsed.framework, 'btc-dashboard/backtest')
    near('M 解析后总收益一致', parsed.metrics.totalReturnPct, 0.98)
    equal('M 解析后 profitFactor 仍是 null（不依赖 stringify 的巧合）', parsed.metrics.profitFactor, null)
    equal('M 解析后 equityCurve 全量', parsed.result.equityCurve.length, 3)
  }

  // generatedAt 也接受 ISO 字符串（统一转毫秒）
  const isoReport = buildJsonReport({ result: RESULT_A, metrics: METRICS_A, config: BASE_CONFIG, generatedAt: '2024-01-11T00:00:00Z' })
  equal('M generatedAt 接受 ISO 字符串并转毫秒', isoReport.generatedAt, Date.UTC(2024, 0, 11, 0, 0, 0))

  // JSON 报告按 SPEC §8 原样带 config（含 dataDir 等），但 HTML 里不应出现本机绝对路径
  const html = buildHtmlReport({
    result: RESULT_A,
    metrics: METRICS_A,
    config: BASE_CONFIG,
    strategy: RESULT_A.strategy,
    generatedAt: NOW,
  })
  check('M HTML 不泄露本机 dataDir 绝对路径', html.includes(BASE_CONFIG.dataDir) === false)
}

// ───────────────────────────── 9. HTML 报告：自包含 / 转义 / SVG / 截断 ─────────────────────────────

/** SVG 里所有 points 坐标必须是有限数字（空图兜底时可能没有 points 属性）。 */
function svgCoordinatesAreFinite(html) {
  const attributes = html.match(/points="([^"]*)"/g) ?? []
  if (attributes.length === 0) return false
  for (const attribute of attributes) {
    const raw = attribute.slice('points="'.length, -1).trim()
    if (raw === '') continue
    for (const pair of raw.split(/\s+/)) {
      const [x, y] = pair.split(',')
      if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return false
    }
  }
  return true
}

const EVIL_RESULT = makeResult({
  equityCurve: CURVE_A,
  strategy: { name: 'evil<script>alert(1)</script>', params: { note: '<b>参数</b>' } },
  trades: [{
    ...TRADES_A[0],
    exitReason: 'stop, "手动" <b>注入了标签</b>',
  }],
  fills: RESULT_A.fills,
  fees: RESULT_A.fees,
  rejected: RESULT_A.rejected,
})
const EVIL_METRICS = computeMetrics(EVIL_RESULT)
const EVIL_HTML = buildHtmlReport({
  result: EVIL_RESULT,
  metrics: EVIL_METRICS,
  config: BASE_CONFIG,
  strategy: EVIL_RESULT.strategy,
  generatedAt: NOW,
})

{
  check('N HTML 以 <!DOCTYPE html> 开头', EVIL_HTML.startsWith('<!DOCTYPE html>'))
  check('N HTML 声明 utf-8', EVIL_HTML.includes('<meta charset="utf-8">'))
  check('N HTML 有内联 CSS', EVIL_HTML.includes('<style>') && EVIL_HTML.includes('</style>'))
  check('N HTML 有内联 SVG（资金曲线 + 回撤曲线）', (EVIL_HTML.match(/<svg/g) ?? []).length >= 2)
  check('N HTML 无任何外部 http(s) 链接', /https?:\/\//i.test(EVIL_HTML) === false)
  check('N HTML 无 script 标签', /<script/i.test(EVIL_HTML) === false)
  check('N HTML 无外部资源属性（src=/href=）', !/\s(?:src|href)=/i.test(EVIL_HTML))
  const sections = ['资金曲线', '回撤曲线', '交易明细', '基准对比', '费用与风险', '回测配置', '局限说明']
  const missing = sections.filter((text) => !EVIL_HTML.includes(text))
  check('N HTML 含全部要求的小节', missing.length === 0, 'missing=' + JSON.stringify(missing))
  check('N HTML 含 Buy & Hold 基准图例', EVIL_HTML.includes('Buy &amp; Hold 基准（现货持有）'))
  check('N HTML 含生成时间（UTC+8）', EVIL_HTML.includes('2024-01-11 08:00 UTC+8'))

  // 转义：策略名/平仓原因里的 HTML 不能变成真标签
  check('N 策略名被 HTML 转义', EVIL_HTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  check('N 平仓原因被 HTML 转义', EVIL_HTML.includes('&lt;b&gt;注入了标签&lt;/b&gt;'))
  check('N 转义后没有可执行 script', EVIL_HTML.includes('<script>alert(1)</script>') === false)
  check('N 没有双重转义（&amp;amp;）', EVIL_HTML.includes('&amp;amp;') === false)
  const dirty = ['NaN', 'Infinity', 'undefined'].filter((text) => EVIL_HTML.includes(text))
  check('N HTML 无 NaN/Infinity/undefined', dirty.length === 0, dirty.join(','))
  check('N SVG 坐标全部是有限数字', svgCoordinatesAreFinite(EVIL_HTML))
  check('N 交易表 1 行', (EVIL_HTML.match(/class="trade-row"/g) ?? []).length === 1)
  const secrets = /(api[_-]?key|secret|passphrase|access[_-]?token)/i.test(EVIL_HTML)
  check('N HTML 不含任何密钥类字段', secrets === false)
}

{
  // 交易表最多 500 行 + 截断说明
  const manyTrades = Array.from({ length: 600 }, (unused, index) => makeTrade(index, index % 3 === 0 ? -5 : 8))
  const result = makeResult({ equityCurve: [point(0, 10000), point(1, 10000)], trades: manyTrades })
  const metrics = computeMetrics(result)
  check('O 600 笔交易的指标可算', metrics.tradeCount === 600)
  const html = buildHtmlReport({ result, metrics, config: BASE_CONFIG, strategy: { name: 'sma-cross', params: {} }, generatedAt: NOW })
  check('O 交易表最多 500 行', (html.match(/class="trade-row"/g) ?? []).length === 500)
  check('O 截断有说明', html.includes('共 600 笔交易') && html.includes('仅展示前 500 笔'))
}

{
  // 空数据：SVG 兜底也不能出 NaN
  const emptyResult = makeResult({ equityCurve: [] })
  const emptyMetrics = computeMetrics(emptyResult)
  const html = buildHtmlReport({ result: emptyResult, metrics: emptyMetrics, config: BASE_CONFIG, generatedAt: NOW })
  check('P 空数据 HTML 仍有合法 SVG', html.includes('<svg'))
  check('P 空数据 SVG 有占位文案', html.includes('暂无资金曲线数据'))
  check('P 空数据 HTML 无 NaN/Infinity', !html.includes('NaN') && !html.includes('Infinity'))
  check('P 空数据 HTML 仍自包含', /https?:\/\//i.test(html) === false)
}

{
  // 只有 1 个/2 个资金曲线点的极端情况：坐标不能除零出 NaN
  for (const [label, curveLength] of [['单点', 1], ['两点', 2]]) {
    const curve = Array.from({ length: curveLength }, (unused, index) => point(index, 10000 + index * 100))
    const result = makeResult({ equityCurve: curve })
    const html = buildHtmlReport({ result, metrics: computeMetrics(result), config: BASE_CONFIG, generatedAt: NOW })
    check('P ' + label + '曲线 HTML 无 NaN/Infinity', !html.includes('NaN') && !html.includes('Infinity'))
    check('P ' + label + '曲线 SVG 坐标有限', svgCoordinatesAreFinite(html))
    check('P ' + label + '曲线 HTML 自包含', /https?:\/\//i.test(html) === false)
  }
}

{
  // 报告模块对“只给 result、不给 metrics”也要能忍（内部回退 computeMetrics）
  let consoleText = ''
  let html = ''
  let threw = false
  try {
    consoleText = formatConsole(RESULT_A, undefined, BASE_CONFIG)
    html = buildHtmlReport({ result: RESULT_A, config: BASE_CONFIG, strategy: RESULT_A.strategy, generatedAt: NOW })
  } catch (error) {
    threw = true
  }
  check('P 缺 metrics 参数时报告不崩', threw === false)
  check('P 缺 metrics 参数时控制台仍含总收益', consoleText.includes('总收益'))
  check('P 缺 metrics 参数时 HTML 仍含 KPI', html.includes('总收益'))
}

// ───────────────────────────── 9b. HTML 报告：K 线图（蜡烛 + 持仓底纹 + 交易标记）─────────────────────────────

/** 造一段可画的 K 线（带涨跌起伏，方便验证阳线/阴线两种实体）。 */
function makeBars(count, startIndex = 0) {
  const bars = []
  let price = 42000
  for (let index = 0; index < count; index += 1) {
    const open = price
    const close = open * (1 + Math.sin((startIndex + index) / 9) * 0.008 + 0.0004)
    bars.push({
      t: T0 + (startIndex + index) * HOUR,
      o: open,
      h: Math.max(open, close) * 1.003,
      l: Math.min(open, close) * 0.997,
      c: close,
      v: 100 + index,
    })
    price = close
  }
  return bars
}

{
  const bars = makeBars(80)
  // 第 30–59 根持仓中、其余空仓 —— 用来验证「持仓底纹」
  const curve = bars.map((bar, index) => point(index, 10000 + index * 20, index >= 30 && index < 60 ? 0.2 : 0, bar.c, bar.t))
  const trades = [
    makeTrade(0, 120, { entryT: bars[30].t, entryPrice: bars[30].o, exitT: bars[59].t, exitPrice: bars[59].c }),
    makeTrade(1, -80, { side: 'short', entryT: bars[60].t, entryPrice: bars[60].o, exitT: bars[79].t, exitPrice: bars[79].c }),
  ]
  const result = makeResult({ equityCurve: curve, trades })
  const html = buildHtmlReport({
    result, metrics: computeMetrics(result), config: BASE_CONFIG,
    strategy: { name: 'donchian-trend', params: {} }, generatedAt: NOW, bars,
  })

  check('R K 线小节存在', html.includes('价格 K 线与交易标记'))
  check('R 80 根 K 线画成 80 根蜡烛（未触发聚合）', (html.match(/class="candle-(up|down)"/g) ?? []).length === 80)
  check('R 蜡烛有上下影线', (html.match(/class="wick-(up|down)"/g) ?? []).length === 80)
  check('R 持仓的 30 根有底纹', (html.match(/class="hold-band"/g) ?? []).length === 30)
  check('R 两笔交易画出 4 个标记（2 开仓 + 2 平仓）', (html.match(/class="marker-(long|short|win|loss)"/g) ?? []).length === 4)
  check('R 标记带悬停说明（开多/平仓）', html.includes('<title>开多') && html.includes('<title>平仓'))
  const legends = ['阳线', '阴线', '持仓中', '▲ 开多', '▼ 开空']
  check('R K 线图例完整', legends.every((text) => html.includes(text)), legends.filter((text) => !html.includes(text)).join(','))
  check('R K 线图无 NaN/Infinity', !html.includes('NaN') && !html.includes('Infinity'))
  check('R K 线报告仍自包含（无 http 链接、无 script）', /https?:\/\//i.test(html) === false && /<script/i.test(html) === false)
  check('R K 线报告 SVG 坐标有限', svgCoordinatesAreFinite(html))
  check('R K 线报告有 3 张图（K 线 + 资金 + 回撤）', (html.match(/<svg/g) ?? []).length >= 3)
}

{
  // 大量 K 线：按桶聚合到 ≤480 根，并在图上注明
  const manyBars = makeBars(2000)
  const manyResult = makeResult({
    equityCurve: manyBars.map((bar, index) => point(index, 10000 + index, 0, bar.c, bar.t)),
    trades: [],
  })
  const manyHtml = buildHtmlReport({
    result: manyResult, metrics: computeMetrics(manyResult), config: BASE_CONFIG, generatedAt: NOW, bars: manyBars,
  })
  const candleCount = (manyHtml.match(/class="candle-(up|down)"/g) ?? []).length
  check('R 2000 根 K 线聚合后 ≤480 根', candleCount > 0 && candleCount <= 480, 'candles=' + String(candleCount))
  check('R 聚合有文字说明', manyHtml.includes('聚合为 1 根'))
  check('R 聚合后无 NaN/Infinity', !manyHtml.includes('NaN') && !manyHtml.includes('Infinity'))
}

{
  // 不传 bars：占位文案，不崩、不出 NaN（旧调用方/JSON-only 场景要能忍）
  const noBarsHtml = buildHtmlReport({
    result: RESULT_A, metrics: METRICS_A, config: BASE_CONFIG, strategy: RESULT_A.strategy, generatedAt: NOW,
  })
  check('R 不传 bars 时显示占位文案', noBarsHtml.includes('未提供 K 线数据'))
  check('R 不传 bars 时其它小节照常', noBarsHtml.includes('资金曲线') && noBarsHtml.includes('回撤曲线'))
  check('R 不传 bars 时无 NaN', !noBarsHtml.includes('NaN'))
}

// ───────────────────────────── 10. writeReports：三件套落盘 ─────────────────────────────

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'bt-metrics-test-'))
try {
  const outDir = join(TEMP_ROOT, 'nested', 'reports')
  const paths = await writeReports({
    result: RESULT_A,
    metrics: METRICS_A,
    config: BASE_CONFIG,
    strategy: RESULT_A.strategy,
    outDir,
    bars: makeBars(30),
  })
  check('Q writeReports 返回三个路径', typeof paths.jsonPath === 'string'
    && typeof paths.htmlPath === 'string' && typeof paths.csvPath === 'string')
  check('Q 三个路径都是绝对路径', isAbsolute(paths.jsonPath) && isAbsolute(paths.htmlPath) && isAbsolute(paths.csvPath))
  check('Q 自动 mkdir -p（目录不存在也能写）', existsSync(outDir))
  check('Q 三个文件都生成', existsSync(paths.jsonPath) && existsSync(paths.htmlPath) && existsSync(paths.csvPath))

  // 文件名：<instId>-<bar>-<strategy>-<起YYYYMMDD>-<止YYYYMMDD>.<ext>
  equal('Q JSON 文件名符合规则', basename(paths.jsonPath), 'BTC-USDT-SWAP-1h-buy-hold-20240101-20240111.json')
  equal('Q HTML 文件名符合规则', basename(paths.htmlPath), 'BTC-USDT-SWAP-1h-buy-hold-20240101-20240111.html')
  equal('Q CSV 文件名符合规则', basename(paths.csvPath), 'BTC-USDT-SWAP-1h-buy-hold-20240101-20240111.csv')

  // JSON：可解析、全量
  let report = null
  let jsonOk = true
  try {
    report = JSON.parse(readFileSync(paths.jsonPath, 'utf8'))
  } catch (error) {
    jsonOk = false
  }
  check('Q JSON 报告可解析', jsonOk === true)
  if (report !== null) {
    equal('Q JSON report.framework', report.framework, 'btc-dashboard/backtest')
    equal('Q JSON report.config.instId', report.config.instId, 'BTC-USDT-SWAP')
    equal('Q JSON report.result.equityCurve 全量', report.result.equityCurve.length, 3)
    near('Q JSON report.metrics 与内存一致', report.metrics.totalReturnPct, 0.98)
  }

  // HTML：自包含、无外链
  const html = readFileSync(paths.htmlPath, 'utf8')
  check('Q 写入的 HTML 自包含（无 http 链接）', /https?:\/\//i.test(html) === false)
  check('Q 写入的 HTML 有内联 SVG', html.includes('<svg'))
  check('Q 写入的 HTML 含 K 线图（bars 透传进报告）', html.includes('价格 K 线与交易标记')
    && (html.match(/class="candle-(up|down)"/g) ?? []).length === 30)
  check('Q 写入的 HTML 声明 utf-8', html.includes('<meta charset="utf-8">'))

  // CSV：表头/时间格式/行数
  const csv = readFileSync(paths.csvPath, 'utf8')
  const csvLines = csv.split('\n').filter((line) => line !== '')
  equal('Q CSV 表头符合 SPEC §8', csvLines[0],
    'seq,side,qty,entry_t,entry_price,exit_t,exit_price,pnl,pnl_pct,fees,bars,exit_reason')
  equal('Q CSV 行数 = 交易数 + 表头', csvLines.length, TRADES_A.length + 1)
  const fields = csvLines[1].split(',')
  check('Q CSV 时间为 UTC ISO（秒级）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fields[3])
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fields[5]), JSON.stringify([fields[3], fields[5]]))
  equal('Q CSV 开仓时间 = 2024-01-01T00:00:00Z', fields[3], '2024-01-01T00:00:00Z')
  equal('Q CSV 平仓时间 = 2024-01-01T02:00:00Z', fields[5], '2024-01-01T02:00:00Z')
  equal('Q CSV side 字段', fields[1], 'long')
  equal('Q CSV pnl 字段', fields[7], '98')

  // CSV 转义：平仓原因里有逗号和引号时必须按 RFC 4180 加引号
  const escapingDir = join(TEMP_ROOT, 'escaping')
  const escapingPaths = await writeReports({
    result: EVIL_RESULT,
    metrics: EVIL_METRICS,
    config: BASE_CONFIG,
    strategy: EVIL_RESULT.strategy,
    outDir: escapingDir,
  })
  const escapingCsv = readFileSync(escapingPaths.csvPath, 'utf8')
  check('Q CSV 逗号/引号字段被正确转义', escapingCsv.includes('"stop, ""手动"" <b>注入了标签</b>"'))
  // 策略名里的非法文件名字符要清洗掉，不能把路径搞坏
  check('Q 策略名非法字符被清洗', basename(escapingPaths.jsonPath).includes('/') === false
    && basename(escapingPaths.jsonPath).includes('<') === false
    && basename(escapingPaths.jsonPath).startsWith('BTC-USDT-SWAP-1h-evil_script_'))
} finally {
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true })
  } catch (error) {
    // 临时目录删不掉不影响测试结论
  }
}

// ───────────────────────────── 汇总 ─────────────────────────────

console.log('')
if (failed > 0) {
  console.log('── ' + failed + ' 项失败（' + passed + ' 项通过）')
  process.exitCode = 1
} else {
  console.log('全部通过（' + passed + ' 项断言）')
}
