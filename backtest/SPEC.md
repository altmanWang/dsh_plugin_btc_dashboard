# 回测框架规格（SPEC v1）

> 这份文件是**契约**：四个模块并行开发，接口、数据结构、口径都以这里为准。
> 改契约前先在团队里说一声（Lead 统一改），不要一边写实现一边偷偷改形状 ——
> 拼接时对不上，比功能少更浪费时间。

## 1. 目标与范围

做 **BTCUSDT 永续合约（OKX `BTC-USDT-SWAP`）** 的单标的回测框架：

- 历史 K 线驱动（`1m/3m/5m/15m/1h/4h/1D`，默认 `1h`）
- 可指定回测时间范围（默认最近 30 天）
- 默认 **1 倍杠杆**
- 手续费：**挂单（maker）0.0200% = 0.0002，吃单（taker）0.0500% = 0.0005**
- 撮合模型：市价单（taker）+ 限价单（maker），单方向净持仓
- 保证金与**爆仓**（近似）
- 资金曲线、逐笔成交、交易明细、绩效指标
- 输出：控制台摘要 + JSON + 自包含 HTML 报告 + 交易 CSV
- 历史 K 线**本地磁盘缓存**，重复回测不再联网
- 策略插件化：**本期内置 2 个示例策略**（`buy-hold` 基线、`sma-cross` 双均线），
  后续策略只需往 `backtest/strategies/` 加文件，不动引擎

**明确不做（v1，写进 README 的「局限」里）**：盘口深度与部分成交、
逐笔撮合、多标的/多仓位、对冲模式、一键反向的开平仓差异（OKX 的 `posSide`）、滑点分布模型
（只用固定 bps 市价滑点）、策略参数寻优。
（资金费率 v1 不做；**v1.7 追加**：CLI/宿主默认计入 funding，历史仅 OKX 近 3 个月，
更早区间按 `config.fundingRate` 固定估算，见 §6.7。）

**数据只用 OKX 公开行情接口，不需要任何 API key。** 绝不把 `.env` 里的密钥打进日志/报告。

## 2. 目录与写入范围（并行开发时各写各的）

```
backtest/
  SPEC.md              ← 本文档（Lead）
  README.md            ← 使用/设计/扩展文档（cli-strategies）
  run.mjs              ← CLI 入口（cli-strategies）
  lib/
    config.mjs         ← 默认参数 / 时间范围解析 / 配置校验（Lead，已完成）
    strategy.mjs       ← 策略定义与加载（Lead，已完成）
    transport.mjs      ← OKX HTTP 传输（代理/直连、重试、限速）（data-layer）
    data.mjs           ← 历史 K 线拉取 + 缺口填补 + 磁盘缓存（data-layer）
    engine.mjs         ← 撮合 / 手续费 / 杠杆保证金 / 爆仓 / 资金曲线（engine）
    metrics.mjs        ← 绩效指标（metrics-report）
    report.mjs         ← 控制台 / JSON / HTML / CSV（metrics-report）
  strategies/
    buy-hold.mjs       ← 基线：首根满仓做多持有（cli-strategies）
    sma-cross.mjs      ← 示例：双均线（cli-strategies）
  data/                ← K 线缓存（运行时生成，gitignore）
  reports/             ← 回测报告（运行时生成，gitignore）
tests/
  backtest-data-test.mjs        ← data-layer
  backtest-engine-test.mjs      ← engine
  backtest-metrics-test.mjs     ← metrics-report
  backtest-cli-test.mjs         ← cli-strategies
  backtest-integration-test.mjs ← Lead（离线端到端）
  backtest-live-test.mjs        ← Lead（真数据冒烟，联网；连不上就跳过）
```

禁止修改：`plugin/`（Lead 会补一个导出）、已有 `tests/*`、`README.md`（Lead 改）。

## 3. 通用约定

- **ESM `.mjs`，零第三方依赖**，Node ≥ 20（本机 v24）。不用 TypeScript、不用 npm install。
- 注释、报错、文档、报告文案一律**中文**（标识符英文）。
- 注释解释**为什么**，不是复述代码；踩坑/反直觉的地方必须写清楚（看已有代码风格）。
- 时间一律 **UTC 毫秒时间戳**（`bar.t` = 该 K 线**开盘**时间）。用户输入裸日期按**北京时间
  UTC+8** 解释；报告展示也统一 `YYYY-MM-DD HH:mm UTC+8`（用 `config.mjs` 的
  `formatTimeUtc8` / `formatDateTimeUtc8`，别各写一套）。
