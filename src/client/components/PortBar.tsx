/**
 * The port-ownership strip shown above an expanded row's log.
 *
 * "Port already in use" is only actionable once the user can see WHICH process
 * holds it, so the owner's name/pid are shown inline (full command line on
 * hover) and ending it is a deliberate two-step action.
 */
import * as React from 'react'

import type { PortOwner } from '../../host/types.ts'

export interface PortBarProps {
  port: number
  /** `undefined` = not inspected yet, `null` = nothing is listening. */
  owner: PortOwner | null | undefined
  /** True once the user asked to end the owner and must confirm. */
  confirming: boolean
  busy: boolean
  onAsk: () => void
  onCancel: () => void
  onConfirm: (pid: number) => void
  onRefresh: () => void
}

export function PortBar(props: PortBarProps): React.ReactElement {
  const { port, owner, confirming, busy } = props
  return (
    <div className="dsr-port">
      {owner === undefined ? (
        <span className="dsr-port-muted">正在检查端口 {port}…</span>
      ) : owner === null ? (
        <span className="dsr-port-muted">端口 {port} 当前空闲</span>
      ) : (
        <>
          <span className="dsr-port-busy" title={owner.commandLine ?? undefined}>
            端口 {port} 被 {owner.name}（pid {owner.pid}）占用
          </span>
          {confirming ? (
            <>
              <button
                type="button"
                className="dsr-btn"
                data-kind="danger"
                disabled={busy}
                onClick={() => props.onConfirm(owner.pid)}
              >
                确认结束
              </button>
              <button type="button" className="dsr-btn" onClick={props.onCancel}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="dsr-btn" data-kind="danger" onClick={props.onAsk}>
              结束该进程
            </button>
          )}
        </>
      )}
      <button type="button" className="dsr-btn" onClick={props.onRefresh}>
        重新检查
      </button>
    </div>
  )
}
