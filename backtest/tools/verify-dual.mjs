/**
 * 独立验证工具 verify-dual（研究/验收用，不是策略本身）。
 *
 * 为什么单独写一个工具：研发交上来的「总收益 / 年化 / 回撤」不能直接采信，
 * 独立验证必须能**一键重跑**下面这些检查，并且把口径固定住（同一份代码、同一个 now 快照、
 * 同一份本地缓存），任何人复跑都得到同样的数字：
 *
 *   1. 复现：干净跑 2020-01-01 → now（--offline 本地缓存），和研发报告/预期值逐项对账；
 *      同一个回测连跑两次，资金曲线必须逐点相同（防模块级状态跨 run 泄漏）。
 *   2. 因果探针（前视偏差客观检查）：把 K 线截断到 60% / 85% 再跑一遍，
 *      截断前已经发生的每一根 K 线权益、每一笔成交，必须与全量回测完全一致。
 *   3. funding 敏感性：--no-funding / 估算 0.005% / 0.01% / 0.02%（每 8h）四种口径。
 *      离线模式下 OKX 历史只覆盖最近约 3 个月，其余按估算费率，工具原样复刻 CLI 口径。
 *   4. 分年度（2020…2026）两套口径（独立回测 / 连续运行切片）与子区间
 *      （2020-2022 / 2022 熊市 / 2023-至今 / 2025-至今）稳健性。
 *   5. 参数邻域敏感性：最优参数沿各轴单独微调（±1~2 档），看收益/回撤是否塌方（是否孤点）。
 *   6. walk-forward：训练段内选参（只按训练段指标排名）→ 验证段评估，验证段不参与选择；
 *      默认 3 种切分（训练到 2024-08-01 / 2023-01-01 / 2024-10-03，最后一种与验收参照对齐）。
 *      网格不大时还会把每组参数的验证段都跑一遍，看「训练段排名 ↔ 验证段表现」的整体关系。
 *   7. 验证段两种口径：
 *      ① 独立启动：2024-10-03 从 10,000 USDT、空仓重新回测；
 *      ② 连续运行切片：从 2020 连续跑，在全样本 equityCurve 上切出 2024-10-03 之后的表现
 *         （以段内第一个权益点为起点，保留跨段持仓；与 Lead 参照口径一致；同时给出
 *         以段前一根收盘为起点的对照值 totalReturnIncludingFirstBarPct）。
 *   8. 同口径对比表：候选 vs 主基线（breakout-hold）/ 次基线（donchian 稳健档）/ 其它候选，
 *      列全样本总收益、年化、回撤、Calmar、夏普、交易、持仓占比、funding 净支出、两种验证段口径。
 *
 * 口径（和框架保持一致，不在工具里发明新口径）：
 *   - 1x、maker 0.0200% / taker 0.0500%、初始 10000 USDT、closeAtEnd=true；
 *   - 指标一律来自 lib/metrics.mjs，回测一律走 lib/engine.mjs（不绕过撮合、不自己算指标）；
 *   - now 固定为 NOW_MS 快照（2026-10-18 05:00Z = UTC+8 13:00），复跑不会因机器时间漂移。
 *
 * 用法：
 *   node backtest/tools/verify-dual.mjs --mode all --out backtest/reports/_scratch/verify/final
 *   node backtest/tools/verify-dual.mjs --mode all --only cand-multi-tf-dual,cand-adaptive-dual-frozen
 *   node backtest/tools/verify-dual.mjs --mode full --only base-breakout-hold
 *   node backtest/tools/verify-dual.mjs --help
 *
 * 追加/自定义验证对象（不改本文件）：
 *   --spec "label:strategy:bar:参数=值,参数=值"     空参数 = 用策略文件里的默认参数
 *   --nbr  "label|axis=值1,值2|axis2=..."           自定义邻域轴（不传则按数字参数自动 ±2）
 *   --walk "label|axis=值1,值2|axis2=..."           自定义 walk-forward 训练网格（笛卡尔积 ≤2000）
 *   --expect "label:总收益:年化:回撤:交易数"         复现断言期望值（可重复）
 *   --splits "2024-08-01,2023-01-01"               自定义 walk-forward 切分点（UTC+8 日期）
 *
 * 输出：控制台表格 + <out>/results.json（全部原始数字）+ <out>/report.md（可贴进验证报告）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  DEFAULT_MAKER_FEE_RATE,
  DEFAULT_TAKER_FEE_RATE,
  FUNDING_INTERVAL_MS,
  formatTimeUtc8,
  normalizeConfig,
} from '../lib/config.mjs'
import { buildFundingEvents, loadBars, loadFundingRates } from '../lib/data.mjs'
import { loadStrategy, withResolvedParams } from '../lib/strategy.mjs'
import { runBacktest } from '../lib/engine.mjs'
import { computeMetrics } from '../lib/metrics.mjs'

// ============================================================================
// 固定口径（改这些等于改验证结论的可比性，别随便动）
// ============================================================================

/** 验证用 now 快照：2026-10-18 05:00Z（= UTC+8 13:00）。4h 缓存最后一根已收盘 K 线在 04:00Z 收盘。 */
const NOW_MS = Date.UTC(2026, 9, 18, 5, 0, 0)
/** 全样本起点：2020-01-01 00:00 UTC+8。 */
const FULL_START_MS = Date.parse('2020-01-01T00:00:00+08:00')
/** 验证段起点：2024-10-03 00:00 UTC+8（Lead 参照口径）。 */
const VAL_START_MS = Date.parse('2024-10-03T00:00:00+08:00')
const INST_ID = 'BTC-USDT-SWAP'
const INITIAL_CAPITAL = 10_000
const LEVERAGE = 1
const DAY_MS = 86_400_000
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

/** TIMEFRAMES 的毫秒数表（工具只跑常见周期，未知 id 直接报错）。 */
const BAR_MS = Object.freeze({
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1D': 86_400_000,
})

/** funding 敏感性四档：null = 完全不计；其余是估算费率（每 8h）。 */
const FUNDING_VARIANTS = [
  { key: 'nofund', label: '不含 funding', includeFunding: false, fundingRate: 0 },
  { key: 'f0005', label: '估算 0.005%/8h', includeFunding: true, fundingRate: 0.00005 },
  { key: 'f0010', label: '估算 0.010%/8h', includeFunding: true, fundingRate: 0.0001 },
  { key: 'f0020', label: '估算 0.020%/8h', includeFunding: true, fundingRate: 0.0002 },
]

/** 子区间：全样本之外最该看的几段（2022 单边熊、2025-2026 震荡/下跌）。 */
const SUBPERIODS = [
  { key: '2020-2022', label: '2020-2022', start: '2020-01-01', end: '2023-01-01' },
  { key: 'bear-2022', label: '2022 熊市段', start: '2022-01-01', end: '2023-01-01' },
  { key: '2023-now', label: '2023→now', start: '2023-01-01', end: null },
  { key: 'range-2025', label: '2025-2026 段', start: '2025-01-01', end: null },
]

/** walk-forward 切分：训练从 2020-01-01 起，到 trainEnd 为止；验证段从 trainEnd 到 now。 */
const WALK_SPLITS = [
  { key: 'train-2024-08', label: '训练 2020-01→2024-08-01', trainEnd: '2024-08-01' },
  { key: 'train-2023-01', label: '训练 2020-01→2023-01-01', trainEnd: '2023-01-01' },
  { key: 'train-2024-10', label: '训练 2020-01→2024-10-02（验收参照）', trainEnd: '2024-10-03' },
]

/**
 * 内置验证对象：两个基线 + 第 8 项参照 + 两个冻结候选。
 * expect 是「期望值」（研发/Lead 报告里的数字或本工具独立跑出的基准值），
 * 用来抓复现偏差：只要对不上，后续结论就不可直接采信。
 */
