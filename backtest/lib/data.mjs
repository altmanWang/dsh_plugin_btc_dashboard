/**
 * OKX 历史 K 线的本地缓存与缺口填补（回测的数据层）。
 *
 * 设计要点（为什么这么写）：
 *   1. **缓存是一等公民**：同一段回测跑第二次绝不该再联网。缓存文件按
 *      `<dataDir>/<instId>/<bar>.json` 存放，内部用 `segments`（已完整覆盖的区间列表）
 *      判断「这段到底有没有」，而不是用「第一根/最后一根」去猜 —— 因为中间可能有缺口。
 *   2. **只缓存已收盘 K 线**：`t + barMs <= now` 且接口 `confirm === '1'`。
 *      正在走的那根每刷新一次变一次，混进缓存会污染回测。
 *      「已收盘边界」取 `floor(now / barMs) * barMs`：任何已收盘 K 线的 t 都严格小于它，
 *      而它之后的 K 线一定还没收盘。这样**不依赖交易所按什么时区/网格对齐 K 线**
 *      （不同周期、不同交易所的日线开盘点是历史遗留问题，不能硬编码假设），
 *      同时保证缓存覆盖区间稳定 —— 同一根 K 线内第二次运行（尤其 offline）不会误报缺口。
 *   3. **按缺口从 `after` 往回翻页**：OKX history-candles 的 `after` 是「返回严格早于
 *      after 的 K 线、最新在前、单页最多 100 根」。所以一个缺口从它的右端（不含）开始，
 *      用当前页最小时间戳当下一页的 after，直到盖住缺口左端。
 *   4. **交易所历史有下限**（比如 1H 只能回到 2019 年底附近）。往回翻到空页时说明
 *      「没有更早的数据了」，把最早一根的时间戳写进缓存的 `earliestKnown`：
 *      之后请求更早区间时直接按已知下界处理，不再每次重试同一段空区间。
 *   5. **原子写**：先写 `.tmp` 再 rename，避免进程中途被杀留下半个 JSON，
 *      下次启动读到损坏缓存。写缓存失败只 warning，不能影响本次已抓到的数据。
 *
 * 缓存文件结构（`earliestKnown` 是对 SPEC §5.3 的**附加字段**，用于记录历史深度下界）：
 *   { version: 1, instId, bar, updatedAt, earliestKnown, segments: [[from,to),...],
 *     bars: [[t,o,h,l,c,v],...] }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  barById,
  DEFAULT_DATA_DIR,
  DEFAULT_FUNDING_RATE,
  DEFAULT_INSTID,
  formatTimeUtc8,
  FUNDING_INTERVAL_MS,
} from './config.mjs'
import { createOkxFetcher } from './transport.mjs'

const CACHE_VERSION = 1
/** 单页上限：history-candles 最多 100 根（300 是另一个接口 /market/candles 的上限）。 */
const PAGE_LIMIT = 100
const DEFAULT_MAX_PAGES = 2_000

function describe(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** 宽松数字：只把真正是有限数字的转出来，其余给 null（不要让 NaN 混进缓存）。 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function rangeText(from, to) {
  return formatTimeUtc8(from) + ' ~ ' + formatTimeUtc8(to)
}

/** log 回调是外部传入的，它自己抛错不该毁掉一次几千页的抓取。 */
function logLine(log, message) {
  if (log === null) return
  try {
    log(message)
  } catch (error) {
    // 忽略日志回调的异常
  }
}

// ------------------------------------------------------------------ K 线归一化

/**
 * 把一行 K 线（数组或对象）归一成 Bar；非法返回 null。
 * 支持数组 `[t,o,h,l,c,v,...confirm]` 与对象 `{t,o,h,l,c,v,confirm?}` 两种输入，
 * 因为测试注入的假 fetcher、`readBarFile` 的三种 JSON 形状都往这里汇。
 * `confirm` 只在输入里有的时候才带上（'1' 已收盘 / '0' 未收盘）。
 */
function normalizeBar(raw) {
  let t, o, h, l, c, v, confirm
  if (Array.isArray(raw)) {
    if (raw.length < 6) return null
    t = toNumber(raw[0])
    o = toNumber(raw[1])
    h = toNumber(raw[2])
    l = toNumber(raw[3])
    c = toNumber(raw[4])
    v = toNumber(raw[5])
    confirm = raw[8]
  } else if (raw !== null && typeof raw === 'object') {
    t = toNumber(raw.t)
    o = toNumber(raw.o)
    h = toNumber(raw.h)
    l = toNumber(raw.l)
    c = toNumber(raw.c)
    v = toNumber(raw.v)
    confirm = raw.confirm
    if (confirm === undefined && raw.done !== undefined) confirm = raw.done === true ? '1' : '0'
  } else {
    return null
  }
  if (t === null || o === null || h === null || l === null || c === null) return null
  // 价格必须是正数、high 不能低于 low：明显是脏数据，丢掉而不是让引擎算出负权益。
  if (t < 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) return null
  const bar = { t, o, h, l, c, v: v === null || v < 0 ? 0 : v }
  if (confirm !== undefined && confirm !== null && confirm !== '') {
    bar.confirm = typeof confirm === 'boolean' ? (confirm ? '1' : '0') : String(confirm)
  }
  return bar
}

/** 剥掉 `confirm` 等附加字段：缓存里只存 SPEC §4 的 6 字段 Bar。 */
function plainBar(bar) {
  return { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }
}

/**
 * 是否已收盘：时间上 `t + barMs <= now`，并且（接口给了 confirm 时）confirm 必须是 '1'。
 * 只靠时间不够 —— 测试/未来接口可能给出时间已过但 confirm='0' 的奇怪行，宁可多丢。
 */
function isClosedBar(bar, barMs, now) {
  if (!Number.isFinite(bar.t) || bar.t + barMs > now) return false
  if (bar.confirm !== undefined) return bar.confirm === '1'
  return true
}

// ------------------------------------------------------------------ 区间运算

/** 合并相邻/重叠区间。相邻判断用 `next.from <= last.to`：时间戳是整数毫秒，相邻即相等。 */
function mergeSegments(segments) {
  const sorted = segments
    .filter((seg) => Array.isArray(seg) && seg.length >= 2)
    .map((seg) => [toNumber(seg[0]), toNumber(seg[1])])
    .filter(([from, to]) => from !== null && to !== null && to > from)
    .sort((a, b) => a[0] - b[0])
  const out = []
  for (const [from, to] of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && from <= last[1]) {
      if (to > last[1]) last[1] = to
    } else {
      out.push([from, to])
    }
  }
  return out
}

