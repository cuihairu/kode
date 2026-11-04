# Baseapp 面 API 参考 —— `KBEngine` 模块

> KB-API-003 (P0) · 第 1/2 篇。源料：kbengine fork
> `docs/api/kbengine/baseapp/{KBEngine.md,Entity.md,Proxy.md,index.md}`（CHM
> 转换稿，含单词粘连/表格破损，已重写不照抄）。取证域为 `kbe/src`
>（`/home/cui/workspaces/kbengine`，HEAD `6d12b8f`，2026-11-04 于 HEAD 逐条
> 复核）；每条断言均带 `file:line` 锚点或显式 **待取证** 标注。差异小节格式
> 遵循 [python-version-baseline](python-version-baseline.md) §7。
>
> **拆分说明（依 todo KB-API-003）：** 四份源料合并后过大，拆为两篇。本篇
> 覆盖 **`KBEngine` 模块面**（模块函数、入口脚本回调、模块属性、常量）；
> **`Entity` / `Proxy` 类面**见 [api-baseapp-entity](api-baseapp-entity.md)。
> Baseapp 是持有客户端连接与 base 实体的进程，cell 工作走 cellapp，持久化
> 与计费走 dbmgr/interfaces。

## 1. 模块面的组装位置

baseapp 进程暴露的 `KBEngine` 模块由五处注册点拼装：

| 注册点 | 注册内容 |
| --- | --- |
| `kbe/src/server/baseapp/baseapp.cpp:430-451`（`Baseapp::installPyModules` 块，app 专属方法） | `time`、`createEntity`、`createEntityLocally`、`createEntityAnywhere`、`createEntityRemotely`、`createEntityFromDBID`、`createEntityAnywhereFromDBID`、`createEntityRemotelyFromDBID`、`executeRawDatabaseCommand`、`quantumPassedPercent`、`charge`、`registerReadFileDescriptor`、`registerWriteFileDescriptor`、`deregisterReadFileDescriptor`、`deregisterWriteFileDescriptor`、`reloadScript`、`isShuttingDown`、`address`、`deleteEntityByDBID`、`lookUpEntityByDBID`、`setAppFlags`、`getAppFlags` |
| `kbe/src/lib/server/entity_app.h:423-453`（`EntityApp::installPyModules`，所有 EntityApp 共享） | `kbassert`、`publish`、`scriptLogType`、`getResFullPath`、`hasRes`、`open`、`listPathRes`、`matchPath`、`getWatcher`、`getWatcherDir`、`debugTracing`；整型常量 `LOG_TYPE_*`、`NEXT_ONLY`、`SERVER_ERR_*` |
| `kbe/src/lib/pyscript/pywatcher.cpp:184-185` | `addWatcher`、`delWatcher` |
| `kbe/src/lib/pyscript/script.cpp:248,258`（`Script::install`） | `component` 字符串属性、`genUUID64` |
| `kbe/src/lib/pyscript/pyurl.cpp:23` | `urlopen` |

方法表之外安装的模块对象：`entities`
（`kbe/src/lib/server/entity_app.h:411`）、`globalData`（`:419`）、
`baseAppData`（`kbe/src/server/baseapp/baseapp.cpp:461`）、`LOG_ON_*`
整型常量（`baseapp.cpp:463-476`）；`APP_FLAGS_*` 常量经 app-flags 映射表
循环注册（`baseapp.cpp:419-424`；取值定义于
`kbe/src/lib/common/common.h:348-352`）。

## 2. 实体创建函数族

所有创建入口共享同一 params 约定：Python dict 的键用于初始化 base 属性；
命名 cell 属性的键会被路由进实体的 `cellData` dict，延迟到 cell 实体真正
创建时生效。未提供的属性取 `.def` 默认值。

### `KBEngine.createEntityLocally(entityType, params=None) -> Entity`

在**本 baseapp** 上新建 base 实体，立即返回直接实体对象——无回调、无网络
往返。需要掌管生命周期（控制 `destroy` 时机）或访问 `EntityCall` 未暴露的
属性时使用；部分 API 只接受直接引用（如 `Proxy.giveClientTo`）。
注册处将 `createEntity` 与 `createEntityLocally` 映射到同一处理函数
（`baseapp.cpp:431-432`；入口 `baseapp.cpp:959`）。

### `KBEngine.createEntity(entityType, params=None) -> Entity`

`createEntityLocally` 的别名——同一处理函数（`baseapp.cpp:431`）。

### `KBEngine.createEntityAnywhere(entityType, params=None, callback=None)`

