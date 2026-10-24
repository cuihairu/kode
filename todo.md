# Kode TODO（细粒度账本，2026-10-22 重拆）

<!--
本文件只放**未完成**任务；完成即勾并补证据（commit hash+测试数+file:line）。
历史勾账与设计出处见 git log 与 docs/review/（含 2026-10-22 统一语义索引重构计划）。
拆分原则: 单项 ≤ 半天可落、可独立验收、带证据口径。
-->

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
- [x] A3-6 后台限流与取消：交互任务单并发+后台让路，不抢主线程（2aca694；src/indexScheduler.ts:42、:149 throttleTimer；docs/perf/2026-pr3-indexscheduler.md）

### A4 PR4 · 统一语义查询（semanticIndex + dependencyGraph）
- [x] A4-1 新建 src/semanticIndex.ts：实体-分面方法/属性-Python类-注册关系-类型映射-根作用域 统一承载（查询 API 不暴露内部遍历）
- [x] A4-2 新建 src/dependencyGraph.ts：entities.xml/def/types.xml/alias.xml/Python 声明 的真实依赖失效（禁「任何变更=全仓重建」，测试单文件变更失效范围）
- [x] A4-3 类型注册表迁移：resolveEntityAnnotationType 改查快照（废除逐次 statSync 指纹，保留更新事件驱动重建，definitionWorkspace.ts:308/320/345）
- [x] A4-4 实体映射查询迁移：getMappingForPythonFile 系改走 semanticIndex（旧 API 行为兼容层，原测试全过）
- [x] A4-5 多资产根模型：规范化根路径+rootID+文件映射+查找顺序显式策略（禁 Map 插入序依赖；同名实体/类冲突测试）
- [x] A4-6 现有查找顺序取证：从测试提取当前命中顺序→固化为显式策略文档+测试（不改行为先锁）

### A5 PR5 · Python Definition 去全仓阻塞
- [x] A5-1 ensureScanned/ensureCompositionRoots 调用关系重构：Definition 先查快照+已建索引，按需单文件解析(stageRequestFiles)，后台补全量（d4fd634；src/pythonClassIndex.ts:1193-1250 两段查询、:1114 单文件入队）
- [x] A5-2 组合根构建缓存：同批 XML/def 只读一次，mtime+size 指纹重派生零重读（d4fd634；src/pythonClassIndex.ts:685-700 python-composition-roots 打点；docs/perf/2026-final-report.md 验收#6）
- [x] A5-3 PythonClassIndex 版本与失效：类/基类/方法/MRO/组合根显式版本+依赖图裁断失效，比较走稳定 classKey 非对象引用（d4fd634；SemanticDependencyGraph 接入、fullRebuild 恒 false；docs/perf/2026-pr5-unblocked-definition.md §4）
- [x] A5-4 删除/重命名/基类变更后旧索引项移除，跳转不到已不存在位置（d4fd634；tests/pythonIndexPr5.test.ts:203-244；docs/perf/2026-final-report.md 场景6 旧项 0 命中）
- [x] A5-5 冷启动 Definition 首查耗时入报告：107,737ms → 468.69ms（PR7 复测 475.34ms），不再等待全仓（d4fd634；docs/perf/2026-pr5-unblocked-definition.md §2 U1、docs/perf/2026-final-report.md §3 场景1）

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
- [ ] C-12 chatgpt 归并书遗留核对（**核对结果：引用余数=0，但原文未删，见下方证据**）
  - 引用余数核对通过：文件名 `chatgpt-2026-10-20-kode-*`、`log-center`、`background-process`、`chatgpt.*roadmap`、`chatgpt.*typings` 各 pattern 在 docs/src/tests/scripts/package.json 全部 0 命中（排除归并书本体与 docs/.vitepress/dist 构建产物）
  - **未达项**：四份原文仍在 docs/review/ 且为 git 跟踪文件（chatgpt-2026-10-20-kode-{roadmap,log-center,background-process,typings}.md，10-21 09:52 落盘，从未有删除提交）——是否随归并完成归档删除，**待用户定夺**（属删档动作，agent 不自行执行）

## D. 维护与质量
- [x] D-1 每日 CI 日巡异常闭环：cron e4bddc0a5a17 **已不在调度器**（CronList 空、无 .claude/scheduled_tasks.json —— 会话级 cron 不跨会话持久，首跑复核无对象，如实记录）；异常侧已闭环：最近唯一失败为 nightly workflow_dispatch 2026-10-23T07:21Z，根因 npm registry TLS handshake EOF（pnpm install 取 vsce-sign/levn 抖动，非代码），下一轮 schedule 2026-10-23T10:58Z 成功自愈，无需动作。**待用户定夺**：是否重建为 durable 日巡（durable 会话常驻任务须用户明确同意，不自建）
- [ ] D-2 docsCommands 测试口径随新配置键滚动补齐（callChainView/typeData/budget 等键的文档行核对）
- [x] D-3 发布铁律季度复核：**查出回潮并已拆**——ci.yml 原有两条绕过版本闸的自动发布腿：① `on: release: created` → `pnpm run publish`（发 GitHub Release 即自动上 Marketplace）；② 任何手动 `workflow_dispatch` 跑 CI/CD 即裸发 Marketplace（无版本一致性校验）。两条均拆除，Marketplace 发布唯一正道=publish.yml workflow_dispatch（含 package.json version 逐字一致性闸 + 全量测试 + lint）；tag push 建 GitHub Release 腿保留（用户手动推 tag 即版本决定，且不触 Marketplace）（e38bdf9；.github/workflows/ci.yml:on 与 build steps）
- [ ] D-4 功能清单 features.md 随 B/C 项落地同步（每项带证据口径不吹）

<!--
完成口径示例: [x] A2-4 Hover 接入快照（1a2b3c4；test:unit 2690/2sk；src/documentStore.ts:42、languageProviders.ts:582）
-->

#### 提案挂账：Rust Core 常驻语言服务（2026-10-23 外部提案整理）

来源与全文见 `docs/review/2026-10-23-rust-core-lsp-proposal.md`（含与 PR1-7 实况的对照表）。口径：**不插队**——PR7 复测收官后按跟踪清单 R1（数据审计）→R2（原型对拍）过闸再议 R3；终端/脚本启动慢按 R4 独立立项。已代决：采纳「先数据后迁移」的闸门顺序，拒绝直接开写 Rust。
