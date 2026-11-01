# 回测集成到看板插件（v1.6）契约

> 目标：把已完成的 `backtest/` 框架接进 `plugin/dsh-btc-dashboard/`，看板里能直接选时间范围跑回测、
> 看资金曲线/指标/交易，并能打开完整 HTML 报告。**这是插件功能，不是 CLI 的附属品**。
>
> 三个写入方并行：Lead（Host 半 index.js + 路由测试 + 文档）、client-ui（client.js）、
> client-tests（tests/client-test.mjs）。接口与文案以本文为准，改契约先告知 Lead。

## 1. 总体结构

```
浏览器（client.js 新增「回测」面板）
  │  同源 fetch，全部走已有信任栅栏 /dsh-btc/*
  ▼
Host 半（index.js 新增 backtest service + 5 条路由）
  │  动态 import 工作区里的 backtest/lib/*.mjs（不复制代码，回测框架仍是唯一实现）
  ▼
backtest/ 框架（data/engine/metrics/report，已完成并通过自检）
```

关键约束：

- **回测在 Host 进程内跑**（不是 spawn CLI）：复用 `loadBars` 的 log 回调做进度、避免子进程管道问题、
  测试里可以注入依赖。回测是异步 job，路由立刻返回 jobId，浏览器轮询。
- 同一时间最多 1 个回测 job；再点返回「已有回测在跑」。
- 只读公开行情，不需要 API key；**不允许 client 传任意文件路径 / 策略路径 / dataDir / outDir**。
- 策略名只允许 `backtest/strategies/` 里的内置名（`listStrategies()` 白名单），**禁止路径**。
- Host 动态 import 回测目录：候选 `DSH_BTC_BACKTEST_DIR` 环境变量 → `<WORKSPACE>/backtest` →
  `resolve(HERE,'..','..','backtest')`；都找不到 → 路由返回中文错误「找不到回测框架目录」，
  不影响看板其它功能。**import 失败要缓存错误并给出人话**，不要每次请求都重试重抛。

## 2. Host API（全部 JSON；错误也用 HTTP 200 + `{ok:false,error}`，与现有路由一致）

### 2.1 `GET /dsh-btc/backtest/strategies`

```json
{
  "ok": true,
  "strategies": [
    { "name": "buy-hold", "params": {} },
    { "name": "sma-cross", "params": { "fast": 20, "slow": 60, "allowShort": false } }
  ],
  "bars": ["1m", "3m", "15m", "1h", "4h", "1D"],
  "defaults": {
    "instId": "BTC-USDT-SWAP", "bar": "1h", "initialCapital": 10000,
    "leverage": 1, "makerFeeRate": 0.0002, "takerFeeRate": 0.0005, "rangeDays": 30
  },
  "limits": { "maxBarsHint": 20000, "maxPages": 2000, "jobTimeoutMs": 1200000 },
  "job": null
}
```

`job` = 当前/最近一次 job 的**状态对象**（同 2.3，不含 summary 以外的大字段），没有则 `null`。
`params` 取策略默认值（`loadStrategy` 后 `strategy.params`）。`maxBarsHint` 给前端提示"预计根数偏大"。

### 2.2 `POST /dsh-btc/backtest/run`

请求体（额外字段一律忽略，不认识的策略/周期返回明确错误）：

```json
{
  "strategy": "sma-cross",
  "params": { "fast": 10, "slow": 30, "allowShort": false },
  "bar": "1h",
  "start": 1767225600000,
  "end": 1798761600000,
  "initialCapital": 10000,
  "leverage": 1,
  "makerFeeRate": 0.0002,
  "takerFeeRate": 0.0005
}
```

- `start/end` 是**毫秒时间戳**（前端把 UTC+8 日期换算好再发；Host 也接受 `YYYY-MM-DD` 字符串，
  统一交给 `normalizeConfig`）。
- `end` 表示**右开区间**；前端选"结束日期（含当日）"时自己 +1 天。
- 校验全部走 `normalizeConfig({ instId 固定, bar, start, end, initialCapital, leverage, makerFeeRate, takerFeeRate })`；
  另外校验策略名在 `listStrategies()` 白名单里、params 是扁平对象（数字/布尔/字符串，长度 ≤ 200 字符）。
