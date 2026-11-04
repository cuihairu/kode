# Baseapp face API reference — the `KBEngine` module

> KB-API-003 (P0) · part 1 of 2. Source material: kbengine fork
> `docs/api/kbengine/baseapp/{KBEngine.md,Entity.md,Proxy.md,index.md}` (CHM
> conversion; rewritten, not copied — the source text has word-gluing and
> broken-table artifacts). Grounding domain is `kbe/src` at
> `/home/cui/workspaces/kbengine`, HEAD `6d12b8f` (verified at HEAD on
> 2026-11-04); every claim carries a `file:line` anchor or an explicit
> **待取证 / to be evidenced** marker. Deviation-annotation format follows
> [python-version-baseline](python-version-baseline.md) §7.
>
> **Split note (per todo KB-API-003):** the four merged sources are too large
> for one page. This page covers the **`KBEngine` module face** (functions,
> entry-script callbacks, module attributes, constants) as installed by the
> baseapp process. The **`Entity` / `Proxy` class face** lives in
> [api-baseapp-entity](api-baseapp-entity.md). Baseapp is the process that
> owns client connections and base entities; it talks to cellapp for cell
> work and to dbmgr/interfaces for persistence and billing.

## 1. How the module face is assembled

The script-visible `KBEngine` module on baseapp is assembled from five
registration sites:

| Site | Registers |
| --- | --- |
| `kbe/src/server/baseapp/baseapp.cpp:430-451` (`Baseapp::installPyModules` block, app-specific methods) | `time`, `createEntity`, `createEntityLocally`, `createEntityAnywhere`, `createEntityRemotely`, `createEntityFromDBID`, `createEntityAnywhereFromDBID`, `createEntityRemotelyFromDBID`, `executeRawDatabaseCommand`, `quantumPassedPercent`, `charge`, `registerReadFileDescriptor`, `registerWriteFileDescriptor`, `deregisterReadFileDescriptor`, `deregisterWriteFileDescriptor`, `reloadScript`, `isShuttingDown`, `address`, `deleteEntityByDBID`, `lookUpEntityByDBID`, `setAppFlags`, `getAppFlags` |
| `kbe/src/lib/server/entity_app.h:423-453` (`EntityApp::installPyModules`, shared by all EntityApps) | `kbassert`, `publish`, `scriptLogType`, `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath`, `getWatcher`, `getWatcherDir`, `debugTracing`; int constants `LOG_TYPE_*`, `NEXT_ONLY`, `SERVER_ERR_*` |
| `kbe/src/lib/pyscript/pywatcher.cpp:184-185` | `addWatcher`, `delWatcher` |
| `kbe/src/lib/pyscript/script.cpp:248,258` (`Script::install`) | `component` string attr, `genUUID64` |
| `kbe/src/lib/pyscript/pyurl.cpp:23` | `urlopen` |

Module objects installed outside the method table: `entities`
(`kbe/src/lib/server/entity_app.h:411`), `globalData` (`:419`), `baseAppData`
(`kbe/src/server/baseapp/baseapp.cpp:461`), and the `LOG_ON_*` int constants
(`baseapp.cpp:463-476`); `APP_FLAGS_*` constants are added by iterating the
app-flags map (`baseapp.cpp:419-424`; flag values defined at
`kbe/src/lib/common/common.h:348-352`).

## 2. Entity creation family

All create-entity entry points share one params convention: a Python dict
whose keys initialize base properties; keys naming cell properties are routed
into the entity's `cellData` dict and only take effect when the cell entity
is later created. Unspecified properties keep their `.def` defaults.

### `KBEngine.createEntityLocally(entityType, params=None) -> Entity`

Creates a new base entity **on this baseapp** and returns the direct entity
object immediately — no callback, no round trip. Use when you must manage the
life cycle (control when `destroy` happens) or touch attributes not exposed
through `EntityCall`; some APIs require a direct reference
(e.g. `Proxy.giveClientTo`). Registration maps both `createEntity` and
`createEntityLocally` to the same handler (`baseapp.cpp:431-432`; entry
`baseapp.cpp:959`).

### `KBEngine.createEntity(entityType, params=None) -> Entity`

Alias of `createEntityLocally` — same handler (`baseapp.cpp:431`).

### `KBEngine.createEntityAnywhere(entityType, params=None, callback=None)`

