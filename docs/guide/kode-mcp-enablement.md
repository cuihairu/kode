# Enabling the kode-mcp server for AI agents

`kode-mcp` is the MCP server that exposes the KBEngine project knowledge to
AI coding agents: entity defs, types, config meanings, protocol frames,
Python symbols and the cross-format reference graph. It is a Rust binary in
this workspace (`crates/kode-mcp`), invoked with the KBEngine assets root as
its first argument, plus optional extra knowledge paths.

The same server works across Roo Code, VS Code Copilot Chat, Claude Code and
Cursor — each reads a JSON config file. The tool list is identical; only the
config file location and format differ.

## Prerequisite: build (or run via cargo)

The server is a normal Rust binary in this repo:

```
cargo build -p kode-mcp --release
# -> crates/kode-mcp/target/release/kode-mcp
```

For development you can run it through cargo instead of a prebuilt binary
(slower to start):

```
cargo run -p kode-mcp -- <assets-root>
```

## Arguments

- **`<assets-root>`** (first, required): the KBEngine assets root — the
  directory containing `scripts/entity_defs/` (`.def` files, `types.xml`,
  `alias.xml`) and `scripts/**/*.py`.
- **extra paths** (optional): additional knowledge directories or files to
  index (e.g. project `.md` docs, Excel files) beyond the assets root.

## Installing from npm (packaging ready, not yet published)

The binary is published the way `esbuild` and `@swc/core` ship theirs:
`@cuihairu/kode-mcp` contains only a launcher script, and the platform
binary comes from a per-platform optional dependency
(`@cuihairu/mcp-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`,
`-win32-x64`, `-win32-arm64`). npm installs exactly one of those, so the
client config stays a single stable command on every OS:

```
npm install @cuihairu/kode-mcp
# config then points at the launcher instead of a cargo build:
{ "command": "kode-mcp", "args": ["/abs/path/to/assets"] }
```

**The tarballs are not on the registry yet.** The packaging mechanism is built
and verified in this repository — `scripts/npm-package.mjs`
(`build`/`pack`/`verify`/`smoke`/`prepare`/`publish`) and the manual
`npm.yml` workflow cross-compile `kode-mcp` for all six targets, pack, and run
a real MCP handshake (`initialize` + `tools/list` returning 25 tools) on each
native runner. Publishing is intentionally left to an explicit trigger that
supplies the version number, matching how this project releases. Until then,
use the cargo build above, or point `KODE_MCP_BINARY` at a binary you already
have — the launcher honours it first.

## Publishing: required environment and secrets

Three different things need credentials; they are deliberately separated so a
build can never reach the registry on its own.

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NODE_AUTH_TOKEN` | CI only, injected from the `NPM_TOKEN` secret | The value npm expands **from `.npmrc`**. npm does not read this name itself — see the note below. |
| `NPM_TOKEN` | GitHub Actions repository secret | Granular access token, scope **All packages**, permission **Read and write**. A classic token cannot be used for automated publish. |
| `KODE_NPM_PUBLISH=1` | local or CI | The explicit gate. `scripts/npm-package.mjs publish` refuses to run without it, so a build cannot publish by accident. |
| `KODE_MCP_BINARY` | client runtime | Absolute path to a `kode-mcp` binary. Overrides platform-package lookup — use it for offline installs or when an IDE already owns a build. |
| `RUST_LOG=off` | smoke harness | Quietens the staged binary during the handshake check. |

### Note: `NODE_AUTH_TOKEN` is a `.npmrc` placeholder, not an npm variable

Verified against npm 11.19.0 and `actions/setup-node`:

- Grepping the whole npm installation for `NODE_AUTH_TOKEN` and `NPM_TOKEN`
  returns **zero** hits. npm reads `_authToken` from config only.
- With only `NODE_AUTH_TOKEN` set, `npm publish` fails with `ENEEDAUTH /
  need auth … using npm adduser` — **before any network request**.
- `setup-node`'s `authutil.ts` writes `//<host>/:_authToken=${NODE_AUTH_TOKEN}`
  into a generated `.npmrc`; npm expands that `${...}` at read time.

Consequences for this workflow:

1. `setup-node` must be given `registry-url` — otherwise it never writes the
   `.npmrc` and the token is dead. `npm.yml` sets it.
