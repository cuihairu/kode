# 入口脚本 SPI 方法表

> KODE-CFG-012 · KB-001 引擎机制。引擎只通过 `getEntryScript()` 触达入口模块，
> 本篇就是该接口的完整方法表。源码取自 `/home/cui/workspaces/kbengine`
> （commit `c2a3b8f`）的 `kbe/src`，模板取自
> `kbe/res/sdk_templates/server/python_assets/scripts/`。同批篇目：
> [固定目录与路径解析链](fixed-directories-and-path-resolution.md)、
> [启动流程与堆栈](startup-flow-and-stack.md)。

入口模块是 `entryScriptFile`，一个**模块名**，默认值 `kbemain`（见
[固定目录与路径解析链](fixed-directories-and-path-resolution.md)）。引擎对它的
一切调用都走 `EntityApp::getEntryScript()`
（`kbe/src/lib/server/entity_app.h:89`）、`PythonApp::getEntryScript()`
（`kbe/src/lib/server/python_app.h:51`）或 `ClientApp::getEntryScript()`
（`kbe/src/lib/client_lib/clientapp.h:83`）。

## 表格怎么读

调用有三种形态，方法缺失时的行为不同：

| 形态 | 方法缺失时 | 位置 |
| --- | --- | --- |
| 直接 `PyObject_CallMethod(...)` | 返回 `NULL`，`SCRIPT_ERROR_CHECK()` 打印 `AttributeError` | 如 `kbe/src/server/loginapp/loginapp.cpp:174` |
| `SCRIPT_OBJECT_CALL_ARGSx(...)` 宏 | 宏内先跑 `PyObject_HasAttrString`；`GETERROR` 为假时静默跳过 | 守卫在 `kbe/src/lib/pyscript/py_macros.h:665`（ARGS0）、`:699`（ARGS1）、`:736`（ARGS2）、`:774`（ARGS3）；`AttributeError` 格式化在 `:681` |
| 显式 `PyObject_HasAttrString` 后再调 | 缺失就不调，安全省略 | 如 `kbe/src/server/baseapp/entity_autoloader.cpp:90` 之后 `:92` |

对 `kbe/src` 全量扫描 `getEntryScript()`，得到 **56 处调用点**、归并出
**36 个不同方法名**：其中 32 个是无条件调用（调用点自身不带守卫），4 个在显式
`PyObject_HasAttrString` 之后。

## 4 个可选方法

| 方法 | 守卫行 | 调用行 | 格式符 | 组件 |
| --- | --- | --- | --- | --- |
| `onAutoLoadEntityCreate` | `kbe/src/server/baseapp/entity_autoloader.cpp:90` | `:92` | `sK` | baseapp |
| `onLogWrote` | `kbe/src/server/tools/logger/logger.cpp:287` | `:290` | `y#` | logger |
| `onReadyForLogin` | `kbe/src/server/baseapp/initprogress_handler.cpp:201`、`kbe/src/server/cellapp/initprogress_handler.cpp:153` | `:206`、`:156` | baseapp 为 `O`，cellapp 为 `i` | baseapp、cellapp |
| `onReadyForShutDown` | `kbe/src/server/baseapp/baseapp.cpp:275`、`kbe/src/server/dbmgr/dbmgr.cpp:78`、`kbe/src/server/tools/logger/logger.cpp:176` | `:278`、`:81`、`:179` | `""` | baseapp、dbmgr、logger |

剩下 32 个里有个细节：其中 14 个走 `SCRIPT_OBJECT_CALL_ARGSx` 宏，属性缺失时
同样被跳过（`py_macros.h:665`、`:699`、`:736`、`:774`），差别只是打不打印
`AttributeError`；另外 18 个是直接调用，从 `kbemain.py` 里删掉它们，每次命中都会
抛 Python `AttributeError`。

## 按组件分表

被多个组件共用的方法在各表中重复出现。

### baseapp —— 12 个方法

