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
