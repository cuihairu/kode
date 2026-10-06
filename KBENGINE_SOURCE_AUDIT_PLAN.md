# KBEngine 源码对照计划

这个文档只做一件事：
把 `kode` 当前涉及的功能按模块列出来，后续严格按模块逐项对照 `../kbengine` 源码核对，不再凭猜测继续扩展。

默认目标版本：

- 优先兼容 KBEngine 官方版本的源码语义。
- 当前以官方 Python 3.7.3 时代的实现和行为作为基线。
- 你本地集成的 Python 3.12.13 改动，只作为学习和补充参考，不作为扩展功能基线。

## 目标

- 先确认当前项目到底做了哪些功能块。
- 再按功能块逐项对照 `../kbengine` 源码。
- 没有源码依据的行为、提示、文档说明，统一下调、删除或重写。
- 默认以官方版本行为为准，不按本地魔改版本扩展能力边界。

## 状态说明

- `未核对`: 还没有按源码逐项检查。
- `核对中`: 正在对照官方源码确认语义。
- `待整改`: 已确认与源码不一致，等改实现。
- `待删除`: 已确认方向错误，应删除或下调。
- `已完成`: 已按源码核对并修正。

## 当前功能块

### 1. `.def` 语法高亮

- 当前状态：`已完成`
- 文件：`syntaxes/kbengine.tmLanguage.json`
- 内容：
  - `.def` 标签高亮
  - 类型高亮
  - `Flags` 高亮
  - 自定义实体名/属性名高亮
- 核对重点：
  - 标签集合是否和引擎真实支持的结构一致
  - `Flags` 名称是否和源码映射一致
  - 是否错误高亮了不存在或不推荐的结构
- 核对结果：
  - 语法高亮移除了把 `CellProperties`、`ClientProperties`、`BASE_CLIENT`、`LOW/HIGH/CRITICAL` 当成官方语义的旧规则。
  - 顶层区块和常量高亮改为对齐已核实结构：`Parent`、`Properties`、三类方法区块、`DetailLevels`、`DatabaseLength`、`ENTITYCALL`、`BASE_AND_CLIENT`、`NEAR/MEDIUM/FAR`。
  - 继续保留通用 XML 标签兜底，但不再把未核实结构赋予 KBEngine 专用语义高亮。

### 2. `.def` 智能提示

- 当前状态：`已完成`
- 文件：`src/languageProviders.ts`
- 内容：
  - `Type` 提示
  - `Flags` 提示
  - `DetailLevel` 提示
  - XML 标签提示
- 核对重点：
  - 提示项是否都来自源码真实支持的字段和值
  - 提示出现的位置是否符合源码解析方式
  - 是否错误支持了自由组合、错误标签或错误域
- 核对结果：
  - 顶层标签补全改为按源码入口收敛，只提示 `Properties`、`BaseMethods`、`CellMethods`、`ClientMethods`、`DetailLevels`。
  - 子标签补全改为按所在区块区分：属性节点只提示属性字段；`Base/Cell` 方法提示 `Arg/Utype/Exposed`；`ClientMethods` 不再提示 `Exposed`。
  - 类型补全扩展到 `<Arg>` 与容器内部标签，按源码支持的 `ARRAY/TUPLE <of>`、`FIXED_DICT <Properties>/<implementedBy>` 结构给出提示。
  - 基础类型集合补齐了源码内置的 `PY_DICT`、`PY_TUPLE`、`PY_LIST`、`BLOB`。

### 3. `.def` 悬停说明

- 当前状态：`已完成`
- 文件：`src/languageProviders.ts`
- 内容：
  - 类型说明
  - `Flags` 说明
  - 标签说明
  - 钩子说明
- 核对重点：
  - 说明内容是否来自源码或项目内可验证资料
  - 是否存在我自己编造的语义解释
  - 是否混入不符合当前引擎版本的旧行为
- 核对结果：
  - `.def` 标签 hover 收敛到源码可直接对应的结构：`Properties`、三类方法区块、`DetailLevels`、`radius/hyst`、`of`、`implementedBy` 等。
  - 删除了把 `CellProperties`、`ClientProperties` 当成官方实体定义区块的说明，避免继续把未见于当前源码入口的结构写成事实。
  - `.def` 符号 hover 不再混入 `hooks.ts` 的钩子文案，避免属性名或方法名碰巧重名时展示未核实说明。

### 4. `.def` 诊断与校验

- 当前状态：`已完成`
- 文件：`src/languageProviders.ts`
- 内容：
  - 未知类型检查
  - 未知 `Flags` 检查
  - 重复定义检查
  - 缺少 `Type` / `Flags` 检查
- 核对重点：
  - 哪些规则是源码明确会拒绝的
  - 哪些规则只是编辑器臆测
  - 哪些规则需要删除，哪些规则需要重写成源码语义
- 核对结果：
  - 以 `entitydef.cpp` 的属性与方法装载逻辑为准，`<Flags>` 改为按单个映射值校验，不再做自由组合与“冲突”判断。
  - 删除了“非法子标签”“重复 `<Type>/<Flags>`”这类源码未明确拒绝的编辑器臆测诊断。
  - 保留并强化了源码会直接导致装载失败的检查：未知类型、未知 `Flags`、未知 `DetailLevel`、缺少 `Type`、缺少 `Flags`、重复属性定义。

### 5. `.def` 跳转定义

- 当前状态：`已完成`
- 文件：`src/languageProviders.ts`
- 内容：
  - `entities.xml -> .def`
  - `.def` 内实体类型跳转
- 核对重点：
  - 跳转来源是否和真实 `scripts/entities.xml`、`entity_defs/*.def` 布局一致
  - 实体名、父类、引用类型的解析方式是否符合源码
- 核对结果：
  - `.def` 实体跳转继续保留 `Type` / `Arg` 中的实体引用，并补上源码 `loadParentClass()` 会读取的 `<Parent><EntityName/></Parent>` 父类跳转。
  - 实体定义路径改为按源码常见布局直接查找 `entity_defs/`、`scripts/entity_defs/`、`assets/scripts/entity_defs/`，删除了对 `**` 假通配路径的无效探测。
  - `entities.xml -> .def` 的跳转仍以实体名映射到同名 `.def` 文件为准，和源码的 `entities.xml + entity_defs/*.def` 装载关系一致。

