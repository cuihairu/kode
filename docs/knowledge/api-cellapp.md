# Cellapp API reference — the `KBEngine` module face (KB-API-004)

> Same claims, same citations; this EN page is canonical for line-number drift checks.
>
> **Scope**: the `KBEngine` module face registered by the **cellapp**
> process, plus the face-assembly layer map that answers "is this API
> really available on cellapp?" for both faces. The shared `Entity` class
> on cellapp (timers, controllers, view/AOI, broadcast, lifecycle,
> attributes, callbacks) has its own page:
> [api-cellapp-entity](api-cellapp-entity.md). Rewritten from the official
> 3.7-era CHM-derived source material
> (`kbengine/docs/api/kbengine/cellapp/Entity.md`, 50 `def` sections;
> `KBEngine.md`, 42 `def` sections; `index.md`) — the material's wording is
> not trusted verbatim (chm-conversion glue like `ThisKBEngine`, table
> corruption); every behavioral claim below is re-grounded in the fork
> source.
>
> **Grounding**: fork `kbe/src` at HEAD `6d12b8f` (grounding base `c2a3b8f`).
> Version baseline and deviation-annotation format follow
> [Python version baseline](python-version-baseline.md). Companion pages:
> [Entity lifecycle & reference release](entity-lifecycle-reference.md) (destroy
> guards, timer/release flow), [Fixed directories](fixed-directories-and-path-resolution.md)
> (`KBE_RES_PATH`-bounded resource functions).
>
> **Coverage**: the KBEngine-module portion of the 121 documented surface
> items — 33 functions + 9 callbacks + 12 attributes (the Entity portion —
> 29 member functions + 21 callbacks + 17 documented attributes — lives on
> the [Entity face page](api-cellapp-entity.md)).

## 1. How the cellapp Python face is assembled

The cellapp script surface is not one registration site; it is four layers.
Reading order for any "is this API really available on cellapp?" question:

| Layer | What it registers | Evidence |
| --- | --- | --- |
| Cell-specific `Entity` methods | `setViewRadius`, `getViewRadius`, `getViewHystArea`, `isReal`, `addProximity`, `addYawRotator`, `clientEntity`, `cancelController`, `canNavigate`, `navigatePathPoints`, `navigate`, `getRandomPoints`, `moveToPoint`, `moveToEntity`, `accelerate`, `entitiesInRange`, `entitiesInView`, `teleport`, `destroySpace`, `debugView`, `getWitnesses` | `kbe/src/server/cellapp/entity.cpp:46-68` (`ENTITY_METHOD_DECLARE_BEGIN(Cellapp, Entity)`) |
| Shared entity methods (baseapp+cellapp) | `addTimer`, `delTimer`, `writeToDB`, `destroy`, `registerEvent`, `deregisterEvent`, `fireEvent`, `getComponent`; getsets `id`, `isDestroyed`, `className` | `kbe/src/lib/entitydef/entity_macro.h:12-40` (macro block spliced into the same table) |
| Cellapp `KBEngine` module functions | `time`, `createEntity`, `executeRawDatabaseCommand`, `reloadScript`, `registerReadFileDescriptor`/`Write` (+`deregister…`), `addSpaceGeometryMapping`, `getSpaceGeometryMapping`, `setSpaceData`, `getSpaceData`, `delSpaceData`, `isShuttingDown`, `address`, `raycast`, `setAppFlags`, `getAppFlags` | `kbe/src/server/cellapp/cellapp.cpp:172-189`; plus `cellAppData` object at `cellapp.cpp:199` |
| Shared server-app module face | `kbassert`(private), `publish`, `scriptLogType`, `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath`, `getWatcher`, `getWatcherDir`, `debugTracing`, `globalData` object | `kbe/src/lib/server/entity_app.h:423-453`, `:418-419` (`globalData` registration) |
| Interpreter-layer (all apps) | `MemoryStream` (`python_app.cpp:271`), `NEXT_ONLY` constant (`:323`), module-level `addTimer`/`delTimer` (`:329-330`), `component` string (`lib/pyscript/script.cpp:248`), `genUUID64` (`:258`), `addWatcher`/`delWatcher` (`lib/pyscript/pywatcher.cpp:184-185`), `urlopen` (`lib/pyscript/pyurl.cpp:23`) | as cited |

