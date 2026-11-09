# Kode 当前架构现状审计（Phase 0 / PR-001 / AUDIT-001..016）

> **2026-11-05 现状刷新（KODE-ARCH-004）**：以下 AUDIT-*/PERF-* 各节是
> 2026-10-23 的取证快照（基点 36052c4），按「快照不改写」原则原样保留；
> 与当前代码的差量统一记在文首「现状刷新」一节。冲突时以刷新节 + git 为准。

## 现状刷新（2026-11-05 · feat/kode-arch）

- **规模**（静态取证，`find`/`wc`/package.json 实测）：src/ 顶层 245 个
  .ts 模块（含子目录共 271 个）、92,581 行；
  测试 506 个 `*.test.ts` + 11 个 bench；contributes：104 命令、104 配置项、
  1 容器（kbengine-explorer）9 视图、107 activationEvents、debuggers 贡献
  仍为空（调试面走 launch/attach 配置 + vscode.debug API，非 debug provider）。
- **最大单件**（自 10-23 快照继续增长，迁移风险项）：languageProviders.ts
  7,180 行（拆分条目 KODE-ARCH-001 未实现）、extension.ts 6,112 行
  （KODE-ARCH-002 未实现）、entityMapping.ts 3,282、globalDataIndex.ts 2,155。
- **Rust workspace 已落地**（10-23 时不存在）：crates/ 10 个
  （kode-protocol/server/vfs/parser/root/index/scheduler/types/corpus/python），
  MSRV 1.97（rust-toolchain pin 1.99.0）；kode-server 已有 RPC 面：进程拓扑
  校验（process_topology.rs，C-17）、官方 def MD5（def_md5.rs，C-18）、
  线格式（wire_codec.rs/message_table.rs，C-15）、数据库 schema
  （database_schema.rs）、python 调用图（python_callgraph.rs）；方向 =
  配置先行架构（todo「配置先行架构」节：配置解析收 Rust 单一真源，
  渲染/l10n 留 TS，经 MCP 问答）。门禁：`cargo clippy --workspace
  --all-targets -- -D warnings`（Cargo.toml 头注）。
- **调试面自快照起从零建成**（AUDIT-008/011 中「deferred」项不再是空）：
  debugpy 自动注入/预检/等待启动（autoDebugpy/debugpyPreflight/
  debugpyWaitAtStartup）、附加守卫与会话登记（debugAttachGuard/
  debugSessionRegistry/debugStatusBoard，Debug Targets 视图）、端口/进程双
  模式与端口探测（debugConfig/debugpyPortProbe）、远程服务器分派
  （sshConfig/remoteConnection/remoteServerTree/remoteProcessList）、
  py-spy dump（pyspyDump）。能力边界见
  docs/design/perf-analysis-boundary.md（KODE-FEAT-002）。
- **热更新面建成**：ReloadTransport（HTTP/Telnet）双传输、状态机
  （sent/accepted/applied/failed/DIRTY/RESTART_REQUIRED）与审计台账
  （docs/hotreload/），细节现状 docs/hotreload/current-implementation.md；
  接入缺口与状态机转换验收待收口（KODE-HOT-001/002 未实现）。
- **数据库面建成**：schema/漂移检查/模拟器/查询生命周期
  （databaseSchema*/databaseDrift*/databaseSimulator/databaseQueryLifecycle*，
  Rust 化 schema 经 databaseSchemaRust）。
- **索引契约文档化**：五索引所有权与版本失效契约
  （docs/architecture/index-ownership.md，KODE-ARCH-003，含
  tests/indexOwnershipContracts.test.ts 16 断言）；统一语义索引架构另见
  docs/architecture/semantic-index.md（仍为现役文档）。
- **性能基线更新**：v0.2 基线 docs/perf/2026-11-04-v02-baseline.md
  （30k 文件/多根/大文件三场景）、进程拓扑诊断成本
  docs/perf/2026-11-04-process-topology-diagnostics.md。
