# btc_dashboard

OKX BTC / ETH 合约价格看板的 DSH 插件工程。

```
.env                                    # OKX 密钥（生产 + 模拟/调试），仅用于确认「配了哪把钥匙」
.env.example                            # 密钥模板（只有占位符；行情接口本身不需要密钥）
.dashboard/state.json                   # 插件持久化的选择（环境 + 周期），已被 .gitignore 忽略
plugin/dsh-btc-dashboard/               # 插件本体（就是安装进 profile 的那份代码）
  ├─ index.js                           # Host 半：取数、代理隧道、EMA、路由
  ├─ client.js                          # 浏览器半：canvas 看图 + 周期/环境切换 + 画线
  ├─ package.json                       # dsh.bundle.patch + dsh.client 声明
  ├─ cordis.patch.yml                   # bundle 层：把 Host 半挂进 profile
  ├─ screenshots.json                   # 市场截图清单（dsh-market 详情页用；路径相对本文件）
  ├─ assets/screenshots/                # 截图：dashboard / alert / backtest
  └─ README.md                          # 实现细节、参数、路由、环境语义
backtest/                               # 回测框架（独立于看板；默认只读公开行情，不需要 API key）
  ├─ run.mjs                            # CLI 入口（--strategy/--start/--end/--bar/--leverage/--maker/--taker…）
  ├─ lib/                               # config / data / transport / engine / metrics / report / strategy
  ├─ strategies/                        # 内置策略：buy-hold（基线）、sma-cross（示例）、
  │                                     #           multi-tf-dual（4h 多空主策略）、adaptive-dual（1D 多空备选）、
  │                                     #           breakout-hold（只做多主策略）、donchian-trend、ema-regime、ma-hysteresis
  ├─ tools/sweep.mjs                    # 参数扫描（训练/验证切分，研究用）
  ├─ SPEC.md                            # 内部契约（接口/数据结构/撮合口径）
  ├─ README.md                          # 使用与设计文档（参数表、ctx API、局限）
  ├─ data/                              # 历史 K 线缓存（运行时生成，gitignore）
  └─ reports/                           # 回测报告产物（运行时生成，gitignore）
tests/                                  # 离线自检脚本（含 backtest-*.mjs 九个）
assets/icon-180.png                     # 插件市场卡片图标（awesome-dsh-plugin 条目的 icon）
docs/awesome-entry.yml                  # 提交到 awesome-dsh-plugin 的条目 YAML（复制进 data/plugins/）
```

画线数据（直线/斐波那契）存在浏览器 `localStorage`，不写这个目录。

## 它是什么