The `Entity` class **attribute** face on cellapp: `base`, `client`,
`allClients`, `otherClients`, `isWitnessed`, `hasWitness`, `isOnGround`,
`spaceID` (read-only); `layer`, `position`, `direction`, `topSpeed`,
`topSpeedY`, `controlledBy`, `volatileInfo` (get+set) —
`server/cellapp/entity.cpp:71-88`. Full per-attribute semantics on the
[Entity face page](api-cellapp-entity.md).

Entity **components** get their own smaller face on cellapp: `addTimer`,
`delTimer`, `clientEntity` plus `ownerID`/`owner`/`name`/`className`/
`isDestroyed`/`base`/`client`/`allClients`/`otherClients` getsets —
`server/cellapp/entity_component.cpp:10-27`. The task-verified anchor
`addTimer = cellapp/entity_component.cpp:12` is this component face; the
main-entity `addTimer` comes from the shared macro (timers on the
[Entity face page](api-cellapp-entity.md)).

## 2. KBEngine module functions (cellapp face)

All 33 functions from the source material, with the registration layer that
actually provides them. "Layer" values: **cell** = `cellapp.cpp:172-189`,
**shared** = `entity_app.h:423-453` / `python_app.cpp`, **interp** =
`lib/pyscript` (common install path, `script.cpp:197-289`).

| Function | Layer | Verified semantics |
| --- | --- | --- |
| `time()` | cell `cellapp.cpp:172` | Game tick count; tick length from `gameUpdateHertz` config |
| `createEntity(entityType, spaceID, position, direction, params)` | cell `cellapp.cpp:173`, impl `:471-533` | Creates a **cell-local** entity in a space that already exists on this cellapp. Failure raises `TypeError`: empty `entityType` (`:488`), `spaceID` not found on this cellapp (`:496`), app shutting down (`:503`); arg-shape errors (`:480`). Returns the entity object; a note in the impl (`:521-527`) documents that an entity destroyed during `addEntityAndEnterWorld` is still returned with `isDestroyed = true` |
| `executeRawDatabaseCommand(command, callback, threadID, dbInterfaceName)` | cell `cellapp.cpp:174`, impl `:536+` | Raw DB command via dbmgr; callback signature `(result, rows, insertid, error)`; same overwriting caveat as the baseapp face |
| `reloadScript(fullReload)` | cell `cellapp.cpp:175` | Reload entity scripts; completion triggers `KBEngine.onInit(True)`; development-mode only |
| `registerReadFileDescriptor` / `registerWriteFileDescriptor` / `deregisterReadFileDescriptor` / `deregisterWriteFileDescriptor` | cell `cellapp.cpp:176-179` | FD callbacks; shared impl `lib/server/py_file_descriptor.cpp` |
| `addSpaceGeometryMapping(spaceID, mapper, path, shouldLoadOnServer, params)` | cell `cellapp.cpp:180` → `SpaceMemory::__py_AddSpaceGeometryMapping` | Binds navmesh/geometry to a space; `params` maps layers→navmesh files; completion callbacks §3 |
| `getSpaceGeometryMapping(spaceID)` | cell `cellapp.cpp:181` | Current mapping name of a space |
| `setSpaceData` / `getSpaceData` / `delSpaceData` | cell `cellapp.cpp:182-184` | Space key/value strings; change broadcast → callback `onSpaceData` (§3) |
| `isShuttingDown()` | cell `cellapp.cpp:185` | Shutdown state; also checked inside `createEntity` (`cellapp.cpp:505-508`) |
| `address()` | cell `cellapp.cpp:186` | Internal network interface address |
| `raycast(spaceID, layer, src, dst)` | cell `cellapp.cpp:187`, impl `cellapp.cpp:2158` | Geometry ray cast; requires the space to have geometry loaded via `addSpaceGeometryMapping` |
| `setAppFlags` / `getAppFlags` | cell `cellapp.cpp:188-189` | e.g. opt out of load balancing |
| `publish()` | shared `entity_app.h:426` | 0 debug / 1 release |
| `scriptLogType(logType)` | shared `entity_app.h:429` | Sets what `print` maps to (`LOG_TYPE_*`) |
| `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath` | shared `entity_app.h:432-444` | Resource access bounded to `KBE_RES_PATH` — see [fixed directories](fixed-directories-and-path-resolution.md) |
| `getWatcher`, `getWatcherDir` | shared `entity_app.h:447-450` | Watcher tree read |
| `debugTracing()` | shared `entity_app.h:453` | PyGC extension-object leak counters |
| `genUUID64()` | interp `script.cpp:258`, impl `:91-106` | 64-bit UUID; **emits a warning** when the process's global order is outside 0~65535 (`script.cpp:99`) because cross-process uniqueness then degrades to per-process |
| `addWatcher(path, dataType, getFunction)` / `delWatcher(path)` | interp `pywatcher.cpp:184-185` | Register/remove a watched variable |
| `urlopen(url, callback, postData, headers)` | interp `pyurl.cpp:23`, impl `:69+` | Async HTTP(S); raises `AssertionError` on bad headers/postData/callback (`pyurl.cpp:98`, `:116`, `:162`, `:174`) |
| `MemoryStream()` | interp `python_app.cpp:271` | KBEngine-serialization byte buffer |
| `createSpace` | — | **Absent**: the cellapp source material does not document it, and the fork registers no cellapp-side `createSpace` (grep over `server/cellapp/` + `lib/server/` = 0 hits). Space creation happens via the baseapp→cellappmgr path (`Cellapp::onCreateCellEntityInNewSpaceFromBaseapp` handles the resulting entity creation, `cellapp.cpp:875`) |

