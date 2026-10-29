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
- Timeout / cancel (IDE-REV-017): every connect and query runs under `kbengine.databaseQueryTimeoutMs` in a cancellable progress notification — timeout or cancel returns with that reason (shown in the 未校验 report), the connection is released right after the underlying query settles (a hung one is force-destroyed), so the entry never waits forever
- Evidence (IDE-REV-020): a real run (report checked) saves drift evidence keyed by engine version to workspace state and appends a verdict line to the output channel; the verdict keeps the queried side (real MySQL) and the simulated side (def-derived baseline, marked 非实测) apart — an undetectable engine version is recorded `unknown` and the verdict stays unknown-version (no compatibility claim), while an unverified run (no connection / unreadable structure) saves nothing and says so honestly
- Entries:
  - Command palette
- See also: [Database Drift Check](./database-drift-check.md)

### `kbengine.database.showDriftEvidence`

- Title: `Show Drift Evidence`
- Purpose: re-view the saved drift-check evidence (IDE-REV-020) in the 「KBEngine 数据库漂移」 output channel — one block per engine version, newest first, each with the classify verdict (`compatible-verified` / `unverified` / `unknown-version` / `drift-found`), the queried summary (real MySQL), the simulated summary (def-derived baseline, marked 非实测), and the record time
- Behavior:
  - Only real executions save evidence (`kbengine.database.checkDrift` / `checkAllDrift` with a checked report); unverified runs save nothing — a standalone simulated face never masquerades as a live result
  - No saved evidence yet is stated honestly (channel + info message), nothing is fabricated
- Entries: Command palette

### `kbengine.database.checkAllDrift`

- Title: `Check All Database Drift`
- Purpose: Check actual MySQL schemas for every workspace entity, reusing one connection and treating all entity tables as expected when finding residual tables
- Prerequisite: Same as `kbengine.database.checkDrift`
- Timeout / cancel: same deadline and progress-notification cancel as `kbengine.database.checkDrift` (per connect/query), over one guarded connection
- Evidence (IDE-REV-020): a real run saves drift evidence keyed by engine version to workspace state and appends a verdict line to the output channel (see `kbengine.database.checkDrift`); an unverified run appends an honest skip line instead
- Entries: Command palette
- See also: [Database Drift Check](./database-drift-check.md)

### `kbengine.database.previewTable`

- Title: `Preview Table Data`
- Purpose: read-only single-table preview (IDE-REV-016) — pick a table and see up to 100 rows in the 「KBEngine 数据库预览」 (KBEngine database preview) output channel; the executed statement is always the fixed whitelist shape `SELECT * FROM \`table\` LIMIT N` (double-checked against the read-only statement gate before it runs, and the connection itself is opened read-only)
- Entries: Command palette
- Behavior:
  - The connection comes from the same per-profile ledger as the drift commands; without a readable engine database config it says so and runs nothing
  - The table picker lists `SHOW TABLES` results; when the listing cannot be fetched (permissions) or the database has no tables, a manual table-name input takes over with the same identifier rules as the preview statement
  - Cancelling the picker (or the manual input) sends no preview query; an unreachable database reports the connection cause honestly with no output
  - Connect and every query run under `kbengine.databaseQueryTimeoutMs` in a cancellable progress notification (IDE-REV-017): timeout or cancel returns with that reason and releases the connection — it never falls back to manual table input on a connection that is being released
  - Rows over the limit are cut and marked truncated in the footer, which also shows the exact SQL that ran
  - Column sources (IDE-REV-018): after the table, a 列来源 section links every result column back to its declaration — derived columns print `filePath:line` of the real `.def`/`types.xml` declaration (clickable in the output panel, the declared type text included), engine structural columns are stated as synthetic with no declaration to jump to, and columns outside the virtual schema stay honestly unknown; a table not derived by any workspace entity says so for the whole section instead of guessing neighbors

### `kbengine.database.previewSchemaImpact`

- Title: `Preview Schema Impact`
- Purpose: read-only single-entity schema impact preview (IDE-REV-019) — diff one entity's real table structure (`SHOW FULL COLUMNS`, a read-only query) against the def-derived virtual schema, and print to the 「KBEngine 结构影响预览」 output channel the change list a sync by the current def would cause: added / removed / type-changed columns; no DDL or write path exists anywhere in the command
- Entries: Command palette; optionally takes an entity name argument
- Behavior:
  - Entity selection: command argument, else the active `.def` file, else a quick pick over workspace registered entities; a cancel or an empty registry honestly runs nothing
  - Integer display widths are normalized before comparing (`int(10) unsigned` equals `int unsigned`, same rule as the drift check); engine structural columns (id / sm_autoLoad / …) are excluded on both sides via the same def-derived synthetic list, so they never show up as removals
  - A table not yet in the database is reported as 整表新建 (whole-table create) with the def-derived column count — no fabricated comparison
  - The connection comes from the same per-profile ledger as the drift commands; without a readable engine database config it says so and runs nothing
  - Connect and the query run under `kbengine.databaseQueryTimeoutMs` in a cancellable progress notification (IDE-REV-017): timeout or cancel returns with that reason; the connection is closed afterwards in every branch
  - The report header states the read-only scope explicitly; zero differences are stated as such (无结构差异)

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
- Purpose: show the target component's telnet debugging instructions, then enter the attach flow; a component with a configured `debugpyPort` skips the briefing and connects to that port directly (IDE-PDBG-001)

