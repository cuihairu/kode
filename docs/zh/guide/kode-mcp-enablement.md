# 为 AI 代理启用 kode-mcp 服务器

`kode-mcp` 是向 AI 编码代理暴露 KBEngine 项目知识的 MCP 服务器：实体 def、
类型、配置含义、协议帧、Python 符号与跨格式引用图。它是本工作区的 Rust
二进制（`crates/kode-mcp`），以 KBEngine 资产根目录为首个参数调用，可加
可选的知识额外路径。

同一服务器在 Roo Code、VS Code Copilot Chat、Claude Code 与 Cursor 下通用
——每个代理读一个 JSON 配置文件。工具列表相同，仅配置文件位置与格式不同。

## 前置：构建（或经 cargo 运行）

服务器是本仓库的普通 Rust 二进制：

```
cargo build -p kode-mcp --release
# -> crates/kode-mcp/target/release/kode-mcp
```

开发期可经 cargo 直接运行（启动较慢）：

```
cargo run -p kode-mcp -- <assets-root>
```

## 参数

- **`<assets-root>`**（首个，必填）：KBEngine 资产根——含
  `scripts/entity_defs/`（`.def`、`types.xml`、`alias.xml`）与
  `scripts/**/*.py` 的目录。
- **额外路径**（可选）：资产根之外要索引的附加知识目录或文件（如项目
  `.md` 文档、Excel）。

## Claude Code — `.mcp.json`（项目根）

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

改用发布二进制：

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

## Roo Code — `.roo/mcp.json`（项目根）

与 Claude Code 同形：

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

## VS Code Copilot Chat — `.vscode/mcp.json`（项目根）

同形：

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

## Cursor — `.cursor/mcp.json`（项目根）

与 Claude Code 同形：

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

## 可问什么

启用后服务器暴露结构感知项目知识索引。常见查询：

- `search_entities("Avatar")` — 有哪些实体及其 def。
- `get_entity_model("Account")` — 完整模型：属性、方法、标志。
- `find_symbol("level")` — 统一查找（实体 / 属性 / 类型 / Python）。
- `protocol_frame(typeName="SKILL_SLOT")` — 自定义类型的线布局。
- `why_setting("baseapp.archivePeriod")` — 配置值、含义、file:line。
- `list_config_settings(prefix="baseapp.")` — 全部配置含义。
- `search_docs("TrainingAvatar")` — 项目 `.md` 文档（root 是资产根目录时，项目根旁常规 `docs/`/`doc/` 目录自动并入；显式 CLI 附加路径照旧）。
- `search_symbols("Avatar")` — Python 类/函数/方法位置。
- `find_references("SKILL_SLOT")` — 跨格式引用边。
- `query_xml("entity.Avatar.Properties.level")` — XML 元素导航。
- `index_status` — 索引健康与置信度分布。

运行 `cargo test -p kode-mcp` 可对 `tests/fixtures/kbengine-demo-assets`
夹具验证服务器与全部工具。

## file:line 接地

指向项目文件的结果携带 `file`/`line` 对（引用边另有
`fromFile`/`fromLine`）。这些是磁盘上真实文件的 **1 基**源码行——def 属性
声明行、types.xml 类型声明行、Python 类/方法行、或配置键出处行
（`kbengine_defaults.xml:618`），可直接在编辑器跳转。没有合成行；解析器
无法归因的行如实省略而非猜测。