Source-material functions accounted for elsewhere: the material's intro
mentions `KBEngine.createCellEntity` — that is the **baseapp** face
(KB-API-003 scope), not registered on cellapp.

## 3. KBEngine module callbacks (cellapp face)

| Callback | Trigger (verified call site) |
| --- | --- |
| `onInit(isReload)` | Entry script, after all scripts loaded (`initprogress_handler.cpp:132-143`; the initial call passes `0`; `reloadScript` triggers the reload call) |
| `onReadyForLogin(isBootstrap)` | Cellapp init-progress poller (`initprogress_handler.cpp:153-160`). Return contract, fork-verified: return `True` → ready (`:163`, `:177`); otherwise a float, and progress counts as complete at `>= 0.9999` (`:194-196`); no callback defined → immediately complete (`:184-191`). Material's "≥ 1.0" is close but the fork threshold is 0.9999 (§5) |
| `onCellAppData(key, value)` | `Cellapp::onBroadcastCellAppDataChanged` after a successful remote write (`cellapp.cpp:864`) |
| `onCellAppDataDel(key)` | Same path after a successful remote delete (`cellapp.cpp:844`) |
| `onGlobalData(key, value)` | `EntityApp::onBroadcastGlobalDataChanged` (`lib/server/entity_app.h:1308`) — shared by baseapp+cellapp |
| `onGlobalDataDel(key)` | same file `entity_app.h:1290` |
| `onSpaceData(spaceID, key, value)` | `SpaceMemory::onSpaceDataChanged` — set and delete both dispatch here with the delete carrying an empty value (`spacememory.cpp:607-619`) |
| `onSpaceGeometryLoaded(spaceID, mapping)` | Per-space geometry done (`spacememory.cpp:308`) |
| `onAllSpaceGeometryLoaded(spaceID, isBootstrap, mapping)` | All cells' geometry for the space done (`spacememory.cpp:336`); `isBootstrap` distinguishes the originating cell |

