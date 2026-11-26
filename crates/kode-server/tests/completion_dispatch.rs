//! textDocument/completion LSP 级门禁:能力协商、未初始化拒绝、文档同步联动
//! (didOpen/didChange/didClose)、取消、null 结果与非法参数。

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

const AVATAR_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

fn open_avatar(state: &mut ServerState) {
    let out = handle_message(
        state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                    "languageId": "kbengine-def",
                    "version": 1,
                    "text": AVATAR_DEF
                }
            }),
        ),
    );
    assert!(out.is_empty());
}

fn completion_params(uri: &str, line: u32, character: u32) -> serde_json::Value {
    json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character }
    })
}

#[test]
fn initialize_advertises_completion_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    let result = response_of(&out);
    assert_eq!(
        result["capabilities"]["completionProvider"]["triggerCharacters"],
        json!(["<"])
    );
    assert_eq!(result["capabilities"]["hoverProvider"], json!(true));
}

#[test]
fn completion_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            7,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

#[test]
fn completion_on_open_document_returns_items() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    // 行 3(1 起,`\t\t<hp>`)col 2 = `<` 后:Properties 开标签全量点。
    let out = handle_message(
        &mut state,
        request(
            9,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                2,
                3,
            ),
        ),
    );
    let result = response_of(&out);
    assert_eq!(result["isIncomplete"], json!(false));
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["label"], json!("hp"));
    assert_eq!(items[0]["kind"], json!(10));
    assert_eq!(items[0]["detail"], json!("UINT32"));
}

#[test]
fn completion_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(12, "textDocument/completion", json!({ "position": {} })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn completion_on_unopened_document_returns_null_result() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            11,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Missing.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn completion_without_detectable_context_returns_null_result() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    // 行 1(顶层)col 2:开标签但栈顶为 root,不接管 → null。
    let out = handle_message(
        &mut state,
        request(
            13,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                0,
                2,
            ),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn cancelled_completion_yields_request_cancelled_error() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    // 取消通知先于请求到达(LSP 允许):请求到达即回 -32800。
    handle_message(
        &mut state,
        notification("$/cancelRequest", json!({ "id": 21 })),
    );
    let out = handle_message(
        &mut state,
        request(
            21,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::REQUEST_CANCELLED);
}

#[test]
fn did_change_updates_completion_items() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def", "version": 2 },
                "contentChanges": [
                    { "text": "<root>\n\t<Properties>\n\t\t<mana>\n\t\t\t<Type> UINT32 </Type>\n\t\t</mana>\n\t</Properties>\n</root>\n" }
                ]
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            22,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                2,
                3,
            ),
        ),
    );
    let items = response_of(&out)["items"].as_array().expect("items");
    assert_eq!(
        items[0]["label"],
        json!("mana"),
        "didChange 后补全未跟随 overlay"
    );
}

