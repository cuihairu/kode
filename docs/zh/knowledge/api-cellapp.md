# Cellapp 面 API 参考（KB-API-004）

> 断言与引用完全一致；行号漂移核对以 EN 篇为准。
>
> **范围**：**cellapp** 进程注册的 Python API 面——`KBEngine` 模块面与
> 该进程上的 `Entity` 类。重写自官方 3.7 口径 CHM 转换源料
> （`kbengine/docs/api/kbengine/cellapp/Entity.md`，50 个 `def` 节；
> `KBEngine.md`，42 个 `def` 节；`index.md`）——源料措辞不照抄
> （chm 转换粘连如 `ThisKBEngine`、表格破损），以下全部行为断言均对
> fork 源码重新取证。
>
> **Grounding**：fork `kbe/src`，HEAD `6d12b8f`（grounding 基线 `c2a3b8f`）。
> 版本口径与偏离标注格式依
> [Python 版本口径](python-version-baseline.md)（§12 用其 §7 模板）。姊妹篇：
> [Entity 生命周期与引用释放](entity-lifecycle-reference.md)（destroy 守卫、
> timer 释放流程）、[Fixed 目录与路径解析](fixed-directories-and-path-resolution.md)
>（`KBE_RES_PATH` 约束的资源函数）。
>
> **覆盖**：源料 121 个文档条目全覆盖——Entity 29 个成员函数 + 21 个回调 +
> 17 个文档属性（摘要表 16 行；`isOnGround` 在属性正文有述但摘要表漏列，
> 见 §12），KBEngine 模块 33 个函数 + 9 个回调 + 12 个属性。

## 1. cellapp Python 面的组装方式

cellapp 脚本面不是单一注册点，而是四层。回答「这个 API 在 cellapp 上真的
存在吗」按此顺序查：

| 层 | 注册内容 | 证据 |
| --- | --- | --- |
| cellapp 专属 `Entity` 方法 | `setViewRadius`, `getViewRadius`, `getViewHystArea`, `isReal`, `addProximity`, `addYawRotator`, `clientEntity`, `cancelController`, `canNavigate`, `navigatePathPoints`, `navigate`, `getRandomPoints`, `moveToPoint`, `moveToEntity`, `accelerate`, `entitiesInRange`, `entitiesInView`, `teleport`, `destroySpace`, `debugView`, `getWitnesses` | `kbe/src/server/cellapp/entity.cpp:46-68`（`ENTITY_METHOD_DECLARE_BEGIN(Cellapp, Entity)`） |
| 共享实体方法（baseapp+cellapp） | `addTimer`, `delTimer`, `writeToDB`, `destroy`, `registerEvent`, `deregisterEvent`, `fireEvent`, `getComponent`；getset `id`, `isDestroyed`, `className` | `kbe/src/lib/entitydef/entity_macro.h:12-40`（宏块拼入同一张表） |
| cellapp `KBEngine` 模块函数 | `time`, `createEntity`, `executeRawDatabaseCommand`, `reloadScript`, `registerReadFileDescriptor`/`Write`（+`deregister…`）, `addSpaceGeometryMapping`, `getSpaceGeometryMapping`, `setSpaceData`, `getSpaceData`, `delSpaceData`, `isShuttingDown`, `address`, `raycast`, `setAppFlags`, `getAppFlags` | `kbe/src/server/cellapp/cellapp.cpp:172-189`；另有 `cellAppData` 对象于 `cellapp.cpp:199` |
| 共享 server-app 模块面 | `kbassert`（私有）, `publish`, `scriptLogType`, `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath`, `getWatcher`, `getWatcherDir`, `debugTracing`, `globalData` 对象 | `kbe/src/lib/server/entity_app.h:423-453`；`:418-419`（`globalData` 注册） |
| 解释器层（所有 app 共用） | `MemoryStream`（`python_app.cpp:271`）、`NEXT_ONLY` 常量（`:323`）、模块级 `addTimer`/`delTimer`（`:329-330`）、`component` 字符串（`lib/pyscript/script.cpp:248`）、`genUUID64`（`:258`）、`addWatcher`/`delWatcher`（`lib/pyscript/pywatcher.cpp:184-185`）、`urlopen`（`lib/pyscript/pyurl.cpp:23`） | 如引 |

