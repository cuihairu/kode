# Commands and Panels


This page collects the main commands Kode exposes in VS Code, where they are entered from, and when each applies.

## Commands in the Command Palette

Open the palette with `Cmd/Ctrl + Shift + P` and search by title keyword, e.g. `Server`, `Entity`, `Log` (command titles carry no `Kode:`/`KBEngine:` prefix).

## Entity Explorer

### `kbengine.refreshExplorer`

- Title: `Refresh`
- Purpose: refresh the entity explorer list
- Entries:
  - Entity explorer title-bar button
  - Command palette

### `kbengine.entity.open`

- Title: `Open Entity Definition`
- Purpose: open the `.def` file of a given entity
- Entries:
  - Clicking an entity item in the entity explorer
  - Command palette

### `kbengine.entity.method.open`

- Title: `Open Entity Method`
- Purpose: open a method symbol's definition or Python implementation
- Entries:
  - Clicking a method entry in the entity explorer
  - Command palette

### `kbengine.database.open`

- Title: `Open Database Schema`
- Purpose: open the virtual document of the database table structures behind an entity's properties (rendered with Chinese labels: the header gives a `数据库: 库名@host:端口` connection line and a 「读图方式」 (how to read) legend; each table is tagged `表类型` / `定义来源` and split into "engine columns (created automatically by the engine, no `.def` declaration needed)" and "property columns (declared in `.def`)" groups, property-column rows ending in `← 文件:行 <属性>` marking the def landing point; each table ends with SQL that can be pasted straight into an external MySQL client: a full-column SELECT, a `SQL(属性列)` containing only def property columns, and for child tables a `SQL(子表 JOIN)` joining the parent by `parentID`; the table prefix can be overridden via `kbengine.db.tablePrefix`)
- Entries:
  - Activity bar KBEngine Explorer → **Entities** view → expand an entity → `Database` group → click a table or field entry
  - Command palette: `Open Database Schema` run without arguments infers the entity from the active `.def`; with no active `.def` it shows 「请先打开一个实体 .def 文件」 (open an entity .def file first) instead of silently doing nothing

### `kbengine.database.simulate`

- Title: `Simulate Entity Database`
- Purpose: simulate table creation and row data on top of the schema, opening the database simulation virtual document (DDL, simulated-row JSON, INSERT statements, and engine-difference notes in one view); without an entity name it infers from the active `.def` file
- Entries:
  - Command palette
- See also: [Database Simulation](./database-simulation.md)

### `kbengine.database.exportSimulation`

- Title: `Export Entity Database Simulation`
- Purpose: export the currently open database simulation virtual document to a Markdown file; a `.dbsim` simulation document must be open first
- Entries:
  - Command palette
- See also: [Database Simulation](./database-simulation.md)

### `kbengine.database.checkDrift`

- Title: `Check Database Drift`
- Purpose: verify the virtual table structures derived from `.def` against the real table structures, comparing table by table for missing tables, missing columns, extra columns, type mismatches, and leftover tables; the report goes to the 「KBEngine 数据库漂移」 (KBEngine database drift) output channel; without an entity name it infers from the active `.def` file
- Prerequisite: the database credentials in the engine config must be stored in plaintext (`<encrypt>false</encrypt>`); with an RSA-encrypted password or an unreachable server it degrades to a 「未校验」 (not verified) notice instead of erroring
- Entries:
  - Command palette
- See also: [Database Drift Check](./database-drift-check.md)

### `kbengine.database.checkAllDrift`

- Title: `Check All Database Drift`
- Purpose: Check actual MySQL schemas for every workspace entity, reusing one connection and treating all entity tables as expected when finding residual tables
- Prerequisite: Same as `kbengine.database.checkDrift`
- Entries: Command palette
- See also: [Database Drift Check](./database-drift-check.md)

## Server Control

### `kbengine.server.start`

- Title: `Start Server`
- Purpose:
  - With a component argument, starts that single component
  - Without one, starts a group of components per `kbengine.autoStart`

### `kbengine.server.stop`

- Title: `Stop Server`
- Purpose:
  - With a component argument, stops that single component
  - Without one, stops all components

### `kbengine.server.restart`

- Title: `Restart Server`
- Purpose: restart a single component

### `kbengine.server.showLogs`

- Title: `Show Logs`
- Purpose: focus a component's log context

## Logs

### `kbengine.logs.showViewer`

