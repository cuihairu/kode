# Supported Features

[中文](./zh/features.md)

Evidence-based feature list for the kode VS Code extension. Each entry carries an evidence pointer; features without verifiable evidence are not listed.

<!-- GROUPS -->

## Def & Entity Intelligence

- **kbengine-def language & grammar** — `.def` files get a dedicated language id, bracket rules and a TextMate grammar — (evidence: package.json#contributes.languages, package.json#contributes.grammars)
- **Real-time .def diagnostics** — unknown types / Flags / DetailLevel values, duplicate property & method definitions, missing Type/Flags fields, with a master switch — (evidence: package.json#configuration `kbengine.diagnostics.*`, `kbengine.enableDiagnostics`; src/defAnalyzer.ts)
- **Structured .def validation** — duplicate definitions, tag placement and missing-field checks behind `kbengine.enableStructureDiagnostics` — (evidence: package.json#configuration `kbengine.enableStructureDiagnostics`; src/defAnalyzer.ts)
- **Receiver-aware def section gating** — property Flags resolved into base/cell/client visibility domains that gate sections and ordering — (evidence: src/defAnalyzer.ts `propertyFlagDomainList`; commit c69517e)
- **Hover: tag / value / symbol docs** — .def tag explanations, type-Flags-DetailLevel value docs and custom property/method summaries — (evidence: package.json#configuration `kbengine.hover.showTagDocs|showValueDocs|showSymbolDocs`; src/languageProviders.ts)
- **Hover: types.xml storage shape** — where a custom type lands in the database (builtin column, FIXED_DICT flatten, ARRAY child table recursion) — (evidence: todo.md:20; package.json#configuration `kbengine.hover.typeStorage`; src/languageProviders.ts `describeTypeStorageShape`)
- **Hover: Implemented-By reverse link** — def method hover shows the script implementation location — (evidence: package.json#configuration `kbengine.hover.implementedBy`; todo.md:111)
- **Hover: entity registration** — entities.xml registration info (Utype number, list position, total count) — (evidence: package.json#configuration `kbengine.hover.entityRegistration`)
- **Hover: merged def chain** — Parent chain + interfaces + component slots as one inheritance-closure hover — (evidence: package.json#configuration `kbengine.hover.defChain`; todo.md:31; src/defChain.ts)
- **Hover: event stats** — registration/listening counts for event constants (event callback reverse links) — (evidence: package.json#configuration `kbengine.hover.eventStats`; src/eventApi.ts)
- **Hover: server config values** — kbengine.xml server config entries with value and explanation — (evidence: package.json#configuration `kbengine.hover.serverConfig`; src/serverConfigHover.ts)
- **Hover: persistent property DB location** — persistent properties show full `db`.`tbl`.`col` name plus engine DDL fragment and limits — (evidence: todo.md:69, todo.md:124; src/databaseSchema.ts `describePropertyDatabaseStorage`)
- **CodeLens: RPC methods** — def-declared Exposed methods marked at their Python implementation lines — (evidence: package.json#configuration `kbengine.codeLens.rpc`; todo.md:74; src/rpcCodeLens.ts)
- **CodeLens: event callbacks** — event callback/subscription markers in Python scripts — (evidence: package.json#configuration `kbengine.codeLens.eventCallbacks`; todo.md:27; src/eventApi.ts)
- **CodeLens: property access reverse jump** — `self.<property>` access lines link back to the def declaration with type/visibility/persistent info — (evidence: package.json#configuration `kbengine.codeLens.property`; todo.md:21; src/propertyCodeLens.ts)
- **CodeLens: types.xml storage lens** — per-type "lands in table X" lens chain with reference back-scan, folded beyond 10 usages — (evidence: package.json#configuration `kbengine.codeLens.typesXml`; todo.md:20; src/languageProviders.ts `TypesXmlCodeLensProvider`)
- **Inlay hints: def-declared data types** — `self.<property>` access sites show the types.xml data type inline — (evidence: package.json#configuration `kbengine.inlayHints.typeData`; todo.md:25; src/typeInlayHints.ts)
- **entities.xml validation** — duplicate entity names get a warning (engine silently merges) plus a Utype list-order hover — (evidence: todo.md:33; src/entitiesXmlAnalysis.ts)
- **Cross-file inheritance checks** — same-name checks across the inheritance chain; Interfaces loading semantics aligned to the engine — (evidence: todo.md:65, todo.md:66; src/defAnalyzer.ts `collectInheritedNames`)
- **Python navigation (F12 / rename / call hierarchy)** — owner-aware navigation with C3-MRO and mixin composition-root resolution, `kbengine.python.enableMroJump` toggle — (evidence: package.json#configuration `kbengine.python.enableMroJump`; src/languageProviders.ts, src/pythonClassIndex.ts, src/entityMapping.ts)
- **Database schema view** — entity/component/ARRAY child-table schemas rendered read-only from def analysis, with property→table jump and F12 support — (evidence: package.json#contributes.commands `kbengine.database.open`; todo.md:124, todo.md:133; src/databaseSchema.ts)
- **SQL templates** — per-table full SELECT, property-column SELECT and child-table JOIN statements, honoring a configurable table prefix — (evidence: todo.md:126; package.json#configuration `kbengine.db.tablePrefix`; src/databaseSchema.ts `renderTableSqlLines`)
- **MySQL drift check (read-only)** — compares code-side schema against the real database; missing/extra/type-mismatched columns reported, SELECT-only whitelist plus session read-only — (evidence: package.json#contributes.commands `kbengine.database.checkDrift|checkAllDrift`; todo.md:125; src/databaseDrift.ts)
- **Database simulation & export** — simulated table structures exportable as JSON/Markdown — (evidence: package.json#contributes.commands `kbengine.database.simulate|exportSimulation`; todo.md:71; src/databaseSimulator.ts)

## Type Stubs & Managed Dir

- **KBEngine.pyi API stub export** — built-in KBEngine Python API index exported as a stub for Pylance; silent auto-export on activation, content-identical zero-write, manual command — (evidence: package.json#configuration `kbengine.python.stubExport`; package.json#contributes.commands `kbengine.python.exportStubs`; todo.md:54; src/pythonStubExport.ts, src/kbeModuleIndex.ts)
- **kbe_types per-file Python stubs** — types.xml custom types (FIXED_DICT→TypedDict, ARRAY, aliases with dependency-ordered emission) exported as per-file `.pyi` with alias resolution — (evidence: package.json#contributes.commands `kbengine.python.exportTypeStubs`; todo.md:37; commits c445f8a, bfaff30; src/pythonTypeStubs.ts)
- **Automatic stub regeneration on types.xml change** — didChange/didCreate/didDelete watchers silently re-export the type stubs — (evidence: todo.md:35; src/pythonTypeStubs.ts `setupTypeStubRegeneration`)
- **entity_types.pyi entity stubs** — per-entity type declarations for def-referenced custom types, wired into activation and entity mapping refresh — (evidence: todo.md:136; src/entityTypeStubs.ts)
- **Configurable stub directory** — `kbengine.python.stubDir` setting > `KBENGINE_STUB_DIR` env var > default `.kbengine/stubs`; user-authored `.pyi` treated as user assets and never overwritten — (evidence: package.json#configuration `kbengine.python.stubDir`; todo.md:42; src/pythonStubExport.ts)
- **python.analysis.extraPaths wiring** — discovered KBEngine scripts roots written at WorkspaceFolder level; only its own segment is managed, user entries untouched — (evidence: package.json#configuration `kbengine.python.extraPathsSync`; package.json#contributes.commands `kbengine.python.syncExtraPaths`; todo.md:55; src/pythonExtraPaths.ts)
- **Configurable managed directory** — kode-managed directory (default `.kbengine`, hosts debug.json and stubs) is renamable via `kbengine.managedDir` with auto-rebuild on rename — (evidence: src/managedDir.ts; commit c69517e; src/extension.ts watcher)

## Debug & Run

- **Quick actions (config-driven execution)** — `command`/`script`/`http` backends defined in `.kbengine/debug.json` `quickActions`, run from the Servers view title bar and def/Python/XML editor title bars — (evidence: todo.md:86; package.json#contributes.commands `kbengine.quickActions.*`; src/quickActions.ts, src/quickActionConfig.ts)
- **First-run script scan** — one-level `.bat` scan registers start/stop and data-import scripts as quick actions, never touching manual entries — (evidence: package.json#contributes.commands `kbengine.quickActions.scanScripts`; todo.md:11, todo.md:86; src/quickActionScanner.ts)
- **debug.json auto-bootstrap** — missing `.kbengine/debug.json` is scaffolded as a commented JSONC skeleton with `${workspaceFolder}` examples and a scanned `quickActions` section; existing config never overwritten — (evidence: todo.md:40; src/debugConfigBootstrap.ts)
- **debug.json JSON Schema validation** — inline schema contributed for `**/.kbengine/debug.json` flags required fields directly in the editor — (evidence: package.json#contributes.jsonValidation; todo.md:53; src/debugJsonSchema.ts)
- **Automatic hot reload** — file watchers trigger a named quick action with debounce, off by default — (evidence: package.json#configuration `kbengine.hotReload.*`; todo.md:52; src/hotReload.ts)
- **Debug/launch configs** — start debugging, attach local/remote (debugpy connect), generate/update launch.json — (evidence: package.json#contributes.commands `kbengine.debug.start|attach|attachRemote|createConfig|updateLaunchJson`; package.json#configuration `kbengine.debug.remoteTargets`; src/debugConfig.ts)
- **Server lifecycle** — start/stop/restart components (auto-start list default machine/logger/dbmgr) through a unified ProcessManager — (evidence: package.json#contributes.commands `kbengine.server.start|stop|restart`; package.json#configuration `kbengine.autoStart`; todo.md:148; src/processManager.ts, src/serverManager.ts)
- **Telnet panel** — component telnet probing, password handshake, incremental-output webview, command whitelist (`:quit` always refused), disconnect keybinding — (evidence: package.json#contributes.commands `kbengine.telnet.*`; package.json#contributes.keybindings; package.json#configuration `kbengine.telnet.*`; todo.md:117; src/telnetService.ts, src/telnetClient.ts)
- **HTTP quick requests** — configurable request list with `${module}` template variable resolved by `__init__.py` package boundaries — (evidence: package.json#contributes.commands `kbengine.httpRequest.run|httpRequests.run`; package.json#configuration `kbengine.httpRequests`; src/httpRequests.ts, src/httpRequestService.ts)
- **Config discovery & final-config view** — auto-discovery of engine config (convention paths, memory, deep scan), synthesized read-only `kbengine-final.xml` view with auto-refresh — (evidence: package.json#contributes.commands `kbengine.config.showFinal|kbengine.discovery.report`; package.json#configuration `kbengine.showFinalConfigOnOpen|autoRefreshFinalConfig`; todo.md:73, todo.md:76, todo.md:77; src/workspaceDiscovery.ts, src/serverConfigMerge.ts)
- **VS Code official variable substitution** — `${workspaceFolder}`, `${env:NAME}` etc. resolved by one shared implementation across config paths and quick actions — (evidence: todo.md:39; src/variableSubstitution.ts)

## Monitoring & SDK

- **Server monitoring panel** — webview visualizing server performance and status metrics — (evidence: package.json#contributes.commands `kbengine.monitoring.show`; src/monitoringCollector.ts, src/monitoringWebView.ts)
- **Log viewer & collector** — log viewer webview with auto-connect on server start, clear/export, incremental batched push with entry cap — (evidence: package.json#contributes.commands `kbengine.logs.showViewer|connect|disconnect|clear|export`; package.json#configuration `kbengine.logAutoConnect|maxLogEntries|loggerPort`; src/logHub.ts, src/logWebView.ts, src/logCollector.ts)
- **Raw log ERROR scan** — aggregates ERROR/CRITICAL entries by component + normalized signature across selected files/folders, click-to-source — (evidence: package.json#contributes.commands `kbengine.logs.scanErrors`; todo.md:51; src/logErrorScan.ts)
- **Client entity SDK generation** — TypeScript & C# client SDKs from entities.xml registration order, client-visible properties only, FIXED_DICT companion files, no-overwrite default — (evidence: package.json#contributes.commands `kbengine.clientSdk.generate`; package.json#configuration `kbengine.clientSdk.outputDir`; todo.md:50; src/clientSdkGenerator.ts)
- **Entity dependency graph** — inheritance/reference dependency graph with text-form Parent edges — (evidence: package.json#contributes.commands `kbengine.dependency.show`; todo.md:68; src/entityDependency.ts, src/entityDependencyWebView.ts)
- **Def architecture flow graph** — webview of client→base/cell method calls and property sync with Markdown/SVG/PNG export — (evidence: package.json#contributes.commands `kbengine.flow.show`; todo.md:60; src/entityFlowGraph.ts, src/entityFlowWebView.ts)
- **Network packet structure generation** — simulated message/packet structure with alias-ID collision reporting, machine JSON + human Markdown output — (evidence: todo.md:72; src/messageTable.ts, src/kbengineProtocol.ts)
- **Discovery report** — visible discovery/locate report on demand and on activation, copyable output — (evidence: package.json#contributes.commands `kbengine.discovery.report`; todo.md:76)

## Editor Basics

- **types.xml injection grammar** — semantic coloring of builtin types, custom type references, ARRAY/FIXED_DICT keywords and implementedBy values injected into XML — (evidence: package.json#contributes.grammars (`injectTo: ["text.xml"]`); todo.md:102)
- **Snippets for kbengine-def / xml / python** — bundled snippet lists per language — (evidence: package.json#contributes.snippets; snippets/)
- **Snippet generation from selection** — turns editor selection text into a workspace-level custom snippet file — (evidence: package.json#contributes.commands `kbengine.snippets.generateFromSelection`; src/snippetGenerator.ts)
- **11 KBEngine color themes** — Monokai, One Dark, Dracula, GitHub Light, Solarized Light/Dark, Nord, Gruvbox Dark, Catppuccin Mocha, VS Dark+/Light+ — (evidence: package.json#contributes.themes)
- **KBEngine Explorer activity bar** — dedicated view container with entity/explorer tree providers — (evidence: package.json#contributes.viewsContainers, package.json#contributes.views; src/explorerProviders.ts)
- **Def/Python code generator** — template-based .def + Python skeleton generation with entities.xml registration — (evidence: package.json#contributes.commands `kbengine.generator.wizard|templates`; package.json#configuration `kbengine.generator.*`; src/codeGenerator.ts, src/generatorForms.ts)
- **Form wizard** — one-shot generation of proxy/space/component/fixed-dict skeletons — (evidence: package.json#contributes.commands `kbengine.generator.formWizard`; todo.md:44)
- **Def renaming** — rename provider resolving link paths across def files — (evidence: src/defRenamer.ts; src/languageProviders.ts `KBEngineRenameProvider`)
- **Call hierarchy** — prepare/callers/callees for def and Python symbols — (evidence: src/languageProviders.ts `KBEngineCallHierarchyProvider`)

## Settings

All extension settings (evidence: package.json#contributes.configuration for contributed keys; src/managedDir.ts for the runtime-read key).

| Setting | Default | Purpose |
| --- | --- | --- |
| `kbengine.db.tablePrefix` | `""` | Database table name prefix (empty = engine default tbl_); schema view and SQL templates substitute from the same source |
| `kbengine.enableDiagnostics` | `true` | Master switch for real-time KBEngine diagnostics |
| `kbengine.enableStructureDiagnostics` | `true` | Structured .def validation (duplicates, tag placement, missing fields) |
| `kbengine.diagnostics.checkUnknownTypes` | `true` | Diagnose unknown KBEngine types |
| `kbengine.diagnostics.checkUnknownFlags` | `true` | Diagnose unknown Flags values |
| `kbengine.diagnostics.checkUnknownDetailLevels` | `true` | Diagnose unknown DetailLevel values |
| `kbengine.diagnostics.checkDuplicateDefinitions` | `true` | Diagnose duplicate property/method definitions |
| `kbengine.diagnostics.checkMissingPropertyFields` | `true` | Diagnose properties missing Type/Flags or duplicate definition fields |
| `kbengine.hover.showTagDocs` | `true` | Show .def tag documentation on hover |
| `kbengine.hover.showValueDocs` | `true` | Show docs for type/Flags/DetailLevel values on hover |
| `kbengine.hover.showSymbolDocs` | `true` | Show summaries for custom property/method names on hover |
| `kbengine.hover.typeStorage` | `true` | Show database storage info of types.xml custom types on hover |
| `kbengine.hover.implementedBy` | `true` | Show script implementation location (Implemented-By) on def method hover |
| `kbengine.hover.entityRegistration` | `true` | Show entities.xml registration info (Utype/list position) on hover |
| `kbengine.hover.defChain` | `true` | Show def property/method declaration chain (file & section origins) on hover |
| `kbengine.hover.eventStats` | `true` | Show event constant registration/listening stats on hover |
| `kbengine.hover.serverConfig` | `true` | Show kbengine.xml server config values and explanations on hover |
| `kbengine.codeLens.rpc` | `true` | RPC method CodeLens at def-declared methods in Python implementation scripts |
| `kbengine.codeLens.eventCallbacks` | `true` | Event callback/subscription CodeLens in Python scripts |
| `kbengine.codeLens.property` | `true` | Property CodeLens at self.<property> access sites (reverse jump to def) |
| `kbengine.codeLens.typesXml` | `true` | Database storage lens chain on types.xml type declaration lines (reference back-scan) |
| `kbengine.inlayHints.typeData` | `true` | Inline def-declared types.xml data types at self.<property> sites |
| `kbengine.entityDefsPath` | `"scripts/entity_defs"` | Default path for entity definition files |
| `kbengine.entitiesXmlPath` | `"scripts/entities.xml"` | Default path for entities.xml |
| `kbengine.binPath` | `"${workspaceFolder}/../kbe/bin/server"` | KBEngine server binaries path; supports ${workspaceFolder} and ${env:VAR} |
| `kbengine.assetsRoot` | `""` | KBEngine assets root (res/server/kbengine.xml + scripts/ underneath); empty = convention-path and deep-scan auto-discovery |
| `kbengine.jumpLog` | `false` | Navigation decision-path logging to the KBEngine Navigation output channel (off = zero cost) |
| `kbengine.showFinalConfigOnOpen` | `true` | Auto-open the synthesized read-only final-config view on activation when the engine default config is locatable |
| `kbengine.autoRefreshFinalConfig` | `true` | Recompute the open final-config view when engine/component kbengine.xml files change |
| `kbengine.debug.remoteTargets` | `[]` | Remote debug target list offered by Attach to Remote Component (debugpy connect, no pathMappings written) |
| `kbengine.autoStart` | `["machine", "logger", "dbmgr"]` | Components auto-started (default machine/logger/dbmgr) |
| `kbengine.loggerPort` | `20022` | KBEngine Logger port (default 20022) |
| `kbengine.logAutoConnect` | `true` | Auto-connect the log collector when starting the server |
| `kbengine.maxLogEntries` | `10000` | Maximum number of log entries kept |
| `kbengine.generator.defOutputPath` | `"scripts/entity_defs"` | Code generator: output directory for .def files |
| `kbengine.generator.pythonOutputPath` | `"scripts"` | Code generator: output directory for Python files |
| `kbengine.generator.generatePython` | `true` | Code generator: whether to also emit Python files |
| `kbengine.generator.registerInEntitiesXml` | `true` | Code generator: whether to register generated entities in entities.xml |
| `kbengine.clientSdk.outputDir` | `"scripts/client_entities"` | Client entity SDK output directory (relative to workspace root; language chosen in-command; no overwrite by default) |
| `kbengine.telnet.host` | `"127.0.0.1"` | Telnet probe target host |
| `kbengine.telnet.port` | `0` | Telnet probe port (0 = fall back to component kbengine.xml <telnet_service>; nothing shown when telnet is off in both) |
| `kbengine.telnet.password` | `""` | Telnet login password (handshake only, never logged; falls back to component/engine defaults; absent = status stays 'port open, no password') |
| `kbengine.telnet.enableCommands` | `[]` | Whitelist of sendable telnet commands (exact or prefix match; :quit always refused) |
| `kbengine.telnet.configXmlPath` | `""` | Optional component kbengine.xml path for telnet port/password fallback (supports ${workspaceFolder}) |
| `kbengine.telnet.probeIntervalSeconds` | `5` | Telnet port probe poll interval in seconds (low-frequency) |
| `kbengine.httpRequests` | `[{"name": "热更新(示例)", "url": "http://127.0.0.1:8000/api/ho...` | HTTP quick request list; ${module} resolved by __init__.py package boundaries |
| `kbengine.python.extraPathsSync` | `true` | Auto-write discovered KBEngine scripts roots into python.analysis.extraPaths (own segment only) |
| `kbengine.python.stubExport` | `true` | Auto-export the built-in KBEngine Python API index as a KBEngine.pyi stub |
| `kbengine.python.stubDir` | `""` | .pyi stub directory (empty = managed default .kbengine/stubs; configured dir scanned, user .pyi never overwritten; supports VS Code variables) |
| `kbengine.python.enableMroJump` | `true` | Cross-file C3-MRO and mixin composition-root navigation for Python (off = current-file inheritance + def fallback only) |
| `kbengine.hotReload.enabled` | `false` | Auto-trigger a quick action on file changes (default off to prevent accidents) |
| `kbengine.hotReload.actionName` | `""` | Quick action name to trigger (must exist in .kbengine/debug.json quickActions) |
| `kbengine.hotReload.globs` | `["**/*.py"]` | File glob patterns to watch (one watcher per pattern) |
| `kbengine.hotReload.debounceMs` | `500` | Debounce milliseconds before triggering (0 = no debounce) |
| `kbengine.managedDir` | `` `.kbengine` `` | Name of the kode-managed directory hosting debug.json and stubs (runtime-read key, not in contributes; auto-rebuild on rename) |

