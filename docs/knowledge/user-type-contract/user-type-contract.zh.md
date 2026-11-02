# 引擎机制 04 · 用户自定义类型三契约与数据流方向

> KB-001 知识库第三批 · 引擎机制文档 · 中文版（英文版见 [`user-type-contract.en.md`](./user-type-contract.en.md)）
>
> **证据规则**：本篇所有引擎行为结论都带 `kbe/src` 源码引用（`file:line`）。引用的第一来源是 kode 仓内已有的源码级分析产物 + 官方 KBEngine 源码（在线 `kbe/src`，用户本地 `~/workspaces/kbengine` 缺失，见文末「证据来源」）；仓内/在线源码均未覆盖的行为标注 `TODO 待验证`，**宁缺毋假，不编造**。

---

## 0. 阅读地图

| 你想知道 | 直接跳 |
|---|---|
| 用户类型（FIXED_DICT + implementedBy）必须实现哪三个方法 | §1.1 |
| 缺一个会怎样（引擎启动注册失败） | §1.2 |
| PYTHON 类型跨网络怎么传（pickle） | §1.3 |
| 序列化实现 = 实例⇄dict；持久化只带持久键（onlyPersistents） | §1.4 |
| 属性 Flags 如何决定同步方向（谁有谁没有） | §2.1 |
| 方法段（Base/Cell/ClientMethods）如何决定调用方向 | §2.2 |
| 方向图（baseapp↔cellapp→clients） | §2.3 |
| 每个方向规则的 file:line 源码证据 | §3 |
| 开发者常犯错误清单 | §4 |
| 待验证清单 | §5 |
| 证据来源 | §6 |

---

## 1. 三契约：用户自定义类型实现必须满足的接口

### 1.1 契约清单：一个用户类型必须实现三个方法

用户自定义类型（FIXED_DICT 配合 `<implementedBy>`）在引擎启动加载 `types.xml` 时，会被要求从实现对象上取三个方法。引擎侧取法见 `FixedDictType::setImplModule`（`kbe/src/lib/entitydef/datatype.cpp`）：

| 契约 | 方法 | 引擎取属性位置 | 用途 |
|---|---|---|---|
| ① 反序列化 | `createObjFromDict(dictData)` | `datatype.cpp:2385` | 从 dict 重建实例（`impl_createObjFromDict` `:2410` 调用它，`datatype.cpp:2420`） |
| ② 序列化 | `getDictFromObj(obj)` | `datatype.cpp:2392` | 把实例拍平回 dict（`impl_getDictFromObj` `:2437` 调用它，`datatype.cpp:2439`） |
| ③ 类型判定 | `isSameType(obj)` | `datatype.cpp:2399` | 判定对象是否本类型合法实例（`impl_isSameType` `:2452` 调用它，`datatype.cpp:2454`） |

三个取属性调用都带空指针检查，任何一个失败即 `return false`（`datatype.cpp:2385-2404`）。

**契约语义（引擎侧如何用这三个方法）：**

- `createObjFromDict`：`impl_createObjFromDict`（`datatype.cpp:2410-2434`）先判断传入值是否已是本类型实例（`PyObject_TypeCheck` + `impl_isSameType`，`:2414`），是则 `Py_INCREF` 直接返回；否则调用 `createObjFromDict_`（`:2420`），返回值再经 `impl_isSameType` 校验（`:2423`），校验失败打印 `".isSameType() is failed!"` 并返回 `Py_None`（`:2427-2431`）。**注意：实现方 `createObjFromDict` 的返回值必须能被 `isSameType` 判定为真，否则引擎当序列化失败处理。**
- `getDictFromObj`：`impl_getDictFromObj`（`datatype.cpp:2437-2449`）直接调用实现，失败则返回 `parseDefaultStr("")`（空默认值）。
- `isSameType`：`impl_isSameType`（`datatype.cpp:2452-2464`）调用实现并转成 bool。

### 1.2 缺一个会怎样：引擎启动注册失败

`setImplModule`（`datatype.cpp:2362`）是引擎加载用户类型实现时的唯一入口。它按顺序取 `createObjFromDict`（`:2385`）、`getDictFromObj`（`:2392`）、`isSameType`（`:2399`），**任一取不到都 `return false`**（`:2386-2404`），导致调用方 `loadImplModule`（`:2333`）返回失败，进而 `FixedDictType::initialize` 的 `implementedBy` 分支失败（`:2178-2179`，组件类型为 CELLAPP/BASEAPP/CLIENT 时）。

