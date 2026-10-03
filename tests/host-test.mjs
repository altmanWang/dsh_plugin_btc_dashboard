// 插件 Host 半的自检：传输通道、6 个周期、EMA 正确性、环境切换。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { boardPayload, healthPayload, parseEnvFile, ema } from '../plugin/dsh-btc-dashboard/index.js'
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
}

// ---- 5) 六个周期：真实取数 + EMA480 覆盖率
async function runEnv(envId) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify({ env: envId }), 'utf8')
  console.log('\n===== 环境 ' + envId + ' =====')
  for (const bar of BARS) {
    const t0 = Date.now()
    const out = await boardPayload({ bar, limit: 180, force: true })
    const ms = Date.now() - t0
    if (out.ok !== true) { fail('bar ' + bar + ' 取数失败：' + out.error); console.log('     ' + out.error); continue }
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
  }
}

await runEnv('demo')
await runEnv('prod')
console.log('\n完成。exitCode=' + String(process.exitCode || 0))
