# Cellapp 面 API 参考——`KBEngine` 模块面（KB-API-004）

> 断言与引用完全一致；行号漂移核对以 EN 篇为准。
>
> **范围**：**cellapp** 进程注册的 `KBEngine` 模块面，外加双面通用的
> 组装层地图（回答「这个 API 在 cellapp 上真的存在吗」）。cellapp 上的
> 共享 `Entity` 类（定时器/控制器/view/AOI/广播/生命周期/属性/回调）有
> 独立一篇：[api-cellapp-entity](api-cellapp-entity.md)。重写自官方 3.7
> 口径 CHM 转换源料（`kbengine/docs/api/kbengine/cellapp/Entity.md`，
> 50 个 `def` 节；`KBEngine.md`，42 个 `def` 节；`index.md`）——源料措辞
> 不照抄（chm 转换粘连如 `ThisKBEngine`、表格破损），以下全部行为断言均
> 对 fork 源码重新取证。
>
> **Grounding**：fork `kbe/src`，HEAD `6d12b8f`（grounding 基线 `c2a3b8f`）。
> 版本口径与偏离标注格式依
> [Python 版本口径](python-version-baseline.md)。姊妹篇：
> [Entity 生命周期与引用释放](entity-lifecycle-reference.md)（destroy 守卫、
> timer 释放流程）、[Fixed 目录与路径解析](fixed-directories-and-path-resolution.md)
>（`KBE_RES_PATH` 约束的资源函数）。
>
> **覆盖**：源料 121 个文档条目中的 KBEngine 模块部分——33 个函数 +
> 9 个回调 + 12 个属性（Entity 部分——29 个成员函数 + 21 个回调 +
> 17 个文档属性——在 [Entity 面篇](api-cellapp-entity.md)）。

## 1. cellapp Python 面的组装方式

cellapp 脚本面不是单一注册点，而是四层。回答「这个 API 在 cellapp 上真的
存在吗」按此顺序查：

| 层 | 注册内容 | 证据 |
| --- | --- | --- |
| cellapp 专属 `Entity` 方法 | `setViewRadius`, `getViewRadius`, `getViewHystArea`, `isReal`, `addProximity`, `addYawRotator`, `clientEntity`, `cancelController`, `canNavigate`, `navigatePathPoints`, `navigate`, `getRandomPoints`, `moveToPoint`, `moveToEntity`, `accelerate`, `entitiesInRange`, `entitiesInView`, `teleport`, `destroySpace`, `debugView`, `getWitnesses` | `kbe/src/server/cellapp/entity.cpp:46-68`（`ENTITY_METHOD_DECLARE_BEGIN(Cellapp, Entity)`） |
| 共享实体方法（baseapp+cellapp） | `addTimer`, `delTimer`, `writeToDB`, `destroy`, `registerEvent`, `deregisterEvent`, `fireEvent`, `getComponent`；getset `id`, `isDestroyed`, `className` | `kbe/src/lib/entitydef/entity_macro.h:12-40`（宏块拼入同一张表） |
| cellapp `KBEngine` 模块函数 | `time`, `createEntity`, `executeRawDatabaseCommand`, `reloadScript`, `registerReadFileDescriptor`/`Write`（+`deregister…`）, `addSpaceGeometryMapping`, `getSpaceGeometryMapping`, `setSpaceData`, `getSpaceData`, `delSpaceData`, `isShuttingDown`, `address`, `raycast`, `setAppFlags`, `getAppFlags` | `kbe/src/server/cellapp/cellapp.cpp:172-189`；另有 `cellAppData` 对象于 `cellapp.cpp:199` |
| 共享 server-app 模块面 | `kbassert`（私有）, `publish`, `scriptLogType`, `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath`, `getWatcher`, `getWatcherDir`, `debugTracing`, `globalData` 对象 | `kbe/src/lib/server/entity_app.h:423-453`；`:418-419`（`globalData` 注册） |
| 解释器层（所有 app 共用） | `MemoryStream`（`python_app.cpp:271`）、`NEXT_ONLY` 常量（`:323`）、模块级 `addTimer`/`delTimer`（`:329-330`）、`component` 字符串（`lib/pyscript/script.cpp:248`）、`genUUID64`（`:258`）、`addWatcher`/`delWatcher`（`lib/pyscript/pywatcher.cpp:184-185`）、`urlopen`（`lib/pyscript/pyurl.cpp:23`） | 如引 |