- Title: `Show Log Viewer`
- Purpose: open the log WebView

### `kbengine.logs.connect`

- Title: `Connect to Logger`
- Purpose: connect to the KBEngine logger port

### `kbengine.logs.disconnect`

- Title: `Disconnect from Logger`
- Purpose: disconnect the log connection

### `kbengine.logs.clear`

- Title: `Clear Logs`
- Purpose: clear the current log panel cache

### `kbengine.logs.export`

- Title: `Export Logs`
- Purpose: export log contents

### `kbengine.logs.scanErrors`

- Title: `Scan Raw Log Errors`
- Purpose: pick a raw log file or folder (folders scan only one level of `.log`/`.txt`/`.out`), scan the `ERROR`/`CRITICAL` lines and aggregate counts by "component + normalized signature", then present count/level/component/signature/last-seen in a WebView panel; clicking a hit opens the source file at that line, and "rescan" reruns over the previous batch of files

## Debugging

### `kbengine.debug.updateLaunchJson`

- Title: `Update launch.json`
- Purpose: generate or update VS Code's PID attach configuration from `pathMappings` in `.kbengine/debug.json`; when `kbengine.debug.remoteTargets` is configured, remote targets are appended at the same time as debugpy `connect` entries

### `kbengine.debug.createConfig`

- Title: `Create Debug Config Template`
- Purpose: create the sample debug configuration file `.kbengine/debug.json`

### `kbengine.debug.start`

- Title: `Start Debugging`
- Purpose: show the target component's telnet debugging instructions, then enter the process-picker attach flow

### `kbengine.debug.attach`

- Title: `Attach to Component`
- Purpose: list local processes for selection and attach to a KBEngine component process that has debugging enabled
- Behavior:
  - Processes matching the target component name are pinned to the top with ✓; the rest keep the system process list order
  - After selection, the debugpy attach configuration is assembled from that process's PID directly — no manual PID typing
  - When the process list cannot be obtained it reports the error plainly instead of spinning

### `kbengine.debug.attachRemote`

- Title: `Attach to Remote Component`
- Purpose: attach to a KBEngine component process on a remote machine that has debugging enabled (debugpy `connect` mode, dialing the remote debugpy listen port directly)
- Prerequisite: configure the target list in the setting `kbengine.debug.remoteTargets` (name + IP + debugpy port, default port 5678); the remote component must first have been sent the enable-debugging command over telnet and have a debugpy listener up
- Behavior:
  - With no targets configured it points to the settings instead of spinning
  - A target picker pops up; after modal confirmation the attach configuration is assembled as `connect: {host, port}` without `pathMappings`

## Configuration

### `kbengine.config.showFinal`

- Title: `Show Final Server Config`
- Purpose: open the read-only "final effective config" view — composed per the engine's loading rules: engine defaults `kbengine_defaults.xml` first (located via `kbengine.binPath`), then same-key overrides from the component `kbengine.xml` (under `kbengine.assetsRoot` first, then the conventional paths `kbengine.xml`/`res/server/kbengine.xml`/`assets/res/server/kbengine.xml`; sub-keys aligned by name)
- Behavior:
  - The composed file is never written to disk; it is the virtual document `kbengine-final.xml`, with hoverable field explanations
  - The document header notes the source paths of defaults and component config
  - When defaults cannot be located it errors plainly; by default (`kbengine.showFinalConfigOnOpen`, with refresh linked to `kbengine.autoRefreshFinalConfig`) it auto-opens in the background after activation
  - Service parameters such as telnet port/password are read from the same composed source

## Visualization Panels

### `kbengine.monitoring.show`

- Title: `Show Monitoring Panel`
- Purpose: open the monitoring panel

### `kbengine.dependency.show`

- Title: `Show Entity Dependency Graph`
- Purpose: open the entity dependency graph

The dependency graph panel supports:

- refreshing the graph
- opening entity definitions from the graph
- exporting SVG
- exporting PNG

### `kbengine.flow.show`

- Title: `Show Entity Flow Graph`
- Purpose: open the entity architecture flow graph — method calls and automatic property sync between the client and baseapp/cellapp

The flow graph panel supports:

- The entity name defaults to the active .def editor; when it cannot be located it prompts to open an entity definition file
- Edge semantics are annotated per property Flags bit, with the engine source (file:line) and member declaration positions listed per edge
- Clicking a member row jumps back to the .def declaration
- Non-Exposed BaseMethods are listed separately as 「客户端调不到的方法」 (methods the client cannot call)
- Refresh re-reads def/entities.xml from disk
- Export Markdown (written directly to a file)
- Export SVG/PNG (rendered via webview, then exported)

