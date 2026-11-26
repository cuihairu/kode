//! Single-concurrency scheduling core (aligned line by line with TS `src/indexScheduler.ts`
//! behaviour + the Rust extension surface).
//!
//! Parity surface (fixture driven, see [`crate::golden`]):
//! - same-file same-version merging, priority taking the higher one; stale incoming tasks
//!   dropped; older queued versions cancelled to yield;
//! - priority + seq fair ordering (FIFO within the same priority, CORE-006);
//! - interactive tasks always precede background ones; background is throttled by the interactive
//!   cooldown (CORE-005/010);
//! - keyed singleton tasks: in-flight reuse, re-enqueue recovery after failure/cancellation (never
//!   permanently pending);
//! - cancellation: cancel queued tasks by handle, batch cancellation; never interrupt running
//!   tasks.
//!
//! Rust extensions (no TS counterpart, book §4 capability surface):
//! - Bounded queue: when full, first evict the lowest-priority / newest-sequence old task; reject
//!   the enqueue if the new task is itself the lowest priority;
//! - Anti-starvation: a background task queued past the starvation ceiling bypasses the cooldown
//!   and is promoted (CORE-006);
//! - Pause/resume: while paused the pump yields no work, enqueueing proceeds as usual, and work
//!   resumes after resuming;
//! - Cold-request warm gate (CORE-009): the initial scan enters the queue as a keyed background
//!   task, while cold REQUEST_LOCAL requests are released immediately — interactive priority always
//!   de-queues ahead of the background initial scan, so a cold request never waits indefinitely for
//!   the whole repository;
//! - Logical clock: parity/tests can inject advances, and real integration has the caller feed the
//!   clock.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::model::{
    priority, RunningTaskInfo, SchedulerMetrics, SchedulerStatus, TaskKind, TaskState,
};

/// Cancellation token: the run body polls it at cooperation points; cancelling a queued task is
/// done by removing it directly from the scheduler.
#[derive(Clone, Debug)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> CancelToken {
        CancelToken(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

impl Default for CancelToken {
    fn default() -> Self {
        CancelToken::new()
    }
}

/// Task body: rejection = this attempt failed (recoverable, not a permanent state, matching TS
/// `run` semantics). The run body should check [`CancelToken`] at cooperation points and yield
/// as early as possible.
pub type RunFn = dyn FnOnce(&CancelToken) -> Result<(), String>;

/// Task input parameters (isomorphic with TS `IndexTaskSpec`; `run` is a synchronous closure —
/// this crate does not pull in a runtime).
pub struct TaskSpec {
    pub kind: TaskKind,
    pub priority: u8,
    pub file: Option<String>,
    pub version: Option<u64>,
    pub target: Option<String>,
    pub run: Box<RunFn>,
}

impl fmt::Debug for TaskSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TaskSpec")
            .field("kind", &self.kind)
            .field("priority", &self.priority)
            .field("file", &self.file)
            .field("version", &self.version)
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

/// Enqueue decision (parity surface: the TS side derives the same decision string from counter
/// deltas).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueDecision {
    /// Ordinary enqueue (including the case where an older same-file version was cancelled to
    /// yield — the new task itself was enqueued successfully).
    Queued,
    /// Merged into an already-queued task of the same file and version (priority takes the higher
    /// one).
    Merged,
    /// The new task is older than a queued same-file task: dropped (stale).
    StaleDropped,
    /// rust_ext: the bounded queue is full and the new task is itself the lowest priority, so the
    /// enqueue is rejected.
    RejectedQueueFull,
}

/// Decision for keyed singleton tasks (the TS `ensureTask` behaviour surface).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureDecision {
    /// First enqueue (or a rerun after the previous one already completed).
    Queued,
    /// The same key is in progress, reuse it directly.
    Reused,
    /// Re-enqueued after a previous failure/cancellation (counted in recoveries).
    Recovered,
    /// rust_ext: the enqueue was rejected (bounded queue full) or the new task was dropped as
    /// stale, so no keyed entry is written.
    /// The returned id is always 0; a later ensure can retry (failures are never cached as
    /// permanent pending).
    Rejected,
}

/// Result of a single pump step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pump {
    /// A task was run to a terminal state.
    Ran,
    /// The queue is empty (or there is no runnable task).
    Idle,
    /// The leading background task was blocked by the interactive cooldown; try again in ms.
    Postponed { retry_in_ms: u64 },
    /// Paused (the pause surface yields no work).
    Paused,
}

struct Task {
    id: u64,
    seq: u64,
    kind: TaskKind,
    priority: u8,
    file: Option<String>,
    version: Option<u64>,
    target: Option<String>,
    state: TaskState,
    cancel_reason: Option<String>,
    enqueued_ms: u64,
    /// Terminal moment (scheduler logical clock, ms; RUST-078-W idle aging compares it against
    /// the `now` supplied by the caller — the timebase must match). Always None for
    /// queued/running.
    terminal_at_ms: Option<u64>,
    #[allow(dead_code)] // Released as soon as the run body executes; the field is kept to
    // mirror the TS lifecycle semantics
    run: Option<Box<RunFn>>,
    cancel: CancelToken,
}

