# G9 Space Viewer / Watcher Panel · Engine Protocol Forensics

> Status: forensics complete (2026-10-24). This document only records the
> message surfaces that really exist in the kbengine engine source tree and
> the implementation locations on both the send and receive sides, for use
> by C-2 "minimal query panel" and C-3 "panel operation surface"; it does
> not mean the extension has implemented any panel capability.
>
> Forensics tree: `/home/cui/workspaces/kbengine` (the `kode` repo's
> `../kbengine` sibling, the same source as `tests/helpers/engineTree.ts`'s
> fallback probing discipline). All `file:line` below are measured line
> numbers in that tree.

## 1. The two protocol lines

The engine's console observation surface splits into two lines that share
nothing with each other:

| Line | Request message family | Receipt | Semantics |
|---|---|---|---|
| Watcher | `41001`–`41008` (numbered per process type, 8 total) | `65502` | tree-shaped watcher value reads (paths registered via `KBEngine.addWatcher`) |
| SpaceViewer | `50001`–`50005` | `65503` | Space/Cell topology and entity distribution snapshots |

The two lines use **different receipt message numbers**: the watcher line
uses `CONSOLE_WATCHERCB_MSGID = 65502` (`kbe/src/lib/helper/console_helper.h:11`,
`Watcher.py:10`; the server receipt at `console_helper.h:175`), while the
SpaceViewer / component-load line uses `CONSOLE_PROFILECB_MSGID = 65503`
(`console_helper.h:12`, `:227`/`:249`/`:271`). The client side registers
each correspondingly: `Watcher.py:60` registers `65502`, and
`SpaceViews.py:56`/`:128`/`:186` together with `Component_Status.py:42`
register `65503`. If a panel receives both lines it must **register both
receipts** — registering only `65503` silently drops watcher receipts; this
is the root cause of this table's earliest version mis-recording "both lines
share 65503".

## 2. Message number table (real source: `kbe/tools/server/pycommon/`)

Watcher request numbers, `kbe/tools/server/pycommon/Watcher.py:32-40`:

```python
CMD_ID_queryWatcher = {
    Define.BASEAPP_TYPE    : 41001,
    Define.CELLAPP_TYPE    : 41002,
    Define.LOGINAPP_TYPE   : 41003,
    Define.BASEAPPMGR_TYPE : 41004,
    Define.CELLAPPMGR_TYPE : 41005,
    Define.DBMGR_TYPE      : 41006,
    Define.INTERFACES_TYPE : 41007,
    Define.LOGGER_TYPE     : 41008,
    ...
}
```

SpaceViewer / component-load request numbers:
`kbe/tools/server/pycommon/SpaceViews.py:33-37` (SpaceViewer) and
`kbe/tools/server/pycommon/Component_Status.py:33-34` (queryAppsLoads):

| Message number | Message name | Target process | Declaration site |
|---|---|---|---|
| 50001 | `Baseappmgr::queryAppsLoads` | baseappmgr | `kbe/src/server/baseappmgr/baseappmgr_interface.h:116` |
| 50002 | `Cellappmgr::queryAppsLoads` | cellappmgr | `kbe/src/server/cellappmgr/cellappmgr_interface.h:91` |
| 50003 | `Cellappmgr::querySpaces` | cellappmgr | `kbe/src/server/cellappmgr/cellappmgr_interface.h:94` |
| 50004 | `Cellapp::querySpaceViewer` (single-Space view) | cellapp | `SpaceViews.py:142`, sent directly by the client |
| 50005 | `Cellapp::querySpaces` (full) | cellapp | `SpaceViews.py:36`, sent directly by the client |

Server-side implementations (measured in the same tree):
- `kbe/src/server/cellappmgr/cellappmgr.cpp:559` `Cellappmgr::querySpaces`
- `kbe/src/server/cellappmgr/cellappmgr.cpp:631` `Cellappmgr::setSpaceViewer`
- `kbe/src/server/cellapp/cellapp.cpp:2259` `Cellapp::setSpaceViewer`
- `kbe/src/server/cellapp/cellapp_interface.h:165` `setSpaceViewer` message declaration
- `kbe/src/server/cellapp/cellapp_interface.h:135` `queryWatcher` message declaration

Receipts split across two numbers (see §1):
- watcher line `CONSOLE_WATCHERCB_MSGID = 65502` — `Watcher.py:10`; the
  server message header `kbe/src/lib/helper/console_helper.h:11` (client
  handler `ConsoleWatcherCBMessageHandler`, message name
  `"console::queryWatcher"`; `console_helper.h:175` forces
  `msgID = CONSOLE_WATCHERCB_MSGID`).