### 6. Python 与 `.def` 映射

- 当前状态：`已完成`
- 文件：
  - `src/entityMapping.ts`
  - `src/pythonLanguageUtils.ts`
  - `src/languageProviders.ts`
- 内容：
  - Python 到 `.def` 跳转
  - `.def` 到 Python 跳转
  - Python 中 `self.xxx` 提示
- 核对重点：
  - 路径搜索是否符合你当前集成后的目录结构
  - 映射规则是否符合生成代码与实际脚本加载路径
  - 是否错误假设了 Python 文件组织方式
- 核对结果：
  - 映射构建不再依赖先找到 `scripts/entity_defs/*.py` 这类假定路径；即使对应 Python 脚本尚未落地，也会保留 `.def` 映射用于后续跳转与补全。
  - Python 脚本候选路径改为优先匹配 KBEngine 常见布局：`scripts/base`、`scripts/cell`、`scripts/interfaces`，并兼容 `assets/scripts/*` 与旧的 `entity_defs` 生成路径。
  - `self.xxx` 的嵌套属性与方法映射逻辑保持不变，但其可用性不再被单个 Python 文件是否存在所阻断。

### 7. 实体浏览器

- 当前状态：`已完成`
- 文件：`src/explorerProviders.ts`
- 内容：
  - 读取实体列表
  - 显示实体类型
  - 打开实体定义
- 核对重点：
  - 实体来源是否应完全以 `entities.xml` 和 `.def` 为准
  - `hasBase/hasCell/hasClient` 推断是否和源码一致
- 核对结果：
  - 实体来源继续以 `entities.xml` 为主，组件类型沿用 `hasBase/hasCell/hasClient` 属性，不再从不存在的 `.def` 区块推断。
  - 实体详情里的属性统计收敛到源码 `Properties` 区块，不再把 `CellProperties/ClientProperties` 计入官方结构。

### 8. 实体依赖分析

- 当前状态：`已完成`
- 文件：
  - `src/entityDependency.ts`
  - `src/entityDependencyWebView.ts`
- 内容：
  - 继承关系
  - 实体引用关系
  - 图形化展示
- 核对重点：
  - 继承和组件关系是否按真实 def 语义解析
  - 是否把编辑器层推断误当成引擎层关系
- 核对结果：
  - 依赖分析改为优先读取 `entities.xml` 的 `hasBase/hasCell/hasClient`，并按源码 `Parent -> <EntityName/>` 结构解析继承，不再读取不存在的 `parent="..."` 属性或 `Implements` 语法。
  - 属性依赖只分析 `Properties` 与容器里的实体引用，删除了 `MAILBOX` 猜测逻辑和 `CellProperties/ClientProperties` 伪区块解析。
  - 依赖图继续保留继承、`ENTITYCALL`/容器引用这类可解释关系，不再把编辑器层启发式结果当成官方事实。

### 9. 代码生成器

- 当前状态：`已完成`
- 文件：`src/codeGenerator.ts`
- 内容：
  - 生成 `.def`
  - 生成 Python
  - 写入 `entities.xml`
- 核对重点：
  - 生成模板是否符合真实 def 结构
  - 字段默认值、方法区块、属性区块是否符合源码
  - 不能在 `.def` 语义没核准之前继续相信这个模块
- 执行约束：
  - 在 `.def` 语义核准前，不继续增强这个模块
- 核对结果：
  - `.def` 生成模板改回源码实际结构：`Parent` 使用子标签写法，属性统一挂到 `Properties`，`Persistent/DatabaseLength/Exposed` 回到真实字段位置。
  - `Arg` 生成不再混入参数名，`entities.xml` 注册也不再写入不存在的 `parent="..."` 属性。
  - 生成器保留在“按当前已核实语义产出最小正确模板”的边界内，不再扩展未证实结构。

### 10. 服务器管理

- 当前状态：`已完成`
- 文件：`src/serverManager.ts`
- 内容：
  - 组件列表
  - 启动/停止/重启
  - 输出日志
- 核对重点：
  - 组件启动方式是否符合你当前集成版 KBEngine
  - 配置目录、资源目录、bin 目录解析是否正确
  - 是否错误简化了真实启动流程
- 核对结果：
  - 组件列表补齐 `interfaces`，启动参数按官方 `start_server.sh` 收敛到 `--cid`、`--gus`。
  - 启动环境补齐 `KBE_ROOT`、`KBE_RES_PATH`、`KBE_BIN_PATH`，避免继续以“裸启动单个二进制”冒充官方模板流程。
  - 服务器管理仍只覆盖本地单机常见启动场景，不再把更复杂的编排流程写成已支持。

### 11. 调试支持

- 当前状态：`已完成`
- 文件：`src/debugConfig.ts`
- 内容：
  - 调试配置生成
  - attach 流程
  - telnet 提示
- 核对重点：
  - 是否符合官方版本组件真实的 telnet / python 调试入口
  - 是否以官方 3.7.3 时代运行模型为基线
  - 你本地 3.12.13 改动只作为附加参考，不进入默认设计
- 核对结果：
  - 默认调试入口改为源码可证实的 telnet 端口与组件映射，附带 password / layer 等必要配置项。
  - VSCode 配置名称改成 “Python attach” 辅助语义，不再误导为 KBEngine 官方自带 debugpy 工作流。
  - 调试提示明确区分“telnet 开启调试”与“PID attach 仅为辅助”两步。

### 12. 日志收集与日志界面

- 当前状态：`已完成`
- 文件：
  - `src/logCollector.ts`
  - `src/logParser.ts`
  - `src/logWebView.ts`
- 内容：
  - logger 连接
  - 日志解析
  - 过滤与导出
- 核对重点：
  - 端口、协议、日志格式是否与源码和当前版本一致
  - 是否错误假设了 logger 输出格式
- 核对结果：
  - 现有 logger watcher 注册协议号与回包处理缺少源码依据，已下调为明确“不支持当前未完成适配”的状态。
  - 日志界面保留过滤、导出与状态呈现，但不再假装已经完成官方 logger 协议对接。

### 13. 监控面板

