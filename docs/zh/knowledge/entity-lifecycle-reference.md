# 实体对象生命周期与引用释放

> KB-001 头号专题(用户点名优先):内存对象引用与释放。
> 所有引用标注 `kbe/src` 的 `文件:行号`;每条结论都以引擎源码为据(锚定
> `kbengine@c2a3b8f`)。baseapp 路径与本文 cellapp 路径类比;定时器/Functor
> 深层引用持有属后续批次主题(标注 TODO,不虚构为已实现)。

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

## 定时器注册/移除

定时器按实体归属(`ScriptTimers`),移除经
`ScriptTimersUtil::delTimer(&pobj->scriptTimers(), timerID)`
(`entity_macro.h:1478`),定时器不存在时返回 `-1`。比实体活得久的定时器是
引擎侧引用持有的隐患——定时器/Functor 深层引用规则属**后续批次主题**(TODO)。