| 方法 | 必选 | 格式符 | 调用点 | 触发时机 |
| --- | --- | --- | --- | --- |
| `onInit` | 是 | `i`（启动为 `0`，热重载为 `1`） | `kbe/src/server/baseapp/baseapp.cpp:3601` | `Baseapp::onDbmgrInitCompleted`（`baseapp.cpp:3581`），脚本加载后的首个回调 |
| `onBaseAppReady` | 是 | `O` | `kbe/src/server/baseapp/initprogress_handler.cpp:185` | `InitProgressHandler::process`（`initprogress_handler.cpp:132`） |
| `onReadyForLogin` | 可选 | `O` | `initprogress_handler.cpp:201` 守卫、`:206` 调用 | 每 tick 轮询，返回值 ≥ 0.9999 才算完成（`initprogress_handler.cpp:244`） |
| `onGlobalData` | 是（宏） | `OO` | `kbe/src/lib/server/entity_app.h:1308` | `EntityApp::onBroadcastGlobalDataChanged`（`entity_app.h:1261`） |
| `onGlobalDataDel` | 是（宏） | `O` | `entity_app.h:1290` | 同一广播路径 |
| `onBaseAppData` | 是（宏） | `OO` | `kbe/src/server/baseapp/baseapp.cpp:3668` | `Baseapp::onBroadcastBaseAppDataChanged`（`baseapp.cpp:3618`） |
| `onBaseAppDataDel` | 是（宏） | `O` | `baseapp.cpp:3649` | 同上 |
| `onCellAppDeath` | 是 | `O` | `baseapp.cpp:696` | `Baseapp::onCellAppDeath`（`baseapp.cpp:673`） |
| `onLoseChargeCB` | 是 | `OOOO` | `baseapp.cpp:3563` | `Baseapp::onChargeCB`（`baseapp.cpp:3510`） |
| `onAutoLoadEntityCreate` | 可选 | `sK` | `entity_autoloader.cpp:90` 守卫、`:92` 调用 | `EntityAutoLoader::onEntityAutoLoadCBFromDBMgr`（`entity_autoloader.cpp:52`） |
| `onReadyForShutDown` | 可选 | `""` | `baseapp.cpp:275` 守卫、`:278` 调用 | `Baseapp::canShutdown`（`baseapp.cpp:258`） |
| `onBaseAppShutDown` | 是（宏） | `i` = `0` / `1` / `2` | `baseapp.cpp:327`、`:342`、`:389` | `onShutdownBegin`（`:321`）→ `onShutdown(first)`（`:334`）→ `onShutdownEnd`（`:383`） |

### cellapp —— 9 个方法

| 方法 | 必选 | 格式符 | 调用点 | 触发时机 |
| --- | --- | --- | --- | --- |
| `onInit` | 是 | `i`（`0`） | `kbe/src/server/cellapp/initprogress_handler.cpp:137` | `InitProgressHandler::process`（`initprogress_handler.cpp:102`）——cellapp 把 `onInit(0)` 当就绪回调用 |
| `onGlobalData` | 是（宏） | `OO` | `kbe/src/lib/server/entity_app.h:1308` | 与 baseapp 共用 |
| `onGlobalDataDel` | 是（宏） | `O` | `entity_app.h:1290` | 与 baseapp 共用 |
| `onCellAppData` | 是（宏） | `OO` | `kbe/src/server/cellapp/cellapp.cpp:864` | `Cellapp::onBroadcastCellAppDataChanged`（`cellapp.cpp:816`） |
| `onCellAppDataDel` | 是（宏） | `O` | `cellapp.cpp:844` | 同上 |
| `onSpaceData` | 是（宏） | 写入 `Iss`、删除 `IsO` | `kbe/src/server/cellapp/spacememory.cpp:609`、`:615` | `SpaceMemory::onSpaceDataChanged`（`spacememory.cpp:603`） |
| `onSpaceGeometryLoaded` | 是（宏） | `Is` | `spacememory.cpp:308` | `SpaceMemory::onLoadedSpaceGeometryMapping`（`spacememory.cpp:299`）——**没有任何模板实现它** |
| `onAllSpaceGeometryLoaded` | 是（宏） | `Iis` | `spacememory.cpp:336` | `SpaceMemory::onAllSpaceGeometryLoaded`（`spacememory.cpp:331`） |
| `onReadyForLogin` | 可选 | `i` | `cellapp/initprogress_handler.cpp:153` 守卫、`:156` 调用 | 与 baseapp 同一套轮询 |

