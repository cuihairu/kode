# bots 面 API 参考：`KBEngine` 模块、`bots` 注册表、客户端对象与 Entity

> KB-API-007（P1）· API 面的 bots 端。官方 `docs/api` 源料
> （kbengine fork `docs/api/kbengine/bots/{KBEngine.md, Entity.md,
> PyClientApp.md, index.md}`，CHM 转换）在此**全部重写**——原排版有词粘连，
> 且 bots 页混入了服务端 Entity 的内容。取证域为 `kbe/src`（位于
> `/home/cui/workspaces/kbengine`，HEAD `6d12b8f`，2026-11-04 于 HEAD 验证）；
> bots 的 C++ 源码在 `kbe/src/server/tools/bots/`。以下每一项均带
> `file:line` 锚点或显式 **待取证 / to be evidenced** 标记。偏离标注格式遵循
> [python-version-baseline §7](python-version-baseline.md)。
>
> **共享面说明：** bots 进程构建于嵌入式客户端库之上，其 `KBEngine` 模块、
> 客户端对象与 `Entity` 类型与 [api-client](api-client.md)（KB-API-002）记录
> 的是同一批 C++ 面。该篇对共享绑定具有权威性；本篇只重新锚定 bots 进程
> **新增或有差异**的部分：`addBots`、`bots` 注册表、入口脚本回调，以及源料
> 偏差。

## 1. bots 进程及其脚本面的组装

bots 是无渲染的客户端模拟器，用于对服务端做压测与浸泡测试：批量创建客户端、
走完 loginapp/baseapp 登录流程，然后回放实体流（`docs/api/kbengine/bots/index.md`；
进程类 `Bots : public ClientApp`，`kbe/src/server/tools/bots/bots.h:40`）。
入口：`KBENGINE_MAIN` 设 `g_componentType = BOTS_TYPE` 并运行
`kbeMainT<Bots>`（`kbe/src/server/tools/bots/main.cpp:60-62`）；共享 main
模板以 `KBEngine` 为名安装 Python 模块
（`kbe/src/lib/client_lib/kbemain.h:102`）。

脚本面由六个注册点组装：

| 注册点 | 注册内容 |
| --- | --- |
| `kbe/src/server/tools/bots/bots.cpp:174-182`（`Bots::installPyModules`） | `ClientObject` / `PyBots` 脚本类型（`:176-177`）、`bots` 注册表对象（`:179-180`）、模块函数 `addBots`（`:182`） |
| `bots.cpp:186-209` | int 常量 `LOG_TYPE_NORMAL/INFO/ERR/DBG/WAR` |
| `bots.cpp:211-228` | 从 `scripts/bots/<name>.py` 导入入口脚本（`:222`） |
| `kbe/src/lib/client_lib/clientapp.cpp:186-217`（`ClientApp::installEntityDef`） | 模块函数 `publish`、`fireEvent`、`player`、`getSpaceData`、`callback`、`cancelCallback`、`getWatcher`、`getWatcherDir`、`disconnect`、`kbassert`（`:191-200`），资源辅助 `getResFullPath`、`hasRes`、`open`、`listPathRes`、`matchPath`（`:203-215`） |
| `clientapp.cpp:233-268`（`ClientApp::installPyModules`） | 注册 `client::Entity` 与 `EntityComponent` 类型（`:236-237`）、`scriptLogType`（`:240`，与 bots 侧 `bots.cpp:185` 重复注册）、`LOG_TYPE_*` int（`:242-266`）、`entities` 映射对象（`:266`） |
| `kbe/src/lib/pyscript/script.cpp:247-258` + `kbe/src/lib/pyscript/pyurl.cpp:23` | `component` 字符串属性（`script.cpp:247-251`）、`genUUID64`（`:258`）、`urlopen`（`pyurl.cpp:23`） |

