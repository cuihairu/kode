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
