//! RUST-070/071/073 真子进程 E2E:索引刷新队列(todo 验收口径)。
//! RUST-082:didChange 风暴缓冲——同文件并一(最新版胜出)、请求入口
//! take_buffered 立即移交(严格收敛一次执行)、窗口到期 flush_due 落批
//! (max latency 兑现),健康面 storm* 记账全程对账。
//!
//! 「不能仅调用队列纯函数验收」:本套件走真实 stdio 子进程——didOpen 后
//! 立即 hover 命中新语料(请求入口 freshen 自键);连续 didChange 风暴
//! (v2/v3/v4)收敛为一次执行(展示最新版);didClose 后盘上文件回读
//! 磁盘重蓄(关闭 ≠ 删除,候选不消失)——全程健康面 `ingest` 记账对账。

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

fn notify(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
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
        .and_then(|r| if r.is_null() { None } else { Some(r.clone()) })
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

fn def_with(prop: &str) -> String {
    format!("<root>\n\t<Properties>\n\t\t<{prop}>\n\t\t\t<Type> UINT32 </Type>\n\t\t</{prop}>\n\t</Properties>\n</root>\n")
}

#[test]
fn index_queue_open_fresh_storm_converges_and_close_replays_disk() {
    let dir = std::env::temp_dir().join(format!("kode-iq-e2e-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("scripts/entity_defs")).unwrap();
    let def_path = dir.join("scripts/entity_defs/Avatar.def");
    std::fs::write(&def_path, def_with("diskmark")).unwrap();
    let def_uri = format!("file://{}", def_path.display());
    let entities_uri = format!("file://{}/scripts/entities.xml", dir.display());

    let mut proc = spawn_server();
    send(
        &mut proc,
        &request(
            1,
            "initialize",
            json!({ "processId": 1, "rootUri": format!("file://{}", dir.display()), "capabilities": {} }),
        ),
    );
    assert!(
        result_of(wait_response(&proc, 1, Duration::from_secs(30)))
            .get("capabilities")
            .is_some(),
        "initialize 应成功"
    );
    send(&mut proc, &notify("initialized", json!({})));

    // 打开哨兵文件(链接面载体)+ 语料文件(overlay 与盘不同内容)。
    send(
        &mut proc,
        &notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": entities_uri, "languageId": "xml", "version": 1,
                "text": "<root>\n  <Avatar/>\n</root>\n" } }),
        ),
    );
    send(
        &mut proc,
        &notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": def_uri, "languageId": "kbengine-def", "version": 1,
                "text": def_with("openmark") } }),
        ),
    );

    // 打开文档立即新鲜:请求入口 freshen 自键,hover 命中 overlay 语料。
    send(
        &mut proc,
        &request(
            10,
            "textDocument/hover",
            json!({ "textDocument": { "uri": def_uri }, "position": { "line": 2, "character": 3 } }),
        ),
    );
    let hover = result_of(wait_response(&proc, 10, Duration::from_secs(30)));
    let open_md = hover
        .pointer("/contents/value")
        .and_then(|v| v.as_str())
        .expect("def property hover markdown")
        .to_string();
    assert!(
        open_md.contains("**openmark**"),
        "打开文档 hover 应立即反映 ingest(请求入口 freshen): {open_md}"
    );
    // 基线记账(open 两文件各入队即执行;open 不进风暴窗,storm 计数应为零)。
    let (base_enq, base_exec, base_seen, base_merged, base_df, base_ff) = {
        send(&mut proc, &request(11, "$/kode/health", json!({})));
        let health = result_of(wait_response(&proc, 11, Duration::from_secs(30)));
        let ingest = health
            .get("ingest")
            .cloned()
            .expect("health missing ingest");
        assert_eq!(
            ingest.get("executed").and_then(|v| v.as_u64()),
            Some(2),
            "两文件 open 各执行一次 ingest: {ingest}"
        );
        let counter = |name: &str| -> u64 {
            ingest
                .get(name)
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| panic!("missing {name}: {ingest}"))
        };
        (
            counter("enqueued"),
            counter("executed"),
            counter("stormSeen"),
            counter("stormMerged"),
            counter("stormDeadlineFlushes"),
            counter("stormForcedFlushes"),
        )
    };
    assert_eq!(
        (base_seen, base_merged, base_df, base_ff),
        (0, 0, 0, 0),
        "open/close 直接入队,不进风暴窗"
    );

    // 连续编辑风暴 v2/v3/v4(RUST-082):三帧拼进一次 write(单 chunk 一
    // 次 process,泵无从穿插)——didChange 全部入风暴缓冲(同文件并一、
    // 最新版本胜出),不直接入队。
    let mut burst = Vec::new();
    for (version, prop) in [(2, "openmark2"), (3, "openmark3"), (4, "openmark4")] {
        let frame = notify(
            "textDocument/didChange",
            json!({ "textDocument": { "uri": def_uri, "version": version },
                "contentChanges": [ { "text": def_with(prop) } ] }),
        );
        let body = serde_json::to_string(&frame).expect("serialize frame");
        let _ = write!(burst, "Content-Length: {}\r\n\r\n{body}", body.len());
    }
    {
        let stdin = proc.child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(&burst).expect("write burst");
        stdin.flush().expect("flush burst");
    }
    // 最新版胜出(hover 面只在 overlay 打开态成立);请求入口 take_buffered
    // 把缓冲事件立即移交并随 freshen 执行——语料严格更新到 v4。
    send(
        &mut proc,
        &request(
            12,
            "textDocument/hover",
            json!({ "textDocument": { "uri": def_uri }, "position": { "line": 2, "character": 3 } }),
        ),
    );
    let hover = result_of(wait_response(&proc, 12, Duration::from_secs(30)));
    let storm_md = hover
        .pointer("/contents/value")
        .and_then(|v| v.as_str())
        .expect("storm hover markdown")
        .to_string();
    assert!(
        storm_md.contains("**openmark4**"),
        "风暴后 hover 应展示最新版本: {storm_md}"
    );
    assert!(
        !storm_md.contains("openmark2") && !storm_md.contains("openmark3"),
        "旧版本不得残留: {storm_md}"
    );
    // 请求入口 take_buffered:缓冲事件在 hover 时立即移交(不等窗口)并
    // 随 freshen 执行——严格收敛为一次执行(单 write 已消除泵穿插)。
    send(&mut proc, &request(13, "$/kode/health", json!({})));
    let health = result_of(wait_response(&proc, 13, Duration::from_secs(30)));
    let ingest = health
        .get("ingest")
        .cloned()
        .expect("health missing ingest");
    let counter = |name: &str| -> u64 {
        ingest
            .get(name)
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| panic!("missing {name}: {ingest}"))
    };
    assert_eq!(
        counter("executed"),
        base_exec + 1,
        "风暴经 take_buffered 严格收敛为一次执行: {ingest}"
    );
    assert_eq!(
        counter("enqueued"),
        base_enq + 1,
        "缓冲移交恰好入队一次: {ingest}"
    );
    assert_eq!(counter("queued"), 0, "移交任务已执行,不得积压: {ingest}");
    assert_eq!(
        counter("stormSeen"),
        base_seen + 3,
        "三次 didChange 全部计入风暴 seen: {ingest}"
    );
    assert_eq!(
        counter("stormMerged"),
        base_merged + 2,
        "同文件并一,v2/v3 被 v4 吸收: {ingest}"
    );
    assert_eq!(
        counter("stormBuffered"),
        0,
        "缓冲已被请求入口摘走: {ingest}"
    );
    assert_eq!(
        counter("stormDeadlineFlushes"),
        base_df,
        "窗口未到期,不得有到期落批: {ingest}"
    );

    // 窗口到期落批(max latency 兑现):此段无缓冲事件(已被摘走),到期
    // 计数不得再动——严格性钉在下方 close 段之后的独立风暴里。
    send(&mut proc, &request(14, "$/kode/health", json!({})));
    let health = result_of(wait_response(&proc, 14, Duration::from_secs(30)));
    let ingest = health
        .get("ingest")
        .cloned()
        .expect("health missing ingest");
    assert_eq!(
        ingest.get("stormDeadlineFlushes").and_then(|v| v.as_u64()),
        Some(base_df),
        "无缓冲时到期 tick 不得虚增落批计数: {ingest}"
    );

    // 窗口到期落批(max latency 兑现):v5/v6 单 write 入缓冲后睡眠越过
    // deadline(300ms),主循环空闲 tick flush_due 移交并执行——缓冲清空、
    // 到期落批恰一次、不依赖任何请求触发。
    let mut burst = Vec::new();
    for (version, prop) in [(5, "openmark5"), (6, "openmark6")] {
        let frame = notify(
            "textDocument/didChange",
            json!({ "textDocument": { "uri": def_uri, "version": version },
                "contentChanges": [ { "text": def_with(prop) } ] }),
        );
        let body = serde_json::to_string(&frame).expect("serialize frame");
        let _ = write!(burst, "Content-Length: {}\r\n\r\n{body}", body.len());
    }
    {
        let stdin = proc.child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(&burst).expect("write burst");
        stdin.flush().expect("flush burst");
    }
    std::thread::sleep(Duration::from_millis(450));
    send(&mut proc, &request(15, "$/kode/health", json!({})));
    let health = result_of(wait_response(&proc, 15, Duration::from_secs(30)));
    let ingest = health
        .get("ingest")
        .cloned()
        .expect("health missing ingest");
    let counter = |name: &str| -> u64 {
        ingest
            .get(name)
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| panic!("missing {name}: {ingest}"))
    };
    assert_eq!(
        counter("stormDeadlineFlushes"),
        base_df + 1,
        "窗口到期应恰好落批一次(空闲 tick 驱动): {ingest}"
    );
    assert_eq!(counter("stormBuffered"), 0, "到期落批后缓冲清空: {ingest}");
    assert_eq!(
        counter("stormSeen"),
        base_seen + 5,
        "v5/v6 计入风暴 seen: {ingest}"
    );
    assert_eq!(
        counter("stormMerged"),
        base_merged + 3,
        "v5 被 v6 吸收: {ingest}"
    );
    assert_eq!(
        counter("enqueued"),
        base_enq + 2,
        "到期落批移交入队恰一次: {ingest}"
    );
    assert_eq!(
        counter("executed"),
        base_exec + 2,
        "落批任务由空闲切片执行: {ingest}"
    );
    assert_eq!(counter("queued"), 0, "落批任务已执行,不得积压: {ingest}");

    // 关闭 ≠ 删除:didClose 后语料回读磁盘重蓄(哨兵文件链接面幸存,
    // 指回盘上 Avatar.def——若被逐出则链接面消失)。
    send(
        &mut proc,
        &notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": def_uri } }),
        ),
    );
    send(
        &mut proc,
        &request(
            16,
            "textDocument/hover",
            json!({ "textDocument": { "uri": entities_uri }, "position": { "line": 1, "character": 3 } }),
        ),
    );
    let hover = result_of(wait_response(&proc, 16, Duration::from_secs(30)));
    let link_md = hover
        .pointer("/contents/value")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    assert!(
        link_md.contains(&def_path.display().to_string()),
        "关闭后盘上语料应回读重蓄(链接面幸存): {link_md}"
    );

    // 关闭文档自身 hover 回 null(未打开文档不服务,诚实面)。
    send(
        &mut proc,
        &request(
            17,
            "textDocument/hover",
            json!({ "textDocument": { "uri": def_uri }, "position": { "line": 2, "character": 3 } }),
        ),
    );
    let hover = wait_response(&proc, 17, Duration::from_secs(30));
    assert!(
        hover
            .pointer("/result")
            .map(|r| r.is_null())
            .unwrap_or(false),
        "关闭文档 hover 应回 null: {hover}"
    );

    assert_clean_exit(proc);
    let _ = std::fs::remove_dir_all(&dir);
}
