# Kode TODO（细粒度账本，2026-10-22 重拆）

<!--
本文件只放**未完成**任务；完成即勾并补证据（commit hash+测试数+file:line）。
历史勾账与设计出处见 git log 与 docs/review/（含 2026-10-22 统一语义索引重构计划）。
拆分原则: 单项 ≤ 半天可落、可独立验收、带证据口径。
-->

> **2026-10-24 用户令**: kode-v02 此后只在 `main` 开发，phase2 已合并（`377950f`，`--no-ff` 保留合并记录），不再开长期 feature 分支。

## P0. 启用插件后卡死：重新打开性能治理（2026-10-26，优先处理）

用户现场反馈：hover loading 约半小时才出现、Python 索引与跳转卡死，禁用插件恢复、启用再次卡顿。**问题未解决，不得沿用此前“性能已验收”的结论。** 当前源码基线 `550d824`；证据与复现范围见 [卡顿分析报告](docs/perf/2026-10-26-stall-analysis.md)。本地探针已确认算法与调度缺陷，但尚未取得用户现场 CPU profile、安装版本及运行日志，不能把“半小时”精确归因到单一函数。以下任务均未完成。

### P0-1 索引维护与扫描范围

- [ ] P0-1a 修复 Python 索引平方级维护：`pythonClassIndex.ts:564/645` 的 `updateFile → unindexFile` 每次遍历全部类，首次入库也如此。改为仅删除该文件的旧类记录；验收首次入库不遍历其他文件类，修改/删除不误删跨文件同名类，用操作计数锁定线性增长。本地基线：8,000 个单类小文件产生 31,996,000 次桶遍历，纯内存维护 3,607.42ms（单轮，非现场耗时）。
- [ ] P0-1b 统一两份 Python 索引的扫描根与排除规则：`entityMapping.ts:1365` 的方法索引漏排 `vcpkg/third_party/out/site-packages` 等目录，与 `PY_SCAN_EXCLUDE` 不一致。验收工作区与外部 assetsRoot 使用一致规则，依赖树文件不被读取/解析，业务脚本仍可导航。
- [ ] P0-1c 方法倒排索引改为单文件增量：`entityMapping.ts:967` 任意 Python change 清空整份索引，下次查询重新全扫。处理修改/新增/删除；验收保存单文件只更新对应方法桶，不触发全树重建，多目标结果保持正确。
- [ ] P0-1d 收敛构建失效与并发：方法索引旧构建失效后仍继续，PythonClassIndex 对未缓存 py 的事件会增加扫描代数。补构建代校验、取消与事件合并；验收连续保存/新建/删除时旧结果不回写，重复全扫和排队任务不持续增长。

### P0-2 前台请求与后台索引解耦

- [ ] P0-2a 消除共享调度器队首阻塞（重开 A3-6）：实体首扫整轮占用一个后台任务，`indexScheduler.ts:357` 的 runningId 阻止高优请求执行。首扫拆成有界任务并释放调度席位；验收首扫尚未完成时 RequestLocal 已执行，而非仅验证排队优先级或 setImmediate 让路。
- [ ] P0-2b 移除定向文件加载对全仓 discovery 的等待：`pythonClassIndex.ts:1020` 为候选排序等待整个文件发现。改用已知路径与稳定候选策略；验收 discovery 挂起/慢速时，已知局部依赖仍可解析，并保持跨根同名符号选择语义。
- [ ] P0-2c 清理交互未命中分支的全量等待（重开 A5-1）：审计 `ensureScanned/ensureCompositionRoots/initialScan`，重点 `pythonClassIndex.ts:1245`、`entityMapping.ts:1116`。前台使用快照与定向依赖，后台补齐；验收冷启动、未知方法、组合根未就绪均无无限等待，同时保留 mixin、多实现与跨根导航语义，不以返回不完整单目标冒充修复。

### P0-3 扩展宿主响应与取消

