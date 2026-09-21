/**
 * One service row: a readout strip.
 *
 * Lamp, name, nameplate-style language tag, monospaced numbers — then the
 * actions. Primary actions (start/stop) are always legible; the rest sit quiet
 * but *visible* until hover, because "invisible until hover" is exactly what
 * made configuration undiscoverable. Configuration lives here too (`onEdit`),
 * instead of only in the panel header.
 */
import * as React from 'react'

import type { ServiceSnapshot } from '../../host/types.ts'
import { formatDuration, isBusy, STATUS_LABEL } from '../format.ts'

export interface ServiceRowProps {
  service: ServiceSnapshot
  /** Workspace heading to render above this row, when several are in view. */
  groupLabel?: string
  busy: boolean
  expanded: boolean
  /** True while this row's form is open. */
  editing?: boolean
  /** Wall clock, ticked by the container, for the uptime badge. */
  now: number
  onAction: (action: 'start' | 'stop' | 'restart', id: string) => void
  onToggleLog: (id: string) => void
  /** Open the configuration form for this service. */
  onEdit?: (id: string) => void
  onRemove: (id: string) => void
  /** Expanded content (port strip + log). */
  children?: React.ReactNode
}

export function ServiceRow(props: ServiceRowProps): React.ReactElement {
  const { definition, runtime } = props.service
  const uptime =
    runtime.startedAt !== undefined && runtime.status !== 'stopped'
      ? formatDuration((runtime.exitedAt ?? props.now) - runtime.startedAt)
      : undefined
  const port = runtime.detectedPort ?? definition.port
  const stopped = runtime.status === 'stopped'

  return (
    <>
      {props.groupLabel !== undefined && (
        <div className="dsr-group" title={definition.workspace}>
          {props.groupLabel}
        </div>
      )}
      <div
        className="dsr-row"
        data-status={runtime.status}
        data-editing={props.editing === true ? 'true' : undefined}
        title={runtime.error ?? definition.note ?? definition.command}
      >
        <span className="dsr-dot" data-s={runtime.status} />
        <span className="dsr-name">{definition.name}</span>
        <span className="dsr-tag">{definition.language}</span>
        {port !== undefined && <span className="dsr-num dsr-strong">:{port}</span>}
        <span className={uptime === undefined ? 'dsr-num dsr-dim' : 'dsr-num'}>
          {uptime ?? STATUS_LABEL[runtime.status]}
        </span>
        <span className="dsr-actions">
          <button
            type="button"
            className="dsr-icon"
            data-kind="go"
            title="启动"
            aria-label="启动"
            disabled={!stopped && runtime.status !== 'failed'}
            onClick={() => props.onAction('start', definition.id)}
          >
            ▶
          </button>
          <button
            type="button"
            className="dsr-icon"
            data-kind="stop"
            // Enabled after a failure too: stopping an already-dead service is
            // how the user resets the row and kicks off the stray-port sweep.
            title="停止"
            aria-label="停止"
            disabled={stopped || props.busy}
            onClick={() => props.onAction('stop', definition.id)}
          >
            ■
          </button>
          <button
            type="button"
            className="dsr-icon"
            title="重启"
            aria-label="重启"
            disabled={isBusy(runtime.status) || props.busy}
            onClick={() => props.onAction('restart', definition.id)}
          >
            ↻
          </button>
          <button
            type="button"
            className="dsr-icon"
            data-quiet="true"
            title="查看日志"
            aria-label="查看日志"
            onClick={() => props.onToggleLog(definition.id)}
          >
            ▤
          </button>
          {props.onEdit !== undefined && (
            <button
              type="button"
              className="dsr-icon"
              data-quiet="true"
              data-kind="edit"
              title="配置这个服务：命令 / 工作目录 / 端口 / 环境变量 / 健康检查"
              aria-label="配置"
              onClick={() => props.onEdit?.(definition.id)}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className="dsr-icon"
            data-quiet="true"
            data-kind="remove"
            title="从列表中删除该服务（不影响运行中的进程）"
            aria-label="删除"
            onClick={() => props.onRemove(definition.id)}
          >
            ×
          </button>
        </span>
      </div>
      {props.children}
    </>
  )
}