cellapp `Entity` 的**属性**面：`base`, `client`, `allClients`,
`otherClients`, `isWitnessed`, `hasWitness`, `isOnGround`, `spaceID`
（只读）；`layer`, `position`, `direction`, `topSpeed`, `topSpeedY`,
`controlledBy`, `volatileInfo`（可读可写）——
`server/cellapp/entity.cpp:71-88`。逐属性语义全文见
[Entity 面篇](api-cellapp-entity.md)。

实体**组件**在 cellapp 上另有较小的一张面：`addTimer`, `delTimer`,
`clientEntity` 加 `ownerID`/`owner`/`name`/`className`/`isDestroyed`/
`base`/`client`/`allClients`/`otherClients` getset——
`server/cellapp/entity_component.cpp:10-27`。任务核验锚
`addTimer = cellapp/entity_component.cpp:12` 指的是组件面；主实体的
`addTimer` 来自共享宏（定时器见 [Entity 面篇](api-cellapp-entity.md)）。

## 2. KBEngine 模块函数（cellapp 面）

源料 33 个函数全覆盖，标注实际提供它们的注册层。「层」取值：**cell** =
`cellapp.cpp:172-189`，**shared** = `entity_app.h:423-453` /
`python_app.cpp`，**interp** = `lib/pyscript`（公共安装路径，
`script.cpp:197-289`）。

| 函数 | 层 | fork 取证的语义 |
| --- | --- | --- |
| `time()` | cell `cellapp.cpp:172` | 游戏tick计数；tick 长度由 `gameUpdateHertz` 配置决定 |
| `createEntity(entityType, spaceID, position, direction, params)` | cell `cellapp.cpp:173`，实现 `:471-533` | 在**本 cellapp 已存在**的空间里创建 cell 本地实体。失败抛 `TypeError`：`entityType` 为空（`:488`）、本进程找不到 `spaceID`（`:496`）、正在关服（`:503`）；参数形状错误（`:480`）。返回实体对象；实现内注（`:521-527`）说明：实体若在 `addEntityAndEnterWorld` 中被销毁，仍会返回给脚本且 `isDestroyed = true` |
| `executeRawDatabaseCommand(command, callback, threadID, dbInterfaceName)` | cell `cellapp.cpp:174`，实现 `:536+` | 经 dbmgr 执行原始 DB 命令；回调签名 `(result, rows, insertid, error)`；与 baseapp 面同样的覆写风险告警 |
| `reloadScript(fullReload)` | cell `cellapp.cpp:175` | 重载实体脚本；完成后触发 `KBEngine.onInit(True)`；仅限开发模式 |
| `registerReadFileDescriptor` / `registerWriteFileDescriptors` / `deregisterReadFileDescriptor` / `deregisterWriteFileDescriptor` | cell `cellapp.cpp:176-179` | FD 回调；共享实现 `lib/server/py_file_descriptor.cpp` |
| `addSpaceGeometryMapping(spaceID, mapper, path, shouldLoadOnServer, params)` | cell `cellapp.cpp:180` → `SpaceMemory::__py_AddSpaceGeometryMapping` | 为空间绑定 navmesh/几何；`params` 做 layer→navmesh 映射；完成回调见 §3 |
| `getSpaceGeometryMapping(spaceID)` | cell `cellapp.cpp:181` | 查询空间当前绑定名 |
| `setSpaceData` / `getSpaceData` / `delSpaceData` | cell `cellapp.cpp:182-184` | 空间键值字符串；变更广播 → 回调 `onSpaceData`（§3） |
| `isShuttingDown()` | cell `cellapp.cpp:185` | 关服状态；`createEntity` 内部也检查（`cellapp.cpp:505-508`） |
| `address()` | cell `cellapp.cpp:186` | 内网接口地址 |
| `raycast(spaceID, layer, src, dst)` | cell `cellapp.cpp:187`，实现 `cellapp.cpp:2158` | 几何射线；要求空间已 `addSpaceGeometryMapping` 装载几何 |
| `setAppFlags` / `getAppFlags` | cell `cellapp.cpp:188-189` | 例如退出负载均衡 |
| `publish()` | shared `entity_app.h:426` | 0 debug / 1 release |
| `scriptLogType(logType)` | shared `entity_app.h:429` | 设定 `print` 映射的日志类型（`LOG_TYPE_*`） |
| `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath` | shared `entity_app.h:432-444` | 资源访问限定在 `KBE_RES_PATH`——见 [fixed 目录篇](fixed-directories-and-path-resolution.md) |
| `getWatcher`, `getWatcherDir` | shared `entity_app.h:447-450` | 读 Watcher 树 |
| `debugTracing()` | shared `entity_app.h:453` | PyGC 扩展对象泄漏计数 |
| `genUUID64()` | interp `script.cpp:258`，实现 `:91-106` | 64 位 UUID；进程 global order 不在 0~65535 时**发运行时警告**（`script.cpp:99`），跨进程唯一性退化为进程内唯一 |
| `addWatcher(path, dataType, getFunction)` / `delWatcher(path)` | interp `pywatcher.cpp:184-185` | 注册/删除观察变量 |
| `urlopen(url, callback, postData, headers)` | interp `pyurl.cpp:23`，实现 `:69+` | 异步 HTTP(S)；headers/postData/callback 不合法抛 `AssertionError`（`pyurl.cpp:98`, `:116`, `:162`, `:174`） |
| `MemoryStream()` | interp `python_app.cpp:271` | KBEngine 序列化字节缓冲 |
| `createSpace` | — | **不存在**：cellapp 源料未记载，fork 也没有 cellapp 侧 `createSpace` 注册（grep `server/cellapp/` + `lib/server/` = 0 命中）。空间创建走 baseapp→cellappmgr 路径（`Cellapp::onCreateCellEntityInNewSpaceFromBaseapp` 处理随后的实体创建，`cellapp.cpp:875`） |

