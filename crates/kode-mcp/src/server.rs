//! kode-mcp MCP server(rmcp stdio)。装配 AssetKnowledge + explain;
//! 资产根从 CLI 参数取(缺省=当前目录)。

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::stdio,
    ErrorData as McpError, RoleServer, ServerHandler, ServiceExt,
};
use std::future::Future;
use std::sync::Arc;

use crate::kb::AssetKnowledge;

#[derive(Debug)]
pub struct KodeMcpServer {
    pub knowledge: AssetKnowledge,
    /// 资产根(config_qa 配置问答面读 `{root}/res/server/kbengine.xml` 等)。
    pub assets_root: std::path::PathBuf,
    /// 额外知识路径(CLI 附加参数;search_docs 在此+资产根下收 `.md`)。
    pub extra_paths: Vec<std::path::PathBuf>,
}

fn object(schema: serde_json::Value) -> Arc<rmcp::model::JsonObject> {
    Arc::new(
        schema
            .as_object()
            .cloned()
            .expect("tool schema must be an object"),
    )
}

fn schema_of(properties: serde_json::Value, required: &[&str]) -> serde_json::Value {
    let required_list: Vec<serde_json::Value> = required
        .iter()
        .map(|name| serde_json::json!(name))
        .collect();
    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required_list,
    })
}

impl KodeMcpServer {
    fn tool(name: &'static str, description: &str, schema: serde_json::Value) -> Tool {
        let mut tool = Tool::default();
        tool.name = name.into();
        tool.description = Some(std::borrow::Cow::Owned(description.to_string()));
        tool.input_schema = object(schema);
        tool
    }

    fn text_result(value: serde_json::Value) -> Result<CallToolResponse, McpError> {
        let payload = serde_json::to_string_pretty(&value)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(payload)]).into())
    }

    fn error_result(message: String) -> Result<CallToolResponse, McpError> {
        Ok(CallToolResult::error(vec![ContentBlock::text(message)]).into())
    }

    fn call_tool_impl(&self, params: CallToolRequestParams) -> Result<CallToolResponse, McpError> {
        let arguments = params.arguments.clone().unwrap_or_default();
        let arg_str = |key: &str| {
            arguments
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        let result = match params.name.as_ref() {
            "search_entities" => {
                let query = arg_str("query").unwrap_or_default();
                let limit = arguments
                    .get("limit")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(20) as usize;
                Ok(self.knowledge.search_entities(&query, limit.max(1)))
            }
            "get_entity_model" => match arg_str("entity") {
                Some(entity) => self.knowledge.get_entity_model(&entity),
                None => Err("missing argument: entity".to_string()),
            },
            "get_type_graph" => Ok(self.knowledge.get_type_graph()),
            "validate_defs" => Ok(self
                .knowledge
                .validate_defs(arg_str("manifestPath").as_deref())),
            "get_message_entry" => match arg_str("entity") {
                Some(entity) => self
                    .knowledge
                    .get_message_entry(&entity, arg_str("method").as_deref()),
                None => Err("missing argument: entity".to_string()),
            },
            "encode_decode_sample" => {
                let value = arguments
                    .get("value")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                match arg_str("typeName") {
                    Some(type_name) => self.knowledge.encode_decode_sample(&type_name, &value),
                    None => Err("missing argument: typeName".to_string()),
                }
            }
            "db_schema_preview" => self
                .knowledge
                .db_schema_preview(arg_str("entity").as_deref()),
            "explain" => Ok(crate::explain::explain(
                &arg_str("topic").unwrap_or_default(),
                arg_str("domain").as_deref(),
                &arg_str("locale").unwrap_or_else(|| "en".to_string()),
            )),
            "get_final_config" => Ok(crate::config_qa::final_config(&self.assets_root)),
            "get_entry_scripts" => Ok(crate::config_qa::entry_scripts(&self.assets_root)),
            "get_database_schema" => match arg_str("entity") {
                Some(entity) => crate::config_qa::database_schema(&self.knowledge, Some(&entity)),
                None => crate::config_qa::database_schema(&self.knowledge, None),
            },
            "why_setting" => match arg_str("key") {
                Some(key) => crate::config_qa::why_setting(&self.assets_root, &key),
                None => Err("missing argument: key".to_string()),
            },
            "list_config_settings" => Ok(crate::config_qa::list_config_settings(
                &self.assets_root,
                arg_str("group").as_deref(),
                arg_str("prefix").as_deref(),
            )),
            // 注:search_docs/search_symbols 在 call_tool 里走 spawn_blocking
            // 面,不经过 call_tool_impl(此面只处理同步工具)。
            "protocol_frame" => crate::protocol_frame::protocol_frame(
                &self.knowledge,
                arg_str("typeName").as_deref(),
                arg_str("entity").as_deref(),
                arg_str("method").as_deref(),
                arg_str("section").as_deref(),
            ),
            "find_symbol" => {
                let query = arg_str("query").unwrap_or_default();
                let limit = arguments
                    .get("limit")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(20) as usize;
                crate::semantic_model::find_symbol(
                    &self.knowledge,
                    &self.assets_root,
                    &query,
                    limit.max(1),
                )
            }
            "index_status" => Ok(crate::semantic_model::index_status(
                &self.knowledge,
                &self.assets_root,
            )),
            "find_references" => {
                let symbol = arg_str("symbol").unwrap_or_default();
                let limit = arguments
                    .get("limit")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(20) as usize;
                crate::semantic_model::find_references(
                    &self.knowledge,
                    &self.assets_root,
                    &symbol,
                    limit.max(1),
                )
            }
            "query_xml" => crate::semantic_model::query_xml(
                &self.knowledge,
                &self.assets_root,
                arg_str("path").as_deref().unwrap_or(""),
            ),
            "read_node" => {
                let node = arg_str("node").unwrap_or_default();
                let limit = arguments
                    .get("limit")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(crate::read_node::DEFAULT_LIMIT_LINES as u64)
                    as usize;
                crate::read_node::read_node(&self.knowledge, &self.assets_root, &node, limit)
            }
            other => Err(format!("unknown tool: {other}")),
        };
        match result {
            Ok(value) => Self::text_result(value),
            Err(message) => Self::error_result(message),
        }
    }
}

