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
