/**
 * The minimal slice of the Cordis host context this plugin uses.
 *
 * dsh-service-runner deliberately depends on NO `@deepseek-ai/*` package: the
 * desktop profile does not install them under its node_modules, and every
 * import of an internal API is a version-coupling risk. Only the documented
 * seam — `webServer.register` — plus `ctx.effect` and `ctx.get` are touched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One route registration as accepted by `@deepseek-ai/dsh-host-webserver`. */
export interface HostRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The webserver service: named routes, matched exact-first then longest-prefix. */
export interface HostWebServer {
  register(route: HostRoute): () => void
  readonly port?: number
}

/** Host plugin context. */
export interface HostContext {
  webServer: HostWebServer
  /** Non-reactive service lookup (`sessionPersistence` and friends). */
  get(name: string): unknown
  /** Lifecycle hook: the returned disposer runs when the plugin is unloaded. */
  effect(callback: () => (() => void) | void, label?: string): void
}

/** The slice of `sessionPersistence` we read to find a session's workspace. */
export interface SessionPersistenceLike {
  open(
    id: string,
    mode: 'read',
  ): Promise<{
    header?: { cwd?: string } & Record<string, unknown>
    close?: () => Promise<void> | void
  }>
}
