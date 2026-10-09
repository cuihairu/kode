# Changelog

All notable changes to the Kode extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- VitePress documentation site under `docs/`
- Detailed configuration reference for all `kbengine.*` settings
- Entity explorer navigation command for opening `.def` files directly
- Dependency graph export support for SVG and PNG
- Entity definition navigation inside `.def` files
- Two-layer test suite: vitest functional tests under `tests/` (1118 cases,
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
