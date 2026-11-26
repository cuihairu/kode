//! RUST-069-W 装配测试:工作区根生命周期真实 RPC 面
//! (`$/kode/workspace/rootAdded|rootRemoved|roots`)落 WorkspaceSession
//! 唯一根注册表 + 共享缓存扇出。session.rs 库单测不替代装配面——本文件
//! 全部走 handle_message(与生产同一条分派链),验收口径:
//! 新增同名实体根仍隔离 / 移除根清镜像+符号+解析候选且回执记账 / 保留根
//! 仍可查 / 重新添加取得新身份且旧化身缓存不复活 / 嵌套根回退 / 外部根。

use serde_json::json;

use kode_protocol::{IncomingMessage, Notification, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};
use std::time::{Duration, Instant};

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

fn response_of(out: &[Outgoing]) -> serde_json::Value {
    match &out[0] {
        Outgoing::Response(response) => response.result.as_ref().unwrap().clone(),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

fn initialize(id: i64, root_uri: &str) -> IncomingMessage {
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

fn root_added(state: &mut ServerState, id: i64, path: &str) -> serde_json::Value {
    response_of(&handle_message(
        state,
        request(id, "$/kode/workspace/rootAdded", json!({ "path": path })),
    ))
}

fn root_removed(state: &mut ServerState, id: i64, path: &str) -> serde_json::Value {
    response_of(&handle_message(
        state,
        request(id, "$/kode/workspace/rootRemoved", json!({ "path": path })),
    ))
}

fn roots_list(state: &mut ServerState, id: i64) -> Vec<(u64, String)> {
    let value = response_of(&handle_message(
        state,
        request(id, "$/kode/workspace/roots", json!({})),
    ));
    value["roots"]
        .as_array()
        .expect("roots array")
        .iter()
        .map(|entry| {
            (
                entry[0].as_u64().expect("root id"),
                entry[1].as_str().expect("root path").to_string(),
            )
        })
        .collect()
}

fn open_document(state: &mut ServerState, uri: &str, language_id: &str, text: &str) {
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

fn open_def(state: &mut ServerState, uri: &str, text: &str) {
    open_document(state, uri, "kbengine-def", text);
}

fn open_entities(state: &mut ServerState, uri: &str) {
    open_document(state, uri, "xml", "<root>\n  <Avatar/>\n</root>\n");
}

/// RUST-070/071/073:模拟主循环空闲切片——didOpen 的语料 ingest 已入
/// 索引刷新队列,泵过后才真正入库(与生产时序一致)。
fn pump_index(state: &mut ServerState) {
    // RESP-001b:泵=生产形态(墙钟界;读线程往返在预算内交货应用)。
    state
        .index
        .pump_budgeted_until(64, Instant::now() + Duration::from_millis(2000));
}

fn definition_at(state: &mut ServerState, id: i64, uri: &str) -> serde_json::Value {
    response_of(&handle_message(
        state,
        request(
            id,
            "textDocument/definition",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": 1, "character": 3 }
            }),
        ),
    ))
}

fn hover_markdown(state: &mut ServerState, id: i64, uri: &str) -> String {
    response_of(&handle_message(
        state,
        request(
            id,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": 1, "character": 3 }
            }),
        ),
    ))["contents"]["value"]
        .as_str()
        .expect("hover markdown")
        .to_string()
}

fn avatar_def(hp: bool) -> String {
    let prop = if hp { "hp" } else { "mp" };
    format!(
        "<root>\n\t<Properties>\n\t\t<{prop}>\n\t\t\t<Type> UINT32 </Type>\n\t\t</{prop}>\n\t</Properties>\n</root>\n"
    )
}

const DEF_A: &str = "file:///workspace/a/scripts/entity_defs/Avatar.def";
const ENTITIES_A: &str = "file:///workspace/a/scripts/entities.xml";

