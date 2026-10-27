# 已支持功能清单

[English](../features.md)

基于证据的 kode 扩展已支持功能清单。每条带证据指针，无据可查的不列。

## Def 与实体智能

- **kbengine-def 语言与语法** —— `.def` 文件注册专属语言 id、括号规则与 TextMate 语法 ——（证据：package.json#contributes.languages、package.json#contributes.grammars）
- **.def 实时诊断** —— 未知类型 / Flags / DetailLevel 取值、属性与方法重复定义、缺 Type/Flags 字段，带总开关 ——（证据：package.json#configuration `kbengine.diagnostics.*`、`kbengine.enableDiagnostics`；src/defAnalyzer.ts）
- **.def 结构化校验** —— 重复定义、标签位置与缺失字段检查，挂 `kbengine.enableStructureDiagnostics` 开关 ——（证据：package.json#configuration `kbengine.enableStructureDiagnostics`；src/defAnalyzer.ts）
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
- **调用链（Show Call Chain）** —— 从 .def/Python 实体方法出发沿 def 索引展开向外出调，默认深度 3，沿 `self.base/cell/client.<方法>()` 接收者调用跳到其他 def 声明方法，解析不到的目标画成开口节点；渲染为打包内嵌的离线 mermaid 图（默认 `graph`，无 CDN）或纯文本回落，面板内 tab 选择持久化到工作区状态并优先于设置项，图渲染失败自动回落文本并在面板头说明 ——（证据：package.json#contributes.commands `kbengine.python.showCallChain`；package.json#configuration `kbengine.python.callChainHints|callChainView`；src/defCallChain.ts `buildDefCallChain`/`renderDefCallChainMermaid`、src/defCallChainProvider.ts、src/defCallChainViewLogic.ts）
- **数据库表结构视图** —— 由 def 分析渲染实体/组件/ARRAY 子表结构的只读视图，支持属性→表跳转与 F12 ——（证据：package.json#contributes.commands `kbengine.database.open`；todo.md:124、todo.md:133；src/databaseSchema.ts）
- **SQL 模板** —— 每表全列 SELECT、属性列 SELECT 与子表 JOIN 语句，遵循可配置表名前缀 ——（证据：todo.md:126；package.json#configuration `kbengine.db.tablePrefix`；src/databaseSchema.ts `renderTableSqlLines`）
- **MySQL 漂移对比（只读）** —— 代码侧 schema 与真实库逐表逐列对比；报缺表/缺列/多列/型别不符，语句白名单 + 会话只读双保险 ——（证据：package.json#contributes.commands `kbengine.database.checkDrift|checkAllDrift`；todo.md:125；src/databaseDrift.ts）
- **数据库模拟与导出** —— 模拟表结构可导出 JSON/Markdown ——（证据：package.json#contributes.commands `kbengine.database.simulate|exportSimulation`；todo.md:71；src/databaseSimulator.ts）

## 类型桩与托管目录

- **KBEngine.pyi API 存根导出** —— 内置 KBEngine Python API 索引导出为存根供 Pylance 使用；激活期静默自动导出、内容一致零写、手动命令入口 ——（证据：package.json#configuration `kbengine.python.stubExport`；package.json#contributes.commands `kbengine.python.exportStubs`；todo.md:54；src/pythonStubExport.ts、src/kbeModuleIndex.ts）
- **kbe_types 分件 Python 类型桩** —— types.xml 自定义类型（FIXED_DICT→TypedDict、ARRAY、别名按依赖拓扑序发射）导出为分件 `.pyi` 并做别名解析 ——（证据：package.json#contributes.commands `kbengine.python.exportTypeStubs`；todo.md:37；commit c445f8a、bfaff30；src/pythonTypeStubs.ts）
- **types.xml 变更自动重生成桩** —— didChange/didCreate/didDelete 三事件静默重导出类型桩 ——（证据：todo.md:35；src/pythonTypeStubs.ts `setupTypeStubRegeneration`）
- **entity_types.pyi 实体桩** —— def 引用自定义类型的实体级类型声明，挂激活期与实体映射刷新 ——（证据：todo.md:136；src/entityTypeStubs.ts）
- **存根目录可配置** —— `kbengine.python.stubDir` 设置 > `KBENGINE_STUB_DIR` 环境变量 > 默认 `.kbengine/stubs`；用户已写的 `.pyi` 视为用户资产不覆盖 ——（证据：package.json#configuration `kbengine.python.stubDir`；todo.md:42；src/pythonStubExport.ts）
- **python.analysis.extraPaths 接线** —— 发现的 KBEngine scripts 根按 WorkspaceFolder 级写入；只管理自己那段，用户手填路径不动 ——（证据：package.json#configuration `kbengine.python.extraPathsSync`；package.json#contributes.commands `kbengine.python.syncExtraPaths`；todo.md:55；src/pythonExtraPaths.ts）
- **托管目录可配置** —— kode 自管目录（默认 `.kbengine`，容纳 debug.json 与存根）可经 `kbengine.managedDir` 改名，改名后自动重建 ——（证据：src/managedDir.ts；commit c69517e；src/extension.ts watcher）

## 调试与运行