#[test]
fn did_close_drops_completion() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_avatar(&mut state);
    handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Avatar.def" } }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            23,
            "textDocument/completion",
            completion_params(
                "file:///workspace/demo/scripts/entity_defs/Avatar.def",
                3,
                2,
            ),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn did_close_keeps_disk_types_in_corpus() {
    // VFS-003 close 转移(修订钉):didClose 逐出 overlay,但盘上仍在的语料
    // 文件必须回落磁盘真相继续喂补全。此前 hover.remove 连带逐出语料视图,
    // 消费文件补全静默空 —— 盘上类型凭空消失(用户可见正确性缺陷)。
    // 盘上无文件的关闭仍逐出(did_close_drops_completion 钉)。
    let tmp = std::env::temp_dir().join(format!("kode-close-corpus-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("mkdir");
    let types_body = "<root>\n\t<MYTYPE> UINT32 </MYTYPE>\n</root>\n";
    std::fs::write(tmp.join("types.xml"), types_body).expect("write types.xml");
    let types_uri = format!("file://{}/types.xml", tmp.display());
    let avatar_uri = format!("file://{}/entity_defs/Avatar.def", tmp.display());

    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(
            1,
            "initialize",
            json!({
                "processId": 1234,
                "rootUri": format!("file://{}", tmp.display()),
                "capabilities": {}
            }),
        ),
    );
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": types_uri,
                    "languageId": "xml",
                    "version": 1,
                    "text": types_body
                }
            }),
        ),
    );
    handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": types_uri } }),
        ),
    );
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": avatar_uri,
                    "languageId": "kbengine-def",
                    "version": 1,
                    "text": "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> MY"
                }
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            2,
            "textDocument/completion",
            completion_params(&avatar_uri, 3, 12),
        ),
    );
    let items = response_of(&out)["items"].as_array().expect("items array");
    assert!(
        items.iter().any(|item| item["label"] == json!("MYTYPE")),
        "didClose 后盘上 types.xml 仍应喂补全: {items:?}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn did_close_of_deleted_file_drops_corpus() {
    // 读盘失败(盘上已删除)→ 真逐出:非空响应壳不装「磁盘真相仍在」。
    let tmp = std::env::temp_dir().join(format!("kode-close-gone-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("mkdir");
    let types_uri = format!("file://{}/types.xml", tmp.display());
    let avatar_uri = format!("file://{}/entity_defs/Avatar.def", tmp.display());
    std::fs::write(
        tmp.join("types.xml"),
        "<root>\n\t<MYTYPE> UINT32 </MYTYPE>\n</root>\n",
    )
    .expect("write types.xml");

    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(
            1,
            "initialize",
            json!({
                "processId": 1234,
                "rootUri": format!("file://{}", tmp.display()),
                "capabilities": {}
            }),
        ),
    );
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": types_uri,
                    "languageId": "xml",
                    "version": 1,
                    "text": "<root>\n\t<MYTYPE> UINT32 </MYTYPE>\n</root>\n"
                }
            }),
        ),
    );
    std::fs::remove_file(tmp.join("types.xml")).expect("remove types.xml");
    handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": types_uri } }),
        ),
    );
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": avatar_uri,
                    "languageId": "kbengine-def",
                    "version": 1,
                    "text": "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> MY"
                }
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            2,
            "textDocument/completion",
            completion_params(&avatar_uri, 3, 12),
        ),
    );
    let items = response_of(&out)["items"].as_array().expect("items array");
    assert!(
        !items.iter().any(|item| item["label"] == json!("MYTYPE")),
        "盘上已删除的语料不得复活: {items:?}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

// ---------------------------------------------------------------------------
// RUST-134:py `self.` 实体成员面(LSP 级,内存 overlay fixture)
// ---------------------------------------------------------------------------

const SELF_ENTITIES: &str = "<root>\n\t<Avatar hasBase=\"true\"/>\n</root>\n";

const SELF_AVATAR_DEF: &str = "<root>\n\
\t<Parent> BaseApp </Parent>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
\t<BaseMethods>\n\
\t\t<reqCastSkill>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</reqCastSkill>\n\
\t</BaseMethods>\n\
</root>\n";

const SELF_BASEAPP_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<name>\n\
\t\t\t<Type> STRING </Type>\n\
\t\t</name>\n\
\t</Properties>\n\
\t<ClientMethods>\n\
\t\t<notify>\n\
\t\t</notify>\n\
\t</ClientMethods>\n\
</root>\n";

const SELF_AVATAR_PY: &str = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tself.\n";

fn open_self_fixture(state: &mut ServerState) {
    for (uri, language, text) in [
        (
            "file:///workspace/demo/scripts/entities.xml",
            "xml",
            SELF_ENTITIES,
        ),
        (
            "file:///workspace/demo/scripts/entity_defs/Avatar.def",
            "kbengine-def",
            SELF_AVATAR_DEF,
        ),
        (
            "file:///workspace/demo/scripts/entity_defs/BaseApp.def",
            "kbengine-def",
            SELF_BASEAPP_DEF,
        ),
        (
            "file:///workspace/demo/scripts/base/Avatar.py",
            "python",
            SELF_AVATAR_PY,
        ),
    ] {
        let out = handle_message(
            state,
            notification(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language,
                        "version": 1,
                        "text": text
                    }
                }),
            ),
        );
        assert!(out.is_empty());
    }
}

