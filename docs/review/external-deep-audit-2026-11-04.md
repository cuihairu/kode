# kode 外部深度审核落地（2026-11-04）

> **来源**：外部深度审核（deepseek 通道重派复核），提取原稿
> `~/.hermes/cache/documents/native-inputs/942e0625…/doc_63721e1ec7e5_issues.md`（481 行）。
> **审核基准**：`c5954f3`（2026-11-04，KB-API-001 文档提交）。
> **重核 HEAD**：`e512e99`（重核当日，含同日 perf 批 06c64e8/1403e72/e60c6b9 与 KB-VER-001）。
> **声明**：外部建议**非仓内事实**——本档只记录「重核后在 HEAD 上仍然成立的问题」；
> 引擎侧引用（`D:/workspaces/kbengine` 的 entitydef.cpp/profile_handler.cpp/common.h 等行号）
> 本仓未复核，一律保留原稿限定语原样搬运；「确认无问题」负面清单同理未经本仓复走。
> **重核方法**：89 条发现逐条对 HEAD 锚点重定位（git grep 锚符号 + file:line 比对），
> 争议项（CORE-1/IDX-2/RT-2/RT-4/DEF-2/RSV-1/RSV-2 等）另做片段精读定性。
> 基线→HEAD 的 src 变更仅 `engineVersion.ts`（新增）与 `entityDependencyWebView.ts`（perf 批，
> 导致 UI-2/UI-4 行号漂移），**未发现评审点名的任何问题在基准后已被修复**；
> KB-API-001 等文档修正与代码发现无交集。

## 一、重核对照表（89 条，双路重复项已并入条目内标注）

结论口径：**属实**＝HEAD 上问题仍在（含行号漂移已更新）；**部分属实**＝结构性问题在但关键子声明不成立/已被在先工作缓解；
**轻核**＝锚点+结构在位但未逐行走完触发路径（保留外部限定语）；**备注**＝原稿备注级/防回归登记，非缺陷。

