//! RUST-131-W:生产文件事件(rename/delete)server 分派层全链(生产形状)。
//!
//! 覆盖:didDeleteFiles 旧 URI 全链撤销(队列待执行刷新摘除 = 晚到复活
//! 禁令 + store overlay/盘缓存 + hover 符号连带);未打开依赖(盘上驻留
//! 语料)删除后旧 URI 无结果;真实磁盘重命名旧侧撤销 + 新 URI 执行时刻
//! 回读盘;打开缓冲区移动(didOpen new 先到,overlay 胜出)与丢弃关闭
//! (close ≠ delete,盘上符号保留)分测;跨根移动各归其根;根外路径
//! 诚实跳过。
//!
//! 探针口径:textDocument/hover 被 overlay 门短路(逐出后恒 null),不能
//! 作复活探针;复活面直接读 `state.hover.borrow().index.symbols_in_file`
//! (符号索引真态)+ `state.index.snapshot()` 队列记账。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Notification, Request, RequestId};
use kode_vfs::{CanonicalUri, DocumentKey};
use kode_server::server::Outgoing;
use kode_server::{handle_message, ServerState};

fn unique_dir(tag: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "kode-r131w-{}-{}-{}",
        tag,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).expect("create tmpdir");
    dir
}

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn notification(method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Notification(Notification {
        jsonrpc: "2.0".into(),
        method: method.into(),
        params: Some(params),
    })
}

/// initialize(多根注册走 workspaceFolders)并返回 ServerState。
fn init_state(dir: &std::path::Path, extra_dirs: &[&std::path::Path]) -> ServerState {
    let mut state = ServerState::new();
    let mut folders = vec![json!({"uri": format!("file://{}", dir.display())})];
    for extra in extra_dirs {
        folders.push(json!({"uri": format!("file://{}", extra.display())}));
    }
    let out = handle_message(
        &mut state,
        request(
            0,
            "initialize",
            json!({"capabilities": {}, "workspaceFolders": folders}),
        ),
    );
    assert_eq!(out.len(), 1, "initialize 应有回执");
    state
}

fn uri_for(dir: &std::path::Path, name: &str) -> String {
    format!("file://{}", dir.join(name).display())
}

fn key_for(state: &ServerState, uri: &str) -> DocumentKey {
    let parsed = CanonicalUri::parse(uri).expect("parse uri");
    let root = state.session.root_for(&parsed);
    DocumentKey::new(root, parsed)
}

/// 请求入口 drain(hover 形)+ 显式泵,回 hover 文本(可 None)。
fn drain_and_hover(state: &mut ServerState, uri: &str, id: i64) -> Option<String> {
    let out = handle_message(
        state,
        request(
            id,
            "textDocument/hover",
            json!({
                "textDocument": {"uri": uri},
                "position": {"line": 2, "character": 4}
            }),
        ),
    );
    assert_eq!(out.len(), 1);
    match out.into_iter().next().unwrap() {
        Outgoing::Response(response) => response
            .result
            .and_then(|r| r.get("contents").and_then(|c| c.get("value")).and_then(|v| v.as_str()).map(String::from)),
        other => panic!("hover 回执形状异常: {other:?}"),
    }
}

fn pump(state: &mut ServerState) {
    state.index.pump_budgeted(64);
}

const DEF_TEXT: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";

/// 防复活靶(核心):didOpen 待执行刷新在泵前被 didDeleteFiles 摘除——
/// 之后请求入口 freshen/泵永远不出符号。没有 purge_key 时 freshen 会执行
/// 残留 didOpen 任务,overlay 回读把语料重新灌回(复活)。
#[test]
fn delete_before_pump_blocks_late_task_resurrection() {
    let dir = unique_dir("late");
    let uri = uri_for(&dir, "Late.def");
    let mut state = init_state(&dir, &[]);
    // 文件已在盘(didOpen 任务执行时 overlay 或盘上都拿得到内容)。
    std::fs::write(dir.join("Late.def"), DEF_TEXT).expect("write def");
    let purged_before = state.index.snapshot().purged;

    // didOpen 入队(version=1),此刻不泵——待执行刷新挂在队列上。
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "plaintext", "version": 1, "text": DEF_TEXT}}),
        ),
    );
    let queued = state.index.snapshot().queued;
    assert!(queued >= 1, "didOpen 应有待执行刷新在队");

    // 泵前删除:队列摘除 + 全链撤销。
    handle_message(
        &mut state,
        notification("workspace/didDeleteFiles", json!({"files": [{"uri": uri}]})),
    );
    let key = key_for(&state, &uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&key).len(),
        0,
        "删除后符号即空"
    );
    assert!(
        state.index.snapshot().purged > purged_before,
        "队列侧应记账 purge"
    );

    // 请求入口 drain + 泵:晚到旧任务复活禁令——永远不出符号。
    pump(&mut state);
    let key = key_for(&state, &uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&key).len(),
        0,
        "泵后不得复活"
    );
    drain_and_hover(&mut state, &uri, 7);
    pump(&mut state);
    let key = key_for(&state, &uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&key).len(),
        0,
        "请求入口 drain 后仍不得复活"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// 未打开依赖:盘上驻留语料(didOpen 后 close,close ≠ delete,盘上
