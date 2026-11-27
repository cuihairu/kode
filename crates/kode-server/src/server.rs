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

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kode_protocol::{
    error_codes, CodeActionDiagnostic, CodeActionParams, CompletionParams, ContentChangeEvent,
    CoreResources, DefinitionParams, DeleteFilesParams, DeletedFile, DidChangeParams,
    DidCloseParams, DidOpenParams, DocumentDiagnosticParams, DocumentSummary, DocumentSymbolParams,
    HealthReport, HoverParams, IncomingMessage, InitializeParams, InitializeResult, Notification,
    PrepareRenameParams, ReferenceParams, RenameFilesParams, RenameParams, RenamedFile, Request,
    RequestId, Response, ServerCapabilities, ServerInfo, ServerNotification, SignatureHelpParams,
    TextDocumentSyncOptions, WorkspaceSymbolParams, PROTOCOL_VERSION,
};
use kode_scheduler::{EnqueueDecision, RootInvalidationSink, WorkspaceSession};
use kode_vfs::{CanonicalUri, DocumentKey, DocumentStore, TextChange};

use crate::completion::to_lsp_items;
use crate::diagnostics::DiagnosticFace;
use crate::hover::HoverEngine;

/// 服务器名(TS 侧握手校验用)。
pub const SERVER_NAME: &str = "kode-server";

/// `$/kode/wait` 单次等待上限(ms):防误用把泵挂死。
const WAIT_MAX_MS: u64 = 10_000;

/// 已应答请求墓碑环上限:迟到取消(请求应答之后才到的 $/cancelRequest)
/// 据此判「请求已完」。只保最近 N 条,更早 id 的迟到取消落先到账的
/// 有界丢弃(总内存仍有界)。
const FINISHED_TOMBSTONE_CAP: usize = 4096;
/// 先到账上限:合法形态是「取消先到、请求紧随」,窗口极小;溢出丢最旧
/// 条目——丢弃只会退化为「正常应答该请求」,不会误取消。
const BEFORE_START_CAP: usize = 1024;

/// 有界插入序集合(先到账):live 查重/查在,order 定淘汰序。
#[derive(Debug, Default)]
struct BeforeStartLedger {
    live: HashSet<RequestId>,
    order: VecDeque<RequestId>,
}

impl BeforeStartLedger {
    fn insert(&mut self, id: RequestId) {
        if self.live.insert(id.clone()) {
            self.order.push_back(id);
        }
        while self.order.len() > BEFORE_START_CAP {
            if let Some(old) = self.order.pop_front() {
                self.live.remove(&old);
            }
        }
    }
    fn remove(&mut self, id: &RequestId) -> bool {
        self.live.remove(id)
    }
    fn len(&self) -> usize {
        self.live.len()
    }
}

/// 已应答请求墓碑环(有界):判迟到取消。
#[derive(Debug, Default)]
struct FinishedTombstones {
    seen: HashSet<RequestId>,
    order: VecDeque<RequestId>,
}

impl FinishedTombstones {
    fn note(&mut self, id: RequestId) {
        if self.seen.insert(id.clone()) {
            self.order.push_back(id);
        }
        while self.order.len() > FINISHED_TOMBSTONE_CAP {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
    }
    fn contains(&self, id: &RequestId) -> bool {
        self.seen.contains(id)
    }
}

/// 取消登记表:与 ServerState 分离成可 Arc 共享的单元,
/// 让 stdio 泵在长请求(`$/kode/wait`)睡眠期间也能登记先到的取消通知
/// (单线程阻塞泵的取消通道,CORE-007 最小实现)。
///
/// 三序全覆盖(生产接线审计 P1-1):
/// - 取消先到、请求后到 → 先到账,请求分派入口消费;
/// - 请求在途(pending)→ 置取消标志,handler 轮询点观测;
/// - 请求已应答、取消迟到 → 墓碑环判已完直接丢弃,不落账
///   (此前永久落 before_start 无界泄漏)。
#[derive(Debug, Default)]
pub struct CancelRegistry {
    /// 进行中可取消请求 → 取消标志。
    pending: Mutex<HashMap<RequestId, Arc<AtomicBool>>>,
    /// 取消通知先于请求到达(LSP 允许):先记账,请求到达时核对。有界。
    before_start: Mutex<BeforeStartLedger>,
    /// 已应答请求(有界环):其取消一律迟到,丢弃。
    finished: Mutex<FinishedTombstones>,
}

impl CancelRegistry {
    /// 取消标志:已 pending 则置位;请求已应答则迟到丢弃;否则记入先到账。
    pub fn request_cancel(&self, id: &RequestId) {
        if let Some(flag) = self.pending.lock().expect("cancel map").get(id) {
            flag.store(true, Ordering::SeqCst);
            return;
        }
        if self
            .finished
            .lock()
            .expect("cancel-finished set")
            .contains(id)
        {
            // 迟到取消:请求已应答(LSP 语义为 no-op),墓碑直接丢弃。
            return;
        }
        self.before_start
            .lock()
            .expect("cancel-before set")
            .insert(id.clone());
    }

    /// 请求应答收尾(分派尾部统一调用):此后同 id 的取消是迟到取消。
    pub fn note_finished(&self, id: &RequestId) {
        self.finished
            .lock()
            .expect("cancel-finished set")
            .note(id.clone());
    }

    /// 请求分派入口统一消费先到账:请求到达即清账(可取消方法把早到结果
    /// 传入 handler;普通方法消费即弃——取消语义随线程池贯穿批全面接入)。
    /// 此前普通 RPC 从不消费,先到取消标记无界累积(生产接线审计批)。
    pub fn consume_early(&self, id: &RequestId) -> bool {
        self.before_start
            .lock()
            .expect("cancel-before set")
            .remove(id)
    }

    /// 请求开始:登记取消标志;若取消通知已先到,立即返回已取消。
    pub fn begin_cancellable(&self, id: &RequestId) -> (Arc<AtomicBool>, bool) {
        let early = self.consume_early(id);
        let flag = Arc::new(AtomicBool::new(false));
        self.pending
            .lock()
            .expect("cancel map")
            .insert(id.clone(), Arc::clone(&flag));
        (flag, early)
    }

    /// 只登记取消标志,不消费先到账(早到判定统一由分派入口消费后传参,
    /// 避免 handler 各自消费时被入口抢账)。
    pub fn register_cancellable(&self, id: &RequestId) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.pending
            .lock()
            .expect("cancel map")
            .insert(id.clone(), Arc::clone(&flag));
        flag
    }

    pub fn end_cancellable(&self, id: &RequestId) {
        self.pending.lock().expect("cancel map").remove(id);
    }

    /// 测试面:先到账深度(泄漏钉)。
    pub fn before_start_len_for_tests(&self) -> usize {
        self.before_start.lock().expect("cancel-before set").len()
    }

