# KBEngine guiconsole integration feasibility · deep source forensics

> Status: forensics complete (2026-11-07). This document records only what
> really exists in the kbengine engine source tree — the guiconsole
> communication chain, enablement conditions, and integration surfaces — and
> lands one integration recommendation; it does not mean the extension has
> implemented any new capability. Chinese primary:
> `docs/zh/design/kbengine-guiconsole-integration.md`.
>
> Forensics tree: `/home/cui/workspaces/kbengine` @ `3082ab5` (the kode
> repo's `../kbengine` sibling). All `file:line` below are measured line
> numbers in that tree. Sibling document:
> `docs/design/space-viewer-watcher.md` (Watcher/SpaceViewer protocol
> forensics; this document cites it instead of repeating it).

## 0. Verdict first

**Yes, it is integrable — kode already has four surfaces live on this
protocol line.** guiconsole is not a standalone service: it is the MFC C++
native client of the 「machined UDP discovery + direct TCP to each
component」protocol line. The kode extension's `src/kbengineProtocol.ts`
(965 lines) already runs on that same line — integrated surfaces: UDP
component discovery (`discoverLocalComponents`, `kbengineProtocol.ts:702-772`,
polled periodically via `monitoringCollector.ts:177-191`), watcher query
(41001-41008 → 65502, `:775`), SpaceViewer (50003 → 65503, `:949`), and
profiles (`:932`). The right move is to **extend the existing TS protocol
module** — not to adopt webconsole, and not to port the MFC app (guiconsole
is a Windows-only MFC binary and cannot run inside a Linux extension host).

**Do first**: live log tail (`Logger::registerLogWatcher` `702` → receipt
`65501`) into an IDE Output channel, wired into the already-shipped
IDE-LIV-007 exception→source jump (`src/exceptionSourceLocator.ts`) to close
the loop 「live log → exception line → click to jump to source」.

## 1. The complete communication chain (①)

Everything goes through machined discovery first, then direct connection.

### 1.1 Discovery: UDP broadcast, fixed port 20086

- guiconsole drives itself with three timers (`guiconsoleDlg.cpp:422-424`):
  timer1 (10ms) main loop, timer2 (100ms) one-shot discovery per component
  type (`guiconsoleDlg.cpp:863-872`, eight types LOGGER/BASEAPP/CELLAPP/
  BASEAPPMGR/CELLAPPMGR/LOGINAPP/DBMGR/BOTS), timer3 (20s) sends
  `onAppActiveTick` on every connected channel
  (`guiconsoleDlg.cpp:878-898`).
- Discovery request = UDP broadcast `MachineInterface::onFindInterfaceAddr`
  (id=1, `messages_fixed_defaults.xml:10-13`), listen port
  `KBE_PORT_START + rand()%1000` (`guiconsoleDlg.cpp:177`); field order:
  uid/username/componentType(CONSOLE_TYPE)/componentID/findComponentType/
  finderAddr/finderRecvPort (`guiconsoleDlg.cpp:192-195`).
- machined binds UDP **20086** to receive:
  `KBE_MACHINE_BROADCAST_SEND_PORT = KBE_PORT_START + 86` (`common.h:100`;
  three binds — broadcast address / local broadcast address / LOCALHOST,
  `machine.cpp:713/:743/:771`).
- Reply: one `onBroadcastInterface` Args25 per matching component, carrying
  uid/username/componentType/componentID/globalOrder/groupOrder/gus/intaddr/
  intport/extaddr/extport/externalAddressEx/pid/cpu/mem/usedmem/state/
  extradata×4 (`machine.cpp:219-228`) — **the component list and the
  cpu/mem/usedmem/state load snapshot ride in the discovery reply**;
  guiconsole's StatusWindow columns (uid/type/id/cpu/memory/entities/
  proxies/clients/cells/address, `StatusWindow.cpp:258-268`) consume this
  broadcast directly.
