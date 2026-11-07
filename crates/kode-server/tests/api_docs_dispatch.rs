//! `$/kode/apiDocs/lookup` RPC dispatch 烟测:走完整 `$/kode/rpc` 链路,
//! 验证域精确命中、zh 本地化回退与缺参 error 通道。

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

fn call_lookup(params: Value) -> Result<Value, String> {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(1, "$/kode/rpc", json!({"method": "$/kode/apiDocs/lookup", "params": params})),
    );
    match &out[0] {
        Outgoing::Response(response) => response
            .result
            .clone()
            .ok_or_else(|| "null result".to_string()),
        Outgoing::Notification(_) => Err("expected response".to_string()),
    }
}

#[test]
fn dispatch_domain_hit_and_zh_fallback() {
    let hit = call_lookup(json!({"name": "onTimer", "domain": "base", "locale": "zh-cn"}))
        .expect("onTimer@base 必须命中");
    assert_eq!(hit.get("owner").and_then(Value::as_str), Some("entity"));
    assert_eq!(hit.get("kind").and_then(Value::as_str), Some("callback"));
    // onTimer(base entity 面)有中文摘要 → 本地化
    assert_eq!(hit.get("localized").and_then(Value::as_bool), Some(true));

    // 缺 locale 默认 en;缺 domain 走唯一 owner/歧义口径
    let en = call_lookup(json!({"name": "createEntity"})).expect("createEntity 唯一 owner 命中");
    assert!(en.get("signature").is_some());
    let ambiguous = call_lookup(json!({"name": "fireEvent"})).expect("歧义也是正常返回");
    assert!(ambiguous.get("ambiguous").is_some());
}

#[test]
fn dispatch_missing_name_is_error_channel() {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(1, "$/kode/rpc", json!({"method": "$/kode/apiDocs/lookup", "params": {}})),
    );
    match &out[0] {
        Outgoing::Response(response) => assert!(
            response.error.is_some(),
            "缺 name 必须走 error 通道: {response:?}"
        ),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}
