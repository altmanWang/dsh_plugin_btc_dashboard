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
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-btc-dashboard'
/**
 * 版本号**从 package.json 读**，不再手写常量。
 *
 * 为什么改：以前这里是硬编码的 `'1.3.2'`，package.json 已经到 1.5.0 了它还是 1.3.2。
 * `/health` 报的 `version` 因此永远停在旧值 —— 排障时"宿主到底跑的是哪份代码"
 * 这个最关键的问题，反而被这个滞后的常量误导过（我按它判断过一轮）。
 * 读取失败就退回一个明显异常的标记，宁可难看也不要给出误导性的答案。
 */
function readOwnVersion() {
  try {
    // ⚠️ 用 `import.meta.url` 自己算目录，**不要**引用下面那个 `HERE` 常量：
    // 本函数在模块顶层就被调用（`export const version = readOwnVersion()`），
    // 而 `const HERE` 那时还在 TDZ —— 连 `typeof HERE` 都会抛 ReferenceError
    // （`typeof` 只对"未声明的变量"安全，对 TDZ 里的 let/const 会抛）。
    // 这个坑让 version 一直返回 'unknown'，真踩过。
    const dir = dirname(fileURLToPath(import.meta.url))
    const file = join(dir, 'package.json')
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    if (pkg !== null && typeof pkg.version === 'string' && pkg.version !== '') {
      // 带上 package.json 的修改时间做"构建指纹"：改了代码没重启，指纹不会变。
      const stamp = Math.round(statSync(file).mtimeMs)
      return pkg.version + '+' + String(stamp)
    }
  } catch (error) { /* 落到下面的兜底 */ }
  return 'unknown'
}

export const version = readOwnVersion()

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

/**
 * 支持的合约标的（白名单）：浏览器只能在这几个之间切换，避免拿任意 instId 去拉 OKX 数据。
 * 前端 client.js 的 INST_OPTIONS 与这里保持同一份口径（label/short 用于标题与单位）。
 */
export const SUPPORTED_INSTS = Object.freeze([
  { instId: 'BTC-USDT-SWAP', label: 'BTCUSDT 永续', short: 'BTC' },
  { instId: 'ETH-USDT-SWAP', label: 'ETHUSDT 永续', short: 'ETH' },
])

/** 把外部传进来的 instId 规范成白名单里的值；不合法返回 null（调用方决定回落还是报错）。 */
export function normalizeInstId(raw) {
  if (typeof raw !== 'string') return null
  const wanted = raw.trim()
  if (wanted === '') return null
  const found = SUPPORTED_INSTS.find((item) => item.instId === wanted)
  return found === undefined ? null : found.instId
}

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

/**
 * 主动关掉所有 keep-alive 隧道。
 *
 * 宿主里用不到（隧道空闲 60 秒会自己断，进程也不退出）；它存在是因为**回测 CLI / 离线脚本
 * 直接 import 本文件**：那些进程跑完就该退出，而挂着的 TLS socket 会让 Node 一直不结束
 * —— 表现为「跑完了还卡着」，最容易被误当成死循环。谁创建的连接谁负责关。
 */
export function closeTransport() {
  for (const key of Array.from(tunnels.keys())) dropTunnel(key)
  tunnelChains.clear()
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
    // 整条序列：浏览器在它上面现算均线，并按窗口切片。
    // ⚠️ 第 7 位 `done` 必须带上：客户端靠它判「这根收线了没」——
    // 收线预警（`closedAlertCursor`）找的就是"最后一根 done 的 K 线"，
    // 未收盘那根的描边与"当前这一列"底带也读它。少这一位，两者都静默失效。
    candles: rows.map((row) => [row.t, row.o, row.h, row.l, row.c, row.v, row.done === true ? 1 : 0]),
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
  // 标的：只认白名单（BTC/ETH）；没传或非法就回落到 Host 配置的默认标的
  const requestedInst = normalizeInstId(opts.instId)
  const instId = requestedInst === null ? cfg.instId : requestedInst
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
    // 与 boardPayload 同一口径：这份载荷也是给浏览器的，本机绝对路径（含用户名）不回
    envFilePresent: existsSync(ENV_FILE),
    env: envView(cfg),
    environments: states,
    instId: cfg.instId,
    insts: SUPPORTED_INSTS.map((item) => Object.assign({}, item)),
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

// ------------------------------------------------------------------ 回测（驱动 backtest/ 框架）
//
// 设计要点（改之前先看一眼）：
//   1. 回测框架是仓库里的独立目录 `backtest/`，插件**不复制**它的代码，而是按需动态 import：
//      CLI 与看板跑的是同一份实现（策略只写一遍、撮合口径只有一处）。
//   2. 回测是长任务（首次抓一年 1h 要几十秒），所以做成 job：POST run 立刻返回 jobId，
//      浏览器轮询 status 拿进度。同一时间只允许一个 job —— 复用同一条代理隧道池，
//      并发跑只会互相抢限速，还让"报告属于哪一次"变得难以解释。
//   3. 宿主与看板共用插件里的 keep-alive 隧道池，所以回测 fetcher 必须
//      `closeTunnels:false`：回测收尾把隧道关了，可能让正在进行的看板刷新一起失败。
//   4. 找目录的候选顺序：`DSH_BTC_BACKTEST_DIR` → `<工作区>/backtest` → 插件上两级/backtest。
//      找不到就给中文错误，不影响看板其它功能（有人可能只安装了插件目录）。
//   5. 安全边界：浏览器只能传**内置策略名 + 参数 + 周期 + 数字**；不接受路径、dataDir、outDir。
//      报告 HTML 是只读生成的，响应带严格 CSP（报告本身零脚本/零外链）。

/** 内存里最多保留几个 job（每个带完整 HTML/JSON 报告，别无限涨）。 */
const BACKTEST_KEEP_JOBS = 5
/** 单次回测超时：1m 全量抓取可能很慢，20 分钟兜底。 */
const BACKTEST_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
/** run 请求体上限（表单就十几个字段）。 */
const BACKTEST_MAX_BODY_BYTES = 16 * 1024
/** 资金曲线降采样点数：浏览器画 600 点足够，报文小两个数量级。 */
const BACKTEST_EQUITY_POINTS = 600
/** 交易明细最多回传条数（表格只显示前 100 行）。 */
const BACKTEST_MAX_TRADES = 500
/** 预计根数超过它时前端提示「首次抓取可能较慢」。 */
const BACKTEST_MAX_BARS_HINT = 20_000
/** 与 data.mjs 的默认 maxPages 对齐（1m 一年会触顶，属于已知限制）。 */
const BACKTEST_MAX_PAGES = 2_000
/** 报告 HTML 的 CSP：零脚本、零外链、不许被 iframe。 */
const BACKTEST_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/**
 * 找仓库里的回测框架目录。按"越显式越优先"的顺序试，
 * 最后兜底用插件自己的位置往上两级 —— 插件装在 `<workspace>/plugin/dsh-btc-dashboard` 时正好对上。
 */
function findBacktestRoot() {
  const candidates = []
  const fromEnv = setting('DSH_BTC_BACKTEST_DIR')
  if (typeof fromEnv === 'string' && fromEnv !== '') candidates.push(resolve(fromEnv))
  candidates.push(join(WORKSPACE, 'backtest'))
  candidates.push(resolve(HERE, '..', '..', 'backtest'))
  for (const dir of candidates) {
    if (existsSync(join(dir, 'lib', 'engine.mjs')) && existsSync(join(dir, 'lib', 'data.mjs'))) return dir
  }
  return null
}

/**
 * 懒加载回测框架模块。
 * import 失败**缓存 rejected promise**：宿主缺 backtest/ 时每次请求都重试会刷屏日志，
 * 而这是"装错了目录"而不是"网络抖动"，重试不会变好。
 */
let backtestLibPromise = null
function loadBacktestLib() {
  if (backtestLibPromise !== null) return backtestLibPromise
  backtestLibPromise = (async () => {
    const root = findBacktestRoot()
    if (root === null) {
      throw new Error('找不到回测框架目录（backtest/）：请在仓库里保留该目录，或用 DSH_BTC_BACKTEST_DIR 指定位置')
    }
    const load = (name) => import(pathToFileURL(join(root, 'lib', name)).href)
    const modules = await Promise.all([
      load('config.mjs'), load('strategy.mjs'), load('data.mjs'), load('engine.mjs'),
      load('metrics.mjs'), load('report.mjs'), load('transport.mjs'),
    ])
    return {
      root: root,
      config: modules[0],
      strategy: modules[1],
      data: modules[2],
      engine: modules[3],
      metrics: modules[4],
      report: modules[5],
      transport: modules[6],
    }
  })()
  return backtestLibPromise
}

/** 金额四舍五入（只是给前端减字节，不参与任何计算）。 */
function roundNumber(value, digits) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Number(n.toFixed(digits))
}