- **规模防呆**：按 `(min(end, now) - start) / barMs` 估算根数，`ceil(根数/100) > maxPages(2000)` 时
  直接返回 `{ok:false, error:'区间太大：预计 … 页，超过单次回测上限 …'}`。不允许"跑 20 分钟再超时"，
  更不允许拿只覆盖一部分区间的结果当回测（那种结果用户根本不会注意到）。
- 成功 → `{ "ok": true, "job": { ...状态对象 } }`；已有任务在跑 → `{ "ok": false, "runningJobId": "bt-…", "error": "已有回测在跑（…），请等它结束或取消" }`；
- 失败 → `{ "ok": false, "error": "中文原因" }`。
- 启动后**异步**执行 §3 流程，接口立刻返回（`state:"running"`, `phase:"data"`）。

### 2.3 `GET /dsh-btc/backtest/status?jobId=…`

`jobId` 可省略 → 返回最近一次 job；没有任何 job → `{ ok:true, job:null }`。形状：

```json
{
  "ok": true,
  "job": {
    "id": "bt-1792237123456-ab12",
    "state": "queued|running|done|error|cancelled",
    "phase": "data|engine|metrics|report|done|error|cancelled",
    "message": "正在抓取历史 K 线…",
    "progress": { "pages": 12, "bars": 1200, "pct": null },
    "startedAt": 1792237123456,
    "finishedAt": null,
    "elapsedMs": 3421,
    "cancelRequested": false,
    "error": null,
    "summary": null
  }
}
```

- `message` 是给人看的中文进度（数据阶段直接透传 `loadBars` 的 log：`已抓取 N 页…`）。
- `summary` 只在 `state:"done"` 时非空，形状见 §2.5；`error` 只在 `state:"error"` 时非空。
- 轮询频率由前端定（约 800ms），Host 不做缓存。

### 2.4 `GET /dsh-btc/backtest/report?jobId=…&format=html|json`

- `format=html`（默认）：`content-type: text/html; charset=utf-8`，正文 = `buildHtmlReport()` 的字符串（报告本身零脚本/零外链）。
  必须加安全头：`content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`、
  `x-content-type-options: nosniff`、`cache-control: no-store`。
- `format=json`：`content-type: application/json; charset=utf-8`，正文 = `buildJsonReport()` 的完整对象。
- job 不存在 → `{ok:false,error:'没有这个回测任务'}`；还没跑完 → `{ok:false,error:'回测还没完成'}`；
  `state:"error"` → `{ok:false,error:job.error}`。

### 2.5 PanelSummary（`job.summary`，只在 done 时给）

```json
{
  "generatedAt": 1792237999000,
  "instId": "BTC-USDT-SWAP",
  "bar": "1h",
  "strategy": { "name": "sma-cross", "params": { "fast": 20, "slow": 60, "allowShort": false } },
  "start": 1767225600000,
  "end": 1798761600000,
  "range": { "bars": 8760, "firstT": 1767225600000, "lastT": 1798758000000, "days": 365.0 },
  "initialEquity": 10000,
  "finalEquity": 9730.97,
  "metrics": { "……backtest/lib/metrics.mjs 的完整 Metrics（SPEC §7）……" },
  "equity": [ { "t": 1767225600000, "equity": 10000, "bh": 10000 }, { "…": "最多 600 个点" } ],
  "trades": [ { "seq": 1, "side": "long", "qty": 0.11, "entryT": 0, "entryPrice": 0, "exitT": 0, "exitPrice": 0, "notional": 0, "fees": 0, "pnl": 0, "pnlPct": 0, "bars": 0, "exitReason": "strategy" } ],
  "tradeCount": 81,
  "fees": { "maker": 0, "taker": 729.11, "total": 729.11, "count": 162 },
  "liquidations": 0,
  "rejected": 0,
  "reports": { "html": "/backtest/report?jobId=bt-…&format=html", "json": "/backtest/report?jobId=bt-…&format=json" }
}
```

