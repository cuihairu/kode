# Player Data Clone — 源码取证与映射核实（Phase 0 / PDC-0001..0007）

状态:源码取证部分(PDC-0001/0002/0004/0005/0006)完成;PDC-0003(真实测试 MySQL 由引擎自动建表)与 PDC-0007 的「真实建表样本」阻塞——本机无 Linux 编译的引擎服务端(kbe/bin 仅 Windows 产物),编译 server 属用户级环境决策(与 IDE-LIV-003..007 同口径);本机 MariaDB 11.8.6 在运行但无可用凭据。取证引擎版本与提交记录于下,plan §9 checkbox 同步勾选已完成项。

对照计划书:`docs/design/v0.2.1-player-data-clone-plan.md`(§2 事实基线、§4 关系分类、§9 Phase 0)。

## 1. PDC-0002 引擎版本与配置事实

- 版本:`2.5.10`(`kbe/src/lib/common/kbeversion.h:10-12`:`KBE_VERSION_MAJOR 2` / `KBE_VERSION_MINOR 5` / `KBE_VERSION_PATCH 10`)。
- 两种目标版本:
  - **官方基线**:KBEngine 官方 2.5.10(最后官方发布线)。
  - **实际使用分支**:`github.com/cuihairu/kbengine`(fork)`master` @ `b6fd2ce`(2026-11-06,含 teleport/db fail-closed 等自维护修复),同 2.5.10 版本号。
- `dbInterface` / `tablePrefix` / `databaseName`:从 `dbmgr` 配置读取,见 §3(PDC-0004)与 §2 注;Kode 侧既有读取实现:`resolveDatabaseInterfaceConfig()`(`src/serverConfigMerge.ts:579`)→ `DatabaseInterfaceConfig`(`:504`,host/port/username/databaseName/characterSet/plainPassword),来源 `<dbmgr><databaseInterfaces><default>`,`extractDatabaseInterfaceConfig`(`serverConfigMerge.ts:538`)。

## 2. PDC-0001 Kode 现有 DB Schema IR / 连接 / 只读 / Profile 代码盘点(复用点)

### 2.1 表结构推导(DefDerivedSchema)

- 纯推导核心 `src/databaseSchemaCore.ts`(1538 行,零 vscode 依赖):
  - 入口 `deriveDatabaseTables`(`:233`);表构建 `buildMysqlTableSchemas`(`:1149`)。
  - 常量:默认表前缀 `DB_TABLE_PREFIX = 'tbl_'`(`:59`)、列前缀 `DB_COLUMN_PREFIX = 'sm_'`(`:61`)。
  - 属性收集(TS,非 Rust):`collectPersistentPropertiesForDefinition` 生成器(`:449`)走 def 闭包;types.xml 别名 `resolveAliasType`(`:358`)/`parseTypeAliases`(`:270`);组件模块域 `getComponentModuleScopes`(`:974`)。
  - 输入 `{entityName, defFilePath, properties, hasCellContent, tablePrefix}`(`:215-221`),输出 `{tables, tableIndex}`(`:223-226`)。
- 门面 `src/databaseSchema.ts`(1622 行):快照缓存(LRU,按 root+实体名键控)、同步入口 `getDatabaseSchemaSnapshot`(`:395`)/异步入口 `buildDatabaseSchemaSnapshotAsync`(`:533`)/调度 `scheduleDatabaseSchemaSnapshotBuild`(`:484`);前缀解析 `resolveSchemaTablePrefix`(`:1143-1147`,设置缺省空 = 引擎默认 `tbl_`);SQL 模板 `quoteSchemaTableName`(`:848`)/子表 JOIN `renderChildTableJoinSelectFor`(`:898`,`LEFT JOIN ... ON c.parentID = p.id`,`:912-914`)。
- Rust 镜像:`crates/kode-server/src/database_schema.rs`(449 行)1:1 复刻全部规则;RPC `$/kode/databaseSchema/build`(`database_schema.rs:31`,注册于 `server.rs:109`);TS 桥 `src/databaseSchemaRust.ts`(`:21` `buildDatabaseTablesInRust`,shape 校验 `:47-72`,任何不可用返 null 回落 TS;dispatch 测试 `crates/kode-server/tests/database_schema_dispatch.rs` 299 行)。
- TS/Rust 分工:同步热路径直通 TS(`databaseSchema.ts:423-425`),异步预热 Rust 优先、失败回落(`:582-588`)。