const DEFAULT_SPECS = [
  {
    label: 'base-breakout-hold',
    note: '主基线（README 推荐主策略）：breakout-hold 4h 默认参数',
    strategy: 'breakout-hold',
    bar: '4h',
    params: { entryWindow: 36, ma: 240, enterBuffer: 0.008, exitBuffer: 0.008, weight: 1 },
    expect: {
      totalReturnPct: 2585.519304236672,
      annualizedReturnPct: 62.221678571685814,
      maxDrawdownPct: 34.50175123486847,
      tradeCount: 50,
    },
    nbr: {
      entryWindow: [24, 30, 36, 42, 48],
      ma: [180, 210, 240, 270, 300],
      enterBuffer: [0.004, 0.006, 0.008, 0.010, 0.012],
      exitBuffer: [0.004, 0.006, 0.008, 0.010, 0.012],
      weight: [0.5, 0.75, 1],
    },
    walkGrid: {
      entryWindow: [24, 30, 36, 42, 48],
      enterBuffer: [0.006, 0.008, 0.010],
      exitBuffer: [0.006, 0.008, 0.010],
    },
  },
  {
    label: 'base-4h-robust',
    note: '次基线：donchian-trend 4h slopeFilter=true exitWindow=60',
    strategy: 'donchian-trend',
    bar: '4h',
    params: { slopeFilter: true, exitWindow: 60 },
    expect: {
      totalReturnPct: 1520.4651567112855,
      annualizedReturnPct: 50.60949847441272,
      maxDrawdownPct: 38.3611457260624,
      tradeCount: 87,
    },
    nbr: {
      entryWindow: [24, 30, 36, 48, 60],
      exitWindow: [40, 50, 60, 80, 100],
      trendWindow: [80, 100, 120, 200],
      slopeFilter: [false],
    },
    walkGrid: {
      entryWindow: [24, 36, 48, 60],
      exitWindow: [24, 36, 60, 80],
      trendWindow: [80, 120, 200],
      slopeFilter: [true, false],
      atrStop: [0],
    },
  },
  {
    label: 'item8-1d-dual',
    note: '第 8 项参照起点：donchian-trend 1D 5/10/50 allowShort（应复现 1639.73%）',
    strategy: 'donchian-trend',
    bar: '1D',
    params: { entryWindow: 5, exitWindow: 10, trendWindow: 50, allowShort: true },
    expect: {
      totalReturnPct: 1639.7303102987223,
      annualizedReturnPct: 52.20321046764656,
      maxDrawdownPct: 51.78222258345202,
      tradeCount: 76,
    },
    nbr: {
      entryWindow: [3, 4, 5, 6, 7, 8],
      exitWindow: [8, 9, 10, 11, 12, 15],
      trendWindow: [0, 45, 50, 55, 60],
      allowShort: [false],
    },
    walkGrid: {
      entryWindow: [3, 5, 8, 10, 15, 20],
      exitWindow: [5, 10, 15, 20, 30, 40],
      trendWindow: [0, 20, 50, 100, 150, 200],
      allowShort: [false, true],
    },
  },
  {
    label: 'cand-adaptive-dual-frozen',
    note: '方向 A 冻结版（1D 多空，SHA256 65236733…af7bd6）；期望值来自研发 FINAL-report',
    strategy: 'adaptive-dual',
    bar: '1D',
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
    expect: {
      totalReturnPct: 3135.63,
      annualizedReturnPct: 66.75,
      maxDrawdownPct: 36.09,
      tradeCount: 50,
      fundingTotal0p1: 31997.33,
    },
    nbr: {
      entryWindow: [3, 4, 5, 6, 8],
      longExitWindow: [8, 10, 11, 12, 13, 15],
      shortExitWindow: [4, 5, 6, 7, 8, 10],
      trendWindow: [30, 40, 50, 60, 80],
      longWindow: [150, 175, 200, 250],
      atrStop: [0, 3, 5, 7, 10],
      volTarget: [0, 0.3, 0.45, 0.5, 0.55, 0.7],
      bearMode: ['price', 'cross', 'either', 'off'],
      reversalMode: ['confirm'],
      allowShort: [false],
    },
    walkGrid: {
      entryWindow: [4, 5, 6],
      longExitWindow: [11, 12, 13],
      shortExitWindow: [5, 6, 7],
      longWindow: [175, 200],
      volTarget: [0.45, 0.5, 0.55],
    },
  },
  {
    label: 'cand-multi-tf-dual',
    note: '方向 B 冻结版（4h 多周期多空，SHA256 7AA7EF94…c5216）；期望值来自 Lead 独立复现',
    strategy: 'multi-tf-dual',
    bar: '4h',
    params: {
      entryWindow: 36,
      exitWindow: 120,
      trendWindow: 200,
      dailyWindow: 225,
      shortWindow: 24,
      shortExitWindow: 48,
      shortAtrStop: 0,
      regimeSlopeDays: 10,
      volTarget: 0,
      allowShort: true,
    },
    expect: {
      totalReturnPct: 4448.33,
      annualizedReturnPct: 75.29,
      maxDrawdownPct: 28.51,
      tradeCount: 68,
    },
    nbr: {
      entryWindow: [30, 34, 36, 38, 42],
      exitWindow: [90, 110, 120, 130, 150],
      trendWindow: [180, 190, 200, 210, 220],
      dailyWindow: [175, 200, 225, 250, 275],
      shortWindow: [18, 22, 24, 26, 30],
      shortExitWindow: [36, 42, 48, 54, 60],
      shortAtrStop: [0, 1, 2, 3],
      regimeSlopeDays: [5, 8, 10, 12, 15],
      volTarget: [0, 0.3, 0.55, 0.7],
      allowShort: [false],
    },
    walkGrid: {
      entryWindow: [30, 36, 42, 48, 54],
      exitWindow: [90, 120, 150, 180],
      trendWindow: [180, 200, 220],
    },
  },
]

// ============================================================================
// 小工具
// ============================================================================

function barMsOf(barId) {
  const ms = BAR_MS[barId]
  if (ms === undefined) throw new Error('工具不支持的周期：' + String(barId))
  return ms
}

function utc8Date(text) {
  const ms = Date.parse(text + 'T00:00:00+08:00')
  if (!Number.isFinite(ms)) throw new Error('日期无法解析：' + text)
  return ms
}

function fmtNum(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return Number(value).toFixed(digits)
}

function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return Number(value).toFixed(digits) + '%'
}

function fmtSignedPct(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%'
}

function fmtMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  const sign = n < 0 ? '-' : ''
  const [integer, decimal] = Math.abs(n).toFixed(2).split('.')
  return sign + integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + decimal
}

function paramsText(params) {
  const entries = Object.entries(params ?? {})
  return entries.length === 0 ? '（默认）' : entries.map(([key, value]) => key + '=' + String(value)).join(' ')
}

function cartesianProduct(axes) {
  const keys = Object.keys(axes)
  if (keys.length === 0) return [{}]
  let combos = [{}]
  for (const key of keys) {
    const next = []
    for (const combo of combos) {
      for (const value of axes[key]) next.push(Object.assign({}, combo, { [key]: value }))
    }
    combos = next
    if (combos.length > 2000) {
      throw new Error('网格组合超过 2000 组（' + combos.length + '），请缩小网格')
    }
  }
  return combos
}

/** lib/metrics 产出的指标 → 本工具表格用的一行（只挑关心的字段）。 */
function metricsRow(metrics) {
  return {
    bars: metrics.bars,
    days: metrics.days,
    finalEquity: metrics.finalEquity,
    totalReturnPct: metrics.totalReturnPct,
    annualizedReturnPct: metrics.annualizedReturnPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    sharpe: metrics.sharpe,
    sortino: metrics.sortino,
    calmar: metrics.calmar,
    tradeCount: metrics.tradeCount,
    winRatePct: metrics.winRatePct,
    profitFactor: metrics.profitFactor,
    exposurePct: metrics.exposurePct,
    feesTotal: metrics.feesTotal,
    fundingPaid: metrics.fundingPaid,
    fundingReceived: metrics.fundingReceived,
    fundingTotal: metrics.fundingTotal,
    fundingPctOfCapital: metrics.fundingPctOfCapital,
    liquidations: metrics.liquidations,
    buyHoldReturnPct: metrics.buyHoldReturnPct,
    buyHoldMaxDrawdownPct: metrics.buyHoldMaxDrawdownPct,
  }
}

/** 连续资金曲线按自然年切片的年度收益（跨年持仓不强制平仓）。 */
function computeChainedYearly(curve) {
  const groups = new Map()
  for (const point of curve) {
    const year = new Date(point.t + 8 * 3_600_000).getUTCFullYear()
    if (!groups.has(year)) groups.set(year, [])
    groups.get(year).push(point)
  }
  const out = []
  let base = curve.length > 0 ? curve[0].equity : null
  for (const [year, points] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
    const last = points[points.length - 1].equity
    const returnPct = base !== null && base > 0 ? (last / base - 1) * 100 : null
    let peak = null
    let dd = null
    for (const point of points) {
      if (peak === null || point.equity > peak) peak = point.equity
      if (peak !== null && peak > 0) {
        const drawdown = 1 - point.equity / peak
        if (dd === null || drawdown > dd) dd = drawdown
      }
    }
    out.push({ year, startEquity: points[0].equity, endEquity: last, returnPct, maxDrawdownPct: dd === null ? null : dd * 100, bars: points.length })
    base = last
  }
  return out
}

/**
 * 连续运行切片指标（验证段口径②）：在全样本 equityCurve 上取 2024-10-03 之后的这一段，
 * 保留跨段持仓的浮盈浮亏，而不是在段起点强制空仓重新起跑。
 *
 * 起点口径与 Lead 参照一致：以「段内第一个权益点」为起点（totalReturn = 段末/段首 - 1），
 * 段首那根 K 线自己的盈亏不计入；同时给出「以段前一根收盘为起点」的对照值。
 */
function sliceContinuousMetrics(result, startMs) {
  const curve = result.equityCurve
  if (!Array.isArray(curve) || curve.length < 3) return null
  const barMs = curve[1].t - curve[0].t
  if (!(barMs > 0)) return null
  let startIdx = -1
  for (let i = 0; i < curve.length; i += 1) {
    if (curve[i].t >= startMs) { startIdx = i; break }
  }
  if (startIdx < 0 || startIdx >= curve.length - 1) return null
  const slice = curve.slice(startIdx)
  const baseEquity = slice[0].equity
  const lastEquity = slice[slice.length - 1].equity
  const totalReturnPct = baseEquity > 0 && Number.isFinite(lastEquity) ? (lastEquity / baseEquity - 1) * 100 : null
  const priorEquity = startIdx > 0 ? curve[startIdx - 1].equity : null
  const totalReturnIncludingFirstBarPct = priorEquity !== null && priorEquity > 0 && Number.isFinite(lastEquity)
    ? (lastEquity / priorEquity - 1) * 100
    : null
  const firstT = slice[0].t
  const lastT = slice[slice.length - 1].t
  const days = (lastT - firstT + barMs) / DAY_MS
  const annualizedReturnPct = days >= 1 && baseEquity > 0 && lastEquity > 0
    ? (Math.pow(lastEquity / baseEquity, 365 / days) - 1) * 100
    : null
  let peak = baseEquity
  let dd = 0
  for (const point of slice) {
    if (point.equity > peak) peak = point.equity
    if (peak > 0) dd = Math.max(dd, 1 - point.equity / peak)
  }
  const returns = []
  for (let i = 1; i < slice.length; i += 1) {
    const previous = slice[i - 1].equity
    const current = slice[i].equity
    if (previous > 0 && Number.isFinite(current)) returns.push(current / previous - 1)
  }
  let sharpe = null
  let sortino = null
  let volatilityPct = null
  if (returns.length >= 2) {
    const ppY = MS_PER_YEAR / barMs
    const rootPpY = Math.sqrt(ppY)
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length
    let sumSq = 0
    let downsideSq = 0
    for (const value of returns) {
      sumSq += (value - mean) * (value - mean)
      const negative = Math.min(value, 0)
      downsideSq += negative * negative
    }
    const std = Math.sqrt(sumSq / returns.length)
    const downside = Math.sqrt(downsideSq / returns.length)
    if (std > 0) {
      sharpe = (mean / std) * rootPpY
      volatilityPct = std * rootPpY * 100
    }
    if (downside > 0) sortino = (mean / downside) * rootPpY
  }
  const calmar = annualizedReturnPct !== null && dd > 0 ? annualizedReturnPct / (dd * 100) : null
  const heldPoints = slice.filter((point) => point.qty !== 0).length
  const tradesInSlice = (result.trades ?? []).filter((trade) => trade.exitT >= startMs)
  let feesInSlice = 0
  for (const fill of result.fills ?? []) if (fill.t >= startMs) feesInSlice += fill.fee
  let fundingInSlice = 0
  for (const event of result.funding?.events ?? []) if (event.t >= startMs) fundingInSlice += event.amount
  return {
    start: firstT,
    end: lastT,
    days,
    bars: slice.length,
    startEquity: baseEquity,
    priorEquity,
    finalEquity: lastEquity,
    totalReturnPct,
    totalReturnIncludingFirstBarPct,
    annualizedReturnPct,
    maxDrawdownPct: dd * 100,
    volatilityPct,
    sharpe,
    sortino,
    calmar,
    tradeCount: tradesInSlice.length,
    exposurePct: slice.length > 0 ? (heldPoints / slice.length) * 100 : null,
    feesTotal: feesInSlice,
    fundingTotal: fundingInSlice,
    liquidationsInSlice: (result.liquidations ?? []).filter((item) => item.t >= startMs).length,
    carriedPositionAtStart: slice[0].qty !== 0 ? (slice[0].qty > 0 ? 'long' : 'short') : 'flat',
    carriedQty: slice[0].qty,
  }
}

