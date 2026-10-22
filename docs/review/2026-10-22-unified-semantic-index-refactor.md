# Kode 重构计划：统一语义索引与语言服务性能治理

<!--
来源: 外部评审（ChatGPT 分享链 https://chatgpt.com/s/t_6ad9f9f782bc81919a28aef6968a69b6）
整理日期: 2026-10-22
性质: 外部建议，不是本仓事实陈述——每条声称落地前须对照源码核验（核验结论见下表）。
-->

## 核验结论（对照 origin/main 源码，2026-10-22）

| 评审声称 | 核验 | 证据 |
|---|---|---|
| EntityMappingManager 构造期全量扫描 | 属实 | src/entityMapping.ts:174/182（initialScan→scanEntityMappings） |
| PythonClassIndex 组合根/扫描分层 | 属实 | src/pythonClassIndex.ts:490/500/582 |
| 外部资产根同步递归遍历 | 属实 | src/scanRoots.ts:197（readdirSync） |
| 类型注册表指纹每次 statSync | 属实 | src/definitionWorkspace.ts:308/320/345 |
| workspaceIndex 已存在 | 属实 | src/workspaceIndex.ts 在库 |
| languageServiceMetrics 待新建 | 属实（不存在，评审正确标为新增） | 缺文件核验 |

结论：本评审的源码事实层可信，按其 PR 1→7 阶段推进；性能数字一律以 PR1 实测基线为准，不预设结论。

---

># Kode 下一轮改造任务：统一语义索引与语言服务性能治理

**目标仓库：** `https://github.com/cuihairu/kode`

**任务性质：** 以源码为依据的重构任务，不是单点性能修补。

**目标场景：** 数万级源文件、多个 KBEngine 资产根；主要卡顿包括 Hover、Definition、Completion、Diagnostics 和 Python 索引。

## 1. 总体目标与不可违反的约束

### 1.1 目标

1. 建立可复现的语言服务性能基线，明确每类请求的耗时分布、调用次数、文件扫描次数和同步文件系统调用。
2. 建立统一的文档快照、KBEngine 语义索引、索引调度与增量失效机制。
3. 将高频语言服务请求改成基于已有快照和索引的查询，不在输入过程中重复执行全仓扫描或全文件解析。
4. 保留现有 KBEngine 语义规则：实体与 `.def` 的关联、Base/Cell/Client 方法归属、Python 类继承和组合根解析、`types.xml`/`alias.xml` 类型映射，以及现有导航回退顺序。
5. 在数万文件、多资产根、文件增删改、配置切换等情况下，保证索引正确性、最终一致性和可恢复性。

### 1.2 不允许

- 不允许仅通过增加缓存、提高并发数或延迟执行来掩盖根因。
- 不允许引入一套与 `EntityMappingManager`、`PythonClassIndex` 并行且结果不一致的新索引。
- 不允许在每次 Hover、Definition 或 Completion 中执行全量目录遍历。
- 不允许通过降低诊断覆盖范围、删除现有导航层、忽略异常来换取性能。
- 不允许假设资产根之间不存在同名实体、同名 Python 类或不同引擎版本。
- 不允许在没有基线数据的情况下宣称“提升了 N 倍”或报告未经实际运行的耗时。
- 不允许第一阶段直接将全部功能迁移至新语言服务器进程。先重构现有 VS Code 扩展内的语言服务边界；是否采用独立 LSP 进程留待基线和架构评审后决定。

## 2. 第一阶段：性能基线与调用链审计

第一阶段先增加可关闭的性能诊断能力，不改变既有功能结果。

### 2.1 必须审计的源码