脚本面周围的进程设施：按配置绑定的 telnet 控制台（`bots.cpp:85-95`）、
`gameUpdateHertz` 频率的游戏 tick 定时器（`bots.cpp:72-74`，分发
`clientapp.cpp:343-353`）、机器人孵化定时器（§2.1）。入口脚本回调 `onInit`
与 `onFinish` 由进程自身驱动（§3）。

## 2. `KBEngine` 模块——函数

### 2.1 源料已记载的函数（8 个）

| 函数 | 签名 | 语义（bots 特有备注） | 注册 / 实现 |
| --- | --- | --- | --- |
| `addBots` | `addBots(totalCount)` 或 `addBots(totalCount, tickCount, tickTime)` | 请求在本 bots 进程创建 `totalCount` 个模拟客户端；`tickCount`/`tickTime` **仅在 > 0 时**覆盖每批数量与间隔；多次调用计数累加；参数个数非 1 或 3 时抛 `TypeError` | `bots.cpp:182`（注册）、`bots.cpp:344-387`（`__py_addBots`：个数检查 `:346/:365/:382-385`，累加 `:359-360`，仅正值覆盖 `:374-378`）；远端（非 Python）变体 `bots.cpp:321-342` |
| `callback(offset, cb) -> int` | — | 与 client 面共享，bots 上绑定一致 | `clientapp.cpp:195` |
| `cancelCallback(id)` | — | 共享 | `clientapp.cpp:196` |
| `genUUID64() -> int` | — | 共享；唯一性仍依赖 `gus` 启动参数 | `script.cpp:258`，警告路径 `:99-106` |
| `getWatcher(path)` / `getWatcherDir(path)` | — | 共享 watcher 查询 | `clientapp.cpp:197-198` |
| `scriptLogType(logType)` | — | 设置 `print` 输出级别；bots 上该名字**被注册两次**（bots 侧与 ClientApp 侧，参数约定相同） | `bots.cpp:185`（`bots.cpp:389-411`）与 `clientapp.cpp:240` |
| `urlopen(url, callback, postData, headers)` | — | 共享异步 HTTP(S)；POST 体必须为 `bytes`，回调收到 `(httpcode, data, headers, success, url)` | `pyurl.cpp:23`；POST bytes 检查 `pyurl.cpp:162` |

**`addBots` 是请求而非即时创建。** 源料示例（"一次加 5 个机器人……瞬时"）
言过其实：`__py_addBots` 只是在 `Bots` 单例上累加计数器。真正的客户端由
`CreateAndLoginHandler` 定时器创建：周期 1 秒
（`create_and_login_handler.cpp:18-22`），以 0.1 秒子 tick 递减限速
（`:43-50`），每次放行创建 `tickCount` 个 `ClientObject`，登录名形如
`<prefix><componentID>_<accountID>`（`:52-61`）；账号 ID 基数为
`genUUID64() * 100000`，除非配置了 `bots_account_name_suffix_inc`
（`:23-27`）。三个计数的默认值来自 `kbengine_defaults.xml` 的
`<defaultAddBots>`（`bots.cpp:41-43`；
`kbe/src/lib/server/serverconfig.cpp:1444-1463`）。

### 2.2 Fork 已注册而源料未记载的函数（11 个）

`publish`、`fireEvent`（模块级，字符串载荷——载荷限制见
[api-client §2](api-client.md)）、`player`、`getSpaceData`、`disconnect`、
`kbassert`、`getResFullPath`、`hasRes`、`open`、`listPathRes`、`matchPath`
——全部绑定于 `clientapp.cpp:191-215`，与 client 面一致。源料只记载了
bots 进程实际暴露的 19 个模块函数中的 8 个。

## 3. 入口脚本回调与模块属性

