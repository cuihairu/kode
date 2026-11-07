# 实体传送、跨 cellapp 迁移与跨进程引用

> KB-001 桶 ② 对 [实体对象生命周期与引用释放](entity-lifecycle-reference.md)
> 中标注 TODO 的迁移/传送引用流的补全。所有引用标注 `kbe/src` 的
> `文件:行号`,锚定工作区引擎提交(`kbengine@3082ab5`)逐条核实;不虚构行为。

## 一个实体,三个可寻址面

KBEngine 实体可同时存在于最多三个进程:**base** 对象(baseapp)、**cell**
对象(cellapp,空间态)与 **client** 对象。一个面上的脚本代码无法持有另一面
对象的 Python 引用——它持有的是 **`EntityCall`**:一个携带
`(componentID, entity id, 调用类型)` 的远程句柄
(`kbe/src/lib/entitydef/entity_call.h:15`)。

调用类型(`kbe/src/lib/common/common.h:285-291`):`CELL`、`BASE`、`CLIENT`,
外加路由变体 `CELL_VIA_BASE`、`BASE_VIA_CELL`、`CLIENT_VIA_CELL`、
`CLIENT_VIA_BASE`。对 EntityCall 的属性访问按**所属面的方法表**解析并返回
`RemoteEntityMethod`(`entity_call.cpp:82-123`);读它的 `.cell` / `.base` /
`.client` 则构造一个新的 via-EntityCall 指向那个面(`entity_call.cpp:138-168`,
服务端总是新建对象,`:166`)。

引用语义推论:

- EntityCall 寻址的是**进程 + entity id**,不是对象。它不保活目标,也没有
  失效通知——目标实体销毁后,发往它的远程调用是一条 `ERROR_MSG` 日志而非
  断言(生命周期篇已覆盖,`cellapp/entity.cpp:991`)。
- base 上的 `self.cell` 是 base 自己的 `cellEntityCall_` 成员:首次获得 cell
  时创建(`baseapp/entity.cpp:1028`,`ENTITYCALL_TYPE_CELL`),`onLoseCell`
  时释放(`baseapp/entity.cpp:1059`)。

## `cellData` 是快照,永远不是活对象

base 侧 `self.cellData` 属性是 `installCellDataAttr` 安装的普通字典
(`baseapp/entity.cpp:217`,`PyObject_SetAttrString` 在 `:227-230`)。其内容
**设计上就是旧的**:

- 初始填充(`createCellData`,`baseapp/entity.cpp:250`)写入的是 **def 文件
  默认值加零值 `position`/`direction`**(`:299-314`)——明确不是 cell 活值。
- cell 存活期间该属性被**删除**(`onGetCell` 在 `baseapp/entity.cpp:1024`
  调 `destroyCellData`;后者在 `:560` 只移除脚本可见属性——`:561-562`
  的注释说明字典被引擎内部保留供备份用)。cell 活着时读 `self.cellData`
  抛 `AttributeError`。
- 刷新路径:`reqBackupCellData`(`baseapp/entity.cpp:1093`)请求 cell 序列化
  当前数据;cell 侧计算 SHA-1 摘要(`cellapp/entity.cpp:1153`),仅当持久化
  数据变化才回传(`backupCellData`,`cellapp/entity.cpp:1132`);base 收到后
  仅在数据脏时重装属性(`onBackupCellData`,`baseapp/entity.cpp:1112-1124`)。
- 通知脚本的 cell 销毁会先自动备份再通知 base(`cellapp/entity.cpp:216-221`:
  `backupCellData()` + `onLoseCell` 包),这就是 base 失去 cell 后仍能读到
  **最后一份** `cellData` 的原因。

正确性规则:`cellData` 只在 cell 缺席(或数据库归档)时有意义,永远不能
替代 `self.cell.<...>` 调用。

## teleport:脚本入口与路由

