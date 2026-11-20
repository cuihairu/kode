//! textDocument/codeAction LSP 级门禁(RUST-143 批 3 接线):能力协商、
//! 四族装配分派(typeReplacement/parityMethod/receiverNone/fixedDict)、
//! 负臂(族外 code/定位面缺失/receiver 提不出)、未知 family -32602、
//! 未开档 null、非法参数 -32602。
//!
//! 决策核零改(code_action_assembly.rs 批 2 纯库 + titleParams 批 3 增列);
//! 本批只钉服务面形状:ActionFace 描述符数组(vscode 对象构造与 l10n
//! 标题插值归 TS 薄壳,按族消费 titleParams)。

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

const UNIT32_DEF: &str = "<Avatar>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>UNIT32</Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
</Avatar>\n";

/// parity 族 def:BaseMethods.onTalk 带 <Arg>(行 5,名字 2..8)。
const ONTALK_DEF: &str = "<Avatar>\n\
\t<Properties>\n\
\t\t<level type=\"UINT32\"/>\n\
\t</Properties>\n\
\t<BaseMethods>\n\
\t\t<onTalk>\n\
\t\t\t<Arg>UINT32</Arg>\n\
\t\t</onTalk>\n\
\t</BaseMethods>\n\
</Avatar>\n";

/// parity 族目标 python 快照(与 golden AVATAR_PY 同文):Avatar 类体末行
/// idx7,插入点 8(1 基展示 9)。
const AVATAR_PY: &str = "import KBEngine\n\nclass Avatar:\n    def __init__(self):\n        self.level = 0\n\n    def onMove(self):\n        pass\n";

/// receiver 族 python:`self.cell.ready()` 行 3,ready 名 token 18..23。
const RECV_PY: &str = "class Mob:\n    def onEnter(self, entity):\n        self.cell.prepareEnter(entity)\n        self.cell.ready()\n";

/// fixedDict 族 python:行 2/3 为下标存储形态赋值。
const FD_PY: &str = "class Box:\n    def onUse(self):\n        self.contents[\"slot\"] = 1\n        self.contents[\"extra\"] = 2\n";

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

fn open_doc(state: &mut ServerState, id: i64, uri: &str, language_id: &str, text: &str) {
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
    let _ = id;
}

#[allow(clippy::too_many_arguments)]
fn code_action_request(
    state: &mut ServerState,
    id: i64,
    uri: &str,
    family: &str,
    diagnostics: serde_json::Value,
    registered: serde_json::Value,
    snapshot_text: serde_json::Value,
    request_range: serde_json::Value,
) -> serde_json::Value {
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": uri },
                "range": request_range,
                "family": family,
                "registered": registered,
                "snapshotText": snapshot_text,
                "diagnostics": diagnostics
            }),
        ),
    );
    response_of(&out).clone()
}

fn diag(
    code: &str,
    start_line: u32,
    start_char: u32,
    end_line: u32,
    end_char: u32,
) -> serde_json::Value {
    json!({
        "code": code,
        "range": {
            "start": {"line": start_line, "character": start_char},
            "end": {"line": end_line, "character": end_char}
        }
    })
}

fn whole_line(line: u32) -> serde_json::Value {
    json!({
        "start": {"line": line, "character": 0},
        "end": {"line": line, "character": 200}
    })
}

#[test]
fn initialize_advertises_code_action_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    assert_eq!(
        response_of(&out)["capabilities"]["codeActionProvider"],
        json!(true)
    );
}

#[test]
fn type_replacement_family_emits_near_edit_candidates() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entity_defs/Avatar.def";
    open_doc(&mut state, 2, uri, "kbengine-def", UNIT32_DEF);
    // 诊断区间锚定 UNIT32 名 token(行 3,9..15),请求区间整行覆盖。
    let result = code_action_request(
        &mut state,
        3,
        uri,
        "typeReplacement",
        json!([diag("kbengine.unknownType", 3, 9, 3, 15)]),
        json!(["UINT32", "UINT64"]),
        serde_json::Value::Null,
        whole_line(3),
    );
    let actions = result.as_array().expect("actions array");
    // 负臂:UINT64 距离 4 出闸,只 UINT32(dist 1)入选。
    assert_eq!(actions.len(), 1, "{result}");
    assert_eq!(actions[0]["kind"], json!("QuickFix"));
    assert_eq!(
        actions[0]["title"],
        json!("Replace with registered type UINT32")
    );
    assert_eq!(actions[0]["titleParams"], json!(["UINT32"]));
    assert_eq!(actions[0]["edit"]["type"], json!("replaceRange"));
    assert_eq!(actions[0]["edit"]["newText"], json!("UINT32"));
    assert_eq!(actions[0]["diagnosticStartLine"], json!(3));
}

#[test]
fn type_replacement_family_gates_by_diagnostic_code() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entity_defs/Avatar.def";
    open_doc(&mut state, 2, uri, "kbengine-def", UNIT32_DEF);
    let result = code_action_request(
        &mut state,
        3,
        uri,
        "typeReplacement",
        json!([diag("kbengine.receiverNone", 3, 9, 3, 15)]),
        json!(["UINT32"]),
        serde_json::Value::Null,
        whole_line(3),
    );
    assert_eq!(result, json!([]), "{result}");
}