cellapp `Entity` 的**属性**面：`base`, `client`, `allClients`,
`otherClients`, `isWitnessed`, `hasWitness`, `isOnGround`, `spaceID`
（只读）；`layer`, `position`, `direction`, `topSpeed`, `topSpeedY`,
`controlledBy`, `volatileInfo`（可读可写）——
`server/cellapp/entity.cpp:71-88`。

实体**组件**在 cellapp 上另有较小的一张面：`addTimer`, `delTimer`,
`clientEntity` 加 `ownerID`/`owner`/`name`/`className`/`isDestroyed`/
`base`/`client`/`allClients`/`otherClients` getset——
`server/cellapp/entity_component.cpp:10-27`。任务核验锚
`addTimer = cellapp/entity_component.cpp:12` 指的是组件面；主实体的
`addTimer` 来自共享宏（§5）。

## 2. KBEngine 模块函数（cellapp 面）

源料 33 个函数全覆盖，标注实际提供它们的注册层。「层」取值：**cell** =
`cellapp.cpp:172-189`，**shared** = `entity_app.h:423-453` /
`python_app.cpp`，**interp** = `lib/pyscript`（公共安装路径，
`script.cpp:197-289`）。

| 函数 | 层 | fork 取证的语义 |
| --- | --- | --- |
| `time()` | cell `cellapp.cpp:172` | 游戏tick计数；tick 长度由 `gameUpdateHertz` 配置决定 |
| `createEntity(entityType, spaceID, position, direction, params)` | cell `cellapp.cpp:173`，实现 `:471-533` | 在**本 cellapp 已存在**的空间里创建 cell 本地实体。失败抛 `TypeError`：`entityType` 为空（`:488`）、本进程找不到 `spaceID`（`:496`）、正在关服（`:503`）；参数形状错误（`:480`）。返回实体对象；实现内注（`:521-527`）说明：实体若在 `addEntityAndEnterWorld` 中被销毁，仍会返回给脚本且 `isDestroyed = true` |
| `executeRawDatabaseCommand(command, callback, threadID, dbInterfaceName)` | cell `cellapp.cpp:174`，实现 `:536+` | 经 dbmgr 执行原始 DB 命令；回调签名 `(result, rows, insertid, error)`；与 baseapp 面同样的覆写风险告警 |
| `reloadScript(fullReload)` | cell `cellapp.cpp:175` | 重载实体脚本；完成后触发 `KBEngine.onInit(True)`；仅限开发模式 |
| `registerReadFileDescriptor` / `registerWriteFileDescriptor` / `deregisterReadFileDescriptor` / `deregisterWriteFileDescriptor` | cell `cellapp.cpp:176-179` | FD 回调；共享实现 `lib/server/py_file_descriptor.cpp` |
| `addSpaceGeometryMapping(spaceID, mapper, path, shouldLoadOnServer, params)` | cell `cellapp.cpp:180` → `SpaceMemory::__py_AddSpaceGeometryMapping` | 为空间绑定 navmesh/几何；`params` 做 layer→navmesh 映射；完成回调见 §3 |
| `getSpaceGeometryMapping(spaceID)` | cell `cellapp.cpp:181` | 查询空间当前绑定名 |
| `setSpaceData` / `getSpaceData` / `delSpaceData` | cell `cellapp.cpp:182-184` | 空间键值字符串；变更广播 → 回调 `onSpaceData`（§3） |
| `isShuttingDown()` | cell `cellapp.cpp:185` | 关服状态；`createEntity` 内部也检查（`cellapp.cpp:505-508`） |
| `address()` | cell `cellapp.cpp:186` | 内网接口地址 |
| `raycast(spaceID, layer, src, dst)` | cell `cellapp.cpp:187`，实现 `cellapp.cpp:2158` | 几何射线；要求空间已 `addSpaceGeometryMapping` 装载几何 |
| `setAppFlags` / `getAppFlags` | cell `cellapp.cpp:188-189` | 例如退出负载均衡 |
| `publish()` | shared `entity_app.h:426` | 0 debug / 1 release |
| `scriptLogType(logType)` | shared `entity_app.h:429` | 设定 `print` 映射的日志类型（`LOG_TYPE_*`） |
| `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath` | shared `entity_app.h:432-444` | 资源访问限定在 `KBE_RES_PATH`——见 [fixed 目录篇](fixed-directories-and-path-resolution.md) |
| `getWatcher`, `getWatcherDir` | shared `entity_app.h:447-450` | 读 Watcher 树 |
| `debugTracing()` | shared `entity_app.h:453` | PyGC 扩展对象泄漏计数 |
| `genUUID64()` | interp `script.cpp:258`，实现 `:91-106` | 64 位 UUID；进程 global order 不在 0~65535 时**发运行时警告**（`script.cpp:99`），跨进程唯一性退化为进程内唯一 |
| `addWatcher(path, dataType, getFunction)` / `delWatcher(path)` | interp `pywatcher.cpp:184-185` | 注册/删除观察变量 |
| `urlopen(url, callback, postData, headers)` | interp `pyurl.cpp:23`，实现 `:69+` | 异步 HTTP(S)；headers/postData/callback 不合法抛 `AssertionError`（`pyurl.cpp:98`, `:116`, `:162`, `:174`） |
| `MemoryStream()` | interp `python_app.cpp:271` | KBEngine 序列化字节缓冲 |
| `createSpace` | — | **不存在**：cellapp 源料未记载，fork 也没有 cellapp 侧 `createSpace` 注册（grep `server/cellapp/` + `lib/server/` = 0 命中）。空间创建走 baseapp→cellappmgr 路径（`Cellapp::onCreateCellEntityInNewSpaceFromBaseapp` 处理随后的实体创建，`cellapp.cpp:875`） |