- SpaceViewer / load line `CONSOLE_PROFILECB_MSGID = 65503` — defined at the
  same value in three places, `SpaceViews.py:13`, `Component_Status.py:13`,
  `Watcher.py:11`; server side `console_helper.h:12`, `:227`/`:249`/`:271`.

Note that `Watcher.py` **defines both constants** (`:10` is 65502, `:11` is
65503), but what actually registers the receipt is `:60`'s 65502; earlier
notes mistakenly recorded the receipt as 65503 because "both constants exist
in the same file".

## 3. Console connection sequence

The real reference implementation = the engine webconsole's bundled Python
client (the panel can copy against it directly):

1. **Connect**: take the target process address from
   `Machines.ComponentInfo.{intaddr,intport}` and connect directly via
   `ServerApp.connect(host, port)` (usage sample comments at
   `SpaceViews.py:44-46`).
2. **Register receipts**: `registerMsg(65503, onXxxMsg)` (`SpaceViews.py:56`);
   the watcher line correspondingly registers
   `registerMsg(65502, onWatcherMsg)` (`Watcher.py:60`).
3. **Send requests**: `MessageStreamWriter(<request number>)` then
   `self.send(msg)` (`SpaceViews.py:66-70`; the SpaceViewer request body is
   empty — only the message number).
4. **Receive receipts**: streamed reads, see §4; reading to EOF ends one
   round.
5. **Poll**: webconsole repeats 3-5 in its websocket loop
   (`views_spaceviewer.py:131-149`).

The `CellAppMgrViewer` class additionally has a cellappmgr-side topology
view (`SpaceViews.py:118-142`), request number `50004`, same receipt
`65503`.

## 4. Receipt stream format (`kbe/tools/server/pycommon/SpaceViews.py:73-113`)

`onSpaceViewerMsg`'s real read order (**the sole basis for C-2's decoding
surface**):

```python
componentType = streamReader.readInt32()      # target process type
componentID   = streamReader.readInt64()      # target process component ID
while not streamReader.EOF():
    CellAppCID  = streamReader.readUint64()   # cellapp component ID
    SpacesSize  = streamReader.readUint32()   # that cellapp's Space count
    for i in range(SpacesSize):
        SpaceID        = streamReader.readUint32()
        SpacePath      = streamReader.readString()
        ScriptModuleName = streamReader.readString()
        SpaceCellSize  = streamReader.readUint32()
        for j in range(SpaceCellSize):
            CELL_ID = streamReader.readUint32()
```

That is: **process header (int32 + int64) → variable-length section per
cellapp → fixed-length section per Space → fixed-length section per Cell**.
`queryAppsLoads`' receipt uses the same `65503`, decoded by
`Component_Status.py:42-54`.

Value type enums (the watcher line and the SpaceViewer line share the same
numeric semantics): both `SpaceViews.py:15-30` and `Watcher.py:14-30` use
`UNKNOWN=0 … COMPONENT_TYPE=14` (uint8/16/32/64, int8/16/32/64, float,
double, char, string, bool, component_type).

## 5. The watcher registration surface (the engine-side basis for C-3's "add/remove watcher")

Script-side API: `KBEngine.addWatcher`, referenced by
`kbe/src/server/tools/guiconsole`, is implemented in
`kbe/src/lib/pyscript/pywatcher.cpp`:

- `pywatcher.cpp:28` `addWatcher(PyObject*, PyObject*)`: two forms,
  `addWatcher(watcherName, deftype, pyCallable)` and
  `addWatcher(watcherPath, deftype, pyCallable)`; deftype accepts only
  `UINT8|UINT16|UINT32|UINT64|INT8|INT16|INT32|INT64|FLOAT|DOUBLE|CHAR|STRING`;
  a wrong value raises `PyErr_Format`
  (`pywatcher.cpp:32,44,52,60,73,83`).
- `pywatcher.cpp:93-137` dispatches `_addWatcher<T>` by deftype;
  `pywatcher.cpp:149-165` `delWatcher`; `pywatcher.cpp:184` module method
  registration.
- Value objects and the path table: `pywatcher.h` / `pywatcher.inl`
  (included at `pywatcher.cpp:4-7`); the watcher definitions proper live in
  `kbe/src/lib/helper/watcher.h` (`watcher.h:227` watches a value directly,
  `:260` watches a method's return value, `:294` watches a member function's
  return value).

## 6. Interface implications for C-2's "minimal query panel"

The panel's minimal loop needs only three things:

1. **Get the address**: reuse `Machines.ComponentInfo`
   (`Component_Status.py` already has the same-source reading) to obtain
   cellappmgr's `intaddr/intport`.
