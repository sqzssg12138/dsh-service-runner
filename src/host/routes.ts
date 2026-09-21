/**
 * HTTP surface of the plugin.
 *
 * Everything the browser half needs hangs off one prefix, and every response is
 * JSON. The routes stay deliberately dumb: they validate, delegate to the store
 * or the process manager, and serialize. All matching is done by the host
 * webserver (exact before longest-prefix), so the handler only routes on the
 * path suffix.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { HostContext, SessionPersistenceLike } from './context.ts'
import { detectWorkspace } from './detect.ts'
import type { ServiceManager } from './manager.ts'
import { describePortOwner, releasePort } from './ports.ts'
import { serviceId, ServiceStore, samePath, dshHome } from './store.ts'
import { isTrustedRequest } from './trust.ts'
import type { ServiceDefinition } from './types.ts'

/** Route prefix; the host webserver owns the matching. */
export const ROUTE_PREFIX = '/service-runner'

/** Bodies are small control payloads; anything larger is a bug or an attack. */
const MAX_BODY_BYTES = 512 * 1024

/** Dependencies the handler closes over. */
export interface RouteDeps {
  ctx: HostContext
  store: ServiceStore
  manager: ServiceManager
  /** Load definitions on first use (store + manager sync). */
  ensureReady: () => Promise<void>
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read the whole request body as text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Parse a JSON body, tolerating an empty one. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req)
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** String field from a record, trimmed; empty strings become undefined. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A valid TCP port from an untrusted record. */
function asPort(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined
}

/** A positive pid from an untrusted record. */
function asPid(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Absolute path of the directory holding a session, when the DSH layout is the
 * usual `sessions/<slug>/<sessionId>` one. Used only as a fallback.
 */
async function sessionDirectory(sessionId: string): Promise<string | undefined> {
  const root = join(dshHome(), 'sessions')
  try {
    const projects = await readdir(root, { withFileTypes: true })
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const candidate = join(root, project.name, sessionId)
      try {
        await stat(candidate)
        return candidate
      } catch {
        /* not this project */
      }
    }
  } catch {
    /* no sessions directory */
  }
  return undefined
}

/**
 * Recover the workspace path from the project slug DSH uses for session
 * folders: `--D-work-my-project--` → `D:\work\my-project`.
 *
 * Ambiguous by construction (a folder name containing `-` cannot be told from a
 * separator), so the decoded path is only accepted when it actually exists.
 */
async function workspaceFromSlug(sessionId: string): Promise<string | undefined> {
  const dir = await sessionDirectory(sessionId)
  if (dir === undefined) return undefined
  const slug = dir.split(/[\\/]/).slice(-2)[0]
  if (slug === undefined) return undefined
  const inner = slug.replace(/^-+/, '').replace(/-+$/, '')
  // Try both separator readings; the one that resolves to a real directory wins.
  for (const separator of ['\\', '/']) {
    const guess = inner.replace(/-/g, separator)
    // `D\work\...` is the drive-letter form after separator substitution.
    const candidate = /^[A-Za-z][\\/]/.test(guess) ? `${guess[0]}:${guess.slice(1)}` : guess
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch {
      /* try the next reading */
    }
  }
  return undefined
}

/** Resolve a session's authoritative workspace directory. */
async function resolveWorkspace(
  deps: RouteDeps,
  sessionId: string | undefined,
  hint: string | undefined,
): Promise<string | undefined> {
  if (sessionId !== undefined) {
    const persistence = deps.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence !== undefined && typeof persistence.open === 'function') {
      try {
        const handle = await persistence.open(sessionId, 'read')
        try {
          const cwd = handle.header?.cwd
          if (typeof cwd === 'string' && cwd !== '') return cwd
        } finally {
          await handle.close?.()
        }
      } catch {
        /* fall through to the next strategy */
      }
    }
    const fromSlug = await workspaceFromSlug(sessionId)
    if (fromSlug !== undefined) return fromSlug
  }
  // The browser may know the cwd from its own session summary; trust it last
  // because the host header is authoritative when it is reachable.
  if (hint !== undefined) return hint
  return undefined
}