**失败后果是启动注册失败**，而不是运行时静默降级：

- `DataTypes::initialize`（`datatypes.cpp:53`）在解析 `types.xml` 时对每个 FIXED_DICT 调 `fixedDict->initialize(...)`（`datatypes.cpp:139`），返回 false 即整体初始化失败 → `EntityDef::initialize` 失败（`entitydef.cpp:181-182`，`DataTypes::initialize(defFilePath + "types.xml")`）→ 各进程初始化失败。
- 所以**缺任一方法 = 引擎启动即失败**，报错形如 `FixedDictType::loadImplModule: <module>.impl error!` 或 `FixedDictType::initialize(): FIXED_DICT(<name>) setImplModule error!`（`datatype.cpp:2342`、`:2214`）。

**正确姿势**：实现类三个方法一个都不能少，且方法名与签名要匹配：`createObjFromDict(self, dictData)` / `getDictFromObj(self, obj)` / `isSameType(self, obj)`。

### 1.3 PYTHON 类型跨网络：pickle 字节流

非 FIXED_DICT 的通用 `PYTHON` 类型跨网络传输用 Python pickle，不是结构体逐字段：

- `PythonType::addToStream`（`datatype.cpp:1225-1229`）：`script::Pickler::pickle(pyValue)` 得到 pickle 字节串，再 `mstream->appendBlob(datas)`（`appendBlob` = u32 长度 + 字节，见 memorystream.h 与 C-15 codec）。
- `PythonType::createFromStream`（`datatype.cpp:1232-1241`）：`mstream->readBlob(datas)` 读回字节串，空则返回 `Py_None`（`:1237-1238`），否则 `script::Pickler::unpickle(datas)`。
- `PythonType::isSameType`（`datatype.cpp:1177-1190`）：**用 `Pickler::pickle(pyValue).empty()` 判合法性**——能 pickle 成功（非空）即视为合法，否则报 `OUT_TYPE_ERROR("PYTHON")`。这意味着**不可 pickle 的对象（如部分 EntityCall、lambda）在写入/校验时会失败**。

**PY_DICT / PY_TUPLE / PY_LIST 同属 pickle 框架**（`PyDictType::isSameType` `datatype.cpp:1255`、`PyTupleType` `:1311`、`PyListType` `:1367`，均继承 `PythonType`），字节布局同 PYTHON（u32 长度 + pickle 字节），与 wire_codec.rs 的 `PYTHON=opaque pickle bytes` 口径一致。

### 1.4 序列化实现 = 实例⇄dict；持久化同线但只带持久键（onlyPersistents）

**同一条序列化线，两个方向：**

- **写（实例→dict→字节）**：`impl_getDictFromObj`（`datatype.cpp:2437`）先把实现实例拍平成 dict，再由 `FixedDictType::addToStreamEx`（`datatype.cpp:2594`）遍历声明的键，把每个值 `addToStream` 写进 stream。
- **读（字节→dict→实例）**：`FixedDictType::createFromStreamEx`（`datatype.cpp:2675`）从 stream 读回 dict，再走 `impl_createObjFromDict`（`datatype.cpp:2410`）用 `createObjFromDict` 重建实例。

**`onlyPersistents`：持久化与在线同步的唯一分流开关。**

`addToStreamEx`（`datatype.cpp:2594`）带 `bool onlyPersistents` 参数。遍历键时（`datatype.cpp:2608-2614`）：

```
if(onlyPersistents) {
    if(!iter->second->persistent)   // 该键声明为不持久化
        continue;                    // 跳过，不写进 stream
}
```

- **在线属性同步**（`addClientDataToStream` → `addToStreamEx`，默认 `onlyPersistents=false`）：所有声明键都写。
- **持久化**（`onlyPersistents=true`）：只写 `<Persistent>` 标记为真的键，非持久键 `continue` 跳过（`datatype.cpp:2610-2614`）。
- 键缺失时的兜底：取不到键就写 `parseDefaultStr("")` 的默认值（`datatype.cpp:2619-2635`），类型不符同理（`:2638-2652`）——保证 stream 布局稳定。

**与 cellData 的关系**：cell 侧 `backupCellData` 调 `addCellDataToStream(BASEAPP_TYPE, ENTITY_CELL_DATA_FLAGS, s)`（`server/cellapp/entity.cpp:1139`）把 cell 属性打包给 baseapp；baseapp 侧 `cellDataDict_` 持有快照（`server/baseapp/entity.cpp:52`，写库时取持久子集 `:406` 处 `getPersistentPropertyDescriptions()`）。持久化走的是同线 + `onlyPersistents` 过滤，不是另开一条路（与[持久化流程 §4 cellData 快照语义](../persistence-flow/persistence-flow.zh.md)一致）。

