# Entity lifecycle & object reference release

> KB-001 head topic (user-named priority): memory object reference & release.
> Sources cited by `kbe/src` `file:line`; every claim is grounded in the engine
> source (`kbengine@c2a3b8f`). The baseapp path is analogous to the cellapp
> path shown here; the migration/teleport reference flow is covered by
> [entity-migration-and-cross-process-references.md](entity-migration-and-cross-process-references.md).

## The live registry holds a strong reference

`KBEngine.entities` is the process-wide live-entity registry. It is a map
`ENTITY_ID → PyObjectPtr` (`kbe/src/lib/entitydef/entities.h:24`): the map value
is a **smart pointer that owns a strong CPython reference** to the entity's
Python object. While an entity is in this map, the engine guarantees its Python
object is alive (refcount ≥ 1 from the registry itself).

## Destroy flow: move out of the registry, into `garbages`

`entity.destroy()` from Python reaches `CLASS::destroyEntity()` (macro,
`kbe/src/lib/entitydef/entity_macro.h:1486`), which forwards to the app-level
`EntityApp::destroyEntity(id, true)` (`kbe/src/lib/server/entity_app.h:713`):

```cpp
PyObjectPtr entity = pEntities_->erase(entityID);   // move out of live map
if(entity != NULL) { entity->destroy(callScript); } // destroy the (still-alive) object
```

`Entities<T>::erase` (`entities.h:331`) does the move in two steps:

```cpp
T* entity = static_cast<T*>(iter->second.get());
_pGarbages->add(id, entity);   // ① record the raw pointer in `garbages`
_entities.erase(iter);         // ② drop the registry's strong ref
return entity;                 // ③ return as PyObjectPtr (kept alive for destroy())
```

So a destroyed entity is **removed from the live registry** and its raw
`PyObject*` is **recorded in `KBEngine.entities.garbages`** — a
non-owning pointer registry (`kbe/src/lib/entitydef/entity_garbages.h:23`, value
type `PyObject*`). `garbages` does **not** increment the refcount on `add`
(`entity_garbages.h:273-301`).

## Reference semantics: the engine does not keep the destroyed object alive

After the registry drops its strong ref (`_entities.erase`), the entity Python
object's lifetime is decided entirely by the **other CPython references**
(script closures, lists, timers, `cellData` snapshots, ...). `garbages` holds a
raw pointer only — it does not own the object. Consequences:

- If **no other reference** remains, the object is freed (refcount 0) and the
  `garbages` entry becomes dangling — a query through `garbages[id]` is only
  valid while the object is still alive.
- If a script **still holds a reference** (the classic leak / use-after-destroy),
  the object stays alive and `garbages` still points at it.

## Leak detection

`EntityGarbages::add` records a timestamp when the map first becomes non-empty
(`entity_garbages.h:282-285`). If the garbages are **not emptied for 3600 s**
(`stampsPerSecond() * 3600`, `entity_garbages.h:289`), the engine logs:

> "For a long time(3600s) not to empty the garbages, there may be a leak of the
> entitys(size:N), please use the `KBEngine.entities.garbages.items()` command
> query!" (`entity_garbages.h:294-296`)

`garbages` is exposed to Python with `has_key`/`keys`/`values`/`items`/`get`
(`entity_garbages.h:124-130`), reachable as `KBEngine.entities.garbages`
(`entities.h:126`). Accessing an entry hands out a strong ref to the caller
(`Py_INCREF`, `entity_garbages.h:169`).

## Destroy guards (traps)

- `destroy()` during `__init__` (`initing`) → **AssertionError**
  ("initing, reject the request", `cellapp/entity.cpp:315`).
- `destroy()` on an already-destroyed entity → **AssertionError**
  ("is destroyed", `cellapp/entity.cpp:322`).
- Most entity methods guard the same way after destroy — `destroySpace`
  (`:354`), `addProximity` (`:1616`), `clientEntity` (`:1638`), and more
  (`:414`, `:1792`): calling any of these on a destroyed entity raises
  AssertionError. A **remote** call targeting a destroyed entity is instead a
  logged `ERROR_MSG`, not an assertion (`onRemoteMethodCall`,
  `cellapp/entity.cpp:991`).
- `entity.isDestroyed` is a read-only Python property (`entity_macro.h:34`).

## `onDestroy` callback & cell data backup