/** `range` 减去已覆盖区间，返回还没覆盖的缺口（升序、左闭右开）。 */
function subtractSegments(range, segments) {
  const [rangeFrom, rangeTo] = range
  const gaps = []
  let cursor = rangeFrom
  for (const [from, to] of mergeSegments(segments)) {
    if (to <= cursor) continue
    if (from >= rangeTo) break
    if (from > cursor) gaps.push([cursor, Math.min(from, rangeTo)])
    cursor = Math.max(cursor, to)
    if (cursor >= rangeTo) break
  }
  if (cursor < rangeTo) gaps.push([cursor, rangeTo])
  return gaps
}

/** 从缓存 K 线反推覆盖区间：相邻两根时间差正好一个周期就算连续。 */
function deriveSegments(bars, barMs) {
  const list = Array.from(bars.values()).sort((a, b) => a.t - b.t)
  const segments = []
  for (const bar of list) {
    const last = segments[segments.length - 1]
    if (last !== undefined && bar.t === last[1]) last[1] = bar.t + barMs
    else segments.push([bar.t, bar.t + barMs])
  }
  return segments
}

/** 从 `{bars: [...]}` / 裸数组里取出 K 线行数组；形状不认识返回 null。 */
function extractBarRows(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.bars)) return parsed.bars
  return null
}

// ------------------------------------------------------------------ 缓存读写

/**
 * 读缓存（文件不存在/损坏/版本不符都**不抛**：回测不该被一个坏缓存卡死）。
 * 返回内存结构：`{ bars: Map<t, Bar>, segments, earliestKnown, dirty }`。
 */
function readCacheFile(file, instId, barId, barMs, now, warnings) {
  const state = { bars: new Map(), segments: [], earliestKnown: null, dirty: false }
  if (!existsSync(file)) return state

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    warnings.push('读取缓存文件失败，已忽略（本次会重新抓取）：' + describe(error))
    return state
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    warnings.push('缓存文件不是合法 JSON，已忽略（本次会重新抓取）：' + file)
    return state
  }

  const wrapped = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  if (wrapped) {
    const version = parsed.version
    if (version !== undefined && version !== CACHE_VERSION) {
      warnings.push('缓存文件版本不支持（v' + String(version) + '），已忽略：' + file)
      return state
    }
    if (parsed.instId !== undefined && parsed.instId !== instId) {
      warnings.push('缓存文件标的不匹配（可能是路径被复用），已忽略：' + file)
      return state
    }
    if (parsed.bar !== undefined && parsed.bar !== barId) {
      warnings.push('缓存文件周期不匹配（可能是路径被复用），已忽略：' + file)
      return state
    }
  }

  const rawRows = extractBarRows(parsed)
  if (rawRows === null) {
    warnings.push('缓存文件格式不支持，已忽略：' + file)
    return state
  }
  for (const rawRow of rawRows) {
    const bar = normalizeBar(rawRow)
    if (bar === null) continue // 非法行直接丢
    if (!isClosedBar(bar, barMs, now)) continue // 只保留已收盘（防旧版本把未收盘写进来）
    state.bars.set(bar.t, plainBar(bar)) // 同 t 去重：后写入的为准（与接口「近端更新」一致）
  }

  let segments = []
  if (wrapped && Array.isArray(parsed.segments)) {
    for (const seg of parsed.segments) {
      if (!Array.isArray(seg) || seg.length < 2) continue
      const from = toNumber(seg[0])
      const to = toNumber(seg[1])
      if (from !== null && to !== null && to > from) segments.push([from, to])
    }
  }
  // 老缓存没有 segments 时，用 K 线自身反推，避免「有数据却每次重抓」。
  if (segments.length === 0 && state.bars.size > 0) segments = deriveSegments(state.bars, barMs)
  // 覆盖区间不能越过「已收盘边界」，否则会把正在走的那根 K 线当成已覆盖。
  // 用 floor(now / barMs) * barMs 而不是 now - barMs + 1：后者会随分钟漂移，
  // 导致同一根 K 线内第二次运行（尤其是 offline）误报缺口。数学上这也是安全的：
  // 任何已收盘 K 线满足 t <= now - barMs < floor(now/barMs)*barMs，必在边界之前；
  // 而 t >= 边界的 K 线一定还没收盘（t + barMs > now）。不依赖交易所的时间对齐方式。
  const closedBoundary = Math.floor(now / barMs) * barMs
  state.segments = mergeSegments(segments.map(([from, to]) => [from, Math.min(to, closedBoundary)]))
  if (wrapped) {
    const earliest = toNumber(parsed.earliestKnown)
    if (earliest !== null) state.earliestKnown = earliest
  }
  return state
}