---

## 2. 数据流方向：属性 Flags 定同步方向，方法段定调用方向

### 2.1 属性 Flags：决定这个属性存在于哪个进程、同步给哪一侧

**9 个 Flag 的位定义**（`kbe/src/lib/entitydef/common.h:17-28`，`enum EntityDataFlags`）：

| Flag（.def 里写的字符串） | 位值 | 引擎常量 | 语义（源码注释） |
|---|---|---|---|
| `CELL_PUBLIC` | `0x01` | `ED_FLAG_CELL_PUBLIC` | 向周围 cell 广播 |
| `CELL_PRIVATE` | `0x02` | `ED_FLAG_CELL_PRIVATE` | 只当前 cell |
| `ALL_CLIENTS` | `0x04` | `ED_FLAG_ALL_CLIENTS` | cell 广播给所有客户端 |
| `CELL_PUBLIC_AND_OWN` | `0x08` | `ED_FLAG_CELL_PUBLIC_AND_OWN` | cell 广播给周围的 + 自己的客户端 |
| `OWN_CLIENT` | `0x10` | `ED_FLAG_OWN_CLIENT` | 只当前 cell 和自己的客户端 |
| `BASE_AND_CLIENT` | `0x20` | `ED_FLAG_BASE_AND_CLIENT` | base 和自己的客户端 |
| `BASE` | `0x40` | `ED_FLAG_BASE` | 只当前 base |
| `OTHER_CLIENTS` | `0x80` | `ED_FLAG_OTHER_CLIENTS` | cell 广播给其他客户端（非自己） |

（另有 `ED_FLAG_UNKOWN = 0x00`，`common.h:19`。）

**.def 字符串 → Flag 的映射表**（`entitydef.cpp:161-174`，`g_entityFlagMapping`）：

| .def 字符串 | 映射到 |
|---|---|
| `BASE` | `ED_FLAG_BASE`（`:166`） |
| `BASE_AND_CLIENT` | `ED_FLAG_BASE_AND_CLIENT`（`:165`） |
| `CELL_PUBLIC` / `CELL` | `ED_FLAG_CELL_PUBLIC`（`:168` / `:161`） |
| `CELL_PRIVATE` | `ED_FLAG_CELL_PRIVATE`（`:169`） |
| `ALL_CLIENTS` / `CELL_AND_CLIENTS` | `ED_FLAG_ALL_CLIENTS`（`:170` / `:163`） |
| `CELL_PUBLIC_AND_OWN` / `CELL_AND_CLIENT` | `ED_FLAG_CELL_PUBLIC_AND_OWN`（`:171` / `:162`） |
| `OWN_CLIENT` | `ED_FLAG_OWN_CLIENT`（`:174`） |
| `OTHER_CLIENTS` / `CELL_AND_OTHER_CLIENTS` | `ED_FLAG_OTHER_CLIENTS`（`:173` / `:164`） |

**派生的"归属组"——这就是"谁有谁没有"的判据**（`common.h:38-56`，`enum EntityDataFlagRelation`）：

| 组常量 | 成员 | 含义 |
|---|---|---|
| `ENTITY_BASE_DATA_FLAGS` | `BASE \| BASE_AND_CLIENT` | 存在于 baseapp |
| `ENTITY_CELL_DATA_FLAGS` | `CELL_PUBLIC \| CELL_PRIVATE \| ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OTHER_CLIENTS \| OWN_CLIENT` | 存在于 cellapp |
| `ENTITY_CLIENT_DATA_FLAGS` | `BASE_AND_CLIENT \| ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OTHER_CLIENTS \| OWN_CLIENT` | 存在于 client |
| `ENTITY_BROADCAST_CELL_FLAGS` | `CELL_PUBLIC \| ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OTHER_CLIENTS` | 需广播给周围 cellapp（ghost） |
| `ENTITY_BROADCAST_OTHER_CLIENT_FLAGS` | `OTHER_CLIENTS \| ALL_CLIENTS` | 需广播给其他客户端 |
| `ENTITY_BROADCAST_OWN_CLIENT_FLAGS` | `ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OWN_CLIENT \| BASE_AND_CLIENT` | 需广播给自己的客户端 |

