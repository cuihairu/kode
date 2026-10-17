# Changelog

All notable changes to the Kode extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-12

Version is frozen at this placeholder on request; it is not a published
release (no tag, no GitHub Release) — nightly rolling builds continue.

### Added
- Merged def-chain hover (source-analysis design point D5): hovering the
  root-level `<Parent>` element in a `.def` presents the def's inheritance
  closure in three facets aligned with the engine's merge semantics
  (entitydef.cpp:890-924、551-639、642-771) — the recursive Parent chain
  (entity parents resolve in the definition root, component parents inside
  `components/`, interface defs never follow `<Parent>`), the flattened
  `interfaces/` list deduplicated across levels in first-seen order, and
  the `components/` hookup list. Parents, interfaces, or components whose
  def file is missing are marked as such instead of being invented, and
  parent chains that form a cycle are truncated by a visited set and
  marked — the engine's `loadParentClass` has no cycle guard, kode does
  not copy that.
- Same-name duplicate entity registrations in `entities.xml` are now
  diagnosed as warnings: the engine silently merges duplicates by reusing
  the first registered module (registerNewScriptDefModule,
  entitydef.cpp:255-262), so later entries and their hasBase/hasCell/
  hasClient assertions never take effect — kode marks each later entry
  (source-analysis design point D3). The check rides the same
  document-event lifecycle and the same `kbengine` diagnostic collection
  as the live `.def` checks, gated by the shared
  `kbengine.enableDiagnostics` master switch.
- Registration hovers on `entities.xml` entity entries now show a
  `**Utype**` line with the 1-based manifest ordinal (the engine assigns
  utype in `entities.xml` child order, entitydef.cpp:253-265; the ordinal
  is the first-occurrence position, matching the engine's first-wins
  merge) plus the total entity count.
- `kbengine.python.exportTypeStubs` exports the `types.xml` custom types
  into `kbe_types.py`, a real Python module (option A of the def-pyi-stubs
  feasibility analysis): FIXED_DICT becomes a TypedDict class with
  properties in document order, ARRAY becomes `List[element]` (nested
  arrays nest), and aliases become type-name assignments emitted in
  dependency topological order; alias cycles and empty directives are
  skipped with the reason stated instead of emitting an assignment that
  references an undefined name. The artifact is deterministic (no
  timestamp) and lives beside `KBEngine.pyi` in the stub directory —
  same three-tier `kbengine.python.stubDir` resolution, same
  `kbengine.python.stubExport` switch, same zero-write-when-unchanged /
  rewrite-when-stale discipline; an existing `kbe_types.py` in a
  user-configured directory is a user asset and is never overwritten.
  Exported once silently after the KBEngine.pyi export at activation,
  chained with one extraPaths sync (the managed segment now joins when
  either artifact is on disk), with the manual command chaining the sync
  as well. A watcher on `**/types.xml` silently regenerates the stub
  after every save/create/delete — no debounce and no extra setting:
  the export's own switch gates it, and deterministic content with the
  zero-write discipline makes repeated triggers side-effect free
- `types.xml` type declarations now explain how they land in the database
  and where they are used. Hovering a declaration name appends a storage
  shape section: built-in aliases land as one main-table column (with the
  resolved column type), FIXED_DICT flattens into columns without a table,
  ARRAY becomes a `tbl_<Entity>_<Property>` child table with one row per
  element (the element landing is described one level deep), and an
  unresolved alias says the engine fails to load `types.xml`. Each type
  declaration line also grows reverse-scan CodeLenses — one per real usage
  (`Hero.itemId → tbl_Hero.sm_itemId`), clicking opens the entity's schema
  document at that column; more than 10 usages fold into a count lens and
  unused types stay silent. Usages are indexed from the same schema
  snapshot the schema view renders, and `.def`/`types.xml`/`entities.xml`
  changes invalidate the index and refresh the lenses
- Hovering a `Persistent` property in `Properties` now shows its database
  storage: the table and column names (`tbl_<Entity>`, `sm_<name>`), the
  three expanded columns for `VECTOR2/3/4`, flattened `FIXED_DICT` key
  chains, and the child table for `ARRAY` properties. Properties typed
  through a `types.xml` alias resolve along the alias chain because the
  schema snapshot expands aliases at build time. Full table SQL stays in
  the `kbengine.database.open` schema document
- Database simulation: `kbengine.database.simulate` opens a `.dbsim`
  virtual document that renders the DDL, simulated row JSON and INSERT
  statements from the schema snapshot in one view, plus a diff list of
  where the simulator behaves differently from the real engine. The
  write semantics are taken from the engine's MySQL backend (dbid>0 means
  UPDATE, otherwise INSERT then LAST_INSERT_ID; one row per array element
  with the parent id; `sm_autoLoad` 0 on first write and -1 afterwards;
  unique conflicts are decided by MySQL indexes, the engine has no
  pre-check). `kbengine.database.exportSimulation` saves the simulation
  document as Markdown
