# client 面 API 参考：KBEngine 模块与 Entity

> KB-API-002（P0）· API 面的 client 端。官方 `docs/api` 源料
> （`kbengine/docs/api/kbengine/client/`，CHM 转换）在此**全部重写**——原排版
> 机器粘连（如 "ThisKBEngine" 这类词粘连），且混入了两种不同实现层而不加区分。
> 以下每一项均按 [python-version-baseline §7](python-version-baseline.md) 的
> 口径标注取证域：**Fork**（`kbe/src` file:line，kbengine HEAD `6d12b8f`，
> 基准 `c2a3b8f`）、**Python**（官方 `docs.python.org`）或
> **插件层 Plugin-layer**（实现于客户端 SDK 插件，仓库外——此类不捏造行号）。
> 同批篇目：[入口脚本 SPI 方法表](entry-script-spi-methods.md)、
> [Entity 生命周期与对象引用释放](entity-lifecycle-reference.md)、
> [Python 版本基线](python-version-baseline.md)。完整 KB-API 批次见知识库
> 索引（README Articles）。

## 1. 一个面，两层实现

CHM 源料记载的 client 面是一个**混合面**：它描述的是游戏客户端看到的表面，
但实现分布在两个完全不同的位置：

| 层 | 所在位置 | 提供什么 | 取证方式 |
| --- | --- | --- | --- |
| 嵌入式 C++ 面（`client_lib`） | `kbe/src/lib/client_lib/`——编入 bots 工具与任何嵌入式 Python 客户端；安装 Python 模块 **`KBEngine`**（`kbe/src/lib/client_lib/kbemain.h:102`） | 模块函数 `player`、`getSpaceData`、`fireEvent`、`callback` 等；C++ `Entity` 类型及其脚本方法/属性 | `kbe/src` `file:line`（Fork） |
| 客户端 SDK 插件层 | 官方客户端插件（unity3d / ogre / html5 demo 等，**不在本仓库**——`kbe/src/client/README.md` 仅给出链接） | `KBEngine.login`、`createAccount`、`reloginBaseapp`、`resetPassword`、`bindAccountEmail`、`newPassword`、`findEntity`，以及 `entity.baseCall/cellCall` 与各便捷属性 | 插件层，以官方 SDK 文档为源 |

源料 `docs/api/kbengine/client/index.md` 自己就说明了这一分工：引擎不附带
完整客户端，由插件「处理与服务器的通信、注册账号、登录界面，提供 Entity
基类」。所以：**凡涉及连接/登录流程的都在插件层；凡涉及实体注册表与 space
数据的都在 `client_lib`。**

## 2. `KBEngine` 模块——函数

### 2.1 Fork 已注册的模块函数

在 `ClientApp::installEntityDef()` 中注册到 `KBEngine` 模块
（`kbe/src/lib/client_lib/clientapp.cpp:191-215`）；模块名本体由
`script.install(..., "KBEngine", componentType)` 安装
（`kbe/src/lib/client_lib/kbemain.h:102`）。

| 函数 | 签名 | 取证域 | 注册 / 实现 |
| --- | --- | --- | --- |
| `player` | `player() -> Entity \| None` | Fork | `clientapp.cpp:193`；实现 `clientobjectbase.cpp:1159-1171` |
| `getSpaceData` | `getSpaceData(key: str) -> str` | Fork | `clientapp.cpp:194`；实现 `clientobjectbase.cpp:2420-2450` |
| `fireEvent` | `fireEvent(eventName: str, data: str)` | Fork | `clientapp.cpp:192`；实现 `clientapp.cpp:493+` |
| `callback` | `callback(time: float, callbackObj) -> int` | Fork | `clientapp.cpp:195`；实现 `clientobjectbase.cpp:254-284` |
| `cancelCallback` | `cancelCallback(callbackID: int)` | Fork | `clientapp.cpp:196`；实现 `clientobjectbase.cpp:287-309` |
| `getWatcher` / `getWatcherDir` | watcher 查询 | Fork | `clientapp.cpp:197-198` |
| `disconnect` | `disconnect()` | Fork | `clientapp.cpp:199` |
| `kbassert` | 调试断言挂点 | Fork | `clientapp.cpp:200` |
| `publish` | 应用 publish 状态 | Fork | `clientapp.cpp:191` |
| `getResFullPath`、`hasRes`、`open`、`listPathRes`、`matchPath` | 资源路径辅助 | Fork | `clientapp.cpp:204-215` |