### loginapp —— 7 个方法

| 方法 | 必选 | 格式符 | 调用点 | 触发时机 |
| --- | --- | --- | --- | --- |
| `onLoginAppReady` | 是 | `""` | `kbe/src/server/loginapp/loginapp.cpp:174` | `Loginapp::initializeEnd`（`loginapp.cpp:163`） |
| `onRequestLogin` | 是 | `ssby#` | `loginapp.cpp:1013` | `Loginapp::login`（`loginapp.cpp:877`） |
| `onLoseLogin` | 是 | `s` | `loginapp.cpp:130` | `Loginapp::onChannelDeregister`（`loginapp.cpp:102`） |
| `onRequestCreateAccount` | 是 | `ssy#` | `loginapp.cpp:368` | `Loginapp::_createAccount`（`loginapp.cpp:285`） |
| `onCreateAccountCallbackFromDB` | 是 | `sHy#` | `loginapp.cpp:590` | `Loginapp::onReqCreateAccountResult`（`loginapp.cpp:578`） |
| `onLoginCallbackFromDB` | 是 | `ssHy#` | `loginapp.cpp:1231` | `Loginapp::onLoginAccountQueryResultFromDbmgr`（`loginapp.cpp:1166`） |
| `onLoginAppShutDown` | 是（宏） | 无参 | `loginapp.cpp:62` | `Loginapp::onShutdownBegin`（`loginapp.cpp:56`） |

### dbmgr —— 4 个方法

| 方法 | 必选 | 格式符 | 调用点 | 触发时机 |
| --- | --- | --- | --- | --- |
| `onDBMgrReady` | 是 | `""` | `kbe/src/server/dbmgr/dbmgr.cpp:309` | `Dbmgr::initializeEnd`（`dbmgr.cpp:283`） |
| `onSelectAccountDBInterface` | 是 | `s` | `dbmgr.cpp:1242` | `Dbmgr::selectAccountDBInterfaceName`（`dbmgr.cpp:1236`） |
| `onReadyForShutDown` | 可选 | `""` | `dbmgr.cpp:78` 守卫、`:81` 调用 | `Dbmgr::canShutdown`（`dbmgr.cpp:76`） |
| `onDBMgrShutDown` | 是（宏） | 无参 | `dbmgr.cpp:156` | `Dbmgr::onShutdownBegin`（`dbmgr.cpp:150`） |

### interfaces —— 5 个方法

| 方法 | 必选 | 格式符 | 调用点 | 触发时机 |
| --- | --- | --- | --- | --- |
| `onInterfaceAppReady` | 是 | `""` | `kbe/src/server/tools/interfaces/interfaces.cpp:153` | `Interfaces::initializeEnd`（`interfaces.cpp:137`） |
| `onRequestCreateAccount` | 是 | `ssy#` | `interfaces.cpp:525` | `Interfaces::reqCreateAccount`（`interfaces.cpp:488`） |
| `onRequestAccountLogin` | 是 | `ssy#` | `interfaces.cpp:637` | `Interfaces::onAccountLogin`（`interfaces.cpp:605`） |
| `onRequestCharge` | 是 | `sKy#` | `interfaces.cpp:752` | `Interfaces::charge`（`interfaces.cpp:717`） |
| `onInterfaceAppShutDown` | 是（宏） | 无参 | `interfaces.cpp:79` | `Interfaces::onShutdownBegin`（`interfaces.cpp:73`） |

### logger —— 4 个方法