    /// 测试面:墓碑环深度。
    pub fn finished_len_for_tests(&self) -> usize {
        self.finished
            .lock()
            .expect("cancel-finished set")
            .seen
            .len()
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
    /// RUST-069-W:经 Rc 供 WorkspaceSession 撤根扇出(共享所有权)。
    pub store: Rc<RefCell<DocumentStore>>,
    /// RUST-069-W:唯一根注册表 = WorkspaceSession——全部 RootId 只经它发号,
    /// 撤根扇出共享缓存(document-store / hover-engine),id 永不复用(化身隔离)。
    pub session: WorkspaceSession,
    /// hover 响应链(PR-010/LSP-003):符号索引 + def 语料视图,纯内存应答。
    /// RUST-069-W:经 Rc 供 WorkspaceSession 撤根扇出(共享所有权)。
    pub hover: Rc<RefCell<HoverEngine>>,
    pub cancels: Arc<CancelRegistry>,
    /// 通用命令 RPC 面(Phase0 接线):`$/kode/rpc` 单臂 dispatch + 注册表。
    pub rpc: crate::rpc::RpcRegistry,
    /// RUST-075-W:worker 池记账快照(健康面 `pool` 键)。main 装配执行器后
    /// 注入;直连构造(单测)为 None,健康面省略该键(既有形状不变)。
    pub pool_stats: Option<Arc<Mutex<crate::executor::PoolStats>>>,
    /// RUST-074-W:暖门状态机(首扫 keyed 单例 + Warming 期冷请求观测)。
    /// 恒装配(健康面 `warm` 键恒在);四状态面走顶层请求臂(warm_gate)。
    pub warm: crate::warm_gate::WarmGate,
    /// RUST-070/071/073:索引刷新队列(hover 语料 ingest 装配线)。恒装配
    /// (健康面 `ingest` 键恒在);didOpen/didChange/didClose 入队,主循环
    /// 空闲切片 + 请求入口 freshen 自键驱动(打开文档小范围交互 > 局部刷新)。
    pub index: crate::index_queue::IndexQueue,
    /// RUST-142:诊断分级装配线(didChange → 四层调度核 → publishDiagnostics)。
    /// 层核为批 1 回放核 + 批 2 决策表;生产接线后由主循环空闲 tick 排空
    /// (flush_diagnostics_pipeline)。恒装配(健康面不暴露,纯内部面)。
    pub diagnostics_pipelines: crate::diagnostic_layering::LayeredSchedulers,
    /// RUST-142:待 flush 的脏文档(客户端 uri 原串 → 最新 didChange 版本,
    /// 与 store 的 DocumentKey 同根同 uri 但保留客户端原串供通知回显)。
    /// didOpen/didChange 标记,didClose 摘除;主循环 flush 排空并发射
    /// `$/kode/publishDiagnostics` 通知(空集零开销直通)。
    pub diagnostics_dirty: BTreeMap<String, i64>,
}

impl ServerState {
    pub fn new() -> Self {
        // 内建命令(echo)在此注册;增量命令各自 crate::<mod>::register(&mut rpc)
        // 加一行(消息表/生成/lint 模块自带 register,见 rpc.rs 模块注)。
        let mut rpc = crate::rpc::RpcRegistry::new();
        crate::client_sdk::register(&mut rpc);
        crate::config_rpc::register(&mut rpc);
        crate::config_rpc::register_resolve(&mut rpc);
        crate::database_schema::register(&mut rpc);
        crate::api_docs::register(&mut rpc);
        crate::db_clone::register(&mut rpc);
        crate::dependency_graph::register(&mut rpc);
        crate::lint::register(&mut rpc);
        crate::message_table::register(&mut rpc);
        crate::process_topology::register(&mut rpc);
        crate::python_callgraph::register(&mut rpc);
        crate::ruff_format::register(&mut rpc);
        // KODE-SYN-006:.def 原生格式化(纯解析面,核收敛在 kode-parser,方案 B)。
        crate::def_format::register(&mut rpc);
        crate::event_coalesce::register(&mut rpc);
        crate::ruff_lint::register(&mut rpc);
        crate::syntax_gate::register(&mut rpc);
        crate::semantics_rpc::register(&mut rpc);
        // wire/encode|decode 不注册:零 TS 消费者,kode-mcp 直复用 wire_codec
        // 库不经 RPC(防「能力已迁移」误导,RUST-MIGRATION-AUDIT-004)。
        crate::def_md5::register(&mut rpc);
        crate::attribute_none::register(&mut rpc);
        crate::self_attribute_flow::register(&mut rpc);
        crate::return_annotations::register(&mut rpc);
        crate::local_return::register(&mut rpc);
        crate::user_type_contract::register(&mut rpc);
        crate::property_direction::register(&mut rpc);
        crate::rpc_arg_count::register(&mut rpc);
        crate::trap_lints::register(&mut rpc);
        crate::post_destroy::register(&mut rpc);
        crate::readonly_write::register(&mut rpc);
        crate::role_misuse::register(&mut rpc);
        crate::receiver_none::register(&mut rpc);
        crate::space_nav::register(&mut rpc);
        crate::workspace_discovery::register(&mut rpc);
        // RUST-069-W:根生命周期唯一注册表装配——共享缓存经 Rc 登记为撤根扇出
        // sink(按登记序:先镜像仓库后 hover 引擎),回执按此序列出清除数。
        let store = Rc::new(RefCell::new(DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let mut session = WorkspaceSession::new();
        session.register_sink(Rc::clone(&store) as Rc<RefCell<dyn RootInvalidationSink>>);
        session.register_sink(Rc::clone(&hover) as Rc<RefCell<dyn RootInvalidationSink>>);
        // RUST-070/071/073:索引刷新队列持有引擎句柄(入队时构建执行时刻
        // 真相执行体);RUST-082:didChange 风暴缓冲在队列内。RESP-001b:
        // 回落读盘走专用读线程(协议线程绝不内联读盘)。
        let index_queue = crate::index_queue::IndexQueue::with_off_thread_reader(
            Rc::clone(&store),
            Rc::clone(&hover),
            std::sync::Arc::new(|path| std::fs::read_to_string(path)),
        );
        ServerState {
            initialized: false,
            shutdown_requested: false,
            exit_requested: false,
            restart_generation: 0,
            started_at: Instant::now(),
            store,
            session,
            hover,
            cancels: Arc::new(CancelRegistry::default()),
            rpc,
            // RUST-075-W:main 装配执行器后注入健康面记账;直连构造 None。
            pool_stats: None,
            warm: crate::warm_gate::WarmGate::new(),
            index: index_queue,
            diagnostics_pipelines: crate::diagnostic_layering::LayeredSchedulers::new(),
            diagnostics_dirty: BTreeMap::new(),
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
    let request_id = request.id.clone();
    let outgoings = handle_request_inner(state, request, poll);
    // 取消生命周期收尾(P1-1):本请求已应答(含 -32002/-32601 错误应答),
    // 此后同 id 的 $/cancelRequest 全是迟到取消,墓碑环判已完直接丢弃,
    // 不再永久落先到账(此前 1000 完成请求+迟到取消留 1000 条记录)。
    state.cancels.note_finished(&request_id);
    outgoings
}

fn handle_request_inner(
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
    // 先到取消账随请求到达统一消费一次(防无界累积;handler 不再各自消费,
    // 避免抢账)。可取消方法把早到结果用于立即取消;其余方法本批消费即弃
    // (取消登记面随线程池贯穿批统一接线)。
    let cancelled_early = state.cancels.consume_early(&request.id);
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
        "$/kode/wait" => vec![Outgoing::Response(handle_wait(
            state,
            request,
            poll,
            cancelled_early,
        ))],
        "$/kode/rpc" => vec![Outgoing::Response(handle_rpc(state, request))],
        "textDocument/hover" => vec![Outgoing::Response(handle_hover(state, request))],
        "textDocument/completion" => {
            vec![Outgoing::Response(handle_completion(
                state,
                request,
                cancelled_early,
            ))]
        }
        "completionItem/resolve" => {
            vec![Outgoing::Response(handle_completion_resolve(
                state,
                request,
                cancelled_early,
            ))]
        }
        "textDocument/definition" => vec![Outgoing::Response(handle_definition(state, request))],
        "textDocument/diagnostic" => vec![Outgoing::Response(handle_diagnostic(state, request))],
        // RUST-139 批 3:def 段符号面(Properties/三方法段容器 + 段内直接声明)。
        "textDocument/documentSymbol" => {
            vec![Outgoing::Response(handle_document_symbol(state, request))]
        }
        // RUST-138 批 3:语料引用位(Properties/方法段的属性与调用点面仍是
        // TS entityMapping 运行时面,Rust 面 = 类型/实体/接口引用位)。
        "textDocument/references" => vec![Outgoing::Response(handle_references(state, request))],
        // RUST-141 批 2:def 重命名面(符号解析/闭包冲突/编辑复算;python
        // self 访问改写面归 TS entityMapping)。
        "textDocument/prepareRename" => {
            vec![Outgoing::Response(handle_prepare_rename(state, request))]
        }
        "textDocument/rename" => vec![Outgoing::Response(handle_rename(state, request))],
        // RUST-143 批 3:codeAction 四族装配面(决策核 code_action_assembly;
        // 诊断对象构造/l10n 标题/WorkspaceEdit 装配归 TS 薄壳)。
        "textDocument/codeAction" => vec![Outgoing::Response(handle_code_action(state, request))],
        "textDocument/signatureHelp" => {
            vec![Outgoing::Response(handle_signature_help(state, request))]
        }
        // RUST-139 批 4:workspace/symbol def 符号前缀检索面(决策核
        // workspace_symbols.rs 批 2;todo/评审文档记作 textDocument/workspaceSymbol)。
        "workspace/symbol" => vec![Outgoing::Response(handle_workspace_symbol(state, request))],
        // RUST-069-W 根生命周期:新增/移除根落 WorkspaceSession 唯一注册表
        // (移除扇出共享缓存清镜像/符号/语料候选),roots 列表供装配对账。
        "$/kode/workspace/rootAdded" => {
            vec![Outgoing::Response(
                crate::root_lifecycle::handle_root_added(state, request),
            )]
        }
        "$/kode/workspace/rootRemoved" => {
            vec![Outgoing::Response(
                crate::root_lifecycle::handle_root_removed(state, request),
            )]
        }
        "$/kode/workspace/roots" => {
            vec![Outgoing::Response(
                crate::root_lifecycle::handle_roots_list(state, request),
            )]
        }
        // RUST-074-W 暖门四面:首扫 keyed 状态机(begin/complete/cancel)+
        // 暖态观测。要动 &mut ServerState 里的状态机,走顶层臂(root_lifecycle
        // 同先例),不经 RpcRegistry(池快照面无状态)。
        "$/kode/index/beginBackgroundScan" => {
            vec![Outgoing::Response(
                crate::warm_gate::handle_begin_background_scan(state, request),
            )]
        }
        "$/kode/index/scanComplete" => {
            vec![Outgoing::Response(crate::warm_gate::handle_scan_complete(
                state, request,
            ))]
        }
        "$/kode/index/scanCancel" => {
            vec![Outgoing::Response(crate::warm_gate::handle_scan_cancel(
                state, request,
            ))]
        }
        "$/kode/index/warmState" => {
            vec![Outgoing::Response(crate::warm_gate::handle_warm_state(
                state, request,
            ))]
        }
        // RUST-133:索引缺口报告(per-URI 裁定 + fill 按需补齐;聚合面与
        // health indexGaps 键同源)。要动 ServerState(fill 入队),走顶层臂。
        "$/kode/indexGaps" => {
            vec![Outgoing::Response(handle_index_gaps(state, request))]
        }
        _ => vec![Outgoing::Response(Response::error(
            Some(request.id),
            error_codes::METHOD_NOT_FOUND,
            format!("method not found: {}", request.method),
        ))],
    }
}

/// `$/kode/rpc` 通用命令面:params = `{ method, params }`,按注册表派发。
/// 未注册 method → -32601;handler Err → -32602(输入/内部错误,TS 兜底)。
fn handle_rpc(state: &mut ServerState, request: Request) -> Response {
    let payload = request.params.unwrap_or(serde_json::Value::Null);
    let method = payload
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let params = payload
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    match state.rpc.dispatch(&method, params) {
        Ok(value) => Response::success(request.id, value),
        Err(msg) => {
            let code = if msg.starts_with("method not found") {
                error_codes::METHOD_NOT_FOUND
            } else {
                error_codes::INVALID_PARAMS
            };
            Response::error(Some(request.id), code, msg)
        }
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
    // RUST-069-W:注册走 WorkspaceSession 唯一发号器(重复 initialize 幂等)。
    if let Some(root_uri) = params.root_uri.as_deref() {
        if let Ok(root) = CanonicalUri::parse(root_uri) {
            state.session.add_root(root.as_path());
        }
    }
    // KBUG-ROOT:多工作区文件夹逐个注册(LSP workspaceFolders);归属依据,
    // 跨根同名实体隔离依赖此注册齐全。
    for folder in params.workspace_folders.into_iter().flatten() {
        if let Ok(root) = CanonicalUri::parse(&folder.uri) {
            state.session.add_root(root.as_path());
        }
    }
    state.initialized = true;
    let result = InitializeResult {
        capabilities: ServerCapabilities {
            text_document_sync: TextDocumentSyncOptions {
                open_close: true,
                change: 1,
            },
            hover_provider: true,
            // Phase2 首片:textDocument/definition(语料声明落点面)。
            definition_provider: true,
            // RUST-139 批 3:textDocument/documentSymbol(def 段符号面)。
            document_symbol_provider: true,
            // RUST-138 批 3:textDocument/references(语料声明+引用位面)。
            references_provider: true,
            // RUST-141 批 2:textDocument/rename+prepareRename(def 重命名面)。
            rename_provider: true,
            // RUST-143 批 3:textDocument/codeAction(四族装配面)。
            code_action_provider: true,
            signature_help_provider: true,
            // RUST-139 批 4:workspace/symbol(def 符号前缀检索面)。
            workspace_symbol_provider: true,
            // PR-011:completion 触发字符 `<`(def 标签位)。
            completion_provider: Some(kode_protocol::CompletionOptions {
                trigger_characters: vec!["<".to_string()],
                // RUST-135:completionItem/resolve 延迟补详情面。
                resolve_provider: true,
            }),
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
    cancelled_early: bool,
) -> Response {
    let ms = request
        .params
        .as_ref()
        .and_then(|p| p.get("ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(WAIT_MAX_MS);
    let flag = state.cancels.register_cancellable(&request.id);
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
        "workspace/didDeleteFiles" => {
            handle_did_delete_files(state, notification.params);
            Vec::new()
        }
        "workspace/didRenameFiles" => {
            handle_did_rename_files(state, notification.params);
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

/// RUST-070/071/073:请求入口刷新(freshen 自键 + 有界追赶)。请求所需
/// 文件先于服务执行(打开文档小范围交互 > 局部刷新,CORE-005);小语料
/// 单请求即全量就绪(同步语义形状不变),大语料余量留给空闲切片。
fn drain_index_for_request(state: &mut ServerState, key: &DocumentKey) {
    let identity = crate::index_queue::identity_of(key);
    // RUST-082:该文件还在风暴窗内则立即移交(不等窗口到期),随后的
    // freshen 即可执行它——打开文档请求即新鲜。
    state.index.take_buffered(&identity);
    state.index.freshen(&identity);
    state.index.pump_budgeted_until(
        crate::index_queue::REQUEST_DRAIN_BUDGET,
        std::time::Instant::now()
            + std::time::Duration::from_millis(crate::index_queue::REQUEST_DRAIN_BUDGET_MS),
    );
}

/// 检索面追赶的墙钟护栏(秒):远大于任何单次查询的合理等待,只防死等——
/// 隔离由条数界(REQUEST_DRAIN_BUDGET)保证,不由墙钟保证。
const GLOBAL_REQUEST_DRAIN_GUARD_SECS: u64 = 30;

/// 无文档上下文的请求入口刷新(RUST-139 批 4:workspace/symbol):检索面
/// 不带文档键,无键可 freshen,只能追赶入库队列——否则 didOpen 的入库任务
/// 还在队列里时语料视图未就绪,检索面恒空集(与 documentSymbol 等按文档键
/// 刷新的臂不同源)。追赶是**纯条数界**:检索面的错答是空集而非慢答——
/// didOpen 入库没走完就答,用户会以为工程里没有该符号(2026-11-24 复现:
/// llvm-cov 仪表化负载下 4ms 墙钟界必然提前收工,CI workspace_symbol_dispatch
/// 三例恒空,本地未仪表化恒绿=负载族)。最坏无响应间隔仍由条数界 + 单任务
/// 解析时长封顶(RESP-001b 读盘已离线),按文档键的臂不动仍走 4ms 墙钟界。
fn drain_index_for_global_request(state: &mut ServerState) {
    state.index.pump_budgeted_until(
        crate::index_queue::REQUEST_DRAIN_BUDGET,
        std::time::Instant::now() + std::time::Duration::from_secs(GLOBAL_REQUEST_DRAIN_GUARD_SECS),
    );
}

/// textDocument/hover(PR-010/LSP-003):文档须已打开(open overlay 优先,
/// VFS-003);未打开/未知词一律回 null 结果(LSP 允许),不报错不阻塞。
/// 响应结构:contents.markdown(LSP 兼容)+ 结构化链面在 kode-server 侧
/// 单测/对拍 golden 中锁定(本切片不外泄扩展字段)。
fn handle_hover(state: &mut ServerState, request: Request) -> Response {
    let params: HoverParams = match request.params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(params) => params,
        None => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "invalid textDocument/hover params",
            )
        }
    };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    drain_index_for_request(state, &key);
    let Some((_, buffer)) = state.store.borrow().open_buffer(&key) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let text = buffer.text().to_string();
    if let Some(hover) = crate::python_process::hover(
        key.uri.as_path(),
        &text,
        params.position.line,
        params.position.character,
    ) {
        return Response::success(request.id, hover);
    }
    let hover =
        state
            .hover
            .borrow()
            .hover(&key, &text, params.position.line, params.position.character);
    match hover {
        Some(response) => Response::success(
            request.id,
            serde_json::json!({
                "contents": {
                    "kind": "markdown",
                    "value": crate::hover::render_markdown(&response),
                }
            }),
        ),
        None => Response::success(request.id, serde_json::Value::Null),
    }
}

/// textDocument/completion(PR-011/LSP-005):文档须已打开(open overlay 优先,
/// VFS-003);未打开/未判定上下文一律回 null 结果(LSP 允许),不报错不阻塞。
/// 可取消查询(CORE-007 同通道):先到取消通知或取消标志置位 → -32800;
/// 计算本身纯内存,取消检查在入口判定(不为纯同步计算开轮询间隙)。
/// 版本化:应答只基于 DocumentStore 严格 version 转移后的 overlay 真相
/// (VFS-003/004;过期版本改动被拒,请求永不见旧文本)。
fn handle_completion(state: &mut ServerState, request: Request, cancelled_early: bool) -> Response {
    let params: CompletionParams = match request.params.and_then(|p| serde_json::from_value(p).ok())
    {
        Some(params) => params,
        None => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "invalid textDocument/completion params",
            )
        }
    };
    let flag = state.cancels.register_cancellable(&request.id);
    let cancelled = cancelled_early || flag.load(Ordering::SeqCst);
    state.cancels.end_cancellable(&request.id);
    if cancelled {
        return Response::error(
            Some(request.id),
            error_codes::REQUEST_CANCELLED,
            "request cancelled via $/cancelRequest",
        );
    }
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    drain_index_for_request(state, &key);
    let Some((_, buffer)) = state.store.borrow().open_buffer(&key) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let text = buffer.text().to_string();
    let completion = state.hover.borrow().completion(
        &key,
        &text,
        params.position.line,
        params.position.character,
    );
    match completion {
        Some(response) => Response::success(request.id, to_lsp_items(&response, key.root)),
        None => Response::success(request.id, serde_json::Value::Null),
    }
}

/// completionItem/resolve(RUST-135 延迟补详情):params = 客户端回传的
/// CompletionItem(含 completion 时嵌入的 data 往返载荷);按载荷复算
/// 文档面(类型/Flags/签名/分面/来源),零 IO——只碰已入库语料视图。
/// 载荷不可判/语料缺位/归属歧义 → 输入原样返回(不装空文档)。可取消
/// (同 completion 入口判定口径)。
fn handle_completion_resolve(
    state: &mut ServerState,
    request: Request,
    cancelled_early: bool,
) -> Response {
    let item: serde_json::Value = match request.params.and_then(|p| serde_json::from_value(p).ok())
    {
        Some(item) => item,
        None => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "invalid completionItem/resolve params",
            )
        }
    };
    let flag = state.cancels.register_cancellable(&request.id);
    let cancelled = cancelled_early || flag.load(Ordering::SeqCst);
    state.cancels.end_cancellable(&request.id);
    if cancelled {
        return Response::error(
            Some(request.id),
            error_codes::REQUEST_CANCELLED,
            "request cancelled via $/cancelRequest",
        );
    }
    Response::success(
        request.id,
        crate::completion::resolve_item(&state.hover.borrow(), &item),
    )
}

/// textDocument/definition(Phase2 首片):文档须已打开;未打开/未知词/
/// 语料无落点一律回 null 结果(LSP 允许),不报错不阻塞。面 = 语料声明
/// 落点(docs/kode2/phase2-slice-a.md §面定义;Python/schema/stub 落点
/// 不在本面,Rust 恒 null 划归边界)。
fn handle_definition(state: &mut ServerState, request: Request) -> Response {
    let params: DefinitionParams = match request.params.and_then(|p| serde_json::from_value(p).ok())
    {
        Some(params) => params,
        None => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "invalid textDocument/definition params",
            )
        }
    };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    drain_index_for_request(state, &key);
    let Some((_, buffer)) = state.store.borrow().open_buffer(&key) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let text = buffer.text().to_string();
    let definition = state.hover.borrow().definition(
        &key,
        &text,
        params.position.line,
        params.position.character,
    );
    match definition {
        Some(location) => Response::success(
            request.id,
            serde_json::to_value(location).expect("serialize location"),
        ),
        None => Response::success(request.id, serde_json::Value::Null),
    }
}

/// textDocument/documentSymbol(RUST-139 批 3):def 段符号面——Properties/
/// 三方法段作容器符号、段内直接声明作子符号(核在
/// [`crate::document_symbols::document_symbols`],与 TS IDE-NAV-005 逐点同构)。
/// 文档须已打开;未打开/解析无根一律回 null 结果(LSP 允许),不报错不阻塞。
/// 诚实边界:本面只出段符号树;进程段面包屑合成根(跨文件对端跳)是 TS
/// provider 投影层职责,不在本面(Rust 恒不含合成根)。
fn handle_document_symbol(state: &mut ServerState, request: Request) -> Response {
    let params: DocumentSymbolParams =
        match request.params.and_then(|p| serde_json::from_value(p).ok()) {
            Some(params) => params,
            None => {
                return Response::error(
                    Some(request.id),
                    error_codes::INVALID_PARAMS,
                    "invalid textDocument/documentSymbol params",
                )
            }
        };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    drain_index_for_request(state, &key);
    let Some((_, buffer)) = state.store.borrow().open_buffer(&key) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let text = buffer.text().to_string();
    match crate::document_symbols::document_symbols(&text) {
        Some(symbols) => Response::success(
            request.id,
            serde_json::to_value(symbols).expect("serialize document symbols"),
        ),
        None => Response::success(request.id, serde_json::Value::Null),
    }
}

/// textDocument/references(RUST-138 批 3 接线;批 4 切语义过滤面):
/// 语料引用面——def 文档出自定义类型/实体 Parent/接口名三类目标的声明位
/// (includeDeclaration 才前置)+ 全语料站点位;types.xml 文档出该类型名在
/// 全语料 .def/<Type>/<Arg>/<of> 值与 types.xml 内引用位(该面无声明位,
/// includeDeclaration 不生效,与 TS provideTypesXmlReferences 同)。
/// 文档须已打开;未打开/未知符号/空结果一律回 null 结果(LSP 允许),不报错。
/// 诚实边界:本面只出语料面引用。Properties/方法段的属性 self 访问与
/// Python 调用点面由 entityMapping 运行时索引(TS)负责,Python 文档本面恒
/// null。站点面走 semantic_reference_locations(批 2 分类核过滤):跨 root
/// 同名异声明(Shadow)与站点域不可解析(Dangling)不入列——2026-11-21 用户
/// 拍板「先切 Rust,测试发现问题」:误杀随发现随修,不再由 TS 兜底补回
/// 同名语法站点(消费点见 references.ts 的 authoritative 分支)。
fn handle_references(state: &mut ServerState, request: Request) -> Response {
    let params: ReferenceParams = match request.params.and_then(|p| serde_json::from_value(p).ok())
    {
        Some(params) => params,
        None => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "invalid textDocument/references params",
            )
        }
    };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    drain_index_for_request(state, &key);
    let Some((_, buffer)) = state.store.borrow().open_buffer(&key) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let text = buffer.text().to_string();
    let locations = state.hover.borrow().semantic_reference_locations(
        &key,
        &text,
        params.position.line,
        params.position.character,
        params.context.include_declaration,
    );
    match locations {
        Some(locations) => Response::success(
            request.id,
            serde_json::to_value(locations).expect("serialize reference locations"),
        ),
        None => Response::success(request.id, serde_json::Value::Null),
    }
}