- Workspace auto-discovery for the KBEngine paths. The resolution order is
  explicit settings, then the conventional layouts, then a bounded deep
  scan (depth 7, 20000 visited entries, `node_modules`/`.git`/`out`/
  `dist` pruned, cached per workspace). A sync read only accepts a unique
  hit — several candidates mean an activation-time quick pick that is
  remembered per workspace, never a silent guess that rewrites the def
  root. Explicit configuration still wins, and sub-paths that follow from
  an existing file stay out of the settings. `types.xml`,
  `messages_fixed(_defaults).xml` and the engine defaults source root need
  no settings at all. When `pythonOutputPath` is still its default, the
  python root is derived from the discovered def root. `kbengine.configPath`
  joins the same chain: the setting (default or explicit) is validated by
  the engine-load probe `res/server/kbengine.xml`, and when it does not
  pass, the assets root is discovered from the conventional locations
  (workspace root, `assets/`, `server_assets/`), the remembered choice, or
  a unique deep-scan hit — several candidates mean an activation-time
  quick pick, never a guess. The discovered root is also used by the
  telnet probe and the final-config view to locate the element
  `kbengine.xml` (its `res/server/kbengine.xml` location is probed too)
- RPC 方法标记：Python 实现脚本里，方法名命中实体 def 方法声明的函数在
  声明行上方出一行可点 CodeLens（`RPC · <区块> · [Exposed ·] <来源 def
  文件名>`），点击跳回 def 声明行；未在 def 声明的普通函数不出 lens。
  按方法名匹配，同名辅助函数也会出 lens（见语言能力页边界说明）
- Discovery diagnostics: `kbengine.discovery.report` writes a
  pasteable plain-text report to the `KBEngine 发现与定位` output channel
  that lays out, per key, the final value in use and where it came from
  (explicit config / remembered choice / convention chain / deep scan /
  derived / fallback / none), the explicit setting's raw value and
  on-disk existence, convention hits and misses, deep-scan hits and the
  remembered choice, plus a numbered issue list with one-line remediation
  per problem. `kbengine.configPath` is validated against the engine load
  anchor `res/server/kbengine.xml`, and the bounded deep scan reports its
  visited-entry count and flags truncation (zero hits are not proof of
  absence). The report is also written silently after activation-time
  discovery, and a visible warning with the issue count points at the
  channel; starting a server with an assets root that lacks the expected
  engine config file now logs a `[WARN]` line in the component channel
  instead of failing quietly
- Entity flow graph: `kbengine.flow.show` opens a webview that maps one
  entity's client → baseapp/cellapp relationships — remote method calls
  and automatic property sync. Edge semantics are read from the property
  Flags bits and each edge lists the engine source (file:line) next to the
  member declaration it came from; `BaseMethods` without `Exposed` are
  listed separately as methods the client cannot call. Clicking a member
  row jumps to its `.def` declaration and the panel refreshes from disk
  (def/entities.xml) rather than caching. The graph exports as Markdown
  (written straight to a file), SVG and PNG; the entity name defaults to
  the active `.def` editor and the panel says so when none can be located
- Quick actions: `kbengine.quickActions.show` (`Run Quick Actions`, a
  button in the Servers view title bar and one in the `.def`/Python/XML
  editor title bars) runs a project-defined action list. The list lives in
  the top-level `quickActions` array of `.kbengine/debug.json` so it
  follows the KBEngine project instead of VS Code settings or
  `launch.json`. Three whitelisted backends, no arbitrary shell entry:
  `command` runs a VS Code command id with `args` passed through,
  `script` runs the script named in the config (`background: true`
  reports the server as started without waiting for an exit code), and
  `http` requests the URL written in the config — never assembled at
  runtime. Paths accept `${workspaceFolder}`, `${workspaceFolder:<name>}`
  and `${env:...}`, resolved at execution; an unknown variable aborts the
  action with the variable named instead of silently becoming an empty
  string. Actions ask for a modal confirmation by default (`confirm:
  false` skips it), the run log goes to the `KBEngine 快速执行动作` output
  channel with script stdout/stderr verbatim, and a failure pops one error
  box (name + exit code / HTTP status / reason). Malformed config entries
  are dropped one by one with a count instead of failing the whole list.
  On first install the workspace root is scanned one level deep for `.bat`
  files; those matching the start/stop-server or export-config-tables
  word lists are offered for registration as a multi-select, and
  cancelling is remembered per workspace so the prompt is not shown again
