# 引擎机制 01 · 实体生命周期（创建 → cell 迁移 → 销毁）

> KB-001 知识库首批 · 引擎机制文档 · 中文版（英文版见 [`entity-lifecycle.en.md`](./entity-lifecycle.en.md)）
>
> **证据规则**：本篇所有引擎行为结论都带 `kbe/src` 源码引用（`file:line`）。引用的第一来源是 kode 仓内已有的源码级分析产物（见文末「证据来源」）；仓内分析未覆盖的行为标注 `TODO 待验证`，待对照引擎源码后补——**宁缺毋假，不编造**。

---

## 0. 阅读地图

| 你想知道 | 直接跳 |
|---|---|
| 实体怎么被创建出来 | §1 |
| cell 实体怎么来、怎么走 | §2 |
| hasBase/hasCell/hasClient 谁决定 | §3 |
| 实体怎么销毁、销毁后脚本侧还剩什么 | §4 |
| 所有生命周期 hook 一览 | §5 |
| 内存引用相关坑（交叉入口） | §6 + [内存引用与释放坑集](../memory-references/memory-references.zh.md) |

一个 KBEngine 实体在服务端有**两段独立的脚本生命**：base 侧（住在 baseapp 进程）与 cell 侧（住在 cellapp 进程的某个 space 里）。两段生命各自有一个 Python 实例、各自的 `onDestroy`、各自的 timer。绝大多数生命周期坑的根源都是：**把两段生命想成了一段**。

## 1. 创建：实体从哪来

### 1.1 base 侧创建入口

脚本可用的创建 API（baseapp 模块面）：

| API | 语义 | 源码 |
|---|---|---|
| `KBEngine.createEntity(entityType, params=None)` | 在本 baseapp 创建 base 实体 | `server/baseapp/baseapp.cpp:431`，实现 `:951-971`（1-2 参） |
| `KBEngine.createEntityLocally(...)` | 同 createEntity（同一实现） | `baseapp.cpp:432` |
| `KBEngine.createEntityAnywhere(entityType, params, callback)` | 让 baseappmgr 挑一个负载最低的 baseapp 创建 | `baseapp.cpp:433`，实现 `:986-1025`（1-3 参，callback 须可调用否则置 NULL） |
| `KBEngine.createEntityRemotely(entityType, baseMB, params, callback)` | 在指定 base mailbox 所在 baseapp 创建 | `baseapp.cpp:434`，实现 `:1028-1090`（2-4 参，第 2 参强制校验 `ENTITYCALL_TYPE_BASE`） |
| `KBEngine.createEntityFromDBID` / `createEntityAnywhereFromDBID` / `createEntityRemotelyFromDBID` | 从数据库按 DBID 恢复 | `baseapp.cpp:435-437` |

实体类型不存在时的报错文案出自注册三连：「Please register in entities.xml and implement a %s.def and %s.py」（`lib/server/entity_app.h:567`）；创建时按进程检查 `hasCell`（cellapp）/ `hasBase`（其他进程）（`entity_app.h:573-582`）。

**关键机制：def 属性在 `__init__` 之前由引擎注入。** 实体类被实例化时，引擎先把 def 声明的属性按默认值摆好，脚本 `__init__` 才跑。这解释了为什么 `__init__` 里能直接 `self.hp` —— 也解释了为什么在 `__init__` **之前**的引擎侧赋值对 Python 不可见（kode 仓内结论，设计取舍记录于 todo.md C-22 条目；引擎侧逐行机制属于「KBEngine Python 绑定层源码分析」扩展域，标注 **TODO 待验证**）。

### 1.2 cell 侧创建入口

cell 实体不被脚本直接创建，而是由 base 侧驱动：

| API | 语义 | 源码 |
|---|---|---|
| `self.createCellEntity(cellEntityCall=None)` | base 实体请求创建自己的 cell | `server/baseapp/entity.cpp:27`（`DECLARE_PY_MOTHOD_ARG1`，`server/baseapp/entity.h:187`，0-1 参） |
| `self.createCellEntityInNewSpace(cellappIndex=0)` | 同上，但在新 space 里 | `server/baseapp/entity.cpp:28`（`entity.h:198`） |
| `KBEngine.createEntity`（cellapp 模块面） | 在指定 space 直接创建 cell 实体 | `server/cellapp/cellapp.cpp:173`，实现 `:471-484`（`"s|I|O|O|O"`） |

### 1.3 三侧存在性判定（谁决定这个实体有没有 base/cell/client 份）

引擎在 def 装载尾部的 `autoMatchCompOwn`（`lib/entitydef/scriptdef_module.cpp:302-530`）里一次性判定 hasCell/hasBase/hasClient，规则是**每侧「脚本存在 ‖ entities.xml 断言，断言优先」**：

