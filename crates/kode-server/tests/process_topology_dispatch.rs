//! `$/kode/processTopology/validate` 全链派发测(C-17)。
//!
//! 走完整 `$/kode/rpc` → `$/kode/processTopology/validate` 链路,验证注册成功、
//! 输入契约(manifestText/entitiesXmlText/defs)与输出形状(findings 数组)。

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

fn rpc(params: Value) -> Value {
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
            json!({"method": "$/kode/processTopology/validate", "params": params}),
        ),
    );
    response_of(&out).clone()
}

const FIVE_PROCESS: &str = r#"<processTopology>
  <process name="machine_1" role="machine"><port>20099</port></process>
  <process name="dbmgr_1" role="dbmgr"><port>20000</port><dependsOn>machine_1</dependsOn></process>
  <process name="baseapp_1" role="baseapp"><port>20005</port><dependsOn>dbmgr_1</dependsOn></process>
  <process name="cellapp_1" role="cellapp"><port>20015</port><dependsOn>baseapp_1</dependsOn></process>
  <process name="loginapp_1" role="loginapp"><port>20013</port><dependsOn>baseapp_1</dependsOn></process>
</processTopology>"#;

const AVATAR_DEF: &str = r#"<root>
  <Properties>
    <name><Type>STRING</Type><Flags>BASE_AND_CLIENT</Flags><Persistent>true</Persistent></name>
  </Properties>
  <CellMethods><respawn></respawn></CellMethods>
  <BaseMethods><reqCastSkill></reqCastSkill></BaseMethods>
</root>"#;

#[test]
fn registered_and_returns_findings_array() {
    let result = rpc(json!({
        "manifestText": FIVE_PROCESS,
        "entitiesXmlText": r#"<root><Avatar hasBase="true" hasCell="true" hasClient="true"></Avatar></root>"#,
        "defs": [{
            "name": "Avatar",
            "category": "entity",
            "filePath": "/defs/entity_defs/Avatar.def",
            "text": AVATAR_DEF,
        }],
    }));
    let findings = result.get("findings").unwrap().as_array().unwrap();
    // 正确五进程拓扑 + Avatar(有 base/cell/persistent)+ dbmgr/baseapp/cellapp
    // 全在 → 零发现。
    assert!(
        findings.is_empty(),
        "expected zero findings, got {findings:#?}"
    );
}

#[test]
fn missing_cellapp_produces_warning() {
    let result = rpc(json!({
        "manifestText": FIVE_PROCESS.replace("<process name=\"cellapp_1\" role=\"cellapp\"><port>20015</port><dependsOn>baseapp_1</dependsOn></process>", ""),
        "entitiesXmlText": r#"<root><Avatar hasBase="true" hasCell="true" hasClient="true"></Avatar></root>"#,
        "defs": [{
            "name": "Avatar",
            "category": "entity",
            "filePath": "/defs/entity_defs/Avatar.def",
            "text": AVATAR_DEF,
        }],
    }));
    let findings = result.get("findings").unwrap().as_array().unwrap();
    let d1 = findings
        .iter()
        .find(|f| {
            f.get("code").and_then(|v| v.as_str()) == Some("kbengine.processTopologyMissingCellapp")
        })
        .expect("D1 finding");
    assert_eq!(d1.get("target").unwrap(), "def");
    assert_eq!(d1.get("line").unwrap(), 5); // CellMethods <respawn> 行(AVATAR_DEF 第 5 行)
    assert_eq!(d1.get("severity").unwrap(), 2);
    assert_eq!(d1.get("related").unwrap().as_array().unwrap().len(), 1);
}

#[test]
fn params_shape_contract_surfaces() {
    // defs 为空数组、entitiesXmlText 缺省 → 仍返回 findings 数组(不报错)。
    let result = rpc(json!({
        "manifestText": FIVE_PROCESS,
        "defs": [],
    }));
    let findings = result.get("findings").unwrap().as_array().unwrap();
    assert!(findings.is_empty());
}