- SQL templates for child tables plus a configurable table prefix.
  ARRAY/component properties do not live in the main table, so two
  template shapes join the existing minimal SELECT: a child-table join
  that `LEFT JOIN`s `tbl_<Entity>_<Property>` on `parentID` so empty
  elements keep their property rows, and a Persistent-filtered column
  list that only includes attributes marked `Persistent=true`. The new
  `kbengine.db.tablePrefix` setting (default empty = the engine's `tbl_`
  prefix from `entity_table_mysql.cpp`) feeds both the schema-view table
  names and every template through one shared resolution function, so the
  two cannot drift apart
- Database drift check: `kbengine.database.checkDrift` compares the real
  MySQL table structure against the virtual tables derived from the
  `.def` files, per table reporting missing tables (entity has not been
  through the table-creation flow), missing columns (property added
  without a resync), extra columns, column-type mismatches (display-width
  differences do not count) and leftover tables. The report goes to the
  `KBEngine 数据库漂移` output channel in one pasteable block. Connection
  details are read from KBEngine's own engine config (the merged
  `<dbmgr><databaseInterfaces><default>` element, port 0 → 3306) — no new
  setting is introduced; a config that only stores an RSA-encrypted
  password cannot be read, so the command reports the entity as unchecked
  instead of asking for a hand-typed password. Queries are read-only by
  rule: the statement is checked against a whitelist (SELECT/SHOW/
  DESCRIBE/EXPLAIN, with INSERT/UPDATE/DELETE/DDL/GRANT/TRUNCATE and
  multi-statement input refused with the reason) and the connection is
  opened with `SET SESSION TRANSACTION READ ONLY`, so even a read-write
  account cannot write through it

### Changed
- `kbengine.configPath` is now `kbengine.assetsRoot`. The setting points at
  the asset root (the engine's `assets` tree, e.g. `flyff_assets`), so the
  name follows the engine's own terminology (`kbemain.h` comments place the
  user copy at `../../../assets/res/server/`) and the `*_assets` convention
  roots the discovery already scans. The default changed from
  `${workspaceFolder}/server` to empty (auto-discovery): the old default
  made an unconfigured workspace behave as if it had an explicit config,
  so the empty default lets the intended "not set → discover" path actually
  run. Users who already set the old key must re-enter it under the new
  name; probe and discovery semantics are otherwise unchanged
- `<implementedBy>` values in `types.xml` now color the module path and the
  symbol separately (one color for the whole value before). Every dotted
  segment before the last is now a module namespace scope
  (`entity.name.namespace.kbengine.implmodule`), the segment right before
  the closing tag stays the implementation symbol scope
  (`variable.other.kbengine.implementedby`); a bare value without dots
  keeps the symbol color alone. The split follows the engine's own load
  semantics (`datatype.cpp` `loadImplModule` treats the value as
  `module.symbol`)
- The database schema document (`kbengine.database.open`) renders with
  Chinese labels and a reading legend instead of raw key/value lines
  (`Backend:` / `kind:` / `index=`). The header shows the entity name,
  storage engine, def file and a table/column count, followed by a legend
  explaining the `tbl_`/`sm_` prefixes, engine-managed columns,
  `parentID` relations, `flags=` scopes and the paste-ready SQL. Each
  table is titled with its kind (实体表/组件表/数组子表), source def
  location and parent table, and splits its columns into an engine group
  (with fixed meaning notes per column) and a property group whose rows
  end with the def location (`← file:line <property>`). Tables without
  def-declared columns say so explicitly. `TABLE` lines and the SQL lines
  keep their exact format, so F12 jumps and pasting into a MySQL client
  are unchanged

### Fixed
- Generating a snippet from a selection now measures the common indent in
  editor `tabSize` columns instead of characters, so a selection that mixes
  tabs and spaces keeps its relative nesting. The character count treated
  one tab as one column, which could push an outer line inside an inner
  one; only selections that mix both whitespace kinds were affected, pure
  tab or pure space selections are unchanged
- `F12` on `Properties`, `BaseMethods` and `CellMethods` now lands on the
  real implementation line in the layouts KBEngine actually ships. The
  candidate chain never tried three of them, so navigation returned only a
  "expected paths" message:
  - `scripts/<role>/interfaces/<Name>.py` and the `Interface_<Name>.py`
    naming variant (old layouts and user projects, e.g.
    `server_assets/scripts/base/interfaces/Interface_Activity.py`)
  - `scripts/<role>/components/<Name>.py` for component methods
  - `scripts/<entity>.py` flat layout (this extension's own code generator
    default `pythonOutputPath: scripts`)
  - the client role also resolves the official template's `bots/` folder,
    and the interface folder is now both the official `interface/` (singular)
    and the historical `interfaces/` (plural)
