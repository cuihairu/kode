# .def / 自定义类型 → `.pyi` 类型桩 可行性分析(只分析,不实现)

> 来源:用户 2026-10-16 需求「能支持生成 utype 定义类型的 .pyi 文件吗,自动生成类型提示,现实吗?」。
> 本轮只落设计与结论,不写实现代码;所有判断给 `file:line`,语料限制如实标注。

## 0. 结论速览

| # | 问题 | 结论 | 工作量 |
|---|---|---|---|
| 1 | 现有解析能否读出 utype 定义 | **能,但不在 entityMapping/PythonClassIndex 那套**——定义由 `databaseSchema.parseTypeAliases` 解析(types.xml);`.def`/`PythonClassIndex` 只存引用与 Python 类 | 小(接线) |
| 2 | utype → Python 注解映射 | **现实**:标量/ARRAY/别名直译,FIXED_DICT → `TypedDict`;复杂嵌套待真实工程验证 | 小-中 |
| 3 | 生成物 + Pylance 接线 | **有前提才现实**:复用 `stubDir`+`extraPaths` 现成设施;但**纯 `.pyi` 模块运行时不可 import**,须选「真 `.py`(TypedDict)」或 `TYPE_CHECKING` 约定;且**不许**生成同名 `.pyi` 遮蔽项目 `.py` | 中 |
| 4 | 时机与更新 | **现实**:激活期自动 + 手动命令先例现成,`.def`/types.xml watcher 去抖有先例;默认目录生成物**不提交** | 小-中 |
| 5 | `self.x` 让 Pylance 静态可知(不改用户代码) | **不现实**(唯一 Pylance 路径是遮蔽项目 `.py`,损实现语义);现状由 kode 自有 provider 补位 | — |
| — | 总评 | **有前提才现实**:「类型面生成类型模块」= 中等工作量可做;「实体自注解面」= 不现实,须改用户代码或维持 kode provider | 中 |

## 1. 现状:现有解析覆盖到哪

### 1.1 entityMapping / PythonClassIndex 那套**读不出** utype 定义

- `src/defParser.ts:58` `parseDefDocument` 是通用 XML 解析(fxp,`parseTagValue:false` 见 `:55`),不带类型语义。
- `src/entityMapping.ts:152` 索引只从 `findFiles('**/*.def')` 建;索引结构 `:107-123`(`EntityMappingIndex`)只有 `methodDefinitions`、`properties: { [name]: { defFile, line } }` 等——**存的是「引用落点」,Type 串原样透传,不存类型定义**。
- `src/pythonClassIndex.ts:40` `parsePythonFile` 只解析 `.py` 的类/方法,扫描面 `:247` `findFiles('**/*.py', ...)`——**完全不看 .def**。

→ 结论:题目点名的两套索引都**不含 utype 定义**;定义在 `entity_defs/types.xml`,由下面另一条线解析。

### 1.2 真正解析类型定义的三处(仓内已有,可复用)

1. **types.xml 别名定义(= utype 定义本体)**:`src/databaseSchema.ts:724` `parseTypeAliases` → `Map<名, { kind: 'fixedDict'|'array'|'builtin'|'unresolved', ... }>`;注释明确对齐引擎 `DataTypes::loadTypes`(别名=条目标签、`FIXED_DICT`/`ARRAY` 走结构、其余文本按已注册类型复用),见 `:96`、`:742-747`;装配点 `:246`。FIXED_DICT 的键与元素类型保存在 XML `node` 上,可继续走子解析。
2. **`.def` 里的类型串(含内联 ARRAY)**:
   - `src/kbengineMetadata.ts:11-12` 注明引擎 `entitydef.cpp` 对属性 `<Type>ARRAY<of>…</of></Type>` 特判,`:41` 落进补全文档;
   - `src/definitionSemantics.ts:74-88` 结构化 `<Arg>` 序列(ARRAY 走 `<of>` 链、嵌套递归,`:627`、`:693` 注释对齐 `FixedArrayType::initialize`);
   - `src/clientSdkGenerator.ts:116-118`、`:197` 按引擎口径把 `<Type>` 直文本与 `<of>` 元素类型分两栏读取。
