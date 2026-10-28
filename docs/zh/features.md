# 已支持功能清单

[English](../features.md)

基于证据的 kode 扩展已支持功能清单。每条带证据指针，无据可查的不列。

## Def 与实体智能

- **kbengine-def 语言与语法** —— `.def` 文件注册专属语言 id、括号规则与 TextMate 语法 ——（证据：package.json#contributes.languages、package.json#contributes.grammars）
- **.def 实时诊断** —— 未知类型 / Flags / DetailLevel 取值、属性与方法重复定义、缺 Type/Flags 字段，带总开关 ——（证据：package.json#configuration `kbengine.diagnostics.*`、`kbengine.enableDiagnostics`；src/defAnalyzer.ts）
- **.def 结构化校验** —— 重复定义、标签位置与缺失字段检查，挂 `kbengine.enableStructureDiagnostics` 开关 ——（证据：package.json#configuration `kbengine.enableStructureDiagnostics`；src/defAnalyzer.ts）
- **Quick Fix：未知类型修正候选** —— 未注册类型诊断（稳定 code `kbengine.unknownType`）出 QuickFix 替换候选，只取已注册类型（内建 + types.xml + 实体），大小写归一编辑距离 ≤2，按距排序截 5；编辑只触碰当前文档，不代建声明 ——（证据：src/languageProviders.ts `KBEngineTypeCodeActionProvider`、`UNKNOWN_TYPE_DIAGNOSTIC_CODE`）
- **Code Action：缺实现 def 方法生成空方法** —— def 方法声明处（属主脚本在盘但缺该方法）出单个 Refactor 动作，标题展示目标文件与插入行；骨架为 `def 名(self, arg0..argN)` 加 `pass` 空体，`<Arg>` 声明数决定形参个数；插入点按目标文件当前文本（打开缓冲区优先）计算；已有同名实现（与 Go to Implementations 同一查询面）不再生成 ——（证据：src/languageProviders.ts `KBEngineMethodImplementationCodeActionProvider`；src/entityMapping.ts `listOwnerScriptFilesForIdentity`）
- **Python 接收者判空诊断** —— `self.cell`/`self.base`/`self.client` 成员引用无判空 guard（正向 if、早退、别名、hasattr）报 Warning 并附引擎 getter 源码；经接收者调用其对应 section 未声明的 `.def` 方法报段错配 ——（证据：package.json#configuration `kbengine.receiverNoneDiagnostics`；src/receiverNoneDiagnostics.ts）
- **接收者感知的 def 段位判定** —— 属性 Flags 解析为 base/cell/client 可见域，用于段判定与排序 ——（证据：src/defAnalyzer.ts `propertyFlagDomainList`；commit c69517e）
- **悬停：标签 / 取值 / 符号文档** —— .def 标签说明、类型-Flags-DetailLevel 取值说明与自定义属性/方法名摘要 ——（证据：package.json#configuration `kbengine.hover.showTagDocs|showValueDocs|showSymbolDocs`；src/languageProviders.ts）
- **悬停：types.xml 落库形态** —— 自定义类型在数据库的落点（builtin 主表单列附列型、FIXED_DICT 平铺、ARRAY 子表递归）——（证据：todo.md:20；package.json#configuration `kbengine.hover.typeStorage`；src/languageProviders.ts `describeTypeStorageShape`）
- **悬停：Implemented-By 反链** —— def 方法悬停显示脚本实现位置 ——（证据：package.json#configuration `kbengine.hover.implementedBy`；todo.md:111）
- **悬停：实体注册信息** —— entities.xml 注册信息（Utype 序号、清单位置、总数）——（证据：package.json#configuration `kbengine.hover.entityRegistration`）
- **悬停：def 声明链合并** —— Parent 链 + interfaces + 组件槽整理为一条继承闭包悬停 ——（证据：package.json#configuration `kbengine.hover.defChain`；todo.md:31；src/defChain.ts）
- **悬停：事件统计** —— 事件常量的注册/监听计数（事件回调反链）——（证据：package.json#configuration `kbengine.hover.eventStats`；src/eventApi.ts）
- **悬停：服务配置取值** —— kbengine.xml 服务配置项的取值与说明 ——（证据：package.json#configuration `kbengine.hover.serverConfig`；src/serverConfigHover.ts）
- **悬停：持久化属性数据库落点** —— 持久化属性显示完整 `` `db`.`tbl`.`col` `` 全名、引擎 DDL 片段与具体限制数值 ——（证据：todo.md:69、todo.md:124；src/databaseSchema.ts `describePropertyDatabaseStorage`）
- **悬停：def 方法 / 接收者调用 / 内建属性标注（Python）** —— 光标落在 Python 实现脚本里 .def 声明过的方法名上时显示 def 声明标注，过与 RPC 镜同一把形参个数 / 注解类型闸门；`self.<段>.<方法>` 调用按段解析 def 候选，段不符不给标注；单段 `self.<属性>` 访问显示内建属性分面标注；每条异步分支受悬停总预算闸约束不再永转，超时层写 LogHub ——（证据：package.json#configuration `kbengine.entity.receiverSections`、`kbengine.entity.builtinProperties`、`kbengine.hover.asyncBudgetMs`；src/languageProviders.ts `provideHover` def-method / receiver-call / builtin-property 分支；src/hoverBudget.ts `raceWithBudget`）
- **CodeLens：RPC 方法标记** —— def 声明的 Exposed 方法在 Python 实现行出镜 ——（证据：package.json#configuration `kbengine.codeLens.rpc`；todo.md:74；src/rpcCodeLens.ts）
- **CodeLens：事件回调标记** —— Python 脚本中事件回调/订阅数标记 ——（证据：package.json#configuration `kbengine.codeLens.eventCallbacks`；todo.md:27；src/eventApi.ts）
- **CodeLens：属性访问反向跳转** —— `self.<属性>` 访问行回链 def 声明，附类型/可见域/持久化信息 ——（证据：package.json#configuration `kbengine.codeLens.property`；todo.md:21；src/propertyCodeLens.ts）
- **CodeLens：types.xml 落库镜链** —— 类型声明行「落库到表 X」镜链带引用反扫，超 10 处折叠为计数镜 ——（证据：package.json#configuration `kbengine.codeLens.typesXml`；todo.md:20；src/languageProviders.ts `TypesXmlCodeLensProvider`）
- **Inlay hint：def 声明数据类型** —— `self.<属性>` 访问处内联显示 types.xml 数据类型;`self.base/cell/client` RPC 调用点每实参后内联显示 def 已声明的形参类型(`argN: 类型`)——（证据：package.json#configuration `kbengine.inlayHints.typeData`；todo.md:25；src/typeInlayHints.ts）
- **Inlay hint：def 形参类型(定义点)** —— entity 脚本区块(ClientMethods/BaseMethods/CellMethods)内 def 的未标注形参后内联 def 声明的 `<Arg>` 类型,声明 `<ReturnType>` 时闭括号后内联 `-> 类型` ——（证据：package.json#configuration `kbengine.inlayHints.defParams`；src/defParamInlayHints.ts）
- **entities.xml 校验** —— 同名重复实体落 warning（引擎按已有模块静默合并）+ Utype 清单序号悬停 ——（证据：todo.md:33；src/entitiesXmlAnalysis.ts）
- **跨文件继承检查** —— 继承链跨文件同名检查；Interfaces 装载语义对齐引擎 ——（证据：todo.md:65、todo.md:66；src/defAnalyzer.ts `collectInheritedNames`）
- **Python 导航（F12 / 重命名 / 调用层级）** —— owner-aware 导航，C3-MRO 与 mixin 组合根解析，`kbengine.python.enableMroJump` 开关 ——（证据：package.json#configuration `kbengine.python.enableMroJump`；src/languageProviders.ts、src/pythonClassIndex.ts、src/entityMapping.ts）
- **冷补全可刷新状态（`self.` 成员补全）** —— 映射索引首扫未完成时，`self.<前缀>` 补全回 `isIncomplete: true` 的空 CompletionList（编辑器继续输入会重查）而非终答 null；不记录任何永久 miss，索引落地后同前缀即得 def 声明成员；首扫完成后无 def 归属的 .py 仍回 null（真 miss 不虚报可刷新）——（证据：src/entityMapping.ts `isInitialScanComplete`；src/languageProviders.ts `PythonCompletionProvider` 冷分支）
- **调用链（Show Call Chain）** —— 从 .def/Python 实体方法出发沿 def 索引展开向外出调，默认深度 3，沿 `self.base/cell/client.<方法>()` 接收者调用跳到其他 def 声明方法，解析不到的目标画成开口节点；渲染为打包内嵌的离线 mermaid 图（默认 `graph`，无 CDN）或纯文本回落，面板内 tab 选择持久化到工作区状态并优先于设置项，图渲染失败自动回落文本并在面板头说明 ——（证据：package.json#contributes.commands `kbengine.python.showCallChain`；package.json#configuration `kbengine.python.callChainHints|callChainView`；src/defCallChain.ts `buildDefCallChain`/`renderDefCallChainMermaid`、src/defCallChainProvider.ts、src/defCallChainViewLogic.ts）
- **数据库表结构视图** —— 由 def 分析渲染实体/组件/ARRAY 子表结构的只读视图，支持属性→表跳转与 F12 ——（证据：package.json#contributes.commands `kbengine.database.open`；todo.md:124、todo.md:133；src/databaseSchema.ts）
- **SQL 模板** —— 每表全列 SELECT、属性列 SELECT 与子表 JOIN 语句，遵循可配置表名前缀 ——（证据：todo.md:126；package.json#configuration `kbengine.db.tablePrefix`；src/databaseSchema.ts `renderTableSqlLines`）
- **MySQL 漂移对比（只读）** —— 代码侧 schema 与真实库逐表逐列对比；报缺表/缺列/多列/型别不符，语句白名单 + 会话只读双保险 ——（证据：package.json#contributes.commands `kbengine.database.checkDrift|checkAllDrift`；todo.md:125；src/databaseDrift.ts）
- **按 profile 选择只读数据库连接（DB-001）** —— 连接配置与查询结果缓存都以 profileId 为主键隔离：切换项目读新 profile 自己的配置，绝不复用另一 profile 的连接（未选择过的 profile 如实 null 不回退邻居；配置解析失败记该 profile 无配置）；结果缓存同 SQL 各 profile 各存各的，TTL 过期与 clearProfile 只影响目标 profile；配置经注入 load/save 持久化（workspaceState 形）重启按 profile 独立读回，缓存为会话级不落盘——陈旧结果不冒充新查询 ——（证据：src/databaseConnectionRegistry.ts）
- **单表只读数据预览（DB-002）** —— 预览语句固定 `SELECT * FROM \`表\` LIMIT N` 形状，执行前再过 databaseDrift 现有 assertReadOnlyStatement 自证（双保险）；默认条数上限 100，显式上限不许超硬顶 1000；runner 无视 LIMIT 多回行时结果面裁到上限并标 truncated；表名只收标识符字符——反引号/空白/分号一律拒绝不拼进语句 ——（证据：src/databaseTablePreview.ts、src/databaseDrift.ts）
- **只读查询取消与超时（DB-003）** —— 慢查询到点立即返回 timeout/cancelled 态（不干等），连接释放等底层结算后 close 恰一次——慢查询结束等待并释放连接；轮询循环在结算/取消/超时任一成立即退，不滞留后台轮询；底层失败如实 failed 态带原错误、释放路径不跳过；close 失败经 released 暴露，不影响已定终态；时钟/打盹/取消探针全注入——快查询在一个宏任务边界内结算则零打盹 ——（证据：src/databaseQueryLifecycle.ts）
- **结果列关联回 def/type 声明（DB-004）** —— 查询结果列经虚拟 schema 字段描述符链接回声明处：已推导列带 def 声明处（filePath+line，点击定位面）与声明类型原文；描述符带 synthetic 标记的引擎结构列（id/sm_autoLoad 等）说明为合成列、无 def 声明处；schema 里找不到的列如实 unknown——不猜合成、不猜邻居表（表名匹配由调用方经 snapshot.tableIndex 取对表，本模块只认拿到的那张表） ——（证据：src/databaseColumnSource.ts、src/databaseSchema.ts）
- **单实体结构变更影响预览（DB-005）** —— 对该实体前后两代虚拟 schema 对比，列出新增/移除/类型变化列清单；纯计算模块零注入面零 IO——不存在执行 DDL 或写库的通路（预览只是清单，落地动作不在本模块）；类型判定以推导后的 mysql 型（typeLabel）为准，声明原文等价变化（别名）不产条目；引擎合成列不进影响面（def 变更不影响引擎结构列） ——（证据：src/databaseSchemaImpact.ts、src/databaseSchema.ts）
- **按引擎版本保存 drift 联验证据（DB-006）** —— 每条记录分开存两个面：实际查询面（真实 MySQL 查询所得；未连接为 null）与模拟 schema 面（虚拟表结构推导，对比基准侧）；结论分类不冒充——引擎版本 unknown 只给 unknown-version（不宣称兼容）、无实际查询只给 unverified（纯模拟不冒充实测）、实测无漂移才 compatible-verified、有漂移如实 drift-found；按引擎版本保存，同版本重录覆盖为最新一次，持久化经注入 load/save ——（证据：src/databaseDriftEvidence.ts）
- **数据库模拟与导出** —— 模拟表结构可导出 JSON/Markdown ——（证据：package.json#contributes.commands `kbengine.database.simulate|exportSimulation`；todo.md:71；src/databaseSimulator.ts）

