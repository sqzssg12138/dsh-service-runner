/**
 * An expanded row's log: filter box, clear/download actions, then the lines.
 *
 * The filter is applied here (client-side) rather than on the host so typing
 * never costs a round trip, and the buffer stays whole for the download.
 */
import * as React from 'react'

import type { LogLine } from '../../host/types.ts'
import { formatClock } from '../format.ts'

export interface LogPanelProps {
  lines: LogLine[]
  filter: string
  onFilterChange: (value: string) => void
  onClear: () => void
  onDownload: () => void
}

export function LogPanel(props: LogPanelProps): React.ReactElement {
  const { lines, filter } = props
  const visible =
    filter === '' ? lines : lines.filter((line) => line.text.toLowerCase().includes(filter.toLowerCase()))

  return (
    <>
      <div className="dsr-log-bar">
        <input
          className="dsr-input"
          value={filter}
          placeholder="过滤日志…"
          aria-label="过滤日志"
          onChange={(event) => props.onFilterChange(event.target.value)}
        />
        <button type="button" className="dsr-btn" onClick={props.onClear}>
          清空
        </button>
        <button type="button" className="dsr-btn" onClick={props.onDownload}>
          下载
        </button>
      </div>
      <div className="dsr-log">
        {visible.length === 0
          ? lines.length === 0
            ? '（暂无日志）'
            : '（没有匹配的行）'
          : visible.map((line) => (
              <div className="dsr-log-line" data-stream={line.stream} key={line.seq}>
                <span className="dsr-log-time">{formatClock(line.at)}</span>
                {line.text}
              </div>
            ))}
      </div>
    </>
  )
}