| 文件 | 已确认的实现 | 需要验证的问题 |
|---|---|---|
| `src/extension.ts` | 注册 Hover、Completion、Definition、Diagnostics；监听文档变化 | 是否有多个入口重复初始化索引；事件处理是否在编辑期间触发昂贵工作 |
| `src/languageProviders.ts` | 包含 `KBEngineHoverProvider`、`PythonCompletionProvider`、`KBEngineDefinitionProvider`、`PythonDefinitionProvider` 及诊断逻辑 | 哪些调用会等待首次全量索引；同一次请求是否重复解析相同文档 |
| `src/entityMapping.ts` | `EntityMappingManager` 在初始化期间调用 `scanEntityMappings()`；`performScanEntityMappings()` 枚举 `.def` 并逐个 `await parseDefFile()` | 首次查询等待时间、串行解析成本、索引是否重复构建 |
| `src/pythonClassIndex.ts` | `ensureScanned()` 枚举 `.py` 并以 16 个任务为一组加载；`ensureCompositionRoots()` 另外枚举 `entities.xml`、`.def`、`types.xml` | 首次 Definition 是否被 Python 全仓扫描阻塞；组合根是否导致第二轮扫描和重复读取 |
| `src/scanRoots.ts` | `findFilesAcrossRoots()` 使用 `workspace.findFiles` 并补充遍历外部资产根；外部遍历使用 `readdirSync` | 目录遍历是否出现在交互请求的关键路径；外部根扫描是否被重复触发 |
| `src/definitionWorkspace.ts` | `resolveEntityAnnotationType()` 计算类型注册表指纹，指纹通过 `statSync` 检查定义文件；`readAliasXml()` 使用 `readFileSync` | 高频类型查询是否反复执行文件系统检查；类型缓存失效是否过于粗粒度 |
| `src/pythonReturnTypeInference.ts` | `resolveLocalVariableReturnType()` 从光标行向上扫描赋值语句 | 大文件上每次 Hover 的文本处理成本及最坏情况 |
| `src/workspaceIndex.ts` | 已有 Python 方法、事件调用等局部索引 | 哪些查询已使用此索引，哪些功能仍在使用独立扫描路径 |

### 2.2 性能埋点要求

增加一个统一的内部性能记录器，例如 `src/languageServiceMetrics.ts`。名称可调整，但必须统一记录格式。

至少记录以下事件：

- `hover`
- `definition`
- `completion`
- `diagnostics`
- `python-index-scan`
- `python-composition-roots`
- `entity-mapping-scan`
- `semantic-query`
- `type-registry-query`
- `file-discovery`
- `document-parse`

每条记录包含：

- 操作名称与请求 ID；
- 文件类型、请求涉及的工作区/资产根标识；
- 总耗时及子阶段耗时；
- 文件发现、读取、解析和缓存命中次数；
- 本次是否等待初始化或索引任务；
- 索引 generation、文档 version；
- 成功、未命中、取消或异常状态。

不要默认记录完整文件内容、用户代码或其他敏感文本。

实现要求：

1. 采用单调时钟测量耗时。
2. 支持关闭详细记录；正常使用时不输出每次请求的冗长日志。
3. 提供汇总信息，至少包含请求次数、P50、P95、P99、最大值和缓存命中率。
4. 记录必须能区分扩展激活、首次索引、索引已就绪和单文件增量更新。
5. 不允许仅根据日志中的单次慢请求就认定根因；需要通过调用次数、耗时拆分和对照实验验证。

### 2.3 基线测试矩阵

建立可重复的测试资产集，至少包含：

- 小型项目：验证现有功能行为。
- 大型模拟项目：数万级源文件。
- 多资产根项目：至少三个互相独立的资产根，含同名实体和 Python 类。
- 大型 Python 文件：用于测试局部变量推导和 Definition。
- 大量 `.def`、`entities.xml`、`types.xml`、`alias.xml` 的项目。
- 包含 `.git`、构建目录、第三方依赖目录的项目。

记录测试机器、操作系统、Node.js/VS Code 版本、CPU、内存、存储介质、文件数量、文件类型分布、资产根数量和缓存状态。

必须分别测试：

1. 冷启动首次索引；
2. 索引已完成后的重复查询；
3. 打开未索引文件后的首次查询；
4. 编辑当前文件后的查询；
5. 修改 `.def` 或 XML 后的查询；
6. 删除文件或资产根后的查询；
7. 多个请求同时触发时的表现。

**第一阶段交付物：** 基线报告、主要调用链图、实际耗时拆分、已证实的瓶颈列表和对应复现步骤。未测量的数据必须标记为“待测”。

## 3. 第二阶段：建立统一的语言服务基础设施

在开始改造各个 Provider 前，先定义统一的数据契约。

建议增加以下模块；若仓库已有相同职责的实现，应优先扩展现有模块，不要机械地新增重复文件。