- [ ] P0-3a 外部根扫描改异步有界遍历：移除 `scanRoots.ts:192` 递归 `readdirSync`；验收慢目录、只有目录/非 Python 文件的树也能让出事件循环，并支持取消。
- [ ] P0-3b 方法索引移除同步枚举/读取：处理 `entityMapping.ts:1378/1400`，让路不能只在成功读取 Python 文件后检查；验收读取失败、非 Python 树与慢文件不会形成长同步阻塞。
- [ ] P0-3c 大文件解析隔离：确认重 CPU 解析路径，将大文件解析放入 worker/server，并明确结果版本与生命周期；验收解析期间扩展宿主仍可处理交互，旧版本结果不覆盖新缓冲区。现有 Rust shadow/保留配置值不算已完成服务切换。
- [ ] P0-3d 接通请求取消与预算（重开 B-1）：`extension.ts` 的 token 传入 provider、扫描与解析；`hoverBudget.ts` 超时后取消或停止该请求独占的工作，避免误取消共享索引。验收取消/超时后工作量收敛、无重复后台任务堆积；不能仅断言 Promise.race 返回 null。本地反例：10ms 定时预算遇到 150ms 同步阻塞，实际 150.34ms 才返回。
- [ ] P0-3e 修复 MRO 开关启动行为：`extension.ts:525` 在项目门控通过后无条件启动 Python 全扫，与 `enableMroJump=false` 的“不做全仓扫描”说明矛盾。统一配置契约与启动路径，覆盖激活、开关切换；未经验证不得把该开关作为止血方案。

### P0-4 真实环境验收与历史结论纠正

- [ ] P0-4a 固化可复跑诊断：将本轮临时探针整理为仓库内复现/回归用例，记录源码版本、输入规模、操作计数与执行命令；覆盖平方级遍历、运行中后台任务挡住交互、同步阻塞导致超时延后。
- [ ] P0-4b 获取现场基线：记录已安装插件版本、操作系统、工作区/外部资产根、Python 语言服务及设置；采集启用/禁用对照、扩展宿主 CPU profile、event-loop delay、请求端到端耗时、扫描文件数、内存与取消后残留任务，区分 Kode 索引与 Python 语言服务索引。
- [ ] P0-4c 真实 VS Code 联合验收：Kode 与 Python 语言服务同时启用，覆盖冷启动、大仓依赖树、外部根、未知符号、连续保存、首次跳转、hover 取消及长会话；逐场景记录修复前后 P50/P95/P99/最大耗时、事件循环延迟与资源变化。沿用既定热态 Hover P95 ≤30ms、Definition P95 ≤50ms 目标；冷启动与未命中单独报告，不以热缓存数据替代。
- [ ] P0-4d 重新审计性能报告与完成标记：保留历史量测事实，纠正“后台不抢主线程”“请求不等全仓”“超时已根治”的泛化结论；补端到端 hover 与长会话证据。P0-4c 现场验收未完成前，本节保持未完成，不以单元测试通过、局部 benchmark 或新增超时关闭问题。

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
- [ ] A3-6 **2026-10-26 重开，见 P0-2a/P0-3**：历史提交 2aca694 实现优先队列与冷却窗口，但运行中的整轮首扫仍阻塞交互任务，同步扫描仍占用宿主；“后台让路、不抢主线程”尚未成立（原证据：docs/perf/2026-pr3-indexscheduler.md）。

### A4 PR4 · 统一语义查询（semanticIndex + dependencyGraph）
- [x] A4-1 新建 src/semanticIndex.ts：实体-分面方法/属性-Python类-注册关系-类型映射-根作用域 统一承载（查询 API 不暴露内部遍历）
- [x] A4-2 新建 src/dependencyGraph.ts：entities.xml/def/types.xml/alias.xml/Python 声明 的真实依赖失效（禁「任何变更=全仓重建」，测试单文件变更失效范围）
- [x] A4-3 类型注册表迁移：resolveEntityAnnotationType 改查快照（废除逐次 statSync 指纹，保留更新事件驱动重建，definitionWorkspace.ts:308/320/345）
- [x] A4-4 实体映射查询迁移：getMappingForPythonFile 系改走 semanticIndex（旧 API 行为兼容层，原测试全过）
- [x] A4-5 多资产根模型：规范化根路径+rootID+文件映射+查找顺序显式策略（禁 Map 插入序依赖；同名实体/类冲突测试）
- [x] A4-6 现有查找顺序取证：从测试提取当前命中顺序→固化为显式策略文档+测试（不改行为先锁）

