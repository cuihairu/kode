# Kode Redesign: A Test Bed That Does Not Depend on a Real KBEngine Environment


> Status: all phases complete (phases 1-4, batches 52-56, 2026-09-26). Baseline measurement time: 2026-09-25.
> The companion list of current-state problems is in section 1; the per-phase completion status is in the progress table in section 6.

## 0. Background and Motivation

Kode is the VSCode development extension for KBEngine. Feature verification has long faced one structural contradiction:

- The extension's **language layer** (.def parsing, completion, hover, diagnostics, go-to-definition) only needs files, so it can already be tested at the pure-logic level;
- but the extension's **runtime layer** (server start/stop, log collection, monitoring collection, debug attach) inherently targets a distributed KBEngine cluster: UDP broadcast discovery on the machine component (port 20086), a watcher TCP port per component (msgid 41001-41008), the logger TCP port (20022), real engine binaries (`kbe/bin/server`), real process PIDs and telnet debug ports (31000-51000).

Today, verifying the runtime layer end to end requires either a real KBEngine checkout and run environment, or hand-written loopback sockets / fake processes scattered across tests. The result: hard to test, slow to test, incomplete coverage, and unrunnable on CI.

The core proposition of this redesign: **turn "what the runtime happens to depend on in the environment" into "what the tests explicitly provide"**, so the whole chain can be verified without a real KBEngine environment while compatibility with the real environment stays unchanged.

## 1. Current-State Problem List (Survey Conclusions)

Every item below carries code evidence and is grouped by "what makes it hard".

### 1.1 Must Depend on a Real KBEngine Environment

| # | Problem | Evidence |
|---|---------|----------|
| P1 | Server management spawns the engine binary directly, and the probe paths are hard-coded to `../kbengine/kbe/bin/server` and `KBENGINE_HOME` | `src/serverManager.ts:192-195`, the `spawn` call at `src/serverManager.ts:329` |
| P2 | machine discovery's UDP broadcast port 20086 is hard-coded and not injectable | `src/kbengineProtocol.ts:45`, `socket.send(frame, MACHINE_BROADCAST_PORT, '127.0.0.1')` at `src/kbengineProtocol.ts:430` |
| P3 | Monitoring collection depends on real machine replies plus a real watcher TCP service per component | `src/monitoringCollector.ts:187,338` (`discoverLocalComponents`/`queryWatcherPath`) |
| P4 | Log collection connects straight to logger TCP 20022, and the protocol adaptation is unfinished, so `connect()` rejects as things stand | `src/extension.ts:343`, `src/logCollector.ts` (the connect rejection path is already locked by tests) |
| P5 | Debug attach needs real component process PIDs, telnet ports 31000-51000 and debugpy | `src/debugConfig.ts:30,271` |
| P6 | The line-by-line engine source verification tests depend on a sibling `../kbengine` checkout or `KBENGINE_ROOT`, skip when missing, and do not run on CI without the engine | `tests/helpers/engineRoot.ts` |

### 1.2 Slow to Start and to Exercise Jointly, Long Debug Chains

| # | Problem | Evidence |
|---|---------|----------|
| P7 | **There has never been a real VSCode verification**: `@vscode/test-electron` is declared as a devDependency but `runTest.ts` never calls it; the mocha layer actually runs in plain Node with a fake vscode injected through a `module._load` patch. The supposed "integration layer" is isomorphic to the vitest layer, it just builds another set of fakes | `src/test/runTest.ts` (no runTests call), `src/test/suite/testUtils.ts` `loadModuleWithMocks` |
| P8 | The full gate measures 47s (lint + vitest 701 cases 36s + clean/tsc full recompile + mocha 110 cases); the duration is acceptable, but the real cost is **maintaining two runners and two sets of fakes in parallel** plus re-running the whole round after a failure (no demand-driven layered entry points) | the `test` script in `package.json`; measured 2026-09-25 |
| P9 | Loopback socket tests bind the fixed port 20086, forcing global `fileParallelism: false` in vitest, serializing 56 files and slowing the whole layer | comments and config in `vitest.config.ts`, `tests/kbengineProtocolSocket.test.ts` |
| P10 | Real process orchestration tests are sensitive to signal timing: the SIGKILL escalation case has to wait for a bash trap marker and occasionally fails under load (self-reported in TESTING.md) | `tests/serverManagerProcesses.test.ts`, TESTING.md batch 24 record |