**Flag → 注册到哪个进程**（`entitydef.cpp:1287-1297`，`loadDefPropertys` 末尾；组件属性同构 `:864-874`）：

```
if(hasCellFlags > 0)   addPropertyDescription(..., CELLAPP_TYPE);   // :1287-1289
if(hasBaseFlags > 0)   addPropertyDescription(..., BASEAPP_TYPE);   // :1291-1293
if(hasClientFlags > 0) addPropertyDescription(..., CLIENT_TYPE);    // :1295-1297
```

`hasBaseFlags/hasCellFlags/hasClientFlags` 就是上面三个组与 `flags` 按位与（`entitydef.cpp:1150-1160`，组件版 `:851-861`）。**一个属性可以同时注册到多个进程——这正是一个 Flag 位组合的结果，不是三选一。**

**逐 Flag 一行：谁有、谁没有（同步方向判定表）**

| Flag | baseapp | cellapp | client（自己的） | client（其他的） | 触发同步的代码路径 |
|---|---|---|---|---|---|
| `BASE` | ✅ | ❌ | ❌ | ❌ | 无广播，仅 baseapp 本地（`common.h:41` 属 BASE 组） |
| `BASE_AND_CLIENT` | ✅ | ❌ | ✅ | ❌ | baseapp → 自己客户端：`baseapp/entity.cpp:128`（`flags & ED_FLAG_BASE_AND_CLIENT` 检查，`:159` 发 `onUpdatePropertys`） |
| `CELL_PUBLIC` | ❌ | ✅ | ❌ | ❌ | cell → 周围 cell（ghost 广播）：`cellapp/entity.cpp:686`（`flags & ENTITY_BROADCAST_CELL_FLAGS`） |
| `CELL_PRIVATE` | ❌ | ✅ | ❌ | ❌ | 仅 cell 本地，不广播（不在任何 CLIENT/BROADCAST 组） |
| `ALL_CLIENTS` | ❌ | ✅ | ✅ | ✅ | cell → 所有客户端：`cellapp/entity.cpp:721`（other）+ `:851`（own）都命中 |
| `CELL_PUBLIC_AND_OWN` | ❌ | ✅ | ✅ | ❌ | cell → 周围 cell + 自己的客户端：`:686`（cell 广播）+ `:851`（own） |
| `OWN_CLIENT` | ❌ | ✅ | ✅ | ❌ | cell → 仅自己的客户端：`cellapp/entity.cpp:851`（`flags & ENTITY_BROADCAST_OWN_CLIENT_FLAGS`） |
| `OTHER_CLIENTS` | ❌ | ✅ | ❌ | ✅ | cell → 仅其他客户端：`cellapp/entity.cpp:721`（`flags & ENTITY_BROADCAST_OTHER_CLIENT_FLAGS`） |

**判据来源**：每个方向的"有没有"由 `common.h:38-56` 的组常量与 `flags` 按位与决定；广播触发点见 `cellapp/entity.cpp` 与 `baseapp/entity.cpp`（`cellapp/entity.cpp:686` cell 广播、`:721` other 客户端、`:851` own 客户端；`baseapp/entity.cpp:128` base→client）。

**广播时按组过滤的具体代码**（`cellapp/entity.cpp`，`onUpdateData` 内）：

- **cell 间广播（ghost）**：`if((flags & ENTITY_BROADCAST_CELL_FLAGS) > 0 && hasGhost())` → `onUpdateGhostPropertys`（`:686-717`）。
- **其他客户端**：`if((flags & ENTITY_BROADCAST_OTHER_CLIENT_FLAGS) > 0)` 遍历 witness（`:721-793`）。
- **自己的客户端**：`if((flags & ENTITY_BROADCAST_OWN_CLIENT_FLAGS) > 0 && clientEntityCall_ != NULL && pWitness_)`（`:851-890`）。
- **baseapp → 自己的客户端**：`if((flags & ED_FLAG_BASE_AND_CLIENT) <= 0 || clientEntityCall_ == NULL) return;`（`baseapp/entity.cpp:128-129`）。

### 2.2 方法段：决定调用方向（谁能被谁调）

**三个方法段不是命名习惯，而是写进了 `MethodDescription` 的 `domain` 字段。** 加载器逐段构造时直接指定 domain：

| .def 段 | 加载函数 | 构造时 domain | 源码 |
|---|---|---|---|
| `<CellMethods>` | `loadDefCellMethods` | `CELLAPP_TYPE` | `entitydef.cpp:1324` |
| `<BaseMethods>` | `loadDefBaseMethods` | `BASEAPP_TYPE` | `entitydef.cpp:1467` |
| `<ClientMethods>` | `loadDefClientMethods` | `CLIENT_TYPE` | `entitydef.cpp:1610` |

