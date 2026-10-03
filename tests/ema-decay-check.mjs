// 排障脚本：验证 EMA 种子误差的衰减律 —— 这是判断「序列要取多深」的依据。
// 数学：两个不同种子的 EMA 递推，差值每根乘 (1-k)，k = 2/(period+1)。
//   所以序列往前多取 m 根，左端误差就乘 (1-k)^m。
// 这里用两种数据（平滑随机游走 / 强趋势）确认，避免被真实行情的孤立毛刺带偏。
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

function series(kind, n) {
  const out = []
  let p = 80000
  let seed = 12345
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const r = seed / 2147483648 - 0.5
    if (kind === 'walk') p = p + r * 120
    else if (kind === 'trend') p = p + 6 + r * 40
    else p = 80000 + Math.sin(i / 37) * 900 + Math.sin(i / 613) * 3000
    out.push(p)
  }
  return out
}

const period = 480
const k = 2 / (period + 1)
const N = 5000
const DISPLAY = 720
for (const kind of ['walk', 'trend', 'cycle']) {
  const closes = series(kind, N)
  const ref = emaForward(closes, period)
  console.log('')
  console.log('=== ' + kind + '：EMA' + period + '，可拖范围最后 ' + DISPLAY + ' 根 ===')
  console.log('  WARMUP |  实测左端误差  |  理论 = 种子误差 × (1-k)^WARMUP')
  for (const warm of [0, 240, 480, 720, 960, 1080, 1440, 1920, 2400]) {
    const total = DISPLAY + warm
    if (total > N) continue
    const off = N - total
    const slice = closes.slice(off)
    const got = emaForward(slice, period)
    // 切片里第一个有值的下标 = period-1；它在整条序列里的下标 = off + period - 1
    const i = period - 1
    const measured = Math.abs(got[i] - ref[off + i])
    // 理论：切片自己播种的值 = 用「切片前 period 根的 SMA」当种子，与真值递推的差
    let sum = 0
    for (let j = 0; j < period; j += 1) sum += closes[off + j]
    const seedValue = sum / period
    const seedError = Math.abs(seedValue - ref[off + period - 1])
    const theory = seedError * Math.pow(1 - k, warm)
    console.log('  ' + String(warm).padStart(6) + ' |' + measured.toFixed(4).padStart(16)
      + ' |' + theory.toFixed(4).padStart(16)
      + '   (种子误差 ' + seedError.toFixed(2) + ')')
  }
}