- 金额单位 USDT，数量单位 BTC（用 JS number，不引 decimal 库；框架目标是口径正确，不是清结算级精度）。
- 百分比字段统一是**百分数**（`12.34` 表示 12.34%），不是 0.1234。
- 无法计算的指标用 `null`，**绝不返回 `NaN` / `Infinity`**（JSON 里会变 null，HTML 里会变 "NaN"）。
- **不写死本机绝对路径**：目录名、`import.meta.url` 推导；默认值从 `config.mjs` 取。
- 所有联网前先查缓存；`offline` 模式下**一个网络请求都不许发**。
- 测试脚本：`node tests/backtest-xxx-test.mjs`，**默认离线**（注入假 fetcher / 合成 K 线），
  断言失败打印中文原因并 `process.exitCode = 1`，最后打印 `全部通过` / `N 项失败`。
  风格参考 `tests/host-test.mjs`（`ok`/`FAIL` 行 + 手工断言）。

## 4. 数据结构

```js
// K 线（升序、按 t 去重、只包含已收盘的）
Bar = { t: number, o: number, h: number, l: number, c: number, v: number }

// 归一化后的回测配置（config.mjs normalizeConfig() 的产物）
Config = {
  instId: 'BTC-USDT-SWAP',
  bar: '1h',                      // TIMEFRAMES id
  start: number,                  // 毫秒 UTC，含
  end: number,                    // 毫秒 UTC，不含
  initialCapital: 10000,          // USDT
  leverage: 1,
  makerFeeRate: 0.0002,           // 0.0200%
  takerFeeRate: 0.0005,           // 0.0500%
  slippageBps: 0,                 // 市价单固定滑点（基点，1bp = 0.01%）
  maintenanceMarginRate: 0.005,   // 维持保证金率（爆仓判定用，近似）
  limitFill: 'tradeThrough',      // 限价单成交判定：'tradeThrough' | 'touch'
  closeAtEnd: true,               // 回测结束时强制平仓（保证最终权益=已实现）
  dataDir: '<abs>',
  outDir: '<abs>',
  now: number,                    // 归一化时刻
  warnings: string[],
}
```

### 4.1 回测结果 BacktestResult（engine 产出，其余模块只读）

```js
BacktestResult = {
  ok: true,
  config: Config,                       // 原样带上（便于报告展示）
  strategy: { name: string, params: object },
  range: { start: number, end: number, bars: number, firstT: number, lastT: number },
  initialEquity: number,
  finalEquity: number,
  equityCurve: [                        // 每根 K 线收盘后一个点；长度 === bars
    { t, equity, cash, qty, price },    //   qty 是有符号持仓（正=多，负=空）
  ],
  fills: [                              // 全部成交（含开平、爆仓、期末平仓）
    {
      t, side: 'buy'|'sell', qty, price, notional, fee,
      feeKind: 'maker'|'taker', kind: 'market'|'limit',
      reason: string,                   // 下单原因，策略/引擎填，见 §6.6
      positionAfter: number,            // 成交后的有符号持仓
    },
  ],
  trades: [                             // 闭合交易（一次开→平的完整往返；部分平仓也记一条）
    {
      seq, side: 'long'|'short', qty,   // qty 是**被平掉**的数量（>0）
      entryT, entryPrice, exitT, exitPrice,
      notional,                         // entryPrice * qty
      fees,                             // 该笔往返分摊到的手续费合计（>0）
      pnl,                              // 净盈亏（已扣 fees）
      pnlPct,                           // pnl / notional * 100
      bars,                             // 持仓跨了几根 K 线（exitIndex - entryIndex）
      exitReason: string,
    },
  ],
  fees: { maker, taker, total, count },
  // v1.7 追加：资金费率结算汇总。total = paid - received（正=净支出，负=净收入）
  funding: {
    total, paid, received, count,
    events: [{ t, rate, qty, price, amount }],   // amount>0 = 付出
    meta: null | { intervalMs, fallbackRate, historicalCount, estimatedCount, uncovered, coverage, source, error },
  },
  liquidations: [{ t, price, qty, equityAfter }],
  rejected: [{ t, reason, order }],     // 杠杆/保证金不足被拒的委托
  logs: [{ t, message }],               // ctx.log()，上限 5000 条（超出丢最早的并记一条）
}
```

## 5. 模块接口

### 5.1 `lib/config.mjs`（Lead 已完成，直接用）

```js
TIMEFRAMES               // [{ id:'1m', okx:'1m', ms:60000, label:'1m' }, ..., { id:'1D' }]
DEFAULT_CONFIG           // 默认值（只读）
DEFAULT_MAKER_FEE_RATE   // 0.0002
DEFAULT_TAKER_FEE_RATE   // 0.0005
DEFAULT_LEVERAGE         // 1
barById(id)              // → TIMEFRAMES 项；未知抛错
isBarId(id)              // → boolean
parseRange({ start, end, now })  // 宽松时间输入 → { start, end }（毫秒 UTC）
normalizeConfig(raw)     // → Config；非法抛 Error（中文）；含 warnings
formatTimeUtc8(ms)       // 'YYYY-MM-DD HH:mm UTC+8'
formatDateTimeUtc8(ms)   // 同上（语义别名，均含时分）
formatDateUtc8(ms)       // 'YYYY-MM-DD'
```

