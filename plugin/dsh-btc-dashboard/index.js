/**
 * dsh-btc-dashboard —— OKX BTC 合约「最新价格 + 多周期 K 线 + EMA20/EMA480」看板（Host 半）。
 *
 * 设计要点：
 *   1. 只在 Host 侧联网取数，浏览器半只 fetch 同源路由 /dsh-btc/*（无 CORS、无密钥外泄）。
 *   2. 生产 / 模拟环境可切换：
 *        - prod → .env 的 PROD_OKX_API_KEY / PROD_OKX_API_SECRET，不带模拟头
 *        - demo → .env 的 DEBUG_OKX_API_KEY / DEBUG_OKX_API_SECRET，带 x-simulated-trading: 1
 *      **行情（ticker / candles）是 OKX 公开接口，不需要签名**，所以密钥只用于
 *      「确认这一环境配了哪把钥匙」并展示掩码；本插件不发任何私有请求，
 *      secret 只用来判断「配没配」，绝不回给浏览器。
 *   3. 本机 DNS 把 www.okx.com 解析成 169.254.0.2（黑洞），直连必失败：
 *      默认走本地代理 http://127.0.0.1:7897（CONNECT 隧道），失败再退直连，
 *      并把「上次成功的通道」记下来，避免每次都在坏通道上等超时。
 *   4. 均线是递推量，所以序列要比「能看的那一段」多留预热：取 1800 根
 *      （= 720 可拖 + 1080 预热），整条序列连同 EMA 一起发给浏览器，
 *      由浏览器按当前周期在整条序列上现算、再按窗口切片 —— 拖动时窗口外也有均线。
 *      历史 K 线一旦收盘就不会变，单独按 10 分钟缓存。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-btc-dashboard'
export const version = '1.3.2'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 工作区（`.env` 与 `.dashboard/` 的所在目录）按这个顺序找：
 *   1. `DSH_BTC_WORKSPACE` —— 显式指定，优先级最高；
 *   2. 插件往上两级 —— 插件放在 `<workspace>/plugin/dsh-btc-dashboard`，
 *      所以这里能同时看到 `.env` 或 `plugin/` 就认定是工作区；
 *   3. 当前工作目录 —— 兜底，这样把仓库 clone 到任何路径都能直接跑，
 *      不依赖任何本机绝对路径。
 */
function pickWorkspace() {
  if (process.env.DSH_BTC_WORKSPACE) return process.env.DSH_BTC_WORKSPACE
  const parent = resolve(HERE, '..', '..')
  if (existsSync(join(parent, '.env')) || existsSync(join(parent, 'plugin'))) return parent
  return process.cwd()
}

const WORKSPACE = pickWorkspace()
const ENV_FILE = join(WORKSPACE, '.env')
const STATE_DIR = join(WORKSPACE, '.dashboard')
const STATE_FILE = join(STATE_DIR, 'state.json')

const OKX_HOST = 'www.okx.com'
const DEFAULT_PROXY = 'http://127.0.0.1:7897'
const DEFAULT_INSTID = 'BTC-USDT-SWAP'
const DEFAULT_ENV = 'demo'

const BARS = [
  { id: '1m', okx: '1m', label: '1m', ms: 60_000 },
  { id: '3m', okx: '3m', label: '3m', ms: 180_000 },
  { id: '15m', okx: '15m', label: '15m', ms: 900_000 },
  { id: '1h', okx: '1H', label: '1h', ms: 3_600_000 },
  { id: '4h', okx: '4H', label: '4h', ms: 14_400_000 },
  { id: '1D', okx: '1D', label: '1D', ms: 86_400_000 },
]
const DEFAULT_BAR = '15m'
const EMA_FAST = 20
const EMA_SLOW = 480
// EMA 是递推量：序列最左边那几根的值离「收敛值」还差得远（EMA480 尤其明显）。
// 客户端能往回拖 MAX_DISPLAY 根，所以序列要比展示窗口多留一段预热：
//   1800 = 720（可拖范围）+ 1080（预热，≈2.25 × EMA480）
// 少留这段的后果就是：拖到最左边时，紫线要么整段没有，要么数值明显偏低。
const SERIES_BARS = 1800
const RECENT_LIMIT = 300 // /market/candles 单次上限
const HISTORY_LIMIT = 100 // /market/history-candles 单次上限
const MAX_PAGES = 20
const HOT_TTL = 15_000 // 最近一段 K 线的缓存时长
const HISTORY_TTL = 600_000 // 已收盘历史 K 线的缓存时长
const TICKER_TTL = 2_000
const DEFAULT_DISPLAY = 180
const MAX_DISPLAY = 720 // 客户端要在时间轴上往回拖，所以一次给足整条序列
const REQUEST_TIMEOUT = 12_000

