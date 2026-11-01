/**
 * dsh-btc-dashboard —— OKX BTC 合约看板的浏览器半（client.js）。
 *
 * 注意两件事，它们由 DSH 的客户端模块机制定死：
 *   1. 这个文件不是 ESM：必须用 window.__ModuleLoader__.load({ id, factory }) 注册惰性工厂，
 *      且 id 必须等于包名（dsh-btc-dashboard）。宿主按原样把这些字节发给浏览器，不做构建。
 *   2. 只能 require 平台种子表里的模块（这里用 react），其它一律不准 —— 所以图表用原生 canvas 画。
 *
 * 数据全部来自 Host 半注册的同源路由 /dsh-btc/*：没有 CORS，密钥也永远不进浏览器。
 */
window.__ModuleLoader__.load({
  id: 'dsh-btc-dashboard',
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
    // 均线的默认色板（前两个就是原来的 EMA20 黄 / EMA480 紫，保持观感不变）
    var EMA_DEFAULT_COLORS = ['#f0b90b', '#a78bfa', '#4a8cff', '#2dd4bf', '#fb923c', '#ea3943', '#e879f9', '#94a3b8'];
    var C_GRID = 'rgba(128,140,155,0.18)';
    var C_AXIS = 'rgba(140,152,166,0.9)';
    // ---- 画布内的浮层颜色：画布不认 CSS，只能写死。这些值是照「浅色面板」选的。
    // 浮层底用深色半透明：对比强，落点也稳（TradingView 的 tooltip 也是深底）
    var C_POPOVER_BG = 'rgba(18,22,27,0.92)';
    var C_POPOVER_BG_SOFT = 'rgba(18,22,27,0.78)';
    var C_POPOVER_TEXT = '#f2f5f8';
    var C_POPOVER_LABEL = 'rgba(160,172,186,0.95)';
    var C_POPOVER_EDGE = 'rgba(140,152,166,0.45)';
    // 十字光标 / 纵横虚线 / 最新价线：**浅色面板上必须够深**，否则白底上根本看不见
    // （这几个以前用的是 rgba(150,160,175,…)，那是照深色底选的，在浅底上等于隐形）
    var C_CROSSHAIR = 'rgba(90,100,112,0.75)';
    // 「当前这一列」的底带、指针实点
    var C_BAND = 'rgba(90,100,112,0.10)';
    var C_POINTER_DOT = 'rgba(70,80,92,0.9)';
    // 画布光标：所有状态（默认 / 拖动中 / 画线中）统一用**纯黑十字**。
    // 自绘而不是用系统关键字：`crosshair` 在浅色主题下是白的、`grab`/`grabbing` 是手型，
    // 都给不了"黑色十字"。面板在浅色主题下是浅底（`--dsw-alias-bg-layer-1` 解析为白），
    // 所以纯黑看得清 —— 本仓库没有深色主题。
    // 光标热点 = (6, 6)，正好是十字交点。
    var CURSOR_CROSS = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13'%3E"
      + "%3Cpath d='M6 0H5v5H0v1h5v5h1V6h5V5H6z' fill='%23000000'/%3E"
      + '%3C/svg%3E") 6 6, crosshair';

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
      // 画布光标：三种状态统一是黑色十字（需求如此）。touch-action:none 让触摸拖动不被页面滚动抢走。
      '.btcd-canvas{display:block;width:100%;height:100%;cursor:' + CURSOR_CROSS + ';touch-action:none}',
      // 画线模式与平移模式的光标一样，这个类只留着给"当前处于画线模式"的语义/测试用
      '.btcd-canvas.btcd-drawmode{cursor:' + CURSOR_CROSS + '}',
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
      // 工具条上的分组标签：「窗口 / 均线 / 工具」。
      // 固定同样的小字号、同一行的行高、同一个最小宽度，并让字在框里居中 ——
      // 这样两行工具条里"标签与后面控件"的基线一致，标签之间也左右对齐（不会一行偏上一行偏下）。
      '.btcd-lbl{display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:22px;height:22px;min-width:26px;color:var(--dsw-alias-label-secondary,#98a2ad);white-space:nowrap}',
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
      // 工具条上的均线条目：色块 + 周期，点它开关；关掉时整条变暗
      '.btcd-ema{padding:3px 7px}',
      '.btcd-ema.off{opacity:.42;text-decoration:line-through}',
      '.btcd-ema-dot{width:9px;height:9px;border-radius:2px;display:inline-block;flex:none}',
      '.btcd-ema-dot-lg{width:14px;height:14px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#4a535c)}',
      // 均线管理浮层：绝对定位在面板内，不挤占图表高度
      '.btcd-panel{position:relative}',
      '.btcd-emapanel{position:absolute;top:96px;right:14px;z-index:4;min-width:290px;background:var(--dsw-alias-bg-overlay,#2b333b);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l2,#4a535c);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.32);padding:8px 10px;display:flex;flex-direction:column;gap:6px;font-size:12px}',
      '.btcd-emapanel-head{display:flex;align-items:center;gap:8px;font-weight:600;padding-bottom:2px}',
      '.btcd-emapanel-row{display:flex;align-items:center;gap:8px}',
      '.btcd-emapanel-row .btcd-period{width:70px;text-align:center}',
      '.btcd-emapanel-foot{color:var(--dsw-alias-label-secondary,#98a2ad);font-size:11px;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l1,#3a4149)}',
      '.btcd-danger:hover{color:var(--dsw-alias-state-error-primary,#ff6b6b)!important}',
      '.btcd-mini-primary{color:var(--dsw-alias-brand-primary,#4a8cff);font-weight:600}',
      '.btcd-mini:disabled{opacity:.45;cursor:not-allowed}',
      // 邮件开关：用颜色说话 —— 开启=绿色，关闭=红色（一眼看出当前状态）
      '.btcd-email-btn{font-weight:600}',
      '.btcd-email-btn-on{background:rgba(22,199,132,.16);border-color:rgba(22,199,132,.55);color:#0f9c67}',
      '.btcd-email-btn-off{background:rgba(234,57,67,.14);border-color:rgba(234,57,67,.5);color:#cf2f39}',
      // 收线预警
      '.btcd-alertpanel{top:132px}',
      // 规则 + 12 条记录能把浮层撑得很高，得让它自己滚（不然底部的记录被切在屏幕外）
      '.btcd-emapanel.btcd-alertpanel{max-height:calc(100vh - 210px);overflow:auto}',
      // 记录那块单独限制高度并滚动，规则区始终看得见
      '.btcd-alert-logwrap{display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow:auto}',
      '.btcd-alert-up{color:var(--btcd-up,#16c784)!important}',
      '.btcd-alert-down{color:var(--btcd-down,#ea3943)!important}',
      '.btcd-alert-btn.armed{color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-alert-chip{background:rgba(74,140,255,.14);color:#4a8cff;border-radius:6px;padding:2px 7px;white-space:nowrap}',
      // 规则绑的不是当前周期时，那格提示要弱化（免得误以为"本周期生效"）
      '.btcd-alert-elsewhere{opacity:.65}',
      // 预警记录
      '.btcd-alert-loghead{border-top:none;display:flex;align-items:center;gap:8px}',
      '.btcd-alert-logrow{align-items:baseline}',
      '.btcd-alert-logtime{color:var(--dsw-alias-label-secondary,#98a2ad);font-size:11px;white-space:nowrap}',
      '.btcd-alert-logtext{font-size:11px}',
      // 工具条按钮上的未读数
      '.btcd-alert-dot{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:#ea3943;color:#fff;font-size:10px;line-height:15px;text-align:center}',
      '.btcd-alert-btn{position:relative}',
      // 自检块：条件不满足时染红，一眼能看见
      '.btcd-alert-diag{background:rgba(74,140,255,.08);border-radius:6px;padding:5px 7px;line-height:1.5}',
      '.btcd-alert-diag-bad{background:rgba(234,57,67,.12)}',
      // 判据日志：一根一行（命中打 ✔，没中打 ·）
      '.btcd-alert-evalrow{align-items:baseline;gap:6px;flex-wrap:wrap}',
      '.btcd-alert-evalrow .btcd-alert-logtext{flex:1 1 auto}',
      '.btcd-alert-gap{color:var(--dsw-alias-state-warning-primary,#d29922);font-size:11px;white-space:nowrap}',
      // 邮件通道
      '.btcd-email-block{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1,#e6e9ee);padding-top:8px}',
      '.btcd-email-to{flex:1 1 auto;min-width:140px}',
      // ---- 回测面板：复用 .btcd-emapanel 的定位 / 底色 / 边框，只覆盖宽度与最大高度 ——
      //      回测要放下表单 + 8 格 KPI + 资金曲线 + 交易表，290px 的默认宽度根本不够。
      '.btcd-emapanel.btcd-btpanel{top:96px;width:460px;max-width:calc(100vw - 40px);max-height:calc(100vh - 210px);overflow:auto}',
      '.btcd-bt-sub{color:var(--dsw-alias-label-secondary,#98a2ad);font-size:11px;font-weight:400}',
      '.btcd-bt-hint{color:var(--dsw-alias-label-secondary,#98a2ad);font-size:11px}',
      '.btcd-bt-warn{color:var(--dsw-alias-state-warn-primary,#e0a800);font-size:11px}',
      '.btcd-bt-select{background:var(--dsw-alias-bg-base,#1a1f24);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l2,#4a535c);border-radius:6px;padding:3px 6px;font-size:11.5px;outline:none}',
      '.btcd-bt-select:focus{border-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-bt-input{width:78px;background:var(--dsw-alias-bg-base,#1a1f24);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l2,#4a535c);border-radius:6px;padding:3px 7px;font-size:11.5px;font-variant-numeric:tabular-nums;outline:none}',
      '.btcd-bt-input:focus{border-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-bt-input.btcd-bt-date{width:122px}',
      '.btcd-bt-check{accent-color:var(--dsw-alias-brand-primary,#4a8cff)}',
      '.btcd-bt-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.btcd-bt-progress{background:rgba(74,140,255,.10);border-radius:6px;padding:4px 7px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.btcd-bt-done{font-size:11.5px;font-weight:600;line-height:1.5}',
      '.btcd-bt-error{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:11.5px;line-height:1.5}',
      // 旧 Host（没加载多标的版本）时的提示：用警示色，别让它看起来像普通说明
      '.btcd-bt-warn{color:var(--dsw-alias-state-warning-primary,#d97706);font-size:11px;line-height:1.5}',
      '.btcd-bt-kpis{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px}',
      '.btcd-bt-kpi{background:var(--dsw-alias-bg-layer-2,#2b333b);border-radius:6px;padding:4px 6px;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.btcd-bt-kpi-label{font-size:10.5px;color:var(--dsw-alias-label-secondary,#98a2ad);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.btcd-bt-kpi b{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.btcd-bt-chartwrap{background:var(--dsw-alias-bg-layer-2,#2b333b);border-radius:6px;padding:4px}',
      '.btcd-btchart{display:block;width:100%;height:200px}',
      '.btcd-bt-trades{max-height:220px;overflow:auto;border-radius:6px}',
      '.btcd-bt-table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}',
      '.btcd-bt-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-overlay,#2b333b);color:var(--dsw-alias-label-secondary,#98a2ad);text-align:left;font-weight:600;padding:3px 4px;white-space:nowrap}',
      '.btcd-bt-table td{border-top:1px solid var(--dsw-alias-border-l1,#3a4149);padding:3px 4px;white-space:nowrap;vertical-align:top}',
      '.btcd-bt-table .btcd-bt-hint{font-size:10px}',
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
        // ⚠️ 这里**不要**再加 `visibilityState === 'hidden'` 之类的守卫。
        // 曾经有一版：`if (document.visibilityState === 'hidden') return;` ——
        // 意图是"标签页在后台就别刷了"，但只要环境的 visibilityState 不是 'visible'
        // （jsdom 报的是 'prerender'，某些内嵌视图/WebView 也会报别的值），
        // 这条守卫就**每次都命中**，整个面板从此不再重渲染 ——
        // 症状是"面板挂上去了，但时间读数停住、预警再也不刷新"，且没有任何报错。
        // 代价权衡：空转一个 setInterval 的开销，远小于"看板静默冻结"的代价。
        var timer = setInterval(function () { state[1](Date.now()); }, ms);
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

    // ------------------------------------------------------------------ 均线列表（支持增删改）
    //
    // 模型就是一条数组：`[{ id, period, color, show }, ...]`，默认 EMA20 + EMA480。
    // 之前是写死的两条（emaFast/emaSlow + showEma20/showEma480 两套状态），
    // 加一条就得动十几处；现在所有逻辑都按列表遍历，加几条都一样。

    var EMA_DEFAULT_COLORS = ['#f0b90b', '#a78bfa', '#4a8cff', '#2dd4bf', '#fb923c', '#ea3943', '#e879f9', '#94a3b8'];
    var EMA_MAX_LINES = 8;
    var EMA_DEFAULT_PERIODS = [20, 480];
    // 均线列表存哪儿：全局一份（跟周期无关，换 15m/1h 用的是同一组均线）
    var EMA_STORE_KEY = 'dsh-btc-dashboard:emas';

    /** 均线条目的新 id（够用即可：只要在这一次会话里唯一）。 */
    var emaSeq = 0;
    function emaNewId() {
      emaSeq += 1;
      return 'e' + String(Date.now().toString(36)) + String(emaSeq);
    }

    /** 给新均线挑个颜色：优先用还没被占的；占满了就按序号轮转。 */
    function emaPickColor(list) {
      var used = {};
      var i;
      for (i = 0; i < list.length; i += 1) if (list[i].color !== undefined) used[String(list[i].color)] = true;
      for (i = 0; i < EMA_DEFAULT_COLORS.length; i += 1) {
        if (used[EMA_DEFAULT_COLORS[i]] !== true) return EMA_DEFAULT_COLORS[i];
      }
      return EMA_DEFAULT_COLORS[list.length % EMA_DEFAULT_COLORS.length];
    }

    /**
     * 把随便什么输入（localStorage 里的旧值、用户传的）规范成一份合法的均线列表。
     * 规则：周期夹到 [2,2000]、最多 `EMA_MAX_LINES` 条、颜色缺失就分配、show 缺省为 true。
     * 空列表是**合法**的（用户可以把均线全删掉），所以这里不做"至少留一条"的兜底 ——
     * 但真要一条都没有时，UI 上会留一个"添加"入口让人加回来。
     *
     * id 的兜底生成器**必须每次都给出不同的值**：早先这里写的是 `function () { return 'e0' }`，
     * 于是默认列表两条的 id 一模一样，删除/修改只会命中第一条（测试直接抓到了）。
     */
    function normalizeEmas(input, nextId) {
      var src = Array.isArray(input) ? input : [];
      var idGen = typeof nextId === 'function' ? nextId : emaNewId;
      var out = [];
      for (var i = 0; i < src.length && out.length < EMA_MAX_LINES; i += 1) {
        var item = src[i];
        if (item === null || item === undefined) continue;
        var period = item.period;
        if (typeof period === 'string') period = parsePeriod(period, null);
        if (typeof period !== 'number' || !isFinite(period) || period < EMA_PERIOD_MIN) continue;
        out.push({
          id: typeof item.id === 'string' && item.id !== '' ? item.id : idGen(),
          period: Math.min(EMA_PERIOD_MAX, Math.round(period)),
          color: typeof item.color === 'string' && item.color !== '' ? item.color : emaPickColor(out),
          show: item.show !== false,
        });
      }
      return out;
    }

    /** 默认列表（首次打开、或读不出来时用）。id 交给 emaNewId，保证两条不同。 */
    function defaultEmas(nextId) {
      return normalizeEmas(
        EMA_DEFAULT_PERIODS.map(function (period) { return { period: period }; }),
        typeof nextId === 'function' ? nextId : emaNewId,
      );
    }

    /** 列表操作：纯函数，不改入参，方便离线断言。 */
    function emaAdd(list, period) {
      var current = Array.isArray(list) ? list : [];
      if (current.length >= EMA_MAX_LINES) return current;
      var used = {};
      var i;
      for (i = 0; i < current.length; i += 1) used[current[i].period] = true;
      // 没指定就给一个"还没被用过"的常用周期，省得新加出来是重复的
      var next = period;
      if (next === undefined || next === null) {
        var candidates = EMA_DEFAULT_PERIODS.concat([10, 30, 60, 120, 240, 720, 960]);
        for (i = 0; i < candidates.length; i += 1) {
          if (used[candidates[i]] !== true) { next = candidates[i]; break }
        }
        if (next === undefined) next = 20 + current.length * 10;
      }
      var item = {
        id: 'e' + String(Date.now().toString(36)) + String(current.length) + String(Math.floor(Math.random() * 1000)),
        period: Math.min(EMA_PERIOD_MAX, Math.max(EMA_PERIOD_MIN, Math.round(Number(next) || 20))),
        color: emaPickColor(current),
        show: true,
      };
      return current.concat([item]);
    }

    function emaRemove(list, id) {
      var out = [];
      for (var i = 0; i < (Array.isArray(list) ? list : []).length; i += 1) {
        if (list[i].id !== id) out.push(list[i]);
      }
      return out;
    }

    /** 改一条：`patch` 里可以有 period / color / show。周期不合法（<2）就忽略这一项。 */
    function emaUpdate(list, id, patch) {
      var out = [];
      for (var i = 0; i < (Array.isArray(list) ? list : []).length; i += 1) {
        var item = list[i];
        if (item.id !== id) { out.push(item); continue }
        var next = { id: item.id, period: item.period, color: item.color, show: item.show !== false };
        if (patch !== null && patch !== undefined) {
          if (patch.period !== undefined) {
            var period = typeof patch.period === 'string' ? parsePeriod(patch.period, null) : Math.round(Number(patch.period));
            if (typeof period === 'number' && isFinite(period) && period >= EMA_PERIOD_MIN) {
              next.period = Math.min(EMA_PERIOD_MAX, period);
            }
          }
          if (typeof patch.color === 'string' && patch.color !== '') next.color = patch.color;
          if (patch.show !== undefined) next.show = patch.show !== false;
        }
        out.push(next);
      }
      return out;
    }

    /** 图例/提示里用的名字。 */
    function emaLabel(item) {
      return 'EMA' + String(item === null || item === undefined ? '' : item.period);
    }

    /**
     * 「整条序列 + 窗口 + 周期」→ 这一帧要画的东西。
     * 均线在整条序列上现算，再按窗口切片，所以窗口停在哪儿，均线就跟到哪儿。
     */
    function emaWindow(candles, win, series) {
      var lines = [];
      for (var i = 0; i < series.length; i += 1) {
        lines.push({ item: series[i].item, series: series[i].series.slice(win.start, win.end) });
      }
      return { candles: candles.slice(win.start, win.end), lines: lines };
    }

    var EMA_PERIOD_MAX = 2000;
    var EMA_PERIOD_MIN = 2;
    var EMA_CACHE_MAX = 10;
    var emaCache = new Map();

    /**
     * 「整条序列 + 均线列表」→ `[{ item, series }, ...]`，带小型缓存。
     * 缓存键含载荷的 fetchedAt 与**每条线的周期与颜色**：拖动/缩放时反复要用，
     * 不必每次 mousemove 重算；但每次刷新（哪怕只有最后一根在动）都得重算。
     */
    function emaFor(candles, list, stamp) {
      var len = candles.length;
      var items = normalizeEmas(list, function () { return 'tmp'; });
      var key = String(len) + '|' + String(stamp === undefined || stamp === null ? 0 : stamp)
        + '|' + String(len === 0 ? 0 : candles[0][0])
        + '|' + String(len === 0 ? 0 : candles[len - 1][0])
        + '|' + items.map(function (it) { return String(it.period) + ':' + String(it.color); }).join(',');
      var hit = emaCache.get(key);
      if (hit !== undefined) return hit;
      var closes = closesOf(candles);
      var made = items.map(function (item) {
        return { item: item, series: emaSeries(closes, item.period) };
      });
      if (emaCache.size >= EMA_CACHE_MAX) emaCache.clear();
      emaCache.set(key, made);
      return made;
    }

    // ------------------------------------------------------------------ 收线预警
    //
    // 「当 K 线收线后收盘价穿过指定均线时提示我」。
    // 判定只在**收线**那一刻做（新出现一根 done 的 K 线），不是每 5 秒刷新都做 ——
    // 否则盘中价格来回穿，会反复弹提示，一点用都没有。

    var ALERT_STORE_KEY = 'dsh-btc-dashboard:alerts';
    var ALERT_LOG_KEY = 'dsh-btc-dashboard:alert-log';
    var ALERT_EVAL_KEY = 'dsh-btc-dashboard:alert-eval';
    var NOTIFY_STORE_KEY = 'dsh-btc-dashboard:notify';
    /** 邮件提醒的目标地址。**真身在宿主**（它才是发信方），这里只缓存一份供界面显示。 */
    var EMAIL_STORE_KEY = 'dsh-btc-dashboard:email';
    var ALERT_MAX = 6;
    // 预警记录：存最近这么多条（够回看，又不会把 localStorage 撑大）
    var ALERT_MAX_HISTORY = 60;
    // 判据日志：每次判定留一条，供排障（为什么没中）。比命中记录多，但都是小对象
    var ALERT_MAX_EVALS = 40;
    // 判定要用到"上一根"，所以至少要有这么多根 K 线才算得出来
    var ALERT_MIN_BARS = 3;
    /** "载荷没带 done"这件事只提醒一次，别每 5 秒刷一遍控制台 */
    var noDoneWarned = false;

    /**
     * 载荷健康度：预警能不能判，全看这几项。做成自检是为了"看得见" ——
     * 症状是"什么都不发生"时，没有自检就只能靠猜（真踩过：宿主少发一位 `done`，
     * 预警静默失效，查了很久都以为是判定逻辑的问题）。
     */
    function candleHealth(candles) {
      var list = Array.isArray(candles) ? candles : [];
      var withDone = 0;
      var doneCount = 0;
      var lastDoneIdx = -1;
      var lastDoneTs = null;
      for (var i = 0; i < list.length; i += 1) {
        var row = list[i];
        var flag = row === undefined || row === null ? undefined : row[6];
        var isFlag = flag === 0 || flag === 1 || flag === true || flag === false;
        if (isFlag) withDone += 1;
        if (isFlag && (flag === 1 || flag === true)) {
          doneCount += 1;
          lastDoneIdx = i;
          lastDoneTs = Number(row[0]);
        }
      }
      return {
        count: list.length,
        withDone: withDone,
        doneCount: doneCount,
        lastDoneIdx: lastDoneIdx,
        lastDoneTs: lastDoneTs,
        // 能不能判收线：每根都要带 done 标记，而且得存在一根"已收盘且有上一根"的
        // （下标 0 那根没有"上一根"，判不了穿越）
        ready: withDone === list.length && list.length >= ALERT_MIN_BARS && lastDoneIdx >= 1,
      };
    }

    // ------------------------------------------------------------------ 预警记录
    //
    // 每条命中都留一条记录，**存在 localStorage 里**（不是只活在内存里）：
    // 刷新页面、关掉看板再打开，记录都还在，用户可以随时清空。
    // 记的是"事实"（哪条规则、哪个周期、什么时候收的线、收盘价与均线值），
    // 不是文案 —— 文案是渲染时按当前格式拼的，这样以后改措辞不会让老记录变成一坨旧字符串。

    /** 一条记录的唯一键：规则 + 那根收线时刻。同一条规则同一根只记一次。 */
    function alertRecordKey(record) {
      return String(record === null || record === undefined ? '' : record.ruleId)
        + '@' + String(record === null || record === undefined ? '' : record.ts);
    }

    /** 把存下来的东西规范成记录列表（脏数据丢掉，不炸）。 */
    function normalizeAlertLog(input) {
      var src = Array.isArray(input) ? input : [];
      var out = [];
      for (var i = 0; i < src.length && out.length < ALERT_MAX_HISTORY; i += 1) {
        var item = src[i];
        if (item === null || item === undefined) continue;
        if (typeof item.text !== 'string' || item.text === '') continue;
        var ts = Number(item.ts);
        var at = Number(item.at);
        out.push({
          id: typeof item.id === 'string' && item.id !== '' ? item.id : alertRecordKey(item),
          ruleId: typeof item.ruleId === 'string' ? item.ruleId : '',
          text: item.text,
          dir: item.dir === 'down' ? 'down' : 'up',
          bar: typeof item.bar === 'string' ? item.bar : '',
          emaPeriod: typeof item.emaPeriod === 'number' && isFinite(item.emaPeriod) ? item.emaPeriod : null,
          close: typeof item.close === 'number' && isFinite(item.close) ? item.close : null,
          ema: typeof item.ema === 'number' && isFinite(item.ema) ? item.ema : null,
          ts: isFinite(ts) ? ts : 0,
          at: isFinite(at) ? at : 0,
        });
      }
      // 新的在前
      out.sort(function (a, b) { return b.at - a.at; });
      return out;
    }

    /**
     * 追加记录（纯函数）：新的在前、同一条规则同一根不重复记、超出上限丢最老的。
     * 返回新数组；没有可加的（全是重复）时**返回原数组**，调用方可以据此跳过写入。
     */
    function alertLogAdd(log, hits, at, bar) {
      var current = Array.isArray(log) ? log : [];
      var seen = {};
      for (var i = 0; i < current.length; i += 1) seen[current[i].id] = true;
      var fresh = [];
      var hitList = Array.isArray(hits) ? hits : [];
      for (var h = 0; h < hitList.length; h += 1) {
        var hit = hitList[h];
        if (hit === null || hit === undefined) continue;
        var id = alertRecordKey(hit);
        if (seen[id] === true) continue;
        seen[id] = true;
        fresh.push({
          id: id,
          ruleId: typeof hit.ruleId === 'string' ? hit.ruleId : '',
          text: String(hit.text),
          dir: hit.dir === 'down' ? 'down' : 'up',
          bar: typeof bar === 'string' ? bar : '',
          emaPeriod: typeof hit.emaPeriod === 'number' ? hit.emaPeriod : null,
          close: typeof hit.close === 'number' ? hit.close : null,
          ema: typeof hit.ema === 'number' ? hit.ema : null,
          ts: Number(hit.ts) || 0,
          at: at,
        });
      }
      if (fresh.length === 0) return current;
      return fresh.concat(current).slice(0, ALERT_MAX_HISTORY);
    }

    /** 记录里那根的收线时间（按周期粒度显示，日线不带时分）。 */
    function alertLogTime(record, barMs) {
      var ms = barMs === undefined || barMs === null ? 0 : barMs;
      return fmtTime(record.ts, ms, true);
    }

    // ------------------------------------------------------------------ 判据日志（dfx 用）
    //
    // 「为什么没中」是这类功能最难查的事：症状是"什么都没发生"。
    // 所以每次判定都留一条判据：那根的时间、收盘价、均线值、以及**为什么中/不中**。
    // 只读不改判定逻辑，纯观测。

    function normalizeEvalLog(input) {
      var src = Array.isArray(input) ? input : [];
      var out = [];
      for (var i = 0; i < src.length && out.length < ALERT_MAX_EVALS; i += 1) {
        var item = src[i];
        if (item === null || item === undefined) continue;
        if (typeof item.verdict !== 'string' || item.verdict === '') continue;
        out.push({
          at: isFinite(Number(item.at)) ? Number(item.at) : 0,
          bar: typeof item.bar === 'string' ? item.bar : '',
          idx: isFinite(Number(item.idx)) ? Number(item.idx) : null,
          ts: isFinite(Number(item.ts)) ? Number(item.ts) : null,
          verdict: item.verdict,
          ruleId: typeof item.ruleId === 'string' ? item.ruleId : '',
          emaPeriod: isFinite(Number(item.emaPeriod)) ? Number(item.emaPeriod) : null,
          dir: item.dir === 'down' ? 'down' : 'up',
          prevClose: isFinite(Number(item.prevClose)) ? Number(item.prevClose) : null,
          nowClose: isFinite(Number(item.nowClose)) ? Number(item.nowClose) : null,
          prevEma: isFinite(Number(item.prevEma)) ? Number(item.prevEma) : null,
          nowEma: isFinite(Number(item.nowEma)) ? Number(item.nowEma) : null,
        });
      }
      return out;
    }

    /** 一次判定的所有理由 → 若干条日志（新的在前），并裁剪到上限。 */
    function evalLogAdd(log, entry) {
      var current = Array.isArray(log) ? log : [];
      if (entry === null || entry === undefined) return current;
      return [entry].concat(current).slice(0, ALERT_MAX_EVALS);
    }

    /**
     * 把一次判定整理成"能贴给别人看"的多行文本（dfx 就是靠这段）。
     * 包含：载荷健康度、游标、规则、每条规则的判据与数字。
     */
    function formatEvalDiag(info) {
      var lines = [];
      var h = info === null || info === undefined ? null : info.health;
      lines.push('[BTC 看板 · 收线预警自检]');
      lines.push('时间: ' + new Date(info !== null && info.at !== undefined ? info.at : Date.now()).toLocaleString());
      lines.push('周期: ' + String(info === null || info.bar === null || info.bar === undefined ? '?' : info.bar)
        + ' | 规则数: ' + String(info === null || info.rules === undefined ? 0 : info.rules));
      if (h !== null && h !== undefined) {
        lines.push('载荷: K 线 ' + String(h.count) + ' 根，带 done ' + String(h.withDone)
          + '，已收盘 ' + String(h.doneCount) + '，就绪=' + String(h.ready === true));
        lines.push('最近一根已收盘: ' + (h.lastDoneTs === null || h.lastDoneTs === undefined
          ? '（没有）' : new Date(Number(h.lastDoneTs)).toLocaleString()));
      }
      lines.push('游标(lastClosedTs): ' + (info === null || info.cursor === null || info.cursor === undefined
        ? '（未登记）' : new Date(Number(info.cursor)).toLocaleString()));
      lines.push('确认新收线的次数(应判): ' + String(info === null || info.expect === undefined ? 0 : info.expect));
      lines.push('实际跑完判定的次数(判定): ' + String(info === null || info.fires === undefined ? 0 : info.fires));
      lines.push('（应判 > 判定 说明判定的那几根里有的失败了；应判不涨说明根本没看见新收线）');
      if (info !== null && info !== undefined && info.error !== undefined && info.error !== null) {
        lines.push('判定异常: ' + String(info.error));
      }
      var evals = info === null || !Array.isArray(info.evals) ? [] : info.evals;
      lines.push('判据（最近 ' + String(evals.length) + ' 条）:');
      if (evals.length === 0) lines.push('  （还没有判定过）');
      for (var i = 0; i < evals.length; i += 1) {
        var e = evals[i];
        lines.push('  ' + new Date(e.at).toLocaleString()
          + ' [' + String(e.bar) + '] EMA' + String(e.emaPeriod)
          + ' ' + (e.dir === 'down' ? '↓' : '↑')
          + ' → ' + e.verdict + '（' + verdictText(e.verdict) + '）'
          + (e.idx === null ? '' : ' #' + String(e.idx))
          + (e.ts === null ? '' : ' 收线 ' + new Date(e.ts).toLocaleString())
          + (e.prevClose === null ? '' : ' 前收 ' + String(e.prevClose) + '/前均 ' + String(e.prevEma))
          + (e.nowClose === null ? '' : ' 今收 ' + String(e.nowClose) + '/今均 ' + String(e.nowEma)));
      }
      return lines.join('\n');
    }

    // ------------------------------------------------------------------ 通知渠道
    //
    // 面板内的 toast / 常驻条是"看着屏幕才有用"。这里补两条能让人察觉的通道：
    //   * 桌面通知：标签页在后台也能弹系统通知（要用户授权，所以做成开关、按需申请）
    //   * 提示音：WebAudio 合成，不带音频文件（用一声 + 一记延长音，够醒目又不吵）
    // 两个都不改变"只在收线那一刻判一次"的语义，只是把同一件事讲给更多地方。

    /** 默认值：都开，但真正生效要用户授权 / 与页面交互过（浏览器策略） */
    function normalizeNotify(input) {
      var src = input !== null && typeof input === 'object' ? input : {};
      return {
        desktop: src.desktop !== false,
        sound: src.sound !== false,
      };
    }

    function notifyAvailable() {
      return typeof window !== 'undefined' && typeof window.Notification === 'function';
    }

    /** 当前授权状态：'granted' / 'denied' / 'default'（不支持时给 'unsupported'）。 */
    function notifyPermission() {
      if (notifyAvailable() !== true) return 'unsupported';
      return String(window.Notification.permission || 'default');
    }

    /** 弹一条桌面通知。没授权 / 不支持 → 返回 false（调用方不必当错误处理）。 */
    function sendDesktopNotice(title, body) {
      if (notifyAvailable() !== true) return false;
      if (notifyPermission() !== 'granted') return false;
      try {
        var n = new window.Notification(String(title), { body: String(body), tag: 'dsh-btc-alert' });
        if (n === null || n === undefined) return false;
        // 点通知就把用户带回这个标签页
        n.onclick = function () {
          try {
            if (typeof window.focus === 'function') window.focus();
            n.close();
          } catch (error) { /* 关不掉就算了 */ }
        };
        return true;
      } catch (error) {
        return false;
      }
    }

    var audioCtx = null;

    /**
     * 一声提示音（WebAudio 合成，两声：短促 + 略低）。
     * 浏览器的自动播放策略要求页面被交互过，否则 AudioContext 会是 suspended ——
     * 所以这里返回 false 表示"没响"，由调用方决定要不要说明。
     */
    function playAlertSound() {
      if (typeof window === 'undefined') return false;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (typeof Ctor !== 'function') return false;
      try {
        if (audioCtx === null) audioCtx = new Ctor();
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') audioCtx.resume();
        var now = audioCtx.currentTime;
        var beep = function (at, freq, dur) {
          var osc = audioCtx.createOscillator();
          var gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, at);
          // 淡入淡出，避免"咔"的爆音
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(0.18, at + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(at);
          osc.stop(at + dur + 0.02);
        };
        beep(now, 880, 0.12);
        beep(now + 0.16, 660, 0.18);
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * 复制文本到剪贴板。`navigator.clipboard` 在非安全上下文里没有，退回 `execCommand`
     * （已废弃但到处都还支持），两条都不行就返回 false，由调用方提示用户自己抄。
     */
    function copyToClipboard(text) {
      var value = String(text);
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined
          && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(value).then(function () { return true; })
            .catch(function () { return false; });
        }
      } catch (error) { /* 落到下面的兜底 */ }
      try {
        if (typeof document === 'undefined') return Promise.resolve(false);
        var area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(area);
        return Promise.resolve(ok === true);
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    // ------------------------------------------------------------------ 预警的共享存储
    //
    // 预警要**常驻执行**：不管看板开不开，只要插件挂着就得盯着收线。
    // 所以判定引擎的输入不能放在 Dashboard 的 state 里 —— 看板一关，那些 state 就没了。
    // 这里做一个模块级的单例存储：侧边栏按钮（常驻）与看板（按需）订阅同一份数据。
    // 用的是"订阅 + 快照"模式，两个组件看到的永远是同一份，不会各存一份互相同步。
    var ALERT_STORE = {
      alerts: [],
      notify: null,
      log: [],
      evals: [],
      unread: 0,
      // 邮件配置：真身在宿主，这里缓存一份（面板要显示、引擎要判"开没开"）。
      // `available` 表示宿主的 qqEmail 服务在不在 —— 不在时界面要给可执行的提示。
      email: { enabled: false, to: '', confirmed: '', authorized: false, available: false, confirmedAt: null, lastSentAt: null, lastError: null, sentCount: 0 },
      meta: { expect: 0, fires: 0, at: null, reason: '', health: null, error: null, lastBar: null, hits: 0 },
    };
    var alertStoreListeners = new Set();
    var alertStoreSnapshot = 0;
    var alertStoreLoaded = false;

    function alertStoreGet(key) {
      if (key === undefined) return ALERT_STORE;
      return ALERT_STORE[key];
    }

    /** 改一处或几处（传对象就是批量），然后通知所有订阅者。 */
    function alertStoreSet(patch) {
      if (patch === null || patch === undefined) return;
      var changed = false;
      for (var key in patch) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        if (Object.is(ALERT_STORE[key], patch[key])) continue;
        ALERT_STORE[key] = patch[key];
        changed = true;
      }
      if (changed !== true) return;
      alertStoreSnapshot += 1;
      alertStoreListeners.forEach(function (fn) { fn(); });
    }

    function alertStoreSubscribe(fn) {
      alertStoreListeners.add(fn);
      return function () { alertStoreListeners.delete(fn); };
    }

    /**
     * 从 localStorage 读一次，把规则 / 记录 / 判据 / 通知开关装进存储。
     * 两个视图（侧边栏按钮、看板）挂载时都会调它 —— 谁先挂载谁把它填上；
     * 之后的重叠调用只是重读一遍同样的数据（幂等），不会覆盖内存里的新内容，
     * 因为任何改动都会立刻写回 localStorage。
     */
    function alertStoreLoad() {
      var rawAlerts = loadStored(ALERT_STORE_KEY, null);
      var rawLog = loadStored(ALERT_LOG_KEY, null);
      var rawEvals = loadStored(ALERT_EVAL_KEY, null);
      var rawNotify = loadStored(NOTIFY_STORE_KEY, null);
      var patch = { notify: normalizeNotify(rawNotify) };
      patch.alerts = rawAlerts === null || rawAlerts === undefined ? [] : normalizeAlerts(rawAlerts, '');
      patch.log = rawLog === null || rawLog === undefined ? [] : normalizeAlertLog(rawLog);
      patch.evals = rawEvals === null || rawEvals === undefined ? [] : normalizeEvalLog(rawEvals);
      // 邮件：本地只缓存了界面用的那几个字段，权威值靠 `pullEmailConfig()` 从宿主对齐
      var cachedEmail = loadStored(EMAIL_STORE_KEY, null);
      if (cachedEmail !== null && cachedEmail !== undefined) patch.email = normalizeEmail(cachedEmail);
      alertStoreSet(patch);
    }

    /**
     * 订阅预警存储。`useSyncExternalStore` 拿不到时退回 useState（老 React 也能跑）。
     * 第三个参数（服务端快照）**必须给**：SSR 渲染时缺它会直接抛
     * "Missing getServerSnapshot"。服务端和首次客户端渲染都返回同一份初始快照，
     * 所以不会出现水合不一致。
     */
    function useAlertStore(key) {
      var sub = React.useSyncExternalStore;
      if (typeof sub === 'function') {
        var read = function () { return alertStoreGet(key); };
        return sub(alertStoreSubscribe, read, read);
      }
      var state = React.useState(function () { return alertStoreGet(key); });
      React.useEffect(function () {
        return alertStoreSubscribe(function () { state[1](alertStoreGet(key)); });
      }, [key]);
      return state[0];
    }

    /**
     * 把预警存储写回 localStorage。任何一处改动都走这里 ——
     * 侧边栏按钮持有引擎，它卸载基本意味着插件卸载，所以不存在"谁来收尾"的问题。
     */
    var alertStoreSaved = {};
    function alertStorePersist() {
      var pairs = [
        [ALERT_STORE_KEY, ALERT_STORE.alerts],
        [ALERT_LOG_KEY, ALERT_STORE.log],
        [ALERT_EVAL_KEY, ALERT_STORE.evals],
        [NOTIFY_STORE_KEY, ALERT_STORE.notify],
      ];
      for (var i = 0; i < pairs.length; i += 1) {
        var text = JSON.stringify(pairs[i][1]);
        if (alertStoreSaved[pairs[i][0]] === text) continue;
        alertStoreSaved[pairs[i][0]] = text;
        saveStored(pairs[i][0], pairs[i][1]);
      }
    }

    // ------------------------------------------------------------------ 预警邮件
    //
    // 发信在**宿主半**（它才有 `ctx.qqEmail`），这里负责：填地址 / 授权确认 / 命中时通知宿主。
    // 授权时机在"用户填地址"那一步；之后每封自动预警只发往已确认的那个地址。
    // 宿主那边为什么不用 DSH 的 approval：见 index.js 里"确认模型"那段说明
    // （approval.request() 要求打开的 turn，而预警是自动触发的，没有 turn 可依附）。

    /**
     * 邮件通道依赖 `dsh-qq-email` 插件（**可选依赖**）：没有它时本插件照常启动、其它功能不受影响。
     * 只在用户真的要开邮件提醒时才给出这条可执行提示 —— 去哪装、装完要做什么、哪些功能不受影响。
     */
    var EMAIL_MISSING_PLUGIN_HINT = '邮件提醒需要 dsh-qq-email 插件（在「插件 → 发现 / Discover」里可安装）：装好并启用后重启宿主即可用；不装它不影响看板、均线、回测等其它功能。';
    var EMAIL_MISSING_PLUGIN_STATE = '⚠️ 邮件提醒不可用：需要先安装并启用 dsh-qq-email 插件（插件市场「发现 / Discover」可搜到），装完重启宿主；桌面通知/提示音不受影响。';

    /** 邮件配置的规范化（本地缓存这份；宿主的权威值通过 /email 接口对齐）。 */
    function normalizeEmail(input) {
      var source = input !== null && typeof input === 'object' ? input : {};
      return {
        enabled: source.enabled === true,
        to: typeof source.to === 'string' ? source.to : '',
        confirmed: typeof source.confirmed === 'string' ? source.confirmed : '',
        authorized: source.authorized === true,
        available: source.available === true,
        confirmedAt: isFinite(Number(source.confirmedAt)) && source.confirmedAt !== null
          ? Number(source.confirmedAt) : null,
        lastSentAt: isFinite(Number(source.lastSentAt)) && source.lastSentAt !== null
          ? Number(source.lastSentAt) : null,
        lastError: typeof source.lastError === 'string' ? source.lastError : null,
        sentCount: isFinite(Number(source.sentCount)) ? Number(source.sentCount) : 0,
      };
    }

    /** 从宿主读回邮件配置，写进共享存储（权威值以宿主为准）。 */
    function pullEmailConfig() {
      return fetchJson('/email').then(function (res) {
        if (res !== null && res.ok === true && res.email !== undefined) {
          alertStoreSet({ email: normalizeEmail(res.email) });
          saveStored(EMAIL_STORE_KEY, alertStoreGet('email'));
        }
        return alertStoreGet('email');
      }).catch(function () {
        return alertStoreGet('email');
      });
    }

    /**
     * 保存邮件配置到宿主。
     * `confirm: true` 表示用户已在界面上确认过这个地址 —— 只有带上它，
     * 宿主才会把地址记成"已确认"并允许后续自动发信。
     */
    function saveEmailConfig(patch, confirm) {
      var body = { enabled: patch.enabled === true, confirm: confirm === true };
      // **只有真的填了地址才传 to** —— 关掉开关时不要把地址带成空串，
      // 那会让后端把已存的地址当成"这次没提交地址"（虽然前端也有兜底，但别在两头都挖坑）。
      if (typeof patch.to === 'string' && patch.to.trim() !== '') body.to = patch.to.trim();
      var fail = function (error) {
        var text = String((error && error.message) || error);
        alertStoreSet({ email: Object.assign({}, alertStoreGet('email'), { lastError: text }) });
        return { ok: false, email: alertStoreGet('email'), needsConfirm: false, error: text };
      };
      // ⚠️ **必须有 catch**：没有它的话，fetch 失败或 .then 里抛异常会让调用方的
      // `setEmailBusy(false)` 永远执行不到 —— 按钮卡在 disabled，表现为"点一下变灰、
      // 再也点不动"（真踩过）。同时未处理的 rejection 会打到 window，测试抓得到。
      return fetchJson('/email', { method: 'POST', body: JSON.stringify(body) })
        .then(function (res) {
          if (res !== null && res.ok === true && res.email !== undefined) {
            var view = normalizeEmail(res.email);
            var current = alertStoreGet('email');
            // 后端这次没带地址时不要把地址抹成空 —— `normalizeEmail` 缺字段就给空串，
            // 直接覆盖会让"地址丢失"，这跟用户报过的"再次打开邮箱丢了"是同一类问题。
            if (view.to === '' && current.to !== '') view.to = current.to;
            alertStoreSet({ email: view });
            saveStored(EMAIL_STORE_KEY, view);
            return { ok: true, email: view, needsConfirm: false, error: null };
          }
          var error = res === null || res.error === undefined ? '保存失败' : String(res.error);
          var needsConfirm = res !== null && res.needsConfirm === true;
          // 保存失败也要让界面看到原因（比如"没找到 qqEmail 服务"）
          alertStoreSet({ email: Object.assign({}, alertStoreGet('email'), { lastError: error }) });
          return { ok: false, email: alertStoreGet('email'), needsConfirm: needsConfirm, error: error };
        })
        .catch(fail);
    }

    /**
     * 发一封**测试**邮件（面板「试一下」用）。
     * 走同一个后端路由，只是带 `test: true` 让宿主用一份示例行情组正文 ——
     * 这样测试邮件长什么样，跟真实预警邮件一模一样，不会"测通了但真预警是另一封"。
     * 测试邮件同样只发往**已确认地址**，不额外开口子。
     */
    function sendTestEmail() {
      return fetchJson('/notify-email', {
        method: 'POST',
        body: JSON.stringify({ test: true, at: Date.now() }),
      }).then(function (res) {
        if (res !== null && res.ok === true) {
          return { ok: true, error: null, to: res.to };
        }
        var error = res === null || res.error === undefined ? '发送失败' : String(res.error);
        var skipped = res === null || res.skipped === undefined ? null : String(res.skipped);
        return { ok: false, error: error, skipped: skipped };
      }).catch(function (error) {
        return { ok: false, error: String((error && error.message) || error), skipped: null };
      });
    }

    /** 命中时把预警信息交给宿主发信。宿主会自己再校验"开关 + 已确认地址"。 */
    function sendAlertEmailOnce(payload) {
      return fetchJson('/notify-email', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (res) {
          if (res !== null && res.ok === true) {
            alertStoreSet({
              email: Object.assign({}, alertStoreGet('email'), {
                lastSentAt: Date.now(),
                lastError: null,
                sentCount: alertStoreGet('email').sentCount + 1,
              }),
            });
            saveStored(EMAIL_STORE_KEY, alertStoreGet('email'));
            return { ok: true, error: null };
          }
          var error = res === null || res.error === undefined ? '发送失败' : String(res.error);
          var skipped = res === null || res.skipped === undefined ? null : String(res.skipped);
          var email = alertStoreGet('email');
          // "没开"/"没授权"不是错误，是正常的跳过；只有真失败才记 lastError
          alertStoreSet({
            email: Object.assign({}, email, {
              lastError: skipped === null ? error : email.lastError,
              available: skipped === 'no-service' ? false : email.available,
            }),
          });
          return { ok: false, error: error, skipped: skipped };
        })
        .catch(function (error) {
          var text = String((error && error.message) || error);
          alertStoreSet({
            email: Object.assign({}, alertStoreGet('email'), { lastError: text }),
          });
          return { ok: false, error: text, skipped: null };
        });
    }

    /**
     * 把一次命中整理成发信用的载荷：**规则 / 周期 / 那根 K 线的数据**。
     * 只做数据搬运，文案与排版都在宿主那边（宿主才知道邮件长什么样）。
     */
    function alertEmailPayload(hit, bar, candles, idx, instId, rules) {
      var candle = Array.isArray(candles) && idx >= 0 && idx < candles.length ? candles[idx] : null;
      return {
        rule: (hit.dir === 'down' ? '收盘下穿' : '收盘上穿') + ' EMA' + String(hit.emaPeriod),
        bar: bar === null || bar === undefined ? '' : String(bar),
        text: typeof hit.text === 'string' ? hit.text : '',
        ts: isFinite(Number(hit.ts)) ? Number(hit.ts) : null,
        instId: typeof instId === 'string' ? instId : '',
        price: { close: hit.close === undefined ? null : hit.close, ema: hit.ema === undefined ? null : hit.ema },
        candle: candle === null ? null : {
          t: Number(candle[0]), o: Number(candle[1]), h: Number(candle[2]),
          l: Number(candle[3]), c: Number(candle[4]), v: Number(candle[5]),
        },
        rules: Array.isArray(rules) ? rules.map(function (one) {
          return { dir: one.dir, emaPeriod: one.emaPeriod, bar: one.bar, on: one.on !== false };
        }) : [],
      };
    }

    /**
     * 常驻的收线判定引擎（一个**只渲染 null 的组件**）。
     *
     * 关键点：它挂在**始终挂载的侧边栏按钮**上，看板开不开都在跑 ——
     * 所以关掉看板、切到别的标签页，规则照样在盯，桌面通知和提示音照样响。
     * 判定所需的数据由它自己取（每个"有规则的周期"各拉一次），不依赖看板是否打开。
     * 看板只是它产出的数据（`ALERT_STORE`）的一个视图。
     *
     * 为什么做成组件而不是 hook：它要在 `shell.overlay`（按需挂载）之外也活着；
     * 而且这样"引擎在不在跑"可以直接在界面上验证，不靠推断。
     */
    function AlertEngine() {
      var alerts = useAlertStore('alerts');
      // 挂载后再读一次盘：`apply()` 那一刻 window/localStorage 未必就绪
      // （模块是在一个受控环境里求值的），所以真正的"首次装载"放在这里更稳。
      React.useEffect(function () {
        alertStoreLoad();
        // 邮件配置以宿主为准（它才是发信方），拉一次对齐本地缓存
        pullEmailConfig();
      }, []);
      var bars = {};
      var barList = [];
      for (var i = 0; i < alerts.length; i += 1) {
        var b = alerts[i].bar;
        if (b === '' || bars[b] === true) continue;
        bars[b] = true;
        barList.push(b);
      }
      var barKey = barList.join(',');
      // 各周期的载荷与游标都放在 ref 里：它们是引擎的工作数据，不需要触发重渲染
      var dataRef = React.useRef({ boards: {}, cursors: {}, expect: 0, fires: 0 });
      React.useEffect(function () {
        if (barKey === '') return undefined;
        var alive = true;
        var list = barKey.split(',');
        function pull() {
          for (var k = 0; k < list.length; k += 1) {
            (function (oneBar) {
              fetchJson('/board?bar=' + encodeURIComponent(oneBar) + '&limit=' + String(FETCH_LIMIT))
                .then(function (res) {
                  if (!alive || res === null || res.ok !== true) return;
                  dataRef.current.boards[oneBar] = res;
                  var patch = runAlertEngine(dataRef.current, oneBar, res, alertStoreGet('alerts'), alertStoreGet('notify'));
                  if (patch !== null) {
                    alertStoreSet(patch);
                    alertStorePersist();
                  }
                })
                .catch(function () { /* 单次失败忽略，下一轮再来 */ });
            })(list[k]);
          }
        }
        pull();
        var timer = setInterval(pull, REFRESH_MS);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [barKey]);
      return null;
    }

    /**
     * 跑一次收线判定（纯逻辑 + 副作用分开：返回值是要写进存储的 patch，通知/声音在这里直接发）。
     *
     * `engine` 是引擎的工作数据 `{ boards, cursors, expect, fires }`（存在 ref 里）。
     * 返回 `null` 表示这次没有新收线、什么都不用改。
     *
     * **这里刻意不依赖任何组件 state**：它由常驻的侧边栏按钮驱动，
     * 所以看板开不开都不影响它。
     */
    function runAlertEngine(engine, oneBar, board, alerts, notify) {
      if (board === null || board === undefined) return null;
      var candles = Array.isArray(board.candles) ? board.candles : [];
      var health = candleHealth(candles);
      var prevReason = engine.reason === undefined ? '' : engine.reason;
      var lastCursor = engine.cursors[oneBar] === undefined ? null : engine.cursors[oneBar];
      function metaOf(reason, cursor, extra) {
        return {
          expect: engine.expect, fires: engine.fires, at: Date.now(), reason: reason,
          health: health, cursor: cursor, error: null, lastBar: null, hits: 0, bar: oneBar,
          previousReason: prevReason,
        };
      }
      // 顺序很重要：**缺 done 是硬阻塞**，不管有没有规则都该先说它
      if (health.ready !== true) {
        engine.reason = 'no-done';
        return { meta: metaOf('no-done', lastCursor, null) };
      }
      var mine = [];
      for (var i = 0; i < alerts.length; i += 1) if (alerts[i].bar === oneBar) mine.push(alerts[i]);
      if (mine.length === 0) {
        engine.reason = 'no-rules';
        return { meta: metaOf('no-rules', lastCursor, null) };
      }
      var cursor = closedAlertCursor(candles, lastCursor);
      if (cursor === null) {
        engine.reason = 'waiting';
        return { meta: metaOf('waiting', lastCursor, null) };
      }
      // 第一次只登记游标：刚装上插件不该把历史上最后一次穿越报成"刚刚发生"
      if (cursor.fresh !== true) {
        engine.cursors[oneBar] = cursor.ts;
        engine.reason = 'armed';
        return { meta: metaOf('armed', cursor.ts, null) };
      }
      engine.cursors[oneBar] = cursor.ts;
      engine.expect += 1;
      var lines;
      var verdicts = [];
      var skipped = [];
      var hits = [];
      var failed = null;
      try {
        lines = emaFor(candles, mine.map(function (a) {
          return { id: 'a' + a.id, period: a.emaPeriod, color: '#000000', show: true };
        }), board.fetchedAt);
        var outcome = evalAlerts(mine, candles, lines, cursor.idx, oneBar, digitsOf(candles[cursor.idx][4]));
        hits = outcome.hits;
        verdicts = outcome.verdicts;
        skipped = outcome.skipped;
        engine.fires += 1;
      } catch (error) {
        failed = String((error && error.message) || error);
        if (typeof console !== 'undefined' && console.error !== undefined) {
          console.error('[btcd] 收线预警判定失败', error);
        }
      }
      // 判据：参与判定的每条规则一条；被跳过的也记原因；抛错本身也记一条
      var at0 = Date.now();
      var entries = [];
      for (var vi = 0; vi < verdicts.length; vi += 1) {
        var v = verdicts[vi];
        entries.push({
          at: at0, bar: oneBar, idx: v.idx, ts: v.ts, verdict: v.verdict,
          ruleId: v.ruleId, emaPeriod: v.emaPeriod, dir: v.dir,
          prevClose: v.prevClose, nowClose: v.nowClose, prevEma: v.prevEma, nowEma: v.nowEma,
        });
      }
      for (var si = 0; si < skipped.length; si += 1) {
        entries.push({
          at: at0, bar: oneBar, idx: cursor.idx, ts: cursor.ts,
          verdict: skipped[si].verdict === 'not-this-bar' ? 'other-bar' : skipped[si].verdict,
          ruleId: skipped[si].ruleId, emaPeriod: null, dir: 'up',
          prevClose: null, nowClose: null, prevEma: null, nowEma: null,
        });
      }
      if (entries.length === 0) {
        entries.push({
          at: at0, bar: oneBar, idx: cursor.idx, ts: cursor.ts,
          verdict: failed === null ? 'no-current-bar-rule' : 'failed',
          ruleId: '', emaPeriod: null, dir: 'up', note: failed,
          prevClose: null, nowClose: null, prevEma: null, nowEma: null,
        });
      }
      var nextEvals = alertStoreGet('evals');
      for (var ei = 0; ei < entries.length; ei += 1) nextEvals = evalLogAdd(nextEvals, entries[ei]);
      if (failed !== null) {
        engine.reason = 'failed';
        var patchFail = { evals: nextEvals, meta: metaOf('failed', cursor.ts, null) };
        patchFail.meta.error = failed;
        return patchFail;
      }
      // 命中：写记录 + 三条通道（面板 toast 由看板自己看 unread，这里只管常驻的两条）
      var patch = { evals: nextEvals };
      if (hits.length === 0) {
        engine.reason = 'checked';
        patch.meta = metaOf('checked', cursor.ts, null);
        return patch;
      }
      engine.reason = 'hit';
      var at = Date.now();
      patch.log = alertLogAdd(alertStoreGet('log'), hits, at, oneBar);
      var unread = alertStoreGet('unread') + hits.length;
      patch.unread = unread;
      patch.meta = metaOf('hit', cursor.ts, null);
      patch.meta.hits = hits.length;
      patch.meta.lastBar = cursor.ts;
      // 常驻提醒的两条通道。看板开着时也会弹 toast（它自己订阅 unread/log）。
      if (notify !== null && notify.desktop === true) {
        for (var hi = 0; hi < hits.length; hi += 1) {
          sendDesktopNotice(
            instShort(board.instId) + ' ' + oneBar + ' 收线预警 · ' + alertDirInfo(hits[hi].dir).label,
            hits[hi].text + '（OKX ' + (board.instId || 'BTC-USDT-SWAP') + '）',
          );
        }
      }
      if (notify !== null && notify.sound === true) playAlertSound();
      // 邮件：交给宿主发（它才有 ctx.qqEmail）。宿主自己再校验"开着 + 地址已确认"，
      // 这里只负责把载荷递过去；失败会写进 email.lastError，面板上看得见。
      var email = alertStoreGet('email');
      if (email !== null && email.enabled === true) {
        for (var mi = 0; mi < hits.length; mi += 1) {
          sendAlertEmailOnce(alertEmailPayload(hits[mi], oneBar, candles, cursor.idx, board.instId, alerts));
        }
      }
      return patch;
    }

    /** 预警的方向：收盘价上穿 / 下穿均线。 */
    var ALERT_DIRS = [
      { id: 'up', label: '收盘上穿', arrow: '↑', text: '收线上穿' },
      { id: 'down', label: '收盘下穿', arrow: '↓', text: '收线下穿' },
    ];

    function alertDirInfo(id) {
      for (var i = 0; i < ALERT_DIRS.length; i += 1) if (ALERT_DIRS[i].id === id) return ALERT_DIRS[i];
      return ALERT_DIRS[0];
    }

    function alertNewId() {
      alertSeq += 1;
      return 'a' + String(Date.now().toString(36)) + String(alertSeq);
    }
    var alertSeq = 0;

    /**
     * 把存下来的东西规范成预警规则列表。
     *
     * **周期字段 `bar` 只保留原值，绝不用"当前周期"去补**：
     * 早先这里写的是"没有 bar 就填传进来的当前周期"，结果规则会被重绑到当时的周期上 ——
     * 在 3m 建的规则切到 15m 就变成绑 15m，看起来像"跟着周期跑"。现在的语义是：
     * 每条规则**固定绑在它被创建时的周期**上；真拿不到周期（面板还没取到数）就记空串，
     * 那条规则哪个周期都不判、在面板里显示"周期未知"，由用户删掉重加。
     */
    function normalizeAlerts(input, bar, nextId) {
      var src = Array.isArray(input) ? input : [];
      var idGen = typeof nextId === 'function' ? nextId : alertNewId;
      var out = [];
      for (var i = 0; i < src.length && out.length < ALERT_MAX; i += 1) {
        var item = src[i];
        if (item === null || item === undefined) continue;
        var period = item.emaPeriod;
        if (typeof period === 'string') period = parsePeriod(period, null);
        if (typeof period !== 'number' || !isFinite(period) || period < EMA_PERIOD_MIN) continue;
        out.push({
          id: typeof item.id === 'string' && item.id !== '' ? item.id : idGen(),
          emaPeriod: Math.min(EMA_PERIOD_MAX, Math.round(period)),
          dir: item.dir === 'down' ? 'down' : 'up',
          bar: typeof item.bar === 'string' ? item.bar : '',
          on: item.on !== false,
        });
      }
      return out;
    }

    /**
     * 收线穿越判定，**并把判据一起返回**（这是排障要的）。
     *
     * `idx` 是刚收线那根的下标，`series` 是那条均线的整条序列。判定条件：
     *   上一根收盘在均线**另一侧**（或刚好相等），这一根收盘到了这一侧 →
     *   也就是"穿过去了"。只在同一侧来回晃不算穿越。
     *
     * 返回值：`{ verdict, ... }`。`verdict === 'hit'` 时额外带 `hit`（给用户看的那句话）。
     * 其它 verdict 说明**为什么没中**，看板把每一条都列出来，省得靠猜：
     *   off / no-rule / bad-index / bad-candle / no-ema / bad-close / side-same / side-crossed-wrong-way
     */
    function evalAlertVerdict(rule, candles, series, idx, digits) {
      if (rule === null || rule === undefined) return { verdict: 'no-rule' };
      if (rule.on === false) return { verdict: 'off' };
      if (!Array.isArray(candles) || !Array.isArray(series)) return { verdict: 'bad-candle' };
      if (idx === null || idx === undefined || idx < 1 || idx >= candles.length) {
        return { verdict: 'bad-index', idx: idx === undefined ? null : idx };
      }
      var now = candles[idx];
      var prev = candles[idx - 1];
      if (now === undefined || prev === undefined) return { verdict: 'bad-candle' };
      var nowEma = series[idx];
      var prevEma = series[idx - 1];
      var base = {
        idx: idx,
        ts: Number(now[0]),
        emaPeriod: rule.emaPeriod,
        dir: rule.dir === 'down' ? 'down' : 'up',
        nowClose: Number(now[4]),
        prevClose: Number(prev[4]),
        nowEma: nowEma === undefined ? null : nowEma,
        prevEma: prevEma === undefined ? null : prevEma,
      };
      if (nowEma === null || nowEma === undefined || prevEma === null || prevEma === undefined) {
        // 均线还没预热出来：这条均线的周期比序列还长（比如刚加了一条 EMA480 而序列不够）
        return Object.assign(base, { verdict: 'no-ema' });
      }
      if (!isFinite(base.nowClose) || !isFinite(base.prevClose)) {
        return Object.assign(base, { verdict: 'bad-close' });
      }
      var up = rule.dir !== 'down';
      var wasOtherSide = up ? base.prevClose <= prevEma : base.prevClose >= prevEma;
      var isThisSide = up ? base.nowClose > nowEma : base.nowClose < nowEma;
      if (wasOtherSide !== true) {
        // 上一根就已经在这边了：没有"穿"的动作
        return Object.assign(base, { verdict: 'side-same' });
      }
      if (isThisSide !== true) {
        // 这一根又回到另一边（或者没过去）—— 方向不对
        return Object.assign(base, { verdict: 'side-crossed-wrong-way' });
      }
      var d = digits === undefined || digits === null ? digitsOf(base.nowClose) : digits;
      var hit = {
        ruleId: rule.id,
        ts: base.ts,
        dir: up ? 'up' : 'down',
        emaPeriod: rule.emaPeriod,
        close: base.nowClose,
        ema: base.nowEma,
        text: ALERT_DIRS[up ? 0 : 1].text + ' EMA' + String(rule.emaPeriod)
          + ' · 收盘 ' + fmtPrice(base.nowClose, d) + ' / 均线 ' + fmtPrice(base.nowEma, d),
      };
      return Object.assign(base, { verdict: 'hit', hit: hit });
    }

    /** 兼容旧签名：只关心"中没中"。 */
    function evalAlert(rule, candles, series, idx, digits) {
      var out = evalAlertVerdict(rule, candles, series, idx, digits);
      return out.verdict === 'hit' ? out.hit : null;
    }

    /** 判据文字：给看板/导出用的人话。 */
    var VERDICT_TEXT = {
      hit: '命中：穿过去了',
      off: '规则已暂停',
      'no-rule': '没有规则',
      'bad-index': '收线那根的下标不合法',
      'bad-candle': 'K 线数据不完整',
      'no-ema': '均线还没预热出值（这条均线的周期比已有序列还长）',
      'bad-close': '收盘价不是数字',
      'side-same': '上一根就已经在均线这一侧了 —— 没有"穿"的动作',
      'side-crossed-wrong-way': '这一根没穿过去（同一侧或又折回去了）',
      'no-current-bar-rule': '没有启用中的、绑在当前周期的规则',
      'other-bar': '规则绑的是别的周期，本次不判',
      'not-advanced': '还没有新的收线（同一根之内不算）',
      'first-seen': '第一次见到这根：只登记游标，不判定',
      failed: '判定过程抛错了（详情见控制台 / 自检块）',
    };

    function verdictText(code) {
      var text = VERDICT_TEXT[code];
      return text === undefined ? String(code) : text;
    }

    /**
     * 把判据按"收线时刻"分组。
     *
     * 一次收线会给每条规则各写一条判据（两条规则就是两条），逐条平铺看起来像重复。
     * 按根分组之后：这一根收在什么价、均线在哪、每条规则各自的结论一目了然；
     * 而且**这一根到上一根隔了多久**也直接看得出来 —— "中间少了几分钟"就是靠这个查的。
     * 返回新的在前，每项 `{ key, ts, at, bar, idx, prevClose, nowClose, prevEma, nowEma, items }`。
     */
    function groupVerdicts(log) {
      var list = Array.isArray(log) ? log : [];
      var order = [];
      var byKey = {};
      for (var i = 0; i < list.length; i += 1) {
        var e = list[i];
        if (e === null || e === undefined) continue;
        var key = String(e.ts === null || e.ts === undefined ? 'no-ts' : e.ts) + '|' + String(e.bar);
        if (byKey[key] === undefined) {
          byKey[key] = {
            key: key, ts: e.ts, at: e.at, bar: e.bar, idx: e.idx,
            prevClose: e.prevClose, nowClose: e.nowClose,
            prevEma: e.prevEma, nowEma: e.nowEma, items: [],
          };
          order.push(key);
        }
        var group = byKey[key];
        group.items.push(e);
        // 同一次判定里每条规则的数字都一样，取第一个有值的补全
        if (group.nowClose === null && e.nowClose !== null) group.nowClose = e.nowClose;
        if (group.prevClose === null && e.prevClose !== null) group.prevClose = e.prevClose;
        if (group.nowEma === null && e.nowEma !== null) group.nowEma = e.nowEma;
        if (group.prevEma === null && e.prevEma !== null) group.prevEma = e.prevEma;
      }
      var out = [];
      for (var k = 0; k < order.length; k += 1) out.push(byKey[order[k]]);
      return out;
    }

    /**
     * 相邻两次收线之间隔了多久（毫秒），拿不到返回 null。
     * 断档通常意味着**看板当时没开着**（判定只在看板打开时跑），标出来就不会被误当成故障。
     */
    function verdictGapMs(groups, index) {
      var list = Array.isArray(groups) ? groups : [];
      var cur = list[index];
      var prev = list[index + 1];
      if (cur === undefined || prev === undefined) return null;
      if (cur.ts === null || cur.ts === undefined || prev.ts === null || prev.ts === undefined) return null;
      var gap = Number(cur.ts) - Number(prev.ts);
      return isFinite(gap) && gap > 0 ? gap : null;
    }

    /**
     * 一次刷新要判的所有预警：只判**当前周期的、开着的**规则。
     * `idx` 传刚收线那一根的下标。
     * 返回 `{ hits, verdicts, skipped }`：命中的、每条规则一条判据、以及被跳过的规则及原因。
     */
    function evalAlerts(rules, candles, lines, idx, bar, digits) {
      var hits = [];
      var verdicts = [];
      var skipped = [];
      var list = Array.isArray(rules) ? rules : [];
      if (list.length === 0) return { hits: hits, verdicts: verdicts, skipped: skipped };
      var byPeriod = {};
      var seriesList = Array.isArray(lines) ? lines : [];
      for (var i = 0; i < seriesList.length; i += 1) {
        if (seriesList[i] === null || seriesList[i] === undefined) continue;
        if (seriesList[i].item === null || seriesList[i].item === undefined) continue;
        byPeriod[String(seriesList[i].item.period)] = seriesList[i].series;
      }
      for (var r = 0; r < list.length; r += 1) {
        var rule = list[r];
        if (rule === null || rule === undefined) continue;
        // 被跳过的也要记原因：不然"为什么没判"就查不出来
        if (rule.on === false) { skipped.push({ ruleId: rule.id, verdict: 'off' }); continue }
        if (rule.bar !== bar) {
          skipped.push({ ruleId: rule.id, verdict: 'not-this-bar', bar: rule.bar });
          continue;
        }
        var out = evalAlertVerdict(rule, candles, byPeriod[String(rule.emaPeriod)], idx, digits);
        verdicts.push({
          ruleId: rule.id,
          emaPeriod: rule.emaPeriod,
          dir: out.dir === 'down' ? 'down' : (rule.dir === 'down' ? 'down' : 'up'),
          verdict: out.verdict,
          idx: out.idx === undefined ? null : out.idx,
          ts: out.ts === undefined ? null : out.ts,
          prevClose: out.prevClose === undefined ? null : out.prevClose,
          nowClose: out.nowClose === undefined ? null : out.nowClose,
          prevEma: out.prevEma === undefined ? null : out.prevEma,
          nowEma: out.nowEma === undefined ? null : out.nowEma,
        });
        if (out.verdict === 'hit') hits.push(out.hit);
      }
      return { hits: hits, verdicts: verdicts, skipped: skipped };
    }

    /**
     * 找"刚收线的那一根"：返回 `{ idx, ts }`，或 null（还没有新的收线）。
     * `lastClosedTs` 是上次判过的收线时刻 —— **第一次调用传 null，表示"只登记不判定"**：
     * 刚打开面板时不能把历史上最后一次穿越当成刚发生的事来提示。
     * 为什么记时刻而不是下标：刷新时历史会从左边滑走，下标会整体漂移。
     */
    function closedAlertCursor(candles, lastClosedTs) {
      if (!Array.isArray(candles) || candles.length < ALERT_MIN_BARS) return null;
      var idx = -1;
      for (var i = candles.length - 1; i >= 0; i -= 1) {
        var done = candles[i][6] === 1 || candles[i][6] === true;
        if (done === true) { idx = i; break }
      }
      // 一根"已收盘"的都找不到 → 载荷里没带 done（宿主老版本，或字段退化了）。
      // 这种时候要**吭声**：静默返回 null 的表现是"预警永远不响"，却没有任何线索
      // （真踩过：宿主 `candles` 只发了 6 位，客户端读第 7 位，于是全线静默失效）。
      // 但每 5 秒轮询都刷一遍会把控制台淹掉，所以**一个会话只提醒一次**。
      if (idx < 0) {
        if (noDoneWarned !== true) {
          noDoneWarned = true;
          if (typeof console !== 'undefined' && console.warn !== undefined) {
            console.warn('[btcd] K 线载荷没有 done 标记（第 7 位缺失），收线预警无法判定；'
              + '需要宿主半升级并重启（只此一次提醒）');
          }
        }
        return null;
      }
      if (idx < 1) return null;
      var ts = Number(candles[idx][0]);
      if (lastClosedTs === null || lastClosedTs === undefined || !isFinite(Number(lastClosedTs))) {
        // 第一次：只把游标停在"当前已收线的那一根"，不判定
        return { idx: idx, ts: ts, fresh: false };
      }
      if (ts <= Number(lastClosedTs)) return null;
      return { idx: idx, ts: ts, fresh: true };
    }

    /** 预警列表操作：纯函数，不改入参。 */
    function alertAdd(list, period, dir, bar) {
      var current = Array.isArray(list) ? list : [];
      if (current.length >= ALERT_MAX) return current;
      return current.concat([{
        id: alertNewId(),
        emaPeriod: Math.min(EMA_PERIOD_MAX, Math.max(EMA_PERIOD_MIN, Math.round(Number(period) || 20))),
        dir: dir === 'down' ? 'down' : 'up',
        bar: bar === undefined || bar === null ? '' : String(bar),
        on: true,
      }]);
    }

    function alertRemove(list, id) {
      var out = [];
      for (var i = 0; i < (Array.isArray(list) ? list : []).length; i += 1) {
        if (list[i].id !== id) out.push(list[i]);
      }
      return out;
    }

    function alertToggle(list, id) {
      var out = [];
      for (var i = 0; i < (Array.isArray(list) ? list : []).length; i += 1) {
        out.push(list[i].id === id ? Object.assign({}, list[i], { on: list[i].on === false }) : list[i]);
      }
      return out;
    }

    function alertSetDir(list, id, dir) {
      var out = [];
      for (var i = 0; i < (Array.isArray(list) ? list : []).length; i += 1) {
        out.push(list[i].id === id ? Object.assign({}, list[i], { dir: dir === 'down' ? 'down' : 'up' }) : list[i]);
      }
      return out;
    }

    /** 把规则改绑到另一条均线上（周期不合法就原样返回）。 */
    function alertSetPeriod(list, id, period) {
      var next = typeof period === 'string' ? parsePeriod(period, null) : Math.round(Number(period));
      if (typeof next !== 'number' || !isFinite(next) || next < EMA_PERIOD_MIN) return list;
      var clamped = Math.min(EMA_PERIOD_MAX, next);
      var out = [];
      for (var i = 0; i < (Array.isArray(list) ? list : []).length; i += 1) {
        out.push(list[i].id === id ? Object.assign({}, list[i], { emaPeriod: clamped }) : list[i]);
      }
      return out;
    }

    /**
     * 在候选均线里取下一条（点按钮轮换用）。
     * 当前值不在候选里（比如那条均线被删了）→ 回到第一条。
     */
    function alertNextPeriod(current, candidates) {
      var list = Array.isArray(candidates) ? candidates : [];
      if (list.length === 0) return current;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] === current) return list[(i + 1) % list.length];
      }
      return list[0];
    }

    /** 给用户看的规则描述：`收盘上穿 EMA20`。 */
    function alertLabel(rule) {
      var d = alertDirInfo(rule === null || rule === undefined ? 'up' : rule.dir);
      return d.label + ' EMA' + String(rule === null || rule === undefined ? '' : rule.emaPeriod);
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
     * 把**可见窗口里**的指针位置吸到最近的 OHLC（画线/尺子端点用）。
     *
     * 为什么全量序列和窗口下标必须一起传：Chart 里 `board.candles` 是 `candles.slice(win.start, win.end)`，
     * 而 `pointerToData` 给出的 `index` 是**窗口内**的小数下标。早先这里直接拿窗口下标去全量数组里取，
     * 整体偏了 `win.start` 根 —— 吸到的是几百根之前那个价位，距离超容差就永远是 null。
     * 表现就是"吸附按钮按了跟没按一样"（实测：窗口内每根 OHLC 正对着鼠标，命中率 0%）。
     *
     * 返回 `null` 表示附近没有可吸的价位；否则返回 `{ index, price, label }`，
     * `label` 是吸到了开/高/低/收的哪一个（用**整数下标**取行，之前传小数下标取到 undefined，
     * 提示永远只显示"吸附"）。
     */
    function snapToViewOhlc(candles, win, index, price, yOf, limitPx) {
      if (!Array.isArray(candles) || candles.length === 0 || typeof yOf !== 'function') return null;
      if (!isFinite(Number(price)) || !isFinite(Number(index))) return null;
      var start = win === null || win === undefined ? 0 : Number(win.start);
      if (!isFinite(start) || start < 0) start = 0;
      var at = clampInt(start + Number(index), 0, candles.length - 1);
      var hit = snapPriceToOhlc(candles, at, price, yOf, limitPx);
      if (hit === null) return null;
      return { index: at, price: hit, label: ohlcLabelOf(candles[at], hit) };
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

    /**
     * 价格轴范围：K 线高低点 + 可见均线，留 6% 余量。放不下时返回 null。
     * `lines` 是 `[{ item, series }]`，只有 `item.show !== false` 的那些参与贴边。
     */
    function priceRange(candles, lines) {
      var lo = Infinity;
      var hi = -Infinity;
      var i;
      var v;
      for (i = 0; i < candles.length; i += 1) {
        if (candles[i][3] < lo) lo = candles[i][3];
        if (candles[i][2] > hi) hi = candles[i][2];
      }
      var list = Array.isArray(lines) ? lines : [];
      for (i = 0; i < list.length; i += 1) {
        if (list[i] === null || list[i] === undefined) continue;
        if (list[i].item !== undefined && list[i].item !== null && list[i].item.show === false) continue;
        var series = list[i].series;
        if (!Array.isArray(series)) continue;
        for (var j = 0; j < series.length; j += 1) {
          v = series[j];
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

    /**
     * 「x 前」：刚刷过的显示"刚刚" —— 一直挂着"00:00前"反而像坏了。
     *
     * ⚠️ 参数是**时长（毫秒）**，不是时间戳。传时间戳进去会显示成
     * "497584h前"（≈57 年）这种一看就离谱的值 —— 真踩过：两处调用点把
     * `rec.at` 直接传了进来。所以这里加一道兜底：超过 10 年一律当成"数不对"，
     * 宁可显示"刚刚"，也不显示一个荒谬的时长。
     */
    var FMT_AGO_MAX_MS = 10 * 365 * 24 * 3600 * 1000;
    function fmtAgo(ms) {
      var d = Number(ms);
      if (!isFinite(d) || d <= 0) return '刚刚';
      if (d > FMT_AGO_MAX_MS || d < 1500) return '刚刚';
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
    function pointerToData(canvas, candles, lines, clientX, clientY, barMs) {
      if (candles.length === 0) return null;
      var box = plotBox(canvas, candles.length);
      var range = priceRange(candles, lines);
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

    // 画布左上角 EMA 图例的几何与配色（绘制和"点它开关均线"的命中判定共用一份，
    // 不然改一处忘一处，就会出现"看着在图例上点，却点不动"）。
    var LEGEND = {
      left: 4,
      top: 2,
      padX: 2,
      padY: 3,
      swatch: 12,
      gapSwatch: 5,
      height: 17,
      maxWidth: 300,
      // 图例**不画底框**（只有色块 + 文字），所以文字必须自己够深、压着 K 线也读得清
      text: '#2f3742',
      // 指针停在图例某一行时的底色（比"没有底框"稍亮一点，一眼能看出会开关谁）
      hotBg: 'rgba(74,140,255,0.16)',
      radius: 5,
      off: 0.4,
      font: '11px system-ui, -apple-system, "Segoe UI", sans-serif',
    };

    /**
     * 图例的每一行（`EMA20  84,724.6`）。值取**可见窗口最后一根**上的均线值 —— 图上画到哪儿，图例就报到哪儿。
     *
     * **列表里的每条都算一行，隐藏的用 `shown: false` 变暗**，这一点是刻意的：
     *   * 行号必须稳定 —— 第 i 行永远对应 `emas[i]`。
     *     早先只列可见的那些，"关掉某条 → 它从图例里消失 → 再也没地方点回来"，
     *     而且后面的行会整体上移，点第 1 行会去开关另一条（实测就是这么坏的）。
     *   * 变暗而不是消失，用户才知道"这条被我关了，点一下能回来"。
     * `lines` 是 `[{ item, series }]`（`series` 是已切片的窗口数据）。
     */
    function emaLegendItems(lines) {
      var lastOf = function (series) {
        return Array.isArray(series) && series.length > 0 ? series[series.length - 1] : null;
      };
      var out = [];
      var list = Array.isArray(lines) ? lines : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] === null || list[i] === undefined) continue;
        var item = list[i].item === undefined || list[i].item === null ? {} : list[i].item;
        out.push({
          key: item.id === undefined ? 'row' + String(i) : item.id,
          label: emaLabel(item),
          value: lastOf(list[i].series),
          color: typeof item.color === 'string' && item.color !== '' ? item.color : EMA_DEFAULT_COLORS[0],
          shown: item.show !== false,
        });
      }
      return out;
    }

    /**
     * 该不该画图例：至少有一条线、且序列里有数据就画。
     * 判据是**长度 > 0**而不是"是数组" —— Host 的均线数组与 K 线等长，
     * 序列为空时"能有值的那一根"根本不存在，画出来只会是一行破折号。
     */
    function legendVisible(lines) {
      var list = Array.isArray(lines) ? lines : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] !== null && list[i] !== undefined && Array.isArray(list[i].series) && list[i].series.length > 0) {
          return true;
        }
      }
      return false;
    }

    /**
     * 图例的**命中区**（不是画出来的框 —— 图例不画底框，只有色块和文字）。
     * 绘制用它的 x/y 定位每一行，pointerdown 用 legendHit 判"点到了哪一行"，
     * 两边共用同一套计算，才不会出现"看着点在图例上却点不动"。
     * 行数固定为均线条数：隐藏的也在（变暗），行号才有稳定含义。
     */
    function legendRect(plotLeft, plotTop, rows) {
      var count = clampInt(rows === undefined || rows === null ? 1 : rows, 1, EMA_MAX_LINES);
      return {
        x: plotLeft + LEGEND.left,
        y: plotTop + LEGEND.top,
        w: LEGEND.padX * 2 + LEGEND.swatch + LEGEND.gapSwatch + LEGEND.maxWidth,
        h: count * LEGEND.height + LEGEND.padY * 2,
      };
    }

    /**
     * 图例的命中判定：指针落在第几行（0 起），-1 = 不在图例上。
     * 返回值就是均线列表的下标，`Chart` 直接拿它去 `onToggleEma(index)`。
     *
     * 判定用**最近的文字行**，不是"落进某个格子里"：
     * 格子的边界要跟高度、内边距、字号三个值严格对齐，任何一个改动都可能把边界挪到用户
     * 以为的那一行之外（表现就是"点第 1 行却开关了第 0 行"）。取最近一行没有这个隐患 ——
     * 只要指针在色块/文字上下半个行高之内，就命中那一行。
     */
    function legendRowAt(localY, plotTop, rows) {
      var count = clampInt(rows === undefined || rows === null ? 1 : rows, 1, EMA_MAX_LINES);
      var first = plotTop + LEGEND.top + LEGEND.padY + LEGEND.height / 2;
      var row = Math.round((localY - first) / LEGEND.height);
      if (row < 0) row = 0;
      if (row > count - 1) row = count - 1;
      return row;
    }

    function legendHit(plotLeft, plotTop, localX, localY, rows) {
      var count = clampInt(rows === undefined || rows === null ? 1 : rows, 1, EMA_MAX_LINES);
      var rect = legendRect(plotLeft, plotTop, count);
      // 上下各留 3px：贴着上下边缘点也算点了图例
      if (localX < rect.x || localX > rect.x + rect.w) return -1;
      if (localY < rect.y - 3 || localY > rect.y + rect.h + 3) return -1;
      return legendRowAt(localY, plotTop, count);
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
      g.fillStyle = C_POPOVER_BG;
      g.strokeStyle = tint;
      g.lineWidth = 1;
      roundBox(g, lx, ly, labelW, labelH, 5);
      g.fill();
      g.stroke();
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = tint;
      g.fillText(line1, lx + 7, ly + 10);
      g.fillStyle = C_POPOVER_TEXT;
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
      // 均线：`board.lines` 是 `[{ item, series }]`（已按窗口切成等长），条数由用户决定
      var lines = Array.isArray(board.lines) ? board.lines : [];
      // 防呆：均线属于 **board**，放进 view 里是会被静默忽略的（测试里踩过一次，
      // 表现是"图上一条均线都没有，但没有任何报错"）。这里直接喊出来。
      if (lines.length === 0 && Array.isArray(view.lines) && view.lines.length > 0) {
        throw new Error('drawChart: 均线要放在 board.lines 里，不是 view.lines');
      }
      var hover = view.hover;
      var hasHover = hover !== null && hover !== undefined && hover >= 0 && hover < 1e9;

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

      var range = priceRange(candles, lines);
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
        g.fillStyle = C_BAND;
        g.fillRect(xOf(lastIndex) - step / 2, priceTop, Math.max(step, 1), volTop + volH - priceTop);
      }

      // 横向网格 + 右侧价格刻度
      // 注意变量名：别叫 lines —— 上面 `lines` 已经是"均线列表"，同函数里 var 提升会把它覆盖掉
      // （踩过一次：均线整条都不画，且不报错，只是 `lines` 变成了数字 5）
      g.textBaseline = 'middle';
      var gridLines = 5;
      for (i = 0; i <= gridLines; i += 1) {
        var price = lo + (span * i) / gridLines;
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
      // 均线：按列表逐条画，条数与颜色都由用户决定（`item.show === false` 的不画，但仍在图例里）
      for (i = 0; i < lines.length; i += 1) {
        var lineItem = lines[i] === null || lines[i] === undefined ? null : lines[i];
        if (lineItem === null || lineItem.item === undefined || lineItem.item === null) continue;
        if (lineItem.item.show === false) continue;
        drawLine(Array.isArray(lineItem.series) ? lineItem.series : [], lineItem.item.color || EMA_DEFAULT_COLORS[0]);
      }

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
        g.strokeStyle = C_CROSSHAIR;
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
          g.fillStyle = C_POPOVER_BG_SOFT;
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

        g.strokeStyle = C_CROSSHAIR;
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
            g.fillStyle = C_POINTER_DOT;
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
          g.fillStyle = C_POPOVER_BG_SOFT;
          roundBox(g, hintX, hintY, hintW, 18, 5);
          g.fill();
          g.fillStyle = C_POPOVER_TEXT;
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
          // 悬浮框里也把每条均线（可见的那些）列出来，跟左上角图例同一个口径
          for (var li = 0; li < lines.length; li += 1) {
            var lrow = lines[li];
            if (lrow === null || lrow === undefined || lrow.item === null || lrow.item === undefined) continue;
            if (lrow.item.show === false) continue;
            if (!Array.isArray(lrow.series)) continue;
            rows.push([emaLabel(lrow.item), fmtPrice(lrow.series[hover], digitsOf(hc[4]))]);
          }
          if (hc[6] !== 1 && hc[6] !== true) rows.push(['状态', '未收盘']);
          var boxW = 132;
          var boxH = 13 * rows.length + 12;
          var bx = hx + 14;
          if (bx + boxW > padL + plotW) bx = hx - 14 - boxW;
          if (bx < padL) bx = padL + 2;
          var by = Math.max(priceTop + 2, Math.min(hy - boxH / 2, priceTop + priceH - boxH - 2));
          g.fillStyle = C_POPOVER_BG;
          g.strokeStyle = C_POPOVER_EDGE;
          g.lineWidth = 1;
          roundBox(g, bx, by, boxW, boxH, 6);
          g.fill();
          g.stroke();
          g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
          for (i = 0; i < rows.length; i += 1) {
            var ty = by + 12 + i * 13;
            g.fillStyle = C_POPOVER_LABEL;
            g.textAlign = 'left';
            g.fillText(rows[i][0], bx + 8, ty);
            g.fillStyle = C_POPOVER_TEXT;
            g.textAlign = 'right';
            g.fillText(rows[i][1], bx + boxW - 8, ty);
          }
        }
      }

      // ---- 左上角图例：每条均线一行（色块 + 名称 + 当前值），专业图表的位置
      // 画在十字光标之前，这样指针压上去时光标线还在图例之上（不会被盖住）。
      var legendItems = legendVisible(lines) ? emaLegendItems(lines) : [];
      if (legendItems.length > 0) {
        var lrect = legendRect(padL, priceTop, legendItems.length);
        g.font = LEGEND.font;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        // 指针停在哪一行就高亮哪一行：点之前就能看出"这一下会开关谁"。
        // 这一条是拿用户反馈换来的 —— 光靠命中区看不见，错位了也发现不了。
        var hotRow = view.hoverLegendRow;
        var hasHot = hotRow !== undefined && hotRow !== null && hotRow >= 0 && hotRow < legendItems.length;
        // 只画色块 + 文字，**不画底框**（底框会压住后面的 K 线）。
        // 代价是文字直接压在 K 线上，所以 LEGEND.text 选了比"次要文字"更深的颜色。
        for (i = 0; i < legendItems.length; i += 1) {
          var item = legendItems[i];
          var rowY = lrect.y + LEGEND.padY + LEGEND.height * i + LEGEND.height / 2;
          if (hasHot && i === hotRow) {
            g.globalAlpha = 1;
            g.fillStyle = LEGEND.hotBg;
            roundBox(g, lrect.x, rowY - LEGEND.height / 2, lrect.w, LEGEND.height, 4);
            g.fill();
          }
          // 被关掉的那条变暗但仍然在：它是"点一下能开回来"的入口
          g.globalAlpha = item.shown ? 1 : LEGEND.off;
          g.fillStyle = item.color;
          g.fillRect(lrect.x + LEGEND.padX, rowY - 1.5, LEGEND.swatch, 3);
          g.fillStyle = LEGEND.text;
          var text = item.label + (item.value === null || item.value === undefined
            ? '  —' : '  ' + fmtPrice(item.value, digitsOf(lastBar[4])));
          g.fillText(text, lrect.x + LEGEND.padX + LEGEND.swatch + LEGEND.gapSwatch, rowY);
          g.globalAlpha = 1;
        }
      }

      // 回看历史时的角标：挪到右上角（左上角让给图例），跟倒计时胶囊上下错开
      if (view.following === false) {
        var tagText = '回看中';
        g.font = LEGEND.font;
        var tagW = g.measureText(tagText).width + 14;
        var tagX = padL + plotW - tagW - 4;
        var tagY = priceTop + 24;
        g.fillStyle = 'rgba(74,140,255,0.18)';
        roundBox(g, tagX, tagY, tagW, 18, 9);
        g.fill();
        g.fillStyle = brand;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(tagText, tagX + 7, tagY + 9);
      }
    }

    // ------------------------------------------------------------------ 取数

    function fetchJson(path, options) {
      return fetch(API + path, Object.assign({ cache: 'no-store' }, options || {})).then(function (response) {
        return response.json();
      });
    }

    function useBoard(bar, auto, epoch, instId) {
      var state = React.useState({ status: 'loading', board: null, error: null, at: 0 });
      var setState = state[1];
      var wantedInst = normalizeInstId(instId) === null ? 'BTC-USDT-SWAP' : normalizeInstId(instId);
      var instQuery = '&instId=' + encodeURIComponent(wantedInst);
      React.useEffect(function () {
        var alive = true;
        var timer = null;

        function load(force) {
          fetchJson('/board?bar=' + encodeURIComponent(bar) + '&limit=' + String(FETCH_LIMIT) + instQuery + (force ? '&force=1' : ''))
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
      }, [bar, auto, epoch, instQuery]);
      return [state[0], function (force) {
        // 手动刷新：直接打一次带 force 的请求（绕过 Host 的 15 秒热缓存）
        fetchJson('/board?bar=' + encodeURIComponent(bar) + '&limit=' + String(FETCH_LIMIT) + instQuery + '&force=1').then(function (res) {
          if (res !== null && res.ok === true) setState({ status: 'done', board: res, error: null, at: Date.now() });
          else setState(function (prev) { return { status: 'error', board: prev.board, error: (res && res.error) || '取数失败', at: prev.at }; });
        }).catch(function (err) {
          setState(function (prev) { return { status: 'error', board: prev.board, error: String((err && err.message) || err), at: prev.at }; });
        });
      }];
    }

    function usePrice(open, instId) {
      var state = React.useState(null);
      var setState = state[1];
      var wantedInst = normalizeInstId(instId) === null ? 'BTC-USDT-SWAP' : normalizeInstId(instId);
      React.useEffect(function () {
        var alive = true;
        function pull() {
          fetchJson('/price?instId=' + encodeURIComponent(wantedInst)).then(function (res) {
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
      }, [open, wantedInst]);
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
      var onToolDoneRef = React.useRef(null);
      var hoverState = React.useState(null);
      var hover = hoverState[0];
      var setHover = hoverState[1];
      var previewState = React.useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];

      var candles = Array.isArray(props.candles) ? props.candles : [];
      var view = props.view;
      var tool = props.tool === undefined || props.tool === null ? 'none' : props.tool;
      var win = windowOf(candles, view);
      // 均线在整条序列上现算、再按窗口切片 —— 窗口拖到哪儿均线就画到哪儿（见上面「均线列表」那一节）。
      // `lines` 从 Dashboard 传进来（已经算好），避免同一份数据在两层各算一遍。
      var lines = Array.isArray(props.lines) ? props.lines : [];
      var board = {
        candles: candles.slice(win.start, win.end),
        lines: lines.map(function (line) {
          return {
            item: line.item,
            series: Array.isArray(line.series) ? line.series.slice(win.start, win.end) : [],
          };
        }),
        meta: { barMs: props.barMs },
      };
      var lastIndex = candles.length === 0 ? -1 : candles.length - 1;
      // ResizeObserver 回调、指针事件与每秒重绘都要读到最新一帧的数据，统一放 ref。
      latest.current = {
        board: board,
        hover: hover,
        following: view.rightTs === null,
        drawings: props.drawings,
        selectedId: props.selectedId === undefined ? null : props.selectedId,
        preview: preview,
        snapTag: snapTagRef.current,
        barMs: props.barMs,
        win: win,
        lastIndex: lastIndex,
        lastPrice: props.lastPrice,
        emaRows: board.lines.length,
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
      onToolDoneRef.current = props.onToolDone;

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
          // 指针停在哪一行图例上（-1 = 没停）
          hoverLegendRow: legendRowRef.current,
          following: l.following,
          drawings: l.drawings,
          selectedId: l.selectedId,
          preview: l.preview,
          snapTag: l.snapTag,
          // following 同时是「回看中」角标的开关和「画最新价线/倒计时」的开关：
          // 跟随最新（rightTs === null）时窗口右端必定就是序列最后一根。
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
      }, [win.start, win.end, candles, lines, hover, view.rightTs,
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
          canvas, l.board.candles, l.board.lines, clientX, clientY, l.barMs,
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
          // dataAt 的下标是**可见窗口内**的，必须配上窗口起点才能在全量序列里找到那根。
          var hit = snapToViewOhlc(candlesRef.current, latest.current === null ? null : latest.current.win,
            at.index, price, yOfPrice, SNAP_PX);
          if (hit !== null) {
            price = hit.price;
            snapped = { price: hit.price, label: hit.label };
          }
        }
        return { ts: at.ts, price: price, snapped: snapped };
      }

      /** 画线的屏幕坐标 → 命中判定（与绘制共用同一套比例尺）。 */
      function drawingGeom() {
        var l = latest.current;
        if (l === null || l.board === null || l.board.candles.length === 0) return null;
        var box = plotBox(canvasRef.current, l.board.candles.length);
        var range = priceRange(l.board.candles, l.board.lines);
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

        // 点在左上角图例上 → 开关那一行对应的均线（不是画线、也不是平移）。
        // 行号就是均线列表的下标，与隐藏与否无关（隐藏的仍在图例里，只是变暗）——
        // 这正是"关掉还能开回来"的关键。
        //
        // 行数**不能只信 latest.current.emaRows**：那个 ref 在某些渲染顺序下还是 0，
        // 于是行数被夹到 1，第 1 行永远点不到（EMA480 点不开 —— 又踩了一次同一个坑）。
        // 按可靠性依次兜底：ref → props 上的列表 → 至少两行（宁可命中区高一点，也不能点不到）。
        var legendRows = 2;
        if (latest.current !== null && latest.current.emaRows > 0) {
          legendRows = latest.current.emaRows;
        } else if (Array.isArray(props.lines) && props.lines.length > 0) {
          legendRows = props.lines.length;
        }
        var legendRow = legendHit(PAD_LEFT, geo.box.priceTop, local.x, local.y, legendRows);
        if (legendRow >= 0 && typeof props.onToggleEma === 'function') {
          props.onToggleEma(legendRow);
          return;
        }

        // 落在价格轴 / 时间轴上 → 按住拖动 = 缩放（专业图表的老习惯，双击同一区域 = 复位）
        if (local.x > PAD_LEFT + geo.plotWidth || local.y > geo.box.volTop + geo.box.volH) {
          dragRef.current = {
            mode: 'axis', startX: event.clientX, moved: false, baseSize: geo.count,
            anchor: clampNum((local.x - PAD_LEFT) / geo.plotWidth, 0, 1),
          };
          setHover(null);
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
          } else {
            if (typeof onSelectRef.current === 'function' && props.selectedId !== null && props.selectedId !== undefined) {
              onSelectRef.current(null);
            }
            dragRef.current = { mode: 'pan', startX: event.clientX, startView: viewRef.current, step: geo.step, delta: 0, moved: false };
            setHover(null);
          }
        } else {
          dragRef.current = { mode: 'pan', startX: event.clientX, startView: viewRef.current, step: geo.step, delta: 0, moved: false };
          setHover(null);
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
        // 只是点一下（没拖动）不算画完：既不留线，也不退出工具（否则误点一下工具就没了）
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
          // 一刀切：直线 / 斐波那契 / 尺子都是"画一条就收工"，画完自动回到平移模式。
          // 不这样的话每条线都要手动按一下 Esc（或再点一次「平移」），连画三条就是三次多余操作；
          // 而且画完还停在画线模式时，下一次拖动会意外又拉出一条线。
          if (typeof onToolDoneRef.current === 'function') onToolDoneRef.current();
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
      /** 指针停在哪一行图例上（-1 = 没停）。放 ref 里，重绘时直接读，不必过 React。 */
      var legendRowRef = React.useRef(-1);
      /** 立刻重画一帧（图例高亮、光标切换这种即时反馈用）。 */
      function draw() { paint(Date.now()); }

      /** 指针在图例的哪一行（-1 = 不在图例上）。用当前帧的行数，保证跟画出来的一致。 */
      function legendRowUnder(event) {
        var canvas = canvasRef.current;
        if (canvas === null) return -1;
        var box = plotBox(canvas, 1);
        var rect = canvas.getBoundingClientRect();
        // 行数优先用"这一帧真的画了几行"，退回 props 上的列表长度
        var rows = props.lines !== undefined && Array.isArray(props.lines) ? props.lines.length : 0;
        return legendHit(PAD_LEFT, box.priceTop, event.clientX - rect.left, event.clientY - rect.top, rows);
      }

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
        var slice = latest.current === null ? { candles: [], lines: [] } : latest.current.board;
        var range = priceRange(slice.candles, slice.lines);
        var index = clampInt(Math.floor((localX - PAD_LEFT) / box.step), 0, count - 1);
        return {
          index: index,
          y: clampNum(localY, box.priceTop, box.priceTop + box.priceH),
          hit: hitCandle(box, range, slice.candles, index, localX, localY),
        };
      }

      function onMove(event) {
        // 图例高亮：指针压在图例上时，光标也换成手型（"这里能点"）
        var row = legendRowUnder(event);
        if (row !== legendRowRef.current) {
          legendRowRef.current = row;
          if (canvasRef.current !== null) {
            canvasRef.current.style.cursor = row >= 0 ? 'pointer' : '';
          }
          draw();
        }
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
      var ariaText = instShort(props.instId) + ' 合约 K 线图，共 ' + String(candles.length) + ' 根，'
        + (view.rightTs === null ? '当前显示最新一段' : '正在回看历史')
        + (props.lastPrice === undefined || props.lastPrice === null ? '' : '，最新价 ' + fmtPrice(props.lastPrice))
        + '；方向键平移，Ctrl 加方向键缩放，Alt+R 回到最新';

      return React.createElement('canvas', {
        ref: canvasRef,
        className: 'btcd-canvas' + (tool !== 'none' ? ' btcd-drawmode' : ''),
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
      bell: ['M6 1.8a3 3 0 0 0-3 3v2.4L2.2 9h7.6L9 7.2V4.8a3 3 0 0 0-3-3Z', 'M4.8 9.8a1.2 1.2 0 0 0 2.4 0'],
      plus: ['M6 2v8', 'M2 6h8'],
      sliders: ['M2 3.4h8', 'M2 8.6h8', 'M4.6 3.4v2.4', 'M7.4 6.2v2.4'],
      pin: ['M6 1.2v9.6', 'M2.2 4.4h7.6'],
      undo: ['M3.2 4.4H7a2.6 2.6 0 1 1 0 5.2H4.4', 'M5 2.2 2.6 4.4 5 6.6'],
      trash: ['M2.2 3.4h7.6', 'M4.6 3.4V2.2h2.8v1.2', 'M3.4 3.4l.5 6.2h4.2l.5-6.2'],
      eye: ['M1.2 6S3.2 2.6 6 2.6 10.8 6 10.8 6 8.8 9.4 6 9.4 1.2 6 1.2 6Z', 'M6 7.4a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z'],
      eyeOff: ['M2 2l8 8', 'M1.4 6S3.4 2.8 6 2.8c.7 0 1.3.2 1.9.4', 'M10.6 6S8.6 9.2 6 9.2c-.7 0-1.3-.2-1.9-.4'],
      refresh: ['M10.2 5.2A4.2 4.2 0 1 0 6 10.2', 'M10.6 2v3.4H7.2'],
      pause: ['M4.2 3v6', 'M7.8 3v6'],
      play: ['M4.4 2.8 9 6l-4.6 3.2Z'],
    };

    // ================================================================== 回测面板
    //
    // 回测是「异步 job」：POST 启动 → 立刻拿 jobId → 浏览器每 800ms 轮询状态。
    // 所以整个面板自己管一整套状态（表单 / 策略列表 / job / 结果），Dashboard 只留一个开关 ——
    // 塞进 Dashboard 会让本来就很大的组件再涨一截，回测状态的生命周期也只在面板打开期间有意义。
    // 接口与文案以 backtest/INTEGRATION-SPEC.md 为准（§2 API、§4 UI，§4.2 的文案是测试断言依据）。

    var BT_STORE_KEY = 'dsh-btc-dashboard:backtest';

    /**
     * 看板切换标的时，把回测表单里记住的标的也切过去。
     * 否则「先打开过回测面板（表单记住了 BTC）→ 在看板切到 ETH → 再打开回测」时，
     * 表单里上次的 BTC 会压过看板的 ETH，用户以为在跑 ETH、实际跑 BTC（真踩过）。
     */
    function syncBacktestStoreInst(next) {
      var stored = loadStored(BT_STORE_KEY, null);
      if (stored === null || stored === undefined || typeof stored !== 'object' || Array.isArray(stored)) return;
      var id = normalizeInstId(next);
      if (id === null || stored.instId === id) return;
      stored.instId = id;
      saveStored(BT_STORE_KEY, stored);
    }
    // 轮询间隔：契约 §2.3 建议约 800ms；再快只是给宿主添无意义的请求
    var BT_POLL_MS = 800;
    // 交易明细最多显示多少行（summary.trades 最多 500 条，全渲染会把浮层撑爆）
    var BT_TRADE_LIMIT = 100;
    // 各周期的毫秒数：只用来估算「预计 N 根 K 线」与交易表里的时间粒度
    var BT_BAR_MS = {
      '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
      '1h': 3600000, '4h': 14400000, '1D': 86400000,
    };
    // 时间范围快捷档位（文案是契约 §4.2 的固定文案，别改字）
    var BT_QUICK_RANGES = [['近7天', 7], ['近30天', 30], ['近90天', 90], ['近1年', 365]];
    // 策略参数的中文名（认不出的参数名就显示原始名，不瞎猜）
    var BT_PARAM_LABELS = {
      fast: '快线', slow: '慢线', allowShort: '允许做空',
      entryWindow: '突破窗口', exitWindow: '出场窗口', trendWindow: '趋势均线',
      atrPeriod: 'ATR 周期', atrStop: 'ATR 止损倍数', slopeFilter: '均线斜率过滤', weight: '仓位比例',
    };
    // 平仓原因的中文口径（引擎可能给出策略自定义字符串，认不出就原样显示）
    var BT_REASON_TEXT = { strategy: '策略', end: '到期', liquidation: '爆仓', stop: '止损', target: '目标' };

    // ---- 合约标的（看板 + 预警 + 回测面板共用）----
    // 白名单与 Host 的 `SUPPORTED_INSTS` 保持同一份口径；真正拦截非法 instId 的是 Host，
    // 前端这份只用于渲染切换按钮 / 下拉，以及标题与单位文案。
    var INST_OPTIONS = [
      { instId: 'BTC-USDT-SWAP', label: 'BTCUSDT 永续', short: 'BTC' },
      { instId: 'ETH-USDT-SWAP', label: 'ETHUSDT 永续', short: 'ETH' },
    ];
    // 当前标的的共享存储：侧边栏按钮与看板要看到同一个选择（和 ALERT_STORE 一个套路）
    var INST_STORE_KEY = 'dsh-btc-dashboard:inst';
    var INST_STORE = { instId: 'BTC-USDT-SWAP', listeners: new Set() };

    function instOption(instId) {
      for (var ii = 0; ii < INST_OPTIONS.length; ii += 1) {
        if (INST_OPTIONS[ii].instId === instId) return INST_OPTIONS[ii];
      }
      return INST_OPTIONS[0];
    }

    /** 标的短名（BTC/ETH）：用在标题、「24h量」单位、侧边栏按钮上。 */
    function instShort(instId) { return instOption(instId).short; }

    /** 标的完整展示名（BTCUSDT 永续 / ETHUSDT 永续）：用在回测面板副标题。 */
    function instLabel(instId) { return instOption(instId).label; }

    /** 只认白名单里的 instId；不合法返回 null（与 Host 的 normalizeInstId 同口径）。 */
    function normalizeInstId(raw) {
      var text = typeof raw === 'string' ? raw.trim() : '';
      for (var ii = 0; ii < INST_OPTIONS.length; ii += 1) {
        if (INST_OPTIONS[ii].instId === text) return text;
      }
      return null;
    }

    function instStoreNotify() {
      INST_STORE.listeners.forEach(function (fn) { fn(); });
    }

    function instStoreSubscribe(fn) {
      INST_STORE.listeners.add(fn);
      return function () { INST_STORE.listeners.delete(fn); };
    }

    /** 从 localStorage 读一次当前标的（apply() 时调用；脏数据静默回落 BTC）。 */
    function instStoreLoad() {
      var id = normalizeInstId(loadStored(INST_STORE_KEY, null));
      if (id === null || id === INST_STORE.instId) return;
      INST_STORE.instId = id;
      instStoreNotify();
    }

    /** 切换当前标的：写回 localStorage 并通知所有订阅者（看板/侧边栏一起换）。 */
    function instStoreSet(next) {
      var id = normalizeInstId(next);
      if (id === null || id === INST_STORE.instId) return;
      INST_STORE.instId = id;
      saveStored(INST_STORE_KEY, id);
      instStoreNotify();
    }

    function useInstStore() {
      var sub = React.useSyncExternalStore;
      if (typeof sub === 'function') {
        var read = function () { return INST_STORE.instId; };
        return sub(instStoreSubscribe, read, read);
      }
      var state = React.useState(function () { return INST_STORE.instId; });
      React.useEffect(function () {
        return instStoreSubscribe(function () { state[1](INST_STORE.instId); });
      }, []);
      return state[0];
    }

    function btBarMs(bar) {
      var ms = BT_BAR_MS[bar];
      return typeof ms === 'number' ? ms : 0;
    }

    /** 毫秒时间戳 → UTC+8 的 YYYY-MM-DD。回测的日期口径固定是北京时间，跟浏览器时区无关。 */
    function btDateText(ms) {
      var t = Number(ms);
      if (!isFinite(t)) return '';
      var d = new Date(t + 8 * 3600000);
      return String(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }

    /** UTC+8 的「今天」（默认结束日期）。 */
    function btTodayUtc8() {
      return btDateText(Date.now());
    }

    /**
     * YYYY-MM-DD → 毫秒（按 UTC+8 的零点）。
     * 契约 §4.2：`Date.parse(date + 'T00:00:00+08:00')`；解析不出来给 NaN，交给调用方报错。
     * 「结束日期含当日」由调用方再 +1 天（右开区间），这里不偷偷加。
     */
    function btDateMs(text) {
      if (typeof text !== 'string' || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) !== true) return NaN;
      var ms = Date.parse(text + 'T00:00:00+08:00');
      // 像 2026-02-31 这种「格式对、日期不存在」的输入，某些引擎会滚到下个月 —— 回读校验一次
      return btDateText(ms) === text ? ms : NaN;
    }

    /** 毫秒 → MM-DD HH:MM（UTC+8）：交易表里够用且不占宽度。 */
    function btStampText(ms) {
      var t = Number(ms);
      if (!isFinite(t)) return '—';
      var d = new Date(t + 8 * 3600000);
      return pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
        + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    }

    /**
     * 表单里的费率按百分比显示（默认 0.0200 / 0.0500），提交时再 /100 成小数。
     * 先 toFixed 再转回数字：0.02/100 的浮点结果和字面量 0.0002 不一定是同一个 double，
     * 而契约要求提交的就是 0.0002 / 0.0005。
     */
    function btRateFromPercent(text) {
      return Number((Number(text) / 100).toFixed(8));
    }

    function btErrText(error) {
      if (error === null || error === undefined) return '未知错误';
      if (typeof error === 'string') return error;
      return String(error.message === undefined || error.message === null ? error : error.message);
    }

    /**
     * 回测接口专用取数：比 fetchJson 多一层「不是 JSON 就别抛英文解析错」。
     *
     * 为什么需要：Host 半是新增路由，**没重启宿主时 /backtest/* 会返回 404 + 空 body**。
     * 直接 `response.json()` 抛的是 `Unexpected end of JSON input` —— 用户看到只会计较英文，
     * 完全猜不到"宿主还没重启"这个真正原因。这里统一折成中文提示，并保留原始状态码。
     */
    function btFetchJson(path, options) {
      return fetch(API + path, Object.assign({ cache: 'no-store' }, options || {})).then(function (response) {
        if (response === null || response === undefined) {
          throw new Error('回测框架不可用（宿主没有响应，请确认 DSH 还在运行）');
        }
        var status = Number(response.status);
        if (status === 404 || status === 405) {
          throw new Error('回测框架不可用（宿主可能还没重启：/dsh-btc/backtest/* 路由未注册）');
        }
        return response.text().then(function (text) {
          if (text === null || text === undefined || text === '') {
            throw new Error('回测框架不可用（宿主返回了空响应，可能还没重启）');
          }
          try {
            return JSON.parse(text);
          } catch (parseError) {
            throw new Error('回测框架不可用（宿主返回的不是 JSON，可能还没重启）');
          }
        });
      });
    }

    /** 数字格式化：null / 非数字给「—」，绝不让 NaN 出现在界面上。 */
    function btNum(value, digits) {
      if (value === null || value === undefined || !isFinite(Number(value))) return '—';
      return Number(value).toFixed(digits === undefined ? 2 : digits);
    }

    /** 百分比（带正负号）—— fmtPct 已经把 null / NaN 处理成「—」了。 */
    function btPct(value) {
      return fmtPct(value);
    }

    /** 百分比（取绝对值显示）：最大回撤 / 胜率这种「本身无方向」的比率用。 */
    function btPctAbs(value) {
      if (value === null || value === undefined || !isFinite(Number(value))) return '—';
      return Math.abs(Number(value)).toFixed(2) + '%';
    }

    function btIsDateText(text) {
      return typeof text === 'string' && isFinite(btDateMs(text));
    }

    function btCoerceParam(def, candidate) {
      if (typeof def === 'boolean') return candidate === true || candidate === 1 || candidate === 'true';
      if (typeof def === 'number') {
        var n = Number(candidate);
        return isFinite(n) ? n : def;
      }
      if (typeof def === 'string') return typeof candidate === 'string' ? candidate : def;
      return candidate === undefined ? def : candidate;
    }

    /**
     * 把 localStorage 里存的值规范成合法表单。
     * 原则：脏数据静默回落默认值（契约 §4.2 明确要求），绝不让一份坏数据把面板卡死。
     */
    function btPositiveText(saved, fallback, hard) {
      var n = Number(saved);
      if (!isFinite(n) || n <= 0) n = Number(fallback);
      if (!isFinite(n) || n <= 0) n = hard;
      return String(n);
    }

    function btRateText(saved, fallbackRate, hardRate) {
      var pct = Number(saved);
      if (!isFinite(pct) || pct < 0) {
        var rate = Number(fallbackRate);
        if (!isFinite(rate) || rate < 0) rate = hardRate;
        pct = rate * 100;
      }
      return pct.toFixed(4);
    }

    /** 找到策略条目（Host 只会给 listStrategies 白名单里的名字；找不到给 null）。 */
    function btFindStrategy(payload, name) {
      var list = payload !== null && payload !== undefined && Array.isArray(payload.strategies) ? payload.strategies : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] !== null && list[i] !== undefined && list[i].name === name) return list[i];
      }
      return null;
    }

    function btStrategyParams(payload, name) {
      var entry = btFindStrategy(payload, name);
      var src = entry !== null && entry.params !== null && typeof entry.params === 'object' && Array.isArray(entry.params) !== true
        ? entry.params : {};
      var out = {};
      for (var key in src) {
        if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
      }
      return out;
    }

    /**
     * 「策略列表载荷 + localStorage 里的旧表单」→ 一份可直接渲染的表单。
     * 默认值以 Host 的 defaults 为准（前端不重复维护一份）；默认策略 sma-cross 是契约 §4.2 的前端约定。
     * 这是纯函数，脏数据（类型不对 / 日期不存在 / 负数）全部静默回落默认值。
     */
    /**
     * 持久化前的参数归一：编辑期 numeric 参数是原始字符串（text 输入框），
     * 存 localStorage 时按策略默认值的类型转回数字；空/非法值保留原样（回填时 btCoerceParam 会回落默认值）。
     */
    function btParamsForStorage(payload, strategyName, params) {
      var defaults = btStrategyParams(payload, strategyName);
      var out = {};
      for (var key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key) !== true) continue;
        var value = params[key];
        if (typeof defaults[key] === 'number') {
          var n = Number(value);
          out[key] = value !== '' && value !== null && value !== undefined && isFinite(n) ? n : defaults[key];
        } else {
          out[key] = value;
        }
      }
      return out;
    }

    function btBuildForm(payload, stored, currentInst) {
      var defaults = payload !== null && payload !== undefined && payload.defaults !== null && typeof payload.defaults === 'object'
        ? payload.defaults : {};
      var list = payload !== null && payload !== undefined && Array.isArray(payload.strategies) ? payload.strategies : [];
      var names = [];
      var i;
      for (i = 0; i < list.length; i += 1) {
        if (list[i] !== null && list[i] !== undefined && typeof list[i].name === 'string') names.push(list[i].name);
      }
      var saved = stored !== null && stored !== undefined && typeof stored === 'object' && Array.isArray(stored) !== true ? stored : {};
      var wantStrategy = typeof saved.strategy === 'string' && saved.strategy !== '' ? saved.strategy : 'sma-cross';
      var strategy = names.indexOf(wantStrategy) >= 0 ? wantStrategy
        : (names.indexOf('sma-cross') >= 0 ? 'sma-cross' : (names.length > 0 ? names[0] : wantStrategy));
      var paramDefaults = btStrategyParams(payload, strategy);
      var savedParams = saved.params !== null && saved.params !== undefined
        && typeof saved.params === 'object' && Array.isArray(saved.params) !== true ? saved.params : null;
      var params = {};
      for (var key in paramDefaults) {
        if (Object.prototype.hasOwnProperty.call(paramDefaults, key) !== true) continue;
        params[key] = savedParams !== null && Object.prototype.hasOwnProperty.call(savedParams, key) === true
          ? btCoerceParam(paramDefaults[key], savedParams[key]) : paramDefaults[key];
      }
      var barList = payload !== null && payload !== undefined && Array.isArray(payload.bars) && payload.bars.length > 0
        ? payload.bars : BAR_IDS;
      // 标的：Host 没返回 insts（旧版 Host 不认 body.instId）时只能 BTC —— 否则 UI 会显示 ETH、
      // Host 却静默跑 BTC。
      var hostSupportsInsts = payload !== null && payload !== undefined
        && Array.isArray(payload.insts) && payload.insts.length > 0;
      // 新 Host：上次表单 > 当前看板标的 > Host 默认 > BTC（用户刚切到 ETH 时回测默认也应是 ETH；
      // Host 的 defaults.instId 只是最后一层兜底，不该压过用户当前的看板选择）
      var wantInst = null;
      if (hostSupportsInsts) {
        wantInst = normalizeInstId(saved.instId);
        if (wantInst === null) wantInst = normalizeInstId(currentInst);
        if (wantInst === null) wantInst = normalizeInstId(defaults.instId);
      }
      if (wantInst === null) wantInst = 'BTC-USDT-SWAP';
      var wantBar = typeof saved.bar === 'string' && barList.indexOf(saved.bar) >= 0 ? saved.bar
        : (typeof defaults.bar === 'string' && barList.indexOf(defaults.bar) >= 0 ? defaults.bar : barList[0]);
      var endText = btIsDateText(saved.end) ? saved.end : btTodayUtc8();
      var rangeDays = Number(defaults.rangeDays);
      if (!isFinite(rangeDays) || rangeDays <= 0) rangeDays = 30;
      var endMs = btDateMs(endText);
      var startText = btIsDateText(saved.start) ? saved.start : btDateText(endMs - rangeDays * 86400000);
      // 开始 >= 结束是坏数据：静默回默认区间（不弹错误，契约要求「脏数据静默回默认」）
      if (!isFinite(btDateMs(startText)) || btDateMs(startText) >= endMs) {
        startText = btDateText(endMs - rangeDays * 86400000);
      }
      return {
        instId: wantInst,
        strategy: strategy,
        params: params,
        bar: wantBar,
        start: startText,
        end: endText,
        capital: btPositiveText(saved.capital, defaults.initialCapital, 10000),
        leverage: btPositiveText(saved.leverage, defaults.leverage, 1),
        maker: btRateText(saved.maker, defaults.makerFeeRate, 0.0002),
        taker: btRateText(saved.taker, defaults.takerFeeRate, 0.0005),
      };
    }

    /**
     * 建一个 blob URL；任何一环缺失都返回 null（调用方负责兜底提示，不把面板带崩）。
     * 为什么先试 window.URL 再试全局 URL：浏览器里两者是同一份，但 jsdom 测试环境会把
     * createObjectURL 作为替身挂在 window.URL 上；多试几组（构造器 × URL 实现）才稳。
     */
    function btBlobUrl(text, mime) {
      var blobs = [];
      var urls = [];
      var i;
      try {
        if (typeof window !== 'undefined' && typeof window.Blob === 'function') blobs.push(window.Blob);
      } catch (e1) { /* 没有 window.Blob 就用全局的 */ }
      try {
        if (typeof Blob === 'function') blobs.push(Blob);
      } catch (e2) { /* 环境没有 Blob */ }
      try {
        if (typeof window !== 'undefined' && window.URL !== null && window.URL !== undefined) urls.push(window.URL);
      } catch (e3) { /* 跳过 */ }
      try {
        if (typeof URL !== 'undefined' && URL !== null) urls.push(URL);
      } catch (e4) { /* 跳过 */ }
      for (i = 0; i < urls.length; i += 1) {
        if (typeof urls[i].createObjectURL !== 'function') continue;
        for (var b = 0; b < blobs.length; b += 1) {
          try {
            return urls[i].createObjectURL(new blobs[b]([text], { type: mime }));
          } catch (e5) {
            // 这一组不兼容（比如 Node 的 URL 不认 jsdom 的 Blob），换一组再试
          }
        }
      }
      return null;
    }

    function btRevokeUrl(url) {
      var urls = [];
      var i;
      try {
        if (typeof window !== 'undefined' && window.URL !== null && window.URL !== undefined) urls.push(window.URL);
      } catch (e1) { /* 跳过 */ }
      try {
        if (typeof URL !== 'undefined' && URL !== null) urls.push(URL);
      } catch (e2) { /* 跳过 */ }
      for (i = 0; i < urls.length; i += 1) {
        if (typeof urls[i].revokeObjectURL !== 'function') continue;
        try {
          urls[i].revokeObjectURL(url);
          return;
        } catch (e3) { /* 换下一个实现 */ }
      }
    }

    /**
     * 资金曲线：权益线（实线）+ Buy&Hold（虚线）+ 回撤面积（下方独立一条带子）。
     * 数据点由 Host 降采样到 ≤600，画起来很便宜，所以不搞缓存，每次直接重画。
     * 画布尺寸按 devicePixelRatio 放大，文字才不糊。
     */
    function btDrawEquityChart(canvas, summary) {
      if (canvas === null || canvas === undefined || summary === null || summary === undefined) return;
      var points = Array.isArray(summary.equity) ? summary.equity : [];
      var dpr = typeof window !== 'undefined' && isFinite(Number(window.devicePixelRatio)) && Number(window.devicePixelRatio) > 0
        ? Number(window.devicePixelRatio) : 1;
      var cssW = Number(canvas.clientWidth);
      if (!isFinite(cssW) || cssW < 40) cssW = 420;
      var cssH = Number(canvas.clientHeight);
      if (!isFinite(cssH) || cssH < 60) cssH = 200;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      var g = null;
      try {
        g = canvas.getContext('2d');
      } catch (e1) {
        g = null;
      }
      if (g === null || g === undefined || typeof g.beginPath !== 'function') return;
      if (typeof g.setTransform === 'function') g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (typeof g.clearRect === 'function') g.clearRect(0, 0, cssW, cssH);
      var brand = cssVar('--dsw-alias-brand-primary', '#4a8cff');
      var labelColor = cssVar('--dsw-alias-label-secondary', '#98a2ad');
      var down = cssVar('--btcd-down', C_DOWN);
      var i;
      g.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textBaseline = 'middle';
      if (points.length < 2) {
        g.fillStyle = labelColor;
        g.textAlign = 'left';
        g.fillText('资金曲线数据不足', 10, cssH / 2);
        return;
      }
      var lo = null;
      var hi = null;
      for (i = 0; i < points.length; i += 1) {
        var point = points[i];
        if (point === null || point === undefined) continue;
        var eq = Number(point.equity);
        if (isFinite(eq)) {
          if (lo === null || eq < lo) lo = eq;
          if (hi === null || eq > hi) hi = eq;
        }
        var bh = Number(point.bh);
        if (isFinite(bh)) {
          if (lo === null || bh < lo) lo = bh;
          if (hi === null || bh > hi) hi = bh;
        }
      }
      if (lo === null || hi === null || hi - lo <= 0) {
        lo = 0;
        hi = 1;
      }
      var pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;
      var span = hi - lo;
      var padL = 44;
      var padR = 8;
      var padT = 8;
      var padB = 14;
      // 下面留 24% 高度画回撤：回撤是「越深越差」的负向面积，单独一条带子才不会被权益线压住
      var ddH = Math.max(22, Math.round((cssH - padT - padB) * 0.24));
      var priceH = Math.max(30, cssH - padT - padB - ddH - 6);
      var plotW = cssW - padL - padR;
      var n = points.length;

      function xOf(index) {
        return padL + (plotW * index) / Math.max(1, n - 1);
      }

      function yOf(value) {
        return padT + priceH - ((value - lo) / span) * priceH;
      }

      // 横向网格 + 左轴价格标签（只标 3 条：浮层只有 460px 宽，标多了糊成一片）
      g.textAlign = 'right';
      for (i = 0; i <= 2; i += 1) {
        var gridValue = lo + (span * i) / 2;
        var gridY = yOf(gridValue);
        g.strokeStyle = C_GRID;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(padL, gridY);
        g.lineTo(padL + plotW, gridY);
        g.stroke();
        g.fillStyle = labelColor;
        g.fillText(fmtPrice(gridValue, 0), padL - 4, gridY);
      }
      // Buy&Hold 虚线先画（压在权益线下面），走势一样时也不会互相盖住
      g.strokeStyle = labelColor;
      g.lineWidth = 1;
      if (typeof g.setLineDash === 'function') g.setLineDash([4, 3]);
      g.beginPath();
      var started = false;
      for (i = 0; i < n; i += 1) {
        var pbh = points[i] === null || points[i] === undefined ? NaN : Number(points[i].bh);
        if (!isFinite(pbh)) continue;
        if (started !== true) {
          g.moveTo(xOf(i), yOf(pbh));
          started = true;
        } else {
          g.lineTo(xOf(i), yOf(pbh));
        }
      }
      g.stroke();
      if (typeof g.setLineDash === 'function') g.setLineDash([]);
      // 权益线（实线、品牌色）
      g.strokeStyle = brand;
      g.lineWidth = 1.6;
      g.beginPath();
      started = false;
      for (i = 0; i < n; i += 1) {
        var peq = points[i] === null || points[i] === undefined ? NaN : Number(points[i].equity);
        if (!isFinite(peq)) continue;
        if (started !== true) {
          g.moveTo(xOf(i), yOf(peq));
          started = true;
        } else {
          g.lineTo(xOf(i), yOf(peq));
        }
      }
      g.stroke();
      // 回撤面积：dd = equity / 历史峰值 - 1（≤0），把「离峰值跌了多少」画成向下的面积
      var ddTop = padT + priceH + 6;
      var peak = null;
      var maxDd = 0;
      var dds = [];
      for (i = 0; i < n; i += 1) {
        var q = points[i] === null || points[i] === undefined ? NaN : Number(points[i].equity);
        if (!isFinite(q)) {
          dds.push(null);
          continue;
        }
        if (peak === null || q > peak) peak = q;
        var dd = peak === null || peak === 0 ? 0 : (q / peak - 1) * 100;
        if (dd < 0) {
          if (-dd > maxDd) maxDd = -dd;
        } else {
          dd = 0;
        }
        dds.push(dd);
      }
      if (maxDd > 0) {
        var ddScale = Math.max(1, maxDd);
        g.fillStyle = 'rgba(234,57,67,0.18)';
        g.beginPath();
        g.moveTo(xOf(0), ddTop);
        for (i = 0; i < n; i += 1) {
          if (dds[i] === null) continue;
          g.lineTo(xOf(i), ddTop + (-dds[i] / ddScale) * ddH);
        }
        g.lineTo(xOf(n - 1), ddTop);
        g.closePath();
        g.fill();
        g.strokeStyle = down;
        g.lineWidth = 1;
        g.beginPath();
        started = false;
        for (i = 0; i < n; i += 1) {
          if (dds[i] === null) continue;
          if (started !== true) {
            g.moveTo(xOf(i), ddTop + (-dds[i] / ddScale) * ddH);
            started = true;
          } else {
            g.lineTo(xOf(i), ddTop + (-dds[i] / ddScale) * ddH);
          }
        }
        g.stroke();
        g.fillStyle = labelColor;
        g.textAlign = 'left';
        g.fillText('回撤 ' + maxDd.toFixed(2) + '%', padL, ddTop + 7);
      }
      // 底部时间刻度：只标首尾（460px 宽放不下更多日期）
      var firstTs = null;
      var lastTs = null;
      for (i = 0; i < n; i += 1) {
        var tt = points[i] === null || points[i] === undefined ? NaN : Number(points[i].t);
        if (!isFinite(tt)) continue;
        if (firstTs === null) firstTs = tt;
        lastTs = tt;
      }
      g.fillStyle = labelColor;
      if (firstTs !== null) {
        g.textAlign = 'left';
        g.fillText(btDateText(firstTs), padL, cssH - 6);
        g.textAlign = 'right';
        g.fillText(btDateText(lastTs), padL + plotW, cssH - 6);
      }
      // 左上角图例（极简：颜色 + 两个字）
      g.textAlign = 'left';
      g.fillStyle = brand;
      g.fillText('权益', padL + 2, padT + 6);
      g.fillStyle = labelColor;
      g.fillText('Buy&Hold', padL + 34, padT + 6);
    }

    /** KPI 八格（契约 §4.2 的顺序）：总收益 / 年化收益 / 最大回撤 / 夏普 / 胜率 / 交易次数 / 手续费 / Buy&Hold。 */
    function btKpiItems(summary) {
      var metrics = summary !== null && summary !== undefined && summary.metrics !== null && summary.metrics !== undefined
        ? summary.metrics : {};
      var fees = summary !== null && summary !== undefined && summary.fees !== null && summary.fees !== undefined
        ? summary.fees : {};
      var tradeCount = summary !== null && summary !== undefined && summary.tradeCount !== null && summary.tradeCount !== undefined
        ? summary.tradeCount : metrics.tradeCount;

      function clsOf(value) {
        if (value === null || value === undefined || !isFinite(Number(value))) return '';
        var n = Number(value);
        return n > 0 ? 'btcd-up' : (n < 0 ? 'btcd-down' : '');
      }

      return [
        { label: '总收益', text: btPct(metrics.totalReturnPct), cls: clsOf(metrics.totalReturnPct) },
        { label: '年化收益', text: btPct(metrics.annualizedReturnPct), cls: clsOf(metrics.annualizedReturnPct) },
        { label: '最大回撤', text: btPctAbs(metrics.maxDrawdownPct), cls: 'btcd-down' },
        { label: '夏普', text: btNum(metrics.sharpe, 2), cls: '' },
        { label: '胜率', text: btPctAbs(metrics.winRatePct), cls: '' },
        {
          label: '交易次数',
          text: tradeCount === null || tradeCount === undefined || !isFinite(Number(tradeCount)) ? '—' : String(tradeCount),
          cls: '',
        },
        { label: '手续费', text: btNum(fees.total, 2), cls: '' },
        { label: 'Buy&Hold', text: btPct(metrics.buyHoldReturnPct), cls: clsOf(metrics.buyHoldReturnPct) },
      ];
    }

    /** 平仓原因：常见值翻成中文，策略自定义的字符串原样显示（别把用户填的原因吞掉）。 */
    function btReasonText(reason) {
      if (typeof reason !== 'string' || reason === '') return '—';
      return Object.prototype.hasOwnProperty.call(BT_REASON_TEXT, reason) ? BT_REASON_TEXT[reason] : reason;
    }

    /**
     * 回测面板（自包含）：表单 / 策略列表 / job 轮询 / 结果全在这里。
     * Dashboard 只负责「开不开」；关闭时整棵组件卸载，下次打开靠 GET /backtest/status 恢复上次结果
     * （契约 §4.2：「打开面板时若 job 还在跑，继续轮询」——恢复出来是 running 就重新起轮询）。
     */
    function BacktestBoard(props) {
      var onClose = typeof props.onClose === 'function' ? props.onClose : null;
      // 当前看板标的（打开面板时的默认值；面板里还有自己的「标的」下拉，可单独选）
      var currentInst = normalizeInstId(props.instId) === null ? 'BTC-USDT-SWAP' : normalizeInstId(props.instId);
      var metaState = React.useState(null);
      var meta = metaState[0];
      var setMeta = metaState[1];
      var formState = React.useState(null);
      var form = formState[0];
      var setForm = formState[1];
      var jobState = React.useState(null);
      var job = jobState[0];
      var setJob = jobState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      // null | 'run' | 'cancel' | 'report' | 'json'：动作进行中禁用按钮，避免连点
      var busyState = React.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var chartRef = React.useRef(null);
      // 当前表单的最新值：applyJob 是异步回调，闭包里可能拿到旧 form，
      // 判「实际标的 vs 面板所选标的」必须读 ref。
      var formRef = React.useRef(null);
      formRef.current = form;

      /** 统一消化一份 job 状态：done 清错误、error 把中文原因摆到面板上。 */
      function applyJob(next) {
        if (next === null || next === undefined) return;
        setJob(next);
        if (next.state === 'error') {
          setError('回测失败：' + (typeof next.error === 'string' && next.error !== '' ? next.error : '回测出错'));
        } else if (next.state === 'done') {
          setError(null);
          // 防御：宿主可能还在跑旧代码（忽略 body.instId），结果标的与面板选择不一致时明确提示，
          // 不能让人把 BTC 的结果当成 ETH 的。
          var selected = formRef.current !== null && formRef.current !== undefined ? formRef.current.instId : null;
          var actual = next.summary !== null && next.summary !== undefined && typeof next.summary.instId === 'string'
            ? next.summary.instId : null;
          if (selected !== null && actual !== null && actual !== selected) {
            setError('注意：本次回测实际标的 ' + actual + '，与面板选择 ' + selected
              + ' 不一致（宿主可能还在跑旧代码，请重启 DSH 宿主后重试）');
          }
        }
      }

      // ---- 打开面板：GET strategies + GET status（不带 jobId，恢复上次结果）+ 回填 localStorage
      React.useEffect(function () {
        var alive = true;
        var stored = loadStored(BT_STORE_KEY, null);
        btFetchJson('/backtest/strategies').then(function (res) {
          if (alive !== true) return;
          var payload = res !== null && res !== undefined && res.ok === true ? res : null;
          setMeta(payload);
          setForm(btBuildForm(payload, stored, currentInst));
          if (payload === null) {
            setError('回测失败：' + ((res !== null && res !== undefined && res.error) || '策略列表加载失败'));
          }
        }).catch(function (loadError) {
          if (alive !== true) return;
          setMeta(null);
          setForm(btBuildForm(null, stored, currentInst));
          // 旧 Host（没有 /backtest/* 路由）会 404 或者返回非 JSON，fetchJson 在 response.json() 那步就拒了。
          // 这时候报「Unexpected token <」对用户没有意义 —— 直接说人话：宿主需要重启。
          setError('回测失败：回测框架不可用（宿主可能还没重启）');
        });
        btFetchJson('/backtest/status').then(function (res) {
          if (alive !== true) return;
          if (res !== null && res !== undefined && res.ok === true && res.job !== null && res.job !== undefined) {
            applyJob(res.job);
          }
        }).catch(function () {
          // 恢复上次结果失败不影响「重新跑一次」，不打扰用户
        });
        return function () { alive = false; };
      }, []);

      // 表单持久化：只存表单字段（契约 §4.2），结果不存 —— 结果以 Host 的 job 为准。
      // params 先归一：编辑期 numeric 参数存的是原始字符串（text 输入框），落盘要转回数字，
      // 否则下次打开 localStorage 里是 "13" 这种字符串（虽然回填时也能 coerce，但存储形状不该脏）。
      React.useEffect(function () {
        if (form === null) return;
        saveStored(BT_STORE_KEY, {
          instId: form.instId,
          strategy: form.strategy,
          params: btParamsForStorage(meta, form.strategy, form.params),
          bar: form.bar,
          start: form.start,
          end: form.end,
          capital: form.capital,
          leverage: form.leverage,
          maker: form.maker,
          taker: form.taker,
        });
      }, [form, meta]);

      var jobId = job !== null && job !== undefined && typeof job.id === 'string' ? job.id : '';
      var jobActive = job !== null && job !== undefined && (job.state === 'running' || job.state === 'queued');
      // ---- job 轮询：只有 running/queued 才轮询；state 一变（done/error/cancelled）effect 自己收掉
      React.useEffect(function () {
        if (jobActive !== true || jobId === '') return undefined;
        var alive = true;
        var timer = setInterval(function () {
          btFetchJson('/backtest/status?jobId=' + encodeURIComponent(jobId)).then(function (res) {
            if (alive !== true) return;
            if (res !== null && res !== undefined && res.ok === true && res.job !== null && res.job !== undefined) {
              applyJob(res.job);
            }
          }).catch(function () {
            // 单次轮询失败忽略，下一轮再来（宿主重启的间隙不该把面板打成错误态）
          });
        }, BT_POLL_MS);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [jobActive, jobId]);

      // ---- 资金曲线：summary 有变化就重画；容器尺寸变化用 ResizeObserver 跟着重画
      React.useEffect(function () {
        var canvas = chartRef.current;
        if (canvas === null || job === null || job === undefined || job.summary === null || job.summary === undefined) {
          return undefined;
        }
        var summary = job.summary;
        btDrawEquityChart(canvas, summary);
        if (typeof ResizeObserver === 'undefined') return undefined;
        var observer = new ResizeObserver(function () { btDrawEquityChart(canvas, summary); });
        observer.observe(canvas);
        return function () { observer.disconnect(); };
      }, [job]);

      function changeField(key, value) {
        setForm(function (prev) {
          if (prev === null) return prev;
          var next = Object.assign({}, prev);
          next[key] = value;
          return next;
        });
      }

      function changeParam(key, value) {
        setForm(function (prev) {
          if (prev === null) return prev;
          var params = Object.assign({}, prev.params);
          params[key] = value;
          var next = Object.assign({}, prev);
          next.params = params;
          return next;
        });
      }

      function changeStrategy(name) {
        setForm(function (prev) {
          if (prev === null) return prev;
          var next = Object.assign({}, prev);
          next.strategy = name;
          // 换策略就把参数换回该策略的默认值（两套参数结构不同，留着旧的没有意义）
          next.params = btStrategyParams(meta, name);
          return next;
        });
      }

      /** 快捷时间范围：结束=今天（UTC+8），开始=结束 - N 天。 */
      function quickRange(days) {
        var endText = btTodayUtc8();
        var startText = btDateText(btDateMs(endText) - days * 86400000);
        setForm(function (prev) {
          if (prev === null) return prev;
          var next = Object.assign({}, prev);
          next.end = endText;
          next.start = startText;
          return next;
        });
      }

      /** 参数按策略默认值的类型转：number → 数字，boolean → 布尔，string → 字符串。 */
      function submitParams() {
        var merged = {};
        var defaults = btStrategyParams(meta, form === null ? '' : form.strategy);
        for (var key in defaults) {
          if (Object.prototype.hasOwnProperty.call(defaults, key) !== true) continue;
          var def = defaults[key];
          var raw = form !== null && form.params !== null && form.params !== undefined
            && Object.prototype.hasOwnProperty.call(form.params, key) ? form.params[key] : def;
          if (typeof def === 'boolean') {
            merged[key] = raw === true;
            continue;
          }
          if (typeof def === 'number') {
            // 编辑期间 params 里存的是**原始字符串**（text 输入框），这里统一转成数字；
            // 空串必须判非法 —— Number('') === 0，不拦的话清空输入会被悄悄当成 0 提交
            if (raw === '' || raw === null || raw === undefined) return null;
            var n = Number(raw);
            if (!isFinite(n)) return null;
            merged[key] = n;
            continue;
          }
          merged[key] = raw === null || raw === undefined ? '' : String(raw);
        }
        return merged;
      }

      function startRun() {
        if (form === null || busy !== null) return;
        var startMs = btDateMs(form.start);
        var endDayMs = btDateMs(form.end);
        if (!isFinite(startMs) || !isFinite(endDayMs)) {
          setError('回测失败：日期格式不对（要 YYYY-MM-DD）');
          return;
        }
        // 结束日期是「含当日」的：契约 §4.2 要求提交右开区间，所以 +1 天
        var endMs = endDayMs + 86400000;
        if (endMs <= startMs) {
          setError('回测失败：结束日期必须晚于开始日期');
          return;
        }
        var capital = Number(form.capital);
        var leverage = Number(form.leverage);
        var maker = Number(form.maker);
        var taker = Number(form.taker);
        if (!isFinite(capital) || capital <= 0) {
          setError('回测失败：初始资金要大于 0');
          return;
        }
        if (!isFinite(leverage) || leverage <= 0) {
          setError('回测失败：杠杆要大于 0');
          return;
        }
        if (!isFinite(maker) || maker < 0 || !isFinite(taker) || taker < 0) {
          setError('回测失败：费率不能是负数');
          return;
        }
        var params = submitParams();
        if (params === null) {
          setError('回测失败：策略参数要是数字');
          return;
        }
        // 旧 Host 不认 instId：ETH 会被静默当成 BTC 跑。宁可拒绝并提示，也不给错结果。
        if (normalizeInstId(form.instId) !== 'BTC-USDT-SWAP'
          && (meta === null || meta === undefined || !Array.isArray(meta.insts) || meta.insts.length === 0)) {
          setError('回测失败：当前宿主还没加载多标的版本，不能回测 ETH（请重启 DSH 宿主后重试）');
          return;
        }
        var body = {
          instId: form.instId,
          strategy: form.strategy,
          params: params,
          bar: form.bar,
          start: startMs,
          end: endMs,
          initialCapital: capital,
          leverage: leverage,
          makerFeeRate: btRateFromPercent(form.maker),
          takerFeeRate: btRateFromPercent(form.taker),
        };
        setBusy('run');
        setError(null);
        btFetchJson('/backtest/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          setBusy(null);
          if (res === null || res === undefined || res.ok !== true) {
            setError('回测失败：' + ((res !== null && res !== undefined && res.error) || '启动失败'));
            return;
          }
          if (res.job !== null && res.job !== undefined) applyJob(res.job);
        }).catch(function (runError) {
          setBusy(null);
          setError('回测失败：' + btErrText(runError));
        });
      }

      function cancelRun() {
        if (job === null || busy !== null) return;
        var runningId = typeof job.id === 'string' ? job.id : '';
        if (runningId === '') return;
        setBusy('cancel');
        setError(null);
        btFetchJson('/backtest/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: runningId }),
        }).then(function (res) {
          setBusy(null);
          if (res === null || res === undefined || res.ok !== true) {
            setError('回测失败：' + ((res !== null && res !== undefined && res.error) || '取消失败'));
            return;
          }
          if (res.job !== null && res.job !== undefined) applyJob(res.job);
        }).catch(function (cancelError) {
          setBusy(null);
          setError('回测失败：' + btErrText(cancelError));
        });
      }

      /** 当前完成结果的 summary（没有就是 null）。 */
      function currentSummary() {
        if (job === null || job === undefined || job.summary === null || job.summary === undefined) return null;
        return job.summary;
      }

      function reportUrl(format) {
        var summary = currentSummary();
        if (summary === null || summary.reports === null || summary.reports === undefined) return '';
        var url = format === 'json' ? summary.reports.json : summary.reports.html;
        return typeof url === 'string' ? url : '';
      }

      function fetchReportText(path) {
        // summary.reports.* 是**相对 API 前缀**的路径（契约 §2.5，形如 /backtest/report?jobId=…），
        // 所以和 fetchJson 一样要拼上 API 前缀；已经带 /dsh-btc 的写法也容忍，免得两种口径混用打错路由。
        var url = path.indexOf(API + '/') === 0 ? path : API + path;
        return fetch(url, { cache: 'no-store' }).then(function (res) {
          if (res === null || res === undefined || res.ok !== true) throw new Error('报告读取失败');
          return res.text();
        });
      }

      /**
       * 打开完整 HTML 报告：fetch → text → Blob → objectURL → window.open。
       * 走 blob 是为了「报告 HTML 不在同源里执行」——Host 那边的 CSP 是第二道防线，
       * 但把报告放进 blob 源里，报告的脚本/外链从一开始就没有本站的权限。
       */
      function openReport() {
        if (busy !== null) return;
        var url = reportUrl('html');
        if (url === '') {
          setError('回测失败：没有可打开的报告');
          return;
        }
        setBusy('report');
        setError(null);
        fetchReportText(url).then(function (html) {
          setBusy(null);
          var blobUrl = btBlobUrl(String(html), 'text/html');
          if (blobUrl === null) {
            setError('回测失败：当前环境不支持以 blob 方式打开报告');
            return;
          }
          var opened = null;
          try {
            opened = typeof window === 'undefined' ? null : window.open(blobUrl, '_blank');
          } catch (openError) {
            opened = null;
          }
          // 浏览器拦截弹窗时 window.open 明确返回 null；只在 null 时提示。
          // （测试替身可能返回 undefined —— 那不代表被拦，别误报成失败）
          if (opened === null) {
            setError('回测失败：报告已生成，但新窗口被浏览器拦截了（请允许弹出窗口后重试）');
          }
        }).catch(function (reportError) {
          setBusy(null);
          setError('回测失败：' + btErrText(reportError));
        });
      }

      function downloadJson() {
        if (busy !== null) return;
        var url = reportUrl('json');
        if (url === '') {
          setError('回测失败：没有可下载的 JSON');
          return;
        }
        setBusy('json');
        setError(null);
        fetchReportText(url).then(function (text) {
          setBusy(null);
          var summary = currentSummary();
          var barLabel = summary !== null && typeof summary.bar === 'string' && summary.bar !== ''
            ? summary.bar : (form === null ? 'bt' : form.bar);
          var strategyLabel = summary !== null && summary.strategy !== null && summary.strategy !== undefined
            && typeof summary.strategy.name === 'string' && summary.strategy.name !== ''
            ? summary.strategy.name : (form === null ? 'strategy' : form.strategy);
          var jobLabel = job !== null && job !== undefined && typeof job.id === 'string' && job.id !== ''
            ? job.id : 'job';
          var filename = 'backtest-' + barLabel + '-' + strategyLabel + '-' + jobLabel + '.json';
          var blobUrl = btBlobUrl(text, 'application/json');
          if (blobUrl === null) {
            setError('回测失败：当前环境不支持下载 blob');
            return;
          }
          try {
            if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') {
              throw new Error('没有 DOM，无法触发下载');
            }
            var a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            a.style.display = 'none';
            if (document.body !== null && document.body !== undefined && typeof document.body.appendChild === 'function') {
              document.body.appendChild(a);
            }
            if (typeof a.click === 'function') a.click();
            if (a.parentNode !== null && a.parentNode !== undefined && typeof a.parentNode.removeChild === 'function') {
              a.parentNode.removeChild(a);
            }
            // 立刻 revoke 有些浏览器会把还没开始的下载掐掉，留 4 秒
            setTimeout(function () { btRevokeUrl(blobUrl); }, 4000);
          } catch (downloadError) {
            setError('回测失败：' + btErrText(downloadError));
          }
        }).catch(function (downloadError) {
          setBusy(null);
          setError('回测失败：' + btErrText(downloadError));
        });
      }

      // ---- 渲染：先出标题行（加载态也要能关掉面板）
      var headKids = [
        React.createElement('span', { key: 'title' }, '回测'),
        React.createElement('span', { key: 'sub', className: 'btcd-bt-sub' }, instLabel(form === null ? currentInst : form.instId)),
        React.createElement('span', { key: 'sp', className: 'btcd-spacer' }),
        React.createElement('button', {
          key: 'close',
          className: 'btcd-mini',
          title: '收起回测面板（Esc 也可以）',
          onClick: function () { if (onClose !== null) onClose(); },
        }, '关闭'),
      ];

      if (form === null) {
        return React.createElement('div', { className: 'btcd-emapanel btcd-btpanel' },
          React.createElement('div', { className: 'btcd-emapanel-head' }, headKids),
          React.createElement('div', { className: 'btcd-bt-hint' }, '正在加载策略…'),
          error === null ? null : React.createElement('div', { className: 'btcd-bt-error' }, error));
      }

      var kids = [];
      kids.push(React.createElement('div', { className: 'btcd-emapanel-head', key: 'head' }, headKids));

      // 标的：BTC / ETH 永续（列表来自 Host 的 insts；Host 端仍会做白名单校验）。
      // 旧版 Host 不返回 insts、也不认 body.instId —— 这种情况下只给 BTC，并明确提示需重启宿主，
      // 不能让人选了 ETH 而 Host 静默跑 BTC。
      var hostSupportsInsts = meta !== null && meta !== undefined && Array.isArray(meta.insts) && meta.insts.length > 0;
      var instMeta = hostSupportsInsts ? meta.insts : [{ instId: 'BTC-USDT-SWAP', label: 'BTCUSDT 永续' }];
      var instOptionKids = [];
      for (var ii = 0; ii < instMeta.length; ii += 1) {
        var iEntry = instMeta[ii];
        if (iEntry === null || iEntry === undefined || typeof iEntry.instId !== 'string') continue;
        if (normalizeInstId(iEntry.instId) === null) continue;
        instOptionKids.push(React.createElement('option', {
          key: 'i' + iEntry.instId,
          value: iEntry.instId,
        }, typeof iEntry.label === 'string' && iEntry.label !== '' ? iEntry.label : iEntry.instId));
      }
      if (instOptionKids.length === 0) {
        instOptionKids.push(React.createElement('option', { key: 'iBTC', value: 'BTC-USDT-SWAP' }, 'BTCUSDT 永续'));
      }
      kids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'instpick' },
        React.createElement('span', { className: 'btcd-bt-hint' }, '标的'),
        React.createElement('select', {
          className: 'btcd-bt-select btcd-bt-inst',
          'aria-label': '标的',
          title: hostSupportsInsts === true
            ? '回测标的：BTC / ETH 永续合约（Host 白名单校验）'
            : '当前宿主还没加载多标的版本（重启宿主后才能回测 ETH）',
          disabled: hostSupportsInsts !== true,
          value: form.instId,
          onChange: function (event) { changeField('instId', event.target.value); },
        }, instOptionKids)));
      if (hostSupportsInsts !== true) {
        kids.push(React.createElement('div', { className: 'btcd-bt-hint btcd-bt-warn', key: 'instwarn' },
          '当前宿主还没加载多标的版本：回测只支持 BTC-USDT-SWAP。要回测 ETH 请重启 DSH 宿主进程'
          + '（不是刷新浏览器页面），再重开面板。'));
      }

      // 策略 / 周期
      var strategies = meta !== null && meta !== undefined && Array.isArray(meta.strategies) ? meta.strategies : [];
      var strategyOptions = [];
      for (var si = 0; si < strategies.length; si += 1) {
        var sname = strategies[si] !== null && strategies[si] !== undefined && typeof strategies[si].name === 'string'
          ? strategies[si].name : '';
        if (sname === '') continue;
        strategyOptions.push(React.createElement('option', { key: 's' + sname, value: sname }, sname));
      }
      if (strategyOptions.length === 0) {
        strategyOptions.push(React.createElement('option', { key: 's' + form.strategy, value: form.strategy }, form.strategy));
      }
      var bars = meta !== null && meta !== undefined && Array.isArray(meta.bars) && meta.bars.length > 0
        ? meta.bars : BAR_IDS;
      var barOptions = [];
      for (var bi = 0; bi < bars.length; bi += 1) {
        var bname = String(bars[bi]);
        barOptions.push(React.createElement('option', { key: 'b' + bname, value: bname }, bname));
      }
      kids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'pick' },
        React.createElement('span', { className: 'btcd-bt-hint' }, '策略'),
        React.createElement('select', {
          className: 'btcd-bt-select btcd-bt-strategy',
          'aria-label': '策略',
          title: '选一个内置策略（Host 按 listStrategies 白名单校验策略名）',
          value: form.strategy,
          onChange: function (event) { changeStrategy(event.target.value); },
        }, strategyOptions),
        React.createElement('span', { className: 'btcd-bt-hint' }, '周期'),
        React.createElement('select', {
          className: 'btcd-bt-select btcd-bt-bar',
          'aria-label': '周期',
          title: '回测用的 K 线周期',
          value: form.bar,
          onChange: function (event) { changeField('bar', event.target.value); },
        }, barOptions)));

      // 策略参数：按 Host 给的默认值类型动态渲染（number → number、boolean → checkbox、string → text）
      var paramDefaults = btStrategyParams(meta, form.strategy);
      var paramKeys = [];
      for (var pk in paramDefaults) {
        if (Object.prototype.hasOwnProperty.call(paramDefaults, pk) === true) paramKeys.push(pk);
      }
      if (paramKeys.length > 0) {
        var paramKids = [React.createElement('span', { className: 'btcd-bt-hint', key: 'lbl' }, '参数')];
        for (var pi = 0; pi < paramKeys.length; pi += 1) {
          var pkey = paramKeys[pi];
          var pdef = paramDefaults[pkey];
          var plabel = Object.prototype.hasOwnProperty.call(BT_PARAM_LABELS, pkey) ? BT_PARAM_LABELS[pkey] : pkey;
          var pval = form.params !== null && form.params !== undefined
            && Object.prototype.hasOwnProperty.call(form.params, pkey) ? form.params[pkey] : pdef;
          if (typeof pdef === 'boolean') {
            paramKids.push(React.createElement('label', {
              className: 'btcd-bt-hint', key: 'p' + pkey, title: '策略参数 ' + pkey,
            },
            React.createElement('input', {
              type: 'checkbox',
              className: 'btcd-bt-check',
              'data-param': pkey,
              'aria-label': plabel,
              checked: pval === true,
              onChange: function (key) {
                return function (event) { changeParam(key, event.target.checked === true); };
              }(pkey),
            }),
            ' ' + plabel));
          } else {
            paramKids.push(React.createElement('label', {
              className: 'btcd-bt-hint', key: 'p' + pkey, title: '策略参数 ' + pkey,
            },
            plabel + ' ',
            React.createElement('input', {
              // 数字参数也用 text + inputMode：type="number" 会带上下调节箭头，
              // 面板里没有"点箭头加减"的语义，而且 number 输入框在小数/空值上有浏览器差异
              type: 'text',
              inputMode: 'decimal',
              autoComplete: 'off',
              spellCheck: false,
              className: 'btcd-bt-input',
              'data-param': pkey,
              'aria-label': plabel,
              value: String(pval === null || pval === undefined ? '' : pval),
              onChange: function (key) {
                return function (event) {
                  // 编辑期间保留**原始字符串**：否则 "0." 会被 Number 成 0，小数点被吞掉，
                  // weight 这种 0–1 的小数参数根本敲不进去。提交时由 submitParams 统一转数字。
                  changeParam(key, event.target.value);
                };
              }(pkey),
            })));
          }
        }
        kids.push(React.createElement('div', { className: 'btcd-emapanel-row btcd-bt-params', key: 'params' }, paramKids));
      }

      // 时间范围（北京时间；结束日期含当日）
      kids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'dates' },
        React.createElement('span', { className: 'btcd-bt-hint' }, '时间范围'),
        React.createElement('input', {
          type: 'date',
          className: 'btcd-bt-input btcd-bt-date',
          'aria-label': '开始日期',
          title: '开始日期（北京时间零点）',
          value: form.start,
          onChange: function (event) { changeField('start', event.target.value); },
        }),
        React.createElement('span', { className: 'btcd-bt-hint' }, '~'),
        React.createElement('input', {
          type: 'date',
          className: 'btcd-bt-input btcd-bt-date',
          'aria-label': '结束日期',
          title: '结束日期（含当日，按北京时间）',
          value: form.end,
          onChange: function (event) { changeField('end', event.target.value); },
        })));

      var quickKids = [React.createElement('span', { className: 'btcd-bt-hint', key: 'lbl' }, '快捷')];
      for (var qi = 0; qi < BT_QUICK_RANGES.length; qi += 1) {
        quickKids.push(React.createElement('button', {
          key: 'q' + qi,
          className: 'btcd-mini',
          title: '结束日期设为今天（UTC+8），开始日期设为 ' + String(BT_QUICK_RANGES[qi][1]) + ' 天前',
          onClick: function (days) {
            return function () { quickRange(days); };
          }(BT_QUICK_RANGES[qi][1]),
        }, BT_QUICK_RANGES[qi][0]));
      }
      kids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'quick' }, quickKids));

      // 资金 / 杠杆 / 费率（费率输入框显示百分比，提交时 /100）
      // 全部用 text + inputMode="decimal"：不要 type="number" 的上下调节箭头（和需求一致，
      // 也避免不同浏览器对小数点的接受方式不一致）；数值校验统一在 startRun 里做。
      function amountField(label, key, aria, value) {
        return React.createElement('label', { className: 'btcd-bt-hint', key: 'f' + key },
          label + ' ',
          React.createElement('input', {
            type: 'text',
            inputMode: 'decimal',
            autoComplete: 'off',
            spellCheck: false,
            className: 'btcd-bt-input',
            'aria-label': aria,
            title: aria + '（' + (key === 'capital' || key === 'leverage' ? '正数' : '百分比，如 0.0200 = 0.02%') + '）',
            value: value,
            onChange: function (k) {
              return function (event) { changeField(k, event.target.value); };
            }(key),
          }));
      }

      kids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'amounts1' },
        amountField('初始资金', 'capital', '初始资金', form.capital),
        amountField('杠杆', 'leverage', '杠杆', form.leverage)));
      kids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'amounts2' },
        amountField('挂单费率(%)', 'maker', '挂单费率', form.maker),
        amountField('吃单费率(%)', 'taker', '吃单费率', form.taker)));

      // 预计根数（超过 Host 的 maxBarsHint 时提示首次会慢）
      var expectBars = null;
      var hintStart = btDateMs(form.start);
      var hintEnd = btDateMs(form.end);
      if (isFinite(hintStart) && isFinite(hintEnd) && hintEnd + 86400000 > hintStart) {
        var hintBarMs = btBarMs(form.bar);
        if (hintBarMs > 0) expectBars = Math.max(0, Math.round((hintEnd + 86400000 - hintStart) / hintBarMs));
      }
      var maxBarsHint = 20000;
      if (meta !== null && meta !== undefined && meta.limits !== null && meta.limits !== undefined) {
        var hinted = Number(meta.limits.maxBarsHint);
        if (isFinite(hinted) && hinted > 0) maxBarsHint = hinted;
      }
      var hintKids = [React.createElement('span', { key: 'bars', className: 'btcd-bt-hint' },
        expectBars === null ? '预计根数 —' : '预计 ' + expectBars.toLocaleString('en-US') + ' 根 K 线')];
      if (expectBars !== null && expectBars > maxBarsHint) {
        hintKids.push(React.createElement('span', { key: 'warn', className: 'btcd-bt-warn' }, '⚠ 首次抓取可能较慢'));
      }
      kids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'hint' }, hintKids));

      // 操作按钮：运行中只留「取消」；完成后多出「打开完整报告 / 下载 JSON」
      var actionKids = [];
      if (jobActive === true) {
        actionKids.push(React.createElement('button', {
          key: 'cancel',
          className: 'btcd-mini btcd-danger',
          disabled: busy !== null,
          title: '取消这次回测（数据抓取阶段会在阶段边界生效）',
          onClick: cancelRun,
        }, '取消'));
      } else {
        actionKids.push(React.createElement('button', {
          key: 'run',
          className: 'btcd-mini btcd-mini-primary',
          disabled: busy !== null,
          title: '按当前表单启动一次回测（同一时间只允许一个）',
          onClick: startRun,
        }, '开始回测'));
      }
      var summary = currentSummary();
      if (summary !== null) {
        actionKids.push(React.createElement('button', {
          key: 'report',
          className: 'btcd-mini',
          disabled: busy !== null,
          title: '在新标签页打开完整 HTML 报告（用 blob 源隔离，报告里的脚本不会在本站执行）',
          onClick: openReport,
        }, '打开完整报告'));
        actionKids.push(React.createElement('button', {
          key: 'json',
          className: 'btcd-mini',
          disabled: busy !== null,
          title: '把完整 JSON 报告下载到本地',
          onClick: downloadJson,
        }, '下载 JSON'));
      }
      if (busy === 'report' || busy === 'json') {
        actionKids.push(React.createElement('span', { key: 'busy', className: 'btcd-bt-hint' }, '处理中…'));
      }
      kids.push(React.createElement('div', { className: 'btcd-emapanel-row btcd-bt-actions', key: 'actions' }, actionKids));

      if (error !== null) {
        kids.push(React.createElement('div', { className: 'btcd-bt-error', key: 'error' }, error));
      }

      if (jobActive === true && job !== null && job !== undefined) {
        var message = typeof job.message === 'string' && job.message !== '' ? job.message : '正在准备…';
        var progress = job.progress !== null && job.progress !== undefined ? job.progress : null;
        var pages = progress === null ? 0 : Number(progress.pages);
        var extra = '';
        // message 里已经带「已抓取 N 页」时不再重复追加；只有没带页数时才补一句
        if (isFinite(pages) && pages > 0 && message.indexOf('页') < 0 && message.indexOf('抓取') < 0) {
          extra = ' · 已抓取 ' + String(pages) + ' 页';
        }
        kids.push(React.createElement('div', { className: 'btcd-bt-progress', key: 'progress' },
          '回测进行中 · ' + message + extra));
      }
      if (job !== null && job !== undefined && job.state === 'cancelled') {
        kids.push(React.createElement('div', { className: 'btcd-bt-hint btcd-bt-cancelled', key: 'cancelled' }, '回测已取消'));
      }

      if (summary !== null) {
        // 完成行：日期按北京时间显示；end 是右开区间，减一天才是用户选的「结束日期（含当日）」
        var doneStart = Number(summary.start);
        var doneEnd = Number(summary.end);
        var doneBars = summary.range !== null && summary.range !== undefined && isFinite(Number(summary.range.bars))
          ? Number(summary.range.bars) : null;
        kids.push(React.createElement('div', { className: 'btcd-bt-done', key: 'done' },
          '回测完成 · ' + (isFinite(doneStart) ? btDateText(doneStart) : '—')
          + ' ~ ' + (isFinite(doneEnd) ? btDateText(doneEnd - 86400000) : '—')
          + ' · ' + (doneBars === null ? '—' : doneBars.toLocaleString('en-US')) + ' 根'));

        // KPI 八格
        var kpis = btKpiItems(summary);
        var kpiKids = [];
        for (var ki = 0; ki < kpis.length; ki += 1) {
          kpiKids.push(React.createElement('div', { className: 'btcd-bt-kpi', key: 'k' + ki },
            React.createElement('span', { className: 'btcd-bt-kpi-label' }, kpis[ki].label),
            React.createElement('b', { className: kpis[ki].cls }, kpis[ki].text)));
        }
        kids.push(React.createElement('div', { className: 'btcd-bt-kpis', key: 'kpis' }, kpiKids));

        // 资金曲线（独立 canvas；尺寸随容器，见 btDrawEquityChart）
        kids.push(React.createElement('div', { className: 'btcd-bt-chartwrap', key: 'chart' },
          React.createElement('canvas', {
            ref: chartRef,
            className: 'btcd-btchart',
            role: 'img',
            'aria-label': '回测资金曲线：权益线 + Buy&Hold 虚线 + 回撤面积',
          })));

        // 交易明细表（最多 100 行，多出来的给一行提示）
        var trades = Array.isArray(summary.trades) ? summary.trades : [];
        var tradeHeadCells = ['#', '方向', '开仓', '平仓', '盈亏', '手续费', '原因'];
        var tradeHeadKids = [];
        for (var hi = 0; hi < tradeHeadCells.length; hi += 1) {
          tradeHeadKids.push(React.createElement('th', { key: 'h' + hi }, tradeHeadCells[hi]));
        }
        var tradeRows = [];
        for (var ti = 0; ti < trades.length && tradeRows.length < BT_TRADE_LIMIT; ti += 1) {
          var trade = trades[ti];
          if (trade === null || trade === undefined) continue;
          var pnl = Number(trade.pnl);
          var pnlCls = isFinite(pnl) ? (pnl > 0 ? 'btcd-up' : (pnl < 0 ? 'btcd-down' : '')) : '';
          tradeRows.push(React.createElement('tr', { key: 'tr' + ti },
            React.createElement('td', null,
              String(trade.seq === null || trade.seq === undefined ? tradeRows.length + 1 : trade.seq)),
            React.createElement('td', { className: trade.side === 'short' ? 'btcd-down' : 'btcd-up' },
              trade.side === 'short' ? '空' : '多'),
            React.createElement('td', null,
              btStampText(trade.entryT),
              React.createElement('div', { className: 'btcd-bt-hint' }, fmtPrice(trade.entryPrice))),
            React.createElement('td', null,
              btStampText(trade.exitT),
              React.createElement('div', { className: 'btcd-bt-hint' }, fmtPrice(trade.exitPrice))),
            React.createElement('td', { className: pnlCls },
              isFinite(pnl) ? (pnl > 0 ? '+' : '') + pnl.toFixed(2) : '—'),
            React.createElement('td', null, btNum(trade.fees, 2)),
            React.createElement('td', null, btReasonText(trade.exitReason))));
        }
        var tradesKids = [];
        if (tradeRows.length === 0) {
          tradesKids.push(React.createElement('div', { className: 'btcd-bt-hint', key: 'empty' }, '没有成交记录'));
        } else {
          tradesKids.push(React.createElement('table', { className: 'btcd-bt-table', key: 'table' },
            React.createElement('thead', null, React.createElement('tr', null, tradeHeadKids)),
            React.createElement('tbody', null, tradeRows)));
          var totalTrades = Number(summary.tradeCount);
          if (isFinite(totalTrades) && totalTrades > tradeRows.length) {
            tradesKids.push(React.createElement('div', { className: 'btcd-bt-hint', key: 'more' },
              '共 ' + String(totalTrades) + ' 笔，只显示最近 ' + String(tradeRows.length) + ' 笔'));
          }
        }
        kids.push(React.createElement('div', { className: 'btcd-bt-trades', key: 'trades' },
          React.createElement('div', { className: 'btcd-bt-hint', key: 'thead' },
            '交易明细（' + String(trades.length) + ' 笔）'),
          tradesKids));
      }

      return React.createElement('div', { className: 'btcd-emapanel btcd-btpanel' }, kids);
    }

    function Dashboard(props) {
      var close = props.close;
      var barState = React.useState(null);
      var bar = barState[0];
      var setBar = barState[1];
      var autoState = React.useState(true);
      var auto = autoState[0];
      var setAuto = autoState[1];
      // 均线列表：`[{ id, period, color, show }]`，默认 EMA20 + EMA480，可增删改。
      // 首次渲染先用默认列表，挂载后再从 localStorage 读（读盘不能放在渲染里）。
      var emaState = React.useState(function () { return defaultEmas(emaNewId); });
      var emas = emaState[0];
      var setEmas = emaState[1];
      var savedEmaRef = React.useRef(null);
      var emaPanelState = React.useState(false);
      var showEmaPanel = emaPanelState[0];
      var setShowEmaPanel = emaPanelState[1];
      // 收线预警：规则 / 记录 / 判据 / 通知开关全部放在**模块级存储**里（`ALERT_STORE`），
      // 因为判定引擎要常驻执行（由侧边栏按钮驱动），看板只是它的一个视图。
      // 组件自己不再持有这些状态，两侧永远看同一份。
      var alerts = useAlertStore('alerts');
      var setAlerts = function (updater) {
        alertStoreSet({ alerts: typeof updater === 'function' ? updater(alertStoreGet('alerts')) : updater });
        alertStorePersist();
      };
      var notify = useAlertStore('notify') || normalizeNotify(null);
      var setNotify = function (updater) {
        alertStoreSet({ notify: typeof updater === 'function' ? updater(alertStoreGet('notify')) : updater });
        alertStorePersist();
      };
      var alertPanelState = React.useState(false);
      var showAlertPanel = alertPanelState[0];
      var setShowAlertPanel = alertPanelState[1];
      // 回测面板：和均线/预警一样，Dashboard 只留一个开关；
      // 表单 / 策略列表 / job 轮询 / 结果全在自包含的 BacktestBoard 里。
      var backtestPanelState = React.useState(false);
      var showBacktestPanel = backtestPanelState[0];
      var setShowBacktestPanel = backtestPanelState[1];
      /**
       * 打开预警看板时把邮件配置拉一次。
       * 不这么做的话，面板可能是"配置还没回来"时挂载的，输入框会停在空值上
       * （缓存里若刚好没有地址就更是空白，看起来像"关闭后地址丢了"）。
       * 同时**清掉编辑标记**：面板重开是一次全新的交互，输入框该跟服务端的值走，
       * 否则上一轮"编辑过"的标记会把输入框钉在旧草稿上 → 地址看起来丢了。
       */
      React.useEffect(function () {
        if (showAlertPanel !== true) return;
        emailEditedRef.current = false;
        setEmailDraft(null);
        pullEmailConfig();
      }, [showAlertPanel]);
      var alertLog = useAlertStore('log');
      var setAlertLog = function (updater) {
        alertStoreSet({ log: typeof updater === 'function' ? updater(alertStoreGet('log')) : updater });
        alertStorePersist();
      };
      var evalLog = useAlertStore('evals');
      var setEvalLog = function (updater) {
        alertStoreSet({ evals: typeof updater === 'function' ? updater(alertStoreGet('evals')) : updater });
        alertStorePersist();
      };
      /** 自上次打开记录面板以来新增了几条（按钮上出个小圆点）—— 也在共享存储里 */
      var unread = useAlertStore('unread');
      var setUnread = function (updater) {
        alertStoreSet({ unread: typeof updater === 'function' ? updater(alertStoreGet('unread')) : updater });
      };
      /** 预警自检：读引擎写进共享存储的 meta。判定不在这里跑，这里只显示。 */
      var diag = useAlertStore('meta');
      /** 邮件地址输入框的草稿（null 表示"跟着服务端的值走"） */
      var emailDraftState = React.useState(null);
      var emailDraft = emailDraftState[0];
      var setEmailDraft = emailDraftState[1];
      /**
       * 用户是不是正在手改地址。
       * 服务端配置会异步回来（也可能被轮询刷新），如果无条件用它覆盖输入框，
       * 用户敲到一半就会被改写；反过来，一律不覆盖就会出现
       * "重开面板地址是空的、要手打一遍"（真踩过）。所以按这个标记二选一。
       */
      var emailEditedRef = React.useRef(false);
      /** 正在保存邮件设置（保存期间禁用控件，避免连点） */
      var emailBusyState = React.useState(false);
      var emailBusy = emailBusyState[0];
      var setEmailBusy = emailBusyState[1];
      // 看板也可能先于引擎挂载（引擎在 overlay 槽里，顺序不保证），这里也读一次盘
      React.useEffect(function () { alertStoreLoad(); }, []);
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
      var inst = useInstStore();
      function switchInst(next) {
        instStoreSet(next);
        // 回测表单记住的标的也跟着切（否则下次打开回测面板还是上一次的标的）
        syncBacktestStoreInst(next);
      }
      var boardCall = useBoard(bar === null ? '15m' : bar, auto, epochState[0], inst);
      var data = boardCall[0];
      var refresh = boardCall[1];
      var price = usePrice(true, inst);
      // 「x 秒前」与「本轮刷新有没有在跑」都要自己走，不能等 5 秒的轮询来推动
      var tick = useTick(1000);
      var submitTick = useTick(120);
      /**
       * 判定节拍：预警判定**不能只靠载荷变化来驱动**。
       * 早先依赖是 `[board, alerts, bar, notify, showAlertPanel]` ——
       * 一旦轮询因为任何原因停下（网络卡住、宿主挂了、缓存层出问题），
       * effect 就永远不再运行，面板上的判据 / 记录 / 自检**一起冻住**，
       * 看起来就是"几分钟没有任何刷新"。现在用 1 秒的节拍兜底：
       * 最多每秒检查一次"有没有新收线"，判断本身仍是幂等的（同一根只判一次）。
       */
      var beat = useTick(1000);

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

      /**
       * 顶部键盘快捷键与"画完一条就退出工具"都要在**只注册一次**的回调里改状态，
       * 所以这些入口统一走 ref：直接调会闭包到首帧的旧值。逻辑只有一份，ref 只是指向它。
       */
      var barIdsRef = React.useRef(BAR_IDS);
      if (data.board !== null && data.board !== undefined && Array.isArray(data.board.bars)) {
        barIdsRef.current = data.board.bars.map(function (item) { return item.id; });
      }
      var switchBarRef = React.useRef(null);
      var deleteSelectedRef = React.useRef(null);
      var toggleAllEmaRef = React.useRef(null);
      var setToolRef = React.useRef(null);
      var setSelectedRef = React.useRef(null);
      // 键盘处理只注册一次，读状态要走 ref（否则闭包到首帧的旧值）
      var showEmaPanelRef = React.useRef(false);
      showEmaPanelRef.current = showEmaPanel;
      var setShowEmaPanelRef = React.useRef(null);
      setShowEmaPanelRef.current = setShowEmaPanel;
      var showAlertPanelRef = React.useRef(false);
      showAlertPanelRef.current = showAlertPanel;
      var setShowAlertPanelRef = React.useRef(null);
      setShowAlertPanelRef.current = setShowAlertPanel;
      // 回测面板同理：键盘处理只注册一次，读状态要走 ref
      var showBacktestPanelRef = React.useRef(false);
      showBacktestPanelRef.current = showBacktestPanel;
      var setShowBacktestPanelRef = React.useRef(null);
      setShowBacktestPanelRef.current = setShowBacktestPanel;
      // Alt+H：一键开关**所有**均线（以前是两条；现在条数不定，所以按"整体"来）
      toggleAllEmaRef.current = function () {
        setEmas(function (prev) {
          var anyOn = false;
          for (var i = 0; i < prev.length; i += 1) if (prev[i].show !== false) anyOn = true;
          return prev.map(function (item) { return Object.assign({}, item, { show: !anyOn }); });
        });
      };
      setToolRef.current = setTool;
      setSelectedRef.current = function (id) { setSelectedId(id === undefined ? null : id); };

      /** 画线的增删改入口（都走 ref，Chart 里读到的永远是最新实现）。 */
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
        /** 一条画完：退出画线工具回到平移模式（一次一个，不连续绘） */
        toolDone: function () { setToolRef.current('none'); },
        /**
         * 点画布左上角的图例第 index 行：开关那条均线。
         * 用**函数式更新**（`prev` 而不是渲染期的 `emas`）：快速连点时闭包里的列表可能已经过期。
         */
        toggleEma: function (index) {
          setEmas(function (prev) {
            var out = [];
            for (var i = 0; i < prev.length; i += 1) {
              out.push(i === index ? Object.assign({}, prev[i], { show: prev[i].show === false }) : prev[i]);
            }
            return out;
          });
        },
      };

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
        /** 焦点在输入框 / 下拉 / 可编辑区里时，键盘属于表单，不应该被画布快捷键拦截。 */
        function isEditableTarget(target) {
          if (target === null || target === undefined) return false;
          var tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
          return target.isContentEditable === true;
        }
        function onKey(event) {
          // 输入框里打字时：除了 Esc（收面板）之外一律不处理。
          // 不守卫的话，下面的数字键 1..6 会切周期并 preventDefault —— 回测面板里
          // 把数字删掉后就再也敲不进去（真踩过）；Delete 键同理（会被当成删画线）。
          if (isEditableTarget(event.target) === true && event.key !== 'Escape') return;
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
            // 均线管理看板开着就先收它，再按才关整个看板
            if (showEmaPanelRef.current === true) {
              setShowEmaPanelRef.current(false);
              return;
            }
            if (showAlertPanelRef.current === true) {
              setShowAlertPanelRef.current(false);
              return;
            }
            // 回测面板同理：先收它，再按才关整个看板
            if (showBacktestPanelRef.current === true) {
              setShowBacktestPanelRef.current(false);
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
            toggleAllEmaRef.current();
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

      // 均线列表的持久化：全局一份（它跟周期无关，换 15m/1h 用的还是同一组均线）
      React.useEffect(function () {
        var raw = loadStored(EMA_STORE_KEY, null);
        if (raw !== null && raw !== undefined) {
          setEmas(normalizeEmas(raw, emaNewId));
        }
      }, []);

      React.useEffect(function () {
        var text = JSON.stringify(emas);
        if (savedEmaRef.current === text) return;
        savedEmaRef.current = text;
        saveStored(EMA_STORE_KEY, emas);
      }, [emas]);

      // 预警的持久化不在这里 —— 规则 / 记录 / 判据 / 通知开关都由 `ALERT_STORE` 统一读写，
      // 因为它必须**常驻**（看板关掉也要继续判），不能随着 Dashboard 卸载而丢失。

      /**
       * 浏览器要求提示音必须在"用户交互过"之后才能响。
       * 面板里点一下、按一下键都算 —— 挂一次性的监听，交互过就摘掉。
       */
      React.useEffect(function () {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        function unlock() {
          if (audioCtx === null) {
            try {
              var Ctor = window.AudioContext || window.webkitAudioContext;
              if (typeof Ctor === 'function') audioCtx = new Ctor();
            } catch (error) { /* 不支持就永远不响 */ }
          }
          if (audioCtx !== null && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
            try { audioCtx.resume(); } catch (error) { /* 忽略 */ }
          }
          window.removeEventListener('pointerdown', unlock, true);
          window.removeEventListener('keydown', unlock, true);
        }
        window.addEventListener('pointerdown', unlock, true);
        window.addEventListener('keydown', unlock, true);
        return function () {
          window.removeEventListener('pointerdown', unlock, true);
          window.removeEventListener('keydown', unlock, true);
        };
      }, []);

      // 收线判定**不在这里** —— 它由常驻的 `<AlertEngine />`（挂在 overlay 槽上、只渲染 null）执行，
      // 所以看板开着或关着都在盯。这里只负责把引擎写进 `ALERT_STORE` 的结果渲染出来。

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
      // 价格行的数据源：**优先用看板载荷里的 ticker**（与 K 线、标的同源，一定是当前合约），
      // `/price` 只作为兜底。原因：旧版 Host 的 `/price` 不认识 instId（会返回默认标的 BTC），
      // 如果优先用它，切换 ETH 后 K 线已经是 ETH、左上角价格/24h 却还是 BTC（真踩过）。
      var priceMatchesInst = price !== null && price !== undefined && normalizeInstId(price.instId) === normalizeInstId(inst);
      var quote = board !== null && board.price !== null && board.price !== undefined
        ? board.price
        : (priceMatchesInst && price.price !== null ? price.price : null);
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
      // 序列一变（每 5 秒刷新/切周期）或均线列表一改，就重算 —— 这就是「动态更新」。
      var emaLines = emaFor(fullCandles, emas, board === null ? 0 : board.fetchedAt);
      var lastClose = fullCandles.length === 0 ? null : fullCandles[fullCandles.length - 1][4];
      var barMs = board === null || board.meta === undefined || board.meta === null ? 0 : Number(board.meta.barMs || 0);
      // 价格行里的「价距 EMA」：每条均线一个，取序列最后一根上的值
      var emaVs = emaLines.map(function (line) {
        var series = line.series;
        var value = series.length === 0 ? null : series[series.length - 1];
        return {
          item: line.item,
          value: value,
          pct: lastClose === null || value === null || value === 0
            ? null : Number((((lastClose - value) / value) * 100).toFixed(3)),
        };
      });

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
        React.createElement('span', { className: 'btcd-title', key: 'title' }, 'OKX ' + instShort(inst) + ' 合约看板'),
        React.createElement('span', { className: 'btcd-chip', key: 'inst' }, board === null ? 'BTC-USDT-SWAP' : board.instId),
        env === null ? null : React.createElement('span', {
          className: 'btcd-chip' + (env.simulated ? ' btcd-demo' : ''),
          key: 'env-chip',
          title: env.note + '（密钥 ' + (env.keyMasked || '未配置') + '）',
        }, (env.simulated ? '模拟环境' : '生产环境') + ' · ' + (env.keyMasked || '无密钥')),
        React.createElement('div', { className: 'btcd-seg', key: 'instseg' },
          React.createElement('button', {
            className: inst === 'BTC-USDT-SWAP' ? 'on' : '',
            onClick: function () { switchInst('BTC-USDT-SWAP'); },
            title: '切换到 BTCUSDT 永续',
          }, 'BTC'),
          React.createElement('button', {
            className: inst === 'ETH-USDT-SWAP' ? 'on' : '',
            onClick: function () { switchInst('ETH-USDT-SWAP'); },
            title: '切换到 ETHUSDT 永续',
          }, 'ETH')),
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
            React.createElement('b', null, fmtVol(quote === null ? null : quote.vol24h) + ' ' + instShort(inst))),
          React.createElement('span', { title: '最近一根 K 线的收盘时间' }, '更新 ',
            React.createElement('b', null, fmtTime(data.at, 0, true))),
          countdownMs === null ? null : React.createElement('span', {
            className: 'btcd-countdown', key: 'cd',
            title: '距离本根 ' + (bar === null ? '15m' : bar) + ' K 线收盘还有 ' + fmtDur(countdownMs),
          }, '距收盘 ', React.createElement('b', null, fmtDur(countdownMs))),
          React.createElement('span', { key: 'ema', title: '每条均线的当前值与「现价距它多少」' }, 'EMA ',
            React.createElement('b', null, emaVs.length === 0 ? '（无）' : emaVs.map(function (line) {
              return String(line.item.period) + ': ' + fmtPrice(line.value);
            }).join(' / '))),
          emaVs.length === 0 ? null : React.createElement('span', { key: 'vs' },
            '价距 ',
            emaVs.map(function (line, index) {
              return React.createElement('span', { key: 'v' + index },
                index > 0 ? '  ' : '',
                String(line.item.period) + ' ',
                React.createElement('b', { className: line.pct === null || line.pct < 0 ? 'btcd-down' : 'btcd-up' },
                  fmtPct(line.pct)));
            })),
          submitting ? React.createElement('span', { className: 'btcd-hint' }, '刷新中…') : null,
          // 最近一次命中的预警：常驻在价格行里，弹一次 toast 之后还能回看
          alertLog.length === 0 ? null : React.createElement('span', {
            key: 'alert', className: 'btcd-alert-chip',
            title: '收线预警最近命中：' + alertLog[0].text + '（' + fmtTime(alertLog[0].ts, barMs, true) + '）',
          }, '🔔 ', alertLog[0].text)),
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

      // 均线：工具条上就一个「均线」按钮 —— 点开就是**管理看板**（增 / 删 / 改 / 显隐全在里面）。
      // 画布左上角的图例只负责逐条显隐（点一下开关），不放任何编辑入口。
      var emaKids = [
        React.createElement('span', { key: 'lbl', className: 'btcd-lbl' }, '均线'),
        React.createElement('button', {
          key: 'manage',
          className: 'btcd-tool' + (showEmaPanel ? ' on' : ''),
          title: '均线管理：新增 / 删除 / 改周期 / 换颜色 / 显隐（画布左上角的图例也能点着开关）',
          'aria-pressed': showEmaPanel,
          'aria-expanded': showEmaPanel,
          onClick: function () { setShowEmaPanel(!showEmaPanel); },
        }, ico(ICON.sliders), React.createElement('span', null,
          emas.length === 0 ? '均线管理' : '均线管理（' + String(emas.length) + '）')),
        // 收线预警：收盘价穿过均线时提示
        React.createElement('span', { key: 'lbl2', className: 'btcd-lbl' }, '预警'),
        React.createElement('button', {
          key: 'alerts',
          className: 'btcd-tool btcd-alert-btn' + (showAlertPanel ? ' on' : '')
            + (alerts.filter(function (a) { return a.on !== false; }).length > 0 ? ' armed' : ''),
          title: alerts.length === 0
            ? '收线预警：K 线收线后收盘价穿过指定均线时提示（点这里设置）'
            : alertLabel(alerts[0]) + (alerts.length > 1 ? ' 等 ' + String(alerts.length) + ' 条规则' : ''),
          'aria-pressed': showAlertPanel,
          onClick: function () {
            var next = !showAlertPanel;
            setShowAlertPanel(next);
            // 打开就等于"看过了"：清掉未读数
            if (next === true) setUnread(0);
          },
        }, ico(ICON.bell), React.createElement('span', null,
          alerts.length === 0 ? '预警' : '预警（' + String(alerts.filter(function (a) { return a.on !== false; }).length) + '）'),
        unread > 0 ? React.createElement('span', {
          key: 'dot', className: 'btcd-alert-dot', title: '有 ' + String(unread) + ' 条新预警记录',
        }, unread > 99 ? '99+' : String(unread)) : null),
        // 回测入口：工具条上就是「回测」两个字（契约 §4.1 的文案），点开/收起右上角回测面板
        React.createElement('span', { key: 'lbl3', className: 'btcd-lbl' }, '回测'),
        React.createElement('button', {
          key: 'backtest',
          className: 'btcd-tool' + (showBacktestPanel ? ' on' : ''),
          title: '回测：选时间范围跑内置策略，看资金曲线 / 指标 / 交易明细',
          'aria-pressed': showBacktestPanel,
          'aria-expanded': showBacktestPanel,
          onClick: function () { setShowBacktestPanel(!showBacktestPanel); },
        }, React.createElement('span', null, '回测')),
        React.createElement('span', { key: 'sp', className: 'btcd-spacer' }),
      ];
      var TOOLS = [
        ['none', '平移', '平移 / 缩放模式（拖动=平移，滚轮=缩放，双击=复位）', ICON.hand],
        ['line', '直线', '按住拖动画一条直线。画完自动回到平移（一次一条）；之后可直接拖动/点选已画的线', ICON.line],
        ['fib', '斐波那契', '按住拖动：起点→终点决定区间，默认画 0 / 0.5 / 1 / 1.5 / 2。画完自动回到平移（一次一条）', ICON.fib],
        ['measure', '尺子', '按住拖动量一段：价格差、涨跌比例、时长。端点会吸附到 OHLC；画完自动回到平移（一次一条）', ICON.ruler],
      ];
      var toolKids = [React.createElement('span', { key: 'lbl', className: 'btcd-lbl' }, '工具')];
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

      // 均线管理看板：新增 / 删除 / 改周期 / 换颜色 / 显隐 / 恢复默认，全在这里。
      // 做成浮层而不是常驻一行：日常只是开关均线（点画布图例就够了），
      // 常驻会把"改周期"这种低频操作一直摆在眼前占地方。
      if (showEmaPanel) {        var emaPanelKids = [
          React.createElement('div', { className: 'btcd-emapanel-head', key: 'head' },
            React.createElement('span', null, '均线管理'),
            React.createElement('span', { className: 'btcd-spacer' }),
            React.createElement('button', {
              key: 'add', className: 'btcd-mini btcd-mini-primary',
              title: emas.length >= EMA_MAX_LINES
                ? '最多 ' + String(EMA_MAX_LINES) + ' 条'
                : '新增一条均线（自动给一个还没用过的周期与颜色）',
              disabled: emas.length >= EMA_MAX_LINES,
              onClick: function () { setEmas(function (prev) { return emaAdd(prev); }); },
            }, '＋ 新增'),
            React.createElement('button', {
              key: 'reset', className: 'btcd-mini',
              title: '恢复默认（EMA' + EMA_DEFAULT_PERIODS.join(' + EMA') + '）',
              onClick: function () { setEmas(defaultEmas(emaNewId)); },
            }, '恢复默认'),
            React.createElement('button', {
              key: 'close', className: 'btcd-mini',
              title: '收起（Esc 也可以）',
              onClick: function () { setShowEmaPanel(false); },
            }, '收起')),
        ];
        for (var mi = 0; mi < emas.length; mi += 1) {
          emaPanelKids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'r' + emas[mi].id },
            React.createElement('button', {
              key: 'color',
              className: 'btcd-ema-dot btcd-ema-dot-lg',
              style: { background: emas[mi].color },
              title: '换颜色（在调色板里轮换）',
              'aria-label': '切换 EMA' + String(emas[mi].period) + ' 的颜色',
              onClick: function (index) { return function () {
                setEmas(function (prev) {
                  var cur = prev[index];
                  if (cur === undefined) return prev;
                  var at = EMA_DEFAULT_COLORS.indexOf(cur.color);
                  return emaUpdate(prev, cur.id, { color: EMA_DEFAULT_COLORS[(at + 1) % EMA_DEFAULT_COLORS.length] });
                });
              }; }(mi),
            }),
            React.createElement(PeriodEditor, {
              key: 'period',
              value: emas[mi].period,
              title: 'EMA' + String(emas[mi].period) + ' 的周期（' + String(EMA_PERIOD_MIN) + '–' + String(EMA_PERIOD_MAX) + '）',
              onCommit: function (id) { return function (text) { setEmas(function (prev) { return emaUpdate(prev, id, { period: text }); }); }; }(emas[mi].id),
            }),
            React.createElement('button', {
              key: 'show', className: 'btcd-mini' + (emas[mi].show !== false ? ' on' : ''),
              title: emas[mi].show !== false ? '当前显示，点击隐藏' : '当前隐藏，点击显示',
              onClick: function (index) { return function () { drawApiRef.current.toggleEma(index); }; }(mi),
            }, emas[mi].show !== false ? '显示中' : '已隐藏'),
            React.createElement('button', {
              key: 'del', className: 'btcd-mini btcd-danger',
              title: '删除这条均线',
              onClick: function (id) { return function () { setEmas(function (prev) { return emaRemove(prev, id); }); }; }(emas[mi].id),
            }, '删除')));
        }
        if (emas.length === 0) {
          emaPanelKids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'empty' },
            React.createElement('span', { className: 'btcd-hint' },
              '一条均线都没有。点右上角的「＋ 新增」加一条，或「恢复默认」加回 EMA20 / EMA480。')));
        } else {
          emaPanelKids.push(React.createElement('div', { className: 'btcd-emapanel-foot', key: 'foot' },
            '共 ' + String(emas.length) + ' / ' + String(EMA_MAX_LINES) + ' 条 · 周期范围 '
            + String(EMA_PERIOD_MIN) + '–' + String(EMA_PERIOD_MAX)
            + ' · 显隐也可以直接点画布左上角的图例'));
        }
        children.push(React.createElement('div', { className: 'btcd-emapanel', key: 'emapanel' }, emaPanelKids));
      }

      // 收线预警看板：一条规则一行（方向 / 均线周期 / 开关 / 删除），外加最近命中记录。
      if (showAlertPanel) {
        var emaPeriods = emas.map(function (e) { return e.period; });
        var pickPeriod = emaPeriods.length > 0 ? emaPeriods[0] : EMA_DEFAULT_PERIODS[0];
        var alertKids = [
          React.createElement('div', { className: 'btcd-emapanel-head', key: 'head' },
            React.createElement('span', null, '收线预警'),
            React.createElement('span', { className: 'btcd-spacer' }),
            React.createElement('button', {
              key: 'add', className: 'btcd-mini btcd-mini-primary',
              title: alerts.length >= ALERT_MAX
                ? '最多 ' + String(ALERT_MAX) + ' 条规则'
                : '加一条：选一个均线周期 + 上穿/下穿',
              disabled: alerts.length >= ALERT_MAX,
              onClick: function () {
                // 周期还没取到就别建规则：建出来也是"周期未知"，哪个周期都不判，
                // 只会让用户以为是坏了。宁可让他等一下再说。
                if (bar === null || bar === undefined || bar === '') {
                  setToast('还在取数，等这一根周期出来再加规则');
                  return;
                }
                if (emaPeriods.length === 0) {
                  setToast('先加一条均线（均线管理），规则要绑在均线上');
                  return;
                }
                setAlerts(function (prev) {
                  var next = alertAdd(prev, pickPeriod, 'up', bar);
                  // 同一条规则别重复加（均线周期 + 方向 + 周期三样都一样时把新加的去掉）
                  var dup = next.filter(function (a) {
                    return a.emaPeriod === pickPeriod && a.dir === 'up' && a.bar === bar;
                  });
                  if (dup.length > 1) {
                    setToast('这条规则已经有了');
                    return prev;
                  }
                  return next;
                });
              },
            }, '＋ 新增规则'),
            React.createElement('button', {
              key: 'close', className: 'btcd-mini',
              title: '收起（Esc 也可以）',
              onClick: function () { setShowAlertPanel(false); },
            }, '收起')),
          // 自检：把"能不能判"的条件直接摆出来。
          // 预警的失败模式是"什么都不发生"，没有这块就只能靠猜（真踩过：宿主少发一位 done）
          (function () {
            // 引擎可能还没跑过（比如刚装上、或规则还没建），此时用看板自己的载荷算健康度，
            // 自检块就不会是空的 —— "看得见"这件事不该依赖引擎的状态。
            var mine = board !== null && Array.isArray(board.candles) ? candleHealth(board.candles) : null;
            var h = diag !== null && diag.health !== null && diag.health !== undefined ? diag.health : mine;
            if (h === null) return null;
            var ready = h.ready === true;
            // 引擎还没产出 meta 时（刚装上 / 还没建规则），用健康度自己推一个结论出来，
            // 别显示空白 —— 缺 done 这种硬阻塞必须立刻看得见
            var reason = diag === null ? (ready ? 'waiting' : 'no-done') : diag.reason;
            var reasonText = reason === 'failed'
              ? '⚠️ 判定过程抛错了：' + String(diag.error) + '（这一条也记进判据日志了）'
              : (reason === 'no-done'
                ? '⚠️ K 线载荷里没有 done 标记（每根的第 7 位缺了），收线判定无法进行 —— 需要重启宿主'
                : (reason === 'no-rules'
                  ? '还没有规则，先加一条'
                  : (reason === 'waiting'
                    ? '已就绪，正在等下一根收线'
                    : (reason === 'armed'
                      ? '已就绪：游标停在最近一根已收盘的 K 线上，等下一根收线就会判'
                      : (reason === 'hit'
                        ? '刚命中 ' + String(diag.hits) + ' 条'
                        : (ready !== true
                          // 结论只有一个"条件不满足"，但原因必须说清 —— 否则用户只会看到"没反应"
                          ? '⚠️ K 线载荷里没有 done 标记（每根的第 7 位缺了），收线判定无法进行'
                          : '已判过 ' + String(diag === null ? 0 : diag.fires) + ' 次收线，最近一次没穿越'))))));
            return React.createElement('div', {
              className: 'btcd-emapanel-foot btcd-alert-diag' + (ready ? '' : ' btcd-alert-diag-bad'),
              key: 'diag',
              title: '收线预警要能工作，需要：① 载荷每根带 done ② 至少一根已收盘 ③ 有一条绑在当前周期的启用规则',
            },
            React.createElement('span', null, '自检  '),
            React.createElement('span', { className: ready ? 'btcd-alert-up' : 'btcd-alert-down' },
              ready ? '条件就绪' : '条件不满足'),
            React.createElement('span', { className: 'btcd-hint' },
              '  · K 线 ' + String(h.count) + ' 根'
              + '（带 done ' + String(h.withDone) + '，已收盘 ' + String(h.doneCount) + '）'
              + ' · 应判 ' + String(diag.expect === undefined ? 0 : diag.expect)
              + ' / 判定 ' + String(diag.fires === undefined ? 0 : diag.fires)
              + ' · 最近检查 ' + (diag.at === undefined || diag.at === null
                ? '（还没检查）' : fmtTime(diag.at, 0, true) + '.' + String(new Date(diag.at).getSeconds()).padStart(2, '0'))
              + (h.lastDoneTs === null ? '' : ' · 最近收线 ' + fmtTime(h.lastDoneTs, barMs, true))),
            React.createElement('span', { className: 'btcd-hint' }, '  · ' + reasonText));
          })(),
          // 通知渠道：面板内提示已经有了，这里补"人不在看屏幕"时也能察觉的两条
          React.createElement('div', { className: 'btcd-emapanel-row', key: 'channels' },
            React.createElement('span', { className: 'btcd-hint' }, '提醒方式'),
            React.createElement('button', {
              key: 'desktop',
              className: 'btcd-mini' + (notify.desktop === true ? ' on' : ''),
              title: notifyAvailable() !== true
                ? '这个环境不支持桌面通知'
                : (notifyPermission() === 'denied'
                  ? '浏览器已经拒绝了通知权限，要在地址栏左边的站点设置里改回来'
                  : '标签页在后台时弹系统通知（需要授权）'),
              disabled: notifyAvailable() !== true,
              onClick: function () {
                if (notify.desktop === true) {
                  setNotify(Object.assign({}, notify, { desktop: false }));
                  return;
                }
                setNotify(Object.assign({}, notify, { desktop: true }));
                // 打开开关时才去申请授权（不在页面加载时就弹框骚扰）
                if (notifyAvailable() === true && notifyPermission() === 'default') {
                  try {
                    var req = window.Notification.requestPermission();
                    if (req !== null && typeof req.then === 'function') {
                      req.then(function (result) {
                        if (result !== 'granted') setToast('桌面通知没拿到授权，只能在面板里提示');
                      }).catch(function () { /* 忽略 */ });
                    }
                  } catch (error) { /* 老浏览器回调式，忽略 */ }
                }
              },
            }, '桌面通知 ' + (notify.desktop === true ? '开' : '关')),
            React.createElement('button', {
              key: 'sound',
              className: 'btcd-mini' + (notify.sound === true ? ' on' : ''),
              title: '收线预警时响一声（WebAudio 合成，不用音频文件）',
              onClick: function () { setNotify(Object.assign({}, notify, { sound: notify.sound !== true })); },
            }, '提示音 ' + (notify.sound === true ? '开' : '关')),
            React.createElement('button', {
              key: 'try', className: 'btcd-mini',
              title: '试一下：响一声 + 弹一条桌面通知（用来确认这两个通道是通的）',
              onClick: function () {
                var okSound = playAlertSound();
                var okDesk = sendDesktopNotice(instShort(inst) + ' 收线预警 · 测试', '这是一条测试通知：收线上穿 EMA20 · 收盘 84,724.6 / 均线 84,300.1');
                var parts = [];
                parts.push(okDesk ? '桌面通知已发' : (notifyAvailable() !== true ? '不支持桌面通知'
                  : (notifyPermission() === 'granted' ? '桌面通知发送失败' : '桌面通知未授权（先打开上面的开关）')));
                parts.push(okSound ? '响了' : '没响（浏览器要求先与页面交互过：点一下面板任意处再试）');
                // 邮件：配好了就顺手发一封测试邮件，一条按钮把三个通道都验掉。
                // 邮件是可选依赖：宿主没有 qqEmail 服务时不去空发请求，直接把"要装 dsh-qq-email"说清楚。
                var mail = alertStoreGet('email');
                if (mail.enabled === true && mail.available !== true) {
                  setToast(parts.join(' · ') + ' · 测试邮件发不出去：需要 dsh-qq-email 插件（插件市场可安装），装好并重启宿主后重试');
                  return;
                }
                if (mail.enabled === true) {
                  setEmailBusy(true);
                  sendTestEmail().then(function (out) {
                    setEmailBusy(false);
                    if (out.ok === true) {
                      setToast(parts.join(' · ') + ' · 测试邮件已发往 ' + String(out.to === undefined ? mail.to : out.to));
                    } else {
                      setToast(parts.join(' · ') + ' · 测试邮件没发出去：' + out.error);
                    }
                  });
                } else {
                  setToast(parts.join(' · '));
                }
              },
            }, '试一下')),
        ];
        // 邮件通道：填地址 → 确认一次 → 之后每封预警自动发往该地址。
        // 授权时机在这里（宿主没有 agent/turn，走不了 approval 服务）。
        (function () {
          var email = alertStoreGet('email');
          var busy = emailBusy === true;
          // 输入框的值：用户**没在编辑**时一律跟着服务端的值走 ——
          // 这样重开面板、或后台拉回新配置都会自动回填；正在编辑才保留用户敲的内容。
          var draft = emailEditedRef.current === true && emailDraft !== null ? emailDraft : email.to;
          /**
           * 按钮只有两种状态，按**当前真实情况**决定：
           *   `active` = 邮件提醒开着 **且** 当前地址已经被确认过。
           * 否则一律显示"开启"（红色）—— 包括"开着但地址变了、授权已失效"这种中间态：
           * 那时候点下去要**重新确认并开启**，而不是"关闭"。
           * 早先的按钮只看 `enabled`，于是"开着但授权失效"时按钮写的是"关闭"，
           * 点一下只会把 enabled 设成 false，用户看到的就是"填了地址却没有开启的按钮"。
           */
          var active = email.enabled === true && email.authorized === true;
          var label = active ? '关闭邮件提醒' : '开启邮件提醒';
          var rows = [];
          rows.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'email-top' },
            React.createElement('span', { className: 'btcd-hint' }, '邮件提醒'),
            React.createElement('input', {
              key: 'to', className: 'btcd-levels btcd-email-to', value: draft,
              spellCheck: false, placeholder: '收件邮箱，如 me@qq.com', 'aria-label': '预警邮件收件地址',
              title: '预警触发时把信息发到这个邮箱（可填多个，逗号分隔）',
              disabled: busy,
              onChange: function (event) {
                emailEditedRef.current = true;
                setEmailDraft(event.target.value);
              },
            }),
            React.createElement('button', {
              key: 'save',
              className: 'btcd-mini btcd-email-btn ' + (active ? 'btcd-email-btn-on' : 'btcd-email-btn-off'),
              disabled: busy,
              'aria-pressed': active,
              title: email.available !== true
                ? '邮件提醒不可用：需要安装并启用 dsh-qq-email 插件（插件市场「发现 / Discover」可搜到），装完重启宿主'
                : (active
                  ? '邮件提醒已开启（绿色）；点一下关闭 —— 地址会保留'
                  : (email.enabled === true && email.authorized !== true
                    ? '开关是开的，但当前地址还没被确认；点一下重新确认并开启'
                    : '邮件提醒当前关闭（红色）；填好地址后点这里开启，会先请你确认一次')),
              onClick: function () {
                var wantOn = active !== true;
                var to = draft.trim();
                // 邮件是可选依赖：缺 qqEmail 服务时不弹确认、不发请求，直接给可执行的安装提示。
                if (wantOn && email.available !== true) { setToast(EMAIL_MISSING_PLUGIN_HINT); return; }
                if (wantOn && to === '') { setToast('先填一个收件邮箱地址'); return; }
                // 要开启、且地址与已确认的不一致（含"开着但授权失效"）→ 先弹确认
                var same = email.confirmed !== '' && email.confirmed.toLowerCase() === to.toLowerCase();
                if (wantOn && same !== true) {
                  var ask = '开启后，每条命中的预警都会自动发到：\n\n' + to
                    + '\n\n发件人是当前已授权的 QQ 邮箱。确认用这个地址接收吗？';
                  var agreed = true;
                  try {
                    agreed = typeof window === 'undefined' || typeof window.confirm !== 'function'
                      ? true : window.confirm(ask);
                  } catch (error) { agreed = true; }
                  if (agreed !== true) { setToast('已取消，没有开启邮件提醒'); return; }
                }
                setEmailBusy(true);
                // 关闭时**不带地址**：后端在地址为空时原样保留已存的值，
                // 前端也不该做"关闭 = 清空地址"这种自作主张（真踩过）。
                // 开启时 confirm 只在"地址需要重新授权"时才置 true。
                saveEmailConfig(
                  { enabled: wantOn, to: wantOn ? to : '' },
                  wantOn && same !== true,
                ).then(function (out) {
                  setEmailBusy(false);
                  if (out.ok !== true) {
                    // **失败时保留用户刚敲的地址**：这时候清掉草稿会把输入框打回
                    // 服务端的旧值（甚至空值），看起来就是"地址丢了"（真踩过）。
                    setToast('邮件设置没保存：' + out.error);
                    return;
                  }
                  // 成功才交回控制权给服务端的值
                  emailEditedRef.current = false;
                  setEmailDraft(null);
                  setToast(wantOn ? '邮件提醒已开启 → ' + out.email.to : '邮件提醒已关闭（地址保留）');
                }).catch(function (error) {
                  // 双保险：`saveEmailConfig` 自己已经 catch 过了，这里再兜一层，
                  // 保证按钮**无论如何**都会恢复可点（卡在 disabled 太难查了）。
                  setEmailBusy(false);
                  setToast('邮件设置没保存：' + String((error && error.message) || error));
                });
              },
            }, label)),
          );
          if (email.enabled !== true && email.confirmed !== '') {
            rows.push(React.createElement('div', { className: 'btcd-emapanel-foot', key: 'email-off' },
              '已确认地址：' + email.confirmed + '（邮件提醒当前关闭，地址保留着）'));
          }
          // 邮件是可选依赖：没有 qqEmail 服务时**不等用户踩坑才发现**，面板里直接给安装提示。
          if (email.available !== true) {
            rows.push(React.createElement('div', {
              className: 'btcd-emapanel-foot btcd-alert-diag-bad',
              key: 'email-state',
            }, EMAIL_MISSING_PLUGIN_STATE));
          } else if (email.enabled === true || email.to !== '') {
            var state = email.enabled !== true
              ? '邮件提醒当前关闭 —— 地址已填好，点右边的按钮开启'
              : (email.authorized === true
                ? '✅ 收件地址已确认，命中时会自动发送'
                : '⚠️ 当前地址还没被确认（地址改过？）—— 点右边的「开启邮件提醒」重新确认');
            var ok = email.enabled === true && email.authorized === true;
            rows.push(React.createElement('div', {
              className: 'btcd-emapanel-foot' + (ok ? '' : (email.enabled === true ? ' btcd-alert-diag-bad' : '')),
              key: 'email-state',
            },
            state,
            email.sentCount > 0 ? ' · 已发 ' + String(email.sentCount) + ' 封' : '',
            email.lastSentAt === null ? '' : ' · 最近 ' + fmtTime(email.lastSentAt, 0, true),
            email.lastError === null ? '' : ' · 最近一次失败：' + email.lastError));
          }
          alertKids.push(React.createElement('div', { className: 'btcd-email-block', key: 'email' }, rows));
        })();
        for (var ai = 0; ai < alerts.length; ai += 1) {
          var boundHere = alerts[ai].bar === bar && alerts[ai].bar !== '';
          alertKids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'r' + alerts[ai].id },
            React.createElement('button', {
              key: 'dir',
              className: 'btcd-mini' + (alerts[ai].dir === 'down' ? ' btcd-alert-down' : ' btcd-alert-up'),
              title: '切换方向：上穿 / 下穿',
              onClick: function (id, dir) {
                return function () { setAlerts(function (p) { return alertSetDir(p, id, dir === 'up' ? 'down' : 'up'); }); };
              }(alerts[ai].id, alerts[ai].dir),
            }, alertDirInfo(alerts[ai].dir).arrow + ' ' + alertDirInfo(alerts[ai].dir).label),
            // 绑哪条均线：点一下在"当前所有均线"里轮换（用户报过"只能绑 EMA20"）
            React.createElement('button', {
              key: 'ema',
              className: 'btcd-mini' + (emaPeriods.indexOf(alerts[ai].emaPeriod) >= 0 ? ' on' : ' btcd-alert-down'),
              title: emaPeriods.length === 0
                ? '还没有均线：先去「均线管理」加一条，规则才绑得上'
                : (emaPeriods.length === 1
                  ? '只有一条均线（EMA' + String(emaPeriods[0]) + '）'
                  : '点一下换绑另一条均线：' + emaPeriods.map(function (p) { return 'EMA' + String(p); }).join(' / ')),
              onClick: function (id, current) {
                return function () {
                  setAlerts(function (p) { return alertSetPeriod(p, id, alertNextPeriod(current, emaPeriods)); });
                };
              }(alerts[ai].id, alerts[ai].emaPeriod),
            }, 'EMA' + String(alerts[ai].emaPeriod)),
            React.createElement('span', {
              key: 'at',
              className: 'btcd-hint' + (boundHere ? '' : ' btcd-alert-elsewhere'),
              title: boundHere
                ? '这条规则在当前周期（' + String(alerts[ai].bar) + '）上生效'
                : '这条规则绑在 ' + (alerts[ai].bar === '' ? '未知周期' : alerts[ai].bar) + ' 上，切过去才会判',
            }, boundHere ? '本周期 ' + String(alerts[ai].bar) : (alerts[ai].bar === '' ? '周期未知' : String(alerts[ai].bar))),
            React.createElement('span', { key: 'sp', className: 'btcd-spacer' }),
            React.createElement('button', {
              key: 'on', className: 'btcd-mini' + (alerts[ai].on !== false ? ' on' : ''),
              title: alerts[ai].on !== false ? '已启用，点击暂停' : '已暂停，点击启用',
              onClick: function (id) { return function () { setAlerts(function (p) { return alertToggle(p, id); }); }; }(alerts[ai].id),
            }, alerts[ai].on !== false ? '已启用' : '已暂停'),
            React.createElement('button', {
              key: 'del', className: 'btcd-mini btcd-danger',
              title: '删除这条规则',
              onClick: function (id) { return function () { setAlerts(function (p) { return alertRemove(p, id); }); }; }(alerts[ai].id),
            }, '删除')));
        }
        if (alerts.length === 0) {
          alertKids.push(React.createElement('div', { className: 'btcd-emapanel-row', key: 'empty' },
            React.createElement('span', { className: 'btcd-hint' },
              '还没有预警规则。点右上角「＋ 新增规则」加一条；'
              + '没有均线时先去「均线管理」加一条（规则要绑在一条均线上）。')));
        }
        // 预警记录：持久化的那份（刷新/重开都还在），支持清空
        if (alertLog.length > 0) {
          var logWrapKids = [];
          for (var li = 0; li < Math.min(12, alertLog.length); li += 1) {
            var rec = alertLog[li];
            logWrapKids.push(React.createElement('div', {
              className: 'btcd-emapanel-row btcd-alert-logrow', key: 'l' + rec.id,
              title: rec.text + (rec.bar === '' ? '' : '（' + rec.bar + ' 周期）'),
            },
            React.createElement('span', {
              key: 'd', className: rec.dir === 'down' ? 'btcd-alert-down' : 'btcd-alert-up',
            }, alertDirInfo(rec.dir).arrow),
            React.createElement('span', { key: 't', className: 'btcd-alert-logtime' },
              alertLogTime(rec, barMs)),
            React.createElement('span', { key: 'x', className: 'btcd-alert-logtext' },
              (rec.bar === '' ? '' : rec.bar + ' ') + rec.text)));
          }
          if (alertLog.length > 12) {
            logWrapKids.push(React.createElement('div', { className: 'btcd-hint', key: 'logmore' },
              '还有 ' + String(alertLog.length - 12) + ' 条更早的记录（存储里都在，这里只显示最近 12 条）'));
          }
          alertKids.push(React.createElement('div', { className: 'btcd-emapanel-foot btcd-alert-loghead', key: 'loghead' },
            React.createElement('span', null, '预警记录（' + String(alertLog.length) + ' 条，最多留 ' + String(ALERT_MAX_HISTORY) + '）'),
            React.createElement('span', { className: 'btcd-spacer' }),
            React.createElement('button', {
              key: 'clear', className: 'btcd-mini btcd-danger',
              title: '清空全部预警记录（不可撤销）',
              onClick: function () {
                setAlertLog([]);
                setUnread(0);
                setToast('预警记录已清空');
              },
            }, '清空记录')));
          alertKids.push(React.createElement('div', { className: 'btcd-alert-logwrap', key: 'logwrap' }, logWrapKids));
        } else {
          alertKids.push(React.createElement('div', { className: 'btcd-emapanel-foot', key: 'logempty' },
            '还没有预警记录。命中一次就会记一条在这里，关掉看板、刷新页面都还在。'));
        }

        // 判据日志：每次判定为什么中/不中。这是"没告警"时唯一能查的东西。
        alertKids.push(React.createElement('div', { className: 'btcd-emapanel-foot btcd-alert-loghead', key: 'evalhead' },
          React.createElement('span', null, '判据日志（' + String(evalLog.length) + ' 条，最多留 ' + String(ALERT_MAX_EVALS) + '）'),
          React.createElement('span', { className: 'btcd-spacer' }),
          React.createElement('button', {
            key: 'copy', className: 'btcd-mini',
            title: '把自检 + 判据 + 规则整理成文本复制到剪贴板（排障时贴给别人看）',
            onClick: function () {
              var text = formatEvalDiag({
                at: Date.now(), bar: bar, rules: alerts.length,
                health: diag === null ? null : diag.health,
                cursor: diag === null ? null : diag.cursor,
                fires: diag === null ? 0 : diag.fires,
                expect: diag === null ? 0 : diag.expect,
                error: diag === null ? null : diag.error,
                evals: evalLog.slice(0, 20),
              });
              copyToClipboard(text).then(function (ok) {
                setToast(ok ? '自检信息已复制到剪贴板' : '复制失败（可展开下面自己抄）');
              });
            },
          }, '复制自检'),
          React.createElement('button', {
            key: 'clreval', className: 'btcd-mini btcd-danger',
            title: '清空判据日志',
            onClick: function () { setEvalLog([]); setToast('判据日志已清空'); },
          }, '清空')));
        if (evalLog.length === 0) {
          alertKids.push(React.createElement('div', { className: 'btcd-emapanel-foot', key: 'evalempty' },
            '还没有判据。等下一次收线就会记一条：那根的时间、前收/今收、前均/今均，以及为什么中/不中。'
            + '（判定由常驻引擎执行 —— 这个看板关着也会继续判。）'));
        } else {
          // 按"收线时刻"分组：一次收线给每条规则各写一条，平铺看起来像重复；
          // 分组后一根一行，缺哪几分钟、断档多久都直接看得出来。
          var groups = groupVerdicts(evalLog);
          var evalKids = [];
          for (var gi = 0; gi < Math.min(8, groups.length); gi += 1) {
            var g2 = groups[gi];
            var anyHit = false;
            for (var ii = 0; ii < g2.items.length; ii += 1) if (g2.items[ii].verdict === 'hit') anyHit = true;
            evalKids.push(React.createElement('div', {
              className: 'btcd-alert-evalrow', key: 'g' + g2.key,
            },
            React.createElement('span', {
              key: 'v', className: anyHit ? 'btcd-alert-up' : 'btcd-alert-elsewhere',
            }, anyHit ? '✔' : '·'),
            React.createElement('span', { key: 't', className: 'btcd-alert-logtime' },
              (g2.bar === '' ? '' : g2.bar + ' ') + fmtTime(g2.at, 0, true)),
            React.createElement('span', { key: 'x', className: 'btcd-alert-logtext' },
              '收线 ' + fmtTime(g2.ts, barMs, true)
              + (g2.nowClose === null ? '' : ' 今收 ' + fmtPrice(g2.nowClose) + ' / 今均 ' + fmtPrice(g2.nowEma)
                + '（前收 ' + fmtPrice(g2.prevClose) + ' / 前均 ' + fmtPrice(g2.prevEma) + '）')),
            React.createElement('span', { key: 'sp', className: 'btcd-spacer' }),
            // 断档：与上一根（更早那根）之间的间隔，超过 1.5 根就标出来
            (function () {
              var gap = verdictGapMs(groups, gi);
              if (gap === null || barMs === 0) return null;
              return gap > barMs * 1.5
                ? React.createElement('span', { key: 'gap', className: 'btcd-alert-gap' },
                  '上一根在 ' + fmtDur(gap) + ' 前')
                : null;
            })()));
            // 逐条规则的原因不再平铺 —— 一根一行就够看。
            // 判据仍然完整存在数据里（`evalLog` 与「复制自检」导出都带着 verdict 与四个数字），
            // 需要查"为什么没中"时用导出，不占界面。
          }
          if (groups.length > 8) {
            evalKids.push(React.createElement('div', { className: 'btcd-hint', key: 'evalmore' },
              '还有 ' + String(groups.length - 8) + ' 根更早的判据（存储里都在，共 '
              + String(evalLog.length) + ' 条）'));
          }
          alertKids.push(React.createElement('div', { className: 'btcd-alert-logwrap', key: 'evalwrap' }, evalKids));
        }
        children.push(React.createElement('div', { className: 'btcd-emapanel btcd-alertpanel', key: 'alertpanel' }, alertKids));
      }

      // 回测面板：自包含组件（表单 / 策略列表 / job 轮询 / 结果都在它内部）。
      // 只在这一行挂载：关掉就卸载，下次打开由它自己 GET status 恢复上次结果。
      if (showBacktestPanel) {
        children.push(React.createElement(BacktestBoard, {
          key: 'btpanel',
          onClose: function () { setShowBacktestPanel(false); },
          instId: inst,
        }));
      }

      // 图表：拖动平移、滚轮缩放、双击回最新（触摸同样走 pointer 事件）
      var chartWrapKids = [React.createElement(Chart, {
        key: 'chart',
        instId: inst,
        candles: fullCandles,
        // 均线：整条序列（含预热）在这里算好，Chart 负责按窗口切片。
        // 不再取 Host 发来的 ema20/ema480 —— 那是写死两条、且只有展示窗口那一段。
        lines: emaLines,
        barMs: barMs,
        view: view,
        onView: setView,
        tool: tool,
        levels: parseFibLevels(levelsText),
        snap: snap,
        // 画布左上角图例：点它会回调这里来开关对应的均线
        onToggleEma: drawApiRef.current.toggleEma,
        drawings: drawings,
        selectedId: selectedId,
        onAdd: drawApiRef.current.add,
        onUpdate: drawApiRef.current.update,
        onSelect: drawApiRef.current.select,
        // 画完一条就退出工具（回到平移），见 Chart 的 onPointerUp
        onToolDone: drawApiRef.current.toolDone,
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

      // 底部这一行只留「可视区间统计」与操作提示 ——
      // EMA 的图例（色块 + 名称 + 当前值）已经画在**画布左上角**（点它可开关），
      // 这里再放一份就是重复信息。
      var legendKids = [
        React.createElement('span', { key: 'ema-hint', className: 'btcd-hint' },
          emas.length === 0
            ? '没有均线：点工具条上的「新增」加一条'
            : '左上角图例可点击开关均线（共 ' + String(emas.length) + ' 条）'),
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
        '拖动平移 · 滚轮缩放 · 双击复位 · ←→ 平移 · Ctrl+↑↓ 缩放 · 1-6 切周期 · Alt+H 开关均线'));
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
        'aria-label': 'OKX ' + instShort(inst) + ' 合约价格看板',
        tabIndex: -1,
        ref: panelRef,
      }, children));
    }

    // ------------------------------------------------------------------ 侧边栏入口

    function SidebarButton(props) {
      var inst = useInstStore();
      var price = usePrice(false, inst);
      var alerts = useAlertStore('alerts');
      var unread = useAlertStore('unread');
      var armed = 0;
      for (var i = 0; i < alerts.length; i += 1) if (alerts[i].on !== false) armed += 1;
      // 旧版 Host 的 /price 不认识 instId（会回 BTC）：标的对不上时宁可不显示价格，
      // 也不要把 BTC 的价格挂在 ETH 按钮上。
      var priceMatchesInst = price !== null && price !== undefined && normalizeInstId(price.instId) === inst;
      var summary = priceMatchesInst && price.price !== null && price.price !== undefined ? price.price : null;
      var up = summary === null || summary.changePct === null ? true : summary.changePct >= 0;
      var text = summary === null
        ? '📊 ' + instShort(inst)
        : '📊 ' + Math.round(summary.last).toLocaleString('en-US') + ' ' + (up ? '▲' : '▼') + Math.abs(summary.changePct).toFixed(2) + '%';
      var title = instShort(inst) + ' 合约 K 线看板（OKX）：最新价 + 1m/3m/15m/1h/4h/1D + EMA20/EMA480'
        + (armed > 0 ? '；收线预警常驻执行中（' + String(armed) + ' 条规则）' : '');
      return React.createElement('button', {
        type: 'button',
        className: 'btcd-ico',
        title: title,
        onClick: props.toggle,
      }, React.createElement('span', { key: 'text', className: up ? 'btcd-up' : 'btcd-down' },
        (props.wide === true ? text : '📊')),
      unread > 0
        ? React.createElement('span', {
          key: 'dot', className: 'btcd-alert-dot',
          title: String(unread) + ' 条未读预警',
        }, unread > 99 ? '99+' : String(unread))
        : null);
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      injectCss();
      // 预警存储在这里就读一次：两个视图（侧边栏按钮 / 看板）谁先挂载都能拿到同一份数据。
      alertStoreLoad();
      // 当前标的同理：侧边栏按钮与看板读到同一个选择（默认 BTC）
      instStoreLoad();
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
              // 引擎**永远挂着**（它只渲染 null），看板才是按需挂载的。
              // 两者写的是同一份 `ALERT_STORE`，所以关掉看板不影响判定。
              // 放在 overlay 槽里而不是侧边栏：overlay 的生命周期跟着插件走，
              // 侧边栏槽位在某些布局下会被卸载（收窄侧边栏时），不适合承载常驻任务。
              return React.createElement(React.Fragment, null,
                React.createElement(AlertEngine, { key: 'engine' }),
                open === true
                  ? React.createElement(Dashboard, {
                    key: 'panel', close: function () { store.setOpen(false); },
                  })
                  : null);
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
        AlertEngine: AlertEngine,
        ALERT_STORE: ALERT_STORE,
        alertStoreLoad: alertStoreLoad,
        runAlertEngine: runAlertEngine,
        alertStoreGet: alertStoreGet,
        alertStoreSet: alertStoreSet,
        Dashboard: Dashboard,
        // 回测面板（自包含组件 + 纯函数）：离线测试可以直接渲染 / 断言换算
        BacktestBoard: BacktestBoard,
        btBuildForm: btBuildForm,
        btDateMs: btDateMs,
        btDateText: btDateText,
        btRateFromPercent: btRateFromPercent,
        btBarMs: btBarMs,
        btKpiItems: btKpiItems,
        btDrawEquityChart: btDrawEquityChart,
        BT_STORE_KEY: BT_STORE_KEY,
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
        snapToViewOhlc: snapToViewOhlc,
        ohlcLabelOf: ohlcLabelOf,
        measureStats: measureStats,
        emaLegendItems: emaLegendItems,
        legendVisible: legendVisible,
        legendRowAt: legendRowAt,
        legendRect: legendRect,
        legendHit: legendHit,
        LEGEND: LEGEND,
        // 均线列表：模型与增删改
        normalizeEmas: normalizeEmas,
        defaultEmas: defaultEmas,
        emaAdd: emaAdd,
        emaRemove: emaRemove,
        emaUpdate: emaUpdate,
        emaPickColor: emaPickColor,
        emaLabel: emaLabel,
        emaNewId: emaNewId,
        EMA_DEFAULT_COLORS: EMA_DEFAULT_COLORS,
        EMA_DEFAULT_PERIODS: EMA_DEFAULT_PERIODS,
        EMA_MAX_LINES: EMA_MAX_LINES,
        EMA_PERIOD_MAX: EMA_PERIOD_MAX,
        EMA_PERIOD_MIN: EMA_PERIOD_MIN,
        EMA_STORE_KEY: EMA_STORE_KEY,
        // 收线预警：规则模型 / 穿越判定 / 游标
        ALERT_STORE_KEY: ALERT_STORE_KEY,
        ALERT_LOG_KEY: ALERT_LOG_KEY,
        EMAIL_STORE_KEY: EMAIL_STORE_KEY,
        ALERT_EVAL_KEY: ALERT_EVAL_KEY,
        normalizeEmail: normalizeEmail,
        alertEmailPayload: alertEmailPayload,
        ALERT_MAX_EVALS: ALERT_MAX_EVALS,
        normalizeEvalLog: normalizeEvalLog,
        evalLogAdd: evalLogAdd,
        groupVerdicts: groupVerdicts,
        verdictGapMs: verdictGapMs,
        formatEvalDiag: formatEvalDiag,
        evalAlertVerdict: evalAlertVerdict,
        verdictText: verdictText,
        VERDICT_TEXT: VERDICT_TEXT,
        copyToClipboard: copyToClipboard,
        ALERT_MAX_HISTORY: ALERT_MAX_HISTORY,
        alertRecordKey: alertRecordKey,
        normalizeAlertLog: normalizeAlertLog,
        alertLogAdd: alertLogAdd,
        alertLogTime: alertLogTime,
        ALERT_MAX: ALERT_MAX,
        ALERT_DIRS: ALERT_DIRS,
        ALERT_MIN_BARS: ALERT_MIN_BARS,
        candleHealth: candleHealth,
        alertDirInfo: alertDirInfo,
        alertNewId: alertNewId,
        normalizeAlerts: normalizeAlerts,
        alertAdd: alertAdd,
        alertRemove: alertRemove,
        alertToggle: alertToggle,
        alertSetDir: alertSetDir,
        alertSetPeriod: alertSetPeriod,
        alertNextPeriod: alertNextPeriod,
        alertLabel: alertLabel,
        evalAlert: evalAlert,
        evalAlerts: evalAlerts,
        closedAlertCursor: closedAlertCursor,
        // 通知渠道（桌面通知 / 提示音）
        NOTIFY_STORE_KEY: NOTIFY_STORE_KEY,
        normalizeNotify: normalizeNotify,
        notifyAvailable: notifyAvailable,
        notifyPermission: notifyPermission,
        sendDesktopNotice: sendDesktopNotice,
        playAlertSound: playAlertSound,
        emaFor: emaFor,
        emaSeries: emaSeries,
        emaWindow: emaWindow,
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
        // 画布上写死的颜色常量：导出是为了让测试能验"它们到底解析成什么值"。
        // 之前踩过：一次批量替换把 `var C_POPOVER_BG = 'rgba(...)'` 改成了
        // `var C_POPOVER_BG = C_POPOVER_BG`（自引用，运行期直接 ReferenceError），
        // 而当时所有断言只检查"画了圆角矩形/写了文字"，一个都没碰值，所以全绿通过。
        COLORS: {
          C_UP: C_UP,
          C_DOWN: C_DOWN,
          C_GRID: C_GRID,
          C_AXIS: C_AXIS,
          C_POPOVER_BG: C_POPOVER_BG,
          C_POPOVER_BG_SOFT: C_POPOVER_BG_SOFT,
          C_POPOVER_TEXT: C_POPOVER_TEXT,
          C_POPOVER_LABEL: C_POPOVER_LABEL,
          C_POPOVER_EDGE: C_POPOVER_EDGE,
          C_CROSSHAIR: C_CROSSHAIR,
          C_BAND: C_BAND,
          C_POINTER_DOT: C_POINTER_DOT,
          CURSOR_CROSS: CURSOR_CROSS,
          EMA_DEFAULT_COLORS: EMA_DEFAULT_COLORS,
        },
        fmtDur: fmtDur,
        fmtAgo: fmtAgo,
        fmtPrice: fmtPrice,
        fmtPct: fmtPct,
        fmtVol: fmtVol,
        fmtTime: fmtTime,
        closesOf: closesOf,
        parsePeriod: parsePeriod,
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
