//! rmcp 客户端 stdio 端到端(MCP-001 验收):list_tools → call_tool 全工具
//! 真数据返回。spawn 本 crate bin(kode-mcp <assets-root>),走完整 MCP
//! 握手 + JSON-RPC 往返;夹具 = kbengine-demo-assets。

use std::path::PathBuf;

use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    service::{serve_client, RoleClient, RunningService},
    transport::{ConfigureCommandExt, TokioChildProcess},
};
use serde_json::Value;
use tokio::process::Command;

fn fixture_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p.push("tests/fixtures/kbengine-demo-assets");
    p
}

async fn connect() -> RunningService<RoleClient, ()> {
    let process = TokioChildProcess::new(Command::new(env!("CARGO_BIN_EXE_kode-mcp")).configure(
        |cmd| {
            cmd.arg(fixture_root());
        },
    ))
    .expect("spawn kode-mcp");
    serve_client((), process).await.expect("mcp handshake")
}

fn call_params(name: &str, arguments: Value) -> CallToolRequestParams {
    let arguments = arguments.as_object().cloned().unwrap_or_default();
    CallToolRequestParams::new(name.to_string()).with_arguments(arguments)
}

fn payload_of(result: CallToolResult) -> Value {
    assert!(
        result.is_error != Some(true),
        "tool call failed: {result:?}"
    );
    let text = result
        .content
        .first()
        .map(|block| match block {
            rmcp::model::ContentBlock::Text(text) => text.text.clone(),
            other => panic!("expected text content, got {other:?}"),
        })
        .expect("tool result content");
    serde_json::from_str(&text).expect("tool payload is JSON")
}

#[tokio::test]
async fn list_tools_exposes_all_eighteen() {
    let client = connect().await;
    let tools = client.list_all_tools().await.expect("list_tools");
    let mut names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "db_schema_preview",
            "encode_decode_sample",
            "explain",
            "find_symbol",
            "get_database_schema",
            "get_entity_model",
            "get_entry_scripts",
            "get_final_config",
            "get_message_entry",
            "get_type_graph",
            "index_status",
            "list_config_settings",
            "protocol_frame",
            "search_docs",
            "search_entities",
            "search_symbols",
            "validate_defs",
            "why_setting",
        ]
    );
    let _ = client.cancel().await;
}

