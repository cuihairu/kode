# Rust Core 收编范围评审

- 日期：2026-10-27
- 评审对象：`/home/cui/.hermes/cache/scratch/tasks/rust-scope-review.md` 第五节结论
- 对照材料：[R1 数据审计](2026-10-27-r1-migration-data-audit.md)、[Rust Core 提案](2026-10-23-rust-core-lsp-proposal.md)、当前 `src/` 与 Rust crates 实现
- 评审基线：评审时工作区 HEAD `cd70e12`

## 总评

赞同 R1 为 `.def`/`types.xml` 解析与实体索引放行 R2；反对把 R2.5 作为无需逐项决策的“顺车包”。R2.5 模块调用频率和输入边界不同：有的只由批命令调用，有的被 hover、CodeLens 或虚拟文档直接调用；它们依赖的数据也不都在 R2 索引中。

R1 的大幅收益来自 XML 解析器的纯进程对照。报告明确指出跨进程 IPC/序列化成本、扩展宿主 RSS 和现场端到端数据尚未测量（R1 §5）。因此这些数字足以支持继续对拍 R2 原型，但不足以证明整个派生计算层迁到 Rust 后仍能保有相同收益。

## 逐节结论

| 分析结论 | 判断 | 依据与修正 |
| --- | --- | --- |
| 一、已定案 | **需修正** | 9.3×–33.8× 内存差距、巨型 def 14.6× 解析差距支持 R2；将其称为“唯一数量级收益”应限定为**当前已测量的 XML 解析面**。R1 的内存数字未含真实扩展宿主 RSS 或 IPC（R1 §2、§5）。暂不迁移交互 provider 与 UI 合理，但不能据此推断所有派生计算都不值得量测。 |
| 二、R2.5 顺车收编 | **反对整包收编** | 各模块入口、频率和输入不同。现有 `SymbolIndex` 提供符号查询、依赖反查和实体 Parent 链，不等于提供每项派生功能的完整语义输入（`crates/kode-index/src/index.rs`）。“边际成本趋零”没有当前实现或含 IPC 的测量支持。 |
| 三、Python R2b 观望 | **赞同观望，需改触发条件** | S4 的 147 ms 是 20 个样本中的尾部值。每次计时同时包含 `onDocumentChanged` 和 `resolveClassBase`，不能归因于 Python 解析（`tests/perf/baseline.bench.ts`）。当前已有大文件 worker 解析路径（`src/pythonParserWorkerHost.ts`）；应先拆出解析、索引提交、MRO 重建和查询耗时。 |
| 四、反例 | **大体赞同，措辞收窄** | 指纹有 TS 侧修法；`databaseDrift` 的真实查询依赖 MySQL。但漂移命令也先构造 schema 快照，不能把整个功能的成本都归到 MySQL IO（`src/extension.ts`、`src/databaseSchema.ts`）。`.pyi`、inlay 和 hover 的展示与 VS Code 接线留在 TS 有依据；“永远留 TS”超出当前数据能支持的范围。 |
| 五、终态 | **反对** | R1/R2 对拍不能推出“解析、索引、派生计算全在 Rust”。仓库已有 `kode-server` 和 Rust shadow 接线，但 `rust` serving 模式仍受 gate 拒绝，TS 仍是服务实现（`crates/README.md`、`src/kodeCoreGate.ts`）。提案中的 R3 状态应拆分记录“骨架已存在”和“能力接入/正式切流未完成”。 |

## R2.5 模块边界核对

