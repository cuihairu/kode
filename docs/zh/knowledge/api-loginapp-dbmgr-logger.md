# Loginapp / Dbmgr / Logger 面 API 参考（KB-API-006）

> 双语镜像：[English](../knowledge/api-loginapp-dbmgr-logger.md)。断言与
> 引用完全一致；行号漂移核对以 EN 篇为准。
>
> **范围**：三个薄服务进程——**loginapp**、**dbmgr**、**logger**——的
> 脚本可见 `KBEngine` 面。源料为官方 3.7 口径 CHM 转换文本
> （`kbengine/docs/api/kbengine/{loginapp,dbmgr,logger}/{KBEngine.md,
> index.md}`，文档条目 9 + 8 + 7 个）。源料措辞不照抄（chm 粘连如
> `ThisKBEnginemodule`、重复的 `onLoginAppReady` 节），以下全部行为断言
> 均对 fork 源码重新取证。三个面合为一篇，因为它们本来就是同一个面：
> 三个进程都派生自 `PythonApp`，差异仅在 C++ 侧调用哪些入口脚本回调。
>
> **Grounding**：fork `kbe/src`，HEAD `6d12b8f`（grounding 基线
> `c2a3b8f`），2026-11-04 在 HEAD 上核验。注意 fork 已把 logger 进程
> 移至 `kbe/src/server/tools/logger/`（上游 3.7 为
> `kbe/src/server/logger/`）；下文锚点一律按 fork 布局。版本口径与偏离
> 标注格式依 [Python 版本口径](python-version-baseline.md)
> （§5 用其 §7 模板）。姊妹篇：[baseapp 面](api-baseapp.md)、
> [cellapp 面](api-cellapp.md)、[client 面](api-client.md)。
>
> **覆盖**：24 个文档条目全覆盖——loginapp 3 个成员函数 + 6 个回调，
> dbmgr 4 个成员函数 + 4 个回调，logger 3 个成员函数 + 4 个回调
> （`onReadyForShutDown` 在 dbmgr 与 logger 两篇源料中都有文档，按面各
> 计一次）。运行时实际安装的共享 `PythonApp` 面远大于源料的 3 函数清单
> （§1）；多出的名字同样带锚点列出。

## 1. 面的组装方式

三个进程都不注册 app 专属的 `KBEngine` 方法。整个模块面来自共享的
`PythonApp` 层加 `Script::install` 核心：

| 注册点 | 注册内容 |
| --- | --- |
| `kbe/src/lib/server/python_app.cpp:230-349`（`PythonApp::installPyModules`，三者共同基类） | `MemoryStream`（`:271`）、`publish`（`:275`）、`scriptLogType`（`:278`）、`getResFullPath`（`:281`）、`hasRes`（`:284`）、`open`（`:287`）、`listPathRes`（`:290`）、`matchPath`（`:293`）、`debugTracing`（`:296`）；整型常量 `LOG_TYPE_NORMAL/INFO/ERR/DBG/WAR`（`:298-322`）、`NEXT_ONLY`（`:323`）；`addTimer`/`delTimer`（`:329-330`）、`registerReadFileDescriptor`/`registerWriteFileDescriptor`/`deregisterReadFileDescriptor`/`deregisterWriteFileDescriptor`（`:331-334`） |
| `kbe/src/lib/pyscript/script.cpp:246-257`（`Script::install`） | `component` 字符串属性（`:248`；按进程取 `COMPONENT_NAME_EX`） |
| `kbe/src/lib/pyscript/script.cpp:258` | `genUUID64` |
| `kbe/src/lib/pyscript/script.cpp:286` + `kbe/src/lib/pyscript/pyurl.cpp:23` | `urlopen`（`Script::install` 期间由 `PyUrl::initialize` 安装） |

派生关系：`Loginapp : PythonApp`
（`kbe/src/server/loginapp/loginapp.h:22`）、`Dbmgr : PythonApp`
（`kbe/src/server/dbmgr/dbmgr.h:32`）、`Logger : PythonApp`
（`kbe/src/server/tools/logger/logger.h:49`）。
`PythonApp::installPyModules` 末尾调用虚函数 `onInstallPyModules()`
（`python_app.cpp:336`）；loginapp 完全留空（loginapp.cpp 中没有任何
`APPEND_SCRIPT_MODULE_METHOD`），dbmgr 只加一个方法（§3），logger 不加。

