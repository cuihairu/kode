# Client-facing API reference: KBEngine module & Entity

> KB-API-002 (P0) · client face of the API surface. The official `docs/api`
> source material (`kbengine/docs/api/kbengine/client/`, CHM conversion) was
> rewritten from scratch here — its layout is machine-mangled (glued tokens
> such as "ThisKBEngine") and it mixes two different implementation layers
> without saying so. Every item below is annotated with its evidence domain
> per [python-version-baseline §7](python-version-baseline.md): **Fork**
> (`kbe/src` file:line at kbengine HEAD `6d12b8f`, base `c2a3b8f`), **Python**
> (official `docs.python.org`), or **Plugin-layer** (implemented in the client
> SDK plugins, outside this repo — no line numbers are invented for these).
> Companion pages: [Entry script SPI methods](entry-script-spi-methods.md),
> [Entity lifecycle & reference release](entity-lifecycle-reference.md),
> [Python version baseline](python-version-baseline.md). See the knowledge
> index (README Articles) for the full KB-API batch.

## 1. One face, two layers

The client face documented by the CHM material is a **hybrid**: it documents
the surface a game client sees, but the implementations live in two different
places:

| Layer | Where it lives | What it provides | Evidence style |
| --- | --- | --- | --- |
| Embedded C++ surface (`client_lib`) | `kbe/src/lib/client_lib/` — compiled into the bots tool and any embedded Python client; installs the Python module **`KBEngine`** (`kbe/src/lib/client_lib/kbemain.h:102`) | module functions `player`, `getSpaceData`, `fireEvent`, `callback`, … ; the C++ `Entity` type and its script methods/attributes | `kbe/src` `file:line` (Fork) |
| Client SDK plugin layer | official client plugins (unity3d / ogre / html5 demos etc., **not in this repo** — `kbe/src/client/README.md` only links them) | `KBEngine.login`, `createAccount`, `reloginBaseapp`, `resetPassword`, `bindAccountEmail`, `newPassword`, `findEntity`, `entity.baseCall/cellCall`, and the convenience attributes | Plugin-layer, official SDK docs are the source |

The `docs/api/kbengine/client/index.md` source states the split itself: the
engine ships no complete client; the plugins "handle communication with the
server, registering accounts, login interface, provide an Entity base class".
So: **anything about connection/login flow lives in the plugin layer; anything
about the entity registry and space data lives in `client_lib`.**

## 2. `KBEngine` module — functions

### 2.1 Fork-registered module functions

Registered onto the `KBEngine` module in `ClientApp::installEntityDef()`
(`kbe/src/lib/client_lib/clientapp.cpp:191-215`); the module name itself is
installed by `script.install(..., "KBEngine", componentType)`
(`kbe/src/lib/client_lib/kbemain.h:102`).

| Function | Signature | Domain | Registration / impl |
| --- | --- | --- | --- |
| `player` | `player() -> Entity \| None` | Fork | `clientapp.cpp:193`; impl `clientobjectbase.cpp:1159-1171` |
| `getSpaceData` | `getSpaceData(key: str) -> str` | Fork | `clientapp.cpp:194`; impl `clientobjectbase.cpp:2420-2450` |
| `fireEvent` | `fireEvent(eventName: str, data: str)` | Fork | `clientapp.cpp:192`; impl `clientapp.cpp:493+` |
| `callback` | `callback(time: float, callbackObj) -> int` | Fork | `clientapp.cpp:195`; impl `clientobjectbase.cpp:254-284` |
| `cancelCallback` | `cancelCallback(callbackID: int)` | Fork | `clientapp.cpp:196`; impl `clientobjectbase.cpp:287-309` |
| `getWatcher` / `getWatcherDir` | watcher queries | Fork | `clientapp.cpp:197-198` |
| `disconnect` | `disconnect()` | Fork | `clientapp.cpp:199` |
| `kbassert` | debug assert hook | Fork | `clientapp.cpp:200` |
| `publish` | app publish state | Fork | `clientapp.cpp:191` |
| `getResFullPath`, `hasRes`, `open`, `listPathRes`, `matchPath` | resource-path helpers | Fork | `clientapp.cpp:204-215` |

