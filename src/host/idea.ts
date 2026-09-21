/**
 * Read JetBrains run configurations.
 *
 * The IDE already knows how each service is meant to be started — main class,
 * module, VM parameters, environment, PowerShell scripts — because the user
 * configured it there. Reading those files beats guessing from build files:
 * `-Dserver.port=8082` inside a VM-parameter string is the ACTUAL port rather
 * than a regex hit on an unrelated line, and a `PowerShellRunType` entry is a
 * command line the user demonstrably runs.
 *
 * Two storage layouts exist and both are read:
 *   .idea/runConfigurations/*.xml   one configuration per file (current)
 *   .idea/workspace.xml             the RunManager component (older projects)
 *
 * Deliberately dependency-free: the XML slice we need is small and flat, and
 * pulling a parser into the host half for it would not pay for itself.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** One run configuration, flattened to the fields that matter here. */
export interface IdeaConfiguration {
  /** Name as shown in the IDE (used as the service name). */
  name: string
  /** JetBrains configuration type id, e.g. `Application`. */
  type: string
  module?: string
  mainClass?: string
  scriptUrl?: string
  vmParameters?: string
  programParameters?: string
  workingDirectory?: string
  envs: Record<string, string>
  /** Maven goals / Gradle tasks, when the type carries them. */
  goals: string[]
  /** npm/pnpm script name. */
  npmScript?: string
  /** Which file this came from, so the candidate can say so. */
  source: string
}

/** Decode the five XML entities JetBrains actually emits. */
function decode(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Attribute map from a tag's raw attribute text. */
function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of raw.matchAll(/([A-Za-z_][\w.:-]*)="([^"]*)"/g)) {
    out[match[1]] = decode(match[2])
  }
  return out
}

/** `<option name="K" value="V" />` pairs (values only — lists handled separately). */
function optionValues(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of body.matchAll(/<option\b([^>]*?)\/?>/g)) {
    const attrs = attributes(match[1])
    if (attrs.name !== undefined && attrs.value !== undefined) out.set(attrs.name, attrs.value)
  }
  return out
}

/** `<option name="X"><list><option value="a" />…</list></option>` values. */
function listValues(body: string, name: string): string[] {
  const start = body.indexOf(`name="${name}"`)
  if (start < 0) return []
  const slice = body.slice(start)
  const end = slice.indexOf('</option>')
  const region = end >= 0 ? slice.slice(0, end) : slice
  return [...region.matchAll(/<option\s+value="([^"]*)"/g)].map((match) => decode(match[1]))
}

/** `<env name="K" value="V" />` pairs. */
function envValues(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of body.matchAll(/<env\s+name="([^"]+)"\s+value="([^"]*)"/g)) {
    out[decode(match[1])] = decode(match[2])
  }
  return out
}

/**
 * Parse every `<configuration>` in one file.
 *
 * `default="true"` entries are type templates the IDE writes into every project
 * (`JetRunConfigurationType`, Python, …); they are not something the user runs
 * and would flood the candidate list, so they are dropped.
 */
export function parseIdeaConfigurations(xml: string, source: string): IdeaConfiguration[] {
  const found: IdeaConfiguration[] = []
  for (const match of xml.matchAll(/<configuration\b([^>]*?)(?:\/>|>([\s\S]*?)<\/configuration>)/g)) {
    const attrs = attributes(match[1])
    if (attrs.default === 'true') continue
    const type = attrs.type ?? ''
    if (type === '') continue
    const body = match[2] ?? ''
    const opts = optionValues(body)
    found.push({
      name: attrs.name ?? type,
      type,
      module: /<module\s+name="([^"]+)"/.exec(body)?.[1],
      mainClass: opts.get('MAIN_CLASS_NAME'),
      scriptUrl: attrs.scriptUrl,
      vmParameters: opts.get('VM_PARAMETERS'),
      programParameters: opts.get('PROGRAM_PARAMETERS'),
      workingDirectory: opts.get('WORKING_DIRECTORY'),
      envs: envValues(body),
      goals: [...listValues(body, 'goals'), ...listValues(body, 'taskNames')],
      npmScript: opts.get('scripts') ?? opts.get('script'),
      source,
    })
  }
  return found
}

/** Every run configuration the IDE has stored for this workspace. */
export async function readIdeaConfigurations(workspace: string): Promise<IdeaConfiguration[]> {
  const found: IdeaConfiguration[] = []

  // Current layout: one file per configuration.
  const directory = join(workspace, '.idea', 'runConfigurations')
  try {
    for (const entry of await readdir(directory)) {
      if (!entry.toLowerCase().endsWith('.xml')) continue
      const text = await readFile(join(directory, entry), 'utf8').catch(() => undefined)
      if (text === undefined) continue
      found.push(...parseIdeaConfigurations(text, `.idea/runConfigurations/${entry}`))
    }
  } catch {
    /* no such directory: the legacy layout may still have them */
  }

  // Legacy layout: all configurations live inside workspace.xml.
  const text = await readFile(join(workspace, '.idea', 'workspace.xml'), 'utf8').catch(() => undefined)
  if (text !== undefined) found.push(...parseIdeaConfigurations(text, '.idea/workspace.xml'))

  // Stable order by name so repeated scans do not shuffle the panel.
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The port the IDE will start the service on, if it says so explicitly.
 *
 * Checked in order of specificity: a `-Dserver.port=` in VM parameters wins,
 * then the same thing in program parameters, then the `SERVER_PORT` env entry.
 */
export function ideaPort(config: IdeaConfiguration): number | undefined {
  const patterns = [
    /-Dserver\.port=(\d{2,5})/i,
    /--server\.port=(\d{2,5})/i,
  ]
  for (const pattern of patterns) {
    for (const text of [config.vmParameters, config.programParameters]) {
      if (text === undefined) continue
      const match = pattern.exec(text)
      if (match?.[1] !== undefined) {
        const port = Number.parseInt(match[1], 10)
        if (port > 0 && port < 65536) return port
      }
    }
  }
  const fromEnv = config.envs.SERVER_PORT ?? config.envs.PORT
  if (fromEnv !== undefined && /^\d{2,5}$/.test(fromEnv.trim())) {
    const port = Number.parseInt(fromEnv.trim(), 10)
    if (port > 0 && port < 65536) return port
  }
  return undefined
}