/// 回读保持符号)——真实删除文件 + didDeleteFiles 后旧 URI 无结果。
#[test]
fn delete_unopened_disk_file_evicts_resident_symbols() {
    let dir = unique_dir("unopened");
    let path = dir.join("Resident.def");
    std::fs::write(&path, DEF_TEXT).expect("write def");
    let uri = uri_for(&dir, "Resident.def");
    let mut state = init_state(&dir, &[]);

    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "plaintext", "version": 1, "text": DEF_TEXT}}),
        ),
    );
    handle_message(
        &mut state,
        notification("textDocument/didClose", json!({"textDocument": {"uri": uri}})),
    );
    drain_and_hover(&mut state, &uri, 1);
    pump(&mut state);
    let key = key_for(&state, &uri);
    assert!(
        !state.hover.borrow().index.symbols_in_file(&key).is_empty(),
        "close 后盘上符号应驻留(close ≠ delete)"
    );

    // 真实删除磁盘文件,再发生产删除事件。
    std::fs::remove_file(&path).expect("remove file");
    handle_message(
        &mut state,
        notification("workspace/didDeleteFiles", json!({"files": [{"uri": uri}]})),
    );
    let key = key_for(&state, &uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&key).len(),
        0,
        "删除后旧 URI 无符号"
    );
    assert!(
        state.store.borrow().open_buffer(&key).is_none(),
        "store overlay/缓存应逐出"
    );
    // 回执面:hover null(旧 URI 无结果)。
    assert_eq!(drain_and_hover(&mut state, &uri, 2), None);
    std::fs::remove_dir_all(&dir).ok();
}

/// 真实磁盘重命名:旧 URI 全链撤销,新 URI 经 request_close 执行时刻回读
/// 盘上新文件(未打开依赖移动)。
#[test]
fn rename_on_disk_moves_symbols_to_new_uri() {
    let dir = unique_dir("rename");
    let old_path = dir.join("Old.def");
    let new_path = dir.join("New.def");
    std::fs::write(&old_path, DEF_TEXT).expect("write def");
    let old_uri = uri_for(&dir, "Old.def");
    let new_uri = uri_for(&dir, "New.def");
    let mut state = init_state(&dir, &[]);

    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": old_uri, "languageId": "plaintext", "version": 1, "text": DEF_TEXT}}),
        ),
    );
    drain_and_hover(&mut state, &old_uri, 1);
    pump(&mut state);
    let old_key = key_for(&state, &old_uri);
    assert!(
        !state.hover.borrow().index.symbols_in_file(&old_key).is_empty(),
        "rename 前旧 URI 符号驻留"
    );

    std::fs::rename(&old_path, &new_path).expect("rename on disk");
    handle_message(
        &mut state,
        notification(
            "workspace/didRenameFiles",
            json!({"files": [{"oldUri": old_uri, "newUri": new_uri}]}),
        ),
    );
    let old_key = key_for(&state, &old_uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&old_key).len(),
        0,
        "rename 后旧 URI 撤销"
    );
    pump(&mut state);
    let new_key = key_for(&state, &new_uri);
    assert!(
        !state.hover.borrow().index.symbols_in_file(&new_key).is_empty(),
        "新 URI 执行时刻回读盘上文件得符号"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// 打开缓冲区的移动:didRenameFiles 后 didOpen(new) 先到(编辑器重开
/// 语义),执行时刻真相 = overlay 未保存修订胜出。
#[test]
fn rename_open_document_overlay_follows_to_new_uri() {
    let dir = unique_dir("openmove");
    let old_path = dir.join("Dirty.def");
    let new_path = dir.join("Moved.def");
    std::fs::write(&old_path, DEF_TEXT).expect("write def");
    let old_uri = uri_for(&dir, "Dirty.def");
    let new_uri = uri_for(&dir, "Moved.def");
    let mut state = init_state(&dir, &[]);

    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": old_uri, "languageId": "plaintext", "version": 1, "text": DEF_TEXT}}),
        ),
    );
    drain_and_hover(&mut state, &old_uri, 1);
    pump(&mut state);

    // 盘上改名;编辑器发送 didRenameFiles + didOpen(new, 保存前修订)。
    std::fs::rename(&old_path, &new_path).expect("rename on disk");
    handle_message(
        &mut state,
        notification(
            "workspace/didRenameFiles",
            json!({"files": [{"oldUri": old_uri, "newUri": new_uri}]}),
        ),
    );
    let dirty = DEF_TEXT.replace("UINT32", "UINT64");
    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": new_uri, "languageId": "plaintext", "version": 1, "text": dirty}}),
        ),
    );
    pump(&mut state);
    let new_key = key_for(&state, &new_uri);
    assert!(
        !state.hover.borrow().index.symbols_in_file(&new_key).is_empty(),
        "新 URI 有符号"
    );
    // overlay 胜出:新 URI 的 open_buffer 文本 = 未保存修订(非盘上旧文)。
    let (_, buffer) = state
        .store
        .borrow()
        .open_buffer(&new_key)
        .expect("新 URI overlay 应在");
    assert!(buffer.text().contains("UINT64"), "未保存修订随移动保留");
    std::fs::remove_dir_all(&dir).ok();
}

