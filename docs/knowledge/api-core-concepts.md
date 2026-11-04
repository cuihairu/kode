# API Core Concepts: A Cross-Cutting Map

> Scope: concepts that recur across the KBEngine API pages (`docs/api/kbengine/`), organized as **shared concepts → per-app differences → lifecycle overview**. This is a concept map, not a function catalog: every API mentioned here is documented in detail on its own page; this article only explains what recurs, what differs, and how the pieces fit.
>
> Grounding: `docs/api/kbengine/` at HEAD `6d12b8f`. Provenance of those pages: `docs/api/kbengine/kbengine_api(cn).chm` / `kbengine_api(en).chm` (see API overview). Chinese mirror: [/zh/knowledge/api-core-concepts](/zh/knowledge/api-core-concepts).

## 1. Concepts shared across apps

### 1.1 One entity, several parts

The single most load-bearing idea in the API docs: one script-level `Entity` exists simultaneously in up to three process "parts" — client, base, cell (keywords: `docs/api/kbengine/keywords.md:19-26`). The parts talk to each other through `EntityCall`, which is deliberately minimal: entity ID + destination address + entity type + call type, checked against the entity's `.def` description before packing (`keywords.md:5-18`).

Consequences that hold on every app:

- `id` is the same integer on the base, cell, and client sides of the same entity (`baseapp/Entity.md:423-431`, `cellapp/Entity.md:1075-1083`, `client/Entity.md:35`).
- `base`, `cell`, `client` are read-only `EntityCall` attributes, `None` when the part does not exist (base side: `baseapp/Entity.md:346-384`; cell side: `cellapp/Entity.md:963-1163` for the client broadcast family).
- An `EntityCall` can only invoke methods declared in the `.def` file — never engine methods, never properties (`keywords.md:16-18`).
- The client side has no `base`/`cell` attributes at all; it reaches the server through `baseCall`/`cellCall` by method name (`client/Entity.md:61-104`).

### 1.2 The entity event system

`registerEvent` / `fireEvent` / `deregisterEvent` appear verbatim on all four `Entity` pages — baseapp (`baseapp/Entity.md:229-265`), cellapp (`cellapp/Entity.md:691-727`), client (`client/Entity.md:140-176`), bots (`bots/Entity.md:133-169`). Semantics: same-process, same-named events; this is a per-process pub/sub, **not** a remote-call mechanism (remote calls are EntityCall). `getComponent` likewise exists on all four sides.

### 1.3 Timers, in three flavors

- **Entity-level timers** on baseapp and cellapp `Entity`: `addTimer`/`delTimer` → `onTimer(timerHandle, userData)` (`baseapp/Entity.md:66-171,319-332`, `cellapp/Entity.md:205-348,911-924`).
- **Module-level timers** on the thin processes: `addTimer(initialOffset, repeatOffset, callbackObj)` takes a callback object instead of an entity method — loginapp (`loginapp/KBEngine.md:25-80`), dbmgr (`dbmgr/KBEngine.md:24-79`), interfaces (`interfaces/KBEngine.md:28-129`), logger (`logger/KBEngine.md:24-78`).
- **Script callbacks** on bots: `callback`/`cancelCallback` (`bots/KBEngine.md:63-112`) — same offset/repeat idea, detached from any entity.

### 1.4 The data dictionaries

Four scoped key/value stores, each with a `get`/`set`/`del` plus a pushed callback on change:

| Dictionary | Where it lives | Script surface |
| --- | --- | --- |
| `globalData` | all server apps | `onGlobalData`/`onGlobalDataDel` (`baseapp/KBEngine.md:866-892`, `cellapp/KBEngine.md:712-738`); dict attribute `globalData` (`baseapp/KBEngine.md:1139`, `cellapp/KBEngine.md:949`) |
| `cellAppData` | cellapp group | `onCellAppData`/`onCellAppDataDel` (`cellapp/KBEngine.md:684-711`); attribute `cellAppData` (`cellapp/KBEngine.md:863`) |
| `baseAppData` | baseapp group | `onBaseAppData`/`onBaseAppDataDel` (`baseapp/KBEngine.md:839-865`); attribute `baseAppData` (`baseapp/KBEngine.md:1088`) |
| `spaceData` | one space | `setSpaceData`/`getSpaceData`/`delSpaceData` + `onSpaceData` (`cellapp/KBEngine.md:228-372,753-767`); clients and bots only read: `client/KBEngine.md:144-160`, `bots/PyClientApp.md:35-49` |