### 3.1 `documentStore`

职责：统一提供当前文档快照。

建议数据结构：

- 文件 URI 和规范化路径；
- 文档版本号；
- 文本内容或按需维护的行索引；
- 已解析的 Python、`.def` 或 XML 结构；
- 当前解析状态；
- 最近一次成功解析的版本。

要求：

- 当前打开的文档以 VS Code 内存文本为准，不能用磁盘旧内容覆盖编辑缓冲区。
- 相同文档版本只解析一次；不同版本必须能识别。
- 解析期间发生新编辑时，旧解析结果不得覆盖新版本。
- 对于没有必要保存完整 AST 的语言服务，允许缓存轻量结构。
- 对大型文档避免在每次查询中重复 `getText().split(/\r?\\
/)`。

### 3.2 `semanticIndex`

职责：提供 KBEngine 领域语义查询，而不是直接负责文件扫描。

统一承载或组合以下信息：

- 实体及其 `.def`；
- 实体的 Parent、interfaces、components；
- Base/Cell/Client 方法和属性归属；
- Python 类、基类、方法及实现文件；
- `entities.xml` 注册关系；
- `types.xml` 与 `alias.xml` 类型映射；
- 资产根、实体定义根和引擎/项目作用域；
- 每个符号的定义位置、来源文件和版本。

查询 API 应按真实需求设计，例如：

- 按当前文件及资产根解析实体归属；
- 查询某实体的指定分面方法或属性；
- 查询 Python 类、方法和继承关系；
- 查询 KBEngine 类型注解；
- 按符号名称和作用域查找定义；
- 获取与当前文档相关的诊断输入。

API 不应暴露需要调用方自行遍历所有资产文件的内部细节。

### 3.3 `indexScheduler`

职责：负责索引任务的生命周期与优先级。

至少支持：

- 首次索引；
- 单文件增量解析；
- 受影响符号和依赖的增量更新；
- 文件删除与资产根移除；
- 同一文件的任务合并；
- 过期任务取消或丢弃；
- 后台任务限流；
- 失败重试；
- 索引状态查询。

优先级建议：

1. 当前打开文件的轻量解析；
2. 当前请求需要但尚未建立的局部索引；
3. 当前文件修改所引起的相关依赖更新；
4. 后台全量索引；
5. 非交互式全项目分析。

VS Code Provider 可以等待必要的局部查询，但不能因为后台全量索引未完成而无条件等待所有文件解析结束。

### 3.4 `dependencyGraph`

职责：维护文件与语义符号之间的依赖关系。

例如：

- `entities.xml` 中实体注册变化影响相关实体解析；
- 某实体 `.def` 变化影响对应实体的属性、方法和类型映射；
- `types.xml` 或 `alias.xml` 变化影响依赖该类型注册表的类型查询；
- Python 类声明、继承或方法变化影响相关 Definition 与 MRO 查询。

必须按实际解析出的依赖建立失效关系，不允许简单地把任何文件变更都处理为全仓索引重建。

### 3.5 索引作用域

多个资产根必须显式进入索引模型。至少需要：

- 规范化根路径；
- 稳定的 root ID；
- 文件到 root 的映射；
- 根内符号索引；
- 根间查找顺序与冲突处理策略。

禁止依赖 `Map` 插入顺序或操作系统文件枚举顺序决定同名符号的实际命中结果。

先从现有代码和测试中提取已存在的查找顺序，将其转化为明确、可测试的策略。若目前没有定义清楚，应先记录现有行为并补充测试，再讨论是否改变。

## 4. 第三阶段：改造 Hover

### 4.1 当前调用路径

`src/extension.ts` 注册：

`registerHoverProvider(...) → KBEngineHoverProvider`

主要逻辑位于 `src/languageProviders.ts` 的 `KBEngineHoverProvider.provideHover()`。

源码中已确认：

- Python 方法声明可能进入 `resolveDefMethodAnnotation()`；
- 接收者调用可能进入 `resolveReceiverCallAnnotation()`；
- 内建属性可能进入 `resolveBuiltinPropertyAnnotation()`；
- 普通 Python Hover 还会调用 `resolveLocalVariableReturnType()`；
- 局部变量推导当前将 `document.getText()` 拆成完整行数组；
- 类型注解解析最终可能进入 `resolveEntityAnnotationType()`。