`teleport` 是 **cell 面**方法:`pyTeleport`(`cellapp/entity.cpp:3394`)。
前置守卫以 AssertionError / Exception 写入脚本日志:实体必须是 **real**
(`isReal()` 断言 "not is real entity",`:3399`——ghost 不能传送)、未销毁、
所在 space 存活、`position`/`direction` 是 3 元序列(`:3405-3435`)。

分发器(`Entity::teleport`,`cellapp/entity.cpp:3713`)按 `nearbyMBRef`
参数路由:

| 参数 | 路由 |
| --- | --- |
| `None` | 同 space 跳转:`teleportLocal`(`:3647`) |
| 实体对象(必在同 cellapp) | `teleportRefEntity`(`:3467`) |
| 本地可解析的 `cellEntityCall` | `teleportRefEntity` |
| 指向其他 cellapp 的 `cellEntityCall` | `teleportRefEntityCall`(`:3538`)——迁移路径 |
| 其他任何值 | 报错 + `onTeleportFailure`(`:3769-3772`) |

源码 `:3716-3730` 处的行为注释(引擎策略,值得知道):

- 任何 teleport 都按**瞬移**处理(可跨 space),哪怕只挪 0.1 米:处在 trap
  里的实体先触发 trap 离开回调,落点仍在同一 trap 内则再触发进入回调。
- 同 cellapp 跨 space 跳转立即执行(`teleportRefEntity` →
  `teleportLocal`,`:3503`)。

`teleportLocal`(`cellapp/entity.cpp:3647`):卸下坐标节点,设置
position/direction,向**自己的 witness 与所有正在观察该实体的其他
witness** 发 `onSetEntityPosAndDir`(`:3660-3710`),重新挂回节点,然后在
cell 上触发 `onTeleportSuccess(nearbyEntity, lastSpaceID)`(`:3801`;
trap/邻域经 `restoreProximitys()` 恢复,`:3810`)。

## 跨 cellapp 传送:完整消息流

### 1. 源 cell:变成 ghost,不销毁

`teleportRefEntityCall`(`cellapp/entity.cpp:3538`):

- 守卫:实体已在途(`ENTITY_FLAGS_TELEPORT_START`)上报
  `onTeleportFailure`(`:3540-3549`);引用必须是 **cell-real** 的
  EntityCall(`isCellReal()` 检查失败即返回,`:3551-3560`)。
- 若实体带 base,源 cell 向 baseapp 发 `onMigrationCellappStart(id,
  source, target)`(`:3584-3593`),让 base 在切换期间**暂存**发往 cell 的
  消息(保序;`:3563-3569` 注释解释了 ghost 转发设计)。
- `changeToGhost(realCell, stream)`(`cellapp/entity.cpp:3964`):断言
  `isReal()`(`:3971`);设置 `realCell_`(real 的定义就是
  `realCell_ == 0`,`cellapp/entity.inl:131`);登记 GhostManager 路由,使
  仍发到 ghost 的消息**转发给 real**(`:3976-3980`);序列化 def 数据 +
  移动 + 控制器 + witness + 定时器 + 事件 + 未决回调(`addToStream`,
  `:3989`);随后**停掉**本地一切——控制器释放(`:3994-3998`)、witness
  清空(`:4000-4004`)、全部脚本定时器取消(`:4006`)、回调管理器终结
  (`:4007`)。
- 序列化包以 `reqTeleportToCellApp` 发往目标(`onTeleportRefEntityCall`,
  `cellapp/entity.cpp:3603-3645`)。源实体**此时不销毁**(注释
  `:3638-3641`):以 ghost 身份存活,转发 base 流量并保留失败恢复的现场;
  `stopMove()` 冻结移动(`:3643`)。

### 2. baseapp:先暂存,再改指向

