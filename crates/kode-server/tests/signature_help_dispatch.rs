//! textDocument/signatureHelp LSP 级门禁(RUST-140 批 3 接线):能力协商、
//! 调用点→签名决策的产出面(label/parameters/documentation/definition)、
//! 活动形参标亮(clamp 零形参臂)、接收者段硬闸(段不符剔除非降权)、
//! 未声明方法无跨 def 回退(非接口文件)、光标不在调用点/未开档/非法参数。
//!
//! 决策核零改(signature_help.rs 批 2 纯库);本批只钉服务面形状:
//! SignatureHelpFace + activeParameter 双键。

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

/// Avatar:CellMethods 有 onTalk(双形参)/onZero(零形参)/onCellGone(段闸样本),
/// BaseMethods 有 onBaseOnly(段闸负例)。
const AVATAR_DEF: &str = "<Avatar>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type>UINT32</Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
\t<CellMethods>\n\
\t\t<onTalk>\n\
\t\t\t<Arg>UINT32</Arg>\n\
\t\t\t<Arg>STRING</Arg>\n\
\t\t</onTalk>\n\
\t\t<onZero>\n\
\t\t</onZero>\n\
\t</CellMethods>\n\
\t<BaseMethods>\n\
\t\t<onBaseOnly>\n\
\t\t\t<Arg>UINT32</Arg>\n\
\t\t</onBaseOnly>\n\
\t</BaseMethods>\n\
</Avatar>\n";

/// cell 脚本:调用点分四行——onTalk 双实参(活动形参 1)/onZero 零形参
/// (clamp 到 0)/onBaseOnly(接收者段闸)/missing(无声明无回退)。
/// 注意:`\` 行续符会吞掉续行首部空白(判例:缩进被吃掉后 `self.cell.` 不
/// 再是段接收者,正臂全空)——python 缩进用 concat! 逐行拼接,不走行续符。
const AVATAR_PY: &str = concat!(
    "import KBEngine\n",
    "\n",
    "class Avatar:\n",
    "    def onEnter(self):\n",
    "        self.cell.onTalk(1, 2)\n",
    "        self.cell.onZero(1, 2)\n",
    "        self.base.onBaseOnly(1)\n",
    "        self.cell.missing(1)\n",
);

const ENTITIES_XML: &str = "<root/>\n";

/// 临时工作区:scripts/entities.xml(向上走查的登记锚)+ entity_defs 一档。
fn make_workspace() -> (String, String, String) {
    // 并行测试各用独立目录(共享目录会让 cleanup 删掉别人正在走查的盘面)。
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "kode-signature-help-dispatch-{}-{}",
        std::process::id(),
        seq
    ));
    let defs_dir = root.join("scripts/entity_defs");
    std::fs::create_dir_all(&defs_dir).expect("create defs dir");
    let cell_dir = root.join("scripts/cell");
    std::fs::create_dir_all(&cell_dir).expect("create cell dir");
    std::fs::write(root.join("scripts/entities.xml"), ENTITIES_XML).expect("write entities.xml");
    std::fs::write(defs_dir.join("Avatar.def"), AVATAR_DEF).expect("write Avatar.def");
    let root_str = root.to_string_lossy().to_string();
    (
        format!("file://{}", root_str),
        format!("file://{}/scripts/entity_defs/Avatar.def", root_str),
        format!("file://{}/scripts/cell/Avatar.py", root_str),
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

/// 初始化 + 语料入库(defs_root 靠 entities.xml 入档定锚;签名候选靠
/// Avatar.def 入语料视图),再开调用点文档——三档缺一,链断在
/// owner_chain_paths/defs_root,正臂必空。
fn seed_workspace(
    state: &mut ServerState,
    root_uri: &str,
    avatar_def_uri: &str,
    avatar_py_uri: &str,
) {
    handle_message(state, initialize_message(1, root_uri));
    let entities_uri = format!("{}/scripts/entities.xml", root_uri);
    open_doc(state, &entities_uri, "xml", ENTITIES_XML);
    open_doc(state, avatar_def_uri, "kbengine-def", AVATAR_DEF);
    open_doc(state, avatar_py_uri, "python", AVATAR_PY);
}

fn signature_help_request(
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
            "textDocument/signatureHelp",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character }
            }),
        ),
    );
    response_of(&out).clone()
}

/// fixture 自推导 1 基声明行(不硬编码,改 fixture 不漂)。
fn def_line_of(mark: &str) -> u32 {
    AVATAR_DEF
        .split('\n')
        .position(|l| l.trim_start().starts_with(mark))
        .expect("marker in fixture") as u32
        + 1
}