源料中他处交代的函数：源料引言提到 `KBEngine.createCellEntity`——那是
**baseapp** 面（KB-API-003 范围），cellapp 未注册。

## 3. KBEngine 模块回调（cellapp 面）

| 回调 | 触发点（已取证） |
| --- | --- |
| `onInit(isReload)` | 入口脚本，全部脚本加载后（`initprogress_handler.cpp:132-143`；首次调用传 `0`；`reloadScript` 触发 reload 调用） |
| `onReadyForLogin(isBootstrap)` | cellapp 初始化进度轮询（`initprogress_handler.cpp:153-160`）。返回契约，fork 取证：返回 `True` → 就绪（`:163`、`:177`）；否则取浮点值，`>= 0.9999` 视为完成（`:194-196`）；未定义该回调 → 立即完成（`:184-191`）。源料「≥ 1.0」接近但 fork 阈值是 0.9999（§12） |
| `onCellAppData(key, value)` | `Cellapp::onBroadcastCellAppDataChanged` 中远端写入成功后（`cellapp.cpp:864`） |
| `onCellAppDataDel(key)` | 同路径远端删除成功后（`cellapp.cpp:844`） |
| `onGlobalData(key, value)` | `EntityApp::onBroadcastGlobalDataChanged`（`lib/server/entity_app.h:1308`）——baseapp+cellapp 共用 |
| `onGlobalDataDel(key)` | 同文件 `entity_app.h:1290` |
| `onSpaceData(spaceID, key, value)` | `SpaceMemory::onSpaceDataChanged`——set 与 del 都派发到此，删除时 value 为空串（`spacememory.cpp:607-619`） |
| `onSpaceGeometryLoaded(spaceID, mapping)` | 单空间几何装载完成（`spacememory.cpp:308`） |
| `onAllSpaceGeometryLoaded(spaceID, isBootstrap, mapping)` | 该空间全部 cell 的几何完成（`spacememory.cpp:336`）；`isBootstrap` 标记发起 cell |

