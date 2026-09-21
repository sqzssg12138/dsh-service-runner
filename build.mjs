/**
 * Build script for dsh-service-runner.
 *
 * Produces two artifacts:
 *   lib/index.js   — the HOST half: a plain Node ESM Cordis plugin.
 *   lib/client.js  — the BROWSER half: a CJS bundle wrapped in the DSH
 *                    `window.__ModuleLoader__.load({ id, factory })` envelope
 *                    the web shell executes.
 *
 * React is kept EXTERNAL in the client bundle on purpose: the shell already
 * seeds `react` in its platform module table, and inlining a second React
 * would give the plugin its own dispatcher (hooks would break).
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

/** Must match package.json "name": the browser module id the shell resolves. */
const PLUGIN_ID = 'dsh-service-runner'

const hostOptions = {
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  // Everything host-side is either a `node:` builtin or injected through the
  // Cordis context, so the only externals are the builtins themselves.
  external: ['node:*'],
  logLevel: 'info',
}

const clientOptions = {
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Classic transform keeps `react/jsx-runtime` out of the picture entirely.
  jsx: 'transform',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'info',
}

/** Indent every non-empty line so the bundle nests inside the factory body. */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? line : pad + line))
    .join('\n')
}

/** Wrap the CJS bundle in the module-loader envelope the web shell expects. */
function wrapClient(code) {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indent(code, 2)}
\t\treturn module.exports;
\t}
});
`
}

async function buildClient() {
  const result = await build(clientOptions)
  const code = result.outputFiles[0].text
  await writeFile('lib/client.js', wrapClient(code), 'utf8')
  console.log('[build] lib/client.js written')
}

async function main() {
  await mkdir('lib', { recursive: true })
  await build(hostOptions)
  console.log('[build] lib/index.js written')
  await buildClient()
}

main().catch((error) => {
  console.error('[build] failed:', error)
  process.exitCode = 1
})
