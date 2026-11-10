# Interfaces process API reference (KB-API-005)

> Same claims, same citations; this EN page is canonical for line-number drift checks.
>
> **Scope**: the Python API surface of the **interfaces** process — the
> third-party platform integration point (account create/login check-out,
> billing). Rewritten from the official 3.7-era CHM-derived source material
> (`kbengine/docs/api/kbengine/interfaces/KBEngine.md`, 13.4k, 12 `def`
> sections; plus the thin `index.md`) — the material's wording is not
> trusted verbatim (chm-conversion glue like `ThisKBEngine`, broken
> parameter tables, Python 2 example code); every behavioral claim below is
> re-grounded in the fork source.
>
> **Grounding**: fork `kbe/src` at HEAD `6d12b8f`. Version baseline and
> deviation-annotation format follow
> [Python version baseline](python-version-baseline.md) (§7 template used in
> §6). Companion pages: [Baseapp API](api-baseapp.md) (`charge()` /
> `onLoseChargeCB` / `Proxy.getClientDatas` — the other ends of the flows
> documented here).
>
> **Coverage**: all 12 documented surface items — 7 `KBEngine` module member
> functions + 5 callbacks — plus the module's error-code constant face
> (`KBEngine.SERVER_SUCCESS` / `SERVER_ERR_*`, mentioned in the material's
> prose but not documented as a section; see §4).

## 1. How the interfaces Python face is assembled

The interfaces process is the smallest server-app Python face. It is a
bare `PythonApp` — **not** an `EntityApp` — so it has **no `Entity` class,
no `entities`, no `globalData`/`cellAppData`** (those are registered by
`EntityApp::installPyModules`, which never runs here). Reading order for
"is this API available on interfaces?":

| Layer | What it registers | Evidence |
| --- | --- | --- |
| Interfaces-specific `KBEngine` module functions | `chargeResponse`, `accountLoginResponse`, `createAccountResponse`, `executeRawDatabaseCommand`; int constants `SERVER_ERR_*` (38 of them, loop over `SERVER_ERR_STR`) | `kbe/src/server/tools/interfaces/interfaces.cpp:176-190` (`Interfaces::onInstallPyModules`; constants `:178-184`, methods `:186-189`) |
| Shared server-app face (`PythonApp`) | `MemoryStream`, `publish`, `scriptLogType`, `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath`, `debugTracing`, module-level `addTimer`/`delTimer`, `registerReadFileDescriptor`/`registerWriteFileDescriptor` (+`deregister…`) | `kbe/src/lib/server/python_app.cpp:271-296`, `:329-334` |
| Interpreter layer (all script-bearing apps) | `urlopen`, `component` string, `genUUID64`, `addWatcher`/`delWatcher` | `lib/pyscript/pyurl.cpp:23`, `script.cpp:248`, `:258`, `pywatcher.cpp:184-185` |
| **Absent** vs baseapp/cellapp | `createEntity`, `charge`, `time`-adjacent entity APIs, the `Entity` class, `globalData`/`cellAppData`, `entities` | `Interfaces : public PythonApp` (`interfaces.h:24`); no `Entity` registration site exists under `server/tools/interfaces/` |

Because `PythonApp` (unlike `EntityApp`) does not install the error-code
constants, the interfaces process registers its own copy of the
`SERVER_ERR_*` block at `interfaces.cpp:178-184` — same string table,
same values (`server_errors.h:57`).

The **entry script** is configured per-process:
`kbengine_defaults.xml → interfaces → entryScriptFile`, default `kbemain`
(`kbe/res/server/kbengine_defaults.xml:234-238`); the engine imports it as
a module (`lib/server/python_app.cpp:338-342`) and every callback
dispatch below targets that module via `getEntryScript()`, not an entity.
The fork ships the template portal at
`kbe/res/sdk_templates/server/python_assets/scripts/interface/kbemain.py`
(136 lines) — note the template directory is `scripts/interface/`
(singular), matching what the engine resolves from `entryScriptFile`;
the deployed game assets' `scripts/interfaces/` lives in the separate
assets repo, not in this fork.

## 2. KBEngine module member functions (interfaces face)

All 7 functions from the source material, with fork-verified semantics.

### `KBEngine.addTimer(initialOffset, repeatOffset, callbackObj)`