| # | 原编号 | 级 | 结论 | HEAD file:line | 重核说明 |
|---|---|---|---|---|---|
| 01 | CORE-1 | P2 | 部分属实（已缓解） | src/kodeCoreClient.ts:248-275 | shutdown(:260) 仍无超时，挂死即永久挂；exit 等待已加 1.5s race+SIGKILL 兜底，但末尾 `await exited`(:273) 对「race 超时时已退出」的进程仍无守卫可挂——两条挂起路径一条仍在、一条留残边 |
| 02 | CORE-2 | P3 | 属实 | src/kodeCoreClient.ts:183-189 | cancelTimer(:185) 仅 hardTimer 被清，迟到 $/cancelRequest 仍在 |
| 03 | CORE-3 | P3 | 属实（行号微漂移） | src/kodeCoreClient.ts:396-402; crates/kode-server/src/server.rs:178-182 | 握手失败仅记 stderr，child 不清；-32002/SERVER_NOT_INITIALIZED 在 server.rs:178/182 |
| 04 | DIA-1 | P2 | 属实 | src/diagnosticScheduler.ts:417,481-485 | error 分支 `throw error`(:482) 后 computation 无人消费，未处理 rejection 在位 |
| 05 | TST-1 | P3 | 属实 | src/pythonTestRunner.ts:268-295 | spawnTestProcess 无超时/无 kill，stdout/stderr 无界累积；isCancelled 只在条目间(:178,191) |
| 06 | TST-2 | P3 | 属实 | src/pythonTestRunner.ts:59,76 | VERBOSE_OUTCOME_PATTERN `\S+` 截断带空格参数化用例 |
| 07 | PAR-1 | P3 | 属实 | src/pythonParserWorkerHost.ts:214-215 | fileQueues.set(:215) 后无逐条目回收（仅整体 clear:79） |
| 08 | 自查-CSP | P3 | 属实 | src/runtimeQueryWebView.ts:369;432,447 | `script-src 'unsafe-inline'` 在 :369；数据面 textContent(:432,:447) 属实（原稿自述暂无注入面，保留） |
| 09 | RUST-1 | P2 | 属实 | crates/kode-python/src/dataflow.rs:332-374 | 各推导式分支 elt 读取(:333/343/366)先于 target 写(:336/346/359/369)，elt 内 use 链断；与 KODE-AUD-007 席位同文件（见划界节） |
| 10 | RUST-2 | P2 | 属实 | crates/kode-python/src/dataflow.rs:218-223 | Match 只读 subject 走 case.body；guard/pattern 捕获均未处理（callgraph 侧已由 KODE-AUD-008/dd869b5 补，dataflow 侧仍开） |
| 11 | RUST-3 | P2 | 属实 | crates/kode-python/src/symbols.rs:46; dataflow.rs:224-233 | `asname or alias.name`→`import os.path` 绑 "os.path"，与 Python3 顶层绑定语义断链 |
| 12 | RUST-4 | P2 | 属实 | crates/kode-scheduler/src/scheduler.rs:452-479 | ensure 无条件 `keyed.insert`(:466)，RejectedQueueFull/StaleDropped(:417/:377) 时 id=0 假条目永久卡 |
| 13 | RUST-5 | P2 | 属实 | crates/kode-scheduler/src/scheduler.rs:442 | tasks.insert(:442) 全文件无 remove/entry——终态任务无界累积 |
| 14 | RUST-6 | P2 | 属实 | crates/kode-scheduler/src/invalidation.rs:67-83 | affected_by 单级反向传播，无传递闭包 |
| 15 | RUST-7 | P3 | 属实 | crates/kode-python/src/graph.rs:93 | `starts_with("self.")` 恒回 caller_file（自述取舍，按引擎语义为漏报面） |
| 16 | RUST-8 | P3 | 属实 | crates/kode-python/src/dataflow.rs:247-248 | Raise/Assert 归 no-op，err/cond/msg 读漏记 |
| 17 | RUST-9 | P3 | 属实 | crates/kode-python/src/dataflow.rs:206-211 | except 捕获名 def_var 记到 try 行（外层 line 变量）非 handler 行 |
| 18 | RUST-10 | P3 | 属实 | crates/kode-python/src/dataflow.rs:399 | `Lambda(l) => collect_reads(l.body)` 无形参遮蔽建模 |
| 19 | RUST-11 | P3 | 属实 | crates/kode-python/src/dataflow.rs:249-250 | Stmt::Global/Nonlocal 归 no-op，后续赋值按局部 def 建假链 |
| 20 | RUST-12 | P3 | 属实 | crates/kode-python/src/callgraph.rs:247-256 | KODE-AUD-008 已把嵌套 def 改独立 caller，但 caller_class 仍继承外层类名→伪 (Foo, inner) 边（该席位残留面，见划界节） |
| 21 | RUST-13 | P3 | 属实 | crates/kode-python/src/callgraph.rs:309 | lambda 体调用归外层 caller、嵌套 def 以自身名——归属口径不一致 |
| 22 | RUST-14 | P3 | 属实 | crates/kode-python/src/symbols.rs:159; scheduler.rs:646-686 | method_params 注释顺序与实现不符（posonly:159）；run 闭包无 catch_unwind，panic 卡死调度 |
| 23 | RUST-注1 | P2级 | 属实（备注） | crates/kode-scheduler/src/invalidation.rs:115,129-135 | plan_dependency_tasks：changed 与依赖同批丢 SingleFileUpdate 优先级 |
| 24 | RUST-注2 | P3级 | 属实（备注） | crates/kode-scheduler/src/journal.rs:29 | JOURNAL_TMP_SUFFIX=".tmp"，无扩展名路径产 `xxx..tmp`（无功能影响） |
| 25 | IDX-1 | P1 | 属实 | src/entityMapping.ts:215,462-470,528,1190-1201 | removedRootKeys 仅 add(:1192) 无 delete/clear；重新登记根仍被 :528 拦截 |
| 26 | IDX-2 | P1 | 属实（边缘路径） | src/pythonClassIndex.ts:640-661,704-782 | 输入稳定即落地(:771-777,含 end metrics+return)——正常路径不中；「连续让位 8 次」fall-through(:779-781) 仍只打日志：rootsMap 不写、metrics 不 end、rootsPromise 不清→join 臂(:644-661)空等，与原稿描述吻合 |
| 27 | IDX-3 | P1 | 属实 | src/workspaceIndex.ts:119-137 | watcher(:131) 挂在 `await Promise.all`(:129) 之后；AUD-074 同款修法未同步到本面 |
| 28 | IDX-4 | P2 | 属实（行号漂移） | src/pythonClassIndex.ts:377,496-498 | onDocumentClosed→invalidate(:498) 推进扫描代→全仓重发现+重解析；原稿 400-418/905-937/1098-1146 已漂移 |
| 29 | IDX-5 | P2 | 属实 | src/globalDataIndex.ts:1643-1652,1701-1718 | scanWorker 循环头只复核 revisions 不复核 generation；generation 守卫仅在 indexFile 层(:1718) |
| 30 | IDX-6 | P3 | 属实 | src/sharedFileEvents.ts:44 | statSync 在 watcher 事件路径（:110/:117 未细核，保留限定） |
| 31 | IDX-7 | P3 | 属实 | src/dependencyGraph.ts:34 | `entities.xml` 无 `/` 前缀锚，`xxxentities.xml` 误判 |
| 32 | IDX-8 | P3 | 属实（轻核） | src/pythonParser.ts:147-157 | `from . import mod` 记录侧在位(module='.')，兄弟模块解析落空半边未走完触发路径 |
| 33 | IDX-9 | P3 | 属实 | src/kbeModuleIndex.ts:408-412 | import 正则锚 `^\s*import\s+(KBEngine\|kbe)`，`import os, kbe` 不命中 |
| 34 | IDX-10 | P3 | 属实（轻核） | src/workspaceDiscovery.ts:225,279-287 | scanCache/cachedScan 无失效路径（scanRoots 侧未细核） |
| 35 | IDX-11 | P3 | 属实 | src/globalDataIndex.ts:2076 | `Promise.all(files.map(indexFile))` 无限流 |
| 36 | IDX-12 | P3 | 属实（轻核+漂移） | src/definitionWorkspace.ts:172-200,193 | getDefinitionWorkspaceLayout 无缓存，existsSync 多点(:193,:711,:712) |
| 37 | IDX-注 | P3级 | 未逐项复核（备注） | — | pathIdentity 不折叠 `..`、pythonExtraPaths 大小写敏感、noteSaved 每键两遍正则——备注级，保留原稿限定语 |
| 38 | RT-1=UI-1 | P1 | 属实（双路重复） | src/logWebView.ts:602-605 | `title="${log.raw}"` 与 `log.component.toUpperCase()` 未转义直进 innerHTML；仅 message 走 escapeHtml(:605)；enableScripts 无 CSP |
| 39 | RT-2 | P1 | 部分属实（RUN-007 已缓解） | src/processManager.ts:336-365 | stop 已有 exitCode/signalCode 预检+timeoutMs 超时升级 killProcessTree(SIGKILL)；「永久挂起」主路径不复现；spawn 失败 error-only-no-exit 的残边依赖 kill 兜底，保留限定 |
| 40 | RT-3 | P2 | 属实 | src/hotReload.ts:575,625; src/hotReloadRetryCommand.ts:72,261 | gateDefChanges 仅 fire 路径(:575/:625)；resendHotReloadTarget 重试不重跑结构闸 |
| 41 | RT-4 | P2 | 部分属实（密码串不属实） | src/debugConfig.ts:430,504,870,884,891,937 | `ucs775502` 全 git 历史不存在（git log -S 零命中）；硬编码默认回落 **`pwd123456`** 写入生成配置属实——凭据固化结构性问题成立，串值以仓内为准 |
| 42 | RT-5 | P2 | 属实 | src/debugConfig.ts:803,824-826 | updateLaunchJson 按名称前缀 `startsWith('KBEngine:')` 清理，无生成标记 |
| 43 | RT-6=UI-3 | P2 | 属实（双路重复） | src/monitoringWebView.ts:243,601,1034 | CDN(:243)、`JSON.stringify(metrics)` 直插 script(:601)、formatMetricCard(:1034) 均在位 |
| 44 | RT-7≈UI-13 | P2 | 属实 | src/logWebView.ts:51-56,96; src/monitoringWebView.ts(keywordFilter) | collector.onLogEntry→updateWebView 全页重渲(:51-56)实核；logHub 增量 appendLogs(:96)未走；monitoring 过滤面轻核 |
| 45 | RT-8 | P3 | 属实 | src/hotReload.ts:298; src/hotReloadRetryCommand.ts:60-65 | `${current.detail} \| ${reason}`——detail 为 undefined 时产 "undefined \| reason"，两处一致 |
| 46 | RT-9 | P3 | 属实（轻核） | src/hotReload.ts:338 | sendViaChannel 在位；accepted 即终态的两路径状态语义差异未逐行走完 |
| 47 | RT-10 | P3 | 未逐行复核（限定语保留） | src/hotReloadRetryCommand.ts | sentAt 时点口径差异按原稿保留，未实核 |
| 48 | RT-11 | P3 | 属实 | src/serverManager.ts:583,590 | existsSync(:583) 与 statSync(:590) 间 TOCTOU，statSync 在 try 外 |
| 49 | RT-12 | P3 | 属实 | src/telnetWebView.ts:365-404 | escapeHtml 已有 4 处，但 querySelector 字符串拼接(:400)无 CSS.escape |
| 50 | RT-13 | P3 | 属实 | src/monitoringWebView.ts, logWebView.ts, telnetWebView.ts 等 | 5 个自建 webview 均无 Content-Security-Policy（grep 零命中） |
| 51 | RT-14 | P3 | 属实（轻核） | src/telnetClient.ts:141,172,243 | connect 链无 setTimeout 连接超时 |
| 52 | RT-15 | P3 | 部分属实（轻核） | src/quickActions.ts:177-190 | 终端复用有 `exitStatus !== undefined` 检查(:178)——「重入复用旧终端」需限定为复用**存活**终端；Windows `%`→`%%` 未处理属实 |
| 53 | UI-2 | P2 | 属实（行号漂移已更新） | src/entityDependencyWebView.ts:1215,1255,1012; entityFlowWebView.ts:276; monitoringWebView.ts:243 | 今日 perf 批(1403e72)改文件致漂移：CDN :1215、mermaid securityLevel :1255、statCard mostReferenced :1012（原 1052/1091/867 失效） |
| 54 | UI-4 | P2 | 部分属实（部分调用点已重构） | src/definitionWorkspace.ts:153; src/extension.ts:1626,1645,1746; src/entityDependency.ts:258 | getWorkspaceRootForDocument 移至 definitionWorkspace.ts:153，无参回落第一根属实（TESTING.md:490 同证）；extension.ts:1626/1645/1746 无参调用实核；entityDependencyWebView.ts:697/752 与 databaseSimulator.ts:739 调用点已不存在（重构，替代路径未复核） |
| 55 | UI-5 | P2 | 属实（轻核+漂移） | src/extension.ts:5318-5319,2062,4602,4835,4848 | entityDefsPath/entitiesXmlPath 仅读取面(:5318-5319)，配置失效清单未见两键；原 4004-4012 行号漂移 |
| 56 | UI-6 | P2 | 属实（轻核） | src/inferPipeline.ts:305-444 | syncInferredCopy 多点(:421,:436,:444)，无防抖/互斥结构在位 |
| 57 | UI-7 | P3 | 属实 | src/extension.ts:5521-5522 | `serverManager.dispose(); await serverManager.dispose();` 笔误逐字在位 |
| 58 | UI-8 | P3 | 属实 | src/selfAttributeNoneDiagnostics.ts:34,72-74 | SELF_MEMBER_ACCESS 直接跑原始行，无 pythonLexicalMask（grep 零命中） |
| 59 | UI-9 | P3 | 属实（轻核） | src/selfAttributeFlowTypes.ts:149,177 | selfAssignment 正则未排除 `+=`/`-=` |
| 60 | UI-10 | P3 | 属实 | src/typeInlayHints.ts:53 | provideInlayHints 无 CancellationToken（grep 零命中） |
| 61 | UI-11 | P3 | 属实 | src/eventApi.ts:70 | 全仓 findFiles 后逐个 openTextDocument，无取消无缓存 |
| 62 | UI-12 | P3 | 属实 | src/entityBuiltinProperties.ts:205-215; src/languageProviders.ts:726 | 内建属性 inlay 正则跑原文行，调用点传 documentStore 行数组 |
| 63 | UI-14 | P3 | 属实 | src/entityDependency.ts:322-365 | calculateMaxDepth 递归臂 istanbul ignore 自证不可达，maxDepth 恒 1（批62 已登记未修） |
| 64 | UI-15 | P3 | 属实 | src/pythonReturnTypeInference.ts:42,79,83 | ASSIGNMENT_PATTERN 对原始行匹配(:79)，maskCodeLine 只处理捕获后 RHS(:83) |
| 65 | UI-16 | P3 | 属实（轻核） | src/languageProviders.ts | hover 全文 findEventCalls vs 数据字典行级/全文口径并存 |
| 66 | UI-17 | P3 | 属实 | src/projectProfiles.ts:108-127 | create() 的 created 字面量(:117-123)未拷贝 input.hotReload（当前调用未传，属潜在） |
| 67 | DEF-1 | P1 | 属实 | src/messageTable.ts:605-608,463-466 | 接口分支提前 return(:605-608) 跳过该接口自身 Interfaces 递归与组件槽注册；buildMessageTableInRust 闭包注释(:463-466)同口径。引擎侧行号未复核（保留原稿断言） |
| 68 | DEF-2 | P1 | 属实 | src/kbengineProtocol.ts:596-663 | cprofile fall-through(:649-663) 不读 timingLength（恒 0），pyprofile/eventprofile/networkprofile 三分支均读——行数据错位结构与原稿一致；引擎 CProfileHandler 行号未复核 |
| 69 | DEF-3 | P1 | 属实 | src/entityWizard.ts:97-98 | 模板输出 `<position> VECTOR3 CELL_PUBLIC_AND_OWN`；引擎受限属性面未复核（保留原稿） |
| 70 | DEF-4 | P1 | 属实（行号漂移） | src/defCallChain.ts:118-136 | `lines.slice(bodyStart)`(:135) 无 endLine 截尾，兄弟方法调用误归属 |
| 71 | DEF-5 | P2 | 属实 | src/defReferenceGraph.ts:185-200 | 父类候选硬编码 `category:'entity'`(:191)→目录恒 defsRoot |
| 72 | DEF-6 | P2 | 属实 | src/definitionSemantics.ts:427-433,602-607 | interface def 的 Parent 经 parentCategory='entity'(:428) 合并；引擎不可见面保留原稿 |
| 73 | DEF-7 | P2 | 属实（轻核） | src/clientSdkGenerator.ts:284,317,352,367 | 组件属性递归在位(:317/:352/:367)，实体 SDK 类无父链/接口闭包合并与 extends（'extends' 零命中） |
| 74 | DEF-8 | P2 | 属实（轻核） | src/codeGenerator.ts | legacy 平铺类名/路径与引擎 scripts/{base,cell}/ 约定不符——结构在位，引擎查找语义保留原稿 |
| 75 | DEF-9 | P3 | 属实 | src/defParser.ts:481 | tagRegex `[^>]*?` 对属性值含 '>' 提前终止 |
| 76 | DEF-10 | P3 | 属实 | src/defChain.ts:73,100,127 | collectFlatDecls 仅入口(:100)+父链(:127)，嵌套 Interfaces 不进链 |
| 77 | DEF-11 | P3 | 属实 | src/defSymbolReferences.ts:245 | 仅扫 'Interface' 一种包装名；defRenamer 已对齐(1 处) |
| 78 | DEF-12 | P3 | 属实 | src/generatedSourceMap.ts:20,25,31 | 硬编码 document line 0/2 且全部覆盖 key 0→多类 stub 只剩最后一个类的 lens |
| 79 | DEF-13 | P3 | 属实（轻核） | src/clientSdkGenerator.ts:390 | getScalarChildValues 对嵌套 `<of>` 只取首文本 |
| 80 | RSV-1 | P1 | 属实 | crates/kode-server/src/def_md5.rs:998-1005 | load_interfaces 用 child_el 具名查找+取**元素名**(interface_el.name)——`<interface> ROLE </interface>` 文本形态得 "interface" 非 "ROLE"，与引擎 FirstChild/getKey 语义失配；引擎行号未复核（保留原稿） |
| 81 | RSV-2 | P1 | 属实 | crates/kode-server/src/def_md5.rs:1042-1055 | `component_type_name = doc.element(type_el).name.clone()`(:1055)＝字面量 "Type"；应取 `<Type>` 文本 |
| 82 | RSV-3 | P2 | 属实 | crates/kode-server/src/def_md5.rs:341-347,354-364,543-548 | register 覆写 alias_name(:345)，is_entitycall 判 alias_name=="ENTITYCALL"(:360)——types.xml 别名即失效 |
| 83 | RSV-4 | P2 | 属实 | crates/kode-server/src/def_md5.rs:1167-1185 | load_parent_class 仅 first_text(:1179)，`<Parent><Avatar/></Parent>` 得空串报 "parent def not found: .def" |
| 84 | RSV-5 | P3 | 属实（轻核） | crates/kode-server/src/lint/rules.rs:664-945 | UnknownFlagValueRule 在位(:664,:945)；整串查表 vs 多 token 放行差异保留原稿口径 |
| 85 | RSV-6 | P3 | 属实 | crates/kode-server/src/def_md5.rs:900-918 | calc_property_utype 全局 prop_utypes 查重(:905-907)即 Err——比引擎跨模块容忍更严 |
| 86 | RSV-7 | P3 | 属实 | crates/kode-server/src/def_md5.rs:354-364 | is_entitycall 对 Array 沿 element 链递归(:357-359) vs 引擎一层 type() |
| 87 | RSV-8 | P3 | 属实 | crates/kode-parser/src/model.rs:349-350,400 | OWN_CLIENT/OTHER_CLIENTS 仅置 has_client(:400)未入 cell 域（process_topology 自有表已正确——原稿自述，未复核） |
| 88 | RSV-9 | P3 | 属实 | crates/kode-parser/src/model.rs:157-162 | interfaces 臂只取元素 text，`<interface><Tank/></interface>` 元素形态漏（与 RSV-1 同根） |
| 89 | RSV-10 | P3 | 属实（备注/防回归） | crates/kode-server/src/python_callgraph.rs:161 | file_stem 仅按 '/' 分割，注释自述 Windows 由调用方统一斜杠——非缺陷，登记防回归 |