#[test]
fn root_added_updates_registry_and_isolates_same_name_entities() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize(1, "file:///workspace/a"));
    // 新增根(生产面:运行期 workspace folder / 外部 assetsRoot 加入)
    let added = root_added(&mut state, 2, "/workspace/b");
    let root_b = added["root"].as_u64().expect("root id");
    assert_ne!(root_b, 0, "新增根必须取得非 UNROOTED 身份");
    // 同路径重复注册幂等(同一化身,不发新 id)
    let again = root_added(&mut state, 3, "/workspace/b");
    assert_eq!(again["root"].as_u64(), Some(root_b), "同路径幂等");
    assert_eq!(
        roots_list(&mut state, 4),
        vec![
            (1, "/workspace/a".to_string()),
            (root_b, "/workspace/b".to_string())
        ],
        "注册表应含两个根"
    );

    // 同名实体两根各一份,新增根后仍隔离(KBUG-ROOT 面在新增根上复验)
    let def_b = "file:///workspace/b/scripts/entity_defs/Avatar.def";
    let entities_b = "file:///workspace/b/scripts/entities.xml";
    open_def(&mut state, DEF_A, &avatar_def(true));
    open_def(&mut state, def_b, &avatar_def(false));
    open_entities(&mut state, ENTITIES_A);
    open_entities(&mut state, entities_b);
    let result = definition_at(&mut state, 5, entities_b);
    assert_eq!(
        result["uri"],
        json!("/workspace/b/scripts/entity_defs/Avatar.def"),
        "新增根查询落本根候选: {result}"
    );
    let result = definition_at(&mut state, 6, ENTITIES_A);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/scripts/entity_defs/Avatar.def"),
        "留存根查询不受新增根污染: {result}"
    );
}

#[test]
fn root_removed_clears_root_and_fans_out_with_receipt() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize(1, "file:///workspace/a"));
    let root_b = root_added(&mut state, 2, "/workspace/b")["root"]
        .as_u64()
        .expect("root id");
    let def_b = "file:///workspace/b/scripts/entity_defs/Avatar.def";
    let entities_b = "file:///workspace/b/scripts/entities.xml";
    open_def(&mut state, DEF_A, &avatar_def(true));
    open_def(&mut state, def_b, &avatar_def(false));
    open_entities(&mut state, ENTITIES_A);
    open_entities(&mut state, entities_b);
    // 空闲切片先落账(语料 ingest 入队后由泵执行,撤根扇出才有 hover
    // 条目可清——与生产时序一致:open → 泵 → remove)。
    pump_index(&mut state);

    let removal = root_removed(&mut state, 3, "/workspace/b");
    assert_eq!(removal["removed"], json!(true), "已注册根移除如实回执");
    assert_eq!(removal["root"].as_u64(), Some(root_b), "回执带被撤根 id");
    let invalidated = removal["invalidated"]
        .as_array()
        .expect("invalidated array")
        .clone();
    assert_eq!(
        invalidated
            .iter()
            .map(|entry| entry[0].as_str().expect("sink name"))
            .collect::<Vec<_>>(),
        vec!["document-store", "hover-engine"],
        "回执按登记序列出消费面(先镜像仓库后 hover 引擎): {invalidated:?}"
    );
    for entry in &invalidated {
        let cleared = entry[1].as_u64().expect("cleared count");
        assert!(cleared >= 1, "每个消费面都应清到该根条目: {invalidated:?}");
    }
    // 注册表已除名
    let roots = roots_list(&mut state, 4);
    assert!(
        !roots.iter().any(|(_, path)| path == "/workspace/b"),
        "撤根后注册表不得再含该根: {roots:?}"
    );

    // 被撤根的镜像 overlay 已清:hover 回 null(不再吐旧内容)。
    let hover = response_of(&handle_message(
        &mut state,
        request(
            5,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": entities_b },
                "position": { "line": 1, "character": 3 }
            }),
        ),
    ));
    assert_eq!(
        hover,
        serde_json::Value::Null,
        "被撤根文档查询回 null: {hover}"
    );

    // 保留根仍可查(镜像/候选未被误伤)。
    let result = definition_at(&mut state, 6, ENTITIES_A);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/scripts/entity_defs/Avatar.def"),
        "保留根候选必须幸存: {result}"
    );
    let value = hover_markdown(&mut state, 7, ENTITIES_A);
    assert!(
        value.contains("/workspace/a/"),
        "保留根 hover 必须幸存: {value}"
    );
}