`parseRange` 接受：毫秒数、`YYYY-MM-DD`、`YYYY-MM-DD HH:mm[:ss]`、ISO（带 Z/偏移）、
`now`、`now-30d` / `now-12h` / `now-4w`。裸日期按 UTC+8。`end` 超出 now 会被夹到 now 并警告。

### 5.2 `lib/transport.mjs`（data-layer）

```js
resolveProxy(options?)   // → { raw, host, port } | null
// 优先级：options.proxy（null/'off' = 强制直连）> process.env.DSH_BTC_PROXY / OKX_PROXY
//        > 工作区 .env 的同名键 > 默认 'http://127.0.0.1:7897'

createOkxFetcher(options?) // → { fetchPage, close, stats }
// options: { proxy?, timeoutMs = 12000, retries = 3, delayMs = 120, request?, log? }
//   request 可注入，签名 (target, url, headers, timeoutMs, proxy) → { status, body(Buffer) }
//   默认用 plugin/dsh-btc-dashboard/index.js 导出的 rawGet（复用它的代理隧道与直连兜底）
//   close() 调插件的 closeTransport()，让 CLI/测试能正常退出（否则 keep-alive 隧道挂住进程）

fetcher.fetchPage({ instId, okxBar, after, limit = 100 })
// → { ok: true, rows: Bar[] } | { ok: false, error: string }
// OKX history-candles：返回 ts < after 的、最新在前、每页最多 100 根。rows 保持接口原序。
// 自动：代理失败退直连（并记住上次成功的通道）、网络错误重试（退避 300/800/2000ms）、
//       HTTP 429 等 1200ms 后重试、请求间隔 ≥ delayMs（限速 20 req/2s 的常识值）
// 永不抛异常，失败一律 { ok:false, error:'中文原因' }
```

注意：`rawGet` 的 body 是 Buffer；`OKX_HOST = 'www.okx.com'`（直连时本机 DNS 会把它解析到
黑洞地址，所以默认走本地代理，本机实测代理可用）。

### 5.3 `lib/data.mjs`（data-layer）

```js
loadBars(options) // async
// options: {
//   instId = 'BTC-USDT-SWAP', bar, start, end,   // bar 是 TIMEFRAMES id；范围 [start, end)
//   dataDir = <backtest/data>, offline = false,
//   fetcher?,              // 注入用（测试）；不传则内部 createOkxFetcher()
//   proxy?, delayMs?, log?, now = Date.now(), maxPages = 2000,
// }
// → {
//   ok: boolean, error: string|null,
//   bars: Bar[],                                  // 升序，全部已收盘，且 start <= t < end
//   requested: { start, end },
//   coverage: { from, to } | null,                // 缓存/本次实际覆盖（毫秒）；无数据为 null
//   fetchedPages: number, fromCache: boolean,     // fromCache=true 表示本次没联网
//   warnings: string[],
// }

readBarFile(file) // → Bar[]；JSON：{bars:[[t,o,h,l,c,v],...]} 或 {bars:[{t,o,...}]} 或裸数组。
                  // 非法/降序抛中文 Error。CLI 的 --data 用它（离线复现与测试）。

// v1.7 追加：资金费率历史（OKX /public/funding-rate-history，只保留最近约 3 个月）
loadFundingRates({ instId?, start, end, dataDir?, offline?, fetcher?, now?, intervalMs?, maxPages?, log? })
// → { ok, error, rates: [{t, rate}], coverage: {from,to}|null, fromCache, fetchedPages,
//     warnings: string[], cacheFile }
// 缓存：<dataDir>/<instId>/funding.json
//   { version:1, instId, updatedAt, rates: [[t,rate],...] }（升序，每次结算一个点）
buildFundingEvents({ rates, start, end, fallbackRate?, intervalMs? })
// → { events: [{t, rate}], meta: { intervalMs, fallbackRate, historicalCount, estimatedCount,
//      uncovered:[[from,to],...], coverage } }
// 历史覆盖到的区间用真实费率，覆盖不到的区间按 fallbackRate 每 8h 生成估算点（对齐 UTC 结算网格）。
```

行为要求：

- **缓存文件**：`<dataDir>/<instId>/<bar>.json`，结构
  `{ version: 1, instId, bar, updatedAt, earliestKnown, segments: [[from,to],...], bars: [[t,o,h,l,c,v],...] }`。
  `earliestKnown` 是实现附加字段：记住交易所历史深度下界（往回翻到空页时写入），
  之后更早的请求不再重复翻几百页空区间；`readBarFile` 能直接吃这个缓存文件。
  transport 的 `fetchPage` 在 OKX 返回 `confirm` 时会把它附在 row 上（收线判断用），
  落盘与 `loadBars` 返回的 Bar 只保留六字段。
  原子写（写 `.tmp` 再 rename）。`segments` 必须合并相邻/重叠区间，用于判断"这段是否已有"。
- **只缓存已收盘 K 线**：`t + barMs <= now`，且 `confirm` 字段存在时必须为 `'1'`。
  range 的 `end` 也要按此夹紧（别把正在走的那根算进去）。
