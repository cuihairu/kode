//! textDocument/definition 与 textDocument/diagnostic LSP 级门禁:能力协商、
//! 文档同步联动、null/空面边界、非法参数。

use serde_json::json;

use kode_protocol::{error_codes, IncomingMessage, Notification, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

fn request(id: i64, method: &str, params: serde_json::Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn notification(method: &str, params: serde_json::Value) -> IncomingMessage {
    IncomingMessage::Notification(Notification {
        jsonrpc: "2.0".into(),
        method: method.into(),
        params: Some(params),
    })
}

fn initialize_message(id: i64) -> IncomingMessage {
    request(
        id,
        "initialize",
        json!({
            "processId": 1234,
            "rootUri": "file:///workspace/demo",
            "capabilities": {}
        }),
    )
}

fn response_of(out: &[Outgoing]) -> &serde_json::Value {
    match &out[0] {
        Outgoing::Response(response) => response.result.as_ref().unwrap(),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

fn error_code_of(out: &[Outgoing]) -> i64 {
    match &out[0] {
        Outgoing::Response(response) => response.error.as_ref().unwrap().code,
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

const AVATAR_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

fn open_avatar(state: &mut ServerState) {
    let out = handle_message(
        state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                    "languageId": "kbengine-def",
                    "version": 1,
                    "text": AVATAR_DEF
                }
            }),
        ),
    );
    assert!(out.is_empty());
}

#[test]
fn initialize_advertises_definition_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    assert_eq!(
        response_of(&out)["capabilities"]["definitionProvider"],
        json!(true)
    );
}

#[test]
fn definition_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            7,
            "textDocument/definition",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" },
                "position": { "line": 2, "character": 3 }
            }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

#[test]
fn definition_on_open_document_returns_location() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    let out = handle_message(
        &mut state,
        request(
            8,
            "textDocument/definition",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" },
                "position": { "line": 2, "character": 3 }
            }),
        ),
    );
    let result = response_of(&out);
    assert_eq!(
        result["uri"],
        json!("/workspace/demo/scripts/entity_defs/Avatar.def")
    );
    assert_eq!(result["range"]["start"]["line"], json!(2));
}

#[test]
fn definition_on_unopened_document_returns_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            9,
            "textDocument/definition",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Missing.def" },
                "position": { "line": 0, "character": 0 }
            }),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn definition_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(10, "textDocument/definition", json!({ "position": {} })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn diagnostic_returns_full_report_with_items() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    // 干净文档 → items 空;注入未知类型 → 一条 Error。
    let out = handle_message(
        &mut state,
        request(
            11,
            "textDocument/diagnostic",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" }
            }),
        ),
    );
    let result = response_of(&out);
    assert_eq!(result["kind"], json!("full"));
    assert_eq!(result["items"], json!([]));

    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def", "version": 2 },
                "contentChanges": [
                    { "text": "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> GHOST </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n" }
                ]
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            12,
            "textDocument/diagnostic",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" }
            }),
        ),
    );
    let result = response_of(&out);
    assert_eq!(result["kind"], json!("full"));
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "didChange 后诊断应更新: {result}");
    assert_eq!(items[0]["severity"], json!(1));
    assert!(
        items[0]["message"].as_str().unwrap().contains("GHOST"),
        "诊断文案应含未知类型名: {items:?}"
    );
}

#[test]
fn diagnostic_on_unopened_document_returns_empty_items() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            13,
            "textDocument/diagnostic",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Missing.def" }
            }),
        ),
    );
    let result = response_of(&out);
    assert_eq!(result["kind"], json!("full"));
    assert_eq!(result["items"], json!([]));
}

#[test]
fn diagnostic_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(14, "textDocument/diagnostic", json!({ "textDocument": 42 })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn did_close_clears_diagnostic_items() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" } }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            15,
            "textDocument/diagnostic",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" }
            }),
        ),
    );
    assert_eq!(response_of(&out)["items"], json!([]));
}
