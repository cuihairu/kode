# 数据库漂移校验


命令 `kbengine.database.checkDrift`（`Check Database Drift`）拿真实 MySQL 表结构，反向校验 `.def` 推导出的虚拟表结构。

命令 `kbengine.database.checkAllDrift`（`Check All Database Drift`）会检查所有工作区实体，一次读取表清单，并以所有实体表的并集识别带前缀的残留表。

单实体命令只把当前实体名下的带前缀表视为残留候选，避免把其他实体的正常表误报；全量命令才会检查整个配置前缀下的残留表。

## 为什么要有它

schema 视图与属性悬停里的表名列型，都是 kode 按引擎装载语义**推导**出来的（`src/databaseSchema.ts`，对齐 `entity_table_mysql.cpp`）。推导链有四段最容易算错：

| 环节 | 算错时的后果 |
| --- | --- |
| 哪些属性进表 | 悬停指向一个库里不存在的列 |
| 类型映射（`UINT8` → `tinyint unsigned` 等） | 拿错列型去写 SQL |
| 容器拆子表（ARRAY / 组件槽） | 以为数据在主表，实际在子表 |
| 列名转换（`sm_` 前缀、向量 index 前置、`FIXED_DICT` 键链） | 列名拼不出来 |

这些错误在推导侧都自洽，只有拿真实表结构对一遍才会暴露——这就是本命令的用途。

## 校验口径

逐表比对，报告表、列型、可空性、默认值和索引差异：

| 标记 | 含义 |
| --- | --- |
| `[缺表]` | 虚拟表在库里不存在：该实体或该容器属性尚未走过建表流程 |
| `[缺列]` | 虚拟表有、真实表没有的列（属性新增后没同步建表） |
| `[多列]` | 真实表有、def 无对应属性的列 |
| `[型别不符]` | 同名列的型别与推导不一致（仅忽略整数显示宽度：`bigint unsigned` ≡ `bigint(20) unsigned`；`varchar(64)` 与 `varchar(128)` 会区分） |
| `[残留表]` | 库里带表前缀的表不在虚拟表结构里：属性删了，表还留着 |
| `[可空性不符]` / `[默认值不符]` | 真实列约束与引擎从属性类型和 `<Default>` 推导的约束不同 |
| `[索引不符]` | 主键、`INDEX`、`UNIQUE`、`sm_autoLoad` 或子表 `parentID` 的索引状态不同 |

报告整段写进 OUTPUT 面板「KBEngine 数据库漂移」，可整段复制回传；有问题时弹警告，无漂移弹信息提示。

## 连接信息从哪来

直接读 KBEngine 自身的引擎配置，**不新增任何设置项**：合成后的 `<dbmgr><databaseInterfaces><default>`（引擎 `kbengine_defaults.xml` + 元件 `kbengine.xml` 同键覆盖），端口 `0` 落 MySQL 默认 3306。

账号密码需要明文存放（`<encrypt>false</encrypt>`）。引擎默认的 `encrypt=true` 是 RSA 密文，kode 不解读——这种情况下命令如实提示「未校验」，而不是让用户为了跑一次校验去手填密码或改引擎配置。

## 只读红线

用户 2026-10-15 明令「只提供查询命令，其他的命令太危险了」，实现上做了双保险：

1. **语句白名单**：只放行 `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN`。`INSERT` / `UPDATE` / `DELETE` / DDL（`CREATE` / `DROP` / `ALTER` / `TRUNCATE`）/ `GRANT` / 任何多语句一律拒绝，并说明拒绝原因。判定前先剥掉注释与字符串字面量，`SELECT ... FOR UPDATE`、`SELECT ... INTO OUTFILE` 这类藏在查询里的写操作同样被拦。
2. **只读会话**：建连即执行 `SET SESSION TRANSACTION READ ONLY`，即便将来模板生成出别的东西，数据库层面也写不进去。

实际发出的语句只有两种：`SHOW TABLES` 与 `SHOW FULL COLUMNS FROM <表名>`。后者读取 MySQL 返回的 `Null`、`Default`、`Key` 元数据；批量检查复用一次连接，并将全部实体表作为残留表判断依据。

## 连不上怎么办

引擎没起、密码是密文、账号没有 `SELECT` 权限、网络不通——一律降级为**「未校验」**并如实说明原因，不弹错误。漂移校验是增强功能，不该把命令整挂；报告里写的是「未校验：……」而不是「通过」。

## 手动核对

不想连库时，用 schema 视图每表尾部那三行 SQL 也能自己查：

```sql
SQL: SELECT * FROM `game_db`.`tbl_Hero` LIMIT 100;
SQL(属性列): SELECT `sm_hp`, `sm_name` FROM `game_db`.`tbl_Hero` LIMIT 100;
SQL(子表 JOIN): SELECT p.`id` AS parentID, c.`id`, c.`parentID`, c.`sm_autoLoad`, c.`sm_value` FROM `game_db`.`tbl_Hero` AS p LEFT JOIN `game_db`.`tbl_Hero_bag` AS c ON c.`parentID` = p.`id` LIMIT 100;
```

表名前缀可由 `kbengine.db.tablePrefix` 覆盖（缺省空 = 引擎默认 `tbl_`），详见 [配置说明](./configuration.md)。
