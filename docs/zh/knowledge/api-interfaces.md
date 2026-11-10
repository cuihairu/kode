# Interfaces 进程 API 参考（KB-API-005）

> 断言与引用完全一致；行号漂移核对以 EN 篇为准。
>
> **范围**：**interfaces** 进程的 Python API 面——第三方平台接入点
> （账号注册/登录核验、计费）。重写自官方 3.7 口径 CHM 转换源料
> （`kbengine/docs/api/kbengine/interfaces/KBEngine.md`，13.4k，12 个
> `def` 节；另含薄 `index.md`）——源料措辞不照抄（chm 转换粘连如
> `ThisKBEngine`、参数表破损、Python 2 示例代码），以下全部行为断言均对
> fork 源码重新取证。
>
> **Grounding**：fork `kbe/src`，HEAD `6d12b8f`。版本口径与偏离标注格式依
> [Python 版本口径](python-version-baseline.md)（§6 用其 §7 模板）。姊妹篇：
> [Baseapp API](api-baseapp.md)（`charge()` / `onLoseChargeCB` /
> `Proxy.getClientDatas`——本文各流程的另一端）。
>
> **覆盖**：源料 12 个文档条目全覆盖——`KBEngine` 模块 7 个成员函数 +
> 5 个回调——外加模块的错误码常量面（`KBEngine.SERVER_SUCCESS` /
> `SERVER_ERR_*`，源料只在正文提及、无独立章节；见 §4）。

## 1. interfaces Python 面的组装方式

interfaces 进程是最小的 server-app Python 面。它是裸 `PythonApp`——
**不是** `EntityApp`——因此**没有 `Entity` 类、没有 `entities`、没有
`globalData`/`cellAppData`**（这些由 `EntityApp::installPyModules` 注册，
在本进程不会运行）。回答「这个 API 在 interfaces 上真的存在吗」按此序查：

| 层 | 注册内容 | 证据 |
| --- | --- | --- |
| interfaces 专属 `KBEngine` 模块函数 | `chargeResponse`, `accountLoginResponse`, `createAccountResponse`, `executeRawDatabaseCommand`；int 常量 `SERVER_ERR_*`（38 个，循环装自 `SERVER_ERR_STR`） | `kbe/src/server/tools/interfaces/interfaces.cpp:176-190`（`Interfaces::onInstallPyModules`；常量 `:178-184`，方法 `:186-189`） |
| 共享 server-app 面（`PythonApp`） | `MemoryStream`, `publish`, `scriptLogType`, `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath`, `debugTracing`，模块级 `addTimer`/`delTimer`，`registerReadFileDescriptor`/`registerWriteFileDescriptor`（+`deregister…`） | `kbe/src/lib/server/python_app.cpp:271-296`, `:329-334` |
| 解释器层（所有带脚本的 app） | `urlopen`, `component` 字符串, `genUUID64`, `addWatcher`/`delWatcher` | `lib/pyscript/pyurl.cpp:23`, `script.cpp:248`, `:258`, `pywatcher.cpp:184-185` |
| 相对 baseapp/cellapp **缺失** | `createEntity`, `charge`, 各实体 API、`Entity` 类、`globalData`/`cellAppData`, `entities` | `Interfaces : public PythonApp`（`interfaces.h:24`）；`server/tools/interfaces/` 下不存在任何 `Entity` 注册点 |

由于 `PythonApp`（不同于 `EntityApp`）不安装错误码常量，interfaces 进程在
`interfaces.cpp:178-184` 自行注册了一份 `SERVER_ERR_*`——同一张字符串表、
同一套值（`server_errors.h:57`）。

**入口脚本**按进程配置：`kbengine_defaults.xml → interfaces →
entryScriptFile`，默认 `kbemain`（`kbe/res/server/kbengine_defaults.xml:234-238`）；
引擎将其作为模块导入（`lib/server/python_app.cpp:338-342`），下文所有回调
分发都经 `getEntryScript()` 打到该模块，而非实体。fork 自带的模板入口在
`kbe/res/sdk_templates/server/python_assets/scripts/interface/kbemain.py`
（136 行）——注意模板目录是 `scripts/interface/`（单数），与引擎从
`entryScriptFile` 解析的名字一致；部署用游戏资产的 `scripts/interfaces/`
在独立的 assets 仓，不在本 fork 内。

## 2. KBEngine 模块成员函数（interfaces 面）