- 组件模块分支（`scriptdef_module.cpp:304-331`）：`scripts/base/components/<name>.py` 存在 → `setBase(true)`；`scripts/cell/components/<name>.py` 存在 → `setCell(true)`；base/cell 有 exposed 方法 → `setClient(true)`。
- 实体分支：读 entities.xml 的 `hasClient`（`:366`）/`hasCell`（`:377`）/`hasBase`（`:388`）断言属性，大小写不敏感 `true` 计 1，其余计 0；断言值进 def md5（`:375、386、397`）。
- 逐侧判定（client 例 `:416-450`；base `:459-493`；cell `:495-529`）：脚本在 + 无断言 → true；脚本在 + 有断言 → **断言赢**；脚本缺 + 无断言 → false；脚本缺 + 有断言 → 断言赢。
- client 进程（CLIENT_TYPE）直接 `setBase(true)+setCell(true)` 返回（`:452-457`）。

这条链的全部细节（路径解析、utype 分配、Interfaces/Components/Parent 合并）见 kode 仓内 `docs/source-analysis.md`——本篇不重复。

## 2. cell 迁移：两段生命之间的信使

### 2.1 cell 的创建与挂钩

base 侧调 `createCellEntity` 后，cellapp 侧创建 cell 实体并回调 base 侧：

- `onGetCell()`：base 实体拿到 cell（`server/baseapp/entity.cpp:1032`）。
- `onCreateCellFailure()`：创建失败（`server/baseapp/entity.cpp:884`）。

此时 base 侧脚本通过 `self.cell`（`server/baseapp/entity.cpp:36`，`pyGetCellEntityCall`，返回 **EntityCall 句柄**而非实体对象）与 cell 通信。

### 2.2 cell 迁移（cellapp 之间的游走）

cell 实体可以跨 cellapp 迁移（负载均衡 / space 切换）：

- `onRestore()`：cell 实体在新 cellapp 上恢复（cell 侧 `server/cellapp/entity.cpp:3868`；base 侧也有 onRestore，见 `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` §11 BaseEntityHooks）。
- teleport 系列：`onTeleport`（cellapp/entity.cpp:3783）/ `onTeleportSuccess(nearbyEntity)`（`:3811`）/ `onTeleportFailure`（teleport 失败路径 bufferOrExeCallback，同区块）。