/// 请求文档文本(uri 解析 → root 归属 → 索引清泵 → 打开缓冲;未打开 None)。
/// 重命名两臂与 documentSymbol/references 同步前置链的公共形状。
fn request_document_text(
    state: &mut ServerState,
    uri_string: &str,
) -> Option<(DocumentKey, String)> {
    let uri = CanonicalUri::parse(uri_string).ok()?;
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    drain_index_for_request(state, &key);
    let (_, buffer) = state.store.borrow().open_buffer(&key)?;
    Some((key, buffer.text().to_string()))
}

/// textDocument/prepareRename(RUST-141 批 2):可重命名符号解析面——def
/// 属性/方法名上的光标给出候选名区间与占位名(核
/// [`crate::def_rename::resolve_rename_symbol_at_offset`],TS defRenamer 同构)。
/// 文档须已打开;未打开/光标不在可重命名符号上回 null(LSP 允许)。
fn handle_prepare_rename(state: &mut ServerState, request: Request) -> Response {
    let params: PrepareRenameParams =
        match request.params.and_then(|p| serde_json::from_value(p).ok()) {
            Some(params) => params,
            None => {
                return Response::error(
                    Some(request.id),
                    error_codes::INVALID_PARAMS,
                    "invalid textDocument/prepareRename params",
                )
            }
        };
    let Some((_, text)) = request_document_text(state, &params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let offset = crate::def_rename::utf16_position_to_offset(
        &units,
        params.position.line as usize,
        params.position.character as usize,
    );
    let Some(symbol) = crate::def_rename::resolve_rename_symbol_at_offset(&text, offset) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let (start_line, start_character) =
        crate::def_rename::utf16_offset_to_position(&units, symbol.word_start);
    let (end_line, end_character) =
        crate::def_rename::utf16_offset_to_position(&units, symbol.word_end);
    Response::success(
        request.id,
        serde_json::json!({
            "range": {
                "start": {"line": start_line, "character": start_character},
                "end": {"line": end_line, "character": end_character}
            },
            "placeholder": symbol.name,
        }),
    )
}

/// textDocument/rename(RUST-141 批 2):def 重命名编辑复算面——符号解析 +
/// 同文件冲突预检(NAV-008)+ 祖先/后代闭包占名预检(AUD-061)+ 目标与后代
/// def 全部编辑(AUD-046 闭包语义)。应答 = `{conflict, closureConflict,
/// fileEdits}` 三键(冲突位不阻塞应答,由调用方决定抛错文案;fileEdits 仅在
/// 双冲突皆空时非空,编辑位为 LSP (line,character) 区间,各行按文件自身
/// 文本换算)。python self 访问/receiver 调用改写面归 TS entityMapping,
/// 不在本面。
/// 诚实边界:闭包预检与后代发现走盘上语料(`find_entity_defs_root_from_file`
/// 向上走查 entities.xml + 递归列 def;决策核既有行为),跨文件文本先查服务
/// 端已同步文档(打开缓冲区优先,与 TS readSharedFileSnapshot 同语义)再落盘读。
fn handle_rename(state: &mut ServerState, request: Request) -> Response {
    let params: RenameParams = match request.params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(params) => params,
        None => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "invalid textDocument/rename params",
            )
        }
    };
    let Some((key, text)) = request_document_text(state, &params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let path = key.uri.as_path().to_string();
    let units: Vec<u16> = text.encode_utf16().collect();
    let offset = crate::def_rename::utf16_position_to_offset(
        &units,
        params.position.line as usize,
        params.position.character as usize,
    );
    let Some(symbol) = crate::def_rename::resolve_rename_symbol_at_offset(&text, offset) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let conflict = crate::def_rename::find_def_rename_conflict(&text, &symbol, &params.new_name);
    // 跨文件读取:已同步文档(打开缓冲区)优先,否则盘读(与 TS
    // readSharedFileSnapshot 同语义)。DocumentStore 无该路径 buffer = 未
    // 镜像/已关,落盘即快照真值。
    let cross_file = |file: &std::path::Path| -> Option<String> {
        let uri = kode_vfs::CanonicalUri::from_path(&file.to_string_lossy());
        let root = state.session.root_for(&uri);
        let key = DocumentKey::new(root, uri);
        if let Some((_, buffer)) = state.store.borrow().open_buffer(&key) {
            return Some(buffer.text().to_string());
        }
        std::fs::read_to_string(file).ok()
    };
    let closure_conflict = crate::def_rename::find_def_rename_conflict_in_closure(
        std::path::Path::new(&path),
        &text,
        &symbol,
        &params.new_name,
        &cross_file,
    );
    let mut file_edits = Vec::new();
    if conflict.is_none() && closure_conflict.is_none() {
        for edit in crate::def_rename::compute_def_rename_edits(
            std::path::Path::new(&path),
            &text,
            &symbol,
            &params.new_name,
            &cross_file,
        ) {
            let file_units: Vec<u16> = edit.text.encode_utf16().collect();
            let ranges: Vec<serde_json::Value> = edit
                .edits
                .iter()
                .map(|range| {
                    let (start_line, start_character) =
                        crate::def_rename::utf16_offset_to_position(&file_units, range.start);
                    let (end_line, end_character) =
                        crate::def_rename::utf16_offset_to_position(&file_units, range.end);
                    serde_json::json!({
                        "start": {"line": start_line, "character": start_character},
                        "end": {"line": end_line, "character": end_character},
                    })
                })
                .collect();
            file_edits.push(serde_json::json!({
                "filePath": edit.file_path.to_string_lossy(),
                "edits": ranges,
            }));
        }
    }
    Response::success(
        request.id,
        serde_json::json!({
            "conflict": conflict.map(|c| serde_json::to_value(c).expect("serialize conflict")),
            "closureConflict": closure_conflict
                .map(|c| serde_json::to_value(c).expect("serialize conflict")),
            "fileEdits": file_edits,
        }),
    )
}

