//! kode-server 入口:stdio LSP 泵(书 §4 CORE-001)。
//!
//! 架构:reader 线程阻塞读 stdin → channel;主线程解帧/分派/写 stdout。
//! 长请求(`$/kode/wait`)睡眠间隙经 poll 泵入新帧并登记取消通知,取消因此
//! 能穿过单线程分派(CORE-007 最小实现)。日志走 stderr,不污染协议通道。
//! 退出语义(CORE-015):shutdown+exit 正常退出;EOF/未 shutdown 退出按
//! 崩溃处理,由 TS client 负责重启。

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use kode_protocol::{
    encode_frame, error_codes, FrameDecoder, FrameOutcome, IncomingMessage, RequestId, Response,
};
use kode_server::executor::{
    assembly_pool_budget, execution_lane, rpc_job_kind, rpc_response_for, ExecutionLane, Job,
    JobOutcome, JobStatus, PoolExecutor,
};
use kode_server::{cancel_target, handle_message_with_poll, rpc::span_id_of, Outgoing, ServerState};

const READ_CHUNK_BYTES: usize = 8192;
/// 主循环空闲轮询间隔:退出/取消的最大感知延迟上界。
const PUMP_TICK: Duration = Duration::from_millis(50);

fn log(message: &str) {
    eprintln!("[kode-server] {message}");
}

/// reader 线程投递的字节块;`None` = stdin EOF/读错误。
type Chunk = Option<Vec<u8>>;

fn spawn_reader() -> Receiver<Chunk> {
    let (tx, rx) = mpsc::channel::<Chunk>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut chunk = [0u8; READ_CHUNK_BYTES];
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) => {
                    log("stdin EOF");
                    break;
                }
                Ok(n) => {
                    if tx.send(Some(chunk[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    log(&format!("stdin read error: {err}"));
                    break;
                }
            }
        }
        let _ = tx.send(None);
    });
    rx
}

/// 从消息里取 id(CORE-003 日志对账用;通知无 id)。
fn request_id(message: &IncomingMessage) -> Option<RequestId> {
    match message {
        IncomingMessage::Request(request) => Some(request.id.clone()),
        IncomingMessage::Notification(_) => None,
    }
}

/// id 不可知(消息形状都非法)时尽量回捞 id,响应能对上账。
fn recover_id(value: &serde_json::Value) -> Option<RequestId> {
    value
        .get("id")
        .and_then(|id| serde_json::from_value(id.clone()).ok())
}

/// RUST-142:诊断管线 flush(脏文档 → 四层核 → publishDiagnostics 通知)。
/// 与索引 flush 同刻调起:空脏集零开销直通(flush_diagnostics_pipeline
/// 内早退);有产出即写 stdout(通知帧与响应帧同链,帧内不交错)。
/// RESP-001:同索引切片双界(条数+墙钟)——lint 不可抢占,一次排空全量
/// 脏集会阻塞主循环数秒,health/hover 回合被排队;界外余量回脏集,
/// 后续空闲 tick 追平。
fn flush_diagnostics(state: &mut ServerState) {
    let deadline = std::time::Instant::now()
        + Duration::from_millis(kode_server::server::DIAGNOSTIC_FLUSH_BUDGET_MS);
    let out = kode_server::server::flush_diagnostics_pipeline(state, deadline);
    if !out.is_empty() {
        write_outgoing(&out);
    }
}

/// 写出站消息到 stdout。
fn write_outgoing(outgoing: &[Outgoing]) {
    let mut stdout = std::io::stdout().lock();
    for message in outgoing {
        let body = match message {
            Outgoing::Response(response) => {
                serde_json::to_value(response).expect("serialize response")
            }
            Outgoing::Notification(notification) => {
                serde_json::to_value(notification).expect("serialize notification")
            }
        };
        let frame = match encode_frame(&body) {
            Ok(frame) => frame,
            Err(err) => {
                log(&format!("encode frame error: {err}"));
                continue;
            }
        };
        if let Err(err) = stdout.write_all(&frame).and_then(|()| stdout.flush()) {
            log(&format!("stdout write error: {err}"));
        }
    }
}

