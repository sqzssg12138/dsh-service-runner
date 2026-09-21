/**
 * Small process helper shared by the manager and the port inspector.
 *
 * Both need to shell out (taskkill, PowerShell probing) and read a little
 * stdout. Neither may ever reject: a failed diagnostic must not take down a
 * service action.
 */
import { spawn } from 'node:child_process'

/** Run a command and collect its stdout, resolving '' on any failure. */
export function runCapture(command: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(output)
    }
    try {
      const child = spawn(command, args, { windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        finish()
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      child.once('exit', () => {
        clearTimeout(timer)
        finish()
      })
      child.once('error', () => {
        clearTimeout(timer)
        finish()
      })
    } catch {
      finish()
    }
  })
}

/** Run a command and report whether it exited 0. */
export function runQuietly(command: string, args: string[], timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => {
        child.kill()
        finish(false)
      }, timeoutMs)
      timer.unref?.()
      child.once('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0)
      })
      child.once('error', () => {
        clearTimeout(timer)
        finish(false)
      })
    } catch {
      finish(false)
    }
  })
}