| 方法 | 必选 | 格式符 | 调用点 | 触发时机 |
| --- | --- | --- | --- | --- |
| `onLoggerAppReady` | 是 | `""` | `kbe/src/server/tools/logger/logger.cpp:131` | `Logger::initializeEnd`（`logger.cpp:116`） |
| `onReadyForShutDown` | 可选 | `""` | `logger.cpp:176` 守卫、`:179` 调用 | `Logger::canShutdown`（`logger.cpp:174`） |
| `onLoggerAppShutDown` | 是（宏） | 无参 | `logger.cpp:218` | `Logger::onShutdownBegin`（`logger.cpp:210`） |
| `onLogWrote` | 可选 | `y#` | `logger.cpp:287` 守卫、`:290` 调用 | `Logger::writeLog`（`logger.cpp:229`）；守卫是 `static bool`，每个进程只判一次（`logger.cpp:287`） |

### client / bots —— 3 个方法

| 方法 | 必选 | 格式符 | 调用点 | 触发时机 |
| --- | --- | --- | --- | --- |
| `onInit` | 是 | `i`（`0`） | `kbe/src/lib/client_lib/clientapp.cpp:131`、`kbe/src/server/tools/bots/bots.cpp:102` | `ClientApp::initializeEnd`（`clientapp.cpp:128`）、`Bots::initializeEnd`（`bots.cpp:88`） |
| `onFinish` | 是 | `""` | `clientapp.cpp:303`、`bots.cpp:124` | `Bots::finalise`（`bots.cpp:121`）——只属 client/bots，不是服务端回调 |
| `onTargetChanged` | 是 | `i` | `clientapp.cpp:458` | 客户端实体目标变化，仅 client |

## 36 个引擎调用 vs 36 个模板函数

七份官方模板合计 **44 处函数定义 / 36 个不同名字**（base 12、login 8、cell 7、
interface 6、logger 4、db 4、bots 3；跨组件重名在「不同名字」里只算一次）。引擎
调用 36 个不同名字，两个集合在 33 个名字上重合：

| 类别 | 数量 | 名字 | 证据 |
| --- | --- | --- | --- |
| 引擎调用且模板实现 | 33 | 交集 | — |
| 引擎调用、模板未实现 | 3 | `onAutoLoadEntityCreate`、`onSpaceGeometryLoaded`、`onTargetChanged` | 守卫/路径：`entity_autoloader.cpp:90`、`py_macros.h:736`、`clientapp.cpp:458` |
| 模板实现、引擎从不调用 | 3 | `onFini`、`onStart`、`onTick` | 见下 |

### 34 vs 36：两个数都是真的，只是口径不同

早先台账把本表记成 **34 个方法**。对 `kbe/src` 的程序化重扫（`c2a3b8f`，
并在 `3082ab5` 复核结果不变）确认经 `getEntryScript()` 调用的不同名字是
**36 个**——本表没有多算。两个数的差别在统计口径：

- **36** = 引擎在入口脚本对象上调用的全部方法，含 client/bots 专属的一对
  `onFinish`（`clientapp.cpp:303`、`bots.cpp:124`）与 `onTargetChanged`
  （`clientapp.cpp:458`）——服务端 `kbemain.py` 永远收不到这两个。
- **34** = 服务端组件口径：36 减去上述 client/bots 专属对。写**服务端**
  入口脚本时看这个数；下游消费面（如 SPI CodeLens 识别表）也应按此口径
  匹配。

两个数都不含 `onFini`、`onStart`、`onTick`——这三个根本不是引擎调用，
见下节更正。

### 三个模板侧名字的更正

- **`onFini` —— 模板与实现不符，待证伪。** `kbe/src` 里没有任何调用点：grep
  `"onFini"` 与 `onFini\b` 都是空，邻接字符串形态（`"on" "Fini"`）也不存在。
  而模板仍把它标成 KBEngine method
  （`kbe/res/sdk_templates/server/python_assets/scripts/base/kbemain.py:56`，
  `INFO_MSG('onFini()')` 在 `:61`）。实际关停走的是 `onXxxShutDown(state)`
  ——三段式顺序见 [启动流程与堆栈](startup-flow-and-stack.md)。
