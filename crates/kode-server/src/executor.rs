//! RUST-075-W worker executor assembly: execution-ownership registration + a real worker pool.
//!
//! Shape: the `$/kode/rpc` registered-face handler is a pure function (`fn(Value) -> Result`) with
//! zero ServerState dependency (TS reads disk and passes text straight through, never touching mirror corpus) -- such requests run on
//! worker threads; the main thread's stdio pump keeps reading/responding, so while heavy work is in flight, health/light requests still
//! answer first. The admission invariants (interactive reservation / background hard cap / total conservation / release accounting) are all held by
//! the kode-scheduler `WorkerPoolGate`; this module only wires and does not set up a separate decision core.
//!
//! Cancellation (CORE-007 + RUST-072): a queued-not-yet-started job is removed immediately, answering -32800 (its capacity
//! was never taken); an in-flight job gets a drop marker registered + its request's cancellation token set -- the handler's cooperation
//! point (the kode-python cancel probe) polls the token and exits early, never producing partial results; every final state
//! (including the interrupted Err) releases capacity; settlement adjudicates Cancelled (-32800) from three sources:
//! the pre-pop registry / the in-flight drop registry / the handler's self-reported cancellation text (a job with no span takes the
//! handler text as the honest source). A drop is registered only when this pool really has the job (a queue-removal hit, or
//! the span was registered at submit) -- unknown ids / duplicates / late cancels never enter the table, and the table stays bounded.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};

use kode_protocol::{error_codes, RequestId, Response};
use kode_scheduler::lane::TaskLane;
use kode_scheduler::{LaneBudget, LaneGate, PoolBudget, WorkerPoolGate};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rpc::RegistrySnapshot;

/// Execution ownership: the top-level method arm -> the execution-location decision face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionLane {
    /// Main-thread inline: fast serving faces (hover/completion/definition/diagnostic/
    /// health/workspace/*) and the ordered-semantics faces (initialize/shutdown/exit/wait).
    Inline,
    /// Worker pool: the `$/kode/rpc` pure-handler face.
    Pool(PoolLane),
}

/// A lane within the pool: interactive (user semantic requests) or background (first scan / reports; production currently has no real background
/// caller; when RUST-074-W lands, register the corresponding inner method's lane here).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PoolLane {
    Interactive,
    Background,
}

/// RUST-076-W: the explicit registry of inner methods with truly blocking IO / external-process waits. Faces in the
/// table belong to `LaneGate::Io` (blocking disk reads / subprocess shell-outs); every other registered face is
/// `Cpu` (pure parsing). Ownership completeness is asserted in tests/executor_ownership.rs against
/// snapshot.methods() in full: an unregistered face defaults to Cpu (still runs), while a face registered
/// in the table that has since been deregistered turns red (guards against stale registrations).
const IO_TASK_METHODS: &[&str] = &[
    "$/kode/dbClone/export",
    "$/kode/dbClone/inspectArchive",
    "$/kode/dbClone/readArchiveRows",
    "$/kode/ruff/format",
    "$/kode/ruff/lint",
    "$/kode/workspace/scanAnchors",
];

/// Single classification source: the `$/kode/rpc` inner method -> (pool lane, LaneGate category).
/// Faces in the IO table -> Background+Io (slow IO never takes an interactive reservation seat); everything else -> Interactive
/// +Cpu. Beyond cpu_max/io_max, an interactive request is always admitted through WorkerPoolGate's interactive reservation
/// (LaneGate::Interactive can always enter); neither hard cap can block the interactive face.
pub fn rpc_lane_class(inner: &str) -> (PoolLane, TaskLane) {
    if IO_TASK_METHODS.contains(&inner) {
        (PoolLane::Background, TaskLane::Io)
    } else {
        (PoolLane::Interactive, TaskLane::Cpu)
    }
}

/// Pool-lane classification (IO-table faces belong to the background lane, sharing the pool with RUST-074-W's warm-gate first scan without taking interactive seats).
pub fn rpc_pool_lane(inner: &str) -> PoolLane {
    rpc_lane_class(inner).0
}

/// LaneGate admission-category classification (the second projection of the single classification source).
pub fn rpc_job_kind(inner: &str) -> TaskLane {
    rpc_lane_class(inner).1
}

/// RUST-076-W: worker count -> LaneGate budget. Structural constraint: io+cpu <= total-1
/// (always keeping >=1 worker for the interactive reservation; WorkerPoolGate's interactive quota
/// is the admission gate and the LaneGate budget is the worker-occupancy gate; the two layers stack). The library's
/// `LaneBudget::from_total` yields io_max=0 at N=2 (starving the IO faces on a 2-core CI),
/// so here we override: at >=2 cores io >= 1; with workers=1 both lanes are 0 (all given to interactive) --
/// since KODE-RESP-005 the production assembly goes through `assembly_pool_budget` with a floor of 2; this branch only
/// remains for direct construction (tests / safety net).
pub fn lane_budget_for_workers(workers: usize) -> LaneBudget {
    let remaining = workers.saturating_sub(1);
    let io_max = if remaining == 0 {
        0
    } else {
        (remaining / 2).max(1)
    };
    let cpu_max = remaining - io_max;
    LaneBudget {
        total: workers,
        io_max,
        cpu_max,
    }
}

/// KODE-RESP-005: the assembly-face budget (the sole production entry, used by main.rs).
///
/// On a single-core / single-CPU-quota machine (available_parallelism=1), `from_total(1)` yields
/// background_max=0 and io_max=0 -- background IO faces (dbClone/ruff/scanAnchors; the production background
/// queue is entirely Io-lane) would never be admitted and requests would never get results; under the draining semantics the
/// shutdown join would hang forever. The assembly floor is 2: 1 interactive worker + 1 IO-face worker.
/// Overselling one thread does not violate the intent of "never saturate all cores" -- background jobs block on subprocesses / disk reads,
/// which are not a CPU saturation source; and the dual hard caps background_max=1/io_max=1 still bound concurrency. With multiple
/// cores (>=2) the behavior matches from_total exactly; the floor only rescues degenerate budgets.
pub fn assembly_pool_budget(cores: usize) -> PoolBudget {
    PoolBudget::from_total(cores.max(2))
}

/// The execution-ownership decision at the main dispatch-loop entry. `$/kode/rpc` is pooled by inner method; an invalid params
/// shape (no inner method) -> Inline, letting the server take its original INVALID_PARAMS
/// error path (stance unchanged; the classifier never pre-empts the answer).
pub fn execution_lane(method: &str, params: Option<&Value>) -> ExecutionLane {
    if method == "$/kode/rpc" {
        return match params
            .and_then(|p| p.get("method"))
            .and_then(|m| m.as_str())
        {
            Some(inner) => ExecutionLane::Pool(rpc_pool_lane(inner)),
            None => ExecutionLane::Inline,
        };
    }
    ExecutionLane::Inline
}

/// Pool accounting snapshot (the health face's `$/kode/health` `pool` key; omitted when no executor is assembled).
/// RUST-076-W: `ioRunning`/`cpuRunning` = LaneGate lanes in flight (an admission/release
/// observation; interactive reservations are presented via WorkerPoolGate's interactive stance and never double-counted).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStats {
    pub workers: usize,
    pub interactive_running: usize,
    pub background_running: usize,
    pub io_running: usize,
    pub cpu_running: usize,
    pub jobs_done: u64,
    pub jobs_failed: u64,
    pub jobs_cancelled: u64,
}

/// One pending job (a pure handler call; workers share no state).
#[derive(Debug)]
pub struct Job {
    pub id: RequestId,
    pub method: String,
    pub params: Value,
    pub lane: PoolLane,
    /// RUST-076-W: the LaneGate admission category (truly blocking IO / external-process waits = Io; CPU parsing
    /// = Cpu). The production path classifies via `rpc_job_kind`; interactive-queue jobs are always admitted through
    /// the Interactive reservation (kind is bookkeeping only; the CPU/IO hard caps never block interactive).
    pub kind: TaskLane,
    /// RUST-068-W: cross-task tracing id (generated at the TS request entry, passed through at envelope level; defaults to None
    /// = a pure server-initiated call with no span). The log face prints only the span, never params (sanitized).
    pub span: Option<String>,
}

