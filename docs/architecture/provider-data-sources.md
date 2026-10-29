# Provider 数据源与副作用清单

- 基线:1813-10-29,ARC-001..005 收敛后(`499d34a`;PDBG-004 增 RemoteServerTreeProvider 并对账全部构造位行号)。性质:描述**当前代码事实**,不是设想稿;与 docs/architecture/semantic-index.md(数据面与调度面)互补,本页回答「每个 provider 查哪些数据、允许造成哪些副作用、还有哪些迁移没做完」。
- 锁定:tests/providerDataSourceDoc.test.ts 逐项对账——extension.ts 实际构造的每个 Provider 类必须在本页出现;watcher 分布清单与 `createFileSystemWatcher` 实际计数逐文件相等;未完成迁移标注在位。代码挪窝必须同笔改本页。

## 1. 副作用边界

读路径总则(ARC-005 定,源级锁 tests/typeStorageWatcherOwnership.test.ts):

- **全仓服务归装配层**:watcher、worker、缓存由 extension.ts 唯一构造、`context.subscriptions` 统一释放、`deactivate()` 收 worker 与快照;provider 不私建第二套全仓服务(`createFileSystemWatcher` 在 languageProviders.ts 为零)。
- provider 允许的副作用只有六类白名单:
  1. **缓存回填**:同版本/mtime 指纹命中失败时填充只读缓存;
  2. **后台补全入队**:首查不等全量,缺口经 `IndexScheduler` 入队后台补(不阻塞请求);
  3. **镜上报**:shadow 对拍/观测腿为 fire-and-forget,不改返回值(确定性面见 docs/perf/2026-baseline.md §7);
  4. **事件发布**:自身 emitter(如 `fireConfigurationChanged`)通知装配线刷新镜;
  5. **UI 面板**:webview/树视图创建与刷新(仅 CallChainController 与 §2b 树 provider);
  6. **编辑提案**:Rename/CodeAction 返回 WorkspaceEdit(宿主/用户执行,provider 不落盘)。
- 禁止:请求路径同步全仓 IO;provider 内建 watcher/worker/第二套索引;读配置/文件作为格式化输入(纯格式化住 hoverMarkdown)。

## 2. Provider 清单

### 2a. 语言 provider(vscode.languages.register\*,26 注册 / 25 类)

注册位为 extension.ts 行号:

| Provider | 类定义 | 注册位 | 数据源 | 允许副作用 |
|---|---|---|---|---|
| KBEngineCompletionProvider | languageProviders.ts:473 | :605 | EntityMappingManager 快照(def 标签/属性语境)+ documentStore 行快照 | 缓存回填 |
| KBEngineSignatureHelpProvider | languageProviders.ts:1264 | :656 | EntityMappingManager(def 方法签名) | 纯读 |
| KBEngineHoverProvider | languageProviders.ts:697 | :681 | EntityMappingManager + documentStore 行快照 + hoverMarkdown 纯格式化 | shadowCompareDefinition 镜上报 |
| ServerConfigHoverProvider | serverConfigHover.ts:151 | :718 | serverConfigMerge 合成的 kbengine.xml 合并树 | 纯读 |
| KBEngineDefinitionProvider | languageProviders.ts:1357 | :729 | EntityMappingManager → SemanticIndex 快照(无全仓等待) | 纯读 |
| PythonDefinitionProvider | languageProviders.ts:3861 | :787 | EntityMappingManager + PythonClassIndex(classes/bases/methods/mro/compositionRoots 五轴) | ensureScanned 后台补全入队 + shadowObserveDefDocument 镜观测 |
| PythonCompletionProvider | languageProviders.ts:5787 | :1061 | EntityMappingManager + engineApiCatalog(:301 异步构建) | 纯读 |
| RpcCodeLensProvider | languageProviders.ts:4651 | :879 | EntityMappingManager(RPC 镜链) | 纯读 |
| CallChainController | defCallChainProvider.ts:49 | :886 | EntityMappingManager | webview 面板创建/更新(UI 副作用) |
| PropertyCodeLensProvider | languageProviders.ts:4819 | :904 | EntityMappingManager(types.xml 属性回指) | fireConfigurationChanged 事件 |
| EventCodeLensProvider | eventApi.ts:95 | :918 | EventCallIndex 小接口(`allEventCalls`,ARC-002;注入 sharedWorkspaceIndex) | 预启动延迟 8s 后共享索引全仓 py 扫描入队(唯一扫描入口) |
| TypesXmlCodeLensProvider | languageProviders.ts:4964 | :954 | databaseSchema 类型存储使用索引(`onTypeStorageUsageIndexPublished` 订阅;构造零依赖) | fireConfigurationChanged 事件;watcher 归装配线(ARC-005) |
| GeneratedSourceCodeLensProvider(python 桩) | generatedSourceLenses.ts:11 | :966 | 构造期快照 buildPythonTypeStubPlan(getCustomTypeInfos) | 纯读 |
| GeneratedSourceCodeLensProvider(entity 桩) | generatedSourceLenses.ts:11 | :3230 | 构造期快照 buildEntityTypeStubPlan(getAllMappings + getCustomTypeInfos) | 纯读 |
| PythonTypeInlayHintsProvider | typeInlayHints.ts:33 | :985 | EntityMappingManager | 纯读 |
| KBEngineBuiltinTypeInlayHintsProvider | languageProviders.ts:649 | :995 | EntityMappingManager | 纯读 |
| DefParamInlayHintsProvider | defParamInlayHints.ts:226 | :1010 | EntityMappingManager | 纯读 |
| KBEngineCallHierarchyProvider | languageProviders.ts:5013 | :1019 | EntityMappingManager(def/python 双选区调用层级) | 纯读 |
| KBEngineReferencesProvider | languageProviders.ts:5117 | :1027 | EntityMappingManager + defReferenceGraph 引用图 | 纯读 |
| KBEngineDocumentSymbolProvider | languageProviders.ts:5231 | :1034 | 当前文档 def 结构(构造零依赖) | 纯读 |
| KBEngineWorkspaceSymbolProvider | languageProviders.ts:5295 | :1040 | EntityMappingManager(全仓符号检索) | 纯读 |
| KBEngineImplementationProvider | languageProviders.ts:5327 | :1047 | EntityMappingManager(def 接口方法实现定位) | 纯读 |
| KBEngineRenameProvider | languageProviders.ts:5618 | :1055 | EntityMappingManager(def 符号改名) | 编辑提案(WorkspaceEdit) |
| KBEngineTypeCodeActionProvider | languageProviders.ts:5375 | :1101 | 当前文档 def 结构(构造零依赖) | 编辑提案(WorkspaceEdit) |
| KBEngineMethodImplementationCodeActionProvider | languageProviders.ts:5470 | :1108 | EntityMappingManager(接口方法补实现) | 编辑提案(WorkspaceEdit) |
| KBEngineReceiverNoneGuardCodeActionProvider | languageProviders.ts:5561 | :1116 | 诊断面(context.diagnostics,code=kbengine.receiverNone)+当前文档文本 | 编辑提案(WorkspaceEdit) |

