//! kode-server 状态机:消息分派、文档同步、取消、健康报告。
//!
//! 纯同步 + 无 IO(stdio 泵在 main.rs),全部可单测:
//! - CORE-002 `initialize` 协商(capabilities/serverInfo,重复 initialize 幂等)
//! - CORE-003 request_id 贯穿:响应/取消/健康报告全部携带原始 id
//! - CORE-015 exit 语义:未 shutdown 的退出可被客户端识别为崩溃并重启
//! - CORE-016 `$/kode/health` 健康探针
//! - VFS-002/003/009(PR-004):文档同步走 kode-vfs DocumentStore——
//!   身份 (root_id, canonical URI)、open overlay、严格 version 转移、
//!   full/ranged 双模式 change、根注册与最长前缀归属。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kode_protocol::{
    error_codes, ContentChangeEvent, DidChangeParams, DidCloseParams, DidOpenParams,
    DocumentSummary, HealthReport, IncomingMessage, InitializeParams, InitializeResult,
    Notification, Request, RequestId, Response, ServerCapabilities, ServerInfo, ServerNotification,
    TextDocumentSyncOptions, PROTOCOL_VERSION,
};
use kode_vfs::{CanonicalUri, DocumentKey, DocumentStore, RootRegistry, TextChange};

/// 服务器名(TS 侧握手校验用)。
pub const SERVER_NAME: &str = "kode-server";

/// `$/kode/wait` 单次等待上限(ms):防误用把泵挂死。
const WAIT_MAX_MS: u64 = 10_000;

/// 取消登记表:与 ServerState 分离成可 Arc 共享的单元,
/// 让 stdio 泵在长请求(`$/kode/wait`)睡眠期间也能登记先到的取消通知
/// (单线程阻塞泵的取消通道,CORE-007 最小实现)。
#[derive(Debug, Default)]
pub struct CancelRegistry {
    /// 进行中可取消请求 → 取消标志。
    pending: Mutex<HashMap<RequestId, Arc<AtomicBool>>>,
    /// 取消通知先于请求到达(LSP 允许):先记账,请求到达时核对。
    before_start: Mutex<HashSet<RequestId>>,
}

impl CancelRegistry {
    /// 取消标志:已 pending 则置位;否则记入先到账。
    pub fn request_cancel(&self, id: &RequestId) {
        if let Some(flag) = self.pending.lock().expect("cancel map").get(id) {
            flag.store(true, Ordering::SeqCst);
            return;
        }
        self.before_start
            .lock()
            .expect("cancel-before set")
            .insert(id.clone());
    }

    /// 请求开始:登记取消标志;若取消通知已先到,立即返回已取消。
    pub fn begin_cancellable(&self, id: &RequestId) -> (Arc<AtomicBool>, bool) {
        let early = self
            .before_start
            .lock()
            .expect("cancel-before set")
            .remove(id);
        let flag = Arc::new(AtomicBool::new(false));
        self.pending
            .lock()
            .expect("cancel map")
            .insert(id.clone(), Arc::clone(&flag));
        (flag, early)
    }

    pub fn end_cancellable(&self, id: &RequestId) {
        self.pending.lock().expect("cancel map").remove(id);
    }
}

/// 服务器状态。
#[derive(Debug)]
pub struct ServerState {
    pub initialized: bool,
    pub shutdown_requested: bool,
    pub exit_requested: bool,
    /// 客户端在 initialize.initializationOptions.restartGeneration 传入的代数,
    /// 健康报告原样回显,供 TS 侧重启逻辑对账(CORE-015/016)。
    pub restart_generation: u64,
    pub started_at: Instant,
    /// 文档同步(VFS-002/003):身份 = (root_id, canonical URI),
    /// open overlay + 严格 version 转移在 kode-vfs DocumentStore。
    pub store: DocumentStore,
    /// 资源根注册(VFS-009 基础版):initialize.rootUri 起注册,最长前缀归属。
    pub roots: RootRegistry,
    pub cancels: Arc<CancelRegistry>,
}

impl ServerState {
    pub fn new() -> Self {
        ServerState {
            initialized: false,
            shutdown_requested: false,
            exit_requested: false,
            restart_generation: 0,
            started_at: Instant::now(),
            store: DocumentStore::new(),
            roots: RootRegistry::new(),
            cancels: Arc::new(CancelRegistry::default()),
        }
    }
}

impl Default for ServerState {
    fn default() -> Self {
        Self::new()
    }
}

/// 出站消息:响应或服务器通知。
#[derive(Debug, Clone)]
pub enum Outgoing {
    Response(Response),
    Notification(ServerNotification),
}

