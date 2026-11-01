// 回测数据层自检（**全程离线**）：
//   1. transport：用注入的 request 验证代理优先级、先代理后直连、重试/退避/429、限速间隔、错误归一；
//      真网络逻辑只存在于实现里，本文件不发任何请求。
//   2. data：假 fetcher 分页 + mkdtemp 临时缓存目录，验证分页拼装、缺口填补、缓存命中、
//      offline 语义、未收盘剔除、失败降级、maxPages、历史深度下界、readBarFile 三种格式。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createOkxFetcher, resolveProxy } from '../backtest/lib/transport.mjs'
import { loadBars, readBarFile } from '../backtest/lib/data.mjs'

// ------------------------------------------------------------------ 测试骨架
let passed = 0
let failed = 0
const createdDirs = []

function ok(label) {
  passed += 1
  console.log('ok   ' + label)
}

function fail(label) {
  failed += 1
  console.log('FAIL ' + label)
  process.exitCode = 1
}

function check(condition, label) {
  if (condition) ok(label)
  else fail(label)
}

async function section(title, task) {
  console.log('\n== ' + title + ' ==')
  try {
    await task()
  } catch (error) {
    fail(title + ' 抛出了未预期异常：' + String(error !== null && error.message !== undefined ? error.message : error))
  }
}

function expectThrow(fn, needle, label) {
  try {
    fn()
    fail(label + '（预期抛错但没有）')
  } catch (error) {
    const message = String(error !== null && error.message !== undefined ? error.message : error)
    check(message.includes(needle), label + '：' + message)
  }
}

function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'btc-backtest-data-' + tag + '-'))
  createdDirs.push(dir)
  return dir
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value), 'utf8')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// ------------------------------------------------------------------ 固定时间轴
const HOUR = 3_600_000
const DAY = 86_400_000
// 固定的「现在」：2026-03-15T05:30:00Z。1h 最后一根已收盘 K 线是 04:00（05:00 收线），
// 已收盘边界 = floor(now / 1h) * 1h = 05:00（t < 05:00 的 K 线才可能已收盘）。
const NOW = Date.UTC(2026, 2, 15, 5, 30, 0)
const LAST_CLOSED = Math.floor((NOW - HOUR) / HOUR) * HOUR // 04:00
const CUTOFF = Math.floor(NOW / HOUR) * HOUR // 05:00：已收盘边界（after 从这里往回翻）

/** 生成 ts < after 的 K 线行（最新在前、数组形状、confirm='1'），最早不早于 earliest。 */
function makeRows({ after, limit, earliest = -Infinity, barMs = HOUR }) {
  const rows = []
  let t = Math.floor((after - 1) / barMs) * barMs
  while (rows.length < limit && t >= earliest) {
    const base = 100 + (Math.abs(Math.round(t / barMs)) % 50)
    rows.push([t, base, base + 1, base - 1, base + 0.5, 10, '', '', '1'])
    t -= barMs
  }
  return rows
}

/** 假分页 fetcher：模拟 OKX history-candles（after 往前翻、单页最多 limit 根、最新在前）。 */
function makePagedFetcher({ earliest = -Infinity, barMs = HOUR, calls = [], failAt = null, rowsFactory = null } = {}) {
  return {
    calls,
    async fetchPage(params) {
      calls.push({ instId: params.instId, okxBar: params.okxBar, after: params.after, limit: params.limit })
      if (failAt !== null && calls.length >= failAt) {
        return { ok: false, error: '模拟网络错误（第 ' + String(calls.length) + ' 页）' }
      }
      const rows = rowsFactory !== null
        ? rowsFactory(params, calls.length)
        : makeRows({ after: params.after, limit: params.limit, earliest, barMs })
      return { ok: true, rows }
    },
  }
}

/** 预期条数：请求区间 [start,end) 内时间上已收盘且落在周期网格上的 K 线数。 */
function expectedBarCount(start, end, barMs = HOUR, now = NOW) {
  const boundary = Math.floor(now / barMs) * barMs
  const cutoff = Math.min(end, boundary)
  const first = Math.ceil(start / barMs) * barMs
  const last = Math.floor((cutoff - 1) / barMs) * barMs
  return last < first ? 0 : Math.round((last - first) / barMs) + 1
}