### 2.2 与真实 MySQL 的接触面(全部只读)

- 唯一 mysql2 导入点:`src/databaseDrift.ts:258`(`() => import('mysql2/promise')`;依赖 `package.json:1756` `mysql2 ^3.24.6`)。
- 连接构建:`createMysqlDriftExecutorWith`(`databaseDrift.ts:201`)→ `createConnection(buildMysqlConnectionOptions(...))`(`:206`;options 构建 `:153-164`)。
- 只读双层防线:
  1. 语句白名单 `assertReadOnlyStatement`(`:109`):首关键字仅 `SELECT/SHOW/DESCRIBE/EXPLAIN`(`:66`),禁 INSERT/UPDATE/DELETE/DDL/GRANT/TRUNCATE/多语句(`:69-90`),违者 `ReadOnlyViolationError`(`:92`)。
  2. 连接级 `SET SESSION TRANSACTION READ ONLY`(`:220`,建连后立即执行;中断挂钩 `:209-215`)。
- 漂移校验:`readTableColumns`(`:318`,`SHOW FULL COLUMNS`,`:322`)、`compareTableColumns`(`:355`)、`buildDriftReport`(`:447`)/`checkDatabaseDrift`(`:579`)、`renderDriftReport`(`:507`)、类型兼容 `isColumnTypeCompatible`(`:272`)/`normalizeColumnType`(`:262`)。
- 查询生命周期闸:`runReadOnlyQueryLifecycle`(`src/databaseQueryLifecycle.ts:49`);集成 `src/databaseQueryLifecycleIntegration.ts:165`(SET READ ONLY 期间挂死连接强制销毁);超时设置 `kbengine.databaseQueryTimeoutMs`(默认 10000ms)。
- 命令:`kbengine.database.open/simulate/exportSimulation/checkDrift/checkAllDrift/previewTable/previewSchemaImpact/showDriftEvidence`(`package.json:341-376`,全部只读面)。

### 2.3 连接 Profile 与配置

- Profile 键控连接注册表:`src/databaseConnectionRegistry.ts`(`DatabaseConnectionRegistry` `:39`,`select` `:67`),按 profileId 隔离 host/port/user/database。
- 引擎连接设置读取:`resolveDatabaseInterfaceConfig()`(`src/serverConfigMerge.ts:579`)。
- 设置:`kbengine.db.tablePrefix`(默认 `""` = 引擎 `tbl_`;`package.json:1008`)、`kbengine.databaseQueryTimeoutMs`(默认 10000)。

### 2.4 行为模拟器(纯内存,不触真实库)

- `src/databaseSimulator.ts`(766 行):零 mysql2 引用;建表 DDL 渲染 `renderMysqlDdl`(`:586`)、INSERT/JSON/文档渲染(`:637/:623/:676`);行操作 `applyRowOperation`(`:326`)、级联删除按 `parentID`(`:434-441`)、`parentID` 由模拟分配不可直写(`:267-272`)。
- **DDL 无 FOREIGN KEY/REFERENCES**——模拟器明确注记「无外键:引擎 DDL 无 FOREIGN KEY/REFERENCES,子表仅靠 parentID 逻辑关联」(`:584/:664`)。

### 2.5 其余支撑面

- `src/databaseSchemaSource.ts`(25 行):纯核心的 `SchemaSourcePorts` 适配(definitionWorkspace 文件发现/实体注册表/sharedFileSnapshot)。
- `src/databaseColumnSource.ts`(63 行)/`src/databasePreviewColumnSource.ts`(72 行):查询结果列回链 def/type 声明位。
- `src/databaseSchemaImpact.ts`(62 行):前后虚拟 schema diff(added/removed/type-changed,排除合成列)。
- `src/databaseSchemaImpactCommand.ts`(243 行):真实表 `SHOW FULL COLUMNS` 对比派生 schema(经 drift 只读执行器 + 生命周期闸)。
- 测试面:41 个数据库相关测试文件(`tests/databaseSchema.test.ts`/`databaseDrift*.test.ts`×4/`databaseQueryLifecycle*.test.ts`×2/`databaseConnectionRegistry.test.ts`/`databasePreviewColumnSource.test.ts`/`databaseColumnSource.test.ts` 等)——Phase 0 之后的回归门禁可直接挂靠。