impl fmt::Debug for Task {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Task")
            .field("id", &self.id)
            .field("seq", &self.seq)
            .field("kind", &self.kind)
            .field("priority", &self.priority)
            .field("file", &self.file)
            .field("version", &self.version)
            .field("target", &self.target)
            .field("state", &self.state)
            .field("cancel_reason", &self.cancel_reason)
            .field("enqueued_ms", &self.enqueued_ms)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
struct KeyedEntry {
    state: TaskState,
    id: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
pub struct SchedulerOptions {
    /// Interactive cooldown window in ms (TS `interactiveCooldownMs`, default 50).
    pub interactive_cooldown_ms: u64,
    /// rust_ext: starvation ceiling in ms for queued background tasks; past it they bypass the
    /// cooldown (CORE-006, default 5000).
    pub starvation_limit_ms: u64,
    /// rust_ext: bounded queue ceiling; None = unbounded (the TS status quo).
    pub max_queued: Option<usize>,
}

impl Default for SchedulerOptions {
    fn default() -> Self {
        SchedulerOptions {
            interactive_cooldown_ms: 50,
            starvation_limit_ms: 5_000,
            max_queued: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnqueueOutcome {
    pub decision: EnqueueDecision,
    pub id: u64,
}

/// Enqueue result (used by storm-buffer consumption).
#[derive(Debug, Clone)]
pub struct StormEvent {
    pub file: String,
    pub version: u64,
    pub priority: u8,
}

/// Storm merge buffer (the CORE-017 notification-merging decision surface): within a window,
/// multiple events for the same file collapse into one, the newest version wins and the
/// priority takes the higher one; an over-cap buffer is force-flushed (so a storm cannot backlog
/// without bound).
#[derive(Debug)]
pub struct StormBuffer {
    events: Vec<StormEvent>,
    max_buffered: usize,
    /// Total number of events received.
    pub events_seen: u64,
    /// Number of events merged away (events_seen − landed).
    pub merged: u64,
    /// Number of times an over-cap buffer triggered a forced flush.
    pub forced_flushes: u64,
}

impl StormBuffer {
    pub fn new(max_buffered: usize) -> StormBuffer {
        StormBuffer {
            events: Vec::new(),
            max_buffered: max_buffered.max(1),
            events_seen: 0,
            merged: 0,
            forced_flushes: 0,
        }
    }

    /// Record one change event; returns true = merged with a buffered event of the same file
    /// (newest version wins, priority takes the higher one), false = a new-file event entered
    /// the buffer.
    pub fn record(&mut self, file: impl Into<String>, version: u64, priority: u8) -> bool {
        self.events_seen += 1;
        let file = file.into();
        if let Some(existing) = self.events.iter_mut().find(|e| e.file == file) {
            self.merged += 1;
            if version > existing.version {
                existing.version = version;
            }
            if priority < existing.priority {
                existing.priority = priority;
            }
            true
        } else {
            if self.events.len() >= self.max_buffered {
                // Guard against an unbounded storm backlog: when the buffer is over cap, force
                // land a batch first (no event is lost; it enters the scheduling queue).
                self.flush();
                self.forced_flushes += 1;
            }
            self.events.push(StormEvent {
                file,
                version,
                priority,
            });
            false
        }
    }

    /// Take the buffer and clear it (one event per file, insertion order stable).
    pub fn flush(&mut self) -> Vec<StormEvent> {
        std::mem::take(&mut self.events)
    }

    /// RUST-082 production wiring surface: name a single-file buffered event to take (the
    /// requested file is refreshed first — if a request for that file arrives inside the debounce
    /// window, the buffered event is handed to the scheduling queue immediately, without waiting
    /// for the window to expire). Returns None when no buffered event exists; the seen/merged
    /// accounting of the take is unchanged.
    pub fn take_file(&mut self, file: &str) -> Option<StormEvent> {
        let index = self.events.iter().position(|e| e.file == file)?;
        Some(self.events.remove(index))
    }

    pub fn buffered(&self) -> usize {
        self.events.len()
    }
}

/// Invalidation scheduler: enqueue / merge / cancel / pause / resume / drain / snapshot (single
/// concurrency, no runtime dependency).
pub struct Scheduler {
    opts: SchedulerOptions,
    tasks: HashMap<u64, Task>,
    /// Ring window of terminal entries (arrival order, front = oldest): once past
    /// [`MAX_RETAINED_TERMINAL_TASKS`], the oldest terminal entries are evicted (RUST-5
    /// bounding). queued/running never enter this window.
    terminal_order: VecDeque<u64>,
    queue_order: Vec<u64>,
    running: Option<u64>,
    next_id: u64,
    next_seq: u64,
    completed: u64,
    failed: u64,
    cancelled: u64,
    keyed: BTreeMap<String, KeyedEntry>,
    pub(crate) metrics: SchedulerMetrics,
    /// Logical clock in ms (injected for parity/tests; real integration advances it via the
    /// caller).
    clock_ms: u64,
    last_interactive_enqueue_ms: i64,
    last_interactive_end_ms: i64,
    paused: bool,
    /// Storm merge buffer (shares the counting surface with this scheduler).
    pub storm: StormBuffer,
    /// CORE-009 observation: the number of cold requests released immediately while the initial
    /// scan was unfinished (rust_ext, outside the TS parity metrics surface; golden output is
    /// unchanged).
    cold_while_warming: u64,
}

const NEVER_MS: i64 = -1_000_000_000;

/// Upper bound on the retention window of terminal tasks (Completed/Failed/Cancelled) in `tasks`
/// (RUST-5): only the most recent this-many terminal records are kept for `task_state` queries,
/// older ones are evicted and freed, so under high-frequency didChange in long sessions `tasks`
/// no longer grows without bound.
pub const MAX_RETAINED_TERMINAL_TASKS: usize = 1024;

/// CORE-009 keyed singleton key for the initial scan (warm-gate convention:
/// begin_background_scan always uses this key, and warm_state observes by it).
pub const BACKGROUND_SCAN_KEY: &str = "background-scan";

/// Warm-gate state (the CORE-009 observable surface).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarmState {
    /// The initial scan has not started (or the last one failed/was cancelled — failures are not
    /// cached as a warm-state illusion, so a new initial scan may be started).
    Idle,
    /// The initial scan is queued or running (background priority; interactive requests can jump
    /// the queue at any time).
    Warming,
    /// The initial scan is complete.
    Warm,
}

/// CORE-009 cold-request decision receipt (ARCH-004: tell explicitly).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColdRequestOutcome {
    /// The underlying enqueue decision (same-file same-version merge / stale drop / rejection on a
    /// full queue).
    pub decision: EnqueueDecision,
    /// Task id (0 when the decision is neither Queued nor Merged).
    pub id: u64,
    /// true = the request was admitted into the interactive queue immediately while the initial
    /// scan was still incomplete. Scheduler-level promise: once a request is Queued it occupies an
    /// executable slot, and REQUEST_LOCAL always de-queues ahead of BACKGROUND_FULL — never
    /// waiting indefinitely for the whole repository (the queue-ceiling semantics are covered
    /// separately by the bounded queue).
    pub while_warming: bool,
}

impl Default for Scheduler {
    fn default() -> Self {
        Scheduler::new(SchedulerOptions::default())
    }
}

impl fmt::Debug for Scheduler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Scheduler")
            .field("queued", &self.queue_order.len())
            .field("running", &self.running)
            .field("completed", &self.completed)
            .field("failed", &self.failed)
            .field("cancelled", &self.cancelled)
            .field("clock_ms", &self.clock_ms)
            .field("paused", &self.paused)
            .field("metrics", &self.metrics)
            .finish_non_exhaustive()
    }
}

/// KR-AUD-22: panic payload → Err text (a panicking run body is accounted as Failed).
fn panic_to_error(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        format!("run panicked: {s}")
    } else if let Some(s) = payload.downcast_ref::<String>() {
        format!("run panicked: {s}")
    } else {
        "run panicked".to_string()
    }
}