源料关于入口脚本位置的说明（onCellAppData/onGlobalData/onInit/
onReadyForLogin 必须写在 `entryScriptFile` 模块）与实现一致：以上派发全部
调用 `getEntryScript()`/`getEntryScript().get()`，不是实体。

## 4. KBEngine 模块属性（cellapp 面）

| 属性 | 类型 | 注册 / 语义 |
| --- | --- | --- |
| `entities` | `Entities` | `entity_app.h:410-411`——本进程全部实体**含 ghost**；`.garbages` 泄漏排查见[实体生命周期篇](entity-lifecycle-reference.md) |
| `globalData` | `GlobalDataClient` | `entity_app.h:418-419`——dict 式，向所有 baseapp+cellapp 复制（服务端锚在 dbmgr；cellapp 构造 `GlobalDataClient(DBMGR_TYPE, …)`） |
| `cellAppData` | dict 式 | `cellapp.cpp:199`（`pCellAppData_`）——跨 cellapp 复制 |
| `component` | string | `script.cpp:248`——本进程为 `'cellapp'` |
| `LOG_TYPE_DBG/INFO/NORMAL/WAR/ERR` | int | `scriptLogType` 的日志级别 |
| `NEXT_ONLY` | int | 定义为 `KBE_NEXT_ONLY`（`python_app.cpp:323`）；cellapp 无消费者——与源料「当前未用」一致 |

两个复制字典**只在显式顶层 set/delete 时广播**：远端派发路径是
`onBroadcastCellAppDataChanged`（`cellapp.cpp:830-872`）与
`onBroadcastGlobalDataChanged`（`entity_app.h:1280-1314`）；对已存 list 的
原地修改不会到达这些调用点，因此永不广播——源料
`cellAppData["list"][1] = 7` 的警告在本 fork 结构上成立。

## 5. Entity 定时器（`addTimer`/`delTimer`/`onTimer`）

- 注册：共享宏 `entity_macro.h:16-17`（主实体）与
  `server/cellapp/entity_component.cpp:12-13`（组件面）。
- `Entity::pyAddTimer(interval, repeat, userArg)`：`entity_macro.h:1387-1405`
  ——用 `EntityScriptTimerHandler` 包装 `TimerHandle`；
  `ScriptTimersUtil::addTimer` 失败返回 id 0 →
  **`ValueError("Unable to add timer")`**（`entity_macro.h:1396-1400`）。
- 派发：`handleTimeout` 把 handle 换回脚本 timer id，调用
  `onTimer(id, userArg)`（`entity_macro.h:1372-1375`）。
- 单次 timer 在 `onRelease` 自动释放（`entity_macro.h:1381-1386`）；
  重复 timer 必须 `delTimer`。
- `delTimer(id | "All")`：`"All"` 全部取消（`entity_macro.h:1447-1451`）；
  参数非 int 抛 `TypeError`，但**未知 id 静默返回 `-1`**——不抛 Python
  异常（`entity_macro.h:1478-1482`）。源料「失效 id 会报错」与本 fork
  不符（§12）。
- 回调名固定：实体脚本类上定义 `onTimer(timerHandle, userData)`。

## 6. Entity 控制器链（移动 / 寻路 / 转向 / 区域）

五个创建函数共享同一归属模型：Entity 同时最多持有一个**移动控制器**
（`pMoveController_`）与一个**转向控制器**（`pTurnController_`），在
`cancelController` 的分发处可见（`entity.cpp:1746-1750`）；控制器 id 来自
`Controllers::freeID()`（`server/cellapp/controllers.h:22`、
`controllers.cpp:19`）。

