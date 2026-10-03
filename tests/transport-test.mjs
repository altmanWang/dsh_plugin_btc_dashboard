// 三条通道的可靠性/延迟对比：谁最适合做看板的数据通道？
import { rawGet } from '../plugin/dsh-btc-dashboard/index.js'

const PROXY = { host: '127.0.0.1', port: 7897, raw: 'http://127.0.0.1:7897' }
const PATHS = [
  '/api/v5/market/ticker?instId=BTC-USDT-SWAP',
  '/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=15m&limit=300',
  '/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=15m&after=1780000000000&limit=100',
  '/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=4H&after=1780000000000&limit=100',
]

async function viaRawTunnel(rounds) {
  let ok = 0
  let fail = 0
  const times = []
  for (let i = 0; i < rounds; i += 1) {
    const path = PATHS[i % PATHS.length]
    const t0 = Date.now()
    try {
      const res = await rawGet('proxy', 'https://www.okx.com' + path, {}, 12000, PROXY)
      const body = JSON.parse(res.body.toString('utf8'))
      const n = Array.isArray(body.data) ? body.data.length : -1
      times.push(Date.now() - t0)
      if (res.status === 200 && body.code === '0') ok += 1
      else { fail += 1; console.log('    rawTunnel 非 200/非 code0:', res.status, String(body.code), path.slice(0, 60)) }
      if (n === 0) console.log('    rawTunnel 空数据:', path.slice(0, 70))
    } catch (e) {
      fail += 1
      times.push(Date.now() - t0)
      console.log('    rawTunnel FAIL:', String(e.message), path.slice(0, 60))
    }
  }
  return { ok, fail, times }
}

async function viaNodeEnvProxy(rounds) {
  // 用子进程，模拟 undici ProxyAgent（Node 24 的 --use-env-proxy）通道
  const { spawnSync } = await import('node:child_process')
  const script = `
    const paths = ${JSON.stringify(PATHS)};
    const out = [];
    for (let i = 0; i < ${rounds}; i += 1) {
      const p = paths[i % paths.length];
      const t0 = Date.now();
      try {
        const r = await fetch('https://www.okx.com' + p, { signal: AbortSignal.timeout(12000) });
        const j = await r.json();
        out.push({ ok: r.status === 200 && j.code === '0', n: Array.isArray(j.data) ? j.data.length : -1, ms: Date.now() - t0, path: p.slice(0, 40) });
      } catch (e) { out.push({ ok: false, error: String(e && e.message || e), ms: Date.now() - t0, path: p.slice(0, 40) }); }
    }
    console.log(JSON.stringify(out));
  `
  const res = spawnSync(process.execPath, ['--use-env-proxy', '-e', script], {
    env: Object.assign({}, process.env, { HTTPS_PROXY: PROXY.raw, HTTP_PROXY: PROXY.raw }),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (res.status !== 0) {
    console.log('    envProxy 子进程失败:', res.status, String(res.stderr).slice(0, 300))
    return { ok: 0, fail: rounds, times: [] }
  }
  let rows = []
  try { rows = JSON.parse(res.stdout.trim().split('\n').pop()) } catch (e) { console.log('    解析失败', String(res.stdout).slice(0, 200)) }
  let ok = 0
  let fail = 0
  const times = []
  for (const r of rows) {
    times.push(r.ms)
    if (r.ok) ok += 1
    else { fail += 1; console.log('    envProxy FAIL:', r.error || ('n=' + r.n), r.path) }
    if (r.ok && r.n === 0) console.log('    envProxy 空数据:', r.path)
  }
  return { ok, fail, times }
}

function summarize(name, r) {
  const t = r.times
  const avg = t.length === 0 ? 0 : Math.round(t.reduce((a, b) => a + b, 0) / t.length)
  const max = t.length === 0 ? 0 : Math.max.apply(null, t)
  console.log(name.padEnd(16) + ' ok=' + r.ok + ' fail=' + r.fail + ' avg=' + avg + 'ms max=' + max + 'ms')
}

const ROUNDS = 12
console.log('=== rawTunnel（我手写的 CONNECT + TLS，每次新建连接）')
summarize('rawTunnel', await viaRawTunnel(ROUNDS))
console.log('=== envProxy（Node24 --use-env-proxy，undici ProxyAgent + 连接池）')
summarize('envProxy', await viaNodeEnvProxy(ROUNDS))
