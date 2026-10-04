# btc_dashboard

OKX BTC 合约价格看板的 DSH 插件工程。

```
.env                                    # OKX 密钥（生产 + 模拟/调试），仅用于确认「配了哪把钥匙」
.dashboard/state.json                   # 插件持久化的选择（环境 + 周期），已被 .gitignore 忽略
plugin/dsh-btc-dashboard/               # 插件本体（就是安装进 profile 的那份代码）
  ├─ index.js                           # Host 半：取数、代理隧道、EMA、路由
  ├─ client.js                          # 浏览器半：canvas 看图 + 周期/环境切换 + 画线
  ├─ package.json                       # dsh.bundle.patch + dsh.client 声明
  ├─ cordis.patch.yml                   # bundle 层：把 Host 半挂进 profile
  └─ README.md                          # 实现细节、参数、路由、环境语义
tests/                                  # 离线自检脚本
```

画线数据（直线/斐波那契）存在浏览器 `localStorage`，不写这个目录。

## 它是什么

一个 DSH 插件：侧边栏底部多一个 `📊` 按钮（显示实时价与涨跌幅），点开是全屏看板 ——
最新价格、`1m/3m/15m/1h/4h/1D` 六个周期的 K 线、默认 EMA20/EMA480 双均线（**周期可在面板上改**），
周期可切换、生产/模拟环境可切换，图表可**拖动平移 / 滚轮缩放 / 双击复位 / 按住轴拖动缩放**，
并支持**画直线、斐波那契与尺子**（默认 0/0.5/1/1.5/2；尺子量价格差/涨跌比例/时长，端点可吸附到 OHLC，
画完能点选、拖端点、隐藏、单条删除）。
跟随最新时有**当前价水平线 + 收盘倒计时**，未收盘那根 K 线单独描边；时间刻度对齐整点并带纵向网格线；
键盘可用（`←/→` 平移、`Ctrl+↑/↓` 缩放、`Alt+R` 回最新、`1`–`6` 切周期）。
均线在浏览器里按**整条序列**（1800 根，含预热）现算，所以**拖到哪个窗口，均线就画到哪儿**，改周期也是即时重算（见[插件 README](plugin/dsh-btc-dashboard/README.md#均线ema怎么算的窗口外为什么也有)）。
只读公开行情：**插件不发任何私有请求**，账户/持仓那部分代码已移除（见[插件 README](plugin/dsh-btc-dashboard/README.md)）。
细节见 [插件 README](plugin/dsh-btc-dashboard/README.md)。

## 安装 / 卸载

已经装好（`plugin_manager` → `install_bundle`，target 指向 `plugin/dsh-btc-dashboard`）。
profile 里的依赖是链接形式，所以这个目录就是线上代码：改客户端半刷新页面即可，改 Host 半需要重启宿主。

> 当前磁盘上是 **1.4.0**。Host 半相对 1.3.2 **没有改动**（`candles` 载荷里的第 7 位 `done` 早就在发，
> 只是客户端以前没用），所以**不需要重启宿主**，刷新页面即可看到新客户端半。
>
> 1.4.0 是客户端半的一轮 UI/UX 改造：最新价线 + 收盘倒计时 + 未收盘 K 线描边、
> 时间刻度对齐整点并带纵向网格、悬浮改成「压中 K 线才弹数据框」、滚轮缩放连续化 + 按住轴拖动缩放、
> 指针事件化（触摸可用）、键盘与焦点管理、**直线 / 斐波那契 / 尺子**（尺子量价格差与涨跌比例、
> 端点吸附 OHLC、画完一条自动回到平移）、画线可选中/拖动/隐藏/单条删除、
> **均线支持任意条数、可增删改**（默认 EMA20 + EMA480：工具条上就一个 `均线管理（N）` 按钮，
> 点开是均线看板 —— 新增 / 删除 / 改周期 / 换颜色 / 显隐 / 恢复默认全在里面，`Esc` 收起；
> 逐条显隐也可以直接点**画布左上角的图例**；配置存 localStorage）、
> **EMA 图例移到画布左上角且可点击开关**、可视区间统计（高/低/量/涨跌幅）接了出来、
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

- 卸载：`plugin_manager` → `remove_bundle` → `@local/dsh-btc-dashboard`
- 停用：`plugin_manager` → `set_plugin` → `btc-dashboard`（或 `set_bundle`），enabled=false

## 自检

```powershell
cd D:\codes\dsh\btc_dashboard

# 1) Host 半：.env 解析、EMA 数学、六个周期 × 两个环境的真实取数（不打真实私有接口）
node tests/host-test.mjs

# 2) 浏览器半：模块格式、slot 注册、组件渲染、canvas 画图、均线（窗口切片 / 改周期 / 口径一致）、
#    最新价线 / 倒计时 / 整点刻度 / 悬浮两档 / 尺子与吸附 / 画线命中与编辑 / 面板 DOM 与无障碍属性
#    （带 120s 看门狗：实现里出现死循环会直接报错退出，而不是让你干等）
node tests/client-test.mjs

# 3) bundle 投递：从首页 boot 里读真实地址，核验宿主发出去的就是本地这份 client.js
#    （/plugins/ 有 cookie 鉴权：DSH_BTC_COOKIE="<名>=<值>"；没给就跳过）
node tests/bundle-verify.mjs

# 4) 运行中的 GUI：路由连通、六个周期、序列深度与预热、热缓存、环境切换、非法输入
node tests/live-verify.mjs
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
