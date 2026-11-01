/**
 * 回测撮合引擎：把「K 线 + 策略 + 配置」跑成一份完整的回测结果（BacktestResult）。
 *
 * 引擎只做「按顺序撮合 + 记账」，不碰文件、不发网络、不算绩效指标
 * （指标在 metrics.mjs、报告在 report.mjs）。同样的 bars/strategy/config 永远得到同样的
 * 结果，所以测试可以完全离线跑、报告可以复现。
 *
 * 动手改之前先记住这几条口径（SPEC §6）：
 *
 *   1. 单方向净持仓：qty 有符号（正多负空），同向加仓按数量加权更新均价；
 *      反向成交 =「先平后反」，平掉的部分生成一条 trade，剩余部分按成交价开新仓，
 *      两段手续费各自分摊（多→空反手会留下「平仓 trade + 新开仓」）。
 *   2. 权益 = cash + qty * (price - avgEntry)，即「现金 + 浮盈」；手续费逐笔从 cash 扣，
 *      所以权益始终是净权益。平仓时把已实现盈亏加回 cash，平完后 equity = cash。
 *   3. 每根 K 线的处理顺序严格是：上一根排队的市价单 → 活跃限价单 → 爆仓检查 →
 *      资金费率结算（若启用）→ 收盘盯市写 equityCurve → strategy.onBar。onBar 里下的单
 *      最早下一根才可能成交，所以策略拿到的 ctx 永远看不到未来。第 0 根只做盯市和 onBar。
 *   4. 杠杆只在「开仓 / 加仓 / 反手」时校验；减仓、平仓任何情况下都必须放行
 *      （否则亏到保证金不足时连止损都下不出去，和真实交易直觉相反）。
 *      1 倍下满仓做多正好用尽权益，用 1e-9 容差放过浮点的几个 ulp。
 *   5. 爆仓价用近似公式（忽略手续费与资金费）：1 倍多头约在均价的 0.5%、
 *      1 倍空头约在均价的 1.995 倍 —— 这是 SPEC 明确要的口径，不要为了"永不爆仓"改宽。
 *   6. 资金费率（funding）按 `input.funding` 传入的结算点逐笔从 cash 扣：
 *      多头 `cash -= qty * 收盘价 * rate`，空头自动反向（qty 为负）。
 *      价格用**当根收盘价**近似结算时刻的标记价；结算点必须落在当根 K 线区间
 *      `[bar.t, bar.t + barMs)` 内。未提供 funding（或 config.includeFunding=false）时完全不计。
 */
import {
  DEFAULT_BAR,
  DEFAULT_CAPITAL,
  DEFAULT_INSTID,
  DEFAULT_LEVERAGE,
  DEFAULT_MAKER_FEE_RATE,
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  DEFAULT_TAKER_FEE_RATE,
  barById,
} from './config.mjs'

/** result.logs 上限（SPEC §4.1）。 */
const LOG_LIMIT = 5000
/**
 * 日志缓冲到这么多条才批量裁一次：如果每来一条就 shift，策略刷 10 万条日志会变成 O(n²)。
 * 批量裁剪后最终仍会压回 LOG_LIMIT 条。
 */
const LOG_FLUSH_AT = LOG_LIMIT + 1000
/** 保证金校验容差：1 倍满仓时 `|qty| * price / leverage` 与 equity 理论相等，浮点会差几个 ulp。 */
const MARGIN_EPS = 1e-9
/** 数量比较容差（BTC 量级，1e-12 远小于任何真实下单精度）。 */
const QTY_EPS = 1e-12

/**
 * 跑一次回测。
 *
 * @param {{ bars: object[], strategy: object, config: object }} input
 *   bars: 升序 K 线（数据层已保证已收盘、无重复）；
 *   strategy: defineStrategy() 的产物（至少要有 onBar）；
 *   config: normalizeConfig() 的产物（默认费率/杠杆等都在里面，引擎不硬编码）。
 * @returns {object} BacktestResult（SPEC §4.1）
 * @throws {Error} 输入非法、或策略回调自己抛错（策略错误原样上抛，CLI 负责给人话）
 */
