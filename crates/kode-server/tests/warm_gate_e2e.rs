//! RUST-074-W 真子进程 E2E:暖门四面接真实服务端(todo 验收口径)。
//!
//! 「不能仅调用 scheduler 纯函数验收」:本套件走真实 stdio 子进程——
//! 可控屏障(begin 后不发 complete 挂住 Warming)期间真实 RPC(selfAttributeFlow)
//! 照常解析目标文件;warmState/健康面显式 incomplete(state=warming +
//! coldWhileWarming 计数);complete → Warm 刷新;cancel → Idle 不留假
//! pending;迟到 complete 诚实报错。

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
            Err(RecvTimeoutError::Disconnected) => panic!("server stdout closed before response for id {id}"),
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

fn assert_clean_exit(mut proc: ServerProc) {
    send(&mut proc, &request(90, "shutdown", json!({})));
    let _ = wait_response(&proc, 90, Duration::from_secs(30));
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

/// 真实解析目标文件:5 行真实形态实体(0 基 queryLine=4 → `self.hp -= n`)。
fn avatar_lines() -> Vec<String> {
    vec![
        "class Avatar:".to_string(),
        "    def __init__(self):".to_string(),
        "        self.hp = 100".to_string(),
        "    def take_damage(self, n):".to_string(),
        "        self.hp -= n".to_string(),
    ]
}

#[test]
fn warm_gate_full_lifecycle_with_barrier_and_real_rpc() {
    let mut proc = spawn_server();

    // 握手。
    send(&mut proc, &request(1, "initialize", json!({ "capabilities": {} })));
    let init = wait_response(&proc, 1, Duration::from_secs(30));
    assert!(
        init.get("result").map(|r| !r.is_null()).unwrap_or(false),
        "initialize 应成功: {init}"
    );
    send(
        &mut proc,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );

    // 初始:idle 全形状(total 从未 begin = null)。
    send(&mut proc, &request(2, "$/kode/index/warmState", json!({})));
    let warm = result_of(wait_response(&proc, 2, Duration::from_secs(30)));
    assert_eq!(
        warm,
        json!({ "state": "idle", "coldWhileWarming": 0, "done": 0, "failed": 0, "total": null }),
        "初始暖态应 idle 全形状: {warm}"
    );

    // 可控屏障:begin(1000) 后不发 complete——首扫挂住 = Warming。
    send(
        &mut proc,
        &request(3, "$/kode/index/beginBackgroundScan", json!({ "total": 1000 })),
    );
    let begun = result_of(wait_response(&proc, 3, Duration::from_secs(30)));
    assert_eq!(
        begun,
        json!({ "state": "warming", "decision": "queued", "scanId": 1 }),
        "begin 应入队 Warming: {begun}"
    );
    // 进行中复用:同 key 第二次 begin 不重入队。
    send(
        &mut proc,
        &request(4, "$/kode/index/beginBackgroundScan", json!({ "total": 1000 })),
    );
    let reused = result_of(wait_response(&proc, 4, Duration::from_secs(30)));
    assert_eq!(
        reused,
        json!({ "state": "warming", "decision": "reused", "scanId": 1 }),
        "进行中 begin 应复用: {reused}"
    );

    // 屏障期真实 RPC:目标文件照常解析(池交互优先级,请求不等首扫)。
    send(
        &mut proc,
        &request(
            10,
            "$/kode/rpc",
            json!({
                "method": "$/kode/python/selfAttributeFlow",
                "params": { "lines": avatar_lines(), "queryLine": 4, "attr": "hp" }
            }),
        ),
    );
    let flow = result_of(wait_response(&proc, 10, Duration::from_secs(30)));
    let types = flow
        .pointer("/flow/types")
        .and_then(|t| t.as_array())
        .expect("真实解析应产出 flow.types")
        .clone();
    assert!(
        types.iter().any(|t| t.as_str() == Some("int")),
        "屏障期真实 RPC 应解析出 hp:int: {flow}"
    );

    // 未覆盖显式 incomplete:warmState 诚实声明 warming + 冷请求计数。
    send(&mut proc, &request(11, "$/kode/index/warmState", json!({})));
    let warm = result_of(wait_response(&proc, 11, Duration::from_secs(30)));
    assert_eq!(warm.get("state").and_then(|s| s.as_str()), Some("warming"));
    let cold = warm
        .get("coldWhileWarming")
        .and_then(|c| c.as_u64())
        .expect("coldWhileWarming number");
    assert!(cold >= 1, "Warming 期真实 RPC 应计入冷请求观测: {warm}");

    // 健康面 warm 键同源。
    send(&mut proc, &request(12, "$/kode/health", json!({})));
    let health = wait_response(&proc, 12, Duration::from_secs(30));
    assert_eq!(
        health.pointer("/result/warm/state").and_then(|s| s.as_str()),
        Some("warming"),
        "健康面应带 warming 暖态: {health}"
    );

    // 首扫完成 → Warm(刷新 = 计数落账)。
    send(
        &mut proc,
        &request(13, "$/kode/index/scanComplete", json!({ "done": 1000, "failed": 0 })),
    );
    let completed = result_of(wait_response(&proc, 13, Duration::from_secs(30)));
    assert_eq!(
        completed,
        json!({ "state": "warm", "done": 1000, "failed": 0 }),
        "complete 应泵至 Warm: {completed}"
    );
    send(&mut proc, &request(14, "$/kode/index/warmState", json!({})));
    let warm = result_of(wait_response(&proc, 14, Duration::from_secs(30)));
    assert_eq!(warm.get("state").and_then(|s| s.as_str()), Some("warm"));
    assert_eq!(warm.get("done").and_then(|d| d.as_u64()), Some(1000));
    assert_eq!(warm.get("total").and_then(|t| t.as_u64()), Some(1000));

    // 刷新循环:Warm 后再 begin = 全新入队(根变化 → 重镜像)。
    send(
        &mut proc,
        &request(15, "$/kode/index/beginBackgroundScan", json!({ "total": 5 })),
    );
    let requeue = result_of(wait_response(&proc, 15, Duration::from_secs(30)));
    assert_eq!(
        requeue.get("decision").and_then(|d| d.as_str()),
        Some("queued"),
        "Warm 后 begin 应全新入队: {requeue}"
    );

    // 取消 → Idle,不留假 pending;迟到 complete 诚实报错。
    send(&mut proc, &request(16, "$/kode/index/scanCancel", json!({})));
    let cancelled = result_of(wait_response(&proc, 16, Duration::from_secs(30)));
    assert_eq!(cancelled, json!({ "state": "idle" }), "cancel 应回 Idle: {cancelled}");
    send(
        &mut proc,
        &request(17, "$/kode/index/scanComplete", json!({ "done": 5, "failed": 0 })),
    );
    let late = wait_response(&proc, 17, Duration::from_secs(30));
    let message = late
        .pointer("/error/message")
        .and_then(|m| m.as_str())
        .expect("迟到 complete 应错误信封");
    assert!(
        message.contains("no background scan in progress"),
        "迟到 complete 诚实报错: {late}"
    );
    assert_eq!(
        late.pointer("/error/code").and_then(|c| c.as_i64()),
        Some(-32602),
        "迟到 complete 应 -32602: {late}"
    );

    // 取消后暖态 idle,冷请求观测保留(会话级累计);幂等 cancel。
    send(&mut proc, &request(18, "$/kode/index/warmState", json!({})));
    let warm = result_of(wait_response(&proc, 18, Duration::from_secs(30)));
    assert_eq!(warm.get("state").and_then(|s| s.as_str()), Some("idle"));
    assert_eq!(
        warm.get("coldWhileWarming").and_then(|c| c.as_u64()),
        Some(cold),
        "冷请求观测应保留: {warm}"
    );
    send(&mut proc, &request(19, "$/kode/index/scanCancel", json!({})));
    let idle = result_of(wait_response(&proc, 19, Duration::from_secs(30)));
    assert_eq!(idle, json!({ "state": "idle" }), "幂等 cancel: {idle}");
    send(&mut proc, &request(20, "$/kode/health", json!({})));
    let health = wait_response(&proc, 20, Duration::from_secs(30));
    assert_eq!(
        health.pointer("/result/warm/state").and_then(|s| s.as_str()),
        Some("idle"),
        "健康面应回 idle: {health}"
    );

    assert_clean_exit(proc);
}
