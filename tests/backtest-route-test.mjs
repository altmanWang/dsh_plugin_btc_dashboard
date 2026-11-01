/**
 * `/dsh-btc/backtest/*` 路由的离线自检。
 *
 * 思路：把 `createBacktestService({ lib })` 的 **data.loadBars 换成合成 K 线**，
 * engine / metrics / report 仍然用真的 —— 这样既不联网、又快，又能验证"面板要的那份裁剪数据"
 * 和"报告确实能生成"。路由层用 `apply(ctx, { backtestService })` 注入同一个 service，
 * 完整走一遍注册/参数校验/HTTP 响应头。
 *
 * 覆盖：
 *   1. strategies：默认口径（1 倍杠杆、maker 0.0200%、taker 0.0500%）、策略列表、周期列表
 *   2. run → 轮询 status 到 done：进度文案、PanelSummary 形状（equity 降采样、trades、fees、reports 链接）
 *   3. report：HTML（CSP 头、正文是自包含报告）/ JSON（可解析、字段齐全）
 *   4. 同一时间只允许一个 job；cancel 在阶段边界生效
 *   5. 入参校验：策略白名单（拒绝路径）、参数类型、周期、时间范围、杠杆/费率
 *   6. 超时兜底（jobTimeoutMs 调小验证）
 *   7. 路由层：注册条数、method 守卫（405）、信任栅栏（401）、非法 JSON、未知 jobId
 */
import * as mod from '../plugin/dsh-btc-dashboard/index.js'

const configMod = await import('../backtest/lib/config.mjs')
const strategyMod = await import('../backtest/lib/strategy.mjs')
const dataMod = await import('../backtest/lib/data.mjs')
const engineMod = await import('../backtest/lib/engine.mjs')
const metricsMod = await import('../backtest/lib/metrics.mjs')
const reportMod = await import('../backtest/lib/report.mjs')

let failed = 0
function check(ok, label, detail) {
  const pass = ok === true
  console.log((pass ? 'ok   ' : 'FAIL ') + label + (detail === undefined || detail === '' ? '' : '  ' + detail))
  if (!pass) failed += 1
  return pass
}

// ---------------------------------------------------------------- 合成 K 线（1h × 240）

const BAR_MS = 3_600_000
const START_T = Date.UTC(2024, 0, 1, 0, 0, 0)
const BAR_COUNT = 240
const ALL_BARS = (() => {
  let seed = 20240101
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const round = (value) => Math.round(value * 100) / 100
  const bars = []
  let price = 42000
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const drift = Math.sin(i / 18) * 0.004 + 0.0003
    const open = price
    const close = open * (1 + drift + (rand() - 0.5) * 0.002)
    const high = Math.max(open, close) * (1 + rand() * 0.0015)
    const low = Math.min(open, close) * (1 - rand() * 0.0015)
    bars.push({ t: START_T + i * BAR_MS, o: round(open), h: round(high), l: round(low), c: round(close), v: 100 + i })
    price = close
  }
  return bars
})()
const RANGE_START = START_T
const RANGE_END = START_T + BAR_COUNT * BAR_MS

// ---------------------------------------------------------------- 可注入的假数据层

let loadDelayMs = 0
let loadCalls = 0
/**
 * 数据层真正收到的参数。`instId` 是 job.config.instId 透传到 `data.loadBars` 的证据
 * （返回给前端的 job 视图不含 config，只能从这里和 summary/report 反推）。
 */
const loadBarsCalls = []
/** 让 /status 轮询有机会看到"已抓取 N 页"这种中间态。 */
async function fakeLoadBars(options = {}) {
  loadCalls += 1
  loadBarsCalls.push({
    instId: options.instId,
    bar: options.bar,
    start: Number(options.start),
    end: Number(options.end),
  })
  if (typeof options.log === 'function') {
    options.log('正在连接 OKX…')
    options.log('已抓取 3 页（1h，最早到 2024-01-01 08:00 UTC+8）')
  }
  if (loadDelayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, loadDelayMs))
  const start = Number(options.start)
  const end = Number(options.end)
  const bars = ALL_BARS.filter((bar) => bar.t >= start && bar.t < end)
  return {
    ok: true,
    error: null,
    bars: bars,
    requested: { start: start, end: end },
    coverage: { from: start, to: end },
    fetchedPages: 3,
    fromCache: false,
    warnings: [],
  }
}