// ================================================================== 1) resolveProxy
await section('resolveProxy：代理优先级', async () => {
  const ENV_KEYS = ['DSH_BTC_WORKSPACE', 'DSH_BTC_PROXY', 'OKX_PROXY']
  function withProxyEnv(env, task) {
    const saved = {}
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    try {
      for (const key of ENV_KEYS) delete process.env[key]
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return task()
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }

  const emptyWorkspace = tempDir('resolve-ws')

  // 默认值：临时工作区里没有 .env，环境变量也全部清空
  const fallback = withProxyEnv({ DSH_BTC_WORKSPACE: emptyWorkspace }, () => resolveProxy())
  check(fallback !== null && fallback.host === '127.0.0.1' && fallback.port === 7897 && fallback.raw === 'http://127.0.0.1:7897',
    '默认代理 http://127.0.0.1:7897（得到 ' + (fallback === null ? 'null' : fallback.host + ':' + String(fallback.port)) + '）')

  // 显式 options.proxy 优先级最高
  const explicit = withProxyEnv({ DSH_BTC_PROXY: 'http://127.0.0.1:1111', DSH_BTC_WORKSPACE: emptyWorkspace },
    () => resolveProxy({ proxy: 'http://127.0.0.1:2222' }))
  check(explicit !== null && explicit.port === 2222, '显式 options.proxy 覆盖环境变量（port=' + String(explicit === null ? 'null' : explicit.port) + '）')

  // off / null / 空串 = 强制直连
  const offs = withProxyEnv({ DSH_BTC_WORKSPACE: emptyWorkspace }, () => [
    resolveProxy({ proxy: 'off' }),
    resolveProxy({ proxy: 'none' }),
    resolveProxy({ proxy: null }),
    resolveProxy({ proxy: '' }),
  ])
  check(offs.every((value) => value === null), 'off / none / null / 空串 都表示强制直连')

  // 环境变量之间：DSH_BTC_PROXY 优先于 OKX_PROXY；空字符串视为未设置
  const envPriority = withProxyEnv({
    DSH_BTC_PROXY: 'http://127.0.0.1:1111',
    OKX_PROXY: 'http://127.0.0.1:3333',
    DSH_BTC_WORKSPACE: emptyWorkspace,
  }, () => resolveProxy())
  check(envPriority !== null && envPriority.port === 1111, '环境变量 DSH_BTC_PROXY 优先于 OKX_PROXY')
  const envFallback = withProxyEnv({
    DSH_BTC_PROXY: '',
    OKX_PROXY: 'http://127.0.0.1:3333',
    DSH_BTC_WORKSPACE: emptyWorkspace,
  }, () => resolveProxy())
  check(envFallback !== null && envFallback.port === 3333, '空的环境变量按未设置处理，继续用 OKX_PROXY')
  const envOff = withProxyEnv({ DSH_BTC_PROXY: 'off', DSH_BTC_WORKSPACE: emptyWorkspace }, () => resolveProxy())
  check(envOff === null, '环境变量写成 off 也表示直连')

  // 工作区 .env（用临时工作区，不读仓库里可能存在的 .env）
  const envWorkspace = tempDir('resolve-dotenv')
  writeFileSync(join(envWorkspace, '.env'), 'OKX_PROXY=http://127.0.0.1:4455\n', 'utf8')
  const fromFile = withProxyEnv({ DSH_BTC_WORKSPACE: envWorkspace }, () => resolveProxy())
  check(fromFile !== null && fromFile.port === 4455, '.env 的 OKX_PROXY 生效（port=' + String(fromFile === null ? 'null' : fromFile.port) + '）')
  writeFileSync(join(envWorkspace, '.env'), 'DSH_BTC_PROXY=http://127.0.0.1:4456\nOKX_PROXY=http://127.0.0.1:4455\n', 'utf8')
  const fromFilePriority = withProxyEnv({ DSH_BTC_WORKSPACE: envWorkspace }, () => resolveProxy())
  check(fromFilePriority !== null && fromFilePriority.port === 4456, '.env 里 DSH_BTC_PROXY 优先于 OKX_PROXY')

  // 不带协议头的写法自动补 http://
  const bare = withProxyEnv({ DSH_BTC_WORKSPACE: emptyWorkspace }, () => resolveProxy({ proxy: '127.0.0.1:5678' }))
  check(bare !== null && bare.host === '127.0.0.1' && bare.port === 5678, '不带协议头的代理地址按 http:// 解释')

  // 非法/不支持的代理：返回 null（退直连），不抛错
  const invalid = withProxyEnv({ DSH_BTC_WORKSPACE: emptyWorkspace }, () => [
    resolveProxy({ proxy: '这不是一个代理地址' }),
    resolveProxy({ proxy: 'socks5://127.0.0.1:1080' }),
  ])
  check(invalid[0] === null && invalid[1] === null, '非法/非 HTTP(S) 代理返回 null（退直连），不抛错')

  // 上层为了统一可能总是展开一个 proxy 键：undefined 必须视为「没传」，
  // 不能变成「强制直连」（本机直连是黑洞，会白白等超时）。
  const undefinedProxy = withProxyEnv({ DSH_BTC_PROXY: 'http://127.0.0.1:1111', DSH_BTC_WORKSPACE: emptyWorkspace },
    () => resolveProxy({ proxy: undefined }))
  check(undefinedProxy !== null && undefinedProxy.port === 1111, 'proxy: undefined 视为未设置（仍走环境变量/默认值）')

  // 显式传 {raw,host,port} 对象也应被接受（内部/测试复用方便）
  const objectProxy = withProxyEnv({ DSH_BTC_WORKSPACE: emptyWorkspace },
    () => resolveProxy({ proxy: { raw: 'http://10.0.0.1:8888', host: '10.0.0.1', port: 8888 } }))
  check(objectProxy !== null && objectProxy.host === '10.0.0.1' && objectProxy.port === 8888, '显式传入 {raw,host,port} 对象可用')
})

// ================================================================== 2) createOkxFetcher（注入 request，不联网）
function okxBody(rows) {
  return Buffer.from(JSON.stringify({ code: '0', msg: '', data: rows }), 'utf8')
}

function okxErrorBody(code, msg) {
  return Buffer.from(JSON.stringify({ code: code, msg: msg, data: [] }), 'utf8')
}

function makeRequest(handler) {
  const calls = []
  const request = async (target, url, headers, timeoutMs, proxy) => {
    const call = { target, url, headers, timeoutMs, proxy, at: Date.now() }
    calls.push(call)
    return handler(target, url, calls.length, call)
  }
  request.calls = calls
  return request
}

function parseAfterLimit(url) {
  const parsed = new URL(url)
  return { after: Number(parsed.searchParams.get('after')), limit: Number(parsed.searchParams.get('limit')) }
}

const PAGE_AFTER = LAST_CLOSED + HOUR // 05:00：请求「早于它」的页

await section('createOkxFetcher：请求形状与返回顺序', async () => {
  const request = makeRequest((target, url) => {
    const { after, limit } = parseAfterLimit(url)
    return { status: 200, body: okxBody(makeRows({ after, limit, earliest: 0 })) }
  })
  const fetcher = createOkxFetcher({ proxy: null, request, delayMs: 0 })
  const result = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 100 })

  check(result.ok === true && Array.isArray(result.rows), 'fetchPage 成功返回 rows')
  check(result.rows.length === 100, 'fetchPage 返回 100 行（limit=100）')
  check(result.rows[0].t === LAST_CLOSED && result.rows[99].t === LAST_CLOSED - 99 * HOUR, 'rows 保持接口原序（最新在前，未被传输层重排）')
  check(result.rows[0].confirm === '1', 'rows 保留 confirm 标记（data 层用它判断收线）')

  const call = request.calls[0]
  check(call.target === 'direct' && call.proxy === null, '显式 proxy:null 时走直连（target=direct）')
  check(call.timeoutMs === 12_000, '默认超时 12000ms 透传给 request')
  check(call.url.includes('/api/v5/market/history-candles'), '请求 history-candles 接口')
  check(call.url.includes('instId=BTC-USDT-SWAP') && call.url.includes('bar=1H') && call.url.includes('limit=100'),
    'URL 带 instId / bar / limit')
  check(call.url.includes('after=' + String(PAGE_AFTER)), 'URL 带 after 分页游标')

  // limit 超过 100 要夹紧（服务端上限），非法 limit 报中文错误但不抛
  const clamped = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 500 })
  check(clamped.ok === true && parseAfterLimit(request.calls[1].url).limit === 100, 'limit 超过 100 被夹紧到 100')
  fetcher.close()
})