> ⚠️ `reports.*` 是**相对 API 前缀 `/dsh-btc` 的路径**（别写成 `/dsh-btc/backtest/...`）：
> 客户端统一用 `fetchJson(path)`（内部 `fetch(API + path)`）。

- `equity` 由 `result.equityCurve` **降采样到 ≤600 点**（等步长取样，首尾必留）；
  `bh` = Buy&Hold 权益序列 `initialCapital * bars[i].c / bars[0].c`（与 metrics 的基准口径一致）。
- `trades` 最多 500 条（超出取**最后** 500 条），`tradeCount` 给总数；`liquidations`/`rejected` 是**数量**。
- 不在 summary 里塞完整 `equityCurve`/`fills`/`logs`（那是完整报告的事，避免轮询报文过大）。

### 2.6 `POST /dsh-btc/backtest/cancel`

body `{ "jobId": "bt-…" }` → `{ ok:true, cancelled:true|false, job:{状态对象} }`。
只能取消 running/queued：置 `cancelRequested=true` 并把 `message` 改成「正在取消…」。
数据抓取阶段无法中途 abort（`loadBars` 不支持），在阶段切换时检查该标记 → `state:"cancelled"`。
已完成/不存在 → `cancelled:false` + 中文原因。

## 3. Job 执行流程（Host 内部）

```
job.state = 'running'
1) phase='data'    loadBars({instId, bar, start, end, dataDir(默认), fetcher(host 自建), log→job.message})
                   —— 进度：每页累计 progress.pages；log 文本原样进 message
2) phase='engine'  await 一个宏任务（让轮询先回包）→ runBacktest({bars, strategy, config})
3) phase='metrics' computeMetrics(result)
4) phase='report'  buildJsonReport + buildHtmlReport（内存持有 html/json 字符串）→
                   可选：writeReports() 落盘到 config.outDir（失败只记 warning，不影响 done）
5) phase='done'    job.summary = PanelSummary；state='done'
错误：state='error', error=中文；取消：state='cancelled'
超时：jobTimeoutMs（默认 20 分钟）到点置 cancelRequested + 在阶段边界转 cancelled
```

- **fetcher 注意**：Host 里必须用 `createOkxFetcher({ closeTunnels: false })`（transport.mjs 新增选项，
  默认 true 保持 CLI 行为）。原因：回测结束若调插件 `closeTransport()` 会把看板自己的 keep-alive
  隧道一起关掉，可能让同时进行的看板刷新失败。Host 结束时不要调 `closeTransport`。
- job 保留最近 5 个（Map + 顺序淘汰）；内存里保留 `html`/`jsonReport`/`summary`。
- 可测试性：`index.js` 导出 `createBacktestService(overrides)`，`overrides` 可注入
  `{ lib, loadBars, runBacktest, computeMetrics, buildJsonReport, buildHtmlReport, writeReports, normalizeConfig, listStrategies, loadStrategy, now }`；
  `apply(ctx, options)` 支持 `options.backtestService` 注入（route 测试用，默认 `createBacktestService()`）。

## 4. 浏览器端 UI（client.js）

### 4.1 入口

工具条「均线 / 预警」那一行再加一项：`回测` 按钮（`className:'btcd-tool'`，
打开时加 ` on`）。点击打开/关闭回测面板。面板放 `<div className="btcd-emapanel btcd-btpanel">`，
绝对定位、右上、宽 460px、`max-height: calc(100vh - 210px)`、内部滚动（复用 `.btcd-emapanel` 样式）。
`Esc` 关闭（和均线/预警面板一致的层级顺序）。

### 4.2 面板结构（文案是测试断言依据，别改字）

