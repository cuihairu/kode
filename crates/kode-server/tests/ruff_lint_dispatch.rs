//! `$/kode/ruff/lint` dispatch 单测(IDE-RUST-005,A 案 shell out)。
//!
//! 打桩:临时目录写可执行假 `ruff` shell 脚本(unix;args 落脚本旁 args.txt
//! 供旗标断言),走完整 `$/kode/rpc` 链路。覆盖:
//! - 假 ruff:available+version+诊断映射(py37 旗标/--no-cache/文件透传/E9xx→error);
//! - 二进制缺席:available:false 如实回退,不是错误;
//! - files 空:只探测版本;
//! - 超上限:如实 Err(不静默截断);
//! - 坏输出:如实 Err 带 ruff 版本。

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

/// 走完整 `$/kode/rpc` 链路调 `$/kode/ruff/lint`;错误响应如实返回 Err 字符串。
fn lint(params: Value) -> Result<Value, String> {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/ruff/lint", "params": params}),
        ),
    );
    match &out[0] {
        Outgoing::Response(response) => {
            if let Some(result) = response.result.as_ref() {
                Ok(result.clone())
            } else {
                Err(response
                    .error
                    .as_ref()
                    .map(|e| e.message.to_string())
                    .unwrap_or_else(|| "unknown rpc error".into()))
            }
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

// ---------------------------------------------------------------------------
// 假 ruff(unix):args 全量落脚本旁 args.txt;--version 出测试版本;check 出
// 两条固定诊断(F841 warning / E902 error,后者带 fix)。
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn write_fake_ruff(dir: &std::path::Path, check_stdout: &str) -> std::path::PathBuf {
    let ruff = dir.join("ruff");
    let script = format!(
        "#!/bin/sh\nd=$(dirname \"$0\")\nprintf '%s\\n' \"$@\" > \"$d/args.txt\"\n\
         if [ \"$1\" = \"--version\" ]; then printf 'ruff 0.99.0-test\\n'; exit 0; fi\n\
         printf '%s' '{}'\n",
        check_stdout
    );
    std::fs::write(&ruff, script).unwrap();
    make_executable(&ruff);
    ruff
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[cfg(unix)]
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kode-ruff-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const FAKE_DIAGS: &str = "[{\"code\":\"E902\",\"message\":\"io boom\",\"location\":{\"row\":1,\"column\":1},\"end_location\":{\"row\":1,\"column\":1},\"filename\":\"/w/b.py\",\"fix\":{\"applicability\":\"unsafe\",\"edits\":[],\"message\":\"m\"}},{\"code\":\"F841\",\"message\":\"unused x\",\"location\":{\"row\":2,\"column\":5},\"end_location\":{\"row\":2,\"column\":6},\"filename\":\"/w/a.py\",\"fix\":null}]";

#[cfg(unix)]
#[test]
fn lint_via_fake_ruff_reports_py37_and_mapped_diags() {
    let dir = temp_dir("ok");
    let ruff = write_fake_ruff(&dir, FAKE_DIAGS);
    let result = lint(json!({
        "files": ["/w/a.py", "/w/b.py"],
        "ruffPath": ruff.to_string_lossy(),
    }))
    .unwrap();
    assert_eq!(result["available"], json!(true));
    assert_eq!(result["version"], json!("ruff 0.99.0-test"));
    let diags = result["diags"].as_array().unwrap();
    assert_eq!(diags.len(), 2);
    // 稳定序:(file,line,col) —— a.py 在前。
    assert_eq!(diags[0]["file"], json!("/w/a.py"));
    assert_eq!(diags[0]["code"], json!("F841"));
    assert_eq!(diags[0]["severity"], json!("warning"));
    assert_eq!(diags[0]["fixable"], json!(false));
    assert_eq!(diags[0]["line"], json!(2));
    assert_eq!(diags[0]["col"], json!(5));
    assert_eq!(diags[0]["endLine"], json!(2));
    assert_eq!(diags[0]["endCol"], json!(6));
    // E9xx = 语法/IO 错误族 → error;带 fix → fixable。
    assert_eq!(diags[1]["file"], json!("/w/b.py"));
    assert_eq!(diags[1]["severity"], json!("error"));
    assert_eq!(diags[1]["fixable"], json!(true));
    // 旗标与文件透传(吃 args.txt 全文断言关键字)。
    let args = std::fs::read_to_string(dir.join("args.txt")).unwrap();
    assert!(args.contains("--target-version"), "args: {args}");
    assert!(args.contains("py37"), "args: {args}");
    assert!(args.contains("--no-cache"), "args: {args}");
    assert!(args.contains("--exit-zero"), "args: {args}");
    assert!(args.contains("/w/a.py"), "args: {args}");
    assert!(args.contains("/w/b.py"), "args: {args}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_ruff_falls_back_available_false_not_error() {
    let result = lint(json!({
        "files": ["/w/a.py"],
        "ruffPath": "/nonexistent/kode-ruff-missing/ruff",
    }))
    .unwrap();
    assert_eq!(result["available"], json!(false));
    assert_eq!(result["diags"].as_array().unwrap().len(), 0);
}

#[cfg(unix)]
#[test]
fn empty_files_probes_version_only() {
    let dir = temp_dir("probe");
    let ruff = write_fake_ruff(&dir, FAKE_DIAGS);
    let result = lint(json!({ "files": [], "ruffPath": ruff.to_string_lossy() })).unwrap();
    assert_eq!(result["available"], json!(true));
    assert_eq!(result["version"], json!("ruff 0.99.0-test"));
    assert_eq!(result["diags"].as_array().unwrap().len(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn too_many_files_rejected_honestly() {
    let files: Vec<String> = (0..2001).map(|i| format!("/w/f{i}.py")).collect();
    let err = lint(json!({ "files": files })).unwrap_err();
    assert!(err.contains("too many files"), "err: {err}");
}

#[cfg(unix)]
#[test]
fn garbage_output_reports_honest_error_with_version() {
    let dir = temp_dir("bad");
    let ruff = write_fake_ruff(&dir, "this is not json");
    let err = lint(json!({
        "files": ["/w/a.py"],
        "ruffPath": ruff.to_string_lossy(),
    }))
    .unwrap_err();
    assert!(err.contains("failed to parse"), "err: {err}");
    assert!(err.contains("0.99.0-test"), "err: {err}");
    let _ = std::fs::remove_dir_all(&dir);
}