/** 真模块 + 假 data.loadBars + 不落盘的 writeReports（测试不往仓库里写报告）。 */
function makeLib() {
  return {
    config: configMod,
    strategy: strategyMod,
    data: { loadBars: fakeLoadBars, readBarFile: dataMod.readBarFile },
    engine: engineMod,
    metrics: metricsMod,
    report: Object.assign({}, reportMod, {
      writeReports: async () => ({ jsonPath: '(test)/a.json', htmlPath: '(test)/a.html', csvPath: '(test)/a.csv' }),
    }),
    transport: {
      createOkxFetcher: () => ({
        fetchPage: async () => ({ ok: false, error: '测试里不应该联网' }),
        close: () => {},
        stats: {},
      }),
    },
  }
}

function makeService(extra) {
  return mod.createBacktestService(Object.assign({ lib: makeLib() }, extra || {}))
}

/** 轮询到目标状态（测试里用真实定时器，20ms 一拍）。 */
async function waitForState(service, jobId, wanted, timeoutMs) {
  const limit = timeoutMs === undefined ? 8000 : timeoutMs
  const want = Array.isArray(wanted) ? wanted : [wanted]
  const started = Date.now()
  for (;;) {
    const answer = service.status(jobId)
    if (answer.ok === true && answer.job !== null && want.indexOf(answer.job.state) >= 0) return answer.job
    if (Date.now() - started > limit) return { timeout: true, last: answer }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

/** 一个够用的 req/res，跑一次路由 handler 并拿回 { status, headers, parsed, text }。 */
function callHandler(handler, options) {
  const opts = options || {}
  const method = opts.method === undefined ? 'GET' : opts.method
  const body = opts.body === undefined ? '' : opts.body
  const url = opts.url === undefined ? '/' : opts.url
  const listeners = {}
  const req = { method: method, url: url, on: (event, fn) => { listeners[event] = fn; return req } }
  let resolveDone
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise })
  const res = {
    statusCode: 200,
    headers: null,
    writeHead: (code, headers) => { res.statusCode = code; res.headers = headers },
    end: (text) => { resolveDone(text === undefined ? '' : String(text)) },
  }
  const promise = Promise.resolve(handler(req, res)).then(() => done)
  setTimeout(() => {
    if (typeof listeners.data === 'function' && body !== '') listeners.data(Buffer.from(body, 'utf8'))
    if (typeof listeners.end === 'function') listeners.end()
  }, 0)
  return promise.then((text) => {
    let parsed = null
    try { parsed = JSON.parse(text) } catch (error) { parsed = null }
    return { status: res.statusCode, headers: res.headers, parsed: parsed, text: text }
  })
}

/** 用假的 webServer 收集 apply() 注册的路由（webserver 对重复 exact path 会抛错，这里同样抛）。 */
function makeHost(service, rejection) {
  const routes = new Map()
  const exact = new Map()
  const disposers = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: (name) => {
      if (name === 'webServer') {
        return {
          register: (spec) => {
            if (exact.has(spec.path)) throw new Error('webserver: duplicate exact route "' + spec.path + '"')
            exact.set(spec.path, spec.handler)
            const list = routes.get(spec.path) === undefined ? [] : routes.get(spec.path)
            list.push(spec.handler)
            routes.set(spec.path, list)
            return () => { exact.delete(spec.path) }
          },
        }
      }
      if (name === 'connection') return { requestRejection: () => rejection }
      return null
    },
  }
  mod.apply(ctx, { backtestService: service })
  return {
    routes: routes,
    handlerAt: (path, index) => {
      const list = routes.get(path)
      if (list === undefined || list.length <= (index === undefined ? 0 : index)) return undefined
      return list[index === undefined ? 0 : index]
    },
    dispose: () => {
      for (const one of disposers) if (typeof one === 'function') one()
      disposers.length = 0
    },
  }
}

const RUN_BODY = {
  strategy: 'buy-hold',
  params: {},
  bar: '1h',
  start: RANGE_START,
  end: RANGE_END,
  initialCapital: 10000,
  leverage: 1,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0005,
}

