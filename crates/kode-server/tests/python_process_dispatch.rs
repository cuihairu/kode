use kode_protocol::{IncomingMessage, Notification, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};
use serde_json::{json, Value};

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn result(outgoing: &[Outgoing]) -> Value {
    match &outgoing[0] {
        Outgoing::Response(response) => response.result.clone().expect("successful response"),
        _ => panic!("expected response"),
    }
}

#[test]
fn python_completion_and_hover_use_the_documents_process() {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(
            1,
            "initialize",
            json!({ "rootUri": "file:///workspace/project", "capabilities": {} }),
        ),
    );
    for role in ["base", "cell", "bots"] {
        let uri = format!("file:///workspace/project/scripts/{role}/probe.py");
        let source = "import KBEngine\nKBEngine.createEntity\n";
        handle_message(
            &mut state,
            IncomingMessage::Notification(Notification {
                jsonrpc: "2.0".into(),
                method: "textDocument/didOpen".into(),
                params: Some(json!({
                    "textDocument": { "uri": uri, "languageId": "python", "version": 1, "text": source }
                })),
            }),
        );
        let completion = result(&handle_message(
            &mut state,
            request(
                2,
                "textDocument/completion",
                json!({
                    "textDocument": {"uri": uri}, "position": {"line": 1, "character": 9}
                }),
            ),
        ));
        let items = completion["items"]
            .as_array()
            .expect("Python module completions");
        let creation = items.iter().find(|item| item["label"] == "createEntity");
        assert_eq!(creation.is_some(), role != "bots");
        if let Some(creation) = creation {
            assert_eq!(
                creation["detail"].as_str().unwrap().contains("spaceID"),
                role == "cell"
            );
            assert_eq!(creation["kind"], 3);
        }
        let hover = result(&handle_message(
            &mut state,
            request(
                3,
                "textDocument/hover",
                json!({
                    "textDocument": {"uri": uri}, "position": {"line": 1, "character": 13}
                }),
            ),
        ));
        if role == "bots" {
            assert!(hover.is_null());
        } else {
            let markdown = hover["contents"]["value"]
                .as_str()
                .expect("module API hover");
            assert_eq!(markdown.contains("spaceID"), role == "cell");
        }
    }
}