源料只提到 `player`、`getSpaceData`、`fireEvent` 三个；其余均为源料未提及的
fork 取证新增项。

#### `player()`

返回当前客户端控制的实体；不存在时（如未登录）返回 `None`。C++ 路径是
`ClientObjectBase::pPlayer()`——用客户端的 `entityID_` 在活跃注册表里直接
查找（`kbe/src/lib/client_lib/clientobjectbase.cpp:1153-1156`）——再由
`__py_getPlayer` 包装，INCREF 后返回实体或 `S_Return`（→ `None`）
（`clientobjectbase.cpp:1159-1171`）。背后的注册表正是
[Entity 生命周期](entity-lifecycle-reference.md)所述的同一个 `Entities<T>`
映射。

#### `getSpaceData(key)`

返回 `key` 对应的 space 数据字符串。space 数据由服务端下发（服务端
`setSpaceData`），客户端存于 `spacedatas_` 映射。`__py_GetSpaceData` 在参数
个数不对、以及 key 不存在时抛 `TypeError`——**key 缺失是异常，不是
`None`**（`kbe/src/lib/client_lib/clientobjectbase.cpp:2420-2450`）。

#### `fireEvent(eventName, data)`

模块级事件派发：把参数包成 `EventData_Script` 后向客户端事件处理器派发
（`clientapp.cpp:493+`）。注意 fork 的签名：`args[1]` 经
`PyUnicode_AsUTF8AndSize` 转换，即载荷是**字符串**而非任意对象。实体范围的
事件用 `Entity.fireEvent`（§4）；CHM 源料只记载了实体级的那一个。

### 2.2 插件层函数（实现不在本仓库）

这些是真实游戏客户端会调用的函数，但 **`kbe/src` 中不存在任何 Python 可见
的注册点**——它们实现于官方客户端 SDK 插件内部。按取证规则标为插件层，
不捏造行号。fork 仓库里有的是各插件触发的底层网络协议路径（同样未注册到
Python，仅为溯源列出）：

| 函数（插件签名） | 源料语义 | 取证域 | 备注 |
| --- | --- | --- | --- |
| `login(username, password)` | 经 loginapp 登录 KBEngine 服务器；UI 层被告知改为触发 `"login"` 事件而非直接调用 | 插件层 | 协议路径存在：`ClientObjectBase::login()` 发送 `LoginappInterface::login`（`clientobjectbase.cpp:604-632`）——无 Python 注册 |
| `createAccount(username, password)` | 请求在服务器上创建账号；UI 触发 `"createAccount"` | 插件层 | 协议路径：`ClientObjectBase::createAccount()`（`clientobjectbase.cpp:449-459`） |
| `reloginBaseapp()` | 掉线后向 baseapp 重登录，比完整登录快；UI 触发 `"reloginBaseapp"` | 插件层 | 协议路径：`ClientObjectBase::reloginBaseapp()` 携 name/password/rndUUID/entityID 发送 `BaseappInterface::reloginBaseapp`（`clientobjectbase.cpp:655-668`） |
| `resetPassword(username)` | 请求 loginapp 发送密码重置邮件 | 插件层 | `kbe/src` 未找到实现 |
| `bindAccountEmail(emailaddress)` | 请求 baseapp 为账号绑定邮箱 | 插件层 | `kbe/src` 未找到实现 |
| `newPassword(oldpassword, newpassword)` | 为账号设置新密码 | 插件层 | `kbe/src` 未找到实现 |
| `findEntity(entityID)` | 按 ID 查找实体实例 | 插件层 | **`client_lib` 中完全无注册点**——fork 侧的等价写法是对已注册的 `entities` 对象做 `KBEngine.entities[entityID]`（§3） |

## 3. `KBEngine` 模块——属性