### 2.6 现状缺口(不可当已覆盖)

- **无任何真实 FK/REFERENCES 处理逻辑**(TS/Rust 全仓无;仅 `parentID` 合成列的语义模拟与 JOIN 模板)——plan §4.2 B 类(真实数据库约束)尚无代码面。
- 无 `kode-db-clone` crate;无 information_schema 物理层读取(漂移只走 `SHOW FULL COLUMNS`);无归档/导出/导入/ID 重映射。
- Kode 侧 `parentID` 知识:合成列发射(`databaseSchemaCore.ts:1339/:1359`;Rust `:322/:342`)、NOT NULL + MUL 索引期望(`databaseDrift.ts:420/:433`)、JOIN 语义(`databaseSchema.ts:912-914`)——但「parentID 指向哪张表哪列」此前未与引擎源码对证,见 §3/§5。

## 3. PDC-0004 引擎真实持久化事实(parentID / 子表主键 / 插入读取顺序 / autoLoad)

以下行号按引擎 checkout `~/workspaces/kbengine`;缩写:`ET.h`=kbe/src/lib/db_interface/entity_table.h、`ETM.cpp`=kbe/src/lib/db_mysql/entity_table_mysql.cpp、`W.h`=db_mysql/write_entity_helper.h、`R.h`=db_mysql/read_entity_helper.h、`SQL.h`=db_mysql/sqlstatement.h、`REM.h`=db_mysql/remove_entity_helper.h、`SC.cpp`=lib/server/serverconfig.cpp、`DEFS.xml`=kbe/res/server/kbengine_defaults.xml。

