<p align="center"><img src="resources/logo.png" width="64" height="64" alt="logo" /></p>

<h1 align="center">Kode — KBEngine Development Environment</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS_Code-1.50.0+-blue.svg" alt="VS Code" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-4.x-blue.svg" alt="TypeScript" /></a>
</p>

[English](README.md) | [中文](README.zh.md)

> **Kode** (KBEngine IDE) - A VS Code development assistant extension for KBEngine

## Introduction

**Kode** is a VS Code extension that provides language support, navigation, and helper panels for the [KBEngine](https://github.com/kbengine/kbengine) game server framework.

KBEngine is an open-source MMO game server framework built on a distributed architecture. Kode targets KBEngine's entity definition (`.def`) files and provides syntax highlighting, completion, hover information, navigation, and diagnostics, along with panels for entity browsing, server control, logs, monitoring, and the dependency graph, plus a code generator.

## Daily Builds

The repository automatically builds from `main` every day and **publishes a rolling release** to [the `nightly` tag on Releases](https://github.com/cuihairu/kode/releases/tag/nightly): each build replaces the previous release's assets and notes (including build time, commit, and an asset table). The tag stays `nightly` and the repository carries no version tags. The scheduled build skips automatically for that day when the default branch has no new commits within 48 hours. The build pipeline lives in [.github/workflows/daily-build.yml](.github/workflows/daily-build.yml).

| Asset | Platform | Install |
|------|------|------|
| `kode-nightly.vsix` | Windows / macOS / Linux (universal for VS Code ≥1.50) | Download and run `code --install-extension kode-nightly.vsix` |

The extension is **still not published to the VS Code Marketplace**; `nightly` is currently the only prebuilt distribution channel. You can also build from source as described in the Installation section below.

## Core Features

### Syntax Highlighting
- [Syntax highlighting for `.def` files]
- [Source-backed semantic highlighting for primitives/containers/detail values]
- [Highlighting for container types (ARRAY, FIXED_DICT, TUPLE)]
- [Source-backed Flags / DetailLevel highlighting]

### IntelliSense
- [Type auto-completion]
- [Flags suggestions]
- [DetailLevel suggestions]
- [XML tag suggestions]
- [**Hook method completion (36 hooks, each with its KBEngine source call-site location)**]

### Code Snippets
- [11 common .def templates + 4 Python hot-reload templates (snippets/kbengine-python.json) + 2 types.xml type-alias templates (ARRAY uses the engine's `<of>` syntax; engine-unregistered types such as BOOL/TUPLE have been removed)]
- [One-click insertion of property definitions]
- [Quick generation of method definitions]
- [Snippet generation from the selection (Generate Snippet from Selection, merged into `.vscode/kbengine-custom.code-snippets`)]

### Hover Documentation
- [Detailed type descriptions]
- [Explanations of Flags usage]
- [Usage recommendations]
- [**Hook documentation** (invocation timing, function signatures, usage examples, source locations)]

### Go to Definition
- [Navigate from `entities.xml` to `.def` files]
- [Quick location of entity definitions]

### Refactoring
- [F2 renaming of properties/methods within .def files]
- [Updates every same-name declaration in the file, across all Flags-scope variants]
- [Auto-syncs restatements in descendant defs along the Parent chain and Interfaces mixins]
- [Honest boundary: covers only .def definitions and references; Python-side references and entities.xml/types.xml are not touched]

### Syntax Checking
- [Real-time syntax validation]
- [Source-verifiable Flags / DetailLevel / required-field validation]
- [Type validity checking]

### Entity Explorer
- [Sidebar listing of all entities]
- [Entity type badges (Cell/Base/Client)]
- [Quick navigation]

### Hooks System
- [36 KBEngine entity script callbacks (verified one by one against the engine source; entries without a source basis were removed)]
- [10 categories: lifecycle, database & archiving, movement, space, teleport, trap, Cell, visibility, control, client]
- [Complete hook documentation and usage examples]
- [Source location annotations]

### Hot-Reload Support
- [Hot-reload code snippets (4, snippets/kbengine-python.json, available in Python files)]
- [KBEngine.reloadScript() suggestions]
- [importlib.reload() hot reload in Python scripts]
- [Reload-related hover documentation and usage examples]

### Server Management
- [Start/stop control for 10 components]
- [Live status display (stopped/starting/running)]
- [Process PID display]
- [Per-component log output]
- [Status bar running-component count]
- [Custom paths and environment variables]

### Log Viewer Integration
- [logger connection entry point with status notes]
- [WebView-based visualization]
- [Multi-level filtering (level, component, keyword)]
- [Regular-expression search]
- [Log export (txt/log/json formats)]
- [Color-coded log levels]

The logger protocol adaptation is not finished yet; the extension states clearly that this capability is not yet supported instead of pretending the official protocol is connected.

### Embedded Python Debugging
- [Custom debug configuration (.kbengine/debug.json)]
- [Per-component debug settings]
- [Automatic launch.json generation]
- [Guided debug enablement via telnet prompts]
- [Attach to KBEngine component processes by PID]
- [Path mapping configuration]

### Monitoring Panel
- [Runtime monitoring based on machine + watcher]
- [CPU, memory, entity counts, and verified watcher metrics]
- [System overview cards]
- [Per-component detail cards]
- [Visual charts (bar and line charts)]
- [Data export (JSON format)]

Monitoring data requires both `machine` discovery and `watcher` queries. When the watcher does not respond, the panel keeps only the basic state returned by machine instead of dressing missing watcher metrics up as complete telemetry.

### Python ↔ Def Two-Way Navigation
- [Entity definition mapping manager]
- [Jump from generated Python files back to .def definitions]
- [IntelliSense in Python files (completion of properties and methods)]
- [Automatic scanning and mapping]
- [Multiple Python generation path configurations]

### Entity Dependency Graph
- [Automatic analysis of entity inheritance]
- [Visual entity dependency graph (Mermaid.js)]
- [Shows Base/Cell/Client entity types]
- [Statistics panel (entity count, maximum depth, most-referenced entities)]
- [Jump from the graph to entity definition files]
- [Graph export (PNG/SVG formats)]

### Code Generator
- [Entity creation wizard (step-by-step guidance)]
- [10 predefined templates (account, avatar, NPC, item, monster, scene, guild, team, mail, empty entity)]
- [Automatic .def generation (KBEngine-compliant format)]
- [Automatic Python generation (with hook methods)]
- [Automatic entity registration in entities.xml]
- [Custom property and method definitions]
- [Configurable output paths and options]

### Telnet Probe and Session Integration
- [Status bar + server control panel status lamps (connected / open / password rejected / off, etc.)]
- [Three-tier configuration: settings / the kbengine.xml `<telnet_service>` section / the engine's default port table for the seven components]
- [Low-frequency probing (5s by default); probe connections are destroyed immediately, never held]
- [Automatic handshake login when the port is open; the password goes only through the socket and never into logs]
- [Panel command input (whitelist + built-in read-only quick commands) with session output echo]
- [Honest "telnet off" notice with the kbengine.xml enablement snippet when the port is closed]

### HTTP Quick Requests
- [`kbengine.httpRequests` settings list: name / URL template / method / headers / body / enable switch / keybinding hint, with one bundled example (disabled by default)]
- [Four template variables: `${module}` (workspace-relative module path, `entities/fight/FightAI.py` → `entities.fight.FightAI`), `${file}`, `${line}`, `${sel}`; substituted literally, no URL encoding]
- [Two trigger paths: the command-palette quick pick, or a keybinding on `kbengine.httpRequest.run` with `args.name` via keybindings.json — open a .py file and press the shortcut to fire a hot reload]
- [Execution log goes to the OUTPUT channel "KBEngine HTTP 快捷请求": `▶` request line → `✓` status · duration · response body; failures show a `✗` marker + error notification, with honest reporting and no hanging]

## Def Performance Analysis

Runs a static check over all `.def` files in the workspace and reports optimization suggestions (execute **`Analyze Def Performance`** from the command palette; the report goes to the `KBEngine Def 分析` output panel and also lands in the Problems list as diagnostics):

- Engine-unregistered types (e.g. `BOOL`/`TUPLE`) — entity loading fails
- Properties missing a valid `<Type>`, or redundant definitions with multiple `<Type>` tags on one property
- Sync-cost hints for heavy-payload types (strings/BLOB/containers/PY_*/VECTOR) broadcast to `ALL_CLIENTS`
- Redundant `DetailLevel` fields on properties without client-visible flags
- Property/method names that are Python keywords, or methods colliding with property names
- Property/method/component-slot names hitting the engine's limited-name list (`ENTITY_LIMITED_PROPERTYS`) — entity loading fails

## Installation

> **Not yet published to the VS Code Marketplace.** To skip local builds, grab `kode-nightly.vsix` from the [Daily Builds](#daily-builds) section; otherwise build from source and install locally as follows.

### Build from Source and Install Locally

```bash
# Clone the repository
git clone https://github.com/cuihairu/kode.git

# Install dependencies
cd kode
pnpm install

# Compile
pnpm run compile

# Package (vsce package produces a .vsix)
pnpm run package

# Install locally
code --install-extension kode-0.1.1.vsix
```

## Documentation

- Configuration and usage documentation lives in [docs/](./docs/)
- The configuration reference is the highlight: [docs/guide/configuration.md](./docs/guide/configuration.md)
- The project ships a VitePress documentation site; preview it locally with `pnpm run docs:dev`

## Versioning

The project currently stays on the `0.1.x` fix-and-polish line by default.

- Fixes, documentation, and enhancements to existing features: stay on `0.1.x`
- Move to `0.2.0` only when a clear new stage of feature work arrives

## Screenshots

### Syntax Highlighting and IntelliSense
Screenshot material is not ready yet. For now, press `F5` to launch the Extension Development Host and preview syntax highlighting, IntelliSense, hover documentation, and diagnostics directly in `.def` files.

### Entity Explorer
Screenshots of the entity explorer and server control panel will be added along with the documentation assets; in the meantime, verify them against the feature notes in [docs/](./docs/) and a local debug window.

## Development

### Requirements

- Node.js `^20.19.0 || >=22.12.0` (the version in `.nvmrc` is recommended)
- Git
- VS Code 1.50.0 or later

### Development Steps

```bash
# 1. Clone the repository
git clone git@github.com:cuihairu/kode.git

# 2. Install dependencies
cd kode
pnpm install

# 3. Open the project in VS Code
code .

# 4. Press F5 to start debugging
# A new VS Code window opens (the Extension Development Host)

# 5. Exercise the features in that window
```

### Project Structure

```
kode/
├── src/
│   ├── extension.ts              # Main entry point
│   ├── languageProviders.ts      # Language features
│   ├── explorerProviders.ts      # Tree views and navigation
│   ├── kbengineMetadata.ts       # KBEngine metadata
│   └── ...
├── syntaxes/
│   ├── kbengine.tmLanguage.json  # Syntax highlighting rules
│   └── kbengine-color-theme.json # Color theme (KBEngine Dark)
├── snippets/
│   ├── kbengine.json             # def snippets (11)
│   ├── kbengine-python.json      # Python hot-reload snippets (4)
│   └── kbengine-types-xml.json   # types.xml type-alias snippets (2)
├── resources/
│   └── docs/                     # Project documents
├── .vscode/
│   └── launch.json               # Debug configuration
├── package.json                  # Extension configuration
├── tsconfig.json                 # TypeScript configuration
└── README.md                     # This file
```

### Testing

```bash
# Run the tests
pnpm test

# Compile
pnpm run compile

# Watch-mode compile
pnpm run watch

# Documentation
pnpm run docs:dev
```

## Usage Documentation

For detailed usage documentation and development guides, see:

- [VitePress documentation](./docs/) - the current documentation entry point
- [Design document](./resources/docs/vscode-extension-design.md) - the original project design
- [Quick start](./resources/docs/vscode-extension-summary.md) - developer guide
- [Naming proposal](./resources/docs/plugin-name-suggestions.md) - brand design

## Testing Architecture

A two-runner, layered test setup: vitest carries all functional tests (`tests/`, including a pure-logic layer, a local KBEngine simulator layer, and an assembly/WebView panel layer on top of fake-vscode stubs — all green without a real KBEngine environment); mocha (`src/test/suite/`, 11 cases) only smoke-tests the compiled artifacts, verifying that the packaged `out/extension.js` activates cleanly. With a KBEngine source checkout present, line-by-line "plugin data vs engine source" verification cases are added automatically. See [TESTING.md](./TESTING.md) and the [redesign notes](./docs/redesign.md) for details.

```bash
pnpm test           # Full suite: vitest + compile + mocha smoke tests
pnpm test:unit      # vitest only (green with no engine and no VS Code download)
pnpm test:coverage  # vitest + coverage
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

### Contributing Guide

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under Apache-2.0 - see the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [KBEngine](https://github.com/kbengine/kbengine) - an excellent game server framework
- [VS Code](https://github.com/microsoft/vscode) - the host editor for this extension
- All contributors

## Contact

- GitHub Issues: [https://github.com/cuihairu/kode/issues](https://github.com/cuihairu/kode/issues)
- Email: cuihairu@gmail.com

## Star History

If this project helps you, consider giving it a star.

---

Current version 0.1.1, not yet published to the Marketplace. 21 features, 26 commands, and 31 configuration settings are in place; see [COMPLETED_FEATURES.md](./COMPLETED_FEATURES.md) for the feature list and [TESTING.md](./TESTING.md) for the testing record.