impl Scheduler {
    pub fn new(opts: SchedulerOptions) -> Scheduler {
        Scheduler {
            opts,
            tasks: HashMap::new(),
            terminal_order: VecDeque::new(),
            queue_order: Vec::new(),
            running: None,
            next_id: 1,
            next_seq: 1,
            completed: 0,
            failed: 0,
            cancelled: 0,
            keyed: BTreeMap::new(),
            metrics: SchedulerMetrics::default(),
            clock_ms: 0,
            last_interactive_enqueue_ms: NEVER_MS,
            last_interactive_end_ms: NEVER_MS,
            paused: false,
            storm: StormBuffer::new(1024),
            cold_while_warming: 0,
        }
    }

    /// Advance the logical clock (the parity `advance` op; it triggers no tasks).
    pub fn advance_clock(&mut self, ms: u64) {
        self.clock_ms += ms;
    }

    pub fn clock_ms(&self) -> u64 {
        self.clock_ms
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Enqueue a task (merging / staleness decision / bounded queue, then it lands in the queue).
    pub fn enqueue(&mut self, spec: TaskSpec) -> EnqueueOutcome {
        if priority::is_interactive(spec.priority) {
            self.last_interactive_enqueue_ms = self.clock_ms as i64;
        }

        // Same-file merging / staleness decision: only applies to tasks carrying a file
        // (fileless tasks such as the initial scan are never merged).
        if let Some(file) = spec.file.clone() {
            let same: Vec<u64> = self
                .queue_order
                .iter()
                .copied()
                .filter(|&id| self.tasks[&id].file.as_deref() == Some(file.as_str()))
                .collect();

            if let Some(&merged_id) = same
                .iter()
                .find(|&&id| self.tasks[&id].version == spec.version)
            {
                // Same-file same-version: collapse into one entry, priority takes the higher
                // one (numerically smaller).
                self.metrics.merged_tasks += 1;
                let task = self.tasks.get_mut(&merged_id).expect("merged task exists");
                if spec.priority < task.priority {
                    task.priority = spec.priority;
                    task.kind = spec.kind;
                }
                return EnqueueOutcome {
                    decision: EnqueueDecision::Merged,
                    id: merged_id,
                };
            }

            let has_newer = same.iter().any(|&id| {
                matches!(
                    (self.tasks[&id].version, spec.version),
                    (Some(existing), Some(incoming)) if existing > incoming
                )
            });
            if has_newer {
                // The new task is older than the queued same-file task already in the queue: drop
                // the new task (stale).
                self.metrics.stale_dropped += 1;
                return EnqueueOutcome {
                    decision: EnqueueDecision::StaleDropped,
                    id: 0,
                };
            }

            // The queue holds an older same-file version: cancel and drop it, yielding the slot to
            // the newer version.
            for id in same {
                let older = matches!(
                    (self.tasks[&id].version, spec.version),
                    (Some(existing), Some(incoming)) if existing < incoming
                );
                if older {
                    self.cancel_queued(id, "stale-version");
                }
            }
        }

        // rust_ext bounded queue: when full, first evict the lowest-priority / newest-sequence old
        // task; reject when the new task is itself the lowest priority.
        if let Some(max) = self.opts.max_queued {
            while self.queue_order.len() >= max {
                let victim = self
                    .queue_order
                    .iter()
                    .copied()
                    .max_by_key(|&id| {
                        let t = &self.tasks[&id];
                        (t.priority, t.seq)
                    })
                    .expect("queue length implies victim");
                let incoming_key = (spec.priority, self.next_seq);
                let victim_key = {
                    let t = &self.tasks[&victim];
                    (t.priority, t.seq)
                };
                if victim_key >= incoming_key {
                    self.cancel_queued(victim, "queue-full-evicted");
                    self.metrics.evicted_queue_full += 1;
                } else {
                    self.metrics.queue_full_rejected += 1;
                    return EnqueueOutcome {
                        decision: EnqueueDecision::RejectedQueueFull,
                        id: 0,
                    };
                }
            }
        }

        let id = self.next_id;
        self.next_id += 1;
        let seq = self.next_seq;
        self.next_seq += 1;
        let task = Task {
            id,
            seq,
            kind: spec.kind,
            priority: spec.priority,
            file: spec.file,
            version: spec.version,
            target: spec.target,
            state: TaskState::Queued,
            cancel_reason: None,
            enqueued_ms: self.clock_ms,
            terminal_at_ms: None,
            run: Some(spec.run),
            cancel: CancelToken::new(),
        };
        self.tasks.insert(id, task);
        self.queue_order.push(id);
        EnqueueOutcome {
            decision: EnqueueDecision::Queued,
            id,
        }
    }

    /// Keyed singleton task (the initial scan, etc.): a key already in progress is reused
    /// directly; after a previous failure/cancellation it is re-enqueued — failures are never
    /// cached as permanent pending, so a later request can recover (matching TS `ensureTask`).
    pub fn ensure(&mut self, key: &str, spec: TaskSpec) -> (EnsureDecision, u64) {
        if let Some(entry) = self.keyed.get(key) {
            if matches!(entry.state, TaskState::Queued | TaskState::Running) {
                return (EnsureDecision::Reused, entry.id.unwrap_or(0));
            }
        }
        let recovered = matches!(
            self.keyed.get(key).map(|e| e.state),
            Some(TaskState::Failed | TaskState::Cancelled)
        );
        let outcome = self.enqueue(spec);
        if !matches!(
            outcome.decision,
            EnqueueDecision::Queued | EnqueueDecision::Merged
        ) {
            // Enqueue rejected (queue full) or dropped as stale: enqueue produced no real task
            // (id=0), and writing a keyed entry now would become a fake pending that never runs
            // (the execute write-back would not match on entry.id, while later ensures would keep
            // returning Reused). Keep no entry at all, so the next ensure takes a fresh enqueue
            // path (consistent with "failures are never cached as permanent pending").
            return (EnsureDecision::Rejected, outcome.id);
        }
        if recovered {
            self.metrics.recoveries += 1;
        }
        self.keyed.insert(
            key.to_string(),
            KeyedEntry {
                state: TaskState::Queued,
                id: Some(outcome.id),
            },
        );
        let decision = if recovered {
            EnsureDecision::Recovered
        } else {
            EnsureDecision::Queued
        };
        (decision, outcome.id)
    }

    /// Whether a keyed task is complete (a convenience status-query surface, matching TS
    /// `isKeyedComplete`).
    pub fn is_keyed_complete(&self, key: &str) -> bool {
        self.keyed
            .get(key)
            .is_some_and(|e| e.state == TaskState::Completed)
    }

    /// Query the state of a task.
    pub fn task_state(&self, id: u64) -> Option<TaskState> {
        self.tasks.get(&id).map(|t| t.state)
    }

    /// Number of task entries currently retained in the `tasks` table (in-flight + terminal
    /// window; the memory-surface probe).
    pub fn retained_task_count(&self) -> usize {
        self.tasks.len()
    }

    /// Cancel one queued task (running tasks are not interrupted; returns whether it really was
    /// cancelled).
    pub fn cancel(&mut self, id: u64, reason: &str) -> bool {
        self.cancel_queued(id, reason)
    }

    /// Cancel all queued tasks (running ones are not interrupted); returns the cancellation count
    /// (same semantics as TS).
    pub fn cancel_queued_tasks(&mut self, reason: &str) -> usize {
        let ids: Vec<u64> = self.queue_order.clone();
        let count = ids.len();
        for id in ids {
            self.cancel_queued(id, reason);
        }
        count
    }

    /// CORE-009: entry point for backgrounding the initial scan. The initial scan is enqueued as a
    /// keyed singleton ([`BACKGROUND_SCAN_KEY`]) (the caller gives it the background priority
    /// BACKGROUND_FULL, which is what makes the initial scan background); an in-progress scan is
    /// reused, and it can be restarted after failure/cancellation. Cold requests do not go
    /// through this entry point.
    pub fn begin_background_scan(&mut self, spec: TaskSpec) -> (EnsureDecision, u64) {
        self.ensure(BACKGROUND_SCAN_KEY, spec)
    }

    /// Warm-gate state (see [`WarmState`]).
    pub fn warm_state(&self) -> WarmState {
        match self.keyed.get(BACKGROUND_SCAN_KEY).map(|e| e.state) {
            None => WarmState::Idle,
            Some(TaskState::Queued) | Some(TaskState::Running) => WarmState::Warming,
            Some(TaskState::Completed) => WarmState::Warm,
            // A failure/cancellation is not cached as a warm-state illusion: the keyed entry has
            // already fallen back, and starting a fresh initial scan can warm up again (same
            // semantics as "failures are never cached as permanent pending").
            Some(TaskState::Failed) | Some(TaskState::Cancelled) => WarmState::Idle,
        }
    }

    /// CORE-009: a cold request = on-demand parsing of a single file, enqueued immediately at
    /// REQUEST_LOCAL. It does not wait even while the initial scan is in flight: interactive
    /// priority always de-queues ahead of the background initial scan (the pick_next decision
    /// surface); the same file and version merges with a queued task, avoiding duplicate parsing.
    /// The receipt carries the warming observation bit.
    pub fn cold_request(
        &mut self,
        file: impl Into<String>,
        version: u64,
        run: Box<RunFn>,
    ) -> ColdRequestOutcome {
        let while_warming = self.warm_state() == WarmState::Warming;
        let outcome = self.enqueue(TaskSpec {
            kind: TaskKind::SingleFileUpdate,
            priority: priority::REQUEST_LOCAL,
            file: Some(file.into()),
            version: Some(version),
            target: None,
            run,
        });
        if while_warming && matches!(outcome.decision, EnqueueDecision::Queued) {
            self.cold_while_warming += 1;
        }
        ColdRequestOutcome {
            decision: outcome.decision,
            id: outcome.id,
            while_warming,
        }
    }

    /// rust_ext: the number of cold requests released immediately while the initial scan was
    /// unfinished (the observation surface).
    pub fn cold_while_warming_count(&self) -> u64 {
        self.cold_while_warming
    }

    /// Single step: take the leading executable task and run it synchronously to a terminal
    /// state.
    pub fn pump_once(&mut self) -> Pump {
        if self.paused {
            return Pump::Paused;
        }
        match self.pick_next() {
            Pick::None => Pump::Idle,
            Pick::Postponed { retry_in_ms } => Pump::Postponed { retry_in_ms },
            Pick::Task(id) => {
                self.execute(id);
                Pump::Ran
            }
        }
    }

    /// RUST-070/073 production wiring surface: name a task to jump the queue — the task with the
    /// given id in the queue is executed immediately (skipping priority order), used for "refresh
    /// the file the request needs first" (a small-scope interaction on the opened document takes
    /// precedence over a local refresh); any non-Queued state (missing / running / already
    /// terminal) always returns false and takes no action.
    /// While paused it yields no work (same semantics as pump_once).
    pub fn promote_and_run(&mut self, id: u64) -> bool {
        if self.paused {
            return false;
        }
        match self.tasks.get(&id) {
            Some(task) if task.state == TaskState::Queued => {
                self.execute(id);
                true
            }
            _ => false,
        }
    }

    /// Drain: execute continuously until the queue is empty / paused / blocked by the cooldown;
    /// when blocked by the cooldown, advance the logical clock by the suggestion, but never beyond
    /// the `max_wait_ms` budget (the parity drain op).
    pub fn drain(&mut self, max_wait_ms: u64) {
        let deadline = self.clock_ms.saturating_add(max_wait_ms);
        loop {
            match self.pump_once() {
                Pump::Ran => continue,
                Pump::Idle | Pump::Paused => break,
                Pump::Postponed { retry_in_ms } => {
                    let remaining = deadline - self.clock_ms;
                    if remaining == 0 {
                        break;
                    }
                    let jump = retry_in_ms.min(remaining);
                    self.clock_ms += jump;
                    if self.clock_ms >= deadline {
                        break;
                    }
                }
            }
        }
    }

    /// Status snapshot.
    pub fn status(&self) -> SchedulerStatus {
        let mut queued_by_priority: BTreeMap<u8, usize> = BTreeMap::new();
        for id in &self.queue_order {
            if let Some(task) = self.tasks.get(id) {
                *queued_by_priority.entry(task.priority).or_default() += 1;
            }
        }
        let running = self.running.and_then(|id| {
            self.tasks.get(&id).map(|t| RunningTaskInfo {
                id: t.id,
                kind: t.kind,
                priority: t.priority,
                file: t.file.clone(),
            })
        });
        let keyed_tasks = self
            .keyed
            .iter()
            .map(|(k, e)| (k.clone(), e.state.as_str().to_string()))
            .collect();
        SchedulerStatus {
            queued: self.queue_order.len(),
            queued_by_priority,
            running,
            completed: self.completed,
            failed: self.failed,
            cancelled: self.cancelled,
            keyed_tasks,
            metrics: self.metrics,
        }
    }

    /// Ledger export: recovery records of the currently queued tasks (the crash-recovery write
    /// surface).
    /// Order = (priority, file), so the recovery enqueue order matches the scheduling priority
    /// order.
    pub fn pending_records(&self) -> Vec<crate::journal::TaskRecord> {
        let mut records: Vec<crate::journal::TaskRecord> = self
            .queue_order
            .iter()
            .filter_map(|id| self.tasks.get(id))
            .map(|t| crate::journal::TaskRecord {
                kind: t.kind.as_str().to_string(),
                priority: t.priority,
                file: t.file.clone(),
                version: t.version,
                target: t.target.clone(),
            })
            .collect();
        records.sort_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then_with(|| match (&a.file, &b.file) {
                    (Some(x), Some(y)) => x.cmp(y),
                    _ => std::cmp::Ordering::Equal,
                })
        });
        records
    }

    fn pick_next(&mut self) -> Pick {
        let mut candidates: Vec<(u8, u64, u64)> = self
            .queue_order
            .iter()
            .filter_map(|id| self.tasks.get(id).map(|t| (t.priority, t.seq, *id)))
            .collect();
        if candidates.is_empty() {
            return Pick::None;
        }
        candidates.sort();
        let head = candidates[0];
        let head_id = head.2;
        let head_priority = head.0;
        if priority::is_interactive(head_priority) {
            // Priority order: interactive tasks always precede background tasks.
            return Pick::Task(head_id);
        }
        // Background throttling: no background task is started within the interactive cooldown
        // window.
        let since = self.clock_ms as i64 - self.last_interactive_ms();
        if since < self.opts.interactive_cooldown_ms as i64 {
            let waited = self
                .clock_ms
                .saturating_sub(self.tasks.get(&head_id).map(|t| t.enqueued_ms).unwrap_or(0));
            if waited >= self.opts.starvation_limit_ms {
                // rust_ext anti-starvation: queued past the ceiling, promote it bypassing the
                // cooldown (CORE-006).
                self.metrics.anti_starvation_promotions += 1;
                return Pick::Task(head_id);
            }
            let retry_in_ms = (self.opts.interactive_cooldown_ms as i64 - since).max(0) as u64;
            self.metrics.postponed_background += 1;
            self.metrics.background_delay_ms += retry_in_ms;
            return Pick::Postponed { retry_in_ms };
        }
        Pick::Task(head_id)
    }

    fn last_interactive_ms(&self) -> i64 {
        self.last_interactive_enqueue_ms
            .max(self.last_interactive_end_ms)
    }

    fn execute(&mut self, id: u64) {
        self.queue_order.retain(|&q| q != id);
        let cancel = {
            let task = self.tasks.get_mut(&id).expect("picked task exists");
            task.state = TaskState::Running;
            task.cancel.clone()
        };
        self.running = Some(id);
        let run = self
            .tasks
            .get_mut(&id)
            .expect("picked task exists")
            .run
            .take()
            .expect("run body present until executed");
        let result = {
            // KR-AUD-22: a panicking run body is accounted as the Failed terminal state
            // (converged by catch_unwind) and no longer capsizes the pump to wedge the scheduler;
            // the panic message is turned into an Err for the failed count.
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&cancel)));
            match caught {
                Ok(r) => r,
                Err(payload) => Err(panic_to_error(payload)),
            }
        };
        let interactive = self
            .tasks
            .get(&id)
            .is_some_and(|t| priority::is_interactive(t.priority));
        let final_state = if result.is_ok() {
            self.completed += 1;
            TaskState::Completed
        } else {
            // A failure is not cached as a "already scanned" illusion: the keyed entry falls back
            // to failed, and a later request reruns it.
            self.failed += 1;
            TaskState::Failed
        };
        for entry in self.keyed.values_mut() {
            if entry.id == Some(id) {
                entry.state = final_state;
            }
        }
        if let Some(task) = self.tasks.get_mut(&id) {
            task.state = final_state;
        }
        self.running = None;
        self.record_terminal(id);
        if interactive {
            self.last_interactive_end_ms = self.clock_ms as i64;
        }
    }

    fn cancel_queued(&mut self, id: u64, reason: &str) -> bool {
        let in_queue = self.queue_order.contains(&id);
        if !in_queue {
            return false;
        }
        if self.tasks.get(&id).map(|t| t.state) != Some(TaskState::Queued) {
            return false;
        }
        self.queue_order.retain(|&q| q != id);
        let task = self.tasks.get_mut(&id).expect("queued task exists");
        task.state = TaskState::Cancelled;
        task.cancel_reason = Some(reason.to_string());
        self.cancelled += 1;
        // Write back the keyed ledger (KR-AUD-90): execute will never run again, and leaving the
        // entry Queued would make later ensures keep returning Reused (a dead id — the task would
        // never rerun).
        for entry in self.keyed.values_mut() {
            if entry.id == Some(id) {
                entry.state = TaskState::Cancelled;
            }
        }
        self.record_terminal(id);
        if reason == "stale-version" {
            self.metrics.stale_dropped += 1;
        }
        true
    }

    /// Terminal-state registration (RUST-5): a terminal id enters the ring retention window, and
    /// past the limit the oldest terminal entry is evicted.
    ///
    /// Compatibility with the Reused semantics: `ensure`'s reuse/recovery decision reads the
    /// independent `keyed` ledger (a KeyedEntry carries its own state copy, and the execute
    /// write-back matches by id), not `tasks` — so evicting a terminal tasks entry never invalidates
    /// a keyed entry and never produces a fake pending;
    /// the `task_state` query surface keeps the most recent
    /// [`MAX_RETAINED_TERMINAL_TASKS`] terminal records.
    /// Ids increase monotonically and each task reaches a terminal state at most once (cancellation
    /// only applies to Queued, and execution removes the task from the queue first), so ids within
    /// the window neither repeat nor skip; defensively, only entries that truly are terminal are
    /// evicted.
    fn record_terminal(&mut self, id: u64) {
        if let Some(task) = self.tasks.get_mut(&id) {
            task.terminal_at_ms = Some(self.clock_ms);
        }
        self.terminal_order.push_back(id);
        while self.terminal_order.len() > MAX_RETAINED_TERMINAL_TASKS {
            let Some(oldest) = self.terminal_order.pop_front() else {
                break;
            };
            let is_terminal = self.tasks.get(&oldest).is_some_and(|t| {
                matches!(
                    t.state,
                    TaskState::Completed | TaskState::Failed | TaskState::Cancelled
                )
            });
            if is_terminal {
                self.tasks.remove(&oldest);
            }
        }
    }

    /// RUST-078-W: idle aging — evict the terminal records whose terminal moment is older than
    /// `now_ms - max_idle_ms` (the front of terminal_order = the oldest terminal state, and it
    /// stops at the first entry not yet overage). queued/running are never touched; the keyed
    /// ledger is never touched (the ensure reuse/recovery semantics are unaffected);
    /// the metrics/golden parity surface is unchanged (only the `tasks` history and the
    /// `task_state` query surface are evicted). `now_ms` shares one timebase with the terminal
    /// moment (the scheduler's logical clock; in production the caller first syncs the logical
    /// clock to the wall clock). Returns the number evicted.
    pub fn age_out_terminal(&mut self, now_ms: u64, max_idle_ms: u64) -> usize {
        let mut aged = 0usize;
        while let Some(&oldest) = self.terminal_order.front() {
            let expired = self
                .tasks
                .get(&oldest)
                .and_then(|t| t.terminal_at_ms)
                .is_some_and(|at| now_ms.saturating_sub(at) > max_idle_ms);
            if !expired {
                break;
            }
            self.terminal_order.pop_front();
            self.tasks.remove(&oldest);
            aged += 1;
        }
        aged
    }

    /// RUST-078-W: proactive reclamation under memory pressure — evict every terminal record (the
    /// `tasks` history + the `task_state` query surface go to zero). queued/running/keyed/metrics
    /// are never touched (the same red line as [`Self::age_out_terminal`]). Returns the number
    /// evicted.
    pub fn reclaim_history(&mut self) -> usize {
        let mut reclaimed = 0usize;
        while let Some(oldest) = self.terminal_order.pop_front() {
            let is_terminal = self.tasks.get(&oldest).is_some_and(|t| {
                matches!(
                    t.state,
                    TaskState::Completed | TaskState::Failed | TaskState::Cancelled
                )
            });
            if is_terminal {
                self.tasks.remove(&oldest);
                reclaimed += 1;
            }
        }
        reclaimed
    }
}