const ENVIRONMENTS = {
  prod: {
    id: 'prod',
    label: '生产',
    note: '实盘行情（不带模拟头）',
    simulated: false,
    keyVar: 'PROD_OKX_API_KEY',
    secretVar: 'PROD_OKX_API_SECRET',
  },
  demo: {
    id: 'demo',
    label: '模拟',
    note: '模拟盘（x-simulated-trading: 1）',
    simulated: true,
    keyVar: 'DEBUG_OKX_API_KEY',
    secretVar: 'DEBUG_OKX_API_SECRET',
  },
}

// ------------------------------------------------------------------ 小工具

function describe(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

function clamp(value, lo, hi) {
  const n = Number(value)
  if (!isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

function num(value) {
  const n = Number(value)
  return isFinite(n) ? n : null
}

function round(value, digits) {
  const n = num(value)
  return n === null ? null : Number(n.toFixed(digits))
}

function isBarId(id) {
  return BARS.some((bar) => bar.id === id)
}

function barById(id) {
  return BARS.find((bar) => bar.id === id) || BARS.find((bar) => bar.id === DEFAULT_BAR)
}

/** 把 OKX 的 K 线数组行转成对象；OKX 顺序：ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm。 */
function normalizeRow(row) {
  if (!Array.isArray(row) || row.length < 6) return null
  const t = num(row[0])
  const o = num(row[1])
  const h = num(row[2])
  const l = num(row[3])
  const c = num(row[4])
  const v = num(row[5])
  if (t === null || o === null || h === null || l === null || c === null) return null
  return { t, o, h, l, c, v: v === null ? 0 : v, done: row[8] === '1' || row[8] === 1 }
}

/** 按时间升序去重：同一时间戳以「后写入的」为准（近端数据比历史页新）。 */
function dedupeRows(rows) {
  const map = new Map()
  for (const row of rows) {
    if (row !== null && row !== undefined) map.set(row.t, row)
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t)
}

/** EMA：用前 period 根的 SMA 做种子，之后递推。前 period-1 位是 null（数据不够）。 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null)
  if (!Array.isArray(values) || values.length < period || period < 1) return out
  let sum = 0
  for (let i = 0; i < period; i += 1) sum += values[i]
  let prev = sum / period
  out[period - 1] = prev
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

// ------------------------------------------------------------------ .env / 状态

/** 极简 .env 解析：支持 export、引号、行尾 # 注释。 */
export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    const quoted = value.length > 1
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    else {
      const hash = value.indexOf(' #')
      if (hash > 0) value = value.slice(0, hash).trim()
    }
    out[match[1]] = value
  }
  return out
}

function fileVars() {
  try {
    return parseEnvFile(readFileSync(ENV_FILE, 'utf8'))
  } catch (error) {
    return {}
  }
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

function writeState(patch) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(Object.assign({}, readState(), patch), null, 1), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

/** 把密钥收成可展示的指纹：只露前 6 后 4，secret 永不外传。 */
function maskKey(value) {
  const text = String(value === undefined || value === null ? '' : value)
  if (text.length === 0) return null
  if (text.length <= 12) return text.slice(0, 3) + '…'
  return text.slice(0, 6) + '…' + text.slice(-4)
}

/** 每 30 秒重读一次 .env：改完钥匙不用重启宿主。 */
let envCache = { at: 0, vars: {} }
function vars() {
  const now = Date.now()
  if (now - envCache.at > 30_000) envCache = { at: now, vars: fileVars() }
  return envCache.vars
}

function setting(key) {
  const fromProcess = process.env[key]
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess
  const v = vars()
  return v[key] !== undefined && v[key] !== '' ? v[key] : undefined
}

function proxySetting() {
  const raw = setting('DSH_BTC_PROXY') || setting('OKX_PROXY') || DEFAULT_PROXY
  if (raw === 'off' || raw === 'none' || raw === '') return null
  try {
    const url = new URL(raw)
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return { raw: raw, host: url.hostname, port: port }
  } catch (error) {
    return null
  }
}

function currentSettings() {
  const state = readState()
  const envId = ENVIRONMENTS[state.env] === undefined ? DEFAULT_ENV : state.env
  const def = ENVIRONMENTS[envId]
  const key = setting(def.keyVar)
  const secret = setting(def.secretVar)
  const instId = setting('OKX_INSTID') || DEFAULT_INSTID
  return {
    envId: envId,
    def: def,
    instId: /^[A-Za-z0-9-]{4,32}$/.test(instId) ? instId : DEFAULT_INSTID,
    barId: isBarId(state.bar) ? state.bar : DEFAULT_BAR,
    proxy: proxySetting(),
    key: key === undefined ? null : key,
    secret: secret === undefined ? null : secret,
  }
}

function envView(cfg) {
  return {
    id: cfg.def.id,
    label: cfg.def.label,
    note: cfg.def.note,
    simulated: cfg.def.simulated,
    keyVar: cfg.def.keyVar,
    secretVar: cfg.def.secretVar,
    keyMasked: maskKey(cfg.key),
    hasKey: typeof cfg.key === 'string' && cfg.key.length > 0,
    hasSecret: typeof cfg.secret === 'string' && cfg.secret.length > 0,
  }
}

// ------------------------------------------------------------------ HTTP 传输（直连 / 本地代理隧道）

const NEED_MORE = { needMore: true }
let transportMemo = null // 上次成功的通道：'proxy' | 'direct'
let lastTransportError = null

/** 解 chunked 正文，返回 { body, consumed }；数据不够返回 null。 */
function tryDecodeChunked(buf) {
  const parts = []
  let pos = 0
  for (;;) {
    const nl = buf.indexOf('\r\n', pos)
    if (nl < 0) return null
    const sizeLine = buf.subarray(pos, nl).toString('latin1').trim()
    const size = parseInt(sizeLine.split(';')[0], 16)
    if (!isFinite(size)) return { body: Buffer.alloc(0), consumed: nl + 2 }
    if (size === 0) {
      // 结束块后面可能还有 trailer，找空行
      const end = buf.indexOf('\r\n\r\n', nl)
      if (end >= 0) return { body: Buffer.concat(parts), consumed: end + 4 }
      if (buf.length >= nl + 4) return { body: Buffer.concat(parts), consumed: nl + 4 }
      return null
    }
    if (buf.length < nl + 2 + size + 2) return null
    parts.push(buf.subarray(nl + 2, nl + 2 + size))
    pos = nl + 2 + size + 2
  }
}

function tryDecode(buf) {
  const sep = buf.indexOf('\r\n\r\n')
  if (sep < 0) return NEED_MORE
  const head = buf.subarray(0, sep).toString('latin1')
  const lines = head.split('\r\n')
  const status = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0])
  if (status === null) return NEED_MORE
  const headers = {}
  for (let i = 1; i < lines.length; i += 1) {
    const colon = lines[i].indexOf(':')
    if (colon > 0) headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim()
  }
  const body = buf.subarray(sep + 4)
  if (/chunked/i.test(headers['transfer-encoding'] || '')) {
    const decoded = tryDecodeChunked(body)
    if (decoded === null) return NEED_MORE
    return {
      status: Number(status[1]),
      headers: headers,
      body: decoded.body,
      consumed: sep + 4 + decoded.consumed,
    }
  }
  const len = headers['content-length'] === undefined ? NaN : Number(headers['content-length'])
  if (isFinite(len)) {
    if (body.length < len) return NEED_MORE
    return { status: Number(status[1]), headers: headers, body: body.subarray(0, len), consumed: sep + 4 + len }
  }
  // 既没有 Content-Length 也没有 chunked：只能读到连接关闭为止
  return { status: Number(status[1]), headers: headers, body: body, consumed: buf.length, unbounded: true }
}