- 当前状态：`已完成`
- 文件：
  - `src/monitoringCollector.ts`
  - `src/monitoringWebView.ts`
- 内容：
  - watcher 指标收集
  - 组件状态面板
- 核对重点：
  - watcher 路径、字段、层级是否和源码一致
  - 是否混入不存在的指标定义
- 核对结果：
  - 监控采集器继续保留源码可证实的 watcher 路径：`globalOrder/groupOrder`、`baseapp numClients/numProxices/load`、`cellapp load/spaceSize/objectPools/*`、`logger stats/*`、`dbmgr` 根计数器。
  - `machine` 广播中的 `extradata*` 与 watcher 指标明确区分；baseapp/cellapp 的实体数、客户端数等基础状态来自 machine，不再把它们描述成 watcher 近似值。
  - 没有源码依据的通用 `entitySize/clients/messagesPerSecond` watcher 假设已下调，监控面板在 watcher 无响应时只保留 machine 基础状态。

### 14. 热更新相关提示

- 当前状态：`已完成`
- 文件：
  - `src/kbengineMetadata.ts`
  - `src/languageProviders.ts`
  - `snippets/kbengine.json`
- 内容：
  - `KBEngine.reloadEntityDef()`
  - `KBEngine.isReload()`
  - `importlib.reload()` 提示
- 核对重点：
  - API 是否在当前引擎版本和当前组件域真实存在
  - 调用上下文是否正确
- 核对结果：
  - 删除了对 `KBEngine.reloadEntityDef()`、`KBEngine.isReload()` 的事实性宣称；在当前官方源码中未找到对应公开 Python API。
  - 热更新提示改为源码确实暴露的 `KBEngine.reloadScript(fullReload)`，并明确其适用域是 `baseapp/cellapp` 组件脚本。
  - `importlib.reload()` 保留为 Python 标准库补充提示，不再冒充 KBEngine 专有热更新能力。

### 15. 文档与 README

- 当前状态：`已完成`
- 文件：
  - `README.md`
  - `docs/`
  - `PROJECT_SUMMARY.md`
  - `COMPLETED_FEATURES.md`
- 内容：
  - 功能说明
  - 配置说明
  - 调试说明
  - 完成功能清单
- 核对重点：
  - 哪些描述已经偏离源码事实
  - 哪些“已支持”需要撤回
  - 文档必须晚于源码核对结果更新
- 核对结果：
  - README、`docs/guide/*`、`PROJECT_SUMMARY.md`、`COMPLETED_FEATURES.md` 已同步收敛到源码核对后的能力边界。
  - 文档撤回了对 `reloadEntityDef/isReload`、旧 `.def` 区块、旧 Flags/DetailLevel、logger 已完成接入、监控近似 watcher 遥测等旧宣称。
  - 配置示例与功能说明改为跟随当前实现，避免再出现“代码已下调但文档仍宣称支持”的状态。
- 复核(批95，2026-10-03)：批91~94 落地后文档再次漂移，已逐项核对修正——README/PROJECT_SUMMARY 的预定义模板数 5→10、补性能分析与代码片段生成条目，PROJECT_SUMMARY 统计与勾选状态对齐实测(27 个 .ts/17082 行/21 个 .md/974+11 用例)，CHANGELOG Unreleased 的双层测试表述改为真实口径、已交付的 Planned 三项迁入 Added，docs/guide/commands.md 补齐 4 条缺失命令(`entity.method.open`/`database.open`/`def.analyze`/`snippets.generateFromSelection`)；并新增 tests/docsCommands.test.ts 锁定「命令贡献点必有文档小节 + 已知失实表述不得回潮」。
- 同批功能块清单补全：批58/91/94 落地的重构支持、性能分析建议、代码片段生成器此前不在本清单(见下 16~18)，登记为 `未核对`，后续批次按顺序核对。

### 16. 重构支持（.def 属性/方法重命名）

- 当前状态：`已完成`
- 文件：
  - `src/defRenamer.ts`
  - `src/languageProviders.ts`（KBEngineRenameProvider）
- 内容：
  - 顶层 `Properties` 属性与三类方法段方法的 F2 重命名
  - 同文件同名声明（含 Flags 作用域变体）更新
  - `Parent` 链与 `Interfaces` 传递闭包后代 def 的同名复述更新
- 核对重点：
  - “同名 Flags 作用域变体视为同一文本符号”是否符合引擎装载语义
  - 后代复述传播面是否与 `loadParentClass`/接口装载的实际解析范围一致
  - 边界声明（Python 侧/entities.xml/types.xml 不参与）是否如实
