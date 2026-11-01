/**
 * 回测框架**离线端到端**自检：从 CLI → 数据文件 → 引擎 → 指标 → 报告整条链跑通，不联网。
 *
 * 为什么单独要有这一层：各模块自己的单测都绿，不等于拼起来能跑 ——
 * 接口形状、默认手续费/杠杆、时间范围过滤、报告落盘，这些只有端到端才暴露。
 *
 * 覆盖：
 *   1. `--data` 离线跑 buy-hold，三件套（json/html/csv）生成、文件名规则
 *   2. 报告里的口径：默认 1 倍杠杆、maker 0.0200%、taker 0.0500%、标的/周期
 *   3. 选定的时间范围真的生效（换 start → 回测的 K 线根数变少）
 *   4. 手续费真的扣了（0 费率 vs 默认费率，权益不同）
 *   5. `--maker 0.02%` 百分比写法
 *   6. sma-cross 也能端到端跑通、参数透传
 *   7. `--offline` 在没有缓存时报错退出（而不是偷偷联网）
 *   8. `--help` / `--list`、非法参数退出码
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../backtest/run.mjs'

const TEMP = mkdtempSync(join(tmpdir(), 'bt-backtest-int-'))
let failures = 0

function check(name, condition, detail) {
  const ok = condition === true
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
  if (!ok) failures += 1
  return ok
}

/** 可复现的伪随机游走 K 线；带点振荡，保证双均线策略有事可做。 */
function makeBars(count, startT, barMs) {
  let seed = 20240101
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const round = (value) => Math.round(value * 100) / 100
  const bars = []
  let price = 42000
  for (let i = 0; i < count; i += 1) {
    const drift = Math.sin(i / 18) * 0.004 + 0.0003
    const open = price
    const close = open * (1 + drift + (rand() - 0.5) * 0.002)
    const high = Math.max(open, close) * (1 + rand() * 0.0015)
    const low = Math.min(open, close) * (1 - rand() * 0.0015)
    bars.push([startT + i * barMs, round(open), round(high), round(low), round(close), 100 + i])
    price = close
  }
  return bars
}

/** 调 CLI 的 main()，行级捕获输出（沙箱里 spawn 吸管道会 EPERM，所以直接进程内调）。 */
async function runCli(args) {
  const out = []
  const err = []
  let code
  try {
    code = await main(args, {
      out: (line) => out.push(String(line)),
      err: (line) => err.push(String(line)),
    })
  } catch (error) {
    code = -1
    err.push('main() 抛错：' + String((error && error.message) || error))
  }
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') }
}

function listReports(dir) {
  try {
    return readdirSync(dir).sort()
  } catch (error) {
    return []
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return null
  }
}