/// textDocument/codeAction(RUST-143 批 3):四族装配决策面——修参数类型/
/// 创建缺失定义/冲突定位(receiver-none 守卫双动作 + FIXED_DICT 整体重赋)。
/// 决策核 [`crate::code_action_assembly`] 纯库直用;`family` 分派单族装配,
/// 产出 ActionFace 描述符数组。诚实边界:registered 近拼宇宙由 TS
/// getKnownTypeContext 装配入参;parity 族目标 python 快照由 TS
/// readSharedFileSnapshot 打开缓冲区优先读入参;vscode.Diagnostic/WorkspaceEdit
/// 对象构造与 l10n 标题(titleParams 按族插值)归 TS 薄壳,不在本面。
/// 文档须已打开(未开档回 null);未知 family 回 -32602(枚举入参诚实拒绝,
/// 不静默空数组)。
fn handle_code_action(state: &mut ServerState, request: Request) -> Response {
    let params: CodeActionParams = match request.params.and_then(|p| serde_json::from_value(p).ok())
    {
        Some(params) => params,
        None => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "invalid textDocument/codeAction params",
            )
        }
    };
    let Some((key, text)) = request_document_text(state, &params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let doc_file = key.uri.as_path().to_string();
    let to_gate_range = |range: &kode_protocol::Range| crate::code_action_assembly::GateRange {
        start_line: range.start.line as usize,
        start_char: range.start.character as usize,
        end_line: range.end.line as usize,
        end_char: range.end.character as usize,
    };
    let diagnostics: Vec<CodeActionDiagnostic> = params.diagnostics;
    let gate_diagnostics: Vec<crate::code_action_assembly::DiagnosticGateFace> = diagnostics
        .iter()
        .map(
            |diagnostic| crate::code_action_assembly::DiagnosticGateFace {
                code: diagnostic.code.clone(),
                range: to_gate_range(&diagnostic.range),
                related_file: diagnostic.related_file.clone(),
                related_message: diagnostic.related_message.clone(),
            },
        )
        .collect();
    let request_range = crate::code_action_assembly::RequestRangeFace {
        start_line: params.range.start.line as usize,
        start_char: params.range.start.character as usize,
        end_line: params.range.end.line as usize,
        end_char: params.range.end.character as usize,
    };
    let registered: Vec<&str> = params.registered.iter().map(String::as_str).collect();
    let actions = match params.family.as_str() {
        "typeReplacement" => crate::code_action_assembly::assemble_type_replacement_actions(
            &text,
            &doc_file,
            &registered,
            &gate_diagnostics,
            &request_range,
        ),
        "parityMethod" => crate::code_action_assembly::assemble_parity_method_actions(
            &text,
            &doc_file,
            params.snapshot_text.as_deref(),
            &gate_diagnostics,
            &request_range,
        ),
        "receiverNone" => crate::code_action_assembly::assemble_receiver_none_actions(
            &text,
            &doc_file,
            &gate_diagnostics,
            &request_range,
        ),
        "fixedDict" => crate::code_action_assembly::assemble_fixed_dict_actions(
            &text,
            &doc_file,
            &gate_diagnostics,
            &request_range,
        ),
        _ => {
            return Response::error(
                Some(request.id),
                error_codes::INVALID_PARAMS,
                "unknown codeAction family",
            )
        }
    };
    let faces: Vec<serde_json::Value> = actions
        .iter()
        .map(|action| serde_json::to_value(action).expect("serialize action face"))
        .collect();
    Response::success(request.id, serde_json::Value::Array(faces))
}

