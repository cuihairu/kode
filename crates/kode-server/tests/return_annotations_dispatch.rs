//! `$/kode/python/returnAnnotations` dispatch 与提取核关键例单测
//! (RUST-MIGRATION-AUDIT-006 B1 车道批 3;与 TS
//! tests/pythonReturnTypeInference.test.ts 关键例对应)。
//!
//! 覆盖:注解事实(有注解/无注解 null/首定义优先/多行签名/字符串内 def 掩码)、
//! 导入绑定(from 别名/bare 别名点分路径/通配跳过/相对点剥除)、逐行单跳调用
//! (属性直调/简单调用/链式拒绝/`==` 拒绝/引号 rhs 掩码后可见)、出参 camelCase。

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

fn response_of(out: &[Outgoing]) -> Value {
    match &out[0] {
        Outgoing::Response(response) => response.result.as_ref().unwrap().clone(),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

fn run(text: &str) -> Value {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/python/returnAnnotations", "params": {"text": text}}),
        ),
    );
    response_of(&out)
}

#[test]
fn dispatch_facts_first_definition_wins() {
    let text = "def a() -> int:\n    pass\ndef a() -> str:\n    pass\ndef b():\n    pass\n";
    let out = run(text);
    let facts = out["facts"].as_array().unwrap();
    assert_eq!(facts.len(), 2);
    assert_eq!(facts[0]["name"], json!("a"));
    assert_eq!(facts[0]["annotation"], json!("int"));
    assert_eq!(facts[1]["name"], json!("b"));
    assert_eq!(facts[1]["annotation"], Value::Null);
}

#[test]
fn dispatch_multiline_signature_annotation() {
    let text = "def get_data(self, key,\n        fallback=None) -> JSONDATA:\n    pass\n";
    let out = run(text);
    let facts = out["facts"].as_array().unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0]["annotation"], json!("JSONDATA"));
}

#[test]
fn dispatch_def_in_string_masked() {
    let text = "s = \"def fake() -> Ghost:\"\ndef real() -> int:\n    pass\n";
    let out = run(text);
    let facts = out["facts"].as_array().unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0]["name"], json!("real"));
}

#[test]
fn dispatch_imports_faces() {
    let text = "import pkg.good as g\nfrom .mods import Good as G, Bad\nfrom m import *\n";
    let out = run(text);
    let names = out["imports"]["names"].as_array().unwrap();
    assert_eq!(names.len(), 2);
    assert_eq!(names[0]["local"], json!("G"));
    assert_eq!(names[0]["module"], json!("mods"));
    assert_eq!(names[0]["symbol"], json!("Good"));
    assert_eq!(names[1]["symbol"], json!("Bad"));
    let receivers = out["imports"]["receivers"].as_array().unwrap();
    assert_eq!(receivers.len(), 1);
    assert_eq!(receivers[0]["local"], json!("g"));
    assert_eq!(receivers[0]["module"], json!("pkg/good"));
}

#[test]
fn dispatch_local_assignment_calls() {
    let text = "data = activity_data.get_data()\nx = f().g()\ny == 5\nz = make()\n";
    let out = run(text);
    let calls = out["localAssignmentCalls"].as_array().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["line"], json!(0));
    assert_eq!(calls[0]["target"], json!("data"));
    assert_eq!(calls[0]["receiver"], json!("activity_data"));
    assert_eq!(calls[0]["methodName"], json!("get_data"));
    assert_eq!(calls[1]["target"], json!("z"));
    assert_eq!(calls[1]["receiver"], Value::Null);
    assert_eq!(calls[1]["methodName"], json!("make"));
}

#[test]
fn dispatch_calls_quoted_rhs_masked() {
    // 引号体里的形似赋值不入调用面(全文掩码);真调用在掩码后仍可见
    let text = "log(\"x = fake()\")\nok = real()\n";
    let out = run(text);
    let calls = out["localAssignmentCalls"].as_array().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["line"], json!(1));
    assert_eq!(calls[0]["target"], json!("ok"));
}

#[test]
fn dispatch_unknown_method_is_error() {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/python/returnAnnotationsTypo", "params": {"text": ""}}),
        ),
    );
    match &out[0] {
        Outgoing::Response(response) => {
            assert!(response.error.is_some(), "unknown method must error");
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
}