### `kbengine.debug.attach`

- Title: `Attach to Component`
- Purpose: attach to a KBEngine component process that has debugging enabled — a component with a configured `debugpyPort` connects straight to that port (port mode); otherwise the mode chosen once decides: port mode (per-component default port table, otherwise 5678) or process attach (local process picker)
- Behavior:
  - First-time without a configured port asks between 端口模式 / 进程附加模式 (remembered in workspace state; `kbengine.debug.resetAttachMode` clears it)
  - Port mode probes the debugpy port over TCP first (IDE-PDBG-002): an open port attaches with zero extra dialogs; a closed port names the cause, and a missing/outdated debugpy on the local interpreter chain offers a one-click `pip install -U debugpy` or a manual guide — after installing, the port is re-probed (installing alone never opens it)
  - Processes matching the target component name are pinned to the top with ✓; the rest keep the system process list order
  - After selection, the debugpy attach configuration is assembled from that process's PID directly — no manual PID typing
  - When the process list cannot be obtained it reports the error plainly instead of spinning

### `kbengine.debug.attachRemote`

- Title: `Attach to Remote Component`
- Purpose: attach to a KBEngine component process on a remote machine that has debugging enabled (debugpy `connect` mode, dialing the remote debugpy listen port directly)
- Prerequisite: configure the target list in the setting `kbengine.debug.remoteTargets` (name + IP + debugpy port, default port 5678); the remote component must first have been sent the enable-debugging command over telnet and have a debugpy listener up
- Behavior:
  - With no targets configured it points to the settings instead of spinning
  - A target picker pops up; after modal confirmation the attach configuration is assembled as `connect: {host, port}`; `pathMappings` is written only when the target entry carries both `localRoot`/`remoteRoot`

### `kbengine.debug.resetAttachMode`

- Title: `Reset Debug Attach Mode Choice`
- Purpose: clear the remembered attach-mode choice (IDE-PDBG-001) so the next `Attach to Component` asks again between port mode and process attach mode
- Behavior:
  - Clears the workspace-state key and confirms with a notification; it never starts an attach itself
  - A component with a configured `debugpyPort` always attaches in port mode regardless of the remembered choice

### `kbengine.debug.pyspyDump`

- Title: `Profile Component with py-spy`
- Purpose: py-spy profiling entry (IDE-PDBG-003) on the Servers tree, inline right after the debug attach icon (`$(pulse)`); dumps the target component process's Python call stacks into the `KBEngine py-spy` output channel
- Entry: Servers tree inline icon (after the debug icon), or the command palette
- Behavior:
  - The process picker is the existing one (component-name matches pinned ✓); the picked PID goes to `py-spy dump --pid <pid> --nonblocking` — nonblocking never pauses the target process, production components keep serving
  - py-spy missing locally asks once: one-click install runs `<interpreter> -m pip install -U py-spy` on the selected interpreter chain; an install failure reports the pip exit code and output tail honestly, never retries in a loop
  - A dump failure shows the cause in the output channel; permission failures append the ptrace guidance — Linux needs `kernel.yama.ptrace_scope=0` (or sudo/cap), containers need `--cap-add=SYS_PTRACE`, Windows needs an elevated or same-user session
- Behavior (remote, IDE-PDBG-004/005): on a component dispatched to a remote server, py-spy runs over `ssh <host> -- …` and the process list comes from the same `ps` over ssh — the picker keeps the local shape (component matches pinned ✓); a listing that cannot be fetched reports the host and ssh cause honestly and opens no picker (never the local list as a stand-in)
- Prerequisite: the target process must be a Python process visible to py-spy; ptrace permission per the guidance above

### `kbengine.remoteServers.select`