/// textDocument/signatureHelp(RUST-140 批 3):python 调用点词法(python_call_at,
/// 与 TS getPythonCallAtPosition 同构)→ 本域继承链闭包签名决策(signature_help
/// 决策核,打分/段闸/回退/骨架组装全在 Rust)→ SignatureHelpFace + 活动形参
/// 标亮(clamp)。文档须已打开(未开档回 null);光标不在调用点/解析不到签名 →
/// null(LSP 允许)。诚实边界:实体注册表运行时链(EntityMappingManager)不跨
/// 该面,签名来源是语料 def 视图;vscode SignatureHelp/ParameterInformation
/// 对象构造与 MarkdownString 包装归 TS 薄壳。
fn handle_signature_help(state: &mut ServerState, request: Request) -> Response {
    let params: SignatureHelpParams =
        match request.params.and_then(|p| serde_json::from_value(p).ok()) {
            Some(params) => params,
            None => {
                return Response::error(
                    Some(request.id),
                    error_codes::INVALID_PARAMS,
                    "invalid textDocument/signatureHelp params",
                );
            }
        };
    let Some((key, text)) = request_document_text(state, &params.text_document.uri) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let Some(line) = text.split('\n').nth(params.position.line as usize) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let Some(call) = crate::python_call_at::get_python_call_at_position(
        line,
        params.position.character as usize,
    ) else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let doc_file = key.uri.as_path().to_string();
    let face = state
        .hover
        .borrow()
        .signature_help(&doc_file, &call.method_name, call.section);
    let Some(face) = face else {
        return Response::success(request.id, serde_json::Value::Null);
    };
    let active_parameter =
        crate::signature_help::clamp_active_parameter(call.active_argument, face.parameters.len());
    Response::success(
        request.id,
        serde_json::json!({
            "signature": face,
            "activeParameter": active_parameter
        }),
    )
}

