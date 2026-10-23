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
use kode_server::{cancel_target, handle_message_with_poll, Outgoing, ServerState};

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
fn dispatch_outcome(
    state: &mut ServerState,
    outcome: FrameOutcome,
    poll: &mut dyn FnMut() -> bool,
) {
    let outgoing: Vec<Outgoing> = match outcome {
        FrameOutcome::Message(value) => match serde_json::from_value(value.clone()) {
            Ok(message) => {
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

/// 处理解码结果序列;poll 闭包把 wait 期间新到的帧排入 `deferred`,
/// `$/cancelRequest` 即刻登记进取消表(长请求取消的唯一通道)。
fn process_outcomes(
    state: &mut ServerState,
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
                            saw_cancel = true;
                            continue;
                        }
                    }
                    deferred.push_back(next);
                }
            }
            saw_cancel
        };
        dispatch_outcome(state, outcome, &mut poll);
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
    let mut decoder = FrameDecoder::new();
    let rx = spawn_reader();
    // 长请求期间暂存的解码结果(wait 结束后回主循环处理)。
    let mut deferred: VecDeque<FrameOutcome> = VecDeque::new();
    let mut eof = false;

    loop {
        if let Some(outcome) = deferred.pop_front() {
            process_outcomes(&mut state, vec![outcome], &rx, &mut decoder, &mut deferred);
        } else if !eof {
            match rx.recv_timeout(PUMP_TICK) {
                Ok(Some(chunk)) => {
                    let outcomes = decoder.push(&chunk);
                    process_outcomes(&mut state, outcomes, &rx, &mut decoder, &mut deferred);
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => eof = true,
                Err(RecvTimeoutError::Timeout) => {}
            }
        } else if deferred.is_empty() {
            break;
        }
        if state.exit_requested {
            log("exit requested");
            break;
        }
    }

    // CORE-015:未走 shutdown 的退出视为异常,stderr 留痕;TS client 据此重启。
    if !state.shutdown_requested {
        log("exited without shutdown (crash-like; client should restart)");
    } else {
        log("clean shutdown");
    }
}
