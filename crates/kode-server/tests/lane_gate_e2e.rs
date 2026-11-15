//! RUST-076-W 真子进程 E2E:阻塞 IO 泳道不阻塞 CPU/交互车道(todo 验收
//! 口径「生产入口集成测试覆盖」)。
//!
//! 载体 = mkfifo 真命名管道:inspectArchive 对 FIFO `File::open` 阻塞在
//! 等写端(O_RDONLY 语义),这是真实阻塞 IO——不是同步 handler 外包一层
//! 计数的假隔离。阻塞期真实交互 RPC(echo)照常往返、健康面 ioRunning=1
//! /cpuRunning=0 如实记账;写端写入垃圾解阻塞 → -32602(坏魔数)→ 泳道
//! 位释放(ioRunning 回 0),失败后无占位泄漏。Linux only(mkfifo)。

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct ServerProc {
    child: Child,
    rx: Receiver<Value>,
}

impl Drop for ServerProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_server() -> ServerProc {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kode-server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn kode-server");
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            let mut length: Option<usize> = None;
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
            let length = match length {
                Some(length) => length,
                None => return,
            };
            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            match serde_json::from_slice::<Value>(&body) {
                Ok(value) => {
                    if tx.send(value).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    ServerProc { child, rx }
}

fn send(proc: &mut ServerProc, value: &Value) {
    let body = serde_json::to_string(value).expect("serialize frame");
    let stdin = proc.child.stdin.as_mut().expect("stdin piped");
    write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).expect("write frame");
    stdin.flush().expect("flush frame");
}

fn request(id: i64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// `$/kode/rpc` 内层调用信封(池路径;分类按内层 method)。
fn rpc_request(id: i64, inner: &str, params: Value) -> Value {
    request(id, "$/kode/rpc", json!({ "method": inner, "params": params }))
}

fn wait_response(proc: &ServerProc, id: i64, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!("no response for id {id} in time");
        }
        match proc.rx.recv_timeout(remaining) {
            Ok(value) => {
                if value.get("id").and_then(|v| v.as_i64()) == Some(id) {
                    return value;
                }
            }
            Err(RecvTimeoutError::Timeout) => panic!("no response for id {id} in time"),
            Err(RecvTimeoutError::Disconnected) => {
                panic!("server stdout closed before response for id {id}")
            }
        }
    }
}

fn result_of(response: Value) -> Value {
    response
        .get("result")
        .and_then(|r| {
            if r.is_null() {
                None
            } else {
                Some(r.clone())
            }
        })
        .unwrap_or_else(|| panic!("expected success response: {response}"))
}

fn health_of(proc: &mut ServerProc, id: &mut i64) -> Value {
    *id += 1;
    send(proc, &request(*id, "$/kode/health", json!({})));
    result_of(wait_response(proc, *id, Duration::from_secs(10)))
}

fn pool_of(health: &Value) -> Value {
    health
        .get("pool")
        .cloned()
        .unwrap_or_else(|| panic!("health missing pool: {health}"))
}

