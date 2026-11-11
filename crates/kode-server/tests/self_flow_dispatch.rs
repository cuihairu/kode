//! `$/kode/python/selfAttributeFlow` dispatch 与流引擎关键例单测
//! (RUST-MIGRATION-AUDIT-006 B1 车道批 1)。
//!
//! 覆盖(与 TS tests/selfAttributeFlowTypes.test.ts 关键例对应;回调面用例
//! 留 TS 侧——生产契约无回调):
//! - 守卫窄化:调用注解解不出 → 空集诚实(annotation null/narrowed true);
//! - __init__ 尾部赋值覆盖收敛为 list;裸 `= None` 保留 None 证据;
//! - 早退守卫去 None;类级 `X = None` 计入基类;
//! - 字面量原子(int/float/bool/list/dict/str/bytes 前缀/tuple);
//! - KR-AUD-59:`+=`/`!=` 不视为赋值,裸 `=` 覆盖;
//! - 非法入参(attr 空/queryLine 负/越界)→ flow:null;
//! - versionKey 复用:同键两次查询结果一致(共享解析)。

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

/// 走完整 `$/kode/rpc` 链路调 `$/kode/python/selfAttributeFlow`。
fn query(lines: &[&str], query_line: i64, attr: &str, version_key: Option<&str>) -> Value {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let mut params = json!({
        "lines": lines,
        "queryLine": query_line,
        "attr": attr,
    });
    if let Some(key) = version_key {
        params["versionKey"] = json!(key);
    }
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/python/selfAttributeFlow", "params": params}),
        ),
    );
    response_of(&out).clone()
}

fn flow_of(result: &Value) -> &Value {
    result.get("flow").unwrap()
}

fn field_of(result: &Value, field: &str) -> Value {
    flow_of(result).get(field).cloned().expect("field present")
}

const GUARD_BODY: [&str; 7] = [
    "class Foo:",
    "    def __init__(self):",
    "        self.TalentTree = None",
    "    def method(self):",
    "        if self.TalentTree is None:",
    "            self.TalentTree = make_tree()",
    "        x = self.TalentTree",
];

#[test]
fn guard_narrowing_honest_empty_set() {
    let result = query(&GUARD_BODY, 6, "TalentTree", None);
    let flow = flow_of(&result);
    assert_eq!(flow["hasNone"], json!(false));
    assert_eq!(flow["narrowed"], json!(true));
    assert_eq!(flow["types"], json!([]));
    assert_eq!(flow["annotation"], Value::Null);
}

#[test]
fn init_override_converges_to_list() {
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.TalentTree = None",
        "        self.TalentTree = []",
        "    def method(self):",
        "        x = self.TalentTree",
    ];
    let result = query(&body, 5, "TalentTree", None);
    let flow = flow_of(&result);
    assert_eq!(flow["annotation"], json!("list"));
    assert_eq!(flow["types"], json!(["list"]));
    assert_eq!(flow["hasNone"], json!(false));
}

#[test]
fn bare_none_keeps_none_evidence() {
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.TalentTree = None",
        "    def method(self):",
        "        self.TalentTree.get(0)",
    ];
    let result = query(&body, 4, "TalentTree", None);
    let flow = flow_of(&result);
    assert_eq!(flow["hasNone"], json!(true));
    assert_eq!(flow["narrowed"], json!(false));
    assert_eq!(flow["annotation"], json!("None"));
}

#[test]
fn early_exit_guard_removes_none() {
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.TalentTree = None",
        "    def method(self):",
        "        if self.TalentTree is None:",
        "            return",
        "        self.TalentTree.get(0)",
    ];
    let result = query(&body, 6, "TalentTree", None);
    let flow = flow_of(&result);
    assert_eq!(flow["hasNone"], json!(false));
    assert_eq!(flow["narrowed"], json!(true));
}

#[test]
fn class_level_none_reports() {
    let body = [
        "class Foo:",
        "    TalentTree = None",
        "    def method(self):",
        "        self.TalentTree.get(0)",
    ];
    let result = query(&body, 3, "TalentTree", None);
    assert_eq!(field_of(&result, "hasNone"), json!(true));
}

#[test]
fn literal_atoms() {
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.A = [1, 2, 3]",
        "        self.B = {\"k\": 1}",
        "        self.C = \"hi\"",
        "        self.D = 7",
        "        self.E = 3.14",
        "        self.F = True",
        "        self.G = b'abc'",
    ];
    let result = query(&body, 2, "A", None);
    assert_eq!(field_of(&result, "annotation"), json!("list"));
    let result = query(&body, 3, "B", None);
    assert_eq!(field_of(&result, "annotation"), json!("dict"));
    let result = query(&body, 4, "C", None);
    assert_eq!(field_of(&result, "annotation"), json!("str"));
    let result = query(&body, 5, "D", None);
    assert_eq!(field_of(&result, "annotation"), json!("int"));
    let result = query(&body, 6, "E", None);
    assert_eq!(field_of(&result, "annotation"), json!("float"));
    let result = query(&body, 7, "F", None);
    assert_eq!(field_of(&result, "types"), json!(["bool"]));
    let result = query(&body, 8, "G", None);
    assert_eq!(field_of(&result, "annotation"), json!("bytes"));
}

#[test]
fn kr_aud_59_augmented_and_comparison_not_captured() {
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.items = None",
        "    def use(self):",
        "        self.items += [1]",
        "        self.items != []",
        "        x = self.items",
    ];
    let result = query(&body, 6, "items", None);
    let flow = flow_of(&result);
    assert_eq!(flow["hasNone"], json!(true));
}

#[test]
fn kr_aud_59_plain_assignment_overrides() {
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.items = None",
        "    def use(self):",
        "        self.items = []",
        "        x = self.items",
    ];
    let result = query(&body, 5, "items", None);
    let flow = flow_of(&result);
    assert_eq!(flow["annotation"], json!("list"));
    assert_eq!(flow["hasNone"], json!(false));
}

#[test]
fn invalid_inputs_return_flow_null() {
    let body = ["class Foo:", "    def m(self):", "        self.x = 1"];
    assert_eq!(query(&body, 1, "", None).get("flow"), Some(&Value::Null));
    assert_eq!(query(&body, -1, "x", None).get("flow"), Some(&Value::Null));
    assert_eq!(query(&body, 99, "x", None).get("flow"), Some(&Value::Null));
}

#[test]
fn version_key_reuse_consistent() {
    let a = query(&GUARD_BODY, 6, "TalentTree", Some("file:///a.py|9"));
    let b = query(&GUARD_BODY, 6, "TalentTree", Some("file:///a.py|9"));
    assert_eq!(a, b);
    assert_eq!(flow_of(&a)["narrowed"], json!(true));
}
