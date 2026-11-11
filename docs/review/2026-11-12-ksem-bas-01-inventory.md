# KSEM-BAS-01 能力与消费入口盘点(2026-11-12)

todo.md「KSEM-BAS-01」交付物。盘点范围:cellData / 类型桩 / RPC / 配置 /
编解码(实体消息表)/ 三类图。方法:三路只读扇出侦察 + 关键声明抽查
(命令注册、provider 注册、package.json 声明、测试文件存在性逐项复核)。

**判定口径**:`已有` 必须给出用户真实可达面(命令面板命令 ID / 诊断集合
规则 / inlay / hover / 树 / webview 面板),**只注册 RPC 不算用户可用**;
`部分` = 计算面在但消费面缺;`缺失` = 无专用面;`待核实` = 接线意图或
真机形态未定。

---

## 1. cellData(引擎 `self.cellData` 字典)—— **已有**

| 面 | 位置 |
| --- | --- |
| 分析核心(TS) | `src/backend/propertyDirectionDiagnostics.ts`(键访问扫描 :205/:191/:247、`__init__` 拷贝赋值 :150/:181-185、copy-property 与 def-face 双流) |
| Rust 核心 | `crates/kode-server/src/property_direction.rs:24`(`$/kode/lint/analyzePropertyDirection`;scan3 cellData 键 :404-406) |
| TS 装配/兜底 | `src/backend/propertyDirectionRust.ts:151`(Rust-first,失败回落本地扫描) |
| 用户消费面 | 诊断:`src/activate/diagnostics.ts:740-779`(集合 `kbengine` :392,开关 `kbengine.propertyDirectionDiagnostics`);inlay:`src/activate/languageServices.ts:600-603`(`kbengine.inlayHints.propertyShadow`);规则登记 KBE-PY-012/012b(`src/lintRuleRegistry.ts:79-92`) |
| 其他感知面 | hover 陷阱知识(`src/backend/behaviorKnowledge.ts:195-205`)、API 文档(`src/generated/apiDocs.ts:52-59` → hover `pythonApiHoverDocs.ts:20`)、受限属性名校验(`defAnalyzer.ts:192` + Rust `lint/rules.rs:68`)、MCP explain(`crates/kode-mcp/src/explain.rs:91`) |
| 测试 | `tests/propertyDirectionDiagnostics.test.ts`(cellData 通道 :335-411)、`propertyDirectionRust.test.ts`、`propertyDirectionRustParity.test.ts`、`languageProviders.test.ts:395`、Rust 内联 :559-641、`kode-mcp e2e :188-199` |

语义边界(设计使然,如实记录):cellData 键流**只走 inlay 不走诊断下划线**
(:335-337 注释);方向违规才出 Warning。缺口:`self.cellData` 裸属性
hover 无专用 builtin 面(`entityBuiltinProperties.ts:38-90` 不列
cellData,`pythonApiHoverDocs.ts:141` 只匹配 `KBEngine.<member>`)——
文档文本仅经 `onWriteToDB` 回调 hover 可达;属小缺口非缺能力。

## 2. 类型桩 —— **已有**(KBEngine 桩为静态 curated,kbe_types/entity_types 从 def 生成)

| 面 | 位置 |
| --- | --- |
| KBEngine 桩 | `src/pythonStubExport.ts:342`(`exportKbeStubs`;vendored 模板 `typings/KBEngine/*.pyi` 23 文件 copy-if-absent 到 `.kbengine/stubs`,reset 命令确认后覆盖;legacy 单文件迁移 :288-308) |
| kbe_types.pyi | `src/pythonTypeStubs.ts`(`exportPythonTypeStubs`,从工作区 types.xml/alias.xml 生成,FIXED_DICT→TypedDict) |
| entity_types.pyi | `src/entityTypeStubs.ts:125`(从实体映射生成) |
| 用户消费面 | 命令:`kbengine.python.exportStubs/resetStubs/exportTypeStubs/syncExtraPaths`(`src/activate/generators.ts:60-104`,package.json :881-911);激活静默导出(generators.ts:157-172,开关 `kbengine.python.stubExport` 默认开);types.xml watcher 再生(`src/activate/views.ts:351`);extraPaths/stubPath 接线(`src/pythonExtraPaths.ts:271-355`) |
| 下游消费 | `kbeModuleIndex.ts:16`、pyrefly search-path(`pyreflyInfer.ts:8`)、`inferredMirrorLookup.ts:7` |
| 测试 | `pythonStubExport/pythonStubDir/kbengineStubTemplate/pythonTypeStubs/entityTypeStubs/pyrightStubGate` 六套件 |

缺口(已定案未实施):KBEngine 桩 = curated 静态拷贝,**不从引擎源码派
生**;源码枚举车道已定案(`docs/design/kbengine-pyi-compiled-module-plan.md`,
钉死 fork commit 零编译),未实施——如实记为升级项,不改变「已有」判定
(现有桩可用且接线完整)。