### A5 PR5 · Python Definition 去全仓阻塞
- [ ] A5-1 **2026-10-26 重开，见 P0-2b/2c**：d4fd634 已实现快照与定向加载，但 staging 仍等待全仓发现，未命中分支仍等待全量扫描；需覆盖全部交互等待路径后重新验收。
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
- [ ] B-1 **2026-10-26 重开，见 P0-3/P0-4**：用户仍报 hover loading 约半小时。历史 9c8daf7 修正路径大小写并添加 2.5s race/5s 首扫预算，1501-def 测试曾得冷 12–14ms/热 8–10ms；这些局部结果不能证明整体根治。同步阻塞会推迟定时器，超时也未取消底层工作，需真实编辑器重新验收。
- [x] B-2 函数着色 白→浅蓝：variable.function.call.python=#8BD5FF（11 主题），before/after scope 实证（179a290@分支；探针实测 get_color 白→#8BD5FF、关键字/def 不吃）
- [x] B-3 RPC 形参 inlay：调用点 `形参名: 类型`（kbengine.inlayHints.typeData 开关；fa13ef9 已在 main；+6 测试）
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
- [x] C-14 V-06·d：引擎版本探针标记已失效，真实树上恒报 unknown。证据：fork `cuihairu/kbengine` 初始导入提交 `0bc93d5` 的树中即无 `kbe/src/lib/common/version.h`，`git log --all --diff-filter=A -- kbe/src/lib/common/version.h` 全史为空；本树是 KBEngine 2.5.10，版本面在 `kbe/src/lib/common/kbeversion.h`，内容为 `#define KBE_VERSION_MAJOR 2` / `MINOR 5` / `PATCH 10` 三宏 + `KBEVersion::versionString()` 运行时函数，**无 `#define KBE_VERSION "..."` 字符串宏**。影响：`src/engineApiMetadata.ts` `findEngineRoot` 与 `tests/helpers/engineTree.ts` 探针都取 `kbe/src/lib/common/version.h`，在本机真树上前者恒 unknown、后者恒 skip。修法：双标记（`version.h` 旧口径 | `kbeversion.h` 新口径）+ 从三宏合成版本串或走 unknown 兜底，两处探针改同一口径并补测试；不得只换文件名（宏形状也变了，单宏正则读不出版本）
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

## D. 维护与质量
- [x] D-1 每日 CI 日巡异常闭环：cron e4bddc0a5a17 **已不在调度器**（CronList 空、无 .claude/scheduled_tasks.json —— 会话级 cron 不跨会话持久，首跑复核无对象，如实记录）；异常侧已闭环：最近唯一失败为 nightly workflow_dispatch 2026-10-23T07:21Z，根因 npm registry TLS handshake EOF（pnpm install 取 vsce-sign/levn 抖动，非代码），下一轮 schedule 2026-10-23T10:58Z 成功自愈，无需动作。**待用户定夺**：是否重建为 durable 日巡（durable 会话常驻任务须用户明确同意，不自建）
- [x] D-2 docsCommands 测试口径随新配置键滚动补齐（tests/docsCommands.test.ts 新增「features.md Settings 表与 package.json 对账」三例：① package.json 每条贡献键都见于 features.md Settings 表（**中英同锁**，防只补一边）② 反向：除运行时键白名单 `kbengine.managedDir` 外不得记载未贡献的键 ③ 标量（字符串/数字/布尔）默认值逐键与 `JSON.stringify` 口径核对，数组/对象只查行不比内容——`callChainView`/`typeData`/`asyncBudgetMs`/`apiMetadata` 等键由此锁自动滚动覆盖，不再逐键补断言）
  - 证据：2a32be3 test: lock features settings table against drift；该锁落地即揪出中英漂移各一处（EN 缺 5 键 hover.asyncBudgetMs/webviewConsoleLogs/python.apiMetadata/python.callChainHints/python.callChainView、zh 缺 `kbengine.python.builtinTypeInlayHints`），已一并补齐 31147ec；test:unit 2808 passed|8 skipped（基线 2799/7，+6 为 C-8 探测用例、+3 为本锁）