/** A string map from an untrusted record; non-string values are dropped. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => entry[0] !== '' && typeof entry[1] === 'string',
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/** Normalise one incoming definition, deriving the id when absent. */
function normalizeDefinition(
  raw: unknown,
  workspace: string,
): ServiceDefinition | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const name = str(record, 'name')
  const command = str(record, 'command')
  if (name === undefined || command === undefined) return undefined
  const language = str(record, 'language')
  const portValue = record.port
  const port =
    typeof portValue === 'number' && Number.isFinite(portValue)
      ? portValue
      : typeof portValue === 'string' && /^\d+$/.test(portValue)
        ? Number.parseInt(portValue, 10)
        : undefined
  return {
    id: str(record, 'id') ?? serviceId(workspace, name),
    workspace,
    name,
    command,
    cwd: str(record, 'cwd'),
    port,
    language:
      language === 'node' || language === 'java' || language === 'python' || language === 'docker'
        ? language
        : 'custom',
    autoDetected: record.autoDetected === true,
    note: str(record, 'note'),
    // Carried through on purpose: these belong to the stored shape and the
    // manager acts on them, but dropping them here made every panel save
    // silently erase the setting.
    env: stringMap(record.env),
    healthUrl: str(record, 'healthUrl'),
    successExitCodes: numberList(record.successExitCodes),
    stopCommand: str(record, 'stopCommand'),
    stopTimeoutMs: positiveNumber(record.stopTimeoutMs),
    stopParentOnly: record.stopParentOnly === true ? true : undefined,
    restart:
      record.restart === 'no' || record.restart === 'on_failure' || record.restart === 'always'
        ? record.restart
        : undefined,
    backoffMs: positiveNumber(record.backoffMs),
    maxRestarts: nonNegativeInteger(record.maxRestarts),
    dependsOn: stringMap(record.dependsOn),
  }
}

/** A non-negative integer from an untrusted record. */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** A positive finite number from an untrusted record. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A list of integers from an untrusted record; non-integers are dropped. */
function numberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const numbers = value.filter(
    (item): item is number => typeof item === 'number' && Number.isInteger(item),
  )
  return numbers.length === 0 ? undefined : numbers
}

/**
 * Build the prefix route handler.
 *
 * The routes:
 *   GET  /service-runner/state      ?sessionId=&workspace=&hint=
 *   POST /service-runner/action     { action: start|stop|restart, id }
 *   GET  /service-runner/logs       ?id=&after=
 *   POST /service-runner/detect     { workspace }
 *   POST /service-runner/save       { workspace, services: [...] }
 */