#[test]
fn root_removed_unknown_reports_removed_false_without_fan_out() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize(1, "file:///workspace/a"));
    open_def(&mut state, DEF_A, &avatar_def(true));
    open_entities(&mut state, ENTITIES_A);

    let removal = root_removed(&mut state, 2, "/workspace/ghost");
    assert_eq!(
        removal,
        json!({ "removed": false }),
        "未知根诚实回 removed:false: {removal}"
    );
    // 无扇出:留存根数据原样可查
    let result = definition_at(&mut state, 3, ENTITIES_A);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/scripts/entity_defs/Avatar.def")
    );
}

#[test]
fn root_removed_purges_pending_refresh_and_blocks_resurrection() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize(1, "file:///workspace/a"));
    let root_b = root_added(&mut state, 2, "/workspace/b")["root"]
        .as_u64()
        .expect("root id");
    let def_b = "file:///workspace/b/scripts/entity_defs/Avatar.def";
    // 入队但不泵:撤根时该根仍有待执行刷新。
    open_def(&mut state, def_b, &avatar_def(false));
    assert!(
        state.index.snapshot().queued >= 1,
        "didOpen 后应有待执行 ingest"
    );

    let removal = root_removed(&mut state, 3, "/workspace/b");
    assert_eq!(removal["removed"], json!(true));
    let purged = removal["purgedPendingRefresh"]
        .as_u64()
        .expect("purgedPendingRefresh receipt");
    assert!(purged >= 1, "撤根回执应带待执行刷新清除数: {removal}");
    assert_eq!(state.index.snapshot().queued, 0, "该根待执行刷新应清空");

    // 泵不复活:被撤根的语料不再灌回(RUST-069-W 撤根语义的队列侧延伸)。
    pump_index(&mut state);
    assert_eq!(
        state.hover.borrow().index.symbol_count(),
        0,
        "purge 后泵不得把旧根语料灌回"
    );
    let _ = root_b;
}

#[test]
fn root_re_added_gets_new_identity_and_old_incarnation_does_not_resurrect() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize(1, "file:///workspace/a"));
    let root_b = root_added(&mut state, 2, "/workspace/b")["root"]
        .as_u64()
        .expect("root id");
    let def_b = "file:///workspace/b/scripts/entity_defs/Avatar.def";
    let entities_b = "file:///workspace/b/scripts/entities.xml";
    open_def(&mut state, def_b, &avatar_def(true));
    open_entities(&mut state, entities_b);

    // 撤根(清镜像+候选)→ 重加同路径:必须取得新身份(id 永不复用)。
    assert_eq!(
        root_removed(&mut state, 3, "/workspace/b")["removed"],
        json!(true)
    );
    let root_b2 = root_added(&mut state, 4, "/workspace/b")["root"]
        .as_u64()
        .expect("root id");
    assert_ne!(root_b2, root_b, "重新添加必须取得新身份(化身隔离)");

    // 旧化身候选不得复活:entities 重开(overlay 归新化身)而 def 未重开,
    // 查询必须 null(若旧化身候选漏清,这里会借旧路径解析成功——红)。
    open_entities(&mut state, entities_b);
    let result = definition_at(&mut state, 5, entities_b);
    assert_eq!(
        result,
        serde_json::Value::Null,
        "旧化身候选不得复活(撤根后 def 未重开): {result}"
    );

    // 新化身 fresh 内容:def 重开(内容已改)后查询落新候选。
    open_def(&mut state, def_b, &avatar_def(false));
    let result = definition_at(&mut state, 6, entities_b);
    assert_eq!(
        result["uri"],
        json!("/workspace/b/scripts/entity_defs/Avatar.def"),
        "新化身 fresh 入库后查询恢复: {result}"
    );
    let value = hover_markdown(&mut state, 7, entities_b);
    assert!(
        value.contains("/workspace/b/"),
        "新化身 hover 落新候选: {value}"
    );
}