- **按缺口抓取**：`[start, end)` 减去缓存 segments 后逐段从 `after=段结束` 往回翻页，
  直到覆盖段起点或没有更早数据。早期数据不可用（如 1H 只到 2019-12 附近）时，
  把"实际能取到的最早一根"记成覆盖下界并给 warning，不要每跑一次都重试同一段。
- `offline: true`：完全用缓存；缺口没覆盖 → `ok:false, error:'离线模式下缓存没有覆盖 <区间>'`。
- 联网部分失败（网络/接口错误）但已有部分数据：`ok:true` + `warnings` 说明缺口；
  一根都没有才 `ok:false`。
- `maxPages` 防死循环；每页抓完调一次 `log?.('已抓取 N 页 …')`。
- 缓存里的时间戳/重复行要清洗（去重、升序、非法行丢弃）。

### 5.4 `lib/engine.mjs`（engine）

```js
runBacktest({ bars, strategy, config, funding?, fundingMeta? }) // 同步，纯 CPU，无 I/O
// → BacktestResult（§4.1）。输入非法抛 Error（中文）。策略回调抛错原样上抛。
// funding: [{ t, rate }]（升序可选；config.includeFunding=false 时忽略）
//   每个点在其所属 K 线区间 [bar.t, bar.t+barMs) 内结算：cash -= qty * bar.c * rate
// fundingMeta: 原样塞进 result.funding.meta（历史/估算统计，报告用）
```

成交/记账语义见 §6。**不要**自己算绩效指标（metrics 负责），也不要读文件。

### 5.5 `lib/metrics.mjs`（metrics-report）

```js
computeMetrics(result) // → Metrics（§9）。纯函数，不看 config 以外的文件。
```

### 5.6 `lib/report.mjs`（metrics-report）

```js
formatConsole(result, metrics, config) // → string（多行中文摘要，CLI 直接打印）
buildJsonReport({ result, metrics, config, strategy, generatedAt? }) // → 可 JSON.stringify 的对象
buildHtmlReport({ result, metrics, config, strategy, generatedAt?, bars? }) // → 自包含 HTML 字符串
//   bars：原始 Bar[]（可选）。给了就画「价格 K 线 + 持仓底纹 + 交易标记」小节；
//   不给就显示占位文案（旧调用方/只有 result 的场景不崩）。
writeReports({ result, metrics, config, strategy, outDir, bars }) // async
// → { jsonPath, htmlPath, csvPath }
// 文件名：<outDir>/<instId>-<bar>-<strategy>-<起始YYYYMMDD>-<结束YYYYMMDD>.<ext>
// 自动 mkdir -p。HTML 内联 SVG，不引任何外部资源（离线打开可用）。
```

控制台至少要有：配置摘要（标的/周期/时间范围/杠杆/手续费/初始资金）、绩效（总收益、年化、
最大回撤、Sharpe、Sortino、Calmar、波动率）、交易统计（次数/胜率/盈亏比/最大连亏）、
费用（maker/taker/合计）、基准对比（Buy&Hold）、爆仓次数、被拒委托数。
数值格式：金额 `1,234.56`，百分比 `12.34%`，比率 `2.31`，无值 `—`。

### 5.7 `lib/strategy.mjs` + `strategies/*.mjs` + `run.mjs`（cli-strategies）

```js
// lib/strategy.mjs（Lead 已完成）
defineStrategy({ name, params = {}, onStart?, onBar, onEnd? })  // → 校验后的策略对象
resolveParams(strategy, overrides = {})  // 合并默认参数；数字/布尔按默认值类型转换；未知键抛错
listStrategies()                         // → [{ name, file }]（读 strategies/ 目录，按名排序）
loadStrategy(nameOrPath)                 // async → 策略对象；未知名字抛中文 Error（附可用列表）
```

策略文件默认导出 `defineStrategy({...})` 的结果。第二个示例策略 `sma-cross` 的参数约定：
`fast=20, slow=60, allowShort=false`（周期单位 = 配置里的 K 线根数）。

CLI `run.mjs` 必须导出可测试的入口：

```js
export async function main(argv, io?)  // → Promise<number>（退出码）
// io = { out(line), err(line) }，默认走 process.stdout/stderr
// main 内**不要**调 process.exit()，不要直接写 stdout（测试注入 io）
```

参数（`--help` 要完整列出）：
```
--strategy <名字|文件>   默认 buy-hold
--start <时间> --end <时间>   默认：end=now、start=now-30d；裸日期按 UTC+8
--bar <1m|3m|5m|15m|1h|4h|1D>    默认 1h
--capital <USDT>         默认 10000
--leverage <倍数>        默认 1
--maker <费率>           默认 0.0002（也接受 0.0200% 写法）
--taker <费率>           默认 0.0005
--inst <instId>          默认 BTC-USDT-SWAP
--param key=value        策略参数，可重复
--data <file.json>       用本地 K 线文件替代联网（离线复现/测试）
--data-dir <目录> --out-dir <目录>
--offline                只读缓存，不联网
--json                   额外打印一份 JSON 摘要（含收益/回撤/交易数）
--list                   列出内置策略
--quiet                  只打印最终结果与报告路径
--help
```

