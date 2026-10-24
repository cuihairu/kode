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
- [x] C-1 G9 Space Viewer/Watcher 面板·第一步：引擎 watcher 协议取证（kbengine 源码树 getWatcher/addWatcher 消息面，file:line 摘录落 docs/design）
  - 证据：新增 docs/design/space-viewer-watcher.md（zh 镜像 docs/zh/design/space-viewer-watcher.md，vitepress 侧栏双语入口已加 docs/.vitepress/config.mts:63/:123）。取证树 = `../kbengine`（与 tests/helpers/engineTree.ts 兜底口径同源）。关键摘录：回执消息号 `CONSOLE_PROFILECB_MSGID=65503`（kbe/tools/server/pycommon/SpaceViews.py:13、Component_Status.py:13、Watcher.py:11 三处一致）；Watcher 请求号 41001-41010 按进程类型分（Watcher.py:32-40）；SpaceViewer 请求号 50001/50002/50003/50004/50005（Component_Status.py:33-34、SpaceViews.py:33-37 与 :142），服务侧实现 cellappmgr.cpp:559 `querySpaces`、cellapp.cpp:2259 `setSpaceViewer`、cellappmgr_interface.h:91/94、cellapp_interface.h:135/165、baseappmgr_interface.h:116；回执流解码顺序（进程头 int32+int64 → 逐 cellapp uint64+uint32 → 逐 Space uint32+string+string+uint32 → 逐 Cell uint32）见 SpaceViews.py:73-113；脚本侧 addWatcher 两形态与 deftype 白名单见 kbe/src/lib/network/pywatcher.cpp:28-137（delWatcher :149-165，模块注册 :184），watcher 定义本体 helper/watcher.h:227/260/294。未取证项如实标注（queryAppsLoads 回执字段、queryWatcher 请求体字段）→ C-3 前补。门禁：docs:build ✓（44.29s）、test:unit 2808 passed | 8 skipped（基线不变）；tsc/oxlint 未涉（纯 docs+config.mts 改动）。
- [x] C-2 G9·第二步：最小查询面板（单 watcher 查询+结果表格，走真实协议，mock 测试）
  - 结果表格：`src/runtimeQueryWebView.ts` 面板 watcher 查询结果从整包 JSON 倾倒改为真 `<table>`（列 Path/Kind/Value，行头 `th scope="row"`，空态文案+`hidden` 切换）；spaces 结果保持 JSON 前置块（有独立命令 `kbengine.spaces.query`）
  - 行投影抽成导出纯函数 `watcherResultRows` / `joinWatcherPath`，口径对引擎 `Watcher.py:73-137`：type 0 叶子段 → 父路径+叶子名按 `Watcher.py:82` fullpath 拼全路径；type≠0 目录段 → `keys` 即子路径；保线序不重排、空输入不造占位行。webview 内联脚本只做渲染，不再自行推导行
  - 走真实协议：面板默认 `defaultRuntimeQueryProtocol`（`queryWatcherPath` 真实 TCP 组帧，msgid 走 `WATCHER_QUERY_MSG_IDS` 表）；mock 测试经注入 seam `RuntimeQueryProtocol`（既有）
  - webview 脚本执行面：按 `tests/entityDependencyPanel.test.ts` 的 runWebviewScript 口径用假 DOM 抽出内联脚本直跑 state 消息——锁表格真渲染出 tbody 行、空态切换、spaces JSON 块（无执行面时投影再对也会静默空表）
  - 顺手修的真 bug：`SpaceQueryResult` 三处 bigint（componentID/snapshot.componentID/cellappID）过 webview 边界即抛 "Do not know how to serialize a BigInt"，整个 state 消息静默废掉——新增 `toSpaceView` 在 postMessage 前转字符串，测试锁 `JSON.stringify(view)` 不抛
  - 测试：`tests/runtimeQueryWebView.test.ts` 5→13 例全绿（joinWatcherPath 口径 / 叶子段 / 目录段 / 多段拼接 / toSpaceView bigint 转换×2 / 表格渲染×2 / 既有 5 例随新消息契约更新）；全量 `Tests 2838 passed | 8 skipped`
