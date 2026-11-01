/**
 * OKX 历史 K 线的 HTTP 传输层：代理/直连切换、重试退避、限速、错误归一。
 *
 * 为什么单独一层：
 *   1. 回测一次要拉几十上百页历史 K 线，最怕「偶发网络抖动直接让整次回测失败」。
 *      重试、退避、限速都收在这里，上层 data.mjs 只需要关心「这一页拿到没有」。
 *   2. 本机 DNS 把 www.okx.com 解析到 169.254.0.2（黑洞地址），直连必失败。
 *      插件里已经踩过这个坑并写好了 CONNECT 隧道 + keep-alive 复用，这里直接复用
 *      `rawGet`，不再造第二套 HTTP 客户端（chunked、连接复用、超时细节全交给它）。
 *   3. 所有对外 API **永不抛异常**：网络世界没有「不可能」，把异常统一折成
 *      `{ ok:false, error:'中文原因' }`，上层才能区分「没数据」和「代码写坏了」。
 *
 * 代理优先级（见 resolveProxy）：
 *   显式 options.proxy → 环境变量 DSH_BTC_PROXY / OKX_PROXY → 工作区 .env 同名键
 *   → 默认 http://127.0.0.1:7897。`off` / `none` / `direct` / `false` / 空串 / null 表示强制直连。
 *
 * 安全：读 .env 只取代理相关键，**绝不把 .env 内容打进日志**（里面混着 API key）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTransport, parseEnvFile, rawGet } from '../../plugin/dsh-btc-dashboard/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const OKX_HOST = 'www.okx.com'
const HISTORY_CANDLES_PATH = '/api/v5/market/history-candles'
/** 本机默认代理：和插件保持一致（Clash 系默认 7897）。 */
const DEFAULT_PROXY_RAW = 'http://127.0.0.1:7897'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_RETRIES = 3
/** 默认请求间隔：OKX 限速 20 次/2 秒，120ms 一次正好在安全区内。 */
const DEFAULT_DELAY_MS = 120
/** history-candles 单页上限是 100（300 是 /market/candles 的上限，别混用）。 */
const PAGE_LIMIT = 100
/** 网络错误退避阶梯；用完之后一直按最后一档 2000ms。 */
const BACKOFF_MS = [300, 800, 2000]
/**
 * OKX 限速是 20 次 / 2 秒，正常限速 120ms/次在安全区内；
 * 真被限速时按官方建议歇一下再来，1200ms 足够让窗口滑过去。
 */
const RATE_LIMIT_WAIT_MS = 1_200

/** 这些写法都表示「不要代理，直连」。 */
const OFF_TOKENS = new Set(['off', 'none', 'direct', 'false', 'no'])

