// 排障脚本（不是回归测试）：在浏览器侧现算均线，怎么才能让「最左边那根」也准？
//
// 三种打法（都用真实 OKX 数据，真值 = 全序列前向播种）：
//   A forward-seed   ：在拿到的切片上从第 0 根前向播种 —— 切片的左端就是种子误差最大处
//   B backward-seed  ：种子取「最后 N 根的 SMA/最后的收敛值」，再按 EMA 的逆递推往左走
//                      EMA_i = EMA_{i+1}/(1-k) - c_i*k/(1-k)，即把误差按 (1-k) 反复衰减
//   C reverse-order  ：把序列倒过来当普通 EMA 跑一遍 —— 数值上等价于另一种加权，误差随时间指数放大
import { rawGet } from '../plugin/dsh-btc-dashboard/index.js'
import { proxyFromEnv } from './_paths.mjs'

const PROXY = proxyFromEnv()

async function get(path) {
  let last = null
  for (let i = 0; i < 4; i += 1) {
    try {
      const res = await rawGet('proxy', 'https://www.okx.com' + path, {}, 15000, PROXY)
      const body = JSON.parse(res.body.toString('utf8'))
      if (res.status !== 200 || body.code !== '0') throw new Error('HTTP ' + res.status + ' code ' + body.code)
      return body.data
    } catch (error) { last = error; await new Promise((r) => setTimeout(r, 300)) }
  }
  throw last
}

const BAR = process.argv[2] || '15m'
const TOTAL = Number(process.argv[3] || 7000)
const INST = 'BTC-USDT-SWAP'
const recent = await get('/api/v5/market/candles?instId=' + INST + '&bar=' + BAR + '&limit=300')
let rows = recent.map((r) => ({ t: Number(r[0]), c: Number(r[4]) })).sort((a, b) => a.t - b.t)
let guard = 0
while (rows.length < TOTAL && guard < 100) {
  guard += 1
  const page = await get('/api/v5/market/history-candles?instId=' + INST + '&bar=' + BAR + '&after=' + rows[0].t + '&limit=100')
  if (!Array.isArray(page) || page.length === 0) break
  const map = new Map()
  for (const r of page.map((x) => ({ t: Number(x[0]), c: Number(x[4]) })).concat(rows)) map.set(r.t, r)
  rows = Array.from(map.values()).sort((a, b) => a.t - b.t)
}
const closes = rows.map((r) => r.c)
console.log('bar=' + BAR + ' bars=' + closes.length + ' last=' + closes[closes.length - 1])
// 数据完整性：K 线必须等间隔，否则「切片 ↔ 真值」的下标对不上，误差全是假的
{
  const gaps = new Map()
  for (let i = 1; i < rows.length; i += 1) {
    const d = rows[i].t - rows[i - 1].t
    gaps.set(d, (gaps.get(d) || 0) + 1)
  }
  const sorted = Array.from(gaps.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4)
  console.log('时间间隔分布(ms): ' + sorted.map((g) => g[0] + '×' + g[1]).join(', '))
}

function emaForward(values, period) {
  const out = new Array(values.length).fill(null)
  if (values.length < period) return out
  let sum = 0
  for (let i = 0; i < period; i += 1) sum += values[i]
  let prev = sum / period
  out[period - 1] = prev
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i += 1) { prev = values[i] * k + prev * (1 - k); out[i] = prev }
  return out
}

/** A：切片上直接前向播种（= 现在客户端对拿到的序列做的事） */
function forwardSeed(values, period) {
  return emaForward(values, period)
}

/** B：先算出末端的 EMA（用整段里最后 min(len,3*period) 根做种子前向跑），再往左逆递推 */
function backwardSeed(values, period) {
  const len = values.length
  const out = new Array(len).fill(null)
  if (len < period) return out
  const k = 2 / (period + 1)
  // 末端种子：用最后 seedLen 根做 SMA 当锚（seedLen 取 3*period，最多到 len）
  const seedLen = Math.min(len, period * 3)
  let sum = 0
  for (let i = len - seedLen; i < len; i += 1) sum += values[i]
  const anchorIdx = len - seedLen + period - 1 >= 0 ? len - seedLen + period - 1 : period - 1
  // 先由种子点前向推到最后一根（拿一个可信的末端值）
  const tail = emaForward(values.slice(len - seedLen), period)
  let v = tail[seedLen - 1]
  out[len - 1] = v
  for (let i = len - 2; i >= 0; i -= 1) {
    v = (v - values[i] * k) / (1 - k)
    out[i] = v
  }
  return out
}

/** C：倒序跑普通 EMA（不推荐，作为对照） */
function reversedSeed(values, period) {
  const rev = values.slice().reverse()
  const got = emaForward(rev, period).reverse()
  return got
}

const n = closes.length
const DISPLAY = 720
const WARMUPS = [0, 240, 480, 720, 1080]
for (const period of [480]) {
  const ref = emaForward(closes, period)
  console.log('')
  console.log('=== EMA' + period + '：真值 = 全序列（' + n + ' 根）前向播种 ===')
  console.log('  预热 | A 前向播种@左端 | B 逆递推@左端 | C 倒序@左端 | A@i=180 | B@i=180 | C@i=180 | B@i=719')
  for (const warm of WARMUPS) {
    const slice = closes.slice(n - DISPLAY - warm, n - warm)
    const off = n - DISPLAY - warm
    // 真值必须切成「同一条时间轴的同一段」：slice[i] 对应 ref[i]（前面 warm 根的 ref 用不上），
    // 早先写成 ref[off+i] 是把下标整体挪了 warm 位，误差全是假的。
    const truth = ref.slice(0, n - warm)
    const got = {
      A: forwardSeed(slice, period),
      B: backwardSeed(slice, period),
      C: reversedSeed(slice, period),
    }
    // 只看切片里 period-1 之后的部分（前面本来就画不出）
    const idx = [Math.max(0, period - 1), Math.max(0, Math.min(DISPLAY - 1, period - 1 + 180)), DISPLAY - 1]
    const err = (name, i) => {
      const a = got[name][i]
      const b = truth[off + i]
      if (a === null || b === null) return '     —  '
      return Math.abs(a - b).toFixed(2).padStart(8)
    }
    console.log('  ' + String(warm).padStart(4) + ' |' + err('A', idx[0]) + '        |' + err('B', idx[0])
      + '       |' + err('C', idx[0]) + '     |' + err('A', idx[1]) + '  |' + err('B', idx[1])
      + '  |' + err('C', idx[1]) + '  |' + err('B', idx[2]))
  }
  console.log('  （左端 = 可拖范围内第一个有值的下标 i=' + (period - 1) + '，$ 为绝对误差，现价≈' + closes[n - 1].toFixed(0) + '）')
}
process.exit(0)