3. **「utype → 目标语言」的既有先例(最接近本需求的已完成品)**:`src/clientSdkGenerator.ts:152` `aliases: ReadonlyMap<string,string>`;`:272-295`「语言中立类型表:内置表逐语言,别名与 FIXED_DICT 与工程 types.xml 同源」;`:301-321` 解析链**内置 → FIXED_DICT 名字 → 别名递归 → 兜底**;FIXED_DICT 伴随类发射见 `:559`(TS)、`:571`(C#)、`:667`(独立文件)。**同构问题已在 TS/C# 生成器解过一遍**,`.pyi` 是第三种发射目标。

### 1.3 术语澄清:本仓 "utype" 两层含义(别混)

- **消息层 utype = 类型/方法编号**,不是自定义类型:`src/messageTable.ts:127`「本级类型 utype(ARRAY 级 = 内联数组类型自身 utype)」;引擎侧 `kbe/res/sdk_templates/client/ue4/Source/KBEnginePlugins/Engine/Bundle.h:133`(`uint16 utype`)、`EntityCall.cpp:67`(`methodUtype`)。
- **本需求的「utype」= 自定义类型别名/复合类型**,即 types.xml 别名条目 + `.def` 引用。`.def` 的 `<Aliases>` 节在本仓语料 **0 命中**(`grep '<Aliases>' --include='*.def'` 全仓空),别名定义实际都在 `types.xml`。

### 1.4 真实样例(语料如实)

**样例 1 — 定义(复合类型)**,`D:\workspaces\kbengine\.tmp\kbengine_typing_fixed_dict_fixture\scripts\entity_defs\types.xml`(全文 13 行):

```xml
2:  <AVATAR_INFO> FIXED_DICT
3:      <Properties>
4:          <name><Type> STRING </Type></name>
7:          <level><Type> UINT32 </Type></level>
10:     </Properties>
11: </AVATAR_INFO>
12: <AVATAR_INFO_LIST> ARRAY <of> AVATAR_INFO </of> </AVATAR_INFO_LIST>
```

**样例 2 — 引用(`.def` 使用 utype)**,同夹具 `scripts/entity_defs/Avatar.def`:

```xml
4:      <Type> AVATAR_INFO </Type>          <!-- profile 属性 -->
8:      <Type> AVATAR_INFO_LIST </Type>     <!-- history 属性 -->
14:     <Arg> AVATAR_INFO </Arg>            <!-- BaseMethods.updateProfile -->
19:     <Arg> AVATAR_INFO_LIST </Arg>       <!-- CellMethods.syncSnapshots -->
```

**样例 3 — 内联 ARRAY 形态(引擎特判)**:`src/kbengineMetadata.ts:41` 登记的文档原文「内联写法 `<Type>ARRAY<of>元素类型</of></Type>`,元素类型放在 `<of>` 子节点」,依据 `kbe/src/lib/entitydef/entitydef.cpp` 属性加载特判(`:11-12`)。

**语料限制(如实)**:

- 非第三方 `.def` 全仓 **18 个**(多为 `.tmp` 类型夹具 + SDK 模板 + BigWorld 示例);可见 `<Type>` 值仅 `STRING`/`INT32`/`INT16`/`INT8` + 上述两个夹具 utype。
- **SDK 模板的 `types.xml` 是空壳**(2 行),复杂类型分布(多层嵌套、VECTOR3 键、混合 ARRAY)在本仓**取不到真实样本**;真实游戏工程的类型面需拿到后复验(见 §7)。
- 「utype」一词在本仓真实出现于消息/方法编号语境(§1.3),**不存在**名为 utype 的 `.def` 结构。

## 2. 映射可行性:utype → Python 类型注解

| utype 形态 | 真实例 | 目标注解 | 档位 |
|---|---|---|---|
| 标量 | `STRING`/`INT32`(Avatar.def:4 引用面同型) | `str` / `int`;`FLOAT`/`DOUBLE`→`float`;`BOOL`→`bool` | **直译(小)** |
| `PYTHON` / `PY` / 未识别 | 语料外,引擎语义即任意对象 | `typing.Any`(有损但合法) | 直译(小) |
| 别名→已注册类型 | types.xml 第三形态(`parseTypeAliases` 'builtin' 臂 `databaseSchema.ts:750`) | `AVATAR_NAME = str`(type alias) | **直译(小)** |
| ARRAY 元素型 | `AVATAR_INFO_LIST`(types.xml:12) | `list[AVATAR_INFO]`;嵌套 `list[list[T]]`(`definitionSemantics.ts:75` 已有递归链) | **直译(小)** |
| FIXED_DICT | `AVATAR_INFO`(types.xml:2-11) | `class AVATAR_INFO(TypedDict): name: str; level: int` | **需生成类(小-中)** |
| FIXED_DICT 嵌套 / 键为向量型 | 本仓无真实样本 | 嵌套 `TypedDict` 递归;键型引用向量类(见 §7 待证) | 中(需真实工程验证) |
| 固定长数组(FIXEDARRAY) | 引擎 DB 层 `kbe/src/lib/db_interface/entity_table.h:24`、`FixedArrayType`(`entity_table_mysql.cpp:1261`) | **Python 侧就是 list** → 归 ARRAY 直译;是落库结构不是新 Python 形态 | 直译(小) |
| 消息/方法 utype 编号 | `messageTable.ts:127`、`Bundle.h:133` | **与类型提示无关,不生成** | 排除 |

**判词**:映射面**现实**——三档齐全,且最难的「别名递归 + FIXED_DICT 结构」已有 `clientSdkGenerator.ts:301-321` 验证过的实现路径可抄口径;不确定性集中在真实工程的复合深度(本仓无样本)。

## 3. 生成物形态与 Pylance 接线

### 3.1 放哪:复用 `stubDir`,不与 .def 同名

- 目录三级解析现成:**设置 `kbengine.python.stubDir`(`package.json:1001`)> 环境变量 `KBENGINE_STUB_DIR` > 默认约定 `.kbengine/stubs`**(`src/pythonStubExport.ts:24/:31/:37-39`,文档 `docs/guide/configuration.md:277`)。
- `.def` 没有同名 `.py` 模块,「与 .def 同名」无处可挂;建议**单模块集中**:`kbe_types.pyi` 或 `kbe_types.py`(见 3.2),与既有 `KBEngine.pyi`(`pythonStubExport.ts:21`)同居。

### 3.2 让 Pylance 用上(现有接线 + 一个硬前提)

- **接线已存在**:`python.analysis.extraPaths` 由 `src/pythonExtraPaths.ts:24` 写入(注释 `:4` 明说 Pylance 靠它解析);默认存根目录在管理段(`:8-9`「设置开且 KBEngine.pyi 在盘才并入」;边界见 `configuration.md:281`)。激活期自动同步 `extension.ts:972-975`,手动命令 `extension.ts:964-971`(`kbengine.python.exportStubs`)。
- **硬前提(不解决则整条不成立)**:**纯 `.pyi` 模块运行时不可 `import`**——Python 导入器没有 `.pyi` 加载器,用户代码写 `from kbe_types import AVATAR_INFO` 会运行时报 `ModuleNotFoundError`,而只在 `TYPE_CHECKING` 分支用才安全。两条可落地方案:
  - **方案 A(推荐)**:生成**真 `.py`**(内容是 `TypedDict`/type alias,运行时可用)——Pylance 与运行时都成立;复用 `stubDir` 目录与「内容一致零写」纪律(`pythonStubExport.ts:5-7/:58`)。
  - **方案 B**:保持纯 `.pyi`,**约定**用户以 `if TYPE_CHECKING: from kbe_types import ...` + 字符串注解书写——零运行时依赖,但要改用户代码并写进文档。
- **`python.analysis.stubPath`**:Pylance 的另一桩路径,**本仓 0 命中**(未接线),列为待证选项,不作依赖。
- **红线:不生成与项目 `.py` 同名的 `.pyi`**(实体类桩)。extraPaths/stub 优先级下,同名 `.pyi` 会**遮蔽项目实现文件**,Pylance 从此看不到真实方法体(补全/跳转语义被桩替代),弊大于利 → 明确排除。

### 3.3 与现有跳转索引共存

- 全部**只读**消费 `.def`/`types.xml`;写只落 `stubDir`(默认目录 kode 自管、内容一致零写、建议 gitignore:`configuration.md:279`;`KBEngine.pyi` 头部亦自带该建议 `kbeModuleIndex.ts:513`)。
- `entityMapping`(`:152`)与 `PythonClassIndex`(`:247`)都不读 `.pyi`,互不影响;kode 自有的 hover/补全/跳转(`languageProviders`,数据源是 `.def`)**不依赖 Pylance**,两者**互补不冲突**:Pylance 拿类型名,kode 拿工程语义(RPC、落库、跳转)。

## 4. 时机与更新

- **先例三件套已齐**:激活期自动导出(`extension.ts:972-975`,`{ silent: true }`)+ 手动命令(`:964-971`)+ 内容一致零写/陈旧才重写(`pythonStubExport.ts:5-7/:58`)。
- **`.def`/types.xml 变更 → 重生成**:去抖 watcher 有现成先例(`src/hotReload.ts:5` 建 watcher 去抖合并连发保存、`:38-44` debounceMs 口径)→ 建议同法;最小起步可**只做手动命令 + 激活期**,watcher 二期(小 → 中)。
- **产物提交与否**:默认 `.kbengine/stubs` 已定性为「kode 自管、建议 `.gitignore` 忽略,生成物随索引更新」(`configuration.md:279`、`kbeModuleIndex.ts:513`)→ **不提交**;用户自配目录 = 用户资产,kode 只扫描不覆盖(`configuration.md:279`)。

## 5. 分条结论与工作量

1. **读出 utype 定义 —— 现实(小)**:不新写解析,复用 `parseTypeAliases`(`databaseSchema.ts:724`)+ `clientSdkGenerator` 解析链(`:301-321`);缺口只是把 `.def` 引用面(`entityMapping.ts:107-123` 的 Type 串)与 types.xml 定义**接起来**成一张类型表。
2. **映射 —— 现实(小-中)**:直译三档 + `FIXED_DICT→TypedDict` 覆盖样例级全部形态;复杂嵌套待真实工程复验(不确定性=中,不是工作量)。
3. **生成物与接线 —— 有前提才现实(中)**:前提 A 选「真 `.py`(TypedDict)」或前提 B 立 `TYPE_CHECKING` 约定(§3.2);同时守住「不 shadow 项目 `.py`」红线。满足后复用 `stubDir`+`extraPaths`+零写设施,增量主要是**发射器 + 类型表**。
4. **实体属性 `self.x` 让 Pylance 静态可知 —— 不现实**:桩不改用户 `.py` 就无处挂注解;唯一 Pylance 路径是同名遮蔽(已排除)。该面继续由 kode 自有 provider(`languageProviders` 的 hover/补全/跳转)补位;若未来要真做,属「代码内注解生成」新需求(改用户文件,另立项)。
5. **自动更新 —— 现实(小-中)**:三件套先例齐,watcher 去抖有 `hotReload` 现成口径。
6. **总评:有前提才现实(总工作量「中」)**——「类型模块生成」可做且大部分复用既有件;「实体自注解面」不现实,须改用户代码或维持 kode provider 补位。

## 6. 设计要点(供下一轮立项,非本轮产出)

- 类型表:`types.xml` 别名(`parseTypeAliases`)+ `.def` 引用面(`entityMapping` Type 串)合成 `Map<类型名, 类型描述>`;别名递归防环沿 `clientSdkGenerator.ts:301` 口径。
- 发射:标量/ARRAY/type alias 三类直译;FIXED_DICT 发 `TypedDict`(键序按 types.xml 文档序,`databaseSchema.ts:724` 的 node 遍历);`from __future__ import annotations` 头,零运行时依赖。
- 落盘:默认 `.kbengine/stubs/kbe_types.py(±.pyi)`,零写纪律与 `KBEngine.pyi` 同款;头部写「生成物,建议 gitignore」。
- 接线:文件进 `extraPaths` 管理段(对齐 `pythonExtraPaths.ts:8-9` 的并入条件),命令 `kbengine.python.exportStubs` 面上加一发或另立 `kbengine.python.exportTypeStubs`。

## 7. 待证清单(不在本仓可断言的)

1. `python.analysis.stubPath` 相对 `extraPaths` 对 `.pyi` 的命中优先级 —— 本仓未接线(0 命中),实施前实测。
2. 真实游戏工程的类型分布(多层嵌套 FIXED_DICT、VECTOR3 键、混合 ARRAY) —— 本仓语料只有夹具级样例(§1.4);SDK 模板 `types.xml` 为空壳。
3. 向量类型(`VECTOR3`)在 `KBEngine.pyi` 中的可用性 —— `src/kbeModuleIndex.ts` 的符号表 `KbeSymbolKind` 只有 `class|function`(`:18`),`VECTOR3`/`vector` 字样 **0 命中** → 生成桩是否已有向量类可引用未证。