- **表名前缀**:引擎无 `tablePrefix` 配置键(全仓 grep 零命中);前缀是编译期宏 `ENTITY_TABLE_PERFIX "tbl"`(`ET.h:38`)、引擎内部表 `KBE_TABLE_PERFIX "kbe"`(`ET.h:37`)。
- **主表 DDL**:`CREATE TABLE IF NOT EXISTS "tbl_" + 实体脚本模块名` + `ENGINE=InnoDB`(`ETM.cpp:390-394`;`MYSQL_ENGINE_TYPE "InnoDB"` `ETM.h:17`);表注册名=脚本模块名(`ET.cpp:134-140`)。
- **主表列**:`id bigint(20) unsigned AUTO_INCREMENT, PRIMARY KEY idKey(id)`(`ETM.cpp:392`,`TABLE_ID_CONST_STR "id"` `ET.h:39`——实体 DBID 存 `id` 列,无 `sm_dbid` 列);`sm_autoLoad tinyint not null default 0` + `INDEX(sm_autoLoad)`(`ETM.cpp:417-418`;索引 `sync_autoload_item_index` `ETM.cpp:110-122`);实体有 cell 时追加合成 `position`/`direction` 两个 VECTOR3(`ETM.cpp:173-208`,无 cell 跳过),展开为 `sm_0_position..sm_2_direction`(`ETM.h:309-313`)。
- **ARRAY 子表**:`EntityTableItemMysql_ARRAY::initialize`(`ETM.cpp:1218-1289`):子表名 = 实体名 + 祖先项名链(非空段,reverse)+ `_` + 属性名(空则常量 `values`,`ET.h:43`);元素列 itemName=`value`(`ET.h:42`,`ETM.cpp:1250-1257`,FD 元素为空串),实际列名经 `init_db_item_name` 加 `sm_` 前缀;`isChild(true)`(`ETM.cpp:1266`)。
- **子表合成列**:`parentID bigint(20) unsigned NOT NULL, INDEX(parentID)`(`ETM.cpp:379-380`)+ 标准 `id` 主键(`ETM.cpp:392`)+ `sm_autoLoad`(`ETM.cpp:417`)。
- **ENTITY_COMPONENT 子表**:`EntityTableItemMysql_Component::initialize`(`ETM.cpp:1507-1560`):子表名 = `<父表名>_<组件属性名>`(`ETM.cpp:1520`),`isChild(true)`(`:1523`),遍历组件持久属性建列(`:1527-1555`),期望至多一行(`KBE_ASSERT(dbids.size()==1)` `:1591`);实体无 cell 时跳过 cell-only 组件属性(`ETM.cpp:150-154,1534-1537`)。
- **parentID 关联**:类型 `DBID`=`uint64`(`common/platform.h:354`);写侧 INSERT 列表前插 `parentID`、值 `PRDBID` 格式化(`SQL.h:82-91`);读侧子表 SELECT 含 `id,parentID,...` 并按 `WHERE parentID in(...)`/`= parentID` 过滤(`SQL.h:227-247`),行 parentID 索引进 `context.dbids[parentID]`(`R.h:183-187`);**无外键**——`parentID` 是普通列+索引,靠引擎写/读/删逻辑维护完整性(见 §5 B 类)。
- **插入顺序**:父表 INSERT 先(`W.h:70`),`dbid = LAST_INSERT_ID`(`W.h:71`;`mysql_insert_id` `db_interface_mysql.cpp:569`),再对每个子表 `parentTableDBID = context.dbid` 递归写(`W.h:84-88`)。更新路径先按 `parentID` 重读子表既有 `id`(`W.h:122-192`),再复用/插入/删除对齐(`W.h:195-281`)。
- **读取顺序**:主表 `SELECT ... WHERE id=<dbid>` 先(`R.h:35-136`,`SQL.h:219-224`),再逐子表 `queryChildDB` 递归按 `parentID in(...)`(`R.h:127-133,236-249`);主表无行返回 false(`ETM.cpp:865-866`)。
- **autoLoad**:`sm_autoLoad` tinyint 0/1;`queryAutoLoadEntities` 按 `WHERE sm_autoLoad=1 LIMIT <start>,<end-start>`(`ETM.cpp:475-502`);写后置位 `update ... set sm_autoLoad=<0|1> where id=<dbid>`(`ETM.cpp:766-775`,调用点 `ETM.cpp:813-815`;写失败也置位 `ET.cpp:47-54`)。
- **删除顺序**:子表先删(`REM.h:152-199`)再父表(`REM.h:31-50`)。
- **Redis 后端**:`EntityTableRedis::writeTable` 恒返回 0(`entity_table_redis.cpp:327-330`)、`queryTable` 无数据(`:339-342`)、ARRAY/FIXED_DICT 子表 init 空操作(`:479-509`)——仅 `createItem` 物化类型串(`:204-316`);即 Redis 后端**不持久化实体**(仅类型字符串),实体持久化实质走 MySQL。

## 4. PDC-0005 列二进制表示与驱动转换

**KBEngine 类型 → MySQL 列型**(`EntityTableMysql::createItem`,`ETM.cpp:505-763`):

| KBEngine 类型 | SQL 列型 | 位置 |
|---|---|---|
| INT8 | `tinyint(@DATALEN@) not null DEFAULT n` | `ETM.cpp:522-523` |
| INT16 | `smallint(@DATALEN@) not null DEFAULT n` | `ETM.cpp:540-541` |
| INT32 | `int(@DATALEN@) not null DEFAULT n` | `ETM.cpp:558-559` |
| INT64 | `bigint(@DATALEN@) not null DEFAULT n` | `ETM.cpp:576-577` |
| UINT8 | `tinyint(@DATALEN@) unsigned not null DEFAULT n` | `ETM.cpp:594-595` |
| UINT16 | `smallint(@DATALEN@) unsigned not null DEFAULT n` | `ETM.cpp:612-613` |
| UINT32 | `int(@DATALEN@) unsigned not null DEFAULT n` | `ETM.cpp:630-631` |
| UINT64 | `bigint(@DATALEN@) unsigned not null DEFAULT n` | `ETM.cpp:648-649` |
| FLOAT | `float(@DATALEN@) not null DEFAULT n` | `ETM.cpp:666-667` |
| DOUBLE | `double(@DATALEN@) not null DEFAULT n` | `ETM.cpp:684-685` |
| STRING | `varchar(@DATALEN@) not null DEFAULT '...'`(默认 255) | `ETM.cpp:689-690,1829-1833` |
| UNICODE | `varchar(@DATALEN@) not null DEFAULT '...'`(默认 255) | `ETM.cpp:694-695,1899-1903` |
| PYTHON / PY_DICT / PY_TUPLE / PY_LIST | `blob` | `ETM.cpp:699-712` |
| BLOB | `blob` | `ETM.cpp:715` |
| ARRAY | (无父列)→ 子表 | `ETM.cpp:717-720` |
| FIXED_DICT | 每键一列 | `ETM.cpp:721-724`;展开 `ETM.cpp:1396-1415` |
| VECTOR2 | 2× `float not null DEFAULT 0` | `ETM.cpp:739-742`(int 若 `CLIENT_NO_FLOAT` `:726-729`) |
| VECTOR3 | 3× `float not null DEFAULT 0` | `ETM.cpp:743-746` |
| VECTOR4 | 4× `float not null DEFAULT 0` | `ETM.cpp:747-750` |
| ENTITYCALL | `blob`(声明)但**从不建列** | `ETM.cpp:752-755`;空 sync `:1191-1194` |
| ENTITY_COMPONENT | (无父列)→ 子表 | `ETM.cpp:756-759` |