三个段的入口在 `loadAllDefDescription` 里按序调用（`entitydef.cpp:937` / `:946` / `:955`）。

**domain 决定 `isBase()/isCell()/isClient()`**（`method.inl:51-63`）：

```
bool isCell()   const { return methodDomain_ == CELLAPP_TYPE; }
bool isBase()   const { return methodDomain_ == BASEAPP_TYPE; }
bool isClient() const { return !isCell() && !isBase(); }   // 即 CLIENT_TYPE
```

**调用方向的运行时落地——按 domain 查表：**

| 从哪来 | 消息处理函数 | 查哪个方法表 | 源码 |
|---|---|---|---|
| baseapp 收到远程调用 | `Entity::onRemoteMethodCall` | `findBaseMethodDescription(utype)` | `baseapp/entity.cpp:929` |
| cellapp 收到远程调用 | `Entity::onRemoteMethodCall` | `findCellMethodDescription(utype)` | `cellapp/entity.cpp:922` |
| cellapp 收到客户端调用 | `Entity::onRemoteCallMethodFromClient` | `findCellMethodDescription(utype)` + `isExposed()` 检查 | `cellapp/entity.cpp:960-966` |
| 客户端收到服务器调用 | `Entity::onRemoteMethodCall` | `findClientMethodDescription(utype)` | `client_lib/entity.cpp:205` |

**关键点**：baseapp 的 `onRemoteMethodCall` 只查 base 表（`:929`），查不到就报 `can't found method` 并 `s.done()` 丢弃（`:930-941`）。cellapp 同理只查 cell 表（`:922-930`）。**所以"在 baseapp 上调用 cell 方法"不是被拒绝，而是根本查不到表项 → 报错丢弃**。

**`Exposed` 子标签 = 该 cell 方法能否被客户端调用**（`method.h:26-35`，`EXPOSED_TYPE`：`NO_EXPOSED=0` / `EXPOSED=1` / `EXPOSED_AND_CALLER_CHECK=2`）。客户端来的调用若方法未暴露，`onRemoteCallMethodFromClient` 打 `not is exposed, call is illegal!` 并丢弃（`cellapp/entity.cpp:963-970`）。`Exposed` 在加载时由 `<Arg> Exposed </Arg>` 设置（`entitydef.cpp:1334-1337`）。

**加载期静态校验**（`EntityDef::checkDefMethod`，`entitydef.cpp:1867-1894`）：脚本里方法的参数个数与 def 声明不符 → 若已 exposed 则尝试升级为 `EXPOSED_AND_CALLER_CHECK`（`:1871-1874`），否则直接 `ERROR_MSG` 并 return false（`:1877-1883`）；同时**对 exposed 的 cell 方法发出警告**，提示 `def {}(self, callerID, ...)` 做调用者校验（`:1888-1893`）——这是引擎自带的"别把不该暴露的 cell 方法暴露出去"安全提示。

### 2.3 方向图：baseapp↔cellapp→clients

```
              ┌────────────────────────────────────────────┐
              │                baseapp                      │
              │  属性: BASE / BASE_AND_CLIENT               │
              │  方法: BaseMethods 段                        │
              │  cellDataDict_ 持有 cell 侧快照             │
              └──────┬──────────────────────┬──────────────┘
         ① 双向      │ base↔cell            │ ② BASE_AND_CLIENT
   baseEntityCall_ ←→│ cellEntityCall_      │    属性 → 自己客户端
              ┌──────┴────────────┐         │
              │   cellapp          │         │
              │  属性: CELL_* 族    │         │
              │  方法: CellMethods  │         │
              │  witness 视野裁剪   │         │
              └──────┬─────────────┘         │
        ③ 属性广播   │ cell → clients        │
   ┌─────────────────┼─────────────────┐     │
   │  自己客户端      │  其他客户端       │     │
   │  OWN 族         │  OTHER 族        │     │
   │  (ownClient)    │  (otherClients)  │     │
   └─────────────────┴─────────────────┘     │
        ④ 方法下行    cell 方法 → client    │
        ⑤ 方法上行    client → cell (Exposed)│
```

**各条边的方向规则（每条都对应上面一节的证据）：**

