/**
 * 回测框架的 CLI 入口。
 *
 * 设计要点（改之前先看一眼，这几条都是刻意的）：
 *   1. `main(argv, io)` 返回退出码、不调 `process.exit()`、不直接写 stdout/stderr。
 *      测试要靠注入 `io` 抓输出；`process.exit()` 则会把还没写完的报告/日志直接截断。
 *      只有「直接运行本文件」的顶层入口才把返回值写进 `process.exitCode`。
 *   2. 解析参数只做「收集原始值」，默认值/时间解析/校验一律交给 `config.mjs` 的
 *      `normalizeConfig()`。两边各写一套默认值，迟早会有一个悄悄过期。
 *   3. 联网 fetcher 由 CLI 创建、在 `finally` 里 `close()`。插件底层是 keep-alive 的
 *      代理隧道，不关的话 Node 进程会一直挂着 —— 表现为「回测跑完了但不退出」。
 *   4. `--data` 读进来的 K 线**也要按 config 的 [start, end) 过滤**。不滤的话用户改了
 *      `--start/--end` 结果却不变 —— 那是最难查的一种假回测。
 *   5. 所有给用户看的错误都是中文短句（不打印 stack）：CLI 用户要的是「哪里错了」，
 *      不是调用栈；调试时改代码比读栈快。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_BAR,
  DEFAULT_CAPITAL,
  DEFAULT_FUNDING_RATE,
  DEFAULT_INSTID,
  DEFAULT_LEVERAGE,
  DEFAULT_MAKER_FEE_RATE,
  DEFAULT_TAKER_FEE_RATE,
  FUNDING_INTERVAL_MS,
  TIMEFRAMES,
  formatDateTimeUtc8,
  formatFeeRate,
  normalizeConfig,
} from './lib/config.mjs'
import { listStrategies, loadStrategy, withResolvedParams } from './lib/strategy.mjs'
import { buildFundingEvents, loadBars, loadFundingRates, readBarFile } from './lib/data.mjs'
import { createOkxFetcher } from './lib/transport.mjs'
import { runBacktest } from './lib/engine.mjs'
import { computeMetrics } from './lib/metrics.mjs'
import { formatConsole, writeReports } from './lib/report.mjs'

// `node backtest/run.mjs --help | head` 这类用法里，下游会先关掉管道：Node 默认把
// stdout 的 EPIPE 当作未捕获错误，甩一屏栈并以非 0 退出 —— 对 CLI 来说这是正常用法，安静退出即可。
// 只吞 EPIPE，其它流错误照常抛（那才是真的坏掉了）。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error !== null && error !== undefined && error.code === 'EPIPE') return
    throw error
  })
}

const DEFAULT_STRATEGY = 'buy-hold'

/** 取值选项 → 内部字段名。不加速写别名：帮助里写什么就只收什么，拼错要报错而不是静默忽略。 */
const VALUE_OPTIONS = Object.freeze({
  '--strategy': 'strategy',
  '--start': 'start',
  '--end': 'end',
  '--bar': 'bar',
  '--capital': 'capital',
  '--leverage': 'leverage',
  '--maker': 'maker',
  '--taker': 'taker',
  '--inst': 'inst',
  '--param': 'param',
  '--data': 'data',
  '--data-dir': 'dataDir',
  '--out-dir': 'outDir',
  '--funding-rate': 'fundingRate',
})

/** 开关选项（不带值）。`--help` 给 `-h` 别名，其余不加快捷键，避免和策略参数撞名。 */
const FLAG_OPTIONS = Object.freeze({
  '--offline': 'offline',
  '--json': 'json',
  '--list': 'list',
  '--quiet': 'quiet',
  '--no-funding': 'noFunding',
  '--help': 'help',
  '-h': 'help',
})