/**
 * 原子写缓存：先写 `.tmp` 再 rename。
 * 写失败只 warning —— 数据已经抓到了，不能因为磁盘问题让整次回测失败。
 */
function writeCacheFile(file, cache, instId, barId, warnings) {
  const tmp = file + '.' + String(process.pid) + '.' + String(Date.now()) + '.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    const payload = {
      version: CACHE_VERSION,
      instId,
      bar: barId,
      updatedAt: Date.now(),
      earliestKnown: cache.earliestKnown,
      segments: cache.segments.map(([from, to]) => [from, to]),
      bars: Array.from(cache.bars.values())
        .sort((a, b) => a.t - b.t)
        .map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v]),
    }
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (error) {
    warnings.push('缓存写入失败（不影响本次回测，下次会重新抓取）：' + describe(error))
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch (cleanupError) {
      // 临时文件删不掉也无所谓，下次 rename 会覆盖
    }
    return false
  }
}

/** 取出请求区间内的已收盘 K 线（升序、副本）。 */
function collectBars(cache, start, end, now, barMs) {
  const bars = []
  for (const bar of cache.bars.values()) {
    if (bar.t < start || bar.t >= end) continue
    if (bar.t + barMs > now) continue // 双保险：只收录已收盘
    bars.push({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v })
  }
  bars.sort((a, b) => a.t - b.t)
  return bars
}

function coverageOf(bars, barMs) {
  if (bars.length === 0) return null
  return { from: bars[0].t, to: bars[bars.length - 1].t + barMs }
}

// ------------------------------------------------------------------ 缺口抓取

/**
 * 逐缺口从右往左翻页（fetchPage 一次一页），把数据写进 cache。
 * 返回最后一次网络/接口错误（中文）或 null；任何异常都在内部折成错误字符串。
 *
 * 关键细节：
 *   - `after = gap[1]`（缺口右端，不含）：OKX 返回 ts < after 的数据；
 *   - 每页最小时间戳当下一页的 after，直到盖住 gap[0]；
 *   - 页可能跨过缺口左端，多出来的更早 K 线也收进缓存（下次区间更宽时直接命中），
 *     覆盖区间从「实际抓到的最早一根」记到缺口右端；
 *   - **空页 = 交易所没有更早数据**，记下 `earliestKnown`（历史深度下界）；
 *   - 中途失败也把已经连续抓到的部分记进 segments，下次不用重抓；
 *   - 每页都调一次 log，长跑时能看到进度。
 */
