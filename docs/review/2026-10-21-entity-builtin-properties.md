# Entity 内建属性提示缺口——kbengine 源码核对报告

日期: 2026-10-21 · 范围: `self.id` / `self.databaseID` 等内建属性在 kode 中无同等提示的成因与全集取证
方法: 逐文件读 `kbe/src` 注册面（SCRIPT_GET/SET 宏与保留属性清单），全部结论带 file:line；引擎检出为
`/home/cui/workspaces/kbengine`。

## 1. 结论

- 引擎侧 Entity 的脚本可见内建属性是**按组件分面**的（baseapp/cellapp/client 各一套 getset 表），
  外加 `.def` 保留属性名单（系统注入，禁止在 def 中重定义）。
- kode 现状：内建属性名散见于 `defAnalyzer.ts` / `messageTable.ts` / `monitoringCollector.ts` /
  `kbeModuleIndex.ts`（消息字段、监控面、模块级符号桩），但 **python 编辑面的 `self.<属性>` 悬停/补全
  没有消费任何一份属性清单**——这是「self.id、self.databaseID 没有同等提示」的直接成因。
- 用户手整理的 `kbengine/typings` 修正版（28d2117）已含 13 个 cellapp 侧属性与 id/className 等，
  **数据源已备**，缺的是 kode 侧接线：属性提示索引 + 按组件分面。
- 配套：`self.cell.X` / `self.base.X` 的调用关系修复（段过滤）已另立实现单（本报告 §5 提及口径）。

## 2. 引擎内建属性全集（按组件）

### 2.1 公共宏（所有实体类继承）

`lib/entitydef/entity_macro.h`：

| 属性 | 读写 | 行 | 说明 |
|---|---|---|---|
| id | GET | :33 | 实体 DBID/entityID（服务端宏块） |
| isDestroyed | GET | :34 | |
| className | GET | :35 | |

客户端宏块 `CLIENT_ENTITY_GETSET_DECLARE_BEGIN`（同文件 :56-61）：id(:58)、spaceID(:59)、isDestroyed(:60)、className(:61)。

### 2.2 baseapp 服务端（`server/baseapp/entity.cpp:35-42`）

宏公共三项 + 下列；块在 `ENTITY_GETSET_DECLARE_BEGIN(Entity)`(:35) 与 `ENTITY_GETSET_DECLARE_END()`(:42) 之间：

| 属性 | 读写 | 行 |
|---|---|---|
| cell | GET | :36（pyGetCellEntityCall，EntityCall 句柄） |
| client | GET | :37 |
| databaseID | GET | :38（pyGetDBID） |
| databaseInterfaceName | GET | :39 |
| shouldAutoBackup | GET+SET | :40 |
| shouldAutoArchive | GET+SET | :41 |

### 2.3 cellapp 服务端（`server/cellapp/entity.cpp:73-89`）

宏公共三项 +：

| 属性 | 读写 | 行 |
|---|---|---|
| base | GET | :74 |
| client | GET | :75 |
| allClients | GET | :76 |
| otherClients | GET | :77 |
| isWitnessed | GET | :78 |
| hasWitness | GET | :79 |
| isOnGround | GET | :80 |
| spaceID | GET | :81 |
| layer | GET+SET | :82 |
| position | GET+SET | :83（Vector3） |
| direction | GET+SET | :84 |
| topSpeed | GET+SET | :85 |
| topSpeedY | GET+SET | :86 |
| controlledBy | GET+SET | :87 |
| volatileInfo | GET+SET | :88 |

### 2.4 客户端（`lib/client_lib/entity.cpp:40-46`）

客户端宏四项 + base(:41 GET)、cell(:42 GET)、clientapp(:43 GET)、position(:44 GET+SET)、
direction(:45 GET+SET)、velocity(:46 GET+SET，pyGetMoveSpeed)。

### 2.5 实体组件 EntityComponent

