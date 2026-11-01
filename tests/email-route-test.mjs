/**
 * 离线验 `/dsh-btc/email` 与 `/dsh-btc/notify-email` 的**路由逻辑**
 * （不启动 webServer，直接调 apply 注册的 handler；不发真邮件）。
 *
 * 为什么需要它：
 * 1. 界面上"填了地址、点了开启、地址却丢了、按钮也没变绿"这类问题，有一半可能是
 *    **运行中的宿主还在跑旧代码**。`/health` 的 `version` 现在是 package.json 的
 *    构建指纹，配这个测试就能把"代码错"和"宿主没重启"彻底分开。
 * 2. 这里还复现了 webserver 的真实路由语义：`register()` 对重复的 (kind, path)
 *    **抛错**（webserver/src/index.ts:169）。以前我的注册不是幂等的，插件重载时
 *    新实例注册第一条路由就中断，**后面所有路由一条都注册不上**，而旧实例还在应答
 *    —— 表现就是"改完代码重启了，行为却完全没变"。真踩过，卡了很多轮。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const STATE = join(ROOT, '.dashboard', 'state.json')
const BACKUP = join(ROOT, '.dashboard', 'state.json.route-test-backup')
const EMAIL = '/dsh-btc/email'
const NOTIFY = '/dsh-btc/notify-email'

let failed = 0
const check = (ok, label, detail) => {
  if (ok) console.log('ok   ' + label + (detail === undefined ? '' : '  ' + detail))
  else { failed += 1; console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + detail)) }
}

const mod = await import('../plugin/dsh-btc-dashboard/index.js')
console.log('===== 预警邮件路由（离线，不发信）=====')
console.log('    代码指纹 version = ' + String(mod.version))

/**
 * 收集 apply() 注册的路由。
 * `exact` 是共享的"已注册路由表"，可以传入一个已有的表，
 * 用来模拟"上一份插件实例的路由还占着"。
 */
function makeHost(options) {
  const opts = options || {}
  const routes = new Map()
  const sends = []
  /** apply() 里有一个每秒重试绑定的定时器；测试跑完要清掉，否则 Node 不退出 */
  const disposers = []
  const exact = opts.exact === undefined ? new Map() : opts.exact
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: (name) => {
      if (name === 'webServer') {
        return {
          register: (spec) => {
            if (exact.has(spec.path)) throw new Error('webserver: duplicate exact route "' + spec.path + '"')
            exact.set(spec.path, spec.handler)
            const list = routes.get(spec.path) === undefined ? [] : routes.get(spec.path)
            list.push(spec.handler)
            routes.set(spec.path, list)
            return () => { exact.delete(spec.path) }
          },
        }
      }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'qqEmail') {
        // 假的发信服务：只记录调用，绝不真的发信
        if (opts.noService === true) return undefined
        return {
          send: (request, sendOptions) => {
            sends.push({ request, sendOptions })
            return Promise.resolve({ queued: true, to: request.to, subject: request.subject, from: 'me@qq.com' })
          },
        }
      }
      return null
    },
  }
  mod.apply(ctx)
  const handlerAt = (path, index) => {
    const list = routes.get(path)
    if (list === undefined || list.length <= index) return undefined
    return list[index]
  }
  const dispose = () => {
    for (const one of disposers) if (typeof one === 'function') one()
    disposers.length = 0
  }
  return { routes, sends, handlerAt, dispose, exact }
}

