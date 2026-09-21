/**
 * Inspect what the detector proposes for a real workspace, without booting DSH.
 *
 * The detector is bundled on the fly so this stays a single command:
 *
 *   node scripts/probe-detect.mjs "D:\path\to\workspace"
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const workspace = process.argv[2] ?? process.cwd()
const out = join(await mkdtemp(join(tmpdir(), 'dsr-detect-')), 'detect.mjs')

await build({
  entryPoints: ['src/host/detect.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})

const { detectWorkspace } = await import(pathToFileURL(out).href)
const result = await detectWorkspace(workspace)

console.log(`workspace: ${workspace}`)
console.log(`candidates: ${result.candidates.length}\n`)
for (const candidate of result.candidates) {
  console.log(`[${candidate.language}] ${candidate.name}`)
  console.log(`    command: ${candidate.command}`)
  console.log(`    cwd    : ${candidate.cwd ?? '(workspace root)'}`)
  console.log(`    port   : ${candidate.port ?? '-'}`)
  console.log(`    reason : ${candidate.reason}`)
}
for (const note of result.notes) console.log(`note: ${note}`)