- Interface and component script resolution is role-paired: a `BaseApp`
  entity's declaration resolves under `base/`, a `CellApp` entity's under
  `cell/`; the role-nested folder wins over a same-named script at the
  `scripts/` root, with the root kept as fallback
- The expected-locations hint now lists every entity script path that was
  tried, including the `bots/` client folder and the flat layout
- The entity dependency graph now builds inheritance edges from the text
  form `<Parent>Hero</Parent>` too. The extractor only recognized the
  element form `<Parent><Hero/></Parent>`, while the engine's
  `loadParentClass` (entitydef.cpp L890) loads both — a text-form def lost
  its inheritance edge in the graph. The wrapper stays case-sensitive like
  the engine's `enterNode` match, and a lowercase `<parent>` is ignored
- The engine messages table is now discovered under both names with the
  engine's own load order (`kbemain.h:71-74` loads the defaults first and
  the user copy on top). The deep scan previously only collected
  `messages_fixed.xml`, so asset templates that ship
  `messages_fixed_defaults.xml` in their own `res/server/` were always
  reported missing. Resolution is now four-level — workspace user copy,
  engine-source user copy, workspace defaults, engine-source defaults —
  and never requires the two files in one directory (the engine comments
  put the defaults in the engine res tree and the user copy in the asset
  tree). A pure-asset workspace with neither file is the normal case and
  is now reported as `informational` with an explanatory note instead of
  counting as an issue; a found engine source root whose `res/server/`
  lacks both files still reports missing
- The config-root convention chain now also accepts first-level
  `*_assets` directories (e.g. `flyff_assets`), matching common project
  layouts without waiting for the deep scan. Directory names only qualify
  a candidate — the engine-load probe `res/server/kbengine.xml` still
  decides

## [0.1.6] - 2026-10-11

### Fixed
- Interface references now follow the engine's `<Interfaces>` load
  semantics. The engine (`loadInterfaces`, entitydef.cpp L559-561) only
  loads children whose wrapper tag is exactly `interface`, `Interface`,
  `type` or `Type` (case-sensitive) — a direct-take form like
  `<MoveIface/>` is silently skipped and never produces a mix-in. The
  analyzer previously accepted any child element, so the entity browser,
  mapping graph and schema views showed interfaces the engine would not
  load. The four-spelling wrapper is now required, and the interface name
  is taken from the first non-comment child (text or element tag), the
  same `enterNode`/`getKey` rule the engine applies
- Parent and interface naming now share one implementation:
  `getReferenceTargetName` in `src/defRenamer.ts` is the single source of
  truth for both, so the two modules can no longer drift apart
- The `<interface>` hover doc no longer suggests the direct-take form;
  it documents the four accepted spellings and that other spellings are
  silently skipped by the engine

## [0.1.5] - 2026-10-10

### Added
- `inherited-name-collision` def-analysis check (ninth check item): the
  analyzer now walks each entity def's inheritance closure — the `<Parent>`
  chain and `<Interfaces>` mix-ins, resolved the same way the engine loads
  them (parent on the def root, component parents inside `components/`,
  interfaces inside `interfaces/`, interface files never follow their own
  `<Parent>`) — and reports names that the engine would reject at load
  time. Collision rules mirror the single shared `ScriptDefModule` the
  engine installs child, parent and interface descriptions into: a
  property against an ancestor method or component-slot name is rejected
  globally; a property against an ancestor property/component slot is
  rejected only on overlapping flag domains (disjoint domains coexist
  legally, `CELL` aliases are normalized first); a method against an
  ancestor property/component is rejected globally; a method against an
  ancestor method only within the same section; a component slot against
  any ancestor same name is rejected unconditionally. Every hit is
  reported as an error with the ancestor file(s) it came from (up to
  three listed)
- Malformed or empty ancestor files in the closure are skipped and
  dangling `Parent` references are silently ignored — the analyzer never
  invents an ancestor surface, so no false positives from unreadable files

## [0.1.4] - 2026-10-10

### Fixed
- Root cause of "hover shows something but nothing jumps" is gone. Script
  directories are now derived from the `.def` file's own location: walk up
  from the def to the nearest `entity_defs` directory (matched by name, or
  by a sibling `entities.xml`/`types.xml`) and take its parent as the
  scripts root. The old workspace-relative derivation only knew three
  hard-coded candidates (`entity_defs`, `scripts/entity_defs`,
  `assets/scripts/entity_defs`), so any other layout — `server/scripts/`,
  `nested/…`, an arbitrary project prefix — silently resolved to a
  non-existent directory and property, method, and the three method
  sections all failed together. File-relative resolution is now tried
  first, the workspace candidate chain only as a fallback
