# Baseapp 面 API 参考 —— `Entity` 与 `Proxy`

> KB-API-003 (P0) · 第 2/2 篇。源料：kbengine fork
> `docs/api/kbengine/baseapp/{Entity.md,Proxy.md,KBEngine.md,index.md}`
> （CHM 转换稿，已重写不照抄）。取证域为 `kbe/src`
>（`/home/cui/workspaces/kbengine`，HEAD `6d12b8f`，2026-11-04 于 HEAD 逐条
> 复核）；每条断言均带 `file:line` 锚点或显式 **待取证** 标注。差异小节格式
> 遵循 [python-version-baseline](python-version-baseline.md) §7。
>
> **拆分说明（依 todo KB-API-003）：** 模块面见
> [api-baseapp](api-baseapp.md)；本篇覆盖 baseapp 进程暴露的两个实体类：
> `Entity`（base 实体）与其挂接客户端的子类 `Proxy`。`Proxy` 不能由脚本
> 直接实例化——它在 loginapp/dbmgr 把客户端移交 baseapp 时由引擎创建
>（`kbe/src/server/baseapp/proxy.cpp:43-59`：构造器递增进程 proxy 计数
>（`:56`）并构建转发器（`:58`））。

## 1. 两个类面的注册位置

| 类 | 方法表 | 属性表 |
| --- | --- | --- |
| `Entity` | `kbe/src/server/baseapp/entity.cpp:26-30`（`createCellEntity`、`createCellEntityInNewSpace`、`destroyCellEntity`）**加上**共享基块 `kbe/src/lib/entitydef/entity_macro.h:17-24`（`addTimer`、`delTimer`、`writeToDB`、`destroy`、`registerEvent`、`deregisterEvent`、`fireEvent`、`getComponent`） | `entity.cpp:35-41`（`cell`、`client`、`databaseID`、`databaseInterfaceName`、`shouldAutoBackup`、`shouldAutoArchive`）加 `entity_macro.h:33-35`（`id`、`isDestroyed`、`className`） |
| `Proxy` | `kbe/src/server/baseapp/proxy.cpp:21-28`（`giveClientTo`、`getClientType`、`getClientDatas`、`streamStringToClient`、`streamFileToClient`、`disconnect`） | `proxy.cpp:33-39`（`roundTripTime`、`timeSinceHeardFromClient`、`clientAddr`、`hasClient`、`clientEnabled`） |

两个类型均由 `Baseapp::installPyModules` 安装
（`baseapp.cpp:408-409` 调 `Entity::installScript()` / `Proxy::installScript()`——`registerScript` 在 `:414-415`）。

## 2. `Entity` —— 定时器

### `entity.addTimer(initialOffset, repeatOffset=0, userArg=0) -> int`

注册定时器：`initialOffset` 秒后首次触发，之后每 `repeatOffset` 秒一次
（repeat `<= 0` 表示只触发一次）。每次触发调用
`entity.onTimer(timerID, userArg)`；`userArg` 必须为整数。返回供
`delTimer` 使用的定时器 id。共享实现：`entity_macro.h:1387`
（`CLASS::pyAddTimer` → `ScriptTimersUtil::addTimer`，`:1391`）。

### `entity.delTimer(id)`

移除定时器（字符串 `"All"` 移除全部）。单次定时器自动移除——对已移除的
id 调用会报错。`entity_macro.h:18`，实现 `:1407`；无效 id 路径 `:1478`
（`ScriptTimersUtil::delTimer` 返回 false → 报错）。

### `entity.onTimer(timerHandle, userData)` *（回调）*

定时器回调；必须定义在 base 部分。由 `Entity::onTimer` 触发
（`kbe/src/server/baseapp/entity.cpp:1658-1662`）。

## 3. `Entity` —— cell 管理

### `entity.createCellEntity(cellEntityCall)`

请求 cellapp 在 `cellEntityCall` 所在 space 创建本实体的 cell 部分
（必须传**直接** cell EntityCall——不能跨 base 引用传
`someBaseRef.cell`；须经携带直接调用的 base 方法中转）。创建信息取自
`cellData`（`.def` 默认值 + `position/direction/spaceID`）。实现
`entity.cpp:1416`；类型检查 `:1435-1439`（参数必须是直接
`ENTITYCALL_TYPE_CELL` 调用）→ `Baseapp::createCellEntity`
（`:1464`）。失败触发 `onCreateCellFailure`。

### `entity.createCellEntityInNewSpace(cellappIndex=None)`

（经 cellappmgr）新建 space 并把本实体的 cell 放入其中。
`cellappIndex=None/0` → 引擎负载均衡器选 cellapp；`>0` 指定 cellapp 序号
（索引溢出回绕：3 个存活 cellapp 时，索引 4 → cellapp 1）。与
`KBEngine.APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING` 组合可将大地图固定
在指定 cellapp。方法表 `entity.cpp:28`，实现 `:1487-1508` →
`Baseapp::createCellEntityInNewSpace`（`:1507`）。

