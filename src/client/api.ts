/**
 * Browser-side HTTP client for the host half.
 *
 * Same-origin fetch against the plugin's own prefix; no auth dance is needed
 * because the web shell already gates the browser session.
 */
import type { DetectResult, LogLine, PortOwner, ServiceDefinition, ServiceSnapshot, WorkspaceSnapshot } from '../host/types.ts'

/** Response of `GET /state`. */
export interface StateResponse {
  ok: boolean
  workspace: string | null
  workspaces: string[]
  snapshots: WorkspaceSnapshot[]
}

/** Response of `GET /logs`. */
export interface LogsResponse {
  ok: boolean
  lines: LogLine[]
  logSeq: number
  status: ServiceSnapshot['runtime']['status']
}

/** Response of `POST /detect`. */
export type DetectResponse = { ok: boolean; error?: string } & Partial<DetectResult>

const BASE = '/service-runner'

/** POST/GET a JSON endpoint, surfacing host-side `error` strings as throws. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  const record = payload as { ok?: boolean; error?: string }
  if (!response.ok || record.ok === false) {
    throw new Error(record.error ?? `请求失败（HTTP ${response.status}）`)
  }
  return payload as T
}

export const api = {
  /** Current workspace + service snapshots. */
  state(sessionId: string | undefined, workspace: string | undefined): Promise<StateResponse> {
    const params = new URLSearchParams()
    if (sessionId !== undefined && sessionId !== '') params.set('sessionId', sessionId)
    if (workspace !== undefined && workspace !== '') params.set('workspace', workspace)
    return call<StateResponse>(`/state?${params.toString()}`)
  },
  /** start / stop / restart one service. */
  action(action: 'start' | 'stop' | 'restart', id: string): Promise<{ ok: boolean; error?: string }> {
    return call('/action', { method: 'POST', body: JSON.stringify({ action, id }) })
  },
  /** Log lines newer than a cursor. */
  logs(id: string, after: number): Promise<LogsResponse> {
    const params = new URLSearchParams({ id, after: String(after) })
    return call<LogsResponse>(`/logs?${params.toString()}`)
  },
  /** Drop a service's buffered lines on the host. */
  clearLogs(id: string): Promise<{ ok: boolean }> {
    return call('/logs/clear', { method: 'POST', body: JSON.stringify({ id }) })
  },
  /** Scan a directory for runnable services. */
  detect(workspace: string): Promise<DetectResponse> {
    return call('/detect', { method: 'POST', body: JSON.stringify({ workspace }) })
  },
  /** Persist the whole list for one workspace. */
  save(
    workspace: string,
    services: ServiceDefinition[],
  ): Promise<{ ok: boolean; services: ServiceSnapshot[] }> {
    return call('/save', { method: 'POST', body: JSON.stringify({ workspace, services }) })
  },
  /** Drop one service definition. */
  remove(id: string): Promise<{ ok: boolean }> {
    return call('/remove', { method: 'POST', body: JSON.stringify({ id }) })
  },
  /** Who is listening on a port; `null` when nothing is. */
  portOwner(port: number): Promise<{ ok: boolean; owner: PortOwner | null }> {
    return call('/port-owner', { method: 'POST', body: JSON.stringify({ port }) })
  },
  /**
   * Kill the process holding a port.
   *
   * The host re-checks the pid against a fresh probe, so a port that changed
   * hands since the panel rendered is reported rather than killed.
   */
  portRelease(port: number, pid: number): Promise<{ ok: boolean; error?: string; owner?: PortOwner }> {
    return call('/port-release', { method: 'POST', body: JSON.stringify({ port, pid }) })
  },
}
