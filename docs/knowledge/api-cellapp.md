# Cellapp API reference (KB-API-004)

> Same claims, same citations; this EN page is canonical for line-number drift checks.
>
> **Scope**: the Python API surface registered by the **cellapp** process —
> the `KBEngine` module face and the shared `Entity` class as it exists on
> cellapp. Rewritten from the official 3.7-era CHM-derived source material
> (`kbengine/docs/api/kbengine/cellapp/Entity.md`, 50 `def` sections;
> `KBEngine.md`, 42 `def` sections; `index.md`) — the material's wording is
> not trusted verbatim (chm-conversion glue like `ThisKBEngine`, table
> corruption); every behavioral claim below is re-grounded in the fork
> source.
>
> **Grounding**: fork `kbe/src` at HEAD `6d12b8f` (grounding base `c2a3b8f`).
> Version baseline and deviation-annotation format follow
> [Python version baseline](python-version-baseline.md) (§7 template used in
> §9). Companion pages:
> [Entity lifecycle & reference release](entity-lifecycle-reference.md) (destroy
> guards, timer/release flow), [Fixed directories](fixed-directories-and-path-resolution.md)
> (`KBE_RES_PATH`-bounded resource functions).
>
> **Coverage**: all 121 documented surface items are covered — Entity 29
> member functions + 21 callbacks + 17 documented attributes (16 table rows;
> `isOnGround` is documented in the material's attribute prose but missing
> from its own summary table — see §9), KBEngine module 33 functions +
> 9 callbacks + 12 attributes.

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
`server/cellapp/entity.cpp:71-88`.

Entity **components** get their own smaller face on cellapp: `addTimer`,
`delTimer`, `clientEntity` plus `ownerID`/`owner`/`name`/`className`/
`isDestroyed`/`base`/`client`/`allClients`/`otherClients` getsets —
`server/cellapp/entity_component.cpp:10-27`. The task-verified anchor
`addTimer = cellapp/entity_component.cpp:12` is this component face; the
main-entity `addTimer` comes from the shared macro (§6.1).

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
| `onReadyForLogin(isBootstrap)` | Cellapp init-progress poller (`initprogress_handler.cpp:153-160`). Return contract, fork-verified: return `True` → ready (`:163`, `:177`); otherwise a float, and progress counts as complete at `>= 0.9999` (`:194-196`); no callback defined → immediately complete (`:184-191`). Material's "≥ 1.0" is close but the fork threshold is 0.9999 (§12) |
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

## 5. Entity timers (`addTimer`/`delTimer`/`onTimer`)

- Registration: shared macro `entity_macro.h:16-17` (main Entity) and
  `server/cellapp/entity_component.cpp:12-13` (component face).
- `Entity::pyAddTimer(interval, repeat, userArg)`:
  `entity_macro.h:1387-1405` — wraps a `TimerHandle` in an
  `EntityScriptTimerHandler`; `ScriptTimersUtil::addTimer` returns id 0 on
  failure → **`ValueError("Unable to add timer")`** (`entity_macro.h:1396-1400`).
- Dispatch: `handleTimeout` converts the handle back to the script timer id
  and calls `onTimer(id, userArg)` (`entity_macro.h:1372-1375`).
- Single-shot timers auto-release in `onRelease` (`entity_macro.h:1381-1386`);
  repeating timers must be `delTimer`'d.
- `delTimer(id | "All")`: `"All"` cancels everything
  (`entity_macro.h:1447-1451`); an invalid/non-int argument raises
  `TypeError`, but **an unknown id returns `-1` silently** — no Python
  exception (`entity_macro.h:1478-1482`). The material's "an error will be
  generated" for stale ids does **not** match this fork (§9).
- Callback name is fixed: `onTimer(timerHandle, userData)` defined on the
  entity script class.

## 6. Entity controller chain (movement / navigation / turn / proximity)

All five creator functions share one ownership model: the Entity holds at
most one **move controller** (`pMoveController_`) and one **turn controller**
(`pTurnController_`), visible in `cancelController`'s dispatch
(`entity.cpp:1746-1750`); controllers draw ids from `Controllers::freeID()`
(`server/cellapp/controllers.h:22`, `controllers.cpp:19`).

