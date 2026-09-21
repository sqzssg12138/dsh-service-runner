/**
 * Who is holding a port, and taking it back on request.
 *
 * "Port already in use" is the most common reason a service refuses to start,
 * and the raw fact is useless on its own — the user needs to know WHICH process
 * it is (an IDE debug session? a leftover dev server?) before deciding to kill
 * it. Windows is covered by Get-NetTCPConnection + Get-CimInstance; elsewhere
 * `lsof` is used when present.
 */
import { spawn } from 'node:child_process'

import { runCapture } from './run.ts'
import type { PortOwner } from './types.ts'

/** Parse the last JSON line of a probe's output. */
function parseJsonLine(text: string): Record<string, unknown> | undefined {
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const value = JSON.parse(trimmed) as unknown
      if (value !== null && typeof value === 'object') return value as Record<string, unknown>
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/** Windows probe: first listener on the port plus its process details. */
async function describeWindows(port: number): Promise<PortOwner | undefined> {
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if ($null -ne $c) {`,
    `  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue`,
    `  $w = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction SilentlyContinue`,
    `  [pscustomobject]@{`,
    `    pid = [int]$c.OwningProcess`,
    `    name = if ($p) { $p.ProcessName } else { 'unknown' }`,
    `    startedAt = if ($p) { $p.StartTime.ToString('o') } else { $null }`,
    `    commandLine = if ($w) { $w.CommandLine } else { $null }`,
    `  } | ConvertTo-Json -Compress`,
    `}`,
  ].join('\n')
  const parsed = parseJsonLine(await runCapture('powershell', ['-NoProfile', '-Command', script], 8_000))
  if (parsed === undefined) return undefined
  const pid = typeof parsed.pid === 'number' ? parsed.pid : Number.parseInt(String(parsed.pid), 10)
  if (!Number.isFinite(pid)) return undefined
  return {
    port,
    pid,
    name: typeof parsed.name === 'string' ? parsed.name : 'unknown',
    startedAt: typeof parsed.startedAt === 'string' && parsed.startedAt !== '' ? parsed.startedAt : undefined,
    commandLine:
      typeof parsed.commandLine === 'string' && parsed.commandLine !== '' ? parsed.commandLine : undefined,
  }
}

/** POSIX probe via lsof, when it exists. */
async function describePosix(port: number): Promise<PortOwner | undefined> {
  const output = await runCapture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 4_000)
  const pid = Number.parseInt(output.trim().split(/\r?\n/)[0] ?? '', 10)
  if (!Number.isFinite(pid)) return undefined
  return { port, pid, name: `pid ${pid}` }
}

/** Describe whoever listens on `port`, or undefined when nothing does. */
export async function describePortOwner(port: number): Promise<PortOwner | undefined> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return process.platform === 'win32' ? describeWindows(port) : describePosix(port)
}

/** Kill a whole process tree. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
      resolve()
      return
    }
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('exit', () => resolve())
      killer.once('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * Take a port back, but only from the process the caller named.
 *
 * The pid is re-checked against a fresh probe first: between the panel showing
 * an owner and the user confirming, the port may have changed hands, and
 * killing blindly would terminate an unrelated process.
 */
export async function releasePort(
  port: number,
  pid: number,
): Promise<{ ok: boolean; error?: string; owner?: PortOwner }> {
  const owner = await describePortOwner(port)
  if (owner === undefined) return { ok: false, error: `端口 ${port} 当前没有监听进程` }
  if (owner.pid !== pid) {
    return {
      ok: false,
      error: `端口 ${port} 的占用者已变化（当前是 pid ${owner.pid} ${owner.name}），请刷新后重试`,
      owner,
    }
  }
  await killTree(pid)
  return { ok: true, owner }
}