async function fillGaps({ fetcher, gaps, cache, instId, okxBar, barId, barMs, now, maxPages, warnings, log, result }) {
  /** 最后一次网络/接口错误（中文）；null 表示没出错。 */
  let lastError = null

  for (const gap of gaps) {
    if (result.fetchedPages >= maxPages) break

    let after = gap[1]
    let minRowSeen = null // 本次连续抓到的所有行里最早的时间戳
    let reachedEarliest = false
    let pageError = null

    while (after > gap[0]) {
      if (result.fetchedPages >= maxPages) break
      const page = await fetcher.fetchPage({ instId, okxBar, after, limit: PAGE_LIMIT })
      result.fetchedPages += 1

      if (page === null || typeof page !== 'object' || page.ok !== true) {
        pageError = page !== null && typeof page === 'object' && typeof page.error === 'string' && page.error !== ''
          ? page.error
          : '未知错误'
        break
      }
      const rows = Array.isArray(page.rows) ? page.rows : []
      let pageMinT = null
      for (const rawRow of rows) {
        const bar = normalizeBar(rawRow)
        if (bar === null) continue
        if (pageMinT === null || bar.t < pageMinT) pageMinT = bar.t
        if (minRowSeen === null || bar.t < minRowSeen) minRowSeen = bar.t
        if (!isClosedBar(bar, barMs, now)) continue // 未收盘，绝不进缓存
        cache.bars.set(bar.t, plainBar(bar))
        cache.dirty = true
      }
      logLine(log, '已抓取 ' + String(result.fetchedPages) + ' 页（' + barId + '，最早到 '
        + formatTimeUtc8(minRowSeen === null ? after : minRowSeen) + '）')

      if (rows.length === 0) {
        reachedEarliest = true // 空页：没有比 after 更早的 K 线了
        break
      }
      if (pageMinT === null || pageMinT >= after) {
        warnings.push('接口没有返回更早的 K 线，分页提前结束（after=' + String(after) + '）')
        break
      }
      after = pageMinT
    }

    // 从缺口右端往下抓到的这一整段是连续的：记进 segments（失败/到上限也不例外，
    // 已抓到的部分下次不用重抓）。
    if (minRowSeen !== null) {
      cache.segments = mergeSegments([...cache.segments, [minRowSeen, gap[1]]])
      cache.dirty = true
    }
    if (reachedEarliest) {
      const earliest = minRowSeen !== null ? minRowSeen : gap[1]
      cache.earliestKnown = cache.earliestKnown === null ? earliest : Math.min(cache.earliestKnown, earliest)
      cache.dirty = true
    }
    if (pageError !== null) {
      lastError = pageError
      warnings.push('联网抓取失败：' + pageError)
      break // 网络/接口错误后不再继续后面的缺口，大概率一样连不上
    }
  }

  if (result.fetchedPages >= maxPages) {
    warnings.push('已达到 maxPages=' + String(maxPages) + ' 的页数上限，剩余缺口未抓取（可调大 maxPages 或缩小回测区间）')
  }
  return lastError
}

// ------------------------------------------------------------------ 对外接口

/**
 * 读本地 K 线文件（CLI 的 `--data` 用它做离线复现）。
 * 支持三种 JSON 形状：
 *   1. `{ "bars": [[t,o,h,l,c,v], ...] }`
 *   2. `{ "bars": [{ "t":..., "o":..., ... }, ...] }`
 *   3. 裸数组（元素可以是上面的数组行或对象行）
 * 缓存文件本身是形状 1（多了几个元数据字段，不影响）。
 * 非法行 / 时间降序抛中文 Error —— CLI 要明确告诉用户文件哪里不对，不能悄悄补数据。
 */
export function readBarFile(file) {
  if (typeof file !== 'string' || file.trim() === '') throw new Error('readBarFile 需要 K 线文件路径')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error('读取 K 线文件失败：' + file + '（' + describe(error) + '）')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('K 线文件不是合法 JSON：' + file)
  }
  const rawRows = extractBarRows(parsed)
  if (rawRows === null) {
    throw new Error('K 线文件格式不支持：需要 {"bars":[[t,o,h,l,c,v],...]}、{"bars":[{t,o,h,l,c,v},...]} 或裸数组：' + file)
  }
  const bars = []
  for (let i = 0; i < rawRows.length; i += 1) {
    const bar = normalizeBar(rawRows[i])
    if (bar === null) {
      throw new Error('K 线文件第 ' + String(i + 1) + ' 行不是合法 K 线（需要正数的 t/o/h/l/c 与 v）：' + file)
    }
    const plain = plainBar(bar)
    const prev = bars[bars.length - 1]
    if (prev !== undefined) {
      if (plain.t < prev.t) {
        throw new Error('K 线文件必须按时间升序排列（第 ' + String(i + 1) + ' 行比上一行早）：' + file)
      }
      if (plain.t === prev.t) {
        bars[bars.length - 1] = plain // 同时间戳去重：保留后一行
        continue
      }
    }
    bars.push(plain)
  }
  return bars
}

/**
 * 加载历史 K 线（回测入口）。
 *
 * options:
 *   instId   默认 'BTC-USDT-SWAP'
 *   bar      TIMEFRAMES 的 id（1m/3m/15m/1h/4h/1D）
 *   start/end 毫秒 UTC，左闭右开
 *   dataDir  缓存目录，默认 config.DEFAULT_DATA_DIR
 *   offline  true = 只读缓存，缺口不联网（缺口没覆盖直接 ok:false）
 *   fetcher  注入抓取器（测试用）；不传且需要联网时内部 createOkxFetcher()
 *   proxy / delayMs / log 透传给内部 fetcher
 *   now      当前时间（测试固定用），默认 Date.now()
 *   maxPages 翻页上限（防死循环/失控），默认 2000
 *
 * 返回 SPEC §5.3 的 `{ ok, error, bars, requested, coverage, fetchedPages, fromCache, warnings }`。
 * 约定：ok:true 时 bars 可能不完整（warnings 说明缺口）；ok:false 时调用方不应使用 bars。
 */
export async function loadBars(options = {}) {
  const warnings = []
  try {
    return await loadBarsInner(options, warnings)
  } catch (error) {
    return {
      ok: false,
      error: '加载历史 K 线失败：' + describe(error),
      bars: [],
      requested: {
        start: options !== null && typeof options === 'object' ? toNumber(options.start) : null,
        end: options !== null && typeof options === 'object' ? toNumber(options.end) : null,
      },
      coverage: null,
      fetchedPages: 0,
      fromCache: true,
      warnings,
    }
  }
}

