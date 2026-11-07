# Traps index (语义陷阱索引)

> KB-001 bucket ④: an index of the semantic traps and easy-to-misread
> behaviors collected across this knowledge base. Each row points at the
> article carrying the full 现象/根因/正确姿势 (symptom / grounded root
> cause / correct pattern) — this page never introduces a claim the target
> article does not already ground. Root-cause citations live in the target
> articles; the grounding commit per article is in its header.

## Memory & references

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| Holding a destroyed entity in a closure/list | `garbages` not emptied; after 3600 s the engine logs a leak warning | Drop references in `onDestroy`; query `KBEngine.entities.garbages.items()` to find holders | [lifecycle §Registry](entity-lifecycle-reference.md) |
| `destroy()` during `__init__` | AssertionError "initing, reject the request" | Defer destruction to after init | [lifecycle §Guards](entity-lifecycle-reference.md) |
| Method call on a destroyed entity (local) | AssertionError "is destroyed" | Guard with `entity.isDestroyed` | [lifecycle §Guards](entity-lifecycle-reference.md) |
| Remote call targeting a destroyed entity | No exception at the caller — a logged `ERROR_MSG`/`WARNING_MSG` at the receiver, message dropped | Treat remote fire-and-forget as best-effort; confirm via callback if it matters | [lifecycle §Guards](entity-lifecycle-reference.md), [migration §Rules](entity-migration-and-cross-process-references.md) |
| Worrying about BigWorld-style "Functor" reference leaks | No `Functor` class exists in KBEngine; the async-callback holder is `PY_CALLBACKMGR` — strong ref per pending callback, released on answer/timeout/finalise | Pending callbacks cannot outlive the timeout nor keep a destroyed entity alive | [lifecycle §Functor](entity-lifecycle-reference.md) |

## Migration & teleport

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| Ghost cannot `teleport` | AssertionError "not is real entity" | Teleport from the real entity | [migration §Teleport](entity-migration-and-cross-process-references.md) |
| Micro-jump inside a trap | Trap leave **and** enter callbacks both fire (teleport counts as instant move) | Expect both callbacks on any teleport, regardless of distance | [migration §Teleport](entity-migration-and-cross-process-references.md) |
| Wrong ref type to `teleport` (e.g. a base EntityCall) | `onTeleportFailure` | Pass a **cell-real** EntityCall (or the entity itself / None) | [migration §Teleport](entity-migration-and-cross-process-references.md) |
| Assuming old cell's `onDestroy` runs after cross-cellapp teleport | It never fires — the old entity is destroyed with `callScript=false`; `onTeleportSuccess` fires on the **new** cell, `onTeleportFailure` restores the **old** one | Put per-space cleanup in `onLeaveSpace`, not `onDestroy`-assumptions | [migration §Completion](entity-migration-and-cross-process-references.md) |
| Stale separately-held EntityCall copy after migration | Message silently dropped at the old cellapp (`WARNING_MSG entityID ... not found`) | Re-read `self.cell`/`self.base` at use time instead of caching the handle | [migration §Rules](entity-migration-and-cross-process-references.md) |
| Reading `self.cellData` while the cell lives | AttributeError (attribute is deleted; values are defaults or last dirty backup anyway) | Use `self.cell.<method>` calls; treat `cellData` as a no-cell-era snapshot only | [migration §cellData](entity-migration-and-cross-process-references.md) |

## Timers & controllers

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| `delTimer` with a stale id expecting an error | Returns `-1` silently (fork); the 3.7 material claims an error | Check the return value | [api-cellapp §deviations](api-cellapp.md) |
| Expecting to cancel timers in `onDestroy` | Unnecessary — `destroy()` cancels all timers (`scriptTimers_.cancelAll()`) | Only `delTimer` matters for early cancel while alive | [lifecycle §Timers](entity-lifecycle-reference.md), [usage stats](api-usage-stats.md) |
| `cancelController("SomeType")` | TypeError — only the exact string `"Movement"` is accepted | Cancel by handle for other controllers | [api-cellapp §deviations](api-cellapp.md) |
| Calling `trackEntity` / `turnToYaw` | No such methods in the fork | `moveToEntity` / `addYawRotator` | [api-cellapp §deviations](api-cellapp.md) |
| Module-level `KBEngine.addTimer` with a self-bound callback leaks | The app-level timer strongly refs the callback object (`self.onTick` strongly refs the entity); entity `destroy()` cancels only the entity's own `scriptTimers_`, never this one — the callback keeps firing / the entity leaks into `garbages` | Store the handle and call `KBEngine.delTimer(handle)` in `onDestroy` (entity-level `self.addTimer` is safe — destroy auto-cancels all) | [lifecycle §Timers](entity-lifecycle-reference.md), `python_app.cpp:721-748` |

## Property sync

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| FIXED_DICT sub-key assignment does not sync | `self.<FIXED_DICT property>[subKey] = value` only mutates the local `pyDict_`; the engine has no notification hook there, so the property never syncs | Whole-reassign idiom: `d = self.<prop>` → mutate sub-key → `self.<prop> = d` (only top-level assignment syncs) | [core-concepts §1.5](api-core-concepts.md), `fixeddict.cpp:272-308` |

## EntityCall semantics

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| Calling an engine method through an EntityCall | Not reachable — an EntityCall only invokes methods declared in the `.def` file | Declare the method in def, or use a local entity reference for engine APIs | [api-core-concepts §1.1](api-core-concepts.md) |

## Callback naming & face placement

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| Project-defined `onXxx` handlers mistaken for engine callbacks | ~1/3 of `def onXxx` definitions in real trees are project conventions, engine never calls them | Check the callback tables before assuming a name is engine-called | [usage stats](api-usage-stats.md), [entry SPI table](entry-script-spi-methods.md) |
| `onReadyForLogin` return-value semantics | Not "≥ 1.0 means ready" — `True` → ready; float completes at `>= 0.9999`; no callback → immediately complete | Return a `True`/float progress per the fork semantics | [api-cellapp §deviations](api-cellapp.md) |
| Expecting `onDestroy` on the embedded client | Never dispatched (empty C++ override, `callScript=false` on remote destroy) | Handle client-side cleanup elsewhere | [api-client §deviations](api-client.md) |

## Client-face API availability

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| `KBEngine.login/createAccount/...` as client Python functions | Not registered on any Python surface in `kbe/src` (plugin-layer, outside this repo) | Use the plugin SDK's functions, not the engine module | [api-client §deviations](api-client.md) |
| `KBEngine.findEntity(id)` | No such registration | `KBEngine.entities[entityID]` | [api-client §deviations](api-client.md) |

## Source-material hygiene

| Trap | Symptom | Correct pattern | Details |
| --- | --- | --- | --- |
| Copying examples from the 3.7 CHM | Python 2 syntax (`print "..."`) does not run on 3.12 | Rewrite snippets; treat material tables as leads, the fork source as truth | [api-cellapp §deviations](api-cellapp.md) |
