/**
 * 绩效指标计算（SPEC §7）。
 *
 * 设计原则：
 *   1. **纯函数**：只吃 BacktestResult（SPEC §4.1），不读文件、不联网、不看进程环境，
 *      同样的 result 永远算得出同样的 metrics（报告可复现）。
 *   2. **绝不返回 NaN / Infinity**：算不出来的指标一律给 `null`（JSON 会把它变 null，
 *      HTML 会把它变 "NaN" 字符串，报告里出现 NaN 比缺一个指标更像 bug）。最后统一
 *      sanitize 一遍兜底。
 *   3. 百分比字段是**百分数**（12.34 表示 12.34%），时间字段是 UTC 毫秒。
 *   4. 分母为 0 / 样本不足 / 无定义时给 null，而不是 0 —— 0 会被误读成“策略跑出来就是 0”。
 *
 * 契约没写死、这里做了实现级决定的口径（均已同步给 Lead）：
 *   - 波动率与 Sharpe 的 std 用**总体标准差**（除以 n）。SPEC 只写了 `std(r)`，而 Sortino
 *     明确写的是 `mean(min(r,0)^2)`（也除以 n）；同一份报告里不该混用两套标准差。
 *   - 每根 K 线收益率 `r_i = equity_i / equity_{i-1} - 1`；上一期权益 ≤ 0 时跳过该点 ——
 *     权益为 0 会得到 Infinity，为负会让“收益率”失去经济意义；跳过导致样本不足时指标给 null。
 *   - `days` = 首根开盘到末根收盘的覆盖时长 = `(lastT - firstT + barMs) / 1 天`。
 *     这样连续 720 根 1h 正好是 30 天，与用户说的“回测最近 30 天”一致。
 *   - 年化收益用 365 天复利；**不足 1 天不给年化**（几十根 K 线外推一年会夸张到没有参考价值）。
 *     期末权益 ≤ 0 时（1 倍空头被爆/亏超 100%）年化收益率没有实数定义，给 null。
 *   - `expectancy` 按教科书定义 `胜率×avgWin − 败率×|avgLoss|`。注意它在数学上恒等于
 *     `avgTradePnl`（分母都取 tradeCount），SPEC 同时列两个字段属于冗余；两个都保留，
 *     报告层只展示一个，避免读者以为算错了。
 *   - `avgLoss` 存**负值**（亏损交易 pnl 的均值），`payoffRatio` 用 `avgWin / |avgLoss|`。
 *   - `profitFactor` / `payoffRatio` 无亏损交易时给 null（照 SPEC），报告层决定显示 `∞`。
 *   - Buy&Hold 基准是**现货、无杠杆、无手续费**：首根收盘价买入、按每根收盘价估值、
 *     末根收盘价定终值；它的最大回撤基于这条合成权益曲线。
 *   - `liquidations` 是**次数**（number）；爆仓明细仍在 result.liquidations 里，报告需要时自己取。
 */

import { barById } from './config.mjs'

const DAY_MS = 86_400_000
/** 一年毫秒数：24/7 的加密市场按 365 天折算（SPEC §7 的 ppY 分子）。 */
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