- 【推断】10-23 快照的 AUDIT-011 结论「全部运行时边界都活在扩展宿主内」
  已部分松动：Rust 侧 kode-server 以子进程/LSP 形态承载解析/校验 RPC
  （processTopologyRust/databaseSchemaRust 等 TS 封装），但进程管理/
  telnet/log/webview 仍在宿主内；「脚本执行须独立服务」的书目标未达成。

## 现状刷新（2026-11-06 · main 当日批量合入）

- **规模更新**（package.json 实测）：contributes 增至 121 命令、110 配置项、
  3 键位（telnet `ctrl+]`/`ctrl+d`、热更通道 `ctrl+alt+r`）。
- **后台索引预热（BG-WARM，59eaaf5）**【已测】：激活即五阶段后台管线
  （发现链首扫等待→共享事件/方法全量首扫→依赖图→定义布局预热→逐实体
  流程图，阶段间让出主线程，可取消），面板只读消费产物缓存三态——
  done 首帧秒出（零 findFiles 零 analyze）、running 先进度页再接同一条
  在跑 Promise、missing/failed/cancelled 回落既有现算；完成标记
  `kbengine.backgroundWarmup.completed` 带代际（扩展版本+排序根指纹）。
  src/backgroundWarmup.ts、src/warmupStages.ts；台账条目见
  docs/features.md（BG-WARM）。
- **热更默认开启与快捷启用（b17ca3d / 5347782 / 6fc034b）**【已测】：
  `kbengine.hotReload.enabled` 默认 `true`；`actionName` 留空时保存 .py 即发
  默认热更请求 `POST http://127.0.0.1:8090/hotfix?module_name=<模块名>`，
  query 与 body 双带 `module_name`（src/hotReloadDefaultHotfix.ts，模块名
  resolveModuleDualName 双名称优先）；`kbengine.hotReload.configureChannel`
  按 profile 配部署级通道（三预设一键启用/高级配置/探活通过才写盘），
  状态栏通道灯与 `kbengine.hotReload.switchChannel`，
  `ctrl+alt+r` 默认键位。现状细节 docs/hotreload/current-implementation.md。
- **路径模板单一真源（10ccf1f）**【事实】：`renderPathTemplate`
  （src/workspacePath.ts:58）统一渲染 `${workspaceFolder}` 等占位，手工输入链
  （src/definitionWorkspace.ts:1284）与发现链（src/workspaceDiscovery.ts:882）
  两链同源——此前手工链漏渲染导致 def 根定位错位的问题就此收口。
- **文件变更元信息（f08cfbd 合 410e262）**【已测】：src/fileChangeMeta.ts 按
  identity+version 懒解析 module/package/processKind（module/package 仅 .py，
  大小写不敏感；记忆化键 = identity + version + 路径形态）；设计文档
  docs/design/file-change-meta.md（en/zh）与实现对齐。

- 日期:2026-10-23 · 分支:v0.2 · 执行协议:docs/kode2/KODE_2_COMPLETE_TODO.md 第 16 章
- 性质:代码取证快照。三栏口径——【事实】=源码 file:line / git 可查;【已测】=有 commit + 报告/原始输出;【推断】=由事实推出的判断,需后续验证;【待测】=无数据,不造数。
- 引用的 PR1-7 数据一律带 commit;测试为 fake-vscode + 真实索引实现的服务层口径,不含真实 VS Code UI 端到端(该项待测)。

## AUDIT-001 固定 commit 与旧 TODO 真实状态

- 【事实】审计基点 commit:`36052c47cb26290b6829632c6c3ca31341161c96`(v0.2 HEAD,`git describe` = v0.1.2-29-g36052c4;最新 tag v0.1.2,另有 nightly)。审计时 working tree 干净(0 个未提交文件)。
- 【事实】todo.md 头部声明「只放未完成任务」,故 A1-A7 区块复选框未勾≠未完成。真实完成状态以 docs/review/2026-10-22-unified-semantic-index-refactor.md 跟踪表(525-531 行)为准:PR1=89e8783、PR2=7d8736b、PR3=2aca694、PR4=2aca694 系、PR5=d4fd634、PR6=ae4256d、PR7=e6e8bc7,与 git log 实际提交一致(本审计逐条核对过)。
- 【事实】B 止血项 B-1..B-5 完成(9c8daf7/179a290/fa13ef9/d5cff3d,squash 收敛 main 为 5071dde),见 todo.md B 区块勾账。
- 【推断】todo.md 复选框与评审账本不同步是账面问题而非工程问题;PR-001 后应以本文件 + 评审账本为状态真相。

