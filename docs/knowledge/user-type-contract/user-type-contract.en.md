# Engine Mechanism 04 · User-Defined Type Three-Contracts & Data-Flow Direction

> KB-001 Knowledge Base, third batch · Engine Mechanism Doc · English edition (Chinese edition: [`user-type-contract.zh.md`](./user-type-contract.zh.md))
>
> **Evidence rule**: every engine-behaviour conclusion here carries a `kbe/src` source citation (`file:line`). The primary source is the in-repo source-level analysis artifacts plus the official KBEngine source (online `kbe/src`; the user's local `~/workspaces/kbengine` is absent — see "Evidence Sources" at the end); anything neither covers is marked `TODO 待验证` — **rather omit than fabricate**.

---

## 0. Reading Map

| You want to know | Jump to |
|---|---|
| Which three methods a user type (FIXED_DICT + implementedBy) must implement | §1.1 |
| What happens if one is missing (engine startup registration fails) | §1.2 |
| How PYTHON types cross the network (pickle) | §1.3 |
| Serialization = instance⇄dict; persistence uses same line but onlyPersistents | §1.4 |
| How property Flags decide sync direction (who has it, who doesn't) | §2.1 |
| How method sections (Base/Cell/ClientMethods) decide call direction | §2.2 |
| Direction graph (baseapp↔cellapp→clients) | §2.3 |
| file:line source evidence per direction rule | §3 |
| Common developer-mistake list | §4 |
| Verification-pending list | §5 |
| Evidence sources | §6 |

---

## 1. Three Contracts: The Interface a User-Defined Type Must Satisfy

### 1.1 The Contract List: three methods a user type must implement

A user-defined type (FIXED_DICT paired with `<implementedBy>`) is required, when the engine loads `types.xml` at startup, to expose three methods on its implementation object. The engine fetches them in `FixedDictType::setImplModule` (`kbe/src/lib/entitydef/datatype.cpp`):

| Contract | Method | Where engine fetches | Purpose |
|---|---|---|---|
| ① Deserialize | `createObjFromDict(dictData)` | `datatype.cpp:2385` | rebuild an instance from a dict (called by `impl_createObjFromDict` `:2410`, call at `datatype.cpp:2420`) |
| ② Serialize | `getDictFromObj(obj)` | `datatype.cpp:2392` | flatten an instance back to a dict (called by `impl_getDictFromObj` `:2437`, call at `datatype.cpp:2439`) |
| ③ Type check | `isSameType(obj)` | `datatype.cpp:2399` | decide whether an object is a legal instance (called by `impl_isSameType` `:2452`, call at `datatype.cpp:2454`) |

All three fetches are null-checked; any failure makes the function `return false` (`datatype.cpp:2385-2404`).

**Contract semantics (how the engine uses the three methods):**

- `createObjFromDict`: `impl_createObjFromDict` (`datatype.cpp:2410-2434`) first checks whether the incoming value is already an instance of this type (`PyObject_TypeCheck` + `impl_isSameType`, `:2414`); if so it `Py_INCREF`s and returns it directly; otherwise it calls `createObjFromDict_` (`:2420`), then validates the return value with `impl_isSameType` (`:2423`); on validation failure it prints `".isSameType() is failed!"` and returns `Py_None` (`:2427-2431`). **Note: your `createObjFromDict` return value must pass your own `isSameType`, or the engine treats it as a serialization failure.**
- `getDictFromObj`: `impl_getDictFromObj` (`datatype.cpp:2437-2449`) calls the implementation directly; on failure returns `parseDefaultStr("")` (empty default).
- `isSameType`: `impl_isSameType` (`datatype.cpp:2452-2464`) calls the implementation and coerces to bool.

### 1.2 Missing one: engine startup registration fails

`setImplModule` (`datatype.cpp:2362`) is the single entry point where the engine loads a user type's implementation. It fetches `createObjFromDict` (`:2385`), `getDictFromObj` (`:2392`), `isSameType` (`:2399`) in order, and **any failure returns false** (`:2386-2404`), making the caller `loadImplModule` (`:2333`) fail, which in turn fails the `implementedBy` branch of `FixedDictType::initialize` (`:2178-2179`, when the component type is CELLAPP/BASEAPP/CLIENT).

**The consequence is a startup registration failure, not a silent runtime degradation:**

- `DataTypes::initialize` (`datatypes.cpp:53`) calls `fixedDict->initialize(...)` (`datatypes.cpp:139`) for each FIXED_DICT while parsing `types.xml`; a false return fails the whole init → `EntityDef::initialize` fails (`entitydef.cpp:181-182`, `DataTypes::initialize(defFilePath + "types.xml")`) → every process fails to initialise.
- So **missing any method = engine fails at startup**, with errors like `FixedDictType::loadImplModule: <module>.impl error!` or `FixedDictType::initialize(): FIXED_DICT(<name>) setImplModule error!` (`datatype.cpp:2342`, `:2214`).

**Correct practice**: implement all three, with matching names and signatures: `createObjFromDict(self, dictData)` / `getDictFromObj(self, obj)` / `isSameType(self, obj)`.

### 1.3 PYTHON types over the network: pickle byte streams

The generic `PYTHON` type (non-FIXED_DICT) crosses the network as a Python pickle, not field by field:

- `PythonType::addToStream` (`datatype.cpp:1225-1229`): `script::Pickler::pickle(pyValue)` yields the pickle byte string, then `mstream->appendBlob(datas)` (`appendBlob` = u32 length + bytes, per memorystream.h and the C-15 codec).
- `PythonType::createFromStream` (`datatype.cpp:1232-1241`): `mstream->readBlob(datas)` reads the bytes; empty → `Py_None` (`:1237-1238`), else `script::Pickler::unpickle(datas)`.
- `PythonType::isSameType` (`datatype.cpp:1177-1190`): **legality is decided via `Pickler::pickle(pyValue).empty()`** — pickleable (non-empty) means legal, else `OUT_TYPE_ERROR("PYTHON")`. This means **unpickleable objects (some EntityCalls, lambdas) fail on write/validation**.

**PY_DICT / PY_TUPLE / PY_LIST share the pickle framework** (`PyDictType::isSameType` `datatype.cpp:1255`, `PyTupleType` `:1311`, `PyListType` `:1367`, all subclass `PythonType`), same byte layout as PYTHON (u32 length + pickle bytes), consistent with wire_codec.rs's `PYTHON = opaque pickle bytes`.

### 1.4 Serialization = instance⇄dict; persistence on the same line but onlyPersistents

**One serialization line, two directions:**

- **Write (instance→dict→bytes)**: `impl_getDictFromObj` (`datatype.cpp:2437`) first flattens the instance into a dict, then `FixedDictType::addToStreamEx` (`datatype.cpp:2594`) iterates declared keys and `addToStream`s each value into the stream.
- **Read (bytes→dict→instance)**: `FixedDictType::createFromStreamEx` (`datatype.cpp:2675`) reads the dict back from the stream, then goes through `impl_createObjFromDict` (`datatype.cpp:2410`) / `createObjFromDict` to rebuild the instance.

**`onlyPersistents`: the single switch that separates persistence from live sync.**

`addToStreamEx` (`datatype.cpp:2594`) takes `bool onlyPersistents`. While iterating keys (`datatype.cpp:2608-2614`):

```
if(onlyPersistents) {
    if(!iter->second->persistent)   // key declared non-persistent
        continue;                    // skip, not written to the stream
}
```

- **Live property sync** (`addClientDataToStream` → `addToStreamEx`, default `onlyPersistents=false`): all declared keys are written.
- **Persistence** (`onlyPersistents=true`): only keys marked `<Persistent>` true are written; non-persistent keys are `continue`d (`datatype.cpp:2610-2614`).
- Fallback on a missing key: writes the `parseDefaultStr("")` default (`datatype.cpp:2619-2635`); type mismatch likewise (`:2638-2652`) — keeps stream layout stable.

**Relation to cellData**: on the cell side `backupCellData` calls `addCellDataToStream(BASEAPP_TYPE, ENTITY_CELL_DATA_FLAGS, s)` (`server/cellapp/entity.cpp:1139`) to pack cell properties to baseapp; baseapp holds the snapshot in `cellDataDict_` (`server/baseapp/entity.cpp:52`), taking the persistent subset at write time (`:406`, `getPersistentPropertyDescriptions()`). Persistence is the same line + `onlyPersistents` filtering, not a separate path (consistent with [Persistence Flow §4 cellData snapshot semantics](../persistence-flow/persistence-flow.en.md)).

---

## 2. Data-Flow Direction: property Flags set sync direction, method sections set call direction

### 2.1 Property Flags: which process holds the property, which side it syncs to

**Bit definitions of the 9 flags** (`kbe/src/lib/entitydef/common.h:17-28`, `enum EntityDataFlags`):

| Flag (string in .def) | Bit | Engine constant | Semantics (source comment) |
|---|---|---|---|
| `CELL_PUBLIC` | `0x01` | `ED_FLAG_CELL_PUBLIC` | broadcast to surrounding cells |
| `CELL_PRIVATE` | `0x02` | `ED_FLAG_CELL_PRIVATE` | current cell only |
| `ALL_CLIENTS` | `0x04` | `ED_FLAG_ALL_CLIENTS` | cell broadcasts to all clients |
| `CELL_PUBLIC_AND_OWN` | `0x08` | `ED_FLAG_CELL_PUBLIC_AND_OWN` | cell broadcasts to surrounding + own client |
| `OWN_CLIENT` | `0x10` | `ED_FLAG_OWN_CLIENT` | current cell and own client only |
| `BASE_AND_CLIENT` | `0x20` | `ED_FLAG_BASE_AND_CLIENT` | base and own client |
| `BASE` | `0x40` | `ED_FLAG_BASE` | current base only |
| `OTHER_CLIENTS` | `0x80` | `ED_FLAG_OTHER_CLIENTS` | cell broadcasts to other clients (not own) |

(Also `ED_FLAG_UNKOWN = 0x00`, `common.h:19`.)

**.def string → Flag mapping** (`entitydef.cpp:161-174`, `g_entityFlagMapping`):

| .def string | Maps to |
|---|---|
| `BASE` | `ED_FLAG_BASE` (`:166`) |
| `BASE_AND_CLIENT` | `ED_FLAG_BASE_AND_CLIENT` (`:165`) |
| `CELL_PUBLIC` / `CELL` | `ED_FLAG_CELL_PUBLIC` (`:168` / `:161`) |
| `CELL_PRIVATE` | `ED_FLAG_CELL_PRIVATE` (`:169`) |
| `ALL_CLIENTS` / `CELL_AND_CLIENTS` | `ED_FLAG_ALL_CLIENTS` (`:170` / `:163`) |
| `CELL_PUBLIC_AND_OWN` / `CELL_AND_CLIENT` | `ED_FLAG_CELL_PUBLIC_AND_OWN` (`:171` / `:162`) |
| `OWN_CLIENT` | `ED_FLAG_OWN_CLIENT` (`:174`) |
| `OTHER_CLIENTS` / `CELL_AND_OTHER_CLIENTS` | `ED_FLAG_OTHER_CLIENTS` (`:173` / `:164`) |

**Derived "ownership groups" — the criterion for who-has-it / who-doesn't** (`common.h:38-56`, `enum EntityDataFlagRelation`):

| Group constant | Members | Meaning |
|---|---|---|
| `ENTITY_BASE_DATA_FLAGS` | `BASE \| BASE_AND_CLIENT` | exists in baseapp |
| `ENTITY_CELL_DATA_FLAGS` | `CELL_PUBLIC \| CELL_PRIVATE \| ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OTHER_CLIENTS \| OWN_CLIENT` | exists in cellapp |
| `ENTITY_CLIENT_DATA_FLAGS` | `BASE_AND_CLIENT \| ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OTHER_CLIENTS \| OWN_CLIENT` | exists in client |
| `ENTITY_BROADCAST_CELL_FLAGS` | `CELL_PUBLIC \| ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OTHER_CLIENTS` | must broadcast to surrounding cellapps (ghost) |
| `ENTITY_BROADCAST_OTHER_CLIENT_FLAGS` | `OTHER_CLIENTS \| ALL_CLIENTS` | must broadcast to other clients |
| `ENTITY_BROADCAST_OWN_CLIENT_FLAGS` | `ALL_CLIENTS \| CELL_PUBLIC_AND_OWN \| OWN_CLIENT \| BASE_AND_CLIENT` | must broadcast to own client |

**Flag → which process registers it** (`entitydef.cpp:1287-1297`, end of `loadDefPropertys`; component properties identical at `:864-874`):

```
if(hasCellFlags > 0)   addPropertyDescription(..., CELLAPP_TYPE);   // :1287-1289
if(hasBaseFlags > 0)   addPropertyDescription(..., BASEAPP_TYPE);   // :1291-1293
if(hasClientFlags > 0) addPropertyDescription(..., CLIENT_TYPE);    // :1295-1297
```

`hasBaseFlags/hasCellFlags/hasClientFlags` are the above three groups bitwise-ANDed with `flags` (`entitydef.cpp:1150-1160`; component version `:851-861`). **A property can register into several processes at once — that is precisely the result of a flag bit combination, not a three-way choice.**

**Per-flag: who has it, who doesn't (sync-direction decision table)**

| Flag | baseapp | cellapp | client (own) | client (others) | Sync code path |
|---|---|---|---|---|---|
| `BASE` | ✅ | ❌ | ❌ | ❌ | no broadcast, baseapp-local only (in BASE group, `common.h:41`) |
| `BASE_AND_CLIENT` | ✅ | ❌ | ✅ | ❌ | baseapp → own client: `baseapp/entity.cpp:128` (`flags & ED_FLAG_BASE_AND_CLIENT` check, sends `onUpdatePropertys` at `:159`) |
| `CELL_PUBLIC` | ❌ | ✅ | ❌ | ❌ | cell → surrounding cells (ghost broadcast): `cellapp/entity.cpp:686` (`flags & ENTITY_BROADCAST_CELL_FLAGS`) |
| `CELL_PRIVATE` | ❌ | ✅ | ❌ | ❌ | cell-local only, no broadcast (in no CLIENT/BROADCAST group) |
| `ALL_CLIENTS` | ❌ | ✅ | ✅ | ✅ | cell → all clients: matches both `cellapp/entity.cpp:721` (other) and `:851` (own) |
| `CELL_PUBLIC_AND_OWN` | ❌ | ✅ | ✅ | ❌ | cell → surrounding cells + own client: `:686` (cell broadcast) + `:851` (own) |
| `OWN_CLIENT` | ❌ | ✅ | ✅ | ❌ | cell → own client only: `cellapp/entity.cpp:851` (`flags & ENTITY_BROADCAST_OWN_CLIENT_FLAGS`) |
| `OTHER_CLIENTS` | ❌ | ✅ | ❌ | ✅ | cell → other clients only: `cellapp/entity.cpp:721` (`flags & ENTITY_BROADCAST_OTHER_CLIENT_FLAGS`) |

**Criterion source**: whether each direction has the property is decided by the group constants in `common.h:38-56` bitwise-ANDed with `flags`; broadcast trigger points are in `cellapp/entity.cpp` and `baseapp/entity.cpp` (`cellapp/entity.cpp:686` cell broadcast, `:721` other clients, `:851` own client; `baseapp/entity.cpp:128` base→client).

**Concrete group-filter code at broadcast time** (inside `onUpdateData` in `cellapp/entity.cpp`):

- **cell-to-cell broadcast (ghost)**: `if((flags & ENTITY_BROADCAST_CELL_FLAGS) > 0 && hasGhost())` → `onUpdateGhostPropertys` (`:686-717`).
- **other clients**: `if((flags & ENTITY_BROADCAST_OTHER_CLIENT_FLAGS) > 0)` iterates witnesses (`:721-793`).
- **own client**: `if((flags & ENTITY_BROADCAST_OWN_CLIENT_FLAGS) > 0 && clientEntityCall_ != NULL && pWitness_)` (`:851-890`).
- **baseapp → own client**: `if((flags & ED_FLAG_BASE_AND_CLIENT) <= 0 || clientEntityCall_ == NULL) return;` (`baseapp/entity.cpp:128-129`).

### 2.2 Method sections: deciding call direction (who may call whom)

**The three method sections are not a naming convention — they are written into the `domain` field of `MethodDescription`.** Each loader sets the domain at construction:

| .def section | Loader | domain at construction | Source |
|---|---|---|---|
| `<CellMethods>` | `loadDefCellMethods` | `CELLAPP_TYPE` | `entitydef.cpp:1324` |
| `<BaseMethods>` | `loadDefBaseMethods` | `BASEAPP_TYPE` | `entitydef.cpp:1467` |
| `<ClientMethods>` | `loadDefClientMethods` | `CLIENT_TYPE` | `entitydef.cpp:1610` |

The three sections are entered in order inside `loadAllDefDescription` (`entitydef.cpp:937` / `:946` / `:955`).

**domain drives `isBase()/isCell()/isClient()`** (`method.inl:51-63`):

```
bool isCell()   const { return methodDomain_ == CELLAPP_TYPE; }
bool isBase()   const { return methodDomain_ == BASEAPP_TYPE; }
bool isClient() const { return !isCell() && !isBase(); }   // i.e. CLIENT_TYPE
```

**Runtime landing of call direction — lookup by domain:**

| Arriving at | Message handler | Which method table | Source |
|---|---|---|---|
| baseapp receives a remote call | `Entity::onRemoteMethodCall` | `findBaseMethodDescription(utype)` | `baseapp/entity.cpp:929` |
| cellapp receives a remote call | `Entity::onRemoteMethodCall` | `findCellMethodDescription(utype)` | `cellapp/entity.cpp:922` |
| cellapp receives a client call | `Entity::onRemoteCallMethodFromClient` | `findCellMethodDescription(utype)` + `isExposed()` check | `cellapp/entity.cpp:960-966` |
| client receives a server call | `Entity::onRemoteMethodCall` | `findClientMethodDescription(utype)` | `client_lib/entity.cpp:205` |

**Key point**: baseapp's `onRemoteMethodCall` looks up only the base table (`:929`); a miss logs `can't found method` and discards via `s.done()` (`:930-941`). cellapp likewise looks up only the cell table (`:922-930`). **So "calling a cell method on baseapp" is not rejected — it simply has no table entry → error and discard.**

**The `Exposed` sub-tag = whether a cell method may be called by clients** (`method.h:26-35`, `EXPOSED_TYPE`: `NO_EXPOSED=0` / `EXPOSED=1` / `EXPOSED_AND_CALLER_CHECK=2`). If a client-originated call hits an unexposed method, `onRemoteCallMethodFromClient` logs `not is exposed, call is illegal!` and discards (`cellapp/entity.cpp:963-970`). `Exposed` is set at load time by `<Arg> Exposed </Arg>` (`entitydef.cpp:1334-1337`).

**Load-time static validation** (`EntityDef::checkDefMethod`, `entitydef.cpp:1867-1894`): if a script method's argument count mismatches the def declaration → if already exposed it tries to upgrade to `EXPOSED_AND_CALLER_CHECK` (`:1871-1874`), otherwise `ERROR_MSG` and return false (`:1877-1883`); it also **warns on exposed cell methods**, suggesting `def {}(self, callerID, ...)` for caller validation (`:1888-1893`) — the engine's built-in "don't expose cell methods you shouldn't" safety hint.

### 2.3 Direction graph: baseapp↔cellapp→clients

```
              ┌────────────────────────────────────────────┐
              │                baseapp                      │
              │  properties: BASE / BASE_AND_CLIENT         │
              │  methods:    BaseMethods section            │
              │  cellDataDict_ holds cell-side snapshot     │
              └──────┬──────────────────────┬──────────────┘
         ① two-way   │ base↔cell            │ ② BASE_AND_CLIENT
   baseEntityCall_ ←→│ cellEntityCall_      │    property → own client
              ┌──────┴────────────┐         │
              │   cellapp          │         │
              │  properties: CELL_*│         │
              │  methods: CellMethods│       │
              │  witness culling   │         │
              └──────┬─────────────┘         │
        ③ prop cast  │ cell → clients        │
   ┌─────────────────┼─────────────────┐     │
   │   own client    │   other clients  │     │
   │   OWN group     │   OTHER group    │     │
   │   (ownClient)   │   (otherClients) │     │
   └─────────────────┴─────────────────┘     │
        ④ method down   cell method → client │
        ⑤ method up     client → cell (Exposed)│
```

**Direction rule per edge (each backed by the evidence above):**

| Edge | Direction | Carries | Evidence |
|---|---|---|---|
| ① base↔cell | two-way | method calls: base calls cell method / cell calls base method (via `EntityCall` handles); properties: cell pushes a cellData snapshot to base (`backupCellData`) | `baseapp/entity.cpp:1028` (cellEntityCall_ built as `ENTITYCALL_TYPE_CELL`); `cellapp/entity.cpp:1180` (`baseEntityCall_->sendCall`, `onBackupEntityCellData`) |
| ② base→client | one-way (own client only) | property `BASE_AND_CLIENT`; `BaseMethods` are not client-callable (clients only call exposed cell methods) | `baseapp/entity.cpp:128-129` (`ED_FLAG_BASE_AND_CLIENT` check), `:159` (`sendToClient`) |
| ③ cell→clients | one-way broadcast | properties bucketed by `ALL_CLIENTS` / `OWN_CLIENT` / `OTHER_CLIENTS` / `CELL_PUBLIC_AND_OWN`, culled by witness | `cellapp/entity.cpp:721` (other), `:851` (own) |
| ④ server→client method | one-way | `ClientMethods` section methods | `client_lib/entity.cpp:205` (`findClientMethodDescription`) |
| ⑤ client→cell method | one-way | only exposed `CellMethods`; unexposed → illegal, discarded | `cellapp/entity.cpp:960-966` (`isExposed()` check) |

**Supplementary direction semantics (base↔cell property data is not symmetric):**

- The cell side **owns** cell properties (`ENTITY_CELL_DATA_FLAGS`) and pushes only a **snapshot** to base for persistence (`cellapp/entity.cpp:1139` `addCellDataToStream(BASEAPP_TYPE, ...)`); the base side never writes back cell properties (cell is the source of cellData).
- The base side **reads** cellData only (`baseapp/entity.cpp:52`), taking the persistent subset at write time (`:406`).
- **Method calls are the only truly two-way edge**: base calls cell methods via `cellEntityCall_->sendCall` (EntityCall is a remote proxy, see [Memory Pitfalls §2](../memory-references/memory-references.en.md)); cell calls base methods via `baseEntityCall_->sendCall` (`cellapp/entity.cpp:1180`).

---

## 3. file:line Source Evidence per Direction Rule (master table)

> The `kbe/src` line numbers come from the official KBEngine source (online `kbe/src`, since the user's local `~/workspaces/kbengine` is absent — see §6). Each was checked against the source; unverified items are marked `TODO 待验证`.

| Rule | Source location |
|---|---|
| Three-contract fetches: createObjFromDict / getDictFromObj / isSameType | `lib/entitydef/datatype.cpp:2385` / `:2392` / `:2399` (checks `:2386-2404`) |
| Missing any → return false → startup registration fails | `datatype.cpp:2362` (setImplModule), `:2333` (loadImplModule), `:2178-2179` (initialize failure), `datatypes.cpp:139`, `entitydef.cpp:181-182` |
| PYTHON over network = pickle | `datatype.cpp:1225-1229` (addToStream), `:1232-1241` (createFromStream), `:1177-1190` (isSameType via pickle.empty()) |
| Serialization = instance⇄dict | `datatype.cpp:2437` (impl_getDictFromObj), `:2410` (impl_createObjFromDict), `:2594` (addToStreamEx), `:2675` (createFromStreamEx) |
| Persistence same line + onlyPersistents | `datatype.cpp:2594` (signature), `:2610-2614` (skip non-persistent keys), `:2619-2635` (missing-key fallback) |
| Property flag bit definitions (9) | `lib/entitydef/common.h:17-28` (enum EntityDataFlags) |
| String→Flag mapping | `entitydef.cpp:161-174` (g_entityFlagMapping) |
| Ownership groups (who has what) | `common.h:38-56` (enum EntityDataFlagRelation) |
| Flag→registered process | `entitydef.cpp:1287-1297` (entity props), `:864-874` (component props); bitwise-AND `:1150-1160` |
| Per-flag sync direction | `cellapp/entity.cpp:686` (cell broadcast), `:721` (other), `:851` (own); `baseapp/entity.cpp:128-129` (base→client) |
| Method section→domain | `entitydef.cpp:1324` (Cell), `:1467` (Base), `:1610` (Client) |
| domain→isBase/isCell/isClient | `lib/entitydef/method.inl:51-63` |
| Remote call looked up by domain | `baseapp/entity.cpp:929` (base table), `cellapp/entity.cpp:922` (cell table), `client_lib/entity.cpp:205` (client table) |
| client→cell requires Exposed | `cellapp/entity.cpp:960-966`; `method.h:26-35` (EXPOSED_TYPE); `entitydef.cpp:1334-1337` (parsing) |
| Method arg static validation | `entitydef.cpp:1867-1894` (checkDefMethod) |
| base↔cell two-way edge (EntityCall) | `baseapp/entity.cpp:1028` (cellEntityCall_), `cellapp/entity.cpp:1180` (baseEntityCall_->sendCall) |
| cell→base property snapshot | `cellapp/entity.cpp:1139` (backupCellData), `baseapp/entity.cpp:52` (cellDataDict_), `:406` (persistent subset) |
| Broadcast group-filter code | `cellapp/entity.cpp:686-717` (ghost), `:721-793` (other), `:851-890` (own) |

---

## 4. Common Developer Mistakes (wiki wording)

> Each entry follows **Symptom → Root cause (with source) → Correct practice**. This is the "land it in the wiki" part of the doc, directly feedable to hover / lint rules (C-23).

### Pitfall 4.1 Accessing a property in the wrong process

**Symptom**: reading `self.hp` in a baseapp script raises `AttributeError` or never returns the latest value; or a cellapp script reports a property declared only on base as absent.

**Root cause**: properties are registered per process by flag, not replicated to every process. `loadDefPropertys` adds only `hasCellFlags>0` properties to `CELLAPP_TYPE` and only `hasBaseFlags>0` to `BASEAPP_TYPE` (`entitydef.cpp:1287-1297`). For example a `Flags="CELL_PRIVATE"` property **exists only in cellapp**; the baseapp side has no such attribute at all.

**Correct practice**:

- Whether a property is reachable on base is decided by `ENTITY_BASE_DATA_FLAGS` (`BASE` / `BASE_AND_CLIENT`, `common.h:41`); on cell, by `ENTITY_CELL_DATA_FLAGS` (`common.h:43`).
- Need cell properties on base → read `self.cellData` (a snapshot, `baseapp/entity.cpp:52`); don't expect `self.<attr>`.
- Need base properties on cell → go through base methods (`<BaseMethods>`) or `self.base.<method>()`; don't assume a local copy.

### Pitfall 4.2 Wrong cross-process call direction (calling a cell method on baseapp / calling an unexposed method)

**Symptom**: `can't found method. utype=... callerID:...` (`baseapp/entity.cpp:932` / `cellapp/entity.cpp:926`), the call silently discarded; or a client call logs `not is exposed, call is illegal!` (`cellapp/entity.cpp:965`).

**Root cause**: methods have their domain hard-coded by section: `<BaseMethods>`→`BASEAPP_TYPE` (`entitydef.cpp:1467`), `<CellMethods>`→`CELLAPP_TYPE` (`:1324`), `<ClientMethods>`→`CLIENT_TYPE` (`:1610`). At runtime each process **looks up only its own domain table** (`baseapp/entity.cpp:929`, `cellapp/entity.cpp:922`). A wrong direction is not "permission denied" — **the entry simply isn't in the table**, hence "can't found method".

**Correct practice**:

- Want it to run on cell → put the method in `<CellMethods>`, call `self.cell.<method>()` from base.
- Want it to run on base → put it in `<BaseMethods>`, call `self.base.<method>()` from cell.
- Client-callable → the method must be in `<CellMethods>` with the `Exposed` sub-tag (`method.h:26-35`); security-sensitive ones use `def m(self, callerID, ...)` for caller checks (the engine warns about this, `entitydef.cpp:1888-1893`).
- **Do not** put client entry points in `<BaseMethods>` — clients only go through the cell exposed table (`cellapp/entity.cpp:960-966`); base-section exposure is not a client entry.

### Pitfall 4.3 Implementing only two of the user-type methods

**Symptom**: engine startup fails, log shows `FixedDictType::initialize(): FIXED_DICT(<name>) setImplModule error!` or `FixedDictType::loadImplModule: ... impl error!` (`datatype.cpp:2214` / `:2342`).

**Root cause**: `setImplModule` fetches all three methods in turn and immediately `return false` on any miss (`datatype.cpp:2385-2404`); there is no "serialize-only, skip type-check" degraded mode.

**Correct practice**: implement all three with correct signatures; the return value of `createObjFromDict` must pass your own `isSameType` (the engine re-validates, `datatype.cpp:2423`).

### Pitfall 4.4 Assuming a user type crosses the network field by field

**Symptom**: the client deserializes an unexpected object, or `unpickle` fails on a version mismatch.

**Root cause**: `PYTHON` / `PY_DICT` / `PY_TUPLE` / `PY_LIST` are always `Pickler::pickle`d then sent opaquely (`datatype.cpp:1225-1229`); only FIXED_DICT (without implementedBy) is sent key by key in declaration order (`datatype.cpp:2594-2660`). pickle is tightly coupled to the Python version and class definition.

**Correct practice**: for cross-end data (especially with C++/other-language ends) use FIXED_DICT / primitive types, not PYTHON; if you must, keep Python versions and class definitions identical on both ends.

### Pitfall 4.5 Assuming persistence writes all keys

**Symptom**: changing a non-persistent sub-key, it's gone after restart.

**Root cause**: persistence goes through `addToStreamEx(..., onlyPersistents=true)`; non-persistent keys are `continue`d (`datatype.cpp:2610-2614`).

**Correct practice**: keys you want persisted must be marked `<Persistent> True</Persistent>` in the def; non-persistent keys serve live sync only.

---

## 5. Verification-Pending List

| # | Item | Why unverified |
|---|---|---|
| 1 | Historical evolution of `EntityDataFlagRelation` groups (version differences) | Only current master checked; no multi-version diff |
| 2 | Exact witness / DETAIL_LEVEL culling boundary for broadcast | `cellapp/entity.cpp:723-748` has detailLevel checks, but the full view-radius / enter-leave-view timing belongs to the entity-lifecycle topic, not expanded here |
| 3 | Cross-cellapp forwarding chain for `ENTITY_BROADCAST_CELL_FLAGS` ghost broadcast | The GhostManager forwarding after `gm->pushMessage(ghostCell(), ...)` (`:716`) was not read |
| 4 | Whether client-side `onUpdatePropertys` re-validates `CELL_*` property flags | Only read to `client_lib/entity.cpp:259`; branches not checked per flag |
| 5 | Whether `onlyPersistents` also filters on the `createFromStreamEx` (read-back) direction | Passing visible at `datatype.cpp:2675-2681`, but the filtering inside `FixedDict::initialize` was not expanded |

---

## 6. Evidence Sources

- **User's local engine source** `~/workspaces/kbengine/kbe/src`: **not present on this host** (`/home/cui/workspaces/kbengine` does not exist). Per the task's stated fallback, the **online official source** `https://github.com/kbengine/kbengine` `kbe/src` (master) was used to verify every line number: `lib/entitydef/datatype.cpp`, `datatype.h`, `entitydef.cpp`, `entitydef.h`, `common.h`, `method.h`, `method.inl`, `datatypes.cpp`, `server/cellapp/entity.cpp`, `server/baseapp/entity.cpp`, `lib/client_lib/entity.cpp`, `lib/entitydef/entity_macro.h`.
- **In-repo analysis artifacts (cross-check)**: `crates/kode-server/src/wire_codec.rs` (PYTHON*=pickle opaque, FIXED_DICT declaration order, with datatype.cpp line provenance); `crates/kode-server/tests/golden/wire-parity.json`; `docs/features.md` C-15 entry.
- **Existing topics in this KB**: [Persistence Flow](../persistence-flow/persistence-flow.en.md) (cellData / write-back timing), [Memory Pitfalls](../memory-references/memory-references.en.md) (EntityCall is a remote proxy), [Entity Lifecycle](../entity-lifecycle/entity-lifecycle.en.md).
- **Line-number caveat**: numbers are per online master; a different local checkout may be shifted, but **function names and semantics do not change**. Anything unverified is marked `TODO 待验证`; no line number was fabricated.

