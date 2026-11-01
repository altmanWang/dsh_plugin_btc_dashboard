/**
 * 资金费率（funding）专项自检：transport 解析 / data 缓存与估算 / engine 结算 / metrics / report。
 *
 * 全部离线：transport 用注入的假 request，data 用假 fetcher + mkdtemp 临时缓存，
 * engine/metrics/report 是纯函数。不碰网络、不读仓库里的真实缓存。
 */
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_FUNDING_RATE, FUNDING_INTERVAL_MS, normalizeConfig } from '../backtest/lib/config.mjs'
import { buildFundingEvents, loadFundingRates } from '../backtest/lib/data.mjs'
import { runBacktest } from '../backtest/lib/engine.mjs'
import { computeMetrics } from '../backtest/lib/metrics.mjs'
import { buildHtmlReport, buildJsonReport, formatConsole } from '../backtest/lib/report.mjs'
import { createOkxFetcher } from '../backtest/lib/transport.mjs'
import { loadStrategy, withResolvedParams } from '../backtest/lib/strategy.mjs'

let passed = 0
let failed = 0
function check(condition, label, detail = '') {
  if (condition) {
    passed += 1
    console.log('ok   ' + label + (detail === '' ? '' : '  ' + detail))
  } else {
    failed += 1
    console.log('FAIL ' + label + (detail === '' ? '' : '  ' + detail))
  }
}
function near(actual, expected, tolerance, label) {
  const ok = Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance
  check(ok, label, 'actual=' + String(actual) + ' expected≈' + String(expected))
}

/** 构造一根 4h K 线；价格可以用固定值或函数。 */
function bar(t, price) {
  return { t, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 100 }
}
function barsFrom(startMs, count, priceAt) {
  const out = []
  for (let i = 0; i < count; i += 1) out.push(bar(startMs + i * FUNDING_INTERVAL_MS / 2, priceAt(i)))
  return out
}

const tempDirs = []
function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-funding-' + name + '-'))
  tempDirs.push(dir)
  return dir
}

