//! KBUG-ROOT 多工程根同名实体隔离:LSP 级门禁。
//! 缺陷(修前):实体名 → def 路径登记是**全局首见**单射,跨工程根借用:
//! A 根先入库 Avatar.def 后,B 根 entities.xml 上 F12/hover/补全全部指向
//! A 根路径。修复契约:def 候选按 DocumentKey.root 隔离,同根同名多候选
//! 歧义不硬猜(F12 → null,TS 面兜底),关闭只清本根候选。

use serde_json::json;

use kode_protocol::{IncomingMessage, Notification, Request, RequestId};
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

/// 根 A 走 initialize.rootUri;根 B 直接注册(register 幂等,initialize 再
/// 注册 A 不受影响)。
fn initialize_message(id: i64) -> IncomingMessage {
    request(
        id,
        "initialize",
        json!({
            "processId": 1234,
            "rootUri": "file:///workspace/a",
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

const AVATAR_DEF_A: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

const AVATAR_DEF_B: &str = "<root>\n\
\t<Properties>\n\
\t\t<mp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</mp>\n\
\t</Properties>\n\
</root>\n";

fn open_def(state: &mut ServerState, uri: &str, text: &str) {
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

fn open_entities(state: &mut ServerState, uri: &str) {
    let out = handle_message(
        state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": "xml",
                    "version": 1,
                    "text": "<root>\n  <Avatar/>\n</root>\n"
                }
            }),
        ),
    );
    assert!(out.is_empty());
}

fn definition_request(state: &mut ServerState, id: i64, entities_uri: &str) -> serde_json::Value {
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/definition",
            json!({
                "textDocument": { "uri": entities_uri },
                "position": { "line": 1, "character": 3 }
            }),
        ),
    );
    response_of(&out).clone()
}

fn hover_markdown(state: &mut ServerState, id: i64, entities_uri: &str) -> String {
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": entities_uri },
                "position": { "line": 1, "character": 3 }
            }),
        ),
    );
    response_of(&out)["contents"]["value"]
        .as_str()
        .expect("hover markdown")
        .to_string()
}

fn completion_labels(state: &mut ServerState, id: i64, entities_uri: &str) -> Vec<(String, Option<String>)> {
    // 开标签位:第 2 行光标停在 `<` 之后(行前缀 `  <` → Entities 开标签上下文)。
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/completion",
            json!({
                "textDocument": { "uri": entities_uri },
                "position": { "line": 1, "character": 4 }
            }),
        ),
    );
    let items = response_of(&out)["items"].as_array().expect("items").clone();
    items
        .into_iter()
        .map(|item| {
            (
                item["label"].as_str().unwrap().to_string(),
                item["detail"].as_str().map(|d| d.to_string()),
            )
        })
        .collect()
}

const ENTITIES_A: &str = "file:///workspace/a/scripts/entities.xml";
const ENTITIES_B: &str = "file:///workspace/b/scripts/entities.xml";
const DEF_A: &str = "file:///workspace/a/scripts/entity_defs/Avatar.def";
const DEF_B: &str = "file:///workspace/b/scripts/entity_defs/Avatar.def";

/// KBUG-ROOT-06(生产装配面):initialize.workspaceFolders 逐个注册为资源根
/// —— 生产 TS 端经此携带多工作区,根归属不靠测试手工 register。
#[test]
fn kbug_root_workspace_folders_initialize_registers_roots() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            1,
            "initialize",
            json!({
                "processId": 1234,
                "workspaceFolders": [
                    { "uri": "file:///workspace/a", "name": "a" },
                    { "uri": "file:///workspace/b", "name": "b" }
                ],
                "capabilities": {}
            }),
        ),
    );
    assert!(matches!(out[0], Outgoing::Response(_)));
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_def(&mut state, DEF_B, AVATAR_DEF_B);
    open_entities(&mut state, ENTITIES_B);
    let result = definition_request(&mut state, 2, ENTITIES_B);
    assert_eq!(
        result["uri"],
        json!("/workspace/b/scripts/entity_defs/Avatar.def"),
        "workspaceFolders 未生效时两根同落 UNROOTED,同名歧义 → null(修前红): {result}"
    );
    open_entities(&mut state, ENTITIES_A);
    let result = definition_request(&mut state, 3, ENTITIES_A);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/scripts/entity_defs/Avatar.def"),
        "workspaceFolders 未生效时两根同落 UNROOTED,同名歧义 → null(修前红): {result}"
    );
}