### `entity.destroyCellEntity()`

请求销毁 cell 部分；无 cell 时报错。方法表 `entity.cpp:29`，入口
`entity.cpp:593`（`pyDestroyCellEntity`），cellapp 消息 `:586`
（`CellappInterface::onDestroyCellEntityFromBaseapp`）。

### `entity.cell` *（只读属性）*

cell 部分的 `EntityCall`；尚无 cell 时为 `None`。getter
`entity.cpp:750`（`pyGetCellEntityCall`），方法表 `:36`。

### `entity.cellData` *（dict 属性）*

cell 未创建期间暂存 cell 属性（`.def` 默认值加 `position`、`direction`、
`spaceID`）；cell 实体创建后该 dict 被消费（删除）。以真实实例属性形式
安装：`PyObject_SetAttrString(this, "cellData", ...)`——
`entity.cpp:238-241`（`installCellDataAttr`），dict 生命周期 `:221-236`。

## 4. `Entity` —— 销毁与持久化

### `entity.destroy(deleteFromDB=False, writeToDB=True)`

销毁 base 部分。若 cell 部分尚存必须先 `destroyCellEntity`；cell 仍在
创建中时销毁被**推迟**到 `onGetCell` 之后（`entity.cpp:641` 告警）。
`deleteFromDB=True` 删除数据库记录；`writeToDB=True`（默认）在拆除前
归档，`deleteFromDB=True` 时被忽略。支持关键字或位置参数
（`METH_VARARGS | METH_KEYWORDS`，`entity_macro.h:20`；解析
`entity.cpp:663-676`；拆除 `Entity::onDestroyEntity`
`entity.cpp:698-731`）。销毁后的对象引用语义（garbages、强引用）统一
记载于 [entity-lifecycle-reference](entity-lifecycle-reference.md)。

### `entity.onDestroy()` *（回调）*

base 部分真正销毁之后触发。`entity.cpp:164-169`。

### `entity.writeToDB(callback=None, shouldAutoLoad=False, dbInterfaceName="default")`

把实体归档进数据库。dbmgr 写入完成后触发
`callback(success, baseEntity)`（`onWriteToDBCallback`，
`entity.cpp:1239-1290`）。`shouldAutoLoad=True` 把记录标记为开服自动加载
（届时走 `onAutoLoadEntityCreate` / `createEntityAnywhereFromDBID`——见
[api-baseapp](api-baseapp.md) §8）。核心写路径 `Entity::writeToDB`
`entity.cpp:1141-1185`；脚本入口 `entity_macro.h:19,832`。

### `entity.onPreArchive() -> bool` *（回调）*

归档写入前调用；返回 False 中止本次写入，返回 True（或未实现该回调）则
继续。在 `Entity::onCellWriteToDBCompleted` 内、写入前触发——
`entity.cpp:1294-1305`。

### `entity.onWriteToDB(cellData)` *（回调）*

实体数据即将写入数据库时触发；`cellData` 为将入库的 dict。在此回调内再
调 `writeToDB` 会无限循环。`entity.cpp:1397-1405`。

### `entity.databaseID` *（只读，uint64）*

永久 id；0 表示从未归档。getter `entity.cpp:769`（`pyGetDBID`）。

### `entity.databaseInterfaceName` *（只读，str）*

本实体持久化所经的 dbmgr 接口名；`databaseID == 0` 时为空串。getter
`entity.cpp:783`，方法表 `:38`。

### `entity.shouldAutoArchive` / `entity.shouldAutoBackup` *（可读写）*

自动归档 / 自动备份策略：`True`、`False` 或 `KBEngine.NEXT_ONLY`
（下一调度周期执行一次后自动翻转为 False）。归档器周期性按这些标志扫描
实体——`kbe/src/server/baseapp/archiver.cpp`（扫描定时器；标志处理见
getter/setter `entity.cpp:842-899`，方法表 `entity.cpp:40-41`）。

## 5. `Entity` —— 身份与恢复

### `entity.id` *（只读，int32）*、`entity.className` *（只读，str）*、`entity.isDestroyed` *（bool）*

共享实体 id（base/cell/client 三侧一致）、类名、已销毁标志。来自共享宏：
`entity_macro.h:33-35`（方法表），getter `:689`（`pyGetID`）、`:1491`
（`pyGetIsDestroyed`）、`:1496`（`pyGetClassName`）。

### `entity.onRestore()` *（回调）*

原 baseapp 崩溃后本实体在别的 baseapp 上重建（备份/恢复流程，处理器见
`kbe/src/server/baseapp/restore_entity_handler.cpp`）时触发。
`entity.cpp:1077-1083`。