export function runBacktest(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('runBacktest 的参数必须是对象：{ bars, strategy, config }')
  }
  const bars = validateBars(input.bars)
  const strategy = validateStrategy(input.strategy)
  const cfg = resolveConfig(input.config, bars)
  // 资金费率结算点：升序、去重、只认有限数字；未启用时为空数组（零成本）
  const funding = cfg.includeFunding ? normalizeFunding(input.funding) : []
  const fundingMeta = input.fundingMeta !== null && typeof input.fundingMeta === 'object' && !Array.isArray(input.fundingMeta)
    ? input.fundingMeta
    : null

  const barCount = bars.length
  const initialCapital = cfg.initialCapital
  const strategyName = typeof strategy.name === 'string' && strategy.name !== '' ? strategy.name : 'strategy'
  // result.strategy.params 原样带上策略参数对象（defineStrategy 已把它冻结，共享引用安全）；
  // ctx.params 则是再包一层 Object.freeze 的只读快照，策略怎么读都改不回去。
  const strategyParams = strategy.params !== null && typeof strategy.params === 'object' && !Array.isArray(strategy.params)
    ? strategy.params
    : {}
  const paramsSnapshot = Object.freeze({ ...strategyParams })

  // ---- 账户状态 ----
  let cash = initialCapital // 现金：手续费与已实现盈亏都从这里进出
  let qty = 0 // 有符号净持仓（BTC）：正多、负空
  let avgEntry = 0 // 持仓均价；空仓时为 0（配合 qty=0 让权益公式不产生 NaN）
  let positionOpenT = null // 当前持仓段的起点（trade.entryT / bars 用）
  let positionOpenIndex = null
  let openFees = 0 // 当前持仓累计、尚未分摊给任何 trade 的手续费
  let makerFees = 0
  let takerFees = 0
  // ---- 资金费率累加（净支出为正：多头付、空头收；空头收钱时 total 为负） ----
  let fundingPaid = 0
  let fundingReceived = 0
  const fundingEvents = []
  let fundingCursor = 0 // funding 数组的扫描指针（funding 已按 t 升序）

  // ---- 输出（SPEC §4.1） ----
  const equityCurve = []
  const fills = []
  const trades = []
  const liquidations = []
  const rejected = []
  const logs = []
  let logDropped = 0

  // ---- 委托队列 ----
  const marketQueue = [] // 已提交、等下一根开盘成交的市价单 / 目标仓单（按提交顺序）
  let limitOrders = [] // 活跃限价单（按提交顺序撮合）
  let nextOrderId = 1

  // ---- 回放位置（ctx 的 getter 从这里取） ----
  let currentIndex = -1
  let currentBar = null
  let phase = 'start' // 'start' → 'bar' → 'end'

  // ==========================================================================
  // 记账
  // ==========================================================================

  /** 某个价格上的权益（净值）：现金 + 浮动盈亏。空仓时直接返回现金。 */
  function equityAt(price) {
    if (qty === 0) return cash
    return cash + qty * (price - avgEntry)
  }

  /** 当前持仓快照（ctx.position 用；返回新对象，策略改它不影响引擎）。 */
  function positionSnapshot() {
    return {
      side: qty > 0 ? 'long' : qty < 0 ? 'short' : 'flat',
      qty, // 有符号：与 equityCurve.qty 口径一致（正多负空）
      entryPrice: qty === 0 ? null : avgEntry,
      notional: qty === 0 ? 0 : Math.abs(qty) * avgEntry,
      unrealizedPnl: currentBar === null || qty === 0 ? 0 : qty * (currentBar.c - avgEntry),
    }
  }

  /**
   * 结算落在本根 K 线区间内的资金费率（funding）。
   * 多头：cash -= qty * price * rate；空头 qty<0，自动变成收钱。
   * 价格用当根收盘价近似（引擎没有逐笔标记价，见文件头 §6）。
   */
  function settleFunding(bar) {
    if (funding.length === 0) return
    const barEnd = bar.t + cfg.barMs
    while (fundingCursor < funding.length && funding[fundingCursor].t < barEnd) {
      const event = funding[fundingCursor]
      fundingCursor += 1
      // 早于当前 bar 的结算点应该已经在之前的 bar 结算过；跳过（数据源可能给了 range 外的点）
      if (event.t < bar.t) continue
      if (qty === 0) continue
      const amount = qty * bar.c * event.rate // >0 = 多头付钱；<0 = 空头付钱（等于多头收钱）
      cash -= amount
      if (amount >= 0) fundingPaid += amount
      else fundingReceived += -amount
      fundingEvents.push({
        t: event.t,
        rate: event.rate,
        qty,
        price: bar.c,
        amount,
      })
    }
  }

  /**
   * 应用一笔成交：更新现金 / 持仓 / 手续费，产出 fill；若这笔成交平掉了旧仓，同时产出 trade。
   * 约定 qty 是成交的绝对数量，方向看 side。
   */
  function applyFill({ t, index, side, qty: fillQty, price, feeKind, kind, reason }) {
    if (!Number.isFinite(fillQty) || !(fillQty > 0)) {
      throw new Error('内部错误：成交数量必须大于 0，收到：' + String(fillQty))
    }

    const feeRate = feeKind === 'maker' ? cfg.makerFeeRate : cfg.takerFeeRate
    const fee = fillQty * price * feeRate
    cash -= fee
    if (feeKind === 'maker') makerFees += fee
    else takerFees += fee

    const signedQty = side === 'buy' ? fillQty : -fillQty
    const qtyBefore = qty
    const absBefore = Math.abs(qtyBefore)
    const opposite = qtyBefore !== 0 && Math.sign(signedQty) !== Math.sign(qtyBefore)

    if (!opposite) {
      // 同向加仓 / 空仓开仓：均价按数量加权；现金只扣手续费，浮盈由权益公式体现
      avgEntry = (absBefore * avgEntry + fillQty * price) / (absBefore + fillQty)
      qty = qtyBefore + signedQty
      openFees += fee
      if (absBefore === 0) {
        positionOpenT = t
        positionOpenIndex = index
      }
    } else {
      // 反向成交：先按成交价结算被平掉那部分的盈亏，再决定是部分平 / 全平 / 反手
      const closedQty = Math.min(absBefore, fillQty)
      // 建仓阶段累计的手续费按「被平数量 / 原持仓数量」分摊；部分平仓时剩下的继续留在 openFees
      const entryFeeShare = openFees * (closedQty / absBefore)
      openFees -= entryFeeShare
      // 这笔成交如果同时开了反向仓，手续费也要按「平 / 开」两段拆开，各归各的 trade
      const exitFeeShare = fee * (closedQty / fillQty)
      const grossPnl = closedQty * (price - avgEntry) * Math.sign(qtyBefore)
      cash += grossPnl

      const tradeFees = entryFeeShare + exitFeeShare
      const pnl = grossPnl - tradeFees
      const notional = avgEntry * closedQty
      trades.push({
        seq: trades.length + 1,
        side: qtyBefore > 0 ? 'long' : 'short',
        qty: closedQty,
        entryT: positionOpenT,
        entryPrice: avgEntry,
        exitT: t,
        exitPrice: price,
        notional,
        fees: tradeFees,
        pnl,
        pnlPct: notional > 0 ? (pnl / notional) * 100 : 0,
        // 持仓跨了几根 K 线：开仓那根的 index 到平仓那根的 index
        bars: positionOpenIndex === null ? 0 : index - positionOpenIndex,
        exitReason: reason,
      })

      if (fillQty > absBefore + QTY_EPS) {
        // 反手（多→空 / 空→多）：上面已记平仓 trade，剩余数量按成交价开反向新仓
        const remain = fillQty - closedQty
        qty = Math.sign(signedQty) * remain
        avgEntry = price
        openFees = fee - exitFeeShare // 只有开新仓那部分手续费留给新仓
        positionOpenT = t
        positionOpenIndex = index
      } else if (fillQty >= absBefore - QTY_EPS) {
        // 全平
        qty = 0
        avgEntry = 0
        openFees = 0
        positionOpenT = null
        positionOpenIndex = null
      } else {
        // 部分平仓：方向、均价、建仓时间都不变，只缩小数量
        qty = qtyBefore + signedQty
      }
    }

    fills.push({
      t,
      side,
      qty: fillQty,
      price,
      notional: fillQty * price,
      fee,
      feeKind,
      kind,
      reason,
      positionAfter: qty,
    })
  }

  /**
   * 成交后的持仓绝对值是否变大，或由正翻负 / 由负翻正。
   * 两种都意味着「在开新仓」，需要做保证金校验；纯减仓/平仓则永远放行。
   */
  function opensExposure(qtyBefore, qtyAfter) {
    if (qtyAfter === 0) return false
    if (Math.abs(qtyAfter) > Math.abs(qtyBefore) + QTY_EPS) return true
    return qtyBefore !== 0 && Math.sign(qtyAfter) !== Math.sign(qtyBefore)
  }

  /** 保证金校验：成交后 |qty| * price / leverage <= equity(price)（含 1e-9 容差）。 */
  function marginOk(qtyAfter, price) {
    const need = (Math.abs(qtyAfter) * price) / cfg.leverage
    const equity = equityAt(price)
    return need <= equity + MARGIN_EPS * Math.max(1, Math.abs(equity))
  }

  /** 中文数字串，拒绝原因里给人看。 */
  function fmtNum(value) {
    return Number.isFinite(value) ? value.toFixed(2) : String(value)
  }

  function marginDetail(qtyAfter, price) {
    return '成交后 |持仓| * 价格 / 杠杆 = ' + fmtNum((Math.abs(qtyAfter) * price) / cfg.leverage)
      + '，超过成交价上的权益 ' + fmtNum(equityAt(price)) + '（' + cfg.leverage + ' 倍杠杆）'
  }

  function marketView(order) {
    return { kind: 'market', side: order.side, qty: order.qty, reason: order.reason }
  }

  function targetView(order) {
    return { kind: 'target', side: order.side, weight: order.weight, reason: order.reason }
  }

  function limitView(order) {
    return {
      kind: 'limit',
      id: order.id,
      side: order.side,
      price: order.price,
      qty: order.qty,
      reduceOnly: order.reduceOnly,
      reason: order.reason,
    }
  }

  /** 记录被拒委托（SPEC §4.1：rejected 只记杠杆/保证金不足）。 */
  function rejectOrder(t, view, detail) {
    rejected.push({ t, reason: '杠杆/保证金不足：' + detail, order: view })
  }

  // ==========================================================================
  // 日志
  // ==========================================================================

  function addLog(t, message) {
    if (logs.length >= LOG_FLUSH_AT) {
      const drop = logs.length - LOG_LIMIT
      logs.splice(0, drop)
      logDropped += drop
    }
    logs.push({ t, message: String(message) })
  }

  /** 收尾：把日志压到上限内；丢过就补一条说明，否则用户不知道日志被截断。 */
  function finalizeLogs() {
    if (logDropped === 0 && logs.length < LOG_LIMIT) return
    // 说明条目本身也占一个名额，所以历史只保留 LOG_LIMIT-1 条
    const keep = LOG_LIMIT - 1
    const drop = logs.length - keep
    if (drop > 0) {
      logs.splice(0, drop)
      logDropped += drop
    }
    logs.push({
      t: bars[barCount - 1].t,
      message: '日志超过 ' + LOG_LIMIT + ' 条上限，已丢弃最早的 ' + logDropped + ' 条',
    })
  }

  // ==========================================================================
  // 撮合
  // ==========================================================================

  /** 执行一条上一根收盘排队的市价单（本根开盘价 + 方向性滑点，taker）。 */
  function executeMarketOrder(order, bar, index) {
    if (order.type === 'target') {
      executeTargetOrder(order, bar, index)
      return
    }
    const slip = cfg.slippageBps / 1e4
    const price = order.side === 'buy' ? bar.o * (1 + slip) : bar.o * (1 - slip)
    const signedQty = order.side === 'buy' ? order.qty : -order.qty
    const qtyAfter = qty + signedQty
    // 减仓/平仓永远放行；只有开仓/加仓/反手才做保证金校验（详见文件头第 4 条）
    if (opensExposure(qty, qtyAfter) && !marginOk(qtyAfter, price)) {
      rejectOrder(bar.t, marketView(order), marginDetail(qtyAfter, price))
      return
    }
    applyFill({
      t: bar.t,
      index,
      side: order.side,
      qty: order.qty,
      price,
      feeKind: 'taker',
      kind: 'market',
      reason: order.reason,
    })
  }

  /**
   * 执行一条目标仓单。
   *
   * 换算发生在**执行时**（SPEC §6.2）：qtyTarget = ±(equity(price) * leverage * weight) / price。
   * 麻烦在于滑点让成交价依赖方向，而目标数量又依赖成交价 —— 所以买/卖两个候选各算一遍，
   * 再用「当前持仓 vs 候选目标」挑出方向，避免绕圈迭代。
   */
  function executeTargetOrder(order, bar, index) {
    const slip = cfg.slippageBps / 1e4
    const open = bar.o
    const isFlat = order.side === 'flat' || order.weight === 0
    const eqOpen = equityAt(open)

    if (!isFlat && eqOpen <= 0) {
      // 权益为负时按百分比定仓，算出来的数量会变成反向仓（多单变空单），直接拒绝更安全
      rejectOrder(bar.t, targetView(order), '当前权益 ' + fmtNum(eqOpen) + '，不足以按目标仓位开仓')
      return
    }

    const candidates = [1, -1].map((dir) => {
      const price = open * (1 + dir * slip)
      let targetQty = 0
      if (!isFlat) {
        const equity = equityAt(price)
        targetQty = ((order.side === 'long' ? 1 : -1) * (equity * cfg.leverage * order.weight)) / price
      }
      return { dir, price, targetQty }
    })
    const buyCandidate = candidates[0] // dir=+1：买入方向的成交价（更贵）
    const sellCandidate = candidates[1] // dir=-1：卖出方向的成交价（更便宜）

    let chosen = null
    if (qty < buyCandidate.targetQty - QTY_EPS) chosen = buyCandidate
    else if (qty > sellCandidate.targetQty + QTY_EPS) chosen = sellCandidate
    // 目标已经落在滑点噪声内：不再下无意义的单（避免每根 K 线都产生一张碎单）
    if (chosen === null) return

    const delta = chosen.targetQty - qty
    if (!(Math.abs(delta) > QTY_EPS)) return
    const side = delta > 0 ? 'buy' : 'sell'
    const fillQty = Math.abs(delta)

    const eqAtFill = equityAt(chosen.price)
    const targetNotional = Math.abs(chosen.targetQty) * chosen.price
    // 兜底校验：weight<=1 时目标名义天然不超限，这里按 SPEC 再显式挡一次
    if (targetNotional > eqAtFill * cfg.leverage * (1 + MARGIN_EPS) || !marginOk(chosen.targetQty, chosen.price)) {
      rejectOrder(bar.t, targetView(order), marginDetail(chosen.targetQty, chosen.price))
      return
    }

    applyFill({
      t: bar.t,
      index,
      side,
      qty: fillQty,
      price: chosen.price,
      feeKind: 'taker',
      kind: 'market',
      reason: order.reason,
    })
  }

  /** 处理活跃限价单：按提交顺序逐张判成交（每张最多一次，全成或全不成）。 */
  function executeLimitOrders(bar, index) {
    const remaining = []
    for (const order of limitOrders) {
      let triggered
      if (order.side === 'buy') {
        // tradeThrough（默认、保守）：必须真的跌破限价；touch：碰到就算
        triggered = cfg.limitFill === 'touch' ? bar.l <= order.price : bar.l < order.price
      } else {
        triggered = cfg.limitFill === 'touch' ? bar.h >= order.price : bar.h > order.price
      }
      if (!triggered) {
        remaining.push(order)
        continue
      }

      let fillQty = order.qty
      if (order.reduceOnly) {
        const canReduce = (order.side === 'buy' && qty < 0) || (order.side === 'sell' && qty > 0)
        // 持仓已经反向或平掉：reduceOnly 委托作废（不报错，见 SPEC §6.3）
        if (!canReduce) continue
        fillQty = Math.min(fillQty, Math.abs(qty))
        if (!(fillQty > QTY_EPS)) continue
      }

      const signedQty = order.side === 'buy' ? fillQty : -fillQty
      const qtyAfter = qty + signedQty
      if (opensExposure(qty, qtyAfter) && !marginOk(qtyAfter, order.price)) {
        // 挂单时付得起保证金不代表成交时还付得起（权益在变）；到成交这一刻再校验，不够就撤单记 rejected
        rejectOrder(bar.t, limitView(order), marginDetail(qtyAfter, order.price))
        continue
      }

      applyFill({
        t: bar.t,
        index,
        side: order.side,
        qty: fillQty,
        price: order.price,
        feeKind: 'maker',
        kind: 'limit',
        reason: order.reason,
      })
    }
    limitOrders = remaining
  }

  /** 爆仓检查（SPEC §6.4）：用本根不利极值判断，成交价 = 爆仓价，taker。 */
  function checkLiquidation(bar, index) {
    if (qty === 0) return
    const liqPrice = qty > 0
      ? avgEntry * (1 - 1 / cfg.leverage + cfg.maintenanceMarginRate)
      : avgEntry * (1 + 1 / cfg.leverage - cfg.maintenanceMarginRate)
    const triggered = qty > 0 ? bar.l <= liqPrice : bar.h >= liqPrice
    if (!triggered) return

    const qtyAbs = Math.abs(qty)
    applyFill({
      t: bar.t,
      index,
      side: qty > 0 ? 'sell' : 'buy',
      qty: qtyAbs,
      price: liqPrice,
      feeKind: 'taker',
      kind: 'market',
      reason: 'liquidation',
    })
    liquidations.push({
      t: bar.t,
      price: liqPrice,
      qty: qtyAbs,
      equityAfter: equityAt(liqPrice), // 已全平，等于 cash
    })

    // 爆仓后仓位已经归零，之前基于原持仓挂的止盈/止损委托已失去意义；
    // 真实交易所强平也会撤单，这里一并撤掉并记日志，避免下一根出现无法解释的成交。
    const cancelled = limitOrders.length
    limitOrders = []
    if (cancelled > 0) addLog(bar.t, '爆仓强平后撤销 ' + cancelled + ' 张未成交限价单')
  }

  // ==========================================================================
  // ctx（策略上下文）
  // ==========================================================================

  /** 配置快照：策略只读这几个字段，避免把整份 Config 暴露出去被改。 */
  const configSnapshot = Object.freeze({
    instId: cfg.instId,
    bar: cfg.bar,
    leverage: cfg.leverage,
    makerFeeRate: cfg.makerFeeRate,
    takerFeeRate: cfg.takerFeeRate,
    initialCapital: cfg.initialCapital,
  })

  function requireCanOrder(api) {
    if (phase === 'end') {
      throw new Error('onEnd 阶段不允许下单（' + api + '）：回测已经结束，委托不会被撮合')
    }
  }

  /**
   * notional 折算用的「当前价」：onBar 里用刚收盘那根的收盘价（SPEC §6.2/§6.3 的提交时换算）；
   * onStart 阶段还没有收盘价，退而用第一根的开盘价 —— 只影响把 USDT 金额折成 BTC 数量。
   */
  function submissionPrice() {
    return currentBar === null ? bars[0].o : currentBar.c
  }

  /** 校验并读取 qty / notional（二选一），返回换算后的数量（BTC）。 */
  function readOrderQty(qtyInput, notional, api) {
    const hasQty = qtyInput !== undefined && qtyInput !== null
    const hasNotional = notional !== undefined && notional !== null
    if (hasQty === hasNotional) {
      throw new Error(api + ' 必须且只能给 qty 或 notional 其中一个')
    }
    if (hasQty) {
      const value = Number(qtyInput)
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(api + ' 的 qty 必须是大于 0 的数字，收到：' + JSON.stringify(String(qtyInput)))
      }
      return value
    }
    const value = Number(notional)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(api + ' 的 notional 必须是大于 0 的数字，收到：' + JSON.stringify(String(notional)))
    }
    const amount = value / submissionPrice()
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(api + ' 把 notional 折成数量失败：' + JSON.stringify(String(notional)))
    }
    return amount
  }

  function readReason(reason) {
    // SPEC §6.6：策略不填 reason 时统一记 'strategy'；引擎内部的 liquidation/end 自己写
    return reason === undefined || reason === null ? 'strategy' : String(reason)
  }

  function readWindowSize(n) {
    const size = Math.floor(Number(n))
    if (!Number.isFinite(size) || size < 1) {
      throw new Error('ctx.window/closes 的 n 必须是 >= 1 的整数，收到：' + JSON.stringify(String(n)))
    }
    return size
  }

  const ctx = {
    get index() {
      return currentIndex
    },
    get time() {
      // onStart 阶段还没有当前 K 线；如实返回 null，而不是假装某根 K 线的开盘时间
      return currentBar === null ? null : currentBar.t
    },
    get bar() {
      // 每次返回新副本：策略想给 bar 打标记随便改，不会污染引擎内部数据
      return currentBar === null ? null : copyBar(currentBar)
    },
    get config() {
      return configSnapshot
    },
    get params() {
      // 只读参数快照（SPEC §6.7）：策略不依赖 this，换成解构调用也不会丢参数
      return paramsSnapshot
    },
    get equity() {
      return currentBar === null ? initialCapital : equityAt(currentBar.c)
    },
    get cash() {
      return cash
    },
    get position() {
      return positionSnapshot()
    },

    /** 最近 n 根 K 线（含当前），返回副本，绝不包含未来。 */
    window(n) {
      const size = readWindowSize(n)
      if (currentIndex < 0) return []
      const from = Math.max(0, currentIndex - size + 1)
      return bars.slice(from, currentIndex + 1).map(copyBar)
    },

    /** 最近 n 个收盘价（含当前），返回副本。 */
    closes(n) {
      const size = readWindowSize(n)
      if (currentIndex < 0) return []
      const from = Math.max(0, currentIndex - size + 1)
      return bars.slice(from, currentIndex + 1).map((bar) => bar.c)
    },

    log(message) {
      // onStart 时还没有当前 bar，日志时间标成第一根开盘时间（保持日志时间戳是毫秒数）
      addLog(currentBar === null ? bars[0].t : currentBar.t, message)
    },

    /** 目标仓位：side=long/short/flat，weight∈[0,1]（flat 等价 weight=0），下一根开盘按权益换算。 */
    target(order = {}) {
      requireCanOrder('ctx.target')
      const { side, weight, reason } = order
      if (side !== 'long' && side !== 'short' && side !== 'flat') {
        throw new Error("ctx.target 的 side 只能是 'long' / 'short' / 'flat'，收到：" + JSON.stringify(side))
      }
      let finalWeight = 0
      if (side !== 'flat') {
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) {
          throw new Error('ctx.target 的 weight 必须是 0–1 之间的数字（side=' + side + '），收到：' + JSON.stringify(weight))
        }
        finalWeight = weight
      }
      marketQueue.push({ type: 'target', side, weight: finalWeight, reason: readReason(reason) })
    },

    /** 市价单：qty 直接给数量；notional 在提交时按当前收盘价折成数量并固定。 */
    market(order = {}) {
      requireCanOrder('ctx.market')
      const { side, qty: qtyInput, notional, reason } = order
      if (side !== 'buy' && side !== 'sell') {
        throw new Error("ctx.market 的 side 只能是 'buy' / 'sell'，收到：" + JSON.stringify(side))
      }
      const amount = readOrderQty(qtyInput, notional, 'ctx.market')
      marketQueue.push({ type: 'market', side, qty: amount, reason: readReason(reason) })
    },

    /** 限价单：下一根起参与撮合，成交价 = 限价，maker。返回 id 供 cancel 用。 */
    limit(order = {}) {
      requireCanOrder('ctx.limit')
      const { side, price, qty: qtyInput, notional, reduceOnly = false, reason } = order
      if (side !== 'buy' && side !== 'sell') {
        throw new Error("ctx.limit 的 side 只能是 'buy' / 'sell'，收到：" + JSON.stringify(side))
      }
      const limitPrice = Number(price)
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
        throw new Error('ctx.limit 的 price 必须是大于 0 的数字，收到：' + JSON.stringify(String(price)))
      }
      if (typeof reduceOnly !== 'boolean') {
        throw new Error('ctx.limit 的 reduceOnly 只能是 true/false，收到：' + JSON.stringify(reduceOnly))
      }
      let amount = readOrderQty(qtyInput, notional, 'ctx.limit')
      const id = nextOrderId
      nextOrderId += 1

      if (reduceOnly) {
        const canReduce = (side === 'buy' && qty < 0) || (side === 'sell' && qty > 0)
        // 没有可减的持仓：直接作废（不报错），但 id 照样返回，调用方可以无脑 cancel
        if (!canReduce) return id
        // SPEC §6.3：reduceOnly 数量不超过当前持仓（超出部分不会变成反向开仓）
        amount = Math.min(amount, Math.abs(qty))
        if (!(amount > QTY_EPS)) return id
      }

      limitOrders.push({
        type: 'limit',
        id,
        side,
        price: limitPrice,
        qty: amount,
        reduceOnly,
        reason: readReason(reason),
      })
      return id
    },

    cancel(id) {
      const index = limitOrders.findIndex((order) => order.id === id)
      if (index < 0) return false
      limitOrders.splice(index, 1)
      return true
    },

    cancelAll() {
      const count = limitOrders.length
      limitOrders = []
      return count
    },
  }

  // ==========================================================================
  // 主循环（SPEC §6.1 的顺序，别调换）
  // ==========================================================================

  // onStart：第 0 根 K 线之前。这里下的单排到第 1 根（第 0 根只做盯市和 onBar）
  if (typeof strategy.onStart === 'function') {
    phase = 'start'
    currentIndex = -1
    currentBar = null
    strategy.onStart(ctx)
  }

  for (let i = 0; i < barCount; i += 1) {
    currentIndex = i
    currentBar = bars[i]

    if (i > 0) {
      // 1) 上一根收盘排队的市价单 / 目标仓单：本根开盘价 + 滑点，taker
      const queued = marketQueue.splice(0, marketQueue.length)
      for (const order of queued) executeMarketOrder(order, currentBar, i)

      // 2) 活跃限价单：本根 high/low + limitFill 判定，成交价 = 限价，maker
      executeLimitOrders(currentBar, i)

      // 3) 爆仓检查：本根不利极值 vs 爆仓价
      checkLiquidation(currentBar, i)
    }

    // 3.5) 资金费率结算：只结算落在本根区间 [t, t+barMs) 内的点。
    //      用当根收盘价近似结算时刻的标记价（引擎没有逐笔标记价，见文件头 §6）。
    settleFunding(currentBar)

    // 4) 收盘盯市：每根 K 线收盘后一个点（equityCurve 长度 === bars 长度）
    equityCurve.push({
      t: currentBar.t,
      equity: equityAt(currentBar.c),
      cash,
      qty,
      price: currentBar.c,
    })

    // 5) 策略回调：这里下的单进队列，下一根才可能成交 → 天然防未来函数
    phase = 'bar'
    strategy.onBar(ctx, copyBar(currentBar), i)
  }

  // ==========================================================================
  // 收尾
  // ==========================================================================

  // 先做期末平仓，再调 onEnd：onEnd 是策略的「收尾」钩子，应该看到按回测规则处理完的
  // 最终状态（仓位已平、ctx.equity === finalEquity），而不是还挂着一个马上要被强平的仓位。
  currentIndex = barCount - 1
  currentBar = bars[barCount - 1]

  // closeAtEnd：最后一根收盘后按收盘价强制平仓（taker），保证最终权益 = 已实现现金
  if (cfg.closeAtEnd && qty !== 0) {
    const lastBar = bars[barCount - 1]
    applyFill({
      t: lastBar.t,
      index: barCount - 1,
      side: qty > 0 ? 'sell' : 'buy',
      qty: Math.abs(qty),
      price: lastBar.c,
      feeKind: 'taker',
      kind: 'market',
      reason: 'end',
    })
    // 期末平仓后最后一点要反映"已实现"的权益/现金，否则 equityCurve 最后一点还挂着持仓
    const lastPoint = equityCurve[equityCurve.length - 1]
    lastPoint.equity = cash
    lastPoint.cash = cash
    lastPoint.qty = 0
  }

  // 到期末还没成交的委托直接丢弃（记一条日志，方便排查"为什么策略没成交"）
  const pendingCount = marketQueue.length + limitOrders.length
  if (pendingCount > 0) {
    addLog(bars[barCount - 1].t, '回测结束，丢弃 ' + pendingCount + ' 张未成交委托')
  }

  if (typeof strategy.onEnd === 'function') {
    phase = 'end'
    strategy.onEnd(ctx)
  }

  finalizeLogs()

  return {
    ok: true,
    // SPEC §4.1：config 原样带上（报告要用它展示标的/周期/杠杆/费率）
    config: input.config,
    strategy: { name: strategyName, params: strategyParams },
    range: {
      start: cfg.start,
      end: cfg.end,
      bars: barCount,
      firstT: bars[0].t,
      lastT: bars[barCount - 1].t,
    },
    initialEquity: initialCapital,
    // 期末平仓后就是现金；closeAtEnd=false 时按最后一根收盘价盯市
    finalEquity: equityAt(bars[barCount - 1].c),
    equityCurve,
    fills,
    trades,
    fees: {
      maker: makerFees,
      taker: takerFees,
      total: makerFees + takerFees,
      count: fills.length,
    },
    // 资金费率（SPEC §4.1 追加字段）：total 为净支出（正=付出，负=收到）
    funding: {
      total: fundingPaid - fundingReceived,
      paid: fundingPaid,
      received: fundingReceived,
      count: fundingEvents.length,
      events: fundingEvents,
      meta: fundingMeta,
    },
    liquidations,
    rejected,
    logs,
  }
}

