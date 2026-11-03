# Entry script SPI methods

> KODE-CFG-012 · KB-001 engine mechanics. The engine reaches the entry module
> only through `getEntryScript()`; this page is the complete method table for
> that interface. Sources: `kbe/src` at `/home/cui/workspaces/kbengine`
> (commit `c2a3b8f`), official templates under
> `kbe/res/sdk_templates/server/python_assets/scripts/`. Companion pages:
> [Fixed directories and path resolution](fixed-directories-and-path-resolution.md),
> [Startup flow and stack](startup-flow-and-stack.md).

The entry module is `entryScriptFile`, a **module name** whose default is
`kbemain` (see [fixed directories](fixed-directories-and-path-resolution.md)).
Everything the engine calls on it goes through
`EntityApp::getEntryScript()` (`kbe/src/lib/server/entity_app.h:89`),
`PythonApp::getEntryScript()` (`kbe/src/lib/server/python_app.h:51`) or
`ClientApp::getEntryScript()` (`kbe/src/lib/client_lib/clientapp.h:83`).

## How to read the tables

Three call forms exist, and they differ in what happens when the method is
missing:

| Form | Missing method behaviour | Where |
| --- | --- | --- |
| `PyObject_CallMethod(...)` directly | returns `NULL`, `AttributeError` printed by `SCRIPT_ERROR_CHECK()` | e.g. `kbe/src/server/loginapp/loginapp.cpp:174` |
| `SCRIPT_OBJECT_CALL_ARGSx(...)` macro | macro runs `PyObject_HasAttrString` first; skipped silently unless `GETERROR` is true | guard at `kbe/src/lib/pyscript/py_macros.h:665` (ARGS0), `:699` (ARGS1), `:736` (ARGS2), `:774` (ARGS3); `AttributeError` formatting at `:681` |
| explicit `PyObject_HasAttrString` guard, then call | never called when absent — safe to omit | e.g. `kbe/src/server/baseapp/entity_autoloader.cpp:90` then `:92` |

A full scan of `getEntryScript()` across `kbe/src` yields **56 call sites**
covering **36 distinct method names**: 32 are invoked unconditionally (the
call site carries no guard of its own) and 4 sit behind an explicit
`PyObject_HasAttrString`.

## The 4 optional methods

| Method | Guard line | Call line | Format | Components |
| --- | --- | --- | --- | --- |
| `onAutoLoadEntityCreate` | `kbe/src/server/baseapp/entity_autoloader.cpp:90` | `:92` | `sK` | baseapp |
| `onLogWrote` | `kbe/src/server/tools/logger/logger.cpp:287` | `:290` | `y#` | logger |
| `onReadyForLogin` | `kbe/src/server/baseapp/initprogress_handler.cpp:201`, `kbe/src/server/cellapp/initprogress_handler.cpp:153` | `:206`, `:156` | `O` (baseapp), `i` (cellapp) | baseapp, cellapp |
| `onReadyForShutDown` | `kbe/src/server/baseapp/baseapp.cpp:275`, `kbe/src/server/dbmgr/dbmgr.cpp:78`, `kbe/src/server/tools/logger/logger.cpp:176` | `:278`, `:81`, `:179` | `""` | baseapp, dbmgr, logger |

A subtlety for the remaining 32: 14 of them go through the
`SCRIPT_OBJECT_CALL_ARGSx` macro, so they are *also* skipped when the attribute
is absent (`py_macros.h:665`, `:699`, `:736`, `:774`) — the difference is only
whether an `AttributeError` is printed. The other 18 are called directly and
raise a Python `AttributeError` on every hit if you delete them from
`kbemain.py`.

## Per-component tables

Repeated methods (shared by several components) appear in each relevant table.

### baseapp — 12 methods

