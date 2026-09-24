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
- Two-layer test suite: vitest pure-logic tests under `tests/` (216 cases) plus
  the existing mocha/@vscode/test-electron integration tests (110 cases), with
  v8 coverage reporting; engine-source-backed conditional tests verify hook call
  sites, type registrations, and flags against a local KBEngine checkout
  (see TESTING.md)
- Python document hover/completion registration and a dedicated python snippet
  contribution (`snippets/kbengine-python.json`) so the four hot-reload
  templates are available in `.py` files
- Hook hover now short-circuits to hook docs before symbol hover, so method
  names in Methods sections show 调用时机/函数签名 instead of symbol-only hover
- Multi-line Methods/BaseMethods sections suggest hooks on later lines without
  a same-line section tag

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


### Planned
- Refactoring support (rename properties/methods)
- Performance analysis suggestions
- More entity templates and snippet generation tooling

## [0.1.0] - 2026-03-25

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

[Unreleased]: https://github.com/cuihairu/kode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cuihairu/kode/releases/tag/v0.1.0