#[tokio::test]
async fn call_tools_return_real_data() {
    let client = connect().await;

    // search_entities:按名子串真数据。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "search_entities",
                serde_json::json!({"query": "Avatar"}),
            ))
            .await
            .expect("call search_entities"),
    );
    assert!(payload["matches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["name"] == "Avatar"));

    // get_entity_model:真实体全模型。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "get_entity_model",
                serde_json::json!({"entity": "Account"}),
            ))
            .await
            .expect("call get_entity_model"),
    );
    assert_eq!(payload["name"], "Account");
    assert!(!payload["properties"].as_array().unwrap().is_empty());

    // get_type_graph:types.xml 节点真数据。
    let payload = payload_of(
        client
            .call_tool(call_params("get_type_graph", serde_json::json!({})))
            .await
            .expect("call get_type_graph"),
    );
    assert!(payload["types"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "SKILL_SLOT"));

    // validate_defs:净夹具零发现。
    let payload = payload_of(
        client
            .call_tool(call_params("validate_defs", serde_json::json!({})))
            .await
            .expect("call validate_defs"),
    );
    assert!(payload["findings"].as_array().unwrap().is_empty());

    // get_message_entry:C-15 同源真数据。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "get_message_entry",
                serde_json::json!({"entity": "Account", "method": "reqCreateAvatar"}),
            ))
            .await
            .expect("call get_message_entry"),
    );
    assert_eq!(payload["entries"].as_array().unwrap().len(), 1);

    // encode_decode_sample:别名类型 hex 样本。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "encode_decode_sample",
                serde_json::json!({"typeName": "ITEM_ID", "value": 7}),
            ))
            .await
            .expect("call encode_decode_sample"),
    );
    assert_eq!(payload["hex"], "0700");

    // db_schema_preview:C-16 同源真数据。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "db_schema_preview",
                serde_json::json!({"entity": "Account"}),
            ))
            .await
            .expect("call db_schema_preview"),
    );
    assert!(payload["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "Account"));

    // explain(KB-001):API 面 + 机制面双命中真数据(cellData 既是库成员,
    // 又命中迁移文关键词)。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "explain",
                serde_json::json!({"topic": "cellData"}),
            ))
            .await
            .expect("call explain"),
    );
    assert_eq!(payload["api"]["member"], "cellData");
    assert_eq!(
        payload["knowledge"][0]["file"],
        "docs/knowledge/entity-migration-and-cross-process-references.md"
    );

    // get_final_config(CFG-008):telnet 端口问答真数据(引擎写死表)。
    let payload = payload_of(
        client
            .call_tool(call_params("get_final_config", serde_json::json!({})))
            .await
            .expect("call get_final_config"),
    );
    assert!(
        payload["customTree"].is_object(),
        "fixture kbengine.xml parsed"
    );
    assert_eq!(payload["telnetDefaultPorts"]["loginapp"], 31000);
    assert_eq!(payload["telnetDefaultPorts"]["dbmgr"], 32000);
    assert!(payload["telnetSummary"].is_array());
    assert!(
        payload["dbInterface"].is_null() || payload["dbInterface"]["password"].is_null(),
        "passwords never leave the process"
    );

    // get_entry_scripts(CFG-008):entryScriptFile 问答真数据。
    let payload = payload_of(
        client
            .call_tool(call_params("get_entry_scripts", serde_json::json!({})))
            .await
            .expect("call get_entry_scripts"),
    );
    let facts = payload["entryScripts"].as_array().unwrap();
    let baseapp = facts
        .iter()
        .find(|f| f["process"] == "baseapp" && f["module"] == "kbemain")
        .expect("baseapp fact");
    assert_eq!(baseapp["exists"], true);
    assert!(baseapp["path"]
        .as_str()
        .unwrap()
        .ends_with("scripts/base/kbemain.py"));
    assert!(facts
        .iter()
        .any(|f| f["module"] == "kbengine" && f["exists"] == false));

    // get_database_schema(CFG-008):schema 问答真数据(单实体 + 索引)。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "get_database_schema",
                serde_json::json!({"entity": "Account"}),
            ))
            .await
            .expect("call get_database_schema"),
    );
    assert_eq!(payload["entity"], "Account");
    assert!(payload["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "Account"));
    assert!(payload["tableIndex"]["Account"].is_object());

    // why_setting(KODE-CFG-018):配置键问答真数据(值 + 中英含义 + file:line)。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "why_setting",
                serde_json::json!({"key": "dbmgr.account_system.account_registration.enable"}),
            ))
            .await
            .expect("call why_setting"),
    );
    assert_eq!(payload["found"], true);
    assert!(payload["meaningZh"].as_str().unwrap().contains("开放注册"));
    assert!(payload["origin"]
        .as_str()
        .unwrap()
        .contains("kbengine_defaults.xml"));

    // list_config_settings(KODE-MCP-KB-001 ⑤):全量配置项含义真数据。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "list_config_settings",
                serde_json::json!({"prefix": "baseapp."}),
            ))
            .await
            .expect("call list_config_settings"),
    );
    assert!(payload["count"].as_u64().unwrap() > 20);
    let settings = payload["settings"].as_array().unwrap();
    assert!(settings.iter().all(|s| s["key"]
        .as_str()
        .unwrap()
        .starts_with("baseapp.")));
    assert!(settings.iter().any(|s| s["key"] == "baseapp.archivePeriod"));

    // search_docs(KODE-MCP-KB-001 ⑥):项目自身 .md 检索真数据(夹具 README)。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "search_docs",
                serde_json::json!({"query": "TrainingAvatar"}),
            ))
            .await
            .expect("call search_docs"),
    );
    assert!(payload["count"].as_u64().unwrap() >= 1);
    let m = &payload["matches"][0];
    assert!(m["file"].as_str().unwrap().ends_with("README.md"));
    assert!(m["title"].as_str().unwrap().contains("KBEngine"));
    assert!(m["snippet"].as_str().unwrap().contains("TrainingAvatar"));

    // search_symbols(KODE-MCP-KB-001 ⑦):scripts/ 下 Python 符号真数据。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "search_symbols",
                serde_json::json!({"query": "Avatar"}),
            ))
            .await
            .expect("call search_symbols"),
    );
    assert!(payload["count"].as_u64().unwrap() >= 1);
    let sym = payload["matches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "class")
        .expect("class symbol");
    assert!(sym["name"].as_str().unwrap().contains("Avatar"));
    assert!(sym["file"].as_str().unwrap().contains("scripts/"));

    // protocol_frame(KODE-MCP-KB-001 ③):协议帧结构真数据(自定义类型 + 方法帧)。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "protocol_frame",
                serde_json::json!({"typeName": "SKILL_SLOT"}),
            ))
            .await
            .expect("call protocol_frame"),
    );
    assert_eq!(payload["type"], "SKILL_SLOT");
    assert_eq!(payload["layout"]["kind"], "FIXED_DICT");
    assert!(payload["layout"]["fields"].as_array().unwrap().len() >= 1);

    let payload = payload_of(
        client
            .call_tool(call_params(
                "protocol_frame",
                serde_json::json!({"entity": "Account", "method": "reqCreateAvatar"}),
            ))
            .await
            .expect("call protocol_frame"),
    );
    assert_eq!(payload["frame"], "Account.reqCreateAvatar");
    assert_eq!(payload["argCount"], 1);

    // find_symbol(KODE-MCP-KB-002 P1):语义模型统一符号查找真数据(属性带 pyType)。
    let payload = payload_of(
        client
            .call_tool(call_params(
                "find_symbol",
                serde_json::json!({"query": "level"}),
            ))
            .await
            .expect("call find_symbol"),
    );
    let prop = payload["matches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "entity-property")
        .expect("entity property");
    assert_eq!(prop["entity"], "Avatar");
    assert_eq!(prop["pyType"], "int");
    assert_eq!(prop["confidence"], "determined");

    // index_status(KODE-MCP-KB-002 P1):索引状态真数据(置信度分布)。
    let payload = payload_of(
        client
            .call_tool(call_params("index_status", serde_json::json!({})))
            .await
            .expect("call index_status"),
    );
    assert!(payload["schema"]["defs"].as_u64().unwrap() >= 1);
    assert!(payload["resolution"]["resolvedTypes"].as_u64().unwrap() >= 1);

    let _ = client.cancel().await;
}

#[tokio::test]
async fn tool_level_errors_come_back_as_is_error_results() {
    let client = connect().await;
    let response = client
        .call_tool(call_params(
            "get_entity_model",
            serde_json::json!({"entity": "NoSuch"}),
        ))
        .await
        .expect("call get_entity_model");
    assert_eq!(response.is_error, Some(true));
    let _ = client.cancel().await;
}
