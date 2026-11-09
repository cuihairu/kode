# TypeScript → Rust 迁移接线核查（第一批）

基准：`b6ce1621` 附近的源码；本表为静态调用链核查，不代表功能对拍、性能或全仓清单已完成。状态以用户入口是否使用 Rust 为准；TS 中保留 VS Code UI、连接驱动或输入收集不自动视为缺陷。

| 能力 | 已核实入口及 Rust 位置 | 状态 / 下一步 |
| --- | --- | --- |
| 通用语言服务切流 | `src/kodeCoreGate.ts` 的 `servingMode` 对 rust 配置仍返回 ts；`src/languageProviders/navigation.ts` 先返回 TS definition，另行 shadow 比较 | **未切流**。Rust 结果可用于 shadow，不能以 Rust server 存在认定语言服务迁移完成；需逐 provider 核对契约、语料、编辑版本/取消和对拍门禁。 |
| Python 类索引及解析 | `src/pythonClassIndex.ts` 使用 `parsePythonFile` / `parsePythonFileResponsive`；`src/pythonParserWorker.ts` 仍调用 TS 解析器 | **TS 实际执行**，worker 隔离不等于 Rust 迁移。需追踪定义、MRO、未保存文档与增量失效，再与 `kode-python` 对拍。 |
| 数据库 schema 推导 | `src/databaseSchema.ts` 先调用 `buildDatabaseTablesInRust`，不可用时调用 `deriveDatabaseTables` | **Rust 优先，保留 TS 回退**；应覆盖两路径行为、输入及失败对拍，尚不能删除旧实现。 |
| 配置解析/派生 | `src/serverConfigResolve.ts` 调用 `$/kode/config/resolve`，`src/configDerive.ts` 调用 `$/kode/config/derive`；解析实现在 `crates/kode-parser/src/config.rs` | **Rust RPC 已接入对应路径**；此结论不覆盖所有配置相关功能和生命周期。 |
| 实体依赖图 / Python 调用图 | `src/entityDependencyWebView.ts` 调用 `buildDependencyGraphInRust` 和 `buildPythonCallGraphInRust` | **所查面板调用 Rust**；需逐个核实其他消费入口、失败状态和功能覆盖。 |
| 玩家克隆计划与归档 | `src/playerDataCloneCommands.ts` 调用 `planCloneExport`、`writeCloneArchive`、`planCloneImport`；RPC 注册见 `crates/kode-server/src/db_clone.rs` | **计划和归档已接 Rust**；TS 仍承担数据库驱动、行编解码及界面编排。 |
| 玩家克隆真实读写 | `src/playerDataCloneCommands.ts` 调用 `executeExportPlan` / `applyImportPlan`；`crates/kode-server/src/db_clone.rs` 未注册 Rust SourceReader/ImportApplier 的执行 RPC | **未接 Rust 执行器**。Rust 库具备实现不代表用户入口具备相同事务、预算和重复导入保证；已在 KODE-REVIEW-001..006 跟踪。 |

## 后续核查规则

按用户可见功能逐条记录 TS 入口、Rust 实现、RPC 注册、默认模式、失败/回退、对应测试及真实环境验收。将“未迁移”“Rust 优先但保留回退”“仅 shadow”“无证据”分开；迁移前不得删除 TS 路径或以新增 crate / RPC 代替接线验收。本表未枚举所有命令、provider 和配置，不能据此声称迁移核查完成。

## 第二批：更多已核实入口

| 能力 | 已核实入口及 Rust 位置 | 状态 / 下一步 |
| --- | --- | --- |
| .def 补全、悬停、跳转 | `src/activate/languageServices.ts` 注册 TS provider；definition 的 Rust 查询仅通过 `shadowCompareDefinition` 对拍，`src/kodeCoreGate.ts` 的 `serveFromRust()` 恒为 false | **用户入口未切换到 Rust**；须逐能力验证完整契约，不能仅翻转总开关。 |
| .def 补充诊断 | `src/languageProviders/validation.ts` 的 `observeRustDefFindings` 仅在 gate 模式非 `ts` 时异步追加部分结果；批量分析 `src/defAnalysisWiring.ts` 走 Rust 优先、TS 回退 | **按入口不同而不同**：批量分析接线，实时诊断为条件性追加，不是统一 Rust 接管。 |
| Python 方法符号表 | `src/entityMappingHelpers.ts` 的 `collectPythonMethods` 调 `buildPythonSymbolsInRust`，不可用时 `parsePythonMethodBlocks` 回退；文件读取仍在 TS | **Rust 优先，TS 回退**；与上表仍由 TS 提供的 Python 类索引不是同一能力。 |
| 消息表 | `src/extension.ts` 经 `buildEntityMessageTableShared`，`src/messageTableEntity.ts` 优先 Rust，不可用回退 `buildMessageTable` | **Rust 优先，TS 回退**。 |
| 客户端 SDK | `src/sdk-gen/clientSdkGenerator.ts` 的 `generateClientSdkEntities` 优先 `generateClientSdkInRust`，不可用回退 `generateClientSdkEntitiesFallback` | **Rust 优先，TS 回退**；写入前预检与输出编排仍在 TS。 |
| 进程拓扑诊断 | `src/activate/diagnostics.ts` 调 `validateProcessTopologyInRust`；Rust 失败时返回空诊断 | **Rust 接入该路径，失败降级为空结果**；需要可观测性，不能将空诊断解释为已通过检查。 |
| DEF 引擎摘要 | `src/defMd5Rust.ts` 暴露 Rust RPC 包装，但 `rg` 仅发现函数定义及测试调用；`src/hotReloadDefHash.ts` 的 `negotiateEngineDigest` 同样无生产调用 | **有实现但未发现生产消费链**；不得依据 crate 或包装器宣称用户侧摘要协商已迁移。需核实目标入口和输入来源，再做端到端接线。 |
| Ruff 诊断 | `src/activate/utilityCommands.ts` 注册命令并调用 `runRuffLintCommand`，`src/ruffLint.ts` 经 Rust RPC 调用 Ruff | **命令路径已接 RPC**；Ruff 本身仍是外部工具，不应称作 Rust Core 自实现解析。 |