源料中他处交代的函数：源料引言提到 `KBEngine.createCellEntity`——那是
**baseapp** 面（KB-API-003 范围），cellapp 未注册。

## 3. KBEngine 模块回调（cellapp 面）

| 回调 | 触发点（已取证） |
| --- | --- |
| `onInit(isReload)` | 入口脚本，全部脚本加载后（`initprogress_handler.cpp:132-143`；首次调用传 `0`；`reloadScript` 触发 reload 调用） |
| `onReadyForLogin(isBootstrap)` | cellapp 初始化进度轮询（`initprogress_handler.cpp:153-160`）。返回契约，fork 取证：返回 `True` → 就绪（`:163`、`:177`）；否则取浮点值，`>= 0.9999` 视为完成（`:194-196`）；未定义该回调 → 立即完成（`:184-191`）。源料「≥ 1.0」接近但 fork 阈值是 0.9999（§5） |
| `onCellAppData(key, value)` | `Cellapp::onBroadcastCellAppDataChanged` 中远端写入成功后（`cellapp.cpp:864`） |
| `onCellAppDataDel(key)` | 同路径远端删除成功后（`cellapp.cpp:844`） |
| `onGlobalData(key, value)` | `EntityApp::onBroadcastGlobalDataChanged`（`lib/server/entity_app.h:1308`）——baseapp+cellapp 共用 |
| `onGlobalDataDel(key)` | 同文件 `entity_app.h:1290` |
| `onSpaceData(spaceID, key, value)` | `SpaceMemory::onSpaceDataChanged`——set 与 del 都派发到此，删除时 value 为空串（`spacememory.cpp:607-619`） |
| `onSpaceGeometryLoaded(spaceID, mapping)` | 单空间几何装载完成（`spacememory.cpp:308`） |
| `onAllSpaceGeometryLoaded(spaceID, isBootstrap, mapping)` | 该空间全部 cell 的几何完成（`spacememory.cpp:336`）；`isBootstrap` 标记发起 cell |

源料关于入口脚本位置的说明（onCellAppData/onGlobalData/onInit/
onReadyForLogin 必须写在 `entryScriptFile` 模块）与实现一致：以上派发全部
调用 `getEntryScript()`/`getEntryScript().get()`，不是实体。