/** 打开一条到目标的 TLS 连接；走代理时先 CONNECT 再在隧道上握 TLS。 */
function openSocket(target, host, port, timeoutMs, proxy) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (target === 'proxy') {
      const raw = netConnect({ host: proxy.host, port: proxy.port })
      let seen = ''
      const onData = (chunk) => {
        seen += chunk.toString('latin1')
        const end = seen.indexOf('\r\n\r\n')
        if (end < 0) return
        raw.removeListener('data', onData)
        const code = Number((/^HTTP\/1\.[01]\s+(\d{3})/.exec(seen) || [])[1] || 0)
        if (code !== 200) {
          raw.destroy()
          rejectPromise(new Error('本地代理拒绝 CONNECT（HTTP ' + String(code) + '）'))
          return
        }
        const tls = tlsConnect({ socket: raw, servername: host })
        tls.once('secureConnect', () => {
          tls.removeListener('error', rejectPromise)
          // CONNECT 阶段的超时必须撤掉：隧道要留着复用（keep-alive），空闲超时由请求侧管
          raw.setTimeout(0)
          resolvePromise(tls)
        })
        tls.once('error', rejectPromise)
      }
      raw.on('data', onData)
      raw.once('error', rejectPromise)
      raw.setTimeout(timeoutMs, () => {
        raw.destroy()
        rejectPromise(new Error('连接本地代理 ' + proxy.host + ':' + String(proxy.port) + ' 超时'))
      })
      raw.write('CONNECT ' + host + ':' + String(port) + ' HTTP/1.1\r\nHost: ' + host + ':' + String(port) + '\r\n\r\n')
      return
    }
    const socket = tlsConnect({ host: host, port: port, servername: host })
    socket.once('secureConnect', () => {
      socket.removeListener('error', rejectPromise)
      resolvePromise(socket)
    })
    socket.once('error', rejectPromise)
  })
}

