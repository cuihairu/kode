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
    handle_message(state, request(0, "initialize", json!({"capabilities": {}})));
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
        request(
            3,
            "$/kode/rpc",
            json!({"method": "$/kode/nope", "params": {}}),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::METHOD_NOT_FOUND);
}

/// 未 initialize 先调 → -32002(与其它请求同门)。
#[test]
fn rpc_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            4,
            "$/kode/rpc",
            json!({"method": "$/kode/echo", "params": {}}),
        ),
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

/// KODE-CFG-005 `$/kode/config/derive`:def 扫描根按配置路径事实派生
/// (`{assets}/res/server/kbengine.xml` → `{assets}/scripts`,CFG-004 链)。
#[test]
fn config_derive_dispatch_def_scan_root_from_path() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(
            5,
            "$/kode/rpc",
            json!({
                "method": "$/kode/config/derive",
                "params": {
                    "tree": null,
                    "defaultsTree": null,
                    "facts": {
                        "workspaceRoot": "/ws",
                        "customConfigPath": "/proj/assets/res/server/kbengine.xml",
                        "entryScripts": []
                    }
                }
            }),
        ),
    );
    assert_eq!(
        response_of(&out)["derive"]["defScanRoots"],
        json!({"roots": ["/proj/assets/scripts"], "fallback": null, "degraded": false})
    );
}

/// 配置路径无 `res` 锚点 → degraded + fallback=workspaceRoot + 诊断条
/// (TS 侧回退旧链,不崩)。
#[test]
fn config_derive_dispatch_degraded_diagnostics() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(
            6,
            "$/kode/rpc",
            json!({
                "method": "$/kode/config/derive",
                "params": {
                    "tree": null,
                    "defaultsTree": null,
                    "facts": {
                        "workspaceRoot": "/ws",
                        "customConfigPath": "/proj/kbengine.xml",
                        "entryScripts": []
                    }
                }
            }),
        ),
    );
    let body = response_of(&out);
    assert_eq!(
        body["derive"]["defScanRoots"],
        json!({"roots": ["/ws"], "fallback": "workspaceRoot", "degraded": true})
    );
    assert!(
        body["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["scope"] == "defScanRoots" && d["severity"] == "warning"),
        "降级应产出 defScanRoots 诊断条"
    );
}

/// 树经 JSON 反序列化进派生(telnet 开关面);树形态非法 → Err(不 panic,
/// TS 回退)。
#[test]
fn config_derive_dispatch_parses_tree_and_rejects_bad_shape() {
    let mut state = ServerState::new();
    init(&mut state);

    // 自定义树含顶层 telnet_service → telnet enabled。
    let out = handle_message(
        &mut state,
        request(
            7,
            "$/kode/rpc",
            json!({
                "method": "$/kode/config/derive",
                "params": {
                    "tree": {"name": "", "text": "", "children": [
                        {"name": "telnet_service", "text": "", "children": [
                            {"name": "port", "text": "40009", "children": []},
                            {"name": "password", "text": "pw", "children": []}
                        ]}
                    ], "sourceComments": []},
                    "defaultsTree": null,
                    "facts": {"workspaceRoot": "/ws", "customConfigPath": null, "entryScripts": []}
                }
            }),
        ),
    );
    assert_eq!(response_of(&out)["derive"]["telnet"]["enabled"], true);
    assert_eq!(
        response_of(&out)["derive"]["telnet"]["endpoints"][0]["port"],
        json!(40009)
    );

    // 树非对象 → Err,dispatch 不 panic。
    let out = handle_message(
        &mut state,
        request(
            8,
            "$/kode/rpc",
            json!({
                "method": "$/kode/config/derive",
                "params": {
                    "tree": "not-an-object",
                    "defaultsTree": null,
                    "facts": {"workspaceRoot": "/ws", "customConfigPath": null, "entryScripts": []}
                }
            }),
        ),
    );
    let err = match &out[0] {
        Outgoing::Response(r) => r.error.as_ref().expect("应返回错误"),
        Outgoing::Notification(_) => panic!("expected response"),
    };
    assert!(
        err.message.contains("应为对象"),
        "错误文案: {}",
        err.message
    );
}

/// KODE-CFG-009 `$/kode/config/resolve`:defaults/custom 原文 → core 解析
/// +合并 +telnet 速览 +数据库连接要素一次出全(TS 消费通道唯一取数口)。
#[test]
fn config_resolve_dispatch_parses_merges_and_reads_values() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(
            9,
            "$/kode/rpc",
            json!({
                "method": "$/kode/config/resolve",
                "params": {
                    "defaultsXml": "<root><loginapp><telnet_service><port> 31000 </port><password> defpwd </password></telnet_service></loginapp><baseapp><telnet_service><port> 40000 </port></telnet_service></baseapp></root>",
                    "customXml": "<loginapp><telnet_service><port> 31001 </port><password> custompwd </password></telnet_service></loginapp>"
                }
            }),
        ),
    );
    let body = response_of(&out);
    // 双树与合成树都在(树形与 derive 入参同构)
    assert!(body["defaultsTree"].is_object());
    assert!(body["customTree"].is_object());
    assert!(body["merged"].is_object());
    // telnet 速览:引擎写死表序 7 组件,custom 覆盖值优先
    let summary = body["telnetSummary"].as_array().unwrap();
    assert_eq!(summary.len(), 7);
    assert_eq!(summary[0]["component"], "loginapp");
    assert_eq!(summary[0]["port"], json!(31001));
    assert_eq!(summary[0]["password"], "custompwd");
    // 数据库连接要素:无 dbmgr 段 → null
    assert!(body["dbInterface"].is_null());
    // 元件 telnet_service 段读值(文档序首段):端口 + 密码
    let custom_telnet = &body["customTelnet"];
    assert_eq!(custom_telnet["port"], json!(31001));
    assert_eq!(custom_telnet["password"], "custompwd");
    // 引擎写死端口表(core 唯一真源)
    assert_eq!(body["telnetDefaultPorts"]["baseapp"], json!(40000));
    assert_eq!(body["telnetDefaultPorts"]["bots"], json!(51000));
}

/// 双侧都缺(null)→ 全空产物,不 panic;defaultsXml 非字符串 → Err。
#[test]
fn config_resolve_dispatch_handles_missing_and_bad_params() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(
            10,
            "$/kode/rpc",
            json!({
                "method": "$/kode/config/resolve",
                "params": {"defaultsXml": null, "customXml": null}
            }),
        ),
    );
    let body = response_of(&out);
    assert!(body["defaultsTree"].is_null());
    assert!(body["customTree"].is_null());
    assert!(body["merged"].is_null());
    assert_eq!(body["telnetSummary"], json!([]));
    assert!(body["dbInterface"].is_null());
    assert!(body["customTelnet"].is_null());
    assert_eq!(body["telnetDefaultPorts"]["loginapp"], json!(31000));

    let out = handle_message(
        &mut state,
        request(
            11,
            "$/kode/rpc",
            json!({
                "method": "$/kode/config/resolve",
                "params": {"defaultsXml": 123, "customXml": null}
            }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}