/// 分派单个解码结果;长请求经 `poll` 泵入新到输入(取消通道)。
/// RUST-075-W:`$/kode/rpc` 纯 handler 面按执行归属交 worker 池(已初始化
/// 前仍走内联,保 SERVER_NOT_INITIALIZED 闸);`$/cancelRequest` 统一登记
/// 取消表并通知执行器(排队摘除/在途丢弃),不经 handler。
fn dispatch_outcome(
    state: &mut ServerState,
    executor: &PoolExecutor,
    outcome: FrameOutcome,
    poll: &mut dyn FnMut() -> bool,
) {
    let outgoing: Vec<Outgoing> = match outcome {
        FrameOutcome::Message(value) => match serde_json::from_value(value.clone()) {
            Ok(message) => {
                if let IncomingMessage::Notification(ref notification) = message {
                    if notification.method == "$/cancelRequest" {
                        if let Some(id) = cancel_target(&value) {
                            state.cancels.request_cancel(&id);
                            executor.cancel(&id);
                        }
                        return;
                    }
                }
                if let IncomingMessage::Request(ref request) = message {
                    if state.initialized {
                        if let ExecutionLane::Pool(lane) =
                            execution_lane(&request.method, request.params.as_ref())
                        {
                            // lane 归池 ⇒ 内层 method 必为字符串(与分类同源);
                            // worker 提交内层 method/params(handler 才在快照里)。
                            let inner_method = request
                                .params
                                .as_ref()
                                .and_then(|p| p.get("method"))
                                .and_then(|m| m.as_str())
                                .expect("pool lane implies inner method string")
                                .to_string();
                            let inner_params = request
                                .params
                                .as_ref()
                                .and_then(|p| p.get("params"))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            // RUST-068-W:信封级 span 透传进 job(跨任务追踪)。
                            let span =
                                span_id_of(request.params.as_ref()).map(str::to_string);
                            // CORE-003:request_id 贯穿——池路径同日志口径。
                            log(&format!(
                                "request {} dispatched (pool: {inner_method} span={})",
                                request.id,
                                span.as_deref().unwrap_or("-")
                            ));
                            // RUST-072:预取消(取消通知先于请求,LSP 允许)——
                            // 作业不入池,即刻 -32800,不占池容量。
                            if state.cancels.consume_early(&request.id) {
                                return write_outgoing(&[Outgoing::Response(Response::error(
                                    Some(request.id.clone()),
                                    error_codes::REQUEST_CANCELLED,
                                    "request cancelled via $/cancelRequest",
                                ))]);
                            }
                            // RUST-074-W:暖门观测——首扫未完成(Warming)期
                            // 派发的真实 RPC 记入冷请求计数;「请求不等首扫」
                            // 由池交互优先级兑现(RUST-075-W)。scheduler
                            // cold_request 入队形态随解析缓存消费者接线启用
                            // (RUST-070/071/073),此处不伪造入队。
                            state.warm.note_cold_request();
                            // RUST-078-W:池分派点即维护点(驻留老化+压力回收
                            // 随生产流量推进;health 只读快照不触发维护)。
                            state.warm.maintain(
                                kode_server::warm_gate::unix_now_ms(),
                                kode_server::server::self_rss_bytes(),
                            );
                            // RUST-076-W:LaneGate 类别与池泳道同源分类
                            // (rpc_lane_class 单一源;worker 准入按 kind
                            // 过 IO/CPU 泳道硬顶,交互面恒走预留位)。
                            executor.submit(Job {
                                id: request.id.clone(),
                                method: inner_method.clone(),
                                params: inner_params,
                                lane,
                                kind: rpc_job_kind(&inner_method),
                                span,
                            });
                            return;
                        }
                    }
                }
                // CORE-003:request_id 贯穿——请求与响应 id 对账日志(stderr)。
                if let Some(id) = request_id(&message) {
                    log(&format!("request {id} dispatched"));
                }
                handle_message_with_poll(state, message, poll)
            }
            Err(_) => vec![Outgoing::Response(Response::error(
                recover_id(&value),
                error_codes::INVALID_REQUEST,
                "message is not a valid JSON-RPC request or notification",
            ))],
        },
        FrameOutcome::InvalidHeader(err) => {
            log(&format!("illegal frame header: {err}"));
            vec![Outgoing::Response(Response::error(
                None,
                error_codes::PARSE_ERROR,
                format!("illegal frame: {err}"),
            ))]
        }
        FrameOutcome::InvalidBody => vec![Outgoing::Response(Response::error(
            None,
            error_codes::PARSE_ERROR,
            "frame body is not valid JSON",
        ))],
    };
    write_outgoing(&outgoing);
}

