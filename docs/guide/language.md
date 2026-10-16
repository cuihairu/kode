# 语言能力


本页说明 Kode 在 `.def` 文件上的语言能力，包括高亮、补全、悬停、跳转和诊断。

## 支持范围

当前重点支持：

- `.def` 文件
- `entities.xml`
- `types.xml`
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

### types.xml 语义着色（注入语法）

`types.xml` 不注册独立语言，默认由 VS Code XML 插件接管基础着色；Kode 用注入语法（injection grammar）在其上叠加引擎语义 scope，不抢宿主分词：

- KBEngine 内置类型（`UINT32`、`ARRAY` 元素类型位置等）→ `support.type.kbengine.builtin`
- 用户自定义类型引用（`<Type>SKILL_SLOT</Type>` 等）→ `entity.name.type.kbengine.custom`
- `ARRAY` 指令 → `keyword.other.kbengine.array`
- `FIXED_DICT` 指令 → `keyword.other.kbengine.fixed-dict`
- `<implementedBy>` 的值分段着色（批131）：点号前的每一段（模块路径）→ `entity.name.namespace.kbengine.implmodule`，紧贴闭标签的最后一段（实现对象）→ `variable.other.kbengine.implementedby`；裸值（无点号）整段落符号段。分段与引擎装载语义对齐（`datatype.cpp` 的 `loadImplModule` 把值当「模块路径.实现对象」处理）

注入选择器带 `- (comment, string)` 排除：语义色不进注释与属性值；类型定义标签（`<SKILL_SLOT>` 本身）保持 XML 标签色，只有 `<Type>` 引用处着语义色。颜色由主题按 scope 决定，不写死色值——扩展自带「KBEngine Dark」主题下：内置绿 `#98C379` / 自定义琥珀 `#E5C07B` / ARRAY 紫 `#C678DD` 粗体 / FIXED_DICT 橙 `#D19A66` 粗体 / implementedBy 模块段紫 `#C678DD`（与 ARRAY 同色但不同场景，ARRAY 带粗体且不同时出现在一个值里）+ 符号段蓝 `#61AFEF`，均对 `#272822` ≥4.5:1；VS Code 内置 Dark+/Light+ 等主题将把内置与自定义折叠为该主题的标准类型色、两条指令折叠为标准关键字色（scope 语义仍在，换回 KBEngine Dark 即恢复全区分）。

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

### 数据库存储（Persistent 属性）

悬停带 `<Persistent>true</Persistent>` 的属性时追加一行数据库落点提示：

- 完整 `` `db`.`table`.`column` `` 全名（库名读自引擎配置；读不到时只给表级全名，不虚构）
- 引擎 DDL 片段（列型、`not null`、`DEFAULT`）与具体取值约束：整型按 MySQL 区间、varchar 按解析后长度（未声明 `<DatabaseLength>` 缺省 255）
- 同 DDL 多列并作一条（如 VECTOR3 的三列）；ARRAY / 组件属性说明去往的子表与 `parentID` 关联

完整能力说明见 [功能总览](./features.md) 的「属性 → 数据库提示与 Schema 视图」。

### types.xml 类型形态（落库形态）

`types.xml` 类型声明名上悬停时，在自定义类型摘要后追加「落库形态」段：

- 别名指向内建类型：主表单列（附解析后的列型，如 `smallint unsigned`）
- FIXED_DICT：平铺成列、不成表；顶层键各占一列
- ARRAY：成子表 `tbl_<实体>_<属性>`、元素各占一行；元素落列按元素类型递归一层（内建给 `sm_value` + 列型，FIXED_DICT 给键平铺，嵌套数组套更深层子表，缺 `<of>` 明说元素类型未知）
- 未解析类型（链断或别名环）：明说「未知类型，引擎装载 types.xml 会失败」

形态判定与 Schema 视图同一套引擎语义（别名解析、列展开同源）；`implementedBy` 值上的悬停只谈引用，不带形态段。

## 跳转定义

### 当前支持