- Entity-mapping index misses no longer strand method navigation. When the
  index has not collected a symbol or its script reference (non-standard
  layouts are not indexed), method lookup now walks the def-relative
  candidate chain before falling back to the def's own declaration line
- Missing implementations always land somewhere navigable instead of only
  popping a message: script present but the property/method absent goes to
  the `class` line; script truly absent goes to the entity's declaration
  line in `entities.xml`, or the def's first line when no registry is
  reachable. The message is kept as an auxiliary note
- Hover and completion text no longer prints placeholder templates.
  `scripts/{base,cell,client}/xxx.py` braces are replaced by the real
  resolved paths (workspace-relative under a workspace, absolute
  otherwise); when nothing resolves, the message reads
  "entity script not found, expected at:" followed by every candidate
  path that was checked
- `src/languageProviders.ts(1546)`: the `Location | Thenable` return of
  the method lookup was read for `.uri`/`.range` before narrowing, which
  broke `tsc` (TS2339). The sync entry point still has to return
  synchronously — 42 existing call sites call `provideDefinition` without
  `await` — so the Thenable is passed through after `'then' in` narrowing
  instead of being awaited

### Added
- "KBEngine Navigation" output channel logging every resolution step:
  entry point, symbol parse result, the property/method candidate chain
  actually tried, the chosen landing, schema hits, registry fallbacks,
  and def-first-line fallbacks
- Real-host verification: a VS Code Electron suite that drives
  `vscode.executeDefinitionProvider` inside a live editor and asserts a
  landing (file exists on disk, exact path, exact line) — not merely a
  message — for four layouts: standard `scripts/entity_defs`, non-standard
  `server/scripts/entity_defs`, `entity_defs` at the workspace root, and a
  component def. All four land
- 16 layout matrix tests covering the four layouts above plus a renamed
  defs directory recognized by its `types.xml` sibling, entity defs with
  no scripts at all, workspace-less resolution, hyphenated entity names
  (declaration-name guard), index-miss fallback, and depth exhaustion

## [0.1.3] - 2026-10-10

### Fixed
- Property navigation in `.def` files no longer silently returns nothing.
  Landing spots resolve in four tiers: the `class` line matching the def
  name → the `__init__` line → the first `class` line → the first line of
  the script. The engine loads properties before `__init__`, so the class
  line stays a reliable anchor even when the property name never appears
  in the script
- Property lookups now walk the engine's loading closure: component defs
  resolve to their role scripts, interface defs resolve to
  `scripts/interfaces/<name>.py`, and entity defs climb declared
  `<Interfaces>` mixins and the `<Parent>` chain (cycle-safe, stops at
  empty or malformed parent defs)
- When neither the script closure nor the database schema resolves a
  property, an explicit message names the property and the expected
  `scripts/<role>/<entity>.py` locations instead of doing nothing
- Clicking a `<Type>` value now explains the miss: built-in types
  (`UINT32` etc.) report "engine built-in, no declaration file", unknown
  custom types report "not declared in types.xml" instead of a silent null

## [0.1.2] - 2026-10-10

### Changed
- Removed two dead settings that no code ever read: `kbengine.pythonDefsPath`
  and `kbengine.enablePythonNavigation`. Python→`.def` navigation resolves
  the def tree through `kbengine.entityDefsPath` plus built-in layout
  fallbacks (`entity_defs`, `scripts/entity_defs`, `assets/scripts/entity_defs`)
- Reference-field navigation now covers the whole family in `.def` files:
  `Parent` and `<Interfaces>` mixin names jump to their def files, `Type`/`Arg`
  entity and component references resolve to `entity_defs/` or
  `entity_defs/components/`, custom type aliases jump to their types.xml
  declaration, `DetailLevel` values jump to the `<DetailLevels>` entry line,
  and method names in BaseMethods/CellMethods/ClientMethods resolve their
  implementation through the engine's loading closure (own role script →
  interface mixin scripts → parent chain; interface defs resolve to
  `scripts/interfaces/` and do not follow `Parent`)
- Telnet surfaces (status bar lamp, dedicated tree view, panel command entry)
  are only shown when telnet is explicitly enabled in configuration — a
  non-zero `kbengine.telnet.port` or a `<telnet_service>` section in the
  component kbengine.xml; the old "nothing configured → seven default
  component ports" fallback is gone. Engine defaults never enable telnet on
  their own — they only supply values when the component section exists
