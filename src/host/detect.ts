/**
 * Workspace service detection.
 *
 * The plugin does not hard-code languages: each rule below claims a marker file
 * and proposes a command. Detection is deliberately shallow (depth 2, temp and
 * dependency directories skipped) because a workspace root is usually a repo,
 * not a filesystem — and walking `node_modules` would cost seconds per scan.
 */
import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import { ideaPort, readIdeaConfigurations, type IdeaConfiguration } from './idea.ts'
import { samePath } from './store.ts'
import type { DetectResult, DetectedService } from './types.ts'

/** Directories that never contain project markers worth scanning. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'coverage',
])

/** Read a file, returning undefined instead of throwing when it is absent. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Whether a path exists (any type). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Parse JSON without throwing. */
function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * First plausible port number found in a blob of config text.
 *
 * Ordered from the most specific spellings to the loosest, because `port: 8080`
 * appears in unrelated contexts (proxy targets, debug ports) and the specific
 * forms are far more trustworthy.
 */
export function findPort(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined
  const patterns = [
    /server\s*\.\s*port\s*[=:]\s*(\d{2,5})/i, // application.properties / .env
    /^\s*port\s*:\s*(\d{2,5})\s*$/im, // application.yml (server.port nested)
    /--port[=\s]+(\d{2,5})/i, // CLI flag
    /\bPORT\s*[=:]\s*["']?(\d{2,5})/i, // env
    /\bport\s*:\s*(\d{2,5})/i, // vite/next config, yaml
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1] !== undefined) {
      const port = Number.parseInt(match[1], 10)
      if (port > 0 && port < 65536) return port
    }
  }
  return undefined
}

/** Which package manager a Node project uses, from its lockfiles. */
async function packageManager(dir: string): Promise<'pnpm' | 'yarn' | 'bun' | 'npm'> {
  if (await exists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  if (await exists(join(dir, 'yarn.lock'))) return 'yarn'
  if (await exists(join(dir, 'bun.lockb'))) return 'bun'
  return 'npm'
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime adaptation (added locally)
//
// Detection used to propose commands that could not run on the machine that
// received them: a Spring Boot module was started with whatever `java` happened
// to be on PATH, and a Node app was started through `pnpm run dev`. Both fail in
// this harness for reasons the workspace cannot express, so the rules below make
// the generated command self-contained instead.
// ─────────────────────────────────────────────────────────────────────────────

/** `1.8` → 8, `17` → 17, `21.0.1` → 21. */
function javaMajorFromVersion(version: string): number | undefined {
  const parts = version.trim().split('.')
  const major =
    parts[0] === '1' ? Number.parseInt(parts[1] ?? '', 10) : Number.parseInt(parts[0] ?? '', 10)
  return Number.isInteger(major) && major > 0 ? major : undefined
}

/**
 * Java release a Maven module asks for.
 *
 * `<java.version>` is the Spring Boot convention and is usually declared once on
 * the aggregator; the compiler-plugin knobs are the fallback for plain projects.
 */
function requiredJavaMajor(pomText: string | undefined): number | undefined {
  if (pomText === undefined) return undefined
  const patterns = [
    /<java\.version>\s*([0-9]+(?:\.[0-9]+)*)\s*<\/java\.version>/,
    /<maven\.compiler\.release>\s*([0-9]+(?:\.[0-9]+)*)\s*<\//,
    /<maven\.compiler\.source>\s*([0-9]+(?:\.[0-9]+)*)\s*<\//,
    /<maven\.compiler\.target>\s*([0-9]+(?:\.[0-9]+)*)\s*<\//,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(pomText)
    if (match?.[1] !== undefined) {
      const major = javaMajorFromVersion(match[1])
      if (major !== undefined) return major
    }
  }
  return undefined
}

/** Directories that hold JDK installations, per platform. */
function jdkRoots(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (process.platform === 'win32') {
    return [
      join(home, '.jdks'),
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Amazon Corretto',
    ]
  }
  return [
    join(home, '.sdkman/candidates/java'),
    '/usr/lib/jvm',
    '/Library/Java/JavaVirtualMachines',
    '/opt/homebrew/opt',
    '/opt/java',
  ]
}

/** Every plausible JDK home: `JAVA_HOME`, then the children of each install root. */
async function jdkCandidateHomes(): Promise<string[]> {
  const homes: string[] = []
  const seen = new Set<string>()
  const add = (candidate: string): void => {
    if (candidate === '') return
    const key = candidate.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    homes.push(candidate.replace(/[\\/]+$/, ''))
  }
  add(process.env.JAVA_HOME ?? '')
  for (const root of jdkRoots()) {
    if (root === '' || !(await exists(root))) continue
    add(root)
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) add(join(root, entry.name))
      }
    } catch {
      /* unreadable root: skip it */
    }
  }
  return homes
}