function describe(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

function finiteNumber(value, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isOffToken(value) {
  if (value === null || value === undefined) return true
  const text = String(value).trim().toLowerCase()
  return text === '' || OFF_TOKENS.has(text)
}

// ------------------------------------------------------------------ 代理解析

/**
 * 工作区目录：`.env` 所在位置。
 * 和插件保持同一套推导（`DSH_BTC_WORKSPACE` → 仓库根 → cwd），但**不缓存**结果：
 * 测试要能临时改 `DSH_BTC_WORKSPACE` 指向临时目录来验证 .env 读取，缓存会把它锁死。
 */
function workspaceDir() {
  const fromEnv = process.env.DSH_BTC_WORKSPACE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  const root = resolve(HERE, '..', '..')
  // 源码仓库根有 .git（或用户放了 .env）；npm/GitHub 安装后包根在 node_modules 里，两者都没有 → 用 cwd。
  if (existsSync(join(root, '.git')) || existsSync(join(root, '.env'))) return root
  return process.cwd()
}

/**
 * 读工作区 `.env` 里与传输相关的变量。解析复用插件的 `parseEnvFile`（支持 export/引号/行尾注释）。
 * 读失败（文件不存在、权限问题）一律当空对象：没有代理配置时退回默认代理即可。
 * 注意：这里只返回变量表，**不打印任何值**。
 */
function readWorkspaceEnv() {
  try {
    return parseEnvFile(readFileSync(join(workspaceDir(), '.env'), 'utf8'))
  } catch (error) {
    return {}
  }
}

/** `host:port` / `http://host:port` → `{ raw, host, port }`；解析不了返回 null。 */
function parseProxyText(value) {
  const raw = String(value).trim()
  if (raw === '') return null
  // 代理地址是纯 ASCII 的 URL：出现空白/中文等字符说明用户填错了，直接当无效，
  // 不要交给 URL 解析器去"猜"（它会把中文域名转 punycode，反而看起来像合法的）。
  if (!/^[\x21-\x7e]+$/.test(raw)) return null
  // 允许用户只写「127.0.0.1:7897」：不带协议头时按 http 解释（代理普遍如此）。
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw
  let url
  try {
    url = new URL(candidate)
  } catch (error) {
    return null
  }
  // 只支持 HTTP(S) 代理：rawGet 的隧道实现就是 CONNECT over TCP，SOCKS 之类的它不认。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  // IPv6 的 hostname 带方括号，其余按域名/IPv4 字符集校验。
  const hostOk = /^[A-Za-z0-9.-]+$/.test(host) || /^\[[0-9A-Fa-f:.]+\]$/.test(host)
  if (!hostOk || !Number.isFinite(port) || port <= 0 || port > 65_535) return null
  return { raw, host, port }
}

/** 把任意 proxy 配置值（字符串 / {raw,host,port} / null）归一成标准形状。 */
function normalizeProxy(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const raw = typeof value.raw === 'string' ? value.raw : ''
    const host = typeof value.host === 'string' ? value.host : ''
    const port = Number(value.port)
    if (host !== '' && Number.isFinite(port) && port > 0 && port <= 65_535) {
      return { raw: raw !== '' ? raw : 'http://' + host + ':' + String(port), host, port }
    }
    return raw !== '' ? parseProxyText(raw) : null
  }
  // 非字符串（true / 数字等）不是合法配置；'off' 之类的令牌在这里统一判掉，
  // 否则会被 URL 解析成主机名 "off"（看起来像代理，实际是坏配置）。
  if (typeof value !== 'string') return null
  if (isOffToken(value)) return null
  return parseProxyText(value)
}

/**
 * 解析代理设置，返回 `{ raw, host, port }` 或 `null`（null = 直连）。
 * 优先级：显式 options.proxy（null/'off' 等 = 强制直连）> 环境变量 DSH_BTC_PROXY / OKX_PROXY
 * > 工作区 .env 同名键 > 默认本地代理。
 * 非法代理字符串返回 null（退直连），由 createOkxFetcher 打一条日志提醒。
 */
export function resolveProxy(options = {}) {
  const opts = options !== null && typeof options === 'object' && !Array.isArray(options) ? options : {}
  // 显式传了 proxy（哪怕是 null = 强制直连）就不再往下找：调用方的意图优先于环境变量。
  // 注意 `{ proxy: undefined }` 视为「没传」：上层为了统一可能总是展开一个 proxy 键，
  // 不能因此把用户没设置的代理当成「强制直连」（本机直连是黑洞，会白白超时）。
  if (hasOwn(opts, 'proxy') && opts.proxy !== undefined) return normalizeProxy(opts.proxy)
  for (const key of ['DSH_BTC_PROXY', 'OKX_PROXY']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') return normalizeProxy(value)
  }
  const fileVars = readWorkspaceEnv()
  for (const key of ['DSH_BTC_PROXY', 'OKX_PROXY']) {
    const value = fileVars[key]
    if (typeof value === 'string' && value.trim() !== '') return normalizeProxy(value)
  }
  return normalizeProxy(DEFAULT_PROXY_RAW)
}

// ------------------------------------------------------------------ 响应解析

function bodyToText(body) {
  if (body === undefined || body === null) return ''
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  return String(body)
}

/**
 * OKX K 线行 → Bar。接口顺序：ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm。
 * 保留 `confirm`（'0'/'1'）：上层 data.mjs 要用它判断「这根收线了没」；
 * 契约里的 Bar 只有 6 个字段，所以这是**附加字段**，data 落盘前会剥掉。
 * 接口返回顺序保持原样（最新在前），排序交给 data.mjs，传输层不擅自重排。
 */
function parseHistoryRows(data) {
  if (!Array.isArray(data)) return null
  const rows = []
  for (const rawRow of data) {
    if (!Array.isArray(rawRow) || rawRow.length < 6) continue
    const t = Number(rawRow[0])
    const o = Number(rawRow[1])
    const h = Number(rawRow[2])
    const l = Number(rawRow[3])
    const c = Number(rawRow[4])
    const v = Number(rawRow[5])
    if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue
    const bar = { t, o, h, l, c, v: Number.isFinite(v) ? v : 0 }
    const confirm = rawRow[8]
    if (confirm !== undefined && confirm !== null && confirm !== '') bar.confirm = String(confirm)
    rows.push(bar)
  }
  return rows
}

function buildHistoryUrl({ instId, okxBar, limit, after }) {
  let url = 'https://' + OKX_HOST + HISTORY_CANDLES_PATH
    + '?instId=' + encodeURIComponent(instId)
    + '&bar=' + encodeURIComponent(okxBar)
    + '&limit=' + String(limit)
  if (after !== null) url += '&after=' + String(after)
  return url
}

const FUNDING_HISTORY_PATH = '/api/v5/public/funding-rate-history'

/**
 * 资金费率历史行解析：OKX 返回对象数组 `{ fundingRate, fundingTime, ... }`。
 * 保留原始顺序（最新在前），排序/去重交给 data.mjs。
 * 注意：OKX 这个接口**只保留最近约 3 个月**，更早的历史拿不到（上层用固定费率估算兜底）。
 */
function parseFundingRows(data) {
  if (!Array.isArray(data)) return null
  const rows = []
  for (const item of data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const t = Number(item.fundingTime)
    // realizedRate 是实际结算费率；它缺失时才退回 fundingRate。两个都缺失跳过该行。
    const rawRate = item.realizedRate === undefined || item.realizedRate === null || item.realizedRate === ''
      ? item.fundingRate
      : item.realizedRate
    const rate = Number(rawRate)
    if (!Number.isFinite(t) || !Number.isFinite(rate)) continue
    rows.push({ t, rate })
  }
  return rows
}

function buildFundingUrl({ instId, limit, after }) {
  return 'https://' + OKX_HOST + FUNDING_HISTORY_PATH
    + '?instId=' + encodeURIComponent(instId)
    + '&limit=' + String(limit)
    + (after !== null ? '&after=' + String(after) : '')
}

function normalizeFundingParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('fetchFundingPage 参数必须是对象')
  }
  const instId = typeof params.instId === 'string' ? params.instId.trim() : ''
  if (!/^[A-Za-z0-9-]{4,32}$/.test(instId)) throw new Error('fetchFundingPage 缺少合法的 instId')
  let limit = PAGE_LIMIT
  if (params.limit !== undefined && params.limit !== null && params.limit !== '') {
    const n = Number(params.limit)
    if (!Number.isFinite(n)) throw new Error('fetchFundingPage 的 limit 不是合法数字')
    limit = Math.min(PAGE_LIMIT, Math.max(1, Math.floor(n)))
  }
  let after = null
  if (params.after !== undefined && params.after !== null && params.after !== '') {
    const n = Number(params.after)
    if (!Number.isFinite(n) || n < 0) throw new Error('fetchFundingPage 的 after 必须是非负毫秒时间戳')
    after = Math.floor(n)
  }
  return { instId, limit, after }
}

function normalizePageParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('fetchPage 参数必须是对象')
  }
  const instId = typeof params.instId === 'string' ? params.instId.trim() : ''
  if (!/^[A-Za-z0-9-]{4,32}$/.test(instId)) throw new Error('fetchPage 缺少合法的 instId')
  const okxBar = typeof params.okxBar === 'string' ? params.okxBar.trim() : ''
  if (okxBar === '') throw new Error('fetchPage 缺少 okxBar（OKX 的周期写法，如 1H / 4H / 1D）')
  let limit = PAGE_LIMIT
  if (params.limit !== undefined && params.limit !== null && params.limit !== '') {
    const n = Number(params.limit)
    if (!Number.isFinite(n)) throw new Error('fetchPage 的 limit 不是合法数字：' + JSON.stringify(String(params.limit)))
    // 服务端上限就是 100，传大了会报参数错误，这里直接夹紧。
    limit = Math.min(PAGE_LIMIT, Math.max(1, Math.floor(n)))
  }
  let after = null
  if (params.after !== undefined && params.after !== null && params.after !== '') {
    const n = Number(params.after)
    if (!Number.isFinite(n) || n < 0) throw new Error('fetchPage 的 after 必须是非负毫秒时间戳')
    after = Math.floor(n)
  }
  return { instId, okxBar, limit, after }
}