## AUDIT-002 模块树、激活入口与组合根

- 【事实】src/ 顶层 91 个 .ts 模块,共 46,366 行(不含 tests/,193 个测试文件)。最大单件:languageProviders.ts 4,681 行(全部语言 Provider 实现)、extension.ts 2,180 行(唯一入口 `activate()`,extension.ts:172)、entityMapping.ts 2,234、definitionWorkspace.ts 1,559、src/backend/pythonClassIndex.ts 1,307。
- 【事实】组合根(单实例,均在 extension.ts 内 new):`IndexScheduler`(:354)→ `EntityMappingManager(context, indexScheduler)`(:356)→ 各 Provider 注入 manager;`PythonClassIndex(indexScheduler)`(definition provider 注册处,≈:459)激活即 `scheduleBackgroundScan()`。PR3/PR5 起 EntityMappingManager 首扫与 PythonClassIndex 文件发现均经 IndexScheduler 入队。
- 【事实】Provider 注册清单(extension.ts):completion×2(:360 def+python 合选区、:619 python)、hover×2(:394 主 hover、:424 serverConfig hover)、definition×2(:433 .def/xml 导航、:459 python)、CodeLens×7(:513-:574、:1664)、InlayHints×2(:584、:594)。诊断走 DiagnosticScheduler(PR6)。无 registerReferenceProvider——引用面走命令 kbengine.symbolReferences.show。
- 【事实】PR2-PR6 数据面/调度面:documentStore.ts(342 行)、indexScheduler.ts(422)、semanticIndex.ts(329)、dependencyGraph.ts(164)、diagnosticScheduler.ts(322),架构图见 docs/architecture/semantic-index.md。
- 【推断】import 图分层清晰:extension.ts(装配)→ languageProviders(实现)→ PR2-6 核心数据面 → IO 面(scanRoots/entityMapping);但 languageProviders.ts 4,681 行是迁移时最大单件风险,Rust 化需按 Provider 逐个拆。

## AUDIT-003 onLanguage:python 激活的初始化面

- 【事实】activationEvents(package.json):`onLanguage:kbengine-def`、`onLanguage:python`、`workspaceContains:**/*.def`、54 个 onCommand。
- 【事实】`activate()` 无「是否 KBEngine 工作区」前置门:一旦激活即(a)按 `kbengine.python.apiMetadata`(默认 true)异步 buildEngineApiCatalog;(b)实例化 IndexScheduler + EntityMappingManager;(c)注册全部 Provider;(d)PythonClassIndex.scheduleBackgroundScan()(extension.ts:172-660)。
- 【事实】PR5 后首扫已后台化:Definition 首查不等全仓扫描(U1 首查 475.34ms,d4fd634,docs/perf/2026-final-report.md §3)。 **2026-10-28 现场复核注(P0-4d)**:服务层口径成立(不等全量收尾);现场口径冷首查 1189ms 仍含 ~1.05s 首扫等待、结果晚到——「不等」限定为不阻塞等收尾,见 docs/review/2026-10-28-p0-4d-report-audit.md §1.1。
- 【结论(事实+推断)】onLanguage:python 确会在任意 Python 工作区拉起全套 KBEngine 机械(索引调度、后台扫描、EntityMappingManager);因首扫后台化+交互限流,不再阻塞首请求,但内存/事件循环占用在非 KBEngine 工作区是纯开销。**无 KBEngine 工作区负案例:未实现、未测——待测**(书第 3 章 PR-006 root-discovery 范围)。

## AUDIT-004 四类 XML 的解析器与调用方

