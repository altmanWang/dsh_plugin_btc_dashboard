// 插件 Host 半的自检：传输通道、6 个周期、EMA 正确性、环境切换。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { boardPayload, healthPayload, parseEnvFile, ema, SUPPORTED_INSTS, normalizeInstId }
  from '../plugin/dsh-btc-dashboard/index.js'
import { STATE_FILE } from './_paths.mjs'

const STATE = STATE_FILE
const BARS = ['1m', '3m', '15m', '1h', '4h', '1D']

function fail(msg) { console.log('FAIL ' + msg); process.exitCode = 1 }

// ---- 1) EMA 与参考实现（朴素定义，无种子递推差异）对比
{
  const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const got = ema(closes, 3)
  // 手算：seed=SMA(1,2,3)=2 → k=0.5 → i=3: 0.5*4+0.5*2=3 → i=4: 4 → ... 递增 1
  const want = [null, null, 2, 3, 4, 5, 6, 7, 8, 9]
  const ok = got.every((v, i) => (v === null && want[i] === null) || Math.abs(v - want[i]) < 1e-9)
  console.log((ok ? 'ok   ' : 'FAIL ') + 'ema 递推 ' + JSON.stringify(got))
  if (!ok) fail('ema 计算结果与手算不一致')
  if (ema([1, 2], 3).some((v) => v !== null)) fail('数据不足时应全部为 null')
}

// ---- 2) .env 解析
{
  const vars = parseEnvFile(require$text())
  function require$text() {
    return [
      '# 调试环境的api',
      'DEBUG_OKX_API_KEY="FAKE-0000-0000-0000-000000000000"',
      'DEBUG_OKX_API_SECRET=FAKE0000000000000000000000000000  # 行尾注释',
      'export PROD_OKX_API_KEY=FAKE-1111-1111-1111-111111111111',
    ].join('\n')
  }
  const ok = vars.DEBUG_OKX_API_KEY === 'FAKE-0000-0000-0000-000000000000'
    && vars.DEBUG_OKX_API_SECRET === 'FAKE0000000000000000000000000000'
    && vars.PROD_OKX_API_KEY === 'FAKE-1111-1111-1111-111111111111'
  console.log((ok ? 'ok   ' : 'FAIL ') + '.env 解析 ' + JSON.stringify(vars))
  if (!ok) fail('.env 解析不正确')
}

// ---- 3) .env 解析的边界情况（不依赖真实密钥）
{
  const parser = parseEnvFile([
    'PLAIN=value',
    'TRAILING=value  # 行尾注释',
    'QUOTED="quoted  # 不是注释"',
    'SINGLE=' + "'single'",
    'export EXPORTED=exported',
    'EMPTY=',
    '# 整行注释=被忽略',
    'NOEQUALS',
    '',
  ].join('\r\n'))
  const cases = [
    ['PLAIN', 'value'],
    ['TRAILING', 'value'],
    ['QUOTED', 'quoted  # 不是注释'],
    ['SINGLE', 'single'],
    ['EXPORTED', 'exported'],
    ['EMPTY', ''],
  ]
  let allOk = parser['# 整行注释'] === undefined && parser.NOEQUALS === undefined
  const got = []
  for (const [key, want] of cases) {
    const actual = parser[key]
    got.push(key + '=' + JSON.stringify(actual))
    if (actual !== want) allOk = false
  }
  console.log((allOk ? 'ok   ' : 'FAIL ') + '.env 边界解析 ' + got.join(' '))
  if (parser.QUOTED !== 'quoted  # 不是注释') fail('.env 解析：引号内的 # 不应被当作注释')
  if (parser.TRAILING !== 'value') fail('.env 解析：行尾 # 注释应被去掉')
  if (parser.EMPTY !== '') fail('.env 解析：空值应解析为空字符串')
  if (parser['# 整行注释'] !== undefined || parser.NOEQUALS !== undefined) fail('.env 解析：注释行与无等号行应被跳过')
  if (!allOk) fail('.env 边界解析存在偏差')
}

