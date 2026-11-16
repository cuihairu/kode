# RUST-147 审计:无 KBEngine 工作区的普通 Python 文件不得受到 Kode 语义劣化影响

日期:2026-11-17
性质:约束合规审计(约束项)——逐面核实零劣化契约现状,零代码缺口,零改动结案。

## 逐面核实

### 1. 激活面:无特征工作区零机械启动

`src/workspaceGate.ts`(书 PR-002 / AUDIT-003 负案例):激活期有界特征探测(合并 glob 单次 findFiles,maxResults=1:*.def / entities.xml / types.xml / alias.xml / kbengine*.xml)——无特征纯 Python 工作区:IndexScheduler 首扫不入队、EntityMappingManager 三 watcher 不建、PythonClassIndex 后台全量扫描不启动。fail-open(探测异常按放行)+ 按需 ensureStartup 兜底保证结果口径不变。测试钉:tests/workspaceGate.test.ts;接线点 src/activate/languageServices.ts:335(gated 才 startKbEngineIndexing)、coreServices.ts:58(deferStartup)、monitoring.ts:340。

### 2. 被动诊断面(打开/编辑事件):零机械唤醒 + 决策核空闸

Python 文档事件排程 12+ 诊断族(src/extension.ts:472-499),但管线取映射走**非启动读**:`getMappingForPythonFile`(src/entityMapping.ts:1177)与 `getDefFileForPythonFile`(:1191)只读内存 map,不 ensureStartup——门控未放行的工作区里打开普通 .py 零扫描零 watcher。空映射下决策核自然零产出:receiver 段错配族(mapping null → 角色不明不猜)、def 方法一致性(无属主 def 静默)、userTypeContract/propertyDirection(def 注册表空)等。

### 3. 决策核族:非实体不接管闸为家族模式

17 个 backend 决策核显式携带「非实体/普通 Python 不接管」闸(全仓 grep 实证):roleMisuse(IDE-LINT-009:"非实体脚本(pathFace null 且 defFaces null)→ 不接管(普通 Python 类不猜)")、readOnlyWrite、postDestroy、cellDataWrite/WrongKey/Callback、fixedDictConstruct、scalarAssign、selfPropertyTypeInference、propertyInitOrderLens、cellDataHover/Completion/ReadType/KeyTracking、createObjFromDictInput、globalDataIndexCore、entityBuiltinProperties、hotReloadDefStructure、postDestroyRust/readOnlyWriteRust、kodeCoreShadowFaces。逐条规则与家族口径一致:角色不明不猜、属性表无据不报。

### 4. 补全面:逐上下文/路径闸

KBEngineCompletionProvider(src/languageProviders/completion.ts)python 面:
- `def on<前缀>` 入口 SPI 钩子:`isComponentEntryScriptFile`(src/backend/entryHooks.ts:91,路径形态 `/<cell>/kbemain.py` 精确匹配)——普通文件路径永不出;
- self. 内建属性补全:实体归属面闸(非实体脚本不接管,注释明示);
- KBEngine. / importlib. / addSpaceGeometryMapping 字符串:显式前缀/实参上下文才触发——普通文件不出现 KBEngine 字样即零注入;
- def-XML 标签/类型/Flags 面:仅 def 文件上下文。

### 5. 交互解析面:使用证据启动(设计在案)

`resolvePropertyDefinition` 族(entityMapping.ts:1249/:1260)带 ensureStartup 兜底——门控未放行工作区的显式属性解析(用户交互证据)会幂等启动机械,扫描后空产出。语义诚实(空≠错),成本仅在确有使用证据时发生,系 workspaceGate 设计权衡(docstring 明示),非语义劣化。

### 6. 其余面

- SemanticTokens:配置默认关(RUST-144 批 4,opt-in);
- Python Outline/breadcrumbs:本扩展零注册(外部语言服务域,RUST-148 矩阵);
- CallHierarchy/inlay/hover:def 依赖链,空索引零产出(RUST-145 批 1 决策核同家族闸)。

## 结论

约束(普通 Python 文件零语义劣化)在激活/被动诊断/决策核/补全/交互五层全部有闸实证:无特征工作区激活零成本;打开普通 .py 零机械唤醒零诊断产出;补全逐上下文门控零注入;显式交互才付启动成本且结果诚实。零代码缺口,审计结案。

## 门禁

纯审计零代码改动,无新门禁义务;当日既有门禁基线见 RUST-145 批 1 注(vitest 860 文件 10397+8skip EXIT=0 / xvfb demo 25 RC=0 / clippy 0 / lint 0 / tsc 0)。