| Function | Impl (cellapp/entity.cpp) | Semantics verified in fork |
| --- | --- | --- |
| `moveToPoint(destination, velocity, distance, userData, faceMovement, moveVertically)` | `:2816` | Straight-line move via `MoveToPointHandler` (`moveto_point_handler.cpp`); real-entity only; returns controller id |
| `moveToEntity(destEntityID, velocity, distance, userData, faceMovement, moveVertically, offsetPos)` | via same move-controller path | Chases a target entity; `offsetPos` shifts the approach point |
| `navigate(destination, velocity, distance, maxMoveDistance, maxSearchDistance, faceMovement, layer, userData)` | `:2690` | Navmesh path move via `NavigateHandler` (`navigate_handler.cpp`); `layer` selects the navmesh layer |
| `navigatePathPoints(destination, maxSearchDistance, layer)` | `:2624` | Query-only: path points, no controller created |
| `getRandomPoints(centerPos, maxRadius, maxPoints, layer)` | `:2758` | Random reachable points (spawn/AI helpers) |
| `canNavigate()` | `:2548` | True only when the space's navigation data is loaded and usable |
| `addYawRotator(targetYaw, velocity, userArg)` | `:3064` | Turn controller via `RotatorHandler` (`rotator_handler.cpp`); completion → `onTurn` |
| `addProximity(rangeXZ, rangeY, userArg)` | `:1604` | Area trigger via `ProximityController` + trap triggers (`proximity_controller.cpp`, `trap_trigger.cpp`); returns controller id; `rangeY` only manages Y when `cellapp/coordinate_system/rangemgr_y` is enabled |
| `accelerate(type, acceleration)` | `:3020` | Scales speed of the active movement/turn controller |
| `cancelController(controllerID \| "Movement")` | `:1671` | Real-entity only (`:1676` AssertionError). Fork-verified contract: the **only** accepted string is exactly `"Movement"` → `stopMove()` (`:1706-1711`); any other string is a `TypeError`; integer ids cancel the matching move/turn controller (`:1746-1750`) |

Movement callbacks, all routed through `Entity::onMove/onMoveOver/
onMoveFailure` (`entity.cpp:2936`, `:2948`, `:2966`):
`onMove` fires per movement step, `onMoveOver` on reaching the target,
`onMoveFailure` on failure (e.g. unreachable path). A **cancelled** move does
not fire `onMoveOver` — the controllers tear down without the completion
callback. `userArg`/`userData` round-trips into each callback.

Note for readers coming from the material's class description: it names
`trackEntity` and `turnToYaw` as controller entry points; **neither name
exists** in the fork's Entity method table (`entity.cpp:46-68`) — the real
entry points are `moveToEntity` and `addYawRotator` (§12).

## 7. View / AOI (Witness) face

The view system is witness-based: an entity with a bound `Witness`
(`server/cellapp/witness.cpp`) tracks which observers receive its updates.

| Item | Impl | Semantics |
| --- | --- | --- |
| `setViewRadius(radius, hyst)` | `entity.cpp:2439` | Real-entity only (`:2441` AssertionError); forwards to the witness/view triggers; `hyst` is the leave-lag band so enter/leave don't flicker |
| `getViewRadius()` / `getViewHystArea()` | `entity.cpp:2462`, `:2518` | Read from the bound witness (`pWitness_->viewRadius()`); **0.0 when no witness is bound** (`:2465-2466`) |
| `debugView()` | `entity.cpp:3149` | Dumps view state (size/seen/pending/radius) to the cellapp log |
| `entitiesInView(pending)` | `entity.cpp:63` registration | `pending=false` → entities already synchronized to the client; `pending=true` → server-visible but not yet synchronized |
| `entitiesInRange(range, entityType, position)` | `entity.cpp:62` | Spherical range query; can find entities outside the view but never across cells |
| `getWitnesses()` | `entity.cpp:2468` | The set of entities observing this one (the broadcast audience, §8) |
| `onEnteredView(entity)` | `entity.cpp:1779-1783` | An entity entered this entity's view |
| `onGetWitness()` / `onLoseWitness()` | `entity.cpp:2177`, `:2215` | Witness bound/unbound; readable via `hasWitness` getset (`entity.cpp:79`) |
| `onWitnessed(isWitnessed)` | `entity.cpp:1483`, `:1528` | This entity entered/left *someone's* view — the canonical AI on/off switch |
| `onUpdateBegin()` / `onUpdateEnd()` | `witness.cpp:749-753`, `:895-899` | Bracket each witness update sweep (only called when the script defines them) |
| `onEnterTrap` / `onLeaveTrap` | `entity.cpp:1752-1765` | Proximity trigger crossings (`addProximity`); also `onLeaveTrapID` by id (`:1770`) |

## 8. Entity calls and the broadcast face

- `base` / `client` (`entity.cpp:74-75`): entityCall to the base-part / the
  bound client; `None` when absent.
- `clientEntity(destID)` (`entity_component.cpp:14` for components; main
  entity shares the cell method table `entity.cpp:53`): wraps a view entity's
  client-side method for calling **through this entity's own client**.