async function loadBarsInner(options, warnings) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('loadBars 参数必须是对象')
  }

  const now = toNumber(options.now) ?? Date.now()
  const instId = options.instId === undefined || options.instId === null || options.instId === ''
    ? DEFAULT_INSTID
    : String(options.instId).trim()
  if (!/^[A-Za-z0-9-]{4,32}$/.test(instId)) throw new Error('标的代码不合法：' + JSON.stringify(instId))

  const timeframe = barById(options.bar) // 非法周期抛中文错误，列出可选值
  const barId = timeframe.id
  const barMs = timeframe.ms

  const start = toNumber(options.start)
  const end = toNumber(options.end)
  const result = {
    ok: false,
    error: null,
    bars: [],
    requested: { start, end },
    coverage: null,
    fetchedPages: 0,
    fromCache: true,
    warnings,
  }
  if (start === null || end === null) {
    result.error = '缺少合法的起止时间（start / end 必须是毫秒时间戳）'
    return result
  }
  if (start >= end) {
    result.error = '起始时间必须早于结束时间（start=' + formatTimeUtc8(start) + '，end=' + formatTimeUtc8(end) + '）'
    return result
  }

  const dataDir = resolve(options.dataDir === undefined || options.dataDir === null || options.dataDir === ''
    ? DEFAULT_DATA_DIR
    : String(options.dataDir))
  const offline = options.offline === true
  const maxPages = Math.max(1, Math.floor(toNumber(options.maxPages) ?? DEFAULT_MAX_PAGES))
  const log = typeof options.log === 'function' ? options.log : null

  // 已收盘边界（开区间上界）：t + barMs <= now ⇔ t < floor(now / barMs) * barMs。
  // 例：now=12:30、1h → 边界 12:00，最后一根已收盘是 11:00 那根。
  // 用对齐边界而不是 now-barMs+1，是为了让缓存覆盖区间稳定（同一根 K 线内多次运行不漂移）；
  // 而且这个边界不依赖「交易所 K 线按什么时区对齐」的假设（见文件头注释）。
  const closedBoundary = Math.floor(now / barMs) * barMs
  const fetchFrom = start
  const fetchTo = Math.min(end, closedBoundary)
  if (end > now) {
    warnings.push('结束时间晚于当前时间，已按已收盘 K 线夹紧（正在走的 K 线不能当历史数据）')
  }
  if (fetchFrom >= fetchTo) {
    result.error = '请求区间内没有已收盘的 K 线（' + rangeText(start, end) + '；最后一根已收盘 K 线的开盘时间不晚于 '
      + formatTimeUtc8(closedBoundary - barMs) + '）'
    return result
  }

  const cacheFile = join(dataDir, instId, barId + '.json')
  const cache = readCacheFile(cacheFile, instId, barId, barMs, now, warnings)

  // 「交易所最早只到某天」是缓存里记下的事实：请求更早的区间时直接夹掉，
  // 不再每次都往一个永远空的方向翻页（1H 早期数据每次重试 600+ 页很浪费）。
  let earliestWarned = false
  const warnEarliest = () => {
    if (earliestWarned) return
    if (cache.earliestKnown === null || fetchFrom >= cache.earliestKnown) return
    earliestWarned = true
    warnings.push('请求起始时间早于交易所最早可用数据（最早 ' + formatTimeUtc8(cache.earliestKnown)
      + '），更早的区间不会再重复联网抓取')
  }

  if (cache.earliestKnown !== null && fetchTo <= cache.earliestKnown) {
    // 整个请求区间都在已知下界之前：交易所根本没有这段数据，也不用联网。
    earliestWarned = true
    warnings.push('请求区间早于交易所最早可用数据（最早 ' + formatTimeUtc8(cache.earliestKnown) + '），没有可用的 K 线')
    result.error = '请求区间内没有可用的已收盘 K 线'
    return result
  }

  let rangeFrom = fetchFrom
  if (cache.earliestKnown !== null && rangeFrom < cache.earliestKnown) {
    rangeFrom = cache.earliestKnown
    warnEarliest()
  }

  const gaps = rangeFrom >= fetchTo ? [] : subtractSegments([rangeFrom, fetchTo], cache.segments)

  /** 联网/接口错误（中文）；成功或没联网时为 null。 */
  let fetchError = null
  if (gaps.length === 0) {
    warnEarliest()
    logLine(log, '缓存已覆盖请求区间，本次不联网')
  } else if (offline) {
    warnEarliest()
    result.ok = false
    result.error = '离线模式下缓存没有覆盖 ' + gaps.map(([from, to]) => rangeText(from, to)).join('、')
    // 失败时也把缓存里已有的部分带回去，方便用户判断「差了多少」，调用方必须先看 ok。
    result.bars = collectBars(cache, start, end, now, barMs)
    result.coverage = coverageOf(result.bars, barMs)
    result.fromCache = true
    return result
  } else {
    if (options.fetcher !== undefined && options.fetcher !== null
      && (typeof options.fetcher !== 'object' || typeof options.fetcher.fetchPage !== 'function')) {
      throw new Error('options.fetcher 必须提供 fetchPage 方法')
    }
    let fetcher = options.fetcher !== undefined && options.fetcher !== null ? options.fetcher : null
    let ownFetcher = false
    if (fetcher === null) {
      fetcher = createOkxFetcher({ proxy: options.proxy, delayMs: options.delayMs, log })
      ownFetcher = true
    }
    try {
      fetchError = await fillGaps({
        fetcher,
        gaps,
        cache,
        instId,
        okxBar: timeframe.okx,
        barId,
        barMs,
        now,
        maxPages,
        warnings,
        log,
        result,
      })
    } finally {
      // 只关自己创建的 fetcher：注入的 fetcher 归调用方管（测试/CLI 可能复用它）。
      if (ownFetcher) {
        try {
          fetcher.close()
        } catch (error) {
          // 关闭失败不影响数据
        }
      }
    }
    if (cache.dirty) writeCacheFile(cacheFile, cache, instId, barId, warnings)
    result.fromCache = result.fetchedPages === 0
    warnEarliest() // 本次可能刚发现「历史深度下界」，发现后也要提醒一次
  }

  result.bars = collectBars(cache, start, end, now, barMs)
  result.coverage = coverageOf(result.bars, barMs)

  if (result.bars.length === 0) {
    result.ok = false
    result.error = fetchError !== null && fetchError !== undefined
      ? '获取历史 K 线失败：' + fetchError
      : '请求区间内没有可用的已收盘 K 线'
    return result
  }

  result.ok = true
  // 最终校验一次覆盖：即使 fetchPage 一路成功，也可能因为 maxPages 等原因留下缺口。
  const missing = rangeFrom >= fetchTo ? [] : subtractSegments([rangeFrom, fetchTo], cache.segments)
  if (missing.length > 0) {
    const ranges = missing.map(([from, to]) => rangeText(from, to)).join('、')
    if (fetchError !== null && fetchError !== undefined) {
      warnings.push('联网抓取失败，以下区间未覆盖：' + ranges + '（原因：' + fetchError + '）')
    } else {
      warnings.push('数据覆盖不完整，以下区间没有抓到 K 线：' + ranges)
    }
  }
  if (result.fetchedPages > 0) {
    logLine(log, '本次共抓取 ' + String(result.fetchedPages) + ' 页，' + barId + ' 缓存现有 '
      + String(cache.bars.size) + ' 根 K 线')
  }
  return result
}

