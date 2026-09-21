/**
 * Presentation helpers for the panel.
 *
 * Kept out of the container component so the row/log/edit pieces stay pure and
 * the container only has to own state and orchestration.
 */
import type { ServiceSnapshot } from '../host/types.ts'

/** Status copy shown in the row title attribute. */
export const STATUS_LABEL: Record<ServiceSnapshot['runtime']['status'], string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  failed: '失败',
}

/** Human duration for the `2m31s` style badge. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${total % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/** Wall-clock `HH:MM:SS` for a log line — without it, ordering is guesswork. */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Last path segment of a workspace root, for the group heading. */
export function workspaceLabel(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? trimmed
}

/** Error → display string. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a runtime is in a state the user can act on. */
export function isBusy(status: ServiceSnapshot['runtime']['status']): boolean {
  return status === 'starting' || status === 'stopping'
}
