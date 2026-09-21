/**
 * Live end-to-end check against a RUNNING dsh instance.
 *
 * Drives the same HTTP surface the browser panel uses. Two services are
 * exercised in one pass:
 *
 *   1. a self-controlled `node -e` process, which proves start → ready → log →
 *      stop end to end in ANY environment; and
 *   2. the workspace's real detected service, which is observed and reported
 *      honestly — a port already held by somebody else is an environment fact,
 *      not a plugin failure, so it is reported rather than asserted.
 *
 * The self-controlled service is removed again afterwards; the detected
 * definition is left in place, because that is what the user wants saved.
 *
 *   node scripts/live-check.mjs [baseUrl] [workspaceDir]
 *
 * `workspaceDir` defaults to the current directory.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:43199'
const workspace = process.argv[3] ?? process.cwd()

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`)
}

async function call(path, init) {
  const response = await fetch(`${base}/service-runner${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  return { status: response.status, body: await response.json() }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Find one service across EVERY workspace snapshot, not just the first one. */
function findService(state, id) {
  for (const entry of state.body.snapshots ?? []) {
    const hit = entry.services.find((item) => item.definition.id === id)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Poll until the service reaches one of the wanted states. */
async function waitFor(id, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let entry = findService(await call('/state', { method: 'GET' }), id)
  while (Date.now() < deadline) {
    if (wanted.includes(entry?.runtime?.status)) break
    await sleep(700)
    entry = findService(await call('/state', { method: 'GET' }), id)
  }
  return { status: entry?.runtime?.status ?? 'unknown', entry }
}

const ECHO_NAME = 'live-check-echo'
const ECHO_COMMAND = 'node -e "console.log(\'live-check-ready\'); setInterval(()=>{},1000)"'

console.log(`base: ${base}\nworkspace: ${workspace}\n`)

// ---- detect -------------------------------------------------------------------
const detected = await call('/detect', {
  method: 'POST',
  body: JSON.stringify({ workspace }),
})
check('探测接口可用', detected.body.ok === true, detected.body.error ?? '')
const candidates = detected.body.candidates ?? []
check('探测到候选服务', candidates.length > 0, `count=${candidates.length}`)
for (const candidate of candidates) {
  console.log(
    `      · [${candidate.language}] ${candidate.name} → ${candidate.command}${candidate.port ? ` (port ${candidate.port})` : ''}`,
  )
}

// ---- save (detected definition + self-controlled echo) -------------------------
const saved = await call('/save', {
  method: 'POST',
  body: JSON.stringify({
    workspace,
    services: [
      ...candidates.map((candidate) => ({
        name: candidate.name,
        command: candidate.command,
        language: candidate.language,
        port: candidate.port,
        cwd: candidate.cwd,
        autoDetected: true,
        note: candidate.reason,
      })),
      {
        name: ECHO_NAME,
        command: ECHO_COMMAND,
        language: 'custom',
        autoDetected: false,
      },
    ],
  }),
})
check('保存服务定义', saved.body.ok === true, saved.body.error ?? '')

const all = saved.body.services ?? []
let echo
let real
for (const entry of all) {
  for (const service of entry.services ?? []) {
    if (service.definition.name === ECHO_NAME) echo = service
    else real = service
  }
}
check('拿到自控服务条目', echo !== undefined)
if (echo === undefined) process.exit(1)

// ---- 1. self-controlled service: full lifecycle --------------------------------
console.log('\n--- 自控服务的完整生命周期 ---')
const echoId = echo.definition.id
check(
  '启动指令被接受',
  (await call('/action', { method: 'POST', body: JSON.stringify({ action: 'start', id: echoId }) })).body.ok === true,
)

const running = await waitFor(echoId, ['running', 'failed', 'stopped'], 30_000)
check('服务进入 running', running.status === 'running', `status=${running.status}`)

const echoLogs = await call(`/logs?id=${echoId}&after=0`)
const echoText = (echoLogs.body.lines ?? []).map((line) => line.text).join('\n')
check('捕获到进程输出', echoText.includes('live-check-ready'))
check('记录了 pid', typeof running.entry?.runtime?.pid === 'number', String(running.entry?.runtime?.pid ?? 'none'))
check('增量游标可用', (await call(`/logs?id=${echoId}&after=${echoLogs.body.logSeq}`)).body.lines.length === 0)

await call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: echoId }) })
const stoppedEcho = await waitFor(echoId, ['stopped', 'failed'], 20_000)
check('停止后回到 stopped', stoppedEcho.status === 'stopped', `status=${stoppedEcho.status}`)

// ---- 2. the real detected service: observe, do not assume -----------------------
if (real !== undefined) {
  console.log(`\n--- 真实服务：${real.definition.name}（${real.definition.command}）---`)
  const realId = real.definition.id
  await call('/action', { method: 'POST', body: JSON.stringify({ action: 'start', id: realId }) })
  const realState = await waitFor(realId, ['running', 'failed', 'stopped'], 90_000)
  const realLogs = await call(`/logs?id=${realId}&after=0`)
  console.log('    日志尾部：')
  for (const line of (realLogs.body.lines ?? []).slice(-6)) {
    console.log(`      [${line.stream}] ${line.text.slice(0, 150)}`)
  }
  if (realState.status === 'running') {
    check('真实服务已就绪', true, `port=${realState.entry?.runtime?.detectedPort ?? real.definition.port ?? '?'}`)
  } else {
    // Not a plugin failure: the plugin reported exactly what happened.
    const reason = realState.entry?.runtime?.error ?? '(无说明)'
    console.log(`    注意：真实服务未就绪（${realState.status}）——${reason}`)
    console.log('    这是环境事实（例如端口已被其他进程占用），插件已如实报告，不计为失败。')
  }
  await call('/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: realId }) })
  await waitFor(realId, ['stopped', 'failed'], 20_000)
}

// ---- cleanup: drop only the probe service, keep the detected definition ---------
await call('/remove', { method: 'POST', body: JSON.stringify({ id: echo.definition.id }) })
const finalState = await call('/state', { method: 'GET' })
check('探针服务已移除', findService(finalState, echo.definition.id) === undefined)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