| 边 | 方向 | 承载内容 | 证据 |
|---|---|---|---|
| ① base↔cell | 双向 | 方法调用：base 调 cell 方法 / cell 调 base 方法（`EntityCall` 句柄）；属性：cell 侧把 cellData 快照推给 base（`backupCellData`） | `baseapp/entity.cpp:1028`（cellEntityCall_ 建 `ENTITYCALL_TYPE_CELL`）；`cellapp/entity.cpp:1180`（`baseEntityCall_->sendCall`，`onBackupEntityCellData`） |
| ② base→client | 单向（只自己客户端） | 属性 `BASE_AND_CLIENT`；`BaseMethods` 不能被客户端调（客户端只调 exposed cell 方法） | `baseapp/entity.cpp:128-129`（`ED_FLAG_BASE_AND_CLIENT` 检查）、`:159`（`sendToClient`） |
| ③ cell→clients | 单向广播 | 属性按 `ALL_CLIENTS` / `OWN_CLIENT` / `OTHER_CLIENTS` / `CELL_PUBLIC_AND_OWN` 分桶，走 witness 视野裁剪 | `cellapp/entity.cpp:721`（other）、`:851`（own） |
| ④ 服务器→client 方法 | 单向 | `ClientMethods` 段方法 | `client_lib/entity.cpp:205`（`findClientMethodDescription`） |
| ⑤ client→cell 方法 | 单向 | 仅 exposed 的 `CellMethods` 方法；未暴露 → illegal 丢弃 | `cellapp/entity.cpp:960-966`（`isExposed()` 检查） |

**补充方向语义（base↔cell 的属性数据，不是双向对等）：**

- cell 侧**自己维护** cell 属性（`ENTITY_CELL_DATA_FLAGS`），只把**快照**推给 base 用于持久化（`cellapp/entity.cpp:1139` `addCellDataToStream(BASEAPP_TYPE, ...)`）；base 侧不写回 cell 属性（cell 是 cellData 的源头）。
- base 侧**只读** cellData（`baseapp/entity.cpp:52`），写库时取持久子集（`:406`）。
- **方法调用是唯一真正双向的边**：base 调 cell 方法走 `cellEntityCall_->sendCall`（EntityCall 为远程代理，见首批[内存坑集 §2](../memory-references/memory-references.zh.md)）；cell 调 base 方法走 `baseEntityCall_->sendCall`（`cellapp/entity.cpp:1180`）。

---

## 3. 每个方向规则的 file:line 源码证据（总表）

> 引用的 `kbe/src` 行号来自官方 KBEngine 源码（在线 `kbe/src`，因用户本地 `~/workspaces/kbengine` 缺失，见 §6 证据来源说明）。已逐条对照源码核实，未核实项标 `TODO 待验证`。

| 规则 | 源码位置 |
|---|---|
| 三契约取方法：createObjFromDict / getDictFromObj / isSameType | `lib/entitydef/datatype.cpp:2385` / `:2392` / `:2399`（检查 `:2386-2404`） |
| 缺任一方法 → return false → 启动注册失败 | `datatype.cpp:2362`（setImplModule）、`:2333`（loadImplModule）、`:2178-2179`（initialize 失败）、`datatypes.cpp:139`、`entitydef.cpp:181-182` |
| PYTHON 跨网络 = pickle | `datatype.cpp:1225-1229`（addToStream）、`:1232-1241`（createFromStream）、`:1177-1190`（isSameType via pickle.empty()） |
| 序列化实现 = 实例⇄dict | `datatype.cpp:2437`（impl_getDictFromObj）、`:2410`（impl_createObjFromDict）、`:2594`（addToStreamEx）、`:2675`（createFromStreamEx） |
| 持久化同线 + onlyPersistents | `datatype.cpp:2594`（签名）、`:2610-2614`（跳过非持久键）、`:2619-2635`（缺键兜底） |
| 属性 Flag 位定义（9 个） | `lib/entitydef/common.h:17-28`（enum EntityDataFlags） |
| 字符串→Flag 映射 | `entitydef.cpp:161-174`（g_entityFlagMapping） |
| 归属组（谁有谁没有） | `common.h:38-56`（enum EntityDataFlagRelation） |
| Flag→注册进程 | `entitydef.cpp:1287-1297`（实体属性）、`:864-874`（组件属性）；按位与 `:1150-1160` |
| 逐 Flag 同步方向 | `cellapp/entity.cpp:686`（cell 广播）、`:721`（other）、`:851`（own）；`baseapp/entity.cpp:128-129`（base→client） |
| 方法段→domain | `entitydef.cpp:1324`（Cell）、`:1467`（Base）、`:1610`（Client） |
| domain→isBase/isCell/isClient | `lib/entitydef/method.inl:51-63` |
| 远程调用按 domain 查表 | `baseapp/entity.cpp:929`（base 表）、`cellapp/entity.cpp:922`（cell 表）、`client_lib/entity.cpp:205`（client 表） |
| 客户端→cell 需 Exposed | `cellapp/entity.cpp:960-966`；`method.h:26-35`（EXPOSED_TYPE）；`entitydef.cpp:1334-1337`（解析） |
| 方法参数静态校验 | `entitydef.cpp:1867-1894`（checkDefMethod） |
| base↔cell 双向边（EntityCall） | `baseapp/entity.cpp:1028`（cellEntityCall_）、`cellapp/entity.cpp:1180`（baseEntityCall_->sendCall） |
| cell→base 属性快照 | `cellapp/entity.cpp:1139`（backupCellData）、`baseapp/entity.cpp:52`（cellDataDict_）、`:406`（持久子集） |
| 广播组过滤代码 | `cellapp/entity.cpp:686-717`（ghost）、`:721-793`（other）、`:851-890`（own） |