// ============================================================================
// CLI 解析
// ============================================================================

const USAGE = [
  '独立验证工具 verify-dual（复现 / 因果探针 / funding / 子区间 / 邻域 / walk-forward / 对比表）',
  '',
  '用法：node backtest/tools/verify-dual.mjs [选项]',
  '',
  '  --mode <all|full|causality|funding|subperiod|nbr|walk|compare>  默认 all',
  '  --only <label1,label2>        只跑指定 label（默认跑全部内置对象 + 追加的 --spec）',
  '  --spec "label:strategy:bar:k=v,k=v"   追加验证对象（可重复）；bar 为 1D/4h 等 TIMEFRAMES id',
  '  --nbr  "label|axis=1,2,3|axis2=..."   自定义参数邻域轴（可重复）',
  '  --walk "label|axis=1,2|axis2=..."     自定义 walk-forward 训练段网格（可重复）',
  '  --expect "label:总收益:年化:回撤:交易数"  复现期望值（可重复，覆盖内置 expect）',
  '  --splits "2024-08-01,2023-01-01"      自定义 walk-forward 切分点（UTC+8 日期，可重复）',
  '  --walk-top <N>                验证段只评估训练段前 N 名（默认 5）',
  '  --out <目录>                  输出目录（默认 backtest/reports/_scratch/verify/last）',
  '  --json                        额外在 stdout 打印一行 JSON 摘要',
  '  --help, -h                    显示本帮助',
  '',
  '输出：控制台表格 + <out>/results.json + <out>/report.md',
].join('\n')

