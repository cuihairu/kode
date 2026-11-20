//! textDocument/rename + prepareRename LSP 级门禁(RUST-141 批 2 接线):
//! 能力协商、prepareRename 候选区间、目标+后代 def 编辑双文件、同文件冲突
//! (NAV-008)与闭包冲突(AUD-061)的面、打开缓冲区优先于盘读(overlay 语义)、
//! 非法参数/未开档。
//!
//! 决策核零改(def_rename.rs 批 1 纯库);本批只钉服务面形状:冲突位不阻塞
//! 应答(三键 {conflict, closureConflict, fileEdits} 由调用方决定抛错文案),
//! 编辑位为 LSP (line,character) 区间、各行按文件自身文本换算。

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

const HERO_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t\t<mp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</mp>\n\
\t</Properties>\n\
\t<CellMethods>\n\
\t\t<onCellCreate>\n\
\t\t\t<Arg> UINT32 </Arg>\n\
\t\t</onCellCreate>\n\
\t</CellMethods>\n\
</root>\n";

/// 后代 def(Parent Hero)复述同名属性 hp——重命名闭包编辑要进这份文件。
const MONSTER_DEF: &str = "<root>\n\
\t<Parent> Hero </Parent>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

/// 闭包冲突fixture:后代占名 vigor 且域位相交(属性判重按域位,无
/// `<Flags>` 域位空集恒不相交——engine 判重矩阵 defAnalyzer 同语义)。
const MONSTER_DEF_VIGOR: &str = "<root>\n\
\t<Parent> Hero </Parent>\n\
\t<Properties>\n\
\t\t<vigor>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</vigor>\n\
\t</Properties>\n\
</root>\n";

/// 盘上版本与 overlay 差一行(hp 在盘上 0 基第 3 行,overlay 第 4 行)——
/// 钉「打开缓冲区优先于盘读」:编辑位按 overlay 行换算才是正确语义。
const MONSTER_DEF_OVERLAY: &str = "<root>\n\
\t<Parent> Hero </Parent>\n\
\t<!-- overlay only comment line -->\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

/// 临时工作区:scripts/entities.xml(向上走查的登记锚)+ entity_defs 两档。
/// 返回 (root_path, hero_uri, monster_uri);entities.xml 必须在盘——闭包
/// 发现靠 find_entity_defs_root_from_file 向上走查它(与 references 的
/// entities_dirs 登记是两条独立链)。
fn make_workspace() -> (String, String, String) {
    // 并行测试各用独立目录(共享目录会让 cleanup 删掉别人正在走查的盘面)。
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "kode-rename-dispatch-{}-{}",
        std::process::id(),
        seq
    ));
    let defs_dir = root.join("scripts/entity_defs");
    std::fs::create_dir_all(&defs_dir).expect("create defs dir");
    std::fs::write(root.join("scripts/entities.xml"), "<root/>\n").expect("write entities.xml");
    std::fs::write(defs_dir.join("Hero.def"), HERO_DEF).expect("write Hero.def");
    std::fs::write(defs_dir.join("Monster.def"), MONSTER_DEF).expect("write Monster.def");
    let root_str = root.to_string_lossy().to_string();
    (
        format!("file://{}", root_str),
        format!("file://{}/scripts/entity_defs/Hero.def", root_str),
        format!("file://{}/scripts/entity_defs/Monster.def", root_str),
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

fn open_doc(state: &mut ServerState, uri: &str, text: &str) {
    let out = handle_message(
        state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": "kbengine-def",
                    "version": 1,
                    "text": text
                }
            }),
        ),
    );
    assert!(out.is_empty());
}

fn prepare_request(
    state: &mut ServerState,
    id: i64,
    uri: &str,
    line: u32,
    character: u32,
) -> serde_json::Value {
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/prepareRename",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character }
            }),
        ),
    );
    response_of(&out).clone()
}

fn rename_request(
    state: &mut ServerState,
    id: i64,
    uri: &str,
    line: u32,
    character: u32,
    new_name: &str,
) -> serde_json::Value {
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/rename",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character },
                "newName": new_name
            }),
        ),
    );
    response_of(&out).clone()
}

