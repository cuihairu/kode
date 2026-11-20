//! textDocument/documentSymbol LSP 级门禁(RUST-139 批 3 接线):能力协商、
//! 文档同步联动、段符号面深等、非符号段空集与无根 null 的区分、非法参数。
//!
//! 深等基准 = document_symbols.rs 批 1 与 TS IDE-NAV-005 的同构口径:
//! 四段容器(Properties=Struct/方法段=Class)+ 段内直接成员
//! (Properties→Field/方法段→Method);Parent/Interfaces/Components 不进面。

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

/// Properties(hp)+CellMethods(onCellCreate) 两段;行号 0 基,供断言锚定。
const AVATAR_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
\t<CellMethods>\n\
\t\t<onCellCreate>\n\
\t\t\t<Arg> UINT32 </Arg>\n\
\t\t</onCellCreate>\n\
\t</CellMethods>\n\
</root>\n";

/// 只有 Parent/Interfaces/Components 的 def:非符号段全不进 Outline → 空集
/// (不是 null:文档可解析、就是没有符号段)。
const META_ONLY_DEF: &str = "<root>\n\
\t<Parent> Avatar </Parent>\n\
\t<Interfaces>\n\
\t\t<movable/>\n\
\t</Interfaces>\n\
\t<Components>\n\
\t\t<weapon> <Type> Weapon </Type> </weapon>\n\
\t</Components>\n\
</root>\n";

const AVATAR_URI: &str = "file:///workspace/demo/scripts/entity_defs/Avatar.def";

fn open_def(state: &mut ServerState, text: &str) {
    let out = handle_message(
        state,
        notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": AVATAR_URI,
                    "languageId": "kbengine-def",
                    "version": 1,
                    "text": text
                }
            }),
        ),
    );
    assert!(out.is_empty());
}

fn symbol_request(state: &mut ServerState, id: i64) -> serde_json::Value {
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/documentSymbol",
            json!({ "textDocument": { "uri": AVATAR_URI } }),
        ),
    );
    response_of(&out).clone()
}

#[test]
fn initialize_advertises_document_symbol_provider() {
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1));
    assert_eq!(
        response_of(&out)["capabilities"]["documentSymbolProvider"],
        json!(true)
    );
}

#[test]
fn document_symbol_before_initialize_is_rejected() {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            7,
            "textDocument/documentSymbol",
            json!({ "textDocument": { "uri": AVATAR_URI } }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::SERVER_NOT_INITIALIZED);
}

#[test]
fn document_symbol_on_open_document_returns_section_symbols() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_def(&mut state, AVATAR_DEF);
    let result = symbol_request(&mut state, 8);
    // 两段:Properties(Struct,子 hp=Field)+CellMethods(Class,子 onCellCreate=
    // Method);range=元素全跨度,selectionRange=开标签跨度(⊆ range)。
    assert_eq!(result.as_array().map(|a| a.len()), Some(2), "{result}");

    let properties = &result[0];
    assert_eq!(properties["name"], json!("Properties"));
    assert_eq!(properties["detail"], json!(""));
    assert_eq!(properties["kind"], json!("Struct"));
    assert_eq!(
        properties["range"]["start"],
        json!({"line": 1, "character": 1})
    );
    assert_eq!(properties["range"]["end"]["line"], json!(6));
    assert_eq!(
        properties["selectionRange"],
        json!({"start": {"line": 1, "character": 1}, "end": {"line": 1, "character": 13}})
    );
    let hp = &properties["children"][0];
    assert_eq!(hp["name"], json!("hp"));
    assert_eq!(hp["kind"], json!("Field"));
    assert_eq!(hp["children"], json!([]));

    let cell_methods = &result[1];
    assert_eq!(cell_methods["name"], json!("CellMethods"));
    assert_eq!(cell_methods["kind"], json!("Class"));
    let method = &cell_methods["children"][0];
    assert_eq!(method["name"], json!("onCellCreate"));
    assert_eq!(method["kind"], json!("Method"));
    // 方法内 <Arg> 不产符号:成员不再下钻。
    assert_eq!(method["children"], json!([]));
}

#[test]
fn document_symbol_meta_only_def_returns_empty_array_not_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_def(&mut state, META_ONLY_DEF);
    let result = symbol_request(&mut state, 9);
    // 可解析但无符号段:空集是合法应答(null 属「无根/未打开」面)。
    assert_eq!(result, serde_json::Value::Array(vec![]));
}

#[test]
fn document_symbol_on_unopened_document_returns_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            10,
            "textDocument/documentSymbol",
            json!({ "textDocument": { "uri": "file:///workspace/demo/scripts/entity_defs/Missing.def" } }),
        ),
    );
    assert_eq!(response_of(&out), &serde_json::Value::Null);
}

#[test]
fn document_symbol_on_unparseable_def_returns_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    // 无根档(与 document_symbols 单测 no_root_returns_none 同口径:
    // 空串/纯文本 → None,残缺开标签会被容错解析器恢复出根,不属本面)。
    open_def(&mut state, "not xml at all\n");
    let result = symbol_request(&mut state, 11);
    assert_eq!(result, serde_json::Value::Null);
}

#[test]
fn document_symbol_with_invalid_params_is_invalid_request() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    let out = handle_message(
        &mut state,
        request(
            12,
            "textDocument/documentSymbol",
            json!({ "textDocument": 42 }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
}

#[test]
fn document_symbol_after_did_change_reflects_new_sections() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_def(&mut state, AVATAR_DEF);
    // didChange:去掉 CellMethods 段 → 只剩 Properties。
    let _ = handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": AVATAR_URI, "version": 2 },
                "contentChanges": [
                    { "text": "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n" }
                ]
            }),
        ),
    );
    let result = symbol_request(&mut state, 13);
    assert_eq!(result.as_array().map(|a| a.len()), Some(1));
    assert_eq!(result[0]["name"], json!("Properties"));
}

#[test]
fn document_symbol_did_close_reverts_to_null() {
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1));
    open_def(&mut state, AVATAR_DEF);
    let _ = handle_message(
        &mut state,
        notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": AVATAR_URI } }),
        ),
    );
    let result = symbol_request(&mut state, 14);
    assert_eq!(result, serde_json::Value::Null);
}