/**
 * Major version of a JDK home, read from its own `release` file.
 *
 * Reading the file avoids spawning `java -version`, which is both slow and — on
 * a machine whose PATH points at an older JRE — misleading.
 */
async function jdkMajor(home: string): Promise<number | undefined> {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  if (home === '' || !(await exists(join(home, 'bin', executable)))) return undefined
  const release = await readText(join(home, 'release'))
  const match = release === undefined ? null : /JAVA_VERSION="([^"]+)"/.exec(release)
  if (match?.[1] === undefined) return undefined
  return javaMajorFromVersion(match[1])
}

/** Smallest installed JDK that satisfies `required`, or undefined. */
async function findJdk(required: number): Promise<string | undefined> {
  let best: { home: string; major: number } | undefined
  for (const home of await jdkCandidateHomes()) {
    const major = await jdkMajor(home)
    if (major === undefined || major < required) continue
    if (best === undefined || major < best.major) best = { home, major }
  }
  return best?.home
}

/** Shell prefix that pins one command to a specific JDK. */
function javaHomePrefix(home: string): string {
  return process.platform === 'win32' ? `set "JAVA_HOME=${home}" && ` : `JAVA_HOME="${home}" `
}

/**
 * Node dev tools whose entry script can be launched by `node` directly.
 *
 * Paths are relative to the project root, most preferred first.
 */
const NODE_TOOL_ENTRIES: Record<string, readonly string[]> = {
  vite: ['node_modules/vite/bin/vite.js'],
  'electron-vite': ['node_modules/electron-vite/bin/electron-vite.js'],
  next: ['node_modules/next/dist/bin/next'],
  nuxt: ['node_modules/nuxt/bin/nuxt.mjs'],
  astro: ['node_modules/astro/astro.js'],
  'react-scripts': ['node_modules/react-scripts/bin/react-scripts.js'],
  'vue-cli-service': ['node_modules/@vue/cli-service/bin/vue-cli-service.js'],
  webpack: ['node_modules/webpack/bin/webpack.js'],
  'webpack-dev-server': ['node_modules/webpack-dev-server/bin/webpack-dev-server.js'],
  rspack: ['node_modules/@rspack/cli/bin/rspack.js'],
  parcel: ['node_modules/parcel/lib/bin.js'],
  nodemon: ['node_modules/nodemon/bin/nodemon.js'],
  tsx: ['node_modules/tsx/dist/cli.mjs'],
  'ts-node': ['node_modules/ts-node/dist/bin.js'],
  'http-server': ['node_modules/http-server/bin/http-server'],
  serve: ['node_modules/serve/build/main.js'],
}

/**
 * Rewrite `<manager> run <script>` into `node <tool entry>` when the script is
 * nothing but a known dev tool.
 *
 * Why this matters here: in this harness `node`, `npm` and `pnpm` all resolve to
 * *Electron* shims (GUI-subsystem binaries with no console). A console child
 * spawned underneath one of them makes Windows allocate a brand-new **visible**
 * console window — closing that window kills the dev server with
 * `0xC000013A`. Driving the tool with the system `node` (a console-subsystem
 * binary that simply inherits the hidden console) avoids the window entirely.
 */