命令查询面(非 register\*Provider,同口径记录):符号引用面板 `kbengine.symbolReferences.show` 走 defReferenceGraph 自定义引用图(与 LSP references provider 并存);实体依赖图 `kbengine.dependency.show` 走 dependencyGraph.ts + webview。数据源同为 EntityMappingManager 快照,副作用限于 webview。

### 2b. 虚拟文档 provider(registerTextDocumentContentProvider,只读内容面)

| Provider | 类定义 | 注册位 | 数据源 |
|---|---|---|---|
| kbe 模块符号桩(匿名×2) | extension.ts 内联(:342、:373) | :342/:373 | buildKbeStubDocument + engineApiCatalog 元数据 |
| KBEngineDatabaseSchemaProvider | databaseSchemaPresentation.ts(ARC-004 装配面) | :358 | databaseSchema 快照/渲染(委托) |
| KBEngineDatabaseSimulationProvider | databaseSimulator.ts:364 | :364 | databaseSimulator 行模拟(schema 快照之上) |
| FinalConfigContentProvider | serverConfigMerge.ts:2768 | :2716 | kbengine.xml 合成树渲染 |

### 2c. 树/任务 provider(UI 装配面)

| Provider | 类定义 | 构造位 | 数据源 | 允许副作用 |
|---|---|---|---|---|
| EntityExplorerProvider | explorerProviders.ts:1391 | :1386 | entities.xml 清单扫描 | 树刷新事件 |
| ServerControlProvider | explorerProviders.ts:1790 | :1738 | serverManager 状态 | 树刷新 + 用户触发启停命令 |
| TelnetTreeProvider | telnetTree.ts:1798 | :1746 | telnetService 状态 | 树刷新事件 |
| RemoteServerTreeProvider | remoteServerTree.ts:1813 | :1761 | ~/.ssh/config 快照 + workspaceState 手动项/选中态(IDE-PDBG-004) | 树刷新事件 |
| KbengineBuildTaskProvider | buildTaskProvider.ts:2146 | :2094 | 构建任务定义(静态) | 无(仅提供任务) |
| DebugTargetTreeProvider | debugStatusTree.ts:2063 | :2011 | getDebugStatusRows 轮询 | 树刷新事件 |
| QuickActionTreeProvider | quickActionTree.ts:3092 | :3040 | 快捷动作清单 | 树刷新 + 用户触发命令 |
| FinalConfigTreeProvider | serverConfigMerge.ts:2808 | :2756 | kbengine.xml 合成树 | 树刷新事件 |

## 3. 诊断面