const HELP_TEXT = [
  'BTCUSDT 永续合约回测（OKX ' + DEFAULT_INSTID + '）',
  '',
  '用法：node backtest/run.mjs [选项]',
  '',
  '策略：',
  '  --strategy <名字|文件>  默认 ' + DEFAULT_STRATEGY + '；内置策略见 --list，也可直接给 .mjs 路径',
  '',
  '时间范围（左闭右开 [start, end)，裸日期按北京时间 UTC+8）：',
  '  --start <时间>          开始时间，默认 now-30d',
  '                          支持 2024-01-01、2024-01-01 08:00、ISO、毫秒时间戳、now-30d',
  '  --end <时间>            结束时间，默认 now（超过 now 会夹到 now 并警告）',
  '  --bar <周期>            K 线周期，默认 ' + DEFAULT_BAR
    + '（可选：' + TIMEFRAMES.map((item) => item.id).join(' / ') + '）',
  '',
  '标的与资金：',
  '  --inst <instId>         标的，默认 ' + DEFAULT_INSTID,
  '  --capital <USDT>        初始资金，默认 ' + String(DEFAULT_CAPITAL),
  '  --leverage <倍数>       杠杆，默认 ' + String(DEFAULT_LEVERAGE) + '（1–100）',
  '',
  '费用：',
  '  --maker <费率>          挂单费率，默认 ' + String(DEFAULT_MAKER_FEE_RATE)
    + '（= ' + formatFeeRate(DEFAULT_MAKER_FEE_RATE) + '）；也接受 0.02% 这种写法',
  '  --taker <费率>          吃单费率，默认 ' + String(DEFAULT_TAKER_FEE_RATE)
    + '（= ' + formatFeeRate(DEFAULT_TAKER_FEE_RATE) + '）；也接受 0.05% 这种写法',
  '',
  '策略参数：',
  '  --param key=value       传给策略的参数，可重复（例：--param fast=10 --param allowShort=true）',
  '',
  '资金费率（funding）：',
  '  默认计入：每 8 小时结算一次，多头付/空头收（历史费用来自 OKX，只保留最近约 3 个月）。',
  '  --funding-rate <费率>   历史缺失区间的估算费率，默认 ' + formatFeeRate(DEFAULT_FUNDING_RATE) + ' / 8h',
  '                          也接受 0.01% 这种写法；长区间回测建议显式给一个值',
  '  --no-funding            完全不计资金费率（与加这个功能之前的结果一致）',
  '  ⚠️ --data 本地文件模式下默认不计资金费率（离线复现要可重复，不混入联网数据）',
  '',
  '数据来源：',
  '  --data <file.json>      用本地 K 线文件替代联网（离线复现/测试），仍按 --start/--end 过滤',
  '  --data-dir <目录>       K 线缓存目录，默认仓库内 backtest/data',
  '  --offline               只读本地缓存，一个网络请求都不发',
  '',
  '输出：',
  '  --out-dir <目录>        报告输出目录，默认仓库内 backtest/reports',
  '  --json                  在输出末尾额外打印一行 JSON 摘要（收益/回撤/交易数/报告路径）',
  '  --quiet                 只打印结论与报告路径，省略进度和完整摘要',
  '  --list                  列出内置策略（含默认参数）',
  '  --help, -h              显示本帮助',
  '',
  '例子：',
  '  node backtest/run.mjs --strategy sma-cross --param fast=20 --param slow=60 --start now-30d',
  '  node backtest/run.mjs --data bars.json --start 2024-01-01 --end 2024-02-01 --out-dir reports',
].join('\n')

/** 把一条文本按行喂给 emit；统一处理 CRLF 与结尾多余空行（报告字符串可能带尾换行）。 */
function writeBlock(emit, text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (normalized === '') return
  for (const line of normalized.split('\n')) emit(line)
}

/**
 * 生成行输出函数：注入了 io.out/io.err 就用注入口，否则写 process.stdout/stderr。
 * 注入口约定「一行一次调用」，所以这里不拼整段文本。
 */
function createEmitter(io, key, stream) {
  const injected = io !== null && typeof io === 'object' && typeof io[key] === 'function' ? io[key] : null
  if (injected !== null) return (line) => injected(String(line))
  return (line) => stream.write(String(line) + '\n')
}

