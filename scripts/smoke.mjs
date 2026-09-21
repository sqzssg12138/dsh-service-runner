/**
 * Standalone smoke test for the host half.
 *
 * Runs the real Cordis plugin body against a stub context and a real HTTP
 * server, so route wiring, detection, persistence and the process lifecycle are
 * all exercised without installing the plugin into DSH. The service it starts is
 * a harmless `node -e` one-liner, never the user's actual dev server.
 *
 *   node scripts/smoke.mjs [workspaceDir]
 */
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the run hermetic: the store writes under DSH_HOME, so point it at a temp
// directory instead of the real profile data.
const sandbox = await mkdtemp(join(tmpdir(), 'dsr-smoke-'))
process.env.DSH_HOME = sandbox

// A port held by "somebody else" before the service starts, to prove the plugin
// no longer reports a stranger's listener as our own service being ready.
const SQUATTED_PORT = 45999
const squatter = createTcpServer()
await new Promise((resolve, reject) => {
  squatter.once('error', reject)
  squatter.listen(SQUATTED_PORT, '127.0.0.1', resolve)
})

const { apply } = await import('../lib/index.js')

const routes = []
/** @type {(() => void)[]} */
const disposers = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      const dispose = () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
  },
  get() {
    return undefined
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}

apply(ctx)

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const route = routes.find((entry) =>
    entry.kind === 'prefix' ? path.startsWith(entry.path) : path === entry.path,
  )
  if (route === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  void route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/service-runner`

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${label}${detail === undefined ? '' : `  ${detail}`}`)
}

async function call(path, init) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  return { status: response.status, body: await response.json() }
}

const workspace = process.argv[2] ?? process.cwd()

console.log(`workspace: ${workspace}\n`)

// 1. state with no workspace
const empty = await call('/state')
check('GET /state 返回 ok', empty.body.ok === true)
check('初始工作区为空', empty.body.workspace === null, JSON.stringify(empty.body.workspace))

// 2. detection over the real workspace
const detected = await call('/detect', {
  method: 'POST',
  body: JSON.stringify({ workspace }),
})
check('POST /detect 成功', detected.body.ok === true, detected.body.error ?? '')
check(
  '探测到至少一个候选服务',
  Array.isArray(detected.body.candidates) && detected.body.candidates.length > 0,
  `candidates=${detected.body.candidates?.length ?? 0}`,
)
for (const candidate of detected.body.candidates ?? []) {
  console.log(`      · [${candidate.language}] ${candidate.name} → ${candidate.command}${candidate.port ? ` (port ${candidate.port})` : ''}`)
}

// 3. save a controllable service + the detected ones
const echoName = 'smoke-echo'
const clashName = 'smoke-port-clash'
const orphanName = 'smoke-orphan'
/** Port the orphan case binds, and later proves was released. */
const ORPHAN_PORT = 45998

