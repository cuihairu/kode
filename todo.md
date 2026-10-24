# Kode TODO（细粒度账本，2026-10-22 重拆）

<!--
本文件只放**未完成**任务；完成即勾并补证据（commit hash+测试数+file:line）。
历史勾账与设计出处见 git log 与 docs/review/（含 2026-10-22 统一语义索引重构计划）。
拆分原则: 单项 ≤ 半天可落、可独立验收、带证据口径。
-->

## A. 语言服务性能治理（结构重构，源自 docs/review/2026-10-22-unified-semantic-index-refactor.md，PR1→PR7 顺序推进）

### A1 PR1 · 性能观测与基线（不改任何行为结果）
- [x] A1-1 新建 src/languageServiceMetrics.ts：单调时钟、请求ID、事件枚举（hover/definition/completion/diagnostics/python-index-scan/entity-mapping-scan/type-registry-query/file-discovery/document-parse 等 11 类），默认关闭详细记录（89e8783；src/languageServiceMetrics.ts:9-23 事件枚举 12 类含 index-scheduler、:105 monotonicNow、:110 nextRequestId、:100/:126 详细记录默认关闭可开；tests/languageServiceMetrics.test.ts）
- [x] A1-2 记录字段齐备：总耗时+子阶段耗时、文件发现/读取/解析/缓存命中计数、是否等待初始化、索引 generation、文档 version、结果状态（成功/未命中/取消/异常）（89e8783；:30-71 子阶段耗时/文件发现-读取-解析计数/缓存命中/waitInitialization/indexGeneration/documentVersion、:25 OperationStatus ok|miss|cancelled|error）
- [x] A1-3 汇总出口：请求数、P50/P95/P99、最大值、命中率（命令面板「Show Language Service Metrics」）（89e8783；:162 nearestRank、:177-179 P50/P95/P99、:209 getLanguageServiceSummaryReport；extension.ts:1311 命令面板 KBEngine: Show Language Service Metrics Summary）
- [x] A1-4 埋点接线：KBEngineHoverProvider/PythonCompletionProvider/KBEngineDefinitionProvider/PythonDefinitionProvider/诊断入口全部打点（只加观测不改逻辑）（89e8783；extension.ts:427 hover、:394/:667 completion、:459/:502 definition、:281/:294 diagnostics 五处入口打点,仅观测不改逻辑）
- [x] A1-5 测试资产集生成器：小项目/数万文件模拟/≥3 资产根含同名实体与同名 Python 类/大 Python 文件/大量 def+xml/含 .git 与 node_modules 的项目（脚本化可复现）（89e8783；scripts/generate-perf-assets.mjs:5-13 六件套资产根、:30 --large-files 30000、:64 scaffoldAssetRoot 含同名实体/同名 Python 类与 .git/node_modules 噪声根）
- [x] A1-6 基线报告落 docs/perf/2026-baseline.md：机器与版本信息、冷启动/热缓存、七场景（首索引/重复查询/未索引文件首查/编辑后/改 def 后/删文件后/并发）实测数字，未测项标「待测」（89e8783；docs/perf/2026-baseline.md:7 §1 环境、:19 §2 资产、:32 §3 七场景实测、:51 §4 发现、:58 §5 待测 6 项如实标注）
- [x] A1-7 主要调用链图（Mermaid）落同报告：hover/definition/completion/diagnostics 四条链的真实调用路径与等待点标注（48b3bb2；同报告:74 §7 四链 Mermaid 各 flowchart TD、等待点 WAITA-F 虚线框；tests/perfCallChainDoc.test.ts 4 例锁结构面与 file:line 出处）

