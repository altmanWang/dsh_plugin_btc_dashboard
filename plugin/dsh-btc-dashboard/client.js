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
    // 打开时的默认可视根数；双击图区也回到这个值
    var DEFAULT_WINDOW = 180;
    // Host 没回 bars 时的周期兜底（也和数字键 1..6 一一对应）
    var BAR_IDS = ['1m', '3m', '15m', '1h', '4h', '1D'];

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
      // 数据陈旧的角标：不用错误红（画面还在正常工作），但必须显眼到"不能拿这个价当实时价"
      '.btcd-stale{background:rgba(224,168,0,.18);color:#e0a800}',
      '.btcd-last.btcd-stale,.btcd-chg.btcd-stale{color:var(--dsw-alias-state-warn-primary,#e0a800)}',
      '.btcd-countdown b{font-weight:600;font-variant-numeric:tabular-nums}',
      '.btcd-lbl{font-size:11px}',
      // 工具按钮：图标 + 文字，选中态用品牌色描边而不是整块填色（一行放得下更多）
      '.btcd-tool{display:inline-flex;align-items:center;gap:4px;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary,#98a2ad);border-radius:6px;padding:3px 8px;font-size:11.5px;cursor:pointer}',
      '.btcd-tool:hover{background:var(--dsw-alias-bg-layer-2,#2b333b);color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.btcd-tool.on{background:var(--dsw-alias-bg-layer-2,#2b333b);border-color:var(--dsw-alias-brand-primary,#4a8cff);color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.btcd-tool:disabled{opacity:.45;cursor:default}',
      '.btcd-tool:focus-visible,.btcd-icon-btn:focus-visible,.btcd-mini:focus-visible,.btcd-tab:focus-visible,.btcd-x:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a8cff);outline-offset:1px}',
      '.btcd-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:transparent;border:1px solid var(--dsw-alias-border-l2,#4a535c);color:var(--dsw-alias-label-secondary,#98a2ad);border-radius:6px;cursor:pointer}',
      '.btcd-icon-btn:hover{color:var(--dsw-alias-label-primary,#e8e8e8);border-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-icon-btn.on{color:var(--dsw-alias-brand-primary,#4a8cff);border-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-spin{width:11px;height:11px;border:2px solid var(--dsw-alias-border-l2,#4a535c);border-top-color:var(--dsw-alias-brand-primary,#4a8cff);border-radius:50%;animation:btcd-rot .7s linear infinite}',
      '@keyframes btcd-rot{to{transform:rotate(360deg)}}',
      '.btcd-sel{background:rgba(74,140,255,.16);color:#4a8cff}',
      '.btcd-toast{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay,#2b333b);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l2,#4a535c);border-radius:8px;padding:6px 14px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:3}',
      // 窄屏：工具条不换行，改成横向滚动 —— 省下的每一行都是图表的高度
      '.btcd-bar{overflow-x:auto;scrollbar-width:thin}',
      '.btcd-bar::-webkit-scrollbar{height:4px}',
      '.btcd-bar::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#4a535c);border-radius:2px}',
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

    /**
     * 每秒（或每 N 毫秒）返回一次「现在的时刻」。
     * 「x 秒前更新」「距收盘 mm:ss」这类读数必须自己走 —— 否则只能等 5 秒的轮询来推动，
     * 看起来就是"卡住了然后跳一下"。
     */
    function useTick(ms) {
      var state = React.useState(function () { return Date.now(); });
      React.useEffect(function () {
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          state[1](Date.now());
        }, ms);
        return function () { clearInterval(timer); };
      }, [ms]);
      return state[0];
    }

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

    /**
     * 把 view 里的 `rightTs: null`（跟随最新）解析成一个**具体的**时间戳，并给出窗口。
     *
     * 为什么不让 null 一路传下去：绘制、命中、键盘都要回答"现在看的是哪一段"，
     * 每处各判一次 null 迟早会分叉（比如绘制用窗口、命中用全量）。
     * 这里解析一次（`rightTs` 始终等于窗口最后一根的时间戳，因此窗口左闭右开、内容确定），
     * 视图状态本身仍然是 null —— 刷新后自动跟着新 K 线走的行为不变。
     */
    function viewWindow(candles, view) {
      var w = windowOf(candles, view);
      var following = view.rightTs === null || view.rightTs === undefined;
      if (w.end <= 0) return { view: { size: view.size, rightTs: null }, window: w, following: following };
      var rightTs = candles[w.end - 1][0];
      return { view: { size: w.end - w.start, rightTs: rightTs }, window: w, following: following };
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
    // 画线命中的容差（比 K 线松一点：线细、端点小，用鼠标点它本来就是精细操作）
    var DRAW_HIT_PX = 5;
    // 按住 K 线轴拖动 = 缩放，按住时间轴拖动 = 缩放；超过这个像素才算拖动，免得双击被当成拖
    var AXIS_DRAG_PX = 3;

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
     * K 线命中容差（像素）。
     *
     * 基础 3px：实体只有几像素宽，没有这点余量几乎点不中。
     * 上限 `step/2`：缩到"一根 0.6px 宽"时，横向余量不该宽到把隔壁几根也吃进来 ——
     * 纵向不受这个限制（细长影线本来就要在竖直方向上宽松一点）。
     */
    function hitTolerance(step) {
      var halfStep = Number(step) / 2;
      if (!isFinite(halfStep) || halfStep <= 0) return CANDLE_HIT_PX;
      return Math.max(1, Math.min(CANDLE_HIT_PX, halfStep));
    }

    /** 画线/尺子端点的吸附容差（像素）：在这个距离内吸到最近的 OHLC。 */
    var SNAP_PX = 8;

    /** 某个价格等于这根 K 线的哪个价（用来自吸附时提示"吸到了什么"）。 */
    function ohlcLabelOf(row, price) {
      if (!Array.isArray(row)) return '吸附';
      var names = ['', '开', '高', '低', '收'];
      for (var k = 1; k <= 4; k += 1) if (Number(row[k]) === Number(price)) return names[k];
      return '吸附';
    }

    /**
     * 尺子量出来的东西：价格差、涨跌比例、时长、根数。
     * 纯函数，好离线断言；`barMs` 为 0 时不给时长/根数（拿不到周期就别瞎算）。
     */
    function measureStats(shape, barMs) {
      var p1 = Number(shape === null || shape === undefined ? NaN : shape.p1);
      var p2 = Number(shape === null || shape === undefined ? NaN : shape.p2);
      var t1 = Number(shape === null || shape === undefined ? NaN : shape.t1);
      var t2 = Number(shape === null || shape === undefined ? NaN : shape.t2);
      if (!isFinite(p1) || !isFinite(p2)) return null;
      var rise = p2 - p1;
      var ms = Number(barMs) > 0 ? Number(barMs) : 0;
      var bars = isFinite(t1) && isFinite(t2) && ms > 0
        ? Math.max(1, Math.round(Math.abs(t2 - t1) / ms) + 1) : null;
      return {
        p1: p1,
        p2: p2,
        rise: rise,
        pct: p1 === 0 ? null : (rise / p1) * 100,
        up: rise >= 0,
        bars: bars,
        // 从起点那根的开盘算到终点那根的开盘 + 一个周期
        ms: isFinite(t1) && isFinite(t2) && ms > 0 ? Math.abs(t2 - t1) + ms : null,
      };
    }

    /**
     * 把鼠标位置吸附到最近的 OHLC（鼠标所在那根 + 左右各一根）里。
     *
     * 为什么不是只吸当前这根：直接吸到"当前这根的开盘/最高/最低/收盘"会四种价位互相跳，
     * 手一抖就跳一格；把邻根也算进来、再按屏幕距离取最近的那个（且要在容差内），
     * 才既吸得准又不乱跳。
     * 返回 null 表示附近没有可吸的价位（那就用鼠标的原始价格）。
     */
    function snapPriceToOhlc(candles, index, price, yOf, limitPx) {
      if (!Array.isArray(candles) || candles.length === 0 || typeof yOf !== 'function') return null;
      if (!isFinite(Number(price))) return null;
      var targetY = yOf(Number(price));
      var limit = Number(limitPx) > 0 ? Number(limitPx) : SNAP_PX;
      var best = null;
      var bestDist = Infinity;
      var at = clampInt(index, 0, candles.length - 1);
      for (var i = Math.max(0, at - 1); i <= Math.min(candles.length - 1, at + 1); i += 1) {
        var row = candles[i];
        if (!Array.isArray(row)) continue;
        for (var k = 1; k <= 4; k += 1) {
          var value = Number(row[k]);
          if (!isFinite(value)) continue;
          var dist = Math.abs(yOf(value) - targetY);
          if (dist < bestDist) { bestDist = dist; best = value; }
        }
      }
      if (best === null || bestDist > limit) return null;
      return best;
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
      var tol = hitTolerance(box.step);

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
    // ------------------------------------------------------------------ 时间刻度 / 收盘倒计时 / 画线命中（纯函数）

    /** 把一个毫秒数说成人话：88:00 / 42:10 / 3h05m。 */
    function fmtDur(ms) {
      var total = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
      var h = Math.floor(total / 3600);
      var m = Math.floor((total % 3600) / 60);
      var s = total % 60;
      if (h > 0) return String(h) + 'h' + pad2(m) + 'm';
      return pad2(m) + ':' + pad2(s);
    }

    /** 「x 前」：刚刷过的显示"刚刚" —— 一直挂着"00:00前"反而像坏了。 */
    function fmtAgo(ms) {
      var d = Math.max(0, Number(ms) || 0);
      if (d < 1500) return '刚刚';
      return fmtDur(d) + '前';
    }

    /**
     * 下一根 K 线的收盘倒计时（毫秒）。
     * 以**最后一根的开盘时间**为基准算：本根 0 秒时正好显示完整周期，然后递减到 0。
     * 时间没对上（时钟偏、barMs 缺失）时返回 null，宁可什么都不显示也不显示错的秒数。
     */
    function closeCountdown(lastTs, barMs, now) {
      var ms = Number(barMs);
      var open = Number(lastTs);
      var at = Number(now);
      if (!(ms > 0) || !isFinite(open) || !isFinite(at)) return null;
      var left = open + ms - at;
      if (left <= 0) return null;
      return left > ms * 4 ? null : left; // 差得太多说明假设不成立
    }

    /** 倒计时的显示文案（图表右上角那个小胶囊）。 */
    function fmtCountdown(ms) {
      return '收 ' + fmtDur(ms);
    }

    /** 刻度步长的候选：1s → 5s → … → 30 天。 */
    var TICK_STEPS = [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 900000,
      1800000, 3600000, 7200000, 14400000, 21600000, 43200000, 86400000, 172800000,
      604800000, 2592000000];

    /**
     * 挑刻度步长：先取第一个「能把窗口切成至少 want 段」的候选，
     * 再按 2 的整数倍一步算到位（倍率直接由需要的段数推出来，不用循环翻倍 ——
     * 循环翻倍在"窗口有几万段"时会把步长打飞，导致一条刻度都排不出来）。
     */
    function tickStepHours(span, want, need) {
      var step = TICK_STEPS[TICK_STEPS.length - 1];
      for (var i = 0; i < TICK_STEPS.length; i += 1) {
        if (TICK_STEPS[i] * want >= span) { step = TICK_STEPS[i]; break; }
      }
      var target = span / want; // 理想步长
      if (step < target) {
        var factor = Math.pow(2, Math.ceil(Math.log2(target / step)));
        if (isFinite(factor) && factor > 1) step = step * factor;
      }
      // 段数太少（窗口极窄、或上面倍数算得不够）时再翻一倍
      if (span / step < need) step = step * Math.pow(2, Math.ceil(Math.log2(need / (span / step))));
      return step;
    }

    /**
     * 时间刻度取「整点」（1m/3m/5m/…、整小时、整 6 小时、整天），而不是把窗口等分。
     * 等分排出来的刻度是"每 37 分钟一条"这种读不出信息的位置（旧实现就是这样），
     * 对齐之后刻度与自然时间边界重合，才看得出"这是几点/哪一天"。
     * 返回时间戳数组（升序，最多 64 条）。
     */
    function timeTicks(startTs, endTs, minTicks, maxTicks) {
      var lo = Number(startTs);
      var hi = Number(endTs);
      var want = Math.max(1, Number(maxTicks) || 4);
      var need = Math.max(2, Number(minTicks) || 2);
      if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return [];
      var step = tickStepHours(hi - lo, want, need);
      if (!isFinite(step) || step <= 0) step = TICK_STEPS[TICK_STEPS.length - 1];
      // 从窗口左端往后推，不依赖时区余数 —— 之前的写法在浮点/时区边界上会算出
      // 一个永远越界的起点，for 条件恒真，直接把客户端转死。
      var offset = new Date(lo).getTimezoneOffset() * 60000;
      var t = Math.ceil((lo - offset) / step) * step + offset;
      if (!isFinite(t)) t = lo;
      var out = [];
      for (var guard = 0; guard < 64 && t <= hi; guard += 1) {
        out.push(t);
        t += step;
      }
      return out;
    }

    /** 点 → 线段的距离（画线命中的基础）。 */
    function pointToSegment(px, py, x1, y1, x2, y2) {
      var dx = x2 - x1;
      var dy = y2 - y1;
      var len2 = dx * dx + dy * dy;
      if (len2 <= 0) return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
      var t = ((px - x1) * dx + (py - y1) * dy) / len2;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      var cx = x1 + t * dx;
      var cy = y1 + t * dy;
      return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    }

    /** 点到线段的投影参数（夹到 [0,1]），拖动端点时用来判断碰到的是哪一头。 */
    function segmentT(px, py, x1, y1, x2, y2) {
      var dx = x2 - x1;
      var dy = y2 - y1;
      var len2 = dx * dx + dy * dy;
      if (len2 <= 0) return 0;
      var t = ((px - x1) * dx + (py - y1) * dy) / len2;
      return t < 0 ? 0 : (t > 1 ? 1 : t);
    }

    /** 画线命中：返回 { index, part }，part = 'a' 起点 / 'b' 终点 / 'body' 线身；没命中返回 null。 */
    function hitDrawing(geom, drawings, localX, localY) {
      if (geom === null || geom === undefined || !Array.isArray(drawings)) return null;
      var tol = DRAW_HIT_PX;
      for (var i = drawings.length - 1; i >= 0; i -= 1) { // 后画的在上层，先判它
        var shape = drawings[i];
        if (shape === null || shape === undefined || shape.hidden === true) continue;
        if (!(Number(shape.p1) === Number(shape.p1)) || !(Number(shape.p2) === Number(shape.p2))) continue;
        if (!isFinite(Number(shape.t1)) || !isFinite(Number(shape.t2))) continue;
        var a = geom.of(shape.t1, shape.p1);
        var b = geom.of(shape.t2, shape.p2);
        var da = Math.sqrt((localX - a.x) * (localX - a.x) + (localY - a.y) * (localY - a.y));
        if (da <= tol) return { index: i, part: 'a' };
        var db = Math.sqrt((localX - b.x) * (localX - b.x) + (localY - b.y) * (localY - b.y));
        if (db <= tol) return { index: i, part: 'b' };
        if (shape.kind === 'fib') {
          // 斐波那契的"线身"是各条水平比例线，点它们也算选中
          var levels = Array.isArray(shape.levels) && shape.levels.length > 0 ? shape.levels : DEFAULT_FIB_LEVELS;
          for (var k = 0; k < levels.length; k += 1) {
            var ly = geom.y(shape.p1 + (shape.p2 - shape.p1) * levels[k]);
            if (Math.abs(localY - ly) <= tol) return { index: i, part: 'body' };
          }
          continue;
        }
        if (pointToSegment(localX, localY, a.x, a.y, b.x, b.y) <= tol) return { index: i, part: 'body' };
      }
      return null;
    }

    /**
     * 把一次拖动作用到画线上：part 决定改哪一头（'body' 整条平移，价位与时间一起搬）。
     * 纯函数：不改入参，返回新的画线对象。
     */
    function moveDrawing(shape, part, dTs, dPrice) {
      var next = {};
      for (var key in shape) if (Object.prototype.hasOwnProperty.call(shape, key)) next[key] = shape[key];
      if (part === 'body') {
        next.t1 = Number(shape.t1) + dTs;
        next.t2 = Number(shape.t2) + dTs;
        next.p1 = Number(shape.p1) + dPrice;
        next.p2 = Number(shape.p2) + dPrice;
        return next;
      }
      if (part === 'a') {
        next.t1 = Number(shape.t1) + dTs;
        next.p1 = Number(shape.p1) + dPrice;
        return next;
      }
      next.t2 = Number(shape.t2) + dTs;
      next.p2 = Number(shape.p2) + dPrice;
      return next;
    }

    /** 画线的 id：旧的没存 id 的补一个，保证能单独选中/删除。 */
    var drawSeq = 0;
    function nextDrawId() {
      drawSeq += 1;
      return 'd' + String(Date.now().toString(36)) + String(drawSeq);
    }

    function withDrawingIds(list) {
      var out = [];
      for (var i = 0; i < list.length; i += 1) {
        var shape = list[i];
        if (shape === null || shape === undefined || typeof shape !== 'object') continue;
        if (typeof shape.id === 'string' && shape.id !== '') { out.push(shape); continue; }
        var copy = {};
        for (var key in shape) if (Object.prototype.hasOwnProperty.call(shape, key)) copy[key] = shape[key];
        copy.id = nextDrawId();
        out.push(copy);
      }
      return out;
    }

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

    /**
     * 蜡烛的实体：未收盘那根半透明 + 描边，一眼能看出"还在动"。
     *
     * `ctx.fillStyle = color` 必须留在里面 —— 画布状态是跨调用共享的，
     * 靠调用方先设好颜色再进来迟早会漏：漏掉的表现就是影线颜色对、实体全串成一个色。
     */
    function bodyOf(ctx, x, w, top, height, hollow, color) {
      ctx.fillStyle = color;
      ctx.globalAlpha = hollow ? 0.45 : 1;
      ctx.fillRect(x - w / 2, top, w, height);
      ctx.globalAlpha = 1;
      if (hollow) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - w / 2 + 0.5, top + 0.5, Math.max(1, w - 1), Math.max(1, height - 1));
      }
    }

    /** 圆角矩形：老浏览器没有 roundRect 就退回直角。 */
    function roundBox(g, x, y, w, h, r) {
      g.beginPath();
      if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, r);
      else g.rect(x, y, w, h);
    }

    /**
     * 尺子：量两点之间的价格差、涨跌比例与时长。
     * 视觉沿用专业图表的习惯 —— 一块半透明区间 + 一条带箭头的斜线 + 一个数据标签；
     * 涨用绿、跌用红，但标签里同时有 ▲/▼ 和正负号（不能只靠颜色区分）。
     */
    function paintMeasure(g, shape, alpha, isSelected, geom, colors) {
      var a = geom.of(shape.t1, shape.p1);
      var b = geom.of(shape.t2, shape.p2);
      var stats = measureStats(shape, geom.barMs());
      if (stats === null) return;
      var x1 = a.x;
      var y1 = a.y;
      var x2 = b.x;
      var y2 = b.y;
      var tint = stats.up ? colors.up : colors.down;
      g.globalAlpha = alpha;

      // 区间底纹
      g.fillStyle = tint;
      g.globalAlpha = alpha * 0.12;
      g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1)));
      g.globalAlpha = alpha;

      // 两端刻度（像标尺的端头）
      g.strokeStyle = tint;
      g.lineWidth = 1;
      g.setLineDash([]);
      g.beginPath();
      g.moveTo(x1 - 6, Math.round(y1) + 0.5);
      g.lineTo(x1 + 6, Math.round(y1) + 0.5);
      g.moveTo(x2 - 6, Math.round(y2) + 0.5);
      g.lineTo(x2 + 6, Math.round(y2) + 0.5);
      g.stroke();

      // 斜线 + 箭头
      g.setLineDash([4, 3]);
      g.lineWidth = isSelected ? 2.2 : 1.6;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.setLineDash([]);
      var angle = Math.atan2(y2 - y1, x2 - x1);
      var head = isSelected ? 11 : 9;
      var spread = 0.42;
      g.fillStyle = tint;
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
      g.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(x1, y1, isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
      g.fill();

      // 数据标签：▲ 差 +1,234.5  +1.54% / 起→止 3h05m 13 根
      g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      var line1 = (stats.up ? '▲ ' : '▼ ') + fmtSigned(stats.rise, digitsOf(stats.p2))
        + (stats.pct === null ? '' : '  ' + fmtPct(stats.pct));
      var line2 = fmtPrice(stats.p1, digitsOf(stats.p1)) + ' → ' + fmtPrice(stats.p2, digitsOf(stats.p2))
        + (stats.ms === null ? '' : '  ' + fmtDur(stats.ms))
        + (stats.bars === null ? '' : '  ' + String(stats.bars) + ' 根');
      var labelW = Math.max(g.measureText(line1).width, g.measureText(line2).width) + 14;
      var labelH = 32;
      var lx = x2 + 12;
      if (lx + labelW > geom.right()) lx = x2 - 12 - labelW;
      if (lx < geom.left()) lx = geom.left() + 2;
      var ly = clampNum((y2 + y1) / 2 - labelH / 2, geom.top() + 2, geom.top() + geom.height() - labelH - 2);
      g.fillStyle = 'rgba(18,22,27,0.92)';
      g.strokeStyle = tint;
      g.lineWidth = 1;
      roundBox(g, lx, ly, labelW, labelH, 5);
      g.fill();
      g.stroke();
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = tint;
      g.fillText(line1, lx + 7, ly + 10);
      g.fillStyle = '#f2f5f8';
      g.fillText(line2, lx + 7, ly + 23);
      g.globalAlpha = 1;
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

      // 颜色每帧只取一次：cssVar 要读 getComputedStyle，逐处调用等于每帧多次强制样式重算
      var up = cssVar('--btcd-up', C_UP);
      var down = cssVar('--btcd-down', C_DOWN);
      var brand = cssVar('--dsw-alias-brand-primary', '#4a8cff');
      var labelColor = cssVar('--dsw-alias-label-secondary', '#98a2ad');
      var candles = Array.isArray(board.candles) ? board.candles : [];
      var ema20 = Array.isArray(board.ema20) ? board.ema20 : [];
      var ema480 = Array.isArray(board.ema480) ? board.ema480 : [];
      var hover = view.hover;
      var hasHover = hover !== null && hover !== undefined && hover >= 0 && hover < 1e9;
      var showEma20 = view.showEma20 !== false;
      var showEma480 = view.showEma480 !== false;

      g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      if (candles.length === 0) {
        g.fillStyle = labelColor;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.fillText('没有 K 线数据', 16, 30);
        return;
      }

      var box = plotBox(canvas, candles.length);
      var padL = PAD_LEFT;
      var padR = PAD_RIGHT;
      var plotW = box.plotW;
      var plotH = box.plotH;
      var volH = box.volH;
      var priceH = box.priceH;
      var priceTop = box.priceTop;
      var volTop = box.volTop;
      var step = box.step;

      var range = priceRange(candles, ema20, ema480, showEma20, showEma480);
      if (range === null) return;
      var lo = range.lo;
      var hi = range.hi;
      var span = hi - lo || 1;
      var barMs = board.meta === undefined || board.meta === null ? 0 : Number(board.meta.barMs || 0);
      var i;
      var j;

      function xOf(index) {
        return padL + step * index + step / 2;
      }

      function yOf(price) {
        return priceTop + priceH - ((price - lo) / span) * priceH;
      }

      var lastBar = candles[candles.length - 1];
      var lastIndex = candles.length - 1;
      var isLastClosed = lastBar[6] === 1 || lastBar[6] === true;

      // 未收盘那根：先用一条极淡的竖带把"当前这一列"标出来（在网格与 K 线之下）
      if (isLastClosed !== true) {
        g.fillStyle = 'rgba(128,140,155,0.07)';
        g.fillRect(xOf(lastIndex) - step / 2, priceTop, Math.max(step, 1), volTop + volH - priceTop);
      }

      // 横向网格 + 右侧价格刻度
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
        g.globalAlpha = c[6] === 1 || c[6] === true || i !== lastIndex ? 0.5 : 0.78;
        g.fillRect(x - Math.max(1, step * 0.3), volTop + volH - hVol, Math.max(1, step * 0.6), hVol);
        g.globalAlpha = 1;
      }

      // K 线（未收盘那根半透明 + 描边）
      var bodyW = Math.max(1, Math.min(step * 0.66, 18));
      for (i = 0; i < candles.length; i += 1) {
        var row = candles[i];
        var isUp = row[4] >= row[1];
        var color = isUp ? up : down;
        var cx = xOf(i);
        var openBar = i === lastIndex && isLastClosed !== true;
        g.strokeStyle = color;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx, yOf(row[2]));
        g.lineTo(cx, yOf(row[3]));
        g.stroke();
        var yOpen = yOf(row[1]);
        var yClose = yOf(row[4]);
        bodyOf(g, cx, bodyW, Math.min(yOpen, yClose), Math.max(1, Math.abs(yClose - yOpen)), openBar, color);
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
      if (showEma20) drawLine(ema20, C_EMA20);
      if (showEma480) drawLine(ema480, C_EMA480);

      // ---- 用户画的线（直线 / 斐波那契）；画在 K 线与均线之上、十字光标之下
      function xOfTs(ts) {
        return padL + step * (indexFrac(candles, ts, barMs) + 0.5);
      }

      var selected = view.selectedId === undefined || view.selectedId === null ? null : String(view.selectedId);

      function paintLine(shape, alpha, isSelected) {
        var x1 = xOfTs(shape.t1);
        var y1 = yOf(shape.p1);
        var x2 = xOfTs(shape.t2);
        var y2 = yOf(shape.p2);
        g.globalAlpha = alpha;
        g.strokeStyle = '#4a8cff';
        g.lineWidth = isSelected ? 2.4 : 1.7;
        g.setLineDash([]);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.fillStyle = '#4a8cff';
        g.beginPath();
        g.arc(x1, y1, isSelected ? 4.5 : 3, 0, Math.PI * 2);
        g.fill();
        g.beginPath();
        g.arc(x2, y2, isSelected ? 4.5 : 3, 0, Math.PI * 2);
        g.fill();
        // 起止价格，方便对照
        g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.textAlign = 'left';
        g.textBaseline = 'bottom';
        g.fillText(fmtPrice(shape.p1, digitsOf(shape.p1)), x1 + 6, y1 - 3);
        g.fillText(fmtPrice(shape.p2, digitsOf(shape.p2)), x2 + 6, y2 - 3);
        g.globalAlpha = 1;
      }

      function paintFib(shape, alpha, isSelected) {
        var x1 = xOfTs(shape.t1);
        var y1 = yOf(shape.p1);
        var x2 = xOfTs(shape.t2);
        var y2 = yOf(shape.p2);
        var levels = Array.isArray(shape.levels) && shape.levels.length > 0 ? shape.levels : DEFAULT_FIB_LEVELS;
        g.globalAlpha = alpha;
        // 起点→终点的虚线
        g.setLineDash([4, 4]);
        g.strokeStyle = FIB_COLORS[1 % FIB_COLORS.length];
        g.lineWidth = isSelected ? 1.8 : 1;
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
        if (isSelected) {
          // 选中时把两个可拖的端点点出来
          g.fillStyle = '#4a8cff';
          g.beginPath();
          g.arc(x1, y1, 4.5, 0, Math.PI * 2);
          g.fill();
          g.beginPath();
          g.arc(x2, y2, 4.5, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
      }


      /** 画线几何：把「时间/价格」映射到本帧的屏幕坐标。绘制与命中判定共用它。 */
      var paintGeom = {
        of: function (ts, price) {
          return { x: xOfTs(ts), y: yOf(price) };
        },
        y: yOf,
        left: function () { return padL; },
        right: function () { return padL + plotW; },
        top: function () { return priceTop; },
        height: function () { return priceH; },
        barMs: function () { return board.meta === undefined || board.meta === null ? 0 : Number(board.meta.barMs || 0); },
      };
      var paintColors = { up: up, down: down };

      var annots = Array.isArray(view.drawings) ? view.drawings : [];
      for (i = 0; i < annots.length; i += 1) {
        var shape = annots[i];
        if (shape === null || shape === undefined || shape.hidden === true) continue;
        var shapeId = shape.id === undefined || shape.id === null ? '' : String(shape.id);
        var isSel = selected !== null && shapeId === selected;
        if (shape.kind === 'fib') paintFib(shape, 0.95, isSel);
        else if (shape.kind === 'measure') paintMeasure(g, shape, 0.95, isSel, paintGeom, paintColors);
        else paintLine(shape, 0.95, isSel);
      }
      if (view.preview !== null && view.preview !== undefined) {
        if (view.preview.kind === 'fib') paintFib(view.preview, 0.55, false);
        else if (view.preview.kind === 'measure') paintMeasure(g, view.preview, 0.7, false, paintGeom, paintColors);
        else paintLine(view.preview, 0.6, false);
      }

      // 时间刻度：对齐到「整点」（见 timeTicks），同时画出纵向网格线
      var ticks = timeTicks(candles[0][0], candles[lastIndex][0] + (barMs > 0 ? barMs : 0),
        Math.max(2, Math.floor(plotW / 220)), Math.max(2, Math.min(8, Math.floor(plotW / 110))));
      g.textAlign = 'center';
      g.textBaseline = 'top';
      var tickLabels = 0;
      for (i = 0; i < ticks.length; i += 1) {
        var frac = indexFrac(candles, ticks[i], barMs);
        var tickX = padL + step * (frac + 0.5);
        if (tickX < padL + 20 || tickX > padL + plotW - 20) continue;
        g.strokeStyle = C_GRID;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(Math.round(tickX) + 0.5, priceTop);
        g.lineTo(Math.round(tickX) + 0.5, volTop + volH);
        g.stroke();
        g.fillStyle = labelColor;
        g.fillText(fmtTime(ticks[i], barMs, false), tickX, volTop + volH + 6);
        tickLabels += 1;
      }

      // 当前价水平线 + 轴上的价格标签（只在「跟随最新」时画）
      //
      // 判据用 following（rightTs === null），不是下标相等：这里拿到的 candles 是**窗口切片**，
      // 而 lastIndex/lastPrice 讲的是**整条序列**的最后一根，两者下标口径不同。
      // 跟随最新时窗口右端必然就是最新那根，这才是唯一正确的条件。
      var drawLive = view.showLast !== false && view.following === true
        && Number(view.lastIndex) === lastIndex && isFinite(Number(view.lastPrice));
      if (drawLive) {
        var liveY = yOf(Number(view.lastPrice));
        g.strokeStyle = 'rgba(150,160,175,0.5)';
        g.setLineDash([5, 4]);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(padL, Math.round(liveY) + 0.5);
        g.lineTo(padL + plotW, Math.round(liveY) + 0.5);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = brand;
        g.beginPath();
        g.moveTo(padL - 1, liveY);
        g.lineTo(padL - 7, liveY - 4);
        g.lineTo(padL - 7, liveY + 4);
        g.closePath();
        g.fill();
        g.fillRect(padL + plotW + 2, liveY - 8.5, padR - 6, 17);
      }

      // 收盘倒计时：常驻在图区右上角，纯 canvas 画（每秒重绘只动 canvas，不惊动 React）
      if (drawLive) {
        var countMs = closeCountdown(lastBar[0], barMs, view.nowMs);
        if (countMs !== null) {
          var cdText = fmtCountdown(countMs);
          var cdW = g.measureText(cdText).width + 16;
          var cdX = padL + plotW - cdW - 4;
          var cdY = priceTop + 3;
          g.fillStyle = 'rgba(18,22,27,0.72)';
          roundBox(g, cdX, cdY, cdW, 18, 5);
          g.fill();
          g.fillStyle = '#cbd5e1';
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          g.fillText(cdText, cdX + 8, cdY + 9);
          g.textAlign = 'center';
          g.textBaseline = 'top';
        }
      }

      // 十字光标 + 浮层
      //
      // 两档显示（view.hoverOnCandle 由 Chart 的指针命中判定给出）：
      //   * 指针不在价格区（或没压中任何一列）：只画横线 + 价格轴上的「鼠标价格」
      //   * 指针落在价格区的某一列：横线吸附到该列收盘价，并弹完整 OHLC / 量 / 均线数据框
      if (hasHover && hover < candles.length) {
        var hc = candles[hover];
        var hx = xOf(hover);
        var onCandle = view.hoverOnCandle === true;
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

        // 指针的真实位置留个点（吸附后横线会离开指针，免得看着像"线跑了"）
        if (onCandle && isFinite(Number(view.hoverY))) {
          var dotY = clampNum(Number(view.hoverY), priceTop, priceTop + priceH);
          if (Math.abs(dotY - hy) > 2) {
            g.fillStyle = 'rgba(190,200,212,0.9)';
            g.beginPath();
            g.arc(hx, dotY, 2, 0, Math.PI * 2);
            g.fill();
          }
          // 画线/尺子正在吸附到某个 OHLC 时，把那根 K 线的高/开/低/收标出来
          if (view.snapTag) {
            var snapY = yOf(Number(view.snapTag.price));
            if (isFinite(snapY)) {
              var snapLabel = String(view.snapTag.label) + ' ' + fmtPrice(Number(view.snapTag.price), digitsOf(hc[4]));
              g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
              var snapW = g.measureText(snapLabel).width + 12;
              var snapX = clampNum(hx + 10, padL + 2, padL + plotW - snapW - 2);
              g.fillStyle = 'rgba(74,140,255,0.92)';
              roundBox(g, snapX, snapY - 9, snapW, 18, 4);
              g.fill();
              g.fillStyle = '#ffffff';
              g.textAlign = 'left';
              g.textBaseline = 'middle';
              g.fillText(snapLabel, snapX + 6, snapY);
            }
          }
        }

        // 右侧价格轴上的标签：显式一点的颜色区分「鼠标价格」与「K 线收盘价」
        g.fillStyle = onCandle ? (hc[4] >= hc[1] ? up : down) : brand;
        g.fillRect(padL + plotW + 2, hy - 7.5, padR - 6, 15);
        g.fillStyle = '#ffffff';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(fmtPrice(hoverPrice, digitsOf(hoverPrice)), padL + plotW + 6, hy);

        if (onCandle !== true) {
          // 没命中：只补一行「鼠标价格」，不弹 K 线数据
          var hintText = '鼠标 ' + fmtPrice(hoverPrice, digitsOf(hoverPrice));
          var hintW = g.measureText(hintText).width + 12;
          var hintX = padL + plotW - hintW - 6;
          var hintY = clampNum(hy - 24, priceTop + 3, priceTop + priceH - 21);
          // 回看历史时左上角有「回看中」角标，别叠上去
          if (view.following === false && hintY < priceTop + 24) {
            hintY = priceTop + 26;
            hintX = Math.min(hintX, padL + Math.max(plotW - hintW - 6, 6));
          }
          g.fillStyle = 'rgba(18,22,27,0.78)';
          roundBox(g, hintX, hintY, hintW, 18, 5);
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
          if (showEma20) rows.push(['EMA' + String(view.emaFastPeriod || 20), fmtPrice(ema20[hover], digitsOf(hc[4]))]);
          if (showEma480) rows.push(['EMA' + String(view.emaSlowPeriod || 480), fmtPrice(ema480[hover], digitsOf(hc[4]))]);
          if (hc[6] !== 1 && hc[6] !== true) rows.push(['状态', '未收盘']);
          var boxW = 132;
          var boxH = 13 * rows.length + 12;
          var bx = hx + 14;
          if (bx + boxW > padL + plotW) bx = hx - 14 - boxW;
          if (bx < padL) bx = padL + 2;
          var by = Math.max(priceTop + 2, Math.min(hy - boxH / 2, priceTop + priceH - boxH - 2));
          g.fillStyle = 'rgba(18,22,27,0.92)';
          g.strokeStyle = 'rgba(150,160,175,0.35)';
          g.lineWidth = 1;
          roundBox(g, bx, by, boxW, boxH, 6);
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
        var tagText = '回看中';
        var tagW = g.measureText(tagText).width + 14;
        g.fillStyle = 'rgba(74,140,255,0.18)';
        roundBox(g, padL + 4, priceTop + 2, tagW, 18, 9);
        g.fill();
        g.fillStyle = brand;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
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

    /**
     * 图表本体。三件事都在这里：
     *   1. 绘制（drawChart，纯函数）
     *   2. 指针交互（平移 / 缩放 / 画线 / 选中编辑），统一走 pointer 事件：
     *      一套代码同时覆盖鼠标、笔、触摸，按住轴拖动缩放与双击复位也在其中
     *   3. 键盘（方向键平移、Ctrl+方向键缩放、Alt+R 回最新、Home 回最新）
     */
    function Chart(props) {
      var canvasRef = React.useRef(null);
      var dragRef = React.useRef(null);
      var latest = React.useRef(null);
      var viewRef = React.useRef(props.view);
      var onViewRef = React.useRef(props.onView);
      var candlesRef = React.useRef([]);
      var toolRef = React.useRef('none');
      var levelsRef = React.useRef(DEFAULT_FIB_LEVELS);
      var snapRef = React.useRef(props.snap !== false);
      var snapTagRef = React.useRef(null);
      var onAddRef = React.useRef(null);
      var onUpdateRef = React.useRef(null);
      var onSelectRef = React.useRef(null);
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
      var lastIndex = candles.length === 0 ? -1 : candles.length - 1;
      // ResizeObserver 回调、指针事件与每秒重绘都要读到最新一帧的数据，统一放 ref。
      latest.current = {
        board: board,
        hover: hover,
        showEma20: props.showEma20,
        showEma480: props.showEma480,
        following: view.rightTs === null,
        drawings: props.drawings,
        selectedId: props.selectedId === undefined ? null : props.selectedId,
        preview: preview,
        snapTag: snapTagRef.current,
        barMs: props.barMs,
        win: win,
        lastIndex: lastIndex,
        lastPrice: props.lastPrice,
        emaFastPeriod: parsePeriod(props.emaFast, DEFAULT_EMA_FAST),
        emaSlowPeriod: parsePeriod(props.emaSlow, DEFAULT_EMA_SLOW),
      };
      viewRef.current = view;
      onViewRef.current = props.onView;
      candlesRef.current = candles;
      toolRef.current = tool;
      levelsRef.current = Array.isArray(props.levels) && props.levels.length > 0 ? props.levels : DEFAULT_FIB_LEVELS;
      snapRef.current = props.snap !== false;
      onAddRef.current = props.onAdd;
      onUpdateRef.current = props.onUpdate;
      onSelectRef.current = props.onSelect;

      /** 用 latest.current 画一帧（重绘入口只有一个，避免两处参数漂移）。 */
      function paint(nowMs) {
        var canvas = canvasRef.current;
        var l = latest.current;
        if (canvas === null || l === null) return;
        var h = l.hover === null || l.hover === undefined ? null : l.hover;
        drawChart(canvas, l.board, {
          hover: h === null ? null : h.index,
          hoverY: h === null ? null : h.y,
          hoverOnCandle: h !== null && h.hit === true,
          showEma20: l.showEma20,
          showEma480: l.showEma480,
          following: l.following,
          drawings: l.drawings,
          selectedId: l.selectedId,
          preview: l.preview,
          snapTag: l.snapTag,
          emaFastPeriod: l.emaFastPeriod,
          emaSlowPeriod: l.emaSlowPeriod,
          // following 同时是「回看中」角标的开关和「画最新价线/倒计时」的开关：
          // 跟随最新（rightTs === null）时窗口右端必定就是序列最后一根。
          following: l.following,
          lastIndex: l.lastIndex,
          lastPrice: l.lastPrice,
          nowMs: nowMs,
        });
      }

      React.useEffect(function () {
        var canvas = canvasRef.current;
        if (canvas === null) return;
        function redraw() { paint(Date.now()); }
        redraw();
        if (typeof ResizeObserver === 'undefined') return;
        var observer = new ResizeObserver(redraw);
        observer.observe(canvas);
        return function () { observer.disconnect(); };
      }, [win.start, win.end, candles, slice, props.showEma20, props.showEma480, hover, view.rightTs,
        props.drawings, props.selectedId, preview]);

      /**
       * 收盘倒计时要每秒走，但每分钟 60 次让 React 重渲染太浪费，
       * 所以这里只在"跨秒"时直接重画一次 canvas（React 树完全不动）。
       */
      React.useEffect(function () {
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          paint(Date.now());
        }, 1000);
        return function () { clearInterval(timer); };
      }, []);

      /** 画布几何（与 drawChart 共用 PAD_* 常量）。 */
      function geometryAt(clientX) {
        var canvas = canvasRef.current;
        if (canvas === null) return null;
        var w = windowOf(candlesRef.current, viewRef.current);
        var count = Math.max(1, w.end - w.start);
        var box = plotBox(canvas, count);
        return { padLeft: PAD_LEFT, plotWidth: box.plotW, step: box.step, count: count, win: w, box: box };
      }

      /** 画布内的本地坐标（样式像素）。 */
      function localOf(event) {
        var canvas = canvasRef.current;
        if (canvas === null) return null;
        var rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
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

      /** 指针 → 画线用的数据坐标 { ts, price }（吸附开关打开时把价格吸到最近的 OHLC）。 */
      function shapePoint(clientX, clientY) {
        var at = dataAt(clientX, clientY);
        if (at === null) return null;
        var price = at.price;
        var snapped = null;
        if (snapRef.current === true && at.box !== undefined && at.range !== null && at.range !== undefined) {
          var box = at.box;
          var range = at.range;
          var span = range.hi - range.lo || 1;
          var yOfPrice = function (value) {
            return box.priceTop + box.priceH - ((value - range.lo) / span) * box.priceH;
          };
          var hitPrice = snapPriceToOhlc(candlesRef.current, at.index, price, yOfPrice, SNAP_PX);
          if (hitPrice !== null) {
            price = hitPrice;
            snapped = { price: hitPrice, label: ohlcLabelOf(candlesRef.current[at.index], hitPrice) };
          }
        }
        return { ts: at.ts, price: price, snapped: snapped };
      }

      /** 画线的屏幕坐标 → 命中判定（与绘制共用同一套比例尺）。 */
      function drawingGeom() {
        var l = latest.current;
        if (l === null || l.board === null || l.board.candles.length === 0) return null;
        var box = plotBox(canvasRef.current, l.board.candles.length);
        var range = priceRange(l.board.candles, l.board.ema20, l.board.ema480, l.showEma20, l.showEma480);
        if (range === null) return null;
        var barMsLocal = l.barMs;
        var span = range.hi - range.lo || 1;
        return {
          of: function (ts, price) {
            return {
              x: PAD_LEFT + box.step * (indexFrac(l.board.candles, ts, barMsLocal) + 0.5),
              y: box.priceTop + box.priceH - ((price - range.lo) / span) * box.priceH,
            };
          },
          y: function (price) {
            return box.priceTop + box.priceH - ((price - range.lo) / span) * box.priceH;
          },
        };
      }

      /** 一次拖动结束后统一收尾（鼠标与触摸共用）。 */
      function endDrag() {
        if (typeof document !== 'undefined' && document.body !== undefined) document.body.style.userSelect = '';
        dragRef.current = null;
        snapTagRef.current = null;
        setDragging(false);
        setPreview(null);
      }

      function capture(event) {
        var canvas = canvasRef.current;
        if (canvas === null || typeof canvas.setPointerCapture !== 'function') return;
        try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* 不支持就算了 */ }
      }

      React.useEffect(function () {
        var canvas = canvasRef.current;
        if (canvas === null) return;
        // React 的 onWheel 是被动的，preventDefault 无效，所以自己挂一个非被动的
        function onWheel(event) {
          var geo = geometryAt(event.clientX);
          if (geo === null) return;
          event.preventDefault();
          // Shift + 滚轮 = 平移；触控板的横向滚动（deltaX 占优）也当平移
          if (event.shiftKey === true) {
            var bars = Math.max(1, Math.round(Math.abs(event.deltaY) / 60) * 3);
            onViewRef.current(panView(candlesRef.current, viewRef.current, event.deltaY > 0 ? bars : -bars));
            return;
          }
          if (event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true
            && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            var hbars = Math.max(1, Math.round(Math.abs(event.deltaX) / 30));
            onViewRef.current(panView(candlesRef.current, viewRef.current, event.deltaX > 0 ? hbars : -hbars));
            return;
          }
          // 平滑缩放：按 deltaY 的指数缩放，而不是"一格 ×1.25"。触控板与滚轮手感都在这一条上。
          var rect = canvas.getBoundingClientRect();
          var anchor = clampNum((event.clientX - rect.left - PAD_LEFT) / geo.plotWidth, 0, 1);
          var factor = Math.exp(clampNum(event.deltaY, -240, 240) / 420);
          var next = clampInt(Math.round(geo.count * factor), MIN_WINDOW, Math.max(MIN_WINDOW, candlesRef.current.length));
          if (next === geo.count) return;
          onViewRef.current(zoomView(candlesRef.current, viewRef.current, next, anchor));
        }
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return function () { canvas.removeEventListener('wheel', onWheel); };
      }, []);

      function onPointerDown(event) {
        if (event.button !== 0 || candlesRef.current.length === 0) return;
        var local = localOf(event);
        var geo = geometryAt(event.clientX);
        if (local === null || geo === null) return;

        // 落在价格轴 / 时间轴上 → 按住拖动 = 缩放（专业图表的老习惯，双击同一区域 = 复位）
        if (local.x > PAD_LEFT + geo.plotWidth || local.y > geo.box.volTop + geo.box.volH) {
          dragRef.current = {
            mode: 'axis', startX: event.clientX, moved: false, baseSize: geo.count,
            anchor: clampNum((local.x - PAD_LEFT) / geo.plotWidth, 0, 1),
          };
          setHover(null);
          setDragging(true);
          capture(event);
          return;
        }

        event.preventDefault();
        if (typeof document !== 'undefined' && document.body !== undefined) document.body.style.userSelect = 'none';
        var currentTool = toolRef.current;

        if (currentTool !== 'none') {
          // 画线/尺子模式：拖动 = 画，不平移
          var start = shapePoint(event.clientX, event.clientY);
          if (start === null) return;
          dragRef.current = {
            mode: 'draw', kind: currentTool, startX: event.clientX, startY: event.clientY, moved: false,
            t1: start.ts, p1: start.price,
          };
          snapTagRef.current = start.snapped;
          setHover(null);
          setDragging(true);
          setPreview({ kind: currentTool, t1: start.ts, p1: start.price, t2: start.ts, p2: start.price, levels: levelsRef.current });
        } else if (props.editable !== false && Array.isArray(props.drawings) && props.drawings.length > 0) {
          // 无工具时按下：点在已有的画线上就进"编辑"，否则才是平移
          var geom = drawingGeom();
          var hit = geom === null ? null : hitDrawing(geom, props.drawings, local.x, local.y);
          if (hit !== null) {
            var shape = props.drawings[hit.index];
            var at = shapePoint(event.clientX, event.clientY);
            dragRef.current = {
              mode: 'edit', part: hit.part, index: hit.index, startX: event.clientX, startY: event.clientY,
              moved: false, base: shape,
              baseTs: at === null ? Number(shape.t1) : at.ts,
              basePrice: at === null ? Number(shape.p1) : at.price,
            };
            if (typeof onSelectRef.current === 'function') onSelectRef.current(shape.id === undefined ? null : shape.id);
            setHover(null);
            setDragging(true);
          } else {
            if (typeof onSelectRef.current === 'function' && props.selectedId !== null && props.selectedId !== undefined) {
              onSelectRef.current(null);
            }
            dragRef.current = { mode: 'pan', startX: event.clientX, startView: viewRef.current, step: geo.step, delta: 0, moved: false };
            setHover(null);
            setDragging(true);
          }
        } else {
          dragRef.current = { mode: 'pan', startX: event.clientX, startView: viewRef.current, step: geo.step, delta: 0, moved: false };
          setHover(null);
          setDragging(true);
        }
        capture(event);
      }

      function onPointerMove(event) {
        var drag = dragRef.current;
        if (drag === null) { onMove(event); return; }
        if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 4) drag.moved = true;

        if (drag.mode === 'axis') {
          var ratio = Math.exp((event.clientX - drag.startX) / 220);
          var size = clampInt(Math.round(drag.baseSize * ratio), MIN_WINDOW, Math.max(MIN_WINDOW, candlesRef.current.length));
          if (size === drag.lastSize) return;
          drag.lastSize = size;
          // 拖动轴缩放时锚在当前窗口右端：往回拖 = 看得更少（放大），往前拖 = 看得更多
          onViewRef.current({ size: size, rightTs: viewRef.current.rightTs });
          return;
        }
        if (drag.mode === 'draw') {
          var at = shapePoint(event.clientX, event.clientY);
          if (at === null) return;
          snapTagRef.current = at.snapped;
          setPreview({ kind: drag.kind, t1: drag.t1, p1: drag.p1, t2: at.ts, p2: at.price, levels: levelsRef.current });
          return;
        }
        if (drag.mode === 'edit') {
          var now = shapePoint(event.clientX, event.clientY);
          if (now === null || drag.base === null || drag.base === undefined) return;
          snapTagRef.current = now.snapped;
          if (typeof onUpdateRef.current === 'function' && drag.base.id !== undefined && drag.base.id !== null) {
            onUpdateRef.current(drag.base.id, moveDrawing(drag.base, drag.part, now.ts - drag.baseTs, now.price - drag.basePrice));
          }
          return;
        }
        var dx = event.clientX - drag.startX;
        var delta = Math.round(dx / Math.max(1, drag.step));
        if (delta === drag.delta) return;
        drag.delta = delta;
        // 用「拖动开始时的视图 + 总位移」算，避免逐帧累加带来的漂移
        onViewRef.current(panView(candlesRef.current, drag.startView, delta));
      }

      function onPointerUp(event) {
        var drag = dragRef.current;
        if (drag === null) return;
        endDrag();
        if (drag.mode !== 'draw') return;
        var at = shapePoint(event.clientX, event.clientY);
        // 只是点一下（没拖动）不算一条线，免得误触画出一堆点
        if (drag.moved !== true || at === null) return;
        if (typeof onAddRef.current === 'function') {
          onAddRef.current({
            id: nextDrawId(),
            kind: drag.kind,
            t1: drag.t1,
            p1: drag.p1,
            t2: at.ts,
            p2: at.price,
            levels: drag.kind === 'fib' ? levelsRef.current.slice() : undefined,
          });
        }
      }

      /** 双击轴区域 = 复位视图；双击图区 = 缩放回默认根数。 */
      function onDoubleClick(event) {
        var local = localOf(event);
        var geo = geometryAt(event.clientX);
        if (local !== null && geo !== null && (local.x > PAD_LEFT + geo.plotWidth || local.y > geo.box.volTop + geo.box.volH)) {
          onViewRef.current({ size: viewRef.current.size, rightTs: null });
          return;
        }
        onViewRef.current({ size: DEFAULT_WINDOW, rightTs: null });
      }

      /**
       * 悬浮两档（`hitCandle` 判定，与绘制共用同一套几何）：
       *   * 指针压在 K 线的实体或影线上 → 弹 OHLC / 量 / 均线数据框，横线吸附到收盘价
       *   * 指针在画布空白处（含成交量区）→ 只画十字光标 + 右轴标出「该 y 对应的价格」
       * 缩得很小时容差会按每根宽度放宽（`hitTolerance`），否则 0.6px 宽的实体根本点不中。
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
        if (localX < PAD_LEFT) return null;
        var slice = latest.current === null ? { candles: [], ema20: [], ema480: [] } : latest.current.board;
        var range = priceRange(slice.candles, slice.ema20, slice.ema480, true, true);
        var index = clampInt(Math.floor((localX - PAD_LEFT) / box.step), 0, count - 1);
        return {
          index: index,
          y: clampNum(localY, box.priceTop, box.priceTop + box.priceH),
          hit: hitCandle(box, range, slice.candles, index, localX, localY),
        };
      }

      function onMove(event) {
        var at = hoverAt(event);
        if (at === null) {
          if (hover !== null) setHover(null);
          return;
        }
        if (hover === null || hover.index !== at.index || hover.y !== at.y || hover.hit !== at.hit) {
          setHover({ index: at.index, y: at.y, hit: at.hit });
        }
      }

      /** 键盘：方向键平移、Ctrl+方向键缩放、+/- 缩放、Alt+R / Home 回最新。 */
      function onKeyDown(event) {
        var list = candlesRef.current;
        if (list.length === 0) return;
        var key = event.key;
        var accel = event.ctrlKey === true || event.metaKey === true;
        var handled = true;
        var geo = geometryAt(0);
        var count = geo === null ? 60 : geo.count;
        if (key === '+' || key === '=' || key === '-' || key === '_') {
          var zoomed = clampInt(Math.round(count * (key === '-' || key === '_' ? 1.25 : 0.8)), MIN_WINDOW, list.length);
          onViewRef.current(zoomView(list, viewRef.current, zoomed, 1));
        } else if (accel && (key === 'ArrowUp' || key === 'ArrowDown')) {
          var n2 = clampInt(Math.round(count * (key === 'ArrowUp' ? 0.8 : 1.25)), MIN_WINDOW, list.length);
          onViewRef.current(zoomView(list, viewRef.current, n2, 1));
        } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
          var bars = accel ? 20 : 1;
          onViewRef.current(panView(list, viewRef.current, key === 'ArrowLeft' ? bars : -bars));
        } else if (event.altKey === true && (key === 'r' || key === 'R')) {
          onViewRef.current({ size: viewRef.current.size, rightTs: null });
        } else if (key === 'Home') {
          onViewRef.current({ size: viewRef.current.size, rightTs: null });
        } else if (key === 'End') {
          onViewRef.current(panView(list, viewRef.current, list.length));
        } else {
          handled = false;
        }
        if (handled) event.preventDefault();
      }

      /** 无障碍：canvas 对读屏是空白，至少给一段「现在看到什么」的文字。 */
      var ariaText = 'BTC 合约 K 线图，共 ' + String(candles.length) + ' 根，'
        + (view.rightTs === null ? '当前显示最新一段' : '正在回看历史')
        + (props.lastPrice === undefined || props.lastPrice === null ? '' : '，最新价 ' + fmtPrice(props.lastPrice))
        + '；方向键平移，Ctrl 加方向键缩放，Alt+R 回到最新';

      return React.createElement('canvas', {
        ref: canvasRef,
        className: 'btcd-canvas' + (dragging ? ' btcd-grabbing' : '') + (tool !== 'none' ? ' btcd-drawmode' : ''),
        tabIndex: 0,
        role: 'img',
        'aria-label': ariaText,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerCancel: onPointerUp,
        onPointerLeave: function () { if (dragRef.current === null) setHover(null); },
        onDoubleClick: onDoubleClick,
        onKeyDown: onKeyDown,
      });
    }


    // ------------------------------------------------------------------ 看板面板

    // ------------------------------------------------------------------ 看板面板

    // 顶部三个小图标（都是 12×12 的描边，颜色跟文字走）
    function ico(paths, size) {
      var s = size === undefined ? 12 : size;
      return React.createElement('svg', {
        width: s, height: s, viewBox: '0 0 12 12', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, paths.map(function (d, i) { return React.createElement('path', { key: 'p' + i, d: d }); }));
    }

    var ICON = {
      hand: ['M2 6.8V3.4a1 1 0 0 1 2 0v3', 'M8 6.3V2.6a1 1 0 0 1 2 0v5.2a3.8 3.8 0 0 1-3.8 3.8H5.6a3 3 0 0 1-2.3-1.1L1.6 8.4a1.05 1.05 0 0 1 1.7-1.2l1 1.3'],
      line: ['M2.4 9.6 9.6 2.4', 'M1.4 8.6a1 1 0 1 0 2 2 1 1 0 0 0-2-2Z', 'M8.6 1.4a1 1 0 1 0 2 2 1 1 0 0 0-2-2Z'],
      fib: ['M1.4 2h9.2', 'M1.4 5h9.2', 'M1.4 8h9.2'],
      // 尺子：一把斜放的直尺 + 两端刻度
      ruler: ['M1 8.6 8.6 1', 'M1.9 9.6 9.6 1.9', 'M2.6 6.6l1.3 1.3', 'M4.6 4.6l1.3 1.3', 'M6.6 2.6l1.3 1.3'],
      magnet: ['M3 9.8V5.2a3 3 0 0 1 6 0v4.6', 'M3 7.6h6', 'M2 9.8h2', 'M8 9.8h2'],
      pin: ['M6 1.2v9.6', 'M2.2 4.4h7.6'],
      undo: ['M3.2 4.4H7a2.6 2.6 0 1 1 0 5.2H4.4', 'M5 2.2 2.6 4.4 5 6.6'],
      trash: ['M2.2 3.4h7.6', 'M4.6 3.4V2.2h2.8v1.2', 'M3.4 3.4l.5 6.2h4.2l.5-6.2'],
      eye: ['M1.2 6S3.2 2.6 6 2.6 10.8 6 10.8 6 8.8 9.4 6 9.4 1.2 6 1.2 6Z', 'M6 7.4a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z'],
      eyeOff: ['M2 2l8 8', 'M1.4 6S3.4 2.8 6 2.8c.7 0 1.3.2 1.9.4', 'M10.6 6S8.6 9.2 6 9.2c-.7 0-1.3-.2-1.9-.4'],
      refresh: ['M10.2 5.2A4.2 4.2 0 1 0 6 10.2', 'M10.6 2v3.4H7.2'],
      pause: ['M4.2 3v6', 'M7.8 3v6'],
      play: ['M4.4 2.8 9 6l-4.6 3.2Z'],
    };

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
      var viewState = React.useState({ size: DEFAULT_WINDOW, rightTs: null });
      var view = viewState[0];
      var setView = viewState[1];
      var toolState = React.useState('none');
      var tool = toolState[0];
      var setTool = toolState[1];
      var levelsState = React.useState(DEFAULT_FIB_LEVELS.join(','));
      var levelsText = levelsState[0];
      var setLevelsText = levelsState[1];
      var showLevelsState = React.useState(false);
      var showLevels = showLevelsState[0];
      var setShowLevels = showLevelsState[1];
      // 画线/尺子端点是否吸附到最近的 OHLC（默认开；关掉就是鼠标的精确价格）
      var snapState = React.useState(true);
      var snap = snapState[0];
      var setSnap = snapState[1];
      // 均线周期（文本 + 生效值）：输入框每敲一下都重算，所以「动态更新」是即时的
      var periodState = React.useState([String(DEFAULT_EMA_FAST), String(DEFAULT_EMA_SLOW)]);
      var periodText = periodState[0];
      var setPeriodText = periodState[1];
      var emaFast = parsePeriod(periodText[0], DEFAULT_EMA_FAST);
      var emaSlow = parsePeriod(periodText[1], DEFAULT_EMA_SLOW);
      var drawState = React.useState([]);
      var drawings = drawState[0];
      var setDrawings = drawState[1];
      var selState = React.useState(null);
      var selectedId = selState[0];
      var setSelectedId = selState[1];
      var toastState = React.useState(null);
      var toast = toastState[0];
      var setToast = toastState[1];
      var savedRef = React.useRef(null);
      var panelRef = React.useRef(null);
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
      // 「x 秒前」与「本轮刷新有没有在跑」都要自己走，不能等 5 秒的轮询来推动
      var tick = useTick(1000);
      var submitTick = useTick(120);

      // Host 记住的周期：第一次拿到载荷时对齐一次，之后以用户点击为准。
      React.useEffect(function () {
        if (bar === null && data.board !== null && data.board.bar) setBar(data.board.bar);
      }, [data.board, bar]);

      var closeRef = React.useRef(close);
      closeRef.current = close;
      var toolRef = React.useRef(tool);
      toolRef.current = tool;
      var drawingsRef = React.useRef(drawings);
      drawingsRef.current = drawings;
      var selectedRef = React.useRef(selectedId);
      selectedRef.current = selectedId;

      /** 画线增删改的三个入口都走 ref，Chart 里读到的永远是最新实现。 */
      var drawApiRef = React.useRef(null);
      drawApiRef.current = {
        add: function (shape) { setDrawings(function (prev) { return prev.concat([shape]); }); },
        update: function (id, nextShape) {
          setDrawings(function (prev) {
            var out = [];
            for (var i = 0; i < prev.length; i += 1) out.push(prev[i].id === id ? nextShape : prev[i]);
            return out;
          });
        },
        select: function (id) { setSelectedId(id === undefined ? null : id); },
      };

      /**
       * 顶部键盘快捷键的依赖全部走 ref：
       * 这个监听只注册一次（[] 依赖），但里面读到的必须永远是「当前」的周期、画线、工具状态。
       */
      var barIdsRef = React.useRef(BAR_IDS);
      if (data.board !== null && data.board !== undefined && Array.isArray(data.board.bars)) {
        barIdsRef.current = data.board.bars.map(function (item) { return item.id; });
      }
      // 面板级键盘监听只注册一次（[] 依赖），所以它调用的函数必须走 ref —— 直接调会闭包到首帧的旧值。
      // 这几个 ref 都指向下面定义的同名函数，逻辑只有一份。
      var switchBarRef = React.useRef(null);
      var deleteSelectedRef = React.useRef(null);
      var toggleEmaRef = React.useRef(null);
      var setToolRef = React.useRef(null);
      var setSelectedRef = React.useRef(null);
      toggleEmaRef.current = function () { setEma(function (prev) { return [!prev[0], !prev[1]]; }); };
      setToolRef.current = setTool;
      setSelectedRef.current = function (id) { setSelectedId(id === undefined ? null : id); };

      React.useEffect(function () {
        if (toast === null) return undefined;
        var timer = setTimeout(function () { setToast(null); }, 2200);
        return function () { clearTimeout(timer); };
      }, [toast]);

      /**
       * 焦点管理：打开时焦点进面板、Tab 圈在面板内、关闭时把焦点还给侧边栏那个按钮。
       * role="dialog" 少了这几条，键盘用户会 Tab 到面板背后的界面里去。
       */
      React.useEffect(function () {
        var previous = typeof document === 'undefined' ? null : document.activeElement;
        var panel = panelRef.current;
        if (panel !== null && typeof panel.focus === 'function') panel.focus();
        return function () {
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function') previous.focus();
        };
      }, []);

      React.useEffect(function () {
        function onKey(event) {
          if (event.key === 'Tab') {
            var panel = panelRef.current;
            if (panel === null) return;
            var nodes = panel.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
            var focusable = [];
            for (var i = 0; i < nodes.length; i += 1) if (nodes[i].disabled !== true) focusable.push(nodes[i]);
            if (focusable.length === 0) return;
            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            var active = document.activeElement;
            if (event.shiftKey === true && (active === first || active === panel || active === null)) {
              event.preventDefault();
              last.focus();
            } else if (event.shiftKey !== true && active === last) {
              event.preventDefault();
              first.focus();
            }
            return;
          }
          if (event.key === 'Escape') {
            if (toolRef.current !== 'none') {
              // 画线模式下 Esc 先退回「无」，再按才关面板
              setToolRef.current('none');
              return;
            }
            if (selectedRef.current !== null) {
              setSelectedRef.current(null);
              return;
            }
            closeRef.current();
            return;
          }
          if (event.key === 'Delete' && selectedRef.current !== null) {
            deleteSelectedRef.current();
            event.preventDefault();
            return;
          }
          if (event.altKey === true && (event.key === 'h' || event.key === 'H')) {
            toggleEmaRef.current();
            event.preventDefault();
            return;
          }
          // 数字键 1..6 切周期（与专业图表一致的高频操作）
          if (event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true
            && typeof event.key === 'string' && event.key.length === 1 && event.key >= '1' && event.key <= '9') {
            var index = Number(event.key) - 1;
            var list = barIdsRef.current;
            if (index < list.length) {
              switchBarRef.current(list[index]);
              event.preventDefault();
            }
          }
        }
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, []);

      // 画线的持久化：按「合约 + 周期」分开存（时间轴口径不同，混在一起没意义），
      // 存在浏览器 localStorage 里，不写宿主磁盘。
      var drawStoreKey = 'dsh-btc-dashboard:drawings:'
        + (data.board === null || data.board === undefined ? 'BTC-USDT-SWAP' : data.board.instId) + ':'
        + (bar === null ? '15m' : bar);

      React.useEffect(function () {
        // 老版本存的画线没有 id，补上（否则没法单独选中/删除）
        var raw = loadStored(drawStoreKey, []);
        var stored = withDrawingIds(Array.isArray(raw) ? raw : []);
        setDrawings(stored);
        setSelectedId(null);
        savedRef.current = JSON.stringify(stored);
      }, [drawStoreKey]);

      React.useEffect(function () {
        var text = JSON.stringify(drawings);
        // 刚载入/刚切周期时内容与已存一致，别把还没加载完的空数组写回去
        if (savedRef.current === text) return;
        savedRef.current = text;
        saveStored(drawStoreKey, drawings);
      }, [drawStoreKey, drawings]);

      function undoDrawing() {
        setDrawings(function (prev) { return prev.slice(0, Math.max(0, prev.length - 1)); });
      }

      function clearDrawings() {
        setDrawings([]);
        setSelectedId(null);
      }

      /**
       * 换周期：必须同时把选中清掉。
       * 不同周期的时间戳完全不同，旧锚点没有意义 → 回到「跟随最新」。
       */
      function switchBar(id) {
        setBar(id);
        setSelectedId(null);
        setView(function (prev) { return { size: prev.size, rightTs: null }; });
      }

      /** 删除当前选中的那条画线（工具条按钮与 Delete 键共用）。 */
      function deleteSelected() {
        var id = selectedRef.current;
        if (id === null) return;
        setDrawings(function (prev) {
          var out = [];
          for (var i = 0; i < prev.length; i += 1) if (prev[i].id !== id) out.push(prev[i]);
          return out;
        });
        setSelectedId(null);
        setToast('已删除选中的画线');
      }

      // 键盘监听里用到的两个入口（实现在上面）：每次渲染都重新指向当帧的闭包
      switchBarRef.current = switchBar;
      deleteSelectedRef.current = deleteSelected;

      function toggleSelectedHidden() {
        var id = selectedRef.current;
        if (id === null) return;
        setDrawings(function (prev) {
          var out = [];
          for (var i = 0; i < prev.length; i += 1) {
            var shape = prev[i];
            if (shape.id === id) {
              var copy = {};
              for (var key in shape) if (Object.prototype.hasOwnProperty.call(shape, key)) copy[key] = shape[key];
              copy.hidden = copy.hidden !== true;
              out.push(copy);
            } else {
              out.push(shape);
            }
          }
          return out;
        });
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
      var barList = board !== null && Array.isArray(board.bars) ? board.bars : BAR_IDS.map(function (id) {
        return { id: id, label: id };
      });
      var stats = board === null ? null : board.stats;
      var warnings = board === null || board.meta === undefined || board.meta === null ? [] : (board.meta.warnings || []);
      var fullCandles = board === null ? [] : (board.candles || []);
      // 均线在这里算一次（整条序列），图例数字、价距均线、图上的曲线都取自它，口径一致。
      // 序列一变（每 5 秒刷新/切周期）或周期一改，就重算 —— 这就是「动态更新」。
      var emaNow = emaFor(fullCandles, emaFast, emaSlow, board === null ? 0 : board.fetchedAt);
      var lastFast = emaNow.emaFast.length === 0 ? null : emaNow.emaFast[emaNow.emaFast.length - 1];
      var lastSlow = emaNow.emaSlow.length === 0 ? null : emaNow.emaSlow[emaNow.emaSlow.length - 1];
      var lastClose = fullCandles.length === 0 ? null : fullCandles[fullCandles.length - 1][4];
      var barMs = board === null || board.meta === undefined || board.meta === null ? 0 : Number(board.meta.barMs || 0);
      var vsFast = lastClose === null || lastFast === null || lastFast === 0
        ? null : Number((((lastClose - lastFast) / lastFast) * 100).toFixed(3));
      var vsSlow = lastClose === null || lastSlow === null || lastSlow === 0
        ? null : Number((((lastClose - lastSlow) / lastSlow) * 100).toFixed(3));

      // ---- 可视区间的统计：Host 每 5 秒都算好了（windowHigh/windowLow/windowVolume/windowChangePct），
      //      以前一个都没显示；可视根数一变就自己在本地的整条序列上重算，跟视野完全同步。
      var viewWindow = windowOf(fullCandles, view);
      var visible = viewWindow.end - viewWindow.start;
      var vHigh = null;
      var vLow = null;
      var vVol = 0;
      var vFirst = null;
      for (var vi = viewWindow.start; vi < viewWindow.end; vi += 1) {
        var candle = fullCandles[vi];
        if (candle === undefined) continue;
        vHigh = vHigh === null ? candle[2] : Math.max(vHigh, candle[2]);
        vLow = vLow === null ? candle[3] : Math.min(vLow, candle[3]);
        vVol += candle[5];
        if (vFirst === null) vFirst = candle[4];
      }
      var vChange = vFirst === null || vFirst === 0 || lastClose === null
        ? null : Number((((lastClose - vFirst) / vFirst) * 100).toFixed(2));
      var lastBarDone = fullCandles.length === 0 ? true : (fullCandles[fullCandles.length - 1][6] === 1 || fullCandles[fullCandles.length - 1][6] === true);
      var countdownMs = fullCandles.length === 0 || viewWindow.end !== fullCandles.length
        ? null : closeCountdown(fullCandles[fullCandles.length - 1][0], barMs, tick);
      var following = viewWindow.end === fullCandles.length;

      // 数据是不是"新鲜"：连续失败超过一个轮询周期就把价格压成中性色（还要留出网络慢的余量）
      var stale = data.status === 'error' && data.at !== 0 && tick - data.at > REFRESH_MS * 2.5;
      var staleFor = stale ? fmtDur(tick - data.at) : '';
      var submitting = data.status === 'refreshing' && submitTick - data.at > 700;

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
        stale ? React.createElement('span', {
          className: 'btcd-chip btcd-stale', key: 'stale',
          role: 'status', 'aria-live': 'polite',
          title: '最近一次刷新失败，画面上的价格是 ' + staleFor + '前的那一份',
        }, '数据 ' + staleFor + '未更新') : null,
        React.createElement('div', { className: 'btcd-spacer', key: 'sp' }),
        React.createElement('button', {
          className: 'btcd-icon-btn', key: 'refresh',
          onClick: function () { refresh(true); },
          title: '立即刷新（绕过 15 秒热缓存）',
          'aria-label': '立即刷新',
        }, submitting ? React.createElement('span', { className: 'btcd-spin' }) : ico(ICON.refresh)),
        React.createElement('button', {
          className: 'btcd-icon-btn' + (auto ? ' on' : ''), key: 'auto',
          onClick: function () { setAuto(!auto); },
          title: auto ? '自动刷新已开（5 秒）：点击暂停' : '自动刷新已暂停：点击恢复',
          'aria-label': auto ? '暂停自动刷新' : '恢复自动刷新',
        }, ico(auto ? ICON.pause : ICON.play)),
        React.createElement('button', { className: 'btcd-x', key: 'close', onClick: close, title: '关闭（Esc）', 'aria-label': '关闭看板' }, '✕'),
      ];
      children.push(React.createElement('div', { className: 'btcd-head', key: 'head' }, headKids));

      // 价格行
      var priceKids = [
        React.createElement('span', {
          className: 'btcd-last ' + (up ? 'btcd-up' : 'btcd-down') + (stale ? ' btcd-stale' : ''), key: 'last',
        }, fmtPrice(last)),
        React.createElement('span', {
          className: 'btcd-chg ' + (up ? 'btcd-up' : 'btcd-down') + (stale ? ' btcd-stale' : ''), key: 'chg',
        }, fmtSigned(quote === null ? null : quote.change24h, 1) + '  ' + fmtPct(changePct)),
        React.createElement('div', { className: 'btcd-kv', key: 'kv' },
          React.createElement('span', null, '买 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.bid))),
          React.createElement('span', null, '卖 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.ask))),
          React.createElement('span', null, '24h高 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.high24h))),
          React.createElement('span', null, '24h低 ', React.createElement('b', null, fmtPrice(quote === null ? null : quote.low24h))),
          React.createElement('span', null, '24h量 ',
            React.createElement('b', null, fmtVol(quote === null ? null : quote.vol24h) + ' BTC')),
          React.createElement('span', { title: '最近一根 K 线的收盘时间' }, '更新 ',
            React.createElement('b', null, fmtTime(data.at, 0, true))),
          countdownMs === null ? null : React.createElement('span', {
            className: 'btcd-countdown', key: 'cd',
            title: '距离本根 ' + (bar === null ? '15m' : bar) + ' K 线收盘还有 ' + fmtDur(countdownMs),
          }, '距收盘 ', React.createElement('b', null, fmtDur(countdownMs))),
          React.createElement('span', null, 'EMA ',
            React.createElement('b', null, String(emaFast) + ': ' + fmtPrice(lastFast) + ' / ' + String(emaSlow) + ': ' + fmtPrice(lastSlow))),
          React.createElement('span', null,
            '价距EMA' + String(emaFast) + ' ',
            React.createElement('b', { className: vsFast === null || vsFast < 0 ? 'btcd-down' : 'btcd-up' }, fmtPct(vsFast)),
            ' 距EMA' + String(emaSlow) + ' ',
            React.createElement('b', { className: vsSlow === null || vsSlow < 0 ? 'btcd-down' : 'btcd-up' }, fmtPct(vsSlow))),
          submitting ? React.createElement('span', { className: 'btcd-hint' }, '刷新中…') : null),
      ];
      children.push(React.createElement('div', { className: 'btcd-price-row', key: 'price' }, priceKids));

      // 周期 + 窗口根数 + 均线周期（合成两行，图表能多留 ~30px）
      var tabKids = [];
      for (var i = 0; i < barList.length; i += 1) {
        tabKids.push(React.createElement('button', {
          key: barList[i].id,
          className: 'btcd-tab' + ((bar === null ? '15m' : bar) === barList[i].id ? ' on' : ''),
          title: '切换到 ' + barList[i].label + '（快捷键 ' + String(i + 1) + '）',
          onClick: function (id) { return function () { switchBar(id); }; }(barList[i].id),
        }, barList[i].label));
      }
      var rangeKids = [React.createElement('span', { key: 'lbl', className: 'btcd-lbl' }, '窗口')];
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

      // 均线周期 + 画线工具（同一行）
      var emaKids = [
        React.createElement('span', { key: 'lbl', className: 'btcd-lbl' }, '均线'),
        React.createElement(PeriodEditor, {
          key: 'fast', value: emaFast, title: '快线周期（默认 20，2–' + String(EMA_PERIOD_MAX) + '）',
          onCommit: function (text) { setPeriodText([text, periodText[1]]); },
        }),
        React.createElement('span', { key: 'sep', className: 'btcd-lbl' }, '/'),
        React.createElement(PeriodEditor, {
          key: 'slow', value: emaSlow, title: '慢线周期（默认 480，2–' + String(EMA_PERIOD_MAX) + '）',
          onCommit: function (text) { setPeriodText([periodText[0], text]); },
        }),
        React.createElement('span', { key: 'sp', className: 'btcd-spacer' }),
      ];
      var TOOLS = [
        ['none', '平移', '平移 / 缩放模式（拖动=平移，滚轮=缩放，双击=复位）', ICON.hand],
        ['line', '直线', '在图上按住拖动，画一条直线；画完后可直接拖动/点选它', ICON.line],
        ['fib', '斐波那契', '在图上按住拖动：起点→终点决定区间，默认画 0 / 0.5 / 1 / 1.5 / 2', ICON.fib],
        ['measure', '尺子', '在图上按住拖动量一段：价格差、涨跌比例、时长（端点会吸附到 OHLC）', ICON.ruler],
      ];
      var toolKids = [React.createElement('span', { key: 'lbl', className: 'btcd-lbl' }, '画线')];
      for (var t = 0; t < TOOLS.length; t += 1) {
        toolKids.push(React.createElement('button', {
          key: TOOLS[t][0],
          className: 'btcd-tool' + (tool === TOOLS[t][0] ? ' on' : ''),
          title: TOOLS[t][2],
          'aria-pressed': tool === TOOLS[t][0],
          onClick: function (id) { return function () { setTool(id); }; }(TOOLS[t][0]),
        }, ico(TOOLS[t][3]), React.createElement('span', null, TOOLS[t][1])));
      }
      if (tool === 'fib') {
        toolKids.push(React.createElement('button', {
          key: 'levels-toggle',
          className: 'btcd-tool' + (showLevels ? ' on' : ''),
          title: '自定义斐波那契比例（逗号或空格分隔）',
          'aria-pressed': showLevels,
          onClick: function () { setShowLevels(!showLevels); },
        }, ico(ICON.pin)));
        if (showLevels) {
          toolKids.push(React.createElement('input', {
            key: 'levels',
            className: 'btcd-levels',
            value: levelsText,
            spellCheck: false,
            'aria-label': '斐波那契比例，逗号分隔',
            title: '斐波那契比例，逗号分隔（改完立刻生效）',
            onChange: function (event) { setLevelsText(event.target.value); },
            onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur(); },
          }));
        }
      }
      var selectedShape = null;
      for (var si = 0; si < drawings.length; si += 1) if (drawings[si].id === selectedId) selectedShape = drawings[si];
      // 吸附开关：画线/尺子的端点是否吸到最近的 OHLC（默认开）
      toolKids.push(React.createElement('button', {
        key: 'snap', className: 'btcd-tool' + (snap ? ' on' : ''),
        title: snap ? '端点吸附已开：靠近 OHLC 时自动对齐（点击关闭）' : '端点吸附已关：端点落在鼠标的精确价格（点击开启）',
        'aria-pressed': snap,
        onClick: function () { setSnap(!snap); },
      }, ico(ICON.magnet), React.createElement('span', null, '吸附')));
      toolKids.push(React.createElement('button', {
        key: 'undo', className: 'btcd-tool', title: '撤销最后一条', disabled: drawings.length === 0,
        onClick: undoDrawing,
      }, ico(ICON.undo), React.createElement('span', null, '撤销')));
      toolKids.push(React.createElement('button', {
        key: 'clear', className: 'btcd-tool', title: '清空当前周期的所有画线', disabled: drawings.length === 0,
        onClick: clearDrawings,
      }, ico(ICON.trash), React.createElement('span', null, '清空')));
      if (selectedShape !== null) {
        toolKids.push(React.createElement('span', { key: 'sel', className: 'btcd-chip btcd-sel' },
          selectedShape.kind === 'fib' ? '已选斐波那契'
            : (selectedShape.kind === 'measure' ? '已选尺子' : '已选直线')));
        toolKids.push(React.createElement('button', {
          key: 'hide', className: 'btcd-tool', title: selectedShape.hidden === true ? '显示这条画线' : '隐藏这条画线',
          onClick: toggleSelectedHidden,
        }, ico(selectedShape.hidden === true ? ICON.eyeOff : ICON.eye), React.createElement('span', null, selectedShape.hidden === true ? '显示' : '隐藏')));
        toolKids.push(React.createElement('button', {
          key: 'del', className: 'btcd-tool', title: '删除选中的画线（Delete）',
          onClick: deleteSelected,
        }, ico(ICON.trash), React.createElement('span', null, '删除')));
      }
      children.push(React.createElement('div', { className: 'btcd-bar', key: 'toolbar' },
        React.createElement('div', { className: 'btcd-tabs', style: { flex: '1 1 auto' } }, emaKids),
        React.createElement('div', { className: 'btcd-tabs' }, toolKids)));

      // 图表：拖动平移、滚轮缩放、双击回最新（触摸同样走 pointer 事件）
      var chartWrapKids = [React.createElement(Chart, {
        key: 'chart',
        candles: fullCandles,
        // 均线不再取 Host 发来的数组（那只有展示窗口那一段），Chart 内部按周期现算
        emaFast: emaFast,
        emaSlow: emaSlow,
        fetchedAt: board === null ? 0 : board.fetchedAt,
        barMs: barMs,
        view: view,
        onView: setView,
        showEma20: showEma20,
        showEma480: showEma480,
        tool: tool,
        levels: parseFibLevels(levelsText),
        snap: snap,
        drawings: drawings,
        selectedId: selectedId,
        onAdd: drawApiRef.current.add,
        onUpdate: drawApiRef.current.update,
        onSelect: drawApiRef.current.select,
        lastIndex: fullCandles.length === 0 ? -1 : fullCandles.length - 1,
        lastPrice: lastClose,
        // 不传 nowMs：图表里的倒计时由 Chart 自己的每秒计时器直接重画 canvas 驱动，
        // 让它跟着 React 每秒重渲染一次纯属浪费。
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

      // 图例 + 可视区间统计（统计以前是 Host 白算的：windowHigh/Low/Volume/ChangePct 一个都没显示）
      var legendKids = [
        React.createElement('button', {
          key: 'ema-fast',
          className: showEma20 ? '' : 'off',
          onClick: function () { setEma([!showEma20, showEma480]); },
          title: '显示/隐藏 EMA' + String(emaFast) + '（Alt+H 两条一起切换）',
        }, React.createElement('span', { className: 'btcd-dot', style: { background: C_EMA20 } }), 'EMA' + String(emaFast) + ' ', fmtPrice(lastFast)),
        React.createElement('button', {
          key: 'ema-slow',
          className: showEma480 ? '' : 'off',
          onClick: function () { setEma([showEma20, !showEma480]); },
          title: '显示/隐藏 EMA' + String(emaSlow) + '（Alt+H 两条一起切换）',
        }, React.createElement('span', { className: 'btcd-dot', style: { background: C_EMA480 } }), 'EMA' + String(emaSlow) + ' ', fmtPrice(lastSlow)),
        React.createElement('span', { className: 'btcd-spacer', key: 'sp' }),
      ];
      if (visible > 1 && vHigh !== null) {
        legendKids.push(React.createElement('span', {
          key: 'vstat',
          title: '可视区间（' + String(visible) + ' 根）的高低、量、涨跌幅 —— 随视野实时变化',
        }, '可视 ',
          React.createElement('b', { className: vChange === null || vChange < 0 ? 'btcd-down' : 'btcd-up' }, fmtPct(vChange)),
          ' 高 ', React.createElement('b', null, fmtPrice(vHigh)),
          ' 低 ', React.createElement('b', null, fmtPrice(vLow)),
          ' 量 ', React.createElement('b', null, fmtVol(vVol))));
      }
      legendKids.push(React.createElement('span', { key: 'range' },
        '可视 ' + String(visible) + ' / 已取 ' + String(fullCandles.length) + ' 根'
        + (stats === null ? '' : ' · 序列 ' + String(stats.seriesCount) + ' 根')));
      if (following !== true && fullCandles.length > 0) {
        legendKids.push(React.createElement('span', { key: 'span' },
          fmtTime(fullCandles[viewWindow.start][0], 0, true) + ' → ' + fmtTime(fullCandles[viewWindow.end - 1][0], 0, true)));
      }
      legendKids.push(React.createElement('span', { key: 'keys', className: 'btcd-hint' },
        '拖动平移 · 滚轮缩放 · 双击复位 · ←→ 平移 · Ctrl+↑↓ 缩放 · 1-6 切周期'));
      children.push(React.createElement('div', { className: 'btcd-legend', key: 'legend' }, legendKids));

      // 页脚：数据源 / 通道 + 告警
      var footKids = [
        React.createElement('span', { key: 'src' }, '数据源 OKX ' + (board === null ? 'BTC-USDT-SWAP' : board.instId) + ' · 公开行情接口（无需签名）'),
        React.createElement('span', { key: 'trans' }, '通道 ' + String(board === null ? '—' : (board.transport || '—')) + (board === null || board.proxy === null ? '（直连）' : '（' + board.proxy + '）')),
        React.createElement('span', { key: 'lat' }, '耗时 ' + String(board === null || board.latencyMs === undefined ? '—' : board.latencyMs + 'ms')),
        board === null ? null : React.createElement('span', { key: 'cache' }, board.meta && board.meta.cached ? '热缓存命中' : '翻页 ' + String(board.meta ? board.meta.pages : 0) + ' 页'),
        React.createElement('span', { key: 'state' },
          lastBarDone ? 'K 线已收盘' : '当前 K 线未收盘',
          countdownMs === null ? '' : ' · 距收盘 ' + fmtDur(countdownMs)),
        React.createElement('span', { key: 'upd' }, data.at === 0 ? '' : fmtAgo(tick - data.at)),
      ];
      for (var w = 0; w < warnings.length; w += 1) {
        footKids.push(React.createElement('span', { className: 'btcd-warn', key: 'w' + w }, '⚠ ' + warnings[w]));
      }
      if (actionError !== null) footKids.push(React.createElement('span', { className: 'btcd-err', key: 'ae' }, '⚠ ' + actionError));
      children.push(React.createElement('div', { className: 'btcd-foot', key: 'foot' }, footKids));

      if (toast !== null) {
        children.push(React.createElement('div', { className: 'btcd-toast', key: 'toast', role: 'status' }, toast));
      }

      return React.createElement('div', {
        className: 'btcd-overlay',
        onMouseDown: function (event) { if (event.target === event.currentTarget) close(); },
      }, React.createElement('div', {
        className: 'btcd-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'OKX BTC 合约价格看板',
        tabIndex: -1,
        ref: panelRef,
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
      }, React.createElement('span', { key: 'text', className: up ? 'btcd-up' : 'btcd-down' },
        (props.wide === true ? text : '📊')));    }

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
        viewWindow: viewWindow,
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
        cssVar: cssVar,
        // 本轮新增的纯函数（离线自检直接测它们，不用搭 DOM）
        closeCountdown: closeCountdown,
        fmtCountdown: fmtCountdown,
        timeTicks: timeTicks,
        tickStepHours: tickStepHours,
        TICK_STEPS: TICK_STEPS,
        hitTolerance: hitTolerance,
        snapPriceToOhlc: snapPriceToOhlc,
        ohlcLabelOf: ohlcLabelOf,
        measureStats: measureStats,
        SNAP_PX: SNAP_PX,
        pointToSegment: pointToSegment,
        segmentT: segmentT,
        hitDrawing: hitDrawing,
        moveDrawing: moveDrawing,
        nextDrawId: nextDrawId,
        withDrawingIds: withDrawingIds,
        DRAW_HIT_PX: DRAW_HIT_PX,
        bodyOf: bodyOf,
        roundBox: roundBox,
        paintMeasure: paintMeasure,
        fmtDur: fmtDur,
        fmtAgo: fmtAgo,
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
        DEFAULT_WINDOW: DEFAULT_WINDOW,
        MIN_WINDOW: MIN_WINDOW,
        RANGES: RANGES,
        BAR_IDS: BAR_IDS,
        useTick: useTick,
        ico: ico,
        ICON: ICON,
      },
    };
  },
});
