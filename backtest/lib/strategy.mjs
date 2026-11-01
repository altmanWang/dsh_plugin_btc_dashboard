/**
 * 策略定义、参数合并与加载。
 *
 * 策略就是**一个纯对象**：`{ name, params, onStart?, onBar, onEnd? }`。
 * 约定：
 *   - 策略只通过 `ctx` 下单，不自己记账、不碰文件、不发网络请求；
 *   - `onBar(ctx, bar, index)` 在每根 K 线**收盘后**调用，产出的委托下一根才可能成交
 *     （引擎保证，见 SPEC §6.1）；
 *   - 后续加策略 = 往 `backtest/strategies/` 丢一个 `.mjs`，默认导出 `defineStrategy({...})`。
 *
 * 为什么要 `defineStrategy` 包一层：策略是用户会不断新增的文件，最容易出的错是
 * 「忘了写 onBar」「params 写成数组」「名字拼错导致 --param 静默无效」。
 * 这些在加载时就报中文错误，比回测跑完发现什么都没做强。
 */
import { readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 内置策略目录：`backtest/strategies/`。 */
export const STRATEGIES_DIR = resolve(HERE, '..', 'strategies')

/** 策略 API 版本：ctx 的接口变了就加一，文档里对得上。 */
export const STRATEGY_API_VERSION = 1

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验并冻结一个策略定义。非法定义抛中文 Error（带字段名，方便直接改）。
 */
export function defineStrategy(def) {
  if (!isPlainObject(def)) throw new Error('策略定义必须是对象')
  const name = typeof def.name === 'string' ? def.name.trim() : ''
  if (name === '') throw new Error('策略缺少 name（非空字符串）')
  if (typeof def.onBar !== 'function') throw new Error('策略「' + name + '」缺少 onBar(ctx, bar, index) 函数')

  const params = def.params === undefined ? {} : def.params
  if (!isPlainObject(params)) throw new Error('策略「' + name + '」的 params 必须是对象（键=参数名，值=默认值）')
  for (const key of Object.keys(params)) {
    const value = params[key]
    const primitive = typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
    if (!primitive || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('策略「' + name + '」的参数 ' + key + ' 默认值必须是有限数字/字符串/布尔值')
    }
  }

  for (const hook of ['onStart', 'onEnd']) {
    if (def[hook] !== undefined && typeof def[hook] !== 'function') {
      throw new Error('策略「' + name + '」的 ' + hook + ' 必须是函数')
    }
  }

  return Object.freeze({
    apiVersion: STRATEGY_API_VERSION,
    name,
    params: Object.freeze({ ...params }),
    onStart: def.onStart,
    onBar: def.onBar,
    onEnd: def.onEnd,
  })
}

/**
 * 合并默认参数与覆盖值（CLI 的 `--param fast=10`）。
 * 按**默认值的类型**转换；未知参数名直接报错（拼错的参数会变成"没生效"，最难查）。
 */
export function resolveParams(strategy, overrides = {}) {
  if (!isPlainObject(overrides)) throw new Error('策略参数覆盖值必须是对象')
  const merged = { ...strategy.params }
  for (const key of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      const known = Object.keys(merged)
      throw new Error('策略「' + strategy.name + '」没有参数 ' + JSON.stringify(key)
        + (known.length > 0 ? '（可用参数：' + known.join(' / ') + '）' : '（它没有可配置参数）'))
    }
    const raw = overrides[key]
    const fallback = merged[key]
    if (typeof fallback === 'number') {
      const value = Number(raw)
      if (!Number.isFinite(value)) {
        throw new Error('参数 ' + key + ' 需要数字，收到：' + JSON.stringify(String(raw)))
      }
      merged[key] = value
    } else if (typeof fallback === 'boolean') {
      const text = String(raw).trim().toLowerCase()
      if (text !== 'true' && text !== 'false') {
        throw new Error('参数 ' + key + ' 需要 true/false，收到：' + JSON.stringify(String(raw)))
      }
      merged[key] = text === 'true'
    } else {
      merged[key] = String(raw)
    }
  }
  return merged
}

/** 合并参数后的新策略对象（CLI 用，不改动原对象）。 */
export function withResolvedParams(strategy, overrides = {}) {
  return defineStrategy({ ...strategy, params: resolveParams(strategy, overrides) })
}

/** 列出内置策略（`backtest/strategies/*.mjs`，按名字排序）。目录不存在返回空数组。 */
export function listStrategies() {
  let names
  try {
    names = readdirSync(STRATEGIES_DIR)
  } catch (error) {
    return []
  }
  return names
    .filter((file) => file.endsWith('.mjs') && !file.startsWith('_'))
    .map((file) => ({ name: file.slice(0, -4), file: join(STRATEGIES_DIR, file) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function looksLikePath(value) {
  return value.endsWith('.mjs') || value.endsWith('.js')
    || value.includes('/') || value.includes('\\') || isAbsolute(value)
}

async function importStrategy(file, display) {
  let module
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    throw new Error('加载策略「' + display + '」失败：' + String((error && error.message) || error))
  }
  const def = module.default
  if (def === undefined || def === null) {
    throw new Error('策略文件「' + display + '」没有默认导出（应 `export default defineStrategy({...})`）')
  }
  // 文件里可能直接写了个普通对象；统一过一遍校验，错误信息一致。
  return defineStrategy(def)
}

/**
 * 按名字（内置策略）或路径加载策略。
 * @param {string} nameOrPath `sma-cross` / `./my-strategy.mjs` / 绝对路径
 */
export async function loadStrategy(nameOrPath) {
  if (typeof nameOrPath !== 'string' || nameOrPath.trim() === '') {
    throw new Error('没有指定策略（--strategy <名字|文件>）')
  }
  const wanted = nameOrPath.trim()
  if (looksLikePath(wanted)) {
    const file = isAbsolute(wanted) ? wanted : resolve(process.cwd(), wanted)
    return importStrategy(file, wanted)
  }
  const available = listStrategies()
  const match = available.find((item) => item.name === wanted)
    || available.find((item) => item.name.toLowerCase() === wanted.toLowerCase())
  if (match === undefined) {
    throw new Error('没有内置策略 ' + JSON.stringify(wanted)
      + (available.length > 0 ? '（可用：' + available.map((item) => item.name).join(' / ') + '）' : '（策略目录是空的）'))
  }
  return importStrategy(match.file, match.name)
}