- **`onTick` —— 不是引擎回调。** `kbe/src` 里不存在 `"onTick"` 字符串，它是模板
  自己的定时器：`onInit` 函数体里有（注释掉的）`#KBEngine.addTimer(0.01, 1.0, onTick)`
  （`kbe/res/sdk_templates/server/python_assets/scripts/db/kbemain.py:17`），定义
  `def onTick(timerID)` 在 `:19`；`interface/kbemain.py:44` 与 `:47` 是同一对。
  即便放开注释，它也由脚本定时器机制驱动，不经过 `getEntryScript()`。
- **`onStart` —— 无调用点，待证伪。** `kbe/src` 里没有针对它的脚本回调调用
  （唯一命中的 `onStart` 是无关的 C++，如 `KBEConcurrency::onStartMainThreadIdling`）。
  模板见 `kbe/res/sdk_templates/server/python_assets/scripts/bots/kbemain.py:14`。
- **`onFinish` 属于组件专属**，不是通用回调：全部调用点只有
  `kbe/src/lib/client_lib/clientapp.cpp:303` 与
  `kbe/src/server/tools/bots/bots.cpp:124`。

## 生命周期图

![KBEngine 入口脚本生命周期](/kbengine-lifecycle.svg)

七阶段（P0 环境路径 → P7 关停），运行期按组件分泳道，关停画成
`state = 0 → 1 → 2` 三段式顺序。必选回调为蓝色，`HasAttr` 守卫的为琥珀色，
三个非引擎名字为虚线。带逐阶段堆栈帧的同款图见
[启动流程与堆栈](startup-flow-and-stack.md)。

## debugpy 该注入在哪

**最佳注入点是 P1 模块导入期（wrapper 模块顶层代码），不是 `onInit`。**

- `onInit` 触发时，引擎已经打过「所有脚本都加载完毕」的注释
  （`kbe/src/lib/server/entity_app.h:1459`、`kbe/src/lib/server/python_app.cpp:708`），
  而 `installPyScript` / `installPyModules` 早已执行完（`entity_app.h:281`、
  `entity_app.h:284`、`python_app.cpp:74`、`python_app.cpp:77`）。此时更早模块的
  导入期错误已经错过。
- wrapper 模块的顶层代码在 `PyImport_Import(entryScriptFile)` 中执行
  （`kbe/src/lib/server/entity_app.h:509`、`python_app.cpp:340`、`bots.cpp:218`、
  `clientapp.cpp:272`），早于 entity def、早于一切回调，而此时进程与端口信息
  已经就绪（`g_kbeSrvConfig.updateInfos(...)` 在 `kbe/src/lib/server/kbemain.h:190`，
  组件注册在 `:198`）。把 `debugpy.listen()` / `debugpy.wait_for_client()` 放在
  `kbemain.py` 顶部，就能停在 Python 真正开始运行的最早一点。
- 次选：只要业务层断点，就用 `onInit(isReload)`——它是首个引擎回调
  （`baseapp.cpp:3601`、`cellapp/initprogress_handler.cpp:137`）。

**装饰类可行。** 引擎用 `PyObject_CallMethod` 在调用时解析属性，所以属性既可以是
被装饰的函数，也可以是带 `__call__` 的类实例。两条约束：

1. 格式符必须与引擎传的一致——`onInit` 用 `"i"`（`baseapp.cpp:3603`），
   `onSpaceGeometryLoaded` 用 `"Is"`（`spacememory.cpp:309`），
   `onLoginCallbackFromDB` 用 `"ssHy#"`（`loginapp.cpp:1233`），而
   `onReadyForLogin` 在 baseapp 是 `"O"`、在 cellapp 是 `"i"`
   （`initprogress_handler.cpp:208` 对 `:158`）。
2. 包装层必须原样透传 `*args, **kwargs` 并原样返回引擎期望的值——登录闸门靠
   `onReadyForLogin` 返回 `Py_True` 才打开（`initprogress_handler.cpp:213`）——
   异常要向上传播，不能吞掉。

上一篇：[固定目录与路径解析链](fixed-directories-and-path-resolution.md) ·
[启动流程与堆栈](startup-flow-and-stack.md) ·
[实体对象生命周期与引用释放](entity-lifecycle-reference.md)