`@DATALEN@` 在同步期以 `getDatabaseLength()`(或 FD 键长)替换,长度 ≤0 时按默认处理(`ETM.cpp:1641-1662` 数字、`:1819-1839` STRING、`:1889-1909` UNICODE)。

**驱动转换(无预处理语句)**:全仓 grep **零** `MYSQL_BIND`/`mysql_bind`/`mysql_stmt`/预处理语句——值一律转成 **SQL 字符串字面量**内嵌语句:
- 数值/向量:`kbe_snprintf(sqlval,"%d/%u/%f/%lf/...")`(`ETM.cpp:1002-1006,1085-1089,1168-1172,1748-1803`)。
- STRING/UNICODE/BLOB/PYTHON:`mysql_real_escape_string` + 引号包裹(`ETM.cpp:1866-1870,1934-1939,1986-1991,2038-2043`)。
- 执行 `mysql_real_query`(`db_interface_mysql.cpp:479`);结果以文本读回 `mysql_store_result`/`mysql_fetch_row`/`mysql_fetch_lengths`(`R.h:50,62-63`),逐型 `atoi`/`atof`/`str2value` 解析(`ETM.cpp:1665-1734,967-982,1052-1065,1135-1148`)。
- 字符集:`mysql_set_character_set`(`db_interface_mysql.cpp:246`)+ `SET NAMES` 式 `characterset_sql`(`:256-258`)。

**Pickler 位置**:`db_mysql`/`db_interface` **不用** `Pickler::pickle`;pickle 发生在实体 def 序列化层——`PythonType::addToStream` 调 `Pickler::pickle` 后 `appendBlob`(`entitydef/datatype.cpp:1227`),反向 `createFromStream`→`Pickler::unpickle`(`:1240`)。故 PYTHON 型属性值在 dbmgr 收到前已 pickle 成字节,db_mysql 将其存为 `blob`(`ETM.cpp:2030-2049`);BLOB 同型(`:1978-1997`)。其余类型用原生 SQL 类型(int/float/varchar),不走 pickle。

## 5. PDC-0006 关系分类与安全边界

对照 plan §4.2 的 A–E 五类,源码证据定界:

| 类别 | 证据 | v1 行为 |
|---|---|---|
| A 引擎确定关系 | 主表→ARRAY 子表(`ETM.cpp:1218-1289`)、主表→组件子表(`ETM.cpp:1507-1560`)、`parentID` 逻辑关联(无 FK,引擎写读删维护) | 自动发现与复制 |
| B 真实数据库约束 | 引擎 DDL **无任何 FOREIGN KEY/REFERENCES**(db_mysql 全目录零命中;`ETM.cpp:380` 仅 `INDEX(parentID)`)——B 类在引擎生成数据中**为空**,除非工程手工加过 FK | 无需处理(默认空) |
| C 显式业务关系 | 属性值存实体 ID(如 `Account.characters` ARRAY<INT64> 存 Avatar dbid、`guildDBID` INT64)——引擎当纯数据处理,不可自动识别 | 用户声明规则才跟随/重写 |
| D 不明结构 | PYTHON/PY_DICT/PY_TUPLE/PY_LIST/BLOB 列(pickle 字节内可能嵌实体 ID,不可内省) | 默认不改、标风险,必要时插件 codec |
| E 外部资源 | `kbe_` 内部表:`kbe_accountinfos`(`kbe_table_mysql.cpp:584-595`)、`kbe_entitylog`(`:41-50`)、`kbe_serverlog`(`:304-309`)、`kbe_email_verification`(`:1302-1308`) | 默认排除,提供缺失报告 |