## 类型桩与托管目录

- **KBEngine.pyi API 存根导出** —— 内置 KBEngine Python API 索引导出为存根供 Pylance 使用；激活期静默自动导出、内容一致零写、手动命令入口 ——（证据：package.json#configuration `kbengine.python.stubExport`；package.json#contributes.commands `kbengine.python.exportStubs`；todo.md:54；src/pythonStubExport.ts、src/kbeModuleIndex.ts）
- **kbe_types 分件 Python 类型桩** —— types.xml 自定义类型（FIXED_DICT→TypedDict、ARRAY、别名按依赖拓扑序发射）导出为分件 `.pyi` 并做别名解析 ——（证据：package.json#contributes.commands `kbengine.python.exportTypeStubs`；todo.md:37；commit c445f8a、bfaff30；src/pythonTypeStubs.ts）
- **types.xml 变更自动重生成桩** —— didChange/didCreate/didDelete 三事件静默重导出类型桩 ——（证据：todo.md:35；src/pythonTypeStubs.ts `setupTypeStubRegeneration`）
- **entity_types.pyi 实体桩** —— def 引用自定义类型的实体级类型声明，挂激活期与实体映射刷新 ——（证据：todo.md:136；src/entityTypeStubs.ts）
- **存根目录可配置** —— `kbengine.python.stubDir` 设置 > `KBENGINE_STUB_DIR` 环境变量 > 默认 `.kbengine/stubs`；用户已写的 `.pyi` 视为用户资产不覆盖 ——（证据：package.json#configuration `kbengine.python.stubDir`；todo.md:42；src/pythonStubExport.ts）
- **python.analysis.extraPaths 接线** —— 发现的 KBEngine scripts 根按 WorkspaceFolder 级写入；只管理自己那段，用户手填路径不动；管理段经 base/cell 角色隔离闸（角色目录永不进合并列表，base/Avatar.py 与 cell/Avatar.py 这类同名模块不会因 extraPaths 顺序跨角色误解析），手动同步时如实播报跨角色同名模块集合 ——（证据：package.json#configuration `kbengine.python.extraPathsSync`；package.json#contributes.commands `kbengine.python.syncExtraPaths`；src/pythonExtraPaths.ts `planPythonExtraPaths`；src/pythonRoleRoots.ts `enforceRoleIsolation`）
- **托管目录可配置** —— kode 自管目录（默认 `.kbengine`，容纳 debug.json 与存根）可经 `kbengine.managedDir` 改名，改名后自动重建 ——（证据：src/managedDir.ts；commit c69517e；src/extension.ts watcher）