/**
 * 每个通道只保留一条 keep-alive 隧道。
 * 原因是实测出来的：本机代理（127.0.0.1:7897）对「每个请求新建一次 CONNECT」不友好 ——
 * 12 次请求里 2 次在 TLS 握手阶段被断开，平均 2.2 秒；复用隧道后 CONNECT 只做一次。
 * 同一通道上的请求串行化：一条 TCP 连接上不做 pipelining。
 */
const tunnels = new Map()
const tunnelChains = new Map()
const TUNNEL_IDLE_MS = 60_000

function tunnelKey(target, proxy) {
  return target === 'proxy' ? 'proxy:' + String(proxy === null ? '' : proxy.raw) : 'direct'
}

function dropTunnel(key) {
  const entry = tunnels.get(key)
  tunnels.delete(key)
  if (entry !== undefined) {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    if (entry.socket !== null) {
      try { entry.socket.destroy() } catch (error) { /* 已经断了 */ }
    }
  }
}

/**
 * 空闲超时用普通定时器，不用 socket.setTimeout(ms, cb)：
 * 后者每调一次就挂一个 'timeout' 监听，连发十几个请求就会报 MaxListenersExceededWarning。
 */
function armIdle(key, entry) {
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => dropTunnel(key), TUNNEL_IDLE_MS)
  if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref()
}

function serialize(key, task) {
  const previous = tunnelChains.get(key) || Promise.resolve()
  const next = previous.then(task, task)
  tunnelChains.set(key, next.then(() => undefined, () => undefined))
  return next
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function writeAndRead(entry, url, headers, timeoutMs) {
  const parsed = new URL(url)
  const socket = entry.socket
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('end', onEnd)
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      cleanup()
      socket.setTimeout(0)
      resolvePromise(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.setTimeout(0)
      rejectPromise(error)
    }
    const onData = (chunk) => {
      entry.buffer = Buffer.concat([entry.buffer, chunk])
      const decoded = tryDecode(entry.buffer)
      if (decoded === NEED_MORE) return
      entry.buffer = entry.buffer.subarray(decoded.consumed)
      finish(decoded)
    }
    const onEnd = () => {
      const decoded = tryDecode(entry.buffer)
      if (decoded === NEED_MORE) fail(new Error('响应不完整（连接被提前关闭）'))
      else finish(decoded)
    }
    const onError = (error) => fail(error)
    const onTimeout = () => fail(new Error('读取 ' + parsed.hostname + ' 响应超时'))
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('error', onError)
    socket.on('timeout', onTimeout)
    socket.setTimeout(timeoutMs)
    const lines = [
      'GET ' + (parsed.pathname + parsed.search) + ' HTTP/1.1',
      'Host: ' + parsed.host,
      'Connection: keep-alive',
      'Accept: application/json',
      'Accept-Encoding: identity',
    ]
    for (const name of Object.keys(headers || {})) lines.push(name + ': ' + headers[name])
    socket.write(lines.join('\r\n') + '\r\n\r\n')
  })
}

async function requestViaTunnel(target, url, headers, timeoutMs, proxy) {
  const key = tunnelKey(target, proxy)
  return serialize(key, async () => {
    let entry = tunnels.get(key)
    if (entry === undefined || entry.socket.destroyed === true) {
      dropTunnel(key)
      const socket = await openSocket(target, OKX_HOST, 443, timeoutMs, proxy)
      entry = { socket: socket, buffer: Buffer.alloc(0), idleTimer: null }
      tunnels.set(key, entry)
      socket.on('error', () => dropTunnel(key))
      socket.on('close', () => dropTunnel(key))
    }
    try {
      const res = await writeAndRead(entry, url, headers, timeoutMs)
      if (/close/i.test(res.headers.connection || '')) dropTunnel(key)
      else armIdle(key, entry)
      return res
    } catch (error) {
      dropTunnel(key)
      throw error
    }
  })
}

/** 单次请求；自检脚本直接用它。 */
export async function rawGet(target, url, headers, timeoutMs, proxy) {
  return requestViaTunnel(target, url, headers, timeoutMs, proxy)
}

/** 先按上次成功的通道试（各 2 次），失败再换另一条；两条都失败才抛错。 */
async function httpGet(url, headers) {
  const proxy = proxySetting()
  const order = transportMemo === 'direct' ? ['direct', 'proxy'] : ['proxy', 'direct']
  const errors = []
  for (const target of order) {
    if (target === 'proxy' && proxy === null) continue
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await requestViaTunnel(target, url, headers, REQUEST_TIMEOUT, proxy)
        transportMemo = target
        if (target === 'proxy') lastTransportError = null
        return res
      } catch (error) {
        errors.push(target + ' 第' + String(attempt + 1) + '次：' + describe(error))
        if (target === 'proxy') lastTransportError = describe(error)
        if (attempt === 0) await delay(150)
      }
    }
  }
  throw new Error(errors.join('；'))
}

