# Loginapp / Dbmgr / Logger face API reference (KB-API-006)

> Bilingual twin: [中文](../zh/knowledge/api-loginapp-dbmgr-logger.md). Same
> claims, same citations; this EN page is canonical for line-number drift
> checks.
>
> **Scope**: the script-visible `KBEngine` face of the three thin server
> processes — **loginapp**, **dbmgr** and **logger** — as documented by the
> official 3.7-era CHM source material (`kbengine/docs/api/kbengine/
> {loginapp,dbmgr,logger}/{KBEngine.md,index.md}`; 9 + 8 + 7 documented
> names). The material's wording is not trusted verbatim (chm-conversion
> glue like `ThisKBEnginemodule`, duplicated `onLoginAppReady` sections);
> every behavioral claim below is re-grounded in the fork source. One
> article covers all three faces because they are one face: all three
> processes derive from `PythonApp` and differ only in which entry-script
> callbacks the C++ side invokes.
>
> **Grounding**: fork `kbe/src` at HEAD `6d12b8f` (grounding base
> `c2a3b8f`), verified at HEAD on 2026-11-04. Note the fork moved the
> logger process to `kbe/src/server/tools/logger/` (upstream 3.7 has
> `kbe/src/server/logger/`); all anchors below use the fork layout.
> Version baseline and deviation-annotation format follow
> [Python version baseline](python-version-baseline.md) (§7 template used
> in §5). Sister pages: [baseapp face](api-baseapp.md),
> [cellapp face](api-cellapp.md),
> [client face](api-client.md).
>
> **Coverage**: all 24 documented surface names are covered — loginapp
> 3 member functions + 6 callbacks, dbmgr 4 member functions + 4 callbacks,
> logger 3 member functions + 4 callbacks (`onReadyForShutDown` is
> documented for both dbmgr and logger; counted per face). The shared
> `PythonApp` face actually installed at runtime is significantly larger
> than the docs' 3-function list (§1); the extra names are enumerated with
> anchors as well.

## 1. How the face is assembled

None of the three processes registers an app-specific `KBEngine` method.
The entire module face comes from the shared `PythonApp` layer plus the
`Script::install` core:

| Site | Registers |
| --- | --- |
| `kbe/src/lib/server/python_app.cpp:230-349` (`PythonApp::installPyModules`, base class of all three apps) | `MemoryStream` (`:271`), `publish` (`:275`), `scriptLogType` (`:278`), `getResFullPath` (`:281`), `hasRes` (`:284`), `open` (`:287`), `listPathRes` (`:290`), `matchPath` (`:293`), `debugTracing` (`:296`); int constants `LOG_TYPE_NORMAL/INFO/ERR/DBG/WAR` (`:298-322`), `NEXT_ONLY` (`:323`); `addTimer`/`delTimer` (`:329-330`), `registerReadFileDescriptor`/`registerWriteFileDescriptor`/`deregisterReadFileDescriptor`/`deregisterWriteFileDescriptor` (`:331-334`) |
| `kbe/src/lib/pyscript/script.cpp:246-257` (`Script::install`) | `component` string attribute (`:248`; per-app name from `COMPONENT_NAME_EX`) |
| `kbe/src/lib/pyscript/script.cpp:258` | `genUUID64` |
| `kbe/src/lib/pyscript/script.cpp:286` + `kbe/src/lib/pyscript/pyurl.cpp:23` | `urlopen` (installed by `PyUrl::initialize` during `Script::install`) |

Derivations: `Loginapp : PythonApp` (`kbe/src/server/loginapp/loginapp.h:22`),
`Dbmgr : PythonApp` (`kbe/src/server/dbmgr/dbmgr.h:32`),
`Logger : PythonApp` (`kbe/src/server/tools/logger/logger.h:49`).
`PythonApp::installPyModules` ends by calling the virtual
`onInstallPyModules()` (`python_app.cpp:336`); loginapp and dbmgr leave it
empty (loginapp.cpp has no `APPEND_SCRIPT_MODULE_METHOD` at all; dbmgr adds
exactly one method, §3), and logger adds none.

