# kode-mcp

MCP server exposing kode's KBEngine `.def` knowledge base to AI agents
(MCP-001). Rust `rmcp` 3.7 + stdio, direct calls into the existing crates —
no Node dependency.

## Tools

| Tool | Input | Source |
|---|---|---|
| `search_entities` | `query` (substring, case-insensitive), optional `limit` | kode-parser parse + tag scan (properties/methods) |
| `get_entity_model` | `entity` | kode-parser `DefFile` full model: properties (type/flags/domains/persistent), methods per section, components, process ownership |
| `get_type_graph` | — | types.xml + alias.xml: alias chains, ARRAY `<of>`, FIXED_DICT fields, `implementedBy`, reference edges |
| `validate_defs` | optional `manifestPath` | parse diagnostics (file+line) across all defs/types.xml; with a process-topology manifest, adds C-17 mismatch findings |
| `get_message_entry` | `entity`, optional `method` filter | kode-server `message_table` (C-15) via `RpcRegistry` — same-source dispatch |
| `encode_decode_sample` | `typeName`, `value` (plain JSON or tagged) | kode-server `wire_codec` (C-15): hex byte sample + roundtrip decode |
| `db_schema_preview` | optional `entity` | kode-server `database_schema` (C-16) via `RpcRegistry` — MySQL DDL preview |

Tool-level failures (unknown entity/type) come back as `is_error: true`
results with the reason — never a fake success.

## Usage

```sh
kode-mcp <assets-root>        # e.g. ~/kbengine-demo-assets
```

MCP client config (stdio):

```json
{
  "mcpServers": {
    "kode": {
      "command": "/path/to/kode-mcp",
      "args": ["/path/to/kbengine/assets"]
    }
  }
}
```

## Tests

- `tests/units.rs` — same-source logic tests against the
  `tests/fixtures/kbengine-demo-assets` fixture (8 cases).
- `tests/e2e.rs` — real `rmcp` client over stdio spawning the binary:
  `list_tools` (all 7) → `call_tool` each tool with real data (3 cases).
  Gate: `cargo test -p kode-mcp`.

# kode-mcp（中文）

把 kode 的 KBEngine `.def` 知识库暴露给 AI agent 的 MCP server(MCP-001)。
Rust `rmcp` 3.7 + stdio,直调既有 crate,零 Node 依赖。

- 七个工具:`search_entities`(按名/标签查实体)/`get_entity_model`(实体全
  模型:属性/方法/Flags 三域/进程归属)/`get_type_graph`(别名/数组/
  FIXED_DICT 类型图+引用边)/`validate_defs`(解析诊断,可选进程拓扑错配
  预警 = C-17)/`get_message_entry`(消息号+布局 = C-15 同源)/
  `encode_decode_sample`(线格式字节样本+回解码)/`db_schema_preview`
  (def→DDL 预览 = C-16 同源)。
- 工具级失败(未知实体/类型)以 `is_error: true` 结果如实返回,不假成功。
- 运行:`kode-mcp <assets-root>`(资产根参数);MCP 客户端 stdio 接入见上。
- 测试:同源单测(demo-assets 夹具)+ rmcp 客户端 stdio 端到端
  (list_tools→call_tool 全工具真数据)。