## 二、与在飞席位工作的划界

| 在飞面 | 重叠的 KR-AUD 项 | 划界说明 |
|---|---|---|
| KODE-AUD-007（dataflow 语义席位） | 09(RUST-1)/10(RUST-2)/16-19(RUST-8..11) | 同文件同函数域（dataflow.rs）。KODE-AUD-007 已修 AugAssign/del/Subscript/walrus/Comprehension-target（b26396e）；RUST-1 是**同分支的另一面**（elt 先于 target 的顺序问题，comprehension_target_defined 测试只覆盖 target 定义、未覆盖 elt 内使用）——派单须知会该席位避免互踩 |
| KODE-AUD-008（callgraph/symbols/graph 席位） | 20(RUST-12)/21(RUST-13)/10(RUST-2 callgraph 半边) | dd869b5 已补嵌套 def 独立 caller 与 Match guard 走查；RUST-12 是该修复的**残留面**（嵌套 def 仍继承外层 caller_class），RUST-2 的 callgraph 侧已闭合、dataflow 侧仍开 |
| KODE-PERF 席位（今日 004/005/006） | 26/28(IDX-2/4)、29(IDX-5)、53/54(UI-2/4) | perf 席位在 pythonClassIndex/globalDataIndex/entityDependencyWebView 相邻性能面活动；1403e72 刚改 entityDependencyWebView.ts → 53/54 行号以此为准；无同函数冲突，但排期上建议与 perf 批错峰 |
| KB-API 文档席位（docs/knowledge） | 无 | 纯文档面，与全部代码发现无交集；KB-API-001 的修正不触及本清单 |
| wt/hot lane（IDE-HOT-100） | 40/45-47(RT-3/8/9/10) | lane 已合入 main，无未合改动 |
| KR-AUD 编号空间 | — | todo.md 现无任何 KR-AUD 前缀，本节首用，无冲突 |

## 三、重核统计

- **89 个跟踪项**（原稿 89 条编号发现；3 对双路重复 RT-1=UI-1、RT-6=UI-3、RT-7≈UI-13 在条目内并标，另有 3 条备注级 RUST-注1/2、IDX-注、RSV-10 防回归）。
- **属实**：82（其中行号漂移已更新 14 条、轻核保留限定语 12 条）。
- **部分属实**：5（01 CORE-1 已缓解残边、39 RT-2 RUN-007 缓解、41 RT-4 密码串不属实但结构属实、52 RT-15 需限定、54 UI-4 部分调用点已重构）。
- **不属实**：0（无一条在 HEAD 上被完全证伪；41 的具体密码串为唯一被证伪的子声明）。
- **未逐项复核（备注级，限定语保留）**：2（37 IDX-注、47 RT-10）。
- **评审点名的 P1 共 12 条**（25/26/27/38/39/67/68/69/70/80/81 + DEF-4 已含 70），全部在 HEAD 上成立（39 为缓解后残边）。
- 基准→HEAD 无一发现已被修复；重核发现的**行号漂移**集中在 entityDependencyWebView.ts（今日 perf 批）与其余文件的自然漂移（≤5 行）。

## 四、原审核全文（清洗后保留，限定语原样）

> 以下为外部原稿全文搬运（已去导出残渣；引擎侧未复核声明、「未取得完整源码」类自述、
> 「确认无问题」负面清单均原样保留，不代表仓内已复核结论）。

---

# kode 深度审核问题清单（2026-11-04）

审核范围：全仓库（src/ 全部 TS 模块、crates/ 全部 Rust crate、引擎语义对照）。
基准：`c5954f3`（2026-11-04）。引擎参考：`D:\workspaces\kbengine`（master，Python 3.7 基线）。
已知且已修复/已挂账的问题不再重复（todo.md 审核发现 2026-10-31～11-04 各节、KODE-AUD/PERF/HOT/FEAT/DBG/I18N/ARCH 开放项）。

严重度：P0=崩溃/数据损坏/安全；P1=明确功能错误；P2=竞态/泄漏/边界错误/性能退化；P3=健壮性与质量隐患。

---

## 一、审核方式说明

- 6 路并行深审：Rust 核心（kode-python/kode-scheduler）、Rust 服务层（kode-server/其余 crates，对照引擎协议与 def/MD5/拓扑语义）、TS 索引层、TS def/协议/生成器（对照引擎 def 语义）、TS 热更新/进程/调试、TS UI/诊断/扩展装配。
- 横切自查：kodeCore*（TS↔Rust 桥接）、diagnosticScheduler、pythonParserWorkerHost、pythonTestRunner、generatorForms、CI/工具链、webview CSP。

## 二、问题清单

### 桥接层（kodeCoreClient / kodeCoreGate）

#### [P2] CORE-1：`KodeCoreClient.dispose()` 存在两条永久挂起路径，导致 Rust server 进程孤儿泄漏
- 位置：`src/kodeCoreClient.ts:248-273`
- 证据：
  1. `await this.rawRequest('shutdown', undefined)`（:260）没有任何超时。若 Rust server 存活但挂死（handler 死循环/输出背压），shutdown 永不回包，`dispose()` 永久挂起，后面的 exit/KILL 清理逻辑永远走不到，子进程泄漏。
  2. exit 竞态：`dispose()` 在 `await rawRequest('shutdown')` 挂起期间，若子进程恰好退出，`handleExit`（:378）先执行——`rejectAll(EXITED)` 使 shutdown 请求被拒（走 catch 继续），但 `this.child` 已被置 null；随后 `const exited = new Promise(child.once('exit'))`（:265）注册在**已经发出过 exit 事件的进程对象**上，永不 resolve；`await exited`（:271）永久挂起。
- 影响：扩展停用/配置切走时 Rust server 进程不被回收；`gate.dispose`（`context.subscriptions` 注册，`kodeCoreGateWiring.ts:83-87`）依赖 `client.dispose()`。
- 修复建议：shutdown 请求包超时（超时即 SIGKILL）；`await exited` 前检查 `child.exitCode !== null || child.killed` 则跳过等待。

#### [P3] CORE-2：`request()` 的 cancelTimer 在请求正常完成后不清理
- 位置：`src/kodeCoreClient.ts:183-189`
- 证据：resolve/reject 包装只 `clearTimeout(hardTimer)`；`cancelTimer`（timeoutMs 时点发 `$/cancelRequest`）保留至触发，对一个已完成的 id 发出取消通知。
- 影响：无害但脏；长会话累计大量迟到取消通知。
- 修复建议：resolve/reject 里同时清 cancelTimer。

#### [P3] CORE-3：崩溃重启握手失败后，进程处于未初始化态继续接单
- 位置：`src/kodeCoreClient.ts:396-401`
- 证据：`handleExit` respawn 后 `initialize()` 失败只记 stderr；child 非 null，后续 `request()` 直接发出，Rust 侧按 -32002 `SERVER_NOT_INITIALIZED` 拒绝（`crates/kode-server/src/server.rs:179-185`），且不再有重试直到下次退出。
- 影响：重启失败后所有请求得到误导性错误（SERVER_ERROR 而非 EXITED），调用方按「Rust 结果错误」记账而非「服务不可用」。
- 修复建议：握手失败后杀掉子进程、置 `child=null`，让请求走 EXITED 路径。

### 诊断调度（diagnosticScheduler）

#### [P2] DIA-1：`computeAsync` 失败路径产生未处理的 Promise rejection
- 位置：`src/diagnosticScheduler.ts:417, 481-485`
- 证据：`const computation = options.computeAsync().then(onOk, error => { this.pending.delete(computation); throw error; })`——重抛后 `computation` 变为 rejected，除 `pendingComputations()` 偶然 `Promise.all` 外无任何消费者；`computeAndPublish` 返回 void，调用方无法挂 catch。
- 影响：异步诊断计算抛错（如 worker 崩溃、解析异常）→ 扩展宿主 UnhandledPromiseRejection 日志噪音，测试环境直接判红；错误信息丢失。
- 修复建议：error 分支改为记统计（如 `errored` 计数）并吞掉，或把 computation 包一层 `.catch(() => undefined)` 存入 pending。

