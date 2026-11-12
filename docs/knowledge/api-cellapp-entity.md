# Cellapp Entity face API reference (KB-API-004)

> Same claims, same citations; this EN page is canonical for line-number drift
> checks.
>
> **Scope**: the shared `Entity` class as registered on the **cellapp**
> process — timers, the controller chain, view/AOI, the broadcast face,
> lifecycle/teleport, attributes and callbacks. The `KBEngine` module face
> and the face-assembly layer map live on the companion page
> [api-cellapp](api-cellapp.md) (§1 there answers "is this API really
> available on cellapp?" for both faces).
>
> **Grounding**: fork `kbe/src` at HEAD `6d12b8f` (grounding base `c2a3b8f`).
> Version baseline and deviation-annotation format follow
> [Python version baseline](python-version-baseline.md). Companion pages:
> [Entity lifecycle & reference release](entity-lifecycle-reference.md) (destroy
> guards, timer/release flow), [Fixed directories](fixed-directories-and-path-resolution.md)
> (`KBE_RES_PATH`-bounded resource functions).
>
> **Coverage**: the Entity portion of the 121 documented surface items —
> 29 member functions + 21 callbacks + 17 documented attributes (16 table
> rows; `isOnGround` is documented in the material's attribute prose but
> missing from its own summary table — see §8).

## 1. Entity timers (`addTimer`/`delTimer`/`onTimer`)

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
  generated" for stale ids does **not** match this fork (§8).
- Callback name is fixed: `onTimer(timerHandle, userData)` defined on the
  entity script class.

## 2. Entity controller chain (movement / navigation / turn / proximity)

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
entry points are `moveToEntity` and `addYawRotator` (§8).

## 3. View / AOI (Witness) face

The view system is witness-based: an entity with a bound `Witness`
(`server/cellapp/witness.cpp`) tracks which observers receive its updates.

| Item | Impl | Semantics |
| --- | --- | --- |
| `setViewRadius(radius, hyst)` | `entity.cpp:2439` | Real-entity only (`:2441` AssertionError); forwards to the witness/view triggers; `hyst` is the leave-lag band so enter/leave don't flicker |
| `getViewRadius()` / `getViewHystArea()` | `entity.cpp:2462`, `:2518` | Read from the bound witness (`pWitness_->viewRadius()`); **0.0 when no witness is bound** (`:2465-2466`) |
| `debugView()` | `entity.cpp:3149` | Dumps view state (size/seen/pending/radius) to the cellapp log |
| `entitiesInView(pending)` | `entity.cpp:63` registration | `pending=false` → entities already synchronized to the client; `pending=true` → server-visible but not yet synchronized |
| `entitiesInRange(range, entityType, position)` | `entity.cpp:62` | Spherical range query; can find entities outside the view but never across cells |
| `getWitnesses()` | `entity.cpp:2468` | The set of entities observing this one (the broadcast audience, §4) |
| `onEnteredView(entity)` | `entity.cpp:1779-1783` | An entity entered this entity's view |
| `onGetWitness()` / `onLoseWitness()` | `entity.cpp:2177`, `:2215` | Witness bound/unbound; readable via `hasWitness` getset (`entity.cpp:79`) |
| `onWitnessed(isWitnessed)` | `entity.cpp:1483`, `:1528` | This entity entered/left *someone's* view — the canonical AI on/off switch |
| `onUpdateBegin()` / `onUpdateEnd()` | `witness.cpp:749-753`, `:895-899` | Bracket each witness update sweep (only called when the script defines them) |
| `onEnterTrap` / `onLeaveTrap` | `entity.cpp:1752-1765` | Proximity trigger crossings (`addProximity`); also `onLeaveTrapID` by id (`:1770`) |

## 4. Entity calls and the broadcast face

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

## 5. Entity lifecycle, persistence, teleport, control

- `destroy(...)` (`entity_macro.h:19`, cellapp guards `entity.cpp:315-323`):
  rejects with `AssertionError` while the entity is initing or already
  destroyed; full destroy/garbage flow in
  [entity lifecycle](entity-lifecycle-reference.md). `onDestroy` is invoked
  only if the script defines it.
- `destroySpace()` (`entity.cpp:342`): destroys the space this entity
  occupies.
- `writeToDB(shouldAutoLoad, dbInterfaceName)` (`entity_macro.h:18`):
  archives the entity to dbmgr (base+cell data); `onWriteToDB` fires on the
  script side when implemented — and on the cellapp it fires with **zero
  arguments** (`entity.cpp:1238`, immediately followed by
  `backupCellData()` `:1239` and serialization). The same entity class's
  base-side callback of the same name takes one `cellData` snapshot
  argument (`cellDataDict_`, see
  [api-baseapp-entity](api-baseapp-entity.md)); write the signature as
  `def onWriteToDB(self, cellData=None)` to work on both. A cellapp entity
  has no cellData attribute (`installCellDataAttr` is never installed
  here) — cell properties are plain instance attributes.
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

## 6. Entity attributes (complete list)

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
| `controlledBy` | R/W | `entity.cpp:87` — see §5 |
| `volatileInfo` | R/W | `entity.cpp:88` (`:2297`) — per-axis volatile sync policy; also declarable in `.def` `<Volatile>` |
| `base` / `client` | R | `entity.cpp:74-75` |
| `allClients` / `otherClients` | R | `entity.cpp:76-77` — see §4 |
| `isWitnessed` / `hasWitness` | R | `entity.cpp:78-79` |
| `isOnGround` | R | `entity.cpp:80` — present in the material's attribute prose but **missing from its summary table** (§8) |

## 7. Entity callbacks (complete list)

Timers §1 (`onTimer`) · controllers §2 (`onMove`, `onMoveOver`,
`onMoveFailure`, `onTurn`) · view §3 (`onEnteredView`, `onGetWitness`,
`onLoseWitness`, `onWitnessed`, `onEnterTrap`, `onLeaveTrap`,
`onUpdateBegin`, `onUpdateEnd`) · lifecycle §5 (`onDestroy`, `onRestore`,
`onSpaceGone`, `onTeleport`, `onTeleportSuccess`, `onTeleportFailure`,
`onWriteToDB`) · control §5 (`onLoseControlledBy`). All 21 callbacks from
the material are accounted for above with call sites; none are fabricated as
implemented beyond what the cited lines show.

## 8. 3.7 source material vs fork 3.12 deviations (Entity face)

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `delTimer` with stale id | "an error will be generated" | Returns `-1` silently; no Python exception raised | Fork | `kbe/src/lib/entitydef/entity_macro.h:1478-1482` |
| `cancelController("Type")` | Implies a controller-type string generally cancels by type | Only the exact string `"Movement"` is accepted; any other string raises `TypeError` | Fork | `kbe/src/server/cellapp/entity.cpp:1706-1711` |
| Controller entry points "trackEntity"/"turnToYaw" | Class description names them as the way controllers are added | No such methods exist in the fork's cellapp Entity table; real entry points are `moveToEntity` / `addYawRotator` | Fork | `kbe/src/server/cellapp/entity.cpp:46-68` |
| `accelerate` parameter table | Table lists parameter "velocity" (chm table corruption) | Signature is `(accelerateType, acceleration)`; impl parses `(type, acceleration)` | Fork | material `Entity.md:142-144`; `kbe/src/server/cellapp/entity.cpp:3020` |
| `isOnGround` | Documented in attribute prose but absent from the material's own attribute summary table | Registered as a read-only getset | Fork | material `Entity.md:1096-1106`; `kbe/src/server/cellapp/entity.cpp:80` |
| `volatileInfo` type row | Listed as "float" in the attribute table | Four-float sequence + optimized flag; declarable via `.def` `<Volatile>` — matches the material's own prose, not its table row | Fork | material `Entity.md:86` vs `:1231-1265`; `kbe/src/server/cellapp/entity.cpp:88` |

Module-face deviations (`onReadyForLogin` threshold, `createSpace` absence,
`NEXT_ONLY`, `genUUID64` uniqueness, the Python 2 `print "..."` example
hygiene note) live on the [module face page](api-cellapp.md) deviations
table.

## References

- Registration maps: `server/cellapp/entity.cpp:46-90`,
  `lib/entitydef/entity_macro.h:12-40`,
  `server/cellapp/entity_component.cpp:10-27`
- Timers: `lib/entitydef/entity_macro.h:1372-1405`, `:1447-1482`
- Controllers: `server/cellapp/controllers.h:22`, `entity.cpp:1604`, `:1671-1750`,
  `:2624-2816`, `:3020-3064`; handlers `moveto_point_handler.cpp`,
  `navigate_handler.cpp`, `rotator_handler.cpp`, `proximity_controller.cpp`,
  `trap_trigger.cpp`
- View: `server/cellapp/witness.cpp:749-753`, `:895-899`;
  `entity.cpp:1779-1783`, `:2092-2215`, `:2439-2518`
- Broadcast: `server/cellapp/all_clients.cpp:57-85`, `:171`;
  `clients_remote_entity_method.cpp:55-135`
- Lifecycle/teleport: `entity.cpp:315-323`, `:3392-3783`, `:3864-3868`;
  `cellapp.cpp:1067`, `:1231`; `spacememory.cpp:510`
- Grounding performed at fork HEAD `6d12b8f` on 2026-11-04.