async function directNodeCommand(
  dir: string,
  scriptText: string,
): Promise<{ command: string; tool: string } | undefined> {
  const parts = scriptText.trim().split(/\s+/)
  const tool = parts[0]
  if (tool === undefined || tool === '') return undefined
  const entries = NODE_TOOL_ENTRIES[tool]
  if (entries === undefined) return undefined
  for (const entry of entries) {
    if (!(await exists(join(dir, entry)))) continue
    const args = parts.slice(1).join(' ')
    return { command: `node "${entry}"${args === '' ? '' : ` ${args}`}`, tool }
  }
  return undefined
}

/**
 * A `spring-boot:run` command that actually works in a multi-module reactor.
 *
 * `-pl <module> -am <goal>` selects the module *and its upstream siblings*, and a
 * goal named on the command line runs for **every** module in the reactor — so
 * the aggregator POM, which has no main class, fails the build with
 * "Unable to find a suitable main class". Installing first and then running the
 * goal without `-am` leaves a reactor of exactly one module.
 */
function springBootRunCommand(
  wrapper: string,
  module: string | undefined,
  aggregator: string | undefined,
): string {
  if (module === undefined || aggregator === undefined) return `${wrapper} spring-boot:run`
  return `${wrapper} -q -pl ${module} -am install -DskipTests && ${wrapper} -pl ${module} spring-boot:run`
}

/** Wrapper script names, most specific platform first. */
const MVN_WRAPPERS = process.platform === 'win32' ? ['mvnw.cmd', 'mvnw'] : ['mvnw', 'mvnw.cmd']
const GRADLE_WRAPPERS = process.platform === 'win32' ? ['gradlew.bat', 'gradlew'] : ['gradlew', 'gradlew.bat']

/** Whether `candidate` sits inside `root` (case/separator-insensitive). */
function isInside(root: string, candidate: string): boolean {
  const normalise = (value: string): string =>
    value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return normalise(candidate).startsWith(normalise(root))
}