源料 7 个函数全覆盖，语义按 fork 取证。

### `KBEngine.addTimer(initialOffset, repeatOffset, callbackObj)`

在 interfaces 主循环上注册定时器。**触发时机**：回调先在 `initialOffset`
秒游戏时间后执行一次，之后每 `repeatOffset` 秒执行一次（只要未移除）。

- 注册：共享 app 面，`python_app.cpp:329`；实现
  `PythonApp::__py_addTimer` `python_app.cpp:721-753`、
  `ScriptTimers::addTimer` `lib/server/script_timers.cpp:40-89`。
- **fork 签名偏离**：解析串是 `"ffO"`（`python_app.cpp:726`）——三个
  参数**全部必填**。源料的 `repeatOffset=0, callbackObj=None` 默认值在本
  面不存在；两参调用抛 `TypeError`。（§6 #1）
- `callbackObj` 不可调用 → `TypeError`（`python_app.cpp:731`）。
- 负 `initialOffset` 告警后钳到 0（`script_timers.cpp:46-50`）。
  `repeatOffset <= 0` 即单次定时器（`repeatTicks = 0`，
  `script_timers.cpp:53-61`）。
- 回调以 `callbackObj(timerID)` 形式调用
  （`ScriptTimerHandler::handleTimeout`，`python_app.cpp:31-40`——`int`
  id 即 `addTimer` 的返回值）。
- 返回定时器 id（`int`）。定时器表耗尽时 `ScriptTimers::addTimer` 返回 0
  （`script_timers.cpp:85-88`），转成 `ValueError: Unable to add timer`
  （`python_app.cpp:739-746`）。

### `KBEngine.delTimer(id)`

移除已注册的定时器。

- 注册：`python_app.cpp:330`；实现 `python_app.cpp:755-775`、
  `ScriptTimers::delTimer` `script_timers.cpp:96-105`。
- 单次定时器触发后自动移除——定时器表项在 timer 完成时由
  `ScriptTimers::releaseTimer`（`script_timers.cpp:108+`）清除，无需显式
  `delTimer`。
- **fork 行为偏离**：源料说无效 id「会产生错误」。fork 先格式化
  `TypeError` 但随即打印并清除（`PyErr_PrintEx`，
  `python_app.cpp:768-771`），**返回 `-1`** 而非向脚本抛异常。移除有效 id
  则返回该 id。（§6 #2）

### `KBEngine.accountLoginResponse(commitName, realAccountName, extraDatas, errorCode)`

提交脚本对 `onRequestAccountLogin` 回调的处理结论。**触发时机**：第三方
平台核验完成后调用；在此之前引擎把请求挂起在 pending-request 表上。

- 注册：`interfaces.cpp:187`；实现 `Interfaces::accountLoginResponse`
  `interfaces.cpp:651-695`；`__py_` 适配层解析 `"ssy#H"`——三个字符串 +
  一个 unsigned short 错误码（`interfaces.cpp:704`）。
- 按 `commitName` 查找请求；查不到 → `ERROR_MSG` 日志，响应被丢弃
  （`interfaces.cpp:654-665`）。
- 成功路径：向发起请求的 dbmgr 发
  `DbmgrInterface::onLoginAccountCBBFromInterfaces`，携带 `baseappID,
  commitName, realAccountName, password, errorCode` **并附加原始请求 blob
  （`task->postDatas`）与你的 `extraDatas`**（`interfaces.cpp:672-676`)
  ——源料「extraDatas 可转发第三方并可修改」的说法在此函数成立。随后清掉
  pending 请求（`interfaces.cpp:691`）。
- `realAccountName` 是别名映射钩子：登录以你返回的名字继续，不必等于提交名。
- `errorCode`：`KBEngine.SERVER_SUCCESS`（0）放行登录；模板还演示了
  `SERVER_ERR_LOCAL_PROCESSING`（35）=「登录受理，但 dbmgr 仍需校验密码」
  （`kbemain.py:113` 及注释；常量 `server_errors.h:52`）。

### `KBEngine.createAccountResponse(commitName, realAccountName, extraDatas, errorCode)`

提交脚本对 `onRequestCreateAccount` 回调的处理结论。

- 注册：`interfaces.cpp:188`；实现 `Interfaces::createAccountResponse`
  `interfaces.cpp:539-581`；`__py_` 适配层 `"ssy#H"`
  （`interfaces.cpp:592`）。