流程：解析参数 → `normalizeConfig` → `loadStrategy` → `resolveParams` →（`--data` 用
`readBarFile`，否则 `loadBars`）→ `runBacktest` → `computeMetrics` → `formatConsole` +
`writeReports` → 打印报告路径。任何错误：中文信息打到 stderr、返回 1。
联网 fetcher 必须在 `finally` 里 `close()`（否则进程被 keep-alive 隧道挂住）。

`--data` 读进来的 K 线**也要按 `config.start/end` 过滤**（`start <= t < end`，与 `loadBars` 口径
一致）；过滤后为空 → 报「时间范围内没有 K 线」并返回 1。否则"换了时间范围但结果没变"这种
假回测最难查。

## 6. 引擎语义（最重要的口径）

### 6.1 循环顺序（第 i 根 K 线）

1. 执行上一根收盘决策排队的**市价单**：成交价 = `bar.o`（多头买入加正滑点、卖出减滑点），taker。
2. 处理**活跃限价单**（上一根收盘及更早挂的）：按本根 `h/l` 判成交，maker，成交价 = 限价。
3. **爆仓检查**：用本根不利极值（多 `bar.l`、空 `bar.h`）判断，见 §6.4。
4. 用 `bar.c` 盯市计算权益，写入 `equityCurve`。
5. 调 `strategy.onBar(ctx, bar, i)`：只能看到 `0..i` 的数据，产出的委托**下一根**才可能成交。

第 0 根 K 线只做 4/5（没有上一根的决策）；若第 0 根就有 onStart 下单，同样第 1 根才成交。
最后一根 onBar 产生的委托若直到结束都没成交，丢弃（记入 logs 可选）。

### 6.2 市价单

- 成交价：买 `open * (1 + slippageBps/1e4)`，卖 `open * (1 - slippageBps/1e4)`。
- 手续费 taker：`|qty| * price * takerFeeRate`，从现金扣。
- `ctx.target({side, weight})`：**在执行时**按下一根开盘价与当时权益换算
  `qtyTarget = ±(equity * leverage * weight) / fillPrice`，再下差值单；
  `weight ∈ [0, 1]`，`side: 'long' | 'short' | 'flat'`（flat 等价 weight=0）。
  若换算出的目标名义超过 `equity * leverage * (1+1e-9)` 或被拒 → 整单拒绝并记录 rejected。
- `ctx.market({side, qty | notional})`：qty 直接给数量；notional 在**提交时**按当前收盘价换算 qty。
- 反向（多→空/空→多）视为「先平后反」：平仓部分生成一条 trade，反向部分开新仓，两段各自计费。

### 6.3 限价单

- 挂单：`ctx.limit({ side, price, qty | notional, reduceOnly = false })`，提交时把 notional 按
  当前收盘价折成 qty 并固定下来；返回 id。下一根起参与撮合。
- 成交判定（`limitFill`）：
  - `tradeThrough`（默认，保守）：买 `bar.l < price` 才成交；卖 `bar.h > price` 才成交
  - `touch`：买 `bar.l <= price`；卖 `bar.h >= price`
- 成交价 = 限价（不做滑点），手续费 maker。
- `reduceOnly: true` 的限价单数量不超过当前持仓；没有持仓时直接作废（不报错）。
- 同一根 K 线多张限价单按提交先后依次撮合；每张最多成交一次（全成或全不成，无部分成交）。
- 策略可在 onBar 里 `ctx.cancel(id)` / `ctx.cancelAll()`；到期末没成交的丢弃。

### 6.4 杠杆、保证金与爆仓（近似）

- 净持仓模式：`qty` 有符号（正多负空），`avgEntry` 均价。
- 权益：`equity(price) = cash + qty * (price - avgEntry)`（持仓中）；平仓时把已实现盈亏
  加进 `cash`，所以平仓后 `equity = cash`。
- 已用保证金：`|qty| * price / leverage`；可用 = `equity(price) - 已用保证金`。
- 下单前检查：成交后 `|qty| * fillPrice / leverage <= equity(fillPrice)`（含 1e-9 容差），
  否则拒绝（rejected，中文原因「杠杆/保证金不足」）。
- 爆仓价（近似，忽略手续费与资金费）：
  - 多：`avgEntry * (1 - 1/leverage + maintenanceMarginRate)`
  - 空：`avgEntry * (1 + 1/leverage - maintenanceMarginRate)`
  当本根极值穿过爆仓价（多 `bar.l <= liqPrice`、空 `bar.h >= liqPrice`）时全平，
  成交价 = 爆仓价，taker 手续费，记 `liquidations` + 一条 `exitReason:'liquidation'` 的 trade。
  1 倍杠杆下多头爆仓价接近 0、空头在 2 倍价格附近 —— 这是对的，别为了"永远不爆"改公式。