/// workspace/symbol(RUST-139 批 4 接线;LSP 规范方法名,todo/评审文档
/// 记作 textDocument/workspaceSymbol):Ctrl+T def 符号前缀检索面。决策核 =
/// workspace_symbols.rs 批 2(语料 entity 类 def root 集 + effective 折叠
/// 闭包 + 组件槽独立面,rootName→symbolName→line 三键排序),本臂零决策输入。
/// 应答 `{symbols:[WorkspaceSymbolHit...]}`;空前缀=全集,无命中回空集不回
/// null(与 documentSymbol「空集=可解析无符号段」区分同口径)。
fn handle_workspace_symbol(state: &mut ServerState, request: Request) -> Response {
    let params: WorkspaceSymbolParams =
        match request.params.and_then(|p| serde_json::from_value(p).ok()) {
            Some(params) => params,
            None => {
                return Response::error(
                    Some(request.id),
                    error_codes::INVALID_PARAMS,
                    "invalid workspace/symbol params",
                );
            }
        };
    // 检索面无文档键,只追赶积压入库(见 drain_index_for_global_request)。
    drain_index_for_global_request(state);
    let hits = state
        .hover
        .borrow()
        .workspace_symbols_by_prefix(&params.query);
    Response::success(request.id, serde_json::json!({ "symbols": hits }))
}

/// RUST-142/RESP-001:诊断 flush 切片预算——至多这么多脏文档**且**不越墙钟界。
/// 与索引 `pump_budgeted_until` 同源双界:lint 解析不可抢占,条数约束不了
/// 响应时间(30×200KB 脏集一次排空=数秒主循环阻塞,health 回合被排队),
/// 故与索引切片同宽(16ms)。
pub const DIAGNOSTIC_FLUSH_BUDGET_MS: u64 = 16;
/// 单次诊断切片的文档条数上界(墙钟界的第二道:极小文档批量)。
pub const DIAGNOSTIC_FLUSH_MAX_DOCS: usize = 8;

/// RUST-142:诊断管线 flush——排空脏文档,经四层调度核计算/节流并发射
/// `$/kode/publishDiagnostics` 通知。主循环空闲 tick 调用;返回待写出的
/// 通知(write_outgoing 落 stdout)。空脏集零开销直通。
///
/// RESP-001:诊断 lint 与 ingest 同为不可抢占的单任务——按
/// `DIAGNOSTIC_FLUSH_MAX_DOCS` + `deadline` 双界切片;界外余量原样回脏集,
/// 由后续空闲 tick 追平(洪水在静默期追平)。切片起始 `deadline` 恒在将来,
/// 故每次切片至少处理首条:CORE-006 不永久推迟。
///
/// 发射面 = 层核 sink 的「本 flush 已请求的 (layer, uri) 最新记录」(换代
/// 后旧 items 不虚报,批 1 语义;跨 flush 旧记录因「本 flush 未请求」被
/// 跳过,不重放)。findings 本体在调用方留存((uri, layer) → Vec<Finding>),
/// 调度器只记账索引(TaskSpec.items 是 bucket 下标,计算在调用方)。
/// C-19(def↔Python 一致性)输入在 TS 侧现采,本面以缺省 parity 输入跑
/// (零产出)——诚实边界:C-19 仍走 TS pull 腿,本面不重复发射。
pub fn flush_diagnostics_pipeline(state: &mut ServerState, deadline: Instant) -> Vec<Outgoing> {
    use crate::diagnostic_pipeline::{DiagnosticLayer, PublishRecord, TaskSpec};
    use crate::lint::{
        analyze_create_params_calls, analyze_def_with_python, Finding, InheritedNames,
        PythonParityInput,
    };

    let dirty: Vec<(String, i64)> = state
        .diagnostics_dirty
        .iter()
        .map(|(uri, version)| (uri.clone(), *version))
        .collect();
    state.diagnostics_dirty.clear();
    if dirty.is_empty() {
        return Vec::new();
    }
    // 已知类型语料(引擎实体 + types.xml/alias.xml 自定义;unknown-type-
    // reference 规则的 known 集,与 golden dump 同口径)。
    let type_ctx = state.hover.borrow().type_context();
    let known: Vec<&str> = type_ctx
        .entity_types
        .iter()
        .chain(type_ctx.custom_types.iter())
        .map(|s| s.as_str())
        .collect();
    let mut resolved: BTreeMap<(String, DiagnosticLayer), Vec<Finding>> = BTreeMap::new();
    let mut requested: BTreeSet<(String, DiagnosticLayer)> = BTreeSet::new();
    for (index, (uri_string, version)) in dirty.iter().enumerate() {
        if index >= DIAGNOSTIC_FLUSH_MAX_DOCS || Instant::now() >= deadline {
            // 界外余量回脏集(版本原样),由后续空闲 tick 追平。
            for (rest_uri, rest_version) in dirty[index..].iter() {
                state
                    .diagnostics_dirty
                    .insert(rest_uri.clone(), *rest_version);
            }
            break;
        }
        let Ok(uri) = CanonicalUri::parse(uri_string) else {
            continue;
        };
        let root = state.session.root_for(&uri);
        let key = DocumentKey::new(root, uri);
        let Some((_, buffer)) = state.store.borrow().open_buffer(&key) else {
            continue;
        };
        let text = buffer.text().to_string();
        // Document-kind dispatch: .def documents run the def lint; .py
        // documents run the CREATE-05 creation-API params face (the params
        // dict of the creation-API family lands in the engine-internal
        // createNamespace). Everything else: rootless XML -> empty face,
        // same discipline as before the dispatch existed.
        let findings = if key.uri.as_path().ends_with(".py") {
            // Field catalog from the hover corpus (same root as the .py
            // document). Entities absent from the corpus stay silent inside
            // check_params (IndexMissing; never "def does not declare").
            let hover = state.hover.borrow();
            let catalog = |entity: &str| {
                hover
                    .def_by_name
                    .get(&(root, entity.to_string()))
                    .and_then(|paths| paths.iter().find_map(|path| hover.def_file(path)))
                    .map(|def| {
                        crate::lint::create_params_calls::EntityFieldSet::from_def(&def.properties)
                    })
            };
            analyze_create_params_calls(&text, &catalog)
        } else {
            let Ok(findings) = analyze_def_with_python(
                &text,
                &InheritedNames::default(),
                &known,
                PythonParityInput::default(),
            ) else {
                continue;
            };
            findings
        };
        let routed = crate::diagnostic_layering::route_findings(findings);
        for layer in DiagnosticLayer::ALL {
            let bucket = routed.bucket(layer);
            if bucket.is_empty() {
                continue;
            }
            resolved.insert((uri_string.clone(), layer), bucket.clone());
            requested.insert((uri_string.clone(), layer));
            let items: Vec<u32> = (0..bucket.len() as u32).collect();
            state.diagnostics_pipelines.core(layer).request(
                uri_string,
                Some(*version),
                TaskSpec {
                    items,
                    async_id: None,
                    side_effects: Vec::new(),
                },
            );
        }
    }
    // 合流 → 每 (layer, uri) 最新记录(层名字节序 + 层内请求序,末位最新)。
    let mut latest: BTreeMap<(String, String), Vec<u32>> = BTreeMap::new();
    for record in state.diagnostics_pipelines.merged_publish() {
        if let PublishRecord::Publish { layer, uri, items } = record {
            latest.insert((layer.as_str().to_string(), uri.clone()), items.clone());
        }
    }
    let mut out = Vec::new();
    for ((layer_name, uri), items) in latest {
        let layer = DiagnosticLayer::parse(&layer_name).expect("layer name");
        if !requested.contains(&(uri.clone(), layer)) {
            // 本 flush 未请求该 (layer, uri):跨 flush 旧记录,不重放。
            continue;
        }
        let mut findings: Vec<Finding> = Vec::new();
        for index in items {
            if let Some(finding) = resolved
                .get(&(uri.clone(), layer))
                .and_then(|bucket| bucket.get(index as usize))
            {
                findings.push(finding.clone());
            }
        }
        let version = dirty.iter().find(|(u, _)| *u == uri).map(|(_, v)| *v);
        out.push(Outgoing::Notification(ServerNotification::new(
            "$/kode/publishDiagnostics",
            Some(serde_json::json!({
                "uri": uri,
                "version": version,
                "layer": layer_name,
                "findings": findings,
            })),
        )));
    }
    out
}

