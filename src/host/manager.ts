/**
 * The process pool behind the panel.
 *
 * One entry per service definition, holding the live child process, the
 * lifecycle state and a bounded ring of log lines. Readiness is decided by the
 * port, not by a timer: a dev server that prints "ready in 300 ms" is still not
 * usable until something answers on its port, and a Java service that takes 40
 * seconds to boot must not be reported as failed at second five.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'

import { runCapture, runQuietly } from './run.ts'
import { dshHome } from './store.ts'

import type {
  LogLine,
  ServiceDefinition,
  ServiceRuntime,
  ServiceSnapshot,
  WorkspaceSnapshot,
} from './types.ts'

/** Log lines kept per service; older lines are dropped from the front. */
const MAX_LOG_LINES = 2000

/**
 * Exit codes that mean "stopped on purpose", for every service.
 *
 * `0` is always clean. The rest follow the conventions every supervisor in this
 * space implements — systemd's `SuccessExitStatus`, process-compose's
 * `success_exit_codes`: a signal-driven shutdown reports `128 + signal`
 * (130 = SIGINT, 143 = SIGTERM), and on Windows closing a console reports
 * `0xC000013A` (`STATUS_CONTROL_C_EXIT`) — exactly what a dev server sees when
 * its console window is closed. Reporting those as failures made a deliberate
 * stop look like a crash.
 */
const DEFAULT_SUCCESS_EXIT_CODES: readonly number[] = [130, 143, 3221225786]

/** Whether one exit code counts as a clean stop for this service. */
function isCleanExit(definition: ServiceDefinition, code: number): boolean {
  if (code === 0) return true
  if (DEFAULT_SUCCESS_EXIT_CODES.includes(code)) return true
  return definition.successExitCodes?.includes(code) === true
}

/**
 * One HTTP readiness probe.
 *
 * Any 2xx/3xx answer means ready — the same contract Kubernetes and
 * process-compose readiness probes use. A refused connection, a timeout or a
 * 5xx are all ordinary "not ready yet" answers, never exceptions.
 */
function httpProbe(rawUrl: string, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let target: URL
    try {
      target = new URL(rawUrl)
    } catch {
      finish(false)
      return
    }
    const send = target.protocol === 'https:' ? httpsGet : httpGet
    try {
      const request = send(target, (response) => {
        const status = response.statusCode ?? 0
        response.resume()
        finish(status >= 200 && status < 400)
      })
      request.setTimeout(timeoutMs, () => {
        request.destroy()
        finish(false)
      })
      request.on('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

/**
 * Expand `${...}` placeholders in a stored command line.
 *
 * Supported: `${workspace}` (absolute workspace root), `${cwd}` (resolved
 * working directory) and `${env:NAME}` (an environment variable). Placeholders
 * let one definition travel between machines, instead of hard-coding an absolute
 * path that only exists on the machine that wrote it.
 */
function expandCommand(definition: ServiceDefinition, cwd: string): string {
  if (!definition.command.includes('${')) return definition.command
  return definition.command.replace(
    /\$\{([a-zA-Z]+)(?::([^}]*))?\}/g,
    (whole, kind: string, arg: string | undefined) => {
      if (kind === 'workspace') return definition.workspace
      if (kind === 'cwd') return cwd
      if (kind === 'env') return arg === undefined ? '' : (process.env[arg] ?? '')
      return whole
    },
  )
}

/**
 * Warn when a command would be executed by the harness's own Electron shims.
 *
 * In this harness `node`, `npm` and `pnpm` are Electron binaries with no console
 * of their own; a console child spawned underneath one of them makes Windows
 * allocate a fresh **visible** console window, and closing that window kills the
 * service with `0xC000013A`. Detection already avoids this for known dev tools,
 * so this hint only fires for hand-written commands.
 */
function shimWarning(command: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  if (!/(^|[\s&|(])(pnpm|npm|yarn|npx)([\s&|)]|$)/.test(command)) return undefined
  return '提示：pnpm/npm 在本环境里是 DSH 的 Electron shim，启动后会另开一个可见的控制台窗口，关掉它服务就停；建议改用系统 node 直启（例如 node "node_modules/vite/bin/vite.js"）'
}

/** One persisted run marker: what we started, so a later activation can reap it. */
interface PersistedRun {
  id: string
  name: string
  pid: number
  /** Epoch ms when we spawned it — compared against the process start time. */
  startedAt: number
  command: string
}

/** Where the run markers live, next to the service list. */
function runStatePath(): string {
  return join(dshHome(), 'service-runner', 'running.json')
}

/**
 * Read the run markers a previous activation left behind.
 *
 * A hard kill (`taskkill /F` on DSH, a crash) never gives the plugin a chance to
 * run its dispose hook, so the processes it started survive the restart and keep
 * holding their ports: the panel cannot see them, and the next start dies with
 * EADDRINUSE. These markers are how a fresh activation learns about them.
 */
async function readRunState(): Promise<PersistedRun[]> {
  try {
    const text = await readFile(runStatePath(), 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is PersistedRun => {
      if (item === null || typeof item !== 'object') return false
      const record = item as Record<string, unknown>
      return (
        typeof record.id === 'string' &&
        typeof record.pid === 'number' &&
        typeof record.startedAt === 'number'
      )
    })
  } catch {
    return []
  }
}

/** Overwrite the run markers (atomic, best effort). */
async function writeRunState(runs: PersistedRun[]): Promise<void> {
  const path = runStatePath()
  try {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(runs, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch {
    /* the markers are a safety net, never a hard requirement */
  }
}

/** How long we wait for the expected port before giving up on "ready". */
const READY_TIMEOUT_MS = 120_000

/** How often the readiness probe re-checks the port. */
const PROBE_INTERVAL_MS = 700

/** Without a known port, a process that survives this long counts as running. */
const BLIND_GRACE_MS = 4_000

/** Grace period between SIGTERM and SIGKILL on POSIX. */
const KILL_GRACE_MS = 5_000

/**
 * How long a polite Windows stop request gets before the process is forced.
 *
 * Only unresponsive processes wait this long — a service that honours the close
 * request disappears immediately and `waitForExit` returns at once.
 */
const GRACEFUL_STOP_MS = 1_500

/**
 * Default budget for a service's own `stopCommand`.
 *
 * Matches process-compose's `shutdown.timeout_seconds` default: long enough for
 * a container stop or an admin shutdown endpoint, short enough that a hung
 * command cannot block the panel.
 */
const STOP_COMMAND_TIMEOUT_MS = 10_000

/**
 * Run a one-shot shell command, resolving whether it exited 0 in time.
 *
 * Used for `stopCommand`, which is hand-written and may be a compound line
 * (`docker stop x && echo done`), so it needs the platform shell rather than a
 * bare executable.
 */
function runShellCommand(command: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn(command, { shell: true, windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        finish(false)
      }, timeoutMs)
      timer.unref?.()
      child.once('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0)
      })
      child.once('error', () => {
        clearTimeout(timer)
        finish(false)
      })
    } catch {
      finish(false)
    }
  })
}

