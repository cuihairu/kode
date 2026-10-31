//! `$/kode/rpc` 通用命令面(Phase0 接线)单测:echo 往返、未知方法错误码、
//! 重复注册 panic。后续命令增量(消息表/生成/lint)在此各加自己的
//! dispatch 用例;handler 纯函数面在各自模块单测。

use serde_json::json;

use kode_protocol::{error_codes, IncomingMessage, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

fn request(id: i64, method: &str, params: serde_json::Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
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

fn init(state: &mut ServerState) {
    handle_message(
        state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
}

/// echo 内建 handler:params 原样回显,验 dispatch 链路贯穿。
#[test]
fn echo_round_trips_params() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/echo", "params": {"a": 1, "b": "x"}}),
        ),
    );
    assert_eq!(response_of(&out), &json!({"a": 1, "b": "x"}));
}

/// params 缺省(null)时 echo 回显 null,不炸。
#[test]
fn echo_without_params_returns_null() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(2, "$/kode/rpc", json!({"method": "$/kode/echo"})),
    );
    assert!(response_of(&out).is_null());
}

/// 未注册方法 → -32601(与 server 顶层未知方法同码)。
#[test]
fn unknown_rpc_method_is_method_not_found() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(3, "$/kode/rpc", json!({"method": "$/kode/nope", "params": {}})),
    );
    assert_eq!(error_code_of(&out), error_codes::METHOD_NOT_FOUND);
}

/// 未 initialize 先调 → -32002(与其它请求同门)。
#[test]
fn rpc_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(4, "$/kode/rpc", json!({"method": "$/kode/echo", "params": {}})),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

/// 同一 method 二次注册是编程错误,必须 panic 而不是静默覆盖。
#[test]
#[should_panic(expected = "registered twice")]
fn rpc_registry_rejects_duplicate_registration() {
    use kode_server::rpc::RpcRegistry;
    let mut reg = RpcRegistry::new(); // 内建已注册 $/kode/echo
    fn passthrough(v: serde_json::Value) -> Result<serde_json::Value, String> {
        Ok(v)
    }
    reg.register("$/kode/echo", passthrough);
}

/// registry 可列出已注册方法(健康/对账面)。
#[test]
fn rpc_registry_lists_registered_methods() {
    use kode_server::rpc::RpcRegistry;
    let reg = RpcRegistry::new();
    let methods: Vec<&str> = reg.methods().collect();
    assert!(methods.contains(&"$/kode/echo"));
}