### A2 PR2 · 文档快照与解析缓存（documentStore）
- [x] A2-1 新建 src/documentStore.ts：URI 规范化+版本号+文本+行索引+解析态（Python/def/XML）+最近成功解析版本（7d8736b；src/documentStore.ts:55 normalizeDocumentKey、:138 updateDocumentSnapshot、:167 getDocumentLines、:183 peekDocumentSnapshot、:275 getOrParseDocumentSync、:28-40 DocumentSnapshot）
- [x] A2-2 内存优先规则：打开文档以 VS Code 缓冲区为准；磁盘旧内容不得覆盖编辑中内容（测试锁定）（tests/documentStore.test.ts:21 规则注释、:150 磁盘旧内容不覆盖断言）
- [x] A2-3 同版本只解析一次；解析中再编辑→旧结果不覆盖新版本（并发测试）（tests/documentStore.test.ts:188 在途解析合并、:211 并发编辑不覆盖新版本）
- [x] A2-4 Hover 接入：provideHover 与局部变量推导改走快照行数据（废除逐次 getText().split 全文拆行）（7d8736b；languageProviders.ts:576 provideHover、:686/:733/:788 局部变量推导全部改走 getDocumentLines 快照,不再逐次 getText().split 全文拆行）
- [x] A2-5 Diagnostics 接入：validateDocument 复用同版本 parseDefAst 快照（7d8736b；languageProviders.ts:1062 validateDocument、:1077 一次 parseDefAst 结果共用标量+结构校验,parseDefAst 走 documentStore "def-ast" 命名空间 :2090/:2096）
- [x] A2-6 快照 LRU/释放策略（关闭文档后内存不泄漏，测试）（7d8736b；documentStore.ts:319 releaseDocument、:324 releaseAllDocumentSnapshots、:329 getStoredSnapshotCount；tests/documentStore.test.ts:292 释放套件、:305 同键不同拼写）
<!-- A1/A2 13 项对账 2026-10-24(全量 test 2969 passed|8 skipped):12 项此前已由
89e8783(PR1 观测基建)与 7d8736b(PR2 documentStore) 引入,本批只补证据口径;仅
A1-7 调用链图此前缺失,48b3bb2 补上并加 tests/perfCallChainDoc.test.ts 锁。 -->


### A3 PR3 · 统一索引调度（indexScheduler）
- [ ] A3-1 新建 src/indexScheduler.ts：任务生命周期（首扫/增量/受影响依赖更新/删除清理）+状态查询
- [ ] A3-2 任务合并：同文件同版本任务去重；过期任务取消丢弃（测试）
- [ ] A3-3 优先级队列：当前文件轻量解析 > 请求所需局部索引 > 依赖更新 > 后台全量 > 非交互分析（测试顺序断言）
- [ ] A3-4 失败恢复：扫描中途失败后后续请求可恢复，不出现永久 pending（测试：杀掉首轮扫描模拟）
- [ ] A3-5 EntityMappingManager 首扫迁入调度器（initialScan 走 scheduler，行为等价测试）
- [ ] A3-6 后台限流与取消（编辑高峰期不抢主线程，指标验证）

### A4 PR4 · 统一语义查询（semanticIndex + dependencyGraph）
- [x] A4-1 新建 src/semanticIndex.ts：实体-分面方法/属性-Python类-注册关系-类型映射-根作用域 统一承载（查询 API 不暴露内部遍历）
- [x] A4-2 新建 src/dependencyGraph.ts：entities.xml/def/types.xml/alias.xml/Python 声明 的真实依赖失效（禁「任何变更=全仓重建」，测试单文件变更失效范围）
- [x] A4-3 类型注册表迁移：resolveEntityAnnotationType 改查快照（废除逐次 statSync 指纹，保留更新事件驱动重建，definitionWorkspace.ts:308/320/345）
- [x] A4-4 实体映射查询迁移：getMappingForPythonFile 系改走 semanticIndex（旧 API 行为兼容层，原测试全过）
- [x] A4-5 多资产根模型：规范化根路径+rootID+文件映射+查找顺序显式策略（禁 Map 插入序依赖；同名实体/类冲突测试）
- [x] A4-6 现有查找顺序取证：从测试提取当前命中顺序→固化为显式策略文档+测试（不改行为先锁）