- [x] D-3 发布铁律季度复核：**查出回潮并已拆**——ci.yml 原有两条绕过版本闸的自动发布腿：① `on: release: created` → `pnpm run publish`（发 GitHub Release 即自动上 Marketplace）；② 任何手动 `workflow_dispatch` 跑 CI/CD 即裸发 Marketplace（无版本一致性校验）。两条均拆除，Marketplace 发布唯一正道=publish.yml workflow_dispatch（含 package.json version 逐字一致性闸 + 全量测试 + lint）；tag push 建 GitHub Release 腿保留（用户手动推 tag 即版本决定，且不触 Marketplace）（e38bdf9；.github/workflows/ci.yml:on 与 build steps）
- [x] D-4 功能清单 features.md 随 B/C 项落地同步（EN+zh 各补 2 条功能条目：**悬停 def 方法 / 接收者调用 / 内建属性标注（Python）**——B-1 三条异步标注面，证据 src/languageProviders.ts `provideHover` 三分支 + src/hoverBudget.ts `raceWithBudget` + 三开关 `kbengine.entity.receiverSections|builtinProperties`、`kbengine.hover.asyncBudgetMs`；**调用链 Show Call Chain**——B-4 深度 3 向外出调沿 `self.base/cell/client.<方法>()` 接收者调用、打包离线 mermaid graph（默认）或纯文本回落、面板 tab 持久化优先于设置、图渲染失败回落文本带面板头说明，证据 `kbengine.python.showCallChain` 命令 + `callChainHints|callChainView` 开关 + src/defCallChain.ts/defCallChainProvider.ts/defCallChainViewLogic.ts；另补 Settings 表行 EN 5 行 + zh 6 行）
  - 证据：31147ec docs: sync features settings table and add feature entries（2 files，15 insertions，EN+zh 功能条目与设置行同批对齐）；每条带 package.json#contributes|configuration 与 src 文件指针，mermaid 渲染四链已过 parse 校验（docs/perf/2026-baseline.md §7）；D-2 锁同批落地防回潮 2a32be3

<!--
完成口径示例: [x] A2-4 Hover 接入快照（1a2b3c4；test:unit 2690/2sk；src/documentStore.ts:42、languageProviders.ts:582）
-->

#### 提案挂账：Rust Core 常驻语言服务（2026-10-23 外部提案整理）

