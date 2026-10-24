//! kode-server 分派状态机单测:initialize 协商、request_id 贯穿、
//! 文档同步、取消、健康报告、shutdown/exit 生命周期。

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
            "capabilities": {},
            "initializationOptions": { "restartGeneration": 2 }
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

#[test]
fn initialize_negotiates_capabilities_and_server_info() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    let result = response_of(&out);
    assert_eq!(
        result["capabilities"]["textDocumentSync"]["openClose"],
        json!(true)
    );
    assert_eq!(
        result["capabilities"]["textDocumentSync"]["change"],
        json!(1)
    );
    assert_eq!(result["serverInfo"]["name"], json!("kode-server"));
    assert!(result["serverInfo"]["version"].is_string());
    assert!(state.initialized);
}

#[test]
fn initialize_echoes_client_restart_generation() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(&mut state, request(2, "$/kode/health", json!({})));
    assert_eq!(response_of(&out)["restartGeneration"], json!(2));
}

#[test]
fn reinitialize_is_idempotent() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(&mut state, initialize_message(2));
    assert!(matches!(&out[0], Outgoing::Response(response) if response.result.is_some()));
    assert!(state.initialized);
}

#[test]
fn request_before_initialize_is_rejected_with_lsp_code() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, request(1, "$/kode/health", json!({})));
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
    assert!(!state.initialized);
}

#[test]
fn request_id_is_echoed_verbatim_through_response() {
    let mut state = ServerState::new();
    let message = IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::String("ext-42".into()),
        method: "initialize".into(),
        params: Some(json!({})),
    });
    let out = handle_message(&mut state, message);
    match &out[0] {
        Outgoing::Response(response) => {
            assert_eq!(response.id, Some(RequestId::String("ext-42".into())));
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

#[test]
fn did_open_change_close_transitions_track_documents() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entities/Monster.def";

    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "kbengine-def", "version": 1, "text": "<Entity>"}}),
        ),
    );
    let out = handle_message(&mut state, request(2, "$/kode/health", json!({})));
    let docs = &response_of(&out)["documents"];
    assert_eq!(docs.as_array().unwrap().len(), 1);
    assert_eq!(docs[0]["uri"], json!(uri));
    assert_eq!(docs[0]["version"], json!(1));

    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({"textDocument": {"uri": uri, "version": 7},
                   "contentChanges": [{"text": "<Entity><GroupName>mob</GroupName></Entity>"}]}),
        ),
    );
    let out = handle_message(&mut state, request(3, "$/kode/health", json!({})));
    let docs = &response_of(&out)["documents"];
    assert_eq!(docs[0]["version"], json!(7));

    handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({"textDocument": {"uri": uri}}),
        ),
    );
    let out = handle_message(&mut state, request(4, "$/kode/health", json!({})));
    assert!(response_of(&out)["documents"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn did_change_on_unknown_uri_is_ignored() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({"textDocument": {"uri": "file:///missing.def", "version": 2},
                   "contentChanges": [{"text": "x"}]}),
        ),
    );
    let out = handle_message(&mut state, request(1, "$/kode/health", json!({})));
    assert!(response_of(&out)["documents"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn health_report_contains_probe_fields() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(&mut state, request(9, "$/kode/health", json!({})));
    let report = response_of(&out);
    assert_eq!(report["status"], json!("ok"));
    assert!(report["pid"].as_u64().unwrap() > 0);
    assert!(report["uptimeMs"].as_u64().is_some());
    assert_eq!(report["initialized"], json!(true));
    assert_eq!(report["shutdownRequested"], json!(false));
}

#[test]
fn shutdown_then_exit_is_clean_lifecycle() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(&mut state, request(2, "shutdown", json!(null)));
    assert!(response_of(&out).is_null());
    assert!(state.shutdown_requested);
    assert!(!state.exit_requested);
    handle_message(&mut state, notification("exit", serde_json::Value::Null));
    assert!(state.exit_requested);
}

#[test]
fn cancellation_before_request_yields_request_cancelled_error() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    // 取消通知先到(LSP 允许),请求后到 → 立即 -32800,不等待。
    handle_message(
        &mut state,
        notification("$/cancelRequest", json!({"id": 77})),
    );
    let out = handle_message(&mut state, request(77, "$/kode/wait", json!({"ms": 5000})));
    assert_eq!(error_code_of(&out), error_codes::REQUEST_CANCELLED);
}

#[test]
fn wait_request_completes_with_waited_ms() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(&mut state, request(5, "$/kode/wait", json!({"ms": 10})));
    let result = response_of(&out);
    assert!(result["waitedMs"].as_u64().unwrap() >= 10);
}

#[test]
fn unknown_request_method_is_method_not_found() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(6, "workspace/executeCommand", json!({})),
    );
    assert_eq!(error_code_of(&out), error_codes::METHOD_NOT_FOUND);
}