### A5 PR5 · Python Definition 去全仓阻塞
- [ ] A5-1 ensureScanned/ensureCompositionRoots 调用关系重构：Definition 先查快照+已建索引，按需单文件解析，后台补全量
- [ ] A5-2 组合根构建缓存：同批 XML/def 只读一次（不同入口不重复发现，指标断言）
- [ ] A5-3 PythonClassIndex 版本与失效：类/基类/方法/MRO/组合根显式版本+失效条件
- [ ] A5-4 删除/重命名/基类变更后旧索引项移除（跳转不到已不存在位置，测试）
- [ ] A5-5 冷启动 Definition 首查耗时入报告（不再等待全仓，数字说话）

### A6 PR6 · 诊断与一致性收口
- [x] A6-1 诊断任务版本化：连续编辑合并过期任务，只发布匹配当前版本结果（测试）
- [x] A6-2 轻量本地诊断与索引语义诊断分层；无关文件变更不重算全部打开文档（指标断言）
- [x] A6-3 entities.xml 诊断入口同版本失效约束
- [x] A6-4 配置切换（诊断开关）正确清理/重算（测试）
- [x] A6-5 同名符号跨根稳定性测试集补齐

### A7 PR7 · 复测回归与交付
- [ ] A7-1 同环境同资产复测，报告 vs PR1 基线对比（无数据不进报告）
- [ ] A7-2 验收表逐项标 通过/未通过/未测量（Hover P95≤30ms 等目标以基线评审定案）
- [ ] A7-3 新架构图+索引数据模型/作用域/失效/调度说明文档
- [ ] A7-4 未解决问题清单与下一轮建议

## B. 在途/止血项（结构性治理并行的即时修复，落地即勾）
- [x] B-1 hover 永转+2分钟：入口 2.5s 总预算 race+waitForInitialScan 5s 超时+LogHub 超时层名（9c8daf7@分支；**真凶=normalizeLookupPath 小写化致定向解析死代码**，修后冷悬停 12-14ms/热 8-10ms，1501-def 树实测；kbengine.hover.asyncBudgetMs；test 2712/0）
- [x] B-2 函数着色 白→浅蓝：variable.function.call.python=#8BD5FF（11 主题），before/after scope 实证（179a290@分支；探针实测 get_color 白→#8BD5FF、关键字/def 不吃）
- [x] B-3 RPC 形参 inlay：调用点 `形参名: 类型`（kbengine.inlayHints.typeData 开关；fa13ef9 已在 main；+6 测试）
- [x] B-4 调用链图形化双 Tab：Graph(默认,esbuild 打包 mermaid@12 离线 5MB 入库)+Text 兜底，kbengine.python.callChainView，渲染失败回落（d5cff3d；16 例测试；CSP 零 CDN）
- [x] B-5 分支成果收敛 main：179a290/9c8daf7/d5cff3d 三 commit squash 为 5071dde 已推 main（本地 main 旧指针 27199f8 经 patch-id 证与 origin c057bb3 重复后重置，零内容丢失）

## C. 功能项（拆细推进）
- [ ] C-1 G9 Space Viewer/Watcher 面板·第一步：引擎 watcher 协议取证（kbengine 源码树 getWatcher/addWatcher 消息面，file:line 摘录落 docs/design）
- [ ] C-2 G9·第二步：最小查询面板（单 watcher 查询+结果表格，走真实协议，mock 测试）
- [ ] C-3 G9·第三步：面板操作面（增删 watcher、结果订阅流），开关默认关
- [ ] C-4 T-04 .pyi 抢占实验结论落地（实验文档已在，产出「开关建议档」待用户拍板行）
- [ ] C-5 V-06 版本感知 API·a：引擎版本/源码提交探测模块（git describe 取不到→unknown，禁硬造）
- [ ] C-6 V-06·b：API 元数据挂接（声明位置+版本标识进 API 浏览面）
- [ ] C-7 V-06·c：配置开关+features 清单行+测试
- [ ] C-8 V-07 兼容性测试·a：KBENGINE_ROOT 探测+无树 skipIf（CI 无树自动跳，skip 原因可见）
- [ ] C-9 V-07·b：fantasydemo 真实脚本样例批（def 解析/继承/校验行为断言）
- [ ] C-10 V-07·c：CI 接线（有树环境真跑，集成 tag）
- [ ] C-11 V-08 边界注记：等真实管理协议（外部条件，触发条件=管理协议可用性，届时重开 C-1/C-2）
- [ ] C-12 chatgpt 归并书遗留核对（roadmap/log-center/background-process/typings 四份→todo/需求归并后原文已删，核引用余数=0）

