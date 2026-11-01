/**
 * 回测框架的公共配置：默认参数、K 线周期表、时间范围解析、配置校验。
 *
 * 这里是**契约的一半**（另一半是 `backtest/SPEC.md`）：engine / data / metrics / report
 * 都只从这里拿默认值和时间格式化，避免各写一套口径。
 *
 * 几个刻意的决定：
 *   1. 用户输入的裸日期（`2024-01-01`、`2024-01-01 08:00`）按**北京时间 UTC+8** 解释。
 *      交易所 K 线是 UTC 对齐的，但人是按北京时间说日期的；内部统一转成 UTC 毫秒，
 *      报告再转回 UTC+8 显示，两头都按用户的直觉来。
 *   2. 时间范围是左闭右开 `[start, end)`。`end` 超过"现在"会被夹到 now（并给 warning），
 *      因为还没走完的 K 线不能当历史数据用。
 *   3. 手续费接受两种写法：`0.0002` 与 `0.0200%`（用户原话就是百分比）。
 *   4. 所有非法输入都抛中文 Error —— CLI 捕获后打一行人话，不需要 stack。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 回测框架根目录（`backtest/`），数据缓存与报告目录都从它推导。 */
export const BACKTEST_DIR = resolve(HERE, '..')

/** K 线周期表。`okx` 是 OKX 接口里的写法（注意 1h→1H、1d→1D），`ms` 是一根的时长。 */
export const TIMEFRAMES = Object.freeze([
  { id: '1m', okx: '1m', ms: 60_000, label: '1m' },
  { id: '3m', okx: '3m', ms: 180_000, label: '3m' },
  { id: '5m', okx: '5m', ms: 300_000, label: '5m' },
  { id: '15m', okx: '15m', ms: 900_000, label: '15m' },
  { id: '1h', okx: '1H', ms: 3_600_000, label: '1h' },
  { id: '4h', okx: '4H', ms: 14_400_000, label: '4h' },
  { id: '1D', okx: '1D', ms: 86_400_000, label: '1D' },
])

/** 默认标的：OKX 的 USDT 本位 BTC 永续。 */
export const DEFAULT_INSTID = 'BTC-USDT-SWAP'
/** 默认周期：1 小时。1m 数据量太大，默认给个一年只有 8760 根的量级。 */
export const DEFAULT_BAR = '1h'
/** 默认杠杆：用户要求 1 倍。 */
export const DEFAULT_LEVERAGE = 1
/** 默认初始资金（USDT）。 */
export const DEFAULT_CAPITAL = 10_000
/** 挂单手续费 0.0200%（用户给的数字）。 */
export const DEFAULT_MAKER_FEE_RATE = 0.0002
/** 吃单手续费 0.0500%（用户给的数字）。 */
export const DEFAULT_TAKER_FEE_RATE = 0.0005
/** 维持保证金率近似值（OKX BTC 永续当前档位约 0.4%–0.5%，回测用它判爆仓）。 */
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005
/** 默认回测最近 30 天。 */
export const DEFAULT_RANGE_DAYS = 30

/**
 * 资金费率（funding）口径：
 *   - 永续合约每 8 小时结算一次，费率为正时多头付、空头收；
 *   - OKX 公开的 funding 历史只保留最近约 3 个月，超出部分无法精确回放，
 *     默认用 DEFAULT_FUNDING_RATE（0.01%/8h）估算，报告里会明确标注「含估算」；
 *   - `includeFunding: false` 可完全关闭（与加这个功能之前的行为一致）。
 */
export const FUNDING_INTERVAL_MS = 8 * 3_600_000
/** 估算用资金费率：8 小时 0.01%（BTC 永续长期均值附近，不是精确历史）。 */
export const DEFAULT_FUNDING_RATE = 0.0001

export const DEFAULT_DATA_DIR = join(BACKTEST_DIR, 'data')
export const DEFAULT_OUT_DIR = join(BACKTEST_DIR, 'reports')

const BEIJING_OFFSET = '+08:00'
const RELATIVE_RE = /^now(?:\s*([+-])\s*(\d+(?:\.\d+)?)\s*([dhmw]))?$/i
const UNIT_MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** 未知周期抛错（别悄悄回退到默认值 —— 那样用户以为在回测 1h，其实在跑别的）。 */
export function barById(id) {
  const found = TIMEFRAMES.find((item) => item.id === id)
  if (found === undefined) {
    throw new Error('不支持的 K 线周期：' + String(id) + '（可选：' + TIMEFRAMES.map((item) => item.id).join(' / ') + '）')
  }
  return found
}

export function isBarId(id) {
  return TIMEFRAMES.some((item) => item.id === id)
}

