# KSEM-SER-02 收口:序列化契约模型登记

**日期**:2026-11-13
**条目**:`todo.md` KSEM-SER-02 —— 登记序列化契约模型:记录编码器/解码器、逻辑对象结构、传输结构、字段序、版本、证据;字节格式与对象结构分别表达。

**证据源**:引擎树 `/home/cui/workspaces/kbengine` @ `3082ab5`(同 SER-01 检出;行号锚定该提交)。

---

## 1. 模型定义(六维记录)

每个引擎数据类型的序列化契约 = 六维记录,**字节格式(§2)与对象结构(§3)分开登记,永不合并表述**:

| 维 | 含义 |
|---|---|
| 编码器/解码器 | 引擎符号 + 锚点(addToStream / createFromStream 实现) |
| 逻辑对象结构 | Python 侧内存对象形态(业务代码看到什么) |
| 传输结构 | wire/db 字节布局(流上是什么) |
| 字段序 | 复合类型的字段排列规则与递归规则 |
| 版本 | 使本布局变化/失效的维度(defs-md5、alias/UID 双布局、onlyPersistents 分叉) |
| 证据 | file:line 锚点 |

**通道分叉**(同一逻辑对象两条字节布局,模型必须分开记):

| | 网络 wire | DB blob |
|---|---|---|
| 装配 | `PropertyDescription::addToStream`(property.cpp:94)逐属性事件帧 | `Entity::addPersistentsDataToStream`(baseapp/entity.cpp:398)整实体 blob → `entity_table.h:330 writeEntity` |
| 属性级 | 帧头 + **裸类型载荷**(无字段标签) | 每属性一条 **utype 标签记录**:`uint16 0(alias 槽,恒 0)` + `uint16 utype` + `addPersistentToStream` 载荷(baseapp/entity.cpp:440-441/:456-457/:471/:491) |
| 字段集 | 全字段 | persistent 子集;FD/ARRAY 递归走 `addToStreamEx(…, true)`(property.cpp:277/:282/:336/:341) |
| 前缀 | — | hasCell() 实体先装 position+direction(保留 utype `ENTITY_BASE_PROPERTY_UTYPE_POSITION_XYZ`/`_DIRECTION_ROLL_PITCH_YAW`,entity_macro.h:1501-1513) |
| 顶层序 | 事件驱动无全实体序 | **属性名字典序**(getPersistentPropertyDescriptions 是 `std::map<std::string,…>`,scriptdef_module.h:31)——非声明序 |
| 错误行为 | 类型错 → OUT_TYPE_ERROR | 缺属性 → 默认值顶替 WARNING;类型错配 → **CRITICAL_MSG**(entity.cpp:467/:435) |

**后果**:wire 与 DB 的字节集、字段序、自描述性(有无 utype 标签)三者全不同——布局解释/兼容检查必须先声明通道,绝不混谈。

## 2. 字节格式登记(传输结构,per 类型)

底层写原语(`kbe/src/lib/common/memorystream.h`):整数/浮点 `append<T>` = `memcpy` 原样落 :599(**主机字节序,无规范化**);`operator<<(std::string)` = 字节 + **NUL 终止**(:221-226);`appendBlob` = **uint32 长度前缀** + 字节(:543)。宽度别名:ENTITY_ID=int32(platform.h:342)、COMPONENT_ID=uint64(:345)、ArraySize=uint32(:353)、ENTITY_PROPERTY_UID/ENTITY_SCRIPT_UID=uint16(entitydef/common.h:80/:82)。

| 类型 | 传输结构(网络 wire) | 锚点 |
|---|---|---|
| INT8/16/32, UINT8/16/32 | sizeof(T) 原样字节(1/2/4) | `IntType<T>::addToStream` datatype.h:874-898(转换失败 → 写 0 并报错,不中止);注册表 datatypes.cpp:56-63 |
| INT64 / UINT64 | 8 字节原样 | datatype.cpp:199/:440 |
| FLOAT / DOUBLE | 4 / 8 字节原样 | datatype.cpp:540/:630 |
| VECTOR2/3/4 | 2/3/4 个 float 连排(8/12/16 字节) | datatype.cpp:737/:841/:946 |
| STRING | **NUL 终止** UTF-8,无长度前缀(内嵌 NUL 截断) | datatype.cpp:1050(→ operator<< memorystream.h:221) |
| UNICODE | uint32 长度 + UTF-8 字节 | datatype.cpp:1129(appendBlob memorystream.h:543) |
| PYTHON | uint32 长度 + cPickle 字节;**空 blob 解出 None** | datatype.cpp:1225-1238 |
| PY_DICT/PY_TUPLE/PY_LIST | 同 PYTHON(pickle 不透明);解码 :1288/:1344/:1400 | 继承 PythonType |
| BLOB | uint32 长度 + 原始字节 | datatype.cpp:1448 |
| ENTITYCALL | id(int32) → cid(uint64) → type(uint16) → utype(uint16) | datatype.cpp:1512,打包尾 :1573-1577;None 写四零 |
| FIXED_ARRAY | uint32 元素数(ArraySize)+ 逐元素载荷,序列序 | datatype.cpp:1831/:1837(addToStreamEx) |
| FIXED_DICT | **无键名无键数**:逐字段按声明序连排载荷 | datatype.cpp:2586/:2592(addToStreamEx) |
| ENTITY_COMPONENT | 委托 EntityComponent::addToStream;DB 臂只装 cell 域 persistent 属性 | datatype.cpp:2793/:2810 |
| 自定义别名(types.xml) | 无自有布局 = 底层类型布局(别名只是名字绑定) | datatypes.cpp 注册面 |