## D. 维护与质量
- [ ] D-1 每日 CI 日巡（cron e4bddc0a5a17）首跑复核（明早09:00）+异常闭环
- [ ] D-2 docsCommands 测试口径随新配置键滚动补齐（callChainView/typeData/budget 等键的文档行核对）
- [ ] D-3 发布铁律执行核对：publish 仅 workflow_dispatch（185f027 已落，季度复核无自动腿回潮）
- [ ] D-4 功能清单 features.md 随 B/C 项落地同步（每项带证据口径不吹）

<!--
完成口径示例: [x] A2-4 Hover 接入快照（1a2b3c4；test:unit 2690/2sk；src/documentStore.ts:42、languageProviders.ts:582）
-->

#### 提案挂账：Rust Core 常驻语言服务（2026-10-23 外部提案整理）

来源与全文见 `docs/review/2026-10-23-rust-core-lsp-proposal.md`（含与 PR1-7 实况的对照表）。口径：**不插队**——PR7 复测收官后按跟踪清单 R1（数据审计）→R2（原型对拍）过闸再议 R3；终端/脚本启动慢按 R4 独立立项。已代决：采纳「先数据后迁移」的闸门顺序，拒绝直接开写 Rust。

## E. kode2 Phase2 slice-a 实现审查待修（2026-10-23）

审查基线：`71961d1`；范围为 definition / diagnostics / shadow 接入。Rust 尚未切流，以下问题主要影响对拍可信度和后台状态；修复期间保持 `serveFromRust=false`。现有相关 TS 19 例、Rust 33 例通过，但未覆盖以下完整生命周期；预载语料的 golden 一致率不能替代生产接线验收。

- [x] E-1 **P1 · 补齐 shadow 语料同步，并与诊断开关解耦**：当前 `src/kodeCoreShadowFaces.ts:162` 只镜像 `.def`，未同步 types.xml / entities.xml / alias.xml 与未打开的依赖文件；`src/languageProviders.ts:1067` 关闭诊断时提前返回，definition 所需同步也停止。真实 kode-server 已复现：引用 MY_INT 被误报未注册，手动补入 types.xml 后诊断消失。验收：通过生产接线验证注册类型诊断、跨文件定义跳转；关闭诊断后 definition 仍使用最新文档与依赖语料，无需测试手动预载。
- [x] E-2 **P1 · Rust 重启后重置版本账并重放快照**：`src/kodeCoreGate.ts:353` 的 mirroredVersions 未随 `src/kodeCoreClient.ts:358` 自动重启失效，新进程收到 didChange 时因文档未打开而忽略。真实 kode-server 已复现：重启后镜像 version 2，health.documents 仍为空、诊断返回空数组。验收：杀进程并等待自动重启，恢复当前文档及依赖快照；继续编辑后 health 版本、definition 和 diagnostics 均正确，旧进程的异步任务不得污染新会话账本。
- [x] E-3 **P2 · definition 对拍等待异步结果解析**：`src/languageProviders.ts:1001` 将 ProviderResult 直接传入 shadow，映射管理器的方法跳转返回 Promise，而 `src/kodeCoreShadowFaces.ts:73` 将其转换为 null。验收：同步 Location、Promise/Thenable<Location>、空结果及拒绝路径均覆盖；对拍使用解析后的真实落点，保持原 provider 返回语义，失败不产生未处理拒绝。
- [x] E-4 **P2 · 关闭文档清理 Rust 镜像与版本账**：`src/extension.ts:692` 仅释放 TS 快照和诊断任务，没有向 Rust 发送 didClose，也未删除 mirroredVersions。验收：关闭/丢弃未保存修改后 Rust 不再持有旧 overlay，依赖查询按磁盘语料策略更新；重开低版本文档正常，连续打开关闭文件不积累已关闭的文档与版本账。