function parseArgs(argv) {
  const options = { specs: [], nbrs: [], walks: [], expects: [], splits: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const readValue = () => {
      if (i + 1 >= argv.length) throw new Error(arg + ' 缺少值')
      i += 1
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--mode') { options.mode = readValue(); continue }
    if (arg === '--only') { options.only = readValue().split(',').map((s) => s.trim()).filter(Boolean); continue }
    if (arg === '--spec') { options.specs.push(readValue()); continue }
    if (arg === '--nbr') { options.nbrs.push(readValue()); continue }
    if (arg === '--walk') { options.walks.push(readValue()); continue }
    if (arg === '--expect') { options.expects.push(readValue()); continue }
    if (arg === '--splits') { options.splits.push(...readValue().split(',').map((s) => s.trim()).filter(Boolean)); continue }
    if (arg === '--walk-top') { options.walkTop = Number(readValue()); continue }
    if (arg === '--out') { options.out = readValue(); continue }
    throw new Error('不认识的参数：' + arg + '（用 --help 看用法）')
  }
  return options
}

/** 解析 `label:strategy:bar:k=v,k=v`；参数部分可为空（用策略默认参数）。 */
function parseInlineSpec(text) {
  const pieces = String(text).split(':')
  if (pieces.length < 3) throw new Error('--spec 需要 label:strategy:bar:参数=值,...（收到：' + text + '）')
  const [label, strategy, bar] = pieces
  const paramsText = pieces.slice(3).join(':').trim()
  const params = {}
  if (paramsText !== '') {
    for (const piece of paramsText.split(',')) {
      const trimmed = piece.trim()
      if (trimmed === '') continue
      const at = trimmed.indexOf('=')
      if (at <= 0) throw new Error('--spec 的参数片段不合法：' + trimmed)
      const key = trimmed.slice(0, at).trim()
      const raw = trimmed.slice(at + 1).trim()
      if (raw === 'true') params[key] = true
      else if (raw === 'false') params[key] = false
      else if (raw !== '' && Number.isFinite(Number(raw))) params[key] = Number(raw)
      else params[key] = raw
    }
  }
  return { label, strategy, bar, params }
}

/** 解析 `label|axis=1,2,3|axis2=true,false` → { label, axes }。 */
function parseAxisSpec(text, kind) {
  const pieces = String(text).split('|').map((s) => s.trim()).filter(Boolean)
  if (pieces.length < 2) throw new Error(kind + ' 需要 label|axis=值1,值2（收到：' + text + '）')
  const label = pieces[0]
  const axes = {}
  for (const piece of pieces.slice(1)) {
    const at = piece.indexOf('=')
    if (at <= 0) throw new Error(kind + ' 的轴片段不合法：' + piece)
    const key = piece.slice(0, at).trim()
    const values = piece.slice(at + 1).split(',').map((v) => v.trim()).filter((v) => v !== '').map((v) => {
      if (v === 'true') return true
      if (v === 'false') return false
      const n = Number(v)
      return Number.isFinite(n) ? n : v
    })
    if (values.length === 0) throw new Error(kind + ' 的轴 ' + key + ' 没有值')
    axes[key] = values
  }
  return { label, axes }
}

// ============================================================================
// 数据加载（每个周期只加载一次；funding 历史只加载一次）
// ============================================================================

const barCache = new Map()

async function loadBarSet(bar) {
  if (barCache.has(bar)) return barCache.get(bar)
  const loaded = await loadBars({
    instId: INST_ID,
    bar,
    start: FULL_START_MS,
    end: NOW_MS,
    offline: true,
  })
  if (loaded.ok !== true) throw new Error('加载 ' + bar + ' K 线失败：' + (loaded.error || '未知原因'))
  const entry = { bars: loaded.bars, fromCache: loaded.fromCache === true, warnings: loaded.warnings }
  barCache.set(bar, entry)
  return entry
}

let fundingCachePromise = null
function loadFundingCache() {
  if (fundingCachePromise === null) {
    fundingCachePromise = loadFundingRates({
      instId: INST_ID,
      start: FULL_START_MS,
      end: NOW_MS,
      offline: true,
    }).then((loaded) => ({
      rates: loaded.rates,
      ok: loaded.ok === true,
      coverage: loaded.coverage,
      error: loaded.error,
      fromCache: loaded.fromCache === true,
    }))
  }
  return fundingCachePromise
}

// ============================================================================
// 回测执行（所有指标都从 lib/metrics.mjs 来）
// ============================================================================

/**
 * 在 [startMs, endMs) 上跑一段回测。
 * config.start/end 对齐到实际切到的 K 线（与 tools/sweep.mjs 同口径），
 * 避免报告展示的区间和真正参与回测的 K 线不一致。
 */
function runRange({ strategy, params, bar, barsAll, startMs, endMs, includeFunding, fundingRate, fundingRates }) {
  const barMs = barMsOf(bar)
  const start = Math.max(startMs, barsAll[0].t)
  const end = Math.min(endMs, barsAll[barsAll.length - 1].t + barMs)
  const bars = barsAll.filter((item) => item.t >= start && item.t < end)
  if (bars.length < 2) return null
  const actualStart = bars[0].t
  const actualEnd = bars[bars.length - 1].t + barMs
  const config = normalizeConfig({
    instId: INST_ID,
    bar,
    start: actualStart,
    end: actualEnd,
    initialCapital: INITIAL_CAPITAL,
    leverage: LEVERAGE,
    makerFeeRate: DEFAULT_MAKER_FEE_RATE,
    takerFeeRate: DEFAULT_TAKER_FEE_RATE,
    includeFunding: includeFunding === true,
    fundingRate: fundingRate === undefined ? 0.0001 : fundingRate,
    now: NOW_MS,
  })
  let fundingEvents = []
  let fundingMeta = null
  if (config.includeFunding) {
    const built = buildFundingEvents({
      rates: fundingRates ?? [],
      start: config.start,
      end: config.end,
      fallbackRate: config.fundingRate,
      intervalMs: FUNDING_INTERVAL_MS,
    })
    fundingEvents = built.events
    fundingMeta = Object.assign({}, built.meta, {
      source: fundingRates !== undefined && fundingRates.length > 0 ? 'offline-partial' : 'estimated',
      error: null,
    })
  }
  const resolved = withResolvedParams(strategy, params ?? {})
  const result = runBacktest({ bars, strategy: resolved, config, funding: fundingEvents, fundingMeta })
  const metrics = computeMetrics(result)
  return { result, metrics, bars, actualStart, actualEnd }
}

/** 一段回测 → 一行指标 + 实际覆盖范围。 */
function runToRow(options) {
  const run = runRange(options)
  if (run === null) return null
  return {
    metrics: metricsRow(run.metrics),
    actualStart: run.actualStart,
    actualEnd: run.actualEnd,
    bars: run.bars.length,
  }
}

// ============================================================================
// 检查 1：复现（连跑两次必须逐点一致）+ 与期望值对账
// ============================================================================

function checkRepro(spec, ctx, expected) {
  const run1 = runRange({
    strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
    startMs: FULL_START_MS, endMs: NOW_MS, includeFunding: false, fundingRates: ctx.fundingRates,
  })
  const run2 = runRange({
    strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
    startMs: FULL_START_MS, endMs: NOW_MS, includeFunding: false, fundingRates: ctx.fundingRates,
  })
  const m1 = metricsRow(run1.metrics)
  let curveDiffs = 0
  let maxCurveDiff = 0
  const n = Math.min(run1.result.equityCurve.length, run2.result.equityCurve.length)
  for (let i = 0; i < n; i += 1) {
    const a = run1.result.equityCurve[i].equity
    const b = run2.result.equityCurve[i].equity
    const diff = Math.abs(a - b)
    if (diff > 1e-9 * Math.max(1, Math.abs(a))) curveDiffs += 1
    if (diff > maxCurveDiff) maxCurveDiff = diff
  }
  const deterministic = run1.result.equityCurve.length === run2.result.equityCurve.length
    && run1.result.fills.length === run2.result.fills.length && curveDiffs === 0

  const mismatches = []
  if (expected !== null && expected !== undefined) {
    const pairs = [
      ['totalReturnPct', m1.totalReturnPct, 0.01],
      ['annualizedReturnPct', m1.annualizedReturnPct, 0.01],
      ['maxDrawdownPct', m1.maxDrawdownPct, 0.01],
      ['tradeCount', m1.tradeCount, 0],
    ]
    for (const [key, actual, tol] of pairs) {
      if (expected[key] === undefined) continue
      const want = Number(expected[key])
      if (!Number.isFinite(want) || !Number.isFinite(Number(actual)) || Math.abs(Number(actual) - want) > tol) {
        mismatches.push(key + ' 期望 ' + want + ' 实际 ' + actual)
      }
    }
    if (expected.fundingTotal0p1 !== undefined) {
      const funded = runRange({
        strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
        startMs: FULL_START_MS, endMs: NOW_MS, includeFunding: true, fundingRate: 0.0001, fundingRates: ctx.fundingRates,
      }).metrics
      if (Math.abs(funded.fundingTotal - Number(expected.fundingTotal0p1)) > 0.5) {
        mismatches.push('fundingTotal 期望 ' + expected.fundingTotal0p1 + ' 实际 ' + funded.fundingTotal)
      }
    }
  }
  return {
    ok: deterministic && mismatches.length === 0,
    deterministic,
    curveDiffs,
    maxCurveDiff,
    mismatches,
    metrics: m1,
    chainedYearly: computeChainedYearly(run1.result.equityCurve),
    continuousValidation: sliceContinuousMetrics(run1.result, VAL_START_MS),
    bars: run1.bars.length,
    actualStart: run1.actualStart,
    actualEnd: run1.actualEnd,
  }
}

// ============================================================================
// 检查 2：因果探针（截断后「过去」必须完全一致 → 无前视 / 无跨 run 泄漏）
// ============================================================================

function checkCausality(spec, ctx) {
  const full = runRange({
    strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
    startMs: FULL_START_MS, endMs: NOW_MS, includeFunding: false, fundingRates: ctx.fundingRates,
  })
  const totalBars = full.bars.length
  const barMs = barMsOf(spec.bar)
  const probes = []
  for (const ratio of [0.6, 0.85]) {
    const k = Math.floor(totalBars * ratio)
    if (k < 50 || k >= totalBars - 5) continue
    const truncated = runRange({
      strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
      startMs: FULL_START_MS, endMs: full.bars[k].t + barMs, includeFunding: false, fundingRates: ctx.fundingRates,
    })
    let diffPoints = 0
    let maxDiff = 0
    const compareCount = Math.min(k, truncated.result.equityCurve.length, full.result.equityCurve.length)
    for (let i = 0; i < compareCount; i += 1) {
      const a = full.result.equityCurve[i].equity
      const b = truncated.result.equityCurve[i].equity
      const diff = Math.abs(a - b)
      if (diff > 1e-7 * Math.max(1, Math.abs(a))) diffPoints += 1
      if (diff > maxDiff) maxDiff = diff
    }
    const cutoff = full.bars[k].t
    const fullFills = full.result.fills.filter((fill) => fill.t < cutoff)
    const truncFills = truncated.result.fills.filter((fill) => fill.t < cutoff)
    let fillsDiffer = fullFills.length !== truncFills.length
    if (!fillsDiffer) {
      for (let i = 0; i < fullFills.length; i += 1) {
        const a = fullFills[i]
        const b = truncFills[i]
        if (a.t !== b.t || a.side !== b.side || Math.abs(a.qty - b.qty) > 1e-9
          || Math.abs(a.price - b.price) > 1e-9 || a.reason !== b.reason) {
          fillsDiffer = true
          break
        }
      }
    }
    probes.push({
      ratio,
      cutoffIndex: k,
      cutoffText: formatTimeUtc8(cutoff),
      comparedPoints: compareCount,
      diffPoints,
      maxDiff,
      fullFillsBefore: fullFills.length,
      truncFillsBefore: truncFills.length,
      fillsDiffer,
      ok: diffPoints === 0 && !fillsDiffer,
    })
  }
  return { ok: probes.every((item) => item.ok), probes }
}

// ============================================================================
// 检查 3：funding 敏感性
// ============================================================================

function checkFunding(spec, ctx) {
  const rows = []
  for (const variant of FUNDING_VARIANTS) {
    const row = runToRow({
      strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
      startMs: FULL_START_MS, endMs: NOW_MS,
      includeFunding: variant.includeFunding, fundingRate: variant.fundingRate,
      fundingRates: ctx.fundingRates,
    })
    rows.push({ variant: variant.key, label: variant.label, ...row.metrics })
  }
  return rows
}

// ============================================================================
// 检查 4：分年度 + 子区间
// ============================================================================

function checkYearly(spec, ctx) {
  const rows = []
  for (let year = 2020; year <= 2026; year += 1) {
    const start = Date.parse(year + '-01-01T00:00:00+08:00')
    const end = year === 2026 ? NOW_MS : Date.parse((year + 1) + '-01-01T00:00:00+08:00')
    const row = runToRow({
      strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
      startMs: start, endMs: end, includeFunding: false, fundingRates: ctx.fundingRates,
    })
    if (row === null) continue
    rows.push({
      year,
      range: formatTimeUtc8(row.actualStart) + ' → ' + formatTimeUtc8(row.actualEnd),
      bars: row.bars,
      totalReturnPct: row.metrics.totalReturnPct,
      maxDrawdownPct: row.metrics.maxDrawdownPct,
      calmar: row.metrics.calmar,
      tradeCount: row.metrics.tradeCount,
      buyHoldReturnPct: row.metrics.buyHoldReturnPct,
    })
  }
  return rows
}

function checkSubperiods(spec, ctx) {
  const rows = []
  for (const period of SUBPERIODS) {
    const start = utc8Date(period.start)
    const end = period.end === null ? NOW_MS : utc8Date(period.end)
    const row = runToRow({
      strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
      startMs: start, endMs: end, includeFunding: false, fundingRates: ctx.fundingRates,
    })
    if (row === null) continue
    rows.push({
      key: period.key,
      label: period.label,
      range: formatTimeUtc8(row.actualStart) + ' → ' + formatTimeUtc8(row.actualEnd),
      totalReturnPct: row.metrics.totalReturnPct,
      annualizedReturnPct: row.metrics.annualizedReturnPct,
      maxDrawdownPct: row.metrics.maxDrawdownPct,
      sharpe: row.metrics.sharpe,
      tradeCount: row.metrics.tradeCount,
      buyHoldReturnPct: row.metrics.buyHoldReturnPct,
    })
  }
  return rows
}

// ============================================================================
// 检查 5：参数邻域敏感性（逐轴单独微调，其余参数保持最优）
// ============================================================================

function checkNeighborhood(spec, ctx, axes) {
  const base = runToRow({
    strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
    startMs: FULL_START_MS, endMs: NOW_MS, includeFunding: false, fundingRates: ctx.fundingRates,
  })
  const rows = []
  for (const [key, values] of Object.entries(axes)) {
    for (const value of values) {
      const params = Object.assign({}, spec.params, { [key]: value })
      const row = runToRow({
        strategy: ctx.strategy, params, bar: spec.bar, barsAll: ctx.bars,
        startMs: FULL_START_MS, endMs: NOW_MS, includeFunding: false, fundingRates: ctx.fundingRates,
      })
      if (row === null) continue
      const deltaTotal = row.metrics.totalReturnPct !== null && base.metrics.totalReturnPct !== null
        ? row.metrics.totalReturnPct - base.metrics.totalReturnPct
        : null
      const deltaDd = row.metrics.maxDrawdownPct !== null && base.metrics.maxDrawdownPct !== null
        ? row.metrics.maxDrawdownPct - base.metrics.maxDrawdownPct
        : null
      rows.push({
        axis: key,
        value,
        params,
        totalReturnPct: row.metrics.totalReturnPct,
        annualizedReturnPct: row.metrics.annualizedReturnPct,
        maxDrawdownPct: row.metrics.maxDrawdownPct,
        calmar: row.metrics.calmar,
        sharpe: row.metrics.sharpe,
        tradeCount: row.metrics.tradeCount,
        deltaTotalPct: deltaTotal,
        deltaDdPct: deltaDd,
      })
    }
  }
  const totals = rows.map((row) => row.totalReturnPct).filter((v) => Number.isFinite(v))
  const dds = rows.map((row) => row.maxDrawdownPct).filter((v) => Number.isFinite(v))
  const baseTotal = base.metrics.totalReturnPct
  const worstTotal = totals.length > 0 ? Math.min(...totals) : null
  const bestTotal = totals.length > 0 ? Math.max(...totals) : null
  const worstDd = dds.length > 0 ? Math.max(...dds) : null
  const ratio = baseTotal !== null && baseTotal > 0 && worstTotal !== null ? worstTotal / baseTotal : null
  const stable = (ratio === null ? null : ratio >= 0.5) && (worstDd === null || worstDd <= (base.metrics.maxDrawdownPct ?? 0) + 10)
  return {
    base: { params: spec.params, metrics: base.metrics },
    rows,
    summary: { baseTotalPct: baseTotal, worstTotalPct: worstTotal, bestTotalPct: bestTotal, worstDdPct: worstDd, worstToBaseRatio: ratio, stable },
  }
}

// ============================================================================
// 检查 6：walk-forward（训练段选参 → 验证段评估；验证段不参与选择）
// ============================================================================

/** 自动生成邻域基线网格：数字参数 ±radius、布尔参数 true/false。 */
function buildAutoAxes(params, radius) {
  const axes = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number' && Number.isInteger(value)) {
      const values = []
      for (let delta = -radius; delta <= radius; delta += 1) {
        const candidate = value + delta
        if (candidate >= 1) values.push(candidate)
      }
      axes[key] = Array.from(new Set(values))
    } else if (typeof value === 'boolean') {
      axes[key] = [true, false]
    }
  }
  return axes
}