### 1.3 No Unified Mock / Local Simulation

| # | Problem | Evidence |
|---|---------|----------|
| P11 | There is no infrastructure for a "fake KBEngine cluster": the machine responder, watcher TCP service, logger service and fake component binaries are all hand-written separately inside individual test files | inlined separately in `tests/kbengineProtocolSocket.test.ts`, `tests/monitoringCollectorSocket.test.ts`, `tests/serverManagerProcesses.test.ts` |
| P12 | There are two vscode doubles and they have diverged: the vitest layer's `tests/helpers/vscodeStub.ts` (416 lines) and the mocha layer's Fake* classes in `src/test/suite/testUtils.ts`; semantics differ (e.g. `FakeLocation` holds `position`, while both the real and stub `Location` hold `range`). And P7 shows the mocha layer is not any more "real", so the divergence is pure duplicate effort | comparing the two files |
| P13 | The stub is "minimum sufficient for evaluation" and therefore not programmable: workspace state, document collections, configuration changes, window messages and panel messages all have to be monkey-patched by each test, repeatedly and fragilely | the header comment in `tests/helpers/vscodeStub.ts` and the patch blocks in each test file |
| P14 | `extension.ts` (532 lines wiring all features) is explicitly excluded from vitest coverage, so the wiring logic (command registration, status bar coupling, the dispose chain) is only indirectly covered by the mocha layer | `vitest.config.ts` `exclude: ['src/test/**','src/extension.ts']` |

### 1.4 Cases Are Hard to Reproduce and Results Hard to Interpret

| # | Problem | Evidence |
|---|---------|----------|
| P15 | Runtime chain failures can only be reproduced by "whoever has a real environment": branches like some monitoring data, watcher connection refusal, and malformed broadcast packets cost a great deal to stage in a real environment | the many records in TESTING.md about the cost of staging scenarios for "real loopback, zero mock" tests |
| P16 | The coverage baseline is split: vitest coverage only counts the 23 files vitest loads, the mocha layer's coverage is not merged, extension.ts is not in the denominator, and the real meaning of "98.99% lines" depends on the baseline note | the notes section in TESTING.md, `vitest.config.ts` |

## 2. Goals and Non-Goals

### Goals

1. **G1 zero-environment testing**: on a machine that only has Node.js (no KBEngine checkout, no VSCode download, not even a display environment), `pnpm test:unit` can verify all core functionality, including the runtime chains (discovery, monitoring, logs, process orchestration, wiring).
2. **G2 fast feedback**: the core layers (including simulator integration) run in under 90s per round; no real VSCode startup needed.
3. **G3 a single double**: there is only one implementation of the vscode test double, it is programmable and stateful, and vitest and mocha share it; the Fake* divergence is removed.
4. **G4 simulation is product knowledge**: the KBEngine simulator freezes the online protocol behavior of machine/watcher/logger/component processes into an executable specification (reusing the codec in `kbengineProtocol`), so a protocol regression is caught in one place.
5. **G5 real verification made explicit**: today "test-electron is declared but never run" (P7), and real VSCode behavior has zero verification. After the redesign: the commit gate (`pnpm test`) does not depend on any real VSCode/engine; a separate optional smoke script (real VSCode + optional real engine) is for manual triggering before a release and stays out of the gate. Engine source conditional verification is retained.
6. **G6 unchanged behavior**: user-visible features, public APIs and `package.json` contribution points are unchanged; the refactor only touches internal structure and tests.

### Non-Goals

