# Python 生命周期钩子

本页依据 KBEngine `2.5.12`（`7d379b9`）的源码。参数表省略 Python 方法的 `self`。分析其他版本时，将脚本宿主、派发函数、参数构造和触发分支一起与目标源码对照。

## 查找派发点

从技能目录执行下列命令。无名称参数时列出扫描范围内的字面量派发点。

```sh
python3 scripts/find-lifecycle-hooks.py onTeleportSuccess
python3 scripts/find-lifecycle-hooks.py onAttached --src /path/to/kbengine/kbe/src
python3 scripts/find-lifecycle-hooks.py --include-lookups
```

扫描覆盖服务端进程和服务器、实体定义、客户端、脚本、数学与导航核心库中的 C++ 文件。它识别 `PyObject_CallMethod`、`SCRIPT_OBJECT_CALL_ARGS*` 和 `bufferOrExeCallback` 等常见派发。基线检出得到 82 个不同名字、111 处派发点。属性查找以 `lookup` 标记，可供追踪间接调用。遇到动态字符串、字段同步生成的 setter、通过对象直接调用的回调或各语言 SDK，需要沿对应注册器或分发器补查。对每个命中的派发函数，还要找到它的调用者和守卫。

## 进程入口脚本

| 宿主 | 查找入口 | 关键时序 |
| --- | --- | --- |
| BaseApp | [启动与登录就绪](source/kbe/src/server/baseapp/initprogress_handler.cpp)，[关闭、启动钩子和共享数据](source/kbe/src/server/baseapp/baseapp.cpp)，[自动加载](source/kbe/src/server/baseapp/entity_autoloader.cpp) | `onInit(0)` 在初始化；`onBaseAppReady(isBootstrap)` 和可选的 `onReadyForLogin(isBootstrap)` 有各自的执行阶段。登录就绪可被轮询。关闭阶段向 `onBaseAppShutDown(state)` 传 0、1、2；`onReadyForShutDown()` 参与判断。 |
| CellApp | [初始化](source/kbe/src/server/cellapp/initprogress_handler.cpp)，[共享数据](source/kbe/src/server/cellapp/cellapp.cpp)，[空间与几何](source/kbe/src/server/cellapp/spacememory.cpp) | `onInit(0)` 在初始化；`onReadyForLogin(groupOrder)` 接收组顺序。`onSpaceData(spaceID, key, value)` 可收到删除路径的 `None`。几何回调分别查单个 mapping 完成和全部 mapping 完成的调用点。 |
| BaseApp / CellApp 重载 | [实体组件重载入口](source/kbe/src/lib/server/entity_app.h#L1452) | `EntityDef::reload` → 组件 `onReloadScript` → 入口模块 `onInit(1)`。BaseApp、CellApp 各自遍历当前实体调用其 C++ `reload`。 |
| LoginApp / DBMgr | [LoginApp](source/kbe/src/server/loginapp/loginapp.cpp)，[DBMgr](source/kbe/src/server/dbmgr/dbmgr.cpp) | 区分启动就绪、账号创建/登录发起、DB 回包、登录通道丢失、账号 DB 接口选择、关闭询问和关闭通知。 |
| Interfaces / Logger | [Interfaces](source/kbe/src/server/tools/interfaces/interfaces.cpp)，[Logger](source/kbe/src/server/tools/logger/logger.cpp) | Interfaces 派发账号、登录和充值请求。Logger 的 `onLogWrote` 与就绪、关闭询问、关闭通知是独立入口。 |
| 原生 Client / Bots | [ClientApp](source/kbe/src/lib/client_lib/clientapp.cpp)，[Bots](source/kbe/src/server/tools/bots/bots.cpp) | 分别核对 `onInit`、`onFinish`，以及 ClientApp 的 `onTargetChanged`。 |

## 实体、Proxy、组件和原生客户端

| 钩子或路径 | 宿主与实参 | 触发条件和源码 |
| --- | --- | --- |
| `__init__()` | 实体、实体组件 | 普通实体初始化先准备命名空间，然后运行组件 `__init__`、实体 `__init__`、设置 owner 后的组件 `onAttached`。恢复、迁移和客户端缓存重放各有独立入口。 [普通初始化](source/kbe/src/lib/entitydef/entity_macro.h#L288) · [客户端对象建立](source/kbe/src/lib/client_lib/clientobjectbase.cpp) |
| `onAttached(owner)`、`onDetached(owner)` | 实体组件，各一个 owner 对象 | 两个 Python 方法各有存在性检查。普通挂载先更新 owner，客户端反序列化还有挂载路径。owner 销毁开始阶段在 `callScript` 为真时派发卸载，销毁结束再释放组件持有的 owner 引用。 [组件派发与清理](source/kbe/src/lib/entitydef/entity_component.cpp#L250) |
| `onGetCell()`、`onCreateCellFailure()`、`onLoseCell()` | Base 实体及组件 | 异步创建 Cell。成功先收起 `cellData` 属性并建立 Cell 代理，恢复路径有跳过 `onGetCell` 的守卫。失败先清创建相关标记。失去 Cell 先清代理和状态，此路径不重装 `self.cellData`。 [Base 派发](source/kbe/src/server/baseapp/entity.cpp#L1014) |
| `onRestore()` | Base、Cell，各零参 | Base 查恢复处理器及其等待条件。Cell 查新空间恢复、已有空间恢复与普通 `initializeScript` 的分支。 [Base 恢复处理器](source/kbe/src/server/baseapp/restore_entity_handler.cpp) · [Cell 创建与恢复](source/kbe/src/server/cellapp/cellapp.cpp) |
| `onPreArchive()`、`onWriteToDB(...)` | Base 的 `onWriteToDB(cellData)` 收到内部快照或 `None`；Cell 的 `onWriteToDB()` 零参 | Base 的 `onPreArchive()` 在 Cell 写库协作完成路径派发。快照参数和运行时脚本属性 `self.cellData` 分开核对。提交确认沿 DBMgr 处理及 Base 写库结果回调查证。 [Base 归档](source/kbe/src/server/baseapp/entity.cpp#L1289) · [Base 快照参数](source/kbe/src/server/baseapp/entity.cpp#L1399) · [Cell 派发](source/kbe/src/server/cellapp/entity.cpp#L1259) |
| `onTeleportSuccess`、`onTeleportFailure()` | Base 成功回调零参；Cell 成功回调只传 `nearbyEntity`；两边失败回调均零参 | Cell 的 C++ `lastSpaceID` 用于内部 Base 回执。Cell 侧 `onTeleport()` 有派发函数，在基线服务器源码中未找到连接该函数的调用者，普通 `Cell.teleport` 的时序以实际成功/失败派发为准。 [Base 派发](source/kbe/src/server/baseapp/entity.cpp#L1552) · [Cell 派发](source/kbe/src/server/cellapp/entity.cpp#L3778) |
| 进出空间、迁移、观察与控制 | Cell 实体及其调用链 | 查 `onEnterSpace` / `onLeaveSpace`、`onEnteringCell` / `onEnteredCell` / `onLeavingCell` / `onLeftCell`、`onSpaceGone`、`onGetWitness` / `onLoseWitness` / `onWitnessed`、`onEnteredView`、Trap、移动与控制权钩子。`onUpdateBegin` 和 `onUpdateEnd` 由 Witness 更新流程派发。 [Cell 实体](source/kbe/src/server/cellapp/entity.cpp) · [Witness](source/kbe/src/server/cellapp/witness.cpp) |
| 连接、重连与代理交接 | Base 的 Proxy | 查 `onClientEnabled()`、`onClientDeath()`、`onClientGetCell()`、`onGiveClientToFailure()`、`onLogOnAttempt(ip, port, password)`、`onStreamComplete(id, success)`。连接建立、重连替换旧通道、移交客户端和真正注销通道有独立分支。 [Proxy](source/kbe/src/server/baseapp/proxy.cpp) · [BaseApp](source/kbe/src/server/baseapp/baseapp.cpp) |
| `onEnterWorld()` / `onLeaveWorld()`、`onEnterSpace()` / `onLeaveSpace()` | 原生 C++ 客户端库内的 Python 实体与组件，以上各零参 | 世界和空间各有派发函数。对象是否复用、缓存属性重放、空间消息和断线清理要从实际分支判断。客户端还有玩家身份切换、控制权、定时器和移动回调。其他语言 SDK 查各自实现。 [原生客户端实体](source/kbe/src/lib/client_lib/entity.cpp#L561) · [客户端消息处理](source/kbe/src/lib/client_lib/clientobjectbase.cpp) |
| `onDestroy()`、`onTimer(timerID, userArg)` | 实体 | 销毁检查 Base/Cell 的脚本派发守卫。跨 CellApp 迁移的源端清理可以走 `callScript=false`。实体定时器由实体生命周期清理；应用级定时器独立维护。 [Base 实体](source/kbe/src/server/baseapp/entity.cpp) · [Cell 实体](source/kbe/src/server/cellapp/entity.cpp) · [实体定时器清理](source/kbe/src/lib/entitydef/entity_macro.h#L1021) |

实体和组件的相对顺序由调用点所用的宏决定。`CALL_ENTITY_AND_COMPONENTS_METHOD` 先调用实体，`CALL_COMPONENTS_AND_ENTITY_METHOD` 先调用组件。验证顺序时，给每条日志附上组件 ID、实体 ID、空间 ID 和实际进入的分支。 [派发宏](source/kbe/src/lib/entitydef/entity_component.h#L16)