/** 毫秒时间戳 → `YYYY-MM-DD HH:mm UTC+8`。非法值给 `—`，不抛错（报告里出现 undefined 很常见）。 */
export function formatTimeUtc8(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  // 直接加 8 小时再用 UTC getter：不依赖本机时区，也不依赖 ICU 的 timeZone 支持。
  const d = new Date(n + 8 * 3_600_000)
  const pad = (value) => String(value).padStart(2, '0')
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
    + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC+8'
}

/** 毫秒时间戳 → `YYYY-MM-DD UTC+8`。 */
export function formatDateUtc8(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  const d = new Date(n + 8 * 3_600_000)
  const pad = (value) => String(value).padStart(2, '0')
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
}

/** 语义别名：报告里两种叫法混着用，统一指到同一个实现，避免一个是 UTC 一个是本地。 */
export const formatDateTimeUtc8 = formatTimeUtc8

/** 手续费率 → `0.0200%` 这种展示串（报告/CLI 共用）。 */
export function formatFeeRate(rate) {
  const n = Number(rate)
  if (!Number.isFinite(n)) return '—'
  return (n * 100).toFixed(4) + '%'
}

/**
 * 解析单个时间输入（不处理默认值）：毫秒数、`YYYY-MM-DD`、`YYYY-MM-DD HH:mm[:ss]`、
 * ISO（带 Z/偏移）、`now`、`now-30d` / `now-12h` / `now-4w`。解析不了抛中文 Error。
 * 返回的永远是 UTC 毫秒。
 */
export function parseTimeInput(raw, label = '时间', now = Date.now()) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error(label + '不是合法数字：' + String(raw))
    return raw
  }
  const text = String(raw).trim()
  if (text === '') return null

  const relative = RELATIVE_RE.exec(text)
  if (relative !== null) {
    if (relative[1] === undefined) return now
    const sign = relative[1] === '-' ? -1 : 1
    const amount = Number(relative[2])
    const unit = relative[3].toLowerCase()
    return now + sign * amount * UNIT_MS[unit]
  }

  // 纯数字且够长才当毫秒时间戳（避免把 "2024" 这种年份误当时间戳）
  if (/^\d+$/.test(text) && text.length >= 12) return Number(text)

  const bareDateTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/
  const bareDate = /^\d{4}-\d{2}-\d{2}$/
  let iso = text
  if (bareDate.test(iso)) {
    iso = iso + 'T00:00:00' + BEIJING_OFFSET
  } else if (bareDateTime.test(iso)) {
    iso = iso.replace(' ', 'T') + BEIJING_OFFSET
  }
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    throw new Error(label + ' 无法解析：' + JSON.stringify(String(raw))
      + '（支持 2024-01-01、2024-01-01 08:00、ISO、now、now-30d）')
  }
  return ms
}

/**
 * 解析回测时间范围，返回 `{ start, end, warnings }`（毫秒 UTC，左闭右开）。
 * 默认：`end = now`，`start = end - 30 天`。
 */
export function parseRange(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const warnings = []
  let end = parseTimeInput(options.end, '结束时间', now)
  if (end === null) end = now
  if (end > now) {
    warnings.push('结束时间晚于当前时间，已夹到 now（未走完的 K 线不能当历史数据）')
    end = now
  }
  let start = parseTimeInput(options.start, '开始时间', now)
  if (start === null) start = end - DEFAULT_RANGE_DAYS * 86_400_000
  if (start >= end) {
    throw new Error('开始时间必须早于结束时间（start=' + formatTimeUtc8(start) + '，end=' + formatTimeUtc8(end) + '）')
  }
  return { start, end, warnings }
}

/** 数值型配置：接受 number 或数字字符串；非法值抛错。 */
function readNumber(raw, label, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value)) throw new Error(label + '不是合法数字：' + JSON.stringify(String(raw)))
  return value
}

/** 费率：接受 `0.0002`、`0.02%`、`0.0200%`；范围 0–5%。 */
export function parseFeeRate(raw, label, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  let value
  if (typeof raw === 'number') {
    value = raw
  } else {
    const text = String(raw).trim()
    if (text.endsWith('%')) value = Number(text.slice(0, -1)) / 100
    else value = Number(text)
  }
  if (!Number.isFinite(value)) throw new Error(label + '不是合法费率：' + JSON.stringify(String(raw)) + '（例：0.0002 或 0.02%）')
  if (value < 0 || value > 0.05) throw new Error(label + '超出合理范围（0–5%）：' + String(value))
  return value
}