/**
 * Shell phrasings meaning "that command does not exist".
 *
 * A missing binary is the single most common start failure, and the raw shell
 * message arrives in the console's OEM code page (on this machine it renders as
 * mojibake), so it is worth one translated line that also points at the wrapper
 * scripts a repository usually ships.
 */
const COMMAND_NOT_FOUND =
  /不是内部或外部命令|is not recognized as an internal or external command|command not found|no such file or directory/i

/** Internal per-service record. */
interface Entry {
  definition: ServiceDefinition
  runtime: ServiceRuntime
  logs: LogLine[]
  /** Monotonic log sequence; never resets so the client cursor stays valid. */
  seq: number
  child?: ChildProcess
  readyTimer?: NodeJS.Timeout
  killTimer?: NodeJS.Timeout
  /** Set while a stop was requested, so the exit handler reports "stopped". */
  stopRequested: boolean
  /**
   * True when the expected port was already taken before we spawned.
   *
   * The readiness probe cannot tell our listener from a stranger's, so in that
   * case it must not be used at all — otherwise the row claims "ready" the
   * instant it starts while the real bind failure stays buried in the log.
   */
  portOccupiedAtStart: boolean
  /** Set once the "command not found" hint was emitted for this run. */
  warnedMissingCommand: boolean
  /**
   * Run generation. Bumped by every start AND every stop, so a start that had
   * to await something can tell that a stop/restart won the race and must not
   * spawn a process the user already asked to cancel.
   */
  runToken: number
  /** Whether the current run actually spawned a process (guards the port sweep). */
  spawned: boolean
  /** Tail of a partial line from the previous chunk. */
  stdoutTail: string
  stderrTail: string
  /** Automatic restarts since the last manual start (absent = 0). */
  restarts?: number
  /** Set while an automatic restart is pending, so `start` keeps the counter. */
  autoRestarting?: boolean
}

/** Absolute working directory for a definition. */
function resolveCwd(definition: ServiceDefinition): string {
  const cwd = definition.cwd?.trim()
  if (cwd === undefined || cwd === '') return definition.workspace
  return isAbsolute(cwd) ? cwd : join(definition.workspace, cwd)
}