- 核对结果（批96，2026-10-03，执行方式五步输出）：
  - 这块当前功能列表：符号解析（顶层属性/方法段方法，光标落在开或闭标签名上）、同文件同名编辑、后代复述传播、定义根向上推导、provider 装配（languageProviders 的 KBEngineRenameProvider 为纯薄壳，无独立语义，未改）。
  - 对应官方源码文件：`kbe/src/lib/entitydef/entitydef.cpp`（loadDefInfo L339 起的装载顺序、loadInterfaces L551 起的 wrapper 拼写检查 L563-565、loadComponents L642 起——组件的接口仍从原定义根解析 L765、组件父类在 components/ 内解析 L774、loadParentClass L890-920 对 `<Parent>` 首个子节点取 getKey、loadDefPropertys 的按域 addPropertyDescription L1286-1297）、`kbe/src/lib/entitydef/scriptdef_module.cpp`（addPropertyDescription L533-610 与三类 addXxxMethodDescription L857/L920/L985 起的同域同名拒绝与跨域分立）、`kbe/src/lib/xml/xml.cpp`（getKey = trim(节点 Value)——文本节点取文本、元素取标签名）。
  - 已确认一致：① 重点1“Flags 作用域变体视为同一文本符号”——引擎按 cell/base/client 三域分立建 PropertyDescription 条目，同域同名复述直接装载失败、跨域同名是各自独立条目而非合并；把同名变体作为一组文本一起改名只是同时改两条引擎本就分立的文本，改名前后装载合法性不变，编辑器侧文本分组不引入错误边，**保留**。② 重点3 边界声明——entities.xml 只持实体名、types.xml 只持类型别名，成员名不出现，Python 侧不参与，声明属实，**保留**。
  - 已确认错误（重点2 传播面与引擎装载面不一致，4 处已修）：① Parent 取名只读文本（getScalarChildValue），漏引擎同样接受的 `<Parent><Hero/></Parent>` 元素形态——改为对 Parent 首个子节点做引擎 getKey 语义（文本取文本、元素取标签名）；同时按引擎锁定混合内容行为：标签间换行缩进使首子节点为空白文本 → 空名、引擎拼不出父类文件（装载失败），不产生边（“文本优先否则首元素”的写法会误跟随，已弃）。② Interfaces 只认 `Interface` 精确拼写，引擎同样接受的 `interface`/`type`/`Type`（entitydef.cpp L563-565）被当成“直取名”产生垃圾边——收敛为四拼写 wrapper 集合，接口名同样按首子节点取名（`<Interface>MoveIface</Interface>` 文本形态与元素形态都认）。③ `<Interfaces><MoveIface/></Interfaces>` 直取形态被跟随传播，而引擎对非 wrapper 子元素直接 continue 不装载——撤回该传播面（新增负向锁）。④ 边解析不按引擎路径：接口文件的 Parent 被跟随（引擎 loadInterfaces 不走 loadParentClass）、组件 Parent 落到实体命名空间解析（引擎在 components/ 内，L774）、引用名全域按类别递归匹配（引擎路径精确：实体父类平铺定义根、接口固定 interfaces/、组件的接口从原定义根解析 L765）——改为按 owner 类别的路径精确解析，闭包键从 `category:name` 改为命中文件路径，同名不同命名空间不再误连。
  - 删/改/保留：改——src/defRenamer.ts 的 parseDefFileSemantics/getReferenceTargetName（新）/INTERFACE_WRAPPER_NAMES（新）/resolveLinkPaths（新）/collectOwnerClosure 重写与头部边界注释，tests/defRenamer.test.ts 夹具 MoveIface/Avatar 改 wrapper 形态并 +4 用例（Parent 元素形态正锁、直取形态负向锁、接口文件 Parent 负向锁、组件 Parent 同目录正锁+越界负向锁、混合内容 Parent 负向锁），tests/defRenamerBranches.test.ts 夹具同步 wrapper 形态；保留——Flags 变体同符号口径、复述处只向下传播、Python 侧/entities.xml/types.xml 边界声明、递归枚举容差（引擎只装载 entities.xml 登记实体，编辑器面向“会被编辑的文件”，超集只影响建议面，已在文档如实声明）；文档——docs/guide/language.md 更新范围/边界、COMPLETED_FEATURES 功能 17、PROJECT_SUMMARY 功能 17 同步引擎对齐语义（README 的粗粒度表述复核后本就属实，未动）。
  - 遗留登记（不改，他块范围）：definitionSemantics.parseInterfaceRefs 仍接受 `<Interfaces>` 直取形态（块 6/8 时代的“三形态”口径，用于实体浏览器/依赖图/数据库 schema 的混入解析），与引擎装载语义存在同源偏差，登记为块 6/8 后续复核项——本块 renamer 已按引擎收敛，两模块口径差异已在各自注释注明。另：语言侧诊断的同作用域重复检查按 Flags **值**相等判重，比引擎的 domain 位重叠粗（如 BASE_AND_CLIENT 与 OWN_CLIENT 都含 client 位，引擎装载失败而诊断放行），属块 4 的既有粒度，一并登记待该块复核。新名与既有方法/属性/组件同名的引擎装载冲突不在 renamer 校验（engine 侧 addPropertyDescription/addXxxMethodDescription 按模块全局拒绝同名），已在边界声明补记并由 defAnalyzer 的 method-property-collision 检查项提示。

### 17. 性能分析建议（.def 静态分析）

- 当前状态：`已完成`
- 文件：
  - `src/defAnalyzer.ts`
- 内容：
  - `kbengine.def.analyze` 命令，8 个检查项产出优化建议（批99 起，原 7 个）
- 核对重点：
  - 幻影类型清单是否与 `DataTypes` 注册表逐名一致
  - 各检查项是否只以“优化建议”口径输出、不冒充引擎装载规则