核查时发现克隆导出另有协议形状缺口：Rust `PlanFilter` 输出 `{kind: ...}`，此前 TS 按字符串判断；`a721f91c` 已修复。`tests/playerDataCloneMysqlReal.test.ts` 可通过 `KODE_CLONE_TEST_MYSQL_PORT` 与 `KODE_CLONE_TEST_SERVER` 接入真实 MySQL 和 kode-server 验证计划、归档及导入执行。

## 第三批：原迁移清单的执行路径复核

原 `docs/architecture/migration-inventory.csv` 记录的是 2026-10-23 的迁移建议，不能把其中 `moved` 当作今天的完成状态；其中 `src/languageProviders.ts` 也已拆分。本批以实际装配和调用为证据，未执行全量行为对拍。

| 原清单范围 | 当前证据及状态 |
| --- | --- |
| 扩展装配 / 编辑器 provider | `src/activate/coreServices.ts` 创建 TS `IndexScheduler`、`EntityMappingManager`；`src/activate/languageServices.ts` 注册 TS 补全、悬停、定义、引用、重命名等 provider。**TS 用户入口仍在使用；Rust 部分仅 shadow，切流未完成。** VS Code 注册与 UI 本身应保留 TS。 |
| .def 解析 / 文档快照 | `src/languageProviders/shared.ts` 的 `parseDefAst` 使用 `getOrParseDocumentSync` 和 TS `parseDefDocument`；`src/databaseSchema.ts` 的 def 解析使用 TS worker 及 TS 回退。**Rust parser 存在，所查生产链尚非 Rust。** |
| 索引 / 依赖失效 / 调度 | `src/entityMapping.ts` 创建 TS `SemanticIndex` 与 `SemanticDependencyGraph`，`src/pythonClassIndex.ts` 创建自身 TS 依赖图，`src/activate/coreServices.ts` 创建 TS 调度器。**所查索引及失效路径仍在 TS；Rust 对应 crate 存在不代表接线完成。** |
| Python 类/MRO 与组合根 | `src/activate/languageServices.ts` 创建 TS `PythonClassIndex`，其导入 `deriveCompositionRoots` 并使用 TS 解析/worker。**类索引、组合根仍为 TS；与 Rust 优先的 Python 方法符号提取分开评估。** |
| 工作区发现 / 扫描根 | `src/activate/utilityCommands.ts` 调 TS `runWorkspaceDiscovery`；扫描根仍由 `src/scanRoots.ts` 管理。**该发现入口和扫描编排仍为 TS；Rust root crate 的正式消费面需逐一查证。** |
| Python 及实体 stub | `src/activate/generators.ts` 注册/调用 `exportKbeStubs`、`exportPythonTypeStubs`、`exportEntityTypeStubs`。**所查生成命令仍在 TS；需保留现有写入保护与 source map 做对拍。** |
| 配置 / 数据库表 / 消息表 / SDK | 配置解析经 Rust RPC；数据库表、消息表及 SDK 为 Rust 优先且保留 TS 回退，分别见上表。**这些是已接线但不能直接移除回退的混合路径。** |
| 进程、Telnet、HTTP、热更新 | `src/activate/serverControls.ts`、`src/activate/views.ts`、`src/activate/hotReload.ts` 装配 TS 管理器/服务。**运行时入口仍在 TS；是否迁移到独立 Rust runtime 需要结合协议、平台与安全边界逐功能验收，不能将 UI 一起机械迁移。** |
| 生成器、调试装配、主题、语法资源 | `src/activate/generators.ts`、`src/activate/serverControls.ts` 仍装配 TS 向导/调试；语法主题为静态资源。**保留或重构边界尚需逐项判断；不是所有 TS 代码都应迁移。** |

剩余工作：逐个命令、provider 和 Rust RPC 建可复现的端到端矩阵，识别生产中完全未调用的 RPC，补齐新旧路径与用户资产保护对拍；本批不声称完成全仓清单或允许切换总 serving 门禁。

## 第四批：Rust RPC 注册与消费面

静态枚举 `crates/kode-server/src/**` 的 `reg.register` 得到 21 个注册项；对照 `src/` 字面方法名与调用方。结论限定当前树，测试调用不等于生产接线。

- `config/resolve`、`config/derive`、`processTopology/validate`、`lint/analyzeDef`、`python/callgraph`、`python/symbols`、`sdk/generate`、`dependency/graph`、`databaseSchema/build`、`messageTable/build`、`ruff/lint` 与五个 `dbClone/*` 均有 TS 包装或消费路径；其默认模式、回退及覆盖程度分别以上表和对应源码为准。
- `def/md5` 有 TS 包装但当前未见生产调用，见 RUST-MIGRATION-AUDIT-003。
- `apiDocs/lookup` 未发现 TS RPC 消费：`src/pythonApiHoverDocs.ts` 使用同源生成的 TS `API_DOC_ENTRIES`；MCP 的 `explain` 复用文档数据。**数据同源不等于 hover 已迁 Rust**；是否切换须验证本地查询时延和断连行为。
- `wire/encode` 与 `wire/decode` 未发现 TS RPC 消费；`crates/kode-mcp/src/kb.rs` 直接复用 Rust 编解码库提供 MCP 样例。**MCP 已使用 Rust 库，VS Code 生产 RPC 消费未发现**；不能据此断言已有 VS Code 功能丢失，应先明确迁移目标。
- `echo` 是 RPC 基础测试入口，不当作需要迁移的用户功能。

