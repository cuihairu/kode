//! RUST-120-W:分类失效差异化——server 分派层全链(生产形状)。
//!
//! 覆盖:didOpen → hover(请求入口 drain,ingestSignature 记账)→
//! didChange 同文本(风暴缓冲 → 请求入口 take_buffered + freshen →
//! ingestIdentical)→ didChange 尾注(ingestBodyOnly)→ didChange 类型
//! 变更(ingestSignature 重灌,悬停反映新类型)。与 TS
//! kodeCoreDifferentialInvalidation e2e 同序对账(那里是真实二进制+TS
//! gate 层;本处锁 server 分派层同语义)。

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Notification, Request, RequestId};
use kode_server::server::Outgoing;
use kode_server::{handle_message, ServerState};

const DEF_V1: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
const DEF_BODY_ONLY: &str = DEF_V1; // 下面用拼接常量区分(编译期不可变拼接)
const URI: &str = "file:///tmp/kode-ingest-dispatch-probe.def";

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn notification(method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Notification(Notification {
        jsonrpc: "2.0".into(),
        method: method.into(),
        params: Some(params),
    })
}

fn request_result(state: &mut ServerState, id: i64, method: &str, params: Value) -> Value {
    let out = handle_message(state, request(id, method, params));
    assert_eq!(out.len(), 1, "{method} 应恰有一条回执");
    match out.into_iter().next().unwrap() {
        Outgoing::Response(response) => response.result.expect("请求应成功"),
        other => panic!("{method} 回执形状异常: {other:?}"),
    }
}

fn ingest(state: &mut ServerState) -> Value {
    let result = request_result(state, 99, "$/kode/health", json!({}));
    result
        .get("ingest")
        .cloned()
        .expect("health 应带 ingest 键")
}

fn hover_hp(state: &mut ServerState, id: i64) -> Option<String> {
    let result = request_result(
        state,
        id,
        "textDocument/hover",
        json!({
            "textDocument": {"uri": URI},
            "position": {"line": 2, "character": 4}
        }),
    );
    result
        .get("contents")
        .and_then(|c| c.get("value"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

#[test]
fn did_change_classification_matches_category_over_dispatch() {
    let mut state = ServerState::new();
    let _ = handle_message(
        &mut state,
        request(
        0,
        "initialize",
        json!({"capabilities": {}, "rootUri": "file:///tmp"})
    ),
    );

    // 首次入库 = signature。
    let _ = handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": URI, "languageId": "kbengine-def", "version": 1, "text": DEF_V1
                }
            }),
        ),
    );
    {
        let result = request_result(&mut state, 98, "$/kode/health", json!({}));
        eprintln!("DBG health initialized={} documents={:?} ingest={}", result["initialized"], result["documents"], result["ingest"]);
    }
    let hover1 = hover_hp(&mut state, 1).expect("打开文档 hover 应可用");
    assert!(hover1.contains("UINT32"), "悬停应出 UINT32: {hover1}");
    let after_open = ingest(&mut state);
    assert_eq!(after_open["ingestSignature"], 1, "首次入库 = signature");
    // RUST-125:解析驻留观测键恒在(预算构造下 budget=256MB 常量口径)。
    let pc = request_result(&mut state, 99, "$/kode/health", json!({}))["parseCache"].clone();
    assert_eq!(
        pc,
        json!({
            "budgetBytes": 268435456u64,
            "residentBytes": pc["residentBytes"],
            "evictions": pc["evictions"],
            "valid": pc["valid"],
            "negative": pc["negative"]
        }),
        "parseCache 观测键形状(预算常量透传)"
    );
    assert!(pc["valid"].as_u64().unwrap() >= 1, "入库后有效条目 >= 1");
    assert!(pc["residentBytes"].as_u64().unwrap() > 0, "入库后驻留权重 > 0");

    // 同文本 didChange(新版本)= identical;悬停不变。
    let _ = handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": URI, "version": 2},
                "contentChanges": [{"text": DEF_V1}]
            }),
        ),
    );
    let hover2 = hover_hp(&mut state, 2).expect("identical 后悬停可用");
    assert!(hover2.contains("UINT32"), "悬停应保持 UINT32: {hover2}");
    let after_identical = ingest(&mut state);
    assert_eq!(
        after_identical["ingestIdentical"], 1,
        "同文本 didChange = identical"
    );
    assert_eq!(after_identical["ingestSignature"], 1, "identical 不失效");

    // 尾注 didChange = body-only(零失效);悬停保持旧事实。
    let def_body_only = format!("{DEF_V1}\n<!-- body-only 尾注 -->\n");
    let _ = handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": URI, "version": 3},
                "contentChanges": [{"text": def_body_only}]
            }),
        ),
    );
    let hover3 = hover_hp(&mut state, 3).expect("body-only 后悬停可用");
    assert!(hover3.contains("UINT32"), "悬停应保持 UINT32: {hover3}");
    let after_body_only = ingest(&mut state);
    assert_eq!(after_body_only["ingestBodyOnly"], 1, "尾注 = body-only");
    assert_eq!(after_body_only["ingestSignature"], 1, "body-only 不失效");

    // 属性类型变更 = signature;悬停重灌出 UINT16。
    let def_signature = DEF_V1.replace("UINT32", "UINT16");
    let _ = handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": URI, "version": 4},
                "contentChanges": [{"text": def_signature}]
            }),
        ),
    );
    let hover4 = hover_hp(&mut state, 4).expect("signature 后悬停可用");
    assert!(hover4.contains("UINT16"), "悬停应反映 UINT16: {hover4}");
    let after_signature = ingest(&mut state);
    assert_eq!(after_signature["ingestSignature"], 2, "类型变更 = signature");
    assert_eq!(after_signature["ingestIdentical"], 1);
    assert_eq!(after_signature["ingestBodyOnly"], 1);
}

const _: &str = DEF_BODY_ONLY; // 保留常量位(与 TS e2e 常量命名对齐)
