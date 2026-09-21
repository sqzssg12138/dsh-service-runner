/**
 * Runtime smoke test for the BROWSER half.
 *
 * The client bundle is not a normal module: it calls
 * `window.__ModuleLoader__.load(...)` at evaluation time, so nothing can import
 * it until that global exists. This script fakes the loader (and the few DOM
 * globals the panel touches), evaluates the real built bundle, invokes the
 * plugin's `apply` against a stub slot service, and finally renders the
 * registered component with real React — which is the only way to catch a
 * component-level crash without booting DSH.
 *
 *   node scripts/client-smoke.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const ReactDOMServer = require('react-dom/server')

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`)
}

// ---- browser environment stub -------------------------------------------------
/** Module-loader registrations, captured from the bundle as it runs. */
const loaded = []
/** Style tags the bundle tried to inject. */
const styleTags = []

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded.push(spec)
    },
  },
}
globalThis.document = {
  head: {
    appendChild(node) {
      styleTags.push(node)
    },
  },
  querySelector() {
    return null
  },
  createElement(tag) {
    return { tagName: tag, dataset: {}, textContent: '' }
  },
  addEventListener() {},
  removeEventListener() {},
}
const store = new Map()
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, value),
  removeItem: (key) => store.delete(key),
}

// ---- evaluate the real bundle -------------------------------------------------
require('../lib/client.js')

check('bundle 注册到 ModuleLoader', loaded.length === 1, `count=${loaded.length}`)
const spec = loaded[0]
check('module id 正确', spec?.id === 'dsh-service-runner', String(spec?.id))

const plugin = spec.factory((name) => require(name))
check('导出 apply 函数', typeof plugin.apply === 'function')
check('导出 inject 列表', Array.isArray(plugin.inject), JSON.stringify(plugin.inject))
check('inject 声明 slots', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

// ---- stub the slot service ----------------------------------------------------
let injectedKey
const registrations = []
const ctx = {
  slots: {
    inject(key, callback) {
      injectedKey = key
      return callback()
    },
    register(registration, component) {
      registrations.push({ registration, component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

check('注入到会话头部 actions 槽位', injectedKey === 'conversation.session.header.actions', String(injectedKey))
check('注册了一个条目', registrations.length === 1, `count=${registrations.length}`)
const entry = registrations[0]
check('槽位 name 正确', entry?.registration.name === 'conversation.session.header.actions')
check('槽位 id 正确', entry?.registration.id === 'service-runner', String(entry?.registration.id))
check('order 为 21', entry?.registration.order === 21, String(entry?.registration.order))
check('组件是函数', typeof entry?.component === 'function')
check('注入了样式表', styleTags.length === 1 && String(styleTags[0].textContent).includes('.dsr-menu'))

// ---- render the component with real React -------------------------------------
let html = ''
try {
  html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(entry.component, { sessionId: 'smoke-session' }),
  )
} catch (error) {
  check('组件初次渲染不抛错', false, error instanceof Error ? error.message : String(error))
}
check('渲染出触发按钮', html.includes('dsr-trigger') && html.includes('服务'), `len=${html.length}`)
check('关闭状态不渲染面板', !html.includes('dsr-menu'))

// The open state renders the panel; flip it by rendering after a synthetic click
// is not possible in SSR, so instead ensure the panel markup exists in the CSS
// contract and that the component tolerates a missing sessionId.
let htmlNoSession = ''
try {
  htmlNoSession = ReactDOMServer.renderToStaticMarkup(React.createElement(entry.component, {}))
} catch (error) {
  check('无 sessionId 时渲染不抛错', false, error instanceof Error ? error.message : String(error))
}
check('无 sessionId 时仍渲染按钮', htmlNoSession.includes('dsr-trigger'))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