// ------------------------------------------------------------------ fetcher

/**
 * 创建 OKX 分页抓取器。
 *
 * options:
 *   proxy     代理配置（经 resolveProxy；不传则按环境变量/.env/默认值）
 *   timeoutMs 单次请求超时，默认 12000
 *   retries   首次失败后的**额外**重试轮数，默认 3（总共最多 4 轮）
 *   delayMs   两次请求之间的最小间隔（从发出到发出），默认 120（限速 20 req/2s）
 *   request   可注入：`(target, url, headers, timeoutMs, proxy) => { status, body }`，默认插件 rawGet
 *   closeTunnels close() 时是否顺带关掉插件的全局 keep-alive 隧道，默认 true。
 *              **在 DSH 宿主进程里跑回测时必须传 false**：宿主和看板共用同一条隧道池，
 *              回测收尾把隧道关了会让正在进行的看板刷新一起失败（看板那边会重连，
 *              但用户可能正好看到一次刷新错误）。
 *   log       进度/重试日志回调（可选）
 *
 * 返回 `{ fetchPage, close, stats }`。fetchPage 永不抛异常。
 */
export function createOkxFetcher(options = {}) {
  const opts = options !== null && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const timeoutMs = Math.max(500, Math.floor(finiteNumber(opts.timeoutMs, DEFAULT_TIMEOUT_MS)))
  const retries = Math.max(0, Math.floor(finiteNumber(opts.retries, DEFAULT_RETRIES)))
  const delayMs = Math.max(0, Math.floor(finiteNumber(opts.delayMs, DEFAULT_DELAY_MS)))
  const request = typeof opts.request === 'function' ? opts.request : rawGet
  const log = typeof opts.log === 'function' ? opts.log : null
  const closeTunnels = opts.closeTunnels !== false

  const proxy = resolveProxy(opts)
  if (proxy === null && hasOwn(opts, 'proxy') && !isOffToken(opts.proxy) && log !== null) {
    // 显式给了代理却解析不了：不能静默直连（直连在本机大概率是黑洞），但也不能抛。
    log('代理地址无法解析，已改为直连（检查 http://host:port 格式）')
  }

  /** 上次成功的通道：'proxy' | 'direct'，用来决定下一次先试哪条（避免每次先踩坏通道）。 */
  let channel = null
  let lastRequestAt = 0
  let closed = false

  const stats = {
    requests: 0, // 实际发出的 HTTP 请求数（含重试）
    pages: 0, // 成功的页数
    ok: 0, // fetchPage 成功次数
    failed: 0, // fetchPage 最终失败的次数
    errors: 0, // 网络异常次数（抛错）
    retries: 0, // 进入重试的次数
    rateLimited: 0, // HTTP 429 / 错误码 50011 次数
    channel: null,
    lastError: null,
  }

  /** 保证两次请求的**发出时间**间隔 >= delayMs（不是响应到发出）。 */
  async function throttle() {
    if (delayMs > 0 && lastRequestAt > 0) {
      const wait = lastRequestAt + delayMs - Date.now()
      if (wait > 0) await sleep(wait)
    }
    lastRequestAt = Date.now()
  }

  /** 先走上一次成功的通道；没有记录时先代理后直连（本机直连是黑洞）。 */
  function orderedTargets() {
    if (proxy === null) return ['direct']
    if (channel === 'direct') return ['direct', 'proxy']
    return ['proxy', 'direct']
  }

  async function fetchPage(params = {}) {
    try {
      const info = normalizePageParams(params)
      const url = buildHistoryUrl(info)
      const maxAttempts = retries + 1
      let lastError = ''

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let rateLimited = false
        for (const target of orderedTargets()) {
          await throttle()
          stats.requests += 1
          let response
          try {
            response = await request(target, url, {}, timeoutMs, proxy)
          } catch (error) {
            // 网络异常：同轮换另一条通道再试，轮末再退避。
            stats.errors += 1
            lastError = '网络错误：' + describe(error)
            continue
          }
          const status = Number(response === null || response === undefined ? NaN : response.status)
          const text = bodyToText(response === null || response === undefined ? undefined : response.body)

          if (status === 429) {
            stats.rateLimited += 1
            lastError = 'OKX 限速（HTTP 429）'
            rateLimited = true
            break // 限速是全局的，换直连也会被限，直接等后重试
          }
          if (status !== 200) {
            lastError = 'OKX HTTP ' + (Number.isFinite(status) ? String(status) : '未知状态')
              + (text !== '' ? '：' + text.slice(0, 120) : '')
            // 5xx 是服务端临时问题，值得换通道/重试；4xx（参数错误等）重试也不会变好。
            if (status >= 500) continue
            stats.failed += 1
            stats.lastError = lastError
            return { ok: false, error: lastError }
          }

          let parsed
          try {
            parsed = JSON.parse(text)
          } catch (error) {
            lastError = 'OKX 返回的不是 JSON：' + text.slice(0, 120)
            continue
          }
          const code = parsed !== null && typeof parsed === 'object' ? String(parsed.code) : ''
          if (code !== '0') {
            const msg = parsed !== null && typeof parsed === 'object' && typeof parsed.msg === 'string' ? parsed.msg : ''
            lastError = 'OKX 接口报错：' + (msg !== '' ? msg : 'code=' + (code === '' ? '未知' : code))
            // 50011 = Too Many Requests，和 429 同样处理。
            if (code === '50011') {
              stats.rateLimited += 1
              rateLimited = true
              break
            }
            continue
          }
          const rows = parseHistoryRows(parsed.data)
          if (rows === null) {
            lastError = 'OKX 返回的数据不是数组'
            continue
          }
          if (rows.length === 0 && Array.isArray(parsed.data) && parsed.data.length > 0) {
            // 有数据但一行都解析不出来：接口形状变了或中间有代理污染，当失败处理，
            // 绝不能让 data 层把「解析失败的空页」误判成「历史数据到尽头了」。
            lastError = 'OKX 返回的 K 线数据无法解析'
            continue
          }

          channel = target
          stats.channel = target
          stats.pages += 1
          stats.ok += 1
          stats.lastError = null
          return { ok: true, rows }
        }

        if (attempt >= maxAttempts) break
        const waitMs = rateLimited ? RATE_LIMIT_WAIT_MS : BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
        stats.retries += 1
        log?.('OKX 请求失败（' + lastError + '），' + String(waitMs) + 'ms 后重试（第 ' + String(attempt) + '/' + String(retries) + ' 次）')
        await sleep(waitMs)
      }

      stats.failed += 1
      stats.lastError = lastError
      const reason = lastError === '' ? '未知原因' : lastError
      return { ok: false, error: reason + '（已尝试 ' + String(maxAttempts) + ' 轮）' }
    } catch (error) {
      // 参数校验等编程错误也折成返回值：契约要求 fetchPage 永不抛。
      stats.failed += 1
      stats.lastError = describe(error)
      return { ok: false, error: '抓取历史 K 线失败：' + describe(error) }
    }
  }

  /**
   * 抓一页资金费率历史（OKX `/public/funding-rate-history`）。
   * 语义与 fetchPage 一致：按 `after`（毫秒时间戳）往回翻，返回**严格早于 after** 的记录、最新在前；
   * 空数组表示「没有更早的数据了」。永不抛异常，失败折成 `{ ok:false, error }`。
   *
   * 注意：OKX 只保留最近约 3 个月，更早的区间由 data.mjs 用固定费率估算兜底。
   */
  async function fetchFundingPage(params = {}) {
    try {
      const info = normalizeFundingParams(params)
      const url = buildFundingUrl(info)
      const maxAttempts = retries + 1
      let lastError = ''

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let rateLimited = false
        for (const target of orderedTargets()) {
          await throttle()
          stats.requests += 1
          let response
          try {
            response = await request(target, url, {}, timeoutMs, proxy)
          } catch (error) {
            stats.errors += 1
            lastError = '网络错误：' + describe(error)
            continue
          }
          const status = Number(response === null || response === undefined ? NaN : response.status)
          const text = bodyToText(response === null || response === undefined ? undefined : response.body)

          if (status === 429) {
            stats.rateLimited += 1
            lastError = 'OKX 限速（HTTP 429）'
            rateLimited = true
            break
          }
          if (status !== 200) {
            lastError = 'OKX HTTP ' + (Number.isFinite(status) ? String(status) : '未知状态')
              + (text !== '' ? '：' + text.slice(0, 120) : '')
            if (status >= 500) continue
            stats.failed += 1
            stats.lastError = lastError
            return { ok: false, error: lastError }
          }

          let parsed
          try {
            parsed = JSON.parse(text)
          } catch (error) {
            lastError = 'OKX 返回的不是 JSON：' + text.slice(0, 120)
            continue
          }
          const code = parsed !== null && typeof parsed === 'object' ? String(parsed.code) : ''
          if (code !== '0') {
            const msg = parsed !== null && typeof parsed === 'object' && typeof parsed.msg === 'string' ? parsed.msg : ''
            lastError = 'OKX 资金费率接口报错：' + (msg !== '' ? msg : 'code=' + (code === '' ? '未知' : code))
            if (code === '50011') {
              stats.rateLimited += 1
              rateLimited = true
              break
            }
            continue
          }
          const rows = parseFundingRows(parsed.data)
          if (rows === null) {
            lastError = 'OKX 资金费率返回的数据不是数组'
            continue
          }
          channel = target
          stats.channel = target
          stats.pages += 1
          stats.ok += 1
          stats.lastError = null
          return { ok: true, rows }
        }

        if (attempt >= maxAttempts) break
        const waitMs = rateLimited ? RATE_LIMIT_WAIT_MS : BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
        stats.retries += 1
        log?.('OKX 资金费率请求失败（' + lastError + '），' + String(waitMs) + 'ms 后重试（第 '
          + String(attempt) + '/' + String(retries) + ' 次）')
        await sleep(waitMs)
      }

      stats.failed += 1
      stats.lastError = lastError
      return { ok: false, error: (lastError === '' ? '未知原因' : lastError) + '（已尝试 ' + String(maxAttempts) + ' 轮）' }
    } catch (error) {
      stats.failed += 1
      stats.lastError = describe(error)
      return { ok: false, error: '抓取资金费率失败：' + describe(error) }
    }
  }

  /**
   * 关掉插件持有的 keep-alive 隧道。
   * 不关的话 Node 进程会因为挂着的 TLS socket 一直不退出 —— 表现为 CLI「跑完了还卡着」。
   * 宿主内（closeTunnels:false）只标记本 fetcher 关闭，不碰全局隧道池。
   */
  function close() {
    if (closed) return
    closed = true
    if (closeTunnels !== true) return
    try {
      closeTransport()
    } catch (error) {
      // 隧道可能已经断开；关闭失败不该影响主流程。
      log?.('关闭传输通道时出错（已忽略）：' + describe(error))
    }
  }

  return { fetchPage, fetchFundingPage, close, stats }
}