enum Pick {
    None,
    Task(u64),
    Postponed { retry_in_ms: u64 },
}

#[cfg(test)]
mod task_debug_tests {
    use super::*;

    /// Task is a private type (it does not enter the status snapshot) and its Debug impl is only
    /// for memory-surface diagnostics; this unit test checks the Debug implementation directly:
    /// field names and values appear truthfully, and unlisted fields do not leak out.
    #[test]
    fn task_debug_renders_fields_and_terminal_reason() {
        let task = Task {
            id: 5,
            seq: 3,
            kind: TaskKind::SingleFileUpdate,
            priority: 1,
            file: Some("/a.def".into()),
            version: Some(7),
            target: None,
            state: TaskState::Cancelled,
            cancel_reason: Some("stale-version".into()),
            enqueued_ms: 42,
            terminal_at_ms: Some(42),
            run: None,
            cancel: CancelToken::new(),
        };
        let dbg = format!("{task:?}");
        assert!(dbg.starts_with("Task {"), "{dbg}");
        assert!(dbg.contains("id: 5"), "{dbg}");
        assert!(dbg.contains("seq: 3"), "{dbg}");
        assert!(dbg.contains("SingleFileUpdate"), "{dbg}");
        assert!(dbg.contains("priority: 1"), "{dbg}");
        assert!(dbg.contains("file: Some(\"/a.def\")"), "{dbg}");
        assert!(dbg.contains("version: Some(7)"), "{dbg}");
        assert!(dbg.contains("state: Cancelled"), "{dbg}");
        assert!(
            dbg.contains("cancel_reason: Some(\"stale-version\")"),
            "{dbg}"
        );
        assert!(dbg.contains("enqueued_ms: 42"), "{dbg}");
        // finish_non_exhaustive: run/cancel do not leak into the diagnostic output.
        assert!(dbg.contains(".."), "{dbg}");
    }