| 条目 | 类别 | 语义与取证 |
| --- | --- | --- |
| `onInit(isReload)` | 回调 | 全部脚本加载完成后在入口脚本上调用；bots 进程恒传 `isReload = 0`——不存在传 1 的重载路径（`bots.cpp:99-113`） |
| `onFinish()` | 回调 | 进程终结时调用，先于客户端清理与 telnet 停机（`bots.cpp:121-141`） |
| `onTargetChanged` | 回调（fork 独有，未记载） | 客户端目标实体变化时在入口脚本上调用（`clientapp.cpp:455-475`） |
| `bots` | 属性，只读 | 进程客户端注册表的 `PyBots` 映射，安装于 `bots.cpp:179-180`；见 §4.1 |
| `entities` | 属性，只读 | 进程的 `Entities<client::Entity>` 映射（`clientapp.cpp:266`；与 client 面同一对象） |
| `component` | 属性，只读字符串 | 本进程取值 `'bots'`：`Script::install` 写入 `COMPONENT_NAME_EX(componentType)`（`script.cpp:247-251`），bots main 设 `BOTS_TYPE`（`main.cpp:60-62`），且 `COMPONENT_NAME[11] == "bots"`（`kbe/src/lib/common/common.h:110`）——与 api-client 的 `component` 判定之关系见 §6 |
| `LOG_TYPE_*` | int 常量 | `NORMAL/INFO/ERR/DBG/WAR`，bots 侧（`bots.cpp:186-209`）与 ClientApp 侧（`clientapp.cpp:242-266`）各安装一次 |

## 4. 客户端对象

### 4.1 `bots` 注册表（`PyBots`）

源料把 `bots` 描述为"包含当前进程所有客户端对象的字典对象"。fork 对象是一个
**只读映射**（`mp_ass_subscript` 为 `NULL`，
`kbe/src/server/tools/bots/pybots.cpp:22-26`），底层是 `Bots::clients()`——
`std::map<Network::Channel*, ClientObject*>`（`bots.h:103`），即以客户端
网络 channel 为键，但脚本面通过 `findClientByAppID` 解析键（`bots.h:120`，
`pybots.cpp:70`）。脚本可见协议：

| 成员 | 行为 | 取证 |
| --- | --- | --- |
| `len(bots)` | 存活客户端数量 | `pybots.cpp:56-59` |
| `bots[appID]` | 对应 `ClientObject`；不存在则抛 `KeyError` | `pybots.cpp:62-79` |
| `has_key`、`keys`、`values`、`items`、`get` | dict 风格辅助；`get` 接受可选默认值 | `pybots.cpp:29-35`，实现 `:56-176` |

### 4.2 客户端对象类型——源料名 "PyClientApp"，fork 类型 `ClientObjectBase`

源料的 `PyClientApp` 类型名在 `kbe/src` 中**没有任何符号**（grep：0 命中）。
bots 的客户端对象是 `ClientObject`（`bots/clientobject.h:20`），它是
`ClientObjectBase`（`kbe/src/lib/client_lib/clientobjectbase.h:34`）的薄
子类，且**不添加任何脚本成员**（`clientobject.cpp:26-33`——各声明块全空）。
脚本面位于 `ClientObjectBase`：

| 成员 | 类别 | 取证 |
| --- | --- | --- |
| `getSpaceData(key)` | 方法；缺失键抛 `TypeError` | 声明 `clientobjectbase.cpp:21`；实现 `:2387-2448` |
| `callback`、`cancelCallback`、`getWatcher`、`getWatcherDir`、`disconnect`、`kbassert` | 方法 | 声明 `clientobjectbase.cpp:22-27` |
| `player()` | 方法；返回受控实体或 `None` | 声明 `clientobjectbase.cpp:28` |
| `id` | getset，int | 声明 `clientobjectbase.cpp:35`；C++ app-ID 计数从 1 起（`:40`） |
| `entities` | getset | 声明 `clientobjectbase.cpp:36` |

每个客户端对象经历连接状态机 `C_STATE_INIT →
C_STATE_INITLOGINAPP_CHANNEL → C_STATE_LOGIN →
C_STATE_LOGIN_BASEAPP_CHANNEL → C_STATE_LOGIN_BASEAPP → C_STATE_PLAY`
（`clientapp.h:41-48`），每个游戏 tick 推进一步（`clientapp.cpp:364-436`）；
baseapp 段在登录前先做 hello/blowfish 握手（`clientapp.cpp:377-404`）。
`Bots::handleGameTick` 每 tick 遍历全部客户端并剔除已销毁者
（`bots.cpp:266-296`）。

