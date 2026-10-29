# Feature Overview


## Language Features

- `.def` syntax highlighting (built-in XML grammar delegation + engine semantic coloring)
- Completion for types, Flags, DetailLevel
- Hover for tags, values, custom symbols
- Navigation between `entities.xml` and `.def`
- Manifest ordinal on `entities.xml` registration hover (batch 147, the `**Utype**` line: the engine assigns utype in `entities.xml` list order, so the ordinal is the first-occurrence position)
- Merged def-chain hover (batch 148, closing source-analysis D5): hovering the root-level `<Parent>` element in a `.def` presents the def's inheritance closure in three facets — the recursive Parent chain, the flattened `interfaces/` list, and the `components/` hookup — aligned with the engine's merge semantics; missing def files for parents/interfaces/components are stated as such, and cycles are truncated by a visited set and marked (the engine's loadParentClass has no cycle guard; kode does not copy that)
- Entity reference navigation inside `.def`
- Bidirectional Python ↔ `.def` navigation
- RPC method markers (functions in Python implementation scripts that hit def method declarations get a one-line clickable CodeLens jumping back to the def declaration)
- Per-feature switches for language features (batch 154): each of the four CodeLens kinds (RPC markers, event callbacks, property markers, the `types.xml` storage lens chain) and the six hover kinds (custom-type storage, `implementedBy` backlink, entity registration, def chain, event stats, server config fields) gets its own `kbengine.*` switch, all default on with no master switch; CodeLens toggles take effect immediately
- Python property type inlay hints (batch 154): `self.<property>` access sites inline the `types.xml` data type declared in the def, resolved through the same index as property F12; `self.base/cell/client` RPC call sites inline the declared parameter types (`: type`, type-only — `.def` `<Arg>` carries no parameter names; declared args only, section-gated), controlled by `kbengine.inlayHints.typeData` (inlay hints have no change event, so a toggle takes effect on the next render)
- `.def` property/method F2 rename (same-file declaration + descendant def restatements, see the boundary note on the language page)

## Diagnostics

- Unknown type check
- Unknown Flags check
- Unknown DetailLevel check
- Duplicate definition check
- Missing `Type` / `Flags` check
- Duplicate entity registration check in `entities.xml` (batch 147): the engine silently merges same-name entries, keeping the first one, so later entries never take effect; kode flags them with a warning, gated by the `kbengine.enableDiagnostics` master switch

## Tool Panels

- Entity explorer
- Server control panel
- Log viewer
- Monitoring panel
- Entity dependency graph
- Entity architecture flow diagram

Notes:
the log viewer has not completed the official logger watcher protocol adaptation.
When the watcher does not respond, the monitoring panel keeps only the base status returned by machine.

## Raw Log ERROR Scan (inventory G6)

- The `Scan Raw Log Errors` command picks raw log files or a folder (a folder scans one level of `.log`/`.txt`/`.out`, sorted by name and deduped); the same parser the log panel uses picks out the `ERROR`/`CRITICAL` lines
- Aggregation is by "component + normalized signature" (numbers folded to `N`, whitespace collapsed, signature truncated to 160 characters); the panel shows count / level / component / signature / most recent time, clicking a row opens that line in the source file, and "Rescan" reruns over the same file set
- Does not depend on the logger watcher protocol: this path keeps working when the logger channel is not connected; 64MB cap per file, and an oversize or unreadable file is recorded as a readError without interrupting the rest

## Telnet Probing and Session Integration

- Telnet-related content shows only when telnet is explicitly enabled (an explicit port in the settings, or a `<telnet_service>` section in kbengine.xml); with neither configured there is no probing and no display — the status light, the standalone tree view, and the panel command entries are all hidden. The engine defaults do contain a `<telnet_service>` section, but defaults only provide value fallbacks and do not switch telnet on by themselves
- Status bar and server control panel status light: connected / enabled·no password / password rejected / not enabled / not configured
- Target resolution chain: kode settings (`kbengine.telnet.host/port/password`) → the component `kbengine.xml` `<telnet_service>` section (specified via `kbengine.telnet.configXmlPath`; when unspecified, `kbengine.assetsRoot/kbengine.xml` first, then convention paths probed at the workspace root: `kbengine.xml`, `res/server/kbengine.xml`, `assets/res/server/kbengine.xml`) → the engine `kbengine_defaults.xml` (inferred via `kbengine.binPath`). Port and password each take the first non-empty value in this order; `.kbengine/debug.json` does not participate in telnet probing
- Probing defaults to one round per 5 seconds, 1.5s timeout per port, sockets destroyed after each probe
- When the port is up, handshake login happens automatically; the password goes over the socket only and never into logs
- Panel command input goes through a whitelist plus built-in read-only shortcuts; `:quit` is always rejected
- A disconnected status can flip back and reconnect; a dropped session does not crash the panel

## Debugging Support

- The debug config reads only the workspace `.kbengine/debug.json`: `telnetHost`/`telnetPort`/`telnetEnableCommands` serve only the `Start Debugging` prompt wording, `pathMappings` is used to generate launch.json; telnet probing/panel/status light follow the three-layer chain above and do not read this file
- The generated launch config is a `debugpy` attach form; local attach has the extension list local processes (matches on component names pinned and marked ✓), and selecting one assembles the config by PID — no more hand-typing PIDs
- Remote attach (`kbengine.debug.attachRemote`) targets come from the setting `kbengine.debug.remoteTargets`, connecting in debugpy `connect` mode straight to the remote debugpy listening port
- Debug model: first send the enable-debugging command into the component via telnet, then attach to the target process
- Two attach modes (IDE-PDBG-001): a component with a configured `debugpyPort` (> 0, optional companion `debugpyHost`) in `.kbengine/debug.json` always attaches in port mode — `Start Debugging` skips the telnet briefing and dials `debugpyHost:debugpyPort` (default host `127.0.0.1`) in debugpy `connect` form, and `Attach to Component` follows the same dispatch; a component without a configured port asks once which mode to use — port mode (connect; with no explicit port the per-component table applies: baseapp 5678 / cellapp 5679 / loginapp 5680 / dbmgr 5681 / logger 5682, otherwise 5678) or process attach mode (the local process picker assembling the config by PID) — and the choice is remembered in workspace state so later attaches go straight through; the first-time prompt's "清除记住的选择" aborts this attach without remembering, and `kbengine.debug.resetAttachMode` (palette: `Reset Debug Attach Mode Choice`) clears the memory so the next attach asks again
- Port mode expects a listener: engine processes never start a debugpy listener on their own — the embedded Python must reach a `debugpy.listen(port)` (or equivalent bootstrap) before the IDE can connect. kode ships three ready-made paths there: `kbengine.debug.autoDebugpy` injects `debugpy.listen` through the component's telnet after start-up, the opt-in `kbengine.debug.waitAtStartup` inserts a `listen` + `wait_for_client` bootstrap at the earliest Python point, and `kbengine.python.debugpySync` copies the debugpy package into `<assets>/scripts/common/debugpy` so `import debugpy` resolves inside the engine
- Port-mode pre-probe (IDE-PDBG-002): before connecting, kode probes the debugpy port over TCP (1.5 s, same pace as telnet probing); an open port attaches straight away with zero extra dialogs, while a closed port names the cause — nobody listening / network timeout / host unresolvable — and, when the local interpreter chain lacks debugpy (or its version is too old), offers a one-click install (`<interpreter> -m pip install -U debugpy`) or a manual guide; an install failure reports the pip exit code and output tail honestly, and after a successful install the port is re-probed — installing the package alone never opens the port, so a still-closed port says exactly that (get the engine listening, then attach again) instead of attaching into a void
- py-spy profiling entry (IDE-PDBG-003): the Servers tree carries a `$(pulse)` icon right after the debug attach icon; picking a component (tree node or picker) and a process (the existing picker, component matches pinned ✓) runs `py-spy dump --pid <pid> --nonblocking` and writes the Python call stacks to the `KBEngine py-spy` output channel — nonblocking never pauses the target process. py-spy missing locally asks once and installs via `<interpreter> -m pip install -U py-spy` (failures honest, no retry loop); permission failures carry the ptrace guidance: py-spy reads the target stack via ptrace, so Linux needs `kernel.yama.ptrace_scope=0` (or sudo/cap), containers need `--cap-add=SYS_PTRACE`, Windows needs an elevated or same-user session
- Remote servers view and dispatch (IDE-PDBG-004): the `Remote Servers` view (KBEngine explorer) lists the hosts from `~/.ssh/config` — HostName/User/Port/ProxyJump parsed per Host block, wildcard and negated aliases hidden — plus manually added hosts, with `本地(直接执行)` always first and selected by default; picking a node (or the palette `Select Remote Server`) stores the choice in workspace state and every debug / py-spy dispatch follows the precedence component `sshHost` > `debug.defaultSshHost` > view selection > local. On a remote target, port-mode attach opens an `ssh -N -L` tunnel (BatchMode, jump chain and port from the config) and connects to `127.0.0.1:<localPort>`, tearing the tunnel down right after the attach; py-spy probe/install/dump all run over `ssh <host> -- …`. Aliases absent from the config connect by their bare name (ssh semantics); `Include` directives are not expanded — hosts living in included files don't show up in the view. A tunnel or host that never comes up fails honestly (exit / not-ready reason naming BatchMode password-free login), never a fake attach
- Remote process picker alignment (IDE-PDBG-005): on a remote target the process list comes from `ssh <host> -- ps -axo pid=,comm=` and the picker is the same face as local — component-name matches pinned ✓ on top, description carrying the PID; a listing that cannot be fetched (ssh exit / timeout / unreachable) reports the host and cause honestly and opens no picker — it never falls back to the local list pretending it is the remote one

- In-editor validation (batch 136 G3): kode ships a JSON Schema for `.kbengine/debug.json` (`contributes.jsonValidation` matching `**/.kbengine/debug.json`), so the VS Code JSON extension flags wrong types, `telnetPort` written as a string, a `pathMappings` entry missing `localRoot`/`remoteRoot`, or a `method` outside the whitelist before you save; validation is a hint only — the parser still drops bad entries and falls back per field as before
- Scaffolded when missing (batch 143): when `.kbengine/debug.json` is absent from the workspace, activation creates `.kbengine/` in the effective working directory and writes an annotated skeleton; the skeleton is written as JSONC (`//` and block comments allowed, same convention as `tsconfig.json`) and kode strips comments before parsing, so your own comments never break config loading. **An existing file is never overwritten**; if the directory is not writable it only reports that plainly on the "KBEngine 配置" output channel, leaving every other capability intact

Notes:
KBEngine components are C++ processes with embedded Python runtimes; debugging is attach-based — there is no "extension launches a Python script" form.

## Final Config View

- Synthesizes the final effective configuration per the engine's loading rules: load the engine default `kbengine_defaults.xml` first, then override with the component `kbengine.xml` (child keys aligned by name); a read-only virtual document `kbengine-final.xml`, never written to disk
- Three entries: the "Final Config" node in the sidebar Config view, the `Show Final Server Config` command, and an automatic background open after activation (`kbengine.showFinalConfigOnOpen`, default on)
- Auto-recomputed after defaults or the component `kbengine.xml` is saved (`kbengine.autoRefreshFinalConfig`, default on); hovering a field shows what it does
- Layering rules and a before/after comparison: the "server config three layers" section in the [configuration reference](./configuration.md)

## Property → Database Hints and the Schema View

- Persistent property hovers append a "database storage" line: the full `` `db`.`table`.`column` `` name + the engine DDL fragment (column type, `not null`, `DEFAULT`) + concrete value constraints (integers per MySQL ranges, varchar per the parsed length; default 255 when `<DatabaseLength>` is absent, `entity_table_mysql.cpp:1829-1833`); same-DDL columns merge into one line (a vector's three columns as one)
- ARRAY / component properties are not in the main table: the hover explains which child table the data lives in and the `parentID` relation, and F12 lands on the child table row in the schema (child tables carry a `父表：` note)
- Connection details are read straight from the engine's own config (nothing hand-filled): the synthesized `<dbmgr><databaseInterfaces><default>` (engine defaults + component `kbengine.xml` same-key override), port `0` falls to the MySQL default 3306 (`db_interface_mysql.cpp:166-167`); the password is read only when `<encrypt>false</encrypt>` (plaintext config) and never displayed; `encrypt=true` RSA ciphertext is not deciphered. Read values are cached per "workspace + binPath" and re-read whenever `kbengine*.xml` or the config changes
- Schema view (`kbengine.database.open`): Chinese-label rendering (batch 133). The header gives the entity name, `存储引擎`, `定义文件`, and a `表: N 张 · 列: M（其中 .def 声明 K）` overview, plus `数据库: 库名@host:端口` when the config is readable, then a "how to read this" legend (`tbl_` / `sm_` prefixes, engine columns not from def, `parentID` relation, flag meanings, SQL paste usage); each table is tagged with `表类型` (entity table / component table / array child table), `定义来源` (workspace-relative path), and `父表：`; fields split into "engine columns (created automatically by the engine, no `.def` declaration needed)" (`id` / `autoLoad` / `parentID` / the six position-and-orientation columns, each with fixed semantic annotations) and "property columns (declared in `.def`)"; property column row ends carry `← 文件:行 <属性>` pointing at the def origin; a table with only engine columns honestly notes `属性列: 无（本表只有引擎列，没有 .def 声明的数据列）`; each table ends with three pasteable SQL lines (full SELECT, a `SQL(属性列)` with only def property columns, and a child table's `SQL(子表 JOIN)` joining the parent via `parentID` with a `LEFT JOIN` preserving empty-element property rows); all carry the database/table prefix and backtick escaping; when the database name is unreadable it degrades to table-level full names, still valid
- The table prefix is overridable: the setting `kbengine.db.tablePrefix` (default empty = engine default `tbl_`), substituted in the same source for table names and the three SQL templates; ARRAY child table hovers likewise give a pasteable JOIN
- types.xml type forms and reference back-scan (batch 134): type declaration name hovers append the "database form" (builtin lands as a main-table single column with its type, FIXED_DICT flattens into columns without a table, ARRAY becomes a `tbl_<Entity>_<Property>` child table with one recursive level of element columns, unresolved types state plainly that engine loading will fail); above each declaration line a CodeLens back-scans the real reference sites (`Hero.itemId → tbl_Hero.sm_itemId`), clicking opens that entity's schema view at the matching column, folding into a count lens beyond 10 sites, invalidated and rescanned when `.def`/`types.xml`/`entities.xml` change; back-scan sites come from the schema snapshot (same engine semantics as the rendering), no separate persistence rules invented
- Database drift check (`kbengine.database.checkDrift` / `checkAllDrift`): compares missing tables / columns, extra columns, type / nullability / default / index differences, and residual tables; checks one or all workspace entities. Connection info comes from engine config (`encrypt=false` plaintext password); queries and sessions remain read-only; connect and each query run under `kbengine.databaseQueryTimeoutMs` with a cancellable progress notification — timeout or cancel returns with that reason and releases the connection (the table preview and schema impact preview commands run under the same deadline and cancel). Schema impact preview (`kbengine.database.previewSchemaImpact`) diffs one entity's real table structure against the def-derived virtual schema and prints the added / removed / type-changed list a sync by the current def would cause — read-only, no DDL anywhere. Real drift runs save evidence keyed by engine version (`kbengine.database.showDriftEvidence` re-views it; an undetectable version stays unknown — no compatibility claim). See [Database Drift Check](./database-drift-check.md)

## Database Simulation

- Simulates table creation and row data on top of a database schema snapshot: a `.dbsim` virtual document shows DDL, simulated row JSON, INSERT statements, and the engine difference list together
- DDL aligns item by item with the engine's MySQL persistence implementation (`tbl_` prefix, `parentID` child column, `sm_autoLoad`, per-type column types, `(@DATALEN@)` empty-width stripping, `ENGINE=InnoDB`); sources in [Database Simulation](./database-simulation.md)
- Row validation follows strict engine semantics: any failed check rejects the whole statement; DELETE cascades child tables recursively; the UNIQUE pre-check is something the simulator does beyond the engine and is registered honestly
- Entries: `Simulate Entity Database` (entity inferred from the active `.def` when no name is passed) and `Export Entity Database Simulation` (export as Markdown)

## Config Auto-Discovery

- A clean workspace needs zero configuration for core features (open a `.def` → entity explorer / dependency graph / flow diagram / property panel / database schema / hovers)
- Discovery chain: explicit config → convention layouts → bounded deep scan (depth 7 / 20k entries, pruning node_modules/.git etc.) → a unique hit is used; multiple candidates pop a quick pick once during activation and remember per workspace
- The server assets root `kbengine.assetsRoot` follows the same chain (batch 128): the original value is validated with the engine-loading probe `res/server/kbengine.xml`; on failure it goes through the convention chain (workspace root, assets/, server_assets/) → remembered choice → deep-scan unique hit fallback; telnet probing and the final config view benefit in sync
- Pure discovery, no settings: `types.xml`, `messages_fixed(_defaults).xml`, and the engine defaults' source-root fallback; sub-paths derived from the def root (interfaces/components/user_type) do not enter the settings
- Location failures are no longer silent: the `kbengine.discovery.report` command lays out the discovery result key by key in the OUTPUT panel (final chosen value and source, explicit-config existence, convention-chain hits/misses, deep-scan hits, remembered choices, deep-scan truncation markers), with per-item remediation advice; the whole report can be copied back to maintainers
- See the "path-like config auto-discovery" section and the full comparison table in the [configuration reference](./configuration.md)

## Python Ecosystem Wiring (inventory G1 / G2)

- extraPaths wiring (batch 136 G1): writes the KBEngine scripts roots discovered in the workspace into `python.analysis.extraPaths` (workspace-folder level), managing only the segment this extension wrote — paths you typed yourself are never touched; nothing is written when nothing changed, and a workspace with no discoverable root is skipped silently. The `Sync Python Extra Paths` command reruns it manually; activation syncs once with zero prompts (`kbengine.python.extraPathsSync` on by default, disableable)
- `.pyi` stub export (batch 136 G2): exports the built-in KBEngine Python API symbol index (same source as completion/hover/navigation) as a real `KBEngine.pyi` file — virtual stub documents are invisible to the Python extension, and only a real file plus the extraPaths wiring resolves `import KBEngine`; identical content is a zero-write, a stale stub is rewritten, activation does it once silently, and the `Export KBEngine Python Stubs` manual entry chains one extraPaths sync after a successful export
- Configurable stub directory (batch 142): `kbengine.python.stubDir` resolves in three tiers — setting > `KBENGINE_STUB_DIR` environment variable > the default convention `.kbengine/stubs`. The default directory is managed by kode (refreshed by content comparison); **a directory you specify is scan-only**: any `.pyi` already in it counts as your asset and is never overwritten, kode only generates when there is none, and an unreadable directory is reported plainly instead of being written blindly
- types.xml type stubs (def-pyi-stubs §6): exports the `entity_defs/types.xml` custom types into a real `.py` module `kbe_types.py` (`FIXED_DICT` → `TypedDict`, `ARRAY` → `List[element]`, aliases → type names; aliases in dependency topological order, cycles/empty directives skipped with a stated reason) — a real module is both a Pylance type source and runtime-importable via `import kbe_types`; it shares the directory and switch with `KBEngine.pyi` (`kbengine.python.stubExport`), its deterministic content upholds the zero-write discipline, and the `Export KBEngine Python Type Stubs` manual entry chains one extraPaths sync after a successful export, and after `types.xml` lands on disk (save/create/delete) the watcher silently regenerates it

## Variable Substitution (batch 141)

- Path-like settings, the `quickActions` and `workspaceRoot` of `.kbengine/debug.json`, and `kbengine.python.stubDir` all go through one set of official VS Code variable substitution instead of each writing its own
- Supported: `${workspaceFolder}`, `${workspaceFolderBasename}`, `${file}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileDirname}`, `${fileExtname}`, `${relativeFile}`, `${relativeFileDirname}`, `${cwd}`, `${userHome}`, `${pathSeparator}`, `${env:NAME}`
- The relative-path family only yields the relative form when the file sits under some workspace root, falling back to an absolute path otherwise; unknown variables follow two policies by semantics — quick action execution fails and names the variable (a silent empty string would run the script as a fake success with an empty path), while path-like settings fall back to an empty string per the existing convention

## HTTP Quick Requests

- The `kbengine.httpRequests` list holds: name / URL template / method / headers / body / enable flag / keybinding display string
- Template variables `${module}` / `${file}` / `${line}` / `${sel}`, replaced literally without URL encoding; `${module}` is the workspace-relative module path (`entities/fight/FightAI.py` → `entities.fight.FightAI`)
- Two trigger paths: a command-palette quick pick; a keybinding for `kbengine.httpRequest.run` with `args.name` in keybindings.json fires directly
- Execution logs go to the OUTPUT panel "KBEngine HTTP 快捷请求"; failures are marked with `✗` plus an error popup

Field and variable tables in the [configuration reference](./configuration.md); command details in [Commands and Panels](./commands.md).

## Quick Actions

- The action list lives in the workspace `.kbengine/debug.json` top-level `quickActions` array (travels with the KBEngine project, not in VS Code settings, not in `launch.json`)
- Three whitelisted backend kinds: `command` (a VS Code command), `script` (a script explicitly declared in the config), `http` (a local hot-update URL written into the config); no arbitrary shell entry
- Two trigger paths: the Servers view title bar button + top-right buttons in `.def` / Python / XML editors + the command palette `Run Quick Actions`
- Actions pop a modal confirm by default; logs go to the OUTPUT panel "KBEngine 快速执行动作"; a failure pops once and keeps the exit/status code
- First-time config creation scans `.bat` / `.ps1` files in the effective config root and `assetsRoot`; scanned actions run with the script's containing directory as `cwd`. `Rescan Scripts for Quick Actions` refreshes scanned entries while preserving manual actions
- `.ps1` runs through PowerShell; script actions can optionally enable a Python venv and choose its path, or auto-discover `.venv` / `venv`
- First install scans one level of workspace-root `.bat` and `.ps1` files; all of them appear in a multi-select registration prompt (keyword lists only assign a category); canceling stops the auto-prompt for that workspace

Command details in [Commands and Panels](./commands.md); config keys and variable tables in the [configuration reference](./configuration.md).

## Auto Hot Reload (inventory G5)

- A file save / watcher event triggers the `quickActions` action named above. The gate `kbengine.hotReload.enabled` is **off by default** to avoid misfires: no file watcher is created before you turn it on, so activation behavior is unchanged; toggling it takes effect immediately, no window restart needed
- Change, create, and delete all count as save events and are merged into one execution by debounce; the trigger path skips the execution confirm, while action failures and unexpected async errors are caught and reported without an unhandled Promise rejection
- When `actionName` is empty or matches no action, the event still fires but only writes one line to the OUTPUT channel "KBEngine 快速执行动作" — no popup, no execution
- For `http` actions the real response feeds the per-target ledger: 2xx lands as delivered-unverified (or upgraded to accepted only when the body echoes the sent file verbatim under the documented receipt protocol), non-2xx lands failed naming the status; unknown bodies stay unverified. An `applied` claim needs double evidence — the receipt's sha256 digest must match the sent file content — and anything less (missing runtime protocol, unreadable content, digest mismatch, verification timeout) stays unverified with the blocking reason recorded
- A `.def` file in the batch goes through a structural gate first: serialization/RPC-parameter changes (property or method add/remove, type/flags/signature change) block the whole batch from the plain reload with a restart-required warning; comment/whitespace-only def edits and pure-Python batches send normally
- `kbengine.hotReload.showBatchSummary` rolls the whole per-target ledger up into the log channel: mixed batches show partial with every failed target named, and each target's per-file reasons stay viewable
- `kbengine.hotReload.retryFailed` re-sends only the failed targets through the real quick-action entry (confirmed-successful targets are never re-sent); it runs under a cancellable progress notification — after cancellation nothing further is sent — and a successful retry turns the ledger page through the same receipt/verification faces as the fire path
- A `.def` file in the batch goes through a structural gate first: serialization/RPC-parameter changes (property or method add/remove, type/flags/signature change) block the whole batch from the plain reload with a restart-required warning; comment/whitespace-only def edits and pure-Python batches send normally

## Dependency Graph

- Mermaid visualization
- Inheritance and `ENTITYCALL` relations
- Click-through to entity definitions from the graph
- SVG export
- PNG export

## Flow Diagram

- Method calls from the client to baseapp/cellapp and automatic property synchronization, as a Mermaid visualization
- Edge semantics annotated per property `Flags` bits, each edge listing the engine source (file:line) and the member declaration site
- Clicking a member row jumps back to its `.def` declaration
- Unexposed BaseMethods listed separately as "methods the client cannot call"
- Refresh re-reads the `def`/`entities.xml` on disk
- Exports Markdown, SVG, PNG

## Code Generation

- Entity creation wizard
- Preset templates (10: account, role, NPC, item, monster, scene, guild, team, mail, empty entity)
- Automatic `.def` generation
- Automatic Python generation
- Automatic registration into `entities.xml`
- Client entity SDK generation (generates client skeletons for entities registered in `entities.xml`; TypeScript / C# multi-select)
- Definition form wizard (batch 139, inventory G7): beyond the entity wizard, generates one form per run — proxy (a Proxy def under `proxy_defs/` whose `Parent` points at the same-named Proxy), space (registers `hasBase` + `hasCell` in `entities.xml`), component (a def under `components/`, optionally mounting a `COMPONENT` property at the end of the entity's `<Properties>` block), fixed-dict type (written into `types.xml`). Existing files are not overwritten by default; duplicate registrations and malformed structures are reported plainly rather than force-inserted

Notes:
the generator is affected by the `kbengine.generator.*` and `kbengine.entitiesXmlPath` settings; the client entity SDK by `kbengine.clientSdk.outputDir`.

## Performance Analysis

- Full-workspace `.def` static checks (the `Analyze Def Performance` command)
- Optimization suggestions written to the output panel and dropped into the problems list as diagnostics

## Snippet Generation

- Generate custom snippets from a selection (the `Generate Snippet from Selection` command)
- Snippet grammar escaping and common-indent stripping (per the editor's `tabSize` column semantics, mixed tabs/spaces keep relative levels), merged into `.vscode/kbengine-custom.code-snippets`