/// 分派一条入站消息,产出 0..n 条出站消息。
pub fn handle_message(state: &mut ServerState, message: IncomingMessage) -> Vec<Outgoing> {
    handle_message_with_poll(state, message, &mut || false)
}

/// 带 `poll` 钩子的分派:`poll` 在长请求睡眠间隙被调用,泵喂入新到的
/// stdio 字节并登记取消通知(返回 true 表示见到过 $/cancelRequest)。
pub fn handle_message_with_poll(
    state: &mut ServerState,
    message: IncomingMessage,
    poll: &mut dyn FnMut() -> bool,
) -> Vec<Outgoing> {
    match message {
        IncomingMessage::Request(request) => handle_request(state, request, poll),
        IncomingMessage::Notification(notification) => handle_notification(state, notification),
    }
}

/// 判断一条解码消息是不是 $/cancelRequest,是则取其目标 id。
pub fn cancel_target(value: &serde_json::Value) -> Option<RequestId> {
    if value.get("method").and_then(|m| m.as_str()) != Some("$/cancelRequest") {
        return None;
    }
    value
        .get("params")
        .and_then(|p| p.get("id"))
        .and_then(|id| serde_json::from_value::<RequestId>(id.clone()).ok())
}

fn handle_request(
    state: &mut ServerState,
    request: Request,
    poll: &mut dyn FnMut() -> bool,
) -> Vec<Outgoing> {
    // CORE-003:initialize/shutdown 之外的请求在未初始化时一律拒(-32002)。
    if request.method != "initialize" && !state.initialized {
        return vec![Outgoing::Response(Response::error(
            Some(request.id),
            error_codes::SERVER_NOT_INITIALIZED,
            "server is not initialized",
        ))];
    }
    match request.method.as_str() {
        "initialize" => vec![Outgoing::Response(handle_initialize(state, request))],
        "shutdown" => {
            state.shutdown_requested = true;
            vec![Outgoing::Response(Response::success(
                request.id,
                serde_json::Value::Null,
            ))]
        }
        "$/kode/health" => {
            vec![Outgoing::Response(Response::success(
                request.id,
                health_report(state),
            ))]
        }
        "$/kode/wait" => vec![Outgoing::Response(handle_wait(state, request, poll))],
        _ => vec![Outgoing::Response(Response::error(
            Some(request.id),
            error_codes::METHOD_NOT_FOUND,
            format!("method not found: {}", request.method),
        ))],
    }
}