async function mainTest() {
  // ---- fixture 与目录
  const barMs = 3_600_000
  const count = 240
  const startT = Date.UTC(2024, 0, 1, 0, 0, 0)
  const endT = startT + count * barMs
  const bars = makeBars(count, startT, barMs)
  const fixture = join(TEMP, 'fixture-bars.json')
  writeFileSync(fixture, JSON.stringify({ bars: bars }), 'utf8')
  const outDirA = join(TEMP, 'out-a')
  const outDirB = join(TEMP, 'out-b')

  // ---- 1) buy-hold 端到端
  {
    const result = await runCli([
      '--strategy', 'buy-hold',
      '--data', fixture,
      '--start', String(startT),
      '--end', String(endT),
      '--out-dir', outDirA,
      '--quiet',
    ])
    check('buy-hold 端到端退出码 0', result.code === 0, 'code=' + String(result.code) + ' err=' + result.errText.slice(0, 200))
    const files = listReports(outDirA)
    check('报告三件套生成', files.length === 3, 'files=' + JSON.stringify(files))
    const nameOk = files.every((file) => /^BTC-USDT-SWAP-1h-buy-hold-\d{8}-\d{8}\.(json|html|csv)$/.test(file))
    check('报告文件名符合规则', nameOk, JSON.stringify(files))

    const jsonFile = files.find((file) => file.endsWith('.json'))
    const htmlFile = files.find((file) => file.endsWith('.html'))
    const csvFile = files.find((file) => file.endsWith('.csv'))
    check('json/html/csv 都存在', jsonFile !== undefined && htmlFile !== undefined && csvFile !== undefined)

    const report = jsonFile === undefined ? null : readJson(join(outDirA, jsonFile))
    if (report === null) {
      check('JSON 报告可解析', false)
    } else {
      check('标的正确', report.config.instId === 'BTC-USDT-SWAP', String(report.config.instId))
      check('周期正确', report.config.bar === '1h', String(report.config.bar))
      check('默认杠杆 = 1', report.config.leverage === 1, String(report.config.leverage))
      check('默认挂单费率 = 0.0002（0.0200%）', report.config.makerFeeRate === 0.0002, String(report.config.makerFeeRate))
      check('默认吃单费率 = 0.0005（0.0500%）', report.config.takerFeeRate === 0.0005, String(report.config.takerFeeRate))
      check('时间范围传到了报告', report.config.start === startT && report.config.end === endT)
      check('回测 K 线根数 = 240', report.result.range.bars === count, String(report.result.range && report.result.range.bars))
      check('资金曲线点数 = K 线根数', Array.isArray(report.result.equityCurve) && report.result.equityCurve.length === count)
      check('策略名正确', report.strategy.name === 'buy-hold', String(report.strategy.name))
      check('buy-hold 至少 1 笔闭合交易', Array.isArray(report.result.trades) && report.result.trades.length >= 1,
        'trades=' + String(report.result.trades && report.result.trades.length))
      check('确实扣了吃单手续费', report.result.fees.taker > 0, 'taker=' + String(report.result.fees.taker))
      check('指标里有总收益/最大回撤', Number.isFinite(report.metrics.totalReturnPct) && Number.isFinite(report.metrics.maxDrawdownPct),
        'totalReturnPct=' + String(report.metrics.totalReturnPct) + ' maxDrawdownPct=' + String(report.metrics.maxDrawdownPct))
      check('Buy&Hold 基准已计算', Number.isFinite(report.metrics.buyHoldReturnPct), String(report.metrics.buyHoldReturnPct))
    }

    const html = htmlFile === undefined ? '' : readFileSync(join(outDirA, htmlFile), 'utf8')
    check('HTML 自包含（无外部 http 链接）', html.length > 500 && !/https?:\/\//.test(html))
    check('HTML 含内联 SVG 资金曲线', html.includes('<svg'))
    check('HTML 标题含标的', html.includes('BTC-USDT-SWAP'))

    const csv = csvFile === undefined ? '' : readFileSync(join(outDirA, csvFile), 'utf8')
    check('CSV 表头符合约定', csv.startsWith('seq,side,qty,entry_t,entry_price,exit_t,exit_price,pnl,pnl_pct,fees,bars,exit_reason'),
      csv.split('\n')[0])
  }

  // ---- 2) 时间范围真的生效（后半段）
  {
    const lateStart = startT + 100 * barMs
    const outDir = join(TEMP, 'out-range')
    const result = await runCli([
      '--strategy', 'buy-hold', '--data', fixture,
      '--start', String(lateStart), '--end', String(endT), '--out-dir', outDir, '--quiet',
    ])
    const jsonFile = listReports(outDir).find((file) => file.endsWith('.json'))
    const report = jsonFile === undefined ? null : readJson(join(outDir, jsonFile))
    check('改时间范围后回测根数变少（140 根）', result.code === 0 && report !== null
      && report.result.range.bars === count - 100, String(report && report.result.range && report.result.range.bars))
    check('改时间范围后 firstT 对齐', report !== null && report.result.range.firstT === lateStart,
      String(report && report.result.range && report.result.range.firstT))
  }

  // ---- 3) 手续费真的影响权益；百分比写法
  {
    const freeDir = join(TEMP, 'out-free')
    const free = await runCli([
      '--strategy', 'buy-hold', '--data', fixture,
      '--start', String(startT), '--end', String(endT), '--out-dir', freeDir,
      '--maker', '0', '--taker', '0', '--quiet',
    ])
    const freeJson = listReports(freeDir).find((file) => file.endsWith('.json'))
    const freeReport = freeJson === undefined ? null : readJson(join(freeDir, freeJson))
    const paidJson = listReports(outDirA).find((file) => file.endsWith('.json'))
    const paidReport = paidJson === undefined ? null : readJson(join(outDirA, paidJson))
    check('0 费率报告可读', free.code === 0 && freeReport !== null)
    check('0 费率时最终权益更高（手续费真的扣了）',
      freeReport !== null && paidReport !== null && freeReport.result.finalEquity > paidReport.result.finalEquity,
      'free=' + String(freeReport && freeReport.result.finalEquity) + ' paid=' + String(paidReport && paidReport.result.finalEquity))

    const pctDir = join(TEMP, 'out-pct')
    const pct = await runCli([
      '--strategy', 'buy-hold', '--data', fixture,
      '--start', String(startT), '--end', String(endT), '--out-dir', pctDir,
      '--maker', '0.02%', '--taker', '0.05%', '--quiet',
    ])
    const pctJson = listReports(pctDir).find((file) => file.endsWith('.json'))
    const pctReport = pctJson === undefined ? null : readJson(join(pctDir, pctJson))
    check('百分比写法 --maker 0.02% / --taker 0.05% 解析正确', pct.code === 0 && pctReport !== null
      && pctReport.config.makerFeeRate === 0.0002 && pctReport.config.takerFeeRate === 0.0005,
    'code=' + String(pct.code) + ' maker=' + String(pctReport && pctReport.config.makerFeeRate))
  }

  // ---- 4) sma-cross 端到端 + 参数透传
  {
    const outDir = join(TEMP, 'out-sma')
    const result = await runCli([
      '--strategy', 'sma-cross', '--data', fixture,
      '--start', String(startT), '--end', String(endT), '--out-dir', outDir,
      '--param', 'fast=5', '--param', 'slow=20', '--quiet',
    ])
    const jsonFile = listReports(outDir).find((file) => file.endsWith('.json'))
    const report = jsonFile === undefined ? null : readJson(join(outDir, jsonFile))
    check('sma-cross 端到端退出码 0', result.code === 0, 'code=' + String(result.code) + ' err=' + result.errText.slice(0, 300))
    check('sma-cross 参数透传', report !== null && report.strategy.params.fast === 5 && report.strategy.params.slow === 20,
      JSON.stringify(report && report.strategy.params))
    check('sma-cross 有交易', report !== null && report.result.trades.length > 0,
      'trades=' + String(report && report.result.trades && report.result.trades.length))
  }

  // ---- 5) 报告产物能被再次读取（HTML 打开不依赖网络、JSON 严格合法）
  // ---- 6) offline 无缓存 → 报错退出，不偷偷联网
  {
    const emptyDataDir = join(TEMP, 'empty-data')
    const outDir = join(TEMP, 'out-offline')
    // 用真实日期：保证无论本机缓存如何，这个目录里必然没有数据
    const result = await runCli([
      '--strategy', 'buy-hold', '--offline', '--data-dir', emptyDataDir,
      '--start', 'now-2d', '--end', 'now', '--out-dir', outDir, '--quiet',
    ])
    check('--offline 无缓存退出码 1', result.code === 1, 'code=' + String(result.code))
    check('--offline 报错信息是中文且提到缓存/离线',
      /离线|缓存/.test(result.errText), result.errText.slice(0, 200))
  }

  // ---- 7) --data + 不指定范围（fixture 在 2024，默认范围最近 30 天）→ 过滤为空要报错
  {
    const outDir = join(TEMP, 'out-empty-range')
    const result = await runCli([
      '--strategy', 'buy-hold', '--data', fixture, '--out-dir', outDir, '--quiet',
    ])
    check('时间范围过滤后为空 → 退出码 1（不会拿范围外数据硬跑）', result.code === 1 && /K 线|时间范围/.test(result.errText),
      'code=' + String(result.code) + ' err=' + result.errText.slice(0, 200))
  }

  // ---- 8) --help / --list / 非法参数
  {
    const help = await runCli(['--help'])
    check('--help 退出码 0 且列出 --strategy', help.code === 0 && help.text.includes('--strategy'))
    const list = await runCli(['--list'])
    check('--list 列出内置策略', list.code === 0 && list.text.includes('buy-hold') && list.text.includes('sma-cross'))
    const bad = await runCli(['--strategy', 'buy-hold', '--bar', '2h', '--start', '2024-01-01', '--end', '2024-02-01'])
    check('非法周期退出码 1', bad.code === 1 && /周期/.test(bad.errText), bad.errText.slice(0, 160))
    const unknownStrategy = await runCli(['--strategy', 'no-such-strategy', '--start', '2024-01-01', '--end', '2024-02-01'])
    check('未知策略退出码 1', unknownStrategy.code === 1 && /策略/.test(unknownStrategy.errText), unknownStrategy.errText.slice(0, 160))
  }
}

try {
  await mainTest()
} finally {
  try {
    rmSync(TEMP, { recursive: true, force: true })
  } catch (error) {
    // 临时目录删不掉不影响测试结论
  }
  if (failures > 0) {
    console.log('── ' + String(failures) + ' 项失败')
    process.exitCode = 1
  } else {
    console.log('全部通过')
  }
}
