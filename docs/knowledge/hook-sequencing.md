# Entity callback sequencing map

The machine-readable core of this map is `src/backend/hookSequencing.ts`
(`HOOK_SEQUENCING`, one entry per callback in `src/hooks.ts` plus the
corroborated-but-unregistered `onLoseCell`). Every engine `file:line` below is
carried over verbatim from `src/hooks.ts` `sourceLocation` or from anchors
already fixed in [Entity lifecycle & reference release](entity-lifecycle-reference.md),
[Baseapp face API reference](api-baseapp.md) §2, and
[Shared concepts](api-core-concepts.md) §3. No new anchors are minted here.

The hover surface (hook hovers, `self.<def-property>` hovers) renders the same
data as a compact timing section; this page is the full picture.

## Creation and def-property injection (phase: creation)

```
createEntity* / createEntityLocally        api-baseapp.md §2
  → def properties injected                params dict keys override .def defaults;
  → cellData populated                     cell-property keys routed into cellData,
                                            effective only when the cell is created
    (unspecified keys keep .def defaults)
```

`def` properties exist **before any script logic runs** — the engine injects
`.def` defaults and `params` overrides at entity construction. Cell-part values
wait in `cellData` (`api-core-concepts.md` §3, "cellData keeps the would-be cell
attributes").

## Cell attach chain (phase: cell-attach)

```
base side (baseapp/entity.cpp, entity-lifecycle-reference.md Cell state table):
  createCellEntity / createCellEntityInNewSpace / restoreCell (async request)
    ├── onGetCell              :1032  — cell landed; cellData attribute deleted (:1024)
    │     ├── onLoseCell       :1059,1065 — cell released (S_RELEASE), base alive;
    │     │     cellData never comes back (stays deleted)
    │     └── onClientGetCell  proxy.cpp:248 — client about to be handed to the cell
    └── onCreateCellFailure    :884   — branch end, no cell

cell side (cellapp/entity.cpp):
  onEnteringCell :3847 → onEnteredCell :3839     (enter: before → after)
  onLeavingCell  :3855 → onLeftCell   :3863     (leave: before → after)
```

## Space (phase: space)

```
onEnterSpace  cellapp/entity.cpp:3823   after the cell entity enters a space
onLeaveSpace  cellapp/entity.cpp:3831   before leaving
onSpaceGone   cellapp/entity.cpp:387    the space itself is destroyed
                                      (different source than onLeaveSpace)
```

## Witness / view (phase: witness-view)

```
onGetWitness :2180 → onUpdateBegin ⇄ onUpdateEnd (per sync round) → onLoseWitness :2218
                     witness.cpp:753 / :899
onWitnessed      :1486,1531   isWitnessed flips
onEnteredView    :1786        entity enters a witness's view
onLoseControlledBy :1513      controlledBy binding released
```

## Movement and teleport (phases: movement, teleport)

```
onMove :2946 → onMoveOver :2964 | onMoveFailure :2982    (branch ends)
onTurn :3098

onTeleport :3786 → onTeleportSuccess :3814 | onTeleportFailure :1558/3797
                    ↑ target space/position already in place; cellapp side
                      receives nearby entities (may be None), baseapp side
                      fires parameterless at flow end
```

## Traps (phase: trap)

```
onEnterTrap :1759 → onLeaveTrap :1768 | onLeaveTrapID :1777
                     (left entity still usable | entity gone, ID only)
```

## Persistence (phase: persistence)

```
restore (baseapp crash recovery):
  restore_cell到达 → onRestore :1083 (cellapp side :3871)

archive cycle:
  onPreArchive :1298 → onWriteToDB :1405 (base) / :1262 (cell)
```

## Client link, timers, destruction (phases: client-link, cross-cutting, destruction)

```
onClientEnabled proxy.cpp:178
onClientDeath   entity.cpp:1048 / proxy.cpp:237 → onLogOnAttempt proxy.cpp:189,205
onStreamComplete proxy.cpp:832

onTimer   cellapp:4358 / baseapp:1662   any phase; addTimer holds no strong
                                        reference, all cancelled on destroy
onDestroy baseapp:169 / cellapp:211     before teardown, both sides
```

## Entry-script SPI (kbemain, module-level)

Covered separately in [Entry script SPI methods](entry-script-spi-methods.md)
(seven phases P0..P7). The cellapp space/navigation chain:
`onSpaceGeometryLoaded → onAllSpaceGeometryLoaded`; `onSpaceData` fires
independently on set/del.

Next: [Entity lifecycle & reference release](entity-lifecycle-reference.md) ·
[Shared concepts](api-core-concepts.md)