export function createHandler(deps: RouteDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Fence first: these routes start and kill processes, so a cross-site page
    // must never reach them. Same-origin panel calls, curl and the test scripts
    // are unaffected (loopback Host, no Origin).
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: '请求被信任围栏拒绝：需要回环 Host 且 Origin 同源' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      await deps.ensureReady()

      if (route === '/state' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        const explicit = url.searchParams.get('workspace') ?? undefined
        const hint = url.searchParams.get('hint') ?? undefined
        const resolved = explicit ?? (await resolveWorkspace(deps, sessionId, hint))
        // Sync definitions for the resolved workspace so a freshly saved list
        // shows up immediately without a plugin reload.
        if (resolved !== undefined) {
          deps.manager.syncDefinitions(deps.store.list())
        }
        sendJson(res, 200, {
          ok: true,
          workspace: resolved ?? null,
          workspaces: deps.store.workspaces(),
          snapshots: deps.manager.snapshot(resolved),
        })
        return
      }

      if (route === '/action' && method === 'POST') {
        const body = await readJson(req)
        const action = str(body, 'action')
        const id = str(body, 'id')
        if (action === undefined || id === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少 action 或 id' })
          return
        }
        if (action === 'start') sendJson(res, 200, await deps.manager.start(id))
        else if (action === 'stop') sendJson(res, 200, await deps.manager.stop(id))
        else if (action === 'restart') sendJson(res, 200, await deps.manager.restart(id))
        else sendJson(res, 400, { ok: false, error: `未知 action: ${action}` })
        return
      }

      if (route === '/logs' && method === 'GET') {
        const id = url.searchParams.get('id')
        if (id === null || id === '') {
          sendJson(res, 400, { ok: false, error: '缺少 id' })
          return
        }
        const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
        const result = deps.manager.logs(id, Number.isFinite(after) ? after : 0)
        if (result === undefined) {
          sendJson(res, 404, { ok: false, error: '服务不存在' })
          return
        }
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      if (route === '/logs/clear' && method === 'POST') {
        const body = await readJson(req)
        const id = str(body, 'id')
        if (id === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少 id' })
          return
        }
        if (!deps.manager.clearLogs(id)) {
          sendJson(res, 404, { ok: false, error: '服务不存在' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }

      if (route === '/detect' && method === 'POST') {
        const body = await readJson(req)
        const workspace = str(body, 'workspace')
        if (workspace === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少 workspace' })
          return
        }
        try {
          const info = await stat(workspace)
          if (!info.isDirectory()) {
            sendJson(res, 400, { ok: false, error: 'workspace 不是目录' })
            return
          }
        } catch {
          sendJson(res, 400, { ok: false, error: `目录不存在：${workspace}` })
          return
        }
        sendJson(res, 200, { ok: true, ...(await detectWorkspace(workspace)) })
        return
      }

      if (route === '/save' && method === 'POST') {
        const body = await readJson(req)
        const workspace = str(body, 'workspace')
        if (workspace === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少 workspace' })
          return
        }
        const rawList = Array.isArray(body.services) ? body.services : []

        // File every entry under the workspace it declares. Rewriting them all
        // into the requested workspace silently moved services between projects
        // whenever the panel's draft did not line up with the request.
        const groups = new Map<string, ServiceDefinition[]>()
        for (const entry of rawList) {
          const record = entry as Record<string, unknown> | null
          const declared = record === null ? undefined : str(record, 'workspace')
          const target = declared ?? workspace
          const definition = normalizeDefinition(entry, target)
          if (definition === undefined) continue
          const bucket = groups.get(definition.workspace) ?? []
          bucket.push(definition)
          groups.set(definition.workspace, bucket)
        }
        if (!groups.has(workspace)) groups.set(workspace, [])

        // `replaceWorkspace` deletes everything the workspace had before writing
        // the draft, so an empty draft wipes the list without a word — refuse
        // that instead of losing services silently.
        for (const [target, definitions] of groups) {
          const existing = deps.store.list(target).length
          if (definitions.length === 0 && existing > 0) {
            sendJson(res, 400, {
              ok: false,
              error: `拒绝用空列表覆盖 ${target} 下已有的 ${existing} 个服务；若确实要清空，请逐个删除后再保存`,
            })
            return
          }
        }

        for (const [target, definitions] of groups) {
          await deps.store.replaceWorkspace(target, definitions)
        }
        deps.manager.syncDefinitions(deps.store.list())
        sendJson(res, 200, { ok: true, services: deps.manager.snapshot(workspace) })
        return
      }

      if (route === '/remove' && method === 'POST') {
        const body = await readJson(req)
        const id = str(body, 'id')
        if (id === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少 id' })
          return
        }
        await deps.manager.stop(id)
        await deps.store.remove(id)
        deps.manager.syncDefinitions(deps.store.list())
        sendJson(res, 200, { ok: true })
        return
      }

      if (route === '/port-owner' && method === 'POST') {
        // POST rather than GET: a port number is data, and this keeps the
        // inspect/release pair symmetric.
        const body = await readJson(req)
        const port = asPort(body.port)
        if (port === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少合法的 port' })
          return
        }
        sendJson(res, 200, { ok: true, owner: (await describePortOwner(port)) ?? null })
        return
      }

      if (route === '/port-release' && method === 'POST') {
        const body = await readJson(req)
        const port = asPort(body.port)
        const pid = asPid(body.pid)
        if (port === undefined || pid === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少合法的 port 或 pid' })
          return
        }
        // releasePort re-checks the pid against a fresh probe, so a port that
        // changed hands in the meantime is reported instead of killed.
        sendJson(res, 200, await releasePort(port, pid))
        return
      }

      if (route === '/reveal-workspaces' && method === 'GET') {
        // Known workspaces plus the one implied by a session, for the picker.
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        const current = await resolveWorkspace(deps, sessionId, undefined)
        const list = deps.store.workspaces()
        if (current !== undefined && !list.some((entry) => samePath(entry, current))) {
          list.push(current)
        }
        sendJson(res, 200, { ok: true, workspaces: list, current: current ?? null })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知路由: ${route}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}