await section('createOkxFetcher：先代理后直连并记住成功通道', async () => {
  const request = makeRequest((target, url) => {
    if (target === 'proxy') throw new Error('connect ECONNREFUSED 127.0.0.1:1')
    const { after, limit } = parseAfterLimit(url)
    return { status: 200, body: okxBody(makeRows({ after, limit, earliest: 0 })) }
  })
  const fetcher = createOkxFetcher({ proxy: 'http://127.0.0.1:1', request, retries: 0, delayMs: 0 })
  const first = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
  check(first.ok === true, '代理失败后自动退直连并成功')
  check(request.calls.map((call) => call.target).join(',') === 'proxy,direct', '第一次请求顺序：先 proxy 后 direct')
  check(request.calls[0].proxy !== null && request.calls[0].proxy.port === 1, 'request 收到解析后的代理对象')

  request.calls.length = 0
  const second = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
  check(second.ok === true && request.calls.map((call) => call.target).join(',') === 'direct',
    '记住上次成功通道：第二次直接走 direct，不再先踩代理')
  check(fetcher.stats.channel === 'direct' && fetcher.stats.ok === 2, 'stats.channel=direct、成功页数=2')
  fetcher.close()
})

await section('createOkxFetcher：网络错误退避重试 / 429 等待重试 / 失败归一', async () => {
  // 网络错误：第 1 次抛错，第 2 次成功；重试前应退避 300ms
  {
    const request = makeRequest((target, url, callIndex) => {
      if (callIndex === 1) throw new Error('socket hang up')
      const { after, limit } = parseAfterLimit(url)
      return { status: 200, body: okxBody(makeRows({ after, limit, earliest: 0 })) }
    })
    const fetcher = createOkxFetcher({ proxy: null, request, retries: 2, delayMs: 0 })
    const startedAt = Date.now()
    const result = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
    const elapsed = Date.now() - startedAt
    check(result.ok === true && request.calls.length === 2, '网络错误后自动重试一次并成功')
    check(elapsed >= 280, '网络错误重试前有退避等待（实测 ' + String(elapsed) + 'ms >= 300ms 量级）')
    check(fetcher.stats.retries === 1 && fetcher.stats.errors === 1, 'stats 记录重试 1 次、网络异常 1 次')
    fetcher.close()
  }

  // 429：等待 1200ms 后重试
  {
    const request = makeRequest((target, url, callIndex) => {
      if (callIndex === 1) return { status: 429, body: Buffer.from('') }
      const { after, limit } = parseAfterLimit(url)
      return { status: 200, body: okxBody(makeRows({ after, limit, earliest: 0 })) }
    })
    const fetcher = createOkxFetcher({ proxy: null, request, retries: 1, delayMs: 0 })
    const startedAt = Date.now()
    const result = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
    const elapsed = Date.now() - startedAt
    check(result.ok === true && request.calls.length === 2, 'HTTP 429 等待后重试成功')
    check(elapsed >= 1_150, '429 后等待约 1200ms（实测 ' + String(elapsed) + 'ms）')
    check(fetcher.stats.rateLimited === 1, 'stats 记录限速 1 次')
    fetcher.close()
  }

  // 一直 500：有限重试后返回中文错误，绝不抛
  {
    const request = makeRequest(() => ({ status: 500, body: Buffer.from('server boom') }))
    const fetcher = createOkxFetcher({ proxy: null, request, retries: 1, delayMs: 0 })
    const result = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
    check(result.ok === false && result.error.includes('HTTP 500'), 'HTTP 500 最终失败并返回中文错误：' + String(result.error).slice(0, 60))
    check(fetcher.stats.failed === 1, 'stats.failed 记 1 次最终失败')
    fetcher.close()
  }

  // 非 JSON / OKX 业务错误
  {
    const fetcherJson = createOkxFetcher({
      proxy: null,
      retries: 0,
      delayMs: 0,
      request: async () => ({ status: 200, body: Buffer.from('这不是 JSON') }),
    })
    const badJson = await fetcherJson.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
    check(badJson.ok === false && badJson.error.includes('不是 JSON'), '响应不是 JSON 时返回失败（不抛）')
    fetcherJson.close()

    const fetcherOkx = createOkxFetcher({
      proxy: null,
      retries: 0,
      delayMs: 0,
      request: async () => ({ status: 200, body: okxErrorBody('51001', 'Instrument does not exist') }),
    })
    const okxFail = await fetcherOkx.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
    check(okxFail.ok === false && okxFail.error.includes('OKX 接口报错') && okxFail.error.includes('Instrument does not exist'),
      'OKX code!=0 时返回接口错误信息（不抛）')
    fetcherOkx.close()
  }
})