What the three apps share beyond the docs list — but that the docs never
mention for these processes — is therefore the full resource/timer/IO face
above. The one **notable absence** is the `SERVER_ERR_*` int constants
(including `SERVER_SUCCESS`): those are registered only by
`EntityApp::installPyModules` (`kbe/src/server/../entity_app.h:485-489`,
values from `kbe/src/lib/server/server_errors.h:57+`), and loginapp/dbmgr/
logger are *not* EntityApps. See the deviations table (row D2).

Also worth stating honestly: the official index pages claim the per-process
scripts live in `scripts/login`, `scripts/db`, `scripts/logger`. This fork's
`kbe/res/scripts/` ships only `common/` (holding the default XMLs such as
`kbengine_defaults.xml`); no login/db/logger entry scripts are included in
the repository, so the callbacks below can only be exercised with entry
scripts supplied by the deployment.

## 2. Loginapp face

Loginapp handles entity registration/login requests
(`docs/api/kbengine/loginapp/index.md:1-5`). Script entry point is
`kbengine_defaults.xml -> entryScriptFile`; every callback below is invoked
on that entry module.

### Member functions

- `addTimer(initialOffset, repeatOffset=0, callbackObj=None)` /
  `delTimer(id)` — shared face, §2.1 of
  [api-baseapp](api-baseapp.md) applies; anchors
  `python_app.cpp:329-330` (registration), `:721-753` (`__py_addTimer`),
  `:755-771` (`__py_delTimer`). Fork detail: `__py_addTimer` parses
  `"ffO"` — the callback argument is **required**, not optional with a
  `None` default (deviation row D1). Repeat offsets ≤ 0 produce a
  single-shot timer (`kbe/src/lib/server/script_timers.cpp:56-66`:
  `repeatTicks` stays 0 unless `repeatOffset > 0`); negative
  `initialOffset` is clamped to 0 with a warning
  (`script_timers.cpp:43-49`), rather than "ignored" as the material says.
- `urlopen(url, callback, postData, headers)` — shared face; registration
  `pyurl.cpp:23`, implementation `PyUrl::__py_urlopen`
  (`pyurl.cpp:69+`, five-arg callback `(httpcode, data, headers, success,
  url)`). Same semantics on all `PythonApp` processes.

### Callbacks

- `onLoginAppReady()` — invoked at the end of `Loginapp::initializeEnd`
  with format `""` (`loginapp.cpp:170-180`; call at `:174-175`).
- `onLoginAppShutDown()` — invoked from `Loginapp::onShutdownBegin`
  (`loginapp.cpp:59-62`).
- `onRequestLogin(loginName, password, clientType, datas)` — invoked from
  `Loginapp::login` with format `"ssby#"` (`loginapp.cpp:1012-1018`).
  Return contract verified: the C++ side accepts either a bare error code
  or a **5-tuple** parsed with `"H|s|s|b|y#"`
  (`errorno, loginName, password, clientType, datas`; parse at
  `loginapp.cpp:1024-1029`, non-sequence / wrong-size results rejected at
  `:1065-1072`). A non-`SERVER_SUCCESS` code routes to `_loginFailed`
  (`:1052-1056`); an empty `loginName` fails with `SERVER_ERR_NAME`
  (`:1058-1064`). Successful requests are tracked in `pendingLoginMgr_`
  (`pendingLoginMgr.h`; find/insert at `loginapp.cpp:1086-1094`), which is
  the queue the material's prose alludes to.
- `onLoginCallbackFromDB(loginName, accountName, errorno, datas)` — the
  dbmgr round-trip callback, invoked at `loginapp.cpp:1229-1235` while
  resolving the pending record (`:1222`).
- `onRequestCreateAccount(accountName, password, datas)` — invoked with
  format `"ssy#"` (`loginapp.cpp:367-373`). Return contract: bare error
  code or tuple `(errorno, accountName, password, datas)` — violations are
  logged at `loginapp.cpp:386` and `:409` (which spells out the tuple
  shape). Requests tracked in `pendingCreateMgr_` (find `:348`, insert
  `:512`).
- `onCreateAccountCallbackFromDB(accountName, errorno, datas)` — invoked
  at `loginapp.cpp:588-594`; the pending record is removed at `:609`.

Note: the material's recommended return expression
`(KBEngine.SERVER_SUCCESS, loginName, ...)` cannot run on this fork's
loginapp as written, because `SERVER_SUCCESS` is not installed on
`PythonApp` processes (deviation row D2).

