// 排障脚本（不是回归测试）：序列要取多深，客户端能拖到的最左边那根 EMA480 才算收敛？
//
// 真值 = 全序列前向播种。被测 = 在「最后 DISPLAY+WARMUP 根」这个切片上前向播种（= 客户端现在做的事）。
// 误差随 WARMUP 指数衰减：EMA 的种子误差每根乘 (1-k)，k=2/(period+1) ⇒ 480 根均线每 240 根衰减到 37%。
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
const TOTAL = Number(process.argv[3] || 8000)
const INST = 'BTC-USDT-SWAP'
const recent = await get('/api/v5/market/candles?instId=' + INST + '&bar=' + BAR + '&limit=300')
let rows = recent.map((r) => ({ t: Number(r[0]), c: Number(r[4]) })).sort((a, b) => a.t - b.t)
let guard = 0
while (rows.length < TOTAL && guard < 120) {
  guard += 1
  const page = await get('/api/v5/market/history-candles?instId=' + INST + '&bar=' + BAR + '&after=' + rows[0].t + '&limit=100')
  if (!Array.isArray(page) || page.length === 0) break
  const map = new Map()
  for (const r of page.map((x) => ({ t: Number(x[0]), c: Number(x[4]) })).concat(rows)) map.set(r.t, r)
  rows = Array.from(map.values()).sort((a, b) => a.t - b.t)
}
const closes = rows.map((r) => r.c)
const last = closes[closes.length - 1]
console.log('bar=' + BAR + ' bars=' + closes.length + ' lastPrice=' + last.toFixed(0))

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

const n = closes.length
const DISPLAY = 720
const ref = { 20: emaForward(closes, 20), 480: emaForward(closes, 480) }

console.log('')
console.log('最大绝对误差 / 相对现价（只看可拖范围内的有效值）')
console.log('  WARMUP | 总根数 | EMA20 左端 | EMA480 左端 | EMA480 i=659 | EMA480 最大 | 相对现价')
for (const warm of [0, 120, 240, 360, 480, 720, 960, 1080, 1440, 1920, 2400, 2880, 3840]) {
  const total = DISPLAY + warm
  if (total > n) continue
  const slice = closes.slice(n - total)
  const off = n - total
  const row = { warm: warm, total: total }
  for (const period of [20, 480]) {
    const got = emaForward(slice, period)
    let worst = 0
    let atLeft = null
    for (let i = 0; i < DISPLAY; i += 1) {
      if (got[i] === null) continue
      const e = Math.abs(got[i] - ref[period][off + i])
      if (atLeft === null) atLeft = e
      if (e > worst) worst = e
    }
    row['p' + period] = { left: atLeft, worst: worst }
  }
  console.log('  ' + String(warm).padStart(6) + ' |' + String(total).padStart(7) + ' |'
    + (row.p20.left === null ? '     —    ' : (row.p20.left.toFixed(2) + '$').padStart(10)) + ' |'
    + (row.p480.left === null ? '     —（还没有值）' : (row.p480.left.toFixed(2) + '$').padStart(16)) + ' |'
    + (row.p480.worst === undefined ? '' : '' ) + (row.p480.left === null ? '' : '')
    + ' ' + (row.p480.left === null ? '' : ((row.p480.left / last) * 100).toFixed(3) + '%').padStart(9) + ' |'
    + (row.p480.worst === null ? '      —      ' : (row.p480.worst.toFixed(2) + '$').padStart(14)) + ' |'
    + (row.p480.left === null ? '' : ((row.p480.left / last) * 100).toFixed(3) + '%').padStart(10))
}
process.exit(0)
