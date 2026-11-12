# 实体对象生命周期与引用释放

> KB-001 头号专题(用户点名优先):内存对象引用与释放。
> 所有引用标注 `kbe/src` 的 `文件:行号`;每条结论都以引擎源码为据(锚定
> `kbengine@c2a3b8f`)。baseapp 路径与本文 cellapp 路径类比;迁移/传送的引用
> 流见[实体传送、跨 cellapp 迁移与跨进程引用](entity-migration-and-cross-process-references.md)。

## 活跃注册表持有强引用

`KBEngine.entities` 是进程级活跃实体注册表,是一个 `ENTITY_ID → PyObjectPtr`
映射(`kbe/src/lib/entitydef/entities.h:24`):映射值是**持有实体 Python 对象
强 CPython 引用的智能指针**。实体在该映射中时,引擎保证其 Python 对象存活
(仅注册表自身即持有 refcount ≥ 1)。

## 销毁流程:移出注册表,进入 `garbages`

Python 侧的 `entity.destroy()` 经宏 `CLASS::destroyEntity()`
(`kbe/src/lib/entitydef/entity_macro.h:1486`)转发到应用级
`EntityApp::destroyEntity(id, true)`(`kbe/src/lib/server/entity_app.h:713`):

```cpp
PyObjectPtr entity = pEntities_->erase(entityID);   // 移出活跃映射
if(entity != NULL) { entity->destroy(callScript); } // 销毁该(仍存活的)对象
```

`Entities<T>::erase`(`entities.h:331`)分两步完成移动:

```cpp
T* entity = static_cast<T*>(iter->second.get());
_pGarbages->add(id, entity);   // ① 把裸指针记入 `garbages`
_entities.erase(iter);         // ② 释放注册表的强引用
return entity;                 // ③ 以 PyObjectPtr 返回(保活供 destroy())
```

因此已销毁实体**被移出活跃注册表**,其裸 `PyObject*` 被**记入
`KBEngine.entities.garbages`**——一个非持有指针注册表
(`kbe/src/lib/entitydef/entity_garbages.h:23`,值类型 `PyObject*`)。`garbages`
在 `add` 时**不加** refcount(`entity_garbages.h:273-301`)。

## 引用语义:引擎不再保活已销毁对象

注册表释放强引用(`_entities.erase`)后,实体 Python 对象的存活期完全由
**其余 CPython 引用**(脚本闭包、列表、定时器、`cellData` 快照等)决定。
`garbages` 只持裸指针、不拥有对象。推论:

- 若**无其他引用**残留,对象即被释放(refcount 0),`garbages` 条目变为悬垂
  ——通过 `garbages[id]` 查询仅在对象仍存活时有效。
- 若脚本**仍持有引用**(典型泄漏/销毁后用),对象保持存活,`garbages` 仍指向它。

## 泄漏检测

`EntityGarbages::add` 在映射首次非空时记录时间戳
(`entity_garbages.h:282-285`)。若 garbages 连续 **3600 秒未被清空**
(`stampsPerSecond() * 3600`,`entity_garbages.h:289`),引擎记日志:

> "For a long time(3600s) not to empty the garbages, there may be a leak of the
> entitys(size:N), please use the `KBEngine.entities.garbages.items()` command
> query!"(`entity_garbages.h:294-296`)

`garbages` 以 Python 方法 `has_key`/`keys`/`values`/`items`/`get` 暴露
(`entity_garbages.h:124-130`),经 `KBEngine.entities.garbages` 可达
(`entities.h:126`)。访问条目时向调用方交出强引用
(`Py_INCREF`,`entity_garbages.h:169`)。

## 销毁护栏(踩坑)

- `__init__` 期间(`initing`)调用 `destroy()` → **AssertionError**
  ("initing, reject the request",`cellapp/entity.cpp:315`)。
- 对已销毁实体再 `destroy()` → **AssertionError**
  ("is destroyed",`cellapp/entity.cpp:322`)。
- 销毁后大多数实体方法同样护栏——`destroySpace`(`:354`)、`addProximity`
  (`:1616`)、`clientEntity`(`:1638`)等(`:414`,`:1792`):对已销毁实体调用任
  一即抛 AssertionError。**远程**调用指向已销毁实体则记为 `ERROR_MSG` 日志而
  非断言(`onRemoteMethodCall`,`cellapp/entity.cpp:991`)。
- `entity.isDestroyed` 是只读 Python 属性(`entity_macro.h:34`)。

