# 图派生候选范围表

- 日期:2026-10-29 · 基线:`443798f`(IDE-RST-007 收口后)
- 来源:todo IDE-RST-008;范围评审「R2.5 模块边界核对」遗漏图派生候选四行(defReferenceGraph/entityDependency/compositionRoots/entityFlowGraph)的逐件展开与核实;R2 现成/缺口对照 [2026-10-29-r2-index-inventory.md](2026-10-29-r2-index-inventory.md)。
- 性质:逐件记录**输入面**(读什么、依赖哪些模块、是否 VS Code/配置/Python)与**交互入口**(产品命令/webview/跳转面及其触发频率),作为后续迁移取舍(RST-009+)的现成底账;本页不做取舍结论。
- 锁定:tests/rstGraphScopeTableDoc.test.ts(章节/命令面/输入事实/缓存事实)。

## 1. defReferenceGraph

- **对象**:src/defReferenceGraph.ts(491 行);跨文件 .def 声明/引用/连接图,与 F2 重命名共享 defRenamer 语义面(collectRenameEditsInText/parseDefFileSemantics),图与重命名编辑不漂移。
- **输入**:调用方给单 .def 路径 → findEntityDefsRootFromFile 根判定(entities.xml 同目录判据)→ 全根 *.def 递归扫描逐文件 fs.readFileSync;实体/接口/组件按路径段分类(interfaces//components/ 目录分域);传递祖先闭包+连接分量过滤;悬空 parent/interface/component(dangling-*)与重复符号检查。**零 VS Code API、零配置读、零 Python**。
- **交互入口**:恰两命令,输出通道呈现——kbengine.project.doctor(extension.ts:3152,Project Doctor 报告)与 kbengine.symbolReferences.show(extension.ts:3186,Mermaid+文本预览);无 hover/watcher/webview。
- **缓存**:无。每次调用全根重扫重解析(O(全根 def)),命令为用户手动低频触发。

## 2. entityDependency

- **对象**:src/entityDependency.ts(622 行,EntityDependencyAnalyzer 两遍全图重建)+ entityDependencyWebView.ts(面板装配)。
- **主路径(IDE-RUST-007 起,2026-10-31)**:图拓扑推导收归 Rust 核心 `$/kode/dependency/graph`(crates/kode-server/src/dependency_graph.rs)——入参 entitiesXml/typesXml/defsRoot + defs/paths/categories/pythonFiles/typeImpls map(TS 收集:findFilesAcrossRoots 全根 *.def+目录前缀分类、脚本目录约定+ImplementedBy 模块解析的 python 候选、getCustomTypeInfos 的类型实现);出图 JSON 节点六 kind(entity/def/interface/component/type/python)七边(registration/inheritance/is-a/has-a/property-type/implements/method-impl)+reverseEdges+三路径(entities.xml/defsRoot/types.xml)+stats;Rust 不可用(无 gate/调用失败/形状不符/异常)回落下行 TS 面(来源徽章「Rust 核心」/「TS 兜底」)。
- **输入(TS 兜底面)**:vscode.workspace.workspaceFolders + findFilesAcrossRoots('**/*.def')(含外部 assetsRoot 遍历,scanRoots.ts)+ vscode.workspace.fs.readFile;布局面走 definitionWorkspace(getRegisteredEntities 读 entities.xml/findEntityDefinitionFile/getDefinitionWorkspaceLayout);**正则文本提取,非严格 XML 解析器**(extractTagBodies/extractNamedChildBlocks);引用扫描仅 Properties 段,ARRAY/FIXED_DICT 容器展开(implementedBy/Type/嵌套递归);maxDepth 退化封顶 1(档内注明不修)。无配置读、无 watcher、无 Python。
- **交互入口**:恰一命令 kbengine.dependency.show(extension.ts:2696)→ webview 面板 kbengine.entityDependency(Mermaid CDN 渲染/导出 PNG-SVG/节点点击开文件:def/entities.xml/types.xml/python);无菜单/键位/hover。
- **缓存**:analyzer 无记忆化,analyze() 每次清空两遍全量重扫;webview 持 currentRender 仅供导出复用。

## 3. compositionRoots

- **对象**:src/compositionRoots.ts(292 行,纯函数层)+ 消费方 src/pythonClassIndex.ts。
- **输入**:模块本体三面内容注入——entities.xml(实体名=根元素直接子元素)/每实体 .def(parent/interfaces/components/fieldTypes)/types.xml(fixedDict/array/builtin+implementedBy 符号+递归 fieldRefs 深度 8);**Python 类/实例赋值交叉不在本模块**,由消费方 PythonClassIndex 供给(fileCache 的 instanceAssignments 按域聚合,implementedBy 符号→类桥接);文件枚举(findFilesAcrossRoots 三类面)/IO/VS Code(vscode.workspace.textDocuments 脏缓冲查询)全在消费方。
- **交互入口**:唯一产品消费链=PythonClassIndex → PythonDefinitionProvider(extension.ts:743 注册,languageId=python)的 **Go-to-Definition**(C3-MRO+组合根 mixin 解析);配置闸 kbengine.python.enableMroJump(默认开,extension.ts:319);喂食 watcher 六处+后台扫描(extension.ts:773-808/1135/1263-1267);hover/CodeLens 不消费此链。**四件中唯一的交互路径常驻面**(定义跳转),但下游有缓存纪元兜着。
- **缓存**:PythonClassIndex 侧完整——rootsMap 懒缓存+rootsPromise single-flight+rootsByScope 分域+rootsEpoch 失效纪元+rootsContentCache(mtime/size 内容缓存,重推导零 IO)+依赖图精确失效(COMPOSITION_ROOTS_NODE)+赋值签名变更 reset。

## 4. entityFlowGraph

- **对象**:src/entityFlowGraph.ts(695 行,纯数据层)+ entityFlowWebView.ts(装配层)。
- **输入**:纯数据层唯一输入 EntityFlowInput{semantics, hasCell}——已解析的 ResolvedDefinitionSemantics+hasCell 状态;**零 fs/零 VS Code/零配置/零 Python**;内嵌引擎真值面 ED_FLAG_BITS(common.h L19-28)+PROPERTY_FLAG_BITS(entitydef.cpp L161-174)+FlowCitation 引擎源位(每边带 file:line 引证)。装配层 buildGraph:workspaceFolders[0] + createDefinitionSemanticsLoader(loadResolved 递归解析 def/interfaces/components/parent)+getDefinitionWorkspaceLayout(配置 entityDefsPath/entitiesXmlPath/typesXmlPath+fs 发现)+resolveEntityHasCell(databaseSchemaCore:entities.xml hasCell 声明→scripts/cell/<Name>.py 存在性回退)。
- **交互入口**:恰一命令 kbengine.flow.show(extension.ts:2705)→ webview 面板 kbengine.entityFlow(活动 .def 编辑器取名/边详情/受阻断调用/成员跳转 openMember/导出);Mermaid CDN。
- **缓存**:纯层无;webview **每次 show 新建 loader**(缓存仅调用内递归解析,不跨 show);resolveEntityHasCell→getRegisteredEntities 每次重读 entities.xml。

## 5. 汇总

| 候选 | 输入面 | 交互入口 | 缓存 | R2 对照 |
|---|---|---|---|---|
| defReferenceGraph | 全根 def fs 扫描+defRenamer 共享语义 | 两命令(输出通道) | 无 | 符号/链现成;悬空检查与重命名共享语义缺口 |
| entityDependency | workspaceFolders+assetsRoot 遍历+**正则提取** | 一命令+webview | 无 | 同上;且解析面本身非严格 XML,对拍需先换腿 |
| compositionRoots | 三面 XML 内容注入+**Python 赋值交叉(消费方)** | Python Go-to-Definition(交互常驻) | 消费方纪元+内容缓存 | XML 面现成;Python 面无 Rust 解析器(r2 §4) |
| entityFlowGraph | 纯层(语义+hasCell)+装配层布局/配置 | 一命令+webview | 不跨 show | 符号面现成;旗标真值表/hasCell(布局+py 存在性)缺口 |

- 四件共同点:交互入口均为**低频命令/webview 面**,唯 compositionRoots 落在 Python 定义跳转交互路径(有缓存纪元兜底);迁移取舍逐件另立记录(RST-009+),本页只立底账。
- 范围评审四行原文与本表核对:entityDependency「依赖面板触发」、compositionRoots「被 Python 导航路径消费」、entityFlowGraph「实体语义+hasCell 派生」均与代码事实一致;defReferenceGraph 补充为两命令(doctor+引用图预览)。