/** 从 loadBars 的进度文案里抠出「已抓取 N 页」（抠不到就当没更新）。 */
function parsePageCount(message) {
  const match = /已抓取\s+(\d+)\s+页/.exec(String(message))
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** 策略参数白名单归一：只接受扁平对象里的数字/布尔/短字符串。 */
function normalizeParamsInput(raw) {
  if (raw === undefined || raw === null) return { ok: true, params: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'params 必须是对象（键=参数名，值=数字/布尔/字符串）' }
  }
  const keys = Object.keys(raw)
  if (keys.length > 20) return { ok: false, error: '策略参数太多（最多 20 个）' }
  const out = {}
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key)) {
      return { ok: false, error: '参数名不合法：' + JSON.stringify(key) }
    }
    const value = raw[key]
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { ok: false, error: '参数 ' + key + ' 不是有限数字' }
      out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'string') {
      if (value.length > 200) return { ok: false, error: '参数 ' + key + ' 太长（最多 200 字符）' }
      out[key] = value
    } else {
      return { ok: false, error: '参数 ' + key + ' 只能是数字/布尔/字符串' }
    }
  }
  return { ok: true, params: out }
}

/** 等步长降采样（首尾都保留）；相邻重复点去掉，免得画布上出现零长度线段。 */
function downsamplePoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length === 0) return []
  if (points.length <= maxPoints) return points.slice()
  const step = (points.length - 1) / (maxPoints - 1)
  const out = []
  for (let i = 0; i < maxPoints; i += 1) {
    const point = points[Math.round(i * step)]
    if (out.length === 0 || out[out.length - 1] !== point) out.push(point)
  }
  return out
}

/** 轮询报文里的 job 视图：去掉 HTML/完整 JSON 报告这些大字段。 */
function backtestJobView(job) {
  if (job === null || job === undefined) return null
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    message: job.message,
    progress: { pages: job.progress.pages, bars: job.progress.bars, pct: job.progress.pct },
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt === null ? Date.now() : job.finishedAt) - job.startedAt,
    cancelRequested: job.cancelRequested,
    error: job.error,
    summary: job.summary,
  }
}

/**
 * 把引擎结果裁成面板能直接画的一小份（INTEGRATION-SPEC §2.5 PanelSummary）。
 * 完整数据仍留在 job.jsonReport / job.html 里，走 report 路由取。
 */
function buildBacktestSummary(input) {
  const job = input.job
  const result = input.result
  const config = input.config
  const metrics = input.metrics
  const strategy = input.strategy
  const bars = input.bars
  const points = downsamplePoints(result.equityCurve, BACKTEST_EQUITY_POINTS)
  const firstClose = Array.isArray(bars) && bars.length > 0 ? bars[0].c : null
  const initial = result.initialEquity
  const equity = points.map((point) => ({
    t: point.t,
    equity: roundNumber(point.equity, 6),
    // Buy&Hold 基准：首根收盘价买入、按同一时间点收盘价估值（与 metrics 的基准口径一致，不含手续费）
    bh: firstClose !== null && firstClose > 0 && Number.isFinite(point.price)
      ? roundNumber(initial * point.price / firstClose, 6)
      : null,
  }))
  const trades = result.trades.length > BACKTEST_MAX_TRADES
    ? result.trades.slice(result.trades.length - BACKTEST_MAX_TRADES)
    : result.trades
  const suffix = '?jobId=' + encodeURIComponent(job.id) + '&format='
  return {
    generatedAt: input.generatedAt,
    instId: config.instId,
    bar: config.bar,
    strategy: { name: strategy.name, params: Object.assign({}, strategy.params) },
    start: config.start,
    end: config.end,
    range: {
      bars: result.range.bars,
      firstT: result.range.firstT,
      lastT: result.range.lastT,
      days: metrics.days,
    },
    initialEquity: result.initialEquity,
    finalEquity: roundNumber(result.finalEquity, 6),
    metrics: metrics,
    equity: equity,
    trades: trades,
    tradeCount: result.trades.length,
    fees: result.fees,
    // 资金费率（净支出；estimatedCount>0 表示区间里有按估算费率补的部分）
    funding: result.funding === undefined || result.funding === null ? null : {
      total: roundNumber(result.funding.total, 6),
      paid: roundNumber(result.funding.paid, 6),
      received: roundNumber(result.funding.received, 6),
      count: result.funding.count,
      estimatedCount: metrics.fundingEstimatedCount === undefined ? null : metrics.fundingEstimatedCount,
    },
    liquidations: result.liquidations.length,
    rejected: result.rejected.length,
    reports: {
      // 相对 API 前缀的路径：客户端 fetchJson() 会自己拼 /dsh-btc，别写成绝对路径
      html: '/backtest/report' + suffix + 'html',
      json: '/backtest/report' + suffix + 'json',
    },
  }
}

/**
 * 回测 job 服务。路由层只做 HTTP，业务全在这里。
 *
 * 可注入 `options.lib`（测试用）：形状与 lib/*.mjs 聚合对象一致，
 * 这样路由测试可以只把 data.loadBars 换成合成 K 线，engine/metrics/report 仍是真的。
 */