## `onDestroy` 回调与 cell 数据备份

`Entity::onDestroy(callScript)`(`cellapp/entity.cpp:204`)仅在
`callScript && isReal()` 时调用 Python 的 `onDestroy` 回调(`:206-210`)。
注释明言:"通常销毁一个entity不通知脚本可能是迁移或者传送造成的"(迁移/传送
期间不通知脚本)。脚本通知的销毁还会 `backupCellData()` 并向 base 发
`onLoseCell`(`:216-220`)——即便 cell 实体已销毁,base 仍保有 cell 数据快照,
这解释了为何 base 侧对已销毁 cell 实体的引用仍能读到最后的 `cellData`。

## Cell 状态表

下列行号除注明外均为 base 侧
(`kbe/src/server/baseapp/entity.cpp`),已对 `kbengine@3082ab5` 源码逐个核过。

| 状态 | 置位 | 清除 | 脚本回调 |
|---|---|---|---|
| base 已建,无 cell | 构造 `:59`(`creatingCell_ = false`) | — | — |
| **创建 cell 中**(请求在途) | `createCellEntity` `:1463`;`restoreCell` `:1473` | `onGetCell` `:1021`;`onCreateCellFailure` `:881` | 无——请求是异步的 |
| **持有 cell** | `onGetCell` `:1028`(建 `cellEntityCall_`) | `onLoseCell` `:1059`(`S_RELEASE`) | `onGetCell` `:1030-1032`,`inRestore_` 时跳过 |
| cell 丢失,base 仍存活 | `onLoseCell` `:1059` | —(之后重装 `cellData`,`:1122`) | `onLoseCell` `:1065` |
| **恢复中**(baseapp 崩溃后) | `restoreCell` `:1474`(`inRestore_ = true`) | `onRestore` `:1085` | `onRestore` `:1080`,由 `restore_entity_handler.cpp:173,266` 驱动 |
| 已销毁 | — | — | base `Entity::onDestroy` `:164`(`callScript` 时触发 `onDestroy`);cellapp `:204` |

恢复入口是 `RestoreEntityHandler::process`
(`restore_entity_handler.cpp:89`),实体由 `baseapp.cpp:709,723` 逐个喂入;它调
`restoreCell`(`:159`、`:304`)——复用常规 cell 路径但置 `inRestore_`,cell 到达后
才由 handler 触发 `onRestore`(`:173`、`:266`)。

### 一次创建调用从不证明已持有 cell

`createCellEntity`(`:1416`)的收尾是置 `creatingCell_ = true`(`:1463`)、发出
`Baseapp::createCellEntity(...)`,然后**同步返回**——此刻 `cellEntityCall_`
仍是 `NULL`。「已持有 cell」唯一可观测点是 `entity.cell` 属性
(getter `pyGetCellEntityCall` `:750`;属性表 `:36`),它读 `cellEntityCall_`,
所以在 `onGetCell` 之前恒为 `None`。在途标志本身是 `creatingCell_`
(`entity.h:295`),仅能以 `creatingCell()`(`entity.h:107`)读到——那是引擎内部
访问器,**没有 Python 面**。

由此一条会咬人的推论:引擎**没有** `isOnCell`/`isOnDB`/`isPersisted` 谓词。
base `Entity` 的属性面是 `cell`、`client`、`databaseID`、
`databaseInterfaceName`、`shouldAutoBackup`、`shouldAutoArchive`
(`:35-41`),外加 `id`、`isDestroyed`、`className`(`entity_macro.h:33-35`)。
凡需判断「有没有 cell」的代码必须读 `entity.cell`,不能由「调过一次创建」推断。

`creatingCell_` 置位期间,`destroy()` 是**延迟**而非拒绝(`:641`):警告
"creating cell! automatic 'destroy' process will begin after 'onGetCell'" 并置
`ENTITY_FLAGS_DESTROY_AFTER_GETCELL`(`entity_macro.h:268`)。之后两处兑现该标志的
路径**销毁对象不同**:`onGetCell` 调 `destroyCellEntity()`(摘掉 cell 部分,
`:1037-1041`),`onLoseCell` 调 `destroy()`(销毁 base,`:1069-1074`)。重复调
`createCellEntity` 会直接失败:`creatingCell_ || cellEntityCall()` 时报
`AssertionError "has a cell"`(`:1435`)。

