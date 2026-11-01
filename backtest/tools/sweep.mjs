/**
 * 策略参数扫描（回测框架自带的小工具，研究用）。
 *
 * 为什么需要它：手改一组参数跑一次 CLI 太慢，而且**很容易在全样本上过拟合**。
 * 这个工具一次跑完一组笛卡尔积，并支持 `--walk 0.7` 的「训练 / 验证」切分：
 * 用前 70% 的数据排名，再看后 30% 的表现 —— 后段不参与选择，才有一点样本外意义。
 *
 * 用法示例：
 *   node backtest/tools/sweep.mjs --strategy donchian-trend --bar 1h \
 *     --start now-1095d --end now --walk 0.7 \
 *     --grid "entryWindow=24,48,72;exitWindow=12,24,48;trendWindow=0,100,200;atrStop=0,2,3;allowShort=false,true" \
 *     --sort annualizedReturnPct --top 15
 *
 * 输出：控制台排名表 + 可选的 `--out results.json`（含每组的完整指标，便于二次分析）。
 * 注意：**参数扫描的结果天然乐观**（选择偏差），验证段也只是"同一段历史的末尾"，
 * 不等于真实样本外。README 的「局限」里写明了这一点。
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { barById, formatTimeUtc8, normalizeConfig } from '../lib/config.mjs'
import { loadBars } from '../lib/data.mjs'
import { loadStrategy, withResolvedParams } from '../lib/strategy.mjs'
import { runBacktest } from '../lib/engine.mjs'
import { computeMetrics } from '../lib/metrics.mjs'

const USAGE = [
  '策略参数扫描（backtest/tools/sweep.mjs）',
  '',
  '用法：node backtest/tools/sweep.mjs --strategy <名字> --grid "参数=值1,值2;参数2=值..." [选项]',
  '',
  '必填：',
  '  --strategy <名字>      内置策略名（同 CLI 的 --strategy；不支持路径，避免扫错文件）',
  '  --grid <表达式>        参数笛卡尔积，形如 "fast=10,20;slow=50,100"',
  '',
  '可选：',
  '  --bar <周期>           默认 1h',
  '  --start <时间>         默认 now-1095d（近 3 年）',
  '  --end <时间>           默认 now',
  '  --capital <USDT>       默认 10000',
  '  --leverage <倍数>      默认 1',
  '  --maker <费率> / --taker <费率>   默认 0.0002 / 0.0005',
  '  --walk <比例>          0–1 之间：前 N 为训练段、后 1-N 为验证段；不传则全样本排名',
  '  --sort <指标>          排名指标（默认 annualizedReturnPct；maxDrawdownPct 会按越小越好排）',
  '  --top <N>              表格显示前 N 名（默认 15）',
  '  --data-dir <目录>      K 线缓存目录（默认 backtest/data）',
  '  --out <file.json>      把完整结果（含每段全部指标）写到文件',
  '  --json                 在 stdout 末尾额外打印一行 JSON 摘要（供脚本消费）',
  '  --help                 显示本帮助',
  '',
  '指标名：annualizedReturnPct / totalReturnPct / maxDrawdownPct / sharpe / sortino / calmar / winRatePct',
].join('\n')

function fail(message) {
  console.error('错误：' + message)
  process.exitCode = 1
}

/** 极简参数解析：值选项取下一个参数；不认识的一律报错（避免"拼错了却静默忽略"）。 */
export function parseArgs(argv) {
  const VALUE_OPTIONS = {
    '--strategy': 'strategy', '--grid': 'grid', '--bar': 'bar', '--start': 'start', '--end': 'end',
    '--capital': 'capital', '--leverage': 'leverage', '--maker': 'maker', '--taker': 'taker',
    '--walk': 'walk', '--sort': 'sort', '--top': 'top', '--data-dir': 'dataDir', '--out': 'out',
  }
  const FLAG_OPTIONS = { '--json': 'json', '--help': 'help', '-h': 'help' }
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (FLAG_OPTIONS[arg] !== undefined) {
      options[FLAG_OPTIONS[arg]] = true
      continue
    }
    const key = VALUE_OPTIONS[arg]
    if (key === undefined) throw new Error('不认识的参数：' + arg + '（用 --help 看用法）')
    if (i + 1 >= argv.length) throw new Error(arg + ' 缺少值')
    options[key] = argv[i + 1]
    i += 1
  }
  return options
}

