# API Core Concepts: A Cross-Cutting Map

> Scope: concepts that recur across the KBEngine API pages (`docs/api/kbengine/`), organized as **shared concepts → per-app differences → lifecycle overview**. This is a concept map, not a function catalog: every API mentioned here is documented in detail on its own page; this article only explains what recurs, what differs, and how the pieces fit.
>
> Grounding: `docs/api/kbengine/` at HEAD `6d12b8f`. Provenance of those pages: `docs/api/kbengine/kbengine_api(cn).chm` / `kbengine_api(en).chm` (see [API overview](/api/kbengine/)). Chinese mirror: [/zh/knowledge/api-core-concepts](/zh/knowledge/api-core-concepts).

## 1. Concepts shared across apps

### 1.1 One entity, several parts

The single most load-bearing idea in the API docs: one script-level `Entity` exists simultaneously in up to three process "parts" — client, base, cell ([keywords](/api/kbengine/keywords.md#EntityCall): `docs/api/kbengine/keywords.md:19-26`). The parts talk to each other through `EntityCall`, which is deliberately minimal: entity ID + destination address + entity type + call type, checked against the entity's `.def` description before packing ([`keywords.md:5-18`](/api/kbengine/keywords.md#EntityCall)).

Consequences that hold on every app:

- `id` is the same integer on the base, cell, and client sides of the same entity ([`baseapp/Entity.md:423-431`](/api/kbengine/baseapp/Entity.md#id), [`cellapp/Entity.md:1075-1083`](/api/kbengine/cellapp/Entity.md#id), [`client/Entity.md:35`](/api/kbengine/client/Entity.md#Attributes)).
- `base`, `cell`, `client` are read-only `EntityCall` attributes, `None` when the part does not exist (base side: [`baseapp/Entity.md:346-384`](/api/kbengine/baseapp/Entity.md#cell); cell side: [`cellapp/Entity.md:963-1163`](/api/kbengine/cellapp/Entity.md#allClients) for the client broadcast family).
- An `EntityCall` can only invoke methods declared in the `.def` file — never engine methods, never properties ([`keywords.md:16-18`](/api/kbengine/keywords.md#EntityCall)).
- The client side has no `base`/`cell` attributes at all; it reaches the server through `baseCall`/`cellCall` by method name ([`client/Entity.md:61-104`](/api/kbengine/client/Entity.md#baseCall)).

### 1.2 The entity event system

`registerEvent` / `fireEvent` / `deregisterEvent` appear verbatim on all four `Entity` pages — baseapp ([`baseapp/Entity.md:229-265`](/api/kbengine/baseapp/Entity.md#fireEvent)), cellapp ([`cellapp/Entity.md:691-727`](/api/kbengine/cellapp/Entity.md#fireEvent)), client ([`client/Entity.md:140-176`](/api/kbengine/client/Entity.md#fireEvent)), bots ([`bots/Entity.md:133-169`](/api/kbengine/bots/Entity.md#fireEvent)). Semantics: same-process, same-named events; this is a per-process pub/sub, **not** a remote-call mechanism (remote calls are EntityCall). `getComponent` likewise exists on all four sides.

### 1.3 Timers, in three flavors

- **Entity-level timers** on baseapp and cellapp `Entity`: `addTimer`/`delTimer` → `onTimer(timerHandle, userData)` ([`baseapp/Entity.md:66-171,319-332`](/api/kbengine/baseapp/Entity.md#addTimer), [`cellapp/Entity.md:205-348,911-924`](/api/kbengine/cellapp/Entity.md#addTimer)).
- **Module-level timers** on the thin processes: `addTimer(initialOffset, repeatOffset, callbackObj)` takes a callback object instead of an entity method — loginapp ([`loginapp/KBEngine.md:25-80`](/api/kbengine/loginapp/KBEngine.md#addTimer)), dbmgr ([`dbmgr/KBEngine.md:24-79`](/api/kbengine/dbmgr/KBEngine.md#addTimer)), interfaces ([`interfaces/KBEngine.md:28-129`](/api/kbengine/interfaces/KBEngine.md#addTimer)), logger ([`logger/KBEngine.md:24-78`](/api/kbengine/logger/KBEngine.md#addTimer)).
- **Script callbacks** on bots: `callback`/`cancelCallback` ([`bots/KBEngine.md:63-112`](/api/kbengine/bots/KBEngine.md#callback)) — same offset/repeat idea, detached from any entity.

### 1.4 The data dictionaries

Four scoped key/value stores, each with a `get`/`set`/`del` plus a pushed callback on change:

| Dictionary | Where it lives | Script surface |
| --- | --- | --- |
| `globalData` | all server apps | `onGlobalData`/`onGlobalDataDel` ([`baseapp/KBEngine.md:866-892`](/api/kbengine/baseapp/KBEngine.md#onGlobalData), [`cellapp/KBEngine.md:712-738`](/api/kbengine/cellapp/KBEngine.md#onGlobalData)); dict attribute `globalData` ([`baseapp/KBEngine.md:1139`](/api/kbengine/baseapp/KBEngine.md#globalData), [`cellapp/KBEngine.md:949`](/api/kbengine/cellapp/KBEngine.md#globalData)) |
| `cellAppData` | cellapp group | `onCellAppData`/`onCellAppDataDel` ([`cellapp/KBEngine.md:684-711`](/api/kbengine/cellapp/KBEngine.md#onCellAppData)); attribute `cellAppData` ([`cellapp/KBEngine.md:863`](/api/kbengine/cellapp/KBEngine.md#cellAppData)) |
| `baseAppData` | baseapp group | `onBaseAppData`/`onBaseAppDataDel` ([`baseapp/KBEngine.md:839-865`](/api/kbengine/baseapp/KBEngine.md#onBaseAppData)); attribute `baseAppData` ([`baseapp/KBEngine.md:1088`](/api/kbengine/baseapp/KBEngine.md#baseAppData)) |
| `spaceData` | one space | `setSpaceData`/`getSpaceData`/`delSpaceData` + `onSpaceData` ([`cellapp/KBEngine.md:228-372,753-767`](/api/kbengine/cellapp/KBEngine.md#onSpaceData)); clients and bots only read: [`client/KBEngine.md:144-160`](/api/kbengine/client/KBEngine.md#getSpaceData), [`bots/PyClientApp.md:35-49`](/api/kbengine/bots/PyClientApp.md#getSpaceData) |

### 1.5 The four data categories

The API docs split an entity's data by *where it is authoritative*:

1. **Property sync (cell → client).** Properties flagged `*_CLIENT*` in the server-side `.def` are broadcast to client entities; on change the client-side `set_<property>` is invoked ([`client/Entity.md:51-55`](/api/kbengine/client/Entity.md#detailed_description)). The docs deliberately do not enumerate the flag values here — that lives in the entitydef documentation they link out to ([`keywords.md:109`](/api/kbengine/keywords.md#entity), [`client/Entity.md:55`](/api/kbengine/client/Entity.md#detailed_description)).
2. **Cell data (position-adjacent).** `position`, `direction`, `volatileInfo` sync policy, `topSpeed`/`topSpeedY` legality checks, view/witness state — all cellapp `Entity` attributes ([`cellapp/Entity.md:1046-1050,1157-1184,1195-1230,1231-1265`](/api/kbengine/cellapp/Entity.md#volatileInfo)). Volatile data has its own optimization policy, configurable per-entity in `.def` `<Volatile>` ([`cellapp/Entity.md:1231-1265`](/api/kbengine/cellapp/Entity.md#volatileInfo)).
3. **Base data (baseapp-resident).** `cellData` holds the cell part's attributes before the cell exists (plus position/direction/spaceID), and is dropped once the cell is created ([`baseapp/Entity.md:359-369`](/api/kbengine/baseapp/Entity.md#cellData)). Archiving/backup strategy attributes `shouldAutoArchive`/`shouldAutoBackup` (with `KBEngine.NEXT_ONLY`) are base-side ([`baseapp/Entity.md:446-474`](/api/kbengine/baseapp/Entity.md#shouldAutoArchive)).
4. **DB data (persisted).** `databaseID` (0 = not permanent), `databaseInterfaceName`, `writeToDB`, `onPreArchive`, `onWriteToDB`, `shouldAutoLoad` — the base side owns the persistence loop ([`baseapp/Entity.md:397-409,412-421,199-215,299-309,333-343`](/api/kbengine/baseapp/Entity.md#databaseID)); cellapp can also trigger a write ([`cellapp/Entity.md:649-666,955-960`](/api/kbengine/cellapp/Entity.md#writeToDB)).

### 1.6 Basic types: a bare table, knowingly bare

[`basetypes.md:3-30`](/api/kbengine/basetypes.md) is a name + byte-width table (fixed 1–20 bytes; `STRING`/`UNICODE`/`PYTHON`/`PY_DICT`/`PY_TUPLE`/`PY_LIST`/`ENTITYCALL`/`BLOB` variable). It carries no defaults, ranges, or serialization semantics — the [audit checklist](/api/kbengine/audit-checklist.md#1-core-concepts) flags exactly this gap ([`audit-checklist.md:48-50`](/api/kbengine/audit-checklist.md#1-core-concepts)). Treat it as the wire-type vocabulary shared by `.def` files and the script bridge, not as a semantics reference.

### 1.7 Shared utility surface

Present (near-)verbatim on both server apps unless noted: resource IO `open`/`hasRes`/`getResFullPath`/`listPathRes`/`matchPath`; file-descriptor hooks `registerReadFileDescriptor`/`registerWriteFileDescriptor`; `urlopen`; `genUUID64`; `executeRawDatabaseCommand`; watcher introspection `addWatcher`/`getWatcher`/`getWatcherDir`/`delWatcher`; `time`, `publish`, `getAppFlags`/`setAppFlags`, `scriptLogType`, `reloadScript`, `MemoryStream`, `address` ([`baseapp/KBEngine.md:90-786`](/api/kbengine/baseapp/KBEngine.md#Member-functions), [`cellapp/KBEngine.md:78-679`](/api/kbengine/cellapp/KBEngine.md#Member-functions); cellapp has no `address`, bots has only a subset: [`bots/KBEngine.md:33-194`](/api/kbengine/bots/KBEngine.md#Member-functions)). The `component` attribute tells each script which app it is in ([`baseapp/KBEngine.md:1051-1058`](/api/kbengine/baseapp/KBEngine.md#component), [`bots/KBEngine.md:233-239`](/api/kbengine/bots/KBEngine.md#component)).

## 2. Where the apps differ

| App | Owns | Script home | Entity callbacks | Distinct module surface |
| --- | --- | --- | --- | --- |
| baseapp | client connection, position-independent logic, archive/backup ([`baseapp/index.md:1-5`](/api/kbengine/baseapp/)) | scripts (project) | base-part lifecycle ([§3](#3-lifecycle-overview)) | `createEntity*` family incl. DBID variants ([`baseapp/KBEngine.md:171-320`](/api/kbengine/baseapp/KBEngine.md#createEntityAnywhere)), `charge`, `lookUpEntityByDBID`/`deleteEntityByDBID`, `onBaseAppReady`/`onReadyForLogin` ([`baseapp/KBEngine.md:791-973`](/api/kbengine/baseapp/KBEngine.md#onBaseAppReady)) |
| cellapp | space/view/witness, movement, navigation, AOI ([`cellapp/index.md:1-6`](/api/kbengine/cellapp/)) | scripts (project) | cell-part lifecycle ([§3](#3-lifecycle-overview)) | `createEntity` ([`cellapp/KBEngine.md:179-215`](/api/kbengine/cellapp/KBEngine.md#createEntity)), `addSpaceGeometryMapping`, `raycast`, space data, geometry-loaded callbacks ([`cellapp/KBEngine.md:768-813`](/api/kbengine/cellapp/KBEngine.md#onSpaceGeometryLoaded)) |
| loginapp | registration/login ([`loginapp/index.md:1-5`](/api/kbengine/loginapp/)) | `scripts/login` | — | `onRequestLogin`/`onRequestCreateAccount` + DB round-trip callbacks ([`loginapp/KBEngine.md:115-202`](/api/kbengine/loginapp/KBEngine.md#onRequestLogin)) |
| dbmgr | entity storage ([`dbmgr/index.md:1-5`](/api/kbengine/dbmgr/)) | `scripts/db` | — | `onSelectAccountDBInterface` ([`dbmgr/KBEngine.md:147-158`](/api/kbengine/dbmgr/KBEngine.md#onSelectAccountDBInterface)) |
| interfaces | third-party platform access ([`interfaces/index.md:1-4`](/api/kbengine/interfaces/)) | `scripts/interfaces` | — | `accountLoginResponse`/`createAccountResponse`/`chargeResponse`, request hooks ([`interfaces/KBEngine.md:67-233`](/api/kbengine/interfaces/KBEngine.md#accountLoginResponse)) |
| logger | log collection ([`logger/index.md:1-5`](/api/kbengine/logger/)) | `scripts/logger` | — | `onLogWrote` ([`logger/KBEngine.md:113-127`](/api/kbengine/logger/KBEngine.md#onLogWrote)) |

### 2.1 The client family: client, bots, PyClientApp

Three members, one contract:

- **client** is not a process but a plugin standard: every client plugin (Unity/UE/JS…) implements the same `KBEngine` module surface — `login`/`createAccount`/`reloginBaseapp`/`resetPassword`/`bindAccountEmail`/`newPassword`, plus `player()` and `findEntity` ([`client/index.md:3-16`](/api/kbengine/client/), [`client/KBEngine.md:31-160`](/api/kbengine/client/KBEngine.md#login)). Client entities are mirrors: `onEnterWorld`/`onLeaveWorld` mean "entered/left the server-side view of the controlling player", while for the player entity they mean "cell created/destroyed on the server" ([`client/Entity.md:187-206`](/api/kbengine/client/Entity.md#onEnterWorld)).
- **bots** is the headless twin: same `Entity` callbacks as client plus `moveToPoint`/`cancelController`, used to simulate and load-test ([`bots/index.md:1-8`](/api/kbengine/bots/), [`bots/Entity.md:51-119`](/api/kbengine/bots/Entity.md#moveToPoint)). `addBots` batch-creates simulated clients ([`bots/KBEngine.md:35-62`](/api/kbengine/bots/KBEngine.md#addBots)); each simulated client is a `PyClientApp` with `player()`/`getSpaceData` and an `entities` dict ([`bots/PyClientApp.md:5-11,35-71`](/api/kbengine/bots/PyClientApp.md)); bots `Entity` exposes its owning app as the `clientapp` attribute ([`bots/Entity.md:208-265`](/api/kbengine/bots/Entity.md#Attributes-documentation)).
- **Proxy** (baseapp) is the server-side counterpart of a logged-in client: `giveClientTo`, streaming files/strings to the client, and the connection callbacks `onClientDeath`/`onClientEnabled`/`onLogOnAttempt` (kick duplicate logins here) ([`baseapp/Proxy.md:53-223`](/api/kbengine/baseapp/Proxy.md#giveClientTo)).

Player identity vs control vs visibility — the checklist calls these out as the classic misread ([`audit-checklist.md:10-11`](/api/kbengine/audit-checklist.md#Audit-principles)): `isPlayer` is an identity check on client/bots ([`client/Entity.md:103-126`](/api/kbengine/client/Entity.md#isPlayer)); `controlledBy` is a cell-side control binding set by `giveClientTo` ([`cellapp/Entity.md:1025-1044`](/api/kbengine/cellapp/Entity.md#controlledBy)); view/witness state (`isWitnessed`, `hasWitness`) is visibility ([`cellapp/Entity.md:1062-1122`](/api/kbengine/cellapp/Entity.md#hasWitness)).

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

- **Creation is layered, not atomic.** A base entity can exist with no cell; `cellData` keeps the would-be cell attributes meanwhile ([`baseapp/Entity.md:359-369`](/api/kbengine/baseapp/Entity.md#cellData)). The cell part is attached later via `createCellEntity`/`createCellEntityInNewSpace`, and `onGetCell` fires on the base when it lands ([`baseapp/Entity.md:125-154,285-291`](/api/kbengine/baseapp/Entity.md#createCellEntity)).
- **Cell relocation is invisible to the base's `id`**: under load balancing the cell entity moves between cellapps; the base keeps talking through the same `cell` EntityCall ([baseapp detailed description, `baseapp/Entity.md:52-61`](/api/kbengine/baseapp/Entity.md#detailed_description)).
- **Two destruction paths**: base-side `destroy(deleteFromDB, writeToDB)` and `destroyCellEntity` ([`baseapp/Entity.md:173-198`](/api/kbengine/baseapp/Entity.md#destroy)); cell-side plain `destroy` ([`cellapp/Entity.md:349-358`](/api/kbengine/cellapp/Entity.md#destroy)). Client side only sees `onDestroy`/`onLeaveWorld`.
- **Disconnect ≠ destroy.** A dropped client triggers `onClientDeath` on Proxy; re-login is arbitrated in `onLogOnAttempt` ([`baseapp/Proxy.md:155-170,185-210`](/api/kbengine/baseapp/Proxy.md#onLogOnAttempt)), and the client can `reloginBaseapp` ([`client/KBEngine.md:66-79`](/api/kbengine/client/KBEngine.md#reloginBaseapp)).
- **Process-level lifecycle** brackets everything: `onInit` → app-ready (`onBaseAppReady`, `onCellAppData`-style ready callbacks, `onReadyForLogin`) → `onReadyForShutDown` → `onFini`/app-shutdown ([`baseapp/KBEngine.md:791-973`](/api/kbengine/baseapp/KBEngine.md#Callback-functions), [`cellapp/KBEngine.md:680-813`](/api/kbengine/cellapp/KBEngine.md#Callback)).

## 4. Honesty notes

- The API pages are CHM-derived help text; wording sometimes merges ("theKBEnginemodule") and link targets inside the pages are anchor-style, not always consistent ([`docs/api/kbengine/index.md:3`](/api/kbengine/index.md)).
- `.def` property flags (`*_CLIENT*` broadcast, persistence, `Volatile`) are referenced but not enumerated anywhere in `docs/api/kbengine/`; both mentions delegate to the external `kbengine.org/docs` pages ([`client/Entity.md:51-55`](/api/kbengine/client/Entity.md#detailed_description), [`keywords.md:109`](/api/kbengine/keywords.md#entity)) — those external links predate this fork and are not verified here.
- Known page defects kept as-is (recorded, not silently fixed): `client/Entity.md` documents `isPlayer` twice ([`client/Entity.md:103-126`](/api/kbengine/client/Entity.md#isPlayer)); `inWorld` appears only in the attribute table without a description entry ([`client/Entity.md:37`](/api/kbengine/client/Entity.md#Attributes)); `set_[property](/study/)` in `client/Entity.md:53` is a malformed inline link.
- `basetypes.md` is a bare table without per-type semantics ([§1.6](#16-basic-types-a-bare-table-knowingly-bare)); do not infer defaults from it.
- `cellapp/Entity.md` warns `position` must not be copied by reference — a real aliasing hazard, preserved verbatim ([`cellapp/Entity.md:1157-1176`](/api/kbengine/cellapp/Entity.md#position)).