| Method | Required | Format | Call site | Trigger |
| --- | --- | --- | --- | --- |
| `onInit` | yes | `i` (`0` at startup, `1` on reload) | `kbe/src/server/baseapp/baseapp.cpp:3601` | `Baseapp::onDbmgrInitCompleted` (`baseapp.cpp:3581`), first callback after scripts load |
| `onBaseAppReady` | yes | `O` | `kbe/src/server/baseapp/initprogress_handler.cpp:185` | `InitProgressHandler::process` (`initprogress_handler.cpp:132`) |
| `onReadyForLogin` | optional | `O` | `initprogress_handler.cpp:201` guard, `:206` call | polled each tick until the return value is ≥ 0.9999 (`initprogress_handler.cpp:244`) |
| `onGlobalData` | yes (macro) | `OO` | `kbe/src/lib/server/entity_app.h:1308` | `EntityApp::onBroadcastGlobalDataChanged` (`entity_app.h:1261`) |
| `onGlobalDataDel` | yes (macro) | `O` | `entity_app.h:1290` | same broadcast path |
| `onBaseAppData` | yes (macro) | `OO` | `kbe/src/server/baseapp/baseapp.cpp:3668` | `Baseapp::onBroadcastBaseAppDataChanged` (`baseapp.cpp:3618`) |
| `onBaseAppDataDel` | yes (macro) | `O` | `baseapp.cpp:3649` | same |
| `onCellAppDeath` | yes | `O` | `baseapp.cpp:696` | `Baseapp::onCellAppDeath` (`baseapp.cpp:673`) |
| `onLoseChargeCB` | yes | `OOOO` | `baseapp.cpp:3563` | `Baseapp::onChargeCB` (`baseapp.cpp:3510`) |
| `onAutoLoadEntityCreate` | optional | `sK` | `entity_autoloader.cpp:90` guard, `:92` call | `EntityAutoLoader::onEntityAutoLoadCBFromDBMgr` (`entity_autoloader.cpp:52`) |
| `onReadyForShutDown` | optional | `""` | `baseapp.cpp:275` guard, `:278` call | `Baseapp::canShutdown` (`baseapp.cpp:258`) |
| `onBaseAppShutDown` | yes (macro) | `i` = `0` / `1` / `2` | `baseapp.cpp:327`, `:342`, `:389` | `onShutdownBegin` (`:321`) → `onShutdown(first)` (`:334`) → `onShutdownEnd` (`:383`) |

### cellapp — 9 methods

| Method | Required | Format | Call site | Trigger |
| --- | --- | --- | --- | --- |
| `onInit` | yes | `i` (`0`) | `kbe/src/server/cellapp/initprogress_handler.cpp:137` | `InitProgressHandler::process` (`initprogress_handler.cpp:102`) — cellapp uses `onInit(0)` as its ready callback |
| `onGlobalData` | yes (macro) | `OO` | `kbe/src/lib/server/entity_app.h:1308` | shared with baseapp |
| `onGlobalDataDel` | yes (macro) | `O` | `entity_app.h:1290` | shared with baseapp |
| `onCellAppData` | yes (macro) | `OO` | `kbe/src/server/cellapp/cellapp.cpp:864` | `Cellapp::onBroadcastCellAppDataChanged` (`cellapp.cpp:816`) |
| `onCellAppDataDel` | yes (macro) | `O` | `cellapp.cpp:844` | same |
| `onSpaceData` | yes (macro) | `Iss` (set) / `IsO` (del) | `kbe/src/server/cellapp/spacememory.cpp:609`, `:615` | `SpaceMemory::onSpaceDataChanged` (`spacememory.cpp:603`) |
| `onSpaceGeometryLoaded` | yes (macro) | `Is` | `spacememory.cpp:308` | `SpaceMemory::onLoadedSpaceGeometryMapping` (`spacememory.cpp:299`) — **not implemented in any template** |
| `onAllSpaceGeometryLoaded` | yes (macro) | `Iis` | `spacememory.cpp:336` | `SpaceMemory::onAllSpaceGeometryLoaded` (`spacememory.cpp:331`) |
| `onReadyForLogin` | optional | `i` | `cellapp/initprogress_handler.cpp:153` guard, `:156` call | same polling loop as baseapp |

### loginapp — 7 methods

| Method | Required | Format | Call site | Trigger |
| --- | --- | --- | --- | --- |
| `onLoginAppReady` | yes | `""` | `kbe/src/server/loginapp/loginapp.cpp:174` | `Loginapp::initializeEnd` (`loginapp.cpp:163`) |
| `onRequestLogin` | yes | `ssby#` | `loginapp.cpp:1013` | `Loginapp::login` (`loginapp.cpp:877`) |
| `onLoseLogin` | yes | `s` | `loginapp.cpp:130` | `Loginapp::onChannelDeregister` (`loginapp.cpp:102`) |
| `onRequestCreateAccount` | yes | `ssy#` | `loginapp.cpp:368` | `Loginapp::_createAccount` (`loginapp.cpp:285`) |
| `onCreateAccountCallbackFromDB` | yes | `sHy#` | `loginapp.cpp:590` | `Loginapp::onReqCreateAccountResult` (`loginapp.cpp:578`) |
| `onLoginCallbackFromDB` | yes | `ssHy#` | `loginapp.cpp:1231` | `Loginapp::onLoginAccountQueryResultFromDbmgr` (`loginapp.cpp:1166`) |
| `onLoginAppShutDown` | yes (macro) | no args | `loginapp.cpp:62` | `Loginapp::onShutdownBegin` (`loginapp.cpp:56`) |