请求 baseappmgr 挑选合适的 baseapp 创建实体；出于负载均衡优先于
`createEntityLocally`。完成后 `callback(entityCall | None)` 触发。入口
`baseapp.cpp:986`（向 baseappmgr 发 `onCreateEntityAnywhere`）；被选中的
baseapp 经接口处理函数执行（`baseapp_interface.h:116`），回调经
`onCreateEntityAnywhereCallback` 送回（`baseapp_interface.h:119`）。

### `KBEngine.createEntityRemotely(entityType, baseMB, params=None, callback=None)`

同 `createEntityAnywhere`，但固定在 `baseMB`（base `EntityCall`）所属的
baseapp 上创建。入口 `baseapp.cpp:1028`；远端路径
`baseapp_interface.h:122-125`。

### `KBEngine.createEntityFromDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

从数据库加载已归档实体，落在本 baseapp 上。若实体已被检出（checked
out），回调返回既有实体的引用。回调：`(baseRef, databaseID, wasActive)`；
失败时 `(None, 0, False)`。入口 `baseapp.cpp:1088`。

### `KBEngine.createEntityAnywhereFromDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

同上，但由 baseappmgr 选择目标 baseapp。入口 `baseapp.cpp:1440`。

### `KBEngine.createEntityRemotelyFromDBID(entityType, dbID, baseMB, callback=None, dbInterfaceName="default")`

从数据库加载，落到 `baseMB` 所属 baseapp。入口 `baseapp.cpp:1966`。

### `KBEngine.deleteEntityByDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

从数据库删除已归档实体（含属性生成的子表数据）。若实体正被检出，删除
失败且回调收到其 `entityCall`；成功则回调 `True`。入口 `baseapp.cpp:5189`。

### `KBEngine.lookUpEntityByDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

纯查询：回调收到 `True` 表示**未**被检出；被检出则收到其 `entityCall`。
入口 `baseapp.cpp:5361`。

## 3. 持久化、数据库、计费

### `KBEngine.executeRawDatabaseCommand(command, callback=None, threadID=0, dbInterfaceName="default")`

经 dbmgr 执行裸数据库命令（MySQL 即 SQL）。回调：
`(result, rows, insertid, error)`——无结果集或出错时 `result` 为 `None`；
`rows` 为受影响行数；`insertid` 类似 `mysql_insert_id()`，仅 MySQL 有意义；
`error` 仅失败时非 `None`。源料的警告成立且是结构性的：实体被检出时，后续
归档会**覆盖**直接 SQL 写入——不要用它读写实体数据。入口
`baseapp.cpp:3214`。

### `KBEngine.charge(ordersID, dbID, byteDatas, pycallback)`

计费请求转发到 interfaces 进程。`pycallback` 原型：
`(orderID, dbID, success, datas)`，interfaces 调用 `chargeResponse` 时触发。
入口 `baseapp.cpp:3435`；订单丢失/未知路径触发入口脚本回调
`onLoseChargeCB`（`baseapp.cpp:3603`）。

## 4. 时间、地址、状态等模块工具

### `KBEngine.time() -> uint32`

当前游戏时间（tick 数）；tick 长度为 `1 / gameUpdateHertz`
（`kbengine.xml` / `kbengine_defaults.xml`）。注册名是 `time`，绑定处理
函数 `__py_gametime`（`baseapp.cpp:430`，实现 `:504`）。

### `KBEngine.quantumPassedPercent() -> int`

当前 tick 已消耗的百分比（线程调度余量探针）。`baseapp.cpp:439`，
实现 `:510`。

### `KBEngine.address() -> (ip, port)`

**内部**网络接口地址，`(uint32 ip, uint32 port)` 元组（数值、网络字节
序）。实现 `baseapp.cpp:5179`。

### `KBEngine.isShuttingDown() -> bool`

关服开始后返回 True。实现 `baseapp.cpp:5173`（读
`Baseapp::isShuttingdown`）；关服状态机在
`onShutdownBegin/onShutdown/onShutdownEnd`（`baseapp.cpp:321,334,383`）。

### `KBEngine.publish() -> int8`

发布模式：0 调试、1 发布。`entity_app.h:426`（`__py_getAppPublish`）。

### `KBEngine.setAppFlags(flags)` / `KBEngine.getAppFlags() -> int`

进程标志位。HEAD 处仅两个取值：`APP_FLAGS_NONE = 0`、
`APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING = 0x1`
（`kbe/src/lib/common/common.h:348-352`）；set/get 处理函数
`baseapp.cpp:5785,5779`。用 `|` 组合。不参与负载均衡的 baseapp 向
baseappmgr 上报的负载信息不同（`onUpdateLoad` 发送 `flags_`，
`baseapp.cpp:497-511`）。