#[test]
fn unknown_notifications_are_dropped_silently() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(&mut state, notification("$/kode/unknown", json!({})));
    assert!(out.is_empty());
}

#[test]
fn notifications_before_initialize_are_dropped() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": "file:///a.def", "languageId": "x", "version": 1, "text": ""}}),
        ),
    );
    assert!(out.is_empty());
    assert_eq!(state.store.open_count(), 0);
}

// ---------------------------------------------------------------------------
// PR-004(VFS):kode-server 文档同步对接 kode-vfs 后的新语义
// ---------------------------------------------------------------------------

/// VFS-003:version 未递增的 didChange 被拒——文本与版本都不回退。
#[test]
fn stale_did_change_is_rejected_and_text_preserved() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///w/Monster.def";
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "kbengine-def", "version": 3, "text": "v3"}}),
        ),
    );
    // 旧 version(2 < 3)的重放必须被忽略。
    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({"textDocument": {"uri": uri, "version": 2},
                   "contentChanges": [{"text": "stale"}]}),
        ),
    );
    let out = handle_message(&mut state, request(2, "$/kode/health", json!({})));
    let docs = response_of(&out)["documents"].as_array().unwrap();
    assert_eq!(docs[0]["version"], json!(3));
    let (version, buffer) = state
        .store
        .open_buffer(&kode_vfs::DocumentKey::new(
            kode_vfs::RootId::UNROOTED,
            kode_vfs::CanonicalUri::parse(uri).unwrap(),
        ))
        .unwrap();
    assert_eq!(version, 3);
    assert_eq!(buffer.text(), "v3");
}

/// VFS-004:增量(ranged)didChange 穿过 server 后按精确坐标生效(emoji 样例)。
#[test]
fn ranged_did_change_applies_utf16_precise_edit() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///w/emoji.def";
    // 行 1 内容 "ab🎯c";把 "🎯"(character 2..4,UTF-16 代理对)换成 "🔥"。
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "kbengine-def", "version": 1,
                   "text": "标题\r\nab🎯c"}}),
        ),
    );
    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({"textDocument": {"uri": uri, "version": 2},
                   "contentChanges": [{
                       "range": {"start": {"line": 1, "character": 2},
                                 "end": {"line": 1, "character": 4}},
                       "text": "🔥"}]}),
        ),
    );
    let key = kode_vfs::DocumentKey::new(
        kode_vfs::RootId::UNROOTED,
        kode_vfs::CanonicalUri::parse(uri).unwrap(),
    );
    let (_, buffer) = state.store.open_buffer(&key).unwrap();
    assert_eq!(buffer.text(), "标题\r\nab🔥c");
}

/// VFS-002/009:initialize.rootUri 注册资源根;文档按最长前缀归属该根。
#[test]
fn initialize_root_uri_registers_root_and_documents_attach_to_it() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let root_id = state
        .roots
        .root_for(&kode_vfs::CanonicalUri::from_path("/workspace/demo"));
    assert_ne!(root_id, kode_vfs::RootId::UNROOTED);
    let uri = "file:///workspace/demo/entities/Monster.def";
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "kbengine-def", "version": 1, "text": "<Entity/>"}}),
        ),
    );
    let key = kode_vfs::DocumentKey::new(root_id, kode_vfs::CanonicalUri::parse(uri).unwrap());
    assert!(state.store.is_open(&key));
    // 根外的文档落到 UNROOTED,不与根内同名文件混淆身份。
    let outside = "file:///elsewhere/Monster.def";
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": outside, "languageId": "kbengine-def", "version": 1, "text": "x"}}),
        ),
    );
    assert!(state.store.is_open(&kode_vfs::DocumentKey::new(
        kode_vfs::RootId::UNROOTED,
        kode_vfs::CanonicalUri::parse(outside).unwrap()
    )));
}

/// VFS-003:didOpen 旧 version 重放被忽略(防御性;较新 buffer 不被覆盖)。
#[test]
fn stale_did_open_is_ignored() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = json!({"textDocument": {"uri": "file:///w/a.def", "languageId": "x", "version": 5, "text": "newest"}});
    handle_message(
        &mut state,
        notification("textDocument/didOpen", uri.clone()),
    );
    let stale = json!({"textDocument": {"uri": "file:///w/a.def", "languageId": "x", "version": 4, "text": "old"}});
    handle_message(&mut state, notification("textDocument/didOpen", stale));
    let key = kode_vfs::DocumentKey::new(
        kode_vfs::RootId::UNROOTED,
        kode_vfs::CanonicalUri::parse("file:///w/a.def").unwrap(),
    );
    let (version, buffer) = state.store.open_buffer(&key).unwrap();
    assert_eq!(version, 5);
    assert_eq!(buffer.text(), "newest");
}