## 3. RPC(Exposed 方法感知)—— **已有**

| 面 | 位置 |
| --- | --- |
| Rust 判定 | `crates/kode-server/src/rpc_arg_count.rs:17-18`(`$/kode/lint/analyzeRpcArgCount`;内联测试 :259+) |
| 诊断(TS) | `src/backend/rpcArgCountDiagnostics.ts`(code `kbengine.rpcArgCount` :46 默认开;Rust-first `computeRpcArgCountFindingsAsync` :275-287 失败回落本地计数) |
| 用户消费面 | 诊断:`src/activate/diagnostics.ts:303-320` → 规则 KBE-PY-009(`lintRuleRegistry.ts:303-306`);CodeLens:`src/activate/languageServices.ts:433-436` **实际注册**(抽查通过);hover Exposed 标注(`hover.ts:1131-1132`)、ClientMethods 补全(`completion.ts:209,821`)、receiver RPC 索引驱动 rename/nav(`entityMapping.ts:2357`) |
| 测试 | `rpcArgCountDiagnostics/rpcArgCountRust/rpcArgCountRustParity`(真二进制逐槽深等,缺二进制跳过)/`rpcArgCountGapArms/rpcCodeLens/defRenameRpc/codeLensCancellation`;Rust dispatch 泛化面 `crates/kode-server/tests/rpc_dispatch.rs` |

盘点问法勘误:`@RemoteMethod` 装饰器在本库/引擎惯例中**不存在**(零命中);
KBEngine RPC-性 = `<Exposed>` + base/cell/client 区块成员资格,两者均已
覆盖。`onRemoteMethodCall` 字符串仅存在于离线包取证 crates,编辑器不可达。
`$/kode/echo`(rpc.rs:63)是唯一注册不消费面,代码已注明 test-fixture-only。
测试面小缺口:`rpc_arg_count` 无专属 dispatch 测试文件(由 parity 套件经
真二进制覆盖,性质=覆盖通道不同非覆盖缺失)。

## 4. 配置(引擎服务器配置)—— **已有**

| 面 | 位置 |
| --- | --- |
| Rust 单一事实源 | `crates/kode-parser/src/config.rs:623`(`resolve_config`,合并 :337、引擎默认 telnet :406);`$/kode/config/resolve`(`config_rpc.rs:264`)+ `$/kode/config/derive`(:24) |
| TS 消费 | `src/serverConfigResolve.ts:386`(gate.runInRust;引擎默认 xml 定位 :445)、fallback 纯核 `serverConfigFallbackCore.ts`、merge 视图 `serverConfigMerge.ts:221/:282-285` |
| 用户消费面 | `kbengine.config.showFinal`(虚拟只读文档 `kbengine-config` scheme,`src/activate/views.ts:312-375`)、`kbengine.config.visualize`(3 树可视化 webview,`src/configVisualizerPanel.ts:47` + `configVisualizerModel.ts:24` 三态投影)、侧栏树(`serverConfigMerge.ts:306`)、contract 诊断(`src/backend/configContractDiagnostics.ts:15`,开关默认开,规则登记 :189-231)、hover/annotation/catalog;`**/kbengine*.xml` watcher 再解析(views.ts:607-626) |
| 测试 | TS:`serverConfigMerge(14)/serverConfigResolve(9)/serverConfigRealDefaults/serverConfigFallbackParity(TS↔Rust 对拍)/configVisualizerModel(19)/configVisualizerPanel/configVisualizerPanelHtml/configContractDiagnostics(21)/extension.misc :150-200`;Rust:`config_units(20)/config_merge_units(14)/config_resolve_units(9)/config_derive_units(29)` + dispatch 覆盖 |

## 5. 编解码(实体消息表)—— **已有**(取证族 crates 未接线,单列)

| 面 | 位置 |
| --- | --- |
| Rust 核心 | `crates/kode-server/src/message_table/`(builder + methods/properties/components/aliases/constants/json/render/views/types/source/assembly;输出与 TS 字段全等) |
| TS 桥+兜底 | `src/backend/messageTable.ts:414`(`buildMessageTableInRust` 经 `$/kode/messageTable/build`;实体闭包 BFS :380-400,形状校验,失败 null);兜底引擎模拟 `messageTableEngine.ts`(1293 行);共享装配 `messageTableEntity.ts`(IDE-AUD-060:预览与导出同一输入) |
| 用户消费面 | `kbengine.messagetable.preview`(QuickPick→markdown 未标题文档,缺声明显式警告不空预览;extension.ts:986-1006,抽查通过)、`kbengine.messagetable.export`(保存对话框 JSON,取消不落文件;:1010-1036,抽查通过);激活事件 package.json:157-158 |
| 测试 | TS:`messageTable/messageTableRust/messageTableEntity/messageTablePreview/messageTableExport/rstMessageTableTradeoffDoc/sdkMessageNumberAudit`(utype 装载序对拍真实引擎 datatypes.cpp);Rust:`message_table_dispatch.rs`(与 TS 测试镜像逐项) |