`onGetCell` 还会跑 `destroyCellData()`(`:1024`)——cell 一旦建成,`cellData`
属性即被**删除**(`destroyCellData` `:560`;dict 对象 `cellDataDict_` 为备份保留,
去掉的只是 Python 属性)。

## 定时器:不持强引用,销毁即取消

定时器按实体归属。Python `addTimer(interval, repeat, userArg)` 构造每个定时
器的 `EntityScriptTimerHandler`,持**裸 `CLASS* pEntity_`**,而非 Python 强引用
(`entity_macro.h:1362-1385`,创建于 `:1389`)。因此引擎**不会**借定时器保活已
销毁实体。

`Entity::destroy()` 调用 `scriptTimers_.cancelAll()`(`cellapp/entity.cpp:4002`);
每个 `handle.cancel()` 触发 handler 的 `onRelease`,释放定时器条目并 `delete`
该 handler(`entity_macro.h:1377-1382`)。故定时器绝不向已销毁实体触发(游戏
逻辑单线程串行)。触发路径是 `handleTimeout` → `pEntity_->onTimer(id, userArg)`
(`entity_macro.h:1370-1375`)→ 经 `bufferOrExeCallback` 调 Python
`onTimer(timerID, userArg)`(`cellapp/entity.cpp:4318-4322`);该函数在
`_scriptCallbacksBufferCount > 0` 时(如 init/ghost 期间)**缓冲**回调,否则
立即执行(`cellapp/entity.cpp:1263-1293`)。

移除:`delTimer(id)` → `ScriptTimersUtil::delTimer` → `handle.cancel()`,定时器
不存在时返回 `-1`(`entity_macro.h:1478`,`script_timers.cpp:96-108`);
`delTimer("All")` → `cancelAll()`(`entity_macro.h:1449`)。

模块级 `KBEngine.addTimer(interval, repeat, callback)`(所有 app 的解释器层
注册面,`python_app.cpp:329-330`;实现在 `__py_addTimer`,`python_app.cpp:721-748`)
是**另一回事**:它构造的是 `ScriptTimerHandler(pTimers, pyCallback)`,**强引用
回调对象**——传 `self.onTick` 即强持实体。该 timer 挂在 app 的 `scriptTimers()`
上,`Entity::destroy()` 的 `scriptTimers_.cancelAll()` 只取消实体自己的
`scriptTimers_`,**不会**取消它。自绑定的重复 timer 不在 `onDestroy` 里
`KBEngine.delTimer` 注销,回调就会持续触发/实体进 `garbages` 泄漏(与上文的
闭包/列表持引用同族);单发(repeat=0)fire 后自释放,窗口有限。

真正的引用隐患不在定时器本身,而在脚本闭包或列表捕获实体且存活超过销毁
——那才是上文 `garbages`/3600 秒泄漏场景,而非定时器持引用。

## 引擎持有的未决回调(「Functor」之问)

BigWorld 时代的「Functor 持引用」担忧在 KBEngine **没有 Functor 可指**:
对 `kbe/src` 全树大小写不敏感检索,除 vendored 测试依赖外不存在
`Functor` 类。引擎真正持有脚本回调的是
`PY_CALLBACKMGR = CallbackMgr<PyObjectPtr>`
(`kbe/src/lib/server/callbackmgr.h:215`),按实体挂成员
(`entity_macro.h:279`),供异步应答类 API(如 `writeToDB(callback)`)使用。

引用语义,逐条锚定 `callbackmgr.h`:

- `save(callback, timeout=0)` 把回调以 **`PyObjectPtr`——强 CPython 引用**
  存入 `cbMap_`,按分配的 id 索引,带过期时间戳;timeout 0 表示用服务器
  配置默认值(`callback_timeout_` 秒)(`:62-74`)。
- `take(id)` 在应答到达时取走并移除(`:78-89`);`tick()` 过期清理——过期
  路径对存储对象 DECREF(`processTimeout`,`:202-212`);`finalise()` 全清
  (裸指针变体逐条 DECREF,`:190-198`)。
- 整个未决集**随迁移/传送存活**:pickle 进实体流
  (`addToStream`/`createFromStream`,`:134-188`)——这正是 ghost 化时看到
  的 `pyCallbackMgr_.addToStream(s)`/`finalise()` 对(见
  [迁移篇](entity-migration-and-cross-process-references.md))。

结论:未决的引擎回调把*回调对象*强引用到应答/过期/实体终结为止——它
绝不保活已销毁的*实体*,也不会泄漏超过超时时间。