## 5. bots 上的 `Entity`——与 client 面同型，外加偏差

bots 的 `Entity` 是 `client::Entity`
（`kbe/src/lib/client_lib/entity.h:34`），由 `ClientApp::installPyModules`
注册（`clientapp.cpp:236`）——与 [api-client §4-5](api-client.md) 记录的面
完全一致。以 bots 本地锚点概述：

- **方法（9 个）：** `moveToPoint`、`cancelController`、`isPlayer`、
  `addTimer`、`delTimer`、`getComponent`（`entity.cpp:29-34`）、
  `registerEvent`、`deregisterEvent`、`fireEvent`（客户端宏
  `kbe/src/lib/entitydef/entity_macro.h:47-49`），另有双下划线管线
  `__reduce_ex__` / `__getDEP__`（`entity_macro.h:45-46`）。
- **属性（10 个）：** `id`、`spaceID`、`isDestroyed`、`className`
  （`entity_macro.h:58-61`）、`base`、`cell`、`clientapp`
  （`entity.cpp:41-43`）、`position`、`direction`、`velocity`（可读写，
  `entity.cpp:44-46`）。
- **回调：** `onEnterWorld` / `onLeaveWorld` / `onEnterSpace` /
  `onLeaveSpace`，由网络处理器分发（`entity.cpp:561-594`；触发点
  `clientobjectbase.cpp:935`、`:972`、`:1034`、`:1055`），另有 `addTimer`
  对应的 `onTimer`（`entity.cpp:894-898`）。
- `moveToPoint` 配套的 `cancelController` 接受数字 controller ID 或字符串
  `"Movement"`（`entity.cpp:787-830`）。

bots `Entity` 页源料特有的偏差见 §6。

## 6. 3.7 源料 vs fork 3.12 偏离

| 条目 | 官方 3.7 时代源料称 | fork 3.12 实际行为 | 域 | 证据 |
| --- | --- | --- | --- | --- |
| `addBots` 示例（"一次加 5 个……瞬时"） | 暗示机器人立即出现 | `__py_addBots` 只累加计数；客户端由 1 秒周期 `CreateAndLoginHandler` 定时器孵化，0.1 秒子 tick 限速 | Fork | `bots.cpp:344-387`；`create_and_login_handler.cpp:18-59` |
| bots 模块函数记载 | 8 个（`addBots callback cancelCallback genUUID64 getWatcher getWatcherDir scriptLogType urlopen`） | 实际注册 19 个；11 个未记载（`publish fireEvent player getSpaceData disconnect kbassert getResFullPath hasRes open listPathRes matchPath`） | Fork | `bots.cpp:182-185`；`clientapp.cpp:191-215`；`script.cpp:258`；`pyurl.cpp:23` |
| `Entity` 成员函数清单 | 7 个（漏计时器） | bots Entity 上 `addTimer` / `delTimer` 同样脚本可见 | Fork | `entity.cpp:32-33` |
| `Entity.isOnGround` 属性 | 可读写 bool，同步 | 仅有 C++ 成员（`entity.h:172-173`），由网络流更新（`clientobjectbase.cpp:828-875`）；**未声明脚本 getter/setter**——作为脚本属性属于插件层 | 待取证 / to be evidenced——取证路径：对比官方 SDK 插件 Entity 类 | `entity.h:172-173`；无对应 `SCRIPT_GET(SET)_DECLARE` |
| `Entity.cellData` 一节 | 记载为 bots Entity 的 dict 属性 | `client_lib` 中**根本没有 `cellData`**（grep：0 命中）——该节是服务端 Entity 内容泄入 bots 页 | Fork | grep `cellData lib/client_lib`：0 命中 |
| `PyClientApp` 类名 | 记载为 KBEngine 模块的类 | `kbe/src` 无此符号；实际类型为 `ClientObjectBase`（bots 子类 `ClientObject` 不加成员） | Fork | grep `PyClientApp`：0 命中；`clientobjectbase.h:34`；`clientobject.cpp:26-33` |
| `bots` "字典" | 普通客户端对象字典 | 以客户端 app-ID 为键的只读映射（底层 channel 映射）；未知键抛 `KeyError` | Fork | `pybots.cpp:22-26`、`:62-79`；`bots.h:103`、`:120` |
| `onInit(isReload)` | 通用初始化回调 | bots 恒传 `isReload = 0` | Fork | `bots.cpp:99-113` |
| `KBEngine.component` | 只读字符串 | 由共享 `Script::install` 在 bots 上注册为 `'bots'`；此行取代 api-client §3 的判定——该处 grep 只扫了 `lib/client_lib`（注册点在 `lib/pyscript`） | Fork | `script.cpp:247-251`；`common.h:110`；`kbemain.h:102`；`main.cpp:60-62` |
| `scriptLogType` 重复注册 | 单一模块函数 | bots 上注册两次（Bots 侧与 ClientApp 侧），均在导入期生效 | Fork | `bots.cpp:185`；`clientapp.cpp:240` |
| `onTargetChanged` | 未记载 | bots/client app 的真实入口脚本回调 | Fork | `clientapp.cpp:455-475` |
| 运行时基线 | CHM 面向嵌入式 3.7.3 编写 | fork 构建 3.12；bots 面全部绑定均为版本中性 C API | Fork | 见 [python-version-baseline §2](python-version-baseline.md) |

