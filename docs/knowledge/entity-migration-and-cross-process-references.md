# Entity teleport, cross-cellapp migration & cross-process references

> KB-001 bucket ② follow-up to [entity-lifecycle-reference.md](entity-lifecycle-reference.md)
> (its marked TODO: the migration/teleport reference flow). Every claim cites
> `kbe/src` `file:line`, verified against the workspace engine commit
> (`kbengine@3082ab5`); no fabricated behavior.

## One entity, three addressable faces

A KBEngine entity can exist simultaneously on up to three processes: the
**base** object (baseapp), the **cell** object (cellapp, spatial state) and
the **client** object. Script code on one face cannot hold a Python reference
to the object on another face — it holds an **`EntityCall`**: a remote handle
carrying `(componentID, entity id, call type)`
(`kbe/src/lib/entitydef/entity_call.h:15`).

Call types (`kbe/src/lib/common/common.h:285-291`): `CELL`, `BASE`, `CLIENT`,
plus the routed variants `CELL_VIA_BASE`, `BASE_VIA_CELL`, `CLIENT_VIA_CELL`,
`CLIENT_VIA_BASE`. Attribute access on an EntityCall resolves against the
**face-relevant** method table and returns a `RemoteEntityMethod`
(`entity_call.cpp:82-123`); reading `.cell` / `.base` / `.client` on it
constructs a new via-EntityCall to that face (`entity_call.cpp:138-168`,
server-side always creates a new object at `:166`).

Consequences for references:

- An `EntityCall` addresses **a process + entity id**, not an object. It does
  not keep the target alive and carries no invalidation notification — if the
  target entity is destroyed, a remote call to it is a logged `ERROR_MSG`, not
  an assertion (already covered in the lifecycle article,
  `cellapp/entity.cpp:991`).
- `self.cell` on the base is the base's own `cellEntityCall_` member: created
  on first cell arrival (`baseapp/entity.cpp:1028`, `ENTITYCALL_TYPE_CELL`)
  and released on `onLoseCell` (`baseapp/entity.cpp:1059`).

## `cellData` is a snapshot, never a live object

The base-side `self.cellData` attribute is a plain dict installed by
`installCellDataAttr` (`baseapp/entity.cpp:217`, `PyObject_SetAttrString`
at `:227-230`). Its contents are **stale by design**:

- Initial fill (`createCellData`, `baseapp/entity.cpp:250`) writes **def-file
  defaults plus a zeroed `position`/`direction`** (`:299-314`) — explicitly
  not the live cell values.
- When the cell exists, the attribute is **deleted** (`onGetCell` calls
  `destroyCellData` at `baseapp/entity.cpp:1024`; `destroyCellData` at `:560`
  only removes the script-visible attribute — the comment at `:561-562` says
  the dict is retained internally for backup). Reading `self.cellData` while
  the cell is alive raises `AttributeError`.
- Refresh path: `reqBackupCellData` (`baseapp/entity.cpp:1093`) asks the cell
  to serialize its current data; the cell side computes a SHA-1 digest
  (`cellapp/entity.cpp:1153`) and only streams back when the persistent data
  changed (`backupCellData`, `cellapp/entity.cpp:1132`); on return the base
  re-installs the attribute only if the
  data was dirty (`onBackupCellData`, `baseapp/entity.cpp:1112-1124`).
- A script-notified cell destroy auto-backs-up before notifying the base
  (`cellapp/entity.cpp:216-221`: `backupCellData()` + `onLoseCell` bundle),
  which is why a base can still read the **last** `cellData` after losing the
  cell.

Correctness rule: `cellData` is meaningful only while the cell is absent
(or for DB archive). It is never a substitute for `self.cell.<...>` calls.

## Teleport: script entry and routing

`teleport` is a **cell-face** method: `pyTeleport`
(`cellapp/entity.cpp:3394`). Precondition guards raise AssertionError /
Exception to the script log: the entity must be **real** (`isReal()` assert
"not is real entity", `:3399` — a ghost cannot teleport), not destroyed,
in a live space, with `position`/`direction` as 3-item sequences
(`:3405-3435`).

The dispatcher (`Entity::teleport`, `cellapp/entity.cpp:3713`) routes by the
`nearbyMBRef` argument:

| Argument | Route |
| --- | --- |
| `None` | same-space jump: `teleportLocal` (`:3647`) |
| entity object (always same cellapp) | `teleportRefEntity` (`:3467`) |
| `cellEntityCall` resolving to a local entity | `teleportRefEntity` |
| `cellEntityCall` to another cellapp | `teleportRefEntityCall` (`:3538`) — the migration path |
| anything else | error + `onTeleportFailure` (`:3769-3772`) |

In-source behavior notes at `:3716-3730` (worth knowing as engine policy):

- Any teleport counts as an **instant move** (can cross spaces) even for a
  0.1 m hop: an entity inside a trap first fires the trap-leave callback,
  then re-enters and fires trap-enter again if it lands inside the same trap.