### 1.5 The four data categories

The API docs split an entity's data by *where it is authoritative*:

1. **Property sync (cell → client).** Properties flagged `*_CLIENT*` in the server-side `.def` are broadcast to client entities; on change the client-side `set_<property>` is invoked (`client/Entity.md:51-55`). The docs deliberately do not enumerate the flag values here — that lives in the entitydef documentation they link out to (`keywords.md:109`, `client/Entity.md:55`).
2. **Cell data (position-adjacent).** `position`, `direction`, `volatileInfo` sync policy, `topSpeed`/`topSpeedY` legality checks, view/witness state — all cellapp `Entity` attributes (`cellapp/Entity.md:1046-1050,1157-1184,1195-1230,1231-1265`). Volatile data has its own optimization policy, configurable per-entity in `.def` `<Volatile>` (`cellapp/Entity.md:1231-1265`).
3. **Base data (baseapp-resident).** `cellData` holds the cell part's attributes before the cell exists (plus position/direction/spaceID), and is dropped once the cell is created (`baseapp/Entity.md:359-369`). Archiving/backup strategy attributes `shouldAutoArchive`/`shouldAutoBackup` (with `KBEngine.NEXT_ONLY`) are base-side (`baseapp/Entity.md:446-474`).
4. **DB data (persisted).** `databaseID` (0 = not permanent), `databaseInterfaceName`, `writeToDB`, `onPreArchive`, `onWriteToDB`, `shouldAutoLoad` — the base side owns the persistence loop (`baseapp/Entity.md:397-409,412-421,199-215,299-309,333-343`); cellapp can also trigger a write (`cellapp/Entity.md:649-666,955-960`).

### 1.6 Basic types: a bare table, knowingly bare

`basetypes.md:3-30` is a name + byte-width table (fixed 1–20 bytes; `STRING`/`UNICODE`/`PYTHON`/`PY_DICT`/`PY_TUPLE`/`PY_LIST`/`ENTITYCALL`/`BLOB` variable). It carries no defaults, ranges, or serialization semantics — the audit checklist flags exactly this gap (`audit-checklist.md:48-50`). Treat it as the wire-type vocabulary shared by `.def` files and the script bridge, not as a semantics reference.

### 1.7 Shared utility surface

Present (near-)verbatim on both server apps unless noted: resource IO `open`/`hasRes`/`getResFullPath`/`listPathRes`/`matchPath`; file-descriptor hooks `registerReadFileDescriptor`/`registerWriteFileDescriptor`; `urlopen`; `genUUID64`; `executeRawDatabaseCommand`; watcher introspection `addWatcher`/`getWatcher`/`getWatcherDir`/`delWatcher`; `time`, `publish`, `getAppFlags`/`setAppFlags`, `scriptLogType`, `reloadScript`, `MemoryStream`, `address` (`baseapp/KBEngine.md:90-786`, `cellapp/KBEngine.md:78-679`; cellapp has no `address`, bots has only a subset: `bots/KBEngine.md:33-194`). The `component` attribute tells each script which app it is in (`baseapp/KBEngine.md:1051-1058`, `bots/KBEngine.md:233-239`).

## 2. Where the apps differ