#[test]
fn parity_method_family_emits_skeleton_insertion() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entity_defs/Avatar.def";
    open_doc(&mut state, 2, uri, "kbengine-def", ONTALK_DEF);
    // 名 token 精确锚定(`\t\t<onTalk>` 里 < 占 char 2,名字 3..9;批 2 判例:
    // 区间带 < 或截尾会把垃圾灌进方法名)。
    let mut diagnostic = diag("def-method-missing-in-python", 5, 3, 5, 9);
    diagnostic["relatedFile"] = json!("/tmp/ws/scripts/avatar.py");
    diagnostic["relatedMessage"] = json!("Avatar");
    let result = code_action_request(
        &mut state,
        3,
        uri,
        "parityMethod",
        json!([diagnostic]),
        json!([]),
        json!(AVATAR_PY),
        whole_line(5),
    );
    let actions = result.as_array().expect("actions array");
    assert_eq!(actions.len(), 1, "{result}");
    let action = &actions[0];
    // 标题参数:[方法名, 目标文件, 1 基展示行](类体末行 7 → 插入点 8 → 9)。
    // 三槽均为字符串(titleParams 是 Vec<String>;行号按位插值,不丢形态)。
    assert_eq!(
        action["titleParams"],
        json!(["onTalk", "/tmp/ws/scripts/avatar.py", "9"])
    );
    assert_eq!(action["edit"]["type"], json!("insertLine"));
    assert_eq!(action["edit"]["file"], json!("/tmp/ws/scripts/avatar.py"));
    assert_eq!(action["edit"]["line"], json!(8));
    let text = action["edit"]["text"].as_str().expect("skeleton text");
    assert!(text.contains("def onTalk"), "{text}");
    assert!(text.contains("raise NotImplementedError"), "{text}");
    assert!(text.contains("-> None"), "{text}");
}

#[test]
fn parity_method_family_requires_related_location_face() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entity_defs/Avatar.def";
    open_doc(&mut state, 2, uri, "kbengine-def", ONTALK_DEF);
    // 定位面缺失(无 relatedFile)→ 不出(不猜)。
    let result = code_action_request(
        &mut state,
        3,
        uri,
        "parityMethod",
        json!([diag("def-method-missing-in-python", 5, 2, 5, 8)]),
        json!([]),
        json!(AVATAR_PY),
        whole_line(5),
    );
    assert_eq!(result, json!([]), "{result}");
}

#[test]
fn receiver_none_family_emits_wrap_then_guard() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/scripts/cell/Mob.py";
    open_doc(&mut state, 2, uri, "python", RECV_PY);
    let result = code_action_request(
        &mut state,
        3,
        uri,
        "receiverNone",
        json!([diag("kbengine.receiverNone", 3, 18, 3, 23)]),
        json!([]),
        serde_json::Value::Null,
        whole_line(3),
    );
    let actions = result.as_array().expect("actions array");
    // 包裹式首选 + 早退式次选;receiver 从区间归属提取(cell)。
    assert_eq!(actions.len(), 2, "{result}");
    assert_eq!(actions[0]["edit"]["type"], json!("replaceLines"));
    assert_eq!(actions[0]["titleParams"], json!(["cell"]));
    let wrap_text = actions[0]["edit"]["text"].as_str().expect("wrap text");
    assert!(wrap_text.contains("if self.cell:"), "{wrap_text}");
    assert_eq!(actions[1]["edit"]["type"], json!("insertLine"));
    assert_eq!(actions[1]["titleParams"], json!(["cell"]));
    let guard_text = actions[1]["edit"]["text"].as_str().expect("guard text");
    assert!(guard_text.contains("if not self.cell:"), "{guard_text}");
}

#[test]
fn receiver_none_family_requires_method_token_overlap() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/scripts/cell/Mob.py";
    open_doc(&mut state, 2, uri, "python", RECV_PY);
    // 区间只盖 receiver 段(self.cell),不盖方法名 token → 提不出不出。
    let result = code_action_request(
        &mut state,
        3,
        uri,
        "receiverNone",
        json!([diag("kbengine.receiverNone", 3, 8, 3, 17)]),
        json!([]),
        serde_json::Value::Null,
        whole_line(3),
    );
    assert_eq!(result, json!([]), "{result}");
}

#[test]
fn fixed_dict_family_emits_whole_reassign() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/scripts/common/Box.py";
    open_doc(&mut state, 2, uri, "python", FD_PY);
    // 诊断锚定行 2 的下标赋值语句。
    let result = code_action_request(
        &mut state,
        3,
        uri,
        "fixedDict",
        json!([diag("kbengine.fixedDictNestedMutation", 2, 8, 2, 34)]),
        json!([]),
        serde_json::Value::Null,
        whole_line(2),
    );
    let actions = result.as_array().expect("actions array");
    assert_eq!(actions.len(), 1, "{result}");
    assert_eq!(actions[0]["edit"]["type"], json!("replaceLines"));
    let text = actions[0]["edit"]["text"].as_str().expect("reassign text");
    assert!(text.contains("_fd = self.contents"), "{text}");
    assert!(text.contains("_fd[\"slot\"] = 1"), "{text}");
    assert!(text.contains("self.contents = _fd"), "{text}");
}

#[test]
fn unknown_family_is_invalid_params() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let uri = "file:///workspace/demo/entity_defs/Avatar.def";
    open_doc(&mut state, 2, uri, "kbengine-def", UNIT32_DEF);
    let out = handle_message(
        &mut state,
        request(
            3,
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": uri },
                "range": whole_line(3),
                "family": "magicFamily",
                "diagnostics": []
            }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn code_action_on_unopened_document_is_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let result = code_action_request(
        &mut state,
        2,
        "file:///workspace/demo/entity_defs/Missing.def",
        "typeReplacement",
        json!([]),
        json!([]),
        serde_json::Value::Null,
        whole_line(0),
    );
    assert_eq!(result, serde_json::Value::Null);
}

#[test]
fn code_action_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(3, "textDocument/codeAction", json!({ "textDocument": 42 })),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}
