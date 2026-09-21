/**
 * Persistence for service definitions.
 *
 * A plain JSON file under the DSH home keeps the plugin dependency-free (no
 * storage service to reach for) and makes the list trivially inspectable and
 * hand-editable by the user:
 *
 *   <DSH_HOME>/service-runner/services.json
 *
 * Writes are atomic (temp file + rename) so a crash mid-save cannot leave a
 * truncated list behind — the panel would then show an empty workspace.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ServiceDefinition } from './types.ts'

/** Runtime data root; DSH exports it, with a homedir fallback for tests. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Absolute path of the definitions file. */
export function storePath(): string {
  return join(dshHome(), 'service-runner', 'services.json')
}

/**
 * Stable id for a (workspace, name) pair.
 *
 * Hashing instead of slugging keeps ids collision-free for same-named services
 * in different sub-projects, and stable across DSH restarts — which is what
 * lets the runtime log buffer and the saved list line up after a re-detect.
 */
export function serviceId(workspace: string, name: string): string {
  const digest = createHash('sha1').update(`${workspace}\n${name}`).digest('hex')
  return digest.slice(0, 12)
}

/** On-disk shape; versioned so a future migration can recognise old files. */
interface StoreFile {
  version: 1
  services: ServiceDefinition[]
}

/** Normalise a raw JSON record into a definition, dropping anything unusable. */
function parseDefinition(raw: unknown): ServiceDefinition | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const workspace = typeof record.workspace === 'string' ? record.workspace.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const command = typeof record.command === 'string' ? record.command.trim() : ''
  if (workspace === '' || name === '' || command === '') return undefined
  const language = record.language
  const port = typeof record.port === 'number' && Number.isFinite(record.port) ? record.port : undefined
  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : serviceId(workspace, name),
    workspace,
    name,
    command,
    cwd: typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined,
    port,
    language:
      language === 'node' || language === 'java' || language === 'python' || language === 'docker'
        ? language
        : 'custom',
    autoDetected: record.autoDetected === true,
    note: typeof record.note === 'string' && record.note !== '' ? record.note : undefined,
    env:
      record.env !== null && typeof record.env === 'object'
        ? Object.fromEntries(
            Object.entries(record.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : undefined,
    healthUrl:
      typeof record.healthUrl === 'string' && record.healthUrl !== ''
        ? record.healthUrl
        : undefined,
    successExitCodes: Array.isArray(record.successExitCodes)
      ? record.successExitCodes.filter(
          (value): value is number => typeof value === 'number' && Number.isInteger(value),
        )
      : undefined,
    stopCommand:
      typeof record.stopCommand === 'string' && record.stopCommand !== ''
        ? record.stopCommand
        : undefined,
    stopTimeoutMs:
      typeof record.stopTimeoutMs === 'number' &&
      Number.isFinite(record.stopTimeoutMs) &&
      record.stopTimeoutMs > 0
        ? record.stopTimeoutMs
        : undefined,
    stopParentOnly: record.stopParentOnly === true ? true : undefined,
    restart:
      record.restart === 'no' || record.restart === 'on_failure' || record.restart === 'always'
        ? record.restart
        : undefined,
    backoffMs:
      typeof record.backoffMs === 'number' &&
      Number.isFinite(record.backoffMs) &&
      record.backoffMs > 0
        ? record.backoffMs
        : undefined,
    maxRestarts:
      typeof record.maxRestarts === 'number' &&
      Number.isInteger(record.maxRestarts) &&
      record.maxRestarts >= 0
        ? record.maxRestarts
        : undefined,
    dependsOn: conditionMap(record.dependsOn),
  }
}

/** A `name → condition` map from an untrusted record (values must be strings). */
function conditionMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => entry[0] !== '' && typeof entry[1] === 'string',
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/** The service list, kept in memory and flushed to disk on every mutation. */
export class ServiceStore {
  #definitions = new Map<string, ServiceDefinition>()
  #loaded = false
  #watcher: { close: () => void } | undefined
  #onExternalChange: (() => void) | undefined
  #reloadTimer: NodeJS.Timeout | undefined