`Entity::onDestroy(callScript)` (`cellapp/entity.cpp:204`) calls the Python
`onDestroy` callback **only when `callScript && isReal()`** (`:206-210`). The
comment is explicit: "通常销毁一个entity不通知脚本可能是迁移或者传送造成的"
(no script notification during migration/teleport). On a script-notified
destroy the engine also `backupCellData()` and sends `onLoseCell` to the base
(`:216-220`) — the base keeps the cell data snapshot even as the cell entity is
destroyed, which is why a base-side reference to a destroyed cell entity can
still read the last `cellData`.

## Cell state table

Line numbers below are the base side
(`kbe/src/server/baseapp/entity.cpp`) unless noted, verified at
`kbengine@3082ab5`.

| State | Set by | Cleared by | Script callback |
|---|---|---|---|
| base created, no cell | ctor `:59` (`creatingCell_ = false`) | — | — |
| **creating cell** (request in flight) | `createCellEntity` `:1463`; `restoreCell` `:1473` | `onGetCell` `:1021`; `onCreateCellFailure` `:881` | none — the request is asynchronous |
| **has cell** | `onGetCell` `:1028` (builds `cellEntityCall_`) | `onLoseCell` `:1059` (`S_RELEASE`) | `onGetCell` `:1030-1032`, skipped when `inRestore_` |
| cell lost, base still alive | `onLoseCell` `:1059` | — (nothing reinstates `cellData` here; the Python attribute **stays deleted**, see below) | `onLoseCell` `:1065` |
| **restoring** (after a baseapp crash) | `restoreCell` `:1474` (`inRestore_ = true`) | `onRestore` `:1085` | `onRestore` `:1080`, driven from `restore_entity_handler.cpp:173,266` |
| destroyed | — | — | base `Entity::onDestroy` `:164` (fires `onDestroy` when `callScript`); cellapp `:204` |

The restore entry is `RestoreEntityHandler::process`
(`restore_entity_handler.cpp:89`), fed per entity from `baseapp.cpp:709,723`;
it calls `restoreCell` (`:159`, `:304`), which reuses the normal cell path but
with `inRestore_` set, then fires `onRestore` from the handler
(`:173`, `:266`) **after** the cell has arrived.

### A create call never proves a cell is held

`createCellEntity` (`:1416`) ends by setting `creatingCell_ = true`
(`:1463`), sending `Baseapp::createCellEntity(...)`, and returning —
**synchronously**, with `cellEntityCall_` still `NULL`. The only observation
that a cell is held is the `entity.cell` property
(getter `pyGetCellEntityCall`, `:750`; attribute table `:36`), which reads
`cellEntityCall_` and is therefore `None` until `onGetCell`. The in-flight flag
itself is `creatingCell_` (`entity.h:295`), readable only as `creatingCell()`
(`entity.h:107`) — an engine-internal accessor with no Python surface.

While `creatingCell_` is set, `destroy()` is **deferred**, not rejected
(`:641`): it warns "creating cell! automatic 'destroy' process will begin after
'onGetCell'" and raises `ENTITY_FLAGS_DESTROY_AFTER_GETCELL`
(`entity_macro.h:268`). The two paths that later honour that flag differ in
**what** they destroy: `onGetCell` calls `destroyCellEntity()` (drop the cell
part, `:1037-1041`), while `onLoseCell` calls `destroy()` (drop the base,
`:1069-1074`). Calling `createCellEntity` twice fails instead:
`AssertionError "has a cell"` when `creatingCell_ || cellEntityCall()`
(`:1435`).

`onGetCell` also runs `destroyCellData()` (`:1024`) — the `cellData` attribute
is **deleted** the moment the cell exists.

### Reading `cellData` after the cell exists raises `AttributeError`

`destroyCellData` (`:560`) deletes the attribute with
`PyObject_DelAttrString(this, "cellData")` (`:564`). There is **no type-level
getter** for `cellData` anywhere in the base `Entity` method table — it is a
pure instance attribute installed by `installCellDataAttr`
(`:217`, via `PyObject_SetAttrString`, `:238`). So after deletion a script read
of `self.cellData` raises `AttributeError`; there is no fallback to
`cellDataDict_`, which the comment at `:562-563` states survives only so the
engine can still back it up.

Reading it back is not automatic either: the only reinstall site is
`onBackupCellData` (`:1109`), and it reinstalls **only when `isDirty`**
(`:1116-1122`). `onLoseCell` (`:1052`) does not touch `cellData` at all, so a
base entity whose cell was destroyed keeps `cellData` deleted.