/**
 * 校验/归一化资金费率结算点：`[{ t, rate }]`。非法条目直接丢弃（数据源问题不该中断回测），
 * 返回按 t 升序的新数组。funding 为 null/undefined 视为「无资金费率」。
 */
function normalizeFunding(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('funding 必须是数组（[{ t, rate }]）')
  const byTime = new Map()
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const t = Number(item.t)
    const rate = Number(item.rate)
    if (!Number.isFinite(t) || !Number.isFinite(rate)) continue
    byTime.set(t, rate)
  }
  return Array.from(byTime.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([t, rate]) => ({ t, rate }))
}

// ============================================================================
// 输入校验 / 归一化（引擎假定 config 来自 normalizeConfig，但对缺字段做防御性回退）
// ============================================================================

/** bar 的只读副本（策略最多能改副本）。 */
function copyBar(bar) {
  return { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }
}

/**
 * 校验并归一化 K 线：形状、数值、升序、OHLC 自洽。
 * 返回新的 bar 数组（不引用调用方的对象，避免策略/调用方改数据影响回测）。
 */
function validateBars(raw) {
  if (!Array.isArray(raw)) throw new Error('缺少 K 线数据：bars 必须是数组')
  if (raw.length === 0) throw new Error('没有可回测的 K 线：bars 为空')

  const out = new Array(raw.length)
  let prevT = -Infinity
  for (let i = 0; i < raw.length; i += 1) {
    const bar = raw[i]
    if (bar === null || typeof bar !== 'object' || Array.isArray(bar)) {
      throw new Error('第 ' + i + ' 根 K 线不是对象：' + JSON.stringify(bar))
    }
    const t = Number(bar.t)
    const open = Number(bar.o)
    const high = Number(bar.h)
    const low = Number(bar.l)
    const close = Number(bar.c)
    const volume = bar.v === undefined ? 0 : Number(bar.v)
    if (!Number.isFinite(t) || !Number.isFinite(open) || !Number.isFinite(high)
      || !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)) {
      throw new Error('第 ' + i + ' 根 K 线含非法数字：' + JSON.stringify(bar))
    }
    if (!(t > prevT)) {
      throw new Error('K 线必须按时间升序且不重复（第 ' + i + ' 根 t=' + t + '，上一根 t=' + prevT + '）')
    }
    if (!(open > 0 && high > 0 && low > 0 && close > 0)) {
      throw new Error('第 ' + i + ' 根 K 线的价格必须大于 0：' + JSON.stringify(bar))
    }
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error('第 ' + i + ' 根 K 线的 high/low 与 open/close 不自洽：' + JSON.stringify(bar))
    }
    out[i] = { t, o: open, h: high, l: low, c: close, v: volume }
    prevT = t
  }
  return out
}

