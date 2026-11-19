//! KODE-RESP-001 验收受注(真二进制 e2e):ingest 解析风暴期间,协议面
//! (health/hover/取消)的响应延迟有界——p95/p99/最长无响应间隔实测记录,
//! 不只断言切片条数。
//!
//! 负载形态:30 × ~200KB def 经 didOpen 连续入队(overlay 内联解析正是
//! 墙钟切片所界的剩余在途成本;读盘离线由 index_queue 单测钉)。随后在
//! 风暴进行中串行打 `$/kode/health` ×20 + hover ×1 + `$/kode/wait` 即刻
//! 取消,逐请求记回合时延。断言阈值=回归护栏(量级远高于实测;真实数字
//! 进断言消息,失败即留档)。

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct ServerProc {
    child: Child,
    rx: Receiver<(Value, Instant)>,
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
    let (tx, rx) = mpsc::channel::<(Value, Instant)>();
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
                    let at = Instant::now();
                    if tx.send((value, at)).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    ServerProc { child, rx }
}

impl ServerProc {
    fn send(&mut self, value: &Value) {
        let body = serde_json::to_vec(value).expect("serialize");
        let stdin = self.child.stdin.as_mut().expect("stdin piped");
        write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).expect("write header");
        stdin.write_all(&body).expect("write body");
        stdin.flush().expect("flush");
    }

    /// 等指定 id 的响应,返回(响应, 回合时延)。超时 panic(带 10s 硬界)。
    fn await_id(&mut self, id: u64, sent: Instant) -> (Value, Duration) {
        let deadline = Duration::from_secs(10);
        loop {
            match self.rx.recv_timeout(deadline) {
                Ok((value, at)) => {
                    if value.get("id") == Some(&json!(id)) {
                        return (value, sent.elapsed());
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    panic!("await id {id} timed out after 10s");
                }
                Err(RecvTimeoutError::Disconnected) => panic!("server exited"),
            }
        }
    }
}

/// ~200KB 合成 def(重复属性块;可解析,hover 位在第 3 行 Type 内)。
fn big_def(file_index: usize) -> String {
    let mut text = String::from("<root>\n\t<Properties>\n");
    for i in 0..2500 {
        text.push_str(&format!(
            "\t\t<p{file_index}_{i}>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</p{file_index}_{i}>\n"
        ));
    }
    text.push_str("\t</Properties>\n</root>\n");
    text
}

/// 分位数(最近邻秩;p∈0..=100)。
fn percentile(mut samples: Vec<f64>, p: f64) -> f64 {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rank = ((p / 100.0) * (samples.len() - 1) as f64).round() as usize;
    samples[rank]
}

fn stats_line(label: &str, samples_ms: &[f64]) -> String {
    let owned: Vec<f64> = samples_ms.to_vec();
    format!(
        "{label}: n={} p50={:.0}ms p95={:.0}ms p99={:.0}ms max={:.0}ms",
        samples_ms.len(),
        percentile(owned.clone(), 50.0),
        percentile(owned.clone(), 95.0),
        percentile(owned.clone(), 99.0),
        percentile(owned, 100.0),
    )
}

#[test]
fn responsiveness_under_ingest_storm() {
    let mut server = spawn_server();
    // 握手(rootUri 任意存在目录;本测试不依赖盘扫描)。
    let sent = Instant::now();
    server.send(&json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "processId": null, "rootUri": "file:///tmp", "capabilities": {} }
    }));
    let _ = server.await_id(1, sent);

    // 风暴:30 × ~200KB def didOpen 连续帧(解析在帧间/空闲切片分摊)。
    for i in 0..30 {
        server.send(&json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": format!("file:///w/storm{i}.def"),
                    "languageId": "kbengine-def",
                    "version": 1,
                    "text": big_def(i)
                }
            }
        }));
    }

    // 风暴进行中:health ×20 串行(回合时延=协议面无响应间隔样本)。
    let mut health_ms: Vec<f64> = Vec::new();
    for id in 2..=21 {
        let sent = Instant::now();
        server.send(&json!({
            "jsonrpc": "2.0", "id": id, "method": "$/kode/health"
        }));
        let (_, latency) = server.await_id(id, sent);
        health_ms.push(latency.as_millis() as f64);
    }

    // hover 一发(def Type 位;时延为观测,内容不判)。
    let sent = Instant::now();
    server.send(&json!({
        "jsonrpc": "2.0", "id": 22, "method": "textDocument/hover",
        "params": { "textDocument": { "uri": "file:///w/storm0.def" },
                    "position": { "line": 3, "character": 12 } }
    }));
    let (_, hover_latency) = server.await_id(22, sent);

    // 长请求 + 即刻取消:取消穿越风暴的回合时延。
    let sent = Instant::now();
    server.send(&json!({
        "jsonrpc": "2.0", "id": 23, "method": "$/kode/wait",
        "params": { "ms": 2000 }
    }));
    // 取消与 wait 隔开(独立 chunk):真实客户端取消总在观察无响应之后,
    // 同批写入会被合读成一个 chunk——poll() 只见新字节,兄弟帧在批内
    // 等长请求返回(CORE-007 形态边界)。
    std::thread::sleep(Duration::from_millis(25));
    server.send(&json!({
        "jsonrpc": "2.0", "method": "$/cancelRequest",
        "params": { "id": 23 }
    }));
    let (cancel_response, cancel_latency) = server.await_id(23, sent);
    assert_eq!(cancel_response["error"]["code"], json!(-32800), "应答取消");

    // 回归护栏(量级阈值,真实数字进消息留档)。
    let hover_ms = hover_latency.as_millis() as f64;
    let cancel_ms = cancel_latency.as_millis() as f64;
    assert!(
        percentile(health_ms.clone(), 99.0) < 1000.0,
        "health p99 超护栏: {} | hover={hover_ms:.0}ms cancel={cancel_ms:.0}ms",
        stats_line("health", &health_ms)
    );
    assert!(
        health_ms.iter().cloned().fold(0.0_f64, f64::max) < 2000.0,
        "health 最长无响应间隔超护栏: {}",
        stats_line("health", &health_ms)
    );
    assert!(
        cancel_ms < 1000.0,
        "取消回合超护栏: cancel={cancel_ms:.0}ms | {}",
        stats_line("health", &health_ms)
    );
    // 实测记录(stdout 落档;--nocapture 可见)。
    println!("{}", stats_line("health", &health_ms));
    println!("hover: {hover_ms:.0}ms  cancel: {cancel_ms:.0}ms");
}
