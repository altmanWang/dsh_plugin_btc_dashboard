// Throwaway network probe: which transport can actually reach OKX from this machine?
import { promises as dns } from 'node:dns'

async function hit(label, url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const t = await r.text()
    console.log(label, '=> OK', r.status, t.replace(/\s+/g, ' ').slice(0, 150))
  } catch (e) {
    console.log(label, '=> FAIL', String((e && e.message) || e))
  }
}

console.log('node', process.version, 'proxy-env:', process.env.HTTPS_PROXY || process.env.https_proxy || '(none)')
try {
  console.log('dns www.okx.com ->', (await dns.resolve4('www.okx.com')).join(','))
} catch (e) {
  console.log('dns www.okx.com -> FAIL', String(e.message))
}
try {
  console.log('dns aws.okx.com ->', (await dns.resolve4('aws.okx.com')).join(','))
} catch (e) {
  console.log('dns aws.okx.com -> FAIL', String(e.message))
}
await hit('egress  github', 'https://api.github.com/zen')
await hit('okx     ticker', 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP')
await hit('okx     aws   ', 'https://aws.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP')
await hit('dns     doh   ', 'https://1.1.1.1/dns-query?name=www.okx.com&type=A')