| 模块 | 当前调用路径 | 输入是否在 R2 索引 | 评审结论 |
| --- | --- | --- | --- |
| `defAnalyzer` | 整仓分析由 `kbengine.def.analyze` 命令触发；读取 VS Code 文档缓冲区，并为每个文件收集继承声明（`src/extension.ts`、`src/defAnalyzer.ts`）。 | **不完整**。需要当前文档内容、节点与位置、继承声明闭包；R2 索引的符号视图不能直接替代。 | 可作独立批处理候选；需先定未保存缓冲区同步和诊断位置对拍口径。 |
| `messageTable` | 当前 `src/` 没有产品调用点，调用只见于测试。 | **否**。依赖 def 树装配顺序、types.xml、`aliasIdEnabled` 和消息编号规则；`MethodDef` 等解析模型只保留部分字段。 | 先确认产品入口和需求，再单独决定是否迁移。 |
| `kbengineProtocol` | 由运行期命令查询空间、watcher 或 profile 数据（`src/extension.ts`、`src/kbengineProtocol.ts`）。 | **否**。输入来自在线组件、socket 帧和运行期回包，与 def 语料无关。 | 从 R2.5 移除；它与 `messageTable` 不是同一类“网络”计算。 |
| `databaseSchema` | 用于数据库字段 hover、types.xml hover/CodeLens、schema 虚拟文档和数据库命令（`src/languageProviders.ts`、`src/databaseSchema.ts`）。 | **否**。除 def/XML 外，还依赖当前文档、项目布局、entities.xml 域位、脚本文件存在性、数据库配置和表名前缀。 | 先分出纯 schema 推导与交互查询，测含 IPC 的 hover/CodeLens 延迟，再决定迁移范围。 |
| `databaseSimulator` | 虚拟文档展示模拟行数据；模拟本身消费 schema 快照（`src/databaseSimulator.ts`）。 | **否**。除 schema 输入外，还有模拟行状态和用户增删改操作。 | 若考虑迁移，应把纯行模拟与 VS Code 文档提供器分开评估。 |
| `defChain` | Parent hover 直接调用 `buildDefChain`（`src/languageProviders.ts`）。 | **部分**。Rust 已有实体 Parent 链；TS 结果还含接口、组件、缺失文件标记及环截断信息（`src/defChain.ts`、`crates/kode-index/src/index.rs`）。 | 属于交互路径，不应按低优先级批预计算包处理；可先做窄范围语义对拍。 |

## Python R2b 评审

观望结论成立，但应依据分层数据，而不是把一次 S4 尾部值当作解析器证据：

- S4 测量含文档编辑更新和后续查询；20 个样本中 P50 为 0.35 ms、P95 为 1.59 ms、P99/max 为 147.13 ms（`docs/perf/baseline-run-post-p0.txt`）。该样本规模不足以稳定估计 P99。
- 目前大文件解析可走 worker thread（阈值 256 KiB），所以 Python 源码解析和索引维护应分别计时。
- 先拆出 worker 解析、索引提交、MRO 重建和最终查询，增加重复运行及真实编辑器样本。只有当解析成本被证实为主要、用户可感知瓶颈后，再做 Rust Python 解析原型及同语料对照。
- “Python 不值得”目前是范围判断，不是 Rust 与 TS 的实测结论；R1 §5 已对此作出说明。

## 补充候选项

以下模块可能复用 `.def` 解析与索引，但调用路径或输入不同，建议作为单独候选调查，不自动并入 R2.5：

- `defReferenceGraph` / Project Doctor：按命令构造跨文件声明、引用和连接图（`src/defReferenceGraph.ts`）。
- `entityDependency`：整仓依赖扫描和图构建，当前通过依赖面板触发（`src/entityDependency.ts`、`src/entityDependencyWebView.ts`）。
- `compositionRoots`：输入包含 entities.xml、def、types.xml 和 Python 类/实例赋值；被 Python 导航路径消费，因此须评估 Python 状态与交互延迟（`src/compositionRoots.ts`、`src/pythonClassIndex.ts`）。
- `entityFlowGraph`：由实体语义、hasCell 状态派生流程图，并供面板渲染（`src/entityFlowGraph.ts`、`src/entityFlowWebView.ts`）。
- `databaseSchema` 的类型存储反查索引：被 types.xml hover/CodeLens 消费；目前从实体 schema 快照构建，且有独立缓存失效口径（`src/databaseSchema.ts`、`src/languageProviders.ts`）。

## 修正建议

1. 把 R2.5 改为逐模块决策表；每项记录调用入口、输入所有者、未保存文档语义、输出契约和含 IPC 的端到端耗时。
2. 明确 Rust parser、`SymbolIndex` 已暴露查询、TS 文档缓冲区和 VS Code 配置之间的边界。“解析过同一份 XML”不表示索引已经具备派生计算所需的全部数据。
3. 对 schema hover、types.xml CodeLens、Parent hover 先做端到端对照，覆盖 IPC 成本、缓存命中和取消行为。
4. Python R2b 以分层 profile 和可重复样本作为触发闸门；解析未被证明是主要成本前，不扩张 Rust Python 范围。
5. 修订 R3 状态描述：分别记录 Rust server 骨架、已接入能力、shadow 覆盖、serving gate 和正式切流，避免把骨架存在等同于迁移完成。