/// CORE-002:initialize 协商。重复 initialize 幂等(重启后客户端可能重发)。
fn handle_initialize(state: &mut ServerState, request: Request) -> Response {
    let params: InitializeParams = request
        .params
        .and_then(|p| serde_json::from_value(p).ok())
        .unwrap_or_default();
    state.restart_generation = params
        .initialization_options
        .as_ref()
        .and_then(|opts| opts.get("restartGeneration"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    // VFS-009:rootUri 注册为首个资源根(注册顺序 = 显式优先顺序)。
    if let Some(root_uri) = params.root_uri.as_deref() {
        if let Ok(root) = CanonicalUri::parse(root_uri) {
            state.roots.register(root.as_path());
        }
    }
    state.initialized = true;
    let result = InitializeResult {
        capabilities: ServerCapabilities {
            text_document_sync: TextDocumentSyncOptions {
                open_close: true,
                change: 1,
            },
        },
        server_info: ServerInfo {
            name: SERVER_NAME.to_string(),
            version: PROTOCOL_VERSION.to_string(),
        },
    };
    Response::success(
        request.id,
        serde_json::to_value(result).expect("serialize initialize"),
    )
}

/// 可取消的测试/探针请求:等待指定毫秒;被 $/cancelRequest 取消则返回 -32800。
/// 睡眠间隙调用 `poll` 泵入新到输入,保证取消通知能穿过阻塞泵。
fn handle_wait(
    state: &mut ServerState,
    request: Request,
    poll: &mut dyn FnMut() -> bool,
) -> Response {
    let ms = request
        .params
        .as_ref()
        .and_then(|p| p.get("ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(WAIT_MAX_MS);
    let (flag, cancelled_early) = state.cancels.begin_cancellable(&request.id);
    let outcome = (|| {
        if cancelled_early || flag.load(Ordering::SeqCst) {
            return Err(());
        }
        // 分片睡眠 + 间隙轮询:取消传播粒度 5ms。
        let step = Duration::from_millis(5);
        let mut waited = Duration::ZERO;
        while waited < Duration::from_millis(ms) {
            if flag.load(Ordering::SeqCst) {
                return Err(());
            }
            std::thread::sleep(step);
            waited += step;
            poll();
            if flag.load(Ordering::SeqCst) {
                return Err(());
            }
        }
        Ok(waited.as_millis() as u64)
    })();
    state.cancels.end_cancellable(&request.id);
    match outcome {
        Ok(waited_ms) => {
            Response::success(request.id, serde_json::json!({ "waitedMs": waited_ms }))
        }
        Err(()) => Response::error(
            Some(request.id),
            error_codes::REQUEST_CANCELLED,
            "request cancelled via $/cancelRequest",
        ),
    }
}

fn handle_notification(state: &mut ServerState, notification: Notification) -> Vec<Outgoing> {
    // 未初始化前的通知一律丢弃(LSP 规范)。
    if !state.initialized && notification.method != "$/cancelRequest" {
        return Vec::new();
    }
    match notification.method.as_str() {
        "initialized" => Vec::new(),
        "exit" => {
            state.exit_requested = true;
            Vec::new()
        }
        "textDocument/didOpen" => {
            handle_did_open(state, notification.params);
            Vec::new()
        }
        "textDocument/didChange" => {
            handle_did_change(state, notification.params);
            Vec::new()
        }
        "textDocument/didClose" => {
            handle_did_close(state, notification.params);
            Vec::new()
        }
        "$/cancelRequest" => {
            if let Some(id) = notification
                .params
                .as_ref()
                .and_then(|p| p.get("id"))
                .and_then(|v| serde_json::from_value::<RequestId>(v.clone()).ok())
            {
                state.cancels.request_cancel(&id);
            }
            Vec::new()
        }
        // 未知通知:静默丢弃(LSP 规范),保证前向兼容。
        _ => Vec::new(),
    }
}

/// didOpen → kode-vfs overlay(VFS-003)。root 按 initialize 注册的根
/// 最长前缀归属(VFS-009);旧 version 重放被拒且静默忽略(防御)。
fn handle_did_open(state: &mut ServerState, params: Option<serde_json::Value>) {
    let Ok(params) = serde_json::from_value::<DidOpenParams>(params.unwrap_or_default()) else {
        return;
    };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return;
    };
    let root = state.roots.root_for(&uri);
    let _ = state.store.open(
        DocumentKey::new(root, uri),
        params.text_document.version,
        params.text_document.text,
    );
}

/// didChange → kode-vfs version 转移(VFS-003):
/// full sync 的每个 change 无 range,增量 change 带 range 走 VFS-004 精确坐标;
/// 未打开文档或 version 未递增的改动一律忽略(不过期覆盖,ARCH-005)。
fn handle_did_change(state: &mut ServerState, params: Option<serde_json::Value>) {
    let Ok(params) = serde_json::from_value::<DidChangeParams>(params.unwrap_or_default()) else {
        return;
    };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return;
    };
    let root = state.roots.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    let changes: Vec<TextChange> = params
        .content_changes
        .into_iter()
        .map(|change: ContentChangeEvent| TextChange {
            range: change.range.map(|range| kode_vfs::Range {
                start: kode_vfs::Position {
                    line: range.start.line,
                    character: range.start.character,
                },
                end: kode_vfs::Position {
                    line: range.end.line,
                    character: range.end.character,
                },
            }),
            text: change.text,
        })
        .collect();
    let _ = state
        .store
        .change(&key, params.text_document.version, changes);
}

/// didClose → 移除 overlay,文档回落磁盘真相(VFS-003 close 转移)。
fn handle_did_close(state: &mut ServerState, params: Option<serde_json::Value>) {
    let Ok(params) = serde_json::from_value::<DidCloseParams>(params.unwrap_or_default()) else {
        return;
    };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return;
    };
    let root = state.roots.root_for(&uri);
    state.store.close(&DocumentKey::new(root, uri));
}

/// CORE-016 健康报告:status/pid/版本/uptime/文档摘要,按 uri 排序保证确定性。
fn health_report(state: &ServerState) -> serde_json::Value {
    let documents: Vec<DocumentSummary> = state
        .store
        .open_summaries()
        .into_iter()
        .map(|(uri, version)| DocumentSummary { uri, version })
        .collect();
    let report = HealthReport {
        status: "ok".to_string(),
        pid: std::process::id(),
        server_version: PROTOCOL_VERSION.to_string(),
        uptime_ms: state.started_at.elapsed().as_millis() as u64,
        initialized: state.initialized,
        shutdown_requested: state.shutdown_requested,
        restart_generation: state.restart_generation,
        documents,
    };
    serde_json::to_value(report).expect("serialize health report")
}