/** 布尔型配置：接受 true/false 与 'true'/'false'/'1'/'0'。 */
function readBoolean(raw, label, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  const text = String(raw).trim().toLowerCase()
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0') return false
  throw new Error(label + '只能是 true/false：' + JSON.stringify(String(raw)))
}

const LIMIT_FILL_MODES = ['tradeThrough', 'touch']

/**
 * 校验并补全配置。非法输入抛中文 Error；能继续跑但值得提醒的放 `config.warnings`。
 * 返回值是纯对象，engine/data/report 都按 SPEC §4 的字段消费。
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('回测配置必须是对象')
  }
  const now = readNumber(raw.now, 'now', Date.now())
  const warnings = []

  const range = parseRange({ start: raw.start, end: raw.end, now })
  warnings.push(...range.warnings)

  const bar = raw.bar === undefined || raw.bar === '' ? DEFAULT_BAR : String(raw.bar)
  if (!isBarId(bar)) barById(bar) // 抛错并带上可选列表
  const barMs = barById(bar).ms
  const span = range.end - range.start
  if (span < barMs) {
    throw new Error('时间范围不足一根 K 线（' + bar + ' = ' + String(barMs / 1000) + ' 秒）')
  }
  if (span < 3 * barMs) warnings.push('时间范围不足 3 根 K 线，绩效指标参考意义有限')

  const instId = raw.instId === undefined || raw.instId === '' ? DEFAULT_INSTID : String(raw.instId).trim()
  if (!/^[A-Za-z0-9-]{4,32}$/.test(instId)) {
    throw new Error('标的代码不合法（只允许字母/数字/短横线）：' + JSON.stringify(instId))
  }

  const initialCapital = readNumber(raw.initialCapital, '初始资金', DEFAULT_CAPITAL)
  if (!(initialCapital > 0)) throw new Error('初始资金必须大于 0，收到：' + String(initialCapital))
  if (initialCapital > 1e12) throw new Error('初始资金过大：' + String(initialCapital))

  const leverage = readNumber(raw.leverage, '杠杆', DEFAULT_LEVERAGE)
  if (!(leverage >= 1 && leverage <= 100)) throw new Error('杠杆必须在 1–100 倍之间，收到：' + String(leverage))

  const makerFeeRate = parseFeeRate(raw.makerFeeRate, '挂单手续费率', DEFAULT_MAKER_FEE_RATE)
  const takerFeeRate = parseFeeRate(raw.takerFeeRate, '吃单手续费率', DEFAULT_TAKER_FEE_RATE)
  if (takerFeeRate < makerFeeRate) warnings.push('吃单费率低于挂单费率，请确认输入是否写反')

  const slippageBps = readNumber(raw.slippageBps, '滑点', 0)
  if (slippageBps < 0 || slippageBps > 1000) throw new Error('滑点必须在 0–1000 基点之间，收到：' + String(slippageBps))

  const maintenanceMarginRate = readNumber(raw.maintenanceMarginRate, '维持保证金率', DEFAULT_MAINTENANCE_MARGIN_RATE)
  if (maintenanceMarginRate < 0 || maintenanceMarginRate > 0.5) {
    throw new Error('维持保证金率必须在 0–50% 之间，收到：' + String(maintenanceMarginRate))
  }

  const limitFill = raw.limitFill === undefined || raw.limitFill === '' ? 'tradeThrough' : String(raw.limitFill)
  if (!LIMIT_FILL_MODES.includes(limitFill)) {
    throw new Error('限价成交判定只能是 ' + LIMIT_FILL_MODES.join(' / ') + '，收到：' + JSON.stringify(limitFill))
  }

  const closeAtEnd = readBoolean(raw.closeAtEnd, '期末平仓', true)
  const includeFunding = readBoolean(raw.includeFunding, '计入资金费率', true)
  // 资金费率是「每 8 小时一次」的费率，接受 0.0001 / 0.01% 两种写法（parseFeeRate 的上限正好 5%）
  const fundingRate = parseFeeRate(raw.fundingRate, '资金费率（估算用）', DEFAULT_FUNDING_RATE)

  const dataDir = raw.dataDir === undefined || raw.dataDir === '' ? DEFAULT_DATA_DIR : resolve(String(raw.dataDir))
  const outDir = raw.outDir === undefined || raw.outDir === '' ? DEFAULT_OUT_DIR : resolve(String(raw.outDir))

  return {
    instId,
    bar,
    start: range.start,
    end: range.end,
    initialCapital,
    leverage,
    makerFeeRate,
    takerFeeRate,
    slippageBps,
    maintenanceMarginRate,
    limitFill,
    closeAtEnd,
    includeFunding,
    fundingRate,
    dataDir,
    outDir,
    now,
    warnings,
  }
}