await section('createOkxFetcher：参数校验 / 限速间隔 / close', async () => {
  const request = makeRequest(() => {
    throw new Error('参数非法时不应真的发请求')
  })
  const fetcher = createOkxFetcher({ proxy: null, request, retries: 0, delayMs: 0 })
  const noInstId = await fetcher.fetchPage({})
  check(noInstId.ok === false && noInstId.error.includes('instId'), '缺 instId 返回中文错误（不抛）')
  const nullParams = await fetcher.fetchPage(null)
  check(nullParams.ok === false, 'fetchPage(null) 返回失败（不抛）')
  const badAfter = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: -1 })
  check(badAfter.ok === false && badAfter.error.includes('after'), '非法 after 返回中文错误（不抛）')
  check(request.calls.length === 0, '参数非法时一个网络请求都没发')
  fetcher.close()
  fetcher.close()
  ok('close() 可重复调用，不抛错')

  // delayMs：两次请求的发出时间间隔必须 >= delayMs
  const delayedRequest = makeRequest((target, url) => {
    const { after, limit } = parseAfterLimit(url)
    return { status: 200, body: okxBody(makeRows({ after, limit, earliest: 0 })) }
  })
  const throttled = createOkxFetcher({ proxy: null, request: delayedRequest, delayMs: 80 })
  await throttled.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
  await throttled.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: PAGE_AFTER, limit: 10 })
  const gap = delayedRequest.calls[1].at - delayedRequest.calls[0].at
  check(gap >= 70, '请求间隔 >= delayMs（实测 ' + String(gap) + 'ms >= 80ms 量级）')
  throttled.close()
})

// ================================================================== 3) loadBars（假 fetcher + 临时缓存）
await section('loadBars：分页拼装与缓存落盘', async () => {
  const dir = tempDir('paging')
  const fetcher = makePagedFetcher({ calls: [] })
  const start = LAST_CLOSED - 249 * HOUR
  const result = await loadBars({ bar: '1h', start, end: NOW, dataDir: dir, now: NOW, fetcher })

  const expected = expectedBarCount(start, NOW) // 250
  check(result.ok === true && result.error === null, 'loadBars 成功')
  check(result.bars.length === 250 && expected === 250, '分页拼装出 250 根 K 线（3 页）')
  check(result.fetchedPages === 3, 'fetchedPages=3（250 根 / 每页 100）')
  check(result.fromCache === false, '首次抓取 fromCache=false')
  check(result.requested.start === start && result.requested.end === NOW, 'requested 原样回填请求区间')

  const ascending = result.bars.every((bar, index, list) => index === 0 || bar.t === list[index - 1].t + HOUR)
  check(ascending, 'bars 升序且时间连续（相邻差正好 1h）')
  check(result.bars[0].t === start && result.bars[result.bars.length - 1].t === LAST_CLOSED, 'bars 首尾正好覆盖请求区间')
  check(result.coverage !== null && result.coverage.from === start && result.coverage.to === LAST_CLOSED + HOUR,
    'coverage 覆盖首根开盘到末根收盘')

  check(fetcher.calls.length === 3, 'fetcher 被调用 3 次（每页一次）')
  check(fetcher.calls.every((call) => call.limit === 100), '每页请求 limit=100')
  check(fetcher.calls.every((call) => call.instId === 'BTC-USDT-SWAP' && call.okxBar === '1H'),
    'fetcher 收到 instId/okxBar（1h → OKX 的 1H 来自 config.TIMEFRAMES）')
  check(fetcher.calls[0].after === CUTOFF, '第一页 after=已收盘时间截止线')
  check(fetcher.calls[1].after === LAST_CLOSED - 99 * HOUR, '第二页 after=上一页最早时间戳')

  const cacheFile = join(dir, 'BTC-USDT-SWAP', '1h.json')
  check(existsSync(cacheFile), '缓存在 <dataDir>/<instId>/<bar>.json')
  const cache = readJson(cacheFile)
  check(cache.version === 1 && cache.instId === 'BTC-USDT-SWAP' && cache.bar === '1h' && typeof cache.updatedAt === 'number',
    '缓存文件头：version/instId/bar/updatedAt')
  check(cache.bars.length === 300, '缓存里存了 3 页共 300 根（含请求区间外多翻到的更早数据，下次更宽区间可直接命中）')
  check(Array.isArray(cache.bars[0]) && cache.bars[0].length === 6, '缓存 bars 是 [t,o,h,l,c,v] 六元组（不含 confirm）')
  check(cache.segments.length === 1 && cache.segments[0][0] === LAST_CLOSED - 299 * HOUR && cache.segments[0][1] === CUTOFF,
    '缓存 segments 记录连续覆盖区间')

  // 同参数第二次：缓存命中，一个请求都不许发
  const counting = { calls: 0, async fetchPage() { counting.calls += 1; return { ok: false, error: '缓存命中时不应联网' } } }
  const result2 = await loadBars({ bar: '1h', start, end: NOW, dataDir: dir, now: NOW, fetcher: counting })
  check(result2.ok === true && result2.fromCache === true && result2.fetchedPages === 0 && counting.calls === 0,
    '缓存命中：fromCache=true、fetchedPages=0、一个网络请求都没发')
  check(result2.bars.length === 250 && result2.bars[0].t === result.bars[0].t, '缓存命中的数据与首次抓取一致')
})