/** "a=1,2;b=x,y" → [{ a: 1 }, { a: 2 }] × [{ b: 'x' }, { b: 'y' }] 的笛卡尔积 */
export function expandGrid(text) {
  const axes = []
  for (const piece of String(text).split(';')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf('=')
    if (at <= 0) throw new Error('grid 片段不合法（要 参数=值1,值2）：' + trimmed)
    const key = trimmed.slice(0, at).trim()
    const values = trimmed.slice(at + 1).split(',').map((value) => value.trim()).filter((value) => value !== '')
    if (values.length === 0) throw new Error('grid 参数没有值：' + key)
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key)) throw new Error('参数名不合法：' + key)
    const parsed = values.map((value) => {
      if (value === 'true') return true
      if (value === 'false') return false
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    })
    axes.push({ key: key, values: parsed })
  }
  if (axes.length === 0) throw new Error('grid 是空的')
  let combos = [{}]
  for (const axis of axes) {
    const next = []
    for (const combo of combos) {
      for (const value of axis.values) {
        const entry = Object.assign({}, combo)
        entry[axis.key] = value
        next.push(entry)
      }
    }
    combos = next
    if (combos.length > 5000) throw new Error('参数组合超过 5000 组（' + String(combos.length) + '），请缩小 grid')
  }
  return { axes: axes, combos: combos }
}

function paramsText(params) {
  return Object.keys(params).map((key) => key + '=' + String(params[key])).join(' ')
}

function numberText(value, digits, suffix) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return Number(value).toFixed(digits === undefined ? 2 : digits) + (suffix === undefined ? '' : suffix)
}

/** 从 metrics 里挑出表格要展示的字段。 */
function pickMetrics(metrics) {
  return {
    totalReturnPct: metrics.totalReturnPct,
    annualizedReturnPct: metrics.annualizedReturnPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    sharpe: metrics.sharpe,
    sortino: metrics.sortino,
    calmar: metrics.calmar,
    winRatePct: metrics.winRatePct,
    tradeCount: metrics.tradeCount,
    feesTotal: metrics.feesTotal,
    exposurePct: metrics.exposurePct,
  }
}

