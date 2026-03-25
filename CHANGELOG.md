# Changelog

All notable changes to the Kode extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Python integration (jump from Python to .def)
- Entity dependency graph visualization
- Refactoring support (rename properties/methods)
- Code generator for entity templates
- Performance analysis suggestions

## [0.1.0] - 2026-03-25

### Added
- Syntax highlighting for .def files
  - 16 basic types (UINT8-64, INT8-64, FLOAT, DOUBLE, BOOL, STRING, VECTOR2/3/4, MAILBOX)
  - Container types (ARRAY, FIXED_DICT, TUPLE)
  - 8 flag types (BASE, CLIENT, BASE_CLIENT, CELL_PUBLIC, CELL_PRIVATE, etc.)
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