- Title: `Select Remote Server`
- Purpose: pick the server that debug and py-spy dispatch through (IDE-PDBG-004) — click a node in the Remote Servers view, or open the picker from the palette
- Entry: Remote Servers view node click, or the command palette
- Behavior:
  - The view lists hosts from `~/.ssh/config` (per-Host-block HostName/User/Port/ProxyJump; wildcard and negated aliases hidden; `Include` not expanded — hosts in included files don't show) plus manually added hosts, with `本地(直接执行)` always first and selected by default
  - The choice lands in workspace state and applies to dispatch with the precedence component `sshHost` > `debug.defaultSshHost` > this selection > local
  - Selecting a remote host makes port-mode attach go over an `ssh -N -L` tunnel and py-spy run over `ssh <host> -- …`; selecting 本地 switches both back to direct local execution
  - An invalid id or a cancelled picker leaves the choice untouched

### `kbengine.remoteServers.add`

- Title: `Add Remote Server`
- Purpose: manually add a remote host to the Remote Servers view (IDE-PDBG-004) — for hosts not written in `~/.ssh/config`
- Entry: Remote Servers view title bar `+`, or the command palette
- Behavior:
  - Asks for a host name (ssh alias or `user@host` form); ProxyJump and other parameters belong in `~/.ssh/config` — a manual entry connects by its bare name
  - Duplicates are collapsed (a name already listed from the config is not shown twice); removing a manual entry never touches the config file

### `kbengine.remoteServers.remove`

- Title: `Remove Remote Server`
- Purpose: remove a manually added host from the Remote Servers view (IDE-PDBG-004)
- Entry: inline trash icon on a manual node (right-click also works), or the command palette
- Behavior:
  - Applies to manual entries only — hosts coming from `~/.ssh/config` have no remove affordance (edit the config file instead)
  - Removing the currently selected entry falls the selection back to 本地, so dispatch never points at a missing host

### `kbengine.remoteServers.refresh`

- Title: `Refresh Remote Servers`
- Purpose: re-read `~/.ssh/config` and rebuild the Remote Servers view (IDE-PDBG-004)
- Entry: Remote Servers view title bar refresh icon, or the command palette
- Behavior:
  - Reports how many hosts came from `~/.ssh/config`, and says plainly when the file doesn't exist (the view then holds 本地 plus manual entries only)

## Configuration

### `kbengine.config.showFinal`

- Title: `Show Final Server Config`
- Purpose: open the read-only "final effective config" view — composed per the engine's loading rules: engine defaults `kbengine_defaults.xml` first (located via `kbengine.binPath`), then same-key overrides from the component `kbengine.xml` (under `kbengine.assetsRoot` first, then the conventional paths `kbengine.xml`/`res/server/kbengine.xml`/`assets/res/server/kbengine.xml`; sub-keys aligned by name)
- Behavior:
  - The composed file is never written to disk; it is the virtual document `kbengine-final.xml`, with hoverable field explanations
  - The document header notes the source paths of defaults and component config
  - When defaults cannot be located it errors plainly; by default (`kbengine.showFinalConfigOnOpen`, with refresh linked to `kbengine.autoRefreshFinalConfig`) it auto-opens in the background after activation
  - Service parameters such as telnet port/password are read from the same composed source

### `kbengine.metrics.showSummary`

- Title: `Show Language Service Metrics Summary`
- Purpose: open the "Kode Language Service Metrics" output channel with the aggregated performance recorder report (PR1 observation layer, no behavior change)
- Behavior:
  - One line per event family (`hover`, `definition`, `completion`, `diagnostics`, `python-index-scan`, `python-composition-roots`, `entity-mapping-scan`, `semantic-query`, `type-registry-query`, `file-discovery`, `document-parse`)
  - Each line reports request count, P50/P95/P99/max/avg elapsed (monotonic clock, ms), cache hit rate, waited-for-init count, file discovery/read/parse totals and status counts
  - Per-request detailed samples are off by default; enable `kbengine.metrics.detailed` to also stream `[kode-lsm]` samples into the log timeline

### `kbengine.metrics.startCpuProfile`

- Title: `Kode: Start Extension Host CPU Profile`
- Purpose: start V8 CPU profiling in the extension host process (IDE-MET-007 jank evidence entry point)
- Behavior:
  - Sampling interval 1000us via the Node inspector `Profiler` domain; a second start while running is rejected with a warning
  - Output directory is the extension global storage (falls back to the system temp dir when unavailable)

### `kbengine.metrics.stopCpuProfile`

- Title: `Kode: Stop Extension Host CPU Profile`
- Purpose: stop profiling and write the capture to disk with its request-window context
- Behavior:
  - Writes `kode-cpu-profile-<timestamp>.cpuprofile` (open in VS Code / Chrome DevTools) plus a sibling `.window.txt`
  - The `.window.txt` sidecar records window start/end ISO timestamps, duration, the language service metrics summary and the event loop delay report, correlating the profile with the request window


### `kbengine.metrics.showActiveTasks`

- Title: `Kode: Show Active Language Service Tasks`
- Purpose: export pending and post-cancel residual task counts (IDE-MET-008)
- Behavior:
  - Lists in-flight language service operations per family (started..ended ledger; cancelled ends also leave the ledger) plus the diagnostics scheduler queued/inFlight workload
  - Read this ledger to compare active tasks before and after cancelling a request; do not infer that work stopped from an empty provider return value


### `kbengine.python.debugpySync`

- Title: `Copy System debugpy into Assets`
- Purpose: one-time wiring for `kbengine.debug.autoDebugpy` — copy the system pip `debugpy` package into `<assets>/scripts/common/debugpy` so that `import debugpy` resolves inside engine components (that directory is the first entry of the engine's module search path, `python_app.cpp:167`; `site_import=0` does not affect it)
- Entries: command palette `Copy System debugpy into Assets`
- Behavior:
  - Locates the source debugpy by probing interpreters in order: the selected interpreter (the `kbengine.python.interpreterPath` → PATH chain, same as the debug preflight), then `python3`, then `python` (`-c "import debugpy"`); a missing package or unreadable install directory is reported honestly, nothing is copied
  - Version gate: the embedded engine Python is 3.12.13 and debugpy supports 3.12 from 1.8.0 on — older system versions are rejected with the reason (`pip install -U debugpy`), never copied blind
  - Own-key discipline: a target directory kode did not write (no workspaceState ledger entry) is treated as user-placed and never touched, whatever its version; the same version already in place is a zero-write skip; kode's own older copy is upgraded
  - Never throws — the outcome (synced / skipped / upgraded / error, with the reason) is surfaced as the command result message
- Boundary: this command only places the package; starting the listener is the job of the `kbengine.debug.autoDebugpy` start-time injection, and attaching is the job of the generated launch.json entries

### `kbengine.debug.waitAtStartup.on`

- Title: `debugpy: Wait for Debugger at Startup (On)`
- Purpose: opt-in wait-for-debugger mode — pause engine components at their earliest Python (before early breakpoints in the entry script), without depending on the post-start telnet injection
- Entries: command palette
- Behavior:
  - Locates the entry script `scripts/kbengine.py` next to `scripts/entity_defs` under the active assets root; a missing entry script is reported honestly and nothing is written
  - Inserts a marked bootstrap block after the module docstring: it reads the `KODE_DEBUGPY_WAIT_PORT` environment variable and runs `debugpy.listen` + `debugpy.wait_for_client()`; without the variable, without the debugpy package, or on any error it stays silent and never blocks engine startup
  - Sets `kbengine.debug.waitAtStartup` to true; `serverManager` then launches default instances of table components (baseapp/cellapp/loginapp/dbmgr/logger) with `KODE_DEBUGPY_WAIT_PORT` set to the per-component table port — the component pauses until VS Code attaches the matching debugpy attach config
  - Insertion is idempotent (already-present block = zero write) and keeps user edits outside the block
- Boundary: named instances keep the telnet-injection path (their per-instance ports come from the start-linkage window; wait mode does not cover them yet, stated honestly); while wait mode is on, the telnet injection for default instances is skipped with a log line (the bootstrap listener already owns the table port)

### `kbengine.debug.waitAtStartup.off`

- Title: `debugpy: Wait for Debugger at Startup (Off)`
- Purpose: turn the wait-for-debugger mode off and restore the entry script
- Entries: command palette
- Behavior: removes the bootstrap block byte-exactly (restoring the original text; an absent block is a zero write) and sets `kbengine.debug.waitAtStartup` to false; if the entry script cannot be located the setting is still turned off with a note
- Boundary: mirrors the On command's boundaries; components already running keep whatever listener they had

### `kbengine.debug.focusTarget`

- Title: `debugpy: Focus Debug Target`
- Purpose: locate a debug target from the Debug Targets tree view (IDE-DBG-008) — each running target shows one row whose phase is one of not-injected / listening (with its debugpy port) / attached (with session count) / failed (with the failure detail); rows refresh on injection outcomes, debug-session starts/ends, and process changes
- Entries: clicking a row in the Debug Targets view (the palette entry explains where to click)
- Behavior:
  - attached: opens the Run and Debug view (`workbench.view.debug`) and names the session entry (its call stack is visible there) — the per-session focus within the view is the editor's own selection, stated honestly
  - listening: reports the debugpy port and points at the matching launch.json attach config
  - failed: shows the failure detail (preflight block, telnet never ready, window exhausted, injection rejected) and how to retry
  - not-injected: explains the two opt-in paths (`kbengine.debug.autoDebugpy` start-time injection, or the wait-at-startup mode) and that a component restart is needed
  - a serverKey that is no longer running is reported as stopped, honestly
- Boundary: the tree only lists running targets (a stopped process has no row); the attached phase wins over listening/failed because a live session implies the injection once succeeded

### `kbengine.jsoncAssociation.off`

- Title: `Turn Off debug.json JSONC Association`
- Purpose: turn off the debug.json JSONC wiring and reclaim what kode wrote — `.kbengine/debug.json` is JSONC (comments; parsed with `stripJsonComments`), and stock json mode draws red squiggles on its comments
- Entries: command palette `Turn Off debug.json JSONC Association`
- Behavior:
  - Flips `kbengine.jsoncAssociation` to `false` at the user (Global) level, so later activations stop wiring
  - Reclaims, per workspace folder, only the `files.associations` glob key kode itself wrote (remembered in workspaceState); a key whose value you later changed, or one you filled by hand, is left exactly as is; your other association keys are never touched
  - When nothing kode wrote is found, it says so and still flips the switch (existing values untouched)
  - To re-enable: set `kbengine.jsoncAssociation` back to `true` and reload the window
- Boundary: the association changes only how the editor treats the file (jsonc coloring, comment tolerance); the parser's acceptance does not change — single quotes, unquoted keys, and trailing commas (JSON5 habits) are still treated as a bad config

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

### `kbengine.quickActions.runByName`

- Title: `Run Quick Action By Name`
- Purpose: execute the quick action identified by the supplied name from the `.kbengine/debug.json` action list

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
- Profile binding: with an active profile, entity registration order and type data are taken from that profile's assets root only (`src/sdkGenerationProfile.ts`); same-named entities from other scanned roots are rejected and named in the completion message, never silently merged; without an active profile the command falls back to the first workspace folder
- Engine trace: every generated file's header records the input engine's version and commit (`src/sdkGenerationTrace.ts`, probed via `readEngineApiMetadata`, profile engine root preferred); when the engine cannot be located both lines read `unknown` verbatim

### `kbengine.project.doctor`

- Title: `Run Project Doctor`
- Purpose: audit the def reference graph and report structural issues

### `kbengine.symbolReferences.show`

- Title: `Show Symbol References Graph`
- Purpose: show the def symbol reference graph as Mermaid and plain-text previews

### `kbengine.profile.start`

- Title: `Start Runtime Profile`
- Purpose: query a running KBEngine component's profile data and show the response

### `kbengine.spaces.query`

- Title: `Query Spaces`
- Purpose: query the local cellappmgr for current space records

### `kbengine.runtimeQuery.show`

- Title: `Show Runtime Query Panel`
- Purpose: discover running components, query cellappmgr spaces, and query watcher values from one panel

### `kbengine.python.showCallChain`

- Title: `Show Call Chain`
- Purpose: generate the configured Python call chain preview for the selected method

### `kbengine.compatibility.check`

- Title: `Check Engine Compatibility`
- Purpose: compare the extension's expected engine surface with the located engine checkout

### `kbengine.workbench.show`

- Title: `Show KBEngine Workbench`
- Purpose: show a command launcher for discovery, runtime queries, schema, SDK, and compatibility tools

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

### `kbengine.hotReload.tempEdit.run`

- Title: `Temp-Edit Hot Reload (Active File)`
- Purpose: temp-edit hot reload on the active file — write a temporary edit (one trailing marker comment line) → optionally restore the original content → fire the configured reload quick action by name → echo the outcome
- Behavior:
  - Gated **off by default** (`kbengine.hotReload.tempEdit.enabled`); the command honestly refuses while disabled
  - The reload step reuses the existing quick-action channel (HTTP and terminal actions alike) — no second HTTP implementation
  - Echo goes to the OUTPUT channel 「KBEngine HTTP 快捷请求」 plus the Problems panel (a diagnostic on the file; cleared on success)
  - Success semantics stay honest: a usable transport receipt is only 「已发送(未确认)」 (sent, unverified) — without a trusted applied receipt the UI never claims the module was hot-updated (accepted ≠ applied)
  - If auto-restore fails the reload is aborted (the marker-edited content is never sent) and the file is reported as left in the temp-edit state

### `kbengine.hotReload.showLog`

- Title: `Show Hot Reload Log`
- Purpose: open the 「KBEngine 热更」 OUTPUT channel — the audit log behind the hot-reload status bar item (HR-UI-001)
- Behavior:
  - The status bar item `$(eye…) 热更: …` reflects the watch state machine: Watch Off (`kbengine.hotReload.enabled=false` or empty globs) → Ready (watchers built) → Sending (debounce elapsed, quick action fired) → Sent(unverified) → Failed; clicking the item runs this command
  - Honest semantics: a completed action without errors is only 「已发送(未确认)」 (sent, unverified) — no business receipt is verified, so the UI never claims the module was applied (receipt verification belongs to the HR-STATE series)
  - Each trigger logs time / trigger files (merged by debounce) / the debounce value, plus the outcome line (sent-unverified / failed / skipped-no-action-name); log lines are appended immediately and are not subject to the status-bar throttle
  - Hidden from the command palette (`when: false`) — the status bar item is the intended entry


### `kbengine.hotReload.showBatchSummary`

- Title: `Show Hot Reload Batch Summary`
- Purpose: render the multi-target hot-reload batch rollup into the 「KBEngine 热更新」 channel and open it — one block per target with per-file reasons (IDE-REV-025 / HOT-006)
- Behavior:
  - Aggregates the whole per-target ledger (every (rootId, targetId) that has records — not just the latest send): a batch with failed and non-failed targets shows 部分成功 (partial) naming each failed target and its reason; all failed shows 全部失败; no failures shows 全部目标发出面成功 with the explicit note that application-confirmation state lives in the per-target detail, never claimed by the batch text
  - Every target — failed or not — gets its per-file block (`rootId::targetId(outcome):` followed by `file → outcome(detail)` lines), so one green target never masks a red one (worst face wins within a target: failed > sent-unverified > accepted > applied)
  - An empty ledger is rendered honestly as 无投递记录 and the channel still opens
  - Success is delivery-face only: sent-unverified never masquerades as applied

### `kbengine.hotReload.retryFailed`

- Title: `Retry Failed Hot Reload Targets`
- Purpose: re-send only the failed targets from the hot-reload ledger through the real quick-action entry (IDE-REV-026 / HOT-007); confirmed-successful targets (applied / accepted / sent-unverified — already delivered) are not re-sent, so their send count does not increase (a re-send would be a duplicate delivery)
- Behavior:
  - Runs under a cancellable progress notification; the cancellation token is probed before each hop — once cancelled, remaining targets are marked 跳过(已取消) and never sent (completed sends are kept, un-started ones never masquerade as sent)
  - The re-send resolves the action by reverse lookup on the quick-action tree (named registered actions and scanned scripts first; index-aligned `@http:` entries last); a target with no resolvable action is reported honestly (找不到以 … 为接收方的动作) and skipped without invoking anything
  - Ledger accounting goes through the same existing faces as the fire path: no-response-face actions record sent-unverified / failed; real HTTP responses are classified by transport fact (2xx = delivered-unverified, non-2xx = failed); a 2xx body is run through the accepted/applied upgrade and the settle window — so a successful retry turns the ledger page instead of leaving a stale failed record
  - The report (resent / not-resent / cancelled counts plus per-target lines with the re-send result) is written to the 「KBEngine 热更新」 channel and the channel opens; an empty ledger reports 无投递记录，没有可重试的目标 honestly

### `kbengine.hotReload.showRevisionEvidence`

- Title: `Show Hot Reload Revision Evidence`
- Purpose: render the revision evidence per (target, file) from real send results into the 「KBEngine 热更新」 channel — each evidence kind named with its own source label, never masquerading for another (IDE-REV-027 / HOT-008)
- Behavior:
  - Three evidence kinds, each labeled: fileHash（本地文件内容哈希重算） — sha256 recomputed locally over the file's current content through the same read channel as the applied-verify digest basis; semanticHash（结构语义指纹） — for `.def` files only, the sha256 of the structural fingerprint (property `{Type,Flags}` + method arg-signature face; comments/whitespace/order do not change it); engineDigest（运行时回执报告） — the digest the runtime reported in a receipt, kept in a session register that attributes it only to the file the receipt echoes verbatim
  - Cross-kind comparison never happens: a local hash is not runtime evidence, so even coincidentally equal values are just two separately-labeled lines — no 「一致」 claim across kinds (same-kind comparison is a protocol-internal verification means, not done on this surface)
  - Missing kinds stay missing: an unreadable file has no fileHash/semanticHash lines, a runtime that never reported a digest has no engineDigest line, a `.py` file has no semanticHash line — nothing is filled in to pretend
  - Both send paths feed the digest register: the fire path and the failed-target retry forward real HTTP receipt bodies to it; an empty ledger reports 无投递记录 honestly
### `kbengine.core.showShadowDiffLog`

- Title: `Kode Core Shadow: Show Diff Log`
- Purpose: open the 「KBEngine Core Shadow」 OUTPUT channel holding the dual-track shadow diff log (kode2 PR-012). Entries only exist in `kbengine.core.backend=shadow` mode: TS keeps serving while same-parameter requests are mirrored to kode-server and the outcome (match / diff / rust-error / rust-timeout / rust-unavailable) is logged per request
- Behavior:
  - In `shadow` mode: shows the channel (creating it on first shadow entry); with no entries yet it reports the summary honestly instead
  - In `ts`/`rust` mode: no channel exists — an info notice states the current `backend` value and that the log is empty; nothing is created
  - Rust results never affect any user-visible behavior in any mode; the log is diagnostic evidence for parity expansion and the rollback drill, not a serving path

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

### `kbengine.python.serviceStatus`

- Title: `Check Python Language Service Status`
- Purpose: report whether the Python language service (`ms-python.vscode-pylance`) is available, in one of three states: 已激活 (active), 未启用 (installed but not active in this window — disabled or not participating), 未安装 (neither registered nor found on disk)
- Classification inputs: registration in `vscode.extensions.all`, its `isActive` flag, and the `<id>-<version>` install directory under the local user extensions dir (disabled extensions never appear in `extensions.all`, so the disk probe is the fallback evidence)
- Honesty rule: whether `python.analysis.extraPaths` has been written never participates in the availability decision; when it has a value, the message appends the explicit caveat 「extraPaths 已写入不等于语言服务可用」 (written ≠ available)

### `kbengine.project.import`

- Title: `Import Existing KBEngine Project`
- Purpose: import an existing KBEngine project into the extension's project profiles: pick the assets root, review the identified faces, confirm to create a profile with a persistent stable ID
- Identification (existence probing only, nothing is written to disk): the `entities` (entities.xml), `defs` (entity_defs) and `scripts` faces come from the shared convention chain (the same one the discovery report uses); `scripts` is the directory holding entities.xml (the assets root itself when entities.xml sits at the top); the `engine` face probes the `kbe/` source anchors under the assets root, its parent and its grandparent (the engine repo is usually a sibling of the assets root)
- Preview: a QuickPick lists all four identification results with exact paths; a face that is not found is shown honestly as 「未识别」 (not identified)
- Behavior:
  - Picking 「导入」 (import) creates the profile (display name = assets root folder name) and reports its ID plus the Python interpreter state (setting if it exists → PATH → explicitly missing); Esc or dismissing any step writes nothing
  - A folder where all of entities/defs/script are missing is rejected with a warning before any preview (no junk profiles)

### `kbengine.project.create`

- Title: `Create Minimal KBEngine Project`
- Purpose: generate an importable empty KBEngine project from the minimal template manifest and register it as a project profile in one command
- Template manifest: a fixed list of directories and files (scripts layout aligned with the shared discovery conventions — scripts/entities.xml, scripts/entity_defs/types.xml, plus the scripts/base and scripts/cell server role dirs); the engine repo is not part of the template, so `engineRoot` is recorded honestly as empty
- Generator protections, all inherited:
  - Refuse on conflict: before any preview, every target path is probed; any existing target (file or directory) is reported with its exact path and the creation is aborted without writing anything
  - Preview: the shared generator QuickPick lists one row per manifest entry (新增目录/新增文件 with the exact absolute path); only picking 「确认生成」 proceeds, Esc writes nothing
  - Atomic writes and rollback: files land via atomic write (temp file + rename); if any step fails, everything created this run is rolled back (files first, then directories in reverse order, plus the implicitly created target root when it did not exist before) and the failure is reported
- Behavior: after a successful creation the profile is built through the same identification chain and identity store as the import command (display name = target folder name), and the message reports the profile ID plus the Python interpreter state (setting if it exists → PATH → explicitly missing)

### `kbengine.project.selectActive`

- Title: `Select Active Project Profile`
- Purpose: choose which project profile is the active one; the selection is persisted by stable ID (workspaceState) and each real switch fires exactly one change event (other features subscribe to it to react to profile switches)
- Picker: a QuickPick lists every profile with its display name and stable ID; picking one persists the selection and reports it
- Honesty rules:
  - The selection is keyed by stable ID — renaming a profile never loses the selection; re-picking the already-active profile is not a switch and fires no event
  - An unknown ID is refused (nothing persisted, nothing fired); a selection whose profile record was later removed resolves honestly to null instead of pretending to be valid
  - With no profiles at all the command says so and never opens the picker

### `kbengine.profile.health`

- Title: `Show Active Profile Health`
- Purpose: summarize the active profile's health to the workbench, one issue kind per row with a concrete navigation entry; the active profile is resolved through the stable-ID selection (see `kbengine.project.selectActive`)
- Issue kinds and entries (each issue carries its own entry):
  - 根歧义 (roots ambiguous — the profile's assets root no longer exists on disk) → re-run `kbengine.project.import`
  - 缺引擎 (engine missing — engine root not recorded, or no longer on disk) → re-run `kbengine.project.import`
  - 缺解释器 (interpreter missing — not recorded, or no longer on disk) → open the `kbengine.python.interpreterPath` setting
  - 缺语言服务 (language service unavailable — the PRJ-005 three-state check reports anything other than 已激活) → run `kbengine.python.serviceStatus`
- Behavior:
  - No active profile → an honest message pointing at the selection command, no picker
  - All healthy → a single health message, no warnings, no picker
  - Issues → a warning with the count, then a QuickPick listing each issue (label = kind, description = the deciding fact, detail = the navigation entry); picking a row navigates to its entry (command or settings), Esc leaves the list without navigating

### `kbengine.extension.identity`

- Title: `Show Extension Identity Report`
- Purpose: report the identity of every installed extension under this publisher and where it is hosted, so a bug report can tell exactly which build the user is running
- Report contents (output channel 「Kode 扩展身份」 (Kode extension identity), copyable whole):
  - Host location: `remote(<name>)` when `vscode.env.remoteName` is set, `local` otherwise, plus the host app name
  - For each matching install (publisher-prefixed extension IDs, sorted): full ID and version; `installed=yes|no` — whether the install directory currently exists on the file system (a vanished directory is reported honestly); `active=yes|no` — whether it is activated in the current window (installation and activation are two orthogonal facts, never merged); `side=workspace host|ui host` — which extension host runs it
  - With no matching installs the report says so instead of listing nothing
- Behavior: the command never scans the workspace; it only reads `vscode.extensions.all` and stats the install directories

### `kbengine.diagnostics.exportReproSummary`

- Title: `Export reproduction config summary`
- Purpose: one-page export of "what the environment looks like" for reproducing a diagnostics report — active versions, roots, host role, switches, and queue data, with sensitive connection information masked
- Report contents (output channel 「Kode 复现配置摘要」 (Kode reproduction config summary), copyable whole):
  - Host role: `local` or `remote(<name>)` plus which extension host side (workspace host | ui host) the window runs
  - Active versions: every `cuihairu.`-prefixed extension as `id@version active=yes|no side=…`, plus the build commit of this install (`out/buildCommit.json`; `unknown` is reported honestly when unreadable)
  - Roots: workspace folders, index scan roots, and the active profile (`displayName`, assets root, engine root; "none" when no profile is selected)
  - Switches: every boolean `kbengine.*` setting contributed by the extension itself (enumerated from its own `package.json`, so the list stays in sync with the configuration surface), rendered `on|off`
  - Queue data: diagnostics queued/in-flight, pending document-update annotations, index tasks queued, schema cold builds, plus language-service operations currently on the ledger (the IDE-MET-008 counts)
  - Connections (masked): the engine dbmgr database interface config rendered as `host=… port=… database=… username=*** password=*** encrypt=…` — the username and password values are never written, and the whole report is passed through a masking pass that rewrites `password=`/`token=`/`secret=`/`authorization=` assignments and URL userinfo to `***`
- Behavior: rendering is a pure function in `src/reproductionSummary.ts`; collection reads only existing faces (`resolveDatabaseInterfaceConfig`, `resolveActiveProfile`, index scan roots, the diagnostic scheduler, the language-service metrics ledger) and the extension's own `package.json`

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

### `kbengine.quickActions.runByName`

- Title: `执行快速动作`
- Purpose: run one quick action by its exact name; the name arrives as the command argument (Command Palette "Run Selected Command", a keybinding, or a programmatic `commands.executeCommand`). Names registered by HTTP capture resolve through the HTTP request service first, then the regular quick-action list
- Entry points: Command Palette with argument; internal callers (e.g. the HTTP captured-action re-run path)
- Behavior: identical execution chain to `kbengine.quickActions.show` (variable substitution → confirmation → dispatch → log); when no action matches the given name it reports the same missing-script error style

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
- Coverage: `KBEngine.pyi` is a curated subset of engine symbols, not a complete engine API; the header states the coverage, and every symbol keeps an original engine typings `file:line` anchor
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
- References and sources: a `FIXED_DICT` property may reference another custom type (such as `PLAYER_ID`); the generator preserves that name reference and emits `# source: types.xml:<line>` per class/property. Generated line numbers must not be used to infer source lines
- Entity-level types: when a `.def` property references a `types.xml` custom type, activation also generates `entity_types.pyi`, materializing per-entity declarations such as `Avatar.profile: ITEM_INFO`; source comments keep both original `.def` and `types.xml` lines
- Same directory and switch as `kbengine.python.exportStubs`: the `kbengine.python.stubDir` three-tier resolution, sharing the `kbengine.python.stubExport` switch; exported once automatically at activation, after KBEngine.pyi (silently)
- Behavior:
  - Deterministic content: the same input produces byte-identical content (no timestamp in the header), following the same zero-write-when-unchanged, rewrite-when-stale discipline as KBEngine.pyi
  - Alias assignments are module-level eager evaluations, emitted in dependency topological order; types with empty `types.xml` directives or alias cycles are skipped with the reason stated in the message — no assignment referencing an undefined name is ever generated
  - The built-in type mapping shares the table with the TS generator: integers → `int`, floats → `float`, strings → `str`, vectors → fixed-length `Tuple`, `PY_DICT/PY_TUPLE/PY_LIST` → typing generics, no counterpart → `Any` (lossy but valid)
  - An existing `kbe_types.py` in a configured user directory is treated as a user asset and never overwritten; the default directory `.kbengine/stubs` is kode-managed
  - When a workspace has no custom types, no file is generated and no message disturbs; after a successful export it chains one extraPaths sync
- `types.xml` on disk regenerates automatically: after a save/create/delete the watcher silently re-exports (no debouncing, no extra setting — the zero-write discipline makes repeated triggers side-effect free; with `kbengine.python.stubExport` off it effectively stops)
  - Setting `kbengine.python.stubExport: false` turns it all off (shared with the KBEngine.pyi stub export)

### `kbengine.source.reveal`

- Title: `Reveal Source Location`
- Purpose: internal navigation helper that forces an editor reveal for a definition-jump target. When a definition provider opens a document with `vscode.open` while that document is already the active editor, VS Code skips the reveal — observed as "clicking the same def link again after going back does nothing"; this command opens the document and forwards the selection so the target line is always revealed (batch 159 def-chain mirror links)
- Behavior:
  - Takes `{ selection: vscode.Range }` as the second argument and applies it via `showTextDocument(uri, { selection })`
  - No-op when invoked without a URI
  - Exists for definition providers, not as a user-facing entry point: it is registered like every contributed command (with its `onCommand:` activation event) so the palette stays empty while programmatic jumps can rely on it

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

When `kbengine.debug.remoteTargets` is configured, `Update launch.json` appends each remote target as its own debugpy `connect` configuration (`connect: {host, port}`; `pathMappings` is written only for entries carrying both `localRoot`/`remoteRoot`).

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

### `kbengine.build.previewTask`

- Title: `Build: Preview Task Description`
- Purpose: preview the exact build task derived from the active profile (IDE-TSK-001) — a script compile check of the profile's assets: the shown command line, working directory and environment are literally what the task runs (the Tasks view registration arrives with TSK-002's TaskProvider, using this same spec)
- Entries: command palette
- Behavior:
  - resolves the active profile (assets root + interpreter) and derives the spec: `<interpreter> -m compileall -q <assets>/scripts` with cwd `<assets>` and `PYTHONUTF8=1` (stable UTF-8 output for compileall error lines, no garbled paths on GBK consoles)
  - a profile without an interpreter falls back to `python3` from PATH, and the fallback is stated in the preview itself — what you see is what runs
  - the preview dialog shows the task type, name, `cd` line, full command line (paths with spaces quoted per shell word-splitting), each env entry, and the interpreter-provenance line
  - no active profile: an honest message points at picking one first
- Boundary: this command only previews; executing the build is TSK-002's task registration, and mapping compile errors to source locations is TSK-003's problem matcher

### `kbengine.tests.list`

- Title: `Tests: List Project Python Tests`
- Purpose: discover the Python tests the project declares (IDE-TSK-004) — a QuickPick of the test files found, scoped strictly to the selected profile
- Entries: command palette
- Behavior:
  - resolves the active profile and scans only its scripts root (`<assets>/scripts`, recursively) for `test_*.py` / `*_test.py` — pytest/unittest's common naming convention; other `*_assets` roots and the engine checkout in the workspace are dependency libraries and structurally never enter the list (discovery starts from the profile's scripts root and takes no other entry)
  - hidden directories and `__pycache__` are skipped; within each file, statically visible cases are parsed (`def test_*` functions and `class Test*` methods) with line and column, shown as the item's case count and names
  - picking a file opens it in the editor; Esc opens nothing
  - nothing found: one honest message names the scripts root and the naming convention — no empty list
  - no active profile: an honest message points at picking one first
- Boundary: this command discovers and lists; running individual tests in the Testing panel is TSK-005

### `kbengine.messagetable.preview`

- Title: `MessageTable: Preview Entity Message Table`
- Purpose: preview a single entity's message table (IDE-SDK-001) — pick an entity and view the existing computed result (methods by section, utypes, alias config, issue list) as markdown
- Entries: command palette
- Behavior:
  - waits for the entity index's initial scan, then offers the indexed entity names in a sorted QuickPick
  - picking an entity builds the table from the same scan-roots/def-loader formula the index uses and shows the rendered markdown in a preview document
  - missing declaration (the entity's def cannot be loaded — not registered or the `.def` file is absent): one honest warning naming the entity and the cause — no empty preview, no guessing
  - no entities indexed at all: an honest warning says so; Esc quietly exits
- Boundary: preview only; JSON export is SDK-002

### `kbengine.messagetable.export`

- Title: `MessageTable: Export Entity Message Table JSON`
- Purpose: export a single entity's message table as JSON (IDE-SDK-002) — the output preserves the method sections, utypes, alias configuration, and the issue list (renderMessageTableJson's existing face)
- Entries: command palette
- Behavior:
  - same entity QuickPick and the same shared build face as the preview command
  - a save dialog proposes `<entity>.messagetable.json`; cancelling it creates no file (nothing is written)
  - a missing declaration gets the same honest warning as preview — no file is proposed
  - a write failure is reported verbatim with the cause; success names the written path
- Boundary: export only; the preview command is SDK-001
