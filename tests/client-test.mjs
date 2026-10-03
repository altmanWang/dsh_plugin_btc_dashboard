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
  ['EMA20', 'EMA20 图例'],
  ['EMA480', 'EMA480 图例'],
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
  const calls = { fillRect: 0, fillText: 0, stroke: 0, moveTo: 0, lineTo: 0, setLineDash: 0, clearRect: 0, roundRect: 0, rect: 0, arc: 0, strokeRect: 0 };
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
    stroke: function () { calls.stroke += 1; }, fill: function () {},
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
    stats: {
      seriesCount: n, displayed: n, ema20Last: e20, ema480Last: e480,
      vsEma20Pct: 0.2, vsEma480Pct: 1.1, windowHigh: price + 400, windowLow: price - 420,
      windowVolume: 123456.78,
    },
    meta: { barMs: 900000, cached: false, pages: 5, warnings: [] },
    transport: 'proxy', proxy: 'http://127.0.0.1:7897', latencyMs: 1800,
  };
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
  try {
    drawChart(made.canvas, makeBoard(n), { hover: hover, showEma20: show20, showEma480: show480 })
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
  b.ema480 = b.ema480.map(function () { return null; })
  const made = makeCanvas(900, 380)
  let error = null
  try { drawChart(made.canvas, b, { hover: 700, showEma20: true, showEma480: true }) } catch (e) { error = e }
  check(error === null, 'EMA480 全为 null 时不抛错')
}
// 空数据
{
  const b = makeBoard(0)
  b.candles = []; b.ema20 = []; b.ema480 = []
  const made = makeCanvas(900, 380)
  let error = null
  try { drawChart(made.canvas, b, { hover: null, showEma20: true, showEma480: true }) } catch (e) { error = e }
  check(error === null, '空 K 线不抛错', 'fillText=' + made.ctx.calls.fillText)
}
// 尺寸为 0（面板还没布局完）
{
  const made = makeCanvas(0, 0)
  let error = null
  try { drawChart(made.canvas, makeBoard(720), { hover: null, showEma20: true, showEma480: true }) } catch (e) { error = e }
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
    const series = d.emaFor(candles, 20, 480, 12345)
    let maxFast = 0
    let maxSlow = 0
    for (let i = 0; i < SERIES; i += 1) {
      maxFast = Math.max(maxFast, Math.abs(series.emaFast[i] - full.ema20[i]))
      maxSlow = Math.max(maxSlow, Math.abs(series.emaSlow[i] - full.ema480[i]))
    }
    check(maxFast < 1e-9 && maxSlow < 1e-9, '浏览器侧 EMA 与 Host 数组逐点一致',
      'fast=' + maxFast + ' slow=' + maxSlow)
  }

  // ---- 关键之二：可拖范围里，两条均线在每个窗口都有值（这就是原来的 bug）
  {
    const series = d.emaFor(candles, 20, 480, 12345)
    check(series.emaSlow.filter((v) => v !== null).length === SERIES - 479,
      'EMA480 从第 480 根起一直有值（预热段之外）',
      series.emaSlow.filter((v) => v !== null).length + '/' + SERIES)
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
    const a = d.emaFor(candles, 20, 480, 777)
    const b = d.emaFor(candles, 20, 480, 777)
    check(a === b, '同一 (序列, 周期, fetchedAt) 命中缓存')
    const c = d.emaFor(candles, 20, 480, 778)
    check(c !== a, 'fetchedAt 变了（新载荷）就重算')
  }

  // ---- 周期可以改：改完立刻是另一条线
  {
    const slow = d.emaFor(candles, 20, 480, 9)
    const quick = d.emaFor(candles, 20, 60, 9)
    const lastIdx = candles.length - 1
    check(Math.abs(slow.emaSlow[lastIdx] - quick.emaSlow[lastIdx]) > 1e-6, '改周期会得到不同的均线',
      slow.emaSlow[lastIdx].toFixed(2) + ' vs ' + quick.emaSlow[lastIdx].toFixed(2))
    check(quick.emaSlow[59] !== null && quick.emaSlow[58] === null, '周期 60 时第 60 根才有值')
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
    ['      // 均线', 'ema'],
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
    const frame = d.emaWindow(candles, w, emaFast, emaSlow, 4242)
    globalThis.__btcdStage = 'setup'
    const made = makeStageCtx()
    const board = {
      candles: frame.candles,
      ema20: frame.ema20,
      ema480: frame.ema480,
      meta: { barMs: 900000 },
    }
    const opts = {
      // 这一节只量「均线画了多少笔」，所以把最新价水平线（只在最右端那一帧出现）关掉
      hover: null, showEma20: true, showEma480: true, showLast: false,
      following: w.end === candles.length,
      emaFastPeriod: emaFast, emaSlowPeriod: emaSlow,
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
  if (process.env.DSH_BTC_TRACE === '1') {
    const tally = (list) => {
      const map = new Map()
      for (const item of list) map.set(item, (map.get(item) || 0) + 1)
      return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
    }
    console.log('--- trace earliest (共 ' + earliest.trace.length + ' 次 moveTo) ---')
    for (const [stack, n] of tally(earliest.trace)) console.log('  ' + n + ' × ' + stack)
    console.log('--- trace newest (共 ' + newest.trace.length + ' 次 moveTo) ---')
    for (const [stack, n] of tally(newest.trace)) console.log('  ' + n + ' × ' + stack)
  }
  check(noEma.moveTo > 0, '对照：没有均线时只画影线', 'moveTo=' + noEma.moveTo)
  check(earliest.win.start === 0 && earliest.win.end === DISPLAY,
    '拖到最早时窗口 = 序列前 ' + DISPLAY + ' 根', JSON.stringify(earliest.win))
  check(earliest.moveTo > noEma.moveTo, '拖到最早时均线也画出来了',
    '无均线=' + noEma.moveTo + ' → 有均线=' + earliest.moveTo)
  check(earliest.frame.ema480.filter((v) => v !== null).length === DISPLAY - 479,
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
    for (const size of [60, 180, 300, 720]) {
      for (const rightIdx of [720, 900, 1200, 1500, 1800]) {
        const view = { size: size, rightTs: rightIdx >= candles.length ? null : candles[rightIdx - 1][0] }
        const w = d.windowOf(candles, view)
        const frame = d.emaWindow(candles, w, 20, 480, 4242)
        // 只有序列最前面那 479 根（预热段）允许是 null；窗口只要整体在它右边，就必须全有值
        if (w.start >= 479 && frame.ema480.some(function (v) { return v === null; })) bad += 1
      }
    }
    check(bad === 0, '预热段之后的每个窗口，EMA480 切片都没有 null', 'bad=' + bad)
  }

  // ---- 面板里有均线周期输入框，且默认就是 20 / 480
  {
    const panelHtml = renderToString(React.createElement(overlay.component))
    check(panelHtml.indexOf('均线') >= 0, '面板包含「均线」周期输入')
    check(panelHtml.indexOf('value="20"') >= 0 && panelHtml.indexOf('value="480"') >= 0,
      '输入框默认 20 / 480')
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
  const range = d.priceRange(candles, board.ema20, board.ema480, true, true)
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
      drawChart(before.canvas, board, { hover: pick, hoverY: value, hoverOnCandle: where === 'candle', showEma20: true, showEma480: true })
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
      drawChart(canvas.canvas, board, { hover: pick, hoverY: y, hoverOnCandle: false, showEma20: true, showEma480: true })
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
      drawChart(made2.canvas, board, { hover: pick, hoverY: box.priceTop + box.priceH + 200, hoverOnCandle: true, showEma20: true, showEma480: true })
      drawChart(made2.canvas, board, { hover: pick, hoverY: null, hoverOnCandle: false, showEma20: true, showEma480: true })
      drawChart(made2.canvas, board, { hover: pick, showEma20: true, showEma480: true })
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
  const atLive = makeCanvas(900, 380)
  drawChart(atLive.canvas, makeBoard(720), { hover: null, showEma20: true, showEma480: true, following: true })
  const atHistory = makeCanvas(900, 380)
  drawChart(atHistory.canvas, makeBoard(720), { hover: null, showEma20: true, showEma480: true, following: false })
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
  const range = d.priceRange(candles, board.ema20, board.ema480, true, true)

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
  const top = d.pointerToData(made.canvas, candles, board.ema20, board.ema480, true, true, 100, box.priceTop, BAR_MS)
  const bottom = d.pointerToData(made.canvas, candles, board.ema20, board.ema480, true, true, 100, box.priceTop + box.priceH, BAR_MS)
  check(Math.abs(top.price - range.hi) < 1e-6, '价格区顶端 = 轴上限', top.price.toFixed(2) + ' vs ' + range.hi.toFixed(2))
  check(Math.abs(bottom.price - range.lo) < 1e-6, '价格区底端 = 轴下限')
  const firstCol = d.pointerToData(made.canvas, candles, board.ema20, board.ema480, true, true, 8 + box.step * 0.5, 100, BAR_MS)
  check(firstCol.ts === candles[0][0], '最左列 = 第一根的时间戳', String(firstCol.ts))
  const col100 = d.pointerToData(made.canvas, candles, board.ema20, board.ema480, true, true, 8 + box.step * 100.5, 100, BAR_MS)
  check(col100.ts === candles[100][0], '第 101 列 = 第 101 根的时间戳')
  const belowPane = d.pointerToData(made.canvas, candles, board.ema20, board.ema480, true, true, 100, box.priceTop + box.priceH + 500, BAR_MS)
  check(Math.abs(belowPane.price - range.lo) < 1e-6, '拖进成交量区也夹在价格区内')

  // ---- 渲染：斐波那契 / 直线 / 预览
  const shape = { kind: 'fib', t1: candles[500][0], p1: 79500, t2: candles[690][0], p2: 80500, levels: [0, 0.5, 1, 1.5, 2] }
  const line = { kind: 'line', t1: candles[520][0], p1: 79800, t2: candles[660][0], p2: 80200 }
  const base = makeCanvas(900, 380)
  drawChart(base.canvas, board, { hover: null, showEma20: true, showEma480: true, following: true, drawings: [] })
  const fibCanvas = makeCanvas(900, 380)
  drawChart(fibCanvas.canvas, board, { hover: null, showEma20: true, showEma480: true, following: true, drawings: [shape] })
  check(fibCanvas.ctx.calls.stroke > base.ctx.calls.stroke, '斐波那契画了水平线',
    base.ctx.calls.stroke + ' → ' + fibCanvas.ctx.calls.stroke)
  check(fibCanvas.ctx.calls.fillText - base.ctx.calls.fillText >= 5, '五个比例各有一个标签',
    '+' + (fibCanvas.ctx.calls.fillText - base.ctx.calls.fillText))
  check(fibCanvas.ctx.calls.setLineDash >= 2, '起点→终点画了虚线')

  const lineCanvas = makeCanvas(900, 380)
  drawChart(lineCanvas.canvas, board, { hover: null, showEma20: true, showEma480: true, following: true, drawings: [line] })
  check(lineCanvas.ctx.calls.arc >= 2, '直线画了两个端点', 'arc=' + lineCanvas.ctx.calls.arc)
  check(lineCanvas.ctx.calls.fillText - base.ctx.calls.fillText >= 2, '直线标出两端价格')

  const previewCanvas = makeCanvas(900, 380)
  drawChart(previewCanvas.canvas, board, { hover: null, showEma20: true, showEma480: true, following: true, drawings: [], preview: shape })
  check(previewCanvas.ctx.calls.stroke > base.ctx.calls.stroke, '拖动时的预览也画出来')

  // 画线在窗口外 / 缺字段时不能崩
  let threw = null
  try {
    drawChart(makeCanvas(900, 380).canvas, board, {
      hover: null, showEma20: true, showEma480: true, following: true,
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
      hover: null, showEma20: true, showEma480: true, following: true,
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
      hover: null, showEma20: true, showEma480: true, following: false, lastIndex: 719, lastPrice: last,
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
      hover: null, showEma20: true, showEma480: true, following: false, lastIndex: 719, lastPrice: last,
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
        ema20: [null],
        ema480: [null],
        meta: { barMs: 900000 },
      }, { hover: null, showEma20: false, showEma480: false, following: false, lastIndex: 0, lastPrice: null })
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

  // 交互测试要自己的 react-dom/client（与 profile 里的 react 同源）
  const RDC = createRequire(reactDomServerPath)('react-dom/client')
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
    /** 当前面板元素（点完一轮之后 DOM 可能已经被 React 换过，必须重新查） */
    panel: function () { return container.querySelector('.btcd-panel'); },
    /** 画线持久化的内容（排障用；也顺带验证"真的落到 localStorage 了"） */
    storedDrawings: function () {
      return win.localStorage.getItem('dsh-btc-dashboard:drawings:BTC-USDT-SWAP:15m');
    },
    errors: function () { return errors.slice(); },
    marks: function () { return marks; },
    win: function () { return win; },
    /** 挂载面板（先按侧边栏按钮把开关打开，跟真实路径一致） */
    mount: function () {
      sidebar2.component({ wide: true }).props.toggle()
      root = RDC.createRoot(container)
      root.render(React.createElement(overlay2.component))
      // react-dom 的并发渲染与 useEffect、以及第一次取数都是异步的，
      // 所以要等到「周期标签出现」再交出去，否则测的还是加载态
      return new Promise(function (resolve) {
        let waited = 0
        const step = function () {
          const panel = container.querySelector('.btcd-panel')
          const tabs = panel === null ? [] : panel.querySelectorAll('.btcd-tab')
          if (tabs.length >= 6 || waited > 2500) { resolve(panel); return }
          waited += 50
          setTimeout(step, 50)
        }
        step()
      });
    },
    click: function (element) {
      element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
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
      doc.dispatchEvent(event);
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
    return { candles: candles, ema20: [], ema480: [], meta: { barMs: 900000 } }
  }
  {
    const board = alternatingBoard(40)
    const painted = colorsPainted(board, { hover: null, showEma20: false, showEma480: false, following: false, lastIndex: -1 })
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
      'not', 'rgba', 'rotate', 'translateX', 'var'])
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
    const range = d.priceRange(candles, board.ema20, board.ema480, true, true)
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
    const base = { hover: null, showEma20: false, showEma480: false, following: true, lastIndex: -1 }
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
