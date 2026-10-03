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

let failed = 0
function check(ok, label, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
  if (!ok) failed += 1
}

// ---------------------------------------------------------------- 1) 载入模块

const code = readFileSync(CLIENT, 'utf8')
check(code.indexOf('export ') < 0, 'client.js 不是 ESM（没有 export 语句）')
check(code.indexOf('__ModuleLoader__.load') >= 0, 'client.js 走 __ModuleLoader__.load 注册惰性工厂')

let captured = null
const listeners = new Set()
const fakeWindow = {
  __ModuleLoader__: { load: function (def) { captured = def; } },
  devicePixelRatio: 2,
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
  const calls = { fillRect: 0, fillText: 0, stroke: 0, moveTo: 0, lineTo: 0, setLineDash: 0, clearRect: 0, roundRect: 0, rect: 0, arc: 0 };
  const ctx = {
    calls: calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    setTransform: function () {}, clearRect: function () { calls.clearRect += 1; },
    beginPath: function () {}, closePath: function () {},
    moveTo: function () { calls.moveTo += 1; }, lineTo: function () { calls.lineTo += 1; },
    stroke: function () { calls.stroke += 1; }, fill: function () {},
    fillRect: function () { calls.fillRect += 1; }, strokeRect: function () {},
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
  function frameStrokes(viewTime, emaFast, emaSlow) {
    const view = { size: DISPLAY, rightTs: viewTime }
    const w = d.windowOf(candles, view)
    const frame = d.emaWindow(candles, w, emaFast, emaSlow, 4242)
    const made = makeCanvas(900, 380)
    drawChart(made.canvas, {
      candles: frame.candles,
      ema20: frame.ema20,
      ema480: frame.ema480,
      meta: { barMs: 900000 },
    }, {
      hover: null, showEma20: true, showEma480: true,
      following: w.end === candles.length,
      emaFastPeriod: emaFast, emaSlowPeriod: emaSlow,
    })
    return { moveTo: made.ctx.calls.moveTo, lineTo: made.ctx.calls.lineTo, win: w, frame: frame }
  }
  const noEma = frameStrokes(null, 999999, 999999) // 周期大到算不出来：只有影线
  const earliest = frameStrokes(candles[DISPLAY - 1][0], 20, 480) // 拖到最早
  const newest = frameStrokes(null, 20, 480)
  check(noEma.moveTo > 0, '对照：没有均线时只画影线', 'moveTo=' + noEma.moveTo)
  check(earliest.win.start === 0 && earliest.win.end === DISPLAY,
    '拖到最早时窗口 = 序列前 ' + DISPLAY + ' 根', JSON.stringify(earliest.win))
  check(earliest.moveTo > noEma.moveTo, '拖到最早时均线也画出来了',
    '无均线=' + noEma.moveTo + ' → 有均线=' + earliest.moveTo)
  check(earliest.frame.ema480.filter((v) => v !== null).length === DISPLAY - 479,
    '最早那一帧里 EMA480 的有效值 = ' + (DISPLAY - 479) + '（前 479 根数学上画不出）')
  check(earliest.moveTo === newest.moveTo, '最早窗口与最新窗口的均线落笔点数一致',
    earliest.moveTo + ' vs ' + newest.moveTo + '（修复前最早窗口只剩 ' + noEma.moveTo + '）')

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
    check(panelHtml.indexOf('均线周期') >= 0, '面板包含「均线周期」输入')
    check(panelHtml.indexOf('value="20"') >= 0 && panelHtml.indexOf('value="480"') >= 0,
      '输入框默认 20 / 480')
  }

  console.log('     （本节 ' + (failed - failedBefore === 0 ? '全部通过' : (failed - failedBefore) + ' 项失败') + '）')
}

// ---------------------------------------------------------------- 4.45) 悬浮：两档显示
//
// 需求：十字光标跟着鼠标走（空白处也要显示鼠标位置对应的价格），
// 但 K 线数据框只在指针真的压在实体/影线上时才弹。
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

// ---------------------------------------------------------------- 5) 格式化

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
process.exitCode = failed === 0 ? 0 : 1
