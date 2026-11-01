# Engine Mechanism 01 · Entity Lifecycle (Create → Cell Migration → Destroy)

> KB-001 Knowledge Base, first batch · Engine Mechanism Doc · English edition (Chinese edition: [`entity-lifecycle.zh.md`](./entity-lifecycle.zh.md))
>
> **Evidence rule**: every engine-behaviour conclusion here carries a `kbe/src` source citation (`file:line`). The primary source is the existing source-level analysis artifacts inside the kode repo (see "Evidence Sources" at the end); anything the in-repo analysis does not cover is marked `TODO 待验证` (to be verified) pending a check against the engine source — **rather omit than fabricate**.

---

## 0. Reading Map

| You want to know | Jump to |
|---|---|
| How an entity gets created | §1 |
| Where the cell entity comes from / goes | §2 |
| Who decides hasBase/hasCell/hasClient | §3 |
| How an entity is destroyed, what survives script-side | §4 |
| All lifecycle hooks at a glance | §5 |
| Memory-reference pitfalls (cross entry) | §6 + [Memory References Pitfall Set](../memory-references/memory-references.en.md) |

A KBEngine entity has **two independent script lifetimes** server-side: the base side (living in a baseapp process) and the cell side (living inside a space of a cellapp process). Each lifetime has its own Python instance, its own `onDestroy`, its own timers. Most lifecycle pitfalls stem from **mistaking two lifetimes for one**.

## 1. Creation: where an entity comes from

### 1.1 Base-side creation entry points

Script-accessible creation APIs (baseapp module surface):

| API | Semantics | Source |
|---|---|---|
| `KBEngine.createEntity(entityType, params=None)` | Create base entity on this baseapp | `server/baseapp/baseapp.cpp:431`, impl `:951-971` (1-2 args) |
| `KBEngine.createEntityLocally(...)` | Same as createEntity (same impl) | `baseapp.cpp:432` |
| `KBEngine.createEntityAnywhere(entityType, params, callback)` | Let baseappmgr pick the least-loaded baseapp | `baseapp.cpp:433`, impl `:986-1025` (1-3 args; callback must be callable else NULL) |
| `KBEngine.createEntityRemotely(entityType, baseMB, params, callback)` | Create on the baseapp that owns the given base mailbox | `baseapp.cpp:434`, impl `:1028-1090` (2-4 args; arg 2 hard-checked `ENTITYCALL_TYPE_BASE`) |
| `KBEngine.createEntityFromDBID` / `createEntityAnywhereFromDBID` / `createEntityRemotelyFromDBID` | Restore from DB by DBID | `baseapp.cpp:435-437` |

The not-found error text comes from the registration triad: "Please register in entities.xml and implement a %s.def and %s.py" (`lib/server/entity_app.h:567`); at creation time `hasCell` (cellapp) / `hasBase` (other processes) is checked by process (`entity_app.h:573-582`).

**Key mechanism: def properties are injected by the engine before `__init__`.** When the entity class is instantiated, the engine lays out the def-declared properties at their defaults first, then the script `__init__` runs. This explains why `self.hp` is directly readable inside `__init__` — and also why engine-side assignment *before* `__init__` is invisible to Python (in-repo conclusion; design trade-off recorded in todo.md C-22; the per-line mechanism belongs to the "KBEngine Python binding layer source analysis" extension domain, marked **TODO 待验证**).

### 1.2 Cell-side creation entry points

The cell entity is not created directly by script — it is driven by the base side:

| API | Semantics | Source |
|---|---|---|
| `self.createCellEntity(cellEntityCall=None)` | Base entity requests its own cell | `server/baseapp/entity.cpp:27` (`DECLARE_PY_MOTHOD_ARG1`, `server/baseapp/entity.h:187`, 0-1 args) |
| `self.createCellEntityInNewSpace(cellappIndex=0)` | Same, but in a new space | `server/baseapp/entity.cpp:28` (`entity.h:198`) |
| `KBEngine.createEntity` (cellapp module surface) | Create cell entity directly in a given space | `server/cellapp/cellapp.cpp:173`, impl `:471-484` (`"s|I|O|O|O"`) |

### 1.3 Three-side existence determination (who decides an entity has base/cell/client)

The engine decides hasCell/hasBase/hasClient once at the tail of def loading in `autoMatchCompOwn` (`lib/entitydef/scriptdef_module.cpp:302-530`), rule per side: **"script present ‖ entities.xml assertion, assertion wins"**:

- Component-module branch (`scriptdef_module.cpp:304-331`): `scripts/base/components/<name>.py` exists → `setBase(true)`; `scripts/cell/components/<name>.py` exists → `setCell(true)`; base/cell has exposed methods → `setClient(true)`.
- Entity branch: reads the `hasClient` (`:366`) / `hasCell` (`:377`) / `hasBase` (`:388`) assertion attributes from entities.xml — case-insensitive `true` counts as 1, anything else as 0; assertion values feed the def md5 (`:375、386、397`).
- Per-side determination (client example `:416-450`; base `:459-493`; cell `:495-529`): script present + no assertion → true; script present + assertion → **assertion wins**; script missing + no assertion → false; script missing + assertion → assertion wins.
- Client processes (CLIENT_TYPE) set `setBase(true)+setCell(true)` up front and return (`:452-457`).

The full chain (path resolution, utype assignment, Interfaces/Components/Parent merge) is in the in-repo `docs/source-analysis.md` — not repeated here.

## 2. Cell Migration: the courier between two lifetimes

### 2.1 Cell creation and attachment

After the base side calls `createCellEntity`, the cellapp side creates the cell entity and calls back to the base side:

- `onGetCell()`: base entity obtained its cell (`server/baseapp/entity.cpp:1032`).
- `onCreateCellFailure()`: creation failed (`server/baseapp/entity.cpp:884`).

The base-side script now talks to the cell through `self.cell` (`server/baseapp/entity.cpp:36`, `pyGetCellEntityCall`, which returns an **EntityCall handle, not the entity object**).

### 2.2 Cell migration (wandering between cellapps)

A cell entity can migrate across cellapps (load balancing / space switch):

- `onRestore()`: cell entity restored on the new cellapp (cell side `server/cellapp/entity.cpp:3868`; base side also has onRestore, see VALIDATION_REPORT §11 BaseEntityHooks).
- teleport family: `onTeleport` (cellapp/entity.cpp:3783) / `onTeleportSuccess(nearbyEntity)` (`:3811`) / `onTeleportFailure` (teleport failure path bufferOrExeCallback, same block).