/** Whether something is listening on a port right now. */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(600, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Poll one service across every workspace snapshot until it settles. */
async function waitForService(id, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let entry
  while (Date.now() < deadline) {
    const state = await call('/state', { method: 'GET' })
    for (const workspace of state.body.snapshots ?? []) {
      const hit = workspace.services.find((item) => item.definition.id === id)
      if (hit !== undefined) entry = hit
    }
    if (wanted.includes(entry?.runtime?.status)) break
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return { status: entry?.runtime?.status ?? 'unknown', entry }
}
const definitions = [
  ...(detected.body.candidates ?? []).map((candidate) => ({
    name: candidate.name,
    command: candidate.command,
    language: candidate.language,
    port: candidate.port,
    cwd: candidate.cwd,
    autoDetected: true,
  })),
  {
    name: echoName,
    // Two levels deep on purpose: the wrapper spawns a grandchild, which is the
    // shape `pnpm run dev` → `vite` has. Stopping must take the whole tree down,
    // not just the shell — that is what the grandchild assertion below checks.
    command:
      'node -e "const{spawn}=require(\'child_process\');const c=spawn(process.execPath,[\'-e\',\'setInterval(()=>{},1000)\'],{stdio:\'ignore\'});console.log(\'dsr-ready-on-port\');console.log(\'dsr-grandchild=\'+c.pid);setInterval(()=>{},1000)"',
    language: 'custom',
    autoDetected: false,
  },
  {
    name: clashName,
    // Claims a port that is already taken, and never binds anything itself: the
    // plugin must not read the squatter's listener as this service being up.
    command: 'node -e "setInterval(()=>{},1000)"',
    language: 'custom',
    port: SQUATTED_PORT,
    autoDetected: false,
  },
  {
    name: orphanName,
    // Really binds a port, and gets its WRAPPER killed WITHOUT /T below: the
    // listener is then re-parented and unreachable by a tree walk — exactly the
    // leaked-dev-server case the port sweep exists for.
    command: `node -e "require('net').createServer().listen(${ORPHAN_PORT},'127.0.0.1');setInterval(()=>{},1000)"`,
    language: 'custom',
    port: ORPHAN_PORT,
    autoDetected: false,
  },
]
const saved = await call('/save', {
  method: 'POST',
  body: JSON.stringify({ workspace, services: definitions }),
})
check('POST /save 成功', saved.body.ok === true, saved.body.error ?? '')

const state = await call('/state', { })
check('保存后 state 有服务', (state.body.snapshots?.[0]?.services?.length ?? 0) === definitions.length,
  `count=${state.body.snapshots?.[0]?.services?.length ?? 0}`)

const echo = state.body.snapshots[0].services.find((entry) => entry.definition.name === echoName)
check('找到 smoke-echo 服务', echo !== undefined)
check('smoke-echo 初始为 stopped', echo?.runtime.status === 'stopped', echo?.runtime.status)

// 4. start it, then confirm the log buffer and (eventually) running state
const started = await call('/action', {
  method: 'POST',
  body: JSON.stringify({ action: 'start', id: echo.definition.id }),
})
check('POST /action start 成功', started.body.ok === true, started.body.error ?? '')

let running = false
let sawLog = false
let shellPid
let grandchildPid
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 400))
  const logs = await call(`/logs?id=${echo.definition.id}&after=0`)
  const text = (logs.body.lines ?? []).map((line) => line.text).join('\n')
  if (text.includes('dsr-ready-on-port')) sawLog = true
  const grandchild = /dsr-grandchild=(\d+)/.exec(text)
  if (grandchild !== null) grandchildPid = Number.parseInt(grandchild[1], 10)
  const current = await call('/state')
  const entry = current.body.snapshots[0].services.find((item) => item.definition.id === echo.definition.id)
  shellPid = entry?.runtime.pid
  if (entry?.runtime.status === 'running') {
    running = true
    break
  }
}
check('进程输出进入日志缓冲', sawLog)
check('进程状态变为 running', running)
check('记录了 shell 与孙进程 pid', shellPid !== undefined && grandchildPid !== undefined,
  `shell=${shellPid ?? '?'} grandchild=${grandchildPid ?? '?'}`)

// 5. incremental log cursor
const cursor = await call(`/logs?id=${echo.definition.id}&after=0`)
const after = await call(`/logs?id=${echo.definition.id}&after=${cursor.body.logSeq}`)
check('增量日志为空（已到末尾）', (after.body.lines ?? []).length === 0)
check('logSeq 单调不减', after.body.logSeq >= cursor.body.logSeq)

// Clearing drops the buffer but must NOT rewind `seq`, or every open panel's
// cursor would restart from zero and re-ingest lines it already has.
const clearedLogs = await call('/logs/clear', {
  method: 'POST',
  body: JSON.stringify({ id: echo.definition.id }),
})
check('POST /logs/clear 成功', clearedLogs.body.ok === true, clearedLogs.body.error ?? '')
const afterClearLogs = await call(`/logs?id=${echo.definition.id}&after=0`)
check('清空后没有历史行', (afterClearLogs.body.lines ?? []).length === 0)
check('清空后 logSeq 未回退', afterClearLogs.body.logSeq >= cursor.body.logSeq,
  `${afterClearLogs.body.logSeq} >= ${cursor.body.logSeq}`)
const clearMissing = await call('/logs/clear', { method: 'POST', body: JSON.stringify({ id: 'nope' }) })
check('清空不存在的服务返回 404', clearMissing.status === 404, String(clearMissing.status))

// 6. stop it
await call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: echo.definition.id }) })
let stopped = false
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  const current = await call('/state')
  const entry = current.body.snapshots[0].services.find((item) => item.definition.id === echo.definition.id)
  if (entry?.runtime.status === 'stopped') {
    stopped = true
    break
  }
}
check('停止后状态回到 stopped', stopped)

// The graceful path must actually be attempted (and reported), not silently
// skipped in favour of /F every time.
const stopText = ((await call(`/logs?id=${echo.definition.id}&after=0`)).body.lines ?? [])
  .map((line) => line.text)
  .join('\n')
check(
  '停止走的是温和优先路径',
  stopText.includes('温和停止请求生效') || stopText.includes('强制结束'),
  stopText
    .split('\n')
    .filter((text) => text.includes('退出') || text.includes('强制'))
    .join(' | ') || '(无相关日志)',
)