fn wait_pool_io_running(
    proc: &mut ServerProc,
    id: &mut i64,
    want: usize,
    timeout: Duration,
) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let health = health_of(proc, id);
        let pool = pool_of(&health);
        if pool.get("ioRunning").and_then(|v| v.as_u64()) == Some(want as u64) {
            return pool;
        }
        assert!(
            Instant::now() < deadline,
            "pool.ioRunning never reached {want}: {pool}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn blocking_io_lane_does_not_stall_cpu_and_interactive() {
    // 唯一 FIFO:进程级唯一名,不引第三方临时目录依赖。
    let fifo = std::env::temp_dir().join(format!(
        "kode-lane-e2e-{}-blocking.fifo",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&fifo);
    let status = Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("run mkfifo");
    assert!(status.success(), "mkfifo failed: {status}");

    let mut proc = spawn_server();
    let mut next_id = 0i64;

    // 握手。
    next_id += 1;
    send(
        &mut proc,
        &request(next_id, "initialize", json!({ "capabilities": {} })),
    );
    let init = wait_response(&proc, next_id, Duration::from_secs(30));
    assert!(
        init.get("result").map(|r| !r.is_null()).unwrap_or(false),
        "initialize 应成功: {init}"
    );
    send(
        &mut proc,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );

    // 泳道分离需 ≥2 worker(1 核机两泳道皆 0,交互全占——本测试前提)。
    let pool = pool_of(&health_of(&mut proc, &mut next_id));
    let workers = pool.get("workers").and_then(|v| v.as_u64()).expect("workers");
    assert!(
        workers >= 2,
        "lane separation E2E requires >=2 workers, got {workers}"
    );
    assert_eq!(
        pool.get("ioRunning").and_then(|v| v.as_u64()),
        Some(0),
        "初始 IO 泳道空: {pool}"
    );

    // 阻塞 IO 车道:inspectArchive 对 FIFO open(O_RDONLY)阻塞等写端——
    // 真实阻塞 IO 面入后台泳道(Background+Io)。
    next_id += 1;
    let blocked_id = next_id;
    send(
        &mut proc,
        &rpc_request(
            blocked_id,
            "$/kode/dbClone/inspectArchive",
            json!({ "path": fifo.to_string_lossy() }),
        ),
    );

    // 阻塞期:ioRunning=1(在飞记账),cpuRunning=0(echo 未走 CPU 泳道)。
    let pool = wait_pool_io_running(&mut proc, &mut next_id, 1, Duration::from_secs(10));
    assert_eq!(
        pool.get("cpuRunning").and_then(|v| v.as_u64()),
        Some(0),
        "IO 阻塞期 CPU 泳道应空: {pool}"
    );

    // 阻塞期交互车道照常:echo 立即往返(IO 满载不吞交互)。
    next_id += 1;
    let echo_id = next_id;
    send(
        &mut proc,
        &rpc_request(
            echo_id,
            "$/kode/echo",
            json!({ "msg": "lane-separation" }),
        ),
    );
    let echo = result_of(wait_response(&proc, echo_id, Duration::from_secs(5)));
    assert_eq!(
        echo.get("msg").and_then(|v| v.as_str()),
        Some("lane-separation"),
        "交互 RPC 应在 IO 阻塞期照常往返: {echo}"
    );
    // IO job 仍阻塞在飞(交互往返未挤掉它),记账如实。
    let pool = pool_of(&health_of(&mut proc, &mut next_id));
    assert_eq!(
        pool.get("ioRunning").and_then(|v| v.as_u64()),
        Some(1),
        "交互往返后 IO job 仍应在飞: {pool}"
    );

    // 解阻塞:写端打开(与阻塞的读端配对)+ 写垃圾 → handler 失败。
    let mut writer = std::fs::File::create(&fifo).expect("open fifo write end");
    let _ = writer.write_all(&[b'x'; 128]);
    drop(writer);
    let blocked = wait_response(&proc, blocked_id, Duration::from_secs(10));
    let err = blocked
        .get("error")
        .cloned()
        .unwrap_or_else(|| panic!("垃圾字节应失败: {blocked}"));
    assert_eq!(
        err.get("code").and_then(|v| v.as_i64()),
        Some(-32602),
        "坏魔数 = 参数/内容错(非 method not found): {err}"
    );

    // 失败后无占位泄漏:泳道位释放(ioRunning 回 0),终态计数入账。
    let pool = wait_pool_io_running(&mut proc, &mut next_id, 0, Duration::from_secs(10));
    assert_eq!(
        pool.get("jobsFailed").and_then(|v| v.as_u64()),
        Some(1),
        "失败计数应入账: {pool}"
    );
    assert!(
        pool.get("jobsDone").and_then(|v| v.as_u64()).unwrap_or(0) >= 1,
        "echo 完成计数应入账: {pool}"
    );

    let _ = std::fs::remove_file(&fifo);

    // 干净退出(排空语义不受泳道记账影响)。
    next_id += 1;
    send(&mut proc, &request(next_id, "shutdown", json!({})));
    let _ = wait_response(&proc, next_id, Duration::from_secs(30));
    send(&mut proc, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match proc.child.try_wait().expect("try_wait") {
            Some(status) => {
                assert!(status.success(), "shutdown+exit 应干净退出: {status}");
                break;
            }
            None => {
                assert!(Instant::now() < deadline, "server did not exit in time");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