- Same-cellapp cross-space jumps execute immediately
  (`teleportRefEntity` → `teleportLocal`, `:3503`).

`teleportLocal` (`cellapp/entity.cpp:3647`): uninstalls the coordinate node,
sets position/direction, notifies **own witness and every other witness
viewing the entity** with `onSetEntityPosAndDir` (`:3660-3710`), re-adds the
node, then fires `onTeleportSuccess(nearbyEntity, lastSpaceID)` on the cell
(`:3801`; traps/proximity restored via `restoreProximitys()` at `:3810`).

## Cross-cellapp teleport: the full message flow

### 1. Source cell: become a ghost, don't die

`teleportRefEntityCall` (`cellapp/entity.cpp:3538`):

- Guard: entity already in transit (`ENTITY_FLAGS_TELEPORT_START`) reports
  `onTeleportFailure` (`:3540-3549`); the ref must be a **cell-real**
  EntityCall (`isCellReal()` check returns on failure, `:3551-3560`).
- If the entity has a base, the source sends `onMigrationCellappStart(id,
  source, target)` to the baseapp (`:3584-3593`) so the base **buffers** its
  cell-bound messages during the switch (order safety; the comment at
  `:3563-3569` explains the ghost-forwarding design).
- `changeToGhost(realCell, stream)` (`cellapp/entity.cpp:3964`): asserts
  `isReal()` (`:3971`); sets `realCell_` (realness is exactly `realCell_ == 0`,
  `cellapp/entity.inl:131`); registers a GhostManager route so messages that
  still arrive at the ghost **forward to the real** (`:3976-3980`); serializes
  def data + movement + controllers + witness + timers + events + pending
  callbacks (`addToStream`, `:3989`); then **stops** everything local —
  controllers released (`:3994-3998`), witness cleared (`:4000-4004`), all
  script timers cancelled (`:4006`), callback manager finalized (`:4007`).
- The serialized bundle goes to the target as `reqTeleportToCellApp`
  (`onTeleportRefEntityCall`, `cellapp/entity.cpp:3603-3645`). The source
  entity is **not destroyed yet** (comment `:3638-3641`): it stays alive as a
  ghost to forward base traffic and to allow restore on failure; `stopMove()`
  freezes movement (`:3643`).

### 2. Baseapp: buffer, then retarget

- `onMigrationCellappStart` (`baseapp/entity.cpp:1571`): the base buffers
  cell-bound messages in `EntityMessagesForwardCellappHandler`
  (`baseapp/entity_messages_forward_handler.h:20`). Safety valves: buffered
  > 8192 messages force the buffer open early (`...handler.cpp:57-62`), a
  5 s wait timeout forces it too (`:80`), and the drain loop replays at most
  `PACKET_MAX_SIZE_TCP * 10` bytes per tick to keep the channel fair
  (`:108-137`).
- `onMigrationCellappEnd` (`baseapp/entity.cpp:1593`, sent by the **new**
  cellapp when the entity is rebuilt): if Start was seen, clear the flag and
  finish; if End raced ahead of Start, set `ENTITY_FLAGS_TELEPORT_STOP` and
  buffer **client-bound** messages instead (`BaseMessagesForwardClientHandler`,
  `entity_messages_forward_handler.h:35`) until Start arrives.
- `onMigrationCellappOver` (`baseapp/entity.cpp:1622`): tells the old cellapp
  `reqTeleportToCellAppOver` and — the key line — **retargets the base's own
  `cellEntityCall_` in place**: `cellEntityCall()->componentID(targetCellAppID)`
  (`:1635`). From this instant `self.cell` addresses the new cellapp. The
  buffered cell-bound messages then replay to the new component
  (`onBufferedForwardToClientMessagesOver`, `:1645`).

### 3. Target cell: rebuild, then confirm

`Cellapp::reqTeleportToCellApp` (`cellapp/cellapp.cpp:1880`): validates the
reference entity, the space and the module (`:1904-1969`); creates the entity
**with the same entity id** and restores it from the stream (`:1971-1997`; a
deserialization failure aborts the teleport and replies failure, `:1982-2009`);
stops the serialized movement controllers (`:2016-2019`); clears any ghost
relation — a teleported-in entity has no ghost part (`ghostCell(0)`,
`:2023`); if it has a base, sets `ENTITY_FLAGS_TELEPORT_START` and notifies
the baseapp `onMigrationCellappEnd` (`:2026-2040`); notifies the client
`onEntityLeaveSpace` (`:2043-2051`); enters the world (`:2055`); fires cell
`onTeleportSuccess` (`:2058`); replies `reqTeleportToCellAppCB(success)`
(`:2060-2064`).

### 4. Completion: destroy old, or restore old

`Cellapp::reqTeleportToCellAppCB` (`cellapp/cellapp.cpp:2075`):

- **Success**: the old (ghost) entity is destroyed with `callScript=false`
  (`:2092-2095`) — no `onDestroy` fires on the old cell, exactly why the
  lifecycle article's `onDestroy` is gated on `callScript && isReal()`
  (`cellapp/entity.cpp:206`).