---

## 4. 开发者常犯错误清单（wiki 口径）

> 每条按 **症状 → 根因（带源码）→ 正确姿势** 组织。这是本篇"落地 wiki"的部分，可直接喂给 hover / lint 规则（C-23）。

### 坑 4.1 在错误的进程访问属性

**症状**：baseapp 脚本里读 `self.hp` 拿到 `AttributeError` 或永远读不到最新值；或者 cellapp 脚本里访问一个只在 base 声明的属性报不存在。

**根因**：属性是按 Flag 注册到进程的，不是所有属性在每个进程都有一份。`loadDefPropertys` 只把 `hasCellFlags>0` 的加到 `CELLAPP_TYPE`、`hasBaseFlags>0` 的加到 `BASEAPP_TYPE`（`entitydef.cpp:1287-1297`）。例如 `Flags="CELL_PRIVATE"` 的属性**只在 cellapp 存在**，baseapp 侧根本没有这个属性。

**正确姿势**：

- 属性能否在 base 侧访问，看它是否属于 `ENTITY_BASE_DATA_FLAGS`（`BASE` / `BASE_AND_CLIENT`，`common.h:41`）；能否在 cell 侧访问看 `ENTITY_CELL_DATA_FLAGS`（`common.h:43`）。
- 需要在 base 侧读 cell 属性 → 读 `self.cellData`（快照，`baseapp/entity.cpp:52`），不要指望 `self.<attr>`。
- 需要在 cell 侧读 base 属性 → 通过 base 方法（`<BaseMethods>`）或 `self.base.<method>()` 取，不要假设本地有副本。

### 坑 4.2 跨进程调用方向错（在 baseapp 调 cell 方法 / 调未暴露方法）

**症状**：`can't found method. utype=... callerID:...`（`baseapp/entity.cpp:932` / `cellapp/entity.cpp:926`），调用静默丢弃；或客户端调用报 `not is exposed, call is illegal!`（`cellapp/entity.cpp:965`）。

**根因**：方法按段写死 domain：`<BaseMethods>`→`BASEAPP_TYPE`（`entitydef.cpp:1467`），`<CellMethods>`→`CELLAPP_TYPE`（`:1324`），`<ClientMethods>`→`CLIENT_TYPE`（`:1610`）。运行时各进程**只查自己 domain 的表**（`baseapp/entity.cpp:929`、`cellapp/entity.cpp:922`）。方向错了不是"权限拒绝"，而是**表里根本没这项**，所以报"can't found method"。

**正确姿势**：

- 想在 cell 侧执行 → 方法写进 `<CellMethods>`，从 base 侧调 `self.cell.<method>()`。
- 想在 base 侧执行 → 写进 `<BaseMethods>`，从 cell 侧调 `self.base.<method>()`。
- 客户端要能调 → 该方法必须在 `<CellMethods>` 且带 `Exposed` 子标签（`method.h:26-35`）；安全敏感的方法用 `def m(self, callerID, ...)` 校验调用者（引擎会给出 warning 提示，`entitydef.cpp:1888-1893`）。
- **不要**把客户端入口方法写进 `<BaseMethods>`——客户端只走 cell 的 exposed 表（`cellapp/entity.cpp:960-966`），base 段的 exposed 不构成客户端入口。

### 坑 4.3 用户类型只实现两个方法