- Telnet port/password now resolve through the engine's own layering: kode
  settings → component kbengine.xml `<telnet_service>` (found via
  `kbengine.telnet.configXmlPath`, else `kbengine.configPath/kbengine.xml`,
  else conventional workspace-root paths) → engine `kbengine_defaults.xml`
  derived from `kbengine.binPath`
- Telnet moved out of the Servers process tree into its own sidebar view
  ("Telnet", visible only while telnet is configured)
- Debug attach lists local processes inside the extension: processes whose
  name matches the target component are pinned to the top with a check mark,
  picking one assembles the attach configuration with its PID directly —
  no more manual PID input; updating launch.json removes the obsolete
  `kbengineProcessId` input left by older versions
- Version bumped to 0.1.1 so nightly VSIX installs are distinguishable in the
  extensions panel (the rolling release keeps the same `kode-nightly.vsix`
  filename, which made stale installs look identical to fresh ones)

### Added
- Final server config view: the engine's own layering (defaults first, then
  component kbengine.xml overriding key by key, child sections aligned by
  name) rendered as a read-only virtual document `kbengine-final.xml` with a
  source header. It opens automatically in a background preview tab when the
  extension activates and defaults can be located
  (`kbengine.showFinalConfigOnOpen`, default on), stays reachable from a
  persistent "Final Config" node in the Config sidebar view and the
  `Show Final Server Config` command, and recomputes itself when either
  source file changes (`kbengine.autoRefreshFinalConfig`, default on).
  Telnet port/password read from the same merged picture
- Remote debug attach: `kbengine.debug.remoteTargets` (name + host + debugpy
  port, port defaults to 5678) plus the `Attach to Remote Component` command
  with a target picker; attaches in debugpy `connect` mode and appends the
  targets to launch.json
- Hover documentation for server config fields: hovering a field in
  `kbengine.xml` / `kbengine_defaults.xml` (and the final-config view) shows
  what it controls, curated from the engine's own bilingual comments
- `.def` highlighting rebuilt on the built-in XML grammar with a semantic
  overlay: the four section tags (Properties / BaseMethods / CellMethods /
  ClientMethods), `Exposed`, `Persistent`, and flag values such as
  `BASE_AND_CLIENT` keep distinct engine-meaning colors, everything else
  (tags, attributes, comments, strings, punctuation) renders with standard
  XML coloring; the bundled theme was retuned to match (no more all-red
  tags), `<`/`>` joined bracket-pair colorization, and def block comments
  switched from C-style to `<!-- -->`
- Property and method navigation from `.def` files: a Properties field name
  jumps to the entity's `class` declaration line in
  `scripts/{base,cell,client}/<Entity>.py` (first existing script wins,
  base→cell→client fallback), and a method name falls back to the matching
  role script's `def` line when no project index is configured (an
  information hint names the expected script when the method is not
  implemented); section-tag hover text now explains
  player-owned properties, remotely callable methods with `Exposed`, and
  client callbacks
- VitePress documentation site under `docs/`
- Detailed configuration reference for all `kbengine.*` settings
- Entity explorer navigation command for opening `.def` files directly
- Dependency graph export support for SVG and PNG
- Entity definition navigation inside `.def` files
- kbe module symbol stub index (`src/kbeModuleIndex.ts`): the built-in
  `KBEngine` API surface (31 symbols anchored to the engine typings) is
  served as a read-only `kbe-stub` virtual document; `kbe.KBEntity` — a
  kode built-in alias of `Entity` (the engine itself has no such symbol) —
  and from-imported bare names resolve via go-to-definition to their stub
  declaration lines, and `kbe.` completion offers the full symbol list
- Entity chain navigation per the source-verified design in
  `docs/source-analysis.md`: `<Interfaces>` names in a def (self-closing
  and paired forms, open and close tags) navigate to
  `entity_defs/interfaces/<name>.def`; Python class-base lanes resolve
  registered entities to `entity_defs/<Name>.def` and pure-script entities
  to `scripts/{base,cell,client}/<Name>.py` (base→cell→client fallback);
  workspaces without `entities.xml` degrade to per-file resolution with a
  one-time notice
- Two-layer test suite: vitest functional tests under `tests/` (1176 cases,
  including engine-source conditional suites that verify hook call sites, type
  registrations, and flags against a local KBEngine checkout) plus a mocha
  compile-artifact smoke layer (`src/test/suite/`, 11 cases); the legacy
  test-electron integration layer was removed in the redesign stage 4, with
  v8 coverage reporting (see TESTING.md)
- Python document hover/completion registration and a dedicated python snippet
  contribution (`snippets/kbengine-python.json`) so the four hot-reload
  templates are available in `.py` files
