# Database Simulation

[English](./database-simulation.en.md) | [中文](./database-simulation.md)

The command `kbengine.database.simulate` simulates "table creation + first batch of row data" on top of a database schema snapshot and opens a `.dbsim` virtual document; `kbengine.database.exportSimulation` exports the current simulation document as Markdown. The simulation rules align item by item with the engine's dbmgr/baseapp MySQL persistence implementation (kbe/src/lib/db_mysql / kbe/src/lib/db_interface); all differences are honestly listed at the end of the document.

## What Is Simulated

| Block | Content | Engine source |
| --- | --- | --- |
| DDL | Per table `CREATE TABLE IF NOT EXISTS`, with `id bigint(20) unsigned AUTO_INCREMENT`, `PRIMARY KEY idKey (id)`, `) ENGINE=InnoDB` | `entity_table_mysql.cpp:390-395` |
| Child table columns | `parentID bigint(20) unsigned NOT NULL` + `INDEX(parentID)` | `entity_table_mysql.cpp:379-380` |
| autoLoad | `sm_autoLoad tinyint not null DEFAULT 0` | `entity_table_mysql.cpp:416-418` |
| Column names | Top level prefixed `<fdName>_`, nested names accumulate the key chain, VECTOR indexes first, ARRAY child tables `values`/reversed ancestor chain | `entity_table_mysql.cpp:215-231`, `:1486-1498`, `:268-272`, `:1228-1257` |
| Per-type DDL | INT8-64/UINT8-64 → `tinyint`..`bigint`; FLOAT/DOUBLE → `float`/`double`; STRING/UNICODE → `varchar(N)`; PYTHON/PY_DICT/PY_TUPLE/PY_LIST/BLOB → `blob` (no NOT NULL/DEFAULT); VECTOR2/3/4 each component `float not null DEFAULT 0` | `entity_table_mysql.cpp:505-763` (`createItem`) |
| Width default | A numeric column without `<DatabaseLength>` is `int not null DEFAULT 0`, not `int(11)` — the engine strips the whole `(@DATALEN@)` segment for an empty length | `entity_table_mysql.cpp:1643-1659` |
| varchar default | Length 255 when `<DatabaseLength>` is absent | `entity_table_mysql.cpp:1829-1833`, `:1899-1903` |
| Persistence | Only properties whose `<Persistent>` is exactly lowercase `true` become columns; a missing node = false | `entitydef.cpp:1178-1188` |
| Indexes | `<Index>` creates an index, uppercased; STRING/UNICODE/PYTHON/BLOB indexes require `<DatabaseLength>`; `<Identifier>true` only enters the def md5, no index created | `entity_table_mysql.cpp:292-334`, `:317-332`; `entitydef.cpp:1221-1239` |
| Row data | Root table 1 row, component child table 1 row, ARRAY child tables default 2 rows (`rowsPerChildTable`), parentID takes the parent table's first row id, row ids increase globally | simulator convention, registered in source comments |
| INSERT statements | `insert into tbl_X (cols) values(...);`, without the `id` column (engine INSERT is the same shape; the new id comes from `mysql_insert_id`) | `sqlstatement.h:69-122`, `:128-145` |
| sm_autoLoad | The exported INSERT folds `sm_autoLoad` in for single-statement rebuilds; the engine actually does a separate UPDATE via `entityShouldAutoLoad` | `entity_table_mysql.cpp:766-775`; `baseapp/entity.cpp:1144-1151` |

## Differences from the Real Engine (11 items, also listed at the end of exported documents)

1. The redis backend is not simulated: the engine also has `kbe/src/lib/db_redis`; snapshot and simulation follow the mysql path only (audit block 19 leftover ①).
2. Column order follows the snapshot document order; the engine's CREATE contains only id/parentID, remaining columns are appended via per-column ALTERs, so physical column order depends on ALTER timing (`entity_table_mysql.cpp:390-395`, `:51-57`).
3. No foreign keys: the engine DDL has no FOREIGN KEY/REFERENCES; child tables relate only logically via parentID, and the exported DDL matches.
4. The engine does no pre-write check for UNIQUE conflicts; a failing MySQL index makes writeTable return 0 (`dbmgr.cpp:1044-1066`; the 1062 branches at `kbe_table_mysql.cpp:187`/`:352` are commented out); the simulator instead pre-checks and reports `unique` — this is something the simulator does beyond the engine.
5. AUTO_INCREMENT start is 1 in the simulation; the engine reads dbInterface `<autoIncrementInit>` (`serverconfig.cpp:1043-1045` → `db_interface_mysql.cpp:775-787`).
6. ARRAY child table row order = ascending child row id; the engine UPDATE overwrites position by position in ascending order and deletes surplus rows (`write_entity_helper.h:92-230`); the simulation addresses insert/update/delete by id and does not implement positional overwrite.
7. The engine INSERT has no id (AUTO_INCREMENT) and sm_autoLoad is updated separately by entityShouldAutoLoad (`entity_table_mysql.cpp:766-775`); the exported INSERT folds in sm_autoLoad so a whole row can be rebuilt with one statement.
8. varchar length takes the DatabaseLength default 255 (`entity_table_mysql.cpp:1829-1833`); the engine's online comparison additionally converts via MBMAXLEN (=3) (`db_interface_mysql.h:16-18`), which the simulation does not.
9. Numeric column DEFAULTs are interpolated verbatim from the def `<Default>` by the engine; a non-numeric default makes MySQL fail at column creation; the simulation parses numerically and falls to 0 when parsing fails.
10. Engine child table rows always have a parent id (parentID NOT NULL); the simulation allows parentID=0 meaning no parent row, occurring only in nested scenarios where the parent table has no simulated row.
11. bigint boundary values go through JS number rounding; for |value| > 2^53 the type check judges the rounded value (the engine uses exact uint64).

## Row Validation Semantics

`applyRowOperation` follows strict engine semantics: if any check fails the whole statement is rejected and storage keeps the pre-operation state (operates on a clone, does not mutate inputs). Checks:

- table/row does not exist (`unknown-table` / `unknown-row`);
- INSERT values carry the `id` column (engine INSERT has no id) or write `parentID` directly (`orphan-parent`);
- integer columns checked against mysql ranges (tinyint -128..127 up to bigint ±2^63, unsigned up to 2^64-1, exact BigInt comparison);
- float columns require finite values; over-length varchar errors; blob accepts strings only;
- UNIQUE column conflicts (update excludes the row itself) — see difference item 4; the engine has no such pre-check;
- DELETE recursively cascades child table rows (the closure of ids to delete, equivalent to `remove_entity_helper.h:38-46` deleting children before parents).

## Entry Points and Export

- `Simulate Entity Database` (`kbengine.database.simulate`): with no entity name passed, inferred from the currently active `.def` file; opens a `.dbsim` virtual document (generated in memory, not written to disk).
- `Export Entity Database Simulation` (`kbengine.database.exportSimulation`): run inside a `.dbsim` document, saves as Markdown; exported content = DDL + row JSON + INSERT statements + the difference list.

The schema snapshot itself is produced by the same source as `Open Database Schema` (`kbengine.database.open`); see that virtual document's header for more details on table structure and column names.