| 属性 | 源料说法 | 对照 fork 的结论 | 取证域 |
| --- | --- | --- | --- |
| `entities` | 进程内所有实体的字典，键含 `entity_uuid`/`entity_id`/`spaceID` | **entities 映射本身是 fork 实有的**：`ClientApp` 向模块安装一个 `Entities<client::Entity>` 对象（`kbe/src/lib/client_lib/clientapp.cpp:266`，卸载于 `:228`）；其脚本方法为 `has_key/keys/values/items/get` 加 `garbages` 注册表（`kbe/src/lib/entitydef/entities.h:114-126`） | Fork（映射本体） |
| `entities.entity_uuid` / `entities.entity_id` / `entities.spaceID` | 映射上的类型化子属性 | fork 的 `Entities<T>` 脚本类型上不存在这些子属性；作为客户端脚本的便捷变量属于插件层 | 插件层 |
| `component` | 只读字符串，取值 `'cellapp' 'baseapp' 'client' 'dbmgr' 'bots' 'editor'` | `lib/client_lib` 中不存在名为 `component` 的脚本注册（grep：0 命中）；组件身份是 C++ 编译期常量（`g_componentType`），不是模块属性 | **待取证**——插件侧属性；取证路径：比对官方 SDK 插件源码中 `component` 的暴露方式 |

## 4. `Entity` 类——成员函数

C++ 类型是 `client::Entity`（`kbe/src/lib/client_lib/entity.h:34`，
`script::ScriptObject` 的子类），由 `ClientObjectBase::createEntity`
逐实体构造（`clientobjectbase.cpp:312-385`）。其 Python 表面声明在两处：
客户端实体公共宏（`kbe/src/lib/entitydef/entity_macro.h:42-53`）与类内
表（`kbe/src/lib/client_lib/entity.cpp:27-46`）。

### 4.1 源料记载的函数

| 函数 | 签名 | 语义与触发时机 | 取证域 | 取证 |
| --- | --- | --- | --- | --- |
| `isPlayer` | `isPlayer() -> bool` | 实体 ID 等于客户端控制的 `entityID_` 时为真 | Fork | 声明 `entity.cpp:31`；实现 `entity.cpp:840-853` |
| `getComponent` | `getComponent(componentName: str, all: bool = False)` | 按类型名取挂接的实体组件；`all=True` 返回全部实例的元组，`False` 返回第一个或 `None` | Fork | 声明 `entity.cpp:34`；实现 `entity_macro.h:1276-1355` |
| `fireEvent` | `fireEvent(eventName: str, *args)` | 实体范围事件派发进 `events_` | Fork | 声明 `entity_macro.h:49`（客户端宏 `:42-53`） |
| `registerEvent` | `registerEvent(eventName: str, callbackObj)` | 向实体 `events_` 映射存入回调 | Fork | 声明 `entity_macro.h:47` |
| `deregisterEvent` | `deregisterEvent(eventName: str, callbackObj)` | 移除已存回调 | Fork | 声明 `entity_macro.h:48` |
| `baseCall` | `baseCall(methodName: str, *args)` | 远程调用实体 base 部分；无返回值（远程调用） | 插件层 | `client_lib` 无 Python 注册；fork 仅以 `base` getter 暴露 base 端点（§4.3）。CHM 示例是 js/c# 插件代码 |
| `cellCall` | `cellCall(methodName: str, *args)` | 远程调用实体 cell 部分；无返回值（远程调用） | 插件层 | 同上——仅 `cell` getter 在 fork 侧 |

### 4.2 Fork 独有函数（源料未记载）

| 函数 | 签名 | 取证域 | 取证 |
| --- | --- | --- | --- |
| `moveToPoint` | 移动请求，由 `moveto_point_handler` 处理 | Fork | `entity.cpp:29` |
| `cancelController` | 取消进行中的移动/控制器 | Fork | `entity.cpp:30` |
| `addTimer` / `delTimer` | 脚本定时器 → `onTimer` 回调 | Fork | `entity.cpp:32-33`；派发 `entity.cpp:894-898` |
| `__reduce_ex__`、`__getDEP__` | pickle / 属性变更事件管线 | Fork | `entity_macro.h:44-45` |

### 4.3 Entity 属性（getter）

声明于 `CLIENT_ENTITY_GETSET_DECLARE_BEGIN`（`entity_macro.h:56-62`）与
`entity.cpp:40-46`：