```
标题行：回测  （副标题：BTCUSDT 永续）        [关闭]
策略：<select> buy-hold / sma-cross           周期：<select> 1m/3m/15m/1h/4h/1D
参数：按策略 params 动态渲染（number → input[type=number]；boolean → checkbox；string → input）
时间范围：<input type="date" aria-label="开始日期"> ~ <input type="date" aria-label="结束日期">
          快捷按钮：近7天 / 近30天 / 近90天 / 近1年
初始资金：<input> 杠杆：<input> 挂单费率：<input> 吃单费率：<input>
        （费率显示为百分比输入，默认 0.0200 / 0.0500，提交时 /100）
提示行：预计 N 根 K 线（N > maxBarsHint 时加 ⚠ 文案「首次抓取可能较慢」）
[开始回测]  运行中：[取消]  完成后：[打开完整报告] [下载 JSON]
进度行：回测进行中 · <job.message>（含页数时显示）
结果区：
  回测完成 · 2026-01-01 ~ 2026-03-01 · 8,760 根
  KPI：总收益 / 年化收益 / 最大回撤 / 夏普 / 胜率 / 交易次数 / 手续费 / Buy&Hold
  资金曲线 canvas（权益 + Buy&Hold 虚线 + 回撤面积，尺寸随容器）
  交易明细表（最多 100 行）：# 方向 开仓 平仓 盈亏 手续费 原因
  错误：回测失败：<中文原因>
```

- 默认值来自 `/backtest/strategies` 的 `defaults`，策略默认取 `sma-cross`（前端定，不影响 CLI）。
- 表单值持久化到 `localStorage` key `dsh-btc-dashboard:backtest`（只存表单：strategy/params/bar/start/end 日期/capital/leverage/费率），
  打开面板时回填；非法/损坏值静默回默认。
- 日期按**北京时间 UTC+8**处理：`start = Date.parse('YYYY-MM-DDT00:00:00+08:00')`；
  `end = Date.parse('YYYY-MM-DDT00:00:00+08:00') + 86400000`（结束日期含当日）。
  日期默认：end = 今天（UTC+8），start = end - 30 天。
- 打开面板时：GET strategies + GET status（无 jobId）恢复上次结果。
- 运行：POST run → 拿 jobId → 每 800ms GET status?jobId=…，直到 state 不是 running/queued。
  任务进行中隐藏「开始回测」、显示「取消」；完成后恢复。
- 「打开完整报告」：fetch `summary.reports.html` → `response.text()` → `URL.createObjectURL(new Blob([html],{type:'text/html'}))`
  → `window.open(blobUrl, '_blank')`（blob 源隔离，不在同源里执行报告 HTML）。
- 「下载 JSON」：fetch json → Blob 下载，文件名 `backtest-<bar>-<strategy>-<jobId>.json`。
- 面板打开时若 job 还在跑（比如上次没关页面），继续轮询。
- 图表用独立 canvas（`className:'btcd-btchart'`），只需线 + 面积 + 坐标轴文字；不搞交互悬浮（v1）。

### 4.3 与现有代码的关系

- 不改变现有看板任何行为；新增状态尽量收在 `BacktestBoard` 组件内部（Dashboard 只加一个显示开关变量 + 按钮 + 渲染）。
- 颜色沿用 CSS 变量 `--btcd-up` / `--btcd-down` / brand；不引任何外部资源。
- 代码体积可控：新增尽量 ≤ 700 行，全中文注释、解释为什么。

## 5. 测试要求

- `tests/backtest-route-test.mjs`（Lead）：离线，`createBacktestService` 注入假 `loadBars`（合成 K 线），
  断言 run/status 轮询到 done / summary 形状 / 策略白名单拒绝路径 / 并发拒绝 / cancel / report html 头 / report json。
- `tests/client-test.mjs`（client-tests）：在 jsdom harness 的 `fakeFetch` 里加 `/backtest/*` 分支（记录 run/cancel 请求体、
  可切换 status 返回值），新增回测面板交互断言（见 §4.2 文案）：打开面板默认值、表单提交换算、轮询进度→完成渲染、
  错误态、取消、打开报告、参数输入、localStorage 回填、Esc 关闭。
- 原有全部测试（host/client/email/bundle/live + backtest 6 个）必须继续全绿。

## 6. 文档与版本

- `package.json` → `1.6.0`；`plugin/README.md` 补「回测面板」一节（入口、参数、口径、耗时/缓存、
  Host 半需重启、报告不落盘/可下载）；根 README 的「回测」小节补一句"看板里也能直接跑"。
- 根 README 的版本说明更新为 1.6.0，并写明 **Host 半有改动需重启宿主**；client 半刷新页面即可。
