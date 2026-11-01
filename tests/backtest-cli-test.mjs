/**
 * 回测 CLI 的**离线端到端**自检（不联网、不 spawn 子进程）。
 *
 * 为什么用 `main(argv, io)` 注入 io 而不是起子进程：
 *   1. 沙箱里子进程用管道吸 stdio 会 EPERM（`spawn` 默认 pipe 的已知限制），测试会假失败；
 *   2. 进程内调用能同时拿到「退出码 + 每一行 stdout/stderr」，断言比解析子进程输出更直接。
 *
 * 为什么用临时目录造 fixture：测试不能依赖本机缓存、不能碰仓库里的 backtest/data 和
 * backtest/reports（并行开发时那可能是别人/上次运行的产物），跑完就删。
 *
 * 覆盖：`--data` 离线端到端、默认费率/杠杆/区间、`--data` 按 [start,end) 过滤、
 *       `--param` 透传（ctx.params）、`--json` 摘要、`--quiet` 结论行、`--list`、`--help`、
 *       各类非法参数退出码 1。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../backtest/run.mjs'

const BAR_MS = 3_600_000
const FIRST_T = Date.UTC(2024, 0, 1, 0, 0, 0) // 2024-01-01T00:00:00Z
const BAR_COUNT = 240
const END_T = FIRST_T + BAR_COUNT * BAR_MS
const TEMP = mkdtempSync(join(tmpdir(), 'btc-backtest-cli-'))

let passed = 0
let failed = 0

function check(name, condition, detail) {
  const ok = condition === true
  if (ok) passed += 1
  else failed += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
  return ok
}

/** 可复现的合成 K 线：两条正弦叠加，保证双均线策略能等到交叉、且默认参数下有事可做。 */
function makeBars() {
  const round2 = (value) => Math.round(value * 100) / 100
  const bars = []
  let previousClose = 50_000
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const wave = Math.sin(index / 7) * 0.02 + Math.sin(index / 19) * 0.015
    const close = 50_000 * (1 + wave)
    const open = index === 0 ? close : previousClose
    bars.push([
      FIRST_T + index * BAR_MS,
      round2(open),
      round2(Math.max(open, close) * 1.001),
      round2(Math.min(open, close) * 0.999),
      round2(close),
      100 + index,
    ])
    previousClose = close
  }
  return bars
}

/** 调 CLI 主入口并收集行级输出；main() 自己会吞异常返回 1，这里再兜一层防止测试进程直接挂掉。 */
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
    err.push('main() 抛出异常：' + String((error && error.message) || error))
  }
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') }
}