以上覆盖注册项的字面调用核查，不包含标准 LSP 方法、动态方法名、不同构建配置或全体 VS Code 命令；无法从静态引用推出对拍通过或已正式切流。

### 工作区发现命令第一项迁移

`$/kode/workspace/scanAnchors` 已将异步 `runWorkspaceDiscovery` 命令的深扫描优先接入 `kode-root`，失败或结果形状不合规回退原 TS；测试覆盖真实 kode-server RPC、六棵 golden 对拍、旧响应失效及回退。**范围仅限该命令预热**：同步激活预热、`cachedScan` 的其他调用及 VS Code 交互仍在 TS，不能因此标记整个发现系统迁移完成。

## 第五批：完整用户可见能力矩阵

本批静态枚举全部用户可见入口并逐条对照 Rust 接线，限定当前工作树（含 `src/languageProviders/hover.ts` 处于另一会话未提交编辑中，见下）。方法：

- 命令面：`package.json` `contributes.commands` 程序化提取得 **132 条**；另有 **1 条**仅经 `registerCommand` 注册未列入 contributes（`kbengine.playerData.previewRedisKeyspace`，`src/activate/serverControls.ts` 区域）。注册面以字面 `registerCommand('kbengine.…')`、常量解析及两处循环注册（`src/databaseWiring.ts:664-677` 的 cloneCommandEntries 8 条；`src/activate/hotReload.ts:396` 经依赖注入转发到 HotReloadStatusController，注册的仍是已计命令）复核，无遗漏的动态注册。
- provider 面：`src/activate/languageServices.ts` 共 27 处 `vscode.languages.register*`（:105/:151/:182/:216/:226/:231/:240/:302/:428/:435/:453/:467/:508/:532/:542/:552/:562/:572/:578/:590/:597/:604/:611/:618/:624/:632/:641）。
- 诊断面：`createDiagnosticCollection` 全仓 13 处（13 个 collection，见 C 表）。
- 总门禁复核：`src/kodeCoreGate.ts:302-304` `serveFromRust()` 函数体为 `return false`（恒 false）；`servingMode` getter（:278-280）只可能返回 `'shadow'|'ts'`；全 `src/` 无 `serveFromRust()` 生产调用方。因此一切"模式非 ts 才并入 Rust 结果"的分支当前不可达，凡 Rust 结果仅在比较/镜像中使用的入口均计为「仅 shadow」。
- Rust RPC 注册面：`crates/kode-server/src/**` 的 `reg.register` 全量枚举得 **22 项**（第四批记 21 项为不含 `echo` 的口径，本表 E 节含 `echo` 合计 22）。
- 状态标签沿用前四批口径：`未迁移`（用户入口由 TS 执行，crate/测试存在不算迁移）、`仅 shadow`（TS 入口运行，Rust 结果只用于比较/镜像，不面向用户）、`Rust 优先+TS 回退`（入口先调 Rust，失败回退 TS）、`Rust 唯一实现`（该入口此路径无 TS 回退）、`未核实`（无静态证据，不猜测）。
- 反自欺规则：每行均出自实际读取代码（grep + Read）；生产 TS 消费链追不到 Rust 调用即记 `未迁移` 并给出证据；Rust RPC 有注册但无 TS 消费方的单独成行暴露（E 节）。本矩阵只证明**接线**，不证明行为对拍，见结论。

### A. 命令面（63 行覆盖 133 条命令）