/** 自动 walk-forward 组合：先试完整笛卡尔积，太多就逐级缩小，最后退成「逐个参数单独偏移」。 */
function buildAutoWalkCombos(params) {
  for (const radius of [2, 1]) {
    const axes = buildAutoAxes(params, radius)
    try {
      return { axes, combos: cartesianProduct(axes), mode: 'cartesian-r' + radius }
    } catch (error) { /* 组合太多，降一级 */ }
  }
  const axes = buildAutoAxes(params, 1)
  const combos = [{ ...params }]
  for (const [key, values] of Object.entries(axes)) {
    for (const value of values) combos.push({ ...params, [key]: value })
  }
  const seen = new Set()
  const unique = combos.filter((combo) => {
    const signature = JSON.stringify(combo)
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
  return { axes, combos: unique, mode: 'coordinate-wise' }
}

function rankRows(rows, key) {
  return rows.slice().sort((a, b) => {
    const av = Number(a.metrics[key])
    const bv = Number(b.metrics[key])
    const an = Number.isFinite(av) ? av : -Infinity
    const bn = Number.isFinite(bv) ? bv : -Infinity
    return bn - an
  })
}

function checkWalkForward(spec, ctx, grid, splits, topN) {
  let axes
  let combos
  let gridMode
  if (grid !== null && grid !== undefined) {
    axes = grid
    combos = cartesianProduct(axes)
    gridMode = 'explicit'
  } else {
    const auto = buildAutoWalkCombos(spec.params)
    axes = auto.axes
    combos = auto.combos
    gridMode = auto.mode
  }
  const splitResults = []
  for (const split of splits) {
    const trainEndMs = utc8Date(split.trainEnd)
    const trainRows = []
    for (const combo of combos) {
      const run = runRange({
        strategy: ctx.strategy, params: combo, bar: spec.bar, barsAll: ctx.bars,
        startMs: FULL_START_MS, endMs: trainEndMs, includeFunding: false, fundingRates: ctx.fundingRates,
      })
      if (run === null) continue
      trainRows.push({ params: combo, metrics: metricsRow(run.metrics) })
    }
    const rankedByAnnual = rankRows(trainRows, 'annualizedReturnPct')
    const fixed = runToRow({
      strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
      startMs: FULL_START_MS, endMs: trainEndMs, includeFunding: false, fundingRates: ctx.fundingRates,
    })
    // 交付参数的排名：网格可能只覆盖部分参数（其余参数固定为策略默认），
    // 所以只比对「spec.params 里显式给出 且 出现在网格轴上」的键，避免全参数比对永远匹配不上。
    const comparableKeys = Object.keys(axes).filter((key) =>
      Object.prototype.hasOwnProperty.call(spec.params, key))
    const fixedRank = rankedByAnnual.findIndex((row) =>
      comparableKeys.every((key) => row.params[key] === spec.params[key]))
    const testMetricsFor = (params) => {
      const row = runToRow({
        strategy: ctx.strategy, params, bar: spec.bar, barsAll: ctx.bars,
        startMs: trainEndMs, endMs: NOW_MS, includeFunding: false, fundingRates: ctx.fundingRates,
      })
      return row === null ? null : row.metrics
    }
    const top = rankedByAnnual.slice(0, Math.max(1, topN))
    const topRows = top.map((row) => ({ params: row.params, train: row.metrics, test: testMetricsFor(row.params) }))
    const bestByCalmarEntry = rankRows(trainRows, 'calmar')[0] ?? null
    const bestByCalmar = bestByCalmarEntry === null
      ? null
      : { params: bestByCalmarEntry.params, train: bestByCalmarEntry.metrics, test: testMetricsFor(bestByCalmarEntry.params) }
    // 网格不大时（<=200 组）把每组的验证段都跑一遍：
    // 看「训练段排名 ↔ 验证段表现」的整体关系，而不只是看前几名 —— 回答「选参流程本身是否可靠」。
    let gridTestDistribution = null
    if (trainRows.length <= 200 && trainRows.length > 0) {
      const rankOf = (params) => rankedByAnnual.findIndex((item) =>
        JSON.stringify(item.params) === JSON.stringify(params)) + 1
      const evaluated = []
      for (const row of trainRows) {
        evaluated.push({
          params: row.params,
          trainAnn: row.metrics.annualizedReturnPct,
          trainRank: rankOf(row.params),
          test: testMetricsFor(row.params),
        })
      }
      const totals = evaluated.map((row) => row.test?.totalReturnPct).filter((value) => Number.isFinite(value))
      const sortedTotals = totals.slice().sort((a, b) => a - b)
      const positive = totals.filter((value) => value > 0).length
      const median = sortedTotals.length === 0 ? null
        : sortedTotals.length % 2 === 1
          ? sortedTotals[(sortedTotals.length - 1) / 2]
          : (sortedTotals[sortedTotals.length / 2 - 1] + sortedTotals[sortedTotals.length / 2]) / 2
      const sortedByTrain = evaluated.slice().sort((a, b) => Number(b.trainAnn) - Number(a.trainAnn))
      const meanOf = (list) => (list.length > 0 ? list.reduce((a, b) => a + b, 0) / list.length : null)
      const pickTotal = (rows) => rows.map((row) => row.test?.totalReturnPct).filter((v) => Number.isFinite(v))
      gridTestDistribution = {
        evaluatedCount: evaluated.length,
        positiveCount: positive,
        positiveRatioPct: totals.length > 0 ? (positive / totals.length) * 100 : null,
        minTotalPct: sortedTotals.length > 0 ? sortedTotals[0] : null,
        medianTotalPct: median,
        maxTotalPct: sortedTotals.length > 0 ? sortedTotals[sortedTotals.length - 1] : null,
        meanOfTop5TrainTotalPct: meanOf(pickTotal(sortedByTrain.slice(0, 5))),
        meanOfBottom5TrainTotalPct: meanOf(pickTotal(sortedByTrain.slice(-5))),
        rows: evaluated,
      }
    }
    const testTotals = topRows.map((row) => row.test?.totalReturnPct).filter((v) => Number.isFinite(v))
    splitResults.push({
      split: split.key,
      splitLabel: split.label,
      trainEnd: split.trainEnd,
      trainBars: fixed?.bars ?? null,
      combos: combos.length,
      fixedParams: {
        params: spec.params,
        trainRank: fixedRank >= 0 ? fixedRank + 1 : null,
        train: fixed === null ? null : fixed.metrics,
        test: testMetricsFor(spec.params),
      },
      bestByAnnualized: topRows[0] ?? null,
      bestByCalmar,
      gridTestDistribution,
      topNTestSummary: {
        count: testTotals.length,
        meanTotalReturnPct: testTotals.length > 0 ? testTotals.reduce((a, b) => a + b, 0) / testTotals.length : null,
        minTotalReturnPct: testTotals.length > 0 ? Math.min(...testTotals) : null,
        maxTotalReturnPct: testTotals.length > 0 ? Math.max(...testTotals) : null,
      },
    })
  }
  return { axes, combos: combos.length, gridMode, splits: splitResults }
}

// ============================================================================
// 检查 7：同口径对比表
// ============================================================================

function buildCompare(allResults) {
  const rows = []
  for (const item of allResults) {
    const full = item.checks.repro?.metrics ?? null
    const funding = item.checks.funding ?? []
    const f0010 = funding.find((row) => row.variant === 'f0010') ?? null
    const val = item.checks.validation ?? null
    const cont = item.checks.repro?.continuousValidation ?? null
    rows.push({
      label: item.label,
      strategy: item.strategy,
      bar: item.bar,
      params: item.params,
      fullTotalPct: full?.totalReturnPct ?? null,
      fullAnnualPct: full?.annualizedReturnPct ?? null,
      fullDdPct: full?.maxDrawdownPct ?? null,
      fullCalmar: full?.calmar ?? null,
      fullSharpe: full?.sharpe ?? null,
      fullTrades: full?.tradeCount ?? null,
      exposurePct: full?.exposurePct ?? null,
      fundingTotal: f0010?.fundingTotal ?? null,
      fundingPctOfCapital: f0010?.fundingPctOfCapital ?? null,
      fundingTotalReturnPct: f0010?.totalReturnPct ?? null,
      valTotalPct: val?.totalReturnPct ?? null,
      valAnnualPct: val?.annualizedReturnPct ?? null,
      valDdPct: val?.maxDrawdownPct ?? null,
      valSharpe: val?.sharpe ?? null,
      valTrades: val?.tradeCount ?? null,
      valContTotalPct: cont?.totalReturnPct ?? null,
      valContAnnualPct: cont?.annualizedReturnPct ?? null,
      valContDdPct: cont?.maxDrawdownPct ?? null,
      valContCarried: cont?.carriedPositionAtStart ?? null,
      liquidations: full?.liquidations ?? null,
      reproOk: item.checks.repro?.ok ?? null,
      causalityOk: item.checks.causality?.ok ?? null,
    })
  }
  return rows
}

// ============================================================================
// 输出
// ============================================================================

function printTable(header, rows) {
  const widths = header.map((cell, index) => Math.max(
    String(cell).length,
    ...rows.map((row) => String(row[index] ?? '').length),
  ))
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ')
  console.log(line(header))
  console.log(widths.map((width) => '─'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
}

function pushTable(md, header, rows) {
  md.push('| ' + header.join(' | ') + ' |')
  md.push('|' + header.map(() => '---').join('|') + '|')
  for (const row of rows) md.push('| ' + row.map((cell) => String(cell ?? '—')).join(' | ') + ' |')
  md.push('')
}

// ============================================================================
// 主流程
// ============================================================================

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help === true) {
    console.log(USAGE)
    return 0
  }

  const mode = options.mode === undefined ? 'all' : options.mode
  const validModes = ['all', 'full', 'causality', 'funding', 'subperiod', 'nbr', 'walk', 'compare']
  if (!validModes.includes(mode)) throw new Error('--mode 只能是 ' + validModes.join(' / ') + '（收到：' + mode + '）')
  const walkTopN = Number.isFinite(options.walkTop) && options.walkTop > 0 ? Math.floor(options.walkTop) : 5

  // ---- 组装验证对象：内置 + --spec 追加，再挂 --nbr/--walk/--expect ----
  const specs = DEFAULT_SPECS.map((spec) => JSON.parse(JSON.stringify(spec)))
  for (const text of options.specs) {
    const parsed = parseInlineSpec(text)
    specs.push({ label: parsed.label, note: '--spec 追加对象', strategy: parsed.strategy, bar: parsed.bar, params: parsed.params, expect: null, nbr: null, walkGrid: null })
  }
  for (const text of options.nbrs) {
    const parsed = parseAxisSpec(text, '--nbr')
    const spec = specs.find((item) => item.label === parsed.label)
    if (spec === undefined) throw new Error('--nbr 指定的 label 不存在：' + parsed.label)
    spec.nbr = parsed.axes
  }
  for (const text of options.walks) {
    const parsed = parseAxisSpec(text, '--walk')
    const spec = specs.find((item) => item.label === parsed.label)
    if (spec === undefined) throw new Error('--walk 指定的 label 不存在：' + parsed.label)
    spec.walkGrid = parsed.axes
  }
  for (const text of options.expects) {
    const pieces = String(text).split(':')
    if (pieces.length < 5) throw new Error('--expect 需要 label:总收益:年化:回撤:交易数（收到：' + text + '）')
    const spec = specs.find((item) => item.label === pieces[0])
    if (spec === undefined) throw new Error('--expect 指定的 label 不存在：' + pieces[0])
    spec.expect = { totalReturnPct: Number(pieces[1]), annualizedReturnPct: Number(pieces[2]), maxDrawdownPct: Number(pieces[3]), tradeCount: Number(pieces[4]) }
  }

  let selected = specs
  if (Array.isArray(options.only) && options.only.length > 0) {
    selected = specs.filter((spec) => options.only.includes(spec.label))
    if (selected.length === 0) throw new Error('--only 没有匹配到任何 label（可用：' + specs.map((s) => s.label).join(' / ') + '）')
  }

  const outDir = resolve(options.out === undefined ? 'backtest/reports/_scratch/verify/last' : options.out)
  mkdirSync(outDir, { recursive: true })

  console.log('════════ verify-dual 独立验证 ════════')
  console.log('now 快照：' + formatTimeUtc8(NOW_MS) + '    全样本：2020-01-01 → now    验证段：2024-10-03 → now')
  console.log('口径：1x、maker 0.0200% / taker 0.0500%、初始 10000 USDT、--offline 本地缓存、资金费率历史仅近 3 个月')
  console.log('')

  const fundingCache = await loadFundingCache()
  const fundingRates = fundingCache.rates
  console.log('funding 缓存：' + fundingRates.length + ' 次历史结算'
    + (fundingCache.coverage === null ? '' : '（覆盖 ' + formatTimeUtc8(fundingCache.coverage.from) + ' → '
      + formatTimeUtc8(fundingCache.coverage.to) + '）')
    + (fundingCache.ok ? '' : '，其余区间按估算费率补齐'))
  console.log('')

  const allResults = []
  for (const spec of selected) {
    const barEntry = await loadBarSet(spec.bar)
    const strategy = await loadStrategy(spec.strategy)
    if (Object.keys(spec.params).length === 0) {
      spec.params = JSON.parse(JSON.stringify(strategy.params))
      spec.paramsSource = 'strategy-defaults'
    }
    const ctx = { bars: barEntry.bars, fundingRates, strategy }
    const item = {
      label: spec.label,
      note: spec.note ?? null,
      strategy: spec.strategy,
      bar: spec.bar,
      params: spec.params,
      paramsSource: spec.paramsSource ?? 'explicit',
      expected: spec.expect ?? null,
      checks: {},
    }
    console.log('──── ' + spec.label + '（' + spec.strategy + ' / ' + spec.bar + ' / ' + paramsText(spec.params) + '）────')
    console.log('数据：' + ctx.bars.length + ' 根 ' + spec.bar + '，'
      + formatTimeUtc8(ctx.bars[0].t) + ' → ' + formatTimeUtc8(ctx.bars[ctx.bars.length - 1].t)
      + (barEntry.fromCache ? '（缓存命中，未联网）' : ''))

    // 复现（所有模式都跑，作为后续所有结论的前提）
    const repro = checkRepro(spec, ctx, spec.expect)
    item.checks.repro = repro
    console.log('')
    console.log('【1】复现 2020-01-01→now（不含 funding）：总收益 ' + fmtSignedPct(repro.metrics.totalReturnPct)
      + ' / 年化 ' + fmtPct(repro.metrics.annualizedReturnPct)
      + ' / 回撤 ' + fmtPct(repro.metrics.maxDrawdownPct)
      + ' / 夏普 ' + fmtNum(repro.metrics.sharpe)
      + ' / Calmar ' + fmtNum(repro.metrics.calmar)
      + ' / 交易 ' + repro.metrics.tradeCount + ' 笔 / 持仓占比 ' + fmtPct(repro.metrics.exposurePct))
    console.log('     二次复跑逐点一致：' + (repro.deterministic ? '是' : '否（差异点 ' + repro.curveDiffs + '）')
      + '    与期望值对账：' + (repro.ok ? '通过' : '不一致 → ' + repro.mismatches.join('；')))
    if (!repro.ok) console.log('❌ 复现失败/有偏差：这是大问题，后续结论不可直接采信')

    if (mode === 'all' || mode === 'causality') {
      const causality = checkCausality(spec, ctx)
      item.checks.causality = causality
      console.log('')
      console.log('【2】因果探针（截断 60%/85% 重跑，截断前必须完全一致）：' + (causality.ok ? '通过' : '❌ 未通过'))
      for (const probe of causality.probes) {
        console.log('     截断@' + String(Math.round(probe.ratio * 100)) + '%（' + probe.cutoffText + '）：比较 '
          + probe.comparedPoints + ' 点，权益差异点 ' + probe.diffPoints + '，成交差异 ' + (probe.fillsDiffer ? '有' : '无')
          + ' → ' + (probe.ok ? '一致' : '❌ 不一致'))
      }
    }

    if (mode === 'all' || mode === 'funding') {
      const funding = checkFunding(spec, ctx)
      item.checks.funding = funding
      console.log('')
      console.log('【3】funding 敏感性（全样本；OKX 历史仅近 3 个月，其余估算）')
      printTable(
        ['口径', '总收益', '年化', '回撤', 'Calmar', '交易', 'funding 净支出', '占初始资金'],
        funding.map((row) => [
          row.label, fmtSignedPct(row.totalReturnPct), fmtPct(row.annualizedReturnPct),
          fmtPct(row.maxDrawdownPct), fmtNum(row.calmar), String(row.tradeCount),
          fmtMoney(row.fundingTotal), fmtPct(row.fundingPctOfCapital),
        ]),
      )
    }

    if (mode === 'all' || mode === 'subperiod') {
      const yearly = checkYearly(spec, ctx)
      item.checks.yearly = yearly
      console.log('')
      console.log('【4】分年度（① 每年独立回测：年初重新起跑、年末强平；不含 funding）')
      printTable(
        ['年份', '①独立总收益', '年内回撤', 'Calmar', '交易', 'Buy&Hold'],
        yearly.map((row) => [
          String(row.year), fmtSignedPct(row.totalReturnPct), fmtPct(row.maxDrawdownPct),
          fmtNum(row.calmar), String(row.tradeCount), fmtSignedPct(row.buyHoldReturnPct),
        ]),
      )
      if (Array.isArray(repro.chainedYearly)) {
        console.log('     ②连续口径（同一笔全样本回测按自然年切片，跨年持仓不强制平仓）')
        printTable(
          ['年份', '②连续口径收益', '年内回撤'],
          repro.chainedYearly.map((row) => [String(row.year), fmtSignedPct(row.returnPct), fmtPct(row.maxDrawdownPct)]),
        )
      }
      const subperiods = checkSubperiods(spec, ctx)
      item.checks.subperiods = subperiods
      console.log('')
      console.log('【5】子区间稳健性（不含 funding）')
      printTable(
        ['区间', '总收益', '年化', '回撤', '夏普', '交易', 'Buy&Hold'],
        subperiods.map((row) => [
          row.label, fmtSignedPct(row.totalReturnPct), fmtPct(row.annualizedReturnPct),
          fmtPct(row.maxDrawdownPct), fmtNum(row.sharpe), String(row.tradeCount), fmtSignedPct(row.buyHoldReturnPct),
        ]),
      )
    }

    if (mode === 'all' || mode === 'nbr') {
      const axes = spec.nbr ?? buildAutoAxes(spec.params, 2)
      const nbr = checkNeighborhood(spec, ctx, axes)
      item.checks.neighborhood = nbr
      console.log('')
      console.log('【6】参数邻域敏感性（逐轴微调，其余不变；不含 funding）')
      printTable(
        ['轴', '取值', '总收益', '年化', '回撤', 'Calmar', '交易', 'Δ总收益', 'Δ回撤'],
        nbr.rows.map((row) => [
          row.axis, String(row.value), fmtSignedPct(row.totalReturnPct), fmtPct(row.annualizedReturnPct),
          fmtPct(row.maxDrawdownPct), fmtNum(row.calmar), String(row.tradeCount),
          fmtSignedPct(row.deltaTotalPct), fmtSignedPct(row.deltaDdPct),
        ]),
      )
      console.log('     邻域判定：基准总收益 ' + fmtSignedPct(nbr.summary.baseTotalPct)
        + '，最差邻域 ' + fmtSignedPct(nbr.summary.worstTotalPct)
        + '（相对基准 ' + (nbr.summary.worstToBaseRatio === null ? '—' : fmtPct(nbr.summary.worstToBaseRatio * 100))
        + '），最差邻域回撤 ' + fmtPct(nbr.summary.worstDdPct)
        + ' → ' + (nbr.summary.stable === true ? '稳定（平台）' : nbr.summary.stable === false ? '⚠️ 不稳定（尖峰）' : '无法判定'))
    }

    if (mode === 'all' || mode === 'walk') {
      const splits = Array.isArray(options.splits) && options.splits.length > 0
        ? options.splits.map((date) => ({ key: 'train-' + date, label: '训练 2020-01→' + date, trainEnd: date }))
        : WALK_SPLITS
      const walk = checkWalkForward(spec, ctx, spec.walkGrid, splits, walkTopN)
      item.checks.walk = walk
      console.log('')
      console.log('【7】walk-forward（训练段选参 → 验证段评估；网格 ' + walk.combos + ' 组 [' + walk.gridMode + ']；不含 funding）')
      for (const split of walk.splits) {
        const best = split.bestByAnnualized
        const bestCalmar = split.bestByCalmar
        const fixed = split.fixedParams
        console.log('   ' + split.splitLabel + '：')
        if (best !== null) {
          console.log('     训练段最优（按年化）：' + paramsText(best.params)
            + ' → 训练 年化 ' + fmtPct(best.train.annualizedReturnPct) + ' / 回撤 ' + fmtPct(best.train.maxDrawdownPct)
            + '；验证段 总收益 ' + fmtSignedPct(best.test?.totalReturnPct) + ' / 年化 ' + fmtPct(best.test?.annualizedReturnPct)
            + ' / 回撤 ' + fmtPct(best.test?.maxDrawdownPct) + ' / 交易 ' + (best.test?.tradeCount ?? '—'))
        }
        if (bestCalmar !== null) {
          console.log('     训练段最优（按 Calmar）：' + paramsText(bestCalmar.params)
            + ' → 验证段 总收益 ' + fmtSignedPct(bestCalmar.test?.totalReturnPct)
            + ' / 年化 ' + fmtPct(bestCalmar.test?.annualizedReturnPct)
            + ' / 回撤 ' + fmtPct(bestCalmar.test?.maxDrawdownPct))
        }
        console.log('     交付参数在训练段的年化排名：第 ' + (fixed.trainRank ?? '—') + ' / ' + split.combos
          + '；交付参数验证段：总收益 ' + fmtSignedPct(fixed.test?.totalReturnPct)
          + ' / 年化 ' + fmtPct(fixed.test?.annualizedReturnPct)
          + ' / 回撤 ' + fmtPct(fixed.test?.maxDrawdownPct)
          + ' / 夏普 ' + fmtNum(fixed.test?.sharpe)
          + ' / 交易 ' + (fixed.test?.tradeCount ?? '—'))
        if (split.gridTestDistribution !== null) {
          const dist = split.gridTestDistribution
          console.log('     网格全量验证段分布（' + dist.evaluatedCount + ' 组）：正收益 ' + dist.positiveCount + '/' + dist.evaluatedCount
            + '（' + fmtPct(dist.positiveRatioPct) + '），总收益 min ' + fmtSignedPct(dist.minTotalPct)
            + ' / 中位 ' + fmtSignedPct(dist.medianTotalPct) + ' / max ' + fmtSignedPct(dist.maxTotalPct)
            + '；训练段前5名验证段均值 ' + fmtSignedPct(dist.meanOfTop5TrainTotalPct)
            + ' VS 后5名均值 ' + fmtSignedPct(dist.meanOfBottom5TrainTotalPct))
        }
        console.log('     训练段前 ' + split.topNTestSummary.count + ' 名的验证段总收益：均值 '
          + fmtSignedPct(split.topNTestSummary.meanTotalReturnPct)
          + '，区间 [' + fmtSignedPct(split.topNTestSummary.minTotalReturnPct)
          + ', ' + fmtSignedPct(split.topNTestSummary.maxTotalReturnPct) + ']')
      }
    }

    // 验证段（两种口径）—— 所有模式都跑，核心判定项
    const val = runToRow({
      strategy: ctx.strategy, params: spec.params, bar: spec.bar, barsAll: ctx.bars,
      startMs: VAL_START_MS, endMs: NOW_MS, includeFunding: false, fundingRates: ctx.fundingRates,
    })
    item.checks.validation = val === null ? null : val.metrics
    item.checks.validationRange = val === null ? null : { start: formatTimeUtc8(val.actualStart), end: formatTimeUtc8(val.actualEnd), bars: val.bars }
    const cont = repro.continuousValidation
    console.log('')
    console.log('【8】验证段 2024-10-03→now（不含 funding），两种口径：')
    console.log('   ① 独立启动（段起点空仓重跑）：总收益 ' + fmtSignedPct(item.checks.validation?.totalReturnPct)
      + ' / 年化 ' + fmtPct(item.checks.validation?.annualizedReturnPct)
      + ' / 回撤 ' + fmtPct(item.checks.validation?.maxDrawdownPct)
      + ' / 夏普 ' + fmtNum(item.checks.validation?.sharpe)
      + ' / 交易 ' + (item.checks.validation?.tradeCount ?? '—'))
    if (cont !== null) {
      console.log('   ② 连续运行切片（保留跨段持仓，段前持仓 = ' + cont.carriedPositionAtStart + '）：总收益 '
        + fmtSignedPct(cont.totalReturnPct) + ' / 年化 ' + fmtPct(cont.annualizedReturnPct)
        + ' / 回撤 ' + fmtPct(cont.maxDrawdownPct) + ' / 夏普 ' + fmtNum(cont.sharpe) + ' / 交易 ' + cont.tradeCount)
      console.log('      （对照：以段前一根收盘为起点 = ' + fmtSignedPct(cont.totalReturnIncludingFirstBarPct)
        + '；两口径差一个 bar 的盈亏）')
    }
    console.log('')
    allResults.push(item)
  }

  // ---- 对比表 ----
  const compare = buildCompare(allResults)
  console.log('════════ 同口径对比表（1x / 默认费率 / now 快照；funding = 估算 0.01%/8h）════════')
  console.log('验证段① = 2024-10-03 独立启动；验证段② = 从 2020 连续运行、切片保留跨段持仓')
  printTable(
    ['对象', '周期', '全样本总收益', '年化', '回撤', 'Calmar', '夏普', '交易', '持仓', 'funding净支出', '含funding总收益', '验证①收益', '验证①年化', '验证①回撤', '验证②收益', '验证②回撤', '复现', '因果'],
    compare.map((row) => [
      row.label, row.bar,
      fmtSignedPct(row.fullTotalPct), fmtPct(row.fullAnnualPct), fmtPct(row.fullDdPct),
      fmtNum(row.fullCalmar), fmtNum(row.fullSharpe), String(row.fullTrades ?? '—'),
      fmtPct(row.exposurePct), fmtMoney(row.fundingTotal), fmtSignedPct(row.fundingTotalReturnPct),
      fmtSignedPct(row.valTotalPct), fmtPct(row.valAnnualPct), fmtPct(row.valDdPct),
      fmtSignedPct(row.valContTotalPct), fmtPct(row.valContDdPct),
      row.reproOk === true ? 'OK' : row.reproOk === false ? '❌' : '—',
      row.causalityOk === true ? 'OK' : row.causalityOk === false ? '❌' : '—',
    ]),
  )
  console.log('')

  // ---- 写 results.json ----
  const results = {
    generatedAt: new Date(NOW_MS).toISOString(),
    tool: 'backtest/tools/verify-dual.mjs',
    config: {
      instId: INST_ID, leverage: LEVERAGE, initialCapital: INITIAL_CAPITAL,
      makerFeeRate: DEFAULT_MAKER_FEE_RATE, takerFeeRate: DEFAULT_TAKER_FEE_RATE,
      now: NOW_MS, nowText: formatTimeUtc8(NOW_MS), fullStart: FULL_START_MS,
      validationStart: VAL_START_MS, offline: true,
    },
    fundingCache: { count: fundingRates.length, coverage: fundingCache.coverage, ok: fundingCache.ok, error: fundingCache.error },
    specs: allResults,
    compare,
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1), 'utf8')

  // ---- 写 report.md ----
  const md = []
  md.push('# verify-dual 独立验证结果（自动生成）')
  md.push('')
  md.push('- 生成工具：`backtest/tools/verify-dual.mjs`')
  md.push('- now 快照：' + formatTimeUtc8(NOW_MS) + '；全样本 2020-01-01 → now；验证段 2024-10-03 → now')
  md.push('- 口径：1x、maker 0.0200% / taker 0.0500%、初始 10000 USDT、--offline 本地缓存；funding 历史仅近 3 个月、其余按估算费率')
  md.push('')
  md.push('## 同口径对比表')
  md.push('')
  md.push('验证段① = 2024-10-03 独立启动（段起点空仓）；验证段② = 从 2020 连续运行、切片保留跨段持仓。')
  md.push('')
  pushTable(md,
    ['对象', '周期', '全样本总收益', '年化', '回撤', 'Calmar', '夏普', '交易', '持仓占比', 'funding净支出', '含funding总收益', '验证①收益', '验证①年化', '验证①回撤', '验证②收益', '验证②回撤', '复现', '因果'],
    compare.map((row) => [
      row.label, row.bar,
      fmtSignedPct(row.fullTotalPct), fmtPct(row.fullAnnualPct), fmtPct(row.fullDdPct),
      fmtNum(row.fullCalmar), fmtNum(row.fullSharpe), String(row.fullTrades ?? '—'),
      fmtPct(row.exposurePct), fmtMoney(row.fundingTotal), fmtSignedPct(row.fundingTotalReturnPct),
      fmtSignedPct(row.valTotalPct), fmtPct(row.valAnnualPct), fmtPct(row.valDdPct),
      fmtSignedPct(row.valContTotalPct), fmtPct(row.valContDdPct),
      row.reproOk === true ? 'OK' : row.reproOk === false ? '❌' : '—',
      row.causalityOk === true ? 'OK' : row.causalityOk === false ? '❌' : '—',
    ]))
  for (const item of allResults) {
    md.push('## ' + item.label)
    md.push('')
    md.push('- 策略：`' + item.strategy + '`；周期：' + item.bar + '；参数：' + paramsText(item.params))
    if (item.note !== null) md.push('- 说明：' + item.note)
    md.push('')
    const repro = item.checks.repro
    md.push('### 复现（2020-01-01→now，不含 funding）')
    md.push('')
    md.push('- 总收益 ' + fmtSignedPct(repro.metrics.totalReturnPct)
      + ' / 年化 ' + fmtPct(repro.metrics.annualizedReturnPct)
      + ' / 回撤 ' + fmtPct(repro.metrics.maxDrawdownPct)
      + ' / 夏普 ' + fmtNum(repro.metrics.sharpe)
      + ' / Calmar ' + fmtNum(repro.metrics.calmar)
      + ' / 交易 ' + repro.metrics.tradeCount + ' 笔 / 持仓占比 ' + fmtPct(repro.metrics.exposurePct))
    md.push('- 二次复跑逐点一致：' + (repro.deterministic ? '是' : '**否**（差异点 ' + repro.curveDiffs + '）')
      + '；与期望值对账：' + (repro.ok ? '通过' : '**不一致**：' + repro.mismatches.join('；')))
    md.push('')
    const causality = item.checks.causality
    if (causality !== undefined) {
      md.push('### 因果探针（前视偏差客观检查）')
      md.push('')
      for (const probe of causality.probes) {
        md.push('- 截断@' + String(Math.round(probe.ratio * 100)) + '%（' + probe.cutoffText + '）：比较 '
          + probe.comparedPoints + ' 点，权益差异 ' + probe.diffPoints + '，成交差异 ' + (probe.fillsDiffer ? '有' : '无')
          + ' → ' + (probe.ok ? '一致' : '**不一致**'))
      }
      md.push('')
    }
    const funding = item.checks.funding
    if (funding !== undefined) {
      md.push('### funding 敏感性（全样本）')
      md.push('')
      pushTable(md,
        ['口径', '总收益', '年化', '回撤', 'Calmar', '交易', 'funding 净支出', '占初始资金'],
        funding.map((row) => [
          row.label, fmtSignedPct(row.totalReturnPct), fmtPct(row.annualizedReturnPct),
          fmtPct(row.maxDrawdownPct), fmtNum(row.calmar), String(row.tradeCount),
          fmtMoney(row.fundingTotal), fmtPct(row.fundingPctOfCapital),
        ]))
    }
    const yearly = item.checks.yearly
    if (yearly !== undefined) {
      md.push('### 分年度（① 每年独立回测：年初重新起跑、年末强平；不含 funding）')
      md.push('')
      pushTable(md,
        ['年份', '①独立总收益', '年内回撤', 'Calmar', '交易', 'Buy&Hold'],
        yearly.map((row) => [
          String(row.year), fmtSignedPct(row.totalReturnPct), fmtPct(row.maxDrawdownPct),
          fmtNum(row.calmar), String(row.tradeCount), fmtSignedPct(row.buyHoldReturnPct),
        ]))
      if (Array.isArray(repro.chainedYearly)) {
        md.push('②连续口径（同一笔全样本回测按自然年切片，跨年持仓不强制平仓）：')
        md.push('')
        pushTable(md,
          ['年份', '②连续口径收益', '年内回撤'],
          repro.chainedYearly.map((row) => [String(row.year), fmtSignedPct(row.returnPct), fmtPct(row.maxDrawdownPct)]))
      }
    }
    const subperiods = item.checks.subperiods
    if (subperiods !== undefined) {
      md.push('### 子区间（不含 funding）')
      md.push('')
      pushTable(md,
        ['区间', '总收益', '年化', '回撤', '夏普', '交易', 'Buy&Hold'],
        subperiods.map((row) => [
          row.label, fmtSignedPct(row.totalReturnPct), fmtPct(row.annualizedReturnPct),
          fmtPct(row.maxDrawdownPct), fmtNum(row.sharpe), String(row.tradeCount), fmtSignedPct(row.buyHoldReturnPct),
        ]))
    }
    const nbr = item.checks.neighborhood
    if (nbr !== undefined) {
      md.push('### 参数邻域敏感性')
      md.push('')
      pushTable(md,
        ['轴', '取值', '总收益', '年化', '回撤', 'Calmar', '交易', 'Δ总收益'],
        nbr.rows.map((row) => [
          row.axis, String(row.value), fmtSignedPct(row.totalReturnPct), fmtPct(row.annualizedReturnPct),
          fmtPct(row.maxDrawdownPct), fmtNum(row.calmar), String(row.tradeCount), fmtSignedPct(row.deltaTotalPct),
        ]))
      md.push('邻域判定：' + (nbr.summary.stable === true ? '稳定（平台）' : nbr.summary.stable === false ? '**不稳定（尖峰）**' : '无法判定'))
      md.push('')
    }
    const walk = item.checks.walk
    if (walk !== undefined) {
      md.push('### walk-forward（训练段选参 → 验证段评估）')
      md.push('')
      for (const split of walk.splits) {
        md.push('**' + split.splitLabel + '**（训练网格 ' + split.combos + ' 组 [' + walk.gridMode + ']）')
        md.push('')
        if (split.bestByAnnualized !== null) {
          md.push('- 训练段最优（按年化）：' + paramsText(split.bestByAnnualized.params)
            + ' → 训练 年化 ' + fmtPct(split.bestByAnnualized.train.annualizedReturnPct)
            + '；**验证段 总收益 ' + fmtSignedPct(split.bestByAnnualized.test?.totalReturnPct)
            + ' / 年化 ' + fmtPct(split.bestByAnnualized.test?.annualizedReturnPct)
            + ' / 回撤 ' + fmtPct(split.bestByAnnualized.test?.maxDrawdownPct) + '**')
        }
        if (split.bestByCalmar !== null) {
          md.push('- 训练段最优（按 Calmar）：' + paramsText(split.bestByCalmar.params)
            + ' → 验证段 总收益 ' + fmtSignedPct(split.bestByCalmar.test?.totalReturnPct)
            + ' / 年化 ' + fmtPct(split.bestByCalmar.test?.annualizedReturnPct))
        }
        md.push('- 交付参数训练段年化排名：第 ' + (split.fixedParams.trainRank ?? '—') + ' / ' + split.combos
          + '；**交付参数验证段：总收益 ' + fmtSignedPct(split.fixedParams.test?.totalReturnPct)
          + ' / 年化 ' + fmtPct(split.fixedParams.test?.annualizedReturnPct)
          + ' / 回撤 ' + fmtPct(split.fixedParams.test?.maxDrawdownPct)
          + ' / 夏普 ' + fmtNum(split.fixedParams.test?.sharpe) + '**')
        if (split.gridTestDistribution !== null) {
          const dist = split.gridTestDistribution
          md.push('- 网格全量验证段分布（' + dist.evaluatedCount + ' 组）：正收益 ' + dist.positiveCount + '/' + dist.evaluatedCount
            + '（' + fmtPct(dist.positiveRatioPct) + '），总收益 min ' + fmtSignedPct(dist.minTotalPct)
            + ' / 中位 ' + fmtSignedPct(dist.medianTotalPct) + ' / max ' + fmtSignedPct(dist.maxTotalPct)
            + '；训练段前 5 名验证段均值 ' + fmtSignedPct(dist.meanOfTop5TrainTotalPct)
            + ' VS 后 5 名均值 ' + fmtSignedPct(dist.meanOfBottom5TrainTotalPct))
        }
        md.push('- 训练段前 ' + split.topNTestSummary.count + ' 名验证段总收益：均值 '
          + fmtSignedPct(split.topNTestSummary.meanTotalReturnPct) + '，区间 ['
          + fmtSignedPct(split.topNTestSummary.minTotalReturnPct) + ', '
          + fmtSignedPct(split.topNTestSummary.maxTotalReturnPct) + ']')
        md.push('')
      }
    }
    const val = item.checks.validation
    if (val !== null && val !== undefined) {
      md.push('### 验证段 2024-10-03→now（不含 funding），两种口径')
      md.push('')
      md.push('- ① 独立启动（段起点空仓重跑）：总收益 ' + fmtSignedPct(val.totalReturnPct)
        + ' / 年化 ' + fmtPct(val.annualizedReturnPct) + ' / 回撤 ' + fmtPct(val.maxDrawdownPct)
        + ' / 夏普 ' + fmtNum(val.sharpe) + ' / Calmar ' + fmtNum(val.calmar) + ' / 交易 ' + val.tradeCount + ' 笔')
      if (repro.continuousValidation !== null) {
        md.push('- ② 连续运行切片（保留跨段持仓，段前持仓 = ' + repro.continuousValidation.carriedPositionAtStart + '）：总收益 '
          + fmtSignedPct(repro.continuousValidation.totalReturnPct) + ' / 年化 ' + fmtPct(repro.continuousValidation.annualizedReturnPct)
          + ' / 回撤 ' + fmtPct(repro.continuousValidation.maxDrawdownPct) + ' / 夏普 ' + fmtNum(repro.continuousValidation.sharpe)
          + ' / 交易（段内平仓）' + repro.continuousValidation.tradeCount + ' 笔')
        md.push('- ②对照：以段前一根收盘为起点 = ' + fmtSignedPct(repro.continuousValidation.totalReturnIncludingFirstBarPct)
          + '（与②差一个 bar 的盈亏，报告以②为准）')
      }
      md.push('')
    }
  }
  writeFileSync(join(outDir, 'report.md'), md.join('\n'), 'utf8')

  console.log('结果文件：')
  console.log('  JSON  ' + join(outDir, 'results.json'))
  console.log('  MD    ' + join(outDir, 'report.md'))
  if (options.json === true) {
    console.log(JSON.stringify({ ok: true, mode, outDir, labels: allResults.map((item) => item.label), reproAllOk: allResults.every((item) => item.checks.repro.ok) }))
  }
  return 0
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error('错误：' + String((error && error.message) || error))
    process.exitCode = 1
  })