Only `player`, `getSpaceData` and `fireEvent` appear in the official CHM
material; the rest are fork-grounded additions the source material never
mentions.

#### `player()`

Returns the entity the client controls, or `None` when there is none (e.g.
before login). The C++ path is `ClientObjectBase::pPlayer()` — a direct lookup
of the client's `entityID_` in the live registry
(`kbe/src/lib/client_lib/clientobjectbase.cpp:1153-1156`) — wrapped by
`__py_getPlayer` which INCREFs and returns the entity or `S_Return` (→
`None`) (`clientobjectbase.cpp:1159-1171`). The registry behind it is the same
`Entities<T>` map documented in
[Entity lifecycle](entity-lifecycle-reference.md).

#### `getSpaceData(key)`

Returns the space-data string for `key`. Space data arrives from the server
(`setSpaceData` on the server side); the client keeps it in the `spacedatas_`
map. `__py_GetSpaceData` raises `TypeError` when the argument count is wrong
and when the key is not present — **missing keys are an exception, not
`None`** (`kbe/src/lib/client_lib/clientobjectbase.cpp:2420-2450`).

#### `fireEvent(eventName, data)`

Module-level event dispatch: wraps the args into an `EventData_Script` and
fires it into the client event handler (`clientapp.cpp:493+`). Note the fork's
signature: `args[1]` is converted with `PyUnicode_AsUTF8AndSize`, i.e. the
payload is a **string**, not arbitrary objects. Entity-scoped events use
`Entity.fireEvent` (§4) instead; the CHM material documents only the
entity-level one.

### 2.2 Plugin-layer functions (implemented outside this repo)

These are the functions a real game client calls, but **no Python-visible
registration point for them exists anywhere in `kbe/src`** — they are
implemented inside the official client SDK plugins. Per the grounding rules,
they are marked Plugin-layer and no line numbers are fabricated. What the
fork *does* contain is the underlying network protocol path each plugin
triggers (also unregistered to Python, listed for traceability only):

| Function (plugin signature) | CHM-source semantics | Domain | Notes |
| --- | --- | --- | --- |
| `login(username, password)` | login to the KBEngine server via loginapp; UI layers are told to fire a `"login"` event instead of calling directly | Plugin-layer | protocol path exists: `ClientObjectBase::login()` sends `LoginappInterface::login` (`clientobjectbase.cpp:604-632`) — no Python registration |
| `createAccount(username, password)` | request account creation on the server; UI fires `"createAccount"` | Plugin-layer | protocol path: `ClientObjectBase::createAccount()` (`clientobjectbase.cpp:449-459`) |
| `reloginBaseapp()` | re-login to baseapp after a drop, faster than full login; UI fires `"reloginBaseapp"` | Plugin-layer | protocol path: `ClientObjectBase::reloginBaseapp()` sends `BaseappInterface::reloginBaseapp` with name/password/rndUUID/entityID (`clientobjectbase.cpp:655-668`) |
| `resetPassword(username)` | ask loginapp to email a password reset | Plugin-layer | no `kbe/src` implementation found |
| `bindAccountEmail(emailaddress)` | ask baseapp to bind an email to the account | Plugin-layer | no `kbe/src` implementation found |
| `newPassword(oldpassword, newpassword)` | set a new password for the account | Plugin-layer | no `kbe/src` implementation found |
| `findEntity(entityID)` | look up an entity instance by ID | Plugin-layer | **no registration point in `client_lib` at all** — client-side lookup in-script is spelled `KBEngine.entities[entityID]` against the fork-registered `entities` object (§3) |

## 3. `KBEngine` module — attributes