**安全边界**:
- `kbe_` 内部表默认 **deny**(§4.1 allow/deny 策略)。
- `sm_*` 字段引擎托管:`sm_autoLoad` 写后置位(`ETM.cpp:766-775`)、`sm_position/sm_direction` 存档覆盖(`ETM.cpp:173-208`)——直接读库 ≠ 在线 Entity 当前值(plan §2 警示),克隆须在计划书 §4.1 允许面上注明「在线实体后续存档可能覆盖」。
- 引擎无「隐私字段」概念——隐私属工程声明(plan §4.3 DSL:`loginCredentials: redact`、`playerName: generate-unique-local`、`autoLoad: disable`)。
- 只读导出面已有强制只读双层防线可复用(kode 侧,见 §2.2):语句白名单 + `SET SESSION TRANSACTION READ ONLY`。

## 6. 映射核实(CLONE-P0 验收核心:kode 类型图推导 vs 引擎真实库表)

**结论:逐规则一致,未发现分叉。** 对照表(kode 侧 `src/databaseSchemaCore.ts` 亲验;引擎侧 §3/§4 行号):

| 规则 | kode 推导 | 引擎真实 | 判定 |
|---|---|---|---|
| 主表名 | `${tablePrefix}${entityName}`(`:1157`) | `tbl_` + 脚本模块名(`ETM.cpp:390-391`) | 一致(注①) |
| 主表固定列 | `id bigint unsigned PRIMARY` + `sm_autoLoad tinyint INDEX`(`:1171-1174`) | `id bigint(20) unsigned AUTO_INCREMENT PRIMARY`(`ETM.cpp:392`)+ `sm_autoLoad tinyint not null default 0`+INDEX(`ETM.cpp:417-418`) | 一致(注②) |
| hasCell 六列 | `sm_0_position..sm_2_direction`(`:1176-1184`) | position/direction VECTOR3 → `sm_%d_<name>`(`ETM.cpp:173-208`,`ETM.h:309-313`) | 一致 |
| ARRAY 子表名 | `buildArrayTableName`:当前表+非空链段+`_<name\|\|'values'>`(`:1307-1323`) | 实体名+祖先非空链(reverse)+`_<name\|\|'values'>`(`ETM.cpp:1228-1257`,`ET.h:43`) | 一致 |
| ARRAY 子表合成列 | `id`/`parentID`/`sm_autoLoad`(`:1337-1341`) | `id`+`parentID`+`INDEX(parentID)`+`sm_autoLoad`(`ETM.cpp:379-380,392,417`) | 一致 |
| ARRAY 元素列 | `expandColumnNames`→`sm_value`(元素名 `'value'`,`:763`,`:1286`) | itemName `'value'`(`ETM.cpp:1250-1257`)经 `init_db_item_name`→`sm_value`(`ETM.cpp:938-941` 经 `:215-230` 循环) | 一致(注③) |
| ENTITY_COMPONENT 子表名 | `${currentTableName}_${property.name}`(`:1238`) | `<父表名>_<组件属性名>`(`ETM.cpp:1520`) | 一致 |
| ENTITY_COMPONENT 跳过 | `!entityHasCell && !scopes 含 'base'`(`:1230-1235`) | 实体无 cell 时跳过 cell-only 组件属性(`ETM.cpp:150-154,1534-1537`) | 一致 |
| ENTITYCALL | 不落列(`:1256-1260`) | `syncToDB` 空操作(`ETM.cpp:1191-1194`) | 一致 |
| FIXED_DICT | 键名前缀累积,无子表(`:1262-1266`) | 每键一列(`ETM.cpp:721-724,1396-1415`) | 一致 |
| 叶子列命名 | VECTOR2/3/4 `sm_%d_<fd><name>`,否则 `sm_<fd><name>`(`:1365-1378`) | `sm_%d_<exstr><name>`(`ETM.h:309-313`)/`sm_<name>`(`ETM.cpp:938-941`) | 一致 |
| 类型标签 | `SIMPLE_DB_TYPE_LABELS` 17 项(`:182-201`) | `createItem` 开关(`ETM.cpp:505-763`) | 一致(逐项匹配) |
| STRING/UNICODE 长度 | 无/≤0 → 255(`:1403-1408`) | 默认 255(`ETM.cpp:1829-1833,1899-1903`) | 一致 |

