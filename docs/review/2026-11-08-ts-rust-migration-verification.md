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