因此三者在源料清单之外共享的，是上表整套资源/timer/IO 面——源料在这
三个进程名下从未提及。一个显著的**缺席项**是 `SERVER_ERR_*` 整型常量
（含 `SERVER_SUCCESS`）：它们只由 `EntityApp::installPyModules` 注册
（`kbe/src/lib/server/entity_app.h:485-489`，取值表
`kbe/src/lib/server/server_errors.h:57+`），而 loginapp/dbmgr/logger
*不是* EntityApp。见偏离表（D2 行）。

另需如实说明：官方 index 页声称各进程脚本位于 `scripts/login`、
`scripts/db`、`scripts/logger`。本 fork 的 `kbe/res/scripts/` 只带
`common/`（存放 `kbengine_defaults.xml` 等默认 XML），仓库不含
login/db/logger 入口脚本——下述回调只能由部署方自带入口脚本触发。

## 2. Loginapp 面

loginapp 负责实体注册与登录请求
（`docs/api/kbengine/loginapp/index.md:1-5`）。脚本入口为
`kbengine_defaults.xml -> entryScriptFile`；以下回调都在入口模块上
调用。

### 成员函数

- `addTimer(initialOffset, repeatOffset=0, callbackObj=None)` /
  `delTimer(id)` —— 共享面，适用
  [api-baseapp](../knowledge/api-baseapp.md) §2.1；锚点
  `python_app.cpp:329-330`（注册）、`:721-753`（`__py_addTimer`）、
  `:755-771`（`__py_delTimer`）。fork 细节：`__py_addTimer` 按 `"ffO"`
  解析——callback 参数是**必填**，并非默认 `None` 的可选参
  （偏离表 D1 行）。`repeatOffset ≤ 0` 得到单次 timer
  （`kbe/src/lib/server/script_timers.cpp:56-66`：仅当
  `repeatOffset > 0` 时 `repeatTicks` 才非 0）；负的
  `initialOffset` 会钳到 0 并告警（`script_timers.cpp:43-49`），
  而非源料所称"忽略"。
- `urlopen(url, callback, postData, headers)` —— 共享面；注册
  `pyurl.cpp:23`，实现 `PyUrl::__py_urlopen`（`pyurl.cpp:69+`，
  五参回调 `(httpcode, data, headers, success, url)`）。所有
  `PythonApp` 进程语义一致。

### 回调

- `onLoginAppReady()` —— 在 `Loginapp::initializeEnd` 末尾以格式
  `""` 调用（`loginapp.cpp:170-180`；调用点 `:174-175`）。
- `onLoginAppShutDown()` —— `Loginapp::onShutdownBegin` 调用
  （`loginapp.cpp:59-62`）。
- `onRequestLogin(loginName, password, clientType, datas)` —— 由
  `Loginapp::login` 以格式 `"ssby#"` 调用
  （`loginapp.cpp:1012-1018`）。返回契约已核验：C++ 侧接受裸错误码或
  **五元组**，按 `"H|s|s|b|y#"` 解析
  （`errorno, loginName, password, clientType, datas`；解析在
  `loginapp.cpp:1024-1029`，非序列/长度不符在 `:1065-1072` 拒绝）。
  非 `SERVER_SUCCESS` 错误码走 `_loginFailed`（`:1052-1056`）；空
  `loginName` 以 `SERVER_ERR_NAME` 失败（`:1058-1064`）。成功的请求
  记入 `pendingLoginMgr_`（`pendingLoginmgr.h`；find/insert 在
  `loginapp.cpp:1086-1094`），即源料行文所指的排队。
- `onLoginCallbackFromDB(loginName, accountName, errorno, datas)` ——
  dbmgr 回程回调，`loginapp.cpp:1229-1235` 调用，处理中的 pending
  记录在 `:1222` 查找。
- `onRequestCreateAccount(accountName, password, datas)` —— 以格式
  `"ssy#"` 调用（`loginapp.cpp:367-373`）。返回契约：裸错误码或元组
  `(errorno, accountName, password, datas)`——违约在 `loginapp.cpp:386`
  与 `:409` 记日志（`:409` 明确写出元组形状）。请求记入
  `pendingCreateMgr_`（find `:348`，insert `:512`）。
- `onCreateAccountCallbackFromDB(accountName, errorno, datas)` ——
  `loginapp.cpp:588-594` 调用；pending 记录在 `:609` 移除。

注意：源料推荐的返回表达式
`(KBEngine.SERVER_SUCCESS, loginName, ...)` 在本 fork 的 loginapp 上
原样运行会失败，因为 `SERVER_SUCCESS` 未安装到 `PythonApp` 进程
（偏离表 D2 行）。