### Python 解析与测试执行

#### [P3] TST-1：`spawnTestProcess` 无超时、无进程终止，取消语义只挡「下一跳」
- 位置：`src/pythonTestRunner.ts:268-295`、`runPythonTests :185-225`
- 证据：`isCancelled()` 只在两个条目之间检查；单个 pytest 挂死时 `child` 永不 close，`await deps.exec(...)` 永久挂起，取消也杀不掉当前进程；stdout/stderr 字符串无界累积。
- 修复建议：exec 面注入超时 + `child.kill()`；输出设上限。

#### [P3] TST-2：pytest `-v` 节点行解析不支持带空格的参数化用例
- 位置：`src/pythonTestRunner.ts:59`
- 证据：`VERBOSE_OUTCOME_PATTERN = /^(\S+\.py(?:::\S+)?) (PASSED|...)/`——`test_x[param with space]` 会被 `\S+` 截断，匹配失败 → 条目误报「未收集到测试」。
- 修复建议：改用「行尾 PASSED/FAILED… 状态词前缀匹配」而不是对节点全串用 `\S+`。

#### [P3] PAR-1：`pythonParserWorkerHost` 的 `fileQueues` 条目永不回收
- 位置：`src/pythonParserWorkerHost.ts:214-215`
- 证据：每个大文件解析都会 `fileQueues.set(filePath, queue)`，任务完成后条目保留（`{inFlight:null, pendingLatest:null}`），没有清理路径；长期会话按大文件数量线性积累。
- 修复建议：任务排干且无 pending 时从 map 删除条目（或回包后惰性清理）。

### UI / Webview

#### [P3] UI-1：`runtimeQueryWebView` CSP 使用 `script-src 'unsafe-inline'`
- 位置：`src/runtimeQueryWebView.ts:369`
- 证据：内联 script + 无 nonce 的宽松 CSP。当前数据注入全部走 `textContent`（:432/:447），暂无注入面，但一旦后续有人用 innerHTML 即成 XSS。
- 修复建议：按 VS Code 官方做法用 `nonce` + `webview.cspSource` 收紧。


---

## 三、各路深审发现（代理汇总）

### Rust 核心路（kode-python / kode-scheduler）— 6 P2 + 8 P3

#### [P2] RUST-1：推导式 elt 读取先于 target 定义，推导式内部 def-use 链全部断裂
- 位置：`crates/kode-python/src/dataflow.rs:332-374`（ListComp/SetComp/DictComp/Generator 四分支）
- 证据：每分支先 `collect_reads(state, &c.elt, line)` 再在 generators 里 `collect_writes(state, &gen.target, line)`；use_var 只在 live 链存在时记 use，`[str(x) for x in xs]` 中 elt 里的 `x` 读取时尚未 def，使用点丢失。现有测试 comprehension_target_defined（dataflow_test.rs:233）只在推导式之后 use(x)，未覆盖 elt 内使用。
- 修复建议：先遍历 generators（iter 读 → target 写 → ifs 读），最后读 elt/key/value。

#### [P2] RUST-2：dataflow 的 Match 语句 guard 不读、pattern 捕获不 def
- 位置：`crates/kode-python/src/dataflow.rs:218-223`
- 证据：只 `collect_reads(&m.subject)` 后直接 `walk_body(&case.body)`；`case.guard`（callgraph 侧 KODE-AUD-008 已补，dataflow 侧漏）与 pattern 绑定（`case [a, b]:`、`case Point(x=p):`）均未处理，case 体内对捕获变量的 use 全部漏记。
- 修复建议：读 guard，并从 pattern 提取捕获名做 def_var。

#### [P2] RUST-3：dotted import 绑定名错误——`import a.b` 的本地绑定是 `a` 而非 `a.b`
- 位置：`crates/kode-python/src/symbols.rs:44-54`（dataflow.rs:224-233 同逻辑）
- 证据：`binding = asname or alias.name` 对 `import os.path` 产出 "os.path"；Python 3 语义只绑顶层 `os`。后续 `os.path.join(...)` 经 Attribute 递归最终 use 的是 "os"，与 def 的 "os.path" 对不上，链断裂；跨文件模块解析也按 "os.path" 找文件。测试只覆盖了 `import os`/`import numpy as np`。
- 修复建议：无 asname 时取 `alias.name` 首段作为 binding。

#### [P2] RUST-4：Scheduler::ensure 入队被拒/过期丢弃时写入 id=0 假 keyed 条目，任务永久卡死
- 位置：`crates/kode-scheduler/src/scheduler.rs:452-479`
- 证据：enqueue 后不检查 `outcome.decision`，无条件 `keyed.insert(key, {Queued, Some(outcome.id)})`。队列满（RejectedQueueFull）或旧 version（StaleDropped）时 id=0；此后 entry.state==Queued → 后续 ensure 恒 Reused，execute 的 keyed 回写按 `entry.id == Some(id)` 永不匹配 id=0 → 该 keyed 任务（如 initial-scan）永久假 pending，违背模块头「失败不缓存成永久 pending」语义。
- 修复建议：ensure 检查 decision，仅 Queued/Merged 拿到真实 id 才写 keyed。

#### [P2] RUST-5：Scheduler.tasks HashMap 永不清理，长会话无界内存增长
- 位置：`crates/kode-scheduler/src/scheduler.rs:442`（insert），全文无 remove
- 证据：终态任务（Cancelled/Completed/Failed）永久留在 tasks，只有 `run.take()` 释放闭包；高频 didChange 下任务数随编辑线性增长、无 prune/上限。
- 修复建议：终态任务在快照/台账消费后摘除（或保留环形窗口）。

#### [P2] RUST-6：InvalidationGraph::affected_by 只做单级反向传播，不取传递闭包
- 位置：`crates/kode-scheduler/src/invalidation.rs:67-83`
- 证据：A 调 B、B 调 C，改 C 只把 B 计入 affected；对 B 的重建不产生变更事件，也不再次触发 affected_by → A 的索引/调用图保持陈旧，直到 B 文件本身被编辑。
- 修复建议：对 affected 做闭包迭代（工作表至不动点），或重建任务完成时递归触发受影响文件。

#### [P3] RUST-7：KbeCrossProcess 边永不产生跨文件反依赖
- 位置：`crates/kode-python/src/graph.rs:93-95`
- 证据：`receiver.starts_with("self.")` 一律返回 caller_file；KBEngine 语义中 `self.cell.xxx()` 的 cell 实现在另一文件（base/Monster.py vs cell/Monster.py），改 cell 侧不会失效 base 侧调用方。代码已自述该启发式，属已知取舍，但按引擎语义是漏报面。

#### [P3] RUST-8：dataflow 的 Raise/Assert 表达式读取漏记
- 位置：`crates/kode-python/src/dataflow.rs:247-248`
- 证据：归入 no-op，但 `raise err`/`assert cond, msg` 中 err/cond/msg 是真实读（callgraph 侧是走的）。

#### [P3] RUST-9：except 捕获名的 def 行号用了 try 语句行号
- 位置：`crates/kode-python/src/dataflow.rs:206-211`
- 证据：`except E as e:` 的 def_var("e", line) 记到 try 行而非 handler 行，下游跳转/诊断错行。

#### [P3] RUST-10：dataflow 不处理 lambda 参数遮蔽
- 位置：`crates/kode-python/src/dataflow.rs:399`
- 证据：lambda 体内对外层同名变量的 use 连到外层链；形参遮蔽（外层有 x，`lambda x: x+1`）时错误连接。

#### [P3] RUST-11：dataflow 对 global/nonlocal 声明后的赋值按局部 def 建模
- 位置：`crates/kode-python/src/dataflow.rs:249-250` + collect_writes
- 证据：`global x; x = 1` 产出假局部 def 链，与"全局不被跟踪"承诺矛盾。

#### [P3] RUST-12：callgraph 嵌套 def 继承外层 caller_class，产生伪 (class, nested-name) 边
- 位置：`crates/kode-python/src/callgraph.rs:247-250`
- 证据：方法体内的嵌套函数调用边 caller_class 仍是外层类名，形成 `(Foo, inner)` 不存在的方法条目；测试 nested_def_calls_recorded 只覆盖模块级嵌套。

#### [P3] RUST-13：callgraph 对 lambda 与嵌套 def 的调用方归属口径不一致
- 位置：`crates/kode-python/src/callgraph.rs:309`
- 证据：嵌套 def 以自身名为独立 caller，lambda 体调用归外层 caller。

#### [P3] RUST-14：method_params 文档注释与实现顺序不符 + run 闭包 panic 卡死调度器
- 位置：`crates/kode-python/src/symbols.rs:159`（注释错）；`crates/kode-scheduler/src/scheduler.rs:646-686`
- 证据：注释称 posonly→pos→kwonly→vararg→kwarg，实现是 posonly→pos→vararg→kwonly→kwarg；`run(&cancel)` panic 时 running 永 Some、任务卡 Running、keyed 卡 Queued（无 catch_unwind），索引构建闭包 panic 即永久卡死调度。
- 修复建议：改注释；panic 用 catch_unwind 包裹按 Failed 终态落账。

**RUST 路备注**：①plan_dependency_tasks（invalidation.rs:129-135）changed 文件与依赖同批（max_batch>1）时整批被标 DependencyUpdate，changed 文件丢失 SingleFileUpdate 优先级，建议强制单独成批；②journal 扩展名拼接对无扩展名路径产生 `xxx..tmp` 临时名（无功能影响）。**确认无问题**：parse.rs、model.rs、symbols.rs 其余、callgraph 其余、journal.rs、golden.rs、invalidation 其余、两 crate 测试覆盖面（逐条核对上述发现均未被现有测试锁定）。

### TS 索引路（pythonClassIndex / entityMapping / workspaceIndex / globalDataIndex 等）— 3 P1 + 2 P2 + 7 P3