#[test]
fn kbug_root_01_definition_lands_in_querying_root() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    state.roots.register("/workspace/b");
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_def(&mut state, DEF_B, AVATAR_DEF_B);
    open_entities(&mut state, ENTITIES_B);

    // B 根查询必须落 B 根的 Avatar.def(修前:全局首见 → A 根路径,红)。
    let result = definition_request(&mut state, 2, ENTITIES_B);
    assert_eq!(
        result["uri"],
        json!("/workspace/b/scripts/entity_defs/Avatar.def"),
        "跨根借用: B 根查询落到了别的根: {result}"
    );

    // A 根同样查询 → A 根路径(双向不串扰)。
    open_entities(&mut state, ENTITIES_A);
    let result = definition_request(&mut state, 3, ENTITIES_A);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/scripts/entity_defs/Avatar.def"),
        "A 根查询被 B 根候选污染: {result}"
    );
}

#[test]
fn kbug_root_01b_open_order_invariance() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    state.roots.register("/workspace/b");
    // 交换入库顺序:B 先、A 后 —— 两根查询仍各自落各自根。
    open_def(&mut state, DEF_B, AVATAR_DEF_B);
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_entities(&mut state, ENTITIES_B);
    open_entities(&mut state, ENTITIES_A);

    let result = definition_request(&mut state, 2, ENTITIES_B);
    assert_eq!(
        result["uri"],
        json!("/workspace/b/scripts/entity_defs/Avatar.def"),
        "入库顺序不得决定落点: {result}"
    );
    let result = definition_request(&mut state, 3, ENTITIES_A);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/scripts/entity_defs/Avatar.def"),
        "入库顺序不得决定落点: {result}"
    );
}

#[test]
fn kbug_root_02_unattributed_documents_are_isolated() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    // 根外文档(无注册根覆盖)与根 A 同名实体互不借用。
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_def(&mut state, "file:///tmp/standalone/Avatar.def", AVATAR_DEF_B);
    open_entities(&mut state, "file:///tmp/standalone/entities.xml");

    let result = definition_request(&mut state, 2, "file:///tmp/standalone/entities.xml");
    assert_eq!(
        result["uri"],
        json!("/tmp/standalone/Avatar.def"),
        "根外文档查询不得借用已注册根候选: {result}"
    );
    let value = hover_markdown(&mut state, 3, "file:///tmp/standalone/entities.xml");
    assert!(
        value.contains("**Definition**: `/tmp/standalone/Avatar.def`"),
        "根外 hover 应指根外候选: {value}"
    );
}

#[test]
fn kbug_root_04_hover_reports_querying_root_candidate() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    state.roots.register("/workspace/b");
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_def(&mut state, DEF_B, AVATAR_DEF_B);
    open_entities(&mut state, ENTITIES_B);
    open_entities(&mut state, ENTITIES_A);

    let value = hover_markdown(&mut state, 2, ENTITIES_B);
    assert!(
        value.contains("**Definition**: `/workspace/b/scripts/entity_defs/Avatar.def`"),
        "B 根 hover 应报 B 根候选(修前报 A 根首见): {value}"
    );
    let value = hover_markdown(&mut state, 3, ENTITIES_A);
    assert!(
        value.contains("**Definition**: `/workspace/a/scripts/entity_defs/Avatar.def`"),
        "A 根 hover 应报 A 根候选: {value}"
    );
}

