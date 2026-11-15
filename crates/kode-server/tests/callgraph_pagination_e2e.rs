//! RUST-077-W 真子进程 E2E:超限调用图响应可分页续取且 payload 有界(todo
//! 验收口径)。
//!
//! 走真实 stdio 帧(`Content-Length` 协议)到 `kode-server` 二进制:单文件
//! 3000 方法宽类制造超 256KiB 响应 → edges/nodes/dataflow 三维切片(带
//! `*Page` 元信息)→ 按各维 nextOffset 续取循环拼回全量,累计 == stats
//! 全量计数;同游标重取字节级确定;每页切片序列化长度与 bytesEstimate 双
//! 有界;legacy 小结果(无页键)单请求原样。池健康 8 键在场。

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

fn callgraph_rpc(proc: &mut ServerProc, id: &mut i64, params: Value) -> Value {
    *id += 1;
    send(proc, &rpc_request(*id, "$/kode/python/callgraph", params));
    result_of(wait_response(proc, *id, Duration::from_secs(60)))
}

/// 宽类生成:每方法一次属性读 + 一次 self-method 调用(必须带括号)。
fn wide_class_source(methods: usize) -> String {
    let mut body = String::from("class Wide:\n");
    for i in 0..methods {
        body.push_str(&format!("    def m{i}(self):\n"));
        body.push_str(&format!("        y = self.a{i}\n"));
        body.push_str(&format!("        self.m{}()\n", (i + 1) % methods));
    }
    body
}

const EDGE_PAGE_MAX_BYTES: usize = 256 * 1024;
const PAGE_SLICE_BOUND: usize = 300 * 1024;

fn assert_bounded(key: &str, result: &Value) {
    let raw = result.get(key).cloned().unwrap_or(Value::Array(Vec::new()));
    let bytes = serde_json::to_string(&raw).expect("serialize slice").len();
    assert!(
        bytes <= PAGE_SLICE_BOUND,
        "{key} slice unbounded: {bytes} bytes"
    );
}

fn page_next(meta: &Value) -> Option<usize> {
    meta.get("nextOffset").and_then(|v| v.as_u64()).map(|v| v as usize)
}

/// 单维续取状态机(与 TS 消费方同契约):开启维追加切片推进游标;终局维只
/// 幂等校验不重复入账。返回 false = 取消半页/游标不前进/终局维复活。
fn step_array_dim(
    sink: &mut Vec<Value>,
    items: Option<&Vec<Value>>,
    meta: Option<&Value>,
    sent: usize,
    done: &mut bool,
    cursor: &mut usize,
    total: &mut usize,
) -> bool {
    // 终局维空尾页:meta 必须指向到底,绝不重复入账。
    if *done {
        let revived = match meta {
            None => false,
            Some(meta) => {
                meta.get("cancelled").and_then(|v| v.as_bool()) == Some(true)
                    || page_next(meta).is_some()
            }
        };
        return !revived;
    }
    let meta = match meta {
        Some(meta) => meta,
        None => {
            // 全量维(首页整段装下):整段收编,终局;续取带 total 空尾页。
            sink.clear();
            if let Some(items) = items {
                sink.extend(items.iter().cloned());
            }
            *total = sink.len();
            *cursor = *total;
            *done = true;
            return true;
        }
    };
    if let Some(items) = items {
        sink.extend(items.iter().cloned());
    }
    if meta.get("cancelled").and_then(|v| v.as_bool()) == Some(true) {
        return false;
    }
    let dim_total =
        meta.get("total").and_then(|v| v.as_u64()).unwrap_or(sink.len() as u64) as usize;
    match page_next(meta) {
        None => {
            *total = dim_total;
            *cursor = *total;
            *done = true;
            true
        }
        Some(next) if next <= sent => false,
        Some(next) => {
            *total = dim_total;
            *cursor = next;
            *done = false;
            true
        }
    }
}

