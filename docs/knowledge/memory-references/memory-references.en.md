# KB-001 · Headline Topic · Memory Object References and Release Pitfall Set (English edition)

> Belongs to: KB-001 "KBEngine Source-Analysis Knowledge Base" **Headline topic of the first batch** (user-named disaster area, 2026-11-01)
> Language: en / zh bilingual (Chinese edition: [`memory-references.zh.md`](./memory-references.zh.md))
> Companion mechanism doc: Entity Lifecycle (create → cell migration → destroy), see [`../entity-lifecycle/`](../entity-lifecycle/)
>
> **Writing principle**: each pitfall is organized as "symptom → root cause (with kbe/src source citation; TODO 待验证 where no citation) → correct practice". Root causes use CPython refcounting semantics; KBEngine-side managed behavior is only written where the in-repo `docs` and the def model actually support it; anything not found is explicitly marked TODO, never fabricated.

## Contents

- [§0 CPython Foundation: why this pitfall set exists](#0-cpython-foundation-why-this-pitfall-set-exists)
- [§1 Pitfall Class 1: lifecycle references](#1-pitfall-class-1-lifecycle-references)
- [§2 Pitfall Class 2: reference invalidity after cell/base migration](#2-pitfall-class-2-reference-invalidity-after-cellbase-migration)
- [§3 Pitfall Class 3: holding a reference after destroy](#3-pitfall-class-3-holding-a-reference-after-destroy)
- [§4 Pitfall Class 4: timer / Functor holding references](#4-pitfall-class-4-timer--functor-holding-references)
- [§5 Pitfall Class 5: cellData snapshot vs live object](#5-pitfall-class-5-celldata-snapshot-vs-live-object)
- [§6 TODO verification list (all TODOs)](#6-todo-verification-list-all-todos)
- [§7 Evidence Sources](#7-evidence-sources)

---

## 0. CPython Foundation: why this pitfall set exists

KBEngine's script layer is CPython. CPython memory release runs on two lines: **refcounting + cyclic garbage collection**:

- **Refcount hits zero → released**: a PyObject with no strong references is destructed immediately (Py_DECREF chain). This is the dominant, and most "zombie"-producing, path — if anyone forgets to drop a strong reference, the object lives forever.
- **Cyclic GC** only handles **reference cycles** (objects referencing each other with no external entry). A pure cycle is eventually collected by GC, but at an uncontrolled time.

On top of that, KBEngine adds a **managed** layer: an entity is not a bare Python object — it is an object registered by `id` in the `entities` dict. The engine can "destroy" an entity (remove from dict, mark `isDestroyed`, stop dispatching logic events), but **as long as your Python code holds a strong reference to it, the Python object stays alive on the heap per refcounting** — the engine's "destroy" semantics and Python's "release" semantics are two different things. All five pitfall classes below grow out of this mismatch.

> The per-line mechanics of CPython refcounting / GC are, per the KB-001 decision, **not rewritten** here — they are cross-referenced to hello-python's `docs/internals/` source-level analysis (object-model / memory-management / gc-module / type-system / eval-loop, 10 docs, inventoried 2026-11-01). This doc uses CPython semantics as a known premise.

---

## 1. Pitfall Class 1: lifecycle references

### Symptom

After storing an entity object into another entity's property / a global dict / a module-level list, the referenced entity appears to "still be called after destroy" or "its methods still run although `self.xxx.isDestroyed` is already True".

### Root cause

**An "entity" in KBEngine is a lifetime managed by the engine, not "own the object once you hold it".**

- The engine registers entities by `id` in `entities` (`lib/entitydef/entities.h:22、:128`; registration `lib/server/entity_app.h:411`). The `KBEngine.entities` module attribute is `entities` on both baseapp and cellapp (`entity_app.h:411`).
- `destroy()` does engine semantics: remove registration, set `isDestroyed=True` (`lib/entitydef/entity_macro.h:34`, same macro block `:33-35`), stop logic-event dispatch.
- What you stored is a **strong reference** (a plain Python assignment `self.friend = other` is an `incref`). Removing the registration does not `decref` on your behalf. So the Python object stays alive on the heap, and `other.someMethod()` still runs — the engine just no longer manages it.

The precise engine-side semantics of "entity being referenced" (whether the engine provides a `__del__` hook or weak references) is not covered by in-repo analysis, marked **TODO 待验证**.

### Correct practice

1. **Store id, not object, for cross-entity relationships**: `self.friendID = other.id`; fetch on use via `KBEngine.entities.get(self.friendID)`. If it returns None (destroyed / not loaded), that naturally expresses "relationship dead".
2. **When you must hold the object, check `isDestroyed` before use** (`entity_macro.h:34`):
   ```python
   friend = self.friend
   if friend is not None and not friend.isDestroyed:
       friend.onSomeEvent(...)
   ```
3. **Clear references at the destroy point**: in `onDestroy` (cell side `server/cellapp/entity.cpp:209`), set `self.friend = None`, remove from global lists, so refcount hits zero.
4. (C-23 plans a `destroyed-entity-reference` lint rule to statically detect common reference patterns to destroyed entities — see todo.md C-23 deliverable ②.)

---

## 2. Pitfall Class 2: reference invalidity after cell/base migration

### Symptom

After a cell entity migrates across cellapps (or teleports), the base side's cached `self.cell` handle, or a stored cell-object reference elsewhere, "can't send calls / calls land on the old address / throws".

### Root cause

`self.cell` / `self.base` are not entity objects — they are **EntityCall handles**, remote proxies for inter-process communication:

- base-side `cell` getter: `pyGetCellEntityCall`, `server/baseapp/entity.cpp:36`, returns an EntityCall handle.
- cell-side `base` getter: `server/cellapp/entity.cpp:74`.
- The engine has only one script type `EntityCall` (`lib/entitydef/entity_call.h:15`); base/cell/client are an internal enum `ENTITYCALL_TYPE` (`lib/common/common.h:283-291`), and there are no `BaseEntityCall/CellEntityCall/ClientEntityCall` subclasses at the Python type level (`docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` deviation list #2, double-evidenced).

Migration is fundamentally **the entity moved processes and changed communication address**. `onRestore()` (`server/cellapp/entity.cpp:3868`) is the moment the cell is rebuilt on the new cellapp; **the old handle points at the old address**. Whether the engine actively invalidates old EntityCalls at migration (null out / repoint) is not covered by in-repo analysis, marked **TODO 待验证** — but either way the safe model is the same: after migration you must **not assume any pre-migration cached EntityCall still points at a live entity**.

### Correct practice

1. **Do not cache `self.cell` / `self.base` across frames into long-lived properties**. Fetch on use: `self.cell.someMethod()`.
2. **Rebuild migration-sensitive state in `onRestore`** (`server/cellapp/entity.cpp:3868`).
3. **Confirm the peer is ready before cross-process interaction**: after migration, use `onGetCell` (base side, `server/baseapp/entity.cpp:1032`) to confirm the new cell is ready, then proceed.

---

## 3. Pitfall Class 3: holding a reference after destroy

### Symptom

After `entity.destroy()`, another entity's stored `self.target = entity` can still call methods / set properties — looks like "destroy didn't take effect"; more insidiously, it causes memory to only grow (object never released).

### Root cause

The semantics of `destroy(deleteFromDB=False, writeToDB=False)` (`lib/entitydef/entity_macro.h:20`, kwargs list `server/baseapp/entity.cpp:626-632、657-658`) are as in §1: engine removes registration + sets `isDestroyed`, **does not clear your Python reference**.

Two consequences:

1. **"Zombie calls"**: you hold a live object (refcount > 0), method calls don't error, but engine-layer logic (view, timers, persistence, event dispatch) no longer treats it as an entity.
2. **Memory leak**: as long as the strong-reference chain is unbroken, the object never releases. If many destroyed entities are long-held somewhere, the heap keeps growing.

Whether the engine clears def properties / component references on the entity at destroy (to break internal reference cycles) is not covered by in-repo analysis, marked **TODO 待验证**. But regardless of what the engine clears, **your own references must be cleared by you**.

### Correct practice

1. As §1: cross-entity always stores id, fetch via `KBEngine.entities.get(id)`, treat None as destroyed.
2. In `onDestroy` (cell side `server/cellapp/entity.cpp:209`), clear all outbound strong references held by this entity (incl. component references, global registrations).
3. When you must hold the object, check `isDestroyed` (`entity_macro.h:34`) before use.

---

## 4. Pitfall Class 4: timer / Functor holding references

### Symptom

After `addTimer` on an entity, even if the entity is destroyed, the timer callback still fires; or the callback is a closure / bound method whose captured entity never releases.

### Root cause

Timers are engine-level scheduling objects, managed by `addTimer` / `delTimer` handles:

- Entity-level `addTimer(initialOffset, repeatOffset=0.0, userArg=0)` / `delTimer(id)` (`lib/entitydef/entity_macro.h:17-18`; impl `:1387-1405`、`:1407-1420`).
- Timer expiry calls back the entity's `onTimer(timerHandle, userData)` (base side `server/baseapp/entity.cpp:1656`, cell side `server/cellapp/entity.cpp:4322`; arg shape `(timerID, intptr(pUser))` per `entity_macro.h:1363`).
- Module-level `addTimer(initialOffset, repeatOffset, callbackObj)` (`lib/server/python_app.cpp:329`, impl `:721-726`, exactly 3 args `"ffO"`); and **baseapp/cellapp modules do not register a module-level addTimer at all** (`server/baseapp/baseapp.cpp:429-451`、`server/cellapp/cellapp.cpp:172-189` have no such entry) — module-level addTimer is only available in pythonapp-lineage processes (dbmgr/loginapp/interfaces/logger) (VALIDATION_REPORT deviation list).
- `delTimer` returns int (`python_app.cpp:766-771`), -1 on failure.

**The key mismatch**: timer callback dispatch is keyed on **whether the engine still considers the entity alive**, not on whether the object's Python reference still exists. After entity destroy the engine no longer dispatches to that entity (the precise engine chain of "timer invalidated on entity destroy" is not covered by in-repo analysis, marked **TODO 待验证**); but **when the callback object is a closure / bound method, the closure's captured strong reference is not affected by timer invalidation** — as long as anything else holds the closure, the captured entity does not release.

### Correct practice

1. **Repeating timers must be `delTimer(handle)`'d in `onDestroy`**. Store the handle returned by addTimer; C-23 plans a `timer-leak-on-destroy` lint rule (detecting addTimer handles not deregistered in onDestroy), see todo.md C-23 deliverable ②.
2. **Callbacks should avoid capturing long-lived entities in closures**; when capture is unavoidable, set the closure to None / remove it from registries in `onDestroy`.
3. For module-level timing needs (cross-entity, not attached to a specific entity), use module-level addTimer on pythonapp-lineage processes; attaching to baseapp/cellapp processes must recognize the source fact that "module-level addTimer does not exist" there (VALIDATION_REPORT deviation list).

---

## 5. Pitfall Class 5: cellData snapshot vs live object

### Symptom

In `onWriteToDB(cellData)`, you modified a `cellData` field expecting to change the cell entity's real property; or you stored `cellData` expecting it to represent "the current cell".

### Root cause

`cellData` is a **data snapshot the engine constructs at DB-write time**, not the cell entity object:

- `cellData` is in the `ENTITY_LIMITED_PROPERTYS` system-reserved property list (`lib/entitydef/common.h:124-157`; `cellData` in the list around `:82`), a system property that defs may not redefine; position/orientation go through alias injection (`common.h:118-121`).
- base-side `onWriteToDB(cellData)` takes a `cellData` arg (`docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi:91`, BaseEntityHooks); cell-side `onWriteToDB()` **takes no args** (same file `:119`, CellEntityHooks). The signature difference alone says: the base-side cellData is **data brought over from the cell side**, not the base entity's own property.
- Cell-side DB-write callback `server/cellapp/entity.cpp:1259`.

"At what moment the snapshot is built, whether it is a shallow copy of the cell entity's properties" is not covered by in-repo analysis, marked **TODO 待验证**; but regardless of implementation, **semantically it is a data copy at write time — modifying it does not affect the cell entity itself**.

### Correct practice

1. In `onWriteToDB(cellData)`, treat it as a read-only data source; to change persisted values, change the cell entity property (so it takes effect at the next sync/DB write), or make explicit the "values I want to inject into this write" semantics (TODO 待验证: whether the engine reads back a modified cellData from the callback).
2. Do not hold `cellData` long-term as a live entity; it is only this write's snapshot.

---

## 6. TODO verification list (all TODOs)

| # | To verify | Where | Source evidence needed |
|---|---|---|---|
| 1 | Whether the engine provides entity weakrefs / `__del__` hook | §1 root cause | entity destruction path (entity_macro.h / pyscript binding) |
| 2 | Whether the engine actively invalidates old EntityCalls at cell migration | §2 root cause | entity_call.cpp migration handling + onRestore chain |
| 3 | Full base destroy → cell destroy call chain | lifecycle doc §3.1 | baseapp/entity.cpp destroy impl |
| 4 | Exact base-side onDestroy call line | lifecycle doc §3.2 / §4.1 | baseapp entity destruction path |
| 5 | Whether engine clears entity def properties / component refs at destroy (breaks reference cycles) | §3 root cause | entity destruction / property-cleanup path |
| 6 | Precise engine behavior of timer invalidation after entity destroy | §4 root cause | entity_macro.h addTimer/delTimer × destruction-path interaction |
| 7 | cellData snapshot construction timing/copy depth; whether modified cellData is read back | §5 root cause | baseapp/entity.cpp DB-write path + cellData packing logic |
| 8 | Per-line mechanism of def-property injection before `__init__` | lifecycle doc §1.1 | KBEngine Python binding layer (extension domain ①) |

---

## 7. Evidence Sources

In-repo analysis artifacts directly checkable (line numbers cited here all come from these docs' source verification):

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` — typings vs kbe/src line-by-line verification (addTimer/delTimer/EntityCall subclasses/cellData/two-side onWriteToDB signature differences and call sites)
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi` — lifecycle hook signatures (incl. onWriteToDB's cellData arg difference)
- `docs/review/2026-10-21-entity-builtin-properties.md` — Entity builtin properties per-component verification (cell/base/isDestroyed/cellData system-reserved list)
- `docs/source-analysis.md` — entitydef load chain and three-side existence determination
- `todo.md` KB-001 / C-23 entries — headline topic positioning, follow-up lint rules (destroyed-entity-reference / timer-leak-on-destroy) plan

The engine source tree itself (`kbe/src/...`) is not inside the kode repo; the in-repo docs above were produced against the user's local KBEngine checkout. All TODO 待验证 items here require verification against the engine source — **not filled in by guessing**.