1. Do not reimplement the KBEngine server itself; the simulator only covers the protocol surface the extension actually consumes.
2. Do not introduce Docker / containerized real clusters as a test dependency (unreachable and slow on CI, see alternative A).
3. Do not bring a real VSCode smoke test into the commit gate (the gate must be reachable on a machine with only Node); the currently unused `@vscode/test-electron` dependency becomes an explicit optional `test:smoke` script or is removed, decided in phase 4. The two runners' coverage numbers are not merged (the baseline is labeled honestly).
   (Phase 4 decision: the dependency has been removed — runTest.ts never called it; if a future L4a on-machine smoke test needs it, it is re-introduced explicitly and kept out of the commit gate.)
4. Do not change the assertion semantics of the 701 existing vitest cases in the language layer (they remain valid).

## 3. New Architecture

### 3.1 Layering and Module Division

The status quo is "every manager class = business logic + vscode API + Node IO" all in one. The redesign splits it into four layers along the dependency direction, and dependencies may only point downward:

```
┌─────────────────────────────────────────────────────────┐
│ L4 wiring layer  src/extension.ts                       │
│    wiring only: construct managers, register commands / │
│    providers / panels                                   │
├─────────────────────────────────────────────────────────┤
│ L3 manager layer (existing classes keep their names and │
│    public API)                                          │
│    serverManager / logCollector / monitoringCollector / │
│    debugConfig / the WebViews / explorer / mapping ...  │
│    change: vscode touchpoints converge on an injected   │
│            UiBridge;                                    │
│            process/socket/timer touchpoints funnel to   │
│            an injected port adapter                     │
├─────────────────────────────────────────────────────────┤
│ L2 port layer (new, src/ports/) inverted-dependency     │
│    interfaces                                           │
│    ProcessRunner    — injectable abstraction of spawn   │
│                      (landed, batch 53)                 │
│    MachineDiscoveryOptions — injected discovery         │
│                      address/port/timeout               │
│                      (landed, batch 52; via parameters  │
│                       rather than src/ports/)           │
│    (default implementation = real child_process / net / │
│     dgram, production behavior unchanged)               │
│    (SocketFactory not started, see the 3.4 conclusion)  │
├─────────────────────────────────────────────────────────┤
│ L1 pure domain layer (largely reached already)          │
│    defParser / definitionSemantics / definitionWorkspace│
│    / kbengineMetadata / hooks / logParser / protocol    │
│    codec                                                │
└─────────────────────────────────────────────────────────┘
```

Two pieces of supporting infrastructure (not production code):

```
tests/sim/            KBEngine local simulator (see 3.2)
tests/fake-vscode/    programmable vscode double (see 3.3)
```

### 3.2 KBEngine Local Simulator (`tests/sim/`)

An in-process, programmable, zero-external-dependency "fake KBEngine cluster" that converges the hand-written responders scattered around in P11 into a formal module:

- **MachineSimulator**: a UDP responder. After receiving a msgid=4 (`MACHINE_MSG_QUERY_ALL_INTERFACES`) request frame, it replays a configured component broadcast frame following `kbengineProtocol`'s 29-field wire order (component type, PID, address, intaddr/intport swap, cpu, componentID bigint). **All ports are dynamically allocated** (bind port 0 so the OS assigns one), and the actual port is reported back to the test.
- **WatcherSimulator**: one TCP service per component. Implements the path query for msgid 41001-41008, with programmable return frames (including fragmented sends, type 0 value frames / type 1 directory frames), connection refusal, timeouts and malformed packets.
- **LoggerSimulator**: a TCP service carrying logger port behavior (the extension-side protocol is unfinished, so the simulator provides the peer in advance for later protocol adaptation; for now it is a programmable "accept then close / fixed response"). **Final verification decision: not started** — `logCollector.connect` rejects the logger watcher protocol as implemented (P4), so a real TCP peer has no verifiable behavioral semantics; the protocol state machine conclusions are already covered by fake-socket cases (tests/logCollector.test.ts, including the connect rejection path), and adding a real connection layer would gain the state machine nothing and be dead code. It lands together with the consuming side when the protocol adaptation batch starts.
- **FakeComponentBin**: generates fake component executables (cross-platform node/shell scripts) with programmable behavior: run normally and periodically emit stdout/stderr, exit immediately with a given exit code, ignore SIGTERM so the SIGKILL escalation is forced, emit a startup marker. Consumed by serverManager's process orchestration tests, replacing the bash script assembly inlined in tests today.
- **SimCluster**: a facade. Brings up an N-component simulated topology (machine + watcher + optional logger) in one call, destroys everything at the end of the test; all resources (ports, temp dirs, child processes) are registered for leak checks.

