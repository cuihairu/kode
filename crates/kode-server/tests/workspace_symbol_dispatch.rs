//! workspace/symbol LSP 级门禁(RUST-139 批 4 接线):能力协商、前缀检索
//! 正臂(属性/方法双 kind + 段注记 + 声明落点)、跨 def 继承折叠(owner 链
//! first-wins)、大小写不敏感、空查询全集、未知前缀空集(非 null)、
//! 初始化前拒绝、非法参数。
//!
//! 决策核零改(workspace_symbols.rs 批 2 纯库 + golden 双侧对拍在案);
//! 本批只钉服务面形状:{symbols:[WorkspaceSymbolHit...]}。

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

const ENTITIES_XML: &str = "<root/>\n";

/// Avatar:Properties(hp)+CellMethods(onTalk);Hero:Parent Avatar +
/// Properties(mana)+ClientMethods(onHello)——Hero 走父链折叠继承 hp/onTalk
/// (first-wins 不覆盖)。
const AVATAR_DEF: &str = "<Avatar>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
\t<CellMethods>\n\
\t\t<onTalk>\n\
\t\t\t<Arg> UINT32 </Arg>\n\
\t\t\t<Arg> STRING </Arg>\n\
\t\t</onTalk>\n\
\t</CellMethods>\n\
</Avatar>\n";

const HERO_DEF: &str = "<Hero>\n\
\t<Parent> Avatar </Parent>\n\
\t<Properties>\n\
\t\t<mana>\n\
\t\t\t<Type> FLOAT </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</mana>\n\
\t</Properties>\n\
\t<ClientMethods>\n\
\t\t<onHello>\n\
\t\t\t<Arg> UINT32 </Arg>\n\
\t\t</onHello>\n\
\t</ClientMethods>\n\
</Hero>\n";

/// 临时工作区:scripts/entities.xml(向上走查的登记锚)+ entity_defs 两档。
fn make_workspace() -> (String, String, String) {
    // 并行测试各用独立目录(共享目录会让 cleanup 删掉别人正在走查的盘面)。
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "kode-workspace-symbol-dispatch-{}-{}",
        std::process::id(),
        seq
    ));
    let defs_dir = root.join("scripts/entity_defs");
    std::fs::create_dir_all(&defs_dir).expect("create defs dir");
    std::fs::write(root.join("scripts/entities.xml"), ENTITIES_XML).expect("write entities.xml");
    std::fs::write(defs_dir.join("Avatar.def"), AVATAR_DEF).expect("write Avatar.def");
    std::fs::write(defs_dir.join("Hero.def"), HERO_DEF).expect("write Hero.def");
    let root_str = root.to_string_lossy().to_string();
    (
        format!("file://{}", root_str),
        format!("file://{}/scripts/entity_defs/Avatar.def", root_str),
        format!("file://{}/scripts/entity_defs/Hero.def", root_str),
    )
}

fn cleanup_workspace(root_uri: &str) {
    let path = root_uri.strip_prefix("file://").expect("root uri");
    let _ = std::fs::remove_dir_all(path);
}

fn initialize_message(id: i64, root_uri: &str) -> IncomingMessage {
    request(
        id,
        "initialize",
        json!({
            "processId": 1234,
            "rootUri": root_uri,
            "capabilities": {}
        }),
    )
}

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

/// 初始化 + 语料入库(defs_root 靠 entities.xml 入档定锚;检索 root 集靠
/// 两档 def 入 corpus_defs 视图)。
fn seed_workspace(state: &mut ServerState, root_uri: &str, avatar_uri: &str, hero_uri: &str) {
    handle_message(state, initialize_message(1, root_uri));
    let entities_uri = format!("{}/scripts/entities.xml", root_uri);
    open_doc(state, &entities_uri, "xml", ENTITIES_XML);
    open_doc(state, avatar_uri, "kbengine-def", AVATAR_DEF);
    open_doc(state, hero_uri, "kbengine-def", HERO_DEF);
}

fn workspace_symbol_request(state: &mut ServerState, id: i64, query: &str) -> serde_json::Value {
    let out = handle_message(
        state,
        request(id, "workspace/symbol", json!({ "query": query })),
    );
    response_of(&out).clone()
}

fn symbols_of(result: &serde_json::Value) -> &[serde_json::Value] {
    result["symbols"].as_array().expect("symbols array")
}

/// fixture 行号自推导(1 基),改 fixture 不漂。
fn def_line_of(text: &str, marker: &str) -> u32 {
    text.split('\n')
        .position(|line| line.trim_start().starts_with(marker))
        .expect("marker in fixture") as u32
        + 1
}

#[test]
fn initialize_advertises_workspace_symbol_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1, "file:///workspace/demo"));
    assert_eq!(
        response_of(&out)["capabilities"]["workspaceSymbolProvider"],
        json!(true)
    );
}

#[test]
fn workspace_symbol_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(7, "workspace/symbol", json!({"query": "hp"})),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

