/**
 * Diagnostics for the browser-module channel of a running DSH instance.
 *
 * The shell's index.html is behind the browser-auth fence, and `/plugins`
 * serves ONLY the exact revisioned URLs the boot payload advertises — a bare
 * `/plugins/<id>/client.js` is a guaranteed 404. This script therefore
 * authenticates with the launch token, captures the cookie, harvests the real
 * bundle URLs out of the injected boot payload, and probes each one.
 *
 *   node scripts/probe-bundles.mjs http://127.0.0.1:43199 <launch-token>
 */
const base = process.argv[2] ?? 'http://127.0.0.1:43199'
const token = process.argv[3]

/** Minimal cookie jar: the token grant is returned as a Set-Cookie. */
const jar = new Map()
function cookieHeader() {
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
}

async function request(path) {
  const response = await fetch(base + path, {
    redirect: 'manual',
    headers: jar.size > 0 ? { cookie: cookieHeader() } : {},
  })
  const setCookies = response.headers.getSetCookie?.() ?? []
  for (const raw of setCookies) {
    const pair = raw.split(';', 1)[0]
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  return response
}

const indexPath = token === undefined ? '/' : `/?token=${encodeURIComponent(token)}`
let index = await request(indexPath)
let html = await index.text()
// A valid token answers with a 303 to the clean URL plus the auth cookie.
if (index.status >= 300 && index.status < 400) {
  console.log(`index: ${index.status} → 跟随重定向（cookie 已获取）`)
  index = await request('/')
  html = await index.text()
}
console.log(`index: ${index.status}  len=${html.length}  cookies=${jar.size}`)
if (index.status !== 200) {
  console.log('index 不可读，无法枚举 bundle')
  process.exit(1)
}

// The boot payload is injected inline; harvest every revisioned plugin URL
// from the page rather than guessing the URL shape.
const urls = [...new Set([...html.matchAll(/\/plugins\/[^"'\\\s)]+/g)].map((match) => match[0]))]
console.log(`--- 发现 ${urls.length} 个 bundle URL ---`)
for (const url of urls) {
  const trimmed = url.length > 150 ? `${url.slice(0, 150)}…` : url
  console.log('   ', trimmed)
}

const mine = urls.filter((url) => url.includes('dsh-service-runner'))
console.log(`--- 属于本插件的 URL: ${mine.length} ---`)

console.log('--- 探测 ---')
for (const url of [...mine, ...urls.filter((entry) => !mine.includes(entry)).slice(0, 3)]) {
  const response = await request(url)
  const body = await response.text()
  const marker = body.includes('__ModuleLoader__') ? 'ModuleLoader ✓' : 'no-loader ✗'
  const hasApply = body.includes('apply') ? 'apply ✓' : 'apply ✗'
  console.log(
    String(response.status).padEnd(4),
    (url.length > 90 ? `${url.slice(0, 90)}…` : url).padEnd(92),
    `len=${String(body.length).padEnd(7)}`,
    marker,
    hasApply,
  )
}