## 3. Dbmgr face

Dbmgr handles entity data storage and load/query
(`docs/api/kbengine/dbmgr/index.md:1-5`).

### Member functions

- `addTimer` / `delTimer` / `urlopen` — identical to loginapp (§2).
- `executeRawDatabaseCommand(command, callback, threadID, dbInterfaceName)`
  — the only app-specific `KBEngine` method dbmgr registers:
  `dbmgr.cpp:355` (`APPEND_SCRIPT_MODULE_METHOD` inside
  `Dbmgr::installPyModules`, which otherwise just chains
  `PythonApp::installPyModules` + `EntityDef` module installation,
  `dbmgr.cpp:331-333`).
  - Argument parsing `Dbmgr::__py_executeRawDatabaseCommand`
    (`dbmgr.cpp:834-880`): 1-4 positional args via `"s#|O|i|O"` —
    `command` (bytes/str), optional `callback`, optional `threadID`
    (stored as `ENTITY_ID eid`), optional `dbInterfaceName` (defaults to
    `"default"` at `:860`; unknown interface names raise `TypeError` at
    `:865-870`). This matches the material's parameter table.
  - Dispatch: `Dbmgr::executeRawDatabaseCommand` (`:881-913`) saves the
    callback into the callback manager (`:905-908`), serializes it with
    the command, and hands it to the interface handler's thread pool;
    invalid interfaces / missing pools error out (`:892`, `:798`,
    `:808`, `:820`).
  - The callback receives `(result, rows, insertid, error)`; the reply
    path is `Dbmgr::onExecuteRawDatabaseCommandCB` (`:918-1035`, callback
    taken at `:1014-1032`).
  - The material's caveat that `threadID` doubles as an entity ID routed
    into that entity's archive queue corresponds to the `eid` parameter
    being forwarded with the command (`:876` → impl signature `:881`).

### Callbacks

- `onDBMgrReady()` — end of `Dbmgr::initializeEnd`
  (`dbmgr.cpp:306-313`).
- `onDBMgrShutDown()` — `Dbmgr::onShutdownBegin`
  (`dbmgr.cpp:153-156`).
- `onReadyForShutDown()` — polled from `Dbmgr::canShutdown` when the
  entry script defines it (`dbmgr.cpp:77-95`): the process exits only if
  the callback returns exactly `Py_True`; anything else yields
  `CAN_SHUTDOWN_STATE_USER_FALSE` and shutdown is re-asked later —
  matching the material's "return True to allow exit".
- `onSelectAccountDBInterface(accountName)` — invoked from
  `Dbmgr::selectAccountDBInterfaceName` with format `"s"`
  (`dbmgr.cpp:1240-1267`): the returned string selects the
  `databaseInterfaces` entry; an empty/unknown result is rejected with an
  error and falls back to `"default"` (`:1254-1258`). The material's
  "returns the interface name" contract is accurate; it is also called for
  *every* account-scoped dbmgr operation, not only logins (call sites
  include `accountNewPassword` routing, `dbmgr.cpp:1230-1235`).

## 4. Logger face

Logger collects logs output by the server processes
(`docs/api/kbengine/logger/index.md:1-5`). Fork layout note: the process
lives under `kbe/src/server/tools/logger/` (upstream: `kbe/src/server/logger/`).

### Member functions

- `addTimer` / `delTimer` / `urlopen` — identical to loginapp (§2). Logger
  itself registers no methods; its internal 20 Hz tick is a C++ dispatcher
  timer, not script-visible (`logger.cpp:123`).

### Callbacks

- `onLoggerAppReady()` — end of `Logger::initializeEnd`
  (`logger.cpp:126-135`).
- `onLoggerAppShutDown()` — `Logger::onShutdownBegin`
  (`logger.cpp:215-218`).
- `onReadyForShutDown()` — same `Py_True` gate as dbmgr, from
  `Logger::canShutdown` (`logger.cpp:175-192`).
- `onLogWrote(datas)` — invoked for every log item when the entry script
  defines it (`logger.cpp:286-316`; detection is cached in a function
  static at `:287`). `datas` is the fully formatted log line passed as
  bytes (`"y#"` format, `:290-294`). The fork's return-value contract goes
  beyond the material: returning `False` marks the item non-persistent
  (`:297-301`), returning a `str`/bytes **rewrites the persisted line**
  (`:303-316`), any other truthy return persists the original. The
  material documents only the argument, not these return semantics.

