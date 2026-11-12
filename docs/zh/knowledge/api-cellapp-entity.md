# Cellapp Entity 面 API 参考（KB-API-004）

> 断言与引用完全一致；行号漂移核对以 EN 篇为准。
>
> **范围**：**cellapp** 进程上注册的共享 `Entity` 类——定时器、控制器链、
> view/AOI、广播面、生命周期/传送、属性与回调。`KBEngine` 模块面与双面
> 通用的组装层地图在姊妹篇 [api-cellapp](api-cellapp.md)（该篇 §1 回答
> 「这个 API 在 cellapp 上真的存在吗」）。
>
> **Grounding**：fork `kbe/src`，HEAD `6d12b8f`（grounding 基线 `c2a3b8f`）。
> 版本口径与偏离标注格式依
> [Python 版本口径](python-version-baseline.md)。姊妹篇：
> [Entity 生命周期与引用释放](entity-lifecycle-reference.md)（destroy 守卫、
> timer 释放流程）、[Fixed 目录与路径解析](fixed-directories-and-path-resolution.md)
>（`KBE_RES_PATH` 约束的资源函数）。
>
> **覆盖**：源料 121 个文档条目中的 Entity 部分——29 个成员函数 +
> 21 个回调 + 17 个文档属性（摘要表 16 行；`isOnGround` 在属性正文有述
> 但摘要表漏列，见 §8）。

## 1. Entity 定时器（`addTimer`/`delTimer`/`onTimer`）

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
  不符（§8）。
- 回调名固定：实体脚本类上定义 `onTimer(timerHandle, userData)`。

## 2. Entity 控制器链（移动 / 寻路 / 转向 / 区域）

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
入口是 `moveToEntity` 与 `addYawRotator`（§8）。

## 3. View / AOI（Witness）面

View 系统基于 witness：绑定了 `Witness` 的实体
（`server/cellapp/witness.cpp`）追踪哪些观察者接收其更新。

| 条目 | 实现 | 语义 |
| --- | --- | --- |
| `setViewRadius(radius, hyst)` | `entity.cpp:2439` | 仅 real 实体（`:2441` AssertionError）；转发给 witness/view 触发器；`hyst` 是离开滞回带，防进/出抖动 |
| `getViewRadius()` / `getViewHystArea()` | `entity.cpp:2462`、`:2518` | 从已绑 witness 读（`pWitness_->viewRadius()`）；**未绑 witness 时为 0.0**（`:2465-2466`） |
| `debugView()` | `entity.cpp:3149` | 把 view 状态（size/seen/pending/radius）打到 cellapp 日志 |
| `entitiesInView(pending)` | `entity.cpp:63` 注册 | `pending=false` → 已同步到客户端的实体；`pending=true` → 服务端可见但未同步 |
| `entitiesInRange(range, entityType, position)` | `entity.cpp:62` | 球形范围查询；可查到 view 之外、但绝不跨 cell |
| `getWitnesses()` | `entity.cpp:2468` | 正在观察本实体的实体集合（即 §4 的广播受众） |
| `onEnteredView(entity)` | `entity.cpp:1779-1783` | 有实体进入本实体 view |
| `onGetWitness()` / `onLoseWitness()` | `entity.cpp:2177`、`:2215` | witness 绑定/解绑；状态可经 `hasWitness` getset 读（`entity.cpp:79`） |
| `onWitnessed(isWitnessed)` | `entity.cpp:1483`、`:1528` | 本实体进入/离开**他人**的 view——AI 开关的规范挂点 |
| `onUpdateBegin()` / `onUpdateEnd()` | `witness.cpp:749-753`、`:895-899` | 包住每轮 witness 更新（脚本定义了才调用） |
| `onEnterTrap` / `onLeaveTrap` | `entity.cpp:1752-1765` | 区域触发器进出（`addProximity`）；另有按 id 的 `onLeaveTrapID`（`:1770`） |

## 4. EntityCall 与广播面

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

## 5. Entity 生命周期、持久化、传送、控制

- `destroy(...)`（`entity_macro.h:19`，cellapp 守卫 `entity.cpp:315-323`）：
  实体 initing 或已销毁时以 `AssertionError` 拒绝；完整销毁/回收流程见
  [实体生命周期篇](entity-lifecycle-reference.md)。脚本定义了 `onDestroy`
  才会调用。
- `destroySpace()`（`entity.cpp:342`）：销毁本实体所在空间。
- `writeToDB(shouldAutoLoad, dbInterfaceName)`（`entity_macro.h:18`）：把
  实体（base+cell 数据）归档到 dbmgr；脚本定义了 `onWriteToDB` 会在落库前
  触发，且 cellapp 侧以 **0 参**触发（`entity.cpp:1238`，紧接
  `backupCellData()` `:1239` 再序列化）——同一实体类在 base 侧的同名回调
  却带 1 个 `cellData` 快照参数（`cellDataDict_`，见
  [api-baseapp-entity](api-baseapp-entity.md)），签名须写
  `def onWriteToDB(self, cellData=None)` 两头兼容；cellapp 实体没有
  cellData 属性（不装 `installCellDataAttr`），cell 属性就是普通实例属性。
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

