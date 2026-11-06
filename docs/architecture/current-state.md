# Kode Current Architecture State Audit (Phase 0 / PR-001 / AUDIT-001..016)

> **2026-11-05 state refresh (KODE-ARCH-004)**: the AUDIT-*/PERF-* sections
> below are the 2026-10-23 forensic snapshot (base 36052c4), preserved as-is
> under the "snapshots are not rewritten" principle; deltas against current
> code are recorded uniformly in the "state refresh" section at the top.
> On conflict, the refresh section + git win.

## State refresh (2026-11-05 · feat/kode-arch)

- **Scale** (static forensics, measured via `find`/`wc`/package.json): 245
  top-level .ts modules under src/ (271 including subdirectories), 92,581
  lines; tests: 506 `*.test.ts` + 11 benches; contributes: 104 commands,
  104 configuration items, 1 container (kbengine-explorer) with 9 views,
  107 activationEvents; the debuggers contribution remains empty (the debug
  surface uses launch/attach configurations + the vscode.debug API, not a
  debug provider).
- **Largest single pieces** (still growing since the 10-23 snapshot;
  migration-risk items): languageProviders.ts 7,180 lines (split entry
  KODE-ARCH-001 not implemented), extension.ts 6,112 lines (KODE-ARCH-002 not
  implemented), entityMapping.ts 3,282, globalDataIndex.ts 2,155.
- **Rust workspace landed** (did not exist at 10-23): crates/ with 10 crates
  (kode-protocol/server/vfs/parser/root/index/scheduler/types/corpus/python),
  MSRV 1.97 (rust-toolchain pin 1.99.0); kode-server already has RPC
  surfaces: process topology validation (process_topology.rs, C-17), official
  def MD5 (def_md5.rs, C-18), wire format (wire_codec.rs/message_table.rs,
  C-15), database schema (database_schema.rs), python call graph
  (python_callgraph.rs); direction = config-first architecture (the todo's
  "config-first architecture" section: config parsing converges on Rust as
  the single source of truth, rendering/l10n stay in TS, Q&A via MCP).
  Gate: `cargo clippy --workspace --all-targets -- -D warnings`
  (Cargo.toml header comment).
- **Debug surface built from zero since the snapshot** (the "deferred" items
  in AUDIT-008/011 are no longer empty): debugpy auto-injection/preflight/
  wait-at-startup (autoDebugpy/debugpyPreflight/debugpyWaitAtStartup), attach
  guard and session registry (debugAttachGuard/debugSessionRegistry/
  debugStatusBoard, Debug Targets view), port/process dual mode and port
  probing (debugConfig/debugpyPortProbe), remote server dispatch
  (sshConfig/remoteConnection/remoteServerTree/remoteProcessList), py-spy dump
  (pyspyDump). Capability boundary: docs/design/perf-analysis-boundary.md
  (KODE-FEAT-002).
- **Hot-reload surface built**: ReloadTransport (HTTP/Telnet) dual transport,
  the state machine (sent/accepted/applied/failed/DIRTY/RESTART_REQUIRED) and
  the audit ledger (docs/hotreload/); current details in
  docs/hotreload/current-implementation.md; integration gaps and state-machine
  transition acceptance still to close (KODE-HOT-001/002 not implemented).
- **Database surface built**: schema/drift check/simulator/query lifecycle
  (databaseSchema*/databaseDrift*/databaseSimulator/databaseQueryLifecycle*,
  Rust-ized schema via databaseSchemaRust).
- **Index contract documented**: the five-index ownership and invalidation
  contract (docs/architecture/index-ownership.md, KODE-ARCH-003, with 16
  assertions in tests/indexOwnershipContracts.test.ts); the unified semantic
  index architecture is separately documented in
  docs/architecture/semantic-index.md (still an active document).
- **Performance baseline updated**: v0.2 baseline
  docs/perf/2026-11-04-v02-baseline.md (30k files/multi-root/large-file
  scenarios), process-topology diagnostics cost
  docs/perf/2026-11-04-process-topology-diagnostics.md.
- 【Inference】The 10-23 snapshot's AUDIT-011 conclusion that "all runtime
  boundaries live inside the extension host" has partially loosened: the Rust
  side's kode-server hosts parsing/validation RPCs as a subprocess/LSP
  (processTopologyRust/databaseSchemaRust and other TS wrappers), but process
  management/telnet/log/webview remain in the host; the book's goal of
  "script execution in a separate service" is not yet achieved.