await section('loadBars：缺口填补与 segments 合并', async () => {
  const dir = tempDir('gap')
  const startA = LAST_CLOSED - 99 * HOUR
  const firstFetcher = makePagedFetcher({ calls: [] })
  const first = await loadBars({ bar: '1h', start: startA, end: NOW, dataDir: dir, now: NOW, fetcher: firstFetcher })
  check(first.ok === true && first.bars.length === 100 && first.fetchedPages === 1, '先缓存 [A, now) 的 100 根（1 页）')

  const startB = startA - 40 * HOUR
  const gapFetcher = makePagedFetcher({ calls: [] })
  const second = await loadBars({ bar: '1h', start: startB, end: NOW, dataDir: dir, now: NOW, fetcher: gapFetcher })
  check(second.ok === true && second.bars.length === 140, '扩大区间后补齐左边 40 根，共 140 根')
  check(second.fetchedPages === 1 && gapFetcher.calls.length === 1, '只抓缺口 1 页（不重抓已缓存段）')
  check(gapFetcher.calls[0].after === startA, '缺口抓取 after=已缓存段的左端（从这里往回翻）')

  const cache = readJson(join(dir, 'BTC-USDT-SWAP', '1h.json'))
  check(cache.segments.length === 1, '相邻区间合并成 1 个 segment（不碎片化）')
  // 本页跨过缺口左端又把更早的 100 根带回来了，覆盖区间从左页最早一根连续到截止线
  check(cache.segments[0][1] === CUTOFF, 'segment 右端等于已收盘截止线')
  check(cache.segments[0][0] === LAST_CLOSED - 199 * HOUR, 'segment 左端等于实际连续抓到的最早一根')

  // 更宽区间：完全命中缓存，不再联网
  const counting = { calls: 0, async fetchPage() { counting.calls += 1; return { ok: true, rows: [] } } }
  const third = await loadBars({ bar: '1h', start: startB - 10 * HOUR, end: NOW, dataDir: dir, now: NOW, fetcher: counting })
  check(third.ok === true && third.fromCache === true && counting.calls === 0 && third.bars.length === 150,
    '更宽区间落在已覆盖范围内：不联网，150 根全部来自缓存')
})

await section('loadBars：offline 模式', async () => {
  const dir = tempDir('offline')
  const start = LAST_CLOSED - 49 * HOUR
  const online = await loadBars({ bar: '1h', start, end: NOW, dataDir: dir, now: NOW, fetcher: makePagedFetcher() })
  check(online.ok === true && online.bars.length === 50, '先在线缓存 50 根')

  const counting = { calls: 0, async fetchPage() { counting.calls += 1; return { ok: true, rows: [] } } }
  const hit = await loadBars({ bar: '1h', start, end: NOW, dataDir: dir, now: NOW, offline: true, fetcher: counting })
  check(hit.ok === true && hit.fromCache === true && counting.calls === 0 && hit.bars.length === 50,
    'offline 命中缓存：ok=true、不联网')

  const widerStart = start - 200 * HOUR
  const miss = await loadBars({ bar: '1h', start: widerStart, end: NOW, dataDir: dir, now: NOW, offline: true, fetcher: counting })
  check(miss.ok === false, 'offline 缓存没覆盖更宽区间：ok=false')
  check(String(miss.error).includes('离线模式下缓存没有覆盖'), 'offline 缺数据报错文案含「离线模式下缓存没有覆盖」：' + String(miss.error).slice(0, 80))
  check(counting.calls === 0, 'offline 缺数据时也一个请求都没发')

  const emptyDir = tempDir('offline-empty')
  const noCache = await loadBars({ bar: '1h', start, end: NOW, dataDir: emptyDir, now: NOW, offline: true })
  check(noCache.ok === false && String(noCache.error).includes('离线模式下缓存没有覆盖'), 'offline 空缓存同样报覆盖错误')
})

