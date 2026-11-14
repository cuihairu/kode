# Provider Data Sources and Side-Effect Inventory

- Baseline: 1813-10-29, after ARC-001..005 converged (`499d34a`; PDBG-004 added RemoteServerTreeProvider and reconciled all construction-site line numbers). Nature: describes **current code facts**, not a concept sketch; complements docs/architecture/semantic-index.md (data and scheduling surfaces). This page answers: which data each provider queries, which side effects it is allowed to cause, and which migrations are still unfinished.
- Locked: tests/providerDataSourceDoc.test.ts reconciles item by item — every Provider class actually constructed in extension.ts must appear on this page; the watcher distribution list must equal the actual `createFileSystemWatcher` count per file; unfinished-migration markers must be in place. Moving code requires editing this page in the same commit.

## 1. Side-effect boundary

Read-path general rule (set by ARC-005, source-level lock tests/typeStorageWatcherOwnership.test.ts):

- **Repo-wide services belong to the assembly layer**: watchers, workers, and caches are constructed only in extension.ts, released uniformly via `context.subscriptions`, with `deactivate()` winding down workers and snapshots; providers never build a second set of repo-wide services (`createFileSystemWatcher` count across languageProviders.ts + src/languageProviders/* is zero).
- The side effects a provider may cause are a six-item whitelist only:
  1. **Cache backfill**: on a same-version/mtime fingerprint miss, fill the read-only cache;
  2. **Background completion enqueue**: the first query does not wait for the full scan; the gap is queued for background completion via `IndexScheduler` (requests are not blocked);
  3. **Shadow reporting**: shadow comparison/observation legs are fire-and-forget and never change return values (determinism surface in docs/perf/2026-baseline.md §7);
  4. **Event publication**: its own emitter (e.g. `fireConfigurationChanged`) notifies the assembly line to refresh the shadow;
  5. **UI panels**: webview/tree-view creation and refresh (only CallChainController and §2b/§2c tree providers);
  6. **Edit proposals**: Rename/CodeAction return a WorkspaceEdit (applied by the host/user; the provider never writes to disk).
- Forbidden: synchronous repo-wide IO on the request path; providers building watchers/workers/a second index; reading config/files as formatting input (pure formatting lives in hoverMarkdown).

## 2. Provider inventory

### 2a. Language providers (vscode.languages.register\*, 32 registrations / 31 classes)

Registration sites are extension.ts line numbers (2026-11-07 真位复核:KODE-ARCH-001 将 languageProviders.ts 拆为 src/languageProviders/* 子模块,类定义列与注册行已按当前代码逐行重探):

| Provider | Class definition | Registration | Data sources | Allowed side effects |
|---|---|---|---|---|
| KBEngineCompletionProvider | languageProviders/completion.ts:260 | :960 | EntityMappingManager snapshot (def tag/attribute context) + documentStore line snapshots | Cache backfill |
| KBEngineSignatureHelpProvider | languageProviders/hover.ts:918 | :1006 | EntityMappingManager (def method signatures) | Pure read |
| KBEngineHoverProvider | languageProviders/hover.ts:71 | :1043 | EntityMappingManager + documentStore line snapshots + hoverMarkdown pure formatting | shadowCompareDefinition shadow report |
| ServerConfigHoverProvider | serverConfigHover.ts:366 | :233 (activate/languageServices.ts) | buildConfigTreePair resolve-cache trees + CFG-06 source-evidence face (backend/configSourceFace) + CFG-10 modification-impact face (backend/configImpact, computed from the hovered document's live text so unsaved edits refresh) | Pure read (presentation only; never writes the user's config) |
| StartupScriptHoverProvider | kbengineStartupScript.ts:409 | :916 | Line-level plain-text token scan (CLI `--args` + `$VAR`/`VAR=` env vars, KBEXP-1) | Pure read |
| KBEngineDefinitionProvider | languageProviders/navigation.ts:15 | :1101 | EntityMappingManager → SemanticIndex snapshot (no repo-wide wait) | Pure read |
| PythonDefinitionProvider | languageProviders/pythonDefinition.ts:237 | :1159 | EntityMappingManager + PythonClassIndex (classes/bases/methods/mro/compositionRoots five axes) | ensureScanned background completion enqueue + shadowObserveDefDocument shadow observation |
| PythonCompletionProvider | languageProviders/completion.ts:627 | :1482 | EntityMappingManager + engineApiCatalog (built async at :301) | Pure read |
| StartupScriptCompletionProvider | kbengineStartupScript.ts:430 | :921 | Line-level plain-text token scan (`--` completes CLI args, `KBE_` completes env vars, KBEXP-1) | Pure read |
| ConfigCompletionProvider | configCompletionProvider.ts:75 | activate/languageServices.ts:255 (KSEM-CFG-04) | buildConfigTreePair resolve-cache trees (analysis WeakMap keyed on defaultsTree identity) + CFG-02 contract extraction + CFG-03 field-identity scan; context parse + key/value suggestions in pure core backend/configCompletion | Pure read (toggle kbengine.configCompletion.enabled; null defaultsTree → no suggestions) |
| ConfigDefinitionProvider | configDefinitionProvider.ts:28 | activate/languageServices.ts:266 (KSEM-CFG-06) | buildConfigTreePair defaults tree + defaults file text (declaration line via CFG-05 line index) + buildFinalServerConfig rendered text (effective value line); pure core backend/configSourceFace path resolution | Pure read (path missing → no locations) |
| RpcCodeLensProvider | languageProviders/codeLens.ts:14 | :1279 | EntityMappingManager (RPC mirror chain) | Pure read |
| CallChainController | defCallChainProvider.ts:49 | :1096 | EntityMappingManager | webview panel creation/update (UI side effect) |
| PropertyCodeLensProvider | languageProviders/codeLens.ts:182 | :1304 | EntityMappingManager (types.xml property back-references) | fireConfigurationChanged event |
| ProcessOwnershipCodeLensProvider | languageProviders/processOwnership.ts:26 | :696 | `scripts/<role>` directory layout via pure core backend/processOwnershipLens (sibling existence via injected fs.existsSync); EntityMappingManager (`resolveMethodDefinition`) as the secondary def-section evidence arm | fireConfigurationChanged event + workspace file create/delete events (.py filter) |
| EventCodeLensProvider | eventApi.ts:95 | :1128 | EventCallIndex small interface (`allEventCalls`, ARC-002; injected sharedWorkspaceIndex) | After the 8s pre-start delay, enqueues the shared index's repo-wide py scan (the only scan entry) |
| TypesXmlCodeLensProvider | languageProviders/codeLens.ts:360 | activate/languageServices.ts:514 (SRC-001 L2) | databaseSchema type-storage usage index (`onTypeStorageUsageIndexPublished` subscription; zero construction deps) | fireConfigurationChanged event; watcher belongs to the assembly line (ARC-005) |
| GeneratedSourceCodeLensProvider (python stubs) | generatedSourceLenses.ts:11 | activate/languageServices.ts:538 (SRC-001 L2) | Construction-time snapshot buildPythonTypeStubPlan(getCustomTypeInfos) | Pure read |
| GeneratedSourceCodeLensProvider (entity stubs) | generatedSourceLenses.ts:11 | activate/generators.ts:90 (SRC-001 L7) | Construction-time snapshot buildEntityTypeStubPlan(getAllMappings + getCustomTypeInfos) | Pure read |
| PythonTypeInlayHintsProvider | typeInlayHints.ts:33 | :1197 | EntityMappingManager | Pure read |
| KBEngineBuiltinTypeInlayHintsProvider | languageProviders/inlay.ts:16 | :1406 | EntityMappingManager | Pure read |
| InferredMirrorTypeInlayHintsProvider | languageProviders/inlay.ts:68 | :584 | Inferred mirror annotation files under managed dir (kbengine.infer.enabled gate; definition-point line diff) | Pure read |
| DefParamInlayHintsProvider | defParamInlayHints.ts:226 | :1217 | EntityMappingManager | Pure read |
| DefPropsInlayHintsProvider | defPropsInlayHints.ts:126 | :1432 | EntityMappingManager (`listPropertyDefinitionsForFile` root-level properties for the anchor's entity) | Pure read |
| KBEnginePropertyShadowInlayHintsProvider | languageProviders/inlay.ts:122 | :600 | EntityMappingManager (`resolvePropertyDefinitionInfo` domain/type faces for copy-property and cellData-key hints; `kbengine.inlayHints.propertyShadow` × `kbengine.propertyDirectionDiagnostics` dual gate) | Pure read |
| KBEngineProxyInternalAttrHintsProvider | languageProviders/inlay.ts:225 | :609 | Project stub-copy Proxy.pyi (line-scanned declaration rows; `kbengine.python.proxyInternalAttrHints` gate; demo asset script domains only) | Pure read |
| KBEngineCallHierarchyProvider | languageProviders/callHierarchy.ts:9 | :1425 | EntityMappingManager (def/python dual-selection call hierarchy) | Pure read |
| KBEngineReferencesProvider | languageProviders/references.ts:22 | :1431 | EntityMappingManager + defReferenceGraph reference graph | Pure read |
| KBEngineDocumentSymbolProvider | languageProviders/references.ts:267 | :1455 | Current document def structure (zero construction deps) | Pure read |
| KBEngineWorkspaceSymbolProvider | languageProviders/references.ts:315 | :1461 | EntityMappingManager (repo-wide symbol search) | Pure read |
| KBEngineImplementationProvider | languageProviders/references.ts:347 | :1468 | EntityMappingManager (def interface method implementation location) | Pure read |
| KBEngineRenameProvider | languageProviders/rename.ts:8 | :1476 | EntityMappingManager (def symbol rename) | Edit proposal (WorkspaceEdit) |
| KBEngineTypeCodeActionProvider | languageProviders/codeAction.ts:13 | :2274 | Current document def structure (zero construction deps) | Edit proposal (WorkspaceEdit) |
| KBEngineMethodImplementationCodeActionProvider | languageProviders/codeAction.ts:113 | :2281 | EntityMappingManager (interface method stub generation) | Edit proposal (WorkspaceEdit) |
| KBEngineDefPythonParityCodeActionProvider | languageProviders/codeAction.ts:240 | :2289 | Diagnostics surface (context.diagnostics, code=def-method-missing-in-python) + bidirectional location surface (target Python file/class) + current document def structure (signature type mapping) | Edit proposal (WorkspaceEdit, method skeleton appended at class end) |
| KBEngineReceiverNoneGuardCodeActionProvider | languageProviders/codeAction.ts:378 | :2297 | Diagnostics surface (context.diagnostics, code=kbengine.receiverNone) + current document text | Edit proposal (WorkspaceEdit, wrap-style preferred + early-return style) |
| HotReloadFileStateCodeLensProvider | hotReloadFileStateLens.ts:43 | :4456 | HotReloadFileStateMachine derived view (ledger source of truth, IDE-HOT-100) | Pure read; state-dot click command kbengine.hotReload.showFileState |

Command query surfaces (non-register\* providers, recorded under the same rules): the symbol references panel `kbengine.symbolReferences.show` uses the defReferenceGraph custom reference graph (coexists with the LSP references provider); the entity dependency graph `kbengine.dependency.show` uses dependencyGraph.ts + webview. Their data sources are likewise EntityMappingManager snapshots, with side effects limited to the webview.

### 2b. Virtual document providers (registerTextDocumentContentProvider, read-only content surface)

| Provider | Class definition | Registration | Data sources |
|---|---|---|---|
| kbe module symbol stub (anonymous ×2) | inline in extension.ts (:442, :488) | :342/:373 | buildKbeStubDocument + engineApiCatalog metadata |
| KBEngineDatabaseSchemaProvider | databaseSchemaPresentation.ts (ARC-004 assembly surface) | :358 | databaseSchema snapshot/rendering (delegated) |
| KBEngineDatabaseSimulationProvider | databaseSimulator.ts:364 | :364 | databaseSimulator line simulation (on top of the schema snapshot) |
| FinalConfigContentProvider | serverConfigMerge.ts:2768 | :2716 | kbengine.xml synthesized-tree rendering |
| GitHistoryVersionContentProvider | gitHistoryDiff.ts:145 | :4143 | kode-git-version virtual documents: version content fetched by the repo/commit/path triple (IDE-GIT-006, bounded read-only git show; missing path → empty string / read failure → throw) |

### 2c. Tree/task providers (UI assembly surface)

Construction-site history: from SRC-001 L4 the server/telnet/player-data/remote-server/debug-target tree providers are constructed in `src/activate/serverControls.ts`, and from SRC-001 L5 the entity-explorer/quick-action/final-config/git-history/git-range-history tree providers are constructed in `src/activate/views.ts` (pure moves from extension.ts; those rows carry the new site below, other rows keep their baseline extension.ts line numbers).

| Provider | Class definition | Construction | Data sources | Allowed side effects |
|---|---|---|---|---|
| EntityExplorerProvider | explorerProviders.ts:1391 | activate/views.ts (SRC-001 L5) | entities.xml manifest scan | Tree refresh events |
| ServerControlProvider | explorerProviders.ts:1790 | activate/serverControls.ts (SRC-001 L4) | serverManager state | Tree refresh + user-triggered start/stop commands |
| TelnetTreeProvider | telnetTree.ts:1798 | activate/serverControls.ts (SRC-001 L4) | telnetService state | Tree refresh events |
| RemoteServerTreeProvider | remoteServerTree.ts:1813 | activate/serverControls.ts (SRC-001 L4) | ~/.ssh/config snapshot + workspaceState manual entries/selection (IDE-PDBG-004) | Tree refresh events |
| PlayerDataTreeProvider | playerDataPanel.ts:108 | activate/serverControls.ts (SRC-001 L4) | read-only MySQL connection profiles derived by configDerive (Rust `derive_database`, CLONE-P5) + databaseDrift read-only query executor; the first frame idempotently triggers derivation and honestly shows "not found" until ready | Tree refresh events (triggered by query/refresh commands) |
| ComponentStatusTreeProvider | componentStatusPanel.ts:92 | :4607 | shared ConsoleHub machined UDP discovery ledger (KB-GC-001; pid/cpu/mem/usedmem/state ride the Args25 discovery reply) + resolved cpu/mem thresholds; vanished processes kept as red tombstone rows | Tree refresh events (auto poll + manual `kbengine.consoleComponentPanel.refresh`), red ThemeIcon on abnormal |
| KbengineBuildTaskProvider | buildTaskProvider.ts:2146 | :2094 | Build task definitions (static) | None (provides tasks only) |
| DebugTargetTreeProvider | debugStatusTree.ts:2063 | activate/serverControls.ts (SRC-001 L4) | getDebugStatusRows polling | Tree refresh events |
| QuickActionTreeProvider | quickActionTree.ts:3092 | activate/views.ts (SRC-001 L5) | Quick action inventory | Tree refresh + user-triggered commands |
| FinalConfigTreeProvider | serverConfigMerge.ts:2808 | activate/views.ts (SRC-001 L5) | kbengine.xml synthesized tree | Tree refresh events |
| GitHistoryTreeProvider | gitHistoryTree.ts:165 | activate/views.ts (SRC-001 L5) | GitCommitLog paging (IDE-GIT-004, queried on demand only via user entry; zero Git when idle), through the shared query gate (IDE-GIT-011: dedupe/concurrency cap 2 with range tracking 1/bounded queue/LRU cache/cancel on view hide-disable-unload) | Tree refresh events + user-triggered "load next page" |
| GitRangeHistoryTreeProvider | gitRangeHistoryTree.ts:208 | activate/views.ts (SRC-001 L5) | Selection→HEAD line-span mapping (IDE-GIT-008) + per-commit modification timeline (IDE-GIT-009, queried on demand only via user entry; zero Git when idle, no editor-switch/selection listeners), through the shared query gate (IDE-GIT-011, duplicate selections keep only the newest) | Tree refresh events (title follows state) |
| PlayerDataTreeProvider | playerDataPanel.ts:108 | activate/serverControls.ts (SRC-001 L4) | MySQL connection profiles from the Rust derive_database single source of truth (`configDerive.getDerivedDatabaseProfile`, zero hand-filling/rewriting) + databaseDrift read-only executor (connection test `SELECT 1`, read-only SELECT by dbid; statement whitelist + READ ONLY session double protection, CLONE-P5 skeleton) | Tree refresh events; read-only query output goes to the "KBEngine Player Data (read-only)" channel with zero writes; the password never leaves as a value (masked marker) |

### 2d. File tree decoration provider (vscode.window.registerFileDecorationProvider, IDE-HOT-100)

| Provider | Class definition | Registration | Data sources | Allowed side effects |
|---|---|---|---|---|
| HotReloadFileDecorationProvider | hotReloadFileDecorations.ts:35 | :4446 | HotReloadFileStateMachine derived view aggregated by (rootId,targetId,file), colored by worst state | Pure read; refresh() via the onDidChangeFileDecorations event |

## 3. Diagnostics surface

No `registerDiagnosticProvider`; diagnostics go through DiagnosticScheduler (`getDiagnosticScheduler()` singleton, extension.ts:575; version tokens + layered accounting + same-URI newest-version-wins):

- Data sources: `validateDocument` (languageProviders.ts:1425) — the defParser single-parse result is shared across scalar + structure validation (`parseDefAst`, :1440); the entry is a same-version documentStore snapshot; `validateEntitiesXmlDocument` (:1458) — the documentStore `entities-analysis` namespace cache (:1471).
- Side effects: DiagnosticCollection publication (the legitimate exit of the diagnostics surface).
- Channel: `onDidChangeTextDocument` (extension.ts:1835) → `flushQueued()` (:1909, single 25ms time slice, IDE-DIA-006) → scheduled by diagnosticScheduler.ts.
- Python receiver-none diagnostics: independently scheduled `scheduleReceiverNoneDiagnostics` (extension.ts:660, async chunked computeReceiverNoneFindingsAsync); diagnostics carry stable codes (`kbengine.receiverNone`/`kbengine.sectionMismatch`, published at extension.ts:730), and `KBEngineReceiverNoneGuardCodeActionProvider` reconciles guard QuickFixes by code.

## 4. Shared services and lifecycle owners

| Service | Sole construction site | Release channel |
|---|---|---|
| IndexScheduler | extension.ts:634 | context.subscriptions |
| EntityMappingManager | extension.ts:652 | context.subscriptions (manager-internal watchers in §5) |
| DiagnosticScheduler | extension.ts:575 (getDiagnosticScheduler singleton) | Process lifetime |
| PythonClassIndex | extension.ts:953 | context.subscriptions |
| WorkspaceIndex | extension.ts:1126 (repo-wide unique, source-level lock) | context.subscriptions |
| TypesXmlCodeLensProvider instance | extension.ts:1168 | context.subscriptions (registration surface + impl instance, ARC-005) |
| typesXml storage-index watcher assembly line | typeStorageIndexWatchers.ts (wired at extension.ts:1175) | context.subscriptions (the returned Disposable) |
| Python parser worker / snapshot cache | Assembly layer | deactivate(): disposePythonParserWorker() + releaseAllDocumentSnapshots() |

## 5. Watcher distribution

Watcher distribution (baseline 499d34a, counted by **source call sites**, reconciled per file by the test; from GLOBDATA-001 globalDataIndex gains 1; from AUD-035 workspaceIndex gains 1 = workspace py glob + external-root RelativePattern; from KODE-CFG-017 inferPipeline gains 1 = the infer pipeline py watcher; from the config-contract check diagnostics extension.ts gains 1 = the .kbengine/debug.json/.gitignore/.vscode/settings.json/CLAUDE.md/README contract-file watcher; from SRC-001 L2 extension.ts yields 1 = the python class-index watcher moved to activate/languageServices.ts, from SRC-001 L3 it yields 1 more = the config-contract watcher moved to activate/diagnostics.ts, from SRC-001 L5 it yields 1 more = the final-config kbengine*.xml watcher moved to activate/views.ts, and from SRC-001 L7 it yields its last one = the managed-dir watcher moved to activate/generators.ts, the test keys by file name so the census lists src/languageServices.ts, src/views.ts and src/generators.ts; from PA-007 increment 2 protocolSchemaSync.ts gains 1 = the protocol-definition watcher group (4 globs through one looped call site); from HR-PR-05 hotReload.ts gains 1 = the disk-side vscode.createFileSystemWatcher real adapter in activate/hotReload.ts, the test keys by file name so it folds into src/hotReload.ts; from KSEM-CFG-05 configValueDiagnosticsWiring.ts gains 1 = the kbengine.xml value-diagnostics watcher): src/languageServices.ts=1 src/diagnostics.ts=1 src/typeStorageIndexWatchers.ts=1 src/entityMapping.ts=3 src/hotReload.ts=2 src/pythonTypeStubs.ts=1 src/debugConfig.ts=1 src/workspaceIndex.ts=2 src/globalDataIndex.ts=1 src/inferPipeline.ts=1 src/views.ts=1 src/generators.ts=1 src/protocolSchemaSync.ts=1 src/configValueDiagnosticsWiring.ts=1 (18 call sites total)

- Assembly-line self-held: typeStorageIndexWatchers.ts ×1 call site (loop-building the 3 def/types.xml/entities.xml watchers, ARC-005) — the config-contract watcher moved to diagnostics.ts (SRC-001 L3), the final-config kbengine*.xml watcher moved to views.ts (SRC-001 L5), and the managed-dir watcher moved to generators.ts (SRC-001 L7; extension.ts now holds zero watcher call sites).
- Module self-held (see §6 notes): entityMapping ×3, hotReload ×1 (explicit dispose/rebuild), pythonTypeStubs ×1, debugConfig ×1.
- workspaceIndex ×1 (py glob) lives inside the class, but WorkspaceIndex's repo-wide unique construction site is in the assembly layer and its Disposable is released via context.subscriptions — the lifecycle rule already satisfies ARC-005 and does not count as unfinished.

## 6. Unfinished migrations

The items below are **explicitly unfinished** migrations and must not be written up as done:

- 【Unfinished migration】The languageProviders.ts monolith: 5,874 lines, 18 exported classes cohabiting one file. ARC-001..005 already split out constants (sourceRevealCommand), pure types (eventIndexTypes), hover formatting (hoverMarkdown), the schema adapter layer (databaseSchemaCore/Presentation), and the watcher assembly line (typeStorageIndexWatchers), but a per-provider file split has not been done — the largest single-piece risk before the RST swimlane (Rust-ification, module-by-module replacement); see docs/architecture/current-state.md AUDIT-002.
- 【Unfinished migration】Signature help and completion copy: the SignatureInformation strings of KBEngineSignatureHelpProvider (languageProviders.ts:1258) and the completion documentation copy still live in languageProviders.ts; ARC-003 only extracted the five hover render sites to hoverMarkdown.ts — these two surfaces, same wording but different features, were not extracted.
- 【Unfinished migration】entityMapping dual reads: types.xml/alias.xml go through direct readFileSync paths in entityMapping.ts, so two paths (direct read + documentStore snapshot) each read the same file once; the structural duplication remains (listed in current-state.md AUDIT-004's CSV risk column; should be merged during the VFS migration).
- 【Unfinished migration】Module self-held watchers: entityMapping.ts ×3, hotReload.ts ×1, pythonTypeStubs.ts ×1, debugConfig.ts ×1 — six call sites living in non-assembly modules. ARC-005 only collected the provider surface (TypesXmlCodeLensProvider); whether the manager/feature-module surface should be folded into the assembly line is undecided, pending per-item review in the RST swimlane (assembly-line benefit vs module cohesion).
