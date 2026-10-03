// 对运行中的 GUI（127.0.0.1:3080）做端到端自检：
// 路由连通、6 个周期、环境切换、以及「序列深度是否够均线在整段时间轴上画」。
//
// 注意：插件 1.3.2 起给 `/dsh-btc/*` 套了信任栅栏（Host/Origin + 浏览器 cookie 鉴权），
// 所以裸 fetch 会被 401 拒掉。要跑这个脚本，先从浏览器 DevTools → Application → Cookies
// 复制那个会话 cookie，然后：
//   $env:DSH_BTC_COOKIE="<cookie 名>=<cookie 值>"; node tests/live-verify.mjs
import { authHeaders, fenceHint } from './_paths.mjs'

const BASE = process.env.DSH_BTC_BASE || 'http://127.0.0.1:3080'
const BARS = ['1m', '3m', '15m', '1h', '4h', '1D']
let failed = 0
function check(ok, label, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
  if (!ok) failed += 1
}

/** 带认证头的 fetch：GET 直接发，POST 需要 JSON body */
async function get(path, options) {
  const opts = options === undefined ? {} : options
  const res = await fetch(BASE + path, Object.assign({}, opts, {
    headers: Object.assign({}, authHeaders(), opts.headers || {}),
  }))
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (error) { /* 非 JSON */ }
  return { status: res.status, text: text, json: json }
}

/** 切换环境只认 POST（GET 会被 405 拒） */
function switchEnv(id) {
  return get('/dsh-btc/env', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ env: id }),
  })
}

// ---------------------------------------------------------------- 0) 栅栏先过一遍
{
  const probe = await get('/dsh-btc/health')
  const hint = fenceHint(probe.status)
  if (hint !== null) {
    console.log('无法继续：' + hint)
    console.log('（这一层是 1.3.2 加的信任栅栏，不是插件坏了；同源的面板请求不受影响。）')
    process.exit(2)
  }
}

// ---------------------------------------------------------------- 1) 客户端半的加载证据
//
// 首页 `/` 有 cookie 鉴权（无 cookie 时 401），所以拿不到 __DSH_BOOT__ 里的 bundle 地址。
// 客户端半「已加载并注册」的证据改用活槽位查询（cordis_inspect_query → client / Slots）：
//   shell.overlay 与 sidebar.footer.action 的 occupants 里应出现 id: "btc-dashboard"。
// 这里只验证 Host 半可观测的部分。

console.log('--- 说明：客户端半的加载证据见 README（Slots inspect 的 occupants）')

// ---------------------------------------------------------------- 2) 六个周期

console.log('\n--- 周期（每次 force，走完整取数）')
const seen = {}
for (const bar of BARS) {
  const t0 = Date.now()
  const res = await get('/dsh-btc/board?bar=' + bar + '&limit=180&force=1')
  const ms = Date.now() - t0
  const b = res.json
  if (b === null || b.ok !== true) {
    check(false, bar + ' 取数', String(b === null ? res.text.slice(0, 120) : b.error))
    continue
  }
  const e480 = b.ema480.filter(function (v) { return v !== null; }).length
  const e20 = b.ema20.filter(function (v) { return v !== null; }).length
  seen[bar] = b
  // 载荷长度 = 整条序列（= stats.seriesCount），均线数组与 K 线等长对齐
  check(b.candles.length === b.ema20.length && b.candles.length === b.ema480.length,
    bar + ' K 线与均线等长', 'candles=' + b.candles.length + ' ema20=' + b.ema20.length + ' ema480=' + b.ema480.length)
  check(b.candles.length === b.stats.seriesCount, bar + ' 载荷 = 整条序列',
    'candles=' + b.candles.length + ' series=' + b.stats.seriesCount)
  check(b.stats.seriesCount >= 1200, bar + ' 序列够深（≥1200 根，含预热）',
    'series=' + b.stats.seriesCount + ' pages=' + b.meta.pages)
  check(b.stats.warmupBars >= 480, bar + ' 预热段 ≥480 根（拖动时 EMA480 才不虚）',
    'warmup=' + b.stats.warmupBars + ' windowBars=' + b.stats.windowBars)
  // 从「序列最左端起算」，EMA20/EMA480 只在各自预热段为 null —— 这就是浏览器侧能画的全部
  check(e20 === b.candles.length - 19 || e20 === 0, bar + ' EMA20 覆盖率', 'ema20=' + e20 + '/' + b.candles.length)
  check(e480 === b.candles.length - 479 || e480 === 0, bar + ' EMA480 覆盖率', 'ema480=' + e480 + '/' + b.candles.length)
  check(typeof b.price.last === 'number' && b.price.last > 1000, bar + ' 有最新价', String(b.price.last))
  console.log('     ' + bar.padEnd(3) + ' last=' + String(b.price.last).padEnd(10) + ' chg24h=' + String(b.price.changePct).padStart(7)
    + '%  ema20=' + String(b.stats.ema20Last).padEnd(9) + ' ema480=' + String(b.stats.ema480Last).padEnd(9)
    + ' series=' + b.stats.seriesCount + ' transport=' + b.transport + ' ' + ms + 'ms')
}