/** 造一个够用的 req/res，跑一次 handler 并拿回 JSON。 */
function callHandler(handler, options) {
  const opts = options || {}
  const method = opts.method === undefined ? 'GET' : opts.method
  const body = opts.body === undefined ? '' : opts.body
  const url = opts.url === undefined ? '/' : opts.url
  const listeners = {}
  const req = {
    method,
    url,
    on: (event, fn) => { listeners[event] = fn; return req },
  }
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })
  const res = {
    statusCode: 200,
    headers: null,
    writeHead: (code, headers) => { res.statusCode = code; res.headers = headers },
    end: (text) => { resolveDone(text === undefined ? '' : String(text)) },
  }
  const promise = Promise.resolve(handler(req, res)).then(() => done)
  setTimeout(() => {
    if (typeof listeners.data === 'function' && body !== '') listeners.data(Buffer.from(body, 'utf8'))
    if (typeof listeners.end === 'function') listeners.end()
  }, 0)
  return promise.then((text) => {
    let parsed = null
    try { parsed = JSON.parse(text) } catch (error) { parsed = null }
    return { status: res.statusCode, parsed, text }
  })
}

mkdirSync(dirname(STATE), { recursive: true })
let previousState = null
try { previousState = readFileSync(STATE, 'utf8') } catch (error) { previousState = null }

