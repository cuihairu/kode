# 语言能力

本页说明 Kode 在 `.def` 文件上的语言能力，包括高亮、补全、悬停、跳转和诊断。

## 支持范围

当前重点支持：

- `.def` 文件
- `entities.xml`
- 生成后的 Python 实体文件与 `.def` 的双向关联

## 语法高亮

`.def` 本身就是 XML 方言：整体按内建 XML 语法着色（标签蓝、属性名浅蓝、标点灰、字符串橙，与常规 XML 编辑观感一致），再叠加一层 KBEngine 语义色。

### 语义着色（叠加在 XML 基础色之上）

- 区块标签：
  - `Properties` — 玩家属性
  - `BaseMethods` — BaseApp 上的方法，可远程调用
  - `CellMethods` — CellApp 上的方法，可远程调用
  - `ClientMethods` — 客户端回调方法
- `Exposed` 及其 `true` 值 — 该方法客户端可直接请求
- `Persistent` 及其 `true` 值 — 该属性自动存储
- Flags 值：`BASE_AND_CLIENT`、`ALL_CLIENTS` 等引擎常量

上述颜色由扩展自带主题提供（Properties 琥珀、BaseMethods 绿、CellMethods 青、ClientMethods 紫——四区块加粗，Exposed 红、Persistent 橙、Flags 值蓝；全部对深色背景 ≥4.5:1 对比度）；换用其他主题时语义 scope 仍在，颜色由该主题决定。

### 其余部分

类型值（如 `UINT32`）、`DetailLevel` 值、自定义属性名与方法名均为普通 XML 分词，不再有专属着色——类型与值对齐由诊断和补全承担。`<` `>` 参与编辑器括号配对着色，注释块为 `<!-- -->`。

### 设计目标

- 视觉对应关系与常规 XML 编辑一致，结构一目了然
- 用户点名的引擎要素（四区块、Exposed、Persistent、Flags 常量）一眼可辨
- 语义层只覆盖上列要素，不私造语法

## 智能提示

### 类型补全

在 `<Type>` 或 `<Arg>` 的值语境中会提供常见类型补全。

### Flags 补全

在 `<Flags>` 中会提供 Flags 建议。

### DetailLevel 补全

在 `<DetailLevel>` 中会提供：

- `NEAR`
- `MEDIUM`
- `FAR`

### 标签补全

输入 `<` 时会提示常见结构标签。

## Hover

当前 Hover 分为三类，可以单独开关。

### 标签说明

例如悬停：

- `Type`
- `Flags`
- `Properties`
- `FIXED_DICT`

会显示该标签的用途说明。

配置项：

- `kbengine.hover.showTagDocs`

### 值说明

例如悬停：

- `UINT32`
- `BASE_AND_CLIENT`
- `FAR`

会显示值的含义、用途和说明。

配置项：

- `kbengine.hover.showValueDocs`

### 自定义符号摘要

例如悬停自定义属性或方法：

```xml
<HP>
  <Type> UINT32 </Type>
  <Flags> BASE_AND_CLIENT </Flags>
</HP>
```

会显示当前定义的摘要信息，例如：

- `Type`
- `Flags`
- `Default`
- `DetailLevel`
- `Arg`

配置项：

- `kbengine.hover.showSymbolDocs`

## 跳转定义

### 当前支持

