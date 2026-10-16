# Development and Release


This page targets maintainers: how to develop locally, debug, build the docs, and control the versioning policy.

## Requirements

- Node.js `^20.19.0 || >=22.12.0` (prefer the version pinned in `.nvmrc`)
- pnpm: defer to the `packageManager` field in `package.json` (currently pnpm 12.10.1)
- VSCode 1.50.0 or newer

## Local Development

```bash
pnpm install
pnpm run watch
code .
```

Then press `F5` in VSCode to start the Extension Development Host.

## Common Scripts

```bash
pnpm run compile
pnpm run watch
pnpm run lint
pnpm test
pnpm run docs:dev
pnpm run docs:build
pnpm run package
```

## Testing

Tests depend on neither a real KBEngine environment nor a VSCode download:
vitest (`tests/`) carries all functional tests — pure logic, the local
simulators (`tests/sim/`), and assembly/panel tests on the fake-vscode stand-in
(`tests/fake-vscode/`); mocha (`src/test/suite/`) only smoke-tests the compiled
artifacts (activation/commands/completion of the packaged `out/extension.js`).
For the layering and how to run, see
[TESTING.md](https://github.com/cuihairu/kode/blob/main/TESTING.md) and the
[redesign notes](../redesign.md).

## Working on the Docs

The VitePress docs entry point is `docs/`.

### Local Preview

```bash
pnpm run docs:dev
```

### Build the Static Site

```bash
pnpm run docs:build
```

## Pre-Release Checks

Check at least the following:

1. Are `README.md`, `docs/`, and `CHANGELOG.md` in sync
2. Are the commands, settings, and version in `package.json` correct
3. Does the `.def` language surface match what the docs describe
4. Do the dependency graph, entity explorer, logs, and debug entry points open

## Version Policy

The project is still in the `0.1.x` fix-and-refine stage.

### When to Stay on `0.1.x`

These changes default to patch versions:

- Bug fixes
- Documentation improvements
- Refining existing features
- Adding settings without changing existing default behavior
- Improving hover, diagnostics, highlighting, and navigation

### When to Consider `0.2.0`

Only with an obvious stage upgrade, for example:

- Introducing a major new module
- Broadly changing default behavior
- Introducing configuration changes that require migration
- Clearly changing the external capability boundary

## Recommended Release Cadence

### Day-to-Day Fixes

- Version: `0.1.x`
- Update `CHANGELOG.md`
- Push to `main` after committing

### Stage Releases

1. Summarize doc and feature changes
2. Confirm screenshots, descriptions, version
3. Run `pnpm run package`
4. Then decide whether to publish to the Marketplace

## Current Documentation Maintenance Principles

- `README.md` is the repo homepage overview
- `docs/` holds the long-term maintained structured documentation
- `CHANGELOG.md` records version changes
- Design documents under `resources/docs/` are kept as design deposits, no longer the sole usage documentation