- Hook hover now short-circuits to hook docs before symbol hover, so method
  names in Methods sections show 调用时机/函数签名 instead of symbol-only hover
- Multi-line Methods/BaseMethods sections suggest hooks on later lines without
  a same-line section tag
- `.def` rename support: F2 rename of properties/methods updates the same-file
  declaration (all Flags-scope variants) and the same-name restatements in
  descendant defs (Parent chain + Interfaces closure)
- Def performance analyzer (`kbengine.def.analyze`) with eight advisory checks
  reported to an output channel and the problems list
- Entity template library expanded from five to ten presets (monster, space,
  guild, team, mail) using only engine-registered types and flags
- Snippet generator command (`kbengine.snippets.generateFromSelection`) that
  escapes and dedents the selection and merges it into
  `.vscode/kbengine-custom.code-snippets`
- Telnet probe and session integration: status-bar and server-panel lamps
  (connected / open without password / password rejected / off / unconfigured);
  target resolution via settings, the kbengine.xml `<telnet_service>` section,
  or the engine default component port table; probe runs every 5 seconds with
  a 1.5-second per-port timeout. When the port is open the panel logs in
  automatically (the password is only written to the socket, never logged),
  offers a whitelisted command input plus read-only quick commands (`:quit` is
  always rejected), and echoes the session output; a dropped connection flips
  the lamp and can reconnect. Six new `kbengine.telnet.*` settings and the
  `kbengine.telnet.showPanel` command
- HTTP quick requests: a `kbengine.httpRequests` settings list (name, URL
  template, method, headers, body, enable switch, keybinding hint) with
  `${module}` / `${file}` / `${line}` / `${sel}` template variables, substituted
  literally without URL encoding (`${module}` maps the workspace-relative
  Python path, e.g. `entities/fight/FightAI.py` → `entities.fight.FightAI`).
  Runs from a quick pick, or from a keybinding on `kbengine.httpRequest.run`
  with `args.name`; the request/response log goes to the
  "KBEngine HTTP 快捷请求" output channel, failures show a `✗` line plus an
  error notification. One bundled example entry, disabled by default
- Test fixture `tests/fixtures/kbengine-demo-assets`: the official SDK Python
  asset template copied verbatim (63 files) with an entity model added on top
  of it (Avatar/Monster defs, an `interfaces/` interface, a
  `components/` component, a types.xml with `implementedBy`, the user_type
  implementation modules and the role scripts). A 23-case walkthrough test
  opens the workspace above the asset root and runs the whole chain once on
  that one real layout: asset discovery, 13 definition-navigation cases,
  `implementedBy` forward and reverse, RPC CodeLens through an interface mix-in,
  the database schema snapshot (entity table, component table, array child
  table), engine config merge, and the silent-failure red line

### Fixed
- 修:CellMethods 方法字段无法导航 — F12 on a real-project method name
  stayed silent. Verified against the official KBEngine SDK template
  (tab indentation, `<root>` wrapper, empty `<Properties>`): navigation
  itself resolves on intact buffers — word-start and mid-name cursors both
  land on the role script's `def` line — so the repro's red traced to the
  harness corrupting the buffer: the cursor-marker strip deleted the tag's
  `<` (turning `<onTick>` into bare text, which parses as the parent's
  text node and drops the METHOD_SECTIONS branch), and a tag rename left a
  mismatched closing tag that made the def parser bail to null. The one
  genuine product gap is closed: a method symbol with no implementation
  (role script missing or no matching `def`) now shows an information
  hint naming `scripts/<role>/<Entity>.py` instead of a silent null
- 修:资产根不是工作区根时 RPC 标记与反向跳转静默失效 — opening
  `<repo>/<xxx>_assets` (the layout the official SDK template ships and the
  `*_assets` convention scan supports) produced no CodeLens on any Python
  method and dead Python → def reverse jumps. The script candidates were
  built only from the three workspace-relative roots (`scripts`,
  `assets/scripts`, `server_assets/scripts`), all of which miss when the
  asset root is nested, so the index held no Python owner files and
  `resolveMethodDefinition` always returned null. The scripts root derived
  from the owning def (`entity_defs` is kept on the same level as
  base/cell/client by the engine, so the def's `entity_defs` parent is the
  scripts root) is now appended after the workspace roots: flat layouts keep
  their candidate order, nested ones only gain
- `kbengine.database.open` run from the command palette without an entity
  name now opens the schema of the active `.def` entity, same convention as
  `kbengine.database.simulate`; with no active `.def` it says
  「请先打开一个实体 .def 文件」 instead of returning silently, when the only
  reachable entry was the Database group inside the Entities view