Entry-script placement note from the material (onCellAppData/onGlobalData/
onInit/onReadyForLogin must live in the `entryScriptFile` module) matches the
implementation: every dispatch above calls
`getEntryScript()`/`getEntryScript().get()`, not an entity.

## 4. KBEngine module attributes (cellapp face)

| Attribute | Type | Registration / semantics |
| --- | --- | --- |
| `entities` | `Entities` | `entity_app.h:410-411` — all entities in this process **including ghosts**; `.garbages` leak inspection documented in [entity lifecycle](entity-lifecycle-reference.md) |
| `globalData` | `GlobalDataClient` | `entity_app.h:418-419` — dict-like, replicated to all baseapps+cellapps (server side is dbmgr-anchored; cellapp constructs a `GlobalDataClient(DBMGR_TYPE, …)`) |
| `cellAppData` | dict-like | `cellapp.cpp:199` (`pCellAppData_`) — replicated across cellapps |
| `component` | string | `script.cpp:248` — `'cellapp'` on this process |
| `LOG_TYPE_DBG/INFO/NORMAL/WAR/ERR` | int | log levels for `scriptLogType` |
| `NEXT_ONLY` | int | defined as `KBE_NEXT_ONLY` (`python_app.cpp:323`); no cellapp consumer — matches the material's "currently unused" note |

Both replicated dicts broadcast **only on explicit top-level set/delete**:
the remote-dispatch paths are `onBroadcastCellAppDataChanged`
(`cellapp.cpp:830-872`) and `onBroadcastGlobalDataChanged`
(`entity_app.h:1280-1314`); an in-place mutation of a stored list never
reaches those call sites, so it is never broadcast — the material's
`cellAppData["list"][1] = 7` warning is structurally true in this fork.

## 5. 3.7 source material vs fork 3.12 deviations (module face)

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `onReadyForLogin` ready threshold | "return value ≥ 1.0 → ready" | `True` → ready; otherwise float, complete at `>= 0.9999`; no callback → immediately complete | Fork | `kbe/src/server/cellapp/initprogress_handler.cpp:163-196` |
| `createSpace` on cellapp | Not documented in the cellapp material | Also absent in the fork: no cellapp-side registration (grep `server/cellapp/` + `lib/server/` = 0 hits); space creation flows baseapp→cellappmgr | Fork | grep 2026-11-04 at HEAD `6d12b8f`; `cellapp.cpp:875` |
| `NEXT_ONLY` | "currently unused in Cellapp" | Constant is still defined on the module, unused — same as material | Fork | `kbe/src/lib/server/python_app.cpp:323` |
| `genUUID64` uniqueness | Depends on the `gus` startup arg; >65535 degrades to per-process uniqueness | Same contract, plus an explicit runtime warning when global order ∉ 0~65535 | Fork | `kbe/src/lib/pyscript/script.cpp:91-106` |
| Python 2 code examples | `print "..."` syntax in material examples | 3.12 requires `print(...)`; snippets must be rewritten, not copied (applies to both faces) | Python | https://docs.python.org/3/whatsnew/3.0.html (print is a function) |

Entity-face deviations (`delTimer` stale id, `cancelController("Type")`,
"trackEntity"/"turnToYaw" entry points, `accelerate` parameter table,
`isOnGround`, `volatileInfo` type row) live on the
[Entity face page](api-cellapp-entity.md) deviations table.

## References

- Registration maps: `server/cellapp/cellapp.cpp:172-199`,
  `lib/server/entity_app.h:410-453`, `lib/server/python_app.cpp:271-334`,
  `lib/pyscript/script.cpp:248-258`, `lib/pyscript/pywatcher.cpp:184-185`,
  `lib/pyscript/pyurl.cpp:23`;
  Entity-face registration maps on the
  [Entity face page](api-cellapp-entity.md)
- Data replication: `cellapp.cpp:830-872`, `lib/server/entity_app.h:1280-1314`,
  `spacememory.cpp:308-619`, `initprogress_handler.cpp:134-196`
- Grounding performed at fork HEAD `6d12b8f` on 2026-11-04.