- kode already speaks this surface: `kbengineProtocol.ts:51`
  `MACHINE_MSG_QUERY_ALL_INTERFACES = 4` (`onQueryAllInterfaceInfos`,
  `messages_fixed_defaults.xml:25-28`), port `MACHINE_BROADCAST_PORT =
  20086` (`kbengineProtocol.ts:58`), polled periodically by
  `monitoringCollector.ts:177-191`.

### 1.2 Connection: TCP direct to each component, no handshake, no auth

- `connectTo()` connects straight to the selected tree node (the discovered
  component's intaddr:intport) via `EndPoint::connect`
  (`guiconsoleDlg.cpp:1405`), then initializes the channel as
  `Channel::INTERNAL` and registers it (`guiconsoleDlg.cpp:1418-1442`).
  **There is no hello/auth message**; keepalive is timer3's
  `onAppActiveTick` (ids 55100-55107, `messages_fixed_defaults.xml:487-541`)
  carrying CONSOLE_TYPE; the server exempts CONSOLE/CLIENT from the
  component-table lookup (`serverapp.cpp:428`).
- Every component process **by default** listens on an internal TCP port:
  `kbeMainT` constructs the NetworkInterface with intlisteningPort_min/max
  (`kbemain.h:182-185`; the 0 default is declared at `kbemain.h:145`), and
  the actual server process mains all
  pass ≥0 (cellapp `main.cpp:61` passes 0; machined passes its own port
  range), so the listener is always created; a `-1` skip branch exists
  (`network_interface.cpp:73-79`) but no process uses it. Failing to bind
  asserts the process down (`network_interface.cpp:81`).

### 1.3 Message set: XML static table + code-forced IDs, merged

- Fixed message table: `kbe/res/server/messages_fixed_defaults.xml`
  (542 lines). Console-relevant families:
  - watcher queries `41001`-`41008` per process type (`:407-445`) →
    receipt **65502**;
  - loads/SpaceViewer `50001`-`50005` (`:447-470`) → receipt **65503**;
  - logs `702` registerLogWatcher / `703` deregisterLogWatcher /
    `704` writeLog (`:354-385`) → receipt **65501**;
  - remote python execution `55001` (Baseapp) / `55002` (Cellapp) /
    `55003` (Bots) onExecScriptCommand (`:472-485`) → receipt **65500**;
  - heartbeats `55100`-`55107` (`:487-541`); process management `2`/`3`/`6`
    (`:15-38`).
- **The four console receipt IDs are code-forced and absent from the XML**:
  `CONSOLE_COMMANDCB_MSGID 65500` / `CONSOLE_LOG_MSGID 65501` /
  `CONSOLE_WATCHERCB_MSGID 65502` / `CONSOLE_PROFILECB_MSGID 65503`
  (`console_helper.h:9-12`); each handler overrides msgID in `onInstall()`
  (`:65/:123/:175/:227`). A decoder's message table must merge both
  sources — reading the XML alone silently drops 65500-65503. (The
  65502/65503 two-line split and receipt registration are already
  forensicked in `docs/design/space-viewer-watcher.md` §1; this document
  follows it.)

### 1.4 Log stream: register on logger, logger pushes back

- guiconsole sends `Logger::registerLogWatcher` (702) over TCP to the
  **logger component** (address from discovery); field order follows the
  **actual writer** `LogWindow.cpp:381-433`: uid(i32)/logtypes(u32)/
  globalOrder(i32)/groupOrder(i32)/date(str)/keyStr(str)/count(i8)+
  n×componentType (**int32 each** — `Bundle::operator<<(COMPONENT_TYPE)`
  serializes as int32, `bundle.h:227-231`, written at `LogWindow.cpp:421-423`)
  + isfind/first (bool, `bundle.h:241`). Note: the XML declares the
  component filter as `UINT8_ARRAY` (`messages_fixed_defaults.xml:354-366`),
  which does NOT match what guiconsole actually writes — decoders must
  follow the writer, a textbook 「check declarations against implementation」
  case. Deregistration 703: `LogWindow.cpp:439`.
- logger's `LogWatcher` filters by uid/logtype/globalOrder/groupOrder/
  component bitmap/date/keyword and pushes each hit logstream as a BLOB in
  `CONSOLE_LOG_MSGID 65501` **back over the same TCP channel**
  (`logwatcher.cpp:85-113`, push point `:104-112`). The log source is each
  component's `Logger::writeLog` (704, `messages_fixed_defaults.xml:373-385`).
- I.e. **tail is a long-lived push stream** — after registration logger
  pushes continuously; closing the connection kills the stream. kode's
  existing `queryWatcherPath` is a one-shot short-connection pattern
  (`kbengineProtocol.ts:775`); tail needs a new long-lived client with
  dispatch by message ID.

### 1.5 Component management and other surfaces

- Process start/stop: `Machine::startserver` (id=2) / `stopserver` (3) /
  `killserver` (6) (`messages_fixed_defaults.xml:15-38`); guiconsole sends
  these via UDP broadcast (`guiconsoleDlg.cpp:1678/:1744`,
  `StartServerWindow.cpp:156/:288`); machined implements them at
  `machine.cpp:846/:917/:1107`, with per-componentID stop
  (`machine.cpp:928-930`).
- Remote python execution: guiconsole sends 55001/55002/55003 by component
  type (`guiconsoleDlg.cpp:597-601`); the server-side
  `EntityApp::onExecScriptCommand` only checks "internal channel"
  (`entity_app.h:1321`), runs `run_simpleString`, and replies via 65500
  (`entity_app.h:1345-1350`).
- Profiles: per-process `X::startProfile` (pyprofile/cprofile/eventprofile/
  networkprofile, `guiconsoleDlg.cpp:1786-1811`), receipt 65503; kode
  already implements `startProfileQuery` (`kbengineProtocol.ts:932`).

## 2. Enablement conditions (②)

**There is no switch — the line is on by default.** Checked item by item:

- `kbengine_defaults.xml` (`kbe/res/server/kbengine_defaults.xml`, 942
  lines) contains **no** console-specific key; the internal TCP listener is
  a default step of process startup for every server component (see 1.2,
  `kbemain.h:182-185`).
- Only two prerequisites: ① machined (the machine process) is running — it
  is the sole responder to discovery broadcasts; the webconsole guide states
  the same ("all operations originate from Machine… ensure the machine
  process is running correctly", `docs/zh/guide/webconsole.md:51`);
  ② the target component's internal TCP port is network-reachable (listener
  existence per 1.2: created by default for server process mains,
  `kbemain.h:182-185`).
- The nearest comparable config surface is the per-app `telnet_service`
  (password-protected, default `pwd123456`: interfaces `:261-267`, dbmgr
  `:423-430`, cellapp near `:545`) — **the console line has no
  corresponding key and no authentication** (see §5).
- Port facts: broadcast fixed at 20086 (`common.h:100`);
  `KBE_MACHINE_TCP_PORT = 20088` (`common.h:102`) is machined's own TCP
  face; component internal ports are auto-assigned (port scan,
  `network_interface.cpp:168-196`) and carried back in the discovery reply.

## 3. webconsole comparison (③)

| Surface | webconsole | guiconsole | kode today |
|---|---|---|---|
| Host | Django 1.8.9 web app (`docs/zh/guide/webconsole.md:9-11`) | Windows MFC C++ binary | VS Code extension (TS) |
| Protocol | same Machine face (HTTP polling, no WebSocket push) | same Machine face + direct component TCP | **already on the same line** (`kbengineProtocol.ts`) |
| Features | user mgmt / cluster mgmt / profiling / live logs / status graphs / python console / watcher / SpaceViewer (`:113-185`) | same domain + graphs/layouts | discovery/watcher/spaces/profile integrated; tail/start-stop/exec missing |
| Maintenance | legacy (Django 1.8.9 EOL) | Windows-only | active |

**Verdict: neither comparison target is the integration target.**
webconsole has no real-time push surface an extension host needs (HTTP
polling), and adopting it means carrying a legacy Django stack; the
guiconsole binary cannot cross platforms. The only sensible path for the
VS Code extension is to **speak guiconsole's protocol directly**: kode's
existing TS implementation already covers discovery/watcher/spaces/profile
(`kbengineProtocol.ts:702/:775/:932/:949`, `monitoringCollector.ts:177-191`);
tail / start-stop / remote execution are the missing three.

## 4. Integration opportunity list (④, by value)

| # | Feature | Messages | Dependencies | Effort | Notes |
|---|---|---|---|---|---|
| 1 | **Live log tail into IDE Output** | 702/703 → 65501 | logger address (discovery already gives it); new long-lived client + ID dispatch | **M** (~100-150 lines TS) | highest value; the byte format of 65501's BLOB logstream is unverified — needs live-machine capture |
| 2 | **Exception→source jump** (wiring IDE-LIV-007) | reuses #1's stream | `exceptionSourceLocator.ts:27/:52/:79` already shipped | **S** (pure wiring) | bundle with #1: every tail line goes parse→resolve→clickable jump |
| 3 | **Component status panel enhancement** | discovery Args25 | prototype exists (`monitoringCollector.ts`) | S | state/extradata (entities/proxies/cells) already ride the reply; presentation only |
| 4 | **Process start/stop/restart buttons** | 2/3/6 (UDP broadcast) | machined; frame field order (`machine.cpp:846-916`) | M | destructive ops: require confirmation + audit; schedule later |
| 5 | **Load curves** | 50001/50002 → 65503 | **queryAppsLoads reply fields unverified** (already flagged in space-viewer-watcher forensics) | M-L | needs live-machine capture; presentation can start from cpu/mem in the discovery broadcast |
| 6 | **Remote python execution** | 55001-3 → 65500 | no new deps | S-M | high debug value but = arbitrary code injection surface; overlaps existing telnet_service; defer |

Codec reuse: everything goes through the existing TS module
`src/kbengineProtocol.ts` (`buildFrame`/`BufferCursor`/constants ready;
65502/65503 constants already carry engine-line citations,
`kbengineProtocol.ts:54-55`). **The kode-kbengine-protocol crate is not a
dependency of this path** — it is the offline forensics/capture-analysis
surface (schema/decode/capture, `crates/kode-kbengine/src/cli.rs:40-93`, no
online-client subcommand); the live surface lives in the TS module. New
constants (702/703/65501/55001-3/65500) must enter the
`watcherProtocolAudit.ts` audit-lock surface, following the IDE-LIV-002
precedent.

## 5. Risks and boundaries (⑤)

- **Protocol version coupling**: the four receipt IDs are hardcoded
  (`console_helper.h:9-12`) — being outside the XML actually makes them
  stable; the real drift surface is the XML static table across engine
  versions. The engine tree is pinned @3082ab5; kode already locks protocol
  numbers with the "audit table + per-entry cross-check" mechanism
  (IDE-LIV-002 precedent) — every new message number must enter that
  surface, never trusting unverified constants.
- **Fork-only changes**: this tree's delta vs upstream kbengine was not
  compared file-by-file; the integration surface depends only on the message
  numbers above, all of which are old upstream protocols — low drift risk,
  but before shipping, line numbers must be re-verified against the target
  engine tree (the audit table carries repoUrl+commit).
- **Security (no authentication anywhere on the line)**: ① discovery
  answers **bypass the uid filter** for requests claiming CONSOLE_TYPE
  (`machine.cpp:168-175` exemption branch; same at `:200-204`) — any process
  that can broadcast gets the full component list and loads; ② python
  execution only checks "internal channel" (`entity_app.h:1321`); ③
  startserver/killserver carry no password (`machine.cpp:846` ff).
  **Conclusion: keep the line localhost-only** (kode's discovery target
  already defaults to `127.0.0.1`, `kbengineProtocol.ts:703`); cross-machine
  access must be explicit config with a documented warning that it equals
  handing over full cluster control. The start/stop buttons must add
  confirmation per the destructive-operation norm.
- **Channel shape**: 65501 tail is a long-lived push stream, unlike the
  existing short-lived query pattern; connection lifecycle
  (reconnect/backoff/stalled-stream notice) is the main engineering cost of
  tail — not the protocol decoding.
- **Known-unverified items** (stated as such): the byte format of 65501's
  BLOB logstream, and the queryAppsLoads (50001/50002) reply fields — both
  require live-machine capture before any decoder is written.

## 6. Minimal verification evidence

No engine runs on this machine, so the evidence is offline: using kode's
**already-compiled existing codec** (`out/kbengineProtocol.js`, zero new
protocol code), the script below builds a 702 request frame and decodes a
65501 receipt stream injected with TCP sticky-packet splits. Reproducible
(run from the kode repo root after `pnpm compile` generates
`out/kbengineProtocol.js`):

```js
const p = require('./out/kbengineProtocol.js');     // run from kode repo root
const cstr = s => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
// 702 request frame: field order per LogWindow.cpp:381-433 (components int32, bundle.h:227-231)
const frame702 = p.buildFrame(702, Buffer.concat([
  i32(1000), i32(0x1f), i32(0), i32(0),             // uid / logtypes / globalOrder / groupOrder
  cstr(''), cstr(''),                                // date / keyStr
  Buffer.from([2]), i32(3), i32(4),                  // count=2 + 2×COMPONENT_TYPE (int32)
  Buffer.from([0, 1]),                               // isfind / first (bool)
]));
// 65501 receipt stream (msgID u16LE + len u16LE + BLOB), decoded across sticky splits
const receipt = line => { const blob = cstr(line);
  const b = Buffer.alloc(4 + blob.length);
  b.writeUInt16LE(65501, 0); b.writeUInt16LE(blob.length, 2);
  blob.copy(b, 4); return b; };
const stream = Buffer.concat([receipt('ERROR cellapp Avatar.py:21 onTimer Traceback ...'),
                              receipt('WARNING baseapp loginapp sync ok')]);
let buf = Buffer.alloc(0); const out = [];
for (const chunk of [stream.subarray(0, 20), stream.subarray(20)]) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const id = buf.readUInt16LE(0), len = buf.readUInt16LE(2);
    if (buf.length < 4 + len) break;
    const payload = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
    if (id === 65501) out.push(payload.slice(0, -1).toString('utf8'));
  }
}
console.log('[702] len=%d [65501]', frame702.length, out);
```

Measured output (**illustrative evidence**: the frame-construction and
sticky-split decode paths work; the 65501 payload's logstream byte order
still follows §5's live-machine-capture caveat — the receipt bodies here
are synthetic):

```
[702] len=33 [65501] [
  'ERROR cellapp Avatar.py:21 onTimer Traceback ...',
  'WARNING baseapp loginapp sync ok' ]
```

## 7. Decision record and cross-references

- **Decided**: adopt the existing 「machined UDP discovery + direct TCP to
  components」line by extending `src/kbengineProtocol.ts`; ship #1+#2 (log
  tail + exception-jump wiring) first. Rejected alternatives: adopt
  webconsole (legacy stack, no real-time push), port guiconsole (MFC cannot
  cross platforms), start a Rust live client on kode-kbengine-protocol (that
  crate's role is offline forensics; the TS face already runs — a second
  implementation). Decided on behalf of the user, subject to after-the-fact
  review.
- Cross-references: `docs/design/space-viewer-watcher.md` (65502/65503
  two-line forensics and receipt registration), `src/exceptionSourceLocator.ts`
  (IDE-LIV-007), `src/watcherProtocolAudit.ts` (protocol-number audit lock),
  `src/monitoringCollector.ts` (current discovery polling),
  `docs/zh/guide/webconsole.md` (comparison target, in the engine tree).