| 能力 | TS 入口(file:fn) | Rust RPC | Rust 位置 | 门禁/默认 | 失败/回退 | 测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kbengine.refreshExplorer | activate/views.ts 树刷新 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.consoleLogTail.show / .toggle / kbengine.consoleComponentPanel.refresh | activate/console.ts | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.entity.open / kbengine.entity.method.open | activate/views.ts 打开 def/方法 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.defMethodConsistency.revalidate | activate/diagnostics.ts（collection :526） | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.database.open | activate/views.ts / databaseWiring | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.database.simulate / exportSimulation | databaseWiring.ts TS 模拟器 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.database.checkDrift / checkAllDrift | databaseWiring.ts TS 漂移检测（MySQL 对比执行在 TS）；其读取的配置解析腿经 ensureConfigResolved 走 `$/kode/config/resolve` | `$/kode/config/resolve`（间接） | config_rpc.rs:264 | 默认即调 | 配置解析失败降级 null 树；漂移执行本身无 Rust 路径 | databaseWiring 单测（漂移逻辑） | 未迁移（仅间接依赖 Rust 配置腿，漂移检测本体 TS） |
| kbengine.database.previewTable / showDriftEvidence | databaseWiring.ts | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.database.previewSchemaImpact | databaseWiring.ts:505-538 → `getDatabaseSchemaSnapshot`（同步冷路径，databaseSchema.ts:425 TS） | — | — | 不涉 Rust（缓存填充腿见 D 节 warmup） | — | — | 未迁移 |
| kbengine.clone.configureSource / configureTarget | databaseWiring.ts:664-677 循环注册，TS 表单/连接配置 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.clone.testSource / testTarget | 同上，TS mysql2 连接测试 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.clone.inspectArchive | databaseWiring.ts → inspectCloneArchive 包装 | `$/kode/dbClone/inspectArchive` | db_clone.rs:40-44 | 默认即调（须 kodeCore serverPath） | Rust 失败报错；归档解析无 TS 回退 | kode-db-clone tests + kode-server dispatch | Rust 唯一实现（归档解析腿；面板编排 TS） |
| kbengine.clone.export | playerDataCloneCommands.ts → planCloneExport + writeCloneArchive（Rust）→ executeExportPlan（TS mysql2 行读流） | `$/kode/dbClone/planExport`、`$/kode/dbClone/export` | db_clone.rs:40-44 | 默认即调 | 计划/归档腿 Rust 失败即失败；行读取永远 TS | golden_apply.rs、tests/playerDataCloneMysqlReal.test.ts（可接真实 MySQL） | Rust 唯一实现（计划/归档腿；行执行 TS） |
| kbengine.clone.import | 同上 → planCloneImport（Rust）→ applyImportPlan（TS） | `$/kode/dbClone/planImport` | db_clone.rs:40-44 | 默认即调 | 计划腿 Rust 失败即失败；导入执行 TS | 同上 | Rust 唯一实现（计划腿；导入执行 TS） |
| kbengine.clone.showAudit | databaseWiring.ts TS 审计面板 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.server.start/stop/restart/showLogs/retry | activate/serverControls.ts TS 进程监督 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.logs.showViewer/connect/disconnect/clear/export | extension.ts 日志查看器 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.logs.scanErrors | extension.ts:1191 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.debug.start / attach | serverControls.ts / 调试装配 TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.debug.pyspyDump / pyspyFlamegraph | TS 编排外部 pyspy | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.remoteServers.select/add/remove/refresh | serverControls.ts | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.debug.attachRemote | serverControls.ts | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.config.showFinal | activate/views.ts:290-320 openFinalConfig → ensureConfigResolved（serverConfigResolve.ts:341） | `$/kode/config/resolve` | config_rpc.rs:264 | 默认即调 | 解析失败降级 null 树（serverConfigMerge.ts:187 两树由 core 解析，core 不可知树为 null），无 TS 重算；TS 仅渲染 | configParity golden、config_derive_units.rs | Rust 唯一实现（合并树解析腿） |
| kbengine.lintRules.showReport | lint 报告面板，数据源 TS 诊断聚合 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.debug.updateLaunchJson / resetAttachMode / createConfig / focusTarget / waitAtStartup.on / .off | debug 配置编排 TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.debug.debugpyInject | debugpyInjectCommand.ts:105 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.metrics.showSummary / startCpuProfile / stopCpuProfile / showActiveTasks | activate/monitoring.ts TS 采样 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.monitoring.show | monitoring webview TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.dependency.show | entityDependencyWebView.ts:291 buildDependencyGraphInRust | `$/kode/dependency/graph` | dependency_graph.rs:28 | 默认先调 | null 或异常回落 TS `analyzer.analyze()`（entityDependencyWebView.ts:299-302，dependencyGraphRust.ts:215） | kode-server dispatch + 面板单测 | Rust 优先+TS 回退 |
| kbengine.pythonCallGraph.show | entityDependencyWebView.ts:428 buildPythonCallGraphInRust | `$/kode/python/callgraph` | python_callgraph.rs:33 | 默认先调 | null/异常置 rustUnavailable 出警告条（:445-453），无 TS 调用图回退 | kode-server dispatch + KODE-PERF-004/005 面板测试 | Rust 唯一实现（调用图计算腿；文件收集 TS） |
| kbengine.flow.show | flow 面板 TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.generator.wizard / formWizard / templates + kbengine.entity.new | activate/generators.ts TS 向导 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.project.import/create/createDemoGame/selectActive/doctor | project 编排 TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.profile.health / profile.start | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.python.serviceStatus/selectInterpreter/createVenv/syncExtraPaths/debugpySync/installRuff | activate/generators.ts、utilityCommands.ts TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.python.exportStubs / exportTypeStubs | generators.ts TS stub 生成 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.python.ruffLint | utilityCommands.ts runRuffLintCommand → ruffLint.ts | `$/kode/ruff/lint` | ruff_lint.rs:26 | 默认即调 | Rust 失败报错；Rust 侧 spawn Ruff 外部工具，非 Rust 自实现解析 | kode-server lint_rules.rs、ruff 单测 | Rust 唯一实现（lint 执行腿；Ruff 本体仍外部工具） |
| kbengine.python.showCallChain | TS 调用链（perfCallChainDoc 面） | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.clientSdk.generate | sdk-gen/clientSdkGenerator.ts generateClientSdkEntities → generateClientSdkInRust | `$/kode/sdk/generate` | client_sdk/mod.rs:36 | 默认先调 | null 回退 generateClientSdkEntitiesFallback；写入预检与输出编排仍 TS | kode-server dispatch + SDK 单测 | Rust 优先+TS 回退 |
| kbengine.def.analyze | defAnalysisWiring.ts:23 → analyzeDefDocumentInRust | `$/kode/lint/analyzeDef` | lint/mod.rs:210 | 默认先调 | Rust 不可用回退 TS 分析 | kode-server lint_rules.rs、def 分析单测 | Rust 优先+TS 回退 |
| kbengine.symbolReferences.show | TS 引用面板 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.runtimeQuery.show | TS telnet 查询面板 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.liveObservation.openExceptionSource | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.spaces.query | TS telnet | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.compatibility.check | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.workbench.show | TS webview | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.snippets.generateFromSelection | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.telnet.showPanel / disconnect | telnetService.ts TS（:294 的 `$/kode/config/resolve` 仅为注释非调用） | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.bots.add / bots.count | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.playerData.refresh / testConnection / queryByDbid（+未列入 contributes 的 kbengine.playerData.previewRedisKeyspace） | activate/serverControls.ts（:183 区域） | `$/kode/config/resolve`、`$/kode/config/derive`（实体表/键位派生腿） | config_rpc.rs:24/264 | 默认即调 | 派生腿失败降级，无 TS 重算；MySQL/Redis 行查询执行仍 TS | config golden + playerData 面单测 | Rust 唯一实现（配置派生腿；查询执行 TS） |
| kbengine.httpRequests.run / httpRequest.run | TS HTTP | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.hotReload.tempEdit.run / showLog / toggle / showBatchSummary / retryFailed / showRevisionEvidence / filterByState / showFileState / configureChannel / switchChannel / confirmDefBaseline（11 条） | hotReloadStatus.ts:170-171、hotReloadChannelConfig.ts:493、activate/hotReload.ts TS 热更管线 | —（fileChangeBypass.ts:58 定义 `$/kode/fileChanged` 旁路，registerRustFileChangeConsumer :220-237 无生产注册，extension.ts:1350 仅作扩展 API 暴露） | — | 旁路默认关闭 | 热更文件变化默认不达 Rust | 热更单测（TS 侧） | 未迁移 |
| kbengine.core.showShadowDiffLog | kodeCoreGateWiring.ts:58，展示 ShadowDiffLog 环形缓冲（kodeCoreGate.ts compare 面） | （消费 shadow 比较产物） | — | shadow 面专用命令 | — | gate shadow 单测 | 仅 shadow（只呈现 shadow 对拍记录，不改变用户结果） |
| kbengine.discovery.report | activate/utilityCommands.ts:284 → runWorkspaceDiscovery（workspaceDiscovery.ts:546）→ preheatDiscoveryScanInRust | `$/kode/workspace/scanAnchors` | workspace_discovery.rs:9 | 默认先调，5000ms 超时 | 失败/响应形状不合规静默回退 TS（workspaceDiscovery.ts:318-336） | 六棵 golden 对拍、回退、失效单测 | Rust 优先+TS 回退（仅深扫描预热腿；cachedScan/交互 TS） |
| kbengine.extension.identity / diagnostics.exportReproSummary | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.quickActions.show/scanScripts/runDefault/runByName | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.jsoncAssociation.off | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.source.reveal | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.build.previewTask | extension.ts:844 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.tests.list | extension.ts:875 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.messagetable.preview / export | extension.ts:986/:1010 → buildEntityMessageTableShared（messageTableEntity.ts）→ buildMessageTableInRust | `$/kode/messageTable/build` | message_table/mod.rs:36 | 默认先调 | null 回退 TS `buildMessageTable` | kode-server dispatch 13 例 + TS 兜底对拍 | Rust 优先+TS 回退 |
| kbengine.infer.run / managedDir.syncExclusions | inferPipeline.ts:488/:495 | — | — | 不涉 Rust | — | — | 未迁移 |
| kbengine.git.showHistory/showRangeHistory/historyNextPage/openVersionDiff/openVersionContent/openRangeHistoryDiff（6 条） | TS `git log -L` 编排 | — | — | 不涉 Rust | — | — | 未迁移 |