### 4.2 必须实施的改造

1. 引入 `DocumentSnapshot`，让局部变量推导复用当前文档的行数据或解析结果。
2. 在 `pythonReturnTypeInference.ts` 中分离“解析赋值语句”和“查询返回类型索引”两个职责。
3. 对当前文件建立必要的局部赋值索引，避免每次 Hover 都从光标行重新向上扫描全部文本。
4. 局部变量索引必须在文档编辑后增量更新或按版本重新构建。
5. 将类型注解解析改成查询 `semanticIndex` 的类型注册表快照。
6. `resolveDefMethodAnnotation()`、`resolveReceiverCallAnnotation()` 和 `resolveBuiltinPropertyAnnotation()` 继续保留现有语义检查，但不得各自触发全仓扫描。
7. 将异步查询拆分为“索引就绪检查、语义查询、Hover 构造”三个阶段，分别记录耗时。
8. 不得因为索引尚未就绪就输出错误的类型提示；可以按现有规则回退到普通 Hover。

### 4.3 验证方式

增加针对以下情况的测试：

- 普通变量 Hover；
- 局部变量返回类型推导；
- 同名变量多次赋值；
- 方法声明、接收者方法和内建属性；
- `types.xml` 与 `alias.xml` 中的自定义类型；
- 当前文档尚未保存；
- 同一文档连续编辑时的过期索引；
- 不同资产根内存在同名实体。

性能测试必须分别测量文本准备、局部符号查询、类型解析和最终 Hover 构造时间。

## 5. 第四阶段：改造 Definition 与 Python 索引

### 5.1 当前调用路径

Python Definition 在 `src/extension.ts` 注册：

`PythonDefinitionProvider(entityMappingManager, pythonClassIndex)`

`.def` 导航使用 `KBEngineDefinitionProvider`。

`src/languageProviders.ts` 中 `KBEngineDefinitionProvider.provideDefinition()` 会先执行 `eventDefinitionAt()`，再进入 `provideDefinitionTraced()`。后者存在多层查找逻辑，包括 KBEngine 内建桩、实体 `.def`、Python 类/MRO 和文件内作用域等。

`src/pythonClassIndex.ts` 中：

- `ensureScanned()` 使用 `findFilesAcrossRoots('**/*.py', ...)` 发现 Python 文件，再按 16 个任务一组加载；
- `ensureCompositionRoots()` 先等待 Python 扫描，再分别发现 `entities.xml`、`.def` 和 `types.xml`，随后逐文件读取并构建组合根映射。

因此，必须验证首次 Definition 是否在交互路径上等待这些全量任务。不能仅因存在异步函数就认定它不会阻塞用户。

### 5.2 必须实施的改造

1. 将 Python 文件发现和解析任务移入统一的索引生命周期。
2. 首次索引可以后台运行；Definition 应先查当前文档快照和已建立的符号索引。
3. 如果当前请求确实需要尚未索引的文件，只对必要的文件执行按需解析，并在后台补齐全局索引。
4. `PythonClassIndex` 的类、基类、方法、MRO、组合根数据必须具备明确的索引版本和失效条件。
5. 组合根构建不能每次因不同入口进入而重复发现和读取同一批 XML/`.def` 文件。
6. 将 `EntityMappingManager` 中 `.def` 扫描结果接入统一语义索引，避免同一 `.def` 被不同子系统重复解析。
7. 保留 `provideDefinitionTraced()` 当前分层查找的优先级和可追踪结果；先将每一层的数据来源切换为统一索引，再单独评估是否有必要调整层次。
8. 为同名类、同名实体和跨资产根定义建立稳定的候选排序策略。
9. 文件删除、类重命名、基类变更后，必须移除旧索引项，不能继续跳转到已不存在的位置。
10. 保留当前打开文件优先使用内存内容的行为。

### 5.3 验证方式

- 冷启动时立即请求 Definition，记录是否等待全仓索引。
- 分别测试类定义、方法定义、属性定义、基类定义、事件调用和 KBEngine 内建桩导航。
- 对同名类和多资产根进行冲突测试。
- 修改一个 Python 文件后，验证无关文件没有被重新解析。
- 修改实体 `.def` 后，验证相关 Python Definition 结果更新。
- 删除 Python 文件后，验证旧类和方法索引被移除。
- 模拟扫描中途失败，验证后续请求可以恢复，而不是永久停留在失败的 Promise 状态。

