/**
 * 回测框架**真实 OKX 数据**冒烟测试（联网，不是默认自检的一部分）。
 *
 * 为什么单独一个文件：其余测试都刻意离线（可复现、CI 友好），但「代理隧道 + 真实翻页 +
 * 真实时间戳对齐 + 缓存落盘」这几样只有打真接口才能证明。所以这个测试：
 *   - 连不上 OKX 就打印「跳过」并返回 0（本机 DNS 把 www.okx.com 解析到黑洞地址，
 *     全靠本地代理；代理没开时不该把仓库自检判红）；
 *   - 走真实链路：loadBars（抓近 10 天 1H）→ 缓存复用不联网 → 引擎 buy-hold →
 *     指标 → CLI（--offline，sma-cross）→ 报告三件套；
 *   - 跑完 closeTransport()，否则 keep-alive 隧道会把进程挂住（真踩过）。
 *
 * 运行：node tests/backtest-live-test.mjs
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatConsole, } from '../backtest/lib/report.mjs'
import { normalizeConfig } from '../backtest/lib/config.mjs'
import { loadBars } from '../backtest/lib/data.mjs'
import { createOkxFetcher } from '../backtest/lib/transport.mjs'
import { loadStrategy, withResolvedParams } from '../backtest/lib/strategy.mjs'
import { runBacktest } from '../backtest/lib/engine.mjs'
import { computeMetrics } from '../backtest/lib/metrics.mjs'
import { main } from '../backtest/run.mjs'

const TEMP = mkdtempSync(join(tmpdir(), 'bt-backtest-live-'))
const DATA_DIR = join(TEMP, 'data')
const OUT_DIR = join(TEMP, 'reports')
const CLI_OUT = join(TEMP, 'cli-reports')
const BAR_MS = 3_600_000

let failures = 0
let skipped = false
let fetcher = null

function check(name, condition, detail) {
  const ok = condition === true
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === undefined || detail === '' ? '' : '  ' + detail))
  if (!ok) failures += 1
  return ok
}

/** 调 CLI 的 main()，行级捕获输出。 */
async function runCli(args) {
  const out = []
  const err = []
  const code = await main(args, { out: (line) => out.push(String(line)), err: (line) => err.push(String(line)) })
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') }
}