## State refresh (2026-11-06 · same-day batch merged to main)

- **Scale update** (measured from package.json): contributes grew to 121
  commands, 110 configuration items, 3 keybindings (telnet `ctrl+]`/`ctrl+d`,
  hot-reload channel `ctrl+alt+r`).
- **Background index warmup (BG-WARM, 59eaaf5)**【Tested】: a five-stage
  background pipeline starting at activation (discovery-chain initial-scan
  wait → shared events/methods full initial scan → dependency graph →
  definition layout warmup → per-entity flowcharts, yielding the main thread
  between stages, cancellable); panels consume the product cache read-only in
  three states — done renders the first frame instantly (zero findFiles, zero
  analyze), running shows a progress page then joins the same in-flight
  Promise, missing/failed/cancelled fall back to the existing on-the-fly
  computation; the completion marker
  `kbengine.backgroundWarmup.completed` carries a generation (extension
  version + ordered-root fingerprint).
  src/backgroundWarmup.ts, src/warmupStages.ts; ledger entry in
  docs/features.md (BG-WARM).
- **Hot reload on by default and one-click enablement (b17ca3d / 5347782 /
  6fc034b)**【Tested】: `kbengine.hotReload.enabled` defaults to `true`; with
  `actionName` empty, saving a .py sends the default hot-reload request
  `POST http://127.0.0.1:8090/hotfix?module_name=<module name>`, carrying
  `module_name` in both query and body (src/hotReloadDefaultHotfix.ts, module
  name via resolveModuleDualName dual-name preference);
  `kbengine.hotReload.configureChannel` configures deployment-level channels
  per profile (three presets one-click enable / advanced config / writes only
  after liveness passes), a status-bar channel light and
  `kbengine.hotReload.switchChannel`, `ctrl+alt+r` as the default keybinding.
  Current details: docs/hotreload/current-implementation.md.
- **Path template single source of truth (10ccf1f)**【Fact】:
  `renderPathTemplate` (src/workspacePath.ts:58) uniformly renders
  `${workspaceFolder}` and other placeholders; the manual-input chain
  (src/definitionWorkspace.ts:1284) and the discovery chain
  (src/workspaceDiscovery.ts:882) share this one source — this closes out the
  earlier bug where the manual chain skipped rendering and mislocated def
  roots.
- **File change meta (f08cfbd merging 410e262)**【Tested】: src/fileChangeMeta.ts
  lazily parses module/package/processKind by identity+version
  (module/package for .py only, case-insensitive; memoization key = identity
  + version + path shape); design doc docs/design/file-change-meta.md
  (en/zh) aligned with the implementation.

- Date: 2026-10-23 · Branch: v0.2 · Protocol: docs/kode2/KODE_2_COMPLETE_TODO.md chapter 16
- Nature: code forensics snapshot. Three-column discipline —【Fact】= source file:line / git-verifiable;【Tested】= has a commit + report/raw output;【Inference】= a judgment derived from facts, needs later verification;【Untested】= no data, no invented numbers.
- PR1-7 data cited always carries a commit; tests are the service-layer
  discipline of fake-vscode + real index implementations, excluding real
  VS Code UI end-to-end (that item untested).

## AUDIT-001 Pinned commit and the old TODO's real state

- 【Fact】Audit base commit: `36052c47cb26290b6829632c6c3ca31341161c96`
  (v0.2 HEAD, `git describe` = v0.1.2-29-g36052c4; latest tag v0.1.2, plus a
  nightly). The working tree was clean at audit time (0 uncommitted files).
- 【Fact】todo.md's header declares "unfinished tasks only", so unchecked
  boxes in blocks A1-A7 do not mean unfinished. The true completion state
  follows the tracking table in
  docs/review/2026-10-22-unified-semantic-index-refactor.md (lines 525-531):
  PR1=89e8783, PR2=7d8736b, PR3=2aca694, PR4=2aca694 family, PR5=d4fd634,
  PR6=ae4256d, PR7=e6e8bc7, consistent with actual git log commits (verified
  item by item in this audit).