- **快速执行动作（配置驱动）** —— `.kbengine/debug.json` 顶层 `quickActions` 定义 `command`/`script`/`http` 三类后端，从 Servers 视图标题栏与 def/Python/XML 编辑器标题栏触发 ——（证据：todo.md:86；package.json#contributes.commands `kbengine.quickActions.*`；src/quickActions.ts、src/quickActionConfig.ts）
- **首装脚本扫描** —— 一层 `.bat` 扫描把启停与导表脚本登记为快速动作，不动手工条目 ——（证据：package.json#contributes.commands `kbengine.quickActions.scanScripts`；todo.md:11、todo.md:86；src/quickActionScanner.ts）
- **debug.json 缺失自动生成** —— `.kbengine/debug.json` 缺失即生成带注释的 JSONC 骨架（`${workspaceFolder}` 示例 + 扫描出的 `quickActions`）；已有配置绝不覆盖 ——（证据：todo.md:40；src/debugConfigBootstrap.ts）
- **debug.json JSON Schema 校验** —— 为 `**/.kbengine/debug.json` 贡献内联 schema，必填字段直接在编辑器标红 ——（证据：package.json#contributes.jsonValidation；todo.md:53；src/debugJsonSchema.ts）
- **debug.json JSONC 关联** —— 文件是 JSONC（带注释，解析走 stripJsonComments），kode 自动把 `files.associations` 接成 `jsonc`，注释不再按 json 划红线；WorkspaceFolder 级只动自己键、已有值不覆盖，`kbengine.jsoncAssociation.off` 命令只回收本扩展写入的条目 ——（证据：package.json#configuration `kbengine.jsoncAssociation`；package.json#contributes.commands `kbengine.jsoncAssociation.off`；src/jsoncAssociation.ts）
- **自动热重载** —— 文件监视触发指定快速动作、带去抖，默认关 ——（证据：package.json#configuration `kbengine.hotReload.*`；todo.md:52；src/hotReload.ts）
- **热更状态栏（HR-UI-001）** —— 状态栏项跟踪监视状态机关→就绪→发送中→已发送(未确认)→失败，渲染节流合并；动作完成且无错只记「已发送(未确认)」（不校验业务回执、绝不声称已生效）；点击状态栏项打开「KBEngine 热更」审计日志（每次触发记 time/触发文件/去抖值/结果）——（证据：package.json#contributes.commands `kbengine.hotReload.showLog`；src/hotReloadStatus.ts、src/hotReload.ts）
- **调试/启动配置** —— 启动调试、本地/远程附加（debugpy connect）、生成/更新 launch.json ——（证据：package.json#contributes.commands `kbengine.debug.start|attach|attachRemote|createConfig|updateLaunchJson`；package.json#configuration `kbengine.debug.remoteTargets`；src/debugConfig.ts）
- **启动即 attach（autoDebugpy）** —— `kbengine.debug.autoDebugpy` 开时，启动成功且开了 telnet 的组件经其 `:python` 层注入 `debugpy.listen`（自建短命客户端，逐组件端口 5678-5682，单组件失败只记日志）；`kbengine.python.debugpySync` 把系统 debugpy（≥1.8.0 版本闸对内嵌 Python 3.12.13）复制进 `<assets>/scripts/common/debugpy`（引擎模块搜索路径第一位），`Update launch.json` 为每组件生成一条 attach 配置 ——（证据：package.json#configuration `kbengine.debug.autoDebugpy`；package.json#contributes.commands `kbengine.python.debugpySync`；src/autoDebugpy.ts、src/debugConfig.ts）
- **服务生命周期** —— 按自动启动列表（默认 machine/logger/dbmgr）启停组件，统一走 ProcessManager ——（证据：package.json#contributes.commands `kbengine.server.start|stop|restart`；package.json#configuration `kbengine.autoStart`；todo.md:148；src/processManager.ts、src/serverManager.ts）
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
- **def/Python 代码生成器** —— 模板化生成 .def + Python 骨架并登记 entities.xml ——（证据：package.json#contributes.commands `kbengine.generator.wizard|templates`；package.json#configuration `kbengine.generator.*`；src/codeGenerator.ts、src/generatorForms.ts）
- **形态向导** —— 一次生成代理/空间/组件/固定字典骨架 ——（证据：package.json#contributes.commands `kbengine.generator.formWizard`；todo.md:44）
- **def 重命名** —— 重命名 provider 跨 def 文件解析链接路径 ——（证据：src/defRenamer.ts；src/languageProviders.ts `KBEngineRenameProvider`）
- **调用层级** —— def 与 Python 符号的 prepare/callers/callees ——（证据：src/languageProviders.ts `KBEngineCallHierarchyProvider`）

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
| `kbengine.debug.remoteTargets` | `[]` | 「Attach to Remote Component」的远程调试目标列表（debugpy connect，不写 pathMappings） |
| `kbengine.jsoncAssociation` | `true` | 自动把 debug.json 的 glob 键写成 `jsonc` 写进工作区 `files.associations`（WorkspaceFolder 级；只动自己键、已有值不覆盖；`kbengine.jsoncAssociation.off` 回收本扩展写入的条目） |
| `kbengine.debug.autoDebugpy` | `false` | 组件启动后经其 telnet `:python` 层注入 `debugpy.listen`（端口 baseapp 5678/cellapp 5679/loginapp 5680/dbmgr 5681/logger 5682，只绑 127.0.0.1；单组件失败只记日志不阻塞启动；注入走 telnet，早期 config 阶段断点属二期） |
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
| `kbengine.runtimeQuery.pollIntervalMs` | `2000` | 运行时查询面板结果订阅流轮询间隔毫秒数（下限 500；仅在 `kbengine.runtimeQuery.enabled` 开启时生效）— `src/runtimeQueryWebView.ts` |
