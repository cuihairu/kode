# Baseapp face API reference — `Entity` and `Proxy`

> KB-API-003 (P0) · part 2 of 2. Source material: kbengine fork
> `docs/api/kbengine/baseapp/{Entity.md,Proxy.md,KBEngine.md,index.md}`
> (CHM conversion; rewritten, not copied). Grounding domain is `kbe/src` at
> `/home/cui/workspaces/kbengine`, HEAD `6d12b8f` (verified at HEAD on
> 2026-11-04); every claim carries a `file:line` anchor or an explicit
> **待取证 / to be evidenced** marker. Deviation-annotation format follows
> [python-version-baseline](python-version-baseline.md) §7.
>
> **Split note (per todo KB-API-003):** the module face lives in
> [api-baseapp](api-baseapp.md); this page covers the two entity classes the
> baseapp process exposes: `Entity` (the base entity) and `Proxy` (its
> client-attached subclass). `Proxy` cannot be instantiated from script — it
> is created by the engine when loginapp/dbmgr hand a client over
> (`kbe/src/server/baseapp/proxy.cpp:43-59`: the constructor increments the
> process proxy count (`:56`) and builds its forwarder (`:58`)).

## 1. Where the two class faces are registered

| Class | Method table | Getset table |
| --- | --- | --- |
| `Entity` | `kbe/src/server/baseapp/entity.cpp:26-30` (`createCellEntity`, `createCellEntityInNewSpace`, `destroyCellEntity`) **plus** the shared base block `kbe/src/lib/entitydef/entity_macro.h:17-24` (`addTimer`, `delTimer`, `writeToDB`, `destroy`, `registerEvent`, `deregisterEvent`, `fireEvent`, `getComponent`) | `entity.cpp:35-41` (`cell`, `client`, `databaseID`, `databaseInterfaceName`, `shouldAutoBackup`, `shouldAutoArchive`) plus `entity_macro.h:33-35` (`id`, `isDestroyed`, `className`) |
| `Proxy` | `kbe/src/server/baseapp/proxy.cpp:21-28` (`giveClientTo`, `getClientType`, `getClientDatas`, `streamStringToClient`, `streamFileToClient`, `disconnect`) | `proxy.cpp:33-39` (`roundTripTime`, `timeSinceHeardFromClient`, `clientAddr`, `hasClient`, `clientEnabled`) |

Both types are installed by `Baseapp::installPyModules`
(`baseapp.cpp:408-409` call `Entity::installScript()` / `Proxy::installScript()`;
`registerScript` at `:414-415`).

## 2. `Entity` — timers

### `entity.addTimer(initialOffset, repeatOffset=0, userArg=0) -> int`

Registers a timer: first fire after `initialOffset` seconds, then every
`repeatOffset` seconds (repeat `<= 0` means fire once). Each fire invokes
`entity.onTimer(timerID, userArg)`; `userArg` must be an int. Returns the
timer id for `delTimer`. Shared impl: `entity_macro.h:1387`
(`CLASS::pyAddTimer` → `ScriptTimersUtil::addTimer`, `:1391`).

### `entity.delTimer(id)`

Removes a timer ("All" string removes all). Single-shot timers self-remove —
delTimer on an already-removed id raises. `entity_macro.h:18`,
impl `:1407`; invalid id path `:1478`
(`ScriptTimersUtil::delTimer` returns false → error).

### `entity.onTimer(timerHandle, userData)` *(callback)*

Timer callback; must be defined on the base part. Raised from
`Entity::onTimer` (`kbe/src/server/baseapp/entity.cpp:1658-1662`).

## 3. `Entity` — cell management

### `entity.createCellEntity(cellEntityCall)`

Asks cellapp to create this entity's cell part in the space of
`cellEntityCall` (must be a **direct** cell EntityCall — you cannot pass
`someBaseRef.cell` across a base ref; route it through a base method that
carries the direct call). Creation info comes from `cellData` (`.def`
defaults + `position/direction/spaceID`). Impl
`entity.cpp:1416`; type checks `:1435-1439` (arg must be a direct
`ENTITYCALL_TYPE_CELL` call) → `Baseapp::createCellEntity`
(`:1464`). Failure raises `onCreateCellFailure`.

### `entity.createCellEntityInNewSpace(cellappIndex=None)`

Creates a brand-new space (via cellappmgr) and puts this entity's cell into
it. `cellappIndex=None/0` → engine load balancer picks the cellapp; `>0`
targets cellapp index N (overflowing indices wrap: with 3 running cellapps,
index 4 → cellapp 1). Works well combined with
`KBEngine.APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING` to pin large maps.
`entity.cpp:28` (table), impl `:1487-1508` →
`Baseapp::createCellEntityInNewSpace` (`:1507`).

