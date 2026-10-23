//! textDocument/hover LSP 级门禁:能力协商、未初始化拒绝、文档同步联动
//! (didOpen/didChange/didClose)、null 结果与非法参数。

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
\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n\
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

/// hp 词的 0 起 UTF-16 行列(`\t\t<hp>` 即第 3 行 3 列)。
fn hp_position() -> serde_json::Value {
    json!({ "line": 2, "character": 3 })
}

#[test]
fn initialize_advertises_hover_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    let result = response_of(&out);
    assert_eq!(result["capabilities"]["hoverProvider"], json!(true));
}

#[test]
fn hover_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            7,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" },
                "position": hp_position()
            }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

#[test]
fn hover_on_open_document_returns_markdown_contents() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    let out = handle_message(
        &mut state,
        request(
            9,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" },
                "position": hp_position()
            }),
        ),
    );
    let result = response_of(&out);
    assert_eq!(result["contents"]["kind"], json!("markdown"));
    let value = result["contents"]["value"].as_str().expect("markdown");
    assert!(value.contains("**hp**"));
    assert!(value.contains("`UINT32`"));
    assert!(value.contains("`BASE_AND_CLIENT`"));
}

#[test]
fn hover_on_unknown_word_returns_null_result() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    let out = handle_message(
        &mut state,
        request(
            10,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" },
                "position": { "line": 3, "character": 0 }
            }),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn hover_on_unopened_document_returns_null_result() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            11,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Missing.def" },
                "position": hp_position()
            }),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn hover_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(12, "textDocument/hover", json!({ "position": {} })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn did_change_updates_hover_text() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def", "version": 2 },
                "contentChanges": [
                    { "text": "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT64 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n" }
                ]
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            13,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" },
                "position": { "line": 2, "character": 3 }
            }),
        ),
    );
    let value = response_of(&out)["contents"]["value"]
        .as_str()
        .expect("markdown");
    assert!(
        value.contains("`UINT64`"),
        "didChange 后 hover 未更新: {value}"
    );
}

#[test]
fn did_close_drops_hover_and_corpus_view() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": "file:///workspace/demo/scripts/entities.xml",
                    "languageId": "xml",
                    "version": 1,
                    "text": "<root>\n\t<Avatar/>\n</root>\n"
                }
            }),
        ),
    );
    handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" } }),
        ),
    );
    // 文档已关 → null。
    let out = handle_message(
        &mut state,
        request(
            14,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" },
                "position": hp_position()
            }),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
    // VFS-012:语料视图连带清理——entities.xml 注册项的 def 存在性失效。
    let out = handle_message(
        &mut state,
        request(
            15,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entities.xml" },
                "position": { "line": 1, "character": 2 }
            }),
        ),
    );
    let value = response_of(&out)["contents"]["value"]
        .as_str()
        .expect("markdown");
    // 关闭后语料视图清理:def 存在性失效,回退到约定名(TS 同口径 `<name>.def`)。
    assert!(
        value.contains("**Definition**: `Avatar.def`"),
        "didClose 后 def 存在性未清理: {value}"
    );
}
