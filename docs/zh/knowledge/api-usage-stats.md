# API 使用模式与频率统计

> KB-001 桶 ③。由 `scripts/kbe-api-scan.py`(AST 解析,仅标准库)于
> 2026-11-07 对本仓库两棵脚本树生成。**口径如实**:即仓库内树——演示资产
> 夹具(`tests/fixtures/kbengine-demo-assets`,50 文件)与项目模板
> (`templates/demo-game`,27 文件)——共 77 文件,0 解析错误。这**不是**
> 真实项目普查;扩大到官方示例项目与真实代码库属后续工作,做完才在此记录。
>
> 再生成:`python3 scripts/kbe-api-scan.py tests/fixtures/kbengine-demo-assets
> templates/demo-game`(加 `--json PATH` 得机器可读输出)。计数口径=属性
> 访问出现次数(读+调用),排序确定(计数降序,再按名)。

## 统计口径

1. **`KBEngine.<name>`** —— `KBEngine` 模块对象上的每次属性访问(函数与
   常量同权)。
2. **实体 API 成员** —— `X.<member>` 访问中 `<member>` 命中 C-21 API 文档库
   (`crates/kode-server/assets/api-docs.json`,225 条)的次数。注意前排:
   `id`/`position` 是内建实体属性,计数含客户端侧普通字段读——数字衡量的是
   *代码中的出现密度*,不是 API「调用」强度。
3. **回调定义** —— `def onXxx(...)` 声明,按引擎已知组分类(名字对照知识页:
   实体生命周期 / client·proxy 生命周期 / 定时器·触发器 / 数据库·归档 /
   全局·空间数据 / 入口脚本 SPI)与**项目自定义** handler(引擎不调用,
   项目代码调用)。

## `KBEngine.<name>` 模块使用(合并)

| 名字 | 计数 | | 名字 | 计数 |
| --- | --- | --- | --- | --- |
| `Entity` | 33 | | `SERVER_ERR_NAME` | 4 |
| `entities` | 13 | | `SERVER_ERR_PASSWORD` | 4 |
| `scriptLogType` | 10 | | `deregisterReadFileDescriptor` | 4 |
| `Proxy` | 8 | | `publish` | 4 |
| `SERVER_SUCCESS` | 8 | | `registerReadFileDescriptor` | 4 |
| `createEntityLocally` | 6 | | `LOG_ON_ACCEPT`、`LOG_TYPE_*`(5 个) | 各 2 |
| `EntityComponent` | 4 | | `SERVER_ERR_LOCAL_PROCESSING` | 2 |
| `accountLoginResponse` | 2 | | `chargeResponse` | 2 |
| `createAccountResponse` | 2 | | `createEntity` | 2 |

解读:基类继承(`Entity`/`Proxy`/`EntityComponent`)与全局注册表
`entities` 占大头;其余是 login/interfaces 管道(服务器错误常量、
interfaces 面的 `*Response` 函数)与 interfaces 面的描述符轮询对
(`registerReadFileDescriptor`/`deregisterReadFileDescriptor`)。

## 实体 API 成员使用(库成员,合并)

注意:经模块对象的访问(`KBEngine.scriptLogType`、`KBEngine.createEntity`
……)会**同时**计入本表与上面的模块表——扫描器对每个 `X.<member>`
(`member` 在库中)计数,不区分接收者。本表看成员相对热度,不是调用的
不交并分割。

| 成员 | 计数 | 备注 |
| --- | --- | --- |
| `id` | 160 | 内建属性;含普通字段读 |
| `position` | 130 | 内建属性;移动/UI 读占大头 |
| `cell` | 24 | base→cell 远程句柄 |
| `client` | 18 | 服务器→客户端广播句柄 |
| `entities` | 17 | 注册表查找 |
| `spaceID` | 12 | |
| `addTimer` | 8 | 这些树里 `delTimer` **从未被调用**——见模式 |
| `destroy` | 8 | |
| `base` | 6 | cell→base 远程句柄 |
| `destroyCellEntity` | 4 | |
| `moveToPoint` | 4 | cell 面移动 |
| `createEntityLocally` | 6 | client 面 |
| `createCellEntity` / `createCellEntityInNewSpace` | 各 2 | cell 创建对 |
| `createSpace` / `giveClientTo` / `time` | 各 2 | |

## 回调定义:引擎已知 vs 项目自定义

引擎已知组(计数=两树定义数):

- **实体生命周期**:`onDestroy` 4、`onGetCell` 4、`onLoseCell` 4、
  `onEnterSpace` 4、`onLeaveSpace` 4、`onEnterWorld` 2
- **client/proxy 生命周期**:`onClientDeath` 4、`onClientEnabled` 4、
  `onLogOnAttempt` 2
- **定时器/触发器**:`onTimer` 10(单一定义数最高的引擎回调)
- **入口脚本 SPI**:`onInit` 6、`onTick` 6、`onReadyForShutDown` 4、
  `onRequestCreateAccount` 4,另有 25 个各 2(各组件 ready/shutdown 对、
  DB 回调、interfaces 请求处理)
- **全局/空间数据**:`onGlobalData`/`onGlobalDataDel` 各 4,`on*Data(Del)`
  家族与 `onSpaceData` 各 2
- **项目自定义**:`onMove`/`onMoveFailure`/`onMoveOver` 各 6、
  `onHPChanged`、`onLevelUp`、`onLoginOK` 各 4,另有 16 个各 2——这些是
  游戏逻辑 handler,由项目代码调用,**不是**引擎回调。两树中约三分之一的
  `def onXxx` 定义是项目自定义——读陌生 KBEngine 代码时的命名约定陷阱
  (见踩坑索引)。

## 值得借鉴的模式(观察到的组合)

- **定时器纪律**:`addTimer` 8 处 vs `onTimer` 10 个定义——两树一致实现
  `onTimer(timerID, userArg)` 并按定时器身份分派
  (`if userArg != TIMER_THINK: return`,
  `templates/demo-game/scripts/cell/Monster.py:139-145`)。值得注意
  `delTimer` **从未被调用**(0 处),尽管加了 8 个定时器:与生命周期篇
  一致(销毁时定时器整批取消——`destroy()` 宏调
  `scriptTimers_.cancelAll()`,`kbengine@3082ab5` 的
  `entity_macro.h:1021`),显式取消只在实体存活期内提前取消时才有意义。
  销毁前应按条件停掉的重复定时器必须调 `delTimer`——演示树没有示范这个
  模式。
- **cell 创建对**:`createCellEntity`/`createCellEntityInNewSpace` 按
  「实体是否已有 space?」二选一——随后必有 `onGetCell` 实现(两树 4/4
  对应)。
- **远程句柄方向**:`cell`(24)≫ `base`(6)——业务逻辑从 base 驱动 cell;
  `client`(18)广播居中。
- **interfaces 面**:轮询对 `registerReadFileDescriptor`/
  `deregisterReadFileDescriptor` 总是成对出现(4/4),对应 interfaces 演示
  的 Poller 模式。

## 喂给流水线

本扫描是 KB-001 流水线桶 ③ 的输入(扫描 → 精校 → hover/MCP)。C-21 hover
库的优先级已隐式反映它;树变更后重跑扫描并在同一批次对账本页(文档常令:
本页绝不声称扫过它没扫的树)。