// ------------------------------------------------------------------ 资金费率（funding）
//
// 口径与限制：
//   - BTC 永续每 8 小时结算一次；本层把 OKX 的 funding 历史抓下来缓存（funding.json），
//     缓存里存的是「一次结算一个点」：{rates: [[t, rate], ...]}。
//   - **OKX 公开接口只保留最近约 3 个月**，更早的区间拿不到；上层（CLI/宿主）用固定费率
//     估算兜底，并在报告里标注「含估算」，绝不把估算伪装成历史。
//   - 缓存覆盖用 segments 表示（每个点覆盖 [t, t+8h)），逻辑和 K 线缓存同一套区间运算。

const FUNDING_CACHE_VERSION = 1
const FUNDING_PAGE_LIMIT = 100
const DEFAULT_FUNDING_MAX_PAGES = 200

/** 资金费率缓存文件名（放在同一个标的目录下，和 K 线缓存并列）。 */
function fundingCacheFile(dataDir, instId) {
  return join(dataDir, instId, 'funding.json')
}

/** 读资金费率缓存；文件不存在/损坏/版本不符都不抛，返回空 Map 并给 warning。 */
function readFundingCache(file, instId, warnings) {
  const state = { rates: new Map(), dirty: false }
  if (!existsSync(file)) return state
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    warnings.push('资金费率缓存损坏，已忽略并重新抓取：' + describe(error))
    return state
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return state
  if (parsed.version !== FUNDING_CACHE_VERSION || parsed.instId !== instId) return state
  const rows = Array.isArray(parsed.rates) ? parsed.rates : []
  for (const row of rows) {
    const t = Array.isArray(row) ? toNumber(row[0]) : toNumber(row?.t)
    const rate = Array.isArray(row) ? toNumber(row[1]) : toNumber(row?.rate)
    if (t !== null && rate !== null) state.rates.set(t, rate)
  }
  return state
}

/** 原子写资金费率缓存（先 .tmp 再 rename，避免进程被杀留下半个 JSON）。 */
function writeFundingCache(file, instId, cache, warnings) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const rates = Array.from(cache.rates.entries()).sort((left, right) => left[0] - right[0])
    const payload = {
      version: FUNDING_CACHE_VERSION,
      instId,
      updatedAt: Date.now(),
      rates,
    }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload))
    renameSync(tmp, file)
  } catch (error) {
    warnings.push('写入资金费率缓存失败（不影响本次回测）：' + describe(error))
  }
}