**注**:
- ① 引擎 `tablePrefix` 是编译期常量 `tbl`(无配置键);kode 的 `kbengine.db.tablePrefix` 是 kode 侧覆写,用于指向**改过前缀的工程**(前缀在工程侧编译期改),非引擎配置读取。实体 def 名 = 脚本模块名(标准情形),除非 def 声明 `ScriptModule` 覆写——覆写时 kode 用 def 名、引擎用脚本模块名,属未覆盖边角,Phase 1 前需以真实 `ScriptModule` 用例复核(现无此类用例在仓内)。
- ② kode `id` 标签 `bigint unsigned` 与引擎 `bigint(20) unsigned` 类型等价(`(20)` 为已废弃显示宽度)。
- ③ agent 摘要「元素列名 = value」为 itemName 读法;实际列名经 `init_db_item_name` 加 `sm_` 前缀为 `sm_value`,与 kode 的 `expandColumnNames` 一致(亲验 `ETM.cpp:938-941`+`:215-230` 循环)。

## 7. PDC-0003 / PDC-0007 状态(阻塞如实)

- **PDC-0003(真实测试 MySQL 由引擎自动建表)阻塞**:本机 `~/workspaces/kbengine/kbe/bin` 无 Linux 编译产物(仅 Windows dll),`~/workspaces/kbengine-build/` 亦无编译 server 二进制(仅 `typings/examples/cellapp` Python 示例)——**编译 server 属用户级环境决策**(与 IDE-LIV-003..007 同口径,不宜 agent 自行起建)。本地 MariaDB 11.8.6 在运行(`mysqld` 运行中、socket `/var/run/mysqld/mysqld.sock`),但 `root` socket 认证与 `cui` 均无可用凭据(`ERROR 1698/1045`),无法建 fixture 库表。
- **PDC-0007(真实建表样本 + Golden Schema)部分**:源码级 DDL 分析已给出精确 `CREATE TABLE`(§3/§4,可直接作 DDL 依据);但「真实建表样本」(引擎建出的实际表)与 Golden Schema 依赖 PDC-0003,未完成。

## 8. 结论与 Phase 1 可依赖事实

- **映射已核实一致**(主表/ARRAY/组件/parentID 归属);kode 的 `deriveDatabaseTables` 可作为 Phase 1 关系图的表结构源,`kode-db-clone` 的 SchemaResolver 不必重写推导,只需在推导结果上叠加物理层与关系图。
- **Phase 1 RelationGraph 可依赖**:A 类引擎确定关系 = 主表→ARRAY 子表 + 主表→组件子表 + `parentID` 逻辑关联;**B 类(真实 FK)在引擎生成数据中为空**;C 类(业务引用)需用户声明;D 类(pickle blob)不可内省;E 类(`kbe_` 表)排除。
- **阻塞项**:PDC-0003/0007 待引擎编译 + MySQL 凭据(用户级决策);`ScriptModule` 覆写边角(注①)待真实用例复核。
- **复用点**:Kode 既有 `databaseSchemaCore.ts`/`database_schema.rs`(推导)、`databaseDrift.ts`(只读漂移,白名单+`SET TRANSACTION READ ONLY`)、`databaseConnectionRegistry.ts`(Profile 连接)、`databaseSimulator.ts`(DDL/行模拟,明确无 FK)、`databaseQueryLifecycle.ts`(超时/取消)——Phase 1 直接挂靠。

**待办(下一批)**:PDC-0003(引擎编译后自动建表)+ PDC-0007(真实样本+Golden Schema)在环境就绪后补;Phase 1(PDC-0101..0107)待 PDC-0007 验收门开启。