### Changed
- Refactored language support code into focused modules
- Enhanced `.def` syntax highlighting with KBEngine-specific semantic scopes
- Expanded hover support for tags, values, and custom symbols
- Made hover and diagnostics behavior configurable
- Updated test module mocking helpers for Node.js 22 compatibility
- Aligned README and documentation wording with the current VitePress setup
- Rebuilt hook metadata from the engine source: 36 verified callbacks with exact
  call-site locations, replacing the previous 40-entry list that contained 17
  callbacks absent from the engine
- Aligned advertised property types with `DataTypes::initialize`: removed
  `BOOL` and `TUPLE` (not registered by the engine), documented `ARRAY`
  (inline `<of>` syntax) and `FIXED_DICT` (types.xml aliases only)
- Rewrote the `kbe-array` snippet to the engine's `ARRAY<of>…</of>` syntax,
  moved `FIXED_DICT` templates to new types.xml snippets (`kbengine-types-xml.json`),
  dropped the fabricated `kbe-tuple` snippet, and moved the four hot-reload
  templates out of `kbengine.json` (11 def snippets) into `kbengine-python.json`
- Fixed `joinWorkspacePath` producing mixed-separator paths for `C:\` workspaces
  on non-Windows hosts (now explicit `path.win32.join`)
- Performance: share one parsed AST across the diagnostic passes, add a
  fixed-entity-tag grammar rule to avoid scanner rebuilds, and speed up the
  line-table computation (validateDocument −46%, full-file tokenization −17%
  on a 173KB fixture, behavior locked by golden regression tests)
- Def analyzer checks realigned with the engine: client-visible flag set taken
  from `ENTITY_CLIENT_DATA_FLAGS` (no `ANY_CLIENT`), duplicate `<Type>` follows
  the engine's first-tag-wins loading, and an eighth check for engine-limited
  names (`ENTITY_LIMITED_PROPERTYS`) whose hit makes entity loading fail. Preset
  templates and the creation wizard no longer emit engine-invalid declarations
  (position/direction/spaceID on has-cell entities, the restricted name `id`)
- Snippet files containing comments or broken JSON are refused instead of being
  overwritten; snippet generator read/write IO failures surface the file path
  in the error message instead of throwing
- Dependency security pins via `pnpm.overrides` (`@vue/server-renderer` 3.5.42,
  `source-map-js` 1.2.2), closing two Dependabot alerts
- Nightly build workflow added (rolling release channel)
- KBEngine Dark theme now ships generic token colors following the VS Code
  Dark+ scope set (strings, keywords, numbers, types, functions, variables,
  operators, regexps), so common languages such as Python keep their syntax
  coloring under this theme; `.def`-specific rules are untouched, and the
  grammar keeps kbengine scopes deepest so `.def` coloring is byte-identical
  (root cause of the "switching to KBEngine Dark kills .py highlighting"
  report; regression-locked by a theme coverage test with a .def golden)

## [0.1.0] - unreleased

Feature state as of 2026-03-25. No git tag has been created for it and the
extension has not been published to the Marketplace; the release checklist
lives in PROJECT_SUMMARY.md / COMPLETED_FEATURES.md.

### Added
- Syntax highlighting for .def files
  - Source-backed KBEngine primitive/container/detail syntax highlighting
  - Container types (ARRAY, FIXED_DICT, TUPLE)
  - Source-backed flag names and DetailLevel values
- IntelliSense support
  - Type auto-completion
  - Flags smart suggestions
  - DetailLevel completion
  - XML tag suggestions
  - **Hooks completion (30+ hooks)**
- Code snippets
  - 13 common templates for properties and methods
  - Quick insert for property definitions
  - Quick insert for method definitions
- Hover documentation
  - Type descriptions and usage
  - Flag explanations
  - Best practices
  - **Hooks documentation with examples and source locations**
- Go to definition
  - Jump from entities.xml to .def files
  - Quick navigation to entity definitions
- Syntax validation
  - Real-time syntax checking
  - Flags conflict detection (BASE + CELL)
  - Type validity checking
- Entity Explorer sidebar
  - Display all entities from entities.xml
  - Show entity types (Cell/Base/Client)
  - Quick navigation to .def files
- **Hooks system support**
  - 30+ KBEngine hooks with full documentation
  - 12 categories: lifecycle, network, database, movement, space, witness, position, teleport, trap, cell, script, system
  - Hover documentation for all hooks including timing, signature, examples, and source locations
  - Auto-completion for hook methods

### Documentation
- Complete design document
- Developer quick start guide
- Naming suggestions document
- Contributing guidelines
- **Complete hooks reference**

### Changed
- **Updated license to Apache-2.0**
