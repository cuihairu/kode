# Bots-face API reference: the `KBEngine` module, the `bots` registry, client objects & Entity

> KB-API-007 (P1) · the bots face of the API surface. Source material: kbengine
> fork `docs/api/kbengine/bots/{KBEngine.md, Entity.md, PyClientApp.md,
> index.md}` (CHM conversion; rewritten here, not copied — the source text has
> word-gluing artifacts and leaks server-Entity content into the bots page).
> Grounding domain is `kbe/src` at `/home/cui/workspaces/kbengine`, HEAD
> `6d12b8f` (verified at HEAD on 2026-11-04); the bots C++ sources live at
> `kbe/src/server/tools/bots/`. Every claim carries a `file:line` anchor or an
> explicit **待取证 / to be evidenced** marker. Deviation-annotation format
> follows [python-version-baseline §7](python-version-baseline.md).
>
> **Shared-face note:** the bots process is built on the embedded client
> library, so its `KBEngine` module, client object and `Entity` types are the
> same C++ surfaces already documented in [api-client](api-client.md)
> (KB-API-002). That page is authoritative for the shared bindings; this page
> re-anchors only what the bots process adds or differs on: `addBots`, the
> `bots` registry, the entry-script callbacks, and the source-material deltas.

## 1. The bots process and how its script face is assembled

Bots is a headless client simulator used to load and soak-test a server: it
mass-creates clients, drives them through loginapp/baseapp login, then replays
the entity stream without any rendering (`docs/api/kbengine/bots/index.md`;
process class `Bots : public ClientApp`, `kbe/src/server/tools/bots/bots.h:40`).
Entry point: `KBENGINE_MAIN` sets `g_componentType = BOTS_TYPE` and runs
`kbeMainT<Bots>` (`kbe/src/server/tools/bots/main.cpp:60-62`); the shared main
template installs the Python module under the name `KBEngine`
(`kbe/src/lib/client_lib/kbemain.h:102`).

The script face is assembled from six registration sites:

| Site | Registers |
| --- | --- |
| `kbe/src/server/tools/bots/bots.cpp:174-182` (`Bots::installPyModules`) | the `ClientObject` / `PyBots` script types (`:176-177`), the `bots` registry object (`:179-180`), module function `addBots` (`:182`) |
| `bots.cpp:186-209` | int constants `LOG_TYPE_NORMAL/INFO/ERR/DBG/WAR` |
| `bots.cpp:211-228` | imports the entry script from `scripts/bots/<name>.py` (`:222`) |
| `kbe/src/lib/client_lib/clientapp.cpp:186-217` (`ClientApp::installEntityDef`) | module functions `publish`, `fireEvent`, `player`, `getSpaceData`, `callback`, `cancelCallback`, `getWatcher`, `getWatcherDir`, `disconnect`, `kbassert` (`:191-200`), resource helpers `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath` (`:203-215`) |
| `clientapp.cpp:233-268` (`ClientApp::installPyModules`) | registers the `client::Entity` and `EntityComponent` types (`:236-237`), `scriptLogType` (`:240`, duplicate of the bots-side registration at `bots.cpp:185`), `LOG_TYPE_*` ints (`:242-266`), the `entities` map object (`:266`) |
| `kbe/src/lib/pyscript/script.cpp:247-258` + `kbe/src/lib/pyscript/pyurl.cpp:23` | `component` string attr (`script.cpp:247-251`), `genUUID64` (`:258`), `urlopen` (`pyurl.cpp:23`) |

Process plumbing around the script face: a telnet console bound from config
(`bots.cpp:85-95`), the game-tick timer at `gameUpdateHertz`
(`bots.cpp:72-74`, dispatch `clientapp.cpp:343-353`), and the bot-spawn timer
(§2.1). Entry-script callbacks `onInit` and `onFinish` are driven by the
process itself (§3).

## 2. `KBEngine` module — functions

### 2.1 Functions documented in the source material (8)