来源与全文见 `docs/review/2026-10-23-rust-core-lsp-proposal.md`（含与 PR1-7 实况的对照表）。口径：**不插队**——PR7 复测收官后按跟踪清单 R1（数据审计）→R2（原型对拍）过闸再议 R3；终端/脚本启动慢按 R4 独立立项。已代决：采纳「先数据后迁移」的闸门顺序，拒绝直接开写 Rust。
- [ ] R1 数据审计（来源=用户 2026-10-27 令,迁移解除排队并入本轮）：用 PR1-7 实测指标定位 TS 残余成本 top3,产出「迁移值得/不值得」结论;结论必须直接指向 P0-1a(平方级维护)与 P0-3c(大文件解析)——回答这两个面上 Rust 能否比 TS 修法拿数量级收益;取舍记录落 docs/review 提案文档或 docs/decisions
- [ ] R2 最小原型对拍（来源=用户 2026-10-27 令,需 R1 过闸后接续）：Rust .def+types.xml 解析器(quick-xml 带位置)+实体索引,与 TS 同语料 diff 一致(位置感知对拍+增量零重建金丝雀);R3 tower-lsp 骨架仅在 R1/R2 双绿后放行
- [x] 审核发现：Python 全扫把失败分块的 wait 拒绝逐一吞掉后仍标记该扫描代完成，失败文件永久缺席且后续查询不重试（967084d；src/pythonClassIndex.ts 逐分块收终态(completed/failed),失败分块的文件登记 pendingScanRetries(file→尝试次数),不再吞掉后照旧标记该代完成;后续查询经 ensureScanned 短路分支触发 schedulePendingScanRetry 定向补解析——只重跑待补文件,不全仓重扫;重试有界 MAX_SCAN_RETRY_ATTEMPTS=3,永久不可读文件不无限重试;tests/pythonIndexPr5.test.ts 新增 FailNextChunkScheduler+「分块失败不被吞掉」用例,断言注入失败后全量口径查不到、待补重试后补齐且重试分块不再失败,未删用例未松断言;perf 锚点随行号重校(552/1020/1128),未删断言）
- [x] 审核发现：self 方法解析已命中静态 MRO 时，组合根派生超过 1 秒仍直接返回空列表，丢弃已找到的有效目标（a8dc6cb；src/pythonClassIndex.ts resolveSelfMethodCandidates 的组合根预算 race 超时分支由 `return []` 改为 `return out`——① 静态 MRO 已命中目标照常返回,组合根侧本次不补,下次查询派生就绪后自然补齐;预算经新增可选参数 budgetMs(默认 INTERACTIVE_INDEX_WAIT_MS)注入,两处 raceWithBudget 一致;tests/pythonIndexPr5.test.ts 新增「组合根派生超时」用例:三 glob 挂起逼出超时路径,断言静态 MRO 命中仍返回(修复前该断言失败),未删用例未松断言;perf 锚点重校(1130),未删断言）
- [x] 审核发现：对象级负缓存只凭映射表非空就记录 miss，首扫尚未完成时可把后续分块里的接口或组件类永久误判为不存在（ee3a53b；src/entityMapping.ts 新增 initialScanCompleted 标志——只在首扫成功落地分支置位,对象级负缓存发布闸由 `mappingIndexes.size > 0` 改为 `initialScanCompleted`:首扫进行中(哪怕映射表已并入部分分块)不凭「表非空」记 miss,后续分块里的接口/组件类不再被永久误判;真实扫描失败不置完成位,负缓存不得基于残缺快照发布;tests/entityMappingObjectNegativeCache.test.ts 新增「首扫进行中的接口/组件类 miss 不落死」用例:ChunkGateScheduler 扣住 Hero 分块复现「映射表非空但首扫未完」中间态,断言中间态查 HealthComp 为 null 且未入 missingClassNames,放行后经 ownerName 回溯命中(组件属性以槽名 healthPack 挂在实体索引),未删用例未松断言）
- [x] 审核发现：worker 解析失败与文件读取失败共用 catch，解析线程崩溃时会删除仍存在文件的旧类索引而非保留并重试（cc5147b；src/pythonClassIndex.ts loadFile 拆成两段 try——读失败(文件被删/不可读)保持原撤索引语义,解析失败(内容已读到、文件仍在盘)保留旧类索引并登记 pendingScanRetries 待补重试;loadFile 改返 boolean(false=本次未提交内容),schedulePendingScanRetry 相应重构:重试表内全部文件(不再按「fileCache 缺席」过滤,否则解析失败保留的文件永远进不了重试),成功信号改看 loadFile 实际提交结果而非 fileCache 有无(保留场景 fileCache 恒有值,旧信号会把失败当成功清账),重试仍有界 MAX_SCAN_RETRY_ATTEMPTS;tests/pythonClassIndexParseFailure.test.ts 新增两例:解析失败保留旧索引+登记待补+恢复后重试补齐(内容变更可见、待补清账)/读失败仍撤索引且不登记重试,改回旧行为(解析失败删索引)首例即红,未删用例未松断言;perf 锚点随行号重校(1020→1051/1130→1161),未删断言）
- [x] 审核发现：调度器将所有已完成、失败及取消任务永久留在 tasks Map，长会话持续保存会累积任务闭包和批量文件路径（d8c3c35；src/indexScheduler.ts pump 终态块与 cancelQueued 各补 `this.tasks.delete(id)`——句柄经 settleListeners/自身闭包保留状态,不依赖 Map,queued/running 查询只看 queueOrder 与 runningId,出表安全;tests/indexScheduler.test.ts 新增「终态任务出表」用例,以运行态快照只读探针断言 completed/failed/cancelled 后 Map 空且计数不回归,未删用例未松断言）
- [x] 审核发现：实体首扫 keyed 任务只启动真实扫描便宣告完成，真实扫描失败又被转成成功的 initialScan；A3-4 的失败重试语义未接到实体扫描（77e9102；src/entityMapping.ts 真实扫描失败不再静默转成功——新增 initialScanFailed/initialScanAttempts 记账,失败分支置失败态而非仅 resolve,负缓存完成位(initialScanCompleted)只在真实成功落地;重试不走 keyed 任务内 await(单槽调度器下首扫分块是独立后台任务,run 内 await 自身子分块会死锁),改管理器侧有界重触发:launchInitialScanViaScheduler(启动+等真实工作)由启动链与 retryInitialScanAfterFailure 共用,冷查询入口(ensureIndexForClass 入口/跨 def 回退)遇失败态重排,上限 MAX_INITIAL_SCAN_ATTEMPTS=3,树真坏不无限打转;tests/entityMappingInitialScanRetry.test.ts 两例:首扫分块注入崩溃→失败态记账且完成位不置+冷查询重触发后完成位置位且 Hero 命中 Hero.def/持续失败时多轮冷查询到 3 次上限后不再重排(failedChunks 不增)且负缓存闸保持关闭,改回静默转成功分支(失败仅 resolve)两例即红,未删用例未松断言）
- [ ] 审核发现：按需加载先按 import 候选顺序截取 64 个缺失路径，导入较多时后面的真实依赖被静默跳过并导致跳转落空（src/pythonClassIndex.ts:877）
- [x] 审核发现：PR5 首查测试在异步文件发现尚未入队分块时断言 gatedCount>0，当前连续两次单独运行均失败，未正确锁住“后台推进”行为（1f77df8；tests/pythonIndexPr5.test.ts:325 前加 `await scheduler.chunksEnqueued`——GatedBackgroundScheduler 在首个 full-reindex 分块入队即 resolve，把断言锚在真实入队时点而非首查返回时点；`scheduleBackgroundScan`(:1039) 是 fire-and-forget，分块在发现完成后才入队，原断言抢到发现前面恒为 0。未删用例未松断言，gatedCount/executedFullReindex/噪声零读/单文件计数四条断言原样保留）
- [ ] 审核发现：大文件 worker 路径及 worker 崩溃、停用、旧 revision 回包均没有直接测试，现有解析测试只覆盖同步 parsePythonFile（src/pythonParserWorkerHost.ts:52）
- [ ] 新任务1（来源=用户 2026-10-27 令,排在审核发现之后实现）：receiver 可能为 None 的诊断告警——self.client/self.cell/self.base 的成员调用/属性访问,当前作用域无 `is not None`/`if x:`/早退/hasattr guard 时报 Warning「receiver may be None when player offline」(附引擎源码引用:server/baseapp/entity.cpp:800 pyGetClientEntityCall、:750 pyGetCellEntityCall、cellapp/entity.cpp:74);guard 分析用 in-tree pythonParser,接收者提取复用 getPythonReceiverCallAtPosition;段错配同源可报(经 self.cell 调 ClientMethods 声明的方法);配置开关默认开可关,severity=Warning;vitest 用例覆盖 guard/无 guard/段错配/开关关
- [ ] 新任务2（来源=用户 2026-10-27 令,排在审核发现之后实现）：def 函数形参 inlay(定义点)——entity 脚本区块(ClientMethods/BaseMethods/CellMethods)内 `def foo(self, a, b):` 每个未手写标注的形参后渲染 `a: <Type>`,类型按「区块+方法名」反查 .def <Arg> 声明(resolveEntityAnnotationType/formatDefMethodSignature 同链,方向反转);口径:def 未声明 <Arg> 不出/形参已有标注不覆盖/区块外普通方法不出(不做推导)/<ReturnType> 存在时顺带 -> 提示/跨行 def 与现有 inlay 同规则;独立开关 kbengine.inlayHints.defParams 默认开;vitest 用例覆盖四边界
- [ ] 新任务3（来源=用户 2026-10-27 令,接新任务1/2 之后）：entity_types.pyi 与脚本类关联(补全断层)——生成存根由独立 `class Avatar:` 改为 `class Avatar(Entity):`(继承 KBEngine 桩 Entity,def 方法并入);EntityCall 补全:每实体生成 mailbox 形态(如 AvatarMB(EntityCall) 含 Base/Cell/Client 方法面),KBEngine.pyi 的 Entity 基类 client/base/cell 属性注解用对应 MB 类型方案落地(最小可用形态自定,取舍写 docs/design/def-pyi-stubs.md 增补节);开关沿用 stubExport/entityStubMethods;vitest 覆盖生成内容/继承关系/开关关时行为
- [ ] 新任务4（来源=用户 2026-10-27 令,接新任务1/2 之后）：消灭 pyi 里可避免的 Any——FIXED_DICT 自定义类型改引用 kbe_types.pyi 已生成的 TypedDict 类名(跨文件 import 对齐,kbe_types 有类但 entity_types 没引用的断层一并修);types.xml 声明元素类型/长度的 ARRAY 类自定义类型改 list[元素类型](递归同一解析链);PYTHON_BUILTIN_TYPE_ANNOTATIONS 补全缺项(对照 kbengine 仓 kbe/res/server/types.xml 与 addDataType 注册面);跨文件同名注解必须真实可解析(import 齐全);诚实 Any 只留裸 ARRAY(def 直接写 ARRAY 无自定义)/PYTHON/ALIAS;vitest 每条消灭路径一例+诚实 Any 边界用例;汇报 Any 占比消灭前后实测数字