/// 池回包线程:worker 一完成即写出响应,不等主循环 tick(重任务在飞时
/// 健康/轻请求微秒级先回;EOF/exit 后在途 job 回包照常落盘,与内联路径
/// 回包平价)。乱序回包,LSP 按 id 对账(TS client pending Map 同口径)。
/// 与主线程各帧独立加锁写出,帧内不交错。
fn spawn_pool_drainer(pool_rx: Receiver<JobOutcome>) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("kode-pool-drain".to_string())
        .spawn(move || {
            while let Ok(outcome) = pool_rx.recv() {
                // RUST-068-W:回包侧留痕(span 与 Job 同源;状态名即终态面)。
                let status_name = match outcome.status {
                    JobStatus::Done(_) => "done",
                    JobStatus::Failed(_) => "failed",
                    JobStatus::Cancelled => "cancelled",
                };
                eprintln!(
                    "[kode-server] pool response {} {status_name} (span={})",
                    outcome.id,
                    outcome.span.as_deref().unwrap_or("-")
                );
                let response = rpc_response_for(outcome.id, outcome.status);
                write_outgoing(&[Outgoing::Response(response)]);
            }
        })
        .expect("spawn pool drainer thread")
}

/// 处理解码结果序列;poll 闭包把 wait 期间新到的帧排入 `deferred`,
/// `$/cancelRequest` 即刻登记进取消表并通知执行器(长请求取消唯一通道;
/// 池路径在途 job 同刻丢弃标记)。
fn process_outcomes(
    state: &mut ServerState,
    executor: &PoolExecutor,
    outcomes: Vec<FrameOutcome>,
    rx: &Receiver<Chunk>,
    decoder: &mut FrameDecoder,
    deferred: &mut VecDeque<FrameOutcome>,
) {
    let cancels = Arc::clone(&state.cancels);
    for outcome in outcomes {
        let mut poll = || -> bool {
            let mut saw_cancel = false;
            while let Ok(Some(more)) = rx.try_recv() {
                for next in decoder.push(&more) {
                    if let FrameOutcome::Message(ref value) = next {
                        if let Some(id) = cancel_target(value) {
                            cancels.request_cancel(&id);
                            executor.cancel(&id);
                            saw_cancel = true;
                            continue;
                        }
                    }
                    deferred.push_back(next);
                }
            }
            saw_cancel
        };
        dispatch_outcome(state, executor, outcome, &mut poll);
    }
}

