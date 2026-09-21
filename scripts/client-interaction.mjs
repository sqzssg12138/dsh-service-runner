/**
 * Interaction smoke test for the panel.
 *
 * Boots the real built bundle inside jsdom, drives it with a mocked host API,
 * and asserts on the rendered panel: the trigger counter, the service rows, the
 * start/stop buttons, the log tail and the edit mode. This exercises the code
 * paths the static render cannot reach (state updates, polling, clicks).
 *
 *   node scripts/client-interaction.mjs
 */
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`)
}

const WORKSPACE = 'D:\\demo\\shop'
const SERVICE_ID = 'abc123def456'

// ---- DOM ----------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:43120/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'MouseEvent',
  'Event',
  'KeyboardEvent',
  'localStorage',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  // Node 26 exposes some of these (navigator) as accessor-only globals, so a
  // plain assignment throws; redefine instead.
  Object.defineProperty(globalThis, key, {
    value: window[key],
    writable: true,
    configurable: true,
  })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ---- host API mock ------------------------------------------------------------
const calls = []
const statePayload = {
  ok: true,
  workspace: WORKSPACE,
  workspaces: [WORKSPACE],
  snapshots: [
    {
      workspace: WORKSPACE,
      name: 'shop',
      services: [        {
          definition: {
            id: SERVICE_ID,
            workspace: WORKSPACE,
            name: 'shop-web',
            command: 'pnpm run dev',
            port: 5174,
            language: 'node',
            autoDetected: true,
          },
          runtime: { status: 'running', pid: 4242, startedAt: Date.now() - 65_000, readyAt: Date.now() - 60_000 },
          logSeq: 2,
        },
        {
          definition: {
            id: 'stoppedservice',
            workspace: WORKSPACE,
            name: 'shop-api',
            command: 'mvn spring-boot:run',
            port: 8080,
            language: 'java',
            autoDetected: true,
          },
          runtime: { status: 'stopped' },
          logSeq: 0,
        },
        {
          definition: {
            id: 'failedservice',
            workspace: WORKSPACE,
            name: 'shop-job',
            command: 'mvn spring-boot:run',
            port: 8082,
            language: 'java',
            autoDetected: true,
          },
          // A dead service whose command never existed: the row must still offer
          // a way out (stop resets it and sweeps the port).
          runtime: { status: 'failed', exitCode: 1, error: '进程异常退出（code 1）' },
          logSeq: 1,
        },
      ],
    },
    {
      // A second workspace, so the panel has to label the groups instead of
      // folding two projects into one indistinguishable list.
      workspace: 'D:\\demo\\api',
      name: 'api',
      services: [
        {
          definition: {
            id: 'apiservice',
            workspace: 'D:\\demo\\api',
            name: 'api-gateway',
            command: 'mvn spring-boot:run',
            port: 9090,
            language: 'java',
            autoDetected: true,
          },
          runtime: { status: 'stopped' },
          logSeq: 0,
        },
      ],
    },
  ],
}

globalThis.fetch = async (url, init) => {
  const text = String(url)
  calls.push({ url: text, method: init?.method ?? 'GET' })
  const json = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })
  if (text.includes('/service-runner/port-owner')) {
    // The running dev server's port is held by "something else" (as in the real
    // 5174/8082 cases) so the panel has an owner to describe and offer to kill.
    return json({
      ok: true,
      owner: { port: 5174, pid: 3316, name: 'java', commandLine: '-agentlib:jdwp=transport=dt_socket,address=127.0.0.1:9709' },
    })
  }
  if (text.includes('/service-runner/port-release')) return json({ ok: true })
  // Must precede the /logs matcher: "/logs/clear" contains "/logs".
  if (text.includes('/service-runner/logs/clear')) return json({ ok: true })
  if (text.includes('/service-runner/state')) return json(statePayload)
  if (text.includes('/service-runner/logs')) {
    return json({
      ok: true,
      lines: [
        { seq: 1, stream: 'stdout', text: 'VITE v8.0.14  ready in 320 ms', at: Date.now() },
        { seq: 2, stream: 'stdout', text: 'Local: http://localhost:5174/', at: Date.now() },
      ],
      logSeq: 2,
      status: 'running',
    })
  }
  if (text.includes('/service-runner/action')) return json({ ok: true })
  if (text.includes('/service-runner/detect')) {
    return json({
      ok: true,
      workspace: WORKSPACE,
      notes: ['自动探测到 1 个服务'],
      candidates: [
        {
          name: 'shop-admin',
          command: 'pnpm run dev:admin',
          port: 5175,
          language: 'node',
          reason: '找到 package.json 的 "dev:admin" 脚本',
        },
      ],
    })
  }
  if (text.includes('/service-runner/save')) return json({ ok: true, services: [] })
  return json({ ok: false, error: `unmocked: ${text}` })
}

// ---- boot the bundle ----------------------------------------------------------
const loaded = []
window.__ModuleLoader__ = { load: (spec) => loaded.push(spec) }
require('../lib/client.js')

const plugin = loaded[0].factory((name) => require(name))
const registrations = []
plugin.apply({
  slots: {
    inject: (_key, callback) => callback(),
    register: (registration, component) => {
      registrations.push({ registration, component })
      return () => {}
    },
  },
})

// ---- render + interact --------------------------------------------------------
const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React

const container = document.getElementById('root')
const root = createRoot(container)

async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }
}

await act(async () => {
  root.render(React.createElement(registrations[0].component, { sessionId: 'smoke-session' }))
})
await settle()

const trigger = container.querySelector('.dsr-trigger')
check('渲染出触发按钮', trigger !== null)
check('显示运行中计数 1', container.querySelector('.dsr-count')?.textContent === '1',
  container.querySelector('.dsr-count')?.textContent ?? '(none)')
check('轮询拉取了 state', calls.some((entry) => entry.url.includes('/service-runner/state')))

// open the panel
await act(async () => {
  trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()

const menu = container.querySelector('.dsr-menu')
check('点击后打开面板', menu !== null)
const rowText = [...container.querySelectorAll('.dsr-row')].map((row) => row.textContent).join(' | ')
check('列出运行中的服务', rowText.includes('shop-web'), rowText)
check('列出已停止的服务', rowText.includes('shop-api'))
const groupTitles = [...container.querySelectorAll('.dsr-group')].map((node) => node.textContent)
check(
  '多工作区时显示分组标题',
  groupTitles.length === 2 && groupTitles.includes('shop') && groupTitles.includes('api'),
  groupTitles.join(' | ') || '(无分组)',
)
check('显示端口', rowText.includes(':5174') && rowText.includes(':8080'))
check('显示运行时长', /1m\d+s/.test(rowText), rowText)
check('显示语言徽章', rowText.includes('node') && rowText.includes('java'))
check('工作区路径可见', container.querySelector('.dsr-ws')?.textContent === WORKSPACE)

// start button disabled while running, enabled while stopped
const rows = [...container.querySelectorAll('.dsr-row')]
const runningRow = rows.find((row) => row.textContent.includes('shop-web'))
const stoppedRow = rows.find((row) => row.textContent.includes('shop-api'))
const buttonOf = (row, label) =>
  [...row.querySelectorAll('.dsr-btn')].find((button) => button.textContent === label)
check('运行中：启动按钮禁用', buttonOf(runningRow, '启动')?.disabled === true)
check('运行中：停止按钮可用', buttonOf(runningRow, '停止')?.disabled === false)
check('已停止：启动按钮可用', buttonOf(stoppedRow, '启动')?.disabled === false)
check('已停止：停止按钮禁用', buttonOf(stoppedRow, '停止')?.disabled === true)

// A failed service must still offer a way out: start to retry, stop to reset the
// row and trigger the stray-port sweep.
const failedRow = rows.find((row) => row.textContent.includes('shop-job'))
check('失败行已渲染', failedRow !== undefined)
check('失败：启动按钮可用（可重试）', failedRow !== undefined && buttonOf(failedRow, '启动')?.disabled === false)
check('失败：停止按钮可用（可复位并回收端口）', failedRow !== undefined && buttonOf(failedRow, '停止')?.disabled === false)

// start the stopped service
await act(async () => {
  buttonOf(stoppedRow, '启动').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
const actionCall = calls.find((entry) => entry.url.includes('/service-runner/action'))
check('点击启动调用了 action 接口', actionCall !== undefined)
check('action 走 POST', actionCall?.method === 'POST')

// expand logs
const logButton = buttonOf(runningRow, '日志')
await act(async () => {
  logButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
const log = container.querySelector('.dsr-log')
check('展开日志区域', log !== null)
check('日志内容渲染', log?.textContent.includes('VITE v8.0.14'), log?.textContent ?? '')
check('增量游标带上了 after 参数', calls.some((entry) => /logs\?id=.*&after=/.test(entry.url)))

// Log tooling: timestamps, filtering, clearing, download affordance.
const clock = container.querySelector('.dsr-log-time')?.textContent ?? ''
check('日志行带时间戳', /^\d{2}:\d{2}:\d{2}$/.test(clock), clock || '(无)')

const filterInput = container.querySelector('.dsr-log-bar .dsr-input')
check('提供日志过滤输入框', filterInput !== undefined)
if (filterInput !== null && filterInput !== undefined) {
  await act(async () => {
    // React's controlled input needs the native value setter to observe a change.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(filterInput, 'this-matches-nothing')
    filterInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await settle()
  check(
    '过滤生效（无匹配时给出提示）',
    container.querySelector('.dsr-log')?.textContent.includes('没有匹配的行') === true,
    container.querySelector('.dsr-log')?.textContent ?? '',
  )
}

const logBarButton = (label) =>
  [...container.querySelectorAll('.dsr-log-bar .dsr-btn')].find((button) => button.textContent === label)
check('提供清空按钮', logBarButton('清空') !== undefined)
check('提供下载按钮', logBarButton('下载') !== undefined)

await act(async () => {
  logBarButton('清空')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
check('清空调用了 /logs/clear', calls.some((entry) => entry.url.includes('/service-runner/logs/clear')))
check('清空后本地日志为空', container.querySelector('.dsr-log')?.textContent.includes('暂无日志') === true)

// Port ownership: name the holder, and make ending it a two-step action.
check(
  '展开后显示端口占用者',
  container.textContent.includes('被 java（pid 3316）占用'),
  container.querySelector('.dsr-port')?.textContent ?? '(无端口条)',
)
const killButton = [...container.querySelectorAll('.dsr-port .dsr-btn')].find(
  (button) => button.textContent === '结束该进程',
)
check('提供「结束该进程」按钮', killButton !== undefined)
await act(async () => {
  killButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
const confirmButton = [...container.querySelectorAll('.dsr-port .dsr-btn')].find(
  (button) => button.textContent === '确认结束',
)
check('第一次点击进入二次确认', confirmButton !== undefined)
await act(async () => {
  confirmButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
check(
  '确认后才调用 port-release',
  calls.some((entry) => entry.url.includes('/service-runner/port-release')),
)

// edit mode + detection
const editButton = [...container.querySelectorAll('.dsr-head .dsr-btn')].find(
  (button) => button.textContent === '编辑',
)
await act(async () => {
  editButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
const detectButton = [...container.querySelectorAll('.dsr-btn')].find(
  (button) => button.textContent === '探测工作区',
)
check('进入编辑模式', detectButton !== undefined)
check('编辑模式列出可编辑行', container.querySelectorAll('.dsr-input').length >= 2)

await act(async () => {
  detectButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
const inputs = [...container.querySelectorAll('.dsr-input')].map((input) => input.value)
check('探测结果并入草稿', inputs.includes('shop-admin'), inputs.join(' | '))
check('探测提示可见', container.textContent.includes('自动探测到 1 个服务'))

// save
const saveButton = [...container.querySelectorAll('.dsr-btn')].find(
  (button) => button.textContent === '保存',
)
await act(async () => {
  saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
check('保存调用 save 接口', calls.some((entry) => entry.url.includes('/service-runner/save')))

await act(async () => {
  root.unmount()
})

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
// Polling timers keep the loop alive; exit explicitly.
process.exit(failures === 0 ? 0 : 1)
