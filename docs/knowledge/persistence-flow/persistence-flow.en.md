# Engine Mechanism 03 · Persistence Flow (dbmgr persistence / write-back timing)

> KB-001 Knowledge Base, second batch · Engine Mechanism Doc · English edition (Chinese edition: [`persistence-flow.zh.md`](./persistence-flow.zh.md))
>
> **Evidence rule**: every engine-behaviour conclusion here carries a `kbe/src` source citation (`file:line`). The primary source is the existing source-level analysis artifacts inside the kode repo (see "Evidence Sources" at the end); anything the in-repo analysis does not cover is marked `TODO 待验证` (to be verified) pending a check against the engine source — **rather omit than fabricate**.

---

## 0. Reading Map

| You want to know | Jump to |
|---|---|
| Script-side persistence entry points | §1 |
| Write-back timing: who triggers a DB write and when | §2 |
| Pre-write hooks (onWriteToDB / onPreArchive) | §3 |
| cellData snapshot semantics | §4 |
| Auto-archive / auto-backup (shouldAutoArchive / shouldAutoBackup) | §5 |
| Restore / auto-load (writeToDB shouldAutoLoad / onAutoLoadEntityCreate) | §6 |
| Verification-pending list | §7 |

## 1. Script-side persistence entry points

| API | Signature | Source |
|---|---|---|
| `self.writeToDB(callback=None, shouldAutoLoad=False, dbInterfaceName="default")` | baseapp 0-3 args `"O\|i\|O"`; cellapp 0-2 args | `lib/entitydef/entity_macro.h:19`; arg parse `entity_macro.h:832-940` |
| `self.destroy(deleteFromDB=False, writeToDB=False)` | with `writeToDB=True`, writes latest state then destroys | `entity_macro.h:20` (METH_KEYWORDS); kwargs list `server/baseapp/entity.cpp:626-632, :657-658` |
| `KBEngine.deleteEntityByDBID(entityType, dbID, callback, dbInterfaceName="default")` | delete by DBID (not via entity instance) | `server/baseapp/baseapp.cpp:448`; impl `:5150-5162` (3-4 args) |
| `KBEngine.lookUpEntityByDBID` | query DB | `server/baseapp/baseapp.cpp:449` |
| `KBEngine.executeRawDatabaseCommand(command, callback=None, threadID=0, dbInterfaceName="default")` | execute raw SQL directly (four registration points: baseapp/cellapp/dbmgr/interfaces) | `baseapp.cpp:438` impl `:3175-3189`; cellapp.cpp:174; dbmgr.cpp:355; interfaces.cpp:189 |

Entity-restore entry points (baseapp module surface): `createEntityFromDBID` / `createEntityAnywhereFromDBID` / `createEntityRemotelyFromDBID` (`server/baseapp/baseapp.cpp:435-437`).

## 2. Write-back timing: who triggers a DB write and when

The DB write action is ultimately executed by the **dbmgr process** (`server/dbmgr/dbmgr.cpp`; dbmgr is `Dbmgr : public PythonApp`, `dbmgr.h:32`, public surface from `python_app.cpp:271-334`). baseapp/cellapp only collect entity state and send a write-to-DB message; the actual DB write is done by dbmgr's database interface (MySQL by default).

**Timing** triggers:

1. **Explicit `writeToDB()`** — script-driven persistence (`entity_macro.h:19`). `callback` fires after the write completes (signature `(rows, insertID, affectedRows, error)`, see the two aliases in `_KBEngine_dbmgr.pyi`, corresponding to `dbmgr.cpp:355`).
2. **`destroy(writeToDB=True)`** — write latest state before destroy (`entity_macro.h:20`, `server/baseapp/entity.cpp:626-632, 657-658`).
3. **Auto-archive / auto-backup** — gated by `shouldAutoArchive` / `shouldAutoBackup` (see §5); periodic archiving is an internal engine schedule, **the schedule period and trigger points are not covered by the in-repo analysis, TODO 待验证**.
4. **Shutdown flow** — a final write for all live, persistable entities during server shutdown (`onReadyForShutDown`-related path; baseapp-side module-level hook call point `baseapp.cpp:275`). The full ordering/batching semantics of shutdown writes **TODO 待验证**.

**Write granularity**: what is written is the entity's **whole persistable property set** (def-declared DB-persisted properties), not a single-property delta. Single-property write-back merging (batching multiple write requests) **TODO 待验证**.

## 3. Pre-write hooks: onWriteToDB / onPreArchive

| hook | Firing time | Source |
|---|---|---|
| `onWriteToDB(cellData)` (base side) | pre-write callback, carries the cell-data snapshot argument | base-side signature `_KBEngine_hooks.pyi:91`; cell-side ref `server/cellapp/entity.cpp:1259` |
| `onWriteToDB()` (cell side) | pre-write callback, no argument | `server/cellapp/entity.cpp:1259` |
| `onPreArchive()` (base side) | before archive | `server/baseapp/entity.cpp:1292` |

