# Kode TODO（细粒度账本，2026-10-22 重拆）

<!--
本文件只放**未完成**任务；完成即勾并补证据（commit hash+测试数+file:line）。
历史勾账与设计出处见 git log 与 docs/review/（含 2026-10-22 统一语义索引重构计划）。
拆分原则: 单项 ≤ 半天可落、可独立验收、带证据口径。
-->

## A. 语言服务性能治理（结构重构，源自 docs/review/2026-10-22-unified-semantic-index-refactor.md，PR1→PR7 顺序推进）

### A1 PR1 · 性能观测与基线（不改任何行为结果）
- [ ] A1-1 新建 src/languageServiceMetrics.ts：单调时钟、请求ID、事件枚举（hover/definition/completion/diagnostics/python-index-scan/entity-mapping-scan/type-registry-query/file-discovery/document-parse 等 11 类），默认关闭详细记录
- [ ] A1-2 记录字段齐备：总耗时+子阶段耗时、文件发现/读取/解析/缓存命中计数、是否等待初始化、索引 generation、文档 version、结果状态（成功/未命中/取消/异常）
- [ ] A1-3 汇总出口：请求数、P50/P95/P99、最大值、命中率（命令面板「Show Language Service Metrics」）
- [ ] A1-4 埋点接线：KBEngineHoverProvider/PythonCompletionProvider/KBEngineDefinitionProvider/PythonDefinitionProvider/诊断入口全部打点（只加观测不改逻辑）
- [ ] A1-5 测试资产集生成器：小项目/数万文件模拟/≥3 资产根含同名实体与同名 Python 类/大 Python 文件/大量 def+xml/含 .git 与 node_modules 的项目（脚本化可复现）
- [ ] A1-6 基线报告落 docs/perf/2026-baseline.md：机器与版本信息、冷启动/热缓存、七场景（首索引/重复查询/未索引文件首查/编辑后/改 def 后/删文件后/并发）实测数字，未测项标「待测」
- [ ] A1-7 主要调用链图（Mermaid）落同报告：hover/definition/completion/diagnostics 四条链的真实调用路径与等待点标注

### A2 PR2 · 文档快照与解析缓存（documentStore）
- [ ] A2-1 新建 src/documentStore.ts：URI 规范化+版本号+文本+行索引+解析态（Python/def/XML）+最近成功解析版本
- [ ] A2-2 内存优先规则：打开文档以 VS Code 缓冲区为准；磁盘旧内容不得覆盖编辑中内容（测试锁定）
- [ ] A2-3 同版本只解析一次；解析中再编辑→旧结果不覆盖新版本（并发测试）
- [ ] A2-4 Hover 接入：provideHover 与局部变量推导改走快照行数据（废除逐次 getText().split 全文拆行）
- [ ] A2-5 Diagnostics 接入：validateDocument 复用同版本 parseDefAst 快照
- [ ] A2-6 快照 LRU/释放策略（关闭文档后内存不泄漏，测试）

### A3 PR3 · 统一索引调度（indexScheduler）
- [ ] A3-1 新建 src/indexScheduler.ts：任务生命周期（首扫/增量/受影响依赖更新/删除清理）+状态查询
- [ ] A3-2 任务合并：同文件同版本任务去重；过期任务取消丢弃（测试）
- [ ] A3-3 优先级队列：当前文件轻量解析 > 请求所需局部索引 > 依赖更新 > 后台全量 > 非交互分析（测试顺序断言）
- [ ] A3-4 失败恢复：扫描中途失败后后续请求可恢复，不出现永久 pending（测试：杀掉首轮扫描模拟）
- [ ] A3-5 EntityMappingManager 首扫迁入调度器（initialScan 走 scheduler，行为等价测试）
- [ ] A3-6 后台限流与取消（编辑高峰期不抢主线程，指标验证）

### A4 PR4 · 统一语义查询（semanticIndex + dependencyGraph）
- [ ] A4-1 新建 src/semanticIndex.ts：实体-分面方法/属性-Python类-注册关系-类型映射-根作用域 统一承载（查询 API 不暴露内部遍历）
- [ ] A4-2 新建 src/dependencyGraph.ts：entities.xml/def/types.xml/alias.xml/Python 声明 的真实依赖失效（禁「任何变更=全仓重建」，测试单文件变更失效范围）
- [ ] A4-3 类型注册表迁移：resolveEntityAnnotationType 改查快照（废除逐次 statSync 指纹，保留更新事件驱动重建，definitionWorkspace.ts:308/320/345）
- [ ] A4-4 实体映射查询迁移：getMappingForPythonFile 系改走 semanticIndex（旧 API 行为兼容层，原测试全过）
- [ ] A4-5 多资产根模型：规范化根路径+rootID+文件映射+查找顺序显式策略（禁 Map 插入序依赖；同名实体/类冲突测试）
- [ ] A4-6 现有查找顺序取证：从测试提取当前命中顺序→固化为显式策略文档+测试（不改行为先锁）

### A5 PR5 · Python Definition 去全仓阻塞
- [ ] A5-1 ensureScanned/ensureCompositionRoots 调用关系重构：Definition 先查快照+已建索引，按需单文件解析，后台补全量
- [ ] A5-2 组合根构建缓存：同批 XML/def 只读一次（不同入口不重复发现，指标断言）
- [ ] A5-3 PythonClassIndex 版本与失效：类/基类/方法/MRO/组合根显式版本+失效条件
- [ ] A5-4 删除/重命名/基类变更后旧索引项移除（跳转不到已不存在位置，测试）
- [ ] A5-5 冷启动 Definition 首查耗时入报告（不再等待全仓，数字说话）

### A6 PR6 · 诊断与一致性收口
- [ ] A6-1 诊断任务版本化：连续编辑合并过期任务，只发布匹配当前版本结果（测试）
- [ ] A6-2 轻量本地诊断与索引语义诊断分层；无关文件变更不重算全部打开文档（指标断言）
- [ ] A6-3 entities.xml 诊断入口同版本失效约束
- [ ] A6-4 配置切换（诊断开关）正确清理/重算（测试）
- [ ] A6-5 同名符号跨根稳定性测试集补齐

### A7 PR7 · 复测回归与交付
- [ ] A7-1 同环境同资产复测，报告 vs PR1 基线对比（无数据不进报告）
- [ ] A7-2 验收表逐项标 通过/未通过/未测量（Hover P95≤30ms 等目标以基线评审定案）
- [ ] A7-3 新架构图+索引数据模型/作用域/失效/调度说明文档
- [ ] A7-4 未解决问题清单与下一轮建议

## B. 在途/止血项（结构性治理并行的即时修复，落地即勾）
- [ ] B-1 hover 永转+2分钟：入口 2.5s 总预算 race+waitForInitialScan 5s 超时+LogHub 超时层名（在途子代理，落地报 commit）
- [ ] B-2 函数着色 白→浅蓝：variable.function.call.python=#8BD5FF（11 主题），before/after scope 实证（分支 fa13ef9..179a290 待合 main）
- [ ] B-3 RPC 形参 inlay：调用点 `形参名: 类型`（kbengine.inlayHints.typeData 开关；分支 fa13ef9 待合 main）
- [ ] B-4 调用链图形化双 Tab：Graph(默认,打包 mermaid 离线)+Text，kbengine.python.callChainView（在途续命单）
- [ ] B-5 上述分支成果收敛 main：单实例面板(f3ff6fc)已在 main，核对无重复提交后 merge/rebase 收口

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