#[test]
fn oversized_callgraph_pages_resume_and_stay_bounded_over_stdio() {
    let methods = 3000;
    let source = wide_class_source(methods);
    let mut next_id = 0i64;
    let mut proc = spawn_server();

    // 握手 + 池健康 8 键。
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
    next_id += 1;
    send(&mut proc, &request(next_id, "$/kode/health", json!({})));
    let health = result_of(wait_response(&proc, next_id, Duration::from_secs(10)));
    let pool = health
        .get("pool")
        .cloned()
        .expect("health missing pool");
    let mut pool_keys: Vec<String> = pool
        .as_object()
        .expect("pool object")
        .keys()
        .cloned()
        .collect();
    pool_keys.sort();
    assert_eq!(
        pool_keys,
        vec![
            "backgroundRunning", "cpuRunning", "interactiveRunning", "ioRunning",
            "jobsCancelled", "jobsDone", "jobsFailed", "workers"
        ]
    );

    // 首页:不带游标。三维超限 → 带 `*Page` 元信息。
    let files = json!([{ "path": "/w/e2e/Wide.py", "text": source }]);
    let mut params = json!({ "files": files, "manifestXmlText": "" });
    let first = callgraph_rpc(&mut proc, &mut next_id, params.clone());
    let stats = first.get("stats").cloned().expect("stats");
    let edge_total = stats.get("edgeCount").and_then(|v| v.as_u64()).expect("edgeCount") as usize;
    let node_total = stats.get("nodeCount").and_then(|v| v.as_u64()).expect("nodeCount") as usize;
    let dataflow_total =
        stats.get("dataflowCount").and_then(|v| v.as_u64()).expect("dataflowCount") as usize;
    assert_eq!(edge_total, methods, "self-method 调用全量边");
    assert_eq!(node_total, methods, "每方法一节点");

    assert!(
        first.get("edgePage").is_some(),
        "超限响应必须携带 edgePage: keys={:?}",
        first.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );
    assert_bounded("edges", &first);
    assert_bounded("nodes", &first);
    assert_bounded("dataflow", &first);
    let bytes_estimate = first
        .get("edgePage")
        .and_then(|p| p.get("bytesEstimate"))
        .and_then(|v| v.as_u64())
        .expect("edgePage.bytesEstimate") as usize;
    assert!(
        bytes_estimate <= EDGE_PAGE_MAX_BYTES,
        "edgePage.bytesEstimate {bytes_estimate} 超策略常量"
    );

    // 续取循环:各维独立状态机推进;续取请求恒携带四游标(开启维
    // nextOffset,终局维 total 空尾页),防止服务端把收完的维重新打开。
    let mut edges: Vec<Value> = Vec::new();
    let mut nodes: Vec<Value> = Vec::new();
    let mut dataflow: Vec<Value> = Vec::new();
    let mut edge_done = false;
    let mut node_done = false;
    let mut dataflow_done = false;
    let mut edge_cursor = 0usize;
    let mut node_cursor = 0usize;
    let mut dataflow_cursor = 0usize;
    let mut edge_dim_total = 0usize;
    let mut node_dim_total = 0usize;
    let mut dataflow_dim_total = 0usize;
    {
        let first_edges = first.get("edges").and_then(|v| v.as_array());
        let first_nodes = first.get("nodes").and_then(|v| v.as_array());
        let first_dataflow = first.get("dataflow").and_then(|v| v.as_array());
        assert!(
            step_array_dim(&mut edges, first_edges, first.get("edgePage"), 0,
                &mut edge_done, &mut edge_cursor, &mut edge_dim_total),
            "首页 edge 维步进失败(取消/卡死): {:?}",
            first.get("edgePage")
        );
        assert!(
            step_array_dim(&mut nodes, first_nodes, first.get("nodePage"), 0,
                &mut node_done, &mut node_cursor, &mut node_dim_total),
            "首页 node 维步进失败: {:?}",
            first.get("nodePage")
        );
        assert!(
            step_array_dim(&mut dataflow, first_dataflow, first.get("dataflowPage"), 0,
                &mut dataflow_done, &mut dataflow_cursor, &mut dataflow_dim_total),
            "首页 dataflow 维步进失败: {:?}",
            first.get("dataflowPage")
        );
    }

    // 确定性锚:第二页请求参数 + 响应字节。
    let mut second_params: Option<Value> = None;
    let mut second_bytes: Option<String> = None;

    let mut pages = 1usize;
    let mut last_page: Value = Value::Null;
    while !(edge_done && node_done && dataflow_done) {
        pages += 1;
        assert!(
            pages < 200,
            "分页循环不终止: pages={pages} edge(cursor={edge_cursor},done={edge_done}) \
             node(cursor={node_cursor},done={node_done}) df(cursor={dataflow_cursor},done={dataflow_done}) \
             last_page={last_page}"
        );
        params["edgeOffset"] = json!(edge_cursor);
        params["nodeOffset"] = json!(node_cursor);
        params["dataflowOffset"] = json!(dataflow_cursor);
        let page = callgraph_rpc(&mut proc, &mut next_id, params.clone());
        if second_params.is_none() {
            second_params = Some(params.clone());
            second_bytes = Some(serde_json::to_string(&page).expect("serialize page"));
        }
        assert_bounded("edges", &page);
        assert_bounded("nodes", &page);
        assert_bounded("dataflow", &page);
        let page_edges = page.get("edges").and_then(|v| v.as_array());
        let page_nodes = page.get("nodes").and_then(|v| v.as_array());
        let page_dataflow = page.get("dataflow").and_then(|v| v.as_array());
        let ok_edges = step_array_dim(&mut edges, page_edges, page.get("edgePage"),
            edge_cursor, &mut edge_done, &mut edge_cursor, &mut edge_dim_total);
        let ok_nodes = step_array_dim(&mut nodes, page_nodes, page.get("nodePage"),
            node_cursor, &mut node_done, &mut node_cursor, &mut node_dim_total);
        let ok_dataflow = step_array_dim(&mut dataflow, page_dataflow, page.get("dataflowPage"),
            dataflow_cursor, &mut dataflow_done, &mut dataflow_cursor, &mut dataflow_dim_total);
        last_page = serde_json::json!({
            "edgePage": page.get("edgePage"),
            "nodePage": page.get("nodePage"),
            "dataflowPage": page.get("dataflowPage"),
            "edgesLen": page_edges.map(|a| a.len()),
            "nodesLen": page_nodes.map(|a| a.len()),
            "dataflowLen": page_dataflow.map(|a| a.len())
        });
        assert!(
            ok_edges && ok_nodes && ok_dataflow,
            "续取维步进失败(取消/卡死/复活): edgesOk={ok_edges} nodesOk={ok_nodes} dfOk={ok_dataflow} last_page={last_page}"
        );
    }

    assert_eq!(edges.len(), edge_total, "续取累计 == stats.edgeCount");
    assert_eq!(nodes.len(), node_total, "续取累计 == stats.nodeCount");
    assert_eq!(dataflow.len(), dataflow_total, "续取累计 == stats.dataflowCount");
    assert!(pages >= 2, "超限必须多页: pages={pages}");

    // 确定性:同游标重取字节级一致(纯函数,text-in)。
    if let (Some(params), Some(bytes)) = (second_params, second_bytes) {
        let replay = callgraph_rpc(&mut proc, &mut next_id, params);
        let replay_bytes = serde_json::to_string(&replay).expect("serialize replay");
        assert_eq!(replay_bytes, bytes, "同游标重取必须字节一致");
    }

    // 分页后服务仍健康(池记账无占位泄漏)。
    next_id += 1;
    send(&mut proc, &request(next_id, "$/kode/health", json!({})));
    let health = result_of(wait_response(&proc, next_id, Duration::from_secs(10)));
    let pool = health.get("pool").cloned().expect("health missing pool");
    assert_eq!(
        pool.get("backgroundRunning").and_then(|v| v.as_u64()),
        Some(0),
        "分页后后台泳道空: {pool}"
    );
}

#[test]
fn legacy_small_callgraph_has_no_page_keys_over_stdio() {
    let source = "class Avatar:\n    def act(self):\n        self.notify()\n\n    def notify(self):\n        pass\n";
    let mut next_id = 0i64;
    let mut proc = spawn_server();
    next_id += 1;
    send(
        &mut proc,
        &request(next_id, "initialize", json!({ "capabilities": {} })),
    );
    let _ = wait_response(&proc, next_id, Duration::from_secs(30));
    send(
        &mut proc,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );

    let params = json!({
        "files": [{ "path": "/w/e2e/Avatar.py", "text": source }],
        "manifestXmlText": ""
    });
    let result = callgraph_rpc(&mut proc, &mut next_id, params);
    for key in ["edgePage", "nodePage", "dataflowPage", "reversePage"] {
        assert!(
            result.get(key).is_none(),
            "全量小结果不得携带 {key}: {result}"
        );
    }
    let stats = result.get("stats").cloned().expect("stats");
    let edges = result.get("edges").and_then(|v| v.as_array()).expect("edges");
    assert_eq!(edges.len(), 1);
    assert_eq!(
        stats.get("edgeCount").and_then(|v| v.as_u64()),
        Some(1),
        "单发即全量: {stats}"
    );
}