## Code Generators

### `kbengine.generator.wizard`

- Title: `Create Entity from Wizard`
- Purpose: create an entity step by step through the wizard

### `kbengine.generator.templates`

- Title: `Create Entity from Template`
- Purpose: quickly generate an entity from a preset template (10 total: account, character, NPC, item, monster, scene, guild, team, mail, empty entity)

### `kbengine.generator.formWizard`

- Title: `Create Def Form from Wizard`
- Purpose: generate definition forms beyond the entity wizard, one kind at a time (proxy / space / component / FIXED_DICT type)
- Landing spots and side edits per form:
  - Proxy: `scripts/proxy_defs/<EntityName>Proxy.def`, with `<Parent>` pointing at `<EntityName>Proxy`; method names are entered comma-separated, and whether the method declarations land in `BaseMethods` or `CellMethods` is chosen inside the command (the engine's loading surface differs by version; the generator does not assert on the engine's behalf)
  - Space: `entity_defs/<Name>.def` (parent class `Space` + enter/leave-space callbacks), plus an inserted `hasBase="true" hasCell="true"` line in `entities.xml`
  - Component: `entity_defs/components/<Name>.def`, with optional mounting — a `<Type>COMPONENT</Type>` property appended at the end of the selected entity's `<Properties>` section
  - FIXED_DICT: inserts a `FIXED_DICT` type block into `types.xml` (with `<Properties>` fields, optional `implementedBy`)
- Behavior: existing def files are not overwritten by default, only noted; duplicate registrations in `entities.xml` / `types.xml` are only logged, not rewritten; a missing `types.xml` gets a minimal new root created; an entity def without a `<Properties>` section is not force-inserted — a note is reported instead
- The on-disk directories are resolved from the current workspace's definition layout (`entity_defs` / `components` / `types.xml` auto-discovered since batch 125); when resolution fails it says so plainly and writes nothing

### `kbengine.clientSdk.generate`