Asks baseappmgr to pick a suitable baseapp and create the entity there;
preferred over `createEntityLocally` for load balancing. `callback(entityCall
| None)` fires on completion. Entry `baseapp.cpp:986` (sends
`onCreateEntityAnywhere` to baseappmgr); the chosen baseapp executes it via
the interface handler (`baseapp_interface.h:116`), callback delivered through
`onCreateEntityAnywhereCallback` (`baseapp_interface.h:119`).

### `KBEngine.createEntityRemotely(entityType, baseMB, params=None, callback=None)`

Like `createEntityAnywhere` but pinned to the baseapp owning `baseMB`
(a base `EntityCall`). Entry `baseapp.cpp:1028`; remote path
`baseapp_interface.h:122-125`.

### `KBEngine.createEntityFromDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

Loads the archived entity from the database **onto this baseapp**. If the
entity is already checked out, the callback receives a reference to the
existing entity. Callback: `(baseRef, databaseID, wasActive)`; on failure
`(None, 0, False)`. Entry `baseapp.cpp:1088`.

### `KBEngine.createEntityAnywhereFromDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

Same as above but baseappmgr chooses the target baseapp. Entry
`baseapp.cpp:1440`.

### `KBEngine.createEntityRemotelyFromDBID(entityType, dbID, baseMB, callback=None, dbInterfaceName="default")`

Loads from the database onto the baseapp owning `baseMB`. Entry
`baseapp.cpp:1966`.

### `KBEngine.deleteEntityByDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

Deletes the archived entity (and child-table rows) from the database. If the
entity is currently checked out, deletion fails and the callback receives its
`entityCall`; otherwise `True`. Entry `baseapp.cpp:5189`.

### `KBEngine.lookUpEntityByDBID(entityType, dbID, callback=None, dbInterfaceName="default")`

Query-only: callback gets `True` if the entity is **not** checked out, its
`entityCall` if it is. Entry `baseapp.cpp:5361`.

## 3. Persistence, database, billing

### `KBEngine.executeRawDatabaseCommand(command, callback=None, threadID=0, dbInterfaceName="default")`

Sends a raw DB command (SQL for MySQL) through dbmgr. Callback:
`(result, rows, insertid, error)` — `result` is `None` when the command has no
result set or errors; `rows` counts affected rows; `insertid` is
`mysql_insert_id()`-like, MySQL-only; `error` is `None` unless failed. The
source material's warning stands and is structural: if the entity is checked
out, later archiving **overwrites** direct SQL edits — do not read/modify
entity data this way. Entry `baseapp.cpp:3214`.

### `KBEngine.charge(ordersID, dbID, byteDatas, pycallback)`

Billing request forwarded to the interfaces process. `pycallback` prototype:
`(orderID, dbID, success, datas)`, invoked when interfaces calls
`chargeResponse`. Entry `baseapp.cpp:3435`; the loss/unknown-order path
raises the entry-script callback `onLoseChargeCB` (`baseapp.cpp:3603`).

## 4. Timers-free module utilities (time, address, state)

### `KBEngine.time() -> uint32`

Current game time in ticks; tick length is `1 / gameUpdateHertz`
(`kbengine.xml` / `kbengine_defaults.xml`). Registered under the name `time`
but bound to handler `__py_gametime` (`baseapp.cpp:430`, impl `:504`).

### `KBEngine.quantumPassedPercent() -> int`

Percentage of the current tick already consumed (thread scheduling headroom
probe). `baseapp.cpp:439`, impl `:510`.

### `KBEngine.address() -> (ip, port)`

Address of the **internal** network interface as a `(uint32 ip, uint32 port)`
tuple (numeric, network byte order). Impl `baseapp.cpp:5179`.

### `KBEngine.isShuttingDown() -> bool`

True once shutdown started. Impl `baseapp.cpp:5173` (reads
`Baseapp::isShuttingdown`); the shutdown state machine runs in
`onShutdownBegin/onShutdown/onShutdownEnd` (`baseapp.cpp:321,334,383`).

### `KBEngine.publish() -> int8`

Release mode: 0 debug, 1 release. `entity_app.h:426` (`__py_getAppPublish`).

### `KBEngine.setAppFlags(flags)` / `KBEngine.getAppFlags() -> int`

Process flags bitmask. Only two values exist at HEAD:
`APP_FLAGS_NONE = 0`, `APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING = 0x1`
(`kbe/src/lib/common/common.h:348-352`); set/get handlers
`baseapp.cpp:5785,5779`. Compose with `|`. A baseapp flagged
not-participating reports load differently to baseappmgr
(`onUpdateLoad` sends `flags_`, `baseapp.cpp:497-511`).

