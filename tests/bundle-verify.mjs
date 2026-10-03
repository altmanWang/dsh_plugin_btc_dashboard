// 证明「运行中的宿主确实在把本插件的浏览器半卖给页面」：
// 从首页的 __DSH_BOOT__ 里取出真实 bundle 地址，按该地址取回字节，并核验里面确实有本插件的代码。
//
// 为什么不再自己拼 /plugins/<id>/client.js?rev=...：
//   1) 宿主实际发的是**多插件拼接**的 combo 地址（/plugins/??a/client.js,b/client.js&rev=<comboRev>），
//      comboRev 是「所有参与插件的 revision 一起算」的哈希，本地只算自己那一个必然对不上；
//   2) 端口原来写死 19387，宿主换到 3080 之后这个脚本就一直失败。
// 所以现在：端口可用 DSH_BTC_BASE 覆盖，地址从页面里读，比对方式是「服务端返回的内容是否
// 逐字节包含本地 client.js 全文」。
//
// /plugins/ 与首页一样有 cookie 鉴权，需要 DSH_BTC_COOKIE="<名>=<值>"（DevTools → Application → Cookies）。
// 没给 cookie 时会打印提示并跳过（退出码 0），而不是报成插件坏了。
import { readFileSync } from 'node:fs'
import { CLIENT_FILE, authHeaders, fenceHint } from './_paths.mjs'

const BASE = (process.env.DSH_BTC_BASE || 'http://127.0.0.1:3080').replace(/\/$/, '')
const ID = '@local/dsh-btc-dashboard'
const CLIENT = CLIENT_FILE

let failed = 0
function check(ok, label, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
  if (!ok) failed += 1
}
function skip(reason) {
  console.log('跳过：' + reason)
  process.exit(0)
}

const local = readFileSync(CLIENT, 'utf8')
console.log('client.js: ' + local.length + ' 字符 / ' + Buffer.byteLength(local) + ' 字节')

const page = await fetch(BASE + '/', { headers: authHeaders(), redirect: 'manual' })
const pageHint = fenceHint(page.status)
if (pageHint !== null) skip(pageHint)
if (page.status !== 200) skip('首页返回 HTTP ' + page.status)

const html = await page.text()
// boot 里的地址是 HTML 转义过的（&amp;rev=），要先还原
const urls = Array.from(new Set(
  Array.from(html.matchAll(/["']([^"'\s]*\/client\.js[^"'\s]*)["']/gu)).map((m) => m[1].replaceAll('&amp;', '&')),
)).filter((u) => u.indexOf(ID + '/client.js') >= 0)

check(urls.length > 0, '首页 boot 里有本插件的 bundle 地址')
if (urls.length === 0) {
  console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
  process.exitCode = 1
  process.exit()
}

const url = urls[0]
console.log('   bundle: ' + url.slice(0, 160) + (url.length > 160 ? ' …（+' + (url.length - 160) + ' 字符）' : ''))

const res = await fetch(BASE + '/' + url.replace(/^\//u, ''), { headers: authHeaders() })
const resHint = fenceHint(res.status)
if (resHint !== null) skip(resHint)
const body = await res.text()
console.log('   HTTP ' + res.status + ' len=' + body.length)

check(res.status === 200, '按 boot 里的真实地址取回了 bundle')
check(body.indexOf(local) >= 0, '返回内容逐字节包含本地 client.js',
  body.length + ' 字节里包含 ' + local.length + ' 字符')
if (body.indexOf(local) < 0 && body.length > 0) {
  // 给出可诊断的差异位置，而不是只说"不一致"
  const at = body.indexOf(local.slice(0, 200))
  console.log('   本地开头 200 字符在响应里的位置: ' + at)
}
check(body.indexOf(ID) >= 0, '内容含模块 id')
check(body.indexOf('EMA480') >= 0, '内容含 EMA480')
check(body.indexOf('1D') >= 0, '内容含 1D 周期')

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exitCode = failed === 0 ? 0 : 1
