# KSEM-SER-01 收口:序列化入口与格式来源盘点

**日期**:2026-11-13
**条目**:`todo.md` KSEM-SER-01 —— 盘点序列化入口与格式来源:分别登记引擎 wire、FIXED_DICT implementedBy、PYTHON/pickle、项目 JSON/自定义 pack/unpack;列出现有 codec 和缺失消费入口。

**证据源**:引擎树 `/home/cui/workspaces/kbengine` @ `3082ab5`(2026-11-13 检出,工作树仅 bin/ 未跟踪产物,源码干净)。行号为该检出实测,后续引擎更新需对账。

---

## 1. 来源 A:引擎 wire(DataType 流序)

**核心接口**(`kbe/src/lib/entitydef/datatype.h`,实现在 `datatype.cpp`):

| 面 | 锚点 | 说明 |
|---|---|---|
| `addToStream(MemoryStream*, PyObject*)` | datatype.h:48(纯虚) | 序列化出口:PyObject → 流。datatype.cpp 约 80 处逐类型实现 |
| `createFromStream(MemoryStream*)` | datatype.h:50(纯虚) | 反序列化入口:流 → PyObject |
| `isSameType(PyObject*)` | datatype.h:46(纯虚) | 类型判定(createObjFromDict 结果校验链一环) |
| `PropertyDescription::addToStream` / `isSameType` | `property.cpp:94` / `:82` | 属性层包装(flags 过滤 + DataType 调度) |

**wire 帧装配**(属性同步,`baseapp/entity.cpp:128-151`):

```
newMessage(ClientInterface::onUpdatePropertys)   // 固定消息 id
<< entity id                                     // 实体 id
<< (usePropertyDescrAlias ? aliasIDAsUint8       // 属性别名 uint8
                          : getUType())          // 或属性 UID uint32
<< mstream                                       // DataType::addToStream 载荷
```

同一帧形族的调用点:

| 调用点 | 面 |
|---|---|
| `baseapp/entity.cpp:134` | 属性变更 → 客户端 onUpdatePropertys |
| `baseapp/entity.cpp:378/:383` | 模板流:defval/现值 addToStream |
| `baseapp/entity_remotemethod.cpp:68` | 方法实参:`methodDescription->addToStream(mstream, args)` |
| `cellapp/entity.cpp:685` | 属性变更 → 客户端 |
| `cellapp/entity.cpp:705` | ghost 广播:onUpdateGhostPropertys(CELL 域位跨 cellapp) |
| `cellapp/entity.cpp:1110/:1115` | 模板流 |
| `baseapp/entity.cpp:994` | 反向:`pMethodDescription->createFromStream(&s)`(方法实参解出) |

**DB 持久化 wire(同一流序落 blob)**(`kbe/src/lib/db_interface/entity_table.h`):`writeItem/:145`、`queryTable/:150`、`writeTable/:230`、`writeEntity/:330`、`queryEntity/:340` 全部以 `MemoryStream*` 为载荷——DB 记录 = 同一 DataType 流序,列形态按类型映射(`db_mysql/entity_table_mysql.cpp:699-711`:PYTHON/复杂类型 → `BLOB` 列 `BINARY_FLAG|BLOB_FLAG`;标量 → 对应 SQL 列)。ARRAY(`:1302`)、FIXED_DICT(`:1453`)、Component(`:1572`)、ENTITYCALL(`:1197`)、VECTOR2-4(`:967/:1052/:1135`)各有自己的 addToStream 展开。

**帧要点(供 SER-12/13)**:字段序 = 消息 id → 实体 id → 属性标识(alias/UID 二选一)→ 类型载荷;alias 模式(uint8)由 `usePropertyDescrAlias()` 决定——同一逻辑属性两种字节布局,SER-13 兼容检查必须覆盖。

## 2. 来源 B:FIXED_DICT implementedBy 转换

引擎侧(user_type 自定义类接管 dict↔对象转换):

| 面 | 锚点 | 说明 |
|---|---|---|
| 值形态 | `datatype.cpp:2331-2357 loadImplModule` | `MODULE.Symbol` 恰两段:ImportModule + GetAttrString;class/def/赋值三形态皆可 |
| 契约安装 | `datatype.cpp:2383-2397 setImplModule` | 逐个 GetAttrString 取 `createObjFromDict`/`getDictFromObj`/`isSameType`,任一缺失 → SCRIPT_ERROR_CHECK 失败,模块装载炸 |
| 转换入口 | `datatype.cpp:2031 impl_createObjFromDict` | wire/db→mem:调 `createObjFromDict` 后过 isSameType |
| 字段注册 | `datatype.cpp:1917/:1918`(pycreateObjFromDict_/pygetDictFromObj_)、`:1935/:1936`(S_RELEASE) | FIXED_DICT 的转换函数槽位 |

kode 已有消费面(见 §5);缺口见 §6 的 SER-03..07。

## 3. 来源 C:PYTHON / pickle

| 面 | 锚点 | 说明 |
|---|---|---|
| Pickler 类 | `kbe/src/lib/pyscript/pickler.h:11` | 代理 `cPickle.dumps/loads` 的静态封装 |
| PYTHON 类型流序 | `datatype.cpp:1185`(空判)`/:1227`(pickle)`/:1240/:1296/:1352/:1408`(unpickle 各实现) | PYTHON 值 = pickle 字节串进流,非结构化 |
| 实体创建 initData | `baseapp/baseapp.cpp:2661`(pickle)/`:2722`(unpickle)、`:2891/:2956`(同族) | createEntityAnywhere 跨进程 params dict → pickle → wire |
| baseapp 共享数据 | `baseapp/baseapp.cpp:3734/:3754 onBroadcastBaseAppDataChanged` | key/value 逐个 unpickle(全局数据车道 KDB 相邻) |