## 调试与运行

- **快速执行动作（配置驱动）** —— `.kbengine/debug.json` 顶层 `quickActions` 定义 `command`/`script`/`http` 三类后端，从 Servers 视图标题栏与 def/Python/XML 编辑器标题栏触发 ——（证据：todo.md:86；package.json#contributes.commands `kbengine.quickActions.*`；src/quickActions.ts、src/quickActionConfig.ts）
- **首装脚本扫描** —— 一层 `.bat` 扫描把启停与导表脚本登记为快速动作，不动手工条目 ——（证据：package.json#contributes.commands `kbengine.quickActions.scanScripts`；todo.md:11、todo.md:86；src/quickActionScanner.ts）
- **debug.json 缺失自动生成** —— `.kbengine/debug.json` 缺失即生成带注释的 JSONC 骨架（`${workspaceFolder}` 示例 + 扫描出的 `quickActions`）；已有配置绝不覆盖 ——（证据：todo.md:40；src/debugConfigBootstrap.ts）
- **debug.json JSON Schema 校验** —— 为 `**/.kbengine/debug.json` 贡献内联 schema，必填字段直接在编辑器标红 ——（证据：package.json#contributes.jsonValidation；todo.md:53；src/debugJsonSchema.ts）
- **debug.json JSONC 关联** —— 文件是 JSONC（带注释，解析走 stripJsonComments），kode 自动把 `files.associations` 接成 `jsonc`，注释不再按 json 划红线；WorkspaceFolder 级只动自己键、已有值不覆盖，`kbengine.jsoncAssociation.off` 命令只回收本扩展写入的条目 ——（证据：package.json#configuration `kbengine.jsoncAssociation`；package.json#contributes.commands `kbengine.jsoncAssociation.off`；src/jsoncAssociation.ts）
- **自动热重载** —— 文件监视触发指定快速动作、带去抖，默认关 ——（证据：package.json#configuration `kbengine.hotReload.*`；todo.md:52；src/hotReload.ts）
- **热更状态栏（HR-UI-001）** —— 状态栏项跟踪监视状态机关→就绪→发送中→已发送(未确认)→失败，渲染节流合并；动作完成且无错只记「已发送(未确认)」（不校验业务回执、绝不声称已生效）；点击状态栏项打开「KBEngine 热更」审计日志（每次触发记 time/触发文件/去抖值/结果）——（证据：package.json#contributes.commands `kbengine.hotReload.showLog`；src/hotReloadStatus.ts、src/hotReload.ts）
- **热更状态按目标隔离（HOT-001）** —— 热更投递结果台账按「文件归属扫描根 rootId × 服务实例 targetId」双维隔离:同文件发给不同实例各自落各自的记录,后一个目标的成败既不覆盖也不复用前一个目标的绿色状态,查别的目标拿不到邻居的记录;同目标同文件重发覆盖为最新一次——这是回执面(HOT-002 起的 sent_unverified/accepted/applied)的地基,接线随回执面落地 ——（证据：src/hotReloadTargetState.ts）
- **HTTP 热更送达只记未确认（HOT-002）** —— 投递分类只认传输事实:2xx=已送达记 sent-unverified(绿色但明示应用层未证实),非 2xx/传输失败=failed 点名状态码或原因;回包 body 一律不作为应用证据(自称 applied/ok 也不升格),回执解读另立(HOT-003+);分类结果直接落 HOT-001 双维台账 ——（证据：src/hotReloadDelivery.ts、src/hotReloadTargetState.ts）
- **单目标 accepted 回执解析（HOT-003）** —— 已记录协议：JSON `{"status":"accepted","file":"<与所发文件逐字一致的回显>"}`（可选 `"targetId"` 给了就必须与目标一致；额外字段忽略，只认已记录字段）；只有逐字段符合契约才把该 (rootId,targetId,file) 记录升格 accepted——file 回显把回执钉住所发文件；未知结构（非 JSON/非对象/状态值不是 accepted）与其他状态值（applied 是 HOT-004 核验面、ok/queued 未记录）一律保留未确认，不猜不升格 ——（证据：src/hotReloadReceipt.ts、src/hotReloadTargetState.ts）
- **单目标 applied 核验（HOT-004）** —— applied 回执协议：JSON `{"status":"applied","file":"<逐字回显>","digest":"<所发内容的 sha256 hex>"}`；digest 用现成原语（node:crypto sha256）对所发内容重算比对，对得上才标 applied（可信 digest+已验证回执双证）；digest 缺失/不符/回执不合规一律保留原状态不升格；超时结算仍未确认的保持未确认（unconfirmed-timeout），不冒充失败也不冒充 applied；revision 证据标签语义另立（HOT-008），本级只认 digest ——（证据：src/hotReloadAppliedCheck.ts、src/hotReloadTargetState.ts）
- **结构性 def 变更标注（HOT-005）** —— 结构指纹双面：序列化面（Properties 段逐属性从其子元素取 `{Type,Flags}`+属性名集合）与 RPC 面（三方法段 BaseMethods/CellMethods/ClientMethods 逐方法的 Arg 类型签名+方法名集合）；指纹任一差异（属性增删/Type/Flags 变化、方法增删/签名变化）=结构性 → 标需重启、不作为普通 Python reload 自动发送；注释/空白/重排/描述文本/默认值不进指纹=非结构性，可走普通 reload 路径；任一侧解析失败保守按结构性（证明不了无结构变化就不自动发）；def 自动应用总闸随回执管道另行接线，本模块只做结构判定 ——（证据：src/hotReloadDefStructure.ts、src/defParser.ts）
- **按目标聚合部分成功结果（HOT-006）** —— 在投递台账上跨目标归并:目标级状态=名下最差文件记录(任一 failed 即 failed,否则任一 sent-unverified 即 sent-unverified,再否则任一 accepted 即 accepted,全 applied 才 applied——同目标绿灯文件不盖红灯文件);批次状态=全部 failed→all-failed、有败有成→partial、无败→all-succeeded、无记录→no-targets;每目标 reason 为逐文件 `文件 → 状态(明细)` 串,两个目标一成一败显示 partial 且各自原因可查;成功=发出面口径,sent-unverified 不冒充 applied ——（证据：src/hotReloadBatchSummary.ts、src/hotReloadTargetState.ts）
- **只重试失败目标（HOT-007）** —— 重试遍历批次聚合（HOT-006）的目标，只对 outcome=failed 的目标重新发送；已确认成功侧（applied/accepted/sent-unverified，均已发出）不重复发送——重发=重复投递同文件；每跳发起前探针取消，取消后停止后续发送：已完成的动作保留，未发起的标 skipped-cancelled 不冒充已发；发送器注入，本模块不碰台账——重发后的结果落账走 HOT-002..004 既有面 ——（证据：src/hotReloadRetry.ts、src/hotReloadBatchSummary.ts）
- **运行时 revision 证据来源标签（HOT-008）** —— 三类证据各带来源标签：fileHash（本地对文件内容重算的哈希）/semanticHash（结构语义指纹）/engineDigest（运行时回执报告），不共用笼统说法；单条展示=标签+截断值+来源；比对只限同类：跨类一律 incomparable，fileHash 与 engineDigest 值巧合相同也不判一致（本地哈希不冒充运行时证据）；证据集合报告只列实际提供的种类，缺的种类不填空不冒充 ——（证据：src/hotReloadRevisionEvidence.ts）
- **真实引擎联验输入登记（LIV-001）** —— 联验所需输入三段清单：目标版本（kbengine 仓 URL+ref）、组件地址（组件名词用现成 COMPONENT_NAMES——machine 广播口、空间列表查询的 cellappmgr、watcher 路径查询的 cellapp/baseapp）、启动条件（demo 服务端启动组件互相发现、可登录的 demo 账号）；默认登记=全未登记+缺实例，状态文案明确「缺实例:未测」，绝不冒充已执行的联验；登记为纯函数合并，原登记对象不变；lastVerifiedAt 为联验后回填位 ——（证据：src/liveValidationInputs.ts、src/kbengineProtocol.ts）
- **watcher 协议号钉版本核对（LIV-002）** —— 逐条核对记录把 watcher 协议号钉到具体引擎版本 kbengine@f85ad81（本机仓核对）：每个请求号引据 kbe/res/server/messages_fixed_defaults.xml 的 `<组件::queryWatcher><id>N` 段（dbmgr 41006、loginapp 41003、baseappmgr 41004、cellappmgr 41005、cellapp 41002、baseapp 41001、logger 41008、interfaces 41007），回包号 65502 引据 kbe/src/lib/helper/console_helper.h:11 的 CONSOLE_WATCHERCB_MSGID；verify 函数把审计表与生产映射逐条咬合——缺键/多键/错号都按组件点名，任何一侧漂移即红，不沿用未验证常量 ——（证据：src/watcherProtocolAudit.ts、src/kbengineProtocol.ts）
- **调试/启动配置** —— 启动调试、本地/远程附加（debugpy connect）、生成/更新 launch.json ——（证据：package.json#contributes.commands `kbengine.debug.start|attach|attachRemote|createConfig|updateLaunchJson`；package.json#configuration `kbengine.debug.remoteTargets`；src/debugConfig.ts）
- **启动即 attach（autoDebugpy）** —— `kbengine.debug.autoDebugpy` 开时，启动成功且开了 telnet 的组件经其 `:python` 层注入 `debugpy.listen`（自建短命客户端，逐组件端口 5678-5682，单组件失败只记日志）；注入前先对所选解释器（`kbengine.python.interpreterPath` → PATH 链）做 debugpy 预检——缺解释器/缺包/版本过老提前给可操作状态，不等注入阶段才报未知失败，资产树已同步过包则照常注入；命名实例（同组件多开）从该组件 8 槽端口窗口（baseapp 5700 / cellapp 5708 / loginapp 5716 / dbmgr 5724 / logger 5732，首闲分配）各取一个独立口，同组件命名实例超过 8 个记 warning 跳过，`Update launch.json` 除每组件一条外再为每个运行中的命名实例生成一条 `component#实例` attach 配置指向其独立口；`kbengine.python.debugpySync` 从同一解释器链取 debugpy（≥1.8.0 版本闸对内嵌 Python 3.12.13）复制进 `<assets>/scripts/common/debugpy`（引擎模块搜索路径第一位）；显式 opt-in 的启动等待模式（`kbengine.debug.waitAtStartup`，on/off 命令）在入口脚本 `scripts/kbengine.py` 顶部插入带标记的 `listen` + `wait_for_client` 引导块，组件停在早期断点之前、不依赖 telnet 注入；调试会话按条目名（默认实例表条目与 `component#实例` 条目）挂回运行目标，两个 cellapp 的会话与进程状态各自可辨；会话结束时由 `kbengine.debug.sessionEndBehavior` 决定善后——`detach`（默认）进程照跑、其他实例不动，`stop-process` 只停该会话自己的那个目标；两个附加入口（Attach to Component / Attach to Remote Component）都在截止闸与可取消的进度通知下运行（`kbengine.debug.attachTimeoutMs`，默认 15 秒）——无人监听的端口到点即停不再永久等待，取消与超时都不重试；Debug Targets 视图逐运行目标一行展示四态——未注入 / 监听（带 debugpy 端口）/ 已附加（带会话数）/ 失败（带失败细节），注入回报、会话起止、进程变化三面刷新，点击行（`kbengine.debug.focusTarget`）已附加时打开 Run and Debug 视图定位会话、其余态如实提示 ——（证据：package.json#configuration `kbengine.debug.autoDebugpy`、`kbengine.debug.waitAtStartup`、`kbengine.debug.sessionEndBehavior`、`kbengine.debug.attachTimeoutMs`；package.json#contributes.commands `kbengine.python.debugpySync`、`kbengine.debug.waitAtStartup.on/off`、`kbengine.debug.focusTarget`；package.json#contributes.views `kbengine.debugTargets`；src/autoDebugpy.ts、src/debugpyPreflight.ts、src/debugpyWaitAtStartup.ts、src/debugSessionRegistry.ts、src/debugAttachGuard.ts、src/debugStatusBoard.ts、src/debugStatusTree.ts、src/debugConfig.ts）
- **按 profile 派生构建任务描述（TSK-001）** —— 活动 profile（assets 根 + 解释器）派生一条脚本编译检查任务，四要素齐全：`<解释器> -m compileall -q <assets>/scripts`、cwd=`<assets>`、env=`PYTHONUTF8=1`；profile 未选解释器回退 PATH 上的 `python3` 且预览里如实标注，`kbengine.build.previewTask` 展示完整命令行（含空格路径按 shell 拆词加引号）、目录与环境——所见即所跑 ；同一描述注册为 TaskProvider——Run Task 任务列表逐 profile 出一条构建项（源 `kode`），tasks.json 手写的 `kbengine.build` 条目按 `profileId` 反解（未知 id 如实解析不出），，执行走原生 ProcessExecution——任务面板取消即终止该次执行；构建错误落到源码：贡献的 `$kbengine-compileall` problem matcher 同时解析 compileall 两种错误格式（旧版单行 `in file … on line` 与 3.13+ 多行 traceback，按真 python3 实跑核对）为文件+行问题 ——（证据：package.json#contributes.commands `kbengine.build.previewTask`；package.json#contributes.problemMatchers `kbengine-compileall`；src/buildTaskSpec.ts、src/buildTaskProvider.ts、src/buildProblemMatcher.ts）
- **项目 Python 测试发现（TSK-004）** —— 项目声明的 Python 测试只在所选 profile 范围内发现：递归扫 `<assets>/scripts` 收 `test_*.py` / `*_test.py`（pytest/unittest 通用命名），工作区里其他 `*_assets` 根与引擎仓是依赖库，结构性不进清单（发现只从 profile 的 scripts 根起步，不接收别的入口）；隐藏目录与 `__pycache__` 跳过，文件内静态可见的用例（`def test_*` 函数、`class Test*` 方法，带行号列号）解析入列表；`kbengine.tests.list` 以 QuickPick 展示测试文件（用例数+用例名）并打开选中文件 ——（证据：package.json#contributes.commands `kbengine.tests.list`；src/pythonTestDiscovery.ts）
- **测试面板跑单个测试（TSK-005）** —— 发现面落成测试面板的测试控制器：逐 `test_*.py` 文件一条目、静态可见用例为子条目，子条目 range 指向发现的行号列号（结果与源码位置对应）；Run 档逐所选用例以 profile 解释器执行 `<解释器> -m pytest <file>::<case> -v --tb=line -p no:cacheprovider`（cwd=profile 的 scripts 根，不在 scripts 根落 `.pytest_cache`）——逐测试输出进面板、失败带 short summary 消息、解释器没有 pytest 如实报 errored 不冒充测试失败、取消在下一测试发起前拦截（未跑的条目标跳过）；跑一次 `kbengine.tests.list` 同步刷新面板树。测试 API 门槛：VS Code ≥1.61 ——（证据：src/pythonTestRunner.ts、src/extension.ts `kbengine-python-tests` 控制器）
- **可重复运行的任务上下文（TSK-006）** —— 重跑钉住已保存的上下文,绝不悄然换根:测试面板首跑把 profile 身份与环境(profile id、assets 根、引擎根、解释器+来源)快照进 workspace 状态,之后每次重跑都按快照执行——活动 profile 切换或 profile 字段编辑只出提示(重跑仍用已保存上下文),盘上根/解释器消失如实拒绝并点名路径,换根唯一显式入口=再跑一次 `kbengine.tests.list` 重新捕获;无解释器的上下文按构建任务同一回退规则(PATH 上的 `python3`)且回退如实标注 ——（证据：src/taskContext.ts、src/extension.ts 运行档与 `kbengine.tests.list` 刷新）
- **服务生命周期** —— 按自动启动列表（默认 machine/logger/dbmgr）启停组件，统一走 ProcessManager；同组件多实例用 `targetId` 区分（IDE-RUN-001），两个 cellapp 可分别登记和停止，进程记录互不覆盖，默认实例登记键保持纯组件名；就绪判定用真实探针（IDE-RUN-003）：配置开了 telnet 的组件以其目标端口做 TCP 连通探针，探针通过才推进 Running，固定 1 秒经过但服务不可用时保持 Starting，未开 telnet 的组件不猜端口、如实回落固定宽限期；就绪等待支持超时与取消（IDE-RUN-004）：默认 60 秒上限，超时/取消后停止等待并点名对应 target（保持 Starting、绝不误标 Running，等待放弃是终态——此后服务就绪也不再翻牌），停止组件即取消其就绪等待；停止按进程树清理（IDE-RUN-007）：POSIX 组件以进程组长启动（detached/setsid），停止时负 pid 组信号杀全组，Windows 用 `taskkill /PID /T /F` 递归终止进程树，组件派生的孙进程停止后不残留，升级击杀（SIGTERM 5 秒后 SIGKILL）与 dispose 同样走进程树；启动项声明直接依赖（IDE-RUN-005）：`ServerComponent.dependsOn` 声明机台为根的标准链（machine→logger/interfaces/dbmgr→appmgr→app→loginapp→bots），`resolveLaunchOrder` 拓扑排序并检测环（报出环路径，自依赖即一元环），依赖就绪唯一判据=在册且 Running（Starting/缺席/放弃等待都不算成功）；`startTargetGroup` 按依赖就绪顺序启动一组目标（IDE-RUN-006）：先拓扑定序（环→零启动），逐目标等依赖就绪才启动，前置失败（退出/放弃等待/启动失败/组内跳过）时依赖它的后续启动不继续、失败沿组传染，组外依赖等到上限（默认 60 秒）；启动失败可单目标重试（IDE-RUN-008）：`retryTarget` 只作用失败 target，在册目标如实报 `already-running` 不重启，已就绪的其他实例不在重试面内（pid 与记录不变）——（证据：package.json#contributes.commands `kbengine.server.start|stop|restart`；package.json#configuration `kbengine.autoStart`；todo.md:148、todo.md:428、todo.md:430-432；src/processManager.ts 的 ProcessReadiness 轮询+timeout/cancelHandle/onGiveUp、src/serverManager.ts 的 createComponentReadinessProbe/buildServerKey/parseServerKey/dependsOn、src/launchDependencies.ts）
- **Telnet 面板** —— 元件 telnet 探测、密码握手、增量输出 webview、命令白名单（`:quit` 恒拒）、断开快捷键 ——（证据：package.json#contributes.commands `kbengine.telnet.*`；package.json#contributes.keybindings；package.json#configuration `kbengine.telnet.*`；todo.md:117；src/telnetService.ts、src/telnetClient.ts）
- **HTTP 快捷请求** —— 可配置请求列表，`${module}` 模板变量按 `__init__.py` 包边界解析 ——（证据：package.json#contributes.commands `kbengine.httpRequest.run|httpRequests.run`；package.json#configuration `kbengine.httpRequests`；src/httpRequests.ts、src/httpRequestService.ts）
- **配置发现与最终配置视图** —— 引擎配置自动发现（约定路径/记忆/深扫描），合成只读 `kbengine-final.xml` 视图并自动刷新 ——（证据：package.json#contributes.commands `kbengine.config.showFinal|kbengine.discovery.report`；package.json#configuration `kbengine.showFinalConfigOnOpen|autoRefreshFinalConfig`；todo.md:73、todo.md:76、todo.md:77；src/workspaceDiscovery.ts、src/serverConfigMerge.ts）
- **VS Code 官方变量替换** —— `${workspaceFolder}`、`${env:NAME}` 等由同一实现统一解析，覆盖配置路径与快速动作 ——（证据：todo.md:39；src/variableSubstitution.ts）

