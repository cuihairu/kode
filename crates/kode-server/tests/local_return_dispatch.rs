//! `$/kode/python/localReturnType` dispatch 与 KBUG-SCOPE 词法作用域链 RPC 例
//! (KBUG-SCOPE-05 生产接线验收:真实 RPC 链路上钉「参数遮蔽/域边界/
//! global/nonlocal 透传/类体隔离」的应答;可推导真值与诚实空各半记录)。

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

fn response_of(out: &[Outgoing]) -> &Value {
    match &out[0] {
        Outgoing::Response(response) => response.result.as_ref().unwrap(),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

/// 走完整 `$/kode/rpc` 链路调 `$/kode/python/localReturnType`。
fn query(lines: &[&str], hover_line: i64, word: &str) -> Value {
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
            json!({
                "method": "$/kode/python/localReturnType",
                "params": {
                    "lines": lines,
                    "hoverLine": hover_line,
                    "word": word,
                }
            }),
        ),
    );
    response_of(&out).clone()
}

/// SCOPE-01:模块层 `x = make()` 不得借给 `def run(x)` 参数位 → ret null。
#[test]
fn kbug_scope_rpc_param_shadow_honest_null() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "x = make()",
        "",
        "def run(x):",
        "    return x",
    ];
    let out = query(&lines, 6, "x");
    assert!(out["ret"].is_null(), "参数位应诚实空,实得 {:?}", out["ret"]);
}

/// SCOPE-05 已知面记录:模块层合法读 → 注解命中(回归网)。
#[test]
fn kbug_scope_rpc_module_read_hit() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "data = make()",
    ];
    let out = query(&lines, 3, "data");
    assert_eq!(out["ret"]["annotation"], "Tree");
    assert_eq!(out["ret"]["methodName"], "make");
}

/// SCOPE-05 已知面记录:嵌套函数闭包读外层函数写点 → 注解命中。
#[test]
fn kbug_scope_rpc_nested_closure_read_hit() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "def outer():",
        "    data = make()",
        "",
        "    def inner():",
        "        return data",
        "    return inner",
    ];
    let out = query(&lines, 7, "data");
    assert_eq!(
        out["ret"]["annotation"],
        "Tree",
        "闭包读应命中外层函数域写点,实得 {:?}",
        out["ret"]
    );
}

/// SCOPE-02:def 结束后的模块层读不借函数体写点 → ret null。
#[test]
fn kbug_scope_rpc_def_body_write_not_borrowed_after_def() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "def run():",
        "    data = make()",
        "",
        "print(data)",
    ];
    let out = query(&lines, 6, "data");
    assert!(out["ret"].is_null(), "函数体写点不应外溢,实得 {:?}", out["ret"]);
}

/// SCOPE-03:global 声明的读透传模块绑定 → 注解命中。
#[test]
fn kbug_scope_rpc_global_read_hit() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "data = make()",
        "",
        "def run():",
        "    global data",
        "    return data",
    ];
    let out = query(&lines, 7, "data");
    assert_eq!(out["ret"]["annotation"], "Tree");
}

/// SCOPE-04:方法体裸名不读所属类体属性表 → ret null(语义重钉)。
#[test]
fn kbug_scope_rpc_method_body_skips_class_body() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "class A:",
        "    data = make()",
        "",
        "    def n(self):",
        "        return data",
    ];
    let out = query(&lines, 7, "data");
    assert!(out["ret"].is_null(), "类体属性表不应被方法体借用,实得 {:?}", out["ret"]);
}

/// SCOPE-04 已知面记录:类体直系读读本类体写点 → 注解命中。
#[test]
fn kbug_scope_rpc_class_body_direct_read_hit() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "class A:",
        "    data = make()",
        "    more = data",
    ];
    let out = query(&lines, 5, "data");
    assert_eq!(out["ret"]["annotation"], "Tree");
}

/// 契约守卫:非法入参(hoverLine 负 / word 空)→ ret null。
#[test]
fn kbug_scope_rpc_invalid_params_honest_null() {
    let lines = ["data = make()"];
    let neg = query(&lines, -1, "data");
    assert!(neg["ret"].is_null());
    let empty_word = query(&lines, 0, "");
    assert!(empty_word["ret"].is_null());
}

// ---- KBUG-BIND(RPC 面绑定验收;BIND-01/03/05)----

/// BIND-01:被调名被参数遮蔽——`run(make)` 内 `make()` 不借模块 def 注解
/// → ret null。
#[test]
fn kbug_bind_rpc_param_shadow_honest_null() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "def run(make):",
        "    data = make()",
        "    return data",
    ];
    let out = query(&lines, 4, "data");
    assert!(out["ret"].is_null(), "参数遮蔽的被调应诚实空,实得 {:?}", out["ret"]);
}

/// BIND-01 守卫:未遮蔽调用照常命中(RPC 面)。
#[test]
fn kbug_bind_rpc_unshadowed_call_hit() {
    let lines = [
        "def make() -> Tree:",
        "    return None",
        "",
        "def run():",
        "    data = make()",
        "    return data",
    ];
    let out = query(&lines, 4, "data");
    assert_eq!(out["ret"]["annotation"], "Tree");
}

/// BIND-03:模块层 `A = B` 重绑定后 `A.load()` 不沿用旧 A 注解 → ret null
/// (B 类值链解不出方法面;绝不含旧 int)。
#[test]
fn kbug_bind_rpc_module_class_rebind_not_old_annotation() {
    let lines = [
        "class A:",
        "    def load(self) -> int:",
        "        return None",
        "",
        "class B:",
        "    def load(self) -> str:",
        "        return None",
        "",
        "A = B",
        "data = A.load(A())",
    ];
    let out = query(&lines, 9, "data");
    assert!(out["ret"].is_null(), "重绑定后不应沿用旧类注解,实得 {:?}", out["ret"]);
}

/// BIND-02:别名透传——`fetch = real`(real 有注解)后 `fetch()` 命中
/// real 注解面(绑定值身份原子链)。
#[test]
fn kbug_bind_rpc_alias_pass_through_hit() {
    let lines = [
        "def real() -> Tree:",
        "    return None",
        "",
        "def run():",
        "    fetch = real",
        "    data = fetch()",
        "    return data",
    ];
    let out = query(&lines, 5, "data");
    assert_eq!(
        out["ret"]["annotation"],
        "Tree",
        "别名绑定应透传 real 注解,实得 {:?}",
        out["ret"]
    );
}
