# Kode TODO（细粒度账本，2026-10-22 重拆）

<!--
本账本保留未完成任务及完成索引；较长的历史证据存档于 docs/review/2026-11-08-todo-completed-history.md。
历史勾账与设计出处见 git log 与 docs/review/（含 2026-10-22 统一语义索引重构计划）。
拆分原则: 单项 ≤ 半天可落、可独立验收、带证据口径。
-->

> **2026-10-24 用户令**: kode-v02 此后只在 `main` 开发，phase2 已合并（`377950f`，`--no-ff` 保留合并记录），不再开长期 feature 分支。

## v0.2.1 — Player Data Clone（2026-11-05 用户提供 ChatGPT 计划书，docs/design/v0.2.1-player-data-clone-plan.md）

> 计划书自身的开发顺序铁律：先做 Phase 0（核实 KBEngine 真实 parentID 关联/嵌套 ARRAY 主键/Account-Avatar 引用结构），不直接写 ExportExecutor。
- [x] CLONE-P0 · P0 · 核实 kode 类型图推导与 KBEngine 真实库表映射（主表/ARRAY/组件/parentID 归属），产出映射证据文档（对照 docs/design/v0.2.1-player-data-clone-plan.md——**完整版已落地**：§9 共 51 条 checkbox 为唯一细粒度任务基线，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0001)
- [x] CLONE-P1 · P1 · 新 crate kode-db-clone：SchemaResolver + RelationGraph + ExportPlanner（计划书 §3/§4）（fa770fe 完成：`crates/kode-db-clone` 自包含 crate（无 kode-server 依赖防循环）——`schema.rs`（CloneSchema/DerivedT… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0002)
- [x] CLONE-P2 · P1 · 只读导出与版本化归档（含 sha256/Schema 指纹/脱敏开关）（§5）（5d2f1d1 完成：`reader.rs` 只读导出——ReadOnlyExecutor 无 DML 方法+validate_readonly 白名单双防线,REPEATABLE READ 一致快照带回退,行/字节/墙钟预算+取消旗标,DFS 父先子后,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0003)
- [x] CLONE-P3 · P1 · ImportPlanner + IDMapper + 冲突预览（Dry Run 先行）（§6/§7）（94d3613 完成：`crates/kode-db-clone` 导入计划期(Prepare,不触库)——`target.rs`（PDC-0301 TargetProfile 仅 local/test+mysql+可写三闸,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0004)
- [x] CLONE-P4 · P1 · 本地事务导入 + KBEngine 原生加载验证（§7/MVP）（1c0c12a 完成：`crates/kode-db-clone/src/apply.rs` Apply/Verify 期(PDC-0401..0408)——`WriteExecutor` 抽象(begin/execute_insert 返回 last-insert-id/query_co… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0005)
- [x] CLONE-P5 · P2 · VSCode 一键导出/导入界面（§9 Phase 5）——7aba984(+6b8d421 惰性装配与命令文档修复):8 条命令(kbengine.clone.configureSource|configureTarget|testSource|testTarget|inspectArchive|export|import|showAudit)+Rus… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0006)
  （用户令 2026-11-06：MySQL 数据面**专用只读界面**——不做通用 MySQL 客户端、查询面零编辑字段、只能查询；写操作仅走计划书 §2 的专门 Import 边界，现有数据库面板保持只读不混入。）
  （只读查询骨架另线落地 39c0af74：Rust `derive_database`（dbmgr/databaseInterfaces/default，custom 非空叶子覆盖 defaults、端口 0/非法→3306、`password_available` 只标记不回传明文，6 单测）+ configDerive `database` 缓存与 `getDerivedDatabaseProfile()` + 只读「玩家数据」面板（kbengine.playerData.refresh/testConnection/queryByDbid：连接档案密码掩码、SELECT 1 连接测试与 dbid 查询经 databaseDrift 只读执行器 READ ONLY+白名单，RSA 密文/未配置如实降级）——与 kbengine.clone.* 导出导入向导共存，查询面/导入面分离即 §2 边界。门禁 cargo 52 套+clippy/fmt 0+tsc/eslint 0+vitest 7/131/8/42 绿。）
- [x] CLONE-P6 · P2 · 性能/安全/兼容/回归测试 + MVP 八条验收（§10）（PDC-0601..0607 全清+0608/0609 追加,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0007)
- [x] CLONE-ATT · P1 · 完整计划书附件——销账：缺件不存在。（2026-11-06 22:1x 核实：用户发来的完整版 422 行一直在此前聊天附件落盘 ~/.hermes/cache/documents/doc_8cb8e5f6626e（当日用户再次原样重发确认 doc_ee0f86d2，逐字节一致）；仓库 docs/design/v0.2.1-player-data-clone-plan.md 即该完整版全文落地（54 条 PDC 全在，含失败注入 PDC-0405/CLI 契约 §8/验收门/DoD 面），差异仅为勾账证据与出处头，无正文缺失；「仅正文摘要落地」系当初登记错误。流程整改已入 fleet-repo-governance：报缺件前必须先查收件缓存与聊天历史）
- [x] CLONE-DOC · P2 · db-clone 权威口径页：能力边界+克隆全链路（中英双语）——回应用户「为啥叫 db-clone？有 clone 玩家数据的功能吗」的口径混乱，一次性写清。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0008)


## P0. 启用插件后卡死：重新打开性能治理（2026-10-26，优先处理）

用户现场反馈：hover loading 约半小时才出现、Python 索引与跳转卡死，禁用插件恢复、启用再次卡顿。**问题未解决，不得沿用此前“性能已验收”的结论。** 当前源码基线 `550d824`；证据与复现范围见 [卡顿分析报告](docs/perf/2026-10-26-stall-analysis.md)。本地探针已确认算法与调度缺陷，但尚未取得用户现场 CPU profile、安装版本及运行日志，不能把“半小时”精确归因到单一函数。以下任务均未完成。

### P0-1 索引维护与扫描范围

- [x] P0-1a 修复 Python 索引平方级维护：`pythonClassIndex.ts:564/645` 的 `updateFile → unindexFile` 每次遍历全部类，首次入库也如此。改为仅删除该文件的旧类记录；验收首次入库不遍历其他文件类，修改/删除不误删跨文件同名类，用操作计数锁定线性增长。本地基线：8,000 个单类小文件产生 31,996,000 次桶遍历，纯内存维护 3,607.42ms（单轮，非现场耗时）。（492fc40;unindexFile 改为只迭代该文件自身类名(fileCache 旧记录,无旧记录早退);tests/pythonIndexMaintenance.test.ts:19 锁定:2,000 类场景 `bucketReads===2,000`(线性,修前为 N(N−1)/2 级)、跨文件同名类存活、删除只清本文件桶。2026-10-27 本仓核验验收全条达成后补勾）
- [x] P0-1b 统一两份 Python 索引的扫描根与排除规则：`entityMapping.ts:1365` 的方法索引漏排 `vcpkg/third_party/out/site-packages` 等目录，与 `PY_SCAN_EXCLUDE` 不一致。验收工作区与外部 assetsRoot 使用一致规则，依赖树文件不被读取/解析，业务脚本仍可导航。（492fc40;方法索引与 PythonClassIndex 共用同一排除集合,workspace+external 同规则;tests/pythonIndexMaintenance.test.ts:115 锁定同排除目录下增量更新不触发全树重走(`directoryReads===0`),依赖树文件不读不解析。2026-10-27 核验补勾）
- [x] P0-1c 方法倒排索引改为单文件增量：`entityMapping.ts:967` 任意 Python change 清空整份索引，下次查询重新全扫。处理修改/新增/删除；验收保存单文件只更新对应方法桶，不触发全树重建，多目标结果保持正确。（492fc40;handlePythonFileChanged 改链 `.then(refreshPythonDefFile)` 单文件刷新,不再清空整份倒排索引;tests/pythonIndexMaintenance.test.ts:19(单文件只动自身方法桶)+:182(首扫中保存先应用再发布,多目标正确)锁定。2026-10-27 核验补勾）
- [x] P0-1d 收敛构建失效与并发：方法索引旧构建失效后仍继续，PythonClassIndex 对未缓存 py 的事件会增加扫描代数。补构建代校验、取消与事件合并；验收连续保存/新建/删除时旧结果不回写，重复全扫和排队任务不持续增长。（492fc40;buildPythonDefIndex 记忆化 promise+失败复位,旧代结果不回写;PythonClassIndex 未缓存 py 事件不再加扫描代数;tests/pythonIndexMaintenance.test.ts:65(新/未缓存 py 不 bump scanGeneration)+:91(取消后请求局部批次停排)+:182(首扫中保存不被旧结果覆盖)锁定。2026-10-27 核验补勾）

### P0-2 前台请求与后台索引解耦

- [x] P0-2a 消除共享调度器队首阻塞（重开 A3-6）：实体首扫整轮占用一个后台任务，`indexScheduler.ts:357` 的 runningId 阻止高优请求执行。首扫拆成有界任务并释放调度席位；验收首扫尚未完成时 RequestLocal 已执行，而非仅验证排队优先级或 setImmediate 让路。（492fc40;首扫拆有界批次任务,批间释放调度席位;tests/entityMappingDeferredStartup.test.ts:150 锁定「后台首扫尚未结束时 RequestLocal 在两个批次之间执行」——门控放行的真执行,非排队优先级断言。2026-10-27 核验补勾）
- [x] P0-2b 移除定向文件加载对全仓 discovery 的等待：`pythonClassIndex.ts:1020` 为候选排序等待整个文件发现。改用已知路径与稳定候选策略；验收 discovery 挂起/慢速时，已知局部依赖仍可解析，并保持跨根同名符号选择语义。（492fc40;定向加载改已知路径+稳定候选,不等全仓 discovery;tests/pythonIndexMaintenance.test.ts:39 锁定「workspace discovery 挂起时显式局部 import 仍解析」,跨根同名符号选择语义由既有导航测试保持。2026-10-27 核验补勾）
- [x] P0-2c 清理交互未命中分支的全量等待（重开 A5-1）：审计 `ensureScanned/ensureCompositionRoots/initialScan`，重点 `pythonClassIndex.ts:1245`、`entityMapping.ts:1116`。前台使用快照与定向依赖，后台补齐；验收冷启动、未知方法、组合根未就绪均无无限等待，同时保留 mixin、多实现与跨根导航语义，不以返回不完整单目标冒充修复。（d4fd634;前台查已发布快照+定向依赖,ensureScanned/ensureCompositionRoots/initialScan 未命中分支不再无限等待(有界预算放行),后台补齐;mixin/多实现/跨根语义保留,非提前返回残缺单目标;tests/entityMappingDeferredStartup.test.ts(冷启动/未就绪分支)+既有导航测试锁定。2026-10-27 核验补勾）

### P0-3 扩展宿主响应与取消

- [x] P0-3a 外部根扫描改异步有界遍历：移除 `scanRoots.ts:192` 递归 `readdirSync`；验收慢目录、只有目录/非 Python 文件的树也能让出事件循环，并支持取消。（492fc40;walkExternalRoot 改 async readdir,每 256 项让出事件循环,入口+每项检查取消 token;readdirSync 递归已移除,目录/非 Python 树同样让路。2026-10-27 核验补勾）
- [x] P0-3b 方法索引移除同步枚举/读取：处理 `entityMapping.ts:1378/1400`，让路不能只在成功读取 Python 文件后检查；验收读取失败、非 Python 树与慢文件不会形成长同步阻塞。（492fc40;performBuildPythonDefIndex 全异步遍历,每 25 文件/16ms 让路,时间让路在目录/文件分支**之前**检查(纯目录或非 Python 树同样让路),读取失败不断链。2026-10-27 核验补勾）
- [x] P0-3c 大文件解析隔离：确认重 CPU 解析路径，将大文件解析放入 worker/server，并明确结果版本与生命周期；验收解析期间扩展宿主仍可处理交互，旧版本结果不覆盖新缓冲区。现有 Rust shadow/保留配置值不算已完成服务切换。（492fc40;大文件解析走真实 worker_threads(pythonParserWorker/Host),非 Rust shadow;revision 透传契约=host 不代吞旧回包,调用方比对丢弃(updateFileResponsive revision 比较);worker 崩溃/退出 failPending+重建;tests/pythonParserWorkerHost.test.ts 8 例锁定(超阈值走线程/旧 revision 上抛/崩溃恢复)。2026-10-27 核验补勾）
- [x] P0-3d 接通请求取消与预算（重开 B-1）：`extension.ts` 的 token 传入 provider、扫描与解析；`hoverBudget.ts` 超时后取消或停止该请求独占的工作，避免误取消共享索引。验收取消/超时后工作量收敛、无重复后台任务堆积；不能仅断言 Promise.race 返回 null。本地反例：10ms 定时预算遇到 150ms 同步阻塞，实际 150.34ms 才返回。（492fc40;token 全链接入 provider/扫描/解析,raceWithBudget 加 CancellationToken+onStop,createLinkedCancellationToken 请求独占 token 预算到期自停、不误取消共享扫描;tests/hoverBudget.test.ts:130 锁定「请求预算取消请求独占后续工作,共享扫描继续」——非仅 Promise.race null;同步阻塞延后定时器现象已固化 tests/perf/timerDelay.bench.ts(见 P0-4a)。2026-10-27 核验补勾）
- [x] P0-3e 修复 MRO 开关启动行为：`extension.ts:525` 在项目门控通过后无条件启动 Python 全扫，与 `enableMroJump=false` 的”不做全仓扫描”说明矛盾。统一配置契约与启动路径，覆盖激活、开关切换；未经验证不得把该开关作为止血方案。（b9c8acb;代码门控 492fc40 已加(激活路径 enableMroJump 分支+配置变更路径),本笔补激活期测试:tests/extension.test.ts「MRO 启动门控」——enableMroJump=false 激活:entity-mapping-scan 已记账(工作区门控放行)而 python-index-scan 保持 null,拨回 true 走配置路径即启动(fileParseCount≥1);prove-red 已做(临时去门控→恰该测试红在 null 断言,已还原)。激活+切换双路径覆盖）

### P0-4 真实环境验收与历史结论纠正

- [x] P0-4a 固化可复跑诊断：将本轮临时探针整理为仓库内复现/回归用例，记录源码版本、输入规模、操作计数与执行命令；覆盖平方级遍历、运行中后台任务挡住交互、同步阻塞导致超时延后。（b9c8acb;三场景固化:①平方级遍历=tests/pythonIndexMaintenance.test.ts:19(门禁,`bucketReads===2,`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0009)
- [x] P0-4b 获取现场基线：记录已安装插件版本、操作系统、工作区/外部资产根、Python 语言服务及设置；采集启用/禁用对照、扩展宿主 CPU profile、event-loop delay、请求端到端耗时、扫描文件数、内存与取消后残留任务，区分 Kode 索引与 Python 语言服务索引。（612c1b2;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0010)
- [x] P0-4c 真实 VS Code 联合验收：Kode 与 Python 语言服务同时启用，覆盖冷启动、大仓依赖树、外部根、未知符号、连续保存、首次跳转、hover 取消及长会话；逐场景记录修复前后 P50/P95/P99/最大耗时、事件循环延迟与资源变化。沿用既定热态 Hover P95 ≤30ms、Definition P95 ≤50ms 目标；冷启动与未命中单独报告，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0011)
- [x] P0-4d 重新审计性能报告与完成标记：保留历史量测事实，纠正“后台不抢主线程”“请求不等全仓”“超时已根治”的泛化结论；补端到端 hover 与长会话证据。P0-4c 现场验收未完成前，本节保持未完成，不以单元测试通过、局部 benchmark 或新增超时关闭问题。（41d4dd8;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0012)

执行顺序：先 P0-1a/1b 与可复跑基线，再处理增量失效、队首阻塞和交互全量等待；随后收口 IO/解析隔离、取消与配置契约，最后完成真实编辑器验收。P0-4b 可提前取证。

## A. 语言服务性能治理（结构重构，源自 docs/review/2026-10-22-unified-semantic-index-refactor.md，PR1→PR7 顺序推进）

### A1 PR1 · 性能观测与基线（不改任何行为结果）
- [x] A1-1 新建 src/languageServiceMetrics.ts：单调时钟(perf_hooks)、请求 ID、11 类事件枚举、详细记录默认关闭(kbengine.metrics.detailed)（89e8783；src/languageServiceMetrics.ts:9-23、:110、:121）
- [x] A1-2 记录字段齐备：总耗时+子阶段、发现/读取/解析计数、缓存命中率、是否等初始化、generation、文档 version、状态 ok/miss/cancelled/error（89e8783；src/languageServiceMetrics.ts:26-52、docs/perf/2026-baseline.md §6）
- [x] A1-3 汇总出口：请求数/P50/P95/P99/最大值/命中率，命令面板 KBEngine: Show Language Service Metrics Summary（89e8783；package.json:365、src/extension.ts:1266-1269、getLanguageServiceSummaryReport）
- [x] A1-4 埋点接线：hover/definition×2/completion×2/诊断×2 走 extension.ts 适配层，索引侧 semantic-query/type-registry-query/python-index-scan/python-composition-roots/file-discovery/document-parse（89e8783；src/extension.ts:266,279,372,405,437,463,628、languageProviders.ts:3414、definitionWorkspace.ts:311、pythonClassIndex.ts:569,685,894、scanRoots.ts:227、documentStore.ts:211）
- [x] A1-5 测试资产集生成器：small/large 30000/multi-root 三根含同名实体 Avatar 与同名类 Inventory/big-py/def-heavy/noise 六件套，确定性可复现（89e8783；scripts/generate-perf-assets.mjs:8-13）
- [x] A1-6 基线报告：环境+资产集+七场景实测数字+待测项如实标注（89e8783；docs/perf/2026-baseline.md §1-§5、原始输出 baseline-run.txt）
- [x] A1-7 四条调用链 Mermaid 图落同报告，等待点虚线标注 A-F（hover 2.5s 预算闸/definition 首扫 5s 闸+组合根 joinWait+pass2 全量/completion 无显式闸/diagnostics 排队合并）；四块均经 mermaid.parse 验证为 flowchart-v2（2e9bdc7；docs/perf/2026-baseline.md §7.1-§7.4）

### A2 PR2 · 文档快照与解析缓存（documentStore）
- [x] A2-1 新建 src/documentStore.ts：URI 规范化+版本号+文本+行索引+解析态+最近成功解析版本（7d8736b；src/documentStore.ts:24-40、:102-110）
- [x] A2-2 内存优先规则：打开文档以 VS Code 缓冲区为准，磁盘旧内容不得覆盖编辑中内容（7d8736b；tests/documentStore.test.ts:21、:150 锁定）
- [x] A2-3 同版本只解析一次；解析中再编辑→旧结果不覆盖新版本（7d8736b；tests/documentStore.test.ts:211 并发用例、:188 parseSlot 命名空间化）
- [x] A2-4 Hover 接入：provideHover 行数据走 getDocumentLines 快照，废逐次 getText().split 全文拆行（7d8736b；src/languageProviders.ts:573、文档同批 hover 行准备 P50 1.66ms→<0.01ms）
- [x] A2-5 Diagnostics 接入：parseDefAst 走 documentStore 'def-ast' 命名空间版本化缓存，标量+结构共用同份结果（7d8736b；src/languageProviders.ts:2074-2082、文档同批 def-ast 同版本命中率 96.1%）
- [x] A2-6 快照释放策略：关闭文档后行索引/解析缓存整体释放，不泄漏（7d8736b；tests/documentStore.test.ts:292、:305 同键不同拼写释放同一份）

### A3 PR3 · 统一索引调度（indexScheduler）
- [x] A3-1 新建 src/indexScheduler.ts：任务生命周期（queued/running/completed/failed/cancelled）+状态查询（2aca694；src/indexScheduler.ts:59、:129、:103）
- [x] A3-2 任务合并：同文件同版本去重（低优先级让位高优先级），过期任务取消丢弃（2aca694；src/indexScheduler.ts:178、tests/indexScheduler.test.ts 合并用例）
- [x] A3-3 优先级队列：当前文件轻量解析 > 请求所需局部索引 > 依赖更新 > 后台全量 > 非交互分析，顺序断言（2aca694；IndexTaskPriority、isInteractivePriority:42）
- [x] A3-4 失败恢复：首扫被杀后再次请求可重新入队并完成，不永久 pending（2aca694；tests/indexScheduler.test.ts:252-262 杀掉首轮扫描模拟、:97 recoveries 计数）
- [x] A3-5 EntityMappingManager 首扫迁入调度器：initialScan 走 scheduler，行为等价（2aca694；src/entityMapping.ts:186-199 scheduler 注入、entity-mapping-scan 打点）
- [x] A3-6 **2026-10-26 重开，见 P0-2a/P0-3**：历史提交 2aca694 实现优先队列与冷却窗口，但运行中的整轮首扫仍阻塞交互任务，同步扫描仍占用宿主；“后台让路、不抢主线程”尚未成立（原证据：docs/perf/2026-pr3-indexscheduler.md）。（271327c 重验收关闭;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0013)

### A4 PR4 · 统一语义查询（semanticIndex + dependencyGraph）
- [x] A4-1 新建 src/semanticIndex.ts：实体-分面方法/属性-Python类-注册关系-类型映射-根作用域 统一承载（查询 API 不暴露内部遍历）
- [x] A4-2 新建 src/dependencyGraph.ts：entities.xml/def/types.xml/alias.xml/Python 声明 的真实依赖失效（禁「任何变更=全仓重建」，测试单文件变更失效范围）
- [x] A4-3 类型注册表迁移：resolveEntityAnnotationType 改查快照（废除逐次 statSync 指纹，保留更新事件驱动重建，definitionWorkspace.ts:308/320/345）
- [x] A4-4 实体映射查询迁移：getMappingForPythonFile 系改走 semanticIndex（旧 API 行为兼容层，原测试全过）
- [x] A4-5 多资产根模型：规范化根路径+rootID+文件映射+查找顺序显式策略（禁 Map 插入序依赖；同名实体/类冲突测试）
- [x] A4-6 现有查找顺序取证：从测试提取当前命中顺序→固化为显式策略文档+测试（不改行为先锁）

### A5 PR5 · Python Definition 去全仓阻塞
- [x] A5-1 **2026-10-26 重开，见 P0-2b/2c**：d4fd634 已实现快照与定向加载，但 staging 仍等待全仓发现，未命中分支仍等待全量扫描；需覆盖全部交互等待路径后重新验收。（271327c 重验收关闭;重开两因=①staging 等全仓 discovery→P0-2b 492fc40 定向加载改已知路径+稳定候选,tests/pythonIndexMaintenance.test.ts:39 锁定 discovery 挂起时局部 import 仍解析②未命中分支等全量→P0-2c d4fd634 ensureScanned/ensureCompositionRoots/initialScan 有界预算放行,tests/entityMappingDeferredStartup.test.ts 锁定冷启动/未就绪分支;现场复核=未命中 hover/def P95 4.43/13.54ms(廉价,未等全量),冷首查 1189ms 有界非无限等待;口径按 P0-4d:服务层不等全量收尾成立,冷窗结果到达≈首扫时长如实单列,不以「不等」泛化）
- [x] A5-2 组合根构建缓存：同批 XML/def 只读一次，mtime+size 指纹重派生零重读（d4fd634；src/pythonClassIndex.ts:685-700 python-composition-roots 打点；docs/perf/2026-final-report.md 验收#6）
- [x] A5-3 PythonClassIndex 版本与失效：类/基类/方法/MRO/组合根显式版本+依赖图裁断失效，比较走稳定 classKey 非对象引用（d4fd634；SemanticDependencyGraph 接入、fullRebuild 恒 false；docs/perf/2026-pr5-unblocked-definition.md §4）
- [x] A5-4 删除/重命名/基类变更后旧索引项移除，跳转不到已不存在位置（d4fd634；tests/pythonIndexPr5.test.ts:203-244；docs/perf/2026-final-report.md 场景6 旧项 0 命中）
- [x] A5-5 冷启动 Definition 特定命中路径耗时入报告：107,737ms → 468.69ms（PR7 复测 475.34ms）（d4fd634；docs/perf/2026-pr5-unblocked-definition.md §2 U1、docs/perf/2026-final-report.md §3 场景1）。**2026-10-26 纠正口径：仅保留该场景量测，不代表所有跳转不等全仓；未命中与慢发现待 P0-2/P0-4 验收。**

### A6 PR6 · 诊断与一致性收口
- [x] A6-1 诊断任务版本化：连续编辑合并过期任务，只发布匹配当前版本结果（测试）
- [x] A6-2 轻量本地诊断与索引语义诊断分层；无关文件变更不重算全部打开文档（指标断言）
- [x] A6-3 entities.xml 诊断入口同版本失效约束
- [x] A6-4 配置切换（诊断开关）正确清理/重算（测试）
- [x] A6-5 同名符号跨根稳定性测试集补齐

### A7 PR7 · 复测回归与交付
- [x] A7-1 同环境同资产复测，七场景 vs PR1 基线逐项对比，无可复现数据不进报告（e6e8bc7；docs/perf/2026-final-report.md §1-§3、原始输出 final-run.txt / final-unblocked-run.txt / final-pr2-run.txt）
- [x] A7-2 验收表逐项标 通过/未通过/未测量：通过 6 / 未通过 0 / 未测量 2（Hover、Completion 端到端 P95 未量测，如实标）（e6e8bc7；docs/perf/2026-final-report.md §4）
- [x] A7-3 新架构图+索引数据模型/作用域/失效/调度说明（e6e8bc7；docs/architecture/semantic-index.md）
- [x] A7-4 未解决问题清单与下一轮建议：5 项未解决 + 6 项下一轮建议（e6e8bc7；docs/perf/2026-final-report.md §5-§6）

## B. 在途/止血项（结构性治理并行的即时修复，落地即勾）
- [x] B-1 **2026-10-26 重开，见 P0-3/P0-4**：用户仍报 hover loading 约半小时。历史 9c8daf7 修正路径大小写并添加 2.5s race/5s 首扫预算，1501-def 测试曾得冷 12–14ms/热 8–10ms；这些局部结果不能证明整体根治。同步阻塞会推迟定时器，超时也未取消底层工作，需真实编辑器重新验收。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0014)
- [x] B-2 函数着色 白→浅蓝：variable.function.call.python=#8BD5FF（11 主题），before/after scope 实证（179a290@分支；探针实测 get_color 白→#8BD5FF、关键字/def 不吃）
- [x] B-3 RPC 形参 inlay：调用点 `形参名: 类型`（kbengine.inlayHints.typeData 开关；fa13ef9 已在 main；+6 测试）
- [x] B-3a 形态收敛（2026-10-29 用户定）：调用点实参 inlay 只显 `: 类型`,不再带合成形参名 argN——.def `<Arg>` 无名可考,名字留在签名帮助/存根面,与定义点 defParams inlay 同风格（819aa34;src/typeInlayHints.ts 标签 `arg${index+1}: ${annotation}` 改 `: ${annotation}`+模块头/方法注释口径改写;tests/typeInlayHints.test.ts 三例断言 arg1: int→: int(单参/双参逐位/错位只出首参),prove-red 先红三例;docs features.md/zh+guide features/configuration 四处同步 argN: type→: type;门禁 eslint 0/tsc 0/unit 4062|7(368 文件)/xvfb demo 25 RC=0）
- [x] B-3b 属性 inlay 解析到底（2026-10-29 用户定口径）:`self.<属性>` 访问处不再显声明原词,与 RPC 实参 inlay 同一 resolveEntityAnnotationType 链解析到底——SERVER_ID(types.xml 别名)→int、VECTOR3→Tuple[float,float,float];… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0015)
- [x] B-6 def 文件着色：types 注入语法双宿主（2026-10-29 用户令：def 内建/ARRAY/FIXED_DICT/自定义类型特殊颜色）——package.json injectTo 扩 `["text.xml","source.kbengine-def"]`,注入语法 injectionSelector 扩双选择器 `L:text.xml - (comment,`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0016)
- [x] B-7 None 守卫快速修复（2026-10-29 用户点火开工）:receiver-none 诊断处出 CodeAction「插入 None 守卫」——receiverNoneDiagnostics 检测面已有(computeReceiverNoneFindings),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0017)
- [x] B-4 调用链图形化双 Tab：Graph(默认,esbuild 打包 mermaid@12 离线 5MB 入库)+Text 兜底，kbengine.python.callChainView，渲染失败回落（d5cff3d；16 例测试；CSP 零 CDN）
- [x] B-5 分支成果收敛 main：179a290/9c8daf7/d5cff3d 三 commit squash 为 5071dde 已推 main（本地 main 旧指针 27199f8 经 patch-id 证与 origin c057bb3 重复后重置，零内容丢失）

## C. 功能项（拆细推进）
- [x] C-1 G9 Space Viewer/Watcher 面板·第一步：引擎 watcher 协议取证（kbengine 源码树 getWatcher/addWatcher 消息面，file:line 摘录落 docs/design）
  - 证据：新增 docs/design/space-viewer-watcher.md（zh 镜像 docs/zh/design/space-viewer-watcher.md，vitepress 侧栏双语入口已加 docs/.vitepress/config.mts:63/:123）。取证树 = `../kbengine`（与 tests/helpers/engineTree.ts 兜底口径同源）。关键摘录：回执消息号 `CONSOLE_PROFILECB_MSGID=65503`（kbe/tools/server/pycommon/SpaceViews.py:13、Component_Status.py:13、Watcher.py:11 三处一致）；Watcher 请求号 41001-41010 按进程类型分（Watcher.py:32-40）；SpaceViewer 请求号 50001/50002/50003/50004/50005（Component_Status.py:33-34、SpaceViews.py:33-37 与 :142），服务侧实现 cellappmgr.cpp:559 `querySpaces`、cellapp.cpp:2259 `setSpaceViewer`、cellappmgr_interface.h:91/94、cellapp_interface.h:135/165、baseappmgr_interface.h:116；回执流解码顺序（进程头 int32+int64 → 逐 cellapp uint64+uint32 → 逐 Space uint32+string+string+uint32 → 逐 Cell uint32）见 SpaceViews.py:73-113；脚本侧 addWatcher 两形态与 deftype 白名单见 kbe/src/lib/pyscript/pywatcher.cpp:28-137（delWatcher :149-165，模块注册 :184），watcher 定义本体 helper/watcher.h:227/260/294。未取证项如实标注（queryAppsLoads 回执字段、queryWatcher 请求体字段）→ C-3 前补。门禁：docs:build ✓（44.29s）、test:unit 2808 passed | 8 skipped（基线不变）；tsc/oxlint 未涉（纯 docs+config.mts 改动）。
- [x] C-2 G9·第二步：最小查询面板（单 watcher 查询+结果表格，走真实协议，mock 测试）
  - 结果表格：`src/runtimeQueryWebView.ts` 面板 watcher 查询结果从整包 JSON 倾倒改为真 `<table>`（列 Path/Kind/Value，行头 `th scope="row"`，空态文案+`hidden` 切换）；spaces 结果保持 JSON 前置块（有独立命令 `kbengine.spaces.query`）
  - 行投影抽成导出纯函数 `watcherResultRows` / `joinWatcherPath`，口径对引擎 `Watcher.py:73-137`：type 0 叶子段 → 父路径+叶子名按 `Watcher.py:82` fullpath 拼全路径；type≠0 目录段 → `keys` 即子路径；保线序不重排、空输入不造占位行。webview 内联脚本只做渲染，不再自行推导行
  - 走真实协议：面板默认 `defaultRuntimeQueryProtocol`（`queryWatcherPath` 真实 TCP 组帧，msgid 走 `WATCHER_QUERY_MSG_IDS` 表）；mock 测试经注入 seam `RuntimeQueryProtocol`（既有）
  - webview 脚本执行面：按 `tests/entityDependencyPanel.test.ts` 的 runWebviewScript 口径用假 DOM 抽出内联脚本直跑 state 消息——锁表格真渲染出 tbody 行、空态切换、spaces JSON 块（无执行面时投影再对也会静默空表）
  - 顺手修的真 bug：`SpaceQueryResult` 三处 bigint（componentID/snapshot.componentID/cellappID）过 webview 边界即抛 "Do not know how to serialize a BigInt"，整个 state 消息静默废掉——新增 `toSpaceView` 在 postMessage 前转字符串，测试锁 `JSON.stringify(view)` 不抛
  - 测试：`tests/runtimeQueryWebView.test.ts` 5→13 例全绿（joinWatcherPath 口径 / 叶子段 / 目录段 / 多段拼接 / toSpaceView bigint 转换×2 / 表格渲染×2 / 既有 5 例随新消息契约更新）；全量 `Tests 2838 passed | 8 skipped`
- [x] C-3 G9·第三步：面板操作面（增删 watcher、结果订阅流），开关默认关
  - 操作面在 `src/runtimeQueryWebView.ts`：`addWatcher` / `removeWatcher` / `toggleStream` 三条消息命令，观察清单 `watchPaths: string[]` 去重拒绝（`Watcher path already on the list: <path>`）、空路径拒绝（`Enter a watcher path to add.`）；结果订阅流 `setInterval` 自持定时器，`onDidDispose` 先 `stopStream()` 再放行；面板关闭后才 resolve 的轮次直接丢弃，不回灌 state
  - 开关默认关落在三处：`package.json` configuration 新增 `kbengine.runtimeQuery.enabled`（boolean, default `false`）与 `kbengine.runtimeQuery.pollIntervalMs`（number, `minimum: 500`, default `2000`）；`defaultRuntimeQueryOptions` 读这两个键；`toggleStream` 开流前查开关，未开即报 `watchList: Result stream is off by default; enable kbengine.runtimeQuery.enabled.` 且不发任何查询；`pollIntervalMs` 运行时按 `Math.max(500, value)` 下限夹取，误填 50 按 500ms 轮询
  - state 契约新增 `watchPaths` / `streaming` 两键，webview 内联脚本按清单渲染 watch-list（每行带 Remove 按钮）、按流状态切 Stream/Stop 按钮文案；空清单轮次不发请求也不清空表格已有行
  - 测试：`tests/runtimeQueryWebView.test.ts` 13→21 例（新增 6 例命令面 + 1 例配置默认值 + 2 例 webview 脚本面 + 1 例 clamp）——假定时器 `vi.useFakeTimers` + `advanceTimersByTime` 驱动轮次、`configurationOverrides.clear()` 逐例清开关避免跨例串味、假 DOM `runWebviewScript` 抽出内联脚本直跑锁 watch-list 真渲染与 Stream 按钮切换；全量 `Tests 2846 passed | 8 skipped`、`tsc -p ./` 零错误
  - 文档对账：`docs/features.md` / `docs/zh/features.md` Settings 表补 2 行（中英同锁，D-2 口径）；`docs/guide/configuration.md` / `docs/zh/guide/configuration.md` 新增 `Runtime Queries` / `运行时查询` 节（表格 + 五条行为规则 + 边界指向 `docs/design/space-viewer-watcher.md` §8）；观察清单定位为**查询目标登记而非引擎 watcher 增删**已在 design 文档 §5/§7 对账，配置节行为规则不重复造说法
- [x] C-4 T-04 .pyi 抢占实验结论落地：开关建议档已落实验文档「Switch recommendation (awaiting user ratification)」——A `stubExport`(默认 true,KBEngine.pyi 无本地运行时文件,无遮蔽)维持开；B `entityStubMethods`(默认 true,产物名 kbe_types.pyi/entity_types.pyi 不与用户模块同名)维持开+仅落自管根；C 全量 `.py` 同树生成(T-04)维持不做,若做须显式 opt-in 默认关。**三个拍板点(A/B/C 默认不动、stubDir 不指脚本树规则、同名遮蔽永久禁)待用户逐条定**；pyright 1.1.414 单点证据,Pylance/Cursor/PyCharm 未验
- [x] C-5 V-06 版本感知 API·a：引擎版本/源码提交探测模块（src/engineApiMetadata.ts:58 `readEngineApiMetadata` 探测入口；:32 `findEngineRoot` 同源口径取 marker `kbe/src/lib/common/version.h` 的 `#define KBE_VERSION` 宏、git 取 commit/describe；取不到一律 unknown 禁硬造——:51 `UNKNOWN_ENGINE_VALUE='unknown'`、:65/:70 两道守卫、:124 `unknownMetadata` 兜底）
  - 证据：tests/engineApiMetadata.test.ts:55「shows unknown rather than inventing values when source or git is unavailable」常驻门禁；src/engineCompatibility.ts:22 `findEngineRoot(startDirectory, explicitRoot)` 引擎树发现同源；C-8 的 tests/helpers/engineTree.ts 测试侧探测与产品侧同 marker，跳过条件与产品报 unknown 的条件同源
- [x] C-6 V-06·b：API 元数据挂接（src/kbeModuleIndex.ts:480 `appendEngineApiMetadata` 把 `# Engine version:` / `# Source commit:` / `# Source describe:` 三行注释注入 KBEngine.pyi 存根首行之后；src/extension.ts:190 与 :218 两处存根生成路径按开关挂接）
- [x] C-7 V-06·c：配置开关+features 清单行+测试（package.json#configuration `kbengine.python.apiMetadata` 默认 true，src/extension.ts:175 读取并 gate `buildEngineApiCatalog`；features.md 中英 Settings 表行已补 31147ec；测试侧 tests/engineApiMetadata.test.ts:55 unknown 兜底断言 + D-2 锁滚动覆盖其默认值口径）
- [x] C-8 V-07 兼容性测试·a：KBENGINE_ROOT 探测+无树 skipIf（tests/helpers/engineTree.ts；探测口径与产品侧 engineApiMetadata.findEngineRoot 同源——marker `kbe/src/lib/common/version.h`、`KBENGINE_ROOT=off` 显式关、环境变量优先、`../kbengine` 兄弟目录兜底，**测试跳过条件与产品报 unknown 的条件同源**；describeWithEngineTree 无树整套 skip 且原因写进套件标题；fixture+注入 6 例常驻门禁，真树断言挂载点留 C-9）
  - 证据：tests/engineTreeProbe.test.ts 无树 6 passed|1 skipped、有树 fixture 7 passed 双配置实测；skip 行内可见 `↓ ... engine tree sanity (real tree) — skipped: no engine tree: set KBENGINE_ROOT or place kbengine next to the repo (no ../kbengine sibling found)`；全量 test:unit 2805 passed|8 skipped（基线 2799/7，+6）
- [x] C-9 V-07·b：fantasydemo 真实脚本样例批（def 解析/继承/校验行为断言）
  - 证据：新增 tests/fantasydemoDefAnalysis.test.ts 7 例（真脚本根 /home/cui/workspaces/BigWorld/programming/fantasydemo/res，无本机 BigWorld 检出即整组跳过，口径同 tests/fantasydemoRealExport.test.ts:30）：entity_defs 5 个真实 .def 与 entities.xml 注册面双向对账（:59）、五 def 解析不抛 + 三方法节齐全 + Volatile 段（:84）、方法-节归属（:103，Avatar logOff→BaseMethods 且带 `<Exposed/>`、fromCell/cellTick→ClientMethods 且 `<Arg>STRING</Arg>`、Guard 三节全空）、属性面（:122，Avatar 四属性类型/域位/Identifier、Account character→BASE、Space 空 Properties 段零属性）、correctness 类检查零误报（:138，invalid-identifier/duplicate-type-tag/engine-limited-name/missing-type/inherited-name-collision 全零；建议类 3 条如实允许并进 CI 日志）、继承闭包空 + def 链单节点无祖先（:163）、entities.xml 零发现 + 注入重复条目的 offset/length 定位锁（:177）
  - 本批发现并修复：`analyzeEntitiesXml` 原只认平铺格式（`<root><Entity/>`，引擎自带 sdk 模板格式），现行引擎 schema 的分节格式 `<root><ClientServerEntities><Avatar/></ClientServerEntities><ServerOnlyEntities>…` 会整体漏检重复条目——现透明下钻已知分节名一层（src/entitiesXmlAnalysis.ts:40 ENTITIES_XML_SECTIONS、:42 collectEntityEntries、:70 接入查重循环），tests/entitiesXmlAnalysis.test.ts:95/:115/:123 补 3 例（分节内重复、跨分节重复、分节容器本身不计入清单且容器内实体子标签不误报）
  - 未做并另挂账 C-13：`getRegisteredEntities` 仍只走平铺口径，分节格式脚本的实体清单装配缺失；分节→hasBase/hasCell/hasClient 域位映射属引擎 schema 语义决定，本批不擅自发明
- [x] C-10 V-07·c：CI 接线（有树环境真跑，集成 tag）
  - `vitest.integration.config.ts`：集成 tag 用**显式文件清单**（engineTreeProbe / realEngineIntegration / fantasydemoRealExport / fantasydemoDefAnalysis），不用通配——`*Real*` 会误收 tests/realReproCellMethods.test.ts（名字带 Real 的普通单测，不依赖树）；vscode alias 与主门禁同源，`environment: 'node'`
  - `.github/workflows/engine-integration.yml`：只 `workflow_dispatch`（输入 `kbengine_root`，留空则套件按缺席 skip 不红）+ 周一 04:19 UTC 周巡；**不接 push/pull_request**——通用 runner 无树，接了只能全量 skip；`permissions: contents: read`，无任何发包/发 tag 步骤（发版走 ci.yml / publish.yml）
  - `tests/integrationTagWiring.test.ts` 3 例锁三处漂移：① 清单非空、每个文件存在且自带树守卫（缺席必 skip 不红）；② 集成配置与主门禁共用同一 vscode 替身、主门禁仍收全量通配、集成配置不退回全量通配；③ workflow 无 push/pull_request 触发、无 `gh release`/`npm publish`/`vsce publish`/`gh workflow run publish`、含 `contents: read`
  - `tests/engineTreeProbe.test.ts:76` 不变量收窄为「root 为 null 时 reason 必须非空」：`KBENGINE_ROOT` 指向真目录但标记缺席时报的是缺哪个标记（如 `has no kbe/src/lib/common/version.h`），不是笼统 `no engine tree`
  - 双环境真跑验证：无 `KBENGINE_ROOT` → `Test Files 3 passed | 1 skipped (4)`、`Tests 15 passed | 6 skipped (21)`，绿；`KBENGINE_ROOT=/home/cui/workspaces/kbengine` → `Test Files 4 passed (4)`、`Tests 20 passed | 1 skipped (21)`，realEngineIntegration 5 例真跑、fantasydemoRealExport 2 例真跑
  - 过程中证实的产品缺陷另挂账 C-14（探针标记在本机真实树上已失效）
- [x] C-13 V-07·d：entities.xml 分节格式注册面（`getRegisteredEntities` 只认平铺 `<root><Entity hasBase/>`，分节 `<ClientServerEntities>/<ServerOnlyEntities>` 内的条目不进清单；需按引擎 schema 定分节→hasBase/hasCell/hasClient 映射口径后落实现+测试）
  - 取证定论：分节是 **BigWorld** entities.xml 语义而非 KBEngine 引擎 schema——fork 2.5.10 引擎源码 `kbe/src` 全树无分节名（`git grep` 零命中），引擎解析 entities.xml 只走 `XML::getRootNode()` 无参遍历（xml.cpp:56-63），分节容器名会被当实体名去开 `<名>.def` 失败即初始化失败；映射依据 fork 学习笔记 docs/zh/study/05-entitydef-and-entity-definition.md:183-192「分组即最终判定」
  - 映射口径：`ClientServerEntities`→hasClient=true、`ServerOnlyEntities`→hasClient=false（均视为已声明）；`hasBase/hasCell` 分节格式不声明，维持属性缺失=false 不伪造（真实域位由 cell/、base/ 脚本目录判定）；同名重复按文档序保留首条（与 registerNewScriptDefModule 静默合并同口径）
  - 实现：`definitionWorkspace.ts getRegisteredEntities` 平铺+分节双口径（分节下钻一层），分节常量从 `entitiesXmlAnalysis.ts` 导出共用（`ENTITIES_XML_SECTION_CLIENT_SERVER`/`_SERVER_ONLY`），分析器头注释同步取证结论（去掉「现行引擎 schema」误述）
  - 测试：definitionWorkspace.test.ts 分节用例（分节条目进清单/分节隐含 hasClient/ServerOnly 显式 false/重复首条胜/空分节无害）
- [x] C-14 V-06·d：引擎版本探针标记已失效，真实树上恒报 unknown。证据：fork `cuihairu/kbengine` 初始导入提交 `0bc93d5` 的树中即无 `kbe/src/lib/common/version.h`，`git log --all --diff-filter=A -- kbe/src/lib/common/version.h` 全史为空；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0018)
  - 实现：`ENGINE_MARKER_LEGACY`（version.h）| `ENGINE_MARKER_KBEVERSION`（kbeversion.h）双标记探针 `hasEngineTreeMarker`；`readEngineVersionMarker` legacy 单宏正则优先，legacy 缺席/畸形则读三宏合成 `major.minor.patch`，任一宏残缺→null（unknown 兜底，不伪造）
  - 同口径落地三处：`engineApiMetadata.ts findEngineRoot`、`engineCompatibility.ts findEngineRoot/readVersionMacro`、`tests/helpers/engineTree.ts detectEngineTree`（缺标记 reason 点名全部标记）
  - 测试：kbeversion.h-only fixture 合成 2.5.10、PATCH 宏残缺报 unknown、engineTreeProbe/engineCompatibility 各补 fixture 用例；真树 sanity 改为「whichever marker ships → semver 形状」
  - 真树验收：本机 `C:\Users\Administrator\workspaces\kbengine`（2.5.10，仅 kbeversion.h）`KBENGINE_ROOT=... vitest run tests/engineTreeProbe.test.ts` 8/8 全绿；fantasydemo 三套件按设计 skip（资产仅 coding 主机）
- [x] C-11 V-08 边界注记：等真实管理协议（外部条件，触发条件=管理协议可用性，届时重开 C-1/C-2）
  - 注记落 `docs/design/space-viewer-watcher.md` §8「V-08 边界注记：真实管理协议（外部条件）」，中英镜像 `docs/zh/design/space-viewer-watcher.md` 逐字节一致
  - 边界划清：C-1 完成的是**源码取证**、不是**协议可用性**；`41001`–`41008` / `50001`–`50005` / `65502` / `65503` 全是引擎**运行期控制台观测协议**，只对正在运行的 KBEngine 服务端可达，仓库与 CI 不保证有该实例 → 端到端断言进不了门禁；注记明写「不硬造实现」
  - 三条重开触发条件：① 可达实例（已知 `host:intport` 的在跑引擎或容器 fixture，且 `Machines.ComponentInfo` 能读到 cellappmgr 条目）② 消息号表对账通过（这些号是引擎**内部常量、不是公开 ABI**，换引擎版本必须重跑取证核对而非沿用）③ 版本可判定（`src/engineApiMetadata.ts` 报真实版本而非 `unknown`，即 C-14 落地）
  - 已留好的钩子（现状即可用，注记注明文件行号）：`src/kbengineProtocol.ts:54-58` 消息号常量表、`:80-89` `WATCHER_QUERY_MSG_IDS`（按引擎进程类型映射 8 个 watcher 请求号，与 `Watcher.py:33-40` 逐条对应）、`:283` `buildFrame` 集中组帧（连接层可 mock，业务解码按 §4 字段顺序逐字段断言）
  - 顺手勘误（C-1 取证最初误记）：watcher 线回执是 **65502** 不是 65503——引擎真值 `console_helper.h:11` `CONSOLE_WATCHERCB_MSGID=65502` / `:12` `CONSOLE_PROFILECB_MSGID=65503` / `:175` watcher 处理器强制 `msgID`，`Watcher.py:10` 定义 65502 且 `:60` 注册 65502；SpaceViewer/负载线才是 65503（`SpaceViews.py:56`/`:128`/`:186`、`Component_Status.py:42`）。watcher 请求族范围是 `41001`–`41008`（8 个进程类型，`Watcher.py:33-40`）不是 `41001`–`41010`。根因：`Watcher.py` 同文件里两个常量都定义了（`:10`=65502、`:11`=65503），早先取错了一个。**`src/kbengineProtocol.ts:54` 的实现本来就是 65502，代码一直是对的，错的只是文档**
  - 防漂移锁 `tests/watcherBoundaryDocs.test.ts` 8 例：中英镜像逐字节一致 / 文档回执号与 `src` 导出常量互证 / 「两条线共用同一回执号」失实表述不得回潮 / `WATCHER_QUERY_MSG_IDS` 必须覆盖 `41001`–`41008` 整段 8 号 / 边界注记小节与三条触发条件在两份文档齐全 / 注记引用的 `:54-58` `:80-89` `:283` 三个行号锚点仍指向真实内容（行号漂移即视为文档失实）/ 注记不得宣称端到端已接通
- [x] C-12 chatgpt 归并书遗留核对（引用余数=0 且四份原文已随归并完成归档删除，见下方证据）
  - 引用余数核对通过：文件名 `chatgpt-2026-10-20-kode-*`、`log-center`、`background-process`、`chatgpt.*roadmap`、`chatgpt.*typings` 各 pattern 在 docs/src/tests/scripts/package.json 全部 0 命中（排除归并书本体与 docs/.vitepress/dist 构建产物）
  - 遗留项已清（2026-10-24 本批）：四份原文 `chatgpt-2026-10-20-kode-{roadmap,log-center,background-process,typings}.md` （10-21 09:52 落盘，合计 68441 字节，从未有删除提交）已从 docs/review/ 删除——内容此前已被蒸馏为决策注记（各份转录头自述采纳落点：roadmap → todo.md「路线图批次」；typings → 类型系统/typings 批次注记；log-center → todo.md「日志中心战役」；background-process → todo.md「后台运行战役」），原文正文在 git 历史中永久可溯，删除不丢证据。同批另有两份 ChatGPT 转录按归并体例落成 docs/review/2026-10-22-unified-semantic-index-refactor.md 与 docs/review/2026-10-23-rust-core-lsp-proposal.md（各带分享链来源行）。删除前复跑引用余数：五个 pattern 在 docs/src/tests/scripts/package.json 全部 0 命中（排除 docs/.vitepress/dist 构建产物）。

## pyi 存根修复与增强（用户令 2026-10-27）
- [x] pyi 缺 typing import（169dcd3；src/entityTypeStubs.ts 头部固定全量导入 `from typing import Any, Callable, Dict, List, Tuple, TypedDict, Union`——与 kbe_types.pyi 头部同口径,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0019)
- [x] ARRAY of 生成两个同名字段（169dcd3；src/entityTypeStubs.ts buildEntityTypeStubPlan 存根侧折叠——[] 子路径(foo[] 与 foo[].x)一律不落行(只过滤,不改 definitionSemantics/toLegacyMapping 登记面,hover/跳转的 propertyPath 查询链不受影响);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0020)
- [x] 自定义类型裸引用断层：kbe_types.pyi 已生成 TypedDict 但 entity_types.pyi 无 import -> 补 from kbe_types import ...（跨文件可解析验收）（e740d59；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0021)
- [x] 消灭可避免 Any + entity_types.pyi 与脚本类关联（class Avatar(Entity) + mailbox 补全）（1cf55c4+c965b1e；任务2 消灭 Any:①分件单位从源文件改成镜像目录——同目录 types.xml+alias.xml 此前镜像落点相同互相覆盖(谁存活取决于组内首名字典序)且各查各表跨文件引用落 Any,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0022)
- [x] FIXED_DICT 属性面内联 ARRAY<of> 落 List[Any] 收口（2026-10-29 用户报 AVATAR_SHOW_INFO roleInfoList;db64355;根因=definitionWorkspace.parseCustomTypeProperties 只取 <Type> 直文本 typeName 丢弃 <of> 嵌套,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0023)

## debug.json 与后台执行修复（用户令 2026-10-27）
- [x] background=true 仍弹终端根因排查（bc810f6；三线定性:①属实已修——parseQuickAction 此前非布尔 background 静默回落 false，JSON5 习惯写 "background": "true"（字符串）即中招且无迹可查；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0024)
- [x] debug.json 标 jsonc（9fc67ff；文件定性 JSONC 非 JSON5——注释合法(stripJsonComments)，单引号/无引号键/尾逗号解析端仍不认，文档写明「关联只改编辑器体验，解析接受面不变」；新增 src/jsoncAssociation.ts：kbengine.jsoncAssociation 默认 true，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0025)
- [x] 调试启动即 attach（0325019；kbengine.debug.autoDebugpy 默认 false 三件套，src/autoDebugpy.ts）(a) kbengine.python.debugpySync 命令：python3→python 回退跑 `import debugpy` 定位系统包，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0026)

## 热更新状态栏反馈（用户令 2026-10-27；源 KODE2 backlog HR-UI-001，docs/kode2/KODE_2_COMPLETE_TODO.md:572）
- [x] 热更新状态栏：文件修改->热更触发->底部状态栏区分状态。当前实现（src/hotReload.ts）成功完全静默只有失败 toast，无状态栏项。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0027)
  - 交付：1e270fe feat: add hot reload status bar item（12 files，+751/-11）。新模块 src/hotReloadStatus.ts（状态机控制器：五态脸面表 `$(eye-closed) 热更: 关`/`$(eye) 就绪`/`$(sync~spin) 发送中`/`$(cloud-upload) 已发送(未确认)`/`$(error) 失败`，右对齐优先级 98；节流渲染=首态即时上屏+窗内后续合并成一次尾沿渲染（默认 200ms，复用注入 timers）；日志走专用 OUTPUT「KBEngine 热更」即时落账不走节流，每行带 `[HH:MM:SS]` time 前缀+触发文件（去抖合并到的全集）+去抖值+结果行；dispose 清节流计时并释放命令/状态栏/通道）；src/hotReload.ts 装配接线（setupHotReload 增可选 status 注入，缺省真 vscode 工厂但节流走真 setTimeout 与测试计时器隔离防污染去抖 pending 计数；apply() 关/globs 空→setWatchOff、建好 watcher→setReady；fire 到点→setSending→动作 resolve→setSentUnverified（无业务回执一律未确认，文案/tooltip 断言禁 成功/Applied 字样）、reject/throw→setFailed 且保留既有 onActionError/showErrorMessage toast 通道；到点未配动作名→setSkippedNoAction 状态回落 Ready 不悬在 Sending；watcher 事件 URI 攒进 pendingTriggers 结账进日志；复合 disposable 折进 context.subscriptions[0] 仍是 1 条，deactivate 连带释放）。点击状态栏项=贡献命令 `kbengine.hotReload.showLog`（package.json contributes+activationEvents，commandPalette `when:false` 藏面板，实配 parity 锁 extension.test.ts「注册面与 package.json 贡献点一致」通过；状态栏登记数 2→3 同测例更新并断言新项优先级 98/命令/默认脸面常显）。
  - 测试：tests/hotReloadStatus.test.ts 15 例——纯函数 formatHotReloadTime 补零 1；控制器级 7（构造即上屏 Watch Off+点击开日志命令、五态文案逐态+未确认态禁称成功/禁 Applied 字样、节流合并（窗内不上屏尾沿一次渲染最终态）、日志行 time 前缀+触发/结果/跳过逐条落账不走节流、同类状态不重复记变更日志、dispose 清计时+三资源释放+无迟到渲染、默认节流 200ms 锁值）；装配级转移表 7（默认关→Watch Off、开→Ready+就绪日志、事件→去抖到点→Sending→无错完成→Sent(未确认)+触发/结果日志全量断言、异步拒绝→Failed+既有错误通道保留、**debounce 期间关开关→Watch Off（去抖取消动作不执行）**、到点未配动作名→回落 Ready 不悬 Sending、deactivate 复合释放 watcher+三资源、缺省构造走真 vscode 工厂（statusBars/channels 登记+对齐/优先级/命令/脸面））。prove-red 六路全过：①fail 不置 Failed→仅 Failed 转移例红 ②节流失效（窗开也即时上屏）→节流+dispose 例红 ③触发日志行剥成裸「触发」→日志行+装配日志例红 ④复合 dispose 漏 status.dispose→deactivate+缺省构造例红 ⑤apply 不置 Watch Off→debounce 期关开关例红 ⑥成功分支 no-op→Sent(未确认)例红；每路只红自己的用例，改完即恢复（diff 复核零差异）。tests/fake-vscode/windowState.ts 把 channels/statusBars 登记表加 export（默认构造断言用，纯增量）。门禁：test:unit 3165 passed|7 skipped（基线 3150/7，+15 全为本批）；xvfb-run test:demo:editor RC=0。文档对账：docs/guide/commands.md+zh 各加 `kbengine.hotReload.showLog` 小节（诚实口径/节流豁免/when:false 藏面板写明）；docs/features.md+zh 热更状态栏功能条目（证据指针）；README.md+README.zh.md 热更新支持节补状态栏 bullet。未删用例未松断言。

## D. 维护与质量
- [x] D-1 每日 CI 日巡异常闭环：cron e4bddc0a5a17 **已不在调度器**（CronList 空、无 .claude/scheduled_tasks.json —— 会话级 cron 不跨会话持久，首跑复核无对象，如实记录）；异常侧已闭环：最近唯一失败为 nightly workflow_dispatch 2026-10-23T07:21Z，根因 npm registry TLS handshake EOF（pnpm install 取 vsce-sign/levn 抖动，非代码），下一轮 schedule 2026-10-23T10:58Z 成功自愈，无需动作。**待用户定夺**：是否重建为 durable 日巡（durable 会话常驻任务须用户明确同意，不自建）
- [x] D-2 docsCommands 测试口径随新配置键滚动补齐（tests/docsCommands.test.ts 新增「features.md Settings 表与 package.json 对账」三例：① package.json 每条贡献键都见于 features.md Settings 表（**中英同锁**，防只补一边）② 反向：除运行时键白名单 `kbengine.managedDir` 外不得记载未贡献的键 ③ 标量（字符串/数字/布尔）默认值逐键与 `JSON.stringify` 口径核对，数组/对象只查行不比内容——`callChainView`/`typeData`/`asyncBudgetMs`/`apiMetadata` 等键由此锁自动滚动覆盖，不再逐键补断言）
  - 证据：2a32be3 test: lock features settings table against drift；该锁落地即揪出中英漂移各一处（EN 缺 5 键 hover.asyncBudgetMs/webviewConsoleLogs/python.apiMetadata/python.callChainHints/python.callChainView、zh 缺 `kbengine.python.builtinTypeInlayHints`），已一并补齐 31147ec；test:unit 2808 passed|8 skipped（基线 2799/7，+6 为 C-8 探测用例、+3 为本锁）
- [x] D-3 发布铁律季度复核：**查出回潮并已拆**——ci.yml 原有两条绕过版本闸的自动发布腿：① `on: release: created` → `pnpm run publish`（发 GitHub Release 即自动上 Marketplace）；② 任何手动 `workflow_dispatch` 跑 CI/CD 即裸发 Marketplace（无版本一致性校验）。两条均拆除，Marketplace 发布唯一正道=publish.yml workflow_dispatch（含 package.json version 逐字一致性闸 + 全量测试 + lint）；tag push 建 GitHub Release 腿保留（用户手动推 tag 即版本决定，且不触 Marketplace）（e38bdf9；.github/workflows/ci.yml:on 与 build steps）
- [x] D-4 功能清单 features.md 随 B/C 项落地同步（EN+zh 各补 2 条功能条目：**悬停 def 方法 / 接收者调用 / 内建属性标注（Python）**——B-1 三条异步标注面，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0028)
  - 证据：31147ec docs: sync features settings table and add feature entries（2 files，15 insertions，EN+zh 功能条目与设置行同批对齐）；每条带 package.json#contributes|configuration 与 src 文件指针，mermaid 渲染四链已过 parse 校验（docs/perf/2026-baseline.md §7）；D-2 锁同批落地防回潮 2a32be3

<!--
完成口径示例: [x] A2-4 Hover 接入快照（1a2b3c4；test:unit 2690/2sk；src/documentStore.ts:42、languageProviders.ts:582）
-->

#### 提案挂账：Rust Core 常驻语言服务（2026-10-23 外部提案整理）

来源与全文见 `docs/review/2026-10-23-rust-core-lsp-proposal.md`（含与 PR1-7 实况的对照表）。口径：**不插队**——PR7 复测收官后按跟踪清单 R1（数据审计）→R2（原型对拍）过闸再议 R3；终端/脚本启动慢按 R4 独立立项。已代决：采纳「先数据后迁移」的闸门顺序，拒绝直接开写 Rust。
- [x] R1 数据审计（来源=用户 2026-10-27 令,迁移解除排队并入本轮）：用 PR1-7 实测指标定位 TS 残余成本 top3,产出「迁移值得/不值得」结论;结论必须直接指向 P0-1a(平方级维护)与 P0-3c(大文件解析)——回答这两个面上 Rust 能否比 TS 修法拿数量级收益;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0029)
- [x] R2 最小原型对拍（来源=用户 2026-10-27 令,需 R1 过闸后接续）：Rust .def+types.xml 解析器(quick-xml 带位置)+实体索引,与 TS 同语料 diff 一致(位置感知对拍+增量零重建金丝雀);R3 tower-lsp 骨架仅在 R1/R2 双绿后放行（R1 过闸=02f71fe;R2 实体已由 phase2-slice-a 弧线交付,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0030)
- [x] 审核发现：Python 全扫把失败分块的 wait 拒绝逐一吞掉后仍标记该扫描代完成，失败文件永久缺席且后续查询不重试（967084d；src/pythonClassIndex.ts 逐分块收终态(completed/failed),失败分块的文件登记 pendingScanRetries(file→尝试次数),不再吞掉后照旧标记该代完成;后续查询经 ensureScanned 短路分支触发 schedulePendingScanRetry 定向补解析——只重跑待补文件,不全仓重扫;重试有界 MAX_SCAN_RETRY_ATTEMPTS=3,永久不可读文件不无限重试;tests/pythonIndexPr5.test.ts 新增 FailNextChunkScheduler+「分块失败不被吞掉」用例,断言注入失败后全量口径查不到、待补重试后补齐且重试分块不再失败,未删用例未松断言;perf 锚点随行号重校(552/1020/1128),未删断言）
- [x] 审核发现：self 方法解析已命中静态 MRO 时，组合根派生超过 1 秒仍直接返回空列表，丢弃已找到的有效目标（a8dc6cb；src/pythonClassIndex.ts resolveSelfMethodCandidates 的组合根预算 race 超时分支由 `return []` 改为 `return out`——① 静态 MRO 已命中目标照常返回,组合根侧本次不补,下次查询派生就绪后自然补齐;预算经新增可选参数 budgetMs(默认 INTERACTIVE_INDEX_WAIT_MS)注入,两处 raceWithBudget 一致;tests/pythonIndexPr5.test.ts 新增「组合根派生超时」用例:三 glob 挂起逼出超时路径,断言静态 MRO 命中仍返回(修复前该断言失败),未删用例未松断言;perf 锚点重校(1130),未删断言）
- [x] 审核发现：对象级负缓存只凭映射表非空就记录 miss，首扫尚未完成时可把后续分块里的接口或组件类永久误判为不存在（ee3a53b；src/entityMapping.ts 新增 initialScanCompleted 标志——只在首扫成功落地分支置位,对象级负缓存发布闸由 `mappingIndexes.size > 0` 改为 `initialScanCompleted`:首扫进行中(哪怕映射表已并入部分分块)不凭「表非空」记 miss,后续分块里的接口/组件类不再被永久误判;真实扫描失败不置完成位,负缓存不得基于残缺快照发布;tests/entityMappingObjectNegativeCache.test.ts 新增「首扫进行中的接口/组件类 miss 不落死」用例:ChunkGateScheduler 扣住 Hero 分块复现「映射表非空但首扫未完」中间态,断言中间态查 HealthComp 为 null 且未入 missingClassNames,放行后经 ownerName 回溯命中(组件属性以槽名 healthPack 挂在实体索引),未删用例未松断言）
- [x] 审核发现：worker 解析失败与文件读取失败共用 catch，解析线程崩溃时会删除仍存在文件的旧类索引而非保留并重试（cc5147b；src/pythonClassIndex.ts loadFile 拆成两段 try——读失败(文件被删/不可读)保持原撤索引语义,解析失败(内容已读到、文件仍在盘)保留旧类索引并登记 pendingScanRetries 待补重试;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0031)
- [x] 审核发现：调度器将所有已完成、失败及取消任务永久留在 tasks Map，长会话持续保存会累积任务闭包和批量文件路径（d8c3c35；src/indexScheduler.ts pump 终态块与 cancelQueued 各补 `this.tasks.delete(id)`——句柄经 settleListeners/自身闭包保留状态,不依赖 Map,queued/running 查询只看 queueOrder 与 runningId,出表安全;tests/indexScheduler.test.ts 新增「终态任务出表」用例,以运行态快照只读探针断言 completed/failed/cancelled 后 Map 空且计数不回归,未删用例未松断言）
- [x] 审核发现：实体首扫 keyed 任务只启动真实扫描便宣告完成，真实扫描失败又被转成成功的 initialScan；A3-4 的失败重试语义未接到实体扫描（77e9102；src/entityMapping.ts 真实扫描失败不再静默转成功——新增 initialScanFailed/initialScanAttempts 记账,失败分支置失败态而非仅 resolve,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0032)
- [x] CI 红例（用户报 run 40470720225,2026-10-27）：pythonMixinNavigation「keeps sibling mixin candidates separate across packages and respects C3 order」同两候选仅顺序翻(收到 [Alternate(a/other), First(a/root)],… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0033)
- [x] 审核发现：按需加载先按 import 候选顺序截取 64 个缺失路径，导入较多时后面的真实依赖被静默跳过并导致跳转落空（27705df；src/pythonClassIndex.ts stageRequestFiles 拆两口——import 派生候选改为全量补载不再截 64(真实依赖静默跳过即审核原罪,保序去重),同目录兄弟候选保留 64 上限(防大目录全读,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0034)
- [x] 审核发现：PR5 首查测试在异步文件发现尚未入队分块时断言 gatedCount>0，当前连续两次单独运行均失败，未正确锁住“后台推进”行为（1f77df8；tests/pythonIndexPr5.test.ts:325 前加 `await scheduler.chunksEnqueued`——GatedBackgroundScheduler 在首个 full-reindex 分块入队即 resolve，把断言锚在真实入队时点而非首查返回时点；`scheduleBackgroundScan`(:1039) 是 fire-and-forget，分块在发现完成后才入队，原断言抢到发现前面恒为 0。未删用例未松断言，gatedCount/executedFullReindex/噪声零读/单文件计数四条断言原样保留）
- [x] 审核发现：大文件 worker 路径及 worker 崩溃、停用、旧 revision 回包均没有直接测试，现有解析测试只覆盖同步 parsePythonFile（8c105e0；tests/pythonParserWorkerHost.test.ts 新增 8 例直接覆盖(纯测试项,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0035)
- [x] 新任务1（来源=用户 2026-10-27 令,排在审核发现之后实现）：receiver 可能为 None 的诊断告警——self.client/self.cell/self.base 的成员调用/属性访问,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0036)
- [x] 新任务2（来源=用户 2026-10-27 令,排在审核发现之后实现）：def 函数形参 inlay(定义点)——entity 脚本区块(ClientMethods/BaseMethods/CellMethods)内 `def foo(self, a, b):` 每个未手写标注的形参后渲染 `a: <Type>`,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0037)


## IDE 原子任务清单（2026-10-27 架构审计拆分）

来源：[架构/性能/IDE 能力审计](docs/review/2026-10-27-kbengine-ide-architecture-audit.md)、[Rust 收编范围评审](docs/review/2026-10-27-rust-scope-review.md)。基线 `b24925f`，只登记尚需交付的行为；已修复的 Docs CI 死链不重新挂开放任务。

原始拆分：**222 项 / 23 组**，其中 P0 39 项、P1 114 项、P2 69 项；此数字不含后续补项。2026-10-29 复审新增任务与重开原因见文末 `IDE-REV`，完成状态以各项当前复选框为准。

执行约定：

- **一次只执行一个 `IDE-分组-编号` 复选框。** 完成该项并记录证据后再选下一项；不能因同组部分通过就整组打勾。
- 每项只交付所写的一个行为，验收就是勾选条件；若实现时仍需同时改变多个独立行为，先把该项继续拆开，再开始实现。
- 完成后在原行追加 `commit + 文件定位 + 该项验证结果`。业务行为需有对应的反例/正例证据；纯文档项核对事实和链接即可，不用为勾账编造测试。
- `前置` 引用的是必须先完成的细项；没有前置的任务也要遵守优先级。建议首项：`IDE-HOV-001`，随后 `IDE-HOV-002`；`IDE-EVT-001` 也是独立止血项。
- 为解锁 P0，可以先完成它明确引用的 P1 前置；后续 IDE 新能力按依赖推进，不以整组完工作为单次执行目标。
- 旧 `P0-4b/c/d`、`A3-6`、`A5-1`、`B-1` 保留历史与汇总含义；本节细项是后续执行粒度。旧项是否关闭按覆盖范围核对，不因历史勾选推断新反例已经修复。
- `MET/ACC` 细化现场采集与验收，已有并行实现满足条件时补证据，不重写；`HOT` 对应既有 HR backlog 的小切片，不重复计作两次交付。
- 功能扩展在性能与索引基础稳定后推进。Rust R2.5/R2b 各项先形成独立取舍结论；完成“评估”不等于已经完成迁移。

| 旧汇总/审计面 | 本节执行入口 |
| --- | --- |
| PERF-01 / B-1 普通 hover 卡顿 | HOV、BUD |
| PERF-03 / IDX-05 事件索引 | EVT |
| IDX-01..04、06、08、09 | IDX |
| IDX-07 / 多份事实源 | SNP |
| PERF-04 / PERF-05 / PERF-06 | SCH / DIA / RES |
| P0-4b / P0-4c / P0-4d | MET / ACC / RST-001 |
| 原生引用、符号、重命名、调用层次 | NAV |
| IDE 项目、生成、运行、调试、测试 | GEN / PRJ / RUN / DBG / TSK |
| 热更新、观测、数据库、SDK、发布 | HOT / LIV / DB / SDK / REL |
| 模块职责 / Rust 范围 | ARC / RST |

### IDE-HOV · 普通 Python hover 与返回注解索引（P0）

来源：PERF-01；src/pythonReturnTypeInference.ts、src/languageProviders.ts。
- [x] IDE-HOV-001 [P0] 无调用赋值时跳过返回注解索引；验收：悬停普通变量且上方无对应调用赋值时，目录枚举与项目文件读取计数均为 0；前置：无。
- [x] IDE-HOV-002 [P0] 用单次遍历提取文件返回注解；验收：同一文件的方法增多时字符访问次数保持线性；无注解方法不反复扫描全文；前置：无。
- [x] IDE-HOV-003 [P0] 保留多行函数签名的返回注解；验收：多行形参后的 -> 注解仍被提取；截断签名不产生虚构注解；前置：IDE-HOV-002。
- [x] IDE-HOV-004 [P0] 让返回注解索引消费单次提取结果；验收：buildReturnAnnotationIndex 不再逐方法调用全文 extract；既有输出不变；前置：IDE-HOV-002, IDE-HOV-003。
- [x] IDE-HOV-005 [P0] 从构建完成时计算缓存有效期；验收：构建耗时超过 3 秒后，紧邻第二次查询不再次读完整项目；前置：无。
- [x] IDE-HOV-006 [P0] 合并同根进行中的注解构建；验收：两个并发请求共享一次构建；失败后下一次可以重新构建；前置：无。
- [x] IDE-HOV-007 [P0] 将注解文件发现改为异步遍历；验收：慢目录枚举期间事件循环可推进，取消后不进入下一个目录；前置：无。
- [x] IDE-HOV-008 [P0] 为注解源码读取设置并发上限；验收：项目文件异步读取的峰值不超过设定并发数，单文件失败不阻断其他文件；前置：IDE-HOV-007。
- [x] IDE-HOV-009 [P0] 为注解构建增加按字节让路点；验收：单个大文件处理也能让出宿主，不能只在文件之间让路；前置：IDE-HOV-004。;2026-10-28 审核整改补漏:让路点此前只盖磁盘索引构建面(extractFileReturnAnnotationsAsync),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0038)
- [x] IDE-HOV-010 [P0] 让普通 hover 只查询已发布注解快照；验收：冷查询可触发受控后台构建，但返回前不等待全项目发现或读取；前置：IDE-HOV-006, IDE-HOV-008, IDE-HOV-009。 【2026-10-29 复审重开：原实现/测试记录保留，验收尚不完整；待 IDE-REV-010 逐项补齐后重新核验，不能按辅助模块或局部测试直接关闭。】【2026-10-31 复核关闭：前置 IDE-REV-010 已勾齐(bb801b6),重开条件逐项重新核验——让出点=documentAnnotationQueue「大文件提取让出事件循环」、只查已发布快照=pythonReturnTypeInference「首次 hover 同步段零 source()」、版本防旧覆盖=「编辑后立即 hover 零提取+旧版本不覆盖」,三项在当前门禁全绿(test:unit 4910 过),按重开条件核验通过,关闭。】
- [x] IDE-HOV-011 [P0] 按文档版本更新当前文件注解；验收：未保存的返回注解变化立即进入该文件桶，旧版本结果不能覆盖新版本；前置：IDE-HOV-004。（137df41;实现=src/pythonReturnTypeInference.ts 文档注解桶:updateDocumentReturnAnnotations(root,{fileKey,version,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0039)
- [x] IDE-HOV-012 [P0] 保存文件时只替换该文件注解桶；验收：修改一个文件不重读其他文件，删除的返回注解不再可查；前置：IDE-HOV-011。（96e127b;实现=src/pythonReturnTypeInference.ts applySavedFileAnnotations 换桶+mergeAnnotationBuckets 合并,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0040)
- [x] IDE-HOV-013 [P0] 新建文件时新增注解桶；验收：新文件保存后可查询其注解，目录发现不重新全跑；前置：IDE-HOV-012。（e84b7ab;实现=IDE-HOV-012 的 applySavedFileAnnotations 对新键 set 即增桶,零新码;验收锁=tests/pythonReturnTypeInference.test.ts 新文件保存测试(readFile/readdir 均未调用=目录发现不重跑,PAYLOAD 可查);测试绿 3224|7）
- [x] IDE-HOV-014 [P0] 删除文件时移除注解桶；验收：文件删除后该来源的注解消失，其他同名方法来源仍存在；前置：IDE-HOV-012。（cb3f74d;实现=src/pythonReturnTypeInference.ts removeSavedFileAnnotations 弃桶+重合并,extension.ts onDidDeleteFiles 接线(.py 过滤);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0041)
- [x] IDE-HOV-015 [P0] 重命名文件时迁移注解来源；验收：旧 URI 查询落空，新 URI 可查，不留下双份结果；前置：IDE-HOV-013, IDE-HOV-014。（7396cdf;实现=src/pythonReturnTypeInference.ts renameSavedFileAnnotations 旧键原位换新键(保插入序),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0042)
- [x] IDE-HOV-016 [P0] 按当前文件限定返回注解候选；验收：同文件明确声明优先于项目中无关同名方法，不跨作用域借用赋值；前置：IDE-HOV-011。（1d6f54b;同文件优先=IDE-HOV-011 悬停文档桶最优先已覆盖(锁定测试 LOCAL 压 REMOTE);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0043)
- [x] IDE-HOV-017 [P0] 按显式 import 限定返回注解候选；验收：导入绑定只解析到对应模块；同名多个候选无法确定时返回未知；前置：IDE-HOV-016。（d2d9bac;实现=src/pythonReturnTypeInference.ts extractFileImports(from/import-as 绑定,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0044)
- [x] IDE-HOV-018 [P0] 增加返回推导独立开关；验收：关闭后 provider 不启动注解构建；package 配置与中英说明一致；前置：IDE-HOV-010。

### IDE-EVT · 事件 CodeLens 与 WorkspaceIndex（P0）

来源：PERF-03、IDX-05；src/eventApi.ts、src/workspaceIndex.ts。
- [x] IDE-EVT-001 [P0] 无事件语法时提前返回 CodeLens；验收：100 个普通文件的探针返回 0 lens 且不打开其他文档；前置：无。
- [x] IDE-EVT-002 [P0] 共享事件索引首扫 Promise；验收：首扫被扣住时第二个调用者等待同一 Promise，不提前拿到空表；前置：无。
- [x] IDE-EVT-003 [P0] 允许事件索引启动失败后重试；验收：首次 discovery 抛错后，下一次查询能重新完成初始化；前置：IDE-EVT-002。
- [x] IDE-EVT-004 [P0] 用后台文件读取替代全仓 openTextDocument；验收：首次事件索引不触发其他文件的 onDidOpenTextDocument 事件；前置：无。
- [x] IDE-EVT-005 [P0] 限制事件索引首扫并发；验收：大仓索引同时处理文件数有上限，取消后不继续启动下一批；前置：IDE-EVT-004。
- [x] IDE-EVT-006 [P0] 统一事件索引扫描根与排除表；验收：外部 assetsRoot 被收录，venv/site-packages/third_party 等按共用规则排除；前置：IDE-EVT-004。
- [x] IDE-EVT-007 [P0] 用未保存缓冲区刷新事件记录；验收：当前文档新增或移除监听后，查询看到同版本事件，不等磁盘 watcher；前置：IDE-EVT-004。
- [x] IDE-EVT-008 [P0] 处理事件索引构建期间的文件更新；验收：延迟的旧磁盘读不能覆盖较新的编辑结果；前置：IDE-EVT-007。
- [x] IDE-EVT-009 [P0] 删除文件时清除事件反向记录；验收：删除监听文件后监听计数和跳转目标同时消失；前置：IDE-EVT-007。
- [x] IDE-EVT-010 [P0] 重命名文件时更新事件 URI；验收：监听跳转只指向新路径，不保留旧路径；前置：IDE-EVT-009。
- [x] IDE-EVT-011 [P0] 释放事件 provider 的索引和 watcher；验收：provider 销毁后 watcher 为 0，在途读取不得重新发布缓存；前置：IDE-EVT-002。
- [x] IDE-EVT-012 [P0] 让事件 CodeLens 读取共享文件索引；验收：事件记录来源复用统一索引，移除该 provider 的独立全仓扫描入口；前置：IDE-EVT-006, IDE-SNP-001。（74b2d9a;实现=src/eventApi.ts 构造必注入共享 WorkspaceIndex(删 ownIndex 自持回退),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0045)

### IDE-IDX · 根身份、实体归属与增量正确性（P1）

来源：IDX-01..09；src/semanticIndex.ts、src/entityMapping.ts、src/definitionSemantics.ts。
- [x] IDE-IDX-001 [P1] 让语义 loader 按精确 def 路径加载入口；验收：双根同名 Hero 请求 B 时，semantics.owner.filePath 确实为 B；前置：无。（0abfe91;实现=src/definitionSemantics.ts loadResolvedAt(路径分区缓存,与名字缓存互不串扰)+resolveSemanticsFromLocal 拆出共用解析体;entityMapping.buildIndex 精确路径只信扫描根 loader(dirname 兜底保持原静默口径,孤儿 manager 不意外建索引);测试=tests/definitionSemantics.test.ts IDE-IDX-001 两例(双根 owner 落 B/坏路径 null);测试绿 3239|7）
- [x] IDE-IDX-002 [P1] 让 loader 缓存按根和文件身份分区；验收：A/B 同名定义分别命中自己的缓存，切换查询顺序不改变结果；前置：IDE-IDX-001。（781c693;实现=src/definitionSemantics.ts ResolutionContext.originRoot(精确路径入口按 def 所属根定)+loadLocal/resolveDefinitionFile 起点根优先+缓存键@根分区,父/接口/组件递归全透传 originRoot;名字入口(无起点根)保持原首根口径;测试=tests/definitionSemantics.test.ts IDE-IDX-002 两例(同名 Hero 含同名父 Shared 双向换序不串/名字缓存不被路径查询污染);测试绿 3241|7）
- [x] IDE-IDX-003 [P1] 让实体名查询携带调用文档根；验收：A/B 同名实体由调用文件根决定，不能依靠最后注册者覆盖；前置：IDE-IDX-002。（1e88c47;实现=semanticIndex.getEntityDefFilesByName(名字→全部 def 文件,不做单胜负)+entityMapping assets 同根配对(python 截于 /scripts/,def 截于 /entity_defs/ 再剥尾 scripts 段),lookupIndexByClass/ensureIndexTargeted 调用根优先,resolveMethodDefinitionForClass/resolvePropertyDefinitionForClass 增可选 callerFile,languageProviders 四处接线传 document.fileName;测试=tests/entityMappingManager.test.ts IDE-IDX-003 双根类查询(A 根拿 A/B 根拿 B/反向不串根);测试绿 3242|7）
- [x] IDE-IDX-004 [P1] 把 Python owner 反查改为多对多；验收：A/B 共用 Shared.py 时反查返回两个实体并保持稳定顺序；前置：无。
- [x] IDE-IDX-005 [P1] 保存共享脚本时刷新全部依赖实体；验收：修改 Shared.py 后 A/B 的方法行号与绑定均更新，未依赖实体不刷新；前置：IDE-IDX-004。（bad7543;实现=entityMapping.handlePythonFileChanged 撤掉首中即 break,findEntitiesByPythonOwner 反查出的全部依赖实体逐个 force 重解析(共享脚本 owner 归属多实体时不再只翻新第一家);测试=tests/entityMappingManager.test.ts IDE-IDX-005(A/B 同引接口 Shared,Shared.py 垫行+补实现后两实体行号 2→6/onExtra 新增绑定均翻新,C 索引原引用保留且 misses 恰 +2);测试绿 3243|7）
- [x] IDE-IDX-006 [P1] 替换注册前移除旧的 owner 记录；验收：Old.py 改为 New.py 后，Old.py 不再映射到该实体；前置：无。
- [x] IDE-IDX-007 [P1] 删除实体时清理所有反向记录；验收：替换后再删除实体，旧 owner、新 owner、类名和 ownerRef 均查不到它；前置：IDE-IDX-006。
- [x] IDE-IDX-008 [P1] 删除同名胜者后保留其他根实体；验收：移除 B 的 Hero 后 A 的 Hero 仍能按 A 根查询，不被一并删除；前置：IDE-IDX-003, IDE-IDX-007。（86a1780;实现=semanticIndex.removeEntityByDefFile 胜者被摘后从剩余同名条目重选(最后注册者胜,与注册覆盖同口径)+entityMapping.handleDefFileChanged 名字槽由重选胜者接管(mappingIndexes 不再连坐同名另一根);tests/semanticIndex.test.ts 两处旧口径断言同步改锁新契约(basename 回落按策略②命中重选胜者);测试=tests/entityMappingManager.test.ts IDE-IDX-008(删 B def 后 A 根查询/名字槽/语义胜者均指向 A,B 独有方法查 null);测试绿 3244|7）
- [x] IDE-IDX-009 [P1] 保留 POSIX 路径大小写；验收：Linux 的 /project/A 与 /project/a 形成两个独立 root/def 键；前置：无。
- [x] IDE-IDX-010 [P1] 统一 Windows 路径比较规则；验收：同一盘符路径的大小写与斜杠变体合并，跨盘路径仍分离；前置：IDE-IDX-009。
- [x] IDE-IDX-011 [P1] 统一 documentStore 与语义索引路径键；验收：同一 URI 在两层得到一致身份，POSIX 大小写差异不串缓存；前置：IDE-IDX-009, IDE-IDX-010。
- [x] IDE-IDX-012 [P1] 为全部工作区根建立 def watcher；验收：修改第二根的 def 后，实体映射与依赖失效均可观察；前置：无。（9a06dce;实现=entityMapping.watchDefFiles 从只挂首根改为遍历全部 workspaceFolders 建 watcher(与 watchPythonFiles 同口径,外部资产根不变);测试=tests/entityMappingManager.test.ts IDE-IDX-012(双 workspace 根,第二根按 pattern 有独立 def watcher,父 def 变更后自身重解析见新方法/子实体依赖失效按需重建继承新方法,第一根索引原引用不动);测试绿 3245|7）
- [x] IDE-IDX-013 [P1] 为全部工作区根建立类型 watcher；验收：第二根 types.xml/alias.xml 更新后，类型快照失效且下次得到新值；前置：无。（31dcce5;实现=entityMapping.watchTypeRegistryFiles 从只挂首根改为遍历全部 workspaceFolders 建 watcher(外部资产根不变,notify→notifySemanticFilesChanged 精确作废链路原样);测试=tests/entityMappingManager.test.ts IDE-IDX-013(双根,第二根按 pattern 有独立 types watcher,B 根 UINT16→STRING 后快照失效重查得 str,A 根不受影响);测试绿 3246|7）
- [x] IDE-IDX-014 [P1] 切换 assetsRoot 时重建实体 watcher；验收：旧外部根 watcher 被释放，新根更新能触发维护；前置：IDE-IDX-012, IDE-IDX-013。（db603b9;实现=entityMapping 三类 watcher 拆出 attachPythonWatcher/attachTypeRegistryWatcher/attachDefWatcher 单 pattern 挂载+refreshExternalRootWatchers() 外部根三件套整组重建(旧 watcher dispose,新根按当前 getExternalScanRoots 重挂,dispose 面同清)+extension.ts assetsRoot 配置变更分支接线;测试=tests/entityMappingManager.test.ts IDE-IDX-014(extA→extB 切换后旧 watcher fire 不再触达维护/新根三件套挂上且 def 变更建出映射);测试绿 3247|7）
- [x] IDE-IDX-015 [P1] 移除根时摘除该根全部索引记录；验收：工作区移除 B 后 B 的实体、owner 和类型都不可查，A 保留；前置：IDE-IDX-003。（78133ff;实现=entityMapping.removeRoot(该根下全部 def 走 removeIndexByDefFile 统一摘除路径——从 handleDefFileChanged 抽出,名字槽同 IDX-008 接管口径)+semanticIndex.removeRoot(该根类型注册表快照全删+根描述符注销,#分隔键前缀不误伤)+extension.ts onDidChangeWorkspaceFolders removed 接线;测试=tests/entityMappingManager.test.ts IDE-IDX-015(B 实体/owner/类查询/类型快照全断,A 全保留);测试绿 3248|7）
- [x] IDE-IDX-016 [P1] 让旧根在途任务无法回写；验收：扫描 B 未结束时移除 B，晚到结果不能重新登记该根；前置：IDE-IDX-015。（754b5e8;实现=entityMapping.removeRoot 记 removedRootKeys+isUnderRemovedRoot 回写闸,buildIndex 入口对已移除根下 def 早退 null(索引/解析缓存/依赖图/语义投影全部不落);测试=tests/entityMappingManager.test.ts IDE-IDX-016(发现快照含 B+批执行窗口闸门,移除 B 后晚到批不回写 HeroB,A 照常);测试绿 3249|7）
- [x] IDE-IDX-017 [P1] 同文件成员跳转只查当前文件快照；验收：全仓扫描挂起时，同文件 Class.method 仍能跳转且不调用 ensureScanned；前置：无。（878c324;实现=languageProviders member-access ② 块撤掉 findClassesByName(内含 await ensureScanned) 索引中转,直接 parsePythonFile 当前文档找 receiverName 类与同名方法(旧路径答案本就只来自当前文档,索引同文件类必被重解析复核);测试=tests/memberAccessNavigation.test.ts IDE-IDX-017(ensureScanned 拒绝挂起模型下 SameFile.helper 仍跳同文件声明行且 ensureScanned 调用数为 0);测试绿 3250|7）
- [x] IDE-IDX-018 [P1] 区分部分候选与完整候选状态；验收：预算到期只拿到静态目标时，内部结果标记 partial，不发布完整枚举的负缓存；前置：无。(683596c)

### IDE-SNP · 共享快照与派生输入（P1）

来源：架构事实源、IDX-07；src/documentStore.ts、src/definitionSemantics.ts、src/databaseSchema.ts。
- [x] IDE-SNP-001 [P1] 定义共享文件快照读取接口；验收：接口明确 rootId/URI/version/content，打开文档优先且不要求打开其他文档；前置：无。(125bc28;src/sharedFileSnapshot.ts readSharedFileSnapshot→SharedFileSnapshot{rootId,uri,fsPath,version,content,source},打开文档=缓冲区全文+编辑序号且绝不读盘,未打开=utf8 磁盘补载+mtimeMs,无 openTextDocument 依赖面,rootId 默认走 SemanticIndex.resolveRootIdForPath;tests/sharedFileSnapshot.test.ts 6 例含生产默认依赖集成,3258|7)
- [x] IDE-SNP-002 [P1] 让语义 loader 读取共享快照；验收：未保存 def 的属性和方法声明可见，未打开文件仍可从磁盘补载；前置：IDE-SNP-001。(3618551;definitionSemantics loadLocal/loadResolvedAtInternal 两读点改 readSharedFileSnapshot,删 readTextFile+fs 导入;未保存 def 的属性/方法声明经缓冲区可见(三入口 loadLocal/loadResolved/loadResolvedAt),未打开磁盘补载/关闭脏文档恢复磁盘版本/缺失 null 口径不变;loader 生产面全部操作期新建无跨编辑缓存风险;3261|7)
- [x] IDE-SNP-003 [P1] 让数据库 schema 读取共享快照；验收：同一未保存 Persistent/Type 修改在 schema 与 def hover 中一致；前置：IDE-SNP-001。(0551a13;databaseSchema 四读点(def 入口/types.xml 别名/两处继承遍历)改 readSharedFileSnapshot,删 readTextDocument;脏 def 的 Persistent 属性与脏 types.xml 的 ARRAY 别名均进 schema,与 SNP-002 语义 loader 同一快照口径,关闭脏文档两边一致回落磁盘;3263|7)
- [x] IDE-SNP-004 [P1] 让类型注册表接收脏 types.xml 更新；验收：未保存别名修改只使依赖该类型的结果失效；前置：IDE-SNP-001。(695fc59;getTypesXmlSnapshot 读共享快照(脏缓冲优先)+快照记 sourceVersions(打开文档编辑序号),resolveEntityAnnotationType 查询前按「现在打开版本 vs 构建记录版本」双向判定过期(打开且前进/构建时打开现关闭都重建),未打开文件仍走 watcher 事件不逐次 stat;脏别名进注册表/关闭恢复磁盘/他根快照对象原样保留三例锁;3266|7)
- [x] IDE-SNP-005 [P1] 关闭脏文档后恢复磁盘版本；验收：丢弃未保存修改并关闭后，下一次查询不再使用脏快照；前置：IDE-SNP-002, IDE-SNP-003。(6196f61;行为本体由 SNP-002/003/004 各面交付(共享快照活询 textDocuments,关闭即回落磁盘),本批补跨面一致锁:tests/snapshotCloseRestore.test.ts 同一流程脏窗口(def+types.xml 双开)三面(loader/schema/注册表)读脏→丢弃关闭三面齐回磁盘;documentStore 关闭即释放(updateDocumentSnapshot→releaseDocument 计数回基线,生产 onDidClose→releaseDocument 接线);红证=回滚 89bfcc7 前源码脏窗口段即红;3268|7)
- [x] IDE-SNP-006 [P1] 为派生结果记录输入版本清单；验收：结果能列出所消费文件版本，任一依赖变更后可判定过期；前置：IDE-SNP-001。(81e79c7;DatabaseSchemaSnapshot 增 inputVersions(fsPath→{source,version}),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0046)
- [x] IDE-SNP-007 [P1] 给 XML 解析缓存增加字节预算；验收：超预算旧条目被淘汰，单份巨型文档不能让 8 条目缓存无限保留；前置：无。(7a6e800;defParser parsedDocumentCache 字节预算 8MiB(utf8 计),不变式=条目≤8 且总字节≤预算,双条件越线都按 usedAtMs LRU 淘汰;单份巨型文档自身超预算保留为独占一条(不无限占住 8 槽,后续条目把它挤掉,退化为逐次重解析);测试面 set/clear + 观测面 getParsedDocumentCacheStats;tests/defParserByteBudget.test.ts 4 例(超预算淘汰/LRU 顺序/巨型独占/条目上限 8 保持);红证=缺 exports+预算放大断言必红;3275|7)
- [x] IDE-SNP-008 [P1] 让共享文件事件按 URI 合并；验收：同一保存产生重复通知时，每个消费索引只应用一次对应版本更新；前置：IDE-SNP-001。(a1eb3ad;src/sharedFileEvents.ts 每消费索引一个合并器实例:createSharedFileEventMerger(窗口 30ms),语义=首报即达(同步投递,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0047)
- [x] IDE-SNP-009 [P1] 增加统一移除根通知；验收：各消费索引收到同一根移除事件，不依靠各自 TTL 自愈；前置：IDE-IDX-015。(fb7dc50;src/rootRemovalEvents.ts createRootRemovalNotifier:一次 emit 同步广播当前全部订阅者(与 SNP-008 文件合并器不同,根移除是粗粒度终态,不做窗口/去重,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0048)
- [x] IDE-SNP-010 [P1] 将根配置 generation 纳入快照身份；验收：assetsRoot 或运行域配置改变后，旧输入结果不得被误复用；前置：IDE-SNP-006, IDE-SNP-009。(3532a3c;src/rootConfigGeneration.ts 全局单调 generation(get/bump(原因)/测试 reset);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0049)

### IDE-BUD · 交互请求预算与取消（P0）

来源：PERF-02、IDX-06；src/extension.ts、src/hoverBudget.ts、src/languageProviders.ts。
- [x] IDE-BUD-001 [P0] 统一 hover 请求的截止时间上下文；验收：所有 hover 分支收到同一 deadline/token；同步路径不得因此被宣称已可抢占；前置：无。(542527c;hoverBudget 增 HoverRequestDeadline+createHoverRequestDeadline(parentToken,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0050)
- [x] IDE-BUD-002 [P0] 让 hover 取消传播到请求独占任务；验收：取消后停止该请求新增读取，共享首扫继续推进；前置：IDE-BUD-001。(3e989ea;entityMapping.resolveMethodDefinition 增第四参 token:入口+ensureIndexForPythonFile 等待后两道闸(取消即 null,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0051)
- [x] IDE-BUD-003 [P0] 透传 def 补全的 CancellationToken；验收：取消后的类型查找不继续安排请求独占工作；前置：无。
- [x] IDE-BUD-004 [P0] 透传 Python 补全的 CancellationToken；验收：旧请求取消后不得返回覆盖新前缀的过时结果；前置：无。
- [x] IDE-BUD-005 [P0] 丢弃过期文档版本的签名帮助；验收：请求过程中编辑参数列表，旧版本签名结果不发布；前置：无。
- [x] IDE-BUD-006 [P0] 取消 CodeLens 后停止后续批次；验收：文档关闭或 token 取消后，不继续给该文档解析新的属性或 RPC 点位；前置：无。
- [x] IDE-BUD-007 [P0] 取消 Call Hierarchy 的后续扫描；验收：取消 incoming/outgoing 查询后，该请求的队列不继续增长；前置：无。
- [x] IDE-BUD-008 [P0] 隔离同点 hover 合并请求的取消；验收：取消一个等待者不取消另一个等待者需要的共享计算；前置：IDE-BUD-002。(881e508;hoverBudget 增 createWaiterUnionToken:共享 token=全部在册等待者并集(人人取消才取消),注销后的等待者取消不波及联合,零在册不取消(创建/登记窗口安全);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0052)
- [x] IDE-BUD-009 [P0] 为未知文件 def 归属查询去掉全扫等待；验收：冷 miss 只读快照和定向依赖；scanEntityMappings 挂起时仍有界返回；前置：无。

### IDE-SCH · 数据库派生计算退出交互重算（P1）

来源：PERF-04；src/databaseSchema.ts、src/databaseSimulator.ts、src/languageProviders.ts。
- [x] IDE-SCH-001 [P1] 拆出不访问 VS Code 的 schema 推导函数；验收：相同显式输入产生相同表/列结果，函数内部不读配置或文件；前置：无。(3873e32;databaseSchema 导出 deriveDatabaseTables(DatabaseSchemaDerivationInput{entityName,defFilePath,properties,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0053)
- [x] IDE-SCH-002 [P1] 为 schema 缓存加入实体与根身份；验收：A/B 同名实体得到各自表结构，不共用单例快照；前置：IDE-SCH-001, IDE-IDX-003。(685fc24;databaseSchema 模块级 LRU 缓存(上限 32):键=normalizePath(根)+\u0000+实体名,命中重插队尾,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0054)
- [x] IDE-SCH-003 [P1] 按 def 依赖版本失效 schema；验收：修改一个 def 仅重建它及其依赖实体的 schema；前置：IDE-SCH-002, IDE-SNP-006。(e5eec39;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0055)
- [x] IDE-SCH-004 [P1] 按 types.xml 依赖版本失效 schema；验收：修改引用类型后相关列更新，无关实体缓存保持命中；前置：IDE-SCH-003, IDE-SNP-004。(e56700f;快照身份增 typeRegistryPath+consumedTypeAliases(别名→解析摘要 b:内建/d:字典结构/a:数组结构/u:未解析,别名链取链尾结果,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0056)
- [x] IDE-SCH-005 [P1] 按表名前缀配置失效 schema；验收：切换 tablePrefix 后所有相关展示使用新表名，不等文件保存；前置：IDE-SCH-002。(c362185;缓存轴已由 SCH-002 tablePrefix 快照字段承担(isDatabaseSchemaSnapshotStale 比对现读 resolveSchemaTablePrefix,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0057)
- [x] IDE-SCH-006 [P1] 把 schema 重建放入后台任务；验收：冷 schema 计算期间宿主可响应取消和其他交互；前置：IDE-SCH-001。(8bfb370;src/schemaWarmup.ts: scheduleBackgroundSchemaWarmup(scheduler, root, entityNames,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0058)
- [x] IDE-SCH-007 [P1] 让属性 hover 查询已发布字段结果；验收：连续悬停同实体不同属性不重复构建完整 schema；前置：IDE-SCH-003, IDE-SCH-006。(dbbe9a0;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0059)
- [x] IDE-SCH-008 [P1] 按实体增量维护类型落库反查；验收：修改一个实体只替换它贡献的 usage 记录，不全仓重建；前置：IDE-SCH-004。(1626623;databaseSchema 反查改按实体记账:typeStorageUsageState{entityRecords:实体→{snapshot,usages[{typeName,usage}]},… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0060)
- [x] IDE-SCH-009 [P1] 让 types.xml CodeLens 只读反查快照；验收：读取 CodeLens 不再遍历所有实体构建 schema；前置：IDE-SCH-008。(6c6e366;databaseSchema 增只读反查面:getTypeStorageUsageIndexReadOnly(root)——聚合已发布则纯读返回(零快照探测,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0061)
- [x] IDE-SCH-010 [P1] 让 schema 导航复用同一代派生结果；验收：虚拟文档展示与字段反向跳转的表名/行号来自同一快照；前置：IDE-SCH-007, IDE-SCH-009。(6b807bd;KBEngineDatabaseSchemaProvider 记「屏上这一代」:publishedRenders(uri→{snapshot,lines}),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0062)

### IDE-DIA · 同步诊断与编辑响应（P1）

来源：PERF-05；src/receiverNoneDiagnostics.ts、src/diagnosticScheduler.ts。
- [x] IDE-DIA-001 [P1] 无 receiver 使用点时跳过诊断解析；验收：不包含 self.base/cell/client 使用的文件不调用完整 Python parser；前置：无。
- [x] IDE-DIA-002 [P1] 一次建立 Python 方法区间表；验收：处理多个调用点不再为每个点重新收集排序全部方法；前置：无。
- [x] IDE-DIA-003 [P1] 诊断复用同版本 Python 解析结果；验收：类索引与 receiver 诊断消费同版本缓存，不各自完整解析一次；前置：IDE-SNP-001, IDE-DIA-002。(a3fff02;PythonClassIndex 增版本键共享解析面:getParsedForVersion(file,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0063)
- [x] IDE-DIA-004 [P1] 按方法复用 receiver guard 分析；验收：同方法多处调用不重复遍历相同 guard 前缀，既有告警语义保持；前置：IDE-DIA-002。(47efc28;receiverNoneDiagnostics 重构 guard 分析为「单趟扫描+候选过闸」:scanGuardCandidates 按(方法区间,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0064)
- [x] IDE-DIA-005 [P1] 将大文件 receiver 诊断移出同步入口；验收：8,000 调用样本计算期间宿主仍可响应请求，旧版本回包丢弃；前置：IDE-DIA-003, IDE-DIA-004。(e25bc7d;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0065)
- [x] IDE-DIA-006 [P1] 为诊断队列增加单轮时间片；验收：多个文档待诊断时，一轮 flush 不连续占满宿主处理全部文档；前置：无。(c2d61b4;DiagnosticScheduler.flushQueued 时间片化:批量出队(collectQueued 所有权转移,并发 flush 不双算)后逐文档处理,连续同步段超 FLUSH_SLICE_MS(25ms,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0066)
- [x] IDE-DIA-007 [P1] 切换 receiver 开关时失效版本标记；验收：文档未编辑也能立即清除或重新发布 receiver 告警；前置：无。 【2026-10-30 第二轮复审重开：R2-F03，待 IDE-AUD-026；生产反例见 docs/review/2026-10-30-completion-audit-round2.md，历史实现/测试证据保留。】d9f9c52 关闭（AUD-026 补上切代守卫:receiver 开关切换→invalidateAll 自增代+全开文档立即重算(既有接线 extension.ts:1465-1481),在途旧异步结果 staleGenerationDropped 丢弃不覆写新配置结果——R2-F03「切代后 new-config 先发布再被 old-config 覆盖」两路(关闭回写/切代覆写)均门住;验收面既有测试 extension.test.ts「切换 receiver 诊断开关时重新计算未编辑文档」覆盖:开→关异步空集清除、关→开重发,文档未编辑,全绿）
- [x] IDE-DIA-008 [P1] 关闭文档时撤销待发布诊断；验收：文档关闭后晚到的 worker 结果不重新写入 DiagnosticCollection；前置：IDE-DIA-005。(be4a662;DiagnosticScheduler 每 URI 关闭代守卫:releaseDocument 自增代,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0067)

### IDE-RES · 队列、缓存和日志资源边界（P2）

来源：PERF-06；src/pythonParserWorkerHost.ts、src/languageServiceMetrics.ts、src/logHub.ts。
- [x] IDE-RES-001 [P2] 合并 worker 中同文件未开始的旧任务；验收：快速提交 v1/v2/v3 时未运行的旧版本不逐份解析；前置：无。(58352c2;pythonParserWorkerHost 同文件派发链 FileQueue{inFlight 一个,pendingLatest 一个}:同文件新请求到达时,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0068)
- [x] IDE-RES-002 [P2] 限制 Python worker 待处理字节量；验收：积压达到上限时不继续无限保留源码字符串，交互任务有可解释结果；前置：IDE-RES-001。(3fe30f6;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0069)
- [x] IDE-RES-003 [P2] 在 worker dispose 时结清全部等待者；验收：全部在途 Promise 都结算，旧 worker 回包不能污染新实例；前置：IDE-RES-001。(b8f7128;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0070)
- [x] IDE-RES-004 [P2] 给聚合耗时样本设置容量上限；验收：大量操作后 elapsed 数组不无限增长，摘要仍标明采样窗口；前置：无。(f17bbb6;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0071)
- [x] IDE-RES-005 [P2] 限制日志文件单轮读取字节数；验收：日志突增时分批读取，不一次分配等于全部增量的大 Buffer；前置：无。(c3a0e35;logHub.watchFile 增 MAX_READ_CHUNK_BYTES=1MiB 单批读取上限:poll 读取段改循环,循环外只 alloc 一块 min(上限,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0072)
- [x] IDE-RES-006 [P2] 限制日志到 webview 的发送积压；验收：页面暂停消费时队列有界，丢弃量可观测且宿主保持响应；前置：无。(0a113d3;logWebView 订阅面改合槽发送:enqueueWebviewBatch——postMessage 在途(webviewPosting)时新批只顶替待发槽(槽容量=1 批,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0073)
- [x] IDE-RES-007 [P2] 隐藏监控面板时停止非必要刷新；验收：隐藏后不继续发送完整图表快照，恢复后显示最新状态；前置：无。(3e5ea52;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0074)
- [x] IDE-RES-008 [P2] 根移除时释放派生内容缓存；验收：移除资产根后其源码/AST/schema 不再被长会话缓存持有；前置：IDE-SNP-009。(9c48b2e;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0075)

### IDE-MET · 现场取证与版本可辨识性（P1）

来源：审计 §5/§8；细化 P0-4b，已有并行采集实现可按证据认领。
- [x] IDE-MET-001 [P1] 导出活动扩展 ID 与版本；验收：报告区分安装目录存在和当前窗口已激活，并列出远程或本地宿主位置；前置：无。(60b4296;新建 src/extensionIdentity.ts 纯函数渲染面:hostLabel(vscode.env.remoteName 有值=remote(name),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0076)
- [x] IDE-MET-002 [P1] 在扩展产物中写入构建提交；验收：运行中的诊断报告能追溯准确源码 SHA，不仅显示 package version；前置：无。(0e892af;三面:①scripts/write-build-commit.mjs 构建脚本——git rev-parse HEAD 写 out/buildCommit.json(无 git 环境写 unknown 不阻断),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0077)
- [x] IDE-MET-003 [P1] 为 hover 增加分支级耗时记录；验收：能区分注解查询、def 映射、schema、渲染和总耗时；前置：无。(cf5bd53;HoverPhaseTimer per-request 直传 provideHoverTimed,三 resolve* 分 def-mapping/schema/render 段+annotation-query 回退段,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0078)
- [x] IDE-MET-004 [P1] 记录文件读取量与读取字节数；验收：一次普通 hover 可核对实际读盘范围，关闭详细日志时开销有界；前置：IDE-MET-003。(6f741d6;fileReadMetrics 模块:累计计数恒开 O(1),明细仅 verbose 走 256 条定长环形缓冲,关=清空;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0079)
- [x] IDE-MET-005 [P1] 采集事件循环延迟并统一为毫秒；验收：输出包含原始单位说明与采样窗口，不把纳秒写成毫秒；前置：无。(bfa7af8;hostVitals:monitorEventLoopDelay 直方图原生纳秒,renderEventLoopDelayReport 纯函数 ms=ns/1e6,报告三行=原始单位声明+窗口(秒/分辨率10ms/样本数)+ms 行与 raw nanoseconds 行并列可对账;激活即启动幂等采样,dispose 停止,showSummary 追加输出;prove-red eventLoopDelay 3 例(纯函数灌注 2.5e6ns→mean=2.5ms+2500000 原值在场/not started/真实监视器 max<60s 上限拦纳秒泄漏);门禁 eslint 0/tsc 0/unit 3425|7/demo 25 RC0;锚点 extension 9 锚 +5 重探同步 baseline)
- [x] IDE-MET-006 [P1] 采集同一进程窗口内 CPU 与 RSS；验收：CPU 增量正确换算微秒，区分采样峰值和进程历史高水位；前置：无。(4404586;hostVitals 扩面:process.cpuUsage 原生微秒增量直接在账不再换算,ms/单核占比为派生行;RSS 三列 current/peak(窗口)/high-water(监视期,跨窗口保留);1s unref 周期采样+手动 sampleHostVitals,报告即消费窗口;showSummary 追加输出;prove-red hostVitalsCpuMemory 3 例先红(函数缺);纯函数灌注 2.5e6us→2500000us/3700.0ms/370.0%+peak=60.0MB vs high-water=80.0MB 分列;活体断高水位≥峰值≥当前;门禁 eslint 0/tsc 0/unit 3428|7/demo 25 RC0;锚点 extension 9 锚 +3 重探同步)
- [x] IDE-MET-007 [P1] 提供扩展宿主 CPU profile 采集入口；验收：从卡顿触发到 profile 落盘的步骤可复现，结果可关联请求窗口；前置：无。(47811fa;cpuProfileCapture:inspector Profiler 域 1000us 采样,会话工厂可注入;kbengine.metrics.startCpuProfile/stopCpuProfile 命令化(package.json+activationEvents+commands.md 三面锁同步);落盘 .cpuprofile+同名 .window.txt(起止 ISO+时长+语言服务指标快照+事件循环延迟报告=请求窗口关联面);globalStorage 缺省回落 tmpdir;prove-red cpuProfileCapture 3 例先红(模块缺);假会话锁生命周期/落盘/幂等/失败断连;门禁 eslint 0/tsc 0/unit 3431|7/demo 25 RC0;锚点 extension 9 锚 +1 重探同步)
- [x] IDE-MET-008 [P1] 导出待处理与取消后残留任务数；验收：请求取消前后能比较活动任务，不用空返回值推断工作已停止；前置：IDE-BUD-002, IDE-RES-001。(3520e72;languageServiceMetrics 在册台账:startLanguageServiceOperation 入册/end 出册(cancelled 终态同出册,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0080)

### IDE-NAV · 基础语言功能逐项补齐（P1）

来源：审计 §4；src/languageProviders.ts、src/defReferenceGraph.ts、src/defRenamer.ts。
- [x] IDE-NAV-001 [P1] 注册 def 原生引用查询入口；验收：Shift+F12 可访问已有 def 引用结果，结果复用统一符号身份；前置：IDE-IDX-003。(bfa8a7d;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0081)
- [x] IDE-NAV-002 [P1] 为属性引用收录 Python self 访问；验收：已确定实体归属的 self.hp 纳入 hp 引用，无关实体同名属性不纳入；前置：IDE-NAV-001, IDE-IDX-004。(a0fb560;entityMapping.getIncomingPythonPropertyAccesses(defFile,prop,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0082)
- [x] IDE-NAV-003 [P1] 为方法引用收录 receiver RPC 调用；验收：Base/Cell/Client 同名方法按 receiver 段分开统计；前置：IDE-NAV-001。(ad466da;entityMapping.getIncomingPythonReceiverCalls(defFile,method,receiver,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0083)
- [x] IDE-NAV-004 [P1] 让引用结果使用未保存文档；验收：新增或删除未保存调用点后，引用列表跟随当前版本；前置：IDE-NAV-002, IDE-NAV-003, IDE-SNP-001。(eaa8f30;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0084)
- [x] IDE-NAV-005 [P1] 注册 def 文档符号；验收：Outline 按 Properties/三方法段展示声明与精确范围；前置：无。(1dc469a;KBEngineDocumentSymbolProvider(languageProviders):parseDefAst 复用 def-ast 版本化缓存,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0085)
- [x] IDE-NAV-006 [P1] 注册根范围工作区符号查询；验收：按名称前缀查询已索引符号，返回 root/文件信息且不触发全仓扫描；前置：IDE-NAV-005, IDE-IDX-003。(84fd87c;entityMapping.searchDefSymbolsByPrefix(prefix,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0086)
- [x] IDE-NAV-007 [P1] 注册 def 方法到 Python 的实现查询；验收：Go to Implementations 按精确声明身份返回实现列表；前置：IDE-IDX-003, IDE-IDX-004。(04acc7e;entityMapping.listMethodImplementationsByIdentity(identity,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0087)
- [x] IDE-NAV-008 [P1] 重命名前检查目标名冲突；验收：同段方法或属性/组件冲突时拒绝编辑并说明冲突位置；前置：无。(d187ecd;defRenamer.findDefRenameConflict(text,symbol,newName) 纯函数:方法重名只查本段(跨段同名合法,reqPos 三段并存是引擎常态),属性与组件同属实体成员命名面任一占名即冲突,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0088)
- [x] IDE-NAV-009 [P1] 重命名计算读取其他脏 def 缓冲区；验收：跨文件编辑范围按各文件当前文本计算，不使用过期磁盘偏移；前置：IDE-SNP-002。(7b8d04f;defRenamer.DefRenameOptions 加可选 readCrossFileContent(filePath)→string|null 注入读口,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0089)
- [x] IDE-NAV-010 [P1] 重命名应用前校验输入版本；验收：预览期间文档变化时重新计算或拒绝，不能套用旧范围；前置：IDE-NAV-009。(8e0177e;defRenamer 加 RenameInputVersionRef{filePath,source('document'|'disk'),version} + 纯函数 renameInputsDrifted(prev,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0090)
- [x] IDE-NAV-011 [P1] 让属性重命名更新确定的 Python 引用；验收：预览列出 def 与已解析 self 访问；有歧义的引用不猜测改写；前置：IDE-NAV-002, IDE-NAV-008, IDE-NAV-010。(da8c18c;KBEngineRenameProvider 注入 EntityMappingManager(可空缺省 null 只出 def 编辑),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0091)
- [x] IDE-NAV-012 [P1] 让方法重命名更新确定的 RPC 引用；验收：调用端 receiver 段与被重命名声明一致时才改写；前置：IDE-NAV-003, IDE-NAV-008, IDE-NAV-010。(7ea10e5;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0092)
- [x] IDE-NAV-013 [P1] 为未知类型诊断提供修正候选；验收：Code Action 仅提供已注册类型的可核对替换，不自动创建声明；前置：无。(486dc46;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0093)
- [x] IDE-NAV-014 [P1] 为缺少实现的方法生成单个空方法；验收：Code Action 展示目标文件与插入点，已有同名实现时不重复生成；前置：IDE-NAV-007。(7f5e6e6;entityMapping 加 listOwnerScriptFilesForIdentity(identity,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0094)
- [x] IDE-NAV-015 [P1] 统一调用层次与 Definition 的符号身份；验收：相同 RPC/mixin 方法在两种入口中的 owner 与目标集合一致；前置：IDE-IDX-003, IDE-IDX-004。(206ae01;languageProviders 抽统一链 resolveDefMethodPythonTarget(document,名,section,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0095)
- [x] IDE-NAV-016 [P1] 为冷补全提供可刷新状态；验收：索引未就绪时不记录永久 miss，索引更新后同前缀可得到成员补全；前置：IDE-SNP-006, IDE-BUD-004。(b631d6d;entityMapping 加 isInitialScanComplete():boolean 只读暴露 initialScanCompleted(不触发门控启动,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0096)
- [x] IDE-NAV-017 [P1] types.xml 引用查询（Shift+F12）（2026-10-30 用户反馈：def 与 types.xml 目前只实现 F12 跳转，Shift+F12 无引用展示）；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0097)
- [x] IDE-NAV-018 [P2] def 引用查询盲区核对（2026-10-30 用户反馈：实测 def 内 Shift+F12 也未展示引用）；现状：IDE-NAV-001 已覆盖方法→Python 调用点、属性→self 访问（tests/defReferences.test.ts 在守），但类型名/实体名等符号类不在引用链上。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0098)

### IDE-GEN · 生成器写入保护（P1）

来源：审计 §6；src/codeGenerator.ts、src/generatorForms.ts。
- [x] IDE-GEN-001 [P1] 阻止实体向导覆盖已有 def；验收：同名 def 已存在时保留原字节并给出冲突信息；前置：无。(18f097e;codeGenerator.generateDefFile 落盘前 fs.existsSync(defFilePath) 守卫→throw `def 文件已存在，保留原文件未覆盖: <目标路径>`,原字节零接触;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0099)
- [x] IDE-GEN-002 [P1] 阻止实体向导覆盖已有 Python 文件；验收：同名实现存在时保留原代码，不能因生成 def 顺带覆盖；前置：无。(a087230;codeGenerator.generatePythonFile 落盘前 fs.existsSync(pythonFilePath) 守卫→throw `Python 文件已存在，保留原代码未覆盖: <目标路径>`,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0100)
- [x] IDE-GEN-003 [P1] 生成前检查全部目标路径；验收：任一目标冲突时不先写出其他半套文件；前置：IDE-GEN-001, IDE-GEN-002。(0a5b976;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0101)
- [x] IDE-GEN-004 [P1] 为单次生成提供变更预览；验收：确认前可查看将新增的 def/Python/注册项与准确路径；前置：IDE-GEN-003。(ff4ba93;codeGenerator 加 confirmGenerationPlan(config):Promise<boolean>——QuickPick 确认行列出计划项(新增 .def 描述=准确 def 路径,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0102)
- [x] IDE-GEN-005 [P1] 对单文件生成使用原子替换；验收：写入中断时旧文件保持完整，不留下半截文本；前置：IDE-GEN-003。(8414888;新模块 src/atomicFileWrite.ts writeFileAtomic(filePath,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0103)
- [x] IDE-GEN-006 [P1] 多文件生成失败时撤回本次新增项；验收：模拟第二份文件写入失败后，第一份新增文件与本次注册项被回收；前置：IDE-GEN-005。(7bf6d73;codeGenerator 加 rollbackLedger{createdFiles,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0104)
- [x] IDE-GEN-007 [P1] 注册 entities.xml 时保留脏缓冲区；验收：写入基于当前文档，不覆盖用户尚未保存的其他注册修改；前置：IDE-SNP-001。(2b081fd;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0105)
- [x] IDE-GEN-008 [P1] 统一两个生成入口的冲突策略；验收：实体向导与表单向导遵守相同的拒绝覆盖、预览和失败处理规则；前置：IDE-GEN-004, IDE-GEN-006, IDE-GEN-007。(ca24b1a;三面统一:①拒绝覆盖——generatorForms 加 hasGeneratorFormConflict(input,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0106)

### IDE-PRJ · KBEngine 项目模型与导入（P2）

来源：审计 §6；src/workspaceDiscovery.ts、src/pythonExtraPaths.ts、src/engineApiMetadata.ts。
- [x] IDE-PRJ-001 [P2] 建立项目 profile 的稳定 ID；验收：同工作区两套 assets/engine 组合能分别保存身份，不用显示名当主键；前置：无。(7f8eb37;新 src/projectProfiles.ts ProjectProfileStore{id 创建时 randomUUID 一次分配+幂等键重摇,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0107)
- [x] IDE-PRJ-002 [P2] 按 profile 保存根与引擎路径；验收：两个 profile 分别读回各自 assets/engine 路径，重启后记录仍独立；前置：IDE-PRJ-001。(3b96b52;ProjectProfileStore 增 saveRoots(id,{assetsRoot?,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0108)
- [x] IDE-PRJ-003 [P2] 提供现有 KBEngine 项目导入命令；验收：选择资产根后能预览 entities/defs/scripts/engine 的识别结果；前置：IDE-PRJ-001。(491628d;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0109)
- [x] IDE-PRJ-004 [P2] 记录 Python 解释器来源；验收：profile 明确使用哪一个解释器，找不到时显示缺失状态；前置：IDE-PRJ-001。(35dedcd;新 src/profileInterpreter.ts:解析链 resolveInterpreterWith——kbengine.python.interpreterPath 设置(存在才采用,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0110)
- [x] IDE-PRJ-005 [P2] 检查 Python 语言服务是否可用；验收：分别显示未安装、未启用和已激活状态，不把 extraPaths 写入等同可用；前置：无。(c678acd;新 src/pythonLanguageServiceStatus.ts 纯判定+渲染面(MET-001 同构,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0111)
- [x] IDE-PRJ-006 [P2] 按 base/cell 角色隔离 Python 分析根；验收：同名模块不会因合并 extraPaths 顺序而被跨角色误解析；前置：IDE-PRJ-002, IDE-PRJ-004。(c9086d9;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0112)
- [x] IDE-PRJ-007 [P2] 建立最小项目创建模板清单；验收：清单明确新增目录和文件，可预览且已有目标冲突时拒绝；前置：无。(38ae8fa;新 src/projectTemplate.ts:MINIMAL_PROJECT_TEMPLATE 固定清单 6 条目(scripts 布局与 DISCOVERY_CONVENTIONS 对齐,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0113)
- [x] IDE-PRJ-008 [P2] 接入最小项目创建命令；验收：一次生成可被导入的空项目，创建过程遵守生成器保护；前置：IDE-PRJ-003, IDE-PRJ-007, IDE-GEN-008。(1b45b83;新 src/projectCreate.ts createMinimalProject(context,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0114)
- [x] IDE-PRJ-009 [P2] 把 profile 健康状态汇总到工作台；验收：缺引擎、缺解释器、缺语言服务和根歧义各有具体定位入口；前置：IDE-PRJ-002, IDE-PRJ-004, IDE-PRJ-005, IDE-PRJ-010。(61c3b6e;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0115)
- [x] IDE-PRJ-010 [P2] 增加活动 profile 选择入口；验收：选择后持久化稳定 ID 并发出一次切换事件，显示名变化不丢选择；前置：IDE-PRJ-002。(58603e1;新 src/activeProfile.ts:ACTIVE_PROFILE_STATE_KEY=kbengine.activeProfileId.v1 持久化稳定 ID;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0116)
- [x] IDE-PRJ-011 [P2] 让语言索引响应 profile 切换；验收：索引输入切换到选定根，旧 profile 晚到结果不写入当前快照；前置：IDE-PRJ-010, IDE-SNP-010。(63fdbca;三面:①src/scanRoots.ts 增会话态选定根 setActiveProfileScanRoot/getActiveProfileScanRoot(非发现记忆,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0117)
- [x] IDE-PRJ-012 [P2] 让启动命令响应 profile 切换；验收：下一次启动使用所选 profile 的引擎和环境，不改变已经运行实例的身份；前置：IDE-PRJ-010, IDE-RUN-001。(dea7bf7;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0118)
- [x] IDE-PRJ-013 [P2] 让生成向导响应 profile 切换；验收：预览及写入路径都来自所选 profile，已打开旧预览在切换后要求重算；前置：IDE-PRJ-010, IDE-GEN-004。(e859a2a;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0119)

### IDE-RUN · 进程目标与启动编排（P1）

来源：审计 §6；src/processManager.ts、src/serverManager.ts。
- [x] IDE-RUN-001 [P1] 用 targetId 区分同组件多实例；验收：两个 cellapp 能分别登记和停止，不能相互覆盖进程记录；前置：IDE-PRJ-001。（4d6268f；`DEFAULT_TARGET_ID='default'`+`buildServerKey`/`parseServerKey`：默认实例登记键保持纯组件名（UI 树/命令/调试注入面零变化），… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0120)
- [x] IDE-RUN-002 [P1] 按 targetId 维护运行状态；验收：进程退出只更新对应实例，其他同类型实例状态不变；前置：IDE-RUN-001。（7ca6323；实现无新增改动——RUN-001 已把 processManager id 与登记键统一为复合键，onState 事件按 `event.id` 精确命中实例行，退出/错误只删对应实例记录；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0121)
- [x] IDE-RUN-003 [P1] 用真实探针确认进程 ready；验收：固定 1 秒经过但服务不可用时仍为 starting，探针成功才 ready；前置：IDE-RUN-002。（27539e5；两面:①src/processManager.ts ProcessSpawnRequest 增 readiness{probe,intervalMs=250}——给出即取代固定宽限定时器,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0122)
- [x] IDE-RUN-004 [P1] 让启动等待支持超时和取消；验收：超时或用户取消后停止等待并报告对应 target，不误标 running；前置：IDE-RUN-003。（42b1f31；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0123)
- [x] IDE-RUN-005 [P1] 为启动项声明直接依赖；验收：依赖图可检测循环，尚未就绪依赖不会被当作成功；前置：IDE-RUN-003。（c07573b；两面:①src/serverManager.ts ServerComponent 增 dependsOn?:readonly string[] 声明面,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0124)
- [x] IDE-RUN-006 [P1] 按依赖就绪顺序启动一组目标；验收：前置进程失败时依赖它的后续启动不继续；前置：IDE-RUN-005。（714f4f6；src/serverManager.ts 增 startTargetGroup(requests,options{dependencyTimeoutMs,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0125)
- [x] IDE-RUN-007 [P1] 停止进程时清理所属子进程；验收：组件派生子进程不会在停止后残留，处理策略有平台区分；前置：IDE-RUN-001。（8eec4b6；src/processManager.ts 增 killProcessTree(pid,signal,child?,deps{runTaskkill?,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0126)
- [x] IDE-RUN-008 [P1] 为启动失败提供单目标重试；验收：重试只作用失败 target，不重复启动已就绪的其他实例；前置：IDE-RUN-004, IDE-RUN-006。（046b126；src/serverManager.ts 增 retryTarget(request,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0127)

### IDE-DBG · 调试闭环（P1）

来源：审计 §6；src/debugConfig.ts、src/autoDebugpy.ts。
- [x] IDE-DBG-001 [P1] 按 targetId 分配 debugpy 端口（9321d22；src/autoDebugpy.ts 新增 DEBUGPY_INSTANCE_PORT_WINDOWS 每组件 8 槽窗口 baseapp 5700/cellapp 5708/loginapp 5716/dbmgr 5724/logger 5732+allocateDebugpyInst… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0128)
- [x] IDE-DBG-002 [P1] 为远程目标配置路径映射（7dc7816；src/debugConfig.ts RemoteDebugTarget 增可选 localRoot/remoteRoot——readRemoteTargets 成对非空才收录(映射需要两侧,半配不猜保持省略,trim 后空串/非字符串整对不落),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0129)
- [x] IDE-DBG-003 [P1] 调试前检查所选解释器的 debugpy（094f684；新 src/debugpyPreflight.ts:checkInterpreterDebugpy 四态预检——interpreter-missing(PRJ-004 同一解析链 设置→PATH,缺失不执行探测,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0130)
- [x] IDE-DBG-004 [P1] 支持启动前等待调试器连接（9b0b404；新 src/debugpyWaitAtStartup.ts:kbengine.debug.waitAtStartup 显式 opt-in(默认 false)——引擎进程里最早执行的 python 只能来自入口脚本,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0131)
- [x] IDE-DBG-005 [P1] 把调试会话关联到运行目标（5ea864b；新 src/debugSessionRegistry.ts:parseDebugSessionName 按 launch.json 生成条目名解析目标身份——表条目 `KBEngine: Python attach to <comp> (debugpy <port>)`=默认实例(DEFAULT_TARGET_… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0132)
- [x] IDE-DBG-006 [P1] 让断开调试只影响指定目标（9ddbe28；验收面=结束会话不终止其他实例+detach/stop 有明确配置:src/debugSessionRegistry.ts 增 onLinkTerminated 订阅面(listener-set 轻实现免 vscode EventEmitter 依赖,unregister 先回调再删链,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0133)
- [x] IDE-DBG-007 [P1] 为调试连接设置取消与超时（09438bc；验收面=不可达端口不永久等待+取消后不重试:新 src/debugAttachGuard.ts 纯模块 attachWithDeadline——执行器内同步发起 start()(同步抛错兜成 rejection 同通道),三路竞速:按期完成(completed+success,清计时器+释放取消订阅,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0134)
- [x] IDE-DBG-008 [P1] 在工作台显示目标调试状态（c2dc455；验收面=四态可辨+点击定位会话:新 src/debugStatusBoard.ts 纯合板——resolveTargetDebugPhase 四态归因(在挂会话>0 一票「已附加」压过监听/失败;否则注入结果面 listening=监听/failed=失败;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0135)

### IDE-TSK · 构建与项目测试工作流（P2）

来源：审计 §6；复用 quick actions 与 VS Code Tasks/Test API。
- [x] IDE-TSK-001 [P2] 定义 profile 的构建任务描述（92a99f5；验收面=command/args/cwd/env 四要素+预览逐字一致:新 src/buildTaskSpec.ts 纯模块——BUILD_TASK_TYPE='kbengine.build'(TSK-002 TaskDefinition.type 注册面),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0136)
- [x] IDE-TSK-002 [P2] 注册 KBEngine 构建 TaskProvider（9d38926；验收面=任务列表逐 profile 出构建项+取消终止:新 src/buildTaskProvider.ts——BUILD_TASK_SOURCE='kode'(任务列表「源」列),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0137)
- [x] IDE-TSK-003 [P2] 把构建错误定位到源码；验收：已支持的编译/脚本错误经 problem matcher 跳到正确文件行；前置：IDE-TSK-002。(1036eeb;compileall 双格式实证:本机 3.14 实跑发现 3.13+ 是多行 traceback(头/Error compiling+File 行+错误类),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0138)
- [x] IDE-TSK-004 [P2] 发现项目声明的 Python 测试；验收：只扫描所选 profile 的测试范围，不把依赖库测试混入；前置：IDE-PRJ-004。(c20c002;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0139)
- [x] IDE-TSK-005 [P2] 在测试面板运行单个测试；验收：单测试输出、通过失败与源码位置对应，取消不继续执行下一测试；前置：IDE-TSK-004。(2622196;新 src/pythonTestRunner.ts:逐条目 <解释器> -m pytest <file>::<case> -v --tb=line -p no:cacheprovider(cwd=scripts 根,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0140)
- [x] IDE-TSK-006 [P2] 保存可重复运行的任务上下文；验收：重跑使用同一 profile/解释器/环境，不能悄然换到另一个根；前置：IDE-TSK-002, IDE-TSK-005。(cd582ae;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0141)

### IDE-HOT · 热更新可验证状态（P2）

来源：审计 §6；细化现有 HR-STATE/HR-HTTP/HR-UI 需求，旧条目作为汇总不双算。
- [x] IDE-HOT-001 [P2] 按 rootId 与 targetId 隔离热更新状态；验收：同文件发给不同实例分别保存结果，不复用上一目标绿色状态；前置：IDE-RUN-001。(8b963c5;新 src/hotReloadTargetState.ts:HotReloadTargetKey{rootId,targetId}(rootId=文件归属扫描根,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0142)
- [x] IDE-HOT-002 [P2] 将 HTTP 发送成功记为未确认；验收：只有 2xx 且无可信应用证据时显示 sent_unverified；前置：IDE-HOT-001。(cb658a5;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0143)
- [x] IDE-HOT-003 [P2] 解析单目标 accepted 回执；验收：只在符合已记录协议的回执上进入 accepted，未知结构保留未确认；前置：IDE-HOT-002。(728d752;新 src/hotReloadReceipt.ts:已记录协议=JSON {"status":"accepted",… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0144)
- [x] IDE-HOT-004 [P2] 核验单目标 applied 状态；验收：仅可信 revision/digest 或已验证回执可标 applied，超时仍未确认；前置：IDE-HOT-003。(ba1d4d0;新 src/hotReloadAppliedCheck.ts:applied 回执协议=JSON {"status":"applied","file":"<逐字回显>",… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0145)
- [x] IDE-HOT-005 [P2] 将结构性 def 变更标记需重启；验收：影响序列化或 RPC 参数的变化不作为普通 Python reload 自动发送；前置：IDE-SNP-006。（53b2821;结构指纹双面=序列化面(Properties 逐属性子元素取 Type|Flags+属性名集)+RPC 面(三方法段逐方法 Arg 签名+方法名集),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0146)
- [x] IDE-HOT-006 [P2] 按目标聚合部分成功结果；验收：两个目标一成一败时显示 partial，并能查看各自原因；前置：IDE-HOT-004。（3e1487f;summarizeHotReloadBatch 吃 HOT-001 台账,目标级=名下最差文件记录(failed>sent-unverified>accepted>applied,同目标绿灯不盖红灯),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0147)
- [x] IDE-HOT-007 [P2] 只重试失败目标的热更新；验收：重试不重复发送已确认成功目标，取消后停止后续发送；前置：IDE-HOT-006。（50b63d7;retryFailedHotReloadTargets 吃 HOT-006 批次聚合,只对 outcome=failed 目标调注入 send;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0148)
- [x] IDE-HOT-008 [P2] 显示运行时 revision 的证据来源；验收：本地 fileHash、semanticHash、engineDigest 标签明确，不相互冒充；前置：IDE-HOT-004。（2421d50;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0149)

- [x] IDE-HOT-100 [P1] 脚本文件热更状态机；验收：每个 (rootId,targetId,file) 有 CLEAN/DIRTY/SENT/APPLIED/FAILED 态，依据=内容 hash+既有回执协议（不靠 mtime）；结构性 def 变更走 RESTART_REQUIRED 不进普通 reload；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0150)

- [x] IDE-HOT-101 [P1] 重载通道抽象（ReloadTransport 接口）；验收：send(target,fileSet)→回执流；内置 A=KBEngine 官方方案（引擎内建 reloadScript，经控制台触达 baseapp/cellapp，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0151)

- [x] IDE-HOT-102 [P2] 重载配置与审计；验收：部署级重载通道配置面板（官方/HTTP 自定义）+连通性测试按钮；全部重载动作进审计（谁/何时/哪些文件/通道/结果）；前置：IDE-HOT-101。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0152)
- [x] IDE-HOT-103 [P1] 热更快捷启用：预设一键启用+状态栏通道切换+默认键位。(5347782;预设四选一(自研 HTTP 推荐/官方/未配置/高级)+单 profile 1 步零输入框+探活失败不写盘红标直达高级流+状态栏 $(plug) 三选切换选中即探活+ctrl+alt+r 默认键位(避撞 httpRequest.run,依据入 4 处文档+测试锁);tests 21+20+3+1 例;vitest 6788/0;codex 5 轮 PASS)
- [x] IDE-HOT-104 [P1] 热更默认开启+默认 HTTP 端点。(b17ca3d+3b9ff2b+a1e2df8;enabled 默认 true(写死 false 仍关)/保存 .py 自动 POST http://127.0.0.1:8090/hotfix,query+body 各带 module_name=<resolveModuleDualName>(双带兼容不同服务端读参)/引擎不可达如实 failed(ECONNREFUSED)/状态栏点击=一键开关写回并核对生效/首激活一次非模态提示可永久关/全仓旧拼写(rel+aod)门清零;vitest 6810/0;codex 2 轮 PASS)
- [x] IDE-HOT-105 [P1] 状态栏版本号徽标：单号=已同步 v3,双号=待同步 v2→v3。(d188a7a;per-file 版本簿 token(mtimeMs:size)+1 绝不倒退,基线仅 applied 且 digest 一致追平;五态文案逐字不回归正交追加;tooltip 待同步清单;OUTPUT 版本跃迁史;watch-off 手动触发照样出号;39 新测试,vitest 6769/0)
- [x] IDE-HOT-106 [P1] watcher 默认只监控 assetsRoot+非 py 旁路通道。(PR#21 31f2f33+0685897;无 globs→派生 <assetsRoot>/**/*.py,拿不到根 ready-with-error 显式报错不回落全扫,根变更重建;非 py 事件照发不投递=fileChangeBypass 纯数据协议+消费者注册表+$/kode/fileChanged 帧(kode-protocol 跨语言对账锁),rust 不可用静默降级,无消费者只记录;显式 glob 宽面 .xml 只走旁路 .py/.def 留热更域;vitest 6943/0+cargo workspace 全绿+clippy 0;codex 5 轮 PASS)
- [x] IDE-HOT-107 [P1] 路径变量模板两链统一。(10ccf1f;workspacePath.renderPathTemplate 委派 variableSubstitution 单一真源,resolveWorkspacePath(手工链)+resolveAgainstWorkspace(发现链)同调,等价性测试 3 例 prove-red;修真 bug=手工链不渲染 ${workspaceFolder} 致 def 根定位错位;附带真机面板打开冒烟 --panelopen 1 passing(84cb82f,替身+真机双层锁打开链路,UI-04 回归假设证伪=旧扩展无热更命令))
- [x] IDE-META-001 [P1] 文件变化元信息：identity+version 记忆化懒解析+进程归属。(f08cfbd 合 410e262;merger 带盘上 version token(9061575);src/fileChangeMeta.ts 字段面 fileName/ext/module/package/processKind/sha256/size/mtime,同版本零 IO,delete 不读不 stat,失败部分字段+reason 不抛;进程归属 base|cell|login|interfaces|bots|logger→对应 app,common/user=shared,判不出 unresolved 不编造,嵌套取最靠近脚本段,ambiguous 给候选;消费端=热更审计行元信息+python 索引日志(kbengine.jumpLog 开关默认关零 IO);17 例红→绿+消费端 4 例+加固 7 例(盘符/UNC/scriptRoot 热切换/LRU 512/sha256 契约);codex 6 轮 PASS)
- [x] IDE-META-002 [P1] module/package 仅 .py 文件解析（非 py 不带,不用 - 冒充）。(adb16a0+2f593db+ea50b8f;显式门控 ext==.py 才调解析器(原依赖 resolveModuleDualName 内部拒绝,落为契约显式化);processKind 全扩展名有效;6 条锁定测试含两消费腿非 py 行 module=-;CI 绿)
- [x] IDE-WARM-001 [P1] 激活即后台预热，面板读缓存秒出。(59eaaf5;五阶段管线(发现链复用/事件索引入调度器/依赖图同 analyzer/定义布局/逐实体并发 4)阶段间 setImmediate 让出+可取消+代际防旧覆盖;面板三态 done 秒出(零 findFiles 零 analyze 断言)/running 进度页复用同 Promise/失败回落现算;实测冷开 4.11ms→0.42ms≈10-13×;43 新测试,vitest 6718/0,CI 全绿)
- [x] KODE-CFG-DESC-001 [P1] 111 配置键 markdownDescription 补全+对账锁。(00e6264+29f1ca9+f87d4e9;全部键=作用+默认值+配置指南锚点深链(111/111 映射真标题);8 enum 全带选项说明;6 短键按真实解析链重写;锁定测试 9 例(键必须有 markdownDescription+默认值段+enum 说明+锚点存在)——首推即抓到并发席 archiveEncryption 裸枚举真违规修掉;顺手修 2 处过时文档)
- [x] KODE-GATE-MOCHA-001 [P1] nightly mocha 门 3 红归因修复+门接进 CI。(7e0e54a+c0c0b5c+79f18cf;manifest 真 bug=121 命令仅 selectInterpreter/createVenv 漏 onCommand 激活事件补齐;状态栏断言 3→5 逐盏锁定(priority 全表无抖动);ci.yml 打包前加 mocha 编译产物烟测步(vsce esbuild 覆盖 out/ 前验 tsc 产物);pnpm test EXIT=0 12 passing)
- [x] KODE-DOCS-AUD-2 [P2] 文档一致性审计第二轮+双语覆盖 100%。(b8d93bf:三桶=文档超前 0/码超前 8/描述不符 3 全修(P0=README 95 命令/92 配置实为 121/111);e0a7b1c:双语 40/53→53/53(12 页中文错放根级 git mv 保字节移 zh+根级落忠实英文译版+space-viewer-watcher/mixin-jump 归位+en commands 归位零丢失);对账锁 en/zh 双份等强度;CI 双绿)


### IDE-LIV · 运行观测与真实协议验证（P2）

来源：审计 §6；src/kbengineProtocol.ts、src/runtimeQueryWebView.ts。
- [x] IDE-LIV-001 [P2] 登记真实引擎联验所需输入；验收：记录目标版本、组件地址和启动条件，缺实例时明确未测；前置：无。（eb23216;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0153)
- [x] IDE-LIV-002 [P2] 核对一个目标版本的 watcher 协议号；验收：请求与回包号可逐条指向该版本源码，不沿用未验证常量；前置：IDE-LIV-001。（0029957;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0154)
- [x] IDE-LIV-003 [P2] 完成一次真实 watcher 路径查询；验收：面板结果与引擎控制台同路径值一致，保留原始联验证据；前置：IDE-LIV-002。（本提交;真机联验 2026-11-07:imac(192.168.5.117) WSL2 Ubuntu 24.04 源码构建引擎(ninja RC=0,内嵌 Python 3.7.17)10 组件+bots 在线,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0155)
- [x] IDE-LIV-004 [P2] 完成一次真实空间列表查询；验收：空间与组件身份可与运行引擎对账，缺失字段明确标未知；前置：IDE-LIV-001。（本提交;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0156)
- [x] IDE-LIV-005 [P2] 用稳定目标身份关联观测结果；验收：相同组件类型的两个实例不会混合数值或曲线；前置：IDE-RUN-001, IDE-LIV-003。（本提交;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0157)
- [x] IDE-LIV-006 [P2] 为观测断连提供恢复状态；验收：断连后旧值标记过期，重连成功才恢复实时标记；前置：IDE-LIV-005。（本提交;真机联验 2026-11-07 同 LIV-003 环境:三态全真实——live(成功读数 04:44:40.816Z)→断连轮对真实不可达地址(127.0.0.1:1 connect 实败非模拟)→stale(连续失败 1 轮,旧值时刻 .816Z 保留,文案明示「重连成功前不转实时」)→对真引擎再成功→live(.818Z,严格晚于断连时刻);证据=docs/acceptance-evidence/IDE-LIV-006.md+docs/acceptance-evidence/IDE-LIV-observation-run-2026-11-07.txt;门禁=eslint 0/tsc 0/vitest 591 文件 7225 passed|2 skipped RC=0/--live 真机套件 5 passing RC=0）
- [x] IDE-LIV-007 [P2] 把运行异常关联到源码定位；验收：带可解析文件行的异常可跳转，无源码时保留原始信息；前置：IDE-LIV-005。（本提交;真机联验 2026-11-07 同 LIV-003 环境:真实异常=cellapp.out S_ERROR traceback(File "/mnt/c/work/liv-run/scripts/cell/Avatar.py",… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0158)
- [x] KB-GC-001 [P1] guiconsole console 链期一:实时日志 tail + 组件状态面板（设计依据 docs/design/kbengine-guiconsole-integration.md §1.4/§4;协议 @3082ab5)。验收=①tail:向发现到的 logger 注册 `Logger::registerLogWatcher`(702),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0159)

### IDE-DB · 只读数据库工作流（P2）

来源：审计 §6；src/databaseDrift.ts、src/databaseSchema.ts。
- [x] IDE-DB-001 [P2] 按 profile 选择只读数据库连接；验收：切换项目不复用另一 profile 的连接配置或结果缓存；前置：IDE-PRJ-001。（7c3e3cc;src/databaseConnectionRegistry.ts 双隔离=DatabaseConnectionRegistry(profileId→配置快照,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0160)
- [x] IDE-DB-002 [P2] 提供单表只读数据预览；验收：只执行现有白名单允许的查询，默认结果有条数上限；前置：IDE-DB-001。（c2129c1;src/databaseTablePreview.ts buildTablePreviewStatement 固定 `SELECT * FROM \`表\` LIMIT N` 形状,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0161)
- [x] IDE-DB-003 [P2] 为只读查询增加取消与超时；验收：慢查询结束等待并释放连接，不滞留后台轮询；前置：IDE-DB-002。（59a41ac;src/databaseQueryLifecycle.ts runReadOnlyQueryLifecycle 四终态=completed/failed/timeout/cancelled,慢查询到点立即返态不干等,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0162)
- [x] IDE-DB-004 [P2] 将结果列关联回 def/type 声明；验收：点击已推导列能定位正确来源；未知引擎列说明为合成列；前置：IDE-SCH-010, IDE-DB-002。（9293bc6;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0163)
- [x] IDE-DB-005 [P2] 提供单实体结构变更影响预览；验收：列出新增/移除/类型变化，不执行 DDL 或写库；前置：IDE-SCH-003。（0820f0a;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0164)
- [x] IDE-DB-006 [P2] 按引擎版本保存 drift 联验证据；验收：报告能区分实际查询结果和模拟 schema，版本未知时不宣称兼容；前置：IDE-DB-001。（a74230d;src/databaseDriftEvidence.ts DriftEvidenceRecord 分开存 queried 面(真实 MySQL 查询所得,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0165)

### IDE-SDK · 客户端 SDK 与消息表入口（P2）

来源：审计 §6；src/clientSdkGenerator.ts、src/messageTable.ts。
- [x] IDE-SDK-001 [P2] 增加单实体 messageTable 预览命令；验收：选择实体后可查看现有计算结果，缺声明时明确提示；前置：IDE-IDX-003。（98f4a06;kbengine.messagetable.preview:src/messageTablePreview.ts 命令体纯逻辑(VSCode 面全注入),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0166)
- [x] IDE-SDK-002 [P2] 提供消息表 JSON 导出；验收：输出保留方法段、utype、alias 配置与问题清单，取消不创建文件；前置：IDE-SDK-001。（8065b95;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0167)
- [x] IDE-SDK-003 [P2] 把 SDK 生成绑定到目标 profile；验收：实体注册顺序与类型数据来自所选根，不能跨根同名覆盖；前置：IDE-PRJ-010, IDE-IDX-003。（c82b956;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0168)
- [x] IDE-SDK-004 [P2] 为 SDK 输出记录引擎版本与提交；验收：生成物可追溯输入版本，探测不到时写 unknown；前置：IDE-SDK-003。（75313fb;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0169)
- [x] IDE-SDK-005 [P2] 对拍一个真实引擎版本的消息编号；验收：以真实装载序核对 SDK/消息表差异，未支持组件编号边界如实保留；前置：IDE-SDK-001, IDE-SDK-004, IDE-LIV-001。（796db26;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0170)

### IDE-REL · 扩展发布与旧版共存（P1）

来源：审计 §5/§6；package.json 与构建发布流程。
- [x] IDE-REL-001 [P1] 检测两个 Kode ID 是否同时激活；验收：只有实际共激活才提示冲突，不把已安装但禁用当作冲突；前置：IDE-MET-001。（17564c9;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0171)
- [x] IDE-REL-002 [P1] 记录旧扩展 ID 的迁移说明；验收：文档给出旧 ID、新 ID 和保留用户设置的迁移步骤；前置：IDE-REL-001。（ad3d361;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0172)
- [x] IDE-REL-003 [P1] 核验 VSIX 包含 parser worker 产物；验收：打包后可直接找到 worker 文件并从包内路径启动；前置：无。（875add2;真打包核验 2026-10-29=vsce package --no-dependencies --out /tmp/rel003(本地产物不 tag 不 Release,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0173)
- [x] IDE-REL-004 [P1] 在 VSIX 中暴露构建身份；验收：安装产物报告的提交与构建输入一致，源码目录版本不冒充已安装版本；前置：IDE-MET-002。（ac24985;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0174)
- [x] IDE-REL-005 [P1] 确定最低 VS Code 运行时矩阵；验收：按使用的 Node/API 核对最低支持版本，记录验证而不是只沿用 engines.vscode；前置：无。（5d9faa8;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0175)
- [x] IDE-REL-006 [P1] 增加安装后单次 hover/跳转烟测；验收：使用打包产物执行有命中断言的请求，覆盖 worker 路径和源定位；前置：IDE-REL-003, IDE-REL-004。（5d5e4b0;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0176)
- [x] IDE-REL-007 [P1] 从诊断报告导出复现配置摘要；验收：导出活动版本、根、角色、开关与队列数据，敏感连接信息被遮蔽；前置：IDE-MET-001, IDE-MET-008。（10bb539;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0177)

### IDE-ARC · 模块职责收敛（P2）

来源：审计 §2；逐个抽离，不合成一次大重构。
- [x] IDE-ARC-001 [P2] 抽离源码 reveal 命令常量；验收：eventApi 等消费者不再为取常量反向依赖整个 languageProviders；前置：无。（3c682ec;新 src/sourceRevealCommand.ts 单一事实源(常量+批159 语义指针注释,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0178)
- [x] IDE-ARC-002 [P2] 抽离事件索引的纯数据类型；验收：WorkspaceIndex 与事件语法分析通过小接口互用，不依赖 provider 实现；前置：IDE-ARC-001。（289807c;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0179)
- [x] IDE-ARC-003 [P2] 抽离 hover Markdown 格式化函数；验收：纯格式化模块不读取文件或配置，既有 hover 文本保持一致；前置：无。（2fd0f44;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0180)
- [x] IDE-ARC-004 [P2] 抽离 schema 的 VS Code 文档适配层；验收：纯 schema 推导不 import vscode，虚拟文档 provider 只装配展示；前置：IDE-SCH-001。（f9948ac;三面拆分 databaseSchema.ts 2627 行→①src/databaseSchemaCore.ts 纯推导核心(1416 行,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0181)
- [x] IDE-ARC-005 [P2] 为共享索引明确唯一生命周期所有者；验收：watcher、worker、缓存由装配层统一释放，provider 不私建第二套全仓服务；前置：IDE-EVT-012, IDE-SNP-001。(d5e3dd6;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0182)
- [x] IDE-ARC-006 [P2] 更新实际查询依赖图；验收：文档列出每个 provider 的数据源与允许副作用，未完成迁移明确标注；前置：IDE-ARC-005。(3d45357;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0183)

### IDE-RST · Rust 范围与迁移决策（P2）

来源：Rust 范围评审；R1/R2 已完成状态保留，R2.5/R2b 为按证据作出的条件决策。
- [x] IDE-RST-001 [P2] 修正 R1 的 Python 泛化结论；验收：保留 4.88 秒冷扫事实，并补普通变量 hover 的 51.27 秒反例和范围说明；前置：无。(6a8a553;R1 审计三处修正+新 §6 修正记录,原始数据行留档不改=§0「全量 Python 冷扫」行加范围限定(仅扫描/调度面,不得泛化到交互面,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0184)
- [x] IDE-RST-002 [P2] 拆开 Rust 骨架和正式 serving 状态；验收：提案逐项记录已存在的 server/shadow、未开放能力和切流门；前置：无。(094ea4c;提案 R3 行下挂四面状态拆分记录(骨架已存在≠迁移完成/已切流,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0185)
- [x] IDE-RST-003 [P2] 列出 R2 索引已经提供的字段；验收：分别列 AST、语义模型、公开索引接口，缺失字段不标现成输入；前置：无。(c81d6d9;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0186)
- [x] IDE-RST-004 [P2] 为 defAnalyzer 单独记录迁移取舍；验收：给出输入缺口、当前耗时、位置对拍范围和采纳/暂缓结论；前置：IDE-RST-003。(5363500;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0187)
- [x] IDE-RST-005 [P2] 为 messageTable 单独记录迁移取舍；验收：计入产品调用频率、types.xml/alias 配置和装配语义成本；前置：IDE-SDK-001, IDE-RST-003。（d372169;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0188)
- [x] IDE-RST-006 [P2] 为数据库纯推导记录迁移取舍；验收：同 URI/版本比较 TS 与 Rust 含 IPC 的总耗时，不以行数代替收益；前置：IDE-SCH-001, IDE-SCH-007, IDE-RST-003。（0493698;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0189)
- [x] IDE-RST-007 [P2] 为 defChain 单独记录迁移取舍；验收：对拍接口/组件/缺失文件/环语义，并量测 Parent hover 的 IPC 成本；前置：IDE-RST-003。（d666305;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0190)
- [x] IDE-RST-008 [P2] 为遗漏图派生候选建立范围表；验收：分别记录 defReferenceGraph、entityDependency、compositionRoots、entityFlowGraph 的输入与交互入口；前置：IDE-RST-003。（1e79cb6;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0191)
- [x] IDE-RST-009 [P2] 拆分 Python 编辑查询的耗时阶段；验收：分别输出解析、提交、MRO、查询耗时，覆盖普通变量 hover 的注解路径；前置：IDE-MET-003, IDE-HOV-010。（3f556e4;languageServiceMetrics 事件面 11→14 类,新三段与既有 document-parse(解析段,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0192)
- [x] IDE-RST-010 [P2] 形成 Python R2b 的继续或暂缓结论；验收：仅在修复后数据仍证明解析为主要成本时推进原型，否则记录暂缓依据；前置：IDE-RST-009, IDE-ACC-001, IDE-ACC-002。（e63b3c3;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0193)

### IDE-ACC · 真实编辑器逐场景验收（P1）

来源：细化现有 P0-4b/P0-4c/P0-4d；任何一场通过不替代其他场。
- [x] IDE-ACC-001 [P1] 验收普通变量冷 hover；验收：真实编辑器覆盖大文件无注解场景，记录命中与空结果耗时及读盘量；前置：IDE-HOV-010, IDE-MET-003, IDE-REL-006。（32d2167;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0194)
- [x] IDE-ACC-002 [P1] 验收注解缓存过期后的重复 hover；验收：超过原 TTL 再悬停，确认不重扫全仓并记录事件循环延迟；前置：IDE-HOV-012, IDE-ACC-001。（3febf27;plainVariableHover 真机套件扩第 2 例(TTL=3s pythonReturnTypeInference.ts:28 真等越期,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0195)
- [x] IDE-ACC-003 [P1] 验收首次事件 CodeLens 的大仓行为；验收：冷启动普通文件不打开全仓文档，事件文件结果有真实命中断言；前置：IDE-EVT-012, IDE-MET-004。（f57878c;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0196)
- [x] IDE-ACC-004 [P1] 验收多根同名实体跳转；验收：真实编辑器分别从 A/B 根跳转，目标、签名与 hover 都属于正确根；前置：IDE-IDX-003, IDE-IDX-012, IDE-IDX-013。（ed445fd;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0197)
- [x] IDE-ACC-005 [P1] 验收新增文件后的首次导航；验收：真实编辑器中新建实现文件后首次跳转命中，不依靠重载窗口；前置：IDE-IDX-007, IDE-SNP-005。（53f9413;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0198)
- [x] IDE-ACC-006 [P1] 验收连续输入后的补全与诊断；验收：输入风暴结束后只显示最新版本结果，宿主延迟和待处理量回落；前置：IDE-DIA-005, IDE-DIA-006, IDE-NAV-016。（04e0322;runTest.ts 新 --storm 模式:StormEntity def 把 mA/mB 都声明在 BaseMethods+属性 hp,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0199)
- [x] IDE-ACC-007 [P1] 验收 hover/导航取消后的收敛；验收：实际取消后记录残留任务数与新增 IO，共享扫描继续且请求独占任务停止；前置：IDE-MET-008, IDE-BUD-008。（806ccac;新真机套件 hoverCancelConverge.test.ts 挂 --field 过滤(取消梯次本体 fieldBaseline 已覆盖,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0200)
- [x] IDE-ACC-008 [P1] 验收与 Python 语言服务共同启用；验收：同机同项目比较启用/禁用与单一 Kode ID，分别归因两套服务成本；前置：IDE-PRJ-005, IDE-REL-001。（27994b5;新 --attribution 真机模式(runTest.ts 与 --field 共用同一工作区装配=demo 资产+5000 文件外部根,同机同项目口径;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0201)
- [x] IDE-ACC-009 [P1] 验收长会话资源边界；验收：固定编辑/打开关闭序列记录 RSS、worker 队列和缓存容量，不只看一次热查询；前置：IDE-RES-002, IDE-RES-004, IDE-RES-008。（4903388;新 --longsession 真机模式(runTest.ts 与 --field 共用装配=demo 资产+5000 文件外部根;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0202)
- [x] IDE-ACC-010 [P1] 按场景纠正最终完成标记；验收：逐项列通过/失败/未测；热态 Hover P95≤30ms、Definition P95≤50ms 分别判定，现场未复现事项保留开放；前置：IDE-ACC-001, IDE-ACC-002, IDE-ACC-003, IDE-ACC-004, IDE-ACC-005, IDE-ACC-006, IDE-ACC-007,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0203)
- [x] IDE-ACC-011 [P1] 验收删除文件后的导航清理；验收：真实编辑器删除实现文件后，定义与实现列表均不再返回旧路径；前置：IDE-IDX-007, IDE-SNP-005。（1295988;验收本身抓到并修掉真 bug:entityMapping 六处 watcher pattern 用 Uri.joinPath(folder.uri,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0204)
- [x] IDE-ACC-012 [P1] 验收文件重命名后的目标迁移；验收：真实编辑器重命名后只返回新 URI，引用列表不存在重复新旧目标；前置：IDE-IDX-007, IDE-SNP-005。（a76af73;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0205)
- [x] IDE-ACC-013 [P1] 验收未保存编辑与放弃编辑的导航；验收：编辑时跳到脏缓冲区位置，放弃修改并关闭后恢复磁盘位置；前置：IDE-SNP-005。（fc8737b;验收首跑抓到真缺口:def→python F12 宿主内主臂=映射索引(resolveMethodImplementationByIdentity,扫描期磁盘行),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0206)

## 2026-10-29 复审修正 · IDE-REV 原子任务

本节整理本轮代码与证据复审，基线为 `d845d06`，资源验收另检查 `4903388`/`be602c0`。后续 `1295988`/`a76af73` 的删除/重命名工作不属于本轮复审结论；不因本节登记撤销其完成标记。

新增 **38 项**：P0 6 项、P1 18 项、P2 14 项。每项只交付一个行为，完成一项后单独验证、提交、推送，再推进下一项。原条目保留已有提交与测量历史，复审重开表示尚未满足完整验收；新项完成不自动批量关闭原条目。建议先处理 IDE-REV-001，再处理 IDE-REV-006～010 的性能/一致性问题。

| 复审结论 | 已有依据与边界 | 执行项 |
| --- | --- | --- |
| Python 索引可能被旧回包覆盖 | 同步解析写入 v2 后，同版本通知提前返回，旧 v1 worker 仍通过 revision 守卫；已确定性复现 | IDE-REV-001 |
| 调试取消范围过大、晚到会话可能残留 | 无参数 stopDebugging 停止全部会话；守卫忽略迟到成功 | IDE-REV-002～003 |
| readiness 等待不完整 | probe 挂起时取消/超时不打断，晚到 true 可标 running；已复现 | IDE-REV-004～005 |
| 注解重建事件回放只覆盖首次扫描 | 已有缓存时不向在途重建登记增量，TTL 发布可能覆盖保存/删除/重命名；保存竞态已复现，删除/重命名须分别锁定反例 | IDE-REV-006～008 |
| 大文件仍有宿主同步入口 | receiver 首次让路前可同步解析；首次 hover 提取约 889KB 样本约 129.5ms，心跳未运行（单次定位数据，非验收基线） | IDE-REV-009～010、035～037 |
| schema 冷/热路径仍有同步工作 | 冷 miss 同步耗尽生成器；热命中已零读取（IDE-REV-011 事件面失效收口）；延后执行的全实体构建仍占宿主 | IDE-REV-012～013 |
| 数据库辅助模块未形成产品闭环 | registry/preview/lifecycle/source/impact/evidence 未接实际命令；永不完成查询超时后 closeCount=0 已复现 | IDE-REV-014～020 |
| 热更新辅助模块未形成产品闭环 | 实际入口仍只更新 sent_unverified；状态仓、回执、applied、聚合与重试等缺接线；保留已满足语义的 IDE-HOT-002 勾选 | IDE-REV-021～027 |
| 量规和验收存在盲区 | 注解 pending 不含执行中；取消样本可全部由预取消满足；长会话缺 worker/容量实测，8 轮 RSS 净增约 114.9MiB，不能据此判定泄漏或稳定 | IDE-REV-028～037 |
| R2b 暂缓判断需修正证据 | 暂缓 Rust 方向可保留，但“大文件解析全部退出宿主”依据不成立；先补调用路径与现场数据 | IDE-REV-038 |

复审测试边界：隔离基线快照全套最初为 4023 通过、1 失败、9 跳过；唯一失败由 archive 缺少 Git 元数据导致，恢复基线 Git 身份后该测试文件 4 项通过。此结果不覆盖随后其他 agent 的提交，也不等于已重跑真实编辑器验收；后者本轮仅核对测试代码与已存日志。共享快照、事件增量、首次扫描事件回放等已落地修复继续保留，不重复挂账。

- [x] IDE-REV-001 [P0] 统一 Python 解析入口的版本代守卫；范围/验收：src/pythonClassIndex.ts：syncDocumentParse 写入新版本时同步推进 revision/当前文档身份，所有异步提交核对同一令牌。验收：门住 v1 worker，先同步发布 v2 再触发同版本编辑通知，释放 v1 后仍为 v2；再覆盖 v3 和同版本去重；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0207)
- [x] IDE-REV-002 [P1] 调试取消只停止本次 attach 会话；范围/验收：src/debugConfig.ts：以明确的 DebugSession 停止本次连接，避免无参数 stopDebugging 停止全部会话。验收：并行存在无关会话，取消/超时当前 attach 后无关会话仍运行；原项：IDE-DBG-007；前置：无（本项用于修复已重开的原项，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0208)
- [x] IDE-REV-003 [P1] 清理超时后才创建成功的 attach 会话；范围/验收：src/debugAttachGuard.ts：超时/取消后迟到的成功结果关联到本次会话并清理一次。验收：延迟 start 成功不遗留新会话、不二次提示、不触碰其他会话；迟到拒绝无未处理异常；原项：IDE-DBG-007；前置：IDE-REV-002。(705e557;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0209)
- [x] IDE-REV-004 [P1] 阻止 readiness 探测晚到后误标 running；范围/验收：src/processManager.ts：probe 返回后复核取消与截止时间。验收：probe 挂起期间取消或超时，随后返回 true 仍报告对应 target 的取消/超时，状态不进入 running；原项：IDE-RUN-004；前置：无（本项用于修复已重开的原项，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0210)
- [x] IDE-REV-005 [P1] 给永久挂起的 readiness probe 设置等待边界；范围/验收：src/processManager.ts：等待 probe 本身参与截止/取消竞速。验收：probe 永不结束时启动等待也按时退出，清理计时器和订阅，其他 target 可继续；晚到结果不改变终态；原项：IDE-RUN-004；前置：IDE-REV-004。(f453491;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0211)
- [x] IDE-REV-006 [P0] 保留 TTL 重建期间的保存注解事件；范围/验收：src/pythonReturnTypeInference.ts：已有缓存时仍把保存事件记录到在途 annotationBuilds，并立即更新已发布桶。验收：预热→TTL 过期→门住旧内容读取→保存新注解→释放重建，新快照只含新值，单文件保存不重读其他文件；原项：IDE-HOV-012；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0212)
- [x] IDE-REV-007 [P0] 保留 TTL 重建期间的删除注解事件；范围/验收：已有缓存与在途重建并存时记录删除事件。验收：预热并门住 TTL 重建，删除后释放旧读取，来源不复活；其他同名来源保留，删除本身不重扫；原项：IDE-HOV-014；前置：无（本项用于修复已重开的原项，不以前者重新关闭为前提）。(3523262;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0213)
- [x] IDE-REV-008 [P0] 保留 TTL 重建期间的重命名注解事件；范围/验收：已有缓存与在途重建并存时记录迁移事件。验收：门住旧路径读取后重命名，发布后旧模块不再命中、新模块可查、来源不重复；覆盖连续保存/重命名事件顺序；原项：IDE-HOV-015；前置：无（本项用于修复已重开的原项，不以前者重新关闭为前提）。(25739d6;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0214)
- [x] IDE-REV-009 [P0] 移除 receiver 异步诊断入口的整文件同步解析；范围/验收：src/extension.ts 与 receiverNoneDiagnostics.ts：诊断消费异步共享解析，审计首次 yield 前的调用发现和上下文构建，避免 syncDocumentParse 绕过大文件 worker。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0215)
- [x] IDE-REV-010 [P0] 移除首次 hover 的整文件同步注解提取；范围/验收：src/pythonReturnTypeInference.ts：resolveLocalVariableReturnTypeFromSnapshotImpl 只查询已发布文档桶，冷版本通过受控异步更新发布。验收：大文件首次 hover、编辑后立即 hover 均不调用同步整文件提取，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0216)
- [x] IDE-REV-011 [P1] 让 schema 热命中校验不读取输入文件内容；范围/验收：src/databaseSchema.ts：peekFreshSchemaCache 的新鲜度校验使用共享版本/失效事件。验收：预热后重复属性查询返回同代快照，监测 .def/types.xml 的同步与异步读取均为零；文件变更后正确失效；原项：IDE-SCH-007；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0217)
- [x] IDE-REV-012 [P1] 让属性 hover 冷 schema 查询只读已发布结果；范围/验收：src/databaseSchema.ts：交互 cache miss/失效只调度后台构建，不同步跑完生成器。验收：冷/失效属性 hover 无整套 schema 同步构建，构建期间可响应取消，发布后字段说明正确；原项：IDE-SCH-006、IDE-SCH-007；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0218)
- [x] IDE-REV-013 [P1] 拆分 type storage 冷索引的实际计算阶段；范围/验收：src/databaseSchema.ts：scheduleTypeStorageUsageColdBuild 不在单个 setImmediate 回调内同步遍历全部实体；逐实体及大输入阶段按预算让路并检查取消。验收：在真实构建中途取消停止后续工作，记录最大连续阻塞，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0219)
- [x] IDE-REV-014 [P1] 修复永久挂起数据库查询的连接释放；范围/验收：src/databaseQueryLifecycle.ts：超时/取消能终止实际查询并在有限时间释放或销毁连接，不等待永不结束的 running。验收：永不 resolve 的查询也结束等待且关闭一次，晚到成功/失败不重复释放，不遗留轮询；原项：IDE-DB-003；前置：无（本项用于修复已重开的原项，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0220)
- [x] IDE-REV-015 [P2] 将 profile 连接注册表接到真实数据库命令；范围/验收：接入 databaseConnectionRegistry，定义切换/释放生命周期。验收：从注册命令执行两项目查询，连接配置与结果隔离；命令级测试能捕获漏接注册表；原项：IDE-DB-001；前置：无（本项用于修复已重开的原项，不以前者重新关闭为前提）。(7e9d547;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0221)
- [x] IDE-REV-016 [P2] 提供可实际打开的单表只读预览入口；范围/验收：将 databaseTablePreview 接到命令与结果展示。验收：用户选择表后看到限量结果，实际执行查询受白名单约束，取消选择不发查询；原项：IDE-DB-002；前置：IDE-REV-015。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0222)
- [x] IDE-REV-017 [P2] 把查询取消与超时接到实际数据库入口；范围/验收：把 databaseQueryLifecycle 接入预览及 drift 查询，配置和用户取消令牌传到底层。验收：真实命令触发慢查询，取消/超时返回并释放连接，界面反馈对应原因；原项：IDE-DB-003；前置：IDE-REV-014、IDE-REV-016。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0223)
- [x] IDE-REV-018 [P2] 把数据库结果列来源接到可点击导航；范围/验收：将 databaseColumnSource 接入实际结果展示。验收：点击推导列打开正确 def/type 行，未知合成列明确说明且不跳错误位置；原项：IDE-DB-004；前置：IDE-REV-016。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0224)
- [x] IDE-REV-019 [P2] 把单实体 schema 影响计算接到预览命令；范围/验收：将 databaseSchemaImpact 接入实体选择与只读报告。验收：从命令看到新增/移除/类型变化，对应实际选中实体，全程无 DDL/写库；原项：IDE-DB-005；前置：无（本项用于修复已重开的原项，不以前者重新关闭为前提）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0225)
- [x] IDE-REV-020 [P2] 把 drift 证据保存接到真实查询报告；范围/验收：将 databaseDriftEvidence 接入 drift 命令，记录引擎版本与实际/模拟来源。验收：真实执行结果能保存并重新查看，未知版本不宣称兼容，模拟证据不冒充联调结果；原项：IDE-DB-006；前置：IDE-REV-015。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0226)
- [x] IDE-REV-021 [P2] 把热更新目标状态仓接到真实发送入口；范围/验收：将 hotReloadTargetState 接入 src/hotReload.ts，每次发送以 rootId/targetId 更新状态。验收：同文件两个实例结果独立，切目标不复用上一目标成功态；保留无回执时 sent_unverified 的真实语义；原项：IDE-HOT-001；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0227)
- [x] IDE-REV-022 [P2] 把 accepted 回执解析接到单目标发送结果；范围/验收：将 hotReloadReceipt/Delivery 接入实际响应处理。验收：只有已记录且已核验的回执进入 accepted，未知响应保持未确认；缺协议证据时该项保持开放；原项：IDE-HOT-003；前置：IDE-REV-021。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0228)
- [x] IDE-REV-023 [P2] 把 applied 证据核验接到目标状态；范围/验收：将 hotReloadAppliedCheck 接入实际核验流程。验收：可信 revision/digest 或验证回执才能进入 applied，过期/未知证据及核验超时均不显示已应用；缺运行时协议则记录阻塞条件；原项：IDE-HOT-004；前置：IDE-REV-022。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0229)
- [x] IDE-REV-024 [P2] 在实际热更新入口阻止结构性 def 自动发送；范围/验收：将结构变更判断接入实际文件发送链。验收：序列化/RPC 参数结构变化提示需重启，实际发送器未收到普通 reload；非结构 Python 更新仍可发送；原项：IDE-HOT-005；前置：IDE-REV-021。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0230)
- [x] IDE-REV-025 [P2] 把多目标热更新结果聚合接到展示入口；范围/验收：将 hotReloadBatchSummary 接入多目标执行结果。验收：一成一败时显示 partial 并可查看每个目标原因，不以最后一个结果覆盖整批；原项：IDE-HOT-006；前置：IDE-REV-023。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0231)
- [x] IDE-REV-026 [P2] 把失败目标重试接到实际重试操作；范围/验收：将 hotReloadRetry 接入操作入口与取消令牌。验收：只重试失败目标，已确认成功目标发送次数不增加，取消后不发送后续目标；原项：IDE-HOT-007；前置：IDE-REV-025。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0232)
- [x] IDE-REV-027 [P2] 把热更新 revision 来源接到实际状态展示；范围/验收：将 hotReloadRevisionEvidence 接入状态/详情。验收：本地 fileHash、semanticHash、engineDigest 明确标注来源，用户能从真实发送结果查看，不互相冒充；原项：IDE-HOT-008；前置：IDE-REV-023。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0233)
- [x] IDE-REV-028 [P1] 准确统计排队和执行中的文档注解更新；范围/验收：src/pythonReturnTypeInference.ts：待处理量覆盖 pending 与 inflight，旧任务 finally 不删除同文件的新任务记录。验收：门住异步提取时仍显示在途，同文件重叠版本分别结束后归零；原项：IDE-MET-008；前置：无（本项用于修复已重开的原项，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0234)
- [x] IDE-REV-029 [P1] 导出注解索引重建在途量 ✔ 2026-10-30 feat 2eac87a（共享构建 running/waiting/cancelled 接入现场报告 `注解索引构建=运行N/等待M/已全取消K`;冷构建与 TTL 重建门住可见、发布/取消收尾归零;取消归属=共享构建只认全体取消;与 REV-028 独占任务分账;tests/annotationBuildWorkload.test.ts 5 例 5 绿,prove-red 1/3/1 红;锚点 9 处 +1 滚动锁步）
- [x] IDE-REV-030 [P1] 导出 worker 队列及字节占用 ✔ 2026-10-30 feat 5adf26a（worker 实测面 `getPythonParserWorkerGauge` 接入现场报告 `worker=运行N/排队M`+`worker排队字节=B/预算/峰值/超预算拒`;挂起 worker 在途可见、超预算排队=31 份顶格+9 拒可辨、恢复归零而峰值/拒绝计数留史;字节与 MAX_QUEUED_PARSE_BYTES 同口径不做第二套估算;非 indexTasksQueued 替代——量规读 worker 宿主自身派发队列;tests/pythonParserWorkerGauge.test.ts 5 例 5 绿,prove-red 1/1/1 红;unit 4325|7/demo 25 RC=0）
- [x] IDE-REV-031 [P1] 导出缓存实际容量与上限 ✔ 2026-10-30 feat 9107305（三缓存容量面接入现场报告:def 文档=条目/上限8/utf8 实测字节/8MiB 预算,schema 快照=条目/LRU32,注解索引=按根条目+TTL3000ms 且口径注明无字节估算;填充/淘汰可核对(填到上限、越线 LRU 回落、清空归零);量规无 hits 字段、渲染无 cacheHits,不把累计命中当容量;tests/cacheCapacityGauge.test.ts 4 例 4 绿,prove-red 1/2/1 红;锚点 +3 滚动锁步;unit 4329|7/demo 25 RC=0）
- [x] IDE-REV-032 [P1] 真实取消执行中的 hover 并验证收敛 ✔ 2026-10-30 feat 50e1002（languageProviders 在途闸(入口守卫后、结果产出前,生产 null)+probeHoverGatedCancel 门内斩探针:settledBeforeCancel 斩后定格=false 证「完成前」;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0235)
- [x] IDE-REV-033 [P1] 补齐执行中导航取消验收 ✔ 2026-10-30 feat 97c00c1（PythonDefinitionProvider 在途闸(入口守卫后,async 门内 await+放行后重查 token=零后续工作/无晚到结果发布)+probeDefinitionGatedCancel;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0236)
- [x] IDE-REV-034 [P1] 重做有实际资源量规的长会话验收；范围/验收：固定并记录暖机/正式阶段、持续时长、编辑与打开关闭序列；包含大文件实际编辑，逐轮采集 RSS、worker 队列/字节与缓存占用。验收：预先写明资源预算与稳态判据并扩大观察窗口，保留旧 8 轮数据；不得仅抬高阈值使现有曲线通过，单轮增长不直接判定泄漏；原项：IDE-ACC-009；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0237)
- [x] IDE-REV-035 [P1] 增加大文件当前文档内 hover 验收；范围/验收：在超 256KiB 当前 .py 内测首次及编辑后立即 hover，分别记录命中、耗时与最大宿主阻塞。验收：场景确实经过当前文档注解路径；与小调用方引用大外部文件的原场景分别报告；原项：IDE-ACC-001、IDE-ACC-002；前置：IDE-REV-010。（701da69;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0238)
- [x] IDE-REV-036 [P1] 修正短查询事件循环采样方法 ✔ 2026-10-30（7d6207f;短查询周边事件循环采样重建为四段法:开 monitorEventLoopDelay(1ms 分辨率)→100ms 预热(采样器前几跳落真实事件循环条件)→histogram.reset()→10ms 落定拍→被测查询→200ms 查询后窗(循环尾部工作纳入样本)→关;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0239)
- [x] IDE-REV-037 [P1] 补齐关闭文件注解 TTL 的交互验收 ✔ 2026-10-30（b045b66;缺口=既有过期 hover 例(acc002)悬停的注解在同一打开文档,文档桶跨 TTL 存活,磁盘快照 TTL 路径从未被走到;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0240)
- [x] IDE-REV-038 [P2] 修正 Python R2b 暂缓结论的证据边界；范围/验收：更新 docs/review/2026-10-29-python-r2b-decision.md：列出 syncDocumentParse 与首次 hover 同步提取漏口，区分已测场景与未测大当前文档。验收：不再声称所有大文件解析已退出宿主；暂缓/推进只按修复后的真实成本判断，缺数据标未测，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0241)

## IDE-GIT · 文件与选中范围历史（2026-10-29 用户需求，默认开启、按需查询）

目标：提供类似 TortoiseGit 的文件修改历史，并能沿选中代码范围查看修改者、提交时间、提交说明和对应差异。仓库当前未发现专用 Git 历史模块。本组排在性能/索引正确性修复之后，不接入 hover、补全或诊断热路径。

界面约定（用户已确认）：资源管理器文件右键、编辑器标签页右键和命令面板提供「Kode：查看文件历史」；编辑器有选区时右键提供「Kode：查看选中范围历史」，命令面板亦可调用并允许用户绑定快捷键。命令打开 Kode 侧边栏中的历史视图，按当前查询对象展示作者、时间、提交说明及分页操作；点击提交在主编辑区打开只读差异，范围历史定位该次修改的历史代码段。视图标题显示文件/范围及基准提交，选区查询固定发起时的上下文；切换文件或选区不自动重查。仅展开侧边栏不扫描仓库，无查询时显示操作引导。

用户约束（2026-10-29 更新）：**默认开启、按需查询**。计划配置 `kbengine.gitHistory.enabled=true`；开启只提供入口，不在激活、打开文件、移动光标或选区变化时运行 Git，不预取历史、不挂历史专用监听、不新增常驻轮询。用户打开历史面板才启动查询；关闭功能时不启动 Git 子进程或历史任务。历史只涵盖本地可用的 Git 提交；未提交内容、浅克隆缺失历史、复制/移动或合并产生的追踪歧义必须明确说明，不能把 blame 的最后修改者当成完整修改时间线。

- [x] IDE-GIT-001 [P2] 声明默认开启的历史功能开关；验收：配置 schema 默认 true，中英说明一致；新安装可见入口但未查询时 Git 调用数为零，关闭后隐藏入口且直接调用命令也不运行 Git；前置：无。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0242)
- [x] IDE-GIT-002 [P2] 按文件定位所属 Git 仓库；验收：多工作区、嵌套仓库与 worktree 各用正确仓库，非 Git 文件给出明确反馈，Git 不可用时有可操作提示；只在启用后的请求中定位；前置：IDE-GIT-001。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0243)
- [x] IDE-GIT-003 [P2] 封装可取消且有界的只读 Git 执行器；验收：使用参数数组、明确 cwd 和路径边界，空格/中文/特殊文件名不变成命令；超时、取消、输出超限均终止对应子进程并释放资源，无阻塞式进程调用；前置：IDE-GIT-002。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0244)
- [x] IDE-GIT-004 [P2] 查询单文件的分页提交记录；验收：输出提交标识、作者身份、作者时间、提交时间及说明，按稳定顺序分页不重复不漏项；默认每页 50 条且可设硬上限，首屏不预读全部 diff/文件内容；未跟踪文件和空历史明确呈现，初次查询不无界加载全部日志；前置：IDE-GIT-003。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0245)
- [x] IDE-GIT-005 [P2] 提供文件历史列表入口；验收：资源管理器文件右键、编辑器标签页右键及命令面板均能以「Kode：查看文件历史」打开正确文件；在 Kode 侧边栏历史视图呈现作者、时间和说明及下一页；标题明确文件与基准提交，无查询时显示引导且零 Git 调用；关闭功能时入口与查询均不活跃；前置：IDE-GIT-004。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0246)
- [x] IDE-GIT-006 [P2] 打开历史版本并比较对应修改；验收：点击侧边栏提交记录在主编辑区打开该版本与父版本的只读 diff，并提供只读打开该版本内容的操作；根提交、删除文件及无内容版本明确处理；不覆盖工作区文件，虚拟文档按仓库/提交/路径隔离；前置：IDE-GIT-005。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0247)
- [x] IDE-GIT-007 [P2] 沿文件重命名追踪历史路径；验收：重命名前后的提交均可查看且打开对应旧路径内容，多仓库同名文件不串历史；无法确定的复制/移动明确提示边界；前置：IDE-GIT-006。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0248)
- [x] IDE-GIT-008 [P2] 把编辑器选区映射到已提交行范围；验收：支持单行与多行选区，覆盖插入/删除导致的偏移；未保存/未提交新增行不能准确映射时明确提示或要求选择已提交版本，不将当前行号直接当 HEAD 行号；前置：IDE-GIT-003。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0249)
- [x] IDE-GIT-009 [P2] 查询范围的逐提交修改时间线；验收：跟随选区对应历史行段的变更，前置插行后仍能找到之前修改，列出多次修改的作者与时间；合并/重命名/无法追踪的边界如实标注，不以当前 blame 结果冒充完整历史；前置：IDE-GIT-007、IDE-GIT-008。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0250)
- [x] IDE-GIT-010 [P2] 展示选区历史并定位该次修改；验收：选中代码后右键或从命令面板执行「Kode：查看选中范围历史」，侧边栏显示对应范围时间线，点击条目在主编辑区打开对应版本 diff 并定位历史范围；展示查询基准提交与原选区，切换编辑器不会错套选区且不自动重查；无选区时右键不展示范围入口，直接调用命令给出选择代码的提示；两类命令均可绑定用户快捷键；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0251)
- [x] IDE-GIT-011 [P2] 收敛历史查询与缓存生命周期；验收：同查询合并；全扩展历史 Git 子进程并发上限 2，其中高成本范围追踪最多 1 个，等待队列有界且重复选区只保留最新请求；缓存按仓库/提交/路径/范围/查询选项隔离并限制条目数与字节，提交内容缓存可复用、日志页显式刷新重新获取 HEAD；关闭视图/禁用配置/卸载后请求独占查询及时取消并清理对应资源，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0252)
- [x] IDE-GIT-012 [P2] 验收历史功能对宿主与语言服务的影响；验收：真实编辑器分别测关闭、默认开启未查询及查询大历史三种状态，在同机同项目交替重复采样；记录历史模块 Git 调用数、进程/任务量、缓存字节、宿主最大延迟及 hover/导航 P95；默认开启未查询的 Git 调用/历史任务必须为零；历史查询不得同步阻塞宿主，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0253)

## IDE-PDBG · 进程调试与性能分析（2026-10-29 用户需求，本地+远程）

目标：把进程级调试与性能分析做成真实可用的闭环。现状（src/debugConfig.ts）：`kbengine.debug.start` 是「telnet 提示弹窗 → 自有进程选择器 → debugpy 按 PID 附加」，`kbengine.debug.attach` 直接进程选择附加，`kbengine.debug.attachRemote` 只连设置里静态声明的 debugpy 端口。用户需求：调试区分**端口模式**（配置了 debugpy 端口直接 connect 附加）与**进程附加模式**（未配置时走附加界面选进程）；未配置首次提示选择模式并记住；端口模式先探端口，未开再查 debugpy 安装、未装提示安装；进程树 debug 图标后加**性能分析图标**（py-spy attach 目标进程，未安装先自动安装，装失败弹窗）；**远程服务器管理界面**（不只本地进程：读 ssh/config 主机、支持跳板机、默认本地 ssh，debug.json 声明连接方式），debug 与 py-spy 都能对远程进程执行；文档写清两种调试模式、debugpy 需在代码中启用监听（`debugpy.listen(port)` 埋点，引擎 Python 3.7.3 嵌入式进程不含内置监听）、远程连接与跳板配置。红线不变：只读优先、连不上如实降级不假成功、装不上如实弹窗不静默。

用户约束（2026-10-29）：①py-spy 图标位置在 debug 图标之后；②py-spy 未安装先自行安装（常规途径），安装失败弹窗提示；③调试未配置端口时第一次提示选择模式（端口/进程附加），选择被记住；④端口模式端口未开 → 检测 debugpy 未装 → 提示安装；⑤远程以 ssh/config 为主（跳板机可能需要），默认本地 ssh，连接方式在 debug.json 中按环境声明；⑥以上全部写进文档。

- [x] IDE-PDBG-001 [P1] 调试入口区分端口模式与进程附加模式；范围/验收：debug.json 组件配置加 debugpyHost/debugpyPort（缺省未配置）；`kbengine.debug.start`/`attach` 按配置分派：已配端口走 connect 附加（不再弹进程选择），未配端口首次弹模式选择（端口/进程附加，workspaceState 记住，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0254)
- [x] IDE-PDBG-002 [P1] 端口模式前置探测：端口开没开 + debugpy 安装提示；范围/验收：connect 附加前 TCP 探测 debugpy 端口；未开时检测目标 Python 环境是否装有 debugpy（本地走既有 debugpyPreflight 面），未装弹提示安装（给出一键安装动作与手装指引），装完/端口开了再附加。验收：端口通则直接附加零多余弹窗；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0255)
- [x] IDE-PDBG-003 [P1] 进程树 debug 图标后加性能分析图标（py-spy）；范围/验收：serverControl 树 view/item/context inline 组 debug 图标之后加 py-spy 入口（$(pulse) 级图标）；点击对目标组件进程跑 py-spy dump 出调用栈到输出通道（进程选择复用既有选择器）；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0256)
- [x] IDE-PDBG-004 [P1] 远程服务器管理视图与连接方式声明；范围/验收：新增远程服务器管理视图（读 ~/.ssh/config 主机列表 + 手动添加，支持跳板链说明与默认本地）；.kbengine/debug.json 按环境声明连接方式（默认 local ssh）；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0257)
- [x] IDE-PDBG-005 [P2] 远程进程枚举与选择对齐；范围/验收：远程目标的进程选择器列出远端进程（ssh ps），组件名匹配置顶口径与本地一致；远端取不到进程清单如实提示。验收：远程 py-spy/调试可从远端进程清单选 PID；本地与远程选择器行为一致；prove-red=远端清单缺失时误走本地清单用例红；前置：IDE-PDBG-004。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0258)
- [x] IDE-PDBG-006 [P1] py-spy 探测/执行按所选解释器定位入口（2026-10-30 用户实测反馈：反复提示安装 py-spy，按提示装好后在 venv 里可正常执行，扩展仍提示未装）；根因：`checkPyspyInstalled`/`runPyspyDump` 只探扩展宿主 PATH 上的裸 `py-spy`，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0259)

## 2026-10-30 用户反馈 · 快速执行终端口径待对齐

- [x] QACT-TERM [P2] 快速执行脚本动作的终端展示口径与用户实测不一致（2026-10-30 用户反馈：实测「还是弹窗、在新的 terminal 中执行」；当前 main 代码为 `hideFromUser: true` 隐藏可复用终端、从不 `terminal.show()`，2026-10-21 e6fd3a0 起生效）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0260)
- [x] PY-ENV [P1] 虚拟环境目录不写死（2026-10-30 用户反馈：同事各有 .kbenv/.venv/venv，环境不能写死）。窄面已做：快速执行动作 venv 自动查找按设置 `kbengine.python.venvDirectories`（默认 ['.venv','venv','.kbenv']，单段目录名防逃逸）在动作目录与配置根逐名探测，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0261)
- [x] TYP-ARRAY [P1] def 属性访问的类型推导与数组元素类型（2026-10-30 用户反馈：def 已定义 `equip_track_list` 类型 EQUIP_TRACK_LIST，py 中 `self.equip_track_list` 仍是 Any；EQUIP_TRACK_LIST 是 list，取出元素应能推导元素类型而不是 Any）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0262)
- [x] NAV-REF-PROP [P2] def 属性 Shift+F12 具体场景核对（2026-10-30 用户反馈补充：def 定义 `equip_track_list`（类型 EQUIP_TRACK_LIST），Shift+F12 应能找到 py 中 `self.equip_track_list` 使用处）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0263)
- [x] IFACE-MERGE [P1] `<Interfaces>` 成员并入宿主实体面（2026-10-30 用户令：def 中 `<Interfaces>` 定义的属性和方法绑定到当前 def 对应的对象上）。引擎语义：接口 def 的 Properties/三方法段并进声明它的实体。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0264)
- [x] RCV-GUARD [P1] receiver None 守卫两处用户反馈（2026-10-30 用户令）：①quick fix 应优先出「包裹式」守卫——`if self.<receiver>:`（真值判定即可，用户：不必 `is not None`）包住当前语句与后续同级块并整体缩进一级、继续执行（用户：这才是常见操作），… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0265)

## 2026-10-30 深度复审 · IDE-AUD 与源码驱动 lint

依据：[完成状态与运行链路深审](docs/review/2026-10-30-completion-and-lint-audit.md)、[KBEngine lint 规则规范](docs/zh/guide/kbengine-lint-rules.md)。固定基线 bf26cbf；15 个 IDE 已勾选细项及 1 个历史 JSONC 条目有明确反例或验收缺口而重开。其他项是否复审通过见逐项 CSV，未评估不能当通过。一次实现一个行为，完成即独立验证、提交、推送；保留原标记的历史证据，不以其他 agent 的未提交改动作为完成依据。

- [x] IDE-AUD-001 [P1] 修复超时 attach 的迟到会话清理；验收：追踪订阅不在闸返回时提前释放；超时后才创建会话、再 resolve start，恰好停止本次会话一次且无订阅残留；卸载仍能释放；关联：IDE-REV-003。 c647fdf
- [x] IDE-AUD-002 [P1] 用每次尝试唯一身份关联调试会话；验收：两个相同显示名称的 attach 并发，取消其中一个仅停止对应会话；不同 workspace/同名启动不误认；关联：IDE-REV-002。已修(8467f88)——startAttachGuarded 每次尝试生成唯一 __kodeAttachId(模块级递增 attachAttemptSeq),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0266)
- [x] IDE-AUD-003 [P1] 将 SSH 隧道存活绑定真实调试会话；验收：startDebugging 成功后隧道仍存活，会话终止才关闭；启动失败/取消/卸载也关闭，覆盖真实会话生命周期而非仅 Boolean 返回；关联：IDE-PDBG-004。已修(3636645)——attachViaTunnel 弃 finally 拆隧道,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0267)
- [x] IDE-AUD-004 [P1] 阻止远端 PID 调试静默走本地；验收：远端选择时提供实际可工作的远端 attach 链；暂不支持则明确拒绝，绝不把本地 PID 列表当远端；远端 py-spy 与调试分别验收；关联：IDE-PDBG-005。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0268)
- [x] IDE-AUD-005 [P1] 给热更新发送与回执加入代际守卫；验收：同根/目标/文件连续发送，门住第一次核验，第二次失败后释放第一次，状态仍是第二次失败；旧超时和回执不改新记录；关联：IDE-REV-021、IDE-REV-023。（cd7b47c:台账按发送代际写回——HotReloadDeliveryRecord 加 attempt,每次新发送推进一代;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0269)
- [x] IDE-AUD-006 [P1] 冻结本次热更新的内容核验基准；验收：发送前保存内容/revision/hash，响应后改文件也不读取新版本冒充所发版本；所有回执核验使用本次基准；关联：IDE-REV-023。（c82f540:核验基准改在发送时点冻结——fire 路径与重发路径都在 runAction 之前发起内容读取算 sha256 存本轮 baselineReads map,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0270)
- [x] IDE-AUD-007 [P1] 补齐 accepted/applied 真实协议证据；验收：登记接收端版本/实现、请求、响应与所应用 revision/digest；模拟 JSON 只能验解析器，缺服务端依据维持未确认并保持原项开放；关联：IDE-REV-022、IDE-REV-023。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0271)
- [x] IDE-AUD-008 [P1] 使数据库缓存随连接配置代失效；验收：同 profile 的 host/port/database/user 等有效身份变化后不命中旧结果；旧连接的晚到结果不可重新污染新代，切换往返验证；关联：IDE-REV-015。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0272)
- [x] IDE-AUD-009 [P1] 让预取消及晚到数据库结果尊重终态；验收：预取消时不建连/不执行 query；等待期间取消或超时后即使查询晚到成功也不标 completed，释放恰一次；关联：IDE-REV-017。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0273)
- [x] IDE-AUD-010 [P1] 清理数据库会话初始化失败的连接；验收：mysql.createConnection 成功、SET READ ONLY 抛错/挂起时关闭或销毁连接并报原始原因；不用仅保护工厂返回后的 executor；关联：IDE-REV-017。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0274)
- [x] IDE-AUD-011 [P1] 把数据库来源导航限定到当前连接资产根；验收：两项目有同名实体/同名表，B 连接预览与 impact 只用 B 声明；没有匹配根时显示未知，不按 workspace 首命中；关联：IDE-REV-018、IDE-REV-019。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0275)
- [x] IDE-AUD-012 [P1] 让单实体结构影响覆盖全部子表；验收：遍历同实体快照所有表，ARRAY/组件子表的新增/移除/类型变化均进报告，全程只读；根表无变化不能掩盖子表变化；关联：IDE-REV-019。✔ 2026-11-01 fix 2fc66ff（runSchemaImpactCommand 遍历同实体全部表:resolveEntityTables(entityName,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0276)
- [x] IDE-AUD-013 [P0] 让单实体 schema 内部计算按预算让路；验收：对 6000 属性和深组件链验证实际最大连续片，25ms 预算不可在整实体 831ms 之后才检查；真实计算中取消不继续发布；关联：IDE-REV-013。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0277)
- [x] IDE-REV-039 [P2] 共享 def XML 解析器分片或 worker 化：单文件大 def(≥12k 行)的 parseDefDocument 实测 95-185ms(vendor fast-xml-parser 整块 opaque，不可内部 yield)，是 schema 单实体预算让路面(AUD-013 51d9ed4)之后的残余最大连续阻塞；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0278)
- [x] IDE-AUD-014 [P1] 补齐热更新结构指纹的引擎装载面；验收：Parent/Interfaces/Components/Persistent/Utype 等已核验结构变化阻止普通 reload；未知结构保守处理，注释/空白等非结构变更仍可通过；关联：IDE-REV-024。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0279)
- [x] IDE-AUD-015 [P1] 验收真实工作已经启动后的 hover 取消；验收：在真实文件读取/解析/查找的中段取消，按请求记录已开始与停止，取消后无晚到结果；入口假闸测试保留但不能充抵；关联：IDE-REV-032。✔ 2026-11-04 自验重跑通过（REV-032 真机用例「确定性在途取消:门内斩=开始后完成前取消,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0280)
- [x] IDE-AUD-016 [P1] 验收真实工作已经启动后的导航取消；验收：真实 definition 依赖链已派发后取消，排队/在途独占任务有证据停止，共享工作继续；取消前后 IO 按请求归属记录；关联：IDE-REV-033。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0281)
- [x] IDE-AUD-017 [P2] 将短资源压力测试与长会话验收分开；验收：保留 16 秒正式序列数据为短压力证据，另预设持续时长、自然编辑序列与资源预算跑长会话；报告 worker/缓存/RSS 趋势，不以手调 parser 代替全部用户交互；关联：IDE-REV-034、IDE-ACC-009。（41ee80e;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0282)
- [x] IDE-AUD-018 [P2] 对账深审后原组与修复细项状态；验收：每个原项重新核对自己的完整验收，修复子项全完成才允许关闭，已有失败反例不因单测通过自动消失；关联：IDE-ACC-010。（docs/review/2026-11-05-aud018-reconciliation.md;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0283)

- [x] IDE-AUD-019 [P1] 对齐最终验收的实际资源量规结构；验收：使用真实 pendingWork 返回类型逐项核对 queued/running，不以 caches/worker 对象与零比较，也不要求缓存容量归零；当前 --final 入口能完成采样，旧类型断言不得遮蔽不兼容；关联：IDE-ACC-010。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0284)
- [x] IDE-AUD-020 [P1] 让延迟越界真正导致最终验收失败；验收：hoverPass 与 definitionPass 分别断言并注入可控延迟证明两者独立失败；预先规定采样/宿主争用处理，不用三轮最优值冒充总体 P95；失败/未测保留开放；关联：IDE-ACC-010。 **完成（42bfd04）**：src/finalMarksVerdict.ts（MetricVerdict 双指标独立判定：预登记争用闸 loadLimit 突发采样排除留痕 excluded、池化总体 P95 非每轮最优、not-assessed≠pass 不冒充、任一失败即整体失败）；tests/finalMarksVerdict.test.ts 8 过（注入延迟序列证独立失败）；真机重跑按预登记口径双指标 load1≈149-151>28 闸如实 not-assessed（docs/perf/2026-11-05-acc010-final-marks-run.txt），IDE-ACC-010 保持开放待安静窗重跑。

- [x] IDE-AUD-021 [P1] 修复 JSONC 关联写入 scope 与激活错误收口（3237581；scope 改 Workspace(单根写 settings.json/多根写 .code-workspace settings 段一次写共享)，拒绝/只读记录 OUTPUT 通道无未处理 Promise，保留用户同名键与托管回收边界；18 例全绿，门禁 lint+tsc+test:unit 4910 过+xvfb RC=0）；验收：真实单根/多根窗口均可写入受支持的 files.associations scope，保留用户同名键与托管回收边界；拒绝更新或只读配置时记录原因且无未处理 Promise；关联：历史 debug.json 标 jsonc、审计 F18。

源码驱动 lint：文档规范编号不等于诊断已注册。下列未勾选项必须接入实际诊断事件，有正反例/开关/版本与性能验证后才能勾选。

- [x] IDE-LINT-001 [P1] 纠正 hasattr 对 EntityCall 非空的错误推断；验收/证据：已完成 c351606；保留 kbengine.receiverNone Warning，三 receiver 与跨 receiver 反例、真实非空 guard 正例及关闭开关；旧实现新增测试 4 红，修复后相关 8 文件 41 绿，eslint/tsc 通过；不包含完整控制流修复。
- [x] IDE-LINT-002 [P1] lint 的同行和复合条件使用可靠布尔语义；验收/证据：self.cell or ready 同行调用仍警告；真正 and 非空分支不报；括号、not、优先级不被字符串拆分误认；不确定形态保留警告。（58493bc;src/receiverNoneDiagnostics.ts:57/146 条件提取+布尔分诊——顶层 and 分句(含括号)恰为接收者/`is not None` 才认,or 不证明,not/优先级按 AST 形态不误认;tests/receiverNoneBooleanSemantics.test.ts 9 例(or 链仍报/is None 不认/and 分句认/括号/not/优先级/不确定保留);receiverNone 11 文件 106 过）
- [x] IDE-LINT-003 [P1] lint 的早退证明要求相关路径真正退出；验收/证据：嵌套条件 return、字符串 return/raise、注释不能算所有路径退出；直接有效 return/raise 正例仍不报。（58493bc;src/receiverNoneDiagnostics.ts:393 块体首行定缩进,仅无条件块级 return/raise 认退出,嵌套条件分支不认,字符串/注释掩码不算;tests/receiverNoneEarlyExitProof.test.ts 6 例;receiverNone 11 文件 106 过）
- [x] IDE-LINT-004 [P1] lint 的别名证明随赋值与作用域失效；验收/证据：别名重赋值、遮蔽、循环及嵌套函数不沿用旧 receiver 证明；同一有效别名 guard 正例保留。（58493bc;src/receiverNoneDiagnostics.ts:340/423/436/451 重绑记账+证明窗口从 guard 前最近赋值起+不跨嵌套 def/class 边界;tests/receiverNoneAliasInvalidation.test.ts 8 例;receiverNone 11 文件 106 过）
- [x] IDE-LINT-005 [P1] receiver lint 屏蔽注释和字面量；验收/证据：注释、普通/三引号字符串不产生调用诊断，真正代码与 f-string 表达式按已支持范围处理；一次词法扫描复用，不能逐命中重扫全文。（58493bc;src/pythonLexicalMask.ts 单遍词法掩码(注释/普通/三引号字符串空白,f-string 表达式保留),call 查找与 guard 分析共享;tests/receiverNoneLexicalMask.test.ts 5 例+receiverNoneCommentForms.test.ts 复现矩阵;receiverNone 11 文件 106 过）
- [x] IDE-LINT-006 [P1] receiver lint 覆盖本地别名使用点；验收/证据：peer=self.cell 后 peer.send 未判空报 Warning，判空正例不报，重赋值后不误当 EntityCall；诊断定位实际 token。（58493bc;src/receiverNoneDiagnostics.ts 别名使用点按作用域链解析,重绑定丢 EntityCall 假设,诊断定位实际 token;tests/receiverNoneAliasUse.test.ts 7 例;receiverNone 11 文件 106 过）
- [x] IDE-LINT-007 [P1] 基于引擎属性表实现只读写入 lint；验收/证据：确认 Entity 身份及角色后检查普通/增强赋值和 del；self.id 等只读属性报告，合法可写属性及普通 Python 同名字段不报；实际 code/开关/测试入规则表。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0285)
- [x] IDE-LINT-008 [P2] 对已解析 RPC 声明实现参数数量 lint；验收/证据：绑定当前根/实体/section 的 Arg，明确参数数量不符才报；星号参数/动态接收者及声明未就绪保留未知，inlay 不能代替诊断。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0286)
- [x] IDE-LINT-009 [P2] 对已确认角色实现属性/API 错用 lint；验收/证据：按源码 baseapp/cellapp/client 分面判断，角色不明和普通 Python 类不猜；hover 元数据与 lint 共用来源。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0287)
- [x] IDE-LINT-010 [P2] 定义并验证 Entity 销毁后访问的最小检查范围；验收/证据：从 getter 的 destroyed 行为核验，先覆盖同函数可确定的 destroy 后直接访问；跨回调/异常/动态分派标未分析，不能全文件误报。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0288)
- [x] IDE-LINT-011 [P1] 统一 lint 规则注册与能力清单；验收/证据：每条规则注册 code/严重度/角色/开关/源码提交/触发入口/修复支持，导出的已启用规则与 Problems 一致；已实现、仅提示、待实现明确区分。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0289)
- [x] IDE-LINT-012 [P1] 验收 lint 快速修复的语法和语义边界；验收/证据：多行调用、同一行两个不同 receiver、EOF、同级后续语句与缩进均可在真实 VS Code 应用；不把第一个 receiver 的修复套给第二个，不无提示改动无关后续逻辑。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0290)

## 2026-10-30 用户令 · KBEngine 跨进程数据字典键索引与类型互推

引擎源码核验(2026-10-30):globalData/baseAppData/cellAppData 经 GlobalDataClient → dbmgr GlobalDataServer(std::map<std::string,std::string>) → 各进程,key/value 均 `script::Pickler::pickle`(标准库 pickle)序列化,接收侧 `Pickler::unpickle` 还原同一 Python 对象(globaldata_client.cpp:98-104、entity_app.h:1261-1308、pickler.cpp:25-26)——**一侧设置的类型在另一侧可恢复**,跨进程类型互推成立。拓扑:globalData→全部进程、baseAppData→仅 baseapp、cellAppData→仅 cellapp(globaldata_server.cpp:60-110);写者自身进程不重收。用户定口径:键粒度=字面量按键值/标识符按键名文本;类型精度=能推才显跳过未知;本次做引用互链+go-to-definition+读写点类型提示,键补全留后续增量。

- [x] GLOBDATA-001 字典键索引与引用/跳转互链 (e6f53ac)；验收/证据：扫描器认 `alias.globalData[KEY]=RHS`(写)、`alias.globalData[KEY]`(读)、`alias.globalData.get(KEY[,default])`(读),非 alias/`self.` 前缀排除、`==` 不算赋值、跨行/复杂键跳过、字符串键解引;跨文件索引(仿 WorkspaceIndex,findFilesAcrossRoots+PY_SCAN_EXCLUDE+8并发时间片让出+noteSaved+watcher);引用 provider 落点 KEY 列出全部写+读点;go-to-definition 读点 KEY 跳首个写点、写点跳首个异类同键点。 【2026-11-01 第四轮复审重开项已全清：IDE-AUD-065..077 十二项(R4-F01..F12)全部已修并复核，重开条件满足，见 docs/review/2026-10-30-completion-audit-round4.md。】
- [x] GLOBDATA-002 读写点类型互推 (6e90299)；验收/证据：写点 `[KEY]=RHS` 出 `: <RHS 类型>`、读点 `.get(KEY)` 出 `: <同键写点值类型 union>`(无写点不出);RHS 字面量(int/float/str/bool/None)、list/dict/tuple 字面量可推,函数调用/运算符/链式不出(能推才显);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0291)

## 2026-10-30 第二轮完成标记复审 · IDE-AUD-022 起

依据：[第二轮深审](docs/review/2026-10-30-completion-audit-round2.md)，固定基线 5715296，独立单测 4351 通过/9 跳过，真实 VSIX 烟测 4 通过。27 类问题/缺口由源码与定向运行探针核对，不代表每项均有完整真机联验；来源与强度见审计 CSV 第二轮字段，不把分组源码复核当逐项独立验收。23 个原勾选项有新反例而重开，保留历史提交；c647fdf 的 IDE-AUD-001 迟到会话修复已独立验证，本轮不撤销。其他 agent 在途的字典/inlay/lint/测试工作不纳入本轮修复完成判断。

以下新增 33 个原子任务，一次只实现一个行为，验证后单独提交推送。优先 IDE-AUD-022/024 资源阻塞，再处理诊断和 F2 数据正确性。

- [x] IDE-AUD-022 [P0] 限制解析 worker 的全局派发与在途源码总量；验收：100 个不同文件首次提交不能绕过预算全部 post；worker 挂起时 posted/排队/字节均有硬上限，恢复后最新版本可继续，独占与共享取消边界不混淆；依据：R2-F01。1e36690（pythonParserWorkerHost 在途数量 16/字节 8MiB 双硬上限，首份任务在途满时转待派发排队受 8MiB 字节预算，回包后 drainAllQueues 全局让路面派发最新；量规加 postedBytes/maxPostedJobs/maxPostedBytes；测试:100 文件首份不全部 post、恢复后排队首份结算、在途满时首份排队可被新版本合并；门禁 lint+tsc+test:unit 4946\|7 + xvfb demo 全绿）
- [x] IDE-AUD-023 [P1] 让 worker 量规覆盖真正待处理输入；验收：区分 host 等待、已投递/实际处理，计入所有保留输入及对应单位；不能 running=100、queuedBytes=0 就宣称单 worker 无积压，超限拒绝/合并可解释；依据：R2-F01。c463555（量规加 postedBytes/maxPostedJobs/maxPostedBytes(1e36690 已在途双上限),复现摘要 worker 段新增「在途字节/在途上限」「总保留=任务/字节」——host 等待(排队)+已投递(在途)计数与字节并存一次可读;测试:量规区分与总保留、摘要渲染新段;门禁 lint+tsc+test:unit 4947\|7 + xvfb demo 全绿。注:worker 单线程,「实际处理」为在途子集,host 不可观测,量规只分 host 等待/已投递两层并注明）
- [x] IDE-AUD-024 [P0] 给日志每轮读取设置总字节与时间片；验收：2MiB/3万行及更大突增按有限总量让出宿主，非仅单块 Buffer 小；心跳与最大连续阻塞有断言，长行跨块与 UTF-8 边界正确；依据：R2-F02。bae99bc（logHub poll 单轮 64KB 字节预算+25ms 时间片，StringDecoder 保 UTF-8 跨块；测试:突增 3 万行心跳可走+轮数≥20+单轮不占排干一半、跨块多字节不损坏、预算 64KB 拆多轮；门禁 lint+tsc+test:unit 4943\|7 + xvfb demo 25 全绿）
- [x] IDE-AUD-025 [P1] 限制 LogHub 上游 pending 队列；验收：按事件/字节限额处理快生产慢消费，超限丢弃/合并策略及统计明确；retained=10 时 pending 也不能无限增，取消/释放排空；依据：R2-F02。84bae0d（logHub pending 事件数 10000/字节 8MiB 双限额，超限 shift 丢最旧，pendingBytes/pendingDropped 记账，flush 出队减字节，clear/dispose 排空；量规 getLogHubGaugeForTests 读 pending/pendingBytes/pendingDropped；测试:50 条快生产慢消费超限丢最旧+字节与件数同源、字节限额独立先触、取消/释放排空；门禁 lint+tsc+test:unit 4949\|7 + xvfb demo 25 全绿）
- [x] IDE-AUD-026 [P1] 诊断回包核验开关与发起配置代；验收：门住旧异步诊断，关闭或切代发布新结果，再放行旧包；旧结果不回写、不标成新代已发布，重新开启同版本可正常计算；依据：R2-F03。d9f9c52（diagnosticScheduler computeAndPublish 捕获发起代 startedGeneration，异步发布守卫新增两道:计算在途时开关关闭→disabledAsyncDropped 不写回 collection;计算在途时代已切换→staleGenerationDropped 不发布也不把新代标成已发布(否则重开同版本被 skippedCurrentVersion 跳过);测试:在途关闭旧包不回写、切代后 new-config 先发布不被 old-config 覆写、旧包先到不标新代已发布同版本仍重算;门禁 lint+tsc+test:unit 4952\|7 + xvfb demo 25 全绿）
- [x] IDE-AUD-027 [P1] F2 在最后一次异步查找后复核所有输入；验收：目标/依赖 def/Python 在途版本变化时重算或拒绝；不返回旧区间，不只对比上一次手势；关闭/取消同样不发布晚到编辑；依据：R2-F04。9c1ca28（KBEngineRenameProvider.provideRenameEdits 捕获起始版本 startVersion,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0292)
- [x] IDE-AUD-028 [P1] 属性引用限定真实词法与 self 所属作用域；验收：过滤字符串/注释/同文件无关类和嵌套 self，保留真读写点；Shift+F12 与 F2 共享已确认的符号结果；依据：R2-F05。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0293)
- [x] IDE-AUD-029 [P1] RPC 引用限定真实词法与调用者作用域；验收：真实 receiver 调用保留；字符串、注释、普通类及重绑定 self 不当成该实体调用，跨段仍隔离；F2 不误改；依据：R2-F06。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0294)
- [x] IDE-AUD-030 [P1] entities.xml 登记进入当前编辑器缓冲区；验收：打开脏文件通过 WorkspaceEdit/版本守卫更新，不擅自保存用户改动；随后正常保存仍有新登记与旧脏内容，撤销/关闭语义可解释；未打开才原子写盘；依据：R2-F07。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0295)
- [x] IDE-AUD-031 [P1] 表单附带改写使用脏文档基底与编辑事务；验收：space 的 entities.xml、固定字典 types.xml、组件挂载 def 分别验证未保存内容不丢，生成失败回滚只撤回本次编辑，不能仅复用确认框；依据：R2-F07。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0296)
- [x] IDE-AUD-032 [P1] 新项目确认后执行 no-clobber 创建；验收：预览期间新增/替换任何目标文件时拒绝整次落盘或安全重预览；原子 rename 不能覆盖并发出现的文件，回滚也不删除他人新增；依据：R2-F08。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0297)
- [x] IDE-AUD-033 [P1] 事件索引在放弃脏文档后恢复磁盘结果；验收：编辑新增/删除监听可见，放弃修改并关闭后监听/跳转恢复；在途旧脏结果不复活，不能等碰巧收到磁盘 watcher 才自愈；依据：R2-F09。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0298)
- [x] IDE-AUD-034 [P1] 事件磁盘更新在途时保留最新变化；验收：门住旧文件读取并连续触发真实磁盘更新，旧回包不能覆盖新版本；合并后至少有一次尾随读取，删除/重命名不会被旧任务复活；依据：R2-F10。8908616（indexFile 在途被新磁盘事件复用不再裸返回原 Promise:递增 revision(在途旧任务版本守卫失效,旧回包不覆盖新版本)+trailingReads 记账合并安排一条尾随读(同文件只一条,落定后按最新盘重读,多次事件合并新版本不丢);dispose 清 trailingReads;删除/重命名在途不复活由既有 fireDelete/rename 的 revision 递增已覆盖(本批补测试锁定);prove-red 1 例先红(在途读期间两次 fireChange:旧码 V2 永久丢失+无尾随读)后绿,删除不复活 1 例绿;门禁 lint+tsc+test:unit 4993|7 + xvfb demo 25 RC=0,全量首跑 1 例负载 flake 复跑全绿(与已知 hoverDeadlineContext 同型)）
- [x] IDE-AUD-035 [P1] 事件索引维护外部根 watcher 生命周期；验收：外部 assetsRoot 初扫后真实增删改均更新；切根时释放旧 RelativePattern watcher 并绑定新根，移除根后不返回其监听；依据：R2-F11。（265f99e;src/workspaceIndex.ts startIndex 末调 refreshExternalWatchers:外部 getExternalScanRoots 逐个挂 RelativePattern watcher(py glob),旧根释放新根挂,dispose 整组释放;extension.ts assetsRoot 切换同步 refreshExternalWatchers;测试=tests/workspaceEventIndex.test.ts IDE-AUD-035 两例(外部挂 RelativePattern=红转绿/切根旧释放新可触发);watcher 分布对账 workspaceIndex 1→2;测试绿 4938|7+25 demo）
- [x] IDE-AUD-036 [P1] 统一根移除通知覆盖共享事件索引；验收：事件缓存和该根在途任务收到同一终态通知，移除 B 不保留 B 监听/目标，不清掉 A；旧 B 回包不能再注册；依据：R2-F11。（6eb1ac7;src/workspaceIndex.ts 加 removeRoot(缓存+building 键前缀判定摘除,该根 revision 前进使在途读盘回包作废,其他根保留);extension.ts rootRemovals 订阅调 sharedWorkspaceIndex.removeRoot;测试=tests/workspaceEventIndex.test.ts IDE-AUD-036 两例(清 B 留 A 红转绿/在途 B 回包不再注册);锚点对账 1149/1227/1267→1154/1232/1272+baseline 同步;测试绿 4936|7+25 demo）
- [x] IDE-AUD-037 [P1] 将依赖就绪编排接到真实启动命令；验收：kbengine.server.start 的自动/组启动走统一依赖图；machine 失败或未 ready 时 logger/dbmgr 等依赖项不继续；命令级测试不能只测管理器 API；依据：R2-F13。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0299)
- [x] IDE-AUD-038 [P1] 提供接通 retryTarget 的实际操作入口；验收：从命令/工作台选择失败目标重试，已就绪目标 PID 不变，失败原因如实显示；取消与超时按既有原子任务守卫执行；依据：R2-F14。c89ce43（产品闭环三面:①serverManager 增失败目标登记 failedTargets(键=buildServerKey),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0300)
- [x] IDE-AUD-039 [P1] 测试会话处理非零退出与 teardown 错误；验收：PASSED 节点后进程退出非零也显示会话错误及 stderr；保留节点主体真实结果，不能整个运行冒充成功；代码缺失/被信号终止也显式处理；依据：R2-F19。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0301)
- [x] IDE-AUD-040 [P2] 测试发现重置普通类与函数作用域；验收：class TestReal 后的 class Ordinary.test_* 不归入 TestReal；切类/嵌套函数/字面量有正反例，静态不支持的形态明确标边界；依据：R2-F20。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0302)
- [x] IDE-AUD-041 [P1] 将进程 attach 会话绑定到具体运行目标；验收：实际 PID 模式会话有结构化 component/targetId/尝试身份，工作台显示 attached；断开/停止只作用该目标，同名并发不误认；依据：R2-F15。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0303)
- [x] IDE-AUD-042 [P1] 返回类型推导尊重最后一次变量写入；验收：调用赋值后常量/未知调用/局部遮蔽不借早先调用答案；跨作用域同名不误推，已知最新调用仍命中；依据：R2-F16。(e3d6885;matchingAssignments 改「最近一次写入」语义:自 hover 行向上只认最近一次对 word 的赋值——是单层调用则作唯一候选,否则(常量/未知表达式/局部遮蔽)返回空,不再把更早调用答案借给被覆盖变量;作用域边界(IDE-HOV-016)与「能推才显」闸保留;prove-red 4 例先红(常量 x=original();x=0/未知调用 x=unknown()/局部遮蔽 x=0 内层不借外层 original/旧「同名重赋值取最后一次可解析」例 191 反转期望 null)+1 正例(已知最新调用仍命中)保绿;门禁 eslint 0/tsc 0/unit 4928|7/demo 25 RC0)
- [x] IDE-AUD-043 [P1] 显式本地无注解声明阻止跨文档借名；验收：当前文件定义 original 无注解时，不从其他打开文件同名 original 借类型；本地明确注解优先，删除/更新文档桶后不留旧值；依据：R2-F16。（0ea00fe;级联顶层加「当前文件 unannotatedNames 含名即 null」,在 fromOthers 之前;测试=tests/pythonReturnTypeInference.test.ts IDE-AUD-043 三例(同文件无注解不借 other.py 的 OTHER_FILE=红转绿,本地 LOCAL 压 OTHER_FILE,磁盘同名亦挡);测试绿 4931|7+25 demo）
- [x] IDE-AUD-044 [P1] 导入别名绑定保留原始符号名；验收：from mod import original as local 后 local() 查 original；不同模块同名、模块别名、相对导入及歧义分别处理，未知不借邻居；依据：R2-F17。（be79881;from-import 绑定值改 {module,symbol},查桶用 symbol 而非绑定名(接收者形态仍用方法名);测试=tests/pythonReturnTypeInference.test.ts IDE-AUD-044 三例(别名查原名 FROM_HELPERS=红转绿,未起别名维持,绑定符号无注解不借邻居);测试绿 4934|7+25 demo）
- [x] IDE-AUD-045 [P1] hover 超时停止无等待者需要的独占工作；验收：预算返回空后原请求不继续新增读取/排队；共享索引与仍有等待者的计算继续，实际在途依赖 token 收到取消，不能仅验证前台返回时间；依据：R2-F18。7cf5c17（src/hoverBudget.ts HoverRequestDeadline 增 cancel()——显式取消链接 token(幂等,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0304)
- [x] IDE-AUD-046 [P2] 修复兼容检查命令的 manifest 路径；验收：真实命令传 package.json 文件路径，bundle 相对于扩展根检查；有效安装不再报 EISDIR/版本缺失，缺文件时原因准确；依据：R2-F21。(42c989d;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0305)
- [x] IDE-AUD-047 [P2] 分开 KBEngine 与 VS Code 版本域；验收：宿主版本只与 engines.vscode 比较，引擎版本只与已声明的引擎支持范围比较；没有引擎支持矩阵时标未知，不把 2.5.10 大于 1.84 当兼容；依据：R2-F22。(4eee9f4;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0306)
- [x] IDE-AUD-048 [P1] 根移除释放全局 XML AST 的对应输入；验收：documentStore 与 defParser 全局缓存共同处理根生命周期，根的源码/AST 不残留；共享同内容与其他根仍可用，不以固定条目预算代替清理；依据：R2-F12。(ada71ee;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0307)
- [x] IDE-AUD-049 [P2] 引用 provider 尊重 includeDeclaration；验收：true 时包含精确声明，false 时不包含，且不重复；属性/RPC 两面都有命令级断言，不把实现当声明；依据：引用 API 补项。(ff37ffd;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0308)
- [x] IDE-AUD-050 [P1] 拒绝无效 PID 后再执行进程树信号；验收：pid 缺失/0/负数/非整数时不向内核或 taskkill 发信号；模拟 process.kill 记录参数验证，spawn 失败/退出并发下不误杀宿主组；依据：R2-F23。(16f0af0 合入,门禁:cargo test 25 绿+lint 0+tsc 0+test:unit 5082|7 绿+demo 25 RC=0)
- [x] IDE-AUD-051 [P2] 将 schema 纯推导与输入收集真正隔离；验收：普通 Node 无 vscode 时可导入并运行纯推导；workspace/layout/fs/snapshot 留在适配层，传递依赖测试替代只查 import 字符串；依据：R2-F24。(da8fdb2 合入,门禁:cargo test 25 绿+lint 0+tsc 0+test:unit 5084|7 绿+demo 25 RC=0)
- [x] IDE-AUD-052 [P1] 从发起时记录异步诊断耗时；验收：门住/延迟 35ms 的计算至少体现在对应等待/总耗时，不再全部为 0；计算/发布可分段，统计与同步路径口径写清；依据：R2-F25。已修 e923c8e：diagnosticScheduler computeAndPublish 计时起点移到 computeAsync() 发起前(原在 then 内,35ms 计算聚合记 0.1ms);同步/异步两路径统一 record 闭包,样本 subPhases={compute,publish} 分段(recordLanguageServiceOperation 增可选 subPhases);prove-red 先红后绿(修复前 max=0.1 断言红,修复后异步 35ms/同步忙等 35ms 的 max/total≥30 且 subPhases.compute≥30);5086|7+25 demo 全绿;承重锚点 218/248→223/253 锁步。
- [x] IDE-AUD-053 [P1] 让热更新遵守 quick action 的布尔失败结果；验收：真实 runByName 返回 false 时不得记已发送；自动发送与失败重试都处理 failed/skipped 并保留原因，成功但无业务回执才 sent-unverified；依据：R2-F26。已修 fbaac3a：hotReload.ts fire 路径与 hotReloadRetryCommand.ts resendHotReloadTarget 都检查 runAction 回执——resolve false(未执行/失败)如实记 failed+原因,不再冒充 sent-unverified/ok:true;true/void 等无业务回执仍只记 sent-unverified;临时编辑路径本已处理 false;prove-red 2 例先红后绿;5088|7+25 demo 全绿;IDE-HOT-002/REV-026 随本修复复核关闭。
- [x] IDE-AUD-054 [P1] 将直接 HTTP 动作的观察器传到底层响应；验收：@http:debug 与 @http:settings 两路径都透传 onHttpResponse，2xx/非2xx/未知回包按真实事实落账；覆盖 QuickActionManager 真实编排而非手调假观察器；依据：R2-F27。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0309)

### IDE-AUD · 第三轮深审补漏（2026-10-30）

证据：[第三轮审计](docs/review/2026-10-30-completion-audit-round3.md)。本轮只重开 GEN-006；其他窄范围验收项保留完成标记，缺口按下列任务分别验收。

- [x] IDE-AUD-055 [P1] 将 schema 视图的根身份贯穿命令与 URI；验收：A/B 同名实体可同时打开两份不同 URI；展示、定位、刷新始终使用各自根，覆盖真实命令到 provider 接线；依据：R3-F01。已修 e5fc511：createDatabaseSchemaUri(entityName,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0310)
- [x] IDE-AUD-056 [P1] 关闭 schema 文档时释放已发布快照；验收：关闭事件删除对应 publishedRenders；连续打开关闭超过 32 个实体后关闭文档不保留快照，仍打开文档保持同代定位；依据：R3-F02。已修 2fbfd2e：KBEngineDatabaseSchemaProvider 构造即订阅 workspace.onDidCloseTextDocument,关闭 kbengine-db-schema 文档即 closeDocument(uri) 删除该 URI 的 publishedRenders(行数组+快照),仍打开文档保持同代定位;provider 自身 push 进 context.subscriptions,deactivate 拆关闭订阅不跨激活泄漏;prove-red 3 例先红后绿(46 视图关 45 只余 1/仍打开同代定位+关闭后退独立口径/真实 documentClosed 事件触发释放),锚点表 extension +3 同步;5099|7+25 demo 全绿。
- [x] IDE-AUD-057 [P2] 释放 schema provider 时清空发布记录；验收：dispose 后 publishedRenders 为空、事件订阅释放；多次 dispose 安全，不影响正常关闭前定位；依据：R3-F02。已修 9c351b8：KBEngineDatabaseSchemaProvider.dispose 现清空 publishedRenders(行数组+快照)并断关闭订阅与 onDidChange 发射器,多次 dispose 幂等(二次释放/清空无副作用),不触碰正常关闭前定位;prove-red 1 例先红后绿(dispose 后全部已发布代释放/二次 dispose 不抛/关闭事件与 closeDocument 对已释放面安全);5100|7+25 demo 全绿。
- [x] IDE-AUD-058 [P2] 按声明节点判断引用图重复符号；验收：单个正常开闭标签零重复警告，同段真实重复声明仍定位正确；Project Doctor 实际调用链得到相同结果；依据：R3-F03。已修 863066f：collectDuplicateIssues 不再按 rename 编辑次数(单个开闭标签产出开+闭 2 编辑位置,曾误当 2 份声明),改按「声明节点」计数——同文件同段同 kind 同名声明节点 >1 才算重复,每组报 1 条(首节点行号);prove-red 2 例先红后绿(Hero/Monster/Boss 单声明零重复警告,Dup.def 同段两 hp 仍定位正确且 Project Doctor 同结果);5101|7+25 demo 全绿。
- [x] IDE-AUD-059 [P2] 让引用图保留无链接的当前实体；验收：选中只有 hp 的 Solo.def 时图含 Solo.hp，Doctor 统计包含当前文件；保持无关孤立实体不误纳入当前连通分量的既有约束；依据：R3-F04。已修 0c5c0fa：buildDefReferenceGraphFromFile 把 seed 文件显式并入 reachableFiles(仅当前实体),不再只留链接端点——无链接的 Solo.def 的 Solo.hp 进图、Doctor checkedFiles/checkedDefinitions>0;无关孤立实体(Orphan)仍不纳入(不在任何连通分量,非 seed);prove-red 1 例先红后绿(选中 Solo.def 图含 Solo.hp,Orphan 仍排除);5102|7+25 demo 全绿。
- [x] IDE-AUD-060 [P2] 将实体所属根的类型注册表接入消息表；验收：preview/export 真实共享构建面读取所选根 types.xml 和 alias 设置；MY_INT→UINT32 参数不再 unknown-arg-type，缺失或非法配置仍如实报告；依据：R3-K01（已知缺口补证）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0311)
- [x] IDE-AUD-061 [P1] 改名前检查受影响继承链的名字冲突；验收：Hero.hp、继承者 Monster.vigor 初始合法，hp→vigor 拒绝并指明后代冲突位置；父链冲突也拒绝，合法跨段同名不误拒；依据：R3-F05。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0312)
- [x] IDE-AUD-062 [P1] 防止 SDK 辅助成员与业务名字冲突；验收：包含业务 entityId 的输入按明确策略生成可编译 TS 或提前拒绝并说明原因；覆盖固定辅助字段和方法名字，不静默覆盖；依据：R3-F06。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0313)
- [x] IDE-AUD-063 [P2] 明确 TS SDK 的 64 位整数表示策略；验收：UINT64/INT64 全域无静默精度丢失或提供明确受限模式；9007199254740993 边界验证，文档说明编译目标及编解码边界，不仅替换类型字符串；依据：R3-F07。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0314)
- [x] IDE-AUD-064 [P1] 隔离每次代码生成的回滚事务；验收：同一实例两次向导重叠时账本互不覆盖；First 打开失败不删除 Second 成功文件；提交后的打开 UI 错误不回滚已完成事务，原多文件写失败回滚用例继续通过；依据：R3-F08。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0315)

### IDE-AUD · 第四轮：字典索引生产复核（2026-10-30）

证据：[第四轮审计](docs/review/2026-10-30-completion-audit-round4.md)。基线 7008e15；GLOBDATA-001 重开，GLOBDATA-002 未提交内容不纳入本轮结论。每项独立验收，局部修复不自动关闭整个 GLOBDATA-001。

- [x] IDE-AUD-065 [P1] 过滤字典键索引中的非代码访问；验收：注释、普通字符串、三引号字符串中的伪写/读点不入索引；真实下标和 get 的字符串键仍识别；真实读点不会跳往注释或字符串内容；依据：R4-F01。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0316)
- [x] IDE-AUD-066 [P1] 在字典导航冷查前验证源访问的词法上下文；验收：外层字符串与注释中的伪访问不启动全量索引、不返回定义/引用；真实字符串键允许导航，覆盖定义与引用两个产品入口；依据：R4-F01。已修(b411967)：新增 `getDataDictAccessInCodeContext(documentText,line,character,`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0317)
- [x] IDE-AUD-067 [P2] 按 Python 字符串值归一化字典键；验收：换行转义与字母 n 不合并，十六进制 A 与字面 A 正确关联；明确支持的字面量前缀/转义范围，不支持语法如实跳过而不改写键值；依据：R4-F02。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0318)
- [x] IDE-AUD-068 [P1] 为字典键倒排与查询加入工程身份；验收：A/B 独立工程同 dict 同键不互跳；同工程 base/cell 的 globalData 可互链，身份贯穿命令、查询和缓存，不仅修改底层键；依据：R4-F03。已修(400ff33)：新增 `resolveScopeRoot(fsPath)`——取最深的 workspace 根前缀，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0319)
- [x] IDE-AUD-069 [P1] 关闭弃改 Python 文档时恢复字典键磁盘索引；验收：磁盘 disk、未保存编辑 dirty、丢弃关闭后只剩 disk；关闭已保存文档不丢正确索引，移除文件不复活旧键；依据：R4-F04。已修(a422c9a)：索引维护脏文档集合 `dirtyDocs`——`noteSaved` 按 `document.isDirty` 登记/撤销，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0320)
- [x] IDE-AUD-070 [P1] 在飞字典索引读盘结束后追赶后到变更；验收：门住旧内容读取、磁盘改 latest 后再触发 watcher change，最终只发布 latest；覆盖多次通知合并、删除和脏文档优先级；依据：R4-F05。已修(e5dd0bf)：`watcher.onDidChange` 先升 revision(在飞读盘若读到旧字节即作废)；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0321)
- [x] IDE-AUD-071 [P1] 按根变化更新字典索引与 watcher；验收：移除根立即撤回其贡献；添加根与 assetsRoot/profile 切换重建正确覆盖，旧任务不能重新发布旧根，外部根监听有实际证据；依据：R4-F06。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0322)
- [x] IDE-AUD-072 [P1] 让字典导航等待冷索引时可及时取消；验收：门住发现/读盘后取消，当前 definition/references 调用在放闸前返回；共享初扫可继续服务其他请求，取消不破坏索引；依据：R4-F07。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0323)
- [x] IDE-AUD-073 [P2] 在发布字典导航前复核启用代际；验收：冷查询等待中关闭 enableDataDictIndex 后不返回旧结果；关闭再开启的代际切换也不放行过期请求；依据：R4-F08。已修(594427e)：`pythonDataDictIndexGeneration` 启用代际——开关每次实际翻转前进(关→开两步也前进两次)；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0324)
- [x] IDE-AUD-074 [P1] 消除字典索引初扫与监听之间的空窗；验收：初扫期间真实 create/change/delete 事件均被记账或重放；捕获旧字节后删文件不能发布幽灵写点，避免监听与全扫互相覆盖；依据：R4-F09。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0325)
- [x] IDE-AUD-075 [P1] 在字典导航异步等待后复核源文档版本；验收：cfg 查询等待期间源改成 different 后不返回旧 cfg 位置；定义与引用共同校验 URI/版本/查询代，覆盖编辑和关闭；依据：R4-F10。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0326)
- [x] IDE-AUD-076 [P1] 将字典索引编辑重扫接入交互调度预算；验收：合并连续编辑、取消旧代并限制单文件扫描和倒排提交的连续阻塞；用实际大文件记录最大执行片和旧结果丢弃，不能只给整个同步循环套 setImmediate；依据：R4-F11。已修(56db9c8)：`noteSaved` 分流——>64KB 文档走异步预算化重扫(合并/取消/切片),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0327)
- [x] IDE-AUD-077 [P2] 修正共享 KBE alias helper 的 from-import 绑定；验收：from KBEngine import Entity 只绑定 Entity，不把未绑定 KBEngine 当模块；import KBEngine 和 import KBEngine as k 正常；复核共享导航/补全调用方的回归；依据：R4-F12。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0328)
- [x] IDE-RUST-001 [P1] def 旗标→进程域真值表单一来源收归 Rust；验收：flag→domain 表仅 Rust 定源，TS 走生成镜像，三方(flag_domains/propertyFlagDomainList/domainBitsOf)同真值表；前置：无。(8a9ea1f;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0329)
- [x] IDE-RUST-002 [P2] 消息表 build 核心挪 Rust；验收：buildMessageTable 纯逻辑在 Rust(kode-parser+kode-types 复用 flag_domains),TS 经命令级 RPC 调 Rust,TS 实现保留兜底;renderer(markdown/JSON)留 TS 纯展示;前置：IDE-RUST-001。(aa1cfc1;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0330)
- [x] IDE-RUST-003 [P3] client SDK 生成核心挪 Rust；验收：纯生产器(parseClientSdkEntity/buildClientSdkTypeMap/generateClientSdkEntityFile/generateClientSdkFixedDictsFile/isClientVisibleProperty)在 Rust,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0331)
- [x] IDE-RUST-004 [P4] lint 规则注册表到 Rust(uv/ruff 口径)；验收：Rust Rule trait+RuleRegistry(可注册规则集,加规则=加一个规则结构体),def 分析规则(未知 Type 引用/未知 Flags(12 词表)/未知 DetailLevel/重复定义(旗标作用域 Warning+Info 成对)/缺 Type·Flags/其它 analyzeDefDocument 规则)注册为规则,TS validateDocument 改调 Rust(Rust 可用时),TS 纯分析器保留兜底+对拍;collectInheritedNames 留 TS 作输入;前置：IDE-RUST-001。(2df60bb 合入,6 门禁:cargo test -p kode-server+lint+tsc+test:unit 5049 绿)
- [x] IDE-RUST-005 [P5] .py 源码 lint via ruff；验收：ruff check --target-version py37(KBEngine Python 锁死 3.7.3);形态待用户定——A(推荐)shell out 到 ruff 二进制(无 ruff 回退不报,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0332)
- [x] IDE-I18N-001 [P1] quick fix 文案跟随语言设置默认英文；验收：quick fix 标题走 vscode.l10n+package.nls.json/zh-cn.json,默认英文,中文环境出中文;不涉 quick fix 语义(边界属 IDE-LINT-012);前置：无。(655494a;package.json +"l10n":"./l10n" 字段,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0333)
- [x] IDE-RUST-006 [P2] components 完整语义收归 Rust(实体组件,has-a 组合);验收：组件槽(EntityComponent 类型属性,Utype/Persistent)解析+组件 def(components/ 子目录)完整递归(Properties/Methods/Callbacks/Parent/Interfaces/DetailLevel)+槽 Utype 与普通属性撞号校验+槽域 flags 派生(f(组件模块 base/cell/client))+SDK 生成组件属性可见性;前置：IDE-RUST-002, IDE-RUST-003, IDE-RUST-004(依赖迁移后 Rust 核心,wave 2)。(f5a5063 合入,门禁:cargo test -p kode-server 26 套绿+lint 0+tsc 0+test:unit 5064|7 绿+demo 25 RC=0)
- [x] IDE-RUST-007 [P2] def 依赖图收归 Rust(接口 is-a + 组件 has-a 合成依赖,用户扩范围:从 entities.xml 出发);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0334)
- [x] IDE-RUST-008 [P2] 数据库表/列推导收归 Rust(承接 IDE-RUST-007 尾部「数据库表字段推导为下一批另行点火」);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0335)
- [x] IDE-BOT-001 [P1] KBEngine 机器人框架支持与多机管理;验收：分析 kbe 自带 bot 框架(kbe/src/lib/bot 与 bot 脚本/实体,createBot 接口)支持方式;能管理机器人(创建/启停/状态/数量);能多台机器协同跑机器人(远程编排/汇总);形态待调研后定(是否走 Rust 核心编排 + TS 管理 UI);前置：无(调研先行)。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0336)
- [x] IDE-PROP-001 [P2] 属性先于 __init__ 装载的可见化;验收：实体类定义/__init__ 处出一行 CodeLens 说明「属性先于 __init__ 装载·来自 Entity.def」(与既有 PropertyCodeLensProvider 同面,独立开关);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0337)
- [x] IDE-DB-001 [P2] 持久化字段数据库类型大小限制提示;验收：def/types.xml 持久化字段(Persistent)受数据库类型大小约束(可指定/不可指定);未显式配置大小时提示引擎默认值+最大值+所用数据库类型(如 STRING→VARCHAR(n)/BLOB 等);形态待调研后定(CodeLens/hover/诊断);前置：无(先分析 engine db 类型映射)。
  - 交付：3563917 feat + 22f5952 docs。形态定 hover 两面(诊断否决=引擎无上限校验无可诊违规,IDE 不发明规则;CodeLens 与既有属性镜重复)。调研定锚(engine db 类型映射,entity_table_mysql.cpp/datatypes.cpp/datatype.cpp):STRING/UNICODE→varchar(N) 未配置(或 ≤0)硬编码 255;整型/浮点 (N) 仅显示宽度未配置引擎剥掉后缀建裸类型;blob 族(PYTHON/PY_DICT/PY_TUPLE/PY_LIST/BLOB/ARRAY/FIXED_DICT/ENTITYCALL/组件槽)一律 blob 大小不可指定;VECTOR 合成列恒 float;引擎侧无上限校验,建表时 MySQL 才报错(varchar 上限 65535 字节整行共享,utf8mb4 每字符最多 4 字节);普通别名不读 DatabaseLength(datatypes.cpp:174-180 只复用目标类型实例),长度只在 def 属性与 FIXED_DICT 子键读取(datatype.cpp:2065-2080)——kode 忽略别名级 DatabaseLength 同引擎口径。实现:src/databaseSimulator.ts 新 describeColumnCapacityNote(列级:varchar 长度可配——未配置点明引擎默认 255/已配置点名 DatabaseLength=N,均附上限 65535 字节/行+引擎不校验建表时 MySQL 才报错;整型/浮点显示宽度不改范围/精度;blob 族与 VECTOR 不可配;标志缺失按有效长度中性表述不冒称)+describeBuiltinTypeCapacity(types.xml 内建类型按族,别名上不生效如实写明「长度配在使用处」),buildPropertyDatabaseStorageHover 同 DDL 列组括注并「取值 X; 容量: Y」;src/languageProviders.ts describeTypeStorageShape 内建形态附容量行+FIXED_DICT/ARRAY 逐键/逐元素行;src/databaseSchemaCore.ts TableFieldDescriptor 加 databaseLengthSpecified(有效长度已折算 255,声明与否单独留痕——不抢改 databaseLength 语义,合成列不带);Rust 侧 crates/kode-server/src/database_schema.rs FieldSchema 镜像 database_length_specified(leaf_field 必带 Some(declared_database_length),synthetic None)双侧对齐。测试:tests/databaseSimulator.test.ts 容量说明 6 新例+悬停文案 3 例按新括注更新;tests/schemaDerivation.test.ts 推导面留痕 1 例(STRING 已配置/未配置/整型/合成列四态);tests/schemaHoverPublishedFields.test.ts 端到端 1 例(Gold.def 加 name(STRING 未配置)→varchar(255)+引擎默认 255+上限,title(DatabaseLength=64)→已配置 DatabaseLength=64 且不冒称默认);tests/typeStorageShapeHover.test.ts 形态措辞全量更新+声明行悬停容量断言;tests/languageProvidersInternals.test.ts 批131 例断言扩容;Rust database_schema_dispatch 新例(sm_title 128 true/sm_desc 255 false/sm_uid 64 true/sm_gold false/id 无字段)。prove-red=git restore --source=c8d9977 src+rs 后 TS 16 例红(5 文件)+cargo 红,恢复后全绿。门禁=eslint 0/tsc 0/test:unit 571 文件 7030 过 2 skip/cargo database_schema_dispatch 6 过/mocha 12 过/xvfb demo 25 RC=0(门禁在重放后的真实树上跑,非首次实现那轮——见下)。坑:并发会话 22:41:28 git reset --hard origin/main 抹掉本批全部未提交改动,首轮流出的 lint/tsc/unit/mocha/demo 绿是已被抹掉树上的成绩不算数;重放(基座核对 b1d19f4..c8d9977 间 14 个目标文件零漂移后逐编辑重放)+全门禁重跑方作数;后续批次随手 git diff > /tmp 快照防再抹。docs:features.md+zh IDE-DB-001 条目;2026-baseline languageProviders 锚 5151/5257/7101→5162/5268/7112,既有漂移 semantic-query 打点 :4707/Impl :4725→真位 :4736/:4754 一并修;perfCallChainDoc ANCHORS 注(十六)。另:途中并发会话在 todo 写下禁字面量触发全仓拼写门,fix f1f6d0d 改写措辞(origin 侧 cb2779e 同修,合并时取舍)。
- [x] IDE-I18N-002 [P2] hover 提示国际化配置;验收：hover 文案可配置语言(默认英文,可选中/中文);检测到中文系统或 UTC+8 时区时默认中文;安装时生成配置(settings 默认值),既有英文 hover 不回退;形态待调研后定(沿用 vscode.l10n 机制或独立配置项);前置：IDE-I18N-001。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0338)
- [x] IDE-PYSPY-001 [P2] py-spy 火焰图集成与定时采集;验收：py-spy record --format flamegraph 出火焰图(既有 py-spy dump 面已集成);支持定时/周期采集(如每 N 秒采 X 次);使用傻瓜化(默认参数/一键采集);UI 需单独设计(采集配置+图展示);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0339)

## 迷你 ARPG demo(2026-11-07 用户令:「现在的demo实在太简单了,有什么办法把demo做的更完整一些,最好一个小型的游戏」;两问已答:位置=就地扩展现有夹具 tests/fixtures/kbengine-demo-assets(明知 golden/nav 锚定面,再生成对账,不另立工程);规模=迷你 ARPG)

- [x] DEMO-GAME-001 [P1] 世界地基:Spaces/Space 实体(hasBase/hasCell)+ Space cell 刷怪表与怪物生成(KBEngine.createEntity 按空间号)+ Account.reqCreateAvatar→Avatar(Proxy)giveClientTo→入空间(createCellEntity)→onEnterWorld 通知… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0340)
- [x] DEMO-GAME-002 [P1] 怪物 AI 状态机:idle 游走(moveToPoint 随机点)→ 仇恨(entitiesInRange 拾 Avatar)→ 追击(moveToEntity)→ 近身周期攻击 → 脱战回巢;onDamaged 反击。验收:引擎日志可见状态迁移与伤害;AI 决策纯函数测试绿。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0341)
- [x] DEMO-GAME-003 [P1] 战斗与成长:Avatar reqAttack/onDamaged/死亡重生(计时回出生点满血)、金币掉落(Inventory.gold)、经验/升级 client 通知。验收:无头跑通完整一局(杀怪得金币经验/可死亡重生),日志断言。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0342)
- [x] DEMO-GAME-004 [P2] bots 无头玩家:bots 脚本模拟客户端登录→建角色→移动/攻击,真引擎跑通一局,不依赖 Unity。验收:bots 日志呈现完整玩法回路。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0343)
- [x] DEMO-GAME-005 [P2] 夹具对账与文档:全部 golden 再生成、navigation-cases 不破坏、play_demo.py 既有回合制验收保持绿(训练场玩法保留不动)、demo README 更新、引擎起服验证脚本入仓(scripts/,复制夹具到运行目录+kbengine.xml DB 覆盖,不直跑仓库夹具)。验收:CI 门禁全绿;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0344)
- [x] DEMO-GAME-006 [P2] 空工程脚手架:demo 游戏模板化(templates/demo-game,夹具游戏子集逐字节对拍+entities.xml 裁剪 Training/Elite)+ 新命令 kbengine.project.createDemoGame(与最小项目同一保护面:冲突拒绝/预览确认/原子写/失败回收/建档)+ 空目录打开时主动提示(onStartupF… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0345)

## 审核发现

- [x] 审核发现：客户端 SDK 生成中，FIXED_DICT 类型仅被组件属性引用（不被任何实体属性引用）时，`ClientSdkComponents.ts` 会发出 `import { X } from './ClientSdkFixedDicts'`，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0346)
- [x] 审核发现：本轮 diff 其余方面（Rust 消息表/旗标域/lint 规则、logHub 分块读与双限额、workspaceIndex 尾随读与根移除、pythonParserWorkerHost 派发队列、pythonSelfScope、processManager 树杀、Rust 测试 15+19+6 全绿、vitest 关键模块用例通过）未见问题（12388975..HEAD）。（审计结论=无问题,2026-11-04 复核勾）

## 审核发现 2026-10-31

- [x] 审核发现：进程停止/释放时对异步启动失败的记录（pid=0）执行 process.kill(-0, sig)，等价于向调用者自身进程组发信号，可能误杀扩展宿主同组进程，应以 pid>0 为闸（src/processManager.ts:83/152/352/355/373）。（复核已修：processManager.ts:72-74 killProcessTree pid>0 闸，tests/cov-debug-process.test.ts:479 四例锁定；lane-1 2026-11-03 勾）
- [x] 审核发现：startTargetGroup 的依赖等待超时用 `?? READINESS_WAIT_TIMEOUT_MS` 把显式 null（约定为无限等待）改写成 60 秒，「等待不限时」路径实际不可达（src/serverManager.ts:858，对照 :755 的 null=无限契约）。（复核已修：serverManager.ts:207 resolveDependencyWaitDeadline null→null/undefined→60s，tests/serverManager.test.ts:73 四例；lane-1 2026-11-03 勾）
- [x] 审核发现：Rust lint 的 flag_scopes 把 OWN_CLIENT/OTHER_CLIENTS 归入 cell 域，与单一来源表（FLAG_TOKEN_DOMAINS：两者仅 client）相悖，继承同名判重与重复定义的域交集检查会误报（crates/kode-server/src/lint/rules.rs:180-188/538/772）。（复核已修 3cc6735：flag_scopes 改走 kode_parser::model::flag_domains 单一来源表(OWN_CLIENT/OTHER_CLIENTS 仅 client 不入 cell),tests/lint_rules.rs:255 同名属性 OWN_CLIENT(client)/CELL_PUBLIC(cell) 域交集用例+tests/parser_units.rs flag_domains(&[OTHER_CLIENTS])==[client],2026-11-04 复核勾）
- [x] 审核发现：Rust lint 的 flag_scopes 用未归一化原始旗标 token 与大写常量比对（缺 CELL→CELL_PUBLIC 别名、大写化与遗留拼写折叠），`Flags="CELL"` 等写法丢域导致 lint 漏报/错报，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0347)
- [x] 审核发现：依赖图对 implementedBy 生成 implements 边时未确保 type:{name} 节点存在（仅 property-type 引用路径会建 type 节点），产出 from 端悬空的边，前端 mermaid 渲染成无样式隐式节点（crates/kode-server/src/dependency_graph.rs:409-417）。（复核已修：dependency_graph.rs:409-417 ensure_node 补建 type 节点，tests/dependency_graph_dispatch.rs:274 实跑 ok；lane-1 2026-11-03 勾）
- [x] 审核发现：globalDataIndex.indexFile 命中在途构建时直接复用旧 promise，不递增 revisions 也不安排尾随重读，在途期间落盘的变更被静默丢弃、索引停留旧内容（workspaceIndex 已修的 AUD-034 同型竞态未同步到此）（src/globalDataIndex.ts:863-866，对照 src/workspaceIndex.ts:231-244）。（复核已修：globalDataIndex.ts:1687-1740 revision 追赶重读，tests/globalDataIndex.test.ts:1552；lane-1 2026-11-03 勾）
- [x] 审核发现：workspaceIndex 在途任务的 finally 无条件 building.delete(fsPath)，会误删 noteDocumentAbandoned 先删后建的新任务条目，后续磁盘事件绕过去重/版本守卫并跳过尾随读，可能发布过期内容（src/workspaceIndex.ts:303-305/176-184）。（复核已修：workspaceIndex.ts:231-246 升 revision+尾随重读、:304-309 只清自己占位，tests/workspaceIndexColdYield.test.ts:104+workspaceEventIndex.test.ts:572；lane-1 2026-11-03 勾）
- [x] 审核发现：debugpy 安装与 py-spy 超时仅 child.kill() 且子进程未 detached，pip/py-spy 衍生的构建孙进程成为孤儿（对照 ProcessManager.killProcessTree 的组杀口径）（src/debugpyPortProbe.ts:154/167-169；src/pyspyDump.ts:38/50-52）。（复核已修：pyspyDump.ts 组杀+detached 9fd9844；debugpyPortProbe.ts 安装通道 f58f4ec——spawn detached(非 win32)设组长、超时 killProcessTree(pid,SIGKILL,child) 组杀不留孙孤儿,INSTALL_TIMEOUT_MS 可注入(测试 300ms 复现挂起),tests/cov-debug-process.test.ts「挂起的 pip 按截止组杀」例;lane-1 2026-11-04 勾）
- [x] 审核发现：autoDebugpy 的 defaultRunPython 是同组唯一无超时/截止的 spawn 包装，解释器挂起时 syncDebugpyPackage 永久等待，命令无反馈卡死（src/autoDebugpy.ts:145-168）。（复核已修 9fd9844：defaultRunPython spawn detached(非 win32)设组长+RUN_PYTHON_TIMEOUT_MS 30s 截止(可注入 setRunPythonTimeoutMsForTests),超时 killProcessTree 组杀+exitCode 124 如实报超时失败,ENOENT 才换下一候选;tests/autoDebugpy.test.ts:593「解释器挂起:按截止组杀并如实报超时失败」例,2026-11-04 复核勾）

- [x] **C-15 · P1 · 实现 · def 驱动的线格式序列化/反序列化**
  - 依据 2026-11-01 用户确认缺失。现状:message_table.rs 已有消息编号表(utype 分配/别名 id/组件槽),缺字节级编解码。
  - 交付:Datatype 编解码器全集(UINT8/16/32/64、STRING、BLOB、VECTOR2/3/4、ARRAY、FIXED_DICT、PYTHON 对象位流,与 KBEngine 线格式逐字节兼容);属性更新流打包/解包;方法调用参数打包;bundle 分片语义;别名 id 编码路径。
  - 验收:与 KBEngine 官方线格式对拍——用官方客户端/抓包样本或 KBEngine 引擎产出的字节流做黄金样本,解码结果逐字节一致;往返(序列化→反序列化)无损;畸形流不 panic(错误返回)。
  - 完成 ✔ 2026-11-01 feat bd1754a（crates/kode-server/src/wire_codec.rs 新——KBEngine 线格式编解码器全集(标量定宽全小端无 varint/STRING NUL 结尾无长度前缀/UNICODE/BLOB/PYTHON* u32 长度+字节(pickle 透传)/ENTITYCALL 16B 定长 id+cid+type+utype/VECTOR2/3/4 连续 f32/ARRAY u32 元素数+部分数组流尽早停/FIXED_DICT 声明序无键名),WireLayout/WireValue/WireError(手动 Display 无 thiserror)/WireCursor 全 LE,encode_value/decode_value 双向,WireSchema::from_sources 结构重解析(不用 TypeGraph 因 field_refs 丢名折平 <of>)+resolve 环守卫;高层入口 encode/decode_property_stream(EntityRef Full/Alias 与属性模式正交;别名 u8+u8/utype u16+u16;特殊 base prop 别名恒 1/2/3、utype 走 BasePropUtype 默认 40000/40001/40002)+encode/decode_method_args(别名=u8 componentAliasID+u8 methodAliasID+实参无计数前缀,utype=u16 utype 组件 id 不读)+encode/decode_message_frame(变长 u16 回填=载荷不含 4 头字节,≥65535=65535+u32 扩展);$/kode/wire/encode|decode RPC 边界注册(server.rs register+lib.rs pub mod 双注册),无 TS 镜像;golden=dump-wire-golden bin+tests/golden/wire-parity.json 35 样本(标量边界/容器/属性流别名+utype+特殊 base/方法实参/消息帧,内置 encode→decode 往返自校验),tests/wire_codec_units.rs 12 测试(golden 字符串等值/双向/逐字节截断不 panic/部分数组尽早停/STRING 非 ASCII 停/ENTITYCALL 16B/别名 id 溢出/≥65535 扩展帧/schema 嵌套+环+未知/RPC dispatch);scripts/wire-probe/memprobe.cpp 尽力交叉验证(编译级通过,链接需完整 KBEngine 构建→跳过,规范推导为权威);门禁 cargo test --workspace --exclude kode-scheduler 全绿|wire_codec_units 12|clippy 本文件零告警(workspace 既有 client_sdk/database_schema/message_table 8 处漂移为 pre-existing 未动)）
- [x] **C-16 · P1 · 实现 · def 驱动的数据库表生成**
  - 交付:从 def 模型生成实体表结构(属性→列映射、类型→SQL 类型映射、Flags INDEXED/UNIQUE→索引、默认值、持久化标记过滤非持久属性);MySQL DDL 输出 + 迁移(已有表结构 diff 升级);dbmgr 对应的读写接口面。与 message_table 同源(共用 def 模型,单一事实源)。
  - 验收:用 KBEngine 官方示例资产(defs)生成,与官方 dbmgr 建表结果对照;round-trip:def→表→描述回读=def 语义。
  - 完成 ✔ 2026-11-01 fix 7330200（def 驱动数据库表生成分批落地:Rust 核心 crates/kode-server/src/database_schema.rs 新 $/kode/databaseSchema/build(IDE-RUST-008,输入=TS 收集的属性描述符树+实体名/def 路径/hasCell/表前缀,推导归 Rust 无读文件;镜像 TS deriveDatabaseTables→buildMysqlTableSchemas→appendPropertyToTable→expandColumnNames/resolveDbTypeLabel/resolveEffectiveDatabaseLength,引擎 ground truth=entity_table_mysql.cpp:根表 {prefix}{entity} 固定 id+sm_autoLoad+hasCell position/direction 六列、ARRAY→子表(元素落子表顶层)、ENTITY_COMPONENT→子表(无 cell 且组件槽无 base 域跳过)、ENTITYCALL 不落列、FIXED_DICT→键名前缀列不建子表、17 内建类型→mysql 型、STRING/UNICODE 未声明或 ≤0 DatabaseLength 落默认 255、Flags INDEXED/UNIQUE→索引、持久化标记过滤非持久属性),TS 兜底 src/databaseSchemaCore.ts+包装 src/databaseSchemaRust.ts(Rust 主路径,无 gate/!ok/形状不合规→null 回落 TS);MySQL DDL 输出 src/databaseSimulator.ts(renderMysqlDdl 引擎 CREATE 形状+列/索引片段,INSERT 形状对齐 sqlstatement.h:69-122 省略自增 id,诚实差距 SIMULATION_DIFFERENCES 清单);迁移 diff src/databaseDrift.ts(compareTableColumns→buildDriftReport→renderDriftReport,已有表结构 diff 升级);dbmgr 读写接口面 databaseSimulator renderInsertStatements+databaseSchema SELECT/JOIN SQL;验收覆盖:Rust 派发测 crates/kode-server/tests/database_schema_dispatch.rs 5(根/子表全字段、类型标签、DatabaseLength、child 表、畸形入参报错)+TS databaseSchemaGaps/databaseSimulator/databaseDrift 套件对照引擎 ground truth(DDL 形状/类型→SQL/迁移/round-trip 语义)。本次提交收口唯一推导奇偶差:组件子表补 parentID 结构列——引擎 isChild(true)(entity_table_mysql.cpp:1525)→syncToDB 给全部 child 表追加 parentID(:379-380),与 ARRAY 子表同形,TS 派生已含,Rust 漏列已补齐(parity bug #1);门禁 cargo test --workspace --exclude kode-scheduler 全绿|clippy 零新增(7 处既有漂移未动)|pnpm lint+tsc 干净|test:unit 5271 绿 7 skip|xvfb test:demo:editor 25 passing)

- [x] **C-17 · P1 · 设计+实现 · 进程拓扑定义与定义期错配预警**
  - 依据 2026-11-01 用户确认缺失:def 体系缺进程划分层——哪些进程、职能是什么;且定义错了进程要预警。修正(2026-11-01 用户纠正):预警=定义期静态校验告警,不是运行时探活(探活/自愈归 custos 与 ops 面,kode 不做)。
  - 交付①进程拓扑清单(部署清单文件):声明部署内全部进程与职能——参照 KBEngine 五进程(loginapp/baseapp/cellapp/dbmgr/machine)并可自定义;每进程:角色职能、承载的 entity 类型归属(cells/base 进程映射)、入口命令行、监听端口、依赖启动顺序;与 def 联动=entity 类型归属哪个进程由 defs 推导校验。
  - 交付②定义期错配预警(静态校验,接入 kode 已有 lint/diagnostics 体系):entity 方法节(Cell/Base/Client)引用了拓扑中不存在或不承载该角色的进程;持久化实体存在但拓扑缺 dbmgr;进程角色重复/冲突;未知进程引用;entity 归属与清单声明矛盾。全部以 warning 诊断形式在编辑/构建期给出(文件+行定位),并可 CI 拦截。
  - 验收:构造五进程拓扑示例;错配用例(实体落错进程/缺 dbmgr/未知进程)逐条产生定位准确的 warning;正确拓扑零误报。
  - 完成 ✔ 2026-11-02 feat abdf6ea（进程拓扑清单+定义期错配预警:Rust 核心 crates/kode-server/src/process_topology.rs 新 $/kode/processTopology/validate(清单 XML 解析 kode-parser xml::parse+LineMap 精确行;实体内容闭包走查 own 属性/方法→接口→组件→父类成环守卫,镜像引擎节→组件映射 CellMethods→CELLAPP/BaseMethods→BASEAPP/ClientMethods→CLIENT,entitydef.cpp:1324/1467/1610,旗标→域映射 common.h:41-45,归属 entity_app.h:573-578 与 components.cpp:933);校验规则 M1-M6/D1-D3/O1-O2 全 warning 定位精确——实体 CellMethods/cell 域属性需 cellapp(D1)、BaseMethods/base 域属性需 baseapp(D2)、持久需 dbmgr(D3)、清单进程名重复/端口冲突/单例角色重复/未知角色除非 custom/未知 dependsOn/依赖成环(M1-M6)、hosts 与内容矛盾或未知名实体(O1-O2),ClientMethods 只记录不校验(客户端侧非服务端拓扑));TS 封装 src/processTopologyRust.ts validateProcessTopologyInRust(Rust 不可用→null→静默零发现)+src/processTopologyDiagnostics.ts 映射,发布独立 kbengine-process-topology 集合,kbengine.diagnostics.checkProcessTopology 开关(默认开);独立 validate-process-topology bin 对目录同校验任一发现 exit 1 供 CI 拦截;验收 five-process 零发现,缺 dbmgr/缺 cellapp/落错进程/未知进程逐条定位准确(process_topology_units 19+dispatch 3+bin 3),正确拓扑零误报;门禁 cargo test --workspace --exclude kode-scheduler 全绿|clippy 零新增(7 处既有漂移未动)|pnpm lint+tsc 干净|test:unit 5283 绿 7 skip|xvfb test:demo:editor 25 passing)

- [x] **MCP-001 · P2 · 实现 · kode-mcp:把 def 知识库暴露给 AI agent**
  - 依据 2026-11-01 用户问「mcp 有没有做的价值」——判定值得:kode 本质是 def 知识库,MCP 让 agent 一次调用拿到准确 def 知识,替代每次自行读文件猜语义。
  - 模式复用:照 sandtable-mcp 先例(Rust rmcp 3.7 + stdio + 原生直调 crate,零 Node 依赖,新 crate kode-mcp 入 workspace)。
  - MVP 工具面(全是现有 crate 薄封装):search_entities(按名/标签查实体) / get_entity_model(实体全模型:属性/方法/Flags/进程归属) / get_type_graph(别名/数组/FIXED_DICT 解析) / validate_defs(def 校验,挂 C-17 错配预警) / get_message_entry(消息号+线格式布局,挂 C-15) / encode_decode_sample(参数→线格式字节样本) / db_schema_preview(def→DDL 预览,挂 C-16 落地后)。
  - 排期:P2,依赖 C-15(已完成)/C-16/C-17 落地后封装。
  - 验收:rmcp 客户端 stdio 端到端(list_tools→call_tool 全工具真数据返回);与 kode-server 同源单测;README + 双语文档。完成 ✔ 2026-11-07 复核勾(实现 2026-11-05 落 main:commit 7c1a1342 七工具(search_entities/get_entity_model/get_type_graph/validate_defs/get_message_entry/encode_decode_sample/db_schema_preview)全非壳——server.rs 派发+kb.rs 复用 kode-parser/kode-server(RpcRegistry 同源);tests/e2e.rs stdio 客户端逐工具真数据断言+units.rs 同源;README.md 英文+中文双语;加固跟笔 ab88ea6a(coverage)与 f28a6e7a/af629737(wire 环/标量守卫);评审 docs/review/2026-11-05-pr-batch-review.md 判 PASS;本席复验:cargo test -p kode-mcp 全绿(5+3+9+8),crate 在 origin/main。)

- [x] **C-18 · P1 · 实现 · KBEngine 官方 def MD5(引擎互通)**
  - 依据 2026-11-01 用户确认缺失。现状:TS 侧有 IDE 内部 hash 体系(hotReloadDefHash sha256 内容 hash + semanticHash 结构 hash + 回执比对,保留不替换),但引擎互通的官方「全 def 复合 MD5」仅有协商描桩未实现,Rust 侧无。
  - 交付:官方 def MD5 算法实现(与 KBEngine 引擎 Def::md5 逐字节一致——遍历顺序/序列化细节严格对齐官方);输出复合 md5 供一致性握手/热更后上报;与 C-15 线格式编码共用 def 遍历顺序。
  - 验收:黄金对拍——用 KBEngine 官方引擎对同一 assets 计算 md5,与 kode 实现输出逐字节一致;官方客户端连服的 def 校验场景可通过。IDE 内部 sha256/semanticHash 双轨保留(用途不同:内部基线 vs 引擎互通)。
  - 完成 ✔ 2026-11-01 feat c817267（crates/kode-server/src/def_md5.rs 新——引擎 EntityDef::md5() 字节级重放器:手写 RFC 1321 MD5(无新依赖,公开向量单测)+DefMd5Stream 结构化字节流构建器(逐段溯源 trace:field+kbengine file:line+hex);Phase1 DataTypes::initialize(21 内建构造序 uid u16+aliasName 空串+types.xml 文档序 FIXED_DICT 每键/ARRAY of/别名链,嵌套先于宿主入流)+Phase2 entities.xml 文档序(模块名→Properties/CellMethods/BaseMethods/ClientMethods 文档序(PropertyDescription 全字段 26B ctor,方法 utype 恒 0x0000,pushArgType=uid u16+exposed 4B,setExposed 4B,引擎坑:Arg 文本即类型、<Utype> 是 Arg 兄弟节点)→接口**递归**(引擎深度,非 message_table 单层)→组件未注册才注册→父类递归→autoMatchCompOwn 每 loadDefInfo 递归层各追加 3×int32(引擎 quirk,恒用子模块名);$/kode/def/md5 RPC(server.rs+lib.rs 双注册);golden=tests/golden/def-md5-parity.json 3 样本(demo-assets BED58F95…/parity-project 37BAB195…/minimal 手推锚点 7D30F640…,手推字节流逐字节核对:21 uid→"Gate"→26B 属性 ctor→方法→3×int32)+dump-def-md5-golden bin 再生成+字符串等值测;tests/def_md5_units.rs 9(RFC1321 向量/21 uid 序/minimal 26B ctor/utype 恒 0/autoMatchCompOwn 3×int32 尾/确定性/畸形不 panic/嵌套先入流/夹具装载)+def_md5_golden.rs 2(等值+md5-vs-stream 自洽)+def_md5_dispatch.rs 2(全链 dispatch+错误通道);TS 面:defMd5Rust.ts computeDefMd5InRust(原文直传,形状校验 32hex/algorithm==='md5'/trace 数组,无 gate/!ok/形不合规→null),hotReloadDefHash.ts negotiateEngineDigest md5 分支(unknown 描桩升格,negotiated/digest 回传,空串/短串退 unknown 兜底),sha256/semanticHash/回执三轨零改动;tests/defMd5Rust.test.ts 4(契约参数/无 gate/!ok/4 形不合规)+hotReloadDefHash.test.ts md5 分支 3;引擎 kbcmd 交叉验证尽力跳过(无可构建 kbcmd,需完整 KBEngine 构建,同 C-15 wire-probe 先例,规范推导 golden 为权威,features.md 如实记录);门禁 cargo test --workspace --exclude kode-scheduler 355 绿|clippy 零新增(7 处既有漂移未动)|pnpm lint+tsc 干净|test:unit 5251 绿 7 skip)

- [x] **C-19 · P1 · 实现 · def↔Python 方法一致性检查 + 一键生成骨架**
  - 依据 2026-11-01 用户确认缺失(旧版本无法正确识别;现在 def 解析与 Python 符号索引地基已齐)。
  - 交付①lint 规则 def-method-missing-in-python:def 中定义的方法在对应同名 Python 实体类中无实现 → warning 诊断,定位在 def 文件方法行,关联提示目标 Python 文件与类名;反向(Python 有 def 无)默认关闭可配,防误报。
  - 交付②LSP CodeAction 一键生成:仅在「def 有 Python 无」的方法上出现——在目标 Python 类末尾生成方法骨架(签名参数从 def 类型映射,默认 raise NotImplementedError 或 pass 可配);生成后自动重算一致性(诊断消除)。
  - 实现:rule 住 crates/kode-server/src/lint/rules/def_python_parity.rs(独立文件避 wt/topology 冲突);`$/kode/lint/analyzeDef` 增 pythonParity 参(TS 采集各段已实现方法),Rust 集合差,Finding.related {file,className}→TS relatedInformation 双向定位;CodeAction KBEngineDefPythonParityCodeActionProvider 类尾插骨架(类型映射 UINT32→int 等)。
  - 验收:示例实体(def 有 3 方法/Python 缺 1)→ 恰好 1 条 warning + code action 生成后 warning 消除;已实现方法零误报;vitest/cargo 绿。
  - 完成 ✔ 2026-11-01 feat dd7303f（src/defMethodConsistency.ts 新——纯逻辑半边:defArgTypeToPythonAnnotation 内建注解映射(UINT32/INT8/UINT64→int,FLOAT/DOUBLE→float,STRING/UNICODE→str,BOOL→bool,BLOB→bytes,与 PYTHON_BUILTIN_TYPE_ANNOTATIONS 单一事实源;typing 泛型 VECTOR2/3/4/PY_DICT/PY_LIST/PY_TUPLE/PYTHON/ENTITYCALL 需 import 不发射→undefined)+buildMethodStubCode(4 空格缩进,形参 argN[: 注解] 或裸 argN,体 pass/raise 可配)+collectDefMethodMissingItems(定位方法名首个 <name 出现+1,回退整行区间,越界跳过,\r\n 行首偏移兼容)+collectPythonMethodNotInDefItems+诊断 code 常量 kbengine.defMethodMissingInPython / kbengine.pythonMethodNotInDef(惯例 kbengine.<camelCase>);src/entityMapping.ts 三查询面+一模块助手:collectDefMethodImplementationGaps(只看 rootCategory='entity' 根防接口误报,只标 defFile 落在本文档的声明,判存与 Go to Implementations 同一 listMethodImplementationsByIdentity 面+缓冲区感知兜底 hasMethodImplementationInSnapshot(readSharedFileSnapshot 打开缓冲区优先,覆盖 CodeAction 生成未保存即消除))、collectPythonMethodNotInDef(跳 dunder/引擎钩子 KBENGINE_HOOKS,默认关防误报)、getDefFileForPythonFile(Python 改动→重算属主 def 寻址);src/languageProviders.ts getLanguageFeatureConfig 加 3 键+buildPythonMethodSkeleton 形参自 def <Arg> 类型映射+CodeAction 附加 action.command=kbengine.defMethodConsistency.revalidate(应用编辑后重算,诊断消除);src/extension.ts 专用诊断集合 kbengine-def-method-consistency(整组替换)+独立调度器 defMethodConsistencyScheduler(主调度器每 URI 单排队槽,共享会顶掉主结构诊断任务致永不算——独立保版本/关闭代/输入代守卫,flush 同节拍、关闭 releaseDocument、enableDiagnostics 主开关同闸、defMethodConsistencyInputsChanged 三键 invalidateAll)+revalidate 命令注册+def/Python 文档事件双路调度;package.json 三配置键(checkDefMethodMissingInPython 默认 true/checkPythonMethodNotInDef 默认 false/entity.methodStubBody enum pass|raise 默认 pass)+命令声明;tests/defMethodConsistency.test.ts 14(注解映射/骨架/定位/\r\n/反向项/code 常量)+defMethodConsistencyGaps.test.ts 5(缺实现入列已实现不入列/缓冲区兜底/接口门控/属主寻址/反向跳钩子)+defMethodImplQuickFix.test.ts 更新(新骨架预期+revalidate 命令断言+raise 体配置)+extension.test.ts(诊断集合 4 条顺序)+perfCallChainDoc.test.ts(锚点漂移校正)+docs 四文件(中英 configuration.md 总览/features.md Settings 表加 3 键,commands.md 加 revalidate 命令节);门禁 pnpm lint+tsc 干净|test:unit 5271 绿 7 skip|xvfb test:demo:editor 25 passing)

- [x] **C-20 · P2 · 实现 · kode-python:Python 调用图与数据流(Rust)** · 已完成 0910ffe+15b8333+89723d4+4090e52+b74ac43+7284213；新 crate crates/kode-python（ruff_python_parser，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0348)
  - 依据 2026-11-01 用户确认缺失:Rust/TS 均无 Python 代码级调用关系与数据流(现有图仅 def→def 依赖)。
  - 集成:Python 解析用 ruff_python_parser(Rust 原生,不造轮子);新 crate kode-python:AST→符号/调用边提取。
  - 交付①调用图:函数/方法级 call graph + KBEngine 特化边(allClients/baseClients 广播边、cell/base 跨进程调用边,进程归属联动 C-17);②过程内数据流(MVP:def-use 链,变量来源与传播);③图入 kode-scheduler DAG,可视化挂 dependencyGraph 面板;④供 C-19 一致性检查复用 Python 符号表(替代自建)。
  - 验收:示例实体项目调用图与人工核对一致(抽样 10 条调用边);改方法签名→受影响调用点全数列出;增量更新(改一个文件只重算该文件)。
  - 后置:过程间数据流/指针分析不进本期。
  - 已完成证据(0910ffe):新 crate `crates/kode-python`(ruff_python_parser 0.0.20,MSRV 1.97 注):
    - 解析 `parse.rs`:`parse_unchecked_source` 容错解析 + LineIndex 行/UTF-16 列定位;
    - 符号表 `symbols.rs`:类/方法/属性/导入四表,识别装饰器/async/继承链/dotted base,`to_corpus()` 降级为 `kode_corpus::PythonModule`(C-19/wt-parity 复用面),`class_index` 查类方法;
    - 调用图 `callgraph.rs`:遍历方法体/模块函数/模块顶层;8 类 `EdgeKind`(Local/Method/SelfMethod/KbeBroadcast/KbeBaseClients/KbeCrossProcess/KbeApi/Unknown),`self.allClients/baseClients` 广播边、`self.cell/base` 跨进程边、`KBEngine.*` API 边;嵌套控制流(if/for/try)行走;
    - 数据流 `dataflow.rs`:过程内 def-use 链(直线 MVP,重定义开新链,self.attr 跟踪,param 标注);
    - 图聚合 `graph.rs`:`PyCallGraph`(callers_of/calls_of/of_kind)+ `build_call_reverse_index` 被调方文件→调用方文件集;
    - 接入 kode-scheduler `invalidation.rs`:`InvalidationGraph::with_call_dependents` + `affected_by` 并集调用方反依赖(泛型 `CallReverseIndex` 消费,保持 scheduler 零第三方依赖);
    - 验收:74 套件 391 测试全绿(含 kode-python 4 测试文件 + scheduler 2 新反依赖测试);`cargo clippy -p kode-python -p kode-scheduler --all-targets --no-deps -- -D warnings` 干净。
  - 未完成(如实标注):交付③「可视化挂 dependencyGraph 面板」只完成 DAG 反依赖数据侧,面板 UI 挂载未在本批——属前端渲染面,待后续批次。

- [x] **C-21 · P2 · 实现 · KBEngine API 文档 hover(双语 i18n)**(2026-11-07 完成,21d0ffc7)
  - 交付①嵌入式 API 文档库:✅ 225 条(base 91/cell 68/client 46/bots 11/server 11/interfaces 9/core 3;entity 73/KBEngine 139/proxy 12/constant 1),每条含签名/双语摘要(en 217 有文,zh 95)/溯源锚(kbe/src file:line)/来源页;正本 = `docs/knowledge/api-*.md`(KB-API 批次源码 grounding 页,即「人工精校」的落地形态)经 `scripts/generate-api-docs.mjs` 确定性抽取,`crates/kode-server/assets/api-docs.json`(kode-server 嵌入,`$/kode/apiDocs/lookup` RPC 可查)与 `src/generated/apiDocs.ts`(TS 镜像)同源双产物,`tests/apiDocsParity.test.ts` 锁逐条一致 + `--check` 防漂移门禁。如实边界:参数说明/返回/示例/引入版本知识页未结构化,不单列不编造;8 条源表无语义列的条目摘要留空。
  - 交付②hover 渲染:✅ 四类触发点全接(`kbengine.hover.apiDocs`,默认开):A. `KBEngine.<api>` 成员访问、B. 内建属性/通道 hover 追加段 + def 声明方法 hover 追加段(命中才非空,不覆盖既有注解)、C. 生命周期回调 `def onX(...)` 声明行;渲染=签名代码块+面/类别行+本地化摘要+源码锚;排在 kbe 模块符号(SP-2)与实体 hooks 面之后,已有更详实 hover 的符号不被覆盖。查询语义(与 Rust 同口径):面精确优先(脚本目录→base/cell/client,client 另试 bots)→唯一 owner 回退→多面同名如实出「多个进程面都有定义」绝不静默挑一个。
  - 交付③i18n:✅ locale 走 `kbengine.hover.language` 既有面(hoverLocale 解析),zh 缺失回退 en 并带 `_(en)_` 如实标注。
  - 验收:✅ 单测锁 = tests/pythonApiHoverDocs.test.ts(查询语义/触发点位置判定/渲染/locale 回退/库地板)+ tests/apiDocsParity.test.ts(双产物一致+生成器零漂移+回调 onXxx 形态纪律)+ Rust 6 单测 2 烟测 + parity golden 重录(hover.builtin-property-databaseID 增补段=设计行为)。如实边界:「对官方 API 清单>=95%」未做全清单对账(官方 CHM 清单未在本仓库结构化);覆盖口径=知识页已 grounding 的 API 面 225 条。
  - 门禁:eslint 0/tsc 0/unit 584 文件 7171 过+2 skip/cargo workspace(--exclude kode-scheduler)104 套全绿/xvfb demo 25 RC=0。
  - 协同:与 P0-A 类型桩同源互补(补全=签名,hover=文档)✅ 同库共享;usage 统计指导优先级未做(后续需要再说)。
  - 锚点:languageProviders.ts 编辑后真位重探 871/961/1852/1911/1935/2063/4812/5220/5326/7170,perfCallChainDoc+2026-baseline.md 锁步。

- [x] **KB-001 · P2 · 建设 · KBEngine 源码解析知识库（双语,人机共用）**
  - 首批头号专题（用户点名的重灾区，2026-11-01）：内存对象引用与释放——实体对象生命周期引用规则、cell/base 迁移后引用失效语义、destroy 后 Python 侧持引用的行为、timer/Functor 持引用与回收、跨进程引用（cellData 快照 vs 活对象）等，逐坑整理：现象/根因（带 kbe/src 源码引用）/正确姿势。用户多次踩坑，经验最密集的区域。
    - ✅ 交付（2026-11-07,feat 65f94116）:头号专题五项全覆盖——生命周期/引用/garbages/定时器=entity-lifecycle-reference.md(增补「Functor 之问」节:KBEngine 无 Functor,持有者=PY_CALLBACKMGR 强引用+超时回收+迁移 pickle,`callbackmgr.h:215`);迁移/传送+cellData 快照 vs 活对象+EntityCall 失效语义=entity-migration-and-cross-process-references.md(新文,锚定 kbengine@3082ab5,跨 cellapp 全消息流 ghost 化→base 暂存→cellEntityCall_ 原地重定向→重建/恢复,HEAD 实际触发回调表:base 面 onTeleportSuccess/onTeleportFailure 是死路径(唯一发送点恒传 fromCellTeleport=true),cell onTeleport() 无调用者)。
  - 知识源交叉引用（2026-11-01 盘点）：CPython 地基直接链接 hello-python/docs/internals/ 的 10 篇源码级分析（object-model/memory-management/gc-module/type-system/eval-loop 等，不重写）；KB-001 内存专题 = CPython 引用计数/GC × KBEngine 托管引用的交叉解释。
  - 扩展域（后续批次）：①KBEngine Python 绑定层源码分析（API 暴露机制/entity 基类机制/属性 __init__ 前赋值的引擎侧根因/脚本加载与热重载实现）；②KBEngine C++ 进程内部（baseapp/cellapp/dbmgr 源码机制）；③BigWorld-Engine-14.4.1 遗产源码（cell 机制血统）；④协议交互序列（握手/重连/迁移时序）；⑤历次会话分析结论收割（C-22/C-23 已部分入账）。
  - 依据 2026-11-01 用户令:「整理出源码解析出来的知识经验」。把历次分析 KBEngine 源码积累的知识结构化沉淀,不是会话记录,是可检索、可维护、喂给 hover/MCP 的资产。
  - 结构(docs/knowledge/,双语 en+zh):
    ① API 知识:逐条 KBEngine API——签名/语义/用途分类(定时器/实体通信/客户端广播/持久化/空间移动/日志/全局数据)/使用示例/坑(与 C-21 文档库同源,共享一份)
    ② 引擎机制文档:实体生命周期(创建→cell 迁移→销毁)、cell/base 划分语义、空间与移动、定时器精度与语义、消息与 bundle 机制、dbmgr 持久化流程——每篇含源码位置引用(kbe/src 文件:行)
    ③ 使用模式与统计:官方资产/真实项目的 API 使用频率与组合模式(usage 统计扫描已起步)
    ④ 踩坑经验:分析过程中发现的语义陷阱(如软保底 off-by-2 类)、易误解行为
    - ✅ 交付:②首轮全落地(lifecycle+迁移/传送+启动流程+入口 SPI+目录路径,baseapp 路径细节仍为记录在案的后续 TODO);③=scripts/kbe-api-scan.py(AST 解析,仅标准库,确定性排序)+api-usage-stats.md(77 文件 0 解析错误;引擎已知 vs 项目自定义回调划分≈1/3 项目自定义;如实边界=仅本仓库两树,官方示例/真实项目扩大属后续);④=traps-index.md(全知识页单行陷阱索引,内存/迁移/定时器/EntityCall/回调命名/client 面/源材料卫生,每行链到承载 grounding 的文章)。
  - 流水线:扫描脚本(kbe-api-scan.py 起步)产出原始数据 → 人工精校成知识条目 → 喂 C-21 hover 文档库 + MCP-001 explain/guide 工具 → 知识条目带源码引用可点击跳转
    - ✅ 交付:kode-mcp 增 explain 工具(crates/kode-mcp/src/explain.rs,第 8 个工具)——API 面直调 kode-server C-21 共享库 api_docs_lookup(与 hover/RPC 同源零复制);机制面=编译期 include_str! 内嵌 5 篇机制文+关键词索引(精确=3 分/互为子串=2 分,前 5),返回标题/双语路径/锚定提交/摘要/章节标题;双面皆空如实返回空+提示绝不编造;单测 6 例+e2e 工具清单 8 个+cellData 双面命中断言。
  - 验收:API 知识覆盖官方 API 清单 >=95%;每篇机制文档带源码引用;双语;MCP 挂 explain 工具能回答「XX API 怎么用/XX 机制怎么运作」。
    - ✅ 每篇机制文档带源码引用(全部 file:line 逐条锚定,新增件锚 kbengine@3082ab5);✅ 双语(en+zh 双树同构,VitePress 双侧边栏已挂);✅ MCP explain 工具(API+机制双面,e2e 验证真数据);如实边界:「>=95% 官方清单」无结构化官方清单可对账(官方 CHM 未入库),覆盖口径=知识页已 grounding 的 API 面 225 条(C-21 同一边界,已记录);③ 统计口径=本仓库两树非官方资产普查。README 状态表/依据规则/文章索引同步对账。
  - 门禁:eslint 0/tsc 0/unit 584 文件 7171 过+2 skip/cargo workspace(--exclude kode-scheduler)104 套全绿(含 kode-mcp 11 单测+3 e2e)/docs:build rc=0(死链检查过)/xvfb demo 25 RC=0。
    - ✅ 收编入账（2026-11-07,PR #38,squash 43bf441c）:本条交付由陈旧伞形 PR #31(feat/demo-game)分拣收编——KB-001 三 commit(65f94116+两 docs tick)自 feat/demo-game cherry-pick 至最新 main(干净落地,冲突面零残留),经 PR #38 合入,CI 全绿(build ×2+rust-coverage ×2+codecov pass;首跑 rust-coverage 红=clippy 1.99 manual_map,explain.rs headings_of 改 strip_prefix().map() 后复跑绿)。同分支 C-22/C-23 实现(fcdab71f/c915f6a3)弃置未收:基于 KB-API 分解前旧 main,与现状 40+ 源文件冲突,两任务 ledger 保持开放待在最新 main 重做;demo 001-005 早已经 #23/#24/#26/#32 入 main 无残留。#31 已关。

- [x] **C-22 · P2 · 实现 · def 属性的可视化呈现(设计已定,2026-11-01)**(106e5855 重做落地:旧实现在已弃 feat/demo-game 分支(fcdab71f,拆分前旧 main),按设计在当前 main 新写,未拉旧代码。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0349)
  - 背景:KBEngine 属性在 __init__ 之前由引擎赋值,Python 侧不可见不可跳转;曾考虑「__属性方法集中声明」方案,因引擎不调用、双事实源漂移、与真实初始化时序矛盾而否决(设计结论记录于本条)。
  - 交付①:.pyi 桩生成器(P0-A)把 def 属性生成为类注解属性(类型+def 行号锚点),跳转可达、改 def 自动再生;
  - 交付②:LSP「跳转到定义」对 def 属性用法(self.hp)直接指向 .def 的 <Properties> 行(单一事实源);hover 同时显示 def 声明与推断类型;
  - 交付③(可选视觉增强):__init__ 注释锚 # kode:props-from-def 处以 inlay hint 折叠渲染 def 属性只读视图(纯渲染,非代码)。
  - 原则:属性唯一事实源=def;一切方便理解的呈现走生成物或渲染层,不在 Python 源码造第二事实源。
  - 验收:self.hp 跳转直达 def 行;pyi 再生与 def 同步(改 def ≤1 周期内更新);零误导(无引擎不调用的死代码)。

- [x] **C-23 · P2 · 实现 · 行为知识工具化(坑→lint/code action/hover 流水线)**(本批落地:交付①结构化=src/knowledge/trapsKnowledge.ts,KB-001 条目带 applies_to/detection/fix/source 四字段+双语注记,6 条(detection 非空 3 条=lint 候选,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0350)
  - 背景 2026-11-01 用户例:「属性修改只有顶层 key 才触发事件」这类行为知识无法在代码里体现,只能踩坑后知道。目标:把 KB-001 知识条目升级为开发者工具可执行的三通道呈现。
  - 交付①KB-001 条目结构化:每条知识增字段 applies_to(适用属性类型/API)/detection(可静态检测的代码模式)/fix(正确姿势与修复代码);detection 非空的条目自动成为 lint 规则候选。
  - 交付②首批 lint 规则(接入现有 lint/diagnostics 体系):
    fixed-dict-nested-mutation:FIXED_DICT 属性子键赋值不触发同步 → warning+code action(一键整体重赋习语);类型判定复用 kode-types 类型图;
    destroyed-entity-reference:检测 Python 侧对已 destroy 实体的常见引用模式(KB-001 内存专题配套);
    timer-leak-on-destroy:addTimer 句柄未在 onDestroy 注销的模式检测。
  - 交付③hover 行为注记:FIXED_DICT/易坑 API 的 hover 附加行为警告段(数据源=KB-001 结构化条目)。
  - 验收:三个规则各配正反用例(误报=0);hover 注记双语;规则可用配置关闭。

- [x] **C-24 · P2 · 实现 · 配置开关效果文档流水线(开关前后截图+动态图,用户令 2026-11-01)**(本 commit 完成:流水线 `scripts/config-switch-gifs/generate.py`(Xvfb 真实 VS Code+kode vsix+demo 资产工作区,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0351)
  - 交付①配置效果清单:枚举全部「开启后有效果」的配置项(VSCode contributes 配置点+引擎侧开关),标注效果可见面(编辑器/面板/行为)。
  - 交付②自动截图流水线:@vscode/test-electron 可编程驱动——起扩展主机→写配置 on→稳定后截图→写配置 off→截图;行为类开关(如热重载)录过程多帧;ffmpeg 缝合动态 GIF。
  - 交付③文档页:docs 增「配置效果」页,每开关=说明+off/on 静态图+动态 GIF(VitePress 直接嵌),双语。
  - 验收:清单内每个开关都有 off/on 图+GIF;流水线重跑可再生成(配置变更不腐化);流水线兼作配置效果回归测试。
  - 顺序:流水线基建(约半天)→逐开关出图(每个几分钟)。

## KBEngine 协议分析器（用户令 2026-11-01，源 ChatGPT 架构评审+代决拍板）

  - 技术决策:Rust=唯一协议语义实现(kode-kbengine-schema/protocol/analyzer 三 crate 入现有 workspace);Wireshark/TShark 仅展示与采集适配层;CLI 先行、插件最后接;MVP=Client↔Server TCP;不建独立 WireLens 仓库;许可证边界=Rust 核心 Apache-2.0,Wireshark 插件单独处理 GPL-2.0。
  - 与 C-15 关系:C-15 线格式编解码器=Phase 2 的类型系统基础;但静态消息表假设在真实连接不成立(登录动态导入协议映射),PA-001 取证后校准。

- [x] PA-001 [P1] Phase 0 协议源码取证；验收：产出 docs/kbengine-wire-protocol.md（Wire Protocol Specification），每条结论带 kbe/src 源码 file:line+真实报文样本，查不到的标 TODO 不编造。范围：定基线引擎版本；客户端 MessageReader/服务端 PacketReader；消息 ID 分配机制（静态 fixed defaults+登录动态导入）；固定/可变/扩展长度（>65534 用 65535 标记+4 字节实长）；packetAlwaysContainLength 配置；字节序/字符串 Unicode/自定义类型编码；登录-协议导入-EntityDef 导入流程；加密/压缩/连接切换；生成测试报文与 PCAP 样本。同步产出：C-15 需修订点清单。前置：无。
- [x] PA-002 [P1] Phase 1 Schema 引擎（新 crate kode-kbengine-schema）；验收：从真实 KBEngine 项目自动生成完整协议 Schema（JSON+Hash+版本兼容检查）。复用 kode-parser/kode-types/kode-vfs；解析 messages_fixed_defaults.xml+项目 messages_fixed.xml+全部 .def+types.xml/alias.xml/entities.xml；构建 Wire Type Layout（独立于现有类型图，类型图≠网络序列化规则）；Schema IR+Golden 测试。前置：PA-001。
- [x] PA-003 [P1] Phase 2 协议引擎（新 crate kode-kbengine-protocol）；验收：完全脱离 Wireshark 的 KBEngine 协议解析库，Fuzz+边界测试绿。模块：cursor 零拷贝/framing 三种长度+TCP 粘包拆包/message ID 静态+动态映射/codec 基础类型/containers ARRAY+FIXED_DICT/entity 属性方法/session 每 Flow 独立/handshake 协商/diagnostics 偏移定位/schema 编译缓存。红线：失败不 panic/不越界/内存有上限/递归类型有界/未知类型 Raw 保留。MVP=Client↔Server。前置：PA-002。
- [x] PA-004 [P2] Phase 3 CLI（kode-kbengine bin）；验收：schema validate/build/diff/inspect、decode --hex、capture analyze（支持 stdin pcap 流式）；PCAP 输入层先复用 TShark 成熟能力。前置：PA-003。
- [x] PA-005 [P2] Phase 3 分析引擎（新 crate kode-kbengine-analyzer）；验收：独立分析一组解码消息出 JSON 报告。能力：消息/流量统计、请求响应关联（仅协议确证标识，不拿相邻猜对）、延迟 P50/P95/P99、异常检测（未知消息/非法长度/Schema 不匹配）、Entity 事件与 RPC 时间线、连接分析（登录/切 Baseapp/重连）。前置：PA-003。
- [ ] PA-006 [P3] Phase 4 Wireshark/TShark 集成；验收：能加载并解析 KBEngine 报文的原生插件（或 C 适配层）。先验证 libwireshark Rust 绑定（现 alpha 0.0.0，按 Wireshark 版本分别构建）六项能力；不满足启用 C Thin Adapter（C 只做注册/重组/协议树映射，解析全在 Rust）。GPL 边界：插件独立 crate+独立许可评估，不混入 Apache VSIX。前置：PA-003（核心稳定后接）。
  - 绑定六项能力实勘完成（2026-11-08，docs/design/pa006-wireshark-plugin.md）：libwireshark 0.0.0-alpha.0 六项 API 面全齐（Dissector/Binding 注册、PacketView 字节、Header derive 树、TcpFraming 重组含 65535 扩展长度形态、Preferences、会话状态），本机 tshark 4.6.4 编译干净 + KBEngine 线格式 spike（2 字节 LE+65535 标记+4 字节实长）编译出 cdylib + 真实 tshark -G plugins 加载成功（装→验→删）；**判定=走 Rust 插件，C Thin Adapter 裁撤**。跨系统实勘=Ubuntu AppArmor 拦个人插件目录（须全局目录/档案覆盖）+插件目录禁 group 可写 + OS×Wireshark 版本矩阵交付（PA-007 版本检测为此设，CLI capture analyze 零 ABI 兜底）。不勾账：插件本体（字段树/会话状态/真实 pcap 验收）待后续批次。
  - 正式插件 crate + 真实 pcap 端到端完成（2026-11-08，feat 41a30e2e，docs/design/pa006-wireshark-plugin.md 第二增量节）：`plugins/wireshark-kbengine/`（独立 GPL-3.0-or-later workspace，cdylib，clippy 0，release 1.0MB，ABI 符号齐）；解析单源=插件 `tcp_framing() None` 直喂 `Flow::feed_direction`（插件零解析逻辑），首遍推进+重放复述摘要缓存，Expert 面 framing_error/unknown_message；首选项 loginapp_port/baseapp_port/defaults_xml（空表全 unknown 与 CLI `--defaults` 缺省同口径）。真实 pcap（login-flow 6 帧，`-o kbengine.loginapp_port:2001`）装→验→删闭环：两模式 `-Y kbengine` 均 6/6 命中；**与 CLI 同源对照逐帧一致**（named：插件 4 解码出消息名+2 framing reset ⇔ CLI 4 records+2 anomalies；unknown：插件 6 UnknownMessageId reset ⇔ CLI 0 records+6 anomalies）——插件忠实转发协议 crate 行为零差异；帧 4/5 reset 归因=合成样本 body 与静态表签名既有不一致（CLI 同报，PA-003/PA-004 遗留面，挂账非插件回归）。不勾账：有类型字段树（Header derive）、Windows/macOS 实机加载。
  - 有类型字段树完成（2026-11-08，feat b3f592ff，docs/design/pa006-wireshark-plugin.md 第三增量节）：数据面=协议 crate `decode_spans`/`SpanKind`/`ValueSpan`（`decode_inner` 跨度镜像：同读序/同 Budget/深度/数组预检/同错误文本；EntityCall/Unresolved 不推进游标 Raw 覆盖剩余），`tests/span_units.rs` 8 例对拍锁定全绿；渲染面=插件手工 `Header` impl（derive 不适用动态区间）18 注册字段（msg_id/msg_len/msg_len_ext + arg_bool/arg_u8..u64/arg_i8..i64/arg_f32b/arg_f64b 字节面/arg_str/arg_bytes/arg_raw/arg_group 递归），帧树按帧号缓存重放遍复述，偏移真校验（`fed` 计数+tvb 帧头 2 字节==id 小端，复位脱节帧如实不出树）。真实 pcap 装→验→删闭环：`-V` 树 4 帧（msg_id×4/msg_len×3/arg_str×7/arg_group×2），`-T fields` 提取帧 1=`0x0004|18|2.5.10,2.5.10`、帧 6=`0x01f6|26|player1,127.0.0.1` 与样本语义一致，复位帧 4/5 无树，unknown 模式 0 树，两模式 `-Y kbengine` 6/6 回归；诚实边界=dict 键名/array 下标不出树（alpha 无 proto_item_set_text）、浮点字节面不解值。不勾账：Windows/macOS 实机加载。
- [ ] PA-007 [P3] Phase 5 Kode 集成；验收：用户零手动配置。Protocol Analyzer 命令+协议管理面板；Wireshark/TShark/插件版本检测；Schema 自动生成与协议文件变化监听（仅协议定义文件触发重建，Python 业务变更不触发）；一键开 PCAP/跑 TShark；Schema 版本提示+错误诊断。前置：PA-004、PA-006。
  - 第一增量：工具链检测命令（2026-11-08，不勾账）：`kbengine.protocol.showStatus` + `kbengine.protocol.tsharkPath|wiresharkPath|cliPath` 配置（src/protocolTooling.ts + src/protocolToolingDetect.ts 纯函数解析面，fixture=本机 tshark 4.6.4 实测字节）；CLI `--version` 契约（crates/kode-kbengine，一行 `kode-kbengine <semver>`，黑盒 2 例）；检测面=tshark 版本/Wireshark GUI（缺席如实）/插件目录/KBEngine 插件三态版本线核对（匹配/不匹配/未知）/CLI 自动发现；全部探测失败收敛「未检出」不抛；报告恒带 CLI 零 ABI 兜底提示。不勾账余量：Schema 自动生成+协议文件监听、一键开 PCAP/跑 TShark、协议管理面板、Schema 版本提示+错误诊断。
  - 第二增量：Schema 建图+协议文件监听（2026-11-08，feat 805c75c6，不勾账）：`kbengine.protocol.buildSchema` 命令跑 `kode-kbengine schema build --project <资产根> --out <globalStorage>/kbengine-schema.json`（src/protocolSchemaSync.ts:计划面 resolveSchemaBuildPlan 三环如实归因——CLI 未检出/探测失败/资产根未检出，执行面 runProtocolSchemaBuild 失败归因 stderr→stdout→退出码，串行器 createSchemaBuildScheduler 在途不重入+尾随一份最新计划不排队放大）+ `kbengine.protocol.schemaAutoBuild` 配置（默认开）=协议定义文件 watcher（`**/*.def`/`**/types.xml`/`**/entities.xml`/`**/alias.xml` 四 glob，Python 结构性不在清单——「仅协议文件触发」是装配面结构保证非运行时后判）×项目根过滤（复用 kbengine.assetsRoot 发现链 memoized，根外事件不触发防 fixture 误建）×共享合并器防抖×串行器；激活零子进程（首次生成=首个协议文件事件或手动命令）；自动面失败只落「KBEngine Protocol Tooling」通道防刷屏，手动命令面才出通知；tests/protocolSchemaSync.test.ts 15 例（计划 5/执行 2/串行器 2/装配 3/装配入口 3）。不勾账余量：一键开 PCAP/跑 TShark、协议管理面板、Schema 版本提示+错误诊断。
  - 第三增量：一键开 PCAP/跑 TShark（2026-11-08，feat f9093142，不勾账）：`kbengine.protocol.openPcap`（选 pcap/pcapng/cap → `kbengine.protocol.wiresharkPath` 拉起 GUI；自带无超时 runner——检测面 5s 超时会杀刚拉起的 GUI；未检出/非零如实警告带配置键提示，GUI 正常打开即成功反馈不刷通知，启动记录落通道）+ `kbengine.protocol.analyzePcap`（选文件 → `kode-kbengine capture analyze --pcap <file> --tshark <tsharkPath>` 零 ABI 路径，CLI 报告原文落「KBEngine Protocol Tooling」通道不摘要不再排版；CLI 未检出/探测失败与 buildSchema 同口径如实警告；分析失败归因 stderr→stdout→退出码；分析面自带 120s 长超时——大 pcap+tshark 两跳不适用 5s 探测预算；对话框取消=零动作）（src/protocolPcapActions.ts，tests/protocolPcapActions.test.ts 9 例：取消双面/GUI 参数契约/ENOENT 警告/非零 stderr 归因/CLI 参数契约+原文落通道/失败通知/装配注册+真实 deps 未检出路径）。不勾账余量：协议管理面板、Schema 版本提示+错误诊断。
  - 第四增量：Schema 版本提示+错误诊断（2026-11-08，feat a5480802，不勾账）：`kbengine.protocol.showStatus` 报告末尾带 Schema 状态段（读 `globalStorage/kbengine-schema.json`）：已生成 → IR 版本/引擎基线/消息·实体规模/缺失实体/构建诊断原文逐条（SYNTAX-005 同规——坏输入保留为可定位诊断不冒充通过,本段即错误诊断面）;未生成 → buildSchema 提示;读取失败 → 带归因;字段逐个防御提取,无 globalStorage 面如实按未生成（src/protocolSchemaSync.ts `readSchemaState` + protocolTooling.ts render Schema 段;真实样本锁定=本机 CLI 对 templates/demo-game 实建 schema JSON,键面 schema_version/engine_baseline/entities/missing_entities/messages{entries,diagnostics}/diagnostics 与 CLI canonical 序一致;tests/protocolSchemaSync.test.ts readSchemaState 6 例+tests/protocolTooling.test.ts Schema 段 5 例）。不勾账余量：协议管理面板（无设计锚,待设计与用户拍板）。

## KBENGINE 属性默认值守卫规则(用户令 2026-11-02,源码已核实)

  - 源码结论:实体创建线引擎对所有 def 属性灌 newDefaultVal()(entity_macro.h:1616→property.cpp:200);FixedDictType::parseDefaultStr 恒建 FixedDict(datatype.cpp:2570,子键递归 2623/2639);FixedArrayType 空默认→[](1823);MySQL 列 not null DEFAULT(db_mysql/entity_table_mysql.cpp:522)。创建线复杂类型不产 None。
  - 生成器口径:__init__ 初始化守卫用 `if self.xxx is None:`(防手工改库/迁移缺列/外部 delattr/stub 脱离引擎);仅对 FIXED_DICT/ARRAY 等引用型生成;简单类型不生成;禁 `if not self.xxx:`(falsy 判断会把引擎合法默认 0/""/[] 误判并重建,引用失效)。

- [x] GEN-DEF-1 [P1] pyi/stub 生成器 __init__ 守卫按上述口径改造;验收:生成的实体类中 FIXED_DICT/ARRAY 属性生成 is None 守卫、简单类型无守卫、全仓无 `if not self.` 形态守卫;现有生成物全量重生成 diff 审计;测试绿。(14cc783;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0352)
- [x] GEN-DEF-1a [P1] GEN-DEF-1 补充:stub 注解去 Optional——def 属性声明类型一律非 Optional(源码已核实创建/装载线恒非 None),现有 List[X] | None 形态全量改为 List[X];验收:重生成后 .get/.append 等调用无 None 警告。(19ebcd7;随 GEN-DEF-1b 合并交付,def 属性注解现为 FixedArray[T]/FixedDict/内建直译,无 `| None` 形态)
- [x] LANG-NAR-1 [P1] 语义引擎流敏感窄化:`if self.X is None: self.X = expr` 后属性类型收窄为 expr 类型;__init__ 内赋值参与属性类型收敛(声明∪赋值);验收:用户场景 self.TalentTree.is None 守卫后 .get 无 List|None 警告,__init__ 初始化后同样无警告;带测试。(7821bef;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0353)
- [x] GEN-DEF-1b [P1] stub 内定义 KBEngine 运行时容器类型:FixedArray[T](script::Sequence 语义:append/extend/insert/pop/remove/index/count/clear/切片/迭代,元素类型受检)+FixedDict(script::Map 语义:键集合按 def 固定,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0354)
- [x] GEN-DEF-2 [P1] 新建实体向导:资源管理器 entity_defs 目录右键/命令面板「New KBEngine Entity」→输入实体名→一键生成:①entity_defs/<Name>.def(骨架:CELL_DATA 常用属性示例/TEMP 属性,属性模板可选简单类型/FixedArray[T]/FixedDict);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0355)
- [x] GEN-DEF-1c [P1] 全类型映射表落地 stub:16 种 DATATYPE(common.h:89-104)按源码确认的运行时对象生成注解——VECTOR2/3/4→KBEngine.Vector2/3/4;PYTHON→解析 def 的 impl 声明(模块.类,datatype.cpp:2346-2353)生成精确类型,无 impl 才 Any;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0356)
- [x] GEN-DEF-1d [P1] KBEngine API 索引条目国际化:FixedArray/FixedDict 等所有 API 条目 summary 必须双语(en+zh 双字段或 locale map),hover 按 IDE 显示语言选择,缺语言 fallback 英文;存量只写中文的条目全部补英文;数据模型层强制双语字段(缺一不可,构建校验)。验收:切换 IDE 语言 hover 中英都正确;单语条目触发构建报错。 (625c738;KbeSymbolEntry 加 summaryEn 必填字段(TS 类型级强制双语),summaryForLanguage 按 IDE 语言选文案(zh 前缀取中文,其余英文),35 条全量补英文,桩 docstring 中文段+EN 段并陈,补全/hover 面按语言选择;门禁 unit 5344|7+lint+tsc+demo 25/25 全绿)
- [x] GEN-DEF-1e [P1] user_type 三契约索引+诊断+数据流方向建模:①types.xml user_type→impl 类→三契约方法(createObjFromDict/getDictFromObj/isSameType,datatype.cpp:2383-2397)建索引;②诊断:impl 类缺任一契约方法→编辑期标错(引擎启动必炸);… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0357)
- [x] KBEXP-1 [P2] 启动参数与启动脚本分析面:索引 KBEngine 各进程启动参数(源码解析入口,KB-001 第六篇产出参数表)与启动脚本链(engine_config/脚本时序);①hover/补全:在 .sh/.bat/启动脚本与 engine_config.xml 中提示参数名与含义;②诊断:脚本中参数拼写错误/缺必要参数时提示;③文档区收录参数速查表(双语)。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0358)

## 审核发现 2026-11-03（0ac2586e..HEAD）

- [x] 审核发现：进程拓扑诊断调度器被喂 queued 任务但 flushQueued 从未被调用——编辑期 def/entities.xml/process_topology.xml 变更经 scheduleProcessTopologyDiagnostics(…,'queued') 入队后无人冲刷,拓扑诊断只在 open/save/开关路径(immediate)更新,「def 变更→拓扑校验」的编辑期联动是死的(src/extension.ts:1754/1856/1860/1863/1909-1916)。（与 KODE-AUD-001 重复：07548e1 已修——编辑冲刷周期补 processTopologyScheduler.flushQueued(),tests/processTopologyFlush.test.ts 集成测试,2026-11-04 复核勾）
- [x] 审核发现：C-19「一键生成方法骨架」CodeAction 永不触发——KBEngineDefPythonParityCodeActionProvider 只认 diagnostic.code==='def-method-missing-in-python',但 Rust 合流路径 mergeRustDefFindings 构造 Diagnostic 时从未设 .code,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0359)
- [x] 审核发现：HotReloadTargetStateStore.record 的代际写回分支丢弃 options.sentDigest(只落 outcome/recordedAt/detail),发送时点冻结的 digest 永不进台账,hotReloadFileState 依赖 record.sentDigest 的 FAILED──文件改──▶DIRTY 转换与 applied 基线解析全部失效,已应用文件恒标 DIRTY(src/hotReloadTargetState.ts:92-107/121-122；src/hotReload.ts:372-378；src/hotReloadRetryCommand.ts:138；src/hotReloadFileState.ts:115/125/194-195)。（与 KODE-AUD-003 重复：02dd105 已修——hotReloadTargetState.ts:96 回执路径补写 sentDigest,代际守卫原样保留,tests/hotReloadTargetState.test.ts,2026-11-04 复核勾）
- [x] 审核发现：selfAttributeFlowTypes 的 scanSequence 不递归 else/except/finally 体——anyBlockOpen 正则缺这些子句关键字,findBlockEnd 停在子句行,更深缩进体被 thisIndent>indent 分支跳过,`if c: self.X=a else: self.X=b` 只收 then 分支,流注解错(src/selfAttributeFlowTypes.ts:112/291/343)。（与 KODE-AUD-004 重复：48d62f3 已修——anyBlockOpen 补 else/except/finally,typeOfExpr 字符串按 b/B 前缀分 bytes,tests/selfAttributeFlowTypes.test.ts 5 例,2026-11-04 复核勾）
- [x] 审核发现：globalDataIndex.runEditRecompute 在小型编辑(≤阈值)期间重读旧 editBuffers——noteSaved 小编辑走 commitFile 同步提交但不清 editBuffers,在飞大文件循环取消后 continue 又取旧大文本提交,覆盖刚提交的小编辑内容,索引停留旧内容直到下次编辑(src/globalDataIndex.ts:1857-1873/1901)。（与 KODE-AUD-005 重复：4d62ade 已修——noteSaved 同步分支提交前清 editBuffers,runEditRecompute 提交前源复核,tests/globalDataIndex.test.ts,2026-11-04 复核勾）
- [x] 审核发现：entityDependencyWebView.refreshCallGraph/refreshGraph 在 await 后未复检 this.panel 与 this.mode——面板在 RPC 在途时关闭(panel=null)会 TypeError 冒泡为「刷新依赖图失败」,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0360)
- [x] 审核发现：process_topology.walk_def 对 interface 来源跳过 visited 守卫(origin!="interface" 分支),接口环(A→B→A)无限递归栈溢出,父类/组件链有成环守卫而接口链没有(crates/kode-server/src/process_topology.rs:411)。（与 KODE-AUD-006 重复：6a2e005 已加 visiting/loading 活动栈守卫并带环测试，2026-11-03 复核勾）
- [x] 审核发现：def_md5 的 load_interfaces 与 load_parent_class 无任何环守卫,load_components 的 loaded_modules 在 load_def_info 末尾才置位,组件/接口/父类任一成环即无限递归栈溢出(crates/kode-server/src/def_md5.rs:730/1006/1045/1168)。（与 KODE-AUD-006 重复：6a2e005 已加 visiting/loading 活动栈守卫并带环测试，2026-11-03 复核勾）
- [x] 审核发现：wire_codec 的 STRING 编码接受内嵌 NUL(is_ascii 对 0x00 为真)写入 NUL 终止流,解码在首个 NUL 截断——encode(Str("a\0b")) 产出字节解码为 "a",往返静默损坏而非报错(crates/kode-server/src/wire_codec.rs:333-338)。（复核已修 fb8c9d0：encode Str 分支含 `s.contains('\0')` → Err(WireError::EmbeddedNulString 新变体),拒绝时不写部分字节;tests/wire_codec_units.rs wire_string_embedded_nul_rejected+wire_string_ascii_roundtrip;prove-red=旧码无变体测试编译红;wire_codec_units 14 例绿,2026-11-04 复核勾）
- [x] 审核发现：kode-python 数据流对 ExprContext 处理过严且不一致——AugAssign 目标以 Store 上下文进 collect_reads(Name 只记 Load)漏记 `x += 1` 的读取(与 self.hp-= 不一致);`del x` 以 Del 上下文进 collect_writes(Name 只记 Store)不 kill 链,与「视作一次重定义/kill」注释相悖;Subscript 存储 self.d[k]=v 被整体重定义且丢 self.d/k 读取(crates/kode-python/src/dataflow.rs:146-160/388-414)。（与 KODE-AUD-007 重复：b26396e 已修——AugAssign collect_reads 强制读旧值,Delete kill_var 终结链,Subscript 写补 collect_reads(value)+collect_reads(slice),tests/dataflow_test.rs 3 例,2026-11-04 复核勾）
- [x] 审核发现：kode-python 数据流 walrus 与推导式目标从不 def——(x := 5) 只读 n.value 忽略 n.target,`[i for i in seq]` 不遍历 gen.target,使用泄漏到同名外层链或丢弃(crates/kode-python/src/dataflow.rs:283/319)。（与 KODE-AUD-007 重复：b26396e 已修——collect_reads NamedExpr target 补 collect_writes,4 种 Comprehension gen.target 补 collect_writes,tests/dataflow_test.rs 2 例,2026-11-04 复核勾）
- [x] 审核发现：调用图漏收嵌套 def/class 体内调用(注释称「由外层类/模块面另行收集」但外层只迭代模块级与类直属体,实际无处收集)且 Match case.guard 不遍历,`case _ if check():` 的 check() 调用丢失(crates/kode-python/src/callgraph.rs:236/241)。（与 KODE-AUD-008 重复：dd869b5 已修——walk_stmt 嵌套 FunctionDef/ClassDef 改独立调用方,Match case.guard 补走查,tests/callgraph_test.rs 3 例,2026-11-04 复核勾）
- [x] 审核发现：symbols.collect_attributes 不递归 Stmt::Match(If/For/While/With/Try 均递归而 Match 缺),match case 体内 self.<attr> 赋值不入类属性表(crates/kode-python/src/symbols.rs:268)。（与 KODE-AUD-008 重复：dd869b5 已修——collect_attributes 补 Stmt::Match 分支,tests/symbols_test.rs match_case_self_attribute_collected,2026-11-04 复核勾）
- [x] 审核发现：graph.resolve_callee_file 把任意点号接收者首段按同名 .py 文件基线解析而不校验是导入绑定,`avatar.x()` 等普通对象方法调用对无关同名文件产生伪跨文件失效边,违背「宁缺毋滥,避免误失效」原则(crates/kode-python/src/graph.rs:102)。（与 KODE-AUD-008 重复：dd869b5 已修——resolve_callee_file 裸名先判调用方自身定义,find_module_function/find_module_file 排除调用方文件且恰一匹配才产,tests/graph_test.rs local_bare_name_no_cross_file_pseudo_edge,2026-11-04 复核勾）

## 代码审核发现（源 ChatGPT 代码审核 2026-11-03，基准 7b20c68e，5 项断言已实证）

- [x] KODE-AUD-001 [P1] 修复进程拓扑诊断 queued 队列不冲刷：extension.ts 编辑冲刷周期补 processTopologyScheduler.flushQueued()；验收：编辑 .def/entities.xml/process_topology.xml 后编辑期诊断更新、连续编辑只跑最新版、关文档不发过期诊断、补编辑事件进调度器的集成测试。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0361)
- [x] KODE-AUD-002 [P1] 统一 C-19 诊断 ID：defMethodConsistency.ts:21 的 kbengine.defMethodMissingInPython 与 languageProviders.ts:6143/6172 的 def-method-missing-in-python 严格比较不匹配致 CodeAction 恒空；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0362)
- [x] KODE-AUD-003 [P1] 热更新状态机代际写回丢失 sentDigest：hotReloadTargetState.ts:92-107 带 attempt 的回执路径未写 options.sentDigest；验收：FAILED→DIRTY 判定与 APPLIED 基线可用，旧 attempt 不污染新 attempt，发送/回执/确认/再编辑/重试全转换测试。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0363)
- [x] KODE-AUD-004 [P1] Python 流敏感分析补控制流：selfAttributeFlowTypes.ts anyBlockOpen 缺 else/except/finally，bytes 字面量误判 str；验收：if/elif/else、try/except/else/finally、提前 return/raise 分支合并正确，b'' 返回 bytes，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0364)
- [x] KODE-AUD-005 [P1] 修复 GlobalDataIndex 旧版覆盖新版竞态：大文件异步扫描与小文件同步提交时 commitFile 不清理 editBuffers 致旧内容回写；验收：大文件编辑→小文件保存→旧任务继续的竞态测试绿，commit/关文档/删除/dispose 均释放缓冲。（4d62ade;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0365)
- [x] KODE-AUD-006 [P1] Rust def 递归循环保护：process_topology.rs walk_def 与 def_md5.rs 的 load_interfaces/load_parent_class/load_components 缺活动栈保护，A→B→A 栈溢出；验收：visited/visiting 双集合统一保护三类关系，循环返回诊断不溢出，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0366)
- [x] KODE-AUD-007 [P1] 修复 Rust Python Dataflow AST 语义：dataflow.rs 漏 AugAssign 读、del、Subscript 容器元素、NamedExpr target、Comprehension target；验收：读/写/删/容器修改分别建模，AST fixture+golden 测试绿。。（b26396e;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0367)
- [x] KODE-AUD-008 [P1] 补 Rust Python 调用图/符号表遗漏：callgraph.rs/symbols.rs/graph.rs 漏嵌套 def/class、Match guard 调用、Match 属性写、跨文件伪边；验收：对应 fixture 测试绿，嵌套/分支/导入绑定用例覆盖。。（dd869b5;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0368)
- [x] KODE-AUD-009 [P1] HTTP 热更新探测去副作用：hotReloadTransport.ts probe() 直接用真实 method/body 会触发实际重载；验收：probe 与真实 fire 请求分离，探测无副作用测试。（a7786a7;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0369)
- [x] KODE-AUD-010 [P1] wire_codec STRING 拒绝内嵌 NUL：kode-server wire_codec.rs:333-338 NUL 终止符致静默截断；验收：拒绝非法输入+编解码往返测试。（fb8c9d0;实现=encode Str 分支 `s.contains('\0')` → Err(WireError::EmbeddedNulString 新变体,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0370)
- [x] KODE-PERF-001 [P1] 流敏感分析按文档版本建缓存：同版本只解析一次 AST，Hover/InlayHints/Diagnostics 共享；验收：访问点增多不重复解析，万行级性能测试。（b4f80f4;实现=selfAttributeFlowTypes parseWithVersionCache 键控 LRU(上限 8,命中触碰尾,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0371)
- [x] KODE-PERF-002 [P1] 消除流诊断平方级行号计算：slice(0,match.index).split() 改一次行起始偏移表；验收：10 万行文件诊断耗时实测对比。（3629636;实现=selfAttributeNoneDiagnostics buildLineStarts 一次行起始偏移表(每 '\n' 后一位置)+双指针推进(g 正则匹配 index 单调递增,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0372)
- [x] KODE-PERF-003 [P2] 清理 GlobalDataIndex 编辑缓冲的内存占用（与 AUD-005 同文件，串行做）。（b645b33;实现=GlobalDataIndex runEditRecompute 收敛提交位(revision+generation 双查通过、文本全量已索引进 cache)释放 editBuffers 大文件快照 delete(fsPath),… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0373)
- [x] KODE-PERF-004 [P2] Python CallGraph 收集支持多 workspace 根、异步读取、超 10,000 文件明确策略；验收：多根工程结果完整、宿主不阻塞。（06c64e8;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0374)
- [x] KODE-PERF-005 [P2] entityDependencyWebView 异步刷新加 generation/取消守卫；验收：关面板/切模式后旧 RPC 结果不写入。（1403e72;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0375)
- [x] KODE-PERF-006 [P2] 测量进程拓扑全量诊断成本：连续编辑/取消/批量 def 输入下的 CPU 与事件循环延迟，落 perf 报告。（e60c6b9;实现=测量面 tests/processTopologyPerf.test.ts(合成 workspace=5 进程清单+entities.xml+N 真实形态实体 def,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0376)
- [x] KODE-HOT-001 [P1] ReloadTransport 实际接入 hotReload.ts fire 路径（现有只在定义与测试出现，发送仍走 runAction）；验收：HTTP/Telnet 两传输真发、配置选择/参数校验/回执/状态记录闭环。(b1d19f4;取证=fire 路径接入 main 已大体落地,缺口在验收面——补 hotReloadFireTransportClosure 走生产 profile 链(ProjectProfileStore 读回→setActiveProfile→resolveReloadTransport)驱动真实 HttpReloadTransport(占位/targetId+sender_digests/applied 双证落台账)与官方通道(控制台真发绝不 claim applied)+畸形段回落+源锁;vitest 6979/0;codex 2 轮 PASS)
- [x] KODE-HOT-002 [P1] 热更新状态机全转换验收：sent/accepted/applied/failed/DIRTY/RESTART_REQUIRED 每个转换带测试。(零改动;既有 hotReloadFileStateTransitions 即全转换矩阵逐边 10/10 无 skip,台账层四态另有 wiring/applied/receipt 覆盖)
- [x] KODE-FEAT-001 [P2] 评估 .def 原生 formatter（与 XML 解析器共享语法事实），先出评估结论再定实现。（评估文档已先行落盘 docs/design/def-formatter-evaluation.md;2026-11-07 核对结论=结论仍成立:结论「可行、推荐方案 B(Rust span 树+kode-server RPC+TS 薄 provider)」依据的源码事实复核无回潮——xml.rs 精确字节 span(open_span/close_span/content_span/name_span)仍在,mask_def_pseudo_comments 现位 xml.rs:803(文档行号 798→803 已随迁标注复核日期),defParser indexOf 重建偏移现位约 :596(541→596 同笔),package.json 无 prettier/xml formatter 依赖、`grep FormattingEdit src/` 零命中两点复核仍真;禁词合规=全文无 闭环/旨在/全方位;实现仍待后续批次,本批不改代码）
- [x] KODE-FEAT-002 [P2] 明确性能分析能力边界：现有运行时指标/py-spy 快照 vs 未实现的 flamegraph/周期采样，分清已做与未做。（评估文档已先行落盘 docs/design/perf-analysis-boundary.md;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0377)
- [x] KODE-DBG-001 [P2] debugpy 早期附加自动化（提案 docs/design/debugpy-attach.md，未实现）：不改引擎三方案=①入口脚本(scripts/base|cell/<entry>.py,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0378)
- [x] KODE-I18N-001 [P1] package.nls.json + package.nls.zh-cn.json：95 命令/95 配置/7 视图的标题描述全部 manifest 国际化；验收：两语言文件 key 全等、无占位符遗漏。(228fec6;123 命令标题+111 配置描述+26 枚举说明+12 嵌套字段全部 %key% 外置,package.nls+zh-cn 两包 288 键全等,zh 人译非机翻)
- [x] KODE-I18N-002 [P1] 运行时文案国际化：Provider/Diagnostics/QuickPick/Notification/Output/Webview 全接入 l10n；验收：中文系统全中文、英文系统全英文、缺 key 回退行为测试。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0379)
- [x] KODE-I18N-003 [P2] 翻译 key/占位符/回退一致性测试。(228fec6;manifestI18n 契约测试=key 全等/%key% 同名同数无死键/{N} 占位一致/缺 key 回退值级断言;真机 --manifestnls 无裸 token + --manifestfallback 删键重启回落两段断言;codex 4 轮 PASS)
- [x] KODE-ARCH-001 [P2] 拆分 languageProviders.ts（6766 行）为 def/python/navigation/inlay/codeAction/callHierarchy 六模块，共享语义查询走服务不互调；验收：拆后全量测试绿。（2026-11-07 feat/kode-arch-split:7343 行→18 行 barrel + src/languageProviders/ 下 13 模块(reveal/shared/validation/completion/inlay/hover/navigation/pythonDefinition/codeLens/callHierarchy/references/codeAction/rename),47 个公开导出逐名保持,10 个 commit 每步全量门禁绿;语义查询走 shared.ts,provider 间不互调）
- [x] KODE-ARCH-002 [P2] 精简 extension.ts（5577 行）：命令/Provider/诊断/调试/数据库/热更新拆独立装配模块；验收：拆后全量测试绿。（已完成 2026-11-08：defAnalysisWiring/loggingWiring/databaseWiring 三装配模块先行（f0412150 前）；SRC-001 L0..L11 十一个激活器层（infrastructure/coreServices/languageServices/diagnostics/serverControls/views/hotReload/generators/monitoring/console/utilityCommands）将 6772 行 activate 全部抽出为 src/activate/*，extension.ts 现 1596 行（-76%），激活顺序由组合根调用点保持，共享实例经返回值注入，销毁所有权随 context.subscriptions 与返回句柄，deactivate 随组合根收口；门禁全绿）
- [x] KODE-ARCH-003 [P2] 建立五索引（SemanticIndex/EntityMapping/PythonClassIndex/WorkspaceIndex/GlobalDataIndex）所有权与版本失效契约文档+断言。（2026-11-05 交付 docs/architecture/index-ownership.md + tests/indexOwnershipContracts.test.ts 16 断言;2026-11-07 拆分后复核全绿,装配行引用真位重探 extension.ts:782/:1125/:1317/:1037）
- [x] KODE-ARCH-004 [P3] 更新 docs/architecture/current-state.md（现为 2026-10-23 旧快照）。（2026-11-07 增补 feat/kode-arch-split refresh 段(快照不重写原则);provider-data-sources.md provider 表类定义/注册行真位重探到拆分后模块）
- [x] KODE-PERF-007 [P3] 建立 v0.2 最新性能基线：30k 文件/多资产根/大 Python 文件的 Hover/Completion/Definition/Diagnostics/内存/宿主延迟。（78f91cd;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0380)
- [x] KODE-PERF-008 [P1] 激活性能收尾：视图先行注册 + 重复扫描抑制，修激活期「视图全空/一直在扫描」现场。（c67492c6 合并 PR #41（提交 8ef5b619）；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0381)
- [x] KODE-AUD-TODO-001 [P2] 对齐 3 条已修复未关闭的旧审核项（Client SDK FIXED_DICT 伴随文件、Rust flag 归一化 normalize_flag_tokens、dependency graph implementedBy 先 ensure_node），实证后勾账。（2026-11-04 三条实证对齐:①Client SDK FIXED_DICT=审核发现行已勾 5ad4946(修=60a6569,两侧测试绿);②Rust flag 归一化 normalize_flag_tokens=审核发现行已勾 e21f024(修=3cc6735,parser_units+flag_domains_golden 绿);③dependency graph implementedBy ensure_node=审核发现行 2026-11-03 已勾(修=ensure_node 补建,dependency_graph_dispatch 实跑 ok)）

## 配置先行架构（用户令 2026-11-03：XML 配置读取迁 Rust core + config-first 管道 + MCP 问答）

背景：两域当前零依赖无环（配置域 TS serverConfigMerge / def 域 Rust kode-parser）；本批把「先解析配置→按配置特性派生 def 发现、telnet、debug 入口断点」钉成单向管道，解析与合并语义收进 Rust core 单一真源，渲染/l10n 留 TS；经 MCP 暴露问答。依赖：001→002/004；003←002；005/006/007←004；009←003；008←004（且并行于 MCP-001）。

- [x] KODE-CFG-001 [P1] 设计文档：配置先行架构与分层边界。解析/合并/派生→Rust core，渲染/注释注入/l10n/VS Code 命令→TS 留存面；消费通道走既有 kode-protocol；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0382)
- [x] KODE-CFG-002 [P1] Rust 配置 XML 解析：kode-parser 增 config 域（kbengine_defaults.xml + 用户覆盖读取），注释剥除与容错语义对齐 TS parseConfigXml；验收：同输入与 TS 解析结果逐段对拍测试绿（含带注释/坏 JSONC/未知元素容错用例）。（e574813;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0383)
- [x] KODE-CFG-003 [P1] 合并语义迁 Rust core：覆盖规则（子元素优先、类型转换、缺失回默认）迁入 core，TS 只提交用户 diff；验收：与 TS mergeConfigXml 合并结果字节级对拍绿；serverConfigMerge 既有 6+23+1 测试经通道切换后不倒退。（0ccbc90;… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0384)
- [x] KODE-CFG-004 [P1] config-first 派生管道：解析结果→DeriveCapabilities（**def 扫描根**=`server/kbengine.xml` 命中段→`rfind("res")`截断→拼`scripts/`（resmgr.cpp:453-499，**引擎无 pyResPath 配置键，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0385)
- [x] KODE-CFG-005 [P1] def 发现按配置派生：def 扫描根按 CFG-004 实勘链推导（`matchRes("server/kbengine.xml")` 命中段→`rfind("res")`→`scripts/`，锚点为 `res` 后缀、`assets/res` 与 `assets/scripts` 兄弟），工作区根兜底，路径不存在时降级+诊断不崩；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0386)
- [x] KODE-CFG-006 [P1] entryScriptFile 自动断点：attach/端口模式派生初始断点=entryScriptFile 模块文件（调试目标自动生成带该断点）；入口文件不存在出诊断；验收：launch/debug 条目断点预填测试+文件校验测试。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0387)
- [x] KODE-CFG-007 [P2] telnet 按配置启用：telnet 段开启时自动列出 Telnet/Debug Targets 目标（含派生端口），关闭时不列；验收：开/关切换目标列表的测试。完成 7fbd6b3：目标列表经 configDerive 送两棵配置树 → Rust derive.telnet（段开关+逐组件派生端口，真源 Rust）→ telnetDeriveTargets.readDerivedTelnetTargets（settings 半+旧路径兜底）；测试 tests/telnetDeriveTargets.test.ts 7 例；门禁 tsc/lint/unit(6224+20skip，负载抖动复跑)/demo 25 RC=0。
- [x] KODE-CFG-008 [P2] MCP 配置问答（并 MCP-001）：工具 get_final_config/get_entry_scripts/get_database_schema 接 kode-mcp。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0388)
- [x] KODE-CFG-018 [P3] MCP why_setting 工具：对给定配置键答「值 + 中英含义 + file:line 出处」（KODE-CFG-008 验收原文拆出；出处=resolve_config sourceComments + 引擎 defaults 文案库；接 kode-mcp 与 get_final_config 同面）。前置：CFG-008 已落（23efd4f1）。
  - [x] why_setting 落 kode-mcp：值=resolve_config 生效树沿点分路径叶子值；中英含义+出处=引擎 defaults 文案库(serverConfigCatalog.ts)生成 Rust 快照 config_catalog.rs(scripts/gen-config-catalog.mjs,单源,--check 对拍,253 条 sorted+唯一);出处=权威 file:line(如 kbengine_defaults.xml:618)+解析树 sourceComments 交叉佐证;未知键 found:false 如实(值仍解析);容器段值列子键名;工具列 12;门禁 kode-mcp 全绿(21 lib+3 e2e+9+8)+clippy 0+gen --check 同步
- [x] KODE-MCP-KB-001 [P1] MCP 知识库与配置问答扩展（用户 2026-11-08 连发八问：① MCP 默认开启配置（Roo Code / VS Code Copilot Chat / Claude Code / Cursor）或文档提供开启配置；② 知识库提供给 AI agent + kode 自身配置项用途；③ 协议解析后数据帧 + 数据库查询 SQL；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0389)
  - [x] ⑤ list_config_settings（全部配置项含义）—— **169b9729**：config_catalog.rs 生成静态快照（253 条中英含义 + file:line 出处），serverConfigCatalog.ts 单一真源，scripts/gen-config-catalog.mjs `--check` 防漂移。
  - [x] ⑥ search_docs（项目 .md 索引 + 额外路径）—— **3ff40139**：docs_index.rs 递归收 `.md`（root+extra），标题/标题列/snippet，5000 文件/1MB 上限；Excel 未纳入（需 calamine，诚实记录）。
  - [x] ⑦ search_symbols（Python 符号索引）—— **e3d87eff**：code_index.rs 复用 kode-python ruff AST 符号抽取（类/函数/方法 + file:line 1 基），kode-mcp 工具列 = 15。
  - [x] ① MCP 开启配置文档（zh+en：Claude Code .mcp.json / Roo Code .roo/mcp.json / VS Code Copilot Chat .vscode/mcp.json / Cursor .cursor/mcp.json）—— **见本批**：docs/guide/kode-mcp-enablement.md + docs/zh/guide/kode-mcp-enablement.md，含 cargo/发布二进制两种 command 形态、assets-root 参数、各代理配置同形、可问清单。
  - [x] ② kode 自身配置项（kbengine.* 设置）文档化—— **既有 docs/guide/configuration.md 覆盖**（222 处 kbengine.* 引用，含 kbengine.core.backend/assetsRoot/enableDiagnostics 等表），本批在 enablement 文档交叉引用。
  - [x] ③ 协议帧 explain 覆盖 —— **见本批**：explain.rs 知识面增 wire protocol 规范文（docs/kbengine-wire-protocol.md,keywords 含 protocol/wire/frame/协议/帧,explain("protocol frame") 命中,测试 knowledge_face_matches_wire_protocol_article）。config_query_sql 拆待 KODE-CFG-016 ③ config schema（如实保留待办）。
  - [x] ④ 源码 file:line 接地 —— **见本批**：find_symbol/query_xml/protocol_frame/why_setting 均返回 1 基真实源码 file:line（def 属性/类型/类方法/配置出处），enablement 文档 §file:line grounding 说明（无合成行,不可归因如实省略）。
- [ ] KODE-MCP-KB-002 [P1] 结构感知项目知识索引（用户 2026-11-08 架构令：非传统 RAG；纯 Rust 多格式知识索引 + Python 语义模型）。要求：**设计文档**（docs/design/kode-mcp-knowledge-index.md）按用户方案展开——四格式源（Excel=calamine/Markdown=pulldown-cmark/Python=kode-python ruff/XML=quick-xml 或既有解析器）+ def 解析内存数据（AssetKnowledge 一等索引源）；统一节点模型（IndexNode/NodeKind/SourceLocation/Reference）；Tantivy BM25 + SQLite 存储；查询按特征路由（精确→结构索引、术语→BM25、自然语言→按需向量，默认确定性）；增量更新（notify+BLAKE3+git 状态）；已确定/推断/未知三档类型置信度；implementedBy FIXED_DICT→自定义 Python 类；跨文件引用图（def↔types.xml↔.py）。**实现分阶段**：P1 Python 语义模型核心（def 属性→types.xml 类型展开→Python 成员关联 + 置信度，工具 find_symbol/query_xml/find_references/index_status）；P2 Tantivy+SQLite 持久化 + 增量；P3 向量模块（可插拔，按需）；P4 Excel + 知识图谱。门禁：kode-mcp 全绿 + tsc 0/lint 0 + 文档锁步。前置：KODE-MCP-KB-001 已落工具（search_docs/search_symbols/list_config_settings/why_setting）。
  - [x] P1 Python 语义模型核心（def 属性→types.xml 类型展开→Python 成员关联 + 置信度；工具 find_symbol/query_xml/find_references/index_status）—— **854a5ecb**：semantic_model.rs 线程 root 贯穿类型解析与建边,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0390)
  - [x] P1 补口 read_node（设计 §12 P1「已解析模型给出精确位置的面」；工具 list_tools 20→21）—— **304971e6**：新模块 `crates/kode-mcp/src/read_node.rs`——节点名大小写不敏感**全等**（非子串,模糊定位仍归 find_symbol/search_symbols）精读定义位置;Python 类/函数/方法带 1 基 start..end **精确块**（PySymbol 补 end_line 字段,kode-python ruff range 本就带块尾）,def 属性/types.xml 类型/alias.xml 别名/实体带 1 基行+字节 name_span+行锚定 12 行窗口（无块尾,不虚构 endLine）;excerpt 双重封顶（行数 120 缺省/400 硬顶 + 16KB 字节）,截断如实回报（精确块块尾封顶不算截断,窗口封顶算）;超 1MB 文件跳过不虚构空 excerpt;匹配封顶 20 条如实报 resultsLimited;server.rs 派发+工具描述（诚实边界写明 no substring）+instructions 行更新;10 单测（精确块不含模块尾码/方法带类归属/属性行=标签 1 基行/类型与别名各带字节 span/limit 钳制截断如实/大小写全等非子串/超限跳过）+e2e list_tools 断言 21 工具;顺带 19316614 归位 kode-mcp 全 crate rustfmt 漂移（机械换行无语义变化）;门禁 cargo test -p kode-mcp 146 过 0 败 + clippy 我的文件 0 新告警
- [x] KODE-CFG-009 [P1] TS 侧消费通道与旧解析下线：hover/final 合成/文档对账全改走 core 解析结果，parseConfigXml 旧实现删除或降兼容薄壳；验收：grep 无双实现，全量测试绿。（bb15a5f3=PR #36 合入；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0391)

### 补充批次（用户令 2026-11-03 续）

- [x] KODE-CFG-010 [P1] 修复：合并最终 XML 时**源注释被剥离丢失**。根因 `src/serverConfigMerge.ts:40` `parseConfigXml` 用 `.replace(/<!--[\s\S]*?-->/g,'')` 整块删除输入注释。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0392)
- [x] KODE-CFG-011 [P1] 知识库：KBEngine **固定目录布局与路径解析链**（用户令 2026-11-03）。已取证的事实须落 docs：①`Resmgr::initialize` 读 `KBE_ROOT/KBE_RES_PATH/KBE_BIN_PATH` 三环境变量，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0393)
- [x] KODE-CFG-012 [P2] 知识库：**入口脚本 SPI 方法表**（kbemain 固定接口）。 **完成（5904664 落文 + 本批口径收口提交）**：docs/knowledge/entry-script-spi-methods.md（en）+ docs/zh/knowledge/ 同构双语（KB-001 面式），… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0394)
- [x] KODE-CFG-013 [P2] 启动流程图含**入口 SPI 堆栈图**：mermaid sequence/flow 展示从组件启动→`Resmgr` 路径解析→`installPyScript`(sys.path 注入)→`PyImport_Import(entryScriptFile)`(entity_app.h:509)→引擎回调 `onInit`→各 `on*Ready`→… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0395)

- [x] KODE-CFG-014 [P1] 生成**入口 SPI 生命周期图（SVG）**，标注每个回调的调用时机与 file:line（用户令 2026-11-03：「应该生成一个生命周期的 svg，补上他们调用的时机」）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0396)
- [x] KODE-CFG-015 [P1] 引擎 SPI 实现函数单独 CodeLens 标注（用户令 2026-11-03：「很多函数都是引擎spi模式需要实现，如果根据配置识别为引擎的spi实现的函数，是不是需要单独的codelens去标注呢」）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0397)
- [x] KODE-CFG-016 [P1] Excel 配置类强类型 stub 与意外写检测（用户令 2026-11-03：「游戏行业都会使用excel生成一些python类做数据配置，这些类包含大量的数据，并且是不经常变化的，只有热更新重载的接口可以改变...如果指定路径，比如哪些是配置路径，哪些是配置再转换的类，是否就可以生成一些强类型的stub提示，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0398)

- [x] KODE-CFG-017 [P1] pyrefly stubgen 无标注函数 stub 推断接入（用户令 2026-11-03：def stub 生成后，用 pyrefly 给无标注函数/参数补类型，运行时可选 monkeytype；用户确认 pytype 已停更，pyrefly 是唯一选项）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0399)
- [ ] KODE-CFG-017-R [P2] KODE-CFG-017 消费面后续批次：kode 原生 hover/inlay/补全 provider 读 `.kbengine/inferred` 副本富化（副本不进 extraPaths/导入解析，T-04 禁遮蔽铁律）、可选非同名 stub 抽取落 `.kbengine/stubs`、Rust 核 `write_scope` 硬不变式（scope 外写一律拒绝不静默）、monkeytype 运行时观测车道（可选）。源：KODE-CFG-017 扫描面勾账拆出（2026-11-07，合入 0012c98e）；前置扫描面已全部落地。
  - [x] Rust 核 `write_scope` 硬不变式审计（2026-11-08）：crates/ 全树 write 路径枚举——扩展面 Rust 核（kode-server/kode-parser/kode-mcp/kode-protocol/kode-kbengine-protocol）**零文件写路径**（只读分析核心，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0400)

## 漏洞扫描遗留（2026-11-03 全舰队扫描，源 scratch/vuln-scan-*.md）

- [x] VULN-KODE-001 [高危·GHSA-r7fv-28h4-cvq7] markdown-it 12.3.2→14.3.2【跨大版本需改代码】：由 pnpm-workspace.yaml override 钉 12.3.2（vsce 兼容考虑，终扫残留 3 之一）；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0401)
- [x] VULN-KODE-002 [高危·GHSA-22p9-wv53-3rq4/GHSA-v245-v573-v5vm] linkify-it 3.0.3→5.0.2【跨大版本需改代码】：经 @vscode/vsce>markdown-it>linkify-it 引入（2 条 advisory，终扫残留 3 之二、三）；验收：pnpm audit 中 linkify-it 不再命中 + pnpm test 不新增失败。**已落（36dd6a6）**：与 001 同一次提交（同根修复——markdown-it 14.3.3 声明 linkify-it ^5.0.2，解除 markdown-it override 即自然升级，无需单独 pin）；`pnpm audit` 中 linkify-it 已无任何命中（vulnerable 区间 ≥2.0.0 <5.0.2 被 5.0.2 移出），vitest 无新增失败（同 001 实测口径）。

### Rust 覆盖率门禁遗留（源审核 deleg_fddc1113，2026-11-03）

- [x] VULN-KODE-R01 [P3] `examples/`（bench_index/bench_parse/head2head）被 `--all-targets` 执行但不进 lcov 分母——如需 example 覆盖率，评估 `--ignore-filename` 反向或单独统计。**已核实证伪（无需改动）**：三 example 均 `0 #[test]` 且仅 `fn main`，被 `--all-targets` 编译但 `cargo test` 不执行（无测试 harness），不产生覆盖率数据——实测 `cargo llvm-cov --package kode-index/kode-parser --all-targets` 的 lcov 中 `bench_index`/`bench_parse`/`head2head` 与所有 `examples/` SF 条目均为零，即不进分母也非 0% 稀释。example 覆盖率非所需，`--ignore-filename` 反向/单独统计均不适用。
- [x] VULN-KODE-R02 [P3] 仓内无 `codecov.yml` → `rust`/TS flag 无 status/carryforward 规则，两侧上传均 `fail_ci_if_error: false`（上传失败静默）——按需补 flag_management。**已落（68b414e）**：新增 `codecov.yml`（`flag_management.default_rules.carryforward: true` + `individual_flags` 显式声明 `rust`/`ts` 各自 `carryforward: true`，YAML 已解析验证）；`ci.yml` TS 上传补 `flags: ts` 与 rust 侧对齐命名。上传失败仍静默（既有 `fail_ci_if_error: false` 口径保留：Codecov 瞬时抖动不拖红主门禁），但 status 规则现能对两 flag 正确归并/carryforward。
- [x] VULN-KODE-R03 [P3] `rust-coverage` job 在自托管 runner（`vars.CI_RUNNER`）无 rustup 即红，且每跑冷装 cargo-llvm-cov + 冷插桩编译（无 cache），25 分钟 step/40 分钟 job 偏紧——如转自托管需加缓存与前置检查。**已决策（潜伏不触发，现状可接受）**：当前 `vars.CI_RUNNER` 未设 → 默认 `ubuntu-latest` 自带 rustup，且 `rust-toolchain.toml` 钉 1.99.0 由 rustup 首调自动装；现 25min/40min 预算内通过（现状绿）。条件未成立，不增设依赖；若将来 `CI_RUNNER` 指向无 rustup 的自托管 runner，再补 rustup 预检 + cargo-llvm-cov 缓存（届时单独排期）。
- [x] VULN-KODE-R04 [P2] `tests/fantasydemoRealExport.test.ts:19` `FANTASY_ROOT` 硬编码 `/home/cui/workspaces/BigWorld/...`——本机红/CI 绿分叉，改 env 覆盖 + 相对仓库根回退，让 CI 也能真跑。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0402)
- [x] VULN-KODE-R05 [P3] 纯 TS/文档改动也全量跑 Rust 覆盖率（无 paths 过滤）——评估 `paths` 过滤或接受现成本。**已决策：接受现成本（finding 自选项）**——`rust-coverage` 是全仓 `cargo test` 唯一执行点（job 注释明言「不另设测试 job」），paths 过滤若误判会让 Rust 改动绕过测试门禁；按 job 级过滤需引 `dorny/paths-filter`，与仓库「不引第三方 action、供应链面最小」哲学冲突，内置 `git diff` 检测在 PR/base_ref 边界上有误判面。故不设 paths 过滤，接受「TS 改动也全量跑 Rust 覆盖率」的成本。

## 用户令 2026-11-03：stub 生成模式分层开关（默认生成+pyright，激进才复制代码）

- [x] `IDE-STUB-001 [P1]` 新增设置 `kbengine.python.stubSourceMode`：`generated`（默认）| `real-source`（激进）。语义：generated=由内置生成链产出 `entity_types.pyi`/`KBEngine.pyi`（现 `entityTypeStubs.ts`/`pythonTypeStubs.ts` 生成链），**不复制真实代码**；real-source=现有「复制真实代码导出」路径（`exportEntityTypeStubs` real 分支/fantasydemoRealExport 所测路径）仅在此档执行。验收：默认 fresh workspace 不出现复制代码行为；切档生效有测试。
- [x] `IDE-STUB-002 [P1]` generated 档接 pyright：生成 stub 后调用 pyright（CLI 优先 `pyright --createstub`/`npx pyright`，探测不可用则降级纯生成并在输出面板提示），用 pyright 诊断校验/补齐生成 stub 的类型面。验收：pyright 在 PATH 时 stub 经其校验（测试 mock/真实二选一），不可用时降级不报错。
- [x] `IDE-STUB-003 [P2]` 文档三处同步：`docs/guide/configuration.md`+`docs/zh/guide/configuration.md` 配置总览表、`docs/guide/features.md`+`docs/zh/guide/features.md` Settings 表（docsCommands 对账测试会查）。
- [x] `IDE-STUB-004 [P1]` 测试：默认档不触发复制代码路径；real-source 档触发；fantasydemoRealExport 标注为 real-source 专属 fixture；`tests/fantasydemoRealExport.test.ts` 在默认档下 skip 理由更新。

> **⚠ 0.2.0 范围冻结（用户令 2026-11-03）**：本账本仅清既有条目与新暴露缺陷；CFG/STUB/KB/协议分析器/IDE-GIT 等**新功能批次一律顺延 0.2.1**，冻结期内不派工。发布判定=QA 线缩水版全绿（见 docs/kode2/qa-execution-plan.md §8）。解冻须用户明示。

## KBEngine Python API 全量整合（用户令 2026-11-04，明示解冻本批次；本节为拆解入账，整合正文未动笔）

来源：`../kbengine` fork `docs/api/`（32 篇 md，kbengine/ 27 + bigworld/ 5；正主=kbengine_api(cn).chm 转换产物）。落点：docs/knowledge/ + docs/zh/knowledge/ 双语逐篇镜像，grounding=kbengine@c2a3b8f 源码 file:line，禁捏造。本节各任务=每组一条（双语两篇交付 + file:line grounding + 源料 3.7 口径→fork 3.12 实际的差异标注）。

### 盘点摘要（2026-11-04）

- **kbengine/ 27 篇**：baseapp 三篇最大（KBEngine.md 44.9k 字符/50 h3 节、Entity.md 17.3k/19、Proxy.md 8.4k/12）；cellapp 两篇（Entity.md 44.0k/50、KBEngine.md 32.4k/42）；client 两篇（Entity.md 7.2k/13、KBEngine.md 4.8k/9）；bots 四篇（KBEngine 7.6k/10、Entity 8.3k/11、PyClientApp 1.4k/2、index）；interfaces KBEngine.md 13.4k/12；loginapp 9.0k/11、dbmgr 9.2k/8、logger 5.8k/7 各一篇+薄 index；横切=keywords.md 7.6k/19、basetypes.md 0.3k（裸类型表）、总览 index.md 0.8k；audit-checklist.md 12.6k 是审计方法论文档（非 API 面，作各任务校验口径用）。
- **bigworld/ 5 篇全部为骨架 stub**（base/bigworld-module/bwpersonality/entity/index，每篇 1.2k-1.7k，只有「源文件位置+已知 API 组+Next steps」，无签名无语义）——不可直接整合。
- 源料质量：正文语义可信（抽验 6 断言 5 过，见 KB-API-003/004/002 内嵌证据），但**排版含chm转换粘连**（单词粘连如 ThisKBEngine、表格破损），整合时须重写不照抄；client 面混入**插件层 API**（login/createAccount/findEntity 等），实现不在 kbe/src（见 KB-API-002）。

### 源码对账抽验结果（2026-11-04，抽 3 篇×2 断言，均已亲验 file:line）

- baseapp/KBEngine.md：`baseAppData`=GlobalDataClient ✓（kbe/src/server/baseapp/baseapp.cpp:461 `registerPyObjectToScript("baseAppData", pBaseAppData_)`，DBMGR_TYPE+BASEAPP_DATA）；`globalData`=GlobalDataClient ✓（kbe/src/lib/server/entity_app.h:418-419，GLOBAL_DATA，baseapp/cellapp 共用此注册点）。
- cellapp/Entity.md：`addTimer(start, interval=0.0, userData=0)` ✓（kbe/src/server/cellapp/entity_component.cpp:12 SCRIPT_METHOD_DECLARE("addTimer", pyAddTimer)）；`controlledBy` BaseEntityCall ✓（kbe/src/server/cellapp/entity.cpp:87 SCRIPT_GETSET_DECLARE("controlledBy", pyGetControlledBy, pySetControlledBy)）。
- client/KBEngine.md：`player()` ✓（kbe/src/lib/client_lib/clientobjectbase.cpp:28 SCRIPT_DIRECT_METHOD_DECLARE("player")；`entities` 同文件 :36）；`findEntity(entityID)` ✗ **kbe/src 全树无注册点**——客户端插件层 API（login/createAccount/reloginBaseapp/bindAccountEmail/newPassword/resetPassword/findEntity 九个成员函数中仅 player/entities/getSpaceData/callback/cancelCallback/getWatcher/getWatcherDir/disconnect/kbassert 在 client_lib/clientobjectbase.cpp:20-28 注册）。结论：client 面文档是「C++ client_lib + 客户端 SDK 插件」混合面，grounding 须分域标注。

### 版本口径取证（2026-11-04，KB-API-001 的已验事实）

- Windows 工程已链 python312 库：kbe/src/server/baseapp/baseapp.vcxproj:118（`python312_d.lib`）等 9 个 vcxproj——**3.12 已落地的事实证据**。
- docs/zh/guide/engineering/python-3.12-upgrade.md:8 仍写「当前 vendored 版本是 3.7.3」——**文档漂移**，升级后未回改。
- kbe/src/lib/pyscript/script.cpp:255 调用点 `PyEval_InitThreads()` 已被 `scriptstdouterrhook.h:11-15` 宏中和（3.9 起弃用、3.13 官方移除；3.12 下无告警、无运行时调用）——嵌入层 C API 审计的实例。
- **vendored `kbe/src/lib/python/` 树未入 git**（`git ls-files kbe/src/lib/python` = 0）且本机不在盘上——3.12 CPython 源码不在仓库内，偏离清单取证须另行取得 3.12 参照（本机 python3.12/官方 changelog），不得凭 3.7 docs/api 源料反推。

### 执行约定（本节通用）

- grounding 统一口径：kbengine@c2a3b8f（该 commit 是 fork HEAD `6d12b8f` 的祖先，账面引用以 c2a3b8f 为准）；每条 API 断言带 `kbe/src` file:line；已在上方抽验过的证据点各任务**复核后引用，不得凭空改写**。
- 差异标注口径：源料 CHM=官方 3.7 时代文档；fork 嵌入 3.12。每篇交付含「源料 vs fork 实测」差异小节（如脚本层 str/bytes、int 无上限、datetime 等 3.7→3.12 语义差 + 嵌入层 C API 变化），无差异的篇目显式写「无偏离」不空缺。
- 双语镜像按 docs/knowledge/README.md 约定：en 为 canonical（行号漂移检查基准），zh 逐篇镜像同引用同主张。
- 与既有条目分工：入口 SPI 36 方法=KODE-CFG-012/014（kbemain 面，不在本节范围）；hover 文档库消费=C-21；MCP 消费=MCP-001；本节产出按 KB-001 流水线喂两者。

- [x] **KB-API-001 · P0 · 建设 · 版本口径说明：python 3.7→3.12 偏离清单**（双语一篇 docs/knowledge/python-version-baseline.md + zh 镜像）
  - 交付：以「版本口径说明」篇回答——官方 docs/api 源料按 3.7 口径写，fork 嵌入 3.12，整合各篇如何标注。内容含：①运行时基线事实（上方取证四条全部复核引用：vcxproj python312、upgrade 文档漂移、script.cpp:255 弃用调用、vendored 树未入 git）；②嵌入层 C API 审计清单（PyEval_InitThreads 及同类已移除/语义变更调用逐个 grep `kbe/src/lib/pyscript`+`lib/server`，逐条标 3.12 下的行为：可编译/告警/须改）；③脚本层 3.7→3.12 语义偏离表（影响 API 整合的子集：str/bytes、int、迭代器、asyncio 无关面不写）；④给 KB-API-002~008 的统一标注模板（每篇差异小节的固定格式）。
  - 验收：清单逐条带 kbe/src file:line 或 CPython 3.12 官方出处（两域分开标）；upgrade 指南页 3.7.3 漂移**不在本任务内改**（那是 kbengine 仓的事，仅在知识库篇里如实记「源仓文档漂移」）；双语镜像一致。
- [x] **KB-API-002 · P0 · 建设 · client 面（客户端运行时）**：源料 client/KBEngine.md(4.8k)+client/Entity.md(7.2k)+client/index.md，双语 docs/knowledge/api-client.md + zh 镜像
  - 范围口径（本批抽验已定）：九个模块函数中 `player/entities/getSpaceData`（+callback/cancelCallback/getWatcher/getWatcherDir/disconnect/kbassert）落 kbe/src grounding（lib/client_lib/clientobjectbase.cpp:20-28 已验，复核后引用）；`login/createAccount/reloginBaseapp/resetPassword/bindAccountEmail/newPassword/findEntity` **无 kbe/src 注册点，标注「实现于客户端 SDK 插件层（本仓库外）」**，不得落到任何 kbe/src file:line，也不得写成未实现——它们对用户可用，只是实现域不同。
  - 内容：Entity 面（isPlayer/player 语义边界、onEnterWorld/onLeaveWorld/onEnterSpace/onLeaveSpace 触发语义、baseCall/cellCall 限制、isOnGround/moveToPoint 同步、ownerOnly 可见性）按 audit-checklist §2 焦点逐条 grounding 后撰写；抽验锚：clientobjectbase.cpp:28/:36。
  - 验收：每断言 file:line 或「插件层」显式标注；差异小节按 KB-API-001 模板；与 KB-001 既有 entity-lifecycle 篇互链。
- [x] **KB-API-003 · P0 · 建设 · baseapp 面**：源料 baseapp/KBEngine.md(44.9k)+Entity.md(17.3k)+Proxy.md(8.4k)+index.md，双语 docs/knowledge/api-baseapp.md + zh 镜像（四源料合一篇过大则拆 api-baseapp + api-baseapp-entity 两篇，拆法写进篇首）
  - 内容：进程级（createBaseEntity/createBaseLocally/globalData/baseAppData/baseBases/onGlobalData 系回调/定时器/addTimer 进程版/远程方法调用）+ Base Entity 面（createCellEntity 语义=Base→Cell 移交非本地创建、writeToDB/destroy/createFromDB）+ Proxy 面（giveClientTo 客户端移交与 Witness 链）。
  - 抽验锚（复核后引用）：baseAppData=baseapp.cpp:461、globalData=entity_app.h:418-419；audit-checklist §3 焦点（Base→Cell handoff 回调序、持久化时序与失败路径、controlledBy/isControlled/control 转移）逐条落。
  - 验收：Proxy giveClientTo 必须落到源码实现点（baseapp proxy.cpp/entity.cpp 相应 file:line）；createCellEntity 按 audit-checklist 定论写「handoff not local creation」并带实现点；差异小节模板齐。
- [x] **KB-API-004 · P0 · 建设 · cellapp 面**：源料 cellapp/Entity.md(44.0k)+cellapp/KBEngine.md(32.4k)+index.md，双语 docs/knowledge/api-cellapp.md + zh 镜像（篇过大可拆两篇，拆法写篇首）
  - 内容：Cell Entity 全面（allClients/其他客户端广播、controlledBy/controlBy、moveToPoint/navigate/navigatePathPoints/cancelController 控制器链、addTimer/delTimer、AOI/进入离开空间回调、volatile/属性广播）+ 进程级（cellData/globalData/cellAppData 注册与回调、createEntity/createSpace 失败语义）。
  - 抽验锚（复核后引用）：addTimer=cellapp/entity_component.cpp:12、controlledBy=cellapp/entity.cpp:87、cellAppData=cellapp.cpp:199、globalData=entity_app.h:418-419；audit-checklist §3 移动/控制器/AOI 焦点逐条落。
  - 验收：控制器链（moveToPoint/navigate/cancelController 共享一条 controller 链，audit-checklist 已连源码分析）带实现点；广播面 allClients/其他 clients 按源码语义写不准含糊；差异小节模板齐。
- [x] **KB-API-005 · P1 · 建设 · interfaces 面**：源料 interfaces/KBEngine.md(13.4k)+index.md，双语 docs/knowledge/api-interfaces.md + zh 镜像
  - 内容：第三方账号接入面（onRequestAccountLogin/onRequestCharge 等 interfaces 组件回调、dbInterface 配置交互），按 audit-checklist §4 「Account/login/database/third-party integration 边界」焦点。
  - 验收：每回调带调用点 file:line（kbe/src/server/tools/interfaces/）；差异小节模板齐。
- [x] **KB-API-006 · P1 · 建设 · loginapp/dbmgr/logger 进程全局面**（交付形态：三源面合并为单篇 api-loginapp-dbmgr-logger.md，含 PythonApp 共享运行时面 15 项补充——与规格三篇口径差异已注明）：源料三篇 KBEngine.md（loginapp 9.0k/dbmgr 9.2k/logger 5.8k）+三篇薄 index，双语 docs/knowledge/api-loginapp.md、api-dbmgr.md、api-logger.md 三篇 + zh 镜像
  - 内容：loginapp（login/createAccount/resetPassword/bindAccountEmail 服务端协议面、onRequestLogin/onLoginCallbackFromDB）、dbmgr（持续化与 Account 查询接口、onSelectAccountDBInterface）、logger（日志观察面/Watcher 挂接）。
  - 验收：三篇各自独立可验收（一篇一 checkbox 口径在本行内分号列出）；audit-checklist §4 进程边界焦点逐条落；差异小节模板齐。
- [x] **KB-API-007 · P1 · 建设 · bots 面（压测组件）**：源料 bots/KBEngine.md(7.6k)+Entity.md(8.3k)+PyClientApp.md(1.4k)+index.md，双语 docs/knowledge/api-bots.md + zh 镜像
  - 交付：docs/knowledge/api-bots.md + docs/zh/knowledge/api-bots.md。脚本面六注册点（bots.cpp:174-182/186-209/211-228 + clientapp.cpp:186-217/233-268 + script.cpp:247-258/pyurl.cpp:23）；19 个模块函数（源料仅记载 8，11 个 fork 独有）；addBots「请求 vs 即时创建」语义（CreateAndLoginHandler 1s 定时器 + 0.1s 子 tick 限速）；入口回调 onInit/onFinish（onInit 恒传 isReload=0）+ fork 独有 onTargetChanged；bots（PyBots）只读映射（has_key/keys/values/items/get + len/下标，键=appID）；客户端对象面（源料名 PyClientApp 无符号，实为 ClientObjectBase，8 方法/2 getset）；Entity 面与 KB-API-002 共域互链不重写、本地重锚定。与 todo 预期差异：**onTick 不存在**（grep 0 命中），压测挂点实为 onInit/onFinish/onTargetChanged，已按实写。
  - 抽验锚（复核后引用）：addBots=bots.cpp:182/:344-387、bots 映射=pybots.cpp:17-25/:52-78、onInit=bots.cpp:99-113、客户端对象方法=clientobjectbase.cpp:21-28、id/entities getset=clientobjectbase.cpp:35-36、Entity 事件宏=entity_macro.h:47-49、Entity 属性=entity.cpp:41-46+entity_macro.h:58-61、component='bots'=script.cpp:247-251+common.h:110。
  - 偏差小节模板齐（12 行，含源料虚构条目：bots Entity 无 cellData/isOnGround 脚本绑定；`component` 判定修正——script.cpp:247-251 在 lib/pyscript 注册，取代 api-client §3 仅扫 lib/client_lib 的结论，已互见）。
  - 验收：共域断言引用 api-client 已 grounding 锚点；bots 专属回调带 kbe/src/server/tools/bots file:line；zh 镜像同结论同引用。
- [x] **KB-API-008 · P1 · 建设 · 核心概念篇（basetypes+keywords+总览）**（交付形态：核心概念地图篇 api-core-concepts.md 吸收 basetypes/keywords 源料，未单独出 api-basetypes.md——与规格口径差异已注明）：源料 basetypes.md(0.3k 裸表)+keywords.md(7.6k/19 节)+总览 index.md(0.8k)，双语 docs/knowledge/api-basetypes.md（含 keywords 术语矩阵）+ zh 镜像
  - 内容：基础类型表（UINT8..VECTOR4/PYTHON/STRING/UNICODE 及字节数——与 kbe/src/lib/entitydef/datatypes.cpp DataTypes::initialize 21 内建逐名对账，kode 仓 1cf55c4 批已核过 21 名清单可复核引用）+ keywords 术语矩阵（ENTITYCALL/CELLDATADICT/PyClient 等按 audit-checklist「表面名 vs 运行时语义」焦点展开）+ API 总览（四桶导航篇）。
  - 验收：类型表每行与 datatypes.cpp 注册点对账（字节断言只写有实现依据的）；术语条目分「表面名/运行时语义/易混点」三列；audit-checklist 建议的「最后收口术语」顺序照做（排在 002-007 之后实施）。
- [x] **KB-API-009 · P2 · 建设 · bigworld/ 5 篇遗产处置决策**：源料 bigworld/{base,bigworld-module,bwpersonality,entity,index}.md（全部骨架 stub，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0403)
  - 交付：一篇**处置决策记录**（docs/knowledge/bigworld-legacy-status.md + zh 镜像，或并入总览篇一节）：按 stub 内 Next steps 评估「从 /*~ 注释提取补全」的成本收益，给出「整合/只留状态说明/明确不整合」三选一建议与理由（stub 所指 server/baseapp/base.hpp 的 /*~ 注释面在 fork 源码里是否存在须先取证）；不整合则写明范围边界防后续误派工。
  - 验收：决策带取证（fork 源码里 /*~ 注释面 grep 结果 file:line）；不得把 stub 内容当已验证 API 整合进任何一篇。


## 版本感知：引擎版本配置与特性门控（用户令 2026-11-04）

> 背景：官方基线 3.7.3，魔改 fork 版本各异（本仓知识库已取证 fork 嵌入 Python 3.12）；不同版本支持的 API/特性不同，kode 的 hover/补全/诊断与知识消费应按所选版本门控。

- [x] `KB-VER-001 [P0]` 新增设置 `kbengine.engineVersion`（默认 `"3.7.3"`，自由串+常见预设提示）：package.json 配置面、读取链、`ConfigurationChangeEvent` 联动；交付单测（默认值/变更事件）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0404)
- [x] `KB-VER-002 [P1]` 知识库/API 参考版本分层标注：每 API 条目标「3.7.3 基线 / fork 3.12+ 新增 / 待取证」，hover/补全内容按 engineVersion 过滤或标注（缺省 3.7.3 时 fork-only 项显式标注「需 fork」）。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0405)
- [x] `KB-VER-003 [P1]` 版本越界提示：项目 def/config 使用了超出所选版本的特性（fork-only 字段在 3.7.3 下）时给 Warning（检测面从既有 xml/def 解析管道入手）。验收：netns 式夹具测一正一反。（2026-11-08 按用户令跳过：fork 相对 3.7.3 的 def/config 差异清单尚未提供，无已验证「fork-only 字段」清单即造不出真实正例，待清单到位后回来做）
- [x] `KB-VER-004 [P2]` 版本自动探测：从引擎安装目录读版本标记（res/version 或构建产物），打开项目时建议 engineVersion 值（不自动改用户设置）。（2026-11-04 完成：src/engineVersionDetect.ts——`detectEngineVersionMarker`（工作区根序列+explicitRoot 优先，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0406)



## 外部深度审核跟踪：KR-AUD（2026-11-04 落地，deepseek 通道全量重核）

> 来源：外部深度审核（基准 c5954f3），逐条对 HEAD `e512e99` 重核后落地。
> 对照表（每条证据与定性）见 [docs/review/external-deep-audit-2026-11-04.md](docs/review/external-deep-audit-2026-11-04.md)——先读对照表再动工，行号以该档为准。
> 口径：属实=HEAD 上仍在；部分属实=结构在但子声明不成立/已缓解（动手前先读档内定性）；编号 KR-AUD 为本节首用，与在飞席位无冲突。
> 划界：dataflow/callgraph 项（09-21）与 KODE-AUD-007/008 席位同文件，派单须知会；UI-2/UI-4 行号已被今日 perf 批（1403e72）刷新。
> 推进顺序：P1（25/26/27/38/39/67/68/69/70/80/81）→ P2 竞态与双轨正确性（09-14/28/29/40-44/53-56）→ P3 择期（转义/CSP 一批统一做：08/38/43/49/50）。验收统一口径：修复+判别测试（修复前红/修复后绿）+既有门禁全绿；引擎语义项（67-72/80-88）须附与引擎源码对拍的 fixture。

- [x] KR-AUD-01 [P2] CORE-1 src/kodeCoreClient.ts:248-275 dispose 挂起双路径——shutdown(:260) 无超时（仍开）+ 末尾 `await exited`(:273) 对 race 超时时已退出进程无守卫（残边；1.5s race+SIGKILL 已缓解主路径）。验收：shutdown 超时→SIGKILL；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0407)
- [x] KR-AUD-02 [P3] CORE-2 src/kodeCoreClient.ts:183-189 resolve/reject 不清 cancelTimer——已完成 id 收到迟到 $/cancelRequest。验收：完成后无取消通知。（2026-11-04 修复：cancelTimer 提升到外层声明，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0408)
- [x] KR-AUD-03 [P3] CORE-3 src/kodeCoreClient.ts:396-402 重启握手失败仅记 stderr，child 不清空→后续请求吃误导性 -32002（server.rs:178）。验收：握手失败即杀子进程走 EXITED 路径。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0409)
- [x] KR-AUD-04 [P2] DIA-1 src/diagnosticScheduler.ts:417,481-485 computeAsync 失败重抛产生未处理 rejection。验收：错误路径无 UnhandledPromiseRejection，错误可观测。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0410)
- [x] KR-AUD-05 [P3] TST-1 src/pythonTestRunner.ts:268-295 spawnTestProcess 无超时/无 kill/输出无界。验收：挂死 pytest 可取消，输出有上限。（2026-11-05 修复：spawnTestProcess 设超时窗（默认 PYTEST_PROCESS_TIMEOUT_MS=600s，可注入短窗测试），到期 SIGKILL+timedOut 入账并明示「测试进程超时被终止」，不再无限挂死；单进程 stdout/stderr 各累计 1MB（MAX_PYTEST_OUTPUT_CHARS）超限截断+标记，无界输出不再撑内存。判别测试 3 例——挂死进程 SIGKILL+timedOut/输出超限带标记/正常小输出不截断；修复前无超时无上限红。5ecc94a）
- [x] KR-AUD-06 [P3] TST-2 src/pythonTestRunner.ts:59 `\S+` 截断带空格参数化用例名。验收：`test_x[param with space]` 解析成功。（2026-11-05 修复：VERBOSE_OUTCOME_PATTERN 节点段由 `\S+` 改贪婪 `\S.*` 回溯到最右 `<OUTCOME>\b`（真实结果恒在参数之后，参数含空格/含 FAILED 字样均不误截）；SUMMARY_PATTERN 节点改 lazy 取到 ` - ` 分隔处。判别测试 2 例——参数含空格聚合/参数内含 FAILED 字样不误截；修复前 `\S+` 红。9dab8f0）
- [x] KR-AUD-07 [P3] PAR-1 src/pythonParserWorkerHost.ts:214-215 fileQueues 条目永不回收。验收：任务排干后条目删除，长会话 map 不随大文件数线性涨。（2026-11-05 修复：drainAllQueues 派发循环后收集「无在途且无待派」的 filePath 并从 fileQueues 删除（先收集再删，防迭代中改 map）；新增 fileQueueCountForTests 测试访问器。判别测试 2 例——3 不同文件排干后条目数 0/同文件 pendingLatest 链式派发后 0；修复前 map 随已处理文件数线性涨红。8fe7c85）
- [x] KR-AUD-08 [P3] 自查-CSP src/runtimeQueryWebView.ts:369 unsafe-inline。验收：nonce+cspSource 收紧（与 50 批量做）。（对账勾账：2491152 修复已落 main）
- [x] KR-AUD-09 [P2] RUST-1 dataflow.rs:332-374 推导式 elt 读先于 target 写，elt 内 def-use 断链。验收：`[str(x) for x in xs]` elt 内 use 有链。〔与 KODE-AUD-007 席位划界〕（对账勾账：0740af6 修复已落 main）
- [x] KR-AUD-10 [P2] RUST-2 dataflow.rs:218-223 Match guard 不读、pattern 捕获不 def。验收：`case [a,b]:` 捕获 def+guard 读各一测试。〔callgraph 半边已由 KODE-AUD-008 闭合〕（对账勾账：2db628e 修复已落 main）
- [x] KR-AUD-11 [P2] RUST-3 symbols.rs:46+dataflow.rs:224-233 `import a.b` 绑定名取首段。验收：dotted import def/use 链合拢+跨文件解析按顶层名。（对账勾账：59fcb90 修复已落 main）
- [x] KR-AUD-12 [P2] RUST-4 scheduler.rs:452-479 ensure 不查 outcome.decision，RejectedQueueFull/StaleDropped 写 id=0 假 keyed 条目永久卡。验收：入队被拒不写 keyed，重试可恢复。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0411)
- [x] KR-AUD-13 [P2] RUST-5 scheduler.rs:442 tasks HashMap 终态任务永不摘除。验收：终态消费后 remove/环形窗口，长会话任务数有界。（2026-11-04 修复：终态环形窗口摘除——execute/cancel_queued 到达终态时 id 入 terminal_order: VecDeque 窗口（front=最旧），… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0412)
- [x] KR-AUD-14 [P2] RUST-6 invalidation.rs:67-83 affected_by 单级传播不取闭包。验收：A→B→C 改 C 时 A 入受影响集。（2026-11-04 修复：affected_by 改为工作表迭代至不动点——frontier 弹出文件展开其声明名的 dependents_of 反向边 + call_dependents overlay，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0413)
- [x] KR-AUD-15 [P3] RUST-7 graph.rs:93 `self.` 前缀恒回 caller_file（引擎 cell 侧漏报面；原稿自述取舍，登记待议）。（2026-11-07 对账勾账：取证推翻原前提——HEAD 上 resolve_callee_file 已对 KbeCrossProcess 边显式短路返回 None（graph.rs「RUST-7:显式短路」注释），不再恒回 caller_file 无声丢弃；跨进程调用方由 uncertain_cross_process_files 显式标出（lib.rs 导出，供保守重扫消费），判别测试 rust7_cross_process_edge_marked_uncertain_not_silent 落自 159d6261。残余 gap=uncertain 面尚无生产消费方接入 invalidation（保留待议）。cargo test -p kode-python：lib 3+callgraph 12+dataflow 17+graph 6+symbols 7 共 45 绿。）
- [x] KR-AUD-16 [P3] RUST-8 dataflow.rs:247-248 Raise/Assert 表达式读漏记。验收：`raise err` 的 err 有 use。（对账勾账：c9fecb5 修复已落 main）
- [x] KR-AUD-17 [P3] RUST-9 dataflow.rs:206-211 except 捕获名 def 行号记到 try 行。验收：def 行=handler 行。（对账勾账：8a822d5 修复已落 main）
- [x] KR-AUD-18 [P3] RUST-10 dataflow.rs:399 lambda 形参遮蔽不建模。验收：`lambda x: x+1` 不连外层 x 链。（对账勾账：cd22f5f 修复已落 main）
- [x] KR-AUD-19 [P3] RUST-11 dataflow.rs:249-250 global/nonlocal 后赋值建假局部 def。验收：global x 赋值不产局部链。（对账勾账：5c63da4 修复已落 main）
- [x] KR-AUD-20 [P3] RUST-12 callgraph.rs:247-256 嵌套 def 继承外层 caller_class 产伪 (Foo, inner) 边。〔KODE-AUD-008 残留面，派单知会〕验收：方法体内嵌套函数不产类方法边。（对账勾账：8734f4d 修复已落 main）
- [x] KR-AUD-21 [P3] RUST-13 callgraph.rs:309 lambda 归外层 caller vs 嵌套 def 归自身——口径统一。验收：两者一致并以测试固化。（对账勾账：4435152 修复已落 main）
- [x] KR-AUD-22 [P3] RUST-14 symbols.rs:159 注释顺序错（posonly→pos→vararg→kwonly→kwarg）+ scheduler.rs:646-686 run 闭包 panic 无 catch_unwind 卡死调度。验收：注释修正+panic 按 Failed 终态落账。（对账勾账：72bb897 修复已落 main）
- [x] KR-AUD-23 [P2级] RUST-注1 invalidation.rs:115,129-135 plan_dependency_tasks：changed 与依赖同批丢 SingleFileUpdate 优先级。验收：changed 强制单独成批。（对账勾账：0d87292 修复已落 main）
- [x] KR-AUD-24 [P3级] RUST-注2 journal.rs:29 无扩展名路径产 `xxx..tmp` 临时名（无功能影响，防回归登记）。（对账勾账：3b20ca2 修复已落 main）
- [x] KR-AUD-25 [P1] IDX-1 entityMapping.ts:215,462-470,528,1192 removedRootKeys 只加不删，根重加入后永久拦 null。验收：根重新登记即解除拉黑，A→B→A 切换索引恢复。〔已修 2026-11-04:performScanEntityMappings 登记扫描根时删除对应 removedRootKeys 项(src/entityMapping.ts:406-414)——登记循环先于发现/解析,不影响同轮对已移除根的拦截;单测 tests/entityMappingManager.test.ts:1251-1335「移除 B→未重加入前拦截保持→重加入重登记后索引恢复」(未修先红:HEAD 复现 getMapping undefined,修复后绿);相关 7 文件 vitest 82/82 全绿(含 IDE-IDX-016 在途拦截既有用例),tsc -p ./ --noEmit 0 错,eslint 改动 2 文件 0 错〕
- [x] KR-AUD-26 [P1] IDX-2 pythonClassIndex.ts:704-782 ensureCompositionRoots 连续让位 8 次 fall-through 只打日志：rootsMap 不落地/metrics 不 end/rootsPromise 不清→组合根查询永久空。验收：fall-through 按最后快照落地或清 rootsPromise 允许重试（边缘场景注入测试）。（159d626;fall-through 落最后快照+end metrics+清 rootsPromise;tests/idxAuditKR26to29.test.ts:59 注入 assignmentsToken 每次变化复现 8 连让位,断言 rootsMap 落地/rootsPromise 清理/metrics 归零/后续查询可用;26 文件 602 过|2 跳）
- [x] KR-AUD-27 [P1] IDX-3 workspaceIndex.ts:119-137 watcher(:131) 晚于首扫 await(:129)——初扫窗口磁盘变更永久漏。验收：对齐 AUD-074 口径（watcher 先挂或扫描后 stat 指纹复核）。（159d626;workspaceIndex watcher 先于 findFiles 挂载,change 升 revision 由监听任务追读;tests/idxAuditKR26to29.test.ts:116 断言 watcher 创建先于 find,初扫窗口 fireChange 后旧 EV 不滞留新 EV 入账;26 文件 602 过|2 跳）
- [x] KR-AUD-28 [P2] IDX-4 pythonClassIndex.ts:377,496-498 单文件 invalidate 作废整扫描代+loadFile 无指纹短路。验收：关单文件不触发全仓重发现/重解析。（159d626;onDocumentClosed 只同步摘缓冲版并按盘定向重载,closeReloads 让后续查询等待落定,不推进 scanGeneration;tests/idxAuditKR26to29.test.ts:177+pythonMixinNavigation:174 双门=discover=0/其他文件 load=0/该文件盘内容恢复;26 文件 602 过|2 跳）
- [x] KR-AUD-29 [P2] IDX-5 globalDataIndex.ts:1643-1652 scanWorker 循环头无 generation 复核（守卫仅在 indexFile 层 :1718），初扫中 removeRoot 空根复活违反 AUD-071。验收：循环头 generation 复核测试。（159d626;scanWorker 捕获 scanGeneration,循环头 removeRoot/invalidate 升代后不再认领剩余文件;tests/idxAuditKR26to29.test.ts:220 8 worker 在飞+removeRoot 后 cache/byKey 均 0;26 文件 602 过|2 跳）
- [x] KR-AUD-30 [P3] IDX-6 sharedFileEvents.ts:44 事件热路径 statSync 同步 IO。验收：改异步 fs.stat。（对账勾账：1c1453f 修复已落 main）
- [x] KR-AUD-31 [P3] IDX-7 dependencyGraph.ts:34 entities.xml 缺 `/` 前缀锚。验收：`xxxentities.xml` 不误判。（对账勾账：5567f5e 修复已落 main）
- [x] KR-AUD-32 [P3] IDX-8 pythonParser.ts:147-157 `from . import mod` 兄弟模块解析落空（解析侧轻核）。验收：`helper.Cls()` 跳转命中。（对账勾账：3e007fb 修复已落 main）
- [x] KR-AUD-33 [P3] IDX-9 kbeModuleIndex.ts:408-412 `import os, kbe` 逗号行不注册别名。验收：该写法整文件接管。（对账勾账：add206a 修复已落 main）
- [x] KR-AUD-34 [P3] IDX-10 workspaceDiscovery.ts:225,279-287 发现链缓存会话内不失效（轻核）。验收：新建 entity_defs 可发现+瞬时失败可重试。（对账勾账：0d436fa 修复已落 main）
- [x] KR-AUD-35 [P3] IDX-11 globalDataIndex.ts:2076 rebuild 无界并发。验收：并发上限常量+测试。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0414)
- [x] KR-AUD-36 [P3] IDX-12 definitionWorkspace.ts:172-200 布局解析无缓存，悬停热路径多次 existsSync。验收：按 rootConfigGeneration 缓存。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0415)
- [x] KR-AUD-37 [P3级] IDX-注 pathIdentity 不折叠 `..`/pythonExtraPaths 大小写敏感/noteSaved 每键两遍正则——原稿备注级，未逐项复核，动手前先自行取证。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0416)
- [x] KR-AUD-38 [P1] RT-1=UI-1 logWebView.ts:602-605 title(log.raw)/component 未转义直进 innerHTML——webview XSS。验收：两处 escapeHtml+判别测试（恶意日志行不产生标签）。（159d626;title=log.raw 与 component 全量 escapeHtml,整页 nonce CSP;tests/webviewSecurity.test.ts:86 两面判别恶意 raw/component 不产生标签+无 unsafe-inline;26 文件 602 过|2 跳）
- [x] KR-AUD-39 [P1] RT-2 processManager.ts:336-365 stop 残边：spawn 失败 error-only 无 exit 时依赖超时升级 kill 兜底。验收：error 事件 resolve exited+超时兜底测试（注意 RUN-007 结构已在，勿回退）。（159d626;exit/error 均为等待终局,超时 SIGKILL 后 250ms 兜底 resolve;tests/processManager.test.ts spawn error-only 不悬挂+超时兜底双例;26 文件 602 过|2 跳）
- [x] KR-AUD-40 [P2] RT-3 hotReloadRetryCommand.ts:72,261 重试路径绕过 gateDefChanges（fire 路径 hotReload.ts:575,625）。验收：结构性 def 变更经重试通道同样被拦。(b1d19f4;闸本就结构先行但测试只压 runAction 分支——补通道分支 pin 测试(结构性 def 经通道重试被拦/非结构照常)+mutation 验证(禁用闸 6 红))
- [x] KR-AUD-41 [P2] RT-4 debugConfig.ts:430,504,870-891,937 硬编码默认密码回落 `pwd123456`（原稿密码串 ucs775502 不属实，结构问题属实）。验收：无默认回落，缺配置显式提示。（159d626;默认/逐组件/示例四处移除 pwd123456,缺省 telnetPassword=undefined 由 startDebugging 显式提示;tests/debugConfig*.test.ts 断言 JSON 全树不含 pwd123456+缺失提示面;26 文件 602 过|2 跳）
- [x] KR-AUD-42 [P2] RT-5 debugConfig.ts:803,824-826 updateLaunchJson 按名称前缀误删用户配置。验收：生成条目加隐藏标记按标记清理。（159d626;生成/动态写入口统一 `_kbengineGenerated` 标记,清理只认标记;用户手写 KBEngine: 前缀保留,带标记陈旧生成项回收;tests/debugConfig.test.ts:260+debugConfigLaunchWrite.test.ts:112;26 文件 602 过|2 跳）
- [x] KR-AUD-43 [P2] RT-6=UI-3 monitoringWebView.ts:243,601,1034 多字段未转义+JSON 直插 script+CDN。验收：escapeHtml 全覆盖+`\u003c` 替换+Chart.js 本地打包。（对账勾账：2491152 修复已落 main）
- [x] KR-AUD-44 [P2] RT-7≈UI-13 logWebView.ts:51-56 collector 路径每条日志整页重渲（logHub 增量路径 :96 未接）；monitoring 过滤同款。验收：高频路径节流+append-only。（对账勾账：b3e4959 修复已落 main）
- [x] KR-AUD-45 [P3] RT-8 hotReload.ts:298+hotReloadRetryCommand.ts:60-65 `undefined | reason` 文案。验收：filter(Boolean).join。(零改动;RT-8 已在仓内修复,hotReloadAnnotationDetail 专测 filter(Boolean) 防 undefined 拼接,结案有据)
- [x] KR-AUD-46 [P3] RT-9 hotReload.ts:338 sendViaChannel accepted 即终态，与另一路径 applied digest 核验语义不一致（轻核）。验收：两路径状态语义对齐。(b1d19f4;取证推翻原判断——注解口两路径本就一致(只认 sent-unverified),真差异=通道 accepted 台账缺 HOT-003 注解 detail,已补 receipt.note 兜底)
- [x] KR-AUD-47 [P3] RT-10 hotReloadRetryCommand.ts sentAt 时点与 fire 路径不一致（原稿未逐行复核项，动手前先取证）。验收：统一语义+注释固化。(b1d19f4;真差异=通道核验窗口锚点在冻结读取之前被耗时吃掉——修为逐组紧贴 transport.send 取锚,红测试 onRecorded 推时钟判别,三次 mutation 验证旧锚变体全红)
- [x] KR-AUD-48 [P3] RT-11 serverManager.ts:583,590 existsSync/statSync TOCTOU。验收：statSync 入 try 或单次 stat 判存在。（对账勾账：71496ec 修复已落 main）
- [x] KR-AUD-49 [P3] RT-12 telnetWebView.ts:365-404 插值未全转义+querySelector 拼接(:400)。验收：escapeHtml+CSS.escape。（2026-11-07 对账勾账：取证确认修复已落 main——159d6261 完成双面修复：插值面 key/label/host/输出行全量 escapeHtml（telnetWebView.ts:233-295 各插值点），脚本面 querySelector 拼接改 `CSS.escape(entry.key)`（telnetWebView.ts:424-425，带选择器元字符注释）；判别测试 tests/webviewSecurity.test.ts:188-259「KR-AUD-49」专属块 2 例——恶意 key/label/host 配置不产生标签+closed 指引转义+断言 CSS.escape 存在+nonce CSP，16/16 绿。）
- [x] KR-AUD-50 [P3] RT-13 monitoring/log/telnet/entityDependency/entityFlow 五 webview 均无 CSP。验收：最小 CSP 或 nonce（与 08/38/43 一批统一做）。（对账勾账：2491152 修复已落 main）
- [x] KR-AUD-51 [P3] RT-14 telnetClient.ts:141-243 connect 无超时。验收：socket 超时+destroy。（对账勾账：c4513fa 修复已落 main）
- [x] KR-AUD-52 [P3] RT-15 quickActions.ts:177-190 存活终端复用语义需明确+Windows `%`→`%%`。验收：复用语义注释固化+Windows 分支转义。（对账勾账：2b1b0ef 修复已落 main）
- [x] KR-AUD-53 [P2] UI-2 entityDependencyWebView.ts:1215(CDN)/1255(securityLevel loose)/1012(statCard 未转义)+entityFlowWebView.ts:276——CDN 供应链+离线失效+标签注入。验收：mermaid/chart.js 离线打包+nonce CSP+strict+escapeHtml（行号为 1403e72 后新行号）。（对账勾账：2491152 修复已落 main）
- [x] KR-AUD-54 [P2] UI-4 definitionWorkspace.ts:153 无参回落第一根；extension.ts:1626,1645,1746 无参调用点实核（entityDependencyWebView/databaseSimulator 旧调用点已重构未复核，动手前重定位）。验收：命令入口传根，多根不串。（对账勾账：48bccec 修复已落 main）
- [x] KR-AUD-55 [P2] UI-5 extension.ts:5318-5319 entityDefsPath/entitiesXmlPath 不在配置失效清单。验收：两键变更触发 schema/索引失效。（对账勾账：42f374b 修复已落 main）
- [x] KR-AUD-56 [P2] UI-6 inferPipeline.ts:305-444 watcher 无防抖无互斥，并发 unlink/write 竞态。验收：debounce+在途互斥（dirty 补一轮）。（对账勾账：2437113 修复已落 main）
- [x] KR-AUD-57 [P3] UI-7 extension.ts:5521-5522 serverManager.dispose() 重复调用笔误。验收：删一行。（对账勾账：317bb58 修复已落 main）
- [x] KR-AUD-58 [P3] UI-8 selfAttributeNoneDiagnostics.ts:34,72-74 原文行匹配 self.x.y 无掩码，字符串/注释假阳性。验收：接 pythonLexicalMask+假阳性回归测试。（对账勾账：c2b0323 修复已落 main）
- [x] KR-AUD-59 [P3] UI-9 selfAttributeFlowTypes.ts:149,177 增强赋值误捕获 RHS。验收：`+=` 排除+流类型保持测试。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0417)
- [x] KR-AUD-60 [P3] UI-10 typeInlayHints.ts:53 不消费 CancellationToken。验收：token 透传+取消生效。（对账勾账：0ef042c 修复已落 main）
- [x] KR-AUD-61 [P3] UI-11 eventApi.ts:70 全仓逐文件 openTextDocument。验收：改索引/缓存路径，大仓 F12 不秒卡。（对账勾账：b75c260 修复已落 main）
- [x] KR-AUD-62 [P3] UI-12 entityBuiltinProperties.ts:205-215+languageProviders.ts:726 内建属性 inlay 在注释/字符串产提示。验收：掩码后匹配。（对账勾账：791dadf 修复已落 main）
- [x] KR-AUD-63 [P3] UI-14 entityDependency.ts:322-365 calculateMaxDepth 递归臂不可达（istanbul ignore 自证），继承深度恒 1。验收：真实链深计算+统计口径变更登记。（对账勾账：840d63c 修复已落 main）
- [x] KR-AUD-64 [P3] UI-15 pythonReturnTypeInference.ts:42,79,83 赋值检测跑原始行，三引号内误判。验收：掩码先行+假阳性回归。（对账勾账：ac521ca 修复已落 main）
- [x] KR-AUD-65 [P3] UI-16 languageProviders.ts hover/定义数据字典口径不一致+每次悬停全文扫描。验收：口径统一+缓存。（对账勾账：5b690bf 修复已落 main）
- [x] KR-AUD-66 [P3] UI-17 projectProfiles.ts:108-127 create() 丢弃 input.hotReload。验收：字面量补拷贝+透传测试。（对账勾账：e497397 修复已落 main）
- [x] KR-AUD-67 [P1] DEF-1 messageTable.ts:605-608,463-466 接口 def 提前 return 跳过自身 Interfaces 递归与组件槽注册——utype/aliasID 与引擎错位。验收：带 Components/嵌套 Interfaces 的接口 fixture 与引擎对拍（引擎侧 entitydef.cpp:611-638 断言保留原稿）。同步修 Rust 侧闭包发现与注释。（159d626;接口按引擎 L611-638 递归自身 Interfaces+注册 Components+不装 Parent,path 守卫截断接口环,Rust 闭包发现同步接口递归/组件;tests/messageTable.test.ts:488/518/559+messageTableRust 覆盖嵌套接口/组件槽/接口环;26 文件 602 过|2 跳+cargo kode-python/kode-server 全绿）
- [x] KR-AUD-68 [P1] DEF-2 kbengineProtocol.ts:649-663 cprofile 分支漏读 timingLength，行数据整体错位。验收：夹具帧解析与引擎 CProfileHandler 写序对拍（引擎行号保留原稿）。（159d626;cprofile 按 profile_handler.cpp:95-128 先读 timingLength 再行数/行数据;tests/cov-debug-process.test.ts:965 断言 timingLength=15+行字段,截断帧仍不越界;26 文件 602 过|2 跳）
- [x] KR-AUD-69 [P1] DEF-3 entityWizard.ts:97-98 模板生成 `<position>` 触发引擎受限属性拒绝。验收：新向导产物不含受限名（position/direction/spaceID），与 defAnalyzer 检查一致。（159d626;模板移除 position,受限名清单 position/direction/spaceID 与 defAnalyzer 同源;tests/entityWizard.test.ts 断言三受限名全缺席+生成物可装载;26 文件 602 过|2 跳）
- [x] KR-AUD-70 [P1] DEF-4 defCallChain.ts:135 `lines.slice(bodyStart)` 无 endLine 截尾，兄弟方法调用误归属。验收：`slice(bodyStart, endLine)`+同文件双方法 fixture。（159d626;receiver 调用面改为 slice(bodyStart,endLine);tests/defCallChain.test.ts 同文件双方法夹具断言兄弟方法调用不误归属;26 文件 602 过|2 跳）
- [x] KR-AUD-71 [P2] DEF-5 defReferenceGraph.ts:185-200 组件/接口 Parent 解析目录与引擎不一致（硬编码 category:'entity' :191）。验收：组件 Parent 按 components/ 目录解析，接口 Parent 忽略。（对账勾账：2ac80ed 修复已落 main）
- [x] KR-AUD-72 [P2] DEF-6 definitionSemantics.ts:427-433,602-607 接口 def Parent 被合并进语义（引擎不可见）。验收：interface 解析丢弃 Parent。（对账勾账：16923c5 修复已落 main）
- [x] KR-AUD-73 [P2] DEF-7 clientSdkGenerator.ts:284-367 实体 SDK 不合并父类/接口成员、无 extends（轻核）。验收：继承实体 SDK 含父链成员。（对账勾账：9add2f0 修复已落 main）
- [x] KR-AUD-74 [P2] DEF-8 codeGenerator.ts legacy 分支类名/目录与引擎约定不符。验收：对齐新向导或移除 legacy。（对账勾账：4e1901a 修复已落 main）
- [x] KR-AUD-75 [P3] DEF-9 defParser.ts:481 tokenizeXml `[^>]*?` 属性值含 '>' 提前终止。验收：注释/CDATA/属性值含 '>' 的定位不 desync。（对账勾账：c4f4764 修复已落 main）
- [x] KR-AUD-76 [P3] DEF-10 defChain.ts:73,100,127 嵌套 Interfaces 不进链式视图。验收：嵌套接口成员入链。（对账勾账：4d82b37 修复已落 main）
- [x] KR-AUD-77 [P3] DEF-11 defSymbolReferences.ts:245 仅识别 'Interface' 一种包装名（引擎接受四种）。验收：复用 defRenamer 常量覆盖四种。（对账勾账：5050c84 修复已落 main）
- [x] KR-AUD-78 [P3] DEF-12 generatedSourceMap.ts:20-31 硬编码 line 0/2 全覆盖 key 0。验收：按实际类起始行分配。（对账勾账：c36bdaa 修复已落 main）
- [x] KR-AUD-79 [P3] DEF-13 clientSdkGenerator.ts:390 `<Arg>ARRAY<of>X</of></Arg>` 只取 "ARRAY"。验收：识别 `<of>` 子元素。（对账勾账：4f64159 修复已落 main）
- [x] KR-AUD-80 [P1] RSV-1 def_md5.rs:998-1005 load_interfaces 语义建模错误（child_el 具名查找+取元素名，引擎为 FirstChild 非注释子节点 getKey）——接口内容整体缺席 md5。验收：Avatar.def 文本/元素两种形态与引擎对拍。〔golden 为自推导，须先补引擎对拍夹具〕（对账勾账：159d626 探针修复已落 main；ee8d073 补引擎对拍夹具——getKey/enterNode 语义按本机 kbengine xml.cpp:72-95/113-119 + entitydef.cpp:562-585 取证，接口文本/元素两形态 golden 样本 md5 归一（6AEE7744…），跨形态 md5 相等 + 缩进元素形态与紧凑归一（tinyxml2 DOM 无"原始字节纯空白"文本节点，enterNode 首子扫描按原始字节分类跳过，实体解码节点照建）+ 缺失接口 def 报错点名入 units 测试；修前 159d626^ 实录 15 红）
- [x] KR-AUD-81 [P1] RSV-2 def_md5.rs:1042-1055 component_type_name 误取元素名 "Type"（应取 `<Type>` 文本，按引擎三步导航）。验收：`<bag><Type>Inventory</Type>` 夹具 md5 与引擎一致。（对账勾账：159d626 探针修复已落 main；e971fc4 补引擎对拍夹具——entitydef.cpp:655-671 三步导航取证，bag/Inventory golden 样本（6A90415E…）锁 Inventory 模块名入流，缩进排版 md5 鲁棒 + Ghost 报错点名 + 无 <Type> 节点报错口径入 units 测试）
- [x] KR-AUD-82 [P2] RSV-3 def_md5.rs:341-364,543-548 is_entitycall 依赖可变 alias_name，types.xml 别名即失效。验收：改用构造即知的 TypeKind 判定，register 不覆写类型元信息。（对账勾账：954af42 修复已落 main）
- [x] KR-AUD-83 [P2] RSV-4 def_md5.rs:1167-1185 load_parent_class 不支持 `<Parent><Avatar/></Parent>` 元素形态。验收：first_child 两分支语义（文本优先，无文本取子元素名）。（对账勾账：e206127 修复已落 main）
- [x] KR-AUD-84 [P3] RSV-5 lint/rules.rs:664-945 UnknownFlagValueRule 多 token 放行 vs 引擎整串查表。验收：按引擎整串，'|' 形态单独出「引擎不支持」诊断。（对账勾账：00fdd82 修复已落 main）
- [x] KR-AUD-85 [P3] RSV-6 def_md5.rs:900-918 calc_property_utype 全局查重比引擎跨模块容忍更严。验收：对齐引擎容忍度或登记口径差异。（对账勾账：e87908d 修复已落 main）
- [x] KR-AUD-86 [P3] RSV-7 def_md5.rs:354-364 is_entitycall 嵌套 ARRAY 递归 vs 引擎一层 type()。验收：ARRAY<ARRAY<ENTITYCALL>> 判定对齐引擎。（对账勾账：791dd8b 修复已落 main）
- [x] KR-AUD-87 [P3] RSV-8 kode-parser model.rs:349-350,400 OWN_CLIENT/OTHER_CLIENTS 未入 cell 域（仅 IDE 提示展示面）。验收：域表对齐 ENTITY_CELL_DATA_FLAGS。（对账勾账：a155d76 修复已落 main）
- [x] KR-AUD-88 [P3] RSV-9 kode-parser model.rs:157-162 extract_def interfaces 仅识别文本形态（与 RSV-1 同根）。验收：元素形态产出接口引用。（对账勾账：66220ed 修复已落 main）
- [x] KR-AUD-89 [P3级] RSV-10 python_callgraph.rs:161 file_stem 仅按 '/' 分割——非缺陷，防回归登记：上游斜杠归一化加断言。（对账勾账：62f417a 修复已落 main）

- [x] **USER-LINT-01 · P1 · 误报修复 · 引擎校验器守卫不识别**（用户报 2026-11-04）：`if kbe.isValid(self.client): self.client.xxx()` 仍报 receiver-none Warning——receiverNoneDiagnostics 的 guard 分析只认 `subject`/`subject is no`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0418)

- [x] **USER-LINT-02 · P1 · 误报修复 · 注释形态漏屏蔽**（用户报 2026-11-04）：`# self.client` 已有 # 注释仍报 receiver-none 警告——词法掩码（pythonLexicalMask）理论应屏蔽注释内的接收者引用，但实际有路径漏走。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0419)

- [x] **KR-AUD-90 [P2] cancel_queued 不回写 keyed 台账**（RUST-5 审核+作者共同发现）：keyed 任务经 stale-version/队满淘汰被取消后，keyed 条目停留 Queued → 后续 ensure 恒 Reused（走 Recovered 路径，行为可辩但语义需审视）。验收：cancel 路径回写 keyed 或显式标记；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0420)


## Rust 核心后续深审补漏（2026-11-04）

证据：[Rust 核心后续源码审计](docs/review/2026-11-04-rust-core-followup.md)（HEAD `c6e8ba1` + 当时工作区，最小探针直接编译相关源码验证）。仅登记未被既有条目覆盖的新缺陷；Rust serving 尚未切流、调度/语料 crate 尚未统一接线等已有迁移范围不重复入账。以下按条目记录进度，须补修复前红、修复后绿的常驻回归；临时探针不充当验收关闭证据。

- [x] KR-AUD-91 [P1] 调用图节点与边贯穿文件身份：`crates/kode-server/src/python_callgraph.rs:206/219` 方法 ID 仅 `Class.method`、函数 ID 仅 `stem::function`，模块仅 stem；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0421)
- [x] KR-AUD-92 [P2] 组件编解码 schema 查询保留组件身份：`crates/kode-server/src/wire_codec.rs:856/884` 属性解码布局回调仅收 child，丢 parent；`:985/1000` 方法参数布局回调仅收 MethodRef，丢已读取的 component_alias。验收：属性回调按 `(parent,`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0422)
- [x] KR-AUD-93 [P2] 方法参数编码拒绝数量不匹配：`crates/kode-server/src/wire_codec.rs:971` 对 arg_layouts 与 args 直接 zip，多参静默丢弃、少参生成缺参帧仍返回 Ok。验收：写输出前检查参数数与布局数相等；多参/少参明确 Err 且输出缓冲保持原状，零参/完整参数正确编码；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0423)
- [x] KR-AUD-94 [P2] 方法编号模式转换禁止整数截断：`crates/kode-server/src/wire_codec.rs:959` Alias 模式把 `MethodRef::Utype(u)` 直接 `as u8`，257 被编码为 1 且返回 Ok。验收：MethodRef 与编码模式不匹配时在写输出前拒绝，或经显式消息表映射后编码，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0424)
- [x] KR-AUD-95 [P3] 修复 RootRegistry 默认构造保留 ID 冲突：`crates/kode-vfs/src/store.rs:42/49` 派生 Default 使 next_id=0，而 new() 从 1 起；`RootRegistry::default().register("/project")` 返回 UNROOTED 的保留 RootId(0)。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0425)
- [x] KR-AUD-96 [P3] 修复文件系统根的 URI 归属边界：`crates/kode-vfs/src/store.rs:121` prefix_len_at_boundary 注册 `/` 后对 `/project/a.py` 的剩余串为 `project/a.py`，因不以 `/` 开头而拒绝，返回 UNROOTED。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0426)

## 空间/导航引擎功能提示适配（2026-11-05）

背景：kode 作为 KBEngine 配套插件，空间分配/导航加载相关 API 已有类型 stub（`kbengine/typings/_KBEngine_*.pyi`：`addSpaceGeometryMapping`/`navigate`/`setSpaceData`/`CellAppModuleHooks`）与知识库（`docs/knowledge/api-cellapp.md`、`entry-script-spi-methods.md`，含 file:line/签名/回调链），stub 导出经 `src/pythonStubExport.ts` 可被 Pylance 消费；但入口脚本 SPI 与资源路径提示未接入 kode 自有 language service（hover/补全/诊断）。

- [x] SP-1 [P0] 入口脚本 SPI hooks 接入 hover/补全
  缺口：`onSpaceGeometryLoaded` / `onAllSpaceGeometryLoaded` / `onSpaceData` 等 kbemain 模块级回调只在 knowledge 文档与 `_KBEngine_hooks.pyi` Protocol 中；`src/hooks.ts` 36 个实体 hooks 仅含 `onEnterSpace`/`onLeaveSpace`/`onSpaceGone`，模块级 SPI 无 hover/文档/源码跳转。
  落点：`src/hooks.ts` 新增 entry 类（或复用 space 分类），数据源对齐 `docs/knowledge/entry-script-spi-methods.md`（已有宏签名/格式/file:line）；`src/languageProviders.ts` `createHookHover` 按文件路径（`scripts/*/kbemain.py`）作用域过滤，避免污染实体脚本。
  验收：kbemain.py 中 `onSpace*` 出现补全，hover 显示签名+调用时机+源码位置（如 `spacememory.cpp:308/336/609`）；实体 hooks 既有测试零回归；prove-red=修复前 kbemain 无该补全/hover。
  （2026-11-05 完成：新建 `src/entryHooks.ts` 独立数据面——`KBENGINE_ENTRY_HOOKS` 收录空间三件套 `onSpaceData`/`onSpaceGeometryLoaded`/`onAllSpaceGeometryLoaded`，模块级签名无 self，sourceLocation=引擎实调行 `spacememory.cpp:613;:619`/`:308`/`:336`；`isComponentEntryScriptFile` 按 `/<component>/kbemain.py` 路径段作用域（cellapp→`/cell/`）。接线 `src/languageProviders.ts`：①补全=`provideCompletionItems` .py 分支 `def (on\w*)$` 前缀匹配+入口路径闸（:616-630）②hover=`provideKnownHover` hoverShowValueDocs 段先查 entry 再落实体 hooks（:1452-1468），新增 `createEntryHookHover`（:2507）。prove-red=tests/entryHooks.test.ts 首跑 `Cannot find module '../src/entryHooks'`；修后 11/11 绿（数据面 4+引擎源码行核验 1+补全 3+hover 3，实体脚本不接管/前缀过滤反例在内）。门禁：`npx vitest run tests/entryHooks.test.ts` 11/11；hooks+languageProviders+featureToggles 四件套 144 过/1 挂（挂=tests/hooks.test.ts `onDestroy` cellapp/entity.cpp:211 行号漂移，stash 验证与本改动无关的既有失败）；languageProvidersInternals 2 挂同为 stash 复现的既有失败；`tsc --noEmit` 0 错；eslint 改动 3 文件 0 错。未 commit。）

- [x] SP-2 [P1] KBEngine 模块函数 hover 挂 knowledge 摘要
  落点：`src/kbeModuleIndex.ts`（38 符号）为 `addSpaceGeometryMapping`/`setSpaceData`/`navigate`/`raycast` 等挂 metadata，hover 附 `api-cellapp.md` 对应行摘要+file:line（模式同 hooks 的 sourceLocation）。
  验收：`KBEngine.addSpaceGeometryMapping(...)` hover 含层参数语义与回调链说明；未挂符号零回归。
  （2026-11-05 完成：`src/kbeModuleIndex.ts` 新增 `CELLAPP_STUB`（typings/_KBEngine_cellapp.pyi）+6 个 cellapp 空间/导航模块函数——`addSpaceGeometryMapping`(:40)/`getSpaceGeometryMapping`(:47)/`setSpaceData`(:48)/`getSpaceData`(:49)/`delSpaceData`(:50)/`raycast`(:54)，summary=api-cellapp.md 行摘要（层参数/回调链 onSpaceGeometryLoaded/onAllSpaceGeometryLoaded/onSpaceData/raycast 几何前置），双语 GEN-DEF-1d 齐备。接线 `src/languageProviders.ts`：`provideKnownHover` hoverShowValueDocs 段先解析 `resolveKbeAccessAtPosition`（alias.Symbol 访问位,未引入别名不接管）→ `getKbeSymbol` → 新增 `createKbeSymbolHover`（:2542，summary+typings 锚点+版本标注）；导入 `summaryForLanguage`/`engineApiVersionAnnotation`。prove-red=tests/spaceNavSymbols.test.ts 首跑 7/9 挂（符号缺席+hover 空）；修后 9/9 绿（数据面 5+hover 4,含未引入别名反例与裸 reloadScript 兜底）。门禁：`npx vitest run tests/spaceNavSymbols.test.ts` 9/9；kbeModuleIndex+entryHooks+languageProviders×3 五件套 146/146 绿（引擎 typings 锚点逐条回验含新增 6 条）；pythonStubExport+parityGolden 绿；`tsc --noEmit` 0 错；eslint 改动 3 文件 0 错。extension.test.ts 2 超时经 stash 验证为既有失败（假组件进程 5s 超时,与本改动无关）。未 commit。）

- [x] SP-3 [P1] 导航资源路径补全
  落点：`addSpaceGeometryMapping` 第 3 参与 `params` dict 值 → 扫描 assetsRoot 下 `*.navmesh`/`*.tmx` 补全（参考既有 assetsRootScan/listPathRes 面）。
  验收：路径前缀补全出工作区实际存在的导航文件；无匹配文件时不误报、不阻塞补全。
  （2026-11-05 完成：`src/languageProviders.ts` 新增 `getAddSpaceGeometryStringPrefix`（:535，检测光标位于 addSpaceGeometryMapping 字符串实参内,含 params dict 嵌套括号深度与转义感知,离开调用即拒）+ `KBEngineCompletionProvider.provideNavPathCompletions`（:734，`findFilesAcrossRoots('**/*.navmesh'/'**/*.tmx')` 双扫 workspace+assetsRoot,相对路径去重,按已输入前缀 includes 过滤,kind=File,detail=navmesh/tmx）；接线于 provideCompletionItems .py 分支 SP-1 entry hooks 之后（:685）。prove-red=tests/navPathCompletion.test.ts 首跑 3/6 挂（path 参/params 值/前缀过滤三正例全空）；修后 6/6 绿（正例 3+反例 3：无匹配空表不误报、非目标调用不接管、既有 KBEngine. reload 补全零回归）。门禁：`npx vitest run tests/navPathCompletion.test.ts` 6/6；languageProviders×3+entryHooks+spaceNavSymbols+kbeModuleIndex 六件套 155/155 绿；`tsc --noEmit` 0 错；eslint 改动 2 文件 0 错。未 commit。）

- [x] SP-4 [P2] 空间/导航语义诊断
  落点：DiagnosticScheduler——`navigate`/`canNavigate` 前置条件（几何未加载）、`_mapping` 保留键被脚本覆盖、layer 与 params 不一致。
  验收：各反例产诊断、正例零误报，接入既有诊断测试口径（prove-red 后修复）。
  （2026-11-05 完成：新建 `src/spaceNavDiagnostics.ts` 纯文本三检——①setSpaceData/delSpaceData 保留键 `_mapping`（引擎 spacememory.cpp:740/862 双路径 AssertionError）②文件有 navigate/navigatePathPoints 但全文无 canNavigate（几何未加载静默失败,entity.cpp:2583 not found navhandle;canNavigate 探针 :2563）③addSpaceGeometryMapping params dict 引号层键（引擎 PyLong_Check,spacememory.cpp:194）。开关 `kbengine.spaceNavDiagnostics` 默认开,接入 extension.ts receiverNone 同通道（computeAsync 尾部追加 spaceNavItems,共享 collection/生命周期）。prove-red=tests/spaceNavDiagnostics.test.ts 首跑 Cannot find module；修后 12/12 绿（三类反例+正例+组合+空文）。门禁：`npx vitest run tests/spaceNavDiagnostics.test.ts` 12/12；receiverNone 三件套 53/53 绿；`tsc --noEmit` 0 错；eslint（修 no-useless-escape 后）0 错；package.json JSON 合法。extension.test.ts 2 超时为已 stash 验证的既有失败。未 commit。）

- [x] SP-5 [P2] `createCellEntityInNewSpace(cellappIndex)` 语义 hover
  落点：参数处 hover 说明 0=自动均衡、N=取模轮转（口径=docs/zh/api/kbengine/baseapp/Entity.md:144）。
  验收：cellappIndex 参数 hover 显示语义说明与示例。
  （2026-11-05 完成：`src/languageProviders.ts` 新增 `createCellappIndexHover`（:2632，word=cellappIndex 或 createCellEntityInNewSpace 时返回语义悬停——0/None=负载均衡自动选、N>0=取模轮转 `(N-1)%cellappSize`（cellappmgr.cpp:348-351）、搭配 NOT_PARTCIPATING_LOAD_BALANCING 钉大地图+副本走机动、python 示例块+源码锚点 baseapp.cpp:2462→cellappmgr.cpp:310）；接线于 provideKnownHover hoverShowValueDocs 段首（:1555,先于 SP-2/SP-1,名称无冲突）。prove-red=tests/cellappIndexHover.test.ts 首跑 4/5 挂（参数语义/示例/方法名/def Arg 四正例全空）；修后 5/5 绿（含不劫持无关标识符反例）。门禁：`npx vitest run tests/cellappIndexHover.test.ts` 5/5；SP 全家桶八件套 141/141 绿；`tsc --noEmit` 0 错；eslint 改动 2 文件 0 错。未 commit。）

- [x] 审核发现：诊断使用全文偏移作为行内列号，第二行起的空间导航告警会定位到错误位置或行末（src/spaceNavDiagnostics.ts:136）。（67d34aa；`computeSpaceNavFindings` 三类发现统一改 `start/end` 为行内列——新增 `offsetToCol(starts, offset)`（offset 减该行起始偏移），不再把全文偏移当列号；_mapping/引号键/self.navigate 三处均改列口径；tests/spaceNavDiagnostics.test.ts 新增「第二行起的诊断列号是行内列而非全文偏移」「第二行起的 _mapping 键列号是行内列」两例（旧实现全文偏移当列号即红）。门禁：`npx vitest run tests/spaceNavDiagnostics.test.ts` 18/18 绿；`tsc --noEmit` 0 错；eslint 改动 2 文件 0 错。）
- [x] 审核发现：范围历史不检查编辑器未保存内容，直接用磁盘差异映射选区，未保存的插入或删除会查询错误的 HEAD 行（src/extension.ts:4200）。（95a28f5；`rangeHistoryDirtyGuard(isDirty)` 守卫注入 src/gitHistory.ts，extension.ts:4210 接线——isDirty=true 时跳过磁盘查询并直接返回不可用状态，不再用磁盘差异映射选区；tests/gitHistory.test.ts 新增「未保存内容不走磁盘查询」一例。门禁：`npx vitest run tests/gitHistory.test.ts` 10/10 绿。）
- [x] 审核发现：Git 查询缓存包含工作区 diff 和 HEAD 查询且范围历史未绕过缓存，文件修改或提交后再次查询会使用过期映射与历史（src/gitQueryGate.ts:205）。（3c04ab2；`queryTouchesHead()` 新增——args 含 HEAD/diff(无 HEAD 则含 .)、rev-parse HEAD、log -n1 HEAD~N、show HEAD:x 等触碰 HEAD 的查询直读 Git 不读写缓存（volatile），其余非 HEAD 查询照常走缓存；tests/gitQueryGate.test.ts 新增 HEAD/diff/rev-parse/log/show 各路径用例。门禁：`npx vitest run tests/gitQueryGate.test.ts` 27/27 绿。）
- [x] 审核发现：重命名历史翻页时以当前路径重新解析被跳过的历史，重命名以前的提交会关联错误路径而无法打开版本（src/gitCommitLog.ts:168）。（d793378；entries 新增 `continuationPath`——R 状态跟踪到 oldPath、C 状态跟踪到 newPath；`loadNextPage` 从 `{parentCommit, path}` 起查而非 `--skip`，逐页沿重命名边界正确追踪旧路径；tests/gitCommitLogFollow.test.ts 新增重命名边界续查 4 例。门禁：`npx vitest run tests/gitCommitLogFollow.test.ts` 12/12 绿、`npx vitest run tests/gitCommitLog.test.ts` 18/18 绿。）
- [x] 审核发现：重命名状态直接使用 Git 默认转义后的路径，包含中文等需引号转义的文件名会导致历史版本路径错误（src/gitCommitLog.ts:209）。（732abb4；`unquoteGitPath()` 新增——R/C 状态路径含 `"` 前缀时剥离外壳引号并把 `\NNN` 八进制转义逐字节 TextDecoder 解码回 UTF-8（中文名不再截断），无引号路径原样；tests/gitCommitLogFollow.test.ts 新增中文名重命名 2 例。门禁：`npx vitest run tests/gitCommitLogFollow.test.ts` 12/12 绿。）
- [x] 审核发现：相对路径检查拒绝任意包含两个连续点的合法文件名，且在 Windows 上拒绝所有子目录路径，导致版本和选区历史无法查询（src/gitHistoryDiff.ts:64）。（732abb4；`relativeVersionPath` 逃逸守卫由 `rel.includes('..')` 改为按 `path.sep` 切段后逐段判——只拒绝确切 `..`/`.` 段，`a..py` 等合法文件名不再误杀；Windows 子目录由 `pathApiFor` 风格选路径（POSIX 输入走 path.posix），非 POSIX 平台 `\` 仅作分隔符不误杀。门禁：`npx vitest run tests/gitHistoryDiff.test.ts` 19/19 绿。）
- [x] 审核发现：文件历史的并发请求没有代际检查，较早查询后返回时会覆盖用户刚选择的文件历史（src/gitHistoryTree.ts:269）。（f3fc92b；`GitHistoryTreeProvider` 新增 `generation` 递增计数器——每次用户选择文件时递增，`loadHistory` 捕获当次 generation，await 返回后若 `generation !== captured` 即丢弃本轮结果不写入面板；tests/gitHistoryTree.test.ts 新增并发请求代际守卫 3 例。门禁：`npx vitest run tests/gitHistoryTree.test.ts` 17/17 绿。）
- [x] 审核发现：父提交查询失败被当作根提交，超时或 Git 错误时差异视图会错误显示整份文件为新增（src/gitHistoryDiff.ts:134）。（1f98c3b；`getParentCommit` 返回 `{kind:'parent'|'root'|'error'}` 三态——`rev-parse <c>^` 成功→parent、`unknown revision`→root、其他错误/超时→error；`openVersionDiff` 对 error 抛出，不再把查询失败当成根提交渲染整份文件为新增；tests/gitHistoryDiff.test.ts 重写父查询路径 6 例。门禁：`npx vitest run tests/gitHistoryDiff.test.ts` 19/19 绿。）
- [x] 审核发现：选区跨越已删除的 HEAD 行时将多个不连续映射段合并为一个范围，导致历史包含用户未选中的已删除行（src/gitRangeHistoryTree.ts:375）。（4f7ba2a；`queryAndLoad` 改为逐段独立查询——选区映射到多个不连续 HEAD 行段时，每段分别 `log -L` 查历史，dedup 后合并 entries；不再把多段合并为一个 `-L start,end` 范围。tests/gitRangeHistoryTree.test.ts 重写多段选区 3 例。门禁：`npx vitest run tests/gitRangeHistoryTree.test.ts` 21/21 绿。）
- [x] 审核发现：派生 scripts 根存在时排除整个外部 assetsRoot，使 scripts 之外的资源和定义文件不再被索引（src/scanRoots.ts:138）。（9ae1067；`getIndexScanRoots` 改为派生 scripts 根存在时仍包含 assetsRoot——两者同时入索引，containment dedup 只去 `assetsRoot ⊇ scriptsRoot` 时删宽者（保留较窄 scriptsRoot），scriptsRoot 与 assetsRoot 有交集但互不含时两个根都保留；tests/scanRoots.test.ts 新增 3 例+tests/configDeriveScanRoot.test.ts 调整 2 例。门禁：`npx vitest run tests/scanRoots.test.ts` 11/11 绿、`npx vitest run tests/configDeriveScanRoot.test.ts` 2/2 绿。）
- [x] 审核发现：空间导航诊断在注释和字符串中也匹配调用，且把任意对象的 navigate 当作引擎方法，默认启用时会产生无关告警（src/spaceNavDiagnostics.ts:147）。（67d34aa；`computeSpaceNavFindings` 新增 `codeMask(text)` 逐字符词法掩码（行注释 `#`、单/双引号字符串含三引号→非代码区），… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0427)
- [x] 审核发现：共享在途 Git 查询仅使用首个调用方的取消令牌，一个视图取消会终止另一视图的相同查询，而后加入视图的取消不会生效（src/gitQueryGate.ts:200）。（4a989eb；`PendingEntry.addCaller(token)` 多调用方记账——cancel 仅当所有调用方都 cancel 才终止共享查询，任一调用方仍活跃则继续；后加入调用方的 cancel 生效于自身退出，不再透传给仍在等待的邻居；移除 `combineTokens`，首调用方不再独占令牌；tests/gitQueryGate.test.ts 新增共享取消 5 例。门禁：`npx vitest run tests/gitQueryGate.test.ts` 27/27 绿。）
## Windows 全量测试对齐（2026-11-05 全量 vitest 分析：6246 测试 194 失败/71 文件；CI=ubuntu 故 Windows 绿从未保证）

- [x] WIN-1 [P1] 真 bug：entityDependency 用 Uri.parse 读 fsPath（18 失败）
  落点：src/entityDependency.ts:140/185 对 `C:\...` 调 Uri.parse，fake-vscode 把 C 当 scheme 丢盘符 → ENOENT `\Users\...`（Linux `/` 开头不触发）。
  验收：entityDependency 四测试族 29/29 绿。
  （2026-11-05 已修：Uri.parse→Uri.file，本地验证 4 文件 29/29。）

- [x] WIN-2 [P1] 假组件 shebang 与 .exe 后缀（约 50 失败：serverManagerProcesses 18/serverReadiness 8/serverGroupLaunch 6/serverTargets 5/serverManagerRunner 4 等）（2026-11-05 关闭：391864f——spawnProcess 经 cmd /d /c… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0428)
  落点：tests/sim/fakeComponentBin.ts 写 `#!/usr/bin/env node` 脚本，Windows 不能直执 shebang（实测 direct exec FAIL、.cmd 包装 OK）；src/serverManager.ts:508 win32 给 executable 加 `.exe` 后缀，测试断言 `ghost` 实得 `ghost.exe`（消息+existsSync 双失配）。
  验收：FakeComponentBin win32 产 .cmd 包装（或 spawn 走 node 直调），测试断言按平台取后缀；serverManager* 全族绿。

- [x] WIN-3 [P1] 测试硬编码 POSIX 路径（约 35 失败：gitHistoryDiff 9/gitRepoLocate 7/pythonTestDiscovery 5/quickActionScanner 5/inferPipeline 6/debugConfig 6/navigationLayoutMatrix 3/pyreflyInfer 2 等）  （2026-11-06 注:configDeriveScanRoot 镜像 scriptsFromConfig 已双分隔符感知(7f377085,win32 绿);gitCommitLog「TAB 文件名 follow」用例 win32 ENOENT 预存失败待修,属本项遗留。。2026-11-07 全批清零:10 类清单修复(f6e24579+8d0e99e5+232211d2) PR #25 自合,双平台全量实测 Linux 7082/0 + imac win32 7033 pass/0 failed, main CI 42297636692 success)
  （2026-11-05 进度2：4d801cf git 路径批落地——pathApiFor 按输入风格选 path（win32 反斜杠信号→平台 path，/ 与相对纯 / 形态→posix；Linux 恒 posix）；relativeVersionPath 逃逸判定顺序修正（先 '..' 拒、归一 / 后再查残余 \——原顺序把 Windows 一切真实路径判成逃逸，文件历史映射整面失效）；gitCommitLog/gitHistoryTree/gitRangeHistoryTree/gitRunner/gitRepoLocate 全部改走风格感知 API。git 九文件 27 失败→165/165。全量 121→90。余 pythonTestDiscovery5/quickActionScanner5/inferPipeline6/debugConfig6/navigation 等约 35。）
  （2026-11-05 进度：server 族内 WIN-3 已清（占位符归一+平台断言随 391864f）；余 git*9/pythonTestDiscovery5/quickActionScanner5/inferPipeline6/debugConfig6/navigation 等硬断言批未动，全量 121 失败中约 40+ 属本项。）
  （2026-11-05 进度：pythonTestRunner.pathSuffixMatch 双分隔符归一已修（40d0082，pytest 结果条目从全 errored 转绿）；covExtensionCommands 夹具改 REAL_INTERPRETER 平台探测。git*/pythonTestDiscovery/inferPipeline 等硬断言批未动。）
  落点：测试断言 `/ws/...`、`/repo/...`，src path.join/dirname 在 win32 产出 `D:\repo\...`、`\ws\...`；gitRepoLocate.ts:62 `w + path.sep` 前缀匹配在混分隔符下必失配。
  验收：断言侧路径归一化（或 src 双分隔符兼容）；该批测试双平台绿。

- [x] WIN-4 [P1] 仓库无 .gitattributes + core.autocrlf=true（CRLF 类：configParity/configMergeParity golden 逐字段差 \r，与既有 wire_golden 同根因）（2026-11-05 关闭：.gitattributes 提交 559ce2f——tests/fixtures/** 与 crates/**/tests/golden/** 强制 eol=lf，两份上游 CRLF kbemain.py 以 -text 豁免；重检出后 configParity/configMergeParity 6/6、wire 17/17、cargo --workspace 仅剩与本项无关的既有 3 失败。）
  落点：tests/fixtures/** 检出 CRLF、golden 按 LF 生成。
  验收：.gitattributes 强制关键目录 eol=lf（或比对前归一化）；golden 类测试双平台绿且不破坏既有检出。

- [x] WIN-5 [P2] POSIX 语义依赖（约 15 失败：logCollectorSocket getuid/cov-longtail 信号 exit code/unexecutable chmod 000/schemaCacheCaseSensitivity 大小写盘等）
  （2026-11-05 进度：server 族信号/chmod 用例已 skip 随 391864f；killProcessTree taskkill 失败回落 child.kill 修掉 processManager stop 悬挂；余 logCollectorSocket getuid/cov-longtail/schemaCache 等未动。）
  （2026-11-05 进度：covExtensionCommands「已装 dump」用例 win32 skip 带注释（Node spawn 无 PATHEXT、.cmd 直 spawn EINVAL，Linux CI 保留覆盖）；logCollectorSocket/cov-longtail/schemaCache 等未动。）
  （2026-11-07 关闭：平台化批已随 win3/tests-portable 入主干（f6e24579 batch2 + 8d0e99e5/232211d2 收口，PR #25 线）——修复前基线 win-full 48 红/imac-full 49 红（2026-11-06 23:31/00:12，_winrun 快照），点名项全部测试侧平台化、不动产品逻辑：logCollectorSocket 「prefers process.getuid」skip win32 带注释（tests/logCollectorSocket.test.ts:252-254）；cov-longtail spawnTestProcess 信号终止 skip win32（Windows 无真 signal、code=1 非 null/SIGTERM，tests/cov-longtail.test.ts:1191-1199）及 watchFile EISDIR(:748)/readdir EACCES(:912) skip；schemaCacheCaseSensitivity 大小写盘 skipIf win32（tests/schemaCacheCaseSensitivity.test.ts:52，POSIX 侧语义保留）；chmod/EACCES 族（defReferenceGraph/entityMapping/defRenamer/computeDefRenameEdits/IDE-AUD-007 0o555·EACCES·RLIMIT_FSIZE）skipIf win32；kbengineProtocolReaders uid 平台分支（win32 无 getuid）。语义测试两平台各自固化：POSIX 全量保留覆盖，win32 跳过带原因注释。收敛证据：imac 真机全量 0 挂（7033 过/49 skip，2026-11-07 05:24 imac-check3b）；Linux 全量 0 挂（7061 过/21 skip，05:27 linux-final；主仓 HEAD=acf2775b 复跑 7141 过/2 skip/0 挂，09:11）。）
  落点：process.getuid 不存在于 win32；Windows 无真 signal，kill 后 code=null 断言失配；chmod 000 不阻止执行/读。
  验收：平台分支或 describe.skipIf(process.platform==='win32') 带注释；语义测试在两平台各自固化。

- [x] WIN-6 [P2] 环境缺失（本机安装，非仓库改动）——非仓库改动项：所需本地环境（依赖/工具链安装）不在代码交付面，需用户本机操作，不做仓库变更（2026-11-08 记录）
  （2026-11-05 进度：真 Python= scoop 3.15.2（~\scoop\apps\python\current，持久 PATH 第1、2条本就正确，会话快照旧致误判）+ pip 装好 pytest 9.2.0/ruff 0.17.3；py-spy 按 covExtensionCommands「未装」用例前提不装（venv 布局 resolvePyspyCommand 不受影响）。开发者模式/symlink EPERM 未解——需用户开「设置→开发者选项→开发者模式」后复测 quickActionRunners/workspaceDiscovery。）
  缺口：真实 Python（现为 WindowsApps 别名 exit 9009）+ pytest + ruff；Windows 开发者模式未开（symlink EPERM，2 失败：quickActionRunners/workspaceDiscovery）。
  验收：python --version/pytest --version 真实可用；symlink 探针 OK；相关测试绿。

- [x] WIN-7 [P2] 全量并行超时（5 硬超时：debugConfigAttach/extension/processManager/pythonClassIndex 等，单跑绿）（2026-11-05 关闭：9b522f3 vitest maxWorkers=8。硬超时 6→1（余1为既有单点）；原「单跑绿全量挂」的 4 个（extension/processManager/pythonClassIndex 等）实为 WIN-2 spawn 失败假象，随 391864f 一并消失。）
  落点：499 文件并行在 16C/8GB 挤爆；vitest 默认 maxWorkers 无上限保护。
  验收：vitest.config 限 maxWorkers（或提供 --maxWorkers 配方）；全量跑超时类清零。

- [x] 审核发现：单行复合语句（if/for/while 一行体）把体里的顶层 `=` 误判为对只读内建属性的注解赋值，`if self.isDestroyed: self.counter = 0`、`if self.cell: self.x = 1` 等常见形态误报只读写入（src/readOnlyWriteDiagnostics.ts:66-74 的 `:` 分支扫描自 :66 起对 `=`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0429)
- [x] 审核发现：多段映射合并后未按提交时间重排——逐段 `git log -L` 各自最新在前，`entriesByKey` 按段序（段1→段2→…）拼接、hash 去重保留首见，未做全局时间排序，跨段时间交错的提交在时间线视图中乱序，且父路径链 `entries[index+1]`（buildRangeHistoryItems 注释明示为更老提交）在段边界取错；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0430)
- [x] 审核发现：kode-db-clone 的 information_schema 查询把 schema 名用反引号当**标识符**比较，`TABLE_SCHEMA = \`kbe\`` 在真实 MySQL/MariaDB 上会报 `Unknown column 'kbe' in 'where clause'`（应作字符串字面量 `'kbe'`）；golden 测试只按 `FROM information_schema.TABLES` 子串匹配，故绿而真库必炸，PDC-0103 真库直连验收首跑即失败（crates/kode-db-clone/src/information_schema.rs:62-63、:70-72、:79-81）（2026-11-06 修复 3e8bccd：TABLE_SCHEMA 改单引号字符串字面量比对 quote_string 单引号双写转义,测试改断言 `'kbe''game'` 字面量形态且禁反引号标识符形态；tables/columns/statistics 三处查询同步）
- [x] 审核发现：kode-mcp `wire_from_json` 把单键对象一律当带标签值处理——普通单字段 FIXED_DICT 以朴素 JSON `{"hp":100}` 输入时键 `hp` 不是已知 tag，走 `!inner.is_object()` 早退返回 `Err("tagged value hp payload type mismatch")`，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0431)
- [x] 审核发现：kode-mcp `component_types_deep` 递归无环守卫——组件槽 type 解析到含同型/互引组件的 def（循环组件引用）时无限递归，栈溢出崩溃（crates/kode-mcp/src/kb.rs:488-510）（2026-11-06 修复 af62973：递归改带路径守卫 `seen: &mut Vec<String>`——当前路径上再遇同名 def(自引用/互引)即标记该槽 `"cycle": true` 不再展开(深度有界,菱形共享不受影响,因按路径 push/pop 而非全局去重),入口 `get_entity_model` 以空路径调用;新增 2 单测(自引用 A→A cycle 标记不展开/互引 A↔B 有界 cycle 标记),prove-red=旧码栈溢出 SIGABRT,`cargo clippy -p kode-mcp --all-targets -- -D warnings` 0,`cargo test -p kode-mcp` 全绿(5 lib+3 e2e+8 integration)）
- [x] 审核发现：kode-db-clone `redact_log` 对**带引号**的凭据值不跳过值体——`password="hunter2"` 在输出 `password=***` 后，值末搜索在偏移 0 处即命中原引号，`rest` 未前移，下一轮把 `"hunter2"` 原样回灌，明文凭据泄漏进审计日志；单测只用无引号值故绿（crates/kode-db-clone/src/redact.rs:94-98）（2026-11-06 修复 b91397a：引号值按配对闭引号整段跳过(含闭引号,未闭合吞余下,不吸收其后空白),裸值仍以空白/逗号为界;新增带引号/引号内空白两测试,值体与引号均不残留）
- [x] 审核发现：hotReload 通道 applied 核验 `channelBaselineReads.get(file)!` 非空断言——回执 `file` 不在本次发送批（异常/伪造接收端回包）时对 `undefined` 取 `.then` 抛 TypeError，中断回执回调批处理；应回落「无基准保持未确认」而非崩溃（src/hotReload.ts:428）`8595896`
- [x] 审核发现：gitCommitLog `unquoteGitPath` 只反解 `\\`、`\"` 与八进制 `\NNN`，未处理 git `core.quotepath` 对控制字符的 C 风格转义（`\t`/`\n`/`\r`/`\a`/`\b`/`\v`/`\f`）——含制表/换行符的文件名反解后保留字面转义串，重命名历史路径错误（罕见边界；src/gitCommitLog.ts:246-285）`e05fb62`
- [x] 审核发现：kode-db-clone preserve 模式（ImportMode::PreserveIfEmpty）apply 违反自身文档契约——`ImportRun.new_root_id` 文档写「preserve 模式为归档原值」，但 `new_root_id`（apply.rs 380-393）与 post-commit verify（`new_ids_for_table`，apply.rs 464-484）只收集 `PlannedCell::NewKey` 占位 id；preserve 模式下 planner 产出的 id 单元是 `PlannedCell::Literal`（import.rs 测试 `preserve_mode_keeps_ids_and_sm_autoload` 已断言），导致 preserve 模式即使按原 id 正确插入，verify 也恒报 post-commit DriftMismatch（found 0 vs expected N）且 `new_root_id` 为 None。（2026-11-08 覆盖率批次发现，crates/kode-db-clone/src/apply.rs:380-393、:464-484）**已修**：`new_ids_for_table` 增参 `rows` 按主键列绑定值取 id——NewKey 占位仍走数据库回填值（allocate 语义逐字节不变），id 列 Literal 取归档原值（preserve 契约落地）；`new_root_id` 改由同一 id 列表首项 + `typed_id_to_u64` 派生，两模式都符合文档；回归测试 `preserve_mode_verify_finds_archived_ids_and_root_handle`（golden_apply.rs，3 表 Avatar 归档端到端：verify found==expected 逐表全过、落库原 id 7/100/101/200、根句柄 Some(7)、清理计划引用原 id 只生成不执行），先证红（DriftMismatch found 0）后修绿；crate 178 过 0 败 + clippy -D warnings 0（1de8860c）
- [x] 审核发现：KODE-REDIS-UI-001 落地（81c4adf7）只注册 `kbengine.playerData.previewRedisKeyspace` 不在 package.json 声明——extension.test「注册面与 package.json 贡献点一致」（P14 验收）恒红，main CI 自 2026-11-08 04:48 起持续红（覆盖率批次干净 HEAD worktree 首跑暴露）；修=补 contributes.commands 声明 + activationEvents + 中英 nls 标题（`2a36cb9c`，worktree 先验证 27/27 绿再入库）；同批加固 sharedFileEventsVersion 时序脆测——窗口 20ms/落定 10ms/到期 60ms 裕度过窄，负载饥饿（同机 629 worker 覆盖率并发）下 setTimeout(10) 实测越过 20ms 窗边界致窗口提前到期补投（CI 未复现属侥幸），放宽 150/30/300ms 语义不变

## 审核 942424540716c9c17cdf62d26a92ea06a0873c18..HEAD（2026-11-06，只审不改）

- [x] 审核发现：`queryTouchesHead` 只识别字面 `HEAD` 引用，而 `git log`/`git log -L s,e:path`/`git log --skip=N -- path`（gitRangeTimeline.ts:191、gitCommitLog.ts:164）不带显式提交时**默认以 HEAD 为起点**——这类查询被 `queryTouchesHead` 判为 volatile=false 而进缓存，提交后重查范围历史/日志页仍读到过期结果，与 3c04ab2「HEAD 触达查询不缓存」的修复声明相悖（src/gitQueryGate.ts:78）`d044ba2`
- [x] 审核发现：只读写入判定的 `AUGMENTED_OPS` 含 `**=`/`//=`/`<<=`/`>>=`，但第 77 行只拼 `c + line[i+1]` 两字符（`**`/`//`/`<<`/`>>`）永不命中——`self.id **= 1`、`self.id //= 2` 等三字符增强赋值全部漏检，不报只读写入告警（src/readOnlyWriteDiagnostics.ts:77）`40087e3`
- [x] 审核发现：def 结构闸在**被拦批次上仍滚动基线**（`baselines.set(file, after)` 无条件执行）——结构性 def 变更被 fire 拦下后基线已推进到新内容，同目标失败重试再过闸因基线一致而放行，把结构性 def 经「重试」通道以普通 reload 下发，RT-3/IDE-HOT-005 声称防住的场景仍可复现（src/hotReloadDefGate.ts:56）`579ef92`
- [x] 审核发现：`pathApiFor` 在 win32 下仅以 `includes('\\')` 判风格，盘符+正斜杠路径（`C:/repo/...`）被误判为 posix，`path.posix.resolve` 会错误锚到 cwd；与 `usesPosixPath`（workspacePath.ts:15，`^[A-Za-z]:[\\/]` 正确认盘符）不一致，WIN-3 风格选径在盘符正斜杠输入下失配（src/workspacePath.ts:29）（2026-11-06 修复 7f377085：win32 pathApiFor 盘符+正斜杠形态归 win32(与 usesPosixPath 同口径),无分隔符相对名保持 posix;git 九族测试双平台绿）
- [x] 审核发现：多段映射用 `Promise.all` 并发发起全部段查询，选区不连续段数超过门限（range 并发 1 + 队列 8）时后段被 gate 以「历史查询队列已满」拒绝，整段范围历史查询整体失败（src/gitRangeHistoryTree.ts:383）（2026-11-06 修复 7f377085：分段改串行逐段查询(段间查代际,首段失败即停),新增 12 段超门限用例锁定在途峰值=1,24/24 绿）
- [x] 审核发现：params dict 引号键正则对**整个 dict 体**（含嵌套 dict）扫描，`{0: {"a": 1}}` 里嵌套 dict 的字符串键 `"a"` 被当作「params 层键」误报，但引擎只校验 params 顶层键（PyDict_Next），嵌套键不校验（实测 `{0: {"a": 1}}` 误报、`{0: "x: y"}` 不误报）（src/spaceNavDiagnostics.ts:261）（2026-11-06 修复 7f377085：topLevelQuotedKeys 深度感知只收顶层键位(嵌套 dict 字符串键不报),新增嵌套不误报/顶层照报两用例,21/21 绿）
- [x] 审核发现：跨行 `self\n.navigate(`（`\s*` 含换行）时诊断行号取 `self` 偏移的行、列号取 `navigate` 偏移的列，两者不同行导致范围落在错误行且越出行尾（实测 line=1/start=5..13，而 navigate 实际在行 2 列 5..13）（src/spaceNavDiagnostics.ts:233-237）（2026-11-06 修复 7f377085：行/列同取方法名偏移,新增跨行用例锁定行内截取恰为方法名本体,21/21 绿）
- [x] 审核发现：win32 `spawnProcess` 对 `.cmd/.bat` 用 `cmd /d /c @<路径>`，`@` 前缀置于 Node 自动加的双引号内破坏 cmd `/c` 的引号保留判定——组件路径含空格（`C:\Users\John Doe\`、`Program Files`）时命令在首个空格被截断、执行失败（src/processManager.ts:65）（2026-11-06 修复 7f377085：windowsVerbatimArguments 自拼命令行,@ 留引号外、含空格 token 自包引号(quoteForCmd),server 族/cov-debug/quickActionRunners 全绿）
- [x] 审核发现：`readDerivedTelnetTargets` 派生半忽略 `kbengine.telnet.configXmlPath` 设置（派生树走 assetsRoot/发现链，不读 configXmlPath），而旧路径 `readTelnetTargetsFromSettings` 优先 configXmlPath——配置了 configXmlPath 的用户派生端口/密码与旧路径不一致（src/telnetDeriveTargets.ts:79-86）（2026-11-06 修复 7f377085：显式 telnet.configXmlPath 即回旧路径(读该文件),新增另一份 xml 端口 47777 用例,8/8 绿）
- [x] 审核发现：`resolveEntryScriptFacts` 只展开 `${workspaceFolder}`、不展开 `${env:...}`（serverManager.getBinPath/getConfigPath 均经 expandWorkspacePlaceholders 支持 env），assetsRoot 用 env 占位符时入口脚本解析到错误路径→误报「entry script missing」且不断点预填（src/configDerive.ts:224）（2026-11-06 修复 7f377085：改走 expandWorkspacePlaceholders(${env:} 同 serverManager 口径),新增 env 占位解析用例,entryScript/configDerive 族绿）
- [x] 审核发现：kode-mcp `WireLayout::Blob` 分支错误提示宣称输入为 "base64/hex"，但代码 `as_str().as_bytes()` 原样入 blob，未做任何 base64/hex 解码——用户按提示传入 hex/base64 字符串会被错误地按原始字节编码（crates/kode-mcp/src/kb.rs:586）（2026-11-06 修复 7f377085：错误文案改如实口径 as_str 原样字节,不再宣称 base64/hex 解码）
- [x] 审核发现：`units.rs` 第 60 行断言 `names.contains(&"TrainingMonster") == false || names.contains(&"TrainingMonster")` 是恒真式（`A==false || A` 恒为 true），对 `TrainingMonster` 是否命中未提供任何覆盖（clippy 亦报 equality-checks-against-false），属假阳性断言（crates/kode-mcp/tests/units.rs:60）（2026-11-06 修复 7f377085：改如实断言 !contains(TrainingMonster),cargo test -p kode-mcp 全绿）
- [x] 审核发现：`render_select` 把表名/列名以反引号直接插值进 SQL 而未转义内含反引号，与 `information_schema.rs` 的 `quote_ident`（反引号 → `` `` `` 转义）不一致——一旦派生 def 标识符含反引号将生成畸形/可注入 SELECT（当前 def 语法下不可达，但属同类未转义缺口）（crates/kode-db-clone/src/planner.rs:224）（2026-11-06 修复 97c42ed：render_select 改经 quote_ident 反引号双写转义(与 information_schema 同口径),新增含反引号表/列名回归测试,生成形态为 `tbl``Avatar`/`weird``col` 且谓词不变）
- [x] 审核发现：`PendingWorkSnapshot.caches.parsedDocuments/databaseSchemas/annotationIndex` 声明为 `number`，但真实 `pendingWork()` 的量规是对象（`{entries,maxEntries,bytes,maxBytes}`/`{entries,capacity}`/`{entries,ttlMs}`）——声明与真实形态不符，直接喂真实数据会类型不符（当前 `drainablePendingWork` 未读 caches 故无运行时报错，属潜在类型契约缺陷）（src/pendingWorkDrain.ts:26-30）（2026-11-06 修复 7f377085：caches 三字段对齐真实容量量规对象形态,tests/pendingWorkDrain 夹具与 longSessionNatural SampleFrame 同步,tsc 0）
- [x] 审核发现：本轮 diff（9424245..HEAD）未见问题。

## 用户令 2026-11-06：venv 能力三段——自动发现 + 状态栏展示/选择 + 一键创建 + 优先级固化（PY-ENV 二期，feat/venv-discovery）

- [x] PY-ENV-2A [P1] venv 自动发现扫描器（与 pythonScanRules 解耦）；验收：深度封顶剪枝扫描 .venv/venv/conda，读 pyvenv.cfg/bin-python|Scripts-python.exe 验真，双平台；损坏 venv 排除。新建 src/venvDiscovery.ts：scanVenvs（递归深度优先扫描、结果按深度排序，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0432)
- [x] PY-ENV-2B [P1] 解释器状态栏展示 + QuickPick 选择写入即刻生效；验收：状态栏项显示当前解释器（venv 名/版本/来源徽标 auto-configured-PATH，缺失明说），点击选择写入 kbengine.python.interpreterPath 即刻生效。新建 src/venvInterpreterPicker.ts（交互面全依赖注入，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0433)
- [x] PY-ENV-2C [P1] 一键创建 venv；验收：列表尾「创建新 venv…」→选目录（默认 .venv）→python -m venv 进度态→完成即直接验真目标并自动选中；缺基础环境如实提示。createVenvFlow：无工作区拒绝/选放置 venv 的父目录（对话框只能选已存在目录，默认工作区根；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0434)
- [x] PY-ENV-2D [P1] 优先级固化：configured → 工作区发现 → PATH；验收：链序不回归、autoDebugpy 兼容。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0435)
- [x] PY-ENV-2E [P2] 文档与对账锁：features.md 中英 PY-ENV 二期功能条目+解释器来源条目改深扫口径+Settings 两行锁步、guide/configuration.md Python Integration 解释器链与状态栏/创建两段、guide/commands.md selectInterpreter/createVenv 小节、package.js… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0436)
- [x] PY-ENV-2F [P1] 收尾接管（2026-11-06，对照任务书逐项验收 + 补齐 + 逐逻辑入 commit + 门禁 + push）：三能力与优先级四段齐全——发现面 src/venvDiscovery.ts 与 pythonScanRules 零 import 互证、状态栏+QuickPick 写回即刻生效、一键创建、configured→工作区深扫→PATH 链序且 t… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0437)

## 审核发现 2026-11-07 · 源码文件分类与特大文件拆分审计（codex -p luna，只审不改）

- [x] SRC-000 修复批（并发会话 checkpoint 损坏 origin/main 的善后，2026-11-07）：764843d0 "chore: checkpoint local baseline" 删了 5 个期二文件（startupViewPlaceholders/indexWatcherScope/activationProfile + 测试 + perf 文档，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0438)
- [x] SRC-001 [P1] 拆分 `src/extension.ts`（6772 行）：`activate` 聚合诊断调度闭包（:627）、语言 provider 装配（:945）、热重载命令（:5155）、生成器与项目命令（:5712）、释放逻辑（:6485）。建议入口保留激活顺序+依赖装配，抽取诊断/语言服务/热重载/项目/生成命令注册模块，明确传入依赖并返回 Disposable；大量状态是 activate 闭包局部变量，不能简单剪切命令，需先梳理共享实例、注册顺序与销毁所有权。代价中高，价值高。（报告 kode-src-classification-2026-11-07-luna.md 逐项判定 2）【前置分析已落地 a359a78a：docs/design/src-001-extension-abstraction-layers.md 11 层抽象 L0..L11+src/activate/* 模块规划+glossary §2.1b 术语；11/11 层全部完成，逐层勾账见下；extension.ts 现 1596 行（wc 口径，自 6772 起 -76%）】
  - [x] L0 基础设施激活器（fb68c7a3：activate 头段 505..620——占位视图/API 目录/虚拟文档 provider/日志开关/core 门/选择器与谓词 116 行迁 src/activate/infrastructure.ts `activateInfrastructure(deps)` 返回共享实例+disposables，组合根保激活序与销毁所有权，engineApiCatalog 经 getter 保活绑定；纯移动零行为变更，extension.ts 锚点 -111 真位重探+baseline 锁步；门禁 tsc 0/eslint 0/unit 612 文件全绿（首轮 hoverDeadlineContext 15ms 墙钟抖动单跑绿复跑消失）/xvfb demo 25 RC=0；6798→6703 行）
  - [x] L1 共享核心服务激活器（7e877ee2：indexScheduler（+types.xml 冷构建后台派发接线）/entityMappingManager（deferStartup 工作区门控）/dataDictIndex（懒建单例，构造提前零副作用，「hover 前注入」约束由调用序保持）迁 src/activate/coreServices.ts `activateCoreServices(deps)` 返回三共享实例+disposables；6703→6665 行）
  - [x] L2 语言服务激活器（688b56f3：补全/签名/hover×3/definition×2/pythonClassIndex+startKbEngineIndexing 门控启动+watcher 机制/codelens×6/inlay×4/callHierarchy/references×3/documentSymbol/workspaceSymbol/implementatio… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0439)
  - [x] L3 诊断调度激活器（f91cca91：主 collection+PR1 计时助手+统一调度器+配置契约块+7 个独立调度器管线 1107 行迁 src/activate/diagnostics.ts `activateDiagnostics(deps)` 返回 28 调度句柄/集合；测试访问器随域迁移经 extension.ts 再导出保测试导入路径；flush 冲刷计时器被 didChange 外部写值留组合根（pythonIndex 三件同款），冲刷闭包原样引用返回句柄；锚点 re-file diagnostics.ts:117/130+extension.ts:531/611，census extension 3→2+diagnostics 1；门禁 tsc 0/eslint 0/unit 612 文件 7350+3skip 全绿/xvfb demo 25 RC=0；5985→4980 行）
  - [x] L4 服务器/调试层（ea35718b：serverManager 初始化+状态订阅/telnet 服务+状态灯+面板/玩家数据面板/远程服务器视图+四命令/debugpy 注入链/调试会话注册表+Debug Targets 树/server 控制四命令/调试配置与 py-spy 命令/机器人命令/状态栏共 1006 行迁 src/activate/serverControls.t… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0440)
  - [x] L5 视图层（babeaf7d：实体浏览器树+open/refresh 命令/HTTP 快捷请求服务与命令/最终配置合成+手动命令/文件历史与范围历史树视图+版本虚拟文档 provider+六命令/最终配置常驻树+kbengine*.xml 联动 watcher/快捷动作树视图与四命令共 486 行迁 src/activate/views.ts，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0441)
  - [x] L6 热重载层（96806bf2：热更状态机（台账之上派生 CLEAN/DIRTY/SENT/APPLIED/FAILED/RESTART_REQUIRED）+文件树角标+CodeLens 状态点+状态过滤+状态点点击/文件版本簿+状态栏版本号/通道快速切换/重发/批次汇总/修订证据/临时编辑热更共 567 行迁 src/activate/hotReload.ts `activat`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0442)
  - [x] L7 生成器/项目层（497d3257：Python 生态接线（extraPaths 同步/桩导出双命令/jsonc 关联关闭）/GeneratedSourceCodeLensProvider（entity 桩）/debug.json 引导与托管目录 watcher/首装扫描/代码生成器与四命令/项目导入创建/演示游戏脚手架/profile 选择与切换落索引输入/客户端 SDK 生… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0443)
  - [x] L8 监控/面板层（a580d9b1：监控面板（collector+webview）/运行时查询（profile/spaces/runtimeQuery）/异常源跳转/兼容性检查/工作台命令/BG-WARM 后台预热控制器与依赖/实体流面板/python 调用图命令共 297 行迁 src/activate/monitoring.ts `activateMonitoring(dep`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0444)
  - [x] L9 console 层（a596cf74：KB-GC-001 guiconsole 期一三面——machined 发现共享链 hub、日志实时 tail（702 注册 → 65501 长连推流进 Output）、组件状态面板（负载/存活,… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0445)
  - [x] L10 工具命令层（f64f71dc：.def 静态分析建议/跨文件语义医生/符号引用图/片段生成/发现报告/扩展身份/双激活警告/复现摘要/Python 服务状态/profile 健康检查/解释器状态栏与选择/ruff lint 与安装/发现报告提示共 597 行迁 src/activate/utilityCommands.ts `activateUtilityCommands(`… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0446)
  - [x] L11 释放逻辑（deactivate 随组合根收口）：不抽文件——activate 内 dispose 块闭合 L0/L1/L2/L4/L5/L7/L8 各层返回的 13 个共享句柄（telnetService/telnetWebView/serverManager/logHub/logCollector/logViewer/debugConfigManager/monitori… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0447)
- [x] SRC-002 [P1] 拆分 `src/entityMapping.ts`（3296 行）：`EntityMappingManager` 混合扫描与索引构建（:386）、watcher（:1023）、Python 方法索引（:1812）、签名匹配（:2008），文件尾另有独立导出解析/身份辅助函数（:2988 起）。建议先抽类型/纯解析/身份辅助函数，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0448)
- [x] SRC-003 [P1] 拆分 `src/globalDataIndex.ts`（2165 行）：键归一化（:94）、Python 词法掩码与访问扫描（:569/:705）、函数返回与类型推断（:926/:1276）、有生命周期的跨文件索引（:1483）。建议按扫描/键解析、值类型推断、索引生命周期拆分，经现有导出面过渡；索引异步分片与提交逻辑保持一致（:1410）。代价中等。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0449)
- [x] SRC-004 [P1] 拆分 `src/codeGenerator.ts`（1891 行）：`KBEngineCodeGenerator` 混合配置与路径解析、生成计划与回滚（:295/:401）、DEF 渲染（:481）、Python 渲染（:810）、多套模板（:1627）。建议先抽数据类型/模板/渲染函数，保留生成事务+用户确认+配置订阅在协调层；多数实现是类私有方法，… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0450)
- [x] SRC-005 [P1] 拆分 `src/definitionWorkspace.ts`（1837 行）：工作区布局及缓存（:173/:330）、自定义类型与别名（:430）、脚本定位（:924）、XML 解析与结构构造（:1453）。建议先拆类型注册/解析与脚本定位，保留兼容导出入口；布局缓存及缺失通知集合（:1196）是模块级共享状态，拆分时明确唯一所有者。代价中等。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0451)
- [x] SRC-006 [P1] 拆分 `crates/kode-server/src/message_table.rs`（2104 行）：JSON 输出模型（:162）、Assembly（:315）、DEF 解析（:449）、属性模拟（:1084）、方法模拟（:1668）。建议按阶段拆同 crate 子模块，不新增 crate；主要入口 register（:607），多阶段共享私有 Assembly，需谨慎设计内部可见性。（报告 逐项判定 7）已完成：bcc4ec1f；cargo test -p kode-server 304 passed / 0 failed；公开入口保留 crates/kode-server/src/message_table/mod.rs:34，Assembly 归位 crates/kode-server/src/message_table/assembly.rs:69。
- [x] SRC-007 [P1] 拆分 `crates/kode-server/src/wire_codec.rs`（1800 行）：值编解码（:333）、schema（:563）、属性流（:840）、方法参数（:977）、消息帧（:1058）；golden 样例生成（:1148 起）是优先分离对象。保留公开类型/函数重导出，注意 golden dump 实际调用方。（报告 逐项判定 7）已完成：0793db1d；cargo test -p kode-server 304 passed / 0 failed；公开入口保留 crates/kode-server/src/wire_codec/mod.rs:28，值编解码 crates/kode-server/src/wire_codec/values.rs:1，golden crates/kode-server/src/wire_codec/golden.rs:1。
- [x] SRC-008 [P1] 部分拆 `crates/kode-server/src/def_md5.rs`（1663 行）：MD5 基础（:69）、Replayer（:515）、RPC（:1359）、golden 样例（:1411）。先抽 MD5/流与 golden 支持；Replayer 状态集中，不硬拆；公开入口 compute_def_md5（:1347）保留。… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0452)
- [x] SRC-009 [P1] 拆分 `tests/globalDataIndex.test.ts`（141KB）：键解析（:43）、扫描（:67）、provider 装配（:256）、类型推断（:383）、索引生命周期（:548）各有 describe 起点，按域拆文件。（报告 逐项判定 8）（0873bcba：拆 5 文件 keyparse 4/scan 4/provider 3/typeinfer 1/lifecycle 15，27 describe 全部按标题字节一致（缺失/多余/变动=0），原文件删除；tsc 0/eslint 0/unit 616 文件 7350 过 3 skip；2026-11-08 勾）
- [x] SRC-010 [P1] 拆分 `tests/extension.test.ts`（113KB）：注册面（:190）、server（:1052）、热重载（:1549）、SDK（:1680）等功能装配混在一起，保留少量端到端装配测试，按功能域拆其余。（报告 逐项判定 8）（fd37347f：18 describe 全部按标题与 git HEAD 字节一致（缺失/变动=0），… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0453)
- [x] SRC-011 [P2] 渐进式功能域目录整理：`src/` 根目录同时放置实体映射（entityMapping.ts:198）、数据库 schema（databaseSchema.ts:395）、调试配置（debugConfig.ts:34）、多个 WebView（monitoringWebView.ts:21）等；… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0454)
- [ ] SRC-012 [P2] 处理其余大文件候选：messageTable.ts（:365 建议拆）、entityDependencyWebView.ts（:145 建议拆）、hover.ts（:72 部分拆）、databaseSchema.ts（:97 部分拆）、databaseSchemaCore.ts（:237 可选拆）、debugConfig.ts（:107 建议拆）、clientSdkGenerator.ts（:269 建议拆）、pythonClassIndex.ts（:168 部分拆）、explorerProviders.ts（:166 可选拆）、monitoringWebView.ts（:21 部分拆）、client_sdk.rs（:35 建议拆）、archive.rs（:90 可选拆）、debugConfigAttach.test.ts（建议拆）、hotReloadReceiverRoundtrip.test.ts（可选拆）。（报告 证据表）
  - messageTable.ts 拆完成（2026-11-08,53793574）：渲染半边（messageTableRender.ts）与实体装配分派半边（messageTableEntity.ts）此前已迁出；本次引擎装载模拟半边（常量表+ModuleAssembly+loadDefIntoModule/loadTypesXml/assignAliasIds 及私有模拟辅助 loadSourceDef/simulateProperty/allocatePropertyUtype/registerComponentSlot/simulateMethod/parseMethodArg/parseArrayOfType 等）迁 src/messageTableEngine.ts（1293 行），枢纽 messageTable.ts 收为 436 行（类型词汇+buildMessageTable/buildMessageTableInRust 双入口）；导入路径全不变；门禁 lint 0/tsc 0/unit 649 文件 7792 过/xvfb demo 25 RC=0；文档对账=def-pyi-stubs.md:127→:130、features.md 证据 PRIMITIVE_TYPE_UTYPES 落 messageTableEngine.ts。
  - entityDependencyWebView.ts 第 2 拆（2026-11-08,e8059bc9）：整页 HTML/CSS/内联脚本生产（renderEntityDependencyWebview+escapeHtml/statGroup/statCard 自由函数）迁 src/entityDependencyWebViewHtml.ts（611 行，纯字符串模块不触 vscode API），控制器 getWebviewContent 收为薄委托（补 mode/title/mermaidUri/cspSource/nonce 入参后调 renderEntityDependencyWebview）；静态骨架逐字节一致（11816 字节全插值位置匹配，仅 regex 转录漂移 `\"`→`"` 修正）；statCard 私→导出（KR-AUD-53 测试经 HTML 半边直调）；hub 1158→567 行；门禁 lint 0/tsc 0/unit 649 文件 7792 过 4 skip/xvfb demo 25 RC=0。
  - databaseSchema.ts 拆完成（2026-11-08,e36bffd4）：types.xml 落库形态与使用处反扫索引（批134 域：TypeStorageShape/TypeStorageUsage/getTypeStorageShape/typeShapeOf/buildTypeStorageUsageIndex+Phased/findTypeStorageUsages(+ReadOnly)/indexTypeStorageUsage(s)BySourceLine/replaceTypeStorageUsageForEntity/onTypeStorageUsageIndexPublished/cancelTypeStorageUsageColdBuild/背景派发器/分阶段冷构建/测试面共 21 导出）迁 src/databaseSchemaTypeStorage.ts（491 行），databaseSchema.ts 1622→1166 行；导入路径全不变（databaseSchema.ts 尾部 re-export 保 20 个既有消费文件的 `from './databaseSchema'` 面，无一处 import databaseSchemaCore 直取）；区域原文逐字节一致（extraction 对拍 473 行 diff=0，kept 区 diff=0 仅追加 re-export）；门禁 lint 0/tsc 0/unit 651 文件 7819 过 4 skip/xvfb demo 25 RC=0。
  - databaseSchemaCore.ts 保持原状（2026-11-08 复核）：纯推导管线无干净切缝——属性收集块（collectPersistentPropertiesForDefinition 454-1153）依赖 11 个跨区私助（readSchemaInputFile/resolveEffectiveTypeName/maybeYieldForBudget 来自别名引擎区 + mergeProperties/clonePersistentProperties/isTruePersistent/isFalsePersistent/getTypeRefName/parseOptionalNumber/normalizeOptionalString/getPropertyScopes 来自值助手区），值助手尾块（1406-1546）又用别名引擎私常量 FLAG_SCOPE_MAP(172)/SIMPLE_DB_TYPE_LABELS(187)，共享私常量 BUILTIN_DB_TYPE_NAMES/INTERFACE_SPELLINGS 横贯别名解析(353/387)与属性收集(538/1073)两区——任一候选边界都被跨区私符贯穿；拆分需导出多私助+环形导入，收益低（模块已 IDE-AUD-051 纯化：零 vscode，源访问全经 SchemaSourcePorts 注入）。按 SRC-013/014 先例结论保留，不需动作。
  - debugConfig.ts 拆完成（2026-11-08,18cec3cd）：进程/端口启动辅助（进程解析+选择器组 parsePsProcesses/parseTasklistProcesses/buildProcessPickItems/pidFromPick/makeProcessLister、远程目标 RemoteDebugTarget/readRemoteTargets/remoteTargetPathMappings、端口启动条目 DEFAULT_DEBUGPY_PORT/portLaunchEntryName/KBENGINE_LAUNCH_GENERATED_KEY/isKbengineGeneratedEntry/withGeneratedMarker/buildPortLaunchEntry/dropSupersededPortEntries/mergePortLaunchEntry、附加尝试 id nextAttachAttemptId 共 16 导出）迁 src/debugConfigLaunch.ts（281 行），debugConfig.ts 1605→1356 行；区域原文逐字节一致（extraction 对拍 282 行 diff 仅 3 处私→导出可见性：DEFAULT_DEBUGPY_PORT/withGeneratedMarker/nextAttachAttemptId 供类导入），class 留 debugConfig.ts 并 import 13 符号；导入路径全不变（debugConfig.ts 尾部 re-export 保 `from './debugConfig'` 面，remoteProcessList 的 buildProcessPickItems/parsePsProcesses/pidFromPick 不变）；新模块仅 vscode + 类型 ProcessEntry/ProcessCommandRunner 依赖（类型擦除无运行环）；门禁 lint 0/tsc 0/unit 651 文件 7819 过 4 skip/xvfb demo 25 RC=0；文档对账=features.md+zh PDBG-005 证据 src/debugConfig.ts→src/debugConfigLaunch.ts。
  - clientSdkGenerator.ts 拆完成（2026-11-08,cd91cad3）：纯生成逻辑（语言中立模型解析 readDefTypeNode/parseClientSdkEntity、类型映射 buildClientSdkTypeMap/resolveClientSdkTypeName/isClientVisibleProperty、成员冲突 findClientSdkMemberConflicts/formatClientSdkMemberConflictMessage/ClientSdkMemberConflict/ClientSdkMemberConflictError、逐语言发射 generateClientSdkEntityFile/generateClientSdkFixedDictsFile/generateClientSdkComponentsFile 共 11 导出 + 常量 CLIENT_SDK_CSHARP_NAMESPACE/listClientSdkBuiltinTypeNames/CLIENT_SDK_FIXED_DICTS_BASENAME/CLIENT_SDK_COMPONENTS_BASENAME/TS_BUILTIN_TYPES/CS_BUILTIN_TYPES/CLIENT_SDK_TYPE_FALLBACKS）迁 src/sdk-gen/clientSdkCodegen.ts（965 行），clientSdkGenerator.ts 1541→626 行；区域原文逐字节一致（extraction 对拍 moved 31808 字符 diff=0、kept 19309 字符 diff=0，仅 hub 顶部 import 面裁剪与尾部 re-export 追加）；hub 尾部 re-export 保 `from './clientSdkGenerator'` 面（generators 的 runClientSdkGenerateCommand、sdkMessageNumberAudit.test 的 listClientSdkBuiltinTypeNames、clientSdkGenerator.test 的 11 纯导出不变）；新模块仅 defParser/defAnalyzer/definitionWorkspace/defRenamer/sdkGenerationTrace + 9 类型导入自 hub（类型擦除无运行环，零 vscode/fs）；门禁 lint 0/tsc 0/unit 651 文件 7819 过 4 skip/xvfb demo 25 RC=0；文档对账=features.md+zh SDK-004 defHeader 证据、SDK-005 listClientSdkBuiltinTypeNames 证据与 clientSdk 相关模块引用落 src/clientSdkCodegen.ts。
  - pythonClassIndex.ts 保持原状（2026-11-08 复核）：无干净切缝——PythonClassIndex 类是单一内聚状态对象（20 私有字段 + ~60 方法互连，294 处 `this.` 引用），纯内容仅顶层 linearizeC3/displayPath（已在顶层导出）与 3 个纯私有方法（classKey 3 行、compatibleContext 10 行、importModuleCandidates 28 行，共 ~42 行）；组合根派生（ensureCompositionRoots 657-826，~206 行）与 self-method 解析（resolveSelfMethodResolution 1338-1527，~190 行）各依赖 10+ 私有成员（rootsMap/rootsByScope/rootsContentCache/dependencyGraph/lookupClass/mroClasses/compatibleContext/resolveSymbol/fileOrder 等），自由函数无法访问类私有成员，拆出需重构状态所有权而非字节级提取，收益低（纯面 ~165 行 ≈ 11%，类主体 1363 行不动）。按 SRC-013/014 先例结论保留，不需动作。
  - explorerProviders.ts 拆完成（2026-11-08,054b7e60）：数据模型层（11 类型 EntityTreeNode/DefinitionStats/DefinitionMethodStats/DefinitionLeafDescriptor/DefinitionGroupDescriptor/DefinitionSectionDescriptor/DefinitionSummaryDescriptor/DefinitionViewModel/DatabaseSectionModel/InheritedDefinitionGroup/DefinitionHierarchyStats + 5 item 类 ExplorerGroupItem/DefinitionTreeItem/DefinitionSectionItem/DefinitionGroupItem/DefinitionLeafItem + 纯辅助 toMethodStats/toStatsFromProperties/flattenProperties/getGroupIcon/getDefinitionIcon/createOpenDefinitionCommand + 导出 parseDefinitionStructure）迁 src/explorerProvidersModel.ts（261 行），explorerProviders.ts 1282→1065 行；区域原文逐字节一致（extraction 对拍 moved 全等、kept 全等，仅 hub 顶部 import 面裁剪与尾部 re-export 追加）；hub 尾部 re-export 保 `from './explorerProviders'` 面（serverControls/views 的 EntityExplorerProvider/ServerControlProvider/pickServerComponent、explorerProviders.test 的 parseDefinitionStructure 不变，item 类经 getChildren 构造由测试结构访问）；新模块仅 vscode/definitionSemantics/definitionWorkspace/entityMapping 依赖（类型擦除无运行环）；门禁 lint 0/tsc 0/unit 651 文件 7819 过 4 skip/xvfb demo 25 RC=0；文档对账=features.md+zh 文件级引用不变（实体浏览器/服务器状态均留 hub）。
  - monitoringWebView.ts 拆完成（2026-11-08,6a470d44）：HTML 渲染半边（getHtml→renderMonitoringWebview 742 行 + 私有辅助 escapeHtml/formatMetricCard/formatDiagnostic）迁 src/monitoringWebViewHtml.ts（911 行，纯字符串模块零 vscode API：vscode 依赖项由控制器预计算传入——cspSource/chartAssetUri/statusSummary/isPaused/refreshInterval/historySeries 全作 options 字段），monitoringWebView.ts 1234→414 行；hub 收为类状态/生命周期/数据管线（applyMetricFilter/applyDiagnosticFilter/buildOverview/buildHistorySeries 留 hub）+ getHtml/escapeHtml/formatMetricCard/formatDiagnostic 4 个薄委托（测试经 internals() 调实例方法面不变）；渲染逻辑参数化（this.componentFilter/diagnosticFilter/keywordFilter/historyWindow/collector 派生值→options 字段，行为等价，Redesign 测试 HTML 断言面验证）；门禁 lint 0/tsc 0/unit 651 文件 7819 过 4 skip/xvfb demo 25 RC=0；文档对账=features.md+zh 文件级引用不变（监控面板 src/monitoringWebView.ts hub 仍在），external-deep-audit 2026-11-04 历史审计记录按先例保留原状。
  - archive.rs 拆完成（2026-11-08,e69a3c8f）：容器格式原语层（7 常量 MAGIC/FORMAT_VERSION/FLAG_ENCRYPTED/HEADER_LEN/MAX_ARCHIVE_SIZE/AEAD_TAG_LEN/FORMAT_NAME + 大小上限检查 enforce_size_cap + 帧序列读取 read_frames/read_u32_or_eof + 帧 AEAD 加解密 aead_seal/aead_open + 头部加密位探测 is_encrypted 共 13 项）迁 crates/kode-db-clone/src/archive/format.rs（201 行，archive.rs 子模块 `mod format;`+`use format::`/`pub use format::` 落提取原位照 client_sdk/mod.rs 样板），archive.rs 1479→1300 行；区域原文逐字节一致（对拍 moved diff=0，仅 11 处私有→pub(super) 可见性 + is_encrypted 文档内链 [`Archive::open`]→`Archive::open` 防断链 2 类机械调整）；公开路径全不变（`archive::is_encrypted`/`archive::MAX_ARCHIVE_SIZE` 经 pub use 保路径,lib.rs crate 根 `kode_db_clone::is_encrypted` 转发零改动,kode-server db_clone.rs:23 消费不受影响;ArchiveMeta/TableMeta/ArchiveWriter/Archive/write_archive/relations_from_plan 留 hub）;内联测试 757 行保持原状（仓内全部 crate 均为 inline `mod tests` 惯例,无外置测试模块先例,不引入新模式）;hub 顶部 chacha20poly1305 导入随迁出裁剪;门禁 fmt 0/clippy -D warnings 0/cargo test 131+21 过 0 败;文档对账=player-clone/db-clone-overview.md en+zh 行号级引用 7 处（:36→format.rs:19、:292→:265、:345→:318、:364→:337、:406→:379、:697→:518 ×2）+模块表补 archive/format.rs,`:3-7` 模块文档行引用不变。
  - debugConfigAttach.test.ts 拆完成（2026-11-08,edbbcfd5）：1850 行按段域三分——core（startDebugging/attachToComponent/write-failure/attachRemote+readRemoteTargets 4 describe,468 行）留 tests/debugConfigAttach.test.ts,DBG-007+IDE-PDBG-001 迁 tests/debugConfigAttachModes.test.ts（570 行）,IDE-PDBG-002/004/002b 迁 tests/debugConfigAttachConnect.test.ts（678 行）;共享装具迁 tests/helpers/debugConfigAttachHarness.ts（229 行,非收集路径不在 vitest include;registerAttachTestHooks 封装 beforeAll/afterAll/beforeEach,9 处 debugResult/debugThrows 赋值改 setter——ES import 绑定只读）;测试体逐段原文一致（对拍 3 文件 body diff=0,仅 import 块重排）;坑=vitest/esbuild 下 vscodeStub `export *` 环回导入子集名会留 workspace 未绑定（import '../src/debugConfig' 先把 'vscode' 别名到桩触发循环绑定失败）,全量名单或经 harness 转发不触雷——测试文件互相禁导入（模块体执行=describe 重复注册）,共享装具必须放非收集模块;门禁 eslint 0/tsc 0/本批 3 文件 64/64 绿/xvfb demo 25 RC=0,全量 unit 在 load~173（并发会话 Rust/C++ 构建打满）下旋转失败集 10/12/5 例（typeStorageColdBuildPhased/ps-spawn/budget 族负载抖动,--maxWorkers=2 降竞争,与本批文件零导入交集,逐一隔离复跑绿——KODE-PERF-004/005 同款环境抖动记录）;文档对账=features.md en+zh 3 处 evidence 段位（IDE-PDBG-001→Modes 文件、002/002b+004→Connect 文件）。
  - 已拆子项 1 messageTable.ts：fbe2da70（renderMessageTableMarkdown/renderMessageTableJson/renderArgSignature/renderArg/renderCellAliasId 迁 src/messageTableRender.ts 216 行，messageTable.ts 1897→1690，区域原文零改动+re-export 保既有导入路径；门禁 tsc 0 / eslint 0 / vitest 621 文件 7350 过 3 skip）。
  - 已拆子项 2 entityDependencyWebView.ts：175c4825（sanitizeRustId/clickLine 与依赖图渲染迁 src/entityDependencyGraphView.ts 317 行、调用图迁 src/entityCallGraphView.ts 275 行，主文件 1704→1140；cross-region refs sanitizeRustId/clickLine 私→导出+跨模块导入，re-export 保测试路径；门禁 tsc 0 / eslint 0 / vitest 621 文件 7350 过 3 skip）。
  - 已拆子项 3 client_sdk.rs：22128585（类型表/TS-CS 发射区域 556..1394 迁 crates/kode-server/src/client_sdk/gen.rs，主文件转 client_sdk/mod.rs（register+内建表+structs+parse+parse_params+generate_handler+tests）；区域原文零改动，唯一可见性调整=generate 私→pub(super)+GeneratedFile 字段 pub(super)（父模块尾 2 访问点），gen.rs 补 use std::collections::{HashMap,HashSet}+kode_parser::{diag::LineMap,xml}；cargo test -p kode-server 304 passed / 0 failed + golden 重生成逐字节一致 + clippy 0 警告）。
- [x] SRC-013 [P2] `src/generated/apiDocs.ts`（3066 行）保持生成物定位：由 scripts/generate-api-docs.mjs:7 从 docs/knowledge/api-*.md 抽取，与 crates/kode-server/assets/api-docs.json 同源，parity 测试校验（tests/apiDocsParity.test.ts:35）。不因 3066 行手工拆分，通过生成脚本维护；需核对当前产物与来源同步。（2026-11-08 验证：apiDocsParity 4/4 绿，当前产物与来源同步，维持生成物定位不手工拆，结论成立）
- [x] SRC-014 [P2] Rust 16 crate 边界合理，无证据支持合并（Cargo.toml:11、kode-index/Cargo.toml:12、kode-kbengine/Cargo.toml:23）——分类结论保留，不需动作。（2026-11-08 复核：crate 边界与依赖方向合理（kode-server 聚合、kode-index/kode-kbengine 职责分明），无合并证据，结论保留不需动作）

## kode Redis 界面（2026-11-08 用户问「redis 的界面实现了吗」）

- [x] KODE-REDIS-UI-001 [P1] Redis 后端界面：现 `DatabaseBackend = 'mysql' | 'redis'` 仅类型（databaseSchemaCore.ts:65），唯一实例化硬编码 `backend: 'mysql'`（databaseSchema.ts:358），… [完整记录](docs/review/2026-11-08-todo-completed-history.md#done-0455)
  - [x] 连接注册 + 键空间模型 + 只读 RESP2 客户端 + 预览命令 + 面板标注：81c4adf7（10 文件；redisDrift/redisKeySpace/redisKeyspaceCommand + registry/panel/serverControls 接线；31 新测试绿 + playerDataPanel 7/7；tsc 除并发 hover.ts 7 错全净；门禁三件套绿；无 redis 时 graceful 空态）

## 数据库管理展示面板（2026-11-08 用户「我认为还是明确的展示面板」）

- [x] DB-MGMT-001 [P1] 明确展示面板：独立 WebView 把 MySQL/Redis 管理做成常驻可见界面（此前分散在命令/输出通道/虚拟文档，用户「关键管理 MySQL 和 redis 的都看不到」）。完成 2026-11-08 commit 9f26845c：`kbengine.database.showManagement` 打开只读面板，活动标签跟随派生档案（mysql/redis/none）；MySQL 列 SHOW TABLES + 网格预览单表，Redis 枚举 kbe_* 键 + HGETALL 哈希预览；全程只读（drift 执行器语句白名单 + RESP2 SCAN/HGETALL 只），open-per-operation 连接 10s 超时，切 tab/dispose 代际守卫弃置在途结果，单点密码不可读门禁，整页 nonce CSP + textContent 纯动态渲染（KR-AUD-50/53）；SRC-012 拆半（控制器 databaseManagementWebView.ts + 纯字符串 HTML 半边 databaseManagementWebViewHtml.ts）；测试 27 例（HTML 转义/CSP 12 + 控制器生命周期/分发/错误面/代际守卫/超时 15）绿；门禁 lint 0 / tsc 0 / unit 7819 过 4 skip / xvfb demo 25 RC=0；文档对账=commands.md en+zh 命令节 + features.md en+zh DB-007 条目 + nls 双语。SRC-012 拆分候选（messageTable/databaseSchema/debugConfig 等）仍在 1455 行挂账待续。

## 深度源码审查待办（2026-11-08，克隆实际执行链与 MCP 检索）

> 审查基准：c82c9a83 附近的工作区；以下是源码链路分析，尚未用真实 MySQL/KBEngine 端到端验证。克隆功能须分别验收 Rust 库、RPC、VS Code 实际入口及真实环境，不能以库单测代替接线验收。

- [x] KODE-REVIEW-001 [P0] 克隆导入提交状态与错误提示：`src/playerDataCloneMysql.ts` 在 COMMIT 后复核，`src/playerDataCloneCommands.ts` 在提交后写审计，异常却统一提示“已回滚”，可能诱发重复导入。验收：区分提交前失败、COMMIT 结果不确定、已提交但复核/审计失败；提示包含可核对的 run/目标信息，不声称未证实的回滚；覆盖 COMMIT 断连、提交后查询失败和审计写入失败。（b6ce1621 区分提交结果不确定/提交后验证失败/回滚失败；tests/playerDataCloneImportCommand.test.ts 覆盖 COMMIT 断连、提交后失败与审计失败，连接关闭错误不掩盖原状态。）
- [x] KODE-REVIEW-002 [P0] 克隆 64 位整数无损往返：`src/playerDataCloneWire.ts` 使用 Number 转换整数，超安全整数的读取会落为文本；MySQL 连接与 insertId 也需端到端对齐。验收：有符号/无符号 64 位边界及超过 2^53 的 ID、普通列经真实 MySQL → RPC/归档 → MySQL 精确往返，禁止静默舍入或类型误判。（9b83ddd5：JS 安全范围外整数走十进制字符串、Rust 兼读旧数字归档、自增主键/父子引用保精度；tests/playerDataCloneMysqlReal.test.ts 真实 MySQL 8→Rust RPC 计划/归档→Rust 导入计划→TS mysql2 写入目标库，覆盖 i64 最小/最大、u64 最大及 >2^53 自增 ID。）
- [x] KODE-REVIEW-003 [P0] 克隆二进制无损往返：`src/playerDataCloneWire.ts` 将二进制编码为十六进制，但 `typedValueToBind` 把 bytes 当普通字符串绑定。验收：导入时还原为实际字节，覆盖空值、零字节、非 UTF-8 与多种 BLOB/BINARY，真实 MySQL 字节级对比。（aad41b48：严格十六进制解码为 Buffer；tests/playerDataCloneMysqlReal.test.ts 经真实 MySQL 8→Rust RPC 归档→目标库对比 BLOB/BINARY/VARBINARY 的空值、空字节、非 UTF-8 数据。）
- [x] KODE-REVIEW-004 [P1] VS Code 导出接入一致性快照：Rust `crates/kode-db-clone/src/reader.rs` 有快照事务，实际 `src/playerDataCloneMysql.ts` 的 `executeExportPlan` 只设置只读会话并逐表查询。验收：同一事务快照读取根表和全部子表，异常/取消释放事务；真实 MySQL 并发修改测试证明不混合不同时间的数据，明确数据库能力不支持时的处理。（b6ce1621：只读一致性事务、取消/错误回滚及行数约束；tests/playerDataCloneMysqlReal.test.ts 在隔离 MySQL 8 容器中于读取主表后并发修改子表，验证仍读取旧快照；不支持事务命令时报错终止，不降级伪装成功。）
- [x] KODE-REVIEW-005 [P1] VS Code 导出强制资源预算：预览显示 `row_budget`，但 `executeExportPlan` 累积所有行且无运行时行数、字节和时间限制；计划期估计不能代替执行期约束。验收：真实读取链执行行/字节/时间预算，超限失败且不生成声称完整的归档；有界或流式读取，覆盖大结果、单查询和取消边界。（TS 实际查询改 mysql2 背压流，默认 64 MiB 编码行预算/120 秒及计划行数上限；超限、停滞超时或取消主动关闭只读连接，拒绝写归档；单测覆盖行/字节超限、停滞超时和取消，隔离 MySQL 8 验证真实流及字节超限。单个数据库行仍需由驱动先接收后才能计算其编码体积。）
- [x] KODE-REVIEW-006 [P1] 将重复导入保护接入 VS Code 实际写入路径：Rust `ImportApplier` 的归档指纹与 `allow_duplicate` 未用于 TS `applyImportPlan`。验收：目标及归档身份持久化登记，同归档默认拒绝重复导入并展示已有记录，明确选择另建副本才允许；覆盖重启、提交结果不确定与审计失败恢复。（8e801750：本机持久化归档 SHA-256+目标原子预留，写入前落盘，重复操作须明确选另建副本；tests/playerDataCloneImportGuard.test.ts 与 tests/playerDataCloneImportCommand.test.ts 覆盖并发/重入、重复确认、未知提交及审计失败。范围为同机相同连接标识；跨机器或同库不同主机别名需独立协调，预留失败或崩溃后保守保留。）
- [x] KODE-REVIEW-007 [P1] MCP 文档/Python 搜索扫描边界：`docs_index.rs`、`code_index.rs` 目录遍历跟随符号链接且无目录去重，文件上限在目录循环外检查，命中上限也未提示不完整；每次调用同步扫描/读取或解析。验收：符号链接环、重复路径、大目录均可终止且严格执行预算；结果明确标识截断和读取失败，覆盖低限额与无命中；评估并消除请求线程上的大规模同步阻塞。（4c225049：共享扫描上限/去重/禁跟随子符号链接、搜索状态字段；9a5e8e1a：两个搜索移至 blocking 线程；新增缺失目录状态测试；cargo test -p kode-mcp 绿。独立语义模型调用的完整性反馈及取消仍需另行核查。）
- [x] KODE-REVIEW-008 [P2] 清理待办与完成证据口径：`todo.md` 声称只放未完成任务，却长期保留大量完成记录；克隆 Rust 库完成与用户入口能力混在一起。验收：保留可追溯历史，明确库、RPC、实际入口和真实环境四层验收状态；将已完成长篇证据迁至适当历史文档或索引，不丢失原始证据。（完成长行原文逐条存档至 docs/review/2026-11-08-todo-completed-history.md，账本原位置保留完成状态、摘要与逐条链接；未完成项保持原文，四层验收状态由迁移矩阵及 KODE-REVIEW 项跟踪。）

## TypeScript 到 Rust 实际迁移核查（2026-11-08 用户要求）

- [x] RUST-MIGRATION-AUDIT-001 [P1] 按用户可见功能建立完整迁移矩阵：逐项核对 TS 入口、Rust 实现、RPC 注册、默认执行路径、失败/回退、测试及真实环境验收；区分未迁移、仅 shadow、Rust 优先/TS 回退、Rust 唯一实现和未核实。先核语言服务与 Python 索引，再核其余命令、诊断和后台能力；不得因 crate 存在或单元测试通过就勾完成。第一批静态证据见 `docs/review/2026-11-08-ts-rust-migration-verification.md`。（完成 2026-11-08 commit 11b680a5：矩阵第五批补全 133 命令/27 provider/13 诊断集/后台/22 RPC 全量账，101 未迁移/11 Rust 唯一/9 Rust 优先+TS 回退/3 仅 shadow/5 死 RPC，serveFromRust 恒 false 与 servingMode 仅 ts|shadow 已直读代码核实；结论明确矩阵证接线不证行为对等，不足作切流依据）
- [ ] RUST-MIGRATION-AUDIT-002 [P1] 按矩阵逐项补齐迁移与接线：以原功能、非保存缓冲区、取消、失败降级和版本正确性为验收，先对拍后切换，禁止静默丢能力；每完成一项立即单独提交并推送。玩家克隆数据执行与完整 64 位链路沿 KODE-REVIEW-001..006 专项跟踪。
  - apiDocs/lookup 行证据批（2026-11-08，b8e6b2b9）：tests/apiDocsRustParity.test.ts 全语料成员 × 域面 × en/zh-cn 对拍一致（hit 字段级/ambiguous 三元组序列/miss 三态）+ 热进程时延实测 p50=1.28ms max=1.79ms + 断连面锁定（现产 hover 链纯内存零 RPC 依赖）；**判定不切**——语料双实现已由生成器 --check 门禁锁零漂移，切换不消灭回退面实现，hover 热路径换 RPC 无净收益；RPC 与 MCP explain 保持同源同语义；附带修复 api_docs.rs `source_refs` 缺 serde rename「sourceRefs」致 RPC/库输出 sourceRefs 恒空（对拍测试捕获）。矩阵 E 表行/未核实 #1/hover 行同步复核（serveFromRust 已随 04a3fada 生效,旧「恒 false」判词作废）。
- [x] RUST-MIGRATION-AUDIT-003 [P1] DEF 引擎复合 MD5 用户入口核查与接线：`src/defMd5Rust.ts` 的 `computeDefMd5InRust` 与 `src/hotReloadDefHash.ts` 的 `negotiateEngineDigest` 当前仅见函数定义及测试调用，未见生产消费链；明确功能入口、真实配置/实体闭包与未保存缓冲区输入、引擎回执来源，接通后用真实 RPC 和故障降级测试，无法获取引擎摘要时保留 unknown，不以 Rust 函数存在勾账。证据见 `docs/review/2026-11-08-ts-rust-migration-verification.md` 第二批。（2026-11-08 接线完成 97c5b112：命令 `kbengine.def.checkEngineMd5`（infrastructure.ts 装配）——golden 收集器同布局收集工作区 def 闭包（entity_defs 三处分型 + xml 三件 + base:X/cell:X 组件脚本存在性；def 原文经 readSharedFileSnapshot 打开缓冲区优先=未保存编辑参与摘要；缺失喂入文件空串入流同引擎装载口径并记备注），经 `$/kode/def/md5` 真 RPC 计算引擎格式 MD5，与 kbcmd SDK 盖章逐一对拍（kbcmd client_sdk.cpp:323 `@{KBE_SERVER_ENTITYDEF_MD5}` → kbengine.js:3052 / KBEngine.cs:95；与登录握手 onHelloCB baseapp.cpp:4910 下发同一值；Unity 失配中止握手 KBEngine.cs:434-439，js 仅记日志）；Rust 不可用=工作区摘要保持 unknown、盖章逐个「无法比对」不猜不用客户端哈希顶替；SDK 扫描每 glob 有界 50 文件超限记备注；报告落共享「KBEngine Def 分析」通道+汇总通知；测试 tests/defMd5Check.test.ts 20 项（收集 6/盖章扫描 3/对拍三态 4/渲染 2/接线 4/二进制在场真 RPC round-trip 1——属性结构变摘要必变）全绿；门禁 eslint 0/tsc 0/unit 7784 过 4 skip（globalDataIndex noteSaved 预算例 226ms>200ms 负载抖动，隔离复跑 61/61 绿，load 38-58/14 核）/xvfb demo 25 RC=0（裸 shell 无 DISPLAY 两次 SIGTRAP=xvfb-run 口径复现绿）；features en+zh/commands en+zh/nls 双语对账）

## 2026-11-08 克隆跨版本验证

- [x] KODE-REVIEW-MYSQL57 [P1] 隔离 MySQL 5.7 容器运行 `tests/playerDataCloneMysqlReal.test.ts`，使用实际 kode-server RPC 执行 MySQL→计划/归档→导入计划→目标 MySQL 事务往返，验证一致性快照、i64/u64 边界、大于 2^53 的主键、BLOB/BINARY/VARBINARY、空值和字节预算；1/1 通过。与 MySQL 8 实测覆盖相同路径。
- [x] RUST-MIGRATION-DISCOVERY-001 [P1] 工作区发现命令的锚点扫描接入 Rust：`$/kode/workspace/scanAnchors` 复用 kode-root 默认有界扫描，`runWorkspaceDiscovery` 优先异步预热 Rust 结果并保留 TS 错误/形状回退；重置后的旧 RPC 结果不得覆盖缓存。`tests/workspaceDiscoveryRust.test.ts` 覆盖真实 kode-server RPC、故障回退和失效竞态，`tests/kodeRootParity.test.ts` 保持对拍；同步激活预热和其他布局调用仍为 TS，后续迁移不虚报。

## NIGHTLY-PLATFORM · 多平台与纯 TS 每日交付（2026-11-08）

- [x] NIGHTLY-PLATFORM-001 六个原生平台（Windows/macOS/Linux × x64/ARM64）与纯 TS 通用包独立构建和验证，完整回归与七包全通过后统一发布 nightly；最终 ZIP 核对平台/构建身份/资产/权限/哈希，并执行解包后二进制真实 LSP 跳转与 CLI schema 验证。运行 [42463793704](https://github.com/cuihairu/kode/actions/runs/42463793704) 全成功，源码 `024a8149`，七包和 SHA256SUMS 已发布。过程修复 Windows 盘符 URI 解析、平台测试假设、musl 链接、worker/语言配置漏包及协议命令激活声明；定义跳转重复执行 TS 已由 `ecefd308` 修复。完整证据见 [多平台交付记录](docs/review/2026-11-08-nightly-platform-packaging.md)。

## UX-REVIEW · 易用性复审与实施计划（2026-11-08）

来源：[Kode 易用性审查](docs/review/2026-11-08-kode-usability-review.md)。目标：让用户从打开项目到完成任务知道当前状态、下一步和失败后的恢复方式。范围包括侧栏、工作台、快速执行、玩家数据、监控面板与真实安装包；保留现有命令、快捷键和高级入口。

执行规则：每个独立子项完成后立即验证、单独提交并推送；父项只有其所有子项及对应验收完成才勾选。TS 通用包与 Rust 平台包均覆盖；无 Rust 后端时明确展示功能不可用和实际恢复方式，不能假报成功。区分源码/自动化证据与实际 VS Code 人工走查，未实测的平台标为未验证。文案跟随现有中英文机制；不将密码、执行器、RPC 等实现细节塞进一般用户流程。

边界：玩家查询保持只读；克隆导入继续限制 local/test，保留导入预演、写入确认、事务、重复导入保护与结果不确定时不得直接重试的提示。任何取消或返回均不能产生意外写入；不能因简化界面删掉已有功能。

### UX-REVIEW-001 [P0] 克隆密码遮挡

- [x] UX-REVIEW-001a 扩展克隆命令输入选项并将源库、目标库的密码输入设为遮挡；验收：实际 VS Code `showInputBox` 收到 `password: true`，其他字段不被误设为密码。
- [x] UX-REVIEW-001b 验证两种角色在输入、留空与取消时的保存语义；密码仅进入 SecretStorage，不进入配置、摘要、通知与日志。覆盖 tests/playerClonePasswordInput.test.ts 与 tests/playerDataClone.test.ts（27 项通过）；tsc 与 eslint 通过。

### UX-REVIEW-002 [P1] 首次使用入口与项目状态

- [x] UX-REVIEW-002a 梳理现有项目导入/创建、工作区发现、诊断与实体入口：明确可复用命令及无工作区、多工作区、外部资源根的真实行为；不得臆造识别成功。
- [x] UX-REVIEW-002a-1 发现诊断命令读取调用时的首个工作区；工作区切换后，激活期旧扫描不能覆盖报告。已覆盖切换与关闭工作区；多根选择仍待后续实现。
- [x] UX-REVIEW-002b 定义并接入可观察状态：未打开工作区、识别中、未找到/失败、已识别；区分扫描进行中、无匹配和读取失败，不以空列表冒充就绪。（2026-11-08,53e7c94c:src/startEntry.ts 状态机——no-workspace/scanning/not-found/failed/ready 五态 + 陈旧根守卫（已切换根的扫描结论弃置,视图过渡期渲染识别中,不拿旧根结论顶替）+ 同根在途重入去重；ready 判据=entity_defs 根唯一发现命中且真实在盘,空列表不冒充就绪,not-found 如实列缺失锚点、failed 保留原始错误,根级读取失败(权限/被删)落 failed 不与无匹配混谈(深扫描对不可读目录静默跳过,结论面把「读不到」与「真没有」分开);激活期识别失败不再无声(unhandled rejection→failed 态);无 workspaceState 宿主保持旧口径整段跳过(不询问/不落报告/不多弹警告,extension 测试替身形态核实);tests/startEntry.test.ts 16 项绿）
- [x] UX-REVIEW-002c 建立侧栏「开始」任务入口，按状态提供打开项目、检查设置/诊断、查看实体等真实可执行操作；失败路径允许重试，保留原有侧栏和命令。（2026-11-08,53e7c94c:package.json 新视图 `kbengine.start` 置顶 kbengine-explorer + `kbengine.start.retryDiscovery` 命令；条目全指既有真实命令——无工作区→打开文件夹(openFolder)、扫描中→纯说明无假按钮、未找到/失败→发现报告+重试、就绪→查看实体(entity.open)/检查报告/启动调试(debug.start)；原 11 个侧栏视图与命令一概保留；placeholders 首位注册+provider 状态订阅刷新+dispose 合并拆除；nls 双语 + l10n bundle en/zh 各 +19 键键集全等；门禁 lint 0/tsc 0/startEntry+placeholders+discovery+quickActionTree+i18n 契约 44 项绿/extension.test 全激活 21/22（余 1 例=并发会话 quickActions 本地化 stale 断言,HEAD 既存,证据='未配置快速执行动作'字符串已不在 src））
- [x] UX-REVIEW-002d 验收冷启动、打开/切换/关闭工作区、识别失败恢复、重试与多根工作区；后台旧扫描结果不能覆盖新工作区状态。真实安装包走查由 UX-REVIEW-009 记录。（2026-11-08,9caa1694:自动化验收 7 例入 tests/startEntry.test.ts——冷启动→打开→就绪全链/关闭目录回落 no-workspace 不残留旧根结论/切换 A→B 过渡期视图渲染识别中不拿 A 结论顶替+落位后 Provider 复渲染/识别失败→补齐布局→同一控制器重试恢复 ready/failed 态重试条目真实指向 retryDiscovery 命令/多根=主根 folders[0] 且次根不被识别/根切换后旧扫描无论成败(含迟到失败)都不污染新根就绪态;真实安装包走查半边如实留 UX-REVIEW-009）

### UX-REVIEW-003 [P1] 快速执行空状态

- [x] UX-REVIEW-003a 将「扫描脚本」与「配置 HTTP 请求」拆成清楚标明行为的独立入口，实际点击分别触发扫描和可编辑的配置位置；无工作区时说明如何打开项目。
- [ ] UX-REVIEW-003b 无脚本、取消选择、扫描失败和已有手工动作时给出准确结果及后续操作；扫描不得覆盖既有手工动作或 HTTP 配置。
- [ ] UX-REVIEW-003c 覆盖树视图空态到真实命令的接线、配置来源、重复执行与多工作区；中英文文案和实际行为一致。

### UX-REVIEW-004 [P1] 玩家数据按任务进入

- [ ] UX-REVIEW-004a 提供「只读查询 / 导出玩家 / 导入到本地或测试库」清晰入口和简短说明；明确数据来自已持久化数据库，不代表在线状态。
- [ ] UX-REVIEW-004b 导出前先检查源连接、可用后端和实体上下文；缺配置时提供配置与测试连接入口，完成后能继续任务或清楚说明如何重试，不先丢失已输入的实体/DBID。
- [x] UX-REVIEW-004b-1 导出在选择实体与输入 DBID 前检查源连接；缺失时可直接进入配置，保存后继续选择，取消不收集后续信息。已覆盖现有导出及新入口（80 项测试通过）；Rust 后端预检和连接测试仍属父项。
- [ ] UX-REVIEW-004c 导入前先检查目标连接及后端；保持目标环境限制、预演、两次写入确认与重复导入保护；取消和失败不误称成功。
- [ ] UX-REVIEW-004d 只读查询缺配置时提供项目配置定位和连接检查入口；不会将克隆源/目标设置当成只读查询的引擎配置。
- [ ] UX-REVIEW-004e 验证纯 TS 无 Rust 后端、缺连接、连接失败、无实体、取消、预演与执行结果；对线上只读和本地/测试写入边界做回归。

### UX-REVIEW-005 [P1] 克隆连接配置体验

- [ ] UX-REVIEW-005a 基于现有配置与 SecretStorage 设计可前进、返回及取消的分步输入；展示步骤和角色，保留已输入的非密码信息但不在摘要回显密码。
- [x] UX-REVIEW-005b 主机、用户名、数据库及端口按实际连接要求校验；端口仅接受 1–65535，空值使用 3306；目标环境仅 local/test。输入错误在当前步骤可修正。
- [ ] UX-REVIEW-005c 提供不含密码的配置摘要与可选连接测试，明确测试失败原因与保存状态；取消不得写入半成品，成功保存后可再次修改。
- [ ] UX-REVIEW-005d 验证源/目标、密码遮挡、保留/清除密码的明确语义、返回修改、取消、测试失败及密钥存储失败；不得输出明文密码。依赖 UX-REVIEW-001。

### UX-REVIEW-006 [P1] 工作台按任务组织

- [x] UX-REVIEW-006a 盘点工作台现有 12 个动作及已有侧栏/命令入口，按项目、运行调试、数据和分析等用户任务分组；常用入口说明用途和前置条件。
- [x] UX-REVIEW-006b 接入现有国际化机制：中文界面显示中文名称与说明，英文界面显示英文；保留可搜索的专业术语与原有命令 ID/快捷键。
- [ ] UX-REVIEW-006c 验证分组选择、取消、命令异常和原有动作逐项可达；不以隐藏高级功能或新增无法执行的按钮充数。

### UX-REVIEW-007 [P2] 监控控件可理解且可访问

- [x] UX-REVIEW-007a 为组件、诊断、关键词、刷新间隔和历史窗口提供可见标签与程序化名称；按钮状态能被辅助技术理解，中英文文案完整。
- [ ] UX-REVIEW-007b 调整工具栏在窄面板下的换行和分组，保留筛选值、刷新、暂停/恢复和导出行为；主题颜色与对比度遵循 VS Code。
- [ ] UX-REVIEW-007c 验证键盘顺序、焦点可见、名称和状态；在真实 VS Code 用屏幕阅读器与窄面板走查，未能执行的环境如实记录。

### UX-REVIEW-008 [P2] 状态与恢复集中展示

- [ ] UX-REVIEW-008a 为玩家查询与连接检查保留可回看的最近一次状态、结果时间和结果入口；结果区分未运行、进行中、空结果、成功、失败与已取消。
- [ ] UX-REVIEW-008b 为缺配置、连接失败和后端不可用提供与真实原因对应的配置、重试或查看详情操作；原始错误用于诊断但不暴露密码。
- [ ] UX-REVIEW-008c 验证刷新/工作区切换时状态归属，过期异步结果不覆盖新任务；成功与空结果不混淆，不确定的导入结果不提供直接重试。与 UX-REVIEW-004 衔接。

### UX-REVIEW-009 [P1] 真实安装包走查与验收

- [ ] UX-REVIEW-009a 准备空工作区、有效 KBEngine 项目、缺配置及后端不可用四种可重复场景；记录版本、系统、包类型、项目规模与准备步骤。
- [ ] UX-REVIEW-009b 从安装包执行首次识别、实体浏览、服务器入口、快速执行、只读查询、克隆前置检查与失败恢复，记录操作步骤、实际结果和困惑点；不得以源码/模拟测试替代。
- [ ] UX-REVIEW-009c 覆盖纯 TS 通用包与 TS+Rust 平台包；在 Windows/macOS/Linux 有条件的实际桌面分别走查并记录，未执行的系统和无障碍场景明确标记未验证。
- [ ] UX-REVIEW-009d 汇总走查问题与修复前后证据，确认未降低只读/写入边界和已有入口可达性；尚未满足的验收保留开放，不能批量勾完成。

### UX-REVIEW-010 [P1] 界面国际化一致性（2026-11-08 用户反馈）

- [x] UX-REVIEW-010a 本轮新增的克隆源库配置入口、连接配置提示与输入校验接入现有 `vscode.l10n` 双语机制；纯命令编排通过注入翻译函数保留非 VS Code 可测试性，选择结果使用同一翻译值判断。覆盖中英文操作和验证。
- [x] UX-REVIEW-010b 盘点当前首次使用、工作台、快速执行、玩家数据/克隆、监控的硬编码文案，列出实际入口、语言覆盖与现有翻译机制；将专业术语与用户文案分开，不能仅搜索中文就声称覆盖完整。
- [ ] UX-REVIEW-010c 将快速执行的扫描、空结果、取消、错误与恢复提示接入现有国际化机制；英文界面不出现硬编码中文，中文界面不暴露无说明的英文按钮；保留原始错误的诊断价值。
- [x] UX-REVIEW-010c-1 快速执行脚本扫描的工作区提示、选择界面、空结果与保存结果接入中英文翻译，保留手工动作数量和配置路径。
- [x] UX-REVIEW-010c-2 快速动作列表的空状态、无效配置数量、选择提示及最近动作预览接入中英文翻译。
- [ ] UX-REVIEW-010d 将玩家数据和克隆的查询、导出、导入、预演、确认、结果不确定及恢复提示逐条国际化；英文和中文均保留真实写入、只读及不能盲目重试的语义，比较选项不得依赖固定语言文字。
- [ ] UX-REVIEW-010e 随首次使用入口与工作台改造同步接入双语，确保设置标题、空态、按钮、辅助功能名称、成功及失败状态均使用同一语言；保留用户实际输入与文件名。
- [ ] UX-REVIEW-010f 对上述入口建立中英文用户路径测试与真实 VS Code 语言切换走查；未验证的其他语言明确说明回退，不声称已支持全部语言。