## 6. 第五阶段：改造 Completion

### 6.1 当前调用路径

`src/extension.ts` 注册了两类相关 Completion：

- `KBEngineCompletionProvider`：处理 `.def` 与 Python 的部分通用补全；
- `PythonCompletionProvider`：处理 Python 中的 KBEngine 实体相关补全。

`src/languageProviders.ts` 的 `PythonCompletionProvider.provideCompletionItems()` 已能识别 `kbe.` / `KBEngine.` 等模块符号语境，并通过 `EntityMappingManager.getMappingForPythonFile()` 获取当前文件的实体映射，再生成属性或方法补全。

### 6.2 必须实施的改造

1. Completion 使用当前文档快照识别光标上下文，不反复获取和处理整份文本。
2. 将实体归属查询、属性查询和方法查询统一委托给 `semanticIndex`。
3. 为符号名称和补全前缀建立可复用的索引，避免每次请求遍历全部属性或方法。
4. 保留现有 `kbe.`、`KBEngine.`、`self.`、接收者路径和 `.def` 结构补全规则。
5. 在索引未就绪时，只允许执行成本受控的局部解析；不得同步等待全仓索引。
6. 对输入过程中高频触发的 Completion 做必要的请求合并或过期结果丢弃，不能让旧请求结果覆盖新输入上下文。

### 6.3 验证方式

测试不同上下文下的候选内容、顺序、类型、详情文本和过滤结果，重点覆盖：

- `self.`；
- `self.base.`、`self.cell.`、`self.client.`；
- 嵌套属性路径；
- `kbe.` / `KBEngine.`；
- `.def` 的 XML 标签和结构补全；
- 同名属性和方法；
- 未完成输入、语法错误和索引未就绪状态。

对同一光标位置连续输入字符，统计每次 Completion 触发的扫描、解析和索引访问次数。

## 7. 第六阶段：改造 Diagnostics

### 7.1 当前调用路径

`src/extension.ts` 创建 `DiagnosticCollection('kbengine')`，并在 `onDidChangeTextDocument`、`onDidOpenTextDocument` 和现有文档初始化流程中调用诊断函数。

`src/languageProviders.ts` 中的 `validateDocument()` 已复用同一次 `parseDefAst(document)`，再执行标量校验和可选的结构校验。

因此，不能把重复解析整个 `.def` AST 当作当前必然存在的问题；必须从新基线确认剩余成本。

### 7.2 必须实施的改造

1. 诊断任务应使用 `DocumentSnapshot`，复用当前版本的解析结果。
2. 文档连续编辑时，合并过期诊断任务；只发布与当前文档版本匹配的结果。
3. 解析成本高的诊断应拆分为轻量本地诊断和依赖索引的语义诊断。
4. 语义诊断只在相关索引更新后重新计算，不因无关文件变化重新分析全部打开文档。
5. 修改诊断配置后，正确清理或重算受影响结果。
6. 保留现有诊断级别、范围、错误信息、开关和行为契约。
7. 为 `entities.xml` 等已有诊断入口建立相同的版本与失效约束。

### 7.3 验证方式

- 大型 `.def` 文件连续输入时，统计解析次数和诊断发布次数。
- 在慢解析期间继续编辑，确保旧版本诊断不会覆盖新版本结果。
- 测试诊断关闭、结构诊断关闭、重新启用等配置切换。
- 修改无关 Python 文件，确认不会触发全体 `.def` 诊断重算。
- 使用已有诊断测试锁定错误消息、范围和级别，避免只比较性能而忽略语义退化。

## 8. 第七阶段：统一文件发现与缓存失效

### 8.1 当前调用路径

`src/scanRoots.ts` 中的 `findFilesAcrossRoots()` 先调用 `vscode.workspace.findFiles()`，再通过 `walkExternalRoot()` 补充遍历外部资产根。

`walkExternalRoot()` 使用 `fs.readdirSync()` 递归遍历目录；`isDirectory()` 使用 `fs.statSync()`。

