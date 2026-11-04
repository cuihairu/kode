# API 核心概念：跨切面地图

> 范围：梳理 KBEngine API 各页（`docs/api/kbengine/`）中反复出现的共有概念，按**跨 app 共有概念 → 各 app 差异 → 生命周期总图**组织。本文是概念地图，不是函数目录：每个被提到的 API 在各自页面都有完整文档，这里只讲什么在各处重复、什么因 app 而异、以及各部分如何拼合。
>
> 对齐基准：HEAD `6d12b8f` 时的 `docs/api/kbengine/`。这些页面的出处是 `docs/api/kbengine/kbengine_api(cn).chm` / `kbengine_api(en).chm`（见 [API 总览](/api/kbengine/)）。英文原版：[/knowledge/api-core-concepts](/knowledge/api-core-concepts)。

## 1. 跨 app 的共有概念

### 1.1 一个实体，多个部分

API 文档中最承重的概念：同一个脚本层 `Entity` 同时存在于最多三个进程「部分」——client、base、cell（[关键词释义](/zh/api/kbengine/keywords.md#EntityCall)：`docs/api/kbengine/keywords.md:19-26`）。各部分之间通过 `EntityCall` 通信，其实现刻意极简：实体 ID + 目的地址 + 实体类型 + EntityCall 类型，发送前先按实体 `.def` 描述校验参数（[`keywords.md:5-18`](/zh/api/kbengine/keywords.md#EntityCall)）。

在所有 app 上都成立的推论：

- 同一实体的 base、cell、client 侧 `id` 是同一个整数（[`baseapp/Entity.md:423-431`](/zh/api/kbengine/baseapp/Entity.md#id)、[`cellapp/Entity.md:1075-1083`](/zh/api/kbengine/cellapp/Entity.md#id)、[`client/Entity.md:35`](/zh/api/kbengine/client/Entity.md#属性)）。
- `base`、`cell`、`client` 都是只读 `EntityCall` 属性，对应部分不存在时为 `None`（base 侧：[`baseapp/Entity.md:346-384`](/zh/api/kbengine/baseapp/Entity.md#cell)；cell 侧客户端广播族：[`cellapp/Entity.md:963-1163`](/zh/api/kbengine/cellapp/Entity.md#allClients)）。
- `EntityCall` 只能调用 `.def` 文件里声明过的方法——不能调用引擎方法，不能访问属性（[`keywords.md:16-18`](/zh/api/kbengine/keywords.md#EntityCall)）。
- 客户端侧根本没有 `base`/`cell` 属性，只能通过 `baseCall`/`cellCall` 按方法名调用服务端（[`client/Entity.md:61-104`](/zh/api/kbengine/client/Entity.md#baseCall)）。

### 1.2 实体事件系统

`registerEvent` / `fireEvent` / `deregisterEvent` 在四个 `Entity` 页面逐字重复出现——baseapp（[`baseapp/Entity.md:229-265`](/zh/api/kbengine/baseapp/Entity.md#fireEvent)）、cellapp（[`cellapp/Entity.md:691-727`](/zh/api/kbengine/cellapp/Entity.md#fireEvent)）、client（[`client/Entity.md:140-176`](/zh/api/kbengine/client/Entity.md#fireEvent)）、bots（[`bots/Entity.md:133-169`](/zh/api/kbengine/bots/Entity.md#fireEvent)）。语义：同进程、同名事件；这是每进程的发布/订阅，**不是**远程调用机制（远程调用走 EntityCall）。`getComponent` 同样在四侧都有。

### 1.3 计时器，三种形态

- **实体级计时器**（baseapp 与 cellapp 的 `Entity`）：`addTimer`/`delTimer` → `onTimer(timerHandle, userData)`（[`baseapp/Entity.md:66-171,319-332`](/zh/api/kbengine/baseapp/Entity.md#addTimer)、[`cellapp/Entity.md:205-348,911-924`](/zh/api/kbengine/cellapp/Entity.md#addTimer)）。
- **模块级计时器**（瘦进程）：`addTimer(initialOffset, repeatOffset, callbackObj)` 收回调对象而非实体方法——loginapp（[`loginapp/KBEngine.md:25-80`](/zh/api/kbengine/loginapp/KBEngine.md#addTimer)）、dbmgr（[`dbmgr/KBEngine.md:24-79`](/zh/api/kbengine/dbmgr/KBEngine.md#addTimer)）、interfaces（[`interfaces/KBEngine.md:28-129`](/zh/api/kbengine/interfaces/KBEngine.md#addTimer)）、logger（[`logger/KBEngine.md:24-78`](/zh/api/kbengine/logger/KBEngine.md#addTimer)）。
- **脚本回调**（bots）：`callback`/`cancelCallback`（[`bots/KBEngine.md:63-112`](/zh/api/kbengine/bots/KBEngine.md#callback)）——同样的偏移/重复思路，但不挂在任何实体上。

### 1.4 数据字典族

四个作用域的键值存储，各自配一对 get/set/del 与变更推送回调：

| 字典 | 作用范围 | 脚本入口 |
| --- | --- | --- |
| `globalData` | 所有服务端 app | `onGlobalData`/`onGlobalDataDel`（[`baseapp/KBEngine.md:866-892`](/zh/api/kbengine/baseapp/KBEngine.md#onGlobalData)、[`cellapp/KBEngine.md:712-738`](/zh/api/kbengine/cellapp/KBEngine.md#onGlobalData)）；字典属性 `globalData`（[`baseapp/KBEngine.md:1139`](/zh/api/kbengine/baseapp/KBEngine.md#globalData)、[`cellapp/KBEngine.md:949`](/zh/api/kbengine/cellapp/KBEngine.md#globalData)） |
| `cellAppData` | cellapp 组 | `onCellAppData`/`onCellAppDataDel`（[`cellapp/KBEngine.md:684-711`](/zh/api/kbengine/cellapp/KBEngine.md#onCellAppData)）；属性 `cellAppData`（[`cellapp/KBEngine.md:863`](/zh/api/kbengine/cellapp/KBEngine.md#cellAppData)） |
| `baseAppData` | baseapp 组 | `onBaseAppData`/`onBaseAppDataDel`（[`baseapp/KBEngine.md:839-865`](/zh/api/kbengine/baseapp/KBEngine.md#onBaseAppData)）；属性 `baseAppData`（[`baseapp/KBEngine.md:1088`](/zh/api/kbengine/baseapp/KBEngine.md#baseAppData)） |
| `spaceData` | 单个 space | `setSpaceData`/`getSpaceData`/`delSpaceData` + `onSpaceData`（[`cellapp/KBEngine.md:228-372,753-767`](/zh/api/kbengine/cellapp/KBEngine.md#onSpaceData)）；客户端与 bots 只读：[`client/KBEngine.md:144-160`](/zh/api/kbengine/client/KBEngine.md#getSpaceData)、[`bots/PyClientApp.md:35-49`](/zh/api/kbengine/bots/PyClientApp.md#getSpaceData) |

### 1.5 四类数据

API 文档按「数据在何处权威」切分实体数据：

1. **property 同步（cell → client）。** 服务端 `.def` 中带 `*_CLIENT*` 标志的属性会广播到客户端实体；变更时客户端侧的 `set_<property>` 被调用（[`client/Entity.md:51-55`](/zh/api/kbengine/client/Entity.md#detailed_description)）。文档刻意不在这里枚举标志取值——那属于它们外链的 entitydef 文档（[`keywords.md:109`](/zh/api/kbengine/keywords.md#entity)、[`client/Entity.md:55`](/zh/api/kbengine/client/Entity.md#detailed_description)）。
2. **cell 数据（贴着位置的数据）。** `position`、`direction`、`volatileInfo` 同步策略、`topSpeed`/`topSpeedY` 合法性校验、View/Witness 状态——全是 cellapp `Entity` 属性（[`cellapp/Entity.md:1046-1050,1157-1184,1195-1230,1231-1265`](/zh/api/kbengine/cellapp/Entity.md#volatileInfo)）。易变数据有独立优化策略，可在 `.def` 的 `<Volatile>` 里按实体配置（[`cellapp/Entity.md:1231-1265`](/zh/api/kbengine/cellapp/Entity.md#volatileInfo)）。
3. **base 数据（baseapp 常驻）。** `cellData` 在 cell 尚未创建时保存 cell 部分的属性（外加 position/direction/spaceID），cell 创建后即删除（[`baseapp/Entity.md:359-369`](/zh/api/kbengine/baseapp/Entity.md#cellData)）。归档/备份策略属性 `shouldAutoArchive`/`shouldAutoBackup`（含 `KBEngine.NEXT_ONLY`）在 base 侧（[`baseapp/Entity.md:446-474`](/zh/api/kbengine/baseapp/Entity.md#shouldAutoArchive)）。
4. **data 数据（落库）。** `databaseID`（0 = 非永久）、`databaseInterfaceName`、`writeToDB`、`onPreArchive`、`onWriteToDB`、`shouldAutoLoad`——持久化循环归 base 侧所有（[`baseapp/Entity.md:397-409,412-421,199-215,299-309,333-343`](/zh/api/kbengine/baseapp/Entity.md#databaseID)）；cellapp 侧也能触发写库（[`cellapp/Entity.md:649-666,955-960`](/zh/api/kbengine/cellapp/Entity.md#writeToDB)）。

### 1.6 基本类型：明知是裸表的裸表

[`basetypes.md:3-30`](/zh/api/kbengine/basetypes.md) 是一张「名称 + 字节数」表（定长 1–20 字节；`STRING`/`UNICODE`/`PYTHON`/`PY_DICT`/`PY_TUPLE`/`PY_LIST`/`ENTITYCALL`/`BLOB` 变长）。它不含默认值、取值范围或序列化语义——[核对清单](/zh/api/kbengine/audit-checklist.md#1-核心概念层)点名的正是这个缺口（[`audit-checklist.md:48-50`](/zh/api/kbengine/audit-checklist.md#1-核心概念层)）。应把它当作 `.def` 与脚本桥共用的线上类型词汇表，而非语义参考。

### 1.7 共享工具面

以下在两个服务端 app 上（基本）逐字重复，另有说明除外：资源 IO `open`/`hasRes`/`getResFullPath`/`listPathRes`/`matchPath`；文件描述符挂钩 `registerReadFileDescriptor`/`registerWriteFileDescriptor`；`urlopen`；`genUUID64`；`executeRawDatabaseCommand`；watcher 观测 `addWatcher`/`getWatcher`/`getWatcherDir`/`delWatcher`；`time`、`publish`、`getAppFlags`/`setAppFlags`、`scriptLogType`、`reloadScript`、`MemoryStream`、`address`（[`baseapp/KBEngine.md:90-786`](/zh/api/kbengine/baseapp/KBEngine.md#成员函数)、[`cellapp/KBEngine.md:78-679`](/zh/api/kbengine/cellapp/KBEngine.md#成员函数)；cellapp 没有 `address`；bots 只有子集：[`bots/KBEngine.md:33-194`](/zh/api/kbengine/bots/KBEngine.md#成员函数)）。`component` 属性告诉每个脚本自己身处哪个 app（[`baseapp/KBEngine.md:1051-1058`](/zh/api/kbengine/baseapp/KBEngine.md#component)、[`bots/KBEngine.md:233-239`](/zh/api/kbengine/bots/KBEngine.md#component)）。

## 2. 各 app 差异

| app | 职责 | 脚本位置 | 实体回调 | 独有模块面 |
| --- | --- | --- | --- | --- |
| baseapp | 客户端连接、位置无关逻辑、归档/备份（[`baseapp/index.md:1-5`](/zh/api/kbengine/baseapp/)） | 项目 scripts | base 部分生命周期（[§3](#3-生命周期总图)） | `createEntity*` 家族含 DBID 变体（[`baseapp/KBEngine.md:171-320`](/zh/api/kbengine/baseapp/KBEngine.md#createEntityAnywhere)）、`charge`、`lookUpEntityByDBID`/`deleteEntityByDBID`、`onBaseAppReady`/`onReadyForLogin`（[`baseapp/KBEngine.md:791-973`](/zh/api/kbengine/baseapp/KBEngine.md#onBaseAppReady)） |
| cellapp | space/View/Witness、移动、寻路、AOI（[`cellapp/index.md:1-6`](/zh/api/kbengine/cellapp/)） | 项目 scripts | cell 部分生命周期（[§3](#3-生命周期总图)） | `createEntity`（[`cellapp/KBEngine.md:179-215`](/zh/api/kbengine/cellapp/KBEngine.md#createEntity)）、`addSpaceGeometryMapping`、`raycast`、space 数据、几何加载回调（[`cellapp/KBEngine.md:768-813`](/zh/api/kbengine/cellapp/KBEngine.md#onSpaceGeometryLoaded)） |
| loginapp | 注册/登录（[`loginapp/index.md:1-5`](/zh/api/kbengine/loginapp/)） | `scripts/login` | — | `onRequestLogin`/`onRequestCreateAccount` + DB 回程回调（[`loginapp/KBEngine.md:115-202`](/zh/api/kbengine/loginapp/KBEngine.md#onRequestLogin)） |
| dbmgr | 实体数据存储（[`dbmgr/index.md:1-5`](/zh/api/kbengine/dbmgr/)） | `scripts/db` | — | `onSelectAccountDBInterface`（[`dbmgr/KBEngine.md:147-158`](/zh/api/kbengine/dbmgr/KBEngine.md#onSelectAccountDBInterface)） |
| interfaces | 第三方平台接入（[`interfaces/index.md:1-4`](/zh/api/kbengine/interfaces/)） | `scripts/interfaces` | — | `accountLoginResponse`/`createAccountResponse`/`chargeResponse` 及请求钩子（[`interfaces/KBEngine.md:67-233`](/zh/api/kbengine/interfaces/KBEngine.md#accountLoginResponse)） |
| logger | 日志收集（[`logger/index.md:1-5`](/zh/api/kbengine/logger/)） | `scripts/logger` | — | `onLogWrote`（[`logger/KBEngine.md:113-127`](/zh/api/kbengine/logger/KBEngine.md#onLogWrote)） |

### 2.1 客户端族：client、bots、PyClientApp

三个成员，同一契约：

- **client** 不是进程而是一份插件标准：每个客户端插件（Unity/UE/JS…）都实现同一套 `KBEngine` 模块面——`login`/`createAccount`/`reloginBaseapp`/`resetPassword`/`bindAccountEmail`/`newPassword`，外加 `player()` 与 `findEntity`（[`client/index.md:3-16`](/zh/api/kbengine/client/)、[`client/KBEngine.md:31-160`](/zh/api/kbengine/client/KBEngine.md#login)）。客户端实体是镜像：`onEnterWorld`/`onLeaveWorld` 对非玩家实体表示「进入/离开受控玩家在服务端的视野」，对玩家实体则表示「cell 已在服务端创建/销毁」（[`client/Entity.md:187-206`](/zh/api/kbengine/client/Entity.md#onEnterWorld)）。
- **bots** 是无头孪生：与 client 相同的 `Entity` 回调，外加 `moveToPoint`/`cancelController`，用于模拟客户端并对服务端压测（[`bots/index.md:1-8`](/zh/api/kbengine/bots/)、[`bots/Entity.md:51-119`](/zh/api/kbengine/bots/Entity.md#moveToPoint)）。`addBots` 批量创建模拟客户端（[`bots/KBEngine.md:35-62`](/zh/api/kbengine/bots/KBEngine.md#addBots)）；每个模拟客户端是一个 `PyClientApp`，带 `player()`/`getSpaceData` 和 `entities` 字典（[`bots/PyClientApp.md:5-11,35-71`](/zh/api/kbengine/bots/PyClientApp.md)）；bots `Entity` 通过 `clientapp` 属性暴露所属应用（[`bots/Entity.md:208-265`](/zh/api/kbengine/bots/Entity.md#属性文档)）。
- **Proxy**（baseapp）是已登录客户端的服务端对应物：`giveClientTo`、向客户端流式下发文件/字符串，以及连接回调 `onClientDeath`/`onClientEnabled`/`onLogOnAttempt`（顶掉重复登录在这里）（[`baseapp/Proxy.md:53-223`](/zh/api/kbengine/baseapp/Proxy.md#giveClientTo)）。

玩家身份、控制权、可见性——核对清单点名这三者是最容易被读混的（[`audit-checklist.md:10-11`](/zh/api/kbengine/audit-checklist.md#核对原则)）：`isPlayer` 是 client/bots 上的身份判断（[`client/Entity.md:103-126`](/zh/api/kbengine/client/Entity.md#isPlayer)）；`controlledBy` 是 cell 侧的控制绑定，由 `giveClientTo` 设置（[`cellapp/Entity.md:1025-1044`](/zh/api/kbengine/cellapp/Entity.md#controlledBy)）；View/Witness 状态（`isWitnessed`、`hasWitness`）是可见性（[`cellapp/Entity.md:1062-1122`](/zh/api/kbengine/cellapp/Entity.md#hasWitness)）。

## 3. 生命周期总图

一个实体，按部分分层（以下引用均为 API 页面中有文档的回调/入口）：

```
                    ┌─ 创建 ──────────────────────────────────────────────┐
 base（baseapp）    │ createEntity* / createEntityLocally        baseapp/KBEngine.md:171-364
                    │ → onRestore → onGetCell / onLoseCell       baseapp/Entity.md:310-318,285-298
                    │ → onPreArchive → onWriteToDB（持久化）      baseapp/Entity.md:299-309,333-343
                    │ → onDestroy                                baseapp/Entity.md:277-284
                    │
 cell（cellapp）    │ createEntity（直建）或 createCellEntity*    cellapp/KBEngine.md:179 / baseapp/Entity.md:125-154
                    │ → onRestore → 每 tick onUpdateBegin/End     cellapp/Entity.md:852-859,925-937
                    │ → onGetWitness/onLoseWitness/onWitnessed    cellapp/Entity.md:767-774,804-812,938-954
                    │ → 陷阱/视野：onEnterTrap/onEnteredView…     cellapp/Entity.md:740-791
                    │ → 传送：onTeleport…Success/Failure          cellapp/Entity.md:880-910
                    │ → onDestroy                                cellapp/Entity.md:732-739
                    │
 client（插件 /     │ 镜像实体：onEnterWorld/onLeaveWorld         client/Entity.md:187-206
 bots）             │（world = 受控玩家的视野；                   client/Entity.md:187-195
                    │  space 切换：onEnterSpace/LeaveSpace）      client/Entity.md:207-216
                    │
 持久化循环         │ writeToDB（两侧均可）/ 自动归档/备份 /       baseapp/Entity.md:199-215,446-474
                    │ createEntityFromDBID 恢复                  baseapp/KBEngine.md:258-299
```

读图要点：

- **创建是分层的，不是原子的。** base 实体可以先存在而无 cell；期间 `cellData` 暂存本应属于 cell 的属性（[`baseapp/Entity.md:359-369`](/zh/api/kbengine/baseapp/Entity.md#cellData)）。cell 部分随后经 `createCellEntity`/`createCellEntityInNewSpace` 挂上，落地时 base 侧触发 `onGetCell`（[`baseapp/Entity.md:125-154,285-291`](/zh/api/kbengine/baseapp/Entity.md#createCellEntity)）。
- **cell 迁移对 base 侧 `id` 不可见**：负载均衡时 cell 实体在 cellapp 之间搬家，base 仍通过同一个 `cell` EntityCall 通信（[baseapp 详细描述，`baseapp/Entity.md:52-61`](/zh/api/kbengine/baseapp/Entity.md#detailed_description)）。
- **销毁有两条路径**：base 侧 `destroy(deleteFromDB, writeToDB)` 与 `destroyCellEntity`（[`baseapp/Entity.md:173-198`](/zh/api/kbengine/baseapp/Entity.md#destroy)）；cell 侧朴素 `destroy`（[`cellapp/Entity.md:349-358`](/zh/api/kbengine/cellapp/Entity.md#destroy)）。客户端只能看到 `onDestroy`/`onLeaveWorld`。
- **断线 ≠ 销毁。** 客户端掉线触发 Proxy 的 `onClientDeath`；重登录在 `onLogOnAttempt` 里裁决（[`baseapp/Proxy.md:155-170,185-210`](/zh/api/kbengine/baseapp/Proxy.md#onLogOnAttempt)），客户端可 `reloginBaseapp`（[`client/KBEngine.md:66-79`](/zh/api/kbengine/client/KBEngine.md#reloginBaseapp)）。
- **进程级生命周期**包住一切：`onInit` → app 就绪（`onBaseAppReady` 等、`onReadyForLogin`）→ `onReadyForShutDown` → `onFini`/app 停机（[`baseapp/KBEngine.md:791-973`](/zh/api/kbengine/baseapp/KBEngine.md#回调函数)、[`cellapp/KBEngine.md:680-813`](/zh/api/kbengine/cellapp/KBEngine.md#回调函数)）。

## 4. 如实标注

- API 页面源自 CHM 帮助文本，个别措辞粘连（如「theKBEnginemodule」），页内链接是锚点式、体例不完全一致（[`docs/api/kbengine/index.md:3`](/zh/api/kbengine/)）。
- `.def` 属性标志（`*_CLIENT*` 广播、持久化、`Volatile`）在 `docs/api/kbengine/` 内被引用但从未枚举；两处提及都外链到 `kbengine.org/docs`（[`client/Entity.md:51-55`](/zh/api/kbengine/client/Entity.md#detailed_description)、[`keywords.md:109`](/zh/api/kbengine/keywords.md#entity)）——这些外链早于本 fork，此处不对其可用性背书。
- 已知页面缺陷按原样保留（记录在案、不做静默修正）：`client/Entity.md` 把 `isPlayer` 文档写了两遍（[`client/Entity.md:103-126`](/zh/api/kbengine/client/Entity.md#isPlayer)）；`inWorld` 只出现在属性表、没有描述条目（[`client/Entity.md:37`](/zh/api/kbengine/client/Entity.md#属性)）；`client/Entity.md:53` 的 `set_[property](/study/)` 是一个内联链接格式错误。
- `basetypes.md` 是无逐类型语义的裸表（[§1.6](#16-基本类型明知是裸表的裸表)），不要从中推断默认值。
- `cellapp/Entity.md` 警告 `position` 不可按引用拷贝——这是真实的别名陷阱，原样保留（[`cellapp/Entity.md:1157-1176`](/zh/api/kbengine/cellapp/Entity.md#position)）。
