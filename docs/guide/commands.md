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

### `kbengine.defMethodConsistency.revalidate`

- Title: `Revalidate Def Method Consistency`
- Purpose: recompute the def↔Python method-consistency diagnostics of a `.def` document (forward `def-method-missing-in-python` and reverse `python-method-not-in-def`); runs automatically after the one-click generate-implementation CodeAction applies its edit, so the diagnostic clears without waiting for the next save — with a `.def` URI argument (command palette run is a no-op)
- Entries:
  - Automatic: appended by the generate-implementation CodeAction on `.def` method symbols
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

### `kbengine.source.reveal`

- Title: `Reveal Source Location`
- Purpose: internal navigation helper that forces an editor reveal for a definition-jump target. When a definition provider opens a document with `vscode.open` while that document is already the active editor, VS Code skips the reveal — observed as "clicking the same def link again after going back does nothing"; this command opens the document and forwards the selection so the target line is always revealed (batch 159 def-chain mirror links)
- Behavior:
  - Takes `{ selection: vscode.Range }` as the second argument and applies it via `showTextDocument(uri, { selection })`
  - No-op when invoked without a URI
  - Exists for definition providers, not as a user-facing entry point: it is registered like every contributed command (with its `onCommand:` activation event) so the palette stays empty while programmatic jumps can rely on it

## Player Data Clone

### `kbengine.clone.configureSource`

- Title: `Configure Clone Source Connection`
- Purpose: store the read-only source database profile for player-data export (CLONE-P5)
- Entries: Command palette
- Behavior:
  - Sequential inputs: host, port (digits only, empty = 3306), user, password (stored only in SecretStorage, never in the profile; empty = not saved), database name
  - A cancelled input ends the command with nothing saved

### `kbengine.clone.configureTarget`

- Title: `Configure Clone Target Connection`
- Purpose: store the writable target database profile for player-data import (CLONE-P5)
- Entries: Command palette
- Behavior:
  - Same input flow as the source profile, plus an explicit environment picker that accepts only `local` / `test` — prod or staging values are rejected at this config gate before the Rust planner's fail-closed re-check
  - The password goes only to SecretStorage; clearing the config clears the secret too

### `kbengine.clone.testSource`

- Title: `Test Clone Source Connection`
- Purpose: verify the stored source profile with a real `SELECT VERSION()` (CLONE-P5)
- Entries: Command palette
- Behavior:
  - Success reports the server version; failure reports the connection cause honestly; a missing profile says so and runs nothing

### `kbengine.clone.testTarget`

- Title: `Test Clone Target Connection`
- Purpose: verify the stored target profile with a real `SELECT VERSION()` (CLONE-P5)
- Entries: Command palette
- Behavior:
  - Success reports the server version; failure reports the connection cause honestly; a missing profile says so and runs nothing
- Entries: Command palette
- Behavior:
  - Success reports the server version; failure reports the connection cause honestly; a missing profile says so and runs nothing

### `kbengine.clone.export`

- Title: `Export Player Data to Archive`
- Purpose: export one player entity's persisted rows to a `.kdpclone` archive (CLONE-P5)
- Entries: Command palette
- Behavior:
  - Pick a registered entity, enter the root DBID (digits only), then choose the save path (`.kdpclone`)
  - The source session is opened read-only; physical tables are probed via `information_schema` (identifiers validated) and the read-only SELECT plan comes from the Rust core (`$/kode/dbClone/planExport`); without the Rust backend the command reports that honestly instead of pretending
  - The plan preview (tables / row budget / missing tables) is printed to the 「KBEngine Player Clone」 channel and requires an explicit confirm before any query runs; execution is cancellable (cancel stops read-only work, nothing to roll back)
  - Sensitive columns are redacted on write by default; a DBID with zero rows exports nothing and says so

### `kbengine.clone.inspectArchive`

- Title: `Inspect Player Clone Archive`
- Purpose: show a `.kdpclone` archive's manifest (CLONE-P5)
- Entries: Command palette; explorer context menu on `.kdpclone` files
- Behavior:
  - Prints entity, format/version, row counts per table, encryption flag, and the presence of `checksums.json` / `redaction-report.json` — never any row values
  - Every view repeats the notice: this is a persisted database copy (Persisted copy), not the online current state (Live state)

### `kbengine.clone.import`

- Title: `Import Player Data from Archive`
- Purpose: import a `.kdpclone` archive into the configured local/test target database (CLONE-P5)
- Entries: Command palette; explorer context menu on `.kdpclone` files
- Behavior:
  - Two-pass planning: pass-1 derives the column order, the unique values that actually occur in the archive are probed with bounded `WHERE IN` reads, pass-2 rehearses conflicts (local rebuild with an `_imported` suffix)
  - The preview channel shows statements per table, ID change categories, unique conflicts, account binding, unresolved-reference risks and warnings — then two explicit confirmations are required (continue, then confirm the real write to the local database)
  - The whole plan applies in a single mysql2 transaction: new keys bind NULL for AUTO_INCREMENT, insert ids backfill into key references, any failure or cancel rolls back — never half a role; afterwards per-table COUNT verification runs, a reverse-topology cleanup plan is generated but never executed, and an audit JSON lands under `.kode/clone-runs/`
  - Engine-side native load verification stays honestly unattempted (`load_verification.attempted=false`); the wired verification surface is the COUNT check

### `kbengine.clone.showAudit`

- Title: `Show Player Clone Import Audits`
- Purpose: replay a past import run's audit JSON from `.kode/clone-runs/` (CLONE-P5)
- Entries: Command palette
- Behavior:
  - Picks among existing audit files and prints the content to the 「KBEngine Player Clone」 channel; no audit files yet says so
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

### `kbengine.server.retry`