try {
  // ================================================================ 1) transport 解析
  console.log('\n--- 1) transport.fetchFundingPage ---')
  {
    const calls = []
    const request = async (target, url) => {
      calls.push(String(url))
      return {
        status: 200,
        body: JSON.stringify({
          code: '0',
          data: [
            { instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', realizedRate: '0.00012', fundingTime: '1704067200000' },
            { instId: 'BTC-USDT-SWAP', fundingRate: '-0.0002', fundingTime: '1704038400000' },
            { bad: 'row' },
          ],
        }),
      }
    }
    const fetcher = createOkxFetcher({ proxy: null, request, delayMs: 0, retries: 0 })
    const page = await fetcher.fetchFundingPage({ instId: 'BTC-USDT-SWAP', after: 1704153600000, limit: 50 })
    check(page.ok === true && Array.isArray(page.rows), 'fetchFundingPage 成功返回 rows')
    check(page.rows.length === 2, '坏行被丢弃（只剩 2 条合法记录）', 'rows=' + String(page.rows.length))
    check(page.rows[0].t === 1704067200000 && page.rows[0].rate === 0.00012,
      '优先用 realizedRate、保留原始顺序（最新在前）', JSON.stringify(page.rows[0]))
    check(page.rows[1].rate === -0.0002, '缺 realizedRate 时退回 fundingRate', JSON.stringify(page.rows[1]))
    check(calls.length === 1 && calls[0].includes('after=1704153600000') && calls[0].includes('limit=50'),
      '请求 URL 带 after / limit', calls[0] || '')
    const empty = createOkxFetcher({
      proxy: null,
      delayMs: 0,
      retries: 0,
      request: async () => ({ status: 200, body: JSON.stringify({ code: '0', data: [] }) }),
    })
    const emptyPage = await empty.fetchFundingPage({ instId: 'BTC-USDT-SWAP', after: 1000 })
    check(emptyPage.ok === true && emptyPage.rows.length === 0, '空页返回 ok + 空数组（表示没有更早数据）')
    const bad = await fetcher.fetchFundingPage({ instId: '' })
    check(bad.ok === false && typeof bad.error === 'string', '非法 instId 返回中文错误而非抛异常', bad.error)
    const failed = createOkxFetcher({
      proxy: null,
      delayMs: 0,
      retries: 0,
      request: async () => ({ status: 500, body: 'boom' }),
    })
    const failPage = await failed.fetchFundingPage({ instId: 'BTC-USDT-SWAP', after: 1000 })
    check(failPage.ok === false, 'HTTP 500 折成 ok:false')
  }

  // ================================================================ 2) data 缓存 / 估算
  console.log('\n--- 2) loadFundingRates + buildFundingEvents ---')
  {
    const NOW = Date.UTC(2026, 0, 10, 0, 0, 0)
    const day = 86_400_000
    const start = NOW - 6 * day
    const end = NOW
    // 交易所只有最近 2 天的数据：制造「部分覆盖 → 估算兜底」场景
    const rates = []
    for (let t = NOW - 2 * day; t < NOW; t += FUNDING_INTERVAL_MS) rates.push({ t, rate: 0.0001 })
    const calls = []
    const fetcher = {
      async fetchFundingPage(params) {
        calls.push(params)
        const older = rates
          .filter((row) => row.t < params.after)
          .sort((a, b) => b.t - a.t)
          .slice(0, 100)
        return { ok: true, rows: older }
      },
    }
    const dir = tempDir('cache')
    const first = await loadFundingRates({ instId: 'BTC-USDT-SWAP', start, end, dataDir: dir, now: NOW, fetcher })
    check(first.ok === true, 'loadFundingRates ok:true')
    check(first.rates.length === rates.length, '历史费率点数量正确', 'got=' + String(first.rates.length))
    check(first.rates.every((row, index) => index === 0 || row.t > first.rates[index - 1].t), '返回的 rates 按时间升序')
    check(calls.length >= 1, '需要联网时调用了 fetcher', 'pages=' + String(calls.length))
    check(first.warnings.some((w) => w.includes('估算')), '覆盖不足时给出「将按固定费率估算」警告',
      JSON.stringify(first.warnings))
    const cacheFile = join(dir, 'BTC-USDT-SWAP', 'funding.json')
    check(existsSync(cacheFile), '资金费率缓存已落盘 funding.json')
    check(first.cacheFile === cacheFile, '返回 cacheFile 路径')

    // 第二次：缓存命中（区间在已覆盖范围内），不再调用 fetcher
    let secondCalls = 0
    const second = await loadFundingRates({
      instId: 'BTC-USDT-SWAP', start: NOW - 2 * day, end, dataDir: dir, now: NOW,
      fetcher: { async fetchFundingPage() { secondCalls += 1; return { ok: true, rows: [] } } },
    })
    check(second.ok === true && secondCalls === 0, '缓存命中时不联网', 'fetcherCalls=' + String(secondCalls))
    check(second.fromCache === true, 'fromCache=true')

    // 离线 + 缓存未覆盖 → ok:false 且带中文原因
    const offlineMiss = await loadFundingRates({
      instId: 'BTC-USDT-SWAP', start: start - 10 * day, end, dataDir: dir, now: NOW, offline: true,
    })
    check(offlineMiss.ok === false && String(offlineMiss.error).includes('离线'),
      '离线模式缓存缺口 → ok:false + 中文错误', String(offlineMiss.error))

    // 缓存损坏 → 不抛，忽略并重新抓
    writeFileSync(cacheFile, '{ 不是 json')
    const damaged = await loadFundingRates({
      instId: 'BTC-USDT-SWAP', start, end, dataDir: dir, now: NOW, fetcher,
    })
    check(damaged.ok === true && damaged.warnings.some((w) => w.includes('损坏')),
      '缓存损坏时忽略并重新抓（不抛异常）')

    // ---- buildFundingEvents：历史 + 估算拼接、8h 对齐
    const built = buildFundingEvents({ rates: first.rates, start, end, fallbackRate: DEFAULT_FUNDING_RATE })
    const uncoveredEvents = built.events.filter((event) => event.t < NOW - 2 * day)
    const estimatedCount = built.meta.estimatedCount
    check(built.meta.historicalCount > 0 && estimatedCount > 0,
      '历史 + 估算混合：historical>0 且 estimated>0',
      'historical=' + String(built.meta.historicalCount) + ' estimated=' + String(estimatedCount))
    check(uncoveredEvents.every((event) => event.rate === DEFAULT_FUNDING_RATE && event.t % FUNDING_INTERVAL_MS === 0),
      '估算点对齐 8 小时 UTC 网格且用估算费率')
    check(built.meta.fallbackRate === DEFAULT_FUNDING_RATE, 'meta 带兜底费率')
    check(built.events.every((event, index) => index === 0 || event.t > built.events[index - 1].t),
      '拼接后结算点严格升序（同一时刻不重复）')

    // 完整覆盖：不该有估算点
    const fullCoverage = []
    for (let t = Math.ceil(start / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS; t < end; t += FUNDING_INTERVAL_MS) {
      fullCoverage.push({ t, rate: 0.0002 })
    }
    const fullBuilt = buildFundingEvents({ rates: fullCoverage, start, end, fallbackRate: 0.9 })
    check(fullBuilt.meta.estimatedCount === 0 && fullBuilt.meta.historicalCount === fullCoverage.length,
      '历史覆盖完整时没有估算点', JSON.stringify(fullBuilt.meta))
    check(fullBuilt.events.every((event) => event.rate === 0.0002), '完整覆盖时不会混入估算费率')
  }

  // ================================================================ 3) engine 结算
  console.log('\n--- 3) 引擎资金费率结算 ---')
  {
    const NOW = Date.UTC(2026, 0, 10, 0, 0, 0)
    const START = NOW - 2 * 86_400_000
    const bars = barsFrom(START, 12, (index) => 100 + index)
    const config = normalizeConfig({
      bar: '4h', start: START, end: NOW, initialCapital: 10000,
      includeFunding: true, fundingRate: DEFAULT_FUNDING_RATE, dataDir: 'x', outDir: 'y',
    })
    const funding = []
    for (let i = 0; i < bars.length; i += 1) funding.push({ t: bars[i].t, rate: 0.0001 })
    const buyHold = await loadStrategy('buy-hold')
    const result = runBacktest({ bars, strategy: withResolvedParams(buyHold, {}), config, funding })
    check(result.funding !== undefined && result.funding.count > 0, '多头持仓时结算了资金费率', 'count=' + String(result.funding.count))
    // 多头 + 正费率 → 付出（total > 0）
    check(result.funding.total > 0, '多头 + 正费率 → 净支出为正', 'total=' + String(result.funding.total))
    // 手工核对：每条结算金额 = 当次持仓 qty × 当根收盘价 × rate；总额 = 各条之和
    const curve = result.equityCurve
    let expected = 0
    const barTimeToIndex = new Map(bars.map((item, index) => [item.t, index]))
    for (const event of result.funding.events) {
      const index = barTimeToIndex.get(event.t)
      if (index === undefined) continue
      expected += event.qty * event.price * 0.0001
      // 末日那根会被 closeAtEnd 强制平仓，equityCurve 里的 qty 被改成 0；其余根应和结算时的持仓一致
      if (index < bars.length - 1) {
        near(event.qty, curve[index].qty, 1e-9, '第 ' + String(index) + ' 根结算时持仓与权益曲线一致')
      }
    }
    near(result.funding.total, expected, 1e-6, '结算总额 = Σ(结算时 qty × 结算价 × rate)')
    check(result.funding.paid > 0 && result.funding.received === 0, '多头只有付出、没有收到')

    // 空头：正费率应收钱（total < 0）
    const shortStrategy = {
      name: 'short-test',
      params: {},
      onBar(ctx) {
        if (ctx.position === null || ctx.position.side === 'flat') ctx.target({ side: 'short', weight: 1 })
      },
    }
    const shortResult = runBacktest({ bars, strategy: shortStrategy, config, funding })
    check(shortResult.funding.total < 0, '空头 + 正费率 → 净收到（total 为负）', 'total=' + String(shortResult.funding.total))

    // includeFunding=false：不结算
    const offConfig = normalizeConfig({ bar: '4h', start: START, end: NOW, includeFunding: false, dataDir: 'x', outDir: 'y' })
    const offResult = runBacktest({ bars, strategy: withResolvedParams(buyHold, {}), config: offConfig, funding })
    check(offResult.funding.count === 0 && offResult.funding.total === 0, 'includeFunding=false 时完全不计资金费率')

    // 不传 funding：零成本（旧调用方式兼容）
    const noFunding = runBacktest({ bars, strategy: withResolvedParams(buyHold, {}), config })
    check(noFunding.funding.count === 0 && noFunding.funding.total === 0, '不传 funding 时零成本（向后兼容）')

    // 结算点时间窗：只结算落在 [bar.t, bar.t+barMs) 的点；末日收盘边界（= bar.t+barMs）不属于任何一根
    const boundaryEvent = { t: bars[bars.length - 1].t + bars[1].t - bars[0].t, rate: 0.0001 }
    const withBoundary = runBacktest({
      bars,
      strategy: withResolvedParams(buyHold, {}),
      config,
      funding: funding.concat([boundaryEvent]),
    })
    check(withBoundary.funding.count === result.funding.count,
      '末日收盘边界上的结算点不会被多算一次',
      'base=' + String(result.funding.count) + ' boundary=' + String(withBoundary.funding.count))

    // ---- metrics 字段
    const metrics = computeMetrics(result)
    near(metrics.fundingTotal, result.funding.total, 1e-9, 'metrics.fundingTotal = result.funding.total')
    check(metrics.fundingCount === result.funding.count, 'metrics.fundingCount = result.funding.count')
    check(Number.isFinite(metrics.fundingPctOfCapital) && Number.isFinite(metrics.totalCostPctOfCapital),
      'metrics 带资金费率/总成本占初始资金')

    // ---- 报告：console / HTML / JSON 都要出现 funding 口径
    const cfg = result.config
    const consoleText = formatConsole(result, metrics, cfg)
    check(consoleText.includes('资金费率净支出'), '控制台摘要含「资金费率净支出」')
    check(consoleText.includes('结算次数'), '控制台摘要含资金费率结算次数')
    const strategyView = { name: 'buy-hold', params: {} }
    const html = buildHtmlReport({ result, metrics, config: cfg, strategy: strategyView, generatedAt: NOW, bars })
    check(html.includes('报告格式 v3'), 'HTML 页脚是报告格式 v3')
    check(html.includes('资金费率净支出') && html.includes('资金费率结算次数'), 'HTML 费用小节含资金费率')
    check(html.includes('计入资金费率'), 'HTML 配置小节含资金费率开关')
    check(html.includes('资金费率') && html.includes('估算'), 'HTML 局限说明里讲了历史缺失部分的估算')
    const json = buildJsonReport({ result, metrics, config: cfg, strategy: strategyView, generatedAt: NOW })
    check(json.result !== undefined && json.result.funding !== undefined && json.result.funding.count > 0,
      'JSON 报告带 result.funding 明细')
    check(json.metrics.fundingTotal !== undefined, 'JSON 报告 metrics 带 fundingTotal')
  }

  // ================================================================ 4) 报告口径（估算标注）
  console.log('\n--- 4) 报告对「估算」的标注 ---')
  {
    const NOW = Date.UTC(2026, 0, 10, 0, 0, 0)
    const START = NOW - 3 * 86_400_000
    const bars = barsFrom(START, 18, (index) => 100 + index)
    const config = normalizeConfig({ bar: '4h', start: START, end: NOW, dataDir: 'x', outDir: 'y' })
    const built = buildFundingEvents({ rates: [], start: START, end: NOW, fallbackRate: DEFAULT_FUNDING_RATE })
    check(built.meta.historicalCount === 0 && built.meta.estimatedCount > 0, '无历史数据时全部按估算生成')
    const result = runBacktest({
      bars,
      strategy: withResolvedParams(await loadStrategy('buy-hold'), {}),
      config,
      funding: built.events,
      fundingMeta: built.meta,
    })
    const metrics = computeMetrics(result)
    check(metrics.fundingEstimatedCount === built.meta.estimatedCount, 'metrics 记录估算次数')
    const consoleText = formatConsole(result, metrics, config)
    check(consoleText.includes('估算'), '控制台提示里标注了估算次数')
    const html = buildHtmlReport({
      result, metrics, config, strategy: { name: 'buy-hold', params: {} }, generatedAt: NOW, bars,
    })
    check(html.includes('估算'), 'HTML 里标注了估算资金费率')
  }
} finally {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { /* 清理失败不影响结果 */ }
  }
}

console.log('')
if (failed > 0) {
  console.log('── ' + String(failed) + ' 项失败')
  process.exitCode = 1
} else {
  console.log('全部通过（' + String(passed) + ' 项断言）')
}