### B. 语言服务 provider 面（27 行 = languageServices.ts 27 处注册）

| 能力 | TS 入口(file:fn) | Rust RPC | Rust 位置 | 门禁/默认 | 失败/回退 | 测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| .def 补全 | languageServices.ts:105 | — | — | 不涉 Rust | — | — | 未迁移 |
| .def 签名帮助 | languageServices.ts:151 | — | — | 不涉 Rust | — | — | 未迁移 |
| .def 悬停 | languageServices.ts:182 → languageProviders/hover.ts:130 KBEngineHoverProvider、provideHoverTimed:209 | — | — | 不涉 Rust | — | hover 单测 | 已切换（2026-11-08 复核：另一会话编辑落定为 04a3fada「feat: serve hover from rust with ts fallback」——服务轨道下语料文档（.def+三类 XML）hover 先走 Rust `textDocument/hover`（serveHoverFromRust，kodeCoreShadowFaces.ts:259；镜像未保存缓冲区后请求），miss/失败/非语料重入 TS 既有链；Python 文档零请求直通 TS。本表其余「未迁移」判词以此为准更新） |
| server 配置悬停（kbengine*.xml） | languageServices.ts:216 | — | — | 不涉 Rust | — | — | 未迁移 |
| 启动脚本悬停 | languageServices.ts:226 | — | — | 不涉 Rust | — | — | 未迁移 |
| 启动脚本补全 | languageServices.ts:231 | — | — | 不涉 Rust | — | — | 未迁移 |
| .def 定义跳转 | languageServices.ts:240 → navigation.ts:18-26 provideDefinition：先返回 TS 位置，另发 shadowCompareDefinition（kodeCoreShadowFaces.ts:168-190，fire-and-forget 不改返回值） | `$/kode/lint/analyzeDef`（经 shadow 面） | lint/mod.rs:210 | shadow 观察专用 | shadow 失败静默，用户结果恒 TS | shadow gate 单测 | 仅 shadow |
| Python 定义跳转（类索引） | languageServices.ts:302 → pythonClassIndex TS | — | — | 不涉 Rust | — | — | 未迁移 |
| rpc CodeLens | languageServices.ts:428 | — | — | 不涉 Rust | — | — | 未迁移 |
| callchain CodeLens | languageServices.ts:435 | — | — | 不涉 Rust | — | — | 未迁移 |
| property CodeLens | languageServices.ts:453 | — | — | 不涉 Rust | — | — | 未迁移 |
| event CodeLens | languageServices.ts:467 | — | — | 不涉 Rust | — | — | 未迁移 |
| typesXml CodeLens | languageServices.ts:508 | — | — | 不涉 Rust | — | — | 未迁移 |
| generatedSource CodeLens | languageServices.ts:532 | — | — | 不涉 Rust | — | — | 未迁移 |
| typeData InlayHints | languageServices.ts:542 | — | — | 不涉 Rust | — | — | 未迁移 |
| builtin type InlayHints | languageServices.ts:552 | — | — | 不涉 Rust | — | — | 未迁移 |
| def 参数 InlayHints | languageServices.ts:562 | — | — | 不涉 Rust | — | — | 未迁移 |
| def 属性 InlayHints | languageServices.ts:572 | — | — | 不涉 Rust | — | — | 未迁移 |
| callHierarchy | languageServices.ts:578 | — | — | 不涉 Rust | — | — | 未迁移 |
| .def 引用 | languageServices.ts:590 | — | — | 不涉 Rust | — | — | 未迁移 |
| Python 引用 | languageServices.ts:597 | — | — | 不涉 Rust | — | — | 未迁移 |
| typesXml 引用 | languageServices.ts:604 | — | — | 不涉 Rust | — | — | 未迁移 |
| documentSymbol | languageServices.ts:611 | — | — | 不涉 Rust | — | — | 未迁移 |
| workspaceSymbol | languageServices.ts:618 | — | — | 不涉 Rust | — | — | 未迁移 |
| implementations | languageServices.ts:624 | — | — | 不涉 Rust | — | — | 未迁移 |
| rename | languageServices.ts:632 | — | — | 不涉 Rust | — | — | 未迁移 |
| Python 补全 | languageServices.ts:641 | — | — | 不涉 Rust | — | — | 未迁移 |