| Function | Signature | Semantics (bots-specific notes) | Registration / impl |
| --- | --- | --- | --- |
| `addBots` | `addBots(totalCount)` or `addBots(totalCount, tickCount, tickTime)` | requests `totalCount` simulated clients on this bots process; `tickCount`/`tickTime` override the per-batch size and interval **only when > 0**; totals accumulate across calls; arity other than 1 or 3 raises `TypeError` | `bots.cpp:182` (registered), `bots.cpp:344-387` (`__py_addBots`: arity checks `:346/:365/:382-385`, accumulation `:359-360`, positive-only overrides `:374-378`); remote (non-Python) variant `bots.cpp:321-342` |
| `callback(offset, cb) -> int` | — | shared with the client face; identical binding on bots | `clientapp.cpp:195` |
| `cancelCallback(id)` | — | shared | `clientapp.cpp:196` |
| `genUUID64() -> int` | — | shared; uniqueness still depends on the `gus` startup arg | `script.cpp:258`, warning path `:99-106` |
| `getWatcher(path)` / `getWatcherDir(path)` | — | shared watcher queries | `clientapp.cpp:197-198` |
| `scriptLogType(logType)` | — | sets `print` output level; on bots this name is registered **twice** (bots-side and ClientApp-side, same arg contract) | `bots.cpp:185` (`bots.cpp:389-411`) and `clientapp.cpp:240` |
| `urlopen(url, callback, postData, headers)` | — | shared async HTTP(S); POST body must be `bytes`, callback receives `(httpcode, data, headers, success, url)` | `pyurl.cpp:23`; POST-bytes check `pyurl.cpp:162` |

**`addBots` is a request, not an instantiation.** The source-material example
("add 5 robots … instantaneously") overstates it: `__py_addBots` only bumps
counters on the `Bots` singleton. Actual clients are created by the
`CreateAndLoginHandler` timer: 1 s period (`create_and_login_handler.cpp:18-22`),
rate-limited by counting 0.1 s sub-ticks down to 0 (`:43-50`), then creating
`tickCount` `ClientObject`s per release with login names
`<prefix><componentID>_<accountID>` (`:52-61`); the account-ID base is
`genUUID64() * 100000` unless `bots_account_name_suffix_inc` is configured
(`:23-27`). Defaults for the three counters come from `kbengine_defaults.xml`
`<defaultAddBots>` (`bots.cpp:41-43`;
`kbe/src/lib/server/serverconfig.cpp:1444-1463`).

### 2.2 Fork-registered functions absent from the source material (11)

`publish`, `fireEvent` (module-level, string payload — see
[api-client §2](api-client.md) for the payload caveat), `player`,
`getSpaceData`, `disconnect`, `kbassert`, `getResFullPath`, `hasRes`, `open`,
`listPathRes`, `matchPath` — all bound at `clientapp.cpp:191-215`, identical to
the client face. The source material documents only 8 of the 19 module
functions the bots process actually exposes.

## 3. Entry-script callbacks and module attributes

| Item | Kind | Semantics & evidence |
| --- | --- | --- |
| `onInit(isReload)` | callback | called on the entry script once all scripts are loaded; the bots process always passes `isReload = 0` — there is no reload path that passes 1 (`bots.cpp:99-113`) |
| `onFinish()` | callback | called during process finalisation, before clients are torn down and the telnet server stops (`bots.cpp:121-141`) |
| `onTargetChanged` | callback (fork-only, undocumented) | invoked on the entry script when the client's target entity changes (`clientapp.cpp:455-475`) |
| `bots` | attribute, read-only | `PyBots` mapping over the process client registry, installed at `bots.cpp:179-180`; see §4.1 |
| `entities` | attribute, read-only | `Entities<client::Entity>` map for the process (`clientapp.cpp:266`; same object as the client face) |
| `component` | attribute, read-only string | equals `'bots'` on this process: `Script::install` writes `COMPONENT_NAME_EX(componentType)` (`script.cpp:247-251`), the bots main sets `BOTS_TYPE` (`main.cpp:60-62`), and `COMPONENT_NAME[11] == "bots"` (`kbe/src/lib/common/common.h:110`) — see §6 for the relation to api-client's `component` verdict |
| `LOG_TYPE_*` | int constants | `NORMAL/INFO/ERR/DBG/WAR`, added by both bots-side (`bots.cpp:186-209`) and ClientApp-side (`clientapp.cpp:242-266`) installation |

## 4. Client objects

### 4.1 The `bots` registry (`PyBots`)

The source material describes `bots` as "a dictionary object that contains all
client objects on the current process". The fork object is a **read-only
mapping** (`mp_ass_subscript` is `NULL`, `kbe/src/server/tools/bots/pybots.cpp:22-26`)
over `Bots::clients()` — a `std::map<Network::Channel*, ClientObject*>`
(`bots.h:103`), i.e. keyed by the client's network channel, but the script
surface resolves keys through `findClientByAppID` (`bots.h:120`,
`pybots.cpp:70`). Script-visible protocol:

| Member | Behavior | Evidence |
| --- | --- | --- |
| `len(bots)` | number of live clients | `pybots.cpp:56-59` |
| `bots[appID]` | the `ClientObject`; raises `KeyError` when absent | `pybots.cpp:62-79` |
| `has_key`, `keys`, `values`, `items`, `get` | dict-style helpers; `get` takes an optional default | `pybots.cpp:29-35`, impls `:56-176` |

### 4.2 The client object type — source name "PyClientApp", fork type `ClientObjectBase`

The source material's `PyClientApp` type name has **no symbol anywhere in
`kbe/src`** (grep: 0 hits). The bots client object is `ClientObject`
(`bots/clientobject.h:20`), a thin subclass of `ClientObjectBase`
(`kbe/src/lib/client_lib/clientobjectbase.h:34`) that adds no script members at
all (`clientobject.cpp:26-33` — all declare blocks empty). The script surface
lives on `ClientObjectBase`:

| Member | Kind | Evidence |
| --- | --- | --- |
| `getSpaceData(key)` | method; missing key raises `TypeError` | declared `clientobjectbase.cpp:21`; impl `:2387-2448` |
| `callback`, `cancelCallback`, `getWatcher`, `getWatcherDir`, `disconnect`, `kbassert` | methods | declared `clientobjectbase.cpp:22-27` |
| `player()` | method; returns the controlled entity or `None` | declared `clientobjectbase.cpp:28` |
| `id` | getset, int | declared `clientobjectbase.cpp:35`; the C++ app-ID counter starts at 1 (`:40`) |
| `entities` | getset | declared `clientobjectbase.cpp:36` |

Each client object lives through the connection state machine `C_STATE_INIT →
C_STATE_INITLOGINAPP_CHANNEL → C_STATE_LOGIN → C_STATE_LOGIN_BASEAPP_CHANNEL →
C_STATE_LOGIN_BASEAPP → C_STATE_PLAY` (`clientapp.h:41-48`), advanced once per
game tick (`clientapp.cpp:364-436`); the baseapp leg performs the hello/blowfish
handshake before login (`clientapp.cpp:377-404`). `Bots::handleGameTick` walks
all clients per tick and drops destroyed ones (`bots.cpp:266-296`).

## 5. `Entity` on bots — same type as the client face, plus deltas

The bots `Entity` is `client::Entity` (`kbe/src/lib/client_lib/entity.h:34`),
registered by `ClientApp::installPyModules` (`clientapp.cpp:236`) — identical
to the surface documented in [api-client §4-5](api-client.md). Recap with
bots-local anchors:

- **Methods (9):** `moveToPoint`, `cancelController`, `isPlayer`, `addTimer`,
  `delTimer`, `getComponent` (`entity.cpp:29-34`), `registerEvent`,
  `deregisterEvent`, `fireEvent` (client macro
  `kbe/src/lib/entitydef/entity_macro.h:47-49`), plus dunder plumbing
  `__reduce_ex__` / `__getDEP__` (`entity_macro.h:45-46`).
- **Attributes (10):** `id`, `spaceID`, `isDestroyed`, `className`
  (`entity_macro.h:58-61`), `base`, `cell`, `clientapp` (`entity.cpp:41-43`),
  `position`, `direction`, `velocity` (get/set, `entity.cpp:44-46`).
- **Callbacks:** `onEnterWorld` / `onLeaveWorld` / `onEnterSpace` /
  `onLeaveSpace`, dispatched from the network handlers (`entity.cpp:561-594`;
  triggers `clientobjectbase.cpp:935`, `:972`, `:1034`, `:1055`), plus
  `onTimer` for `addTimer` (`entity.cpp:894-898`).
- `moveToPoint` accepts either a numeric controller ID or the string
  `"Movement"` in `cancelController` (`entity.cpp:787-830`).

Source-material deltas specific to the bots `Entity` page are in §6.