/// textDocument/diagnostic(Phase2 首片,LSP pull 诊断 full 报告形):
/// `{kind:"full", items:[DiagnosticFace...]}`。文档须已打开;未打开回
/// 空 items(不报错不阻塞)。面 = TS validateDocument 语料子集。
fn handle_diagnostic(state: &mut ServerState, request: Request) -> Response {
    let params: DocumentDiagnosticParams =
        match request.params.and_then(|p| serde_json::from_value(p).ok()) {
            Some(params) => params,
            None => {
                return Response::error(
                    Some(request.id),
                    error_codes::INVALID_PARAMS,
                    "invalid textDocument/diagnostic params",
                )
            }
        };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return Response::success(
            request.id,
            serde_json::json!({ "kind": "full", "items": [] }),
        );
    };
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    drain_index_for_request(state, &key);
    let Some((_, buffer)) = state.store.borrow().open_buffer(&key) else {
        return Response::success(
            request.id,
            serde_json::json!({ "kind": "full", "items": [] }),
        );
    };
    let text = buffer.text().to_string();
    let items: Vec<DiagnosticFace> = state.hover.borrow().diagnostics(key.uri.as_path(), &text);
    Response::success(
        request.id,
        serde_json::json!({ "kind": "full", "items": items }),
    )
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
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri.clone());
    if state
        .store
        .borrow_mut()
        .open(
            key.clone(),
            params.text_document.version,
            params.text_document.text.clone(),
        )
        .is_ok()
    {
        // hover 语料 ingest 入索引刷新队列(RUST-070/071/073:DEPENDENCY_
        // UPDATE keyed 去重)——不再内联解析,镜像洪水不再压住交互帧;请求
        // 入口 freshen 自键保打开文档即时新鲜。版本 = 打开版本(同版本重发
        // 在队即合并)。open 不过风暴窗(交互即时需求)。
        let version = u64::try_from(params.text_document.version).unwrap_or(0);
        // RUST-125:打开触达解析缓存(驱逐缓刑;「当前打开文件优先」)。
        state.index.note_buffer_open(&key);
        state.index.request_open(&key, version);
        // RUST-142:打开即标记诊断脏(主循环 flush 计算并发射该版本诊断;
        // 与索引风暴缓冲独立,层核节流面)。uri 用客户端原串(通知回显可对账)。
        state.diagnostics_dirty.insert(
            params.text_document.uri.clone(),
            params.text_document.version,
        );
    }
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
    let root = state.session.root_for(&uri);
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
        .borrow_mut()
        .change(&key, params.text_document.version, changes);
    // hover 语料 ingest 入风暴缓冲(RUST-082:时间窗合并,max latency 有界
    // ——连续敲键至多每窗一批;CORE-008 keyed 让位仍兜底)。窗口到期由主
    // 循环 flush_due 移交调度队列;请求入口对该文件立即移交(take_buffered)
    // 保打开文档请求即新鲜。
    let version = u64::try_from(params.text_document.version).unwrap_or(0);
    state.index.record_change(&key, version);
    // RUST-142:版本转移成功即标记诊断脏(独立于索引风暴缓冲;层核节流由
    // 主循环 flush 驱动,版本换代即重算发布,同版跳过语义在层核内)。
    state.diagnostics_dirty.insert(
        params.text_document.uri.clone(),
        params.text_document.version,
    );
}

/// didClose → 移除 overlay,文档回落磁盘真相(VFS-003 close 转移)。
fn handle_did_close(state: &mut ServerState, params: Option<serde_json::Value>) {
    let Ok(params) = serde_json::from_value::<DidCloseParams>(params.unwrap_or_default()) else {
        return;
    };
    let Ok(uri) = CanonicalUri::parse(&params.text_document.uri) else {
        return;
    };
    let root = state.session.root_for(&uri);
    let key = DocumentKey::new(root, uri);
    state.store.borrow_mut().close(&key);
    // VFS-012 下游清理(修订):关闭 ≠ 删除。刷新入队(RUST-070/071/073):
    // 执行时刻真相 = 盘上仍在回读磁盘重蓄语料视图(符号/def/types 继续喂
    // 补全与悬停),读盘失败(已删除/不可读)才真正逐出 —— 此前连带
    // hover.remove,盘上类型凭空消失,消费文件补全静默空。version=None
    // 与打开/编辑的 Some(version) 不同键:close 后必让位重入队,不合并
    // (close 不过风暴窗:状态转移)。
    state.index.request_close(&key);
    // RUST-142:关闭即摘脏 + 四层释放(层核 releasedDropped 记账;晚到
    // 异步以自己版本发布/关闭代守卫不虚报——批 1 语义继承)。
    state.diagnostics_dirty.remove(&params.text_document.uri);
    for layer in crate::diagnostic_pipeline::DiagnosticLayer::ALL {
        state
            .diagnostics_pipelines
            .core(layer)
            .release_document(&params.text_document.uri);
    }
}

/// RUST-131-W:workspace/didDeleteFiles(生产文件事件)——旧 URI 全链撤销:
/// 队列摘除该身份的待执行刷新与风暴缓冲事件(晚到旧任务复活禁令)+
/// store overlay/盘缓存逐出(VFS-012)+ hover 符号/语料/def 候选/解析
/// 注册表连带(符号、反向依赖、解析缓存一条 remove 链收口)。根外路径
/// 与不可解析 URI 诚实跳过(共享缓存身份永不脱离已注册根)。诊断为
/// pull 形态:textDocument/diagnostic 对已逐出键回空 items(既有形状)。
/// 引用与生成源映射在本轨无独立存储面——引用经解析注册表随键撤销,生成
/// 源映射未接入(诚实边界,见验收文档)。
fn handle_did_delete_files(state: &mut ServerState, params: Option<serde_json::Value>) {
    let Ok(params) = serde_json::from_value::<DeleteFilesParams>(params.unwrap_or_default()) else {
        return;
    };
    for DeletedFile { uri } in &params.files {
        evict_uri(state, uri);
    }
}

/// RUST-131-W:workspace/didRenameFiles——旧 URI 全链撤销(同删除链),
/// 新 URI 经 request_close 执行时刻真相重放(overlay 优先回落磁盘,读盘
/// 失败 = 逐出):didOpen(new) 先到则 overlay 未保存修订胜出,后到则其
/// 自身入队兜底,未打开则回读盘上新文件;跨根移动新旧各归其根。
fn handle_did_rename_files(state: &mut ServerState, params: Option<serde_json::Value>) {
    let Ok(params) = serde_json::from_value::<RenameFilesParams>(params.unwrap_or_default()) else {
        return;
    };
    for RenamedFile { old_uri, new_uri } in &params.files {
        evict_uri(state, old_uri);
        if let Ok(new) = CanonicalUri::parse(new_uri) {
            if let Some(new_key) = state.session.key_for(&new) {
                state.index.request_close(&new_key);
            }
        }
    }
}

/// 单 URI 撤销全链(delete 主干,rename 旧侧共用):不可解析/根外诚实跳过;
/// 命中则队列摘除 + store 逐出 + hover 全链 remove(同步序,无并发穿插,
/// 泵只可能经残留待执行任务复活——已全部摘除)。
fn evict_uri(state: &mut ServerState, uri: &str) {
    let Ok(parsed) = CanonicalUri::parse(uri) else {
        return;
    };
    let Some(key) = state.session.key_for(&parsed) else {
        return;
    };
    let identity = crate::index_queue::identity_of(&key);
    state.index.purge_key(&identity);
    state.store.borrow_mut().remove(&key);
    state.hover.borrow_mut().remove(&key);
}

/// RUST-133:索引缺口聚合报告(health `indexGaps` 键与 `$/kode/indexGaps`
/// 无 uri 形态同源)。三族:unindexed(暖扫计划的未完成量;暖扫之外无全量
/// 计划账,known/missing 诚实 null 不虚构 0)/ partial(解析失败负缓存,
/// count + 有界样本)/ stale(刷新在途:调度队列 + 风暴缓冲)。
fn index_gaps_report(state: &ServerState) -> serde_json::Value {
    let negatives = state.hover.borrow().index.negative_entries();
    const SAMPLE_MAX: usize = 8;
    let samples: Vec<serde_json::Value> = negatives
        .iter()
        .take(SAMPLE_MAX)
        .map(|(key, reason)| serde_json::json!({ "uri": key.uri.to_string(), "reason": reason }))
        .collect();
    let warm = state.warm.snapshot();
    let ingest = state.index.snapshot();
    let (known, missing) = match warm.total {
        Some(total) => (
            serde_json::Value::from(total),
            serde_json::Value::from(total.saturating_sub(warm.done).saturating_sub(warm.failed)),
        ),
        None => (serde_json::Value::Null, serde_json::Value::Null),
    };
    serde_json::json!({
        "unindexed": { "known": known, "indexed": warm.done, "missing": missing },
        "partial": { "count": negatives.len(), "samples": samples },
        "stale": { "queued": ingest.queued, "stormBuffered": ingest.storm_buffered },
    })
}

