/**
 * 报告输出（SPEC §5.6 / §8）：控制台摘要、JSON、自包含 HTML、交易 CSV。
 *
 * 几条刻意的决定：
 *   1. **报告是给人看的最后一道口径闸门**：指标为 null 时显示 `—`（而不是 NaN / undefined）；
 *      金额千分位、百分比两位、比率两位、时间统一走 config.mjs 的 UTC+8 格式化函数，
 *      保证 CLI、JSON、HTML、CSV 四处的数字不会“同一份结果四种写法”。
 *   2. **控制台不用颜色、不依赖终端**：重定向到文件、粘进 issue 也要能读；中文按显示宽度
 *      对齐（CJK 占两格），不用 `padEnd` 硬凑（那样中文列会歪）。
 *   3. **HTML 自包含**：内联 CSS + 内联 SVG，零外部资源（无 http(s) 链接、无字体/脚本/CDN）。
 *      SVG 里刻意不写 `xmlns="http://www.w3.org/2000/svg"`（HTML5 内联 SVG 不需要，
 *      写了反而让“离线自包含”的静态检查出现一个假的 http 链接）。
 *   4. **JSON 报告全量可复现**：equityCurve / fills / trades 原样带上，指标里的 null 保持
 *      JSON null（`.stringify` 不会写出 `Infinity` 字符串）。
 *   5. HTML 交易表最多 500 行并注明截断 —— 几万笔交易全塞进 HTML 会让浏览器打开就卡死，
 *      完整明细留给 JSON/CSV。
 *   6. 报告只消费已知字段，不打印 config 里的 dataDir/outDir 之类本机绝对路径（JSON 除外：
 *      SPEC 要求原样带上 config 以便复现）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { DEFAULT_OUT_DIR, formatDateUtc8, formatFeeRate, formatTimeUtc8 } from './config.mjs'
import { computeMetrics } from './metrics.mjs'

/** JSON 报告里的框架标识（SPEC §8 固定值）。 */
const FRAMEWORK = 'btc-dashboard/backtest'
/** 无值占位符：报告里宁可显示这个，也不显示 null / NaN / undefined。 */
const DASH = '—'
/** HTML 交易表上限（SPEC §8：最多 500 行并注明截断）。 */
const MAX_HTML_TRADE_ROWS = 500
/** SVG 采样上限：1m×30 天有 4 万多点，全画进 SVG 文件会有几 MB，浏览器打开就卡。 */
const CHART_MAX_POINTS = 720
/** K 线图最多画多少根蜡烛：超过就按桶聚合（宽度 960px 下 480 根已经足够密）。 */
const CHART_MAX_CANDLES = 480
/** K 线图上最多标记多少笔交易（几百个标记会把图糊掉，完整明细交给交易表/CSV）。 */
const CHART_MAX_TRADE_MARKERS = 160
/** 控制台“标签：值”单元格的显示宽度（CJK 字符按 2 格算）。 */
const CELL_WIDTH = 22

const CHART = Object.freeze({
  width: 960,
  height: 340,
  padTop: 20,
  padRight: 20,
  padBottom: 34,
  padLeft: 78,
})