### `entity.destroyCellEntity()`

Requests destruction of the cell part; errors when there is no cell.
Table `entity.cpp:29`, entry `entity.cpp:593` (`pyDestroyCellEntity`),
cellapp message `:586`
(`CellappInterface::onDestroyCellEntityFromBaseapp`).

### `entity.cell` *(read-only attr)*

`EntityCall` to the cell part, `None` until a cell exists. Getter
`entity.cpp:750` (`pyGetCellEntityCall`), table `:36`.

### `entity.cellData` *(dict attr)*

Holds the cell properties while no cell exists (`.def` defaults plus
`position`, `direction`, `spaceID`); the dict is consumed (deleted) when the
cell entity is created. Installed as a real instance attribute via
`PyObject_SetAttrString(this, "cellData", ...)` —
`entity.cpp:238-241` (`installCellDataAttr`), dict lifecycle `:221-236`.

## 4. `Entity` — destruction and persistence

### `entity.destroy(deleteFromDB=False, writeToDB=True)`

Destroys the base part. If a cell part exists it must be destroyed first
(`destroyCellEntity`); destroying while the cell is still being created is
deferred until `onGetCell` (`entity.cpp:641` warning). `deleteFromDB=True`
removes the DB record; `writeToDB=True` (default) archives before teardown,
ignored when `deleteFromDB` is True. Keyword or positional args accepted
(`METH_VARARGS | METH_KEYWORDS`, `entity_macro.h:20`; parse
`entity.cpp:663-676`; teardown `Entity::onDestroyEntity`
`entity.cpp:698-731`). Object-reference semantics after destroy (garbages,
strong refs) are covered once in
[entity-lifecycle-reference](entity-lifecycle-reference.md).

### `entity.onDestroy()` *(callback)*

Fired after the base part is actually destroyed.
`entity.cpp:164-169`.

### `entity.writeToDB(callback=None, shouldAutoLoad=False, dbInterfaceName="default")`

Archives the entity to the database. `callback(success, baseEntity)` fires
when the dbmgr write completes (`onWriteToDBCallback`,
`entity.cpp:1239-1290`). `shouldAutoLoad=True` marks the record for auto-load
at server start (then `onAutoLoadEntityCreate` /
`createEntityAnywhereFromDBID` runs — see
[api-baseapp](api-baseapp.md) §8). Core write path `Entity::writeToDB`
`entity.cpp:1141-1185`; script entry `entity_macro.h:19,832`.

### `entity.onPreArchive() -> bool` *(callback)*

Called before an archive write; returning False aborts this write, True (or
absence of the callback) proceeds. Invoked inside
`Entity::onCellWriteToDBCompleted` before the write —
`entity.cpp:1294-1305`.

### `entity.onWriteToDB(cellData)` *(callback)*

Fires when entity data is about to be written to the database; `cellData` is
the dict that will be stored. Calling `writeToDB` inside it loops forever.
`entity.cpp:1397-1405`.

### `entity.databaseID` *(read-only, uint64)*

Permanent id; 0 means never archived. Getter `entity.cpp:769` (`pyGetDBID`).

### `entity.databaseInterfaceName` *(read-only, str)*

Name of the dbmgr interface this entity persists through; empty string when
`databaseID == 0`. Getter `entity.cpp:783`, table `:38`.

### `entity.shouldAutoArchive` / `entity.shouldAutoBackup` *(get/set)*

Auto-archive / auto-backup strategy: `True`, `False`, or
`KBEngine.NEXT_ONLY` (one scheduled pass, then flips to False). The archiver
periodically sweeps entities using these flags — `kbe/src/server/baseapp/archiver.cpp`
(sweep timer; flag handling `entity.cpp:842-899` getters/setters, table
`entity.cpp:40-41`).

## 5. `Entity` — identity and restore

### `entity.id` *(read-only, int32)* — `entity.className` *(read-only, str)* — `entity.isDestroyed` *(bool)*

Shared entity id (same across base/cell/client views), class name, and
destroyed flag. From the shared macro:
`entity_macro.h:33-35` (table), getters `:689` (`pyGetID`), `:1491`
(`pyGetIsDestroyed`), `:1496` (`pyGetClassName`).

### `entity.onRestore()` *(callback)*