// ---- 4) health
{
  const h = healthPayload()
  console.log('ok   health env=' + h.env.id + ' instId=' + h.instId + ' proxy=' + h.proxy
    + '\n     keys: prod=' + h.environments.prod.keyMasked + ' demo=' + h.environments.demo.keyMasked
    + ' (secret: prod=' + h.environments.prod.hasSecret + ' demo=' + h.environments.demo.hasSecret + ')')
  if (!h.environments.prod.hasSecret || !h.environments.demo.hasSecret) fail('.env 里的 secret 没读到')
  // 可选标的列表：前端「标的」下拉与标题用它（离线断言，不依赖行情）
  const insts = Array.isArray(h.insts) ? h.insts : []
  if (insts.length !== 2) {
    fail('healthPayload().insts 应为 2 个标的：' + JSON.stringify(insts))
  } else if (!insts.some((item) => item.instId === 'BTC-USDT-SWAP')
    || !insts.some((item) => item.instId === 'ETH-USDT-SWAP')) {
    fail('healthPayload().insts 缺 BTC-USDT-SWAP / ETH-USDT-SWAP：' + JSON.stringify(insts))
  } else if (insts.some((item) => typeof item.label !== 'string' || item.label === '')) {
    fail('healthPayload().insts 有项缺 label：' + JSON.stringify(insts))
  } else {
    console.log('ok   health 可选标的：' + insts.map((item) => item.instId + '(' + item.label + ')').join(' / '))
  }
}

// ---- 4.5) 标的白名单：纯函数，离线
{
  const ids = SUPPORTED_INSTS.map((item) => item.instId)
  const shapeOk = SUPPORTED_INSTS.every((item) => typeof item.label === 'string' && item.label !== ''
    && typeof item.short === 'string' && item.short !== '')
  if (ids.length !== 2 || ids.indexOf('BTC-USDT-SWAP') < 0 || ids.indexOf('ETH-USDT-SWAP') < 0) {
    fail('SUPPORTED_INSTS 不是 [BTC-USDT-SWAP, ETH-USDT-SWAP]：' + JSON.stringify(ids))
  } else if (!shapeOk) {
    fail('SUPPORTED_INSTS 项缺 label / short：' + JSON.stringify(SUPPORTED_INSTS))
  } else {
    console.log('ok   SUPPORTED_INSTS = ' + JSON.stringify(SUPPORTED_INSTS))
  }
  // 合法值（含首尾空白）规范成白名单里的精确写法
  for (const raw of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', '  ETH-USDT-SWAP  ']) {
    if (normalizeInstId(raw) !== String(raw).trim()) {
      fail('合法 instId 没被规范成白名单值：' + JSON.stringify(raw) + ' → ' + JSON.stringify(normalizeInstId(raw)))
    }
  }
  // 非法值一律返回 null：调用方（board 回落默认 / run 报错）才有统一口径
  for (const raw of [null, undefined, '', '   ', 'DOGE-USDT-SWAP', 'eth-usdt-swap', 'BTCUSDT',
    'BTC-USDT-SWAPX', 123, {}, []]) {
    if (normalizeInstId(raw) !== null) fail('非法 instId 没被拒：' + JSON.stringify(raw))
  }
  console.log('ok   normalizeInstId：合法通过（含 trim）/ 非法一律 null（含大小写不同）')
}

