// 证明「运行中的宿主确实在把本插件的浏览器半卖给页面」：
// bundle 地址里的 rev 是文件元数据的哈希，可以在本地算出来，然后按真实地址取回字节。
import { statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CLIENT_FILE, controlClientFile } from './_paths.mjs'

const BASE = 'http://127.0.0.1:19387'
const HASH_LEN = 12
const ID = '@local/dsh-btc-dashboard'
const CLIENT = CLIENT_FILE
const CONTROL = controlClientFile()

function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(String(Buffer.byteLength(part)) + ':').update(part)
  return hash.digest('hex').slice(0, HASH_LEN)
}
function revisionOf(stat) {
  return framedHash('plugin-artifact', [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)])
}
function comboRevision(id, rev) {
  return framedHash('combo', [id, rev])
}

let failed = 0
function check(ok, label, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
  if (!ok) failed += 1
}

const stat = statSync(CLIENT)
const rev = revisionOf(stat)
const comboRev = comboRevision(ID, rev)
console.log('client.js: size=' + stat.size + ' mtimeMs=' + stat.mtimeMs)
console.log('   rev=' + rev + '  comboRev=' + comboRev)

const candidates = [
  ['chunk', '/plugins/' + ID + '/client.js?rev=' + rev],
  ['combo', '/plugins/??' + ID + '/client.js&rev=' + comboRev],
]

let got = null
for (const [kind, url] of candidates) {
  const res = await fetch(BASE + url)
  const body = await res.text()
  console.log('   ' + kind.padEnd(6) + ' HTTP ' + res.status + ' len=' + body.length)
  if (res.status === 200 && got === null) got = { kind, body, url }
}

check(got !== null, '按真实 rev 取回了 bundle')
if (got !== null) {
  const local = readFileSync(CLIENT, 'utf8')
  check(got.kind === 'chunk', '命中的是 chunk 形式', got.kind)
  check(got.body.length > 0 && got.body.length === local.length, '返回字节数与本地一致',
    got.body.length + ' vs ' + local.length)
  check(got.body === local, '返回内容与本地文件逐字节一致')
  check(got.body.indexOf('@local/dsh-btc-dashboard') >= 0, '内容含模块 id')
  check(got.body.indexOf('EMA480') >= 0, '内容含 EMA480')
  check(got.body.indexOf('1D') >= 0, '内容含 1D 周期')
} else if (CONTROL === null) {
  console.log('   对照跳过：找不到自带插件的 client.js（可用 DSH_BRAND_CLIENT 指定）')
} else {
  // 对照：连自带插件也取不到，说明是 rev 算法不对，而不是插件没被组装
  const controlStat = statSync(CONTROL)
  const controlRev = revisionOf(controlStat)
  const controlRes = await fetch(BASE + '/plugins/@deepseek-ai/dsh-client-ui-brand-official/client.js?rev=' + controlRev)
  console.log('   对照（自带插件）HTTP ' + controlRes.status + ' rev=' + controlRev)
}

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exitCode = failed === 0 ? 0 : 1