- **`allClients` / `otherClients`** (`entity.cpp:76-77`, getters `:581`,
  `:592`): attribute access returns a broadcast proxy
  (`AllClientsComponent::onScriptGetAttribute`, `all_clients.cpp:57-85`,
  which asserts the owner is a **real** entity, `:70-76`). A method call on
  the proxy runs `ClientsRemoteEntityMethod::callmethod`
  (`clients_remote_entity_method.cpp:55+`), and the fork semantics are:
  1. The audience is `pEntity->witnesses()` — the entities currently
     observing this entity (`:73`), i.e. the Witness-driven view set, **not**
     an arbitrary radius query.
  2. `allClients` additionally sends to the entity's **own client** first —
     the send happens only when `!otherClients_ && pWitness() &&
     clientEntityCall()` (`:113`).
  3. `otherClients` (`otherClients_=true`, `all_clients.cpp:171`) skips the
     own-client send entirely.
  4. Method args are serialized once into a `MemoryStream` and replayed to
     each audience channel (`:92-135`).
  So the material's Avatar example is exact: `avatar.allClients.attack(...)`
  reaches the avatar's own client plus every witnessing player's client;
  `otherClients` reaches only the witnesses.

## 9. Entity lifecycle, persistence, teleport, control

- `destroy(...)` (`entity_macro.h:19`, cellapp guards `entity.cpp:315-323`):
  rejects with `AssertionError` while the entity is initing or already
  destroyed; full destroy/garbage flow in
  [entity lifecycle](entity-lifecycle-reference.md). `onDestroy` is invoked
  only if the script defines it.
- `destroySpace()` (`entity.cpp:342`): destroys the space this entity
  occupies.
- `writeToDB(shouldAutoLoad, dbInterfaceName)` (`entity_macro.h:18`):
  archives the entity to dbmgr (base+cell data); `onWriteToDB` fires on the
  script side when implemented.
- `teleport(nearbyMBRef, position, direction)` (`entity.cpp:3392`):
  cross-space jump. `nearbyMBRef=None` teleports within the current cell.
  Failure paths call `onTeleportFailure()` (`entity.cpp:3471`, `:3481`,
  `:3490`, `:3522`, `:3544`, `:3557`, `:3591`, `:3769`); success calls
  `onTeleportSuccess(nearbyEntity, lastSpaceID)` (`:3530`, `:3706`).
  `onTeleport()` (`entity.cpp:3778-3783`) fires at the pre-transfer moment of
  the teleport flow.
- `controlledBy` getset (`entity.cpp:87`): setter asserts the entity is real
  (`:422`); assigning a base entityCall hands movement authority to that
  client's base entity; losing control triggers `onLoseControlledBy(id)`
  (`:1510`); on client handoff the entity re-assigns `controlledBy` to its
  own base (`:2172-2173`); the field round-trips through entity
  backup/restore streams (`:4035-4099`).
- `onRestore()` (`entity.cpp:3864-3868`, driven from
  `cellapp.cpp:1067`/`:1231` during space restore from baseapp): cellapp
  crash recovery re-creation hook.
- `onSpaceGone()` (`entity.cpp:381-384`; broadcast per entity from
  `spacememory.cpp:510`): the containing space was destroyed.
- `isReal()` (`entity.cpp:1446`): real vs ghost; ghosts proxy def-method
  calls over RPC (`entity_component.cpp:42-49`).

## 10. Entity attributes (complete list)

| Attribute | R/W | Notes (fork-verified) |
| --- | --- | --- |
| `id` | R | `entity_macro.h:37` |
| `className` | R | `entity_macro.h:39` |
| `isDestroyed` | R | `entity_macro.h:38`, impl `:1489-1493` |
| `position` | R/W | `entity.cpp:83`; writes go through the position-update path (witness/volatile machinery) |
| `direction` | R/W | `entity.cpp:84` — (roll, pitch, yaw) radians |
| `layer` | R/W | `entity.cpp:82` — navmesh layer selection (`:2242`) |
| `spaceID` | R | `entity.cpp:81` |
| `topSpeed` / `topSpeedY` | R/W | `entity.cpp:85-86` — server-side movement legality bound |
| `controlledBy` | R/W | `entity.cpp:87` — see §9 |
| `volatileInfo` | R/W | `entity.cpp:88` (`:2297`) — per-axis volatile sync policy; also declarable in `.def` `<Volatile>` |
| `base` / `client` | R | `entity.cpp:74-75` |
| `allClients` / `otherClients` | R | `entity.cpp:76-77` — see §8 |
| `isWitnessed` / `hasWitness` | R | `entity.cpp:78-79` |
| `isOnGround` | R | `entity.cpp:80` — present in the material's attribute prose but **missing from its summary table** (§9) |

## 11. Entity callbacks (complete list)

