/**
 * 指标小工具：EMA / SMA / ATR，以及"逐根递推"版本。
 *
 * 为什么既要有全序列版又要有 step 版：
 *   - 全序列版（`ema` / `sma` / `atr`）写起来直观，测试和核对用；
 *   - 策略里**必须用 step 版**：一次回测几万根 K 线、参数扫描上百组，
 *     每根都从 `ctx.window()` 重算一遍指标是 O(n·period) 的，扫一遍能跑几分钟。
 *     递推版每根 O(1)，让「参数扫描」这种用法真的可用。
 *
 * 约定（和 backtest/lib/config.mjs 的口径一致）：
 *   - 输入都是按时间升序的数组；输出与输入等长，数据不够的位置是 null；
 *   - EMA 用前 period 根的 SMA 做种子（与看板插件的 `ema()` 口径一致）；
 *   - ATR 用 Wilder 平滑：首值是前 period 个 TR 的简单平均，之后 `(prev*(p-1)+TR)/p`；
 *   - TR = max(high-low, |high-prevClose|, |low-prevClose|)，第一根没有 prevClose，TR 为 null。
 */

/** 简单移动平均；不足 period 的位置是 null。 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null)
  const p = Math.floor(Number(period))
  if (!Array.isArray(values) || p < 1 || values.length < p) return out
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]
    if (i >= p) sum -= values[i - p]
    if (i >= p - 1) out[i] = sum / p
  }
  return out
}

/** 指数移动平均（SMA 种子），与看板插件口径一致；不足 period 的位置是 null。 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null)
  const p = Math.floor(Number(period))
  if (!Array.isArray(values) || p < 1 || values.length < p) return out
  let sum = 0
  for (let i = 0; i < p; i += 1) sum += values[i]
  let prev = sum / p
  out[p - 1] = prev
  const k = 2 / (p + 1)
  for (let i = p; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** 单根真实波幅；没有前收（第一根）返回 null。 */
export function trueRange(bar, prevClose) {
  if (prevClose === null || prevClose === undefined || !Number.isFinite(Number(prevClose))) return null
  const high = Number(bar.h)
  const low = Number(bar.l)
  const close = Number(prevClose)
  return Math.max(high - low, Math.abs(high - close), Math.abs(low - close))
}

/** 全序列 ATR（Wilder 平滑）；数据不够的位置是 null。 */
export function atr(bars, period) {
  const out = new Array(bars.length).fill(null)
  const p = Math.floor(Number(period))
  if (!Array.isArray(bars) || p < 1 || bars.length < p + 1) return out
  const trs = []
  for (let i = 1; i < bars.length; i += 1) trs.push(trueRange(bars[i], bars[i - 1].c))
  // trs[k] 对应 bars[k+1]；前 p 个 TR 的简单平均是 bars[p] 的 ATR
  let seed = 0
  for (let k = 0; k < p; k += 1) seed += trs[k]
  let prev = seed / p
  out[p] = prev
  for (let k = p; k < trs.length; k += 1) {
    prev = (prev * (p - 1) + trs[k]) / p
    out[k + 1] = prev
  }
  return out
}

/** 递推 EMA 一步：`prev` 为上一根的 EMA（第一根用 SMA 种子）。 */
export function emaStep(prev, value, period) {
  const k = 2 / (Math.floor(Number(period)) + 1)
  return Number(value) * k + Number(prev) * (1 - k)
}

/** 递推 ATR 一步（Wilder）。`prevAtr` 是上一根 ATR，`tr` 是本根真实波幅。 */
export function atrStep(prevAtr, tr, period) {
  const p = Math.floor(Number(period))
  return (Number(prevAtr) * (p - 1) + Number(tr)) / p
}

/** 一段数组里最大的一个；空数组返回 null（策略里用它算 Donchian 通道）。 */
export function maxOf(values) {
  let best = null
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i])
    if (Number.isFinite(value) && (best === null || value > best)) best = value
  }
  return best
}

/** 一段数组里最小的一个；空数组返回 null。 */
export function minOf(values) {
  let best = null
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i])
    if (Number.isFinite(value) && (best === null || value < best)) best = value
  }
  return best
}