fn main() {
    // --version:打包/握手阶段校验二进制身份用。
    if std::env::args().any(|arg| arg == "--version") {
        println!("kode-server {}", kode_protocol::PROTOCOL_VERSION);
        return;
    }
    log(&format!(
        "starting pid={} version={} protocol={}",
        std::process::id(),
        env!("CARGO_PKG_VERSION"),
        kode_protocol::PROTOCOL_VERSION
    ));

    let mut state = ServerState::new();
    // RUST-075-W:worker 执行器装配(预算=可用核数;交互预留/后台硬顶由
    // WorkerPoolGate 持有)。快照与注册表同源;健康面共享记账 cell。
    // KODE-RESP-005:装配经 assembly_pool_budget 下限 2——单核/单配额机
    // from_total(1) 后台永不准入且 draining join 挂死。
    let snapshot = state.rpc.snapshot();
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let (executor, pool_rx) = PoolExecutor::spawn(snapshot, assembly_pool_budget(workers));
    state.pool_stats = Some(executor.stats_cell());
    // 池回包由专职线程泵出(不占主循环 tick;worker 完成 → 回包微秒级落盘)。
    let drainer = spawn_pool_drainer(pool_rx);
    let mut decoder = FrameDecoder::new();
    let rx = spawn_reader();
    // 长请求期间暂存的解码结果(wait 结束后回主循环处理)。
    let mut deferred: VecDeque<FrameOutcome> = VecDeque::new();
    let mut eof = false;

    loop {
        if let Some(outcome) = deferred.pop_front() {
            process_outcomes(&mut state, &executor, vec![outcome], &rx, &mut decoder, &mut deferred);
        } else if !eof {
            match rx.recv_timeout(PUMP_TICK) {
                Ok(Some(chunk)) => {
                    let outcomes = decoder.push(&chunk);
                    process_outcomes(&mut state, &executor, outcomes, &rx, &mut decoder, &mut deferred);
                    // 帧路径不跑 ingest(RESP-001 验收实测):切片单任务解析
                    // 超支不可抢占,连续 didOpen 洪水下后续帧被逐片排队
                    // (30×200KB 实测 3.2s 无响应)。帧间只做风暴窗到期移交
                    // (RUST-082 max latency,纯记账);ingest 走空闲 tick 大
                    // 切片 + 请求排水(freshen 自文件优先)——交互帧永不
                    // 为后台解析买单,洪水在静默期追平(CORE-006 不永久
                    // 推迟:空闲切片恒推进)。
                    // RUST-142:帧路径不跑诊断 flush(RESP-001 验收实测:
                    // 切片单任务 lint 超支不可抢占——连续 didOpen 洪水下
                    // 后续帧被逐片排队);诊断 flush 走空闲 tick(静默期
                    // 追平,交互帧永不为后台 lint 买单,同 ingest 口径)。
                    state.index.flush_due(std::time::Instant::now());
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => eof = true,
                Err(RecvTimeoutError::Timeout) => {
                    // 空闲 tick:风暴窗到期移交(RUST-082)+ 大切片追赶
                    // (CORE-006 后台不可永久推迟;DEPENDENCY_UPDATE 优先级
                    // 恒交互级,冷却不适用)。RESP-001:同样叠墙钟界。
                    state.index.flush_due(std::time::Instant::now());
                    flush_diagnostics(&mut state);
                    state.index.pump_budgeted_until(
                        64,
                        std::time::Instant::now()
                            + std::time::Duration::from_millis(
                                kode_server::index_queue::IDLE_SLICE_BUDGET_MS,
                            ),
                    );
                }
            }
        } else if deferred.is_empty() {
            break;
        }
        if state.exit_requested {
            log("exit requested");
            break;
        }
    }
    // drop → shutdown:worker 排空已受理队列退出;全部 sender 落后回包
    // 线程见 EOF 自己退出(join 收口,在途响应绝不丢)。
    drop(executor);
    let _ = drainer.join();

    // CORE-015:未走 shutdown 的退出视为异常,stderr 留痕;TS client 据此重启。
    if !state.shutdown_requested {
        log("exited without shutdown (crash-like; client should restart)");
    } else {
        log("clean shutdown");
    }
}

// ---- 单测 -----------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use kode_scheduler::PoolBudget;

    /// 最小装配:state + 两 worker 池(分派坏帧臂只需 error 响应可构造)。
    fn fixture() -> (ServerState, PoolExecutor) {
        let mut state = ServerState::new();
        state.initialized = true;
        let (executor, _rx) = PoolExecutor::spawn(state.rpc.snapshot(), PoolBudget::from_total(2));
        (state, executor)
    }

    #[test]
    fn recover_id_faces() {
        // 数字/字符串 id 回捞;缺 id/非标量形态 → None(响应账面不可知)。
        assert!(matches!(
            recover_id(&serde_json::json!({ "id": 7 })),
            Some(RequestId::Number(7))
        ));
        assert!(matches!(
            recover_id(&serde_json::json!({ "id": "abc" })),
            Some(RequestId::String(s)) if s == "abc"
        ));
        assert_eq!(recover_id(&serde_json::json!({ "method": "x" })), None);
        assert_eq!(
            recover_id(&serde_json::json!({ "id": { "nested": 1 } })),
            None
        );
    }

    #[test]
    fn dispatch_bad_frame_outcomes_error_responses() {
        // 三个帧级坏形臂:非对象消息体(serde 拒)/非法帧头/非法 body。
        // 可观边界=不 panic 且经 write_outgoing 落错误响应帧(stdout)。
        let (mut state, executor) = fixture();
        let mut never = || false;
        dispatch_outcome(
            &mut state,
            &executor,
            FrameOutcome::Message(serde_json::json!(3)),
            &mut never,
        );
        dispatch_outcome(
            &mut state,
            &executor,
            FrameOutcome::InvalidHeader("missing Content-Length".into()),
            &mut never,
        );
        dispatch_outcome(&mut state, &executor, FrameOutcome::InvalidBody, &mut never);
    }

    #[test]
    fn write_outgoing_both_variants_execute() {
        // Response/Notification 双臂序列化+编码+写盘链(stdout;encode 对
        // 合法消息恒成功,错误臂为防御面)。
        write_outgoing(&[
            Outgoing::Response(Response::error(
                Some(RequestId::Number(1)),
                error_codes::INVALID_REQUEST,
                "unit probe",
            )),
            Outgoing::Notification(kode_protocol::ServerNotification::new("$/unitProbe", None)),
        ]);
    }
}