- 同样按 `commitName` 查找、查不到即丢弃（`interfaces.cpp:542-553`）。
- **fork 行为偏离**：回包 `DbmgrInterface::onCreateAccountCBFromInterfaces`
  只携带 `baseappID, commitName, realAccountName, password, errorCode`
  （`interfaces.cpp:560-561`）——`extraDatas` 参数被接受但**从不转发**。
  源料对两个 Response 函数都写了「extraDatas 可转发第三方并可修改」；在本
  面上只有 `accountLoginResponse` 成立。（§6 #5）
- pending 请求清除于 `interfaces.cpp:579`。

### `KBEngine.chargeResponse(orderID, extraDatas, errorCode)`

提交脚本对 `onRequestCharge` 回调的计费结论。

- 注册：`interfaces.cpp:186`；实现 `Interfaces::chargeResponse`
  `interfaces.cpp:766-839`；`__py_` 适配层解析 `"sy#H"`
  （`interfaces.cpp:848`）。
- **源料遗漏的 fork 校验**：`errorCode >= SERVER_ERR_MAX`（38）时整次调用
  **静默无操作**——订单继续挂起，回调永远到不了 baseapp
  （`interfaces.cpp:851-855`）。自造的越界「自定义错误码」会被直接丢弃。
  （§6 #7）
- 订单存在（`interfaces.cpp:812-837`）：把你的 `extraDatas` 写入订单记录
  （`:813-814`），向 dbmgr 通道发 `DbmgrInterface::onChargeCB`，带
  `baseappID, ordersID, dbid, extraDatas, cbid, errorCode`（`:817-823`）；
  baseapp 随即完成实体 `charge()` 的回调。订单记录擦除（`:837`）。
- **订单不存在**（已超时出表或从未注册）：fork 向**全部** dbmgr 通道广播
  `onChargeCB`，`baseappID`/`dbid`/`cbid` 置零（`interfaces.cpp:779-810`）
  ——源码注释说明这是刻意让 baseapp 的 `onLoseChargeCB` 收到「平台回调但
  服务器侧没有该订单号」的情况（互链 [baseapp API](api-baseapp.md)，
  `baseapp.cpp:3603`）。连 dbmgr 通道都没有 → `ERROR_MSG` 后丢弃
  （`:805-809`）。

### `KBEngine.executeRawDatabaseCommand(command, callback, threadID, dbInterfaceName)`

经 dbmgr 执行原始数据库命令。源料的告诫是结构性的：用本函数改实体数据，
可能被实体后续归档覆盖——实体数据请走实体 DB API。

- 注册：`interfaces.cpp:189`；`__py_` 适配层 `interfaces.cpp:240-283`：
  1-4 参形式（`"s#"`、`"s#|O"`、`"s#|O|i"`、`"s#|O|i|O"`，`:249-256`）；
  `dbInterfaceName` 不在
  `kbengine_defaults.xml → dbmgr → databaseInterfaces` 中则抛 `TypeError`
  （`:273-278`）；默认接口名 `"default"`（`:267-272`）。
- `threadID` 在 fork 中是 `ENTITY_ID eid`：传实体 DBID/id，命令会排到该
  实体的缓冲 DB 写之后，而不是进通用线程池。dbmgr 侧已取证：
  `eid == -1` → `DBUtil::pThreadPool(...).addTask(DBTaskExecuteRawDatabaseCommand)`
  （`dbmgr.cpp:803-810`）；`eid > -1` →
  `Buffered_DBTasks::addTask(DBTaskExecuteRawDatabaseCommandByEntity)`
  （`dbmgr.cpp:815-826`）。缓冲任务队列内部的精确顺序保证：待取证
  （路径 `kbe/src/server/dbmgr/buffered_dbtasks.cpp`）。
- 传输：interfaces 进程从已注册 dbmgr 中**随机**挑一个
  （`interfaces.cpp:295-306`），发 `DbmgrInterface::executeRawDatabaseCommand`，
  带 `eid`、`dbInterfaceIndex`、自身 component id/type 及已保存的回调 id
  （`interfaces.cpp:322-333`）。找不到 dbmgr → `ERROR_MSG`，直接返回、
  无回调（`:303-306`）。