**base side takes `cellData`, cell side takes none** — the signature difference is itself evidence: the base side's `cellData` is **a data snapshot carried over from the cell side**, not a property of the base entity itself (first-batch conclusion, see [Memory References §5](../memory-references/memory-references.en.md#5-pitfall-class-5-celldata-snapshot-vs-live-object)).

## 4. cellData snapshot semantics

- `cellData` is **a data snapshot constructed by the engine at write time**, not the cell entity object.
- `cellData` is in the system-reserved property list `ENTITY_LIMITED_PROPERTYS` (`lib/entitydef/common.h:124-157`, includes `cellData`), a system property forbidden to redefine in def; position/direction go through alias injection (`common.h:118-121`).
- **Correct practice**: in `onWriteToDB(cellData)` treat it as a **read-only data source**; to change persisted values, change the cell entity property (it takes effect on the next sync/write). Do not hold it long-term as a live entity.
- The snapshot's construction timing / copy depth, and whether `onWriteToDB` modifications to cellData are read back — **TODO 待验证** (already listed in the first batch; folded into §7 here).

## 5. Auto-archive / auto-backup

| Property | R/W | Semantics | Source |
|---|---|---|---|
| `shouldAutoArchive` | GET+SET | Whether the entity participates in **periodic archiving** (persistence) | `server/baseapp/entity.cpp:41` (getset) |
| `shouldAutoBackup` | GET+SET | Whether the entity participates in **periodic backup** | `server/baseapp/entity.cpp:40` (getset) |

- Both are getset properties on the base-side (baseapp) entity (`server/baseapp/entity.cpp:40-41`); defaults are set by the engine (**default value source lines not separately evidenced, TODO 待验证**).
- **Archive vs backup difference**: archive writes to the **database** (dbmgr persistence); backup writes to an **in-memory/disk backup** (for crash recovery, not to DB). Their trigger periods and scheduler implementation **TODO 待验证**.
- The system-reserved property list includes `shouldAutoArchive` / `shouldAutoBackup` (`lib/entitydef/common.h:124-157`), forbidden to redefine in def.

## 6. Restore and auto-load

- `writeToDB(..., shouldAutoLoad=True)`: mark the entity to be **auto-loaded** at server startup (`entity_macro.h:19` arg parse `:832-940`).
- Server-startup auto-load fires the callback: `onAutoLoadEntityCreate(entityType, dbid)` (baseapp module-level hook, call point `server/baseapp/entity_autoloader.cpp:83`).
- Restore entry trio: `createEntityFromDBID` / `createEntityAnywhereFromDBID` / `createEntityRemotelyFromDBID` (`server/baseapp/baseapp.cpp:435-437`).
- **The auto-load selection strategy** (which entities get loaded at startup, in what order/condition) **TODO 待验证** — the `entity_autoloader.cpp` filter logic is not expanded in the in-repo analysis.

## 7. Verification-pending list (待验证清单)

| # | Point to verify | Section | Source evidence needed |
|---|---|---|---|
| 1 | Periodic-archive schedule period and trigger points | §2 / §5 | baseapp archive scheduler |
| 2 | Full ordering and batching semantics of shutdown writes | §2 | shutdown path (baseapp shutdown × entity write) |
| 3 | Single-property write-back merging (batching multiple write requests) | §2 | write-to-DB message queue/buffer |
| 4 | Defaults for shouldAutoArchive / shouldAutoBackup | §5 | baseapp/entity.cpp constructor init |
| 5 | Underlying channel difference between archive (DB) and backup (non-DB) | §5 | baseapp backup path vs dbmgr write path |
| 6 | cellData snapshot construction timing / copy depth / read-back after modification | §4 | baseapp/entity.cpp write path + cellData packing logic |
| 7 | Auto-load entity selection strategy and order | §6 | entity_autoloader.cpp filter logic |
| 8 | Whether the two onWriteToDB call points fire on the same frame | §3 | baseapp write path (base-side onWriteToDB call line) |

## 8. Evidence Sources

In-repo artifacts directly checkable (the line numbers cited in this doc come from source forensics in these documents):

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` — writeToDB arg parse (entity_macro.h:832-940), destroy kwargs, deleteEntityByDBID, executeRawDatabaseCommand registration points, onWriteToDB / onPreArchive / onAutoLoadEntityCreate call points
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi` — onWriteToDB two-side signature difference (base takes cellData / cell takes none), onPreArchive, onAutoLoadEntityCreate
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_dbmgr.pyi` — dbmgr module surface and callback aliases (`dbmgr.cpp:355`)
- `docs/review/2026-10-21-entity-builtin-properties.md` — shouldAutoArchive / shouldAutoBackup / cellData system-reserved property list (common.h:124-157)
- `docs/knowledge/memory-references/` — cellData snapshot vs live-object pitfall (first batch §5)
- `todo.md` KB-001 entry — persistence flow is one of the designated mechanism-doc topics

The engine source tree itself (`kbe/src/...`) is not in the kode repo; the in-repo documents above were produced against the user's local KBEngine checkout (`~/workspaces/kbengine`). Behaviours not covered by the in-repo docs are marked TODO 待验证 throughout.
