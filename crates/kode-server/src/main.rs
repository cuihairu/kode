//! kode-server entry: stdio LSP pump (book §4 CORE-001).
//!
//! Transport framing (`Content-Length` header + JSON body, short reads, split
//! packets, invalid frames) is delegated to the `lsp-server` crate's `Connection`:
//! it owns the reader/writer threads and the codec, so this crate only maps
//! messages and pumps its own scheduling — no hand-rolled byte framing anywhere.
//!
//! Architecture: the `Connection` receiver yields fully parsed messages; the main
//! thread dispatches / pumps new input during long requests (`$/kode/wait`) and
//! registers cancel notifications, so cancellation can cross the single-threaded
//! dispatch (CORE-007 minimal implementation). Logs go to stderr, never polluting
//! the protocol channel. Exit semantics (CORE-015): shutdown+exit is a normal
//! exit; EOF / exit without shutdown is treated as a crash and the TS client is
//! responsible for restarting. (A malformed frame now fails the reader instead of
//! resync-hunting: the library reports the error, the reader thread ends and the
//! channel disconnects, the process exits crash-faced and the client restarts —
//! one bad frame surfaces immediately instead of wedging the stream silently.)

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use kode_protocol::{error_codes, IncomingMessage, Notification, Request, RequestId, Response};
use kode_server::executor::{
    assembly_pool_budget, execution_lane, rpc_job_kind, rpc_response_for, ExecutionLane, Job,
    JobOutcome, JobStatus, PoolExecutor,
};
use kode_server::{handle_message_with_poll, rpc::span_id_of, Outgoing, ServerState};
use lsp_server::{Connection, Message};

const PUMP_TICK: Duration = Duration::from_millis(50);

fn log(message: &str) {
    eprintln!("[kode-server] {message}");
}