## 6. 3.7 source material vs fork 3.12 deviations

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `addBots` example ("add 5 robots … instantaneously") | implies bots appear immediately | `__py_addBots` only accumulates counters; clients spawn via the 1 s `CreateAndLoginHandler` timer with 0.1 s sub-tick rate limiting | Fork | `bots.cpp:344-387`; `create_and_login_handler.cpp:18-59` |
| module functions documented for bots | 8 (`addBots callback cancelCallback genUUID64 getWatcher getWatcherDir scriptLogType urlopen`) | 19 registered; 11 undocumented (`publish fireEvent player getSpaceData disconnect kbassert getResFullPath hasRes open listPathRes matchPath`) | Fork | `bots.cpp:182-185`; `clientapp.cpp:191-215`; `script.cpp:258`; `pyurl.cpp:23` |
| `Entity` member functions listed | 7 (omits timers) | `addTimer` / `delTimer` are also script-visible on the bots Entity | Fork | `entity.cpp:32-33` |
| `Entity.isOnGround` attribute | read-write bool, synced | C++ member only (`entity.h:172-173`), updated from the network stream (`clientobjectbase.cpp:828-875`); **no script getter/setter declared** — as a script attribute it is plugin-layer | 待取证 / to be evidenced — evidence path: diff the official SDK plugin entity class | `entity.h:172-173`; no `SCRIPT_GET(SET)_DECLARE` for it |
| `Entity.cellData` section | documented as a bots-Entity dict attribute | **no `cellData` anywhere in `client_lib`** (grep: 0 hits) — the section is server-Entity material leaked into the bots page | Fork | grep `cellData lib/client_lib`: 0 hits |
| `PyClientApp` class name | documented as a KBEngine-module class | no such symbol in `kbe/src`; the type is `ClientObjectBase` (bots subclass `ClientObject` adds no members) | Fork | grep `PyClientApp`: 0 hits; `clientobjectbase.h:34`; `clientobject.cpp:26-33` |
| `bots` "dictionary" | plain dict of client objects | read-only mapping keyed by client app-ID via channel map; `KeyError` on unknown key | Fork | `pybots.cpp:22-26`, `:62-79`; `bots.h:103`, `:120` |
| `onInit(isReload)` | generic init callback | bots always passes `isReload = 0` | Fork | `bots.cpp:99-113` |
| `KBEngine.component` | read-only string | registered on bots as `'bots'` by the shared `Script::install`; this supersedes the api-client §3 row whose grep was scoped to `lib/client_lib` only (the registration lives in `lib/pyscript`) | Fork | `script.cpp:247-251`; `common.h:110`; `kbemain.h:102`; `main.cpp:60-62` |
| `scriptLogType` double registration | single module function | registered twice on bots (Bots-side and ClientApp-side), both live at import time | Fork | `bots.cpp:185`; `clientapp.cpp:240` |
| `onTargetChanged` | not documented | real entry-script callback on the bots/client app | Fork | `clientapp.cpp:455-475` |
| runtime baseline | CHM written against embedded 3.7.3 | fork builds 3.12; all bots-face bindings are version-neutral C API | Fork | see [python-version-baseline §2](python-version-baseline.md) |

## Coverage summary

19 module functions (8 documented + 11 fork-only), 3 entry-script callbacks
(2 documented + 1 fork-only), 7 module attributes/constants, the 5-member
`PyBots` mapping, the 8-method / 2-getset client-object face, and the 9-method
/ 10-attribute / 5-callback `Entity` face — every item with a `file:line`
anchor at HEAD `6d12b8f`.

## References

- Fork: `kbe/src/server/tools/bots/` — `main.cpp:60-62`, `bots.h:40`,
  `:103`, `:115-120`, `bots.cpp:36-43`, `:72-95`, `:99-141`, `:174-228`,
  `:242-249`, `:260-296`, `:321-342`, `:344-411`,
  `create_and_login_handler.cpp:18-59`, `clientobject.cpp:26-33`,
  `pybots.cpp:22-176`
- Fork (shared client face): `kbe/src/lib/client_lib/` — `kbemain.h:102`,
  `clientapp.h:41-48`, `clientapp.cpp:186-217`, `:233-268`, `:343-436`,
  `:455-475`, `clientobjectbase.h:34`, `clientobjectbase.cpp:20-40`,
  `:2387-2448`, `entity.h:34`, `:172-173`, `entity.cpp:29-46`, `:561-594`,
  `:787-830`, `:894-898`
- Fork (shared script layer): `kbe/src/lib/pyscript/script.cpp:247-258`,
  `pyurl.cpp:23`, `:162`; `kbe/src/lib/entitydef/entity_macro.h:45-49`,
  `:56-64`; `kbe/src/lib/common/common.h:110`;
  `kbe/src/lib/server/serverconfig.cpp:1444-1463`
- Source material (rewritten, not copied): kbengine
  `docs/api/kbengine/bots/KBEngine.md`, `Entity.md`, `PyClientApp.md`,
  `index.md` (CHM conversion; glued-token layout)
- Baseline & annotation rules:
  [python-version-baseline](python-version-baseline.md) (§7 template)
- Companion pages: [api-client](api-client.md) (shared client_lib face),
  [api-baseapp](api-baseapp.md) / [api-cellapp](api-cellapp.md) (the server
  faces the bots connect to)
