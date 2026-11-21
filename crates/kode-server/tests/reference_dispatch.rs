//! textDocument/references LSP 级门禁(RUST-138 批 3 接线):能力协商、
//! 语料双档联动(父类 def 必须也入库才有声明位)、includeDeclaration 真支配、
//! types.xml 面无声明位、未打开/内建/不可解析/null 分面、非法参数。
//!
//! 位置面口径 = references.rs 批 1 与 TS provideDefSymbolReferences /
//! provideTypesXmlReferences 的同构:站点位 (uri,line,start) 零宽区间、
//! 声明位=types 行首 / def 文件首行、声明先行 + 站点序 + 双键 dedup。

use serde_json::json;

use kode_protocol::{error_codes, IncomingMessage, Notification, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

fn request(id: i64, method: &str, params: serde_json::Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn notification(method: &str, params: serde_json::Value) -> IncomingMessage {
    IncomingMessage::Notification(Notification {
        jsonrpc: "2.0".into(),
        method: method.into(),
        params: Some(params),
    })
}

fn initialize_message(id: i64) -> IncomingMessage {
    request(
        id,
        "initialize",
        json!({
            "processId": 1234,
            "rootUri": "file:///workspace/demo",
            "capabilities": {}
        }),
    )
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

const AVATAR_URI: &str = "file:///workspace/demo/scripts/entity_defs/Avatar.def";
const MONSTER_URI: &str = "file:///workspace/demo/scripts/entity_defs/Monster.def";
const TYPES_URI: &str = "file:///workspace/demo/scripts/entity_defs/types.xml";
const ENTITIES_URI: &str = "file:///workspace/demo/scripts/entities.xml";

/// 语料父类 def:Parent 目标解析出的声明落点(文件首行)。
const MONSTER_DEF: &str = "<root>\n\
\t<Parent> Account </Parent>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

/// 查询方:Parent 值 Monster(第 1 行,名字起于列 10)+ Type 值 Weapon
/// (第 7 行,名字起于列 12)+ 内建 UINT32(无引用面)+ 不可解析父类。
const AVATAR_DEF: &str = "<root>\n\
\t<Parent> Monster </Parent>\n\
\t<Interfaces>\n\
\t\t<interface>movable</interface>\n\
\t</Interfaces>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> Weapon </Type>\n\
\t\t</hp>\n\
\t\t<score>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</score>\n\
\t</Properties>\n\
\t<Parent> NoSuchEntity </Parent>\n\
</root>\n";

/// 自定义类型注册表:Weapon 是 types.xml 符号(内建类型不是)。
const TYPES_XML: &str = "<root>\n\
\t<Weapon> STRING </Weapon>\n\
</root>\n";

fn open_doc(state: &mut ServerState, uri: &str, language_id: &str, text: &str) {
    let out = handle_message(
        state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": 1,
                    "text": text
                }
            }),
        ),
    );
    assert!(out.is_empty());
}

/// 打开整份语料:父类 def + 查询方 def + 类型注册表 + 实体注册。
/// entities.xml 必须入库——defs_root 靠它登记 entities 目录,
/// 缺它 Parent 目标解析不出声明落点(hover.rs:691 注册条件)。
fn open_corpus(state: &mut ServerState) {
    open_doc(
        state,
        ENTITIES_URI,
        "xml",
        "<root>\n  <Monster/>\n</root>\n",
    );
    open_doc(state, MONSTER_URI, "kbengine-def", MONSTER_DEF);
    open_doc(state, TYPES_URI, "xml", TYPES_XML);
    open_doc(state, AVATAR_URI, "kbengine-def", AVATAR_DEF);
}

fn reference_result(
    state: &mut ServerState,
    id: i64,
    uri: &str,
    line: u32,
    character: u32,
    include_declaration: Option<bool>,
) -> serde_json::Value {
    let mut params = json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character }
    });
    if let Some(flag) = include_declaration {
        params["context"] = json!({ "includeDeclaration": flag });
    }
    let out = handle_message(state, request(id, "textDocument/references", params));
    response_of(&out).clone()
}

#[test]
fn initialize_advertises_references_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    assert_eq!(
        response_of(&out)["capabilities"]["referencesProvider"],
        json!(true)
    );
}