| 属性 | 类型 | 语义 | 取证域 | 取证 |
| --- | --- | --- | --- | --- |
| `id` | 只读 int | 实体 ID；getter 宏返回 `id_` | Fork | `entity_macro.h:58`，实现 `:689` |
| `spaceID` | 只读 int | 实体所在 space 的 ID | Fork | `entity_macro.h:59`，实现 `:739` |
| `className` | 只读 string | def 模块中的实体类型名 | Fork | `entity_macro.h:61`，实现 `:1496` |
| `isDestroyed` | 只读 bool | 销毁标志（CHM 源料未记载） | Fork | `entity_macro.h:60` |
| `position` | 可读写 `Vector3` | 世界坐标；由服务端同步，客户端侧写入经 `updatePlayerToServer` 上送 | Fork | `entity.cpp:44`；同步路径 `clientobjectbase.cpp:1193-1275` |
| `direction` | 可读写 `Vector3` | （roll, pitch, yaw）弧度；同步纪律同 `position` | Fork | `entity.cpp:45` |
| `velocity` | 可读写 float | `moveToPoint` 使用的移动速度（CHM 源料未记载） | Fork | `entity.cpp:46` |
| `base` / `cell` | 只读 EntityCall | base/cell 部分的端点；服务端授予前为 `None` | Fork | `entity.cpp:41-42`，实现 `entity.cpp:110-131` |
| `clientapp` | 只读 | 所属客户端 app 对象 | Fork | `entity.cpp:43` |

CHM 源料记载、但 **fork 的客户端 Entity 未注册**的属性：

| 属性 | 源料说法 | 结论 | 取证域 |
| --- | --- | --- | --- |
| `isOnGround` | 可读写 bool；客户端控制实体变更后上送服务端 | C++ 成员 `isOnGround_` 存在且由网络流更新（`entity.cpp:65`、`clientobjectbase.cpp:868`），但**未声明任何脚本 getter/setter**——作为脚本可见属性属插件层 | **待取证**——取证路径：比对官方 SDK 插件的实体类 |
| `inWorld` | 只读 bool | `enterworld_` 是 C++ 内部标志（`entity.cpp:61`）；未声明脚本 getter | **待取证**——同上取证路径 |

## 5. `Entity` 回调

引擎从网络处理器驱动这些回调；脚本方法经
`CALL_ENTITY_AND_COMPONENTS_METHOD` 派发器调用（`entity.cpp:561-594`）。

| 回调 | 触发时机 | 取证域 | 取证 |
| --- | --- | --- | --- |
| `onEnterWorld` | 实体进入世界；玩家实体则先成为 player | Fork | 派发 `entity.cpp:561-568`；触发点 `clientobjectbase.cpp:930-935`（`onBecomePlayer` :932，`onEnterWorld` :935） |
| `onLeaveWorld` | 实体离开世界/视野范围 | Fork | 派发 `entity.cpp:570-577`；触发点 `clientobjectbase.cpp:969-972` |
| `onEnterSpace` | 受控实体进入新 space | Fork | 派发 `entity.cpp:580-586`；触发点 `clientobjectbase.cpp:1034` |
| `onLeaveSpace` | 受控实体离开当前 space | Fork | 派发 `entity.cpp:588-594`；触发点 `clientobjectbase.cpp:1055` |
| `onTimer(timerID, userArg)` | `addTimer` 到期 | Fork | `entity.cpp:894-898` |
| `onDestroy` | 源料：「实体被销毁时调用」 | **待取证** | fork 嵌入式客户端的销毁路径调用的是 *C++* `onDestroy(callScript)`——`client::Entity` 上的**空**覆盖（`entity.h:144`），由 `destroy()` 调用（`entity_macro.h:1010-1032`，调用点 `:1020`）；远程销毁路径传 `callScript=false`（`clientobjectbase.cpp:204-215`、`:1080`），故 `client_lib` 内不存在脚本可见的 `onDestroy` 派发。取证路径：比对官方 SDK 插件实体类 |

### 属性广播：`set_<propertyName>`

带客户端广播标志的 cell 属性变更时，引擎在客户端实体上调用
`set_<name>`：`Entity::callPropertysSetMethods()` 拼 `"set_" + name` 标识符
并以旧值为参调用（`entity.cpp:855-891`）；进世界时按
`isOnInitCallPropertysSetMethods` 配置执行（`clientobjectbase.cpp:937-942`），
属性更新时亦执行（`entity.cpp:30-46`，`onDefDataChanged` 于
`entity.cpp:36-45`）。与 CHM 的 `set_[property]` 描述一致，但此处给出的是
fork 取证而非断言。