/// Execution final state: Done = a successful return value / Failed = a handler Err (mapped to -32602 or -32601) /
/// Cancelled = cancelled (queue removal or in-flight drop, mapped to -32800).
#[derive(Debug)]
pub enum JobStatus {
    Done(Value),
    Failed(String),
    Cancelled,
}

#[derive(Debug)]
pub struct JobOutcome {
    pub id: RequestId,
    pub lane: PoolLane,
    pub status: JobStatus,
    /// RUST-068-W: the reply-side log carries the same span (passed through from the same source as Job).
    pub span: Option<String>,
}

/// Final state -> LSP response mapping: the same stance as server.rs `handle_rpc` (an Err message
/// starting with "method not found" -> -32601, otherwise -> -32602; cancel -> -32800, consistent with
/// the `$/kode/wait` cancellation semantics). Kept in one place to guard against double-write drift.
pub fn rpc_response_for(id: RequestId, status: JobStatus) -> Response {
    match status {
        JobStatus::Done(value) => Response::success(id, value),
        JobStatus::Failed(msg) => {
            let code = if msg.starts_with("method not found") {
                error_codes::METHOD_NOT_FOUND
            } else {
                error_codes::INVALID_PARAMS
            };
            Response::error(Some(id), code, msg)
        }
        JobStatus::Cancelled => Response::error(
            Some(id),
            error_codes::REQUEST_CANCELLED,
            "request cancelled via $/cancelRequest",
        ),
    }
}

struct ExecShared {
    snapshot: RegistrySnapshot,
    done_tx: Sender<JobOutcome>,
    stats_cell: Arc<Mutex<PoolStats>>,
    state: Mutex<ExecState>,
    signal: Condvar,
}

struct ExecState {
    gate: WorkerPoolGate,
    /// RUST-076-W: IO/CPU lane admission accounting (truly blocking faces and CPU-parsing faces each hold an independent
    /// hard cap; io+cpu <= workers-1 structurally preserves the interactive reservation). Admission/release all happen under this lock,
    /// the same lock as the queue -- no lock-free cross-thread reordering.
    lane_gate: LaneGate,
    interactive: VecDeque<Job>,
    background: VecDeque<Job>,
    /// Job ids cancelled while in flight (or just popped but not yet started); dropped on this basis before/after execution.
    running_cancelled: HashSet<RequestId>,
    /// RUST-068-W: the span table for in-flight/queued jobs (inserted at submit, removed at final state) --
    /// cancel/reply logs look up spans by id; capacity = the number of pending jobs, naturally bounded.
    spans: std::collections::HashMap<RequestId, String>,
    /// RUST-072: cancellation tokens for in-flight jobs (registered when a worker pops, removed at final state) --
    /// a cancel hit sets the token, and the handler exits early through the kode-python probe cooperation point;
    /// capacity = the number of in-flight jobs, naturally bounded.
    running_tokens: HashMap<RequestId, Arc<AtomicBool>>,
    draining: bool,
}

/// The worker-pool executor: held by the main thread; worker count = the total budget.
pub struct PoolExecutor {
    shared: Arc<ExecShared>,
    /// Join the thread handles on Drop (shutdown semantics: stop accepting, drain, then exit).
    handles: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

impl std::fmt::Debug for PoolExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Workers/accounting reconcile through the health pool key; Debug reports identity only and does not expand internal locks.
        f.debug_struct("PoolExecutor").finish_non_exhaustive()
    }
}

impl PoolExecutor {
    /// Assemble the executor: an inconsistent budget panics (never run in a broken state, matching the gate's stance).
    pub fn spawn(
        snapshot: RegistrySnapshot,
        budget: PoolBudget,
    ) -> (PoolExecutor, Receiver<JobOutcome>) {
        budget.validate().expect("pool budget must be valid");
        let workers = budget.total;
        let (done_tx, done_rx) = channel();
        let stats_cell = Arc::new(Mutex::new(PoolStats {
            workers,
            ..PoolStats::default()
        }));
        let shared = Arc::new(ExecShared {
            snapshot,
            done_tx,
            stats_cell: Arc::clone(&stats_cell),
            state: Mutex::new(ExecState {
                gate: WorkerPoolGate::new(budget).expect("pool budget must be valid"),
                lane_gate: LaneGate::new(lane_budget_for_workers(workers))
                    .expect("lane budget must be valid"),
                interactive: VecDeque::new(),
                background: VecDeque::new(),
                running_cancelled: HashSet::new(),
                spans: std::collections::HashMap::new(),
                running_tokens: HashMap::new(),
                draining: false,
            }),
            signal: Condvar::new(),
        });
        let handles = (0..workers)
            .map(|_| {
                let shared = Arc::clone(&shared);
                std::thread::Builder::new()
                    .name("kode-pool".to_string())
                    .spawn(move || worker_loop(Arc::clone(&shared)))
                    .expect("spawn pool worker thread")
            })
            .collect();
        (
            PoolExecutor {
                shared,
                handles: Mutex::new(handles),
            },
            done_rx,
        )
    }

    /// The accounting-snapshot cell shared with the health face (ServerState.pool_stats points at the same one).
    pub fn stats_cell(&self) -> Arc<Mutex<PoolStats>> {
        Arc::clone(&self.shared.stats_cell)
    }

    /// Submit a job; during draining (exiting) it is silently discarded -- the only submitter is the main-loop pump,
    /// which stops before shutdown; this branch only covers a very narrow closing race window.
    pub fn submit(&self, job: Job) {
        let mut state = self.shared.state.lock().expect("pool state lock");
        if state.draining {
            return;
        }
        if let Some(span) = &job.span {
            state.spans.insert(job.id.clone(), span.clone());
        }
        match job.lane {
            PoolLane::Interactive => state.interactive.push_back(job),
            PoolLane::Background => state.background.push_back(job),
        }
        self.shared.signal.notify_all();
    }

    /// Cancel a request: queued-not-started -> remove and answer -32800 (capacity untaken, no drop registration --
    /// a dequeued job never runs, so a registration would have no one to settle it); in-flight -> set the cancellation token + a
    /// drop marker; after execution the capacity is released as usual and the result is discarded, answering -32800. Unknown/duplicate/late
    /// ids enter no table (RUST-072 bounding; no growth on long runs).
    pub fn cancel(&self, id: &RequestId) {
        let (removed, span) = {
            let mut state = self.shared.state.lock().expect("pool state lock");
            let removed = remove_queued(&mut state.interactive, id)
                .or_else(|| remove_queued(&mut state.background, id));
            if removed.is_some() {
                bump_stats(&self.shared.stats_cell, &state, |stats| {
                    stats.jobs_cancelled += 1;
                });
            }
            // RUST-072: an in-flight token hit sets it immediately (the handler cooperation point polls and exits early).
            if let Some(token) = state.running_tokens.get(id) {
                token.store(true, Ordering::SeqCst);
            }
            // RUST-072 bounding: a drop marker is written only when the job could still be executed -- an in-flight
            // token-table hit, or the narrow window where it was popped without a token registered (dequeued but in the worker's hands,
            // span-table hit). A queue-removed job has left the queue and never runs, so it enters no table (otherwise
            // the registration would have no one to settle and remove it, and long-run queued cancels would leak); unknown ids (inline requests / duplicates /
            // late cancels) enter no table either. Table capacity <= the number of in-flight jobs, bounded on long runs.
            if state.running_tokens.contains_key(id)
                || (!removed.is_some() && state.spans.contains_key(id))
            {
                state.running_cancelled.insert(id.clone());
            }
            // RUST-068-W: two span-lookup states -- queue removal = the final state is this very receipt, and the span leaves the
            // table with the receipt carrying it; in-flight drop = the final state happens in the worker's settlement section, so the span stays in the
            // table (carried by the worker's reply), and the cancellation trace keeps a read-only clone. Previously in-flight drops also removed the table unconditionally:
            // the worker settlement would find nothing -> the final-state receipt lost its span (guaranteed to hit within the race window between
            // queue removal and worker pop; the win32-arm64 nightly build's span_table case went red in practice).
            let span = if removed.is_some() {
                state.spans.remove(id)
            } else {
                state.spans.get(id).cloned()
            };
            (removed, span)
        };
        log_cancel(id, span.as_deref());
        if let Some(job) = removed {
            let _ = self.shared.done_tx.send(JobOutcome {
                id: id.clone(),
                lane: job.lane,
                status: JobStatus::Cancelled,
                span,
            });
        }
    }

