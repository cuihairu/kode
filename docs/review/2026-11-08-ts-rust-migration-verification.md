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
