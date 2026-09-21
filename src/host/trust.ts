/**
 * Browser-trust fence for the plugin's routes.
 *
 * Behaviourally the same defence the `/api` gateway and dsh-better-sidebar
 * apply: the request must be bound to a loopback authority, must not carry a
 * cross-site browser marker, and any `Origin` it does carry must name that same
 * hostname.
 *
 * This is a DNS-rebinding / cross-site defence, NOT authentication. A local
 * tool without an Origin header (curl, the smoke scripts) still gets through —
 * that is deliberate, and it is what keeps the panel's own tooling usable. What
 * it stops is a random web page in the user's browser POSTing to
 * `http://127.0.0.1:<port>/service-runner/action` and starting or killing
 * processes on their machine.
 */
import type { IncomingMessage } from 'node:http'

/** Read a header as a plain string (node may give arrays/undefined). */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Whether a hostname names the local loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Decide whether one request may reach the plugin routes.
 *
 * Comparisons are on the HOSTNAME, not host:port — some Chromium builds
 * serialize the Origin of a non-default-port loopback page without the port
 * (`http://127.0.0.1`), and requiring an exact match would reject the panel's
 * own fetch calls. The Host fence above has already bound the authority.
 */
export function isTrustedRequest(request: IncomingMessage): boolean {
  const host = header(request, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (header(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request, 'origin')
  // No Origin is fine: a non-browser client, and the Host fence already bound
  // the request to loopback.
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