2. Do **not** put the token in the repository's own `.npmrc`: it would be
   committed. The generated `.npmrc` lives in the runner's temp dir.
3. Locally, `npm config set //registry.npmjs.org/:_authToken <token>` or a
   user-level `~/.npmrc` is the equivalent — never a repository file.

### One-time account setup

1. `npm profile login` in a browser (npm enforces 2FA on every account, so a
   token is created from the account's 2FA page rather than a plain password).
2. Publish scope: `@cuihairu/*` resolves to your **personal** npm account. npm
   has no free organisation scope, so do not expect `@kode/...` unless that
   scope is already yours.
3. Every package already carries `"publishConfig": { "access": "public" }`,
   which is required for scoped packages — without it npm answers `402`.
4. First publish is unpublished by default. Add `--access public` (done
   automatically by the script) when a package should be visible to everyone.

### Publishing from CI

`.github/workflows/npm.yml` is manual-only (`workflow_dispatch`) and mirrors
`publish.yml`:

```
version:  0.2.0     # must equal the committed package.json version
publish:   false     # true only publishes after all validation passes
```

`permissions: contents: read` and `concurrency: kode-npm-publish` keep a run
from publishing mid-rebase. The `prepare` job re-runs
`verify-npm-set.mjs` on the downloaded tarballs before anything ships, and the
binary-size cap in `verify` blocks an unstripped debug build (200 MB limit).

### Publishing locally

```
export KODE_NPM_PUBLISH=1
export NODE_AUTH_TOKEN=<granular token>
node scripts/npm-package.mjs pack            # build dist/npm/*.tgz
node scripts/npm-package.mjs publish --dry   # inspect the exact upload
node scripts/npm-package.mjs publish         # upload
```

`publish` uploads the packed tarballs rather than re-packing the directories,
so what leaves the machine is byte-for-byte what `pack` verified.

### Verifying without publishing anything

```
node scripts/npm-package.mjs verify   # static checks, always safe
node scripts/npm-package.mjs smoke    # real MCP handshake on a staged binary
node scripts/npm-package.mjs sizes     # tarball and binary sizes
```


## Claude Code — `.mcp.json` (project root)

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

With a release binary instead:

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "/abs/path/to/crates/kode-mcp/target/release/kode-mcp",
      "args": ["/abs/path/to/kbengine-assets"]
    }
  }
}
```

## Roo Code — `.roo/mcp.json` (project root)

Same shape as Claude Code:

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

## VS Code Copilot Chat — `.vscode/mcp.json` (project root)

Same shape:

```json
{
  "servers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

## Cursor — `.cursor/mcp.json` (project root)

Same shape as Claude Code:

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

## What you can ask

Once enabled, the server exposes the structure-aware project knowledge
index. Common queries:

- `search_entities("Avatar")` — which entities exist and their defs.
- `get_entity_model("Account")` — full model: properties, methods, flags.
- `find_symbol("level")` — unified lookup (entity / property / type / Python).
- `protocol_frame(typeName="SKILL_SLOT")` — wire layout of a custom type.
- `why_setting("baseapp.archivePeriod")` — config value, meaning, file:line.
- `list_config_settings(prefix="baseapp.")` — all config meanings.
- `search_docs("TrainingAvatar")` — project `.md` docs (assets root plus conventional project-root `docs/`/`doc/` dirs auto-included when the root is an assets directory; explicit CLI extra paths still honored).
- `search_symbols("Avatar")` — Python class/function/method locations.
- `find_references("SKILL_SLOT")` — cross-format reference edges.
- `query_xml("entity.Avatar.Properties.level")` — XML element navigation.
- `index_status` — index health and confidence distribution.

Run `cargo test -p kode-mcp` to verify the server and its tools against the
fixture assets under `tests/fixtures/kbengine-demo-assets`.

## file:line grounding

Results that point into project files carry a `file`/`line` pair (and
`fromFile`/`fromLine` for reference edges). These are **1-based** source
lines of the real file on disk — a def property's declared line, a types.xml
type declaration line, a Python class/method line, or a config key's origin
line (`kbengine_defaults.xml:618`). They are editor-jumpable as-is. No result
line is synthesized; a line the parser cannot attribute is omitted rather than
guessed.
