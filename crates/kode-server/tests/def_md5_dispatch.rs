//! `$/kode/def/md5` RPC dispatch 烟测:走完整 `$/kode/rpc` 链路,镜像 TS
//! `computeDefMd5InRust` 的参数形态,验证 md5Hex/streamHex 输出与畸形入参
//! 的 error 通道。

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

fn call_md5(params: Value) -> Value {
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
            json!({"method": "$/kode/def/md5", "params": params}),
        ),
    );
    response_of(&out).clone()
}

#[test]
fn dispatch_minimal_anchor() {
    let r = call_md5(json!({
        "typesXml": "<root></root>",
        "entitiesXml": "<root><Gate hasCell=\"true\"></Gate></root>",
        "defs": {"Gate": "<root>\
            <Properties><level><Type> UINT32 </Type><Flags> BASE </Flags>\
            <Persistent> true </Persistent></level></Properties>\
            <CellMethods><respawn></respawn></CellMethods>\
            <BaseMethods><reqUpgrade><Exposed> true </Exposed>\
            <Arg> UINT32 </Arg></reqUpgrade></BaseMethods>\
            <ClientMethods><onLevelUp><Arg> UINT32 </Arg></onLevelUp></ClientMethods>\
            </root>"},
        "aliasXml": "",
        "componentScripts": []
    }));
    let md5 = r["md5"].as_str().expect("md5");
    assert_eq!(md5.len(), 32);
    assert!(md5
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
    // 与 frozen golden 的最小锚点一致(规范推导锚点)。
    let golden = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .unwrap()
            .join("crates/kode-server/tests/golden/def-md5-parity.json"),
    )
    .expect("golden");
    let golden: Value = serde_json::from_str(&golden).expect("golden json");
    let anchor = golden["samples"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "minimal-single-entity")
        .expect("anchor");
    assert_eq!(md5, anchor["md5"].as_str().unwrap());
    assert_eq!(
        r["streamHex"].as_str().unwrap(),
        anchor["streamHex"].as_str().unwrap()
    );
    assert!(!r["trace"].as_array().unwrap().is_empty());
}

#[test]
fn dispatch_defs_nonstring_entry_skipped() {
    // defs 值非字符串(数字)→ 该条目跳过(mod.rs:1178-1180);componentScripts
    // 含非字符串元素 → 只留字符串条目(mod.rs:1191-1193)。
    let r = call_md5(json!({
        "typesXml": "<root></root>",
        "entitiesXml": "<root><Gate hasCell=\"true\"></Gate></root>",
        "defs": {"Gate": "<root></root>", "Skip": 123},
        "aliasXml": "",
        "componentScripts": ["cell:Gate", 7, null, true]
    }));
    let md5 = r["md5"].as_str().expect("md5");
    assert_eq!(md5.len(), 32);
    assert!(
        md5.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()),
        "非字符串 defs 值被跳过,不 panic"
    );
}

#[test]
fn dispatch_defs_non_object_and_scripts_non_array() {
    // defs 非对象 → 整体跳过;componentScripts 非数组 → 整体跳过;空 entities
    // → Ok(仅 phase1 内建序列)。
    let r = call_md5(json!({
        "typesXml": "",
        "entitiesXml": "",
        "defs": 123,
        "aliasXml": "",
        "componentScripts": "cell:Gate"
    }));
    let md5 = r["md5"].as_str().expect("md5");
    assert_eq!(md5.len(), 32);
    let stream = r["streamHex"].as_str().expect("streamHex");
    // phase1 恰为 21 内建 uid 序列(u16 LE)。
    let mut expect = String::new();
    for i in 1..=21u16 {
        expect.push_str(&format!("{:02x}{:02x}", i & 0xff, i >> 8));
    }
    assert_eq!(stream, expect, "非对象参数回落 phase1");
}

#[test]
fn dispatch_error_channel() {
    // 缺 def → error 经 RPC error 返回,不 panic。
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
            json!({"method": "$/kode/def/md5", "params": {
                "typesXml": "<root></root>",
                "entitiesXml": "<root><Ghost hasCell=\"true\"></Ghost></root>",
                "defs": {},
                "aliasXml": "",
                "componentScripts": []
            }}),
        ),
    );
    match &out[0] {
        Outgoing::Response(response) => {
            assert!(response.error.is_some(), "缺 def 应返回 error");
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
}