/** Whether a tool resolves on PATH (`where` / `which`). */
function commandExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    try {
      const child = spawn(probe, [name], { windowsHide: true, stdio: 'ignore' })
      child.once('exit', (code) => resolve(code === 0))
      child.once('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

/**
 * Nearest wrapper at or above `dir`, as a path relative to `dir`.
 *
 * A wrapper lives at the repository root while the module carrying the
 * `pom.xml` often sits a level or two down (`debug/`, `service-a/`). Looking
 * only inside `dir` produced `mvn spring-boot:run` for such modules — a command
 * that dies instantly on a machine without a global Maven install, even though
 * the repository ships a perfectly good `mvnw.cmd`.
 */
async function findWrapperAbove(
  dir: string,
  workspace: string,
  names: readonly string[],
): Promise<string | undefined> {
  let current = dir
  for (let depth = 0; depth < 4; depth += 1) {
    for (const name of names) {
      if (await exists(join(current, name))) {
        const rel = relative(dir, join(current, name))
        return rel.startsWith('.') ? rel : `.${sep}${rel}`
      }
    }
    if (samePath(current, workspace)) break
    const parent = dirname(current)
    if (parent === current || !isInside(workspace, parent)) break
    current = parent
  }
  return undefined
}

/** Node/前端 rule: package.json with a runnable script. */
async function detectNode(dir: string, label: string, cwd?: string): Promise<DetectedService[]> {
  const manifest = parseJson(await readText(join(dir, 'package.json')))
  if (manifest === undefined) return []
  const scripts = manifest.scripts
  if (scripts === null || typeof scripts !== 'object') return []
  const entries = scripts as Record<string, unknown>

  // `dev` is the convention; `serve`/`start` are the fallbacks a Vite/Next app
  // usually exposes when `dev` is absent.
  const scriptName = ['dev', 'develop', 'serve', 'start'].find(
    (name) => typeof entries[name] === 'string',
  )
  if (scriptName === undefined) return []

  const manager = await packageManager(dir)
  const scriptText = String(entries[scriptName])
  // Prefer driving the dev tool with the system `node`; the package manager stays
  // the fallback so unknown scripts keep working exactly as before.
  const direct = await directNodeCommand(dir, scriptText)
  const command =
    direct?.command ?? (manager === 'npm' ? `npm run ${scriptName}` : `${manager} run ${scriptName}`)

  // Port hints, best first: the script's own flag, then the framework configs.
  let port = findPort(scriptText)
  if (port === undefined) {
    for (const candidate of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'next.config.js', 'next.config.mjs']) {
      port = findPort(await readText(join(dir, candidate)))
      if (port !== undefined) break
    }
  }
  if (port === undefined) port = findPort(await readText(join(dir, '.env')))
  if (port === undefined) port = findPort(await readText(join(dir, '.env.local')))

  const name = label === '' ? (typeof manifest.name === 'string' ? manifest.name : 'app') : label
  return [
    {
      name,
      command,
      cwd,
      port,
      language: 'node',
      note:
        direct !== undefined
          ? `package.json → node ${direct.tool}（直启，避开 Electron shim）`
          : `package.json → ${manager} run ${scriptName}`,
      reason:
        direct !== undefined
          ? `找到 package.json 的 "${scriptName}" 脚本（${direct.tool}），改用系统 node 直接启动以避免弹出控制台窗口`
          : `找到 package.json 的 "${scriptName}" 脚本`,
    },
  ]
}

/** Java rule: Maven / Gradle / packaged jar. */
async function detectJava(
  dir: string,
  label: string,
  workspace: string,
  cwd?: string,
): Promise<DetectedService[]> {
  const found: DetectedService[] = []
  const name = label === '' ? basename(dir) : label

  const pomText = await readText(join(dir, 'pom.xml'))
  if (pomText !== undefined) {
    // A module that does not apply the Spring Boot plugin is a library, not a
    // service: `spring-boot:run` would fail, and so would `java -jar` on its
    // plain (non-executable) jar. Propose nothing rather than a broken command.
    if (!/spring-boot-maven-plugin/.test(pomText)) return found
    // A submodule listed by a root aggregator must be started FROM the root with
    // `-pl <module> -am`; from inside its own directory Maven becomes the
    // reactor root and cannot resolve the sibling modules it depends on.
    const aggregator = cwd === undefined ? undefined : await aggregatorFor(workspace, cwd)
    const runDir = aggregator === undefined ? dir : join(workspace, aggregator)
    const wrapper = await findWrapperAbove(runDir, workspace, MVN_WRAPPERS)
    // No wrapper anywhere up the tree: the command depends on a global Maven,
    // which may simply not exist. Check before promising the user a command.
    const usable = wrapper !== undefined || (await commandExists('mvn'))
    const maven = wrapper ?? 'mvn'
    const goal = springBootRunCommand(maven, aggregator === undefined ? undefined : cwd, aggregator)

    // Pin the build to a JDK that can actually compile it. The harness may run
    // with an older JAVA_HOME than the project requires, and that mismatch
    // otherwise surfaces as a 60-line Maven stack trace instead of a hint.
    const required =
      requiredJavaMajor(pomText) ?? requiredJavaMajor(await readText(join(workspace, 'pom.xml')))
    let prefix = ''
    let jdkNote = ''
    if (required !== undefined) {
      const current =
        process.env.JAVA_HOME === undefined ? undefined : await jdkMajor(process.env.JAVA_HOME)
      if (current === undefined || current < required) {
        const jdk = await findJdk(required)
        if (jdk !== undefined) {
          prefix = javaHomePrefix(jdk)
          jdkNote = `，已绑定 JDK ${required}+（${jdk}）`
        } else {
          jdkNote = `，但未找到 JDK ${required}+（当前 JAVA_HOME ${current ?? '不可用'}）`
        }
      }
    }

    found.push({
      name,
      command: `${prefix}${goal}`,
      cwd: aggregator === undefined ? cwd : aggregator === '' ? undefined : aggregator,
      port: findPort(await readText(join(dir, 'src/main/resources/application.yml'))) ??
        findPort(await readText(join(dir, 'src/main/resources/application.properties'))),
      language: 'java',
      note: wrapper !== undefined ? `pom.xml + ${wrapper}` : 'pom.xml（系统 mvn）',
      reason:
        wrapper !== undefined
          ? `找到 pom.xml，使用 Maven Wrapper ${wrapper}${
              aggregator !== undefined ? '（先 install 兄弟依赖，再只对该模块 run）' : ''
            }${jdkNote}`
          : usable
            ? `找到 pom.xml（用系统 mvn）${jdkNote}`
            : '找到 pom.xml，但既没有 wrapper 也没有系统 mvn —— 该命令无法执行',
    })
    // A Spring Boot Maven project is the common case; don't also propose the jar rule.
    return found
  }

  const gradleFile = (await exists(join(dir, 'build.gradle')))
    ? 'build.gradle'
    : (await exists(join(dir, 'build.gradle.kts')))
      ? 'build.gradle.kts'
      : undefined
  if (gradleFile !== undefined) {
    const wrapper = await findWrapperAbove(dir, workspace, GRADLE_WRAPPERS)
    const usable = wrapper !== undefined || (await commandExists('gradle'))
    found.push({
      name,
      command: wrapper !== undefined ? `${wrapper} bootRun` : 'gradle bootRun',
      cwd,
      language: 'java',
      note: wrapper !== undefined ? `${gradleFile} + ${wrapper}` : gradleFile,
      reason:
        wrapper !== undefined
          ? `找到 ${gradleFile}，使用 Gradle Wrapper ${wrapper}`
          : usable
            ? `找到 ${gradleFile}（用系统 gradle）`
            : `找到 ${gradleFile}，但既没有 wrapper 也没有系统 gradle —— 该命令无法执行`,
    })
    return found
  }

  // Packaged fat jar: the only runnable artifact when sources are not built here.
  const targetDir = join(dir, 'target')
  if (await exists(targetDir)) {
    try {
      const entries = await readdir(targetDir)
      const jar = entries.find(
        (entry) => entry.endsWith('.jar') && !entry.endsWith('-sources.jar') && !entry.endsWith('-javadoc.jar'),
      )
      if (jar !== undefined) {
        found.push({
          name,
          command: `java -jar ${join('target', jar)}`,
          cwd,
          language: 'java',
          note: `target/${jar}`,
          reason: '找到 target 下可执行的 jar',
        })
      }
    } catch {
      /* unreadable target dir: nothing to propose */
    }
  }
  return found
}

/** Python rule: Django manage.py / uvicorn / plain main.py. */
async function detectPython(dir: string, label: string, cwd?: string): Promise<DetectedService[]> {
  const name = label === '' ? basename(dir) : label
  if (await exists(join(dir, 'manage.py'))) {
    return [
      {
        name,
        command: 'python manage.py runserver',
        cwd,
        port: 8000,
        language: 'python',
        note: 'manage.py',
        reason: '找到 Django 的 manage.py',
      },
    ]
  }
  const hasModule = (await exists(join(dir, 'main.py'))) || (await exists(join(dir, 'app.py')))
  const hasManifest =
    (await exists(join(dir, 'requirements.txt'))) ||
    (await exists(join(dir, 'pyproject.toml')))
  if (hasModule && hasManifest) {
    const module = (await exists(join(dir, 'main.py'))) ? 'main' : 'app'
    return [
      {
        name,
        command: `python -m uvicorn ${module}:app --reload`,
        cwd,
        port: 8000,
        language: 'python',
        note: `${module}.py`,
        reason: '找到 Python 入口与依赖清单',
      },
    ]
  }
  return []
}

/** Docker rule: compose file at this level. */
async function detectDocker(dir: string, label: string, cwd?: string): Promise<DetectedService[]> {
  let compose: string | undefined
  for (const candidate of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (await exists(join(dir, candidate))) {
      compose = candidate
      break
    }
  }
  if (compose === undefined) return []
  return [
    {
      name: label === '' ? `${basename(dir)} (compose)` : label,
      command: 'docker compose up',
      cwd,
      language: 'docker',
      note: compose,
      reason: `找到 ${compose}`,
    },
  ]
}

/** Turn an IDE macro path (`$PROJECT_DIR$/x`) into a workspace-relative path. */
function projectRelative(value: string | undefined, workspace: string): string | undefined {
  if (value === undefined || value === '') return undefined
  const stripped = value.replace(/^\$PROJECT_DIR\$[\\/]?/, '')
  if (stripped === '') return undefined
  if (!isAbsolute(stripped)) return stripped
  if (!isInside(workspace, stripped)) return undefined
  const rel = relative(workspace, stripped)
  return rel === '' ? undefined : rel
}

/** Directory of a named module, when the name matches a subdirectory with a build file. */
async function moduleDirectory(workspace: string, module: string | undefined): Promise<string | undefined> {
  if (module === undefined || module === '') return undefined
  const candidate = join(workspace, module)
  if (!isInside(workspace, candidate)) return undefined
  for (const marker of ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json']) {
    if (await exists(join(candidate, marker))) return module
  }
  return undefined
}

/**
 * Map the IDE's own run configurations onto runnable commands.
 *
 * The most trustworthy source available: the entries carry the real module, the
 * real port and a command line the user demonstrably runs, so these candidates
 * are produced BEFORE the heuristic ones and win the name collision below.
 * Configuration types that cannot be turned into a faithful command line are
 * skipped rather than guessed at — a wrong command is worse than a missing one.
 */
async function detectIdea(configurations: IdeaConfiguration[], workspace: string): Promise<DetectedService[]> {
  const found: DetectedService[] = []
  for (const config of configurations) {
    const port = ideaPort(config)
    const note = `来自 IDEA 配置「${config.name}」（${config.source}）`
    const module = await moduleDirectory(workspace, config.module)
    const buildDir = module === undefined ? workspace : join(workspace, module)

    if (config.type === 'PowerShellRunType') {
      const script = projectRelative(config.scriptUrl, workspace)
      if (script === undefined) continue
      const scriptDir = dirname(script)
      found.push({
        name: config.name,
        command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
        cwd: scriptDir === '.' ? module : scriptDir,
        port,
        language: 'custom',
        note,
        reason: `IDEA 里的 PowerShell 运行配置（${script}）`,
      })
      continue
    }

    if (config.type === 'Application' || config.type === 'SpringBootApplicationConfigurationType') {
      // `Application` may be a plain main class; only claim spring-boot:run when
      // the build actually carries the plugin.
      const pom = await readText(join(buildDir, 'pom.xml'))
      if (pom === undefined || !/spring-boot-maven-plugin/.test(pom)) continue

      // Prefer the aggregator + `-pl/-am`: a module that depends on a sibling
      // cannot be started from inside its own directory (see aggregatorFor).
      const aggregator = module === undefined ? undefined : await aggregatorFor(workspace, module)
      const runDir = aggregator === undefined ? buildDir : join(workspace, aggregator)
      const wrapper = await findWrapperAbove(runDir, workspace, MVN_WRAPPERS)
      if (wrapper === undefined) continue
      const goal = springBootRunCommand(
        wrapper,
        aggregator === undefined ? undefined : module,
        aggregator,
      )
      // Same JDK pinning as the heuristic rule: the IDE resolves the project SDK
      // on its own, a command line does not.
      const required =
        requiredJavaMajor(pom) ?? requiredJavaMajor(await readText(join(workspace, 'pom.xml')))
      let prefix = ''
      let jdkNote = ''
      if (required !== undefined) {
        const current =
          process.env.JAVA_HOME === undefined ? undefined : await jdkMajor(process.env.JAVA_HOME)
        if (current === undefined || current < required) {
          const jdk = await findJdk(required)
          if (jdk !== undefined) {
            prefix = javaHomePrefix(jdk)
            jdkNote = `，已绑定 JDK ${required}+`
          }
        }
      }
      found.push({
        name: config.name,
        command: `${prefix}${goal}`,
        cwd: aggregator === undefined ? module : aggregator === '' ? undefined : aggregator,
        port,
        language: 'java',
        note,
        reason:
          `IDEA 里的 Java 运行配置${config.mainClass !== undefined ? `（${config.mainClass}）` : ''}` +
          (aggregator !== undefined ? '（先 install 兄弟依赖，再只对该模块 run）' : '') +
          jdkNote,
      })
      continue
    }

    if (config.type === 'MavenRunConfiguration') {
      // cwd follows the aggregator when there is one — the IDE runs Maven from
      // the project root — while the goals stay exactly as the user wrote them.
      const aggregator = module === undefined ? undefined : await aggregatorFor(workspace, module)
      const runDir = aggregator === undefined ? buildDir : join(workspace, aggregator)
      const wrapper = await findWrapperAbove(runDir, workspace, MVN_WRAPPERS)
      if (wrapper === undefined || config.goals.length === 0) continue
      found.push({
        name: config.name,
        command: `${wrapper} ${config.goals.join(' ')}`,
        cwd: aggregator === undefined ? module : aggregator === '' ? undefined : aggregator,
        port,
        language: 'java',
        note,
        reason: `IDEA 里的 Maven 运行配置（${config.goals.join(' ')}）`,
      })
      continue
    }

    if (config.type === 'GradleRunConfiguration') {
      const aggregator = module === undefined ? undefined : await aggregatorFor(workspace, module)
      const runDir = aggregator === undefined ? buildDir : join(workspace, aggregator)
      const wrapper = await findWrapperAbove(runDir, workspace, GRADLE_WRAPPERS)
      if (wrapper === undefined || config.goals.length === 0) continue
      found.push({
        name: config.name,
        command: `${wrapper} ${config.goals.join(' ')}`,
        cwd: aggregator === undefined ? module : aggregator === '' ? undefined : aggregator,
        port,
        language: 'java',
        note,
        reason: `IDEA 里的 Gradle 运行配置（${config.goals.join(' ')}）`,
      })
      continue
    }

    if (config.type === 'js.build_tools.npm' || config.type === 'js.build_tools.pnpm') {
      const script = config.npmScript
      if (script === undefined || script === '') continue
      const manager = await packageManager(buildDir)
      // Same Electron-shim avoidance as the package.json rule: drive a known dev
      // tool with the system `node` rather than through npm/pnpm.
      const manifest = parseJson(await readText(join(buildDir, 'package.json')))
      const declared = manifest?.scripts
      const scriptText =
        declared !== null && typeof declared === 'object'
          ? (declared as Record<string, unknown>)[script]
          : undefined
      const direct =
        typeof scriptText === 'string' ? await directNodeCommand(buildDir, scriptText) : undefined
      found.push({
        name: config.name,
        command:
          direct?.command ?? (manager === 'npm' ? `npm run ${script}` : `${manager} run ${script}`),
        cwd: module,
        port,
        language: 'node',
        note,
        reason:
          direct !== undefined
            ? `IDEA 里的 npm 运行配置（${script} → 用系统 node 直启 ${direct.tool}）`
            : `IDEA 里的 npm 运行配置（${script}）`,
      })
    }
  }
  return found
}

/** Escape a literal for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The aggregator POM that owns `module`, when the workspace root is one.
 *
 * A Spring Boot module often depends on a sibling: `debug` needs
 * `module-sample`. Running `mvn spring-boot:run` INSIDE the module directory
 * makes Maven treat that module as the root of its own reactor, so the sibling
 * cannot be resolved ("Could not find artifact com.example.app:module-sample:
 * jar:0.0.1-SNAPSHOT"). Running from the aggregator with `-pl <module> -am`
 * builds the siblings too — which is what the IDE does internally with its own
 * classpath, and why the same configuration works there but not from a shell.
 *
 * @returns the aggregator directory relative to the workspace, or undefined.
 */
async function aggregatorFor(workspace: string, module: string): Promise<string | undefined> {
  const rootPom = await readText(join(workspace, 'pom.xml'))
  if (rootPom === undefined) return undefined
  if (!/<packaging>\s*pom\s*<\/packaging>/.test(rootPom)) return undefined
  return new RegExp(`<module>\\s*${escapeRegExp(module)}\\s*</module>`).test(rootPom) ? '' : undefined
}

/** Run every rule against one directory. */
async function detectInDirectory(
  dir: string,
  label: string,
  workspace: string,
  cwd?: string,
): Promise<DetectedService[]> {
  const results = await Promise.all([
    detectNode(dir, label, cwd),
    detectJava(dir, label, workspace, cwd),
    detectPython(dir, label, cwd),
    detectDocker(dir, label, cwd),
  ])
  return results.flat()
}

/**
 * Scan a workspace root and its immediate sub-projects.
 *
 * Depth 2 covers the two layouts that matter in practice: a single project at
 * the root, and a container (`apps/`, `packages/`, `services/`) holding several.
 * Sub-project entries are named `<folder>` AND carry `cwd: <folder>` — without
 * that relative cwd the command would run at the workspace root, which for a
 * monorepo means running the wrong project (or nothing at all).
 */
export async function detectWorkspace(workspace: string): Promise<DetectResult> {
  const candidates: DetectedService[] = []
  const notes: string[] = []

  // The IDE's own configurations come first: they are the most accurate source
  // available, and the de-duplication below keeps the FIRST entry for a given
  // (cwd, name), so an IDE configuration wins over a heuristic guess.
  const ideaConfigurations = await readIdeaConfigurations(workspace)
  candidates.push(...(await detectIdea(ideaConfigurations, workspace)))
  if (ideaConfigurations.length > 0) {
    notes.push(`发现 ${ideaConfigurations.length} 个 IDEA 运行配置`)
  }

  candidates.push(...(await detectInDirectory(workspace, '', workspace)))

  let children: string[] = []
  try {
    const entries = await readdir(workspace, { withFileTypes: true })
    children = entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch (error) {
    notes.push(`无法读取目录：${error instanceof Error ? error.message : String(error)}`)
  }

  for (const child of children.slice(0, 40)) {
    const childDir = join(workspace, child)
    const found = await detectInDirectory(childDir, child, workspace, child)
    // Only surface a sub-project when it produced something runnable.
    candidates.push(...found)
  }

  // Merge duplicates by command + cwd: `apps/web` and `packages/web` may both be
  // Vite apps, but the same command in the same directory twice is noise.
  //
  // IDE entries were pushed first, so they survive with the name the user knows
  // from the IDE — but the heuristic entry being dropped may be the one that
  // knows the port (read out of application.yml), so that is carried over.
  const merged = new Map<string, DetectedService>()
  for (const candidate of candidates) {
    const key = `${candidate.cwd ?? ''}|${candidate.command}`
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, candidate)
      continue
    }
    if (existing.port === undefined && candidate.port !== undefined) {
      merged.set(key, { ...existing, port: candidate.port })
    }
  }
  const unique = [...merged.values()]

  if (unique.length === 0) {
    notes.push('未识别到可运行服务，可在面板中手动添加命令。')
  }
  return { workspace, candidates: unique, notes }
}

/** Exposed for the route layer: read a config file inside a workspace. */
export { readText as readWorkspaceFile, exists as pathExists }
