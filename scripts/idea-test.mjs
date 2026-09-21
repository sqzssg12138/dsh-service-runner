/**
 * Detector test for the JetBrains-configuration source.
 *
 * Builds a throwaway workspace containing the two storage layouts (one file per
 * configuration, plus a legacy `workspace.xml` RunManager), an IDE type we
 * cannot faithfully map, and a `default="true"` template that must be ignored —
 * then asserts what the detector proposes.
 *
 *   node scripts/idea-test.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`)
}

const bundle = join(await mkdtemp(join(tmpdir(), 'dsr-idea-bundle-')), 'detect.mjs')
await build({
  entryPoints: ['src/host/detect.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { detectWorkspace } = await import(pathToFileURL(bundle).href)

const SPRING_POM =
  '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>'
const LIBRARY_POM =
  '<project><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId></plugin></plugins></build></project>'
/**
 * The workspace root as an aggregator: `packaging=pom` plus the module list, so
 * submodules have to be started from here with `-pl … -am` — a module that
 * depends on a sibling cannot be run from inside its own directory.
 */
const AGGREGATOR_POM = `<project>
  <artifactId>workspace-parent</artifactId>
  <packaging>pom</packaging>
  <modules>
    <module>api</module>
    <module>plain</module>
  </modules>
</project>`

const workspace = await mkdtemp(join(tmpdir(), 'dsr-idea-ws-'))
await mkdir(join(workspace, '.idea', 'runConfigurations'), { recursive: true })
await mkdir(join(workspace, 'api'), { recursive: true })
await mkdir(join(workspace, 'plain'), { recursive: true })

await writeFile(join(workspace, 'mvnw.cmd'), '@echo off\r\n')
await writeFile(join(workspace, 'pom.xml'), AGGREGATOR_POM)
await writeFile(join(workspace, 'api', 'pom.xml'), SPRING_POM)
await writeFile(join(workspace, 'plain', 'pom.xml'), LIBRARY_POM)
await writeFile(join(workspace, 'dev.ps1'), 'Write-Host hi\r\n')

// Current layout: one configuration per file.
await writeFile(
  join(workspace, '.idea', 'runConfigurations', 'ApiApplication.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="ApiApplication" type="SpringBootApplicationConfigurationType" factoryName="Spring Boot">
    <option name="SPRING_BOOT_MAIN_CLASS" value="com.demo.ApiApplication" />
    <module name="api" />
    <option name="VM_PARAMETERS" value="-Dserver.port=9123 -Xmx512m" />
    <envs>
      <env name="SPRING_PROFILES_ACTIVE" value="dev" />
    </envs>
    <method v="2">
      <option name="Make" enabled="true" />
    </method>
  </configuration>
</component>
`,
)
await writeFile(
  join(workspace, '.idea', 'runConfigurations', 'Front.ps1.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Front.ps1" type="PowerShellRunType" factoryName="PowerShell" scriptUrl="$PROJECT_DIR$/dev.ps1">
    <envs />
    <method v="2" />
  </configuration>
</component>
`,
)
// A plain Java main (no spring-boot plugin) and an unsupported type: both must
// be skipped rather than guessed at.
await writeFile(
  join(workspace, '.idea', 'runConfigurations', 'PlainMain.xml'),
  `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="PlainMain" type="Application" factoryName="Application">
    <option name="MAIN_CLASS_NAME" value="com.demo.Plain" />
    <module name="plain" />
  </configuration>
</component>
`,
)
await writeFile(
  join(workspace, '.idea', 'runConfigurations', 'SomePlugin.xml'),
  `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="SomePlugin" type="UnknownJetBrainsRunType" factoryName="X">
    <module name="api" />
  </configuration>
</component>
`,
)

// Legacy layout, plus the type template the IDE writes for every project.
await writeFile(
  join(workspace, '.idea', 'workspace.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="RunManager" selected="MavenApp">
    <configuration name="MavenApp" type="MavenRunConfiguration" factoryName="Maven">
      <MavenSettings>
        <option name="goals">
          <list>
            <option value="clean" />
            <option value="spring-boot:run" />
          </list>
        </option>
      </MavenSettings>
      <module name="api" />
    </configuration>
    <configuration default="true" type="JetRunConfigurationType">
      <module name="api" />
      <method v="2" />
    </configuration>
  </component>
</project>
`,
)

const result = await detectWorkspace(workspace)
const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))

const api = byName.get('ApiApplication')
check('读取 runConfigurations 里的 Spring Boot 配置', api !== undefined)
check('使用 IDEA 里的名字', api?.name === 'ApiApplication')
check('聚合 pom 下改为从根启动（cwd 为空）', api?.cwd === undefined, String(api?.cwd))
check('命令带上 -pl/-am', (api?.command ?? '').includes('-pl api -am'), api?.command ?? '')
check('从 VM 参数里取到真实端口', api?.port === 9123, String(api?.port))
check('使用向上找到的 wrapper', (api?.command ?? '').includes('mvnw'), api?.command ?? '')
check('note 标明来源', (api?.note ?? '').includes('IDEA'), api?.note ?? '')

const front = byName.get('Front.ps1')
check('读取 PowerShell 运行配置', front !== undefined)
check(
  'PowerShell 脚本转成 -File 命令',
  (front?.command ?? '').includes('powershell') && (front?.command ?? '').includes('dev.ps1'),
  front?.command ?? '',
)
check('$PROJECT_DIR$ 被还原为相对路径', front?.cwd === undefined || front.cwd === '.', String(front?.cwd))

const maven = byName.get('MavenApp')
check('读取 legacy workspace.xml 里的配置', maven !== undefined)
check('解析 Maven goals（多值）', (maven?.command ?? '').includes('clean spring-boot:run'), maven?.command ?? '')
check('legacy Maven 配置也从聚合根启动', maven?.cwd === undefined, String(maven?.cwd))

check('跳过 default="true" 的模板', byName.get('JetRunConfigurationType') === undefined)
check('跳过非 Spring Boot 的普通 Application', byName.get('PlainMain') === undefined)
check('跳过无法映射的配置类型', byName.get('SomePlugin') === undefined)

// Same command + cwd from two IDE entries collapses into one row — and here the
// surviving name is the IDE's own, with the heuristic's port carried over.
check('无 Spring Boot 插件的库模块不生成候选', byName.get('plain') === undefined)
check('notes 报告了配置数量', result.notes.some((note) => note.includes('IDEA')), result.notes.join(' | '))

await rm(workspace, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
