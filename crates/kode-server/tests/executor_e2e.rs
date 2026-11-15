//! RUST-075-W 真子进程 E2E:默认装配(非测试注入)必须走 worker 执行器。
//!
//! 验收面(todo RUST-075-W):真实子进程跑受控重任务时,健康/轻请求先回;
//! worker 数不越预算(健康 pool.workers);错误/取消后容量释放(记账归零);
//! 默认路径确实用执行器(健康 pool.jobsDone 只能来自池结算)。

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// 子进程守护:测试任何路径退出都杀掉,不留孤儿 server。
struct ServerProc {
    child: Child,
    rx: Receiver<Value>,
    /// stderr 行收集(诊断/断言两用;None = stderr 未收集)。
    err_rx: Option<Receiver<String>>,
}

impl ServerProc {
    /// 已到达的 stderr 行快照(非阻塞收干)。
    fn stderr_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(rx) = &self.err_rx {
            while let Ok(line) = rx.try_recv() {
                lines.push(line);
            }
        }
        lines
    }
}

impl Drop for ServerProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_server() -> ServerProc {
    spawn_server_with_stderr()
}

/// RUST-068-W:stderr 同步 piped 收集(span 留痕/脱敏断言的数据源),
/// 逐行转发进 channel;主测试经 `stderr_lines()` 按需取用。
fn spawn_server_with_stderr() -> ServerProc {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kode-server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kode-server");
    let stderr = child.stderr.take().expect("stderr piped");
    let (err_tx, err_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if err_tx.send(line).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            // 逐行读 header;空行后按 Content-Length 读 body。
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
    // err_tx 随 reader 线程存活;ServerProc Drop 杀进程后 channel 断开。
    ServerProc {
        child,
        rx,
        err_rx: Some(err_rx),
    }
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

/// 等指定 id 的响应(超时即红;非目标消息按乱序回包丢弃继续等)。
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
                panic!(
                    "server stdout closed before response for id {id}; stderr so far:\n{}",
                    proc.stderr_lines().join("\n")
                )
            }
        }
    }
}

/// 收下一条任何响应(乱序对账用;超时 None)。
fn next_response(proc: &ServerProc, timeout: Duration) -> Option<Value> {
    proc.rx.recv_timeout(timeout).ok()
}

/// 重任务语料:~4 万行真实形态 python(类 + 数万 filler 方法),无
/// versionKey → 不缓存,每次现解析,worker 侧真实计算数百毫秒量级。
fn big_lines() -> Vec<String> {
    let mut lines = vec![
        "class Avatar:".to_string(),
        "    def __init__(self):".to_string(),
        "        self.hp = 100".to_string(),
        "    def take_damage(self, n):".to_string(),
        "        self.hp -= n".to_string(),
    ];
    for i in 0..20_000 {
        lines.push(format!("    def filler_{i}(self):"));
        lines.push("        pass".to_string());
    }
    lines
}