- 权益可以为负（1 倍空头遇到超过 100% 的上涨），指标按实数算，不要夹到 0。

### 6.5 手续费与期末平仓

- taker：市价单、爆仓、期末平仓；maker：限价单成交。费率来自 config，默认 0.0002 / 0.0005。
- `fees` 汇总 maker/taker/total/count。
- `closeAtEnd: true`（默认）：最后一根收盘后按 `bar.c` 以 taker 平掉剩余持仓
  （`reason:'end'`），更新 `equityCurve` 最后一点的 equity/cash，最终 `finalEquity = cash`。
- v1.7 起**计入资金费率**（见 §6.7）；`config.includeFunding=false` 或未传 `funding` 时为 0。

### 6.6 下单 reason 约定

策略调用 ctx API 时可选 `reason`（字符串，默认 `'strategy'`）。引擎内部：`'liquidation'`、
`'end'`、target/market/limit 的默认 reason 见上。trade 的 `exitReason` 取平仓那笔 fill 的 reason。

### 6.7 资金费率（funding，v1.7 追加）

- 结算顺序：每根 K 线的「市价单 → 限价单 → 爆仓检查 → **资金费率结算** → 收盘盯市 → 策略 onBar」。
  结算点落在 `[bar.t, bar.t + barMs)` 内才结算；价格用当根收盘价 `bar.c` 近似（引擎没有逐笔标记价）。
- 金额：`amount = qty * bar.c * rate`（`qty` 有符号：多头付、空头收；`rate>0` 时多头付出）。
  `cash -= amount`，并记入 `result.funding.events`。
- 汇总：`result.funding = { total: paid - received, paid, received, count, events, meta }`；
  `meta` 由调用方传入（历史/估算次数、兜底费率、覆盖区间、数据源），引擎原样带回。
- 历史来源：OKX 公开接口只保留最近约 3 个月；更早区间由调用方按 `config.fundingRate`
  估算（默认 0.01%/8h），报告/控制台标注估算次数。严禁把估算结果标成历史。
- 未启用（`includeFunding:false`）或不传 `funding` 时：`result.funding` 全 0，与 v1.6 结果一致。

### 6.8 ctx（策略拿到的上下文）

```js
ctx.index      // 当前 bar 下标（0-based）
ctx.time       // bar.t
ctx.bar        // 当前 bar 的只读副本
ctx.params     // 合并后的策略参数（只读快照）——策略**只能从这里**读 --param 覆盖值
ctx.config     // 配置快照（只读：instId/bar/leverage/makerFeeRate/takerFeeRate/initialCapital）
ctx.equity     // 当前收盘价上的权益
ctx.cash
ctx.position   // { side:'long'|'short'|'flat', qty, entryPrice, notional, unrealizedPnl }
ctx.window(n)  // 最近 n 根 Bar（含当前），n>=1；返回副本，**绝不包含未来**
ctx.closes(n)  // 最近 n 个收盘价（含当前）
ctx.log(msg)   // 记一条日志（result.logs）
ctx.target({ side, weight, reason? })
ctx.market({ side:'buy'|'sell', qty?, notional?, reason? })
ctx.limit({ side:'buy'|'sell', price, qty?, notional?, reduceOnly?, reason? }) // → id
ctx.cancel(id) / ctx.cancelAll()
```

防未来函数：`window/closes` 只能用 `0..i`；返回的是副本（策略改它不影响引擎）。
若策略在 `onBar` 之外（onStart/onEnd）下单：onStart 的单排到第 1 根，onEnd 不允许下单（抛错）。

## 7. 绩效指标定义（metrics）

```js
Metrics = {
  bars, firstT, lastT, days,
  initialEquity, finalEquity,
  totalReturnPct, annualizedReturnPct,        // 年化用 365 天；不足 1 天 → null
  maxDrawdownPct, maxDrawdownPeakT, maxDrawdownTroughT,
  volatilityPct, sharpe, sortino, calmar,     // 年化；样本不足/标准差为 0 → null
  tradeCount, winningTrades, losingTrades, winRatePct,
  profitFactor, avgWin, avgLoss, payoffRatio, avgTradePnl, avgTradePct, expectancy,
  maxConsecutiveWins, maxConsecutiveLosses,
  feesMaker, feesTaker, feesTotal, feesPctOfCapital,
  // v1.7 追加：资金费率（净支出为正）
  fundingPaid, fundingReceived, fundingTotal, fundingCount,
  fundingEstimatedCount, fundingPctOfCapital, totalCostPctOfCapital,
  exposurePct,                                // 有持仓的 K 线占比
  liquidations,
  buyHoldReturnPct, buyHoldMaxDrawdownPct, buyHoldFinalEquity, // 现货基准：首根收盘买入、末根收盘
}
```