## 5. 调试 / watcher / 资源

### `KBEngine.addWatcher(path, dataType, getFunction)` / `KBEngine.delWatcher(path)`

向监控系统（GUIConsole/telnet）注册/删除 `scripts/...` 下的监视变量。
`dataType` 为基础类型字符串（如 `UINT32`）。每次采样时无参调用
`getFunction` 取值。`kbe/src/lib/pyscript/pywatcher.cpp:184-185`。

### `KBEngine.getWatcher(path) -> value` / `KBEngine.getWatcherDir(path) -> tuple`

读单个 watcher 值 / 列出 watcher 目录的条目。`entity_app.h:447,450`；
实现 `:757,896`。

### `KBEngine.debugTracing()`

输出引擎跟踪的扩展对象计数器（`FixedArray`、`FixedDict`、`Entity`、
`EntityCall` 等）。正常关服时计数非零即存在引擎封装对象的泄漏。
`entity_app.h:453` → `kbe/src/lib/pyscript/py_gc.cpp:224`
（`PyGC::__py_debugTracing`）。泄漏实体实例另见
`KBEngine.entities.garbages`——[entity-lifecycle-reference](entity-lifecycle-reference.md)。

### `KBEngine.hasRes(res) -> bool`、`KBEngine.getResFullPath(res) -> str|None`、`KBEngine.matchPath(res) -> str`、`KBEngine.listPathRes(path, extension=None) -> tuple`、`KBEngine.open(res, mode='r', encoding=None) -> file`

基于 `KBE_RES_PATH` 的资源路径工具；`matchPath`/`getResFullPath` 将相对
资源路径解析为绝对路径（`getResFullPath` 未命中返回 `None`），
`listPathRes` 按扩展名过滤（`"txt|py"` 形式的字符串或元组）。注册均在
`entity_app.h:432-443`。路径解析规则详见
[fixed-directories-and-path-resolution](fixed-directories-and-path-resolution.md)。

### `KBEngine.scriptLogType(logType)`

设置 `print` 输出使用的日志级别；`logType` 取 `LOG_TYPE_*` 常量之一。
`entity_app.h:429`（实现约 `:925-940`）。

### `KBEngine.reloadScript(fullReload=True) -> bool`

重载实体脚本模块；`fullReload=True` 时连实体定义一起重载，存活实体的
`__class__` 被替换为新类。仅限开发期使用。完成时以 `onInit(True)` 通知
（`kbe/src/lib/server/entity_app.h:1461`）。入口 `baseapp.cpp:5129` →
`Baseapp::reloadScript`（`:5148` 一带）→ 逐实体 `reload()`
（`:5165-5168`）。

## 6. 网络、HTTP、描述符

### `KBEngine.urlopen(url, callback=None, postData=None, headers=None)`

主线程外的异步 HTTP/HTTPS 请求。回调：
`(httpcode, data, headers, success, url)`；提供 `postData`（bytes）即由
GET 转 POST；`headers` 为 dict。注册 `kbe/src/lib/pyscript/pyurl.cpp:23`，
实现 `:69`（`PyUrl::__py_urlopen`）。

### `KBEngine.registerReadFileDescriptor(fileDescriptor, callback)` / `KBEngine.deregisterReadFileDescriptor(fileDescriptor)`（Write 版同名）

把裸 fd/socket 挂进引擎网络分发器：可读/可写时 `callback(fd)` 触发。
baseapp 注册 `baseapp.cpp:441-444` →
`kbe/src/lib/server/py_file_descriptor.cpp:35` 及 `:22-31`
（对 `Components` 的分发器 register/deregister）。

### `KBEngine.MemoryStream()`

3.7 源料在 baseapp 模块下列出该构造器（按引擎打包规则的二进制序列化
对象）。**baseapp 面待取证**：该构造器注册于 `PythonApp` 系工具
（`kbe/src/lib/server/python_app.cpp:271`，`PyMemoryStream::py_new`），
但 baseapp 所在的 `EntityApp::installPyModules` 链（`entity_app.h:407-453`）
无 `MemoryStream` 注册，也未找到面向 baseapp 的
`PyMemoryStream::installScript` 调用。取证路径：在 baseapp 入口脚本执行
`KBEngine.MemoryStream()` 并记录结果；在此之前该源料断言视为未证实。

## 7. `genUUID64`

### `KBEngine.genUUID64() -> uint64`