**FIXED_DICT 三条编码器行为契约**(SER-03/06/07 的引擎依据):
1. `hasImpl()` → 先 `impl_getDictFromObj(pyValue)`(自定义序列化出口)再逐字段装(:2595-2597);
2. 缺键 **或** `isSameType` 失败 → **静默以 `parseDefaultStr("")` 默认值顶替**,不报错不中止(:2627/:2642 两臂)——错值上 wire 的表现是「默认值」,不是异常;
3. 嵌套 FD/ARRAY 递归走 Ex 变体,onlyPersistents 一路下传(:2638-2646)。

## 3. 对象结构登记(逻辑对象,per 类型)

| 类型 | 内存形态(业务侧) | 解码产物锚点 |
|---|---|---|
| 整数族 | Python int;**isSameType 做范围检查**(超范围 false) | datatype.h:858-867 |
| FLOAT/DOUBLE | float | datatype.cpp:556/:645 |
| VECTOR2/3/4 | Vector2/3/4(kbe 内建 vector 对象) | :753/:857/:962 |
| STRING | str(UTF-8 解出) | :1064(PyUnicode_FromString) |
| UNICODE | str(UTF-8 decode) | :1144(PyUnicode_DecodeUTF8) |
| PYTHON | 任意 PyObject(pickle roundtrip;空 → None) | :1232-1238 |
| PY_DICT/PY_TUPLE/PY_LIST | dict/tuple/list(pickle roundtrip) | :1288/:1344/:1400 |
| BLOB | bytes | :1465 |
| ENTITYCALL | mailbox 对象(EntityCallAbstract 系) | :1582 |
| FIXED_ARRAY | FixedArray(序列接口,长度动态记录非定容) | :1858 |
| FIXED_DICT | 无 impl:FixedDict(字典接口,键集固定);**有 impl:用户类实例**(createObjFromDict 产物,过 isSameType 校验) | :2667 起;转换安装 :2031/:2383-2397 |
| ENTITY_COMPONENT | EntityComponent | :2990 |

## 4. 字段序登记

- **FIXED_DICT**:字段序 = `keyTypes_` 声明序(def XML 属性序),wire 上**无自描述**(无键名/键数)——解码方按同一序逐字段读;**任何字段增删/重排都是破坏性布局变更**(SER-13 兼容检查的核心判据)。
- **FIXED_ARRAY**:长度前缀动态,元素逐个读,无字段序问题;元素类型固定单一。
- **wire 属性流(帧层)**:属性按调度顺序逐个 append(每条 = 帧头 + 单属性载荷,baseapp/entity.cpp:128-151),非整实体打包。
- **DB 顶层流**:persistent 属性按**属性名字典序**(std::map 键序,scriptdef_module.h:31)——**与 FD 内部声明序不同族**;属性重命名(即使类型不变)会改变 DB blob 顶层记录序,但不改变 FD 内部序(SER-13 两条不同判据)。
- **ENTITY_COMPONENT DB 臂**:cell 域 persistent 属性,同名 map 序(datatype.cpp:2810);celldata 字典缺键 → 默认值 + ERROR_MSG(:2826 附近)。

## 5. 版本登记

| 维度 | 面 | 锚点 |
|---|---|---|
| defs-md5 | def 集一致性指纹:EntityDef::md5 静态聚合,装载末 final | entitydef.h:185/:255、entitydef.cpp:243;发给对端 baseapp.cpp:4910 |
| alias/UID 双布局 | 属性帧标识字段二选一:alias uint8(usePropertyDescrAlias)或 UID uint16——**同一逻辑属性两种字节布局** | baseapp/entity.cpp:139-148 |
| onlyPersistents | wire(全字段)vs DB(persistent 子集)通道分叉 | property.cpp:112/:277/:336 |
| 转换实现变更 | implementedBy 指向的用户代码变更不改变布局,但改变 dict↔对象语义 | datatype.cpp:2383-2397 |

## 6. 证据与消费映射

- 本登记全部锚点已逐个打开核实(SER-01 盘点 + 本批 datatypes.cpp/memorystream.h/property.cpp/platform.h/entitydef.h 补核);引擎树 pinned commit 3082ab5(SER-01 同),引擎更新按 BAS-02 五步复核。
- 消费映射:SER-03(getDictFromObj 输出↔schema)/SER-04(createObjFromDict 输入获得 schema)以 §2 FIXED_DICT 字段序 + §3 内存形态为绑定目标;SER-05/06(成员/往返)用 §2 行为契约(静默默认值顶替)与 §4 字段序;SER-07(isSameType)以 §3 范围检查 + §2 FIXED_DICT 两臂失败行为为边界;SER-12(布局解释)直接消费 §2 表;SER-13(兼容)消费 §5 版本维;SER-14(往返样本)以 §2 布局构造夹具字节序。
- 边界:本登记是**模型文档**,不含代码;SER-03 起逐条物化(Rust/TS 消费面),物化时以本表为契约真源,发现引擎行为与本表冲突时先改本表并注明证据。