- 从 `entities.xml` 跳转到对应的 `.def`
- 从 `.def` 中 `Type` / `Arg` 里的实体引用跳转到对应实体定义（实体引用解析到定义根平铺位置，组件引用解析到 `components/` 子目录）
- 从 `.def` 的 `Parent` 跳到父类 def、`<Interfaces>` 包裹内的接口名跳到 `interfaces/` 下的接口 def
- 从 `Properties` 字段 `DetailLevel` 值跳到同文件 `<DetailLevels>` 下的档位声明行
- 从生成的 Python 文件跳转回 `.def` 中的属性和方法
- `types.xml` 的 `<implementedBy>` 值（形如 `MODULE.symbol`，引擎按 `.` 拆两段：`ImportModule` 前段 + `GetAttrString` 后段）双向跳转：正向从 implementedBy 值跳到实现文件里符号的定义行（`class`/`def`/赋值三种形态，符号解析不到才回落文件首行）；反向从 Python 符号（定义名或任意引用处）跳回 `types.xml` 的 implementedBy 行，悬停给出引用方类型与落点行，点击与提示同一套解析
- RPC 方法标记：Python 实现脚本里，方法名命中实体 def 方法声明（`BaseMethods`/`CellMethods`/`ClientMethods`）的函数，在声明行上方出一行 CodeLens（`RPC · <区块> · [Exposed ·] <来源 def 文件名>`），点击跳回 def 声明行；未在 def 声明的普通函数不出 lens
- types.xml 类型声明行引用反扫 CodeLens（批134）：声明名上方按真实引用逐条出镜（`Hero.itemId → tbl_Hero.sm_itemId` 形态，一条使用一枚），点击执行 `kbengine.database.open` 打开该实体 Schema 视图并定位到对应列；同一类型超过 10 处使用折叠出一枚 `+N 处落库未列出` 计数镜（无命令、仅提示）；类型无引用不出镜；`.def` / `types.xml` / `entities.xml` 增删改即失效重扫
- 从 `Properties` 字段名跳到实现脚本，落点四档：与 def 同名的 `class` 定义行 → `__init__` 行 → 首个 `class` 行（类名与 def 不一致时）→ 脚本首行（base→cell→client 取第一个在盘脚本；引擎在 `__init__` 之前装载属性，属性名未必出现在脚本里，类/`__init__` 行仍是可靠锚点）
- 脚本目录按 def 文件自身位置反推：从 `.def` 向上找最近的 `entity_defs` 目录（按名字匹配，或同级含 `entities.xml`/`types.xml`），其父目录即脚本根，脚本 = `<父>/{base,cell,client}/<实体名>.py`；找不到再回落工作区候选链（`entity_defs`、`scripts/entity_defs`、`assets/scripts/entity_defs`、`server_assets/scripts/entity_defs`），约定全 miss 时走有界深扫描（限深 7 层/2 万条目，剪 `node_modules`/`.git`/`out`/`dist`），同步读只认唯一命中，多候选宁缺勿猜。文件相对解析优先于工作区相对解析，非标准布局（如 `server/scripts/entity_defs`）同样可跳
- 属性实现脚本按引用闭包解析：组件 def 落 `scripts/cell/<组件>.py` 等角色脚本，接口 def 落 `scripts/interfaces/<接口名>.py`（不跟随 `Parent`），实体 def 沿自身角色脚本 → `<Interfaces>` 混入脚本 → `Parent` 链逐级向上；全链落空且数据库 schema 也未命中时必有落点：脚本确实不存在 → 该实体在 `entities.xml` 的声明行（无注册表时退 def 首行），同时弹辅助提示列出全部已检查的候选路径，不再只弹提示不跳
- 点属性 `<Type>` 值：内建类型（`UINT32` 等）弹「引擎内建、无对应声明文件」提示；自定义类型未在 types.xml 声明时弹「未找到声明」提示，均不无声
- 从 `BaseMethods` / `CellMethods` / `ClientMethods` 方法名跳到对应角色脚本里的 `def` 行；工程索引未收录该符号或脚本时按文件约定（def 相对候选链）回落，仍找不到实现 → 落 `entities.xml` 声明行或 def 首行（同属性口径，必有落点），提示仅作辅助
- 方法实现脚本按引用闭包解析：自身角色脚本 → `<Interfaces>` 混入的 `scripts/interfaces/<接口>.py` → `Parent` 链逐级向上（接口 def 自身的实现在 `scripts/interfaces/<接口名>.py`，接口不跟随 `Parent`）
- 悬停与补全提示里的脚本路径一律是真实解析到的路径（工作区内显示工作区相对路径，区外显示绝对路径），解析不到时明说「未找到实体脚本，期望位置：」并列出全部候选，不再出现 `scripts/{base,cell,client}/xxx.py` 花括号模板

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
- RPC 方法标记按方法名匹配，不分实现归属：闭包脚本（父类/接口实现）里恰好与某实体 def 声明同名的辅助函数也会出 lens；解析器只回答「该名字是不是 def 声明的 RPC 方法」，不回答「这一行是不是它的实现」
- 默认值与类型的严格匹配检查
- 跨全部项目实体引用的深度静态分析

这些属于下一阶段增强。