### `entity.onGetCell()` / `entity.onLoseCell()` *（回调）*

cell 部分挂接（`onGetCell`，`entity.cpp:1014-1032`；自动销毁兜底
`:1037`）/ cell 部分卸下（`onLoseCell`，`entity.cpp:1052-1065`；自动销毁
兜底 `:1069`）。源料的建议成立：在 `onLoseCell` 里 `self.destroy()` 是
拆除 base 部分的可靠时机。

### `entity.onCreateCellFailure()` *（回调）*

cell 创建请求失败。`entity.cpp:877-884`。

### `entity.client` *（只读属性）*

挂接客户端的 `EntityCall`；无客户端绑定时为 `None`。base `Entity` 上该
getter 存在（`entity.cpp:800`，方法表 `:37`），但只有 `Proxy` 携带的客户端
才会填充它（见 §7）。

## 6. `Entity` —— 事件总线与组件

### `entity.fireEvent(eventName, *args)` / `entity.registerEvent(eventName, callback)` / `entity.deregisterEvent(eventName, callback)`

实体级事件分发（引擎事件与用户事件）。`entity_macro.h:21-23`（方法表），
实现 `:1126`（`pyRegisterEvent`）、`:1162`（`pyDeregisterEvent`）、`:1198`
（`pyFireEvent`）。

### `entity.getComponent(componentName, all=False)`

返回挂接在实体上的指定类型组件实例；`all=True` 返回全部实例，否则返回
第一个（或空）。`entity_macro.h:24,1276-1355`（`pyGetComponent`；`all`
由布尔 kwarg 解析 `:1354`）。

## 7. `Proxy` —— 面向客户端的子类

`Proxy` 继承 `Entity`（`proxy.cpp:43-45`），是客户端连接在服务器侧的
锚点：loginapp/dbmgr 在目标 baseapp 上创建它，服务器→客户端的全部流量
经其转发器（`proxy.cpp:56-58`、`kbe/src/server/baseapp/proxy_forwarder.h`）。

### `proxy.giveClientTo(otherProxy)`

把客户端控制权移交给同一 baseapp 上的另一个 Proxy。前置条件在
`proxy.cpp:311-380` 强制：当前 proxy 存活且持有客户端（`:328-331`）、目标
存活（`:342-347`）、不能是自身（`:354-359`）、目标无客户端（`:366-373`）；
任一违反即触发 `onGiveClientToFailure` 而非抛异常。脚本入口 `:274-299`
（`pyGiveClientTo`，类型检查错误 `:287`）；方法表 `:22`。这是"必须持有
直接实体引用而非 `EntityCall`"的典型场景。

### `proxy.onGiveClientToFailure()` *（回调）*

`proxy.cpp:304-307`。

### `proxy.onClientEnabled()` *（回调）*

实体完全可用、可与客户端通信；`giveClientTo` 移交控制权后也会触发。
`proxy.cpp:174-178`。

### `proxy.onClientDeath()` *（回调）*

客户端断开；通常在此销毁 proxy 账号实体。`proxy.cpp:217-237`。

### `proxy.onClientGetCell()` *（回调）*

客户端获得实体 `cell` 属性访问权时触发。`proxy.cpp:241-248`。

### `proxy.onLogOnAttempt(ip, port, password) -> int` *（回调）*

第二个客户端试图绑定本（已在内存中的）账号实体——典型顶号场景。返回
`KBEngine.LOG_ON_ACCEPT`（踢掉旧客户端、绑新客户端）、`LOG_ON_REJECT`
（维持当前绑定）或 `LOG_ON_WAIT_FOR_DESTROY`（新登录排队至本实体销毁——
先在回调内调 `destroy`/`destroyCellEntity`）。引擎侧：`proxy.cpp:182-205`
（脚本调用 `:189`），返回值在 `baseapp.cpp:3919-3962` 解释
（`LOG_ON_ACCEPT` 踢人 `:3926-3933`，wait-for-destroy `:3960`）。注意头
文件级常量为 `0/1/2`（`proxy.h:24-26`），模块级再导出见
`baseapp.cpp:463-476`。

### `proxy.disconnect()`

断开绑定的客户端：将客户端 channel 标记为 condemn。
`proxy.cpp:70-78`（`pyDisconnect`），方法表 `:27`。

### `proxy.getClientType() -> int`

客户端类型枚举：0 未知、1 手机、2 Windows、3 Linux、4 Mac、5 浏览器、
6 bots、7 mini、8 end。`proxy.cpp:252`；由登录元数据写入
（`pEntity->setClientType(...)`，`baseapp.cpp:4165`）。

### `proxy.getClientDatas() -> (bytes, bytes)`

客户端**登录**与**注册**时附带的透传 bytes（经 interfaces 进程转发给第
三方账号系统）。`proxy.cpp:258`；账号实体创建时写入
（`setLoginDatas/setCreateDatas`，`baseapp.cpp:4166-4167`）。