await section('loadBars：未收盘 K 线与 confirm 剔除', async () => {
  const dir = tempDir('unclosed')
  const start = LAST_CLOSED - 4 * HOUR
  const showFetcher = makePagedFetcher({
    calls: [],
    rowsFactory: () => {
      const rows = []
      // 接口（或注入的假 fetcher）可能把正在走的那根也带回来：时间上未收盘，必须丢掉
      rows.push([LAST_CLOSED + HOUR, 100, 101, 99, 100, 5, '', '', '0'])
      for (const offset of [0, 1, 2, 3, 4]) {
        const t = LAST_CLOSED - offset * HOUR
        // 02:00 那根时间上已收盘，但 confirm='0'：按 SPEC 也必须剔除
        rows.push([t, 100, 101, 99, 100, 5, '', '', t === LAST_CLOSED - 2 * HOUR ? '0' : '1'])
      }
      return rows
    },
  })
  const result = await loadBars({ bar: '1h', start, end: NOW + 3 * HOUR, dataDir: dir, now: NOW, fetcher: showFetcher })
  check(result.ok === true && result.bars.length === 4, '未收盘 K 线 + confirm=0 的 K 线都被剔除（5 根只剩 4 根）')
  check(result.bars.every((bar) => bar.t + HOUR <= NOW), '返回的每根 K 线都满足 t + barMs <= now')
  check(!result.bars.some((bar) => bar.t === LAST_CLOSED + HOUR), '正在走的 K 线（05:00）没有出现在结果里')
  check(!result.bars.some((bar) => bar.t === LAST_CLOSED - 2 * HOUR), 'confirm=0 的 K 线（02:00）没有出现在结果里')
  check(result.warnings.some((warning) => warning.includes('夹紧')), 'end 超过 now 时给出夹紧 warning')

  const cache = readJson(join(dir, 'BTC-USDT-SWAP', '1h.json'))
  check(cache.bars.length === 4, '缓存里也只有 4 根已收盘 K 线')
  check(cache.bars.every((row) => row[0] + HOUR <= NOW), '缓存里没有未收盘 K 线')
  check(cache.bars.every((row) => row.length === 6), '缓存行是纯 6 字段（confirm 已剥离）')

  // 手工构造的旧缓存里混进未收盘 K 线：读取时清除，offline 也能正常用
  const dirtyDir = tempDir('dirty-cache')
  const lastT = LAST_CLOSED
  const bars = [lastT - 3 * HOUR, lastT - 2 * HOUR, lastT - HOUR, lastT]
    .map((t) => [t, 100, 101, 99, 100.5, 10])
  bars.push([lastT + HOUR, 100, 101, 99, 100.5, 10]) // 05:00：正在走的那根
  writeJson(join(dirtyDir, 'BTC-USDT-SWAP', '1h.json'), {
    version: 1,
    instId: 'BTC-USDT-SWAP',
    bar: '1h',
    updatedAt: Date.now(),
    earliestKnown: null,
    segments: [[lastT - 3 * HOUR, lastT + HOUR]],
    bars,
  })
  const cleaned = await loadBars({ bar: '1h', start: lastT - 3 * HOUR, end: NOW + 2 * HOUR, dataDir: dirtyDir, now: NOW, offline: true })
  check(cleaned.ok === true && cleaned.bars.length === 4, '读缓存时剔除未收盘 K 线（offline 仍可用）')
  check(!cleaned.bars.some((bar) => bar.t === lastT + HOUR), '手工塞进缓存的 05:00 未收盘 K 线没有被返回')
})

await section('loadBars：联网部分失败降级为 warning', async () => {
  const dir = tempDir('partial')
  const start = LAST_CLOSED - 249 * HOUR
  const fetcher = makePagedFetcher({ calls: [], failAt: 2 }) // 第 2 页失败，第 1 页已成功
  const result = await loadBars({ bar: '1h', start, end: NOW, dataDir: dir, now: NOW, fetcher })
  check(result.ok === true, '部分数据可用时仍 ok=true（降级而不是整次失败）')
  check(result.fetchedPages === 2, 'fetchedPages=2（含失败的那一页尝试）')
  check(result.bars.length === 100, '只拿到第 1 页的 100 根')
  check(result.warnings.some((warning) => warning.includes('模拟网络错误')), 'warnings 说明联网失败原因')
  check(result.warnings.some((warning) => warning.includes('未覆盖')), 'warnings 说明哪些区间没覆盖到')
  check(result.coverage !== null && result.coverage.from === LAST_CLOSED - 99 * HOUR, 'coverage 只报告实际拿到的范围')

  const cache = readJson(join(dir, 'BTC-USDT-SWAP', '1h.json'))
  check(cache.bars.length === 100 && cache.segments.length === 1, '已抓到的部分已落盘（下一次不用重抓）')

  const offline = await loadBars({ bar: '1h', start, end: NOW, dataDir: dir, now: NOW, offline: true })
  check(offline.ok === false && String(offline.error).includes('离线模式下缓存没有覆盖'), '部分成功留下的缓存仍不足以离线覆盖整个区间')

  // 一根都没拿到：ok=false，且有中文错误
  const emptyDir = tempDir('total-fail')
  const alwaysFail = makePagedFetcher({ calls: [], failAt: 1 })
  const totalFail = await loadBars({ bar: '1h', start, end: NOW, dataDir: emptyDir, now: NOW, fetcher: alwaysFail })
  check(totalFail.ok === false && String(totalFail.error).includes('获取历史 K 线失败'), '一根都没抓到：ok=false 且错误含「获取历史 K 线失败」')
  check(totalFail.bars.length === 0, '失败时 bars 为空')
  check(!existsSync(join(emptyDir, 'BTC-USDT-SWAP', '1h.json')), '一根都没抓到时不写缓存文件')
})

