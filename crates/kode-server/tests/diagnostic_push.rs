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
    assert_eq!(
        state.diagnostics_dirty.get(uri),
        Some(&2),
        "didChange 换版标脏"
    );

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
    assert!(flush(&mut state).is_empty(), "干净 def 零通知");
}

#[test]
fn did_close_drops_dirty_and_releases_layers() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entities/Monster.def";

    did_open(&mut state, uri, 1, MISSING_FLAGS_DEF);
    handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({"textDocument": {"uri": uri}}),
        ),
    );
    assert!(
        !state.diagnostics_dirty.contains_key(uri),
        "didClose 摘除脏标记"
    );
    assert!(flush(&mut state).is_empty(), "关闭后 flush 零通知");
}

#[test]
fn empty_dirty_set_is_zero_cost() {
    let mut state = ServerState::new();
    assert!(flush(&mut state).is_empty(), "空脏集零发射");
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

// ---- CREATE-05:creation-API params face wired into the flush chain ------

/// Def fixture: a plain BASE property and a cell-domain property (the
/// catalog the params face folds against).
const CREATE_PARAMS_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>UINT32</Type>\n\
\t\t\t<Flags>BASE</Flags>\n\
\t\t</hp>\n\
\t\t<speed>\n\
\t\t\t<Type>FLOAT</Type>\n\
\t\t\t<Flags>CELL_PUBLIC</Flags>\n\
\t\t</speed>\n\
\t</Properties>\n\
</root>\n";

/// Python fixture: one creation call with all four non-silent shapes —
/// type-suspicious (hp), cellData-channel type-suspicious (speed), the
/// cellData-not-dict error, and an undeclared key (extra).
const CREATE_PARAMS_PY: &str = "import KBEngine\n\nKBEngine.createEntity(\"Monster\", \
                                 {\"hp\": \"no\", \"speed\": [], \"cellData\": 7, \"extra\": 1})\n";

const CREATE_PARAMS_PY_URI: &str = "file:///workspace/demo/scripts/entities/spawn.py";

/// didOpen + a hover request on the def (drains the ingest line so the
/// params face sees the corpus catalog).
fn open_def_with_corpus_ready(state: &mut ServerState, uri: &str, text: &str) {
    did_open(state, uri, 1, text);
    handle_message(
        state,
        request(
            99,
            "textDocument/hover",
            json!({
                "textDocument": {"uri": uri},
                "position": {"line": 0, "character": 0}
            }),
        ),
    );
}

/// All publishDiagnostics params from one flush, with their layer names.
fn publishes(out: &[Outgoing]) -> Vec<(String, serde_json::Value)> {
    out.iter()
        .filter_map(|item| match item {
            Outgoing::Notification(notification)
                if notification.method == "$/kode/publishDiagnostics" =>
            {
                let params = notification.params.clone().expect("有参数");
                let layer = params["layer"].as_str().expect("layer").to_string();
                Some((layer, params))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn create_params_face_publishes_through_flush_chain() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let def_uri = "file:///workspace/demo/entities/Monster.def";
    open_def_with_corpus_ready(&mut state, def_uri, CREATE_PARAMS_DEF);

    did_open(&mut state, CREATE_PARAMS_PY_URI, 1, CREATE_PARAMS_PY);
    let out = publishes(&flush(&mut state));
    let by_layer: std::collections::BTreeMap<String, serde_json::Value> = out.into_iter().collect();
    assert_eq!(by_layer.len(), 2, "localSyntax + semantic 两层各一条通知");

    // localSyntax:the cellData-not-dict error (catalog-free, self-contained).
    let local = &by_layer["localSyntax"];
    assert_eq!(local["uri"], json!(CREATE_PARAMS_PY_URI));
    assert_eq!(local["version"], json!(1));
    let local_findings = local["findings"].as_array().expect("findings");
    assert_eq!(local_findings.len(), 1);
    assert_eq!(
        local_findings[0]["check"],
        json!("create-params-celldata-not-dict")
    );
    assert_eq!(local_findings[0]["severity"], json!("error"));

    // semantic:catalog-dependent hints (undeclared + two type suspicions,
    // the cellData-channel one carries the channel in its message).
    let semantic = &by_layer["semantic"];
    let semantic_findings = semantic["findings"].as_array().expect("findings");
    let checks: Vec<&str> = semantic_findings
        .iter()
        .map(|f| f["check"].as_str().expect("check"))
        .collect();
    assert_eq!(
        checks,
        vec![
            "create-params-type-suspicious",
            "create-params-type-suspicious",
            "create-params-undeclared-attr"
        ]
    );
    assert!(semantic_findings[1]["message"]
        .as_str()
        .expect("message")
        .contains("cellData"));
}

#[test]
fn create_params_face_stays_silent_without_corpus() {
    // No def opened: the entity has no catalog → IndexMissing inside
    // check_params → no catalog-dependent hints published (never "def
    // does not declare"). The cellData shape check is catalog-free by
    // design, so the fixture keeps only catalog-dependent keys here.
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let py =
        "import KBEngine\nKBEngine.createEntity(\"Monster\", {\"extra\": 1, \"hp\": \"no\"})\n";
    did_open(&mut state, CREATE_PARAMS_PY_URI, 1, py);
    assert!(publishes(&flush(&mut state)).is_empty(), "无目录零发射");
}

#[test]
fn plain_python_without_creation_calls_publishes_nothing() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let def_uri = "file:///workspace/demo/entities/Monster.def";
    open_def_with_corpus_ready(&mut state, def_uri, CREATE_PARAMS_DEF);
    let py = "import KBEngine\n\nprint(\"no creation calls here\")\n";
    did_open(&mut state, CREATE_PARAMS_PY_URI, 1, py);
    assert!(publishes(&flush(&mut state)).is_empty(), "无调用点零发射");
}