Corollary that bites: the engine has **no** `isOnCell`/`isOnDB`/`isPersisted`
predicate. The base `Entity` attribute surface is `cell`, `client`,
`databaseID`, `databaseInterfaceName`, `shouldAutoBackup`,
`shouldAutoArchive` (`:35-41`) plus `id`, `isDestroyed`, `className`
(`entity_macro.h:33-35`). Code that reasons about "does it have a cell" must
read `entity.cell`, not the fact that a create was called.

## Timers: no strong reference, cancelled on destroy

Timers are per-entity. Python `addTimer(interval, repeat, userArg)` builds a
per-timer `EntityScriptTimerHandler` holding a **raw `CLASS* pEntity_`**, not a
Python strong reference (`entity_macro.h:1362-1385`, created at `:1389`). The
engine therefore does **not** keep a destroyed entity alive through a timer.

`Entity::destroy()` calls `scriptTimers_.cancelAll()` (`cellapp/entity.cpp:4002`);
each `handle.cancel()` fires the handler's `onRelease`, which releases the timer
entry and `delete`s the handler (`entity_macro.h:1377-1382`). So a timer never
fires on a destroyed entity (game logic is serialized on one thread). The
timer's fire path is `handleTimeout` → `pEntity_->onTimer(id, userArg)`
(`entity_macro.h:1370-1375`) → Python `onTimer(timerID, userArg)` via
`bufferOrExeCallback` (`cellapp/entity.cpp:4318-4322`), which **buffers** the
callback while `_scriptCallbacksBufferCount > 0` (e.g. during init/ghost) and
executes it otherwise (`cellapp/entity.cpp:1263-1293`).

Removal: `delTimer(id)` → `ScriptTimersUtil::delTimer` → `handle.cancel()`,
returns `-1` when the timer does not exist (`entity_macro.h:1478`,
`script_timers.cpp:96-108`); `delTimer("All")` → `cancelAll()`
(`entity_macro.h:1449`).

Module-level `KBEngine.addTimer(interval, repeat, callback)` (interpreter-layer
registration on every app, `python_app.cpp:329-330`; implementation
`__py_addTimer`, `python_app.cpp:721-748`) is a **different story**: it builds a
`ScriptTimerHandler(pTimers, pyCallback)` that holds a **strong reference to the
callback object** — passing `self.onTick` strongly refs the entity. That timer
lives on the app's `scriptTimers()`, and `Entity::destroy()`'s
`scriptTimers_.cancelAll()` cancels only the entity's own `scriptTimers_`,
**never** it. A self-bound repeating timer that is not `KBEngine.delTimer`'d in
`onDestroy` keeps firing / leaks the entity into `garbages` (same family as the
closure/list references above); single-shot (repeat=0) self-releases after firing.

The real reference hazard is not the timer itself but a script closure or list
that captures the entity and outlives the destroy — that is the `garbages`/
3600 s leak scenario above, not a timer-holding reference.

## Pending engine-held callbacks (the "Functor" question)

The BigWorld-era "Functor holds a reference" worry has **no Functor to point
at in KBEngine**: a case-insensitive search of `kbe/src` finds no `Functor`
class outside vendored test dependencies. The engine's actual holder of
script callbacks is `PY_CALLBACKMGR = CallbackMgr<PyObjectPtr>`
(`kbe/src/lib/server/callbackmgr.h:215`), a per-entity member
(`entity_macro.h:279`) used by async-answer APIs (e.g. `writeToDB(callback)`).

Reference semantics, grounded in `callbackmgr.h`:

- `save(callback, timeout=0)` stores a **`PyObjectPtr` — a strong CPython
  reference** — in `cbMap_` keyed by an allocated id, with an expiry
  timestamp; timeout 0 means the server-config default
  (`callback_timeout_` seconds) (`callbackmgr.h:62-74`).
- `take(id)` returns and removes the callback when the answer arrives
  (`:78-89`); `tick()` expires stale entries — the expired path DECREFs the
  stored object (`processTimeout`, `:202-212`); `finalise()` clears all
  (DECREF on each entry for the raw-pointer variant, `:190-198`).
- The whole pending set **survives migration/teleport**: it is pickled into
  the entity stream (`addToStream`/`createFromStream`, `:134-188`) — this is
  the `pyCallbackMgr_.addToStream(s)`/`finalise()` pair seen in the
  ghost transition ([migration article](entity-migration-and-cross-process-references.md)).

Net: a pending engine callback keeps the *callback object* strongly
referenced until answered, expired or the entity is finalized — it never
keeps a destroyed *entity* alive, and it does not leak past the timeout.