#### [P1] IDX-1：removedRootKeys 永不清理，根移除后重新加入的资产根永久无法建索引
- 位置：`src/entityMapping.ts:215/:462-470/:528/:1190-1201`；接线 `src/extension.ts`（applyActiveProfileToIndexInput 与 kbengine.assetsRoot 配置变更）
- 证据：`removedRootKeys` 全文件仅一处 `add`（removeRoot），无 delete/clear；buildIndex:528 `if (isUnderRemovedRoot(defPath)) return null`。profile A→B→A 切换时 A 的根先被拉黑，再重新 registerRoot+分块 parseDefFile，但每个 .def 都被拦成 null；工作区文件夹"移除再加回"同样命中。
- 影响：该根下所有实体索引/语义投影/defParseCache 永久为空（jump/hover/CodeLens 全落空），直到重启窗口；pythonClassIndex/globalDataIndex 的 removeRoot 无此黑名单，仅实体面中招。
- 修复建议：根重新登记时从 removedRootKeys 删除对应键。

#### [P1] IDX-2：ensureCompositionRoots 连续 8 次让位后未落地，rootsPromise 不清空 → 组合根查询永久空
- 位置：`src/pythonClassIndex.ts:704-778/:779-781/:640-662`
- 证据：循环 8 次每次 epoch/token 变化即 continue；循环正常退出后只打日志"按最后一次输入落地"，rootsMap/rootsByScope 从未写入、rootsPromise 也没清。之后所有调用走 join 分支 await 已 resolve 的旧 promise 直接返回，rootsMap 恒 null → self 方法解析②段恒空集，直到某次无关 resetRoots 才解锁；compositionMetrics 未 end，且每次失败尝试重跑 3 个 findFilesAcrossRoots 全仓发现。
- 修复建议：循环退出后按最后快照落地并 end metrics；或失败时置 rootsPromise=null 允许重试。

#### [P1] IDX-3：WorkspaceIndex 首扫完成后才挂 watcher，初扫窗口内磁盘变更永久漏事件
- 位置：`src/workspaceIndex.ts:119-137`（watcher 在 `await Promise.all` 之后创建）
- 证据：扫描读旧字节到 watcher 挂载之间的窗口内文件变更：无 revision 提升、收不到事件 → cache 旧内容且无自愈。globalDataIndex.ts:1617-1637（AUD-074）已明确认定并修复同款问题，WorkspaceIndex 未同步。
- 修复建议：对齐 AUD-074 口径，watcher 挪到扫描前，或扫描后对 cache 条目做 stat 指纹复核。

#### [P2] IDX-4：单文件 invalidate 作废整个扫描代 + loadFile 无短路，每关一个 .py 触发全仓重发现+全量重解析
- 位置：`src/pythonClassIndex.ts:496-499/:400-418/:905-937/:1098-1146`
- 证据：onDocumentClosed 对每个关闭的 .py 调 invalidate → scanGeneration 前进 → 下次 resolveSelfMethodResolution 重跑全仓发现+全部分块 loadFile（未变更文件也被重读重解析）。
- 修复建议：单文件失效只重载该文件，或 loadFile 加 mtime/size 指纹短路。

#### [P2] IDX-5：GlobalDataDictIndex 初扫进行中 removeRoot，已移除根的文件被以空根身份"复活"进倒排
- 位置：`src/globalDataIndex.ts:1643-1652/:2002-2048/:1702/:1718`
- 证据：scanWorker 无 generation 复核；removeRoot 升 generation 只清当时 cache，在飞的初扫对未开始文件以新一代 generation 通过守卫，commitFile 以 resolveScopeRoot（=''）为键提交，违反 AUD-071 语义。
- 修复建议：scanWorker 循环头加 generation 复核。

#### [P3] IDX-6：sharedFileEvents 盘上版本核对用 statSync（watcher 事件热路径同步 IO）
- 位置：`src/sharedFileEvents.ts:42-49/:110/:117`

#### [P3] IDX-7：classifySemanticFile 对 entities.xml 缺 `/` 前缀锚
- 位置：`src/dependencyGraph.ts:34`（`endsWith('entities.xml')`，types/alias 都带 `/`）——`xxxentities.xml` 误判。

#### [P3] IDX-8：resolveSymbol 不支持 `from . import mod` 兄弟模块形态
- 位置：`src/pythonParser.ts:147-155` + `src/pythonClassIndex.ts:310-337/:301`——`from . import helper; helper.Cls()` 跳转落空。

#### [P3] IDX-9：getKbeAliases 不识别 `import os, kbe` 逗号多模块行
- 位置：`src/kbeModuleIndex.ts:410`——该写法下 kbe 别名不注册，整文件静默不接管。

#### [P3] IDX-10：发现链缓存会话内不随文件系统失效
- 位置：`src/workspaceDiscovery.ts:225/:279-287` + `src/scanRoots.ts:96-104`——中途新建 entity_defs 发现不到；瞬时失败(null)被记忆到会话结束。

#### [P3] IDX-11：GlobalDataDictIndex.rebuild 无界并发
- 位置：`src/globalDataIndex.ts:2076`——`Promise.all(files.map(indexFile))` 无限流，瞬时句柄/内存峰值。

#### [P3] IDX-12：getDefinitionWorkspaceLayout 无缓存，悬停热路径每次多条 fs.existsSync
- 位置：`src/definitionWorkspace.ts:170-270/:355-414`

**IDX 路备注**：pathIdentity 不折叠 `..`；pythonExtraPaths 差量比较大小写敏感（Windows 重复共存边缘）；workspaceIndex.noteSaved 挂 onDidChangeTextDocument 每键两遍正则（大文件可观测开销，既有取舍）。**确认无问题**：semanticIndex、documentStore、compositionRoots、pythonScanRules、atomicFileWrite、workspaceGate、sharedFileSnapshot、indexScheduler、scanRoots、pathIdentity/pythonExtraPaths（备注级）、workspaceIndex 其余、kbeModuleIndex 其余、globalDataIndex/entityMapping/pythonClassIndex 已修路径复核通过。

### TS 运行时路（热更新 / 进程 / 调试 / 远程 / 监控 / 日志）— 2 P1 + 5 P2 + 8 P3

#### [P1] RT-1：logWebView formatLogEntry 双注入点未转义（XSS）
- 位置：`src/logWebView.ts:602-605`
- 证据：`title="${log.raw}"` 与 `${log.component.toUpperCase()}` 直接拼进 innerHTML，未经 escapeHtml；log.raw 来自引擎日志原始行。
- 影响：恶意/被污染日志行 `"><img src=x onerror=...>` 打开日志面板即触发注入。
- 修复建议：title 与 component 一律 escapeHtml，或改 DOM textContent 构建。

#### [P1] RT-2：processManager.stop() 缺退出兜底，可能永久挂起
- 位置：`src/processManager.ts:336-365`
- 证据：`await exited` 等 'exit'；taskkill 启动失败/spawn 失败时进程对象只发 'error' 不发 'exit'，exited 永不 resolve。
- 影响：stop/restart 永久挂起，UI 停止/重启失效，后续启动编排阻塞。
- 修复建议：exited 加超时兜底，'error' 事件中 resolve。

#### [P2] RT-3：hotReloadRetryCommand 重试路径绕过 def 结构闸（HOT-005）
- 位置：`src/hotReloadRetryCommand.ts`（resendHotReloadTarget）
- 证据：fire 路径发送前经 gateDefChanges（def 结构指纹闸）；重试直接 resend 上次 target，不重跑结构闸。
- 影响：结构性 def 变更首次发送失败后经"重试"通道以普通 reload 下发。
- 修复建议：resend 复用与 fire 相同的 gateDefChanges 判定。

#### [P2] RT-4：debugConfig 硬编码默认 telnet 密码 'ucs775502'
- 位置：`src/debugConfig.ts`（getComponentConfig 回落值）
- 证据：未配置时默认回落源码硬编码密码写入生成配置；凭据固化进源码与 launch.json，secret scanning 必报。
- 修复建议：不做默认回落，缺密码提示显式配置。

#### [P2] RT-5：updateLaunchJson 按名称前缀清理误删用户自有配置
- 位置：`src/debugConfig.ts`（updateLaunchJson 清理逻辑）
- 证据：按 `config.name.startsWith('KBEngine:')` 过滤删除；用户以该前缀自命名的配置被静默删除。
- 修复建议：自动生成条目加隐藏标记（如 kbengineGenerated:true），按标记清理。

#### [P2] RT-6：monitoringWebView 多字段未转义 + JSON 注入 + 无 CSP + CDN 脚本
- 位置：`src/monitoringWebView.ts:1034-1120`（formatMetricCard）、:601-602（script 注入）、:243（CDN）
- 证据：`metric.component.toUpperCase()`、componentType、status、internalAddress 未转义；`JSON.stringify(metrics)`/historySeries 直接插入 `<script>`（`</script>` 可逃逸）；Chart.js 从 cdn.jsdelivr.net 加载且全文件无 CSP。
- 修复建议：插值统一 escapeHtml；JSON 把 `<` 换 `\u003c`；Chart.js 本地打包 + 严格 CSP。

#### [P2] RT-7：monitoringWebView/logWebView 过滤输入每键全页重渲丢焦点
- 位置：`src/monitoringWebView.ts`（keywordFilter）、`src/logWebView.ts`（search + collector.onLogEntry）
- 证据：input 每键整页 HTML 重写，焦点/光标丢失；日志高频到达走全页重渲。
- 修复建议：局部 DOM 更新；高频路径节流 + append-only。

#### [P3] RT-8：noteStillUnverified 产生 "undefined | reason" 文案
- 位置：`src/hotReload.ts:298` 附近；同款 `src/hotReloadRetryCommand.ts:60-65`。修复：`[current.detail, reason].filter(Boolean).join(' | ')`。

#### [P3] RT-9：hotReload channel 路径缺 applied digest 核验与 settle 调度
- 位置：`src/hotReload.ts`（sendViaChannel）——收到 accepted 即终态，两路径状态语义不一致。

#### [P3] RT-10：重试路径 sentAt 与 fire 路径取时点不一致
- 位置：`src/hotReloadRetryCommand.ts`——统一 sentAt 语义并注释固化。