## 5. Debug / watcher / resource

### `KBEngine.addWatcher(path, dataType, getFunction)` / `KBEngine.delWatcher(path)`

Register/remove a watched variable under `scripts/...` for the monitoring
system (GUIConsole/telnet). `dataType` is a basetype string (e.g. `UINT32`).
`getFunction` is called with no args each time the watcher samples the value.
`kbe/src/lib/pyscript/pywatcher.cpp:184-185`.

### `KBEngine.getWatcher(path) -> value` / `KBEngine.getWatcherDir(path) -> tuple`

Read one watcher value / list a watcher directory's entries from the engine's
watcher tree. `entity_app.h:447,450`; impls `:757,896`.

### `KBEngine.debugTracing()`

Prints the engine-tracked extended-object counters (`FixedArray`, `FixedDict`,
`Entity`, `EntityCall`, ...). Non-zero counters at clean shutdown mean leaked
engine-wrapped Python objects. `entity_app.h:453` →
`kbe/src/lib/pyscript/py_gc.cpp:224` (`PyGC::__py_debugTracing`). For leaked
entity instances see `KBEngine.entities.garbages` —
[entity-lifecycle-reference](entity-lifecycle-reference.md).

### `KBEngine.hasRes(res) -> bool`, `KBEngine.getResFullPath(res) -> str|None`, `KBEngine.matchPath(res) -> str`, `KBEngine.listPathRes(path, extension=None) -> tuple`, `KBEngine.open(res, mode='r', encoding=None) -> file`

Resource-path utilities over `KBE_RES_PATH`; `matchPath`/`getResFullPath`
resolve a relative res path to absolute (`getResFullPath` returns `None` on
miss), `listPathRes` filters by extension (str like `"txt|py"` or a tuple).
All registered in `entity_app.h:432-443`. Path-resolution rules are covered in
[fixed-directories-and-path-resolution](fixed-directories-and-path-resolution.md).

### `KBEngine.scriptLogType(logType)`

Sets the log level used for `print` output; `logType` is one of the
`LOG_TYPE_*` constants. `entity_app.h:429` (impl `:925-940` region).

### `KBEngine.reloadScript(fullReload=True) -> bool`

Reloads entity script modules and (with `fullReload=True`) entity defs; live
entities get their `__class__` swapped to the reloaded class. Dev-time only.
The caller is told completion via `onInit(True)`
(`kbe/src/lib/server/entity_app.h:1461`). Entry `baseapp.cpp:5129` →
`Baseapp::reloadScript` (`:5148` region) → per-entity `reload()`
(`:5165-5168`).

## 6. Network, HTTP, descriptors

### `KBEngine.urlopen(url, callback=None, postData=None, headers=None)`

Async HTTP/HTTPS request off the main thread. Callback:
`(httpcode, data, headers, success, url)`; provide `postData` (bytes) to
switch GET→POST; `headers` is a dict. Registered at
`kbe/src/lib/pyscript/pyurl.cpp:23`, impl `:69` (`PyUrl::__py_urlopen`).

### `KBEngine.registerReadFileDescriptor(fileDescriptor, callback)` / `KBEngine.deregisterReadFileDescriptor(fileDescriptor)` (same for Write)