export function createBacktestService(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const injectedLib = opts.lib !== undefined && opts.lib !== null ? opts.lib : null
  const getLib = injectedLib !== null ? () => Promise.resolve(injectedLib) : loadBacktestLib
  const jobTimeoutMs = Number.isFinite(Number(opts.jobTimeoutMs)) && Number(opts.jobTimeoutMs) > 0
    ? Number(opts.jobTimeoutMs)
    : BACKTEST_DEFAULT_TIMEOUT_MS
  /** jobId → job；Map 保持插入顺序，淘汰最早的非运行中任务。 */
  const jobs = new Map()
  let counter = 0
  let lastJob = null

  function pruneJobs() {
    while (jobs.size > BACKTEST_KEEP_JOBS) {
      let victim = null
      for (const job of jobs.values()) {
        if (job.state === 'running' || job.state === 'queued') continue
        victim = job
        break
      }
      if (victim === null) return
      jobs.delete(victim.id)
    }
  }

  function activeJob() {
    for (const job of jobs.values()) {
      if (job.state === 'running' || job.state === 'queued') return job
    }
    return null
  }

  function finishJob(job, state, message) {
    job.state = state
    job.phase = state
    job.message = message
    if (job.finishedAt === null) job.finishedAt = Date.now()
    if (job.timer !== null) {
      clearTimeout(job.timer)
      job.timer = null
    }
  }

  function cancelReason(job) {
    if (job.timedOut === true) return '回测超时（' + String(Math.round(jobTimeoutMs / 60000)) + ' 分钟），已停止'
    return '回测已取消'
  }

  async function executeJob(job) {
    const lib = await getLib()
    try {
      // ---- 1) 数据：loadBars / fetcher 的 log 直接变成面板上的进度文案
      job.phase = 'data'
      job.message = '正在获取历史 K 线…'
      // 进度回调同时交给 fetcher（每页进度）和 loadBars（缓存命中/缺口等说明），面板只看一份文案
      const progress = (message) => {
        if (job.state !== 'running' || job.cancelRequested === true) return
        const text = String(message === undefined ? '' : message)
        if (text !== '') job.message = text
        const pages = parsePageCount(text)
        if (pages !== null) job.progress.pages = pages
      }
      const fetcher = lib.transport.createOkxFetcher({
        // ⚠️ 必须 false：宿主和看板共用隧道池，关掉会把看板的 keep-alive 一起毁掉
        closeTunnels: false,
        log: progress,
      })
      let loaded
      try {
        loaded = await lib.data.loadBars({
          instId: job.config.instId,
          bar: job.config.bar,
          start: job.config.start,
          end: job.config.end,
          dataDir: job.config.dataDir,
          fetcher: fetcher,
          now: job.config.now,
          log: progress,
        })
      } finally {
        try { fetcher.close() } catch (error) { /* 关不掉不影响结果 */ }
      }
      if (job.cancelRequested === true) {
        finishJob(job, 'cancelled', cancelReason(job))
        return
      }
      if (loaded.ok !== true) {
        throw new Error(loaded.error === null || loaded.error === undefined ? '没有取到历史 K 线' : loaded.error)
      }
      job.progress.bars = loaded.bars.length
      job.progress.pages = Math.max(job.progress.pages, Number(loaded.fetchedPages) || 0)

      // ---- 1.5) 资金费率：OKX 历史（只保留最近约 3 个月）+ 缺失区间按估算费率补齐。
      // 历史接口失败不阻断回测：退化为全区间估算，报告/摘要里会标注（estimatedCount > 0）。
      let fundingEvents = []
      let fundingMeta = null
      const canLoadFunding = job.config.includeFunding !== false
        && typeof lib.data.loadFundingRates === 'function'
        && typeof lib.data.buildFundingEvents === 'function'
      if (canLoadFunding) {
        job.phase = 'data'
        job.message = '正在获取资金费率历史…'
        const fundingFetcher = lib.transport.createOkxFetcher({
          closeTunnels: false,
          log: progress,
        })
        let fundingLoaded = null
        try {
          fundingLoaded = await lib.data.loadFundingRates({
            instId: job.config.instId,
            start: job.config.start,
            end: job.config.end,
            dataDir: job.config.dataDir,
            fetcher: fundingFetcher,
            now: job.config.now,
            log: progress,
          })
        } catch (error) {
          fundingLoaded = { ok: false, error: describe(error), rates: [], warnings: [] }
        } finally {
          try { fundingFetcher.close() } catch (error) { /* 关不掉不影响结果 */ }
        }
        if (job.cancelRequested === true) {
          finishJob(job, 'cancelled', cancelReason(job))
          return
        }
        const fallbackRate = Number.isFinite(Number(job.config.fundingRate))
          ? Number(job.config.fundingRate)
          : lib.config.DEFAULT_FUNDING_RATE
        const built = lib.data.buildFundingEvents({
          rates: fundingLoaded.rates,
          start: job.config.start,
          end: job.config.end,
          fallbackRate: fallbackRate,
          intervalMs: lib.config.FUNDING_INTERVAL_MS,
        })
        fundingEvents = built.events
        fundingMeta = Object.assign({}, built.meta, {
          source: fundingLoaded.ok === true ? (fundingLoaded.fromCache === true ? 'cache' : 'okx') : 'estimated',
          error: fundingLoaded.error === undefined ? null : fundingLoaded.error,
        })
      }

      // ---- 2) 撮合：先让出一次事件循环，让一次 status 轮询能先回包（长回测期间面板才不像卡住）
      job.phase = 'engine'
      job.message = '正在回放 ' + String(loaded.bars.length) + ' 根 K 线…'
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
      const result = lib.engine.runBacktest({
        bars: loaded.bars,
        strategy: job.strategy,
        config: job.config,
        funding: fundingEvents,
        fundingMeta: fundingMeta,
      })
      if (job.cancelRequested === true) {
        finishJob(job, 'cancelled', cancelReason(job))
        return
      }

      // ---- 3) 指标
      job.phase = 'metrics'
      job.message = '正在计算绩效指标…'
      const metrics = lib.metrics.computeMetrics(result)

      // ---- 4) 报告（内存持有；落盘失败不影响面板）
      job.phase = 'report'
      job.message = '正在生成报告…'
      const generatedAt = Date.now()
      const strategyView = { name: job.strategy.name, params: Object.assign({}, job.strategy.params) }
      job.jsonReport = lib.report.buildJsonReport({ result: result, metrics: metrics, config: job.config, strategy: strategyView, generatedAt: generatedAt })
      // bars 必需：HTML 报告里的 K 线图要用原始 OHLC（result 里只有权益曲线的收盘价）
      job.html = lib.report.buildHtmlReport({
        result: result, metrics: metrics, config: job.config, strategy: strategyView, generatedAt: generatedAt, bars: loaded.bars,
      })
      try {
        job.reports = await lib.report.writeReports({
          result: result, metrics: metrics, config: job.config, strategy: strategyView, outDir: job.config.outDir, bars: loaded.bars,
        })
      } catch (error) {
        job.reports = null // 落盘只是方便用户翻文件，失败不该让回测失败
      }
      job.summary = buildBacktestSummary({
        job: job, result: result, config: job.config, metrics: metrics,
        strategy: strategyView, bars: loaded.bars, generatedAt: generatedAt,
      })
      finishJob(job, 'done', '回测完成')
    } catch (error) {
      if (job.state === 'cancelled') return
      if (job.cancelRequested === true) {
        finishJob(job, 'cancelled', cancelReason(job))
        return
      }
      finishJob(job, 'error', '回测失败：' + describe(error))
      job.error = describe(error)
    }
  }

  /** 列出内置策略与默认值（面板打开时拉一次）。 */
  async function list() {
    try {
      const lib = await getLib()
      const names = lib.strategy.listStrategies()
      const strategies = []
      for (const item of names) {
        try {
          const loaded = await lib.strategy.loadStrategy(item.name)
          strategies.push({ name: loaded.name, params: Object.assign({}, loaded.params) })
        } catch (error) {
          // 单个策略文件坏掉不该让整个回测面板打不开：跳过它，前端就看不到这个策略。
        }
      }
      return {
        ok: true,
        strategies: strategies,
        bars: lib.config.TIMEFRAMES.map((item) => item.id),
        // 可选标的：前端回测面板的「标的」下拉就是这份列表（默认仍 BTC）
        insts: SUPPORTED_INSTS.map((item) => Object.assign({}, item)),
        defaults: {
          instId: lib.config.DEFAULT_INSTID,
          bar: lib.config.DEFAULT_BAR,
          initialCapital: lib.config.DEFAULT_CAPITAL,
          leverage: lib.config.DEFAULT_LEVERAGE,
          makerFeeRate: lib.config.DEFAULT_MAKER_FEE_RATE,
          takerFeeRate: lib.config.DEFAULT_TAKER_FEE_RATE,
          rangeDays: lib.config.DEFAULT_RANGE_DAYS,
        },
        limits: {
          maxBarsHint: BACKTEST_MAX_BARS_HINT,
          maxPages: BACKTEST_MAX_PAGES,
          jobTimeoutMs: jobTimeoutMs,
        },
        job: backtestJobView(lastJob),
      }
    } catch (error) {
      return { ok: false, error: '回测框架不可用：' + describe(error) }
    }
  }

  /** 启动一次回测。校验失败/已有任务在跑 → { ok:false, error }；成功立刻返回 job。 */
  async function start(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: '请求体必须是对象' }
    }
    const running = activeJob()
    if (running !== null) {
      return {
        ok: false,
        runningJobId: running.id,
        error: '已有回测在跑（' + running.message + '），请等它结束或先取消',
      }
    }
    let lib
    try {
      lib = await getLib()
    } catch (error) {
      return { ok: false, error: '回测框架不可用：' + describe(error) }
    }

    // 1) 策略：只认内置白名单（不收路径 —— 否则等于给浏览器一个任意 import 的口子）
    const wanted = typeof raw.strategy === 'string' ? raw.strategy.trim() : ''
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(wanted)) {
      return { ok: false, error: '策略名不合法：' + JSON.stringify(String(raw.strategy)) }
    }
    const names = lib.strategy.listStrategies().map((item) => item.name)
    if (names.indexOf(wanted) < 0) {
      return { ok: false, error: '没有内置策略 ' + JSON.stringify(wanted) + '（可用：' + names.join(' / ') + '）' }
    }
    const paramCheck = normalizeParamsInput(raw.params)
    if (paramCheck.ok !== true) return { ok: false, error: paramCheck.error }
    let strategy
    try {
      strategy = lib.strategy.withResolvedParams(await lib.strategy.loadStrategy(wanted), paramCheck.params)
    } catch (error) {
      return { ok: false, error: describe(error) }
    }

    // 2) 配置：全部交给 config.mjs 校验；标的走白名单（BTC / ETH），不传则用默认标的。
    let requestedInstId
    if (raw.instId !== undefined && raw.instId !== null && raw.instId !== '') {
      requestedInstId = normalizeInstId(raw.instId)
      if (requestedInstId === null) {
        return {
          ok: false,
          error: '不支持的标的 ' + JSON.stringify(String(raw.instId))
            + '（可选：' + SUPPORTED_INSTS.map((item) => item.instId).join(' / ') + '）',
        }
      }
    }
    let config
    try {
      config = lib.config.normalizeConfig({
        instId: requestedInstId,
        bar: raw.bar,
        start: raw.start,
        end: raw.end,
        initialCapital: raw.initialCapital,
        leverage: raw.leverage,
        makerFeeRate: raw.makerFeeRate,
        takerFeeRate: raw.takerFeeRate,
      })
    } catch (error) {
      return { ok: false, error: describe(error) }
    }

    // 2.5) 规模防呆：数据层单次最多翻 BACKTEST_MAX_PAGES 页（每页 100 根）。
    // 超了不能真跑 —— 要么等 20 分钟超时，要么拿"只覆盖了一部分区间"的结果当回测，
    // 后者比直接报错糟得多（用户不会注意到 warning）。这里按估算保守拦截。
    const timeframe = lib.config.barById(config.bar)
    const closedEnd = Math.min(config.end, config.now)
    const estimatedBars = Math.max(0, Math.ceil((closedEnd - config.start) / timeframe.ms))
    const estimatedPages = Math.ceil(estimatedBars / 100)
    if (estimatedPages > BACKTEST_MAX_PAGES) {
      return {
        ok: false,
        error: '区间太大：预计 ' + String(estimatedBars) + ' 根 ' + config.bar + ' K 线（约 '
          + String(estimatedPages) + ' 页历史），超过单次回测上限 ' + String(BACKTEST_MAX_PAGES)
          + ' 页（约 20 万根）。请缩短时间范围或换更大的周期（例如 1m 建议 ≤ 近 90 天，回测一年请用 1h/4h）',
      }
    }

    counter += 1
    const job = {
      id: 'bt-' + String(Date.now()) + '-' + String(counter),
      state: 'running',
      phase: 'data',
      message: '排队中…',
      progress: { pages: 0, bars: 0, pct: null },
      startedAt: Date.now(),
      finishedAt: null,
      cancelRequested: false,
      timedOut: false,
      error: null,
      timer: null,
      config: config,
      strategy: strategy,
      summary: null,
      html: null,
      jsonReport: null,
      reports: null,
    }
    jobs.set(job.id, job)
    lastJob = job
    pruneJobs()
    job.timer = setTimeout(() => {
      if (job.state !== 'running' || job.cancelRequested === true) return
      job.timedOut = true
      job.cancelRequested = true
      job.message = '回测超时，正在停止…'
    }, jobTimeoutMs)
    if (typeof job.timer.unref === 'function') job.timer.unref()
    // 故意不 await：run 请求立刻返回 jobId，执行进度靠浏览器轮询
    executeJob(job).catch((error) => {
      finishJob(job, 'error', '回测失败：' + describe(error))
      job.error = describe(error)
    })
    return { ok: true, job: backtestJobView(job) }
  }

  /** 查状态；jobId 省略时返回最近一次（面板重开要能恢复上次结果）。 */
  function status(jobId) {
    const id = typeof jobId === 'string' ? jobId.trim() : ''
    if (id === '') return { ok: true, job: backtestJobView(lastJob) }
    const job = jobs.get(id)
    if (job === undefined) return { ok: false, error: '没有这个回测任务：' + id }
    return { ok: true, job: backtestJobView(job) }
  }

  /** 取报告：`{ ok, contentType, body, html }`；路由层负责写响应头。 */
  function report(jobId, format) {
    const id = typeof jobId === 'string' ? jobId.trim() : ''
    const job = id === '' ? lastJob : jobs.get(id)
    if (job === null || job === undefined) return { ok: false, error: '没有这个回测任务' }
    if (job.state === 'error') return { ok: false, error: job.error === null ? '回测失败' : job.error }
    if (job.state !== 'done') return { ok: false, error: '回测还没完成（当前：' + job.message + '）' }
    const wanted = format === undefined || format === '' ? 'html' : String(format).trim().toLowerCase()
    if (wanted === 'html') {
      if (typeof job.html !== 'string') return { ok: false, error: '这次任务没有生成 HTML 报告' }
      return { ok: true, html: true, contentType: 'text/html; charset=utf-8', body: job.html }
    }
    if (wanted === 'json') {
      return { ok: true, html: false, contentType: 'application/json; charset=utf-8', body: JSON.stringify(job.jsonReport) }
    }
    return { ok: false, error: 'format 只能是 html 或 json' }
  }

  /** 取消：数据抓取阶段无法真正 abort，会在阶段边界转 cancelled。 */
  function cancel(jobId) {
    const id = typeof jobId === 'string' ? jobId.trim() : ''
    const job = id === '' ? lastJob : jobs.get(id)
    if (job === null || job === undefined) return { ok: false, cancelled: false, error: '没有这个回测任务' }
    if (job.state !== 'running' && job.state !== 'queued') {
      return { ok: false, cancelled: false, error: '回测已经结束（' + job.message + '）', job: backtestJobView(job) }
    }
    job.cancelRequested = true
    job.message = '正在取消…（数据抓取阶段要等当前页结束）'
    return { ok: true, cancelled: true, job: backtestJobView(job) }
  }

  return { list: list, start: start, status: status, report: report, cancel: cancel }
}