## 监控与 SDK

- **服务器监控面板** —— webview 可视化服务器性能与状态指标 ——（证据：package.json#contributes.commands `kbengine.monitoring.show`；src/monitoringCollector.ts、src/monitoringWebView.ts）
- **日志查看器与收集器** —— 日志 webview、启动自动连接、清除/导出、增量合批推送带上限 ——（证据：package.json#contributes.commands `kbengine.logs.showViewer|connect|disconnect|clear|export`；package.json#configuration `kbengine.logAutoConnect|maxLogEntries|loggerPort`；src/logHub.ts、src/logWebView.ts、src/logCollector.ts）
- **原始日志 ERROR 扫描** —— 选文件/文件夹按「组件+归一签名」聚合 ERROR/CRITICAL，点击行开源文件定位 ——（证据：package.json#contributes.commands `kbengine.logs.scanErrors`；todo.md:51；src/logErrorScan.ts）
- **客户端实体 SDK 生成** —— 按 entities.xml 登记序生成 TypeScript 与 C# 客户端 SDK，只收客户端可见属性、FIXED_DICT 伴随文件、默认不覆盖 ——（证据：package.json#contributes.commands `kbengine.clientSdk.generate`；package.json#configuration `kbengine.clientSdk.outputDir`；todo.md:50；src/clientSdkGenerator.ts）
- **实体依赖图** —— 继承/引用依赖图，继承边认文本形态 Parent ——（证据：package.json#contributes.commands `kbengine.dependency.show`；todo.md:68；src/entityDependency.ts、src/entityDependencyWebView.ts）
- **def 架构流程图** —— webview 呈现 client→base/cell 方法调用与属性同步，可导出 Markdown/SVG/PNG ——（证据：package.json#contributes.commands `kbengine.flow.show`；todo.md:60；src/entityFlowGraph.ts、src/entityFlowWebView.ts）
- **网络包结构生成** —— 模拟消息/包结构并报 aliasID 占号与冲突，机读 JSON + 人读 Markdown 双产出 ——（证据：todo.md:72；src/messageTable.ts、src/kbengineProtocol.ts）
- **发现与定位报告** —— 按需与激活时自动出发现/定位报告，整段可复制 ——（证据：package.json#contributes.commands `kbengine.discovery.report`；todo.md:76）

