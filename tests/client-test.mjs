// 客户端半的离线自检：模块格式、slot 注册、组件渲染、canvas 画图。
// 真实 React 来自 profile 的 node_modules；canvas 用记录型 2D 上下文替身。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { CLIENT_FILE, profilePackageJson } from './_paths.mjs'
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
    candles.push([1780000000000 + i * 900000, o, h, l, c, 100 + (i % 17) * 9]);
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
function createInteractiveDom() {
  const candidates = []
  if (process.env.DSH_JSDOM) candidates.push(process.env.DSH_JSDOM)
  candidates.push('jsdom')
  candidates.push('D:\\codes\\dsh\\deepseek-harness\\node_modules\\.pnpm\\jsdom@29.1.1_@noble+hashes@2.3.0\\node_modules\\jsdom\\lib\\api.js')
  let JSDOM = null
  for (const candidate of candidates) {
    try {
      const require2 = createRequire(import.meta.url)
      const resolved = candidate.startsWith('D:') ? candidate : require2.resolve(candidate)
      // jsdom 是 CJS/ESM 混合，两种入口都试
      const loaded = require2(resolved)
      JSDOM = loaded.JSDOM || (loaded.default && loaded.default.JSDOM) || null
      if (JSDOM !== null) break
    } catch (error) { /* 试下一个 */ }
  }
  if (JSDOM === null) return null

  // 交互测试要自己的 react-dom / react-dom/client（与 profile 里的 react 同源）
  const RDC = createRequire(reactDomServerPath)('react-dom/client')
  const { flushSync } = createRequire(reactDomServerPath)('react-dom')
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:3080/',
  })
  const win = dom.window
  const doc = win.document

  // 画布：不需要真画，但 drawChart 会调用这些方法，得让它们存在且不抛错
  const noopCtx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    setTransform: function () {}, clearRect: function () {}, beginPath: function () {}, closePath: function () {},
    moveTo: function () {}, lineTo: function () {}, stroke: function () {}, fill: function () {},
    fillRect: function () {}, strokeRect: function () {}, fillText: function () {}, setLineDash: function () {},
    arc: function () {}, rect: function () {}, roundRect: function () {},
    measureText: function (text) { return { width: String(text).length * 6.5 }; },
  }
  win.HTMLCanvasElement.prototype.getContext = function () { return noopCtx }
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
    'requestAnimationFrame', 'cancelAnimationFrame', 'MouseEvent', 'KeyboardEvent', 'Event']) {
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
  const pricePayload = {
    ok: true,
    env: { id: 'demo', label: '模拟', simulated: true, keyMasked: 'cafe12…beef' },
    price: {
      last: 84061.1, change24h: 120.5, changePct: 0.14, bid: 84061, ask: 84061.2,
      high24h: 84500, low24h: 83600, vol24h: 1511.94,
    },
  }
  const fakeFetch = function (url) {
    const payload = String(url).indexOf('/price') >= 0 ? pricePayload : interactiveBoard;
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
    /** 这一份 JSDOM 的 window：测试里要自己造事件（画布上的 pointer 序列）时用得上 */
    window: win,
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
    mount: function () {
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
     * ⚠️ 已知限制：**渲染在 portal 里的输入框用不了**。管理浮层（`.btcd-emapanel`）就是
     * portal，它里面的 input 派发事件时，同一个页面上的原生监听器收得到、React 的
     * `onClick` 也正常，但 React 的 `onChange` 不触发。周期输入的真机路径因此没有自动化覆盖，
     * 改周期后的效果改由 `emaUpdate` 的单测保证。
     */
    type: function (element, text) {
      const proto = win.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(element, text)
      flushSync(function () {
        element.dispatchEvent(new win.Event('input', { bubbles: true }))
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
        'ohlcLabelOf', 'timeTicks', 'tickStepHours', 'closeCountdown', 'fmtCountdown', 'fmtDur', 'fmtAgo',
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
      'not', 'rgba', 'rotate', 'translateX', 'var', 'url'])
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
      // 注意：面板是渲染在**另一个容器**（React portal）里的 —— `containerEl.contains(panel)` 是 false，
      // 所以查 DOM 要用 document，不能用 containerEl（踩过：面板明明在页面上却"查不到"）。
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

      // 改周期：输入框在**管理浮层**里，而浮层是渲染在别的容器（React portal）里的。
      // 这个 harness 里「portal 内的 input 合成事件」触发不了 React 的 onChange
      // （原生监听器收得到 input、portal 里的 onClick 也正常，就是 input 不行），
      // 所以这里只验"输入框在、值对、受控"；改周期后的**效果**由 `emaUpdate` 单测覆盖。
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
