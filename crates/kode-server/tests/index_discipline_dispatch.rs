//! `$/kode/syntax/gate` 与 `$/kode/events/coalesce` dispatch 单测
//! (INDEX-DISCIPLINE-001 ①③)。
//!
//! 走完整 `$/kode/rpc` 链路(模式照 ruff_lint_dispatch.rs):两个面都是
//! 无状态纯函数决策核,TS 薄壳经 kodeCoreShadowGate 调用。覆盖:
//! - syntax/gate:健康文本 ok=true;编辑中途断裂(括号/字符串)ok=false 带
//!   行号 reason;缺 text 参数如实 Err(不静默当空文本);
//! - events/coalesce:窗口 hold → dirty 顺延 → flush 按「最近修改的最后出」
//!   排序;max_defer 到顶 dirty 也放行(有界);缺 nowMs 如实 Err。

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

/// 走完整 `$/kode/rpc` 链路;错误响应如实返回 Err 字符串。
fn rpc(face: &str, params: Value) -> Result<Value, String> {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(1, "$/kode/rpc", json!({"method": face, "params": params})),
    );
    match &out[0] {
        Outgoing::Response(response) => {
            if let Some(result) = response.result.as_ref() {
                Ok(result.clone())
            } else {
                Err(response
                    .error
                    .as_ref()
                    .map(|e| e.message.to_string())
                    .unwrap_or_else(|| "unknown rpc error".into()))
            }
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

#[test]
fn syntax_gate_passes_healthy_text() {
    let result = rpc(
        "$/kode/syntax/gate",
        json!({"text": "class A:\n    def m(self):\n        return 1\n"}),
    )
    .unwrap();
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["reasons"], json!([]));
}

#[test]
fn syntax_gate_rejects_mid_edit_breakage_with_location() {
    let bracket = rpc("$/kode/syntax/gate", json!({"text": "def m(self:\n    pass\n"})).unwrap();
    assert_eq!(bracket["ok"], json!(false));
    let reasons = bracket["reasons"].as_array().unwrap();
    assert!(reasons.iter().any(|r| r.as_str().unwrap().contains("unclosed-bracket")));

    let string = rpc("$/kode/syntax/gate", json!({"text": "value = 'abc\n"})).unwrap();
    assert_eq!(string["ok"], json!(false));
    assert!(string["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r.as_str().unwrap().contains("unterminated-string")));
}

#[test]
fn syntax_gate_missing_text_is_an_honest_error() {
    assert!(rpc("$/kode/syntax/gate", json!({})).is_err());
}

#[test]
fn coalesce_holds_inside_window_flushes_past_it() {
    let result = rpc(
        "$/kode/events/coalesce",
        json!({
            "nowMs": 6300,
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [
                {"file": "a.py", "firstPushedAtMs": 6000, "lastPushedAtMs": 6200}
            ],
            "dirtyFiles": []
        }),
    )
    .unwrap();
    // 窗口内(6300-6200=100 < 300):hold
    assert_eq!(result["hold"], json!(1));
    assert_eq!(result["flush"], json!([]));

    let past = rpc(
        "$/kode/events/coalesce",
        json!({
            "nowMs": 6600,
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [
                {"file": "a.py", "firstPushedAtMs": 5800, "lastPushedAtMs": 6000}
            ],
            "dirtyFiles": []
        }),
    )
    .unwrap();
    assert_eq!(past["flush"], json!(["a.py"]));
    assert_eq!(past["hold"], json!(0));
}

#[test]
fn coalesce_defers_dirty_files_until_max_defer_bound() {
    // dirty 且未到顺延上限:下一窗(顺延)
    let deferred = rpc(
        "$/kode/events/coalesce",
        json!({
            "nowMs": 1000,
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [
                {"file": "a.py", "firstPushedAtMs": 0, "lastPushedAtMs": 0}
            ],
            "dirtyFiles": ["a.py"]
        }),
    )
    .unwrap();
    assert_eq!(deferred["defer"], json!(["a.py"]));
    assert_eq!(deferred["flush"], json!([]));

    // dirty 也到顶(first 到 now 已 5000+):有界放行,不让队列饿死
    let beyond = rpc(
        "$/kode/events/coalesce",
        json!({
            "nowMs": 5600,
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [
                {"file": "a.py", "firstPushedAtMs": 0, "lastPushedAtMs": 5000}
            ],
            "dirtyFiles": ["a.py"]
        }),
    )
    .unwrap();
    assert_eq!(beyond["flush"], json!(["a.py"]));
}

#[test]
fn coalesce_flushes_most_recently_touched_last() {
    let result = rpc(
        "$/kode/events/coalesce",
        json!({
            "nowMs": 10000,
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [
                {"file": "newest.py", "firstPushedAtMs": 700, "lastPushedAtMs": 900},
                {"file": "oldest.py", "firstPushedAtMs": 0, "lastPushedAtMs": 100},
                {"file": "middle.py", "firstPushedAtMs": 400, "lastPushedAtMs": 500}
            ],
            "dirtyFiles": []
        }),
    )
    .unwrap();
    assert_eq!(result["flush"], json!(["oldest.py", "middle.py", "newest.py"]));
}

#[test]
fn coalesce_missing_now_is_an_honest_error() {
    let result = rpc(
        "$/kode/events/coalesce",
        json!({
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [],
            "dirtyFiles": []
        }),
    );
    assert!(result.is_err());
}
