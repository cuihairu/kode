# Engine Mechanism 02 · Timers & Messaging (timer semantics / precision / bundle mechanism)

> KB-001 Knowledge Base, second batch · Engine Mechanism Doc · English edition (Chinese edition: [`timer-messages.zh.md`](./timer-messages.zh.md))
>
> **Evidence rule**: every engine-behaviour conclusion here carries a `kbe/src` source citation (`file:line`). The primary source is the existing source-level analysis artifacts inside the kode repo (see "Evidence Sources" at the end); anything the in-repo analysis does not cover is marked `TODO 待验证` (to be verified) pending a check against the engine source — **rather omit than fabricate**.

---

## 0. Reading Map

| You want to know | Jump to |
|---|---|
| Which registration surfaces addTimer/delTimer exist on | §1 |
| Timer argument semantics, onTimer argument shape | §2.1 |
| How much timer precision you can expect | §2.2 |
| Timer vs entity destruction | §2.3 |
| How bytes on the wire are encoded (MemoryStream) | §3.1 |
| Message-frame / bundle-layer format | §3.2 |
| Method-call, property-update frame structure | §3.3 / §3.4 |

## 1. Three registration surfaces for timer

The same-named `addTimer` exists on **three different registration surfaces** in the engine, with different signatures and different availability per process — mixing them up is a common pitfall:

### 1.1 Entity-level (Entity.addTimer / delTimer)

| API | Signature | Source |
|---|---|---|
| `self.addTimer(initialOffset, repeatOffset=0.0, userArg=0)` | 1-3 args, returns timer handle | `lib/entitydef/entity_macro.h:17` (`DECLARE_PY_MOTHOD_ARG3`, macro at `lib/pyscript/py_macros.h:228`); impl `entity_macro.h:1387-1405` |
| `self.delTimer(id)` | Accepts int handle or `"All"` string | `lib/entitydef/entity_macro.h:18`; impl `:1407-1420` |

Base-side and cell-side entities each have their own pair (timers are per-lifetime). The client-side (bots process) Entity has the same-named pair too: `lib/client_lib/entity.cpp:32-33`.

Callback firing point: `onTimer(timerHandle, userData)` — base side `server/baseapp/entity.cpp:1656`, cell side `server/cellapp/entity.cpp:4322`; engine argument shape `(timerID, intptr(pUser))` see `entity_macro.h:1363`.

### 1.2 Component-level (EntityComponent.addTimer / delTimer)

`EntityComponent` has its own independent pair (`server/baseapp/entity_component.cpp:10-11`) — bound to the component's lifecycle, not the host entity's.

### 1.3 Module-level (KBEngine.addTimer — pythonapp-lineage only)

| API | Signature | Source |
|---|---|---|
| `KBEngine.addTimer(initialOffset, repeatOffset, callbackObj)` | **exactly 3 args** `"ffO"`, no defaults, 3rd is callback object | `lib/server/python_app.cpp:329`; impl `:721-726` |
| `KBEngine.delTimer(id) -> int` | Returns timerID, -1 on failure | `lib/server/python_app.cpp:330`; impl `:755-771` |

**Key fact: module-level addTimer is only available on pythonapp-lineage processes** (dbmgr / loginapp / interfaces / logger; shared registration region `python_app.cpp:271-334`); **baseapp / cellapp modules never register it** (`server/baseapp/baseapp.cpp:429-451`, `server/cellapp/cellapp.cpp:172-189` have no such entry — VALIDATION_REPORT deviation list). Writing `KBEngine.addTimer(...)` in base/cell scripts is an AttributeError.

## 2. Timer semantics and precision

### 2.1 Argument and callback semantics

- `initialOffset`: initial delay; `repeatOffset`: repeat interval; `userArg`: passed through as the second `onTimer` argument.
- Callback signature `onTimer(timerHandle: int, userData: int)` (`_KBEngine_hooks.pyi:90`/`:115`); engine-side actual args `(timerID, intptr(pUser))` (`entity_macro.h:1363`) — **userData travels through the intptr integer channel, not an arbitrary Python object**; what happens when an object reference is passed belongs to the binding layer, **TODO 待验证**.
- `repeatOffset=0` means a one-shot timer (official-doc phrasing; source line not separately evidenced, **TODO 待验证**).