- 核对结果（批96，2026-10-03，执行方式五步输出）：
  - 这块当前功能列表：单文件静态分析（analyzeDefDocument）+ 报告格式化（formatDefAnalysisReport），7 检查项（phantom-type/missing-type/duplicate-type-tag/heavy-sync-broadcast/redundant-detail-level/invalid-identifier/method-property-collision），命令接线在 extension.ts，诊断落 `kbengine-def-analysis`。
  - 对应官方源码文件：`kbe/src/lib/entitydef/datatypes.cpp`（addDataType L56-79 注册 21 个内建类型，BOOL/BOOLEAN/TUPLE/MAP/FIXED_ARRAY 逐名不在册）、`kbe/src/lib/entitydef/common.cpp`（stringToEntityDataFlags L45-77——旗标名单共 8 个：CELL_PUBLIC/CELL_PRIVATE/ALL_CLIENTS/CELL_PUBLIC_AND_OWN/OWN_CLIENT/BASE_AND_CLIENT/BASE/OTHER_CLIENTS，整串比对、无组合语法）、`kbe/src/lib/entitydef/common.h`（L19-27 位值、L45 ENTITY_CLIENT_DATA_FLAGS = BASE_AND_CLIENT|ALL_CLIENTS|CELL_PUBLIC_AND_OWN|OTHER_CLIENTS|OWN_CLIENT）、`kbe/src/lib/entitydef/entitydef.cpp`（loadDefPropertys：Type 经 enterNode 只取首个、缺 Type 报错返回；L967-1009 validDefPropertyName 按 ENTITY_LIMITED_PROPERTYS 与 KBEngine.Entity 既有属性拒绝受限名）、`kbe/src/lib/entitydef/scriptdef_module.cpp`（addPropertyDescription L533-610 拒绝与方法名 L539/组件名 L547 冲突及同域同名属性 L590；三类 addXxxMethodDescription L857/L920/L985 拒绝与属性同名——双向都是装载错误）。
  - 已确认一致：① 幻影类型清单——与 datatypes.cpp 注册表逐名核对，BOOL/BOOLEAN/TUPLE/MAP/FIXED_ARRAY 确不在册且 types.xml 别名机制救不回，"实体加载会失败"表述属实，**保留**；② heavy-sync-broadcast——ALL_CLIENTS 确为全体客户端广播位，大负载类型的同步开销提示为编辑器侧建议口径、未冒充引擎规则，**保留**；③ 检查定位与报告格式无引擎语义宣称，**保留**。
  - 已确认错误（4 处已修）：① CLIENT_SYNC_FLAGS 名单失实——含引擎不存在的幻影名 ANY_CLIENT（common.cpp 8 名单里没有）、误含纯 cell 广播位 CELL_PUBLIC（0x1，不在 ENTITY_CLIENT_DATA_FLAGS）、漏掉真客户端位 OWN_CLIENT/CELL_PUBLIC_AND_OWN/BASE_AND_CLIENT——导致冗余 DetailLevel 检查双向失真（漏报 CELL_PUBLIC+DetailLevel、误报三个真客户端旗标下的有意义配置），改为 ENTITY_CLIENT_DATA_FLAGS 位集展开的 5 名单；② invalid-identifier 表述失实——"实体类无法生成该成员"不成立：引擎 C 层 setattr 挂关键字名不报错、装载不失败，真实影响只是 Python 脚本语法无法写 self.class 访问，改为如实口径；③ method-property-collision 表述失实——"Python 实体类中会互相覆盖"不成立：引擎装载时按名冲突直接拒绝（scriptdef_module 双向检查），改为"实体加载会失败"；④ duplicate-type-tag 表述不准——引擎 enterNode 只取首个 <Type>、行为确定而非"取值歧义"，改为按首取语义表述；附带把 missing-type 的含混表述（"无法确定存储与同步布局"）收敛为"实体加载会失败"（引擎找不到 Type 报错返回，与 phantom-type 同级事实）。
  - 删/改/保留：改——src/defAnalyzer.ts 的 CLIENT_SYNC_FLAGS（引擎真值名单）、describeKeywordProblem、method-property-collision/missing-type/duplicate-type-tag 四处消息文案与注释；tests/defAnalyzer.test.ts +2 用例（真客户端旗标负向锁 ×3、CELL_PUBLIC 漏转报正锁 + ANY_CLIENT 幻影名负向锁）并补消息文案锁（装载不失败/实体加载会失败/只装载首个/不得回潮"互相覆盖""无法生成"）；tests/perfRegression.test.ts 建议 goldens 重取（findingCount 220→620：夹具 CELL_PUBLIC|ANY_CLIENTS 与 BASE_PUBLIC|CELL_PUBLIC 两类旗标的 DetailLevel 由漏转报，digest 827fa39f/77945013）；文档——COMPLETED_FEATURES 功能 18 与未来增强 ⑦、PROJECT_SUMMARY 功能 18 同步引擎口径（README/docs 的粗粒度表述复核后本就属实，未动）；保留——幻影类型清单、heavy-sync 口径、检查项与实时诊断的错位分工、Flags 按 '|' 容错拆分（引擎整串比对会拒绝组合旗标，该情形由语言侧实时诊断拦，分析侧容错只影响建议面）。
  - 遗留登记（不改，后续候选）：① 引擎 validDefPropertyName 还会拒绝 ENTITY_LIMITED_PROPERTYS 受限名（id/position/direction/spaceID/autoLoad/cell/base/client/cellData/className/component/databaseID/isDestroyed/shouldAutoArchive/shouldAutoBackup/__ACCOUNT_NAME__ 等，common.h L125-158）与 KBEngine.Entity 既有属性名——kode 诊断与分析均未覆盖，属可新增检查项（有源码依据，待排期）；② 同名检查只比单文件，继承链跨文件同名（引擎按模块全局拒绝）不在范围，已在文档如实声明；③ 幻影类型清单只列高频误写 5 名，引擎 21 注册名的任意拼错属语言侧"未知类型"诊断范围，两模块分工维持现状。
- 核对结果补充（批99，2026-10-05，遗留①收口，执行方式五步输出）：
  - 这块当前功能列表：检查项 7→8——新增 `engine-limited-name`：属性/方法名/组件槽名命中引擎受限名单（def 属性注册、脚本类构造的 PROPERTY/COMPONENT_PROPERTY/METHOD/CLIENT_METHOD 四类 DefContext、loadComponents 三处共用 validDefPropertyName，拒绝即实体加载会失败）；FIXED_DICT 键不查（引擎 DC_TYPE_FIXED_ITEM 明写放开）。
  - 对应官方源码文件：`entitydef/common.h` L125-158（名单含 C 字面拼接怪癖："component" 行尾缺逗号与 "databaseID" 拼成单条目 "componentdatabaseID"，两名单独不被拒；"interface" 与终止哨兵 "" 拼接后仍在名单）、`entitydef/entitydef.cpp` L967-1009（validDefPropertyName 名单臂 + KBEngine.Entity 运行时属性查询臂）、`entitydef/py_entitydef.cpp` L520/550/562/574（四类 DefContext 注册拒绝，抛 AssertionError）、L2519（def XML 属性注册拒绝）、`entitydef.cpp` L660（loadComponents 槽名拒绝）、L588-594（FIXED_ITEM 分支注释明写放开键限制）。
  - 已确认一致：清单按编译后真值逐名收录（含 componentdatabaseID 条目）；KBEngine.Entity 属性臂不硬编码（运行时面不在引擎仓静态可推导，COMPLETED_FEATURES 范围注记如实声明）。
  - 已确认错误：无新增——本项为遗留①登记的新增检查，非既有实现缺陷。
  - 删/改/保留：改——`src/defAnalyzer.ts`（DefAnalysisCheck 联合 + ENTITY_LIMITED_PROPERTYS 常量与拼接怪癖注释 + Properties/方法节/Components 三处检查）、`tests/defAnalyzer.test.ts`（+7 用例：属性/方法/组件命中正锁、拼接怪癖双向锁、"interface" 正锁、FD 键豁免锁、普通名负向锁）、COMPLETED_FEATURES 检查项 ⑧ 与范围注记、README 性能分析节；保留——原 7 检查项与语言侧实时诊断的错位分工不变。
  - 遗留登记（更新）：原①已由批99 落地——受限名单臂全量实现，Entity 运行时属性臂以静态不可推导为由不硬编码（COMPLETED_FEATURES 范围注记声明）；②③ 维持不变。