### C. 诊断面（13 个 createDiagnosticCollection）

| 能力 | TS 入口(file:fn) | Rust RPC | Rust 位置 | 门禁/默认 | 失败/回退 | 测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kbengine 主诊断（.def 实时校验） | diagnostics.ts:367 + validation.ts:13-41 validateDocument（parseDefAst + validateScalarTagValues + validateDefStructure TS 主路）；:37 shadowObserveDefDocument 仅观察；observeRustDefFindings:72-107 仅 gate 模式≠ts 才并入，而 servingMode 只可能 'shadow'/'ts' → 合并分支不可达 | shadow 面间接 | — | shadow 观察专用 | 用户结果恒 TS | validation 单测 + shadow 单测 | 仅 shadow |
| kbengine-def-analysis（批量 def 分析） | defAnalysisWiring.ts:20-23 | `$/kode/lint/analyzeDef` | lint/mod.rs:210 | Rust 优先 | 回退 TS 分析 | kode-server lint_rules.rs | Rust 优先+TS 回退（与 kbengine.def.analyze 同链路的诊断产物面） |
| kbengine-config-contract（配置契约） | diagnostics.ts:385 | — | — | 不涉 Rust | — | — | 未迁移 |
| defMethodConsistency（def 方法一致性） | diagnostics.ts:526 | — | — | 不涉 Rust | — | — | 未迁移 |
| userTypeContract | diagnostics.ts:627 | — | — | 不涉 Rust | — | — | 未迁移 |
| propertyDirection | diagnostics.ts:704 | — | — | 不涉 Rust | — | — | 未迁移 |
| readOnlyWrite | diagnostics.ts:778 | — | — | 不涉 Rust | — | — | 未迁移 |
| roleMisuse | diagnostics.ts:832 | — | — | 不涉 Rust | — | — | 未迁移 |
| postDestroy | diagnostics.ts:886 | — | — | 不涉 Rust | — | — | 未迁移 |
| processTopology（进程拓扑） | diagnostics.ts:946，schedule :1055-1119，:1088 validateProcessTopologyInRust | `$/kode/processTopology/validate` | process_topology.rs:35 | 默认即调 | `if (!result) return []` 静默空诊断，无 TS 重算（不可观测） | process_topology_units.rs + 调度单测 | Rust 唯一实现（失败降级空诊断） |
| kode-ruff | utilityCommands.ts:567，经 ruffLint.ts 命令触发 | `$/kode/ruff/lint` | ruff_lint.rs:26 | 命令触发即调 | Rust 失败报错，无 TS 解析回退 | ruff/lint_rules.rs | Rust 唯一实现（仅命令路径；无自动触发面） |
| kbengine-trap-lints | trapDiagnosticsWiring.ts:149（rg `$/kode|InRust` 零命中） | — | — | 不涉 Rust | — | — | 未迁移 |
| hotReload tempEdit 诊断 | activate/hotReload.ts:568 | — | — | 不涉 Rust | — | — | 未迁移 |

### D. 后台 / 调度 / webview 面

