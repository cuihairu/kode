# 语义陷阱索引

> KB-001 桶 ④:本知识库各页收集的语义陷阱与易误解行为总索引。每行指向
> 承载完整「现象/根因(带源码引用)/正确姿势」的文章——本页绝不引入目标
> 文章没有 grounding 的新论断。根因引用在目标文章内;各文章锚定的引擎
> 提交见其页首。

## 内存与引用

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| 闭包/列表持有已销毁实体 | `garbages` 不清空;3600 秒后引擎记泄漏警告 | 在 `onDestroy` 清引用;用 `KBEngine.entities.garbages.items()` 定位持有者 | [生命周期 §注册表](entity-lifecycle-reference.md) |
| `__init__` 期间 `destroy()` | AssertionError "initing, reject the request" | 销毁推迟到初始化之后 | [生命周期 §守卫](entity-lifecycle-reference.md) |
| 对已销毁实体调方法(本地) | AssertionError "is destroyed" | 先查 `entity.isDestroyed` | [生命周期 §守卫](entity-lifecycle-reference.md) |
| 远程调用发往已销毁实体 | 调用方无异常——接收端记 `ERROR_MSG`/`WARNING_MSG`,消息丢弃 | 远程调用按尽力而为对待;重要结果走回调确认 | [生命周期 §守卫](entity-lifecycle-reference.md)、[迁移 §规则](entity-migration-and-cross-process-references.md) |
| 担心 BigWorld 式「Functor」引用泄漏 | KBEngine 无 `Functor` 类;异步回调持有者是 `PY_CALLBACKMGR`——每条未决回调一个强引用,应答/超时/终结即释放 | 未决回调活不过超时,也保活不了已销毁实体 | [生命周期 §Functor](entity-lifecycle-reference.md) |

## 迁移与传送

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| ghost 不能 `teleport` | AssertionError "not is real entity" | 从 real 实体发起传送 | [迁移 §teleport](entity-migration-and-cross-process-references.md) |
| trap 内微跳 | trap 离开**和**进入回调都触发(teleport 一律按瞬移处理) | 任何传送都预期两个回调,与距离无关 | [迁移 §teleport](entity-migration-and-cross-process-references.md) |
| `teleport` 传错引用类型(如 base EntityCall) | `onTeleportFailure` | 传 **cell-real** 的 EntityCall(或实体本身 / None) | [迁移 §teleport](entity-migration-and-cross-process-references.md) |
| 以为跨 cellapp 传送后旧 cell 会跑 `onDestroy` | 永不触发——旧实体以 `callScript=false` 销毁;`onTeleportSuccess` 在**新** cell 触发,`onTeleportFailure` 在**旧** cell 恢复 | 按 space 的清理放 `onLeaveSpace`,不要押注 `onDestroy` | [迁移 §收尾](entity-migration-and-cross-process-references.md) |
| 迁移后单独持有的 EntityCall 副本过期 | 消息在旧 cellapp 被静默丢弃(`WARNING_MSG entityID ... not found`) | 用时现读 `self.cell`/`self.base`,不缓存句柄 | [迁移 §规则](entity-migration-and-cross-process-references.md) |
| cell 存活期间读 `self.cellData` | AttributeError(属性已删;值本就是默认值或最后一次脏备份) | 走 `self.cell.<方法>` 调用;`cellData` 只当无 cell 期快照 | [迁移 §cellData](entity-migration-and-cross-process-references.md) |

## 定时器与控制器

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| `delTimer` 传过期 id 以为会报错 | 静默返回 `-1`(fork);3.7 材料称会报错 | 检查返回值 | [api-cellapp-entity §偏差表](api-cellapp-entity.md) |
| 以为要在 `onDestroy` 里注销定时器 | 没必要——`destroy()` 全量取消(`scriptTimers_.cancelAll()`) | `delTimer` 只在存活期内提前取消时用 | [生命周期 §定时器](entity-lifecycle-reference.md)、[使用统计](api-usage-stats.md) |
| `cancelController("SomeType")` | TypeError——只认精确字符串 `"Movement"` | 其他控制器按句柄取消 | [api-cellapp-entity §偏差表](api-cellapp-entity.md) |
| 调 `trackEntity` / `turnToYaw` | fork 里没有这两个方法 | 用 `moveToEntity` / `addYawRotator` | [api-cellapp-entity §偏差表](api-cellapp-entity.md) |
| 模块级 `KBEngine.addTimer` 自绑定回调泄漏 | app 级 timer 强持回调对象(`self.onTick` 即强持实体),实体 `destroy()` 只取消实体自身 `scriptTimers_`,**不会**取消它——回调持续触发/实体进 `garbages` 泄漏 | 句柄存成员,`onDestroy` 里 `KBEngine.delTimer(句柄)`(实体级 `self.addTimer` 无此问题,destroy 自动全量取消) | [生命周期 §定时器](entity-lifecycle-reference.md)、`python_app.cpp:721-748` |

## 属性同步

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| FIXED_DICT 属性子键赋值不同步 | `self.<FIXED_DICT属性>[子键] = 值` 只改本地 `pyDict_`,引擎在该路径无通知面,属性不会同步 | 整体重赋习语:`d = self.<属性>` → 改子键 → `self.<属性> = d`(只有顶层赋值走同步) | [core-concepts §1.5](api-core-concepts.md)、`fixeddict.cpp:272-308` |

## EntityCall 语义

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| 经 EntityCall 调引擎方法 | 不可达——EntityCall 只能调 `.def` 文件声明的方法 | 方法进 def,或引擎 API 用本地实体引用调 | [api-core-concepts §1.1](api-core-concepts.md) |

## 回调命名与面放置

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| 项目自定义 `onXxx` 被当成引擎回调 | 真实树中约 1/3 的 `def onXxx` 是项目约定,引擎从不调用 | 先对照回调表再认定名字是引擎调用 | [使用统计](api-usage-stats.md)、[入口 SPI 表](entry-script-spi-methods.md) |
| `onReadyForLogin` 返回值语义 | 不是「≥ 1.0 即就绪」——`True` 即就绪;浮点到 `>= 0.9999` 完成;无回调则立即完成 | 按 fork 语义返回 `True`/浮点进度 | [api-cellapp §偏差表](api-cellapp.md) |
| 期望内嵌客户端触发 `onDestroy` | 永不分发(C++ 覆写为空;远程销毁 `callScript=false`) | 客户端侧清理放别处 | [api-client §偏差表](api-client.md) |

## client 面 API 可用性

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| 把 `KBEngine.login/createAccount/...` 当客户端 Python 函数 | `kbe/src` 任何 Python 面都未注册(插件层,本仓库之外) | 用插件 SDK 的函数,不是引擎模块 | [api-client §偏差表](api-client.md) |
| `KBEngine.findEntity(id)` | 无此注册 | `KBEngine.entities[entityID]` | [api-client §偏差表](api-client.md) |

## 源材料卫生

| 陷阱 | 现象 | 正确姿势 | 详情 |
| --- | --- | --- | --- |
| 照抄 3.7 CHM 示例 | Python 2 语法(`print "..."`)在 3.12 跑不起来 | 示例重写;材料表格当线索,fork 源码当事实 | [api-cellapp §偏差表](api-cellapp.md) |