    /// Depth of the pending jobs' span table (a test/health reconciliation port; removed at final state, naturally bounded).
    pub fn outstanding_spans_for_tests(&self) -> usize {
        self.shared
            .state
            .lock()
            .expect("pool state lock")
            .spans
            .len()
    }

    /// RUST-072: depth of the cancel-drop registry (a test port; acceptance of "the long-run registry stays bounded" --
    /// unknown ids / late cancels never enter; removed at final state; capacity <= pending + in-flight jobs).
    pub fn pending_cancel_registrations_for_tests(&self) -> usize {
        self.shared
            .state
            .lock()
            .expect("pool state lock")
            .running_cancelled
            .len()
    }

    /// Stop accepting new jobs; workers drain the accepted queue then exit (an accepted request owes a reply, never discarded),
    /// and join all workers (the exit path; blocks until in-flight handlers complete).
    pub fn shutdown(&self) {
        {
            let mut state = self.shared.state.lock().expect("pool state lock");
            state.draining = true;
        }
        self.shared.signal.notify_all();
        let mut handles = self.handles.lock().expect("pool handles lock");
        for handle in handles.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for PoolExecutor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// RUST-068-W: the cancellation trace (span defaults to printing `-`; prints only id/span, never params -- sanitized).
fn log_cancel(id: &RequestId, span: Option<&str>) {
    eprintln!(
        "[kode-server] request {id} cancelled (pool span={})",
        span.unwrap_or("-")
    );
}

/// Remove the queued job with the target id from the queue (the cancel path; capacity untaken, no release accounting needed).
fn remove_queued(queue: &mut VecDeque<Job>, id: &RequestId) -> Option<Job> {
    let index = queue.iter().position(|job| &job.id == id)?;
    queue.remove(index)
}

/// Update accounting via the closure and sync the health-face cell (the gate and lane_gate running counts refresh after every
/// accounting change; the cell is held briefly inside the queue lock only, the health path holds only the cell lock, never the reverse).
/// RUST-076-W: interactive in-flight is presented via WorkerPoolGate's interactive stance; LaneGate's
/// Interactive count is never double-published; the io/cpu lanes reconcile directly through LaneGate.
/// Same family as KR-AUD-22 (the same stance as scheduler.rs panic_to_error): a handler panic message becomes an
/// Err message, accounted under the Failed final state.
fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        format!("dispatch panicked: {s}")
    } else if let Some(s) = payload.downcast_ref::<String>() {
        format!("dispatch panicked: {s}")
    } else {
        "dispatch panicked".to_string()
    }
}

fn bump_stats(cell: &Mutex<PoolStats>, state: &ExecState, f: impl FnOnce(&mut PoolStats)) {
    if let Ok(mut stats) = cell.lock() {
        stats.interactive_running = state.gate.interactive_running();
        stats.background_running = state.gate.background_running();
        stats.io_running = state.lane_gate.running(TaskLane::Io);
        stats.cpu_running = state.lane_gate.running(TaskLane::Cpu);
        f(&mut stats);
    }
}

/// KODE-RESP-005: a read-only probe of whether the background queue head could be admitted (changes no accounting; the same form as the
/// worker take-job section's try_admit criterion: the lane hard cap + the gate's double gate). Lets the draining
/// guard recognize queued jobs that would never be scheduled.
fn background_admittable(state: &ExecState) -> bool {
    let head_kind = match state.background.front() {
        Some(job) => job.kind,
        None => return true,
    };
    let lane_budget = state.lane_gate.budget();
    let lane_ok = match head_kind {
        TaskLane::Interactive => true,
        TaskLane::Io => state.lane_gate.running(TaskLane::Io) < lane_budget.io_max,
        TaskLane::Cpu => state.lane_gate.running(TaskLane::Cpu) < lane_budget.cpu_max,
    };
    let gate_budget = state.gate.budget();
    let gate_ok = state.gate.background_running() < gate_budget.background_max
        && state.gate.interactive_running() + state.gate.background_running()
            < gate_budget.total - gate_budget.interactive_reserved;
    lane_ok && gate_ok
}

