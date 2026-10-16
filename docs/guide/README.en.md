# Quick Start

[English](./README.en.md) | [中文](./README.md)

## Install Dependencies

```bash
pnpm install
```

## Start Extension Development

```bash
pnpm run watch
code .
```

Then press `F5` in VSCode to start the Extension Development Host.

## Documentation Site

This project uses VitePress for its documentation site.

```bash
pnpm run docs:dev
```

Build the output:

```bash
pnpm run docs:build
```

## Version Policy

The current stage stays on the `0.1.x` line for continuous fixes.

- `0.1.x`
  - For fixing issues, supplementing docs, enhancing existing features, and refining interactions
- `0.2.0`
  - Considered only with a clear feature-level upgrade or a compatibility boundary change

If you are contributing to releases or maintenance, do not upgrade to `0.2.0` just because "it keeps getting better".

## Recommended KBEngine Project Structure

```text
your-project/
├── scripts/
│   ├── entities.xml
│   ├── entity_defs/
│   │   ├── Avatar.def
│   │   └── Account.def
│   └── base/
├── server/
└── kbengine/
```

## Capability Overview

- `.def` syntax highlighting, hover, diagnostics, navigation
- Bidirectional Python ↔ `.def` navigation
- Entity explorer and server control panel
- Telnet probing with panel integration (status light, auto login, whitelisted commands)
- HTTP quick requests (URL template variables, hot-update straight from a keybinding)
- Log viewer, monitoring panel, dependency graph
- Entity code generator
- Database simulation (row data and insert/update/delete previews on top of the schema)
- Auto-discovery for path-like settings (conventions → bounded deep scan → multi-candidate ask-and-remember)

Notes:
both the log viewer and the monitoring panel depend on KBEngine's runtime protocols.
If the logger/watcher responses misbehave, these two degrade to partial capability instead of full telemetry.

For details see [Feature Overview](./features.md).

## Where to Read Next

- To tune behavior and paths: see the [configuration reference](./configuration.md)
- For command entry points and panel purposes: see [Commands and Panels](./commands.md)
- For the `.def` language surface: see [Language Features](./language.md)
- For logs, the dependency graph, and the generator: see [Log Viewer](./logging.md), [Entity Dependency Graph](./dependency-graph.md), [Code Generator](./generator.md)
- To join maintenance and release work: see [Development and Release](./development.md)