function listReports(dir) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function mainTest() {
  const fixture = join(TEMP, 'fixture-bars.json')
  writeFileSync(fixture, JSON.stringify({ bars: makeBars() }), 'utf8')
  const dataDir = join(TEMP, 'data-cache') // 与 --data 一起给，纯粹防止误写仓库默认缓存目录

  // ---- 1) --help / --list（不依赖任何数据模块）
  {
    const help = await runCli(['--help'])
    check('--help 退出码 0', help.code === 0, 'code=' + String(help.code))
    const options = ['--strategy', '--start', '--end', '--bar', '--capital', '--leverage', '--maker',
      '--taker', '--inst', '--param', '--data', '--data-dir', '--out-dir', '--offline', '--json',
      '--list', '--quiet', '--help']
    const missing = options.filter((option) => !help.stdout.includes(option))
    check('--help 列出全部参数', missing.length === 0, missing.length === 0 ? undefined : '缺少 ' + missing.join(' / '))
    check('--help 不写 stderr', help.stderr === '', JSON.stringify(help.stderr.slice(0, 120)))
  }
  {
    const list = await runCli(['--list'])
    check('--list 退出码 0', list.code === 0, 'code=' + String(list.code))
    check('--list 列出内置策略', list.stdout.includes('buy-hold') && list.stdout.includes('sma-cross'))
    check('--list 显示 sma-cross 默认参数', list.stdout.includes('fast=20') && list.stdout.includes('slow=60'),
      list.stdout.slice(0, 160).replace(/\n/g, ' | '))
  }

  // ---- 2) buy-hold 离线端到端：默认费率 / 杠杆 / 区间 / 报告三件套
  {
    const outDir = join(TEMP, 'out-buy-hold')
    const result = await runCli([
      '--strategy', 'buy-hold',
      '--data', fixture,
      '--start', String(FIRST_T),
      '--end', String(END_T),
      '--data-dir', dataDir,
      '--out-dir', outDir,
    ])
    check('buy-hold 端到端退出码 0', result.code === 0,
      'code=' + String(result.code) + ' stderr=' + JSON.stringify(result.stderr.slice(0, 200)))
    check('控制台摘要含标的/周期', result.stdout.includes('BTC-USDT-SWAP') && result.stdout.includes('1h'))
    check('控制台打印了报告路径', result.stdout.includes('报告'))
    check('输出全部走 io.out（未直接写 stdout）', result.out.length > 0 && result.stdout.length > 0)

    const files = listReports(outDir)
    const jsonFile = files.find((file) => file.endsWith('.json'))
    const htmlFile = files.find((file) => file.endsWith('.html'))
    const csvFile = files.find((file) => file.endsWith('.csv'))
    check('报告三件套生成', [jsonFile, htmlFile, csvFile].every((file) => typeof file === 'string'),
      JSON.stringify(files))

    const report = jsonFile === undefined ? null : readJson(join(outDir, jsonFile))
    if (report === null) {
      check('JSON 报告可解析', false)
    } else {
      check('默认 makerFeeRate = 0.0002（0.0200%）', report.config.makerFeeRate === 0.0002,
        String(report.config.makerFeeRate))
      check('默认 takerFeeRate = 0.0005（0.0500%）', report.config.takerFeeRate === 0.0005,
        String(report.config.takerFeeRate))
      check('默认 leverage = 1', report.config.leverage === 1, String(report.config.leverage))
      check('默认初始资金 = 10000', report.config.initialCapital === 10000, String(report.config.initialCapital))
      check('回测区间来自 --start/--end', report.config.start === FIRST_T && report.config.end === END_T,
        'start=' + String(report.config.start) + ' end=' + String(report.config.end))
      check('回测 K 线根数 = 240', report.result.range.bars === BAR_COUNT,
        String(report.result.range && report.result.range.bars))
      check('策略名 = buy-hold', report.strategy.name === 'buy-hold', String(report.strategy.name))
      check('buy-hold 至少 1 笔闭合交易', Array.isArray(report.result.trades) && report.result.trades.length >= 1,
        'trades=' + String(report.result.trades && report.result.trades.length))
      check('确实扣了吃单手续费', report.result.fees.taker > 0, 'taker=' + String(report.result.fees.taker))
      check('指标 totalReturnPct 是数字（不是 null/NaN）', Number.isFinite(report.metrics.totalReturnPct),
        String(report.metrics.totalReturnPct))
    }

    const html = htmlFile === undefined ? '' : readFileSync(join(outDir, htmlFile), 'utf8')
    check('HTML 报告非空且是 HTML', html.length > 500 && html.includes('<html'))
    const csv = csvFile === undefined ? '' : readFileSync(join(outDir, csvFile), 'utf8')
    check('CSV 报告非空且有表头', csv.split('\n')[0].startsWith('seq,side,qty'))
  }

  // ---- 3) --data 也必须按 [start, end) 过滤（否则「改了范围结果没变」是假回测）
  {
    const lateStart = FIRST_T + 100 * BAR_MS
    const outDir = join(TEMP, 'out-range')
    const result = await runCli([
      '--strategy', 'buy-hold',
      '--data', fixture,
      '--start', String(lateStart),
      '--end', String(END_T),
      '--data-dir', dataDir,
      '--out-dir', outDir,
      '--quiet',
    ])
    check('收窄区间后退出码 0', result.code === 0, 'code=' + String(result.code))
    const jsonFile = listReports(outDir).find((file) => file.endsWith('.json'))
    const report = jsonFile === undefined ? null : readJson(join(outDir, jsonFile))
    check('--quiet 至少有一行可识别结论', result.stdout.includes('完成'), JSON.stringify(result.stdout.slice(0, 200)))
    check('--data 已按 [start,end) 过滤（根数 140）', report !== null && report.result.range.bars === BAR_COUNT - 100,
      String(report && report.result.range && report.result.range.bars))
    check('过滤后 firstT 对齐新起点', report !== null && report.result.range.firstT === lateStart,
      String(report && report.result.range && report.result.range.firstT))
  }

  // ---- 4) sma-cross：--param 透传 + 百分比费率写法 + --json 摘要（--quiet 仍打印结论）
  {
    const outDir = join(TEMP, 'out-sma-cross')
    const result = await runCli([
      '--strategy', 'sma-cross',
      '--data', fixture,
      '--start', String(FIRST_T),
      '--end', String(END_T),
      '--param', 'fast=4',
      '--param', 'slow=12',
      '--param', 'allowShort=true',
      '--maker', '0.0200%',
      '--taker', '0.0500%',
      '--data-dir', dataDir,
      '--out-dir', outDir,
      '--quiet',
      '--json',
    ])
    check('sma-cross 端到端退出码 0', result.code === 0,
      'code=' + String(result.code) + ' stderr=' + JSON.stringify(result.stderr.slice(0, 300)))

    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '')
    const summary = lines.length === 0 ? null : readJsonText(lines[lines.length - 1])
    check('--json 的 JSON 摘要可解析（在输出末尾一行）', summary !== null,
      JSON.stringify(lines[lines.length - 1] || ''))
    if (summary !== null) {
      check('摘要里标的/周期/策略名正确',
        summary.instId === 'BTC-USDT-SWAP' && summary.bar === '1h' && summary.strategy.name === 'sma-cross',
        JSON.stringify({ instId: summary.instId, bar: summary.bar }))
      check('摘要里 --param 优先级生效',
        summary.strategy.name === 'sma-cross' && summary.strategy.params.fast === 4
        && summary.strategy.params.slow === 12 && summary.strategy.params.allowShort === true,
        JSON.stringify(summary.strategy.params))
      check('摘要含收益/回撤/交易数',
        Number.isFinite(summary.totalReturnPct) && Number.isFinite(summary.maxDrawdownPct)
        && Number.isFinite(summary.tradeCount))
      check('摘要里的三份报告路径都存在',
        typeof summary.reports === 'object' && summary.reports !== null
        && existsSync(summary.reports.json) && existsSync(summary.reports.html) && existsSync(summary.reports.csv))

      const report = summary.reports && typeof summary.reports.json === 'string'
        ? readJson(summary.reports.json)
        : null
      if (report === null) {
        check('sma-cross JSON 报告可解析', false)
      } else {
        check('报告里的策略参数来自 --param（ctx.params 透传）',
          report.strategy.params.fast === 4 && report.strategy.params.slow === 12
          && report.strategy.params.allowShort === true, JSON.stringify(report.strategy.params))
        check('百分比费率写法解析正确（0.0200% / 0.0500%）',
          report.config.makerFeeRate === 0.0002 && report.config.takerFeeRate === 0.0005,
          'maker=' + String(report.config.makerFeeRate) + ' taker=' + String(report.config.takerFeeRate))
        check('sma-cross 有闭合交易', Array.isArray(report.result.trades) && report.result.trades.length > 0,
          'trades=' + String(report.result.trades && report.result.trades.length))
      }
    }
  }

  // ---- 5) 非法参数：中文错误 + 退出码 1（全部在联网/读数据之前失败）
  {
    const invalidCases = [
      { name: '未知选项', args: ['--no-such-option'], needle: '未知选项' },
      {
        name: '非法 K 线周期',
        args: ['--bar', '2h', '--data', fixture, '--start', String(FIRST_T), '--end', String(END_T)],
        needle: '周期',
      },
      {
        name: '非法费率',
        args: ['--maker', 'abc', '--data', fixture, '--start', String(FIRST_T), '--end', String(END_T)],
        needle: '费率',
      },
      { name: '--param 缺少等号', args: ['--param', 'fast'], needle: 'key=value' },
      { name: '选项缺少值', args: ['--strategy'], needle: '缺少值' },
      {
        name: '未知策略',
        args: ['--strategy', 'no-such-strategy', '--data', fixture,
          '--start', String(FIRST_T), '--end', String(END_T)],
        needle: '策略',
      },
      {
        name: '--data 过滤后为空',
        args: ['--strategy', 'buy-hold', '--data', fixture, '--out-dir', join(TEMP, 'out-empty')],
        needle: '时间范围内没有 K 线',
      },
    ]
    for (const item of invalidCases) {
      const result = await runCli(item.args)
      check(item.name + ' → 退出码 1', result.code === 1, 'code=' + String(result.code))
      check(item.name + ' → stderr 是能看懂的中文错误', result.stderr.includes('错误：') && result.stderr.includes(item.needle),
        JSON.stringify(result.stderr.slice(0, 180)))
    }
  }
}

/** 解析一行 JSON 文本；失败返回 null（测试里不抛）。 */
function readJsonText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

try {
  await mainTest()
} finally {
  try {
    rmSync(TEMP, { recursive: true, force: true })
  } catch {
    // 临时目录删不掉不影响测试结论
  }
  if (failed > 0) {
    console.log('\n' + String(failed) + ' 项失败（' + String(passed) + ' 项通过）')
    process.exitCode = 1
  } else {
    console.log('\n全部通过（' + String(passed) + ' 项断言）')
  }
}
