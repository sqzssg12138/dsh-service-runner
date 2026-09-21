/**
 * Edit mode: one inset form card per service.
 *
 * Each field carries its own label (the old version relied on placeholders
 * alone, which is why the configuration read as "not obvious"), and the card
 * header names the service so a long list stays navigable.
 *
 * Detection MERGES into the draft (rather than replacing it) so hand-tuned rows
 * survive a re-scan; duplicates are recognised by command + cwd.
 */
import * as React from 'react'

import type { ServiceDefinition } from '../../host/types.ts'

export interface EditPanelProps {
  workspace: string | null
  manualWorkspace: string
  draft: ServiceDefinition[]
  notes: string[]
  onManualWorkspace: (value: string) => void
  onDraftChange: (next: ServiceDefinition[]) => void
  onDetect: () => void
  onSave: () => void
  onCancel: () => void
}

/** `A=1;B=2` → `{ A: '1', B: '2' }`; empty input means "no variables". */
function textToEnv(text: string): Record<string, string> | undefined {
  const entries = text
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .map((part) => {
      const at = part.indexOf('=')
      return [part.slice(0, at).trim(), part.slice(at + 1)] as const
    })
    .filter(([key]) => key !== '')
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/** Inverse of {@link textToEnv}, for the editor field. */
function envToText(env: Record<string, string> | undefined): string {
  return env === undefined
    ? ''
    : Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join(';')
}

export function EditPanel(props: EditPanelProps): React.ReactElement {
  const { draft } = props
  const target = props.workspace ?? props.manualWorkspace

  const replace = (index: number, patch: Partial<ServiceDefinition>): void => {
    props.onDraftChange(
      draft.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    )
  }

  const remove = (index: number): void => {
    props.onDraftChange(draft.filter((_, position) => position !== index))
  }

  return (
    <>
      <div className="dsr-foot">
        <button type="button" className="dsr-btn" data-kind="primary" onClick={props.onDetect}>
          探测工作区
        </button>
        <button
          type="button"
          className="dsr-btn"
          onClick={() =>
            props.onDraftChange([
              ...draft,
              {
                id: `${target}:新服务${draft.length + 1}`,
                workspace: target,
                name: `新服务${draft.length + 1}`,
                command: '',
                language: 'custom',
                autoDetected: false,
              },
            ])
          }
        >
          ＋ 添加服务
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="dsr-btn" data-kind="primary" onClick={props.onSave}>
          保存
        </button>
        <button type="button" className="dsr-btn" onClick={props.onCancel}>
          取消
        </button>
      </div>

      {props.notes.map((note) => (
        <div className="dsr-hint" key={note}>
          {note}
        </div>
      ))}

      {draft.length === 0 && (
        <div className="dsr-empty">
          列表为空。
          <br />
          点「探测工作区」自动生成候选，或「＋ 添加服务」手写一条。
        </div>
      )}

      {draft.map((entry, index) => (
        <div className="dsr-form" key={`${entry.id}-${index}`}>
          <div className="dsr-form-head">
            <span>#{index + 1}</span>
            <b>{entry.name.trim() === '' ? '未命名服务' : entry.name}</b>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="dsr-remove"
              title="从草稿中删除这一条"
              aria-label="删除这一条"
              onClick={() => remove(index)}
            >
              ×
            </button>
          </div>

          <div className="dsr-field-row">
            <label className="dsr-field" style={{ flex: '0 0 44%' }}>
              <span className="dsr-label">名称</span>
              <input
                className="dsr-input"
                value={entry.name}
                placeholder="面板里显示的名字"
                onChange={(event) => replace(index, { name: event.target.value })}
              />
            </label>
            <label className="dsr-field">
              <span className="dsr-label">端口</span>
              <input
                className="dsr-input"
                value={entry.port ?? ''}
                placeholder="可留空"
                onChange={(event) => {
                  const raw = event.target.value.replace(/[^\d]/g, '')
                  replace(index, { port: raw === '' ? undefined : Number.parseInt(raw, 10) })
                }}
              />
            </label>
            <label className="dsr-field">
              <span className="dsr-label">类型</span>
              <input
                className="dsr-input"
                value={entry.language}
                placeholder="node"
                onChange={(event) =>
                  replace(index, {
                    language: event.target.value as ServiceDefinition['language'],
                  })
                }
              />
            </label>
          </div>

          <label className="dsr-field">
            <span className="dsr-label">启动命令</span>
            <input
              className="dsr-input"
              value={entry.command}
              placeholder={'node ".\\node_modules\\vite\\bin\\vite.js"'}
              onChange={(event) => replace(index, { command: event.target.value })}
            />
          </label>

          <div className="dsr-field-row">
            <label className="dsr-field">
              <span className="dsr-label">工作目录（相对工作区）</span>
              <input
                className="dsr-input"
                value={entry.cwd ?? ''}
                placeholder="留空 = 工作区根目录"
                onChange={(event) =>
                  replace(index, { cwd: event.target.value === '' ? undefined : event.target.value })
                }
              />
            </label>
            <label className="dsr-field" style={{ flex: '0 0 42%' }}>
              <span className="dsr-label">健康检查 URL</span>
              <input
                className="dsr-input"
                value={entry.healthUrl ?? ''}
                placeholder="http://localhost:5174/"
                onChange={(event) =>
                  replace(index, {
                    healthUrl: event.target.value === '' ? undefined : event.target.value,
                  })
                }
              />
            </label>
          </div>

          <label className="dsr-field">
            <span className="dsr-label">环境变量（KEY=VALUE，多个用 ; 分隔）</span>
            <input
              className="dsr-input"
              value={envToText(entry.env)}
              placeholder="JAVA_HOME=C:\jdk17;NODE_ENV=development"
              onChange={(event) => replace(index, { env: textToEnv(event.target.value) })}
            />
          </label>
        </div>
      ))}

      <div className="dsr-foot">
        <label className="dsr-field">
          <span className="dsr-label">工作区目录（绝对路径）</span>
          <input
            className="dsr-input"
            value={props.manualWorkspace}
            placeholder="D:\path\to\project"
            onChange={(event) => props.onManualWorkspace(event.target.value)}
          />
        </label>
      </div>
    </>
  )
}
