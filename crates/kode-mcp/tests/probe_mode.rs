//! --probe 探活模式端到端(2026-11-24 MCP 活性灯批):真二进制 + rmcp 客户
//! 端完整握手,钉三个行为面——①握手面可用(initialize/tools/list);
//! ②跳过语料装载(夹具里明明有 Avatar,探活模式 search_entities 必须空);
//! ③空库上工具调用不 panic(如实空结果)。探针预算吃不起整库解析,这三条
//! 是 TS 探针毫秒级判活的合同。

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

async fn connect_probe() -> RunningService<RoleClient, ()> {
    let process = TokioChildProcess::new(Command::new(env!("CARGO_BIN_EXE_kode-mcp")).configure(
        |cmd| {
            cmd.arg("--probe").arg(fixture_root());
        },
    ))
    .expect("spawn kode-mcp --probe");
    serve_client((), process).await.expect("mcp handshake")
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
async fn probe_mode_answers_handshake_with_tools_listed() {
    let client = connect_probe().await;
    let tools = client.list_all_tools().await.expect("list_tools");
    assert!(
        tools.iter().any(|t| t.name == "search_entities"),
        "probe mode must still advertise the tool surface, got {} tools",
        tools.len()
    );
    let _ = client.cancel().await;
}

#[tokio::test]
async fn probe_mode_skips_corpus_and_serves_empty_library_without_panic() {
    let client = connect_probe().await;
    // 夹具含 Avatar(全量模式 e2e 断言能搜到);探活模式空库必须空结果——
    // 空 = 证明没走 AssetKnowledge::load,且空库读路径不 panic。
    let payload = payload_of(
        client
            .call_tool(
                CallToolRequestParams::new("search_entities".to_string()).with_arguments(
                    [("query".to_string(), Value::String("Avatar".to_string()))]
                        .into_iter()
                        .collect(),
                ),
            )
            .await
            .expect("call search_entities"),
    );
    assert_eq!(
        payload["matches"].as_array().map(Vec::len),
        Some(0),
        "probe mode must not load the corpus: {payload}"
    );
    let _ = client.cancel().await;
}
