/**
 * Does a spawned service pop up a stray terminal window?
 *
 * The question only means anything when the PARENT has no console — that is the
 * Electron host's situation, while this script's own shell has one. So phase 1
 * re-launches this file detached (no console, no inherited stdio) and phase 2,
 * now console-less, spawns the service configurations under test and records
 * each child's window handle. Results land in a JSON file because a console-less
 * phase has nowhere to print.
 *
 *   node scripts/probe-console.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const RESULT = join(tmpdir(), 'dsr-console-probe.json')

/** Two levels deep, the `pnpm run dev` → `vite` shape. */
const COMMAND =
  'node -e "const{spawn}=require(\'child_process\');const c=spawn(process.execPath,[\'-e\',\'setInterval(()=>{},1000)\'],{stdio:\'ignore\'});console.log(\'grandchild=\'+c.pid);setInterval(()=>{},1000)"'

// Phase 1: become console-less, then let phase 2 do the measuring.
if (process.env.DSR_CONSOLELESS !== '1') {
  const child = spawn(process.execPath, [SELF], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, DSR_CONSOLELESS: '1' },
  })
  child.unref()
  console.log(`relaunched console-less (pid ${child.pid}); results → ${RESULT}`)
  process.exit(0)
}

/** Window handle + process name, read through PowerShell. */
function windowInfo(pid) {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $p) { 'gone' } else { "$($p.Id)|$($p.ProcessName)|$($p.MainWindowHandle)|$($p.MainWindowTitle)" }`
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  } catch (error) {
    return `error:${error.message}`
  }
}

/** Consoles attached in this session, to see whether one gets created. */
function conhosts() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-Process conhost -ErrorAction SilentlyContinue | Measure-Object).Count",
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    return Number.parseInt(out.trim(), 10)
  } catch {
    return -1
  }
}

function alive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const cases = [
  ['current shipped config (hide, no detach)', { windowsHide: true, detached: false }],
  ['hide + stdin ignored', { windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'] }],
  ['no hide (control: should have a console)', { windowsHide: false, detached: false }],
]

const report = { consoleless: true, conhostsBefore: conhosts(), cases: [] }

for (const [label, options] of cases) {
  const child = spawn(COMMAND, { shell: true, ...options })
  let out = ''
  child.stdout?.on('data', (chunk) => {
    out += chunk
  })
  child.stderr?.on('data', (chunk) => {
    out += chunk
  })

  await new Promise((resolve) => setTimeout(resolve, 1800))

  const grandchild = /grandchild=(\d+)/.exec(out)
  const entry = {
    label,
    options: JSON.stringify(options),
    shellPid: child.pid,
    capturedOutput: out.slice(0, 120),
    grandchildPid: grandchild === null ? null : Number.parseInt(grandchild[1], 10),
    shellWindow: child.pid === undefined ? 'n/a' : windowInfo(child.pid),
    grandchildWindow:
      grandchild === null ? 'n/a' : windowInfo(Number.parseInt(grandchild[1], 10)),
    conhostsDuring: conhosts(),
  }

  // Tear the tree down and prove the grandchild went with it.
  if (child.pid !== undefined) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.once('exit', resolve)
      killer.once('error', resolve)
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  entry.grandchildAliveAfterKill = entry.grandchildPid === null ? null : alive(entry.grandchildPid)
  report.cases.push(entry)
}

report.conhostsAfter = conhosts()
writeFileSync(RESULT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.exit(0)
