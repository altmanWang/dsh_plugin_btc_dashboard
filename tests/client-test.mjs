// 客户端半的离线自检：模块格式、slot 注册、组件渲染、canvas 画图。
// 真实 React 来自 profile 的 node_modules；canvas 用记录型 2D 上下文替身。
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { CLIENT_FILE, profilePackageJson, WORKSPACE } from './_paths.mjs'
const CLIENT = CLIENT_FILE
const PROFILE_PKG = profilePackageJson()
if (PROFILE_PKG === null) {
  console.log('跳过：找不到 DSH profile（可用 DSH_PROFILE_DIR 指定），本测试需要 profile 里的 react')
  process.exit(0)
}
const profileRequire = createRequire(PROFILE_PKG)
// react 和 react-dom 必须来自同一份拷贝，否则 renderToString 会把元素当成普通对象。
const reactDomServerPath = profileRequire.resolve('react-dom/server')
const reactDomRequire = createRequire(reactDomServerPath)
const React = reactDomRequire('react')
const { renderToString } = reactDomRequire('react-dom/server')
console.log('react        ', reactDomRequire.resolve('react'))
console.log('react-dom    ', reactDomServerPath)
console.log('react version', React.version)

/**
 * 看门狗：这个测试是同步跑完的，正常几秒内结束。
 * 如果实现里出现"条件恒真的循环"，进程会占满一个核并且永远不出结果 —— 让人干等着最糟，
 * 所以到点直接报错退出（曾经真的踩过一次：时间刻度起点算错，把客户端转死）。
 */
const WATCHDOG_MS = Number(process.env.DSH_BTC_TEST_TIMEOUT || 120000)
const watchdog = setTimeout(function () {
  console.error('\n超时 ' + WATCHDOG_MS + 'ms 仍未结束：实现里可能有死循环（看门狗退出）')
  process.exit(3)
}, WATCHDOG_MS)

let failed = 0
function check(ok, label, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
  if (!ok) failed += 1
}

// ---------------------------------------------------------------- 1) 载入模块

const code = readFileSync(CLIENT, 'utf8')
// 有些断言要查「源码里有没有这个写法」（比如只在特定状态下才渲染的 aria-live 提示）
const CLIENT_SOURCE_CODE = code
check(code.indexOf('export ') < 0, 'client.js 不是 ESM（没有 export 语句）')
check(code.indexOf('__ModuleLoader__.load') >= 0, 'client.js 走 __ModuleLoader__.load 注册惰性工厂')

let captured = null
const listeners = new Set()
const fakeWindow = {
  __ModuleLoader__: { load: function (def) { captured = def; } },
  devicePixelRatio: 2,
  // Dashboard 渲染时会读 localStorage（画线），没有就当作空
  localStorage: {
    getItem: function () { return null; },
    setItem: function () { /* 不落盘 */ },
  },
}
// 让 document.createElement('canvas') 返回一块可画的画布：这样 renderToString 跑 <Chart> 时，
// ref 回调 + useEffect 会真的走一遍 drawChart（下面「均线」那一节要靠落笔数判断画没画出来）。
const fakeCanvases = []
function makeFakeCanvas(w, h) {
  const ctx = makeCtx()
  const canvas = {
    width: w,
    height: h,
    clientWidth: w,
    clientHeight: h,
    style: {},
    dataset: {},
    getContext: function () { return ctx; },
    getBoundingClientRect: function () { return { left: 0, top: 0, right: w, bottom: h, width: w, height: h }; },
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  canvas.ctx = ctx
  fakeCanvases.push(canvas)
  return canvas
}
const sandbox = new Function('window', 'fetch', 'document', 'ResizeObserver', 'getComputedStyle', code)
const fakeDocument = {
  head: { appendChild: function () {} },
  querySelector: function () { return null; },
  createElement: function (tag) { return tag === 'canvas' ? makeFakeCanvas(900, 380) : { dataset: {}, style: {} }; },
  addEventListener: function () {},
  removeEventListener: function () {},
  visibilityState: 'visible',
}
sandbox(fakeWindow, function () { return Promise.resolve({ json: function () { return Promise.resolve({ ok: false }); } }); }, fakeDocument, undefined, undefined)

check(captured !== null, '__ModuleLoader__.load 被调用')
check(captured.id === '@local/dsh-btc-dashboard', 'bundle id 等于包名', 'id=' + captured.id)

const mod = captured.factory(function (spec) {
  if (spec === 'react') return React
  throw new Error('客户端 require 了非种子模块：' + spec)
})
check(typeof mod.apply === 'function', 'factory 返回 apply')
check(Array.isArray(mod.inject) && mod.inject[0] === 'slots', 'factory 声明 inject=[slots]')

// ---------------------------------------------------------------- 2) slot 注册

const registered = []
const fakeCtx = {
  effect: function (fn) { const d = fn(); return function () { if (typeof d === 'function') d(); }; },
  slots: {
    inject: function (key, cb) { return cb(); },
    register: function (options, component) {
      registered.push({ options: options, component: component });
      return function () {};
    },
  },
}
mod.apply(fakeCtx)
check(registered.length === 2, '注册了两个槽位', registered.map(function (r) { return r.options.name + '#' + r.options.id; }).join(' , '))
check(registered.some(function (r) { return r.options.name === 'sidebar.footer.action'; }), '注册侧边栏入口')
check(registered.some(function (r) { return r.options.name === 'shell.overlay'; }), '注册 shell.overlay 面板')

// ---------------------------------------------------------------- 3) 侧边栏按钮渲染

const sidebar = registered.filter(function (r) { return r.options.name === 'sidebar.footer.action'; })[0]
const buttonEl = sidebar.component({ wide: true })
const buttonHtml = renderToString(buttonEl)
check(buttonHtml.indexOf('📊') >= 0, '侧边栏按钮渲染出图标', buttonHtml.slice(0, 80))

const overlay = registered.filter(function (r) { return r.options.name === 'shell.overlay'; })[0]

// 关闭状态下不应渲染任何东西
const closedHtml = renderToString(React.createElement(overlay.component))
check(closedHtml === '', '面板关闭时不渲染内容', JSON.stringify(closedHtml))

// 侧边栏按钮的 onClick 就是 store.toggle：点一下打开面板
buttonEl.props.toggle()
const panelHtml = renderToString(React.createElement(overlay.component))
for (const [needle, label] of [
  ['OKX BTC 合约看板', '标题'],
  ['模拟', '模拟环境按钮'],
  ['生产', '生产环境按钮'],
  // 均线的周期/当前值现在只画在**画布**上（工具条上就一个「均线管理」按钮），
  // 所以这里不再断言 DOM 里有 EMA20/EMA480 —— 那是 canvas 的活，由画布那节的断言盯着。
  ['均线', '均线分组'],
  ['1m', '1m 周期'],
  ['3m', '3m 周期'],
  ['15m', '15m 周期'],
  ['1h', '1h 周期'],
  ['4h', '4h 周期'],
  ['1D', '1D 周期'],
  ['公开行情接口', '数据源说明'],
]) {
  check(panelHtml.indexOf(needle) >= 0, '面板包含 ' + label)
}

// ---------------------------------------------------------------- 4) 画图（替身 canvas）

function makeCtx() {
  const calls = { fillRect: 0, fillText: 0, fill: 0, stroke: 0, moveTo: 0, lineTo: 0, setLineDash: 0, clearRect: 0, roundRect: 0, rect: 0, arc: 0, strokeRect: 0 };
  const trace = [];
  const STACK = process.env.DSH_BTC_TRACE === '1';
  const ctx = {
    calls: calls,
    trace: trace,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    setTransform: function () {}, clearRect: function () { calls.clearRect += 1; },
    beginPath: function () {}, closePath: function () {},
    moveTo: function () {
      calls.moveTo += 1;
      if (STACK) trace.push(new Error().stack.split('\n').slice(1, 4).map(function (l) { return l.trim() }).join(' | '));
    },
    lineTo: function () { calls.lineTo += 1; },
    stroke: function () { calls.stroke += 1; }, fill: function () { calls.fill += 1; },
    fillRect: function () { calls.fillRect += 1; }, strokeRect: function () { calls.strokeRect += 1; },
    fillText: function () { calls.fillText += 1; },
    setLineDash: function () { calls.setLineDash += 1; },
    measureText: function (text) { return { width: String(text).length * 6.5 }; },
    arc: function () { calls.arc += 1; },
    rect: function () { calls.rect += 1; }, roundRect: function () { calls.roundRect += 1; },
  };
  return ctx;
}

function makeCanvas(w, h) {
  const ctx = makeCtx();
  const canvas = {
    clientWidth: w,
    clientHeight: h,
    width: 0,
    height: 0,
    getContext: function () { return ctx; },
    getBoundingClientRect: function () { return { left: 0, top: 0, right: w, bottom: h, width: w, height: h }; },
  };
  return { canvas: canvas, ctx: ctx };
}

// 造一段和真实载荷同形状的板子：带 EMA20/EMA480（前 479 根 EMA480 为 null）
function makeBoard(n) {
  const candles = [];
  const ema20 = [];
  const ema480 = [];
  let price = 80000;
  let sum20 = 0;
  let sum480 = 0;
  let e20 = null;
  let e480 = null;
  for (let i = 0; i < n; i += 1) {
    price = price + (Math.sin(i / 7) * 60) + (i % 13 === 0 ? -180 : 40);
    const o = price - 30;
    const c = price;
    const h = Math.max(o, c) + 50;
    const l = Math.min(o, c) - 50;
    // 第 7 位 done：与真实宿主一致 —— 除了最后一根，其余都已收盘
    candles.push([1780000000000 + i * 900000, o, h, l, c, 100 + (i % 17) * 9, i === n - 1 ? 0 : 1]);
    sum20 += c;
    sum480 += c;
    if (i >= 20) sum20 -= candles[i - 20][4];
    if (i >= 480) sum480 -= candles[i - 480][4];
    if (i === 19) e20 = sum20 / 20;
    else if (i > 19) e20 = c * (2 / 21) + e20 * (1 - 2 / 21);
    if (i === 479) e480 = sum480 / 480;
    else if (i > 479) e480 = c * (2 / 481) + e480 * (1 - 2 / 481);
    ema20.push(e20);
    ema480.push(e480);
  }
  return {
    ok: true,
    bar: '15m',
    bars: [{ id: '15m', label: '15m' }],
    instId: 'BTC-USDT-SWAP',
    // keyMasked 只用来看页脚渲染，不参与断言 —— 必须是虚构值，不要复制真实环境里的掩码
    env: { id: 'demo', label: '模拟', simulated: true, keyMasked: 'cafe12…beef' },
    price: { last: price, change24h: 120.5, changePct: 0.14, bid: price - 0.1, ask: price + 0.1, high24h: price + 400, low24h: price - 420, vol24h: 1511.94 },
    candles: candles,
    ema20: ema20,
    ema480: ema480,
    // 新接口：均线是列表（`[{ item, series }]`），默认两条 = EMA20 + EMA480
    lines: [
      { item: { id: 'e-fast', period: 20, color: '#f0b90b', show: true }, series: ema20 },
      { item: { id: 'e-slow', period: 480, color: '#a78bfa', show: true }, series: ema480 },
    ],
    stats: {
      seriesCount: n, displayed: n, ema20Last: e20, ema480Last: e480,
      vsEma20Pct: 0.2, vsEma480Pct: 1.1, windowHigh: price + 400, windowLow: price - 420,
      windowVolume: 123456.78,
    },
    meta: { barMs: 900000, cached: false, pages: 5, warnings: [] },
    transport: 'proxy', proxy: 'http://127.0.0.1:7897', latencyMs: 1800,
  };
}

/** 老宿主的形状：K 线只有 6 位（没有 `done`）。专门用来验证"缺 done 时要看得见"。 */
function makeBoardNoDone(n) {
  const b = makeBoard(n || 400)
  b.candles = b.candles.map((c) => c.slice(0, 6))
  return b
}

/** 造一份测试用的均线列表：`show` 决定这一条是否显示（画图接口吃 item.show）。 */
function testLines(ema20, ema480, showFast, showSlow) {
  return [
    { item: { id: 'e-fast', period: 20, color: '#f0b90b', show: showFast !== false }, series: Array.isArray(ema20) ? ema20 : [] },
    { item: { id: 'e-slow', period: 480, color: '#a78bfa', show: showSlow !== false }, series: Array.isArray(ema480) ? ema480 : [] },
  ]
}

const drawChart = mod.debug.drawChart
for (const [n, w, h, hover, show20, show480, label] of [
  [720, 900, 380, null, true, true, '常规 720 根'],
  [720, 900, 380, 500, true, true, '带十字光标'],
  [720, 900, 380, 719, true, true, '光标在最右'],
  [720, 900, 380, 0, true, true, '光标在最左'],
  [720, 900, 380, 9999, true, true, '光标越界'],
  [480, 300, 200, 200, true, true, '小画布'],
  [1, 900, 380, 0, true, true, '单根 K 线'],
  [720, 900, 380, null, false, false, '两条均线都隐藏'],
  [720, 900, 380, null, true, false, '只显示 EMA20'],
]) {
  const made = makeCanvas(w, h)
  let error = null
  const board = makeBoard(n)
  try {
    drawChart(made.canvas, board, { hover: hover })
  } catch (e) {
    error = e
  }
  check(error === null, 'drawChart ' + label + ' 不抛错', error === null ? ('fillRect=' + made.ctx.calls.fillRect + ' fillText=' + made.ctx.calls.fillText + ' stroke=' + made.ctx.calls.stroke) : String(error && error.stack ? error.stack.split('\n')[0] : error))
  if (n > 1 && error === null) {
    check(made.ctx.calls.fillRect > n, 'drawChart ' + label + ' 画了 K 线实体与量柱')
    check(made.ctx.calls.stroke > 0, 'drawChart ' + label + ' 画了影线/均线')
    check(made.ctx.calls.fillText >= 5, 'drawChart ' + label + ' 画了刻度文字')
  }
}

// EMA480 全为 null 时也不能崩
{
  const b = makeBoard(720)
  const nulledSlow = b.ema480.map(function () { return null; })
  const made = makeCanvas(900, 380)
  let error = null
  try { drawChart(made.canvas, b, { hover: 700, lines: testLines(b.ema20, nulledSlow) }) } catch (e) { error = e }
  check(error === null, 'EMA480 全为 null 时不抛错')
}
// 一条均线都没有（用户把均线全删了）也不能崩
{
  const b = makeBoard(720)
  const made = makeCanvas(900, 380)
  let error = null
  try { drawChart(made.canvas, b, { hover: 700, lines: [] }) } catch (e) { error = e }
  check(error === null, '均线列表为空时不抛错', error === null ? '' : String(error.message))
}
// 空数据
{
  const b = makeBoard(0)
  b.candles = []; b.ema20 = []; b.ema480 = []; b.lines = testLines([], [])
  const made = makeCanvas(900, 380)
  let error = null
  try { drawChart(made.canvas, b, { hover: null, lines: testLines([], []) }) } catch (e) { error = e }
  check(error === null, '空 K 线不抛错', 'fillText=' + made.ctx.calls.fillText)
}
// 尺寸为 0（面板还没布局完）
{
  const made = makeCanvas(0, 0)
  const b = makeBoard(720)
  let error = null
  try { drawChart(made.canvas, b, { hover: null, lines: testLines(b.ema20, b.ema480) }) } catch (e) { error = e }
  check(error === null, '画布 0×0 时安全返回')
}

// ---------------------------------------------------------------- 4.4) 均线：窗口拖到哪儿就画到哪儿
//
// 曾经的坑：均线直接用 Host 发来的 ema20/ema480 数组切片。那两个数组只有展示窗口那一段，
// 而 EMA 的前 period-1 位必然是 null（EMA480 有 479 个），默认窗口才 180 根 ——
// 时间轴往左一拖，窗口整个滑进 null 里，紫线整段消失。
// 现在：Host 发整条带预热的序列，浏览器在整条序列上现算、再按窗口切片。
{
  const d = mod.debug
  const failedBefore = failed

  const SERIES = 1800 // = Host 的 SERIES_BARS：720 可看 + 1080 预热
  const DISPLAY = 720
  const full = makeBoard(SERIES)
  const candles = full.candles
  check(candles.length === SERIES, '序列 ' + SERIES + ' 根（含预热）')

  // ---- 数学：与朴素定义（SMA 播种 + 递推）逐点一致
  {
    const closes = candles.map((c) => c[4])
    const got = d.emaSeries(closes, 20)
    let sum = 0
    for (let i = 0; i < 20; i += 1) sum += closes[i]
    let ref = sum / 20
    let maxErr = 0
    for (let i = 19; i < closes.length; i += 1) {
      if (i === 19) ref = sum / 20
      else ref = closes[i] * (2 / 21) + ref * (1 - 2 / 21)
      maxErr = Math.max(maxErr, Math.abs(got[i] - ref))
    }
    check(maxErr < 1e-9, 'emaSeries 与朴素递推逐点一致', 'maxErr=' + maxErr)
    check(got.length === closes.length, 'emaSeries 长度与序列一致')
    check(got.slice(0, 19).every((v) => v === null), 'emaSeries 前 period-1 位是 null')
    check(got[19] !== null, 'emaSeries 第 period 位就有值')
    check(d.emaSeries([1, 2, 3], 480).every((v) => v === null), '序列短于周期时全是 null')
    check(d.emaSeries([], 20).length === 0, '空序列返回空数组')
  }

  // ---- 关键之一：默认周期下，浏览器算出来的和 Host 发的逐点相同（两边口径一致）
  {
    const series = d.emaFor(candles, d.defaultEmas(), 12345)
    let maxFast = 0
    let maxSlow = 0
    for (let i = 0; i < SERIES; i += 1) {
      maxFast = Math.max(maxFast, Math.abs(series[0].series[i] - full.ema20[i]))
      maxSlow = Math.max(maxSlow, Math.abs(series[1].series[i] - full.ema480[i]))
    }
    check(maxFast < 1e-9 && maxSlow < 1e-9, '浏览器侧 EMA 与 Host 数组逐点一致',
      'fast=' + maxFast + ' slow=' + maxSlow)
    check(series.length === 2 && series[0].item.period === 20 && series[1].item.period === 480,
      '默认列表就是 EMA20 + EMA480',
      series.map((s) => String(s.item.period)).join(','))
    check(series[0].item.color !== series[1].item.color, '两条默认均线颜色不同',
      series[0].item.color + ' / ' + series[1].item.color)
  }

  // ---- 关键之二：可拖范围里，两条均线在每个窗口都有值（这就是原来的 bug）
  {
    const series = d.emaFor(candles, d.defaultEmas(), 12345)
    const slowSeries = series[1].series
    check(slowSeries.filter((v) => v !== null).length === SERIES - 479,
      'EMA480 从第 480 根起一直有值（预热段之外）',
      slowSeries.filter((v) => v !== null).length + '/' + SERIES)
    // 旧行为：Host 只发最后 720 根，浏览器（或旧 Host）在那 720 根上重新播种
    const pannable = candles.slice(SERIES - DISPLAY)
    const naiveSlow = d.emaSeries(pannable.map((c) => c[4]), 480)
    const naiveValid = naiveSlow.filter((v) => v !== null).length
    check(naiveValid === DISPLAY - 479, '对照：只拿最后 ' + DISPLAY + ' 根时 EMA480 只剩 ' + naiveValid + ' 个值',
      'valid=' + naiveValid)
    check(d.windowOf(pannable, { size: 180, rightTs: null }).start === DISPLAY - 180, '默认窗口在序列右端')
  }

  // ---- 缓存：同一段序列 + 同样周期不应重复算（对象引用相同）
  {
    const a = d.emaFor(candles, d.defaultEmas(), 777)
    const b = d.emaFor(candles, d.defaultEmas(), 777)
    check(a === b, '同一 (序列, 周期, fetchedAt) 命中缓存')
    const c = d.emaFor(candles, d.defaultEmas(), 778)
    check(c !== a, 'fetchedAt 变了（新载荷）就重算')
    // 加一条均线 → 缓存键变化，必须重算（否则新线画不出来）
    const three = d.emaAdd(d.defaultEmas(), 120)
    const e = d.emaFor(candles, three, 777)
    check(e !== a && e.length === 3, '均线列表变了就重算', String(e.length) + ' 条')
  }

  // ---- 周期可以改：改完立刻是另一条线
  {
    const list = d.defaultEmas()
    const slow = d.emaFor(candles, list, 9)
    const quick = d.emaFor(candles, d.emaUpdate(list, list[1].id, { period: 60 }), 9)
    const lastIdx = candles.length - 1
    check(Math.abs(slow[1].series[lastIdx] - quick[1].series[lastIdx]) > 1e-6, '改周期会得到不同的均线',
      slow[1].series[lastIdx].toFixed(2) + ' vs ' + quick[1].series[lastIdx].toFixed(2))
    check(quick[1].series[59] !== null && quick[1].series[58] === null, '周期 60 时第 60 根才有值')
    check(d.emaFor(candles, list, 9) === slow, '没改列表时仍命中缓存')
  }

  // ---- 周期输入的容错
  {
    check(d.parsePeriod('15', 20) === 15, '正常数字')
    check(d.parsePeriod('', 20) === 20, '空输入 → 保留旧值')
    check(d.parsePeriod('abc', 20) === 20, '非数字 → 保留旧值')
    check(d.parsePeriod('1', 20) === 20, '小于下限 → 保留旧值')
    check(d.parsePeriod('99999', 20) === 2000, '超上限 → 夹到 2000')
    check(d.parsePeriod('480.7', 20) === 20, '带小数点不认（inputMode=numeric 只出整数）')
    check(d.parsePeriod('-20', 20) === 20, '负数 → 保留旧值')
  }

  // ---- 真的画出来了：用 <Chart> 内部同一个函数切出这一帧，再数画布上的落笔点
  // 注意数的是 moveTo/lineTo（一条折线只有一次 stroke，stroke 数看不出均线画没画）。
  /**
   * 量「这一帧画了多少笔」，并按绘制阶段分类。
   *
   * 为什么不能只比 moveTo 总数：时间刻度的条数由窗口位置决定（同一个窗口切在不同钟点
   * 边界上，落进画布内的刻度可能是 3 条也可能是 4 条），那是正常的，跟均线无关。
   * 以前的断言比总数，刻度逻辑一动就误报。这里给 drawChart 的每个绘制阶段插一个标记，
   * 把 moveTo 归类后再比 —— 比的才是均线本身。
   */
  function makeStageCtx() {
    const made = makeCanvas(900, 380)
    const byStage = new Map()
    const ctx = made.ctx
    const origMove = ctx.moveTo
    ctx.moveTo = function () {
      const stage = globalThis.__btcdStage || 'setup'
      byStage.set(stage, (byStage.get(stage) || 0) + 1)
      return origMove.apply(null, arguments)
    }
    return { canvas: made.canvas, ctx: ctx, byStage: byStage }
  }

  // drawChart 的绘制阶段：注释里出现的那一行就是阶段起点
  const STAGES = [
    ['      // 横向网格 + 右侧价格刻度', 'grid'],
    ['      // 成交量', 'volume'],
    ['      // K 线（未收盘那根半透明 + 描边）', 'candles'],
    ['      // 均线：按列表逐条画', 'ema'],
    ['      // 时间刻度：对齐到「整点」', 'ticks'],
    ['      // 当前价水平线', 'live'],
    ['      // 收盘倒计时', 'countdown'],
    ['      // 十字光标 + 浮层', 'crosshair'],
  ]
  // 把带标记的 drawChart 源码重新求值一次，只给这节的分阶段测量用（不影响上面的正常加载）
  const stageSource = (function () {
    const whole = readFileSync(CLIENT, 'utf8')
    let body = whole
    for (const [needle, name] of STAGES) {
      // 找不到就跳过这个阶段，而不是整个测试崩掉（绘制分段是内部实现，会随重构变）
      const at = body.indexOf(needle)
      if (at < 0) { console.log('     （提示：绘制阶段「' + name + '」的标记没找到，该阶段并入上一段统计）'); continue }
      body = body.slice(0, at)
        + '      globalThis.__btcdStage = ' + JSON.stringify(name) + ';\n'
        + body.slice(at)
    }
    return body
  })()
  const stageMod = (function () {
    let captured2 = null
    const win2 = { __ModuleLoader__: { load: function (def) { captured2 = def; } }, devicePixelRatio: 2 }
    new Function('window', 'fetch', 'document', 'ResizeObserver', 'getComputedStyle', stageSource)(
      win2, function () { return Promise.resolve({ json: function () { return Promise.resolve({ ok: false }); } }); }, fakeDocument, undefined, undefined)
    return captured2.factory(function (spec) { if (spec === 'react') return React; throw new Error(spec) })
  })()
  const drawChartStaged = stageMod.debug.drawChart

  function frameStrokes(viewTime, emaFast, emaSlow) {
    const view = { size: DISPLAY, rightTs: viewTime }
    const w = d.windowOf(candles, view)
    // 均线在整条序列上算，再按窗口切片（emaWindow 现在吃 `[{ item, series }]`）
    const list = [
      { id: 'f', period: emaFast, color: '#f0b90b', show: true },
      { id: 's', period: emaSlow, color: '#a78bfa', show: true },
    ]
    const full = d.emaFor(candles, list, 4242)
    const frame = d.emaWindow(candles, w, full)
    globalThis.__btcdStage = 'setup'
    const made = makeStageCtx()
    const board = {
      candles: frame.candles,
      lines: frame.lines,
      meta: { barMs: 900000 },
    }
    const opts = {
      // 这一节只量「均线画了多少笔」，所以把最新价水平线（只在最右端那一帧出现）关掉
      hover: null, showLast: false,
      following: w.end === candles.length,
    }
    // 只用「带阶段标记的副本」画：它除了多写一行 globalThis.__btcdStage，与正式实现逐字相同
    drawChartStaged(made.canvas, board, opts)
    const stages = {}
    made.byStage.forEach(function (count, name) { stages[name] = count })
    return { moveTo: made.ctx.calls.moveTo, lineTo: made.ctx.calls.lineTo, win: w, frame: frame, stages: stages }
  }
  const noEma = frameStrokes(null, 999999, 999999) // 周期大到算不出来：只有影线
  const earliest = frameStrokes(candles[DISPLAY - 1][0], 20, 480) // 拖到最早
  const newest = frameStrokes(null, 20, 480)
  check(noEma.moveTo > 0, '对照：没有均线时只画影线', 'moveTo=' + noEma.moveTo)
  check(earliest.win.start === 0 && earliest.win.end === DISPLAY,
    '拖到最早时窗口 = 序列前 ' + DISPLAY + ' 根', JSON.stringify(earliest.win))
  check(earliest.moveTo > noEma.moveTo, '拖到最早时均线也画出来了',
    '无均线=' + noEma.moveTo + ' → 有均线=' + earliest.moveTo)
  check(earliest.frame.lines[1].series.filter((v) => v !== null).length === DISPLAY - 479,
    '最早那一帧里 EMA480 的有效值 = ' + (DISPLAY - 479) + '（前 479 根数学上画不出）')
  check(earliest.stages.ema === 2 && newest.stages.ema === 2,
    '两个窗口都画出了两条均线',
    '最早=' + JSON.stringify(earliest.stages) + ' 最新=' + JSON.stringify(newest.stages))
  check(earliest.stages.candles === newest.stages.candles && earliest.stages.candles === DISPLAY,
    '两个窗口都画了 ' + DISPLAY + ' 根 K 线')
  // 唯一允许有差异的是时间刻度：刻度对齐到整点，窗口切的位置不同，"落在画布里的刻度"
  // 本来就可能是 3 条或 4 条（不是 bug，改刻度逻辑时别再把它当成均线回归）。
  const tickDiff = Math.abs((earliest.stages.ticks || 0) - (newest.stages.ticks || 0))
  check(tickDiff <= 1, '两个窗口的时间刻度条数最多差 1 条（对齐整点带来的正常差异）',
    '最早=' + earliest.stages.ticks + ' 最新=' + newest.stages.ticks)
  check(earliest.moveTo - earliest.stages.ticks === newest.moveTo - newest.stages.ticks,
    '除时间刻度数的影响外，两个窗口的落笔数完全一致',
    earliest.moveTo + ' vs ' + newest.moveTo + '，刻度各 ' + earliest.stages.ticks + ' / ' + newest.stages.ticks
    + ' 条（修复前最早窗口的均线整段画不出来，只剩 ' + noEma.moveTo + ' 笔影线）')

  // 中间任何一段窗口：切出来的均线不能有 null
  {
    let bad = 0
    const warm = d.emaFor(candles, [
      { id: 'f', period: 20, color: '#f0b90b', show: true },
      { id: 's', period: 480, color: '#a78bfa', show: true },
    ], 4242)
    for (const size of [60, 180, 300, 720]) {
      for (const rightIdx of [720, 900, 1200, 1500, 1800]) {
        const view = { size: size, rightTs: rightIdx >= candles.length ? null : candles[rightIdx - 1][0] }
        const w = d.windowOf(candles, view)
        const frame = d.emaWindow(candles, w, warm)
        // 只有序列最前面那 479 根（预热段）允许是 null；窗口只要整体在它右边，就必须全有值
        if (w.start >= 479 && frame.lines[1].series.some(function (v) { return v === null; })) bad += 1
      }
    }
    check(bad === 0, '预热段之后的每个窗口，EMA480 切片都没有 null', 'bad=' + bad)
  }

  // ---- 面板上默认就是 EMA20 + EMA480（可增删改的列表，初始两条）
  {
    const panelHtml = renderToString(React.createElement(overlay.component))
    check(panelHtml.indexOf('均线') >= 0, '面板包含「均线」分组')
    check(panelHtml.indexOf('均线管理') >= 0, '工具条上有「均线管理」入口（点开就是管理看板）')
    // 工具条上**不再**逐条列均线，也**不再**有独立的「新增」按钮（都收进看板了）
    check(panelHtml.indexOf('btcd-ema-dot') < 0, '工具条不逐条列均线（逐条显隐在画布图例上）')
    check(panelHtml.indexOf('＋ 新增') < 0, '工具条上没有独立的「新增」（在管理看板里）')
    check(panelHtml.indexOf('2 条 · 点图例开关') < 0, '不再有「点图例开关」这种多余提示')
  }

  // ---- 均线列表：默认两条，支持新增 / 删除 / 修改
  {
    // 默认：EMA20 + EMA480，两条都显示，颜色就是经典的金 / 紫
    const base = d.defaultEmas()
    check(base.length === 2, '默认两条均线', String(base.length))
    check(base[0].period === 20 && base[1].period === 480, '默认周期是 20 与 480',
      base.map((x) => x.period).join(','))
    check(base.every((x) => x.show !== false), '默认两条都是显示的')
    check(base[0].color === '#f0b90b' && base[1].color === '#a78bfa', '默认沿用原来的金 / 紫',
      base[0].color + ' ' + base[1].color)
    check(base[0].id !== base[1].id && base[0].id !== undefined, '每条有自己的 id',
      base.map((x) => String(x.id)).join(','))
    check(new Set(base.map((x) => x.id)).size === base.length, 'id 不重复')
    check(d.EMA_DEFAULT_PERIODS.join(',') === '20,480', 'EMA_DEFAULT_PERIODS 就是 20/480')

    // id 由注入的生成器给（默认列表在 React useState 初始值里跑，必须能拿到真 id）
    let seq = 0
    const withIds = d.defaultEmas(function () { seq += 1; return 'id' + seq })
    check(withIds[0].id === 'id1' && withIds[1].id === 'id2', 'id 生成器被用上',
      withIds.map((x) => x.id).join(','))

    // 新增
    const three = d.emaAdd(base, 120)
    check(three.length === 3, '新增一条 → 3 条', String(three.length))
    check(three[2].period === 120 && three[2].show !== false, '新那条的周期就是给的 120')
    check(base.length === 2, '新增是纯函数，不改原数组', String(base.length))
    const auto = d.emaAdd(base)
    check(auto.length === 3 && [20, 480].indexOf(auto[2].period) < 0,
      '不指定周期时给一个还没用过的', String(auto[2].period))
    check(new Set(three.map((x) => x.color)).size === 3, '新增的一条拿到不同的颜色',
      three.map((x) => x.color).join(' '))

    // 上限
    let many = base
    for (let i = 0; i < 20; i += 1) many = d.emaAdd(many, 10 + i)
    check(many.length === d.EMA_MAX_LINES, '条数封顶在 EMA_MAX_LINES', String(many.length))

    // 删除
    const removed = d.emaRemove(three, three[1].id)
    check(removed.length === 2, '删掉一条 → 2 条', String(removed.length))
    check(removed.map((x) => x.period).join(',') === '20,120', '删掉的正是那一条',
      removed.map((x) => x.period).join(','))
    check(three.length === 3, '删除是纯函数，不改原数组')
    check(d.emaRemove(three, '不存在的 id').length === 3, '删不存在的 id 不变')
    check(d.emaRemove(three, three[0].id).length === 2, '删第一条也可以')
    // 全删光是允许的（工具栏会留「新增」入口）
    let empty = three
    for (const item of three) empty = d.emaRemove(empty, item.id)
    check(empty.length === 0, '可以全部删光', String(empty.length))

    // 修改周期
    const edited = d.emaUpdate(base, base[1].id, { period: 240 })
    check(edited[1].period === 240, '改周期生效', String(edited[1].period))
    check(edited[0].period === 20, '没改的那条不动')
    check(edited[1].id === base[1].id && edited[1].color === base[1].color, '改周期不动 id 与颜色')
    check(d.emaUpdate(base, base[1].id, { period: '' }).length === 2, '空输入不炸')
    check(d.emaUpdate(base, base[1].id, { period: 'abc' })[1].period === 480, '非法周期被忽略，保留旧值')
    check(d.emaUpdate(base, base[1].id, { period: '120' })[1].period === 120, '字符串数字也认')
    check(d.emaUpdate(base, base[1].id, { period: 1 })[1].period === 480, '周期 <2 被忽略')
    check(d.emaUpdate(base, base[1].id, { period: 999999 })[1].period === d.EMA_PERIOD_MAX,
      '周期超上限被夹住', String(d.emaUpdate(base, base[1].id, { period: 999999 })[1].period))

    // 修改显示 / 颜色
    const hidden = d.emaUpdate(base, base[1].id, { show: false })
    check(hidden[1].show === false && hidden[0].show !== false, '可以单独隐藏某一条')
    check(d.emaUpdate(hidden, base[1].id, { show: true })[1].show === true, '也能再打开')
    const recolored = d.emaUpdate(base, base[0].id, { color: '#123456' })
    check(recolored[0].color === '#123456', '可以换颜色')
    check(d.emaUpdate(base, base[0].id, { color: '' })[0].color === '#f0b90b', '空颜色被忽略')

    // 规范化：脏数据（localStorage 里可能存着旧版本 / 手改过的值）
    const dirty = d.normalizeEmas([
      { period: 30 },
      { period: '60', color: '#111111', show: false },
      { period: 1 },          // 非法，丢掉
      null,                   // 丢掉
      { period: 5000 },       // 夹到上限
      { period: 'abc' },      // 丢掉
    ], function () { return 'z' })
    check(dirty.length === 3, '脏数据被清成 3 条', JSON.stringify(dirty.map((x) => x.period)))
    check(dirty[0].period === 30 && dirty[0].id === 'z', '缺 id 就补一个', String(dirty[0].id))
    check(dirty[1].period === 60 && dirty[1].color === '#111111' && dirty[1].show === false,
      '字符串周期转数字、颜色与显示状态保留', JSON.stringify(dirty[1]))
    check(dirty[2].period === 2000, '超上限夹到 2000', String(dirty[2].period))
    check(d.normalizeEmas(null).length === 0, 'null 输入 → 空列表（不炸）')
    check(d.normalizeEmas([]).length === 0, '空数组 → 空列表')
    check(d.normalizeEmas([{ period: 20 }]).length === 1, '最少能只留一条')

    // 颜色分配：优先用没被占的
    const pick = d.emaPickColor([{ color: d.EMA_DEFAULT_COLORS[0] }])
    check(pick === d.EMA_DEFAULT_COLORS[1], '已被占的颜色不会重复分配', String(pick))
    check(d.emaPickColor([]) === d.EMA_DEFAULT_COLORS[0], '空列表从第一个颜色开始')
    const allUsed = d.EMA_DEFAULT_COLORS.map((c) => ({ color: c }))
    check(d.EMA_DEFAULT_COLORS.indexOf(d.emaPickColor(allUsed)) >= 0, '颜色用光了也不返回空')

    // 名字
    check(d.emaLabel({ period: 20 }) === 'EMA20', 'emaLabel', d.emaLabel({ period: 20 }))
  }

  // ---- 列表变了，画出来的线也要跟着变（这才是"支持新增"的实证）
  {
    const board3 = makeBoard(720)
    const list3 = [
      { id: 'a', period: 20, color: '#f0b90b', show: true },
      { id: 'b', period: 480, color: '#a78bfa', show: true },
      { id: 'c', period: 120, color: '#4a8cff', show: true },
    ]
    const lines3 = d.emaFor(board3.candles, list3, 1)
    check(lines3.length === 3, '三条均线都算出来了', String(lines3.length))

    // 数"均线阶段"的落笔：用带标记的副本画，跟 frameStrokes 同一套办法
    const countEmaStrokes = function (list) {
      const win = { start: 540, end: 720 }
      const full = d.emaFor(board3.candles, list, 7)
      const frame = d.emaWindow(board3.candles, win, full)
      globalThis.__btcdStage = 'setup'
      const made = makeStageCtx()
      drawChartStaged(made.canvas, {
        candles: frame.candles, lines: frame.lines, meta: { barMs: 900000 },
      }, { hover: null, following: true })
      return made.byStage.get('ema') || 0
    }
    const twoStrokes = countEmaStrokes(list3.slice(0, 2))
    const threeStrokes = countEmaStrokes(list3)
    check(threeStrokes > twoStrokes, '加一条均线就多画一条线',
      '两条=' + twoStrokes + ' → 三条=' + threeStrokes)
    check(countEmaStrokes([{ id: 'a', period: 20, color: '#f0b90b', show: false }]) === 0,
      '隐藏的那条不画')
    check(countEmaStrokes([]) === 0, '列表为空时一条都不画（也不炸）')
  }

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

// ---------------------------------------------------------------- 4.45) 悬浮：两档显示
//
// 需求：数据框只在指针**真的压在 K 线实体/影线上**时才弹；指针在画布空白处时，
// 只画十字光标 + 轴上的「鼠标位置对应的价格」（这一节前半段的 hitCandle 断言是它的基础，
// 后半段断言两档各自画了什么）。
{
  const d = mod.debug
  const failedBefore = failed
  const board = makeBoard(240)
  const candles = board.candles
  const made = makeCanvas(900, 380)
  const box = d.plotBox(made.canvas, candles.length)
  const range = d.priceRange(candles, board.lines)
  const span = range.hi - range.lo
  const xOf = function (i) { return 8 + box.step * i + box.step / 2 }
  const yOf = function (p) { return box.priceTop + box.priceH - ((p - range.lo) / span) * box.priceH }
  // 挑一根实体够高的 K 线，方便算「点在实体里 / 点在实体上方空白处」
  let pick = 0
  for (let i = 200; i < 240; i += 1) {
    if (Math.abs(candles[i][1] - candles[i][4]) > Math.abs(candles[pick][1] - candles[pick][4])) pick = i
  }
  const row = candles[pick]
  const bodyY = (yOf(row[1]) + yOf(row[4])) / 2
  // 同一列里，实体上方仍有影线，所以「空白」要取到最高价之上 —— 还得让指针落在价格区内 + 3px 容差之外
  const blankY = yOf(row[2]) - (d.CANDLE_HIT_PX + 12)
  check(blankY > box.priceTop + 3, '构造出的空白点确实在价格区内', 'blankY=' + blankY.toFixed(1) + ' priceTop=' + box.priceTop)

  const distY = function (value, where) {
    return function () {
      const before = makeCanvas(900, 380)
      drawChart(before.canvas, board, { hover: pick, hoverY: value, hoverOnCandle: where === 'candle' })
      return before
    }
  }

  // ---- 命中判定本身（x 是「本列 ± 容差」，不是「整列」——
  //      否则指针在别的列时也会被算成命中它，那就等于「悬浮任意位置都弹框」了）
  check(d.hitCandle(box, range, candles, pick, xOf(pick), bodyY) === true,
    '指针压在实体里 → 命中')
  check(d.hitCandle(box, range, candles, pick, xOf(pick), yOf(row[2]) + 1) === true,
    '指针压在上影线上 → 命中')
  check(d.hitCandle(box, range, candles, pick, xOf(pick), yOf(row[3]) - 1) === true,
    '指针压在下影线上 → 命中')
  check(d.hitCandle(box, range, candles, pick, xOf(pick) + d.CANDLE_HIT_PX - 1, bodyY) === true,
    '指针在容差内的横向空白 → 仍算命中（细实体点得中）')
  check(d.hitCandle(box, range, candles, pick, xOf(pick) + d.CANDLE_HIT_PX + 3, bodyY) === false,
    '指针横着出容差 → 不命中')
  check(d.hitCandle(box, range, candles, pick, xOf(pick), blankY) === false,
    '指针在最高价上方的空白处 → 不命中')
  check(d.hitCandle(box, range, candles, pick, xOf(pick), 0) === false,
    '指针在价格区上方的空白处 → 不命中')
  check(d.hitCandle(box, null, candles, pick, xOf(pick), 100) === false, '价格范围拿不到 → 不命中')
  check(d.hitCandle(box, range, candles, -1, xOf(0), 100) === false, '下标越界 → 不命中')
  check(d.hitCandle(box, range, [], 0, 0, 0) === false, '空数据 → 不命中')

  // ---- 渲染：空白处只有光标 + 鼠标价格（不弹 K 线数据框）
  const blank = distY(blankY, 'blank')()
  const onCandle = distY(bodyY, 'candle')()
  // 数据框有 7 行 + 2 行均线 = 9 行，每行 2 段文字；空白档只有 1 段提示文字
  check(onCandle.ctx.calls.fillText - blank.ctx.calls.fillText >= 16,
    '命中 K 线时弹出数据框（多出 ~18 段文字）',
    '空白=' + blank.ctx.calls.fillText + ' 命中=' + onCandle.ctx.calls.fillText)
  check(blank.ctx.calls.fillText >= 8, '空白处仍然画了网格刻度 + 鼠标价格', 'fillText=' + blank.ctx.calls.fillText)
  check(blank.ctx.calls.moveTo >= 2, '空白处仍然画了十字光标', 'moveTo=' + blank.ctx.calls.moveTo)
  check(blank.ctx.calls.roundRect >= 1 && onCandle.ctx.calls.roundRect >= 1,
    '两档都画了圆角浮层', 'blank=' + blank.ctx.calls.roundRect + ' hit=' + onCandle.ctx.calls.roundRect)

  // ---- 空白档横线跟着鼠标走：同一个窗口、不同的 hoverY → 价格轴标签落在不同高度
  //（价格轴刻度文字在 x = padL+plotW+8，鼠标价格标签在 x = padL+plotW+6，只差 2px，别只按 x 过滤）
  {
    const tagYs = []
    const prices = []
    for (const y of [box.priceTop + 10, box.priceTop + box.priceH - 10]) {
      const canvas = makeCanvas(900, 380)
      const texts = []
      canvas.ctx.fillText = function (text, x, ty) { texts.push([String(text), x, ty]) }
      drawChart(canvas.canvas, board, { hover: pick, hoverY: y, hoverOnCandle: false })
      const tag = texts.filter(function (t) { return t[1] === 8 + box.plotW + 6 })
      tagYs.push(tag.length === 0 ? null : tag[0][2])
      prices.push(tag.length === 0 ? null : tag[0][0])
    }
    check(tagYs[0] !== null && tagYs[1] !== null, '两档都画了价格轴上的鼠标价格标签', JSON.stringify(tagYs))
    check(tagYs[0] !== tagYs[1], '价格轴标签跟着鼠标的 y 走（不复用 K 线收盘价）', JSON.stringify(tagYs))
    check(prices[0] !== prices[1], '标签显示的就是该 y 对应的价格', JSON.stringify(prices))
  }

  // ---- 指针不在价格区（拖进成交量区）也不崩，且数据框仍夹在价格区内
  {
    const made2 = makeCanvas(900, 380)
    let threw = null
    try {
      drawChart(made2.canvas, board, { hover: pick, hoverY: box.priceTop + box.priceH + 200, hoverOnCandle: true })
      drawChart(made2.canvas, board, { hover: pick, hoverY: null, hoverOnCandle: false })
      drawChart(made2.canvas, board, { hover: pick })
    } catch (error) { threw = error }
    check(threw === null, '缺 hoverY / 越界 hoverY 都不抛错', threw === null ? '' : String(threw.message))
  }

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

// ---------------------------------------------------------------- 4.5) 时间轴窗口（拖动 / 缩放）

{
  const d = mod.debug
  const candles = makeBoard(720).candles // 升序，ts = 1780000000000 + i*900000
  const failedBefore = failed

  const win = d.windowOf(candles, { size: 180, rightTs: null })
  check(win.start === 540 && win.end === 720, '默认窗口 = 最后 180 根', JSON.stringify(win))

  check(d.indexAfter(candles, candles[0][0] - 1) === 0, '二分：目标早于第一根 → 0')
  check(d.indexAfter(candles, candles[719][0]) === 720, '二分：目标等于最后一根 → len')

  // 关键：刷新之后（左边滑走、右边新增）按时间戳锚定，用户正在看的那根不跳
  const anchorTs = candles[719][0]
  const appended = []
  for (let i = 1; i <= 5; i += 1) appended.push([candles[719][0] + i * 900000, 80000, 80100, 79900, 80050, 120])
  const refreshed = candles.slice(20).concat(appended)
  const anchored = d.windowOf(refreshed, { size: 180, rightTs: anchorTs })
  check(refreshed[anchored.end - 1][0] === anchorTs, '刷新后窗口右端仍锚在同一根 K 线',
    'ts=' + refreshed[anchored.end - 1][0] + ' 期望=' + anchorTs)
  check(anchored.end - anchored.start === 180, '刷新后窗口根数不变', String(anchored.end - anchored.start))

  const panned = d.panView(candles, { size: 180, rightTs: null }, 100)
  check(panned.rightTs === candles[619][0], '往早平移 100 根，右端对齐', String(panned.rightTs))
  check(d.panView(candles, panned, -100).rightTs === null, '拖回最右端自动恢复「跟随最新」')

  const earliest = d.windowOf(candles, d.panView(candles, { size: 180, rightTs: null }, 99999))
  check(earliest.start === 0 && earliest.end === 180, '拖到最早时左端贴住 0', JSON.stringify(earliest))

  const cur = { size: 200, rightTs: candles[719][0] }
  const before = d.windowOf(candles, cur)
  const midBefore = (before.start + before.end - 1) / 2
  const zoomed = d.windowOf(candles, d.zoomView(candles, cur, 100, 0.5))
  const midAfter = (zoomed.start + zoomed.end - 1) / 2
  check(zoomed.end - zoomed.start === 100, '缩放后窗口根数正确', String(zoomed.end - zoomed.start))
  check(Math.abs(midAfter - midBefore) <= 1, '中点锚定缩放：中间那根基本不动',
    '中点 ' + midBefore + ' → ' + midAfter)

  const huge = d.zoomView(candles, cur, 5000, 0.5)
  check(huge.rightTs === null, '放大到超过总量时回到跟随最新')
  check(d.windowOf(candles, huge).start === 0, '此时窗口覆盖全量')

  check(d.windowOf([], { size: 180, rightTs: null }).end === 0, '空数据窗口为 0')
  check(JSON.stringify(d.windowOf(candles.slice(0, 5), { size: 180, rightTs: null })) === '{"start":0,"end":5}',
    '数据不足窗口根数时全量显示')
  const tiny = d.windowOf(candles, { size: 0, rightTs: null })
  check(tiny.end - tiny.start === 30, '过小的窗口被夹到下限 30 根')
  let threw = null
  try { d.panView([], { size: 180, rightTs: null }, 10) } catch (e) { threw = e }
  check(threw === null, '空数组平移不抛错')

  // drawChart 在回看历史时要多画一个角标
  const liveBoard = makeBoard(720)
  const atLive = makeCanvas(900, 380)
  drawChart(atLive.canvas, liveBoard, { hover: null, lines: testLines(liveBoard.ema20, liveBoard.ema480), following: true })
  const atHistory = makeCanvas(900, 380)
  drawChart(atHistory.canvas, liveBoard, { hover: null, lines: testLines(liveBoard.ema20, liveBoard.ema480), following: false })
  check(atHistory.ctx.calls.fillText > atLive.ctx.calls.fillText, '回看历史时多画「回看中」角标',
    atLive.ctx.calls.fillText + ' → ' + atHistory.ctx.calls.fillText)

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

// ---------------------------------------------------------------- 4.6) 画线：几何、斐波那契、渲染

{
  const d = mod.debug
  const failedBefore = failed
  const board = makeBoard(720)
  const candles = board.candles
  const BAR_MS = 900000
  const made = makeCanvas(900, 380)
  const box = d.plotBox(made.canvas, candles.length)
  const range = d.priceRange(candles, board.lines)

  // ---- 时间轴 ↔ 下标（绘图点可以落在两根 K 线之间，也可以落在窗口外）
  check(Math.abs(d.indexFrac(candles, candles[100][0], BAR_MS) - 100) < 1e-9, '时间戳 → 整数下标')
  check(Math.abs(d.indexFrac(candles, candles[100][0] + BAR_MS / 2, BAR_MS) - 100.5) < 1e-9, '时间戳 → 小数下标')
  check(Math.abs(d.indexFrac(candles, candles[0][0] - BAR_MS * 3, BAR_MS) + 3) < 1e-9, '窗口左侧之外是负下标')
  check(Math.abs(d.tsAtIndex(candles, 100.5, BAR_MS) - (candles[100][0] + BAR_MS / 2)) < 1, '下标 → 时间戳')
  const roundTrip = d.tsAtIndex(candles, d.indexFrac(candles, candles[655][0] + 12345, BAR_MS), BAR_MS)
  check(Math.abs(roundTrip - (candles[655][0] + 12345)) < 2, '时间戳 ↔ 下标往返一致', String(roundTrip))

  // ---- 斐波那契价位：0 → 起点，1 → 终点，1.5 / 2 是终点之外的扩展
  check(d.fibPrice(100, 200, 0) === 100, 'fib 0 = 起点')
  check(d.fibPrice(100, 200, 0.5) === 150, 'fib 0.5 = 中点')
  check(d.fibPrice(100, 200, 1) === 200, 'fib 1 = 终点')
  check(d.fibPrice(100, 200, 1.5) === 250, 'fib 1.5 = 终点之上')
  check(d.fibPrice(100, 200, 2) === 300, 'fib 2 = 再翻一倍')
  check(d.fibPrice(200, 100, 0.5) === 150, '反向区间（跌）也对')

  // ---- 默认比例就是需求里的 0 / 0.5 / 1 / 1.5 / 2
  check(JSON.stringify(d.parseFibLevels('')) === '[0,0.5,1,1.5,2]', '空输入 → 默认 0/0.5/1/1.5/2')
  check(JSON.stringify(d.parseFibLevels('0,0.5,1,1.5,2')) === '[0,0.5,1,1.5,2]', '解析标准输入')
  check(JSON.stringify(d.parseFibLevels('0 0.618, 1')) === '[0,0.618,1]', '空格/逗号混用也能解析')
  check(JSON.stringify(d.parseFibLevels('abc,,')) === '[0,0.5,1,1.5,2]', '全是垃圾 → 退回默认')
  check(d.parseFibLevels('0,1,2,3,4,5,6,7,8,9,10,11,12,13,14').length === 12, '比例数量有上限')

  // ---- 指针 → 数据坐标（必须与画图同一套比例尺）
  const top = d.pointerToData(made.canvas, candles, board.lines, 100, box.priceTop, BAR_MS)
  const bottom = d.pointerToData(made.canvas, candles, board.lines, 100, box.priceTop + box.priceH, BAR_MS)
  check(Math.abs(top.price - range.hi) < 1e-6, '价格区顶端 = 轴上限', top.price.toFixed(2) + ' vs ' + range.hi.toFixed(2))
  check(Math.abs(bottom.price - range.lo) < 1e-6, '价格区底端 = 轴下限')
  const firstCol = d.pointerToData(made.canvas, candles, board.lines, 8 + box.step * 0.5, 100, BAR_MS)
  check(firstCol.ts === candles[0][0], '最左列 = 第一根的时间戳', String(firstCol.ts))
  const col100 = d.pointerToData(made.canvas, candles, board.lines, 8 + box.step * 100.5, 100, BAR_MS)
  check(col100.ts === candles[100][0], '第 101 列 = 第 101 根的时间戳')
  const belowPane = d.pointerToData(made.canvas, candles, board.lines, 100, box.priceTop + box.priceH + 500, BAR_MS)
  check(Math.abs(belowPane.price - range.lo) < 1e-6, '拖进成交量区也夹在价格区内')

  // ---- 渲染：斐波那契 / 直线 / 预览
  const shape = { kind: 'fib', t1: candles[500][0], p1: 79500, t2: candles[690][0], p2: 80500, levels: [0, 0.5, 1, 1.5, 2] }
  const line = { kind: 'line', t1: candles[520][0], p1: 79800, t2: candles[660][0], p2: 80200 }
  const base = makeCanvas(900, 380)
  drawChart(base.canvas, board, { hover: null, following: true, drawings: [] })
  const fibCanvas = makeCanvas(900, 380)
  drawChart(fibCanvas.canvas, board, { hover: null, following: true, drawings: [shape] })
  check(fibCanvas.ctx.calls.stroke > base.ctx.calls.stroke, '斐波那契画了水平线',
    base.ctx.calls.stroke + ' → ' + fibCanvas.ctx.calls.stroke)
  check(fibCanvas.ctx.calls.fillText - base.ctx.calls.fillText >= 5, '五个比例各有一个标签',
    '+' + (fibCanvas.ctx.calls.fillText - base.ctx.calls.fillText))
  check(fibCanvas.ctx.calls.setLineDash >= 2, '起点→终点画了虚线')

  const lineCanvas = makeCanvas(900, 380)
  drawChart(lineCanvas.canvas, board, { hover: null, following: true, drawings: [line] })
  check(lineCanvas.ctx.calls.arc >= 2, '直线画了两个端点', 'arc=' + lineCanvas.ctx.calls.arc)
  check(lineCanvas.ctx.calls.fillText - base.ctx.calls.fillText >= 2, '直线标出两端价格')

  const previewCanvas = makeCanvas(900, 380)
  drawChart(previewCanvas.canvas, board, { hover: null, following: true, drawings: [], preview: shape })
  check(previewCanvas.ctx.calls.stroke > base.ctx.calls.stroke, '拖动时的预览也画出来')

  // 画线在窗口外 / 缺字段时不能崩
  let threw = null
  try {
    drawChart(makeCanvas(900, 380).canvas, board, {
      hover: null, following: true,
      drawings: [
        { kind: 'fib', t1: candles[0][0] - BAR_MS * 500, p1: 70000, t2: candles[719][0] + BAR_MS * 500, p2: 90000, levels: [0, 1] },
        { kind: 'line', t1: candles[10][0], p1: 80000 },
        null,
        { kind: 'fib' },
      ],
    })
  } catch (e) { threw = e }
  check(threw === null, '残缺/超界的画线不抛错', threw === null ? '' : String(threw.message))

  // ---- 面板 UI：工具条在，且默认比例就是 0/0.5/1/1.5/2
  const panelHtml = renderToString(React.createElement(overlay.component))
  for (const needle of ['画线', '直线', '斐波那契', '撤销', '清空']) {
    check(panelHtml.indexOf(needle) >= 0, '面板包含画线控件「' + needle + '」')
  }
  check(JSON.stringify(mod.debug.parseFibLevels('0,0.5,1,1.5,2')) === '[0,0.5,1,1.5,2]', '默认比例含 0/0.5/1/1.5/2')

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

// ---------------------------------------------------------------- 4.7) 本轮加的：最新价线 / 倒计时 / 整点刻度 / 画线编辑 / 键盘与焦点

{
  const d = mod.debug
  const failedBefore = failed

  // ---- 收盘倒计时：以最后一根的开盘时刻为基准
  {
    const T0 = 1780000000000
    check(d.closeCountdown(T0, 900000, T0) === 900000, '刚开盘 → 剩整整一个周期')
    check(d.closeCountdown(T0, 900000, T0 + 300000) === 600000, '过了 5 分钟 → 剩 10 分钟')
    check(d.closeCountdown(T0, 900000, T0 + 899999) === 1, '差 1ms 收盘')
    check(d.closeCountdown(T0, 900000, T0 + 900000) === null, '已到收盘时刻 → 不算倒计时')
    check(d.closeCountdown(T0, 900000, T0 + 900000 * 5) === null, '时间戳早已过期 → 宁可不显示')
    check(d.closeCountdown(T0, 0, T0 + 1) === null, 'barMs 缺失 → null')
    check(d.closeCountdown(null, 900000, T0) === null, '没有 K 线时间 → null')
    check(d.fmtDur(900000) === '15:00', 'fmtDur 分:秒', d.fmtDur(900000))
    check(d.fmtDur(3725000) === '1h02m', 'fmtDur 超过一小时', d.fmtDur(3725000))
    check(d.fmtAgo(300) === '刚刚', '刚刷过显示「刚刚」', d.fmtAgo(300))
    check(d.fmtAgo(125000) === '02:05前', 'fmtAgo 带「前」', d.fmtAgo(125000))
    // **真事故回归**：两处调用点把"时间戳"当成"时长"传了进来，
    // 于是预警记录里显示"497584h前"（≈57 年）。参数必须是时长。
    check(d.fmtAgo(Date.now()) === '刚刚',
      'fmtAgo 收到时间戳（而不是时长）时不再显示荒谬的年数', d.fmtAgo(Date.now()))
    check(d.fmtAgo(1770000000000) === '刚刚', '明显是时间戳的输入被兜住', d.fmtAgo(1770000000000))
    check(d.fmtAgo(0) === '刚刚', '0 显示刚刚', d.fmtAgo(0))
    check(d.fmtAgo(-5) === '刚刚', '负数显示刚刚', d.fmtAgo(-5))
    check(d.fmtAgo(null) === '刚刚', 'null 显示刚刚', d.fmtAgo(null))
    check(d.fmtAgo(NaN) === '刚刚', 'NaN 显示刚刚', d.fmtAgo(NaN))
    check(d.fmtAgo(3 * 3600 * 1000) === '3h00m前', '正常的 3 小时照常显示', d.fmtAgo(3 * 3600 * 1000))
  }

  // ---- 时间刻度：对齐到整点，而不是把窗口等分
  {
    const T0 = 1780000000000
    const ticks = d.timeTicks(T0, T0 + 900000 * 29, 2, 5)
    check(ticks.length >= 2, '30 根 15m 的窗口能取到刻度', 'n=' + ticks.length)
    let aligned = true
    for (const t of ticks) if (t % 900000 !== 0) aligned = false
    check(aligned, '每条刻度都落在 15 分钟的整数倍上', JSON.stringify(ticks.slice(0, 4)))
    let ascending = true
    for (let i = 1; i < ticks.length; i += 1) if (ticks[i] <= ticks[i - 1]) ascending = false
    check(ascending, '刻度严格升序')
    check(ticks.every((t) => t >= T0 && t <= T0 + 900000 * 29), '刻度都落在窗口内')
    // 窗口极窄 / 极宽 / 退化输入都不能死循环（这里就是当初把浏览器转死的地方）
    check(d.timeTicks(T0, T0 + 1000, 2, 8).length <= 64, '1 秒的窗口不死循环')
    check(d.timeTicks(T0, T0 + 86400000 * 4000, 200, 400).length >= 2, '超宽窗口也能给出刻度')
    check(JSON.stringify(d.timeTicks(T0, T0, 2, 8)) === '[]', '零宽窗口返回空')
    check(JSON.stringify(d.timeTicks(T0 + 100, T0, 2, 8)) === '[]', '反向窗口返回空')
    check(JSON.stringify(d.timeTicks(NaN, T0, 2, 8)) === '[]', '非数字输入返回空')
  }

  // ---- 画线编辑：整体平移 / 拖端点 / 命中判定 / id 补齐
  {
    const shape = { id: 's1', kind: 'line', t1: 1000, p1: 80000, t2: 2000, p2: 81000 }
    const moved = d.moveDrawing(shape, 'body', 500, -100)
    check(moved.t1 === 1500 && moved.t2 === 2500, '整体平移：两个时间都动了')
    check(moved.p1 === 79900 && moved.p2 === 80900, '整体平移：两个价位都动了')
    check(shape.t1 === 1000 && moved.t1 !== shape.t1, 'moveDrawing 不改入参（纯函数）')
    const dragA = d.moveDrawing(shape, 'a', 50, 10)
    check(dragA.t1 === 1050 && dragA.p1 === 80010 && dragA.t2 === 2000 && dragA.p2 === 81000,
      '拖起点只动起点')
    const dragB = d.moveDrawing(shape, 'b', 50, 10)
    check(dragB.t2 === 2050 && dragB.p2 === 81010 && dragB.t1 === 1000, '拖终点只动终点')
    check(d.moveDrawing(shape, 'body', 0, 0).levels === undefined, '没 levels 的线不会长出 levels')

    const geom = {
      of: (ts, price) => ({ x: ts / 10, y: 1000 - price / 100 }),
      y: (price) => 1000 - price / 100,
    }
    const list = [{ id: 'a', kind: 'line', t1: 100, p1: 80000, t2: 300, p2: 81000 }]
    // 端点 (10, 200) → (30, 190)
    check(JSON.stringify(d.hitDrawing(geom, list, 10, 200)) === '{"index":0,"part":"a"}', '点在起点上 → 命中起点')
    check(JSON.stringify(d.hitDrawing(geom, list, 30, 190)) === '{"index":0,"part":"b"}', '点在终点上 → 命中终点')
    check(d.hitDrawing(geom, list, 20, 195).part === 'body', '点在线身上 → 命中线身')
    check(d.hitDrawing(geom, list, 20, 260) === null, '离得远 → 不命中')
    // 同一条线上「横向超出容差、纵向落在容差带附近」的点要算命中（线是斜的，判的是垂距）
    check(d.hitDrawing(geom, list, 10 + d.DRAW_HIT_PX + 2, 200) !== null, '沿线段方向偏一点仍算命中（判垂距）')
    check(d.hitDrawing(geom, list, 60, 200) === null, '端点之外沿着延长线走远 → 不命中')
    check(d.hitDrawing(geom, [{ id: 'h', kind: 'line', t1: 100, p1: 80000, t2: 300, p2: 81000, hidden: true }], 10, 200) === null,
      '隐藏的画线不参与命中')
    check(d.hitDrawing(geom, [{ id: 'f', kind: 'fib', t1: 100, p1: 80000, t2: 300, p2: 81000, levels: [0, 1] }], 20, 200) !== null,
      '斐波那契的比例线也能点中')
    // 后画的在上层：两条重叠时应该命中后画的那条
    const stacked = [list[0], { id: 'b', kind: 'line', t1: 100, p1: 80000, t2: 300, p2: 81000 }]
    check(d.hitDrawing(geom, stacked, 20, 195).index === 1, '重叠时命中上层（后画的）那条')
    check(d.hitDrawing(null, list, 10, 200) === null, '几何拿不到 → 不命中')
    check(d.hitDrawing(geom, [], 10, 200) === null, '空列表 → 不命中')
    check(d.hitDrawing(geom, [null, undefined, { kind: 'line' }], 10, 200) === null, '残缺元素不抛错')

    const withIds = d.withDrawingIds([{ kind: 'line' }, { id: 'keep', kind: 'fib' }, null, { kind: 'line' }])
    check(withIds.length === 3, '补齐 id 时丢掉 null 元素', String(withIds.length))
    check(typeof withIds[0].id === 'string' && withIds[0].id !== '', '没 id 的补一个')
    check(withIds[1].id === 'keep', '已有的 id 不动')
    check(withIds[0].id !== withIds[2].id, '两个新 id 不重复')
  }

  // ---- 渲染：最新价线 / 倒计时胶囊 / 纵向网格线
  //
  // 注意「回看中」角标：回看态会多画一段文字，所以不能拿 fillText 总数去比"有没有倒计时"，
  // 得按文字内容断言。
  {
    const board = makeBoard(720)
    const candles = board.candles
    const last = candles[719][4]
    const liveOpts = {
      hover: null, following: true,
      lastIndex: 719, lastPrice: last, nowMs: candles[719][0] + 600000,
    }
    const textOf = function (b, view, opts) {
      const canvas = makeCanvas(900, 380)
      const seen = []
      canvas.ctx.fillText = function (text) { seen.push(String(text)) }
      d.drawChart(canvas.canvas, b, opts)
      return seen
    }
    const liveText = textOf(board, null, liveOpts)
    const historyText = textOf(board, null, {
      hover: null, following: false, lastIndex: 719, lastPrice: last,
    })
    check(liveText.filter((t) => t.indexOf('收 ') === 0).length === 1,
      '跟随最新时画布上有且只有一个「收 mm:ss」倒计时',
      liveText.filter((t) => t.indexOf('收') === 0).join(' , '))
    check(historyText.every((t) => t.indexOf('收 ') !== 0), '回看历史时不画倒计时')
    check(liveText.indexOf('回看中') < 0 && historyText.indexOf('回看中') >= 0,
      '「回看中」角标只在回看态出现')

    const live = makeCanvas(900, 380)
    const noLive = makeCanvas(900, 380)
    d.drawChart(live.canvas, board, liveOpts)
    d.drawChart(noLive.canvas, board, {
      hover: null, following: false, lastIndex: 719, lastPrice: last,
    })
    check(live.ctx.calls.fillRect > noLive.ctx.calls.fillRect, '跟随最新时画了最新价标签',
      noLive.ctx.calls.fillRect + ' → ' + live.ctx.calls.fillRect)
    check(live.ctx.calls.stroke > noLive.ctx.calls.stroke, '跟随最新时画了最新价水平线')

    // 未收盘那根要区别对待：payload 第 7 位 [6] = done
    {
      const open = makeBoard(720)
      open.candles[719] = open.candles[719].slice(0, 6).concat([0])
      const closed = makeBoard(720)
      closed.candles[719] = closed.candles[719].slice(0, 6).concat([1])
      const a = makeCanvas(900, 380)
      const b = makeCanvas(900, 380)
      d.drawChart(a.canvas, open, liveOpts)
      d.drawChart(b.canvas, closed, liveOpts)
      check(a.ctx.calls.strokeRect >= 1 && b.ctx.calls.strokeRect === 0,
        '未收盘那根用描边标出来（已收盘的不描）',
        '未收盘 strokeRect=' + a.ctx.calls.strokeRect + ' 已收盘=' + b.ctx.calls.strokeRect)
      check(a.ctx.calls.fillRect > b.ctx.calls.fillRect, '未收盘那根还多画了「当前这一列」的底带',
        a.ctx.calls.fillRect + ' vs ' + b.ctx.calls.fillRect)
      check(textOf(open, null, liveOpts).indexOf('未收盘') < 0, '不悬浮时画布上没有多余文字')
    }

    // 纵向网格线：刻度处才有竖线，所以「有刻度的那一帧」stroke 必须更多
    {
      const thick = makeCanvas(900, 380)
      d.drawChart(thick.canvas, board, liveOpts)
      const single = makeCanvas(900, 380)
      d.drawChart(single.canvas, {
        candles: [candles[719]],
        lines: [{ item: { id: 'a', period: 20, color: '#f0b90b', show: false }, series: [null] }],
        meta: { barMs: 900000 },
      }, { hover: null, following: false, lastIndex: 0, lastPrice: null })
      check(thick.ctx.calls.stroke > single.ctx.calls.stroke + 2,
        '刻度处画了纵向网格线（stroke 数随刻度增加）',
        '720 根=' + thick.ctx.calls.stroke + ' vs 1 根=' + single.ctx.calls.stroke)
    }
  }

  // ---- 面板：焦点/键盘/画线管理的控件与无障碍属性
  {
    const panelHtml = renderToString(React.createElement(overlay.component))
    check(panelHtml.indexOf('aria-modal="true"') >= 0, '面板标了 aria-modal')
    check(panelHtml.indexOf('role="dialog"') >= 0, '面板保持 role=dialog')
    check(panelHtml.indexOf('tabindex="-1"') >= 0, '面板本身可聚焦（焦点陷阱的锚点）')
    check(panelHtml.indexOf('aria-pressed') >= 0, '画线工具是按下态按钮（aria-pressed）')
    // 数据陈旧时要有一条 role=status + aria-live 的提示（首屏还没数据，所以这里查的是标记本身）
    check(CLIENT_SOURCE_CODE.indexOf("'aria-live': 'polite'") >= 0, '陈旧数据的状态提示挂了 aria-live=polite')
    check(CLIENT_SOURCE_CODE.indexOf('btcd-stale') >= 0, '陈旧状态有专门的样式钩子')
    check(panelHtml.indexOf('暂停自动刷新') >= 0 || panelHtml.indexOf('恢复自动刷新') >= 0, '自动刷新按钮有无障碍名称')
    check(panelHtml.indexOf('立即刷新') >= 0, '刷新按钮有无障碍名称')
    check(panelHtml.indexOf('关闭看板') >= 0, '关闭按钮有无障碍名称')
    check(panelHtml.indexOf('拖动平移 · 滚轮缩放 · 双击复位') >= 0, '图例里给出了操作提示')
    check(panelHtml.indexOf('1-6 切周期') >= 0, '提示里写明了周期快捷键')
    check(panelHtml.indexOf('24h量 ') >= 0 && panelHtml.indexOf('BTC') >= 0, '24h 量补上了单位')
    check(CLIENT_SOURCE_CODE.indexOf('距收盘 ') >= 0, '价格行里放了距收盘倒计时')
  }

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

/**
 * 一个能真的点得动的 DOM 环境（jsdom + react-dom/client）。
 *
 * 为什么需要它：面板里最容易坏的东西是**事件处理函数**（比如某个函数被删了只剩 ref，
 * 一按就 ReferenceError，整棵 React 树随之被卸载 —— 用户看到的就是"面板自己关了"）。
 * renderToString 只出字符串，永远碰不到事件处理函数，所以这类 bug 只能靠真渲染 + 真事件发现。
 *
 * jsdom 从 DSH checkout 的依赖里找（这个测试本来就是本机自检用的），
 * 找不到就返回 null，由调用方跳过 —— 而不是判成失败。
 */
function createInteractiveDom(options) {
  const candidates = []
  if (process.env.DSH_JSDOM) candidates.push(process.env.DSH_JSDOM)
  candidates.push('jsdom')
  /**
   * DSH checkout 里的 jsdom：**不能写死 pnpm 目录名**（`jsdom@29.1.1_@noble+hashes@2.3.0` 这种）。
   * 依赖一升级目录名就变，测试于是不报错、只是静默跳过 jsdom 那半 —— "全绿"却什么也没验。
   * 这里按 `node_modules/.pnpm/jsdom@*` 扫一遍，把找到的入口都当候选（版本号随它变）。
   */
  const checkoutRoot = resolve(WORKSPACE, '..', 'deepseek-harness')
  const pnpmDir = join(checkoutRoot, 'node_modules', '.pnpm')
  try {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.indexOf('jsdom@') === 0) {
        candidates.push(join(pnpmDir, entry, 'node_modules', 'jsdom', 'lib', 'api.js'))
      }
    }
  } catch (error) { /* 没有 DSH checkout：只试环境变量 / 包名 */ }
  let JSDOM = null
  for (const candidate of candidates) {
    try {
      const require2 = createRequire(import.meta.url)
      // require.resolve 也吃绝对路径：DSH_JSDOM 指到 api.js 时同样成立
      const resolved = require2.resolve(candidate)
      // jsdom 是 CJS/ESM 混合，两种入口都试
      const loaded = require2(resolved)
      JSDOM = loaded.JSDOM || (loaded.default && loaded.default.JSDOM) || null
      if (JSDOM !== null) break
    } catch (error) { /* 试下一个 */ }
  }
  if (JSDOM === null) return null

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:3080/',
  })
  const win = dom.window
  const doc = win.document

  /**
   * 可选的 localStorage 预置（键 → 原样字符串）。
   * 用来验「上次选的标的被记住」：插件的 apply() 一上来就读 localStorage，
   * 所以必须在求值 client.js **之前**写进去。默认不预置 —— 旧用例行为完全不变。
   */
  const prefill = options !== undefined && options !== null && options.storage !== undefined
    && options.storage !== null && typeof options.storage === 'object' ? options.storage : null
  if (prefill !== null) {
    for (const key of Object.keys(prefill)) {
      const value = prefill[key]
      win.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }

  // 画布：不需要真画，但 drawChart 会调用这些方法，得让它们存在且不抛错。
  // **每块画布一个上下文**（浏览器就是这样）：回测面板的资金曲线要单独数落笔次数，
  // 共用一份上下文的话主图每秒重绘会混进来，断言就成了"可能画了"。
  const ctxByCanvas = new WeakMap()
  const ctxForCanvas = function (canvas) {
    let ctx = ctxByCanvas.get(canvas)
    if (ctx === undefined) {
      ctx = makeCtx()
      ctxByCanvas.set(canvas, ctx)
    }
    return ctx
  }
  win.HTMLCanvasElement.prototype.getContext = function () { return ctxForCanvas(this) }
  win.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 380, width: 900, height: 380, x: 0, y: 0 }
  }
  for (const [name, value] of [['clientWidth', 900], ['clientHeight', 380]]) {
    Object.defineProperty(win.HTMLCanvasElement.prototype, name, { get: function () { return value }, configurable: true })
  }
  // 面板的 CSS 变量（drawChart 会用 getComputedStyle 读它们）
  const style = doc.createElement('style')
  style.textContent = '.btcd-panel{--btcd-up:#16c784;--btcd-down:#ea3943}'
  doc.head.appendChild(style)

  // 只在这段测试期间替换全局，跑完还原（后面的断言还要用原来的假 window）
  const saved = new Map()
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'MouseEvent', 'KeyboardEvent', 'Event',
    'MessageChannel']) {
    saved.set(key, globalThis[key])
  }
  globalThis.window = win
  globalThis.document = doc
  globalThis.HTMLElement = win.HTMLElement
  globalThis.Element = win.Element
  globalThis.Node = win.Node
  globalThis.getComputedStyle = win.getComputedStyle.bind(win)
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win)
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win)
  globalThis.MouseEvent = win.MouseEvent
  globalThis.KeyboardEvent = win.KeyboardEvent
  globalThis.Event = win.Event
  /**
   * **必须有 MessageChannel**：react-dom 18 的调度器优先用它把"待提交的更新"派回事件循环。
   * jsdom 不提供，这里用 setTimeout 兜一个语义等价的。
   */
  if (typeof globalThis.MessageChannel !== 'function') {
    globalThis.MessageChannel = function FakeMessageChannel() {
      const self = { onmessage: null, postMessage: function (data) { setTimeout(function () { if (self.onmessage !== null) self.onmessage({ data: data }); }, 0) } }
      this.port1 = self
      this.port2 = self
    }
  }
  /**
   * **jsdom 的 `document.visibilityState` 是 `'prerender'`，不是 `'visible'`。**
   * 插件里所有"每秒自走"的定时器都带 `visibilityState === 'hidden' → return` 的守卫，
   * 在 jsdom 下这条守卫**每次都命中**，于是挂载之后面板再也不重渲染 ——
   * 表现是"时间读数停住、预警不刷新"。这个坑把好几个测试都骗过去了：
   * 它们全靠 flushSync（点按钮 / 派事件）驱动，正好绕过了"自己会不会动"这件事。
   * 浏览器里它就是 'visible'，所以这里显式修正环境。
   */
  try {
    Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true })
    Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true })
  } catch (error) { /* 改不动就维持原样，相关断言会失败并说明原因 */ }

  /**
   * **必须等 jsdom 的全局装好之后再 require('react-dom')。**（顺序反了输入框就永远收不到 onChange）
   * react-dom 在**模块加载那一刻**算一次 `canUseDOM` / `isInputEventSupported`
   * （后者靠 `'oninput' in document.createElement('input')`）。如果那时全局还没有 window/document，
   * 它就认定当前环境不支持 input 事件，退到 IE9 的 polyfill 分支：靠 `attachEvent('onpropertychange')`
   * 和 selectionchange/keyup 来补。jsdom 没有 `attachEvent`，于是无论 dispatch 什么事件，
   * React 的 onChange 都不会触发 —— 4.9 邮件输入框那条「type() 不生效、原因没查出」的旧注释就是它。
   * 回测面板要靠"改表单 → 断言 POST 体"来验换算，所以这里必须修对环境（先装全局，再加载 react-dom）。
   */
  const RDC = createRequire(reactDomServerPath)('react-dom/client')
  const { flushSync } = createRequire(reactDomServerPath)('react-dom')

  /**
   * 报告用到的浏览器 API（jsdom 不全）：
   * - `win.open`：jsdom 的 open 会报 "Not implemented"，换成记录型替身，断言里只看"有没有 open、参数对不对"，
   *   不真开窗；
   * - `URL.createObjectURL`：jsdom 29 仍然没有实现，补一个返回 `blob:jsdom-N` 的替身并记录 Blob，
   *   这样"先把 html 变成 blob url 再 window.open"这条链路能走通（浏览器里行为一致）。
   */
  const openedWindows = []
  win.open = function (url, target) {
    openedWindows.push({ url: url, target: target })
    // 必须返回一个**非 null** 的假 window：实现会把 null 当成"被弹窗拦截"并报错态
    return { closed: false, focus: function () {}, close: function () {} }
  }
  const objectUrls = []
  try {
    win.URL.createObjectURL = function (blob) {
      const url = 'blob:jsdom-' + String(objectUrls.length + 1)
      objectUrls.push({ url: url, blob: blob })
      return url
    }
    win.URL.revokeObjectURL = function () { /* 替身：不释放 */ }
  } catch (error) { /* 改不动就维持原样，报告相关断言会失败并说明原因 */ }

  const errors = []
  const marks = { nativeSeen: 0 }
  win.addEventListener('error', function (event) { errors.push(String(event.message)) })
  win.addEventListener('unhandledrejection', function (event) { errors.push('rejection: ' + String(event.reason)) })

  // 再加载一份插件（这次有真 DOM）
  let captured2 = null
  win.__ModuleLoader__ = { load: function (def) { captured2 = def; } }
  // 取数替身：/price 与 /board 都要给出与真实载荷同形状的字段，
  // 否则渲染期读到 undefined 会抛错，测试就变成"环境不对"而不是"代码不对"
  const interactiveBoard = makeBoard(400)
  // 六个周期标签都要有：预警要验"规则绑在创建时的周期上"，就得能真切周期
  interactiveBoard.bars = [
    { id: '1m', label: '1m' }, { id: '3m', label: '3m' }, { id: '15m', label: '15m' },
    { id: '1h', label: '1h' }, { id: '4h', label: '4h' }, { id: '1D', label: '1D' },
  ]
  const pricePayload = {
    ok: true,
    // 真实 Host 的 /price 响应带实际使用的标的；替身也带上，风格与真实载荷一致
    instId: 'BTC-USDT-SWAP',
    env: { id: 'demo', label: '模拟', simulated: true, keyMasked: 'cafe12…beef' },
    price: {
      last: 84061.1, change24h: 120.5, changePct: 0.14, bid: 84061, ask: 84061.2,
      high24h: 84500, low24h: 83600, vol24h: 1511.94,
    },
  }
  /** 让测试能把下一次 /board 的载荷换掉（收线预警要"多收了一根"才好验） */
  let boardOverride = null
  /**
   * 让测试把 /price 的载荷整个换掉（默认 null = 用上面那份 pricePayload）。
   * 设了之后**原样返回**、不再把请求 URL 上的 instId 反射进载荷 ——
   * 用来模拟旧 Host：`/price` 不认识 instId，响应里仍是 BTC 的价格/标的。
   */
  let priceOverride = null
  /**
   * 邮件配置的替身状态。`/email` 的 GET / POST 与 `/notify-email` 都在这里应答 ——
   * 早先这个替身只认 `/price`，**其余一律返回 K 线载荷**，于是 `/email` 拿到的是板子数据、
   * `res.email` 永远是 undefined，配置同步不回来（"地址不回填"就是这么来的）。
   * 顺带把 POST 的请求体记下来，供断言检查前端到底提交了什么。
   */
  const emailState = {
    enabled: false,
    to: '',
    confirmed: '',
    confirmedAt: null,
    lastSentAt: null,
    lastError: null,
    sentCount: 0,
    /** 宿主有没有 qqEmail 服务（dsh-qq-email 装没装）：false 用来测"缺依赖时的提示" */
    available: true,
  }
  const emailPosts = []
  const notified = []
  /** 让下一次 /email 的 POST 失败（测"保存失败后按钮不能卡死"） */
  let failEmailPost = false
  const emailView = () => ({
    enabled: emailState.enabled === true,
    to: emailState.to,
    confirmed: emailState.confirmed,
    authorized: emailState.confirmed !== '' && emailState.confirmed.toLowerCase() === emailState.to.toLowerCase(),
    available: emailState.available !== false,
    confirmedAt: emailState.confirmedAt,
    lastSentAt: emailState.lastSentAt,
    lastError: emailState.lastError,
    sentCount: emailState.sentCount,
  })
  /**
   * 回测面板的取数替身（契约 backtest/INTEGRATION-SPEC.md §2）。
   *
   * 面板的生命周期：打开 → GET strategies + GET status（不带 jobId，恢复上次结果）；
   * 点开始 → POST run → 每 800ms GET status?jobId=…；完成后可 GET report、POST cancel。
   * 所以这里用 **status 队列** 驱动轮询：`setBtStatus([running, done])` 表示"下一次 status 给 running、
   * 再下一次给 done"，队列空了就一直返回最近一次的那个 job（模拟"状态停在 done/error"）。
   * run/cancel 的请求体都按顺序记录，供断言检查前端到底提交了什么（和 emailPosts 一个套路）。
   */
  const btStrategiesPayload = () => ({
    ok: true,
    strategies: [
      { name: 'buy-hold', params: {} },
      {
        name: 'donchian-trend',
        params: {
          entryWindow: 36, exitWindow: 36, trendWindow: 120, atrPeriod: 14,
          atrStop: 0, allowShort: false, slopeFilter: false, weight: 1,
        },
      },
      { name: 'sma-cross', params: { fast: 20, slow: 60, allowShort: false } },
    ],
    bars: ['1m', '3m', '5m', '15m', '1h', '4h', '1D'],
    // 可选标的来自 Host 的 insts（回测面板「标的」下拉的数据源，前端不写死列表）
    insts: [
      { instId: 'BTC-USDT-SWAP', label: 'BTCUSDT 永续', short: 'BTC' },
      { instId: 'ETH-USDT-SWAP', label: 'ETHUSDT 永续', short: 'ETH' },
    ],
    defaults: {
      instId: 'BTC-USDT-SWAP', bar: '1h', initialCapital: 10000,
      leverage: 1, makerFeeRate: 0.0002, takerFeeRate: 0.0005, rangeDays: 30,
    },
    limits: { maxBarsHint: 20000, maxPages: 2000, jobTimeoutMs: 1200000 },
    job: null,
  })
  const btState = {
    /** GET strategies 的载荷（用例可用 setBtStrategies 整个换掉） */
    strategies: btStrategiesPayload(),
    /** setBtStatus 排的队；每来一次 GET status 消费一个 */
    statuses: [],
    /** 最近一次返回给前端的 job（没有就 null） */
    current: null,
    /** POST run 的请求体（按顺序） */
    runs: [],
    /** POST cancel 的请求体（按顺序） */
    cancels: [],
    /** GET report 的记录：{ url, format } */
    reportFetches: [],
    /** 设成字符串 → POST run 返回 {ok:false,error}（测错误态） */
    runError: null,
    /** 设成对象 → POST run 直接返回它当 job（不设时用下面的默认 running job） */
    runJob: null,
    /** GET report?format=html 的正文（固定一段，能看出"真的把报告文本拿回来了"） */
    reportHtml: '<!doctype html><html><head><meta charset="utf-8"><title>回测报告</title></head>'
      + '<body><h1>回测报告</h1><p>这是测试替身返回的报告 HTML。</p></body></html>',
    /** GET report?format=json 的正文 */
    reportJson: { generatedAt: 1792237999000, instId: 'BTC-USDT-SWAP', bar: '1h', metrics: { totalReturnPct: 12.34 } },
  }
  /** 回测的 JSON 响应（形状对齐真实路由：HTTP 200 + ok 字段） */
  const btJson = (payload, status) => Promise.resolve({
    ok: true,
    status: status === undefined ? 200 : status,
    headers: { get: function (name) { return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null } },
    json: function () { return Promise.resolve(payload) },
    text: function () { return Promise.resolve(JSON.stringify(payload)) },
  })
  /**
   * 所有请求的日志（{ url, method }，按顺序）。
   * fakeFetch 是取数的唯一入口，所以在这里记一份最省事：
   * 「切到 ETH 之后 /board、/price 的 URL 真的带上了 instId=ETH-USDT-SWAP」只能靠它验。
   */
  const requests = []
  const fakeFetch = function (url, options) {
    const text = String(url);
    const isPrice = text.indexOf('/price') >= 0;
    const isEmail = text.indexOf('/email') >= 0;
    const isNotify = text.indexOf('/notify-email') >= 0;
    const method = options !== undefined && options !== null && options.method !== undefined
      ? String(options.method) : 'GET';
    requests.push({ url: text, method: method });
    if (isEmail === true) {
      if (method === 'POST') {
        let body = {};
        try { body = JSON.parse(String(options.body === undefined ? '{}' : options.body)) } catch (error) { body = {} }
        // 先记录请求体（哪怕接下来要模拟失败），这样断言能看出前端到底提交了什么
        emailPosts.push(body)
        if (failEmailPost === true) {
          return Promise.reject(new Error('模拟：邮件设置保存失败'))
        }
        if (typeof body.to === 'string' && body.to.trim() !== '') emailState.to = body.to.trim()
        emailState.enabled = body.enabled === true
        if (emailState.enabled === true && body.confirm === true) {
          emailState.confirmed = emailState.to
          emailState.confirmedAt = Date.now()
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ ok: true, email: emailView() }) },
          text: function () { return Promise.resolve(JSON.stringify({ ok: true, email: emailView() })) },
        })
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ ok: true, email: emailView() }) },
        text: function () { return Promise.resolve(JSON.stringify({ ok: true, email: emailView() })) },
      })
    }
    if (isNotify === true) {
      let body = {};
      try { body = JSON.parse(String(options.body === undefined ? '{}' : options.body)) } catch (error) { body = {} }
      notified.push(body)
      if (emailState.enabled !== true) {
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ ok: false, skipped: 'disabled', error: '邮件提醒没开' }) },
          text: function () { return Promise.resolve('{}') },
        })
      }
      emailState.lastSentAt = Date.now()
      emailState.sentCount += 1
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ ok: true, queued: true, to: [emailState.to], subject: 'x' }) },
        text: function () { return Promise.resolve('{"ok":true}') },
      })
    }
    /**
     * `/backtest/*` 必须先于 /board 兜底判断，否则 strategies/status 会被当成 K 线载荷。
     * `text` 是完整 URL（`/dsh-btc/backtest/…`），按路径段判断即可。
     * 顺序安全性：`isEmail` 用的是 `indexOf('/email')`，而 `/backtest/` 里不含 `/email`；
     * `/notify-email` 也只匹配它自己那条 —— 所以这里的判断放在它们之后不会互相抢。
     */
    if (text.indexOf('/backtest/') >= 0) {
      // --- POST run：先记录请求体（哪怕接下来模拟失败），再决定返回什么
      if (text.indexOf('/backtest/run') >= 0 && method === 'POST') {
        let body = {}
        try { body = JSON.parse(String(options.body === undefined ? '{}' : options.body)) } catch (error) { body = {} }
        btState.runs.push(body)
        if (btState.runError !== null) return btJson({ ok: false, error: btState.runError })
        const running = btState.runJob !== null ? btState.runJob : {
          id: 'bt-test-1',
          state: 'running',
          phase: 'data',
          message: '正在抓取历史 K 线…',
          progress: { pages: 3, bars: 300, pct: null },
          startedAt: 1792237123456,
          finishedAt: null,
          elapsedMs: 1200,
          cancelRequested: false,
          error: null,
          summary: null,
        }
        btState.current = running
        return btJson({ ok: true, job: running })
      }
      // --- POST cancel：记录 jobId，并让之后的 status/返回值都是 cancelled
      if (text.indexOf('/backtest/cancel') >= 0 && method === 'POST') {
        let body = {}
        try { body = JSON.parse(String(options.body === undefined ? '{}' : options.body)) } catch (error) { body = {} }
        btState.cancels.push(body)
        const base = btState.current === null ? { id: 'bt-test-1' } : btState.current
        const cancelled = Object.assign({}, base, {
          state: 'cancelled',
          phase: 'cancelled',
          message: '正在取消…',
          cancelRequested: true,
          finishedAt: 1792237200000,
          error: null,
        })
        btState.current = cancelled
        return btJson({ ok: true, cancelled: true, job: cancelled })
      }
      if (text.indexOf('/backtest/strategies') >= 0) return btJson(btState.strategies)
      // --- GET status：队列优先；队列空了一直给最近一次（模拟"状态就停在那儿"）
      if (text.indexOf('/backtest/status') >= 0) {
        const next = btState.statuses.length > 0 ? btState.statuses.shift() : btState.current
        if (next !== null && next !== undefined) btState.current = next
        return btJson({ ok: true, job: next === undefined ? null : next })
      }
      // --- GET report：html 走 text()（面板要把它包成 blob），json 走 json()
      if (text.indexOf('/backtest/report') >= 0) {
        const isHtml = text.indexOf('format=html') >= 0
        btState.reportFetches.push({ url: text, format: isHtml ? 'html' : 'json' })
        if (isHtml === true) {
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: function (name) { return String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null } },
            json: function () { return Promise.reject(new Error('报告是 HTML，不是 JSON')) },
            text: function () { return Promise.resolve(btState.reportHtml) },
          })
        }
        return btJson(btState.reportJson)
      }
      return btJson({ ok: false, error: '测试替身不认识的回测路径：' + text })
    }
    const chosen = boardOverride === null ? interactiveBoard : boardOverride;
    /**
     * /price 的替身：显式 setPricePayload() 过就原样返回（不反射 instId —— 用来模拟旧 Host
     * 不认 instId、回的还是 BTC 的价格）；否则返回默认 pricePayload 并反射 instId。
     */
    const rawPrice = isPrice && priceOverride !== null ? priceOverride : null
    const wantedPayload = isPrice ? (rawPrice === null ? pricePayload : rawPrice) : chosen;
    /**
     * 把请求 URL 上的 instId 反射回载荷（真实 Host 就是这样：响应里的 instId = 实际使用的标的）。
     * 这样「切到 ETH 后标题 chip / 页脚 / 回测副标题跟着变」才是端到端可验的，
     * 而不是只验了请求 URL。没带 instId 时保持替身原样。
     */
    const instMatch = /[?&]instId=([^&]+)/.exec(text)
    const requestedInst = instMatch === null ? '' : decodeURIComponent(instMatch[1])
    const payload = rawPrice !== null
      ? rawPrice
      : (requestedInst === ''
        ? wantedPayload
        : Object.assign({}, wantedPayload, { instId: requestedInst }))
    if (isPrice !== true && process.env.DSH_BTC_TRACE === '1') {
      console.log('[fetch] /board → override=' + String(boardOverride !== null) + ' 根数=' + String((chosen.candles || []).length)
        + (requestedInst === '' ? '' : ' instId=' + requestedInst));
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(payload); },
      text: function () { return Promise.resolve(JSON.stringify(payload)); },
    });
  }
  new Function('window', 'document', 'getComputedStyle', 'fetch', CLIENT_SOURCE_CODE)(
    win, doc, globalThis.getComputedStyle, fakeFetch)
  const mod2 = captured2.factory(function (spec) { if (spec === 'react') return React; throw new Error(spec) })
  const registered2 = []
  mod2.apply({
    effect: function (fn) { const d = fn(); return function () { if (typeof d === 'function') d(); }; },
    slots: {
      inject: function (key, cb) { return cb(); },
      register: function (options, component) {
        registered2.push({ options: options, component: component });
        return function () {};
      },
    },
  })
  const overlay2 = registered2.filter(function (r) { return r.options.name === 'shell.overlay'; })[0]
  const sidebar2 = registered2.filter(function (r) { return r.options.name === 'sidebar.footer.action'; })[0]

  const container = doc.getElementById('root')
  let root = null
  return {
    container: function () { return container; },
    /**
     * 换掉接下来的 /board 载荷（收线预警要"又多收了一根 K 线"才好验）。
     * 拿到的板子必须有 `lines` 字段，否则图表画不出均线。
     */
    setBoard: function (next) {
      boardOverride = next;
      // 立刻再拉一次，不等 5 秒轮询
      const panel = container.querySelector('.btcd-panel');
      const refresh = panel === null ? null : panel.querySelector('button[aria-label="立即刷新"]');
      if (refresh !== null && refresh !== undefined) {
        flushSync(function () {
          refresh.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        });
      }
    },
    /**
     * 让 React 把挂起的更新冲出来。
     * 在这个 harness 里，promise 回调里排队的更新有时不会自己跑完（没有真实帧循环），
     * 靠"再点一下不改变状态的东西"把调度器踢一脚最省事。
     */
    pump: function () {
      const panel = container.querySelector('.btcd-panel');
      const auto = panel === null ? null : panel.querySelector('button[aria-label^="暂停自动刷新"], button[aria-label^="恢复自动刷新"]');
      if (auto !== null && auto !== undefined) {
        flushSync(function () {
          auto.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        });
        flushSync(function () {
          auto.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        });
      }
    },
    /**
     * 把 React 挂起的更新冲出来，**不改变任何状态**。
     * 用 flushSync 包一次空操作：如果挂起的更新存在，它会被提交。
     * （在这个 harness 里，定时器/轮询触发的 setState 不一定会自己提交 —— 见 mount 里的 MessageChannel 说明。）
     */
    flushPending: function () {
      flushSync(function () { /* 空操作，只为逼一次提交 */ })
    },
    /** 让 React 与 effect 跑几拍（载荷变化后的判定是异步的） */
    settle: function (ms) {
      return new Promise(function (resolve) {
        let waited = 0
        const step = function () {
          if (waited >= (ms || 400)) { resolve(); return }
          waited += 50
          setTimeout(step, 50)
        }
        step()
      })
    },
    /** 这一份 JSDOM 的 window：测试里要自己造事件（画布上的 pointer 序列）时用得上 */
    window: win,
    /** 同一份 window（读它的 localStorage 之类） */
    win: function () { return win; },
    /** 所有取数请求（{url, method}，按顺序）：验 URL 带 instId 用 */
    requests: function () { return requests.slice(); },
    /** /board 的请求 URL（按顺序） */
    boardRequests: function () {
      return requests.filter(function (r) { return r.url.indexOf('/board?') >= 0 })
        .map(function (r) { return r.url; });
    },
    /** /price 的请求 URL（按顺序） */
    priceRequests: function () {
      return requests.filter(function (r) { return r.url.indexOf('/price') >= 0 })
        .map(function (r) { return r.url; });
    },
    /**
     * 换掉 /price 的载荷（传 null 恢复默认）。
     * 设了之后原样返回、不反射请求 URL 上的 instId —— 用来模拟旧 Host：
     * `/price` 不认 instId，响应里仍是 BTC 的标的与价格。
     */
    setPricePayload: function (next) { priceOverride = next === undefined ? null : next; },
    /** 侧边栏入口组件（要在 jsdom 里真渲染它才跑得动 usePrice/useInstStore） */
    sidebarComponent: function () { return sidebar2.component; },
    /** 邮件配置替身的状态（测试要预置"上次填好的地址"） */
    emailState: function () { return emailState; },
    /** 前端提交给 /email 的请求体（按顺序） */
    emailPosts: function () { return emailPosts; },
    /** 前端提交给 /notify-email 的载荷（按顺序） */
    notified: function () { return notified; },
    /** 让 /email 的 POST 失败（模拟宿主没起来） */
    failEmailPost: {
      set: function (value) { failEmailPost = value === true; },
    },
    // ---- 回测面板的替身句柄（风格对齐 emailPosts / failEmailPost）
    /** GET /backtest/strategies 的载荷（可整体替换，用来验"策略 / 周期选项来自服务端"） */
    setBtStrategies: function (next) { btState.strategies = next; },
    /** 排后续 GET /backtest/status 的返回：数组 = 逐拍消费，单个对象 = 一直返回它 */
    setBtStatus: function (next) {
      btState.statuses = Array.isArray(next) ? next.slice() : [next]
    },
    /** 让 POST /backtest/run 返回 {ok:false,error}（传 null 恢复正常） */
    setBtRunError: function (message) { btState.runError = message === undefined ? null : message },
    /** 让 POST /backtest/run 直接返回指定 job（默认是一个 running 的 job） */
    setBtRunJob: function (job) { btState.runJob = job === undefined ? null : job },
    /** 回测替身的整体状态：{ current, runs, cancels, reportFetches, strategies, statuses } */
    btState: function () { return btState; },
    /** POST /backtest/run 的请求体（按顺序） */
    btRuns: function () { return btState.runs; },
    /** POST /backtest/cancel 的请求体（按顺序） */
    btCancels: function () { return btState.cancels; },
    /** GET /backtest/report 的请求记录（按顺序，含 format） */
    btReportFetches: function () { return btState.reportFetches; },
    /** 换掉 GET report?format=html 的正文 */
    setBtReportHtml: function (html) { btState.reportHtml = html; },
    /** window.open 的记录（{url,target}）：报告那条链路必须走 blob url + _blank */
    openedWindows: function () { return openedWindows; },
    /** URL.createObjectURL 造出来的 blob url 记录（含 Blob 本体，可看 type） */
    objectUrls: function () { return objectUrls; },
    /** 某块画布上的落笔计数；不传 selector 时看回测资金曲线 */
    canvasCalls: function (selector) {
      const el = container.querySelector(selector === undefined ? 'canvas.btcd-btchart' : selector)
      if (el === null || el === undefined) return null
      const ctx = ctxByCanvas.get(el)
      return ctx === undefined ? null : ctx.calls
    },
    /** 最近一次切面测试里捕获到的运行时错误（未处理的 rejection 也算） */
    errors: function () { return errors.slice(); },
    /** 逼 React 同步提交（在自己派发事件之后读 DOM 之前调一下） */
    flushSync: flushSync,
    /** 当前面板元素（点完一轮之后 DOM 可能已经被 React 换过，必须重新查） */
    panel: function () { return container.querySelector('.btcd-panel'); },
    /** 画线持久化的内容（排障用；也顺带验证"真的落到 localStorage 了"） */
    storedDrawings: function () {
      return win.localStorage.getItem('dsh-btc-dashboard:drawings:BTC-USDT-SWAP:15m');
    },
    errors: function () { return errors.slice(); },
    /** 插件模块本身（有些用例要直接渲染 Chart 之类的子组件） */
    module: function () { return mod2; },
    /**
     * 渲染任意组件并返回"能驱动它"的句柄。
     * 这里的事件能正常送达 React —— 因为 jsdom 的全局是在**渲染之前**装好的
     * （react-dom 的事件系统在模块加载时就绑定了当时的 window，顺序反了就永远收不到）。
     */
    render: function (component, props) {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const seen = {}
      const record = function (name) {
        return function () {
          if (seen[name] === undefined) seen[name] = []
          seen[name].push(Array.prototype.slice.call(arguments))
        }
      }
      const wrapped = Object.assign({}, props, {
        onView: function (view) { record('view')(view) },
        onAdd: function (shape) { record('add')(shape) },
        onUpdate: function (id, shape) { record('update')(id, shape) },
        onSelect: function (id) { record('select')(id) },
        onToolDone: function () { record('toolDone')() },
      })
      const sub = RDC.createRoot(host)
      // React 18 的 createRoot().render() 是异步提交的，这里要立刻拿到 DOM，
      // 所以用 flushSync 逼它同步提交（不然 host 里是空的）
      flushSync(function () { sub.render(React.createElement(component, wrapped)) })
      const canvas = host.querySelector('canvas')
      return {
        canvas: function () { return canvas },
        hostHtml: function () { return host.innerHTML },
        added: function () { return seen.add === undefined ? [] : seen.add.map(function (a) { return a[0] }) },
        viewCount: function () { return seen.view === undefined ? 0 : seen.view.length },
        toolDoneCount: function () { return seen.toolDone === undefined ? 0 : seen.toolDone.length },
        canvasClass: function () { return canvas === null ? '(没有 canvas)' : canvas.className },
        pointer: function (type, x, y, buttons) {
          const event = new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, buttons: buttons, clientX: x, clientY: y,
          })
          event.pointerId = 1
          event.pointerType = 'mouse'
          canvas.dispatchEvent(event)
        },
        destroy: function () {
          try { sub.unmount() } catch (error) { /* 已卸载 */ }
          host.remove()
        },
      }
    },
    /** 挂载面板（先按侧边栏按钮把开关打开，跟真实路径一致） */
    mount: function (options) {
      // 允许用例指定这次要发的载荷（自检要验"老宿主只发 6 位"这种形状）
      if (options !== undefined && options !== null
        && (options.board !== undefined || options.boardOverrideRaw !== undefined)) {
        boardOverride = options.board !== undefined ? options.board : options.boardOverrideRaw;
      }
      sidebar2.component({ wide: true }).props.toggle()
      root = RDC.createRoot(container)
      root.render(React.createElement(overlay2.component))
      // react-dom 的并发渲染与 useEffect、以及第一次取数都是异步的。
      // 判据要挑"只有完整渲染之后才会成立"的：六个周期标签 **且** 工具条里已经有「尺子」。
      // 只等标签数会踩到竞态 —— React 可能分几次提交，中途也能看到 6 个标签但工具条还没画出来。
      return new Promise(function (resolve) {
        let waited = 0
        const step = function () {
          const panel = container.querySelector('.btcd-panel')
          const tabs = panel === null ? 0 : panel.querySelectorAll('.btcd-tab').length
          const tools = panel === null ? 0 : panel.querySelectorAll('.btcd-tool').length
          if ((tabs >= 6 && tools >= 5) || waited > 4000) { resolve(panel); return }
          waited += 50
          setTimeout(step, 50)
        }
        step()
      });
    },
    /**
     * 往受控输入框里"打字"。
     * 不能直接 `input.value = x`：React 在 input 上挂了一个 value tracker，
     * 直接赋值会被它判定成"没变过"，onChange 根本不触发。
     * 要用原型上的原生 setter 赋值，再把 input 事件派发出去，React 才会认。
     *
     * 旧注释说"portal 里的输入框用不了"（管理浮层是 portal 那会儿）—— 那个结论后来查清了：
     * 真正的原因是 **react-dom 在 jsdom 全局装好之前就被 require 了**，于是它判定环境不支持
     * input 事件、退到 IE9 polyfill（见 createInteractiveDom 里加载顺序的注释）。修好之后
     * 同源 `.btcd-emapanel` 里的输入框（均线周期 / 邮件地址 / 回测表单）都能正常驱动 onChange。
     */
    type: function (element, text) {
      const proto = win.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(element, text)
      flushSync(function () {
        element.dispatchEvent(new win.Event('input', { bubbles: true }))
      })
    },
    /**
     * 改 `<select>` 的值：同样要绕过 React 的受控 value，再用原生 setter + change 事件。
     * （select 的 onChange 走 change 事件；checkbox 的走 click，直接用 click 就行。）
     */
    select: function (element, value) {
      const proto = win.HTMLSelectElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(element, value)
      flushSync(function () {
        element.dispatchEvent(new win.Event('change', { bubbles: true }))
      })
    },
    click: function (element) {
      // React 18 里点击引起的 setState 是异步提交的，断言前必须逼它同步落盘，
      // 否则读到的还是上一帧的 DOM（踩过：点「新增」后仍然只有两条）。
      flushSync(function () {
        element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      })
    },
    /** 在画布上按 pointer 序列拖一把（组件用的是 pointer 事件） */
    drag: function (element, from, to) {
      const mk = function (type, point, buttons) {
        const event = new win.MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, buttons: buttons,
          clientX: point.x, clientY: point.y,
        });
        event.pointerId = 1;
        event.pointerType = 'mouse';
        return event;
      };
      element.dispatchEvent(mk('pointerdown', from, 1));
      element.dispatchEvent(mk('pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 1));
      element.dispatchEvent(mk('pointermove', to, 1));
      element.dispatchEvent(mk('pointerup', to, 0));
    },
    key: function (key, extra) {
      const event = new win.KeyboardEvent('keydown', Object.assign({ key: key, bubbles: true, cancelable: true }, extra || {}));
      // 和 click 一样：键盘触发的 setState 也是异步提交的，不逼一下断言会读到旧 DOM
      flushSync(function () { doc.dispatchEvent(event) });
    },
    /**
     * 收尾：先卸载（让 React 的 effect 清理跑完），再让调度器跑一拍，最后才还原全局并关窗口。
     * 顺序错了会在 React 的调度任务里读到已经拿掉的 window，报"window is not defined" ——
     * 测试结果是对的，但那串错误噪音会盖住真问题。
     */
    unmount: async function () {
      if (root !== null) {
        try { root.unmount() } catch (error) { /* 已经卸载过就算了 */ }
      }
      await new Promise(function (resolve) { setTimeout(resolve, 50) })
      for (const [key, value] of saved) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
      win.close()
    },
  };
}

/**
 * 把插件运行期拼出来的那份 CSS 字符串求出来（`.btcd-drawmode{cursor:' + CURSOR_CROSS + '}` 这类）。
 * 断言样式要针对"真正会被塞进 <style> 的内容"，而不是源码里的字面量。
 */
function buildPluginCss() {
  try {
    const cursorExpr = /var CURSOR_CROSS = ([\s\S]*?);\n/.exec(CLIENT_SOURCE_CODE)[1]
    const cursor = new Function('return ' + cursorExpr)()
    const body = /var CSS = \[([\s\S]*?)\]\.join\(''\);/.exec(CLIENT_SOURCE_CODE)[1]
    return new Function('CURSOR_CROSS', "return [" + body + "].join('')")(cursor)
  } catch (error) {
    return null
  }
}

// ---------------------------------------------------------------- 4.8) 回归：涨绿跌红 / 周期能切 / 点画线不炸//
// 这三个是「改完 B/C/E 之后在真面板上发现的」：
//   1) 所有 K 线实体一个颜色 —— bodyOf 里漏了 ctx.fillStyle = color，
//      画布状态跨调用共享，于是实体全用「上一次设过的颜色」填充（影线是对的，所以特别像串色）。
//   2) 点周期标签 / 按数字键切周期直接抛 ReferenceError：switchBar 被删了只剩 ref。
//   3) 点已画的线抛 ReferenceError：deleteSelected 同上，抛出时整棵 React 树被卸载（面板"自己关了"）。
{
  const d = mod.debug
  const failedBefore = failed

  // ---- (1) 影线和实体都必须用「那根自己的」颜色
  function colorsPainted(board, opts) {
    const made = makeCanvas(900, 380)
    const fills = []
    const strokes = []
    const ctx = made.ctx
    const origFill = ctx.fillRect
    const origStroke = ctx.stroke
    // 记录「填充那一刻的 fillStyle / strokeStyle」
    ctx.fillRect = function () { fills.push({ color: ctx.fillStyle, alpha: ctx.globalAlpha }); return origFill.apply(null, arguments) }
    ctx.stroke = function () { strokes.push(ctx.strokeStyle); return origStroke.apply(null, arguments) }
    d.drawChart(made.canvas, board, opts)
    return { fills: fills, strokes: strokes }
  }
  // 造一段有涨有跌、且实体高度是 1 的探针数据，避免 x 排序造成的巧合
  function alternatingBoard(n) {
    const candles = []
    for (let i = 0; i < n; i += 1) {
      const up = i % 2 === 0
      const o = 80000
      const c = up ? 80100 : 79900
      candles.push([1780000000000 + i * 900000, o, 80200, 79800, c, 100, 1])
    }
    return { candles: candles, ema20: [], ema480: [], lines: [], meta: { barMs: 900000 } }
  }
  {
    const board = alternatingBoard(40)
    const painted = colorsPainted(board, { hover: null, following: false, lastIndex: -1 })
    const bodyColors = new Map()
    for (const f of painted.fills) if (f.alpha === 1) bodyColors.set(f.color, (bodyColors.get(f.color) || 0) + 1)
    check(bodyColors.get('#16c784') === 20, '涨的实体用绿色（20 根）', JSON.stringify(Array.from(bodyColors.entries())))
    check(bodyColors.get('#ea3943') === 20, '跌的实体用红色（20 根）', JSON.stringify(Array.from(bodyColors.entries())))
    const strokeSet = new Set(painted.strokes)
    check(strokeSet.has('#16c784') && strokeSet.has('#ea3943'), '影线两种颜色都有',
      JSON.stringify(Array.from(strokeSet)))
    // 量柱也吃同一套颜色
    const volumeColors = new Map()
    for (const f of painted.fills) if (f.alpha === 0.5) volumeColors.set(f.color, (volumeColors.get(f.color) || 0) + 1)
    check(volumeColors.get('#16c784') === 20 && volumeColors.get('#ea3943') === 20,
      '量柱同样涨绿跌红', JSON.stringify(Array.from(volumeColors.entries())))
  }
  // 源码级保险：bodyOf 必须自己设 fillStyle（别再依赖调用方）
  {
    const bodyOfSource = CLIENT_SOURCE_CODE.slice(CLIENT_SOURCE_CODE.indexOf('function bodyOf'))
    const head = bodyOfSource.slice(0, 400)
    check(head.indexOf('ctx.fillStyle = color') >= 0, 'bodyOf 自己设置 fillStyle（不靠调用方先设好）')
    check((CLIENT_SOURCE_CODE.match(/function bodyOf\(/g) || []).length === 1, 'bodyOf 只定义一次（重复定义会互相覆盖）')
    check((CLIENT_SOURCE_CODE.match(/function roundBox\(/g) || []).length === 1, 'roundBox 只定义一次')
  }

  // ---- (2)(3) 面板真的渲染出来了：用 jsdom 注水渲染，检查 DOM 结构
  //
  // 诚实说明：这一节**不派发事件**。react-dom 在模块加载时就把事件系统绑到了当时的
  // `window` 上，而这里的 jsdom 窗口是后来才装进 globalThis 的 —— 派发过去的 click
  // 能触发原生监听器，但永远到不了 React 的 onClick（实测三种派发方式都一样）。
  // 所以事件处理函数里"函数没定义"这类 bug，靠下面的**静态标识符扫描**兜：
  // 把 onClick 里用到的每个名字强制引用一次，名字没定义就会被抓出来。
  // 这里负责另外半件事：真渲染一遍，确认 DOM 结构、禁用态、无障碍属性都对。
  const dom = createInteractiveDom()
  if (dom === null) {
    console.log('     跳过 DOM 渲染测试：环境里找不到 jsdom（可设 DSH_JSDOM 指定路径）')
  } else {
    const panel = await dom.mount()
    check(panel !== null && panel.textContent.length > 200, 'jsdom 里真的渲染出了面板',
      panel === null ? 'null' : String(panel.textContent.length) + ' 字符')
    if (panel !== null) {
      const tabLabels = Array.from(panel.querySelectorAll('.btcd-tab')).map(function (b) { return b.textContent })
      check(tabLabels.join(',') === '1m,3m,15m,1h,4h,1D', '渲染出六个周期标签', tabLabels.join(','))
      check(panel.querySelectorAll('.btcd-tab.on').length === 1, '只有一个周期是选中态')
      const toolLabels = Array.from(panel.querySelectorAll('.btcd-tool')).map(function (b) { return b.textContent })
      check(toolLabels.join(',').indexOf('尺子') >= 0 && toolLabels.join(',').indexOf('吸附') >= 0,
        '工具条里有尺子与吸附', toolLabels.join(','))
      // 吸附按钮本身要按得动、状态要真的切（"看起来没用"的根因在数据基准，由 4.9 的端到端用例盯着；
      // 这里守住另一头：按钮别变成一个永远按不动的样式壳）
      const snapButton = function () {
        for (const b of panel.querySelectorAll('.btcd-tool')) if (b.textContent.trim() === '吸附') return b
        return null
      }
      check(snapButton() !== null, '工具条上有「吸附」按钮')
      if (snapButton() !== null) {
        check(snapButton().getAttribute('aria-pressed') === 'true', '吸附默认是开的',
          String(snapButton().getAttribute('aria-pressed')))
        dom.click(snapButton())
        check(snapButton().getAttribute('aria-pressed') === 'false', '点一下 → 状态变「关」',
          String(snapButton().getAttribute('aria-pressed')))
        dom.click(snapButton())
        check(snapButton().getAttribute('aria-pressed') === 'true', '再点一下 → 恢复「开」',
          String(snapButton().getAttribute('aria-pressed')))
      }
      // 首屏没有画线：撤销/清空应当是禁用的
      const disabledTools = Array.from(panel.querySelectorAll('.btcd-tool[disabled]')).map(function (b) { return b.textContent })
      check(disabledTools.indexOf('撤销') >= 0 && disabledTools.indexOf('清空') >= 0,
        '没有画线时「撤销/清空」是禁用的', disabledTools.join(','))
      const canvas = panel.querySelector('canvas.btcd-canvas')
      check(canvas !== null, '画布渲染出来并带 btcd-canvas 类')
      if (canvas !== null) {
        check(canvas.getAttribute('tabindex') === '0', '画布可聚焦（键盘操作的前提）')
        check(canvas.getAttribute('role') === 'img', '画布有 role=img')
        check(String(canvas.getAttribute('aria-label')).indexOf('K 线图') >= 0, '画布有描述性的 aria-label')
      }
      check(panel.getAttribute('aria-modal') === 'true' && panel.getAttribute('role') === 'dialog', '面板是模态对话框')
      check(dom.errors().length === 0, '整个渲染过程没有页面级异常', dom.errors().join(' | '))
    }
    // 全局作用域不该被插件污染（客户端半是模块，不是脚本）
    const leakedGlobals = ['drawChart', 'emaFor', 'hitDrawing', 'measureStats', 'barIdsRef']
      .filter(function (name) { return typeof globalThis[name] !== 'undefined' })
    check(leakedGlobals.length === 0, '没有把内部函数泄漏到全局', leakedGlobals.join(','))
    await dom.unmount()
  }

  // ---- 静态兜底：别再出现「用了但没定义」的裸标识符
  {
    // 关键函数全部"引用一次"：如果哪个定义被删了，它就会落进下面的 missing 列表。
    // 这一条是拿真事故换来的 —— `switchBar` / `deleteSelected` 被删掉定义之后，
    // renderToString 照样全绿（它不碰事件处理函数），只有真人点一下才炸。
    const guarded = 'var __guard = function(){'
      + 'return [' + [
        'switchBar', 'deleteSelected', 'toggleSelectedHidden', 'undoDrawing', 'clearDrawings', 'switchEnv',
        'bodyOf', 'roundBox', 'paintLine', 'paintFib', 'paintMeasure', 'drawChart', 'hitCandle', 'hitDrawing',
        'moveDrawing', 'withDrawingIds', 'nextDrawId', 'measureStats', 'hitTolerance', 'snapPriceToOhlc',
        'snapToViewOhlc', 'ohlcLabelOf', 'timeTicks', 'tickStepHours', 'closeCountdown', 'fmtCountdown', 'fmtDur', 'fmtAgo',
        'useTick', 'ico', 'viewWindow', 'priceRange', 'plotBox', 'pointerToData', 'windowOf', 'panView',
        'zoomView', 'indexFrac', 'tsAtIndex', 'emaFor', 'emaWindow', 'clampNum', 'clampInt', 'digitsOf',
        'emaLegendItems', 'legendRowKey', 'legendVisible', 'legendRect', 'legendHit',
      ].join(', ') + '];};\n'
    const called = new Set()
    for (const m of (guarded + CLIENT_SOURCE_CODE).matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[2])
    const defined = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
      'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'case', 'break', 'continue',
      'instanceof', 'yield', 'await', 'async', 'class', 'extends', 'super', 'this', 'null', 'true', 'false',
      'undefined', 'NaN', 'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean',
      'Object', 'Array', 'Math', 'Date', 'JSON', 'Map', 'Set', 'Promise', 'Error', 'RegExp', 'Symbol',
      'Infinity', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'requestAnimationFrame', 'getComputedStyle', 'ResizeObserver', 'Uint8Array', 'min', 'max',
      // 下面这些是字符串里的 CSS 函数（如 grid-template-columns: repeat(4,minmax(0,1fr))），
      // 不是 JS 调用 —— 源码扫描不区分字符串，会误报，所以按白名单放行。
      'minmax', 'repeat',
      'not', 'rgba', 'rgb', 'hsl', 'calc', 'rotate', 'translateX', 'translateY', 'scale', 'var', 'url',
      'min', 'max', 'clamp', 'linear-gradient', 'cubic-bezier'])
    for (const m of CLIENT_SOURCE_CODE.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1])
    for (const m of CLIENT_SOURCE_CODE.matchAll(/var\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1])
    for (const m of CLIENT_SOURCE_CODE.matchAll(/function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
      for (const p of m[1].split(',')) { const t = p.trim().split(/[=\s]/)[0]; if (t) defined.add(t) }
    }
    for (const m of CLIENT_SOURCE_CODE.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) defined.add(m[1])
    for (const name of ['useState', 'useRef', 'useEffect', 'createElement']) defined.add(name)
    defined.add('encodeURIComponent')
    defined.add('decodeURIComponent')
    defined.add('ema') // README 里提到的函数名，注释中会出现
    const missing = Array.from(called).filter((name) => !defined.has(name)).sort()
    check(missing.length === 0, '没有「调用了一个不存在的函数」的写法', missing.join(', '))
  }

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

// ---------------------------------------------------------------- 4.9) 悬浮两档 / 尺子 / 吸附
{
  const d = mod.debug
  const failedBefore = failed

  // ---- 悬浮两档：压中 K 线才弹数据框，空白处只给鼠标价格
  {
    const board = makeBoard(240)
    const candles = board.candles
    const made = makeCanvas(900, 380)
    const box = d.plotBox(made.canvas, candles.length)
    const range = d.priceRange(candles, board.lines)
    const span = range.hi - range.lo
    const xOf = function (i) { return 8 + box.step * i + box.step / 2 }
    const yOf = function (p) { return box.priceTop + box.priceH - ((p - range.lo) / span) * box.priceH }
    let pick = 0
    for (let i = 200; i < 240; i += 1) {
      if (Math.abs(candles[i][1] - candles[i][4]) > Math.abs(candles[pick][1] - candles[pick][4])) pick = i
    }
    const row = candles[pick]
    const bodyY = (yOf(row[1]) + yOf(row[4])) / 2
    const blankY = yOf(row[2]) - (d.hitTolerance(box.step) + 12)
    check(d.hitCandle(box, range, candles, pick, xOf(pick), bodyY) === true, '指针压在实体里 → 命中（弹数据框）')
    check(d.hitCandle(box, range, candles, pick, xOf(pick), blankY) === false,
      '指针在同一列但离 K 线很远的空白处 → 不命中（只给鼠标价格）',
      'blankY=' + blankY.toFixed(1) + ' 实体顶=' + Math.min(yOf(row[1]), yOf(row[4])).toFixed(1))
    check(d.hitCandle(box, range, candles, pick, xOf(pick), 0) === false, '指针在图区上方的空白处 → 不命中')
    // 缩得很小时容差要放宽，否则 0.6px 宽的实体点不中
    const wide = { step: 6, priceTop: box.priceTop, priceH: box.priceH }
    check(d.CANDLE_HIT_PX === 3, '基础容差是 3px', String(d.CANDLE_HIT_PX))
    check(d.hitTolerance(6) === d.CANDLE_HIT_PX, '正常宽度（每根 6px）用基础容差', String(d.hitTolerance(6)))
    check(d.hitTolerance(0.6) < d.CANDLE_HIT_PX && d.hitTolerance(0.6) >= 1,
      '缩到每根 0.6px 时横向余量收到半个格子（免得吃进隔壁几根）', String(d.hitTolerance(0.6)))
    check(d.hitTolerance(0) === d.CANDLE_HIT_PX, 'step 缺失时退回基础容差', String(d.hitTolerance(0)))
    check(d.hitCandle(wide, range, candles, pick, xOf(pick), bodyY) === true, '宽窗口下正常命中')
  }

  // ---- 吸附：把鼠标价格吸到最近的 OHLC
  {
    const candles = [[1780000000000, 100, 110, 90, 105, 10, 1], [1780000000000 + 900000, 105, 120, 100, 118, 10, 1]]
    const yOf = function (p) { return 1000 - p * 5 } // 每 1 块钱 5px
    check(d.snapPriceToOhlc(candles, 0, 110.5, yOf, 8) === 110, '吸到最近的"高"')
    check(d.snapPriceToOhlc(candles, 0, 104, yOf, 8) === 105, '吸到最近的"收"')
    check(d.snapPriceToOhlc(candles, 0, 100.4, yOf, 8) === 100, '吸到最近的"开"')
    check(d.snapPriceToOhlc(candles, 1, 121, yOf, 8) === 120, '邻根的高也算进来', String(d.snapPriceToOhlc(candles, 1, 121, yOf, 8)))
    check(d.snapPriceToOhlc(candles, 0, 116, yOf, 3) === null, '超出容差就不吸（用鼠标原始价格）')
    check(d.snapPriceToOhlc(candles, 0, NaN, yOf, 8) === null, '非数字价格 → null')
    check(d.snapPriceToOhlc([], 0, 100, yOf, 8) === null, '空数据 → null')
    check(d.ohlcLabelOf(candles[0], 110) === '高', '能说清吸到了哪个价', d.ohlcLabelOf(candles[0], 110))
    check(d.ohlcLabelOf(candles[0], 105) === '收', '收也认得', d.ohlcLabelOf(candles[0], 105))
    check(d.ohlcLabelOf(null, 105) === '吸附', '拿不到 K 线时不崩')
  }

  // ---- 吸附的窗口下标基准：窗口内下标要落到「窗口里那几根」上
  //
  // 真事故：Chart 的 board.candles 是窗口切片（默认 180 根），pointerToData 给的是窗口内下标，
  // 但吸附拿的是全量序列（720 根）配这个下标 —— 整体偏了 540 根，吸到的是几百根前的价位，
  // 超出 8px 容差就永远返回 null。用户看到的就是"工具条上的吸附按了跟没按一样"。
  {
    // 价格故意用整数、每 10 块一档，yOf 放大到 50px/档，方便断言"吸到了哪一档"
    const candles = []
    for (let i = 0; i < 720; i += 1) {
      const base = 10000 + i * 10
      candles.push([1780000000000 + i * 900000, base, base + 30, base - 30, base + 10, 1, 1])
    }
    const yOf = function (p) { return 50000 - p * 5 } // 每 10 块 = 50px
    const win = { start: 540, end: 720 }
    const cases = [[0, 1, '开'], [100, 2, '高'], [179, 3, '低'], [37, 4, '收']]
    for (const [wi, k, label] of cases) {
      const row = candles[win.start + wi]
      const hit = d.snapToViewOhlc(candles, win, wi, row[k], yOf, d.SNAP_PX)
      check(hit !== null && hit.price === row[k] && hit.index === win.start + wi,
        '窗口第 ' + wi + ' 根：吸到窗口里那根（全量第 ' + (win.start + wi) + ' 根）自己',
        JSON.stringify(hit))
      check(hit !== null && hit.label === label, '窗口第 ' + wi + ' 根：标签说明吸到「' + label + '」',
        hit === null ? 'null' : hit.label)
    }
    // 指针在两根 OHLC 中间（离最近档 15px > 8px）→ 不吸
    const row = candles[640]
    const far = d.snapToViewOhlc(candles, win, 100, row[2] + 3, yOf, d.SNAP_PX)
    check(far === null, '超出容差 → 不吸（用鼠标原始价格）', JSON.stringify(far))
    // 小数下标：窗口里指针可以落在两根之间，四舍五入到最近那根
    const round = d.snapToViewOhlc(candles, win, 100.49, candles[640][2], yOf, d.SNAP_PX)
    check(round !== null && round.index === 640, '小数下标四舍五入到最近的那根', JSON.stringify(round))
    // win 缺失时按起点 0 处理（纯函数自洽；Chart 永远会传 win）
    const noWin = d.snapToViewOhlc(candles.slice(540), null, 100, candles[640][2], yOf, d.SNAP_PX)
    check(noWin !== null && noWin.index === 100, '没有窗口信息时按起点 0 处理', JSON.stringify(noWin))
  }

  // ---- 尺子：价格差 / 涨跌比例 / 时长 / 根数
  {
    const BAR = 900000 // 15m
    const up = { kind: 'measure', t1: 1780000000000, p1: 80000, t2: 1780000000000 + BAR * 12, p2: 81200 }
    const stats = d.measureStats(up, BAR)
    check(stats !== null && stats.rise === 1200, '价格差 = p2 - p1', JSON.stringify(stats && stats.rise))
    check(Math.abs(stats.pct - 1.5) < 1e-9, '涨跌比例 = 差 / p1', String(stats.pct))
    check(stats.up === true, '涨用 ▲ + 绿色')
    check(stats.bars === 13, '跨 12 根 + 自身 = 13 根', String(stats.bars))
    check(stats.ms === BAR * 13, '时长按"起点开盘 → 终点开盘 + 一个周期"算', String(stats.ms))
    check(d.fmtDur(stats.ms) === '3h15m', '时长说成人话', d.fmtDur(stats.ms))
    const down = d.measureStats({ kind: 'measure', t1: 1000, p1: 81000, t2: 1000 + BAR, p2: 80190 }, BAR)
    check(down.rise === -810 && down.up === false, '跌的方向也对', JSON.stringify([down.rise, down.up]))
    check(Math.abs(down.pct + 1) < 1e-9, '跌幅 -1%', String(down.pct))
    check(down.bars === 2, '相邻两根 = 2 根')
    const noBar = d.measureStats(up, 0)
    check(noBar.bars === null && noBar.ms === null, '拿不到周期就不给时长/根数', JSON.stringify([noBar.bars, noBar.ms]))
    check(d.measureStats({ p1: 0, p2: 10, t1: 0, t2: 0 }, BAR).pct === null, 'p1 = 0 时不给比例（避免除零）')
    check(d.measureStats(null, BAR) === null, '空对象 → null')
    check(d.measureStats({ p1: NaN, p2: 1 }, BAR) === null, '非数字 → null')
  }

  // ---- 尺子渲染：画了区间/箭头/标签，且两种方向用不同颜色
  {
    const board = makeBoard(720)
    const candles = board.candles
    const base = { hover: null, following: true, lastIndex: -1 }
    const empty = makeCanvas(900, 380)
    d.drawChart(empty.canvas, board, base)
    const ruler = { id: 'm1', kind: 'measure', t1: candles[500][0], p1: 79500, t2: candles[690][0], p2: 80500 }
    const made = makeCanvas(900, 380)
    d.drawChart(made.canvas, board, Object.assign({ drawings: [ruler] }, base))
    check(made.ctx.calls.stroke > empty.ctx.calls.stroke, '尺子画了斜线/刻度端',
      empty.ctx.calls.stroke + ' → ' + made.ctx.calls.stroke)
    check(made.ctx.calls.fillRect > empty.ctx.calls.fillRect, '尺子画了区间底纹与箭头')
    check(made.ctx.calls.fillText - empty.ctx.calls.fillText >= 2, '尺子写了数据标签（两行）',
      '+' + (made.ctx.calls.fillText - empty.ctx.calls.fillText))
    // 颜色：涨用绿、跌用红（都有 ▲/▼ 兜底，不只靠颜色）
    const colors = new Set()
    const seen = []
    const canvas = makeCanvas(900, 380)
    canvas.ctx.fillRect = function () { colors.add(canvas.ctx.fillStyle) }
    canvas.ctx.fillText = function (text) { seen.push(String(text)) }
    d.drawChart(canvas.canvas, board, Object.assign({ drawings: [ruler] }, base))
    check(colors.has('#16c784'), '上涨的尺子用绿色', JSON.stringify(Array.from(colors)))
    check(seen.some((t) => t.indexOf('▲') === 0), '标签里有 ▲ 与正数', seen.filter((t) => t.indexOf('▲') === 0 || t.indexOf('▼') === 0).join(' | '))
    const downRuler = { id: 'm2', kind: 'measure', t1: candles[500][0], p1: 80500, t2: candles[690][0], p2: 79500 }
    const canvas2 = makeCanvas(900, 380)
    const colors2 = new Set()
    const seen2 = []
    canvas2.ctx.fillRect = function () { colors2.add(canvas2.ctx.fillStyle) }
    canvas2.ctx.fillText = function (text) { seen2.push(String(text)) }
    d.drawChart(canvas2.canvas, board, Object.assign({ drawings: [downRuler] }, base))
    check(colors2.has('#ea3943'), '下跌的尺子用红色', JSON.stringify(Array.from(colors2)))
    check(seen2.some((t) => t.indexOf('▼') === 0), '标签里有 ▼ 与负数', seen2.filter((t) => t.indexOf('▼') === 0).join(' | '))
    // 预览（还没松手）也要画
    const previewCanvas = makeCanvas(900, 380)
    d.drawChart(previewCanvas.canvas, board, Object.assign({ drawings: [], preview: ruler }, base))
    check(previewCanvas.ctx.calls.stroke > empty.ctx.calls.stroke, '拖动中的尺子预览也画出来')
    // 残缺数据不能炸
    let threw = null
    try {
      d.drawChart(makeCanvas(900, 380).canvas, board, Object.assign({
        drawings: [{ kind: 'measure' }, null, { kind: 'measure', p1: 1, p2: 2, t1: 0, t2: 0 }],
      }, base))
    } catch (error) { threw = error }
    check(threw === null, '残缺的尺子数据不抛错', threw === null ? '' : String(threw.message))
  }

  // ---- 画线命中：尺子也要能被选中（线身 + 端点）
  {
    const geom = {
      of: (ts, price) => ({ x: ts / 10, y: 1000 - price / 100 }),
      y: (price) => 1000 - price / 100,
    }
    const rulers = [{ id: 'r1', kind: 'measure', t1: 100, p1: 80000, t2: 300, p2: 81000 }]
    check(d.hitDrawing(geom, rulers, 10, 200).part === 'a', '尺子起点可点中')
    check(d.hitDrawing(geom, rulers, 30, 190).part === 'b', '尺子终点可点中')
    check(d.hitDrawing(geom, rulers, 20, 195).part === 'body', '尺子斜线可点中（之后能整条拖动）')
    check(d.hitDrawing(geom, rulers, 20, 260) === null, '离尺子远 → 不命中')
  }

  // ---- 面板：尺子工具 + 吸附开关都在
  {
    const panelHtml = renderToString(React.createElement(overlay.component), { intl: true })
    check(panelHtml.indexOf('尺子') >= 0, '工具条里有「尺子」')
    check(panelHtml.indexOf('吸附') >= 0, '工具条里有「吸附」开关')
    check(panelHtml.indexOf('价格差、涨跌比例、时长') >= 0, '尺子的说明写清了量什么')
    check((CLIENT_SOURCE_CODE.match(/function paintMeasure\(/g) || []).length === 1, 'paintMeasure 只定义一次')
    check((CLIENT_SOURCE_CODE.match(/function paintFib\(/g) || []).length === 1, 'paintFib 只定义一次')
  }

  // ---- 工具条外观：画线光标 + 分组标签的行内对齐
  //
  // 注意：CSS 是运行期拼出来的（`.btcd-drawmode{cursor:' + CURSOR_CROSS + '}`），
  // 所以要看的是**拼完之后的那份样式表**，而不是源码里的字面量。
  {
    const builtCss = buildPluginCss()
    check(builtCss !== null && builtCss.length > 3000, '能拼出插件的完整样式表',
      builtCss === null ? 'null' : String(builtCss.length) + ' 字符')
    if (builtCss !== null) {
      // 画布上**所有状态**都是黑色十字：默认、拖动中、画线中
      const canvasRule = /\.btcd-canvas\{([^}]*)\}/.exec(builtCss)
      check(canvasRule !== null, '有 .btcd-canvas 规则')
      const cursorMatch = /\.btcd-canvas\.btcd-drawmode\{cursor:([^}]*)\}/.exec(builtCss)
      check(cursorMatch !== null, '有 .btcd-drawmode 的光标规则')
      if (cursorMatch !== null) {
        const value = cursorMatch[1]
        check(value.indexOf('data:image/svg+xml') >= 0, '光标是自绘的（data URI）', value.slice(0, 50))
        check(value.indexOf('%23000000') >= 0, '十字是黑色')
        check(value.indexOf('%23ffffff') < 0, '没有白色描边（需求要纯黑）')
        check(value.indexOf(', crosshair') >= 0, '最后带 crosshair 兜底关键字')
        check(value.indexOf(') 6 6,') >= 0, '热点设在十字交点上')
      }
      if (canvasRule !== null) {
        const defaultCursor = /cursor:([^;]*)/.exec(canvasRule[1])
        check(defaultCursor !== null && defaultCursor[1].indexOf('data:image/svg+xml') >= 0,
          '默认状态就是自绘光标（不是 grab）', String(defaultCursor === null ? '?' : defaultCursor[1].slice(0, 50)))
        check(defaultCursor !== null && cursorMatch !== null && defaultCursor[1] === cursorMatch[1],
          '默认状态与画线状态的光标完全一致（所有状态都是同一个黑十字）')
      }
      check(builtCss.indexOf('cursor:grab') < 0 && builtCss.indexOf('cursor:grabbing') < 0,
        '样式表里已经不剩 grab / grabbing（拖动中也不再换手型）')
      // 标签：固定高度/行高/最小宽度 + 居中，保证两行工具条基线一致、标签左右对齐
      const lblMatch = /\.btcd-lbl\{([^}]*)\}/.exec(builtCss)
      check(lblMatch !== null, '有 .btcd-lbl 标签样式')
      if (lblMatch !== null) {
        const body = lblMatch[1]
        for (const need of ['display:inline-flex', 'align-items:center', 'justify-content:center',
          'line-height:22px', 'height:22px', 'min-width:26px', 'white-space:nowrap']) {
          check(body.indexOf(need) >= 0, '标签样式含 ' + need)
        }
      }
      // 样式表不能被光标的 data URI 截断：几条关键规则都要在
      const rules = (builtCss.match(/\{/g) || []).length
      check(rules >= 60, '样式表规则数量正常（没被 data URI 里的引号截断）', String(rules) + ' 条')
      check(builtCss.indexOf('.btcd-tool{') >= 0 && builtCss.indexOf('.btcd-toast{') >= 0, '末尾的规则都还在')
    }
    // 文案：第二个分组标签叫「工具」；三个标签走同一个样式类（不再各写 inline style，才会对齐）
    const panelHtml2 = renderToString(React.createElement(overlay.component), { intl: true })
    check(panelHtml2.indexOf('>工具<') >= 0, '分组标签写的是「工具」')
    check(panelHtml2.indexOf('>窗口<') >= 0, '第一个分组标签还是「窗口」')
    const lblCount = (CLIENT_SOURCE_CODE.match(/className: 'btcd-lbl'/g) || []).length
    check(lblCount >= 3, '三个分组标签都走同一个样式类', String(lblCount) + ' 处')
  }

  // ---- 画完一条就退出工具（一次一个，不连续绘）
  //
  // 这条行为在 Chart 的 pointer 事件里，所以真的渲染 Chart、真的拖一把。
  // 必须在上面那个 jsdom 作用域里做：jsdom 的全局要先装好，React 才收得到事件。
  const dom2 = createInteractiveDom()
  if (dom2 === null) {
    console.log('     跳过「画完即退出」测试：环境里找不到 jsdom')
  } else {
    const chart = dom2.module().debug.Chart
    const board = makeBoard(720)
    const candles = board.candles
    const chartProps = function (tool) {
      return {
        candles: candles,
        // 画这条测试不关心均线，给空列表就行（Chart 不再自己算均线，由 Dashboard 传进来）
        lines: [],
        barMs: 900000,
        view: { size: 180, rightTs: null },
        tool: tool,
        levels: [0, 0.5, 1],
        drawings: [],
        snap: false, // 关掉吸附，量出来的价格就是鼠标位置，断言好写
        lastIndex: candles.length - 1,
        lastPrice: candles[candles.length - 1][4],
      }
    }

    const h = dom2.render(chart, chartProps('measure'))
    check(h.canvas() !== null, 'Chart 渲染出了 canvas',
      h.canvas() === null ? 'host.innerHTML=' + JSON.stringify(String(h.hostHtml()).slice(0, 200)) : 'ok')
    check(dom2.errors().length === 0, 'Chart 渲染不抛错', dom2.errors().join(' | '))
    check(h.canvas().getAttribute('tabindex') === '0', 'Chart 的 canvas 可聚焦',
      String(h.canvas().getAttribute('tabindex')))
    check(h.canvasClass().indexOf('btcd-drawmode') >= 0, '选了工具时 canvas 带画线光标类', h.canvasClass())

    // 拖一把 = 画一条尺子
    h.pointer('pointerdown', 200, 120, 1)
    h.pointer('pointermove', 330, 190, 1)
    h.pointer('pointermove', 470, 265, 1)
    h.pointer('pointerup', 470, 265, 0)
    check(h.added().length === 1, '拖动后提交了一条画线', String(h.added().length) + ' 条')
    if (h.added().length === 1) {
      check(h.added()[0].kind === 'measure', '提交的是尺子', h.added()[0].kind)
      check(h.added()[0].p1 !== h.added()[0].p2, '两端价格不同（真的量出了一段）',
        String(h.added()[0].p1) + ' → ' + String(h.added()[0].p2))
      check(typeof h.added()[0].id === 'string' && h.added()[0].id !== '', '带上 id（能单独选中/删除）')
    }
    check(h.toolDoneCount() === 1, '画完立刻通知「工具收工」（自动回到平移）',
      String(h.toolDoneCount()) + ' 次')

    // 只点一下（没拖动）不算画完：不该提交，也不该退出工具
    h.pointer('pointerdown', 300, 150, 1)
    h.pointer('pointerup', 300, 150, 0)
    check(h.added().length === 1, '只点一下不产生画线', String(h.added().length) + ' 条')
    check(h.toolDoneCount() === 1, '只点一下不触发「工具收工」', String(h.toolDoneCount()) + ' 次')
    check(dom2.errors().length === 0, '整段拖动过程中没有页面级异常', dom2.errors().join(' | '))

    // 对照：平移模式下拖动 = 平移视图，不画东西
    const h2 = dom2.render(chart, chartProps('none'))
    h2.pointer('pointerdown', 400, 150, 1)
    h2.pointer('pointermove', 250, 150, 1)
    h2.pointer('pointerup', 250, 150, 0)
    check(h2.added().length === 0, '平移模式下拖动不产生画线')
    check(h2.viewCount() > 0, '平移模式下拖动改变了视图', String(h2.viewCount()) + ' 次')
    check(h2.canvasClass().indexOf('btcd-drawmode') < 0, '平移模式下不带画线光标类', h2.canvasClass())
    h.destroy()
    h2.destroy()

    // ---- 吸附（端到端）：默认窗口只显示最后 180 根（全量 720），拖到某根 OHLC 上要真吸上去
    //
    // 回归：早先 shapePoint 拿「窗口内下标」去全量序列里取行，整体偏了 `win.start` 根 ——
    // 对窗口内每根 OHLC 正对着鼠标，吸附命中率都是 0%，所以工具条上的「吸附」看起来毫无作用。
    {
      const board720 = makeBoard(720)
      const cs = board720.candles
      const winStart = cs.length - 180
      const winCs = cs.slice(winStart)
      const snapProps = function (snap) {
        return {
          candles: cs, lines: [], barMs: 900000,
          view: { size: 180, rightTs: null },
          tool: 'measure', levels: [0, 0.5, 1], drawings: [],
          snap: snap, lastIndex: cs.length - 1, lastPrice: cs[cs.length - 1][4],
        }
      }
      const setup = function (snap) {
        const handle = dom2.render(chart, snapProps(snap))
        const cvs = handle.canvas()
        const box = d.plotBox(cvs, winCs.length)
        const range = d.priceRange(winCs, [])
        const span = range.hi - range.lo || 1
        return {
          handle: handle,
          yOf: function (p) { return box.priceTop + box.priceH - ((p - range.lo) / span) * box.priceH },
          priceAt: function (y) { return range.lo + (1 - (y - box.priceTop) / box.priceH) * span },
          xOf: function (i) { return 8 + box.step * i + box.step / 2 }, // PAD_LEFT = 8
        }
      }
      const wi = 100
      const full = winStart + wi
      const row = cs[full]
      check(winStart > 0, '这份板子确实有窗口偏移（不然这条测试证明不了什么）', String(winStart))
      // 窗口里所有 OHLC 的集合：吸附成功时终点必须是其中一个；没吸上则是鼠标原始价（几乎不可能落在这里）
      const windowOhlc = new Set()
      for (const c of winCs) for (let k = 1; k <= 4; k += 1) windowOhlc.add(Number(c[k]))
      // 针尖故意离「高」差 5px（在 8px 容差内，但绝不是 OHLC 本身）：
      // 吸上 → p2 变成某个 OHLC；没吸上 → p2 是鼠标原始价。两者用浮点巧合也分得开。
      const yNear = function (setupFor) { return setupFor.yOf(row[2]) + 5 }

      // 开：同样的针尖位置，终点要变成窗口里某个 OHLC
      const on = setup(true)
      const rawOn = on.priceAt(yNear(on))
      on.handle.pointer('pointerdown', on.xOf(wi - 20), on.yOf(cs[full - 20][4]), 1)
      on.handle.pointer('pointermove', on.xOf(wi), yNear(on), 1)
      on.handle.pointer('pointerup', on.xOf(wi), yNear(on), 0)
      check(on.handle.added().length === 1, '吸附开：拖动产生一条画线', String(on.handle.added().length) + ' 条')
      if (on.handle.added().length === 1) {
        const p2 = on.handle.added()[0].p2
        check(windowOhlc.has(p2),
          '吸附开：终点变成窗口里某根 K 线的 OHLC（修前这里是鼠标原始价 → 按钮看起来没作用）',
          String(p2) + ' 原始价=' + String(rawOn))
        check(p2 !== rawOn, '吸附开：终点不再是鼠标原始价格', String(p2) + ' vs ' + String(rawOn))
      }
      check(dom2.errors().length === 0, '吸附开：拖动过程没有页面级异常', dom2.errors().join(' | '))
      on.handle.destroy()

      // 关：**同一个位置**，终点就是鼠标的精确价格
      const off = setup(false)
      const rawOff = off.priceAt(yNear(off))
      off.handle.pointer('pointerdown', off.xOf(wi - 20), off.yOf(cs[full - 20][4]), 1)
      off.handle.pointer('pointermove', off.xOf(wi), yNear(off), 1)
      off.handle.pointer('pointerup', off.xOf(wi), yNear(off), 0)
      check(off.handle.added().length === 1, '吸附关：拖动也产生一条画线', String(off.handle.added().length) + ' 条')
      if (off.handle.added().length === 1) {
        check(Math.abs(off.handle.added()[0].p2 - rawOff) < 1e-6, '吸附关：终点落在鼠标的精确价格',
          String(off.handle.added()[0].p2) + ' vs ' + String(rawOff))
      }
      off.handle.destroy()
    }
    await dom2.unmount()
  }

  // ---- 整面板回归：**在画布上点图例**，均线真的要隐藏/恢复
  //
  // 这条是拿用户反馈换来的："画布中的图例，点击隐藏打开失效"。
  // 前面那些图例测试都是直接渲染 <Chart> 并喂 props，绕过了 Dashboard 那一层
  // （画布上的 `onToggleEma` 实际接到 `drawApiRef.current.toggleEma`），所以没抓到。
  {
    const dom7 = createInteractiveDom()
    if (dom7 === null) {
      console.log('     跳过「整面板点画布图例」测试：环境里找不到 jsdom')
    } else {
      await dom7.mount()
      const docEl = dom7.container().ownerDocument
      const canvas = docEl.querySelector('canvas')
      check(canvas !== null, '整面板里有画布')
      // 诊断：这个 canvas 到底挂在哪个 React root 下？页面上一共几个 canvas / .btcd-panel？
      check(canvas.isConnected === true, 'canvas 还在文档里')
      check(docEl.querySelectorAll('canvas').length === 1, '页面上只有一个 canvas',
        String(docEl.querySelectorAll('canvas').length))
      check(docEl.querySelectorAll('.btcd-panel').length === 1, '页面上只有一个面板',
        String(docEl.querySelectorAll('.btcd-panel').length))
      check(docEl.querySelectorAll('.btcd-emapanel-row').length >= 0, '可以读到管理行')
      const box = d.plotBox(canvas, 180)
      const rect = d.legendRect(8, box.priceTop, 2)
      const rowY = function (row) { return rect.y + d.LEGEND.padY + d.LEGEND.height * row + d.LEGEND.height / 2 }
      const clickLegend = function (row) {
        const x = rect.x + 6
        const y = rowY(row)
        for (const type of ['pointerdown', 'pointerup']) {
          const ev = new dom7.window.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0,
            clientX: x, clientY: y,
          })
          ev.pointerId = 1
          ev.pointerType = 'mouse'
          // flushSync：点击引起的 setState 在 React 18 里是异步提交的，断言前必须逼它同步落盘
          dom7.flushSync(function () { canvas.dispatchEvent(ev) })
        }
      }
      const panelStates = function () {
        return Array.prototype.map.call(docEl.querySelectorAll('.btcd-emapanel-row'), (r) => {
          const bs = r.querySelectorAll('button.btcd-mini')
          return bs.length === 0 ? '?' : bs[0].textContent
        })
      }

      // 工具条上不再逐条列均线（唯一的逐条入口就是画布图例）
      check(docEl.querySelectorAll('.btcd-ema').length === 0,
        '工具条不再逐条列均线', String(docEl.querySelectorAll('.btcd-ema').length) + ' 个条目')

      // 打开管理看板（读状态用；逐条显隐本身是画布图例的活）
      const manageBtn = (function () {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('均线管理') === 0) return b
        }
        return null
      })()
      check(manageBtn !== null, '有「均线管理」按钮')
      dom7.click(manageBtn)
      check(panelStates().join(',') === '显示中,显示中', '初始两条都显示', JSON.stringify(panelStates()))

      // 点画布图例第 0 行 → 第 0 条隐藏
      clickLegend(0)
      check(panelStates().join(',') === '已隐藏,显示中', '点画布图例第 0 行 → 第 0 条隐藏',
        JSON.stringify(panelStates()) + ' | 页面异常=' + JSON.stringify(dom7.errors()))
      // 再点一次 → 恢复（这就是"点击隐藏打开失效"的那一步）
      clickLegend(0)
      check(panelStates().join(',') === '显示中,显示中', '再点一次 → 恢复显示（"打开失效"的那一步）',
        JSON.stringify(panelStates()))
      // 第 1 行也要能点，且不能串行
      clickLegend(1)
      check(panelStates().join(',') === '显示中,已隐藏', '点第 1 行 → 第 1 条隐藏（行号不串）',
        JSON.stringify(panelStates()))
      clickLegend(1)
      check(panelStates().join(',') === '显示中,显示中', '第 1 条也能恢复', JSON.stringify(panelStates()))

      check(dom7.errors().length === 0, '整段点图例过程中没有页面级异常', dom7.errors().join(' | '))
      await dom7.unmount()
    }
  }

  // ---- 整面板：均线的增 / 删 / 改真的能点（真渲染 + 点真按钮）
  {
    const dom5 = createInteractiveDom()
    if (dom5 === null) {
      console.log('     跳过「均线增删改」整面板测试：环境里找不到 jsdom')
    } else {
      const panel = await dom5.mount()
      check(panel !== null, '面板渲染出来了')

      const containerEl = dom5.container()
      check(containerEl !== null, '面板容器在')
      // 查 DOM 统一用 document 而不是 containerEl：浮层历史上用过 portal 渲染
      // （`containerEl.contains(panel)` 曾为 false）；现在虽挂在同一个 root 下，
      // 用 document 查不依赖这个实现细节，更稳（踩过：面板明明在页面上却"查不到"）。
      const docEl = containerEl.ownerDocument
      const findButton = function (text) {
        const all = docEl.querySelectorAll('button')
        for (const b of all) if (b.textContent.indexOf(text) >= 0) return b
        return null
      }
      const findButtonExact = function (text) {
        const all = docEl.querySelectorAll('button')
        for (const b of all) if (b.textContent.trim() === text) return b
        return null
      }
      // 只算**真实的均线行**：空列表时看板里也会有一个 .btcd-emapanel-row 占位提示，
      // 那个不算一条均线（踩过：把它算进去，"全删光"永远不成立）。
      const emaRows = function () {
        return Array.prototype.filter.call(
          docEl.querySelectorAll('.btcd-emapanel-row'),
          (r) => r.querySelector('.btcd-period') !== null)
      }
      const hasEmptyHint = function () {
        return docEl.body.textContent.indexOf('一条均线都没有') >= 0
      }
      const rowPeriods = function () {
        return Array.prototype.map.call(docEl.querySelectorAll('.btcd-emapanel-row .btcd-period'), (i) => i.value)
      }
      const rowStates = function () {
        return Array.prototype.map.call(emaRows(), (r) => {
          const bs = r.querySelectorAll('button.btcd-mini')
          return bs.length === 0 ? '?' : bs[0].textContent
        })
      }

      // 工具条上只有**一个**「均线管理」按钮（逐条显隐在画布图例上，增删改在看板里）
      check(docEl.querySelectorAll('.btcd-ema').length === 0, '工具条不逐条列均线',
        String(docEl.querySelectorAll('.btcd-ema').length) + ' 个条目')
      const manageBtn = findButtonExact('均线管理（2）')
      check(manageBtn !== null, '工具条上有一个「均线管理」按钮（带条数）',
        Array.prototype.map.call(docEl.querySelectorAll('button'), (b) => b.textContent.trim())
          .filter((t) => t.indexOf('均线') >= 0).join(' | '))

      // 点它 → 打开管理看板，默认两条 20 / 480
      dom5.click(manageBtn)
      check(emaRows().length === 2, '默认两条均线', String(emaRows().length))
      check(rowPeriods().join(',') === '20,480', '默认周期就是 20 与 480', JSON.stringify(rowPeriods()))
      check(rowStates().join(',') === '显示中,显示中', '默认两条都显示', JSON.stringify(rowStates()))
      const dotBg = Array.prototype.map.call(
        docEl.querySelectorAll('.btcd-emapanel-row .btcd-ema-dot-lg'),
        (el) => el.style.background)
      check(dotBg.length === 2 && dotBg[0] !== dotBg[1], '两条的颜色不同', JSON.stringify(dotBg))

      // 新增：按钮在**看板里**（不再单独占一个工具条按钮）
      const addBtn = findButtonExact('＋ 新增')
      check(addBtn !== null, '看板右上角有「＋ 新增」')
      dom5.click(addBtn)
      check(emaRows().length === 3, '点「＋ 新增」后变成三条', String(emaRows().length))
      check(rowPeriods()[0] === '20' && rowPeriods()[1] === '480', '原来两条还在', JSON.stringify(rowPeriods()))
      check(new Set(rowPeriods()).size === 3, '新增的周期跟原来两条不重复', JSON.stringify(rowPeriods()))
      check(findButtonExact('均线管理（3）') !== null, '工具条上的条数跟着更新')

      // 「均线管理」是切换：点一下收起，再点一下打开
      dom5.click(findButtonExact('均线管理（3）'))
      check(emaRows().length === 0, '再点「均线管理」→ 看板收起')
      dom5.click(findButtonExact('均线管理（3）'))
      check(emaRows().length === 3, '再点一次 → 看板又打开', String(emaRows().length))
      // Esc 也能收看板（按钮 tooltip 里这么写的，就得真支持）
      dom5.key('Escape')
      check(emaRows().length === 0, 'Esc 收起均线看板', String(emaRows().length))
      check(docEl.querySelector('.btcd-panel') !== null, 'Esc 只收看板，不关整个面板')
      dom5.click(findButtonExact('均线管理（3）'))
      check(emaRows().length === 3, '再打开继续后面的用例', String(emaRows().length))

      // 改周期：早先这个 harness 里浮层内的 input 触发不了 React 的 onChange
      // （当时以为怪 portal，真正原因是 react-dom 在 jsdom 全局装好之前就被 require —— 已修，
      // 见 createInteractiveDom 的注释）。这里仍不去改输入框：后面的断言依赖当前周期值
      // （20 / 480 / 10），改周期后的**效果**由 `emaUpdate` 单测覆盖。
      const periodInputs = docEl.querySelectorAll('.btcd-emapanel-row .btcd-period')
      check(periodInputs.length === 3, '每行一个有周期输入框', String(periodInputs.length))
      check(String(periodInputs[0].value) === '20', '第一个输入框里是 20', String(periodInputs[0].value))
      check(periodInputs[2].value === '10', '第三行是新增那条的周期 10', String(periodInputs[2].value))
      check(periodInputs[0].getAttribute('inputmode') === 'numeric', '输入框是数字键盘',
        String(periodInputs[0].getAttribute('inputmode')))

      // 每行都能单独显示/隐藏（点行内的状态按钮）
      dom5.click(emaRows()[1].querySelector('button.btcd-mini'))
      check(rowStates().join(',') === '显示中,已隐藏,显示中', '点行内状态按钮 → 只隐藏那一条',
        JSON.stringify(rowStates()))
      dom5.click(emaRows()[1].querySelector('button.btcd-mini'))
      check(rowStates().join(',') === '显示中,显示中,显示中', '再点回来', JSON.stringify(rowStates()))

      // 删除第三条
      const delBtn = emaRows()[2].querySelector('button.btcd-danger')
      check(delBtn !== null, '每行有删除按钮')
      dom5.click(delBtn)
      check(emaRows().length === 2, '点删除后回到两条', String(emaRows().length))
      check(rowPeriods().join(',') === '20,480', '删掉的正是新增那条', JSON.stringify(rowPeriods()))

      // 删完只剩两条 → 工具条按钮上的条数要跟着回落
      check(findButtonExact('均线管理（2）') !== null, '工具条按钮上的条数回到 2',
        Array.prototype.map.call(docEl.querySelectorAll('button'), (b) => b.textContent.trim())
          .filter((t) => t.indexOf('均线') >= 0).join(' | '))
      // 全删光也允许：按钮上就不再带条数，看板里提示怎么加回来
      let emptyGuard = 0
      const rowDeleteBtn = function (row) {
        const rowEl = emaRows()[row]
        if (rowEl === undefined) return null
        return rowEl.querySelector('.btcd-danger')
          || (rowEl.lastElementChild !== null && rowEl.lastElementChild.classList.contains('btcd-danger')
            ? rowEl.lastElementChild : null)
      }
      check(rowDeleteBtn(0) !== null, '能定位到第 0 行的删除按钮')
      const delTrace = []
      while (emaRows().length > 0 && emptyGuard < 12) {
        const btn = rowDeleteBtn(0)
        if (btn === null) { delTrace.push('第 ' + String(emptyGuard) + ' 次找不到删除按钮'); break }
        dom5.click(btn)
        emptyGuard += 1
        delTrace.push('删除后剩 ' + String(emaRows().length) + ' 行')
      }
      check(emaRows().length === 0, '可以把均线全删光',
        String(emaRows().length) + ' 行（试了 ' + String(emptyGuard) + ' 次）| ' + delTrace.join(' → '))
      check(hasEmptyHint(), '删光后看板里提示怎么加回来')
      check(findButtonExact('均线管理') !== null, '空列表时按钮不带条数',
        Array.prototype.map.call(docEl.querySelectorAll('button'), (b) => b.textContent.trim())
          .filter((t) => t.indexOf('均线') >= 0).join(' | '))
      // 「恢复默认」把它加回来
      dom5.click(findButtonExact('恢复默认'))
      check(emaRows().length === 2 && rowPeriods().join(',') === '20,480',
        '「恢复默认」加回 EMA20 + EMA480', JSON.stringify(rowPeriods()))
      check(hasEmptyHint() === false, '加回来后空态提示消失')

      check(dom5.errors().length === 0, '整段点按过程中没有页面级异常', dom5.errors().join(' | '))
      await dom5.unmount()
    }
  }

  // ---- 所见即所点：用**实际绘制的文字坐标**反查命中行。
  // 前面那些断言都靠 legendRect 自己算坐标，和实现同源 —— 一旦"画的时候用一套、判命中用另一套"就查不出来。
  // 这条改成：拦截 fillText 拿到图例真画在哪，再用这个 y 去问 legendHit 该命中哪一行。
  {
    const textAt = []
    const canvas = makeCanvas(900, 380)
    canvas.ctx.fillText = function (text, x, y) { textAt.push([String(text), x, y]) }
    const board9 = makeBoard(720)
    // 三条，覆盖"行数 > 2"的情况
    const lines9 = testLines(board9.ema20.slice(540), board9.ema480.slice(540)).concat([
      { item: { id: 'c', period: 120, color: '#4a8cff', show: true }, series: board9.ema20.slice(540) },
    ])
    d.drawChart(canvas.canvas, {
      candles: board9.candles.slice(540), lines: lines9, meta: { barMs: 900000 },
    }, { hover: null, following: true })
    const legendTexts = textAt.filter((t) => t[0].indexOf('EMA') === 0)
    check(legendTexts.length === 3, '图上真的画了三条图例文字', legendTexts.map((t) => t[0]).join(' | '))
    // 每一条文字自己的 y，必须能反查出它自己的行号
    for (let row = 0; row < legendTexts.length; row += 1) {
      const y = legendTexts[row][2]
      const hitRow = d.legendHit(8, 10, legendTexts[row][1], y, 3)
      check(hitRow === row, '第 ' + row + ' 行文字的位置点下去命中第 ' + row + ' 行',
        '文字=' + JSON.stringify(legendTexts[row][0]) + ' y=' + String(y) + ' → 命中 ' + String(hitRow))
    }
    // 命中判定要"取最近一行"：行与行之间的空隙、以及上下边缘之外，都不能串到隔壁行
    const box9 = d.plotBox(canvas.canvas, 180)
    const first = box9.priceTop + d.LEGEND.top + d.LEGEND.padY + d.LEGEND.height / 2
    check(d.legendRowAt(first, box9.priceTop, 3) === 0, '第 0 行中心 → 第 0 行')
    check(d.legendRowAt(first + d.LEGEND.height * 0.4, box9.priceTop, 3) === 0,
      '第 0/1 行之间偏上 → 还是第 0 行')
    check(d.legendRowAt(first + d.LEGEND.height * 0.6, box9.priceTop, 3) === 1,
      '第 0/1 行之间偏下 → 第 1 行')
    check(d.legendRowAt(first + d.LEGEND.height, box9.priceTop, 3) === 1, '第 1 行中心 → 第 1 行')
    // 上下超出行范围也要夹住，不能返回负数或越界（那会让 onToggleEma 收到非法下标）
    check(d.legendRowAt(first - 500, box9.priceTop, 3) === 0, '远远在上方 → 夹到第 0 行')
    check(d.legendRowAt(first + 500, box9.priceTop, 3) === 2, '远远在下方 → 夹到最后一行')
    // 命中区的上下边缘外 3px 仍算命中（贴边点也算），再远就交给平移
    const rect9 = d.legendRect(8, box9.priceTop, 3)
    check(d.legendHit(8, box9.priceTop, rect9.x + 4, rect9.y - 2, 3) === 0, '上边缘外 2px 仍命中')
    check(d.legendHit(8, box9.priceTop, rect9.x + 4, rect9.y + rect9.h + 2, 3) === 2, '下边缘外 2px 仍命中')
    check(d.legendHit(8, box9.priceTop, rect9.x + 4, rect9.y - 30, 3) === -1, '再往上就不算图例了')

    // 悬停高亮：给了 hoverLegendRow 就多画一块底（点到之前能看出会开关谁）
    const hot = makeCanvas(900, 380)
    d.drawChart(hot.canvas, {
      candles: board9.candles.slice(540), lines: lines9, meta: { barMs: 900000 },
    }, { hover: null, following: true, hoverLegendRow: 1 })
    const noHot = makeCanvas(900, 380)
    d.drawChart(noHot.canvas, {
      candles: board9.candles.slice(540), lines: lines9, meta: { barMs: 900000 },
    }, { hover: null, following: true, hoverLegendRow: -1 })
    // 高亮底是 roundBox + fill 画的，所以数 fill 而不是 fillRect
    check(hot.ctx.calls.fill === noHot.ctx.calls.fill + 1, '悬停时多画了一块高亮底',
      noHot.ctx.calls.fill + ' → ' + hot.ctx.calls.fill)
    // 越界的 hoverLegendRow 不该画高亮，也不该抛错
    const badHot = makeCanvas(900, 380)
    d.drawChart(badHot.canvas, {
      candles: board9.candles.slice(540), lines: lines9, meta: { barMs: 900000 },
    }, { hover: null, following: true, hoverLegendRow: 99 })
    check(badHot.ctx.calls.fill === noHot.ctx.calls.fill, '行号越界时不画高亮',
      String(badHot.ctx.calls.fill))
  }

  // ---- 系统扫一遍：**每一行 × 每种条数 × 每种画布尺寸**都要点得动、且不串行。
  // 用户报的是"点 EMA20 没反应 / 点 EMA480 却开关了 EMA20"，这正是行错位的症状 ——
  // 所以这里不再只测一个尺寸，把组合都跑一遍（只挂载一次面板，靠改 canvas 的 clientWidth/Height 换尺寸）。
  {
    const sizes = [[900, 380, '常见'], [600, 300, '小面板'], [1200, 500, '宽面板'], [320, 200, '极窄']]
    const counts = [1, 2, 3, 5]
    const dom8 = createInteractiveDom()
    if (dom8 === null) {
      console.log('     跳过「各尺寸 × 各条数」扫测：环境里找不到 jsdom')
    } else {
      await dom8.mount()
      const docEl = dom8.container().ownerDocument
      const canvas = docEl.querySelector('canvas')
      const bad = []
      let checked = 0
      const findExact = function (text) {
        for (const b of docEl.querySelectorAll('button')) if (b.textContent.trim() === text) return b
        return null
      }
      const boardBtn = function () {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('均线管理') === 0) return b
        }
        return null
      }
      const panelRows = function () {
        return Array.prototype.filter.call(docEl.querySelectorAll('.btcd-emapanel-row'),
          (r) => r.querySelector('.btcd-period') !== null)
      }
      const readShown = function () {
        // 看板本来就开着（下面一直保持打开），直接读行内按钮文本
        return panelRows().map((r) => {
          const mini = r.querySelector('button.btcd-mini')
          return mini !== null && mini.textContent === '显示中' ? '1' : '0'
        })
      }
      // 先打开看板并保持开着（图例在画布左上角，看板是绝对定位的浮层，不挡画布坐标）
      dom8.click(boardBtn())
      for (const [w, h, sizeLabel] of sizes) {
        Object.defineProperty(canvas, 'clientWidth', { value: w, configurable: true })
        Object.defineProperty(canvas, 'clientHeight', { value: h, configurable: true })
        for (const count of counts) {
          while (panelRows().length > count) {
            const last = panelRows()[panelRows().length - 1]
            dom8.click(last.querySelector('.btcd-danger') || last.lastElementChild)
          }
          while (panelRows().length < count) {
            const before = panelRows().length
            dom8.click(findExact('＋ 新增'))
            if (panelRows().length === before) break
          }
          const initial = readShown()
          if (initial.length !== count) {
            bad.push(sizeLabel + '/' + count + ' 条: 只铺出 ' + String(initial.length) + ' 行')
            continue
          }
          const box = d.plotBox(canvas, 180)
          const rect = d.legendRect(8, box.priceTop, count)
          const clickRow = function (row) {
            const y = box.priceTop + d.LEGEND.top + d.LEGEND.padY + d.LEGEND.height * row + d.LEGEND.height / 2
            for (const type of ['pointerdown', 'pointerup']) {
              const ev = new dom8.window.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0,
                clientX: rect.x + 6, clientY: y,
              })
              ev.pointerId = 1
              ev.pointerType = 'mouse'
              dom8.flushSync(function () { canvas.dispatchEvent(ev) })
            }
          }
          const expect = initial.slice()
          for (let row = 0; row < count; row += 1) {
            expect[row] = expect[row] === '1' ? '0' : '1'
            clickRow(row)
            const got = readShown()
            checked += 1
            if (got.join('') !== expect.join('')) {
              bad.push(sizeLabel + '/' + String(count) + ' 条 点第 ' + String(row) + ' 行: 期望 '
                + expect.join('') + ' 实得 ' + got.join(''))
            }
          }
        }
      }
      check(bad.length === 0, '各尺寸 × 各条数：每一行都只开关自己那一条',
        '共验证 ' + String(checked) + ' 次点击（' + String(sizes.length * counts.length) + ' 种组合）| '
        + (bad.length === 0 ? '' : bad.slice(0, 4).join(' ; ')))
      check(dom8.errors().length === 0, '扫测过程中没有页面级异常', dom8.errors().join(' | '))
      await dom8.unmount()
    }
  }

  // ---- 左上角 EMA 图例：画在画布上、可点击开关
  {
    const chart = mod.debug.Chart
    const board = makeBoard(720)
    const candles = board.candles
    const baseProps = function (over) {
      return Object.assign({
        candles: candles, barMs: 900000,
        view: { size: 180, rightTs: null },
        tool: 'none', levels: [0, 0.5, 1], drawings: [], snap: false,
        lastIndex: candles.length - 1, lastPrice: candles[candles.length - 1][4],
      }, over || {})
    }

    // ---- 几何：命中区与命中行（纯函数，先单独验）。命中区**不画出来**，只用来判点击。
    {
      const rect = d.legendRect(8, 10, 2)
      check(rect.x === 8 + 4 && rect.y === 10 + 2, '图例贴在绘图区左上角', JSON.stringify([rect.x, rect.y]))
      check(rect.w > 60 && rect.h >= 30, '两条时命中区尺寸合理', JSON.stringify([rect.w, rect.h]))
      check(d.legendRect(8, 10, 1).h < rect.h, '一条时命中区更矮',
        rect.h + ' → ' + d.legendRect(8, 10, 1).h)
      check(d.legendHit(8, 10, rect.x + 5, rect.y + 6, 2) === 0, '点在框内上半 → 第 0 行')
      check(d.legendHit(8, 10, rect.x + 5, rect.y + rect.h - 4, 2) === 1, '点在框内下半 → 第 1 行')
      check(d.legendHit(8, 10, rect.x - 6, rect.y + 6, 2) === -1, '框左边之外 → 不命中')
      check(d.legendHit(8, 10, rect.x + 5, rect.y + rect.h + 6, 2) === -1, '框下面之外 → 不命中')
      check(d.legendHit(8, 10, rect.x + rect.w + 6, rect.y + 6, 2) === -1, '框右边之外 → 不命中')
    }

    // ---- 渲染：图上出现 EMA20 / EMA480 的文案与当前值
    // 注意：`lines` 是 **board** 的字段（`board.lines`），不是 view 的 ——
    // 放到 view 里会被静默忽略（踩过一次：图例整块不画，断言只说"没写文字"）。
    const legendBoard = function (show20, show480) {
      return {
        candles: candles.slice(540),
        lines: testLines(board.ema20.slice(540), board.ema480.slice(540), show20, show480),
        meta: { barMs: 900000 },
      }
    }
    const legendTexts = function (show20, show480, following) {
      const seen = []
      const positions = []
      const canvas = makeCanvas(900, 380)
      canvas.ctx.fillText = function (text, x, y) {
        seen.push(String(text)); positions.push([String(text), x, y])
      }
      d.drawChart(canvas.canvas, legendBoard(show20, show480), {
        hover: null,
        following: following !== false,
      })
      return { seen: seen, positions: positions, calls: canvas.ctx.calls }
    }
    {
      const both = legendTexts(true, true, true)
      check(both.seen.some((t) => t.indexOf('EMA20') === 0), '画布左上角写了 EMA20',
        both.seen.filter((t) => t.indexOf('EMA') === 0).join(' | '))
      check(both.seen.some((t) => t.indexOf('EMA480') === 0), '画布左上角写了 EMA480')
      const line = both.seen.filter((t) => t.indexOf('EMA20') === 0)[0]
      check(line !== undefined && line.indexOf(',') > 0, '图例带上了当前值', String(line))
      // 图例必须落在绘图区左上角附近（x 贴近左边、y 贴近顶部）
      const legendPos = both.positions.filter((t) => t[0].indexOf('EMA20') === 0)[0]
      check(legendPos !== undefined && legendPos[1] < 40 && legendPos[2] < 40,
        '图例画在左上角', legendPos === undefined ? '?' : 'x=' + legendPos[1] + ' y=' + legendPos[2])

      const onlySlow = legendTexts(false, true, true)
      check(onlySlow.seen.some((t) => t.indexOf('EMA20') === 0),
        '关掉 EMA20 后它仍在图例里（变暗，留着当"点回来"的入口）',
        onlySlow.seen.filter((t) => t.indexOf('EMA') === 0).join(' | '))
      check(onlySlow.seen.some((t) => t.indexOf('EMA480') === 0), 'EMA480 还在图例里')
      check(onlySlow.seen.length === both.seen.length, '关掉一条不会让图例少一行（行号必须稳定）',
        both.seen.length + ' → ' + onlySlow.seen.length)
      // 图例**不画底框**：文字之外不该有圆角矩形（K 线/十字光标里没有 roundRect 调用）
      check(d.LEGEND.bg === undefined, 'LEGEND 里没有底框颜色')
      check(typeof d.LEGEND.text === 'string' && d.LEGEND.text.length > 0, '图例文字色是显式指定的', d.LEGEND.text)

      const none = legendTexts(false, false, true)
      // 两条都隐藏时图例**仍然画**（变暗）—— 它是"点一下能开回来"的入口。
      // 想彻底不看图例就删掉均线，那时 legendVisible 才是 false。
      check(none.seen.some((t) => t.indexOf('EMA20') === 0), '两条都隐藏时图例仍在（否则点不回来）')
    }

    // ---- 回归：关掉某条之后还能点图例把它开回来（曾经的 bug：关掉就没了，再也点不开）
    {
      const mk = function (showFast, showSlow, period) {
        return [
          { item: { id: 'a', period: period || 20, color: '#f0b90b', show: showFast }, series: [1, 2, 3] },
          { item: { id: 'b', period: 480, color: '#a78bfa', show: showSlow }, series: [4, 5, 6] },
        ]
      }
      const itemsAll = d.emaLegendItems(mk(true, true))
      const itemsNoSlow = d.emaLegendItems(mk(true, false))
      const itemsNone = d.emaLegendItems(mk(false, false))
      check(itemsAll.length === 2, '两条都显示时图例有两条')
      check(itemsNoSlow.length === 2, '关掉慢线后图例**仍然有两条**（慢线只是变暗）',
        String(itemsNoSlow.length) + ' 条')
      check(itemsNoSlow[0].key === 'a' && itemsNoSlow[1].key === 'b',
        '行的顺序不随显示状态变（跟均线列表一一对应）',
        JSON.stringify([itemsNoSlow[0].key, itemsNoSlow[1].key]))
      check(itemsNoSlow[1].shown === false && itemsNoSlow[0].shown === true, '慢线变暗、快线仍亮',
        JSON.stringify([itemsNoSlow[0].shown, itemsNoSlow[1].shown]))
      check(itemsNoSlow[1].label === 'EMA480', '变暗的那条照样写着 EMA480', itemsNoSlow[1].label)
      check(itemsNoSlow[1].value === 6, '变暗的那条照样有值（隐藏不影响取值）', String(itemsNoSlow[1].value))
      check(itemsNone.every((it) => it.shown === false), '两条都关掉时都标成 shown=false')

      check(d.legendVisible(mk(true, true)) === true, '都显示 → 图例要画')
      check(d.legendVisible(mk(true, false)) === true, '只显示一条 → 图例仍要画（另一条是入口）')
      check(d.legendVisible(mk(false, true)) === true, '只显示慢线 → 图例也要画')
      check(d.legendVisible(mk(false, false)) === true, '两条都隐藏时图例仍然要画（否则点不回来）')
      check(d.legendVisible([]) === false, '没有均线时图例不画')
      check(d.legendVisible([{ item: { id: 'x', period: 20, show: true }, series: [] }]) === false,
        '序列为空时不画图例')

      // 命中区按当前条数算，隐藏的那行照样点得到，否则就"开不回来"了
      const rect = d.legendRect(8, 10, 2)
      check(rect.h === 2 * d.LEGEND.height + d.LEGEND.padY * 2, '命中区按两行算', String(rect.h))
      check(d.legendHit(8, 10, rect.x + 5, rect.y + 6, 2) === 0, '第 0 行命中 → 第 0 条均线')
      check(d.legendHit(8, 10, rect.x + 5, rect.y + rect.h - 4, 2) === 1, '第 1 行命中 → 第 1 条（隐藏时也点得到）')
      check(d.legendHit(8, 10, rect.x + 5, rect.y + 6, 3) === 0, '三条时第 0 行还是第 0 条')
    }

    // ---- 回归：*每*一行都要点得到，而且行号不能串。
    // 这条是拿一次真 bug 换来的：Chart 里算行数用的是 `latest.current.emaRows`，
    // 而那个 ref 在某些渲染顺序下还是 0 → 行数被夹到 1 → 第 1 行永远点不到，
    // 表现就是"EMA480 在图例上点不开"（跟上一轮那个 bug 长得一模一样）。
    {
      const rows = [0, 1, 2]
      const dom4 = createInteractiveDom()
      if (dom4 === null) {
        console.log('     跳过「每行都点得到」测试：环境里找不到 jsdom')
      } else {
        const hits = []
        const h4 = dom4.render(mod.debug.Chart, baseProps({
          lines: testLines(board.ema20.slice(540), board.ema480.slice(540)).concat([
            { item: { id: 'c', period: 120, color: '#4a8cff', show: true }, series: board.ema20.slice(540) },
          ]),
          onToggleEma: function (index) { hits.push(index) },
        }))
        const box4 = d.plotBox(h4.canvas(), 180)
        const rect4 = d.legendRect(8, box4.priceTop, 3)
        for (const row of rows) {
          const y = rect4.y + d.LEGEND.padY + d.LEGEND.height * row + d.LEGEND.height / 2
          h4.pointer('pointerdown', rect4.x + 6, y, 1)
          h4.pointer('pointerup', rect4.x + 6, y, 0)
        }
        check(hits.join(',') === '0,1,2', '三条均线时每一行都点得到、行号不串',
          JSON.stringify(hits) + '（只出现 0 就说明行数被夹成了 1）')
        h4.destroy()
        await dom4.unmount()
      }
    }

    // ---- 「回看中」角标挪到右上角，不再压在图例上
    {
      const history = legendTexts(true, true, false)
      const badge = history.positions.filter((t) => t[0] === '回看中')[0]
      const legendPos = history.positions.filter((t) => t[0].indexOf('EMA20') === 0)[0]
      check(badge !== undefined, '回看态仍然画「回看中」角标')
      if (badge !== undefined && legendPos !== undefined) {
        check(badge[1] > legendPos[1] + 100, '角标挪到了图例右边（不再压着图例）',
          '图例 x=' + legendPos[1] + ' 角标 x=' + badge[1])
      }
    }

    // ---- 交互：点图例开关均线（真渲染 + 真 pointer 事件）
    const dom3 = createInteractiveDom()
    if (dom3 === null) {
      console.log('     跳过「点图例开关均线」测试：环境里找不到 jsdom')
    } else {
      const toggles = []
      const h3 = dom3.render(chart, baseProps({
        // 这个 baseProps（4.x 节那个）默认不带 lines，图例交互必须显式给列表 ——
        // 否则 props.lines 是 undefined，Chart 只能退回"至少两行"的兜底
        lines: testLines(board.ema20.slice(540), board.ema480.slice(540)),
        onToggleEma: function (which) { toggles.push(which) },
      }))
      // 命中区要用**真实几何**算：用 hook 给出的 canvas（它带 JSDOM 的 clientWidth/Height）
      // 交给 plotBox 拿到 priceTop，再用 legendRect 定位每一行。
      // 不能用 legendRect(8, 10) 那种假数值 —— 行位置会跟实现差一截（踩过：点第 1 行实际落到第 0 行）。
      const canvasEl = h3.canvas()
      const box = d.plotBox(canvasEl, 180)
      const rect = d.legendRect(8, box.priceTop, 2)
      const rowY = function (index) { return rect.y + d.LEGEND.padY + d.LEGEND.height * index + d.LEGEND.height / 2 }
      const x = rect.x + 6
      h3.pointer('pointerdown', x, rowY(0), 1)
      h3.pointer('pointerup', x, rowY(0), 0)
      check(toggles.length === 1 && toggles[0] === 0, '点图例第 0 行 → 开关第 0 条均线', JSON.stringify(toggles))
      check(h3.added().length === 0, '点图例不会顺手画出一条线')
      h3.pointer('pointerdown', x, rowY(1), 1)
      h3.pointer('pointerup', x, rowY(1), 0)
      check(toggles.length === 2 && toggles[1] === 1, '点图例第 1 行 → 开关第 1 条均线', JSON.stringify(toggles))
      // 再点一次同一行：这就是"关掉之后能不能开回来"的那一步。
      // 早先隐藏的那条会从图例里消失，行号整体上移，于是永远开不回来（或误开别的）。
      h3.pointer('pointerdown', x, rowY(1), 1)
      h3.pointer('pointerup', x, rowY(1), 0)
      check(toggles.length === 3 && toggles[2] === 1,
        '再点第 1 行还是第 1 条（关掉之后也能开回来）', JSON.stringify(toggles))
      // 图例之外按下仍然是正常平移
      h3.pointer('pointerdown', 400, 150, 1)
      h3.pointer('pointermove', 300, 150, 1)
      h3.pointer('pointerup', 300, 150, 0)
      check(toggles.length === 3, '图例之外按下不会误触发开关', JSON.stringify(toggles))
      check(h3.viewCount() > 0, '图例之外按下仍然是平移', String(h3.viewCount()) + ' 次')
      h3.destroy()
      await dom3.unmount()
    }
  }

  // ---- 画布颜色常量：必须真的是"颜色"
  //
  // 这条是拿一次真事故换来的：批量替换把 `var C_POPOVER_BG = 'rgba(18,22,27,.92)'`
  // 改成了 `var C_POPOVER_BG = C_POPOVER_BG`（自引用），运行期直接 ReferenceError，
  // 而当时所有断言只检查"画了个圆角矩形""写了段文字"，**没有一个碰过颜色的值**，于是全绿通过。
  // 现在把每个常量的值都验一遍：是合法颜色字符串，且彼此不重复（自引用会得到同值或直接崩）。
  {
    const colors = d.COLORS
    check(colors !== undefined && typeof colors === 'object', '导出了画布颜色常量表')
    const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|url\(.*\)\s+\S+\s+\S+)$/
    const bad = []
    for (const [name, value] of Object.entries(colors)) {
      if (Array.isArray(value)) continue
      // CURSOR_CROSS 不是颜色，是一整条 cursor 值（SVG data URI + 热点），单独放行。
      // 注意 SVG 里的颜色是 **percent-encoded** 的（`fill='%23000000'`），所以这里查 `%23`
      // 而不是 `#` —— 第一次写成 `#` 把这条断言写错了。
      if (name === 'CURSOR_CROSS') {
        if (typeof value !== 'string' || value.indexOf('url(') !== 0 || value.indexOf('%23') < 0) {
          bad.push(name + '=' + String(value))
        }
        continue
      }
      if (typeof value !== 'string' || !COLOR_RE.test(value)) bad.push(name + '=' + String(value))
    }
    check(bad.length === 0, '每个颜色常量都是合法的颜色字符串', bad.join(' | '))
    check(Array.isArray(colors.EMA_DEFAULT_COLORS) && colors.EMA_DEFAULT_COLORS.length >= 4,
      '均线调色板至少有 4 个颜色', String((colors.EMA_DEFAULT_COLORS || []).length))
    check(new Set(colors.EMA_DEFAULT_COLORS).size === colors.EMA_DEFAULT_COLORS.length,
      '调色板内部不重复')
    const flat = Object.entries(colors)
      .filter(([k, v]) => typeof v === 'string' && k !== 'CURSOR_CROSS')
      .map(([, v]) => v)
    check(new Set(flat).size >= flat.length - 1, '颜色常量之间没有大面积的重复值',
      String(flat.length) + ' 个常量 / ' + String(new Set(flat).size) + ' 种颜色')
    check(colors.C_POPOVER_BG !== colors.C_POPOVER_TEXT, '浮层底色与文字色不同',
      colors.C_POPOVER_BG + ' vs ' + colors.C_POPOVER_TEXT)
    check(colors.C_UP !== colors.C_DOWN, '涨跌两色不同', colors.C_UP + ' vs ' + colors.C_DOWN)
  }

  // ---- 收线预警：规则模型 + 穿越判定
  //
  // 这是需求「K 线收线超过指定均线时提示」的核心，判定必须精确：
  // 只有"上一根在另一侧、这一根穿过来"才算，同一侧来回晃不算。
  {
    // -- 规则模型
    const base = d.alertAdd([], 20, 'up', '15m')
    check(base.length === 1, '新增一条规则', String(base.length))
    check(base[0].emaPeriod === 20 && base[0].dir === 'up' && base[0].bar === '15m' && base[0].on !== false,
      '新规则默认：周期 / 上穿 / 当前周期 / 启用', JSON.stringify(base[0]))
    check(d.alertLabel(base[0]) === '收盘上穿 EMA20', '规则描述', d.alertLabel(base[0]))
    check(d.alertLabel(d.alertAdd([], 60, 'down', '1h')[0]) === '收盘下穿 EMA60', '下穿的方向描述也对')
    let many = []
    for (let i = 0; i < 20; i += 1) many = d.alertAdd(many, 10 + i, 'up', '15m')
    check(many.length === d.ALERT_MAX, '规则条数封顶', String(many.length))
    const removed = d.alertRemove(base.concat(base.slice(0, 0)), base[0].id)
    check(removed.length === 0, '删除规则')
    const off = d.alertToggle(base, base[0].id)
    check(off[0].on === false, '暂停规则')
    check(d.alertToggle(off, base[0].id)[0].on === true, '再启用')
    check(d.alertSetDir(base, base[0].id, 'down')[0].dir === 'down', '切换方向')
    // 脏数据
    const dirty = d.normalizeAlerts([
      { emaPeriod: 20, dir: 'up' },
      { emaPeriod: 'abc' },            // 丢掉
      null,                            // 丢掉
      { emaPeriod: 5000, dir: 'down', bar: '1h', on: false },
    ], '15m', function () { return 'z' })
    check(dirty.length === 2, '脏规则被清成 2 条', JSON.stringify(dirty.map((a) => a.emaPeriod)))
    check(dirty[0].id === 'z', '缺 id 补一个', dirty[0].id)
    // 缺周期记空串，**不是**填当前周期：否则面板每次载入规则都会把它重绑到当时的周期
    check(dirty[0].bar === '', '缺周期记空串（不会被改成"当前周期"）', JSON.stringify(dirty[0].bar))
    check(dirty[1].emaPeriod === 2000 && dirty[1].on === false, '超上限夹住、暂停状态保留', JSON.stringify(dirty[1]))
    check(dirty[1].bar === '1h', '规则自己记的周期保留', JSON.stringify(dirty[1].bar))
    check(d.normalizeAlerts(null).length === 0, 'null 输入 → 空列表')

    // -- 规则绑的周期：绝不能因为"当前周期"而改变（用户报的第一条问题）
    check(d.alertAdd([], 20, 'up', '3m')[0].bar === '3m', 'alertAdd 记下传入的周期',
      d.alertAdd([], 20, 'up', '3m')[0].bar)
    check(d.alertAdd([], 20, 'up', null)[0].bar === '', '周期未知时记空串（不猜）',
      JSON.stringify(d.alertAdd([], 20, 'up', null)[0].bar))
    check(d.alertAdd([], 20, 'up', undefined)[0].bar === '', '周期 undefined 也记空串')
    // 关键：归一化**不能**把"空周期"改写成传进来的当前周期 ——
    // 否则面板每次重新载入规则都会把它重绑到当时的周期上
    const keepEmpty = d.normalizeAlerts([{ emaPeriod: 20, dir: 'up', bar: '' }], '15m')
    check(keepEmpty[0].bar === '', '归一化不会把"周期未知"改写成当前周期',
      JSON.stringify(keepEmpty[0].bar))
    const keep3m = d.normalizeAlerts([{ emaPeriod: 20, dir: 'up', bar: '3m' }], '15m')
    check(keep3m[0].bar === '3m', '归一化保留原有周期（不被当前周期覆盖）',
      JSON.stringify(keep3m[0].bar))
    // 改方向 / 暂停启用都不能动周期
    const r0 = d.alertAdd([], 20, 'up', '3m')[0]
    check(d.alertSetDir([r0], r0.id, 'down')[0].bar === '3m', '改方向不动周期')
    check(d.alertToggle([r0], r0.id)[0].bar === '3m', '暂停/启用不动周期')
    check(d.alertSetDir([r0], r0.id, 'down')[0].emaPeriod === 20, '改方向不动均线周期')

    // -- 同一条规则只判它绑的那个周期
    const c3 = [1000, 2000, 3000].map((t) => [t, 1, 2, 3, 2, 5, 1])
    const series3 = [3, 2, 1] // 上一根收盘 2 == 均线 2（齐平），这一根收盘 2 > 均线 1 → 上穿
    const lines3 = [{ item: { id: 'f', period: 20, show: true }, series: series3 }]
    const rule3m = { id: 'x', emaPeriod: 20, dir: 'up', bar: '3m', on: true }
    check(d.evalAlerts([rule3m], c3, lines3, 2, '3m', 0).hits.length === 1, '3m 的规则在 3m 上会判')
    check(d.evalAlerts([rule3m], c3, lines3, 2, '15m', 0).hits.length === 0, '3m 的规则在 15m 上不判')
    check(d.evalAlerts([rule3m], c3, lines3, 2, '1h', 0).hits.length === 0, '3m 的规则在 1h 上也不判')

    // -- 每一条规则可以绑**任意一条均线**（用户报的第二条问题：只能绑 EMA20）
    check(d.alertSetPeriod([r0], r0.id, 480)[0].emaPeriod === 480, '能把规则改绑到 EMA480',
      String(d.alertSetPeriod([r0], r0.id, 480)[0].emaPeriod))
    check(d.alertSetPeriod([r0], r0.id, 480)[0].bar === '3m', '改绑均线不动周期')
    check(d.alertSetPeriod([r0], r0.id, 480)[0].id === r0.id, '改绑均线不动 id')
    check(d.alertSetPeriod([r0], r0.id, 1)[0].emaPeriod === 20, '非法均线周期被忽略（保留旧值）',
      String(d.alertSetPeriod([r0], r0.id, 1)[0].emaPeriod))
    check(d.alertSetPeriod([r0], r0.id, 'abc')[0].emaPeriod === 20, '非数字也忽略')
    check(d.alertLabel(d.alertSetPeriod([r0], r0.id, 480)[0]) === '收盘上穿 EMA480',
      '改绑后描述跟着变', d.alertLabel(d.alertSetPeriod([r0], r0.id, 480)[0]))
    // 下一条均线（在给定候选里轮换）
    check(d.alertNextPeriod(20, [20, 480]) === 480, '下一条均线：20 → 480')
    check(d.alertNextPeriod(480, [20, 480]) === 20, '下一条均线：480 → 20（循环）')
    check(d.alertNextPeriod(20, [20]) === 20, '只有一条均线时还是它自己')
    check(d.alertNextPeriod(20, []) === 20, '没有均线列表时保持原值')
    check(d.alertNextPeriod(120, [20, 480]) === 20, '当前周期不在列表里 → 回到第一条')

    // -- 穿越判定：手造一组 K 线，让收盘价在均线上下穿
    // K 线格式 [ts, open, high, low, close, vol, done]
    const mk = (ts, close, done) => [ts, close, close + 1, close - 1, close, 10, done === false ? 0 : 1]
    // 均线值直接用数组喂进去，测判定本身（不掺 EMA 计算）
    const candles = [mk(1000, 100), mk(2000, 100), mk(3000, 100), mk(4000, 110)]
    const seriesUp = [null, 100, 100, 105]      // 最后一根收盘 110 在均线 105 之上，上一根 100 <= 100
    const up = d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: true }, candles, seriesUp, 3, 1)
    check(up !== null, '收盘从均线下方跑到上方 → 命中上穿', JSON.stringify(up))
    check(up !== null && up.dir === 'up' && up.emaPeriod === 20, '命中里带上方向与周期', JSON.stringify(up))
    check(up !== null && up.close === 110 && up.ema === 105, '命中里带上收盘价与均线值', JSON.stringify(up))
    check(up !== null && up.text.indexOf('收线上穿 EMA20') === 0, '提示文案', up === null ? '' : up.text)
    check(up !== null && up.ts === 4000, '命中里带上那根的时间戳', String(up === null ? '' : up.ts))

    // 方向不对 → 不命中
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'down', on: true }, candles, seriesUp, 3, 1) === null,
      '上穿不触发下穿规则')
    // 同一侧（都在上方）→ 不命中：这是"穿过"而不是"在上方"
    const seriesAbove = [null, 90, 92, 100]
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: true }, candles, seriesAbove, 3, 1) === null,
      '一直贴在上方不算穿过')
    // 下穿
    const candlesDown = [mk(1000, 100), mk(2000, 100), mk(3000, 100), mk(4000, 90)]
    const seriesDown = [null, 100, 100, 100]
    const down = d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'down', on: true }, candlesDown, seriesDown, 3, 1)
    check(down !== null, '收盘从上方跑到下方 → 命中下穿')
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: true }, candlesDown, seriesDown, 3, 1) === null,
      '下穿不触发上穿规则')
    // 各种边界
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: false }, candles, seriesUp, 3, 1) === null,
      '暂停的规则不判')
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: true }, candles, seriesUp, 0, 1) === null,
      '第 0 根没有"上一根"，不判')
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: true }, candles, seriesUp, 99, 1) === null,
      '下标越界不判')
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: true }, candles, [null, null, null, null], 3, 1) === null,
      '均线还没预热出值时不判')
    check(d.evalAlert({ id: 'r', emaPeriod: 20, dir: 'up', on: true }, candles, seriesUp, 3, 1) !== null,
      '刚齐平后穿过也算（prevClose === prevEma）')

    // -- 只判"当前周期"的规则
    const lines = [
      { item: { id: 'f', period: 20, show: true }, series: seriesUp },
      { item: { id: 's', period: 60, show: true }, series: seriesUp },
    ]
    const rules = [
      { id: 'a', emaPeriod: 20, dir: 'up', bar: '15m', on: true },
      { id: 'b', emaPeriod: 20, dir: 'up', bar: '1h', on: true },   // 别的周期
      { id: 'c', emaPeriod: 60, dir: 'up', bar: '15m', on: true },  // 另一个周期参数
      { id: 'e', emaPeriod: 20, dir: 'down', bar: '15m', on: true }, // 方向不符
    ]
    const hits = d.evalAlerts(rules, candles, lines, 3, '15m', 1).hits
    check(hits.length === 2, '只判当前周期的规则（含另一个均线周期）', JSON.stringify(hits.map((h) => h.ruleId)))
    check(hits.map((h) => h.ruleId).sort().join(',') === 'a,c', '命中的正是 a 与 c', JSON.stringify(hits.map((h) => h.ruleId)))
    check(d.evalAlerts(rules, candles, lines, 3, '1D', 1).hits.length === 0, '切到别的周期时都不判')
    check(d.evalAlerts([], candles, lines, 3, '15m', 1).hits.length === 0, '没有规则时不判')
    // 规则指向的均线被删了 → 不判，但不报错
    check(d.evalAlerts([{ id: 'x', emaPeriod: 999, dir: 'up', bar: '15m', on: true }],
      candles, lines, 3, '15m', 1).hits.length === 0, '规则指向的均线不存在时不判也不崩')

    // -- 游标：第一次只登记，不判定（刚打开面板不该报历史上的穿越）
    const closed = [mk(1000, 1), mk(2000, 2), mk(3000, 3), mk(4000, 4), mk(5000, 5, false)]
    const first = d.closedAlertCursor(closed, null)
    check(first !== null && first.fresh === false, '第一次只登记游标，不判定',
      JSON.stringify(first))
    check(first !== null && first.ts === 4000, '游标停在最后一根已收盘的 K 线上', String(first === null ? '' : first.ts))
    check(first !== null && first.idx === 3, '游标下标指向那根', String(first === null ? '' : first.idx))
    check(d.closedAlertCursor(closed, 4000) === null, '同一根还没收 → 不再判定')
    const later = closed.concat([mk(6000, 6)])
    const second = d.closedAlertCursor(later, 4000)
    check(second !== null && second.fresh === true && second.ts === 6000,
      '又收了一根 → 判定这一根', JSON.stringify(second))
    check(d.closedAlertCursor([mk(1000, 1), mk(2000, 2, false)], 0) === null,
      '一根都没收线时不判')
    check(d.closedAlertCursor([], null) === null, '空序列不崩')

    // **真事故回归**：宿主曾经只发 6 位 K 线（没有 done），客户端靠第 7 位判"收线了没"，
    // 于是收线预警永远不响、且没有任何报错。现在至少要**吭一声**。
    const noDone = [[1000, 1, 2, 0, 1, 10], [2000, 1, 2, 0, 1, 10], [3000, 1, 2, 0, 1, 10]]
    const savedWarn = console.warn
    const warned = []
    console.warn = function (msg) { warned.push(String(msg)) }
    let cursorNoDone = 'x'
    try {
      cursorNoDone = d.closedAlertCursor(noDone, null)
    } finally {
      console.warn = savedWarn
    }
    check(cursorNoDone === null, '载荷没有 done 时判不出来（返回 null）', String(cursorNoDone))
    check(warned.length === 1 && warned[0].indexOf('done') >= 0,
      '载荷没有 done 时要报警告（不能静默失效）', warned.join(' | '))
    // 有 done 时不该报
    const warned2 = []
    console.warn = function (msg) { warned2.push(String(msg)) }
    try {
      d.closedAlertCursor([
        [1000, 1, 2, 0, 1, 10, 1], [2000, 1, 2, 0, 1, 10, 1], [3000, 1, 2, 0, 1, 10, 0],
      ], null)
    } finally {
      console.warn = savedWarn
    }
    check(warned2.length === 0, '带 done 的载荷不报警告', warned2.join(' | '))
  }

  // ---- 收线预警：界面与真实触发（整面板 + 真点击）
  {
    const dom9 = createInteractiveDom()
    if (dom9 === null) {
      console.log('     跳过「收线预警界面」测试：环境里找不到 jsdom')
    } else {
      await dom9.mount()
      const docEl = dom9.container().ownerDocument
      const findExact = function (text) {
        for (const b of docEl.querySelectorAll('button')) if (b.textContent.trim() === text) return b
        return null
      }
      const findPrefix = function (text) {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf(text) === 0) return b
        }
        return null
      }
      const alertRows = function () {
        return Array.prototype.filter.call(docEl.querySelectorAll('.btcd-alertpanel .btcd-emapanel-row'),
          (r) => r.querySelector('button.btcd-danger') !== null)
      }

      // 工具条上有「预警」入口
      const alertBtn = findPrefix('预警')
      check(alertBtn !== null, '工具条上有「预警」按钮',
        Array.prototype.map.call(docEl.querySelectorAll('.btcd-tool'), (b) => b.textContent.trim()).join(','))

      // 点开 → 空态提示
      dom9.click(alertBtn)
      check(docEl.querySelector('.btcd-alertpanel') !== null, '点开收线预警看板')
      check(docEl.body.textContent.indexOf('还没有预警规则') >= 0, '空态有提示')

      // 加一条规则
      const addRule = findExact('＋ 新增规则')
      check(addRule !== null, '看板里有「＋ 新增规则」')
      dom9.click(addRule)
      check(alertRows().length === 1, '加了一条规则', String(alertRows().length))
      check(alertRows()[0].textContent.indexOf('收盘上穿') >= 0, '默认是上穿',
        alertRows()[0].textContent)
      check(alertRows()[0].textContent.indexOf('20') >= 0, '默认绑在第一条均线（EMA20）上',
        alertRows()[0].textContent)
      check(findPrefix('预警（1）') !== null, '工具条上的启用条数跟着变',
        Array.prototype.map.call(docEl.querySelectorAll('.btcd-tool'), (b) => b.textContent.trim()).join(','))

      // 同一条别重复加
      dom9.click(findExact('＋ 新增规则'))
      check(alertRows().length === 1, '重复规则不会被加进来', String(alertRows().length))

      // 切换方向
      dom9.click(alertRows()[0].querySelector('button.btcd-mini'))
      check(alertRows()[0].textContent.indexOf('收盘下穿') >= 0, '点方向按钮切换上穿/下穿',
        alertRows()[0].textContent)

      // 暂停 / 启用
      const onBtn = Array.prototype.filter.call(alertRows()[0].querySelectorAll('button.btcd-mini'),
        (b) => b.textContent === '已启用' || b.textContent === '已暂停')[0]
      check(onBtn !== undefined, '有启用/暂停按钮')
      dom9.click(onBtn)
      check(alertRows()[0].textContent.indexOf('已暂停') >= 0, '暂停规则', alertRows()[0].textContent)
      check(findExact('预警（0）') !== null, '暂停后启用条数变 0',
        Array.prototype.map.call(docEl.querySelectorAll('.btcd-tool'), (b) => b.textContent.trim()).join(','))
      const findRowBtn = function (text) {
        const btns = alertRows()[0].querySelectorAll('button.btcd-mini')
        for (const b of btns) if (b.textContent === text) return b
        return null
      }
      dom9.click(findRowBtn('已暂停'))
      check(alertRows()[0].textContent.indexOf('已启用') >= 0, '再启用', alertRows()[0].textContent)

      // Esc 收起
      dom9.key('Escape')
      check(docEl.querySelector('.btcd-alertpanel') === null, 'Esc 收起预警看板')
      check(docEl.querySelector('.btcd-panel') !== null, 'Esc 只收预警看板，不关整个面板')

      // 删除规则
      dom9.click(findPrefix('预警'))
      const delBtn = alertRows()[0].querySelector('button.btcd-danger')
      check(delBtn !== null, '每行有删除按钮')
      dom9.click(delBtn)
      check(alertRows().length === 0, '删除后回到空态', String(alertRows().length))
      check(docEl.body.textContent.indexOf('还没有预警规则') >= 0, '删完显示空态')

      check(dom9.errors().length === 0, '整段操作没有页面级异常', dom9.errors().join(' | '))
      await dom9.unmount()
    }
  }

  // ---- 收线预警：整条链路（flat 板 → cross 板）走一遍，不依赖 React 的调度
  {
    const BAR2 = 900000
    const flat = []
    for (let i = 0; i < 60; i += 1) flat.push([1780000000000 + i * BAR2, 100, 101, 99, 100, 10, 1])
    flat.push([1780000000000 + 60 * BAR2, 100, 101, 99, 100, 10, 0]) // 未收盘
    const cross = flat.slice(0, 60).concat([[1780000000000 + 60 * BAR2, 100, 131, 99, 130, 10, 1]])

    const rule = d.alertAdd([], 20, 'up', '15m')[0]
    const seriesOf = (candles) => d.emaFor(candles, [
      { id: 'f', period: 20, color: '#f0b90b', show: true },
    ], 1)

    // 第一次：游标只登记
    const c1 = d.closedAlertCursor(flat, null)
    check(c1 !== null && c1.fresh === false, '第一次只看不判', JSON.stringify(c1))
    check(c1 !== null && c1.ts === 1780000000000 + 59 * BAR2, '游标停在最后一根已收盘的',
      String(c1 === null ? '' : c1.ts))
    // 同一块板子再判：没有新收线 → 什么都不做
    check(d.closedAlertCursor(flat, c1.ts) === null, '同一块板子不重复判')
    // flat 上一直贴着均线，不算穿越
    check(d.evalAlerts([rule], flat, seriesOf(flat), 59, '15m', 1).hits.length === 0,
      '一直贴着均线不算穿越')

    // 换了新板子（多收一根，且穿线）→ 判定命中
    const c2 = d.closedAlertCursor(cross, c1.ts)
    check(c2 !== null && c2.fresh === true, '新板子 → 有新的收线', JSON.stringify(c2))
    check(c2 !== null && c2.idx === 60, '下标指向新收的那一根', String(c2 === null ? '' : c2.idx))
    const hits = d.evalAlerts([rule], cross, seriesOf(cross), c2.idx, '15m', 1).hits
    check(hits.length === 1, '新收一根且穿线 → 命中一条预警', JSON.stringify(hits))
    check(hits.length === 1 && hits[0].text.indexOf('收线上穿 EMA20') === 0, '提示文案正确',
      hits.length === 0 ? '' : hits[0].text)
    check(hits.length === 1 && hits[0].close === 130, '命中里带着新收线的收盘价',
      String(hits.length === 0 ? '' : hits[0].close))
    // 方向反了 → 不命中
    check(d.evalAlerts([d.alertSetDir([rule], rule.id, 'down')[0]], cross, seriesOf(cross), c2.idx, '15m', 1).hits.length === 0,
      '下穿规则不会被上穿触发')
  }

  // 收线预警：界面与规则管理（整面板 + 真点击）。
  // 触发那一步（载荷变化 → 判定 → 提示条）在这个 harness 里验不了：promise 回调里排队的
  // 状态更新没有真实帧循环推，React 不一定提交。上面那节已经把判定逻辑整条链路覆盖了，
  // 这里只验 UI 接线（按钮 → state → 控件）。
  {
    const dom10 = createInteractiveDom()
    if (dom10 === null) {
      console.log('     跳过「收线预警界面」测试：环境里找不到 jsdom')
    } else {
      await dom10.mount()
      const docEl = dom10.container().ownerDocument
      const findPrefix = function (text) {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf(text) === 0) return b
        }
        return null
      }
      const findExact = function (text) {
        for (const b of docEl.querySelectorAll('button')) if (b.textContent.trim() === text) return b
        return null
      }
      const alertRows = function () {
        return Array.prototype.filter.call(docEl.querySelectorAll('.btcd-alertpanel .btcd-emapanel-row'),
          (r) => r.querySelector('button.btcd-danger') !== null)
      }
      // 加一条规则（默认「收盘上穿 EMA20」，绑当前周期）
      dom10.click(findPrefix('预警'))
      dom10.click(findExact('＋ 新增规则'))
      check(alertRows().length === 1, '规则已加', String(alertRows().length))
      check(alertRows()[0].textContent.indexOf('收盘上穿') >= 0 && alertRows()[0].textContent.indexOf('20') >= 0,
        '默认规则绑在第一条均线（EMA20）上、方向是上穿', alertRows()[0].textContent)
      check(alertRows()[0].textContent.indexOf('本周期') >= 0, '标出了它绑在哪个周期上',
        alertRows()[0].textContent)

      // -- 规则必须**绑在创建时的周期**上：切周期不能把它改成新周期
      const barTab = function (label) {
        for (const b of docEl.querySelectorAll('.btcd-tab')) {
          if (b.textContent.trim() === label) return b
        }
        return null
      }
      const readStoredAlerts = function () {
        try {
          return JSON.parse(dom10.win().localStorage.getItem('dsh-btc-dashboard:alerts') || '[]')
        } catch (e) { return [] }
      }
      // 先把刚才那条删掉，从干净状态开始
      dom10.click(alertRows()[0].querySelector('button.btcd-danger'))
      check(alertRows().length === 0, '清掉默认那条')

      // -- 能绑到**任意一条**均线（用户报过"只能绑 EMA20"）
      const emaBtn = function () {
        const btns = alertRows()[0].querySelectorAll('button.btcd-mini')
        for (const b of btns) if (b.textContent.indexOf('EMA') === 0) return b
        return null
      }
      dom10.click(findExact('＋ 新增规则'))
      check(emaBtn() !== null, '规则行里有「EMAn」按钮', alertRows()[0].textContent)
      check(emaBtn().textContent === 'EMA20', '默认绑第一条均线 EMA20', emaBtn().textContent)
      dom10.click(emaBtn())
      check(emaBtn().textContent === 'EMA480', '点一下就换绑到 EMA480（第二条均线）',
        emaBtn().textContent)
      check(alertRows()[0].textContent.indexOf('收盘上穿') >= 0, '换绑均线不影响方向',
        alertRows()[0].textContent)
      const storedBound = readStoredAlerts()
      check(storedBound.length === 1 && storedBound[0].emaPeriod === 480,
        '换绑后存下来的也是 480', JSON.stringify(storedBound.map((a) => a.emaPeriod)))
      dom10.click(emaBtn())
      check(emaBtn().textContent === 'EMA20', '再点一下轮回到 EMA20（两条之间循环）',
        emaBtn().textContent)

      // 切到 3m 再加规则
      const tab3 = barTab('3m')
      check(tab3 !== null, '有 3m 周期标签')
      dom10.click(tab3)
      await dom10.settle(250)
      dom10.click(alertRows()[0].querySelector('button.btcd-danger'))
      check(alertRows().length === 0, '清空后从 3m 重新加')
      dom10.click(findExact('＋ 新增规则'))
      check(alertRows().length === 1, '在 3m 下加了一条规则', String(alertRows().length))
      check(alertRows()[0].textContent.indexOf('本周期') >= 0, '刚建时标的是"本周期 3m"',
        alertRows()[0].textContent)
      const stored3m = readStoredAlerts()
      check(stored3m.length === 1 && stored3m[0].bar === '3m', '规则里记的周期是 3m',
        JSON.stringify(stored3m.map((a) => a.bar)))

      // 切到 15m：规则还在，但**不该**变成绑 15m
      dom10.click(barTab('15m'))
      await dom10.settle(250)
      const rowsOn15m = alertRows()
      check(rowsOn15m.length === 1, '切到 15m 后规则还在', String(rowsOn15m.length))
      check(rowsOn15m[0].textContent.indexOf('本周期') < 0,
        '切到 15m 后规则不再标"本周期"（它绑的是 3m）', rowsOn15m[0].textContent)
      check(rowsOn15m[0].textContent.indexOf('3m') >= 0, '规则上写着它绑的周期 3m',
        rowsOn15m[0].textContent)
      const storedAfterSwitch = readStoredAlerts()
      check(storedAfterSwitch.length === 1 && storedAfterSwitch[0].bar === '3m',
        '切周期**没有**改写规则里的周期', JSON.stringify(storedAfterSwitch.map((a) => a.bar)))
      // 在 15m 上换绑均线，也不能顺手把周期改成 15m
      dom10.click(emaBtn())
      const storedAfterRebind = readStoredAlerts()
      check(storedAfterRebind[0].bar === '3m', '在别的周期上改绑均线也不动周期',
        JSON.stringify(storedAfterRebind.map((a) => a.bar)))
      dom10.click(emaBtn())

      // 再切回 3m：又变回"本周期"
      dom10.click(barTab('3m'))
      await dom10.settle(250)
      check(alertRows()[0].textContent.indexOf('本周期') >= 0,
        '切回 3m 又显示"本周期"', alertRows()[0].textContent)
      // 清理并验 Esc
      dom10.click(alertRows()[0].querySelector('button.btcd-danger'))
      check(alertRows().length === 0, '删除规则', String(alertRows().length))
      dom10.key('Escape')
      check(docEl.querySelector('.btcd-alertpanel') === null, 'Esc 收起预警看板')
      check(docEl.querySelector('.btcd-panel') !== null, 'Esc 只收预警看板，不关整个面板')
      await dom10.unmount()
    }
  }

  // ---- 通知渠道：桌面通知 + 提示音（不支持的环境里也不能抛错）
  {
    check(d.normalizeNotify(null).desktop === true && d.normalizeNotify(null).sound === true,
      '默认两个渠道都开', JSON.stringify(d.normalizeNotify(null)))
    check(d.normalizeNotify({ desktop: false }).desktop === false, '能单独关掉桌面通知')
    check(d.normalizeNotify({ sound: false }).sound === false, '能单独关掉提示音')
    check(d.normalizeNotify('乱七八糟').desktop === true, '垃圾输入退回默认值')
    check(d.normalizeNotify(null).sound === true && d.normalizeNotify({}).desktop === true,
      '缺字段按"开"处理')
    check(typeof d.notifyAvailable() === 'boolean', 'notifyAvailable 返回布尔',
      String(d.notifyAvailable()))
    check(typeof d.notifyPermission() === 'string', 'notifyPermission 返回字符串',
      d.notifyPermission())
    // 关键：这两个在任何环境下都不能抛（没授权 / 不支持 / 没交互过都只是"没生效"）
    let threw = null
    try {
      d.sendDesktopNotice('测试标题', '测试正文')
      d.playAlertSound()
    } catch (error) { threw = error }
    check(threw === null, '发通知 / 放提示音在任何环境下都不抛错',
      threw === null ? '（当前环境：available=' + String(d.notifyAvailable()) + ' permission=' + d.notifyPermission() + '）'
        : String(threw && threw.message))
    check(typeof d.sendDesktopNotice('测试', '正文') === 'boolean', 'sendDesktopNotice 返回布尔')
    check(typeof d.playAlertSound() === 'boolean', 'playAlertSound 返回布尔')
    check(d.NOTIFY_STORE_KEY === 'dsh-btc-dashboard:notify', '通知开关的存储键', d.NOTIFY_STORE_KEY)
  }

  // ---- 预警记录：持久化 + 去重 + 清空
  {
    const mkHit = (ruleId, ts, text) => ({
      ruleId: ruleId, ts: ts, dir: 'up', emaPeriod: 20, close: 130, ema: 100,
      text: text || ('收线上穿 EMA20 · 收盘 130.0 / 均线 100.0'),
    })
    // 追加：新的在前
    let log = d.alertLogAdd([], [mkHit('r1', 1000)], 5000, '3m')
    check(log.length === 1, '记下一条', String(log.length))
    check(log[0].ruleId === 'r1' && log[0].ts === 1000 && log[0].at === 5000 && log[0].bar === '3m',
      '记录里带规则 / 收线时刻 / 记录时刻 / 周期', JSON.stringify(log[0]))
    check(log[0].id === 'r1@1000', '记录 id 是"规则@收线时刻"', log[0].id)
    log = d.alertLogAdd(log, [mkHit('r2', 2000)], 6000, '3m')
    check(log.length === 2, '再记一条', String(log.length))
    check(log[0].ruleId === 'r2', '新的在最前面（倒序）', log[0].ruleId)

    // 去重：同一条规则同一根只记一次
    const same = d.alertLogAdd(log, [mkHit('r2', 2000)], 7000, '3m')
    check(same === log, '同一条规则同一根不重复记（连数组引用都不变）', String(same.length))
    check(d.alertLogAdd(log, [mkHit('r2', 2001)], 7000, '3m').length === 3,
      '同一规则但换了一根 → 记新的')

    // 一次命中多条
    const many = d.alertLogAdd([], [mkHit('a', 1), mkHit('b', 1), mkHit('c', 1)], 100, '3m')
    check(many.length === 3, '一次命中多条就记多条', String(many.length))
    // 同一次里重复的也去掉
    check(d.alertLogAdd([], [mkHit('a', 1), mkHit('a', 1)], 100, '3m').length === 1,
      '同一批里的重复也去掉')

    // 上限：超出丢最老的
    let big = []
    for (let i = 0; i < d.ALERT_MAX_HISTORY + 25; i += 1) {
      big = d.alertLogAdd(big, [mkHit('r', 1000 + i)], 9000 + i, '3m')
    }
    check(big.length === d.ALERT_MAX_HISTORY, '记录条数封顶', String(big.length))
    check(big[0].ts === 1000 + d.ALERT_MAX_HISTORY + 24, '留下的是最新的那批', String(big[0].ts))
    check(big[big.length - 1].ts === 1000 + 25, '最老的被丢掉了',
      String(big[big.length - 1].ts))

    // 规范化：脏数据丢掉，不炸
    const dirty = d.normalizeAlertLog([
      { ruleId: 'a', ts: 1, at: 10, text: 'ok' },
      null,
      { ruleId: 'b', ts: 2, at: 20 },            // 没 text → 丢
      { ruleId: 'c', ts: 'x', at: 'y', text: 't' }, // 时间不是数字 → 归 0，但保留
    ])
    check(dirty.length === 2, '脏记录被清成 2 条', String(dirty.length))
    check(dirty[0].ruleId === 'a', '按 at 倒序（at=10 在后）', JSON.stringify(dirty.map((r) => r.ruleId)))
    check(dirty[1].ts === 0 && dirty[1].at === 0, '非法时间归 0', JSON.stringify([dirty[1].ts, dirty[1].at]))
    check(d.normalizeAlertLog(null).length === 0, 'null → 空列表')
    check(d.normalizeAlertLog('乱') .length === 0, '垃圾输入 → 空列表')
    check(d.alertLogAdd(null, [mkHit('a', 1)], 1, '3m').length === 1, '日志为 null 也能追加')
    check(d.alertLogAdd([], null, 1, '3m').length === 0, '命中为 null → 不加')
    check(d.alertLogAdd([], [], 1, '3m').length === 0, '空命中 → 不加')

    // 时间显示
    check(typeof d.alertLogTime({ ts: 1780000000000 }, 900000) === 'string', '记录时间可渲染',
      d.alertLogTime({ ts: 1780000000000 }, 900000))
    check(d.alertLogTime({ ts: 1780000000000 }, 86400000).indexOf(':') < 0,
      '日线记录只显示日期', d.alertLogTime({ ts: 1780000000000 }, 86400000))
    check(d.ALERT_LOG_KEY === 'dsh-btc-dashboard:alert-log', '记录的存储键', d.ALERT_LOG_KEY)
  }

  // ---- 预警记录：界面（持久化 + 清空）
  {
    const dom11 = createInteractiveDom()
    if (dom11 === null) {
      console.log('     跳过「预警记录界面」测试：环境里找不到 jsdom')
    } else {
      const win11 = dom11.win()
      // 预置两条记录，模拟"上次留下的"
      win11.localStorage.setItem('dsh-btc-dashboard:alert-log', JSON.stringify([
        { id: 'a@1', ruleId: 'a', ts: 1780000000000, at: Date.now() - 60000, text: '收线上穿 EMA20 · 收盘 130.0 / 均线 100.0', dir: 'up', bar: '15m', emaPeriod: 20, close: 130, ema: 100 },
        { id: 'b@2', ruleId: 'b', ts: 1779999000000, at: Date.now() - 120000, text: '收线下穿 EMA480 · 收盘 90.0 / 均线 100.0', dir: 'down', bar: '15m', emaPeriod: 480, close: 90, ema: 100 },
      ]))
      await dom11.mount()
      const docEl = dom11.container().ownerDocument
      const findPrefix = function (text) {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf(text) === 0) return b
        }
        return null
      }
      const findExact = function (text) {
        for (const b of docEl.querySelectorAll('button')) if (b.textContent.trim() === text) return b
        return null
      }
      const logRows = function () { return docEl.querySelectorAll('.btcd-alert-logrow') }

      dom11.click(findPrefix('预警'))
      check(logRows().length === 2, '把上次留下的记录读回来了（持久化）', String(logRows().length))
      check(docEl.body.textContent.indexOf('预警记录（2 条') >= 0, '标题里写着条数',
        String((docEl.body.textContent.match(/预警记录（[^）]*）/) || [])))
      check(logRows()[0].textContent.indexOf('EMA20') >= 0, '第一条记录在上（新的在前）',
        logRows()[0].textContent)
      check(logRows()[1].textContent.indexOf('EMA480') >= 0, '第二条记录在下',
        logRows()[1].textContent)
      // 记录行里**只留触发时间**，不再显示"间隔多久"。
      // 那条"多久之前"曾经显示成 "497584h前"（≈57 年）—— 调用点把时间戳当成了时长。
      // 现在的做法是把它整个删掉，所以这里直接查渲染出来的行：有触发时间、没有"前"。
      const rowTexts = Array.from(logRows()).map((row) => row.textContent)
      check(rowTexts.every((t) => /\d{2}-\d{2}\s+\d{2}:\d{2}/.test(t)),
        '每条记录都带触发时间', JSON.stringify(rowTexts))
      check(rowTexts.every((t) => !/\d+h\d{2}m前|\d{2}:\d{2}前/.test(t)),
        '记录行里不再出现"间隔多久"（连同那个时间戳当时长的老 bug 一起删掉了）',
        JSON.stringify(rowTexts))
      check(rowTexts.every((t) => !/\d{4,}h/.test(t)),
        '也没有"几千小时前"这种荒谬时长', JSON.stringify(rowTexts))

      // 清空
      const clearBtn = findExact('清空记录')
      check(clearBtn !== null, '有「清空记录」按钮')
      dom11.click(clearBtn)
      check(logRows().length === 0, '清空后记录都没了', String(logRows().length))
      check(docEl.body.textContent.indexOf('还没有预警记录') >= 0, '清空后显示空态')
      const storedAfterClear = win11.localStorage.getItem('dsh-btc-dashboard:alert-log')
      check(storedAfterClear === null || storedAfterClear === '[]',
        '清空也写回了存储', String(storedAfterClear))

      // 再打开一次（重新挂载）确认清空是持久的
      await dom11.unmount()
      const dom12 = createInteractiveDom()
      if (dom12 !== null) {
        dom12.win().localStorage.setItem('dsh-btc-dashboard:alert-log', '[]')
        await dom12.mount()
        const docEl2 = dom12.container().ownerDocument
        for (const b of docEl2.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('预警') === 0) { dom12.click(b); break }
        }
        check(docEl2.querySelectorAll('.btcd-alert-logrow').length === 0,
          '重新打开后记录仍是空的（清空持久生效）')
        await dom12.unmount()
      }
    }
  }

  // ---- 预警自检：把"能不能判"的条件显示出来（失败模式是"什么都不发生"，必须看得见）
  {
    // 纯函数部分
    const healthy = [[1000, 1, 2, 0, 1, 10, 1], [2000, 1, 2, 0, 1, 10, 1], [3000, 1, 2, 0, 1, 10, 0]]
    const h1 = d.candleHealth(healthy)
    check(h1.ready === true, '正常的载荷 → 就绪', JSON.stringify(h1))
    check(h1.count === 3 && h1.withDone === 3, '数出根数与带 done 的根数', JSON.stringify(h1))
    check(h1.doneCount === 2, '数出已收盘的根数', String(h1.doneCount))
    check(h1.lastDoneTs === 2000 && h1.lastDoneIdx === 1, '记住最近一根已收盘的',
      JSON.stringify([h1.lastDoneTs, h1.lastDoneIdx]))
    // 老宿主：只有 6 位（这就是"预警从来不响"的真凶）
    const broken = d.candleHealth([[1000, 1, 2, 0, 1, 10], [2000, 1, 2, 0, 1, 10], [3000, 1, 2, 0, 1, 10]])
    check(broken.ready === false && broken.withDone === 0, '缺 done 的载荷 → 不就绪',
      JSON.stringify(broken))
    check(d.candleHealth([]).ready === false, '空载荷不就绪')
    check(d.candleHealth(null).ready === false, 'null 载荷不就绪')
    check(d.candleHealth([[1000, 1, 2, 0, 1, 10, 1], [2000, 1, 2, 0, 1, 10, 1], [3000, 1, 2, 0, 1, 10, 1]]).ready === true,
      '全部已收盘也算就绪（极端但合法：最后一根只是还没出现）')
    check(d.candleHealth([[1000, 1, 2, 0, 1, 10, 1], [2000, 1, 2, 0, 1, 10, 1]]).ready === false,
      '只有 2 根时不就绪（少于 ALERT_MIN_BARS）', String(d.ALERT_MIN_BARS))

    // 界面：自检块要出现；缺 done 时染红并说清原因
    const dom13 = createInteractiveDom()
    if (dom13 === null) {
      console.log('     跳过「预警自检」界面测试：环境里找不到 jsdom')
    } else {
      const openAlerts = function (docEl, hook) {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('预警') === 0) { hook.click(b); return }
        }
      }
      // （1）正常载荷：第 7 位 done 补齐，与真实宿主一致
      const withDone = makeBoard(400)
      withDone.candles = withDone.candles.map((c, i) => c.concat([i === withDone.candles.length - 1 ? 0 : 1]))
      withDone.bars = [
        { id: '1m', label: '1m' }, { id: '3m', label: '3m' }, { id: '15m', label: '15m' },
        { id: '1h', label: '1h' }, { id: '4h', label: '4h' }, { id: '1D', label: '1D' },
      ]
      await dom13.mount({ board: withDone })
      const docEl = dom13.container().ownerDocument
      openAlerts(docEl, dom13)
      const diag = docEl.querySelector('.btcd-alert-diag')
      check(diag !== null, '看板里有自检块')
      check(diag !== null && diag.textContent.indexOf('条件就绪') >= 0, '正常载荷下显示"条件就绪"',
        diag === null ? '' : diag.textContent)
      check(diag !== null && diag.textContent.indexOf('带 done 400') >= 0,
        '自检里报出带 done 的根数', diag === null ? '' : diag.textContent)
      check(diag !== null && diag.textContent.indexOf('最近检查') >= 0,
        '自检里有"最近检查"时间戳（每次轮询都会跳，用来确认它真的在工作）',
        diag === null ? '' : diag.textContent)
      check(diag !== null && diag.textContent.indexOf('应判') >= 0 && diag.textContent.indexOf('判定') >= 0,
        '自检里把"应判"和"判定"分开显示（分辨卡在哪一步）',
        diag === null ? '' : diag.textContent)
      check(diag !== null && diag.className.indexOf('btcd-alert-diag-bad') < 0, '就绪时不染红',
        diag === null ? '' : diag.className)
      await dom13.unmount()

      // （2）老宿主载荷（6 位）：自检要明确说缺 done
      const legacy = createInteractiveDom()
      if (legacy !== null) {
        await legacy.mount({ board: makeBoardNoDone() })
        const doc2 = legacy.container().ownerDocument
        openAlerts(doc2, legacy)
        const diag2 = doc2.querySelector('.btcd-alert-diag')
        check(diag2 !== null, '老宿主载荷下也有自检块')
        check(diag2 !== null && diag2.textContent.indexOf('条件不满足') >= 0,
          '显示"条件不满足"', diag2 === null ? '' : diag2.textContent)
        check(diag2 !== null && diag2.textContent.indexOf('没有 done 标记') >= 0,
          '说清是缺 done 标记', diag2 === null ? '' : diag2.textContent)
        check(diag2 !== null && diag2.className.indexOf('btcd-alert-diag-bad') >= 0,
          '不满足时染红', diag2 === null ? '' : diag2.className)
        await legacy.unmount()
      }
    }
  }

  // ---- 判据记录：每次判定都要能回答"为什么中/为什么没中"
  {
    const mk2 = (ts, close, done) => [ts, close, close + 1, close - 1, close, 10, done === false ? 0 : 1]
    const candles2 = [mk2(1000, 100), mk2(2000, 100), mk2(3000, 100), mk2(4000, 110)]
    const ruleUp = { id: 'r1', emaPeriod: 20, dir: 'up', bar: '3m', on: true }

    // 命中：把判据也带出来
    const hitV = d.evalAlertVerdict(ruleUp, candles2, [null, 100, 100, 105], 3, 1)
    check(hitV.verdict === 'hit', '命中时 verdict=hit', String(hitV.verdict))
    check(hitV.hit !== undefined && hitV.hit.text.indexOf('收线上穿 EMA20') === 0,
      '命中时带上给用户看的文案', hitV.hit === undefined ? '' : hitV.hit.text)
    check(hitV.prevClose === 100 && hitV.nowClose === 110, '判据里带前收/今收',
      JSON.stringify([hitV.prevClose, hitV.nowClose]))
    check(hitV.prevEma === 100 && hitV.nowEma === 105, '判据里带前均/今均',
      JSON.stringify([hitV.prevEma, hitV.nowEma]))
    check(hitV.ts === 4000, '判据里带那根的收线时刻', String(hitV.ts))

    // 各种"没中"的原因都要能区分开
    check(d.evalAlertVerdict({ id: 'r', emaPeriod: 20, dir: 'up', bar: '3m', on: false },
      candles2, [null, 1, 1, 1], 3, 1).verdict === 'off', '暂停 → off')
    check(d.evalAlertVerdict(null, candles2, [null, 1, 1, 1], 3, 1).verdict === 'no-rule', '没有规则 → no-rule')
    check(d.evalAlertVerdict(ruleUp, candles2, [null, 1, 1, 1], 0, 1).verdict === 'bad-index',
      '下标 0（没有上一根）→ bad-index')
    check(d.evalAlertVerdict(ruleUp, candles2, [null, 1, 1, 1], 99, 1).verdict === 'bad-index',
      '下标越界 → bad-index')
    check(d.evalAlertVerdict(ruleUp, candles2, [null, null, null, null], 3, 1).verdict === 'no-ema',
      '均线没预热出值 → no-ema')
    check(d.evalAlertVerdict(ruleUp,
      [mk2(1000, 100), mk2(2000, 100), mk2(3000, 100), [4000, 1, 2, 0, 'x', 10, 1]],
      [null, 1, 1, 1], 3, 1).verdict === 'bad-close', '收盘价不是数字 → bad-close')
    check(d.evalAlertVerdict(ruleUp, candles2, [null, 90, 92, 100], 3, 1).verdict === 'side-same',
      '上一根已在均线这一侧 → side-same')
    check(d.evalAlertVerdict(ruleUp, candles2, [null, 100, 100, 120], 3, 1).verdict === 'side-crossed-wrong-way',
      '这一根没穿过去 → side-crossed-wrong-way')
    // 每个 verdict 都得有中文说明（不然看板显示一堆英文码）
    for (const code of Object.keys(d.VERDICT_TEXT)) {
      check(d.verdictText(code) !== code, 'verdict 有中文说明：' + code, d.verdictText(code))
    }
    check(d.verdictText('不存在的码') === '不存在的码', '未知码原样返回')
    // 失败也要有判据文案 —— 早先"判定抛错"会直接 return，表现是"判据日志一直不动"，
    // 而自检块走别的分支照常更新，看起来就像"日志不刷新"。真踩过，所以这条钉死。
    check(d.verdictText('failed') !== 'failed', '判定抛错有专门的判据文案', d.verdictText('failed'))
    check(typeof d.VERDICT_TEXT.failed === 'string' && d.VERDICT_TEXT.failed.length > 0,
      'failed 在判据表里', String(d.VERDICT_TEXT.failed))

    // 批量：参与判定的记判据，被跳过的记原因
    const lines2 = [
      { item: { id: 'f', period: 20, show: true }, series: [null, 100, 100, 105] },
      { item: { id: 's', period: 60, show: true }, series: [null, 100, 100, 105] },
    ]
    const rules2 = [
      { id: 'a', emaPeriod: 20, dir: 'up', bar: '3m', on: true },    // 命中
      { id: 'b', emaPeriod: 20, dir: 'down', bar: '3m', on: true },  // 方向反，不中
      { id: 'c', emaPeriod: 20, dir: 'up', bar: '1h', on: true },    // 别的周期 → 跳过
      { id: 'e', emaPeriod: 20, dir: 'up', bar: '3m', on: false },   // 暂停 → 跳过
    ]
    const out2 = d.evalAlerts(rules2, candles2, lines2, 3, '3m', 1)
    check(out2.hits.length === 1 && out2.hits[0].ruleId === 'a', '只有 a 命中',
      JSON.stringify(out2.hits.map((h) => h.ruleId)))
    check(out2.verdicts.length === 2, '参与判定的记两条判据', String(out2.verdicts.length))
    check(out2.verdicts.map((v) => v.verdict).sort().join(',') === 'hit,side-crossed-wrong-way',
      'b 的判据写明"没穿过去"', JSON.stringify(out2.verdicts.map((v) => [v.ruleId, v.verdict])))
    check(out2.skipped.length === 2, '被跳过的记两条', String(out2.skipped.length))
    check(out2.skipped.map((s) => s.verdict).sort().join(',') === 'not-this-bar,off',
      '跳过原因区分"别的周期"与"暂停"', JSON.stringify(out2.skipped.map((s) => [s.ruleId, s.verdict])))
    check(d.evalAlerts([], candles2, lines2, 3, '3m', 1).hits.length === 0, '没有规则时安全')
    check(d.evalAlerts(null, candles2, lines2, 3, '3m', 1).verdicts.length === 0, 'null 规则安全')

    // 日志追加与规范化
    let log2 = d.evalLogAdd([], { at: 100, verdict: 'hit', bar: '3m', emaPeriod: 20, dir: 'up' })
    check(log2.length === 1, '加一条判据', String(log2.length))
    log2 = d.evalLogAdd(log2, { at: 200, verdict: 'side-same', bar: '3m', emaPeriod: 20, dir: 'up' })
    check(log2[0].at === 200, '新的在前', String(log2[0].at))
    check(d.evalLogAdd(null, null).length === 0, 'null 判据安全')
    let bigEval = []
    for (let i = 0; i < d.ALERT_MAX_EVALS + 5; i += 1) bigEval = d.evalLogAdd(bigEval, { at: i, verdict: 'side-same' })
    check(bigEval.length === d.ALERT_MAX_EVALS, '判据条数封顶', String(bigEval.length))
    const dirtyEval = d.normalizeEvalLog([
      { at: 1, verdict: 'hit', bar: '3m' },
      null,
      { at: 2 },                       // 没 verdict → 丢
      { at: 'x', verdict: 'off' },     // 时间非法 → 归 0
    ])
    check(dirtyEval.length === 2, '脏判据清成 2 条', String(dirtyEval.length))
    check(dirtyEval[1].at === 0, '非法时间归 0', String(dirtyEval[1].at))

    // 导出文本：要包含关键信息，能直接贴给别人
    const diagText = d.formatEvalDiag({
      at: 1780000000000, bar: '3m', rules: 2,
      health: { count: 1800, withDone: 1800, doneCount: 1799, ready: true, lastDoneTs: 1780000000000 },
      cursor: 1780000000000, fires: 7, expect: 7,
      evals: [{
        at: 1780000000000, bar: '3m', idx: 5, ts: 1780000000000, verdict: 'side-same',
        ruleId: 'a', emaPeriod: 20, dir: 'up', prevClose: 100, nowClose: 101, prevEma: 99, nowEma: 100,
      }],
    })
    check(typeof diagText === 'string' && diagText.length > 80, '导出的自检文本不是空的',
      String(diagText.length) + ' 字符')
    for (const needle of ['收线预警自检', '周期: 3m', '带 done 1800',
      '确认新收线的次数(应判): 7', '实际跑完判定的次数(判定): 7', '应判 > 判定',
      'side-same', '上一根就已经在均线这一侧了', '前收 100']) {
      check(diagText.indexOf(needle) >= 0, '自检文本包含「' + needle + '」')
    }
    check(d.formatEvalDiag(null).indexOf('收线预警自检') >= 0, 'null 输入也能导出（不炸）')
    check(d.ALERT_EVAL_KEY === 'dsh-btc-dashboard:alert-eval', '判据日志的存储键', d.ALERT_EVAL_KEY)
  }

  // ---- 判据日志：刷新时机（纯逻辑）
  //
  // 说明：**判据只在"新收一根"时产生一条**，不是每次 5 秒轮询都写 ——
  // 否则 40 条上限只够存 3 分钟的日志，真正的判据反而被刷掉了。
  // 所以"看着不刷新"是正常的；为了让人能确认它**在工作**，自检块里另有一个
  // 每秒都在跳的"最近检查"时间戳（不写进日志，所以不会淹掉判据）。
  {
    // 日志只在有判定结果时增长
    const entry = { at: 1, verdict: 'side-same', bar: '15m', emaPeriod: 20, dir: 'up' }
    let log = []
    check(d.evalLogAdd(log, null) === log, '没有判定结果时不加（引用都不变）')
    log = d.evalLogAdd(log, entry)
    check(log.length === 1, '有判定结果才加', String(log.length))
    // 上限：40 条，够存 40 根收线的判据（15m 上就是 10 小时）
    check(d.ALERT_MAX_EVALS === 40, '判据上限 40 条', String(d.ALERT_MAX_EVALS))
    // 每次判定只记当前这一根：同一条规则同一根可以有"这一次"的判据，
    // 但日志是按"每次判定一条"追加的，所以同一根重复判会出现多条 —— 用时间戳区分
    const twice = d.evalLogAdd(log, Object.assign({}, entry, { at: 2 }))
    check(twice.length === 2 && twice[0].at === 2, '同一根的两次判定各记一条（时间戳不同）',
      String(twice.length))
  }

  // ---- 复现："面板保持打开时，新判据会不会自己出现"
  // 用户实测：自检块实时刷新，但判据日志要收起再展开才更新。这里把它抓出来。
  {
    const dom15 = createInteractiveDom()
    if (dom15 === null) {
      console.log('     跳过「判据日志实时刷新」复现：环境里找不到 jsdom')
    } else {
      /** 带 done 的板子：前 closedCount 根已收盘，其余未收盘 */
      const mkB = function (n, closedCount) {
        const b = makeBoard(n)
        b.bars = [
          { id: '1m', label: '1m' }, { id: '3m', label: '3m' }, { id: '15m', label: '15m' },
          { id: '1h', label: '1h' }, { id: '4h', label: '4h' }, { id: '1D', label: '1D' },
        ]
        b.candles = b.candles.map((c, i) => c.concat([i < closedCount ? 1 : 0]))
        return b
      }
      await dom15.mount({ board: mkB(120, 119) })
      const docEl = dom15.container().ownerDocument
      const findExact = function (t) {
        for (const b of docEl.querySelectorAll('button')) if (b.textContent.trim() === t) return b
        return null
      }
      const findPrefix = function (t) {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf(t) === 0) return b
        }
        return null
      }
      const evalRows = function () { return docEl.querySelectorAll('.btcd-alert-evalrow') }
      const diagText = function () {
        const el = docEl.querySelector('.btcd-alert-diag')
        return el === null ? '' : el.textContent
      }

      // 打开预警 + 加一条规则（绑当前周期）——之后**不再碰面板**
      dom15.click(findPrefix('预警'))
      dom15.click(findExact('＋ 新增规则'))
      await dom15.settle(500)
      check(diagText().indexOf('应判') >= 0, '自检块已在（开着的面板里）', diagText())
      const rowsBefore = evalRows().length

      // （A）预置一条判据到**这一份 window** 的存储里，然后挂载 → 应该读回来并渲染
      dom15.win().localStorage.setItem('dsh-btc-dashboard:alert-eval', JSON.stringify([
        { at: Date.now() - 1000, bar: '1m', idx: 5, ts: 1780000000000, verdict: 'side-same', ruleId: 'x', emaPeriod: 20, dir: 'up', prevClose: 100, nowClose: 101, prevEma: 99, nowEma: 100 },
      ]))
      const dom16 = createInteractiveDom()
      if (dom16 === null) {
        console.log('     跳过后续判据渲染测试')
      } else {
        dom16.win().localStorage.setItem('dsh-btc-dashboard:alert-eval', JSON.stringify([
          { at: Date.now() - 1000, bar: '1m', idx: 5, ts: 1780000000000, verdict: 'side-same', ruleId: 'x', emaPeriod: 20, dir: 'up', prevClose: 100, nowClose: 101, prevEma: 99, nowEma: 100 },
        ]))
        await dom16.mount({ board: mkB(120, 119) })
        const doc16 = dom16.container().ownerDocument
        for (const b of doc16.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('预警') === 0) { dom16.click(b); break }
        }
        // 一根一行：不再逐条规则平铺原因（用户要求"不需要显示原因"）
        check(doc16.querySelectorAll('.btcd-alert-evalrow').length === 1,
          '从存储里读回的判据会被渲染出来（一根一行）',
          String(doc16.querySelectorAll('.btcd-alert-evalrow').length))
        const evalRowText = doc16.querySelector('.btcd-alert-evalrow').textContent
        check(evalRowText.indexOf('收线') >= 0 && evalRowText.indexOf('今收') >= 0
          && evalRowText.indexOf('前收') >= 0,
        '那一行带着收线时刻与四个数字', evalRowText)
        check(evalRowText.indexOf('没有"穿"的动作') < 0
          && evalRowText.indexOf('这一根没穿过去') < 0
          && evalRowText.indexOf('命中：穿过去了') < 0,
        '行里不再写"为什么"（原因只在「复制自检」里）', evalRowText)
        check(doc16.body.textContent.indexOf('判据日志（1 条') >= 0, '标题里的条数也对',
          String((doc16.body.textContent.match(/判据日志（[^）]*）/) || [])))
        await dom16.unmount()
      }
      void rowsBefore
    }
  }

  // ---- 判据分组：一次收线给每条规则各写一条，按"收线时刻"归并；并算出断档
  {
    // 用用户贴的那组数据造：同一根收线、两条规则、结论相反
    const log = d.normalizeEvalLog([
      { at: 1780000058000, bar: '1m', idx: 10, ts: 1780000057000, verdict: 'side-same', ruleId: 'up', emaPeriod: 20, dir: 'up', prevClose: 86350.0, nowClose: 86260.3, prevEma: 86318.4, nowEma: 86312.9 },
      { at: 1780000058000, bar: '1m', idx: 10, ts: 1780000057000, verdict: 'hit', ruleId: 'dn', emaPeriod: 20, dir: 'down', prevClose: 86350.0, nowClose: 86260.3, prevEma: 86318.4, nowEma: 86312.9 },
      { at: 1780000050000, bar: '1m', idx: 2, ts: 1780000049000, verdict: 'side-crossed-wrong-way', ruleId: 'dn', emaPeriod: 20, dir: 'down', prevClose: 86292.7, nowClose: 86345.9, prevEma: 86243.7, nowEma: 86253.4 },
      { at: 1780000050000, bar: '1m', idx: 2, ts: 1780000049000, verdict: 'side-same', ruleId: 'up', emaPeriod: 20, dir: 'up', prevClose: 86292.7, nowClose: 86345.9, prevEma: 86243.7, nowEma: 86253.4 },
    ])
    check(log.length === 4, '四条判据都读回来了', String(log.length))
    const groups = d.groupVerdicts(log)
    check(groups.length === 2, '归并成两根（同一次收线的多条规则合成一组）', String(groups.length))
    check(groups[0].ts === 1780000057000, '新的那根在前', String(groups[0].ts))
    check(groups[0].items.length === 2, '那根下面挂着两条规则', String(groups[0].items.length))
    check(groups[0].nowClose === 86260.3 && groups[0].nowEma === 86312.9,
      '这一根的数字只显示一次（不重复四遍）', JSON.stringify([groups[0].nowClose, groups[0].nowEma]))
    check(groups[1].items.length === 2, '另一根也挂着两条', String(groups[1].items.length))

    // 断档：这两根的收线时刻差了 8 秒（1m 周期下就是断档，因为正常只差 60 秒）
    const gap = d.verdictGapMs(groups, 0)
    check(gap === 8000, '算出两根之间的间隔（8000ms）', String(gap))
    check(d.verdictGapMs(groups, 1) === null, '最后一根没有"上一根"，返回 null')
    check(d.verdictGapMs([], 0) === null, '空列表安全')
    check(d.verdictGapMs(null, 0) === null, 'null 安全')
    // 同一时刻的两条不会被拆成两组
    const oneBar = d.groupVerdicts([
      { ts: 1000, bar: '1m', at: 5, verdict: 'hit', emaPeriod: 20, dir: 'up' },
      { ts: 1000, bar: '1m', at: 5, verdict: 'side-same', emaPeriod: 20, dir: 'down' },
    ])
    check(oneBar.length === 1 && oneBar[0].items.length === 2, '同一根的判据归到一组',
      String(oneBar.length))
    // 不同周期/不同时刻要分开
    const mixed = d.groupVerdicts([
      { ts: 1000, bar: '1m', at: 5, verdict: 'hit', emaPeriod: 20, dir: 'up' },
      { ts: 2000, bar: '1m', at: 5, verdict: 'hit', emaPeriod: 20, dir: 'up' },
      { ts: 1000, bar: '15m', at: 5, verdict: 'hit', emaPeriod: 20, dir: 'up' },
    ])
    check(mixed.length === 3, '不同时刻 / 不同周期各自成组', String(mixed.length))
    check(d.groupVerdicts(null).length === 0, 'null 安全')
    check(d.groupVerdicts([]).length === 0, '空安全')
  }

  // ---- 邮件通道：配置规范化 + 发信载荷
  {
    // 规范化：坏值一律退回安全默认
    const e0 = d.normalizeEmail(null)
    check(e0.enabled === false && e0.to === '' && e0.authorized === false,
      'null 邮件配置退回安全默认', JSON.stringify(e0))
    check(d.normalizeEmail({ enabled: 'yes' }).enabled === false, 'enabled 只认真 true')
    check(d.normalizeEmail({ to: 'a@b.com', authorized: true }).authorized === true, 'authorized 透传')
    check(d.normalizeEmail({ sentCount: 'x' }).sentCount === 0, '非法 sentCount 归 0')
    check(d.normalizeEmail({ lastSentAt: 'y' }).lastSentAt === null, '非法 lastSentAt 归 null')
    check(d.EMAIL_STORE_KEY === 'dsh-btc-dashboard:email', '邮件缓存的存储键', d.EMAIL_STORE_KEY)

    // 发信载荷：要带规则 / 周期 / 那根 K 线的数据
    const candles9 = [[1780000000000, 100, 110, 90, 105, 12, 1], [1780000060000, 105, 120, 100, 118, 30, 1]]
    const hit9 = {
      ruleId: 'r1', dir: 'up', emaPeriod: 20, ts: 1780000060000, close: 118, ema: 112,
      text: '收线上穿 EMA20 · 收盘 118.0 / 均线 112.0',
    }
    const payload9 = d.alertEmailPayload(hit9, '1m', candles9, 1, 'BTC-USDT-SWAP', [
      { dir: 'up', emaPeriod: 20, bar: '1m', on: true },
      { dir: 'down', emaPeriod: 480, bar: '15m', on: false },
    ])
    check(payload9.rule === '收盘上穿 EMA20', '载荷里带命中的规则', payload9.rule)
    check(payload9.bar === '1m', '载荷里带周期', payload9.bar)
    check(payload9.ts === 1780000060000, '载荷里带收线时刻', String(payload9.ts))
    check(payload9.instId === 'BTC-USDT-SWAP', '载荷里带合约', payload9.instId)
    // 邮件文案要随标的：看板切到 ETH 后 AlertEngine 传的是 board.instId，载荷里的合约跟着变
    check(d.alertEmailPayload(hit9, '1m', candles9, 1, 'ETH-USDT-SWAP', []).instId === 'ETH-USDT-SWAP',
      '载荷里的合约跟随当前标的（ETH-USDT-SWAP）')
    check(payload9.price.close === 118 && payload9.price.ema === 112, '载荷里带收盘价与均线值',
      JSON.stringify(payload9.price))
    check(payload9.candle !== null && payload9.candle.o === 105 && payload9.candle.h === 120
      && payload9.candle.l === 100 && payload9.candle.c === 118 && payload9.candle.v === 30,
    '载荷里带触发那根 K 线的 OHLCV', JSON.stringify(payload9.candle))
    check(payload9.rules.length === 2 && payload9.rules[1].on === false,
      '载荷里带当前规则清单（含暂停状态）', JSON.stringify(payload9.rules))
    // 越界 / 缺失都要安全
    check(d.alertEmailPayload(hit9, '1m', candles9, 99, '', []).candle === null, '下标越界时不带 K 线')
    check(d.alertEmailPayload(hit9, '1m', candles9, -1, 'X', []).candle === null, '负下标安全')
    check(d.alertEmailPayload(hit9, null, null, 0, '', null).bar === '', 'null 周期安全')
    check(d.alertEmailPayload(hit9, '1m', candles9, 1, 'X', null).rules.length === 0, 'null 规则清单安全')
  }

  // ---- 最基本的前提：面板挂着不动时，**它到底还会不会自己重渲染**
  //
  // 用户反馈"过了几分钟没有任何刷新"，连自检块的"最近检查"时间戳都不动了。
  // 那个时间戳靠每秒重渲染驱动，所以先验这一条：不给任何输入，面板自己会不会动。
  {
    const dom17 = createInteractiveDom()
    if (dom17 === null) {
      console.log('     跳过「面板自走」测试：环境里找不到 jsdom')
    } else {
      await dom17.mount()
      const docEl = dom17.container().ownerDocument
      const findPrefix17 = function (t) {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf(t) === 0) return b
        }
        return null
      }
      const findExact17 = function (t) {
        for (const b of docEl.querySelectorAll('button')) if (b.textContent.trim() === t) return b
        return null
      }
      /** 自检块里的"最近检查 …HH:MM.SS"：取末尾那段时间 */
      const diagClock = function () {
        const el = docEl.querySelector('.btcd-alert-diag')
        if (el === null) return null
        const m = el.textContent.match(/(\d{2}:\d{2}\.\d{2})/)
        return m === null ? null : m[1]
      }
      /** 面板里所有"时:分"读数（用来整体判断在不在走） */
      const clockBits = function () {
        return (docEl.body.textContent.match(/\d{1,2}:\d{2}(:\d{2})?(\.\d{2})?/g) || []).join(',')
      }
      dom17.click(findPrefix17('预警'))
      dom17.click(findExact17('＋ 新增规则'))
      await dom17.settle(1200)

      const diag1 = diagClock()
      check(diag1 !== null, '能读到自检块的"最近检查"', String(diag1))
      const bits1 = clockBits()
      // 连采 6 次（每 700ms 一次）：区分"从没动"和"动了几下就停"
      const samples = []
      for (let s = 0; s < 6; s += 1) {
        await dom17.settle(700)
        samples.push(diagClock())
      }
      const uniqueSamples = Array.from(new Set(samples.filter((x) => x !== null)))
      check(uniqueSamples.length > 1,
        '不给任何输入，自检块的"最近检查"会自己走（面板真的在重渲染）',
        '采样=' + JSON.stringify(samples) + ' | 首值=' + String(diag1)
        + ' | visibilityState=' + String(docEl.visibilityState))
    }
  }

  // ---- 邮件通道的界面：地址要能回填、开关不能清空地址、试一下能发测试邮件
  {
    const dom18 = createInteractiveDom()
    if (dom18 === null) {
      console.log('     跳过「邮件通道界面」测试：环境里找不到 jsdom')
    } else {
      // 预置"上次已经填好并确认过"的地址（模拟用户关掉面板再打开）
      const win18 = dom18.win()
      const st18 = dom18.emailState()
      st18.enabled = true
      st18.to = 'me@qq.com'
      st18.confirmed = 'me@qq.com'
      st18.confirmedAt = Date.now() - 3600000
      win18.localStorage.setItem('dsh-btc-dashboard:email', JSON.stringify({
        enabled: true, to: 'me@qq.com', confirmed: 'me@qq.com', authorized: true, available: true,
      }))
      // 确认框一律同意（jsdom 没有 confirm，实现里会当同意；这里显式给一个假的更真实）
      let confirmAsked = 0
      win18.confirm = function () { confirmAsked += 1; return true }

      await dom18.mount()
      const docEl = dom18.container().ownerDocument
      const openAlerts = function () {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('预警') === 0) { dom18.click(b); return }
        }
      }
      const emailInput = function () { return docEl.querySelector('.btcd-email-to') }
      const emailBtn = function () { return docEl.querySelector('.btcd-email-btn') }
      const findPrefix18 = function (t) {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf(t) === 0) return b
        }
        return null
      }
      const findExact18 = function (t) {
        for (const b of docEl.querySelectorAll('button')) if (b.textContent.trim() === t) return b
        return null
      }
      openAlerts()
      await dom18.settle(400)
      check(emailInput() !== null, '面板里有邮件地址输入框')
      check(emailInput().value === 'me@qq.com',
        '打开警报看板时地址自动回填（不会被空值锁住）', JSON.stringify(emailInput().value))
      // 开关按钮用颜色说话：开启=绿、关闭=红
      check(emailBtn() !== null, '有邮件开关按钮')
      check(emailBtn().className.indexOf('btcd-email-btn-on') >= 0,
        '邮件提醒开着时按钮是绿色态', emailBtn().className)
      check(emailBtn().className.indexOf('btcd-email-btn-off') < 0,
        '绿色态不该同时挂红色类', emailBtn().className)
      check(emailBtn().textContent.indexOf('关闭') >= 0,
        '已开启且已确认时，按钮是「关闭邮件提醒」', emailBtn().textContent)

      // 关掉开关：地址必须留着，不能清空
      const toggle18 = emailBtn()
      dom18.click(toggle18)
      await dom18.settle(400)
      const posts18 = dom18.emailPosts()
      check(posts18.length >= 1, '关开关时提交了一次 /email', String(posts18.length))
      // 关掉时**不该**把空地址当成"新地址"提交上去
      check(posts18[posts18.length - 1].enabled === false, '提交的是 enabled=false',
        JSON.stringify(posts18[posts18.length - 1]))
      check(posts18[posts18.length - 1].to === undefined,
        '关闭时不提交地址（关闭 ≠ 清空）', JSON.stringify(posts18[posts18.length - 1]))
      check(st18.to === 'me@qq.com', '关掉开关后服务端存的地址没被清掉', JSON.stringify(st18.to))
      check(emailInput().value === 'me@qq.com',
        '关掉开关后输入框里地址还在（这就是被报的"点开关地址被清空"）',
        JSON.stringify(emailInput().value))
      check(confirmAsked === 0, '关掉不需要弹确认', String(confirmAsked))
      // 关掉后按钮必须变红
      check(emailBtn().className.indexOf('btcd-email-btn-off') >= 0,
        '关掉后按钮变红色态', emailBtn().className)
      check(emailBtn().className.indexOf('btcd-email-btn-on') < 0,
        '红色态不该同时挂绿色类', emailBtn().className)
      check(emailBtn().textContent.indexOf('开启') >= 0,
        '关闭后按钮变成「开启邮件提醒」（用户报过"只有关闭按键"）', emailBtn().textContent)

      // 再打开：地址与已确认一致 → 不该重复问确认，按钮回到绿色
      dom18.click(emailBtn())
      await dom18.settle(400)
      check(st18.enabled === true && st18.to === 'me@qq.com', '重新打开后地址仍是 me@qq.com',
        JSON.stringify([st18.enabled, st18.to]))
      check(confirmAsked === 0, '地址没变时不该重复弹确认', String(confirmAsked))
      check(emailBtn().className.indexOf('btcd-email-btn-on') >= 0,
        '重新打开后按钮变回绿色态', emailBtn().className)

      // **回归用户报的原始症状**：开关开着、但地址被改过（授权失效）时，
      // 按钮必须回到"开启"，点一下要能"重新确认并开启"，而不是只能关闭。
      st18.to = 'changed@qq.com'
      st18.confirmed = 'me@qq.com'
      await dom18.settle(300)
      dom18.click(findPrefix18('预警'))
      dom18.click(findPrefix18('预警'))
      await dom18.settle(500)
      check(emailBtn().className.indexOf('btcd-email-btn-off') >= 0,
        '开着但授权失效 → 按钮回到红色（"开启"态）', emailBtn().className + ' | ' + emailBtn().textContent)
      check(emailBtn().textContent.indexOf('开启') >= 0,
        '开着但授权失效 → 按钮文案是「开启邮件提醒」', emailBtn().textContent)
      const asksBefore = confirmAsked
      dom18.click(emailBtn())
      await dom18.settle(500)
      check(confirmAsked > asksBefore, '点「开启」时会重新弹一次确认', String(confirmAsked))
      check(st18.confirmed === 'changed@qq.com',
        '重新确认后授权覆盖了新地址', JSON.stringify([st18.to, st18.confirmed]))
      check(emailBtn().className.indexOf('btcd-email-btn-on') >= 0,
        '重新确认后按钮变绿', emailBtn().className)

      // 「试一下」在配好邮箱后要真的发一封测试邮件
      const before18 = dom18.notified().length
      dom18.click(findExact18('试一下'))
      await dom18.settle(500)
      const sent18 = dom18.notified()
      check(sent18.length === before18 + 1, '「试一下」发了一封测试邮件',
        '前 ' + String(before18) + ' → 后 ' + String(sent18.length))
      check(sent18[sent18.length - 1].test === true, '测试邮件的载荷带 test 标记',
        JSON.stringify(sent18[sent18.length - 1]))
      check(st18.sentCount === 1, '服务端记了一次发送', String(st18.sentCount))
      await dom18.unmount()

      // 没配邮箱时「试一下」不该发邮件
      const dom19 = createInteractiveDom()
      if (dom19 !== null) {
        await dom19.mount()
        const doc19 = dom19.container().ownerDocument
        for (const b of doc19.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('预警') === 0) { dom19.click(b); break }
        }
        await dom19.settle(300)
        for (const b of doc19.querySelectorAll('button')) {
          if (b.textContent.trim() === '试一下') { dom19.click(b); break }
        }
        await dom19.settle(400)
        check(dom19.notified().length === 0, '没开邮件提醒时「试一下」不发邮件',
          String(dom19.notified().length))
        await dom19.unmount()
      }
    }
  }

  // ---- 邮件开关：保存失败也不能把按钮卡成灰色，地址也不能丢
  {
    const dom20 = createInteractiveDom()
    if (dom20 === null) {
      console.log('     跳过「邮件保存失败」测试：环境里找不到 jsdom')
    } else {
      const win20 = dom20.win()
      win20.confirm = function () { return true }
      await dom20.mount()
      const docEl = dom20.container().ownerDocument
      const openAlerts = function () {
        for (const b of docEl.querySelectorAll('button')) {
          if (b.textContent.trim().indexOf('预警') === 0) { dom20.click(b); return }
        }
      }
      const emailInput = function () { return docEl.querySelector('.btcd-email-to') }
      const emailBtn = function () { return docEl.querySelector('.btcd-email-btn') }
      // 让 /email 的 POST 失败（模拟宿主没起来 / 没装 dsh-qq-email）
      dom20.failEmailPost.set(true)
      openAlerts()
      await dom20.settle(400)

      // 现在输入框真的能被驱动了（早先这里"怎么都触发不了 onChange"的根因是
      // react-dom 在 jsdom 全局装好之前就被 require，退到了 IE9 polyfill —— 见
      // createInteractiveDom 里加载顺序的注释）。断言重点仍是"保存失败后按钮不能卡死"，
      // 顺带把"地址确实进了输入框 / 进了 POST 体"也钉住。
      dom20.type(emailInput(), 'me@qq.com')
      await dom20.settle(200)
      check(emailInput().value === 'me@qq.com', '地址真的敲进了输入框（onChange 已被驱动）',
        JSON.stringify(emailInput().value))
      check(emailBtn().disabled !== true, '填过地址后按钮可点',
        'disabled=' + String(emailBtn().disabled))
      check(docEl.body.textContent.indexOf('开启邮件提醒') >= 0
        || docEl.body.textContent.indexOf('关闭邮件提醒') >= 0,
      '按钮上写着明确的动作（开启 / 关闭）')

      dom20.click(emailBtn())
      await dom20.settle(700)
      check(dom20.emailPosts().length === 1 && dom20.emailPosts()[0].to === 'me@qq.com',
        '保存失败那次 POST 也带上了输入框里的地址',
        JSON.stringify(dom20.emailPosts()))

      // **核心回归**：保存失败后按钮必须恢复可点 —— 用户报的"点一下变灰、关不掉了"
      check(emailBtn().disabled !== true,
        '保存失败后按钮没有卡在 disabled（用户报过"点一下变灰、关不掉了"）',
        'disabled=' + String(emailBtn().disabled) + ' class=' + emailBtn().className)
      check(docEl.body.textContent.indexOf('保存失败') >= 0
        || docEl.body.textContent.indexOf('邮件设置没保存') >= 0
        || docEl.body.textContent.indexOf('先填一个收件邮箱地址') >= 0,
      '失败/缺地址都有可见反馈（不是静默）')

      // 失败之后再点一次仍然能发出请求（如果真的卡死了这一步会 fail）
      const postsBefore = dom20.emailPosts().length
      dom20.click(emailBtn())
      await dom20.settle(600)
      check(dom20.emailPosts().length > postsBefore || emailBtn().disabled !== true,
        '再点一次仍然可用（没有卡死）',
        '请求数 ' + String(postsBefore) + ' → ' + String(dom20.emailPosts().length)
        + '，disabled=' + String(emailBtn().disabled))
      await dom20.unmount()
    }
  }

  // ---- 邮件是可选依赖：宿主没装 dsh-qq-email 时，面板要直接给"去哪装"的提示；
  //      点「开启」也不能白弹确认框 / 发无意义的保存请求（用户 2026-11 提的验收点）
  {
    const dom21 = createInteractiveDom()
    if (dom21 === null) {
      console.log('     跳过「邮件缺依赖提示」测试：环境里找不到 jsdom')
    } else {
      const win21 = dom21.win()
      let confirmAsked21 = 0
      win21.confirm = function () { confirmAsked21 += 1; return true }
      const st21 = dom21.emailState()
      st21.available = false
      await dom21.mount()
      const docEl = dom21.container().ownerDocument
      for (const b of docEl.querySelectorAll('button')) {
        if (b.textContent.trim().indexOf('预警') === 0) { dom21.click(b); break }
      }
      await dom21.settle(400)
      const emailInput = docEl.querySelector('.btcd-email-to')
      const emailBtn = docEl.querySelector('.btcd-email-btn')
      check(emailInput !== null && emailBtn !== null, '缺依赖时邮件控件照样渲染（面板不崩）')
      check(docEl.body.textContent.indexOf('dsh-qq-email') >= 0,
        '缺依赖时面板直接提示要装 dsh-qq-email')
      check(docEl.body.textContent.indexOf('插件市场') >= 0,
        '提示里给出安装去处（插件市场 / 发现）')
      dom21.type(emailInput, 'me@qq.com')
      await dom21.settle(200)
      const postsBefore21 = dom21.emailPosts().length
      dom21.click(emailBtn)
      await dom21.settle(500)
      check(dom21.emailPosts().length === postsBefore21,
        '缺依赖时点「开启」不发保存请求（先提示安装）',
        '请求数 ' + String(postsBefore21) + ' → ' + String(dom21.emailPosts().length))
      check(confirmAsked21 === 0, '缺依赖时点「开启」不白弹一次确认框', String(confirmAsked21))
      check(docEl.body.textContent.indexOf('dsh-qq-email') >= 0,
        '点「开启」后的提示里带着 dsh-qq-email（可执行）')
      await dom21.unmount()
    }
  }

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

// ---------------------------------------------------------------- 4.10) 回测面板（jsdom 交互）
//
// 契约：backtest/INTEGRATION-SPEC.md §4.2 的**文案是断言依据**，§5 要求这一段覆盖：
//   打开面板默认值 / 表单提交换算 / 轮询进度→完成渲染 / 错误态 / 取消 / 打开完整报告 /
//   参数输入 / localStorage 回填 / Esc 关闭。
// Host 的 job 状态机（单任务、超时、summary 裁剪、报告安全头）由 tests/backtest-route-test.mjs
// 独立覆盖；这里只验"浏览器端怎么用这些接口、怎么把 job 状态画成界面"。
{
  const failedBefore = failed
  const DAY_MS = 86400000
  const UTC8_OFFSET_MS = 8 * 3600000

  /** 毫秒 → UTC+8 的 YYYY-MM-DD（和面板里的 btDateText 同口径；期望值在测试里自己算，不抄实现） */
  function btDayText(ms) {
    const d = new Date(Number(ms) + UTC8_OFFSET_MS)
    return d.toISOString().slice(0, 10)
  }
  /** UTC+8 的今天 */
  function btTodayUtc8() {
    return btDayText(Date.now())
  }
  /** UTC+8 某天零点的毫秒（契约 §4.2 的日期口径） */
  function btDayMs(text) {
    return Date.parse(text + 'T00:00:00+08:00')
  }

  const BT_START_MS = btDayMs('2026-01-01')
  // 右开区间：summary.end 是 2026-04-01，用户看到的结束日期应该是 2026-03-31
  const BT_END_OPEN_MS = btDayMs('2026-04-01')

  /**
   * 一份"回测完成"的 job（形状按契约 §2.3 / §2.5；数值挑能一眼对上的）。
   * 60 个权益点足够让资金曲线真的画线（canvas 落笔数断言要用）。
   */
  function btDoneJob() {
    const barMs = 3600000
    const equity = []
    for (let i = 0; i < 60; i += 1) {
      equity.push({ t: BT_START_MS + i * 24 * barMs, equity: 10000 + i * 20, bh: 10000 - i * 5 })
    }
    return {
      id: 'bt-test-1',
      state: 'done',
      phase: 'done',
      message: '回测完成',
      progress: { pages: 12, bars: 2160, pct: 100 },
      startedAt: BT_START_MS,
      finishedAt: BT_START_MS + 3421,
      elapsedMs: 3421,
      cancelRequested: false,
      error: null,
      summary: {
        generatedAt: 1792237999000,
        instId: 'BTC-USDT-SWAP',
        bar: '1h',
        strategy: { name: 'sma-cross', params: { fast: 13, slow: 60, allowShort: false } },
        start: BT_START_MS,
        end: BT_END_OPEN_MS,
        range: { bars: 2160, firstT: BT_START_MS, lastT: BT_END_OPEN_MS - barMs, days: 90 },
        initialEquity: 10000,
        finalEquity: 11234,
        metrics: {
          totalReturnPct: 12.34, annualizedReturnPct: 55.55, maxDrawdownPct: -5.67,
          sharpe: 1.23, sortino: 1.8, calmar: 2.4, volatilityPct: 20.1,
          winRatePct: 66.67, tradeCount: 3, profitFactor: 2.1, payoffRatio: 1.5,
          avgTradePct: 0.5, maxWinPct: 3.2, maxLossPct: -1.1, buyHoldReturnPct: -2.5,
        },
        equity: equity,
        trades: [
          { seq: 1, side: 'long', qty: 0.11, entryT: BT_START_MS + 5 * barMs, entryPrice: 84000.5, exitT: BT_START_MS + 20 * barMs, exitPrice: 85200.5, notional: 9240, fees: 12.5, pnl: 120.5, pnlPct: 1.2, bars: 15, exitReason: 'strategy' },
          { seq: 2, side: 'short', qty: 0.12, entryT: BT_START_MS + 30 * barMs, entryPrice: 85000, exitT: BT_START_MS + 45 * barMs, exitPrice: 84300, notional: 10200, fees: 13.1, pnl: 80.2, pnlPct: 0.8, bars: 15, exitReason: 'end' },
          { seq: 3, side: 'long', qty: 0.1, entryT: BT_START_MS + 50 * barMs, entryPrice: 83000, exitT: BT_START_MS + 60 * barMs, exitPrice: 83100, notional: 8300, fees: 9.9, pnl: 8.4, pnlPct: 0.1, bars: 10, exitReason: 'strategy' },
        ],
        tradeCount: 3,
        fees: { maker: 20.1, taker: 15.4, total: 35.5, count: 6 },
        liquidations: 0,
        rejected: 0,
        reports: {
          html: '/backtest/report?jobId=bt-test-1&format=html',
          json: '/backtest/report?jobId=bt-test-1&format=json',
        },
      },
    }
  }

  /** 运行中的 job（message 带页数，验"进度行显示 job.message"） */
  function btRunningJob() {
    return {
      id: 'bt-test-1', state: 'running', phase: 'data', message: '已抓取 3 页…',
      progress: { pages: 3, bars: 300, pct: null }, startedAt: BT_START_MS,
      finishedAt: null, elapsedMs: 1200, cancelRequested: false, error: null, summary: null,
    }
  }

  /** 出错的 job（error 是给人看的中文原因） */
  function btErrorJob(message) {
    return {
      id: 'bt-test-1', state: 'error', phase: 'error', message: '回测失败',
      progress: { pages: 2, bars: 200, pct: null }, startedAt: BT_START_MS,
      finishedAt: BT_START_MS + 2100, elapsedMs: 2100, cancelRequested: false,
      error: message, summary: null,
    }
  }

  /** 一份 dom 的界面查询工具。所有查询都**现查**：React 每次提交都可能换掉节点。 */
  function btUi(dom) {
    const doc = dom.container().ownerDocument
    const panel = () => dom.container().querySelector('.btcd-btpanel')
    const inPanel = function (selector) {
      const p = panel()
      return p === null ? null : p.querySelector(selector)
    }
    const toolButton = function (text) {
      const dashboard = dom.container().querySelector('.btcd-panel')
      if (dashboard === null) return null
      for (const b of dashboard.querySelectorAll('.btcd-tool')) {
        if (b.textContent.trim() === text) return b
      }
      return null
    }
    const findButton = function (text) {
      const scope = panel()
      if (scope !== null) {
        for (const b of scope.querySelectorAll('button')) if (b.textContent.trim() === text) return b
      }
      for (const b of doc.querySelectorAll('button')) if (b.textContent.trim() === text) return b
      return null
    }
    const field = function (aria) {
      const scope = panel()
      if (scope === null) return null
      for (const el of scope.querySelectorAll('input, select')) {
        if (el.getAttribute('aria-label') === aria) return el
      }
      return null
    }
    return {
      doc: doc,
      panel: panel,
      inPanel: inPanel,
      toolButton: toolButton,
      findButton: findButton,
      field: field,
      /** 输入框 / 下拉当前值（找不到给 null，方便断言里直接看） */
      value: function (aria) {
        const el = field(aria)
        return el === null ? null : el.value
      },
      /** 下拉的全部 option.value（验"选项来自服务端载荷"） */
      options: function (aria) {
        const el = field(aria)
        if (el === null) return null
        return Array.from(el.options).map(function (o) { return o.value })
      },
      /** 打开 / 收起回测面板（工具条「回测」按钮，真实路径） */
      togglePanel: function () {
        const button = toolButton('回测')
        if (button !== null) dom.click(button)
        return button
      },
      text: function () {
        const p = panel()
        return p === null ? '' : p.textContent
      },
      /** KPI 格：标签 → 数值 */
      kpis: function () {
        const out = {}
        const p = panel()
        if (p === null) return out
        for (const box of p.querySelectorAll('.btcd-bt-kpi')) {
          const label = box.querySelector('.btcd-bt-kpi-label')
          const value = box.querySelector('b')
          if (label !== null && value !== null) out[label.textContent.trim()] = value.textContent.trim()
        }
        return out
      },
      kpiLabels: function () {
        const p = panel()
        if (p === null) return []
        return Array.from(p.querySelectorAll('.btcd-bt-kpi-label')).map(function (el) { return el.textContent.trim() })
      },
      tradeRows: function () {
        const p = panel()
        return p === null ? [] : Array.from(p.querySelectorAll('.btcd-bt-trades tbody tr'))
      },
    }
  }

  // ---- 用例 1：入口 / 默认值 / 表单换算 / 轮询到完成 / 报告 / 回填 / Esc
  {
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「回测面板」交互测试：环境里找不到 jsdom')
    } else {
      const ui = btUi(dom)
      await dom.mount()

      // (1) 工具条入口：契约 §4.1 要求「均线 / 预警」那一行多一个「回测」按钮
      check(ui.toolButton('回测') !== null, '工具条上有「回测」按钮')
      check(ui.toolButton('回测') !== null && ui.toolButton('回测').className.indexOf('btcd-tool') >= 0,
        '「回测」按钮带 btcd-tool 类', ui.toolButton('回测') === null ? 'null' : ui.toolButton('回测').className)

      // (2) 打开面板：GET strategies 之后表单按 defaults 填好（标题行文案是契约）
      ui.togglePanel()
      await dom.settle(350)
      dom.flushPending()
      const panelEl = ui.panel()
      check(panelEl !== null && panelEl.className.indexOf('btcd-emapanel') >= 0
        && panelEl.className.indexOf('btcd-btpanel') >= 0,
      '点「回测」打开面板（class 含 btcd-emapanel / btcd-btpanel）',
      panelEl === null ? 'null' : panelEl.className)
      check(ui.toolButton('回测') !== null && ui.toolButton('回测').className.indexOf('on') >= 0,
        '面板打开时工具条按钮加 on 态', ui.toolButton('回测') === null ? 'null' : ui.toolButton('回测').className)
      check(ui.text().indexOf('回测') >= 0 && ui.text().indexOf('BTCUSDT 永续') >= 0,
        '面板标题行有「回测」和副标题「BTCUSDT 永续」')
      check(ui.inPanel('canvas.btcd-btchart') === null, '还没跑完时不渲染资金曲线 canvas')
      check(ui.findButton('打开完整报告') === null, '还没跑完时没有「打开完整报告」')
      // 数字输入统一用 input[type=text] + inputMode=decimal：不能有 type=number（带上下调节箭头）
      const numberInputs = panelEl === null ? null : panelEl.querySelectorAll('input[type="number"]')
      check(numberInputs !== null && numberInputs.length === 0,
        '回测面板里没有 type=number 输入框（没有上下调节箭头）',
        numberInputs === null ? 'null' : String(numberInputs.length))

      // 策略 / 周期选项来自 GET /backtest/strategies（不是前端写死的列表）
      check(ui.options('策略') !== null && ui.options('策略').join(',') === 'buy-hold,donchian-trend,sma-cross',
        '策略下拉来自 GET /backtest/strategies', String(ui.options('策略')))
      check(ui.value('策略') === 'sma-cross', '默认策略是 sma-cross（契约 §4.2 前端约定）', String(ui.value('策略')))
      check(ui.options('周期') !== null && ui.options('周期').join(',') === '1m,3m,5m,15m,1h,4h,1D',
        '周期下拉来自 payload.bars', String(ui.options('周期')))
      check(ui.value('周期') === '1h', '默认周期来自 defaults.bar', String(ui.value('周期')))
      // 标的：「标的」下拉来自 GET /backtest/strategies 的 insts（Host 白名单，前端不写死列表）
      check(ui.options('标的') !== null && ui.options('标的').join(',') === 'BTC-USDT-SWAP,ETH-USDT-SWAP',
        '标的下来自 GET /backtest/strategies 的 insts', String(ui.options('标的')))
      check(ui.value('标的') === 'BTC-USDT-SWAP',
        '看板是 BTC 时回测默认标的仍是 BTC-USDT-SWAP（兼容旧行为）', String(ui.value('标的')))

      // 参数按策略默认值动态渲染：sma-cross → fast/slow 文本输入 + allowShort checkbox
      const fastInput = ui.inPanel('[data-param="fast"]')
      const slowInput = ui.inPanel('[data-param="slow"]')
      const allowShortInput = ui.inPanel('[data-param="allowShort"]')
      check(fastInput !== null && fastInput.type === 'text' && fastInput.inputMode === 'decimal' && fastInput.value === '20',
        '参数 fast 是纯文本输入（inputMode=decimal，没有上下调节箭头）', fastInput === null ? 'null' : String(fastInput.value))
      check(slowInput !== null && slowInput.type === 'text' && slowInput.inputMode === 'decimal' && slowInput.value === '60',
        '参数 slow 是纯文本输入', slowInput === null ? 'null' : String(slowInput.value))
      check(allowShortInput !== null && allowShortInput.type === 'checkbox' && allowShortInput.checked === false,
        '布尔参数 allowShort 渲染成勾选框（默认 false）',
        allowShortInput === null ? 'null' : String(allowShortInput.checked))

      // 时间范围：结束=今天（UTC+8），开始=结束-30 天（契约 §4.2）
      const todayUtc8 = btTodayUtc8()
      const expectStart = btDayText(btDayMs(todayUtc8) - 30 * DAY_MS)
      const startField = ui.field('开始日期')
      check(startField !== null && startField.type === 'date', '开始日期是 input[type=date]')
      check(ui.value('开始日期') === expectStart, '开始日期默认 = 今天（UTC+8）- 30 天',
        String(ui.value('开始日期')) + '（期望 ' + expectStart + '）')
      check(ui.value('结束日期') === todayUtc8, '结束日期默认 = 今天（UTC+8）',
        String(ui.value('结束日期')) + '（期望 ' + todayUtc8 + '）')

      // 资金 / 杠杆 / 费率默认值（费率显示为百分比，提交时 /100）
      check(ui.value('初始资金') === '10000', '初始资金默认 10000', String(ui.value('初始资金')))
      check(ui.value('杠杆') === '1', '杠杆默认 1x', String(ui.value('杠杆')))
      check(ui.value('挂单费率') === '0.0200', '挂单费率按百分比显示 0.0200', String(ui.value('挂单费率')))
      check(ui.value('吃单费率') === '0.0500', '吃单费率按百分比显示 0.0500', String(ui.value('吃单费率')))
      // 四个金额输入框也必须是文本输入（不带 spinner）
      const amountFieldsOk = ['初始资金', '杠杆', '挂单费率', '吃单费率'].every((aria) => {
        const field = ui.field(aria)
        return field !== null && field.type === 'text' && field.inputMode === 'decimal'
      })
      check(amountFieldsOk, '资金/杠杆/费率输入框都是纯文本（inputMode=decimal，无上下调节箭头）')
      for (const quick of ['近7天', '近30天', '近90天', '近1年']) {
        check(ui.findButton(quick) !== null, '有快捷时间按钮「' + quick + '」')
      }
      // 30 天区间 + 结束日期含当日（右开 +1 天）→ 实际覆盖 31 个自然日，1h 周期 = 744 根
      check(ui.text().indexOf('预计 744 根 K 线') >= 0,
        '提示行按区间 / 周期估算根数（开始=结束-30d、结束含当日 → 31 天 × 24 = 744 根）')

      // 快捷按钮：改日期走同一个 UTC+8 口径（默认 30 天就是 end-30d）
      dom.click(ui.findButton('近7天'))
      await dom.settle(100)
      dom.flushPending()
      check(ui.value('开始日期') === btDayText(btDayMs(ui.value('结束日期')) - 7 * DAY_MS),
        '「近7天」把开始日期改成结束日期前 7 天', String(ui.value('开始日期')))
      dom.click(ui.findButton('近30天'))
      await dom.settle(100)
      dom.flushPending()
      check(ui.value('开始日期') === expectStart, '「近30天」把区间改回默认的 30 天', String(ui.value('开始日期')))

      // 参数随策略动态渲染：切到无参数的 buy-hold → 参数输入消失；切回来 → 参数回到默认
      dom.select(ui.field('策略'), 'buy-hold')
      await dom.settle(100)
      dom.flushPending()
      check(ui.value('策略') === 'buy-hold' && ui.inPanel('[data-param="fast"]') === null,
        '切到 buy-hold（无参数）后参数输入消失', String(ui.value('策略')))
      dom.select(ui.field('策略'), 'sma-cross')
      await dom.settle(100)
      dom.flushPending()
      check(ui.inPanel('[data-param="fast"]') !== null && ui.inPanel('[data-param="fast"]').value === '20',
        '切回 sma-cross 参数回到该策略默认值（fast=20）',
        ui.inPanel('[data-param="fast"]') === null ? 'null' : String(ui.inPanel('[data-param="fast"]').value))

      // 小数参数（donchian-trend 的 weight）：文本输入框编辑期保留原始字符串，
      // 不能出现"敲 0.5 被 Number 成 0、小数点被吞掉"的经典问题
      dom.select(ui.field('策略'), 'donchian-trend')
      await dom.settle(120)
      dom.flushPending()
      const weightField = ui.inPanel('[data-param="weight"]')
      check(weightField !== null && weightField.type === 'text' && weightField.inputMode === 'decimal',
        'donchian-trend 的 weight 参数是纯文本输入（无 spinner）',
        weightField === null ? 'null' : String(weightField.value))
      dom.type(weightField, '0.5')
      await dom.settle(80)
      dom.flushPending()
      check(ui.inPanel('[data-param="weight"]') !== null && ui.inPanel('[data-param="weight"]').value === '0.5',
        '小数 0.5 原样保留（编辑期存字符串，不被 Number 吞成 0）',
        ui.inPanel('[data-param="weight"]') === null ? 'null' : String(ui.inPanel('[data-param="weight"]').value))
      // 切回 sma-cross 继续后面的提交断言（切策略会把参数重置成该策略默认值）
      dom.select(ui.field('策略'), 'sma-cross')
      await dom.settle(120)
      dom.flushPending()

      // (3) 改表单 → 点开始回测：POST 体要做金额 / 费率 / 日期 / 参数换算
      dom.type(ui.inPanel('[data-param="fast"]'), '13')
      dom.type(ui.field('初始资金'), '25000')
      dom.type(ui.field('杠杆'), '2')
      dom.type(ui.field('挂单费率'), '0.0300')
      dom.type(ui.field('吃单费率'), '0.0600')
      dom.select(ui.field('周期'), '4h')
      await dom.settle(120)
      dom.flushPending()
      check(ui.inPanel('[data-param="fast"]') !== null && ui.inPanel('[data-param="fast"]').value === '13',
        '受控参数输入框能改（fast=13）',
        ui.inPanel('[data-param="fast"]') === null ? 'null' : String(ui.inPanel('[data-param="fast"]').value))

      // 排两拍 status：第一拍 running（带页数），第二拍 done（带 summary）
      dom.setBtStatus([btRunningJob(), btDoneJob()])
      const runButton = ui.findButton('开始回测')
      check(runButton !== null && runButton.disabled !== true, '有「开始回测」按钮且可点',
        runButton === null ? 'null' : 'disabled=' + String(runButton.disabled))
      dom.click(runButton)
      await dom.settle(150)
      dom.flushPending()

      check(dom.btRuns().length === 1, '点「开始回测」发了一次 POST /backtest/run', String(dom.btRuns().length))
      const runBody = dom.btRuns().length === 0 ? {} : dom.btRuns()[0]
      check(runBody.strategy === 'sma-cross', 'POST run.strategy = 当前策略 sma-cross', String(runBody.strategy))
      check(runBody.instId === 'BTC-USDT-SWAP', 'POST run.instId = 当前标的 BTC-USDT-SWAP', String(runBody.instId))
      check(runBody.bar === '4h', 'POST run.bar 跟随周期选择（4h）', String(runBody.bar))
      check(runBody.params !== null && typeof runBody.params === 'object'
        && runBody.params.fast === 13 && runBody.params.slow === 60 && runBody.params.allowShort === false,
      'POST run.params 带策略参数（fast 改成 13，布尔保持 false）', JSON.stringify(runBody.params))
      check(runBody.initialCapital === 25000, 'POST run.initialCapital 是数字 25000', String(runBody.initialCapital))
      check(runBody.leverage === 2, 'POST run.leverage 是数字 2', String(runBody.leverage))
      check(runBody.makerFeeRate === 0.0003, '挂单费率 0.0300% → 提交 0.0003（/100）', String(runBody.makerFeeRate))
      check(runBody.takerFeeRate === 0.0006, '吃单费率 0.0600% → 提交 0.0006（/100）', String(runBody.takerFeeRate))
      const startText = ui.value('开始日期')
      const endText = ui.value('结束日期')
      check(runBody.start === btDayMs(startText), 'POST run.start = 开始日期 UTC+8 零点的毫秒',
        String(runBody.start) + '（期望 ' + String(btDayMs(startText)) + '）')
      check(runBody.end === btDayMs(endText) + DAY_MS, 'POST run.end = 结束日期 + 1 天（右开区间）',
        String(runBody.end) + '（期望 ' + String(btDayMs(endText) + DAY_MS) + '）')
      check((runBody.start + UTC8_OFFSET_MS) % DAY_MS === 0,
        'start 落在 UTC+8 零点（16:00Z，不是浏览器本地零点）', new Date(runBody.start).toISOString())
      // 契约 §4.2：start = 结束日期 - 30 天；结束日期「含当日」→ 提交右开区间再 +1 天，
      // 所以从 start 到 end 一共跨 31 个自然日（30 天区间 + 结束当天）。
      check(runBody.end - runBody.start === 31 * DAY_MS,
        '默认区间：开始=结束前 30 天、结束含当日（右开 +1 天）→ 跨 31 天',
        String((runBody.end - runBody.start) / DAY_MS) + ' 天')

      // (4) 运行中：进度行 / 取消按钮；正式轮询前先用 run 返回的 job 显示进度
      check(ui.text().indexOf('回测进行中') >= 0, '运行中显示「回测进行中」', ui.text().slice(0, 120))
      check(ui.text().indexOf('正在抓取历史 K 线') >= 0, '进度行带 job.message 文案（正在抓取历史 K 线…）')
      check(ui.findButton('取消') !== null, '运行中按钮变成「取消」')
      check(ui.findButton('开始回测') === null, '运行中隐藏「开始回测」')
      await dom.settle(950)
      dom.flushPending()
      check(ui.text().indexOf('已抓取 3 页') >= 0, '轮询到 running 时进度行跟着更新（已抓取 3 页…）',
        ui.text().indexOf('已抓取 3 页') >= 0 ? '' : ui.text().slice(0, 160))

      // (5) 轮询到 done：KPI / 完成行 / 交易明细 / 资金曲线
      await dom.settle(1100)
      dom.flushPending()
      const finalJob = dom.btState().current
      check(finalJob !== null && finalJob.state === 'done', 'status 轮询到 done',
        finalJob === null ? 'null' : String(finalJob.state))
      check(ui.text().indexOf('回测完成 · 2026-01-01 ~ 2026-03-31 · 2,160 根') >= 0,
        '完成行显示区间（UTC+8）与根数', ui.text().slice(0, 200))
      check(ui.inPanel('.btcd-bt-progress') === null, '完成后进度行消失')

      check(ui.kpiLabels().join(',') === '总收益,年化收益,最大回撤,夏普,胜率,交易次数,手续费,Buy&Hold',
        'KPI 八项标签与顺序符合契约 §4.2', ui.kpiLabels().join(','))
      const kpis = ui.kpis()
      check(kpis['总收益'] === '+12.34%', 'KPI 总收益 = +12.34%', String(kpis['总收益']))
      check(kpis['年化收益'] === '+55.55%', 'KPI 年化收益 = +55.55%', String(kpis['年化收益']))
      check(kpis['最大回撤'] === '5.67%', 'KPI 最大回撤 = 5.67%（取绝对值显示）', String(kpis['最大回撤']))
      check(kpis['夏普'] === '1.23', 'KPI 夏普 = 1.23', String(kpis['夏普']))
      check(kpis['胜率'] === '66.67%', 'KPI 胜率 = 66.67%', String(kpis['胜率']))
      check(kpis['交易次数'] === '3', 'KPI 交易次数 = tradeCount 3', String(kpis['交易次数']))
      check(kpis['手续费'] === '35.50', 'KPI 手续费 = fees.total 35.50', String(kpis['手续费']))
      check(kpis['Buy&Hold'] === '-2.50%', 'KPI Buy&Hold = -2.50%', String(kpis['Buy&Hold']))

      const tradeRows = ui.tradeRows()
      check(tradeRows.length === 3, '交易明细渲染 3 行（summary.trades）', String(tradeRows.length))
      const headCells = Array.from(ui.panel().querySelectorAll('.btcd-bt-trades thead th'))
        .map(function (th) { return th.textContent.trim() })
      check(headCells.join(',') === '#,方向,开仓,平仓,盈亏,手续费,原因',
        '交易明细表头符合契约（# 方向 开仓 平仓 盈亏 手续费 原因）', headCells.join(','))
      const row0 = tradeRows.length === 0 ? '' : tradeRows[0].textContent
      const row1 = tradeRows.length < 2 ? '' : tradeRows[1].textContent
      check(row0.indexOf('多') >= 0 && row0.indexOf('84,000.5') >= 0 && row0.indexOf('+120.50') >= 0,
        '第一笔交易行有方向 / 开仓价 / 盈亏', row0)
      check(row0.indexOf('策略') >= 0, '平仓原因 strategy 翻成中文「策略」', row0)
      check(row1.indexOf('空') >= 0 && row1.indexOf('到期') >= 0,
        '第二笔是空单、到期平仓（原因 end → 到期）', row1)
      check(ui.text().indexOf('交易明细（3 笔）') >= 0, '交易明细标题带笔数')

      const chartCalls = dom.canvasCalls()
      check(chartCalls !== null, '完成结果里渲染了资金曲线 canvas.btcd-btchart')
      check(chartCalls !== null && chartCalls.lineTo > 20 && chartCalls.stroke >= 2,
        '资金曲线 canvas 真的落笔了（lineTo/stroke）',
        chartCalls === null ? 'null' : JSON.stringify(chartCalls))
      check(chartCalls !== null && chartCalls.fillText >= 4,
        '资金曲线画了坐标轴 / 图例文字', chartCalls === null ? 'null' : 'fillText=' + String(chartCalls.fillText))
      const chartEl = ui.inPanel('canvas.btcd-btchart')
      check(chartEl !== null && chartEl.width >= 400 && chartEl.height > 0,
        'canvas 按容器尺寸设置了像素大小', chartEl === null ? 'null' : chartEl.width + 'x' + chartEl.height)
      check(ui.findButton('打开完整报告') !== null && ui.findButton('下载 JSON') !== null,
        '完成后出现「打开完整报告 / 下载 JSON」两个按钮')
      check(ui.findButton('开始回测') !== null && ui.findButton('开始回测').disabled !== true,
        '完成后「开始回测」恢复可点')

      // (6) 打开完整报告：GET summary.reports.html → Blob → window.open(blobUrl, '_blank')
      check(dom.btReportFetches().length === 0 && dom.openedWindows().length === 0,
        '点之前没有取过报告、也没开过窗口')
      dom.click(ui.findButton('打开完整报告'))
      await dom.settle(300)
      dom.flushPending()
      const reportFetches = dom.btReportFetches()
      check(reportFetches.length === 1 && reportFetches[0].format === 'html',
        '「打开完整报告」fetch 了 report?format=html',
        JSON.stringify(reportFetches.map(function (r) { return r.format })))
      check(reportFetches.length > 0 && reportFetches[0].url.indexOf('/backtest/report') >= 0
        && reportFetches[0].url.indexOf('jobId=bt-test-1') >= 0,
      '报告 URL 是 summary.reports.html 拼上 API 前缀（带 jobId）',
      reportFetches.length === 0 ? '' : reportFetches[0].url)
      const opened = dom.openedWindows()
      check(opened.length === 1 && opened[0].target === '_blank',
        'window.open 用 _blank 打开新窗口', JSON.stringify(opened))
      check(opened.length > 0 && String(opened[0].url).indexOf('blob:') === 0,
        '新窗口打开的是 blob URL（报告不在同源里执行）', opened.length === 0 ? '' : opened[0].url)
      const objectUrls = dom.objectUrls()
      check(objectUrls.length === 1 && objectUrls[0].blob.type === 'text/html',
        '报告 HTML 被包成 text/html 的 Blob', objectUrls.length === 0 ? '' : String(objectUrls[0].blob.type))
      check(ui.text().indexOf('新窗口被浏览器拦截') < 0, 'open 成功时不会误报「被弹窗拦截」')

      // (7) localStorage 回填：收起面板再打开，表单值还在（key 是契约固定的）
      const storedRaw = dom.win().localStorage.getItem('dsh-btc-dashboard:backtest')
      check(storedRaw !== null, '表单写进了 localStorage[dsh-btc-dashboard:backtest]')
      let storedForm = {}
      try { storedForm = JSON.parse(String(storedRaw)) } catch (error) { storedForm = {} }
      check(storedForm.capital === '25000' && storedForm.params !== null && storedForm.params.fast === 13
        && storedForm.bar === '4h' && storedForm.instId === 'BTC-USDT-SWAP',
      'localStorage 存的是改过的表单（capital / params / bar / instId）', JSON.stringify(storedForm))
      dom.click(ui.toolButton('回测'))
      await dom.settle(150)
      dom.flushPending()
      check(ui.panel() === null, '再点「回测」收起面板')
      check(ui.toolButton('回测') !== null && ui.toolButton('回测').className.indexOf('on') < 0,
        '收起后工具条按钮去掉 on 态', ui.toolButton('回测') === null ? 'null' : ui.toolButton('回测').className)
      dom.click(ui.toolButton('回测'))
      await dom.settle(350)
      dom.flushPending()
      check(ui.value('初始资金') === '25000', '重开面板后初始资金回填 25000', String(ui.value('初始资金')))
      check(ui.inPanel('[data-param="fast"]') !== null && ui.inPanel('[data-param="fast"]').value === '13',
        '重开面板后参数 fast 回填 13',
        ui.inPanel('[data-param="fast"]') === null ? 'null' : String(ui.inPanel('[data-param="fast"]').value))
      check(ui.value('周期') === '4h' && ui.value('挂单费率') === '0.0300',
        '重开面板后周期 / 费率也回填',
        JSON.stringify([ui.value('周期'), ui.value('挂单费率')]))
      check(ui.value('标的') === 'BTC-USDT-SWAP', '重开面板后标的也回填 BTC-USDT-SWAP',
        String(ui.value('标的')))
      // 打开面板时 GET status（不带 jobId）会恢复上次结果
      check(dom.btState().current !== null && dom.btState().current.state === 'done',
        '重开面板时 GET status 恢复上次 job 状态',
        dom.btState().current === null ? 'null' : String(dom.btState().current.state))
      check(ui.text().indexOf('回测完成') >= 0 && ui.kpis()['总收益'] === '+12.34%',
        '恢复出来的上次结果直接渲染 KPI')

      // (8) Esc 关闭面板（契约 §4.1：和均线 / 预警面板一致的层级顺序）
      dom.key('Escape')
      await dom.settle(100)
      dom.flushPending()
      check(ui.panel() === null, 'Esc 关闭回测面板')
      check(ui.toolButton('回测') !== null && ui.toolButton('回测').className.indexOf('on') < 0,
        'Esc 后工具条按钮恢复未打开态', ui.toolButton('回测') === null ? 'null' : ui.toolButton('回测').className)
      check(dom.errors().length === 0, '回测面板整个交互过程没有页面级异常', dom.errors().join(' | '))
      await dom.unmount()
    }
  }

  // ---- 用例 2：错误态（run 返回 ok:false；轮询到 state=error）
  {
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「回测错误态」测试：环境里找不到 jsdom')
    } else {
      const ui = btUi(dom)
      await dom.mount()
      ui.togglePanel()
      await dom.settle(350)
      dom.flushPending()
      check(ui.panel() !== null, '错误态用例：回测面板已打开')

      // (a) POST run 返回 ok:false → 「回测失败：<中文原因>」，按钮不能卡死
      dom.setBtRunError('已有回测在跑（bt-other），请等它结束或取消')
      dom.click(ui.findButton('开始回测'))
      await dom.settle(300)
      dom.flushPending()
      check(ui.text().indexOf('回测失败：已有回测在跑（bt-other），请等它结束或取消') >= 0,
        'run 返回 ok:false 时显示「回测失败：<中文原因>」', ui.text().slice(0, 200))
      const retryButton = ui.findButton('开始回测')
      check(retryButton !== null && retryButton.disabled !== true,
        '启动失败后「开始回测」恢复可点（没有卡死）',
        retryButton === null ? 'null' : 'disabled=' + String(retryButton.disabled))
      check(dom.btRuns().length === 1, '失败那次也记到了 run 请求体', String(dom.btRuns().length))

      // (a2) Host 侧的错误串不再自带「回测失败：」前缀（由前端统一拼一次）：
      // 契约：index.js 返回 `不支持的标的 "…"（可选：…）`，面板应显示「回测失败：不支持的标的 …」，
      // 而不是曾经的双前缀「回测失败：回测失败：…」。
      dom.setBtRunError('不支持的标的 "DOGE-USDT-SWAP"（可选：BTC-USDT-SWAP / ETH-USDT-SWAP）')
      dom.click(ui.findButton('开始回测'))
      await dom.settle(250)
      dom.flushPending()
      check(ui.text().indexOf('回测失败：不支持的标的 "DOGE-USDT-SWAP"') >= 0,
        'run 返回「不支持的标的…」时面板显示「回测失败：<原因>」', ui.text().slice(0, 220))
      check(ui.text().indexOf('回测失败：回测失败：') < 0,
        'Host 不再带前缀后，前端只拼一次「回测失败：」（没有双前缀）', ui.text().slice(0, 220))
      check(dom.btRuns().length === 2, '非法标的那次也记到了 run 请求体', String(dom.btRuns().length))
      dom.setBtRunError(null)

      // (b) 轮询到 state=error → 进度先出现、再变成「回测失败：job.error」，按钮恢复
      dom.setBtRunError(null)
      dom.setBtStatus([btRunningJob(), btErrorJob('数据抓取失败：网络超时')])
      dom.click(ui.findButton('开始回测'))
      await dom.settle(250)
      dom.flushPending()
      check(ui.text().indexOf('回测进行中') >= 0, '第二次启动进入运行中（进度行出现）')
      await dom.settle(2000)
      dom.flushPending()
      check(ui.text().indexOf('回测失败：数据抓取失败：网络超时') >= 0,
        '轮询到 error 时显示 job.error 的中文原因', ui.text().slice(0, 200))
      const afterErrorRun = ui.findButton('开始回测')
      check(afterErrorRun !== null && afterErrorRun.disabled !== true,
        '错误态结束后「开始回测」恢复可点',
        afterErrorRun === null ? 'null' : 'disabled=' + String(afterErrorRun.disabled))
      check(ui.findButton('取消') === null, '错误态下没有「取消」按钮')
      check(dom.errors().length === 0, '错误态过程没有页面级异常', dom.errors().join(' | '))
      await dom.unmount()
    }
  }

  // ---- 用例 3：取消（运行中点「取消」→ POST cancel → 状态变 cancelled）
  {
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「回测取消」测试：环境里找不到 jsdom')
    } else {
      const ui = btUi(dom)
      await dom.mount()
      ui.togglePanel()
      await dom.settle(350)
      dom.flushPending()
      check(ui.panel() !== null, '取消用例：回测面板已打开')
      dom.setBtStatus([btRunningJob()])
      dom.click(ui.findButton('开始回测'))
      await dom.settle(1100)
      dom.flushPending()
      check(ui.findButton('取消') !== null, '运行中显示「取消」按钮')
      dom.click(ui.findButton('取消'))
      await dom.settle(400)
      dom.flushPending()
      const cancels = dom.btCancels()
      check(cancels.length === 1, '点「取消」发了一次 POST /backtest/cancel', String(cancels.length))
      check(cancels.length > 0 && cancels[0].jobId === 'bt-test-1',
        'cancel 请求体带当前 jobId', JSON.stringify(cancels[0]))
      check(ui.text().indexOf('回测已取消') >= 0, '取消后显示「回测已取消」', ui.text().slice(0, 200))
      check(ui.findButton('取消') === null && ui.findButton('开始回测') !== null,
        '取消后按钮回到「开始回测」')
      check(dom.btState().current !== null && dom.btState().current.state === 'cancelled',
        '取消后 job 状态变成 cancelled',
        dom.btState().current === null ? 'null' : String(dom.btState().current.state))
      check(dom.errors().length === 0, '取消过程没有页面级异常', dom.errors().join(' | '))
      await dom.unmount()
    }
  }

  // ---- 用例 4：标的切换（看板标题 / board & price 透传 / localStorage 记忆 / 回测面板标的）
  //
  // 契约：默认仍是 BTC（旧行为不变）；切到 ETH 后看板标题、取数 URL、页面上的标的标识都跟着变，
  // 选择写进 localStorage 记住；回测面板的「标的」下拉默认按「上次表单 > Host defaults.instId >
  // 当前看板标的 > BTC」的优先级取值，提交 body 带 instId。
  {
    const instKey = 'dsh-btc-dashboard:inst'
    const backtestKey = 'dsh-btc-dashboard:backtest'
    const findDashButton = function (dom, text) {
      const panel = dom.container().querySelector('.btcd-panel')
      if (panel === null) return null
      for (const b of panel.querySelectorAll('button')) {
        if (b.textContent.trim() === text) return b
      }
      return null
    }
    const titleOf = function (dom) {
      const el = dom.container().querySelector('.btcd-panel .btcd-title')
      return el === null ? '' : el.textContent
    }
    const lastContaining = function (list, needle) {
      for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].indexOf(needle) >= 0) return list[i]
      return null
    }

    // ---- 4a) 默认 BTC；点 ETH → 标题/ board / price / localStorage 全跟上；回测面板标的优先级
    {
      const dom = createInteractiveDom()
      if (dom === null) {
        console.log('     跳过「标的切换」测试：环境里找不到 jsdom')
      } else {
        await dom.mount()
        check(titleOf(dom).indexOf('OKX BTC 合约看板') >= 0, '默认标题仍是「OKX BTC 合约看板」', titleOf(dom))
        const boards0 = dom.boardRequests()
        check(boards0.length > 0 && lastContaining(boards0, 'instId=BTC-USDT-SWAP') !== null,
          '默认 /board 请求带 instId=BTC-USDT-SWAP',
          boards0.length === 0 ? '(没有 /board 请求)' : boards0[boards0.length - 1])
        const prices0 = dom.priceRequests()
        check(prices0.length > 0 && lastContaining(prices0, 'instId=BTC-USDT-SWAP') !== null,
          '默认 /price 请求带 instId=BTC-USDT-SWAP',
          prices0.length === 0 ? '(没有 /price 请求)' : prices0[prices0.length - 1])
        check(findDashButton(dom, 'BTC') !== null && findDashButton(dom, 'ETH') !== null,
          '标题行有 BTC / ETH 标的切换按钮')
        check(findDashButton(dom, 'ETH') !== null
          && findDashButton(dom, 'ETH').className.indexOf('on') < 0,
        '默认选中 BTC（ETH 按钮不是 on 态）',
        findDashButton(dom, 'ETH') === null ? 'null' : findDashButton(dom, 'ETH').className)

        // ---- 点 ETH：标题 / 取数 URL / 页面标识 / localStorage 记忆
        dom.click(findDashButton(dom, 'ETH'))
        await dom.settle(500)
        dom.flushPending()
        check(titleOf(dom).indexOf('OKX ETH 合约看板') >= 0, '切到 ETH 后标题跟着变', titleOf(dom))
        const boards1 = dom.boardRequests()
        check(lastContaining(boards1, 'instId=ETH-USDT-SWAP') !== null,
          '切到 ETH 后 /board 请求 URL 带 instId=ETH-USDT-SWAP',
          boards1.length === 0 ? '(没有 /board 请求)' : boards1[boards1.length - 1])
        const prices1 = dom.priceRequests()
        check(lastContaining(prices1, 'instId=ETH-USDT-SWAP') !== null,
          '切到 ETH 后 /price 请求 URL 带 instId=ETH-USDT-SWAP',
          prices1.length === 0 ? '(没有 /price 请求)' : prices1[prices1.length - 1])
        // 替身会把请求 URL 上的 instId 反射回载荷（模拟 Host 的真实响应），所以页面标识也该变
        check(dom.container().querySelector('.btcd-panel').textContent.indexOf('ETH-USDT-SWAP') >= 0,
          '页面上的标的标识跟着变成 ETH-USDT-SWAP')
        const storedRaw = dom.win().localStorage.getItem(instKey)
        let storedInst = null
        try { storedInst = JSON.parse(String(storedRaw)) } catch (error) { storedInst = null }
        check(storedInst === 'ETH-USDT-SWAP',
          'localStorage[dsh-btc-dashboard:inst] 记住 ETH 选择', String(storedRaw))

        // ---- 回测面板：这次 JSDOM 没有旧回测表单 → 标的跟随「当前看板标的」（ETH），
        //      优先于 Host defaults.instId（BTC）。优先级见 btBuildForm 注释：
        //      上次表单 > 当前看板标的 > Host defaults > BTC
        const ui = btUi(dom)
        ui.togglePanel()
        await dom.settle(350)
        dom.flushPending()
        check(ui.panel() !== null, '标的用例：回测面板已打开')
        check(ui.value('标的') === 'ETH-USDT-SWAP',
          '看板切 ETH 后首次打开回测面板：默认标的跟随看板 ETH（优先于 Host defaults 的 BTC）',
          String(ui.value('标的')))
        check(ui.text().indexOf('ETHUSDT 永续') >= 0,
          '回测副标题显示 ETHUSDT 永续', ui.text().slice(0, 60))

        // 表单里换标的：副标题跟着变（先切 BTC 再切回 ETH，验 onChange 两个方向都生效）
        dom.select(ui.field('标的'), 'BTC-USDT-SWAP')
        await dom.settle(120)
        dom.flushPending()
        check(ui.value('标的') === 'BTC-USDT-SWAP' && ui.text().indexOf('BTCUSDT 永续') >= 0,
          '回测表单切到 BTC 后副标题变 BTCUSDT 永续',
          JSON.stringify([ui.value('标的'), ui.text().slice(0, 60)]))
        dom.select(ui.field('标的'), 'ETH-USDT-SWAP')
        await dom.settle(120)
        dom.flushPending()
        check(ui.value('标的') === 'ETH-USDT-SWAP' && ui.text().indexOf('ETHUSDT 永续') >= 0,
          '再切回 ETH 后副标题变 ETHUSDT 永续',
          JSON.stringify([ui.value('标的'), ui.text().slice(0, 60)]))
        dom.setBtStatus([btRunningJob(), btDoneJob()])
        dom.click(ui.findButton('开始回测'))
        await dom.settle(200)
        dom.flushPending()
        const ethRuns = dom.btRuns()
        check(ethRuns.length === 1 && ethRuns[0].instId === 'ETH-USDT-SWAP',
          '从 ETH 起的回测：POST run.instId = ETH-USDT-SWAP',
          JSON.stringify(ethRuns.length === 0 ? null : ethRuns[0]))

        // 收起再打开：表单标的从 localStorage 回填 ETH（下次打开不用重选）
        dom.click(ui.toolButton('回测'))
        await dom.settle(150)
        dom.flushPending()
        dom.click(ui.toolButton('回测'))
        await dom.settle(350)
        dom.flushPending()
        check(ui.value('标的') === 'ETH-USDT-SWAP' && ui.text().indexOf('ETHUSDT 永续') >= 0,
          '重开回测面板后标的回填 ETH（localStorage 记忆）',
          JSON.stringify([ui.value('标的'), ui.text().slice(0, 60)]))
        check(dom.errors().length === 0, '标的切换整段操作没有页面级异常', dom.errors().join(' | '))
        await dom.unmount()
      }
    }

    // ---- 4b) 刷新页面后记忆生效：预置 localStorage=ETH → 首屏就是 ETH；脏值静默回落 BTC
    {
      const dom = createInteractiveDom({ storage: { [instKey]: JSON.stringify('ETH-USDT-SWAP') } })
      if (dom === null) {
        console.log('     跳过「标的内存」测试：环境里找不到 jsdom')
      } else {
        await dom.mount()
        check(titleOf(dom).indexOf('OKX ETH 合约看板') >= 0,
          '刷新后记忆生效：首屏标题直接是 ETH', titleOf(dom))
        const boards = dom.boardRequests()
        check(boards.length > 0 && boards[0].indexOf('instId=ETH-USDT-SWAP') >= 0,
          '刷新后首个 /board 请求就带 instId=ETH-USDT-SWAP',
          boards.length === 0 ? '(没有 /board 请求)' : boards[0])
        await dom.unmount()
      }
      const dirty = createInteractiveDom({ storage: { [instKey]: JSON.stringify('DOGE-USDT-SWAP') } })
      if (dirty !== null) {
        await dirty.mount()
        check(titleOf(dirty).indexOf('OKX BTC 合约看板') >= 0,
          'localStorage 里的非法标的静默回落 BTC', titleOf(dirty))
        const dirtyBoards = dirty.boardRequests()
        check(dirtyBoards.length > 0 && dirtyBoards[0].indexOf('instId=BTC-USDT-SWAP') >= 0,
          '非法记忆值下首个 /board 请求仍带 instId=BTC-USDT-SWAP',
          dirtyBoards.length === 0 ? '(没有 /board 请求)' : dirtyBoards[0])
        await dirty.unmount()
      }

      // 优先级第 1 级：localStorage 里的旧回测表单 > 当前看板标的。
      // 预置「看板 ETH + 上次表单 BTC」→ 打开回测面板应当是 BTC（不是 ETH）。
      const savedWins = createInteractiveDom({
        storage: {
          [instKey]: JSON.stringify('ETH-USDT-SWAP'),
          [backtestKey]: JSON.stringify({ instId: 'BTC-USDT-SWAP', strategy: 'sma-cross' }),
        },
      })
      if (savedWins !== null) {
        await savedWins.mount()
        const uiSaved = btUi(savedWins)
        uiSaved.togglePanel()
        await savedWins.settle(350)
        savedWins.flushPending()
        check(uiSaved.value('标的') === 'BTC-USDT-SWAP',
          '上次表单的标的优先：看板 ETH + 旧表单 BTC → 回测默认 BTC', String(uiSaved.value('标的')))
        check(uiSaved.text().indexOf('BTCUSDT 永续') >= 0,
          '上次表单标的优先时副标题是 BTCUSDT 永续', uiSaved.text().slice(0, 60))
        await savedWins.unmount()
      }
      // 旧表单里的标的是脏值 → 跳过它，回落到当前看板标的（ETH）
      const dirtySaved = createInteractiveDom({
        storage: {
          [instKey]: JSON.stringify('ETH-USDT-SWAP'),
          [backtestKey]: JSON.stringify({ instId: 'DOGE-USDT-SWAP', strategy: 'sma-cross' }),
        },
      })
      if (dirtySaved !== null) {
        await dirtySaved.mount()
        const uiDirtySaved = btUi(dirtySaved)
        uiDirtySaved.togglePanel()
        await dirtySaved.settle(350)
        dirtySaved.flushPending()
        check(uiDirtySaved.value('标的') === 'ETH-USDT-SWAP',
          '旧表单标的非法时跳过它，回落到当前看板标的 ETH', String(uiDirtySaved.value('标的')))
        check(uiDirtySaved.text().indexOf('ETHUSDT 永续') >= 0,
          '旧表单标的非法回落时副标题是 ETHUSDT 永续', uiDirtySaved.text().slice(0, 60))
        await dirtySaved.unmount()
      }

      // ---- 4c) 看板切标的会同步 localStorage 里回测表单记住的 instId，
      //      避免"上次表单的 BTC"压过"看板刚切的 ETH"（线上踩过的坑）
      const syncStore = createInteractiveDom({
        storage: { [backtestKey]: JSON.stringify({ instId: 'BTC-USDT-SWAP', strategy: 'sma-cross', bar: '4h' }) },
      })
      if (syncStore !== null) {
        await syncStore.mount()
        const beforeRaw = syncStore.win().localStorage.getItem(backtestKey)
        check(String(beforeRaw).indexOf('"BTC-USDT-SWAP"') >= 0,
          '4c 预置：回测表单里记住的是 BTC', String(beforeRaw))
        syncStore.click(findDashButton(syncStore, 'ETH'))
        await syncStore.settle(400)
        syncStore.flushPending()
        let afterStored = null
        try { afterStored = JSON.parse(String(syncStore.win().localStorage.getItem(backtestKey))) } catch (error) { afterStored = null }
        check(afterStored !== null && afterStored.instId === 'ETH-USDT-SWAP',
          '看板切 ETH 后，回测表单记住的 instId 同步成 ETH', JSON.stringify(afterStored))
        check(afterStored !== null && afterStored.strategy === 'sma-cross' && afterStored.bar === '4h',
          '同步标的时不动回测表单其它字段', JSON.stringify(afterStored))
        await syncStore.unmount()
      }
      // 没有旧回测表单时，切标的不会凭空创建一份（避免脏数据）
      const noStore = createInteractiveDom()
      if (noStore !== null) {
        await noStore.mount()
        noStore.click(findDashButton(noStore, 'ETH'))
        await noStore.settle(400)
        noStore.flushPending()
        check(noStore.win().localStorage.getItem(backtestKey) === null,
          '没有旧回测表单时，看板切标的不会凭空创建回测表单',
          String(noStore.win().localStorage.getItem(backtestKey)))
        await noStore.unmount()
      }
    }
  }

  // ---- 用例 5：旧 Host（GET strategies 响应没有 insts）→ 回测面板只允许 BTC + 明确提示重启宿主
  //
  // 线上问题：宿主还在跑旧 index.js 时，浏览器半新版会让人在回测面板选 ETH，
  // 而旧 Host 不认 body.instId、静默按 BTC 跑。现在旧 Host 下下拉被禁用、只给 BTC，
  // 并提示「重启 DSH 宿主」；即使表单被弄成非 BTC，开始回测也必须在本地拒绝（不发 POST）。
  {
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「旧 Host 回测面板」测试：环境里找不到 jsdom')
    } else {
      const ui = btUi(dom)
      await dom.mount()
      // 模拟旧 Host：先把 strategies 载荷里的 insts 字段删掉，再打开面板（面板打开时才拉 strategies）
      const oldPayload = JSON.parse(JSON.stringify(dom.btState().strategies))
      delete oldPayload.insts
      dom.setBtStrategies(oldPayload)
      ui.togglePanel()
      await dom.settle(400)
      dom.flushPending()
      check(ui.panel() !== null, '旧 Host 用例：回测面板已打开')
      const instField = ui.field('标的')
      check(instField !== null && instField.disabled === true,
        '旧 Host：标的 select 被禁用', instField === null ? 'null' : 'disabled=' + String(instField.disabled))
      check(ui.options('标的') !== null && ui.options('标的').join(',') === 'BTC-USDT-SWAP',
        '旧 Host：标的只有 BTC 一个选项', String(ui.options('标的')))
      check(ui.value('标的') === 'BTC-USDT-SWAP', '旧 Host：回测标的回落到 BTC', String(ui.value('标的')))
      check(ui.text().indexOf('当前宿主还没加载多标的版本') >= 0 && ui.text().indexOf('重启 DSH 宿主') >= 0,
        '旧 Host：面板明确提示「当前宿主还没加载多标的版本…重启 DSH 宿主」', ui.text().slice(0, 220))
      // 兼容路径没被误伤：旧 Host 下用 BTC 发起回测仍然正常（POST body.instId=BTC）
      dom.setBtStatus([btRunningJob(), btDoneJob()])
      dom.click(ui.findButton('开始回测'))
      await dom.settle(200)
      dom.flushPending()
      check(dom.btRuns().length === 1 && dom.btRuns()[0].instId === 'BTC-USDT-SWAP',
        '旧 Host：默认仍能用 BTC 发起回测（兼容路径不误伤）', JSON.stringify(dom.btRuns()))
      await dom.unmount()
    }

    // 表单被弄成非 BTC（正常 UI 点不动 disabled 下拉，这里直接派发 change 模拟脏状态）：
    // 守卫必须在本地拦住 —— 否则旧 Host 会静默按 BTC 跑，用户拿到错结果还以为在跑 ETH。
    const guardDom = createInteractiveDom()
    if (guardDom !== null) {
      const ui2 = btUi(guardDom)
      await guardDom.mount()
      const oldPayload2 = JSON.parse(JSON.stringify(guardDom.btState().strategies))
      delete oldPayload2.insts
      guardDom.setBtStrategies(oldPayload2)
      ui2.togglePanel()
      await guardDom.settle(400)
      guardDom.flushPending()
      const field2 = ui2.field('标的')
      guardDom.select(field2, 'ETH-USDT-SWAP')
      await guardDom.settle(120)
      guardDom.flushPending()
      guardDom.click(ui2.findButton('开始回测'))
      await guardDom.settle(250)
      guardDom.flushPending()
      check(guardDom.btRuns().length === 0,
        '旧 Host：表单不是 BTC 时点开始回测不会发 POST（本地拒绝）', String(guardDom.btRuns().length))
      check(ui2.text().indexOf('不能回测 ETH') >= 0,
        '旧 Host：本地拒绝时提示不能回测 ETH', ui2.text().slice(0, 240))
      check(ui2.text().indexOf('重启 DSH 宿主') >= 0,
        '旧 Host：本地拒绝提示里告诉用户重启宿主', ui2.text().slice(0, 240))
      await guardDom.unmount()
    }
  }

  // ---- 用例 6：价格数据源——看板优先用 board.price（与 K 线同源），/price 只作兜底
  //
  // 线上问题：切 ETH 后 K 线是 ETH，左上角价格/24h 却还是 BTC。
  // 修复：quote 优先 board.price；/price 仅在响应 instId 与当前标的匹配时兜底。
  {
    const mockPrice = function (last, instId) {
      return {
        ok: true,
        instId: instId,
        env: { id: 'demo', label: '模拟', simulated: true, keyMasked: 'cafe12…beef' },
        price: {
          last: last, change24h: 10, changePct: 0.25, bid: last - 0.5, ask: last + 0.5,
          high24h: last + 100, low24h: last - 100, vol24h: 1234.5,
        },
      }
    }
    const boardWithPrice = function (last) {
      const b = makeBoard(400)
      b.price = Object.assign({}, b.price, {
        last: last, bid: last - 0.5, ask: last + 0.5, high24h: last + 100, low24h: last - 100,
        change24h: 12.5, changePct: 0.25, vol24h: 888.8,
      })
      return b
    }
    const panelLast = function (dom) {
      const el = dom.container().querySelector('.btcd-panel .btcd-last')
      return el === null ? '' : el.textContent.trim()
    }
    const panelPriceRowText = function (dom) {
      const el = dom.container().querySelector('.btcd-panel .btcd-price-row')
      return el === null ? '' : el.textContent
    }
    const dashButton = function (dom, text) {
      const panel = dom.container().querySelector('.btcd-panel')
      if (panel === null) return null
      for (const b of panel.querySelectorAll('button')) if (b.textContent.trim() === text) return b
      return null
    }

    // 6a/6b：board.price=5000，/price 却回 42000（且切 ETH 后仍回 BTC 的 42000）
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「价格数据源」测试：环境里找不到 jsdom')
    } else {
      dom.setPricePayload(mockPrice(42000, 'BTC-USDT-SWAP'))
      await dom.mount({ board: boardWithPrice(5000) })
      await dom.settle(400)
      dom.flushPending()
      check(panelLast(dom) === '5,000.0',
        '价格行优先用 board.price（与 K 线同源），显示 5,000 而不是 /price 的 42,000', panelLast(dom))
      check(panelPriceRowText(dom).indexOf('42,000') < 0,
        '价格行不出现 /price 的 42,000', panelPriceRowText(dom).slice(0, 120))

      // 切 ETH：/price 仍回 BTC（模拟旧 Host 不认 instId）→ 价格必须还是 board 的 5,000
      dom.click(dashButton(dom, 'ETH'))
      await dom.settle(500)
      dom.flushPending()
      check(panelLast(dom) === '5,000.0',
        '切 ETH 后价格仍来自 board.price，不会被旧 Host 的 /price BTC 价污染', panelLast(dom))
      check(dom.priceRequests().some(function (u) { return u.indexOf('instId=ETH-USDT-SWAP') >= 0 }),
        '切 ETH 后确实请求了 /price?instId=ETH-USDT-SWAP',
        dom.priceRequests().slice(-2).join(' | '))
      check(panelPriceRowText(dom).indexOf('24h量') >= 0 && panelPriceRowText(dom).indexOf('ETH') >= 0,
        '24h量单位随标的显示 ETH', panelPriceRowText(dom).slice(0, 160))

      // 6c：侧边栏在 /price 标的对不上时不显示 BTC 价格，只显示「📊 ETH」
      const side1 = dom.render(dom.sidebarComponent(), { wide: true, toggle: function () {} })
      await dom.settle(300)
      dom.flushPending()
      const side1Html = side1.hostHtml()
      check(side1Html.indexOf('📊 ETH') >= 0, '侧边栏按当前标的显示「📊 ETH」', side1Html.slice(0, 160))
      check(side1Html.indexOf('42,000') < 0 && side1Html.indexOf('42001') < 0,
        '侧边栏不显示 /price 回的 BTC 价格（标的对不上宁可不显示数字）', side1Html.slice(0, 160))
      side1.destroy()

      // 6d：正对照——/price 的 instId 与当前标的一致时，侧边栏正常显示价格
      dom.setPricePayload(mockPrice(2411.37, 'ETH-USDT-SWAP'))
      const side2 = dom.render(dom.sidebarComponent(), { wide: true, toggle: function () {} })
      await dom.settle(300)
      dom.flushPending()
      check(side2.hostHtml().indexOf('2,411') >= 0,
        '侧边栏在 /price 标的匹配时正常显示价格（兜底通道没被写死）', side2.hostHtml().slice(0, 160))
      side2.destroy()
      await dom.unmount()
    }

    // 6e：board 没有 price 时 /price 兜底；但 /price 标的与当前不符时也不能显示 BTC 价
    const domB = createInteractiveDom()
    if (domB !== null) {
      domB.setPricePayload(mockPrice(42000, 'BTC-USDT-SWAP'))
      const noPriceBoard = makeBoard(400)
      noPriceBoard.price = null
      await domB.mount({ board: noPriceBoard })
      await domB.settle(400)
      domB.flushPending()
      check(panelLast(domB) === '42,000.0',
        'board 没有 price 时用 /price 兜底（显示 42,000）', panelLast(domB))
      domB.click(dashButton(domB, 'ETH'))
      await domB.settle(500)
      domB.flushPending()
      check(panelLast(domB) === '—',
        'board 无 price 且 /price 标的对不上时显示「—」，不显示 BTC 价', panelLast(domB))
      await domB.unmount()
    }
  }

  // ---- 用例 7：宿主静默按 BTC 跑（忽略 body.instId）→ 结果页必须明确告警实际标的
  //
  // 线上问题：「回测面板切 ETH 但回测还是 BTC」。除了旧 Host 面板禁用之外，
  // 运行时还有一道防御：done 的 summary.instId 与面板选择不一致时必须写清楚，不能让人误会。
  {
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「实际标的告警」测试：环境里找不到 jsdom')
    } else {
      const ui = btUi(dom)
      await dom.mount()
      ui.togglePanel()
      await dom.settle(350)
      dom.flushPending()
      check(ui.panel() !== null, '实际标的告警用例：回测面板已打开')
      dom.select(ui.field('标的'), 'ETH-USDT-SWAP')
      await dom.settle(120)
      dom.flushPending()
      const mismatchJob = btDoneJob()
      mismatchJob.summary.instId = 'BTC-USDT-SWAP' // 模拟旧 Host 忽略了 body.instId、静默按 BTC 跑
      dom.setBtStatus([btRunningJob(), mismatchJob])
      dom.click(ui.findButton('开始回测'))
      await dom.settle(2100)
      dom.flushPending()
      check(ui.text().indexOf('注意：本次回测实际标的 BTC-USDT-SWAP') >= 0
        && ui.text().indexOf('与面板选择 ETH-USDT-SWAP 不一致') >= 0,
      'Host 静默按 BTC 跑时，结果页提示实际标的与面板选择不一致', ui.text().slice(0, 260))
      check(ui.text().indexOf('重启 DSH 宿主') >= 0,
        '不一致提示里告诉用户重启 DSH 宿主', ui.text().slice(0, 260))
      check(dom.errors().length === 0, '静默按 BTC 跑用例没有页面级异常', dom.errors().join(' | '))
      await dom.unmount()
    }
  }

  // ---- 用例 8：焦点在输入框时，全局快捷键（1–6 切周期）必须放行给表单
  //
  // 线上问题：回测面板的数字输入框删空后，再按数字键打不进去 —— Dashboard 的全局 keydown
  // 挂在 document 上且没检查事件目标，输入框里的 1–6 被当成「切周期」并 preventDefault。
  // 修复：焦点在 input/textarea/select/contentEditable 时（Escape 除外）一律不处理。
  {
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「输入框键盘守卫」测试：环境里找不到 jsdom')
    } else {
      const ui = btUi(dom)
      await dom.mount()
      ui.togglePanel()
      await dom.settle(350)
      dom.flushPending()
      check(ui.panel() !== null, '键盘守卫用例：回测面板已打开')
      const currentBar = function () {
        const el = dom.container().querySelector('.btcd-panel .btcd-tab.on')
        return el === null ? '' : el.textContent.trim()
      }
      const barBefore = currentBar()
      check(barBefore !== '' && barBefore !== '1m', '前提：当前周期不是 1m', barBefore)

      // (1) 焦点在「初始资金」输入框里按 1：不许切周期、不许 preventDefault
      let capInput = ui.field('初始资金')
      check(capInput !== null, '回测面板里有「初始资金」输入框')
      capInput.focus()
      const numEv = new dom.window.KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true })
      dom.flushSync(function () { capInput.dispatchEvent(numEv) })
      await dom.settle(80)
      dom.flushPending()
      check(numEv.defaultPrevented === false,
        '输入框里按 1：事件没有被 preventDefault（键盘交给表单）',
        'defaultPrevented=' + String(numEv.defaultPrevented))
      check(currentBar() === barBefore, '输入框里按 1：周期没有被切成 1m', currentBar())

      // 对照组：焦点不在输入框（事件目标是 document）时，1 仍然是切周期快捷键
      dom.key('1')
      await dom.settle(200)
      dom.flushPending()
      check(currentBar() === '1m', '对照组：焦点不在输入框时按 1 仍然切到 1m（快捷键没被改坏）', currentBar())

      // (2) 「删空再输入」：删空后敲数字不再被吞，提交时资金按新值走
      capInput = ui.field('初始资金')
      dom.type(capInput, '')
      await dom.settle(80)
      dom.flushPending()
      check(ui.value('初始资金') === '', '资金输入框可以删空（受控组件跟随空串）', String(ui.value('初始资金')))
      const afterEmptyEv = new dom.window.KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true })
      dom.flushSync(function () { ui.field('初始资金').dispatchEvent(afterEmptyEv) })
      await dom.settle(80)
      dom.flushPending()
      check(afterEmptyEv.defaultPrevented === false, '删空后按 1 也没有被全局快捷键吞掉',
        'defaultPrevented=' + String(afterEmptyEv.defaultPrevented))
      dom.type(ui.field('初始资金'), '123')
      await dom.settle(80)
      dom.flushPending()
      check(ui.value('初始资金') === '123', '删空后再输入 123：受控值正常跟随', String(ui.value('初始资金')))
      dom.setBtStatus([btRunningJob(), btDoneJob()])
      dom.click(ui.findButton('开始回测'))
      await dom.settle(200)
      dom.flushPending()
      const guardRuns = dom.btRuns()
      check(guardRuns.length === 1 && guardRuns[0].initialCapital === 123,
        '删空再输入后提交：POST run.initialCapital === 123（整条链路可用）',
        JSON.stringify(guardRuns.length === 0 ? null : guardRuns[0]))
      await dom.unmount()
    }
  }

  // ---- 用例 9：输入框里按 Delete 不能删掉选中的画线（Delete 交给表单）；Esc 仍能收面板
  {
    const dom = createInteractiveDom()
    if (dom === null) {
      console.log('     跳过「输入框 Delete 不删画线」测试：环境里找不到 jsdom')
    } else {
      await dom.mount()
      const docEl = dom.container().ownerDocument
      const panel = function () { return dom.container().querySelector('.btcd-panel') }
      const canvas = dom.container().querySelector('canvas.btcd-canvas')
      const toolButton = function (text) {
        const p = panel()
        if (p === null) return null
        for (const b of p.querySelectorAll('.btcd-tool')) if (b.textContent.trim() === text) return b
        return null
      }
      const storedDrawings = function () {
        let list = []
        try { list = JSON.parse(String(dom.storedDrawings() || '[]')) } catch (error) { list = [] }
        return Array.isArray(list) ? list : []
      }
      const pointerEvent = function (type, x, y, buttons) {
        const ev = new dom.window.MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, buttons: buttons, clientX: x, clientY: y,
        })
        ev.pointerId = 1
        ev.pointerType = 'mouse'
        dom.flushSync(function () { canvas.dispatchEvent(ev) })
        return ev
      }
      /** 用真实交互画一条直线：选工具 → 拖动（Chart 用 pointer 事件） */
      const drawLine = async function () {
        dom.click(toolButton('直线'))
        pointerEvent('pointerdown', 300, 150, 1)
        pointerEvent('pointermove', 400, 185, 1)
        pointerEvent('pointermove', 500, 220, 1)
        pointerEvent('pointerup', 500, 220, 0)
        await dom.settle(120)
        dom.flushPending()
      }
      /** 点线段中点 = 命中那条画线并选中（Chart 在 pointerdown 里命中就 onSelect） */
      const selectLine = async function () {
        pointerEvent('pointerdown', 400, 185, 1)
        pointerEvent('pointerup', 400, 185, 0)
        await dom.settle(120)
        dom.flushPending()
      }
      const selectedChip = function () {
        const el = panel() === null ? null : panel().querySelector('.btcd-sel')
        return el === null ? '' : el.textContent.trim()
      }
      check(canvas !== null, '键盘守卫用例：画布存在')

      // 先证明「选中 + Delete」这条链本身是通的（否则下面的"没删掉"证明不了什么）
      await drawLine()
      check(storedDrawings().length === 1, '画一条直线（落到 localStorage）', String(storedDrawings().length))
      await selectLine()
      check(selectedChip().indexOf('已选直线') >= 0, '点中直线后进入选中态', selectedChip())
      dom.key('Delete')
      await dom.settle(120)
      dom.flushPending()
      check(storedDrawings().length === 0, '对照：焦点不在输入框时 Delete 会删掉选中画线', String(storedDrawings().length))

      // 再画一条并选中，然后打开回测面板、把焦点放进输入框按 Delete
      await drawLine()
      await selectLine()
      check(storedDrawings().length === 1 && selectedChip().indexOf('已选直线') >= 0,
        '重新画一条并选中（供 Delete 保护用例使用）', JSON.stringify({ count: storedDrawings().length, chip: selectedChip() }))

      const ui = btUi(dom)
      ui.togglePanel()
      await dom.settle(350)
      dom.flushPending()
      check(ui.panel() !== null, 'Delete 保护用例：回测面板已打开')
      const capInput = ui.field('初始资金')
      check(capInput !== null, 'Delete 保护用例：资金输入框存在')
      capInput.focus()
      const delEv = new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      dom.flushSync(function () { capInput.dispatchEvent(delEv) })
      await dom.settle(120)
      dom.flushPending()
      check(delEv.defaultPrevented === false, '输入框里按 Delete 不被全局快捷键处理（defaultPrevented=false）',
        'defaultPrevented=' + String(delEv.defaultPrevented))
      check(storedDrawings().length === 1, '输入框里按 Delete 不会删掉选中的画线',
        JSON.stringify(storedDrawings()))
      check(selectedChip().indexOf('已选直线') >= 0, '画线仍是选中态（Delete 交给了表单）', selectedChip())

      // Esc：先清选中（全局 Esc 的第一级），再按一次收掉回测面板 —— 焦点在输入框里也要生效
      const mkEsc = function () {
        return new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      }
      const esc1 = mkEsc()
      dom.flushSync(function () { capInput.dispatchEvent(esc1) })
      await dom.settle(120)
      dom.flushPending()
      check(selectedChip() === '', '焦点在输入框时按 Esc 仍能清掉画线选中态', selectedChip())
      const esc2 = mkEsc()
      dom.flushSync(function () { ui.field('初始资金').dispatchEvent(esc2) })
      await dom.settle(150)
      dom.flushPending()
      check(ui.panel() === null, '焦点在输入框时按 Esc 仍能收起回测面板')
      check(dom.container().querySelector('.btcd-panel') !== null, 'Esc 只收回测面板，不关整个看板')
      check(storedDrawings().length === 1, 'Esc 收起面板时画线还在', String(storedDrawings().length))

      // 最后再重新点选画线、把焦点放回非输入区域，确认 Delete 快捷键本身没坏（对照组）。
      // 注意：上面第一次 Esc 已经把选中态清掉了，所以这里要重新点选一次。
      pointerEvent('pointerdown', 400, 185, 1)
      pointerEvent('pointerup', 400, 185, 0)
      await dom.settle(120)
      dom.flushPending()
      check(selectedChip().indexOf('已选直线') >= 0, '重新点选画线成功（对照组前提）', selectedChip())
      dom.key('Delete')
      await dom.settle(120)
      dom.flushPending()
      check(storedDrawings().length === 0, '对照：收面板后 Delete 仍能删画线（快捷键没被改坏）',
        String(storedDrawings().length))
      check(dom.errors().length === 0, '输入框键盘守卫用例没有页面级异常', dom.errors().join(' | '))
      await dom.unmount()
    }
  }

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

const f = mod.debug
check(f.fmtPrice(84061.1) === '84,061.1', 'fmtPrice 千分位', f.fmtPrice(84061.1))
check(f.fmtPrice(null) === '—', 'fmtPrice 空值')
check(f.fmtPct(0.1234) === '+0.12%', 'fmtPct', f.fmtPct(0.1234))
check(f.fmtPct(-1.5) === '-1.50%', 'fmtPct 负数', f.fmtPct(-1.5))
check(f.fmtVol(1511.94) === '1.51K', 'fmtVol K', f.fmtVol(1511.94))
check(f.fmtVol(2500000) === '2.50M', 'fmtVol M', f.fmtVol(2500000))
check(f.fmtTime(1780000000000, 86400000).indexOf(':') < 0, '日线只显示日期', f.fmtTime(1780000000000, 86400000))
check(f.fmtTime(1780000000000, 900000, true).indexOf(':') > 0, '日内显示时间', f.fmtTime(1780000000000, 900000, true))

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
clearTimeout(watchdog)
process.exitCode = failed === 0 ? 0 : 1
/**
 * 收个尾：jsdom 用例挨个开窗/关窗，偶有窗口或 setInterval 残留句柄，进程会卡在
 * 「全部通过」之后不退出（本地跑测试时看起来就像卡死）。给 stdout 一拍把缓冲吐完，
 * 再强制退出；`unref()` 保证没有残留句柄时它不拖住进程（正常路径照旧自然退出）。
 */
setTimeout(function () { process.exit(process.exitCode) }, 100).unref()