- **回调** `(result, rows, insertid, error)`——由
  `Interfaces::onExecuteRawDatabaseCommandCB`（`interfaces.cpp:339-460`）
  在主线程收到 dbmgr 回包时调用：
  - 有错误串 → `result = None`、`rows = None`、`insertid = None`、
    `error = str`（`:417-432`）；
  - 有结果集（`nfields > 0`）→ `result` 为行列表，每行是 **`bytes`** 单元
    列表（`PyBytes_FromStringAndSize`，`:391`），SQL `NULL` → `None`
    （`:380-384`）；此时 `rows`/`insertid` 为 `None`（`:365-367`）。
  - 无结果集（如 DELETE）→ `result = None`、`rows` = 受影响行数、
    `insertid` = 最后插入 id，均为 `int`（`:400-413`）。
  - 源料「每行是含字段值的字符串列表」是 Python 2 时代措辞；fork 上拿到
    的是 `bytes`，需自行解码。（§6 #9）

### `KBEngine.urlopen(url, callback, postData, headers)`

异步 HTTP(S) 请求，底层 libcurl（`lib/network/http_utility.h:86`，SSL 选项
`:127+`）。请求在主线程之外执行，回调回到主循环。

- 注册：解释器层，`PyUrl::initialize`（`lib/pyscript/pyurl.cpp:15-25`，
  挂接于 `script.cpp:286`）；实现 `PyUrl::__py_urlopen`
  `pyurl.cpp:69-215`。
- 参数形式（fork，`pyurl.cpp:73-181`）：仅 `(url)` 即取回即弃；
  `(url, callback)`；**源料未记载的三参形式**——第三参为 `dict` 时按
  `headers`、为 `bytes` 时按 `postData` 解释，其余抛 `AssertionError`
  （`pyurl.cpp:78-117`）；以及四参形式 `(url, callback, postData, headers)`，
  `postData` 必须是 `bytes`（`:160-166`）。header 字典非 `str:str` 抛
  `AssertionError`（`:94-100`、`:136-143`）；回调不可调用抛
  `AssertionError`（`:174-178`）。无 `postData` 即 GET。
- **返回值**（源料未记载）：`int` 型请求建立状态——`0` = `OK`，其余见
  `Request::Status`（`pyurl.cpp:197-222`，`http_utility.h:89-94`）。
  **不是** HTTP 码；HTTP 码在回调里送达。
- **回调** `(httpcode, data, headers, success, url)`——在
  `PyUrl::onHttpCallback` 组装为 5 元组（`pyurl.cpp:38-65`）：`httpcode`
  int；`data` str（响应体）；**`headers` 是收到的原始头部块字符串**
  （`PyUnicode_FromString(pRequest.getReceivedHeader())`，`pyurl.cpp:50`）
  ——**不是源料声称的 dict**；`success` bool；`url` str。（§6 #8）
- 回调对象在触发前被 `PyUrl::pyCallbacks`（`pyurl.cpp:12`、`:190`）持有，
  请求中途不会被 GC。

## 3. KBEngine 模块回调（interfaces 面）

5 个回调都分发到入口脚本模块（`getEntryScript()`）。所有入站请求以网络
消息抵达 interfaces 进程（`interfaces_interface.h:50`、`:53`、`:56`）；
各 handler 先落一条 pending 请求记录，再调脚本。

| 回调 | 触发（已核验调用点） | 格式串 |
| --- | --- | --- |
| `onInterfaceAppReady()` | `Interfaces::initializeEnd`，脚本加载、主 tick 定时器与无 dbmgr 的 init 之后、telnet server 启动之前（`interfaces.cpp:151-158`；定时器 `:141-142`） | `""` |
| `onInterfaceAppShutDown()` | `Interfaces::onShutdownBegin`（`interfaces.cpp:73-80`） | 经 `SCRIPT_OBJECT_CALL_ARGS0`（`py_macros.h:657`），入口脚本没有该属性时**静默跳过**（`PyObject_HasAttrString` 守卫） |
| `onRequestCreateAccount(registerName, password, datas)` | `Interfaces::reqCreateAccount`（`interfaces.cpp:488-533`）；dbmgr 转发客户端注册请求时调用。同名在途请求静默忽略（`:501-506`）。计名为 `onRequestCreateAccount`（`profile.cpp:7`） | `"ssy#"`（`:525-532`）——`datas` 以 `bytes`（`y#`）抵达 |
| `onRequestAccountLogin(loginName, password, datas)` | `Interfaces::onAccountLogin`（`interfaces.cpp:605-650`）；dbmgr→interfaces 登录核验。同名在途请求忽略（`:612-617`）。已计名（`profile.cpp:8`） | `"ssy#"`（`:636-643`） |
| `onRequestCharge(ordersID, entityDBID, datas)` | `Interfaces::charge`（`interfaces.cpp:717-763`）；baseapp 的 `KBEngine.charge` 经 dbmgr→interfaces 中转后触发（baseapp 入口 `baseapp.cpp:3435`）。重复订单号 `ERROR_MSG` 后拒绝（`:736-741`）。已计名（`profile.cpp:9`） | `"sKy#"`（`:750-758`）——**`ordersID` 是 `str`**，`entityDBID` 是 `K`（uint64） |