## 编辑器基础

- **types.xml 注入语法** —— 向 XML 注入语义着色：内置类型、自定义类型引用、ARRAY/FIXED_DICT 关键字与 implementedBy 值 ——（证据：package.json#contributes.grammars（`injectTo: ["text.xml"]`）；todo.md:102）
- **kbengine-def / xml / python 片段** —— 各语言内置片段清单 ——（证据：package.json#contributes.snippets；snippets/）
- **选区生成片段** —— 把编辑器选区文本转成工作区级自定义片段文件 ——（证据：package.json#contributes.commands `kbengine.snippets.generateFromSelection`；src/snippetGenerator.ts）
- **11 套 KBEngine 配色主题** —— Monokai、One Dark、Dracula、GitHub Light、Solarized Light/Dark、Nord、Gruvbox Dark、Catppuccin Mocha、VS Dark+/Light+ ——（证据：package.json#contributes.themes）
- **KBEngine Explorer 活动栏** —— 专属视图容器与实体/资源树 provider ——（证据：package.json#contributes.viewsContainers、package.json#contributes.views；src/explorerProviders.ts）
- **def/Python 代码生成器** —— 模板化生成 .def + Python 骨架并登记 entities.xml（entities.xml 在编辑器有未保存修改时，注册写入以缓冲区当前文本为基底，不覆盖用户未保存的注册）；目标 .def 或同名 Python 实现文件已存在时拒绝覆盖（保留原字节并报出冲突路径）；落盘前预检全部目标，任一冲突即整体中止，不写半套文件；随后展示生成计划预览（def/Python 准确路径与 entities.xml 注册行），确认后才落盘；生成器写盘一律原子落位（临时文件+rename），写入中断时旧文件保持完整、不留半截文本；多文件生成任一步失败时回收本次新增文件与 entities.xml 注册项，不留半套——向导与模板两个入口同守；选择了活动 profile 时，预览与写入路径都按所选 profile 的资产根解析（共享发现链以资产根为基，布局未识别回落 `<资产根>/scripts` 约定；路径项不回落设置链——profile 是权威输入），profile 切换即时重载输出配置，预览打开期间发生切换则旧预览作废：按新根重算计划并要求重新确认，绝不沿旧预览的路径落盘——（证据：package.json#contributes.commands `kbengine.generator.wizard|templates`；package.json#configuration `kbengine.generator.*`；src/codeGenerator.ts `generateDefFile`/`loadConfig`/`confirmGenerationPlan`、src/generatorForms.ts）
- **形态向导** —— 一次生成代理/空间/组件/固定字典骨架；与实体向导遵守同一写入策略（目标冲突整体不写、确认前计划预览、原子落位、失败回收本次新增与改写）；有活动 profile 时落盘布局按其资产根解析，预览打开期间 profile 切换同样作废重算（重算计划、重新确认）——（证据：package.json#contributes.commands `kbengine.generator.formWizard`；src/generatorForms.ts `generateGeneratorForm`/`runGeneratorFormWizard`、src/generationConfirm.ts）
- **def 重命名** —— 重命名 provider 跨 def 文件解析链接路径；目标名与同段方法或属性/组件冲突时拒绝并说明冲突位置；跨文件编辑按各文件当前文本（经 `readSharedFileSnapshot` 优先取打开文档缓冲区）计算，不用过期磁盘偏移；一次手势内记录输入版本引用，目标文档版本漂移即拒绝（跨文件漂移则重算），不套用旧范围；属性重命名同时改写已解析的 `self.<属性>` 访问，方法重命名改写 receiver 段与声明段一致的 `self.<receiver>.<方法>(` 调用（owner 注册面判定归属），无关实体同名（歧义）访问不猜测改写 ——（证据：src/defRenamer.ts `findDefRenameConflict`/`computeDefRenameEdits` `readCrossFileContent`/`renameInputsDrifted`；src/languageProviders.ts `KBEngineRenameProvider`；src/entityMapping.ts `getIncomingPythonPropertyAccesses`/`getIncomingPythonReceiverCalls`）
- **调用层级** —— def 与 Python 符号的 prepare/callers/callees；def 方法 prepare 与 F12 走同一解析链（identity 绑定/属主+全局唯一回退 → def 相对约定链，`resolveDefMethodPythonTarget`），相同 RPC/mixin 方法在两种入口根到同一目标；无 python 目标时层次如实 null，不借 F12 的注册声明展示回落 ——（证据：src/languageProviders.ts `KBEngineCallHierarchyProvider`、`resolveDefMethodPythonTarget`）
- **实现查询（Go to Implementations，def 方法）** —— def 方法声明按精确符号身份出实现列表（属主绑定与段属主脚本；不含全项目名字猜测回退）——（证据：src/entityMapping.ts `listMethodImplementationsByIdentity`；src/languageProviders.ts `KBEngineImplementationProvider`）
- **工作区符号（Ctrl+T）** —— 已索引 def 符号按名称前缀跨 root 查询，返回 root/段容器信息，查询不触发全仓扫描 ——（证据：src/entityMapping.ts `searchDefSymbolsByPrefix`；src/languageProviders.ts `KBEngineWorkspaceSymbolProvider`）
- **def 文档符号（Outline）** —— Properties 与三方法段作容器，段内声明作子符号，范围精确到元素全跨度 ——（证据：src/languageProviders.ts `KBEngineDocumentSymbolProvider`）
- **def 引用查询（Shift+F12）** —— def 属性/方法引用按 owner 注册面归属：属性 `self` 访问、方法调用经统一符号身份链、receiver RPC 调用（`self.cell.X` / `self.base.X` / `self.client.X`）按段分开统计；结果跟随未保存缓冲区（打开文档快照优先、磁盘兜底）——（证据：src/languageProviders.ts `KBEngineReferencesProvider`；src/entityMapping.ts `getIncomingPythonMethodCalls`）