| 能力 | TS 入口(file:fn) | Rust RPC | Rust 位置 | 门禁/默认 | 失败/回退 | 测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IndexScheduler（索引调度） | activate/coreServices.ts TS | — | — | 不涉 Rust | — | — | 未迁移 |
| diagnosticScheduler | TS（诊断调度，锚点见 perfCallChainDoc §7） | — | — | 不涉 Rust | — | — | 未迁移 |
| database schema 派生缓存填充（warmup/refresh 异步腿） | databaseSchema.ts:582-588 `(await buildDatabaseTablesInRust(...)) ?? deriveDatabaseTables(...)` | `$/kode/databaseSchema/build` | database_schema.rs:31 | 默认先调 | Rust 不可用回退 TS 派生；同步冷路径 :425 恒 TS | kode-server dispatch + 双路径对拍单测 | Rust 优先+TS 回退 |
| Python 方法符号提取（后台索引） | entityMappingHelpers.ts:355 collectPythonMethods → buildPythonSymbolsInRust | `$/kode/python/symbols` | python_callgraph.rs:34 | 默认先调 | 回退 TS parsePythonMethodBlocks；文件读取仍 TS | kode-server dispatch + 回退单测 | Rust 优先+TS 回退 |
| Python 类索引 / MRO / 组合根 | pythonClassIndex.ts（TS 解析 + worker） | — | — | 不涉 Rust | — | — | 未迁移 |
| 工作区发现预热（激活期） | workspaceDiscovery.ts:318-336 preheatDiscoveryScanInRust（runWorkspaceDiscovery :546 调用） | `$/kode/workspace/scanAnchors` | workspace_discovery.rs:9 | 默认先调，5000ms 超时 | 失败静默回退 TS cachedScan | golden 对拍单测 | Rust 优先+TS 回退（仅预热腿） |
| 激活期配置解析预热 | activate/infrastructure.ts:90-120 ensureConfigResolved 预取 | `$/kode/config/resolve` | config_rpc.rs:264 | 默认即调 | 失败降级 null 树，无 TS 重算 | configParity golden | Rust 唯一实现（解析腿） |
| config derive（配置派生） | configDerive.ts | `$/kode/config/derive` | config_rpc.rs:24 | 默认即调 | 失败降级，无 TS 重算 | config_derive_units.rs、configParity golden | Rust 唯一实现（派生腿） |
| shadow 语料镜像（.def/entities.xml/types.xml/alias.xml） | kodeCoreShadowFaces.ts:198 shadowMirrorCorpusDocument（gate mirrorDocument kodeCoreGate.ts:428-457） | 镜像通道 | — | shadow 面专用 | 静默 | shadow 单测 | 仅 shadow |
| 文件监视器（finalConfigWatcher / watchPythonIndex / def 变更） | activate/views.ts、languageServices.ts TS watcher | — | — | 不涉 Rust | — | — | 未迁移 |
| 热更管线（tempEdit/批次/频道/基线） | activate/hotReload.ts TS | —（`$/kode/fileChanged` 旁路无生产注册） | — | 旁路默认关闭 | — | 热更单测 | 未迁移 |
| 日志尾随（consoleLogTail / logs viewer） | TS | — | — | 不涉 Rust | — | — | 未迁移 |
| 指标采样（metrics CPU profile / active tasks） | activate/monitoring.ts TS | — | — | 不涉 Rust | — | — | 未迁移 |
| 进程监督（kode-server 进程 start/stop/restart、kodeCore serverPath 生命周期） | serverControls.ts / kodeCoreGateWiring.ts TS 编排（kodeCoreGate.ts:333 runInRust 按 RPC 起停 kode-server，属通道非业务迁移） | —（通道本身） | — | 通道供上表各 RPC 使用 | gate 返回 {ok:false,reason} | gate 单测 | 未迁移（通道 TS 管理；仅作为 RPC 载体） |
| webview 面板族（monitoring/workbench/telnet/logs/playerData/cloneAudit/lintRules/databasePreview/runtimeQuery/spaces/flow/bots/http/infer/quickActions/discovery 渲染） | 各 webview TS 渲染与编排（dependency/callgraph 两面板的图计算腿已计于命令面，不重复计数） | — | — | 不涉 Rust（除上述两面板） | — | — | 未迁移 |
| def 文档快照解析缓存 | languageProviders/shared.ts parseDefAst → getOrParseDocumentSync（TS parseDefDocument + worker） | — | — | 不涉 Rust | — | — | 未迁移 |
| WorkspaceIndex 8s 宽限 / 后台预热（backgroundWarmup） | activate/languageServices.ts、coreServices.ts TS | — | — | 不涉 Rust | — | — | 未迁移 |

### E. Rust RPC 注册面与 TS 消费面（含死 RPC 暴露）

`crates/kode-server/src/**` `reg.register` 全量 22 项：config/resolve、config/derive、processTopology/validate、lint/analyzeDef、python/callgraph、python/symbols、sdk/generate、dependency/graph、databaseSchema/build、messageTable/build、ruff/lint、workspace/scanAnchors、dbClone/inspectArchive、dbClone/planExport、dbClone/export、dbClone/planImport、dbClone/readArchiveRows、apiDocs/lookup、wire/encode、wire/decode、def/md5、echo。前 17 项的 TS 消费方见 A–D 表；以下 5 项无生产 TS 消费链：