源料「必须在入口模块（entryScriptFile）实现」与实现一致：以上分发均调用
`PyObject_CallMethod(getEntryScript().get(), …)`；缺回调得到 `NULL` →
`SCRIPT_ERROR_CHECK()` 打印 traceback，进程继续
（`scriptobject.h:39-50`）。

**分发契约**：`onRequest*` 之后，引擎以提交名/订单号为键挂起一条记录并
回到网络循环——interfaces 是单线程的（自带模板正是因此告诫勿用阻塞式
HTTP 库，`kbemain.py:7`）。脚本最终必须调用对应的 `*Response`，否则记录
一直留到进程退出时由 `WARNING_MSG` 清点丢弃（`interfaces.cpp:49-71`）。

## 4. 模块常量面（错误码）

源料只在正文提及 `KBEngine.SERVER_SUCCESS` 与 `KBEngine.SERVER_ERROR_*`。
fork 的实际面：`SERVER_ERR_STR`（`lib/server/server_errors.h:57-100`）的
全部 38 项以模块 int 形式装于 `interfaces.cpp:178-184`，值 = 下标。

- `KBEngine.SERVER_SUCCESS = 0`（`server_errors.h:17`）。
- `SERVER_ERR_MAX = 38` 是表哨兵——**不**作为常量安装，但限定各
  `*Response` 可接受的取值范围（`interfaces.cpp:851-855`）。
- `SERVER_ERR_LOCAL_PROCESSING = 35`（`server_errors.h:52`）：模板登录路径
  用它表示「受理，dbmgr 仍查密码」（`kbemain.py:113`）。
- 完整表在部署侧的 `kbe/res/server/server_errors.xml`，与源料所述一致。

## 5. 三条请求/响应流程

| 流程 | 链路 | 响应路由 |
| --- | --- | --- |
| 账号注册 | client → loginapp → dbmgr（`Dbmgr::reqCreateAccount`，`dbmgr.cpp:683-697`）→ `findBestInterfacesHandler()`：dbmgr 配置了 interfaces 则选 `InterfacesHandler_Interfaces`，否则 `InterfacesHandler_Dbmgr` 本地处理（`dbmgr/interfaces_handler.cpp:20-31`；转发 `:281`）→ `onRequestCreateAccount` | `createAccountResponse` → `onCreateAccountCBFromInterfaces` → dbmgr → baseapp |
| 账号登录 | client → loginapp → dbmgr → 同一套 handler 分流 → `onAccountLogin`（`interfaces.cpp:605`） | `accountLoginResponse` → `onLoginAccountCBBFromInterfaces`（携带 `postDatas` + `extraDatas`，`interfaces.cpp:672-675`）→ dbmgr → baseapp → `Proxy`（实体侧读取口：`getClientDatas`，`proxy.cpp:24`） |
| 计费 | baseapp `KBEngine.charge`（`baseapp.cpp:3435`）→ dbmgr → `InterfacesHandler_Interfaces::charge`（`interfaces_handler.cpp:544-575`）→ `onRequestCharge` | `chargeResponse` → `onChargeCB` → dbmgr → baseapp 实体回调或 `onLoseChargeCB`（`baseapp.cpp:3603`） |

订单记账：每笔 charge 订单带 `timeout` 戳，按 `interfaces_orders_timeout_`
配置计算（`interfaces.cpp:721`；默认 `0` 于 `lib/server/serverconfig.cpp:83`，
配置读取 `:532`）——**但本 HEAD 没有任何代码消费该字段**（grep
`server/tools/interfaces/`：只有赋值与结构体成员，`orders.h:38`）。不存在
清扫过期订单的超时逻辑；响应永远不来的 charge 会一直占着表项直至进程退出。
待取证：上游是否本有周期清扫而本 fork 缺失。