**迁移不销毁 base 段生命**：迁走的只是 cell 实体，base 实体原地不动，`self.cell` 句柄在迁移完成后指向新 cellapp 上的实体。迁移期间的引用失效坑见[内存坑集 §2](../memory-references/memory-references.zh.md#2-cell-迁移后的引用失效)。

### 2.3 cell 的丢失

- `onLoseCell()`：base 侧感知 cell 丢失（`server/baseapp/entity.cpp:1065`）。
- `self.destroyCellEntity()`：base 侧主动拆掉 cell（`server/baseapp/entity.cpp:29`）。
- `onSpaceGone()`：cell 侧感知所在 space 没了（`server/cellapp/entity.cpp:384`）。

## 3. 销毁：两段生命各自落幕

### 3.1 脚本侧 API

`self.destroy(deleteFromDB=False, writeToDB=False)`（`lib/entitydef/entity_macro.h:20`，METH_KEYWORDS；kwargs 名单 `server/baseapp/entity.cpp:626-632、657-658`）。

- base 侧 destroy 会级联销毁 cell 实体（引擎链路细节 **TODO 待验证**：仓内分析未覆盖 base destroy → cell 销毁的完整调用链）。
- `deleteFromDB=True` 时同步删数据库记录；`writeToDB=True` 时先把最新状态写库再销毁。

### 3.2 hook 触发

- `onDestroy()`：两侧各自触发（cell 侧 `server/cellapp/entity.cpp:209`；base 侧调用点 **TODO 待验证**——VALIDATION_REPORT §11 将 `onDestroy OK（cellapp/entity.cpp:209）` 记在 BaseEntityHooks 名下，具体 base 侧调用行号仓内分析未单独取证）。
- `onWriteToDB`：写库前回调（cell 侧 `server/cellapp/entity.cpp:1259`；base 侧也有，签名带 `cellData` 参数，见 §5）。

### 3.3 销毁后脚本侧还剩什么

- `isDestroyed` 属性（`lib/entitydef/entity_macro.h:34`）在销毁后为真。
- **Python 对象本身不一定死**：destroy 是引擎语义上的销毁（实体从 entities 字典摘除、不再参与逻辑），但任何仍持有该 Python 对象引用的代码（别的实体的属性、全局列表、timer 回调闭包）都会让对象按 CPython 引用计数继续存活——这是内存坑集的第一坑，详见[内存坑集 §3](../memory-references/memory-references.zh.md#3-destroy-后仍持有引用)。

## 4. 完整生命周期 hook 全表

### 4.1 BaseEntityHooks（base 侧，8 个）

| hook | 触发时机 | 源码 |
|---|---|---|
| `onCreateCellFailure()` | createCellEntity 失败 | `server/baseapp/entity.cpp:884` |
| `onDestroy()` | base 实体销毁 | cell 侧同名参照 `cellapp/entity.cpp:209`；base 侧行号 **TODO 待验证** |
| `onGetCell()` | 拿到 cell | `server/baseapp/entity.cpp:1032` |
| `onLoseCell()` | cell 丢失 | `server/baseapp/entity.cpp:1065` |
| `onPreArchive()` | 归档前 | `server/baseapp/entity.cpp:1292` |
| `onRestore()` | base 侧恢复 | VALIDATION_REPORT §11（行号见该报告） |
| `onTimer(timerHandle, userData)` | timer 到期 | `server/baseapp/entity.cpp:1656`；实参形态 `(timerID, intptr(pUser))` 见 `entity_macro.h:1363` |
| `onWriteToDB(cellData)` | 写库前（带 cell 数据快照参数） | cell 侧参照 `cellapp/entity.cpp:1259`；`cellData` 参数语义见内存坑集 §5 |

### 4.2 CellEntityHooks（cell 侧，18 个）

| hook | 触发时机 | 源码 |
|---|---|---|
| `onDestroy()` | cell 实体销毁 | `server/cellapp/entity.cpp:209` |
| `onEnteredView(entity)` | 有实体进入视野 | `server/cellapp/entity.cpp:1783` |
| `onGetWitness()` | 获得观察者 | `server/cellapp/entity.cpp:2177` |
| `onLoseWitness()` | 失去观察者 | `server/cellapp/entity.cpp:2215` |
| `onMove(controllerID, userData)` | 移动 | `server/cellapp/entity.cpp:2943` |
| `onMoveOver(controllerID, userData)` | 移动完成 | `server/cellapp/entity.cpp:2961` |
| `onMoveFailure(controllerID, userData)` | 移动失败 | `server/cellapp/entity.cpp:2979` |
| `onRestore()` | 迁移后恢复 | `server/cellapp/entity.cpp:3868` |
| `onSpaceGone()` | space 消失 | `server/cellapp/entity.cpp:384` |
| `onTurn(controllerID, userData)` | 转向 | `server/cellapp/entity.cpp:3095` |
| `onTeleport()` | teleport 开始 | `server/cellapp/entity.cpp:3783` |
| `onTeleportFailure()` | teleport 失败 | teleport 失败路径 bufferOrExeCallback，同区块 |
| `onTeleportSuccess(nearbyEntity)` | teleport 成功 | `server/cellapp/entity.cpp:3811` |
| `onTimer(timerHandle, userData)` | timer 到期 | `server/cellapp/entity.cpp:4322` |
| `onUpdateBegin()` | 同步帧开始（witness 路径） | `server/cellapp/witness.cpp:749` |
| `onUpdateEnd()` | 同步帧结束 | `witness.cpp` onUpdateEnd 对称调用点 |
| `onWitnessed(isWitnessed)` | 被观察状态变化 | `server/cellapp/entity.cpp:1483` |
| `onWriteToDB()` | 写库前（cell 侧无 cellData 参数） | `server/cellapp/entity.cpp:1259` |

### 4.3 ProxyHooks（账号实体，6 个）

| hook | 触发时机 | 欠驱动码 |
|---|---|---|
| `onClientDeath()` | 客户端断开 | `server/baseapp/entity.cpp:1048` |
| `onClientGetCell()` | 客户端拿到 cell 数据 | `server/baseapp/proxy.cpp:248` |
| `onClientEnabled()` | 客户端激活 | `server/baseapp/proxy.cpp:178` |
| `onGiveClientToFailure()` | giveClientTo 失败 | `server/baseapp/proxy.cpp:307` |
| `onLogOnAttempt(ip, port, password) -> int` | 异地登录尝试 | `server/baseapp/proxy.cpp:189`（`"sks"`） |
| `onStreamComplete(id, success)` | 文件流完成 | `server/baseapp/proxy.cpp:832` |

## 5. 生命周期与内存引用的交界

本篇刻意不展开内存语义，只给入口：

1. **生命周期引用规则**（什么引用会把已销毁实体钉在内存里）→ 内存坑集 §1
2. **cell/base 迁移后引用失效**（EntityCall 句柄的生死）→ 内存坑集 §2
3. **destroy 后持引用**（引用计数如何让「死」实体继续被调用）→ 内存坑集 §3
4. **timer/Functor 持引用**（addTimer 句柄与回调对象的生命周期错配）→ 内存坑集 §4
5. **cellData 快照 vs 活对象**（onWriteToDB 的 cellData 是快照不是活实体）→ 内存坑集 §5

## 6. 证据来源

仓内可直接核对的分析产物（本篇引用的行号均出自这些文档的源码取证）：

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` —— typings 逐条对照 kbe/src 的核验报告（390+ 条 API 全量，含生命周期 hook 调用点）
- `docs/reference/kbengine-typings-2026-10-21/API_MATRIX.md` —— API 归属矩阵
- `docs/review/2026-10-21-entity-builtin-properties.md` —— Entity 内建属性（cell/base/isDestroyed/cellData 等）按组件分面取证
- `docs/source-analysis.md` —— entitydef 装载链、三侧存在性判定（autoMatchCompOwn）、Interfaces/Components/Parent 语义
- `todo.md` KB-001 / C-22 / C-23 条目 —— 知识库结构与后续 lint/hover 工具化规划

引擎源码本体（`kbe/src/...`）不在 kode 仓内；上述仓内文档基于用户本地 KBEngine 检出（`~/workspaces/kbengine`）产出。仓内文档未覆盖的行为，本篇一律标 TODO 待验证。