/** 取 OKX 公开接口并解出 data；返回 { ok, data, error }。 */
async function okxApi(cfg, path) {
  const headers = {}
  if (cfg.def.simulated) headers['x-simulated-trading'] = '1'
  let res
  try {
    res = await httpGet('https://' + OKX_HOST + path, headers)
  } catch (error) {
    const proxy = cfg.proxy
    const hint = proxy === null
      ? '（未配置代理，本机 DNS 可能把 ' + OKX_HOST + ' 解析到黑洞地址）'
      : '（本地代理 ' + proxy.raw + ' 是否在运行？）'
    return { ok: false, error: '连不上 OKX' + hint + '：' + describe(error) }
  }
  const text = res.body.toString('utf8')
  if (res.status !== 200) return { ok: false, error: 'OKX HTTP ' + String(res.status) + '：' + text.slice(0, 200) }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: 'OKX 返回的不是 JSON：' + text.slice(0, 200) }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.code !== '0') {
    const message = parsed !== null && typeof parsed === 'object' ? parsed.msg : undefined
    return { ok: false, error: 'OKX 接口报错：' + String(message || 'code=' + String(parsed && parsed.code)) }
  }
  return { ok: true, data: Array.isArray(parsed.data) ? parsed.data : [] }
}

// ------------------------------------------------------------------ 数据装配

const tickerCache = new Map()
const seriesCache = new Map()
const historyCache = new Map()

async function fetchTicker(cfg, force) {
  const key = cfg.envId + '|' + cfg.instId
  const now = Date.now()
  const hit = tickerCache.get(key)
  if (hit !== undefined && (force !== true ? now - hit.at < TICKER_TTL : false)) return hit.value
  const res = await okxApi(cfg, '/api/v5/market/ticker?instId=' + encodeURIComponent(cfg.instId))
  if (res.ok !== true) return { ok: false, error: res.error }
  const row = res.data[0]
  if (row === undefined) return { ok: false, error: '行情为空（instId=' + cfg.instId + '）' }
  const last = num(row.last)
  const open24h = num(row.open24h)
  const value = {
    ok: true,
    ticker: {
      instId: row.instId,
      last: last,
      lastSz: num(row.lastSz),
      bid: num(row.bidPx),
      bidSz: num(row.bidSz),
      ask: num(row.askPx),
      askSz: num(row.askSz),
      open24h: open24h,
      high24h: num(row.high24h),
      low24h: num(row.low24h),
      vol24h: num(row.vol24h),
      volCcy24h: num(row.volCcy24h),
      ts: num(row.ts),
      change24h: last === null || open24h === null ? null : Number((last - open24h).toFixed(2)),
      changePct: last === null || open24h === null || open24h === 0
        ? null : Number((((last - open24h) / open24h) * 100).toFixed(3)),
    },
  }
  tickerCache.set(key, { at: now, value: value })
  return value
}

async function fetchRecent(cfg, bar) {
  const path = '/api/v5/market/candles?instId=' + encodeURIComponent(cfg.instId)
    + '&bar=' + encodeURIComponent(bar.okx) + '&limit=' + String(RECENT_LIMIT)
  const res = await okxApi(cfg, path)
  if (res.ok !== true) return { ok: false, error: res.error }
  return { ok: true, rows: res.data.map(normalizeRow).filter(Boolean) }
}

async function fetchHistoryPage(cfg, bar, afterTs) {
  const path = '/api/v5/market/history-candles?instId=' + encodeURIComponent(cfg.instId)
    + '&bar=' + encodeURIComponent(bar.okx) + '&after=' + String(afterTs)
    + '&limit=' + String(HISTORY_LIMIT)
  const res = await okxApi(cfg, path)
  if (res.ok !== true) return { ok: false, error: res.error }
  return { ok: true, rows: res.data.map(normalizeRow).filter(Boolean) }
}

/**
 * 取足够算 EMA480 的 K 线序列（目标 720 根）。
 * 最近一段按 HOT_TTL 缓存；已收盘的历史按 HISTORY_TTL 缓存，所以刷新通常只打一次 candles。
 */
