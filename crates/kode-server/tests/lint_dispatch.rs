//! `$/kode/lint/analyzeDef` 命令面门禁:经 `$/kode/rpc` 单臂 dispatch,
//! 入参 `{text, inheritedNames?}` → findings JSON(与 TS analyzeDefDocument
//! 输出形状一致)。验证:注册、典型含各类错误的 def 各规则命中、未知方法
//! 错误码、输入缺 text 的错误回退。

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

/// 经 `$/kode/rpc` 派发 `$/kode/lint/analyzeDef`,返回 findings 数组。
fn analyze(state: &mut ServerState, id: i64, params: serde_json::Value) -> Vec<serde_json::Value> {
    let out = handle_message(
        state,
        request(
            id,
            "$/kode/rpc",
            json!({"method": "$/kode/lint/analyzeDef", "params": params}),
        ),
    );
    let result = response_of(&out);
    let findings = result.get("findings").expect("findings key");
    serde_json::from_value(findings.clone()).expect("findings as array")
}

fn checks_of(findings: &[serde_json::Value]) -> Vec<String> {
    findings
        .iter()
        .map(|f| f.get("check").unwrap().as_str().unwrap().to_string())
        .collect()
}

/// 典型含各错误的 def:幻影类型、缺 Type、重复定义、未知 Flags/DetailLevel、
/// 受限名、Python 关键字、方法-属性同名。
/// 注:第二个 <hp>(CELL_PUBLIC)与第一个(ALL_CLIENTS)同 cell 域位 → 重复定义;
/// <weird> 的 NOT_A_FLAG 与 ULTRA 分别触发未知旗标/未知 DetailLevel。
const KITCHEN_SINK: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>BOOL</Type>\n\
\t\t\t<Flags>ALL_CLIENTS</Flags>\n\
\t\t</hp>\n\
\t\t<hp>\n\
\t\t\t<Type>UINT8</Type>\n\
\t\t\t<Flags>CELL_PUBLIC</Flags>\n\
\t\t</hp>\n\
\t\t<weird>\n\
\t\t\t<Type>UINT8</Type>\n\
\t\t\t<Flags>NOT_A_FLAG</Flags>\n\
\t\t\t<DetailLevel>ULTRA</DetailLevel>\n\
\t\t</weird>\n\
\t\t<position>\n\
\t\t\t<Type>VECTOR3</Type>\n\
\t\t\t<Flags>BASE</Flags>\n\
\t\t</position>\n\
\t\t<class>\n\
\t\t\t<Type>UINT8</Type>\n\
\t\t\t<Flags>BASE</Flags>\n\
\t\t</class>\n\
\t\t<orphan>\n\
\t\t\t<Flags>BASE</Flags>\n\
\t\t</orphan>\n\
\t</Properties>\n\
\t<BaseMethods>\n\
\t\t<hp>\n\
\t\t\t<Arg>INT8</Arg>\n\
\t\t</hp>\n\
\t\t<onTick>\n\
\t\t\t<Arg>UINT8</Arg>\n\
\t\t</onTick>\n\
\t</BaseMethods>\n\
</root>\n";

/// 命令面:典型含各错误 def → 各规则 findings 命中(至少覆盖关键 check)。
#[test]
fn analyze_def_reports_kitchen_sink_rules() {
    let mut state = ServerState::new();
    init(&mut state);
    let findings = analyze(
        &mut state,
        1,
        json!({"text": KITCHEN_SINK, "inheritedNames": {}}),
    );
    let checks = checks_of(&findings);
    // 规则命中(非穷举,只锁本 fixture 必然触发的)
    assert!(checks.contains(&"phantom-type".to_string()), "{checks:?}");
    assert!(checks.contains(&"missing-type".to_string()), "{checks:?}");
    assert!(
        checks.contains(&"duplicate-definition".to_string()),
        "{checks:?}"
    );
    assert!(
        checks.contains(&"unknown-flag-value".to_string()),
        "{checks:?}"
    );
    assert!(
        checks.contains(&"unknown-detail-level".to_string()),
        "{checks:?}"
    );
    assert!(
        checks.contains(&"engine-limited-name".to_string()),
        "{checks:?}"
    );
    assert!(
        checks.contains(&"invalid-identifier".to_string()),
        "{checks:?}"
    );
    assert!(
        checks.contains(&"method-property-collision".to_string()),
        "{checks:?}"
    );
    // 每条 finding 携带 TS analyzeDefDocument 同形字段
    for f in &findings {
        assert!(f.get("check").is_some(), "{f}");
        assert!(f.get("severity").is_some(), "{f}");
        assert!(f.get("message").is_some(), "{f}");
        assert!(f.get("line").is_some(), "{f}");
        assert!(f.get("offset").is_some(), "{f}");
        assert!(f.get("length").is_some(), "{f}");
    }
}

/// 干净 def → 空 findings(零误报)。
#[test]
fn analyze_def_clean_def_returns_empty() {
    let mut state = ServerState::new();
    init(&mut state);
    let clean = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>UINT32</Type>\n\
\t\t\t<Flags>BASE</Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    let findings = analyze(&mut state, 2, json!({"text": clean}));
    assert!(findings.is_empty(), "{findings:?}");
}

/// 未注册方法 → -32601(与其它 RPC 未知方法同码)。
#[test]
fn unknown_lint_method_is_method_not_found() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(3, "$/kode/rpc", json!({"method": "$/kode/lint/nope"})),
    );
    assert_eq!(error_code_of(&out), error_codes::METHOD_NOT_FOUND);
}

/// 缺 text 入参 → handler Err → -32602(TS 兜底路径)。
#[test]
fn analyze_def_missing_text_is_invalid_params() {
    let mut state = ServerState::new();
    init(&mut state);
    let out = handle_message(
        &mut state,
        request(4, "$/kode/rpc", json!({"method": "$/kode/lint/analyzeDef"})),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

/// inheritedNames 经 JSON 传入驱动 inherited-name-collision:属性与祖先方法
/// 同名(全局拒绝)→ error。
#[test]
fn analyze_def_inherited_name_collision_fires() {
    let mut state = ServerState::new();
    init(&mut state);
    let text = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>UINT32</Type>\n\
\t\t\t<Flags>BASE</Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    let inherited = json!({
        "hp": {
            "propertyDomains": [],
            "componentDomains": [],
            "methodSections": ["base"],
            "propertySources": [],
            "componentSources": [],
            "methodSources": ["Base.def"]
        }
    });
    let findings = analyze(
        &mut state,
        5,
        json!({"text": text, "inheritedNames": inherited}),
    );
    let checks = checks_of(&findings);
    assert!(
        checks.contains(&"inherited-name-collision".to_string()),
        "{checks:?}"
    );
}

/// 已注册方法列表包含 lint 命令(ServerState 装配;健康/对账面)。
#[test]
fn registry_lists_lint_method() {
    let state = ServerState::new();
    assert!(state.rpc.methods().any(|m| m == "$/kode/lint/analyzeDef"));
}