Timers §5 · controllers §6 (`onMove`, `onMoveOver`, `onMoveFailure`,
`onTurn`) · view §7 (`onEnteredView`, `onGetWitness`, `onLoseWitness`,
`onWitnessed`, `onEnterTrap`, `onLeaveTrap`, `onUpdateBegin`, `onUpdateEnd`)
· lifecycle §9 (`onDestroy`, `onRestore`, `onSpaceGone`, `onTeleport`,
`onTeleportSuccess`, `onTeleportFailure`, `onWriteToDB`) · control §9
(`onLoseControlledBy`) · `onTimer` §5. All 21 callbacks from the material
are accounted for above with call sites; none are fabricated as implemented
beyond what the cited lines show.

## 12. 3.7 source material vs fork 3.12 deviations

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `delTimer` with stale id | "an error will be generated" | Returns `-1` silently; no Python exception raised | Fork | `kbe/src/lib/entitydef/entity_macro.h:1478-1482` |
| `cancelController("Type")` | Implies a controller-type string generally cancels by type | Only the exact string `"Movement"` is accepted; any other string raises `TypeError` | Fork | `kbe/src/server/cellapp/entity.cpp:1706-1711` |
| Controller entry points "trackEntity"/"turnToYaw" | Class description names them as the way controllers are added | No such methods exist in the fork's cellapp Entity table; real entry points are `moveToEntity` / `addYawRotator` | Fork | `kbe/src/server/cellapp/entity.cpp:46-68` |
| `accelerate` parameter table | Table lists parameter "velocity" (chm table corruption) | Signature is `(accelerateType, acceleration)`; impl parses `(type, acceleration)` | Fork | material `Entity.md:142-144`; `kbe/src/server/cellapp/entity.cpp:3020` |
| `isOnGround` | Documented in attribute prose but absent from the material's own attribute summary table | Registered as a read-only getset | Fork | material `Entity.md:1096-1106`; `kbe/src/server/cellapp/entity.cpp:80` |
| `onReadyForLogin` ready threshold | "return value ≥ 1.0 → ready" | `True` → ready; otherwise float, complete at `>= 0.9999`; no callback → immediately complete | Fork | `kbe/src/server/cellapp/initprogress_handler.cpp:163-196` |
| `createSpace` on cellapp | Not documented in the cellapp material | Also absent in the fork: no cellapp-side registration (grep `server/cellapp/` + `lib/server/` = 0 hits); space creation flows baseapp→cellappmgr | Fork | grep 2026-11-04 at HEAD `6d12b8f`; `cellapp.cpp:875` |
| `NEXT_ONLY` | "currently unused in Cellapp" | Constant is still defined on the module, unused — same as material | Fork | `kbe/src/lib/server/python_app.cpp:323` |
| `genUUID64` uniqueness | Depends on the `gus` startup arg; >65535 degrades to per-process uniqueness | Same contract, plus an explicit runtime warning when global order ∉ 0~65535 | Fork | `kbe/src/lib/pyscript/script.cpp:91-106` |
| Code examples (`print "..."`) | Python 2 syntax in material examples | 3.12 requires `print(...)`; the material's snippets must be rewritten, not copied | Python | https://docs.python.org/3/whatsnew/3.0.html (print is a function) |
| `volatileInfo` type row | Listed as "float" in the attribute table | Four-float sequence + optimized flag; declarable via `.def` `<Volatile>` — matches the material's own prose, not its table row | Fork | material `Entity.md:86` vs `:1231-1265`; `kbe/src/server/cellapp/entity.cpp:88` |

## References

- Registration maps: `server/cellapp/entity.cpp:46-90`,
  `lib/entitydef/entity_macro.h:12-40`, `server/cellapp/entity_component.cpp:10-27`,
  `server/cellapp/cellapp.cpp:172-199`, `lib/server/entity_app.h:410-453`,
  `lib/server/python_app.cpp:271-334`, `lib/pyscript/script.cpp:248-258`,
  `lib/pyscript/pywatcher.cpp:184-185`, `lib/pyscript/pyurl.cpp:23`
- Timers: `lib/entitydef/entity_macro.h:1372-1405`, `:1447-1482`
- Controllers: `server/cellapp/controllers.h:22`, `entity.cpp:1604`, `:1671-1750`,
  `:2624-2816`, `:3020-3064`; handlers `moveto_point_handler.cpp`,
  `navigate_handler.cpp`, `rotator_handler.cpp`, `proximity_controller.cpp`,
  `trap_trigger.cpp`
- View: `server/cellapp/witness.cpp:749-753`, `:895-899`;
  `entity.cpp:1779-1783`, `:2092-2215`, `:2439-2518`
- Broadcast: `server/cellapp/all_clients.cpp:57-85`, `:171`;
  `clients_remote_entity_method.cpp:55-135`
- Data replication: `cellapp.cpp:830-872`, `lib/server/entity_app.h:1280-1314`,
  `spacememory.cpp:308-619`, `initprogress_handler.cpp:134-196`
- Grounding performed at fork HEAD `6d12b8f` on 2026-11-04.
