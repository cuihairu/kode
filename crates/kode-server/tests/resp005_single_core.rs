//! KODE-RESP-005 验收受注(真二进制 e2e,单核亲和):available_parallelism=1
//! 下后台 IO 面 RPC(dbClone/ruff/scanAnchors 形态)真实出结果;排队时
//! shutdown+exit 在预算内退出。不只断言预算数字——修复前 from_total(1)
//! 的 background_max=0/io_max=0 使该面请求永无回包,且 draining join
//! 永久挂起(进程不退出)。
//!
//! 单核注入 = `taskset -c 0`(sched_getaffinity 反映进
//! std::thread::available_parallelism);无 taskset 的环境跳过(CI linux
//! 装载 util-linux)。

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

/// taskset -c 0 下拉起真二进制;taskset 缺席 → None(调用方跳过)。
fn spawn_single_core_server() -> Option<ServerProc> {
    let probe = Command::new("taskset").arg("-c").arg("0").arg("true").output();
    if probe.is_err() {
        return None;
    }
    let mut child = Command::new("taskset")
        .args(["-c", "0"])
        .arg(env!("CARGO_BIN_EXE_kode-server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn kode-server under taskset");
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
    Some(ServerProc { child, rx })
}

fn send(proc: &mut ServerProc, value: &Value) {
    let body = serde_json::to_vec(value).expect("serialize");
    let stdin = proc.child.stdin.as_mut().expect("stdin piped");
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).expect("write header");
    stdin.write_all(&body).expect("write body");
    stdin.flush().expect("flush");
}

fn wait_response(proc: &ServerProc, id: i64, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        assert!(!remain.is_zero(), "await id {id} timed out");
        match proc.rx.recv_timeout(remain) {
            Ok(value) => {
                if value.get("id") == Some(&json!(id)) {
                    return value;
                }
            }
            Err(RecvTimeoutError::Timeout) => panic!("await id {id} timed out"),
            Err(RecvTimeoutError::Disconnected) => panic!("server exited before id {id}"),
        }
    }
}

fn initialize(proc: &mut ServerProc) {
    send(
        proc,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "processId": null, "rootUri": "file:///tmp", "capabilities": {} }
        }),
    );
    let _ = wait_response(proc, 1, Duration::from_secs(30));
    send(
        proc,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );
}

fn scan_anchors_request(id: i64, root: &str) -> Value {
    json!({
        "jsonrpc": "2.0", "id": id, "method": "$/kode/rpc",
        "params": { "method": "$/kode/workspace/scanAnchors", "params": { "root": root } }
    })
}

/// 真实 fixture 根(有 entities_xml/entity_defs 的在役夹具)。
fn fixture_root() -> String {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../kode-root/tests/fixtures/linux_assets");
    root.to_string_lossy().into_owned()
}

#[test]
fn single_core_pool_serves_real_scan_anchors() {
    let Some(mut server) = spawn_single_core_server() else {
        println!("taskset unavailable; skipping");
        return;
    };
    initialize(&mut server);

    // 单核亲和下真实后台 IO 面 RPC:scanAnchors 真扫盘出结果。
    let sent = Instant::now();
    send(&mut server, &scan_anchors_request(2, &fixture_root()));
    let response = wait_response(&server, 2, Duration::from_secs(30));
    let latency = sent.elapsed();
    let entity_defs_nonempty = response
        .pointer("/result/entityDefs")
        .and_then(Value::as_array)
        .map(|arr| !arr.is_empty())
        .unwrap_or(false);
    assert!(
        entity_defs_nonempty,
        "单核下 scanAnchors 必须真实出结果: {response}"
    );
    println!("scanAnchors under taskset -c 0: {latency:?}");

    // 装配下限观测:健康面 pool.workers ≥ 2(交互 1 + IO 面 1)。
    send(
        &mut server,
        &json!({ "jsonrpc": "2.0", "id": 3, "method": "$/kode/health" }),
    );
    let health = wait_response(&server, 3, Duration::from_secs(30));
    let workers = health
        .pointer("/result/pool/workers")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    assert!(workers >= 2, "单核装配下限 2 应入健康面: {health}");
}

#[test]
fn single_core_exit_bounded_with_queued_background_jobs() {
    let Some(mut server) = spawn_single_core_server() else {
        println!("taskset unavailable; skipping");
        return;
    };
    initialize(&mut server);

    // 排队即退:两发后台 IO 面 scanAnchors 入队后立刻 shutdown+exit。
    // 修复前:background 永不准入 → draining 排空等不到 → join 挂死,
    // 进程不退出。修复后:下限预算准入(或安全网取消),退出有界。
    let root = fixture_root();
    send(&mut server, &scan_anchors_request(10, &root));
    send(&mut server, &scan_anchors_request(11, &root));
    send(
        &mut server,
        &json!({ "jsonrpc": "2.0", "id": 20, "method": "shutdown", "params": {} }),
    );
    let _ = wait_response(&server, 20, Duration::from_secs(30));
    let started = Instant::now();
    send(
        &mut server,
        &json!({ "jsonrpc": "2.0", "method": "exit" }),
    );
    let deadline = Duration::from_secs(10);
    loop {
        match server.child.try_wait().expect("try wait") {
            Some(status) => {
                assert!(
                    status.success(),
                    "shutdown+exit 应干净退出: {status}"
                );
                assert!(
                    started.elapsed() < deadline,
                    "排队后台 job 时退出超预算: {:?}",
                    started.elapsed()
                );
                println!("exit with queued jobs: {:?}", started.elapsed());
                server.child.kill().ok();
                return;
            }
            None => {
                assert!(
                    started.elapsed() < deadline,
                    "单核排队后台 job 时进程未在 {deadline:?} 内退出(挂死复发)"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