- Title: `Retry Failed Target`
- Purpose:
  - With a component argument, retries that single failed target
  - Without one, offers a picker of targets whose group start failed (with the failure reason), and retries the selection
  - Ready targets are reported as already-running and are not restarted

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
- Purpose: generate or update VS Code's PID attach configuration from `pathMappings` in `.kbengine/debug.json`; when `kbengine.debug.remoteTargets` is configured, remote targets are appended at the same time as debugpy `connect` entries; a component with a configured `debugpyPort` (or a remembered port mode) additionally gets one debugpy `connect` entry pointing at its actual port — same name and shape as the port-mode dynamic write, so re-running never wipes the port mode's F5 landing spot
- Behavior: only `KBEngine:`-prefixed entries are replaced — user entries and `inputs` are kept as-is; a `.vscode/launch.json` carrying comments (JSONC) or broken syntax is refused with the reason stated (rewriting would lose content), never written blind; the read-modify-write runs behind a serial gate, so a concurrent port-mode dynamic write loses no entries

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
  - A port that is still closed moves on to the "next step" guidance instead of stopping (no dead end): the notice carries the latest not-listening cause, the three listening paths and the launch.json landing spot, with three controls — `起监听并附加` (make sure debugpy is synced into `<assets>/scripts/common/debugpy` first, wait for the component's telnet to be ready, send `debugpy.listen` through its `:python` layer, then re-probe the port and attach right away; a failure is reported as it is, never faked) / `重试附加` (re-probe directly — if the listener came up elsewhere it just connects) / `起监听指引` (the three paths plus a copyable `python -m debugpy --listen 127.0.0.1:<port> --wait-for-client <entry script>`)
  - Every port-mode attach idempotently writes that component's `host:port` connect entry into `.vscode/launch.json` (`type`/`request`/`connect`; user entries and hand-edited fields kept as-is, superseded same-component port entries recycled; a file with comments or broken syntax is refused with the reason stated) — Run and Debug can F5 straight into it
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

### `kbengine.debug.debugpyInject`

- Title: `Inject debugpy Listener and Attach`
- Purpose: one-shot debugpy automation (KODE-DBG-001, the console-injection option of docs/design/debugpy-attach.md) — send `debugpy.listen` over the component's telnet `:python` layer, then attach in port mode; no engine changes, no file edits
- Entry: command palette
- Behavior:
  - Lists the running components (default instances by name, named instances as `component#instance`); cancelling the pick does nothing
  - Port: the per-component table (baseapp 5678 / cellapp 5679 / loginapp 5680 / dbmgr 5681 / logger 5682, otherwise 5678), bound to `127.0.0.1` only
  - Listener: reuses the existing one-shot path — syncs the assets-tree debugpy package if missing, waits for telnet readiness, injects through a short-lived telnet client; a failed injection reports the reason and never attaches
  - Attach: once the listener is up, reuses the port mode of `Attach to Component` (probe → connect); if the attach does not complete, the error points to `Attach to Component` for a retry
  - Gated by `kbengine.debug.debugpyInject` (default on); when off, the command only says so and does nothing
  - Early-startup breakpoints are not this command's job — use `kbengine.debug.waitAtStartup` (the bootstrap option of the same proposal)

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

### `kbengine.debug.pyspyFlamegraph`

- Title: `Collect Flame Graph with py-spy`
- Purpose: py-spy flame graph entry (IDE-PYSPY-001) on the Servers tree, flame icon (`$(flame)`) after the dump icon; runs `py-spy record --format flamegraph` on the target component process, landing a sampling-window call stack as an SVG flame graph and opening it in the editor
- Entry: Servers tree inline icon (after the dump icon), or the command palette
- Behavior:
  - Frictionless defaults: 10s window, 100 samples/s, `--nonblocking` (never pauses the target) — one click collects
  - Timed/periodic collection: two input boxes configure "collect X times every N seconds" (defaults 1 run / every 5s, integer-validated); with X>1 each run lands `flame-<timestamp>-<index>.svg` (output dir `~/.tmp/kode-pyspy-flamegraphs`), any failure stops the run and keeps already-collected files
  - Missing py-spy reuses the one-click install chain (same as dump); a successful collect opens the SVG in the editor (VS Code native image preview), per-run results go to the `KBEngine py-spy` output channel
- Behavior (remote): flame graph record supports local components only for now — a remote dispatch says so honestly and suggests `py-spy dump` for call stacks (remote file retrieval is a follow-up)
- Prerequisite: the target process must be a Python process visible to py-spy; ptrace permission as with dump

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

### `kbengine.lintRules.showReport`

- Title: `Show Lint Rules Capability Report`
- Purpose: print the lint rule capability list into the `Kode Lint Rules` output channel — each rule's spec number / diagnostic code / severity / applicable roles / config toggles / trigger entry / quick-fix support / evidence source module / implementation status, grouped as implemented / hint-only / pending with a per-rule enabled/disabled mark under the current configuration (IDE-LINT-011; single source of truth `src/lintRuleRegistry.ts`, rule numbering follows the `kbengine-lint-rules.md` rule table)

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
  - listening: reports the debugpy port with two next-step controls — `立即附加` (runs the whole port-mode chain, falling into the next-step guidance when the port is closed) and `打开 launch.json` (writes that port's connect entry first, then opens it; a failed write is stated honestly); a named-instance row (`component#instance`) only offers `打开 launch.json` (attach follows the component's configured port and would target the wrong instance, so the control is honestly withheld)
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

### `kbengine.consoleLogTail.show`

- Title: `KBEngine Console: Show Live Log Tail`
- Purpose: open the 「KBEngine Console 日志」 Output channel carrying the live 65501 push stream from the engine logger (guiconsole line, KB-GC-001)

### `kbengine.consoleLogTail.toggle`

- Title: `KBEngine Console: Start/Stop Live Log Tail`
- Purpose: start/stop the tail long connection (702 register / 703 deregister). Explicit user intent overrides the `kbengine.consoleLogTail.enabled` default-on gate (missing config counts as ON, only explicit `false` turns it off)

### `kbengine.consoleComponentPanel.refresh`

- Title: `Refresh Component Status`
- Purpose: run one machined discovery round and repaint the component status view (same hub the tail uses; also the view title bar refresh button)

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

### `kbengine.pythonCallGraph.show`

- Title: `Show Python Call Graph`
- Purpose: open the Python method-level call graph (same panel as the entity dependency graph, in callgraph mode)

The callgraph mode panel supports:

- Collecting all `*.py` files under the workspace roots (excluding `node_modules`/`out`/`.vscode-test`/`.git`) and sending their text to the Rust core
- Method-level call edges classified into 8 kinds (local / method / self-method / kbe-broadcast / kbe-base-clients / kbe-cross-process / kbe-api / unknown), each with a dedicated arrow and color
- Unresolved callees rendered as stub nodes (`ext:` / `kbe:` prefixes) so call sites are never dropped
- Cross-file callers (via `reverseIndex`) feeding the kode-scheduler invalidation DAG
- Clicking a node opens the corresponding `.py` file
- Export SVG / PNG

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

### `kbengine.entity.new`

- Title: `New KBEngine Entity`
- Purpose: generate a loadable new entity in three steps (name → property template → entity form)
- Entry points: command palette, or right-click a folder in the Explorer (`entity_defs` only; other folders get a hint and abort)
- What gets generated in one pass:
  - `entity_defs/<Name>.def` skeleton with common sample properties (`name`/`hp`/`position`) plus a TEMP property (`Persistent=false`), and one property-template sample: simple `UINT32`, inline `ARRAY<of UINT32>`, or a FIXED_DICT named type
  - Per-part scripts following the engine convention — class name exactly `<Name>` extending `KBEngine.Entity` — written to `scripts/base/<Name>.py` / `scripts/cell/<Name>.py` (hooks: `onTimer`, `onWriteToDB(self, cellData)` on base, `onEnterWorld`/`onLeaveWorld` on cell)
  - `scripts/client/<Name>.py` client stub when the chosen form includes Client
  - FIXED_DICT template auto-registers its named type in `types.xml` (no `implementedBy` — default serialization loads as-is)
  - `<Name>` registration in `entities.xml`
- `__init__` guards follow the GEN-DEF-1 convention: `if self.<prop> is None:` only for ARRAY/FIXED_DICT properties, and only in the part whose Flags domain includes the property; simple types get no guard and `if not self.` is never emitted
- Project-level templates override the built-in skeletons: `.kode/templates/new-entity.def`, `new-entity.base.py`, `new-entity.cell.py`, `new-entity.client.py` with `{{Name}}`/`{{ClassName}}` placeholders (unknown placeholders are kept verbatim)
- Behavior: preflight aborts on any existing target (no partial generation), a confirm screen lists every landing spot before writing, a failed pass rolls back created files (including the `types.xml` insertion), and after a committed pass the entity explorer is refreshed so the new def/script pair is indexed immediately

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

### `kbengine.liveObservation.openExceptionSource`

- Title: `Open Exception Source Location`
- Purpose: jump to the workspace file and line named by a runtime exception line (Python traceback or engine log `file.py:line`); when no workspace source matches, the raw exception line is preserved in the warning message instead of a guessed jump

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

### `kbengine.bots.add`

- Title: `KBEngine: Add Bots (telnet addBots)`
- Purpose: drive the engine `bots` process (the client-simulator load tool) to add simulated clients at runtime — the local closed loop (IDE-BOT-001); the bots process carries its own telnet python layer (default port 51000), so no process restart is involved
- Inputs: total count (≥1, required); optional batching — per-batch count (≥1) and interval seconds (≥0, empty = 0); leaving the batch empty sends one-shot
- Behavior:
  - The command string mirrors the engine API form exactly: one-shot `KBEngine.addBots(5)`, batched `KBEngine.addBots(1000, 5, 10)`
  - The whitelist gate is never bypassed: addBots is a write operation (mass login), so with `"KBEngine.addBots"` missing from `kbengine.telnet.enableCommands` the command refuses to send and names the exact entry to add
  - When the count query is whitelisted too (`"len(KBEngine.bots)"`), the current bot count is queried right after adding and written to the output channel
  - Honest bounds: the engine has no per-bot destroy API (the `KBEngine.bots` dict is read-only) — reducing bots = stopping the bots process; every send writes this into the output channel, and no per-bot metrics are fabricated
  - Failure modes are honest: no bots telnet target (telnet not configured, or a single custom port excludes component targets) → told how the target derives; session not ready within the bounded wait → reported, nothing sent

### `kbengine.bots.count`

- Title: `KBEngine: Query Bot Count (len(KBEngine.bots))`
- Purpose: query the current bot count through the bots telnet python layer
- Behavior:
  - Sends `len(KBEngine.bots)` over the bots target's session and reads the result line within a bounded wait (~2s); the parsed number goes to the output channel
  - No numeric line in time is reported as such — no fabricated count
  - Requires `"len(KBEngine.bots)"` in `kbengine.telnet.enableCommands` (read-only, but not a built-in quick command); a missing entry is named in the error

### `kbengine.playerData.refresh`

- Title: `Refresh Player Data Profile`
- Purpose: re-derive the MySQL connection profile from the engine config and refresh the read-only "Player Data" tree
- Source of truth: Rust `derive_database` reads `dbmgr/databaseInterfaces/default` from the component `kbengine.xml` + engine `kbengine_defaults.xml` (leaf defaults per the engine: host `localhost`, port 0 → 3306, username `kbe`, database `kbe`, charset `utf8mb4`)
- Read-only constraint: the view never offers editable fields — connection facts come from the engine config only

### `kbengine.playerData.testConnection`

- Title: `Test Database Connection (Read-Only SELECT 1)`
- Purpose: probe the derived MySQL endpoint with a whitelisted `SELECT 1` through the read-only executor (`SET SESSION TRANSACTION READ ONLY` + statement whitelist)
- Behavior:
  - Success reports host:port/database plus latency; failure degrades honestly to a message (never blocks other features)
  - When the engine password is RSA-encrypted (`<encrypt>` not `false`) it is never decrypted — the command reports "not tested" instead of guessing

### `kbengine.playerData.queryByDbid`

- Title: `Query Player by DBID (Read-Only)`
- Purpose: run a single read-only ``SELECT * FROM `tbl_Account` WHERE `id` = <dbid>`` (table prefix from `kbengine.db.tablePrefix`, default `tbl_`) and print the rows to the "KBEngine 玩家数据(只读)" output channel
- Input validation: the dbid must be a decimal positive integer; anything else is rejected before any connection is made
- Read-only constraint: results are displayed only; no editing, no export side effects (export/import live in the dedicated Player Data Clone lane)

### `kbengine.playerData.previewRedisKeyspace`

- Title: `Preview Redis Keyspace (Read-Only)`
- Purpose: list the redis keyspace of the derived backend (active when the database profile type is `redis`), classified per the engine's own key model (`kbe_entitylog:<dbid>:<type>` per `kbe/src/lib/db_redis`) — it never invents MySQL-style table structures
- Behavior:
  - Uses a minimal built-in RESP2 client (no new dependency); connection fields come from the connection registry's redis host/port/auth/db-index entries
  - Unreachable redis / connection failure degrades to an honest failure message (read-only degradation, other features unaffected); an empty keyspace reports "no kbe_* keys" instead of pretending success; a non-redis backend reports it is not previewed (redis-only surface)
  - Read-only constraint: `SCAN`/`TYPE` enumeration only — no writes, no deletes, no TTL changes

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
  - The status bar item `$(eye…) 热更: …` reflects the watch state machine: Watch Off (`kbengine.hotReload.enabled=false` or empty globs) → Ready (watchers built) → Sending (debounce elapsed, request fired) → Sent(unverified) → Failed; clicking the item runs `kbengine.hotReload.toggle` (one-key on/off), and the toggle notice's 「打开日志」 button opens this log
  - Honest semantics: a completed action without errors is only 「已发送(未确认)」 (sent, unverified) — no business receipt is verified, so the UI never claims the module was applied (receipt verification belongs to the HR-STATE series)
  - Each trigger logs time / trigger files (merged by debounce) / the debounce value, plus the request line and the outcome line (sent-unverified / failed); log lines are appended immediately and are not subject to the status-bar throttle
  - Running this command re-samples the disk versions and appends the HOT-VER version ledger (per in-scope tracked file: baseline version, disk version, then every version jump with its time, attempt, digest prefix and accepted/applied/failed outcome) before opening the channel; with no tracked file nothing extra is written
  - Hidden from the command palette (`when: false`) — reach it from the toggle notice's 「打开日志」 button or the first-run notice

### `kbengine.hotReload.toggle`

- Title: `Hot Reload: Toggle Auto Watch On/Off`
- Purpose: one-key on/off of automatic hot reload — writes `kbengine.hotReload.enabled` back to configuration (workspace settings when the window has a workspace file, otherwise user settings) instead of flipping an in-memory flag
- Behavior:
  - Hot reload is **on by default** (user order 2026-11-06); the command flips the effective value, and the configuration-changed listener tears down / rebuilds the watchers immediately — no window restart
  - Bound to the 「热更」 status bar item, so clicking the status bar is the one-key off; a non-modal notice confirms the new state and offers 「打开日志」
  - With no `kbengine.hotReload.actionName` set, a save sends the default hot-reload request `POST http://127.0.0.1:8090/hotfix?module_name=<module>` with body `module_name=<module>` (both carry it); an unreachable engine is reported as **failed** in the status bar and log, never as success
  - A failed configuration write is reported honestly (log + error notification) and leaves the status machine face untouched


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

### `kbengine.hotReload.filterByState`

- Title: `Hot Reload: Show Changed Files (Dirty/Sent)`
- Purpose: render the hot-reload attention set — files that changed but have not been (re)loaded — into the 「KBEngine 热更新」 channel and open it (IDE-HOT-100 / design §3.4)
- Behavior:
  - Attention set = DIRTY ∪ SENT only (「看哪些改了还没重载」); FAILED and RESTART_REQUIRED have their own dedicated command surfaces and are never mixed into this filter
  - The state is derived over the delivery ledger (rootId × targetId × file) with content sha256 as the change basis — never mtime, so touch/perm-only edits do not mark a file dirty
  - Each listed file shows its state, the baseline hash prefix, and the ledger detail (attempt generation / accepted annotation) — an empty attention set reports 无待处理 files honestly
  - Hidden from the command palette (`when: false`) — the status bar item is the intended entry

### `kbengine.hotReload.showFileState`

- Title: `Hot Reload: Show File State`
- Purpose: render the per-file hot-reload lifecycle state across every target that references it (invoked from the CodeLens status dot; IDE-HOT-100)
- Behavior:
  - The status dot (CodeLens) is derived from the same ledger-derived state machine: CLEAN (no badge) / DIRTY (orange) / SENT (blue) / APPLIED (green) / FAILED (red) / RESTART_REQUIRED (purple)
  - A file in the workspace root shows one line per target with its state, baseline hash prefix, send generation, and detail; a file outside any root reports 不在工作区根内 honestly
  - RESTART_REQUIRED is the HOT-005 structural-def gate: a structural def change blocks the whole batch and is surfaced as restart-required (a conservative hold, never a fake failure) — the reason text names the gate

### `kbengine.hotReload.configureChannel`

- Title: `Hot Reload: Configure Deployment Channel`
- Default keybinding: `ctrl+alt+r` (macOS `cmd+alt+r`), **no `when` narrowing** — available in any editor/workspace context out of the box, no user setup needed. Avoidance rationale: `ctrl+alt+h` is already the documented example key for `kbengine.httpRequest.run` in the configuration guide, and `ctrl+]` / `ctrl+d` belong to the telnet panel, so the hot-reload quick enable uses `ctrl+alt+r`
- How to change: edit it in Keyboard Shortcuts, or in `keybindings.json` **remove the default binding first, then bind the new key** (adding a new entry for the same `command` alone does not drop the default) —
  ```json
  [
    { "key": "ctrl+alt+r", "command": "-kbengine.hotReload.configureChannel" },
    { "key": "ctrl+shift+r", "command": "kbengine.hotReload.configureChannel" }
  ]
  ```
  On macOS write the **user** rule with a `key` field too (`keybindings.json` holds user rules, `mac` is not used there):
  ```json
  [
    { "key": "cmd+alt+r", "command": "-kbengine.hotReload.configureChannel" },
    { "key": "cmd+shift+r", "command": "kbengine.hotReload.configureChannel" }
  ]
  ```
- Conflict rule: when another command shares the key, Keyboard Shortcuts lists both and marks the conflict; keybindings are resolved **bottom-up, first rule whose `when` matches wins** — user rules sit after default rules, so a user binding (or the removal line above) takes precedence, with ties within one layer decided by actual order and context; this extension's own bindings never collide (test-locked)
- Purpose: per-ProjectProfile deploy-level hot-reload channel panel — the **first screen is a three-preset quick enable** (in-house receiver [recommended] / KBEngine official / unset, plus an "advanced" entry); picking a preset auto-fills the default parameters (local port/path), runs **one-shot connectivity probe, and enables only when the probe passes** (a single profile goes straight to the preset screen, multiple profiles pick one first — ≤2 steps total, zero input boxes). The multi-step flow (pick a channel → collect parameters → save or probe) stays under "advanced" (IDE-HOT-102 / design §5.1)
- Behavior:
  - Channel is stored per profile (`profile.hotReload`); **unset** restores the fallback to the existing `kbengine.hotReload.actionName` quick-action channel (the channel-less behavior is unchanged)
  - Two channels: `kbengine-official` (**depends on the engine `reloadScript`**, via console — host / port / optional password) and `http` (**the in-house receiver**, `scripts/hot-reload-receiver/referenceReceiver.mjs` in this repo, with the custom accepted/applied receipt contract — URL template with `${files}` / `${fileList}`, method, body template, optional headers)
  - **Preset quick enable**: the in-house receiver defaults to `http://127.0.0.1:8000/reload`, POST, body `{"files":${files}}` (**JSON object body** — only an object body gets `targetId`/`sender_digests` auto-attached by the transport, which is what lets the receiver answer `applied` after checking the digest; a bare `${files}` array body never reaches applied); parameters already configured on the same channel are kept rather than reset. The selection runs `transport.probe()` and **writes the profile only when the probe passes** — an unreachable endpoint is reported honestly as 探活不通,未启用 and points back to the advanced flow to check port/path; never silently enabled
  - Start the receiver on the preset port: `scripts/hot-reload-receiver/referenceReceiver.mjs` defaults to `--port 0` (random), so run **`node referenceReceiver.mjs --port 8000 --root <staging root> --mode apply`** — otherwise the preset URL's port 8000 honestly probes as unreachable
  - A **connectivity test** (inside the advanced flow) runs `transport.probe()` on the collected config without saving (probe never writes the profile); a malformed config is reported honestly (通道配置不完整) rather than guessed
  - Every step is cancellable and nothing is written until the final 保存 — cancel at any step reports `false` and leaves the profile untouched
  - The panel is a quick-pick + input flow (the existing profile-edit pattern); unknown ids save as 保存失败 and never silently create
  - **Callable with zero configuration**: with no profile it says so honestly (无部署 profile); with a single profile but no channel the first screen is already the preset list (multiple profiles pick one first), and passing `{ entry: 'advanced', profileId }` goes straight to that profile's advanced flow — never a silent no-op
- When a profile has a channel configured and is active, the fire path sends the whole reload batch through `transport.send` (receipts feed the per-target ledger directly) instead of the quick action; with no channel configured the actionName path is unchanged

### `kbengine.hotReload.switchChannel`

- Title: `Hot Reload: Switch Channel (Status Bar Quick Switch)`
- Purpose: the status-bar channel lamp's click entry — a three-preset QuickPick (in-house receiver [recommended] / KBEngine official / unset) that switches the active profile's hot-reload channel in one pick, probing immediately after the selection
- Behavior:
  - The lamp shows the current channel: `热更:自研HTTP` / `热更:KBEngine官方` / `热更:未配置`; with no active profile it honestly reads 未配置
  - Each option carries a `(当前)` marker; the selection writes the active profile's `hotReload` section (same persistence surface as `configureChannel`)
  - **Probe feedback**: green = default background + `$(plug)` + an "探活通过" info notice, then the profile is written; red = `$(error)` + the status-bar error background + an error notice carrying a **one-click repair** button (打开高级配置修参数) that jumps straight into that profile's advanced flow — the channel is neither switched nor written
  - The lamp text always names the **configured** channel (a failed probe leaves the config untouched, so the text stays on the old channel while the red mark and tooltip name the attempted one)
  - Green/red reflect only the latest probe verdict; as soon as the channel changes (profile switch or panel write) the stale verdict is dropped
  - The existing send-state lamp (behind `kbengine.hotReload.showLog`) keeps rendering only the send state; the two lamps sit at different priorities (96 / 98) so they never fight for the slot or the color

### `kbengine.hotReload.confirmDefBaseline`

- Title: `Hot Reload: Confirm Restart (Rebuild def Structure Baselines)`
- Purpose: rebuild the def structural-gate baselines after a real engine restart (F1, 2026-11-05 review) — baselines represent the structure version the target engine has actually loaded, and are only advanced by a real send (`commit`) or this explicit restart confirmation
- Behavior:
  - Re-baselines every def file the gate has seen this session to its current on-disk content and reports the confirmed file count in the hot-reload log + an info notice
  - Blocked batches (structural change / no baseline / unreadable) never advance baselines — without a restart confirmation the second save of the same blocked content stays blocked instead of silently passing on the rolled baseline
  - Unreadable files are skipped (not fabricated); the count reported is the number of files actually re-baselined

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

### `kbengine.python.selectInterpreter`

- Title: `Select Python Interpreter`
- Purpose: the interpreter status bar item's click target — the item itself shows the current interpreter (venv directory name, Python version when the probe succeeds, and a source badge: `auto` = workspace discovery, `configured` = the `kbengine.python.interpreterPath` setting, `PATH` = interpreter found on PATH; a missing interpreter says so plainly)
- QuickPick contents: the active interpreter first (✓), then every environment the workspace scan verified (evidence `pyvenv.cfg` for venv / `conda-meta` for conda, plus a real interpreter binary on disk — `bin/python` / `Scripts/python.exe`; broken environments without both are never listed), then the PATH interpreter, and 「创建新 venv…」 (create a new venv) last
- Effect: picking an entry writes `kbengine.python.interpreterPath` at workspace level and takes effect immediately (the resolution chain reads live configuration; no reload); Esc writes nothing

### `kbengine.python.createVenv`

- Title: `Create Virtual Environment (venv)`
- Purpose: one-shot venv creation: pick a target directory (default `<workspaceRoot>/.venv`) → run `python -m venv <dir>` inside a progress notification → verify the created directory directly (`pyvenv.cfg` + interpreter binary, independent of the scan depth so a target outside the scan range still qualifies) → auto-select and write the new interpreter into `kbengine.python.interpreterPath`
- Honesty rules: the base interpreter resolves through the PATH chain only (never through workspace discovery, which may be the environment being rebuilt) — when PATH has no python3/python the flow refuses with an explicit message and never spawns; an occupied (existing, non-empty) target directory aborts before any write; a non-zero venv exit reports the stderr tail; a created directory that verification cannot confirm (no `pyvenv.cfg` or no interpreter binary) is reported as such and never selected

### `kbengine.python.ruffLint`

- Title: `Ruff Lint Python Files (py37)`
- Purpose: lint the workspace's `.py` files via the Rust backend (`$/kode/ruff/lint`, crates/kode-server/src/ruff_lint.rs): the backend spawns ruff with `--target-version py37` locked (KBEngine 3.7.3) and `--no-cache` (never writes `.ruff_cache` into the workspace), then the command publishes the results as VS Code diagnostics (E9xx → error, everything else → warning; files with no findings are cleared)
- Bounds: at most 2000 files per call (the same cap on both the TS and Rust sides); beyond it the command reports the real count and the cap and runs nothing; a workspace with no `.py` files says so and runs nothing
- Honesty rules: ruff missing is reported as-is (`available:false` from the backend — never a silent empty pass); the backend unavailable (kode-server not reachable) is reported as a backend problem, not as 「no issues」
- Consent-based install (never silent): when ruff is missing the command asks first — 「安装(Install via pip)」 runs `<selected interpreter> -m pip install ruff` (on success the ruff binary is located in the interpreter's own bin directory and the lint re-runs with it), 「手动安装命令(Show command)」 prints the exact manual command into the 「KBEngine Ruff」 output channel; a failed install reports the error with the same manual command to run yourself, and the raw pip output always lands in the channel

### `kbengine.python.installRuff`

- Title: `Install Ruff via pip (Selected Interpreter)`
- Purpose: manual install entry — runs `<selected interpreter> -m pip install ruff`, then probes ruff again and reports the version found (or 未检出, honestly)
- Honesty rules: no selected interpreter refuses up front (pointing to `Select Python Interpreter` instead of guessing a python); a failed install reports the error together with the exact manual command (`"<python>" -m pip install ruff`, quoted when the path has spaces) so the user can run it themselves; the full pip log stays in the 「KBEngine Ruff」 output channel

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

### `kbengine.project.createDemoGame`

- Title: `Create Demo Game Project`
- Purpose: scaffold a playable mini-ARPG KBEngine project (login/avatar creation, monster spawning, combat with kill rewards and level-ups, death/respawn, headless bots) from the demo game template shipped with the extension, and register it as a project profile in one command
- Template payload: `templates/demo-game` inside the extension install directory — the game subset of the acceptance fixture byte-for-byte (base/cell/client/bots/common/interfaces/db/interface/logger/login scripts, entity_defs with the game entities, user types, res/server), with only `scripts/entities.xml` trimmed to the five game entities (Account/Spaces/Space/Avatar/Monster); a parity test pins the template to the fixture so neither side drifts alone
- Generator protections: identical to `kbengine.project.create` (refuse on conflict before any preview, the shared confirm QuickPick with one row per entry, atomic writes — file entries create their parent directories on demand — roll-back-everything-this-run on failure, profile registration through the import identification chain); a missing or empty template reports honestly and writes nothing
- Empty-workspace offer: when a window opens with exactly one workspace folder that has no non-dot entries (an empty directory), the extension proactively offers this command once via a notification (delayed ~2s after activation; dismissing runs nothing); the offer needs `onStartupFinished` activation because `workspaceContains` cannot express an empty folder



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
  - The built-in type mapping shares the table with the TS generator: integers → `int`, floats → `float`, strings → `str`, `VECTOR2/3/4` → `KBEngine.Vector2/3/4`, `PY_DICT/PY_TUPLE/PY_LIST` → `dict`/`tuple`/`list` with the `<Default>` literal refined when present, `PYTHON` → the def `impl` class when declared else `Any`, `ENTITYCALL` → `KBEngine.EntityCall`, `BLOB` → `bytes`, no counterpart → `Any` (lossy but valid)
  - An existing `kbe_types.py` in a configured user directory is treated as a user asset and never overwritten; the default directory `.kbengine/stubs` is kode-managed
  - When a workspace has no custom types, no file is generated and no message disturbs; after a successful export it chains one extraPaths sync
- `types.xml` on disk regenerates automatically: after a save/create/delete the watcher silently re-exports (no debouncing, no extra setting — the zero-write discipline makes repeated triggers side-effect free; with `kbengine.python.stubExport` off it effectively stops)
- A `.def` create/change/delete regenerates `entity_types.pyi` automatically (C-22): a 400 ms trailing debounce collapses bursts into one regeneration, sharing the `kbengine.python.stubExport` master gate and the content-compare zero-write discipline; the `entity_types.pyi` source-mirror CodeLens plan refreshes in place after a successful regeneration (a failed one does not refresh). Scope: `.def` files only — `entities.xml` is not wired yet
  - Setting `kbengine.python.stubExport: false` turns it all off (shared with the KBEngine.pyi stub export)

## Git History

### `kbengine.git.showHistory`

- Title: `Kode: 查看文件历史 (View File History)`
- Purpose: open the file history view (IDE-GIT-001 gate, IDE-GIT-005). The entry is visible only while `kbengine.gitHistory.enabled` is on (explorer file context menu, editor context/tab context menu, command palette); it is an entry point — history is queried on demand only when the user opens it, never at activation, file open, cursor move or selection change, with no prefetch or polling
- Behavior:
  - Gated by the same switch: with the feature off the command is hidden from menus and a direct invocation runs nothing Git
  - Resolves the target from the invocation argument (context menu URI) or the active editor; on demand locates the owning Git repository and queries page 0 into the `kbengine.gitHistory` sidebar tree, then focuses it
  - The tree rows show subject + `author · time` and a tooltip (hash, author email, times, body); a trailing 加载下一页 row appends the next bounded page on click only; the view title names the file and its baseline commit (`a.py @ 01234567`)
  - The query follows renames (IDE-GIT-007): commits before and after a rename are listed, each row carries the path the file had at that commit, and a trace that ends in a copy/delete rather than a clean rename shows an honest copy-or-move boundary row instead of pretending history continues
  - An idle view shows a guidance row and makes zero Git calls; terminal states (untracked / staged-no-history / empty-repo / locate failure / bounded-runner outcome) are reported honestly

### `kbengine.git.historyNextPage`

- Title: `Kode: 加载下一页文件历史 (Load Next History Page)`
- Purpose: internal tree-item action for the `kbengine.gitHistory` view (IDE-GIT-005); appends the next bounded page of commit records on explicit click. Hidden from the command palette (`when: false`) — it is not a user-facing entry point
- Behavior:
  - Only queries while the view holds a loaded, has-more state; a terminal or last-page state queries nothing
  - Appends the next page without duplicates or gaps; a failed/empty next page keeps the already-loaded rows and clears has-more

### `kbengine.git.showRangeHistory`

- Title: `Kode: 查看选中范围历史 (View Selection History)`
- Purpose: open the selection history entry (IDE-GIT-001 gate, IDE-GIT-010 entry point), shown in the editor context menu only with a selection and in the command palette; gated like the file history entry
- Behavior:
  - Gated by `kbengine.gitHistory.enabled`; a disabled feature hides the entry and a direct invocation runs nothing Git
  - With a selection: maps the working-copy selection to its committed (HEAD) line span (IDE-GIT-008), queries that span's per-commit timeline (IDE-GIT-009), and shows it in the `kbengine.gitRangeHistory` sidebar view — the title states the query basis (`file @ HEAD 行 N-M`) and the original selection is preserved for display; uncommitted/unsaved lines produce an honest warning with only the committed part shown
  - With no selection: the context-menu entry is hidden (requires `editorHasSelection`); a direct invocation gives a "select code first" prompt without running Git
  - The view holds its own state — switching editors or moving the cursor never re-queries or mis-applies a stale selection to another editor (no activation/file-open/cursor/selection listeners)

### `kbengine.git.openRangeHistoryDiff`

- Title: `Kode: 打开版本差异并定位范围 (Open Version Diff and Locate)`
- Purpose: open a range-history entry's commit version versus its parent as a read-only diff, then locate the entry's line range in that version (IDE-GIT-010). Bound to clicking an entry row in the `kbengine.gitRangeHistory` view; hidden from the command palette (`when: false`)
- Behavior:
  - Invoked with `(entry, filePath, repoRoot, parentFilePath?)`; opens the same version-vs-parent diff as `kbengine.git.openVersionDiff` (IDE-GIT-006 virtual documents), then opens the commit's version content in a non-preview tab with the entry's line range selected (`Range(rangeStart-1, 0, rangeEnd-1, 0)`)
  - The line range span is recorded per entry from the `-L` diff hunks' new side (`RangeChangeEntry.rangeStart/rangeEnd`), so locating works even when the range moved between commits
  - Across a rename the parent-era path is used for the left side (IDE-GIT-007); gated by `kbengine.gitHistory.enabled`, a disabled feature runs nothing Git

### `kbengine.git.openVersionDiff`

- Title: `Kode: 打开版本差异 (Open Version Diff)`
- Purpose: open a historical commit's version of a file versus its parent as a read-only diff in the editor (IDE-GIT-006). Bound to clicking a commit row in the `kbengine.gitHistory` view; hidden from the command palette (`when: false`)
- Behavior:
  - Invoked with `(commit, filePath, repoRoot, parentFilePath?)`; resolves the commit's parent via `git rev-list --parents -n1`; the root commit uses an empty left side so the whole file reads as added
  - Across a rename the left side uses the parent-era path (IDE-GIT-007), so a pure rename shows no change instead of a fabricated whole-file add
  - Both sides open as virtual documents (`kode-git-version` scheme) keyed by repo/commit/path — workspace files are never overwritten or opened as real files
  - A path absent at that commit (deleted or not-yet-created) shows as an empty side; a bounded read failure surfaces an honest error rather than a silent empty
  - Gated by `kbengine.gitHistory.enabled`; a disabled feature runs nothing Git

### `kbengine.git.openVersionContent`

- Title: `Kode: 打开版本内容 (Open Version Content)`
- Purpose: read-only open a historical commit's version of a file (IDE-GIT-006). Bound to the commit row context menu in the `kbengine.gitHistory` view; hidden from the command palette (`when: false`)
- Behavior:
  - Opens the `kode-git-version` virtual document for that repo/commit/path in a non-preview editor tab — no workspace file is written or replaced
  - A path absent at that commit (deleted) opens empty; a bounded read failure surfaces an honest error
  - Gated by `kbengine.gitHistory.enabled`; a disabled feature runs nothing Git

## Build and Tests

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

## Entity Message Table

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

## .kbengine Managed Directory

### `kbengine.infer.run`

- Title: `KBEngine: Run pyrefly Infer (无标注函数 stub 推断)`
- Purpose: run the pyrefly inference pipeline (KODE-CFG-017) — mirror the scripts tree to `.kbengine/inferred/`, then run `pyrefly infer` on the copy with `.kbengine/stubs` (def/types.xml-verified stubs) as the type environment, so un-annotated functions get inferred annotations without touching user source
- Entries: command palette
- Behavior:
  - disabled (`kbengine.infer.enabled=false`): an honest notice says so and nothing runs
  - pyrefly binary not found (no setting, not on PATH, not in the pipx default location): an honest notice tells the user to `pipx install pyrefly` or set `kbengine.infer.pyreflyPath` — the feature degrades, no error is thrown
  - a non-zero exit from any scripts root is reported verbatim with the exit codes; success names the scripts-root count
  - every write path passes the write-scope gate first — default `managed` scope only allows `.kbengine/**`, user source needs the explicit `kbengine.infer.sourceWrite=user` opt-in
- Boundary: inference only; the consumer layer (native providers reading the annotated copy) is a later batch

### `kbengine.managedDir.syncExclusions`

- Title: `KBEngine: Sync .kbengine Exclusions (搜索/watcher/gitignore)`
- Purpose: re-apply the `.kbengine` isolation — `search.exclude` and `files.watcherExclude` get the `.kbengine/**` entry (own-segment discipline: only kode's previously-written keys are touched, user entries are never removed) and the git repo root `.gitignore` gets an idempotent `.kbengine/` line when the file already exists
- Entries: command palette
- Behavior:
  - runs the same face as the activation-time silent sync, but reports what it wrote (which workspaces got `search.exclude` / `watcherExclude`, which git roots got a `.gitignore` append)
  - `.gitignore` is never created (SVN / no-VCS workspaces get no git-specific write at all)
  - idempotent: a second run with no changes writes nothing
- Boundary: isolation only; the mirror and infer steps are `kbengine.infer.run`

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

## Protocol Tooling

### `kbengine.protocol.showStatus`

- Title: `KBEngine: 显示协议工具链状态`
- Purpose: probe the machine's protocol tooling (PA-007) and render an honest status report into the OUTPUT channel 「KBEngine Protocol Tooling」 — tshark version, Wireshark GUI version (absent GUI reported as absent), personal/global plugin folders, the KBEngine Wireshark dissector plugin (PA-006) with its plugin-folder vs host version-line check (match / mismatch "host will not load" / unknown), and the kode-kbengine CLI path + version
- Behavior:
  - Every probe failure collapses to 「未检出」 (not found) — never an error, never a guess
  - The report always states the zero-ABI fallback: `kode-kbengine capture analyze` analyzes pcaps without the plugin
  - Probes read `kbengine.protocol.tsharkPath` / `kbengine.protocol.wiresharkPath` / `kbengine.protocol.cliPath` (CLI empty = `target/{debug,release}` auto-discovery, same shape as kode-server)
  - The report ends with a schema state section (PA-007 increment 4) read from `globalStorage/kbengine-schema.json`: generated → IR version, engine baseline, message/entity counts, missing entities (registered in entities.xml but no `.def`) and build diagnostics listed verbatim (SYNTAX-005 convention: bad inputs are kept as diagnostics, never a fake pass); not generated → the `kbengine.protocol.buildSchema` hint; unreadable → the reason

### `kbengine.protocol.buildSchema`

- Title: `KBEngine: 生成 KBEngine 协议 Schema`
- Purpose: build the KBEngine protocol schema from the workspace asset root via the kode-kbengine CLI (`schema build --project <assetsRoot> --out <globalStorage>/kbengine-schema.json`) — the same plan the auto-rebuild face uses (PA-007 second increment)
- Behavior:
  - Asset root resolution reuses `kbengine.assetsRoot` and the existing discovery chain (`resolveAssetsRootForWorkspace`); CLI resolution reuses `kbengine.protocol.cliPath` + auto-discovery; any missing link surfaces an honest warning with the reason (CLI 未检出 / CLI 探测失败 / 资产根未检出) — never a guess
  - Success notifies with the output file path and logs to the 「KBEngine Protocol Tooling」 channel; failure notifies with the CLI's own error text (stderr first, then stdout, then exit code)
  - The auto-rebuild face (default on, `kbengine.protocol.schemaAutoBuild`) rebuilds on protocol definition file events (`.def` / `types.xml` / `entities.xml` / `alias.xml`) inside the project root, debounced through the shared merger and coalesced by an in-flight scheduler (one trailing rebuild, no queue amplification); Python files are structurally never watched; activation spawns no process — initial build happens on the first protocol file event or via this command

### `kbengine.protocol.openPcap`

- Title: `KBEngine: 在 Wireshark 中打开 PCAP`
- Purpose: one-click open a packet capture in the Wireshark GUI — pick a file (`pcap` / `pcapng` / `cap`) and the configured `kbengine.protocol.wiresharkPath` launches with it (PA-007 third increment)
- Behavior:
  - Dialog cancel does nothing — no process, no notification
  - Wireshark undiscovered / launch failure warns honestly with the config key hint; a normally opened GUI is its own success feedback (no notification)
  - The launch record lands in the 「KBEngine Protocol Tooling」 channel; the GUI is launched without a timeout (a detection-face 5s timeout would kill the just-launched GUI — this face carries its own runner)

### `kbengine.protocol.analyzePcap`

- Title: `KBEngine: 用 kode-kbengine 分析 PCAP`
- Purpose: run the zero-ABI analysis path — `kode-kbengine capture analyze --pcap <file> --tshark <tsharkPath>` (the CLI drives tshark; the KBEngine plugin is NOT required) and render the report verbatim into the 「KBEngine Protocol Tooling」 channel
- Behavior:
  - Dialog cancel does nothing; CLI undiscovered / probe failure warns honestly with the reason (same attribution as `buildSchema`)
  - Analysis failure notifies with the CLI's own error text (stderr → stdout → exit code); the report is rendered as-is — no summarizing, no re-formatting
  - This face carries a long timeout (120s) — large pcaps + the tshark hop do not fit the detection face's 5s probe budget