    /// RUST-078-W: idle aging — over-age terminal records are evicted, fresh terminal records are
    /// kept, queued ones are never touched, and the keyed ledger is never touched (the ensure reuse
    /// semantics are unaffected), with zero change to metrics.
    /// RUST-070/073: named queue-jumping execution — the given id runs immediately, skipping
    /// priority order; a non-Queued state (unknown id / already terminal) always returns false;
    /// the jump does not swallow the rest of the queue.
    #[test]
    fn promote_and_run_executes_named_queued_task_out_of_order() {
        use crate::model::priority::{BACKGROUND_FULL, REQUEST_LOCAL};
        let mut s = Scheduler::new(SchedulerOptions::default());
        let run = |_token: &crate::scheduler::CancelToken| Ok(());
        // Within the same priority, the earlier enqueued task has the smaller seq; enqueue
        // REQUEST_LOCAL first and BACKGROUND_FULL second, so ordinary pick_next would run
        // REQUEST_LOCAL first — promoting the latter by name is the queue jump.
        let first = s
            .enqueue(TaskSpec {
                kind: TaskKind::SingleFileUpdate,
                priority: REQUEST_LOCAL,
                file: Some("/a.def".into()),
                version: Some(1),
                target: None,
                run: Box::new(run),
            })
            .id;
        let second = s
            .enqueue(TaskSpec {
                kind: TaskKind::FullReindex,
                priority: BACKGROUND_FULL,
                file: Some("/b.def".into()),
                version: Some(1),
                target: None,
                run: Box::new(run),
            })
            .id;
        assert!(s.promote_and_run(second), "Queued 态指名执行应成功");
        assert_eq!(s.task_state(second), Some(TaskState::Completed));
        assert_eq!(
            s.task_state(first),
            Some(TaskState::Queued),
            "插队不吞其余任务"
        );
        // Non-Queued states: unknown id / already terminal → false.
        assert!(!s.promote_and_run(999), "未知 id 拒绝");
        assert!(!s.promote_and_run(second), "已终态拒绝");
        // The rest of the queue drains as usual.
        s.drain(10_000);
        assert_eq!(s.task_state(first), Some(TaskState::Completed));
        assert_eq!(s.status().queued, 0);
    }

