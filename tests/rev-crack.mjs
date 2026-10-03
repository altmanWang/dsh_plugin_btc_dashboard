// 反推 bundle URL 里的 rev：用「自带插件」做对照，试几种元数据编码，命中即证明算法。
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CLIENT_FILE, controlClientFile } from './_paths.mjs'

const BASE = 'http://127.0.0.1:19387'
const LEN = 12
const BRAND_CLIENT = controlClientFile()

function framed(domain, parts) {
  const h = createHash('sha1').update(domain).update('\0')
  for (const p of parts) h.update(String(Buffer.byteLength(p)) + ':').update(p)
  return h.digest('hex').slice(0, LEN)
}

const cases = [
  ['btc-dashboard', '@local/dsh-btc-dashboard', 'client.js', CLIENT_FILE],
]
if (BRAND_CLIENT !== null) {
  cases.push(['brand-official', '@deepseek-ai/dsh-client-ui-brand-official', 'lib/client.js', BRAND_CLIENT])
} else {
  console.log('（跳过自带插件对照：找不到它的 client.js，可用 DSH_BRAND_CLIENT 指定）')
}

for (const [label, id, fileName, file] of cases) {
  const s = statSync(file)
  const b = statSync(file, { bigint: true })
  const variants = {
    'float ms': [String(s.mtimeMs), String(s.ctimeMs), String(s.size)],
    'trunc ms': [String(Math.trunc(s.mtimeMs)), String(Math.trunc(s.ctimeMs)), String(s.size)],
    'bigint ms': [String(b.mtimeMs), String(b.ctimeMs), String(b.size)],
    'float ms + birth': [String(s.mtimeMs), String(s.birthtimeMs), String(s.size)],
    'mtime only': [String(s.mtimeMs), String(s.size)],
    'iso dates': [s.mtime.toISOString(), s.ctime.toISOString(), String(s.size)],
    'bigint ns': [String(b.mtimeNs), String(b.ctimeNs), String(b.size)],
  }
  console.log('\n== ' + label + ' (' + file + ')')
  console.log('   mtimeMs=' + s.mtimeMs + ' ctimeMs=' + s.ctimeMs + ' size=' + s.size)
  let hit = null
  for (const [name, parts] of Object.entries(variants)) {
    const rev = framed('plugin-artifact', parts)
    const url = BASE + '/plugins/' + id + '/' + fileName + '?rev=' + rev
    const res = await fetch(url)
    const body = res.status === 200 ? await res.text() : ''
    console.log('   ' + name.padEnd(16) + ' rev=' + rev + '  HTTP ' + res.status + (body ? '  len=' + body.length : ''))
    if (res.status === 200 && hit === null) hit = { name, rev, body, url }
  }
  if (hit !== null) {
    console.log('   >>> 命中：' + hit.name + ' rev=' + hit.rev)
    if (label === 'btc-dashboard') {
      const { readFileSync } = await import('node:fs')
      const local = readFileSync(file, 'utf8')
      console.log('   >>> 与本地逐字节一致：' + (hit.body === local))
    }
  } else {
    console.log('   >>> 全部 404')
  }
}