fn worker_loop(shared: Arc<ExecShared>) {
    loop {
        // Take-job section: under the lock only queue removal and admission accounting happen; the handler runs outside the lock.
        // RUST-076-W: admission has two layers -- LaneGate (IO/CPU/interactive lane accounting, first) +
        // WorkerPoolGate (the interactive reservation quota, second); either layer rejecting rolls back the already-admitted side,
        // and the job honestly returns to the queue to wait for capacity (condvar wait, no busy spinning).
        let (job, admitted_lane) = {
            let mut state = shared.state.lock().expect("pool state lock");
            'pick: loop {
                // Draining (exiting): drain the accepted queue before exiting -- every accepted request owes
                // a reply; silently discarding would break reply parity with the inline path.
                if state.draining && state.interactive.is_empty() && state.background.is_empty() {
                    return;
                }
                // KODE-RESP-005: while draining, the queue head can never be admitted (a degenerate budget, e.g. an unassembled
                // floor of total=1: background_max=0/io_max=0) and no job at all is
                // in flight -- the drain semantics would never see the drain complete and join would hang forever. Honestly cancel
                // the remaining queued jobs (answering -32800, the honest approximation of "accepted means owing a reply") and then fall through to
                // the loop-top drain check to exit. The probe is read-only and changes no accounting; an interactive queue head with zero
                // occupancy can always enter, so this shape cannot occur.
                if state.draining
                    && state.interactive.is_empty()
                    && !state.background.is_empty()
                    && state.gate.interactive_running() == 0
                    && state.gate.background_running() == 0
                    && !background_admittable(&state)
                {
                    while let Some(job) = state.background.pop_front() {
                        let span = state.spans.remove(&job.id);
                        bump_stats(&shared.stats_cell, &state, |stats| {
                            stats.jobs_cancelled += 1;
                        });
                        let _ = shared.done_tx.send(JobOutcome {
                            id: job.id,
                            lane: job.lane,
                            status: JobStatus::Cancelled,
                            span,
                        });
                    }
                    shared.signal.notify_all();
                    continue;
                }
                // Interactive first: the reservation semantics -- a saturated/queued background cannot block an interactive request either.
                // The interactive face is always admitted through LaneGate::Interactive (always able to enter, until the
                // total fills); kind is bookkeeping only, and the CPU/IO hard caps never block interactive.
                if let Some(job) = state.interactive.pop_front() {
                    let lane_admitted = state.lane_gate.try_admit(TaskLane::Interactive);
                    let gate_admitted = lane_admitted && state.gate.try_admit_interactive();
                    if gate_admitted {
                        bump_stats(&shared.stats_cell, &state, |_| {});
                        break 'pick (job, TaskLane::Interactive);
                    }
                    // Theoretically unreachable (worker=total; a waking idle thread must find a free seat);
                    // honestly return it to the queue to wait for capacity, never over-admitting (rolling back the already-admitted side first).
                    if lane_admitted && !gate_admitted {
                        state.lane_gate.release(TaskLane::Interactive);
                    }
                    state.interactive.push_front(job);
                } else if let Some(&head_kind) = state.background.front().map(|job| &job.kind) {
                    // Background queue: admit the queue head's job into its lane by kind (IO/CPU each hold a hard cap,
                    // separated semantics -- IO saturation does not squeeze CPU, and vice versa), then pass the gate quota.
                    // The queue head does not move (FIFO order preserved); a lane rejection makes the whole queue wait -- no reordering,
                    // no queue jumping; the empty-queue path and this one both take the condvar wait.
                    let lane_admitted = state.lane_gate.try_admit(head_kind);
                    let gate_admitted = lane_admitted && state.gate.try_admit_background();
                    if lane_admitted && gate_admitted {
                        let job = state
                            .background
                            .pop_front()
                            .expect("background non-empty checked");
                        bump_stats(&shared.stats_cell, &state, |_| {});
                        break 'pick (job, head_kind);
                    }
                    if lane_admitted && !gate_admitted {
                        state.lane_gate.release(head_kind);
                    }
                }
                state = shared.signal.wait(state).expect("pool state lock poisoned");
            }
        };
        // RUST-072: register this job's cancellation token (registered under the lock so the cancel three-lookup window stays consistent) and
        // set it into this thread's probe -- the handler cooperation point (kode-python) exits early on this basis.
        let cancel_token = Arc::new(AtomicBool::new(false));
        {
            let mut state = shared.state.lock().expect("pool state lock");
            state
                .running_tokens
                .insert(job.id.clone(), Arc::clone(&cancel_token));
        }
        kode_python::cancel::set_probe(Some(Arc::clone(&cancel_token)));
        // RUST-068-W: the worker-side start trace (the cross-task tracing face; prints only id/method/span).
        eprintln!(
            "[kode-server] pool job {} {} start (span={})",
            job.id,
            job.method,
            job.span.as_deref().unwrap_or("-")
        );
        // Ids cancelled before pop (outside the queue-removal window): short-circuit as cancelled, never running the handler.
        let cancelled_before = {
            let mut state = shared.state.lock().expect("pool state lock");
            state.running_cancelled.remove(&job.id)
        };
        let outcome_status = if cancelled_before {
            JobStatus::Cancelled
        } else {
            // Pure handler execution (outside the lock; workers share no state).
            // Same family as KR-AUD-22 (catch_unwind convergence, following the scheduler.rs precedent): a worker
            // is spawned once and never reborn; a handler panic flipping the thread would leave this job's gate
            // quota and lane seat never released (count leakage wedges admission shut), and the requester would never get a final-state reply.
            let dispatched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                shared.snapshot.dispatch(&job.method, job.params)
            }));
            match dispatched {
                Ok(Ok(value)) => JobStatus::Done(value),
                Ok(Err(msg)) => JobStatus::Failed(msg),
                Err(payload) => JobStatus::Failed(panic_message(payload)),
            }
        };
        // Settlement section: release accounting + final-state counters + the reply (an in-flight cancel discards the result here).
        // RUST-072: cancellation is adjudicated from three sources in parallel -- the pre-pop registry, the in-flight drop registry,
        // and the handler's self-reported cancellation text (a cooperation-point Err; a job with no span bypasses the span table,
        // taking the handler text as the honest source, never falling to -32602 posing as a params error).
        let mut state = shared.state.lock().expect("pool state lock");
        let cancelled = cancelled_before
            || state.running_cancelled.remove(&job.id)
            || matches!(&outcome_status, JobStatus::Failed(msg)
                if msg == kode_python::cancel::CANCELLED_MSG);
        let final_status = if cancelled {
            JobStatus::Cancelled
        } else {
            outcome_status
        };
        let released = match job.lane {
            PoolLane::Interactive => state.gate.release_interactive(),
            PoolLane::Background => state.gate.release_background(),
        };
        // RUST-076-W: lane seats and gate quota release in the same batch (cancel/failure release as usual --
        // no seat leaks; release rejecting an underflow means an admission/release mismatch = an assembly bug).
        let lane_released = state.lane_gate.release(admitted_lane);
        if !released || !lane_released {
            // Admission/release mismatch = an assembly bug: leave a stderr trace, do not panic (server robustness).
            eprintln!("[kode-server] pool release without admission (bug)");
        }
        bump_stats(&shared.stats_cell, &state, |stats| match final_status {
            JobStatus::Done(_) => stats.jobs_done += 1,
            JobStatus::Failed(_) => stats.jobs_failed += 1,
            JobStatus::Cancelled => stats.jobs_cancelled += 1,
        });
        // The span/token tables are removed at final state (capacity = pending/in-flight job counts, naturally bounded).
        let span = state.spans.remove(&job.id);
        state.running_tokens.remove(&job.id);
        drop(state);
        // RUST-072: clear this thread's probe (worker threads are reused; guard against cross-job contamination).
        kode_python::cancel::set_probe(None);
        let _ = shared.done_tx.send(JobOutcome {
            id: job.id,
            lane: job.lane,
            status: final_status,
            span,
        });
        // Capacity released: waiting background/interactive jobs may take a job.
        shared.signal.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::RpcRegistry;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    /// Test slow-handler coordinator: static slots (fn pointers cannot capture). Each test uses a non-overlapping
    /// ticket range, giving zero cross-test interference (cargo test parallel-safe).
    fn hold() -> &'static (Mutex<Vec<u32>>, Condvar) {
        static HOLD: std::sync::OnceLock<(Mutex<Vec<u32>>, Condvar)> = std::sync::OnceLock::new();
        HOLD.get_or_init(|| (Mutex::new(Vec::new()), Condvar::new()))
    }

    /// PoisonError tolerance: after a worker panic poisons the lock, the test coordination face still takes the lock and works,
    /// keeping one test's panic from implicating the whole group (PoisonError guilt-by-association precedent: it went red on CI in practice).
    fn hold_lock() -> std::sync::MutexGuard<'static, Vec<u32>> {
        hold().0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Slow-machine tolerance: an environment-aware cap on the bounded wait's tick count. The default 3000 matches the historical stance
    /// (a 20ms tick ~ 60s); CI slow machines relax it via the workflow setting KODE_TEST_TICK_BUDGET=9000.
    fn tick_budget() -> usize {
        std::env::var("KODE_TEST_TICK_BUDGET")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000)
    }

    /// fn-pointer handler: after registering the ticket it blocks until release number (ticket+1000) appears.
    /// A notify-driven true wait: a single wait until deadline; release's notify_all wakes it early
    /// (spurious wakeups are absorbed by the contains loop), no per-tick polling; the total duration is bounded
    /// (tick_budget x 20ms, defaulting to 60s / 180s on CI) -- so an orphaned worker after a test-side panic
    /// still times out and exits by itself, never wedging CI (the pure unbounded wait() version wedged in practice).
    fn blocking_handler(params: Value) -> Result<Value, String> {
        let ticket = params.get("ticket").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        {
            let mut waiting = hold_lock();
            waiting.push(ticket);
        }
        hold().1.notify_all();
        let mut waiting = hold_lock();
        let deadline = Instant::now() + Duration::from_millis(tick_budget() as u64 * 20);
        loop {
            if waiting.contains(&(ticket + 1000)) {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "handler ticket {ticket} never released"
            );
            let (next, _) = hold()
                .1
                .wait_timeout(waiting, remaining)
                .unwrap_or_else(|e| e.into_inner());
            waiting = next;
        }
        waiting.retain(|t| *t != ticket);
        Ok(serde_json::json!({ "ticket": ticket }))
    }

    /// Release the specified ticket (the test coordination face).
    fn release(ticket: u32) {
        let mut waiting = hold_lock();
        waiting.push(ticket + 1000);
        drop(waiting);
        hold().1.notify_all();
    }

    /// RUST-072 cancellable handler: after registering the ticket it polls this thread's cancel probe (the same query channel as the
    /// production kode-python cooperation point); on cancel -> Err (the cancellation text), otherwise it waits for release.
    fn cancellable_polling_handler(params: Value) -> Result<Value, String> {
        let ticket = params.get("ticket").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        {
            let mut waiting = hold_lock();
            waiting.push(ticket);
        }
        hold().1.notify_all();
        let mut ticks = 0usize;
        loop {
            if kode_python::cancel::is_cancelled() {
                return Err(kode_python::cancel::CANCELLED_MSG.to_string());
            }
            {
                let waiting = hold_lock();
                if waiting.contains(&(ticket + 1000)) {
                    break;
                }
            }
            assert!(
                ticks < tick_budget(),
                "cancellable handler ticket {ticket} never resolved"
            );
            std::thread::sleep(Duration::from_millis(10));
            ticks += 1;
        }
        Ok(serde_json::json!({ "ticket": ticket }))
    }

    /// Wait until a handler registered the specified ticket (the observable face of a worker truly starting).
    /// Bounded wait: turns red rather than wedging when the scheduling face regresses (interactive never entering).
    fn wait_started(ticket: u32) {
        let mut waiting = hold_lock();
        let mut ticks = 0usize;
        loop {
            if waiting.contains(&ticket) {
                return;
            }
            assert!(
                ticks < tick_budget(),
                "worker never started ticket {ticket}"
            );
            let (next, _) = hold()
                .1
                .wait_timeout(waiting, Duration::from_millis(20))
                .unwrap_or_else(|e| e.into_inner());
            waiting = next;
            ticks += 1;
        }
    }

    fn registry_with_test_handlers() -> RegistrySnapshot {
        let mut reg = RpcRegistry::new();
        reg.register("$/kode/test/blocking", blocking_handler);
        reg.register("$/kode/test/cancellable", cancellable_polling_handler);
        reg.register(
            "$/kode/test/failing",
            |_params: Value| -> Result<Value, String> {
                Err("boom: deliberate test failure".to_string())
            },
        );
        reg.snapshot()
    }

    fn job(id: u32, method: &str, lane: PoolLane) -> Job {
        // The default kinds are isomorphic with the production classification: background queue = Io faces, interactive queue = Cpu faces
        // (interactive admission always goes through the Interactive reservation; kind is bookkeeping only).
        let kind = match lane {
            PoolLane::Interactive => TaskLane::Cpu,
            PoolLane::Background => TaskLane::Io,
        };
        job_with_kind(id, method, lane, kind)
    }

    fn job_with_kind(id: u32, method: &str, lane: PoolLane, kind: TaskLane) -> Job {
        Job {
            id: RequestId::Number(id as i64),
            method: method.to_string(),
            params: serde_json::json!({ "ticket": id }),
            lane,
            kind,
            span: Some(format!("span-{id:04x}")),
        }
    }

    #[test]
    fn lane_budget_for_workers_keeps_interactive_reserve_and_io_floor() {
        // Structural constraint: io+cpu <= workers-1 (always keep the interactive reservation); at >=2 cores io >= 1
        // (the library's from_total gives io=0 at N=2, starving the IO faces); a single core gives everything to interactive.
        let cases = [
            (1usize, (0usize, 0usize)),
            (2, (1, 0)),
            (3, (1, 1)),
            (4, (1, 2)),
            (8, (3, 4)),
        ];
        for (workers, (io, cpu)) in cases {
            let b = lane_budget_for_workers(workers);
            assert_eq!((b.io_max, b.cpu_max), (io, cpu), "workers={workers}");
            assert_eq!(b.total, workers);
            assert!(b.validate().is_ok(), "workers={workers} 预算须自洽");
        }
    }

    #[test]
    fn rpc_lane_class_routes_io_table_and_defaults_cpu() {
        // The IO table's five faces -> Background+Io (slow IO never takes interactive seats).
        for method in [
            "$/kode/dbClone/export",
            "$/kode/dbClone/inspectArchive",
            "$/kode/dbClone/readArchiveRows",
            "$/kode/ruff/lint",
            "$/kode/workspace/scanAnchors",
        ] {
            assert_eq!(
                rpc_lane_class(method),
                (PoolLane::Background, TaskLane::Io),
                "{method} 须归 IO 表"
            );
        }
        // The remaining registered faces default to Interactive+Cpu (pure parsing).
        assert_eq!(
            rpc_lane_class("$/kode/echo"),
            (PoolLane::Interactive, TaskLane::Cpu)
        );
        assert_eq!(
            rpc_lane_class("$/kode/python/selfAttributeFlow"),
            (PoolLane::Interactive, TaskLane::Cpu)
        );
        // The two projections of the single classification source agree.
        for method in ["$/kode/ruff/lint", "$/kode/echo"] {
            assert_eq!(rpc_pool_lane(method), rpc_lane_class(method).0);
            assert_eq!(rpc_job_kind(method), rpc_lane_class(method).1);
        }
    }

    #[test]
    fn io_saturation_does_not_block_cpu_and_interactive_lanes() {
        // total=4 -> io_max=1, cpu_max=2. IO full + CPU full + interactive in flight all hold simultaneously
        // (all 4 workers occupied), and after CPU saturates the 4th CPU job queues -- interactive still enters immediately.
        let budget = PoolBudget {
            total: 4,
            interactive_reserved: 1,
            background_max: 3,
        };
        let (executor, _rx) = PoolExecutor::spawn(registry_with_test_handlers(), budget);
        executor.submit(job_with_kind(
            501,
            "$/kode/test/blocking",
            PoolLane::Background,
            TaskLane::Io,
        ));
        wait_started(501);
        executor.submit(job_with_kind(
            502,
            "$/kode/test/blocking",
            PoolLane::Background,
            TaskLane::Cpu,
        ));
        wait_started(502);
        executor.submit(job_with_kind(
            503,
            "$/kode/test/blocking",
            PoolLane::Background,
            TaskLane::Cpu,
        ));
        wait_started(503);
        // The 4th CPU job: the CPU lane hard cap (2) and the gate's background quota (3) are both saturated
        // -- queue and wait for capacity, never over-admitting (an 80ms observation quiet period; if it started anyway, the 505 interactive
        // request would have no worker left, and wait_started turning red would be the over-admission face).
        executor.submit(job_with_kind(
            504,
            "$/kode/test/blocking",
            PoolLane::Background,
            TaskLane::Cpu,
        ));
        std::thread::sleep(Duration::from_millis(80));
        // The interactive face still enters immediately with CPU full + IO full (the reservation semantics).
        executor.submit(job(505, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(505);
        let stats = stats_of(&executor);
        assert_eq!(
            (
                stats.io_running,
                stats.cpu_running,
                stats.interactive_running
            ),
            (1, 2, 1),
            "IO 满+CPU 满+交互在飞并存(4 worker 全占)"
        );
        release(505);
        release(502);
        // A CPU seat releases: queued CPU jobs enter in order (a still-full IO seat does not block CPU).
        wait_started(504);
        let stats = stats_of(&executor);
        assert_eq!(stats.cpu_running, 2, "CPU 位释放后补位");
        assert_eq!(stats.io_running, 1, "IO 泳道仍满");
        release(504);
        release(503);
        release(501);
        drop(executor);
    }

    #[test]
    fn cancel_queued_io_job_leaves_no_lane_slot() {
        // total=2 -> io_max=1. Cancelling a queued IO job: answers -32800 immediately with zero lane seats taken;
        // Subsequent IO jobs enter as usual after the seat releases (no seat leak).
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        executor.submit(job(601, "$/kode/test/blocking", PoolLane::Background));
        wait_started(601);
        executor.submit(job(602, "$/kode/test/blocking", PoolLane::Background));
        executor.cancel(&RequestId::Number(602));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Cancelled));
        let stats = stats_of(&executor);
        assert_eq!(stats.jobs_cancelled, 1);
        assert_eq!(stats.io_running, 1, "在途 601 泳道位未受影响");
        release(601);
        // The lane seat has released: a new IO job can execute (a cancel leaves no seat taken).
        executor.submit(job(603, "$/kode/test/blocking", PoolLane::Background));
        wait_started(603);
        assert_eq!(stats_of(&executor).io_running, 1);
        release(603);
        drop(executor);
    }

    #[test]
    fn failing_io_job_releases_lane_slot() {
        // An IO job fails (handler Err): the lane seat releases as usual, so later IO jobs do not starve.
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        executor.submit(job(611, "$/kode/test/failing", PoolLane::Background));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Failed(_)));
        assert_eq!(stats_of(&executor).io_running, 0, "失败即释放泳道位");
        executor.submit(job(612, "$/kode/test/blocking", PoolLane::Background));
        wait_started(612);
        release(612);
        drop(executor);
    }

    #[test]
    fn span_table_tracks_outstanding_jobs_and_drains_on_terminal() {
        // Deterministic queueing: 701/703's two wait_started calls occupy both workers of total=2,
        // so when 702 is submitted, admission must reject (the interactive reservation is full too) and it must take the "queue -> cancel-remove" path.
        // No longer relying on the race where the main thread's cancel grabs the lock before the worker wakes -- on a slow CI
        // machine this went red in practice: if the worker pops first, 702 is in flight, cancel takes the in-flight path leaving the span in the table,
        // and the 2!=1 assertion must go red (try_admit_interactive's "total occupancy < total always admits interactive").
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        executor.submit(job(701, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(701);
        executor.submit(job(703, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(703);
        executor.submit(job(702, "$/kode/test/blocking", PoolLane::Interactive));
        assert_eq!(
            executor.outstanding_spans_for_tests(),
            3,
            "未决=3(两张在飞+一张排队)"
        );
        executor.cancel(&RequestId::Number(702));
        assert_eq!(
            executor.outstanding_spans_for_tests(),
            2,
            "排队取消摘除 span"
        );
        release(701);
        release(703);
        // The three receipts arrive over the channel in any order: sort them out by id (701/703 completions + the 702 cancel).
        let expected_701 = format!("span-{:04x}", 701);
        let expected_702 = format!("span-{:04x}", 702);
        let expected_703 = format!("span-{:04x}", 703);
        let mut cancelled_span: Option<String> = None;
        let mut outcome_701: Option<JobOutcome> = None;
        let mut outcome_703: Option<JobOutcome> = None;
        while outcome_701.is_none() || outcome_703.is_none() || cancelled_span.is_none() {
            let o = recv_outcome(&rx);
            match o.id {
                RequestId::Number(701) => outcome_701 = Some(o),
                RequestId::Number(703) => outcome_703 = Some(o),
                RequestId::Number(702) => {
                    cancelled_span = Some(o.span.expect("702 取消回执带 span"))
                }
                _ => {}
            }
        }
        assert_eq!(
            cancelled_span.as_deref(),
            Some(expected_702.as_str()),
            "排队取消回执携带同源 span"
        );
        assert_eq!(
            outcome_701.unwrap().span.as_deref(),
            Some(expected_701.as_str()),
            "701 回包携带同源 span"
        );
        assert_eq!(
            outcome_703.unwrap().span.as_deref(),
            Some(expected_703.as_str()),
            "703 回包携带同源 span"
        );
        assert_eq!(
            executor.outstanding_spans_for_tests(),
            0,
            "终态后 span 表排空(有界面)"
        );
        drop(executor);
    }

    #[test]
    fn inflight_cancel_terminal_outcome_carries_span() {
        // Regression pin: a cancel on the in-flight-drop path must not remove the span from the span table -- the final-state receipt is
        // produced by the worker's settlement section, so the span must stay in the table to ride along with the reply (the queue-removal path is
        // already covered by the span_table case; the previous unconditional table removal let the worker settlement find nothing, going red on
        // the win32 nightly in practice). Determinism: cancel only after the start, never through the queue race window.
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        // Ticket 841: an independent range (the cancellable case previously collided with its range-mate 801 -- the global hold
        // registry is shared across pools, so overlapping ticket numbers made wait_started fire on someone else's registration).
        executor.submit(job(841, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(841);
        executor.cancel(&RequestId::Number(841));
        assert_eq!(
            executor.outstanding_spans_for_tests(),
            1,
            "在途取消 span 留表待终态回执"
        );
        release(841);
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Cancelled));
        assert_eq!(
            outcome.span.as_deref(),
            Some("span-0349"),
            "在途取消终态回执携带 span"
        );
        assert_eq!(
            executor.outstanding_spans_for_tests(),
            0,
            "终态后 span 表排空"
        );
        drop(executor);
    }

    fn stats_of(executor: &PoolExecutor) -> PoolStats {
        // PoisonError tolerance: the same as the hold face; accounting observation after a panic is not guilt-bound.
        *executor
            .shared
            .stats_cell
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Wait until accounting enters the expected running state (polling; a timeout fails the assertion).
    fn wait_running(executor: &PoolExecutor, interactive: usize, background: usize) {
        for _ in 0..300 {
            let stats = stats_of(executor);
            if stats.interactive_running == interactive && stats.background_running == background {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "pool running never reached i={interactive}/b={background}: {:?}",
            stats_of(executor)
        );
    }

    fn recv_outcome(rx: &Receiver<JobOutcome>) -> JobOutcome {
        rx.recv_timeout(Duration::from_secs(5))
            .expect("job outcome in time")
    }

    #[test]
    fn execution_lane_routes_rpc_and_keeps_malformed_inline() {
        assert_eq!(
            execution_lane(
                "$/kode/rpc",
                Some(&serde_json::json!({ "method": "$/kode/echo" }))
            ),
            ExecutionLane::Pool(PoolLane::Interactive)
        );
        // Invalid shape: returns Inline, letting the server take its original INVALID_PARAMS path.
        assert_eq!(
            execution_lane("$/kode/rpc", Some(&serde_json::json!({}))),
            ExecutionLane::Inline
        );
        assert_eq!(execution_lane("$/kode/rpc", None), ExecutionLane::Inline);
        // Top-level serving faces are always Inline.
        assert_eq!(
            execution_lane("textDocument/hover", None),
            ExecutionLane::Inline
        );
        assert_eq!(execution_lane("$/kode/health", None), ExecutionLane::Inline);
    }

    #[test]
    fn rpc_response_for_maps_status_codes() {
        let done = rpc_response_for(
            RequestId::Number(1),
            JobStatus::Done(serde_json::json!({ "ok": true })),
        );
        assert!(done.error.is_none(), "Done 映射成功响应");
        let not_found = rpc_response_for(
            RequestId::Number(2),
            JobStatus::Failed("method not found: x".to_string()),
        );
        assert_eq!(not_found.error.as_ref().map(|e| e.code), Some(-32601));
        let invalid = rpc_response_for(
            RequestId::Number(3),
            JobStatus::Failed("bad input".to_string()),
        );
        assert_eq!(invalid.error.as_ref().map(|e| e.code), Some(-32602));
        let cancelled = rpc_response_for(RequestId::Number(4), JobStatus::Cancelled);
        assert_eq!(cancelled.error.as_ref().map(|e| e.code), Some(-32800));
    }

    #[test]
    fn interactive_drains_before_background_reservation_holds() {
        // total=2, reserved=1, background_max=1。
        let budget = PoolBudget {
            total: 2,
            interactive_reserved: 1,
            background_max: 1,
        };
        let (executor, rx) = PoolExecutor::spawn(registry_with_test_handlers(), budget);
        // First take the only background seat, then queue a background job, then queue an interactive one: interactive must overtake the queued background job.
        executor.submit(job(101, "$/kode/test/blocking", PoolLane::Background));
        wait_started(101);
        executor.submit(job(102, "$/kode/test/blocking", PoolLane::Background));
        executor.submit(job(103, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(103);
        let stats = stats_of(&executor);
        assert_eq!(
            (stats.interactive_running, stats.background_running),
            (1, 1),
            "交互越过排队后台执行;后台硬顶 1 未越过"
        );
        release(103);
        release(101);
        // The freed background seat lets queued job 102 execute.
        wait_started(102);
        release(102);
        let mut seen: Vec<i64> = Vec::new();
        while let Ok(outcome) = rx.recv_timeout(Duration::from_secs(5)) {
            if let RequestId::Number(n) = outcome.id {
                seen.push(n);
            }
            assert!(matches!(outcome.status, JobStatus::Done(_)));
            if seen.len() == 3 {
                break;
            }
        }
        assert_eq!(seen.len(), 3, "三个 job 全部执行: {seen:?}");
        assert!(seen.contains(&103), "交互 job 必须执行: {seen:?}");
        drop(executor);
    }

    #[test]
    fn background_hard_cap_never_exceeded() {
        let budget = PoolBudget {
            total: 2,
            interactive_reserved: 1,
            background_max: 1,
        };
        let (executor, rx) = PoolExecutor::spawn(registry_with_test_handlers(), budget);
        executor.submit(job(201, "$/kode/test/blocking", PoolLane::Background));
        executor.submit(job(202, "$/kode/test/blocking", PoolLane::Background));
        executor.submit(job(203, "$/kode/test/blocking", PoolLane::Background));
        wait_started(201);
        wait_running(&executor, 0, 1);
        assert_eq!(stats_of(&executor).background_running, 1, "后台硬顶 1");
        // Background saturated: interactive still enters immediately (the reservation semantics).
        executor.submit(job(209, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(209);
        wait_running(&executor, 1, 1);
        release(209);
        release(201);
        // The freed background seat: queued jobs enter in order.
        wait_started(202);
        release(202);
        wait_started(203);
        release(203);
        let mut seen: Vec<i64> = Vec::new();
        while let Ok(outcome) = rx.recv_timeout(Duration::from_secs(5)) {
            if let RequestId::Number(n) = outcome.id {
                seen.push(n);
            }
            assert!(matches!(outcome.status, JobStatus::Done(_)));
            if seen.len() == 4 {
                break;
            }
        }
        assert_eq!(seen.len(), 4, "四个 job 全部执行: {seen:?}");
        drop(executor);
    }

    #[test]
    fn cancel_queued_drops_before_start_without_taking_capacity() {
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(1));
        executor.submit(job(301, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(301);
        executor.submit(job(302, "$/kode/test/blocking", PoolLane::Interactive));
        // Cancelling 302 while queued: answers -32800 immediately, no capacity taken.
        executor.cancel(&RequestId::Number(302));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Cancelled));
        let stats = stats_of(&executor);
        assert_eq!(stats.jobs_cancelled, 1);
        assert_eq!(stats.interactive_running, 1, "在途 301 未受影响");
        // Release 301: 302 must not revive.
        release(301);
        let mut seen_first = false;
        let mut seen_cancelled_twice = false;
        while let Ok(outcome) = rx.recv_timeout(Duration::from_millis(500)) {
            match outcome.id {
                RequestId::Number(301) => {
                    assert!(matches!(outcome.status, JobStatus::Done(_)));
                    seen_first = true;
                }
                RequestId::Number(302) => seen_cancelled_twice = true,
                _ => {}
            }
        }
        assert!(seen_first, "301 正常完成");
        assert!(!seen_cancelled_twice, "302 只回一次取消,不复活");
        drop(executor);
    }

    #[test]
    fn cancel_running_discards_result_and_releases_capacity() {
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(1));
        executor.submit(job(401, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(401);
        executor.cancel(&RequestId::Number(401));
        release(401);
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Cancelled));
        let stats = stats_of(&executor);
        assert_eq!(stats.jobs_cancelled, 1);
        assert_eq!(stats.interactive_running, 0, "容量已释放");
        // Capacity recovers after release: a new job can execute.
        executor.submit(job(402, "$/kode/echo", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Done(_)));
        drop(executor);
    }

    #[test]
    fn cancel_running_flips_token_handler_exits_early_and_settles_cancelled() {
        // RUST-072 core face: in-flight cancel -> cancel sets the token -> the handler cooperation point's probe
        // exits early (a true interruption, not waiting for the handler to finish naturally) -> settles as Cancelled (-32800),
        // capacity is reclaimed immediately, and light requests are not occupied.
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(1));
        executor.submit(job(801, "$/kode/test/cancellable", PoolLane::Interactive));
        wait_started(801);
        let cancel_at = std::time::Instant::now();
        executor.cancel(&RequestId::Number(801));
        let outcome = recv_outcome(&rx);
        // The handler polls the probe every 10ms: the early exit should land within seconds (finishing naturally is also
        // bounded, but the cancel path must be clearly faster than the release path -- there is no release here; the only
        // exit is the cancel).
        assert!(
            cancel_at.elapsed() < Duration::from_secs(5),
            "在途取消应经令牌提前退出,实测 {:?}",
            cancel_at.elapsed()
        );
        assert!(
            matches!(outcome.status, JobStatus::Cancelled),
            "协作中断结算 Cancelled,实际 {outcome:?}"
        );
        let response = rpc_response_for(outcome.id, outcome.status);
        assert_eq!(
            response.error.as_ref().map(|e| e.code),
            Some(-32800),
            "协作中断回 -32800,绝不落 -32602 冒充参数错"
        );
        assert_eq!(
            executor.pending_cancel_registrations_for_tests(),
            0,
            "终态摘除:登记表排空"
        );
        assert_eq!(stats_of(&executor).interactive_running, 0, "容量已回收");
        // After reclamation, light requests still enter immediately as usual.
        executor.submit(job(802, "$/kode/echo", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Done(_)));
        drop(executor);
    }

    #[test]
    fn cancel_handler_message_settles_cancelled_even_without_span() {
        // A job with no span (submit carried no span -> no span-table entry): an in-flight cancel
        // is adjudicated through the in-flight token table (registered when the worker pops, span-independent) -- settling
        // as Cancelled, never as Failed (-32602).
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(1));
        let bare = Job {
            id: RequestId::Number(811),
            method: "$/kode/test/cancellable".to_string(),
            params: serde_json::json!({ "ticket": 811 }),
            lane: PoolLane::Interactive,
            kind: TaskLane::Cpu,
            span: None,
        };
        executor.submit(bare);
        wait_started(811);
        executor.cancel(&RequestId::Number(811));
        let outcome = recv_outcome(&rx);
        assert!(
            matches!(outcome.status, JobStatus::Cancelled),
            "无 span 在途取消仍按令牌表裁定 Cancelled,实际 {outcome:?}"
        );
        assert_eq!(stats_of(&executor).jobs_cancelled, 1);
        drop(executor);
    }

    #[test]
    fn handler_reported_cancellation_message_settles_cancelled() {
        // The honest-source arm of the three settlement sources, observable: the executor never cancelled (both the token table
        // and the drop table absent), the handler itself observed the cancel through the probe and reported the cancellation text -> settles as Cancelled,
        // never as Failed (-32602) posing as a params error.
        fn self_reporting_cancel_handler(_params: Value) -> Result<Value, String> {
            let token = Arc::new(AtomicBool::new(true));
            kode_python::cancel::set_probe(Some(token));
            let verdict = kode_python::cancel::check_point();
            kode_python::cancel::set_probe(None);
            Err(verdict
                .expect_err("probe flipped true must cancel")
                .to_string())
        }
        let mut reg = RpcRegistry::new();
        reg.register("$/kode/test/selfcancel", self_reporting_cancel_handler);
        let (executor, rx) = PoolExecutor::spawn(reg.snapshot(), PoolBudget::from_total(1));
        executor.submit(job(812, "$/kode/test/selfcancel", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        assert!(
            matches!(outcome.status, JobStatus::Cancelled),
            "handler 自报取消文案应裁定 Cancelled,实际 {outcome:?}"
        );
        let response = rpc_response_for(outcome.id, outcome.status);
        assert_eq!(
            response.error.as_ref().map(|e| e.code),
            Some(-32800),
            "handler 自报取消映射 -32800"
        );
        drop(executor);
    }

    #[test]
    fn panicking_handler_settles_failed_and_releases_gate() {
        // Same family as KR-AUD-22: a handler panic is accounted under the Failed final state (catch_unwind convergence).
        // A worker is spawned once and never reborn -- without convergence the thread would flip: the gate quota and lane seats
        // would never release (count leakage wedges admission shut) and the requester would never get a final-state reply.
        fn panicking_handler(_params: Value) -> Result<Value, String> {
            panic!("handler exploded");
        }
        let mut reg = RpcRegistry::new();
        reg.register("$/kode/test/boom", panicking_handler);
        let (executor, rx) = PoolExecutor::spawn(reg.snapshot(), PoolBudget::from_total(1));
        executor.submit(job(911, "$/kode/test/boom", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        let JobStatus::Failed(message) = outcome.status else {
            panic!("panic 应落 Failed 终态,实际 {outcome:?}");
        };
        assert!(
            message.contains("handler exploded"),
            "panic 消息应可定位,实际 {message:?}"
        );
        // Quota released: after the final state the lane occupancy drains and the failure counter books.
        let stats = stats_of(&executor);
        assert_eq!(stats.interactive_running, 0, "终态后交互占用应排空");
        assert_eq!(stats.jobs_failed, 1, "panic 按失败计数");
        // The thread was not flipped: the same worker handles the next job as usual
        executor.submit(job(912, "$/kode/test/boom", PoolLane::Interactive));
        let second = recv_outcome(&rx);
        assert!(matches!(second.status, JobStatus::Failed(_)));
        drop(executor);
    }

    #[test]
    fn cancel_unknown_and_duplicate_ids_never_grow_registration_table() {
        // Acceptance of "the long-run registry stays bounded": unknown ids (inline requests / never-submitted ids), queue
        // removal (once dequeued it never runs, so a registration would have no settler and enters no table), and duplicate/late cancels after final state
        // all enter no table -- table capacity <= the number of in-flight jobs, no growth on long runs.
        let (executor, _rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        // Occupy both workers: 821/823 in flight, 822 queued.
        executor.submit(job(821, "$/kode/test/cancellable", PoolLane::Interactive));
        executor.submit(job(823, "$/kode/test/cancellable", PoolLane::Interactive));
        wait_started(821);
        wait_started(823);
        executor.submit(job(822, "$/kode/test/cancellable", PoolLane::Interactive));
        let unknown = RequestId::Number(99_999);
        for _ in 0..1000 {
            executor.cancel(&unknown);
        }
        assert_eq!(
            executor.pending_cancel_registrations_for_tests(),
            0,
            "未知 id 千次取消不入表"
        );
        assert_eq!(
            executor.outstanding_spans_for_tests(),
            3,
            "未知 id 不动在途 job 的 span"
        );
        // Queue removal: the job leaves the queue and never runs, and its registration enters no table (the leak arm -- the old stance entered the table here
        // with no settler, letting long-run queued cancels grow unboundedly).
        executor.cancel(&RequestId::Number(822));
        assert_eq!(
            executor.pending_cancel_registrations_for_tests(),
            0,
            "排队摘除不入表(离队即永不执行)"
        );
        // In-flight cancel: the registry is hit, and the final state (cooperative interruption) removes it immediately; later duplicate cancels (the
        // unknown-id arm) do not grow it further.
        executor.cancel(&RequestId::Number(821));
        assert_eq!(
            executor.pending_cancel_registrations_for_tests(),
            1,
            "在途取消入表"
        );
        let mut ticks = 0;
        while executor.pending_cancel_registrations_for_tests() > 0 {
            assert!(ticks < 300, "登记表终态不摘除");
            std::thread::sleep(Duration::from_millis(10));
            ticks += 1;
        }
        executor.cancel(&RequestId::Number(821));
        executor.cancel(&RequestId::Number(821));
        assert_eq!(
            executor.pending_cancel_registrations_for_tests(),
            0,
            "终态后重复取消不入表"
        );
        release(823);
        drop(executor);
    }

    #[test]
    fn late_cancel_after_terminal_never_grows_registration_table() {
        // A late cancel (after final state): the table entry is gone, the cancel falls to the "unknown id" arm, and enters no table.
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(1));
        executor.submit(job(831, "$/kode/test/cancellable", PoolLane::Interactive));
        wait_started(831);
        release(831);
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Done(_)));
        assert_eq!(executor.pending_cancel_registrations_for_tests(), 0);
        assert_eq!(executor.outstanding_spans_for_tests(), 0);
        executor.cancel(&RequestId::Number(831));
        assert_eq!(
            executor.pending_cancel_registrations_for_tests(),
            0,
            "迟到取消不入表"
        );
        drop(executor);
    }

    #[test]
    fn failed_job_maps_error_and_releases_capacity() {
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        executor.submit(job(501, "$/kode/test/failing", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        let response = rpc_response_for(outcome.id, outcome.status);
        assert_eq!(response.error.as_ref().map(|e| e.code), Some(-32602));
        wait_running(&executor, 0, 0);
        // An unknown method gets the same stance, -32601.
        executor.submit(job(502, "$/kode/test/absent", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        let response = rpc_response_for(outcome.id, outcome.status);
        assert_eq!(response.error.as_ref().map(|e| e.code), Some(-32601));
        drop(executor);
    }

    #[test]
    fn snapshot_dispatch_matches_registry_methods() {
        let snapshot = registry_with_test_handlers();
        assert_eq!(snapshot.len(), 4, "echo 内建 + 三个测试 handler");
        for method in snapshot.methods() {
            assert!(method.starts_with("$/kode/"), "method 全带前缀: {method}");
        }
        assert!(
            snapshot
                .dispatch("$/kode/test/absent", Value::Null)
                .unwrap_err()
                .starts_with("method not found"),
            "未知 method 同口径"
        );
    }

    #[test]
    fn workers_never_exceed_budget_total() {
        static EXECUTED: AtomicU32 = AtomicU32::new(0);
        fn counting_handler(params: Value) -> Result<Value, String> {
            EXECUTED.fetch_add(1, Ordering::SeqCst);
            Ok(params)
        }
        let mut reg = RpcRegistry::new();
        reg.register("$/kode/test/counting", counting_handler);
        let (executor, rx) = PoolExecutor::spawn(reg.snapshot(), PoolBudget::from_total(2));
        for id in 601..=606 {
            executor.submit(job(id, "$/kode/test/counting", PoolLane::Interactive));
        }
        let mut done = 0;
        while done < 6 {
            let outcome = recv_outcome(&rx);
            assert!(matches!(outcome.status, JobStatus::Done(_)));
            done += 1;
        }
        assert_eq!(EXECUTED.load(Ordering::SeqCst), 6);
        let stats = stats_of(&executor);
        assert_eq!(stats.workers, 2);
        assert_eq!(stats.jobs_done, 6);
        assert_eq!(stats.interactive_running, 0);
        drop(executor);
    }

    /// KODE-RESP-005: the assembly-budget floor -- a single core gets 2 (1 interactive + 1 IO face, with background
    /// admittable); multiple cores match from_total field for field (the floor only rescues degenerate budgets).
    #[test]
    fn assembly_budget_floors_single_core_and_keeps_multicore() {
        let single = assembly_pool_budget(1);
        assert_eq!(
            single,
            PoolBudget {
                total: 2,
                interactive_reserved: 1,
                background_max: 1
            },
            "单核装配下限 2:后台 IO 面可准入"
        );
        assert!(single.validate().is_ok());
        assert_eq!(assembly_pool_budget(8), PoolBudget::from_total(8));
        assert_eq!(assembly_pool_budget(2), PoolBudget::from_total(2));
    }

    /// KODE-RESP-005 acceptance arm 1 (pool level): under the single-core-derived assembly budget, a background IO-face
    /// job (the dbClone/ruff/scanAnchors shape) really executes and produces a result -- before the fix,
    /// from_total(1)'s background_max=0 kept it from ever dequeuing.
    #[test]
    fn single_core_assembly_budget_runs_background_io_job() {
        fn echo_handler(params: Value) -> Result<Value, String> {
            Ok(params)
        }
        let mut reg = RpcRegistry::new();
        reg.register("$/kode/test/echo", echo_handler);
        let (executor, rx) = PoolExecutor::spawn(reg.snapshot(), assembly_pool_budget(1));
        executor.submit(job(901, "$/kode/test/echo", PoolLane::Background));
        let outcome = recv_outcome(&rx);
        assert_eq!(outcome.id, RequestId::Number(901));
        assert!(
            matches!(outcome.status, JobStatus::Done(_)),
            "单核装配预算下后台 job 必须真实执行: {outcome:?}"
        );
        drop(executor);
    }

    /// KODE-RESP-005 acceptance arm 2 (pool level): a background queued job that can never be admitted while draining
    /// is honestly cancelled (-32800) and shutdown returns bounded -- before the fix, join hung forever.
    /// Built directly from the degenerate budget from_total(1): the assembly floor already guards the production path; here we pin
    /// the safety-net semantics (exit never wedges under any budget combination).
    #[test]
    fn shutdown_cancels_unschedulable_background_queue() {
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(1));
        executor.submit(job(911, "$/kode/test/echo", PoolLane::Background));
        executor.submit(job(912, "$/kode/test/echo", PoolLane::Background));
        let started = std::time::Instant::now();
        executor.shutdown();
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "shutdown 必须有界返回(实测 {elapsed:?})"
        );
        let mut cancelled = 0;
        for _ in 0..2 {
            let outcome = recv_outcome(&rx);
            assert!(
                matches!(outcome.status, JobStatus::Cancelled),
                "不可调度排队 job 应取消回执: {outcome:?}"
            );
            cancelled += 1;
        }
        assert_eq!(cancelled, 2);
        assert_eq!(stats_of(&executor).jobs_cancelled, 2);
    }
}