Called when this entity is recreated on another baseapp after the original
baseapp crashed (backup/restore flow; handlers in
`kbe/src/server/baseapp/restore_entity_handler.cpp`).
`entity.cpp:1077-1083`.

### `entity.onGetCell()` / `entity.onLoseCell()` *(callbacks)*

Cell part attached (`onGetCell`, `entity.cpp:1014-1032`; auto-destroy
fallback `:1037`) / cell part detached (`onLoseCell`,
`entity.cpp:1052-1065`; auto-destroy fallback `:1069`). The source
material's advice stands: a `self.destroy()` in `onLoseCell` is the reliable
place to tear down the base part.

### `entity.onCreateCellFailure()` *(callback)*

Cell creation request failed. `entity.cpp:877-884`.

### `entity.client` *(read-only attr)*

`EntityCall` to the attached client, `None` when no client is bound. On the
base `Entity` this getter exists (`entity.cpp:800`, table `:37`) but is only
populated for `Proxy`-carried clients (see §7).

## 6. `Entity` — event bus and components

### `entity.fireEvent(eventName, *args)` / `entity.registerEvent(eventName, callback)` / `entity.deregisterEvent(eventName, callback)`

Per-entity event dispatch (engine events like `onCreateCellFailure`-style
notifications and user events). `entity_macro.h:21-23` (table), impls
`:1126` (`pyRegisterEvent`), `:1162` (`pyDeregisterEvent`), `:1198`
(`pyFireEvent`).

### `entity.getComponent(componentName, all=False)`

Returns attached component instance(s) of the given type; `all=True` returns
every instance, otherwise the first (or an empty result).
`entity_macro.h:24,1276-1355` (`pyGetComponent`; `all` parsed from a bool kwarg
`:1354`).

## 7. `Proxy` — the client-facing subclass

`Proxy` extends `Entity` (`proxy.cpp:43-45`) and is the server-side anchor of
a client connection: loginapp/dbmgr create it on the target baseapp, and all
server→client traffic flows through its forwarder
(`proxy.cpp:56-58`, `kbe/src/server/baseapp/proxy_forwarder.h`).

### `proxy.giveClientTo(otherProxy)`

Transfers client control to another Proxy on the same baseapp. Preconditions
enforced at `proxy.cpp:311-380`: current proxy alive and has a client
(`:328-331`), target alive (`:342-347`), not self (`:354-359`), target has no
client (`:366-373`); any violation raises `onGiveClientToFailure` instead of
an exception. Script entry `:274-299` (`pyGiveClientTo`, type-check error
`:287`); table `:22`. This is the canonical reason to need a direct entity
reference rather than an `EntityCall`.

### `proxy.onGiveClientToFailure()` *(callback)*

`proxy.cpp:304-307`.

### `proxy.onClientEnabled()` *(callback)*

The entity is fully usable and can talk to the client; also fired after
`giveClientTo` hands control over. `proxy.cpp:174-178`.

### `proxy.onClientDeath()` *(callback)*

Client disconnected; typically destroy the proxy account entity here.
`proxy.cpp:217-237`.

### `proxy.onClientGetCell()` *(callback)*

Fires when the client gains access to the entity's `cell` attribute.
`proxy.cpp:241-248`.

### `proxy.onLogOnAttempt(ip, port, password) -> int` *(callback)*

A second client is trying to bind to this (already live) account entity —
the classic double-login. Return `KBEngine.LOG_ON_ACCEPT` (kick the old
client, bind the new), `LOG_ON_REJECT` (keep current binding), or
`LOG_ON_WAIT_FOR_DESTROY` (queue the new login until this entity is
destroyed — call `destroy`/`destroyCellEntity` from the callback first).
Engine: `proxy.cpp:182-205` (script call `:189`), decision interpreted in
`baseapp.cpp:3919-3962` (`LOG_ON_ACCEPT` kick `:3926-3933`,
wait-for-destroy `:3960`). Note the header-level constants are
`0/1/2` (`proxy.h:24-26`) and are re-exported to the module at
`baseapp.cpp:463-476`.

### `proxy.disconnect()`

Disconnects the bound client: condemns the client channel.
`proxy.cpp:70-78` (`pyDisconnect`), table `:27`.

### `proxy.getClientType() -> int`

Client type enum: 0 unknown, 1 mobile, 2 Windows, 3 Linux, 4 Mac, 5 browser,
6 bots, 7 mini, 8 end. `proxy.cpp:252`; set from login metadata
(`pEntity->setClientType(...)`, `baseapp.cpp:4165`).

### `proxy.getClientDatas() -> (bytes, bytes)`