## 3. Dbmgr 面

dbmgr 负责实体数据存储与加载/查询
（`docs/api/kbengine/dbmgr/index.md:1-5`）。

### 成员函数

- `addTimer` / `delTimer` / `urlopen` —— 与 loginapp 相同（§2）。
- `executeRawDatabaseCommand(command, callback, threadID,
  dbInterfaceName)` —— dbmgr 注册的唯一 app 专属 `KBEngine` 方法：
  `dbmgr.cpp:355`（位于 `Dbmgr::installPyModules` 内；该函数其余部分
  只是串联 `PythonApp::installPyModules` 与 `EntityDef` 模块安装，
  `dbmgr.cpp:331-333`）。
  - 参数解析 `Dbmgr::__py_executeRawDatabaseCommand`
    （`dbmgr.cpp:834-880`）：1-4 个位置参，按 `"s#|O|i|O"`——
    `command`（bytes/str）、可选 `callback`、可选 `threadID`
    （存作 `ENTITY_ID eid`）、可选 `dbInterfaceName`（默认
    `"default"`，`:860`；未知接口名在 `:865-870` 抛 `TypeError`）。
    与源料参数表一致。
  - 分发：`Dbmgr::executeRawDatabaseCommand`（`:881-913`）把回调存入
    回调管理器（`:905-908`），与命令一起序列化后交给接口处理器的
    线程池；无效接口/缺池报错（`:892`、`:798`、`:808`、`:820`）。
  - 回调收到 `(result, rows, insertid, error)`；回程路径是
    `Dbmgr::onExecuteRawDatabaseCommandCB`（`:918-1035`，回调取出在
    `:1014-1032`）。
  - 源料关于 `threadID` 可传实体 ID、并入该实体归档队列的提示，对应
    `eid` 参数随命令转发（`:876` → 实现签名 `:881`）。

### 回调

- `onDBMgrReady()` —— `Dbmgr::initializeEnd` 末尾
  （`dbmgr.cpp:306-313`）。
- `onDBMgrShutDown()` —— `Dbmgr::onShutdownBegin`
  （`dbmgr.cpp:153-156`）。
- `onReadyForShutDown()` —— 入口脚本实现该函数时由
  `Dbmgr::canShutdown` 轮询（`dbmgr.cpp:77-95`）：仅当回调恰好返回
  `Py_True` 才允许退出；其余返回值得
  `CAN_SHUTDOWN_STATE_USER_FALSE`，稍后再次询问——与源料
  "返回 True 允许退出"一致。
- `onSelectAccountDBInterface(accountName)` —— 由
  `Dbmgr::selectAccountDBInterfaceName` 以格式 `"s"` 调用
  （`dbmgr.cpp:1240-1267`）：返回的字符串选择
  `databaseInterfaces` 条目；空/未知结果报错并回退 `"default"`
  （`:1254-1258`）。源料"返回接口名"的契约准确；且该回调对**所有**
  账号类 dbmgr 操作都会触发，不限于登录（调用点含
  `accountNewPassword` 路由，`dbmgr.cpp:1230-1235`）。

## 4. Logger 面

logger 收集各服务进程输出的日志
（`docs/api/kbengine/logger/index.md:1-5`）。fork 布局提示：进程位于
`kbe/src/server/tools/logger/`（上游为 `kbe/src/server/logger/`）。

### 成员函数

- `addTimer` / `delTimer` / `urlopen` —— 与 loginapp 相同（§2）。
  logger 自身不注册方法；其内部 20 Hz tick 是 C++ dispatcher timer，
  脚本不可见（`logger.cpp:123`）。

### 回调

- `onLoggerAppReady()` —— `Logger::initializeEnd` 末尾
  （`logger.cpp:126-135`）。
- `onLoggerAppShutDown()` —— `Logger::onShutdownBegin`
  （`logger.cpp:215-218`）。
- `onReadyForShutDown()` —— 与 dbmgr 相同的 `Py_True` 门，
  来自 `Logger::canShutdown`（`logger.cpp:175-192`）。
- `onLogWrote(datas)` —— 入口脚本实现该函数时，每条日志都会调用
  （`logger.cpp:286-316`；检测在函数级 static 缓存，`:287`）。
  `datas` 是完整格式化后的日志行，以 bytes 传入（`"y#"` 格式，
  `:290-294`）。fork 的返回值契约超出源料：返回 `False` 则该条不落盘
  （`:297-301`）；返回 `str`/bytes 会**改写落盘内容**
  （`:303-316`）；其余真值按原样落盘。源料只记载了参数，
  未记载这些返回语义。