**Migration does not destroy the base-side lifetime**: only the cell entity moves; the base entity stays put, and the `self.cell` handle points to the entity on the new cellapp once migration completes. The reference-invalidity pitfall during migration is in [Memory Pitfalls §2](../memory-references/memory-references.en.md#2-reference-invalidity-after-cell-migration).

### 2.3 Cell loss

- `onLoseCell()`: base side perceives cell loss (`server/baseapp/entity.cpp:1065`).
- `self.destroyCellEntity()`: base side actively tears down the cell (`server/baseapp/entity.cpp:29`).
- `onSpaceGone()`: cell side perceives its space is gone (`server/cellapp/entity.cpp:384`).

## 3. Destruction: each lifetime ends on its own

### 3.1 Script-side API

`self.destroy(deleteFromDB=False, writeToDB=False)` (`lib/entitydef/entity_macro.h:20`, METH_KEYWORDS; kwargs list `server/baseapp/entity.cpp:626-632、657-658`).

- Base-side destroy cascades to destroy the cell entity (engine chain details **TODO 待验证**: in-repo analysis does not cover the full base destroy → cell destroy call chain).
- `deleteFromDB=True` deletes the DB record synchronously; `writeToDB=True` writes the latest state to DB before destroying.

### 3.2 Hook firing

- `onDestroy()`: fires on each side independently (cell side `server/cellapp/entity.cpp:209`; base-side call site **TODO 待验证** — VALIDATION_REPORT §11 records `onDestroy OK（cellapp/entity.cpp:209）` under BaseEntityHooks, but the base-side line number is not separately evidenced in-repo).
- `onWriteToDB`: callback before DB write (cell side `server/cellapp/entity.cpp:1259`; base side also exists, with a `cellData` argument — see §5).

### 3.3 What survives script-side after destroy

- The `isDestroyed` property (`lib/entitydef/entity_macro.h:34`) becomes true after destroy.
- **The Python object itself may not die**: destroy is an engine-semantic destruction (entity removed from the entities dict, no longer participates in logic), but any code still holding a reference to the Python object (another entity's property, a global list, a timer callback closure) keeps it alive per CPython refcounting — this is pitfall #1 of the memory set, see [Memory Pitfalls §3](../memory-references/memory-references.en.md#3-holding-a-reference-after-destroy).

## 4. Full Lifecycle Hook Table

### 4.1 BaseEntityHooks (base side, 8)

| hook | Fires when | Source |
|---|---|---|
| `onCreateCellFailure()` | createCellEntity failed | `server/baseapp/entity.cpp:884` |
| `onDestroy()` | base entity destroyed | cell-side same-name `cellapp/entity.cpp:209`; base-side line **TODO 待验证** |
| `onGetCell()` | got cell | `server/baseapp/entity.cpp:1032` |
| `onLoseCell()` | cell lost | `server/baseapp/entity.cpp:1065` |
| `onPreArchive()` | before archive | `server/baseapp/entity.cpp:1292` |
| `onRestore()` | base-side restore | VALIDATION_REPORT §11 (line in that report) |
| `onTimer(timerHandle, userData)` | timer due | `server/baseapp/entity.cpp:1656`; arg shape `(timerID, intptr(pUser))` per `entity_macro.h:1363` |
| `onWriteToDB(cellData)` | before DB write (with cell data snapshot arg) | cell-side ref `cellapp/entity.cpp:1259`; `cellData` arg semantics in Memory Pitfalls §5 |

### 4.2 CellEntityHooks (cell side, 18)

| hook | Fires when | Source |
|---|---|---|
| `onDestroy()` | cell entity destroyed | `server/cellapp/entity.cpp:209` |
| `onEnteredView(entity)` | entity entered view | `server/cellapp/entity.cpp:1783` |
| `onGetWitness()` | gained witness | `server/cellapp/entity.cpp:2177` |
| `onLoseWitness()` | lost witness | `server/cellapp/entity.cpp:2215` |
| `onMove(controllerID, userData)` | move | `server/cellapp/entity.cpp:2943` |
| `onMoveOver(controllerID, userData)` | move over | `server/cellapp/entity.cpp:2961` |
| `onMoveFailure(controllerID, userData)` | move failed | `server/cellapp/entity.cpp:2979` |
| `onRestore()` | restored after migration | `server/cellapp/entity.cpp:3868` |
| `onSpaceGone()` | space gone | `server/cellapp/entity.cpp:384` |
| `onTurn(controllerID, userData)` | turn | `server/cellapp/entity.cpp:3095` |
| `onTeleport()` | teleport begins | `server/cellapp/entity.cpp:3783` |
| `onTeleportFailure()` | teleport failed | teleport failure path bufferOrExeCallback, same block |
| `onTeleportSuccess(nearbyEntity)` | teleport succeeded | `server/cellapp/entity.cpp:3511` (VALIDATION_REPORT records `:3811`) |
| `onTimer(timerHandle, userData)` | timer due | `server/cellapp/entity.cpp:4322` |
| `onUpdateBegin()` | sync frame begins (witness path) | `server/cellapp/witness.cpp:749` |
| `onUpdateEnd()` | sync frame ends | `witness.cpp` onUpdateEnd symmetric call site |
| `onWitnessed(isWitnessed)` | witnessed state changed | `server/cellapp/entity.cpp:1483` |
| `onWriteToDB()` | before DB write (no cellData arg on cell side) | `server/cellapp/entity.cpp:1259` |

### 4.3 ProxyHooks (account entity, 6)

| hook | Fires when | Source |
|---|---|---|
| `onClientDeath()` | client disconnected | `server/baseapp/entity.cpp:1048` |
| `onClientGetCell()` | client got cell data | `server/baseapp/proxy.cpp:248` |
| `onClientEnabled()` | client enabled | `server/baseapp/proxy.cpp:178` |
| `onGiveClientToFailure()` | giveClientTo failed | `server/baseapp/proxy.cpp:307` |
| `onLogOnAttempt(ip, port, password) -> int` | remote login attempt | `server/baseapp/proxy.cpp:189` (`"sks"`) |
| `onStreamComplete(id, success)` | file stream done | `server/baseapp/proxy.cpp:832` |

## 5. Lifecycle × Memory References Boundary

This doc deliberately does not expand memory semantics — only gives the entry points:

1. **Lifecycle reference rules** (what reference pins a destroyed entity in memory) → Memory Pitfalls §1
2. **Reference invalidity after cell/base migration** (EntityCall handle lifetime) → Memory Pitfalls §2
3. **Holding a reference after destroy** (how refcounting lets a "dead" entity keep being called) → Memory Pitfalls §3
4. **timer/Functor holding references** (addTimer handle vs callback object lifetime mismatch) → Memory Pitfalls §4
5. **cellData snapshot vs live object** (onWriteToDB's cellData is a snapshot, not a live entity) → Memory Pitfalls §5

## 6. Evidence Sources

In-repo analysis artifacts directly checkable (line numbers cited here all come from these docs' source verification):

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` — typings vs kbe/src line-by-line verification report (390+ API entries, incl. lifecycle hook call sites)
- `docs/reference/kbengine-typings-2026-10-21/API_MATRIX.md` — API attribution matrix
- `docs/review/2026-10-21-entity-builtin-properties.md` — Entity builtin properties (cell/base/isDestroyed/cellData etc.) per-component verification
- `docs/source-analysis.md` — entitydef load chain, three-side existence determination (autoMatchCompOwn), Interfaces/Components/Parent semantics
- `todo.md` KB-001 / C-22 / C-23 entries — knowledge base structure and subsequent lint/hover tooling plan

The engine source tree itself (`kbe/src/...`) is not inside the kode repo; the in-repo docs above were produced against the user's local KBEngine checkout (`~/workspaces/kbengine`). Behaviors not covered by in-repo docs are marked TODO 待验证 here.
