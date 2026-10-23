//! textDocument/completion LSP 级门禁:能力协商、未初始化拒绝、文档同步联动
//! (didOpen/didChange/didClose)、取消、null 结果与非法参数。

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

fn completion_params(uri: &str, line: u32, character: u32) -> serde_json::Value {
    json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character }
    })
}

#[test]
fn initialize_advertises_completion_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    let result = response_of(&out);
    assert_eq!(
        result["capabilities"]["completionProvider"]["triggerCharacters"],
        json!(["<"])
    );
    assert_eq!(result["capabilities"]["hoverProvider"], json!(true));
}

#[test]
fn completion_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            7,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

#[test]
fn completion_on_open_document_returns_items() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    // 行 3(1 起,`\t\t<hp>`)col 2 = `<` 后:Properties 开标签全量点。
    let out = handle_message(
        &mut state,
        request(
            9,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                2,
                3,
            ),
        ),
    );
    let result = response_of(&out);
    assert_eq!(result["isIncomplete"], json!(false));
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["label"], json!("hp"));
    assert_eq!(items[0]["kind"], json!(10));
    assert_eq!(items[0]["detail"], json!("UINT32"));
}

#[test]
fn completion_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(12, "textDocument/completion", json!({ "position": {} })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn completion_on_unopened_document_returns_null_result() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            11,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Missing.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn completion_without_detectable_context_returns_null_result() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    // 行 1(顶层)col 2:开标签但栈顶为 root,不接管 → null。
    let out = handle_message(
        &mut state,
        request(
            13,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                0,
                2,
            ),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn cancelled_completion_yields_request_cancelled_error() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    // 取消通知先于请求到达(LSP 允许):请求到达即回 -32800。
    handle_message(
        &mut state,
        notification("$/cancelRequest", json!({ "id": 21 })),
    );
    let out = handle_message(
        &mut state,
        request(
            21,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::REQUEST_CANCELLED);
}

#[test]
fn did_change_updates_completion_items() {
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
                    { "text": "<root>\n\t<Properties>\n\t\t<mana>\n\t\t\t<Type> UINT32 </Type>\n\t\t</mana>\n\t</Properties>\n</root>\n" }
                ]
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            22,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                2,
                3,
            ),
        ),
    );
    let items = response_of(&out)["items"].as_array().expect("items");
    assert_eq!(
        items[0]["label"],
        json!("mana"),
        "didChange 后补全未跟随 overlay"
    );
}

#[test]
fn did_close_drops_completion() {
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
            23,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}