// ---- 5) 六个周期：真实取数 + EMA480 覆盖率
async function runEnv(envId) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify({ env: envId }), 'utf8')
  console.log('\n===== 环境 ' + envId + ' =====')
  let okCount = 0
  for (const bar of BARS) {
    const t0 = Date.now()
    const out = await boardPayload({ bar, limit: 180, force: true })
    const ms = Date.now() - t0
    if (out.ok !== true) { fail('bar ' + bar + ' 取数失败：' + out.error); console.log('     ' + out.error); continue }
    okCount += 1
    const e480 = out.ema480.filter((v) => v !== null).length
    const e20 = out.ema20.filter((v) => v !== null).length
    console.log('ok   ' + bar.padEnd(3)
      + ' price=' + String(out.price === null ? '-' : out.price.last).padEnd(10)
      + ' chg24h=' + String(out.price === null ? '-' : out.price.changePct).padStart(7) + '%'
      + ' candles=' + String(out.candles.length).padStart(3)
      + ' series=' + String(out.stats.seriesCount).padStart(3)
      + ' ema20/480=' + e20 + '/' + e480
      + ' last=' + out.stats.ema20Last + '/' + out.stats.ema480Last
      + ' ' + ms + 'ms'
      + (out.meta.cached ? ' (cached)' : ' pages=' + out.meta.pages)
      + (out.meta.warnings.length > 0 ? '\n     ⚠ ' + out.meta.warnings.join(' / ') : ''))
    if (out.stats.seriesCount < 480) fail(bar + ' 序列不足 480 根，EMA480 画不出来')
    if (out.ema20.length !== out.candles.length || out.ema480.length !== out.candles.length) {
      fail(bar + ' EMA 数组与 K 线长度不一致')
    }
    if (out.transport !== 'proxy') fail(bar + ' 传输通道不是 proxy（实际 ' + out.transport + '）')
    // K 线的形状：必须是 7 位，第 7 位是 done（0/1）。
    // 这一条是拿真事故换来的：宿主曾经只发 6 位，客户端读 candles[i][6] 判"收线了没"，
    // 于是**收线预警永远不响**、未收盘那根的描边也一直没画 —— 却没有任何报错。
    const badShape = out.candles.filter((c) => !Array.isArray(c) || c.length < 7 || (c[6] !== 0 && c[6] !== 1))
    if (badShape.length > 0) {
      fail(bar + ' 有 ' + badShape.length + ' 根 K 线缺 done 标记（第 7 位）：' + JSON.stringify(badShape[0]))
    }
    // 已收盘的至少要有一根（否则客户端找不到"刚收线的那根"），而且不能全 1（最后一根通常未收盘）
    const doneCount = out.candles.filter((c) => c[6] === 1).length
    if (doneCount === 0) fail(bar + ' 一根已收盘的 K 线都没有：收线预警判不了')
    if (doneCount === out.candles.length) {
      fail(bar + ' 所有 K 线都标成已收盘了（最后一根应当是未收盘的）')
    }
    console.log('     done: 已收盘 ' + doneCount + '/' + out.candles.length
      + '，最后一根 done=' + String(out.candles[out.candles.length - 1][6]))
  }
  return okCount
}

