//! `$/kode/python/userTypeContract` dispatch 单测(RUST-MIGRATION-AUDIT-006
//! B1 车道批 4;与 TS tests/userTypeContract.test.ts 关键例对应)。
//!
//! 覆盖:缺一/缺全方法收集(消息文案字节级/定位行/related 标签)、全齐零项、
//! 文件过滤与空 implFile 静默、probes 探测面(CRLF 源/缩进)、camelCase 出参、
//! 未知方法报错。

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

fn run(params: Value) -> Value {
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
            json!({"method": "$/kode/python/userTypeContract", "params": params}),
        ),
    );
    response_of(&out)
}

const COMPLETE_IMPL: &str = "class TalentTreeImpl:\n    def createObjFromDict(self, dictData):\n        return dictData\n    def getDictFromObj(self, obj):\n        return {}\n    def isSameType(self, obj):\n        return True\n";
const NO_IS_SAME_IMPL: &str = "class TalentTreeImpl:\n    def createObjFromDict(self, dictData):\n        return dictData\n    def getDictFromObj(self, obj):\n        return {}\n";

#[test]
fn dispatch_missing_method_detection() {
    let out = run(json!({
        "file": "/w/impl.py",
        "sources": {"/w/impl.py": NO_IS_SAME_IMPL},
        "statuses": [{
            "name": "TalentTree",
            "implementedBy": "talent.TalentTreeImpl",
            "implFile": "/w/impl.py",
            "implLine": 7,
        }],
    }));
    let items = out["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["method"], json!("isSameType"));
    assert_eq!(items[0]["symbolName"], json!("TalentTreeImpl"));
    assert_eq!(items[0]["symbolLength"], json!(14));
    assert_eq!(items[0]["line"], json!(7));
    assert_eq!(items[0]["related"]["label"], json!("实现文件 impl.py"));
    assert_eq!(
        items[0]["message"],
        json!("user_type TalentTree 的实现 talent.TalentTreeImpl 缺契约方法 isSameType():类型判定失效(createObjFromDict 结果无法通过校验)——引擎 setImplModule 取不到该方法,装载实现模块必失败")
    );
}

#[test]
fn dispatch_all_present_zero_items() {
    let out = run(json!({
        "file": "/w/impl.py",
        "sources": {"/w/impl.py": COMPLETE_IMPL},
        "statuses": [{
            "name": "TalentTree",
            "implementedBy": "talent.TalentTreeImpl",
            "implFile": "/w/impl.py",
            "implLine": 1,
        }],
    }));
    assert_eq!(out["items"].as_array().unwrap().len(), 0);
    assert_eq!(out["probes"]["/w/impl.py"]["isSameType"], json!(true));
}

#[test]
fn dispatch_filters_to_target_file_and_silent_without_impl() {
    let out = run(json!({
        "file": "/w/impl.py",
        "sources": {"/w/impl.py": "", "/w/other.py": ""},
        "statuses": [
            {"name": "Bound", "implFile": "/w/impl.py", "implLine": 2},
            {"name": "Elsewhere", "implFile": "/w/other.py", "implLine": 1},
            {"name": "NoFile"},
        ],
    }));
    let items = out["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    for item in items {
        assert_eq!(item["typeName"], json!("Bound"));
        assert_eq!(item["line"], json!(2));
    }
}

#[test]
fn dispatch_probes_face_crlf_and_indent() {
    // CRLF 源 + tab 缩进:探测在行起点语义下命中
    let source = "class Impl:\r\n\tdef createObjFromDict(self, d):\r\n\t    pass\r\n";
    let out = run(json!({
        "file": "/w/impl.py",
        "sources": {"/w/impl.py": source},
        "statuses": [],
    }));
    assert_eq!(out["probes"]["/w/impl.py"]["createObjFromDict"], json!(true));
    assert_eq!(out["probes"]["/w/impl.py"]["isSameType"], json!(false));
    assert_eq!(out["items"].as_array().unwrap().len(), 0);
}

#[test]
fn dispatch_missing_source_probes_all_false() {
    let out = run(json!({
        "file": "/w/impl.py",
        "sources": {},
        "statuses": [{"name": "T", "implFile": "/w/impl.py", "implLine": 1}],
    }));
    let items = out["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["method"], json!("createObjFromDict"));
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
            json!({"method": "$/kode/python/userTypeContractTypo", "params": {}}),
        ),
    );
    match &out[0] {
        Outgoing::Response(response) => {
            assert!(response.error.is_some(), "unknown method must error");
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
}
