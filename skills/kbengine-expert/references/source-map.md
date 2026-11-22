# KBEngine 2.5.12 源码导航

下列路径以 [源码快照](source/) 为根。跟踪业务问题时，把发行版的引擎入口与目标项目的资产定义、日志和部署配置对应起来。

| 问题 | 入口与检索锚点 | 优先核实 |
| --- | --- | --- |
| 进程启动、配置覆盖、组件注册 | `kbe/src/server/<component>/main.cpp` → `kbe/src/lib/server/serverapp.cpp`、`serverconfig.cpp`、`components.cpp`。配置见 `kbe/res/server/kbengine_defaults.xml` 和资产 `res/server/kbengine.xml`。 | 进程监听成功、注册到对应管理组件、业务脚本启用三个阶段各自的日志。根据实际加载顺序确认默认值与部署覆盖值。 |
| 登录成功但角色未接管 | `kbe/src/server/loginapp/loginapp.cpp` 的 `Loginapp::login`、`onLoginAccountQueryResultFromDbmgr`、`onLoginAccountQueryBaseappAddrFromBaseappmgr`，以及 `kbe/src/server/baseapp/baseapp.cpp` 的 `Baseapp::loginBaseapp`。认证分支查 `kbe/src/server/dbmgr/interfaces_handler.cpp`。 | 区分认证结果、分配 Base、返回可达地址、客户端到 Base 的第二段连接和客户端接管。核对外部与内部地址，并沿同一账号关联回包。 |
| 实体、属性、Base 与 Cell | `kbe/src/lib/entitydef/entitydef.cpp` 解析 `entities.xml`、`entity_defs/` 和类型定义。接着看同目录 `scriptdef_module.cpp`、`property.cpp`、`datatype.cpp`。创建路径由 `baseapp/entity.cpp` 和 `Baseapp::createCellEntity` 到 `Cellapp::onCreateCellEntityFromBaseapp`，失败回包找 `Baseapp::onCreateCellFailure`。 | 区分实体 ID 与数据库 ID、Base 与 Cell 属性、Cell 创建前的 `cellData` 和创建后的实体状态。拿实际 `.def` 验证可见性、持久化和类型。 |
| Mailbox 或远端调用 | `kbe/src/lib/entitydef/remote_entity_method.cpp`、`entitycallabstract.cpp` 的 `newCall`、`sendCall`，接到 Base/Cell 的 `Entity::onRemoteMethodCall`。消息声明查目标组件的 `*_interface.h`。 | 确认目标组件、实体是否仍活跃、类型与方法索引、参数编码和接收端处理。发送或入队成功仅表示对应阶段成功。 |
| AOI、空间和跨 Cell 迁移 | `kbe/src/server/cellapp/witness.cpp` 的 `Witness::installViewTrigger`，以及 `coordinate_system.cpp`、`view_trigger.cpp`、`spacememory.cpp`。迁移从 `cellapp.cpp` 的 `reqTeleportToCellApp` 追 `reqTeleportToCellAppCB` 和 `reqTeleportToCellAppOver`。 | 区分实体实际归属、观察者可见集合、客户端收到的进入或离开消息。记录迁移前后组件及空间 ID，检查源回收、目标接管与中途失败。 |
| 持久化、重复加载和回调 | `kbe/src/server/baseapp/entity.cpp` 的 `Entity::writeToDB` → `kbe/src/server/dbmgr/dbmgr.cpp` 的 `Dbmgr::writeEntity` 及 `dbtasks.cpp` → `Baseapp::onWriteToDBCallback`。加载看 `Baseapp::createEntityFromDBID` 和对应回调。存储适配器在 `kbe/src/lib/db_interface/`、`db_mysql/`、`db_redis/`。 | 区分定时归档、显式写库、销毁和重登。检查持久属性及 Cell 状态参与方式、缓冲任务顺序、DB 实际提交和回调结果。 |
| 网络、协议和客户端兼容 | `kbe/src/lib/network/event_dispatcher.cpp`、`network_interface.cpp`、`channel.cpp`、`packet_reader.cpp`、`bundle.cpp` 的 `Bundle::newMessage`。固定消息在 `kbe/res/server/messages_fixed_defaults.xml`，SDK 生成在 `kbe/src/server/tools/kbcmd/`。 | 按同版消息声明与输入建立只含正常业务流量的最小对照，核对消息 ID、长度、参数顺序、属性索引、加载时生成的定义与 SDK 版本。 |

## 业务脚本与本地复核

- [Python 资产模板](source/kbe/res/sdk_templates/server/python_assets/) 提供 `scripts/base/`、`scripts/cell/`、`scripts/db/` 和 `scripts/login/` 的 `kbemain.py`，并附 `entities.xml` 与 Account 示例。用它对照入口位置，业务生命周期以目标项目脚本和组件调用点为准。
- 常见验证组合包括登录到 Base 接管、创建 Cell 与创建失败回包、同一 DBID 重复加载、切换 Cell 前后 AOI 和属性同步，以及重载前后的存量和新实体。
- 只验证数据库或客户端的一段日志时，结论限定在已观察的阶段。需要判断跨进程因果时，记录同一个账号、实体或回调 ID 在两端的先后顺序。