- 【事实】唯一 XML 运行时解析器:vendored fast-xml-parser(`vendor/fast-xml-parser/fxp.cjs`),仅经 src/backend/defParser.ts(516 行)以 preserveOrder 模式使用;DefDocument 保留 tagStart/closeTag 偏移 + lineStarts,支持 file:line 源定位;模块级 8 条目 LRU 解析缓存(src/backend/defParser.ts:16-18)。
- 【事实】调用方:parseDefAst/parseDefDocument 在 languageProviders.ts 有 10 处调用;src/backend/entitiesXmlAnalysis.ts(entities.xml 清单重复实体诊断)与 definitionSemantics 复用同一解析面。
- 【事实】types.xml/alias.xml:entityMapping.ts 直接 readFileSync(:752、:1309、:1810)解析,类型注册表走 SemanticIndex 快照(PR4 起);kbengine.xml + kbengine_defaults.xml 合成:serverConfigMerge.ts(:153、:202、:216)。
- 【已测】重复 parse/read 的止血证据:同版本 .def 解析命中率 96.1%(n=51,PR2 7d8736b,docs/perf/final-pr2-run.txt);组合根 mtime+size 指纹缓存重派生零重读、`findFilesAcrossRoots` 生命周期缓存(PR5 d4fd634)。
- 【推断】残余同步读集中在 entityMapping.ts 直读路径(有 watcher 失效联动),已非热路径;但「同一文件被 manager 直读与 documentStore 快照两条路各读一次」的结构性重复仍存在,迁移 VFS 时应合并(列入 CSV 风险列)。

## AUDIT-005 核心索引/类型/组合根的真实名称与路径

| 书中概念 | 实际名 | 路径:行 |
|---|---|---|
| EntityMappingManager | `EntityMappingManager` | src/entityMapping.ts:144 |
| PythonClassIndex | `PythonClassIndex`(五轴版本:classes/bases/methods/mro/compositionRoots) | src/backend/pythonClassIndex.ts:311 |
| type registry | `SemanticIndex` + `SemanticTypeRegistrySnapshot<T>` | src/semanticIndex.ts:70 |
| composition root | src/compositionRoots.ts + PythonClassIndex rootsEpoch/赋值桥指纹 | src/compositionRoots.ts(287 行) |
| definitionWorkspace | `DefinitionWorkspace`(文件级) | src/definitionWorkspace.ts |
| 依赖失效 | `SemanticDependencyGraph`(fullRebuild 恒 false) | src/dependencyGraph.ts |
| 调度 | `IndexScheduler` / `DiagnosticScheduler` | src/indexScheduler.ts:129 / src/diagnosticScheduler.ts:81 |
| 快照 | `DocumentStore`(URI 规范化+版本+行索引) | src/documentStore.ts |
| 局部符号索引 | `WorkspaceIndex` | src/workspaceIndex.ts:22 |

## AUDIT-006 同步 IO 盘点(非测试代码)

- 【事实】`fs.*Sync` 共 121 处,分布 25 个文件;Top:workspaceDiscovery.ts 17、generatorForms.ts 14、entityMapping.ts 10、codeGenerator.ts 9、pythonStubExport.ts 8、definitionWorkspace.ts 6、extension.ts 5、engineCompatibility.ts 5、debugConfigBootstrap.ts 5、serverManager.ts 4、logHub.ts 4、src/backend/defChain.ts 4、clientSdkGenerator.ts 4。
- 【事实】`getText().split` 全文拆行残余 2 处热区外:languageProviders.ts:4063、eventApi.ts:81(documentStore.ts 内 3 处为注释/口径说明)。hover/inlay 高频路径已改快照行数据(PR2,7d8736b)。
- 【事实】`statSync` 8 个文件:semanticIndex.ts:249、definitionWorkspace.ts:303、entityMapping.ts:306、scanRoots.ts:23、defCallChain.ts:240、quickActions.ts:774、serverManager.ts:405、logHub.ts:186。PR4 已废除逐次 statSync 类型指纹(类型注册表改纯内存快照)。
- 【事实】`workspace.findFiles`/glob:scanRoots.ts 12、entityMapping.ts 9、hotReload.ts 7、languageProviders.ts 5、其余零散。`ensureScanned` 14 处引用全部在 src/backend/pythonClassIndex.ts(PR5 后首查路径不再等全量,后台补全)。
- 【已测】交互请求无全仓遍历:PR7 验收 §9.2 #5/#6 通过(docs/perf/2026-final-report.md §4)。