## 项目模型

- **项目 profile 身份存储** —— 同一工作区里每套 assets/engine 组合保存为独立 profile，持有持久稳定 ID（创建时一次分配，按工作区存于 `workspaceState`，重启后照旧读回）；显示名只是可变字段——改名或两条同名互不吞并、不丢身份；根路径按 profile 保存（`saveRoots` 只动目标记录的路径字段，重存一条 profile 的 assets/engine 根不会串写另一条，重启后两条各自独立读回）——（证据：src/projectProfiles.ts `ProjectProfileStore`）
- **活动 profile 选择** —— 活动 profile 按稳定 ID 记忆（workspaceState），显示名改名不丢选择；每次真实切换（新 ID ≠ 旧 ID）恰发一次切换事件供其他功能订阅，重选同条不发；未知 ID 拒绝，选择对应的记录被删除后如实解析为 null——（证据：package.json#contributes.commands `kbengine.project.selectActive`；src/activeProfile.ts `setActiveProfile`/`onDidChangeActiveProfile`）
- **profile 健康汇总** —— 活动 profile 的健康按四类问题汇总（根歧义=资产根不在盘、缺引擎=引擎根未记录或不在盘、缺解释器=未记录或不在盘、缺语言服务=PRJ-005 判定非已激活），每类各带自己的定位入口（重导入命令 / 解释器设置 / 语言服务状态命令）；全部健康一条消息收场，有问题开选择器、选中一行跳对应入口——（证据：package.json#contributes.commands `kbengine.profile.health`；src/profileHealth.ts `collectProfileHealth`/`showProfileHealthSummary`）
- **语言索引响应 profile 切换** —— 活动 profile 的资产根成为索引输入（优先于 `kbengine.assetsRoot` 设置与自动发现；选定根不在盘时如实落空走原链）；切换时旧外部根从各索引定向摘除（SNP-009 摘除路径），根配置 generation 前进——旧 profile 起步的在途扫描批次经代闸不再写入当前快照，新输入由新扫描重建——（证据：src/scanRoots.ts `setActiveProfileScanRoot`；src/entityMapping.ts `performScanEntityMappings` 代闸；extension.ts `onDidChangeActiveProfile` 接线）
- **启动响应活动 profile** —— 下一次启动按活动 profile 解析引擎与配置根：engineRoot 推导 `kbe/bin/server` 作 bin 路径、assetsRoot 作配置根（优先于 `kbengine.binPath`/`kbengine.assetsRoot` 设置与自动发现；字段为空时该项如实回落设置链；profile 的配置根是权威输入，探针未通过也不静默回落工作区发现）；解析在启动时按稳定 ID 读（不缓存，切换无需重新接线），每个在册实例快照记录它实际启动时的 bin/配置根与 profile ID——切换 profile 不改动已运行实例的记录、pid 与进程本体；同键在册时再启动仍拒绝（已在运行），所选 profile 自下一次启动起生效——（证据：src/serverManager.ts `getActiveProfileLaunchRoots`；src/serverManager.ts `RunningServer.binPath`/`configPath`/`profileId`）
- **现有项目导入** —— 选择资产根后按同一约定链识别 entities/defs/scripts/engine 四面（未命中的面如实预览「未识别」），预览清单逐面列出识别结果，选「导入」确认才建立 profile；任一步取消零写入，四面全空的目录直接拒绝不出预览 ——（证据：package.json#contributes.commands `kbengine.project.import`；src/projectImport.ts `identifyProjectLayout`/`importExistingProject`）
- **按 profile 记录解释器来源** —— 每个 profile 记录用哪个 Python 解释器、来自哪里（`kbengine.python.interpreterPath` 设置存在才采用，否则定位 PATH 里的 python3/python，再没有如实记缺失状态，绝不伪造路径）；导入确认消息内联显示解释器状态，早于此字段存在的旧记录读回时归一为缺失而不是被丢弃——（证据：src/profileInterpreter.ts `resolveInterpreterWith`/`describeInterpreterState`；src/projectProfiles.ts `saveInterpreter`）
- **Python 语言服务可用性检查** —— 按 `ms-python.vscode-pylance` 的注册/激活/安装目录证据报告未安装／未启用／已激活三态；extraPaths 写入绝不计为可用，只附明确警示——（证据：package.json#contributes.commands `kbengine.python.serviceStatus`；src/pythonLanguageServiceStatus.ts `classifyPythonService`）
- **最小项目创建模板** —— 一份固定清单明确列出新建空 KBEngine 项目要落的每个目录和文件（相对路径逐条、文件内容齐备，scripts 布局与共享发现约定对齐，建出的骨架可被导入识别）；创建预检逐条探测目标路径——任一目标已存在即按准确路径上报冲突，预览每条一行给准确绝对路径——（证据：src/projectTemplate.ts `MINIMAL_PROJECT_TEMPLATE`/`planProjectCreation`/`buildProjectCreationPreviewItems`）；创建命令把清单接到盘面并全程继承生成器保护——预览前冲突即拒、与生成器共用的确认 QuickPick、文件原子写、失败回收本次全部新增，成功后走与导入同一识别链建档——（证据：package.json#contributes.commands `kbengine.project.create`；src/projectCreate.ts `createMinimalProject`）

