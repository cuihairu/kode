# 引擎机制 03 · 持久化流程（dbmgr 持久化 / 写回时机）

> KB-001 知识库第二批 · 引擎机制文档 · 中文版（英文版见 [`persistence-flow.en.md`](./persistence-flow.en.md)）
>
> **证据规则**：本篇所有引擎行为结论都带 `kbe/src` 源码引用（`file:line`）。引用的第一来源是 kode 仓内已有的源码级分析产物（见文末「证据来源」）；仓内分析未覆盖的行为标注 `TODO 待验证`，待对照引擎源码后补——**宁缺毋假，不编造**。

---

## 0. 阅读地图

| 你想知道 | 直接跳 |
|---|---|
| 脚本侧有哪些持久化入口 | §1 |
| 写回时机：谁在什么时候触发写库 | §2 |
| 写库前的 hook（onWriteToDB / onPreArchive） | §3 |
| cellData 快照语义 | §4 |
| 自动归档 / 自动备份（shouldAutoArchive / shouldAutoBackup） | §5 |
| 恢复 / 自动加载（writeToDB shouldAutoLoad / onAutoLoadEntityCreate） | §6 |
| 待验证清单 | §7 |

## 1. 脚本侧持久化入口

| API | 签名 | 源码 |
|---|---|---|
| `self.writeToDB(callback=None, shouldAutoLoad=False, dbInterfaceName="default")` | baseapp 0-3 参 `"O\|i\|O"`；cellapp 0-2 参 | `lib/entitydef/entity_macro.h:19`；参数解析 `entity_macro.h:832-940` |
| `self.destroy(deleteFromDB=False, writeToDB=False)` | `writeToDB=True` 时先把最新状态写库再销毁 | `entity_macro.h:20`（METH_KEYWORDS）；kwargs 名单 `server/baseapp/entity.cpp:626-632、:657-658` |
| `KBEngine.deleteEntityByDBID(entityType, dbID, callback, dbInterfaceName="default")` | 按 DBID 删库（不经过实体实例） | `server/baseapp/baseapp.cpp:448`；实现 `:5150-5162`（3-4 参） |
| `KBEngine.lookUpEntityByDBID` | 查库 | `server/baseapp/baseapp.cpp:449` |
| `KBEngine.executeRawDatabaseCommand(command, callback=None, threadID=0, dbInterfaceName="default")` | 直接执行原始 SQL（baseapp/cellapp/dbmgr/interfaces 四注册点） | `baseapp.cpp:438` 实现 `:3175-3189`；cellapp.cpp:174；dbmgr.cpp:355；interfaces.cpp:189 |

实体从库恢复入口（baseapp 模块面）：`createEntityFromDBID` / `createEntityAnywhereFromDBID` / `createEntityRemotelyFromDBID`（`server/baseapp/baseapp.cpp:435-437`）。

## 2. 写回时机：谁在什么时候触发写库

写库动作最终由 **dbmgr 进程**执行（`server/dbmgr/dbmgr.cpp`；dbmgr 是 `Dbmgr : public PythonApp`，`dbmgr.h:32`，公共面来自 `python_app.cpp:271-334`）。baseapp/cellapp 侧只负责收集实体状态并发送写库消息，真正的 DB 写由 dbmgr 的数据库接口（默认 MySQL）完成。

触发写库的**时机**：

1. **显式 `writeToDB()`** —— 脚本主动落库（`entity_macro.h:19`）。`callback` 在写库完成后回调（签名 `(rows, insertID, affectedRows, error)`，见 `_KBEngine_dbmgr.pyi` 两个别名，对应 `dbmgr.cpp:355`）。
2. **`destroy(writeToDB=True)`** —— 销毁前先落库（`entity_macro.h:20`，`server/baseapp/entity.cpp:626-632、657-658`）。
3. **自动归档 / 自动备份** —— 由 `shouldAutoArchive` / `shouldAutoBackup` 门控（见 §5）；周期性归档是引擎内部调度，**调度周期与触发点仓内分析未覆盖，TODO 待验证**。
4. **关服流程** —— 服务器关闭时对存活的、需持久化的实体做一次写库（`onReadyForShutDown` 相关链路；baseapp 侧 `baseapp.cpp:275` 是 baseapp 模块级 hook 调用点）。关服写库的完整顺序/批次语义 **TODO 待验证**。

**写回粒度**：写的是**整个实体的持久化属性集**（def 声明的 DB 持久化属性），不是单属性增量。单属性级的写回合并（多个写请求合一批）**TODO 待验证**。

## 3. 写库前的 hook：onWriteToDB / onPreArchive

| hook | 触发时机 | 源码 |
|---|---|---|
| `onWriteToDB(cellData)`（base 侧） | 写库前回调，带 cell 数据快照参数 | base 侧签名见 `_KBEngine_hooks.pyi:91`；cell 侧对照 `server/cellapp/entity.cpp:1259` |
| `onWriteToDB()`（cell 侧） | 写库前回调，无参数 | `server/cellapp/entity.cpp:1259` |
| `onPreArchive()`（base 侧） | 归档前 | `server/baseapp/entity.cpp:1292` |