- `onMigrationCellappStart`(`baseapp/entity.cpp:1571`):base 把发往 cell
  的消息暂存进 `EntityMessagesForwardCellappHandler`
  (`baseapp/entity_messages_forward_handler.h:20`)。安全阀:暂存超过
  8192 条强制提前放开(`...handler.cpp:57-62`);等待超时 5 秒同样强制放开
  (`:80`);放行回路每 tick 最多重放 `PACKET_MAX_SIZE_TCP * 10` 字节,保证
  信道公平(`:108-137`)。
- `onMigrationCellappEnd`(`baseapp/entity.cpp:1593`,由**新** cellapp 重建
  实体后发来):若已见过 Start,清标记收尾;若 End 抢先于 Start 到达,置
  `ENTITY_FLAGS_TELEPORT_STOP` 并改为暂存**发往 client** 的消息
  (`BaseMessagesForwardClientHandler`,`entity_messages_forward_handler.h:35`)
  直到 Start 到达。
- `onMigrationCellappOver`(`baseapp/entity.cpp:1622`):通知旧 cellapp
  `reqTeleportToCellAppOver`,并——关键一行——**原地重定向 base 自己的
  `cellEntityCall_`**:`cellEntityCall()->componentID(targetCellAppID)`
  (`:1635`)。此刻起 `self.cell` 指向新 cellapp。暂存的 cell 消息随后重放
  到新组件(`onBufferedForwardToClientMessagesOver`,`:1645`)。

### 3. 目标 cell:重建,再确认

`Cellapp::reqTeleportToCellApp`(`cellapp/cellapp.cpp:1880`):校验参照
实体、space 与模块(`:1904-1969`);以**同一 entity id** 创建实体并从流中
恢复(`:1971-1997`;反序列化失败则中止传送并回失败,`:1982-2009`);停掉
随流而来的移动控制器(`:2016-2019`);清 ghost 关系——传送抵达的实体没有
ghost 部分(`ghostCell(0)`,`:2023`);若带 base,置
`ENTITY_FLAGS_TELEPORT_START` 并通知 baseapp `onMigrationCellappEnd`
(`:2026-2040`);通知 client `onEntityLeaveSpace`(`:2043-2051`);进世界
(`:2055`);触发 cell `onTeleportSuccess`(`:2058`);回
`reqTeleportToCellAppCB(success)`(`:2060-2064`)。

### 4. 收尾:销毁旧的,或恢复旧的

`Cellapp::reqTeleportToCellAppCB`(`cellapp/cellapp.cpp:2075`):

- **成功**:旧(ghost)实体以 `callScript=false` 销毁(`:2092-2095`)——
  旧 cell 上不触发 `onDestroy`,这正是生命周期篇的 `onDestroy` 以
  `callScript && isReal()` 为闸的原因(`cellapp/entity.cpp:206`)。
- **失败**:baseapp 收到 `onMigrationCellappEnd(source, source)`
  (`:2098-2118`),放弃迁移并把暂存消息重放回**旧** cellapp;旧实体经
  `changeToReal(0, stream)`(`cellapp/cellapp.cpp:2143`,实现见
  `cellapp/entity.cpp:4010`)从序列化副本恢复(def 数据、控制器、witness、
  定时器、回调都经 `createFromStream` 回来);随后 cell `onTeleportFailure()`
  触发(`cellapp/cellapp.cpp:2163`)。若实体已消失(如 space 被销毁),仅记
  `ERROR_MSG`(`:2133-2140`)。
- `reqTeleportToCellAppOver`(`cellapp/cellapp.cpp:2171`)清除新实体的在途
  标记,序列完成。

## 实际触发的脚本回调

在本提交(`kbengine@3082ab5`):

- cell 面:`onTeleportSuccess(nearbyEntity)`(`cellapp/entity.cpp:3801`,
  经 `bufferOrExeCallback` 缓冲,init/ghost 期间顺延)与
  `onTeleportFailure()`(`:3790`)。成功时 base 收到的通知带
  `fromCellTeleport=true`(`_sendBaseTeleportResult`,`:3381`,唯一发送点
  `:3806`),因此 base **静默更新自己的 `spaceID`**——
  `baseapp/entity.cpp:1543-1546` 只在 `fromCellTeleport` 为 false 时才调
  base 脚本回调,而当前没有任何发送点传 false。