async function loadSeries(cfg, bar, force) {
  const key = cfg.envId + '|' + cfg.instId + '|' + bar.id
  const now = Date.now()
  const hit = seriesCache.get(key)
  if (hit !== undefined && force !== true && now - hit.at < HOT_TTL) {
    return { ok: true, rows: hit.rows, cached: true, at: hit.at, pages: 0 }
  }
  const recent = await fetchRecent(cfg, bar)
  if (recent.ok !== true) {
    if (hit !== undefined) return { ok: true, rows: hit.rows, cached: true, at: hit.at, pages: 0, warning: recent.error }
    return { ok: false, error: recent.error }
  }
  let rows = recent.rows
  if (hit !== undefined && rows.length > 0) {
    const oldest = rows[0].t
    rows = hit.rows.filter((row) => row.t < oldest).concat(rows)
  }
  rows = dedupeRows(rows)
  // 热缓存里可能还留着更多的历史（MAX_PAGES 上限以内），超出 SERIES_BARS 的先削掉：
  // 既省内存，也让下面「还差多少根」的判断不会被旧数据干扰。
  if (rows.length > SERIES_BARS) rows = rows.slice(rows.length - SERIES_BARS)

  let pages = 0
  let warning = null
  while (rows.length < SERIES_BARS && pages < MAX_PAGES) {
    if (rows.length === 0) break
    const after = rows[0].t
    const hkey = key + '|' + String(after)
    const hc = historyCache.get(hkey)
    let page
    if (hc !== undefined && now - hc.at < HISTORY_TTL) {
      page = hc.rows
    } else {
      const fetched = await fetchHistoryPage(cfg, bar, after)
      if (fetched.ok !== true) {
        warning = fetched.error
        break
      }
      page = fetched.rows
      historyCache.set(hkey, { at: now, rows: page })
    }
    if (page.length === 0) break
    rows = dedupeRows(page.concat(rows))
    pages += 1
  }
  if (rows.length > SERIES_BARS) rows = rows.slice(rows.length - SERIES_BARS)
  if (rows.length > 0) seriesCache.set(key, { at: now, rows: rows })
  return { ok: rows.length > 0, rows: rows, cached: false, at: now, pages: pages, warning: warning, error: rows.length > 0 ? null : '没有取到 K 线' }
}

function dropCacheFor(envId) {
  for (const key of Array.from(tickerCache.keys())) if (key.startsWith(envId + '|')) tickerCache.delete(key)
  for (const key of Array.from(seriesCache.keys())) if (key.startsWith(envId + '|')) seriesCache.delete(key)
  for (const key of Array.from(historyCache.keys())) if (key.startsWith(envId + '|')) historyCache.delete(key)
}

/**
 * 组装看板载荷。
 *
 * `candles` 发的是**整条序列**（SERIES_BARS 根，含最前面那段只用于给均线预热的 K 线），
 * 因为若只发最后 MAX_DISPLAY 根，浏览器侧就只能在那 720 根上重新播种：
 * EMA480 会退化成「480 根 SMA」，和这里的收敛值差一截。
 * `tags` 里额外给出「默认展示窗口」那一段的统计（窗口高低/涨跌），供不用序列口径的地方参考。
 */
function buildBoard(cfg, bar, series, ticker, options) {
  const opts = options === undefined || options === null ? {} : options
  const rows = series.rows
  const closes = rows.map((row) => row.c)
  const ema20 = ema(closes, EMA_FAST)
  const ema480 = ema(closes, EMA_SLOW)
  // 默认展示窗口（最后 MAX_DISPLAY 根）只用来算「窗口统计」，发给浏览器的是整条序列
  const window = rows.slice(Math.max(0, rows.length - MAX_DISPLAY))
  const last = window.length > 0 ? window[window.length - 1].c : null
  const e20Last = ema20.length > 0 ? ema20[ema20.length - 1] : null
  const e480Last = ema480.length > 0 ? ema480[ema480.length - 1] : null
  let high = null
  let low = null
  let volume = 0
  for (const row of window) {
    high = high === null ? row.h : Math.max(high, row.h)
    low = low === null ? row.l : Math.min(low, row.l)
    volume += row.v
  }
  const warnings = []
  if (series.warning) warnings.push(series.warning)
  if (rows.length < EMA_SLOW) warnings.push('只取到 ' + String(rows.length) + ' 根 K 线，EMA480 还画不出来')
  if (typeof cfg.key !== 'string' || cfg.key.length === 0) {
    warnings.push('.env 里没有 ' + cfg.def.keyVar + '（行情是公开接口，不影响取价）')
  }

  return {
    ok: true,
    env: envView(cfg),
    instId: cfg.instId,
    bar: bar.id,
    bars: BARS.map((item) => ({ id: item.id, label: item.label })),
    fetchedAt: Date.now(),
    transport: transportMemo,
    proxy: cfg.proxy === null ? null : cfg.proxy.raw,
    price: ticker === null || ticker.ok !== true ? null : ticker.ticker,
    // 整条序列：浏览器在它上面现算均线，并按窗口切片
    candles: rows.map((row) => [row.t, row.o, row.h, row.l, row.c, row.v]),
    // 与 candles 等长对齐的均线（同一套口径、同一条序列）；浏览器若用默认周期，结果与这里逐点相同
    ema20: ema20,
    ema480: ema480,
    stats: {
      seriesCount: rows.length,
      displayed: rows.length,
      windowBars: window.length,
      warmupBars: rows.length - window.length,
      seriesFrom: rows.length > 0 ? rows[0].t : null,
      seriesTo: rows.length > 0 ? rows[rows.length - 1].t : null,
      emaFast: EMA_FAST,
      emaSlow: EMA_SLOW,
      ema20Last: round(e20Last, 2),
      ema480Last: round(e480Last, 2),
      vsEma20Pct: last === null || e20Last === null ? null : Number((((last - e20Last) / e20Last) * 100).toFixed(3)),
      vsEma480Pct: last === null || e480Last === null ? null : Number((((last - e480Last) / e480Last) * 100).toFixed(3)),
      windowHigh: round(high, 2),
      windowLow: round(low, 2),
      windowVolume: round(volume, 4),
      lastClose: last,
      firstClose: window.length > 0 ? window[0].c : null,
      windowChangePct: window.length > 1 && window[0].c !== 0
        ? Number((((last - window[0].c) / window[0].c) * 100).toFixed(3)) : null,
      lastCandleAt: window.length > 0 ? window[window.length - 1].t : null,
      lastCandleDone: window.length > 0 ? window[window.length - 1].done : null,
    },
    meta: {
      // 不回 workspace 绝对路径：这份载荷是给浏览器的，本机目录与用户名没有必要外传
      barMs: bar.ms,
      cached: series.cached === true,
      pages: series.pages === undefined ? 0 : series.pages,
      seriesTarget: SERIES_BARS,
      warnings: warnings,
    },
  }
}