#### [P3] RT-11：serverManager.startComponent statSync 在 try 之外（TOCTOU）
- 位置：`src/serverManager.ts:590` 附近——existsSync 与 statSync 之间文件被删抛未捕获异常。

#### [P3] RT-12：telnetWebView 部分插值未转义 + querySelector 拼接
- 位置：`src/telnetWebView.ts`——数据源为本地配置，可利用性低；统一 escapeHtml + CSS.escape。

#### [P3] RT-13：monitoring/log/telnet 三个 webview 均无 CSP meta
- 修复建议：各加最小 CSP（或 nonce 内联）。

#### [P3] RT-14：telnetClient.connect() 无连接超时
- 位置：`src/telnetClient.ts`——connect 内加 socket 超时，失败即 destroy。

#### [P3] RT-15：quickActions 后台终端 id 重入复用旧终端 + Windows `%` 未转义
- 位置：`src/quickActions.ts`——明确终端复用语义；Windows 分支 `%`→`%%`。

**RT 路确认无问题**：hotReloadTargetState/AppliedCheck/Receipt/Delivery/Transport/FileState/DefHash/DefStructure/Status/BatchSummary*/RevisionEvidence*/ChannelConfig/TempEdit/FileDecorations/Retry、debugAttachGuard/debugSessionRegistry/debugConfigBootstrap/debugStatusBoard/debugStatusTree/debugTargetFocus/debugJsonSchema、debugpy*/autoDebugpy、remoteConnection/sshConfig/remoteProcessList/pyspyDump/cpuProfileCapture（spawn 数组无 shell 注入）、telnetService/telnetTree/webviewConsoleBridge、quickActionConfig/Scanner/Tree、httpRequests/httpRequestService/variableSubstitution/hooks/kbengineStartupScript/launchDependencies/buildTask*/buildCommit、processTopologyDiagnostics/Rust、serverCommandTarget、monitoringCollector、logCollector/logParser/logErrorScan（转义完整）、remoteServerTree。


### TS UI 路（extension / languageProviders / webview / 诊断）— 1 P1 + 5 P2 + 11 P3（其中 3 项与运行时路重复发现，已合并标注）

#### [P1] UI-1：logWebView 将远端日志原文未转义注入 HTML 属性 → webview XSS（与 RT-1 同项，两路独立发现）
- 位置：`src/logWebView.ts:602`（`title="${log.raw}"`）、:605（`${log.component.toUpperCase()}`）
- 证据：`log.message` 走 escapeHtml，但同模板 title 与组件名直接插值；log.raw 是 KBEngine logger 经网络下发的原始日志行。该页面 enableScripts:true 且无 CSP（对照 `webview/defCallChainProvider.ts:293` 的 nonce CSP 是仓内正确范本）。
- 影响：连接恶意/被劫持服务端查看日志即触发 webview XSS（可 postMessage 到宿主命令面）。
- 修复：title/component 过 escapeHtml；同批给全部自建 webview 补 CSP。

#### [P2] UI-2：三个 webview 无 CSP + CDN 脚本 + mermaid securityLevel:'loose'（供应链与离线双风险）
- 位置：`src/entityDependencyWebView.ts:1052/:1091`、`src/entityFlowWebView.ts:276/:305`、`src/monitoringWebView.ts:243`
- 证据：mermaid/chart.js 从 cdn.jsdelivr.net 加载 + 无 CSP meta + mermaid `securityLevel:'loose'` 且 htmlLabels:true；图文本来自工作区 def/entities 派生（label 直接拼 `${node.label}` 未转义）；`entityDependencyWebView.ts:867` statCard 的 mostReferenced（实体名）未转义直进 HTML。
- 影响：CDN 供应链风险 + 离线环境图失效 + Marketplace 审核红线；潜在标签注入。
- 修复：mermaid/chart.js 打进离线包（参照 defCallChainViewer 的 esbuild 单文件方案），补 nonce CSP，securityLevel 改 strict，statCard 补 escapeHtml。

#### [P2] UI-3：monitoringWebView 服务器返回字段未转义直拼 HTML/内联脚本（与 RT-6 同项，两路独立发现）
- 位置：`src/monitoringWebView.ts:1058/:1063/:1067/:1114`（formatMetricCard 的 component/componentType/status/internalAddress）、:601-602（`JSON.stringify(metrics)`/historySeries 直插 `<script>`）
- 证据：metric 字段来自引擎组件 watcher/monitor 接口响应（外部数据）；JSON.stringify 不转义 `<`，字段值含 `</script>` 即断开脚本上下文。
- 修复：字段全过 escapeHtml；JSON 用 `.replace(/</g,'\\u003c')`。

#### [P2] UI-4：多根工作区无文档上下文的快照/拓扑查询一律落第一个根（串根/漏检）
- 位置：`src/extension.ts:~1626/:~1645/:~1746/:2593`（processTopology 诊断等 getWorkspaceRootForDocument() 无参）、`src/databaseSimulator.ts:739`、`src/entityDependencyWebView.ts:697/:752`、`src/entityFlowWebView.ts:105`、`src/entityDependency.ts:105`
- 证据：getWorkspaceRootForDocument(undefined) 恒回退 workspaceFolders[0]。多根 A/B 各有同名实体/同名 process_topology.xml 时，.dbsim 虚拟文档、拓扑诊断、依赖图面板永远读 A 根。
- 影响：B 根用户的模拟表结构/拓扑诊断/依赖图来自错误项目（静默错数据）。
- 修复：命令入口把活动编辑器/所选实体的根传下去（AUD-055 的 root 参数模式可复用）。

#### [P2] UI-5：配置变更监视缺口——改 kbengine.entityDefsPath / entitiesXmlPath 后索引与 schema 缓存不失效
- 位置：`src/extension.ts` 配置 onDidChangeConfiguration 失效分支（只列 assetsRoot/db/binPath/configPath；:4004-4012 的 resetDatabaseInterfaceConfigCache 段同）
- 证据：布局解析读取 entityDefsPath/entitiesXmlPath（writeDiscoveryReport:5318-5319 证实），改这两键改变 def 发现根，但共享索引/schema 快照的 rootConfigGeneration 不感知。
- 影响：改配置后悬停/诊断/schema 一直用旧根数据，直到重载窗口。
- 修复：两键加入失效清单（invalidate schema 缓存 + 触发 index 输入重算）。

#### [P2] UI-6：inferPipeline watcher 无防抖、无并发互斥
- 位置：`src/inferPipeline.ts:430-441`（'**/*.py' 三事件直呼 syncInferredCopy）
- 证据：每次 py 变更即全量 listSourceFiles+内容比对镜像同步；async 无排队——连续保存时多轮并发执行，plan(复制/覆盖/删除) 与另一轮写入可交错（并发 unlink 与 writeFileSync 同路径竞态）。
- 影响：大工作区每次保存全树扫描；stale 删除可能误删正在写的目标。
- 修复：加 debounce + 在途互斥（在途时记 dirty，结束后补一轮）。

#### [P3] UI-7：extension.ts 收尾对 serverManager 重复 dispose
- 位置：`src/extension.ts:5521-5522` 附近：`serverManager.dispose(); await serverManager.dispose();`——明确笔误，依赖幂等性。

#### [P3] UI-8：selfAttributeNoneDiagnostics 在未掩码原文上匹配 self.x.y → 字符串/注释假阳性
- 位置：`src/selfAttributeNoneDiagnostics.ts`（SELF_MEMBER_ACCESS 直接跑原始行；对照 receiverNoneDiagnostics 全程用 pythonLexicalMask 掩码）——文档字符串/注释里的 self.hp.name 示例产假诊断。

#### [P3] UI-9：selfAttributeFlowTypes 增强赋值误当普通赋值，流类型重置为未知
- 位置：`src/selfAttributeFlowTypes.ts`（selfAssignment 正则未排除 `+=`/`-=`）——`self.items += [x]` 捕获 RHS "+ [x]" 解析不出 → 属性流类型清空（保守假阴性）。

#### [P3] UI-10：typeInlayHints 不消费 CancellationToken + 全文重复解析
- 位置：`src/typeInlayHints.ts` provideInlayHints（无 token 参数、每次 getKbeAliases 全文解析 + 冷索引 await）——慢索引下 inlay 请求不可取消。

#### [P3] UI-11：事件定义跳转全仓逐文件 openTextDocument
- 位置：`src/eventApi.ts:64-88`（findFiles('**/*.{py,def}') 后逐个 openTextDocument+全文正则，无取消无缓存）——大仓 F12 秒级卡顿。

#### [P3] UI-12：内建属性 inlay 在注释/字符串里产提示
- 位置：`src/entityBuiltinProperties.ts:206-233`（原文行正则；调用点 languageProviders.ts:726 传原文行）——注释 `# self.id` 也挂 inlay。

#### [P3] UI-13：logWebView collector 路径每条日志整页重渲（与 RT-7 部分同项）
- 位置：`src/logWebView.ts:51-56`（collector.onLogEntry → 全量 applyFilter+getHtml 重建整页）；logHub 路径已有增量 appendLogs+背压（:61-103），collector 直连路径没走。

#### [P3] UI-14：entityDependency 继承深度统计恒为 1（代码内已登记未修）
- 位置：`src/entityDependency.ts:343-361` calculateMaxDepth（种子只对无 parent 实体调用，递归臂不可达，istanbul ignore 自证）——依赖图"最大继承深度"永远显示 1。

#### [P3] UI-15：pythonReturnTypeInference 赋值检测跑在原始行文本上
- 位置：`src/pythonReturnTypeInference.ts`（ASSIGNMENT_PATTERN 对原始行匹配，maskCodeLine 只用于捕获后 RHS）——三引号字符串内 `x = ...` 误判为赋值，局部变量悬停假阳性。

#### [P3] UI-16：悬停/定义侧事件统计与数据字典检测口径不一致
- 位置：`src/languageProviders.ts` provideKnownHover（每次悬停 findEventCalls 全文扫描；数据字典 hover 用行级 getKbeDataDictAccessAtPosition 而 definition 用全文 getDataDictAccessInCodeContext）——性能小 + 同一位置 hover/定义行为可能不一致。

