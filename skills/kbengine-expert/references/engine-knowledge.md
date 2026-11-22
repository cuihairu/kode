# KBEngine 引擎机制与常见误判

资料以随附官方 `2.5.12` 源码为准。先根据现象找到下面的机制，再到目标版本核对调用者、状态及回包。钩子签名和进程入口见 [生命周期钩子](lifecycle-hooks.md)。

| 现象 | 核对依据 |
| --- | --- |
| Base 可以创建，Cell 部分迟迟不可用 | Base 的 Cell 创建调用发异步请求。检查创建中标记、CellApp 回包、Base 侧 `onGetCell` 或 `onCreateCellFailure`。确认目标 Space、CellApp 与 Base 的实体 ID 对应。 [Base 实体](source/kbe/src/server/baseapp/entity.cpp#L1014) · [Cell 请求处理](source/kbe/src/server/cellapp/cellapp.cpp) |
| `cellData` 在某些回调中找不到 | 区分创建前暴露的 `self.cellData`、Cell 上的实例属性、Base 内部持有的字典与传给 `onWriteToDB` 的快照。Base 成功挂接 Cell 时删除脚本属性。失去 Cell 的处理分支不负责重装该属性，快照恢复另查 `onBackupCellData`。 [建立代理与删除属性](source/kbe/src/server/baseapp/entity.cpp#L1014) · [失去 Cell](source/kbe/src/server/baseapp/entity.cpp#L1052) · [Base 写库参数](source/kbe/src/server/baseapp/entity.cpp#L1399) |
| 跨 CellApp 后旧对象未执行清理逻辑 | 本地传送可以复用实例。跨进程迁移由目标侧分配对象并读取迁移流，源侧收到成功回包后可按 `callScript=false` 清理。普通构造、恢复、迁移和 Ghost 转 Real 各查自己的入口。 [目标接收与源侧清理](source/kbe/src/server/cellapp/cellapp.cpp#L1958) · [Cell 实体状态与序列化](source/kbe/src/server/cellapp/entity.cpp) |
| 对象已销毁，还被脚本引用或仍收到定时回调 | 活跃注册表移除与对象引用计数释放发生在不同阶段。检查脚本容器、闭包、绑定方法和未决回调。实体的定时器集合在销毁路径取消。应用级 `KBEngine.addTimer` 的实现会持有回调对象，绑定方法可以让实体继续存活。 [注册表](source/kbe/src/lib/entitydef/entities.h) · [遗留引用诊断](source/kbe/src/lib/entitydef/entity_garbages.h#L289) · [实体定时器](source/kbe/src/lib/entitydef/entity_macro.h#L1021) · [应用级回调所有权](source/kbe/src/lib/server/python_app.cpp#L17) |
| 写库调用成功返回，数据仍未落库 | 把调用提交、Cell 快照回收、DBMgr 任务执行和 Base 写库结果分开核对。`onPreArchive`、`onWriteToDB` 都发生在结果确认之前。同一实体在进程内的 ID 与持久化 DBID 分别用于查找与关联。 [归档与 DB 回调](source/kbe/src/server/baseapp/entity.cpp) · [DBMgr](source/kbe/src/server/dbmgr/dbmgr.cpp) · [DB 任务](source/kbe/src/server/dbmgr/dbtasks.cpp) |
| 属性 Flags 显示正确，状态仍未同步到预期客户端 | 查枚举和消费掩码、实体归属、Witness 以及属性定义入口。XML 路径先把 Flags 转大写再查询映射，映射明确接受若干兼容旧名。若使用 Python 定义装饰器，从其自己的标志解析路径查接受的名字与无效值处理。 [Flags 与位掩码](source/kbe/src/lib/entitydef/common.h) · [XML 映射](source/kbe/src/lib/entitydef/entitydef.cpp#L161) · [XML 解析](source/kbe/src/lib/entitydef/entitydef.cpp#L1137) · [Python 定义入口](source/kbe/src/lib/entitydef/py_entitydef.cpp) |
| RPC 已发送，业务方法没有执行 | 先核对目标实体与组件，再核对调用侧的方法索引、参数编码、实体代理的目标地址，以及接收侧是否还能找到实体。跨组件结论需要接收方日志或业务确认回包。 [代理发送](source/kbe/src/lib/entitydef/remote_entity_method.cpp) · [Base 接收](source/kbe/src/server/baseapp/entity.cpp#L888) · [Cell 接收](source/kbe/src/server/cellapp/entity.cpp#L896) |
| 视野事件、登录或重连的顺序与预期不同 | AOI 分开核对实体所在 Cell、Witness 的观察集合和客户端对象。登录分开核对 DB 认证、Base 分配、第二段连接和 Proxy 接管。重连检查是否复用了 Proxy、如何更换旧通道、客户端是否重建对象或重放缓存属性。 [Witness](source/kbe/src/server/cellapp/witness.cpp) · [LoginApp](source/kbe/src/server/loginapp/loginapp.cpp) · [BaseApp](source/kbe/src/server/baseapp/baseapp.cpp) · [客户端对象](source/kbe/src/lib/client_lib/clientobjectbase.cpp) |

## 查证顺序

1. 核对目标进程的引擎版本、资产目录、实体定义和脚本宿主。脚本配置、生成 SDK 和运行中的部署产物各有版本。
2. 定位派发函数，再回查入口分支及异步边界。同名方法在不同宿主可以有不同实参和执行顺序。
3. 隔离验证时记录同一账号或实体的组件 ID、实体 ID、DBID 和 space ID，覆盖已确认的正常路径及相关失败分支。