Hooks a raw fd/socket into the engine's network dispatcher: `callback(fd)`
fires on readability / writability. Baseapp registration
`baseapp.cpp:441-444` → `kbe/src/lib/server/py_file_descriptor.cpp:35` and
`:22-31` (register/deregister against `Components`' dispatcher).

### `KBEngine.MemoryStream()`

The 3.7 source material lists a `KBEngine.MemoryStream` constructor (binary
serializer following engine packing rules). **待取证 / to be evidenced on the
baseapp face**: the constructor is registered for `PythonApp`-based tools at
`kbe/src/lib/server/python_app.cpp:271` (`PyMemoryStream::py_new`), but
`EntityApp::installPyModules` (the baseapp chain, `entity_app.h:407-453`)
contains no `MemoryStream` registration, and no `PyMemoryStream::installScript`
caller was found for baseapp. Evidence path: run a baseapp with
`KBEngine.MemoryStream()` in its entry script and record the result; treat the
docs claim as unverified until then.

## 7. `genUUID64`

### `KBEngine.genUUID64() -> uint64`

Generates a 64-bit unique id: seconds-since-epoch plus a per-second 16-bit
counter (`kbe/src/lib/common/platform.h:738-770`). Cross-process uniqueness
needs the component global order in 1..65535 — the first call warns
otherwise (`kbe/src/lib/pyscript/script.cpp:96-101`, registration `:258`).
The 3.7 text attributes this to a baseapp startup parameter `gus`; at HEAD
the guard reads `g_componentGlobalOrder` (see deviation table).

## 8. Entry-script callbacks

All callbacks below are invoked on the **entry script module**
(`kbengine_defaults.xml -> baseapp -> entryScriptFile`; the engine resolves
them via `getEntryScript()`).

| Callback | Fires when | Grounding |
| --- | --- | --- |
| `onBaseAppReady(isBootstrap)` | Baseapp finished loading scripts and entities; `isBootstrap` is True for the first baseapp (group order 1) | `kbe/src/server/baseapp/initprogress_handler.cpp:179-190` |
| `onInit(isReload)` | After `onDbmgrInitCompleted` at startup (`isReload=0`, `baseapp.cpp:3636-3647`), and again with `True` after `reloadScript` (`entity_app.h:1461`) | both cited |
| `onReadyForLogin(isBootstrap)` | Polled while init progresses; return `True` (or a float `>= 0.9999`) to let loginapp accept clients; the float is reported to baseappmgr as init-progress percent | `initprogress_handler.cpp:200-233` (`Py_True` → `v=100` at `:213,227`; threshold `v >= 0.9999` at `:244-246`) |
| `onReadyForShutDown()` | Before process exit; returning `True` permits exit, anything else re-asks later | `baseapp.cpp:275-285` |
| `onBaseAppShutDown(state)` | Shutdown phases: `state=0` begin (before client disconnect, `baseapp.cpp:321-328`), `1` before entities are archived (`:334-343`), `2` after archiving completes (`:383-390`) | all three cited |
| `onFini()` | 3.7 source material: "after the engine is officially shut down". **Not found at fork HEAD** — no `onFini` symbol exists anywhere in `kbe/src` (only `onFinish` in client_lib/bots). **待取证**: confirm upstream intent (possibly never wired for baseapp) before relying on it | `grep -rn onFini kbe/src` = 0 hits |
| `onCellAppDeath(addr)` | A cellapp died (`addr = (ip, port)` tuple, numeric network order); suppressed while this baseapp is itself shutting down | `baseapp.cpp:673-700` (tuple built `:679-684`, guard `:676-679`) |
| `onBaseAppData(key, value)` / `onBaseAppDataDel(key)` | `KBEngine.baseAppData` was written / deleted on any baseapp | `baseapp.cpp:3707,3688` (from `onBroadcastBaseAppDataChanged`) |
| `onGlobalData(key, value)` / `onGlobalDataDel(key)` | `KBEngine.globalData` written / deleted cluster-wide | `kbe/src/lib/server/entity_app.h:1308,1290` |
| `onLoseChargeCB(orderID, dbID, success, datas)` | `charge()` order lost or unknown when interfaces responds | `baseapp.cpp:3603` |
| `onAutoLoadEntityCreate(entityType, dbID)` | An auto-load entity (`writeToDB` with `shouldAutoLoad`) is created at startup. If implemented, script-side creation replaces the engine default `createEntityAnywhereFromDBID`. Runs before `onBaseAppReady` | `kbe/src/server/baseapp/entity_autoloader.cpp:90-97` |

## 9. Module attributes

### `KBEngine.entities`

Live-entity registry for this process (`ENTITY_ID → strong-ref PyObjectPtr`).
Lifetime/garbage semantics are documented once in
[entity-lifecycle-reference](entity-lifecycle-reference.md); installed at
`kbe/src/lib/server/entity_app.h:411`.

### `KBEngine.baseAppData`

Dict-like object **replicated across all baseapps**. Top-level assignments
broadcast to every baseapp; mutations of a value's internals do **not**
broadcast (the classic `[1,2,3]` vs `[1,7,3]` pitfall from the source
material stands). Keys/values must be serializable by the engine. Writes
trigger `onBaseAppData` / `onBaseAppDataDel` everywhere. Installed
`baseapp.cpp:461` (`GlobalDataClient(DBMGR_TYPE, GlobalDataServer::BASEAPP_DATA)`,
`:457`); change ingestion `baseapp.cpp:3654+`.

### `KBEngine.globalData`

Same contract as `baseAppData` but replicated across **baseapps and
cellapps**; changes raise `onGlobalData` / `onGlobalDataDel`.
`kbe/src/lib/server/entity_app.h:419`, callbacks `:1308,1290`.

### `KBEngine.component`

Read-only string naming the running component type — `'baseapp'` on this
process. `kbe/src/lib/pyscript/script.cpp:248`.

## 10. Constants

| Constant | Meaning | Grounding |
| --- | --- | --- |
| `LOG_TYPE_NORMAL / INFO / ERR / DBG / WAR` | Log levels for `scriptLogType` | `entity_app.h:455-478` |
| `NEXT_ONLY` | One-shot sentinel for `shouldAutoArchive` / `shouldAutoBackup`: run at the next scheduled pass, then flip to False | `entity_app.h:480` |
| `LOG_ON_ACCEPT / LOG_ON_REJECT / LOG_ON_WAIT_FOR_DESTROY` | Return values of `Proxy.onLogOnAttempt`; values 1/0/2 | `baseapp.cpp:463-476`; enum `kbe/src/server/baseapp/proxy.h:24-26`; interpreted in `baseapp.cpp:3919-3962` |
| `APP_FLAGS_NONE`, `APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING` | Process flags for `setAppFlags` | `baseapp.cpp:419-424`; `common.h:348-352` |

## 3.7 source material vs fork 3.12 deviations

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `onFini` | Callback fires after the engine is officially shut down | No `onFini` hook exists at HEAD; only client_lib/bots know an `onFinish` | Fork | `grep -rn onFini kbe/src` = 0 hits; `server/tools/bots/bots.cpp:125` (`onFinish`) |
| `onReadyForLogin` return | Return ≥ 1.0 means ready | `True` → ready (v=100); a numeric return is compared against `0.9999`, not 1.0, and is otherwise reported as progress percent | Fork | `initprogress_handler.cpp:213-246` |
| `genUUID64` uniqueness source | Depends on baseapp startup parameter `gus` | Guard checks `g_componentGlobalOrder` ∈ 1..65535 (warn once); id = timestamp + per-second counter | Fork | `lib/pyscript/script.cpp:91-108`; `lib/common/platform.h:738-770` |
| `KBEngine.MemoryStream()` on baseapp | Listed as a baseapp-module constructor | No registration on the baseapp (`EntityApp`) chain; only `PythonApp` tools register it — **待取证** at runtime | Fork | `lib/server/python_app.cpp:271` present; `entity_app.h:407-453` absent |
| `baseAppData` delete-callback name | Attribute text says "See: KBEngine.onBaseAppData and KBEngine.onDelBaseAppData" | The registered callback name is `onBaseAppDataDel` — the source text's `onDelBaseAppData` does not exist | Fork | `baseapp.cpp:3688` |
| `roundTripTime` Linux-only claim | "only takes effect under Linux" | Not verified either way | — | **待取证**: read `Proxy::pyGetRoundTripTime` (`proxy.cpp:445`) against preprocessor guards, then re-classify |
| 3.7→3.12 script-layer deltas for this face | — | Nothing in this face touches str/bytes/int semantics changed by 3.8–3.12; verified items in python-version-baseline §4 apply by reference | Python | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html); see python-version-baseline §4 |

## References

- Registration map: `kbe/src/server/baseapp/baseapp.cpp:419-476,504-519`,
  `kbe/src/lib/server/entity_app.h:407-487`,
  `kbe/src/lib/pyscript/{pywatcher.cpp:184-185, script.cpp:248,258,
  pyurl.cpp:23, py_gc.cpp:224}`,
  `kbe/src/lib/server/{py_file_descriptor.cpp:22-35, python_app.cpp:271}`
- Callbacks: `kbe/src/server/baseapp/{initprogress_handler.cpp:179-241,
  entity_autoloader.cpp:90-97, baseapp.cpp:275-285,321-390,3595-3610,
  3636-3647,3688-3710,673-700}`, `kbe/src/lib/server/entity_app.h:1290,1308,1461`
- Python domain: [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)
- Companion pages: [api-baseapp-entity](api-baseapp-entity.md),
  [python-version-baseline](python-version-baseline.md),
  [entity-lifecycle-reference](entity-lifecycle-reference.md),
  [fixed-directories-and-path-resolution](fixed-directories-and-path-resolution.md)