Registers a timer on the interfaces main loop. **Trigger timing**: the
callback first fires after `initialOffset` seconds of game time, then
every `repeatOffset` seconds while it is set.

- Registration: shared app face, `python_app.cpp:329`; implementation
  `PythonApp::__py_addTimer` `python_app.cpp:721-753`,
  `ScriptTimers::addTimer` `lib/server/script_timers.cpp:40-89`.
- **Fork signature deviation**: the parse string is `"ffO"`
  (`python_app.cpp:726`) — all three arguments are **required**. The
  material's `repeatOffset=0, callbackObj=None` defaults do not exist on
  this face; a 2-argument call raises `TypeError`. (§6 #1)
- Non-callable `callbackObj` → `TypeError` (`python_app.cpp:731`).
- Negative `initialOffset` is clamped to 0 with a warning
  (`script_timers.cpp:46-50`). `repeatOffset <= 0` means single-shot
  (`repeatTicks = 0`, `script_timers.cpp:53-61`).
- The callback is invoked as `callbackObj(timerID)`
  (`ScriptTimerHandler::handleTimeout`, `python_app.cpp:31-40` — the
  `int` id is the value returned by `addTimer`).
- Returns the timer id (`int`). Timer-table exhaustion returns 0 from
  `ScriptTimers::addTimer` (`script_timers.cpp:85-88`), which becomes a
  `ValueError: Unable to add timer` (`python_app.cpp:739-746`).

### `KBEngine.delTimer(id)`

Removes a registered timer.

- Registration: `python_app.cpp:330`; implementation
  `python_app.cpp:755-775`, `ScriptTimers::delTimer`
  `script_timers.cpp:96-105`.
- Single-shot timers are removed automatically when they fire — the
  timer-table entry is dropped by `ScriptTimers::releaseTimer`
  (`script_timers.cpp:108+`) on timer completion, so no explicit
  `delTimer` is needed for them.
- **Fork behavior deviation**: the material says an invalid id "will
  generate an error". The fork formats a `TypeError` but then prints and
  clears it (`PyErr_PrintEx`, `python_app.cpp:768-771`) and **returns
  `-1`** instead of raising into the script. `delTimer` of a valid id
  returns the id. (§6 #2)

### `KBEngine.accountLoginResponse(commitName, realAccountName, extraDatas, errorCode)`

Submits the script's verdict for an `onRequestAccountLogin` callback.
**Trigger timing**: call it after your third-party platform check
finishes; the engine is parked on the pending-request map until then.

- Registration: `interfaces.cpp:187`; implementation
  `Interfaces::accountLoginResponse` `interfaces.cpp:651-695`; the
  `__py_` shim parses `"ssy#H"` — three strings + an unsigned-short
  error code (`interfaces.cpp:704`).
- Looks the request up by `commitName`; unknown name → `ERROR_MSG` log
  and the response is dropped (`interfaces.cpp:654-665`).
- On success, sends `DbmgrInterface::onLoginAccountCBBFromInterfaces`
  to the requesting dbmgr with `baseappID, commitName, realAccountName,
  password, errorCode` **plus the original request blob
  (`task->postDatas`) and your `extraDatas` appended**
  (`interfaces.cpp:672-676`) — so here the material's "extraDatas can
  forward data to the third party and back" claim holds. The pending
  request is then erased (`interfaces.cpp:691`).
- `realAccountName` is the alias-mapping hook: the login continues under
  the name you return, not necessarily the submitted one.
- `errorCode`: `KBEngine.SERVER_SUCCESS` (0) permits the login; the
  template also demonstrates `SERVER_ERR_LOCAL_PROCESSING` (35) =
  "login accepted, but dbmgr must still verify the password"
  (`kbemain.py:113` + comment; constant `server_errors.h:52`).

### `KBEngine.createAccountResponse(commitName, realAccountName, extraDatas, errorCode)`

Submits the script's verdict for an `onRequestCreateAccount` callback.

- Registration: `interfaces.cpp:188`; implementation
  `Interfaces::createAccountResponse` `interfaces.cpp:539-581`; `__py_`
  shim `"ssy#H"` (`interfaces.cpp:592`).
- Same lookup-by-`commitName` + drop-on-unknown behavior as above
  (`interfaces.cpp:542-553`).
- **Fork behavior deviation**: the reply bundle
  `DbmgrInterface::onCreateAccountCBFromInterfaces` carries only
  `baseappID, commitName, realAccountName, password, errorCode`
  (`interfaces.cpp:560-561`) — the `extraDatas` argument is accepted but
  **never forwarded**. The material claims extraDatas "can forward the
  data to a third-party platform and provide an opportunity to modify
  it" for both response functions; on this face it is only true for
  `accountLoginResponse`. (§6 #5)
- Pending request erased at `interfaces.cpp:579`.

### `KBEngine.chargeResponse(orderID, extraDatas, errorCode)`

Submits the billing verdict for an `onRequestCharge` callback.

- Registration: `interfaces.cpp:186`; implementation
  `Interfaces::chargeResponse` `interfaces.cpp:766-839`; `__py_` shim
  parses `"sy#H"` (`interfaces.cpp:848`).
- **Fork validation the material omits**: `errorCode >= SERVER_ERR_MAX`
  (38) makes the whole call a **silent no-op** — the order stays parked
  and the callback never reaches baseapp (`interfaces.cpp:851-855`). Any
  out-of-range "custom" error code you invent is discarded. (§6 #7)
- Known order (`interfaces.cpp:812-837`): stores your `extraDatas` into
  the order record (`:813-814`) and sends `DbmgrInterface::onChargeCB`
  to the dbmgr channel with `baseappID, ordersID, dbid, extraDatas,
  cbid, errorCode` (`:817-823`); baseapp then completes the entity's
  `charge()` callback. The order record is erased (`:837`).
- **Unknown order** (already timed out of the map or never registered):
  the fork broadcasts `onChargeCB` to **all** dbmgr channels with
  zeroed `baseappID`/`dbid`/`cbid` (`interfaces.cpp:779-810`) — the
  source comment notes this deliberately reaches baseapp's
  `onLoseChargeCB` for platform callbacks that arrive without a
  registered order (cross-ref [baseapp API](api-baseapp.md),
  `baseapp.cpp:3603`). No dbmgr channel at all → `ERROR_MSG` and drop
  (`:805-809`).

### `KBEngine.executeRawDatabaseCommand(command, callback, threadID, dbInterfaceName)`

Executes a raw DB command through dbmgr. The material's caveat stands
and is structural: entity data written this way can be overwritten by a
later entity archive — prefer the entity DB API for entity data.

- Registration: `interfaces.cpp:189`; `__py_` shim
  `interfaces.cpp:240-283`: 1-4 argument forms
  (`"s#"`, `"s#|O"`, `"s#|O|i"`, `"s#|O|i|O"`, `:249-256`); a
  `dbInterfaceName` that is not in
  `kbengine_defaults.xml → dbmgr → databaseInterfaces` raises `TypeError`
  (`:273-278`); default interface name is `"default"` (`:267-272`).
- `threadID` is `ENTITY_ID eid` in the fork: pass an entity DBID/id and
  the command is queued behind that entity's buffered DB writes instead
  of running on the general thread pool. Verified at the dbmgr side:
  `eid == -1` → `DBUtil::pThreadPool(...).addTask(DBTaskExecuteRawDatabaseCommand)`
  (`dbmgr.cpp:803-810`); `eid > -1` → `Buffered_DBTasks::addTask(DBTaskExecuteRawDatabaseCommandByEntity)`
  (`dbmgr.cpp:815-826`). Exact ordering guarantees inside the
  buffered-task queue: 待取证 (path `kbe/src/server/dbmgr/buffered_dbtasks.cpp`).
- Transport: the interfaces process picks a **random** registered dbmgr
  (`interfaces.cpp:295-306`), sends
  `DbmgrInterface::executeRawDatabaseCommand` with `eid`,
  `dbInterfaceIndex`, its own component id/type and a saved callback id
  (`interfaces.cpp:322-333`). No dbmgr found → `ERROR_MSG`, return
  without callback (`:303-306`).
- **Callback** `(result, rows, insertid, error)` — delivered by
  `Interfaces::onExecuteRawDatabaseCommandCB` (`interfaces.cpp:339-460`),
  invoked on the main thread when dbmgr replies:
  - error string present → `result = None`, `rows = None`,
    `insertid = None`, `error = str` (`:417-432`);
  - result set (`nfields > 0`) → `result` is a list of rows, each row a
    list of **`bytes`** cells (`PyBytes_FromStringAndSize`,
    `:391`), SQL `NULL` → `None` (`:380-384`); then `rows`/`insertid`
    are `None` (`:365-367`).
  - no result set (e.g. DELETE) → `result = None`, `rows` = affected-row
    count, `insertid` = last-insert id, both `int` (`:400-413`).
  - The material's "each line is a list of strings" is a Python-2-era
    wording; on the fork you get `bytes` and must decode. (§6 #9)

### `KBEngine.urlopen(url, callback, postData, headers)`

Asynchronous HTTP(S) request, backed by libcurl
(`lib/network/http_utility.h:86`, SSL options `:127+`). The request runs
off the main thread; the callback is invoked on the main loop.

- Registration: interpreter layer, `PyUrl::initialize`
  (`lib/pyscript/pyurl.cpp:15-25`, hooked at `script.cpp:286`);
  implementation `PyUrl::__py_urlopen` `pyurl.cpp:69-215`.
- Argument forms (fork, `pyurl.cpp:73-181`): `(url)` only fetch-and-drop;
  `(url, callback)`; **a 3-argument form the material does not document**
  where the third argument is interpreted as `headers` if it is a `dict`
  and as `postData` if it is `bytes` — anything else raises
  `AssertionError` (`pyurl.cpp:78-117`); and the 4-argument form
  `(url, callback, postData, headers)` where `postData` must be `bytes`
  (`:160-166`). Non-`str:str` header dicts raise `AssertionError`
  (`:94-100`, `:136-143`); a non-callable callback raises
  `AssertionError` (`:174-178`). No `postData` → GET.
- **Return value** (undocumented in the material): an `int` request-setup
  status — `0` = `OK`, other values per `Request::Status`
  (`pyurl.cpp:197-222`, `http_utility.h:89-94`). It is **not** the HTTP
  code; that arrives in the callback.
- **Callback** `(httpcode, data, headers, success, url)` — assembled as a
  5-tuple in `PyUrl::onHttpCallback` (`pyurl.cpp:38-65`): `httpcode`
  int; `data` str (received body); **`headers` is a raw string of the
  received header block** (`PyUnicode_FromString(pRequest.getReceivedHeader())`,
  `pyurl.cpp:50`) — **not the dict the material claims**; `success` bool;
  `url` str. (§6 #8)
- The callback object is kept alive in `PyUrl::pyCallbacks`
  (`pyurl.cpp:12`, `:190`) until it fires, so a local function reference
  will not be GC'd mid-request.

## 3. KBEngine module callbacks (interfaces face)

All 5 are dispatched on the entry-script module (`getEntryScript()`).
All incoming requests arrive as network messages on the interfaces
process (`interfaces_interface.h:50`, `:53`, `:56`); each handler
stashes a pending-request record first, then calls the script.

| Callback | Trigger (verified call site) | Format string |
| --- | --- | --- |
| `onInterfaceAppReady()` | `Interfaces::initializeEnd`, after script load, main-tick timer and dbmgr-less init — before the telnet server starts (`interfaces.cpp:151-158`; timer `:141-142`) | `""` |
| `onInterfaceAppShutDown()` | `Interfaces::onShutdownBegin` (`interfaces.cpp:73-80`) | via `SCRIPT_OBJECT_CALL_ARGS0` (`py_macros.h:657`) which **silently skips** the call if the entry script has no such attribute (`PyObject_HasAttrString` guard) |
| `onRequestCreateAccount(registerName, password, datas)` | `Interfaces::reqCreateAccount` (`interfaces.cpp:488-533`); called when dbmgr forwards a client register request. Duplicate in-flight name is silently ignored (`:501-506`). Profiled as `onRequestCreateAccount` (`profile.cpp:7`) | `"ssy#"` (`:525-532`) — both passwords and `datas` arrive as `str`/`bytes` (`y#`) |
| `onRequestAccountLogin(loginName, password, datas)` | `Interfaces::onAccountLogin` (`interfaces.cpp:605-650`); dbmgr→interfaces login check. Duplicate in-flight name ignored (`:612-617`). Profiled (`profile.cpp:8`) | `"ssy#"` (`:636-643`) |
| `onRequestCharge(ordersID, entityDBID, datas)` | `Interfaces::charge` (`interfaces.cpp:717-763`); fired when baseapp's `KBEngine.charge` is relayed dbmgr→interfaces (baseapp entry `baseapp.cpp:3435`). Duplicate order id rejected with `ERROR_MSG` (`:736-741`). Profiled (`profile.cpp:9`) | `"sKy#"` (`:750-758`) — **`ordersID` is a `str`**, `entityDBID` is `uint64` (`K`) |

The material's note that these callbacks "must be implemented in the
portal module" matches the implementation: every dispatch above calls
`PyObject_CallMethod(getEntryScript().get(), …)`; a missing callback
yields `NULL` → `SCRIPT_ERROR_CHECK()` prints the traceback and the
process continues (`scriptobject.h:39-50`).

**Dispatch contract**: after `onRequest*`, the engine parks a pending
record keyed by the submitted name/order id and returns to the network
loop — interfaces is single-threaded (the shipped template warns against
blocking HTTP libs for exactly this reason, `kbemain.py:7`). The script
must eventually call the matching `*Response` or the record stays until
process exit, where a `WARNING_MSG` dump lists discards
(`interfaces.cpp:49-71`).

## 4. Module constant face (error codes)

The material references `KBEngine.SERVER_SUCCESS` and
`KBEngine.SERVER_ERROR_*` only in prose. The fork face: all 38 entries
of `SERVER_ERR_STR` (`lib/server/server_errors.h:57-100`) are installed
as module ints at `interfaces.cpp:178-184`, value = index.

- `KBEngine.SERVER_SUCCESS = 0` (`server_errors.h:17`).
- `SERVER_ERR_MAX = 38` is the table sentinel — it is **not** installed
  as a constant, but it bounds what `*Response` calls accept
  (`interfaces.cpp:851-855`).
- `SERVER_ERR_LOCAL_PROCESSING = 35` (`server_errors.h:52`): the
  template's login path uses it to mean "accepted, dbmgr still checks
  the password" (`kbemain.py:113`).
- The full table lives in `kbe/res/server/server_errors.xml` on the
  deployment side, as the material notes.

## 5. The three request/response flows

| Flow | Chain | Response routing |
| --- | --- | --- |
| Account create | client → loginapp → dbmgr (`Dbmgr::reqCreateAccount`, `dbmgr.cpp:683-697`) → `findBestInterfacesHandler()` picks `InterfacesHandler_Interfaces` when dbmgr is configured with interfaces, else `InterfacesHandler_Dbmgr` handles it locally (`dbmgr/interfaces_handler.cpp:20-31`; forward `:281`) → `onRequestCreateAccount` | `createAccountResponse` → `onCreateAccountCBFromInterfaces` → dbmgr → baseapp |
| Account login | client → loginapp → dbmgr → same handler split → `onAccountLogin` (`interfaces.cpp:605`) | `accountLoginResponse` → `onLoginAccountCBBFromInterfaces` (carries `postDatas` + `extraDatas`, `interfaces.cpp:672-675`) → dbmgr → baseapp → `Proxy` (entity-side reader: `getClientDatas`, `proxy.cpp:24`) |
| Billing | baseapp `KBEngine.charge` (`baseapp.cpp:3435`) → dbmgr → `InterfacesHandler_Interfaces::charge` (`interfaces_handler.cpp:544-575`) → `onRequestCharge` | `chargeResponse` → `onChargeCB` → dbmgr → baseapp entity callback or `onLoseChargeCB` (`baseapp.cpp:3603`) |

Order bookkeeping: each charge order carries a `timeout` stamp computed
from `interfaces_orders_timeout_` config
(`interfaces.cpp:721`; default `0` at `lib/server/serverconfig.cpp:83`,
read from config at `:532`) — **but nothing consumes that field at this
HEAD** (grep over `server/tools/interfaces/`: only the assignment and
the struct member, `orders.h:38`). There is no timeout sweep that
evicts stale orders; a charge whose response never arrives occupies its
map entry until process exit. 待取证 whether upstream intends a
periodic sweep that this fork dropped.

## 6. Deviation annotations (§7 template, [Python version baseline](python-version-baseline.md))

| Item | Official 3.7-era source material says | Fork 3.12 (this repo) actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `addTimer` signature | `addTimer(initialOffset, repeatOffset=0, callbackObj=None)` — defaults exist | All three arguments required; 2-arg call raises `TypeError` | Fork | `python_app.cpp:721-726` (`PyArg_ParseTuple(args, "ffO", …)`) |
| `delTimer` invalid id | "will generate an error" (implies raised into script) | Formats `TypeError`, prints-and-clears it, **returns `-1`**; no exception reaches the script | Fork | `python_app.cpp:766-771` |
| `createAccountResponse` extraDatas | "can forward the data … and provide an opportunity to modify it" (parallel wording to login) | Parameter accepted but **not forwarded** — reply bundle omits it | Fork | `interfaces.cpp:560-561`; contrast login `interfaces.cpp:672-675` |
| `onRequestCharge` ordersID type | `uint64` (template docstring repeats this, `kbemain.py:82-83`) | **`str`** — format `"sKy#"`; only `entityDBID` is `K`(uint64) | Fork | `interfaces.cpp:750-758` |
| `chargeResponse` errorCode range | "integer, error code" — any value implied | Values `>= SERVER_ERR_MAX`(38) are silently discarded; the order stays pending | Fork | `interfaces.cpp:845-855`, `server_errors.h:55` |
| `urlopen` callback `headers` | "is an dict", e.g. `{"Content-Type": …}` | **Raw header block as `str`** | Fork | `pyurl.cpp:50` (`PyUnicode_FromString(pRequest.getReceivedHeader())`) |
| `urlopen` 3-arg form | Only 2-arg (GET) and 4-arg (POST) documented | 3-arg form: third arg is `headers` if `dict`, `postData` if `bytes`, else `AssertionError` | Fork | `pyurl.cpp:78-117` |
| `executeRawDatabaseCommand` result cells | "a list of strings containing field values" | Cells are **`bytes`** (decode yourself); SQL `NULL` → `None` | Fork | `interfaces.cpp:380-389` |
| Material example code | Python 2 (`print "…"`, `kbengine/interfaces/KBEngine.md:49`) | Fork embeds CPython 3.12 — example is stale; see baseline doc | Python | [python-version-baseline](python-version-baseline.md) §1-§2; `print` statement removed in Python 3 |
| Callback placement | "must be implemented in the portal module (entryScriptFile)" | Confirmed: dispatch targets `getEntryScript()`; missing callback prints traceback via `SCRIPT_ERROR_CHECK` and the process continues | Fork | `interfaces.cpp:525-533`, `:636-643`, `:750-758`; `scriptobject.h:39-50` |
| Entry-script location | "scripts/interface directory" (index.md) | Engine resolves `<interfaces><entryScriptFile>` = `kbemain`; fork template at `res/sdk_templates/.../scripts/interface/kbemain.py`; deployed `scripts/interfaces/` belongs to the assets repo (outside this fork) | Fork | `kbengine_defaults.xml:234-238`; `python_app.cpp:338-342` |
| Charge order timeout | Not mentioned | `interfaces_orders_timeout_` stamp computed but never consumed at this HEAD — no eviction sweep | Fork | `interfaces.cpp:721`, `serverconfig.cpp:83/:532`, `orders.h:38` |

## 7. 待取证 (open evidence items)

1. **Buffered-task ordering** for entity-threaded
   `executeRawDatabaseCommand` calls — the split
   (`dbmgr.cpp:803-810` vs `:815-826`) is verified; ordering guarantees
   inside `Buffered_DBTasks` are not yet pinned to file:line
   (`kbe/src/server/dbmgr/buffered_dbtasks.cpp`).
2. **Charge-order timeout sweep** — whether upstream has an eviction
   path that this fork lacks, or the `timeout` field is dead upstream
   too (compare upstream v3.x line when reachable).
3. **dbmgr → loginapp result relay** details beyond the interfaces-side
   bundles (`onCreateAccountCBFromInterfaces`,
   `onLoginAccountCBBFromInterfaces`) — belongs to the KB-API-006
   loginapp/dbmgr scope; only the interfaces-side half is grounded here.
