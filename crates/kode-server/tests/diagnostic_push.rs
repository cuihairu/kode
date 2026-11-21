//! RUST-142 生产接线批:didOpen/didChange/didClose → 层核 →
//! `$/kode/publishDiagnostics` 通知的端到端面。层核本体(golden)与决策表
//! (批 2)已由 golden 套件覆盖,本文件只锁生产接线:脏文档经
//! flush_diagnostics_pipeline 计算/路由/发射。

use std::time::{Duration, Instant};

use serde_json::json;

use kode_protocol::{IncomingMessage, Notification, Request, RequestId};
use kode_server::{handle_message, server::flush_diagnostics_pipeline, Outgoing, ServerState};

/// 主循环空闲 tick 口径的 flush(墙钟界取宽值:单测文档微小,预算只锁
/// 「界外余量回脏集」的切片语义,不锁具体宽度)。
fn flush(state: &mut ServerState) -> Vec<Outgoing> {
    let deadline = Instant::now() + Duration::from_secs(1);
    flush_diagnostics_pipeline(state, deadline)
}

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
            "initializationOptions": { "restartGeneration": 1 }
        }),
    )
}

/// 最小触发 def:属性缺 `<Flags>` → missing-flags(lint_rules.rs 同款)。
const MISSING_FLAGS_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>UINT32</Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

/// 干净 def(带 Flags)→ 零 lint 产出。
const CLEAN_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>UINT32</Type>\n\
\t\t\t<Flags>BASE</Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

fn did_open(state: &mut ServerState, uri: &str, version: i64, text: &str) {
    handle_message(
        state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "kbengine-def",
                                    "version": version, "text": text}}),
        ),
    );
}

fn did_change(state: &mut ServerState, uri: &str, version: i64, text: &str) {
    handle_message(
        state,
        notification(
            "textDocument/didChange",
            json!({"textDocument": {"uri": uri, "version": version},
                   "contentChanges": [{"text": text}]}),
        ),
    );
}

/// 从通知列表里取唯一 publishDiagnostics 通知的 params。
fn only_publish(out: &[Outgoing]) -> serde_json::Value {
    assert_eq!(out.len(), 1, "期望恰好 1 条通知");
    match &out[0] {
        Outgoing::Notification(notification) => {
            assert_eq!(notification.method, "$/kode/publishDiagnostics");
            notification.params.clone().expect("有参数")
        }
        Outgoing::Response(_) => panic!("期望通知"),
    }
}

#[test]
fn did_open_flushes_publish_diagnostics_with_findings() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entities/Monster.def";

    did_open(&mut state, uri, 1, MISSING_FLAGS_DEF);
    assert_eq!(state.diagnostics_dirty.get(uri), Some(&1), "didOpen 标记脏");

    let params = only_publish(&flush(&mut state));
    assert!(!state.diagnostics_dirty.contains_key(uri), "flush 排空脏集");
    assert_eq!(params["uri"], json!(uri));
    assert_eq!(params["version"], json!(1));
    assert_eq!(params["layer"], json!("localSyntax"));
    let findings = params["findings"].as_array().expect("findings 数组");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0]["check"], json!("missing-flags"));
    assert_eq!(findings[0]["severity"], json!("error"));
}

#[test]
fn did_change_flushes_at_latest_version() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entities/Monster.def";

    // 先打开(buffer 上线;didOpen 也标脏),再 didChange 换版。
    did_open(&mut state, uri, 1, MISSING_FLAGS_DEF);
    flush(&mut state);
    did_change(&mut state, uri, 2, MISSING_FLAGS_DEF);
    assert_eq!(state.diagnostics_dirty.get(uri), Some(&2), "didChange 换版标脏");

    let params = only_publish(&flush(&mut state));
    assert_eq!(params["version"], json!(2), "按最新 didChange 版本发射");
    let findings = params["findings"].as_array().expect("findings 数组");
    assert_eq!(findings.len(), 1, "换代后仍单条 missing-flags");
    assert_eq!(findings[0]["check"], json!("missing-flags"));
}

#[test]
fn version_bump_to_clean_def_emits_nothing() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entities/Monster.def";

    did_open(&mut state, uri, 1, MISSING_FLAGS_DEF);
    assert_eq!(flush(&mut state).len(), 1, "v1 有 1 条");
    // v2:补齐 Flags → 零产出;flush 不再发射(同步面重置由 TS 承担)。
    did_change(&mut state, uri, 2, CLEAN_DEF);
    assert!(
        flush(&mut state).is_empty(),
        "干净 def 零通知"
    );
}

#[test]
fn did_close_drops_dirty_and_releases_layers() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entities/Monster.def";

    did_open(&mut state, uri, 1, MISSING_FLAGS_DEF);
    handle_message(
        &mut state,
        notification("textDocument/didClose", json!({"textDocument": {"uri": uri}})),
    );
    assert!(
        !state.diagnostics_dirty.contains_key(uri),
        "didClose 摘除脏标记"
    );
    assert!(
        flush(&mut state).is_empty(),
        "关闭后 flush 零通知"
    );
}

#[test]
fn empty_dirty_set_is_zero_cost() {
    let mut state = ServerState::new();
    assert!(
        flush(&mut state).is_empty(),
        "空脏集零发射"
    );
}

/// RESP-001:切片条数界——超 `DIAGNOSTIC_FLUSH_MAX_DOCS` 的脏集一次只
/// 消费条数界内的文档,界外余量原样回脏集(不丢),由后续切片追平。
/// (文档无 buffer → open_buffer 失败零产出,但预算仍按条数消费;锁的
/// 是「不全量排空」的切片语义,非 lint 产出。)
#[test]
fn budget_slice_keeps_remainder_dirty() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let extra = 4usize;
    let total = kode_server::server::DIAGNOSTIC_FLUSH_MAX_DOCS + extra;
    for i in 0..total {
        let uri = format!("file:///workspace/demo/entities/D{i}.def");
        state.diagnostics_dirty.insert(uri, 1);
    }
    let out = flush(&mut state);
    assert!(out.is_empty(), "无 buffer 文档零产出");
    assert_eq!(
        state.diagnostics_dirty.len(),
        extra,
        "一次切片只消费条数界,余量回脏集"
    );
}