#[test]
fn workspace_symbol_prefix_returns_property_and_method_hits() {
    let (root_uri, avatar_uri, hero_uri) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_uri, &hero_uri);
    let result = workspace_symbol_request(&mut state, 8, "on");
    let symbols = symbols_of(&result);
    // "on" 命中 = onTalk(Avatar 自持 CellMethods)+ onHello(Hero 自持
    // ClientMethods)+ onTalk(Hero 经父链折叠继承,first-wins 不覆盖)= 3 条;
    // onHello 无子类继承,不存在第二份。排序 rootName→symbolName→line
    // 字节序:Avatar root 先于 Hero,同 root 内 onHello('H')<onTalk('T')。
    assert_eq!(symbols.len(), 3, "{result}");
    let names: Vec<&str> = symbols
        .iter()
        .map(|hit| hit["symbolName"].as_str().expect("name"))
        .collect();
    assert_eq!(names, vec!["onTalk", "onHello", "onTalk"], "{result}");

    // symbols[0] = Avatar 自持 onTalk。
    let avatar_talk = &symbols[0];
    assert_eq!(avatar_talk["kind"], json!("method"));
    assert_eq!(avatar_talk["section"], json!("CellMethods"));
    assert_eq!(avatar_talk["rootName"], json!("Avatar"));
    assert!(
        avatar_talk["defFile"]
            .as_str()
            .expect("defFile")
            .ends_with("/entity_defs/Avatar.def"),
        "{result}"
    );
    assert_eq!(
        avatar_talk["line"],
        json!(def_line_of(AVATAR_DEF, "<onTalk>"))
    );

    // symbols[1] = Hero 自持 onHello。
    let hero_hello = &symbols[1];
    assert_eq!(hero_hello["kind"], json!("method"));
    assert_eq!(hero_hello["section"], json!("ClientMethods"));
    assert_eq!(hero_hello["rootName"], json!("Hero"));
    assert!(
        hero_hello["defFile"]
            .as_str()
            .expect("defFile")
            .ends_with("/entity_defs/Hero.def"),
        "{result}"
    );
    assert_eq!(
        hero_hello["line"],
        json!(def_line_of(HERO_DEF, "<onHello>"))
    );

    // symbols[2] = Hero 经父链折叠继承 onTalk:落点指回声明档(Avatar.def),
    // rootDefFile 指回 root 实体档(Hero.def)。
    let hero_talk = &symbols[2];
    assert_eq!(hero_talk["kind"], json!("method"));
    assert_eq!(hero_talk["section"], json!("CellMethods"));
    assert_eq!(hero_talk["rootName"], json!("Hero"));
    assert!(
        hero_talk["defFile"]
            .as_str()
            .expect("defFile")
            .ends_with("/entity_defs/Avatar.def"),
        "{result}"
    );
    assert_eq!(
        hero_talk["line"],
        json!(def_line_of(AVATAR_DEF, "<onTalk>"))
    );
    assert!(
        hero_talk["rootDefFile"]
            .as_str()
            .expect("rootDefFile")
            .ends_with("/entity_defs/Hero.def"),
        "{result}"
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn workspace_symbol_property_hit_has_null_section() {
    let (root_uri, avatar_uri, hero_uri) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_uri, &hero_uri);
    let result = workspace_symbol_request(&mut state, 9, "hp");
    let symbols = symbols_of(&result);
    assert_eq!(symbols.len(), 2, "{result}");
    for hit in symbols {
        assert_eq!(hit["kind"], json!("property"), "{result}");
        assert_eq!(hit["section"], serde_json::Value::Null, "{result}");
        assert_eq!(hit["symbolName"], json!("hp"), "{result}");
        assert_eq!(hit["line"], json!(def_line_of(AVATAR_DEF, "<hp>")));
    }
    // 两条 = Avatar 本域 + Hero 父链折叠(继承不复制 defFile:落点指回声明档)。
    let roots: Vec<&str> = symbols
        .iter()
        .map(|hit| hit["rootName"].as_str().expect("root"))
        .collect();
    assert_eq!(roots, vec!["Avatar", "Hero"], "{result}");
    assert!(
        symbols[1]["defFile"]
            .as_str()
            .expect("defFile")
            .ends_with("/entity_defs/Avatar.def"),
        "{result}"
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn workspace_symbol_matches_case_insensitively_and_trims() {
    let (root_uri, avatar_uri, hero_uri) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_uri, &hero_uri);
    let result = workspace_symbol_request(&mut state, 10, "  HP  ");
    let names: Vec<&str> = symbols_of(&result)
        .iter()
        .map(|hit| hit["symbolName"].as_str().expect("name"))
        .collect();
    assert_eq!(names, vec!["hp", "hp"], "{result}");
    cleanup_workspace(&root_uri);
}

#[test]
fn workspace_symbol_unknown_prefix_returns_empty_array_not_null() {
    let (root_uri, avatar_uri, hero_uri) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_uri, &hero_uri);
    let result = workspace_symbol_request(&mut state, 11, "zzz");
    assert_eq!(result, json!({ "symbols": [] }), "{result}");
    cleanup_workspace(&root_uri);
}

#[test]
fn workspace_symbol_empty_query_returns_full_set() {
    let (root_uri, avatar_uri, hero_uri) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_uri, &hero_uri);
    let result = workspace_symbol_request(&mut state, 12, "");
    let symbols = symbols_of(&result);
    // 全集:Avatar 本域 hp+onTalk;Hero 本域 mana+onHello + 父链折叠 hp+onTalk。
    assert_eq!(symbols.len(), 6, "{result}");
    let keys: Vec<String> = symbols
        .iter()
        .map(|hit| {
            format!(
                "{}/{}",
                hit["rootName"].as_str().expect("root"),
                hit["symbolName"].as_str().expect("name")
            )
        })
        .collect();
    assert_eq!(
        keys,
        vec![
            "Avatar/hp",
            "Avatar/onTalk",
            "Hero/hp",
            "Hero/mana",
            "Hero/onHello",
            "Hero/onTalk"
        ],
        "{result}"
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn workspace_symbol_invalid_params_is_rejected() {
    let (root_uri, avatar_uri, hero_uri) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_uri, &hero_uri);
    let out = handle_message(&mut state, request(13, "workspace/symbol", json!({})));
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
    let out = handle_message(
        &mut state,
        request(14, "workspace/symbol", json!({"query": 42})),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
    cleanup_workspace(&root_uri);
}