function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function formatAmount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const sign = number < 0 ? '-' : ''
  const [integer, decimal] = Math.abs(number).toFixed(2).split('.')
  return sign + integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + decimal
}

function formatPct(value, signed = false) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const sign = signed && number > 0 ? '+' : ''
  return sign + number.toFixed(2) + '%'
}

function formatCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : '—'
}

/**
 * 解析命令行。只收集原始字符串，非法/缺值/未知选项当场抛中文 Error。
 * 支持 `--opt value` 与 `--opt=value` 两种写法（后者更适合脚本里避免空格问题）。
 */
function parseArgs(argv) {
  const values = {}
  const flags = {}
  const paramOverrides = {}
  const args = Array.isArray(argv) ? argv.map((item) => String(item)) : []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('-') || token === '-') {
      throw new Error('不支持位置参数：' + JSON.stringify(token) + '（选项见 --help）')
    }
    const equalAt = token.indexOf('=')
    const name = equalAt >= 0 ? token.slice(0, equalAt) : token
    const inlineValue = equalAt >= 0 ? token.slice(equalAt + 1) : undefined

    if (Object.prototype.hasOwnProperty.call(FLAG_OPTIONS, name)) {
      if (inlineValue !== undefined) throw new Error('选项 ' + name + ' 是开关，不接受值')
      flags[FLAG_OPTIONS[name]] = true
      continue
    }

    if (Object.prototype.hasOwnProperty.call(VALUE_OPTIONS, name)) {
      let raw = inlineValue
      if (raw !== undefined) {
        if (raw === '') throw new Error('选项 ' + name + ' 缺少值（用 --help 查看用法）')
      } else {
        const next = args[index + 1]
        // 允许负数值（如 --leverage -1 要走到配置校验，给出明确的中文报错），
        // 但 "--xxx" 视为「忘了给值、直接进了下一个选项」。
        if (next === undefined || next.startsWith('--') || next === '-h') {
          throw new Error('选项 ' + name + ' 缺少值（用 --help 查看用法）')
        }
        index += 1
        raw = next
      }
      const field = VALUE_OPTIONS[name]
      if (field === 'param') {
        const splitAt = raw.indexOf('=')
        if (splitAt <= 0) {
          throw new Error('--param 需要 key=value 形式，收到：' + JSON.stringify(raw)
            + '（例：--param fast=10）')
        }
        const key = raw.slice(0, splitAt).trim()
        if (key === '') throw new Error('--param 的参数名不能为空：' + JSON.stringify(raw))
        // 重复给同一个 key 以最后一次为准：后面的覆盖前面的，符合命令行直觉。
        paramOverrides[key] = raw.slice(splitAt + 1).trim()
      } else {
        values[field] = raw
      }
      continue
    }

    throw new Error('未知选项：' + name + '（用 --help 查看支持的选项）')
  }

  return { values, flags, paramOverrides }
}

/** `--list`：列出内置策略并尽量显示默认参数（某个策略加载失败只影响它自己那一行）。 */
async function listBuiltinStrategies(out) {
  const items = listStrategies()
  if (items.length === 0) {
    out('backtest/strategies/ 下没有 .mjs 策略文件')
    return
  }
  out('内置策略（backtest/strategies/）：')
  for (const item of items) {
    let detail
    try {
      const strategy = await loadStrategy(item.name)
      const keys = Object.keys(strategy.params)
      detail = keys.length === 0
        ? '（无参数）'
        : keys.map((key) => key + '=' + JSON.stringify(strategy.params[key])).join('  ')
    } catch (error) {
      detail = '（加载失败：' + errorMessage(error) + '）'
    }
    out('  ' + item.name.padEnd(16) + detail)
  }
  out('')
  out('提示：--param key=value 覆盖参数（可重复）；--strategy 也可直接给 .mjs 文件路径。')
}