## 6. Entity 属性（完整清单）

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
| `controlledBy` | R/W | `entity.cpp:87`——见 §5 |
| `volatileInfo` | R/W | `entity.cpp:88`（`:2297`）——分轴 volatile 同步策略；也可在 `.def` `<Volatile>` 声明 |
| `base` / `client` | R | `entity.cpp:74-75` |
| `allClients` / `otherClients` | R | `entity.cpp:76-77`——见 §4 |
| `isWitnessed` / `hasWitness` | R | `entity.cpp:78-79` |
| `isOnGround` | R | `entity.cpp:80`——源料属性正文有述但其摘要表**漏列**（§8） |

## 7. Entity 回调（完整清单）

定时器 §1（`onTimer`）· 控制器 §2（`onMove`, `onMoveOver`, `onMoveFailure`,
`onTurn`）· view §3（`onEnteredView`, `onGetWitness`, `onLoseWitness`,
`onWitnessed`, `onEnterTrap`, `onLeaveTrap`, `onUpdateBegin`,
`onUpdateEnd`）· 生命周期 §5（`onDestroy`, `onRestore`, `onSpaceGone`,
`onTeleport`, `onTeleportSuccess`, `onTeleportFailure`, `onWriteToDB`）·
控制 §5（`onLoseControlledBy`）。源料全部 21 个回调已在上方各节带调用点
交代；未将引用行之外的任何行为写成已实现。

## 8. 3.7 源料 vs fork 3.12 偏离（Entity 面）

| 条目 | 官方 3.7 口径源料说法 | fork 3.12 实际行为 | 领域 | 证据 |
| --- | --- | --- | --- | --- |
| `delTimer` 传入失效 id | 「会报错」 | 静默返回 `-1`；不抛 Python 异常 | Fork | `kbe/src/lib/entitydef/entity_macro.h:1478-1482` |
| `cancelController("Type")` | 暗示控制器类型字符串可按类型取消 | 只接受精确字符串 `"Movement"`；其他字符串抛 `TypeError` | Fork | `kbe/src/server/cellapp/entity.cpp:1706-1711` |
| 控制器入口 "trackEntity"/"turnToYaw" | 类描述称控制器经它们添加 | fork 的 cellapp Entity 表无此方法；真实入口是 `moveToEntity` / `addYawRotator` | Fork | `kbe/src/server/cellapp/entity.cpp:46-68` |
| `accelerate` 参数表 | 表中参数写作 "velocity"（chm 表格破损） | 签名是 `(accelerateType, acceleration)`；实现按 `(type, acceleration)` 解析 | Fork | 源料 `Entity.md:142-144`；`kbe/src/server/cellapp/entity.cpp:3020` |
| `isOnGround` | 属性正文有述但源料自己的属性摘要表缺失 | 已注册为只读 getset | Fork | 源料 `Entity.md:1096-1106`；`kbe/src/server/cellapp/entity.cpp:80` |
| `volatileInfo` 类型行 | 属性表写 "float" | 四浮点序列 + 优化开关；可经 `.def` `<Volatile>` 声明——与源料自身正文一致、与其表行不一致 | Fork | 源料 `Entity.md:86` vs `:1231-1265`；`kbe/src/server/cellapp/entity.cpp:88` |

模块面偏离（`onReadyForLogin` 阈值、cellapp 无 `createSpace`、`NEXT_ONLY`、
`genUUID64` 唯一性、Python 2 `print "..."` 示例卫生注记）在
[模块面篇](api-cellapp.md)偏离表。

## References

- 注册映射：`server/cellapp/entity.cpp:46-90`、
  `lib/entitydef/entity_macro.h:12-40`、
  `server/cellapp/entity_component.cpp:10-27`
- 定时器：`lib/entitydef/entity_macro.h:1372-1405`、`:1447-1482`
- 控制器：`server/cellapp/controllers.h:22`、`entity.cpp:1604`、
  `:1671-1750`、`:2624-2816`、`:3020-3064`；handler
  `moveto_point_handler.cpp`、`navigate_handler.cpp`、
  `rotator_handler.cpp`、`proximity_controller.cpp`、`trap_trigger.cpp`
- View：`server/cellapp/witness.cpp:749-753`、`:895-899`；
  `entity.cpp:1779-1783`、`:2092-2215`、`:2439-2518`
- 广播：`server/cellapp/all_clients.cpp:57-85`、`:171`；
  `clients_remote_entity_method.cpp:55-135`
- 生命周期/传送：`entity.cpp:315-323`、`:3392-3783`、`:3864-3868`；
  `cellapp.cpp:1067`、`:1231`；`spacememory.cpp:510`
- Grounding 于 fork HEAD `6d12b8f`，2026-11-04。