/** 需要卸载的 effect（apply() 的每秒绑定定时器），finally 里统一清 */
const disposers = []
try {
  const host = makeHost()
  disposers.push(host.dispose)
  const { routes, sends, handlerAt } = host

  check(routes.has(EMAIL), '注册了 ' + EMAIL + ' 路由')
  // `/email` 是**一个** handler 内按 method 分支（GET 读 / POST 写）：
  // webserver 同一 (kind, path) 只能有一条路由，声明两次会让 POST 被 GET 接走。
  check((routes.get(EMAIL) || []).length === 1,
    'email 只有一条路由（内部按 method 分支）',
    String((routes.get(EMAIL) || []).length))
  const post = handlerAt(EMAIL, 0)
  const get = handlerAt(EMAIL, 0)

  console.log('\n--- 1) 授权闸门 ---')
  writeFileSync(STATE, JSON.stringify({ env: 'prod', bar: '1m' }, null, 1), 'utf8')
  const r1 = await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: true, to: 'me@qq.com', confirm: false }),
  })
  check(r1.status === 200, 'POST 返回 200', String(r1.status))
  check(r1.parsed !== null && r1.parsed.needsConfirm === true,
    '开启但没带 confirm 时回 needsConfirm:true',
    JSON.stringify(r1.parsed === null ? r1.text : r1.parsed.error))
  const after1 = JSON.parse(readFileSync(STATE, 'utf8'))
  check(after1.email === undefined || after1.email.enabled !== true,
    '没确认时不会把 enabled 写成 true', JSON.stringify(after1.email))

  console.log('\n--- 2) 带 confirm 保存 ---')
  const r2 = await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: true, to: 'me@qq.com', confirm: true }),
  })
  check(r2.parsed !== null && r2.parsed.ok === true, '保存成功',
    JSON.stringify(r2.parsed === null ? r2.text : r2.parsed.email))
  check(r2.parsed !== null && r2.parsed.email.enabled === true, '返回 enabled:true')
  check(r2.parsed !== null && r2.parsed.email.to === 'me@qq.com',
    '返回里带着地址（界面靠它回填）', JSON.stringify(r2.parsed === null ? '' : r2.parsed.email.to))
  check(r2.parsed !== null && r2.parsed.email.authorized === true,
    '返回 authorized:true（按钮该变绿）')
  check(r2.parsed !== null && r2.parsed.email.lastSentAt === null,
    '从没发过时 lastSentAt 是 null（不是 0）',
    JSON.stringify(r2.parsed === null ? '' : r2.parsed.email.lastSentAt))
  const disk2 = JSON.parse(readFileSync(STATE, 'utf8'))
  check(disk2.email !== undefined && disk2.email.enabled === true && disk2.email.to === 'me@qq.com',
    '真的写到 state.json 了', JSON.stringify(disk2.email))

  console.log('\n--- 3) 关闭不清空地址 ---')
  const r3 = await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: false, confirm: false }),
  })
  check(r3.parsed !== null && r3.parsed.email.enabled === false, '关闭成功')
  check(r3.parsed !== null && r3.parsed.email.to === 'me@qq.com',
    '关闭时地址保留（关闭不等于清空）', JSON.stringify(r3.parsed === null ? '' : r3.parsed.email.to))
  const disk3 = JSON.parse(readFileSync(STATE, 'utf8'))
  check(disk3.email !== undefined && disk3.email.to === 'me@qq.com' && disk3.email.enabled === false,
    '磁盘上也是"关着但留着地址"', JSON.stringify(disk3.email))

  console.log('\n--- 4) 地址改过 → 授权失效 → 重新确认 ---')
  const r4 = await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: false, to: 'changed@qq.com', confirm: false }),
  })
  check(r4.parsed !== null && r4.parsed.email.to === 'changed@qq.com', '能保存新地址')
  check(r4.parsed !== null && r4.parsed.email.authorized === false,
    '地址变过时 authorized:false（按钮回到"开启邮件提醒"）',
    JSON.stringify(r4.parsed === null ? '' : r4.parsed.email.authorized))
  const r5 = await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: true, to: 'changed@qq.com', confirm: true }),
  })
  check(r5.parsed !== null && r5.parsed.email.authorized === true,
    '重新确认后 authorized 回到 true（按钮变绿）')

  console.log('\n--- 5) 入参校验 / 读接口 ---')
  const r6 = await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: true, to: 'not-an-email', confirm: true }),
  })
  check(r6.parsed !== null && r6.parsed.ok === false, '非法地址被拒',
    JSON.stringify(r6.parsed === null ? r6.text : r6.parsed.error))
  const rBad = await callHandler(post, { method: 'POST', url: EMAIL, body: 'this-is-not-json' })
  check(rBad.parsed !== null && rBad.parsed.ok === false
    && String(rBad.parsed.error).indexOf('JSON') >= 0,
  '非法 JSON 被拒（旧代码在这里会返回 ok:true）',
  JSON.stringify(rBad.parsed === null ? rBad.text : rBad.parsed.error))
  const r7 = await callHandler(get, { method: 'GET', url: EMAIL })
  check(r7.parsed !== null && r7.parsed.ok === true && r7.parsed.email !== undefined,
    'GET 能读回配置')
  check(r7.parsed !== null && r7.parsed.email.lastSentAt === null,
    'GET 回来的 lastSentAt 也是 null')

  console.log('\n--- 6) 发信门禁 ---')
  check(routes.has(NOTIFY), '注册了 ' + NOTIFY + ' 路由')
  const notify = handlerAt(NOTIFY, 0)
  await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: false, confirm: false }),
  })
  const n1 = await callHandler(notify, {
    method: 'POST', url: NOTIFY, body: JSON.stringify({ test: true }),
  })
  check(n1.parsed !== null && n1.parsed.ok === false && n1.parsed.skipped === 'disabled',
    '没开邮件提醒时发信被跳过', JSON.stringify(n1.parsed))
  check(sends.length === 0, '没开时一次都没调发信服务', String(sends.length))

  console.log('\n--- 7) 开着 + 已确认 → 测试邮件走到发信服务 ---')
  await callHandler(post, {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: true, to: 'me@qq.com', confirm: true }),
  })
  const n2 = await callHandler(notify, {
    method: 'POST', url: NOTIFY, body: JSON.stringify({ test: true }),
  })
  check(n2.parsed !== null && n2.parsed.ok === true, '测试邮件发得出去', JSON.stringify(n2.parsed))
  check(sends.length === 1, '真的调了 qqEmail.send 一次', String(sends.length))
  check(sends.length > 0 && sends[0].request.to.join(',') === 'me@qq.com',
    '发往已确认的地址', JSON.stringify(sends.length > 0 ? sends[0].request.to : null))
  check(sends.length > 0 && sends[0].sendOptions.confirmedByCaller === true,
    '走 confirmedByCaller（宿主没有 agent/turn，只能走这条）',
    JSON.stringify(sends.length > 0 ? sends[0].sendOptions.confirmedByCaller : null))
  check(sends.length > 0 && String(sends[0].request.subject).indexOf('BTC') >= 0,
    '测试邮件主题带 BTC', sends.length > 0 ? sends[0].request.subject : '')
  check(sends.length > 0 && String(sends[0].request.body).indexOf('触发那根 K 线') >= 0,
    '测试邮件正文含"触发那根 K 线"（与真实预警同一组装路径）',
    sends.length > 0 ? String(sends[0].request.body).length + ' 字符' : '')

  console.log('\n--- 8) 没装 dsh-qq-email 时 ---')
  const bare = makeHost({ noService: true })
  disposers.push(bare.dispose)
  writeFileSync(STATE, JSON.stringify({ env: 'prod', bar: '1m' }, null, 1), 'utf8')
  const b1 = await callHandler(bare.handlerAt(EMAIL, 0), {
    method: 'POST', url: EMAIL,
    body: JSON.stringify({ enabled: true, to: 'me@qq.com', confirm: true }),
  })
  check(b1.parsed !== null && b1.parsed.ok === false
    && String(b1.parsed.error).indexOf('qqEmail') >= 0,
  '没有 qqEmail 服务时明确报错（不假装成功）',
  JSON.stringify(b1.parsed === null ? b1.text : b1.parsed.error))
  const b2 = await callHandler(bare.handlerAt(EMAIL, 0), { method: 'GET', url: EMAIL })
  check(b2.parsed !== null && b2.parsed.email.available === false,
    'GET 里 available:false（界面据此给可执行的提示）',
    JSON.stringify(b2.parsed === null ? b2.text : b2.parsed.email.available))

  console.log('\n--- 9) 路由注册容错（重载 / 陈旧占用）---')
  const shared = new Map()
  const first = makeHost({ exact: shared })
  disposers.push(first.dispose)
  check((first.routes.get(EMAIL) || []).length === 1,
    '第一份实例：email 一条路由占住', String((first.routes.get(EMAIL) || []).length))
  check(shared.has(EMAIL) && shared.has(NOTIFY), 'shared 表里 email 与 notify-email 都在',
    JSON.stringify([...shared.keys()]))

  // 9b) 同一个 server 上再 apply 一次（模拟重载）：新实例要能接管
  const reloaded = makeHost({ exact: shared })
  disposers.push(reloaded.dispose)
  check(shared.has(EMAIL) && shared.has(NOTIFY), '重载后路由仍在（新实例接管）')

  // 9c) 有"陈旧实例"占着路由时：新代码不能整片失败
  const stale = new Map()
  stale.set('/dsh-btc/board', () => { throw new Error('陈旧 handler 不该被调用') })
  stale.set(EMAIL, () => { throw new Error('陈旧 handler 不该被调用') })
  const fresh = makeHost({ exact: stale })
  disposers.push(fresh.dispose)
  // 关键点：即使 board/email 被陈旧占用，**后面的路由也必须注册上**
  check(stale.has(NOTIFY), '被陈旧占用时，后面的 notify-email 仍然注册成功',
    JSON.stringify([...stale.keys()]))
  const n9 = await callHandler(fresh.handlerAt(NOTIFY, 0), {
    method: 'POST', url: NOTIFY, body: JSON.stringify({ test: true }),
  })
  check(n9.parsed !== null, 'notify-email 可用（返回了 JSON）',
    JSON.stringify(n9.parsed === null ? n9.text.slice(0, 80) : Object.keys(n9.parsed)))
} finally {
  // 卸载 apply() 注册的 effect（那个每秒重试绑定的定时器会吊住进程）
  for (const one of disposers) if (typeof one === 'function') one()
  // 还原状态文件：测试不该留下痕迹
  if (previousState === null) rmSync(STATE, { force: true })
  else writeFileSync(STATE, previousState, 'utf8')
  rmSync(BACKUP, { force: true })
}

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
// 显式退出：即使还有没清理干净的句柄，也不要让 CI / 脚本挂住
process.exit(failed === 0 ? 0 : 1)