/// py `self.` 位出实体成员(LSP 投影 label/kind/detail):本类属性 →
/// 方法分面 → 继承链成员(defs_root/category 探测锚在 def 路径上)。
#[test]
fn completion_on_py_self_lists_entity_members_from_def_corpus() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_self_fixture(&mut state);
    // 行 6(1 起)= `\t\tself.`,col 7 = 行尾全量点。
    let out = handle_message(
        &mut state,
        request(
            31,
            "textDocument/completion",
            completion_params("file:///workspace/demo/scripts/base/Avatar.py", 5, 7),
        ),
    );
    let result = response_of(&out);
    assert_eq!(result["isIncomplete"], json!(false));
    let items = result["items"].as_array().expect("items");
    let labels: Vec<&str> = items
        .iter()
        .map(|i| i["label"].as_str().expect("label"))
        .collect();
    assert_eq!(
        labels,
        vec!["hp", "reqCastSkill", "name", "notify"],
        "本类属性/方法在前,继承链成员随后(hp/reqCastSkill 遮蔽 BaseApp 同名)"
    );
    // 属性带类型 detail;方法 kind=2(method)。
    let hp = items.iter().find(|i| i["label"] == json!("hp")).unwrap();
    assert_eq!(hp["kind"], json!(10));
    assert_eq!(hp["detail"], json!("UINT32"));
    let req = items
        .iter()
        .find(|i| i["label"] == json!("reqCastSkill"))
        .unwrap();
    assert_eq!(req["kind"], json!(2));
    let name = items.iter().find(|i| i["label"] == json!("name")).unwrap();
    assert_eq!(name["detail"], json!("STRING"));
}

/// 非 self 位/非实体 py 诚实 null(不装无候选,让位 TS 既有链的语义由
/// TS 装配层处理;Rust 分派层回 null 结果)。
#[test]
fn completion_on_py_non_self_or_non_entity_is_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_self_fixture(&mut state);
    let non_self = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tmonster.\n";
    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": {
                    "uri": "file:///workspace/demo/scripts/base/Avatar.py",
                    "version": 2
                },
                "contentChanges": [{ "text": non_self }]
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            32,
            "textDocument/completion",
            completion_params("file:///workspace/demo/scripts/base/Avatar.py", 5, 12),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
    // 无同 stem 语料 def 的 py:归属落空 → null。
    let helper_py = "class Helper:\n\tdef run(self):\n\t\tself.\n";
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": "file:///workspace/demo/scripts/base/Helper.py",
                    "languageId": "python",
                    "version": 1,
                    "text": helper_py
                }
            }),
        ),
    );
    let out = handle_message(
        &mut state,
        request(
            33,
            "textDocument/completion",
            completion_params("file:///workspace/demo/scripts/base/Helper.py", 2, 7),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

/// RUST-135:capabilities 广播 resolveProvider(complationItem/resolve 面)。
#[test]
fn initialize_advertises_completion_resolve_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    let provider = &response_of(&out)["capabilities"]["completionProvider"];
    assert_eq!(provider["triggerCharacters"], json!(["<"]));
    assert_eq!(provider["resolveProvider"], json!(true));
}

/// resolve 往返(LSP 级):completion 出条目 → completionItem/resolve 回传
/// → documentation 文档面(类型/来源)。语料缺位条目原样返回不装空文档。
#[test]
fn completion_resolve_roundtrip_enriches_documentation() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_self_fixture(&mut state);
    let out = handle_message(
        &mut state,
        request(
            41,
            "textDocument/completion",
            completion_params("file:///workspace/demo/scripts/base/Avatar.py", 5, 7),
        ),
    );
    let items = response_of(&out)["items"].as_array().expect("items");
    let hp = items
        .iter()
        .find(|i| i["label"] == json!("hp"))
        .expect("hp 条目")
        .clone();
    let out = handle_message(
        &mut state,
        request(42, "completionItem/resolve", hp.clone()),
    );
    let resolved = response_of(&out);
    assert_eq!(resolved["label"], json!("hp"));
    let doc = resolved["documentation"]["value"]
        .as_str()
        .expect("documentation");
    assert!(doc.contains("`UINT32`"), "类型面: {doc}");
    assert!(
        doc.contains("scripts/entity_defs/Avatar.def"),
        "来源路径: {doc}"
    );
    // resolve 后 data 原样保留(客户端二次 resolve 场景)。
    assert_eq!(resolved["data"], hp["data"]);
}

#[test]
fn completion_resolve_without_payload_echoes_input() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            43,
            "completionItem/resolve",
            json!({ "label": "mystery", "kind": 7 }),
        ),
    );
    assert_eq!(response_of(&out), &json!({ "label": "mystery", "kind": 7 }));
    // params 缺失(非 item 形)→ INVALID_PARAMS(params None 走坏参臂)。
    let missing = IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(45),
        method: "completionItem/resolve".into(),
        params: None,
    });
    let out = handle_message(&mut state, missing);
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}