/** 取一次完整看板数据（客户端 /dsh-btc/board 用的就是这个）。 */
export async function boardPayload(options) {
  const opts = options === undefined || options === null ? {} : options
  const started = Date.now()
  const cfg = currentSettings()
  const bar = barById(opts.bar === undefined || opts.bar === null || opts.bar === '' ? cfg.barId : opts.bar)
  const instId = opts.instId !== undefined && /^[A-Za-z0-9-]{4,32}$/.test(String(opts.instId))
    ? String(opts.instId) : cfg.instId
  const scoped = Object.assign({}, cfg, { instId: instId })
  try {
    const ticker = await fetchTicker(scoped, opts.force === true)
    const series = await loadSeries(scoped, bar, opts.force === true)
    if (series.ok !== true) {
      return {
        ok: false,
        error: series.error,
        env: envView(cfg),
        instId: instId,
        bar: bar.id,
        bars: BARS.map((item) => ({ id: item.id, label: item.label })),
        transport: transportMemo,
        proxy: cfg.proxy === null ? null : cfg.proxy.raw,
        price: ticker.ok === true ? ticker.ticker : null,
        latencyMs: Date.now() - started,
      }
    }
    const payload = buildBoard(scoped, bar, series, ticker, opts)
    payload.latencyMs = Date.now() - started
    return payload
  } catch (error) {
    return {
      ok: false,
      error: '取数失败：' + describe(error),
      env: envView(cfg),
      instId: instId,
      bar: bar.id,
      bars: BARS.map((item) => ({ id: item.id, label: item.label })),
      transport: transportMemo,
      proxy: cfg.proxy === null ? null : cfg.proxy.raw,
      latencyMs: Date.now() - started,
    }
  }
}

export function healthPayload() {
  const cfg = currentSettings()
  const states = {}
  for (const id of Object.keys(ENVIRONMENTS)) {
    const def = ENVIRONMENTS[id]
    const key = setting(def.keyVar)
    const secret = setting(def.secretVar)
    states[id] = {
      label: def.label,
      keyVar: def.keyVar,
      secretVar: def.secretVar,
      keyMasked: maskKey(key),
      hasKey: typeof key === 'string' && key.length > 0,
      hasSecret: typeof secret === 'string' && secret.length > 0,
    }
  }
  return {
    ok: true,
    version: version,
    workspace: WORKSPACE,
    envFile: ENV_FILE,
    envFilePresent: existsSync(ENV_FILE),
    env: envView(cfg),
    environments: states,
    instId: cfg.instId,
    bar: cfg.barId,
    bars: BARS.map((item) => ({ id: item.id, label: item.label })),
    ema: { fast: EMA_FAST, slow: EMA_SLOW },
    seriesTarget: SERIES_BARS,
    proxy: cfg.proxy === null ? null : cfg.proxy.raw,
    transport: transportMemo,
    lastTransportError: lastTransportError,
    caches: { ticker: tickerCache.size, series: seriesCache.size, history: historyCache.size },
    now: Date.now(),
  }
}

// ------------------------------------------------------------------ 路由

function readBody(req, limitBytes) {
  return new Promise((resolvePromise) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limitBytes) parts.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(parts).toString('utf8')))
    req.on('error', () => resolvePromise(''))
  })
}

function query(req, name) {
  try {
    const url = new URL(req.url === undefined || req.url === null ? '/' : req.url, 'http://local')
    const value = url.searchParams.get(name)
    return value === null ? '' : value
  } catch (error) {
    return ''
  }
}

