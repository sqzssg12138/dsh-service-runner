/**
 * The session-header action: a status dot plus the service panel.
 *
 * Reads nothing from the shell beyond `sessionId` — the workspace path, the
 * service list and every log line come from the plugin's own host routes, so
 * the panel works the same whether the conversation is fresh or restored.
 *
 * This file owns state and orchestration only: the row/log/edit pieces live in
 * `./components` and the pure formatters in `./format`.
 */
import * as React from 'react'

import type {
  LogLine,
  PortOwner,
  ServiceDefinition,
  ServiceSnapshot,
  WorkspaceSnapshot,
} from '../host/types.ts'
import { api } from './api.ts'
import { EditPanel } from './components/EditPanel.tsx'
import { LogPanel } from './components/LogPanel.tsx'
import { PortBar } from './components/PortBar.tsx'
import { ServiceRow } from './components/ServiceRow.tsx'
import { messageOf, workspaceLabel } from './format.ts'

/** Standard props handed to a `conversation.session.header.actions` entry. */
export interface ActionProps {
  sessionId?: string
  /** Locale lookup; unused by this panel (copy is Chinese-first). */
  t?: (key: string) => string
  [key: string]: unknown
}

/** Where the user's chosen workspace path is remembered. */
const WORKSPACE_KEY = 'dsr.workspace'

/** Maximum log lines kept in the browser per service. */
const CLIENT_LOG_LIMIT = 800