公式：
- bar 收益率 `r_i = equity_i / equity_{i-1} - 1`（跳过第 0 个点）
- 波动率 = `std(r) * sqrt(ppY) * 100`，`ppY = 365*24*3600*1000 / barMs`（24/7 市场，365 天）
- Sharpe = `mean(r)/std(r)*sqrt(ppY)`；Sortino = `mean(r)/sqrt(mean(min(r,0)^2))*sqrt(ppY)`
- 最大回撤 = `max(1 - equity/历史峰值)`，记录峰值/谷值时间
- Calmar = `annualizedReturnPct / maxDrawdownPct`（回撤为 0 → null）
- profitFactor = 盈利交易 pnl 之和 / |亏损交易 pnl 之和|（无亏损 → null，报告显示 `∞` 由 report 决定）
- payoffRatio = avgWin / |avgLoss|（无亏损 → null）
- winRatePct = 盈利交易数 / tradeCount * 100（无交易 → null）
- 连赢/连亏按 trades 顺序统计（pnl==0 不计入也不打断 —— 记录说明即可）
- exposurePct = equityCurve 中 qty != 0 的点数 / 总点数 * 100

## 8. 报告（report）

- `formatConsole` 用等宽中文对齐；不依赖颜色（重定向到文件也要能读）。
- JSON 报告：`{ generatedAt, framework:'btc-dashboard/backtest', config, strategy, result, metrics }`，
  result 里的 `equityCurve`/`fills`/`trades` 全量带上（可复现）。
- HTML：`<meta charset="utf-8">`、内联 CSS/SVG、no-JS 也能看；包含标题（标的/周期/策略/时间范围/
  杠杆/手续费/资金费率）、KPI 卡片、**价格 K 线图（传了 bars 时：蜡烛聚合到 ≤480 根、持仓底纹、开/平仓标记）**、
  资金曲线（含 Buy&Hold 基准）、回撤曲线、交易表（最多 500 行并注明截断）、
  配置表、局限说明。HTML 里的文本要转义。页脚有「报告格式 v3」标记（v3 = 含 K 线 + 资金费率）。
- CSV：交易明细表头英文（`seq,side,qty,entry_t,entry_price,exit_t,exit_price,pnl,pnl_pct,fees,bars,exit_reason`），
  时间用 UTC ISO（`2024-01-01T00:00:00Z`），便于 Excel/pandas。

## 9. 脚本约定

- 内置策略：`buy-hold`（第 1 根 onBar 满仓做多，持到期末）、`sma-cross`（快慢 EMA/MA 交叉：
  快线在慢线上方做多、下方平仓；`allowShort=true` 时下方做空）。
  实现要对齐 `ctx.target` 语义，不要在策略里自己记账。
- 后续追加（不改变契约）：`donchian-trend`（唐奇安突破 + 趋势均线过滤 + 可选 ATR 跟踪止损，
  推荐 4h）、`ema-regime`（EMA 交叉 + 趋势过滤 + ATR 止损）、`ma-hysteresis`（均线滞回带，
  推荐 4h：站上 MA×(1+enterBuffer) 持有、跌破 MA×(1-exitBuffer) 平仓）、`breakout-hold`
  （突破入场 + 均线滞回出场，推荐 4h；只做多主策略）、**`multi-tf-dual`（v1.8：4h 数据内部
  聚合 UTC 日线，日线 MA 与多日斜率定 regime，空头只在日线熊市开启；多头慢出场/空头快回补；
  推荐 4h，多空主策略）**、**`adaptive-dual`（v1.8：1D 周期，MA200 熊市闸门 + 非对称出场 +
  波动率目标仓位 + ATR 止损；1D 多空备选）**。指标递推逻辑在
  `backtest/lib/indicators.mjs`；参数扫描/训练验证工具在 `backtest/tools/sweep.mjs`；
  独立验证套件在 `backtest/tools/verify-dual.mjs`。
- `--param` 解析：`fast=10`、`allowShort=true`；未知参数由 `resolveParams` 报错。
- **策略参数从 `ctx.params` 读，不依赖 `this` 绑定**：CLI 用
  `withResolvedParams(strategy, overrides)` 得到 `params` 已合并的策略对象再交给引擎，
  引擎把它原样挂在 `ctx.params` 上（只读）。这样无论引擎怎么调用 `onBar`，
  `--param` 都不会静默失效。

## 10. 验收（每个模块自己的测试必须覆盖）

| 模块 | 测试文件 | 至少覆盖 |
| --- | --- | --- |
| data | `tests/backtest-data-test.mjs` | 分页拼装、缺口填补、缓存命中不再联网、offline 缺数据报错、未收盘 K 线剔除、readBarFile 两种格式、失败降级警告 |
| funding | `tests/backtest-funding-test.mjs` | 资金费率接口解析（realizedRate 优先/坏行丢弃）、缓存与离线、历史+估算拼接（8h 对齐/次数统计）、引擎结算（多付/空收/开关/时间窗）、metrics 字段、报告口径（v3/估算标注） |
| engine | `tests/backtest-engine-test.mjs` | taker/maker 费率、滑点、限价 tradeThrough/touch、目标仓位换算、杠杆拒绝、多→空反转两笔 trade、爆仓、closeAtEnd、无未来函数、手续费合计、equityCurve 长度 |
| metrics | `tests/backtest-metrics-test.mjs` | 手工算得的收益/回撤/Sharpe、无交易时全 null、连赢连亏、profitFactor/payoff、exposure、buyHold、formatConsole 关键字、HTML 自包含且转义、writeReports 三个文件 |
| cli | `tests/backtest-cli-test.mjs` | `main()` 注入 io、`--data` 离线端到端、默认费率/杠杆断言、报告文件生成、`--list`、`--help`、非法参数退出码 1 |