/** 只认有限 number（undefined / null / 字符串 / NaN / ±Infinity 一律当缺失）。 */
function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function numberOrNull(value) {
  return isNum(value) ? value : null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** 算术平均；空数组返回 null（不是 0 —— “没有样本”和“样本均值为 0”是两回事）。 */
function mean(values) {
  if (values.length === 0) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

/** 总体标准差（除以 n）。样本为空返回 null；单样本标准差为 0，调用方按“样本不足”处理。 */
function populationStd(values) {
  const average = mean(values)
  if (average === null) return null
  let sumSquares = 0
  for (const value of values) {
    const diff = value - average
    sumSquares += diff * diff
  }
  return Math.sqrt(sumSquares / values.length)
}

/**
 * 从 `config.bar` 取一根 K 线的毫秒数；周期 id 非法时退化为资金曲线相邻点间隔的中位数
 * （中位数而不是均值，是为了容忍数据缺口把间隔拉大）。
 */
function resolveBarMs(config, curve) {
  const barId = config.bar
  if (typeof barId === 'string' && barId !== '') {
    try {
      return barById(barId).ms
    } catch (error) {
      // 未知周期不该让报告崩掉：继续按曲线间隔推断（引擎产出的 bar 本来也是合法的）
    }
  }
  const diffs = []
  for (let index = 1; index < curve.length; index += 1) {
    const prev = numberOrNull(curve[index - 1]?.t)
    const current = numberOrNull(curve[index]?.t)
    if (prev !== null && current !== null && current > prev) diffs.push(current - prev)
  }
  if (diffs.length === 0) return null
  diffs.sort((left, right) => left - right)
  return diffs[Math.floor(diffs.length / 2)]
}

/** 首根到末根的覆盖时长（天）；见文件头“days 口径”。 */
function resolveDays(bars, barMs, firstT, lastT) {
  if (barMs !== null && barMs > 0 && firstT !== null && lastT !== null && lastT >= firstT) {
    return (lastT - firstT + barMs) / DAY_MS
  }
  if (barMs !== null && barMs > 0 && bars !== null && bars > 0) {
    return (bars * barMs) / DAY_MS
  }
  // 连周期都推不出来时，至少给一个只有间隔的近似值（少算一根，不影响“<1 天”判断的大方向）
  if (firstT !== null && lastT !== null && lastT > firstT) return (lastT - firstT) / DAY_MS
  return null
}

/** 每根 K 线的简单收益率；上一期权益 ≤ 0 或数据缺失的点跳过（理由见文件头）。 */
function buildReturns(curve) {
  const returns = []
  for (let index = 1; index < curve.length; index += 1) {
    const previous = numberOrNull(curve[index - 1]?.equity)
    const current = numberOrNull(curve[index]?.equity)
    if (previous === null || current === null) continue
    if (previous <= 0) continue
    returns.push(current / previous - 1)
  }
  return returns
}

/**
 * 最大回撤。`points` 里每项至少要有 `equity`（`t` 可选）。
 * 返回 `{ pct, peakT, troughT }`：pct 是百分数；峰/谷值是**触发最大回撤那一段**的
 * 历史峰值时间与谷值时间；曲线单调上涨（回撤为 0）时时间是 null。
 */
function maxDrawdown(points) {
  let peak = null
  let peakT = null
  let maxDd = null
  let maxDdPeakT = null
  let maxDdTroughT = null
  for (const point of points) {
    const equity = numberOrNull(point?.equity)
    if (equity === null) continue
    if (peak === null || equity > peak) {
      peak = equity
      peakT = numberOrNull(point?.t)
      if (maxDd === null) maxDd = 0
    }
    // 峰值 ≤ 0（初始资金为负这种极端情况）时 “1 - equity/peak” 没有意义，跳过该段
    if (maxDd === null || !(peak > 0)) continue
    const drawdown = 1 - equity / peak
    if (drawdown > maxDd) {
      maxDd = drawdown
      maxDdPeakT = peakT
      maxDdTroughT = numberOrNull(point?.t)
    }
  }
  return {
    pct: maxDd === null ? null : maxDd * 100,
    peakT: maxDdPeakT,
    troughT: maxDdTroughT,
  }
}

/** 年化收益率（百分数）；见文件头“不足 1 天 / 期末权益 ≤ 0 → null”。 */
function annualizedReturn(initialEquity, finalEquity, days) {
  if (days === null || days < 1) return null
  if (initialEquity === null || initialEquity <= 0) return null
  if (finalEquity === null || finalEquity <= 0) return null
  return (Math.pow(finalEquity / initialEquity, 365 / days) - 1) * 100
}

/** 交易统计：胜率、盈亏因子、盈亏比、连赢连亏等（口径见文件头）。 */
function computeTradeStats(trades) {
  const pnls = []
  const pnlPcts = []
  for (const trade of trades) {
    const pnl = numberOrNull(trade?.pnl)
    if (pnl !== null) pnls.push(pnl)
    const notional = numberOrNull(trade?.notional)
    const pnlPct = numberOrNull(trade?.pnlPct)
      ?? (pnl !== null && notional !== null && notional > 0 ? (pnl / notional) * 100 : null)
    if (pnlPct !== null) pnlPcts.push(pnlPct)
  }

  const wins = pnls.filter((pnl) => pnl > 0)
  const losses = pnls.filter((pnl) => pnl < 0)
  let grossProfit = 0
  let grossLoss = 0
  for (const pnl of pnls) {
    if (pnl > 0) grossProfit += pnl
    else if (pnl < 0) grossLoss += -pnl
  }

  const tradeCount = trades.length
  const avgWin = mean(wins)
  const avgLoss = mean(losses)
  const avgTradePnl = mean(pnls)

  // 连赢/连亏：pnl==0（或缺失）的平价单不计入也不打断当前连击（SPEC §7 明确要求记录这一点）。
  let maxWins = 0
  let maxLosses = 0
  let winStreak = 0
  let lossStreak = 0
  for (const trade of trades) {
    const pnl = numberOrNull(trade?.pnl)
    if (pnl === null || pnl === 0) continue
    if (pnl > 0) {
      winStreak += 1
      lossStreak = 0
      if (winStreak > maxWins) maxWins = winStreak
    } else {
      lossStreak += 1
      winStreak = 0
      if (lossStreak > maxLosses) maxLosses = lossStreak
    }
  }

  return {
    tradeCount,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRatePct: tradeCount > 0 ? (wins.length / tradeCount) * 100 : null,
    // 没有亏损交易时盈亏因子无定义（SPEC 要求 null，报告层决定显示 ∞）
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWin,
    avgLoss,
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    avgTradePnl,
    avgTradePct: mean(pnlPcts),
    // 教科书期望值；等价于 avgTradePnl（见文件头说明），保留是因为 SPEC 两个字段都列了
    expectancy: tradeCount > 0 && pnls.length > 0 ? (grossProfit - grossLoss) / tradeCount : null,
    maxConsecutiveWins: maxWins,
    maxConsecutiveLosses: maxLosses,
  }
}

/**
 * 手续费汇总：优先用引擎给的 `result.fees`（它才是记账口径）；
 * 缺字段时才从 fills 反推（报告不该因为少了汇总字段就显示 null）。
 */
function computeFeeTotals(source, fills) {
  const feeInfo = asObject(source.fees)
  let maker = numberOrNull(feeInfo.maker)
  let taker = numberOrNull(feeInfo.taker)
  let total = numberOrNull(feeInfo.total)
  let count = numberOrNull(feeInfo.count)

  if (maker === null || taker === null || total === null) {
    let sumMaker = 0
    let sumTaker = 0
    for (const fill of fills) {
      const fee = numberOrNull(fill?.fee)
      if (fee === null) continue
      if (fill?.feeKind === 'maker') sumMaker += fee
      else if (fill?.feeKind === 'taker') sumTaker += fee
    }
    if (maker === null) maker = sumMaker
    if (taker === null) taker = sumTaker
    if (total === null) total = maker + taker
    if (count === null) count = fills.length
  }

  return {
    maker,
    taker,
    total,
    count: count ?? 0,
  }
}

/**
 * 资金费率（funding）汇总：优先用引擎给的 `result.funding`；
 * 缺字段时按 0 处理（旧结果/未启用 funding 的回测不该显示 null）。
 * `total` 为净支出：正数=付出，负数=收到。
 */
function computeFundingTotals(source) {
  const funding = asObject(source.funding)
  const paid = numberOrNull(funding.paid)
  const received = numberOrNull(funding.received)
  const total = numberOrNull(funding.total)
  const count = numberOrNull(funding.count)
  const safePaid = paid ?? 0
  const safeReceived = received ?? 0
  return {
    paid: safePaid,
    received: safeReceived,
    total: total ?? safePaid - safeReceived,
    count: count ?? 0,
    estimated: asObject(funding.meta).estimatedCount !== undefined
      ? numberOrNull(asObject(funding.meta).estimatedCount) ?? 0
      : null,
  }
}

/**
 * Buy&Hold 基准（现货、无杠杆、无手续费）：首根收盘价买入，之后按每根收盘价估值。
 * SPEC 明确“首根收盘买入、末根收盘”，所以首/末根价格缺失或非正时整组基准给 null
 * （不拿中间某一根的价格冒充首根，避免报告里出现一个"无中生有"的基准收益）。
 */
function computeBuyHold(curve, initialEquity) {
  const empty = { returnPct: null, maxDrawdownPct: null, finalEquity: null }
  if (initialEquity === null || initialEquity <= 0 || curve.length === 0) return empty

  const firstPrice = numberOrNull(curve[0]?.price)
  const lastPrice = numberOrNull(curve[curve.length - 1]?.price)
  if (firstPrice === null || firstPrice <= 0) return empty
  if (lastPrice === null || lastPrice <= 0) return empty

  // 中间点价格缺失时跳过该点（不影响首/末根的基准收益）
  const synthetic = []
  for (const point of curve) {
    const price = numberOrNull(point?.price)
    if (price === null || price <= 0) continue
    synthetic.push({ t: numberOrNull(point?.t), equity: (initialEquity * price) / firstPrice })
  }

  return {
    returnPct: (lastPrice / firstPrice - 1) * 100,
    maxDrawdownPct: maxDrawdown(synthetic).pct,
    finalEquity: (initialEquity * lastPrice) / firstPrice,
  }
}

/** 统一兜底：任何非有限数字都变 null；保证返回对象可直接 JSON.stringify。 */
function sanitize(metrics) {
  const clean = {}
  for (const key of Object.keys(metrics)) {
    const value = metrics[key]
    if (typeof value === 'number') clean[key] = Number.isFinite(value) ? value : null
    else clean[key] = value === undefined ? null : value
  }
  return clean
}

/**
 * 计算全部绩效指标（SPEC §7）。字段名与顺序照契约；算不出的给 null。
 * 对缺失字段尽量宽容（不抛错）—— 报告模块永远不该因为 result 少一个字段而崩掉；
 * 真正的契约校验由引擎/集成测试负责。
 *
 * @param {object} result BacktestResult（SPEC §4.1）
 * @returns {object} Metrics（SPEC §7）
 */
export function computeMetrics(result) {
  const source = asObject(result)
  const config = asObject(source.config)
  const range = asObject(source.range)
  const curve = asArray(source.equityCurve)
  const fills = asArray(source.fills)
  const trades = asArray(source.trades)

  const barMs = resolveBarMs(config, curve)
  const bars = numberOrNull(range.bars) ?? (curve.length > 0 ? curve.length : null)
  const firstT = numberOrNull(range.firstT)
    ?? (curve.length > 0 ? numberOrNull(curve[0]?.t) : null)
  const lastT = numberOrNull(range.lastT)
    ?? (curve.length > 0 ? numberOrNull(curve[curve.length - 1]?.t) : null)

  const initialEquity = numberOrNull(source.initialEquity) ?? numberOrNull(config.initialCapital)
  const finalEquity = numberOrNull(source.finalEquity)
    ?? (curve.length > 0 ? numberOrNull(curve[curve.length - 1]?.equity) : null)

  const days = resolveDays(bars, barMs, firstT, lastT)
  const totalReturnPct = initialEquity !== null && initialEquity > 0 && finalEquity !== null
    ? (finalEquity / initialEquity - 1) * 100
    : null
  const annualizedReturnPct = annualizedReturn(initialEquity, finalEquity, days)

  const drawdown = maxDrawdown(curve)

  // 年化类指标：ppY = 365*24*3600*1000 / barMs（SPEC §7 的公式）
  let volatilityPct = null
  let sharpe = null
  let sortino = null
  if (barMs !== null && barMs > 0) {
    const returns = buildReturns(curve)
    const ppY = MS_PER_YEAR / barMs
    const rootPpY = Math.sqrt(ppY)
    const averageReturn = mean(returns)
    // 样本不足（< 2 个收益率）时标准差没有意义；std=0 时 Sharpe/波动率都无定义（SPEC → null）
    const std = returns.length >= 2 ? populationStd(returns) : null
    if (averageReturn !== null && std !== null && std > 0) {
      volatilityPct = std * rootPpY * 100
      sharpe = (averageReturn / std) * rootPpY
    }
    // Sortino 的分母用下行偏差 sqrt(mean(min(r,0)^2))；没有负收益时下行偏差为 0 → null
    if (returns.length >= 2 && averageReturn !== null) {
      let downsideSquares = 0
      for (const value of returns) {
        const negative = Math.min(value, 0)
        downsideSquares += negative * negative
      }
      const downsideDeviation = Math.sqrt(downsideSquares / returns.length)
      if (downsideDeviation > 0) sortino = (averageReturn / downsideDeviation) * rootPpY
    }
  }
  // Calmar = 年化收益 / 最大回撤；回撤为 0（或年化算不出）→ null，不硬造一个 0
  const calmar = annualizedReturnPct !== null && drawdown.pct !== null && drawdown.pct > 0
    ? annualizedReturnPct / drawdown.pct
    : null

  const tradeStats = computeTradeStats(trades)
  const fees = computeFeeTotals(source, fills)
  const funding = computeFundingTotals(source)

  // 曝露率：有持仓（qty != 0）的 K 线点数占比
  let heldPoints = 0
  for (const point of curve) {
    const qty = numberOrNull(point?.qty)
    if (qty !== null && qty !== 0) heldPoints += 1
  }
  const exposurePct = curve.length > 0 ? (heldPoints / curve.length) * 100 : null

  const liquidations = Array.isArray(source.liquidations)
    ? source.liquidations.length
    : (numberOrNull(source.liquidations) ?? 0)

  const buyHold = computeBuyHold(curve, initialEquity)

  return sanitize({
    bars,
    firstT,
    lastT,
    days,
    initialEquity,
    finalEquity,
    totalReturnPct,
    annualizedReturnPct,
    maxDrawdownPct: drawdown.pct,
    maxDrawdownPeakT: drawdown.peakT,
    maxDrawdownTroughT: drawdown.troughT,
    volatilityPct,
    sharpe,
    sortino,
    calmar,
    ...tradeStats,
    feesMaker: fees.maker,
    feesTaker: fees.taker,
    feesTotal: fees.total,
    feesPctOfCapital: initialEquity !== null && initialEquity > 0 ? (fees.total / initialEquity) * 100 : null,
    // 资金费率（funding）：total 为净支出（正=付出，负=收到）
    fundingPaid: funding.paid,
    fundingReceived: funding.received,
    fundingTotal: funding.total,
    fundingCount: funding.count,
    fundingEstimatedCount: funding.estimated,
    fundingPctOfCapital: initialEquity !== null && initialEquity > 0 ? (funding.total / initialEquity) * 100 : null,
    // 总成本（手续费 + 资金费率净支出）占初始资金
    totalCostPctOfCapital: initialEquity !== null && initialEquity > 0
      ? ((fees.total + funding.total) / initialEquity) * 100
      : null,
    exposurePct,
    liquidations,
    buyHoldReturnPct: buyHold.returnPct,
    buyHoldMaxDrawdownPct: buyHold.maxDrawdownPct,
    buyHoldFinalEquity: buyHold.finalEquity,
  })
}