生成 64 位唯一 id：秒级时间戳 + 每秒循环的 16 位计数器
（`kbe/src/lib/common/platform.h:738-770`）。跨进程唯一性要求组件
global order 处于 1..65535，否则首次调用告警
（`kbe/src/lib/pyscript/script.cpp:96-101`，注册 `:258`）。3.7 文本把这一
前提归于 baseapp 启动参数 `gus`；HEAD 处守卫读的是
`g_componentGlobalOrder`（见差异表）。

## 8. 入口脚本回调

以下回调全部在**入口脚本模块**上触发
（`kbengine_defaults.xml -> baseapp -> entryScriptFile`；引擎经
`getEntryScript()` 解析）。

| 回调 | 触发时机 | 取证 |
| --- | --- | --- |
| `onBaseAppReady(isBootstrap)` | baseapp 加载完脚本与实体；`isBootstrap` 在首个 baseapp（group order 1）为 True | `kbe/src/server/baseapp/initprogress_handler.cpp:179-190` |
| `onInit(isReload)` | 启动时 `onDbmgrInitCompleted` 之后（`isReload=0`，`baseapp.cpp:3636-3647`）；`reloadScript` 完成后再以 `True` 触发（`entity_app.h:1461`） | 两处均已引 |
| `onReadyForLogin(isBootstrap)` | 初始化推进过程中被轮询；返回 `True`（或浮点 `>= 0.9999`）则 loginapp 放行客户端；浮点值作为初始化进度百分比上报 baseappmgr | `initprogress_handler.cpp:200-233`（`Py_True` → `v=100` 见 `:213,227`；阈值 `v >= 0.9999` 见 `:244-246`） |
| `onReadyForShutDown()` | 进程退出前；返回 `True` 允许退出，其他值稍后重新询问 | `baseapp.cpp:275-285` |
| `onBaseAppShutDown(state)` | 关服阶段：`state=0` 开始（断开客户端前，`baseapp.cpp:321-328`）、`1` 实体归档前（`:334-343`）、`2` 归档完成（`:383-390`） | 三处均已引 |
| `onFini()` | 3.7 源料称"引擎正式关服后触发"。**fork HEAD 未找到**——`kbe/src` 全库无 `onFini` 符号（client_lib/bots 只有 `onFinish`）。**待取证**：确认上游意图（可能从未在 baseapp 接线）后再依赖 | `grep -rn onFini kbe/src` = 0 命中 |
| `onCellAppDeath(addr)` | 某 cellapp 宕机（`addr = (ip, port)` 元组，数值网络字节序）；本 baseapp 自身正在关服时不触发 | `baseapp.cpp:673-700`（元组构造 `:679-684`，守卫 `:676-679`） |
| `onBaseAppData(key, value)` / `onBaseAppDataDel(key)` | `KBEngine.baseAppData` 在任一 baseapp 上被写入 / 删除 | `baseapp.cpp:3707,3688`（源自 `onBroadcastBaseAppDataChanged`） |
| `onGlobalData(key, value)` / `onGlobalDataDel(key)` | `KBEngine.globalData` 全集群写入 / 删除 | `kbe/src/lib/server/entity_app.h:1308,1290` |
| `onLoseChargeCB(orderID, dbID, success, datas)` | interfaces 应答时订单丢失或未知 | `baseapp.cpp:3603` |
| `onAutoLoadEntityCreate(entityType, dbID)` | 启动时自动加载实体（`writeToDB` 带 `shouldAutoLoad`）。若脚本实现此回调，则由脚本侧创建，替代引擎默认的 `createEntityAnywhereFromDBID`。先于 `onBaseAppReady` 执行 | `kbe/src/server/baseapp/entity_autoloader.cpp:90-97` |

## 9. 模块属性

### `KBEngine.entities`

本进程存活实体注册表（`ENTITY_ID → 强引用 PyObjectPtr`）。生命周期/垃圾
语义统一记载于
[entity-lifecycle-reference](entity-lifecycle-reference.md)；安装位置
`kbe/src/lib/server/entity_app.h:411`。

### `KBEngine.baseAppData`

**跨所有 baseapp 复制**的 dict 型对象。顶层赋值向全部 baseapp 广播；修改
值内部**不会**广播（源料的 `[1,2,3]` vs `[1,7,3]` 陷阱成立）。键值须经
引擎序列化。写入在所有进程触发 `onBaseAppData` / `onBaseAppDataDel`。
安装 `baseapp.cpp:461`
（`GlobalDataClient(DBMGR_TYPE, GlobalDataServer::BASEAPP_DATA)`，`:457`）；
变更接收 `baseapp.cpp:3654+`。

### `KBEngine.globalData`