| App | Owns | Script home | Entity callbacks | Distinct module surface |
| --- | --- | --- | --- | --- |
| baseapp | client connection, position-independent logic, archive/backup (`baseapp/index.md:1-5`) | scripts (project) | base-part lifecycle ([§3](#3-lifecycle-overview)) | `createEntity*` family incl. DBID variants (`baseapp/KBEngine.md:171-320`), `charge`, `lookUpEntityByDBID`/`deleteEntityByDBID`, `onBaseAppReady`/`onReadyForLogin` (`baseapp/KBEngine.md:791-973`) |
| cellapp | space/view/witness, movement, navigation, AOI (`cellapp/index.md:1-6`) | scripts (project) | cell-part lifecycle ([§3](#3-lifecycle-overview)) | `createEntity` (`cellapp/KBEngine.md:179-215`), `addSpaceGeometryMapping`, `raycast`, space data, geometry-loaded callbacks (`cellapp/KBEngine.md:768-813`) |
| loginapp | registration/login (`loginapp/index.md:1-5`) | `scripts/login` | — | `onRequestLogin`/`onRequestCreateAccount` + DB round-trip callbacks (`loginapp/KBEngine.md:115-202`) |
| dbmgr | entity storage (`dbmgr/index.md:1-5`) | `scripts/db` | — | `onSelectAccountDBInterface` (`dbmgr/KBEngine.md:147-158`) |
| interfaces | third-party platform access (`interfaces/index.md:1-4`) | `scripts/interfaces` | — | `accountLoginResponse`/`createAccountResponse`/`chargeResponse`, request hooks (`interfaces/KBEngine.md:67-233`) |
| logger | log collection (`logger/index.md:1-5`) | `scripts/logger` | — | `onLogWrote` (`logger/KBEngine.md:113-127`) |

### 2.1 The client family: client, bots, PyClientApp

Three members, one contract:

- **client** is not a process but a plugin standard: every client plugin (Unity/UE/JS…) implements the same `KBEngine` module surface — `login`/`createAccount`/`reloginBaseapp`/`resetPassword`/`bindAccountEmail`/`newPassword`, plus `player()` and `findEntity` (`client/index.md:3-16`, `client/KBEngine.md:31-160`). Client entities are mirrors: `onEnterWorld`/`onLeaveWorld` mean "entered/left the server-side view of the controlling player", while for the player entity they mean "cell created/destroyed on the server" (`client/Entity.md:187-206`).
- **bots** is the headless twin: same `Entity` callbacks as client plus `moveToPoint`/`cancelController`, used to simulate and load-test (`bots/index.md:1-8`, `bots/Entity.md:51-119`). `addBots` batch-creates simulated clients (`bots/KBEngine.md:35-62`); each simulated client is a `PyClientApp` with `player()`/`getSpaceData` and an `entities` dict (`bots/PyClientApp.md:5-11,35-71`); bots `Entity` exposes its owning app as the `clientapp` attribute (`bots/Entity.md:208-265`).
- **Proxy** (baseapp) is the server-side counterpart of a logged-in client: `giveClientTo`, streaming files/strings to the client, and the connection callbacks `onClientDeath`/`onClientEnabled`/`onLogOnAttempt` (kick duplicate logins here) (`baseapp/Proxy.md:53-223`).

Player identity vs control vs visibility — the checklist calls these out as the classic misread (`audit-checklist.md:10-11`): `isPlayer` is an identity check on client/bots (`client/Entity.md:103-126`); `controlledBy` is a cell-side control binding set by `giveClientTo` (`cellapp/Entity.md:1025-1044`); view/witness state (`isWitnessed`, `hasWitness`) is visibility (`cellapp/Entity.md:1062-1122`).

## 3. Lifecycle overview

One entity, layered by part (all references are callbacks/entry points documented in the API pages):

```
                    ┌─ create ─────────────────────────────────────────────┐
 base (baseapp)     │ createEntity* / createEntityLocally        baseapp/KBEngine.md:171-364
                    │ → onRestore  → onGetCell / onLoseCell      baseapp/Entity.md:310-318,285-298
                    │ → onPreArchive → onWriteToDB (persistence)  baseapp/Entity.md:299-309,333-343
                    │ → onDestroy                                 baseapp/Entity.md:277-284
                    │
 cell (cellapp)     │ createEntity (direct) or createCellEntity*  cellapp/KBEngine.md:179 / baseapp/Entity.md:125-154
                    │ → onRestore → onUpdateBegin/End per tick    cellapp/Entity.md:852-859,925-937
                    │ → onGetWitness/onLoseWitness/onWitnessed    cellapp/Entity.md:767-774,804-812,938-954
                    │ → traps/view: onEnterTrap/onEnteredView…    cellapp/Entity.md:740-791
                    │ → teleport: onTeleport…Success/Failure      cellapp/Entity.md:880-910
                    │ → onDestroy                                 cellapp/Entity.md:732-739
                    │
 client (plugin /   │ mirror entity: onEnterWorld/onLeaveWorld    client/Entity.md:187-206
 bots)              │ (world = the controller player's view;      client/Entity.md:187-195
                    │  space transitions: onEnterSpace/LeaveSpace) client/Entity.md:207-216
                    │
 persistence loop   │ writeToDB (either side) / auto-archive/     baseapp/Entity.md:199-215,446-474
                    │ backup / createEntityFromDBID restore       baseapp/KBEngine.md:258-299
```

Reading the map:

- **Creation is layered, not atomic.** A base entity can exist with no cell; `cellData` keeps the would-be cell attributes meanwhile (`baseapp/Entity.md:359-369`). The cell part is attached later via `createCellEntity`/`createCellEntityInNewSpace`, and `onGetCell` fires on the base when it lands (`baseapp/Entity.md:125-154,285-291`).
- **Cell relocation is invisible to the base's `id`**: under load balancing the cell entity moves between cellapps; the base keeps talking through the same `cell` EntityCall (baseapp detailed description, `baseapp/Entity.md:52-61`).
- **Two destruction paths**: base-side `destroy(deleteFromDB, writeToDB)` and `destroyCellEntity` (`baseapp/Entity.md:173-198`); cell-side plain `destroy` (`cellapp/Entity.md:349-358`). Client side only sees `onDestroy`/`onLeaveWorld`.
- **Disconnect ≠ destroy.** A dropped client triggers `onClientDeath` on Proxy; re-login is arbitrated in `onLogOnAttempt` (`baseapp/Proxy.md:155-170,185-210`), and the client can `reloginBaseapp` (`client/KBEngine.md:66-79`).
- **Process-level lifecycle** brackets everything: `onInit` → app-ready (`onBaseAppReady`, `onCellAppData`-style ready callbacks, `onReadyForLogin`) → `onReadyForShutDown` → `onFini`/app-shutdown (`baseapp/KBEngine.md:791-973`, `cellapp/KBEngine.md:680-813`).

## 4. Honesty notes

- The API pages are CHM-derived help text; wording sometimes merges ("theKBEnginemodule") and link targets inside the pages are anchor-style, not always consistent (`docs/api/kbengine/index.md:3`).
- `.def` property flags (`*_CLIENT*` broadcast, persistence, `Volatile`) are referenced but not enumerated anywhere in `docs/api/kbengine/`; both mentions delegate to the external `kbengine.org/docs` pages (`client/Entity.md:51-55`, `keywords.md:109`) — those external links predate this fork and are not verified here.
- Known page defects kept as-is (recorded, not silently fixed): `client/Entity.md` documents `isPlayer` twice (`client/Entity.md:103-126`); `inWorld` appears only in the attribute table without a description entry (`client/Entity.md:37`); `set_[property](/study/)` in `client/Entity.md:53` is a malformed inline link.
- `basetypes.md` is a bare table without per-type semantics ([§1.6](#16-basic-types-a-bare-table-knowingly-bare)); do not infer defaults from it.
- `cellapp/Entity.md` warns `position` must not be copied by reference — a real aliasing hazard, preserved verbatim (`cellapp/Entity.md:1157-1176`).