**症状**：引擎启动失败，日志 `FixedDictType::initialize(): FIXED_DICT(<name>) setImplModule error!` 或 `FixedDictType::loadImplModule: ... impl error!`（`datatype.cpp:2214` / `:2342`）。

**根因**：`setImplModule` 依次取三个方法，任一缺失立即 `return false`（`datatype.cpp:2385-2404`），不存在"只序列化不判类型"的降级模式。

**正确姿势**：三个方法都实现且签名正确；`createObjFromDict` 的返回值必须能通过你自己的 `isSameType`（引擎会二次校验，`datatype.cpp:2423`）。

### 坑 4.4 以为用户类型跨网络是逐字段传

**症状**：客户端反序列化出意料外的对象、或版本不一致时 `unpickle` 失败。

**根因**：`PYTHON` / `PY_DICT` / `PY_TUPLE` / `PY_LIST` 一律 `Pickler::pickle` 后 opaque 传输（`datatype.cpp:1225-1229`），只有 FIXED_DICT（且无 implementedBy）才逐键按声明序传（`datatype.cpp:2594-2660`）。pickle 与 Python 版本/类定义强耦合。

**正确姿势**：跨端（尤其是 C++/其他语言端）数据用 FIXED_DICT / 基础类型，别用 PYTHON；确实需要时保证两端 Python 版本与类定义一致。

### 坑 4.5 以为持久化会把所有键写库

**症状**：改了某个非持久子键，重启后丢失。

**根因**：持久化走 `addToStreamEx(..., onlyPersistents=true)`，非持久键被 `continue` 跳过（`datatype.cpp:2610-2614`）。

**正确姿势**：要落库的键必须在 def 里标 `<Persistent> True</Persistent>`；非持久键只用于运行时同步。

---

## 5. 待验证清单

| # | 待验证项 | 为什么未验证 |
|---|---|---|
| 1 | `EntityDataFlagRelation` 各组的**历史演进**（是否有版本差异） | 只核对了当前 master 源码，未比对多版本 |
| 2 | `witness` 视野/DETAIL_LEVEL 对广播的精确裁剪边界 | `cellapp/entity.cpp:723-748` 有 detailLevel 判断，但视野半径/进入离开视野的完整时序属实体生命周期专题，未展开 |
| 3 | `ENTITY_BROADCAST_CELL_FLAGS` ghost 广播的**跨 cellapp 转发**链路 | `gm->pushMessage(ghostCell(), ...)`（`:716`）之后的 GhostManager 转发细节未读 |
| 4 | 客户端侧 `onUpdatePropertys` 对 `CELL_*` 属性的过滤是否二次校验 | 只读到 `client_lib/entity.cpp:259`，未逐分支核 flag |
| 5 | `onlyPersistents` 在 `createFromStreamEx` 方向是否也过滤（读回时是否忽略非持久键） | `datatype.cpp:2675-2681` 传参可见，但 `FixedDict::initialize` 内部过滤逻辑未展开 |

---

## 6. 证据来源

- **用户本地引擎源码** `~/workspaces/kbengine/kbe/src`：**本次不在此主机上**（`/home/cui/workspaces/kbengine` 不存在）。按任务口径改用**在线官方源码** `https://github.com/kbengine/kbengine` 的 `kbe/src`（master）逐条核对行号：`lib/entitydef/datatype.cpp`、`datatype.h`、`entitydef.cpp`、`entitydef.h`、`common.h`、`method.h`、`method.inl`、`datatypes.cpp`、`server/cellapp/entity.cpp`、`server/baseapp/entity.cpp`、`lib/client_lib/entity.cpp`、`lib/entitydef/entity_macro.h`。
- **仓内已有分析产物（交叉印证）**：`crates/kode-server/src/wire_codec.rs`（PYTHON*=pickle opaque、FIXED_DICT 声明序，带 datatype.cpp 行号 provenance）；`crates/kode-server/tests/golden/wire-parity.json`；`docs/features.md` C-15 条目。
- **同库既有专题**：[持久化流程](../persistence-flow/persistence-flow.zh.md)（cellData / 写回时机）、[内存坑集](../memory-references/memory-references.zh.md)（EntityCall 是远程代理）、[实体生命周期](../entity-lifecycle/entity-lifecycle.zh.md)。
- **行号口径说明**：本篇行号以在线 master 为准；若用户本地 checkout 版本不同，行号可能有偏移，**语义与函数名不变**。凡未能核实的均标 `TODO 待验证`，未编造任何行号。