| 能力 | TS 入口(file:fn) | Rust RPC | Rust 位置 | 门禁/默认 | 失败/回退 | 测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| API 文档查询 | pythonApiHoverDocs.ts 用同源生成的 TS `API_DOC_ENTRIES`（语料生成级锁一致 C-21）；MCP explain 直调 `api_docs_lookup` 库函数（非 VS Code RPC） | `$/kode/apiDocs/lookup` | api_docs.rs | 无 VS Code RPC 消费者 | RPC 面 null/失败时调用方回退 TS | Rust 侧单测 + tests/apiDocsRustParity.test.ts | **对拍锁定，判定不切**（2026-11-08 证据批：全语料成员 × 域面 × en/zh-cn 逐条一致——hit 字段级、ambiguous 三元组序列、miss 三态；热进程时延实测 p50=1.28ms/max=1.79ms（n=40）；断连面=现产 hover 链纯内存零 RPC 依赖，无门无二进制不降级。不切理由：语料双实现已由生成器 --check 门禁锁零漂移，切换不消灭第二实现（回退面必须保留），hover 热路径换 RPC 无净收益；RPC 与 MCP explain 保持同源同语义。附带修复：api_docs.rs `source_refs` 缺 serde rename「sourceRefs」致 RPC/库输出 sourceRefs 恒空——已补 rename，对拍测试捕获） |
| wire 编码 | 无 VS Code 消费者：kode-mcp/src/kb.rs 直接复用 Rust 编解码库（非经 RPC） | `$/kode/wire/encode` | wire_codec/rpc.rs:13 | 无消费者 | — | kode-server wire 测试 | 未迁移（Rust RPC registered but no TS consumer found；死 RPC） |
| wire 解码 | 同上 | `$/kode/wire/decode` | wire_codec/rpc.rs:14 | 无消费者 | — | 同上 | 未迁移（Rust RPC registered but no TS consumer found；死 RPC） |
| DEF 引擎摘要 md5 | TS 包装存在但生产调用为零：defMd5Rust.ts:51 computeDefMd5InRust 仅 wt/qs、wt/i18n-manifest 测试引用；hotReloadDefHash.ts negotiateEngineDigest 零调用（todo RUST-MIGRATION-AUDIT-003 已登记） | `$/kode/def/md5` | def_md5/mod.rs:1161 | 无生产消费者 | — | kode-server def_md5 测试 | 未迁移（Rust RPC registered but no TS consumer found；包装器≠接线） |
| echo | 仅 RPC 基础测试入口 | `$/kode/echo` | rpc.rs:62 | — | — | rpc 测试 | 未迁移（测试入口，不当作用户功能） |

### 未核实清单

1. **hover 面最终形态**：✅ 已复核（2026-11-08）。该会话编辑落定为 04a3fada：服务轨道（serveFromRust，kodeCoreGate.ts:314 `mode==='rust' && serverPath!==''`）下语料 hover Rust 优先、TS 兜底重入；「serveFromRust 恒 false」的旧判词作废。语料面切换证据见 tests/kodeHoverServing.test.ts；Python API 文档面（lookupApiDoc）的切换判定见 E 表 apiDocs/lookup 行。
2. **诊断收集族的自动触发面**：13 个 collection 的触发时机（保存/编辑/命令）本批只逐一核实了 collection 创建点与 Rust 触点，未逐一核实每个 collection 的调度入口；若某 TS collection 内部间接调用了上表 Rust 腿（如 def-analysis 产物），归类不变（其消费面已单列）。
3. **kbengine.workbench.show 下游数据源**：面板本身 TS 已核实，但其内部数据请求是否间接经过 Rust 依赖图/调用图缓存未再向下追；需要证据：对 workbench webview 的消息处理函数逐个追调用链。
4. **行为对拍/契约一致性**：本矩阵全部为静态接线证据。凡标 `Rust 优先+TS 回退` 的行，两条路径的输出是否一致、回退是否无感，本批未验证；需要证据：双路径对拍测试或真实环境验收（第四批 scanAnchors 已有六棵 golden 对拍属个例）。
5. **dbClone/readArchiveRows 的直接消费方**：✅ 已核实（2026-11-09）。生产消费链 = `src/playerDataCloneCommands.ts:787`（`handleCloneImport` 的导入预演路径，非仅包装器）：`readCloneArchiveRows(path, deps.getKeyRoot())`（Rust RPC `$/kode/dbClone/readArchiveRows`，`src/playerDataCloneRust.ts:70`）→ 三态（no-gate/error/ok）分别提示或继续 → `rowsByTable = new Map(rowsCall.result.tables.map(t => [t.name, t.rows]))` → `uniqueValuesFromRows(rowsByTable, columnOrder, uniqueKeys)` → `probeExistingValues(connection, candidates)` → pass-2 `planCloneImport` 冲突预演。故该 RPC 是**导入预演的归档行读取腿**（唯一值候选源），非死 RPC，也不与 inspectArchive 同链路（inspectArchive 是归档元数据/清单面，readArchiveRows 是行数据面）。

### 结论

本矩阵在静态接线层面覆盖了当前树全部 133 条命令（132 contributes + 1 未列入）、27 个语言服务 provider 注册、13 个诊断 collection、后台/调度/webview 面及 22 个 Rust RPC 注册项。它**能够**确立的事实是：默认门禁下用户入口真正走到 Rust 的能力清单——10 条命令的特定腿为 Rust 唯一实现（clone 计划/归档、config.showFinal、ruffLint、callgraph 面板、playerData 派生腿），6 条命令与 3 条后台腿为 Rust 优先+TS 回退（dependency、clientSdk、def.analyze、messagetable.preview/export、discovery 预热、databaseSchema warmup、python symbols），1 条命令 + 实时 def 诊断 + 语料镜像为仅 shadow，5 个 Rust RPC 为死 RPC（apiDocs/lookup、wire/encode、wire/decode、def/md5、echo），其余绝大多数入口（116 条命令、26 个 provider、9 个诊断 collection）仍为 TS 执行。

它**不能**确立的事实是：以上"Rust 唯一实现/Rust 优先"行的 Rust 与 TS 路径行为一致（无对拍证据的行仅证明调用接线）；`serveFromRust()` 恒 false（kodeCoreGate.ts:302-304）且 `servingMode` 无 'rust' 值的现状没有改变，本矩阵不构成翻转总 serving 门禁的依据；死 RPC 的存在说明"新增 Rust 能力"不等于"用户侧已迁移"，迁移验收必须逐入口给出接线 + 对拍 + 回退三面证据。