### 2.2 Precision

- Argument unit is **seconds** (float, `"ffO"` parse surface `python_app.cpp:721-726`; entity-level same float surface). The engine drives expiry checks on the main-loop frame, so timer callback precision is bounded by the frame period — **the scheduler quantization behaviour (minimum granularity, position of expiry check within a frame) is not covered by the in-repo analysis, TODO 待验证**.
- The baseapp module surface has `quantumPassedPercent() -> int` (`server/baseapp/baseapp.cpp:439`, impl `:510-513`) returning the current frame progress percentage — corroborating the "frame/quantum" concept; the mapping from the quantum length config item to timer precision **TODO 待验证**.

### 2.3 Timer vs entity lifecycle

- Timer callback dispatch is governed by whether the engine still treats the entity as alive, not by whether a Python reference remains (first-batch conclusion, see [Memory References §4](../memory-references/memory-references.en.md#4-pitfall-class-4-timer--functor-holding-reference)). The precise engine path that stops dispatching after destroy **TODO 待验证**.
- Correct practice: cancel a repeating timer in `onDestroy` with `delTimer(handle)`; clear all at once with `delTimer("All")` (`entity_macro.h:18` impl `:1407-1420` accepts int or `"All"`). C-23 plans a `timer-leak-on-destroy` lint rule.

## 3. Messaging & bundle mechanism

### 3.1 Foundation: MemoryStream byte layout

All inter-process messages ultimately land on this byte layout (all **little-endian, fixed-width, no varint**, `lib/common/memorystream.h`; kode's Rust-authoritative reimplementation `crates/kode-server/src/wire_codec.rs` carries per-item source provenance):

| Type | Layout | Source |
|---|---|---|
| UINT8/16/32/64 | LE 1/2/4/8 bytes | `memorystream.h:259-281` |
| INT8/16/32/64 | LE 1/2/4/8 bytes (ENTITY_ID same width int32, `platform.h:342`) | `memorystream.h:283-305` |
| FLOAT / DOUBLE | IEEE754 LE 4/8 bytes | `memorystream.h:307-317` (datatype.cpp:540/:630) |
| BOOL | 1-byte int8, non-zero→true | `memorystream.h:247-251` |
| STRING | raw bytes + 0x00, no length prefix; empty string = single byte 0x00 | `memorystream.h:224-229` |
| UNICODE / BLOB / PYTHON / PY_DICT / PY_TUPLE / PY_LIST | u32 length + bytes (PYTHON* are opaque pickle bytes) | `memorystream.h:551-556` (appendBlob); datatype.cpp:1129-1142, :1225-1229, :1288-1296, :1344-1352, :1400-1408 |
| ENTITYCALL | 16-byte fixed: id i32 + component_id u64 + type u16 + script_uid u16 | `datatype.cpp:1512-1573` (width base `platform.h:345`) |

The script-side same-named `MemoryStream` class is the Python face of this layout (`lib/pyscript/py_memorystream.cpp:27-35`; `bytes()` method name not a dunder, `:30`; rpos/wpos/fill `:31-33`, `:540-646`).

### 3.2 Bundle layer: message-frame format

The bundle is the layer that frames messages for sending (`lib/network/bundle.cpp`):

- **Frame header**: `msgid u16 + length u16`; for variable-length messages the length field = **payload length (excluding the 4-byte frame header)** (`network/bundle.cpp:273-395`; enum base `lib/common/common.h:88-92`).
- **Variable-length backpatch**: the length is unknown until send time, so a placeholder is written then backpatched `currMsgLength_ - ID_SIZE - LENGTH_SIZE` (`bundle.cpp:346-347`).
- **Fixed-length messages**: no length field, fixed body read (`bundle.cpp:304-309`).
- **≥65535 extended-length frame**: length field written as 65535, then a u32 true length backpatched (`bundle.cpp:358-371`).
- Rust-side aligned implementation: `wire_codec.rs` `encode_message_frame` / `decode_message_frame` (`crates/kode-server/src/wire_codec.rs:1010-1054`), 35 golden samples locking byte-level equality (`crates/kode-server/tests/golden/wire-parity.json`).

### 3.3 Method-call frame (remote call of exposed methods)

`self.cell.X()` / `self.base.X()` / `self.client.X()` ultimately encode as:

- **Alias mode**: u8 componentPropertyAliasID (0=this entity) + u8 methodAliasID + args (`lib/client_lib/entity.cpp:169-182`; args have no count prefix, `entitydef/method.cpp:146-176`).
- **utype mode**: u16 methodUtype + args; component id is always 0 and never read (`client_lib/entity.cpp:184-190`, `:170-181`); method utype = uint16.

### 3.4 Property-update stream (cell→client sync frame structure)

- **Entity ID**: full i32 (`clientobjectbase.cpp:1113-1119` ENTITY_ID=int32) or alias u8.
- **Alias-mode entry**: parent u8 + child u8; **utype-mode entry**: parent u16 + child u16 (ENTITY_PROPERTY_UID=uint16, `lib/common/common.h:80`; property utype starts from 1 in def parse order, `entitydef/entitydef.cpp:1020-1094`).
- Special base properties position/direction/spaceID: alias-mode ids 1/2/3, utype-mode 40000/40001/40002.
- **Full snapshot is ordered alphabetically by property name** (the engine's `getClientPropertyDescriptions` is a std::map ordered container).

## 4. Verification-pending list (待验证清单)

| # | Point to verify | Section | Source evidence needed |
|---|---|---|---|
| 1 | How the engine holds/releases a Python object reference passed as userArg | §2.1 | entity_macro.h addTimer impl PyObject retention policy |
| 2 | Source line for repeatOffset=0 one-shot semantics | §2.1 | timer system class (lib/server/timer.* or equivalent) |
| 3 | Scheduler quantization of timer expiry (position within frame, minimum granularity) | §2.2 | main loop + Timers::process |
| 4 | Mapping from quantum length config to timer precision | §2.2 | baseapp config item + gametime impl |
| 5 | Precise engine path disabling timers after entity destroy | §2.3 | entity destruction path × Timers cleanup |
| 6 | Bundle send timing (batching/flush policy, per-frame merge) | §3.2 | network/channel send queue |
| 7 | msgid allocation table (which ids are internal messages) | §3.2 | message-table generation/registration code |
| 8 | Difference (if any) between server-to-server and client method-call frames | §3.3 | baseapp/cellapp-side method dispatch code |

## 5. Evidence Sources

In-repo artifacts directly checkable (the line numbers cited in this doc come from source forensics in these documents):

- `docs/reference/kbengine-typings-2026-10-21/VALIDATION_REPORT.md` — addTimer three registration surfaces, delTimer return value, missing module-level surface (deviation list)
- `docs/reference/kbengine-typings-2026-10-21/_KBEngine_hooks.pyi` — onTimer signature
- `crates/kode-server/src/wire_codec.rs` — C-15 Rust-authoritative wire codec, byte-for-byte reproduction of memorystream.h / bundle.cpp / datatype.cpp / client_lib/entity.cpp, each with file:line provenance
- `crates/kode-server/tests/golden/wire-parity.json` — 35 golden samples (byte-level equality)
- `docs/features.md` C-15 entry — codec scope and provenance summary
- `docs/knowledge/memory-references/` — timer/Functor holding-reference pitfalls (first batch)
- `todo.md` KB-001 / C-23 entries — timer-leak-on-destroy lint plan

The engine source tree itself (`kbe/src/...`) is not in the kode repo; the in-repo documents above were produced against the user's local KBEngine checkout (`~/workspaces/kbengine`). Behaviours not covered by the in-repo docs are marked TODO 待验证 throughout.