- base 面:`onTeleportSuccess` / `onTeleportFailure` 脚本回调存在
  (`baseapp/entity.cpp:1562` / `:1555`),但本提交**不会因 teleport 触发**
  (死路径,等待未来出现传 false 的发送点)。
- cell `onTeleport()`(`cellapp/entity.cpp:3781`)在本 HEAD **无调用者**——
  其注释提到的 `base.teleport` 流程本 fork 并未暴露。

## 迁移中的引用语义(实用规则)

1. **同 cellapp 直接引用**(其他 cell 脚本持有该实体对象):跨 cellapp 传送
   成功后旧对象被销毁(`callScript=false`),持有的引用变成已销毁对象引用
   ——受生命周期篇守卫约束(方法调用抛 AssertionError;`isDestroyed` 为
   `true`)。
2. **迁移实体 base 上的 `self.cell`**:唯一的共享 `cellEntityCall_` 实例被
   原地重定向(`baseapp/entity.cpp:1635`),切换后读 `self.cell` 即指向新
   cellapp。此前捕获的引用(如 `c = self.cell`)是**同一对象**,同样看到
   重定向——但经其他途径构造的引用(如别的实体拿到的描述本实体的
   `otherBase.cell`)是独立的 EntityCall 对象,携带旧 `componentID`,
   **不会**被更新;引擎把它们发往旧 cellapp,实体已不在那里——投递层记
   `WARNING_MSG "entityID ... not found"` 并丢弃消息(`Cellapp::onEntityCall`,
   `cellapp/cellapp.cpp:1331`),调用方不会收到异常。
3. **base 上的 cellData 读者**:传送本身不影响(属性在 cell 存活期间缺席);
   下一次脏备份经 `reqBackupCellData` 路径重新同步。
4. **在途窗口内**旧实体以 ghost 存在,控制器/定时器已停——发到它的调用被
   转发给 real(`Cellapp::onEntityCall`:`if(!entity->isReal())` →
   GhostManager 推送到 `realCell()`,`cellapp/cellapp.cpp:1341-1352`;路由
   登记 `cellapp/entity.cpp:3976-3980`);引擎靠这个转发而非阻塞 base,
   暂存重放与新目标之间不丢消息、不乱序(注释 `:3563-3569`)。

## 踩坑清单(汇入桶 ④ 索引)

- ghost 实体不能 `teleport`(`isReal()` 断言,`cellapp/entity.cpp:3399`)。
- teleport 永远是*瞬移*:留在同一 trap 内的微跳也会先后触发 trap 离开/进入
  回调(`:3716-3720`)。
- `teleport` 传入类型错误的引用(如 base EntityCall)会以 `onTeleportFailure`
  失败收场——引用必须是 **cell-real** 的 EntityCall(`:3551-3560`)。
- 跨 cellapp 失败时实体在**旧** cell 恢复并在那里触发 `onTeleportFailure`;
  成功时旧实体静默销毁(`callScript=false`)、**新** cell 触发
  `onTeleportSuccess`——游戏逻辑不能假设旧对象的 `onDestroy` 会执行
  (`cellapp/cellapp.cpp:2092-2095`)。
- cell 活着时 `self.cellData` 被删除:读它抛 `AttributeError`
  (`baseapp/entity.cpp:1024`);其值要么是默认值要么是最后一次脏备份,永远
  不是活值(`:250`、`:1112-1124`)。
- 迁移时引擎不会失效单独持有的 EntityCall 副本(`baseapp/entity.cpp:1635`
  只重定向 base 自己的调用)——过期副本指向一个实体已不存在的进程。