## AUDIT-007 四主请求真实调用链与等待点

- 【事实】所有 Provider 外壳统一经 `startLanguageServiceOperation` 打点(extension.ts:330-356 定义),记录 fileKind/documentVersion/ok|miss|error。
- **hover**:`registerHoverProvider` → `KBEngineHoverProvider(entityMappingManager).provideHover`(async)。等待点:waitForInitialScan 5s 超时 + 入口 2.5s 总预算 race(`kbengine.hover.asyncBudgetMs`);B-1 修复后冷悬停 12-14ms/热 8-10ms(1501-def 树实测,9c8daf7)。
- **definition(.def/xml)**:`KBEngineDefinitionProvider(entityMappingManager).provideDefinition`,读 semanticIndex 快照,无全仓等待。**definition(python)**:`PythonDefinitionProvider(entityMappingManager, pythonClassIndex)`;PR5 起先查快照+已建索引,后台补全量;【已测】U1 冷首查 475.34ms/1 命中(全量口径对照 107,737→100,492ms),重复查询 P50/95/99 = 16.00/22.10/23.60ms(n=40,d4fd634,final-report §3)。
- **completion**:`KBEngineCompletionProvider`(.def+python 合选区,触发字符 `< > / : .`)+ `pythonCompletionProvider`;【待测】大型集端到端 P95 无 bench(final-report §9.2 #2 未测量)。
- **diagnostics**:文档事件 → DiagnosticScheduler.requestQueued(版本令牌,最新胜出)→ validateDocument/validateEntitiesXmlDocument(同步计算)→ 直接写 collection。【已测】同脚本诊断重算 19→7 次、无关变更 0(ae4256d,PR6 报告)。
- **references**:无 LSP references provider;命令 kbengine.symbolReferences.show 走自定义引用图(src/backend/defReferenceGraph.ts)。【待测】未入性能预算考核。
- 【推断】等待点残余风险:hover 的 5s 首扫等待在万级文件冷启动仍会触顶(基线冷索引 100s 量级),PR5 只解了 definition;hover 冷启动体验待补 bench。

## AUDIT-008 能力矩阵(迁移对照,明细见 migration-inventory.csv)

- 【事实】contributes:54 commands、1 view container(kbengine-explorer)含 5 views(quickActions/entityExplorer/serverControl/telnetStatus/config)、65 个 `kbengine.*` 配置项、语言 kbengine-def(+grammar/language-configuration)、3 组 snippets(def/types-xml/python)、2 keybindings、jsonValidation(**/.kbengine/debug.json)、themes。
- 【事实】debuggers contribution 为空(无 debug provider 注册);debugConfig.ts/debugConfigBootstrap.ts 只做 launch.json 生成/附加配置与 debug.json schema(commands kbengine.debug.*)。
- 【事实】测试面:193 个测试文件,门禁 `pnpm test:unit` ≥2,799 通过(PR7 实跑 2,799 passed/7 skipped)+ tsc/eslint 零错。

## AUDIT-009 `.pyi` 生成算法

- 【事实】无 Python AST、无动态执行 Python:src/ 下无 `spawn('python…')`/`exec('python…')`/`import ast` 路径。三套生成器全部文本发射:
  1. `KBEngine.pyi`(pythonStubExport.ts):从 kode 自有符号索引 kbeModuleIndex 的 `buildKbeStubExportContent` 发射,与虚拟桩文档同源;可选拼装引擎 typings(`typings/_KBEngine_*.pyi` 12 模块固定序)。开关 `kbengine.python.stubExport` 默认开。
  2. pythonTypeStubs.ts:types.xml 自定义类型 → `kbe_types.pyi` plan/content 纯函数构建。
  3. entityTypeStubs.ts:.def 实体属性/方法桩,带 `# source: types.xml:行 / def 文件` 源注记。
- 【已测】`.pyi` 遮蔽实验:pyright 1.1.414 下可见 stub 会隐藏 runtime-only 符号(docs/review/2026-10-22-pyi-shadow-experiment.md);全量 .py→.pyi 生成默认保持关。
- 【推断】算法是「自有索引/文本正则」路线,非 AST;复杂注解(联合、泛型、装饰器签名)保真度待评估——待测(书 9 章/ADR-105、ADR-110)。

## AUDIT-010 代码生成的写入行为

- 【事实】codeGenerator.ts:.def 写入(:211)与实体 .py 写入(:376)**无覆盖保护**(目标已存在也直接 writeFileSync);entities.xml 注册有防重(regex `<Name(?=[\s>/])` 检查+警告,:497-522)后插 `</root>` 前写回。
- 【事实】generatorForms.ts 有 `writeOrSkip(filePath, content, overwrite)`(:422)显式覆盖开关;types.xml/entities.xml 写回路径(:457、:473、:494)。
- 【事实】pythonTypeStubs `exportPythonTypeStubs`:用户目录目标已存在→跳过(「按用户资产不覆盖」);内容一致→零写;types.xml watcher 自动重生成(:602)。pythonStubExport:内容与磁盘一致时零写。
- 【事实】源位置跳转:generatedSourceMap.ts `resolvePythonTypeStubSource`/`resolveEntityTypeStubSource` + GeneratedSourceCodeLensProvider(stub 内 `# source:` 注记回指 def/types.xml 行)。
- 【事实】版本/冲突处理:生成文件无版本字段,冲突语义=跳过或覆盖二值;无备份、无三方合并。【推断】codeGenerator 的裸覆盖与 PR-001 红线(用户文件写入须单独审核)相悖,迁移时列入 typings/codegen 风险项(CSV 风险列)。

## AUDIT-011 运行时边界(log/terminal/HTTP/telnet/watcher)

- 【事实】进程:processManager.ts(child_process.spawn,进程表跟踪,SIGTERM→SIGKILL 降级)与 serverManager.ts(KBEngine 组件 start/stop/restart)。全部在扩展宿主进程内,无常驻 Core 子进程。
- 【事实】log:logHub.ts 进程内 EventEmitter 批处理(onBatch),sha256 指纹去重(:101),loggerPort 配置接收端口;logWebView/monitoringWebView 为 webview 面。日志采集为 TCP/端口接收形态,连接生命周期与 logAutoConnect 配置联动。
- 【事实】telnet:telnetClient.ts `net.connect` + SocketFactory 注入,状态机(connecting 等),telnetService 定时探测(`kbengine.telnet.probeIntervalSeconds`,0=按元件 kbengine.xml `<telnet_service>` 段回落引擎 defaults/内置端口表);自动握手密码不落日志。
- 【事实】HTTP:仅出站客户端(httpRequestService.ts,默认超时 10,000ms,响应预览截断 4,000 字符);无内置 HTTP 服务器。
- 【事实】watcher 清单(createFileSystemWatcher/onDidSave):entityMapping.ts×3(types.xml/alias.xml/实体文件失效联动)、extension.ts×3、hotReload.ts×1、pythonTypeStubs.ts×1(**/types.xml)、workspaceIndex.ts×1(py glob)、languageProviders.ts×1、debugConfig.ts×1。hotReload 显式 dispose/重建;其余经 subscriptions 释放。
- 【推断】所有运行时边界(进程/端口/socket/watcher)都活在扩展宿主内——与书 ARCH-002「语言请求不得 spawn 进程、脚本执行须独立服务」存在结构性差距,是 Rust Core 迁移的核心动机事实。

## AUDIT-014 旧 A1-A7 → 新 Phase 映射

| 旧项 | commit | 新账本位置 |
|---|---|---|
| A1 PR1 性能观测与基线 | 89e8783 | Phase 0(PERF-005/007 分段时延已落地服务层口径) |
| A2 PR2 documentStore | 7d8736b | Phase 1 PR-004 core/vfs-snapshot 的 TS 侧前身(快照/同版本单解析契约已锁定) |
| A3 PR3 indexScheduler | 2aca694 | Phase 2 PR-009 invalidation-scheduler 前身(优先级队列/任务合并/失败恢复已锁定) |
| A4 PR4 semanticIndex+dependencyGraph | 2aca694 系 | Phase 2 PR-007/PR-008 前身(统一查询、依赖失效、多根查找顺序取证 docs/review/2026-10-23-pr4-lookup-order-forensics.md) |
| A5 PR5 Definition 去全仓阻塞 | d4fd634 | Phase 2 PR-010 双轨对比的 TS 基线(U1 475.34ms 即对拍基准) |
| A6 PR6 诊断一致性 | ae4256d | Phase 3 PR-011 诊断版本化前驱 |
| A7 PR7 复测回归 | e6e8bc7 | Phase 0 基线收官(docs/perf/2026-final-report.md) |

- 【已测】永转/超时回归测试现状:hover 永转修复(B-1,9c8daf7→5071dde)与调度器失败恢复不永久 pending(PR3 A3-4)均有测试锁定,在 2,799 门禁内;诊断重算计数断言(tests/diagnosticScheduler.test.ts)。
- 【推断】A1-A7 与书 PR-002(fix/ts-hotpath)的交叠:书中「明显阻塞路径止血」实际已被 A2-A6 完成;PR-002 应改为消耗基线 §6 遗留清单(Hover/Completion bench、内存记录、多轮基准)。

## AUDIT-015 retained / moved / reworked / deferred

- 逐模块分类见 docs/architecture/migration-inventory.csv(「迁移方式」列)。汇总:retained(不动)≈语法包/主题/snippets/schema;reworked(TS→Rust 逐模块替换)=解析/索引/查询/诊断核心;moved(原样搬入新宿主)=HTTP 快捷请求、telnet 客户端、日志面、webview;deferred=debugger 面(本就无 provider)、数据库模拟等非语言功能。
- 【推断】能力零丢失要求下,multi-root 同名实体/类的查找顺序(已取证+测试锁定)必须先于 Rust 查询核心对拍。

## AUDIT-016 HR-AUDIT:HTTP/Watch/Hash 代码真相与差异清单

- 【事实】HTTP 快捷请求**已实现**:httpRequests.ts(条目解析校验 + 模板变量)+ httpRequestService.ts(出站请求/超时/输出);命令 kbengine.httpRequest.run、kbengine.httpRequests.run。模板变量:`${module}`=按 `__init__.py` 包边界上扫(httpRequests.ts:108-116;base/cell 无 `__init__.py` 不算包段)、`${moduleBasename}`=末段一层、`${filename}`、`${line}`、`${sel}` + VS Code 官方变量族(经 variableSubstitution 单一真源);字面替换,无 URL 编码。
- 【事实】内置示例端点/参数名以 2026-11-06 用户令为准:`POST http://127.0.0.1:8090/hotfix?module_name=${module}`,query 与 body 各带一份 `module_name=${module}`(兼容不同服务端读参口径,同值重复无害)(src/httpRequests.ts、package.json `kbengine.httpRequests` 默认值、docs/zh/guide/configuration.md,测试锁同步);旧的错误拼写(批152 记录的 `8000/api/hotfix?…`)已全仓清零,`tests/hotfixSpellingGate.test.ts` 全量 grep 断言。服务端(KBEngine 管理接口)实现不在本仓库——HR-AUDIT-009 待测。
- 【事实】Watch:hotReload.ts 是「保存/监视→去抖(默认 500ms)→触发热更」,**默认开**(2026-11-06 用户令;显式 `enabled=false` 仍关);未配 `actionName` 时经 TS 发默认 HTTP 热更请求 `POST http://127.0.0.1:8090/hotfix?module_name=<模块名>`(body 同带 `module_name=<模块名>`,双带兼容不同服务端,src/hotReloadDefaultHotfix.ts),一键关 = 状态栏点击 / `kbengine.hotReload.toggle`。
- 【事实】Hash/Digest:src/ 无 .def/.xml 哈希或引擎 Digest 实现(仅 logHub.ts:101 用 sha256 做日志去重指纹);热更新成功确认(transport_success/accepted/applied 分类)无任何代码。
- 【差异清单(现状 → 书 19 章规范)】
  1. 模块名:现 `${module}`=完整包路径(entities.fight.FightAI),书要求双名称模型 requestModule=fight.FightAI(父目录名+文件短名)+ fullModule 展示——需 HR-MOD 改造;
  2. 成功语义:现仅展示 HTTP 响应预览,无 accepted/applied 区分、无「请求已发送/待确认」状态——需 HR-STATE;
  3. Watch→HTTP:2026-11-06 起默认路径已连线(保存 → 默认热更 POST `http://127.0.0.1:8090/hotfix?module_name=<模块名>`,src/hotReloadDefaultHotfix.ts);走 quick action 的按目标/幂等语义仍需 HR-WATCH adapter;
  4. Hash:全缺——HR-HASH 全量待建;
  5. 记录唯一化:无 targetId+rootId+URI 记录模型;
  6. 安全:无 workspace 白名单/endpoint 批准/默认关的 per-target 开关(hotReload 的一键开关与默认端点约束可复用)。
- 【事实】逐项实现路径落点:本文件即差异清单指针;HR-AUDIT-012 的 docs/hotreload/current-implementation.md 已由并行 HR-PR-01 落库(commit 1e30ff8,与本审计同一基点 SHA 36052c4),HR 差异清单以该文件为准。

## PERF-002/003/004 fixtures 规格(现状与差距)

- 【已测】现有生成器 scripts/generate-perf-assets.mjs(确定性):small 7 / large 30,005(.py) / multi-root 18(3 根,同名实体 Avatar+同名类 Inventory) / big-py 5(单文件 8,000 方法) / def-heavy 1,323(1,200 .def + 40 组 entities/types/alias 变体) / noise 406(.git/build/third_party 干扰)。复现:`KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts`(89e8783 起,至 e6e8bc7 复测同资产)。
- 对照书 S/M/L/XL/XRoot 分档:S≈small ✓;L≈large ✓(30k>10k);multi-root 覆盖 XRoot 的 3 根与同名冲突 ✓;**M(2k) 无现成档——待建(生成器参数化即可)**;**XL(50k+) 待建**;深继承、循环别名、不完整 XML、非 ASCII 路径**待建**。
- PERF-004 真实引擎样例:待测(fantasydemo 真实脚本批 = 旧 C-9,未排期);合成与真实样例隔离要求已预留目录规划。

## PERF-005 分段时延口径(已测/待测)

- 【已测】服务层分段(PR1 埋点 11 类事件:completion/hover/definition/diagnostics/python-index-scan/entity-mapping-scan/type-registry-query/file-discovery/document-parse 等):冷索引 107,737→100,493ms;去阻塞首查 475.34ms;热查询 P95 0.02-22.1ms;def 热复扫 17-18.7ms;失效 6.7-11.3ms;诊断重算 19→7。来源:89e8783 基线 + e6e8bc7 复测,原始输出 docs/perf/*.txt。
- 【待测】extension activation(真实 VS Code 激活)、workspace discovery、publish 到编辑器(端到端)、Core spawn/handshake(Rust Core 尚不存在,N/A 直至 PR-003)。所有服务层数字不含 UI 序列化与 provider 调度开销。

## PERF-015 跨机器口径

- 【事实】PR1-7 全部数字出自同一台机器(docs/perf/hardware.md);final-report §5 如实记录单轮抖动(机械盘 + 热缓存口径下 U4 两轮 130.3s/89.9s,同代码)。
- 【规则(采纳书 PERF-015)】跨机器不比较绝对速度;主报告用本机固定基准;现所有结论为单轮,**多轮取中位/置信区间待建**(bench `--repeat`)。

## PERF-016 decisions.md

- 【事实】docs/perf/decisions.md 尚不存在;现有优化证据分散于 docs/perf/2026-pr2/3/5/6-*.md 与 docs/review/2026-10-22-unified-semantic-index-refactor.md。受本 PR「只产三文件」约束未建——待建,建时逐项迁移(证据、取舍、回退)。