## 5. 3.7 源料 vs fork 3.12 偏离

| 条目 | 官方 3.7 源料声称 | fork 3.12 实际 | 域 | 证据 |
| --- | --- | --- | --- | --- |
| D1 `addTimer` 的 `callbackObj` 默认值 | `callbackObj=None`——可选参数 | callback **必填**：`PyArg_ParseTuple(args, "ffO")` 缺参即失败 | Fork | `kbe/src/lib/server/python_app.cpp:721-725` |
| D2 这些进程上的 `KBEngine.SERVER_SUCCESS` / `SERVER_ERR_*` | `onRequestLogin`/`onRequestCreateAccount` 应返回 `(KBEngine.SERVER_SUCCESS, ...)` | `SERVER_ERR_*` 常量在 loginapp 与 dbmgr 上**实存**（各自 `onInstallPyModules` 内有同款注册循环：`loginapp.cpp:199-206`、`dbmgr.cpp:343-352`），**仅 logger 缺失**（`logger.h:49` 派生自 `PythonApp` 且无此注册）——文档片段在 loginapp/dbmgr 可用，仅 logger 上会失败 | Fork | `kbe/src/server/loginapp/loginapp.cpp:199-206`、`kbe/src/server/dbmgr/dbmgr.cpp:343-352`、`kbe/src/lib/server/entity_app.h:485-489`、`kbe/src/lib/server/server_errors.h:57-58` |
| D3 `addTimer` 的 `repeatOffset ≤ 0`"将被忽略" | 忽略（则 timer 仍重复？） | 仅当 `repeatOffset > 0` 时 `repeatTicks` 才非 0 → timer 为单次；负 `initialOffset` 钳 0 并告警 | Fork | `kbe/src/lib/server/script_timers.cpp:43-49, 56-66` |
| D4 `delTimer` 传无效 id "将产生错误" | 产生错误 | 行为一致：抛 `TypeError` 并返回 `-1`——契约无偏离，错误类型现在明确 | Fork | `kbe/src/lib/server/python_app.cpp:755-771` |
| D5 示例中的 `print` 语句 | Python-2 `print` 语法 | 内嵌解释器为 Python 3.12；示例需 `print(...)` | Python | 已核验——语法之外无行为偏离；见 [Python 版本口径](python-version-baseline.md) §2、§4 |
| D6 `onLogWrote` 返回值语义 | 仅记载 `datas` 参数 | 返回 `False` 不落盘；返回字符串则改写落盘日志行 | Fork | `kbe/src/server/tools/logger/logger.cpp:286-316` |
| D7 logger 进程源码位置 | 源料早于布局变化；上游 3.7 为 `kbe/src/server/logger/` | fork 移至 `kbe/src/server/tools/logger/` | Fork | HEAD `6d12b8f` 目录树 |
| D8 `urlopen` 在三个面上的可用性 | loginapp/dbmgr/logger 各自记载 | 一致——经 `PyUrl::initialize` 安装到每个 `PythonApp` | Fork | `kbe/src/lib/pyscript/script.cpp:286`、`kbe/src/lib/pyscript/pyurl.cpp:23` |

## References（参考）

- 源料：`kbengine/docs/api/kbengine/loginapp/{KBEngine.md,index.md}`、
  `dbmgr/{KBEngine.md,index.md}`、`logger/{KBEngine.md,index.md}`
- 共享面：`kbe/src/lib/server/python_app.cpp:230-349, 721-771`、
  `kbe/src/lib/pyscript/script.cpp:246-290`、
  `kbe/src/lib/pyscript/pyurl.cpp:23, 69+`、
  `kbe/src/lib/server/script_timers.cpp:38-70`
- Loginapp：`kbe/src/server/loginapp/loginapp.cpp:59-62, 170-180,
  367-410, 588-609, 1012-1094, 1222-1235`、`pendingLoginmgr.h`
- Dbmgr：`kbe/src/server/dbmgr/dbmgr.cpp:77-95, 153-156, 306-313,
  331-360, 786-913, 918-1035, 1240-1267`
- Logger：`kbe/src/server/tools/logger/logger.cpp:123, 126-135,
  175-192, 215-218, 286-316`、`logwatcher.h/cpp`
- 姊妹知识页：`api-baseapp.md`、`api-baseapp-entity.md`、
  `api-cellapp.md`、`api-client.md`、`python-version-baseline.md`