**base 侧带 `cellData`、cell 侧无参** —— 两侧签名差异本身就是证据：base 侧的 `cellData` 是**从 cell 侧带过来的一份数据快照**，不是 base 实体自己的属性（首批结论，见[内存坑集 §5](../memory-references/memory-references.zh.md#5-坑五类celldata-快照-vs-活对象)）。

## 4. cellData 快照语义

- `cellData` 是**引擎在写库时刻构造的一份数据快照**，不是 cell 实体对象。
- `cellData` 在系统保留属性名单 `ENTITY_LIMITED_PROPERTYS` 里（`lib/entitydef/common.h:124-157`，含 `cellData`），是 def 禁止重定义的系统属性；位置/朝向走别名注入（`common.h:118-121`）。
- **正确姿势**：在 `onWriteToDB(cellData)` 里把它当**只读数据源**用；要改持久化值，改 cell 实体属性（下次同步/写库生效）。不要把它当活实体长期持有。
- 快照的构造时机 / 拷贝深度、`onWriteToDB` 里改 cellData 是否回读——**TODO 待验证**（首批已列，此处并入 §7）。

## 5. 自动归档 / 自动备份

| 属性 | 读写 | 语义 | 源码 |
|---|---|---|---|
| `shouldAutoArchive` | GET+SET | 实体是否参与**周期性归档**（持久化） | `server/baseapp/entity.cpp:41`（getset） |
| `shouldAutoBackup` | GET+SET | 实体是否参与**周期性备份** | `server/baseapp/entity.cpp:40`（getset） |

- 两者都是 base 侧（baseapp）实体的 getset 属性（`server/baseapp/entity.cpp:40-41`），默认值由引擎设置（**默认值源码行未单独取证，TODO 待验证**）。
- **归档与备份的区别**：归档写**数据库**（dbmgr 持久化），备份写**内存/磁盘备份**（故障恢复用，不落 DB）。两者触发周期与调度器实现 **TODO 待验证**。
- 系统保留属性名单包含 `shouldAutoArchive` / `shouldAutoBackup`（`lib/entitydef/common.h:124-157`），def 禁止重定义。

## 6. 恢复与自动加载

- `writeToDB(..., shouldAutoLoad=True)`：写库时标记实体在服务器启动时**自动加载**（`entity_macro.h:19` 参数解析 `:832-940`）。
- 服务器启动自动加载触发回调：`onAutoLoadEntityCreate(entityType, dbid)`（baseapp 模块级 hook，调用点 `server/baseapp/entity_autoloader.cpp:83`）。
- 恢复入口三件套：`createEntityFromDBID` / `createEntityAnywhereFromDBID` / `createEntityRemotelyFromDBID`（`server/baseapp/baseapp.cpp:435-437`）。
- **自动加载的选择策略**（哪些实体在启动时被加载、按什么顺序/条件）**TODO 待验证**——`entity_autoloader.cpp` 具体筛选逻辑仓内分析未展开。

## 7. 待验证清单

| # | 待验证点 | 关联章节 | 需要的源码证据 |
|---|---|---|---|
| 1 | 周期归档的调度周期与触发点 | §2 / §5 | baseapp 归档调度器 |
| 2 | 关服写库的完整顺序与批次语义 | §2 | 关服路径（baseapp 关服 × 实体写库） |
| 3 | 单属性级写回合并（多写请求合批） | §2 | 写库消息队列/缓冲 |
| 4 | shouldAutoArchive / shouldAutoBackup 默认值 | §5 | baseapp/entity.cpp 构造初始化 |
| 5 | 归档（DB）与备份（非 DB）的底层通道差异 | §5 | baseapp backup 路径 vs dbmgr 写库路径 |
| 6 | cellData 快照构造时机 / 拷贝深度 / 改后是否回读 | §4 | baseapp/entity.cpp 写库路径 + cellData 打包逻辑 |
| 7 | 自动加载的实体选择策略与顺序 | §6 | entity_autoloader.cpp 筛选逻辑 |
| 8 | onWriteToDB 两侧调用点是否同帧 | §3 | baseapp 写库路径（base 侧 onWriteToDB 调用行号） |

## 8. 证据来源

仓内可直接核对的分析产物（本篇引用的行号均出自这些文档的源码取证）：

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` —— writeToDB 参数解析（entity_macro.h:832-940）、destroy kwargs、deleteEntityByDBID、executeRawDatabaseCommand 注册点、onWriteToDB / onPreArchive / onAutoLoadEntityCreate 调用点
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi` —— onWriteToDB 两侧签名差异（base 带 cellData / cell 无参）、onPreArchive、onAutoLoadEntityCreate
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_dbmgr.pyi` —— dbmgr 模块面与回调别名（`dbmgr.cpp:355`）
- `docs/review/2026-10-21-entity-builtin-properties.md` —— shouldAutoArchive / shouldAutoBackup / cellData 系统保留属性名单（common.h:124-157）
- `docs/knowledge/memory-references/` —— cellData 快照 vs 活对象坑（首批 §5）
- `todo.md` KB-001 条目 —— 持久化流程为指定机制文档专题之一

引擎源码本体（`kbe/src/...`）不在 kode 仓内；上述仓内文档基于用户本地 KBEngine 检出（`~/workspaces/kbengine`）产出。仓内文档未覆盖的行为，本篇一律标 TODO 待验证。