function describeParams(params) {
  const entries = Object.entries(params ?? {})
  if (entries.length === 0) return '（无参数）'
  return entries.map(([key, value]) => key + '=' + JSON.stringify(value)).join('  ')
}

/** 把 loadBars 的结果翻成一行人话；--quiet 时不打印。 */
function describeBars(loaded) {
  const source = loaded.fromCache === true
    ? '本次未联网（缓存命中）'
    : '联网抓取 ' + formatCount(loaded.fetchedPages) + ' 页'
  const coverage = loaded.coverage === null || loaded.coverage === undefined
    ? '缓存覆盖未知'
    : '缓存覆盖 ' + formatDateTimeUtc8(loaded.coverage.from) + ' → ' + formatDateTimeUtc8(loaded.coverage.to)
  return source + '，' + formatCount(loaded.bars.length) + ' 根 K 线（' + coverage + '）'
}

/** 从 --data 文件读 K 线，并按 config 的时间范围过滤（口径与 loadBars 的返回一致）。 */
function readBarsFromFile(file, config) {
  const all = readBarFile(resolve(file))
  if (!Array.isArray(all) || all.length === 0) {
    throw new Error('--data 文件里没有 K 线：' + file)
  }
  const bars = all.filter((bar) => bar.t >= config.start && bar.t < config.end)
  if (bars.length === 0) {
    throw new Error('时间范围内没有 K 线：--data 文件共 ' + formatCount(all.length) + ' 根，但没有一根落在 '
      + formatDateTimeUtc8(config.start) + ' → ' + formatDateTimeUtc8(config.end)
      + '（用 --start/--end 指定覆盖文件的范围）')
  }
  if (bars.length < 2) {
    throw new Error('时间范围内只有 ' + formatCount(bars.length) + ' 根 K 线，无法回测'
      + '（--data 文件是否覆盖了 --start/--end？）')
  }
  return { bars, total: all.length }
}

/** `--json` 的摘要：只放脚本/人一眼要的结论，全量数据在 JSON 报告文件里。 */
function buildSummary({ config, strategy, result, metrics, paths }) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    instId: config.instId,
    bar: config.bar,
    config: {
      instId: config.instId,
      bar: config.bar,
      start: config.start,
      end: config.end,
      initialCapital: config.initialCapital,
      leverage: config.leverage,
      makerFeeRate: config.makerFeeRate,
      takerFeeRate: config.takerFeeRate,
    },
    strategy: { name: strategy.name, params: strategy.params },
    initialEquity: metrics.initialEquity,
    finalEquity: metrics.finalEquity,
    totalReturnPct: metrics.totalReturnPct,
    annualizedReturnPct: metrics.annualizedReturnPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    sharpe: metrics.sharpe,
    sortino: metrics.sortino,
    tradeCount: metrics.tradeCount,
    winRatePct: metrics.winRatePct,
    fees: result.fees,
    funding: {
      total: result.funding !== undefined ? result.funding.total : 0,
      count: result.funding !== undefined ? result.funding.count : 0,
      paid: result.funding !== undefined ? result.funding.paid : 0,
      received: result.funding !== undefined ? result.funding.received : 0,
      estimatedCount: metrics.fundingEstimatedCount,
    },
    liquidations: Array.isArray(result.liquidations) ? result.liquidations.length : 0,
    rejectedOrders: Array.isArray(result.rejected) ? result.rejected.length : 0,
    reports: {
      json: paths.jsonPath,
      html: paths.htmlPath,
      csv: paths.csvPath,
    },
  }
}

/**
 * CLI 主入口。
 * @param {string[]} argv 不含 `node` 与脚本路径的参数列表
 * @param {{ out?: (line: string) => void, err?: (line: string) => void }} [io] 测试注入口
 * @returns {Promise<number>} 退出码：0 成功 / 1 失败
 */