## 4. KBEngine 模块属性（cellapp 面）

| 属性 | 类型 | 注册 / 语义 |
| --- | --- | --- |
| `entities` | `Entities` | `entity_app.h:410-411`——本进程全部实体**含 ghost**；`.garbages` 泄漏排查见[实体生命周期篇](entity-lifecycle-reference.md) |
| `globalData` | `GlobalDataClient` | `entity_app.h:418-419`——dict 式，向所有 baseapp+cellapp 复制（服务端锚在 dbmgr；cellapp 构造 `GlobalDataClient(DBMGR_TYPE, …)`） |
| `cellAppData` | dict 式 | `cellapp.cpp:199`（`pCellAppData_`）——跨 cellapp 复制 |
| `component` | string | `script.cpp:248`——本进程为 `'cellapp'` |
| `LOG_TYPE_DBG/INFO/NORMAL/WAR/ERR` | int | `scriptLogType` 的日志级别 |
| `NEXT_ONLY` | int | 定义为 `KBE_NEXT_ONLY`（`python_app.cpp:323`）；cellapp 无消费者——与源料「当前未用」一致 |

两个复制字典**只在显式顶层 set/delete 时广播**：远端派发路径是
`onBroadcastCellAppDataChanged`（`cellapp.cpp:830-872`）与
`onBroadcastGlobalDataChanged`（`entity_app.h:1280-1314`）；对已存 list 的
原地修改不会到达这些调用点，因此永不广播——源料
`cellAppData["list"][1] = 7` 的警告在本 fork 结构上成立。

## 5. 3.7 源料 vs fork 3.12 偏离（模块面）

| 条目 | 官方 3.7 口径源料说法 | fork 3.12 实际行为 | 领域 | 证据 |
| --- | --- | --- | --- | --- |
| `onReadyForLogin` 就绪阈值 | 「返回值 ≥ 1.0 → 就绪」 | `True` → 就绪；否则浮点，`>= 0.9999` 完成；未定义回调 → 立即完成 | Fork | `kbe/src/server/cellapp/initprogress_handler.cpp:163-196` |
| cellapp 上的 `createSpace` | cellapp 源料未记载 | fork 同样不存在：无 cellapp 侧注册（grep `server/cellapp/` + `lib/server/` = 0 命中）；空间创建走 baseapp→cellappmgr | Fork | 2026-11-04 于 HEAD `6d12b8f` grep；`cellapp.cpp:875` |
| `NEXT_ONLY` | 「当前在 Cellapp 未使用」 | 常量仍定义在模块上、无消费者——与源料一致 | Fork | `kbe/src/lib/server/python_app.cpp:323` |
| `genUUID64` 唯一性 | 依赖 `gus` 启动参数；>65535 退化为进程内唯一 | 契约相同，且 global order ∉ 0~65535 时有显式运行时警告 | Fork | `kbe/src/lib/pyscript/script.cpp:91-106` |
| Python 2 代码示例 | 源料示例为 `print "..."` 语法 | 3.12 要求 `print(...)`；片段须重写、不可照抄（两面通用） | Python | https://docs.python.org/3/whatsnew/3.0.html（print 为函数） |

Entity 面偏离（`delTimer` 失效 id、`cancelController("Type")`、
"trackEntity"/"turnToYaw" 入口、`accelerate` 参数表、`isOnGround`、
`volatileInfo` 类型行）在 [Entity 面篇](api-cellapp-entity.md)偏离表。

## References

- 注册映射：`server/cellapp/cellapp.cpp:172-199`、
  `lib/server/entity_app.h:410-453`、`lib/server/python_app.cpp:271-334`、
  `lib/pyscript/script.cpp:248-258`、`lib/pyscript/pywatcher.cpp:184-185`、
  `lib/pyscript/pyurl.cpp:23`；Entity 面注册映射见
  [Entity 面篇](api-cellapp-entity.md)
- 数据复制：`cellapp.cpp:830-872`、`lib/server/entity_app.h:1280-1314`、
  `spacememory.cpp:308-619`、`initprogress_handler.cpp:134-196`
- Grounding 于 fork HEAD `6d12b8f`，2026-11-04。
