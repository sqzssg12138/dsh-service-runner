# dsh-service-runner

给 DSH 加上 **IDEA 右上角那样的服务启停面板**：在会话头部右上角列出当前工作区的前端 / Java / Python / Docker 服务，一键启动、停止、重启，并实时查看它们的输出。

- 支持**多个工作区**：服务按工作区根目录隔离保存，切会话即切项目。
- 支持**多语言自动探测**：Node/前端、Maven/Gradle/Java、Python、Docker Compose，探测结果可在界面里改。
- **host 侧零依赖**：只用 node 内置模块 + `webServer` 这一个官方接缝，不 import 任何 `@deepseek-ai/*` 内部包，DSH 升级不易碎。
- **client 侧只依赖 `react`**：不内联自己的 React（否则 hooks 会因双份 React 而错乱）。

---

## 使用

装好后重启一次 DSH Desktop，会话头部右上角（后台任务按钮旁边）会出现「服务」按钮：

1. 点「服务」→ 面板打开，显示当前工作区已保存的服务。
2. 第一次用：点「编辑」→「探测工作区」，自动生成候选列表。
3. 在编辑态里可以改名称、命令、端口，删掉不需要的行，再点「保存」。
4. 回到列表态即可「启动 / 停止 / 重启」，点「日志」展开该服务的实时输出。

状态点含义：灰=已停止，黄闪=启动中，绿=运行中，红=失败。绿色时按钮上的数字是运行中的服务数。

### 工作区是怎么确定的

优先取会话的权威工作区（host 从 `sessionPersistence` 读会话头里的 `cwd`）；取不到时回退到会话目录名的反解；都失败就在面板底部的输入框里手填绝对路径——填过一次会记住。

## 自动探测规则

| 语言 | 触发文件 | 生成的命令 |
| --- | --- | --- |
| `node` | `package.json` 里有 `dev`/`develop`/`serve`/`start` | `pnpm run dev`（按 lockfile 自动选 pnpm/yarn/bun/npm） |
| `java` | `pom.xml` | `.\mvnw.cmd spring-boot:run`（有 wrapper）或 `mvn spring-boot:run` |
| `java` | `build.gradle[.kts]` | `.\gradlew.bat bootRun` 或 `gradle bootRun` |
| `java` | `target/*.jar` | `java -jar target/xxx.jar` |
| `python` | `manage.py` | `python manage.py runserver` |
| `python` | `main.py`/`app.py` + 依赖清单 | `python -m uvicorn main:app --reload` |
| `docker` | `docker-compose.y[a]ml` / `compose.y[a]ml` | `docker compose up` |

扫描范围是工作区根目录 + 一层子目录（`apps/`、`packages/` 这类容器布局），自动跳过 `node_modules`、`target`、`.git` 等目录。端口从 `vite.config.*`、`application.y[a]ml`、`.env`、脚本参数里推断。

### 优先来源：IDEA 的运行配置

工作区里有 `.idea` 时，插件会先读 JetBrains 自己的运行配置 —— **两种存储布局都支持**：`.idea/runConfigurations/*.xml`（每个配置一个文件，新式）与 `.idea/workspace.xml` 的 `RunManager`（旧式）。

| IDEA 配置类型 | 生成的命令 |
| --- | --- |
| `SpringBootApplicationConfigurationType` / `Application`（且 pom 含 spring-boot 插件） | `..\mvnw.cmd spring-boot:run`，`cwd` = 配置里的 module 目录 |
| `PowerShellRunType` | `powershell -NoProfile -ExecutionPolicy Bypass -File "<脚本>"` |
| `MavenRunConfiguration` | `<wrapper> <goals…>` |
| `GradleRunConfiguration` | `<wrapper> <tasks…>` |
| `js.build_tools.npm` / `.pnpm` | `pnpm run <script>` |

价值在**准确性**：`-Dserver.port=8082` 写在 VM 参数里就是真实端口（不是正则撞上的数字），`module` 指明命令该在哪个子目录跑，而 PowerShell 脚本本身就是你日常运行的那条命令。

所以这些候选**排在启发式结果之前**，同命令同时取 IDEA 的名字；反过来，被合并掉的启发式候选若探到了端口（例如从 `application.yml`），端口会补到 IDEA 那条上 —— 名字来自 IDE，端口来自构建文件。

无法忠实还原成命令行的配置类型会被**跳过而不是瞎猜**；`default="true"` 的类型模板（IDEA 给每个项目都写一份，如 `JetRunConfigurationType`）也会忽略，否则候选列表会被灌满。

