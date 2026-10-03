/**
 * 测试脚本共用的路径解析与环境读取。
 *
 * 这些值以前是硬编码的绝对路径（`D:\codes\dsh\btc_dashboard\...`、
 * `C:\Users\<用户名>\.dsh\...`），既把本机目录和用户名写进了仓库，也让别处 clone
 * 下来跑不起来。现在统一改成「按脚本自身位置推导 + 优先读 DSH 提供的环境变量」。
 *
 * 依赖 DSH 安装布局的路径（profile、自带插件对照文件）找不到时返回 null，
 * 由调用方决定是跳过还是报错 —— 这类脚本本来就是本机排障用的。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parseEnvFile } from '../plugin/dsh-btc-dashboard/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根目录（tests/ 的上一级）。 */
export const WORKSPACE = resolve(HERE, '..')

/** 插件目录与插件本体文件。 */
export const PLUGIN_DIR = join(WORKSPACE, 'plugin', 'dsh-btc-dashboard')
export const CLIENT_FILE = join(PLUGIN_DIR, 'client.js')

/** 插件读写的那两个文件。 */
export const ENV_FILE = join(WORKSPACE, '.env')
export const STATE_FILE = join(WORKSPACE, '.dashboard', 'state.json')

/**
 * 读工作区的 `.env`（不存在就返回空对象）。
 * 解析规则复用插件自己导出的 `parseEnvFile`，避免测试与实现各写一套正则。
 */
export function readEnv() {
  try {
    return parseEnvFile(readFileSync(ENV_FILE, 'utf8'))
  } catch (error) {
    return {}
  }
}

/** 代理设置：`.env` 的 OKX_PROXY 优先，否则用本机默认的那个。 */
export function proxyFromEnv() {
  const raw = readEnv().OKX_PROXY || 'http://127.0.0.1:7897'
  try {
    const url = new URL(raw)
    return { host: url.hostname, port: Number(url.port || 80), raw: raw }
  } catch (error) {
    return { host: '127.0.0.1', port: 7897, raw: 'http://127.0.0.1:7897' }
  }
}

/** DSH 的 profile 目录：优先环境变量，否则按 ~/.dsh/profiles/<名> 推。 */
export function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const name = process.env.DSH_PROFILE || 'web'
  const candidate = join(home, 'profiles', name)
  return existsSync(candidate) ? candidate : null
}

/** profile 的 package.json —— `createRequire` 用它来解析 profile 里的 react 等依赖。 */
export function profilePackageJson() {
  const dir = profileDir()
  if (dir === null) return null
  const file = join(dir, 'package.json')
  return existsSync(file) ? file : null
}

/**
 * 请求运行中的宿主时用到的认证信息。
 *
 * 插件从 1.3.2 起对 `/dsh-btc/*` 套了 `connection.requestRejection` ——
 * 它同时做 Host/Origin 校验**和**浏览器 cookie 鉴权，所以用裸 `fetch` 打这些路由
 * 会拿到 401。那个 cookie 是进程内密钥签名的 `HttpOnly` 值，没法伪造，
 * 只能从浏览器里取出来喂进来：
 *
 *   DSH_BTC_COOKIE="<cookie 名>=<值>"    # 从 DevTools → Application → Cookies 复制
 *
 * 只做 Host/Origin 那半的检查（不带 cookie）用 `DSH_BTC_NO_COOKIE=1` 显式声明。
 */
export function authHeaders() {
  const headers = { 'sec-fetch-site': 'same-origin' }
  const raw = process.env.DSH_BTC_COOKIE
  if (raw) {
    const at = raw.indexOf('=')
    if (at > 0) headers.cookie = raw
    else headers.cookie = raw
  }
  return headers
}

/** 这个 401/403 是不是信任栅栏给的（用来把「被拒」讲成人话，而不是当成功能坏了）。 */
export function fenceHint(status) {
  if (status !== 401 && status !== 403) return null
  return status === 401
    ? '被信任栅栏拒绝（401：缺少浏览器会话 cookie）。用 DSH_BTC_COOKIE="<名>=<值>" 传入 cookie 后重试'
    : '被信任栅栏拒绝（403：Host/Origin 校验不通过）'
}

/**
 * 自带插件（`@deepseek-ai/dsh-client-ui-brand-official`）的 client.js。
 * 只用于 rev 算法对照；找不到返回 null，调用方应跳过而不是判失败。
 */
export function controlClientFile() {
  const candidates = []
  const profile = profileDir()
  if (profile !== null) {
    candidates.push(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules',
      '@deepseek-ai', 'dsh-client-ui-brand-official', 'lib', 'client.js'))
  }
  // 全局 npm 安装（`npm i -g @deepseek-ai/dsh`）的常见位置
  candidates.push(join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules',
    '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-brand-official', 'lib', 'client.js'))
  if (process.env.DSH_BRAND_CLIENT) candidates.unshift(process.env.DSH_BRAND_CLIENT)
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return null
}