// ---------------------------------------------------------------- 3) 热缓存

console.log('\n--- 热缓存（同一周期连续两次）')
{
  const t0 = Date.now()
  const first = await get('/dsh-btc/board?bar=15m&limit=180')
  const ms1 = Date.now() - t0
  const t1 = Date.now()
  const second = await get('/dsh-btc/board?bar=15m&limit=180')
  const ms2 = Date.now() - t1
  check(first.json !== null && first.json.ok === true && second.json !== null && second.json.ok === true, '两次调用都成功')
  check(second.json !== null && second.json.meta.cached === true, '第二次命中热缓存')
  console.log('     第一次 ' + ms1 + 'ms（cached=' + (first.json && first.json.meta ? first.json.meta.cached : '?') + '）第二次 ' + ms2 + 'ms（cached=' + (second.json && second.json.meta ? second.json.meta.cached : '?') + '）')
}

// ---------------------------------------------------------------- 4) 环境切换

console.log('\n--- 生产 / 模拟切换')
const before = (await get('/dsh-btc/health')).json
check(before !== null && before.ok === true, 'health 可用')
const other = before.env.id === 'prod' ? 'demo' : 'prod'
{
  const sw = await switchEnv(other)
  check(sw.json !== null && sw.json.ok === true, '切到 ' + other + ' 成功', sw.json === null ? sw.text.slice(0, 120) : JSON.stringify(sw.json.env))
  check(sw.json !== null && sw.json.env.id === other, '返回的目标环境正确')

  const board = (await get('/dsh-btc/board?bar=15m&limit=60&force=1')).json
  check(board !== null && board.env.id === other, '看板跟随环境切换', board === null ? '' : board.env.id + ' simulated=' + board.env.simulated)
  check(board !== null && board.price !== null && board.price.last > 1000, '切换后仍能取到价', board === null || board.price === null ? '' : String(board.price.last))
  check(board !== null && board.env.keyMasked !== undefined && board.env.keyMasked !== null, '展示了该环境的密钥指纹', board === null ? '' : String(board.env.keyMasked))
  check(board !== null && JSON.stringify(board).indexOf(before.environments[other].keyMasked) >= 0, '指纹与 health 里的一致')

  const back = await switchEnv(before.env.id)
  check(back.json !== null && back.json.ok === true, '切回 ' + before.env.id + ' 成功')
  const rest = (await get('/dsh-btc/health')).json
  check(rest !== null && rest.env.id === before.env.id, '状态已恢复', rest === null ? '' : rest.env.id)
}

// ---------------------------------------------------------------- 5) 非法输入

console.log('\n--- 边界')
{
  // 非法环境：POST 过去应被白名单拒（不是 405，405 是给 GET 的）
  const bad = await switchEnv('nope')
  check(bad.json !== null && bad.json.ok === false, '非法环境被拒绝', String(bad.json && bad.json.error))
  const badGet = await get('/dsh-btc/env?env=demo')
  check(badGet.status === 405, 'GET /dsh-btc/env 被拒（写操作只认 POST）', 'HTTP ' + String(badGet.status))
  const badBar = await get('/dsh-btc/board?bar=nope')
  check(badBar.json !== null && badBar.json.ok === true, '非法周期回退到默认周期', badBar.json === null ? '' : badBar.json.bar)
  const price = await get('/dsh-btc/price')
  check(price.json !== null && price.json.ok === true && price.json.price !== null, '轻量价格接口可用', price.json === null ? '' : String(price.json.price.last))
  const gone = await get('/dsh-btc/account')
  check(gone.status === 404, '账户路由已下线', 'HTTP ' + String(gone.status))
}

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exitCode = failed === 0 ? 0 : 1