2. **Send 50003**: an empty-body `Cellappmgr::querySpaces`, receipt `65503`.
3. **Decode in §4's order**: table columns = `componentID` (process),
   `SpaceID`, `SpacePath`, `ScriptModuleName`, `CELL_ID[]`; empty sections
   (a cellapp with `SpacesSize=0`) display honestly as empty, with no
   default rows padded in.

No dependency on the engine's Python runtime — `MessageStreamWriter`'s write
surface is just "message number + empty body", so the extension side can use
its own connection implementation, but **the decode order must copy §4 field
by field**; otherwise a misaligned `readString` wrecks the whole frame.

## 7. Boundaries and un-forensic'd items

- `queryAppsLoads` (50001/50002) receipt field composition not expanded
  field by field; only the client entry at `Component_Status.py:54` is
  confirmed. If C-2 also builds a load column, separate forensics is needed.
- The watcher line's `queryWatcher` request body is forensics'd:
  `Watcher.py:70-76` `requireQueryWatcher` writes only one string,
  `msg.writeString(path)` (`:75`), with no depth field; the receipt uses
  `65502`, decoded by `Watcher.py:78` `onWatcherMsg`. C-3's panel watch-list
  is therefore only a registry of query targets and does not involve
  engine-side watcher add/remove (see §5: `KBEngine.addWatcher` /
  `delWatcher` are in-process script APIs with no console protocol
  messages).
- This forensics does not cover `guiconsole`'s (MFC desktop) implementation
  details; its `guiconsoleDlg.cpp:1206-1210` serves only as corroborating
  evidence that "the same message family can be reused by a C++ client".

## 8. V-08 boundary note: the real management protocol (external conditions)

C-2 / C-3's verifiable surface within the repo is **mock tests**; end-to-end
real runs are blocked by one external condition: the
`41001`–`41008` / `50001`–`50005` / `65502` / `65503` documented here all
belong to the engine's **runtime console observation protocol**, reachable
only against a running KBEngine server — without `loginserver` /
`cellappmgr` processes actually listening on `intaddr:intport`, not a single
frame can be sent. The repo and CI do not guarantee such an instance, so
end-to-end assertions cannot enter the gate. This is an external condition,
not an engineering gap; **no implementation is fabricated**.

**Reopen triggers** (all three must hold to advance C-2 / C-3 from the mock
surface to the real-protocol surface):

1. **A reachable instance**: a running engine (or containerized fixture) with
   a known `host:intport`, whose `Machines.ComponentInfo` yields a cellappmgr
   entry. Until then the panel side can only mock-test the connection layer.
2. **Message-number table reconciliation passes**: the target engine
   version's `Watcher.py` / `SpaceViews.py` / `console_helper.h` match this
   table item by item. These numbers are engine **internal constants, not a
   public ABI**; version drift breaks parsing directly, so changing engine
   versions requires re-running the forensics check rather than carrying it
   forward.
3. **Version determinable**: `src/engineApiMetadata.ts` can report a real
   version instead of `unknown`. On the local tree it reports `unknown`
   until C-14 lands, leaving the panel without the basis to "refuse
   connection on version mismatch"; blindly connecting to a wrong-version
   engine only yields garbled frames.

**Hooks already in place** (no external condition needed; usable now):

- Message numbers live in a constants table rather than hard-coded in the
  send/receive functions: `src/kbengineProtocol.ts:54-58`
  (`CONSOLE_WATCHER_CB_MSG_ID` / `CONSOLE_PROFILE_CB_MSG_ID` /
  `CELLAPPMGR_QUERY_SPACES_MSG_ID` / `MACHINE_BROADCAST_PORT`) and
  `src/kbengineProtocol.ts:80-89` `WATCHER_QUERY_MSG_IDS` (mapping 8 watcher
  request numbers per engine process type, item-by-item matching
  `Watcher.py:33-40`). If reconciliation fails (condition 2), the whole
  table can be disabled rather than patched site by site.
- Framing is centralized in `src/kbengineProtocol.ts:283` `buildFrame`,
  separating the connection layer from business decoding: the connection can
  be mocked while business decoding asserts field by field in §4's order.
- The panel switch defaulting off is C-3's task discipline; before
  conditions 1/2/3 all hold, the panel must not auto-connect at extension
  startup.

C-1 delivered **source forensics**, not **protocol usability**; this section
draws the boundary between the two. `src/kbengineProtocol.ts`'s transport
surface (framing / deframing / UDP discovery) is implemented per the
constants above; what's missing is the three external conditions, not code.