### 18. 代码片段生成器（自定义代码片段）

- 当前状态：`已完成`
- 文件：
  - `src/snippetGenerator.ts`
  - `src/extension.ts`（命令接线）
- 内容：
  - 选区文本转义/去公共缩进，合并写入工作区 `.code-snippets` 文件
- 核对重点：
  - 是否宣称了任何引擎能力（应为纯编辑器功能，scope 取文档语言）
  - 转义与合并语义是否与 VSCode 片段文件格式一致
- 核对结果（批97，2026-10-04，执行方式五步输出）：
  - 这块当前功能列表：纯逻辑层 `src/snippetGenerator.ts`——`escapeSnippetText`（片段语法转义）、`selectionToSnippetBody`（统一换行/去首尾空行/按非空行最少缩进去公共缩进/逐行转义）、`mergeSnippetEntry`（新建/合并/同名覆盖判定/顶层非对象与坏 JSON 抛错）、路径常量 `.vscode/kbengine-custom.code-snippets`；命令装配层 `src/extension.ts`——`kbengine.snippets.generateFromSelection`（选区守卫 → 名称/前缀必填 → 描述可选 → 空选区/无工作区守卫 → 读-合并-写，同名覆盖警告，坏 JSON 拒绝改写），package.json 贡献命令与激活事件。纯编辑器功能，无引擎参与，scope 恒取生成时文档 languageId。
  - 对应官方源码文件（VS Code main，2026-10-04 取）：`src/vs/base/common/json.ts`——片段文件经 `parse`（L864）装载，属性写入走 `setObjectProperty`（L847-860）：`__proto__` 键改用 `Object.defineProperty` 保留自身属性，注释明写防原型污染；`src/vs/workbench/contrib/snippets/browser/snippetsFile.ts`——`load()`（L269-285）`jsonParse` 后以 `Object.entries`（L274）枚举自身键，`JsonSerializedSnippet` 字段与 `isJsonSerializedSnippet` 形状判定（L176-187，`body` 真值即平铺条目），`_parseSnippet`（L295）`body` 数组 `join('\n')`（L304）、prefix 缺省回退 `''`、`scope` 按 `split(',')` 取语言列表（L318）；`snippetsService.ts` 里 `.code-snippets` 文件不设 `defaultScopes`（L509），逐条 `scope` 生效（L507 语言文件才钉死默认域）；`src/vs/editor/contrib/snippet/browser/snippetParser.ts`——`_parseEscaped`（L790）：`\` 只转义 `$`/`}`/`\` 三字符、其余保留反斜杠，`_until` 反转义正则 `\\(\$|}|\\)`（L776），`_parse`（L781-787）兜底 `_parseAnything`（L1146）——散落 `{`/`}` 按字面文本；`src/vs/editor/contrib/snippet/browser/snippetSession.ts`——`adjustWhitespace`（L427-467）取插入行前导空白（L429），续行 `lineLeadingWhitespace + 行` 后 `normalizeIndentation`（L462/L466），片段体自身缩进不剥离。官方文档 User Defined Snippets（https://code.visualstudio.com/docs/editor/userdefinedsnippets）：片段文件为 JSONC、项目级 `.vscode/*.code-snippets` 位置、`prefix`/`body`/`description`/`scope` 字段与 `body` 转义示例。KBEngine 源码不涉及——本块与引擎装载/语义无交点，`../kbengine` 无可对照面，核对重点 1 即查「是否零引擎宣称」。
  - 已确认一致：① 核对重点 1 全表面零引擎能力宣称——package.json 命令标题/图标/激活事件、四条命令消息、`docs/guide/commands.md` 与 `features.md` 小节、README/COMPLETED_FEATURES 功能 19/PROJECT_SUMMARY/CHANGELOG 条目、源码头注与行注全部纯编辑器口径，`kbengine` 仅出现在命令 id 与文件名（命名而非能力）；scope 取生成时文档 languageId（`.def` 即 package.json 注册的 `kbengine-def`），与官方 `.code-snippets` 逐条 `scope`（单语言 id 为合法列表项）语义一致——**保留**。② 转义与官方片段语法逐点一致——官方 `\` 为转义前缀（仅 `$`/`}`/`\`），本实现对 `\` 双重转义、对 `$` 前缀转义，产出与官方文档示例同形（文本 `$MyVar = 2` → 转义 `\$` → JSON `\\$`）；`}` 不转义但因 `$` 全量转义不可能进入占位符/选择支上下文，散落 `{`/`}` 官方按字面文本——**保留**。③ 去公共缩进与官方插入语义配套——官方 `adjustWhitespace` 给续行叠加插入行缩进并归一化、不剥片段体自身缩进，本实现先剥公共缩进避免叠加双份，源码注释「插入位置的缩进由编辑器补」属实——**保留**。④ 合并落盘格式与官方装载面一致——顶层对象、2 空格缩进、尾部换行；条目仅 `scope`/`prefix`/`body`（`description` 空串省略，官方以片段名回退显示），`body` 行数组（官方 `join('\n')` 消费）、`prefix` 单串（官方兼容串或数组）、`scope` 单语言 id（官方 `split(',')` 后列表项）；路径即官方项目级片段文件位置；严格 JSON 是官方 JSONC 超集的子集，可被官方加载器读取；既有条目原样透传——**保留**。⑤ 带注释/坏 JSON 拒绝改写——官方片段文件为 JSONC（容忍注释与尾逗号），本实现显式报错、不静默丢用户注释，`commands.md`/`COMPLETED_FEATURES`/`PROJECT_SUMMARY` 三处如实记载该边界——**保留**。
  - 已确认错误（1 处已修，合并语义与片段文件装载不一致）：`mergeSnippetEntry` 用普通赋值 `root[name] = record` 写条目，片段名为 `__proto__` 且既有文件无该键时命中 `Object.prototype.__proto__` 访问器——条目不落任何自身属性即被丢掉（`overwritten` 判 false、序列化输出 `{}\n`），命令层照报「已生成自定义代码片段」，成功消息与落盘内容相悖；官方装载面对同一键专门防御（`setObjectProperty` 用 `defineProperty` 保留自身属性），且 `Object.entries` 枚举自身键——同一输入官方可装载、本实现写丢并报成功，属核对重点 2 的合并语义不一致。改为 `root = { ...root, [name]: record }`（spread/计算键按 CreateDataProperty 定义绕开访问器，常规名称行为不变），+2 用例（新建名 `__proto__` 落盘含 `"__proto__"` 自身属性键、键序与值全等；既有 `__proto__` 条目再生成 `overwritten` 判 true 且前缀更新、他条目保留）；变异复跑验证：换回普通赋值第 1 例红（输出 `{}\n`），还原后全绿。
  - 删/改/保留：改——`src/snippetGenerator.ts` 的 `mergeSnippetEntry` 条目写入（普通赋值 → spread/计算键）与注释，`tests/snippetGenerator.test.ts` +2 用例（`__proto__` 名正锁 ×2）。文档——README/CHANGELOG/`commands.md`/`features.md`/COMPLETED_FEATURES 功能 19/PROJECT_SUMMARY 功能 19 中本块表述逐条复核属实未动（全仓 README/docs 粗粒度表述复核属已登记遗留，按本批边界不动）。保留——转义口径（`\`/`$`）、批94「选区按字面收录不推断占位符」口径、公共缩进剥离+编辑器补缩进、scope=文档 languageId、同名覆盖警告、坏 JSON/带注释拒绝改写不静默改写、`workspaceFolders[0]` 落盘（与 codeGenerator/debugConfig 等全仓既有约定一致）。
  - 遗留登记（不改，后续候选）：① 公共缩进按字符数计（`/^[ \t]*/` 长度），纯 tab 或纯空格选区精确，tab/空格混用时相对层级可能残留偏移——修正需引入编辑器 `tabSize` 列语义，纯逻辑层暂无该输入，待排期；② 片段文件的读/写 IO 失败（权限、同名目录、磁盘满）不在命令层 catch，交 VS Code 通用命令错误呈现——文件仅在成功解析后才改写，无静默损毁，如需友好提示待排期；③ 多根工作区固定取首根落盘与 codeGenerator/debugConfig 等全仓 `workspaceFolders[0]` 约定一致（非本块引入），活动文档不在首根时片段仍写首根 `.vscode/`——如要按文档所在根落盘需全仓统一改口径，待排期。

### 19. 数据库 Schema 查看

- 当前状态：`已完成`
- 文件：
  - `src/databaseSchema.ts`（表/列快照、结构列与位置列合成、types.xml 别名解析、虚拟文档与行定位）
  - `src/explorerProviders.ts`（database 段树形消费与字段叶子）
  - `src/languageProviders.ts`（表/字段双向跳转接线）
- 内容：
  - `scripts/entity_defs` def 树 → 表/列模型（根表/组件子表/数组子表、字段行定位、schema 虚拟文档）
  - 类型别名链（types.xml）解析与 mysql 列型/列名预览
- 核对重点：
  - 结构列、位置/朝向合成列、组件子表跳过规则是否与引擎建表语义一致
  - 属性持久化判定与 ARRAY/FIXED_DICT/别名装载是否与 entitydef 装载语义一致
- 核对结果（批98，2026-10-05，执行方式五步输出；本块按批95「清单补块」先例于批98 登记）：
  - 这块当前功能列表：`src/databaseSchema.ts`——`getDatabaseSchemaSnapshot`（workspace 布局 → def 树递归收集持久属性 → 表/列列表，组件表/数组子表/FIXED_DICT 平铺/位置朝向合成列）、`buildMysqlTableSchemas`（结构列 id/sm_autoLoad/parentID、VECTOR 展开、ENTITYCALL 丢列、同名去重）、`resolveAliasType`/`parseArrayElementDescriptor`（types.xml 别名链、结构别名原地展开、环检测）、虚拟文档 URI 与 schema 渲染、表/字段行定位、source/target 三态跳转与反查；`src/explorerProviders.ts` 的 database 段（`tbl_` 分组 → 字段叶子 → `kbengine.database.open`）；`src/languageProviders.ts` 渲染文本字段定位与 target 反查。
  - 这块对应的官方源码文件：`kbe/src/lib/db_mysql/entity_table_mysql.cpp`——建表 `syncToDB`（L379-381 子表 `parentID bigint(20) unsigned NOT NULL, INDEX(parentID)`、L392 `id bigint(20) unsigned AUTO_INCREMENT, PRIMARY KEY idKey (id)`、L417-418 `sm_autoLoad` 列 `tinyint not null DEFAULT 0` 与 L112 索引）；建表属性循环（L150-154：实体无 cell + `DATA_TYPE_ENTITY_COMPONENT` + 槽无 base 域 → continue，组件连表跳过）；hasCell 位置朝向（L174-210：两组 `VECTOR3`，itemName `position`/`direction`）；列名分派 `init_db_item_name`（L210 调用/L215-231 FD 前缀分派、基形 L940 `sm_%s%s`、ARRAY L1357、FIXED_DICT L1486、Component L1620、ENTITYCALL `syncToDB` 空实现 L1191-1194 从不建列）；组件属性循环跳过（L1534 `!pScriptDefModule->hasCell() && pdescrs->hasCell() && !pdescrs->hasBase()` → continue）；`db_mysql/entity_table_mysql.h` L271/312/353 向量 `sm_%d_%s%s`；`db_interface/entity_table.h` L40-44 前缀常量（parentID/sm/autoLoad）与 L177 `TABLEITEM_MAP`（按 UID 有序）；`entitydef/entitydef.cpp` L551 `loadInterfaces`、L689-712 组件槽 `Persistent` 默认真/"false" 才关、L1097 `loadDefPropertys`（缺 Flags L1143、缺 Type L1215 报错路径）；`entitydef/datatypes.cpp` L94/105 `DataTypes::loadTypes`；`entitydef/scriptdef_module.cpp` L302 `autoMatchCompOwn`；`entitydef/datatype.cpp` L1658-1719 `FixedArrayType::initialize`（`<of>` 文本递归）；`xml/xml.cpp` L72-95 `enterNode`/L113-119 `getKey`（trim 后按元素 TAG 名匹配）。
  - 这块已确认一致的部分：① 结构列三件套（每表 `id` 主键 + `sm_autoLoad` 默认 0 带索引，子表另加 `parentID`）与引擎 DDL 同形；位置/朝向六列仅 hasCell 实体（两组 VECTOR3 经向量命名展开为 `sm_0_position..sm_2_position`、`sm_0_direction..sm_2_direction`），向量列 index 在前、FD 前缀夹在 index 与项名之间，FD 平铺 `sm_<名>_<键>`——**保留**。② 属性入表只看 `Persistent` 文本（忽略大小写恰 "true"），持久映射无域过滤（cellOnly 属性照常落列），缺 Type 收集层剔除；组件槽相反（默认持久、"false" 才关）与 `loadComponents` 同构；`STRING` 长度缺省 255；`ENTITYCALL` 不落列（引擎 `syncToDB` 空实现从不建列）——**保留**。③ 组件跳过规则 (a)（实体无 cell + ENTITY_COMPONENT 槽无 base 域 → 连表跳过）与建表循环 L150-154 逐项对齐；槽域 = 组件模块域（def 内容旗标域 + 非空方法段，经父链/接口包装键递归 ∪ 脚本存在性；client 域需 base/cell 至少一域同在），与 `autoMatchCompOwn` 置真不清零语义一致——**保留**。④ types.xml 别名链（指引文本、结构别名 FIXED_DICT/ARRAY 原地展开、别名→内建复用同一注册实例、环检测、空指引不解析）与 `loadTypes`/`getDataType` 同构；数组元素按解析后 kind 分支、别名元素复用条目同一实例——**保留**。⑤ 容忍超集按批93 口径如实标注（缺 Flags/Type/of、缺 def、四拼写外包装键：引擎报错或 continue，kode 预览子集或跳过，测试注释注明）——**保留**。
  - 这块已确认错误的部分（2 处已修，均在别名装载面）：D-T1 `parseArrayElementDescriptor` 按 raw typeName 字面判分支、容器恒取 `<of>`——types.xml 结构别名作数组元素时整支跳过，别名 FIXED_DICT 元素即使进入也取错容器（inline 数组的别名元素 Properties 挂在 types.xml 条目下而非 `<of>`，得到空 children）；引擎按解析后 kind 分支且别名元素复用 `loadTypes` 先建的条目实例——改为 raw||resolved 双分支 + 容器按 `resolved.kind` 三目。D-A3 `resolveAliasType` 对指引直接落内建的别名（如 UINT16，不在 typeAliases 表）返回 unresolved，mysql 列型标签丢失；引擎 `getDataType` 只认注册名、`addDataType` 只改 aliasName 复用同一内建实例——补 `BUILTIN_DB_TYPE_NAMES`（简单类型集 + VECTOR2/3/4）在环守卫前分流。附带清理：`mergeComponents` 外层冗余类目判断（接口类目提前 return，调用点恒 entity/component）；`has*` 扫描父臂按不可达契约收进 istanbul ignore 区间（批98 定性）。
  - 这块接下来要删什么、改什么、保留什么：改——`src/databaseSchema.ts` 的 `parseArrayElementDescriptor` 分支结构、`resolveAliasType` 内建分流与 `BUILTIN_DB_TYPE_NAMES` 常量、`mergeComponents` 简化、`has*` 父臂 ignore 区间；测试——`databaseSchema.test.ts` 15→18、`databaseSchemaGaps.test.ts` 12→19、Deep/Branches 各换 1 例新语义断言、explorer/languageProviders 断言随结构列语义修正（合计 +10 用例；变异复跑两缺陷各致 1 红，还原后全绿）。保留——虚拟文档/渲染/定位表面、快照容忍超集口径、列序按文档序（`TABLEITEM_MAP` 按 UID 有序不可复现，属展示选择）、explorer/languageProviders 消费面。
  - 遗留登记（不改，后续候选）：① redis 后端引擎存在、本实现从未产出（预览面按 mysql 单口径）；② 引擎按组件脚本模块建 `tbl_<组件>` 根表，kode 视角挂实体域（展示组织差异）；③ hasCell/组件域的脚本判定以文件存在性近似 dbmgr `loadAllEntityScriptModules` 的导入成功/失败语义；④ 组件规则 (b)（L1534：实体无 cell 且组件属性 cell-only → 跳过该属性列）按 def 内容模型契约不可达（组件属性带 cell 域 ⇒ 组件模块 hasCell ⇒ `autoMatchCompOwn` 匹配实体 setCell ⇒ 实体有 cell，首操作数恒假）——文档登记不写码；⑤ 容忍超集（缺 Flags/Type/of、缺 def、四拼写外包装键：引擎中止或 continue，kode 预览子集/跳过，测试注释已标注）；⑥ `TABLEITEM_MAP` 按 UID 有序、列序不可复现，kode 按文档序（展示选择）；⑦ 跨块（不属本块）：语言侧 Flags 诊断按值判重与 `g_entityFlagMapping` 域位粒度（BASE_AND_CLIENT 与 OWN_CLIENT 同域位重叠时引擎装载失败、诊断放行）——块16 遗留已登记归块 4 复核，本块仅记引用；⑧ entities.xml 属性语义本块用「声明优先 + 脚本存在性」模型，块 7/8 浏览器口径不变。

## 核对顺序

后续严格按下面顺序过，不并行乱写：

1. `.def` 诊断与校验
2. `.def` 智能提示
3. `.def` 悬停与跳转
4. Python 与 `.def` 映射
5. 调试支持
6. 服务器管理
7. 代码生成器
8. 日志与监控
9. 文档清理

## 执行方式

每次只做一块，输出内容固定为：

1. 这块当前功能列表
2. 这块对应的官方源码文件
3. 这块已确认一致的部分
4. 这块已确认错误的部分
5. 这块接下来要删什么、改什么、保留什么

## 当前约束

- 没有源码依据，不新增行为。
- 没有源码依据，不宣称“支持”。
- 先校正功能边界，再改实现，再补测试，最后改文档。
- 如官方版本与本地魔改版本不一致，默认先站在官方版本一侧。