// ---- 5.5) 预警邮件：地址校验 / 配置规范化 / 正文组装（**纯函数，绝不发信**）
async function runEmailChecks() {
  console.log('\n===== 预警邮件（只验组装与校验，不发信）=====')
  const m = await import('../plugin/dsh-btc-dashboard/index.js')

  // 地址校验
  const good = m.validateEmailList('Me@QQ.com, a@b.cn;c@d.io')
  if (good.ok !== true) fail('合法地址被拒：' + good.error)
  else console.log('ok   合法地址通过（' + good.list.join(', ') + '）')
  for (const bad of ['', '   ', 'no-at-sign', 'a@b', '@b.com', 'a b@c.com']) {
    if (m.validateEmailList(bad).ok === true) fail('非法地址被放过：' + JSON.stringify(bad))
  }
  console.log('ok   非法地址全部被拒')
  if (m.validateEmailList('a@b.com,a@B.COM').list.length !== 1) fail('重复地址没有去重')
  console.log('ok   地址去重（大小写不敏感）')

  // 配置规范化：坏值退回安全默认
  const n0 = m.normalizeEmailConfig(null)
  if (n0.enabled !== false || n0.to !== '' || n0.sentCount !== 0) {
    fail('null 配置没有退回安全默认：' + JSON.stringify(n0))
  }
  if (m.normalizeEmailConfig({ enabled: 'yes' }).enabled !== false) fail('enabled 没有只认真 true')
  if (m.normalizeEmailConfig({ sentCount: 'x' }).sentCount !== 0) fail('非法 sentCount 没有归 0')
  console.log('ok   配置规范化挡掉坏值')

  // 视图：授权是否覆盖当前地址
  const v1 = m.emailView(m.normalizeEmailConfig({ enabled: true, to: 'a@b.com', confirmed: 'a@b.com' }), true)
  if (v1.authorized !== true || v1.available !== true) fail('已确认且服务可用时 authorized 应为 true')
  const v2 = m.emailView(m.normalizeEmailConfig({ enabled: true, to: 'new@b.com', confirmed: 'old@b.com' }), true)
  if (v2.authorized !== false) fail('地址变了以后 authorized 仍为 true（会绕过确认）')
  console.log('ok   authorized 只在"当前地址 == 已确认地址"时为 true')

  // 正文组装：必须带规则 / 周期 / 触发那根 K 线
  const built = m.buildAlertEmail({
    rule: '收盘下穿 EMA20', bar: '15m', text: '收线下穿 EMA20 · 收盘 85,774.3 / 均线 85,783.9',
    ts: 1780000000000, instId: 'BTC-USDT-SWAP',
    price: { close: 85774.3, ema: 85783.9 },
    candle: { t: 1780000000000, o: 85800, h: 85820, l: 85750, c: 85774.3, v: 123.4 },
    rules: [{ dir: 'down', emaPeriod: 20, bar: '15m', on: true }],
  })
  if (built.ok !== true) fail('正文组装失败：' + built.error)
  else {
    for (const needle of ['收盘下穿 EMA20', '周期：15m', '85,774.3', '均线', '触发那根 K 线',
      '开：85800', '高：85820', '低：85750', '收：85774.3', '量：123.4', 'BTC-USDT-SWAP', '当前启用的规则']) {
      if (built.body.indexOf(needle) < 0) fail('邮件正文缺少「' + needle + '」')
    }
    console.log('ok   正文含规则 / 周期 / 收线时间 / 触发那根 K 线的 OHLCV（' + built.body.length + ' 字符）')
    if (built.subject.indexOf('15m') < 0 || built.subject.indexOf('下穿') < 0) {
      fail('主题没有带周期或方向：' + built.subject)
    }
    console.log('ok   主题：' + built.subject)
    // 正文是给人看的，不该出现任何内部字段
    for (const leak of ['secret', 'password', 'apiKey', 'passphrase', 'token']) {
      if (built.body.toLowerCase().indexOf(leak.toLowerCase()) >= 0) fail('邮件正文疑似泄露字段：' + leak)
    }
    console.log('ok   正文不含任何密钥类字段')
  }
  // 缺字段也不能炸
  const empty = m.buildAlertEmail({})
  if (empty.ok !== true) fail('空载荷组装应当成功（走占位文案）：' + empty.error)
  else console.log('ok   空载荷也能组装（占位文案，不炸）')
  if (m.buildAlertEmail(null).ok !== true) fail('null 载荷应当安全')

  // qqEmail 服务在不在
  const cli = process.env.DSH_QQ_EMAIL_CLI || '%APPDATA%\\npm\\...\\agently-cli\\scripts\\run.js'
  console.log('   提示：真正发信需要 dsh-qq-email 已启用（提供 ctx.qqEmail）。CLI 查找位置见 ' + cli)
}