### 多模块项目：为什么从根目录以 `-pl … -am` 启动

如果模块被根部的**聚合 pom**（`packaging=pom` + `<modules>`）收录，命令会从**根目录**运行并带上 `-pl <module> -am`，而不是钻进模块目录：

```
.\mvnw.cmd -pl debug -am spring-boot:run      # cwd = 仓库根
```

因为 Maven 在模块目录里会把**该模块当成 reactor 的根**，同仓库的兄弟模块依赖就解析不到了，典型报错：

```
[ERROR] Could not resolve dependencies for project com.example.app:debug:jar:0.0.1-SNAPSHOT
[ERROR] dependency: com.example.app:module-sample:jar:0.0.1-SNAPSHOT (compile)
[ERROR] 	Could not find artifact com.example.app:module-sample:jar:0.0.1-SNAPSHOT
```

IDEA 里同样的配置能跑，是因为 IDEA 用自己的 classpath 解析、不经过 Maven reactor —— 所以「IDEA 里能跑」并不等于「命令行能跑」，这里必须翻译成 reactor 语义。`-am`（also make）会把被依赖的兄弟模块一起构建。

同理，**只有应用了 `spring-boot-maven-plugin` 的模块才会被提议**：库模块既不能 `spring-boot:run`，它的普通 jar 也不能 `java -jar`（没有 Main-Class），给它生成候选只会得到一条必然失败的命令。

## 数据与接口

- 服务定义：`<DSH_HOME>/service-runner/services.json`（可用编辑器直接改，改完刷新面板即可）
- HTTP（前缀 `/service-runner`，仅供面板同源调用）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state?sessionId=&workspace=` | 当前工作区 + 服务快照 |
| POST | `/action` | `{action: start\|stop\|restart, id}` |
| GET | `/logs?id=&after=` | 增量日志（`after` 是上次的 `logSeq`） |
| POST | `/logs/clear` | `{id}` 清空该服务的日志缓冲（`seq` 不回退） |
| POST | `/detect` | `{workspace}` 扫描候选服务 |
| POST | `/save` | `{workspace, services[]}` 覆盖保存 |
| POST | `/remove` | `{id}` 删除一条 |
| POST | `/port-owner` | `{port}` 查该端口的监听进程（pid/进程名/启动时间/命令行） |
| POST | `/port-release` | `{port, pid}` 结束占用者；**会重新核对 pid**，端口易主时拒绝执行 |

运行状态只存在内存里：**DSH 退出/插件卸载时，本插件启动的进程会被一并结束**，不会留下占着端口的孤儿 dev server。

### 安全：信任围栏

这些路由会启停本机进程，所以每个请求都要过一道围栏（与 `/api` 网关、dsh-better-sidebar 同款策略）：Host 必须是回环地址、不得携带 `sec-fetch-site: cross-site`、若携带 `Origin` 则其主机名必须与 Host 一致。

挡的是「浏览器里某个网页偷偷 POST 到 `127.0.0.1:<端口>/service-runner/action` 来启动/杀掉你机器上的进程」；不带 `Origin` 的本机工具（curl、测试脚本）照常可用，面板自身同源调用不受影响。

## 端口被占用怎么办

面板里展开任意服务（点「日志」），上方会显示该端口的实际占用者：

```
端口 8082 被 java（pid 3316）占用   [结束该进程] [重新检查]
```

鼠标悬停能看到完整命令行——这是分辨「IDEA 的 debug 会话」和「上次跑剩的 dev server」的关键。点「结束该进程」需要**二次确认**；host 侧还会在动手前重新核对 pid，端口在你看面板期间易主的话会报错而不是误杀。

## 安装与卸载

前置条件：

| 依赖 | 要求 |
| --- | --- |
| DSH Desktop | 本插件在 `0.1.5-rc.2` 上开发与验证 |
| Node.js | ≥ 20（host 半以 `node20` 为目标编译） |
| pnpm | 依赖安装与构建 |

```powershell
git clone https://github.com/sqzssg12138/dsh-service-runner.git
cd dsh-service-runner
pnpm install
pnpm run build

# 以 link 方式装进目标 profile（desktop / web 按实际存在的替换）
dsh plugin --profile desktop add "link:<克隆到的绝对路径>"