- 【Fact】B stop-the-bleeding items B-1..B-5 done (9c8daf7/179a290/fa13ef9/
  d5cff3d, squash collapsed main to 5071dde), see todo.md block B's ledger.
- 【Inference】todo.md checkboxes drifting from the review ledger is a
  bookkeeping problem, not an engineering one; after PR-001, this file + the
  review ledger are the state truth.

## AUDIT-002 Module tree, activation entry, composition root

- 【Fact】src/ has 91 top-level .ts modules, 46,366 lines total (excluding
  tests/, 193 test files). Largest pieces: languageProviders.ts 4,681 lines
  (all language provider implementations), extension.ts 2,180 lines (the only
  entry `activate()`, extension.ts:172), entityMapping.ts 2,234,
  definitionWorkspace.ts 1,559, pythonClassIndex.ts 1,307.
- 【Fact】Composition root (singletons, all new'd inside extension.ts):
  `IndexScheduler` (:354) → `EntityMappingManager(context, indexScheduler)`
  (:356) → providers injected with the manager; `PythonClassIndex(indexScheduler)`
  (at the definition-provider registration site, ≈:459) schedules
  `scheduleBackgroundScan()` on activation. From PR3/PR5, EntityMappingManager's
  initial scan and PythonClassIndex file discovery are queued through
  IndexScheduler.
- 【Fact】Provider registration inventory (extension.ts): completion ×2 (:360
  def+python merged selection, :619 python), hover ×2 (:394 main hover, :424
  serverConfig hover), definition ×2 (:433 .def/xml navigation, :459 python),
  CodeLens ×7 (:513-:574, :1664), InlayHints ×2 (:584, :594). Diagnostics go
  through DiagnosticScheduler (PR6). No registerReferenceProvider — the
  references surface is the command kbengine.symbolReferences.show.
- 【Fact】PR2-PR6 data/scheduling surfaces: documentStore.ts (342 lines),
  indexScheduler.ts (422), semanticIndex.ts (329), dependencyGraph.ts (164),
  diagnosticScheduler.ts (322); architecture diagram in
  docs/architecture/semantic-index.md.
- 【Inference】The import graph layers cleanly: extension.ts (assembly) →
  languageProviders (implementations) → PR2-6 core data surfaces → IO
  surfaces (scanRoots/entityMapping); but languageProviders.ts at 4,681 lines
  is the largest single-piece migration risk — Rust-ification requires
  splitting it provider by provider.

## AUDIT-003 The initialization surface of onLanguage:python activation

- 【Fact】activationEvents (package.json): `onLanguage:kbengine-def`,
  `onLanguage:python`, `workspaceContains:**/*.def`, 54 onCommand entries.
- 【Fact】`activate()` has no "is this a KBEngine workspace" gate: once
  activated it immediately (a) async-builds buildEngineApiCatalog per
  `kbengine.python.apiMetadata` (default true); (b) instantiates IndexScheduler
  + EntityMappingManager; (c) registers all providers; (d)
  PythonClassIndex.scheduleBackgroundScan() (extension.ts:172-660).
- 【Fact】After PR5 the initial scan is backgrounded: the first Definition
  query does not wait for the repo-wide scan (U1 first query 475.34ms,
  d4fd634, docs/perf/2026-final-report.md §3). **2026-10-28 field recheck
  note (P0-4d)**: the service-layer claim holds (no waiting for full-scan
  completion); in the field, a cold first query at 1189ms still included
  ~1.05s of initial-scan wait with late-arriving results — "does not wait" is
  bounded to "does not block on completion", see
  docs/review/2026-10-28-p0-4d-report-audit.md §1.1.
- 【Conclusion (fact+inference)】onLanguage:python indeed spins up the full
  KBEngine machinery (index scheduling, background scans, EntityMappingManager)
  in any Python workspace; because the initial scan is backgrounded and
  interaction-throttled, it no longer blocks the first request, but the
  memory/event-loop occupancy in non-KBEngine workspaces is pure overhead.
  **Negative case of "no KBEngine workspace": not implemented, not tested —
  untested** (book chapter 3, PR-006 root-discovery scope).

## AUDIT-004 Parsers and callers for the four XML kinds

- 【Fact】The only runtime XML parser: vendored fast-xml-parser
  (`vendor/fast-xml-parser/fxp.cjs`), used only through src/defParser.ts
  (516 lines) in preserveOrder mode; DefDocument keeps tagStart/closeTag
  offsets + lineStarts, supporting file:line source location; a module-level
  8-entry LRU parse cache (defParser.ts:16-18).
- 【Fact】Callers: parseDefAst/parseDefDocument have 10 call sites in
  languageProviders.ts; entitiesXmlAnalysis.ts (entities.xml manifest
  duplicate-entity diagnostics) and definitionSemantics reuse the same parse
  surface.
- 【Fact】types.xml/alias.xml: entityMapping.ts parses them via direct
  readFileSync (:752, :1309, :1810), with the type registry on SemanticIndex
  snapshots (since PR4); kbengine.xml + kbengine_defaults.xml synthesis:
  serverConfigMerge.ts (:153, :202, :216).
- 【Tested】Stop-the-bleeding evidence for duplicate parse/read: same-version
  .def parse hit rate 96.1% (n=51, PR2 7d8736b,
  docs/perf/final-pr2-run.txt); composition-root mtime+size fingerprint cache
  re-derives with zero re-reads, `findFilesAcrossRoots` lifecycle cache
  (PR5 d4fd634).
- 【Inference】Residual synchronous reads concentrate in entityMapping.ts's
  direct-read path (with watcher invalidation wired in); no longer the hot
  path. But the structural duplication of "the same file read once via the
  manager's direct read and once via the documentStore snapshot" remains and
  should be merged when migrating to VFS (listed in the CSV risk column).

## AUDIT-005 Real names and paths of core indexes/types/composition root

| Book concept | Actual name | Path:line |
|---|---|---|
| EntityMappingManager | `EntityMappingManager` | src/entityMapping.ts:144 |
| PythonClassIndex | `PythonClassIndex` (five version axes: classes/bases/methods/mro/compositionRoots) | src/pythonClassIndex.ts:311 |
| type registry | `SemanticIndex` + `SemanticTypeRegistrySnapshot<T>` | src/semanticIndex.ts:70 |
| composition root | src/compositionRoots.ts + PythonClassIndex rootsEpoch/assignment-bridge fingerprint | src/compositionRoots.ts (287 lines) |
| definitionWorkspace | `DefinitionWorkspace` (file-level) | src/definitionWorkspace.ts |
| dependency invalidation | `SemanticDependencyGraph` (fullRebuild always false) | src/dependencyGraph.ts |
| scheduling | `IndexScheduler` / `DiagnosticScheduler` | src/indexScheduler.ts:129 / src/diagnosticScheduler.ts:81 |
| snapshot | `DocumentStore` (URI normalization + version + line index) | src/documentStore.ts |
| local symbol index | `WorkspaceIndex` | src/workspaceIndex.ts:22 |

## AUDIT-006 Synchronous IO census (non-test code)

- 【Fact】`fs.*Sync` appears 121 times across 25 files; top:
  workspaceDiscovery.ts 17, generatorForms.ts 14, entityMapping.ts 10,
  codeGenerator.ts 9, pythonStubExport.ts 8, definitionWorkspace.ts 6,
  extension.ts 5, engineCompatibility.ts 5, debugConfigBootstrap.ts 5,
  serverManager.ts 4, logHub.ts 4, defChain.ts 4, clientSdkGenerator.ts 4.
- 【Fact】`getText().split` whole-text line splitting has 2 residual sites
  outside hot zones: languageProviders.ts:4063, eventApi.ts:81 (3 sites in
  documentStore.ts are comments/discipline notes). The high-frequency
  hover/inlay paths were moved to snapshot line data (PR2, 7d8736b).
- 【Fact】`statSync` in 8 files: semanticIndex.ts:249, definitionWorkspace.ts:303,
  entityMapping.ts:306, scanRoots.ts:23, defCallChain.ts:240, quickActions.ts:774,
  serverManager.ts:405, logHub.ts:186. PR4 removed the per-call statSync type
  fingerprint (type registry moved to pure in-memory snapshots).
- 【Fact】`workspace.findFiles`/glob: scanRoots.ts 12, entityMapping.ts 9,
  hotReload.ts 7, languageProviders.ts 5, others scattered. All 14
  `ensureScanned` references are in pythonClassIndex.ts (after PR5 the first
  query no longer waits for the full scan; background completion).
- 【Tested】Interactive requests do no repo-wide traversal: PR7 acceptance
  §9.2 #5/#6 passed (docs/perf/2026-final-report.md §4).

## AUDIT-007 Real call chains and wait points of the four main requests

- 【Fact】All provider shells are uniformly instrumented via
  `startLanguageServiceOperation` (defined extension.ts:330-356), recording
  fileKind/documentVersion/ok|miss|error.
- **hover**: `registerHoverProvider` →
  `KBEngineHoverProvider(entityMappingManager).provideHover` (async). Wait
  points: waitForInitialScan with a 5s timeout + an entry budget race of 2.5s
  total (`kbengine.hover.asyncBudgetMs`); after the B-1 fix, cold hover
  12-14ms / warm 8-10ms (measured on the 1501-def tree, 9c8daf7).
- **definition (.def/xml)**:
  `KBEngineDefinitionProvider(entityMappingManager).provideDefinition` reads
  the semanticIndex snapshot, no repo-wide wait. **definition (python)**:
  `PythonDefinitionProvider(entityMappingManager, pythonClassIndex)`; since
  PR5 it queries snapshots + built indexes first, completing the rest in the
  background;【Tested】U1 cold first query 475.34ms / 1 hit (full-scan baseline
  for comparison 107,737→100,492ms), repeated queries P50/95/99 =
  16.00/22.10/23.60ms (n=40, d4fd634, final-report §3).
- **completion**: `KBEngineCompletionProvider` (.def+python merged selection,
  trigger characters `< > / : .`) + `pythonCompletionProvider`;【Untested】no
  bench for large-collection end-to-end P95 (final-report §9.2 #2 unmeasured).
- **diagnostics**: document events → DiagnosticScheduler.requestQueued
  (version tokens, newest wins) → validateDocument/validateEntitiesXmlDocument
  (synchronous computation) → written directly to the collection.【Tested】
  same-script diagnostic recomputation 19→7, unrelated changes 0 (ae4256d,
  PR6 report).
- **references**: no LSP references provider; the command
  kbengine.symbolReferences.show uses the custom reference graph
  (defReferenceGraph.ts).【Untested】not included in performance budgeting.
- 【Inference】Residual wait-point risk: hover's 5s initial-scan wait will
  still max out on cold starts with tens of thousands of files (cold indexing
  baseline on the order of 100s); PR5 only fixed definition; hover cold-start
  experience awaits a bench.

## AUDIT-008 Capability matrix (migration mapping; details in migration-inventory.csv)

- 【Fact】contributes: 54 commands, 1 view container (kbengine-explorer) with
  5 views (quickActions/entityExplorer/serverControl/telnetStatus/config),
  65 `kbengine.*` configuration items, language kbengine-def (+grammar/
  language-configuration), 3 snippet sets (def/types-xml/python), 2
  keybindings, jsonValidation (**/.kbengine/debug.json), themes.
- 【Fact】debuggers contribution empty (no debug provider registered);
  debugConfig.ts/debugConfigBootstrap.ts only do launch.json generation/attach
  configuration and the debug.json schema (commands kbengine.debug.*).
- 【Fact】Test surface: 193 test files; gate `pnpm test:unit` ≥2,799 passing
  (PR7 actual run 2,799 passed/7 skipped) + tsc/eslint zero errors.

## AUDIT-009 The `.pyi` generation algorithm

- 【Fact】No Python AST, no dynamic Python execution: no
  `spawn('python…')`/`exec('python…')`/`import ast` paths under src/. All
  three generators emit text:
  1. `KBEngine.pyi` (pythonStubExport.ts): emitted from kode's own symbol
     index kbeModuleIndex via `buildKbeStubExportContent`, same source as the
     virtual stub documents; optionally assembles engine typings
     (`typings/_KBEngine_*.pyi`, 12 modules in fixed order). Switch
     `kbengine.python.stubExport` defaults on.
  2. pythonTypeStubs.ts: types.xml custom types → `kbe_types.pyi`
     plan/content built by pure functions.
  3. entityTypeStubs.ts: .def entity property/method stubs with
     `# source: types.xml:line / def file` source annotations.
- 【Tested】`.pyi` shadowing experiment: under pyright 1.1.414, visible stubs
  hide runtime-only symbols
  (docs/review/2026-10-22-pyi-shadow-experiment.md); full .py→.pyi generation
  stays off by default.
- 【Inference】The algorithm is the "own index/text regex" route, not AST;
  fidelity for complex annotations (unions, generics, decorator signatures)
  awaits evaluation — untested (book ch. 9 / ADR-105, ADR-110).

## AUDIT-010 Code generation write behavior

- 【Fact】codeGenerator.ts: .def writes (:211) and entity .py writes (:376)
  have **no overwrite protection** (writeFileSync straight over an existing
  target); entities.xml registration has duplicate prevention (regex
  `<Name(?=[\s>/])` check + warning, :497-522) before writing back before
  `</root>`.
- 【Fact】generatorForms.ts has `writeOrSkip(filePath, content, overwrite)`
  (:422) as an explicit overwrite switch; types.xml/entities.xml write-back
  paths (:457, :473, :494).
- 【Fact】pythonTypeStubs `exportPythonTypeStubs`: target already exists in a
  user directory → skip ("user assets are not overwritten"); identical
  content → zero write; types.xml watcher auto-regenerates (:602).
  pythonStubExport: zero write when content matches disk.
- 【Fact】Source-location jumps: generatedSourceMap.ts
  `resolvePythonTypeStubSource`/`resolveEntityTypeStubSource` +
  GeneratedSourceCodeLensProvider (`# source:` annotations in stubs point
  back to def/types.xml lines).
- 【Fact】Version/conflict handling: generated files carry no version field;
  conflict semantics are the binary skip-or-overwrite; no backups, no
  three-way merge.【Inference】codeGenerator's bare overwrite contradicts
  PR-001's red line (writes to user files need separate review); list it in
  the typings/codegen risk items at migration time (CSV risk column).

## AUDIT-011 Runtime boundaries (log/terminal/HTTP/telnet/watcher)

- 【Fact】Processes: processManager.ts (child_process.spawn, process-table
  tracking, SIGTERM→SIGKILL degradation) and serverManager.ts (KBEngine
  component start/stop/restart). All inside the extension host process; no
  resident Core subprocess.
- 【Fact】log: logHub.ts in-process EventEmitter batching (onBatch), sha256
  fingerprint dedupe (:101), receives the port from loggerPort config;
  logWebView/monitoringWebView are webview surfaces. Log collection is the
  TCP/port-receiver shape, with connection lifecycle tied to the
  logAutoConnect configuration.
- 【Fact】telnet: telnetClient.ts `net.connect` + SocketFactory injection,
  state machine (connecting etc.), telnetService periodic probing
  (`kbengine.telnet.probeIntervalSeconds`, 0 = fall back per component
  kbengine.xml `<telnet_service>` section to engine defaults/built-in port
  table); auto-handshake passwords never land in logs.
- 【Fact】HTTP: outbound client only (httpRequestService.ts, default timeout
  10,000ms, response preview truncated at 4,000 characters); no built-in HTTP
  server.
- 【Fact】Watcher inventory (createFileSystemWatcher/onDidSave):
  entityMapping.ts×3 (types.xml/alias.xml/entity-file invalidation coupling),
  extension.ts×3, hotReload.ts×1, pythonTypeStubs.ts×1 (**/types.xml),
  workspaceIndex.ts×1 (py glob), languageProviders.ts×1, debugConfig.ts×1.
  hotReload does explicit dispose/rebuild; the rest are released via
  subscriptions.
- 【Inference】All runtime boundaries (processes/ports/sockets/watchers) live
  inside the extension host — a structural gap against the book's ARCH-002
  "language requests must not spawn processes; script execution belongs in a
  separate service", and a core motivating fact for the Rust Core migration.

## AUDIT-014 Old A1-A7 → new Phase mapping

| Old item | Commit | New ledger location |
|---|---|---|
| A1 PR1 performance observation and baseline | 89e8783 | Phase 0 (PERF-005/007 segmented latencies landed at service-layer discipline) |
| A2 PR2 documentStore | 7d8736b | Phase 1 PR-004 core/vfs-snapshot's TS-side predecessor (snapshot/single-parse-per-version contract locked) |
| A3 PR3 indexScheduler | 2aca694 | Phase 2 PR-009 invalidation-scheduler predecessor (priority queue/task merge/failure recovery locked) |
| A4 PR4 semanticIndex+dependencyGraph | 2aca694 family | Phase 2 PR-007/PR-008 predecessors (unified queries, dependency invalidation, multi-root lookup-order forensics docs/review/2026-10-23-pr4-lookup-order-forensics.md) |
| A5 PR5 Definition de-blocking | d4fd634 | Phase 2 PR-010 dual-track comparison's TS baseline (U1 475.34ms is the comparison benchmark) |
| A6 PR6 diagnostics consistency | ae4256d | Phase 3 PR-011 diagnostics versioning predecessor |
| A7 PR7 retest regression | e6e8bc7 | Phase 0 baseline wrap-up (docs/perf/2026-final-report.md) |

- 【Tested】Infinite-spin/timeout regression test status: the hover
  infinite-spin fix (B-1, 9c8daf7→5071dde) and the scheduler's failure
  recovery never pending forever (PR3 A3-4) both have test locks, within the
  2,799 gate; diagnostic recompute counting assertions
  (tests/diagnosticScheduler.test.ts).
- 【Inference】Overlap of A1-A7 with the book's PR-002 (fix/ts-hotpath): the
  book's "stop the bleeding on clearly blocking paths" was already done by
  A2-A6; PR-002 should be redirected to consume baseline §6's leftover list
  (Hover/Completion bench, memory records, multi-round benchmarks).

## AUDIT-015 retained / moved / reworked / deferred

- Per-module classification in docs/architecture/migration-inventory.csv
  ("migration method" column). Summary: retained (untouched) ≈ grammar
  packages/themes/snippets/schema; reworked (TS→Rust module-by-module
  replacement) = parsing/index/query/diagnostics core; moved (ported as-is
  into the new host) = HTTP quick requests, telnet client, log surface,
  webviews; deferred = debugger surface (never had a provider), database
  simulation and other non-language features.
- 【Inference】Under the zero-capability-loss requirement, the multi-root
  same-name entity/class lookup order (forensics done + test locked) must be
  compared against the Rust query core first.

## AUDIT-016 HR-AUDIT: HTTP/Watch/Hash code truth and gap list

- 【Fact】HTTP quick requests **implemented**: httpRequests.ts (entry parse/
  validation + template variables) + httpRequestService.ts (outbound
  requests/timeout/output); commands kbengine.httpRequest.run,
  kbengine.httpRequests.run. Template variables: `${module}` = upward scan by
  `__init__.py` package boundary (httpRequests.ts:108-116; base/cell lack
  `__init__.py` and don't count as package segments), `${moduleBasename}` =
  one level of the last segment, `${filename}`, `${line}`, `${sel}` + the
  VS Code official variable family (via the variableSubstitution single
  source of truth); literal substitution, no URL encoding.
- 【Fact】Built-in example endpoint/parameter names follow the 2026-11-06
  user directive: `POST http://127.0.0.1:8090/hotfix?module_name=${module}`,
  with a copy of `module_name=${module}` in both query and body (compatible
  with different server-side parameter-reading conventions; harmless
  duplication of the same value) (src/httpRequests.ts, package.json
  `kbengine.httpRequests` default, docs/zh/guide/configuration.md, test-locked
  sync); the old wrong spelling (the `8000/api/hotfix?…` recorded in batch
  152) has been purged repo-wide, asserted by full grep in
  `tests/hotfixSpellingGate.test.ts`. The server side (KBEngine management
  interface) implementation is not in this repo — HR-AUDIT-009 untested.
- 【Fact】Watch: hotReload.ts is "save/watch → debounce (default 500ms) →
  trigger hot reload", **on by default** (2026-11-06 user directive; explicit
  `enabled=false` still turns it off); with `actionName` unset it sends the
  default HTTP hot-reload request via TS, `POST
  http://127.0.0.1:8090/hotfix?module_name=<module name>` (body also carries
  `module_name=<module name>`, dual-carried for server compatibility,
  src/hotReloadDefaultHotfix.ts); one-click off = status-bar click /
  `kbengine.hotReload.toggle`.
- 【Fact】Hash/Digest: src/ has no .def/.xml hashing or engine Digest
  implementation (only logHub.ts:101 uses sha256 as a log dedupe fingerprint);
  hot-reload success confirmation (transport_success/accepted/applied
  classification) has no code at all.
- 【Gap list (current state → book ch. 19 specification)】
  1. Module name: currently `${module}` = full package path
     (entities.fight.FightAI); the book requires the dual-name model
     requestModule=fight.FightAI (parent dir name + file short name) +
     fullModule for display — needs the HR-MOD rework;
  2. Success semantics: currently only the HTTP response preview is shown, no
     accepted/applied distinction, no "request sent / pending confirmation"
     status — needs HR-STATE;
  3. Watch→HTTP: the default path has been wired since 2026-11-06 (save →
     default hot-reload POST `http://127.0.0.1:8090/hotfix?module_name=<module
     name>`, src/hotReloadDefaultHotfix.ts); per-target/idempotent semantics
     via quick actions still need the HR-WATCH adapter;
  4. Hash: entirely missing — HR-HASH wholly to build;
  5. Record uniqueness: no targetId+rootId+URI record model;
  6. Security: no workspace whitelist/endpoint approval/default-off
     per-target switch (hotReload's one-click toggle and default-endpoint
     constraints are reusable).
- 【Fact】Per-item implementation landing: this file is the gap-list pointer;
  HR-AUDIT-012's docs/hotreload/current-implementation.md was landed by the
  parallel HR-PR-01 (commit 1e30ff8, same base SHA 36052c4 as this audit);
  the HR gap list defers to that file.

## PERF-002/003/004 Fixture specs (state and gaps)

- 【Tested】Existing generator scripts/generate-perf-assets.mjs
  (deterministic): small 7 / large 30,005 (.py) / multi-root 18 (3 roots,
  same-name entity Avatar + same-name class Inventory) / big-py 5 (single
  file, 8,000 methods) / def-heavy 1,323 (1,200 .def + 40 groups of
  entities/types/alias variants) / noise 406 (.git/build/third_party
  interference). Reproduce: `KODE_PERF_LARGE_FILES=30000 npx vitest run
  --config vitest.bench.config.ts` (since 89e8783, re-test through e6e8bc7 on
  the same assets).
- Against the book's S/M/L/XL/XRoot tiers: S≈small ✓; L≈large ✓ (30k>10k);
  multi-root covers XRoot's 3 roots and same-name conflicts ✓; **M (2k) has
  no ready-made tier — to build (generator parameterization suffices)**;
  **XL (50k+) to build**; deep inheritance, alias cycles, incomplete XML,
  non-ASCII paths **to build**.
- PERF-004 real engine samples: untested (fantasydemo real-script batch = the
  old C-9, unscheduled); the isolation requirement between synthetic and real
  samples has a reserved directory plan.

## PERF-005 Segmented latency discipline (tested/untested)

- 【Tested】Service-layer segmentation (PR1 instrumentation, 11 event kinds:
  completion/hover/definition/diagnostics/python-index-scan/
  entity-mapping-scan/type-registry-query/file-discovery/document-parse
  etc.): cold index 107,737→100,493ms; de-blocked first query 475.34ms; warm
  query P95 0.02-22.1ms; def warm rescan 17-18.7ms; invalidation 6.7-11.3ms;
  diagnostic recompute 19→7. Sources: 89e8783 baseline + e6e8bc7 re-test,
  raw output docs/perf/*.txt.
- 【Untested】extension activation (real VS Code activation), workspace
  discovery, publish to editor (end-to-end), Core spawn/handshake (Rust Core
  does not exist yet, N/A until PR-003). All service-layer numbers exclude UI
  serialization and provider dispatch overhead.

## PERF-015 Cross-machine discipline

- 【Fact】All PR1-7 numbers came from the same machine
  (docs/perf/hardware.md); final-report §5 honestly records single-run jitter
  (mechanical disk + warm-cache discipline: U4 two runs 130.3s/89.9s, same
  code).
- 【Rule (adopting the book's PERF-015)】Do not compare absolute speed across
  machines; the main report uses this machine's fixed baseline; all current
  conclusions are single-run, **multi-run median/confidence interval to
  build** (bench `--repeat`).

## PERF-016 decisions.md

- 【Fact】docs/perf/decisions.md does not exist yet; existing optimization
  evidence is scattered across docs/perf/2026-pr2/3/5/6-*.md and
  docs/review/2026-10-22-unified-semantic-index-refactor.md. Not built due to
  this PR's "produce only three files" constraint — to build, migrating items
  one by one when created (evidence, trade-offs, rollback).