/** 缓存里的费率点 → 已覆盖区间：每个点覆盖 [t, t + interval)。 */
function fundingSegmentsOf(rates, intervalMs) {
  const segments = []
  const sorted = Array.from(rates.keys()).sort((left, right) => left - right)
  for (const t of sorted) {
    const last = segments[segments.length - 1]
    if (last !== undefined && t <= last[1]) {
      if (t + intervalMs > last[1]) last[1] = t + intervalMs
    } else {
      segments.push([t, t + intervalMs])
    }
  }
  return mergeSegments(segments)
}

/** 费率点 → 覆盖率（最早/最晚），没有数据给 null。 */
function fundingCoverageOf(rates, intervalMs) {
  if (rates.size === 0) return null
  const times = Array.from(rates.keys()).sort((left, right) => left - right)
  return { from: times[0], to: times[times.length - 1] + intervalMs }
}

/**
 * 加载资金费率历史（OKX `/public/funding-rate-history`，只保留最近约 3 个月）。
 *
 * options: instId / start / end / dataDir / offline / fetcher / now / intervalMs / maxPages / log
 *
 * 返回 `{ ok, error, rates: [{ t, rate }], coverage, fromCache, fetchedPages, warnings, cacheFile }`。
 * ok:false 时调用方应改用固定费率估算；ok:true 时 rates 可能只覆盖部分区间（warnings 会说明）。
 * 注意：`start` 允许早于 OKX 保留期 —— 这里不会报错，只会返回能拿到的部分。
 */
export async function loadFundingRates(options = {}) {
  const warnings = []
  try {
    return await loadFundingRatesInner(options, warnings)
  } catch (error) {
    return {
      ok: false,
      error: '加载资金费率失败：' + describe(error),
      rates: [],
      coverage: null,
      fromCache: true,
      fetchedPages: 0,
      warnings,
    }
  }
}

async function loadFundingRatesInner(options, warnings) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('loadFundingRates 参数必须是对象')
  }
  const now = toNumber(options.now) ?? Date.now()
  const instId = options.instId === undefined || options.instId === null || options.instId === ''
    ? DEFAULT_INSTID
    : String(options.instId).trim()
  if (!/^[A-Za-z0-9-]{4,32}$/.test(instId)) throw new Error('资金费率标的代码不合法：' + JSON.stringify(instId))
  const intervalMs = toNumber(options.intervalMs) ?? FUNDING_INTERVAL_MS
  const start = toNumber(options.start)
  const end = toNumber(options.end)
  const result = {
    ok: false,
    error: null,
    rates: [],
    coverage: null,
    fromCache: true,
    fetchedPages: 0,
    warnings,
    cacheFile: null,
  }
  if (start === null || end === null) {
    result.error = '缺少合法的起止时间（start / end 必须是毫秒时间戳）'
    return result
  }
  if (start >= end) {
    result.error = '资金费率的起始时间必须早于结束时间'
    return result
  }
  const dataDir = resolve(options.dataDir === undefined || options.dataDir === null || options.dataDir === ''
    ? DEFAULT_DATA_DIR
    : String(options.dataDir))
  const offline = options.offline === true
  const maxPages = Math.max(1, Math.floor(toNumber(options.maxPages) ?? DEFAULT_FUNDING_MAX_PAGES))
  const log = typeof options.log === 'function' ? options.log : null
  const cacheFile = fundingCacheFile(dataDir, instId)
  result.cacheFile = cacheFile

  const cache = readFundingCache(cacheFile, instId, warnings)
  const fetchTo = Math.min(end, now)
  if (fetchTo <= start) {
    // 请求区间都在未来：没有资金费率可结算，直接返回空（不算错误）
    result.ok = true
    return result
  }

  let gaps = subtractSegments([start, fetchTo], fundingSegmentsOf(cache.rates, intervalMs))
  if (gaps.length > 0 && offline) {
    result.ok = false
    result.error = '离线模式下资金费率缓存没有覆盖 ' + gaps.map(([from, to]) => rangeText(from, to)).join('、')
    result.rates = Array.from(cache.rates.entries())
      .filter(([t]) => t >= start && t < end)
      .sort((left, right) => left[0] - right[0])
      .map(([t, rate]) => ({ t, rate }))
    result.coverage = fundingCoverageOf(cache.rates, intervalMs)
    return result
  }

  let fetchError = null
  if (gaps.length > 0) {
    if (options.fetcher !== undefined && options.fetcher !== null
      && (typeof options.fetcher !== 'object' || typeof options.fetcher.fetchFundingPage !== 'function')) {
      throw new Error('options.fetcher 必须提供 fetchFundingPage 方法')
    }
    let fetcher = options.fetcher !== undefined && options.fetcher !== null ? options.fetcher : null
    let ownFetcher = false
    if (fetcher === null) {
      fetcher = createOkxFetcher({ proxy: options.proxy, delayMs: options.delayMs, log })
      ownFetcher = true
    }
    try {
      // 从右往左翻：after=cursor 返回严格早于 cursor 的记录（最新在前）
      let cursor = fetchTo
      let pages = 0
      while (cursor > start && pages < maxPages) {
        const page = await fetcher.fetchFundingPage({ instId, after: cursor, limit: FUNDING_PAGE_LIMIT })
        if (page.ok !== true) {
          fetchError = page.error || '抓取资金费率失败'
          warnings.push(fetchError)
          break
        }
        if (page.rows.length === 0) break // 没有更早的数据（OKX 只保留最近约 3 个月）
        pages += 1
        let minT = Infinity
        for (const row of page.rows) {
          cache.rates.set(row.t, row.rate)
          cache.dirty = true
          if (row.t < minT) minT = row.t
        }
        if (!Number.isFinite(minT) || minT >= cursor) break // 防死循环
        cursor = minT
      }
      result.fetchedPages = pages
      if (pages >= maxPages) warnings.push('资金费率已达到 maxPages=' + String(maxPages) + ' 的页数上限')
    } finally {
      if (ownFetcher) {
        try {
          fetcher.close()
        } catch (error) {
          // 关闭失败不影响数据
        }
      }
    }
    if (cache.dirty) writeFundingCache(cacheFile, instId, cache, warnings)
    result.fromCache = result.fetchedPages === 0
    gaps = subtractSegments([start, fetchTo], fundingSegmentsOf(cache.rates, intervalMs))
    if (gaps.length > 0) {
      warnings.push('资金费率历史只覆盖 ' + (fundingCoverageOf(cache.rates, intervalMs) === null
        ? '无'
        : rangeText(fundingCoverageOf(cache.rates, intervalMs).from, fundingCoverageOf(cache.rates, intervalMs).to))
        + '，以下区间将按固定费率估算：' + gaps.map(([from, to]) => rangeText(from, to)).join('、'))
    }
  } else {
    logLine(log, '资金费率缓存已覆盖请求区间，本次不联网')
  }

  result.rates = Array.from(cache.rates.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([t, rate]) => ({ t, rate }))
  result.coverage = fundingCoverageOf(cache.rates, intervalMs)
  if (result.rates.length === 0) {
    result.ok = false
    result.error = fetchError !== null
      ? '抓取资金费率失败：' + fetchError
      : '没有可用的资金费率数据（OKX 只保留最近约 3 个月）'
    return result
  }
  result.ok = true
  return result
}

