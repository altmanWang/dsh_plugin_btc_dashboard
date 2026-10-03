// 排障脚本（不是回归测试）：用真实 OKX K 线量化「序列取多长，展示窗口左端的 EMA480 才够准」。
//
// 真值：序列取到 4000+ 根，前向 SMA 播种算 EMA，取最后 720 根作为参照。
// 现状：host 取 720 根（SERIES_BARS），最后 720 根全发给客户端 ⇒ 客户端能拖到的最左一根就是
//       序列第 0 根，它的 EMA480 只是「前 480 根的 SMA」，离收敛值差得远 —— 拖动时看到的
//       「窗口外没有均线 / 均线不对」就是这一条。
import { rawGet } from '../plugin/dsh-btc-dashboard/index.js'
import { proxyFromEnv } from './_paths.mjs'

const PROXY = proxyFromEnv()

async function get(path) {
  let last = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await rawGet('proxy', 'https://www.okx.com' + path, {}, 15000, PROXY)
      if (res.status !== 200) throw new Error('HTTP ' + res.status + ' ' + path)
      const body = JSON.parse(res.body.toString('utf8'))
      if (body.code !== '0') throw new Error('code ' + body.code + ' ' + body.msg)
      return body.data
    } catch (error) {
      last = error
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  throw last
}

const BAR = process.argv[2] || '15m'
const TARGET = Number(process.argv[3] || 4200)
const INST = 'BTC-USDT-SWAP'

const recent = await get('/api/v5/market/candles?instId=' + INST + '&bar=' + BAR + '&limit=300')
let rows = recent.map((r) => ({ t: Number(r[0]), c: Number(r[4]) })).sort((a, b) => a.t - b.t)
let pages = 0
while (rows.length < TARGET && pages < 80) {
  pages += 1
  const page = await get('/api/v5/market/history-candles?instId=' + INST + '&bar=' + BAR + '&after=' + rows[0].t + '&limit=100')
  if (!Array.isArray(page) || page.length === 0) break
  const map = new Map()
  for (const r of page.map((x) => ({ t: Number(x[0]), c: Number(x[4]) })).concat(rows)) map.set(r.t, r)
  rows = Array.from(map.values()).sort((a, b) => a.t - b.t)
}
console.log('/ ' + BAR + ' bars=' + rows.length + ' pages=' + pages + ' ' + new Date(rows[0].t).toISOString() + ' -> ' + new Date(rows[rows.length - 1].t).toISOString())
const closes = rows.map((r) => r.c)

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
const lastClose = closes[n - 1]

for (const period of [20, 480]) {
  const ref = emaForward(closes, period)
  console.log('')
  console.log('=== EMA' + period + ' (truth = ' + n + ' bars; errors measured on the last ' + DISPLAY + ' bars) ===')
  console.log('  SERIES | err@i=0 | err@i=180 | err@i=360 | err@i=540 | err@i=719 | err@i=0 %')
  for (const target of [720, 1020, 1320, 1620, 1920, 2400, 3000, n]) {
    if (target > n) continue
    const slice = closes.slice(n - target)
    const got = emaForward(slice, period)
    const off = n - target
    const at = {}
    let valid = 0
    for (let i = 0; i < target; i += 1) {
      const a = got[i]
      const b = ref[off + i]
      const ok = a !== null && b !== null
      if (ok) valid += 1
      if (i === 0 || i === 180 || i === 360 || i === 540 || i === target - 1) at[i] = ok ? Math.abs(a - b) : null
    }
    const cells = [0, 180, 360, 540, target - 1].map(function (i) {
      const v = at[i]
      return v === undefined ? '   n/a  ' : (v === null ? '  null  ' : v.toFixed(2).padStart(8))
    })
    const pct = at[0] === null || at[0] === undefined ? 'null' : ((at[0] / lastClose) * 100).toFixed(3) + '%'
    console.log('  ' + String(target).padStart(6) + ' |' + cells.join(' |') + ' | ' + pct.padStart(9) + '  valid=' + valid)
  }
}
process.exit(0)