所有测试**默认不联网**。真数据冒烟由 Lead 的 `tests/backtest-live-test.mjs` 负责（连不上就跳过）。

## 11. 实现补充（契约冻结后各模块敲定的细节）

这些是 SPEC 原文没写死、实现时定下来的口径。改代码前先对一遍，别当成"可以随便改的细节"。

**数据层**
- 缓存文件多 `earliestKnown`（交易所最早可用时间），翻到空页时落盘；之后更早的请求直接夹掉并 warning，
  不重复翻空页。
- `fetchPage` 的 row 带 `confirm`（Bar 六字段之外的附加字段），沿到 `loadBars` 内部即剥离；
  落盘与返回的 Bar 只有 `{t,o,h,l,c,v}`。
- 已收盘边界 = `floor(now / barMs) * barMs`：比 `now - barMs + 1` 更稳（同一根 K 线内二次运行、
  尤其 offline 不会因边界漂移误报缺口），也避免假设交易所按 UTC 对齐 —— 实测 `1D` 按 **UTC+8 零点**对齐，
  `1m/1h/4h` 按 UTC 对齐。
- `segments` 语义：只记录"从缺口右端连续抓到的整段"；翻页时多抓到的更早 K 线也进缓存（下次更宽区间直接命中），
  但不会错误宣称覆盖。中途失败/触顶保留已抓部分，下次不重抓。
- fetcher 归属：`loadBars` 自建的在 `finally` 里 close；注入的由调用方 close（CLI 在 finally 关）。
- 真实深度（2026-10 实测）：`1m/1h/4h` 最早 2019-12-16 UTC，`1D` 最早 2019-11-28 UTC+8。
- **资金费率（v1.7）**：OKX `funding-rate-history` 只保留最近约 3 个月；`loadFundingRates` 缓存
  `<dataDir>/<instId>/funding.json`，`buildFundingEvents` 对未覆盖区间按 `config.fundingRate`
  （默认 0.01%/8h）每 8h 生成估算点；`--data` 离线复现模式默认**不计**资金费率。

**引擎**
- `ctx.params` 是 `Object.freeze({...strategy.params})` 只读快照；`result.strategy = { name, params }`。
- `ctx.position.qty` 有符号（正多负空），与 `equityCurve.qty` 一致；空仓 `entryPrice: null`。
- 保证金校验只发生在开仓/加仓/反手；减仓/平仓永远放行（亏到保证金不足也要能止损）。
  市价/目标仓在执行时校验，**限价单在成交那一刻校验**（不够则撤单并记 rejected）。
- 爆仓后撤销全部未成交限价单并记 log（真实强平会撤单，避免下一根出现无法解释的成交）。
- `onEnd` 在 `closeAtEnd` 之后调用（看到已实现状态），且 onEnd 禁止下单（抛中文错误）。
- 期末未成交委托直接丢弃，记一条 log（不进 rejected）。
- logs 最终最多 5000 条 = 4999 条真实日志 + 1 条截断说明。
- 滑点只作用于市价单/目标仓；爆仓与期末平仓不加滑点（成交价=爆仓价/最后收盘价）。
- `ctx.target` 是"差值单"：每根重复调用且价格漂移会产生小额再平衡单（多花手续费），
  策略应只在信号变化时下单。
- 多→空反转：一笔反向 fill 拆成「平仓 trade + 以成交价开反向新仓」，手续费按平/开数量比例分摊；
  加仓后部分平仓的 `entryT/entryPrice` 取持仓段起点/平仓时加权均价（近似口径，trade 级不追到每笔加仓）。

**指标/报告**
- 覆盖时长 `days = (lastT - firstT + barMs) / 1天`；年化 365 天复利，不足 1 天或期末权益 ≤ 0 → null。
- 波动率/Sharpe 用总体标准差（除以 n）；Sortino 下行偏差 `sqrt(mean(min(r,0)^2))`。
- 无亏损时 profitFactor/payoffRatio = null（JSON 里就是 null），控制台显示 `∞`；无交易显示 `—`。
- Buy&Hold 基准 = 现货、无杠杆、无手续费（首根收盘买入、末根收盘估值）。
- 控制台与 HTML **不输出本机绝对路径**；JSON 原样带 config（含 dataDir/outDir，供机器复现）。
- HTML 内联 CSS/SVG、零外部资源、零 `<script>`；动态文本全部转义；SVG 采样上限 720 点防大文件。