export async function main(argv, io) {
  const out = createEmitter(io, 'out', process.stdout)
  const err = createEmitter(io, 'err', process.stderr)
  let fetcher = null

  try {
    const args = Array.isArray(argv) ? argv.map((item) => String(item)) : []

    // --help 优先于一切：就算后面的参数写错了，用户想看用法也应该看得到。
    if (args.includes('--help') || args.includes('-h')) {
      writeBlock(out, HELP_TEXT)
      return 0
    }

    const parsed = parseArgs(args)
    const quiet = parsed.flags.quiet === true

    if (parsed.flags.list === true) {
      await listBuiltinStrategies(out)
      return 0
    }

    // 1) 配置：默认值、时间范围、费率写法、目录解析都在 normalizeConfig 里。
    //    --data 是「离线复现」模式：默认不计资金费率（否则同一份数据文件的结果会随联网状态变化）。
    const useDataFile = parsed.values.data !== undefined
    if (useDataFile && parsed.values.fundingRate !== undefined) {
      err('警告：--data 本地文件模式不联网抓资金费率，本次回测不计资金费率')
    }
    const config = normalizeConfig({
      instId: parsed.values.inst,
      bar: parsed.values.bar,
      start: parsed.values.start,
      end: parsed.values.end,
      initialCapital: parsed.values.capital,
      leverage: parsed.values.leverage,
      makerFeeRate: parsed.values.maker,
      takerFeeRate: parsed.values.taker,
      dataDir: parsed.values.dataDir,
      outDir: parsed.values.outDir,
      includeFunding: useDataFile ? false : parsed.flags.noFunding !== true,
      fundingRate: parsed.values.fundingRate,
      now: Date.now(),
    })
    for (const warning of config.warnings) err('警告：' + warning)

    // 2) 策略：先于取数加载，策略名拼错时不用白等一轮网络请求。
    const baseStrategy = await loadStrategy(parsed.values.strategy ?? DEFAULT_STRATEGY)
    const strategy = withResolvedParams(baseStrategy, parsed.paramOverrides)
    if (!quiet) {
      err('策略：' + strategy.name + ' ' + describeParams(strategy.params))
      err('区间：' + formatDateTimeUtc8(config.start) + ' → ' + formatDateTimeUtc8(config.end)
        + '（' + config.instId + '，' + config.bar + '，' + config.leverage + ' 倍杠杆）')
    }

    // 3) K 线：--data 走本地文件；否则查缓存/联网；--offline 保证一个请求都不发。
    let bars
    if (parsed.values.data !== undefined) {
      const loaded = readBarsFromFile(parsed.values.data, config)
      bars = loaded.bars
      if (!quiet) {
        err('数据：本地文件 ' + resolve(parsed.values.data) + '，' + bars.length + ' 根'
          + (bars.length === loaded.total ? '' : '（已按 --start/--end 从 ' + loaded.total + ' 根中过滤）'))
      }
    } else {
      const offline = parsed.flags.offline === true
      if (!offline) {
        fetcher = createOkxFetcher({
          log: quiet ? undefined : (message) => err('  ' + message),
        })
      }
      const loaded = await loadBars({
        instId: config.instId,
        bar: config.bar,
        start: config.start,
        end: config.end,
        dataDir: config.dataDir,
        offline,
        fetcher: fetcher ?? undefined,
        log: quiet ? undefined : (message) => err('  ' + message),
      })
      if (loaded.ok !== true) throw new Error(loaded.error || 'K 线加载失败')
      for (const warning of loaded.warnings ?? []) err('警告：' + warning)
      if (!Array.isArray(loaded.bars) || loaded.bars.length < 2) {
        throw new Error('时间范围内没有 K 线（或只有 ' + formatCount(loaded.bars?.length ?? 0)
          + ' 根），无法回测：' + formatDateTimeUtc8(config.start) + ' → ' + formatDateTimeUtc8(config.end))
      }
      bars = loaded.bars
      if (!quiet) err('数据：' + describeBars(loaded))
    }

    // 3.5) 资金费率：历史（OKX 最近约 3 个月）+ 缺失区间按估算费率补齐。
    //      抓取失败不阻断回测：明确警告后退化为「全区间估算」，报告里会标注估算次数。
    let fundingEvents = []
    let fundingMeta = null
    if (config.includeFunding) {
      const fundingLoaded = await loadFundingRates({
        instId: config.instId,
        start: config.start,
        end: config.end,
        dataDir: config.dataDir,
        offline: parsed.flags.offline === true,
        fetcher: fetcher ?? undefined,
        log: quiet ? undefined : (message) => err('  ' + message),
      })
      for (const warning of fundingLoaded.warnings ?? []) err('警告：' + warning)
      const built = buildFundingEvents({
        rates: fundingLoaded.rates,
        start: config.start,
        end: config.end,
        fallbackRate: config.fundingRate,
        intervalMs: FUNDING_INTERVAL_MS,
      })
      fundingEvents = built.events
      fundingMeta = Object.assign({}, built.meta, {
        source: fundingLoaded.ok === true ? (fundingLoaded.fromCache === true ? 'cache' : 'okx') : 'estimated',
        error: fundingLoaded.error ?? null,
      })
      if (fundingLoaded.ok !== true) {
        err('警告：资金费率历史不可用（' + (fundingLoaded.error || '未知原因') + '），全区间按估算费率 '
          + formatFeeRate(config.fundingRate) + '/8h 计算')
      }
      if (!quiet) {
        err('资金费率：历史 ' + formatCount(built.meta.historicalCount) + ' 次 + 估算 '
          + formatCount(built.meta.estimatedCount) + ' 次（估算值 ' + formatFeeRate(config.fundingRate) + '/8h）')
      }
    }

    // 4) 回测 + 指标：都是纯 CPU/纯函数，不碰网络和文件。
    const result = runBacktest({ bars, strategy, config, funding: fundingEvents, fundingMeta })
    const metrics = computeMetrics(result)

    // 5) 输出：完整摘要 → 报告文件 → --json 摘要。报告路径无论如何都打印（--quiet 也一样）。
    if (quiet) {
      out('完成：' + config.instId + ' · ' + config.bar + ' · ' + strategy.name
        + ' · 最终权益 ' + formatAmount(metrics.finalEquity) + ' USDT'
        + ' · 总收益 ' + formatPct(metrics.totalReturnPct, true)
        + ' · 最大回撤 ' + formatPct(metrics.maxDrawdownPct)
        + ' · 交易 ' + formatCount(metrics.tradeCount) + ' 笔')
    } else {
      writeBlock(out, formatConsole(result, metrics, config))
    }

    const paths = await writeReports({
      result,
      metrics,
      config,
      strategy: { name: strategy.name, params: strategy.params },
      outDir: config.outDir,
      // HTML 报告里的 K 线图需要原始 OHLC（result 里只有权益曲线的收盘价）
      bars,
    })
    out('报告：')
    out('  JSON  ' + paths.jsonPath)
    out('  HTML  ' + paths.htmlPath)
    out('  CSV   ' + paths.csvPath)

    if (parsed.flags.json === true) {
      // 单行 JSON：脚本直接取最后一行解析，不用在混合输出里找括号配对。
      out(JSON.stringify(buildSummary({ config, strategy, result, metrics, paths })))
    }
    return 0
  } catch (error) {
    err('错误：' + errorMessage(error))
    return 1
  } finally {
    if (fetcher !== null && typeof fetcher.close === 'function') {
      try {
        const maybePromise = fetcher.close()
        if (maybePromise !== null && typeof maybePromise === 'object' && typeof maybePromise.then === 'function') {
          await maybePromise
        }
      } catch (error) {
        // 关闭失败不该把已经跑完的回测判成失败，但必须让人看见（否则进程可能挂住）。
        err('警告：关闭联网通道失败：' + errorMessage(error))
      }
    }
  }
}

/** 直接 `node backtest/run.mjs` 时才自动执行；被测试 import 时不跑。 */
function isDirectRun() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write('错误：' + errorMessage(error) + '\n')
      process.exitCode = 1
    })
}
