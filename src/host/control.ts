/**
 * Local control API for this plugin.
 *
 * The plugin's own HTTP surface is registered on the harness webserver, which
 * refuses any request that is not the Electron renderer — so no script, CLI or
 * automated check can drive it, and every verification becomes a manual GUI
 * dance. This listener is deliberately separate: **loopback only, token-guarded,
 * and optional** (a busy port simply leaves the plugin without it).
 *
 * The port and token are published to
 * `<harness home>/service-runner/control.json` so a local tool can discover them
 * instead of being told:
 *
 *   const { port, token } = JSON.parse(fs.readFileSync(controlJson, 'utf8'))
 *   await fetch(`http://127.0.0.1:${port}/state`, {
 *     headers: { authorization: `Bearer ${token}` },
 *   })
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'

import { dshHome } from './store.ts'

/** Preferred port; a busy one disables the API rather than moving it silently. */
const DEFAULT_PORT = 4519

/** Bodies are small control payloads; anything larger is a bug or an attack. */
const MAX_BODY_BYTES = 256 * 1024

/** Where the port and token are published for local tools. */
export function controlStatePath(): string {
  return join(dshHome(), 'service-runner', 'control.json')
}

/** What the API can do, supplied by the plugin. */
export interface ControlHandlers {
  state: () => unknown
  action: (action: string, id: string) => Promise<unknown>
  logs: (id: string, after: number) => unknown
}

/** A running control listener. */
export interface ControlApi {
  port: number
  token: string
  close: () => void
}

/** Read a whole request body as text, refusing oversized ones. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Constant-time token comparison. */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Start the listener.
 *
 * @returns the running API, or `undefined` when the port cannot be bound — the
 *   plugin must keep working either way.
 */
export async function startControlApi(
  handlers: ControlHandlers,
  preferredPort = DEFAULT_PORT,
): Promise<ControlApi | undefined> {
  const token = randomBytes(24).toString('base64url')

  const send = (response: ServerResponse, status: number, payload: unknown): void => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(payload))
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const header = request.headers.authorization
      const bearer =
        typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
      if (!tokenMatches(token, bearer ?? url.searchParams.get('token') ?? undefined)) {
        send(response, 401, { ok: false, error: 'unauthorized' })
        return
      }
      const method = (request.method ?? 'GET').toUpperCase()
      try {
        if (url.pathname === '/state' && method === 'GET') {
          send(response, 200, { ok: true, ...(handlers.state() as object) })
          return
        }
        if (url.pathname === '/action' && method === 'POST') {
          const raw = await readBody(request)
          const body = (raw.trim() === '' ? {} : JSON.parse(raw)) as Record<string, unknown>
          const action = typeof body.action === 'string' ? body.action : undefined
          const id = typeof body.id === 'string' ? body.id : undefined
          if (action === undefined || id === undefined) {
            send(response, 400, { ok: false, error: 'action and id are required' })
            return
          }
          send(response, 200, { ok: true, result: await handlers.action(action, id) })
          return
        }
        if (url.pathname === '/logs' && method === 'GET') {
          const id = url.searchParams.get('id')
          if (id === null || id === '') {
            send(response, 400, { ok: false, error: 'id is required' })
            return
          }
          const parsed = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
          const result = handlers.logs(id, Number.isFinite(parsed) ? parsed : 0)
          if (result === undefined) {
            send(response, 404, { ok: false, error: 'unknown service' })
            return
          }
          send(response, 200, { ok: true, ...(result as object) })
          return
        }
        send(response, 404, { ok: false, error: `unknown route: ${url.pathname}` })
      } catch (error) {
        send(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  })

  const bound = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(preferredPort, '127.0.0.1', () => resolve(true))
  })
  if (!bound) {
    try {
      server.close()
    } catch {
      /* never bound */
    }
    return undefined
  }

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : preferredPort
  try {
    const statePath = controlStatePath()
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      `${JSON.stringify({ port, token, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    /* discovery is a convenience; the API works even if it cannot be published */
  }

  return {
    port,
    token,
    close: () => {
      try {
        server.close()
      } catch {
        /* already closed */
      }
    },
  }
}