#[test]
fn references_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            7,
            "textDocument/references",
            json!({
                "textDocument": { "uri": AVATAR_URI },
                "position": { "line": 1, "character": 10 }
            }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

#[test]
fn references_on_parent_value_returns_declaration_then_sites() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    let result = reference_result(&mut state, 8, AVATAR_URI, 1, 10, Some(true));
    assert!(result.is_array(), "{result}");
    let locations = result.as_array().unwrap();
    // 声明先行(Monster.def 文件首行零宽)+ 站点(Avatar 自身 Parent 值)。
    assert_eq!(locations.len(), 2, "{result}");
    assert_eq!(
        locations[0]["uri"],
        json!("/workspace/demo/scripts/entity_defs/Monster.def")
    );
    assert_eq!(
        locations[0]["range"],
        json!({"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}})
    );
    assert_eq!(
        locations[1]["uri"],
        json!("/workspace/demo/scripts/entity_defs/Avatar.def")
    );
    assert_eq!(
        locations[1]["range"]["start"],
        json!({"line": 1, "character": 10})
    );
    // 站点是零宽位置面(TS new vscode.Position(line, start) 同形)。
    assert_eq!(locations[1]["range"]["start"], locations[1]["range"]["end"]);
}

#[test]
fn references_omits_declaration_without_include_declaration() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    // 缺省 context(客户端可只送文档+位置)= 不含声明,与显式 false 同形。
    let without = reference_result(&mut state, 9, AVATAR_URI, 1, 10, None);
    let explicit_false = reference_result(&mut state, 10, AVATAR_URI, 1, 10, Some(false));
    assert_eq!(without, explicit_false, "{without} vs {explicit_false}");
    let sites = without.as_array().unwrap();
    assert_eq!(sites.len(), 1, "{without}");
    assert_eq!(
        sites[0]["uri"],
        json!("/workspace/demo/scripts/entity_defs/Avatar.def")
    );
}

#[test]
fn references_on_custom_type_value_includes_types_declaration() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    let result = reference_result(&mut state, 11, AVATAR_URI, 7, 10, Some(true));
    let locations = result.as_array().unwrap();
    // 声明 = types.xml 该类型名所在行行首;站点 = def 内 <Type> 值。
    assert!(
        locations
            .iter()
            .any(|l| l["uri"] == json!("/workspace/demo/scripts/entity_defs/types.xml")),
        "{result}"
    );
    assert!(
        locations
            .iter()
            .any(|l| l["uri"] == json!("/workspace/demo/scripts/entity_defs/Avatar.def")),
        "{result}"
    );
}

#[test]
fn references_on_builtin_type_returns_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    // 内建类型 UINT32 无引用面(TS builtIns 同拒),不是空集。
    let result = reference_result(&mut state, 12, AVATAR_URI, 9, 10, Some(true));
    assert_eq!(result, serde_json::Value::Null);
}

#[test]
fn references_on_unresolvable_parent_returns_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    // NoSuchEntity 不在语料 → 目标不可解析(null,不虚构)。
    let result = reference_result(&mut state, 13, AVATAR_URI, 13, 10, Some(true));
    assert_eq!(result, serde_json::Value::Null);
}

#[test]
fn references_on_types_xml_symbol_lists_corpus_sites_without_declaration() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    // types.xml 面:全语料 <Type>/<Arg>/<of> 值位,恒无声明位(includeDeclaration
    // 不生效)——显式 true 也只得站点,不多出 types.xml 自身。
    let result = reference_result(&mut state, 14, TYPES_URI, 1, 2, Some(true));
    let locations = result.as_array().unwrap();
    assert_eq!(locations.len(), 1, "{result}");
    assert_eq!(
        locations[0]["uri"],
        json!("/workspace/demo/scripts/entity_defs/Avatar.def")
    );
    assert_eq!(
        locations[0]["range"]["start"],
        json!({"line": 7, "character": 10})
    );
}

#[test]
fn references_on_python_document_returns_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    open_doc(
        &mut state,
        "file:///workspace/demo/scripts/cell/Monster.py",
        "python",
        "class Monster:\n    pass\n",
    );
    // 诚实边界:Python 文档无 Rust 引用面(属性/调用点面归 TS entityMapping)。
    let result = reference_result(
        &mut state,
        15,
        "file:///workspace/demo/scripts/cell/Monster.py",
        0,
        6,
        Some(true),
    );
    assert_eq!(result, serde_json::Value::Null);
}

#[test]
fn references_on_unopened_document_returns_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let result = reference_result(
        &mut state,
        16,
        "file:///workspace/demo/scripts/entity_defs/Missing.def",
        1,
        10,
        Some(true),
    );
    assert_eq!(result, serde_json::Value::Null);
}

#[test]
fn references_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(17, "textDocument/references", json!({ "textDocument": 42 })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn references_after_did_close_reverts_to_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    let before = reference_result(&mut state, 18, AVATAR_URI, 1, 10, Some(true));
    assert!(before.is_array());
    let _ = handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": AVATAR_URI } }),
        ),
    );
    let after = reference_result(&mut state, 19, AVATAR_URI, 1, 10, Some(true));
    assert_eq!(after, serde_json::Value::Null);
}

#[test]
fn references_on_interface_word_excludes_dangling_site() {
    // RUST-138 批 4(2026-11-21 用户拍板「先切 Rust」):语义过滤面分歧行为钉。
    // `movable` 是 Avatar.def 的接口 wrapper 目标,但语料无 interfaces/movable.def
    // ——站点域声明路径 None = Dangling,语义面剔除;includeDeclaration 也只
    // 前置声明位而该查询声明本身 None,故两个取值都空集 → null。位置面(旧)则
    // 会照列该站点(数组 len 1),正是本批切换消灭的同名语法噪声。
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_corpus(&mut state);
    let result = reference_result(&mut state, 20, AVATAR_URI, 3, 15, Some(false));
    assert_eq!(result, serde_json::Value::Null, "{result}");
    let with_decl = reference_result(&mut state, 21, AVATAR_URI, 3, 15, Some(true));
    assert_eq!(with_decl, serde_json::Value::Null, "{with_decl}");
}