### dbmgr — 4 methods

| Method | Required | Format | Call site | Trigger |
| --- | --- | --- | --- | --- |
| `onDBMgrReady` | yes | `""` | `kbe/src/server/dbmgr/dbmgr.cpp:309` | `Dbmgr::initializeEnd` (`dbmgr.cpp:283`) |
| `onSelectAccountDBInterface` | yes | `s` | `dbmgr.cpp:1242` | `Dbmgr::selectAccountDBInterfaceName` (`dbmgr.cpp:1236`) |
| `onReadyForShutDown` | optional | `""` | `dbmgr.cpp:78` guard, `:81` call | `Dbmgr::canShutdown` (`dbmgr.cpp:76`) |
| `onDBMgrShutDown` | yes (macro) | no args | `dbmgr.cpp:156` | `Dbmgr::onShutdownBegin` (`dbmgr.cpp:150`) |

### interfaces — 5 methods

| Method | Required | Format | Call site | Trigger |
| --- | --- | --- | --- | --- |
| `onInterfaceAppReady` | yes | `""` | `kbe/src/server/tools/interfaces/interfaces.cpp:153` | `Interfaces::initializeEnd` (`interfaces.cpp:137`) |
| `onRequestCreateAccount` | yes | `ssy#` | `interfaces.cpp:525` | `Interfaces::reqCreateAccount` (`interfaces.cpp:488`) |
| `onRequestAccountLogin` | yes | `ssy#` | `interfaces.cpp:637` | `Interfaces::onAccountLogin` (`interfaces.cpp:605`) |
| `onRequestCharge` | yes | `sKy#` | `interfaces.cpp:752` | `Interfaces::charge` (`interfaces.cpp:717`) |
| `onInterfaceAppShutDown` | yes (macro) | no args | `interfaces.cpp:79` | `Interfaces::onShutdownBegin` (`interfaces.cpp:73`) |

### logger — 4 methods

| Method | Required | Format | Call site | Trigger |
| --- | --- | --- | --- | --- |
| `onLoggerAppReady` | yes | `""` | `kbe/src/server/tools/logger/logger.cpp:131` | `Logger::initializeEnd` (`logger.cpp:116`) |
| `onReadyForShutDown` | optional | `""` | `logger.cpp:176` guard, `:179` call | `Logger::canShutdown` (`logger.cpp:174`) |
| `onLoggerAppShutDown` | yes (macro) | no args | `logger.cpp:218` | `Logger::onShutdownBegin` (`logger.cpp:210`) |
| `onLogWrote` | optional | `y#` | `logger.cpp:287` guard, `:290` call | `Logger::writeLog` (`logger.cpp:229`); the guard is a `static bool`, evaluated once per process (`logger.cpp:287`) |

### client / bots — 3 methods

| Method | Required | Format | Call site | Trigger |
| --- | --- | --- | --- | --- |
| `onInit` | yes | `i` (`0`) | `kbe/src/lib/client_lib/clientapp.cpp:131`, `kbe/src/server/tools/bots/bots.cpp:102` | `ClientApp::initializeEnd` (`clientapp.cpp:128`), `Bots::initializeEnd` (`bots.cpp:88`) |
| `onFinish` | yes | `""` | `clientapp.cpp:303`, `bots.cpp:124` | `Bots::finalise` (`bots.cpp:121`) — client/bots only, not a server callback |
| `onTargetChanged` | yes | `i` | `clientapp.cpp:458` | client entity target change — client only |

## 36 engine calls vs 36 template functions

The seven official templates define **44 function definitions / 36 distinct
names** (base 12, login 8, cell 7, interface 6, logger 4, db 4, bots 3 — names
shared between components are counted once each in the distinct total). The
engine calls 36 distinct names. The two sets overlap on 33 names:

| Category | Count | Names | Evidence |
| --- | --- | --- | --- |
| Both engine and template | 33 | the intersection | — |
| Engine calls, no template implements it | 3 | `onAutoLoadEntityCreate`, `onSpaceGeometryLoaded`, `onTargetChanged` | guards/paths: `entity_autoloader.cpp:90`, `py_macros.h:736`, `clientapp.cpp:458` |
| Template defines it, engine never calls it | 3 | `onFini`, `onStart`, `onTick` | see below |

### The three template-only names, corrected