/** 校验策略对象（兼容普通对象，但至少要能 onBar）。 */
function validateStrategy(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('缺少策略：strategy 必须是带 onBar(ctx, bar, index) 的策略对象')
  }
  if (typeof raw.onBar !== 'function') {
    throw new Error('策略缺少 onBar(ctx, bar, index) 函数')
  }
  for (const hook of ['onStart', 'onEnd']) {
    if (raw[hook] !== undefined && typeof raw[hook] !== 'function') {
      throw new Error('策略的 ' + hook + ' 必须是函数')
    }
  }
  return raw
}

/** 数值型配置：缺省回退 config.mjs 的默认值（引擎不硬编码默认值），非法数字抛中文错误。 */
function readConfigNumber(raw, fallback, label) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error('回测配置的' + label + '不是合法数字：' + JSON.stringify(String(raw)))
  }
  return value
}

/**
 * 校验配置并派生引擎内部要用的值。
 * 正常路径下 config 来自 normalizeConfig（字段齐全）；这里的回退只为容错，不改变 result.config。
 */
function resolveConfig(raw, bars) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('回测配置必须是对象（应来自 config.normalizeConfig）')
  }

  const barId = raw.bar === undefined || raw.bar === '' ? DEFAULT_BAR : String(raw.bar)
  const barMs = barById(barId).ms // 未知周期在这里抛中文错误
  const firstT = bars[0].t
  const lastT = bars[bars.length - 1].t

  const initialCapital = readConfigNumber(raw.initialCapital, DEFAULT_CAPITAL, '初始资金')
  if (!(initialCapital > 0)) {
    throw new Error('回测配置的初始资金必须大于 0，收到：' + String(raw.initialCapital))
  }

  const leverage = readConfigNumber(raw.leverage, DEFAULT_LEVERAGE, '杠杆')
  if (!(leverage >= 1)) {
    throw new Error('回测配置的杠杆必须 >= 1，收到：' + String(raw.leverage))
  }

  const makerFeeRate = readConfigNumber(raw.makerFeeRate, DEFAULT_MAKER_FEE_RATE, '挂单手续费率')
  if (!(makerFeeRate >= 0 && makerFeeRate < 1)) {
    throw new Error('回测配置的挂单手续费率必须在 0–100% 之间，收到：' + String(raw.makerFeeRate))
  }

  const takerFeeRate = readConfigNumber(raw.takerFeeRate, DEFAULT_TAKER_FEE_RATE, '吃单手续费率')
  if (!(takerFeeRate >= 0 && takerFeeRate < 1)) {
    throw new Error('回测配置的吃单手续费率必须在 0–100% 之间，收到：' + String(raw.takerFeeRate))
  }

  const slippageBps = readConfigNumber(raw.slippageBps, 0, '滑点')
  if (!(slippageBps >= 0)) {
    throw new Error('回测配置的滑点必须 >= 0 基点，收到：' + String(raw.slippageBps))
  }

  const maintenanceMarginRate = readConfigNumber(
    raw.maintenanceMarginRate,
    DEFAULT_MAINTENANCE_MARGIN_RATE,
    '维持保证金率',
  )
  if (!(maintenanceMarginRate >= 0 && maintenanceMarginRate < 1)) {
    throw new Error('回测配置的维持保证金率必须在 0–100% 之间，收到：' + String(raw.maintenanceMarginRate))
  }

  const limitFill = raw.limitFill === undefined || raw.limitFill === '' ? 'tradeThrough' : String(raw.limitFill)
  if (limitFill !== 'tradeThrough' && limitFill !== 'touch') {
    throw new Error('回测配置的 limitFill 只能是 tradeThrough / touch，收到：' + JSON.stringify(limitFill))
  }

  const closeAtEnd = raw.closeAtEnd === undefined ? true : raw.closeAtEnd
  if (typeof closeAtEnd !== 'boolean') {
    throw new Error('回测配置的 closeAtEnd 只能是 true/false，收到：' + JSON.stringify(closeAtEnd))
  }

  // 资金费率开关：缺省开启（有 funding 数据才真正结算）；显式 false 时忽略 input.funding
  const includeFunding = raw.includeFunding === undefined ? true : raw.includeFunding
  if (typeof includeFunding !== 'boolean') {
    throw new Error('回测配置的 includeFunding 只能是 true/false，收到：' + JSON.stringify(includeFunding))
  }

  const start = raw.start === undefined || raw.start === null ? firstT : Number(raw.start)
  const end = raw.end === undefined || raw.end === null ? lastT + barMs : Number(raw.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('回测配置的时间范围 start/end 必须是毫秒时间戳')
  }
  if (!(start < end)) {
    throw new Error('回测配置的时间范围必须 start < end（start=' + start + '，end=' + end + '）')
  }

  const instId = raw.instId === undefined || raw.instId === '' ? DEFAULT_INSTID : String(raw.instId)

  return {
    instId,
    bar: barId,
    barMs,
    start,
    end,
    initialCapital,
    leverage,
    makerFeeRate,
    takerFeeRate,
    slippageBps,
    maintenanceMarginRate,
    limitFill,
    closeAtEnd,
    includeFunding,
  }
}