/** Whether a TCP port accepts a connection right now. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(900)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

/** Whether a pid still exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for a process to disappear, returning whether it did. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return !isAlive(pid)
}

/**
 * Pull a listening port out of a log line.
 *
 * Dev servers announce themselves in every dialect: `http://localhost:5173/`,
 * `Listening on 0.0.0.0:8080`, `--port 3000`. Any of those beats making the user
 * type the port into the panel.
 */
export function extractPort(line: string): number | undefined {
  const patterns = [
    /https?:\/\/[^\s/:]+:(\d{2,5})/i, // http://localhost:5173/
    /\b(?:listening|started|running|serving)\b[^\d]{0,24}(\d{2,5})\b/i, // Listening on ... 8080
    /--port[=\s]+(\d{2,5})/i,
    /\bport\b[^\d]{0,12}(\d{2,5})\b/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(line)
    if (match?.[1] !== undefined) {
      const port = Number.parseInt(match[1], 10)
      if (port > 0 && port < 65536) return port
    }
  }
  return undefined
}

/** Join a workspace path to its display name. */
function workspaceName(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? trimmed
}

export class ServiceManager {
  #entries = new Map<string, Entry>()

  /**
   * Replace the known definitions.
   *
   * Runtime state for ids that survive the update is preserved — a re-detect
   * must never look like a restart to the user.
   */
  syncDefinitions(definitions: ServiceDefinition[]): void {
    const incoming = new Set(definitions.map((definition) => definition.id))
    for (const [id, entry] of [...this.#entries]) {
      if (!incoming.has(id)) {
        // Definition removed while running: stop it so we don't orphan a child.
        if (entry.child !== undefined) void this.stop(id)
        this.#entries.delete(id)
      }
    }
    for (const definition of definitions) {
      const existing = this.#entries.get(definition.id)
      if (existing === undefined) {
        this.#entries.set(definition.id, {
          definition,
          runtime: { status: 'stopped' },
          logs: [],
          seq: 0,
          stopRequested: false,
          portOccupiedAtStart: false,
          warnedMissingCommand: false,
          runToken: 0,
          spawned: false,
          stdoutTail: '',
          stderrTail: '',
        })
      } else {
        existing.definition = definition
      }
    }
  }

  /** Definitions currently known, newest state included. */
  snapshot(workspace?: string): WorkspaceSnapshot[] {
    const grouped = new Map<string, ServiceSnapshot[]>()
    for (const entry of this.#entries.values()) {
      if (workspace !== undefined && workspace !== '' && entry.definition.workspace !== workspace) {
        continue
      }
      const list = grouped.get(entry.definition.workspace) ?? []
      list.push({
        definition: entry.definition,
        runtime: entry.runtime,
        logSeq: entry.seq,
      })
      grouped.set(entry.definition.workspace, list)
    }
    return [...grouped.entries()]
      .map(([root, services]) => ({
        workspace: root,
        name: workspaceName(root),
        services: services.sort((a, b) => a.definition.name.localeCompare(b.definition.name)),
      }))
      .sort((a, b) => a.workspace.localeCompare(b.workspace))
  }

  /** Log lines after a cursor; `after = 0` returns everything buffered. */
  logs(id: string, after: number): { lines: LogLine[]; logSeq: number; status: ServiceRuntime['status'] } | undefined {
    const entry = this.#entries.get(id)
    if (entry === undefined) return undefined
    const lines = entry.logs.filter((line) => line.seq > after)
    return { lines, logSeq: entry.seq, status: entry.runtime.status }
  }

  /**
   * Drop a service's buffered lines.
   *
   * `seq` deliberately keeps counting: client cursors are `seq` values, so
   * resetting it would make every open panel re-fetch from zero, and the next
   * appended line would collide with ones the client already has.
   */
  clearLogs(id: string): boolean {
    const entry = this.#entries.get(id)
    if (entry === undefined) return false
    entry.logs = []
    return true
  }

  /** Markers describing what this activation is currently running. */
  #persistedRuns(): PersistedRun[] {
    const runs: PersistedRun[] = []
    for (const [id, entry] of this.#entries) {
      const pid = entry.child?.pid
      const startedAt = entry.runtime.startedAt
      if (pid === undefined || startedAt === undefined || !entry.spawned) continue
      runs.push({
        id,
        name: entry.definition.name,
        pid,
        startedAt,
        command: entry.definition.command,
      })
    }
    return runs
  }

  /** Flush the markers after any lifecycle change (best effort, never awaited). */
  #persistRuns(): void {
    void writeRunState(this.#persistedRuns())
  }

  /**
   * Reap processes a previous activation started and never got to stop.
   *
   * Called once per activation before the panel can start anything: a hard kill
   * leaves those processes alive holding their ports, and nothing else in the
   * plugin knows they exist. Every pid is verified against its recorded start
   * time first, so a recycled pid is never touched.
   */
  async reapPersistedRuns(): Promise<void> {
    const runs = await readRunState()
    // Clear the markers first: they describe the previous activation, and a
    // second replay must never happen even if this pass is interrupted.
    await writeRunState([])
    for (const run of runs) {
      if (!(await this.#killIfStillOurs(run))) continue
      const entry = this.#entries.get(run.id)
      if (entry !== undefined) {
        this.#append(entry, 'system', `已清理上次运行遗留的进程（${run.name}，pid ${run.pid}）`)
      }
    }
    this.#persistRuns()
  }

  /**
   * Kill one recorded pid, but only when it is demonstrably the process we
   * started. A pid that no longer exists — or whose start time is far from the
   * recorded moment — has been recycled by the OS and is left alone.
   */
  async #killIfStillOurs(run: PersistedRun): Promise<boolean> {
    if (process.platform !== 'win32') {
      try {
        process.kill(run.pid, 'SIGKILL')
        return true
      } catch {
        return false
      }
    }
    const script = [
      `$p = Get-Process -Id ${run.pid} -ErrorAction SilentlyContinue`,
      `if ($p -eq $null) { Write-Output 'gone'; exit 0 }`,
      `$start = [int64]($p.StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds`,
      `if ([math]::Abs($start - ${run.startedAt}) -gt 15000) { Write-Output 'stale'; exit 0 }`,
      `taskkill /PID ${run.pid} /T /F | Out-Null`,
      `Write-Output 'killed'`,
    ].join('\n')
    const output = await runCapture('powershell', ['-NoProfile', '-Command', script])
    return output.includes('killed')
  }

  /** Start one service. Re-starting a live service is a no-op. */
  async start(id: string, path?: Set<string>): Promise<{ ok: boolean; error?: string }> {
    const entry = this.#entries.get(id)
    if (entry === undefined) return { ok: false, error: '服务不存在（可能已被移除）' }
    if (entry.child !== undefined && entry.runtime.status !== 'failed') {
      return { ok: true }
    }

    // Dependencies first: bring up whatever this service waits on, then wait for
    // each declared condition. The trail travels down the *current recursion
    // path* instead of living on the instance — a global set made two concurrent
    // starts of the same service look like a dependency cycle.
    const trail = path ?? new Set<string>()
    if (entry.definition.dependsOn !== undefined) {
      if (trail.has(id)) {
        this.#append(entry, 'system', '检测到依赖循环，已跳过依赖编排')
      } else {
        trail.add(id)
        try {
          const failure = await this.#startDependencies(entry, trail)
          if (failure !== undefined) return { ok: false, error: failure }
        } finally {
          trail.delete(id)
        }
      }
    }

    const definition = entry.definition
    const cwd = resolveCwd(definition)
    // Claim this run. Anything that lands after this point bumps the token, and
    // the awaits below re-check it before spawning.
    const token = entry.runToken + 1
    entry.runToken = token
    entry.spawned = false
    entry.stopRequested = false
    entry.warnedMissingCommand = false
    entry.stdoutTail = ''
    entry.stderrTail = ''
    // A manual start resets the retry budget; an automatic restart keeps it, so
    // the cap actually bounds a crash loop.
    if (entry.autoRestarting !== true) entry.restarts = 0
    entry.autoRestarting = false
    // Keep the previous run's start time: it is the cutoff that tells a stray
    // listener left by that run apart from an unrelated process on the port.
    const previousStart = entry.runtime.startedAt
    const command = expandCommand(definition, cwd)
    entry.runtime = { status: 'starting', startedAt: Date.now() }
    this.#append(entry, 'system', `$ ${command}`)
    this.#append(entry, 'system', `cwd: ${cwd}`)
    const hint = shimWarning(command)
    if (hint !== undefined) this.#append(entry, 'system', hint)

    // Decide BEFORE spawning whether the port is already somebody else's: a
    // ready-probe on a port we do not own would report a stranger's process as
    // our success. Probing first removes the race entirely.
    entry.portOccupiedAtStart = false
    if (definition.port !== undefined) {
      let occupied = await probePort(definition.port)
      // The probe is the only await before the spawn, so it is exactly where a
      // stop can slip in. Losing the race means: start nothing.
      if (entry.runToken !== token) return { ok: false, error: '启动已取消：期间收到了停止指令' }
      // A dev server can outlive the wrapper that started it (its window was
      // closed, the wrapper crashed), leaving the port held by an orphan this
      // manager can no longer see — the next start then dies with EADDRINUSE.
      // Reap listeners that appeared at or after OUR previous launch; a
      // stranger's older process is never touched.
      if (occupied && previousStart !== undefined) {
        this.#append(entry, 'system', `端口 ${definition.port} 已被占用，检查是否为上次运行遗留…`)
        await this.#reapStrayListener(entry, definition.port, previousStart)
        if (entry.runToken !== token) return { ok: false, error: '启动已取消：期间收到了停止指令' }
        await new Promise((resolve) => setTimeout(resolve, 400))
        occupied = await probePort(definition.port)
      }
      entry.portOccupiedAtStart = occupied
      if (occupied) {
        this.#append(
          entry,
          'system',
          `注意：端口 ${definition.port} 在启动前已被占用，无法用端口确认本服务是否就绪`,
        )
      }
    }
    if (entry.runToken !== token) return { ok: false, error: '启动已取消：期间收到了停止指令' }

    let child: ChildProcess
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        // A POSIX process group lets us signal the whole tree (npm → vite, etc.).
        // On Windows `detached` MUST stay false: measured, with it cmd.exe's
        // output stops reaching our pipes entirely, which would blind the panel.
        detached: process.platform !== 'win32',
        windowsHide: true,
        // stdin is not ours to hand out; stdout/stderr feed the log panel.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Logs are replayed into a <pre> panel, so ANSI colour would only show
        // up as escape noise. NO_COLOR also silences the FORCE_COLOR/NO_COLOR
        // conflict warning Node prints on every run when the parent sets it.
        env: { ...process.env, ...definition.env, NO_COLOR: '1' },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      entry.runtime = { status: 'failed', error: message, exitedAt: Date.now() }
      this.#append(entry, 'system', `启动失败：${message}`)
      return { ok: false, error: message }
    }

    entry.child = child
    entry.spawned = true
    entry.runtime.pid = child.pid

    child.stdout?.on('data', (chunk: Buffer) => this.#consume(entry, 'stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.#consume(entry, 'stderr', chunk))

    child.once('error', (error) => {
      entry.runtime = {
        ...entry.runtime,
        status: 'failed',
        error: error.message,
        exitedAt: Date.now(),
      }
      this.#append(entry, 'system', `进程错误：${error.message}`)
      entry.child = undefined
      this.#clearTimers(entry)
    })

    child.once('exit', (code, signal) => {
      this.#clearTimers(entry)
      entry.child = undefined
      this.#persistRuns()
      const exitCode = code ?? (signal !== null ? -1 : 0)
      const wasStopping = entry.stopRequested
      entry.stopRequested = false
      const clean = wasStopping || isCleanExit(definition, exitCode)
      if (clean) {
        entry.runtime = {
          ...entry.runtime,
          status: 'stopped',
          exitCode,
          exitedAt: Date.now(),
          pid: undefined,
        }
        this.#append(
          entry,
          'system',
          exitCode === 0 || wasStopping
            ? `进程已退出（code ${exitCode}）`
            : `进程已退出（code ${exitCode}，按干净停止处理：信号退出码或已配置的 successExitCodes）`,
        )
      } else {
        entry.runtime = {
          ...entry.runtime,
          status: 'failed',
          exitCode,
          exitedAt: Date.now(),
          pid: undefined,
          error: entry.runtime.error ?? `进程异常退出（code ${exitCode}${signal !== null ? `, ${signal}` : ''}）`,
        }
        this.#append(entry, 'system', `进程异常退出（code ${exitCode}${signal !== null ? `, ${signal}` : ''}）`)
      }

      // Automatic recovery, modelled on PM2's restart strategies and
      // process-compose's `availability`: a bounded number of retries with a
      // doubling backoff, so a service that crashes during startup cannot spin.
      const policy = definition.restart ?? 'no'
      const wanted = wasStopping
        ? false
        : policy === 'always' || (policy === 'on_failure' && !clean)
      if (!wanted) return
      const max = definition.maxRestarts ?? 3
      const used = entry.restarts ?? 0
      if (max > 0 && used >= max) {
        this.#append(entry, 'system', `已自动重启 ${used} 次，达到 maxRestarts=${max}，不再重试`)
        return
      }
      entry.restarts = used + 1
      entry.autoRestarting = true
      const base = definition.backoffMs ?? 1_000
      const delay = Math.min(base * 2 ** used, 30_000)
      this.#append(
        entry,
        'system',
        `将在 ${(delay / 1000).toFixed(1)}s 后自动重启（第 ${entry.restarts} 次，策略 ${policy}）`,
      )
      const timer = setTimeout(() => {
        void this.start(definition.id)
      }, delay)
      timer.unref?.()
    })

    // Record what we started: if DSH is killed outright, the dispose hook never
    // runs and these markers are the only trace the next activation can find.
    this.#persistRuns()
    this.#watchReadiness(entry)
    return { ok: true }
  }

  /** Stop one service (process tree on Windows, process group elsewhere). */
  async stop(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.#entries.get(id)
    if (entry === undefined) return { ok: false, error: '服务不存在（可能已被移除）' }
    // Cancel any start that is still awaiting its port probe.
    entry.runToken += 1
    const definition = entry.definition
    const child = entry.child
    const pid = child?.pid
    if (child === undefined || pid === undefined) {
      entry.runtime = { ...entry.runtime, status: 'stopped', pid: undefined }
      this.#persistRuns()
      // The wrapper exited on its own, so there is no tree left to walk — but a
      // dev server it spawned may still hold the port, so sweep by port.
      this.#append(entry, 'system', '外层进程已自行退出，正在按端口检查残留')
      this.#reapAfterStop(entry)
      return { ok: true }
    }

    entry.stopRequested = true
    entry.runtime = { ...entry.runtime, status: 'stopping' }
    this.#clearTimers(entry)
    this.#append(entry, 'system', `正在停止（pid ${pid}）…`)

    // A service may ship its own graceful shutdown (`docker stop`, an admin
    // endpoint, a REPL that wants `quit`). Run it first with its own budget,
    // then fall through to the platform teardown below.
    const stopCommand = definition.stopCommand?.trim()
    if (stopCommand !== undefined && stopCommand !== '') {
      const budget = definition.stopTimeoutMs ?? STOP_COMMAND_TIMEOUT_MS
      this.#append(entry, 'system', `先执行自定义停止命令（最多 ${budget / 1000}s）：${stopCommand}`)
      const finished = await runShellCommand(stopCommand, budget)
      this.#append(
        entry,
        'system',
        finished
          ? '自定义停止命令已完成'
          : '自定义停止命令未在预算内以成功状态结束，继续按默认方式停止',
      )
    }

    if (process.platform === 'win32') {
      // `taskkill /T` walks the tree npm/mvn spawn underneath us — killing the
      // shell alone leaves the real server up. WITHOUT `/F` it posts a close
      // request first, which a console app (Spring Boot, vite) can intercept to
      // run its shutdown hooks; only if that fails to take the process down do
      // we force it. A process with no console refuses the polite request, so
      // the graceful call fails fast and we go straight to /F.
      // The polite call's exit code is NOT trustworthy: `taskkill /T` reports
      // failure when any single member of the tree has no console, even though
      // the console members did receive the close request and are shutting down
      // properly. So ask, then judge by whether the process actually went away.
      // `stopParentOnly` drops `/T`: a supervisor that cleans up its own children
      // would have that cleanup skipped by a tree kill.
      const tree = definition.stopParentOnly === true ? [] : ['/T']
      await runQuietly('taskkill', ['/PID', String(pid), ...tree], 4_000)
      if (await waitForExit(pid, GRACEFUL_STOP_MS)) {
        this.#append(entry, 'system', '进程已退出（温和停止请求生效）')
      } else {
        this.#append(entry, 'system', `进程未在 ${GRACEFUL_STOP_MS / 1000}s 内响应，强制结束`)
        await runQuietly('taskkill', ['/PID', String(pid), ...tree, '/F'])
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      }
      entry.killTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS)
      entry.killTimer.unref?.()
    }

    // The exit handler flips the state to `stopped`; if the process is already
    // gone the exit event fired synchronously and the status is final by now.
    // The tree kill above cannot reach a server that was re-parented earlier, so
    // sweep the port as well.
    this.#reapAfterStop(entry)
    return { ok: true }
  }

  /** Stop then start, preserving the log buffer (a restart is readable context). */
  async restart(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.#entries.get(id)
    if (entry === undefined) return { ok: false, error: '服务不存在（可能已被移除）' }
    this.#append(entry, 'system', '— 重启 —')
    await this.stop(id)
    // Give the OS a beat to release the port before the new process binds it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    return this.start(id)
  }

  /** Kill everything this plugin started (called on plugin disposal). */
  async disposeAll(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(ids.map((id) => this.stop(id)))
  }

  /** Feed a raw chunk through the line splitter. */
  #consume(entry: Entry, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const key = stream === 'stdout' ? 'stdoutTail' : 'stderrTail'
    const combined = entry[key] + chunk.toString('utf8')
    const lines = combined.split(/\r?\n/)
    entry[key] = lines.pop() ?? ''
    for (const line of lines) this.#append(entry, stream, line)
  }

  /** Append one log line, trimming the ring and harvesting a port if unseen. */
  #append(entry: Entry, stream: LogLine['stream'], text: string): void {
    entry.seq += 1
    entry.logs.push({ seq: entry.seq, stream, text, at: Date.now() })
    if (entry.logs.length > MAX_LOG_LINES) {
      entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES)
    }
    if (stream !== 'system' && entry.definition.port === undefined) {
      const port = extractPort(text)
      if (port !== undefined) {
        entry.definition = { ...entry.definition, port }
        entry.runtime = { ...entry.runtime, detectedPort: port }
      }
    }
    // Translate the most common start failure once per run. Re-entry is safe:
    // the appended hint is a `system` line, which this branch ignores.
    if (stream !== 'system' && !entry.warnedMissingCommand && COMMAND_NOT_FOUND.test(text)) {
      entry.warnedMissingCommand = true
      this.#append(
        entry,
        'system',
        '找不到该命令：请确认它已安装并在 PATH 中，或改用项目自带的 wrapper（如 .\\mvnw.cmd、./gradlew），也可以点「编辑」修改启动命令。',
      )
    }
  }

  /** Poll the port until it answers, the process dies, or we time out. */
  #watchReadiness(entry: Entry): void {
    const deadline = Date.now() + READY_TIMEOUT_MS
    const healthUrl = entry.definition.healthUrl
    let failures = 0
    const tick = async (): Promise<void> => {
      if (entry.child === undefined) return // exited while we were probing
      const port = entry.definition.port

      // An explicit health URL outranks the port: a listening socket can belong
      // to a process that is not serving yet, and when the port was already
      // taken before we started, the socket proves nothing at all.
      if (healthUrl !== undefined && !entry.portOccupiedAtStart) {
        if (await httpProbe(healthUrl)) {
          if (entry.child !== undefined) {
            entry.runtime = {
              ...entry.runtime,
              status: 'running',
              readyAt: Date.now(),
              ...(port === undefined ? {} : { detectedPort: port }),
            }
            this.#append(entry, 'system', `健康检查通过：${healthUrl}`)
          }
          return
        }
        failures += 1
        if (entry.child === undefined) return
        if (failures % 10 === 0) {
          this.#append(entry, 'system', `健康检查尚未通过（已尝试 ${failures} 次）：${healthUrl}`)
        }
        if (Date.now() > deadline) {
          this.#append(
            entry,
            'system',
            `健康检查 ${healthUrl} 超时，进程仍在运行（状态按运行中处理）`,
          )
          entry.runtime = {
            ...entry.runtime,
            status: 'running',
            error: `健康检查 ${healthUrl} 未在超时内通过`,
          }
          return
        }
        entry.readyTimer = setTimeout(() => void tick(), PROBE_INTERVAL_MS)
        entry.readyTimer.unref?.()
        return
      }

      // Without a usable port signal — no port at all, or the port belonged to
      // someone else before we started — liveness is all we can honestly claim.
      if (port === undefined || entry.portOccupiedAtStart) {
        const occupiedPort = port
        const occupied = entry.portOccupiedAtStart
        entry.readyTimer = setTimeout(() => {
          if (entry.child !== undefined && entry.runtime.status === 'starting') {
            entry.runtime = {
              ...entry.runtime,
              status: 'running',
              readyAt: Date.now(),
              ...(occupied
                ? { error: `端口 ${occupiedPort} 在启动前已被占用，就绪状态未经端口确认` }
                : {}),
            }
          }
        }, BLIND_GRACE_MS)
        entry.readyTimer.unref?.()
        return
      }
      if (await probePort(port)) {
        if (entry.child !== undefined) {
          entry.runtime = {
            ...entry.runtime,
            status: 'running',
            readyAt: Date.now(),
            detectedPort: port,
          }
          this.#append(entry, 'system', `端口 ${port} 已就绪`)
        }
        return
      }
      if (entry.child === undefined) return
      if (Date.now() > deadline) {
        this.#append(entry, 'system', `等待端口 ${port} 超时，进程仍在运行（状态按运行中处理）`)
        entry.runtime = { ...entry.runtime, status: 'running', error: `端口 ${port} 未在超时内响应` }
        return
      }
      entry.readyTimer = setTimeout(() => void tick(), PROBE_INTERVAL_MS)
      entry.readyTimer.unref?.()
    }
    void tick()
  }

  /**
   * Sweep a listener that outlived its wrapper.
   *
   * A dev server can survive the shell that started it: when the wrapper dies
   * first (Ctrl+C on a shared console, an npm crash), the server is re-parented
   * and `taskkill /T` from the wrapper can no longer reach it, so it holds the
   * port forever and the next start fails with EADDRINUSE. Reap it by port —
   * but ONLY when the listener started at or after our own launch, so a port
   * that was already somebody else's is never touched.
   */
  async #reapStrayListener(entry: Entry, port: number, since: number): Promise<void> {
    if (process.platform !== 'win32') return
    const script = [
      `$cutoff = [datetime]::Parse('${new Date(since).toISOString()}')`,
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |`,
      `  ForEach-Object {`,
      `    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue`,
      `    if ($p -and $p.StartTime -ge $cutoff) {`,
      `      taskkill /PID $_.OwningProcess /T /F | Out-Null`,
      `      Write-Output $_.OwningProcess`,
      `    }`,
      `  }`,
    ].join('\n')
    const output = await runCapture('powershell', ['-NoProfile', '-Command', script])
    for (const line of output.split(/\r?\n/)) {
      const pid = line.trim()
      if (/^\d+$/.test(pid)) {
        this.#append(entry, 'system', `已清理占用端口 ${port} 的残留进程（pid ${pid}）`)
      }
    }
  }

  /** Kick off the port sweep for a service that just stopped. */
  #reapAfterStop(entry: Entry): void {
    // Only after a run that really spawned something: a cancelled start created
    // no process, and its fresh `since` timestamp would otherwise authorise
    // killing an unrelated listener that merely appeared in the meantime.
    if (!entry.spawned) return
    const port = entry.definition.port
    const since = entry.runtime.startedAt
    if (port === undefined || since === undefined) return
    void this.#reapStrayListener(entry, port, since)
  }

  /**
   * Start every dependency of `entry` and wait for its condition.
   *
   * Returns a failure message (surfaced on the dependent service) or undefined
   * when everything it waits on is satisfied. Modelled on process-compose's
   * `depends_on` conditions. `dependsOn` is keyed by the panel's service names
   * rather than ids, because ids are workspace-qualified and not something a
   * user types by hand.
   */
  async #startDependencies(entry: Entry, trail: Set<string>): Promise<string | undefined> {
    const deps = entry.definition.dependsOn
    if (deps === undefined) return undefined
    for (const [name, rawCondition] of Object.entries(deps)) {
      const condition =
        rawCondition === 'healthy' || rawCondition === 'completed_successfully'
          ? rawCondition
          : 'started'
      const dependency = this.#findByName(name, entry.definition.workspace)
      if (dependency === undefined) {
        this.#append(entry, 'system', `依赖的服务「${name}」不在列表里，已跳过`)
        continue
      }
      if (this.#satisfies(dependency, condition)) {
        this.#append(entry, 'system', `依赖「${name}」已满足（${condition}）`)
        continue
      }
      this.#append(entry, 'system', `先启动依赖「${name}」（要求 ${condition}）`)
      const started = await this.start(dependency.definition.id, trail)
      if (!started.ok) {
        this.#append(entry, 'system', `依赖「${name}」启动失败：${started.error ?? '未知原因'}`)
        return `依赖 ${name} 启动失败`
      }
      if (!(await this.#waitForCondition(dependency, condition))) {
        this.#append(entry, 'system', `等待依赖「${name}」满足 ${condition} 超时`)
        return `依赖 ${name} 未在超时内满足 ${condition}`
      }
      this.#append(entry, 'system', `依赖「${name}」已就绪`)
    }
    return undefined
  }

  /** A dependency by panel name, preferring the dependent's own workspace. */
  #findByName(name: string, workspace: string): Entry | undefined {
    let fallback: Entry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.definition.name !== name) continue
      if (entry.definition.workspace === workspace) return entry
      fallback ??= entry
    }
    return fallback
  }

  /** Whether one entry's current state satisfies a dependency condition. */
  #satisfies(entry: Entry, condition: string): boolean {
    if (condition === 'completed_successfully') {
      return entry.runtime.status === 'stopped' && (entry.runtime.exitCode ?? -1) === 0
    }
    if (condition === 'healthy') {
      return entry.runtime.status === 'running' && entry.runtime.readyAt !== undefined
    }
    return entry.child !== undefined || entry.runtime.status === 'running'
  }

  /** Poll until a dependency satisfies its condition, or the budget runs out. */
  async #waitForCondition(entry: Entry, condition: string): Promise<boolean> {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (this.#satisfies(entry, condition)) return true
      // Nothing left to wait for: the dependency has already ended without
      // satisfying the condition (failed, or stopped with a non-zero code).
      // Without this the caller burns the whole budget on a dependency that
      // finished seconds ago — which is exactly what a failed dependency does.
      if (entry.child === undefined && entry.runtime.status !== 'starting') return false
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return false
  }

  /** Clear the readiness probe timer. */
  #clearTimers(entry: Entry): void {
    if (entry.readyTimer !== undefined) {
      clearTimeout(entry.readyTimer)
      entry.readyTimer = undefined
    }
    if (entry.killTimer !== undefined) {
      clearTimeout(entry.killTimer)
      entry.killTimer = undefined
    }
  }
}