async function liveTest() {
  // ---- 0) 网络可用性：连不上就跳过（不是失败）
  fetcher = createOkxFetcher({ delayMs: 130 })
  const probe = await fetcher.fetchPage({ instId: 'BTC-USDT-SWAP', okxBar: '1H', after: Date.now(), limit: 5 })
  if (probe.ok !== true) {
    skipped = true
    console.log('跳过（SKIP）：当前连不上 OKX —— ' + String(probe.error))
    console.log('  本机需要本地代理（默认 127.0.0.1:7897）才能访问 OKX；代理没开时跳过是预期行为。')
    return
  }
  console.log('ok   网络可用（代理/直连），探到 ' + String(probe.rows.length) + ' 根 1H K 线')

  // ---- 1) 真数据抓取：近 10 天 1H
  const config = normalizeConfig({ bar: '1h', start: 'now-10d', end: 'now', dataDir: DATA_DIR, outDir: OUT_DIR })
  const loaded = await loadBars({
    instId: config.instId,
    bar: config.bar,
    start: config.start,
    end: config.end,
    dataDir: DATA_DIR,
    fetcher,
    now: config.now,
    log: (message) => console.log('     · ' + message),
  })
  if (!check('真实数据 loadBars 成功', loaded.ok === true, String(loaded.error || ''))) return

  check('K 线数量足够（≥100 根）', loaded.bars.length >= 100, 'bars=' + String(loaded.bars.length))
  check('K 线升序且无重复', loaded.bars.every((bar, i) => i === 0 || bar.t > loaded.bars[i - 1].t))
  check('严格落在请求的时间范围内', loaded.bars.every((bar) => bar.t >= config.start && bar.t < config.end))
  check('只含已收盘 K 线', loaded.bars.every((bar) => bar.t + BAR_MS <= config.now))
  check('OHLC 自洽（h≥max(o,c)、l≤min(o,c)）',
    loaded.bars.every((bar) => bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c)))
  check('真实数据 1H 间隔为 3600000ms',
    loaded.bars.every((bar, i) => i === 0 || bar.t - loaded.bars[i - 1].t === BAR_MS))

  // ---- 2) 模块级全链路：buy-hold
  const strategy = withResolvedParams(await loadStrategy('buy-hold'), {})
  const result = runBacktest({ bars: loaded.bars, strategy, config })
  const metrics = computeMetrics(result)
  check('引擎跑通 buy-hold', result.ok === true && result.range.bars === loaded.bars.length,
    'bars=' + String(result.range && result.range.bars))
  check('资金曲线长度 = K 线根数', result.equityCurve.length === loaded.bars.length)
  check('期末权益是有限数', Number.isFinite(result.finalEquity), 'finalEquity=' + String(result.finalEquity))
  check('确实产生了手续费（默认吃单 0.0500%）', result.fees.total > 0, JSON.stringify(result.fees))
  check('指标可算（总收益/最大回撤）',
    Number.isFinite(metrics.totalReturnPct) && Number.isFinite(metrics.maxDrawdownPct),
    'return=' + String(metrics.totalReturnPct) + '% dd=' + String(metrics.maxDrawdownPct) + '%')
  check('指标里没有 NaN/Infinity',
    Object.keys(metrics).every((key) => typeof metrics[key] !== 'number' || Number.isFinite(metrics[key])))

  // ---- 3) 缓存复用：同一区间第二次读缓存，一根网络请求都不许发
  {
    let networkCalls = 0
    const countingFetcher = {
      fetchPage: async () => {
        networkCalls += 1
        return { ok: false, error: '缓存命中时不应该联网' }
      },
      close: () => {},
    }
    const firstT = loaded.bars[0].t
    const lastEnd = loaded.bars[loaded.bars.length - 1].t + BAR_MS
    const cached = await loadBars({
      instId: config.instId, bar: config.bar, start: firstT, end: lastEnd,
      dataDir: DATA_DIR, fetcher: countingFetcher, now: config.now,
    })
    check('第二次读缓存不联网', networkCalls === 0 && cached.ok === true,
      'networkCalls=' + String(networkCalls) + ' ok=' + String(cached.ok) + ' ' + String(cached.error || ''))
    check('缓存返回的 K 线根数一致', cached.bars.length === loaded.bars.length,
      'cached=' + String(cached.bars.length) + ' loaded=' + String(loaded.bars.length))
  }

  // ---- 4) CLI 端到端（--offline 走真实缓存，不联网）
  {
    const cli = await runCli([
      '--strategy', 'sma-cross',
      '--bar', '1h',
      '--start', String(loaded.bars[0].t),
      '--end', String(loaded.bars[loaded.bars.length - 1].t + BAR_MS),
      '--data-dir', DATA_DIR,
      '--out-dir', CLI_OUT,
      '--param', 'fast=10', '--param', 'slow=30',
      '--offline', '--quiet',
    ])
    check('CLI 基于真实缓存离线回测退出码 0', cli.code === 0,
      'code=' + String(cli.code) + ' ' + cli.errText.slice(0, 300))
    const files = existsSync(CLI_OUT) ? readdirSync(CLI_OUT).sort() : []
    check('报告三件套生成', files.length === 3, JSON.stringify(files))
    const jsonFile = files.find((file) => file.endsWith('.json'))
    if (jsonFile !== undefined) {
      const report = JSON.parse(readFileSync(join(CLI_OUT, jsonFile), 'utf8'))
      check('报告默认口径：1 倍杠杆 + 0.0200%/0.0500%',
        report.config.leverage === 1 && report.config.makerFeeRate === 0.0002 && report.config.takerFeeRate === 0.0005,
        'lev=' + String(report.config.leverage) + ' maker=' + String(report.config.makerFeeRate) + ' taker=' + String(report.config.takerFeeRate))
      check('报告 K 线根数与数据层一致', report.result.range.bars === loaded.bars.length,
        'report=' + String(report.result.range.bars) + ' data=' + String(loaded.bars.length))
    }
    const htmlFile = files.find((file) => file.endsWith('.html'))
    if (htmlFile !== undefined) {
      const html = readFileSync(join(CLI_OUT, htmlFile), 'utf8')
      check('HTML 报告自包含且含内联 SVG', html.includes('<svg') && !/https?:\/\//.test(html))
    }
  }

  // ---- 5) 人眼可读的摘要（这个测试本来就要人看）
  console.log('\n──── 真实数据 buy-hold 摘要（近 10 天 1H）────')
  console.log(formatConsole(result, metrics, config))
}

try {
  await liveTest()
} finally {
  if (fetcher !== null) {
    try {
      fetcher.close()
    } catch (error) {
      // 关不掉不影响测试结论
    }
  }
  try {
    rmSync(TEMP, { recursive: true, force: true })
  } catch (error) {
    // 临时目录清理失败不影响结论
  }
  if (skipped === true) {
    console.log('\n跳过（SKIP）：本机当前连不上 OKX，真实数据冒烟未执行（不算失败）')
  } else if (failures > 0) {
    console.log('── ' + String(failures) + ' 项失败')
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
}