await section('loadBars：maxPages 防死循环', async () => {
  const dir = tempDir('maxpages')
  const start = LAST_CLOSED - 499 * HOUR
  const fetcher = makePagedFetcher({ calls: [] }) // 永远能翻出数据，靠 maxPages 停下
  const result = await loadBars({ bar: '1h', start, end: NOW, dataDir: dir, now: NOW, fetcher, maxPages: 2 })
  check(result.ok === true, 'maxPages 触顶但有部分数据：ok=true')
  check(result.fetchedPages === 2 && fetcher.calls.length === 2, '最多只翻 maxPages=2 页（不会无限抓）')
  check(result.bars.length === 200, '只返回已抓到的 200 根')
  check(result.warnings.some((warning) => warning.includes('maxPages')), 'maxPages 触顶给出 warning')
})

await section('loadBars：交易所历史深度下界（earliestKnown）', async () => {
  const dir = tempDir('earliest')
  const earliest = LAST_CLOSED - 249 * HOUR // 交易所只有最近 250 根
  const requestStart = earliest - 60 * HOUR
  const fetcher = makePagedFetcher({ calls: [], earliest })
  const first = await loadBars({ bar: '1h', start: requestStart, end: NOW, dataDir: dir, now: NOW, fetcher })
  check(first.ok === true && first.bars.length === 250, '请求更早区间时按交易所实际能取到的 250 根返回')
  check(first.fetchedPages === 4, '翻到空页才停（3 页有数据 + 1 页空页确认到底）')
  check(first.bars[0].t === earliest, '第一根就是交易所最早可用的一根')
  check(first.warnings.some((warning) => warning.includes('最早可用')), 'warnings 说明请求区间早于交易所最早可用数据')

  const cache = readJson(join(dir, 'BTC-USDT-SWAP', '1h.json'))
  check(cache.earliestKnown === earliest, '缓存记录 earliestKnown（历史深度下界）')
  check(cache.segments.length === 1 && cache.segments[0][0] === earliest, 'segments 左端等于最早可用 K 线')

  // 第二次同样请求：已知下界，直接夹掉，不再重试空区间
  const counting = { calls: 0, async fetchPage() { counting.calls += 1; return { ok: true, rows: [] } } }
  const second = await loadBars({ bar: '1h', start: requestStart, end: NOW, dataDir: dir, now: NOW, fetcher: counting })
  check(second.ok === true && second.fromCache === true && counting.calls === 0 && second.bars.length === 250,
    '第二次请求：不再为「没有更早数据」的区间联网（历史深度下界已缓存）')
  check(second.warnings.some((warning) => warning.includes('最早可用')), '第二次仍然提醒区间早于可用数据')

  // 请求整个落在下界之前：直接报没有可用数据，不联网
  const before = await loadBars({
    bar: '1h',
    start: earliest - 200 * HOUR,
    end: earliest - 50 * HOUR,
    dataDir: dir,
    now: NOW,
    fetcher: counting,
  })
  check(before.ok === false && String(before.error).includes('没有可用的已收盘 K 线'), '请求区间完全早于下界：ok=false 且说明没有可用 K 线')
  check(counting.calls === 0, '完全早于下界时也不联网')
})

await section('loadBars：参数校验与周期映射', async () => {
  const dir = tempDir('validate')
  const badBar = await loadBars({ bar: '2h', start: NOW - 10 * HOUR, end: NOW, dataDir: dir, now: NOW })
  check(badBar.ok === false && String(badBar.error).includes('不支持的 K 线周期'), '未知周期返回中文错误（不抛）')

  const badRange = await loadBars({ bar: '1h', start: NOW, end: NOW, dataDir: dir, now: NOW })
  check(badRange.ok === false && String(badRange.error).includes('起始时间必须早于结束时间'), 'start>=end 返回中文错误')

  const nullOptions = await loadBars(null)
  check(nullOptions.ok === false && String(nullOptions.error).includes('必须是对象'), 'loadBars(null) 返回中文错误（不抛）')

  const missingRange = await loadBars({ bar: '1h', dataDir: dir, now: NOW })
  check(missingRange.ok === false && String(missingRange.error).includes('缺少合法的起止时间'), '缺 start/end 返回中文错误')

  const future = await loadBars({ bar: '1h', start: NOW + DAY, end: NOW + 2 * DAY, dataDir: dir, now: NOW })
  check(future.ok === false && String(future.error).includes('没有已收盘的 K 线'), '请求区间全在 now 之后：没有已收盘 K 线')

  const badFetcherDir = tempDir('validate-fetcher')
  const badFetcher = await loadBars({ bar: '1h', start: NOW - 10 * HOUR, end: NOW, dataDir: badFetcherDir, now: NOW, fetcher: {} })
  check(badFetcher.ok === false && String(badFetcher.error).includes('fetchPage'), 'fetcher 缺 fetchPage 返回中文错误')

  // 1D 周期：okxBar 必须映射成 '1D'（来自 config.TIMEFRAMES，不在这里重写周期表）
  const dailyDir = tempDir('daily')
  const dailyFetcher = makePagedFetcher({ calls: [], barMs: DAY })
  const lastClosedDay = Math.floor((NOW - DAY) / DAY) * DAY
  const daily = await loadBars({
    bar: '1D',
    start: lastClosedDay - 9 * DAY,
    end: NOW,
    dataDir: dailyDir,
    now: NOW,
    fetcher: dailyFetcher,
  })
  check(daily.ok === true && daily.bars.length === 10, '1D 周期能正常分页拼装（10 根）')
  check(dailyFetcher.calls[0].okxBar === '1D' && dailyFetcher.calls[0].instId === 'BTC-USDT-SWAP', '1D 传给 OKX 的 bar=1D')
  check(daily.bars[0].t === lastClosedDay - 9 * DAY && daily.bars[daily.bars.length - 1].t === lastClosedDay,
    '1D 时间戳按 86400000 连续')
})