#[test]
fn pool_serves_heavy_task_while_light_requests_return_first() {
    let mut proc = spawn_server();

    // 握手:initialize → initialized。
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

    // 默认装配:健康面必须带 pool 键(worker 数=预算,≥1)。
    send(&mut proc, &request(2, "$/kode/health", json!({})));
    let health = wait_response(&proc, 2, Duration::from_secs(30));
    let pool = health
        .pointer("/result/pool")
        .expect("默认装配健康面必须带 pool 键(执行器真装配,非测试注入)");
    assert!(
        pool.get("workers").and_then(|w| w.as_u64()).unwrap_or(0) >= 1,
        "pool.workers >= 1: {pool}"
    );

    // 重任务入池;紧跟一发轻健康。轻请求必须先回(泵不被重任务阻塞)。
    let heavy = request(
        10,
        "$/kode/rpc",
        json!({
            "method": "$/kode/python/selfAttributeFlow",
            "params": { "lines": big_lines(), "queryLine": 4, "attr": "hp" }
        }),
    );
    send(&mut proc, &heavy);
    send(&mut proc, &request(11, "$/kode/health", json!({})));
    let first =
        next_response(&proc, Duration::from_secs(30)).expect("重任务在飞时至少应有轻响应先回");
    assert_eq!(
        first.get("id").and_then(|v| v.as_i64()),
        Some(11),
        "健康必须先于重任务回包(乱序回包=执行器真在跑): {first}"
    );

    // 重任务回包:流引擎真算出 self.hp 流型(非空)。
    let done = wait_response(&proc, 10, Duration::from_secs(120));
    let flow = done.pointer("/result/flow").expect("selfAttributeFlow 应回 flow");
    assert!(
        flow.get("types").and_then(|t| t.as_array()).map(|t| !t.is_empty()).unwrap_or(false),
        "重任务必须真执行(非空 types): {flow}"
    );

    // 池记账:jobsDone 只能来自池结算(默认路径真用执行器),容量已释放。
    send(&mut proc, &request(12, "$/kode/health", json!({})));
    let health = wait_response(&proc, 12, Duration::from_secs(30));
    let pool = health.pointer("/result/pool").expect("pool 键仍在");
    assert!(
        pool.get("jobsDone").and_then(|v| v.as_u64()).unwrap_or(0) >= 1,
        "jobsDone >= 1(默认路径走池): {pool}"
    );
    assert_eq!(
        pool.get("interactiveRunning").and_then(|v| v.as_u64()),
        Some(0),
        "重任务完成后容量释放: {pool}"
    );

    // 错误释放:未知内层 method → -32601,记账 jobsFailed 且容量归零。
    send(
        &mut proc,
        &request(
            20,
            "$/kode/rpc",
            json!({ "method": "$/kode/test/absent", "params": {} }),
        ),
    );
    let failed = wait_response(&proc, 20, Duration::from_secs(30));
    assert_eq!(
        failed.pointer("/error/code").and_then(|c| c.as_i64()),
        Some(-32601),
        "未知 method 映射 -32601: {failed}"
    );
    send(&mut proc, &request(21, "$/kode/health", json!({})));
    let health = wait_response(&proc, 21, Duration::from_secs(30));
    let pool = health.pointer("/result/pool").expect("pool 键仍在");
    assert!(
        pool.get("jobsFailed").and_then(|v| v.as_u64()).unwrap_or(0) >= 1,
        "jobsFailed >= 1(错误结算): {pool}"
    );
    assert_eq!(
        pool.get("interactiveRunning").and_then(|v| v.as_u64()),
        Some(0),
        "错误后容量同样释放: {pool}"
    );

    // 干净退出:shutdown + exit。
    send(&mut proc, &request(30, "shutdown", json!({})));
    wait_response(&proc, 30, Duration::from_secs(30));
    send(&mut proc, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match proc.child.try_wait().expect("try_wait") {
            Some(status) => break status,
            None => {
                assert!(Instant::now() < deadline, "server did not exit in time");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    assert!(status.success(), "shutdown+exit 应干净退出: {status}");
}

/// RUST-068-W:同一请求跨任务可追踪、并发请求不串 span、日志脱敏。
/// 三面留痕 = 主循环 dispatch / worker 起跑 / 池回包,同一 (id, span) 贯穿;
/// params 内容(SECRETPAYLOAD)绝不进 stderr。只打印请求 id 不算完成。
#[test]
fn pool_span_id_traces_across_tasks_without_param_leaks() {
    let mut proc = spawn_server_with_stderr();

    send(&mut proc, &request(1, "initialize", json!({ "capabilities": {} })));
    wait_response(&proc, 1, Duration::from_secs(30));
    send(&mut proc, &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }));

    // 两个并发池任务,信封各带不同 span;params 内放敏感标记验证脱敏。
    // request 10:真实流引擎 handler(小语料,handler 成功结算即可)。
    send(
        &mut proc,
        &request(
            10,
            "$/kode/rpc",
            json!({
                "method": "$/kode/python/selfAttributeFlow",
                "params": {
                    "lines": ["class A:", "    def f(self):", "        self.x = SECRETPAYLOAD"],
                    "queryLine": 2,
                    "attr": "x"
                },
                "spanId": "e2espan000000000a"
            }),
        ),
    );
    // request 11:轻 echo(注册 builtin,快;乱序面);不同 span。
    // 注:内层不用 $/kode/health——它是生命周期面,只在内联路径,不在池快照。
    send(
        &mut proc,
        &request(
            11,
            "$/kode/rpc",
            json!({ "method": "$/kode/echo", "params": {}, "spanId": "e2espan000000000b" }),
        ),
    );

    // 两请求并发,回包乱序(内层 health 快,可能先回);单循环并收两个
    // id,绝不丢弃(丢弃会让后找的 id 永远等不到)。
    let mut done_flow: Option<Value> = None;
    let mut done_health: Option<Value> = None;
    let collect_deadline = Instant::now() + Duration::from_secs(120);
    while done_flow.is_none() || done_health.is_none() {
        assert!(
            Instant::now() < collect_deadline,
            "responses incomplete (flow={}, health={})",
            done_flow.is_some(),
            done_health.is_some()
        );
        match proc.rx.try_recv() {
            Ok(value) => {
                match value.get("id").and_then(|v| v.as_i64()) {
                    Some(10) => done_flow = Some(value),
                    Some(11) => done_health = Some(value),
                    _ => {}
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let done_flow = done_flow.expect("id 10 collected");
    assert!(
        done_flow.get("result").is_some(),
        "流 handler 应成功结算(非 Failed/Cancelled): {done_flow}"
    );
    let done_health = done_health.expect("id 11 collected");
    assert!(
        done_health.get("result").is_some(),
        "echo handler 应成功结算: {done_health}"
    );

    // 三面留痕证据:每个请求的 dispatch / start / response 行同 span。
    // 响应落盘前 drainer 的 stderr 行已写出(先日志后写 stdout),证据应
    // 很快齐;仍给有界窗口防调度抖动。
    let mut evidence = std::collections::HashSet::new();
    for id in [10, 11] {
        for face in ["dispatched", "start", "response"] {
            evidence.insert(format!("{id}/{face}"));
        }
    }
    let mut lines: Vec<String> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !evidence.is_empty() {
        if Instant::now() >= deadline {
            panic!(
                "stderr 证据不齐(缺 {evidence:?});已收 {} 行:\n{}",
                lines.len(),
                lines.join("\n")
            );
        }
        std::thread::sleep(Duration::from_millis(20));
        for line in proc.stderr_lines() {
            let want_span = |id: i64| {
                if id == 10 {
                    "e2espan000000000a"
                } else {
                    "e2espan000000000b"
                }
            };
            for id in [10, 11] {
                // dispatch 面: request {id} dispatched (pool: … span=…)
                if line.contains(&format!("request #{id} dispatched (pool:")) {
                    assert!(
                        line.contains(&format!("span={}", want_span(id))),
                        "dispatch span 必须与信封同源: {line}"
                    );
                    evidence.remove(&format!("{id}/dispatched"));
                }
                // worker 起跑面:pool job {id} … start (span=…)
                if line.contains(&format!("pool job #{id} ")) && line.contains(" start (span=") {
                    assert!(
                        line.contains(&format!("span={}", want_span(id))),
                        "worker 起跑 span 必须与 dispatch 同源: {line}"
                    );
                    evidence.remove(&format!("{id}/start"));
                }
                // 回包面:pool response {id} done (span=…)
                if line.contains(&format!("pool response #{id} done (span=")) {
                    assert!(
                        line.contains(&format!("span={}", want_span(id))),
                        "回包 span 必须与请求同源(并发不串): {line}"
                    );
                    evidence.remove(&format!("{id}/response"));
                }
            }
            lines.push(line);
        }
    }

    // 脱敏:params 内容(SECRETPAYLOAD)绝不进任何 stderr 行。
    for line in &lines {
        assert!(
            !line.contains("SECRETPAYLOAD"),
            "params 内容泄漏进日志: {line}"
        );
    }

    // 收尾干净退出。
    send(&mut proc, &request(30, "shutdown", json!({})));
    wait_response(&proc, 30, Duration::from_secs(30));
    send(&mut proc, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match proc.child.try_wait().expect("try_wait") {
            Some(status) => break status,
            None => {
                assert!(Instant::now() < deadline, "server did not exit in time");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    assert!(status.success(), "shutdown+exit 应干净退出: {status}");
}