#### [P3] UI-17：projectProfiles.create() 丢弃入参 hotReload
- 位置：`src/projectProfiles.ts:115-122`（ProjectProfileInput 含 hotReload，created 字面量未拷贝；当前两处调用未传，属潜在）。

**UI 路确认无问题**：webview/defCallChainViewer（nonce CSP+strict，正确范本）、runtimeQueryWebView（有 CSP+textContent）、telnetWebView（风险极低）、quickActionTree、explorerProviders、entityFlowGraph、entityTypeStubs、pythonTypeStubs、database 全家（databaseSchema 快照/双轴过期/AUD-055 根身份、SchemaCore 引擎语义对齐严谨、Drift/QueryLifecycle/ConnectionRegistry SQL 注入经白名单+multipleStatements:false 排除、Simulator 转义/BigInt 边界正确）、流分析四件、serverConfig 组（summarizeFinalTelnet 明文密码展示为用户明令功能，reproductionSummary 双层凭据遮蔽合规）、profileHealth/profileInterpreter/activeProfile/workspacePath/managedDir*/hostVitals/fileReadMetrics/performanceBenchmark/navigationLog/reproductionSummary/typeStorageIndexWatchers/watcherProtocolAudit/eventIndexTypes/jsoncAssociation/annotationSourceLog/pyreflyInfer。extension.ts/languageProviders.ts 已全量精读，结论并入上述条目。无 P0。

### TS def/协议/生成器路（对照引擎源码逐条验证）— 4 P1 + 4 P2 + 5 P3

#### [P1] DEF-1：messageTable 接口 def 提前 return，跳过引擎会装载的接口 Components 与嵌套 Interfaces
- 位置：`src/messageTable.ts:605-608`（loadDefIntoModule）、:464-491（buildMessageTableInRust 闭包发现）
- 证据：`if (originKind === 'interface') { return; }` 在接口递归与组件槽注册之前。引擎 loadInterfaces 对每个接口：loadAllDefDescriptions 后 `if (!ignoreComponents)` 调 loadComponents（默认 false，entitydef.h:105），并递归 loadInterfaces 进接口自身 def 的 `<Interfaces>`（entitydef.cpp:611-638，已核对原文）。buildMessageTableInRust 闭包注释"引擎不递归接口自身"与引擎源码矛盾。
- 影响：实体实现了带 `<Components>` 或嵌套 `<Interfaces>` 的接口时，消息表/属性表 utype 分配与引擎不一致——后续所有属性/方法的 utype、aliasID、客户端属性集合整体错位；Rust 主路径与 TS 回退路径均受影响。
- 修复：接口分支不提前 return（保留 visited 去重），继续走接口递归 + registerComponentSlot；父类递归仍跳过（引擎 loadInterfaces 不调 loadParentClass）；同步修 Rust 侧闭包发现与注释。

#### [P1] DEF-2：parseProfileFrame cprofile 分支漏读 timingLength，行数据整体错位
- 位置：`src/kbengineProtocol.ts:651-663`（resultKind===1 fall-through 分支）
- 证据：pyprofile(0)/eventprofile(2)/networkprofile(3) 分支都在 rows 前读 `readUInt32()` 作 timingLength；cprofile 分支直接读 rows。引擎 CProfileHandler::timeout 写顺序为 int8 type(=1) + uint32 timinglen_ + ArraySize size + 行数据（profile_handler.cpp:96-97/152-155，已核对）。
- 影响：打开 cprofile 结果行数读成 timinglen 字节值、每个 float 偏移错 4 字节，预览全乱。
- 修复：cprofile 分支先 readUInt32() 再读行数组。

#### [P1] DEF-3：entityWizard 新向导生成 `<position>` 属性，触发引擎受限属性拒绝
- 位置：`src/entityWizard.ts:96-99`（commonPropertyLines）
- 证据：模板输出 `<position> VECTOR3 CELL_PUBLIC_AND_OWN`；position/direction/spaceID 属 ENTITY_LIMITED_PROPERTYS（kbe/src/lib/entitydef/common.h:125-157），引擎对用户 def 声明这些名字直接报错、实体装载失败。codeGenerator.ts 的 avatar 模板有注释避开这三个属性，新向导没有；且与扩展自身 defAnalyzer 的受限名检查矛盾。
- 影响：新向导创建的实体 def 引擎无法加载（baseapp/cellapp 启动报错）。
- 修复：commonPropertyLines 移除 position（引擎自动提供）。

#### [P1] DEF-4：defCallChain 方法体切片无下界，兄弟方法的调用被误归属
- 位置：`src/defCallChain.ts:118-135`（receiverCallsInMethod）
- 证据：`lines.slice(methodBlock.line)` 只切起始行，未用 parsePythonMethodBlocks 已算出的 endLine 截尾；该方法之后所有方法体都被当作当前方法的调用来源。无测试覆盖。
- 影响：同脚本内后续方法的 receiver 调用（cell↔base）产生虚假 call-chain 边，调用链视图/跳转错误。
- 修复：`lines.slice(bodyStart, methodBlock.endLine)`。

#### [P2] DEF-5：defReferenceGraph 组件/接口 Parent 解析目录与引擎不一致
- 位置：`src/defReferenceGraph.ts:176-225`
- 证据：父类候选硬编码 category:'entity' → 目录恒 defsRoot；引擎 loadComponents 中组件 Parent 在 `defFilePath + "components/"` 下解析（entitydef.cpp:713/765），接口 def 的 `<Parent>` 引擎完全不处理。
- 影响：组件 Parent 链接解析不到；接口 Parent 产生引擎不存在的继承链接。
- 修复：按来源 category 决定父类目录，接口 def 忽略 Parent。

#### [P2] DEF-6：definitionSemantics 合并接口 def 的 `<Parent>`，引擎不可见
- 位置：`src/definitionSemantics.ts:604-607/:427-433`
- 证据：接口 def 的 Parent 被 parentCategory='component'|'entity' 合并进语义；引擎只取属性/方法/组件/嵌套接口。
- 影响：扩展推导的继承语义（成员归属、重载判定）与引擎运行时不同。
- 修复：interface 语义解析时丢弃 Parent 引用（或标注引擎无效）。

#### [P2] DEF-7：clientSdkGenerator 实体 SDK 类不合并父类/接口成员，也不生成 extends
- 位置：`src/clientSdkGenerator.ts`（组件属性有 parseClientSdkComponentProperties 递归，实体无对应逻辑）
- 证据：引擎实体成员 = 本身 + 父链 + 接口闭包 + 组件槽；SDK 只输出实体自身 def 的成员。
- 影响：继承/实现接口的实体生成的客户端 SDK 缺少父类与接口的属性/方法，客户端按 SDK 编码会运行时调用不存在的成员。
- 修复：沿 parent/interfaces 引用递归收集成员并生成 extends。

#### [P2] DEF-8：codeGenerator 旧版向导类名/文件位置与引擎约定不符
- 位置：`src/codeGenerator.ts`（generatePythonContent legacy 分支）
- 证据：在 scripts/<Name>.py 生成 class <Name>Cell/<Name>Base 平铺类；引擎按 scripts/{base,cell}/<Entity>.py、模块内类名 == 实体名查找。新 runNewEntityWizard 是正确的。
- 影响：仅用 legacy 生成的脚本引擎加载不到实体类（no script <Entity>）。
- 修复：legacy 分支对齐新向导目录与类名，或移除 legacy 路径。

#### [P3] DEF-9：defParser tokenizeXml 正则不处理注释/CDATA/属性值中的 '>'
- 位置：`src/defParser.ts`（`[^>]*` 在属性值含 `>` 时提前终止标签）——极端 def 下位置表 desync，仅影响诊断定位精度（解析本体走 fast-xml-parser 不受影响）。

#### [P3] DEF-10：defChain 不收集接口 def 自身的嵌套 Interfaces
- 位置：`src/defChain.ts`（collectFlatDecls 只在入口+父链调用）——嵌套接口成员不进链式视图。

#### [P3] DEF-11：defSymbolReferences 只识别 `<Interface>` 一种包装名
- 位置：`src/defSymbolReferences.ts`——引擎接受 interface/Interface/type/Type 四种（entitydef.cpp:559-561）；defRenamer 已对齐可复用其常量。

#### [P3] DEF-12：generatedSourceMap 硬编码 line 0/2 且全部覆盖 key 0
- 位置：`src/generatedSourceMap.ts`——多类 stub 文件时 CodeLens 指向最后一个类；其余行永远无 lens。修复：按实际类起始行分配。

#### [P3] DEF-13：clientSdkGenerator `<Arg>ARRAY<of>X</of></Arg>` 只取到 "ARRAY"
- 位置：`src/clientSdkGenerator.ts`（getScalarChildValues 对嵌套元素只返回首个文本）——数组参数方法 SDK 类型标注退化。修复：Arg 解析识别 `<of>` 子元素。

**DEF 路确认无问题（约 30 个文件）**：defParserWorker/Host、defAnalyzer（受限名与继承冲突矩阵对齐 scriptdef_module.cpp）、defCallChainProvider/ViewLogic、defMethodConsistency、defParamInlayHints、defPythonParity、defMd5Rust、defRenamer、definitionWorkspace、messageTableEntity/Export/Preview、engineApiMetadata、engineCompatibility（METHOD_LOAD_ORDER Cell→Base→Client 已实证一致）、entityTypeStubs、pythonTypeStubs、snippetGenerator、projectCreate/Import/Template、sdkGenerationProfile、sdkMessageNumberAudit、rootConfigGeneration、entitiesXmlAnalysis、typesXmlReferences、userTypeContract/Source、entityBuiltinProperties。


### Rust 服务层路（kode-server / 其余 crates，对照引擎源码逐条验证）— 2 P1 + 2 P2 + 6 P3

**根因综述**：`def_md5.rs` 的 XML 导航把引擎 enterNode 建模成"父元素内找具名子元素"；实际语义（kbengine/kbe/src/lib/resmgr/xml.cpp:72-95）是：从传入节点开始，先检查自身 getKey(node)==key 再沿兄弟链，命中后返回该元素**第一个非注释子节点**；getKey(xml.cpp:113-119)=trim(Value)，文本节点返回文本。多数用点恰好等价而幸存，以下几处不等价。

