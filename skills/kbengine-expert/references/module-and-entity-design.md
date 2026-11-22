# 模块、实体与进程选型

本指南以官方 [实体定义](https://kbengine.github.io/docs/programming/entitydef.html)、[实体注册](https://kbengine.github.io/docs/configuration/entities.html)、[目录结构](https://kbengine.github.io/docs/concepts/directorys.html)和[服务器布局](https://kbengine.github.io/docs/concepts/layout.html)为入口，关键调用以 KBEngine `2.5.12` 源码为据。其他版本按目标进程源码核对。

## 先确定新功能属于谁

| 形态 | 适用条件 | 例子 |
| --- | --- | --- |
| Python 模块、包或普通对象 | 功能只需同进程调用，或者状态与既有实体同生共死，无独立的引擎身份、空间行为或写库生命周期。 | 伤害公式、掉落计算、同进程的冷却策略。 |
| EntityComponent | 多类实体复用同一块属性或行为，且挂载、同步、销毁都跟随 owner。组件访问和远端路由仍依附于 owner。 | 角色背包、多个生物共用的技能集合。 |
| 独立实体 | 对象需要独立寻址、单独创建或销毁，或者需要引擎提供的空间、AOI、归档、恢复等能力。 | NPC、独立存在的地面掉落物、拥有权威成员状态并可被独立调用的房间。 |
| 自建进程或外部服务 | 功能依赖独立部署、隔离故障、不同负载伸缩或对外协议，并已确定超时、回包与恢复方式。 | 独立部署的第三方服务适配。 |

选型是设计建议。官方实体定义列了持久化、远程访问、视野与触发器、故障恢复等用途。实体可按职责选择 Base、Cell、Client 面。角色背包可先由角色托管，确实需要脱离角色生命周期独立存在时，再评估独立实体。房间可由 Base-only 实体维护成员和匹配状态，存在空间内实时模拟时再使用 Cell。 [官方实体定义](https://kbengine.github.io/docs/programming/entitydef.html) · [组件 owner](source/kbe/src/lib/entitydef/entity_component.cpp#L148)

## 创建什么就改哪一层

1. **新增 Python 模块。** 根据状态归属放到 `scripts/base`、`scripts/cell`，或者多个宿主可共同导入的 `scripts/common`、`scripts/server_common`。从已有入口导入，使用目标宿主验证加载路径。模块级变量属于各自的解释器进程。跨进程共享状态走目标版本提供的数据同步或显式消息机制，并明确写入方。 [官方目录结构](https://kbengine.github.io/docs/concepts/directorys.html) · [嵌入式 Python 导入](python373.md)
2. **新增 EntityComponent。** 在 `scripts/entity_defs/components/<Type>.def` 定义组件契约，在 owner 的 `.def` 的 `<Components>` 中增加组件槽位和 `<Type>`。根据宿主补脚本，核对 `onAttached(owner)`、`onDetached(owner)`、属性 Flags 和持久化行为。 [组件加载](source/kbe/src/lib/entitydef/entitydef.cpp#L642) · [组件生命周期](lifecycle-hooks.md)
3. **新增独立实体。** 在 `scripts/entities.xml` 注册类型，在 `scripts/entity_defs/<Entity>.def` 声明需由引擎处理的属性、Flags、持久化和跨进程方法，按需实现 Base、Cell、Client 脚本。客户端由独立 SDK 承载时，核对 `hasClient` 及 SDK 的约定。Base 侧 `createEntity` 和 `createEntityLocally` 在 2.5.12 注册到同一个入口。跨 Base 选择 `createEntityAnywhere` 或指定目标的 `createEntityRemotely`，已存在的持久实例按 DBID 加载。若还需要 Cell 部分，Base 侧另外发起创建，并在相应回调确认结果。 [官方实体注册](https://kbengine.github.io/docs/configuration/entities.html) · [Base 创建 API](source/kbe/src/server/baseapp/baseapp.cpp#L431) · [Cell 挂接回调](source/kbe/src/server/baseapp/entity.cpp#L1014)
4. **新增真正的引擎进程。** 先确认组件身份、注册和发现、消息接口、线程或事件循环、资源配置以及启动关闭顺序。对照同版本现有组件的 `main.cpp`、`*_interface.h` 和 Machine 发现路径。部署前验证组件不可达、掉线和重启时的行为。 [官方服务器引擎编程](https://kbengine.github.io/docs/programming/serverengineprogramming.html) · [Machine 组件发现](source/kbe/src/server/machine/machine.cpp#L163)

## 主要进程怎么协作

| 进程 | 职责与查证入口 |
| --- | --- |
| LoginApp | 登录、账号注册入口。认证结果从 DBMgr 返回，随后协调获取客户端可连接的 BaseApp 地址。 [登录回包](source/kbe/src/server/loginapp/loginapp.cpp#L1166) |
| BaseAppMgr | 协调 BaseApp，并为待登录账号等场景选择 BaseApp。业务对象由 BaseApp 自身持有。 [待登录账号分配](source/kbe/src/server/baseappmgr/baseappmgr.cpp#L579) |
| BaseApp | 运行 Base 实体和 Proxy，承担客户端的游戏会话，也承载大量非空间业务。需要空间能力的实体还可有对应的 Cell 部分。 [客户端接管](source/kbe/src/server/baseapp/baseapp.cpp#L3769) |
| CellAppMgr | 协调 CellApp。新 Space 的创建请求经过 CellAppMgr；已有 Space 的 Cell 创建可按目标 Cell 代理走现有 CellApp。 [新 Space 请求](source/kbe/src/server/cellappmgr/cellappmgr.cpp#L310) · [已有 Space 请求](source/kbe/src/server/baseapp/baseapp.cpp#L3020) |
| CellApp | 运行空间中的实体及实时逻辑，包括坐标、AOI、移动、战斗或 AI。 [CellApp](source/kbe/src/server/cellapp/cellapp.cpp) · [Witness](source/kbe/src/server/cellapp/witness.cpp) |
| DBMgr | 处理账号查询和实体持久化。脚本提交写库、DB 任务执行和结果回调是独立阶段。 [账号查询](source/kbe/src/server/dbmgr/dbmgr.cpp#L730) · [实体写库](source/kbe/src/server/dbmgr/dbmgr.cpp#L1044) |
| Machine、Logger、Interfaces | 分别提供组件发现与机器级管理、日志收集、第三方账号或计费等集成。 [官方进程说明](https://kbengine.github.io/docs/concepts/layout.html) |

排查时画出请求和回包两条边。三个典型链路如下。

- **登录**。客户端先找 LoginApp。LoginApp 与 DBMgr、BaseAppMgr 协作后返回地址，客户端再连接分配到的 BaseApp 并由 Proxy 接管。 [登录与地址回包](source/kbe/src/server/loginapp/loginapp.cpp#L1166) · [BaseApp 接管](source/kbe/src/server/baseapp/baseapp.cpp#L3769)
- **创建 Cell**。BaseApp 可以将已有空间里的创建请求发到目标 CellApp。新空间的创建请求经 CellAppMgr。Base 侧用成功或失败回调辨认最终结果。 [新空间](source/kbe/src/server/baseapp/baseapp.cpp#L2423) · [已有空间](source/kbe/src/server/baseapp/baseapp.cpp#L3020) · [回调](lifecycle-hooks.md)
- **持久化**。BaseApp 视路径取得 Cell 快照，发到 DBMgr，再按写库回调确认。用实体 ID 追运行期对象，用 DBID 追数据库记录。 [写库机制](engine-knowledge.md)