口径:PYTHON 桶 = pickle 不透明字节——**无字段结构可静态展开**(SER-11 边界的引擎依据)。

## 4. 来源 D:项目 JSON / 自定义 pack/unpack

- **引擎不拦截**:项目脚本 `import json` 走 CPython stdlib,引擎无 hook、无 wire 参与——JSON 是**业务内存结构**,不进引擎流序。
- kode 现有 JSON 面 = **传输侧**非分析侧:`src/backend/hotReloadTransport.ts:557/:564` 生成的热更载荷脚本里 `json.loads/dumps`(kode↔引擎自身通道)。
- 项目业务代码里的 `dumps/loads` 链、自定义 pack/unpack 函数:**现在没有任何分析面**(SER-08..10 的靶子)。无 schema 时 `json.loads` 返回类型静态不可知——验收文本明令「无 schema 时不声称 json.loads 返回固定类型」。

## 5. kode 现有 codec/契约面(盘点)

**TS(`src/backend/`)**:

| 模块 | 已有面 | 覆盖来源 |
|---|---|---|
| `userTypeContract.ts`(+`userTypeContractSource.ts`) | 三契约方法存在性(缺方法诊断 `kbengine.userTypeContractMethodMissing`);序列化方向文案:缺 createObjFromDict=反序列化入口缺失、缺 getDictFromObj=序列化出口缺失、缺 isSameType=类型判定失效;裸 PYTHON 整值 pickle 进出注解(`userTypeContractSource.ts:86-88`) | B + C |
| `implementedByBinding.ts`(STRUCT-06) | `MODULE.Symbol` 绑定裁定(bound/unbound 九类未知保留:ambiguous-symbol/ambiguous-module/dynamic-value/module-not-found/symbol-not-found/malformed);包胜文件导入序 | B |
| `fixedDictConstructCheck.ts` | createObjFromDict 构造点键检查(缺键/多键/值结构,STRUCT-03) | B |
| `fixedDictSubscript.ts`(STRUCT-02) | FIXED_DICT 内存形式子字段键位(补全/跳转/悬停) | B(内存视图) |
| `fixedDictMutationDiagnostics.ts` | FIXED_DICT 子键赋值/嵌套变异陷阱 | B(写点) |
| `hoverMarkdown.ts` | transport vs memory 双视图展示 | A+B(展示) |
| `playerDataCloneWire.ts` | kode 自身 dbClone TypedValue 邻接标签 JSON wire(`$/kode/dbClone/*`)——**kode 内部通道**,非引擎流序 | kode 自有 |

**Rust(`crates/kode-server/src/semantics/`)**:

| 面 | 位置 |
|---|---|
| `implemented_by_symbol` 字段(types.rs / rpcargs.rs) | FIXED_DICT 绑定符号随 RPC 结构面下发 |
| snapshot/rules 组件槽合并(CELL-16) | 组件属性结构归一(非序列化,但共用 def 类型图) |
| `refs.rs`/`rpcargs.rs` | Arg 类型引用与角色化引用(方法实参 wire 的静态半边) |

## 6. 缺失消费入口(映射 SER-02..14)

| 条目 | 缺口(盘点结论) |
|---|---|
| SER-02 契约模型 | 无统一模型把「编码器/解码器/逻辑对象/传输结构/字段序/版本/证据」表达为可查询对象;现散在 7 个 TS 模块各说各话 |
| SER-03 getDictFromObj 输出 | 契约方法**存在性**已查(缺方法诊断),但返回 dict 的**结构**未与 FIXED_DICT schema 关联;缺键/多键/字段类型错不能定位到 return/写点 |
| SER-04 createObjFromDict 输入 | 构造**调用点**键检查已有(fixedDictConstructCheck);转换函数**内部**的 key 访问(补全/跳转/读类型)未获得 schema 上下文 |
| SER-05 转换后对象成员 | 无:静态可解析构造/赋值与输出成员的关联;不凭函数名推定结构(验收令) |
| SER-06 往返结构 | 无:encode/decode 字段对应静态比较;数值往返属运行时验证(需 SER-14 样本) |
| SER-07 isSameType 边界 | 存在性已查;签名/调用绑定与「动态返回不冒称兼容」的待验证状态未建 |
| SER-08 项目 schema | 无任何项目级 schema/注解绑定机制 |
| SER-09 静态字典格式 | dict 构造/写点提取必修/可选/值类型:kode 有流面(self_flow 属性写点),无 dict 形状面 |
| SER-10 JSON 传播 | dumps/loads 链结构传播:零 |
| SER-11 pickle 边界 | 裸 PYTHON≠FIXED_DICT 的裁剪已有注解面;「已有对象类型可传递证据」未建 |
| SER-12 wire 布局解释 | 字段路径/类型/偏移展示:零(hover 双视图只有文字说明,无布局) |
| SER-13 wire 兼容检查 | alias/UID 双布局、Arg 顺序、schema 变更比较:零 |
| SER-14 引擎往返样本 | 无可信夹具集 |

## 7. 边界与不猜口径

- 本盘点只登记**入口与来源**,不实现任何消费面(SER-02 起逐条点火)。
- pickle 桶不透明:PYTHON 值不给字段结构(引擎依据 §3);裸 PYTHON 冒称 FIXED_DICT 是 SER-11 的禁令,不是本盘点的推断空间。
- 项目 JSON 无引擎参与(§4):结构只能来自项目自身写点/schema,SER-08 的「无 schema 不声称固定类型」在此定调。
- DB blob 与网络帧共用 DataType 流序(§1):SER-12/13 的布局解释一张表服务两通道,但 alias/UID 双布局是网络帧特有,DB 侧无 alias。