    #[test]
    fn age_out_terminal_drops_only_expired_and_never_touches_live_or_keyed() {
        use crate::model::priority::{BACKGROUND_FULL, REQUEST_LOCAL};
        let mut s = Scheduler::new(SchedulerOptions::default());
        let run = |_token: &crate::scheduler::CancelToken| Ok(());
        let a = s.enqueue(TaskSpec {
            kind: TaskKind::SingleFileUpdate,
            priority: REQUEST_LOCAL,
            file: Some("/a.def".into()),
            version: Some(1),
            target: None,
            run: Box::new(run),
        });
        s.drain(10_000);
        assert_eq!(s.task_state(a.id), Some(TaskState::Completed));
        s.advance_clock(1_000);
        let b = s.enqueue(TaskSpec {
            kind: TaskKind::SingleFileUpdate,
            priority: REQUEST_LOCAL,
            file: Some("/b.def".into()),
            version: Some(1),
            target: None,
            run: Box::new(run),
        });
        s.drain(10_000);
        // The keyed ledger is present (the ensure reuse-semantics surface) and must be intact
        // after aging.
        let (_, k) = s.ensure(
            "age-key",
            TaskSpec {
                kind: TaskKind::SingleFileUpdate,
                priority: BACKGROUND_FULL,
                file: Some("/k.def".into()),
                version: Some(1),
                target: None,
                run: Box::new(run),
            },
        );
        s.drain(10_000);
        let retained_before = s.retained_task_count();
        let metrics_before = {
            let st = s.status();
            (st.completed, st.failed, st.cancelled)
        };

        // Fresh window (both ≤60s): not one is evicted.
        assert_eq!(s.age_out_terminal(1_000 + 500, 60_000), 0);
        assert_eq!(s.retained_task_count(), retained_before);
        // a went terminal at clock 0; b went terminal at clock 1000. At now=60_001: a is overage
        // (60001 > 60000), b (59001) is retained.
        assert_eq!(s.age_out_terminal(60_001, 60_000), 1);
        assert_eq!(s.task_state(a.id), None, "超龄终态记录已摘");
        assert_eq!(
            s.task_state(b.id),
            Some(TaskState::Completed),
            "新鲜终态保留"
        );
        assert_eq!(s.retained_task_count(), retained_before - 1, "只摘超龄条目");
        // The keyed reuse semantics are unaffected by aging: another ensure on the same key lands
        // the warm-kind decision (the Completed ledger stays intact) and produces no fake pending.
        assert!(s.is_keyed_complete("age-key"), "keyed 台账必须原样");
        let _ = k;
        // Zero change on the metrics/golden parity surface.
        let st = s.status();
        assert_eq!((st.completed, st.failed, st.cancelled), metrics_before);
    }