#### [P1] RSV-1：load_interfaces 语义建模错误，接口内容整体缺失于 md5
- 位置：`crates/kode-server/src/def_md5.rs:998-1005`
- 证据：Rust 用 `child_el(doc, if_entry, "Interface"/"interface"/"Type"/"type")` 只在条目的**子元素**里找具名元素，找不到即 continue。引擎 entitydef.cpp:561-585：对真实形态 `<Interfaces><interface> ROLE </interface></Interfaces>`（fixtures Avatar.def:3-5），interfaceNode=条目 FirstChild（文本"ROLE"）→ interfaceName="ROLE" → 装载 interfaces/ROLE.def，其属性/方法并入模块 md5。元素形态 `<interface><Tank/></interface>` 同样失配（引擎取 `<Tank/>` 元素名）。
- 影响：凡使用 Interfaces 的资产（标准资产普遍），kode 的 entitydef md5 与引擎不一致；接口属性/方法完全缺席。golden 为自推导（"规范推导为权威"），测试无法暴露。
- 修复：interface_name = 条目第一个非注释子节点——文本取 trim 文本、元素取元素名；删除 child_el 具名查找。

#### [P1] RSV-2：load_components 组件类型名误取元素名 "Type"
- 位置：`crates/kode-server/src/def_md5.rs:1042-1055`
- 证据：`let component_type_name = doc.element(type_el).name.clone()` 得到字面量 "Type"。引擎 entitydef.cpp:654-671 三步导航：componentName=getKey(implementsNode)（"bag"）→ componentNode=enterNode(implementsNode,componentName) → componentTypeNameNode=enterNode(componentNode,"Type") → componentTypeName=getKey(...)（"Inventory"）。夹具 Avatar.def:42-47 `<bag><Type> Inventory </Type>`：引擎得 "Inventory"，Rust 得 "Type" → 尝试装 Type.def（失败），真实 Inventory.def 内容缺失、utype 计数失同步。对照 message_table.rs:585-597 用 node_value 取文本是正确写法。
- 影响：凡带 Components 的资产 md5 与引擎不一致，组件属性/utype 全错。
- 修复：component_type_name 取 `<Type>` 元素文本（first_text），按引擎三步导航重写。

#### [P2] RSV-3：is_entitycall 依赖可变 alias_name，别名注册后判定失效
- 位置：`crates/kode-server/src/def_md5.rs:341-347`（register）、:354-364（is_entitycall）、:543-548（types.xml 别名路径）
- 证据：register 覆写共享 TypeInfo.alias_name；is_entitycall 判 `info.alias_name=="ENTITYCALL" && kind==Builtin`。types.xml 出现 `<ENTITYCALL1> ENTITYCALL </ENTITYCALL1>` → alias_name 被覆写 → 恒 false。引擎 property.cpp:47-51 用 `getName()`，虚函数恒返回内建名（datatype.h:633），别名共享同一对象不影响判定。
- 影响：触发需 types.xml 对 ENTITYCALL 取别名（较少见）；触发后 ENTITYCALL 属性 persistent=false 覆盖失效 → isPersistent 字节失配 → md5 不一致。
- 修复：is_entitycall 改用稳定类型种类（构造即知的 TypeKind 或 type-id 集），register 不覆写类型元信息。

#### [P2] RSV-4：load_parent_class 不支持 Parent 元素形态
- 位置：`crates/kode-server/src/def_md5.rs:1173-1179`
- 证据：parent_name=first_text；`<Parent><Avatar/></Parent>` 无文本子节点 → 空串 → "parent def not found: .def"。引擎 entitydef.cpp:897-899 对该形态得 "Avatar"。主流文本形态正确，仅非标准但引擎合法的元素形态受影响。
- 修复：first_child 两分支语义（文本优先，无文本取首个子元素名）。

#### [P3] RSV-5：lint UnknownFlagValueRule 多 token 放行 vs 引擎整串查表
- 位置：`crates/kode-server/src/lint/rules.rs` vs entitydef.cpp:1137-1141——"CELL_PUBLIC|CELL_PRIVATE" 引擎拒绝、lint 放行（规则文案自己也注明引擎不支持）。修复：按引擎整串查表，'|' 形态单独出"引擎不支持"诊断。

#### [P3] RSV-6：calc_property_utype 全局重复检测比引擎严格
- 位置：`crates/kode-server/src/def_md5.rs`——引擎（entitydef.cpp:1018-1093）容忍跨模块显式重复 utype，Rust 全局查重更严 → 极少数资产 kode 报错而引擎可装载。

#### [P3] RSV-7：is_entitycall 嵌套 ARRAY 递归 vs 引擎一层 type()
- 位置：`crates/kode-server/src/def_md5.rs:357-359`——datatype.cpp:2104/2141 仅查一层 element type()。ARRAY<ARRAY<ENTITYCALL>> 的 FixedDict 键两者判定不同 → md5 分歧（边缘形态）。

#### [P3] RSV-8：kode-parser flag_domains：OWN_CLIENT/OTHER_CLIENTS 未入 cell 域
- 位置：`crates/kode-parser/src/model.rs`——引擎 ENTITY_CELL_DATA_FLAGS（entitydef/common.h:43）包含二者（process_topology.rs 自有 CELL_FLAGS 表已正确）。仅影响 IDE 域提示展示，不影响 md5/线格式。

#### [P3] RSV-9：extract_def interfaces 仅识别文本形态
- 位置：`crates/kode-parser/src/model.rs`——`<interface><Tank/></interface>` 元素形态不产出接口引用；dependency_graph 有补偿，process_topology 走 parse_def 路径会漏接口节点。与 RSV-1 同根。

#### [P3] RSV-10：python_callgraph file_stem 仅按 '/' 分割（防御性提示）
- 位置：`crates/kode-server/src/python_callgraph.rs`——注释声明 Windows 由调用方统一斜杠；若上游遗漏归一化，反斜杠路径 stem 失真 → caller 匹配落空。非缺陷，登记防回归。

**RSV 路确认无问题（已核对）**：wire_codec.rs（与 memorystream.h/bundle.cpp 逐项一致，含 65535 扩展长度阈值、readBlob 截断容忍）、client_sdk.rs（slot_type_name 与 enterNode 语义一致；别名链与 TS clientSdkGenerator.ts:432-456 对拍一致）、database_schema.rs（与 entity_table_mysql.cpp 全项一致：根表/六列 VECTOR/子表命名/组件表跳过/STRING 255/ENTITYCALL 不落列）、dependency_graph.rs、process_topology.rs（活动栈环保护在位、CELL_FLAGS 与引擎一致）、server.rs/rpc.rs/main.rs（畸形输入均回错不 panic）、message_table.rs（父链环守卫、接口不递归与引擎一致——注意：TS 侧 messageTable.ts 的同功能实现见 DEF-1，Rust 侧一致而 TS 侧不一致，两侧行为分叉本身即是风险）、lint/mod.rs 其余规则、bin/、kode-vfs 全部（uri/store/disk/walk/line_index）、kode-protocol FrameDecoder（重同步/上限正确）、kode-parser xml.rs 状态机、kode-root 全部（有界扫描+symlink 护栏+敏感目录台账）、kode-index（槽位回收/倒排差量清理正确）、kode-types（三色 DFS/环诊断）、kode-corpus 全部。

**覆盖度说明**：tests/ 目录、hover/completion/definition/diagnostics 深度语义未逐行精读（已做 panic 路径定向扫描，仅 golden 序列化受控 expect，未见问题）；message_table.rs 的 utype/aliasID 分配段为快速通读。

## 四、汇总与修复优先级建议

### 数量统计（全量，去重前）

| 路线 | P1 | P2 | P3 |
|---|---|---|---|
| 自查（桥接/调度器/解析/测试执行/CSP） | 0 | 2 | 6 |
| Rust 核心（kode-python/scheduler） | 0 | 6 | 8 |
| Rust 服务层（kode-server 等） | 2 | 2 | 6 |
| TS 索引 | 3 | 2 | 7 |
| TS def/协议/生成器 | 4 | 4 | 5 |
| TS 运行时 | 2 | 5 | 8 |
| TS UI | 1 | 5 | 11 |
| **合计** | **12** | **26** | **51** |

重复项（两路独立发现，已在文内标注）：logWebView XSS（RT-1=UI-1）、monitoringWebView 注入（RT-6=UI-3）、webview 每键全页重渲（RT-7≈UI-13/RT-7）、typeInlayHints 重复解析（自查 UI 路印证）。去重后净数约 85 项。

### 建议修复顺序

1. **P1 立即修（12 项）**：
   - 引擎语义硬伤（改动即错）：DEF-1 消息表接口 utype 错位、DEF-2 cprofile 帧解析、DEF-3 向导生成受限属性、RSV-1/RSV-2 def_md5 语义
   - 索引可用性：IDX-1（根拉黑不释放）、IDX-2（组合根永久空）、IDX-3（watcher 晚挂）
   - 安全/挂起：RT-1（logWebView XSS）、RT-2（stop 挂起）、DEF-4（call chain 误归属）
2. **P2 本迭代**：竞态类（IDX-4/5、UI-6）、双轨正确性（RUST-1~6，尤其 scheduler id=0 卡死与无界内存）、多根串根（UI-4）、凭据硬编码（RT-4）、误删用户配置（RT-5）、def 结构闸绕过（RT-3）
3. **P3 择期**：转义/CSP 批量加固（一个批次统一做全部 webview）、解析精度、注释/文档修正、前瞻性预留

### 审核方法与可信度说明

- 全部引擎语义分歧（DEF/RSV 路）均已打开 `D:/workspaces/kbengine/kbe/src` 对应 C++ 文件核对行号后断言，非凭记忆。
- 全部 TS/Rust 发现均给出 file:line 与触发路径；已知已修项（b26396e/dd869b5/6a2e005/fb8c9d0/60a6569/3cc6735/02dd105/48d62f3/4d62ade/a7786a7/d08e315/b4f80f4/3629636/b645b33 等）与已知开放项（KODE-PERF/HOT/FEAT/DBG/I18N/ARCH）未重复上报。
- 各路均附「确认无问题文件」清单，负面结论同样经过精读而非抽样。