try {
  // ================================================================ 1) list
  console.log('\n--- 1) strategies 默认口径 ---')
  const service = makeService()
  const listed = await service.list()
  check(listed.ok === true, 'list 返回 ok')
  check(Array.isArray(listed.strategies) && listed.strategies.length >= 2,
    '列出内置策略', (listed.strategies || []).map((s) => s.name).join(','))
  check((listed.strategies || []).some((s) => s.name === 'sma-cross'), '有 sma-cross')
  check((listed.strategies || []).some((s) => s.name === 'buy-hold'), '有 buy-hold')
  check(listed.defaults.instId === 'BTC-USDT-SWAP', '默认标的 BTC-USDT-SWAP', String(listed.defaults.instId))
  check(listed.defaults.leverage === 1, '默认杠杆 1 倍', String(listed.defaults.leverage))
  check(listed.defaults.makerFeeRate === 0.0002, '默认挂单费率 0.0200%', String(listed.defaults.makerFeeRate))
  check(listed.defaults.takerFeeRate === 0.0005, '默认吃单费率 0.0500%', String(listed.defaults.takerFeeRate))
  check(listed.defaults.initialCapital === 10000, '默认初始资金 10000')
  check(Array.isArray(listed.bars) && listed.bars.length === 7, '周期列表 7 个（含 5m）', (listed.bars || []).join('/'))
  check(listed.limits !== undefined && listed.limits.jobTimeoutMs > 0, 'limits 里有超时')
  check(listed.job === null, '还没有 job 时返回 null')
  // 可选标的：回测面板的「标的」下拉直接吃这份列表（Host 侧白名单，前端不写死）
  check(Array.isArray(listed.insts) && listed.insts.length === 2,
    'insts 列出两个可回测标的', JSON.stringify((listed.insts || []).map((item) => item.instId)))
  const instIds = (listed.insts || []).map((item) => item.instId)
  check(instIds.indexOf('BTC-USDT-SWAP') >= 0 && instIds.indexOf('ETH-USDT-SWAP') >= 0,
    'insts 含 BTC-USDT-SWAP / ETH-USDT-SWAP', instIds.join('/'))
  check((listed.insts || []).every((item) => typeof item.label === 'string' && item.label !== ''
    && typeof item.short === 'string' && item.short !== ''),
  'insts 每项带 label / short（回测副标题与看板标题要用）', JSON.stringify((listed.insts || [])[1]))

  // ================================================================ 2) happy path
  console.log('\n--- 2) run → status 轮询到 done ---')
  const started = await service.start(Object.assign({}, RUN_BODY))
  check(started.ok === true, 'run 返回 ok', JSON.stringify(started.error || ''))
  check(started.job !== undefined && /^bt-\d+-\d+$/.test(String(started.job.id)), 'jobId 形状 bt-…', String(started.job && started.job.id))
  check(started.job.state === 'running', '立刻返回 running（不阻塞请求）', String(started.job.state))
  const jobId = started.job.id
  const early = service.status(jobId)
  check(early.ok === true && early.job.id === jobId, 'status 能按 jobId 查到')

  const done = await waitForState(service, jobId, 'done')
  if (done.timeout === true) {
    check(false, 'job 在超时内完成', JSON.stringify(done.last && done.last.job && done.last.job.message))
  } else {
    check(true, 'job 在超时内完成', done.message)
    check(done.summary !== null && typeof done.summary === 'object', 'done 时带 summary')
    const summary = done.summary || {}
    check(summary.instId === 'BTC-USDT-SWAP', 'summary 标的正确')
    // 不传 instId 时必须保持旧行为（默认 BTC）：数据层收到的也是 BTC
    check(loadBarsCalls.length > 0 && loadBarsCalls[0].instId === 'BTC-USDT-SWAP',
      '不传 instId 时数据层仍用默认 BTC-USDT-SWAP', JSON.stringify(loadBarsCalls[0]))
    check(summary.bar === '1h', 'summary 周期正确')
    check(summary.start === RANGE_START && summary.end === RANGE_END, 'summary 回测区间正确')
    check(summary.strategy && summary.strategy.name === 'buy-hold', 'summary 带策略名', summary.strategy && summary.strategy.name)
    check(summary.range && summary.range.bars === BAR_COUNT, 'summary.range.bars = 240', String(summary.range && summary.range.bars))
    check(summary.initialEquity === 10000, '初始权益 10000', String(summary.initialEquity))
    check(Number.isFinite(summary.finalEquity), '最终权益是有限数', String(summary.finalEquity))
    check(summary.metrics !== undefined && Number.isFinite(summary.metrics.totalReturnPct),
      'summary.metrics 带总收益', String(summary.metrics && summary.metrics.totalReturnPct))
    check(summary.metrics !== undefined && summary.metrics.tradeCount >= 1, '有闭合交易', String(summary.metrics && summary.metrics.tradeCount))
    check(Array.isArray(summary.equity) && summary.equity.length > 0 && summary.equity.length <= 600,
      'equity 点数 ≤600', String(summary.equity && summary.equity.length))
    check(summary.equity[0] !== undefined && Number.isFinite(summary.equity[0].equity), 'equity 点带权益')
    check(summary.equity[0] !== undefined && Number.isFinite(summary.equity[0].bh), 'equity 点带 Buy&Hold 基准')
    check(Array.isArray(summary.trades) && summary.trades.length >= 1, 'trades 非空', String(summary.trades && summary.trades.length))
    check(summary.tradeCount === (summary.metrics && summary.metrics.tradeCount), 'tradeCount 与 metrics 一致')
    check(summary.fees !== undefined && summary.fees.taker > 0, '确实扣了吃单手续费', JSON.stringify(summary.fees))
    check(summary.liquidations === 0 && summary.rejected === 0, '没有爆仓/拒单')
    check(typeof summary.reports === 'object' && String(summary.reports.html).indexOf('/backtest/report?jobId=') === 0,
      'reports.html 是相对 API 的路径', String(summary.reports && summary.reports.html))
    check(String(summary.reports.json).indexOf('format=json') > 0, 'reports.json 带 format=json')

    // ---- report（服务层）
    const htmlReport = service.report(jobId, 'html')
    check(htmlReport.ok === true && htmlReport.html === true, 'HTML 报告可取')
    check(String(htmlReport.contentType).indexOf('text/html') === 0, 'HTML content-type 正确')
    check(typeof htmlReport.body === 'string' && htmlReport.body.indexOf('<svg') >= 0, 'HTML 里有内联 SVG')
    check(htmlReport.body.indexOf('BTC-USDT-SWAP') >= 0, 'HTML 标题含标的')
    const jsonReport = service.report(jobId, 'json')
    check(jsonReport.ok === true && jsonReport.html === false, 'JSON 报告可取')
    let reportObject = null
    try { reportObject = JSON.parse(jsonReport.body) } catch (error) { reportObject = null }
    check(reportObject !== null, 'JSON 报告可解析')
    check(reportObject !== null && reportObject.metrics !== undefined, 'JSON 报告带 metrics')
    check(reportObject !== null && reportObject.result !== undefined && reportObject.result.equityCurve.length === BAR_COUNT,
      'JSON 报告带全量资金曲线（240 点）')
    check(reportObject !== null && reportObject.config.makerFeeRate === 0.0002 && reportObject.config.takerFeeRate === 0.0005,
      '报告 config 里费率正确')
  }

  // ================================================================ 2.5) 标的：合法 ETH 生效 / 非法被拒
  console.log('\n--- 2.5) 标的：合法 ETH 生效 / 非法被拒 ---')
  {
    const ethStarted = await service.start(Object.assign({}, RUN_BODY, { instId: 'ETH-USDT-SWAP' }))
    check(ethStarted.ok === true, '带合法 instId=ETH-USDT-SWAP 的 run 成功', JSON.stringify(ethStarted.error || ''))
    if (ethStarted.ok === true) {
      const ethDone = await waitForState(service, ethStarted.job.id, 'done')
      check(ethDone.timeout !== true, 'ETH 回测在超时内完成',
        ethDone.timeout === true
          ? JSON.stringify(ethDone.last && ethDone.last.job && ethDone.last.job.message)
          : String(ethDone.message))
      const ethSummary = ethDone.timeout === true ? {} : (ethDone.summary || {})
      check(ethSummary.instId === 'ETH-USDT-SWAP', 'ETH 回测 summary.instId = ETH-USDT-SWAP', String(ethSummary.instId))
      // job.config.instId 透传到数据层的证据（缓存目录 / 报告 / 资金费率都跟着它走）
      const ethLoad = loadBarsCalls[loadBarsCalls.length - 1]
      check(ethLoad !== undefined && ethLoad.instId === 'ETH-USDT-SWAP',
        'loadBars 收到 instId=ETH-USDT-SWAP', JSON.stringify(ethLoad))
      const ethHtml = service.report(ethStarted.job.id, 'html')
      check(ethHtml.ok === true && String(ethHtml.body).indexOf('ETH-USDT-SWAP') >= 0,
        'ETH 回测的 HTML 报告标题含 ETH-USDT-SWAP')
      const ethJson = service.report(ethStarted.job.id, 'json')
      let ethReport = null
      try { ethReport = JSON.parse(ethJson.body) } catch (error) { ethReport = null }
      check(ethReport !== null && ethReport.config !== undefined && ethReport.config.instId === 'ETH-USDT-SWAP',
        'ETH 回测的 JSON 报告 config.instId = ETH-USDT-SWAP',
        ethReport === null ? 'JSON 解析失败' : String(ethReport.config && ethReport.config.instId))
      check(ethReport !== null && ethReport.config !== undefined && ethReport.config.instId !== 'BTC-USDT-SWAP',
        'ETH 回测没有被悄悄按 BTC 跑')
    }
    // 非法 instId：必须在启动前拒绝（不白跑数据层），错误信息要说人话并给出可选值
    const beforeBadInst = loadCalls
    const badInst = await service.start(Object.assign({}, RUN_BODY, { instId: 'DOGE-USDT-SWAP' }))
    check(badInst.ok === false && typeof badInst.error === 'string' && badInst.error.indexOf('不支持的标的') >= 0,
      '非法 instId 被拒（错误信息含「不支持的标的」）', String(badInst && badInst.error))
    check(badInst.ok === false && String(badInst.error).indexOf('BTC-USDT-SWAP') >= 0
      && String(badInst.error).indexOf('ETH-USDT-SWAP') >= 0,
    '非法 instId 的错误信息里列出可选标的', String(badInst && badInst.error))
    // 错误串由前端统一拼「回测失败：」前缀，Host 侧不能自己再带一遍（否则面板会显示双前缀）
    check(badInst.ok === false && String(badInst.error).indexOf('回测失败：') < 0
      && /^不支持的标的/.test(String(badInst.error)),
    'Host 侧错误串以「不支持的标的 …」开头且不带「回测失败：」前缀', String(badInst && badInst.error))
    check(loadCalls === beforeBadInst, '非法 instId 不会启动 job（不白跑数据层）', String(loadCalls - beforeBadInst))
  }

  // ================================================================ 3) 进度文案
  console.log('\n--- 3) 数据阶段进度（loadBars log → job.message/pages）---')
  loadDelayMs = 120
  const progressStart = await service.start(Object.assign({}, RUN_BODY, { strategy: 'sma-cross', params: { fast: 5, slow: 20 } }))
  check(progressStart.ok === true, '慢任务也能启动')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  const mid = service.status(progressStart.job.id)
  check(mid.ok === true && mid.job.message.indexOf('已抓取 3 页') >= 0,
    '进度文案透传到 message', String(mid.job && mid.job.message))
  check(mid.job.progress.pages === 3, 'progress.pages 被解析出来', String(mid.job && mid.job.progress.pages))
  await waitForState(service, progressStart.job.id, 'done')
  loadDelayMs = 0

  // ================================================================ 4) 并发拒绝 + 取消
  console.log('\n--- 4) 单任务 + 取消 ---')
  loadDelayMs = 200
  const slow = await service.start(Object.assign({}, RUN_BODY))
  check(slow.ok === true, '启动慢任务')
  const second = await service.start(Object.assign({}, RUN_BODY))
  check(second.ok === false, '已有任务时第二次 run 被拒', JSON.stringify(second.error))
  check(second.runningJobId === slow.job.id, '拒绝时返回 runningJobId', String(second.runningJobId))
  const cancelled = service.cancel(slow.job.id)
  check(cancelled.ok === true && cancelled.cancelled === true, 'cancel 立即置取消标记')
  const afterCancel = await waitForState(service, slow.job.id, 'cancelled')
  check(afterCancel.timeout !== true, '任务最终进入 cancelled', afterCancel.message || JSON.stringify(afterCancel.last))
  const cancelAgain = service.cancel(slow.job.id)
  check(cancelAgain.ok === false && cancelAgain.cancelled === false, '对已结束的任务 cancel 返回 cancelled:false', String(cancelAgain.error))
  loadDelayMs = 0

  // ================================================================ 5) 入参校验
  console.log('\n--- 5) 入参校验 ---')
  const beforeCount = loadCalls
  const badCases = [
    ['策略路径注入被拒', { strategy: '../strategies/buy-hold' }],
    ['未知策略被拒', { strategy: 'no-such' }],
    ['策略名类型错误被拒', { strategy: 123 }],
    ['params 是数组被拒', Object.assign({}, RUN_BODY, { params: [1, 2] })],
    ['未知参数被拒（防拼错静默无效）', Object.assign({}, RUN_BODY, { strategy: 'sma-cross', params: { fst: 10 } })],
    ['参数类型非法被拒', Object.assign({}, RUN_BODY, { strategy: 'sma-cross', params: { fast: { x: 1 } } })],
    ['非法周期被拒', Object.assign({}, RUN_BODY, { bar: '2h' })],
    ['开始晚于结束被拒', Object.assign({}, RUN_BODY, { start: RANGE_END, end: RANGE_START })],
    ['杠杆 0 被拒', Object.assign({}, RUN_BODY, { leverage: 0 })],
    ['费率过大被拒', Object.assign({}, RUN_BODY, { makerFeeRate: 0.9 })],
    ['请求体不是对象被拒', null],
  ]
  for (const [label, body] of badCases) {
    const answer = await service.start(body)
    check(answer.ok === false && typeof answer.error === 'string' && answer.error !== '', label,
      String(answer && answer.error).slice(0, 60))
  }
  // 规模防呆：1m × 一年 ≈ 52 万根 / 5,256 页，超过数据层 2,000 页上限 → 必须在启动前拒绝，
  // 不能"跑 20 分钟再超时"，更不能拿覆盖不全的结果当回测。
  {
    const now = Date.now()
    const tooBig = await service.start(Object.assign({}, RUN_BODY, {
      bar: '1m', start: now - 365 * 86400000, end: now,
    }))
    check(tooBig.ok === false && String(tooBig.error).indexOf('区间太大') >= 0, '超大区间在启动前被拒（1m×一年）',
      String(tooBig && tooBig.error).slice(0, 80))
  }
  check(loadCalls === beforeCount, '校验失败不会启动 job（不会白跑数据层）', String(loadCalls - beforeCount))

  // ================================================================ 6) 未知 job
  console.log('\n--- 6) 未知 jobId ---')
  check(service.status('bt-nope').ok === false, 'status 未知 jobId 报错')
  check(service.report('bt-nope', 'html').ok === false, 'report 未知 jobId 报错')
  check(service.cancel('bt-nope').ok === false, 'cancel 未知 jobId 报错')

  // ================================================================ 7) 超时
  console.log('\n--- 7) 超时兜底 ---')
  const timeoutService = makeService({ jobTimeoutMs: 80 })
  loadDelayMs = 300
  const timeoutStart = await timeoutService.start(Object.assign({}, RUN_BODY))
  check(timeoutStart.ok === true, '超时用例启动')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  const timedMid = timeoutService.status(timeoutStart.job.id)
  check(timedMid.job.cancelRequested === true, '到点后置 cancelRequested')
  const timedEnd = await waitForState(timeoutService, timeoutStart.job.id, ['cancelled', 'error'])
  check(timedEnd.timeout !== true && String(timedEnd.message).indexOf('超时') >= 0,
    '最终状态说明是超时', String(timedEnd.message))
  loadDelayMs = 0

  // ================================================================ 8) 路由层
  console.log('\n--- 8) 路由层 ---')
  const routeService = makeService()
  const host = makeHost(routeService)
  try {
    const paths = [
      ['/dsh-btc/backtest/strategies', 'GET'],
      ['/dsh-btc/backtest/run', 'POST'],
      ['/dsh-btc/backtest/status', 'GET'],
      ['/dsh-btc/backtest/report', 'GET'],
      ['/dsh-btc/backtest/cancel', 'POST'],
    ]
    check(host.routes.size === 11, '注册了 11 条路由（6 条原有 + 5 条回测）', String(host.routes.size))
    for (const [path] of paths) {
      check(host.routes.has(path) && host.handlerAt(path) !== undefined, '注册了 ' + path)
    }

    const strategiesRes = await callHandler(host.handlerAt('/dsh-btc/backtest/strategies'), { method: 'GET', url: '/dsh-btc/backtest/strategies' })
    check(strategiesRes.status === 200 && strategiesRes.parsed.ok === true, 'GET strategies 返回 200 + ok')
    check(Array.isArray(strategiesRes.parsed.insts) && strategiesRes.parsed.insts.length === 2,
      'GET strategies 路由响应带 insts（两个标的）',
      JSON.stringify((strategiesRes.parsed.insts || []).map((item) => item.instId)))

    const runRes = await callHandler(host.handlerAt('/dsh-btc/backtest/run'), {
      method: 'POST', url: '/dsh-btc/backtest/run', body: JSON.stringify(RUN_BODY),
    })
    check(runRes.status === 200 && runRes.parsed.ok === true && runRes.parsed.job !== undefined,
      'POST run 返回 job', JSON.stringify(runRes.parsed.error || ''))
    const routeJobId = runRes.parsed.job.id
    await waitForState(routeService, routeJobId, 'done')
    const statusRes = await callHandler(host.handlerAt('/dsh-btc/backtest/status'), {
      method: 'GET', url: '/dsh-btc/backtest/status?jobId=' + encodeURIComponent(routeJobId),
    })
    check(statusRes.parsed.ok === true && statusRes.parsed.job.state === 'done', 'GET status 返回 done')
    const htmlRes = await callHandler(host.handlerAt('/dsh-btc/backtest/report'), {
      method: 'GET', url: '/dsh-btc/backtest/report?jobId=' + encodeURIComponent(routeJobId) + '&format=html',
    })
    check(htmlRes.status === 200, 'GET report html 返回 200', String(htmlRes.status))
    check(htmlRes.headers !== null && String(htmlRes.headers['content-type']).indexOf('text/html') === 0,
      'HTML content-type', JSON.stringify(htmlRes.headers && htmlRes.headers['content-type']))
    check(htmlRes.headers !== null && String(htmlRes.headers['content-security-policy']).indexOf("default-src 'none'") >= 0,
      'HTML 带 CSP 安全头', JSON.stringify(htmlRes.headers && htmlRes.headers['content-security-policy']))
    check(htmlRes.headers !== null && htmlRes.headers['x-content-type-options'] === 'nosniff', 'HTML 带 nosniff')
    check(htmlRes.text.indexOf('<svg') >= 0, 'HTML 正文是完整报告')
    // K 线图：Host 侧（index.js → lib.report.buildHtmlReport）必须把 bars 透传进去，
    // 否则报告只剩资金/回撤两张图 —— 这个断言专门盯「忘了传 bars」这种回归。
    check(htmlRes.text.indexOf('价格 K 线与交易标记') >= 0, 'HTML 含价格 K 线小节')
    check((htmlRes.text.match(/class="candle-(up|down)"/g) || []).length > 0, 'HTML 里真的画出了蜡烛',
      'candles=' + String((htmlRes.text.match(/class="candle-(up|down)"/g) || []).length))
    check(htmlRes.text.indexOf('报告格式 v3') >= 0, 'HTML 页脚有报告格式版本标记（用来区分旧宿主生成的文件）')
    check(htmlRes.text.indexOf('资金费率') >= 0, 'HTML 报告含资金费率口径（v3）')
    const jsonRes = await callHandler(host.handlerAt('/dsh-btc/backtest/report'), {
      method: 'GET', url: '/dsh-btc/backtest/report?jobId=' + encodeURIComponent(routeJobId) + '&format=json',
    })
    let routeReport = null
    try { routeReport = JSON.parse(jsonRes.text) } catch (error) { routeReport = null }
    check(routeReport !== null && routeReport.metrics !== undefined, 'GET report json 可解析')
    const badFormat = await callHandler(host.handlerAt('/dsh-btc/backtest/report'), {
      method: 'GET', url: '/dsh-btc/backtest/report?jobId=' + encodeURIComponent(routeJobId) + '&format=xml',
    })
    check(badFormat.parsed.ok === false && String(badFormat.parsed.error).indexOf('html') >= 0, '非法 format 被拒')

    const guardRunGet = await callHandler(host.handlerAt('/dsh-btc/backtest/run'), { method: 'GET', url: '/dsh-btc/backtest/run' })
    check(guardRunGet.status === 405 && String(guardRunGet.headers.allow) === 'POST', 'GET run 返回 405 + allow:POST')
    const guardStrategiesPost = await callHandler(host.handlerAt('/dsh-btc/backtest/strategies'), {
      method: 'POST', url: '/dsh-btc/backtest/strategies', body: '{}',
    })
    check(guardStrategiesPost.status === 405, 'POST strategies 返回 405', String(guardStrategiesPost.status))
    const badJson = await callHandler(host.handlerAt('/dsh-btc/backtest/run'), {
      method: 'POST', url: '/dsh-btc/backtest/run', body: 'not-json',
    })
    check(badJson.parsed.ok === false && String(badJson.parsed.error).indexOf('JSON') >= 0, '非法 JSON 被拒', JSON.stringify(badJson.parsed.error))
    const unknownStatus = await callHandler(host.handlerAt('/dsh-btc/backtest/status'), {
      method: 'GET', url: '/dsh-btc/backtest/status?jobId=bt-nope',
    })
    check(unknownStatus.parsed.ok === false, '未知 jobId 状态返回 ok:false')
    const cancelRes = await callHandler(host.handlerAt('/dsh-btc/backtest/cancel'), {
      method: 'POST', url: '/dsh-btc/backtest/cancel', body: JSON.stringify({ jobId: routeJobId }),
    })
    check(cancelRes.parsed.ok === false && cancelRes.parsed.cancelled === false, '对已完成任务 cancel 返回 cancelled:false')

    // 路由层：POST body.instId 透传到 job.config（数据层 + summary 都能看到）
    const ethRouteRun = await callHandler(host.handlerAt('/dsh-btc/backtest/run'), {
      method: 'POST', url: '/dsh-btc/backtest/run',
      body: JSON.stringify(Object.assign({}, RUN_BODY, { instId: 'ETH-USDT-SWAP' })),
    })
    check(ethRouteRun.parsed.ok === true && ethRouteRun.parsed.job !== undefined,
      'POST run 带 instId=ETH-USDT-SWAP 返回 job', JSON.stringify(ethRouteRun.parsed.error || ''))
    const ethRouteJobId = ethRouteRun.parsed.job === undefined ? '' : ethRouteRun.parsed.job.id
    const ethRouteDone = await waitForState(routeService, ethRouteJobId, 'done')
    check(ethRouteDone.timeout !== true && ethRouteDone.summary !== null
      && ethRouteDone.summary.instId === 'ETH-USDT-SWAP',
    '路由层 ETH 回测的 summary.instId = ETH-USDT-SWAP',
    ethRouteDone.summary === null
      ? String(ethRouteDone.last && ethRouteDone.last.job && ethRouteDone.last.job.message)
      : String(ethRouteDone.summary && ethRouteDone.summary.instId))
    check(loadBarsCalls[loadBarsCalls.length - 1] !== undefined
      && loadBarsCalls[loadBarsCalls.length - 1].instId === 'ETH-USDT-SWAP',
    '路由层 ETH 回测的数据层也收到 instId=ETH-USDT-SWAP',
    JSON.stringify(loadBarsCalls[loadBarsCalls.length - 1]))
    const badInstRoute = await callHandler(host.handlerAt('/dsh-btc/backtest/run'), {
      method: 'POST', url: '/dsh-btc/backtest/run',
      body: JSON.stringify(Object.assign({}, RUN_BODY, { instId: 'DOGE-USDT-SWAP' })),
    })
    check(badInstRoute.parsed.ok === false && String(badInstRoute.parsed.error).indexOf('不支持的标的') >= 0,
      '路由层非法 instId 被拒', JSON.stringify(badInstRoute.parsed.error))
    check(badInstRoute.parsed.ok === false
      && String(badInstRoute.parsed.error).indexOf('回测失败：') < 0,
    '路由层错误串也不带「回测失败：」前缀（前端统一拼）', JSON.stringify(badInstRoute.parsed.error))
  } finally {
    host.dispose()
  }

  // ---- 信任栅栏：connection 判定返回 401 时，路由必须直接拒（这是安全边界）
  const fencedHost = makeHost(makeService(), 401)
  try {
    const fenced = await callHandler(fencedHost.handlerAt('/dsh-btc/backtest/strategies'), { method: 'GET', url: '/dsh-btc/backtest/strategies' })
    check(fenced.status === 401, '信任栅栏返回 401 时路由被拒', String(fenced.status))
  } finally {
    fencedHost.dispose()
  }

  // ================================================================ 9) 清理
  // 让所有 service 里可能还在跑的任务收尾（否则定时器把进程挂住）
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
} finally {
  if (failed > 0) {
    console.log('\n── ' + String(failed) + ' 项失败')
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
}