## 6. 3.7 源料 vs fork 3.12 偏离

| 条目 | 官方 3.7 时代源料说法 | fork 3.12 实际行为 | 域 | 取证 |
| --- | --- | --- | --- | --- |
| `KBEngine.login/createAccount/reloginBaseapp/resetPassword/bindAccountEmail/newPassword` | 记载为客户端的 Python 模块函数 | `kbe/src` 中未注册到任何 Python 表面；仅存在底层协议发送路径（未注册的 C++） | 插件层 | 仓库外；协议路径 `clientobjectbase.cpp:604-632`、`:449-459`、`:655-668` |
| `KBEngine.findEntity` | 记载为模块函数 | `client_lib` 无注册点；等价查找为 `entities[entityID]` | 插件层 | grep `client_lib` 的 `findEntity`：0 命中；注册表 `clientapp.cpp:266` |
| `KBEngine.entities`「含 `entity_uuid`/`entity_id`/`spaceID`」 | 记载为 entities 映射的类型化子属性 | fork 的 `Entities<T>` 仅暴露 `has_key/keys/values/items/get/garbages` | 插件层 | `entitydef/entities.h:114-126` |
| `KBEngine.component` | 只读字符串属性 | `lib/client_lib` 无脚本注册 | 待取证 | grep `lib/client_lib` 的 `"component"`：0 命中 |
| `Entity.baseCall/cellCall` | 记载为 Entity 方法（示例为 js/c#） | `client_lib` 未注册；仅存在 `base`/`cell` EntityCall getter | 插件层 | `entity.cpp:40-46` |
| `Entity.isOnGround` | 可读写脚本属性 | 仅为 C++ 成员，无脚本绑定 | 待取证 | `entity.cpp:65`、`clientobjectbase.cpp:868`，无 `SCRIPT_GET(SET)_DECLARE` |
| `Entity.inWorld` | 只读脚本属性 | C++ 内部 `enterworld_`，无脚本绑定 | 待取证 | `entity.cpp:61` |
| `Entity.onDestroy` | 销毁时的脚本回调 | 嵌入式客户端从不派发（空 C++ 覆盖；远程销毁 `callScript=false`） | 待取证 | `entity.h:144`、`entity_macro.h:1010-1032`、`clientobjectbase.cpp:1080` |
| 运行时基线 | CHM 按嵌入式 3.7.3 编写 | fork 构建为 3.12（Windows）/ 解释器无关（Linux）；对 client 面无影响——以上绑定均为版本中立的 C API | Fork | 见 [python-version-baseline §2](python-version-baseline.md) |
| 模块级 `fireEvent`、`callback`、定时器、`getWatcher*`、资源辅助 | 源料中不存在 | 已注册于 fork 的 `KBEngine` 模块 | Fork | `clientapp.cpp:191-215` |

## References

- Fork：`kbe/src/lib/client_lib/clientapp.cpp`（`:103-110`、`:191-215`、
  `:228`、`:266`、`:493+`）、`clientobjectbase.cpp`（`:20-37`、`:204-215`、
  `:254-309`、`:312-385`、`:449-459`、`:604-632`、`:655-668`、`:824-1081`、
  `:1153-1171`、`:1193-1275`、`:2420-2450`）、`entity.cpp`（`:27-46`、
  `:36-45`、`:61`、`:65`、`:110-131`、`:561-594`、`:840-853`、`:856-891`、
  `:894-898`）、`entity.h`（`:32`、`:144`）、
  `kbe/src/lib/client_lib/kbemain.h:102`、
  `kbe/src/lib/entitydef/entity_macro.h`（`:42-53`、`:56-62`、`:689`、
  `:739`、`:1010-1032`、`:1276-1355`、`:1496`）、
  `kbe/src/lib/entitydef/entities.h:114-126`
- 源料（重写，未照抄）：kbengine `docs/api/kbengine/client/` 的
  `KBEngine.md`、`Entity.md`、`index.md`（CHM 转换；词粘连排版）
- 基线与标注规则：[python-version-baseline](python-version-baseline.md)
  （§7 模板、§6 fork-over-docs 规则）
- 客户端 SDK 插件：仓库外（`kbe/src/client/README.md` 链接官方 demo）——
  上表插件层各行以官方 SDK 文档为源