| 函数 | 实现（cellapp/entity.cpp） | fork 取证语义 |
| --- | --- | --- |
| `moveToPoint(destination, velocity, distance, userData, faceMovement, moveVertically)` | `:2816` | 经 `MoveToPointHandler` 直线移动（`moveto_point_handler.cpp`）；仅 real 实体；返回控制器 id |
| `moveToEntity(destEntityID, velocity, distance, userData, faceMovement, moveVertically, offsetPos)` | 同一移动控制器路径 | 追逐目标实体；`offsetPos` 偏移接近点 |
| `navigate(destination, velocity, distance, maxMoveDistance, maxSearchDistance, faceMovement, layer, userData)` | `:2690` | 经 `NavigateHandler` 沿 navmesh 移动（`navigate_handler.cpp`）；`layer` 选 navmesh 层 |
| `navigatePathPoints(destination, maxSearchDistance, layer)` | `:2624` | 纯查询：返回路径点，不创建控制器 |
| `getRandomPoints(centerPos, maxRadius, maxPoints, layer)` | `:2758` | 可达随机点（刷怪/AI 辅助） |
| `canNavigate()` | `:2548` | 仅当空间导航数据已装载可用时为 True |
| `addYawRotator(targetYaw, velocity, userArg)` | `:3064` | 经 `RotatorHandler` 的转向控制器（`rotator_handler.cpp`）；完成 → `onTurn` |
| `addProximity(rangeXZ, rangeY, userArg)` | `:1604` | 经 `ProximityController` + trap 触发器的区域触发（`proximity_controller.cpp`、`trap_trigger.cpp`）；返回控制器 id；`rangeY` 仅在 `cellapp/coordinate_system/rangemgr_y` 开启时生效 |
| `accelerate(type, acceleration)` | `:3020` | 缩放当前移动/转向控制器速度 |
| `cancelController(controllerID \| "Movement")` | `:1671` | 仅 real 实体（`:1676` AssertionError）。fork 取证契约：**唯一**接受的字符串是精确的 `"Movement"` → `stopMove()`（`:1706-1711`）；其他字符串抛 `TypeError`；整数 id 取消匹配的移动/转向控制器（`:1746-1750`） |

移动回调全部经 `Entity::onMove/onMoveOver/onMoveFailure`
（`entity.cpp:2936`、`:2948`、`:2966`）路由：`onMove` 每步触发，`onMoveOver`
到达目标触发，`onMoveFailure` 失败触发（如路径不可达）。**被取消**的移动
不触发 `onMoveOver`——控制器直接拆除、不走完成回调。`userArg`/`userData`
原样进入各回调。

给读源料者的提示：其类描述把 `trackEntity`、`turnToYaw` 写作控制器入口；
fork 的 Entity 方法表里**这两个名字都不存在**（`entity.cpp:46-68`）——真实
入口是 `moveToEntity` 与 `addYawRotator`（§12）。

## 7. View / AOI（Witness）面

View 系统基于 witness：绑定了 `Witness` 的实体
（`server/cellapp/witness.cpp`）追踪哪些观察者接收其更新。