## 6. 偏离标注（§7 模板，[Python 版本口径](python-version-baseline.md)）

| 条目 | 官方 3.7 口径源料说 | 本 fork 3.12 实际 | 域 | 证据 |
| --- | --- | --- | --- | --- |
| `addTimer` 签名 | `addTimer(initialOffset, repeatOffset=0, callbackObj=None)`——有默认值 | 三参全必填；两参调用抛 `TypeError` | Fork | `python_app.cpp:721-726`（`PyArg_ParseTuple(args, "ffO", …)`） |
| `delTimer` 无效 id | 「会产生错误」（暗示向脚本抛异常） | 格式化 `TypeError` 后打印并清除，**返回 `-1`**；异常不会到达脚本 | Fork | `python_app.cpp:766-771` |
| `createAccountResponse` extraDatas | 「可转发数据……并可修改」（与 login 平行措辞） | 参数被接受但**不转发**——回包不含它 | Fork | `interfaces.cpp:560-561`；对照 login `interfaces.cpp:672-675` |
| `onRequestCharge` ordersID 类型 | `uint64`（模板 docstring 同样写 uint64，`kbemain.py:82-83`） | **`str`**——格式 `"sKy#"`；只有 `entityDBID` 是 `K`(uint64) | Fork | `interfaces.cpp:750-758` |
| `chargeResponse` errorCode 范围 | 「integer，错误码」——暗示任意值 | `>= SERVER_ERR_MAX`(38) 的值被静默丢弃；订单继续挂起 | Fork | `interfaces.cpp:845-855`、`server_errors.h:55` |
| `urlopen` 回调 `headers` | 「是 dict」，如 `{"Content-Type": …}` | **原始头部块字符串** | Fork | `pyurl.cpp:50`（`PyUnicode_FromString(pRequest.getReceivedHeader())`） |
| `urlopen` 三参形式 | 只写了两参（GET）与四参（POST） | 三参形式：第三参 `dict` 按 `headers`、`bytes` 按 `postData`，否则 `AssertionError` | Fork | `pyurl.cpp:78-117` |
| `executeRawDatabaseCommand` 结果单元 | 「含字段值的字符串列表」 | 单元是 **`bytes`**（自行解码）；SQL `NULL` → `None` | Fork | `interfaces.cpp:380-389` |
| 源料示例代码 | Python 2（`print "…"`, `kbengine/interfaces/KBEngine.md:49`） | fork 嵌入 CPython 3.12——示例过时；见口径篇 | Python | [python-version-baseline](python-version-baseline.md) §1-§2；`print` 语句在 Python 3 移除 |
| 回调放置 | 「必须在入口模块（entryScriptFile）实现」 | 证实：分发打 `getEntryScript()`；缺回调经 `SCRIPT_ERROR_CHECK` 打印 traceback，进程继续 | Fork | `interfaces.cpp:525-533`、`:636-643`、`:750-758`；`scriptobject.h:39-50` |
| 入口脚本位置 | 「scripts/interface 目录」（index.md） | 引擎解析 `<interfaces><entryScriptFile>` = `kbemain`；fork 模板在 `res/sdk_templates/.../scripts/interface/kbemain.py`；部署用 `scripts/interfaces/` 属 assets 仓（fork 外） | Fork | `kbengine_defaults.xml:234-238`；`python_app.cpp:338-342` |
| 计费订单超时 | 未提及 | `interfaces_orders_timeout_` 戳有计算但本 HEAD 无消费——无清扫逻辑 | Fork | `interfaces.cpp:721`、`serverconfig.cpp:83/:532`、`orders.h:38` |

## 7. 待取证（开放证据项）

1. **缓冲任务顺序**：实体线程化的 `executeRawDatabaseCommand`——分流
   （`dbmgr.cpp:803-810` 对 `:815-826`）已核验；`Buffered_DBTasks`
   内部顺序保证尚未钉到 file:line（`kbe/src/server/dbmgr/buffered_dbtasks.cpp`）。
2. **计费订单超时清扫**——上游是否本有驱逐路径而本 fork 缺失，或
   `timeout` 字段上游也是死字段（可达时对照上游 v3.x 线）。
3. **dbmgr → loginapp 结果中转**：`onCreateAccountCBFromInterfaces` /
   `onLoginAccountCBBFromInterfaces` 之后的细节——属 KB-API-006
   loginapp/dbmgr 范围；本文只取证 interfaces 侧半程。