  /** Read the file once; a missing or corrupt file yields an empty list. */
  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    await this.#readInto()
  }

  /**
   * Follow the file so a hand edit — or any other tool writing it — takes effect
   * without restarting the harness.
   *
   * The *directory* is watched rather than the file: `#flush` writes a temporary
   * file and renames it over the target, and a watcher bound to the old inode
   * does not survive that replacement.
   */
  watch(onChange: () => void): void {
    this.#onExternalChange = onChange
    if (this.#watcher !== undefined) return
    void (async () => {
      try {
        const { watch } = await import('node:fs')
        const watcher = watch(dirname(storePath()), { persistent: false }, (_event, filename) => {
          const name = filename === null ? '' : String(filename)
          if (name === '' || name.startsWith('services.json')) this.#scheduleReload()
        })
        watcher.on('error', () => {
          /* watching is best effort: a lost watcher must not break the panel */
        })
        this.#watcher = watcher
      } catch {
        /* unsupported platform or missing directory: keep serving the snapshot */
      }
    })()
  }

  /** Release the watcher and any pending reload. */
  dispose(): void {
    if (this.#reloadTimer !== undefined) {
      clearTimeout(this.#reloadTimer)
      this.#reloadTimer = undefined
    }
    try {
      this.#watcher?.close()
    } catch {
      /* already closed */
    }
    this.#watcher = undefined
    this.#onExternalChange = undefined
  }

  /** Coalesce the burst of events a single atomic write produces. */
  #scheduleReload(): void {
    if (this.#reloadTimer !== undefined) clearTimeout(this.#reloadTimer)
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined
      void (async () => {
        await this.#readInto()
        this.#onExternalChange?.()
      })()
    }, 120)
    this.#reloadTimer.unref?.()
  }

  /** Replace the in-memory map from disk; a torn read keeps the last good one. */
  async #readInto(): Promise<void> {
    let next: Map<string, ServiceDefinition>
    try {
      const text = await readFile(storePath(), 'utf8')
      const parsed = JSON.parse(text) as Partial<StoreFile>
      const list = Array.isArray(parsed.services) ? parsed.services : []
      next = new Map()
      for (const entry of list) {
        const definition = parseDefinition(entry)
        if (definition !== undefined) next.set(definition.id, definition)
      }
    } catch {
      // Missing file is the normal first run; a corrupt or half-written one is
      // not worth failing over — keep serving the last good snapshot.
      return
    }
    this.#definitions = next
  }

  /** Every definition, optionally narrowed to one workspace. */
  list(workspace?: string): ServiceDefinition[] {
    const all = [...this.#definitions.values()]
    const scoped =
      workspace === undefined || workspace === ''
        ? all
        : all.filter((definition) => samePath(definition.workspace, workspace))
    return scoped.sort(
      (a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name),
    )
  }

  /** Distinct workspace roots present in the store. */
  workspaces(): string[] {
    return [...new Set([...this.#definitions.values()].map((definition) => definition.workspace))]
  }

  /** Insert or replace one definition. */
  async upsert(definition: ServiceDefinition): Promise<void> {
    this.#definitions.set(definition.id, definition)
    await this.#flush()
  }

  /** Drop one definition by id. */
  async remove(id: string): Promise<void> {
    if (this.#definitions.delete(id)) await this.#flush()
  }

  /** Replace the whole list for one workspace (the panel's "save" action). */
  async replaceWorkspace(workspace: string, definitions: ServiceDefinition[]): Promise<void> {
    for (const [id, existing] of [...this.#definitions]) {
      if (samePath(existing.workspace, workspace)) this.#definitions.delete(id)
    }
    for (const definition of definitions) this.#definitions.set(definition.id, definition)
    await this.#flush()
  }

  /** Atomic write of the current list. */
  async #flush(): Promise<void> {
    const path = storePath()
    const payload: StoreFile = { version: 1, services: this.list() }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }
}

/** Case/separator-insensitive path equality (Windows-safe). */
export function samePath(a: string, b: string): boolean {
  const normalise = (value: string): string =>
    value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return normalise(a) === normalise(b)
}
