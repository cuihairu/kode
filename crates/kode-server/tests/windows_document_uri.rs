//! A Windows fsPath must survive document ingress and a real LSP query on every host.
use kode_protocol::{IncomingMessage, Notification, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};
use serde_json::json;

#[test]
fn windows_document_path_is_opened_and_served() {
    let mut state = ServerState::new();
    let request = |id, method: &str, params| {
        IncomingMessage::Request(Request {
            jsonrpc: "2.0".into(),
            id: RequestId::Number(id),
            method: method.into(),
            params: Some(params),
        })
    };
    handle_message(
        &mut state,
        request(1, "initialize", json!({"capabilities": {}})),
    );
    let uri = r"D:\project\scripts\entity_defs\Avatar.def";
    let text =
        include_str!("../../../tests/fixtures/kbengine-demo-assets/scripts/entity_defs/Avatar.def");
    handle_message(
        &mut state,
        IncomingMessage::Notification(Notification {
            jsonrpc: "2.0".into(),
            method: "textDocument/didOpen".into(),
            params: Some(
                json!({"textDocument": {"uri":uri, "languageId":"kbengine-def", "version":1, "text":text}}),
            ),
        }),
    );
    let output = handle_message(
        &mut state,
        request(
            2,
            "textDocument/definition",
            json!({
                "textDocument":{"uri":uri}, "position":{"line":35, "character":18}
            }),
        ),
    );
    let Outgoing::Response(response) = &output[0] else {
        panic!("expected definition response")
    };
    assert!(response.error.is_none());
    let location = response.result.as_ref().unwrap();
    assert_eq!(
        location["uri"],
        "/D:/project/scripts/entity_defs/Avatar.def"
    );
    assert_eq!(location["range"]["start"]["line"], 60);
}