`src/definitionWorkspace.ts` 中的 `resolveEntityAnnotationType()` 每次调用都会计算基于文件元数据的类型注册表指纹；`entityAnnotationRegistryFingerprint()` 使用 `fs.statSync()` 检查相关定义文件，`readAliasXml()` 使用 `fs.readFileSync()` 读取别名文件。

这些实现确实存在同步文件系统操作，但其对实际卡顿的贡献大小必须通过性能记录确认。

### 8.2 必须实施的改造

1. 统一文件发现结果，按规范化路径去重，并明确每个文件所属的资产根。
2. 为文件发现结果增加生命周期与失效规则，避免每个 Provider 独立重新遍历目录。
3. 对外部资产根使用受控的异步发现或可复用的扫描结果；不能让全目录同步递归进入输入事件路径。
4. 使用 VS Code 文件系统事件和已知配置变化维护索引失效；在必要的情况下提供有界的重扫或手动刷新机制。
5. 将 `types.xml`、`alias.xml` 的读取、解析和注册表构建移动到更新事件或索引任务中。
6. 将类型注册表解析结果以快照形式提供给 Hover、Completion 和其他类型相关查询。
7. 当文件变更事件无法可靠覆盖所有情况时，提供显式的一致性检查机制，而不是在每次查询时对全量文件做同步元数据检查。
8. 明确资产根新增、移除、重命名和失去访问权限时的清理规则。

### 8.3 验证方式

在输入事件处理和语言服务请求期间，使用埋点确认：

- 是否发生递归目录遍历；
- 是否发生同步 `statSync`、`readdirSync`、`readFileSync`；
- 每次查询发现了多少文件；
- 类型注册表被重新构建的次数；
- 修改单个定义文件后，是否只使相关索引失效；
- 新增或移除外部资产根后，是否能更新结果。

不能仅用搜索源码中是否还存在 `readFileSync` 来验收。允许在明确的后台任务、初始化或非交互式路径中使用合适的文件系统操作；重点是消除不必要的交互关键路径阻塞。

## 9. 测试与验收标准

以下性能目标是本轮建议采用的**验收目标**，不是仓库当前已经测得的性能，也不是对加速倍数的承诺。最终需用固定测试环境和实际测试结果填写报告。

### 9.1 行为正确性

- 现有单元测试、集成测试和演示资产导航测试全部通过。
- Hover、Definition、Completion 和 Diagnostics 的现有语义保持一致。
- 多资产根、同名实体、同名类和不同根内的类型定义有稳定且可解释的解析结果。
- 文件新增、删除、修改、重命名和配置切换后，不保留失效的符号定义。
- 索引任务失败后可以恢复，旧任务不能覆盖新文档版本。

### 9.2 性能验收

| 指标 | 验收要求 |
|---|---|
| 已建立索引后的 Hover | 在固定大型测试集上测量 P50/P95/P99；建议 P95 目标 ≤ 30 ms |
| 已建立索引后的 Completion | 在固定大型测试集上测量 P50/P95/P99；建议 P95 目标 ≤ 50 ms |
| 已建立索引后的 Definition | 在固定大型测试集上测量 P50/P95/P99；建议 P95 目标 ≤ 50 ms |
| 单文件增量解析 | 记录不同文件大小和类型的耗时分布；建议常见测试文件的 P95 ≤ 100 ms |
| 交互请求中的全仓扫描 | 已建立索引后的正常请求不得触发全仓目录遍历 |
| 高频请求的同步文件系统访问 | 不得因为查询类型注解、局部变量或符号定义而重复同步检查整组资产文件 |
| 增量失效范围 | 单文件变更只更新该文件及依赖图确认的相关索引 |
| 索引冷启动 | 记录首次索引耗时、扫描文件数、解析文件数、内存和失败率；首轮先建立基线，再制定优化目标 |
| 大型项目稳定性 | 多轮查询和文件变更后，不出现持续增长的重复索引任务、过期结果或不可恢复的失败状态 |

P95 目标应以实际开发机和测试环境为依据评审。如果某类请求的语义解析本身较重，先交付测量结果、瓶颈拆分和明确的改进计划，不能通过删减功能或返回不完整结果达标。

### 9.3 可重复性能报告