契约同 `baseAppData`，但复制范围是 **baseapp + cellapp**；变更触发
`onGlobalData` / `onGlobalDataDel`。`kbe/src/lib/server/entity_app.h:419`，
回调 `:1308,1290`。

### `KBEngine.component`

只读字符串，标明当前运行的组件类型——本进程为 `'baseapp'`。
`kbe/src/lib/pyscript/script.cpp:248`。

## 10. 常量

| 常量 | 含义 | 取证 |
| --- | --- | --- |
| `LOG_TYPE_NORMAL / INFO / ERR / DBG / WAR` | `scriptLogType` 的日志级别 | `entity_app.h:455-478` |
| `NEXT_ONLY` | `shouldAutoArchive` / `shouldAutoBackup` 的单次哨兵：下一调度周期执行一次后自动置 False | `entity_app.h:480` |
| `LOG_ON_ACCEPT / LOG_ON_REJECT / LOG_ON_WAIT_FOR_DESTROY` | `Proxy.onLogOnAttempt` 的返回值；取值 1/0/2 | `baseapp.cpp:463-476`；枚举 `kbe/src/server/baseapp/proxy.h:24-26`；解释处 `baseapp.cpp:3919-3962` |
| `APP_FLAGS_NONE`、`APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING` | `setAppFlags` 的进程标志 | `baseapp.cpp:419-424`；`common.h:348-352` |

## 3.7 源料 vs fork 3.12 差异

| 条目 | 官方 3.7 源料说法 | fork 3.12 实际行为 | 域 | 证据 |
| --- | --- | --- | --- | --- |
| `onFini` | 引擎正式关服后触发 | HEAD 无此挂钩；全库只有 client_lib/bots 的 `onFinish` | Fork | `grep -rn onFini kbe/src` = 0 命中；`server/tools/bots/bots.cpp:125`（`onFinish`） |
| `onReadyForLogin` 返回值 | 返回 ≥ 1.0 即就绪 | `True` → 就绪（v=100）；数值返回与 `0.9999` 比较（非 1.0），且数值本身作为进度百分比上报 | Fork | `initprogress_handler.cpp:213-246` |
| `genUUID64` 唯一性来源 | 依赖 baseapp 启动参数 `gus` | 守卫检查 `g_componentGlobalOrder` ∈ 1..65535（仅告警一次）；id = 时间戳 + 每秒计数器 | Fork | `lib/pyscript/script.cpp:91-108`；`lib/common/platform.h:738-770` |
| baseapp 上的 `KBEngine.MemoryStream()` | 列为 baseapp 模块构造器 | `EntityApp` 链无注册；仅 `PythonApp` 系工具注册——运行时**待取证** | Fork | `lib/server/python_app.cpp:271` 存在；`entity_app.h:407-453` 不存在 |
| `baseAppData` 删除回调名 | 属性正文写 "See: KBEngine.onBaseAppData and KBEngine.onDelBaseAppData" | 注册的回调名是 `onBaseAppDataDel`——源料的 `onDelBaseAppData` 不存在 | Fork | `baseapp.cpp:3688` |
| `roundTripTime` 仅 Linux 生效的说法 | "only takes effect under Linux" | 未能证实/证伪 | — | **待取证**：核对 `Proxy::pyGetRoundTripTime`（`proxy.cpp:445`）与预处理器守卫后再归类 |
| 本面的 3.7→3.12 脚本层差异 | — | 本面不触及 3.8–3.12 变更的 str/bytes/int 语义；python-version-baseline §4 已验证项按引用适用 | Python | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)；见 python-version-baseline §4 |

## References

- 注册面：`kbe/src/server/baseapp/baseapp.cpp:419-476,504-519`、
  `kbe/src/lib/server/entity_app.h:407-487`、
  `kbe/src/lib/pyscript/{pywatcher.cpp:184-185, script.cpp:248,258,
  pyurl.cpp:23, py_gc.cpp:224}`、
  `kbe/src/lib/server/{py_file_descriptor.cpp:22-35, python_app.cpp:271}`
- 回调：`kbe/src/server/baseapp/{initprogress_handler.cpp:179-241,
  entity_autoloader.cpp:90-97, baseapp.cpp:275-285,321-390,3595-3610,
  3636-3647,3688-3710,673-700}`、`kbe/src/lib/server/entity_app.h:1290,1308,1461`
- Python 域：[What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)
- 关联篇目：[api-baseapp-entity](api-baseapp-entity.md)、
  [python-version-baseline](python-version-baseline.md)、
  [entity-lifecycle-reference](entity-lifecycle-reference.md)、
  [fixed-directories-and-path-resolution](fixed-directories-and-path-resolution.md)
