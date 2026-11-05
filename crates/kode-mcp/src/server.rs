//! kode-mcp MCP server(rmcp stdio)。装配 AssetKnowledge + 七个工具;
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
                 encode_decode_sample, db_schema_preview.",
            )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + Send + '_ {
        let mut result = ListToolsResult::default();
        result.tools = vec![
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
            ];
        std::future::ready(Ok(result))
    }

    fn call_tool(
        &self,
        params: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, McpError>> + Send + '_ {
        std::future::ready(self.call_tool_impl(params))
    }
}

/// stdio 入口:加载资产根并服务到进程退出。
pub async fn run_stdio(root: std::path::PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let server = KodeMcpServer {
        knowledge: AssetKnowledge::load(&root),
    };
    let running = server.serve(stdio()).await?;
    running.waiting().await?;
    Ok(())
}