## 5. 3.7 source material vs fork 3.12 deviations

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| D1 `addTimer` `callbackObj` default | `callbackObj=None` — optional parameter | Callback is **required**: `PyArg_ParseTuple(args, "ffO")` fails without it | Fork | `kbe/src/lib/server/python_app.cpp:721-725` |
| D2 `KBEngine.SERVER_SUCCESS` / `SERVER_ERR_*` on these processes | `onRequestLogin`/`onRequestCreateAccount` should return `(KBEngine.SERVER_SUCCESS, ...)` | `SERVER_ERR_*` constants exist on loginapp and dbmgr (each registers its own loop in `Loginapp::onInstallPyModules` `loginapp.cpp:199-206` and `Dbmgr::onInstallPyModules` `dbmgr.cpp:343-352`) but are **missing on logger** (no `onInstallPyModules` loop; `logger.h:49` derives from `PythonApp` with no such registration) — snippets raising these constants work on loginapp/dbmgr and fail on logger only | Fork | `kbe/src/server/loginapp/loginapp.cpp:199-206`, `kbe/src/server/dbmgr/dbmgr.cpp:343-352`, `kbe/src/lib/server/entity_app.h:485-489`, `kbe/src/lib/server/server_errors.h:57-58` |
| D3 `addTimer` `repeatOffset ≤ 0` "will be ignored" | Ignored (i.e. timer repeats anyway?) | `repeatTicks` stays 0 unless `repeatOffset > 0` → timer is single-shot; negative `initialOffset` is clamped to 0 with a warning | Fork | `kbe/src/lib/server/script_timers.cpp:43-49, 56-66` |
| D4 `delTimer` with invalid id "will generate an error" | Generates an error | Same behavior: raises `TypeError` and returns `-1` — no deviation in contract, error type now explicit | Fork | `kbe/src/lib/server/python_app.cpp:755-771` |
| D5 `print` statement in examples | Python-2 `print` syntax | Embedded interpreter is Python 3.12; examples need `print(...)` | Python | Verified — no behavioral deviation beyond syntax; see [python-version-baseline](python-version-baseline.md) §2, §4 |
| D6 `onLogWrote` return semantics | Documents only the `datas` argument | Return `False` suppresses persistence; returning a string rewrites the persisted log line | Fork | `kbe/src/server/tools/logger/logger.cpp:286-316` |
| D7 logger process source location | Material predates layout; upstream 3.7 has `kbe/src/server/logger/` | Fork moved the process to `kbe/src/server/tools/logger/` | Fork | Fork tree listing at HEAD `6d12b8f` |
| D8 `urlopen` availability on all three faces | Documented per-face for loginapp/dbmgr/logger | Same — installed for every `PythonApp` via `PyUrl::initialize` | Fork | `kbe/src/lib/pyscript/script.cpp:286`, `kbe/src/lib/pyscript/pyurl.cpp:23` |

## References

- Source material: `kbengine/docs/api/kbengine/loginapp/{KBEngine.md,index.md}`,
  `dbmgr/{KBEngine.md,index.md}`, `logger/{KBEngine.md,index.md}`
- Shared face: `kbe/src/lib/server/python_app.cpp:230-349, 721-771`,
  `kbe/src/lib/pyscript/script.cpp:246-290`,
  `kbe/src/lib/pyscript/pyurl.cpp:23, 69+`,
  `kbe/src/lib/server/script_timers.cpp:38-70`
- Loginapp: `kbe/src/server/loginapp/loginapp.cpp:59-62, 170-180, 367-410,
  588-609, 1012-1094, 1222-1235`, `pendingLoginmgr.h`
- Dbmgr: `kbe/src/server/dbmgr/dbmgr.cpp:77-95, 153-156, 306-313, 331-360,
  786-913, 918-1035, 1240-1267`
- Logger: `kbe/src/server/tools/logger/logger.cpp:123, 126-135, 175-192,
  215-218, 286-316`, `logwatcher.h/cpp`
- Sister knowledge pages: `api-baseapp.md`, `api-baseapp-entity.md`,
  `api-cellapp.md`, `api-client.md`, `python-version-baseline.md`