/** 跑一段 K 线：策略 + 配置 → metrics（顺手把该段实际覆盖的 config.start/end 对齐）。 */
function segmentMetrics(strategy, bars, baseConfig) {
  const first = bars[0].t
  const last = bars[bars.length - 1].t
  const config = Object.assign({}, baseConfig, { start: first, end: last + barById(baseConfig.bar).ms })
  const result = runBacktest({ bars: bars, strategy: strategy, config: config })
  return computeMetrics(result)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(String(error.message || error))
    return
  }
  if (options.help === true) {
    console.log(USAGE)
    return
  }
  if (typeof options.strategy !== 'string' || options.strategy === '') { fail('缺少 --strategy'); return }
  if (typeof options.grid !== 'string' || options.grid === '') { fail('缺少 --grid（参数笛卡尔积）'); return }

  let grid
  try {
    grid = expandGrid(options.grid)
  } catch (error) {
    fail(String(error.message || error))
    return
  }

  let config
  try {
    config = normalizeConfig({
      bar: options.bar === undefined ? '1h' : options.bar,
      start: options.start === undefined ? 'now-1095d' : options.start,
      end: options.end === undefined ? 'now' : options.end,
      initialCapital: options.capital,
      leverage: options.leverage,
      makerFeeRate: options.maker,
      takerFeeRate: options.taker,
      dataDir: options.dataDir,
    })
  } catch (error) {
    fail(String(error.message || error))
    return
  }

  let loaded
  try {
    loaded = await loadBars({
      instId: config.instId,
      bar: config.bar,
      start: config.start,
      end: config.end,
      dataDir: config.dataDir,
      log: (message) => console.log('  · ' + String(message)),
    })
  } catch (error) {
    fail('加载 K 线失败：' + String(error.message || error))
    return
  }
  if (loaded.ok !== true) { fail(String(loaded.error || '没有取到 K 线')); return }
  const bars = loaded.bars
  if (bars.length < 100) { fail('K 线太少（' + String(bars.length) + ' 根），扫参数没有意义'); return }

  let base
  try {
    base = await loadStrategy(options.strategy)
  } catch (error) {
    fail(String(error.message || error))
    return
  }

  const walk = options.walk === undefined ? 0 : Number(options.walk)
  if (!(walk >= 0 && walk < 1)) { fail('--walk 必须在 [0,1) 之间（0 表示不切分）'); return }
  const splitAt = walk > 0 ? Math.floor(bars.length * walk) : null
  const segments = splitAt === null
    ? [{ name: 'full', bars: bars }]
    : [{ name: 'train', bars: bars.slice(0, splitAt) }, { name: 'test', bars: bars.slice(splitAt) }]
  const rankSegment = segments[0].name

  const sortKey = options.sort === undefined ? 'annualizedReturnPct' : String(options.sort)
  const ascending = sortKey === 'maxDrawdownPct'
  const top = options.top === undefined ? 15 : Math.max(1, Math.floor(Number(options.top)))

  // Buy&Hold 基准：在同一段数据上跑一遍 buy-hold，让"策略到底有没有超额"有参照
  let benchmark = null
  try {
    const buyHold = withResolvedParams(await loadStrategy('buy-hold'), {})
    benchmark = segments.map((segment) => ({ name: segment.name, metrics: segmentMetrics(buyHold, segment.bars, config) }))
  } catch (error) {
    benchmark = null
  }

  console.log('')
  console.log('════════ 策略参数扫描 ════════')
  console.log('策略：' + base.name + '    周期：' + config.bar + '    K 线：' + String(bars.length) + ' 根')
  console.log('区间：' + formatTimeUtc8(bars[0].t) + ' → ' + formatTimeUtc8(bars[bars.length - 1].t))
  if (splitAt !== null) {
    console.log('切分：训练 ' + String(segments[0].bars.length) + ' 根（' + formatTimeUtc8(segments[0].bars[0].t) + ' → '
      + formatTimeUtc8(segments[0].bars[segments[0].bars.length - 1].t) + '）'
      + ' / 验证 ' + String(segments[1].bars.length) + ' 根（' + formatTimeUtc8(segments[1].bars[0].t) + ' → '
      + formatTimeUtc8(segments[1].bars[segments[1].bars.length - 1].t) + '）')
  }
  if (benchmark !== null) {
    console.log('Buy&Hold 基准：' + benchmark.map((item) => item.name + ' 年化 '
      + numberText(item.metrics.annualizedReturnPct, 2, '%') + ' / 回撤 '
      + numberText(item.metrics.maxDrawdownPct, 2, '%')).join('    '))
  }
  console.log('参数组合：' + String(grid.combos.length) + ' 组    排名指标：' + sortKey + (ascending ? '（越小越好）' : '（越大越好）'))
  console.log('')

  const rows = []
  let done = 0
  for (const combo of grid.combos) {
    done += 1
    if (done % 20 === 0) console.log('  …已完成 ' + String(done) + '/' + String(grid.combos.length))
    let strategy
    try {
      strategy = withResolvedParams(base, combo)
    } catch (error) {
      rows.push({ params: combo, error: String(error.message || error) })
      continue
    }
    const row = { params: combo }
    try {
      for (const segment of segments) {
        row[segment.name] = pickMetrics(segmentMetrics(strategy, segment.bars, config))
      }
    } catch (error) {
      rows.push({ params: combo, error: String(error.message || error) })
      continue
    }
    rows.push(row)
  }

  const ranked = rows
    .filter((row) => row.error === undefined && row[rankSegment] !== undefined)
    .sort((a, b) => {
      const av = a[rankSegment][sortKey]
      const bv = b[rankSegment][sortKey]
      const an = Number.isFinite(Number(av)) ? Number(av) : (ascending ? Infinity : -Infinity)
      const bn = Number.isFinite(Number(bv)) ? Number(bv) : (ascending ? Infinity : -Infinity)
      return ascending ? an - bn : bn - an
    })

  const errors = rows.length - ranked.length
  const header = splitAt === null
    ? ['#', '参数'.padEnd(52), '年化', '总收益', '最大回撤', '夏普', '交易', '胜率']
    : ['#', '参数'.padEnd(52), '训练年化', '训练总收益', '训练回撤', '训练夏普', '训练交易', '验证（年化 / 回撤 / 夏普 / 交易）']
  console.log(header.join('  '))
  console.log('─'.repeat(150))
  for (let i = 0; i < Math.min(top, ranked.length); i += 1) {
    const row = ranked[i]
    const seg = row[rankSegment]
    const cells = [String(i + 1).padStart(2), paramsText(row.params).padEnd(52)]
    if (splitAt === null) {
      cells.push(
        numberText(seg.annualizedReturnPct, 2, '%'),
        numberText(seg.totalReturnPct, 2, '%'),
        numberText(seg.maxDrawdownPct, 2, '%'),
        numberText(seg.sharpe, 2),
        String(seg.tradeCount),
        numberText(seg.winRatePct, 1, '%'),
      )
    } else {
      // 切分时：训练段排名，验证段并列展示（验证段不参与选择）
      cells.push(
        numberText(seg.annualizedReturnPct, 2, '%'),
        numberText(seg.totalReturnPct, 2, '%'),
        numberText(seg.maxDrawdownPct, 2, '%'),
        numberText(seg.sharpe, 2),
        String(seg.tradeCount),
      )
      const test = row.test
      cells.push('→ 验证 年化 ' + numberText(test.annualizedReturnPct, 2, '%')
        + ' / 回撤 ' + numberText(test.maxDrawdownPct, 2, '%')
        + ' / 夏普 ' + numberText(test.sharpe, 2)
        + ' / 交易 ' + String(test.tradeCount))
    }
    console.log(cells.join('  '))
  }
  if (errors > 0) console.log('\n（' + String(errors) + ' 组参数运行失败，已跳过）')

  const best = ranked.length > 0 ? ranked[0] : null
  if (best !== null) {
    console.log('')
    console.log('最优参数（按 ' + rankSegment + ' 段 ' + sortKey + '）：' + paramsText(best.params))
    if (splitAt !== null) {
      console.log('  训练段：年化 ' + numberText(best.train.annualizedReturnPct, 2, '%')
        + ' / 回撤 ' + numberText(best.train.maxDrawdownPct, 2, '%')
        + ' / 夏普 ' + numberText(best.train.sharpe, 2) + ' / 交易 ' + String(best.train.tradeCount))
      console.log('  验证段：年化 ' + numberText(best.test.annualizedReturnPct, 2, '%')
        + ' / 回撤 ' + numberText(best.test.maxDrawdownPct, 2, '%')
        + ' / 夏普 ' + numberText(best.test.sharpe, 2) + ' / 交易 ' + String(best.test.tradeCount))
    }
  }

  if (typeof options.out === 'string' && options.out !== '') {
    const payload = {
      generatedAt: Date.now(),
      strategy: base.name,
      grid: { axes: grid.axes, combos: grid.combos.length },
      config: {
        instId: config.instId, bar: config.bar, start: config.start, end: config.end,
        initialCapital: config.initialCapital, leverage: config.leverage,
        makerFeeRate: config.makerFeeRate, takerFeeRate: config.takerFeeRate,
      },
      bars: bars.length,
      walk: walk,
      sortKey: sortKey,
      benchmark: benchmark,
      rows: rows,
    }
    writeFileSync(options.out, JSON.stringify(payload, null, 1), 'utf8')
    console.log('\n完整结果已写入：' + options.out)
  }
  if (options.json === true) {
    console.log(JSON.stringify({
      ok: true,
      strategy: base.name,
      combos: grid.combos.length,
      walk: walk,
      sortKey: sortKey,
      best: best === null ? null : { params: best.params, train: best.train === undefined ? null : best.train, test: best.test === undefined ? null : best.test },
      benchmark: benchmark,
    }))
  }
}

/** 直接运行（`node backtest/tools/sweep.mjs ...`）才执行；被测试 import 时不跑，避免误触发。 */
function isDirectRun() {
  try {
    const entry = process.argv[1]
    if (typeof entry !== 'string' || entry === '') return false
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch (error) {
    return false
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    fail(String(error && error.message ? error.message : error))
  })
}