#[test]
fn kbug_root_05_close_releases_only_own_root_candidates() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    state.roots.register("/workspace/b");
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_def(&mut state, DEF_B, AVATAR_DEF_B);
    open_entities(&mut state, ENTITIES_B);
    open_entities(&mut state, ENTITIES_A);

    // 关闭 B 根 Avatar.def:B 根候选清空(F12 → null,hover 回退约定名),
    // A 根候选不受波及。
    let out = handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": DEF_B } }),
        ),
    );
    assert!(out.is_empty());

    let result = definition_request(&mut state, 2, ENTITIES_B);
    assert_eq!(
        result,
        serde_json::Value::Null,
        "B 根候选已清空,F12 不得借 A 根路径: {result}"
    );
    let value = hover_markdown(&mut state, 3, ENTITIES_B);
    assert!(
        value.contains("**Definition**: `Avatar.def`"),
        "B 根 hover 应回退约定名(存在性失效): {value}"
    );
    assert!(
        !value.contains("/workspace/a/"),
        "A 根路径不得借给 B 根 hover: {value}"
    );

    let result = definition_request(&mut state, 4, ENTITIES_A);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/scripts/entity_defs/Avatar.def"),
        "关闭 B 根 def 不得清掉 A 根候选: {result}"
    );

    // 重开 B 根 def:候选重建,B 根查询恢复。
    open_def(&mut state, DEF_B, AVATAR_DEF_B);
    let result = definition_request(&mut state, 5, ENTITIES_B);
    assert_eq!(
        result["uri"],
        json!("/workspace/b/scripts/entity_defs/Avatar.def"),
        "重开后 B 根候选未重建: {result}"
    );
}

#[test]
fn kbug_root_03_same_root_ambiguity_is_unknown_not_first_seen() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    // 同根两个同名 Avatar.def(如 scripts/entity_defs 与 assets/entity_defs):
    // F12 歧义 → null(不硬猜首见);hover 存在性仍为真(候选存在)。
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_def(
        &mut state,
        "file:///workspace/a/assets/entity_defs/Avatar.def",
        AVATAR_DEF_B,
    );
    open_entities(&mut state, ENTITIES_A);

    let result = definition_request(&mut state, 2, ENTITIES_A);
    assert_eq!(
        result,
        serde_json::Value::Null,
        "同根同名歧义不得硬猜首见: {result}"
    );
    let value = hover_markdown(&mut state, 3, ENTITIES_A);
    assert!(
        value.contains("**Definition**: `/workspace/a/scripts/entity_defs/Avatar.def`"),
        "hover 信息面报入库序首候选: {value}"
    );
}

#[test]
fn kbug_root_06_completion_scoped_to_querying_root() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    state.roots.register("/workspace/b");
    // A 根只有 Avatar,B 根只有 Monster:在 B 根 entities.xml 上补全不得
    // 冒出 A 根的 Avatar。
    open_def(&mut state, DEF_A, AVATAR_DEF_A);
    open_def(
        &mut state,
        "file:///workspace/b/scripts/entity_defs/Monster.def",
        AVATAR_DEF_B,
    );
    // 补全用开标签位文本(第 2 行只有 `<`)。
    let out = handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": ENTITIES_B,
                    "languageId": "xml",
                    "version": 1,
                    "text": "<root>\n  <\n</root>\n"
                }
            }),
        ),
    );
    assert!(out.is_empty());

    let labels = completion_labels(&mut state, 2, ENTITIES_B);
    assert!(
        labels.iter().any(|(label, _)| label == "Monster"),
        "B 根补全应含本根 Monster: {labels:?}"
    );
    assert!(
        labels.iter().all(|(label, _)| label != "Avatar"),
        "B 根补全不得借 A 根候选 Avatar: {labels:?}"
    );
    let monster = labels
        .iter()
        .find(|(label, _)| label == "Monster")
        .expect("Monster item");
    assert_eq!(
        monster.1.as_deref(),
        Some("/workspace/b/scripts/entity_defs/Monster.def"),
        "detail 应为本根路径: {monster:?}"
    );
}