- [ ] C-3 G9·第三步：面板操作面（增删 watcher、结果订阅流），开关默认关
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
- [ ] C-13 V-07·d：entities.xml 分节格式注册面（`getRegisteredEntities` 只认平铺 `<root><Entity hasBase/>`，分节 `<ClientServerEntities>/<ServerOnlyEntities>` 内的条目不进清单；需按引擎 schema 定分节→hasBase/hasCell/hasClient 映射口径后落实现+测试）
- [ ] C-14 V-06·d：引擎版本探针标记已失效，真实树上恒报 unknown。证据：fork `cuihairu/kbengine` 初始导入提交 `0bc93d5` 的树中即无 `kbe/src/lib/common/version.h`，`git log --all --diff-filter=A -- kbe/src/lib/common/version.h` 全史为空；本树是 KBEngine 2.5.10，版本面在 `kbe/src/lib/common/kbeversion.h`，内容为 `#define KBE_VERSION_MAJOR 2` / `MINOR 5` / `PATCH 10` 三宏 + `KBEVersion::versionString()` 运行时函数，**无 `#define KBE_VERSION "..."` 字符串宏**。影响：`src/engineApiMetadata.ts` `findEngineRoot` 与 `tests/helpers/engineTree.ts` 探针都取 `kbe/src/lib/common/version.h`，在本机真树上前者恒 unknown、后者恒 skip。修法：双标记（`version.h` 旧口径 | `kbeversion.h` 新口径）+ 从三宏合成版本串或走 unknown 兜底，两处探针改同一口径并补测试；不得只换文件名（宏形状也变了，单宏正则读不出版本）
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

## E. kode2 Phase2 slice-a 实现审查待修（2026-10-23）

审查基线：`71961d1`；范围为 definition / diagnostics / shadow 接入。Rust 尚未切流，以下问题主要影响对拍可信度和后台状态；修复期间保持 `serveFromRust=false`。现有相关 TS 19 例、Rust 33 例通过，但未覆盖以下完整生命周期；预载语料的 golden 一致率不能替代生产接线验收。

- [x] E-1 **P1 · 补齐 shadow 语料同步，并与诊断开关解耦**：当前 `src/kodeCoreShadowFaces.ts:162` 只镜像 `.def`，未同步 types.xml / entities.xml / alias.xml 与未打开的依赖文件；`src/languageProviders.ts:1067` 关闭诊断时提前返回，definition 所需同步也停止。真实 kode-server 已复现：引用 MY_INT 被误报未注册，手动补入 types.xml 后诊断消失。验收：通过生产接线验证注册类型诊断、跨文件定义跳转；关闭诊断后 definition 仍使用最新文档与依赖语料，无需测试手动预载。
- [x] E-2 **P1 · Rust 重启后重置版本账并重放快照**：`src/kodeCoreGate.ts:353` 的 mirroredVersions 未随 `src/kodeCoreClient.ts:358` 自动重启失效，新进程收到 didChange 时因文档未打开而忽略。真实 kode-server 已复现：重启后镜像 version 2，health.documents 仍为空、诊断返回空数组。验收：杀进程并等待自动重启，恢复当前文档及依赖快照；继续编辑后 health 版本、definition 和 diagnostics 均正确，旧进程的异步任务不得污染新会话账本。
- [ ] E-3 **P2 · definition 对拍等待异步结果解析**：`src/languageProviders.ts:1001` 将 ProviderResult 直接传入 shadow，映射管理器的方法跳转返回 Promise，而 `src/kodeCoreShadowFaces.ts:73` 将其转换为 null。验收：同步 Location、Promise/Thenable<Location>、空结果及拒绝路径均覆盖；对拍使用解析后的真实落点，保持原 provider 返回语义，失败不产生未处理拒绝。
- [ ] E-4 **P2 · 关闭文档清理 Rust 镜像与版本账**：`src/extension.ts:692` 仅释放 TS 快照和诊断任务，没有向 Rust 发送 didClose，也未删除 mirroredVersions。验收：关闭/丢弃未保存修改后 Rust 不再持有旧 overlay，依赖查询按磁盘语料策略更新；重开低版本文档正常，连续打开关闭文件不积累已关闭的文档与版本账。