# 卸载
dsh plugin --profile desktop remove dsh-service-runner
```

改完代码后重新构建并重启 DSH 即可：

```powershell
pnpm run build
```

> **为什么必须重启**：profile 的 `dsh.profile.bundles` 只在启动时组合一次。新装的 bundle 不会热加载——本插件的 client bundle 由 shell 在启动时按启动载荷（`__DSH_BOOT__`）注册，同理。

## 目录结构

```
src/host/        宿主半：进程管理、多语言探测、HTTP 路由、持久化
src/client/      浏览器半：会话头部面板（React，只依赖 react）
lib/             构建产物（index.js = host 半，client.js = 浏览器半），不入库
scripts/         冒烟 / 交互 / 探测脚本，见「开发与测试」
.local-patches/  本机排障记录与补丁重放脚本（本地目录，不入库）
```

## 开发与测试

```powershell
pnpm run build      # esbuild → lib/index.js (host) + lib/client.js (client)
pnpm run typecheck  # tsc --noEmit

node scripts/smoke.mjs "D:\path\to\workspace"   # host 全链路（临时 DSH_HOME，含进程树清理）
node scripts/client-smoke.mjs                   # client bundle 结构 + 首屏渲染
node scripts/client-interaction.mjs             # jsdom 里真实点击交互
node scripts/live-check.mjs http://127.0.0.1:<port> "D:\path\to\workspace"   # 对运行中的实例做真启停
node scripts/idea-test.mjs                      # IDEA 运行配置解析（自造 fixture，含 legacy 布局）
node scripts/probe-detect.mjs "D:\某个项目"      # 看探测会给某个工作区生成什么候选（不用启动 DSH）
```

`scripts/probe-bundles.mjs <base> <launch-token>` 用于排查「面板没出现」：它会用启动令牌拿到 shell HTML，列出真实注册的 bundle URL 并逐个探测。

## 停止服务时会发生什么

`停止` / `重启` 依次做三件事：

1. **先礼后兵** —— Windows 上先发一次不带 `/F` 的 `taskkill /T`（关闭请求），给进程 1.5s 自己退出。Spring Boot、vite 这类控制台程序能借这个机会跑完 shutdown hook（关连接池、释放锁、删临时文件），而不是被一刀切断。POSIX 上对应 `SIGTERM` → 5s → `SIGKILL`。

   > 这里有个坑：`taskkill /T` 的**返回码不可信**——树里只要有一个进程没有控制台，整条命令就报失败，可控制台成员其实已经收到关闭请求了。所以插件不看返回码，只看进程是否真的消失。

2. **杀进程树** —— 仍未退出就上 `taskkill /PID <shell> /T /F`，覆盖 `pnpm → vite` 这类多层结构。

3. **按端口兜底回收** —— dev server 可能活得比外层 shell 久（shell 先被 Ctrl+C 打死、npm 崩溃时会变成孤儿进程，`taskkill /T` 再也追不到它），于是它永久占着端口，下次启动直接 `EADDRINUSE`。插件会按声明的端口反查监听者，**仅当该监听者的启动时间不早于本次服务启动时间**时终止它——端口本来就属于别人的进程绝不会被碰。

第 1、3 步都会在日志里留下痕迹，例如：

```
进程未在 1.5s 内响应，强制结束
外层进程已自行退出，正在按端口检查残留
已清理占用端口 5174 的残留进程（pid 27804）
```

## 日志面板

展开某个服务（点「日志」）后，日志区上方有一条工具条：

- **时间戳** —— 每行前面是 `HH:MM:SS`，没有它就没法对时序。
- **过滤** —— 子串匹配（大小写不敏感），日志刷得快时用来盯某一行。
- **清空** —— 同时清掉 host 缓冲与本地副本；host 侧的 `seq` 继续递增，所以其他打开着面板的窗口游标依然有效，不会重复拉取。
- **下载** —— 导出为 `<服务名>.log`，带 ISO 时间戳和流标记（`stdout`/`stderr`/`system`），方便存档或转给别人看。

## 已知限制

- 端口就绪判断在端口被**其他**进程占用时不作数：插件会在启动前探测该端口，若已被占用就明确写入「无法用端口确认本服务是否就绪」，改用「进程存活过宽限期」判定，并在运行状态上标注未经端口确认——不会再谎报「已就绪」。
- `detached: true` 不能用于 Windows：实测会让子进程的 stdout/stderr 完全不再到达管道，面板将看不到任何输出。
- 日志缓冲是每个服务最近 2000 行，超出后从头部丢弃。

## License

[MIT](LICENSE)