/// 跨根移动:旧根撤销、新根入库,各归其根(根身份不串)。
#[test]
fn rename_across_roots_moves_symbols_between_roots() {
    let root_a = unique_dir("crossa");
    let root_b = unique_dir("crossb");
    let old_path = root_a.join("Traveler.def");
    let new_path = root_b.join("Traveler.def");
    std::fs::write(&old_path, DEF_TEXT).expect("write def");
    let old_uri = uri_for(&root_a, "Traveler.def");
    let new_uri = uri_for(&root_b, "Traveler.def");
    let mut state = init_state(&root_a, &[&root_b]);

    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": old_uri, "languageId": "plaintext", "version": 1, "text": DEF_TEXT}}),
        ),
    );
    drain_and_hover(&mut state, &old_uri, 1);
    pump(&mut state);

    std::fs::rename(&old_path, &new_path).expect("rename on disk");
    handle_message(
        &mut state,
        notification(
            "workspace/didRenameFiles",
            json!({"files": [{"oldUri": old_uri, "newUri": new_uri}]}),
        ),
    );
    pump(&mut state);
    let old_key = key_for(&state, &old_uri);
    let new_key = key_for(&state, &new_uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&old_key).len(),
        0,
        "旧根撤销"
    );
    assert!(
        !state.hover.borrow().index.symbols_in_file(&new_key).is_empty(),
        "新根入库"
    );
    assert_ne!(old_key.root, new_key.root, "跨根各归其根");
    std::fs::remove_dir_all(&root_a).ok();
    std::fs::remove_dir_all(&root_b).ok();
}

/// 诚实跳过:不可解析 URI / 根外路径不惊动任何状态(不 panic、不逐出他人)。
#[test]
fn delete_skips_unparseable_and_out_of_root_uris() {
    let dir = unique_dir("skip");
    let keep_path = dir.join("Keep.def");
    let other_path = dir.join("Other.def");
    std::fs::write(&keep_path, DEF_TEXT).expect("write def");
    std::fs::write(&other_path, DEF_TEXT).expect("write def");
    let keep_uri = uri_for(&dir, "Keep.def");
    let other_uri = uri_for(&dir, "Other.def");
    let mut state = init_state(&dir, &[]);
    for (id, uri) in [(1i64, keep_uri.as_str()), (2, other_uri.as_str())] {
        handle_message(
            &mut state,
            notification(
                "textDocument/didOpen",
                json!({"textDocument": {"uri": uri, "languageId": "plaintext", "version": 1, "text": DEF_TEXT}}),
            ),
        );
        drain_and_hover(&mut state, uri, id);
        pump(&mut state);
    }

    handle_message(
        &mut state,
        notification(
            "workspace/didDeleteFiles",
            json!({"files": [
                {"uri": "not-a-uri"},
                {"uri": "file:///outside-any-root/Ghost.def"},
                {"uri": keep_uri}
            ]}),
        ),
    );
    let keep_key = key_for(&state, &keep_uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&keep_key).len(),
        0,
        "同批好 URI 照常撤销"
    );
    let other_key = key_for(&state, &other_uri);
    assert!(
        !state.hover.borrow().index.symbols_in_file(&other_key).is_empty(),
        "坏/根外 URI 跳过不误伤他文件"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// 风暴缓冲同身份事件一并摘除(didChange 在风暴窗内 + 删除 → 移交路径
/// 不得把旧语料灌回)。
#[test]
fn delete_purges_storm_buffered_change_for_same_identity() {
    let dir = unique_dir("storm");
    let path = dir.join("Storm.def");
    std::fs::write(&path, DEF_TEXT).expect("write def");
    let uri = uri_for(&dir, "Storm.def");
    let mut state = init_state(&dir, &[]);

    handle_message(
        &mut state,
        notification(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": "plaintext", "version": 1, "text": DEF_TEXT}}),
        ),
    );
    drain_and_hover(&mut state, &uri, 1);
    pump(&mut state);

    // didChange 进风暴缓冲(窗口未到期不移交)。
    handle_message(
        &mut state,
        notification(
            "textDocument/didChange",
            json!({"textDocument": {"uri": uri, "version": 2}, "contentChanges": [{"text": DEF_TEXT}]}),
        ),
    );
    assert!(
        state.index.snapshot().storm_buffered >= 1,
        "didChange 应在风暴缓冲"
    );

    handle_message(
        &mut state,
        notification("workspace/didDeleteFiles", json!({"files": [{"uri": uri}]})),
    );
    assert_eq!(
        state.index.snapshot().storm_buffered,
        0,
        "同身份风暴缓冲事件应一并摘除"
    );
    pump(&mut state);
    let key = key_for(&state, &uri);
    assert_eq!(
        state.hover.borrow().index.symbols_in_file(&key).len(),
        0,
        "缓冲移交路径不得复活"
    );
    std::fs::remove_dir_all(&dir).ok();
}
