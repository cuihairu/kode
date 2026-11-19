//! main() 退出/分派语义集成(COV-038):真实拉起二进制(CARGO_BIN_EXE_
//! 模式,与 executor_e2e 同车道)。
//! ① stdin 立即关闭 → reader EOF → 主循环 eof 分支 → 无 deferred 即退出
//!   → 未 shutdown 按崩溃面留痕(CORE-015,TS client 据此重启)。
//! ② `$/kode/wait` 内联长请求睡眠间隙 poll 泵:在飞 cancel 即刻登记 +
//!   续帧入 deferred,wait 结束后主循环 310 分支补分派。
//! ③ `--version` 握手校验臂:打印协议版本即退。
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct ServerProc {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    rx: mpsc::Receiver<Value>,
}

impl Drop for ServerProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// stdout 逐帧读(header 行定长 → body),Value 进 channel。
fn spawn_server() -> ServerProc {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kode-server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn kode-server");
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut length: Option<usize> = None;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(_) => return,
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    length = rest.trim().parse().ok();
                }
            }
            let Some(length) = length else { return };
            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            let Ok(value) = serde_json::from_slice(&body) else {
                return;
            };
            if tx.send(value).is_err() {
                return;
            }
        }
    });
    ServerProc {
        child,
        stdin: Some(stdin),
        rx,
    }
}

fn send(proc: &mut ServerProc, value: &Value) {
    let body = serde_json::to_string(value).expect("serialize frame");
    let stdin = proc.stdin.as_mut().expect("stdin still open");
    write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).expect("write frame");
    stdin.flush().expect("flush frame");
}

fn request(id: i64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// 等指定 id 的响应(超时即红;非目标消息丢弃继续等)。
fn wait_response(proc: &ServerProc, id: i64, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "no response for id {id} in time");
        match proc.rx.recv_timeout(remaining) {
            Ok(value) => {
                if value.get("id").and_then(|v| v.as_i64()) == Some(id) {
                    return value;
                }
            }
            Err(RecvTimeoutError::Timeout) => panic!("no response for id {id} in time"),
            Err(RecvTimeoutError::Disconnected) => panic!("server exited early"),
        }
    }
}

fn handshake(proc: &mut ServerProc) {
    send(
        proc,
        &request(1, "initialize", json!({ "capabilities": {} })),
    );
    wait_response(proc, 1, Duration::from_secs(30));
    send(
        proc,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );
}

#[test]
fn stdin_eof_without_shutdown_exits_crash_faced() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kode-server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kode-server");
    // 立即关闭 stdin:reader Ok(0) → send(None) → 主循环 Ok(None) 分支
    // eof=true → deferred 空 → break → drop(executor)+drainer join →
    // shutdown_requested=false 走崩溃面留痕。
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait exit");
    assert!(
        output.status.success(),
        "EOF 退出应正常收尾: {:?}",
        output.status
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("exited without shutdown"),
        "CORE-015 崩溃面留痕缺失: {stderr}"
    );
    assert!(
        stderr.contains("stdin EOF"),
        "reader EOF 留痕缺失: {stderr}"
    );
}

/// poll 泵双臂:在飞取消即登记(-32800 即刻回)+ 续帧入 deferred,
/// wait 结束主循环 310 分支补分派(health 照常回包)。
#[test]
fn wait_poll_pumps_cancel_and_defers_trailing_frames() {
    let mut proc = spawn_server();
    handshake(&mut proc);

    // 内联长请求 id 5:300ms 分片睡眠,间隙 poll。
    send(&mut proc, &request(5, "$/kode/wait", json!({ "ms": 300 })));
    std::thread::sleep(Duration::from_millis(30));
    // 在飞窗内连发:取消 id 5 + 轻请求 id 6(两帧同 chunk 落 pipe)。
    send(
        &mut proc,
        &json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": 5 } }),
    );
    send(&mut proc, &request(6, "$/kode/health", json!({})));

    let cancelled = wait_response(&proc, 5, Duration::from_secs(30));
    assert_eq!(
        cancelled.pointer("/error/code").and_then(|c| c.as_i64()),
        Some(-32800),
        "在飞取消应经 poll 登记并结算 -32800: {cancelled}"
    );
    // deferred 补分派:health 在 wait 结束后照常回包。
    let health = wait_response(&proc, 6, Duration::from_secs(30));
    assert!(health.get("result").is_some(), "health 应回包: {health}");

    // 干净收尾:关 stdin 让 server 走 EOF 退出(kill 会丢进程内覆盖计数,
    // profraw 无 atexit 不落盘——COV-038 判例)。
    drop(proc.stdin.take());
    let status = proc.child.wait().expect("server EOF exit");
    assert!(status.success(), "EOF 收尾应正常退出: {status}");
}

/// `--version` 握手校验臂:打印版本即退(不进 stdio 泵)。
#[test]
fn version_arg_prints_and_exits() {
    let output = Command::new(env!("CARGO_BIN_EXE_kode-server"))
        .arg("--version")
        .output()
        .expect("spawn kode-server --version");
    assert!(output.status.success(), "--version 应正常退出");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.starts_with("kode-server "),
        "--version 应打印版本行: {stdout}"
    );
}