### `proxy.streamStringToClient(data, desc="", id=-1) -> id` / `proxy.streamFileToClient(resourceName, desc="", id=-1) -> id`

向绑定的客户端推送字符串 / 资源文件，发送在工作线程进行（不阻塞主线程）。
`id` 为调用方自定的 16 位标识，`-1` → 引擎分配；完成时触发
`onStreamComplete(id, success)`。方法表 `:25-26`；实现 `:649`（字符串）、
`:560`（文件）；下载队列在 `kbe/src/server/baseapp/data_downloads.h`；
完成回调 `proxy.cpp:829-832`。

### `proxy.onStreamComplete(id, success)` *（回调）*

`proxy.cpp:829-832`。

### Proxy 属性（`proxy.cpp:33-39`）

| 属性 | 含义 | getter |
| --- | --- | --- |
| `clientAddr` | 绑定客户端的 `(ip, port)` 元组 | `proxy.cpp:512` |
| `hasClient` | 当前是否有客户端绑定 | `proxy.cpp:493` |
| `clientEnabled` | `onClientEnabled` 已触发；脚本可与客户端通信 | `proxy.cpp:541` |
| `roundTripTime` | 一段时间窗口内到客户端的平均 RTT | `proxy.cpp:445`（源料"仅 Linux 生效"的说法**待取证**——getter 处未见预处理器守卫） |
| `timeSinceHeardFromClient` | 距最近一次收到客户端包的秒数 | `proxy.cpp:469` |

### `__ACCOUNT_NAME__` / `__ACCOUNT_PASSWORD__`

3.7 源料将二者列为 Proxy 只读属性。fork HEAD 处它们**不是** Proxy
getset：而是在登录时以 dict 条目形式注入账号实体的初始化数据
（`baseapp.cpp:4174-4178`——`__ACCOUNT_PASSWORD__` 为所供密码的 MD5
摘要），脚本按账号实体的实体 dict 成员读取，与
`lib/entitydef/common.h:142-143` 呼应。见差异表。

## 3.7 源料 vs fork 3.12 差异

| 条目 | 官方 3.7 源料说法 | fork 3.12 实际行为 | 域 | 证据 |
| --- | --- | --- | --- | --- |
| `Proxy.__ACCOUNT_NAME__` / `__ACCOUNT_PASSWORD__` | Proxy 只读属性 | 非 Proxy getset；登录时注入账号实体初始化 dict（`__ACCOUNT_PASSWORD__` 为 MD5 摘要） | Fork | `baseapp.cpp:4174-4178`；`proxy.cpp:33-39`（getset 表无此二者）；`lib/entitydef/common.h:142-143` |
| `onLogOnAttempt` 常量 | 文档只描述模块常量 | 常量既在模块级（`LOG_ON_*` 整数 1/0/2）也在头文件宏；脚本返回值在 `loginBaseapp` 中 switch 分派 | Fork | `proxy.h:24-26`；`baseapp.cpp:463-476,3919-3962` |
| cell 存活时的 `Entity.destroy` | "产生错误" | cell 创建中销毁**推迟**并告警至 `onGetCell`，并非立即报错 | Fork | `entity.cpp:641`（告警）、`:598-691` |
| `roundTripTime` 平台说法 | "仅 Linux 生效" | HEAD 未证实——getter 无平台守卫 | — | **待取证**：审计 `proxy.cpp:445-468` 及其数据来源路径 |
| `writeToDB` 自动加载默认创建方式 | 引擎默认 `createEntityAnywhereFromDBID` | HEAD 行为一致；脚本可经 `onAutoLoadEntityCreate` 覆盖 | Fork | `entity_autoloader.cpp:90-97` |
| 本面的 3.7→3.12 脚本层差异 | — | 本面是签名/kwarg 管线（`METH_VARARGS|METH_KEYWORDS`），未暴露 3.8–3.12 变更的 str/bytes/int 语义；python-version-baseline §4 已验证项按引用适用 | Python | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)；见 python-version-baseline §4 |

## References

- `kbe/src/server/baseapp/{entity.cpp, entity.h, proxy.cpp, proxy.h,
  proxy.inl, archiver.cpp, data_downloads.h, restore_entity_handler.cpp,
  baseapp.cpp:413-416,4163-4178,3919-3962}`
- `kbe/src/lib/entitydef/entity_macro.h:17-35,689,832,1035,1126-1198,
  1276-1355,1387-1478,1491-1496`
- `kbe/src/lib/entitydef/common.h:142-143`
- Python 域：[What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)
- 关联篇目：[api-baseapp](api-baseapp.md)、
  [entity-lifecycle-reference](entity-lifecycle-reference.md)、
  [python-version-baseline](python-version-baseline.md)