Construction and parsing of protocol frames **reuse the exported functions in `src/kbengineProtocol.ts`** — the simulator and the extension share one protocol specification, which is where G4 lands.

### 3.3 Programmable vscode Double (`tests/fake-vscode/`)

Upgraded from the existing `vscodeStub` skeleton into a stateful, scriptable singleton environment (not reinvented per test):

- **WorkspaceState**: workspaceFolders, in-memory file tree (upgrading the existing memoryFileSystem), document collections (open/close/change events), the configuration table (with `onDidChangeConfiguration` triggerable), injectable `createFileSystemWatcher` events.
- **WindowState**: message queues (`show*Message` can be asserted and given scripted answers), scripted QuickPick/InputBox answers (existing codeGenerator tests already do this locally, converged into a shared piece), TextDocument open records and a programmable `showTextDocument` (including refusal to open).
- **PanelRegistry**: a programmable WebviewPanel factory (records creation arguments, captures `onDidReceiveMessage`, can fire `onDidDispose`); the message-domain tests of all three WebViews (logViewer/monitoring/entityDependency — every `createWebviewPanel` consumer in `src`) consume it, replacing the current monkey-patched panel factory.
- **CommandRegistry**: `registerCommand`/`executeCommand` really record, so `extension.ts`'s `activate()` can be assembled as a whole inside vitest and its registrations, status bar and dispose chain asserted — closing P14.
- **Compatibility strategy**: `tests/helpers/vscodeStub.ts` is kept as a thin re-export shell (so the import paths of the existing 701 cases are not broken) and the behavior moves to fake-vscode. The mocha layer's `testUtils.ts` Fake* classes retire step by step and unify on importing fake-vscode (removing P12).

### 3.4 Injection Point Changes (Production Code, Minimal Intrusion)