每轮报告必须包含：

- 代码提交 SHA；
- 测试机器和软件版本；
- 测试资产集文件数量及组成；
- 冷启动与热缓存结果；
- 各语言服务的请求数、P50/P95/P99；
- 目录遍历、文件读取、解析和缓存命中次数；
- 与基线的对比；
- 任何未达标指标及原因。

## 10. 实施顺序与提交拆分

按以下顺序执行，避免一次性大重构无法定位回归：

### PR 1：性能观测与基线

新增性能记录器、测试场景和基线报告。此阶段不应改变语言服务结果。

### PR 2：文档快照与解析缓存

实现 `documentStore` 或扩展现有文档缓存；先接入 Hover 和 Diagnostics，保证版本一致性。

### PR 3：统一索引调度

引入 `indexScheduler`，接入现有 `EntityMappingManager`、`PythonClassIndex` 和 `WorkspaceIndex`。完成任务合并、过期任务丢弃、增量失效与失败恢复。

### PR 4：统一 KBEngine 语义查询

实现或整理 `semanticIndex` 与 `dependencyGraph`。先迁移类型注册表和实体映射查询，再迁移 Definition 与 Completion。保留原查询层的行为测试。

### PR 5：消除 Python Definition 的首次全仓阻塞

调整 `PythonClassIndex.ensureScanned()` 与 `ensureCompositionRoots()` 的调用关系，使局部 Definition 可以利用当前文档和已建索引工作，并由后台任务完成其余索引。

### PR 6：诊断与多资产根一致性

接入版本化快照、依赖失效、根级隔离和符号冲突测试，确保诊断和导航使用同一语义来源。

### PR 7：性能复测与回归

在相同环境、相同资产集、相同查询脚本下复测，与 PR 1 基线对比。没有可复现数据的性能声明不允许进入最终报告。

## 11. 最终交付物

Code Agent 完成后必须提交：

1. 所有代码改动与对应测试。
2. 性能基线和改造后报告。
3. 现有语言服务的调用链与新架构图。
4. 索引数据模型、作用域规则、失效规则和任务调度说明。
5. 多资产根与同名符号的解析策略说明。
6. 未解决问题清单和下一轮建议。
7. 一份明确的验收表，逐项标注通过、未通过或未测量。

**最终完成标准：** 不只是 Hover 变快，而是 Hover、Definition、Completion、Diagnostics 和 Python 索引共享一致的文档快照与 KBEngine 语义数据；全仓索引作为受控的后台任务运行，增量变更可以正确传播，性能问题能够通过指标复现和定位。</WritingBlock>

## 给 Code Agent 的执行提醒

我建议你把这份任务作为一个整体交给 Agent，但要求它**先完成 PR 1 的基线与调用链审计，再提交后续改造计划**。尤其要先验证三个最值得怀疑的热点：

1. **Hover：** `provideHover()` 中每次处理完整文档行数组，以及类型注解查询时反复计算文件指纹。
2. **Definition：** Python 类索引首次扫描和组合根构建是否处于当前请求的等待链上。
3. **索引：** `EntityMappingManager`、`PythonClassIndex` 与 `WorkspaceIndex` 是否重复发现、读取或解析同一批资产。

这些是源码支持的检查方向，不是已经测得的性能归因。真正的优先级应由第一阶段的耗时拆分决定。

---

## 落地跟踪（勾一项补一个 commit hash）

- [x] PR1 性能观测与基线（记录器 + 测试资产集 + 基线报告）— 89e8783（docs/perf/2026-baseline.md）
- [ ] PR2 文档快照与解析缓存（documentStore，先接 Hover/Diagnostics）
- [ ] PR3 统一索引调度（indexScheduler 接 EntityMappingManager/PythonClassIndex/WorkspaceIndex）
- [ ] PR4 统一语义查询（semanticIndex + dependencyGraph，先类型注册表与实体映射）
- [ ] PR5 消除 Python Definition 首次全仓阻塞（ensureScanned/ensureCompositionRoots 调用关系重构）
- [ ] PR6 诊断与多资产根一致性（版本化快照/依赖失效/根级隔离/冲突测试）
- [ ] PR7 性能复测与回归（同环境同资产对比 PR1 基线，无可复现数据不进报告）