无 `registerDiagnosticProvider`;诊断经 DiagnosticScheduler(`getDiagnosticScheduler()` 单例,extension.ts:463;版本令牌 + 分层记账 + 同 URI 新版本胜出):

- 数据源:`validateDocument`(languageProviders.ts:1425)——defParser 一次解析结果共用标量 + 结构校验(`parseDefAst`,:1440),入口为 documentStore 同版本快照;`validateEntitiesXmlDocument`(:1458)——documentStore `entities-analysis` 命名空间缓存(:1471)。
- 副作用:DiagnosticCollection 发布(诊断面合法出口)。
- 通道:`onDidChangeTextDocument`(extension.ts:1149)→ `flushQueued()`(:1189,单轮 25ms 时间片,IDE-DIA-006)→ diagnosticScheduler.ts 调度。
- Python receiver-none 诊断:独立调度 `scheduleReceiverNoneDiagnostics`(extension.ts:548,异步分片 computeReceiverNoneFindingsAsync);诊断带稳定 code(`kbengine.receiverNone`/`kbengine.sectionMismatch`,extension.ts:596 发布处),`KBEngineReceiverNoneGuardCodeActionProvider` 按 code 对账出守卫 QuickFix。

## 4. 共享服务与生命周期所有者

| 服务 | 唯一构造位 | 释放通道 |
|---|---|---|
| IndexScheduler | extension.ts:522 | context.subscriptions |
| EntityMappingManager | extension.ts:540 | context.subscriptions(manager 内 watcher 见 §5) |
| DiagnosticScheduler | extension.ts:463(getDiagnosticScheduler 单例) | 进程生命周期 |
| PythonClassIndex | extension.ts:753 | context.subscriptions |
| WorkspaceIndex | extension.ts:922(全仓唯一,源级锁) | context.subscriptions |
| TypesXmlCodeLensProvider 实例 | extension.ts:959 | context.subscriptions(注册面 + impl 实例,ARC-005) |
| typesXml 落库索引 watcher 装配线 | typeStorageIndexWatchers.ts(extension.ts:966 接线) | context.subscriptions(返回的 Disposable) |
| Python parser worker / 快照缓存 | 装配层 | deactivate():disposePythonParserWorker() + releaseAllDocumentSnapshots() |

## 5. watcher 分布

watcher 分布(基线 499d34a,按**源码调用位**计,测试逐文件对账):src/extension.ts=3 src/typeStorageIndexWatchers.ts=1 src/entityMapping.ts=3 src/hotReload.ts=1 src/pythonTypeStubs.ts=1 src/debugConfig.ts=1 src/workspaceIndex.ts=1(合计 11 处调用位)

- 装配层自持:extension.ts ×3、typeStorageIndexWatchers.ts ×1 调用位(循环建 def/types.xml/entities.xml 3 枚 watcher,ARC-005)。
- 模块自持(见 §6 标注):entityMapping ×3、hotReload ×1(显式 dispose/重建)、pythonTypeStubs ×1、debugConfig ×1。
- workspaceIndex ×1(py glob)住类内,但 WorkspaceIndex 全仓唯一构造位在装配层,Disposable 随 context.subscriptions 释放——生命周期口径已符合 ARC-005,不算未完成。

## 6. 未完成迁移

以下各项为**当前明确未完成**的迁移,不写成已完成:

- 【未完成迁移】languageProviders.ts 单体:5,874 行,18 个 export class 同居一文件。ARC-001..005 已切走常量(sourceRevealCommand)、纯类型(eventIndexTypes)、hover 格式化(hoverMarkdown)、schema 适配层(databaseSchemaCore/Presentation)、watcher 装配线(typeStorageIndexWatchers),但按 provider 拆文件未做——是 RST 泳道(Rust 化逐模块替换)前的最大单件风险,见 docs/architecture/current-state.md AUDIT-002。
- 【未完成迁移】签名帮助与补全文案:KBEngineSignatureHelpProvider(languageProviders.ts:1258)的 SignatureInformation 字符串与补全 documentation 文案仍住 languageProviders.ts;ARC-003 只抽离了 hover 五个 render 位到 hoverMarkdown.ts,这两面同词句不同特性未抽。
- 【未完成迁移】entityMapping 双读:types.xml/alias.xml 在 entityMapping.ts 走直读 readFileSync 路径,与 documentStore 快照两条路对同一文件各读一次,结构性重复仍在(current-state.md AUDIT-004 列 CSV 风险列,VFS 迁移时应合并)。
- 【未完成迁移】模块自持 watcher:entityMapping.ts ×3、hotReload.ts ×1、pythonTypeStubs.ts ×1、debugConfig.ts ×1 共六处调用位住非装配层模块。ARC-005 只收了 provider 面(TypesXmlCodeLensProvider);manager/功能模块面是否归装配线未决,待 RST 泳道逐项评审(归线收益 vs 模块内聚)。
