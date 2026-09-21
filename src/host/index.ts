/**
 * dsh-service-runner — host half.
 *
 * A Cordis plugin that owns a workspace service process pool and publishes it
 * over `/service-runner/*` for the browser panel to drive.
 *
 * The host half is intentionally dependency-free: only `node:` builtins plus
 * the `webServer` seam documented by `@deepseek-ai/dsh-host-webserver`.
 */
import { startControlApi, type ControlApi } from './control.ts'
import type { HostContext } from './context.ts'
import { ServiceManager } from './manager.ts'
import { createHandler, ROUTE_PREFIX } from './routes.ts'
import { dshHome, ServiceStore } from './store.ts'

/** Services this plugin needs before it can activate. */
export const inject = ['webServer']

/** Plugin name, surfaced in cordis diagnostics. */
export const name = 'dsh-service-runner'

/**
 * Plugin body.
 *
 * Everything lives inside one `ctx.effect`, so a reload (or HMR re-activation)
 * tears the routes down and stops every child process before the new instance
 * takes over — no orphaned dev servers holding ports.
 */
export function apply(ctx: HostContext): void {
  const store = new ServiceStore()
  const manager = new ServiceManager()

  // Definitions are loaded lazily on the first HTTP call: activation must stay
  // fast and must not touch the filesystem before the webserver is listening.
  let ready: Promise<void> | undefined
  const ensureReady = (): Promise<void> => {
    if (ready === undefined) {
      ready = (async () => {
        await store.load()
        manager.syncDefinitions(store.list())
        // Follow later edits to the file, so a hand edit — or another tool's
        // write — reaches the panel without restarting the harness.
        store.watch(() => manager.syncDefinitions(store.list()))
        // Reap anything a previous activation started and never got to stop: a
        // hard kill gives no chance to run the dispose hook, and those processes
        // keep holding their ports while the panel cannot see them.
        await manager.reapPersistedRuns()
      })()
    }
    return ready
  }

  ctx.effect(() => {
    const handler = createHandler({ ctx, store, manager, ensureReady })
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    })
    // Activation evidence: the host log only receives logger output, so the
    // plugin records its own activation next to the service list. This makes
    // "did the live patch layer actually mount me?" answerable from outside the
    // process, without the GUI or its launch token.
    void recordActivation()

    // A second, separate listener for local tools: the routes above sit behind
    // the harness's renderer gate, so nothing scriptable can reach them. Port and
    // token are published under the harness home; a busy port just disables it.
    let control: ControlApi | undefined
    void startControlApi({
      state: () => ({ workspaces: store.workspaces(), snapshots: manager.snapshot() }),
      action: (action, id) => {
        if (action === 'start') return manager.start(id)
        if (action === 'stop') return manager.stop(id)
        if (action === 'restart') return manager.restart(id)
        return Promise.resolve({ ok: false, error: `unknown action: ${action}` })
      },
      logs: (id, after) => manager.logs(id, after),
    })
      .then((api) => {
        control = api
        if (api === undefined) {
          console.warn('service-runner: 本地控制 API 未启用（端口被占用或不可用）')
          return
        }
        console.info(`service-runner: 本地控制 API 已监听 127.0.0.1:${api.port}`)
      })
      .catch(() => {
        /* the API is optional: never fail activation over it */
      })

    return () => {
      dispose()
      control?.close()
      // The watcher is ours as well: left behind it would hold the directory
      // handle and fire reloads into a disposed store.
      store.dispose()
      // Children are ours: leaving them running would leak a dev server onto a
      // port that the next activation cannot see or stop.
      void manager.disposeAll()
    }
  }, 'dsh-service-runner: routes')
}

/** Append-free activation marker: one file, rewritten on every activation. */
async function recordActivation(): Promise<void> {
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const path = join(dshHome(), 'service-runner', 'host-activated.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), route: ROUTE_PREFIX }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // Diagnostic only: never fail activation over a marker file.
  }
}
