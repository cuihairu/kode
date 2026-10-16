# Feature Overview


## Language Features

- `.def` syntax highlighting (built-in XML grammar delegation + engine semantic coloring)
- Completion for types, Flags, DetailLevel
- Hover for tags, values, custom symbols
- Navigation between `entities.xml` and `.def`
- Entity reference navigation inside `.def`
- Bidirectional Python ↔ `.def` navigation
- RPC method markers (functions in Python implementation scripts that hit def method declarations get a one-line clickable CodeLens jumping back to the def declaration)
- `.def` property/method F2 rename (same-file declaration + descendant def restatements, see the boundary note on the language page)

## Diagnostics

- Unknown type check
- Unknown Flags check
- Unknown DetailLevel check
- Duplicate definition check
- Missing `Type` / `Flags` check

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
- Database drift check (`kbengine.database.checkDrift`): takes real table structures and reverse-checks the def-derived virtual structures, reporting missing tables / missing columns / extra columns / type mismatches / leftover tables; connection info reads the engine config (`encrypt=false` plaintext password), only `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` pass and the connection opens as a read-only session; connection failures degrade to "未校验" (not checked) without errors. See [Database Drift Check](./database-drift-check.md)

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
- First install scans one level of workspace-root `.bat` files; scripts matching start/stop or config-export keyword lists prompt a multi-select registration; canceling stops the auto-prompt for that workspace

Command details in [Commands and Panels](./commands.md); config keys and variable tables in the [configuration reference](./configuration.md).

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

Notes:
the generator is affected by the `kbengine.generator.*` and `kbengine.entitiesXmlPath` settings; the client entity SDK by `kbengine.clientSdk.outputDir`.

## Performance Analysis

- Full-workspace `.def` static checks (the `Analyze Def Performance` command)
- Optimization suggestions written to the output panel and dropped into the problems list as diagnostics

## Snippet Generation

- Generate custom snippets from a selection (the `Generate Snippet from Selection` command)
- Snippet grammar escaping and common-indent stripping (per the editor's `tabSize` column semantics, mixed tabs/spaces keep relative levels), merged into `.vscode/kbengine-custom.code-snippets`