| 条目 | 实现 | 语义 |
| --- | --- | --- |
| `setViewRadius(radius, hyst)` | `entity.cpp:2439` | 仅 real 实体（`:2441` AssertionError）；转发给 witness/view 触发器；`hyst` 是离开滞回带，防进/出抖动 |
| `getViewRadius()` / `getViewHystArea()` | `entity.cpp:2462`、`:2518` | 从已绑 witness 读（`pWitness_->viewRadius()`）；**未绑 witness 时为 0.0**（`:2465-2466`） |
| `debugView()` | `entity.cpp:3149` | 把 view 状态（size/seen/pending/radius）打到 cellapp 日志 |
| `entitiesInView(pending)` | `entity.cpp:63` 注册 | `pending=false` → 已同步到客户端的实体；`pending=true` → 服务端可见但未同步 |
| `entitiesInRange(range, entityType, position)` | `entity.cpp:62` | 球形范围查询；可查到 view 之外、但绝不跨 cell |
| `getWitnesses()` | `entity.cpp:2468` | 正在观察本实体的实体集合（即 §8 的广播受众） |
| `onEnteredView(entity)` | `entity.cpp:1779-1783` | 有实体进入本实体 view |
| `onGetWitness()` / `onLoseWitness()` | `entity.cpp:2177`、`:2215` | witness 绑定/解绑；状态可经 `hasWitness` getset 读（`entity.cpp:79`） |
| `onWitnessed(isWitnessed)` | `entity.cpp:1483`、`:1528` | 本实体进入/离开**他人**的 view——AI 开关的规范挂点 |
| `onUpdateBegin()` / `onUpdateEnd()` | `witness.cpp:749-753`、`:895-899` | 包住每轮 witness 更新（脚本定义了才调用） |
| `onEnterTrap` / `onLeaveTrap` | `entity.cpp:1752-1765` | 区域触发器进出（`addProximity`）；另有按 id 的 `onLeaveTrapID`（`:1770`） |

## 8. EntityCall 与广播面

- `base` / `client`（`entity.cpp:74-75`）：到 base 部分 / 已绑定客户端的
  entityCall；无则 `None`。
- `clientEntity(destID)`（组件面 `entity_component.cpp:14`；主实体与 cell
  方法表共用 `entity.cpp:53`）：包装 view 内实体在**本实体自己的客户端**
  上的方法调用。
- **`allClients` / `otherClients`**（`entity.cpp:76-77`，getter `:581`、
  `:592`）：属性访问返回广播代理
  （`AllClientsComponent::onScriptGetAttribute`，`all_clients.cpp:57-85`，
  断言属主是 **real** 实体，`:70-76`）。对代理的方法调用进入
  `ClientsRemoteEntityMethod::callmethod`
  （`clients_remote_entity_method.cpp:55+`），fork 语义为：
  1. 受众是 `pEntity->witnesses()`——当前正在观察本实体的实体集合
    （`:73`），即 Witness 驱动的 view 集合，**不是**任意半径查询。
  2. `allClients` 还会先发给实体**自己的客户端**——仅当
     `!otherClients_ && pWitness() && clientEntityCall()` 时发送（`:113`）。
  3. `otherClients`（`otherClients_=true`，`all_clients.cpp:171`）完全跳过
     自己客户端。
  4. 方法参数一次性序列化进 `MemoryStream`，再向每个受众信道回放
    （`:92-135`）。
  所以源料的 Avatar 例子是精确的：`avatar.allClients.attack(...)` 到达
  avatar 自己的客户端加每个见证玩家的客户端；`otherClients` 只达见证者。

## 9. Entity 生命周期、持久化、传送、控制

- `destroy(...)`（`entity_macro.h:19`，cellapp 守卫 `entity.cpp:315-323`）：
  实体 initing 或已销毁时以 `AssertionError` 拒绝；完整销毁/回收流程见
  [实体生命周期篇](entity-lifecycle-reference.md)。脚本定义了 `onDestroy`
  才会调用。
- `destroySpace()`（`entity.cpp:342`）：销毁本实体所在空间。
- `writeToDB(shouldAutoLoad, dbInterfaceName)`（`entity_macro.h:18`）：把
  实体（base+cell 数据）归档到 dbmgr；脚本定义了 `onWriteToDB` 会在落库前
  触发。
- `teleport(nearbyMBRef, position, direction)`（`entity.cpp:3392`）：跨空间
  传送。`nearbyMBRef=None` 在当前 cell 内传送。失败路径调用
  `onTeleportFailure()`（`entity.cpp:3471`、`:3481`、`:3490`、`:3522`、
  `:3544`、`:3557`、`:3591`、`:3769`）；成功调用
  `onTeleportSuccess(nearbyEntity, lastSpaceID)`（`:3530`、`:3706`）。
  `onTeleport()`（`entity.cpp:3778-3783`）在传送流程的传输前时刻触发。