单列事实:`crates/kode-kbengine-schema/protocol/analyzer` 的 message
table 族(运行时/离线包取证)**未接线到扩展**——grep 证实无 src/ 或
kode-server 引用;是否需要接线属后续车道决策,记 **待核实**(意图未定,
非缺陷)。

## 6. 三类图(+ 两个相邻图面)

### 6.1 Python 调用图 —— **已有**
`kbengine.pythonCallGraph.show`(package.json:657)→ `monitoring.ts:296`
→ `entityDependencyWebView`('callgraph' 模式);计算 Rust
`$/kode/python/callgraph`(`python_callgraph.rs:38` ← `kode-python` callgraph
+ CallReverseIndex),**无 TS 兜底**:Rust 不可用 = badge + 空图诚实注记。
收集策略有界(10,000 文件截断 + warning 条,PERF-004);取消代际守卫
(PERF-005)。测试:`pythonCallGraphRust(14)/entityDependencyWebView(29)/
entityDependencyPanel(35)` + 真宿主 smoke `panelOpenSmoke.test.ts`;
Rust `callgraph_test(23)/graph_test(36)/python_callgraph_dispatch(14)`。

### 6.2 def 调用链(方法级)—— **已有**
`kbengine.python.showCallChain`(package.json:759)→
`languageServices.ts:442-453`(CodeLens + 命令);计算
`src/backend/defCallChain.ts`(def 方法 → base/cell/client receiver);
webview `defCallChainProvider.ts:279` + `media/defCallChainViewer.js`。
测试 6 套件(defCallChain/Exposed/ShellRedesign/Wiring/ViewTabs/cov)。

### 6.3 实体依赖/结构图 —— **已有**
`kbengine.dependency.show`(package.json:652)→ 同面板;计算 Rust
`$/kode/dependency/graph`(`dependency_graph.rs:29` ←
`dependencyGraphRust.ts:226`)+ TS 兜底 `entityDependency.ts`(badge
「TS 兜底」);Mermaid 渲染 `entityDependencyGraphView.ts:11-23`。
测试:Rust 5 + parity 5 + webview 族 + smoke;Rust dispatch 9。
相邻:**entity flow 图** `kbengine.flow.show` 亦已有
(`entityFlowWebView.ts:131` + `entityFlowGraph.ts`,引擎源码引用语义,
MD/SVG/PNG 导出;测试 53+23)。

### 6.4 数据流图(def-use)—— **部分**
计算面已有且 Rust 权威:`crates/kode-python/src/dataflow.rs`(过程内
def-use,MVP 边界文档化),仅作 `$/kode/python/callgraph` /
`$/kode/python/symbols` 的 `dataflow` 字段暴露;call 反向索引喂调度失效
(`kode-scheduler` InvalidationGraph)。**无图 UI**(webview/面板零命中,
抽查通过);MCP server.rs:418 明说不含此查询。相邻:self 属性流走
inlay/诊断非图。→ 图 UI 面缺失,记部分。

### 6.5 类图(Python 类图)—— **缺失**
无命令/无面板/无 webview(抽查 grep 零命中)。唯一痕迹:C3 MRO 线性化
用于 mixin jump(`pythonClassIndex.ts:66`),设计明说「不预计算全仓类图」
(`docs/zh/design/mixin-jump.md:135`)。实体级结构由 6.3 覆盖;类级继承
图无专用面。

---

## 附:盘点口径与边界

- **「注册 RPC ≠ 用户可用」执行**:每域「用户消费面」行独立列出命令 ID/
  provider 注册点/诊断集合;三处抽查(languageServices CodeLens 注册、
  extension.ts 消息表命令体、views.ts content provider 注册)逐一到源
  核实。唯一注册不消费面 = `$/kode/echo`,代码自带 test-only 注明。
- **并发会话驻留件不在本盘点内**:`crates/kode-server/src/semantics/`
  (KSEM 批 1 驻留未接线)不构成任何「已有」面的证据,勿删勿吞。
- **待核实清单**:① 编解码取证族 crates 接线意图(§5 单列);②
  `self.cellData` 裸 hover 缺口是否补(§1);③ KBEngine 桩源码枚举
  车道实施(§2 已定案);④ rpc_arg_count 专属 dispatch 测试是否补
  (§3,现由 parity 真二进制覆盖)。
- 引擎契约登记(KSEM-BAS-02)不在本盘点内,顺延。