| Module | Current touchpoint | Change |
|------|----------|------|
| `kbengineProtocol.discoverLocalComponents` | Hard-coded 127.0.0.1:20086 | Add an optional `{host, port, timeoutMs}` parameter, defaults unchanged (P2) |
| `monitoringCollector` | Calls `discoverLocalComponents()` directly | The constructor accepts `discoveryOptions` (including the machine port) and passes it through |
| `logCollector` | Connects to `net` directly | Keep (host/port were already configurable); the simulator only provides the peer |
| `serverManager` | `import { spawn }` directly | Extract a `ProcessRunner` port whose default implementation passes spawn through; tests can inject (recording, fault injection), while real process integration tests keep using real spawn + FakeComponentBin |
| `extension.ts` | 532 lines of direct wiring | Keep the structure, only make the injectable points (each manager's constructor arguments) explicit; `activate` itself keeps its signature |

Principle: **the default implementation is the production behavior**, every new parameter is optional and its absence is exactly today's behavior — the change is invisible to users (G6).

Final verification decision (batch 57): the L2 architecture sketch listed `SocketFactory` (an injectable abstraction for TCP/UDP clients), and it was ultimately **not started** — testability of the protocol clients was already solved by two smaller paths: the discovery address/port/timeout is injected through `discoverLocalComponents`'s optional parameters (batch 52), and socket failure paths are covered by vitest `vi.mock('dgram'/'net')` (tests/kbengineProtocolGaps.test.ts). logCollector's host/port were already configurable (the "keep" row in the change table). Building an interface with no consumer violates minimal intrusion, so it waits until a real fault-injection need appears. Likewise the `src/ports/` directory does not land — ProcessRunner lives inside `src/serverManager.ts`, which is enough and visible.

## 4. Verification Strategy: Test Layering Without a Real KBEngine Environment

```
L1 pure logic unit tests (vitest, the existing 701 cases keep growing)
   depends on: nothing. Covers def / metadata / hooks / log parsing / protocol
   codec / generator pure functions.
L2 simulator integration (vitest, new tests/sim/*.test.ts + migrating the
   existing socket tests)
   depends on: Node (loopback sockets / real child processes), no vscode, no
   engine, no fixed ports.
   covers: the full machine discovery chain, watcher collection, monitoring
   aggregation, server process orchestration
   (normal / instant exit / EACCES / SIGTERM / SIGKILL escalation / startAuto /
   stopAll / restart), log collection state machine and reconnect.
L3 FakeVscode full chain (vitest, extending the existing *Panel/*Gaps series)
   depends on: fake-vscode + the L2 simulator. Covers: panel lifecycle and
   message domains of the four WebViews, diagnostic coupling, entityMapping
   watcher coupling, extension.ts activate wiring and the dispose chain,
   server status → status bar / tree view refresh.
L4 real layer (explicit, independent of the commit gate)
   L4a real VSCode smoke test (optional script test:smoke; phase 4 decision:
       remove the unused @vscode/test-electron dependency, this layer does
       not land for now, re-introduce it explicitly if needed): extension
       activation, command registration exists, one completion/hover/diagnostic
       works in real VSCode. Not part of pnpm test.
   L4b engine source conditional verification (keep the existing skipIf
       mechanism): on machines with an engine checkout, run the data vs source
       line-by-line verification; without the engine it skips automatically and
       does not block the gate.
Acceptance baseline (G1): on a "machine with only Node", run L1+L2+L3 (that is
   pnpm test:unit); all green means the core features are verified. L4 is
   additional assurance, not a gate.
```

The layering also settles the baseline problem (P16): L1-L3 coverage is computed under one vitest baseline, `extension.ts` is in the denominator (activate is reached by L3); L4 stays out of coverage and is labeled honestly.

## 5. Key Trade-offs and Alternatives

| Decision | Choice | Alternatives and why they were rejected |
|------|------|----------------|
| Fake cluster shape | In-process Node simulator (UDP/TCP/script binaries) | **A. Real engine via docker-compose**: no officially maintained image, long build chain, unusable on CI, minutes-long startup — violates G1/G2. |
| vscode double | Build our own stateful Fake (upgrading the existing stub) | **B. Bring in jest/vscode test frameworks or the whole sinon toolkit**: the existing stub has already taken shape and grew against the project's real cases; migrating frameworks is expensive for little gain. Keep native vitest `vi` plus our own programmable objects. |
| Port strategy | Dynamic ports (bind 0) + injection | **C. Keep the fixed 20086 + serial execution**: this is the root of P9; tests can never get fast and concurrency is never reproducible. |
| Process test shape | Keep real spawn + programmable fake binaries | **D. Fully mock child_process**: spawn's signal semantics, exit codes and stream behavior are expensive to mock and distorted; fake binaries are real processes with zero distortion, they only converge the assembly into FakeComponentBin. |
| Runner layout | vitest carries L1-L3; the mocha layer is isomorphic to vitest (P7) so it is gradually merged; real VSCode verification becomes an optional separate test:smoke | **E. Push everything into test-electron**: needs downloads and a display environment, so the gate is unreachable (G1/G2); **F. Keep today's two runners**: the mocha layer is not more real (P7), it is purely duplicated maintenance cost. |
| extension.ts coverage | Test activate directly under FakeVscode | **G. Keep excluding it from the denominator**: wiring logic is a regression hotspot (missing command registration / missing dispose), and P14 has already shown the current baseline is distorted. |

## 6. Phased Rollout Plan

Each phase is independently deliverable and independently committed, and the full test suite must be green afterwards (see the gate in section 8).

### Phase 1: Simulator Bed (`tests/sim/`) + Dynamic Ports [batch 52]

- Create `tests/sim/`: the `MachineSimulator`, `WatcherSimulator`, `SimCluster` skeleton.
- `discoverLocalComponents` gains optional `{host, port, timeoutMs}` parameters (defaults unchanged).
  Accompaniments: the `MonitoringCollector` constructor accepts `discoveryOptions` and passes them through; the protocol module gains the `buildComponentInfo`/`encodeWatcherValue`/`buildWatcherValueFrameBody`/`buildWatcherDirFrameBody` encoders (the duals of the parse family, reused by the simulator).
- Migrate the socket tests to the simulator + dynamic ports. (kbengineProtocolSocket/kbengineProtocolReaders/kbengineProtocolGaps/monitoringCollectorSocket/monitoringCollectorGaps, five files; plus new tests/sim.test.ts with 15 self-tests for the simulator)
- Lift `fileParallelism: false`.
- Acceptance result: vitest 57 files, 716 cases all green, file-level parallelism restored, full run 36s → about 13s; the fixed port 20086 binding is gone from test code (only the literal engine source assertion remains).

### Phase 2: Process Simulation (`FakeComponentBin`) + the ProcessRunner Port [batch 53]

- `tests/sim/fakeComponentBin.ts` generates programmable fake component binaries.
  Behaviors: run (marker/cwd/env echo/stderr), exit (given exit code),
  ignore-sigterm (install the SIGTERM handler before printing the marker —
  structurally eliminating the "signal arrives before the trap is installed"
  race, replacing the original bash trap approach), listen (open a TCP
  listener on 127.0.0.1 after an optional delay — the readiness-probe face
  for IDE-RUN-003), unexecutable (chmod 000
  → EACCES). The node shebang is cross-platform.
- `serverManager` extracts the `ProcessRunner` injection point (the default passes spawn through).
  Existing mocha-layer cases that mock `child_process` via `module._load` are unaffected.
- Migrate `tests/serverManagerProcesses.test.ts` to FakeComponentBin.
  18 cases behave equivalently (including SIGKILL escalation), inlined bash
  assembly drops to zero; add tests/serverManagerRunner.test.ts with 2 cases
  specific to the injection point (parameter pass-through recording + a
  synchronous throw going through catch).
- Acceptance: all pass (see the batch 53 commit).

### Phase 3: FakeVscode Infrastructure + extension.ts Under Test [batch 54]

- The five `tests/fake-vscode/` modules land.
  - `core.ts`: value types (Position/Range/Uri/EventEmitter/TreeItem/Diagnostic
    family/makeTextDocument etc., migrated as-is from the old stub) + a new StatusBarAlignment.
  - `workspaceState.ts`: a stateful workspace — in-memory fs, configuration
    overrides, document collections (textDocuments), three fireable workspace
    events (documentChanged/documentOpened/configurationChanged), TextDocumentContentProvider bookkeeping.
  - `windowState.ts`: three-channel message bookkeeping, output channel/status
    bar/tree view registration, showInputBox/showQuickPick/showSaveDialog
    defaulting to cancel, createWebviewPanel defaulting to panelRegistry.
  - `commandRegistry.ts`: registerCommand really records, executeCommand really dispatches.
  - `languages.ts`: bookkeeping for four kinds of provider registration + a DiagnosticCollection registry.
  - `panelRegistry.ts`: a recording fake WebviewPanel (captures
    onDidReceiveMessage/onDidDispose, records postMessage, can fire) — the
    consuming side for the phase 4 WebView migration.
- `vscodeStub.ts` becomes a pure re-export shell. The import paths and
  monkey-patch semantics (sharing the same mutable object) of 33 existing test
  files are all unchanged, and 718 cases pass with zero edits.
- extension.ts wiring tests land under test (tests/extension.test.ts, 6 cases).
  The registration surface and package.json contribution points agree strictly
  in both directions (21 commands / 2 views / 6 language service registrations /
  virtual document provider / status bar arguments and hidden state), 21
  commands really dispatch through executeCommand (including FakeComponentBin
  real processes' full start/stop/restart/showLogs chain and the status bar
  running-count coupling), the dispose chain tears down the registration surface
  item by item, the workspace branch's initial scan and three event couplings,
  and the no-workspace branch (workspaceFolders === undefined; an empty array
  is truthy).
- Acceptance reached: extension.ts enters the coverage denominator, 99.5% lines /
  100% functions (the only uncovered L234 is the defensive catch in
  openMethodTarget that never throws); overall coverage 98.99% → 99.01% lines
  (it rises after extension.ts is counted in).
- A real defect is fixed along the way: the empty-target guard of
  `kbengine.entity.method.open` sat after the label concatenation — invoking it
  from the command palette without arguments would throw a TypeError before
  reaching the guard; the guard is moved up (behavior only changes from "throws"
  to a silent no-op in the original throwing scenario).

### Phase 4: WebView/Manager Migration + mocha Slimming + Docs [batch 55/56]

- WebView panel tests migrate to PanelRegistry. (batch 55; the actual consuming
  surface is three WebViews, the original "four" count was wrong:
  logWebViewPanel/monitoringPanel/entityDependencyPanel — 51 cases migrated to
  panelRegistry's default fake panel, assertion semantics unchanged, each file
  keeps only the showSaveDialog queue and fs.writeFile fault injection patches)
- The mocha layer is cut down to a smoke set; `testUtils.ts` Fake* retires, and
  mocha reuses fake-vscode. (batch 56) 19 files 4930 lines / 110 cases → 3
  files 10 cases: manifest contribution points, out/extension.js activated and
  disposed end to end through fake-vscode over a **compiled copy** (new
  `tsconfig.mocha.json` compiles tests/fake-vscode + vscodeStub into
  `out/tests/`, and the test chain inserts that compile step), and
  out/languageProviders.js minimal completion + hover responses. The 17 suites
  isomorphic to vitest retire (P7 decision: they are not more real, purely
  duplicated maintenance). The `@vscode/test-electron` dependency is removed —
  runTest.ts never called it; if a future L4a on-machine smoke test needs it, it
  is re-introduced explicitly and kept out of the commit gate.
- Update `TESTING.md` (new layering notes), `docs/guide/development.md`, `README.md`. (batch 56)
- Acceptance: `pnpm test:unit` (L1-L3) is all green with no engine and no
  VSCode download (KBENGINE_ROOT=off baseline 59 files 724 cases); `pnpm test`
  is fully green (full gate measured at 31.6s on 2026-09-26: vitest 12.7s + full
  compile + 10 mocha smoke cases, ample headroom against G2's 90s target); the
  docs match the new architecture.

### Progress

| Phase | Status | Milestone commit |
|------|------|---------------|
| 1 | Done (batch 52) | Simulator bed + dynamic ports + file parallelism restored |
| 2 | Done (batch 53) | FakeComponentBin + ProcessRunner injection + process orchestration tests migrated |
| 3 | Done (batch 54) | fake-vscode five modules + vscodeStub compatibility shell + extension.ts under test (99.5%) |
| 4 | Done (batch 55/56) | WebView panel tests migrated to panelRegistry; mocha cut to compiled-artifact smoke (10 cases); Fake* retired, @vscode/test-electron removed; docs aligned |

## 7. Risks and Countermeasures

- **Simulator drift** (simulated behavior ≠ real engine behavior): protocol frame construction reuses the same codec in `kbengineProtocol`; L4b engine source verification stays anchored to the real wire order; the simulator's "specification is documentation" comments annotate the engine source basis line by line (following the existing batch-note style).
- **Injection parameter sprawl**: every new parameter must be optional and default to current behavior; type tests lock the defaults (e.g. `MACHINE_BROADCAST_PORT === 20086`).
- **Dual-track cost during migration**: the old style is not deleted immediately in phases 1-3, the last phase cleans up uniformly; each phase's commit is independently revertible.

## 8. Commit and Verification Gate (Existing Hard Repo Constraints)

- The full test suite must pass before every commit / push (`pnpm lint` + `pnpm test`); fix failures first, committing red tests is forbidden.
- git tag is forbidden; any release/publish action is forbidden; push only to the current branch's remote, never force.