## 覆盖小结

19 个模块函数（8 已记载 + 11 fork 独有）、3 个入口脚本回调（2 已记载 +
1 fork 独有）、7 个模块属性/常量、`PyBots` 映射的 5 个成员、客户端对象面的
8 方法 / 2 getset，以及 `Entity` 面的 9 方法 / 10 属性 / 5 回调——全部带
HEAD `6d12b8f` 的 `file:line` 锚点。

## 参考

- Fork：`kbe/src/server/tools/bots/`——`main.cpp:60-62`、`bots.h:40`、
  `:103`、`:115-120`、`bots.cpp:36-43`、`:72-95`、`:99-141`、`:174-228`、
  `:242-249`、`:260-296`、`:321-342`、`:344-411`、
  `create_and_login_handler.cpp:18-59`、`clientobject.cpp:26-33`、
  `pybots.cpp:22-176`
- Fork（共享 client 面）：`kbe/src/lib/client_lib/`——`kbemain.h:102`、
  `clientapp.h:41-48`、`clientapp.cpp:186-217`、`:233-268`、`:343-436`、
  `:455-475`、`clientobjectbase.h:34`、`clientobjectbase.cpp:20-40`、
  `:2387-2448`、`entity.h:34`、`:172-173`、`entity.cpp:29-46`、`:561-594`、
  `:787-830`、`:894-898`
- Fork（共享脚本层）：`kbe/src/lib/pyscript/script.cpp:247-258`、
  `pyurl.cpp:23`、`:162`；`kbe/src/lib/entitydef/entity_macro.h:45-49`、
  `:56-64`；`kbe/src/lib/common/common.h:110`；
  `kbe/src/lib/server/serverconfig.cpp:1444-1463`
- 源料（重写，非照抄）：kbengine `docs/api/kbengine/bots/KBEngine.md`、
  `Entity.md`、`PyClientApp.md`、`index.md`（CHM 转换；词粘连排版）
- 基线与标注规则：[python-version-baseline](python-version-baseline.md)
  （§7 模板）
- 同批篇目：[api-client](api-client.md)（共享 client_lib 面）、
  [api-baseapp](api-baseapp.md) / [api-cellapp](api-cellapp.md)（bots 所连
  接的服务端面）