/// RUST-133:$/kode/indexGaps——索引缺口报告与按需补齐。无 uri = 聚合报告;
/// 带 uri = per-URI 裁定 {uri, tracked, parseError, pendingRefresh, gap,
/// filled}:gap 四态 unindexed(索引不知晓)/ partial(负缓存,解析失败)/
/// stale(刷新在途)/ none;裁定序 stale → unindexed → partial(在途刷新
/// 会改写驻留真相,先报;真缺口才轮到 fill);fill=true 且 unindexed 时
/// request_close 按需补齐(执行时刻真相重放:盘上有合法文件即回读入库)。
fn handle_index_gaps(state: &mut ServerState, request: Request) -> Response {
    let params: serde_json::Value = request.params.clone().unwrap_or_default();
    let Some(uri) = params.get("uri").and_then(|v| v.as_str()) else {
        return Response::success(request.id, index_gaps_report(state));
    };
    let fill = params
        .get("fill")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let Ok(parsed) = CanonicalUri::parse(uri) else {
        return Response::success(
            request.id,
            serde_json::json!({
                "uri": uri,
                "tracked": false,
                "parseError": serde_json::Value::Null,
                "pendingRefresh": false,
                "filled": false,
                "gap": "unindexed",
            }),
        );
    };
    let Some(key) = state.session.key_for(&parsed) else {
        return Response::success(
            request.id,
            serde_json::json!({
                "uri": uri,
                "tracked": false,
                "parseError": serde_json::Value::Null,
                "pendingRefresh": false,
                "filled": false,
                "gap": "unindexed",
            }),
        );
    };
    let known = state.hover.borrow().index.known_to_registry(&key);
    let parse_error = state
        .hover
        .borrow()
        .index
        .negative_entries()
        .into_iter()
        .find(|(k, _)| *k == key)
        .map(|(_, reason)| reason);
    let pending_refresh = state
        .index
        .has_pending(&crate::index_queue::identity_of(&key));
    // tracked = 索引以任何形态知晓(成功入库或已记解析失败);负缓存文件
    // 不进注册表前向表,只按 known 判会把 partial 误报成 unindexed。
    let tracked = known || parse_error.is_some();
    // 裁定序:stale 先于一切(在途刷新会改写驻留真相,消费者无须行动);
    // 真缺口 unindexed(fill 的适用面)先于 partial(缺口是解析失败,处置
    // 链是改文件重解析,非重放入库)。
    let gap = if pending_refresh {
        "stale"
    } else if !tracked {
        "unindexed"
    } else if parse_error.is_some() {
        "partial"
    } else {
        "none"
    };
    // fill 只对 unindexed 生效:partial/stale/none 都有自己的既有处置链
    // (负缓存重解析 / 刷新在途 / 无缺口),fill 不越权重放。
    let mut filled = false;
    if fill && gap == "unindexed" {
        let decision = state.index.request_close(&key);
        filled = matches!(decision, EnqueueDecision::Queued | EnqueueDecision::Merged);
    }
    Response::success(
        request.id,
        serde_json::json!({
            "uri": uri,
            "tracked": tracked,
            "parseError": parse_error,
            "pendingRefresh": pending_refresh,
            "filled": filled,
            "gap": gap,
        }),
    )
}

/// CORE-016 健康报告:status/pid/版本/uptime/文档摘要,按 uri 排序保证确定性。
fn health_report(state: &ServerState) -> serde_json::Value {
    let documents: Vec<DocumentSummary> = state
        .store
        .borrow()
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
        resources: read_core_resources(),
    };
    let mut value = serde_json::to_value(report).expect("serialize health report");
    // RUST-075-W:worker 池记账(执行器装配后存在;直连构造省略该键)。
    if let Some(stats_cell) = &state.pool_stats {
        if let Ok(stats) = stats_cell.lock() {
            value["pool"] = serde_json::to_value(*stats).expect("serialize pool stats");
        }
    }
    // RUST-074-W:暖门观测(首扫状态机 + Warming 期冷请求数)。暖门恒装配,
    // 该键恒在。
    let warm = state.warm.snapshot();
    value["warm"] = serde_json::json!({
        "state": warm.state,
        "coldWhileWarming": warm.cold_while_warming,
        "done": warm.done,
        "failed": warm.failed,
        "total": warm.total,
    });
    // RUST-078-W:驻留维护观测(idle aging + 内存压力主动回收),恒装配。
    let maintenance = state.warm.maintenance_snapshot();
    value["maintenance"] = serde_json::json!({
        "agedTerminal": maintenance.aged_terminal,
        "pressureReclaims": maintenance.pressure_reclaims,
        "lastRssBytes": maintenance.last_rss_bytes,
    });
    // RUST-070/071/073:索引刷新队列观测(CORE-005/006/008 生产面)。
    let ingest = state.index.snapshot();
    value["ingest"] = serde_json::json!({
        "queued": ingest.queued,
        "enqueued": ingest.enqueued,
        "merged": ingest.merged,
        "staleDropped": ingest.stale_dropped,
        "rejectedQueueFull": ingest.rejected_queue_full,
        "executed": ingest.executed,
        "purged": ingest.purged,
        "stormSeen": ingest.storm_seen,
        "stormMerged": ingest.storm_merged,
        "stormBuffered": ingest.storm_buffered,
        "stormDeadlineFlushes": ingest.storm_deadline_flushes,
        "stormForcedFlushes": ingest.storm_forced_flushes,
        // RUST-120-W:分类失效计数(差异化失效观测面)。
        "ingestIdentical": ingest.ingest_identical,
        "ingestBodyOnly": ingest.ingest_body_only,
        "ingestSignature": ingest.ingest_signature,
        "ingestRemoved": ingest.ingest_removed,
    });
    // RUST-125:解析驻留观测(冷热分层运行面:预算/驻留/驱逐三计数)。
    let pc = state.hover.borrow().index.parse_cache_stats();
    value["parseCache"] = serde_json::json!({
        "budgetBytes": pc.budget_bytes,
        "residentBytes": pc.resident_bytes,
        "evictions": pc.evictions,
        "valid": pc.valid,
        "negative": pc.negative,
    });
    // RUST-133:索引缺口观测(unindexed/partial/stale 三族聚合;与
    // $/kode/indexGaps 无 uri 形态同源)。
    value["indexGaps"] = index_gaps_report(state);
    value
}

/// RUST-026 Core 进程资源快照(Linux /proc;非 Linux/解析失败=None 诚实降级,
/// 绝不伪造零值)。disk read/write_bytes 来自 /proc/self/io,只计真实存储 IO
/// (不含页缓存命中)。
#[cfg(target_os = "linux")]
fn read_core_resources() -> Option<CoreResources> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let mut rss_kb: Option<u64> = None;
    let mut threads: Option<u32> = None;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            rss_kb = rest.split_whitespace().next()?.parse().ok();
        } else if let Some(rest) = line.strip_prefix("Threads:") {
            threads = rest.trim().parse().ok();
        }
    }
    let io = std::fs::read_to_string("/proc/self/io").ok()?;
    let mut disk_read_bytes: Option<u64> = None;
    let mut disk_write_bytes: Option<u64> = None;
    for line in io.lines() {
        if let Some(rest) = line.strip_prefix("read_bytes:") {
            disk_read_bytes = rest.trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix("write_bytes:") {
            disk_write_bytes = rest.trim().parse().ok();
        }
    }
    // /proc/self/stat:pid (comm) 后首 token=state(field 3);utime=field 14,
    // stime=field 15 → 去头后下标 11/12。CLK_TCK=100 为 Linux 标准假设。
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let after_comm = stat.rsplit_once(')').map(|(_, rest)| rest.trim())?;
    let stat_fields: Vec<&str> = after_comm.split_whitespace().collect();
    let cpu_ticks: u64 = stat_fields
        .get(11)
        .and_then(|utime| utime.parse::<u64>().ok())
        .zip(
            stat_fields
                .get(12)
                .and_then(|stime| stime.parse::<u64>().ok()),
        )
        .map(|(utime, stime)| utime + stime)?;
    Some(CoreResources {
        rss_bytes: rss_kb? * 1024,
        threads: threads?,
        disk_read_bytes: disk_read_bytes?,
        disk_write_bytes: disk_write_bytes?,
        cpu_time_ms: cpu_ticks * 10,
    })
}

#[cfg(not(target_os = "linux"))]
fn read_core_resources() -> Option<CoreResources> {
    None
}

/// RUST-078-W:进程 RSS 字节(暖门维护面压力采样;非 Linux/读失败 = None,
/// 绝不伪造零值)。
pub fn self_rss_bytes() -> Option<u64> {
    read_core_resources().map(|r| r.rss_bytes)
}

#[cfg(test)]
mod tests {
    // 唯一测试 linux-only(/proc 面);use 同门,Windows 夜构建不引 dead import。
    #[cfg(target_os = "linux")]
    use super::*;

    /// RUST-026:Linux 下资源快照来自 /proc,字段齐全且非零(绝不伪造零值)。
    #[test]
    #[cfg(target_os = "linux")]
    fn core_resources_reads_proc_fields() {
        let resources =
            read_core_resources().expect("linux 下 /proc/self/status 与 /proc/self/io 应可读");
        assert!(resources.rss_bytes > 0, "RSS 必须为正");
        assert!(resources.threads >= 1, "至少主线程");
        // cpu_time_ms=0 是合法读数:年轻进程 CPU 可能不足 1 tick(10ms),
        // 断在场不断数值(与磁盘 IO 计数器同口径)
        // /proc/self/io 计数器只计真实存储 IO 系统调用;mmap 载入的二进制
        // 不经 read(),年轻进程两者都可能为 0——只断字段已解析,不断数值
        // (观测语义诚实:0 是合法读数,不是缺数)
    }
}