The opaque bytes the client attached to **login** and to **register**
(passed through the interfaces process for third-party account systems).
`proxy.cpp:258`; populated at account creation
(`setLoginDatas/setCreateDatas`, `baseapp.cpp:4166-4167`).

### `proxy.streamStringToClient(data, desc="", id=-1) -> id` / `proxy.streamFileToClient(resourceName, desc="", id=-1) -> id`

Push a string / a resource file to the bound client on worker threads (main
thread not blocked). `id` is caller-chosen 16-bit, `-1` → engine allocates;
completion raises `onStreamComplete(id, success)`. Table `:25-26`; impls
`:649` (string), `:560` (file); download queue in
`kbe/src/server/baseapp/data_downloads.h`; completion `proxy.cpp:829-832`.

### `proxy.onStreamComplete(id, success)` *(callback)*

`proxy.cpp:829-832`.

### Proxy attributes (`proxy.cpp:33-39`)

| Attr | Meaning | Getter |
| --- | --- | --- |
| `clientAddr` | `(ip, port)` tuple of the bound client | `proxy.cpp:512` |
| `hasClient` | A client is currently bound | `proxy.cpp:493` |
| `clientEnabled` | `onClientEnabled` has fired; scripts may talk to the client | `proxy.cpp:541` |
| `roundTripTime` | Average RTT to the client over a window | `proxy.cpp:445` (source material's "Linux-only" claim **待取证** — no preprocessor guard seen at the getter) |
| `timeSinceHeardFromClient` | Seconds since last client packet | `proxy.cpp:469` |

### `__ACCOUNT_NAME__` / `__ACCOUNT_PASSWORD__`

The 3.7 source material presents these as Proxy read-only attributes. At
fork HEAD they are **not** Proxy getsets: they are injected as dict entries
into the account entity's initialization data at login
(`baseapp.cpp:4174-4178` — MD5 digest of the supplied password for
`__ACCOUNT_PASSWORD__`), so script code reads them as entity dict members of
the account entity, mirroring `lib/entitydef/common.h:142-143`. See
deviation table.

## 3.7 source material vs fork 3.12 deviations

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `Proxy.__ACCOUNT_NAME__` / `__ACCOUNT_PASSWORD__` | Read-only Proxy attributes | Not Proxy getsets; injected into the account entity's init dict at login (`__ACCOUNT_PASSWORD__` is the MD5 digest) | Fork | `baseapp.cpp:4174-4178`; `proxy.cpp:33-39` (getset table lacks both); `lib/entitydef/common.h:142-143` |
| `onLogOnAttempt` constants | Docs describe module constants only | Constants are both module-level (`LOG_ON_*` ints 1/0/2) and header macros; script return value is switch-dispatched in `loginBaseapp` | Fork | `proxy.h:24-26`; `baseapp.cpp:463-476,3919-3962` |
| `Entity.destroy` when cell alive | "generate an error" | Destroy during cell creation is **deferred** with a warning until `onGetCell`, not an immediate error | Fork | `entity.cpp:641` (warning), `:598-691` |
| `roundTripTime` platform claim | "only takes effect under Linux" | Unverified at HEAD — getter shows no platform guard | — | **待取证**: audit `proxy.cpp:445-468` and its feed path |
| `writeToDB` auto-load default creator | Engine default `createEntityAnywhereFromDBID` | Confirmed same behavior at HEAD; script override via `onAutoLoadEntityCreate` | Fork | `entity_autoloader.cpp:90-97` |
| 3.7→3.12 script-layer deltas for this face | — | This face is signature/kwargs plumbing (`METH_VARARGS|METH_KEYWORDS`); no 3.8–3.12 str/bytes/int semantic exposure; python-version-baseline §4 verified items apply by reference | Python | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html); see python-version-baseline §4 |

## References

- `kbe/src/server/baseapp/{entity.cpp, entity.h, proxy.cpp, proxy.h,
  proxy.inl, archiver.cpp, data_downloads.h, restore_entity_handler.cpp,
  baseapp.cpp:413-416,4163-4178,3919-3962}`
- `kbe/src/lib/entitydef/entity_macro.h:17-35,689,832,1035,1126-1198,
  1276-1355,1387-1478,1491-1496`
- `kbe/src/lib/entitydef/common.h:142-143`
- Python domain: [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)
- Companion pages: [api-baseapp](api-baseapp.md),
  [entity-lifecycle-reference](entity-lifecycle-reference.md),
  [python-version-baseline](python-version-baseline.md)