await section('readBarFile：三种 JSON 形状与错误处理', async () => {
  const dir = tempDir('readbar')
  const t0 = LAST_CLOSED - 2 * HOUR
  const rows = [
    [t0, 100, 102, 99, 101, 12],
    [t0 + HOUR, 101, 103, 100, 102, 13],
  ]

  const arraysFile = join(dir, 'arrays.json')
  writeFileSync(arraysFile, JSON.stringify({ bars: rows }), 'utf8')
  const fromArrays = readBarFile(arraysFile)
  check(fromArrays.length === 2 && fromArrays[0].t === t0 && fromArrays[0].c === 101, '形状 1：{bars:[[t,o,h,l,c,v],...]}')

  const objectsFile = join(dir, 'objects.json')
  writeFileSync(objectsFile, JSON.stringify({ bars: rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })) }), 'utf8')
  const fromObjects = readBarFile(objectsFile)
  check(fromObjects.length === 2 && fromObjects[1].t === t0 + HOUR && fromObjects[1].v === 13, '形状 2：{bars:[{t,o,h,l,c,v},...]}')

  const bareFile = join(dir, 'bare.json')
  writeFileSync(bareFile, JSON.stringify(rows.map(([t, o, h, l, c, v]) => [t, o, h, l, c, v])), 'utf8')
  const fromBare = readBarFile(bareFile)
  check(fromBare.length === 2 && fromBare[0].t === t0, '形状 3：裸数组')

  const cacheLike = join(dir, 'cache-like.json')
  writeFileSync(cacheLike, JSON.stringify({ version: 1, instId: 'BTC-USDT-SWAP', bar: '1h', segments: [[t0, t0 + 2 * HOUR]], bars: rows }), 'utf8')
  const fromCacheLike = readBarFile(cacheLike)
  check(fromCacheLike.length === 2, '缓存文件（带元数据的形状 1）也能被 readBarFile 读取')

  const duplicateFile = join(dir, 'duplicate.json')
  writeFileSync(duplicateFile, JSON.stringify([[t0, 100, 102, 99, 101, 12], [t0, 100, 105, 99, 104, 20]]), 'utf8')
  const deduped = readBarFile(duplicateFile)
  check(deduped.length === 1 && deduped[0].c === 104, '同一时间戳去重：保留后一行')

  expectThrow(() => readBarFile(join(dir, 'missing.json')), '读取 K 线文件失败', '文件不存在抛中文 Error')
  const badJsonFile = join(dir, 'bad.json')
  writeFileSync(badJsonFile, '这不是 JSON', 'utf8')
  expectThrow(() => readBarFile(badJsonFile), '不是合法 JSON', '非法 JSON 抛中文 Error')
  const badShapeFile = join(dir, 'bad-shape.json')
  writeFileSync(badShapeFile, JSON.stringify({ foo: 1 }), 'utf8')
  expectThrow(() => readBarFile(badShapeFile), '格式不支持', '不支持的形状抛中文 Error')
  const descendingFile = join(dir, 'descending.json')
  writeFileSync(descendingFile, JSON.stringify([[t0 + HOUR, 100, 102, 99, 101, 12], [t0, 100, 102, 99, 101, 12]]), 'utf8')
  expectThrow(() => readBarFile(descendingFile), '升序', '时间降序抛中文 Error')
  const invalidRowFile = join(dir, 'invalid-row.json')
  writeFileSync(invalidRowFile, JSON.stringify([[t0, 100]]), 'utf8')
  expectThrow(() => readBarFile(invalidRowFile), '不是合法 K 线', '非法行抛中文 Error')

  const emptyFile = join(dir, 'empty.json')
  writeFileSync(emptyFile, JSON.stringify({ bars: [] }), 'utf8')
  check(readBarFile(emptyFile).length === 0, '空 bars 数组返回空列表')
})

// ------------------------------------------------------------------ 收尾
for (const dir of createdDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    // 清理临时目录失败不影响测试结论
  }
}

console.log('')
if (failed === 0) {
  console.log('全部通过（' + String(passed) + ' 项）')
} else {
  console.log(String(failed) + ' 项失败（通过 ' + String(passed) + ' 项）')
}