/**
 * 把「历史费率 + 固定费率估算」拼成引擎要的结算事件。
 *
 * - 历史费率覆盖到的区间用真实结算点；
 * - 覆盖不到的区间（OKX 无历史的部分）按 `fallbackRate` 每 8 小时生成一个估算点；
 * - 返回 `{ events: [{t, rate}], meta: { historicalCount, estimatedCount, fallbackRate, uncovered, coverage } }`。
 */
export function buildFundingEvents(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('buildFundingEvents 参数必须是对象')
  }
  const start = toNumber(options.start)
  const end = toNumber(options.end)
  if (start === null || end === null || !(start < end)) {
    throw new Error('buildFundingEvents 需要合法的 start / end（左闭右开）')
  }
  const intervalMs = toNumber(options.intervalMs) ?? FUNDING_INTERVAL_MS
  if (!(intervalMs > 0)) throw new Error('资金费率结算间隔必须大于 0')
  const fallbackRate = toNumber(options.fallbackRate) ?? DEFAULT_FUNDING_RATE
  if (!(fallbackRate >= 0)) throw new Error('估算资金费率不能为负：' + String(fallbackRate))

  const rawRates = Array.isArray(options.rates) ? options.rates : []
  const historical = new Map()
  for (const item of rawRates) {
    const t = Array.isArray(item) ? toNumber(item[0]) : toNumber(item?.t)
    const rate = Array.isArray(item) ? toNumber(item[1]) : toNumber(item?.rate)
    if (t !== null && rate !== null && t >= start && t < end) historical.set(t, rate)
  }

  const uncovered = subtractSegments([start, end], fundingSegmentsOf(historical, intervalMs))
  const estimated = []
  for (const [from, to] of uncovered) {
    // 对齐到 8 小时的 UTC 结算网格（00:00 / 08:00 / 16:00）
    let t = Math.ceil(from / intervalMs) * intervalMs
    while (t < to) {
      if (!historical.has(t)) estimated.push({ t, rate: fallbackRate })
      t += intervalMs
    }
  }

  const events = []
  for (const [t, rate] of Array.from(historical.entries()).sort((left, right) => left[0] - right[0])) {
    events.push({ t, rate })
  }
  for (const event of estimated) events.push(event)
  events.sort((left, right) => left.t - right.t)

  const coverage = fundingCoverageOf(historical, intervalMs)
  return {
    events,
    meta: {
      intervalMs,
      fallbackRate,
      historicalCount: historical.size,
      estimatedCount: estimated.length,
      uncovered,
      coverage,
    },
  }
}