一个 DSH 插件：侧边栏底部多一个 `📊` 按钮（显示实时价与涨跌幅），点开是全屏看板 ——
**支持两个合约：`BTC-USDT-SWAP` / `ETH-USDT-SWAP`**（面板顶部 `BTC / ETH` 分段按钮切换，
选择记在浏览器 localStorage；切换后 K 线、价格、均线、画线、预警判定与回测默认标的都跟着走），
最新价格、`1m/3m/15m/1h/4h/1D` 六个周期的 K 线、默认 EMA20/EMA480 双均线（**周期可在面板上改**），
周期可切换、生产/模拟环境可切换，图表可**拖动平移 / 滚轮缩放 / 双击复位 / 按住轴拖动缩放**，
并支持**画直线、斐波那契与尺子**（默认 0/0.5/1/1.5/2；尺子量价格差/涨跌比例/时长，端点可吸附到 OHLC，
画完能点选、拖端点、隐藏、单条删除）。
跟随最新时有**当前价水平线 + 收盘倒计时**，未收盘那根 K 线单独描边；时间刻度对齐整点并带纵向网格线；
键盘可用（`←/→` 平移、`Ctrl+↑/↓` 缩放、`Alt+R` 回最新、`1`–`6` 切周期）。
均线在浏览器里按**整条序列**（1800 根，含预热）现算，所以**拖到哪个窗口，均线就画到哪儿**，改周期也是即时重算（见[插件 README](plugin/dsh-btc-dashboard/README.md#均线ema怎么算的窗口外为什么也有)）。
只读公开行情：**插件不发任何私有请求**，账户/持仓那部分代码已移除（见[插件 README](plugin/dsh-btc-dashboard/README.md)）。
细节见 [插件 README](plugin/dsh-btc-dashboard/README.md)。

同一仓库里还有一个**独立的回测框架** `backtest/`（见下节）：同样的 OKX 永续（BTC / ETH 都在白名单里）、
同样只读公开行情，用来在历史 K 线上验证策略想法 —— 默认 1 倍杠杆、挂单 0.0200% / 吃单 0.0500%，可指定回测区间。

## 安装

### 从 npm（推荐）

```powershell
dsh plugin --profile web add dsh-btc-dashboard
# --profile 换成你的 profile 名（如 web）；装完重启该 profile，浏览器刷新页面即可
```

### 从 GitHub（不经过 npm）

插件本体在 `plugin/dsh-btc-dashboard/`（仓库根不是 npm 包，所以安装命令要带 `#path:`）：

```powershell
dsh plugin --profile web add "github:altmanWang/dsh_plugin_btc_dashboard#path:/plugin/dsh-btc-dashboard"
```

- 只读 OKX 公开行情（ticker / candles），**不需要 API key**，不读账户与持仓；
- 可选：把 `.env.example` 复制成 `.env` 填上密钥，面板才会显示当前环境「配了哪把钥匙」的掩码（不填也能正常看行情）；
- **邮件提醒是可选通道**：依赖 [dsh-qq-email](https://github.com/altmanWang/dsh-qq-email) 插件（已上架 DSH 插件市场，`插件 → 发现 / Discover` 可搜到）。
  **不装它插件照常启动**，看板/均线/画线/回测都不受影响；要用邮件时预警面板会直接提示去安装，装完重启宿主即可；
- 零第三方 npm 依赖，Node 版本跟随宿主；卸载：`dsh plugin --profile web remove dsh-btc-dashboard`。

## 本地开发安装 / 卸载

在本仓库里开发时，用 `plugin_manager` 的 `install_bundle` 把 `plugin/dsh-btc-dashboard` 链接进 profile。
profile 里的依赖是链接形式，所以这个目录就是线上代码：改客户端半刷新页面即可，改 Host 半需要重启宿主。

> 当前磁盘上是 **1.8.1**。1.8.1 只改了邮件通道的**可选依赖提示**：没装 `dsh-qq-email` 时插件照常启动，
> 预警面板会提示去「插件 → 发现 / Discover」安装；Host 半（提示文案）有改动，需要重启宿主。
>
> **Host 半有改动，需要重启宿主** —— 1.8.0 增加了 `ETH-USDT-SWAP`：
> 看板顶部 `BTC / ETH` 切换、侧边栏价格跟随、回测面板「标的」下拉（Host 半新增
> `SUPPORTED_INSTS` 白名单，board/price/backtest/health 都按白名单走）。
> 1.7.1 给回测周期加了 `5m`
> （`backtest/lib/config.mjs` 是 Host 动态 import 的模块，宿主不重启不会出现新周期；
> 超短线实测结论见 `backtest/README.md`）。1.7.0 把**资金费率（funding）**计入了回测：
> 引擎按 8 小时结算从现金扣款，OKX 历史只保留最近约 3 个月、更早区间按估算费率补并在报告里标注；
> 报告格式升到 v3（K 线 + 资金费率 + 交易标记）。1.6.0 把回测框架接进了看板：
> 新增 5 条 `/dsh-btc/backtest/*` 路由（策略列表 / 启动回测 / 进度轮询 / 报告 / 取消），
> Host 侧用异步 job 跑回测、按需动态 import 仓库里的 `backtest/` 框架；看板工具条多一个「回测」面板。
> 1.5.0 新增了预警邮件的三条路由
> （`/dsh-btc/email` 读 / 写、`/dsh-btc/notify-email` 发信）并在发信时取宿主侧服务 `ctx.qqEmail`。
> 1.4.1 给 `candles` 补上了第 7 位 `done`（0/1）；1.4.0 的说明里曾写着"这一位早就在发，
> 只是客户端以前没用"，**那是错的**：宿主当时只发了 6 位，于是「收线预警」从来没跑过，
> 而控制台一句报错都没有。
>
> 1.4.0/1.4.1 是客户端半的一轮 UI/UX 改造：最新价线 + 收盘倒计时 + 未收盘 K 线描边、
> 时间刻度对齐整点并带纵向网格、悬浮改成「压中 K 线才弹数据框」、滚轮缩放连续化 + 按住轴拖动缩放、
> 指针事件化（触摸可用）、键盘与焦点管理、**直线 / 斐波那契 / 尺子**（尺子量价格差与涨跌比例、
> 端点吸附 OHLC、画完一条自动回到平移）、画线可选中/拖动/隐藏/单条删除、
> **均线支持任意条数、可增删改**（默认 EMA20 + EMA480：工具条上就一个 `均线管理（N）` 按钮，
> 点开是均线看板 —— 新增 / 删除 / 改周期 / 换颜色 / 显隐 / 恢复默认全在里面，`Esc` 收起；
> 逐条显隐也可以直接点**画布左上角的图例**；配置存 localStorage）、
> **EMA 图例移到画布左上角且可点击开关**、
> **收线预警**（K 线收线后收盘价上穿/下穿指定均线时提示：规则可增删改、绑周期、只在收线那刻判一次；
> 提示走面板 toast + 价格行常驻条 + **桌面通知**（需授权）+ **提示音**（WebAudio，需先与页面交互）
> + **邮件**（走 `dsh-qq-email` 的宿主服务 `ctx.qqEmail`；填地址时确认一次，之后自动发往该地址，
> 内容含规则/周期/收线时间/触发那根 K 线的 OHLCV）；
> **预警记录持久化到 localStorage、可一键清空**；**判据日志**记下每次判定"为什么中/为什么没中"
> （带前收/今收/前均/今均，看板里可「复制自检」整段导出排障）；
> **判定常驻执行**（引擎挂在 `shell.overlay`，关掉看板也在跑））、
> 可视区间统计（高/低/量/涨跌幅）接了出来、
> 刷新计时自走 + 数据陈旧标记、画布光标统一为黑色十字、工具条标签行内对齐。
> 期间修掉一批真 bug：**所有 K 线实体串成一个颜色**（`bodyOf` 漏设 `fillStyle`）、
> **切周期 / 点画线抛 ReferenceError 导致面板自己关闭**（函数定义被删、只剩 ref 上的副本）、
> 一个**会把浏览器转死**的死循环（时间刻度起点算错）、
> **「关掉均线后在图例上点不回来」**（图例只列可见的那些 → 行号错位，修了两次）、
> 以及**均线整条画不出来却不报错**（新加的 `lines` 与网格的 `var lines` 同名，被 var 提升覆盖）。
> 那个"点不回来"第二次的成因很像：**测试**没逼 React 提交（React 18 里自己派发的 pointer 事件
> 引起的 setState 是异步的），断言读到的还是旧状态 —— 产品是好的，测试在说谎；
> 现在派发事件统一用 `flushSync` 包一层。
> 详见[插件 README 的「踩过的坑」](plugin/dsh-btc-dashboard/README.md#踩过的坑改这块之前先看一眼)。

- 卸载：`plugin_manager` → `remove_bundle` → `dsh-btc-dashboard`
- 停用：`plugin_manager` → `set_plugin` → `btc-dashboard`（或 `set_bundle`），enabled=false

## 回测（backtest/）

看板之外，仓库里有一个**独立、零依赖、只读公开行情**的 OKX BTC-USDT-SWAP 永续回测框架
（1.6.0 起**看板里也能直接用**：工具条「预警」右边有个「回测」按钮，选策略/区间/资金/杠杆/费率就能跑，
面板内看 KPI + 资金曲线 + 交易明细，还能打开完整 HTML 报告；1.7.0 起默认计入资金费率）：

- 标的默认 `BTC-USDT-SWAP`，`--inst ETH-USDT-SWAP` 可回测 ETH 永续（看板回测面板也有「标的」下拉，
  白名单 BTC / ETH）；周期 `1m / 3m / 5m / 15m / 1h / 4h / 1D`（默认 `1h`；5m 为 v1.7.1 新增，
  超短线研究结论见 `backtest/README.md`「超短线实验」）；**回测区间可指定**
  （`--start/--end`，默认最近 30 天，裸日期按北京时间 UTC+8）
- **杠杆默认 1 倍**；手续费 **挂单 maker 0.0200% = 0.0002 / 吃单 taker 0.0500% = 0.0005**
  （两者都能用 `--maker/--taker` 覆盖，也接受 `0.02%` 写法）
- 撮合：市价单（taker）+ 限价单（maker，成交价=限价、默认 `tradeThrough` 保守判成交）；单方向净持仓；
  有保证金检查与近似爆仓、期末平仓；产出资金曲线、逐笔成交、闭合交易、绩效指标（收益/年化/最大回撤/
  Sharpe/Sortino/Calmar/胜率/盈亏比/费用/Buy&Hold 基准…）
- 历史 K 线**本地磁盘缓存**（默认 `backtest/data/`，已 gitignore）：同一段区间第二次回测不再联网；
  `--offline` 保证一个请求都不发；`--data <file.json>` 用本地 K 线文件离线复现
- 数据可用性（实测，经本地代理）：`1m / 1h / 4h` 可回溯到 **2019-12-16 UTC**，`1D` 到
  **2019-11-28（UTC+8）**；更早的区间接口直接返回空页，缓存会把下界记住、不重复重试
- 输出：控制台摘要 + JSON（全量曲线/成交/交易，可二次分析）+ **自包含单文件 HTML**（内联 SVG，断网可看）
  + 交易 CSV

```powershell
# 多空主策略（v1.8 新增）：4h 聚合日线定 regime，日线熊市才做空；多头慢出场、空头快回补
# 2020 起总收益 +4448.33%（不含 funding）、年化 75.29%、最大回撤 28.51%
node backtest/run.mjs --strategy multi-tf-dual --bar 4h --start 2020-01-01 --end now --no-funding
node backtest/run.mjs --strategy multi-tf-dual --bar 4h --start 2020-01-01 --end now

# 1D 多空备选（交易更少、验证段更强）
node backtest/run.mjs --strategy adaptive-dual --bar 1D --start 2020-01-01 --end now

# 只做多主策略：突破入场 + 均线滞回出场（4h；突破 36 根新高才买，跌破 MA240 下轨才卖）
node backtest/run.mjs --strategy breakout-hold --bar 4h --start now-1095d --end now
node backtest/run.mjs --strategy breakout-hold --bar 4h --start 2020-01-01 --end now

# 备选：纯均线滞回带（入场不要求突破，交易更多）
node backtest/run.mjs --strategy ma-hysteresis --bar 4h --start 2020-01-01 --end now

# 另一档：唐奇安突破 + 趋势过滤（默认档偏进攻）
node backtest/run.mjs --strategy donchian-trend --bar 4h --start now-1095d --end now

# 最近 30 天、1h、双均线（首次联网抓取并缓存；之后读缓存）
node backtest/run.mjs --strategy sma-cross --start now-30d --end now

# 基线对照 / 指定区间、资金、杠杆、费率
node backtest/run.mjs --strategy buy-hold --start 2025-01-01 --end 2025-07-01 --capital 10000 --leverage 1

# 参数扫描（训练/验证切分，研究用）
node backtest/tools/sweep.mjs --strategy donchian-trend --bar 4h --start now-1095d --end now --walk 0.7 \
  --grid "entryWindow=24,36,48,60;exitWindow=24,36,48,60;trendWindow=80,100,120,200;allowShort=false"

# 完全离线（缓存没覆盖就报错退出，不会偷偷联网）
node backtest/run.mjs --strategy sma-cross --offline

# 列出内置策略 / 全部参数
node backtest/run.mjs --list
node backtest/run.mjs --help
```

报告默认写到 `backtest/reports/`（已 gitignore），文件名形如
`BTC-USDT-SWAP-4h-donchian-trend-20231018-20261017.html`。

**内置了 8 个策略**：`buy-hold`（基线）、`sma-cross`（示例双均线）、
**`multi-tf-dual`（多空主策略，v1.8 新增：4h 内部聚合日线定 regime，日线熊市才做空；多头慢出场、空头快回补）**、
**`breakout-hold`（只做多主策略：突破入场 + 均线滞回出场 —— 只在突破时买，回调不深就一直拿着，
二次上涨不会因为"没创新高"而踏空）**、`adaptive-dual`（1D 多空备选）、`ma-hysteresis`（纯均线滞回，备选）、
`donchian-trend`（唐奇安突破 + 趋势过滤，近 3 年最强）、`ema-regime`（备选 EMA 趋势）。

**多空策略实测（4h、1x、默认费率、2020-01-01 → 2026-10-17）**：`multi-tf-dual` 总收益 **+4448.33%**（不含 funding）、
年化 75.29%、最大回撤 28.51%、Calmar 2.64；含 funding（0.01%/8h 估算）+3568.60%。同期只做多主策略
`breakout-hold` 是 +2585.52% / 年化 62.22% / 回撤 34.50%、含 funding +1792.05%。分年度最差是 2025 年
-1.1%（震荡年，双向策略的天然弱点）；2022 年 +27.3%（同年 Buy&Hold -64%）。
> ⚠️ 多空策略默认参数只由训练段 2020-01→2024-10 选出（验证段 2024-10→now 未参与选择），
> 但结构是在看过全历史后设计的，仍有选择偏差；2025 震荡年接近打平；含 funding 的大头是估算费率。
> 详见 [backtest/README.md 的「multi-tf-dual」一节](backtest/README.md#multi-tf-dual多周期双向趋势4h当前收益最高的策略)。

`breakout-hold` 默认参数（4h、1x、默认费率）：**2019-12 起 6.8 年：年化 65.1% / 最大回撤 34.5% / Calmar 1.89**；
2020 起年化 62.2% / 回撤 34.5%；近 3 年 36.4% / 回撤 27.8%（近 3 年这波行情里唐奇安默认档更猛：
45.5% / 18.4%，但它长历史回撤 59.9%）。分年度最差是 2022 年 -19%（同年 Buy&Hold -64%）。
> 以上是**不含资金费率**的 v1.6 口径。v1.7 起 CLI/看板默认计入 funding（历史只覆盖最近 3 个月、更早按估算费率），
> 计入后 breakout-hold：近 3 年 36.4% → **29.5%**、2020 起 62.2% → **54.1%**；想复现旧口径加 `--no-funding`。
> 已实现的一个组合是否"还能 30%+"，要按含 funding 的 29.5% 来看（近 3 年刚好在 30% 线附近）。
⚠️ 参数是在历史上选出来的，**别当成未来收益承诺**；逐年表现、策略切换为什么没采用、
资金费率/手续费等细节见
[backtest/README.md 的「内置策略与推荐预设」](backtest/README.md#内置策略与推荐预设)。

后续加策略只需往 `backtest/strategies/` 放一个 `.mjs`（默认导出 `defineStrategy({...})`，
参数从 `ctx.params` 读），引擎/指标/报告都不用动；看板回测面板里会自动出现。
策略写法、`ctx` API、完整参数表、手续费/资金费率/爆仓口径、已知局限
（funding 历史只有近 3 个月、无盘口深度/部分成交、撮合与爆仓是近似模型）见
[backtest/README.md](backtest/README.md)。

## 自检

```powershell
cd <仓库根目录>

# 1) Host 半：.env 解析、EMA 数学、六个周期 × 两个环境的真实取数（不打真实私有接口）
node tests/host-test.mjs

# 2) 浏览器半：模块格式、slot 注册、组件渲染、canvas 画图、均线（窗口切片 / 改周期 / 口径一致）、
#    最新价线 / 倒计时 / 整点刻度 / 悬浮两档 / 尺子与吸附 / 画线命中与编辑 / 面板 DOM 与无障碍属性、
#    回测面板（默认值 / 表单换算 / 轮询进度 / KPI 与资金曲线 / 交易表 / 取消 / 打开报告 / localStorage 回填）
#    （带 120s 看门狗：实现里出现死循环会直接报错退出，而不是让你干等）
node tests/client-test.mjs

# 3) bundle 投递：从首页 boot 里读真实地址，核验宿主发出去的就是本地这份 client.js
#    （/plugins/ 有 cookie 鉴权：DSH_BTC_COOKIE="<名>=<值>"；没给就跳过）
node tests/bundle-verify.mjs

# 4) 运行中的 GUI：路由连通、六个周期、序列深度与预热、热缓存、环境切换、非法输入
node tests/live-verify.mjs

# 5) 预警邮件的路由逻辑（离线，不启动 webServer、不发真邮件）
#    把"代码错"和"宿主没重启"分开：如果这里的 needsConfirm / authorized 都对，
#    但界面上点开启没反应，那就是宿主还在跑旧 index.js —— 必须重启。
node tests/email-route-test.mjs

# 6) 回测框架：九个离线自检（全不联网，可重复跑）
node tests/backtest-data-test.mjs         # 数据层：分页 / 缺口 / 缓存命中 / offline / readBarFile
node tests/backtest-engine-test.mjs       # 引擎：撮合 / 费率 / 滑点 / 杠杆 / 爆仓 / 无未来函数
node tests/backtest-metrics-test.mjs      # 指标与报告：公式 / JSON / HTML / CSV
node tests/backtest-cli-test.mjs          # CLI：--data 离线端到端、默认 1x + 0.0200%/0.0500% 断言
node tests/backtest-integration-test.mjs  # 跨模块端到端：时间范围过滤、手续费真的扣、报告三件套
node tests/backtest-strategy-test.mjs     # 指标数学 + 策略行为（开多/退出/开空/仓位/状态重置）+ sweep 工具
node tests/backtest-funding-test.mjs      # 资金费率：解析 / 缓存 / 历史+估算拼接 / 引擎结算 / 报告口径
node tests/backtest-dual-strategy-test.mjs # 多空策略：多空开仓 / 状态重置 / 截断因果性 / 真实数据冒烟

# 6b) 插件里的回测路由（离线，注入合成 K 线，不联网）
node tests/backtest-route-test.mjs        # strategies/run/status/report/cancel、CSP、405 守卫、单任务、取消、超时

# 7) 回测真实数据冒烟（联网）：经本地代理抓 OKX 历史 K 线，验证缓存复用与 CLI --offline；
#    连不上 OKX 会打印「跳过」并返回 0（本机 DNS 黑洞，全靠代理，代理没开时跳过是预期）
node tests/backtest-live-test.mjs
```

`tests/transport-test.mjs` 与 `tests/rev-crack.mjs` 是排障时用的实验脚本，不是回归测试；
`tests/ema-*.mjs` 三个探针也是排障用的，用来量「序列取多深、均线左端才收敛」（它们会真的打 OKX）：

```powershell
node tests/ema-depth-probe.mjs 15m 4200   # 序列深度 × 各位置误差
node tests/ema-depth2-probe.mjs 15m 8000  # 预热深度 → 可拖范围左端误差
node tests/ema-seed-probe.mjs 15m 7000    # 前向播种 vs 逆递推（后者数值不稳定，已弃用）
node tests/ema-decay-check.mjs            # 种子误差衰减律的数学验证（不打网络）
```

浏览器半的**加载**证据不看 HTTP（首页有 cookie 鉴权），而是查活着的槽位占用：
`cordis_inspect_query` → platform `client`、provider `Slots`、method `listSubTree`、input `{"root":"shell.overlay"}`，
occupants 里应出现 `id: "btc-dashboard"`（`sidebar.footer.action` 同理）。

## 安全提醒

`/dsh-btc/*` 四条路由都过了 `connection.requestRejection` 这道信任栅栏：Host 校验（防 DNS rebinding）、
`sec-fetch-site: cross-site` 与 Origin 校验（跨站页面发起的请求一律拒）、以及浏览器鉴权（同源请求带的
签名 HttpOnly cookie）。唯一的写操作 `POST /dsh-btc/env` **只接受 POST**，GET 的变体已关闭。
栅栏判定不可用时返回 `503` 而不是放行。

默认只绑 `127.0.0.1`，所以常规使用没问题；但**不要用 `--host 0.0.0.0` 之类的方式把 DSH 暴露到局域网**
——栅栏挡的是跨站请求，同网段直连仍是可达面。
详见[插件 README 的路由一节](plugin/dsh-btc-dashboard/README.md#路由浏览器半只-fetch-同源接口无-cors)。

回测框架同样**只用 OKX 公开行情接口，不需要、也不读取任何 API key**；抓下来的 K 线缓存
（`backtest/data/`）与报告（`backtest/reports/`）都在 `.gitignore` 里，不会进仓库。

## 许可证

MIT，见 [LICENSE](LICENSE)。