// The stop must take the WHOLE tree: a surviving grandchild is exactly the
// leaked-dev-server failure mode this plugin exists to prevent.
function alive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
for (let attempt = 0; attempt < 20 && (alive(shellPid) || alive(grandchildPid)); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300))
}
check('shell 进程已结束', !alive(shellPid), `pid=${shellPid ?? '?'}`)
check('孙进程也被清理（进程树 kill）', !alive(grandchildPid), `pid=${grandchildPid ?? '?'}`)

// 6b. A port that was already taken must never be reported as OUR readiness.
const clash = (await call('/state')).body.snapshots[0].services.find(
  (item) => item.definition.name === clashName,
)
check('找到 smoke-port-clash 服务', clash !== undefined)
const clashStart = await call('/action', {
  method: 'POST',
  body: JSON.stringify({ action: 'start', id: clash.definition.id }),
})
check('端口冲突服务可启动', clashStart.body.ok === true, clashStart.body.error ?? '')

let clashRunning = false
let clashLogs = ''
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 400))
  const logs = await call(`/logs?id=${clash.definition.id}&after=0`)
  clashLogs = (logs.body.lines ?? []).map((line) => line.text).join('\n')
  const entry = (await call('/state')).body.snapshots[0].services.find(
    (item) => item.definition.id === clash.definition.id,
  )
  if (entry?.runtime.status === 'running') {
    clashRunning = true
    break
  }
}
check('端口被占用时按进程存活判定 running', clashRunning)
check('日志说明端口在启动前已被占用', clashLogs.includes('在启动前已被占用'))
check('不再谎报「端口已就绪」', !clashLogs.includes(`端口 ${SQUATTED_PORT} 已就绪`))

const clashRuntime = (await call('/state')).body.snapshots[0].services.find(
  (item) => item.definition.id === clash.definition.id,
)?.runtime
check(
  '运行状态带「未经端口确认」提示',
  typeof clashRuntime?.error === 'string' && clashRuntime.error.includes('未经端口确认'),
  clashRuntime?.error ?? '(none)',
)

await call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: clash.definition.id }) })
let clashStopped = false
for (let attempt = 0; attempt < 15; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  const entry = (await call('/state')).body.snapshots[0].services.find(
    (item) => item.definition.id === clash.definition.id,
  )
  if (entry?.runtime.status === 'stopped') {
    clashStopped = true
    break
  }
}
check('端口冲突服务已停止', clashStopped)

// 6c. A listener that outlived its wrapper must be reaped by PORT: the tree is
//     gone, so only a port sweep can free it.
const orphan = (await call('/state')).body.snapshots
  .flatMap((entry) => entry.services)
  .find((item) => item.definition.name === orphanName)
check('找到 smoke-orphan 服务', orphan !== undefined)
await call('/action', { method: 'POST', body: JSON.stringify({ action: 'start', id: orphan.definition.id }) })
const orphanUp = await waitForService(orphan.definition.id, ['running', 'failed'], 25_000)
check('孤儿用例服务已就绪', orphanUp.status === 'running', `status=${orphanUp.status}`)
check('监听端口确实被占用', await portOpen(ORPHAN_PORT))

// Kill ONLY the wrapper (no /T) so the listener is re-parented and orphaned.
await new Promise((resolve) => {
  const killer = spawn('taskkill', ['/PID', String(orphanUp.entry?.runtime?.pid), '/F'], { windowsHide: true })
  killer.once('exit', resolve)
  killer.once('error', resolve)
})
await new Promise((resolve) => setTimeout(resolve, 1500))
check('外层被杀后监听者仍占着端口（已模拟出孤儿）', await portOpen(ORPHAN_PORT))

await call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: orphan.definition.id }) })
let reaped = false
for (let attempt = 0; attempt < 25; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 400))
  if (!(await portOpen(ORPHAN_PORT))) {
    reaped = true
    break
  }
}
check('停止后按端口回收了孤儿监听者', reaped)
const orphanLogs = (await call(`/logs?id=${orphan.definition.id}&after=0`)).body.lines ?? []
check(
  '日志记录了残留清理',
  orphanLogs.some((line) => line.text.includes('已清理占用端口')),
  orphanLogs.filter((line) => line.stream === 'system').map((line) => line.text).slice(-2).join(' | '),
)