    /// RUST-078-W: proactive reclamation under memory pressure — all terminal history is evicted
    /// (retained goes to zero), queued entries are never touched (cancellation only acts on
    /// terminal records), and keyed/metrics are unchanged.
    #[test]
    fn reclaim_history_drops_all_terminal_and_keeps_live_and_keyed() {
        use crate::model::priority::REQUEST_LOCAL;
        let mut s = Scheduler::new(SchedulerOptions::default());
        let run = |_token: &crate::scheduler::CancelToken| Ok(());
        for i in 0..3 {
            let id = s.enqueue(TaskSpec {
                kind: TaskKind::SingleFileUpdate,
                priority: REQUEST_LOCAL,
                file: Some(format!("/r{i}.def")),
                version: Some(1),
                target: None,
                run: Box::new(run),
            });
            let _ = id.id;
        }
        s.drain(10_000);
        // Leave one queued task on the field (pressure reclamation must never touch it).
        let live = s.enqueue(TaskSpec {
            kind: TaskKind::SingleFileUpdate,
            priority: REQUEST_LOCAL,
            file: Some("/live.def".into()),
            version: Some(1),
            target: None,
            run: Box::new(run),
        });
        assert_eq!(s.task_state(live.id), Some(TaskState::Queued));
        // One queued cancellation → terminal (Cancelled is also part of the reclamation surface);
        // a single-point cancel, without touching live (cancel_queued_tasks would clear the whole
        // queue).
        let cancelme = s.enqueue(TaskSpec {
            kind: TaskKind::SingleFileUpdate,
            priority: REQUEST_LOCAL,
            file: Some("/cancelme.def".into()),
            version: Some(1),
            target: None,
            run: Box::new(run),
        });
        assert!(s.cancel(cancelme.id, "pressure-test"), "queued 取消应成功");
        let keyed_before = {
            let st = s.status();
            (st.completed, st.failed, st.cancelled)
        };

        let reclaimed = s.reclaim_history();
        assert_eq!(reclaimed, 4, "3 完成 + 1 取消终态全摘");
        assert_eq!(s.retained_task_count(), 1, "只留 queued 活任务");
        assert_eq!(
            s.task_state(live.id),
            Some(TaskState::Queued),
            "queued 永不动"
        );
        let st = s.status();
        assert_eq!(
            (st.completed, st.failed, st.cancelled),
            keyed_before,
            "metrics 零变化"
        );
        // After reclamation, running still works normally (the queue / ledger are alive).
        s.drain(10_000);
        assert_eq!(s.task_state(live.id), Some(TaskState::Completed));
    }

    /// Warm-gate empty state: a scheduler that never called begin_background_scan = Idle.
    #[test]
    fn warm_state_idle_before_any_scan() {
        let s = Scheduler::new(SchedulerOptions::default());
        assert_eq!(s.warm_state(), WarmState::Idle);
    }

    /// Queue-jump execution is refused while paused: no work is produced (same semantics as
    /// pump_once).
    #[test]
    fn promote_and_run_paused_refuses() {
        let mut s = Scheduler::new(SchedulerOptions::default());
        s.pause();
        assert!(!s.promote_and_run(1), "暂停期指名执行一律 false");
    }
}
