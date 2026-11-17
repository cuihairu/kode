# user_type 实现契约:types.xml FIXED_DICT implementedBy 三契约方法

依据:fork KBEngine(HEAD 55a66552)`kbe/src/lib/entitydef/datatype.cpp` + `entitydef.cpp`,与 fork study 档 `docs/zh/study/05-entitydef-and-entity-definition.md` §5.6 交叉校对。本文只写源码已证事实;未取证处显式标注。

## 1. types.xml 在加载序中的位置

- `entitydef.cpp:181`:`if(!DataTypes::initialize(defFilePath + "types.xml"))` —— types.xml 在 entities.xml 与各 `.def` 解析**之前**装载;`.def` 里 `<Type>` 能否识别取决于 DataTypes 注册表里是否已有该名字,而非 Python 侧是否存在同名类。
- `DataTypes::initialize` 先注册内置类型(UINT/INT/STRING/VECTOR/PYTHON/ENTITYCALL 等),再 `loadTypes()` 把 types.xml 里的别名/FIXED_DICT/ARRAY 补进注册表(fork study 档 §5.6 同向)。

## 2. implementedBy 的解析与组件范围

FIXED_DICT 节点上的 `<implementedBy>` 是「脚本自定义类型辅助实现」的声明(`moduleName.Symbol` 两段式):

- `datatype.cpp:2169-2172`:解析 `implementedBy` 子节点,取原文 `strType`。
- **组件范围闸** `datatype.cpp:2174-2179`:仅 `CELLAPP_TYPE || BASEAPP_TYPE || CLIENT_TYPE` 三组件执行装载:

```cpp
if(g_componentType == CELLAPP_TYPE || g_componentType == BASEAPP_TYPE ||
        g_componentType == CLIENT_TYPE)
```

```cpp
if(strType.size() > 0 && !loadImplModule(strType))
    return false;
```

其余组件(dbmgr/loginapp/logger/interfaces/bots 等)不装载 impl 模块,`strType` 只进 `EntityDef::md5()` 参与校验和。
- `datatype.cpp:2328-2335`:`strutil::kbe_split<char>(moduleName, '.', res_)` 后要求**恰好两段**,否则报 `FixedDictType::loadImplModule: {} impl error! like:[moduleName.ClassName|moduleName.xxInstance]` 装载失败(`|` 两侧是「类 / 实例」两种合法形态的记法,不是分隔符)。
- `datatype.cpp:2343-2354`:`PyImport_ImportModule(res_[0])` 取模块 → `PyObject_GetAttrString(implModule, res_[1])` 取符号 → `setImplModule(pyImplObj)`。
- `.def`/脚本上下文直接传实现对象的另一路:`datatype.cpp:2203-2219` `PyEntityDef::FixedDictType::initialize()` 同样走 `setImplModule(implementedBy)`,失败报 `FIXED_DICT({}) setImplModule error!`。

## 3. 三契约方法(装载硬闸)

`datatype.cpp:2360 FixedDictType::setImplModule(PyObject* pyobj)`:

1. impl 对象为 null → `SCRIPT_ERROR_CHECK` + return false(实现模块装载失败)。
2. `PyType_Check(implObj_)` 为真(类形态)→ `PyObject_CallObject` 实例化;实例化失败 → 装载失败(`xxInstance` 实例形态跳过此步)。此后三方法都从**实例**上取。
3. 三契约方法逐个 `PyObject_GetAttrString` 取,**顺序即声明序**;任一取不到(实现缺该方法)→ `SCRIPT_ERROR_CHECK` + return false,实现模块装载失败——引擎侧表现为组件启动/实体定义装载链报错:

```cpp
pycreateObjFromDict_ = PyObject_GetAttrString(implObj_, "createObjFromDict");
```

```cpp
pygetDictFromObj_ = PyObject_GetAttrString(implObj_, "getDictFromObj");
```

```cpp
pyisSameType_ = PyObject_GetAttrString(implObj_, "isSameType");
```

引擎在此只做**属性存在性**检查(`GetAttrString`),对实现的语法形态没有任何 `def` 约束:类方法、模块级函数、实例属性、赋值/lambda 绑定的 callable,只要属性取得到即通过本闸。

## 4. 序列化契约方向(缺方法的后果)

- **wire/db→mem(反序列化入口)** = `impl_createObjFromDict`(`datatype.cpp:2408`):入参已是目标脚本类型或 `impl_isSameType` 通过则原样透传;否则调 `pycreateObjFromDict_`,返回 null 或校验不过 → `SCRIPT_ERROR_CHECK` + `{}.isSameType() is failed!` + `Py_RETURN_NONE`(`datatype.cpp:2421-2427`)。缺 `createObjFromDict` = 无法从网络/DB 构造该类型。
- **mem→wire/db(序列化出口)** = `impl_getDictFromObj`(`datatype.cpp:2435`):

```cpp
PyObject* FixedDictType::impl_getDictFromObj(PyObject* pyobj)
```

调 `pygetDictFromObj_`,取不到实现时同类失败链。缺 `getDictFromObj` = 无法写网络/持久化该类型。
- `impl_isSameType`(`datatype.cpp:2450`)同时是 `createObjFromDict` 结果的校验器(`datatype.cpp:2421`)。缺 `isSameType` = 类型判定失效(构造结果无法过校验)。