/// Convert the library request id (number or string, private inner) into the
/// protocol's own `RequestId`. The round trip through JSON keeps both forms
/// faithfully — CORE-003 forbids normalizing them.
fn protocol_request_id(id: &lsp_server::RequestId) -> Option<RequestId> {
    serde_json::to_value(id)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// Protocol request id → library id (the reverse field mapping; both forms
/// survive the JSON round trip).
fn library_request_id(id: &RequestId) -> Option<lsp_server::RequestId> {
    serde_json::to_value(id)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// Library request id → log string (same account as `RequestId` Display).
fn request_id_log(id: &lsp_server::RequestId) -> String {
    match protocol_request_id(id) {
        Some(request_id) => request_id.to_string(),
        None => id.to_string(),
    }
}

/// Inbound library message → protocol DTO. The library already parsed the
/// JSON-RPC envelope, so this is a pure field mapping; the DTO shapes stay owned
/// by kode-protocol. Client responses (kode-server never issues reverse requests)
/// are logged and dropped.
fn incoming_message(message: Message) -> Option<IncomingMessage> {
    match message {
        Message::Request(request) => {
            let lsp_server::Request { id, method, params } = request;
            Some(IncomingMessage::Request(Request {
                jsonrpc: "2.0".to_string(),
                id: protocol_request_id(&id).unwrap_or(RequestId::Number(0)),
                method,
                params: (params != serde_json::Value::Null).then_some(params),
            }))
        }
        Message::Notification(notification) => {
            let lsp_server::Notification { method, params } = notification;
            Some(IncomingMessage::Notification(Notification {
                jsonrpc: "2.0".to_string(),
                method,
                params: (params != serde_json::Value::Null).then_some(params),
            }))
        }
        Message::Response(response) => {
            log(&format!(
                "dropping unexpected response for id {}",
                request_id_log(&response.id)
            ));
            None
        }
    }
}

/// Protocol error code → library code (both are JSON-RPC numbers; the library
/// types it as i32).
fn error_code(code: i64) -> i32 {
    i32::try_from(code).unwrap_or(i32::MIN)
}

/// Protocol DTO → library message, for writing to the wire through the connection.
fn outgoing_message(outgoing: &Outgoing) -> Option<Message> {
    match outgoing {
        Outgoing::Response(response) => {
            let Some(id) = response.id.as_ref().and_then(library_request_id) else {
                // The id-less `Response` form existed only for framing-level parse
                // errors; JSON-RPC requires an id, so an id-less response cannot be
                // framed (those errors now fail fast inside the library, before a
                // message is ever built).
                log("response without id dropped");
                return None;
            };
            let result = response.result.clone().unwrap_or(serde_json::Value::Null);
            Some(Message::Response(lsp_server::Response {
                id,
                response_result: match response.error.as_ref() {
                    Some(err) => Err(lsp_server::ResponseError {
                        code: error_code(err.code),
                        message: err.message.clone(),
                        data: err.data.clone(),
                    }),
                    None => Ok(result),
                },
            }))
        }
        Outgoing::Notification(notification) => {
            Some(Message::Notification(lsp_server::Notification {
                method: notification.method.clone(),
                params: notification
                    .params
                    .clone()
                    .unwrap_or(serde_json::Value::Null),
            }))
        }
    }
}

/// Write outgoing messages to stdout through the library's writer thread.
fn write_outgoing(sender: &Sender<Message>, outgoing: &[Outgoing]) {
    for message in outgoing {
        match outgoing_message(message) {
            Some(wire) => {
                if let Err(err) = sender.send(wire) {
                    log(&format!("send message error: {err}"));
                    return;
                }
            }
            None => continue,
        }
    }
}

/// RUST-142: diagnostics pipeline flush (dirty documents → four-layer core →
/// publishDiagnostics notification). Invoked at the same moment as the index
/// flush: an empty dirty set passes through at zero cost (early exit inside
/// flush_diagnostics_pipeline); any output is written to stdout immediately
/// (notification frames and response frames share the chain, never interleaved
/// within a frame).
/// RESP-001: the same slicing double bound as the index (count + wall clock) —
/// lint is not preemptible, draining the full dirty set at once would block the
/// main loop for seconds and queue health/hover turns; the remainder beyond the
/// bound returns to the dirty set and is caught up on later idle ticks.
fn flush_diagnostics(state: &mut ServerState, sender: &Sender<Message>) {
    let deadline = std::time::Instant::now()
        + Duration::from_millis(kode_server::server::DIAGNOSTIC_FLUSH_BUDGET_MS);
    let out = kode_server::server::flush_diagnostics_pipeline(state, deadline);
    if !out.is_empty() {
        write_outgoing(sender, &out);
    }
}

/// Dispatch a single decoded message; long requests pump newly arrived input
/// through `poll` (the cancellation channel).
/// RUST-075-W: the `$/kode/rpc` pure-handler face is handed to the worker pool
/// by execution ownership (before initialization it still runs inline, keeping
/// the SERVER_NOT_INITIALIZED gate); `$/cancelRequest` uniformly registers into
/// the cancel table and notifies the executor (queued removal / in-flight
/// discard), without going through a handler.
fn dispatch_outcome(
    state: &mut ServerState,
    executor: &PoolExecutor,
    sender: &Sender<Message>,
    message: IncomingMessage,
    poll: &mut dyn FnMut() -> bool,
) {
    let outgoing: Vec<Outgoing> = match message {
        IncomingMessage::Request(request) => {
            if state.initialized {
                if let ExecutionLane::Pool(lane) =
                    execution_lane(&request.method, request.params.as_ref())
                {
                    // lane assigned to the pool ⇒ the inner method must be a
                    // string (same source as the classification);
                    // the worker submits the inner method/params (only the
                    // handler is in the snapshot).
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
                    // RUST-068-W: envelope-level span passed through into the job
                    // (cross-task tracking).
                    let span = span_id_of(request.params.as_ref()).map(str::to_string);
                    // CORE-003: request_id threading — the pool path shares the
                    // same log discipline.
                    log(&format!(
                        "request {} dispatched (pool: {inner_method} span={})",
                        request.id,
                        span.as_deref().unwrap_or("-")
                    ));
                    // RUST-072: pre-cancellation (cancel notification arrives
                    // before the request, LSP allows it) — the job does not enter
                    // the pool, -32800 immediately, no pool capacity consumed.
                    if state.cancels.consume_early(&request.id) {
                        return write_outgoing(
                            sender,
                            &[Outgoing::Response(Response::error(
                                Some(request.id),
                                error_codes::REQUEST_CANCELLED,
                                "request cancelled via $/cancelRequest",
                            ))],
                        );
                    }
                    // RUST-074-W: warm-gate observation — real RPCs dispatched
                    // during the unfinished first scan (Warming) are counted as
                    // cold requests; "requests do not wait for the first scan" is
                    // honored by the pool's interactive priority (RUST-075-W).
                    // The scheduler cold_request enqueue form will be enabled
                    // when the parse-cache consumer wiring lands
                    // (RUST-070/071/073); no fabricated enqueue here.
                    state.warm.note_cold_request();
                    // RUST-078-W: the pool dispatch point is the maintenance
                    // point (residency aging + pressure reclamation advance with
                    // production traffic; health's read-only snapshot does not
                    // trigger maintenance).
                    state.warm.maintain(
                        kode_server::warm_gate::unix_now_ms(),
                        kode_server::server::self_rss_bytes(),
                    );
                    // RUST-076-W: LaneGate categories share one source with the
                    // pool's lane classification (rpc_lane_class is the single
                    // source; worker admission applies the IO/CPU lane hard caps
                    // by kind, the interactive face always takes the reserved slot).
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
            // CORE-003: request_id threading — request/response id reconciliation
            // log (stderr).
            log(&format!("request {} dispatched", request.id));
            handle_message_with_poll(state, IncomingMessage::Request(request), poll)
        }
        IncomingMessage::Notification(notification) => {
            if notification.method == "$/cancelRequest" {
                if let Some(id) = notification
                    .params
                    .as_ref()
                    .and_then(|p| p.get("id"))
                    .and_then(|id| serde_json::from_value::<RequestId>(id.clone()).ok())
                {
                    state.cancels.request_cancel(&id);
                    executor.cancel(&id);
                }
                return;
            }
            handle_message_with_poll(state, IncomingMessage::Notification(notification), poll)
        }
    };
    write_outgoing(sender, &outgoing);
}

/// Pool response-drainer thread: writes the response as soon as a worker
/// finishes, without waiting for a main-loop tick (while heavy jobs are in
/// flight, health/light requests return microseconds earlier; after EOF/exit,
/// in-flight job responses still land on disk, on par with the inline path).
/// Out-of-order responses are reconciled by id per LSP (same discipline as the
/// TS client's pending Map). Each frame is written under an independent lock
/// with the main thread, never interleaved within a frame.
fn spawn_pool_drainer(
    pool_rx: std::sync::mpsc::Receiver<JobOutcome>,
    sender: Sender<Message>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("kode-pool-drain".to_string())
        .spawn(move || {
            while let Ok(outcome) = pool_rx.recv() {
                // RUST-068-W: response-side tracing (span shares a source with Job;
                // the status name is the terminal face).
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
                write_outgoing(&sender, &[Outgoing::Response(response)]);
            }
        })
        .expect("spawn pool drainer thread")
}

/// Process a decoded message sequence; the poll closure queues messages arriving
/// during a wait into `deferred`, and `$/cancelRequest` is immediately
/// registered into the cancel table and notified to the executor (the only
/// channel for long-request cancellation; pool-path in-flight jobs get their
/// discard marker at the same moment).
fn process_outcomes(
    state: &mut ServerState,
    executor: &PoolExecutor,
    sender: &Sender<Message>,
    messages: Vec<Message>,
    receiver: &Receiver<Message>,
    deferred: &mut VecDeque<Message>,
) {
    let cancels = Arc::clone(&state.cancels);
    for message in messages {
        let mut poll = || -> bool {
            let mut saw_cancel = false;
            while let Ok(next) = receiver.try_recv() {
                if let Message::Notification(ref notification) = next {
                    if notification.method == "$/cancelRequest" {
                        if let Some(id) = notification
                            .params
                            .get("id")
                            .and_then(|id| serde_json::from_value::<RequestId>(id.clone()).ok())
                        {
                            cancels.request_cancel(&id);
                            executor.cancel(&id);
                            saw_cancel = true;
                            continue;
                        }
                    }
                }
                deferred.push_back(next);
            }
            saw_cancel
        };
        let Some(incoming) = incoming_message(message) else {
            continue;
        };
        dispatch_outcome(state, executor, sender, incoming, &mut poll);
    }
}

fn main() {
    // --version: for binary-identity checks during packaging/handshaking.
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
    // RUST-075-W: worker executor assembly (budget = available cores; the
    // interactive reserve / background hard caps are held by WorkerPoolGate).
    // The snapshot shares a source with the registry; the health face shares the
    // accounting cell.
    // KODE-RESP-005: assembly goes through assembly_pool_budget with a floor of
    // 2 — on single-core/single-quota machines, from_total(1) leaves the
    // background permanently unadmitted and the draining join hangs.
    let snapshot = state.rpc.snapshot();
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let (executor, pool_rx) = PoolExecutor::spawn(snapshot, assembly_pool_budget(workers));
    state.pool_stats = Some(executor.stats_cell());
    // The `Connection` reader thread ends when stdin closes (EOF) or when a
    // malformed frame is reported; either way the channel disconnects and the
    // main loop's next receive observes it as EOF.
    let (connection, io_threads) = Connection::stdio();
    // Destructure: dropping the bundled `Connection` at the end of main would
    // keep a sender alive and hang the library's writer thread in join().
    let lsp_server::Connection { sender, receiver } = connection;
    // Pool responses are pumped out by a dedicated thread (no main-loop tick
    // consumed; worker finishes → response lands in microseconds).
    let drainer = spawn_pool_drainer(pool_rx, sender.clone());
    // Decoded messages parked during a long request (returned to the main loop
    // once the wait ends).
    let mut deferred: VecDeque<Message> = VecDeque::new();
    let mut eof = false;

    loop {
        if let Some(message) = deferred.pop_front() {
            process_outcomes(
                &mut state,
                &executor,
                &sender,
                vec![message],
                &receiver,
                &mut deferred,
            );
        } else if !eof {
            match receiver.recv_timeout(PUMP_TICK) {
                Ok(message) => {
                    process_outcomes(
                        &mut state,
                        &executor,
                        &sender,
                        vec![message],
                        &receiver,
                        &mut deferred,
                    );
                    // The frame path does not run ingest (verified during RESP-001
                    // acceptance): a slice's single-job parse overrun is not
                    // preemptible, so under a continuous didOpen flood later frames get
                    // queued slice by slice (measured 3.2s with no response at
                    // 30×200KB). Between frames, only the storm-window expiry handover
                    // happens (RUST-082 max latency, pure accounting); ingest runs on
                    // idle ticks with large slices + request draining (freshen prioritizes
                    // the self file) — interactive frames never pay for background
                    // parsing, and the flood is caught up during quiet periods (CORE-006
                    // no permanent deferral: idle slices always advance).
                    // RUST-142: the frame path does not run the diagnostics flush
                    // (verified during RESP-001 acceptance: a slice's single-job lint
                    // overrun is not preemptible — under a continuous didOpen flood
                    // later frames get queued slice by slice); the diagnostics flush
                    // runs on idle ticks (caught up during quiet periods, interactive
                    // frames never pay for background lint, same discipline as ingest).
                    state.index.flush_due(std::time::Instant::now());
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    // Idle tick: storm-window expiry handover (RUST-082) + large-slice
                    // catch-up (CORE-006: background work must not be deferred forever;
                    // DEPENDENCY_UPDATE priority is always interactive-level, cooling
                    // does not apply). RESP-001: also layers the wall-clock bound.
                    state.index.flush_due(std::time::Instant::now());
                    flush_diagnostics(&mut state, &sender);
                    state.index.pump_budgeted_until(
                        64,
                        std::time::Instant::now()
                            + std::time::Duration::from_millis(
                                kode_server::index_queue::IDLE_SLICE_BUDGET_MS,
                            ),
                    );
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    // The library's reader ended: stdin closed, or it reported a
                    // malformed frame and stopped (the diagnostic lands on stderr
                    // from the reader thread). Either way the stream is over.
                    log("stdin EOF (reader disconnected)");
                    eof = true;
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
    // drop → shutdown: workers drain their accepted queues and exit; once all
    // senders are gone the response thread sees EOF and exits by itself (join
    // closes it out, in-flight responses are never lost).
    drop(executor);
    let _ = drainer.join();

    // CORE-015: an exit without shutdown is treated as abnormal, traced to
    // stderr; the TS client restarts based on it.
    if !state.shutdown_requested {
        log("exited without shutdown (crash-like; client should restart)");
    } else {
        log("clean shutdown");
    }
    // Join the library's IO threads last: the writer drains any messages still
    // in the queue before exiting, then the reader (already at EOF / disconnected).
    // The sender is dropped first so the writer's channel closes.
    drop(sender);
    if let Err(err) = io_threads.join() {
        log(&format!("io threads error: {err}"));
    }
}

// ---- unit tests ------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use kode_protocol::ServerNotification;
    use kode_scheduler::PoolBudget;

    /// Minimal assembly: state + a two-worker pool (the dispatch arm only needs
    /// an executor to hand jobs to).
    fn fixture() -> (ServerState, PoolExecutor) {
        let mut state = ServerState::new();
        state.initialized = true;
        let (executor, _rx) = PoolExecutor::spawn(state.rpc.snapshot(), PoolBudget::from_total(2));
        (state, executor)
    }

    /// The library request id ↔ protocol RequestId round trip: number and string
    /// forms survive (CORE-003); the mapping is total over both shapes.
    #[test]
    fn request_id_round_trip_faces() {
        let number: lsp_server::RequestId = serde_json::from_value(serde_json::json!(7)).unwrap();
        assert_eq!(protocol_request_id(&number), Some(RequestId::Number(7)));
        let text: lsp_server::RequestId = serde_json::from_value(serde_json::json!("abc")).unwrap();
        assert_eq!(
            protocol_request_id(&text),
            Some(RequestId::String("abc".to_string()))
        );
    }

    /// `$/cancelRequest` registers into the cancel table without a handler and
    /// emits no response; a later pool-lane request for that id sees the early
    /// cancellation and answers -32800 immediately (RUST-072).
    #[test]
    fn cancel_notification_registers_and_pre_cancel_replies() {
        let (mut state, executor) = fixture();
        let (client, server) = lsp_server::Connection::memory();
        let mut never = || false;
        let cancel = Message::Notification(lsp_server::Notification {
            method: "$/cancelRequest".to_string(),
            params: serde_json::json!({ "id": 5 }),
        });
        let mut deferred = VecDeque::new();
        // `client.sender` injects the inbound frame; `server.receiver` is the
        // channel the poll closure drains during long requests.
        client.sender.send(cancel).expect("inject cancel");
        let incoming = server
            .receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("cancel delivered");
        process_outcomes(
            &mut state,
            &executor,
            &server.sender,
            vec![incoming],
            &server.receiver,
            &mut deferred,
        );

        let request = IncomingMessage::Request(Request {
            jsonrpc: "2.0".to_string(),
            id: RequestId::Number(5),
            method: "$/kode/rpc".to_string(),
            params: Some(serde_json::json!({ "method": "$/kode/echo" })),
        });
        dispatch_outcome(&mut state, &executor, &server.sender, request, &mut never);
        // The client-facing response is observed from the client's own channel
        // (written by the memory connection's writer thread).
        let response = client
            .receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("cancel response");
        drop(executor);
        match response {
            Message::Response(response) => match response.response_result {
                Err(err) => assert_eq!(err.code, error_code(error_codes::REQUEST_CANCELLED)),
                Ok(result) => panic!("expected cancellation, got {result}"),
            },
            other => panic!("expected a response, got {other:?}"),
        }
    }

    /// The Response/Notification two-arm wire mapping through a memory
    /// connection: the client side observes the exact JSON-RPC shapes the TS
    /// client's pending Map reconciles by id.
    #[test]
    fn write_outgoing_both_variants_execute() {
        let (client, server) = lsp_server::Connection::memory();
        write_outgoing(
            &server.sender,
            &[
                Outgoing::Response(Response::error(
                    Some(RequestId::Number(1)),
                    error_codes::INVALID_REQUEST,
                    "unit probe",
                )),
                Outgoing::Notification(ServerNotification::new("$/unitProbe", None)),
            ],
        );
        match client
            .receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("response frame")
        {
            Message::Response(response) => match response.response_result {
                Err(err) => {
                    assert_eq!(err.code, error_code(error_codes::INVALID_REQUEST));
                    assert_eq!(err.message, "unit probe");
                    assert_eq!(err.data, None);
                }
                Ok(result) => panic!("expected an error result, got {result}"),
            },
            other => panic!("expected a response, got {other:?}"),
        }
        match client
            .receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("notification frame")
        {
            Message::Notification(notification) => {
                assert_eq!(notification.method, "$/unitProbe");
            }
            other => panic!("expected a notification, got {other:?}"),
        }
    }
}
