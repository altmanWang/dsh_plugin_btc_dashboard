// 排障脚本（不是回归测试）：量化「均线预热」误差，决定客户端该怎么补窗口外的均线。
//
// 参考值：用 5000 根 K 线、前向 SMA(period) 播种算出的 EMA，取最后 720 根作为「真值」。
// 候选方案在同样的 720 根上重算，比一比左端差多少。
const n = 5000
const closes = []
let price = 80000
for (let i = 0; i < n; i += 1) {
  price = price + Math.sin(i / 7) * 60 + Math.sin(i / 311) * 400 + (i % 13 === 0 ? -180 : 40)
  closes.push(price)
}

function emaForward(values, period, warm) {
  // warm: 从 index warm 开始（用前面的数据预热），返回与 values 等长的数组
  const out = new Array(values.length).fill(null)
  if (values.length < period) return out
  let sum = 0
  for (let i = warm; i < warm + period; i += 1) sum += values[i]
  let prev = sum / period
  out[warm + period - 1] = prev
  const k = 2 / (period + 1)
  for (let i = warm + period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** 候选：在给定切片上，先用「尾部 3*period 根的 SMA」播种，再往左倒推。 */
function emaFromTail(values, period) {
  const len = values.length
  const out = new Array(len).fill(null)
  if (len === 0 || period < 1) return out
  const seedLen = Math.min(len, Math.max(period, 3 * period))
  let sum = 0
  for (let i = len - seedLen; i < len; i += 1) sum += values[i]
  let v = sum / seedLen
  out[len - 1] = v
  const k = 2 / (period + 1)
  for (let i = len - 2; i >= 0; i -= 1) {
    v = values[i] * k + v * (1 - k)
    out[i] = v
  }
  return out
}

/** 候选：老实的「前向 + 前 period 根做种子」，也就是 Host 现在干的事。 */
function emaForwardNaive(values, period) {
  return emaForward(values, period, 0)
}

const tail = closes.slice(n - 720)
const ref = {}
for (const period of [20, 480]) {
  const full = emaForward(closes, period, 0)
  ref[period] = full.slice(n - 720)
}

for (const period of [20, 480]) {
  console.log('=== period ' + period + ' （720 根切片）===')
  for (const [name, fn] of [['tail-seed 倒推', emaFromTail], ['前向 + 首段播种（现状）', emaForwardNaive]]) {
    const got = fn(tail, period)
    const stats = { max: 0, maxAt: -1, at0: null, at180: null, at360: null, at540: null, at700: null }
    for (let i = 0; i < 720; i += 1) {
      if (ref[period][i] === null || got[i] === null) continue
      const err = Math.abs(got[i] - ref[period][i])
      if (err > stats.max) { stats.max = err; stats.maxAt = i }
      if (i === 0) stats.at0 = err
      if (i === 180) stats.at180 = err
      if (i === 360) stats.at360 = err
      if (i === 540) stats.at540 = err
      if (i === 700) stats.at700 = err
    }
    console.log('  ' + name)
    console.log('    |误差| 最大 ' + stats.max.toFixed(2) + ' @i=' + stats.maxAt
      + '  i0=' + (stats.at0 === null ? '—' : stats.at0.toFixed(2))
      + '  i180=' + (stats.at180 === null ? '—' : stats.at180.toFixed(2))
      + '  i360=' + (stats.at360 === null ? '—' : stats.at360.toFixed(2))
      + '  i540=' + (stats.at540 === null ? '—' : stats.at540.toFixed(2))
      + '  i700=' + (stats.at700 === null ? '—' : stats.at700.toFixed(2)))
  }
}
