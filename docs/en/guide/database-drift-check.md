# Database Drift Check


The command `kbengine.database.checkDrift` (`Check Database Drift`) takes the real MySQL table structures and reverse-checks the virtual table structures derived from `.def` files.

`kbengine.database.checkAllDrift` (`Check All Database Drift`) checks every entity in the workspace, reads the table list once, and treats the union of entity tables as expected when identifying prefixed residual tables.

The single-entity command only treats prefixed tables under that entity's name as residual candidates, avoiding false positives for other entities. The all-entity command checks residual tables across the configured prefix.

## Why It Exists

The table and column names in the schema view and property hovers are **derived** by kode following the engine's loading semantics (`src/databaseSchema.ts`, aligned with `entity_table_mysql.cpp`). Four spots in the derivation chain are the easiest to get wrong:

| Step | Consequence when wrong |
| --- | --- |
| Which properties enter the table | A hover points to a column that does not exist in the database |
| Type mapping (`UINT8` → `tinyint unsigned` etc.) | SQL written against the wrong column type |
| Container splitting into child tables (ARRAY / component slots) | Assuming data is in the main table when it is in a child table |
| Column name conversion (`sm_` prefix, vector index first, `FIXED_DICT` key chain) | The column name cannot be spelled out |

These errors are all self-consistent on the derivation side; only comparing against the real table structures exposes them — that is this command's purpose.

## Check Rules

Compared table by table, reporting table, column type, nullability, default, and index differences:

| Marker | Meaning |
| --- | --- |
| `[缺表]` (missing table) | The virtual table does not exist in the database: this entity or container property has not gone through table creation yet |
| `[缺列]` (missing column) | Columns the virtual table has but the real table does not (property added, table not rebuilt in sync) |
| `[多列]` (extra column) | Columns the real table has with no corresponding def property |
| `[型别不符]` (type mismatch) | Same-named column whose type differs from the derivation (only integer display widths are ignored: `bigint unsigned` ≡ `bigint(20) unsigned`; `varchar(64)` differs from `varchar(128)`) |
| `[残留表]` (leftover table) | Tables in the database carrying the table prefix that are not in the virtual structure: the property was deleted, the table remains |
| `[可空性不符]` / `[默认值不符]` | Actual column constraints differ from engine rules and the property's `<Default>` |
| `[索引不符]` | Primary, `INDEX`, `UNIQUE`, `sm_autoLoad`, or child-table `parentID` index state differs |

The whole report goes to the OUTPUT panel "KBEngine 数据库漂移" and can be copied back in full; a warning pops when there are problems, an info notice when there is no drift.

## Where Connection Info Comes From

Read directly from KBEngine's own engine configuration, **adding no settings of its own**: the synthesized `<dbmgr><databaseInterfaces><default>` (engine `kbengine_defaults.xml` + component `kbengine.xml` same-key override); port `0` falls to the MySQL default 3306.

The account password must be stored in plaintext (`<encrypt>false</encrypt>`). The engine default `encrypt=true` is RSA ciphertext, which kode does not decipher — in that case the command honestly reports "未校验" (not checked) instead of making the user hand-fill a password or change the engine config just to run one check.

## Read-Only Red Line

The user's 2026-10-15 order (translated): "Only provide query commands; the other commands are too dangerous." The implementation has double protection:

1. **Statement whitelist**: only `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` pass. `INSERT` / `UPDATE` / `DELETE` / DDL (`CREATE` / `DROP` / `ALTER` / `TRUNCATE`) / `GRANT` / any multi-statement is rejected with the reason stated. Comments and string literals are stripped before the check, so write operations hidden inside queries like `SELECT ... FOR UPDATE` or `SELECT ... INTO OUTFILE` are also blocked.
2. **Read-only session**: on connect, `SET SESSION TRANSACTION READ ONLY` is executed; even if some future template generated something else, the database layer would refuse writes.

Only two statement forms are issued: `SHOW TABLES` and `SHOW FULL COLUMNS FROM <table>`. The latter reads MySQL's `Null`, `Default`, and `Key` metadata. Batch checks reuse one connection and use all entity tables to identify residual tables.

## When the Connection Fails

Engine not running, encrypted password, account without `SELECT` privilege, network unreachable — all degrade to **"未校验" (not checked)** with the reason honestly stated, no error popup. Drift checking is an enhancement; it should not take the whole command down; the report says "未校验：……" (not checked: ...) rather than "passed".

## Manual Verification

Without connecting to the database, the three SQL lines at the end of each table in the schema view let you check by hand:

```sql
SQL: SELECT * FROM `game_db`.`tbl_Hero` LIMIT 100;
SQL(属性列): SELECT `sm_hp`, `sm_name` FROM `game_db`.`tbl_Hero` LIMIT 100;
SQL(子表 JOIN): SELECT p.`id` AS parentID, c.`id`, c.`parentID`, c.`sm_autoLoad`, c.`sm_value` FROM `game_db`.`tbl_Hero` AS p LEFT JOIN `game_db`.`tbl_Hero_bag` AS c ON c.`parentID` = p.`id` LIMIT 100;
```

The table name prefix can be overridden via `kbengine.db.tablePrefix` (default empty = engine default `tbl_`); see the [configuration reference](./configuration.md).