| Attribute | CHM-source claim | Verdict against the fork | Domain |
| --- | --- | --- | --- |
| `entities` | dict of all entities in the process, keys `entity_uuid`/`entity_id`/`spaceID` | The **entities map itself is fork-real**: `ClientApp` installs an `Entities<client::Entity>` object into the module (`kbe/src/lib/client_lib/clientapp.cpp:266`, uninstalled at `:228`); its script methods are `has_key/keys/values/items/get` plus the `garbages` registry (`kbe/src/lib/entitydef/entities.h:114-126`) | Fork (map) |
| `entities.entity_uuid` / `entities.entity_id` / `entities.spaceID` | typed sub-attributes of the map | No such sub-attributes exist on the fork's `Entities<T>` script type; as client-script convenience variables they belong to the plugin layer | Plugin-layer |
| `component` | read-only string, one of `'cellapp' 'baseapp' 'client' 'dbmgr' 'bots' 'editor'` | No script registration named `component` exists in `lib/client_lib` (grep: 0 hits); the component identity is a C++ compile-time constant (`g_componentType`), not a module attribute | **待取证 / to be evidenced** — plugin-side attribute; evidence path: diff the official SDK plugin sources for how `component` is exposed |

## 4. `Entity` class — member functions

The C++ type is `client::Entity` (`kbe/src/lib/client_lib/entity.h:34`,
subclass of `script::ScriptObject`), constructed per entity by
`ClientObjectBase::createEntity` (`clientobjectbase.cpp:312-385`). Its Python
surface is declared in two places: the shared client-entity macro
(`kbe/src/lib/entitydef/entity_macro.h:42-53`) and the per-class table
(`kbe/src/lib/client_lib/entity.cpp:27-46`).

### 4.1 Functions documented in the source material

| Function | Signature | Semantics & trigger | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `isPlayer` | `isPlayer() -> bool` | true when the entity's ID equals the client's controlled `entityID_` | Fork | declared `entity.cpp:31`; impl `entity.cpp:840-853` |
| `getComponent` | `getComponent(componentName: str, all: bool = False)` | returns the attached entity component by type name; `all=True` returns a tuple of all instances, `False` the first or `None` | Fork | declared `entity.cpp:34`; impl `entity_macro.h:1276-1355` |
| `fireEvent` | `fireEvent(eventName: str, *args)` | entity-scoped event dispatch into `events_` | Fork | declared `entity_macro.h:49` (client macro `:42-53`) |
| `registerEvent` | `registerEvent(eventName: str, callbackObj)` | store a callback in the entity's `events_` map | Fork | declared `entity_macro.h:47` |
| `deregisterEvent` | `deregisterEvent(eventName: str, callbackObj)` | remove a previously stored callback | Fork | declared `entity_macro.h:48` |
| `baseCall` | `baseCall(methodName: str, *args)` | remote call to the entity's base part; no return (remote) | Plugin-layer | no Python registration in `client_lib`; the fork exposes the base endpoint only as the `base` getter (§4.3). CHM examples are js/c# plugin code |
| `cellCall` | `cellCall(methodName: str, *args)` | remote call to the entity's cell part; no return (remote) | Plugin-layer | same — only the `cell` getter is fork-side |

### 4.2 Fork-only functions (absent from the source material)

| Function | Signature | Domain | Evidence |
| --- | --- | --- | --- |
| `moveToPoint` | movement request handled by `moveto_point_handler` | Fork | `entity.cpp:29` |
| `cancelController` | cancel an active movement/controller | Fork | `entity.cpp:30` |
| `addTimer` / `delTimer` | script timers → `onTimer` callback | Fork | `entity.cpp:32-33`; dispatch `entity.cpp:894-898` |
| `__reduce_ex__`, `__getDEP__` | pickling / datachange-event plumbing | Fork | `entity_macro.h:44-45` |

### 4.3 Entity attributes (getters)

Declared in `CLIENT_ENTITY_GETSET_DECLARE_BEGIN`
(`entity_macro.h:56-62`) and `entity.cpp:40-46`:

| Attribute | Type | Semantics | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `id` | read-only int | entity ID; the getter macro returns `id_` | Fork | `entity_macro.h:58`, impl `:689` |
| `spaceID` | read-only int | ID of the space the entity is in | Fork | `entity_macro.h:59`, impl `:739` |
| `className` | read-only string | entity type name from its def module | Fork | `entity_macro.h:61`, impl `:1496` |
| `isDestroyed` | read-only bool | destruction flag (not in the CHM material) | Fork | `entity_macro.h:60` |
| `position` | get/set `Vector3` | world position; synced from server, client-side writes feed `updatePlayerToServer` | Fork | `entity.cpp:44`; sync path `clientobjectbase.cpp:1193-1275` |
| `direction` | get/set `Vector3` | (roll, pitch, yaw) in radians; same sync discipline as `position` | Fork | `entity.cpp:45` |
| `velocity` | get/set float | movement speed used by `moveToPoint` (not in the CHM material) | Fork | `entity.cpp:46` |
| `base` / `cell` | read-only EntityCall | endpoints for base/cell parts; `None` until the server grants them | Fork | `entity.cpp:41-42`, impl `entity.cpp:110-131` |
| `clientapp` | read-only | the owning client app object | Fork | `entity.cpp:43` |

CHM material attributes **not** registered on the fork's client Entity:

| Attribute | CHM-source claim | Verdict | Domain |
| --- | --- | --- | --- |
| `isOnGround` | read-write bool; client-controlled entities push changes to the server | The C++ member `isOnGround_` exists and is updated from the network stream (`entity.cpp:65`, `clientobjectbase.cpp:868`), but **no script getter/setter is declared** — as a script-visible attribute it is plugin-layer | **待取证 / to be evidenced** — evidence path: diff the official SDK plugin entity class |
| `inWorld` | read-only bool | `enterworld_` is a C++-internal flag (`entity.cpp:61`); no script getter declared | **待取证 / to be evidenced** — same evidence path |

## 5. `Entity` callbacks

The engine drives these from the network handlers; the script methods are
invoked through `CALL_ENTITY_AND_COMPONENTS_METHOD` dispatchers
(`entity.cpp:561-594`).

| Callback | Fired when | Domain | Evidence |
| --- | --- | --- | --- |
| `onEnterWorld` | entity enters the world; for the player entity it also becomes player first | Fork | dispatch `entity.cpp:561-568`; trigger `clientobjectbase.cpp:930-935` (`onBecomePlayer` :932, `onEnterWorld` :935) |
| `onLeaveWorld` | entity leaves the world / view scope | Fork | dispatch `entity.cpp:570-577`; trigger `clientobjectbase.cpp:969-972` |
| `onEnterSpace` | controlled entity enters a space | Fork | dispatch `entity.cpp:580-586`; trigger `clientobjectbase.cpp:1034` |
| `onLeaveSpace` | controlled entity leaves its space | Fork | dispatch `entity.cpp:588-594`; trigger `clientobjectbase.cpp:1055` |
| `onTimer(timerID, userArg)` | `addTimer` expiry | Fork | `entity.cpp:894-898` |
| `onDestroy` | CHM: "called when the entity is destroyed" | **待取证 / to be evidenced** | in the fork's embedded client the destroy path calls the *C++* `onDestroy(callScript)` — an **empty** override on `client::Entity` (`entity.h:144`) invoked from `destroy()` (`entity_macro.h:1010-1032`, call at `:1020`); the remote destroy path passes `callScript=false` (`clientobjectbase.cpp:204-215`, `:1080`), so no script-visible `onDestroy` dispatch exists in `client_lib`. Evidence path: diff the official SDK plugin entity class |

### Property broadcast: `set_<propertyName>`

When a cell property with a client broadcast flag changes, the engine calls
`set_<name>` on the client entity: `Entity::callPropertysSetMethods()` builds
the `"set_" + name` identifier and calls it with the old value
(`entity.cpp:855-891`); it runs on world entry per
`isOnInitCallPropertysSetMethods` config (`clientobjectbase.cpp:937-942`) and
on property updates (`entity.cpp:30-46`, `onDefDataChanged` at
`entity.cpp:36-45`). This matches the CHM's `set_[property]` description but
is grounded here rather than asserted.