#[test]
fn initialize_advertises_signature_help_provider() {
    let (root_uri, _avatar, _py) = make_workspace();
    let mut state = ServerState::new();
    let out = handle_message(&mut state, initialize_message(1, &root_uri));
    assert_eq!(
        response_of(&out)["capabilities"]["signatureHelpProvider"],
        json!(true)
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn cell_call_returns_signature_with_active_parameter() {
    let (root_uri, avatar_def, avatar_py) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_def, &avatar_py);
    // 行 4(0 基)`self.cell.onTalk(1, 2)`:光标落在第二个实参侧(char 27),
    // 顶层逗号序 1 → activeParameter 1。
    let result = signature_help_request(&mut state, 2, &avatar_py, 4, 27);
    let face = &result["signature"];
    assert_eq!(
        face["label"],
        json!("def onTalk(self, arg1: int, arg2: str)")
    );
    assert_eq!(face["parameters"], json!(["arg1: int", "arg2: str"]));
    assert_eq!(result["activeParameter"], json!(1));
    assert_eq!(face["definition"]["section"], json!("CellMethods"));
    assert_eq!(face["definition"]["line"], json!(def_line_of("<onTalk>")));
    assert!(
        face["documentation"]
            .as_str()
            .expect("documentation")
            .contains("接收者 self.CellMethods"),
        "{}",
        face["documentation"]
    );
    cleanup_workspace(&root_uri);
}

#[test]
fn zero_parameter_signature_clamps_active_parameter() {
    let (root_uri, avatar_def, avatar_py) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_def, &avatar_py);
    // 行 5 `self.cell.onZero(1, 2)`:调用写错(零形参却传两实参),光标在
    // 逗号后 → 活动形参必须夹到 0,不得越界报 1。
    let result = signature_help_request(&mut state, 2, &avatar_py, 5, 29);
    assert_eq!(result["signature"]["label"], json!("def onZero(self)"));
    assert_eq!(result["signature"]["parameters"], json!([]));
    assert_eq!(result["activeParameter"], json!(0));
    cleanup_workspace(&root_uri);
}

#[test]
fn receiver_section_gate_drops_other_section_call() {
    let (root_uri, avatar_def, avatar_py) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_def, &avatar_py);
    // cell 脚本调 self.base.onBaseOnly:调用方段=CellMethods,onBaseOnly 只声明
    // 在 BaseMethods → 段硬闸剔除(不降权)→ 无签名。
    let result = signature_help_request(&mut state, 2, &avatar_py, 6, 31);
    assert_eq!(result, serde_json::Value::Null);
    cleanup_workspace(&root_uri);
}

#[test]
fn undeclared_method_has_no_cross_def_fallback() {
    let (root_uri, avatar_def, avatar_py) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_def, &avatar_py);
    // 非接口文件不回退全语料(防误绑):本域闭包查不到 → null。
    let result = signature_help_request(&mut state, 2, &avatar_py, 7, 30);
    assert_eq!(result, serde_json::Value::Null);
    cleanup_workspace(&root_uri);
}

#[test]
fn cursor_off_call_site_is_null() {
    let (root_uri, avatar_def, avatar_py) = make_workspace();
    let mut state = ServerState::new();
    seed_workspace(&mut state, &root_uri, &avatar_def, &avatar_py);
    // 行 0 `import KBEngine`:不在调用点。
    let result = signature_help_request(&mut state, 2, &avatar_py, 0, 6);
    assert_eq!(result, serde_json::Value::Null);
    cleanup_workspace(&root_uri);
}

#[test]
fn signature_help_on_unopened_document_is_null() {
    let (root_uri, _avatar, _avatar_py) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    let result = signature_help_request(
        &mut state,
        2,
        "file:///tmp/elsewhere/scripts/cell/Ghost.py",
        4,
        27,
    );
    assert_eq!(result, serde_json::Value::Null);
    cleanup_workspace(&root_uri);
}

#[test]
fn signature_help_with_invalid_params_is_invalid_request() {
    let (root_uri, _avatar, _py) = make_workspace();
    let mut state = ServerState::new();
    handle_message(&mut state, initialize_message(1, &root_uri));
    let out = handle_message(
        &mut state,
        request(
            2,
            "textDocument/signatureHelp",
            json!({ "textDocument": 42 }),
        ),
    );
    assert_eq!(error_code_of(&out), error_codes::INVALID_PARAMS);
    cleanup_workspace(&root_uri);
}