export function apply(ctx) {
  let server = null
  let bound = false
  let lastError = null

  const json = (res, value, status) => {
    res.writeHead(status === undefined ? 200 : status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  /**
   * 信任栅栏：这几条路由是直接挂在 webServer 上的，绕过了 DSH 给 /api 的那套检查，
   * 所以要自己向 `connection` 服务要一个判定。`requestRejection` 一次覆盖三件事：
   *   - Host 栅栏（防 DNS rebinding：攻击者域名会被浏览器填进 Host，这里对不上）
   *   - `sec-fetch-site: cross-site` 与 Origin 栅栏（跨站页面发起的请求一律拒）
   *   - 浏览器鉴权（同源请求带的那个签名 HttpOnly cookie）
   * 同源的面板请求会正常通过；被拒时写 401/403 并把请求就此结束。
   *
   * 判定不可用时**拒绝**而不是放行：这是安全边界，宁可面板报错也不能静默降级成无防护。
   */
  const rejected = (req, res) => {
    let rejection
    try {
      const connection = ctx.get('connection')
      if (connection === undefined || connection === null) {
        json(res, { ok: false, error: '缺少 connection 服务，无法校验请求来源' }, 503)
        return true
      }
      rejection = connection.requestRejection(req)
    } catch (error) {
      lastError = describe(error)
      json(res, { ok: false, error: '请求来源校验失败：' + describe(error) }, 503)
      return true
    }
    if (rejection === undefined) return false
    res.writeHead(rejection)
    res.end()
    return true
  }

  const route = (path, handle) => {
    ctx.effect(() => server.register({
      kind: 'exact',
      path: path,
      handler: (req, res) => {
        Promise.resolve()
          .then(() => (rejected(req, res) ? undefined : handle(req, res)))
          .catch((error) => {
            lastError = describe(error)
            json(res, { ok: false, error: describe(error) })
          })
      },
    }), 'dsh-btc-dashboard: ' + path)
  }

  function registerRoutes(target) {
    // 看板主数据
    route('/dsh-btc/board', async (req, res) => {
      const payload = await boardPayload({
        bar: query(req, 'bar'),
        instId: query(req, 'instId'),
        limit: query(req, 'limit'),
        force: query(req, 'force') === '1',
      })
      if (payload.ok === true && isBarId(payload.bar)) {
        // 只在选择真的变了的时候落盘，避免每 5 秒写一次状态文件
        const saved = readState()
        if (saved.bar !== payload.bar || saved.env !== payload.env.id) {
          writeState({ bar: payload.bar, env: payload.env.id })
        }
      }
      json(res, payload)
    })

    // 侧边栏用的轻量接口：只要最新价
    route('/dsh-btc/price', async (req, res) => {
      const cfg = currentSettings()
      const ticker = await fetchTicker(cfg, query(req, 'force') === '1')
      json(res, {
        ok: ticker.ok === true,
        error: ticker.ok === true ? null : ticker.error,
        env: envView(cfg),
        instId: cfg.instId,
        transport: transportMemo,
        price: ticker.ok === true ? ticker.ticker : null,
        now: Date.now(),
      })
    })

    // 环境切换：只认 POST（body {"env":"prod"}）—— 这是唯一的写操作，所以不让 GET 也能改状态。
    route('/dsh-btc/env', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
        res.end(JSON.stringify({ ok: false, error: '环境切换只接受 POST，body 形如 {"env":"prod"}' }))
        return
      }
      let wanted = query(req, 'env')
      const raw = await readBody(req, 4096)
      try {
        const parsed = JSON.parse(raw === '' ? '{}' : raw)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.env === 'string') wanted = parsed.env
      } catch (error) {
        json(res, { ok: false, error: '请求体不是 JSON' })
        return
      }
      if (ENVIRONMENTS[wanted] === undefined) {
        json(res, { ok: false, error: '未知环境：' + String(wanted) + '（只认 prod / demo）' })
        return
      }
      const previous = currentSettings().envId
      writeState({ env: wanted })
      if (previous !== wanted) dropCacheFor(wanted)
      const cfg = currentSettings()
      json(res, {
        ok: true,
        previous: previous,
        env: envView(cfg),
        transport: transportMemo,
        proxy: cfg.proxy === null ? null : cfg.proxy.raw,
      })
    })

    // 自检
    route('/dsh-btc/health', (req, res) => {
      const payload = healthPayload()
      payload.lastError = lastError
      payload.bound = bound
      json(res, payload)
    })
  }

  function bind() {
    if (server === null) server = ctx.get('webServer') ?? null
    if (!bound && server !== null && server !== undefined) {
      registerRoutes(server)
      bound = true
    }
  }

  // apply 跑在启动早期，webServer 往往还没 ACTIVE：先试一次，再每秒补试。
  try {
    bind()
  } catch (error) {
    lastError = describe(error)
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        bind()
      } catch (error) {
        lastError = describe(error)
      }
    }, 1000)
    return () => { clearInterval(timer) }
  }, 'dsh-btc-dashboard: bind loop')
}