- `controlledBy` getset（`entity.cpp:87`）：setter 断言实体为 real
  （`:422`）；赋 base entityCall 即把移动权威交给对应客户端的 base 实体；
  失去控制触发 `onLoseControlledBy(id)`（`:1510`）；客户端交接时实体把
  `controlledBy` 重设为自己的 base（`:2172-2173`）；该字段随实体备份/恢复
  流往返（`:4035-4099`）。
- `onRestore()`（`entity.cpp:3864-3868`，由 `cellapp.cpp:1067`/`:1231` 在
  baseapp 恢复空间时驱动）：cellapp 崩溃恢复重建挂点。
- `onSpaceGone()`（`entity.cpp:381-384`；由 `spacememory.cpp:510` 对每实体
  广播）：所在空间被销毁。
- `isReal()`（`entity.cpp:1446`）：real 还是 ghost；ghost 的 def 方法调用
  经 RPC 代理（`entity_component.cpp:42-49`）。

## 10. Entity 属性（完整清单）

| 属性 | 读/写 | 说明（fork 取证） |
| --- | --- | --- |
| `id` | R | `entity_macro.h:37` |
| `className` | R | `entity_macro.h:39` |
| `isDestroyed` | R | `entity_macro.h:38`，实现 `:1489-1493` |
| `position` | R/W | `entity.cpp:83`；写入走位置更新路径（witness/volatile 机制） |
| `direction` | R/W | `entity.cpp:84`——(roll, pitch, yaw) 弧度 |
| `layer` | R/W | `entity.cpp:82`——navmesh 层选择（`:2242`） |
| `spaceID` | R | `entity.cpp:81` |
| `topSpeed` / `topSpeedY` | R/W | `entity.cpp:85-86`——服务端移动合法性上界 |
| `controlledBy` | R/W | `entity.cpp:87`——见 §9 |
| `volatileInfo` | R/W | `entity.cpp:88`（`:2297`）——分轴 volatile 同步策略；也可在 `.def` `<Volatile>` 声明 |
| `base` / `client` | R | `entity.cpp:74-75` |
| `allClients` / `otherClients` | R | `entity.cpp:76-77`——见 §8 |
| `isWitnessed` / `hasWitness` | R | `entity.cpp:78-79` |
| `isOnGround` | R | `entity.cpp:80`——源料属性正文有述但其摘要表**漏列**（§12） |

## 11. Entity 回调（完整清单）

定时器 §5 · 控制器 §6（`onMove`, `onMoveOver`, `onMoveFailure`, `onTurn`）·
view §7（`onEnteredView`, `onGetWitness`, `onLoseWitness`, `onWitnessed`,
`onEnterTrap`, `onLeaveTrap`, `onUpdateBegin`, `onUpdateEnd`）· 生命周期 §9
（`onDestroy`, `onRestore`, `onSpaceGone`, `onTeleport`, `onTeleportSuccess`,
`onTeleportFailure`, `onWriteToDB`）· 控制 §9（`onLoseControlledBy`）·
`onTimer` §5。源料全部 21 个回调已在上方各节带调用点交代；未将引用行之外
的任何行为写成已实现。

## 12. 3.7 源料 vs fork 3.12 偏离