// ---- 5.6) 标的：boardPayload 级（联网；前面一个周期都没取到就跳过，保证离线也能跑）
async function runInstBoardChecks(networkAvailable) {
  console.log('\n===== 标的（boardPayload）=====')
  if (networkAvailable !== true) {
    console.log('     跳过 boardPayload 标的测试：当前环境拿不到行情（离线可跑）')
    return
  }

  // ① 非法 instId → 回落 Host 配置的默认标的（默认 BTC）；响应里的 instId 必须是"实际使用的标的"。
  //    紧跟在 runEnv('prod') 之后调用，BTC 1h 的热缓存还在，基本不会再翻页。
  const fallback = await boardPayload({ bar: '1h', instId: 'DOGE-USDT-SWAP', force: false })
  if (fallback.instId !== 'BTC-USDT-SWAP') {
    fail('非法 instId 没有回落到默认 BTC-USDT-SWAP（实际 ' + JSON.stringify(fallback.instId) + '）')
  } else {
    console.log('ok   非法 instId 回落默认 BTC（ok=' + String(fallback.ok) + '，instId=' + fallback.instId
      + (fallback.meta !== undefined && fallback.ok === true ? '，cached=' + String(fallback.meta.cached) : '') + '）')
  }

  // ② 合法 ETH：真的按 ETH 取数（价格 / K 线 / EMA 都是 ETH 的）
  const t0 = Date.now()
  const eth = await boardPayload({ bar: '1h', instId: 'ETH-USDT-SWAP', force: true })
  if (eth.ok !== true) {
    fail('boardPayload(ETH-USDT-SWAP) 取数失败：' + eth.error)
    return
  }
  if (eth.instId !== 'ETH-USDT-SWAP') {
    fail('boardPayload(ETH) 返回 instId=' + JSON.stringify(eth.instId) + '，期望 ETH-USDT-SWAP')
  }
  if (eth.price === null || eth.price.instId !== 'ETH-USDT-SWAP') {
    fail('ETH 的 ticker 不是 ETH-USDT-SWAP：' + JSON.stringify(eth.price))
  }
  const e20 = eth.ema20.filter((v) => v !== null).length
  const e480 = eth.ema480.filter((v) => v !== null).length
  const badShape = eth.candles.filter((c) => !Array.isArray(c) || c.length < 7 || (c[6] !== 0 && c[6] !== 1))
  const doneCount = eth.candles.filter((c) => c[6] === 1).length
  if (badShape.length > 0) fail('ETH 有 ' + badShape.length + ' 根 K 线缺 done 标记：' + JSON.stringify(badShape[0]))
  if (doneCount === 0 || doneCount === eth.candles.length) fail('ETH 的 done 标记分布不对（已收盘 ' + doneCount + '/' + eth.candles.length + '）')
  if (eth.stats.seriesCount < 480) fail('ETH 序列不足 480 根，EMA480 画不出来')
  if (eth.ema20.length !== eth.candles.length || eth.ema480.length !== eth.candles.length) {
    fail('ETH EMA 数组与 K 线长度不一致')
  }
  if (eth.transport !== 'proxy') fail('ETH 传输通道不是 proxy（实际 ' + eth.transport + '）')
  console.log('ok   boardPayload(ETH-USDT-SWAP) 通过：price.last=' + String(eth.price.last)
    + ' candles=' + String(eth.candles.length) + ' ema20/480=' + e20 + '/' + e480
    + ' series=' + String(eth.stats.seriesCount) + ' ' + (Date.now() - t0) + 'ms'
    + (eth.meta.cached ? ' (cached)' : ' pages=' + eth.meta.pages))

  // ③ 不传 instId 仍是默认 BTC（向后兼容；同样吃热缓存）
  const dflt = await boardPayload({ bar: '1h', force: false })
  if (dflt.instId !== 'BTC-USDT-SWAP') {
    fail('不传 instId 时 boardPayload 不是默认 BTC-USDT-SWAP（实际 ' + JSON.stringify(dflt.instId) + '）')
  } else {
    console.log('ok   不传 instId 时仍是默认 BTC-USDT-SWAP（ok=' + String(dflt.ok) + '）')
  }
}

const demoOk = await runEnv('demo')
const prodOk = await runEnv('prod')
await runInstBoardChecks(demoOk > 0 || prodOk > 0)
await runEmailChecks()
console.log('\n完成。exitCode=' + String(process.exitCode || 0))