#[test]
fn initialize_advertises_rename_provider() {
    let (root_uri, _hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1, &root_uri));
    assert_eq!(
        response_of(&out)["capabilities"]["renameProvider"],
        json!(true)
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn prepare_rename_on_property_returns_range_and_placeholder() {
    let (root_uri, hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    open_doc(&mut state, &hero, HERO_DEF);
    let result = prepare_request(&mut state, 2, &hero, 2, 3);
    assert_eq!(result["placeholder"], json!("hp"), "{result}");
    // 候选区间 = 开标签名字跨度(`\t\t<hp>` 里 < 占 char 2,名字 3..5)。
    assert_eq!(
        result["range"],
        json!({
            "start": {"line": 2, "character": 3},
            "end": {"line": 2, "character": 5}
        }),
        "{result}"
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn prepare_rename_off_symbol_returns_null() {
    let (root_uri, hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    open_doc(&mut state, &hero, HERO_DEF);
    // 光标在 <Type> 值(非符号元素名)→ null。
    let result = prepare_request(&mut state, 3, &hero, 3, 14);
    assert_eq!(result, serde_json::Value::Null);
    cleanup_workspace(&root_uri);
}

#[test]
fn rename_before_initialize_is_rejected() {
    let (root_uri, hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            4,
            "textDocument/rename",
            json!({
                "textDocument": { "uri": hero },
                "position": { "line": 2, "character": 3 },
                "newName": "vigor"
            }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
    cleanup_workspace(&root_uri);
}

#[test]
fn rename_returns_target_and_descendant_edits() {
    let (root_uri, hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    open_doc(&mut state, &hero, HERO_DEF);
    let result = rename_request(&mut state, 5, &hero, 2, 3, "vigor");
    assert_eq!(result["conflict"], serde_json::Value::Null, "{result}");
    assert_eq!(
        result["closureConflict"],
        serde_json::Value::Null,
        "{result}"
    );
    let files = result["fileEdits"].as_array().expect("fileEdits array");
    // 目标 + 后代(Parent Hero 复述 hp)双文件,按路径升序。
    assert_eq!(files.len(), 2, "{result}");
    assert!(
        files[0]["filePath"].as_str().unwrap().ends_with("Hero.def"),
        "{result}"
    );
    assert!(
        files[1]["filePath"]
            .as_str()
            .unwrap()
            .ends_with("Monster.def"),
        "{result}"
    );
    // 目标文件:开标签名 + 闭标签名两处(名字跨度 3..5 / 4..6)。
    let hero_edits = files[0]["edits"].as_array().unwrap();
    assert_eq!(hero_edits.len(), 2, "{result}");
    assert_eq!(
        hero_edits[0],
        json!({"start": {"line": 2, "character": 3}, "end": {"line": 2, "character": 5}})
    );
    assert_eq!(
        hero_edits[1],
        json!({"start": {"line": 5, "character": 4}, "end": {"line": 5, "character": 6}})
    );
    // 后代文件:同名复述两处。
    let monster_edits = files[1]["edits"].as_array().unwrap();
    assert_eq!(monster_edits.len(), 2, "{result}");
    assert_eq!(
        monster_edits[0],
        json!({"start": {"line": 3, "character": 3}, "end": {"line": 3, "character": 5}})
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn rename_in_file_conflict_reports_conflict_not_edits() {
    let (root_uri, hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    open_doc(&mut state, &hero, HERO_DEF);
    // hp→mp:同段(Properties)占名 → conflict 面(行 1 基),fileEdits 空。
    let result = rename_request(&mut state, 6, &hero, 2, 3, "mp");
    assert_eq!(
        result["conflict"]["surface"],
        json!("Properties"),
        "{result}"
    );
    assert_eq!(result["conflict"]["name"], json!("mp"), "{result}");
    assert_eq!(result["conflict"]["line"], json!(7), "{result}");
    assert_eq!(
        result["fileEdits"],
        serde_json::Value::Array(vec![]),
        "{result}"
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn rename_closure_conflict_reports_closure_conflict() {
    let (root_uri, hero, monster) = make_workspace();
    // 盘上 Monster 改为占名 vigor(闭包预检读盘)。
    let monster_path = monster.strip_prefix("file://").expect("monster uri");
    std::fs::write(monster_path, MONSTER_DEF_VIGOR).expect("rewrite Monster.def");
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    open_doc(&mut state, &hero, HERO_DEF);
    let result = rename_request(&mut state, 7, &hero, 2, 3, "vigor");
    let closure = &result["closureConflict"];
    assert_eq!(closure["surface"], json!("Properties"), "{result}");
    assert_eq!(closure["name"], json!("vigor"), "{result}");
    assert!(
        closure["filePath"]
            .as_str()
            .unwrap()
            .ends_with("Monster.def"),
        "{result}"
    );
    assert_eq!(
        result["fileEdits"],
        serde_json::Value::Array(vec![]),
        "{result}"
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn rename_prefers_open_buffer_over_disk() {
    let (root_uri, hero, monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    open_doc(&mut state, &hero, HERO_DEF);
    // Monster.def 打开版多一行注释(hp 在 overlay 第 4 行,盘上第 3 行)——
    // 编辑位必须按 overlay 换算(打开缓冲区优先)。
    open_doc(&mut state, &monster, MONSTER_DEF_OVERLAY);
    let result = rename_request(&mut state, 8, &hero, 2, 3, "vigor");
    let files = result["fileEdits"].as_array().expect("fileEdits array");
    assert_eq!(files.len(), 2, "{result}");
    let monster_edits = if files[1]["filePath"]
        .as_str()
        .unwrap()
        .ends_with("Monster.def")
    {
        &files[1]
    } else {
        &files[0]
    };
    let edits = monster_edits["edits"].as_array().unwrap();
    assert_eq!(
        edits[0],
        json!({"start": {"line": 4, "character": 3}, "end": {"line": 4, "character": 5}}),
        "{result}"
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn rename_on_unopened_document_returns_null() {
    let (root_uri, hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    let missing = format!("{}.missing", hero);
    let result = rename_request(&mut state, 9, &missing, 2, 3, "vigor");
    assert_eq!(result, serde_json::Value::Null);
    cleanup_workspace(&root_uri);
}

#[test]
fn rename_with_invalid_params_is_invalid_request() {
    let (root_uri, _hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    let out = handle_message(
        &mut state,
        request(10, "textDocument/rename", json!({ "textDocument": 42 })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
    cleanup_workspace(&root_uri);
}

#[test]
fn prepare_rename_with_invalid_params_is_invalid_request() {
    let (root_uri, _hero, _monster) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    let out = handle_message(
        &mut state,
        request(
            11,
            "textDocument/prepareRename",
            json!({ "textDocument": 42 }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
    cleanup_workspace(&root_uri);
}