// ───────────────────────────── 基础工具 ─────────────────────────────

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asObject(value) {
  return isPlainObject(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function pickNum(...values) {
  for (const value of values) if (isNum(value)) return value
  return null
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/** 金额：千分位 + 固定小数位；非数字显示 `—`。 */
function formatAmount(value, digits = 2) {
  if (!isNum(value)) return DASH
  const negative = value < 0
  const fixed = Math.abs(value).toFixed(digits)
  const parts = fixed.split('.')
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const text = parts.length > 1 ? grouped + '.' + parts[1] : grouped
  return (negative ? '-' : '') + text
}

/** 带正负号的金额（盈亏类）：正数显式加 `+`。 */
function formatSignedAmount(value, digits = 2) {
  if (!isNum(value)) return DASH
  return (value > 0 ? '+' : '') + formatAmount(value, digits)
}

/** 百分比：百分数输入（12.34 表示 12.34%），固定两位。 */
function formatPercent(value, digits = 2, signed = false) {
  if (!isNum(value)) return DASH
  const text = Math.abs(value).toFixed(digits) + '%'
  if (value < 0) return '-' + text
  if (signed && value > 0) return '+' + text
  return text
}

/** 比率（Sharpe / Sortino / 盈亏比）：固定两位，不带单位。 */
function formatRatio(value) {
  return isNum(value) ? formatAmount(value, 2) : DASH
}

/** 计数：整数 + 千分位。 */
function formatCount(value) {
  return isNum(value) ? formatAmount(value, 0) : DASH
}

/**
 * 盈利因子 / 盈亏比在“有盈利交易但一笔都没亏”时指标为 null（SPEC 要求 metrics 给 null），
 * 报告层按 SPEC §7 的说明显示 `∞`；真正没交易/没数据时仍显示 `—`。
 */
function formatProfitFactor(value, metrics) {
  if (isNum(value)) return formatAmount(value, 2)
  if (isNum(metrics?.winningTrades) && metrics.winningTrades > 0
    && isNum(metrics?.losingTrades) && metrics.losingTrades === 0) return '∞'
  return DASH
}

function formatPayoffRatio(value, metrics) {
  if (isNum(value)) return formatAmount(value, 2)
  if (isNum(metrics?.winningTrades) && metrics.winningTrades > 0
    && isNum(metrics?.losingTrades) && metrics.losingTrades === 0) return '∞'
  return DASH
}

/** HTML 文本转义：报告里所有来自 result/config/策略名的文本都必须过这一层。 */
function escapeHtml(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 字符显示宽度：CJK / 全角按 2 格，其余 1 格（等宽中文对齐用）。 */
function textWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/** 控制台双列单元格：标签+值整体补齐到固定显示宽度，保证两列对齐。
 * 值太长（超过列宽）时至少留两个空格，避免和右侧单元格粘在一起。 */
function cell(label, value) {
  const text = label + '：' + value
  const width = textWidth(text)
  return text + ' '.repeat(width < CELL_WIDTH ? CELL_WIDTH - width : 2)
}
/** 控制台单列行（值太长时不适合放双列）。 */
function row(label, value) {
  return '  ' + label + '：' + value
}

function section(title) {
  return '【' + title + '】'
}

// ───────────────────────────── 入参归一化 ─────────────────────────────

function resolveConfig(config, source) {
  if (isPlainObject(config)) return config
  return asObject(source?.config)
}

/**
 * 策略展示对象：只留 `{ name, params }`（策略对象上可能有函数，不能直接 JSON.stringify）。
 * 也接受调用方直接传策略名字符串。
 */
function resolveStrategy(source, strategy) {
  const raw = strategy === undefined || strategy === null ? source?.strategy : strategy
  if (typeof raw === 'string' && raw.trim() !== '') return { name: raw.trim(), params: {} }
  if (!isPlainObject(raw)) return { name: 'unknown', params: {} }
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'unknown'
  return { name, params: isPlainObject(raw.params) ? raw.params : {} }
}

/** generatedAt 统一成 UTC 毫秒（框架内部时间口径；HTML 展示时再转 UTC+8）。 */
function resolveGeneratedAt(value) {
  if (isNum(value)) return value
  if (value instanceof Date) {
    const time = value.getTime()
    if (Number.isFinite(time)) return time
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function resolveMetrics(metrics, source) {
  return isPlainObject(metrics) ? metrics : computeMetrics(source)
}

// ───────────────────────────── JSON 报告 ─────────────────────────────

/**
 * JSON 报告（SPEC §8）：顶层就 6 个键，不要加私货 —— 下游脚本按这个形状读。
 * 结果里的 equityCurve / fills / trades 全量带上，报告可以离线复现。
 */
export function buildJsonReport({ result, metrics, config, strategy, generatedAt } = {}) {
  const source = asObject(result)
  return {
    generatedAt: resolveGeneratedAt(generatedAt),
    framework: FRAMEWORK,
    config: resolveConfig(config, source),
    strategy: resolveStrategy(source, strategy),
    result: result ?? null,
    metrics: metrics ?? null,
  }
}

// ───────────────────────────── 控制台报告 ─────────────────────────────

/**
 * 控制台摘要（SPEC §5.6）：纯文本、无颜色、中文等宽对齐。
 * 结构：配置 → 绩效 → 交易 → 费用 → 基准对比 → 风险/拒单 → 提示。
 */
export function formatConsole(result, metrics, config) {
  const source = asObject(result)
  const cfg = resolveConfig(config, source)
  const m = resolveMetrics(metrics, source)
  const strategy = resolveStrategy(source)
  const instId = typeof cfg.instId === 'string' && cfg.instId !== '' ? cfg.instId : DASH
  const barText = typeof cfg.bar === 'string' && cfg.bar !== '' ? cfg.bar : DASH

  const lines = []
  const title = instId + ' 永续合约回测报告'
  lines.push('='.repeat(10) + ' ' + title + ' ' + '='.repeat(10))
  if (isNum(cfg.now)) lines.push('生成时间：' + formatTimeUtc8(cfg.now))
  if (isNum(cfg.start) && isNum(cfg.end)) {
    lines.push('回测区间：' + formatTimeUtc8(cfg.start) + ' → ' + formatTimeUtc8(cfg.end))
  }
  lines.push('')

  // ---- 配置
  const initialCapital = pickNum(m.initialEquity, cfg.initialCapital)
  const closeAtEnd = cfg.closeAtEnd === true ? '是' : (cfg.closeAtEnd === false ? '否' : DASH)
  lines.push(section('配置'))
  lines.push('  ' + cell('标的', instId) + cell('周期', barText))
  lines.push('  ' + cell('策略', strategy.name)
    + cell('杠杆', isNum(cfg.leverage) ? formatCount(cfg.leverage) + 'x' : DASH))
  lines.push('  ' + cell('初始资金', formatAmount(initialCapital) + ' USDT') + cell('期末平仓', closeAtEnd))
  lines.push('  ' + cell('挂单费率', formatFeeRate(cfg.makerFeeRate))
    + cell('吃单费率', formatFeeRate(cfg.takerFeeRate)))
  lines.push('  ' + cell('滑点', isNum(cfg.slippageBps) ? formatAmount(cfg.slippageBps, 1) + ' bp' : DASH)
    + cell('维持保证金率', isNum(cfg.maintenanceMarginRate) ? formatPercent(cfg.maintenanceMarginRate * 100) : DASH))
  lines.push('  ' + cell('限价成交', typeof cfg.limitFill === 'string' ? cfg.limitFill : DASH)
    + cell('回测根数', formatCount(m.bars)))
  lines.push(row('实际覆盖', formatTimeUtc8(m.firstT) + ' → ' + formatTimeUtc8(m.lastT)
    + '（' + formatCount(m.bars) + ' 根 / ' + formatAmount(m.days, 2) + ' 天）'))
  lines.push('')

  // ---- 绩效
  lines.push(section('绩效'))
  lines.push('  ' + cell('期初权益', formatAmount(m.initialEquity) + ' USDT')
    + cell('期末权益', formatAmount(m.finalEquity) + ' USDT'))
  lines.push('  ' + cell('总收益', formatPercent(m.totalReturnPct, 2, true))
    + cell('年化收益', formatPercent(m.annualizedReturnPct, 2, true)))
  lines.push('  ' + cell('最大回撤', formatPercent(m.maxDrawdownPct))
    + cell('波动率', formatPercent(m.volatilityPct)))
  lines.push('  ' + cell('Sharpe', formatRatio(m.sharpe)) + cell('Sortino', formatRatio(m.sortino)))
  lines.push('  ' + cell('Calmar', formatRatio(m.calmar)) + cell('曝露率', formatPercent(m.exposurePct)))
  lines.push(row('最大回撤区间', formatTimeUtc8(m.maxDrawdownPeakT) + ' → ' + formatTimeUtc8(m.maxDrawdownTroughT)))
  lines.push('')

  // ---- 交易
  const tradeCount = isNum(m.tradeCount) ? m.tradeCount : 0
  const wins = isNum(m.winningTrades) ? m.winningTrades : 0
  const losses = isNum(m.losingTrades) ? m.losingTrades : 0
  const breakeven = Math.max(0, tradeCount - wins - losses)
  lines.push(section('交易'))
  lines.push('  ' + cell('交易次数', formatCount(m.tradeCount))
    + cell('胜 / 负 / 平', wins + ' / ' + losses + ' / ' + breakeven))
  lines.push('  ' + cell('胜率', formatPercent(m.winRatePct))
    + cell('盈利因子', formatProfitFactor(m.profitFactor, m)))
  lines.push('  ' + cell('盈亏比', formatPayoffRatio(m.payoffRatio, m))
    + cell('平均每笔收益', formatPercent(m.avgTradePct, 2, true)))
  lines.push('  ' + cell('平均盈利', formatAmount(m.avgWin)) + cell('平均亏损', formatAmount(m.avgLoss)))
  lines.push('  ' + cell('平均每笔', formatSignedAmount(m.avgTradePnl))
    + cell('最大连赢', formatCount(m.maxConsecutiveWins) + ' 次'))
  lines.push('  ' + cell('最大连亏', formatCount(m.maxConsecutiveLosses) + ' 次')
    + cell('期望值', formatSignedAmount(m.expectancy)))
  lines.push('')

  // ---- 费用
  lines.push(section('费用'))
  lines.push('  ' + cell('挂单手续费(maker)', formatAmount(m.feesMaker) + ' USDT')
    + cell('吃单手续费(taker)', formatAmount(m.feesTaker) + ' USDT'))
  lines.push('  ' + cell('费用合计', formatAmount(m.feesTotal) + ' USDT')
    + cell('占初始资金', formatPercent(m.feesPctOfCapital)))
  // 资金费率：净支出为正（多头付），净收入为负（空头收）
  const fundingExtra = isNum(m.fundingEstimatedCount) && m.fundingEstimatedCount > 0
    ? '（估算 ' + formatCount(m.fundingEstimatedCount) + ' 次）'
    : ''
  lines.push('  ' + cell('资金费率净支出', formatSignedAmount(m.fundingTotal) + ' USDT')
    + cell('结算次数', formatCount(m.fundingCount) + ' 次' + fundingExtra))
  lines.push('')

  // ---- 基准对比
  const excess = isNum(m.totalReturnPct) && isNum(m.buyHoldReturnPct)
    ? m.totalReturnPct - m.buyHoldReturnPct
    : null
  lines.push(section('基准对比（Buy & Hold）'))
  lines.push('  ' + cell('基准收益', formatPercent(m.buyHoldReturnPct, 2, true))
    + cell('超额收益', formatPercent(excess, 2, true)))
  lines.push('  ' + cell('基准期末权益', formatAmount(m.buyHoldFinalEquity) + ' USDT')
    + cell('基准最大回撤', formatPercent(m.buyHoldMaxDrawdownPct)))
  lines.push('')

  // ---- 风险与拒单
  const fills = asArray(source.fills)
  const rejected = asArray(source.rejected)
  const curve = asArray(source.equityCurve)
  const finalQty = curve.length > 0 && isNum(curve[curve.length - 1]?.qty)
    ? curve[curve.length - 1].qty
    : null
  lines.push(section('风险与拒单'))
  lines.push('  ' + cell('爆仓次数', formatCount(m.liquidations)) + cell('被拒委托', formatCount(rejected.length)))
  lines.push('  ' + cell('成交笔数', formatCount(fills.length))
    + cell('期末持仓', finalQty === null ? DASH : formatAmount(finalQty, 6) + ' BTC'))
  lines.push('')

  // ---- 提示（口径边界写在报告里，避免读者把近似模型当成清结算结果）
  lines.push(section('提示'))
  lines.push('  · 资金费率默认计入（历史只覆盖最近约 3 个月，更早区间按估算费率补，报告标注估算次数）；')
  lines.push('    不含盘口深度与部分成交；爆仓为近似模型。')
  lines.push('  · 数字口径面向策略研究，不是清结算级精度，不构成投资建议。')
  const warnings = asArray(cfg.warnings).filter((item) => typeof item === 'string' && item !== '')
  if (warnings.length > 0) lines.push('  · 配置警告：' + warnings.join('；'))

  return lines.join('\n')
}

// ───────────────────────────── HTML 报告 ─────────────────────────────

const HTML_CSS = `
:root {
  --bg: #f5f7fa;
  --card: #ffffff;
  --text: #1f2933;
  --muted: #6b7280;
  --border: #e5e7eb;
  --pos: #047857;
  --neg: #b91c1c;
  --eq: #2563eb;
  --base: #9ca3af;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 28px 20px 48px;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 14px;
  line-height: 1.65;
}
.hero, main, footer.foot { max-width: 1080px; margin-left: auto; margin-right: auto; }
.hero { margin-bottom: 20px; }
.hero h1 { margin: 0 0 8px; font-size: 26px; font-weight: 700; }
.hero .sub { margin: 0 0 6px; color: var(--muted); }
.hero .meta { margin: 0; color: var(--muted); font-size: 12px; }
.hero .warn {
  margin: 10px 0 0;
  padding: 8px 12px;
  border-left: 3px solid #d97706;
  background: #fffbeb;
  color: #92400e;
  border-radius: 4px;
}
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin: 0 0 18px; }
.kpi { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.kpi .kpi-label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.kpi .kpi-value { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi .kpi-value.pos { color: var(--pos); }
.kpi .kpi-value.neg { color: var(--neg); }
section.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin: 0 0 18px; }
section.card h2 { margin: 0 0 14px; font-size: 17px; font-weight: 600; }
.chart { display: block; width: 100%; height: auto; }
.chart .grid { stroke: var(--border); stroke-width: 1; }
.chart .axis-label { fill: var(--muted); font-size: 12px; font-family: inherit; }
.chart .empty { fill: var(--muted); font-size: 14px; }
.chart .eq-line { fill: none; stroke: var(--eq); stroke-width: 1.6; }
.chart .eq-area { fill: var(--eq); opacity: 0.10; }
.chart .base-line { fill: none; stroke: var(--base); stroke-width: 1.4; stroke-dasharray: 5 4; }
.chart .dd-line { fill: none; stroke: #dc2626; stroke-width: 1.4; }
.chart .dd-area { fill: #dc2626; opacity: 0.14; }
.chart .candle-up { fill: #047857; }
.chart .candle-down { fill: #b91c1c; }
.chart .wick-up { stroke: #047857; stroke-width: 1; }
.chart .wick-down { stroke: #b91c1c; stroke-width: 1; }
.chart .hold-band { fill: #2563eb; opacity: 0.08; }
.chart .marker-long { fill: #047857; }
.chart .marker-short { fill: #b91c1c; }
.chart .marker-win { fill: #047857; }
.chart .marker-loss { fill: #b91c1c; }
.chart .note { fill: var(--muted); font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; color: var(--muted); font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 14px; height: 8px; border-radius: 2px; }
.swatch.eq { background: var(--eq); }
.swatch.base { background: var(--base); }
.swatch.dd { background: #dc2626; }
.swatch.candle-up { background: #047857; }
.swatch.candle-down { background: #b91c1c; }
.swatch.hold { background: rgba(37, 99, 235, 0.22); }
.swatch.marker-long { background: #047857; }
.swatch.marker-short { background: #b91c1c; }
.muted { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
thead th { background: #f9fafb; color: var(--muted); font-weight: 600; }
tbody tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
table.kv th { width: 42%; color: var(--muted); font-weight: 500; }
table.kv td { font-variant-numeric: tabular-nums; }
ul.limits { margin: 0; padding-left: 20px; }
ul.limits li { margin: 4px 0; }
footer.foot { margin-top: 8px; color: var(--muted); font-size: 12px; }
@media (max-width: 640px) {
  body { padding: 16px 10px 32px; }
  .hero h1 { font-size: 21px; }
  .hero .sub { font-size: 12px; }
}
`.trim()

/** 空图/数据不足时的 SVG 兜底：照样输出合法 SVG，不产生 NaN 坐标。 */
function chartPlaceholder(text) {
  return '<svg class="chart" viewBox="0 0 960 160" role="img" aria-label="' + escapeHtml(text) + '">'
    + '<text class="empty" x="480" y="88" text-anchor="middle">' + escapeHtml(text) + '</text>'
    + '</svg>'
}

/** 等间距采样下标（保留首尾点）；点数不多时原样返回。 */
function sampleIndexes(length, maxPoints) {
  if (length <= maxPoints) {
    return Array.from({ length }, (unused, index) => index)
  }
  const step = (length - 1) / (maxPoints - 1)
  const indexes = []
  let previous = -1
  for (let index = 0; index < maxPoints; index += 1) {
    const current = Math.round(index * step)
    if (current !== previous) {
      indexes.push(current)
      previous = current
    }
  }
  return indexes
}

/** Y 轴金额的紧凑写法（1e6 以上用 M/B，避免坐标标签挤成一团）。 */
function compactAmount(value) {
  if (!isNum(value)) return ''
  const abs = Math.abs(value)
  if (abs >= 1e9) return (value / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (value / 1e6).toFixed(2) + 'M'
  if (abs >= 1e4) return formatAmount(value, 0)
  return formatAmount(value, 2)
}

/** 图表的通用坐标系与网格（y 值由调用方的映射函数决定）。 */
function chartFrame() {
  const plotWidth = CHART.width - CHART.padLeft - CHART.padRight
  const plotHeight = CHART.height - CHART.padTop - CHART.padBottom
  return {
    plotWidth,
    plotHeight,
    left: CHART.padLeft,
    top: CHART.padTop,
    right: CHART.padLeft + plotWidth,
    bottom: CHART.padTop + plotHeight,
  }
}

/** X 轴刻度：首/中/末三处日期（UTC+8），避免密集时间标签糊成一片。 */
function renderXAxisLabels(points, sampleRanks) {
  const plotWidth = CHART.width - CHART.padLeft - CHART.padRight
  const lastRank = sampleRanks.length - 1
  const candidates = lastRank <= 0
    ? [0]
    : [...new Set([0, Math.floor(lastRank / 2), lastRank])]
  const ticks = []
  for (const rank of candidates) {
    const point = points[sampleRanks[rank]]
    if (point === undefined) continue
    const isFirst = rank === 0
    const isLast = rank === lastRank
    // 只有一个点时把标签放在图中间（和居中的折线对齐），其余按首/中/末分布
    const ratio = lastRank <= 0 ? 0.5 : rank / lastRank
    const x = round2(isLast && lastRank > 0 ? CHART.padLeft + plotWidth : CHART.padLeft + ratio * plotWidth)
    const anchor = lastRank <= 0 ? 'middle' : (isFirst ? 'start' : (isLast ? 'end' : 'middle'))
    ticks.push('<text class="axis-label" x="' + x + '" y="' + (CHART.height - 10) + '" text-anchor="' + anchor + '">'
      + escapeHtml(formatDateUtc8(point.t)) + '</text>')
  }
  return ticks.join('')
}

/** 资金曲线 SVG（含 Buy&Hold 基准）+ 图例。采样时两条序列共用同一组下标，保证对齐。 */
function renderEquitySection(curve, metrics) {
  const points = []
  for (const point of curve) {
    if (!isPlainObject(point)) continue
    if (!isNum(point.equity) || !isNum(point.t)) continue
    points.push({
      t: point.t,
      equity: point.equity,
      price: isNum(point.price) && point.price > 0 ? point.price : null,
    })
  }
  const heading = '<h2>资金曲线（含 Buy &amp; Hold 基准）</h2>'
  if (points.length === 0) {
    return '<section class="card">' + heading + chartPlaceholder('暂无资金曲线数据（回测没有产生 K 线）') + '</section>'
  }

  const sampleRanks = sampleIndexes(points.length, CHART_MAX_POINTS)
  const equityValues = sampleRanks.map((index) => points[index].equity)
  const initialEquity = isNum(metrics?.initialEquity) ? metrics.initialEquity : null
  const firstPrice = points[0].price
  const canBaseline = initialEquity !== null && initialEquity > 0 && firstPrice !== null
  const baselineValues = canBaseline
    ? sampleRanks.map((index) => {
      const price = points[index].price
      return price === null ? null : (initialEquity * price) / firstPrice
    })
    : null

  let minValue = null
  let maxValue = null
  const include = (value) => {
    if (value === null) return
    if (minValue === null || value < minValue) minValue = value
    if (maxValue === null || value > maxValue) maxValue = value
  }
  for (const value of equityValues) include(value)
  if (baselineValues !== null) for (const value of baselineValues) include(value)
  if (minValue === null || maxValue === null) {
    return '<section class="card">' + heading + chartPlaceholder('暂无资金曲线数据（权益点不完整）') + '</section>'
  }
  if (maxValue === minValue) {
    const padding = Math.abs(maxValue) * 0.01 || 1
    minValue -= padding
    maxValue += padding
  } else {
    const padding = (maxValue - minValue) * 0.06
    minValue -= padding
    maxValue += padding
  }

  const frame = chartFrame()
  const xAt = (rank) => (sampleRanks.length <= 1
    ? frame.left + frame.plotWidth / 2
    : frame.left + (rank / (sampleRanks.length - 1)) * frame.plotWidth)
  const yAt = (value) => frame.top + ((maxValue - value) / (maxValue - minValue)) * frame.plotHeight

  const grid = []
  for (let step = 0; step <= 4; step += 1) {
    const fraction = step / 4
    const value = maxValue - fraction * (maxValue - minValue)
    const y = round2(yAt(value))
    grid.push('<line class="grid" x1="' + frame.left + '" y1="' + y + '" x2="' + round2(frame.right) + '" y2="' + y + '"/>')
    grid.push('<text class="axis-label" x="' + (frame.left - 8) + '" y="' + round2(y + 4)
      + '" text-anchor="end">' + escapeHtml(compactAmount(value)) + '</text>')
  }

  const equityLine = equityValues
    .map((value, rank) => round2(xAt(rank)) + ',' + round2(yAt(value)))
    .join(' ')
  const areaPoints = round2(xAt(0)) + ',' + round2(frame.bottom) + ' '
    + equityLine + ' '
    + round2(xAt(sampleRanks.length - 1)) + ',' + round2(frame.bottom)
  let baselineLine = ''
  if (baselineValues !== null) {
    const baselinePoints = []
    baselineValues.forEach((value, rank) => {
      if (value !== null) baselinePoints.push(round2(xAt(rank)) + ',' + round2(yAt(value)))
    })
    if (baselinePoints.length >= 2) {
      baselineLine = '<polyline class="base-line" points="' + baselinePoints.join(' ') + '"/>'
    }
  }

  const svg = '<svg class="chart" viewBox="0 0 ' + CHART.width + ' ' + CHART.height
    + '" role="img" aria-label="资金曲线图">'
    + grid.join('')
    + renderXAxisLabels(points, sampleRanks)
    + baselineLine
    + '<polygon class="eq-area" points="' + areaPoints + '"/>'
    + '<polyline class="eq-line" points="' + equityLine + '"/>'
    + '</svg>'
  const legend = '<div class="legend">'
    + '<span><i class="swatch eq"></i>策略权益（USDT）</span>'
    + '<span><i class="swatch base"></i>Buy &amp; Hold 基准（现货持有）</span>'
    + '</div>'
  return '<section class="card">' + heading + svg + legend + '</section>'
}

/** 回撤曲线 SVG：相对历史峰值的回撤百分比，越往下回撤越深。 */
function renderDrawdownSection(curve) {
  const points = []
  let peak = null
  for (const point of curve) {
    if (!isPlainObject(point)) continue
    if (!isNum(point.equity) || !isNum(point.t)) continue
    if (peak === null || point.equity > peak) peak = point.equity
    if (peak === null || !(peak > 0)) continue
    points.push({ t: point.t, drawdown: Math.max(0, 1 - point.equity / peak) * 100 })
  }
  const heading = '<h2>回撤曲线</h2>'
  if (points.length === 0) {
    return '<section class="card">' + heading + chartPlaceholder('暂无回撤数据') + '</section>'
  }
  let maxDrawdown = 0
  for (const point of points) if (point.drawdown > maxDrawdown) maxDrawdown = point.drawdown
  if (!(maxDrawdown > 0)) {
    return '<section class="card">' + heading + chartPlaceholder('本期无回撤（权益未跌破历史峰值）') + '</section>'
  }

  const sampleRanks = sampleIndexes(points.length, CHART_MAX_POINTS)
  const values = sampleRanks.map((index) => points[index].drawdown)
  const domainMax = maxDrawdown * 1.05
  const frame = chartFrame()
  const xAt = (rank) => (sampleRanks.length <= 1
    ? frame.left + frame.plotWidth / 2
    : frame.left + (rank / (sampleRanks.length - 1)) * frame.plotWidth)
  // 回撤是“负向”指标：0 在顶部，数值越大越往下
  const yAt = (value) => frame.top + (value / domainMax) * frame.plotHeight

  const grid = []
  for (let step = 0; step <= 4; step += 1) {
    const value = (domainMax / 4) * step
    const y = round2(yAt(value))
    grid.push('<line class="grid" x1="' + frame.left + '" y1="' + y + '" x2="' + round2(frame.right) + '" y2="' + y + '"/>')
    grid.push('<text class="axis-label" x="' + (frame.left - 8) + '" y="' + round2(y + 4)
      + '" text-anchor="end">' + escapeHtml(formatPercent(-value)) + '</text>')
  }
  const linePoints = values
    .map((value, rank) => round2(xAt(rank)) + ',' + round2(yAt(value)))
    .join(' ')
  const areaPoints = round2(xAt(0)) + ',' + round2(frame.top) + ' '
    + linePoints + ' '
    + round2(xAt(sampleRanks.length - 1)) + ',' + round2(frame.top)

  const svg = '<svg class="chart" viewBox="0 0 ' + CHART.width + ' ' + CHART.height
    + '" role="img" aria-label="回撤曲线图">'
    + grid.join('')
    + renderXAxisLabels(points, sampleRanks)
    + '<polygon class="dd-area" points="' + areaPoints + '"/>'
    + '<polyline class="dd-line" points="' + linePoints + '"/>'
    + '</svg>'
  const legend = '<div class="legend">'
    + '<span><i class="swatch dd"></i>相对历史峰值的回撤幅度</span>'
    + '<span>最大回撤 ' + escapeHtml(formatPercent(maxDrawdown)) + '</span>'
    + '</div>'
  return '<section class="card">' + heading + svg + legend + '</section>'
}

/**
 * K 线图（价格走势 + 持仓底纹 + 交易标记）。
 *
 * 为什么需要它：只给资金曲线/回撤曲线的话，读者看不出"权益为什么这么走"——
 * 是趋势跟对了、还是在一段震荡里被反复打脸；把价格 K 线和买卖点画在同一张图上才能复盘。
 *
 * 三个刻意的处理：
 *   1. **聚合**：1m×30 天有 4 万多根，全画进 SVG 会有几 MB。这里按桶聚合到 ≤480 根
 *      （开=第一根开盘、收=最后一根收盘、高低取桶内极值），保证报告文件大小与可读性。
 *   2. **持仓底纹**：用 `equityCurve` 的 `qty`（与 bars 一一对应）给"有仓位"的桶加淡蓝底，
 *      一眼能看出策略什么时候在场内、什么时候空仓。
 *   3. **交易标记**：▲=开仓（绿多红空）、●=平仓（绿盈红亏），带 `<title>` 悬停信息；
 *      标记数量设上限（几百个会把图糊掉），完整明细仍在交易表/CSV。
 */
function renderCandleSection(bars, curve, tradesInput) {
  const heading = '<h2>价格 K 线与交易标记</h2>'
  const rawBars = asArray(bars)
  const candles = []
  for (let index = 0; index < rawBars.length; index += 1) {
    const bar = rawBars[index]
    if (!isPlainObject(bar)) continue
    if (!isNum(bar.t) || !isNum(bar.o) || !isNum(bar.h) || !isNum(bar.l) || !isNum(bar.c)) continue
    if (!(bar.o > 0 && bar.h > 0 && bar.l > 0 && bar.c > 0)) continue
    const point = asArray(curve)[index]
    const qty = isPlainObject(point) && isNum(point.qty) ? point.qty : 0
    candles.push({
      t: bar.t,
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
      hold: qty !== 0,
    })
  }
  if (candles.length === 0) {
    return '<section class="card">' + heading
      + chartPlaceholder('未提供 K 线数据（报告生成时没有传入 bars，用 CLI / 回测面板生成即可）')
      + '</section>'
  }

  // ---- 按桶聚合（保留首尾；桶内持仓状态取"任一时刻有仓"）
  const bucketSize = Math.max(1, Math.ceil(candles.length / CHART_MAX_CANDLES))
  const buckets = []
  for (let start = 0; start < candles.length; start += bucketSize) {
    const chunk = candles.slice(start, start + bucketSize)
    let high = chunk[0].h
    let low = chunk[0].l
    let hold = false
    for (const item of chunk) {
      if (item.h > high) high = item.h
      if (item.l < low) low = item.l
      if (item.hold === true) hold = true
    }
    buckets.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: high,
      l: low,
      c: chunk[chunk.length - 1].c,
      hold: hold,
    })
  }
  const count = buckets.length

  // ---- 价格范围（上下各留 4% 余量）
  let minPrice = Infinity
  let maxPrice = -Infinity
  for (const bucket of buckets) {
    if (bucket.l < minPrice) minPrice = bucket.l
    if (bucket.h > maxPrice) maxPrice = bucket.h
  }
  if (!(maxPrice > minPrice)) {
    const padding = Math.abs(maxPrice) * 0.01 || 1
    minPrice -= padding
    maxPrice += padding
  } else {
    const padding = (maxPrice - minPrice) * 0.04
    minPrice -= padding
    maxPrice += padding
  }

  const frame = chartFrame()
  const step = frame.plotWidth / count
  const bodyWidth = Math.max(1, Math.min(10, step * 0.64))
  const xCenter = (index) => frame.left + (index + 0.5) * step
  const yAt = (price) => frame.top + ((maxPrice - price) / (maxPrice - minPrice)) * frame.plotHeight
  const yBounded = (price) => Math.min(frame.bottom, Math.max(frame.top, yAt(price)))

  // ---- y 轴网格 + 标签
  const grid = []
  for (let stepIndex = 0; stepIndex <= 4; stepIndex += 1) {
    const price = maxPrice - (stepIndex / 4) * (maxPrice - minPrice)
    const y = round2(yAt(price))
    grid.push('<line class="grid" x1="' + frame.left + '" y1="' + y + '" x2="' + round2(frame.right) + '" y2="' + y + '"/>')
    grid.push('<text class="axis-label" x="' + (frame.left - 8) + '" y="' + round2(y + 4)
      + '" text-anchor="end">' + escapeHtml(compactAmount(price)) + '</text>')
  }

  // ---- x 轴刻度：首/中/末
  const ticks = []
  const tickRanks = count <= 1 ? [0] : [...new Set([0, Math.floor((count - 1) / 2), count - 1])]
  for (const rank of tickRanks) {
    const x = round2(rank === 0 ? frame.left : (rank === count - 1 ? frame.right : xCenter(rank)))
    const anchor = rank === 0 ? 'start' : (rank === count - 1 ? 'end' : 'middle')
    ticks.push('<text class="axis-label" x="' + x + '" y="' + (CHART.height - 10)
      + '" text-anchor="' + anchor + '">' + escapeHtml(formatDateUtc8(buckets[rank].t)) + '</text>')
  }

  // ---- 持仓底纹（画在 K 线之前，避免盖住蜡烛）
  const bands = []
  for (let index = 0; index < count; index += 1) {
    if (buckets[index].hold !== true) continue
    const x = round2(frame.left + index * step)
    bands.push('<rect class="hold-band" x="' + x + '" y="' + frame.top
      + '" width="' + round2(Math.max(1, step)) + '" height="' + frame.plotHeight + '"/>')
  }

  // ---- 蜡烛（影线 + 实体）
  const wicks = []
  const bodies = []
  for (let index = 0; index < count; index += 1) {
    const bucket = buckets[index]
    const x = round2(xCenter(index))
    const up = bucket.c >= bucket.o
    const strokeClass = up ? 'wick-up' : 'wick-down'
    const fillClass = up ? 'candle-up' : 'candle-down'
    wicks.push('<line class="' + strokeClass + '" x1="' + x + '" y1="' + round2(yAt(bucket.h))
      + '" x2="' + x + '" y2="' + round2(yAt(bucket.l)) + '"/>')
    const top = round2(yAt(Math.max(bucket.o, bucket.c)))
    const bottom = round2(yAt(Math.min(bucket.o, bucket.c)))
    bodies.push('<rect class="' + fillClass + '" x="' + round2(x - bodyWidth / 2) + '" y="' + top
      + '" width="' + round2(bodyWidth) + '" height="' + round2(Math.max(1, bottom - top)) + '"/>')
  }

  // ---- 交易标记：把时间映射到聚合后的桶
  const bucketIndexAt = (time) => {
    if (!isNum(time)) return null
    if (time < buckets[0].t) return null
    let low = 0
    let high = count - 1
    let answer = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (buckets[middle].t <= time) {
        answer = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return answer
  }
  const trades = asArray(tradesInput)
  const markerTrades = trades.length > CHART_MAX_TRADE_MARKERS
    ? trades.slice(trades.length - CHART_MAX_TRADE_MARKERS)
    : trades
  const markers = []
  for (const trade of markerTrades) {
    if (!isPlainObject(trade)) continue
    const entryIndex = bucketIndexAt(trade.entryT)
    const exitIndex = bucketIndexAt(trade.exitT)
    const sideText = trade.side === 'short' ? '开空' : '开多'
    if (entryIndex !== null && isNum(trade.entryPrice)) {
      const x = round2(xCenter(entryIndex))
      const y = round2(yBounded(trade.entryPrice))
      const longEntry = trade.side !== 'short'
      // 多头开仓画在价格上方（▲），空头画在下方（▼），避免和蜡烛实体糊在一起
      const points = longEntry
        ? (round2(x - 5) + ',' + round2(y - 5) + ' ' + round2(x + 5) + ',' + round2(y - 5) + ' ' + x + ',' + round2(y - 13))
        : (round2(x - 5) + ',' + round2(y + 5) + ' ' + round2(x + 5) + ',' + round2(y + 5) + ' ' + x + ',' + round2(y + 13))
      const title = sideText + ' ' + formatTimeUtc8(trade.entryT) + ' @ ' + formatAmount(trade.entryPrice)
        + (isNum(trade.qty) ? ' · ' + formatAmount(trade.qty, 4) + ' BTC' : '')
      markers.push('<g><title>' + escapeHtml(title) + '</title><polygon class="' + (longEntry ? 'marker-long' : 'marker-short')
        + '" points="' + points + '"/></g>')
    }
    if (exitIndex !== null && isNum(trade.exitPrice)) {
      const x = round2(xCenter(exitIndex))
      const y = round2(yBounded(trade.exitPrice))
      const win = isNum(trade.pnl) ? trade.pnl >= 0 : true
      const title = '平仓 ' + formatTimeUtc8(trade.exitT) + ' @ ' + formatAmount(trade.exitPrice)
        + (isNum(trade.pnl) ? ' · 盈亏 ' + formatSignedAmount(trade.pnl) + ' USDT' : '')
      markers.push('<g><title>' + escapeHtml(title) + '</title><circle class="' + (win ? 'marker-win' : 'marker-loss')
        + '" cx="' + x + '" cy="' + y + '" r="3.2"/></g>')
    }
  }

  const noteParts = ['共 ' + formatCount(candles.length) + ' 根 K 线']
  if (bucketSize > 1) noteParts.push('每 ' + String(bucketSize) + ' 根聚合为 1 根（共 ' + String(count) + ' 根）')
  if (trades.length > markerTrades.length) {
    noteParts.push('交易标记只画最近 ' + String(markerTrades.length) + ' 笔（共 ' + String(trades.length) + ' 笔）')
  }
  const note = '<p class="muted">' + escapeHtml(noteParts.join(' · ')) + '</p>'

  const svg = '<svg class="chart" viewBox="0 0 ' + CHART.width + ' ' + CHART.height
    + '" role="img" aria-label="价格 K 线图（含持仓底纹与交易标记）">'
    + grid.join('')
    + ticks.join('')
    + bands.join('')
    + wicks.join('')
    + bodies.join('')
    + markers.join('')
    + '</svg>'
  const legend = '<div class="legend">'
    + '<span><i class="swatch candle-up"></i>阳线（收 ≥ 开）</span>'
    + '<span><i class="swatch candle-down"></i>阴线（收 &lt; 开）</span>'
    + '<span><i class="swatch hold"></i>持仓中</span>'
    + '<span><i class="swatch marker-long"></i>▲ 开多</span>'
    + '<span><i class="swatch marker-short"></i>▼ 开空</span>'
    + '<span><i class="swatch marker-long"></i>● 平仓（盈利）</span>'
    + '<span><i class="swatch marker-short"></i>● 平仓（亏损）</span>'
    + '</div>'
  return '<section class="card">' + heading + note + svg + legend + '</section>'
}

/** KPI 卡片：一行一眼看完核心指标。 */
function renderKpiSection(metrics) {
  const toneOf = (value) => (isNum(value) ? (value > 0 ? 'pos' : (value < 0 ? 'neg' : '')) : '')
  const cards = [
    ['期末权益', formatAmount(metrics.finalEquity) + ' USDT', ''],
    ['总收益', formatPercent(metrics.totalReturnPct, 2, true), toneOf(metrics.totalReturnPct)],
    ['年化收益', formatPercent(metrics.annualizedReturnPct, 2, true), toneOf(metrics.annualizedReturnPct)],
    ['最大回撤', formatPercent(metrics.maxDrawdownPct), isNum(metrics.maxDrawdownPct) && metrics.maxDrawdownPct > 0 ? 'neg' : ''],
    ['Sharpe', formatRatio(metrics.sharpe), toneOf(metrics.sharpe)],
    ['Sortino', formatRatio(metrics.sortino), toneOf(metrics.sortino)],
    ['Calmar', formatRatio(metrics.calmar), toneOf(metrics.calmar)],
    ['波动率', formatPercent(metrics.volatilityPct), ''],
    ['胜率', formatPercent(metrics.winRatePct), ''],
    ['盈亏比', formatPayoffRatio(metrics.payoffRatio, metrics), ''],
    ['交易次数', formatCount(metrics.tradeCount), ''],
    ['费用合计', formatAmount(metrics.feesTotal) + ' USDT', ''],
    ['资金费率净支出', formatSignedAmount(metrics.fundingTotal) + ' USDT',
      isNum(metrics.fundingTotal) && metrics.fundingTotal > 0 ? 'neg' : (isNum(metrics.fundingTotal) && metrics.fundingTotal < 0 ? 'pos' : '')],
    ['Buy & Hold 收益', formatPercent(metrics.buyHoldReturnPct, 2, true), toneOf(metrics.buyHoldReturnPct)],
    ['爆仓次数', formatCount(metrics.liquidations), isNum(metrics.liquidations) && metrics.liquidations > 0 ? 'neg' : ''],
  ]
  const html = cards.map(([label, value, tone]) => {
    const className = tone === '' ? 'kpi-value' : 'kpi-value ' + tone
    return '<div class="kpi"><div class="kpi-label">' + escapeHtml(label) + '</div>'
      + '<div class="' + className + '">' + escapeHtml(value) + '</div></div>'
  }).join('')
  return '<section class="kpis">' + html + '</section>'
}

/** 交易明细表（最多 500 行，截断时注明）。 */
function renderTradesSection(trades) {
  const heading = '<h2>交易明细</h2>'
  if (trades.length === 0) {
    return '<section class="card">' + heading + '<p class="muted">本期没有闭合交易。</p></section>'
  }
  const shown = trades.slice(0, MAX_HTML_TRADE_ROWS)
  const head = '<thead><tr><th>#</th><th>方向</th><th class="num">数量（BTC）</th>'
    + '<th>开仓时间</th><th class="num">开仓价</th><th>平仓时间</th><th class="num">平仓价</th>'
    + '<th class="num">盈亏（USDT）</th><th class="num">盈亏%</th><th class="num">手续费</th>'
    + '<th class="num">持仓K线</th><th>平仓原因</th></tr></thead>'
  const rows = shown.map((trade, index) => {
    const item = isPlainObject(trade) ? trade : {}
    const seq = isNum(item.seq) ? formatCount(item.seq) : String(index + 1)
    const side = item.side === 'short' ? '空' : (item.side === 'long' ? '多' : DASH)
    const cells = [
      ['', seq],
      ['', side],
      ['num', formatAmount(item.qty, 4)],
      ['', formatTimeUtc8(item.entryT)],
      ['num', formatAmount(item.entryPrice)],
      ['', formatTimeUtc8(item.exitT)],
      ['num', formatAmount(item.exitPrice)],
      ['num', formatSignedAmount(item.pnl)],
      ['num', formatPercent(item.pnlPct, 2, true)],
      ['num', formatAmount(item.fees)],
      ['num', formatCount(item.bars)],
      ['', item.exitReason === undefined || item.exitReason === null || item.exitReason === '' ? DASH : String(item.exitReason)],
    ]
    return '<tr class="trade-row">'
      + cells.map(([className, value]) => '<td' + (className === '' ? '' : ' class="' + className + '"') + '>'
        + escapeHtml(value) + '</td>').join('')
      + '</tr>'
  }).join('')
  const note = trades.length > shown.length
    ? '<p class="muted">共 ' + trades.length + ' 笔交易，页面仅展示前 ' + shown.length
      + ' 笔（完整明细见 JSON 报告与 CSV）。</p>'
    : '<p class="muted">共 ' + trades.length + ' 笔交易。</p>'
  return '<section class="card">' + heading + note
    + '<div class="table-wrap"><table>' + head + '<tbody>' + rows + '</tbody></table></div></section>'
}

function renderBenchmarkSection(metrics) {
  const excess = isNum(metrics.totalReturnPct) && isNum(metrics.buyHoldReturnPct)
    ? metrics.totalReturnPct - metrics.buyHoldReturnPct
    : null
  const rows = [
    ['策略总收益', formatPercent(metrics.totalReturnPct, 2, true)],
    ['Buy & Hold 收益', formatPercent(metrics.buyHoldReturnPct, 2, true)],
    ['超额收益（策略 − 基准）', formatPercent(excess, 2, true)],
    ['Buy & Hold 期末权益', formatAmount(metrics.buyHoldFinalEquity) + ' USDT'],
    ['Buy & Hold 最大回撤', formatPercent(metrics.buyHoldMaxDrawdownPct)],
  ]
  const body = rows.map(([label, value]) => '<tr><th>' + escapeHtml(label) + '</th><td class="num">'
    + escapeHtml(value) + '</td></tr>').join('')
  return '<section class="card"><h2>基准对比</h2>'
    + '<p class="muted">Buy &amp; Hold 基准按现货持有计算：首根 K 线收盘价买入、每根收盘价估值、'
    + '末根收盘价定终值，不扣手续费、不加杠杆，仅作参照。</p>'
    + '<div class="table-wrap"><table class="kv"><tbody>' + body + '</tbody></table></div></section>'
}

function renderFeesRiskSection(source, metrics) {
  const curve = asArray(source.equityCurve)
  const lastQty = curve.length > 0 && isNum(curve[curve.length - 1]?.qty)
    ? curve[curve.length - 1].qty
    : null
  const estimatedText = isNum(metrics.fundingEstimatedCount) && metrics.fundingEstimatedCount > 0
    ? '（其中估算 ' + formatCount(metrics.fundingEstimatedCount) + ' 次）'
    : ''
  const rows = [
    ['挂单手续费（maker）', formatAmount(metrics.feesMaker) + ' USDT'],
    ['吃单手续费（taker）', formatAmount(metrics.feesTaker) + ' USDT'],
    ['手续费合计', formatAmount(metrics.feesTotal) + ' USDT'],
    ['手续费占初始资金', formatPercent(metrics.feesPctOfCapital)],
    ['资金费率净支出', formatSignedAmount(metrics.fundingTotal) + ' USDT' + (metrics.fundingTotal < 0 ? '（净收入）' : '')],
    ['资金费率结算次数', formatCount(metrics.fundingCount) + ' 次' + estimatedText],
    ['总成本（手续费+资金费率）占初始资金',
      formatPercent(isNum(metrics.totalCostPctOfCapital) ? metrics.totalCostPctOfCapital : null)],
    ['成交笔数', formatCount(asArray(source.fills).length)],
    ['爆仓次数', formatCount(metrics.liquidations)],
    ['被拒委托数', formatCount(asArray(source.rejected).length)],
    ['期末持仓', lastQty === null ? DASH : formatAmount(lastQty, 6) + ' BTC'],
  ]
  const body = rows.map(([label, value]) => '<tr><th>' + label + '</th><td class="num">'
    + escapeHtml(value) + '</td></tr>').join('')
  return '<section class="card"><h2>费用与风险</h2>'
    + '<div class="table-wrap"><table class="kv"><tbody>' + body + '</tbody></table></div></section>'
}

function renderConfigSection(config, source, metrics, strategy) {
  const range = asObject(source.range)
  const params = strategy.params
  const paramsText = Object.keys(params).length === 0 ? '（无）' : JSON.stringify(params)
  const rows = [
    ['标的', typeof config.instId === 'string' && config.instId !== '' ? config.instId : DASH],
    ['K 线周期', typeof config.bar === 'string' && config.bar !== '' ? config.bar : DASH],
    ['策略', strategy.name],
    ['策略参数', paramsText],
    ['时间范围（配置）', formatTimeUtc8(config.start) + ' → ' + formatTimeUtc8(config.end)],
    ['实际覆盖', formatTimeUtc8(pickNum(metrics.firstT, range.firstT))
      + ' → ' + formatTimeUtc8(pickNum(metrics.lastT, range.lastT))],
    ['K 线根数', formatCount(metrics.bars)],
    ['回测天数', isNum(metrics.days) ? formatAmount(metrics.days, 2) + ' 天' : DASH],
    ['初始资金', formatAmount(pickNum(metrics.initialEquity, config.initialCapital)) + ' USDT'],
    ['杠杆', isNum(config.leverage) ? formatCount(config.leverage) + 'x' : DASH],
    ['挂单费率（maker）', formatFeeRate(config.makerFeeRate)],
    ['吃单费率（taker）', formatFeeRate(config.takerFeeRate)],
    ['市价滑点', isNum(config.slippageBps) ? formatAmount(config.slippageBps, 1) + ' bp' : DASH],
    ['维持保证金率', isNum(config.maintenanceMarginRate) ? formatPercent(config.maintenanceMarginRate * 100) : DASH],
    ['限价成交判定', typeof config.limitFill === 'string' ? config.limitFill : DASH],
    ['期末强制平仓', config.closeAtEnd === true ? '是' : (config.closeAtEnd === false ? '否' : DASH)],
    ['计入资金费率', config.includeFunding === false ? '否' : (config.includeFunding === true ? '是' : DASH)],
    ['估算资金费率（历史缺失时）',
      isNum(config.fundingRate) ? formatPercent(config.fundingRate * 100) + ' / 8h' : DASH],
  ]
  const body = rows.map(([label, value]) => '<tr><th>' + escapeHtml(label) + '</th><td>'
    + escapeHtml(value) + '</td></tr>').join('')
  return '<section class="card"><h2>回测配置</h2>'
    + '<p class="muted">时间均为 UTC+8；回测区间左闭右开。手续费率 0.0200% = 0.0002、'
    + '0.0500% = 0.0005，与 OKX BTC-USDT-SWAP 默认档位对应。资金费率每 8 小时结算一次，'
    + '多头付/空头收；OKX 公开历史只保留最近约 3 个月，更早区间按上面的估算费率计算。</p>'
    + '<div class="table-wrap"><table class="kv"><tbody>' + body + '</tbody></table></div></section>'
}

function renderLimitationsSection() {
  const items = [
    '资金费率（funding）：默认计入（每 8 小时结算，多头付/空头收，按当根收盘价近似标记价）。'
      + '历史费率来自 OKX 公开接口，只保留最近约 3 个月；超出部分按固定估算费率计算并在报告里标注次数，'
      + '因此长区间报告的资金费率是「历史 + 估算」的混合值，不是精确历史。',
    '不模拟盘口深度与部分成交：每张委托要么全成、要么全不成。',
    '非逐笔撮合：限价单按 K 线高低点判定是否成交，可能高估成交率。',
    '只支持单标的、单方向净持仓；不支持对冲模式与多仓位。',
    '滑点只支持固定 bps 的市价滑点，不含成交冲击与滑点分布模型。',
    '爆仓判定为近似公式（忽略手续费与资金费）；1 倍杠杆下多头爆仓价接近 0，空头在 2 倍价格附近。',
    '策略参数未做寻优，样本内结果不代表样本外表现。',
    'Buy &amp; Hold 基准为现货持有（不计手续费、不加杠杆），仅作参照。',
    '期末强制平仓（若开启）按最后一根收盘价以 taker 费率平仓，因此最终权益可能含一笔平仓成本。',
    '数值口径面向策略研究，不是清结算级精度；本报告不构成任何投资建议。',
  ]
  return '<section class="card"><h2>局限说明</h2><ul class="limits">'
    + items.map((item) => '<li>' + item + '</li>').join('')
    + '</ul></section>'
}

/**
 * 自包含 HTML 报告（SPEC §8）：内联 CSS + 内联 SVG，不引任何外部资源，离线可直接打开。
 * 所有来自数据的文本都经过 HTML 转义（策略名/平仓原因/参数里可能有任意字符）。
 */
export function buildHtmlReport({ result, metrics, config, strategy, generatedAt, bars } = {}) {
  const source = asObject(result)
  const cfg = resolveConfig(config, source)
  const m = resolveMetrics(metrics, source)
  const strat = resolveStrategy(source, strategy)
  const at = resolveGeneratedAt(generatedAt)
  const curve = asArray(source.equityCurve)
  const trades = asArray(source.trades)
  const barList = asArray(bars)

  const instId = typeof cfg.instId === 'string' && cfg.instId !== '' ? cfg.instId : DASH
  const barText = typeof cfg.bar === 'string' && cfg.bar !== '' ? cfg.bar : DASH
  const title = instId + ' 永续合约回测报告'

  const subtitleParts = [
    escapeHtml(instId),
    '周期 ' + escapeHtml(barText),
    '策略 ' + escapeHtml(strat.name),
    formatTimeUtc8(cfg.start) + ' → ' + formatTimeUtc8(cfg.end),
    isNum(cfg.leverage) ? '杠杆 ' + formatCount(cfg.leverage) + 'x' : '杠杆 ' + DASH,
    'maker ' + formatFeeRate(cfg.makerFeeRate) + ' / taker ' + formatFeeRate(cfg.takerFeeRate),
  ]
  const warnings = asArray(cfg.warnings).filter((item) => typeof item === 'string' && item !== '')

  const head = '<!DOCTYPE html>'
    + '\n<html lang="zh-CN">'
    + '\n<head>'
    + '\n<meta charset="utf-8">'
    + '\n<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '\n<title>' + escapeHtml(title) + '</title>'
    + '\n<style>\n' + HTML_CSS + '\n</style>'
    + '\n</head>'
    + '\n<body>'

  const hero = '<header class="hero">'
    + '\n<h1>' + escapeHtml(title) + '</h1>'
    + '\n<p class="sub">' + subtitleParts.join(' · ') + '</p>'
    + '\n<p class="meta">生成时间：' + formatTimeUtc8(at) + ' · 框架：' + FRAMEWORK
    + ' · K 线 ' + formatCount(m.bars) + ' 根 / ' + (isNum(m.days) ? formatAmount(m.days, 2) + ' 天' : DASH)
    + ' · 初始资金 ' + formatAmount(pickNum(m.initialEquity, cfg.initialCapital)) + ' USDT</p>'
    + (warnings.length > 0
      ? '\n<p class="warn">配置警告：' + escapeHtml(warnings.join('；')) + '</p>'
      : '')
    + '\n</header>'

  const main = '<main>'
    + '\n' + renderKpiSection(m)
    + '\n' + renderCandleSection(barList, curve, trades)
    + '\n' + renderEquitySection(curve, m)
    + '\n' + renderDrawdownSection(curve)
    + '\n' + renderTradesSection(trades)
    + '\n' + renderBenchmarkSection(m)
    + '\n' + renderFeesRiskSection(source, m)
    + '\n' + renderConfigSection(cfg, source, m, strat)
    + '\n' + renderLimitationsSection()
    + '\n</main>'

  const footer = '<footer class="foot">本报告为离线自包含文件：不加载任何外部资源、不需要 JavaScript'
    + '（用浏览器直接打开或分享给他人均可）。生成框架：' + FRAMEWORK
    + ' · 报告格式 v3（含价格 K 线、资金费率与交易标记）'
    + '。若看不到 K 线图或资金费率，说明生成该报告的宿主还在跑旧版本，需要重启宿主后重新回测。</footer>'

  return head + '\n' + hero + '\n' + main + '\n' + footer + '\n</body>\n</html>\n'
}

// ───────────────────────────── CSV 报告 ─────────────────────────────

/** UTC ISO（秒级，SPEC §8 示例 `2024-01-01T00:00:00Z`，不带毫秒）。 */
function toUtcIso(ms) {
  if (!isNum(ms)) return ''
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** CSV 单元格：含逗号/引号/换行时按 RFC 4180 加引号转义。 */
function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
  return text
}

/** 交易明细 CSV（SPEC §8 表头固定英文，时间用 UTC ISO，便于 Excel / pandas 读）。 */
function buildCsv(result) {
  const trades = asArray(asObject(result).trades)
  const header = 'seq,side,qty,entry_t,entry_price,exit_t,exit_price,pnl,pnl_pct,fees,bars,exit_reason'
  const lines = [header]
  for (const trade of trades) {
    const item = asObject(trade)
    lines.push([
      csvCell(item.seq),
      csvCell(item.side),
      csvCell(item.qty),
      csvCell(toUtcIso(item.entryT)),
      csvCell(item.entryPrice),
      csvCell(toUtcIso(item.exitT)),
      csvCell(item.exitPrice),
      csvCell(item.pnl),
      csvCell(item.pnlPct),
      csvCell(item.fees),
      csvCell(item.bars),
      csvCell(item.exitReason),
    ].join(','))
  }
  return lines.join('\n') + '\n'
}

// ───────────────────────────── 落盘 ─────────────────────────────

/** 文件名片段：去掉 Windows 不允许的字符，避免策略名/标的名把路径搞坏。 */
function safeFilePart(value) {
  const text = String(value === null || value === undefined ? '' : value).trim()
  const cleaned = text.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 64)
  return cleaned === '' ? 'unknown' : cleaned
}

function dateStamp(ms) {
  if (!isNum(ms)) return 'unknown'
  return formatDateUtc8(ms).replace(/-/g, '')
}

/** `<instId>-<bar>-<strategy>-<起始YYYYMMDD>-<结束YYYYMMDD>`（SPEC §5.6）。 */
function reportBaseName(config, source, strategy) {
  const range = asObject(source.range)
  const instId = safeFilePart(config.instId ?? 'backtest')
  const bar = safeFilePart(config.bar ?? 'bar')
  const start = pickNum(config.start, range.start)
  const end = pickNum(config.end, range.end)
  return [instId, bar, safeFilePart(strategy.name), dateStamp(start), dateStamp(end)].join('-')
}

/**
 * 写报告三件套（SPEC §5.6）：`<outDir>/<...>.json|.html|.csv`，自动 mkdir -p。
 * JSON / HTML 共用同一个 generatedAt，保证两份报告是“同一次生成”。
 *
 * @returns {Promise<{jsonPath: string, htmlPath: string, csvPath: string}>}
 */
export async function writeReports({ result, metrics, config, strategy, outDir, bars } = {}) {
  const source = asObject(result)
  const cfg = resolveConfig(config, source)
  const strat = resolveStrategy(source, strategy)
  const m = resolveMetrics(metrics, source)
  const generatedAt = Date.now()

  const jsonReport = buildJsonReport({
    result: source,
    metrics: m,
    config: cfg,
    strategy: strat,
    generatedAt,
  })
  const html = buildHtmlReport({
    result: source,
    metrics: m,
    config: cfg,
    strategy: strat,
    generatedAt,
    bars: bars,
  })
  const csv = buildCsv(source)

  const directory = resolve(String(outDir ?? cfg.outDir ?? DEFAULT_OUT_DIR))
  const baseName = reportBaseName(cfg, source, strat)
  const jsonPath = join(directory, baseName + '.json')
  const htmlPath = join(directory, baseName + '.html')
  const csvPath = join(directory, baseName + '.csv')

  await mkdir(directory, { recursive: true })
  await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2) + '\n', 'utf8')
  await writeFile(htmlPath, html, 'utf8')
  await writeFile(csvPath, csv, 'utf8')

  return { jsonPath, htmlPath, csvPath }
}