- **Failure**: the baseapp is told `onMigrationCellappEnd(source, source)`
  (`:2098-2118`) so it aborts the migration and replays its buffered messages
  back to the **old** cellapp; the old entity is found and
  `changeToReal(0, stream)` (`cellapp/cellapp.cpp:2143`, implementation
  `cellapp/entity.cpp:4010`) restores it from the serialized copy (def data,
  controllers, witness, timers, callbacks all come back via `createFromStream`);
  then cell `onTeleportFailure()` fires (`cellapp/cellapp.cpp:2163`). If the
  entity meanwhile vanished (e.g. its space was destroyed), only an
  `ERROR_MSG` is logged (`:2133-2140`).
- `reqTeleportToCellAppOver` (`cellapp/cellapp.cpp:2171`) clears the new
  entity's in-transit flag, completing the sequence.

## Which script callbacks actually fire

At this commit (`kbengine@3082ab5`):

- Cell face: `onTeleportSuccess(nearbyEntity)` (`cellapp/entity.cpp:3801`,
  buffered through `bufferOrExeCallback` so it defers during init/ghost) and
  `onTeleportFailure()` (`:3790`). On success the base is notified with
  `fromCellTeleport=true` (`_sendBaseTeleportResult`, `:3381`, only sender at
  `:3806`), so the base **silently updates its `spaceID`** —
  `baseapp/entity.cpp:1543-1546` only invokes base script callbacks when
  `fromCellTeleport` is false, which no sender passes at HEAD.
- Base face: `onTeleportSuccess` / `onTeleportFailure` script callbacks exist
  (`baseapp/entity.cpp:1562` / `:1555`) but are **not fired for teleport** at
  this commit (dead path pending a `fromCellTeleport=false` sender).
- Cell `onTeleport()` (`cellapp/entity.cpp:3781`) has **no callers** at HEAD —
  its comment references a `base.teleport` flow this fork does not expose.

## Reference semantics across a migration (the practical rules)

1. **Same-cellapp direct references** (another cell script holding the entity
   object): after a successful cross-cellapp teleport the old object is
   destroyed (`callScript=false`), so held references become
   destroyed-object references — subject to the lifecycle article's guards
   (method calls raise AssertionError; `isDestroyed` is `true`).
2. **`self.cell` on the migrating entity's base**: the one shared
   `cellEntityCall_` instance is retargeted in place
   (`baseapp/entity.cpp:1635`), so code that reads `self.cell` *after* the
   switch addresses the new cellapp. A Python reference captured earlier
   (e.g. `c = self.cell`) is the **same object** and therefore also sees the
   retarget — but references built through other paths (e.g. another entity's
   `otherBase.cell` describing this entity) are separate EntityCall objects
   carrying the old `componentID` and are **not** updated; the engine sends
   them to the old cellapp, where the entity no longer exists — the delivery
   layer logs `WARNING_MSG "entityID ... not found"` and drops the message
   (`Cellapp::onEntityCall`, `cellapp/cellapp.cpp:1331`), no exception at the
   caller.
3. **cellData readers on the base**: unaffected by teleport itself (the
   attribute is absent while the cell lives); the backup refresh path
   (`reqBackupCellData`) re-syncs it on the next dirty backup.
4. **During the in-flight window** the old entity exists as a ghost with
   controllers/timers stopped — calls routed to it are forwarded to the real
   (`Cellapp::onEntityCall`: `if(!entity->isReal())` → GhostManager push to
   `realCell()`, `cellapp/cellapp.cpp:1341-1352`; route registered at
   `cellapp/entity.cpp:3976-3980`); the engine relies on this forwarding
   instead of blocking the base, so no message is lost or reordered between
   the buffered replay and the new target (comment `:3563-3569`).

## Traps checklist (feeds the bucket ④ index)

- Ghost entities cannot `teleport` (`isReal()` assert,
  `cellapp/entity.cpp:3399`).
- Teleport is always an *instant move*: trap leave/re-enter callbacks both
  fire on a micro-jump that stays inside a trap (`:3716-3720`).
- `teleport` with a wrong-typed ref (e.g. a base EntityCall) fails loudly
  with `onTeleportFailure` — the ref must be a **cell-real** EntityCall
  (`:3551-3560`).
- Cross-cellapp failure restores the entity on the **old** cell and fires
  `onTeleportFailure` there; success destroys it silently (`callScript=false`)
  and fires `onTeleportSuccess` on the **new** cell — game logic must not
  assume the old object's `onDestroy` runs (`cellapp/cellapp.cpp:2087-2091`).
- `self.cellData` is deleted while the cell lives: reading it raises
  `AttributeError` (`baseapp/entity.cpp:1024`); its values are defaults or
  the last dirty backup, never live (`:250`, `:1112-1124`).
- The engine never invalidates separately-held EntityCall copies on
  migration (`baseapp/entity.cpp:1635` retargets only the base's own call) —
  stale copies address a process where the entity no longer exists.
