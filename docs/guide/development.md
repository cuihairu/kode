# Development and Release


This page targets maintainers: how to develop locally, debug, build the docs, and control the versioning policy.

## Requirements

- Node.js `^20.19.0 || >=22.12.0` (prefer the version pinned in `.nvmrc`)
- pnpm: defer to the `packageManager` field in `package.json` (currently pnpm 12.10.1)
- VSCode 1.82.0 or newer — see the runtime matrix below for why this is the floor

## VS Code Runtime Matrix (REL-005)

The minimum supported VS Code is **1.82** (`engines.vscode: ^1.82.0`). This is derived, not inherited:

| Constraint | Floor | Basis |
| --- | --- | --- |
| `languages.registerInlayHintsProvider` (type-stub inlays) | 1.66 | stable API since 1.66; pinning `@types/vscode` to `1.82.0` makes `tsc` verify every API we use is ≤1.82 |
| `vscode.tests.createTestController` + `TestRun.appendOutput` | 1.59 / 1.61 | test-tree and output faces (IDE-TSK-005) |
| `workspace.onDidRenameFiles`/`onDidDeleteFiles`, `workspace.fs` | 1.33 / 1.34 | file events and virtual FS |
| esbuild `--target=node18` bundles (`out/extension.js`, `out/pythonParserWorker.js`) | **1.82** | VS Code 1.82+ embeds Node 18.15 (Electron 25); per the [vscode-versions](https://github.com/ewanharris/vscode-versions) mapping (Node 16→1.80, Node 18→1.82, Node 20→1.90) |

The binding floor is 1.82 (the Node runtime beats the API floor). Guards in `tests/runtimeMatrix.test.ts` keep three declarations in sync: `engines.vscode ≥1.82`, `@types/vscode` pinned to the same major.minor as `engines.vscode` (so a floating types package cannot hide an out-of-matrix API), and every `--target=nodeN` in the `bundle` script mapped to its minimum VS Code. Raising the bundle target later (e.g. to Node 20) fails the guard until `engines.vscode` moves to ≥1.90.

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

## Changed Code Has No Effect? Check Which Build VS Code Runs

Most "my change did nothing" reports are stale artifacts, not logic bugs. Check in order:

1. **Installed extension**: `%USERPROFILE%\.vscode\extensions` must contain a
   `cuihairu.kode-kbengine-*` folder (the extension id was renamed from `kode` to `kode-kbengine`, and the last segment follows the version); if it is absent, the extension is not installed
   and you are not testing this code.
   ```powershell
   Get-ChildItem $env:USERPROFILE\.vscode\extensions -Filter '*kode*'
   ```
2. **Extension Development Host (F5) artifact**: the entry point is `main` in
   `package.json` = `./out/extension.js`. Rebuild, then confirm the new code is
   actually in the artifact (using the jump-fix symbol as an example):
   ```bash
   pnpm run vscode:prepublish
   pnpm exec node -e "console.log(require('fs').readFileSync('out/extension.js','utf8').includes('resolveSelfMethodCandidates'))"
   # must print true; false means the compile is stale or was never run
   ```
3. **Rebuild and install** (shortest path; `out/` and `*.vsix` are gitignored):
   ```bash
   pnpm install
   pnpm run package        # vsce runs vscode:prepublish = compile + bundle
   code --install-extension kode-kbengine-*.vsix
   ```
   Then run `Developer: Reload Window` before testing.
4. **Confirm the extension activated**: activation events are only
   `workspaceContains:**/*.def` and opening a `.def` file — there is no
   `onLanguage:python`. In a pure-Python folder with no `.def` anywhere the
   extension never activates, so the Python definition provider does not exist.
   Open any `.def` file or switch to a workspace root that contains `.def`.
5. **No new setting is required**: none of the 41 `contributes.configuration`
   keys is a jump/mixin/index switch, and the Python definition provider is
   registered unconditionally at `src/extension.ts:205`.

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
5. Does the packaged VSIX contain the parser worker — after `vsce package`, unzip the artifact and confirm `extension/out/pythonParserWorker.js` is present, then start it from the unpacked path with `node` (`new Worker(<unpacked>/extension/out/pythonParserWorker.js)`) and check a parse request gets its `id`/`revision`/`parsed` reply. Structure guards for this live in `tests/vsixPackaging.test.ts`: `.vscodeignore` must exclude `out/**` before keeping `!out/pythonParserWorker.js`, the `bundle` script must keep the worker esbuild entry, and the worker/parser sources must not import `vscode` (the worker starts from the package path without the extension host). Verified 2026-10-29 on a locally packaged artifact (REL-003).
6. Does the packaged VSIX expose the build identity — the same unzipped artifact must carry `extension/out/buildCommit.json`, and its `commit` field must equal the `git rev-parse HEAD` the package was built from (verified 2026-10-29, REL-004). At runtime `readBuildCommit` reads `<extensionPath>/out/buildCommit.json` only; a missing or corrupt file reports `unknown` and never falls back to the source checkout's git state, so a source-tree commit can never impersonate the installed build.
7. Run the post-install smoke against the packaged artifact — `pnpm run test:smoke:vsix` packages the VSIX, unzips it into the install layout, loads the unpacked `extension/` folder as the extension in a real VS Code host, and asserts real hits: identity (extension path is the artifact, install-layout files present), hover on a `.def` tag, a `.def`→entity-script definition jump with an exact source line, and a cross-file self-method jump whose implementation lives in a >256 KiB Python file — a file that can only have been parsed by the packaged worker thread (REL-006, verified 2026-10-29; wiring locked by `tests/vsixSmokeWiring.test.ts`). `KODE_VSIX_PATH=<path.vsix>` can inject a prebuilt package for fast reruns.

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