## 设置项

全部扩展设置（证据：package.json#contributes.configuration 为已贡献键；src/managedDir.ts 为运行时读取键）。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `kbengine.db.tablePrefix` | `""` | 数据库表名前缀（空 = 引擎默认 tbl_）；schema 视图与 SQL 模板同源替换 |
| `kbengine.enableDiagnostics` | `true` | KBEngine 实时诊断总开关 |
| `kbengine.enableStructureDiagnostics` | `true` | 结构化 .def 校验（重复定义、标签位置、缺失字段） |
| `kbengine.receiverNoneDiagnostics` | `true` | Python 侧 Warning：无判空的 `self.cell`/`self.base`/`self.client` 引用与 `.def` 段错配 |
| `kbengine.diagnostics.checkUnknownTypes` | `true` | 诊断未知 KBEngine 类型 |
| `kbengine.diagnostics.checkUnknownFlags` | `true` | 诊断未知 Flags 取值 |
| `kbengine.diagnostics.checkUnknownDetailLevels` | `true` | 诊断未知 DetailLevel 取值 |
| `kbengine.diagnostics.checkDuplicateDefinitions` | `true` | 诊断属性/方法重复定义 |
| `kbengine.diagnostics.checkMissingPropertyFields` | `true` | 诊断属性缺 Type/Flags 或重复定义字段 |
| `kbengine.hover.showTagDocs` | `true` | 悬停显示 .def 标签说明 |
| `kbengine.hover.showValueDocs` | `true` | 悬停显示类型/Flags/DetailLevel 取值说明 |
| `kbengine.hover.showSymbolDocs` | `true` | 悬停显示自定义属性/方法名摘要 |
| `kbengine.hover.returnTypeInference` | `true` | 悬停时根据 Python 返回注解推导局部变量类型 |
| `kbengine.hover.typeStorage` | `true` | 悬停显示 types.xml 自定义类型落库信息 |
| `kbengine.hover.implementedBy` | `true` | 悬停显示 def 方法的脚本实现位置（Implemented-By 反链） |
| `kbengine.hover.entityRegistration` | `true` | 悬停显示 entities.xml 注册信息（Utype/清单位置） |
| `kbengine.hover.defChain` | `true` | 悬停显示 def 属性/方法声明链（文件与区块来源） |
| `kbengine.hover.eventStats` | `true` | 悬停显示事件常量注册/监听统计 |
| `kbengine.hover.serverConfig` | `true` | 悬停显示 kbengine.xml 服务配置取值与说明 |
| `kbengine.hover.asyncBudgetMs` | `2500` | 悬停 def 方法 / 接收者调用 / 内建属性三条异步链的总预算（毫秒）；超预算截断该层不再永转，超时行写 LogHub（`[kode-hover][timeout]`）；`<= 0` 关闸（src/hoverBudget.ts、src/languageProviders.ts） |
| `kbengine.codeLens.rpc` | `true` | Python 实现脚本中 def 声明方法的 RPC 标记 CodeLens |
| `kbengine.codeLens.eventCallbacks` | `true` | Python 脚本中事件回调/订阅 CodeLens |
| `kbengine.codeLens.property` | `true` | `self.<属性>` 访问处属性 CodeLens（回跳 def） |
| `kbengine.codeLens.typesXml` | `true` | types.xml 类型声明行落库镜链 CodeLens（引用反扫） |
| `kbengine.inlayHints.typeData` | `true` | `self.<属性>` 访问处内联显示 def 声明的 types.xml 数据类型;`self.base/cell/client` RPC 调用点内联显示 def 已声明的形参类型 |
| `kbengine.inlayHints.defParams` | `true` | entity 脚本区块内 def 未标注形参内联 def 声明的 `<Arg>` 类型;声明 `<ReturnType>` 时内联 `-> 类型` |
| `kbengine.entityDefsPath` | `"scripts/entity_defs"` | 实体定义文件默认路径 |
| `kbengine.entitiesXmlPath` | `"scripts/entities.xml"` | entities.xml 默认路径 |
| `kbengine.binPath` | `"${workspaceFolder}/../kbe/bin/server"` | KBEngine 服务端二进制路径；支持 ${workspaceFolder} 与 ${env:VAR} |
| `kbengine.assetsRoot` | `""` | KBEngine 资产根（其下应有 res/server/kbengine.xml 与 scripts/）；留空走约定路径与深扫描自动发现 |
| `kbengine.jumpLog` | `false` | 跳转决策路径日志打到 KBEngine Navigation 输出通道（关 = 零开销） |
| `kbengine.showFinalConfigOnOpen` | `true` | 激活期能定位引擎默认配置时自动打开合成的只读最终配置视图 |
| `kbengine.autoRefreshFinalConfig` | `true` | 引擎/元件 kbengine.xml 变更后自动重算并刷新已打开的最终配置视图 |
| `kbengine.debug.remoteTargets` | `[]` | 「Attach to Remote Component」的远程调试目标列表（debugpy connect；条目带成对 `localRoot`/`remoteRoot` 时写入该 pathMappings，半配或未配保持省略） |
| `kbengine.jsoncAssociation` | `true` | 自动把 debug.json 的 glob 键写成 `jsonc` 写进工作区 `files.associations`（WorkspaceFolder 级；只动自己键、已有值不覆盖；`kbengine.jsoncAssociation.off` 回收本扩展写入的条目） |
| `kbengine.debug.autoDebugpy` | `false` | 组件启动后经其 telnet `:python` 层注入 `debugpy.listen`（端口 baseapp 5678/cellapp 5679/loginapp 5680/dbmgr 5681/logger 5682，只绑 127.0.0.1；命名实例从每组件 8 槽窗口（5700 起）取独立口；单组件失败只记日志不阻塞启动；注入走 telnet，早期断点由启动等待模式覆盖） |
| `kbengine.debug.waitAtStartup` | `false` | 显式 opt-in 的启动等待：入口脚本 `scripts/kbengine.py` 顶部的带标记引导块在最早 Python 处执行 `debugpy.listen` + `wait_for_client()`（表内组件默认实例，表口经 `KODE_DEBUGPY_WAIT_PORT` 下发），停在早期断点之前、不依赖 telnet 注入；on/off 命令插块/删块逐字节还原；无环境变量或无包静默放行 |
| `kbengine.debug.sessionEndBehavior` | `"detach"` | 调试会话结束时的行为：`detach`（默认）进程照跑、其他实例一律不动；`stop-process` 只停该会话附加的那个目标，按组件+实例精确定位（仅对扩展生成的 attach 条目生效，用户会话不受影响） |
| `kbengine.debug.attachTimeoutMs` | `15000` | 附加调试的截止毫秒数：无人监听的端口到点即停（可取消的进度通知，本次不重试）；`0`/负值不限时 |
| `kbengine.autoStart` | `["machine","logger","dbmgr"]` | 自动启动的组件列表 |
| `kbengine.loggerPort` | `20022` | KBEngine Logger 端口（默认 20022） |
| `kbengine.logAutoConnect` | `true` | 启动服务器时自动连接日志收集器 |
| `kbengine.maxLogEntries` | `10000` | 最大日志条目数 |
| `kbengine.webviewConsoleLogs` | `true` | 把 Logs 面板页面的 console 输出与未捕获异常收进 LogHub（src/webviewConsoleBridge.ts） |
| `kbengine.generator.defOutputPath` | `"scripts/entity_defs"` | 代码生成器：.def 输出目录 |
| `kbengine.generator.pythonOutputPath` | `"scripts"` | 代码生成器：Python 输出目录 |
| `kbengine.generator.generatePython` | `true` | 代码生成器：是否同时生成 Python 文件 |
| `kbengine.generator.registerInEntitiesXml` | `true` | 代码生成器：是否在 entities.xml 自动注册实体 |
| `kbengine.clientSdk.outputDir` | `"scripts/client_entities"` | 客户端实体 SDK 输出目录（相对工作区根；语言在命令内选择；默认不覆盖） |
| `kbengine.telnet.host` | `"127.0.0.1"` | telnet 探测目标主机 |
| `kbengine.telnet.port` | `0` | telnet 探测端口（0 = 回落元件 kbengine.xml `<telnet_service>`；设置与引擎配置都未开 telnet 时不展示） |
| `kbengine.telnet.password` | `""` | telnet 登录密码（仅握手用、不写日志；按元件/引擎默认配置回落；都没有则状态停在「端口开·未配密码」） |
| `kbengine.telnet.enableCommands` | `[]` | telnet 面板可发送命令白名单（精确或前缀匹配；`:quit` 恒拒） |
| `kbengine.telnet.configXmlPath` | `""` | 可选：元件 kbengine.xml 路径，作 telnet 端口/密码回落（支持 ${workspaceFolder}） |
| `kbengine.telnet.probeIntervalSeconds` | `5` | telnet 端口探测轮询间隔（秒，低频） |
| `kbengine.httpRequests` | （含一条热更示例） | HTTP 快捷请求列表；`${module}` 按 `__init__.py` 包边界解析 |
| `kbengine.python.interpreterPath` | `""` | Python 解释器路径，项目 profile 连来源一并记录（本设置存在才采用，否则取 PATH 的 python3/python，再没有记缺失状态） |
| `kbengine.python.extraPathsSync` | `true` | 自动把发现的 KBEngine scripts 根写入 python.analysis.extraPaths（只管自己那段） |
| `kbengine.python.stubExport` | `true` | 自动把内置 KBEngine Python API 索引导出为 KBEngine.pyi 存根 |
| `kbengine.python.stubDir` | `""` | `.pyi` 存根目录（空 = 自管默认 `.kbengine/stubs`；配置目录则扫描、用户 .pyi 不覆盖；支持 VS Code 变量） |
| `kbengine.python.enableMroJump` | `true` | Python 跨文件 C3-MRO 与 mixin 组合根导航开关（关 = 仅当前文件继承解析 + .def 回退） |
| `kbengine.python.apiMetadata` | `true` | 引擎感知的 KBEngine API 元数据——版本、源码 commit/describe 与原始声明位置——写进导出存根头部；取不到源码身份时显示 `unknown`，绝不编造（src/engineApiMetadata.ts、src/kbeModuleIndex.ts） |
| `kbengine.python.callChainHints` | `true` | Python 实体方法调用链提示与命令；关则隐藏入口，Show Call Chain 不再生成预览（src/defCallChainProvider.ts） |
| `kbengine.python.callChainView` | `"graph"` | Show Call Chain 面板初始视图：`graph`（打包内嵌 mermaid，离线）或 `text`；面板内 tab 选择持久化到工作区状态并优先于本设置（src/defCallChainViewLogic.ts） |
| `kbengine.hotReload.enabled` | `false` | 文件变更自动触发快速动作（默认关防误触） |
| `kbengine.hotReload.actionName` | `""` | 要触发的快速动作名（须存在于 .kbengine/debug.json quickActions） |
| `kbengine.hotReload.globs` | `["**/*.py"]` | 监视的文件匹配模式（每模式一个 watcher） |
| `kbengine.hotReload.debounceMs` | `500` | 触发前去抖毫秒数（0 = 不去抖） |
| `kbengine.hotReload.tempEdit.enabled` | `false` | 临时编辑热更新 quick action 总开关（默认关防误触，与 `kbengine.hotReload.enabled` 同口径）；开启后 `kbengine.hotReload.tempEdit.run` 才会写入临时编辑、触发重载并还原（src/hotReloadTempEdit.ts） |
| `kbengine.hotReload.tempEdit.actionName` | `""` | 第 3 步 reloadScript 按名触发的 quick action 名（HTTP 或终端动作均可）；留空视为配置错误中止，不编辑不发请求 |
| `kbengine.hotReload.tempEdit.autoRestore` | `true` | 发送 reloadScript 前是否自动还原原始内容；还原失败会中止请求并在问题通道报错，文件停留在临时编辑态需手工处理 |
| `kbengine.hotReload.tempEdit.scriptRoot` | `""` | 脚本资源根（双名称解析起点：fullModule = 根相对全部目录段 + 短名，requestModule = 直接父目录 + 短名）；留空则回显模块名未解析，不猜测 |
| `kbengine.core.backend` | `"ts"` | 双轨后端开关（kill-switch）：默认 `ts`；任何非 `shadow`/`rust` 值（含拼错）一律回落 `ts`；改回 `ts` 立即停用 Rust 进程，用户无感（src/kodeCoreGate.ts） |
| `kbengine.core.serverPath` | `""` | kode-server 二进制路径（cargo build -p kode-server 产物）；仅在 backend=shadow 时使用；留空则影子比对记 rust-unavailable，不启动进程 |
| `kbengine.core.shadow.timeoutMs` | `2000` | 影子比对镜像请求超时（毫秒）；超时只记差异日志 rust-timeout，不影响 TS 服务路径 |
| `kbengine.managedDir` | `` `.kbengine` `` | kode 托管目录名（运行时读取键，不在 contributes 中；改名后自动重建） |
| `kbengine.entity.builtinProperties` | `true` | 内建属性 hover + `self.` 补全（分面）— `src/languageProviders.ts:400,561` |
| `kbengine.entity.receiverSections` | `true` | hover/F12/RPC 镜的接收者段过滤 — `src/languageProviders.ts:515,3374,3897` |
| `kbengine.python.builtinTypeInlayHints` | `true` | `self.<内建属性>` 访问后内联 `: <类型>` 提示 — `src/languageProviders.ts`（`KBEngineBuiltinTypeInlayHintsProvider`），受 `kbengine.entity.builtinProperties` 总闸控制 |
| `kbengine.python.stubEngineTypings` | `true` | KBEngine.pyi 并入引擎 typings 全量 — `src/pythonStubExport.ts:360` |
| `kbengine.python.entityStubMethods` | `true` | entity_types.pyi 方法面 — `src/entityTypeStubs.ts:74,139` |
| `kbengine.types.aliasDiscovery` | `true` | alias.xml 自定义类型发现 — `src/definitionWorkspace.ts:285` |
| `kbengine.runtimeQuery.enabled` | `false` | 运行时查询面板操作面（watcher 观察清单增删与结果订阅流；默认关时面板只剩单次手动查询）— `src/runtimeQueryWebView.ts` |
| `kbengine.metrics.fileReadDetail` | `false` | 文件读取明细审计（路径+字节数，环形缓冲 256 条，`kbengine.metrics.showSummary` 可查；默认关=只累计计数，开销有界）— `src/fileReadMetrics.ts` |
| `kbengine.runtimeQuery.pollIntervalMs` | `2000` | 运行时查询面板结果订阅流轮询间隔毫秒数（下限 500；仅在 `kbengine.runtimeQuery.enabled` 开启时生效）— `src/runtimeQueryWebView.ts` |