- **`onFini` — template vs implementation mismatch, 待证伪.** No call site
  exists anywhere in `kbe/src`: grepping `"onFini"` and `onFini\b` returns
  nothing, and the adjacent-string form (`"on" "Fini"`) does not appear either.
  The template still labels it a KBEngine method
  (`kbe/res/sdk_templates/server/python_assets/scripts/base/kbemain.py:56`,
  `INFO_MSG('onFini()')` at `:61`). Actual shutdown goes through
  `onXxxShutDown(state)` instead — the three-stage sequence is in
  [startup flow and stack](startup-flow-and-stack.md).
- **`onTick` — not an engine callback.** No `"onTick"` string exists in
  `kbe/src`. It is the template's own timer: the `onInit` body carries the
  (commented-out) line `#KBEngine.addTimer(0.01, 1.0, onTick)` at
  `kbe/res/sdk_templates/server/python_assets/scripts/db/kbemain.py:17` with
  `def onTick(timerID)` at `:19`, and the same pair at
  `interface/kbemain.py:44` and `:47`. When enabled it fires from the script
  timer machinery, never from `getEntryScript()`.
- **`onStart` — no call site, 待证伪.** `kbe/src` has no script-callback
  invocation of it (the only `onStart` hits are unrelated C++ such as
  `KBEConcurrency::onStartMainThreadIdling`). Template:
  `kbe/res/sdk_templates/server/python_assets/scripts/bots/kbemain.py:14`.
- **`onFinish` is component-specific**, not general: the only call sites are
  `kbe/src/lib/client_lib/clientapp.cpp:303` and
  `kbe/src/server/tools/bots/bots.cpp:124`.

## Lifecycle diagram

![KBEngine entry script lifecycle](/kbengine-lifecycle.svg)

Seven phases (P0 environment paths → P7 shutdown), runtime split into
per-component lanes, shutdown drawn as the three-stage `state = 0 → 1 → 2`
sequence. Required callbacks are blue, `HasAttr`-guarded ones amber, the three
non-engine names dashed. The same picture with per-phase stack frames is on
[Startup flow and stack](startup-flow-and-stack.md).

## Where to attach debugpy

**Best injection point: P1, the module import — not `onInit`.**

- `onInit` fires *after* the engine has already commented 「所有脚本都加载完毕」
  (`kbe/src/lib/server/entity_app.h:1459`, `kbe/src/lib/server/python_app.cpp:708`),
  which is after `installPyScript` / `installPyModules` have run
  (`entity_app.h:281`, `entity_app.h:284`, `python_app.cpp:74`,
  `python_app.cpp:77`). Any import-time error in an earlier module is already
  past you by then.
- The wrapper module's top-level code runs inside
  `PyImport_Import(entryScriptFile)` (`kbe/src/lib/server/entity_app.h:509`,
  `python_app.cpp:340`, `bots.cpp:218`, `clientapp.cpp:272`), i.e. **before**
  entity defs, before every callback, and while process/port identity is
  already known (`g_kbeSrvConfig.updateInfos(...)` at
  `kbe/src/lib/server/kbemain.h:190`, components registered at `:198`).
  Putting `debugpy.listen()` / `debugpy.wait_for_client()` at the top of
  `kbemain.py` stops the process at the earliest point where Python runs at all.
- Fallback: `onInit(isReload)` if you only need business-layer breakpoints —
  it is the first engine callback (`baseapp.cpp:3601`,
  `cellapp/initprogress_handler.cpp:137`).

**Decorators work.** The engine resolves the attribute at call time through
`PyObject_CallMethod`, so the attribute may be a decorated function *or* an
instance with `__call__`. Two constraints:

1. The format string must match what the engine passes — `onInit` uses `"i"`
   (`baseapp.cpp:3603`), `onSpaceGeometryLoaded` uses `"Is"`
   (`spacememory.cpp:309`), `onLoginCallbackFromDB` uses `"ssHy#"`
   (`loginapp.cpp:1233`), and `onReadyForLogin` is `"O"` on baseapp but `"i"`
   on cellapp (`initprogress_handler.cpp:208` vs `:158`).
2. The wrapper must forward `*args, **kwargs` unchanged and return what the
   engine expects — `onReadyForLogin` must return `Py_True` for the login gate
   to open (`initprogress_handler.cpp:213`) — letting exceptions propagate
   rather than swallowing them.

Next: [Fixed directories and path resolution](fixed-directories-and-path-resolution.md) ·
[Startup flow and stack](startup-flow-and-stack.md) ·
[Entity lifecycle & reference release](entity-lifecycle-reference.md)