export function ServiceRunnerAction(props: ActionProps): React.ReactElement {
  const sessionId = props.sessionId
  const [open, setOpen] = React.useState(false)
  const [workspace, setWorkspace] = React.useState<string | null>(null)
  const [snapshots, setSnapshots] = React.useState<WorkspaceSnapshot[]>([])
  const [knownWorkspaces, setKnownWorkspaces] = React.useState<string[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [busyIds, setBusyIds] = React.useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [logs, setLogs] = React.useState<Record<string, LogLine[]>>({})
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState<ServiceDefinition[]>([])
  const [notes, setNotes] = React.useState<string[]>([])
  const [manualWorkspace, setManualWorkspace] = React.useState<string>(() => {
    try {
      return localStorage.getItem(WORKSPACE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [now, setNow] = React.useState(() => Date.now())
  /** Workspace switcher popover in the panel header. */
  const [wsOpen, setWsOpen] = React.useState(false)
  const wsRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!wsOpen) return
    const onDown = (event: MouseEvent): void => {
      if (wsRef.current?.contains(event.target as Node) === true) return
      setWsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [wsOpen])
  /** Port holder per service id; `undefined` = not inspected yet, `null` = free. */
  const [portOwners, setPortOwners] = React.useState<Record<string, PortOwner | null | undefined>>({})
  /** Service id whose "end that process" button is awaiting confirmation. */
  const [confirmingPort, setConfirmingPort] = React.useState<string | null>(null)
  /** Case-insensitive substring filter applied to the expanded log. */
  const [logFilter, setLogFilter] = React.useState('')

  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const logCursorRef = React.useRef<Record<string, number>>({})

  /** Services of the workspace currently in view (host returns just that one). */
  const services = React.useMemo(
    () => snapshots.flatMap((snapshot) => snapshot.services),
    [snapshots],
  )

  /**
   * Latest services for callbacks that must not re-subscribe on every poll.
   *
   * The state poll rebuilds `services` every 1.5s; reading it through a ref
   * keeps the port-inspection effect keyed on the expanded row alone.
   */
  const servicesRef = React.useRef<ServiceSnapshot[]>([])
  servicesRef.current = services
  const runningCount = services.filter(
    (service) => service.runtime.status === 'running' || service.runtime.status === 'starting',
  ).length

  /** Pull the aggregate state. */
  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const result = await api.state(sessionId, manualWorkspace === '' ? undefined : manualWorkspace)
      setWorkspace(result.workspace)
      setSnapshots(result.snapshots)
      setKnownWorkspaces(result.workspaces)
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [sessionId, manualWorkspace])

  // Poll: fast while the panel is open, slow while it is closed (the trigger's
  // counter must stay truthful without hammering the host).
  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), open ? 1500 : 5000)
    return () => clearInterval(timer)
  }, [refresh, open])

  // Wall clock for the uptime badge.
  React.useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])

  // Incremental log tail while a row is expanded.
  React.useEffect(() => {
    if (expanded === null) return
    let alive = true
    const id = expanded
    const pull = async (): Promise<void> => {
      try {
        const after = logCursorRef.current[id] ?? 0
        const result = await api.logs(id, after)
        if (!alive) return
        logCursorRef.current[id] = result.logSeq
        if (result.lines.length > 0) {
          setLogs((previous) => {
            const merged = [...(previous[id] ?? []), ...result.lines]
            return { ...previous, [id]: merged.slice(-CLIENT_LOG_LIMIT) }
          })
        }
      } catch {
        /* service removed mid-stream: the next state poll drops the row */
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [expanded])

  // Click / Escape outside closes the menu, matching the shell's popovers.
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Inspect a service's port when its row is expanded. The owner is what makes
  // "port already in use" actionable — an IDE debug session and a leftover dev
  // server look identical until you can see which process it is.
  React.useEffect(() => {
    if (expanded === null) return
    const id = expanded
    const service = servicesRef.current.find((item) => item.definition.id === id)
    const port = service?.runtime.detectedPort ?? service?.definition.port
    if (port === undefined) return
    let alive = true
    void (async () => {
      try {
        const result = await api.portOwner(port)
        if (alive) setPortOwners((previous) => ({ ...previous, [id]: result.owner }))
      } catch {
        /* inspection is best-effort: never block the panel on it */
      }
    })()
    return () => {
      alive = false
    }
  }, [expanded])

  /** Persist the manually typed workspace so the next session starts there. */
  const commitManualWorkspace = (value: string): void => {
    setManualWorkspace(value)
    try {
      localStorage.setItem(WORKSPACE_KEY, value)
    } catch {
      /* storage disabled: the value still lives in component state */
    }
  }

  /** start / stop / restart with per-row busy feedback. */
  const runAction = async (action: 'start' | 'stop' | 'restart', id: string): Promise<void> => {
    setBusyIds((previous) => ({ ...previous, [id]: true }))
    try {
      await api.action(action, id)
      await refresh()
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusyIds((previous) => ({ ...previous, [id]: false }))
    }
  }

  /** Enter edit mode with the current definitions. */
  const beginEdit = (): void => {
    setDraft(services.map((service) => ({ ...service.definition })))
    setNotes([])
    setEditing(true)
  }

  /** Merge detection candidates into the draft (skipping duplicates). */
  const detect = async (): Promise<void> => {
    const target = workspace ?? manualWorkspace
    if (target === '') {
      setError('请先填写工作区目录')
      return
    }
    try {
      const result = await api.detect(target)
      const found = result.candidates ?? []
      setNotes(result.notes ?? [])
      setDraft((previous) => {
        const merged = [...previous]
        for (const candidate of found) {
          const duplicate = merged.some(
            (entry) => entry.command === candidate.command && (entry.cwd ?? '') === (candidate.cwd ?? ''),
          )
          if (duplicate) continue
          merged.push({
            id: `${target}:${candidate.name}`,
            workspace: target,
            name: candidate.name,
            command: candidate.command,
            cwd: candidate.cwd,
            port: candidate.port,
            language: candidate.language,
            autoDetected: true,
            note: candidate.reason,
          })
        }
        return merged
      })
      if (found.length === 0) setError('未探测到新的可运行服务')
      else setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }

  /** Persist the draft and leave edit mode. */
  const saveDraft = async (): Promise<void> => {
    const target = workspace ?? manualWorkspace
    if (target === '') {
      setError('请先填写工作区目录')
      return
    }
    try {
      await api.save(target, draft)
      setEditing(false)
      await refresh()
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }

  /** Clear a service's log buffer, locally and on the host. */
  const clearServiceLogs = async (id: string): Promise<void> => {
    try {
      await api.clearLogs(id)
      // The host keeps incrementing `seq`, so the pull cursor stays valid and
      // only the local copy needs dropping.
      setLogs((previous) => ({ ...previous, [id]: [] }))
    } catch (caught) {
      setError(messageOf(caught))
    }
  }

  /** Save the buffered lines as a file the user can keep or send on. */
  const downloadLogs = (name: string, id: string): void => {
    const lines = logs[id] ?? []
    const text = lines
      .map((line) => `${new Date(line.at).toISOString()} [${line.stream}] ${line.text}`)
      .join('\n')
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${name}.log`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('当前环境不支持下载日志')
    }
  }

  /** Re-read the current holder of a port. */
  const refreshPortOwner = async (id: string, port: number): Promise<void> => {
    try {
      const result = await api.portOwner(port)
      setPortOwners((previous) => ({ ...previous, [id]: result.owner }))
    } catch (caught) {
      setError(messageOf(caught))
    }
  }

  /**
   * End the process holding the port. Two-step on purpose (the button asks for
   * confirmation first) and the host re-checks the pid, so a port that changed
   * hands between render and click is reported instead of killed.
   */
  const releasePortOwner = async (id: string, port: number, pid: number): Promise<void> => {
    setBusyIds((previous) => ({ ...previous, [id]: true }))
    try {
      await api.portRelease(port, pid)
      setConfirmingPort(null)
      setPortOwners((previous) => ({ ...previous, [id]: null }))
      await refresh()
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
      await refreshPortOwner(id, port)
    } finally {
      setBusyIds((previous) => ({ ...previous, [id]: false }))
    }
  }

  /** Remove one definition outright (edit mode has its own row delete). */
  const removeService = async (id: string): Promise<void> => {
    try {
      await api.remove(id)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    }
  }

  const trigger = (
    <button
      type="button"
      className="dsr-trigger"
      data-open={open ? 'true' : 'false'}
      title="工作区服务"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="dsr-dot" data-s={runningCount > 0 ? 'running' : 'stopped'} />
      <span>服务</span>
      {runningCount > 0 && <span className="dsr-count">{runningCount}</span>}
    </button>
  )

  if (!open) return <div className="dsr-root">{trigger}</div>

  return (
    <div className="dsr-root" ref={rootRef}>
      {trigger}
      <div className="dsr-menu" role="dialog" aria-label="工作区服务">
        <div className="dsr-head">
          <span className="dsr-ws" title={workspace ?? '未确定工作区'}>
            {workspace === null ? '未确定工作区' : workspaceLabel(workspace)}
          </span>
          <span style={{ flex: 1 }} />
          {knownWorkspaces.length > 1 && (
            <div className="dsr-pick" ref={wsRef}>
              <button
                type="button"
                className="dsr-pick-btn"
                data-open={wsOpen ? 'true' : undefined}
                title={workspace ?? '选择工作区'}
                aria-haspopup="listbox"
                aria-expanded={wsOpen}
                onClick={() => setWsOpen((value) => !value)}
              >
                <span>切换</span>
                <span className="dsr-pick-caret">▾</span>
              </button>
              {wsOpen && (
                <ul className="dsr-pick-menu" role="listbox" aria-label="选择工作区">
                  {knownWorkspaces.map((entry) => (
                    <li key={entry}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={entry === workspace}
                        className="dsr-pick-item"
                        data-current={entry === workspace ? 'true' : undefined}
                        title={entry}
                        onClick={() => {
                          commitManualWorkspace(entry)
                          setWsOpen(false)
                        }}
                      >
                        <span className="dsr-pick-check">{entry === workspace ? '✓' : ''}</span>
                        <span className="dsr-pick-name">{workspaceLabel(entry)}</span>
                        <span className="dsr-pick-path">{entry}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <button type="button" className="dsr-btn" onClick={() => void refresh()} title="刷新状态">
            刷新
          </button>
          {!editing && (
            <button
              type="button"
              className="dsr-btn"
              data-kind="primary"
              onClick={beginEdit}
              title="编辑服务列表（每行的 ✎ 也能直接进入配置）"
            >
              ✎ 编辑
            </button>
          )}
        </div>

        <div className="dsr-body">
          {error !== null && <div className="dsr-error">{error}</div>}

          {workspace === null && !editing && (
            <div className="dsr-hint">
              未能从会话推断工作区目录。请填写项目根目录（例如 D:\work\my-project），
              然后点「编辑 → 探测」自动生成服务列表。
            </div>
          )}

          {editing ? (
            <EditPanel
              workspace={workspace}
              manualWorkspace={manualWorkspace}
              draft={draft}
              notes={notes}
              onManualWorkspace={commitManualWorkspace}
              onDraftChange={setDraft}
              onDetect={() => void detect()}
              onSave={() => void saveDraft()}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              {services.length === 0 && (
                <div className="dsr-empty">
                  当前工作区没有已保存的服务。
                  <br />
                  点右上「编辑」→「探测工作区」自动生成。
                </div>
              )}
              {services.map((service, index) => {
                const id = service.definition.id
                const isExpanded = expanded === id
                const port = service.runtime.detectedPort ?? service.definition.port
                const previous = services[index - 1]
                // Only worth a heading when more than one workspace is in view: the
                // panel folds them into a single list, and rows from different
                // projects would otherwise be indistinguishable.
                const groupLabel =
                  snapshots.length > 1 && previous?.definition.workspace !== service.definition.workspace
                    ? workspaceLabel(service.definition.workspace)
                    : undefined
                return (
                  <ServiceRow
                    key={id}
                    service={service}
                    groupLabel={groupLabel}
                    busy={busyIds[id] === true}
                    expanded={isExpanded}
                    now={now}
                    onAction={(action, serviceId) => void runAction(action, serviceId)}
                    onToggleLog={(serviceId) => setExpanded(isExpanded ? null : serviceId)}
                    onEdit={() => beginEdit()}
                    onRemove={(serviceId) => void removeService(serviceId)}
                  >
                    {isExpanded && port !== undefined && (
                      <PortBar
                        port={port}
                        owner={portOwners[id]}
                        confirming={confirmingPort === id}
                        busy={busyIds[id] === true}
                        onAsk={() => setConfirmingPort(id)}
                        onCancel={() => setConfirmingPort(null)}
                        onConfirm={(pid) => void releasePortOwner(id, port, pid)}
                        onRefresh={() => void refreshPortOwner(id, port)}
                      />
                    )}
                    {isExpanded && (
                      <LogPanel
                        lines={logs[id] ?? []}
                        filter={logFilter}
                        onFilterChange={setLogFilter}
                        onClear={() => void clearServiceLogs(id)}
                        onDownload={() => downloadLogs(service.definition.name, id)}
                      />
                    )}
                  </ServiceRow>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
