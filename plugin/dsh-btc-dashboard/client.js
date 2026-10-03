/**
 * dsh-btc-dashboard —— OKX BTC 合约看板的浏览器半（client.js）。
 *
 * 注意两件事，它们由 DSH 的客户端模块机制定死：
 *   1. 这个文件不是 ESM：必须用 window.__ModuleLoader__.load({ id, factory }) 注册惰性工厂，
 *      且 id 必须等于包名（@local/dsh-btc-dashboard）。宿主按原样把这些字节发给浏览器，不做构建。
 *   2. 只能 require 平台种子表里的模块（这里用 react），其它一律不准 —— 所以图表用原生 canvas 画。
 *
 * 数据全部来自 Host 半注册的同源路由 /dsh-btc/*：没有 CORS，密钥也永远不进浏览器。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-btc-dashboard',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    var API = '/dsh-btc';
    var REFRESH_MS = 5000;
    // 一次要够多的历史：拖动时间轴能往回看多远，取决于这里拿到多少根（Host 端 MAX_DISPLAY 封顶）。
    var FETCH_LIMIT = 720;
    var RANGES = [60, 120, 180, 300];
    var MIN_WINDOW = 30;

    // 图表用色属于「作品色」：不跟主题 token 走，但只作用在本面板里。
    var UP = 'var(--btcd-up)';
    var DOWN = 'var(--btcd-down)';
    var C_UP = '#16c784';
    var C_DOWN = '#ea3943';
    var C_EMA20 = '#f0b90b';
    var C_EMA480 = '#a78bfa';
    // 与 Host 半的 EMA_FAST / EMA_SLOW 对齐（Host 只用来出图例数字，曲线在浏览器里算）
    var DEFAULT_EMA_FAST = 20;
    var DEFAULT_EMA_SLOW = 480;
    var C_GRID = 'rgba(128,140,155,0.18)';
    var C_AXIS = 'rgba(140,152,166,0.9)';

    var CSS = [
      '.btcd-ico{display:inline-flex;align-items:center;gap:6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:transparent;border:none;color:inherit;font:inherit;font-size:12px;cursor:pointer;padding:4px 8px;border-radius:6px}',
      '.btcd-ico:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.btcd-ico .btcd-up{color:var(--btcd-up)}',
      '.btcd-ico .btcd-down{color:var(--btcd-down)}',
      '.btcd-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px}',
      '.btcd-panel{--btcd-up:#16c784;--btcd-down:#ea3943;width:min(1180px,96vw);height:min(780px,92vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#22282e);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l1,#3a4149);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.35);overflow:hidden;font-size:13px}',
      '.btcd-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#3a4149);flex-wrap:wrap}',
      '.btcd-title{font-size:14px;font-weight:600}',
      '.btcd-chip{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#2b333b);color:var(--dsw-alias-label-secondary,#98a2ad);white-space:nowrap}',
      '.btcd-chip.btcd-demo{background:rgba(240,185,11,.16);color:#f0b90b}',
      '.btcd-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,#4a535c);border-radius:8px;overflow:hidden}',
      '.btcd-seg button{background:transparent;border:none;color:var(--dsw-alias-label-secondary,#98a2ad);padding:5px 12px;font-size:12px;cursor:pointer}',
      '.btcd-seg button.on{background:var(--dsw-alias-brand-primary,#4a8cff);color:#fff}',
      '.btcd-seg button:disabled{opacity:.6;cursor:default}',
      '.btcd-spacer{margin-left:auto}',
      '.btcd-x{background:transparent;border:1px solid var(--dsw-alias-border-l2,#4a535c);color:var(--dsw-alias-label-secondary,#98a2ad);border-radius:6px;width:26px;height:26px;cursor:pointer;line-height:1}',
      '.btcd-x:hover{color:var(--dsw-alias-label-primary,#e8e8e8);border-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-price-row{display:flex;align-items:baseline;gap:16px;padding:8px 14px 4px;flex-wrap:wrap}',
      '.btcd-last{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.5px}',
      '.btcd-chg{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.btcd-up{color:var(--btcd-up)}',
      '.btcd-down{color:var(--btcd-down)}',
      '.btcd-kv{display:flex;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,#98a2ad);font-size:12px;font-variant-numeric:tabular-nums}',
      '.btcd-kv b{color:var(--dsw-alias-label-primary,#e8e8e8);font-weight:500}',
      '.btcd-bar{display:flex;align-items:center;gap:10px;padding:6px 14px;flex-wrap:wrap}',
      '.btcd-tabs{display:flex;gap:4px;flex-wrap:wrap}',
      '.btcd-tab{background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary,#98a2ad);border-radius:6px;padding:4px 11px;font-size:12px;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.btcd-tab:hover{background:var(--dsw-alias-bg-layer-2,#2b333b)}',
      '.btcd-tab.on{background:var(--dsw-alias-bg-layer-2,#2b333b);border-color:var(--dsw-alias-border-l2,#4a535c);color:var(--dsw-alias-label-primary,#e8e8e8);font-weight:600}',
      '.btcd-mini{background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary,#98a2ad);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer}',
      '.btcd-mini.on{background:var(--dsw-alias-bg-layer-2,#2b333b);color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.btcd-toggle{background:transparent;border:none;color:var(--dsw-alias-label-secondary,#98a2ad);font-size:11px;cursor:pointer;padding:3px 6px;border-radius:6px}',
      '.btcd-toggle:hover{background:var(--dsw-alias-bg-layer-2,#2b333b)}',
      '.btcd-chart-wrap{flex:1;min-height:260px;position:relative;padding:2px 8px 0}',
      '.btcd-canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none}',
      '.btcd-canvas.btcd-grabbing{cursor:grabbing}',
      '.btcd-canvas.btcd-drawmode{cursor:crosshair}',
      '.btcd-levels{width:150px;background:var(--dsw-alias-bg-base,#1a1f24);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l2,#4a535c);border-radius:6px;padding:3px 8px;font-size:11.5px;font-variant-numeric:tabular-nums;outline:none}',
      '.btcd-levels:focus{border-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-period{width:58px;background:var(--dsw-alias-bg-base,#1a1f24);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l2,#4a535c);border-radius:6px;padding:3px 7px;font-size:11.5px;font-variant-numeric:tabular-nums;outline:none;text-align:right}',
      '.btcd-period:focus{border-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-backlive{position:absolute;top:8px;right:16px;z-index:2;background:var(--dsw-alias-brand-primary,#4a8cff);color:#fff;border:none;border-radius:999px;padding:4px 11px;font-size:11px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.28)}',
      '.btcd-hint{opacity:.7}',
      '.btcd-center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#98a2ad);font-size:13px;text-align:center;padding:0 24px}',
      '.btcd-legend{display:flex;align-items:center;gap:14px;padding:4px 14px;font-size:12px;color:var(--dsw-alias-label-secondary,#98a2ad);flex-wrap:wrap}',
      '.btcd-legend button{background:none;border:none;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 4px;border-radius:4px}',
      '.btcd-legend button:hover{background:var(--dsw-alias-bg-layer-2,#2b333b)}',
      '.btcd-legend button.off{opacity:.42;text-decoration:line-through}',
      '.btcd-dot{width:9px;height:3px;border-radius:2px;display:inline-block}',
      '.btcd-foot{display:flex;gap:14px;flex-wrap:wrap;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l1,#3a4149);font-size:11.5px;color:var(--dsw-alias-label-secondary,#98a2ad);font-variant-numeric:tabular-nums}',
      '.btcd-warn{color:var(--dsw-alias-state-warn-primary,#e0a800)}',
      '.btcd-err{color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
      '.btcd-ok{color:var(--dsw-alias-state-success-primary,#16c784)}',
    ].join('');

    function injectCss() {
      if (typeof document === 'undefined') return;
      var tagId = 'dsh-btc-dashboard/css';
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-btc-dashboard';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** localStorage 读写（不存在就当作空，别让画线功能拖垮面板）。 */
    function loadStored(key, fallback) {
      try {
        if (typeof window === 'undefined' || window.localStorage === undefined) return fallback;
        var raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (error) {
        return fallback;
      }
    }

    function saveStored(key, value) {
      try {
        if (typeof window === 'undefined' || window.localStorage === undefined) return;
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        // 存不上不影响本次会话里的绘制
      }
    }

    // ------------------------------------------------------------------ 格式化

    function digitsOf(value) {
      var v = Math.abs(Number(value));
      if (!isFinite(v)) return 2;
      if (v >= 1000) return 1;
      if (v >= 10) return 2;
      if (v >= 1) return 3;
      return 5;
    }

    function fmtPrice(value, digits) {
      if (value === null || value === undefined || !isFinite(Number(value))) return '—';
      var d = digits === undefined ? digitsOf(value) : digits;
      return Number(value).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    }

    function fmtSigned(value, digits, suffix) {
      if (value === null || value === undefined || !isFinite(Number(value))) return '—';
      var n = Number(value);
      var d = digits === undefined ? Math.abs(n) >= 100 ? 1 : 2 : digits;
      return (n > 0 ? '+' : '') + n.toFixed(d) + (suffix === undefined ? '' : suffix);
    }

    function fmtPct(value, digits) {
      if (value === null || value === undefined || !isFinite(Number(value))) return '—';
      var n = Number(value);
      var d = digits === undefined ? 2 : digits;
      return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
    }

    function fmtVol(value) {
      if (value === null || value === undefined || !isFinite(Number(value))) return '—';
      var n = Number(value);
      if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
      return n.toFixed(2);
    }

    function pad2(n) {
      return n < 10 ? '0' + n : String(n);
    }

    /** 周期决定时间粒度：日线只给日期，日内给 HH:MM。 */
    function fmtTime(ts, barMs, withDate) {
      if (ts === null || ts === undefined) return '—';
      var d = new Date(Number(ts));
      var date = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      if (barMs !== undefined && barMs >= 86400000) return date;
      return withDate === true ? date + ' ' + time : time;
    }

    function agoText(ms) {
      var s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + ' 秒前';
      var m = Math.floor(s / 60);
      if (m < 60) return m + ' 分钟前';
      return Math.floor(m / 60) + ' 小时前';
    }

    // ------------------------------------------------------------------ 均线（在浏览器里算）
    //
    // 为什么要客户端自己算，而不是直接用 Host 发来的 ema20/ema480 数组：
    //   EMA 是递推量 —— 第 i 根的值依赖它前面所有 K 线，数组前 period-1 位必然是 null
    //   （EMA480 有 479 个 null，而默认窗口才 180 根）。时间轴往回一拖，可见窗口就滑进了
    //   这段 null 里：紫线整段消失，这就是「窗口外的均线没有绘制」。
    // 现在的做法：Host 发整条带预热的序列（SERIES_BARS，含 1080 根预热），浏览器
    //   ① 在整条序列上按当前周期算一遍 EMA（默认 20/480，与 Host 口径逐点相同）；
    //   ② 画之前按窗口切片。
    // 于是拖动/缩放时每个窗口都有均线，改周期也是即时重算，不额外打网络。

    /**
     * 整条收盘价序列的 EMA：前 period 根的 SMA 做种子，之后递推。
     * 与 Host 半的 ema() 是同一套口径（host-test 里对手算结果做过回归），
     * 所以默认周期下这里算出来的值和 Host 的 ema20/ema480 数组逐点相同。
     */
    function emaSeries(closes, period) {
      var len = closes.length;
      var out = new Array(len);
      var i;
      for (i = 0; i < len; i += 1) out[i] = null;
      var n = Math.round(Number(period));
      if (!isFinite(n) || n < 1 || len < n) return out;
      var sum = 0;
      for (i = 0; i < n; i += 1) sum += Number(closes[i]);
      var prev = sum / n;
      out[n - 1] = prev;
      var k = 2 / (n + 1);
      for (i = n; i < len; i += 1) {
        prev = Number(closes[i]) * k + prev * (1 - k);
        out[i] = prev;
      }
      return out;
    }

    /** 从 K 线里取收盘价。 */
    function closesOf(candles) {
      var out = [];
      for (var i = 0; i < candles.length; i += 1) out.push(candles[i][4]);
      return out;
    }

    /** 均线周期：夹到 [2, 2000]，非数字/空 → 用旧值。 */
    function parsePeriod(text, fallback) {
      var raw = String(text === undefined || text === null ? '' : text).trim();
      if (raw === '' || /^[0-9]{1,6}$/.test(raw) !== true) return fallback;
      var n = Number(raw);
      if (!isFinite(n) || n < 2) return fallback;
      return Math.min(2000, Math.round(n));
    }

    /**
     * 「整条序列 + 窗口 + 周期」→ 这一帧要画的东西。
     * 均线在整条序列上现算，再按窗口切片，所以窗口停在哪儿，均线就跟到哪儿。
     */
    function emaWindow(candles, win, emaFast, emaSlow, stamp) {
      var series = emaFor(candles, emaFast, emaSlow, stamp);
      return {
        candles: candles.slice(win.start, win.end),
        ema20: series.emaFast.slice(win.start, win.end),
        ema480: series.emaSlow.slice(win.start, win.end),
      };
    }

    var EMA_PERIOD_MAX = 2000;
    var EMA_PERIOD_MIN = 2;
    var EMA_CACHE_MAX = 6;
    var emaCache = new Map();

    /**
     * 「整条序列 + 两个周期」→ { fast, slow, emaFast, emaSlow }，带小型缓存。
     * 缓存键含载荷的 fetchedAt：同一段行情在拖动/缩放时反复要用，不必每次 mousemove 重算，
     * 但每次刷新（哪怕只有最后一根在动）都得重算。
     */
    function emaFor(candles, fastPeriod, slowPeriod, stamp) {
      var len = candles.length;
      var fast = Math.round(clampNum(fastPeriod, EMA_PERIOD_MIN, EMA_PERIOD_MAX));
      var slow = Math.round(clampNum(slowPeriod, EMA_PERIOD_MIN, EMA_PERIOD_MAX));
      var key = String(len) + '|' + String(fast) + '|' + String(slow)
        + '|' + String(stamp === undefined || stamp === null ? 0 : stamp)
        + '|' + String(len === 0 ? 0 : candles[0][0])
        + '|' + String(len === 0 ? 0 : candles[len - 1][0]);
      var hit = emaCache.get(key);
      if (hit !== undefined) return hit;
      var closes = closesOf(candles);
      var made = { fast: fast, slow: slow, emaFast: emaSeries(closes, fast), emaSlow: emaSeries(closes, slow) };
      if (emaCache.size >= EMA_CACHE_MAX) emaCache.clear();
      emaCache.set(key, made);
      return made;
    }

    // ------------------------------------------------------------------ 画图

    function cssVar(name, fallback) {
      if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fallback;
      var probe = document.querySelector('.btcd-panel');
      if (probe === null) return fallback;
      var value = getComputedStyle(probe).getPropertyValue(name);
      return value !== undefined && String(value).trim() !== '' ? String(value).trim() : fallback;
    }

    // ------------------------------------------------------------------ 时间轴窗口（纯函数，便于离线自检）
    //
    // 视图用「窗口根数 size + 右端那根的时间戳 rightTs」描述，rightTs === null 表示跟随最新。
    // 为什么不记下标：每次刷新历史会从左边滑走、新 K 线从右边进来，下标会整体漂移；
    // 记住时间戳，用户正在看的那几根 K 线才会停在原地。

    function clampNum(value, lo, hi) {
      var n = Number(value);
      if (!isFinite(n)) n = lo;
      if (n < lo) return lo;
      if (n > hi) return hi;
      return n;
    }

    function clampInt(value, lo, hi) {
      if (hi < lo) hi = lo;
      var n = Math.round(Number(value));
      if (!isFinite(n)) n = lo;
      if (n < lo) return lo;
      if (n > hi) return hi;
      return n;
    }

    /** K 线按时间升序时，返回「最后一个 ts <= 目标」的下一个下标（用作窗口右端，左闭右开）。 */
    function indexAfter(candles, ts) {
      var lo = 0;
      var hi = candles.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (candles[mid][0] <= ts) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    /** 视图 → 可见区间 { start, end }（左闭右开）。 */
    function windowOf(candles, view) {
      var len = candles.length;
      if (len === 0) return { start: 0, end: 0 };
      var size = clampInt(view.size, Math.min(MIN_WINDOW, len), len);
      var follow = view.rightTs === null || view.rightTs === undefined;
      var end = follow ? len : indexAfter(candles, view.rightTs);
      var minEnd = Math.min(size, len);
      if (end > len) end = len;
      if (end < minEnd) end = minEnd;
      var start = end - size;
      if (start < 0) start = 0;
      return { start: start, end: end };
    }

    /** 平移：delta > 0 往更早看，delta < 0 往更新看；贴到最右端自动回到「跟随最新」。 */
    function panView(candles, view, delta) {
      var len = candles.length;
      if (len === 0) return view;
      var w = windowOf(candles, view);
      var size = w.end - w.start;
      var end = clampInt(w.end - delta, Math.min(size, len), len);
      if (end >= len) return { size: size, rightTs: null };
      return { size: size, rightTs: candles[end - 1][0] };
    }

    /** 缩放：anchorFraction 是锚点在窗口里的相对位置（0 = 左端，1 = 右端），滚轮传光标位置。 */
    function zoomView(candles, view, nextSize, anchorFraction) {
      var len = candles.length;
      var minSize = Math.min(MIN_WINDOW, len);
      if (len === 0) return { size: MIN_WINDOW, rightTs: null };
      var w = windowOf(candles, view);
      var size = clampInt(nextSize, minSize, len);
      var f = clampNum(anchorFraction === undefined || anchorFraction === null ? 1 : anchorFraction, 0, 1);
      var anchor = w.start + f * (w.end - w.start);
      var end = clampInt(anchor + (1 - f) * size, Math.min(size, len), len);
      if (end >= len) return { size: size, rightTs: null };
      return { size: size, rightTs: candles[end - 1][0] };
    }

    // ------------------------------------------------------------------ 绘图几何（绘制与指针换算共用同一份）

    var PAD_LEFT = 8;
    var PAD_RIGHT = 74;
    var PAD_TOP = 10;
    var PAD_BOTTOM = 22;
    var VOL_RATIO = 0.16;
    var VOL_GAP = 8;
    var FIB_COLORS = ['#9aa4b2', '#f0b90b', '#4a8cff', '#a78bfa', '#ea3943', '#2dd4bf', '#fb923c'];
    var DEFAULT_FIB_LEVELS = [0, 0.5, 1, 1.5, 2];
    var MAX_FIB_LEVELS = 12;
    // 悬浮命中的容差（CSS 像素）：实体也就几像素宽，没有这点余量几乎点不中
    var CANDLE_HIT_PX = 3;

    function plotBox(canvas, count) {
      var cssW = canvas.clientWidth || 900;
      var cssH = canvas.clientHeight || 380;
      var plotW = Math.max(40, cssW - PAD_LEFT - PAD_RIGHT);
      var plotH = Math.max(60, cssH - PAD_TOP - PAD_BOTTOM);
      var volH = Math.round(plotH * VOL_RATIO);
      var priceH = plotH - volH - VOL_GAP;
      return {
        cssW: cssW,
        cssH: cssH,
        plotW: plotW,
        plotH: plotH,
        volH: volH,
        priceH: priceH,
        priceTop: PAD_TOP,
        volTop: PAD_TOP + priceH + VOL_GAP,
        step: plotW / Math.max(1, count),
      };
    }

    /**
     * 指针是不是落在第 index 根 K 线上（实体矩形，或上下影线那一条）。
     * 用来区分两档悬浮：
     *   * 命中 K 线 → 弹完整的 OHLC / 量 / 均线数据框
     *   * 只在画布空白处 → 只画十字光标 + 鼠标位置的价格
     * 判定用的就是 drawChart 画实体/影线的同一套 xOf / yOf、同一个 bodyW，不会出现「看着压上了却没框」。
     */
    function hitCandle(box, range, candles, index, localX, localY) {
      if (!Array.isArray(candles) || candles.length === 0) return false;
      if (!Number.isInteger(index) || index < 0 || index >= candles.length) return false;
      if (range === null || range === undefined) return false;
      var row = candles[index];
      if (!Array.isArray(row)) return false;
      var span = range.hi - range.lo || 1;
      var priceH = box.priceH;
      function yOf(price) {
        return box.priceTop + priceH - ((price - range.lo) / span) * priceH;
      }
      var xOf = PAD_LEFT + box.step * index + box.step / 2;
      var bodyW = Math.max(1, Math.min(box.step * 0.66, 18));
      var tol = CANDLE_HIT_PX;

      // 实体：与画出来的一样，最小 1px 高（十字星也要能点中）
      var yOpen = yOf(row[1]);
      var yClose = yOf(row[4]);
      var top = Math.min(yOpen, yClose);
      var height = Math.max(1, Math.abs(yClose - yOpen));
      if (localX >= xOf - bodyW / 2 - tol && localX <= xOf + bodyW / 2 + tol
        && localY >= top - tol && localY <= top + height + tol) {
        return true;
      }
      // 上下影线：x 贴着中心线、y 在高低价之间
      var yHigh = yOf(row[2]);
      var yLow = yOf(row[3]);
      return localX >= xOf - tol && localX <= xOf + tol
        && localY >= Math.min(yHigh, yLow) - tol && localY <= Math.max(yHigh, yLow) + tol;
    }

    /** 价格轴范围：K 线高低点 + 可见均线，留 6% 余量。放不下时返回 null。 */
    function priceRange(candles, ema20, ema480, showEma20, showEma480) {
      var lo = Infinity;
      var hi = -Infinity;
      var i;
      var v;
      for (i = 0; i < candles.length; i += 1) {
        if (candles[i][3] < lo) lo = candles[i][3];
        if (candles[i][2] > hi) hi = candles[i][2];
      }
      if (showEma20) {
        for (i = 0; i < ema20.length; i += 1) {
          v = ema20[i];
          if (v !== null && v !== undefined) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (showEma480) {
        for (i = 0; i < ema480.length; i += 1) {
          v = ema480[i];
          if (v !== null && v !== undefined) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (!isFinite(lo) || !isFinite(hi)) return null;
      var pad = (hi - lo) * 0.06 || Math.max(1, Math.abs(hi) * 0.001);
      return { lo: lo - pad, hi: hi + pad };
    }

    /** 时间戳 → 窗口内的小数下标（绘图点可以落在两根 K 线之间，也可以落在窗口之外）。 */
    function indexFrac(candles, ts, barMs) {
      var len = candles.length;
      if (len === 0) return 0;
      if (len === 1) return 0;
      var first = candles[0][0];
      var last = candles[len - 1][0];
      var ms = barMs > 0 ? barMs : (last - first) / (len - 1);
      if (!(ms > 0)) ms = 1;
      if (ts <= first) return (ts - first) / ms;
      if (ts >= last) return (len - 1) + (ts - last) / ms;
      var lo = 0;
      var hi = len - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (candles[mid][0] <= ts) lo = mid;
        else hi = mid;
      }
      var a = candles[lo][0];
      var b = candles[hi][0];
      return lo + (b === a ? 0 : (ts - a) / (b - a));
    }

    /** 小数下标 → 时间戳（画线时把指针位置存成数据坐标要用）。 */
    function tsAtIndex(candles, index, barMs) {
      var len = candles.length;
      if (len === 0) return 0;
      if (len === 1) return candles[0][0];
      var last = len - 1;
      var first = candles[0][0];
      var ms = barMs > 0 ? barMs : (candles[last][0] - first) / last;
      if (!(ms > 0)) ms = 1;
      if (index <= 0) return first + index * ms;
      if (index >= last) return candles[last][0] + (index - last) * ms;
      var lo = Math.floor(index);
      var f = index - lo;
      return candles[lo][0] + (candles[lo + 1][0] - candles[lo][0]) * f;
    }

    /** 斐波那契价位：0 → 起点 p1，1 → 终点 p2，1.5 / 2 → p2 之外的扩展位。 */
    function fibPrice(p1, p2, ratio) {
      return p1 + (p2 - p1) * ratio;
    }

    /** 把 "0,0.5,1,1.5,2" 解析成价位数组；不合法就退回默认。 */
    function parseFibLevels(text) {
      var parts = String(text === undefined || text === null ? '' : text).split(/[,，\s]+/);
      var out = [];
      for (var i = 0; i < parts.length && out.length < MAX_FIB_LEVELS; i += 1) {
        if (parts[i] === '') continue;
        var n = Number(parts[i]);
        if (isFinite(n)) out.push(n);
      }
      return out.length > 0 ? out : DEFAULT_FIB_LEVELS.slice();
    }

    /** 指针 → 数据坐标 { index, price }；与 drawChart 用同一套 box / range，避免线画偏。 */
    function pointerToData(canvas, candles, ema20, ema480, showEma20, showEma480, clientX, clientY, barMs) {
      if (candles.length === 0) return null;
      var box = plotBox(canvas, candles.length);
      var range = priceRange(candles, ema20, ema480, showEma20, showEma480);
      if (range === null) return null;
      var rect = canvas.getBoundingClientRect();
      var span = range.hi - range.lo || 1;
      var localX = clientX - rect.left;
      var localY = clampNum(clientY - rect.top, box.priceTop, box.priceTop + box.priceH);
      var index = (localX - PAD_LEFT) / box.step - 0.5;
      return {
        index: index,
        // 存时间戳而不是下标：刷新/切换周期后仍然指向同一时刻
        ts: tsAtIndex(candles, index, barMs),
        price: range.lo + (1 - (localY - box.priceTop) / box.priceH) * span,
        box: box,
        range: range,
      };
    }

    function drawChart(canvas, board, view) {
      if (canvas === null || board === null) return;
      var dpr = window.devicePixelRatio || 1;
      var cssW = canvas.clientWidth || 900;
      var cssH = canvas.clientHeight || 380;
      if (cssW < 40 || cssH < 60) return;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      var g = canvas.getContext('2d');
      if (g === null) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cssW, cssH);

      var up = cssVar('--btcd-up', C_UP);
      var down = cssVar('--btcd-down', C_DOWN);
      var candles = Array.isArray(board.candles) ? board.candles : [];
      var ema20 = Array.isArray(board.ema20) ? board.ema20 : [];
      var ema480 = Array.isArray(board.ema480) ? board.ema480 : [];
      var labelColor = cssVar('--dsw-alias-label-secondary', '#98a2ad');
      if (candles.length === 0) {
        g.fillStyle = labelColor;
        g.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.fillText('没有 K 线数据', 16, 30);
        return;
      }

      var box = plotBox(canvas, candles.length);
      var padL = PAD_LEFT;
      var padR = PAD_RIGHT;
      var padT = PAD_TOP;
      var padB = PAD_BOTTOM;
      var plotW = box.plotW;
      var plotH = box.plotH;
      var volH = box.volH;
      var priceH = box.priceH;
      var priceTop = box.priceTop;
      var volTop = box.volTop;
      var step = box.step;

      var range = priceRange(candles, ema20, ema480, view.showEma20, view.showEma480);
      if (range === null) return;
      var lo = range.lo;
      var hi = range.hi;
      var span = hi - lo || 1;
      var i;
      var j;

      function xOf(index) {
        return padL + step * index + step / 2;
      }

      function yOf(price) {
        return priceTop + priceH - ((price - lo) / span) * priceH;
      }

      // 横向网格 + 右侧价格刻度
      g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textBaseline = 'middle';
      var lines = 5;
      for (i = 0; i <= lines; i += 1) {
        var price = lo + (span * i) / lines;
        var y = yOf(price);
        g.strokeStyle = C_GRID;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(padL, Math.round(y) + 0.5);
        g.lineTo(padL + plotW, Math.round(y) + 0.5);
        g.stroke();
        g.fillStyle = labelColor;
        g.textAlign = 'left';
        g.fillText(fmtPrice(price, digitsOf(price)), padL + plotW + 8, y);
      }

      // 成交量
      var volMax = 0;
      for (i = 0; i < candles.length; i += 1) if (candles[i][5] > volMax) volMax = candles[i][5];
      if (volMax <= 0) volMax = 1;
      g.fillStyle = C_GRID;
      g.textAlign = 'left';
      g.fillText('VOL ' + fmtVol(volMax), padL + 2, volTop + 8);
      for (i = 0; i < candles.length; i += 1) {
        var c = candles[i];
        var hVol = Math.max(0.5, (c[5] / volMax) * (volH - 12));
        var x = xOf(i);
        g.fillStyle = c[4] >= c[1] ? up : down;
        g.globalAlpha = 0.5;
        g.fillRect(x - Math.max(1, step * 0.3), volTop + volH - hVol, Math.max(1, step * 0.6), hVol);
        g.globalAlpha = 1;
      }

      // K 线
      var bodyW = Math.max(1, Math.min(step * 0.66, 18));
      for (i = 0; i < candles.length; i += 1) {
        var row = candles[i];
        var isUp = row[4] >= row[1];
        var color = isUp ? up : down;
        var cx = xOf(i);
        g.strokeStyle = color;
        g.fillStyle = color;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx, yOf(row[2]));
        g.lineTo(cx, yOf(row[3]));
        g.stroke();
        var yOpen = yOf(row[1]);
        var yClose = yOf(row[4]);
        var top = Math.min(yOpen, yClose);
        var height = Math.max(1, Math.abs(yClose - yOpen));
        g.fillRect(cx - bodyW / 2, top, bodyW, height);
      }

      // 均线
      function drawLine(series, color) {
        g.strokeStyle = color;
        g.lineWidth = 1.7;
        g.beginPath();
        var started = false;
        for (j = 0; j < series.length && j < candles.length; j += 1) {
          var value = series[j];
          if (value === null || value === undefined) {
            started = false;
            continue;
          }
          var px = xOf(j);
          var py = yOf(value);
          if (!started) {
            g.moveTo(px, py);
            started = true;
          } else {
            g.lineTo(px, py);
          }
        }
        g.stroke();
      }
      if (view.showEma20) drawLine(ema20, C_EMA20);
      if (view.showEma480) drawLine(ema480, C_EMA480);

      // ---- 用户画的线（直线 / 斐波那契）；画在 K 线与均线之上、十字光标之下
      var barMsDraw = board.meta === undefined || board.meta === null ? 0 : Number(board.meta.barMs || 0);

      function xOfTs(ts) {
        return padL + step * (indexFrac(candles, ts, barMsDraw) + 0.5);
      }

      function paintLine(shape, alpha) {
        var x1 = xOfTs(shape.t1);
        var y1 = yOf(shape.p1);
        var x2 = xOfTs(shape.t2);
        var y2 = yOf(shape.p2);
        g.globalAlpha = alpha;
        g.strokeStyle = '#4a8cff';
        g.lineWidth = 1.7;
        g.setLineDash([]);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.fillStyle = '#4a8cff';
        g.beginPath();
        g.arc(x1, y1, 3, 0, Math.PI * 2);
        g.fill();
        g.beginPath();
        g.arc(x2, y2, 3, 0, Math.PI * 2);
        g.fill();
        // 起止价格，方便对照
        g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.textAlign = 'left';
        g.textBaseline = 'bottom';
        g.fillText(fmtPrice(shape.p1, digitsOf(shape.p1)), x1 + 6, y1 - 3);
        g.fillText(fmtPrice(shape.p2, digitsOf(shape.p2)), x2 + 6, y2 - 3);
        g.globalAlpha = 1;
      }

      function paintFib(shape, alpha) {
        var x1 = xOfTs(shape.t1);
        var y1 = yOf(shape.p1);
        var x2 = xOfTs(shape.t2);
        var y2 = yOf(shape.p2);
        var levels = Array.isArray(shape.levels) && shape.levels.length > 0 ? shape.levels : DEFAULT_FIB_LEVELS;
        g.globalAlpha = alpha;
        // 起点→终点的虚线
        g.setLineDash([4, 4]);
        g.strokeStyle = FIB_COLORS[1 % FIB_COLORS.length];
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.setLineDash([]);
        g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.textAlign = 'left';
        g.textBaseline = 'bottom';
        for (var k = 0; k < levels.length; k += 1) {
          var ratio = levels[k];
          var price = fibPrice(shape.p1, shape.p2, ratio);
          var y = yOf(price);
          var color = FIB_COLORS[k % FIB_COLORS.length];
          g.strokeStyle = color;
          g.lineWidth = ratio === 0 || ratio === 1 ? 1.5 : 1;
          g.beginPath();
          g.moveTo(padL, y);
          g.lineTo(padL + plotW, y);
          g.stroke();
          g.fillStyle = color;
          g.fillText(String(ratio) + '  ' + fmtPrice(price, digitsOf(price)), padL + 4, y - 2);
        }
        g.globalAlpha = 1;
      }

      var annots = Array.isArray(view.drawings) ? view.drawings : [];
      for (i = 0; i < annots.length; i += 1) {
        var shape = annots[i];
        if (shape === null || shape === undefined) continue;
        if (shape.kind === 'fib') paintFib(shape, 0.95);
        else paintLine(shape, 0.95);
      }
      if (view.preview !== null && view.preview !== undefined) {
        if (view.preview.kind === 'fib') paintFib(view.preview, 0.55);
        else paintLine(view.preview, 0.6);
      }

      // 时间刻度
      g.fillStyle = labelColor;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      var ticks = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
      var barMs = board.meta === undefined || board.meta === null ? 0 : Number(board.meta.barMs || 0);
      for (i = 0; i <= ticks; i += 1) {
        var index = Math.round((candles.length - 1) * (i / ticks));
        var tickX = xOf(index);
        if (tickX < padL + 14 || tickX > padL + plotW - 14) continue;
        g.fillText(fmtTime(candles[index][0], barMs, false), tickX, volTop + volH + 6);
      }

      // 十字光标 + 浮层
      //
      // 两档显示（view.hoverOnCandle 由 Chart 的指针命中判定给出）：
      //   * 指针在画布空白处：只画十字光标，价格轴上标出「鼠标位置对应的价格」
      //   * 指针压在某根 K 线的实体/影线上：再弹完整的 OHLC / 量 / 均线数据框
      var hover = view.hover;
      if (hover !== null && hover !== undefined && hover >= 0 && hover < candles.length) {
        var hc = candles[hover];
        var hx = xOf(hover);
        var onCandle = view.hoverOnCandle === true;
        // 空白处时横线要跟着鼠标走（看的是指针那一点的价格），命中 K 线时才吸附到收盘价
        var hy = onCandle ? yOf(hc[4]) : clampNum(Number(view.hoverY), priceTop, priceTop + priceH);
        if (isFinite(hy) !== true) hy = yOf(hc[4]);
        var hoverPrice = onCandle ? hc[4] : lo + (1 - (hy - priceTop) / priceH) * span;

        g.strokeStyle = 'rgba(150,160,175,0.55)';
        g.setLineDash([3, 3]);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(hx, priceTop);
        g.lineTo(hx, volTop + volH);
        g.stroke();
        g.beginPath();
        g.moveTo(padL, hy);
        g.lineTo(padL + plotW, hy);
        g.stroke();
        g.setLineDash([]);

        // 右侧价格轴上的标签：显式一点的颜色区分「鼠标价格」与「K 线收盘价」
        g.fillStyle = onCandle ? (hc[4] >= hc[1] ? up : down) : cssVar('--dsw-alias-brand-primary', '#4a8cff');
        var tagH = 15;
        g.fillRect(padL + plotW + 2, hy - tagH / 2, padR - 6, tagH);
        g.fillStyle = '#ffffff';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(fmtPrice(hoverPrice, digitsOf(hoverPrice)), padL + plotW + 6, hy);

        if (onCandle !== true) {
          // 空白处：只补一行「鼠标价格」，不弹 K 线数据
          var hintText = '鼠标 ' + fmtPrice(hoverPrice, digitsOf(hoverPrice));
          g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
          var hintW = g.measureText(hintText).width + 12;
          var hintX = padL + plotW - hintW - 6;
          var hintY = clampNum(hy - 24, priceTop + 3, priceTop + priceH - 21);
          // 回看历史时左上角有「回看中」角标，别叠上去
          if (view.following === false && hintY < priceTop + 24) {
            hintY = priceTop + 26;
            hintX = Math.min(hintX, padL + Math.max(plotW - hintW - 6, 6));
          }
          g.fillStyle = 'rgba(18,22,27,0.78)';
          g.beginPath();
          if (typeof g.roundRect === 'function') g.roundRect(hintX, hintY, hintW, 18, 5);
          else g.rect(hintX, hintY, hintW, 18);
          g.fill();
          g.fillStyle = '#e8edf3';
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          g.fillText(hintText, hintX + 6, hintY + 9);
        } else {
          var rows = [
            ['时间', fmtTime(hc[0], barMs, true)],
            ['开', fmtPrice(hc[1], digitsOf(hc[4]))],
            ['高', fmtPrice(hc[2], digitsOf(hc[4]))],
            ['低', fmtPrice(hc[3], digitsOf(hc[4]))],
            ['收', fmtPrice(hc[4], digitsOf(hc[4]))],
            ['量', fmtVol(hc[5])],
            ['涨跌', fmtPct(hc[1] === 0 ? 0 : ((hc[4] - hc[1]) / hc[1]) * 100)],
          ];
          if (view.showEma20) rows.push(['EMA' + String(view.emaFastPeriod || 20), fmtPrice(ema20[hover], digitsOf(hc[4]))]);
          if (view.showEma480) rows.push(['EMA' + String(view.emaSlowPeriod || 480), fmtPrice(ema480[hover], digitsOf(hc[4]))]);
          var boxW = 132;
          var boxH = 13 * rows.length + 12;
          var bx = hx + 14;
          if (bx + boxW > padL + plotW) bx = hx - 14 - boxW;
          if (bx < padL) bx = padL + 2;
          var by = Math.max(priceTop + 2, Math.min(hy - boxH / 2, priceTop + priceH - boxH - 2));
          g.fillStyle = 'rgba(18,22,27,0.92)';
          g.strokeStyle = 'rgba(150,160,175,0.35)';
          g.lineWidth = 1;
          g.beginPath();
          if (typeof g.roundRect === 'function') {
            g.roundRect(bx, by, boxW, boxH, 6);
          } else {
            g.rect(bx, by, boxW, boxH);
          }
          g.fill();
          g.stroke();
          g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
          for (i = 0; i < rows.length; i += 1) {
            var ty = by + 12 + i * 13;
            g.fillStyle = 'rgba(160,172,186,0.95)';
            g.textAlign = 'left';
            g.fillText(rows[i][0], bx + 8, ty);
            g.fillStyle = '#f2f5f8';
            g.textAlign = 'right';
            g.fillText(rows[i][1], bx + boxW - 8, ty);
          }
        }
      }

      // 回看历史时的角标：提醒当前右端不是最新一根
      if (view.following === false) {
        g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        var tagText = '回看中';
        var tagW = g.measureText(tagText).width + 14;
        g.fillStyle = 'rgba(74,140,255,0.18)';
        g.beginPath();
        if (typeof g.roundRect === 'function') g.roundRect(padL + 4, priceTop + 2, tagW, 18, 9);
        else g.rect(padL + 4, priceTop + 2, tagW, 18);
        g.fill();
        g.fillStyle = cssVar('--dsw-alias-brand-primary', '#4a8cff');
        g.fillText(tagText, padL + 11, priceTop + 11);
      }
    }

    // ------------------------------------------------------------------ 取数

    function fetchJson(path, options) {
      return fetch(API + path, Object.assign({ cache: 'no-store' }, options || {})).then(function (response) {
        return response.json();
      });
    }

    function useBoard(bar, auto, epoch) {
      var state = React.useState({ status: 'loading', board: null, error: null, at: 0 });
      var setState = state[1];
      React.useEffect(function () {
        var alive = true;
        var timer = null;

        function load(force) {
          fetchJson('/board?bar=' + encodeURIComponent(bar) + '&limit=' + String(FETCH_LIMIT) + (force ? '&force=1' : ''))
            .then(function (res) {
              if (!alive) return;
              if (res !== null && res.ok === true) {
                setState({ status: 'done', board: res, error: null, at: Date.now() });
              } else {
                setState(function (prev) {
                  return { status: 'error', board: prev.board, error: (res && res.error) || '取数失败', at: prev.at };
                });
              }
            })
            .catch(function (err) {
              if (!alive) return;
              setState(function (prev) {
                return { status: 'error', board: prev.board, error: String((err && err.message) || err), at: prev.at };
              });
            });
        }

        setState(function (prev) { return { status: prev.board === null ? 'loading' : 'refreshing', board: prev.board, error: null, at: prev.at }; });
        load(false);
        if (auto) {
          timer = setInterval(function () {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') load(false);
          }, REFRESH_MS);
        }
        return function () {
          alive = false;
          if (timer !== null) clearInterval(timer);
        };
      }, [bar, auto, epoch]);
      return [state[0], function (force) {
        // 手动刷新：直接打一次带 force 的请求（绕过 Host 的 15 秒热缓存）
        fetchJson('/board?bar=' + encodeURIComponent(bar) + '&limit=' + String(FETCH_LIMIT) + '&force=1').then(function (res) {
          if (res !== null && res.ok === true) setState({ status: 'done', board: res, error: null, at: Date.now() });
          else setState(function (prev) { return { status: 'error', board: prev.board, error: (res && res.error) || '取数失败', at: prev.at }; });
        }).catch(function (err) {
          setState(function (prev) { return { status: 'error', board: prev.board, error: String((err && err.message) || err), at: prev.at }; });
        });
      }];
    }

    function usePrice(open) {
      var state = React.useState(null);
      var setState = state[1];
      React.useEffect(function () {
        var alive = true;
        function pull() {
          fetchJson('/price').then(function (res) {
            if (alive && res !== null) setState(res);
          }).catch(function () { /* 单次失败忽略，下一轮再来 */ });
        }
        pull();
        var timer = setInterval(function () {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') pull();
        }, open ? 3000 : REFRESH_MS);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [open]);
      return state[0];
    }

    // ------------------------------------------------------------------ 图表组件

    /**
     * 均线周期输入框。文本留在本地 state 里（否则敲到一半就被 props 改写），
     * 生效值由父组件 parsePeriod 决定；父组件回灌的 value 变了（比如非法输入被夹回来）时再对齐。
     */
    function PeriodEditor(props) {
      var draftState = React.useState(String(props.value));
      var draft = draftState[0];
      var setDraft = draftState[1];
      React.useEffect(function () {
        setDraft(String(props.value));
      }, [props.value]);
      return React.createElement('input', {
        className: 'btcd-period',
        value: draft,
        inputMode: 'numeric',
        spellCheck: false,
        title: props.title,
        'aria-label': props.title,
        onChange: function (event) {
          setDraft(event.target.value);
          props.onCommit(event.target.value);
        },
        onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur(); },
      });
    }

    function Chart(props) {
      var canvasRef = React.useRef(null);
      var dragRef = React.useRef(null);
      var latest = React.useRef(null);
      var viewRef = React.useRef(props.view);
      var onViewRef = React.useRef(props.onView);
      var candlesRef = React.useRef([]);
      var toolRef = React.useRef('none');
      var levelsRef = React.useRef(DEFAULT_FIB_LEVELS);
      var onCommitRef = React.useRef(null);
      var hoverState = React.useState(null);
      var hover = hoverState[0];
      var setHover = hoverState[1];
      var dragState = React.useState(false);
      var dragging = dragState[0];
      var setDragging = dragState[1];
      var previewState = React.useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];

      var candles = Array.isArray(props.candles) ? props.candles : [];
      var view = props.view;
      var tool = props.tool === undefined || props.tool === null ? 'none' : props.tool;
      var win = windowOf(candles, view);
      // 均线：对「整条序列」现算，再切窗口 —— 所以窗口拖到哪儿，均线就画到哪儿（见上面 EMA 那一节）。
      // 每帧最多算一次：emaFor 的结果按 (长度, 周期, fetchedAt) 缓存。
      var slice = emaWindow(candles, win, props.emaFast, props.emaSlow, props.fetchedAt);
      var board = {
        candles: slice.candles,
        ema20: slice.ema20,
        ema480: slice.ema480,
        meta: { barMs: props.barMs },
      };
      var ema20 = board.ema20;
      var ema480 = board.ema480;
      // ResizeObserver 回调与 window 事件里都要读到最新一帧的数据，统一放 ref。
      latest.current = {
        board: board,
        hover: hover,
        showEma20: props.showEma20,
        showEma480: props.showEma480,
        following: view.rightTs === null,
        drawings: props.drawings,
        preview: preview,
        barMs: props.barMs,
        emaFastPeriod: parsePeriod(props.emaFast, DEFAULT_EMA_FAST),
        emaSlowPeriod: parsePeriod(props.emaSlow, DEFAULT_EMA_SLOW),
      };
      viewRef.current = view;
      onViewRef.current = props.onView;
      candlesRef.current = candles;
      toolRef.current = tool;
      levelsRef.current = Array.isArray(props.levels) && props.levels.length > 0 ? props.levels : DEFAULT_FIB_LEVELS;
      onCommitRef.current = props.onCommit;

      React.useEffect(function () {
        var canvas = canvasRef.current;
        if (canvas === null) return;
        function redraw() {
          var l = latest.current;
          var h = l.hover === null || l.hover === undefined ? null : l.hover;
          drawChart(canvas, l.board, {
            hover: h === null ? null : h.index,
            hoverY: h === null ? null : h.y,
            hoverOnCandle: h !== null && h.hit === true,
            showEma20: l.showEma20,
            showEma480: l.showEma480,
            following: l.following,
            drawings: l.drawings,
            preview: l.preview,
            emaFastPeriod: l.emaFastPeriod,
            emaSlowPeriod: l.emaSlowPeriod,
          });
        }
        redraw();
        if (typeof ResizeObserver === 'undefined') return;
        var observer = new ResizeObserver(redraw);
        observer.observe(canvas);
        return function () { observer.disconnect(); };
      }, [win.start, win.end, candles, slice, props.showEma20, props.showEma480, hover, view.rightTs, props.drawings, preview]);

      /** 画布几何（与 drawChart 共用 PAD_* 常量）。 */
      function geometryAt(clientX) {
        var canvas = canvasRef.current;
        if (canvas === null) return null;
        var rect = canvas.getBoundingClientRect();
        var w = windowOf(candlesRef.current, viewRef.current);
        var count = Math.max(1, w.end - w.start);
        var box = plotBox(canvas, count);
        return {
          rect: rect,
          padLeft: PAD_LEFT,
          plotWidth: box.plotW,
          step: box.step,
          count: count,
          window: w,
          fraction: clampNum((clientX - rect.left - PAD_LEFT) / box.plotW, 0, 1),
        };
      }

      /** 指针 → 数据坐标（用当前可见切片，跟画出来的完全一致）。 */
      function dataAt(clientX, clientY) {
        var canvas = canvasRef.current;
        if (canvas === null || latest.current === null) return null;
        var l = latest.current;
        return pointerToData(
          canvas, l.board.candles, l.board.ema20, l.board.ema480,
          l.showEma20, l.showEma480, clientX, clientY, l.barMs,
        );
      }

      React.useEffect(function () {
        var canvas = canvasRef.current;
        if (canvas === null) return;
        // React 的 onWheel 是被动的，preventDefault 无效，所以自己挂一个非被动的
        function onWheel(event) {
          var geo = geometryAt(event.clientX);
          if (geo === null) return;
          event.preventDefault();
          var factor = event.deltaY > 0 ? 1.25 : 0.8;
          var next = Math.round(geo.count * factor);
          onViewRef.current(zoomView(candlesRef.current, viewRef.current, next, geo.fraction));
        }
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return function () { canvas.removeEventListener('wheel', onWheel); };
      }, []);

      function onMouseDown(event) {
        if (event.button !== 0 || candlesRef.current.length === 0) return;
        event.preventDefault();
        var currentTool = toolRef.current;

        if (currentTool !== 'none') {
          // 画线模式：拖动 = 画，不平移
          var start = dataAt(event.clientX, event.clientY);
          if (start === null) return;
          dragRef.current = {
            mode: 'draw',
            kind: currentTool,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            t1: start.ts,
            p1: start.price,
          };
          setHover(null);
          setDragging(true);
          setPreview({ kind: currentTool, t1: start.ts, p1: start.price, t2: start.ts, p2: start.price, levels: levelsRef.current });
        } else {
          var geo = geometryAt(event.clientX);
          if (geo === null) return;
          dragRef.current = { mode: 'pan', startX: event.clientX, startView: viewRef.current, step: geo.step, delta: 0 };
          setHover(null);
          setDragging(true);
        }

        function onWindowMove(moveEvent) {
          var drag = dragRef.current;
          if (drag === null) return;
          if (drag.mode === 'draw') {
            var at = dataAt(moveEvent.clientX, moveEvent.clientY);
            if (at === null) return;
            if (Math.abs(moveEvent.clientX - drag.startX) + Math.abs(moveEvent.clientY - drag.startY) > 4) drag.moved = true;
            setPreview({ kind: drag.kind, t1: drag.t1, p1: drag.p1, t2: at.ts, p2: at.price, levels: levelsRef.current });
            return;
          }
          var dx = moveEvent.clientX - drag.startX;
          var delta = Math.round(dx / Math.max(1, drag.step));
          if (delta === drag.delta) return;
          drag.delta = delta;
          // 用「拖动开始时的视图 + 总位移」算，避免逐帧累加带来的漂移
          onViewRef.current(panView(candlesRef.current, drag.startView, delta));
        }

        function onWindowUp(upEvent) {
          var drag = dragRef.current;
          dragRef.current = null;
          setDragging(false);
          window.removeEventListener('mousemove', onWindowMove);
          window.removeEventListener('mouseup', onWindowUp);
          setPreview(null);
          if (drag === null || drag.mode !== 'draw') return;
          var at = dataAt(upEvent.clientX, upEvent.clientY);
          // 只是点一下（没拖动）不算一条线，免得误触画出一堆点
          if (drag.moved !== true || at === null) return;
          if (typeof onCommitRef.current === 'function') {
            onCommitRef.current({
              kind: drag.kind,
              t1: drag.t1,
              p1: drag.p1,
              t2: at.ts,
              p2: at.price,
              levels: drag.kind === 'fib' ? levelsRef.current.slice() : undefined,
            });
          }
        }

        window.addEventListener('mousemove', onWindowMove);
        window.addEventListener('mouseup', onWindowUp);
      }

      /**
       * 悬浮：算出指针在第几列、y 落在价格区的哪个位置、以及是不是真的压在 K 线上。
       * 只有压上了才弹数据框；画布空白处只画光标 + 鼠标价格。
       */
      function hoverAt(event) {
        var canvas = canvasRef.current;
        if (canvas === null) return null;
        var w = windowOf(candlesRef.current, viewRef.current);
        var count = Math.max(1, w.end - w.start);
        var box = plotBox(canvas, count);
        var rect = canvas.getBoundingClientRect();
        var localX = event.clientX - rect.left;
        var localY = event.clientY - rect.top;
        var index = clampInt(Math.floor((localX - PAD_LEFT) / box.step), 0, count - 1);
        var slice = latest.current === null ? { candles: [], ema20: [], ema480: [] } : latest.current.board;
        var range = priceRange(slice.candles, slice.ema20, slice.ema480, true, true);
        return {
          index: index,
          y: clampNum(localY, box.priceTop, box.priceTop + box.priceH),
          hit: hitCandle(box, range, slice.candles, index, localX, localY),
        };
      }

      function onMove(event) {
        if (dragRef.current !== null) return;
        var at = hoverAt(event);
        if (at === null) return;
        if (hover === null || hover.index !== at.index || hover.y !== at.y || hover.hit !== at.hit) {
          setHover({ index: at.index, y: at.y, hit: at.hit });
        }
      }

      return React.createElement('canvas', {
        ref: canvasRef,
        className: 'btcd-canvas' + (dragging ? ' btcd-grabbing' : '') + (tool !== 'none' ? ' btcd-drawmode' : ''),
        onMouseDown: onMouseDown,
        onMouseMove: onMove,
        onMouseLeave: function () { setHover(null); },
        onDoubleClick: function () { onViewRef.current({ size: viewRef.current.size, rightTs: null }); },
      });
    }

    // ------------------------------------------------------------------ 看板面板

    function Dashboard(props) {
      var close = props.close;
      var barState = React.useState(null);
      var bar = barState[0];
      var setBar = barState[1];
      var autoState = React.useState(true);
      var auto = autoState[0];
      var setAuto = autoState[1];
      var emaState = React.useState([true, true]);
      var showEma20 = emaState[0][0];
      var showEma480 = emaState[0][1];
      var setEma = emaState[1];
      var epochState = React.useState(0);
      var setEpoch = epochState[1];
      var viewState = React.useState({ size: 180, rightTs: null });
      var view = viewState[0];
      var setView = viewState[1];
      var toolState = React.useState('none');
      var tool = toolState[0];
      var setTool = toolState[1];
      var levelsState = React.useState(DEFAULT_FIB_LEVELS.join(','));
      var levelsText = levelsState[0];
      var setLevelsText = levelsState[1];
      // 均线周期（文本 + 生效值）：输入框每敲一下都重算，所以「动态更新」是即时的
      var periodState = React.useState([String(DEFAULT_EMA_FAST), String(DEFAULT_EMA_SLOW)]);
      var periodText = periodState[0];
      var setPeriodText = periodState[1];
      var emaFast = parsePeriod(periodText[0], DEFAULT_EMA_FAST);
      var emaSlow = parsePeriod(periodText[1], DEFAULT_EMA_SLOW);
      var drawState = React.useState([]);
      var drawings = drawState[0];
      var setDrawings = drawState[1];
      var savedRef = React.useRef(null);
      var envState = React.useState(null); // 正在切换的目标环境
      var switching = envState[0];
      var setSwitching = envState[1];
      var errState = React.useState(null);
      var actionError = errState[0];
      var setActionError = errState[1];
      var boardCall = useBoard(bar === null ? '15m' : bar, auto, epochState[0]);
      var data = boardCall[0];
      var refresh = boardCall[1];
      var price = usePrice(true);

      // Host 记住的周期：第一次拿到载荷时对齐一次，之后以用户点击为准。
      React.useEffect(function () {
        if (bar === null && data.board !== null && data.board.bar) setBar(data.board.bar);
      }, [data.board, bar]);

      React.useEffect(function () {
        function onKey(event) {
          if (event.key === 'Escape' && tool !== 'none') {
            // 画线模式下 Esc 先退回「无」，再按才关面板
            setTool('none');
            return;
          }
          if (event.key === 'Escape') close();
        }
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, [close, tool]);

      // 画线的持久化：按「合约 + 周期」分开存（时间轴口径不同，混在一起没意义），
      // 存在浏览器 localStorage 里，不写宿主磁盘。
      var drawStoreKey = 'dsh-btc-dashboard:drawings:'
        + (data.board === null || data.board === undefined ? 'BTC-USDT-SWAP' : data.board.instId) + ':'
        + (bar === null ? '15m' : bar);

      React.useEffect(function () {
        var stored = loadStored(drawStoreKey, []);
        setDrawings(Array.isArray(stored) ? stored : []);
        savedRef.current = JSON.stringify(Array.isArray(stored) ? stored : []);
      }, [drawStoreKey]);

      React.useEffect(function () {
        var text = JSON.stringify(drawings);
        // 刚载入/刚切周期时内容与已存一致，别把还没加载完的空数组写回去
        if (savedRef.current === text) return;
        savedRef.current = text;
        saveStored(drawStoreKey, drawings);
      }, [drawStoreKey, drawings]);

      function addDrawing(shape) {
        setDrawings(function (prev) { return prev.concat([shape]); });
      }

      function undoDrawing() {
        setDrawings(function (prev) { return prev.slice(0, Math.max(0, prev.length - 1)); });
      }

      function clearDrawings() {
        setDrawings([]);
      }

      function switchEnv(id) {
        if (switching !== null) return;
        setSwitching(id);
        setActionError(null);
        fetchJson('/env', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ env: id }),
        }).then(function (res) {
          if (res === null || res.ok !== true) throw new Error((res && res.error) || '切换失败');
          setEpoch(function (n) { return n + 1; });
        }).catch(function (error) {
          setActionError(String((error && error.message) || error));
        }).then(function () {
          setSwitching(null);
        });
      }

      var board = data.board;
      // 注意：这个变量不能叫 view —— 上面 view 已经是时间轴窗口，同函数作用域的 var 会互相覆盖
      var quote = price !== null && price.price !== null ? price.price : (board === null ? null : board.price);
      var env = board !== null && board.env ? board.env : (price !== null && price.env ? price.env : null);
      var last = quote === null ? null : quote.last;
      var changePct = quote === null ? null : quote.changePct;
      var up = changePct === null ? true : changePct >= 0;
      var barList = board !== null && Array.isArray(board.bars) ? board.bars : [
        { id: '1m', label: '1m' }, { id: '3m', label: '3m' }, { id: '15m', label: '15m' },
        { id: '1h', label: '1h' }, { id: '4h', label: '4h' }, { id: '1D', label: '1D' },
      ];
      var stats = board === null ? null : board.stats;
      var warnings = board === null || board.meta === undefined || board.meta === null ? [] : (board.meta.warnings || []);
      var fullCandles = board === null ? [] : (board.candles || []);
      // 均线在这里算一次（整条序列），图例数字、价距均线、图上的曲线都取自它，口径一致。
      // 序列一变（每 5 秒刷新/切周期）或周期一改，就重算 —— 这就是「动态更新」。
      var emaNow = emaFor(fullCandles, emaFast, emaSlow, board === null ? 0 : board.fetchedAt);
      var lastFast = emaNow.emaFast.length === 0 ? null : emaNow.emaFast[emaNow.emaFast.length - 1];
      var lastSlow = emaNow.emaSlow.length === 0 ? null : emaNow.emaSlow[emaNow.emaSlow.length - 1];
      var lastClose = fullCandles.length === 0 ? null : fullCandles[fullCandles.length - 1][4];
      var vsFast = lastClose === null || lastFast === null || lastFast === 0
        ? null : Number((((lastClose - lastFast) / lastFast) * 100).toFixed(3));
      var vsSlow = lastClose === null || lastSlow === null || lastSlow === 0
        ? null : Number((((lastClose - lastSlow) / lastSlow) * 100).toFixed(3));

      var children = [];

      // 标题行
      var headKids = [
        React.createElement('span', { className: 'btcd-title', key: 'title' }, 'OKX BTC 合约看板'),
        React.createElement('span', { className: 'btcd-chip', key: 'inst' }, board === null ? 'BTC-USDT-SWAP' : board.instId),
        env === null ? null : React.createElement('span', {
          className: 'btcd-chip' + (env.simulated ? ' btcd-demo' : ''),
          key: 'env-chip',
          title: env.note + '（密钥 ' + (env.keyMasked || '未配置') + '）',
        }, (env.simulated ? '模拟环境' : '生产环境') + ' · ' + (env.keyMasked || '无密钥')),
        React.createElement('div', { className: 'btcd-seg', key: 'seg' },
          React.createElement('button', {
            className: env !== null && env.id === 'demo' ? 'on' : '',
            disabled: switching !== null,
            onClick: function () { switchEnv('demo'); },
            title: '切到模拟环境（DEBUG_OKX_API_KEY + x-simulated-trading: 1）',
          }, switching === 'demo' ? '切…' : '模拟'),
          React.createElement('button', {
            className: env !== null && env.id === 'prod' ? 'on' : '',
            disabled: switching !== null,
            onClick: function () { switchEnv('prod'); },
            title: '切到生产环境（PROD_OKX_API_KEY，不带模拟头）',
          }, switching === 'prod' ? '切…' : '生产')),
        React.createElement('div', { className: 'btcd-spacer', key: 'sp' }),
        React.createElement('button', {
          className: 'btcd-mini', key: 'refresh', onClick: function () { refresh(true); },
          title: '立即刷新（绕过 15 秒热缓存）',
        }, '刷新'),
        React.createElement('button', {
          className: 'btcd-mini' + (auto ? ' on' : ''), key: 'auto',
          onClick: function () { setAuto(!auto); },
          title: auto ? '自动刷新已开（5 秒）' : '自动刷新已关',
        }, auto ? '自动 5s' : '手动'),
        React.createElement('button', { className: 'btcd-x', key: 'close', onClick: close, title: '关闭（Esc）' }, '✕'),
      ];
      children.push(React.createElement('div', { className: 'btcd-head', key: 'head' }, headKids));

      // 价格行
      var priceKids = [
        React.createElement('span', {
          className: 'btcd-last ' + (up ? 'btcd-up' : 'btcd-down'), key: 'last',
        }, fmtPrice(last)),
        React.createElement('span', {
          className: 'btcd-chg ' + (up ? 'btcd-up' : 'btcd-down'), key: 'chg',
        }, fmtSigned(quote === null ? null : quote.change24h, 1) + '  ' + fmtPct(changePct)),
        React.createElement('div', { className: 'btcd-kv', key: 'kv' },
          React.createElement('span', null, '买 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.bid))),
          React.createElement('span', null, '卖 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.ask))),
          React.createElement('span', null, '24h高 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.high24h))),
          React.createElement('span', null, '24h低 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.low24h))),
          React.createElement('span', null, '24h量 ', React.createElement('b', null, fmtVol(quote === null ? null : quote.vol24h))),
          React.createElement('span', null, '更新 ', React.createElement('b', null, fmtTime(data.at, 0, true))),
          React.createElement('span', null, 'EMA ',
            React.createElement('b', null, String(emaFast) + ': ' + fmtPrice(lastFast) + ' / ' + String(emaSlow) + ': ' + fmtPrice(lastSlow))),
          React.createElement('span', null,
            '价距EMA' + String(emaFast) + ' ',
            React.createElement('b', { className: vsFast === null || vsFast < 0 ? 'btcd-down' : 'btcd-up' }, fmtPct(vsFast)),
            ' 距EMA' + String(emaSlow) + ' ',
            React.createElement('b', { className: vsSlow === null || vsSlow < 0 ? 'btcd-down' : 'btcd-up' }, fmtPct(vsSlow))),
          React.createElement('span', { className: 'btcd-center-tag' },
            data.status === 'refreshing' ? '刷新中…' : '')),
      ];
      children.push(React.createElement('div', { className: 'btcd-price-row', key: 'price' }, priceKids));

      // 周期 + 窗口根数
      var tabKids = [];
      for (var i = 0; i < barList.length; i += 1) {
        tabKids.push(React.createElement('button', {
          key: barList[i].id,
          className: 'btcd-tab' + ((bar === null ? '15m' : bar) === barList[i].id ? ' on' : ''),
          // 换周期要回到「跟随最新」：不同周期的时间戳完全不同，旧锚点没有意义
          onClick: function (id) { return function () { setBar(id); setView({ size: view.size, rightTs: null }); }; }(barList[i].id),
        }, barList[i].label));
      }
      var rangeKids = [React.createElement('span', { key: 'lbl', style: { fontSize: '11px' } }, '窗口')];
      for (var r = 0; r < RANGES.length; r += 1) {
        rangeKids.push(React.createElement('button', {
          key: 'r' + RANGES[r],
          className: 'btcd-mini' + (Math.round(view.size) === RANGES[r] ? ' on' : ''),
          title: '可视 ' + String(RANGES[r]) + ' 根（拖动平移 / 滚轮缩放）',
          onClick: function (n) { return function () { setView({ size: n, rightTs: view.rightTs }); }; }(RANGES[r]),
        }, String(RANGES[r])));
      }
      children.push(React.createElement('div', { className: 'btcd-bar', key: 'bar' },
        React.createElement('div', { className: 'btcd-tabs' }, tabKids),
        React.createElement('div', { className: 'btcd-spacer' }),
        React.createElement('div', { className: 'btcd-tabs' }, rangeKids)));

      // 均线周期（改一下立刻重算重画，也能让窗口外的历史段有均线）
      var emaKids = [
        React.createElement('span', { key: 'lbl', style: { fontSize: '11px' } }, '均线周期'),
        React.createElement(PeriodEditor, {
          key: 'fast', value: emaFast, title: '快线周期（默认 20，2–' + String(EMA_PERIOD_MAX) + '）',
          onCommit: function (text) { setPeriodText([text, periodText[1]]); },
        }),
        React.createElement('span', { key: 'sep', style: { fontSize: '11px' } }, '/'),
        React.createElement(PeriodEditor, {
          key: 'slow', value: emaSlow, title: '慢线周期（默认 480，2–' + String(EMA_PERIOD_MAX) + '）',
          onCommit: function (text) { setPeriodText([periodText[0], text]); },
        }),
        React.createElement('span', { key: 'hint', className: 'btcd-hint', style: { fontSize: '11px' } },
          '在浏览器里按整条序列（已取 ' + String(fullCandles.length) + ' 根）计算，拖动/缩放/改周期即时重算'),
      ];
      children.push(React.createElement('div', { className: 'btcd-bar', key: 'emabar' }, emaKids));

      // 画线工具条
      var toolKids = [React.createElement('span', { key: 'lbl', style: { fontSize: '11px' } }, '画线')];
      var TOOLS = [
        ['none', '无', '平移 / 缩放模式（拖动=平移，滚轮=缩放）'],
        ['line', '直线', '在图上按住拖动，画一条直线（记录两个价位）'],
        ['fib', '斐波那契', '在图上按住拖动：起点→终点决定区间，默认画 0 / 0.5 / 1 / 1.5 / 2'],
      ];
      for (var t = 0; t < TOOLS.length; t += 1) {
        toolKids.push(React.createElement('button', {
          key: TOOLS[t][0],
          className: 'btcd-mini' + (tool === TOOLS[t][0] ? ' on' : ''),
          title: TOOLS[t][2],
          onClick: function (id) { return function () { setTool(id); }; }(TOOLS[t][0]),
        }, TOOLS[t][1]));
      }
      if (tool === 'fib') {
        toolKids.push(React.createElement('input', {
          key: 'levels',
          className: 'btcd-levels',
          value: levelsText,
          spellCheck: false,
          title: '斐波那契比例，逗号分隔（改完立刻生效）',
          onChange: function (event) { setLevelsText(event.target.value); },
          onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur(); },
        }));
      }
      toolKids.push(React.createElement('button', {
        key: 'undo', className: 'btcd-mini', title: '撤销最后一条', disabled: drawings.length === 0,
        onClick: undoDrawing,
      }, '撤销'));
      toolKids.push(React.createElement('button', {
        key: 'clear', className: 'btcd-mini', title: '清空当前周期的所有画线', disabled: drawings.length === 0,
        onClick: clearDrawings,
      }, '清空'));
      toolKids.push(React.createElement('span', { key: 'count', style: { fontSize: '11px' } },
        drawings.length === 0 ? '当前周期没有画线' : '已画 ' + String(drawings.length) + ' 条'));
      children.push(React.createElement('div', { className: 'btcd-bar', key: 'drawbar' }, toolKids));

      // 图表：拖动平移、滚轮缩放、双击回最新
      var viewWindow = windowOf(fullCandles, view);
      var visible = viewWindow.end - viewWindow.start;
      var chartWrapKids = [React.createElement(Chart, {
        key: 'chart',
        candles: fullCandles,
        // 均线不再取 Host 发来的数组（那只有展示窗口那一段），Chart 内部按周期现算
        emaFast: emaFast,
        emaSlow: emaSlow,
        fetchedAt: board === null ? 0 : board.fetchedAt,
        barMs: board === null || board.meta === undefined || board.meta === null ? 0 : board.meta.barMs,
        view: view,
        onView: setView,
        showEma20: showEma20,
        showEma480: showEma480,
        tool: tool,
        levels: parseFibLevels(levelsText),
        drawings: drawings,
        onCommit: addDrawing,
      })];
      if (board === null) {
        chartWrapKids.push(React.createElement('div', { className: 'btcd-center', key: 'msg' },
          data.status === 'error' ? ('⚠️ ' + (data.error || '取数失败')) : '正在从 OKX 取数…（首次会向前翻页补足均线预热需要的 K 线）'));
      } else if (data.status === 'error' && data.error) {
        chartWrapKids.push(React.createElement('div', { className: 'btcd-center', key: 'msg', style: { alignItems: 'flex-end', paddingBottom: '8px' } },
          React.createElement('span', { className: 'btcd-err' }, '⚠️ 刷新失败：' + data.error)));
      }
      if (board !== null && view.rightTs !== null) {
        chartWrapKids.push(React.createElement('button', {
          key: 'back-live',
          className: 'btcd-backlive',
          onClick: function () { setView({ size: view.size, rightTs: null }); },
          title: '回到最新（也可以双击图表，或一直往右拖到底）',
        }, '回看历史中 · 回最新 →'));
      }
      children.push(React.createElement('div', { className: 'btcd-chart-wrap', key: 'chart-wrap' }, chartWrapKids));

      // 图例（数字与曲线同源：都是上面按当前周期现算的那条序列）
      children.push(React.createElement('div', { className: 'btcd-legend', key: 'legend' },
        React.createElement('button', {
          className: showEma20 ? '' : 'off',
          onClick: function () { setEma([!showEma20, showEma480]); },
          title: '显示/隐藏 EMA' + String(emaFast),
        }, React.createElement('span', { className: 'btcd-dot', style: { background: C_EMA20 } }), 'EMA' + String(emaFast) + ' ', fmtPrice(lastFast)),
        React.createElement('button', {
          className: showEma480 ? '' : 'off',
          onClick: function () { setEma([showEma20, !showEma480]); },
          title: '显示/隐藏 EMA' + String(emaSlow),
        }, React.createElement('span', { className: 'btcd-dot', style: { background: C_EMA480 } }), 'EMA' + String(emaSlow) + ' ', fmtPrice(lastSlow)),
        React.createElement('span', { className: 'btcd-spacer' }),
        stats === null ? null : React.createElement('span', null, '可视 ' + String(visible) + ' / 已取 ' + String(fullCandles.length) + ' 根 · 序列 ' + String(stats.seriesCount) + ' 根'),
        board === null || fullCandles.length === 0 ? null : React.createElement('span', null,
          fmtTime(fullCandles[viewWindow.start][0], 0, true) + ' → ' + fmtTime(fullCandles[viewWindow.end - 1][0], 0, true)),
        React.createElement('span', { className: 'btcd-hint' },
          tool === 'none'
            ? '拖动平移 · 滚轮缩放 · 双击回最新'
            : (tool === 'fib'
              ? '在图上按住拖动生成斐波那契（比例可改，默认 0/0.5/1/1.5/2）· Esc 退出画线'
              : '在图上按住拖动画直线 · Esc 退出画线'))));

      // 页脚：数据通道 + 告警
      var footKids = [
        React.createElement('span', { key: 'src' }, '数据源 OKX ' + (board === null ? 'BTC-USDT-SWAP' : board.instId) + ' · 公开行情接口（无需签名）'),
        React.createElement('span', { key: 'trans' }, '通道 ' + String(board === null ? '—' : (board.transport || '—')) + (board === null || board.proxy === null ? '（直连）' : '（' + board.proxy + '）')),
        React.createElement('span', { key: 'lat' }, '耗时 ' + String(board === null || board.latencyMs === undefined ? '—' : board.latencyMs + 'ms')),
        board === null ? null : React.createElement('span', { key: 'cache' }, board.meta && board.meta.cached ? '热缓存命中' : '翻页 ' + String(board.meta ? board.meta.pages : 0) + ' 页'),
        React.createElement('span', { key: 'upd' }, data.at === 0 ? '' : agoText(Date.now() - data.at) + '更新'),
      ];
      for (var w = 0; w < warnings.length; w += 1) {
        footKids.push(React.createElement('span', { className: 'btcd-warn', key: 'w' + w }, '⚠ ' + warnings[w]));
      }
      if (actionError !== null) footKids.push(React.createElement('span', { className: 'btcd-err', key: 'ae' }, '⚠ ' + actionError));
      children.push(React.createElement('div', { className: 'btcd-foot', key: 'foot' }, footKids));

      return React.createElement('div', {
        className: 'btcd-overlay',
        onMouseDown: function (event) { if (event.target === event.currentTarget) close(); },
      }, React.createElement('div', {
        className: 'btcd-panel',
        role: 'dialog',
        'aria-label': 'OKX BTC 合约价格看板',
      }, children));
    }

    // ------------------------------------------------------------------ 侧边栏入口

    function SidebarButton(props) {
      var price = usePrice(false);
      var summary = price === null || price.price === null ? null : price.price;
      var up = summary === null || summary.changePct === null ? true : summary.changePct >= 0;
      var text = summary === null
        ? '📊 BTC'
        : '📊 ' + Math.round(summary.last).toLocaleString('en-US') + ' ' + (up ? '▲' : '▼') + Math.abs(summary.changePct).toFixed(2) + '%';
      return React.createElement('button', {
        type: 'button',
        className: 'btcd-ico',
        title: 'BTC 合约 K 线看板（OKX）：最新价 + 1m/3m/15m/1h/4h/1D + EMA20/EMA480',
        onClick: props.toggle,
      }, React.createElement('span', { className: up ? 'btcd-up' : 'btcd-down' },
        (props.wide === true ? text : '📊')));
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      injectCss();
      var store = { open: false, listeners: new Set() };
      store.setOpen = function (value) {
        store.open = value;
        store.listeners.forEach(function (fn) { fn(); });
      };
      store.toggle = function () { store.setOpen(!store.open); };
      store.subscribe = function (fn) {
        store.listeners.add(fn);
        return function () { store.listeners.delete(fn); };
      };

      function useOpen() {
        var state = React.useState(store.open);
        React.useEffect(function () {
          return store.subscribe(function () { state[1](store.open); });
        }, []);
        return state[0];
      }

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'btc-dashboard', order: 40, label: 'BTC 合约看板' },
            function (props) {
              return React.createElement(SidebarButton, { wide: props && props.wide === true, toggle: store.toggle });
            });
        });
      }, 'dsh-btc-dashboard: footer action');

      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'btc-dashboard', order: 70, label: 'BTC 合约价格看板' },
            function () {
              var open = useOpen();
              if (!open) return null;
              return React.createElement(Dashboard, { close: function () { store.setOpen(false); } });
            });
        });
      }, 'dsh-btc-dashboard: overlay');
    }

    return {
      inject: ['slots'],
      apply: apply,
      // 只给离线自检用：DSH 的模块表只读 apply / inject，多余的键会被忽略。
      debug: {
        drawChart: drawChart,
        Chart: Chart,
        Dashboard: Dashboard,
        SidebarButton: SidebarButton,
        windowOf: windowOf,
        panView: panView,
        zoomView: zoomView,
        indexAfter: indexAfter,
        indexFrac: indexFrac,
        tsAtIndex: tsAtIndex,
        fibPrice: fibPrice,
        parseFibLevels: parseFibLevels,
        pointerToData: pointerToData,
        plotBox: plotBox,
        priceRange: priceRange,
        hitCandle: hitCandle,
        CANDLE_HIT_PX: CANDLE_HIT_PX,
        fmtPrice: fmtPrice,
        fmtPct: fmtPct,
        fmtVol: fmtVol,
        fmtTime: fmtTime,
        emaSeries: emaSeries,
        emaFor: emaFor,
        emaWindow: emaWindow,
        closesOf: closesOf,
        parsePeriod: parsePeriod,
        DEFAULT_EMA_FAST: DEFAULT_EMA_FAST,
        DEFAULT_EMA_SLOW: DEFAULT_EMA_SLOW,
      },
    };
  },
});