## 6. 3.7 source material vs fork 3.12 deviations

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| `KBEngine.login/createAccount/reloginBaseapp/resetPassword/bindAccountEmail/newPassword` | documented as Python module functions of the client | not registered on any Python surface in `kbe/src`; only the underlying protocol send paths exist as C++ (unregistered) | Plugin-layer | outside this repo; protocol paths `clientobjectbase.cpp:604-632`, `:449-459`, `:655-668` |
| `KBEngine.findEntity` | documented as a module function | no registration point in `client_lib`; equivalent lookup is `entities[entityID]` | Plugin-layer | grep `client_lib` for `findEntity`: 0 hits; registry `clientapp.cpp:266` |
| `KBEngine.entities` "contains `entity_uuid`/`entity_id`/`spaceID`" | documented as typed sub-attributes of the entities map | fork `Entities<T>` exposes `has_key/keys/values/items/get/garbages` only | Plugin-layer | `entitydef/entities.h:114-126` |
| `KBEngine.component` | read-only string attribute | no script registration in `lib/client_lib` | 待取证 | grep `"component"` in `lib/client_lib`: 0 hits |
| `Entity.baseCall/cellCall` | documented as Entity methods (examples are js/c#) | not registered in `client_lib`; only `base`/`cell` EntityCall getters exist | Plugin-layer | `entity.cpp:40-46` |
| `Entity.isOnGround` | read-write script attribute | C++ member only, no script binding | 待取证 | `entity.cpp:65`, `clientobjectbase.cpp:868`, no `SCRIPT_GET(SET)_DECLARE` |
| `Entity.inWorld` | read-only script attribute | C++-internal `enterworld_`, no script binding | 待取证 | `entity.cpp:61` |
| `Entity.onDestroy` | script callback on destroy | embedded client never dispatches it (empty C++ override; `callScript=false` on remote destroy) | 待取证 | `entity.h:144`, `entity_macro.h:1010-1032`, `clientobjectbase.cpp:1080` |
| runtime baseline | CHM written against embedded 3.7.3 | fork builds 3.12 (Windows) / interpreter-agnostic (Linux); no client-face impact — all bindings above are version-neutral C API | Fork | see [python-version-baseline §2](python-version-baseline.md) |
| module-level `fireEvent`, `callback`, timers, `getWatcher*`, resource helpers | not present in the source material | registered on the fork's `KBEngine` module | Fork | `clientapp.cpp:191-215` |

## References

- Fork: `kbe/src/lib/client_lib/clientapp.cpp` (`:103-110`, `:191-215`,
  `:228`, `:266`, `:493+`), `clientobjectbase.cpp` (`:20-37`, `:204-215`,
  `:254-309`, `:312-385`, `:449-459`, `:604-632`, `:655-668`, `:824-1081`,
  `:1153-1171`, `:1193-1275`, `:2420-2450`), `entity.cpp` (`:27-46`,
  `:36-45`, `:61`, `:65`, `:110-131`, `:561-594`, `:840-853`, `:856-891`,
  `:894-898`), `entity.h` (`:32`, `:144`), `kbe/src/lib/client_lib/kbemain.h:102`,
  `kbe/src/lib/entitydef/entity_macro.h` (`:42-53`, `:56-62`, `:689`,
  `:739`, `:1010-1032`, `:1276-1355`, `:1496`),
  `kbe/src/lib/entitydef/entities.h:114-126`
- Source material (rewritten, not copied): kbengine `docs/api/kbengine/client/`
  `KBEngine.md`, `Entity.md`, `index.md` (CHM conversion; glued-token layout)
- Baseline & annotation rules:
  [python-version-baseline](python-version-baseline.md) (§7 template, §6 fork-over-docs rule)
- Client SDK plugins: outside this repo (`kbe/src/client/README.md` links the
  official demos) — official SDK documentation is the source for
  Plugin-layer rows above