// 6d. A stop racing a start must CANCEL it. start() awaits a port probe before
//     spawning, and without a run token a stop landing in that window set the
//     state to "stopped" while the process was started anyway — a live server
//     behind a stopped label. Repeated because the window is only a few ms.
let racedLive = 0
let racedStatus = 'unknown'
for (let round = 0; round < 5; round += 1) {
  await call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: orphan.definition.id }) })
  await new Promise((resolve) => setTimeout(resolve, 300))
  await Promise.all([
    call('/action', { method: 'POST', body: JSON.stringify({ action: 'start', id: orphan.definition.id }) }),
    call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: orphan.definition.id }) }),
  ])
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const entry = (await call('/state', { method: 'GET' })).body.snapshots
      .flatMap((workspace) => workspace.services)
      .find((item) => item.definition.id === orphan.definition.id)
    racedStatus = entry?.runtime.status ?? 'unknown'
    if (racedStatus === 'stopped' || racedStatus === 'failed') break
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
  if (await portOpen(ORPHAN_PORT)) racedLive += 1
  // Leave a clean slate for the next round.
  await call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: orphan.definition.id }) })
  await new Promise((resolve) => setTimeout(resolve, 500))
}
check('并发 start+stop 后状态回到 stopped', racedStatus === 'stopped', `status=${racedStatus}`)
check('被取消的启动没有留下监听进程', racedLive === 0, `5 轮中有 ${racedLive} 轮端口仍被占用`)

// 6e. Port inspection, and release that refuses to kill a stranger.
const ownerInfo = await call('/port-owner', { method: 'POST', body: JSON.stringify({ port: SQUATTED_PORT }) })
check(
  '能查到端口占用者',
  typeof ownerInfo.body.owner?.pid === 'number',
  JSON.stringify(ownerInfo.body.owner ?? null),
)
check(
  '占用者就是本测试进程',
  ownerInfo.body.owner?.pid === process.pid,
  `pid=${ownerInfo.body.owner?.pid} 期望 ${process.pid}`,
)
const freeOwner = await call('/port-owner', { method: 'POST', body: JSON.stringify({ port: 45997 }) })
check('空闲端口返回 null', freeOwner.body.owner === null, JSON.stringify(freeOwner.body.owner))

const wrongPid = await call('/port-release', {
  method: 'POST',
  body: JSON.stringify({ port: SQUATTED_PORT, pid: 999_999 }),
})
check('pid 不匹配时拒绝释放', wrongPid.body.ok === false, wrongPid.body.error ?? '')
check('拒绝之后端口仍然被占用', await portOpen(SQUATTED_PORT))
const badPort = await call('/port-owner', { method: 'POST', body: JSON.stringify({ port: 'abc' }) })
check('非法 port 被拒绝', badPort.status === 400, String(badPort.status))

// 7. remove
const removed = await call('/remove', { method: 'POST', body: JSON.stringify({ id: echo.definition.id }) })
check('POST /remove 成功', removed.body.ok === true, removed.body.error ?? '')

// 8. unknown route
const missing = await call('/nope')
check('未知路由返回 404', missing.status === 404, String(missing.status))

// 8b. Trust fence: cross-site callers must not be able to start or kill anything.
async function statusFor(headers) {
  const response = await fetch(`${base}/port-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ port: SQUATTED_PORT }),
  })
  return response.status
}
check('无 Origin 的本机调用放行', (await statusFor({})) === 200)
check(
  '跨站 Origin 被拒绝',
  (await statusFor({ origin: 'https://evil.example' })) === 403,
  String(await statusFor({ origin: 'https://evil.example' })),
)
check(
  'cross-site 标记被拒绝',
  (await statusFor({ 'sec-fetch-site': 'cross-site' })) === 403,
  String(await statusFor({ 'sec-fetch-site': 'cross-site' })),
)
check(
  '同源 Origin 放行',
  (await statusFor({ origin: `http://127.0.0.1:${new URL(base).port}` })) === 200,
  String(await statusFor({ origin: `http://127.0.0.1:${new URL(base).port}` })),
)

// `fetch` refuses to set a forbidden header like Host, so the Host fence needs
// the raw http client to be exercised at all.
function rawStatus(relativePath, headers, body = '{}') {
  const target = new URL(base)
  // `base` already carries the plugin prefix; the raw client needs it too.
  const path = `${target.pathname}${relativePath}`
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', () => resolve(0))
    req.end(body)
  })
}
check(
  '非回环 Host 被拒绝',
  (await rawStatus('/port-owner', { host: 'evil.example.com' })) === 403,
  String(await rawStatus('/port-owner', { host: 'evil.example.com' })),
)
check(
  '回环 Host 放行（到达路由；空 body 由参数校验挡下，说明未被围栏拦）',
  (await rawStatus('/port-owner', { host: `127.0.0.1:${new URL(base).port}` })) === 400,
  String(await rawStatus('/port-owner', { host: `127.0.0.1:${new URL(base).port}` })),
)

// 9. disposal stops everything (no orphans)
const before = routes.length
for (const dispose of disposers.splice(0)) dispose()
check('disposer 移除了路由', routes.length === 0 && before > 0, `routes=${routes.length}`)

server.close()
await new Promise((resolve) => squatter.close(resolve))
await rm(sandbox, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