- Title: `Generate Client Entity SDK`
- Purpose: generate client entity skeletons from the entities registered in `entities.xml`; languages are checked inside the command (TypeScript / C#, multi-select) — see [Client Entity SDK Generation](./client-sdk.md)

## Performance Analysis

### `kbengine.def.analyze`

- Title: `Analyze Def Performance`
- Purpose: statically check all `.def` files in the workspace and emit optimization suggestions
- Output:
  - The report goes to the 「KBEngine Def 分析」 (KBEngine def analysis) output channel
  - Diagnostics land in the Problems list (`kbengine-def-analysis`)

## Snippet Generation

### `kbengine.snippets.generateFromSelection`

- Title: `Generate Snippet from Selection`
- Purpose: escape the editor selection for snippet syntax (`$`/`\`) and strip the common indent, then after three inputs (name/prefix/description) merge-write into `.vscode/kbengine-custom.code-snippets`
- Behavior:
  - The common indent is stripped per the editor's `tabSize` column semantics; tab/space-mixed selections keep their relative levels
  - A same-named snippet entry is overwritten with a warning
  - A snippet file hand-edited into comments/bad JSON is refused for rewriting, with a notice
  - Snippet file read/write IO failures (permissions, a path occupied by a directory/file, etc.) error with the file path instead of a bare command error

### `kbengine.telnet.showPanel`

- Title: `Show Telnet Panel`
- Purpose: open the telnet control panel (probe status lights + command session)
- Target resolution chain: kode settings (`kbengine.telnet.host/port/password`) → the component `kbengine.xml`'s `<telnet_service>` section (specified by `kbengine.telnet.configXmlPath`; when unspecified, probed via `kbengine.assetsRoot` and conventional paths) → the engine `kbengine_defaults.xml` (located via `kbengine.binPath`); `.kbengine/debug.json` does not participate in telnet probing
- Behavior:
  - The panel lists a status light per target: 未配置 (not configured) / 未开启 (not open) / 已开启（未接会话） (open, no session) / 端口开·未配密码 (port open, no password set) / 密码被拒 (password rejected) / 已连接 (connected)
  - An open target can establish a persistent session (automatic handshake login) with whitelisted command input, built-in read-only shortcut commands, and output echo
  - A not-open target is told honestly how to open it (with a kbengine.xml `<telnet_service>` config snippet), no spinning
  - A disconnect during operation tears the session down and flips the status light; the panel stays up and can reconnect
  - Inside the panel, `Ctrl+]` / `Ctrl+D` drop the session (standard telnet escapes, effective only while the panel is focused); see also the `kbengine.telnet.disconnect` command

### `kbengine.telnet.disconnect`

- Title: `Disconnect Telnet Session`
- Purpose: actively drop the current telnet session. The extension drops its own connection and never sends the engine `:quit` — `:quit` shuts the whole server process down, and the whitelist layer always refuses it
- Entries: telnet tree title-bar button, command palette, `Ctrl+]` / `Ctrl+D` inside the telnet panel
- Behavior:
  - The session panel's currently selected target goes first; with nothing selected or no session on it, the first connected target is taken
  - With no connected session it says so honestly, no spinning

### `kbengine.httpRequests.run`

- Title: `Run HTTP Quick Request`
- Purpose: pick one from the "enabled" HTTP quick requests and run it (quick requests are added/removed/edited and enabled/disabled in the `kbengine.httpRequests` setting)
- Behavior:
  - With no enabled entries it says so honestly, no spinning
  - The run log goes to the OUTPUT channel 「KBEngine HTTP 快捷请求」 (KBEngine HTTP quick requests): `▶` request line (after template substitution) → `✓` status code · duration → response body (truncated past 4000 characters, with the full length noted)
  - Failures render as a `✗` mark + an error popup (the OUTPUT channel has no coloring API, so no literal red)

### `kbengine.httpRequest.run`

- Title: `Run Named HTTP Quick Request`
- Purpose: run one enabled quick request directly by name; requires passing `args.name`
- Behavior:
  - Designed for keybindings on this very command: bind a key to it in "Keyboard Shortcuts" with `args` carrying `{"name": "请求名"}` (request name), and you get "open a .py and hot-reload with one keystroke"
  - Without `args.name` it warns honestly and points to `kbengine.httpRequests.run`; an unknown name or a disabled entry returns an error receipt, no spinning
- Template variables (shared by URL/body/header values, literal substitution, no URL encoding):
  - `${module}`: the current file's workspace-relative module path (`entities/fight/FightAI.py` → `entities.fight.FightAI`; outside the workspace it falls back to the file name)
  - `${file}`: the file name (`FightAI.py`)
  - `${line}`: the cursor line (1-based)
  - `${sel}`: the selected text
  - With no active editor, each variable substitutes to the empty string

### `kbengine.discovery.report`

- Title: `Show Discovery Report`
- Purpose: generate the "discovery and location" diagnostic report and show it in the OUTPUT channel 「KBEngine 发现与定位」 (KBEngine discovery and location); the report can be copied whole and sent back to the maintainer, without pasting workspace file trees
- Report contents (spread out key by key; failures are no longer silent):
  - The three def-tree anchors (entity_defs / entities.xml / types.xml) and derived directories (interfaces / components): the final values in use and their sources (explicit config / remembered choice / convention chain / deep scan / first fallback candidate), the explicit config's original value and existence, convention-chain hits and misses, deep-scan hits, remembered choices
  - Assets root `kbengine.assetsRoot` (validated against the engine-loading probe `res/server/kbengine.xml`; since batch 129 the convention chain includes first-level `*_assets` directories like `flyff_assets`, and a hit is still accepted only by probe) and engine binary `kbengine.binPath` (including kbe source-root auto-detection), plus the engine message tables (batch 129 dual names: the user copy `messages_fixed.xml` and the default `messages_fixed_defaults.xml`, four priority levels aligned with the engine loading order — workspace user copy → engine source-root user copy → workspace default → engine source-root default; an assets-only workspace having neither is normal, the report marks it `informational` and counts no problem; only when an engine source root is found yet both copies are missing is a problem reported)
  - Bounded deep-scan metadata: entries visited, whether the cap truncated the scan (truncation is flagged 「命中集可能不全」 — the hit set may be incomplete)
  - A problem list: each item with a one-line remedy suggestion (missing entities.xml → points at `kbengine.entitiesXmlPath`; assets root missing the probe file → points at the expected shape, etc.)
- Behavior:
  - With no workspace open it warns instead of spinning
  - With problems present it pops a warning pointing at the OUTPUT panel; when all is well, an info notice
  - After activation-time auto discovery completes, a report is also silently dropped into the same channel (a notice pops only when there are problems)

### `kbengine.quickActions.show`

- Title: `Run Quick Actions`
- Purpose: pop the 「快速执行动作」 (quick actions) list and run the selected one. The action list lives in the workspace's `.kbengine/debug.json` top-level `quickActions` array — it travels with the KBEngine project, not into VS Code settings and not into `launch.json`
- Entries: Servers view title-bar button, top-right buttons on `.def` / Python / XML editors, command palette `Run Quick Actions`
- Three backend kinds (a whitelist; no arbitrary shell entry is provided):
  - `command`: a VS Code command id, `args` passed through verbatim (string items support variables), reusing the invoked command's own error reporting
  - `script`: runs a script explicitly declared in the config; `background: true` means server-start types do not wait for the exit code (the process being alive reports 「已启动」 — started)
  - `http`: requests a URL hard-coded in the config; no runtime concatenation
- Variables (substituted at run time, applied to config literal strings): `${workspaceFolder}` (the effective quick-action config root, normally the first workspace root), `${workspaceFolder:Name}` (root by name), `${env:VAR_NAME}`. An unknown variable errors out immediately, naming the variable — never a silent empty-string substitution
- Behavior:
  - An action pops a modal confirmation by default (`confirm: false` skips it); the run log goes to the OUTPUT channel 「KBEngine 快速执行动作」 (KBEngine quick actions), and script stdout/stderr flows in verbatim
  - A failure pops once (action name + exit code / status code / reason), with the script's stdout/stderr left in the channel
  - Invalid config entries (e.g. a `type` outside the whitelist, missing required fields) are pruned one by one with a count notice; the whole table never fails
  - When the config is missing, it scans the config root and top-level `assetsRoot` for `.bat` / `.ps1` files and writes them into the new config; scanned actions use the script directory as `cwd`. An existing empty config gets a registration prompt on activation
  - `.ps1` files run through PowerShell; script actions may set `venv: { enabled: true, path?: "${workspaceFolder}/.venv" }` to add the environment to the child process PATH
  - The list is grouped by backend kind: consecutive same-type runs share one group-name separator line; config order is never reshuffled

### `kbengine.quickActions.runDefault`

- Title: `Run Default Quick Action`
- Purpose: one-keystroke run of "the last action actually run"; if none has ever run, the first item of the list is taken. When the workspace has no runnable action at all it says 「未发现可执行脚本」 (no runnable script found) and points at `.kbengine/debug.json`
- Entries: the ▶ button in the KBEngine Explorer view title bar (first to the right of the dropdown ▾ button)
- Behavior:
  - The memory key `kbengine.quickActions.lastRun` lives in this workspace's workspaceState; an action picked in the list immediately becomes the ▶ default target, regardless of that run's outcome
  - When the remembered action is deleted or broken it falls back to the first item of the list, without erroring
  - The execution chain is identical to `kbengine.quickActions.show` (variable substitution → confirmation → dispatch → log)

### `kbengine.quickActions.scanScripts`

- Title: `Rescan Scripts for Quick Actions`
- Purpose: Rescan top-level `.bat` / `.ps1` files in the effective config root and `assetsRoot`; refresh generated actions from the selection while preserving manual actions and other debug settings
- Script working directory: scanned actions use the script's containing directory as `cwd`
- Entry point: Command Palette

### `kbengine.python.syncExtraPaths`

- Title: `Sync Python Extra Paths`
- Purpose: write the workspace-discovered KBEngine scripts root into `python.analysis.extraPaths` (WorkspaceFolder level) so the Python extension (Pylance/pyright) can resolve `import KBEngine` and `import common.*` in entity scripts
- Entries: command palette `Sync Python Extra Paths`; also synced once automatically at extension activation (`kbengine.python.extraPathsSync` default on, fully silent during activation)
- Behavior:
  - The scripts-root candidates share the entity index's conventions: `<workspace>/scripts`, `<workspace>/assets/scripts`, `<workspace>/server_assets/scripts`, first-level `<xxx>_assets/scripts` (the batch 129 assets-root convention); only paths that really exist on disk are collected
  - `.kbengine/stubs` (the stub export directory) joins the managed segment when `kbengine.python.stubExport` is on and `KBEngine.pyi` is on disk; a user-configured `kbengine.python.stubDir` directory does not join the managed segment
  - Written via resource-scoped `getConfiguration('python', folder).update(...)` (WorkspaceFolder level); comments in settings.json are preserved by the host; written only when the discovery result differs from the current value — no change, no file touch
  - It manages only the segment this extension wrote: the last-written set is remembered in workspaceState, and the next sync removes the old set before writing the new one; user-entered paths are never touched
  - Setting `kbengine.python.extraPathsSync: false` turns it all off (when off, the command only explains without writing); a manual rerun reports the write result, while activation-time auto sync stays quiet

### `kbengine.python.exportStubs`

- Title: `Export KBEngine Python Stubs`
- Purpose: export the built-in KBEngine Python API symbol index (the same source as kode's completion/hover/navigation) as a real `.pyi` file, which together with the extraPaths wiring lets Pylance resolve `import KBEngine` (virtual stub documents are invisible to the Python extension)
- Stub directory resolved in three tiers (batch 142): `kbengine.python.stubDir` setting > env var `KBENGINE_STUB_DIR` > default convention `<workspace>/.kbengine/stubs`; VS Code variables like `${workspaceFolder}`/`${env:NAME}` are supported
- Entries: command palette `Export KBEngine Python Stubs`; also exported once automatically at activation (`kbengine.python.stubExport` default on, fully silent during activation)
- Behavior:
  - The default convention directory is kode-managed: zero write when the content matches disk; stale content (after an index update) is automatically rewritten; manual edits are not kept
  - A configured user directory is entered but never left: any `.pyi` already in the directory is treated as a user asset and never overwritten; one is generated only when no `.pyi` exists; an unreadable directory (missing/no permission) is reported honestly, never blindly written
  - Ignoring `.kbengine/stubs/` in `.gitignore` is recommended (a generated artifact that follows kode index updates); pre-existing `.pyi` files in a user-configured directory are user assets — kode neither changes nor deletes them
  - An unwritable directory (a read-only mount, etc.) warns and continues with the remaining workspace folders
  - After a successful export it chains one extraPaths sync so the new stub directory takes effect immediately
  - Setting `kbengine.python.stubExport: false` turns it all off

### `kbengine.python.exportTypeStubs`

- Title: `Export KBEngine Python Type Stubs`
- Purpose: export the custom types (utype) in `entity_defs/types.xml` into a Python type stub module `kbe_types.py` — `FIXED_DICT` → `TypedDict` classes, `ARRAY` → `List[element]`, aliases → target type names — which together with the extraPaths wiring gives entity and tool scripts a real type source for `import kbe_types` (feasibility analysis: [Def/utype to .pyi stubs](../design/def-pyi-stubs.md))
- A real `.py` rather than a `.pyi`: a pure `.pyi` has no runtime form, so `import kbe_types` on the Python side gets no value; a real module serves both as a Pylance type source and as a runtime import
- Same directory and switch as `kbengine.python.exportStubs`: the `kbengine.python.stubDir` three-tier resolution, sharing the `kbengine.python.stubExport` switch; exported once automatically at activation, after KBEngine.pyi (silently)
- Behavior:
  - Deterministic content: the same input produces byte-identical content (no timestamp in the header), following the same zero-write-when-unchanged, rewrite-when-stale discipline as KBEngine.pyi
  - Alias assignments are module-level eager evaluations, emitted in dependency topological order; types with empty `types.xml` directives or alias cycles are skipped with the reason stated in the message — no assignment referencing an undefined name is ever generated
  - The built-in type mapping shares the table with the TS generator: integers → `int`, floats → `float`, strings → `str`, vectors → fixed-length `Tuple`, `PY_DICT/PY_TUPLE/PY_LIST` → typing generics, no counterpart → `Any` (lossy but valid)
  - An existing `kbe_types.py` in a configured user directory is treated as a user asset and never overwritten; the default directory `.kbengine/stubs` is kode-managed
  - When a workspace has no custom types, no file is generated and no message disturbs; after a successful export it chains one extraPaths sync
- `types.xml` on disk regenerates automatically: after a save/create/delete the watcher silently re-exports (no debouncing, no extra setting — the zero-write discipline makes repeated triggers side-effect free; with `kbengine.python.stubExport` off it effectively stops)
  - Setting `kbengine.python.stubExport: false` turns it all off (shared with the KBEngine.pyi stub export)

## Typical Workflows

### Creating an entity

1. Run `Create Entity from Wizard`
2. Pick the output configuration
3. Generate the `.def` and optional Python files
4. If `kbengine.generator.registerInEntitiesXml` is enabled, write into `entities.xml`
5. Continue editing in the entity explorer

### Observing online behavior

1. Start the components to observe
2. Open the log viewer
3. Open the monitoring panel to watch resource changes
4. Use the dependency graph to inspect entity relations

Note:
Logs and monitoring both depend on KBEngine's protocol interactions.
The log protocol adaptation is not finished yet; when the watcher is unresponsive, the monitoring panel keeps only the basic machine-returned state.

### Debugging a component

1. Confirm the target component's telnet is enabled (address/port/password confirmed along the resolution chain: kode settings `kbengine.telnet.*` → the component `kbengine.xml`'s `<telnet_service>` section → the engine `kbengine_defaults.xml`)
2. Run `Create Debug Config Template`, which generates `.kbengine/debug.json`; its `telnetHost`/`telnetPort`/`telnetEnableCommands` serve only `Start Debugging`'s instructions, and `pathMappings` feeds launch.json generation — none of them affect telnet probing or the panel
3. Run `Start Debugging` to read the instructions, and first send the project's actual enable-debugging command to the target component over telnet
4. Run `Attach to Component` and pick the target process in the process list (processes matching the component name are pinned to the top with ✓)

## Do Commands Integrate with Configuration?

Yes. Many commands read `kbengine.*` settings, for example:

- Entity navigation reads `kbengine.entityDefsPath`
- Server start reads `kbengine.autoStart`
- The log panel reads `kbengine.loggerPort`
- The dependency graph reads `kbengine.entitiesXmlPath` and `kbengine.entityDefsPath`
- The generators read `kbengine.generator.*`

Debugging is the exception. Local attach no longer reads the old `kbengine.pythonPath`, `kbengine.debugPort`, `kbengine.autoAttachDebug`; `.kbengine/debug.json` serves only `Start Debugging`'s instructions and `pathMappings`, and does not participate in telnet probing/panel/status lights. Remote attach (`kbengine.debug.attachRemote`) takes its target list from the setting `kbengine.debug.remoteTargets`.

## Debug Command Notes

### `Attach to Component`

KBEngine's debugging model is not "launch a Python file". The Python runtime here is embedded in a C++ component process, so the extension keeps only two steps:

1. Send the project's actual enable-debugging command to the target component over telnet
2. Attach to the chosen target process via VS Code's built-in process picker (`${command:pickProcess}`, popped and parsed by debugpy)

The `launch.json` generated by the extension is fixed to the process-picker attach form:

```json
{
  "name": "KBEngine: Attach to baseapp",
  "type": "debugpy",
  "request": "attach",
  "processId": "${command:pickProcess}",
  "justMyCode": false,
  "pathMappings": [
    {
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "${workspaceFolder}"
    }
  ]
}
```

The `${input:kbengineProcessId}` manual-PID input item generated by earlier versions is deprecated; running `Update launch.json` cleans up that leftover input automatically.

When `kbengine.debug.remoteTargets` is configured, `Update launch.json` appends each remote target as its own debugpy `connect` configuration (`connect: {host, port}`, without `pathMappings`).

### Recommended Order

1. Confirm the target component's telnet is enabled (kode settings `kbengine.telnet.*` or the component `kbengine.xml`'s `<telnet_service>` section)
2. Run `Create Debug Config Template`
3. Fill in the enable-debugging command and path mappings in `.kbengine/debug.json` (`telnetHost`/`telnetPort` affect only the instructions)
4. Run `Update launch.json`
5. Run `Start Debugging`, read the instructions, and enable debugging first
6. Run `Attach to Component` and pick the target process in the popped list (matches pinned to the top with ✓)

### Troubleshooting Points

If `Attach to Component` fails, check these first:

1. Whether the target KBEngine component has really enabled debugging over telnet (telnet address/port/password confirmed along the resolution chain: kode settings `kbengine.telnet.*` → the component `kbengine.xml`'s `<telnet_service>` section → the engine `kbengine_defaults.xml`)
2. Whether the process picked in the list is really the target component process, not some other manager or helper process
3. Whether `telnetEnableCommands` in `.kbengine/debug.json` matches the project's real command (affects only `Start Debugging`'s instructions, not the telnet connection itself)
4. Whether `pathMappings` in `.kbengine/debug.json` maps to the current workspace's source directory
5. Whether `ms-python.debugpy` is installed and enabled on this machine