`server/baseapp/entity_component.cpp:14-22`：ownerID(:15)、owner(:16)、name(:17)、className(:18)、
isDestroyed(:19)、cell(:20)、client(:21)。客户端件 `lib/client_lib/entity_component.cpp:18-20`：
className/isDestroyed/cell 同款。

### 2.6 系统保留属性（def 禁止重定义）

`lib/entitydef/common.h:124-157` `ENTITY_LIMITED_PROPERTYS`（注释：被限制的系统属性，def 中不允许定义）：

id、position、direction、spaceID、autoLoad、cell、base、client、cellData、className、
databaseID、isDestroyed、shouldAutoArchive、shouldAutoBackup、__ACCOUNT_NAME__、__ACCOUNT_PASSWORD__、
clientAddr、clientEnabled、hasClient、roundTripTime、timeSinceHeardFromClient、allClients、hasWitness、
isWitnessed、otherClients、topSpeed、topSpeedY、interface。

位置/朝向的底座别名见 `common.h:118-121`（ENTITY_BASE_PROPERTY_ALIASID_POSITION_XYZ=1、
DIRECTION_ROLL_PITCH_YAW=2、SPACEID=3）——即 position/direction/spaceID 走别名注入而非普通 def 属性。

**附带发现（引擎侧字面量怪癖）**：`common.h:137-138` 为跨行相邻字符串 `\"component\"`（无逗号）+ `\"databaseID\"`，
C 字符串拼接后实际入表项为 `componentdatabaseID`；`:155-156` 的 `\"interface\"` + `\"\"` 拼接无害。
对 kode 无直接影响（该表只用于 def 校验黑名单），记录备查。

## 3. 可用数据源盘点（修提示时直接消费，零自创）

| 数据源 | 位置 | 现状 |
|---|---|---|
| 引擎 getset 表 | 上述 file:line | 已取证（本报告） |
| 修正版引擎 typings | `kbengine/typings/_KBEngine_*.pyi`（28d2117） | 含属性声明与类型（id: int 等），已随 2cc8c13 快照进 kode `docs/reference/kbengine-typings-2026-10-21/` |
| 引擎内建→python 映射 | `src/pythonTypeStubs.ts` PYTHON_BUILTIN_TYPE_ANNOTATIONS | 已有（UINT8→int 等，kbengine datatypes.cpp 对齐） |
| def 段解析 | `src/defAnalyzer.ts`、`clientSdkGenerator.ts` readDefMethods | 已有 |

## 4. 缺口与修复建议（待实现，另立单）

1. **属性提示索引**：新增「Entity 内建属性表」（按组件分面：baseapp/cellapp/client，含类型引自
   PYTHON_BUILTIN_TYPE_ANNOTATIONS 或 typings），接到 python 编辑面的 hover + 补全：
   `self.<属性名>` 在实体脚本中命中 → 提示「KBEngine 内建属性（<组件>侧）：类型，读写性」，
   与方法面的 def 声明提示同级。无前缀脚本（非实体类）不接管。
2. **读写性标注**：GET 属性（如 baseapp 的 databaseID）提示「只读」，GET+SET（position 等）标注可写，
   避免误导赋值。
3. **组件分面**：base 脚本给 baseapp 面 + 宏公共三项；cell 脚本给 cellapp 面；client.py 给客户端面。
   依据是脚本所在 def/文件身份（与方法段过滤同源判定）。
4. **与调用关系修复合并验收**：`self.cell.X` 段过滤（CellMethods/BaseMethods/ClientMethods）落地后，
   属性与方法两面共享同一「self. 前缀→组件面」的解析底座。

## 5. 关联口径

- `self.cell.X` → 仅 CellMethods 段候选；`self.base.X` → 仅 BaseMethods；`self.client.X` → ClientMethods；
  无前缀维持现行（域目录 + 形参/类型闸门）。已派实现单。
- 桩导出目录 `.kbengine` 可配置（默认 `.kbengine`）+ 删除后默认自动生成，已并入同一实现单。