// ------------------------------------------------------------------ 预警邮件
//
// 用 `dsh-qq-email` 提供的宿主侧 Cordis 服务 `ctx.qqEmail` 发信（那个插件的
// Agent 工具 `send_qq_email` 跟这里是同一份发送实现，只是入口不同）。
//
// ⚠️ 确认模型：`ctx.qqEmail.send()` 有两条路 ——
//   a) 传 `agent` → 它自己去调 DSH 的 `approval.request()`；
//   b) 不传 `agent` → 调用方必须显式 `confirmedByCaller: true`。
// 这里**只能走 b**：`approval.request()` 要求 `req.agent.session` 且必须在
// **打开的 turn 内**（`user-approval/src/index.ts`：outside an open turn 就直接抛），
// 而宿主插件没有 agent 上下文，预警又是半夜自动触发的、根本没有 turn 可依附。
//
// 所以授权时机前移到"用户填地址"那一步：面板里必须显式点过"确认用这个地址接收"，
// 宿主才把它记成**已确认地址**；之后每封自动预警只允许发往这个地址。
// 这不是形式主义 —— 它把"忘了确认"从静默发信变成一次失败（服务层也是这个意图）。

/** 单个地址的长度上限（RFC 5321）。 */
const EMAIL_MAX_ADDRESS_CHARS = 254;
/** 正文上限：qqEmail 服务内联 argv 传递，收紧到 20000 字符。 */
const EMAIL_MAX_BODY_CHARS = 20000;
/** 主题上限由 CLI 定为 4000，这里留余量。 */
const EMAIL_MAX_SUBJECT_CHARS = 300;
/** 宽松但足够严格的地址形状校验（与 qqEmail 自己的规则一致）。 */
const EMAIL_ADDRESS_RE = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[^\s@,;<>"()[\]]+$/;

/**
 * 邮件通道是**可选依赖**：Host 半只在路由里用 `ctx.get('qqEmail')` 惰性取服务，
 * 模块加载与 apply 都不依赖它 —— 没装 `dsh-qq-email` 时插件照常启动，只有邮件通道不可用。
 * 用户真要开邮件提醒时才给这条可执行提示：装哪个、去哪装、装完做什么、不影响什么。
 */
const QQ_EMAIL_MISSING_HINT = '邮件提醒依赖 dsh-qq-email 插件（已在 DSH 插件市场上架）：当前宿主没有找到它提供的 qqEmail 服务。'
  + '请在「插件 → 发现 / Discover」里安装并启用 dsh-qq-email，然后重启宿主；不装它不影响看板、均线、回测等其它功能。';

/** 地址串按逗号 / 分号 / 空白切分，去重、去空。 */
function parseEmailList(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input === undefined || input === null ? '' : input);
  const seen = new Set();
  const out = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const value = piece.trim();
    if (value === '') continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** 校验地址列表；返回 `{ ok, list, error }`。 */
export function validateEmailList(input) {
  const list = parseEmailList(input);
  if (list.length === 0) return { ok: false, list, error: '请填写收件邮箱地址' };
  if (list.length > 5) return { ok: false, list, error: '收件人最多 5 个' };
  for (const one of list) {
    if (one.length > EMAIL_MAX_ADDRESS_CHARS) return { ok: false, list, error: '邮箱地址过长：' + one };
    if (!EMAIL_ADDRESS_RE.test(one)) return { ok: false, list, error: '邮箱地址格式不对：' + one };
  }
  return { ok: true, list, error: null };
}

/** 时间戳字段的规范化：只接受**真正的数字**，其它（null / undefined / 字符串）一律给 null。 */
function finiteOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/** 预警邮件配置的规范化（读盘 / 收请求都走它，坏值一律退回安全的默认）。 */
export function normalizeEmailConfig(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  // 已确认地址：只有它非空时才允许自动发信
  const confirmed = parseEmailList(source.confirmed);
  return {
    enabled: source.enabled === true,
    to: parseEmailList(source.to).join(', '),
    // 只有"当前填的地址"与"已确认地址"完全一致时才算授权仍然有效
    confirmed: confirmed.join(', '),
    // ⚠️ 不能写成 `Number.isFinite(Number(x))`：`Number(null)` 是 0 会通过检查，
    // 于是"从没发过"（null / 字段缺失）被写成 `lastSentAt: 0` —— 界面显示成 1970 年，
    // 而且这个 0 会落盘，把"没发过"变成"发过但时间是 0"。真踩过。
    confirmedAt: finiteOrNull(source.confirmedAt),
    lastSentAt: finiteOrNull(source.lastSentAt),
    lastError: typeof source.lastError === 'string' ? source.lastError : null,
    sentCount: Number.isFinite(source.sentCount) ? source.sentCount : 0,
  };
}

/** 面板与自检用的视图（不外泄内部字段）。 */
export function emailView(config, serviceAvailable) {
  const confirmed = parseEmailList(config.confirmed);
  const to = parseEmailList(config.to);
  const same = confirmed.length > 0 && confirmed.join('|').toLowerCase() === to.join('|').toLowerCase();
  return {
    enabled: config.enabled === true,
    to: config.to,
    confirmed: config.confirmed,
    // 授权是否仍然覆盖当前地址
    authorized: same,
    confirmedAt: config.confirmedAt,
    lastSentAt: config.lastSentAt,
    lastError: config.lastError,
    sentCount: config.sentCount,
    // qqEmail 服务在不在（不在时面板要给出可执行的提示，而不是干瞪眼）
    available: serviceAvailable === true,
  };
}

function pad2(value) {
  const n = Number(value);
  return String(n < 10 ? '0' + String(n) : String(n));
}

/** `YYYY-MM-DD HH:mm:ss`（本地时间；邮件正文里给人看，不做时区换算）。 */
function stampText(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '—';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/**
 * 组装预警邮件。
 *
 * 内容按用户要求：**触发命中的规则 / 周期 / 那根 K 线的数据**，外加当时的
 * 收盘价与均线值（判据）。纯文本，不附加任何签名或"由系统发送"的说明。
 * @param body 面板 POST 上来的预警载荷。
 * @returns `{ subject, body }`，或 `{ ok: false, error }`。
 */
/**
 * 「试一下」用的示例预警载荷。
 *
 * 刻意**走与真实预警完全相同的组装路径** —— 否则会出现"测试邮件长这样、
 * 真预警邮件长那样"这种最坑人的偏差。只有数据是编的（跟当前行情无关）。
 */
function sampleAlertPayload() {
  const now = Date.now()
  // 收线时间用"刚刚收盘的那一根"更贴近真实：按 15m 向下取整
  const barStart = now - (now % (15 * 60 * 1000))
  return {
    rule: '收盘上穿 EMA20',
    bar: '15m',
    text: '收线上穿 EMA20 · 收盘 84,724.6 / 均线 84,300.1（测试邮件）',
    ts: barStart,
    instId: 'BTC-USDT-SWAP',
    price: { close: 84724.6, ema: 84300.1 },
    candle: { t: barStart, o: 84200.5, h: 84880.0, l: 84150.2, c: 84724.6, v: 128.44 },
    rules: [
      { dir: 'up', emaPeriod: 20, bar: '15m', on: true },
      { dir: 'down', emaPeriod: 20, bar: '15m', on: true },
    ],
  }
}

export function buildAlertEmail(body) {  const bar = typeof body.bar === 'string' && body.bar !== '' ? body.bar : '';
  const rule = typeof body.rule === 'string' ? body.rule : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const ts = Number(body.ts);
  const price = body.price !== null && typeof body.price === 'object' ? body.price : null;
  const candle = body.candle !== null && typeof body.candle === 'object' ? body.candle : null;

  const lines = [];
  lines.push('BTC 合约收线预警');
  lines.push('');
  lines.push('命中规则：' + (rule === '' ? '（未提供）' : rule));
  lines.push('周期：' + (bar === '' ? '（未提供）' : bar));
  if (Number.isFinite(ts)) lines.push('K 线收线时间：' + stampText(ts));
  lines.push('触发时间：' + stampText(Date.now()));
  lines.push('');
  lines.push('判定结果：' + (text === '' ? '（未提供）' : text));
  if (price !== null && Number.isFinite(Number(price.close))) {
    lines.push('收盘价：' + String(price.close) + (price.ema === undefined || price.ema === null ? '' : ' / 均线：' + String(price.ema)));
  }
  if (candle !== null) {
    lines.push('');
    lines.push('触发那根 K 线：');
    if (Number.isFinite(Number(candle.t))) lines.push('  开盘时间：' + stampText(candle.t));
    if (Number.isFinite(Number(candle.o))) lines.push('  开：' + String(candle.o));
    if (Number.isFinite(Number(candle.h))) lines.push('  高：' + String(candle.h));
    if (Number.isFinite(Number(candle.l))) lines.push('  低：' + String(candle.l));
    if (Number.isFinite(Number(candle.c))) lines.push('  收：' + String(candle.c));
    if (Number.isFinite(Number(candle.v))) lines.push('  量：' + String(candle.v));
  }
  if (Array.isArray(body.rules) && body.rules.length > 0) {
    lines.push('');
    lines.push('当前启用的规则：');
    for (const one of body.rules.slice(0, 20)) {
      if (one === null || typeof one !== 'object') continue;
      lines.push('  ' + (one.dir === 'down' ? '收盘下穿' : '收盘上穿') + ' EMA' + String(one.emaPeriod)
        + (typeof one.bar === 'string' && one.bar !== '' ? '（' + one.bar + '）' : ''));
    }
  }
  if (typeof body.instId === 'string' && body.instId !== '') {
    lines.push('');
    lines.push('合约：' + body.instId);
  }

  const subject = '[BTC 预警] ' + (bar === '' ? '' : bar + ' ') + (text === '' ? '收线穿越均线' : text);
  const emailBody = lines.join('\n');
  if (emailBody.length > EMAIL_MAX_BODY_CHARS) {
    return { ok: false, error: '邮件正文过长（' + String(emailBody.length) + ' > ' + String(EMAIL_MAX_BODY_CHARS) + '）' };
  }
  return {
    ok: true,
    subject: subject.slice(0, EMAIL_MAX_SUBJECT_CHARS),
    body: emailBody,
  };
}


export function apply(ctx, options) {
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
   * 回测服务实例：路由只负责 HTTP，业务（job 管理/进度/报告）都在 `createBacktestService()` 里。
   * `options.backtestService` 是**给测试注入用的**（路由测试要离线跑），宿主照常 `apply(ctx)`。
   */
  const backtestService = options !== null && options !== undefined && options.backtestService !== undefined
    ? options.backtestService
    : createBacktestService()

  /**
   * webserver 的 exact 路由不区分 method，同一条 path 的所有方法都会进 handler，
   * 所以 GET-only / POST-only 的语义得自己保证（写操作尤其不能让 GET 混进来）。
   */
  const allowMethod = (req, res, method) => {
    if (req.method === method) return false
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: method })
    res.end(JSON.stringify({ ok: false, error: '只接受 ' + method + '，收到：' + String(req.method === undefined ? '未知' : req.method) }))
    return true
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

  /**
   * 已经成功占住的 (path|label)：防止 bind 循环每秒重复注册同一条。
   * 用普通 Set 就够 —— 一个进程里 apply 次数有限，不需要 WeakSet 的复杂度。
   */
  const claimedRoutes = new Set()

  /**
   * path → 本实例注册成功后拿到的 disposer。
   * 撤回时按 **path** 找（不是按 label），所以同一个 path 上声明多个 handler
   * （`/email` 的 GET 与 POST）时，后声明的能正确覆盖先声明的。
   */
  const ownedPaths = new Map()

  /** 本插件声明的全部路由键（`path|label`），用于 /health 里报"占住了几条" */
  const ROUTE_KEYS = [
    '/dsh-btc/board|GET',
    '/dsh-btc/price|GET',
    '/dsh-btc/env|POST',
    '/dsh-btc/health|GET',
    '/dsh-btc/email|GET+POST',
    '/dsh-btc/notify-email|POST',
    '/dsh-btc/backtest/strategies|GET',
    '/dsh-btc/backtest/run|POST',
    '/dsh-btc/backtest/status|GET',
    '/dsh-btc/backtest/report|GET',
    '/dsh-btc/backtest/cancel|POST',
  ]

  /**
   * 注册一条 exact 路由，**幂等且能从"陈旧路由"里恢复**。
   *
   * 为什么不直接 `server.register()`：`webserver.register()` 在 (kind, path)
   * 重复时**抛错**（`duplicate exact route`），disposer 由 `ctx.effect` 负责调用。
   * 于是"插件重载时旧 fiber 还没卸载完"这种时序下，新 fiber 注册第一条路由就抛，
   * **整个 registerRoutes 中断 —— 后面所有路由一条都注册不上**，而旧实例还在应答，
   * 表现为"改完代码重启了，行为却完全没变"。真踩过，卡了很多轮。
   *
   * 现在的策略：**每条路由各自 try**，撞了就"按 path 撤掉旧的、再注册"，
   * 把陈旧占用顶掉；这条路失败也不影响别的路由。
   * `ownedPaths` 记录"本实例注册成功的东西"，撤回时按 path 去找，
   * 这样同一个 path 上声明多个 handler（/email 的 GET 与 POST）也能正确覆盖。
   *
   * `label` 只用来区分同一个 path 上的多个 handler，不参与撤回调度的键。
   */
  const route = (path, label, handle) => {
    const key = path + '|' + label
    if (claimedRoutes.has(key)) return
    const spec = {
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
    }
    let dispose = null
    ctx.effect(() => {
      const attempt = () => { dispose = server.register(spec) }
      const dropOwn = () => {
        const owner = ownedPaths.get(path)
        if (typeof owner !== 'function') return false
        try { owner() } catch (inner) { /* 撤不掉就继续尝试注册 */ }
        ownedPaths.delete(path)
        return true
      }
      try {
        attempt()
      } catch (first) {
        // 撞重复了。两种来源：①本实例在同一个 path 上先声明了别的 handler
        // （比如 /email 的 GET 在前、POST 在后）；②上一份插件实例的路由还没释放。
        // 先按 path 撤掉**自己注册的**那条再重试 —— 不能无条件先撤：
        // 那会把前面刚注册好的 GET 撤掉，最后只剩 GET 在应答（真踩过）。
        if (dropOwn() === true) {
          try {
            attempt()
          } catch (second) {
            lastError = describe(second)
            return () => {}
          }
        } else {
          // 只剩情形②：`server.register` 返回的 disposer 只能撤自己注册的那条，
          // 对"别人的占用"没有合法撤销途径。记下来（/health 的 lastError 看得到），
          // 不标记 claimed，让 bind 循环下一轮继续试，占用一释放就自己恢复。
          // 关键是**不往外抛** —— 一条路由被占，不该让别的路由也注册不上。
          lastError = describe(first)
          return () => {}
        }
      }
      ownedPaths.set(path, dispose)
      claimedRoutes.add(key)
      return () => {
        claimedRoutes.delete(key)
        if (ownedPaths.get(path) === dispose) ownedPaths.delete(path)
        if (typeof dispose === 'function') dispose()
      }
    }, 'dsh-btc-dashboard: ' + key)
  }

  function registerRoutes(target) {
    // 看板主数据
    route('/dsh-btc/board', 'GET', async (req, res) => {
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

    // 侧边栏用的轻量接口：只要最新价（可带 ?instId=ETH-USDT-SWAP 看另一个合约）
    route('/dsh-btc/price', 'GET', async (req, res) => {
      const cfg = currentSettings()
      const requestedInst = normalizeInstId(query(req, 'instId'))
      const scoped = requestedInst === null ? cfg : Object.assign({}, cfg, { instId: requestedInst })
      const ticker = await fetchTicker(scoped, query(req, 'force') === '1')
      json(res, {
        ok: ticker.ok === true,
        error: ticker.ok === true ? null : ticker.error,
        env: envView(cfg),
        instId: scoped.instId,
        transport: transportMemo,
        price: ticker.ok === true ? ticker.ticker : null,
        now: Date.now(),
      })
    })

    // 环境切换：只认 POST（body {"env":"prod"}）—— 这是唯一的写操作，所以不让 GET 也能改状态。
    route('/dsh-btc/env', 'POST', async (req, res) => {
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
    route('/dsh-btc/health', 'GET', (req, res) => {
      const payload = healthPayload()
      payload.lastError = lastError
      // `bound` 以前是"首次注册是否跑过"的局部变量，插件被应用两次时永远是 false，
      // 排障时看着像"没绑定"却其实在服务 —— 误导过好几轮。现在按**实际占住的路由条数**
      // 算：全部占住才算 true，没占满时把还缺哪些路径也报出来。
      const missing = ROUTE_KEYS.filter((one) => !claimedRoutes.has(one))
      payload.bound = missing.length === 0
      payload.routes = { total: ROUTE_KEYS.length, claimed: ROUTE_KEYS.length - missing.length, missing: missing }
      json(res, payload)
    })

    /** 取 `ctx.qqEmail`（`dsh-qq-email` 插件提供）；没装时返回 null 由调用方给出提示。 */
    function qqEmailService() {
      try {
        const service = ctx.get('qqEmail')
        return service === undefined || service === null ? null : service
      } catch (error) {
        return null
      }
    }

    // 预警邮件配置：GET 读、POST 写。
    // ⚠️ **必须合成一个 handler**：webserver 的路由表同一个 (kind, path) 只能有一条，
    // 声明两次的话后一条要先把前一条撤掉，谁最终生效取决于注册顺序 —— 实测出现过
    // "POST 请求被 GET 的 handler 接走"。`/dsh-btc/env` 也是同样的写法（单 handler 内按 method 分支）。
    // 写入路径**必填 `confirm: true` 才把地址记为"已确认"** ——
    // 这是整个自动发信的授权时机（见文件上方关于确认模型的说明）。
    route('/dsh-btc/email', 'GET+POST', async (req, res) => {
      if (req.method !== 'POST') {
        const service = qqEmailService()
        json(res, {
          ok: true,
          email: emailView(normalizeEmailConfig(readState().email), service !== null),
        })
        return
      }
      const raw = await readBody(req, 8192)
      let parsed
      try {
        parsed = JSON.parse(raw === '' ? '{}' : raw)
      } catch (error) {
        json(res, { ok: false, error: '请求体不是 JSON' })
        return
      }
      if (parsed === null || typeof parsed !== 'object') {
        json(res, { ok: false, error: '请求体要是对象' })
        return
      }
      const current = normalizeEmailConfig(readState().email)
      const wantEnabled = parsed.enabled === true
      // 地址没填就允许关掉；要开就必须有合法地址
      const checked = validateEmailList(parsed.to);
      if (wantEnabled && checked.ok !== true) {
        json(res, { ok: false, error: checked.error })
        return
      }
      const toText = checked.list.join(', ');
      const sameAsConfirmed = checked.list.length > 0
        && parseEmailList(current.confirmed).join('|').toLowerCase() === checked.list.join('|').toLowerCase();
      // 开启邮件提醒 + 地址变了（或首次）→ 必须显式确认
      let confirmedText = current.confirmed;
      let confirmedAt = current.confirmedAt;
      if (wantEnabled && sameAsConfirmed !== true) {
        if (parsed.confirm !== true) {
          json(res, {
            ok: false,
            needsConfirm: true,
            error: '开启邮件提醒前需要确认收件地址：' + toText + '（确认后每封预警邮件都会自动发往这个地址）',
          })
          return
        }
        const service = qqEmailService()
        if (service === null) {
          json(res, { ok: false, error: QQ_EMAIL_MISSING_HINT, missingPlugin: 'dsh-qq-email' })
          return
        }
        confirmedText = toText;
        confirmedAt = Date.now();
      }
      if (wantEnabled !== true) {
        // 关掉时保留地址，但不保留"已确认"之外的任何语义变化
        confirmedText = checked.list.length > 0 ? confirmedText : current.confirmed;
      }
      const next = normalizeEmailConfig(Object.assign({}, current, {
        enabled: wantEnabled,
        to: checked.list.length > 0 ? toText : current.to,
        confirmed: confirmedText,
        confirmedAt: confirmedAt,
      }));
      writeState({ email: next });
      const service = qqEmailService()
      json(res, { ok: true, email: emailView(next, service !== null) })
    })

    /**
     * 发一封预警邮件。客户端在命中时调用。
     *
     * 三重门：①配置开着 ②当前地址已被确认 ③qqEmail 服务可用 —— 任一不满足就
     * 明确返回原因，客户端的判据日志里会记下来（不静默失败）。
     */
    route('/dsh-btc/notify-email', 'POST', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
        res.end(JSON.stringify({ ok: false, error: '只接受 POST' }))
        return
      }
      const raw = await readBody(req, 65536)
      let payload
      try {
        payload = JSON.parse(raw === '' ? '{}' : raw)
      } catch (error) {
        json(res, { ok: false, error: '请求体不是 JSON' })
        return
      }
      const current = normalizeEmailConfig(readState().email)
      if (current.enabled !== true) {
        json(res, { ok: false, skipped: 'disabled', error: '邮件提醒没开' })
        return
      }
      const confirmed = parseEmailList(current.confirmed);
      const to = parseEmailList(current.to);
      if (confirmed.length === 0 || confirmed.join('|').toLowerCase() !== to.join('|').toLowerCase()) {
        json(res, { ok: false, skipped: 'unauthorized', error: '当前收件地址还没被确认过（请在预警面板里确认一次）' })
        return
      }
      const service = qqEmailService()
      if (service === null) {
        json(res, { ok: false, skipped: 'no-service', error: QQ_EMAIL_MISSING_HINT, missingPlugin: 'dsh-qq-email' })
        return
      }
      const isTest = payload !== null && typeof payload === 'object' && payload.test === true
      const built = buildAlertEmail(isTest ? sampleAlertPayload() : (payload === null || typeof payload !== 'object' ? {} : payload))
      if (built.ok !== true) {
        writeState({ email: Object.assign({}, current, { lastError: built.error }) })
        json(res, { ok: false, error: built.error })
        return
      }
      try {
        const sent = await service.send(
          { to: confirmed, subject: built.subject, body: built.body },
          // 不走 approval：宿主没有 agent 上下文，而 approval.request() 要求
          // 打开的 turn（详见文件上方说明）。授权已在 /dsh-btc/email 那一步拿到，
          // 且这里只允许发往**已确认地址** —— 这就是 confirmedByCaller 的语义。
          { confirmedByCaller: true, signal: AbortSignal.timeout(120000) },
        )
        const stamp = Date.now()
        writeState({
          email: Object.assign({}, current, {
            lastSentAt: stamp,
            lastError: null,
            sentCount: current.sentCount + 1,
          }),
        })
        console.log('[dsh-btc-dashboard] 预警邮件已发出 → ' + confirmed.join(', '))
        json(res, { ok: true, queued: sent.queued === true, to: sent.to, subject: sent.subject, from: sent.from })
      } catch (error) {
        const message = error !== null && error !== undefined && typeof error.message === 'string'
          ? error.message
          : describe(error)
        writeState({ email: Object.assign({}, current, { lastError: message }) })
        console.warn('[dsh-btc-dashboard] 预警邮件发送失败：' + message)
        json(res, { ok: false, error: message })
      }
    })

    // ------------------------------------------------------------------ 回测
    // 5 条路由都走同一个信任栅栏（见 rejected）：回测读的是公开行情，但"跑一次任务"
    // 是消耗宿主资源的写操作，不能给跨站页面留口子。
    route('/dsh-btc/backtest/strategies', 'GET', async (req, res) => {
      if (allowMethod(req, res, 'GET')) return
      json(res, await backtestService.list())
    })

    route('/dsh-btc/backtest/run', 'POST', async (req, res) => {
      if (allowMethod(req, res, 'POST')) return
      const raw = await readBody(req, BACKTEST_MAX_BODY_BYTES)
      let body
      try {
        body = JSON.parse(raw === '' ? '{}' : raw)
      } catch (error) {
        json(res, { ok: false, error: '请求体不是 JSON' })
        return
      }
      json(res, await backtestService.start(body))
    })

    route('/dsh-btc/backtest/status', 'GET', async (req, res) => {
      if (allowMethod(req, res, 'GET')) return
      json(res, await backtestService.status(query(req, 'jobId')))
    })

    // 报告同一条路由出两种格式：format=html（浏览器新标签打开）或 format=json（下载/二次分析）。
    // HTML 响应带严格 CSP —— 报告本身零脚本零外链，这条头是第二道保险。
    route('/dsh-btc/backtest/report', 'GET', async (req, res) => {
      if (allowMethod(req, res, 'GET')) return
      const out = await backtestService.report(query(req, 'jobId'), query(req, 'format'))
      if (out.ok !== true) {
        json(res, { ok: false, error: out.error })
        return
      }
      if (out.html === true) {
        res.writeHead(200, {
          'content-type': out.contentType,
          'cache-control': 'no-store',
          'content-security-policy': BACKTEST_HTML_CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
        res.end(out.body)
        return
      }
      res.writeHead(200, {
        'content-type': out.contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(out.body)
    })

    route('/dsh-btc/backtest/cancel', 'POST', async (req, res) => {
      if (allowMethod(req, res, 'POST')) return
      const raw = await readBody(req, 4096)
      let body
      try {
        body = JSON.parse(raw === '' ? '{}' : raw)
      } catch (error) {
        json(res, { ok: false, cancelled: false, error: '请求体不是 JSON' })
        return
      }
      json(res, await backtestService.cancel(body !== null && typeof body === 'object' ? body.jobId : ''))
    })
  }

  function bind() {
    if (server === null) server = ctx.get('webServer') ?? null
    if (server === null || server === undefined) return
    // 还没占满就每轮再试：单条路由因为"陈旧占用"失败时，`route()` 会不标记 claimed，
    // 于是下一轮自动重试 —— 插件能从重载时序里自己恢复，不需要重启进程。
    if (ROUTE_KEYS.some((one) => !claimedRoutes.has(one))) {
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