impl ServerHandler for KodeMcpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::default())
            .with_server_info(Implementation::new("kode-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Pass the KBEngine assets root as the CLI argument. Tools: search_entities, \
                 get_entity_model, get_type_graph, validate_defs, get_message_entry, \
                 encode_decode_sample, db_schema_preview, explain, get_final_config, \
                 get_entry_scripts, get_database_schema, why_setting, list_config_settings, \
                 search_docs, search_symbols, protocol_frame, find_symbol, index_status, \\\n                 find_references, query_xml, read_node.",
            )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + Send + '_ {
        let result = ListToolsResult {
            tools: vec![
                Self::tool(
                    "search_entities",
                    "Search KBEngine entity defs by entity name or tag (property/method name). Case-insensitive substring match.",
                    schema_of(
                        serde_json::json!({
                            "query": {"type": "string", "description": "substring to match against entity names and tags"},
                            "limit": {"type": "integer", "description": "max matches (default 20)"}
                        }),
                        &["query"],
                    ),
                ),
                Self::tool(
                    "get_entity_model",
                    "Full model of one entity: properties (type/flags/domains/persistent), methods per section, components, process ownership.",
                    schema_of(
                        serde_json::json!({
                            "entity": {"type": "string", "description": "entity def name (file stem)"}
                        }),
                        &["entity"],
                    ),
                ),
                Self::tool(
                    "get_type_graph",
                    "Custom type graph from types.xml + alias.xml: alias chains, ARRAY element types, FIXED_DICT fields, implementedBy.",
                    serde_json::json!({"type": "object", "properties": {}}),
                ),
                Self::tool(
                    "validate_defs",
                    "Validate all defs: parse diagnostics (file+line). Optional manifestPath adds process-topology mismatch warnings (C-17).",
                    schema_of(
                        serde_json::json!({
                            "manifestPath": {"type": "string", "description": "optional process topology manifest XML path"}
                        }),
                        &[],
                    ),
                ),
                Self::tool(
                    "get_message_entry",
                    "Message-table entries for one entity (C-15 same source): method name, utype, aliasID, argument wire layouts. Optional method substring filter.",
                    schema_of(
                        serde_json::json!({
                            "entity": {"type": "string", "description": "entity def name"},
                            "method": {"type": "string", "description": "optional method-name substring filter"}
                        }),
                        &["entity"],
                    ),
                ),
                Self::tool(
                    "encode_decode_sample",
                    "Encode a JSON value into the entity wire format (hex byte sample) via types.xml/alias.xml resolution, then decode it back (roundtrip).",
                    schema_of(
                        serde_json::json!({
                            "typeName": {"type": "string", "description": "type name resolvable through types.xml/alias.xml"},
                            "value": {"description": "JSON value matching the wire layout"}
                        }),
                        &["typeName", "value"],
                    ),
                ),
                Self::tool(
                    "db_schema_preview",
                    "Database DDL preview derived from defs (C-16 same source). entity omitted = all entities.",
                    schema_of(
                        serde_json::json!({
                            "entity": {"type": "string", "description": "optional entity def name"}
                        }),
                        &[],
                    ),
                ),
                Self::tool(
                    "explain",
                    "Explain a KBEngine API member (C-21 same-source library: signature, summary, source refs) or a mechanism topic (knowledge-base article match with headings and grounding). Answers \"how to use API X\" and \"how mechanism X works\".",
                    schema_of(
                        serde_json::json!({
                            "topic": {"type": "string", "description": "API member name (e.g. fireEvent, onGetCell) or mechanism keyword (e.g. teleport, celldata, lifecycle, ghost)"},
                            "domain": {"type": "string", "description": "optional API disambiguation: base|cell|client|bots|server|interfaces|core"},
                            "locale": {"type": "string", "description": "en (default) or zh-cn, API-face summary localization"}
                        }),
                        &["topic"],
                    ),
                ),
                Self::tool(
                    "get_final_config",
                    "Final server config Q&A: parses {root}/res/server/kbengine.xml (+ kbengine_defaults.xml when vendored) via the same engine as the IDE config face. Returns the merged tree with source comments, the telnet summary per component, the built-in engine default telnet ports, and the dbmgr database interface (host/port/username/database/charset; passwords are never returned).",
                    serde_json::json!({"type": "object", "properties": {}}),
                ),
                Self::tool(
                    "get_entry_scripts",
                    "Entry-script facts per server component (baseapp/cellapp/loginapp/dbmgr/interfaces/logger/bots): resolved entry module (config entryScriptFile override or engine default kbemain), expected scripts/<role>/<module>.py path and on-disk existence, plus the shared engine wrapper scripts/kbengine.py (debugpy injection point).",
                    serde_json::json!({"type": "object", "properties": {}}),
                ),
                Self::tool(
                    "get_database_schema",
                    "Database schema Q&A derived from entity defs (same source as the IDE database face): per-entity MySQL tables and columns with type labels, lengths and def source refs, plus a table-name index. entity omitted = all entities.",
                    schema_of(
                        serde_json::json!({
                            "entity": {"type": "string", "description": "optional entity def name"}
                        }),
                        &[],
                    ),
                ),
                Self::tool(
                    "why_setting",
                    "Why a server config key: its effective value (resolved from {root}/res/server/kbengine.xml merged with a vendored kbengine_defaults.xml), the curated Chinese and English meaning, and the authoritative file:line origin (e.g. kbe/res/server/kbengine_defaults.xml:618) plus the raw source comments on the resolved node. Unknown key returns found:false (value still resolved when present in the tree).",
                    schema_of(
                        serde_json::json!({
                            "key": {"type": "string", "description": "dotted config key path (root/process sections stripped), e.g. baseapp.archivePeriod"}
                        }),
                        &["key"],
                    ),
                ),
                Self::tool(
                    "list_config_settings",
                    "Every server config option with its curated Chinese and English meaning and authoritative file:line origin (the engine defaults copy library). Optional group/prefix filter; each entry carries the effective value resolved from the config (null when absent). Answers 'what does each XML config option mean'.",
                    schema_of(
                        serde_json::json!({
                            "group": {"type": "string", "description": "optional functional group filter (process/net/db/account/telnet/log/view/backup/perf/test/general/custom)"},
                            "prefix": {"type": "string", "description": "optional dotted key-prefix filter, e.g. baseapp."}
                        }),
                        &[],
                    ),
                ),
                Self::tool(
                    "search_docs",
                    "Search the project's own Markdown docs (recursively under the assets root plus any configured extra knowledge paths passed as extra CLI args) for a case-insensitive query. Returns matching files with title, headings and a snippet. Complements the built-in explain knowledge articles with the project's own requirement/design docs. Excel data is not indexed (needs a parse dependency).",
                    schema_of(
                        serde_json::json!({
                            "query": {"type": "string", "description": "case-insensitive substring to search for in the project's .md docs"},
                            "limit": {"type": "integer", "description": "max matches (default 20)"}
                        }),
                        &["query"],
                    ),
                ),
                Self::tool(
                    "search_symbols",
                    "Search Python symbols defined under the assets root's scripts/ tree (classes, module-level functions, methods). Uses the same ruff-based AST symbol extraction as the IDE analysis face. Returns name, kind (class/function/method), file, line, and the owning class for methods. Answers 'where is symbol X defined'. Call-graph and dataflow queries are not covered by this tool.",
                    schema_of(
                        serde_json::json!({
                            "query": {"type": "string", "description": "case-insensitive substring to match against symbol names"},
                            "limit": {"type": "integer", "description": "max matches (default 20)"}
                        }),
                        &["query"],
                    ),
                ),
                Self::tool(
                    "protocol_frame",
                    "Depict a wire layout: either a custom type (typeName resolved through types.xml/alias.xml, full nested layout) or one remote method's argument payload (declared argument layouts only — no message ID, framing/length or other envelope fields). Uses the same wire codec as the IDE message-table face. Offsets are relative to the immediate parent container and are null once a preceding field is variable-length. Byte samples are covered by encode_decode_sample; this tool only draws structure. When a method name exists in more than one section (BaseMethods/CellMethods/ClientMethods), pass section to disambiguate; otherwise the first matching section is used.",
                    schema_of(
                        serde_json::json!({
                            "typeName": {"type": "string", "description": "custom type name resolvable through types.xml/alias.xml (takes precedence)"},
                            "entity": {"type": "string", "description": "entity def name, with method, to draw a remote-method argument payload"},
                            "method": {"type": "string", "description": "remote method name on the entity"},
                            "section": {"type": "string", "description": "optional section filter: BaseMethods | CellMethods | ClientMethods"}
                        }),
                        &[],
                    ),
                ),
                Self::tool(
                    "find_symbol",
                    "Unified symbol lookup across the Python semantic model: entity defs, entity properties (with the resolved Python type and confidence), types.xml types (with implementedBy) and Python symbols (classes/functions/methods). Treats .def + types.xml + .py as one Python type system. Answers 'where is symbol X defined' and 'what Python type does def property X have'.",
                    schema_of(
                        serde_json::json!({
                            "query": {"type": "string", "description": "case-insensitive symbol name substring"},
                            "limit": {"type": "integer", "description": "max matches (default 20)"}
                        }),
                        &["query"],
                    ),
                ),
                Self::tool(
                    "index_status",
                    "Status of the structure-aware knowledge index: Python files scanned / symbols, schema counts (defs/types/aliases), type-resolution confidence distribution (determined/inferred/unknown), Python scan truncation and scan errors, and schema load errors. Answers 'is the index healthy and how complete'. A truncated or error-skipped scan is reported, never hidden as healthy.",
                    serde_json::json!({"type": "object", "properties": {}}),
                ),
                Self::tool(
                    "find_references",
                    "Cross-format reference edges for a symbol: which def property / types.xml type / Python class or method references it, with the production rule and confidence. Edges come from explicit rules over already-parsed data (entity-class-name, types.xml type-reference, implementedBy, def-method-name). Same-name heuristic edges are confidence unknown. Scope is honest: Python imports, calls, property-to-member associations and types.xml-to-types.xml references are NOT yet indexed, so an empty result does not prove a safe change boundary.",
                    schema_of(
                        serde_json::json!({
                            "symbol": {"type": "string", "description": "symbol name to trace references for"},
                            "limit": {"type": "integer", "description": "max edges (default 20)"}
                        }),
                        &["symbol"],
                    ),
                ),
                Self::tool(
                    "query_xml",
                    "Navigate the parsed XML knowledge structure by element path. Supports exactly three path shapes: types.<Name> for a types.xml type declaration, entity.<Name> for a def entity summary, entity.<Name>.Properties.<prop> for a single property (with the resolved Python type and confidence). It is not a general XML query and does not navigate config XML (config Q&A is why_setting/list_config_settings/get_final_config).",
                    schema_of(
                        serde_json::json!({
                            "path": {"type": "string", "description": "element path, e.g. types.SKILL_SLOT or entity.Avatar.Properties.level"}
                        }),
                        &["path"],
                    ),
                ),
                Self::tool(
                    "read_node",
                    "Read the definition of a known node precisely: Python class/function/method blocks return the exact start..end line range, entity/def-property/types.xml type/alias.xml alias return the 1-based line plus byte name span with a bounded excerpt window. Node name is matched case-insensitively but exactly (no substring; use find_symbol/search_symbols for fuzzy location). Excerpts are capped by line and byte limits and truncation is reported, never hidden.",
                    schema_of(
                        serde_json::json!({
                            "node": {"type": "string", "description": "node name, e.g. Avatar, hp, ITEM_ID, make"},
                            "limit": {"type": "integer", "description": "max excerpt lines (default 120, hard cap 400)"}
                        }),
                        &["node"],
                    ),
                ),
            ],
            ..Default::default()
        };
        std::future::ready(Ok(result))
    }

    #[allow(clippy::manual_async_fn)] // Match the other ServerHandler future-returning methods.
    fn call_tool(
        &self,
        params: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, McpError>> + Send + '_ {
        async move {
            let name = params.name.as_ref();
            if name != "search_docs" && name != "search_symbols" {
                return self.call_tool_impl(params);
            }
            let args = params.arguments.as_ref();
            let query = args
                .and_then(|a| a.get("query"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let limit = args
                .and_then(|a| a.get("limit"))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(20) as usize;
            let root = self.assets_root.clone();
            let extra = self.extra_paths.clone();
            let docs = name == "search_docs";
            let result = tokio::task::spawn_blocking(move || {
                if docs {
                    crate::docs_index::search_docs(&root, &extra, &query, limit.max(1))
                } else {
                    crate::code_index::search_symbols(&root, &query, limit.max(1))
                }
            })
            .await
            .map_err(|error| {
                McpError::internal_error(format!("search task failed: {error}"), None)
            })?;
            match result {
                Ok(value) => Self::text_result(value),
                Err(message) => Self::error_result(message),
            }
        }
    }
}

/// stdio 入口:加载资产根(可选额外知识路径)并服务到进程退出。
pub async fn run_stdio(
    root: std::path::PathBuf,
    extra_paths: Vec<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let server = KodeMcpServer {
        knowledge: AssetKnowledge::load(&root),
        assets_root: root,
        extra_paths,
    };
    let running = server.serve(stdio()).await?;
    running.waiting().await?;
    Ok(())
}