| 条目 | 官方 3.7 口径源料说法 | fork 3.12 实际行为 | 领域 | 证据 |
| --- | --- | --- | --- | --- |
| `delTimer` 传入失效 id | 「会报错」 | 静默返回 `-1`；不抛 Python 异常 | Fork | `kbe/src/lib/entitydef/entity_macro.h:1478-1482` |
| `cancelController("Type")` | 暗示控制器类型字符串可按类型取消 | 只接受精确字符串 `"Movement"`；其他字符串抛 `TypeError` | Fork | `kbe/src/server/cellapp/entity.cpp:1706-1711` |
| 控制器入口 "trackEntity"/"turnToYaw" | 类描述称控制器经它们添加 | fork 的 cellapp Entity 表无此方法；真实入口是 `moveToEntity` / `addYawRotator` | Fork | `kbe/src/server/cellapp/entity.cpp:46-68` |
| `accelerate` 参数表 | 表中参数写作 "velocity"（chm 表格破损） | 签名是 `(accelerateType, acceleration)`；实现按 `(type, acceleration)` 解析 | Fork | 源料 `Entity.md:142-144`；`kbe/src/server/cellapp/entity.cpp:3020` |
| `isOnGround` | 属性正文有述但源料自己的属性摘要表缺失 | 已注册为只读 getset | Fork | 源料 `Entity.md:1096-1106`；`kbe/src/server/cellapp/entity.cpp:80` |
| `onReadyForLogin` 就绪阈值 | 「返回值 ≥ 1.0 → 就绪」 | `True` → 就绪；否则浮点，`>= 0.9999` 完成；未定义回调 → 立即完成 | Fork | `kbe/src/server/cellapp/initprogress_handler.cpp:163-196` |
| cellapp 上的 `createSpace` | cellapp 源料未记载 | fork 同样不存在：无 cellapp 侧注册（grep `server/cellapp/` + `lib/server/` = 0 命中）；空间创建走 baseapp→cellappmgr | Fork | 2026-11-04 于 HEAD `6d12b8f` grep；`cellapp.cpp:875` |
| `NEXT_ONLY` | 「当前在 Cellapp 未使用」 | 常量仍定义在模块上、无消费者——与源料一致 | Fork | `kbe/src/lib/server/python_app.cpp:323` |
| `genUUID64` 唯一性 | 依赖 `gus` 启动参数；>65535 退化为进程内唯一 | 契约相同，且 global order ∉ 0~65535 时有显式运行时警告 | Fork | `kbe/src/lib/pyscript/script.cpp:91-106` |
| 代码示例（`print "..."`） | 源料示例为 Python 2 语法 | 3.12 要求 `print(...)`；源料片段须重写、不可照抄 | Python | https://docs.python.org/3/whatsnew/3.0.html（print 为函数） |
| `volatileInfo` 类型行 | 属性表写 "float" | 四浮点序列 + 优化开关；可经 `.def` `<Volatile>` 声明——与源料自身正文一致、与其表行不一致 | Fork | 源料 `Entity.md:86` vs `:1231-1265`；`kbe/src/server/cellapp/entity.cpp:88` |

## References

- 注册映射：`server/cellapp/entity.cpp:46-90`、
  `lib/entitydef/entity_macro.h:12-40`、
  `server/cellapp/entity_component.cpp:10-27`、
  `server/cellapp/cellapp.cpp:172-199`、`lib/server/entity_app.h:410-453`、
  `lib/server/python_app.cpp:271-334`、`lib/pyscript/script.cpp:248-258`、
  `lib/pyscript/pywatcher.cpp:184-185`、`lib/pyscript/pyurl.cpp:23`
- 定时器：`lib/entitydef/entity_macro.h:1372-1405`、`:1447-1482`
- 控制器：`server/cellapp/controllers.h:22`、`entity.cpp:1604`、
  `:1671-1750`、`:2624-2816`、`:3020-3064`；handler
  `moveto_point_handler.cpp`、`navigate_handler.cpp`、
  `rotator_handler.cpp`、`proximity_controller.cpp`、`trap_trigger.cpp`
- View：`server/cellapp/witness.cpp:749-753`、`:895-899`；
  `entity.cpp:1779-1783`、`:2092-2215`、`:2439-2518`
- 广播：`server/cellapp/all_clients.cpp:57-85`、`:171`；
  `clients_remote_entity_method.cpp:55-135`
- 数据复制：`cellapp.cpp:830-872`、`lib/server/entity_app.h:1280-1314`、
  `spacememory.cpp:308-619`、`initprogress_handler.cpp:134-196`
- Grounding 于 fork HEAD `6d12b8f`，2026-11-04。