#[test]
fn nested_root_removal_falls_back_to_parent_root() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize(1, "file:///workspace/a"));
    let nested = "/workspace/a/nested";
    let root_nested = root_added(&mut state, 2, nested)["root"]
        .as_u64()
        .expect("root id");
    let def_nested = "file:///workspace/a/nested/scripts/entity_defs/Avatar.def";
    let entities_nested = "file:///workspace/a/nested/scripts/entities.xml";
    // 只开 nested 的 def(不开 A 根 Avatar):回落后的候选唯一,归属判定不歧义。
    open_def(&mut state, def_nested, &avatar_def(false));
    open_entities(&mut state, entities_nested);
    // 嵌套根最长前缀胜出:查询落 nested 候选
    let result = definition_at(&mut state, 3, entities_nested);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/nested/scripts/entity_defs/Avatar.def"),
        "嵌套根归属(最长前缀): {result}"
    );

    // 撤嵌套根:同路径文件回落父根(重开镜像被清过的文件后归属 A)。
    assert_eq!(root_removed(&mut state, 4, nested)["removed"], json!(true));
    let roots = roots_list(&mut state, 5);
    assert!(!roots.iter().any(|(id, _)| *id == root_nested));
    open_def(&mut state, def_nested, &avatar_def(false));
    open_entities(&mut state, entities_nested);
    let result = definition_at(&mut state, 6, entities_nested);
    assert_eq!(
        result["uri"],
        json!("/workspace/a/nested/scripts/entity_defs/Avatar.def"),
        "嵌套根撤除后同路径回落父根归属(候选仍指 nested 路径): {result}"
    );
    let root_for = state.session.root_for(&kode_vfs::CanonicalUri::from_path(
        "/workspace/a/nested/scripts/entities.xml",
    ));
    assert_eq!(root_for.0, 1, "同路径现在归属父根 A(id=1,注册序第二个根)");
}

#[test]
fn external_root_outside_workspace_registers_and_serves() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize(1, "file:///workspace/a"));
    // 外部 assetsRoot:不在任何 workspace folder 内,只能经 rootAdded 注册。
    let added = root_added(&mut state, 2, "/assets/shared");
    assert_ne!(added["root"].as_u64(), Some(0), "外部根必须取得身份");
    let def_ext = "file:///assets/shared/scripts/entity_defs/Avatar.def";
    let entities_ext = "file:///assets/shared/scripts/entities.xml";
    open_def(&mut state, def_ext, &avatar_def(true));
    open_entities(&mut state, entities_ext);
    let result = definition_at(&mut state, 3, entities_ext);
    assert_eq!(
        result["uri"],
        json!("/assets/shared/scripts/entity_defs/Avatar.def"),
        "外部根内查询落本根候选(未注册前会落 UNROOTED): {result}"
    );
}

#[test]
fn root_lifecycle_requires_initialized_and_validates_params() {
    let mut state = ServerState::new();
    // 未初始化拒(-32002,与 serving 面同口径)
    let out = handle_message(
        &mut state,
        request(1, "$/kode/workspace/rootAdded", json!({ "path": "/x" })),
    );
    match &out[0] {
        Outgoing::Response(response) => {
            assert!(response.error.is_some(), "未初始化必须拒绝");
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
    handle_message(&mut state, initialize(2, "file:///workspace/a"));
    // 缺 path / 空 path → -32602
    for params in [json!({}), json!({ "path": "" })] {
        let out = handle_message(&mut state, request(3, "$/kode/workspace/rootAdded", params));
        match &out[0] {
            Outgoing::Response(response) => {
                assert!(response.error.is_some(), "缺/空 path 必须拒绝");
            }
            Outgoing::Notification(_) => panic!("expected response"),
        }
    }
}