- 从 `entities.xml` 跳转到对应的 `.def`
- 从 `.def` 中 `Type` / `Arg` 里的实体引用跳转到对应实体定义（实体引用解析到定义根平铺位置，组件引用解析到 `components/` 子目录）
- 从 `.def` 的 `Parent` 跳到父类 def、`<Interfaces>` 包裹内的接口名跳到 `interfaces/` 下的接口 def
- 从 `Properties` 字段 `DetailLevel` 值跳到同文件 `<DetailLevels>` 下的档位声明行
- 从生成的 Python 文件跳转回 `.def` 中的属性和方法
- 从 `Properties` 字段名跳到实现脚本，落点四档：与 def 同名的 `class` 定义行 → `__init__` 行 → 首个 `class` 行（类名与 def 不一致时）→ 脚本首行（base→cell→client 取第一个在盘脚本；引擎在 `__init__` 之前装载属性，属性名未必出现在脚本里，类/`__init__` 行仍是可靠锚点）
- 属性实现脚本按引用闭包解析：组件 def 落 `scripts/cell/<组件>.py` 等角色脚本，接口 def 落 `scripts/interfaces/<接口名>.py`（不跟随 `Parent`），实体 def 沿自身角色脚本 → `<Interfaces>` 混入脚本 → `Parent` 链逐级向上；全链落空且数据库 schema 也未命中时弹信息提示指明属性名与期望的 `scripts/<角色>/<实体>.py`，不再无声无息
- 点属性 `<Type>` 值：内建类型（`UINT32` 等）弹「引擎内建、无对应声明文件」提示；自定义类型未在 types.xml 声明时弹「未找到声明」提示，均不无声
- 从 `BaseMethods` / `CellMethods` / `ClientMethods` 方法名跳到对应角色脚本里的 `def` 行（未配置工程索引时按文件约定回落；方法未实现——脚本缺失或没有对应 `def` 行——时弹信息提示指明期望的 `scripts/<角色>/<实体>.py`，不再无声无息）
- 方法实现脚本按引用闭包解析：自身角色脚本 → `<Interfaces>` 混入的 `scripts/interfaces/<接口>.py` → `Parent` 链逐级向上（接口 def 自身的实现在 `scripts/interfaces/<接口名>.py`，接口不跟随 `Parent`）

### 典型示例

```xml
<Target>
  <Type> Avatar </Type>
  <Flags> BASE_AND_CLIENT </Flags>
</Target>
```

把光标放到 `Avatar` 上，可以跳到 `Avatar.def`。

## 重命名

在 `.def` 文件里把光标放到顶层属性名或方法名上（开标签或闭标签均可），按 `F2` 即可重命名。

### 更新范围

- 同文件内同名声明：属性的全部 Flags 作用域变体、方法所属段内的同名方法
- 后代实体定义中的同名复述：`Parent` 链与 `Interfaces` 混入的传递闭包覆盖到的 `.def`（传播边对齐引擎装载路径：`Parent`/接口名取元素的**首个非空白子节点**——文本取文本、元素取标签名，同引擎 `getKey` 语义；tinyxml 默认丢弃元素间纯空白文本节点（`condenseWhiteSpace=true`，KBEngine 未改），换行缩进的展开写法与紧凑写法同样装载，`<Parent>` 里只留空白时无子节点、不产生边；实体父类解析到定义根平铺位置、组件 def 的 `Parent` 在 `components/` 内解析、接口固定解析到 `interfaces/` 子目录；接口文件装载时不读 `Parent`；`<Interfaces>` 只认 `interface`/`Interface`/`type`/`Type` 四种包裹拼写，以接口名直接命名的子元素（如 `<MoveIface/>`）引擎不装载、不产生传播边）
- 开标签与闭标签上的名字同步更新

### 边界

- 只更新 `.def` 面；Python 侧 `self.x` 访问与方法调用、`entities.xml`、`types.xml`、数据库 schema 视图不参与
- 在复述处发起重命名只向下传播（该文件与其后代），不会回改祖先源头声明
- `BaseMethods` / `CellMethods` / `ClientMethods` 是三个独立命名空间，同名方法互不影响
- 新名必须是合法标识符（字母或下划线开头）；目录里找不到 `entities.xml` 定位定义根时只更新当前文件
- 新名与既有方法/属性/组件同名不做装载校验（引擎侧同名属装载错误，可由「性能分析」命令的同名检查项提示）
- 文件枚举覆盖定义根整树（含未在 `entities.xml` 登记的 `.def`），面向"会被编辑的文件"而非"本轮被装载的文件"

## 诊断

诊断分成“总开关”和“规则子开关”。

### 当前规则

- 未知类型
- 未知 Flags
- 未知 DetailLevel
- 重复属性或方法
- 属性缺少 `Type` / `Flags`

### 推荐使用方式

如果你觉得过于频繁，不要直接关掉全部诊断，优先关闭这些更吵的规则：

- `kbengine.diagnostics.checkDuplicateDefinitions`
- `kbengine.diagnostics.checkMissingPropertyFields`

完整配置说明见 [配置说明](./configuration.md)。

## 当前边界

目前还没有完整做到：

- 重命名只覆盖 `.def` 定义与引用面，Python 侧引用同步与实体本身的更名属于下一阶段
- 默认值与类型的严格匹配检查
- 跨全部项目实体引用的深度静态分析

这些属于下一阶段增强。
