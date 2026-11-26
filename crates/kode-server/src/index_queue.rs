//! RUST-070/071/073: index refresh queue -- the hover-corpus ingest assembly line (production wiring).
//! RUST-082: didChange debounce storm buffer (time-window coalescing + max latency).
//!
//! CORE-005 "local dependency refresh yields to direct semantic queries": the hover-corpus ingest of didOpen/didChange/didClose no longer runs inline on the stdio pump thread
//! (parsing a mirror flood file by file would push interactive frames behind it); instead it enters a kode-scheduler dispatch queue (DEPENDENCY_UPDATE),
//! driven by main-loop idle slices plus the request entry's "freshen the needed files first". CORE-008: same file same
//! version merges and an older version yields (cancel the old, queue the new); one input storm converges to at most one pending task;
//! CORE-006: bounded queue (over-limit honestly counts a rejection, never silently accumulates). The executor takes "the truth at execution time":
//! overlay first (open document), falls back to disk, and a failed disk read = a true eviction (VFS-012
//! revision, same stance) -- the open/change/close context at enqueue time is not carried, so tasks are idempotent and mergeable.
//!
//!
//! RUST-082 (CORE-017): didChange first enters the StormBuffer time window (same-file merge / newest version wins);
//! only when the window expires (<= max latency) or the buffer overflows is the whole batch handed to the dispatch queue
//! -- continuous typing no longer enqueues and executes per version; didOpen/didClose bypass the window (open = an immediate interactive
//! need, close = a state transition), and the request entry hands the buffered events for that file over immediately (take_file), keeping
//! "an open-document request is immediately fresh". delete/create semantics = the truth at execution time (absent on disk -> evict;
//! present on disk -> re-read), which merges naturally; there is no separate watch face (honest boundary, no pretense that fs-watch is on duty).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use kode_scheduler::model::priority::DEPENDENCY_UPDATE;
use kode_scheduler::scheduler::RunFn;
use kode_scheduler::{
    EnqueueDecision, Scheduler, SchedulerOptions, StormBuffer, TaskKind, TaskSpec,
};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

use kode_index::ChangeCategory;

use crate::hover::HoverEngine;

/// Bounded-queue cap (CORE-006). The corpus scale (thousands of def files) sits far below this; a rejection over the cap
/// counts into `rejectedQueueFull` (health face); never silently accumulate, never silently lose semantics -- a rejected file
/// has no index entries until its next change; an honest gap, not a pretense of completeness.
pub const INDEX_QUEUE_MAX: usize = 8192;

/// Request-entry drain budget (entries): freshen its own key + catch up FIFO at most N entries, leaving the rest to
/// idle slices -- a small corpus (tests / small repos) becomes fully ready in one request; a large-corpus request does not carry the full flood.
pub const REQUEST_DRAIN_BUDGET: usize = 16;

/// RESP-001: request-drain wall-clock cap (ms). The entry cap is kept (small corpus: fully ready in one request,
/// stance unchanged) with a wall-clock bound stacked on -- entry counts cannot bound response time, time can: on a slow disk / large file,
/// an interactive request pays at most this much on unrelated catch-up, leaving the remainder to idle slices.
pub const REQUEST_DRAIN_BUDGET_MS: u64 = 4;

/// RESP-001: idle-tick large-slice wall-clock cap (ms). Idle catch-up can push harder but stays bounded likewise
/// (the 64-entry count is kept as the upper bound).
pub const IDLE_SLICE_BUDGET_MS: u64 = 16;

/// didChange debounce time window (CORE-017 max latency): multiple versions of the same file within the window merge into one,
/// and the whole batch is handed over on window expiry -- worst-case latency = the window duration; under continuous input, at most one batch per window
/// (bounded latency, never postponed indefinitely).
pub const DID_CHANGE_DEBOUNCE_MS: u64 = 300;

/// Storm-buffer file cap: on overflow, force a batch out first (an honest latency-for-throughput bound -- under an extreme storm,
/// never accumulate, never defer latency to infinity; first get the old batch into the queue).
pub const STORM_BUFFER_MAX_FILES: usize = 512;

/// Identity key: `root:path` (a single source shared by the dedup/freshen/purge/storm-buffer faces).
pub fn identity_of(key: &DocumentKey) -> String {
    format!("{}:{}", key.root.0, key.uri.as_path())
}

/// Index-refresh observation snapshot (same source as the health face's `ingest` key).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexQueueSnapshot {
    /// Entries currently queued.
    pub queued: u64,
    /// Cumulative enqueues (yield re-enqueues count).
    pub enqueued: u64,
    /// Same-file same-version merges (not enqueued).
    pub merged: u64,
    /// Stale-version drops (the new task is older than the queued one).
    pub stale_dropped: u64,
    /// Queue-full rejections.
    pub rejected_queue_full: u64,
    /// Cumulative successful executions.
    pub executed: u64,
    /// Pending entries cleared by root purge.
    pub purged: u64,
    /// RUST-082: total events received by the storm buffer.
    pub storm_seen: u64,
    /// RUST-082: events merged away by the storm buffer.
    pub storm_merged: u64,
    /// RUST-082: files currently in the buffer.
    pub storm_buffered: u64,
    /// RUST-082: whole-batch handovers on window expiry (the max-latency accounting).
    pub storm_deadline_flushes: u64,
    /// RUST-082: forced batch-outs on buffer overflow.
    pub storm_forced_flushes: u64,
    /// RUST-120-W: ingest classed identical (fingerprint hit; the index state is untouched).
    pub ingest_identical: u64,
    /// RUST-120-W: ingest classed body-only (registered facts fully equal; the view is written nowhere and no bump).
    pub ingest_body_only: u64,
    /// RUST-120-W: ingest classed signature (re-populate the view + bump).
    pub ingest_signature: u64,
    /// RUST-120-W: eviction by execution-time truth (the file is absent on disk).
    pub ingest_removed: u64,
}

/// RUST-120-W: per-class invalidation counts (accounted by the executor at execution time; the queue holds the original,
/// the closure holds a clone; a single-threaded Rc/RefCell world, the same pattern as done_log). The fields are
/// accounted by [`record_ingest`], read via [`IndexQueue::snapshot`].
#[derive(Debug, Default)]
pub struct IngestCounts {
    identical: u64,
    body_only: u64,
    signature: u64,
    removed: u64,
}

fn record_ingest(counts: &Rc<RefCell<IngestCounts>>, change: ChangeCategory) {
    let mut c = counts.borrow_mut();
    match change {
        ChangeCategory::Identical => c.identical += 1,
        ChangeCategory::BodyOnly => c.body_only += 1,
        ChangeCategory::Signature => c.signature += 1,
    }
}

/// RESP-001: disk-fallback read function (injection point). The argument = a native path string.
pub type DiskReadFn = Rc<dyn Fn(&str) -> std::io::Result<String>>;

/// RESP-001b: cross-thread read function (owned by the read thread). Same as [`DiskReadFn`] but
/// `Arc + Send + Sync`, shared as the injection point by [`IngestReadThread::spawn`] and
/// [`IndexQueue::with_off_thread_reader`].
pub type SharedDiskReadFn = std::sync::Arc<dyn Fn(&str) -> std::io::Result<String> + Send + Sync>;

/// Production read function: a pass-through to `std::fs::read_to_string`.
fn default_disk_reader() -> DiskReadFn {
    Rc::new(|path| std::fs::read_to_string(path))
}

// ---- RESP-001b: dedicated disk-read thread ------------------------------------------------
//
// Motivation: Batch-1 (wall-clock slices) bounded the "between-tasks" pauses, but disk reads within a single task still ran on the
// protocol thread (slow disk / large file = a per-file unresponsive interval). A dedicated read thread moves "reading" entirely off the
// protocol thread (the read thread only does reader(path), production = std::fs; it does not parse -- parsing still runs inside the slice
// budget). Two beats: the task executor only "registers + posts a read task" and returns (no applying,
// no evicting); once read, the done pump **applies directly** (poll_reads verifies the execution-time truth on the same thread:
// if an overlay is open, drop the disk read [an on-disk snapshot must not wash away unsaved revisions]; otherwise apply the read
// result / evict on read failure). It does not re-enter the dispatch core's queue -- if two done items for the same identity arrive together before a slice,
// the same-file same-version Merged decision would swallow the second beat (a race observed in practice); applying
// directly is naturally FIFO order-preserving: both the old and new reads apply, and the final state = the last read; after a purge
// (purge_root/purge_key) removes the name, any done arriving afterwards is discarded (the late-revival defense, the same
// semantics as the pending removal).

/// Read-thread request (identity + native path).
struct DiskReadJob {
    identity: String,
    path: String,
}

/// Read-thread completion (identity + result; arrives in FIFO, order-preserving per identity).
struct DiskReadDone {
    identity: String,
    result: std::io::Result<String>,
}

/// Dedicated disk-read thread handle: driven exclusively by the main thread (the wanted/stash ledgers stay on one thread, lock-free);
/// the OS thread only runs `reader(path)`. Once the handle is dropped (all Senders dropped), the thread exits naturally;
/// not joined (an in-flight hung read does not block shutdown semantics -- process exit collects it).
pub(crate) struct IngestReadThread {
    job_tx: mpsc::Sender<DiskReadJob>,
    done_rx: mpsc::Receiver<DiskReadDone>,
    /// Registered demand (identity -> in-flight count): submit increments, completion decrements, purge removes the name.
    /// A done arriving with no name (count exhausted / already purged) = an unowned read, discarded.
    wanted: HashMap<String, usize>,
}

impl IngestReadThread {
    /// Spawn the read thread; the reader must be Send+Sync (owned by the thread -- the main-thread Rc injection point
    /// [`DiskReadFn`] does not fit here; tests inject slow/failing reads with Arc closures).
    fn spawn(reader: SharedDiskReadFn) -> Rc<RefCell<Self>> {
        let (job_tx, job_rx) = mpsc::channel::<DiskReadJob>();
        let (done_tx, done_rx) = mpsc::channel::<DiskReadDone>();
        std::thread::Builder::new()
            .name("kode-ingest-read".to_string())
            .spawn(move || {
                for job in job_rx.iter() {
                    let result = reader(&job.path);
                    if done_tx
                        .send(DiskReadDone {
                            identity: job.identity,
                            result,
                        })
                        .is_err()
                    {
                        // Handle side dropped: remaining reads are unowned; exit.
                        break;
                    }
                }
            })
            .expect("spawn ingest read thread");
        Rc::new(RefCell::new(Self {
            job_tx,
            done_rx,
            wanted: HashMap::new(),
        }))
    }

    /// Register demand + post a read task (count-based: duplicate posting allowed, consumed one by one in FIFO order).
    fn submit(&mut self, identity: &str, path: &str) {
        *self.wanted.entry(identity.to_string()).or_insert(0) += 1;
        let _ = self.job_tx.send(DiskReadJob {
            identity: identity.to_string(),
            path: path.to_string(),
        });
    }

    fn try_recv_done(&mut self) -> Option<DiskReadDone> {
        self.done_rx.try_recv().ok()
    }

    /// Consume the registered count on completion; no name (purged / count exhausted) = an unowned read, returns false.
    fn consume_wanted(&mut self, identity: &str) -> bool {
        match self.wanted.get_mut(identity) {
            Some(count) if *count > 0 => {
                *count -= 1;
                if *count == 0 {
                    self.wanted.remove(identity);
                }
                true
            }
            _ => false,
        }
    }

    /// Cancel: remove the name from the ledger (a done arriving afterwards = unowned, discarded).
    fn purge(&mut self, identity: &str) {
        self.wanted.remove(identity);
    }

    /// Root purge: remove the names of all registered reads under this root (identity prefix `root:`; identities whose task has settled but whose read is still
    /// in flight are not in the pending ledger; the root-level removal closes this gap -- the late-revival defense).
    fn purge_root(&mut self, root: RootId) {
        let prefix = format!("{}:", root.0);
        self.wanted
            .retain(|identity, _| !identity.starts_with(&prefix));
    }

    /// Whether this identity still has a read in flight (the read-thread extension of the stale-gap criterion).
    fn in_flight(&self, identity: &str) -> bool {
        self.wanted.contains_key(identity)
    }

    /// Whether any read is in flight (the pump slice's "queue empty but reads in flight" waiting criterion).
    fn any_in_flight(&self) -> bool {
        !self.wanted.is_empty()
    }
}

/// Index refresh queue: the kode-scheduler dispatch core + the identity ledger (pending) + the storm buffer.
pub struct IndexQueue {
    sched: Scheduler,
    /// identity -> (task id, RootId): the freshen named-key face + the root-purge face.
    pending: HashMap<String, (u64, RootId)>,
    /// Execution receipt log: after the wrapped closure completes, push the identity; the pump side reconciles and clears the ledger.
    /// Rc-shared (the closure holds a clone, the queue holds the original; a single-threaded Rc/RefCell world).
    done_log: Rc<RefCell<Vec<String>>>,
    counters: IndexQueueSnapshot,
    /// RUST-120-W: per-class invalidation counts (accounted at closure execution time, merged into snapshot).
    ingest_counts: Rc<RefCell<IngestCounts>>,
    /// RUST-082: the didChange storm buffer (time-window coalescing; the core record's internal overflow forced-flush
    /// silently drops its return value, so the wrapper always pre-drains before record and never triggers it).
    storm: StormBuffer,
    /// identity -> RootId: used to rebuild DocumentKey when handing over buffered events.
    storm_roots: HashMap<String, RootId>,
    /// Window expiry instant (set when the first event lands in the window; reset once the buffer empties).
    storm_deadline: Option<Instant>,
    /// Engine handle (builds the execution-time-truth executor at enqueue time).
    store: Rc<RefCell<kode_vfs::DocumentStore>>,
    hover: Rc<RefCell<HoverEngine>>,
    /// RESP-001: disk-fallback read function (a test injection point simulating slow disk / large files).
    disk_reader: DiskReadFn,
    /// RESP-001b: the dedicated disk-read thread (None = inline disk reads, the existing semantics / existing test stance).
    reads: Option<Rc<RefCell<IngestReadThread>>>,
}

impl std::fmt::Debug for IndexQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexQueue")
            .field("snapshot", &self.snapshot())
            .field("pending", &self.pending.len())
            .field("off_thread_reads", &self.reads.is_some())
            .finish()
    }
}

impl IndexQueue {
    pub fn new(
        store: Rc<RefCell<kode_vfs::DocumentStore>>,
        hover: Rc<RefCell<HoverEngine>>,
    ) -> IndexQueue {
        IndexQueue::with_disk_reader(store, hover, default_disk_reader())
    }

    /// RESP-001b: same as [`IndexQueue::new`], but disk-fallback reads go through the dedicated read thread (the
    /// protocol thread never reads the disk inline); the reader must be Send+Sync (owned by the read thread; tests inject
    /// slow / failing / blocking reads).
    pub fn with_off_thread_reader(
        store: Rc<RefCell<kode_vfs::DocumentStore>>,
        hover: Rc<RefCell<HoverEngine>>,
        reader: SharedDiskReadFn,
    ) -> IndexQueue {
        let mut queue = IndexQueue::with_disk_reader(store, hover, default_disk_reader());
        queue.reads = Some(IngestReadThread::spawn(reader));
        queue
    }

    /// RESP-001: same as [`IndexQueue::new`], but disk-fallback reads go through the injection point `disk_reader`
    /// (production = `std::fs::read_to_string`; tests inject slow reads to simulate a slow disk / large files).
    pub fn with_disk_reader(
        store: Rc<RefCell<kode_vfs::DocumentStore>>,
        hover: Rc<RefCell<HoverEngine>>,
        disk_reader: DiskReadFn,
    ) -> IndexQueue {
        IndexQueue {
            sched: Scheduler::new(SchedulerOptions {
                // CORE-006: bounded queue. Interactive cooldown / starvation promotion belong to >=BACKGROUND_FULL
                // semantics; this queue is always DEPENDENCY_UPDATE (is_interactive=true),
                // so cooldown does not apply (honestly registered, no pretense that an anti-starvation mechanism is on duty).
                max_queued: Some(INDEX_QUEUE_MAX),
                ..SchedulerOptions::default()
            }),
            pending: HashMap::new(),
            done_log: Rc::new(RefCell::new(Vec::new())),
            counters: IndexQueueSnapshot::default(),
            ingest_counts: Rc::new(RefCell::new(IngestCounts::default())),
            storm: StormBuffer::new(STORM_BUFFER_MAX_FILES),
            storm_roots: HashMap::new(),
            storm_deadline: None,
            store,
            hover,
            disk_reader,
            reads: None,
        }
    }

    /// didOpen: enqueue the corpus ingest immediately (open = an immediate interactive need, bypassing the storm window).
    /// Same-file same-version already queued merges; a new version yields (the old task is cancelled by the dispatch core and the ledger points at
    /// the new id); stale versions drop; queue-full rejects honestly.
    pub fn request_open(&mut self, key: &DocumentKey, version: u64) -> EnqueueDecision {
        self.enqueue_refresh(key, Some(version))
    }

    /// RUST-125: an open event touches the parse cache (one round of eviction reprieve) -- the index-side fulfillment of "the currently
    /// open file first". The edit face touches it naturally via didChange->update; an open file untouched for a long time
    /// gets evicted after its reprieve = an honest cold eviction (a reprieve is not a hard pin; beyond budget it does not stay resident unboundedly).
    pub fn note_buffer_open(&self, key: &DocumentKey) {
        self.hover.borrow_mut().index.note_buffer_activity(key);
    }

    /// didClose: enqueue a refresh (version=None and Some are different keys, so after close it must always yield and re-
    /// enqueue, never merge; the execution-time truth decides between re-reading the disk and evicting).
    pub fn request_close(&mut self, key: &DocumentKey) -> EnqueueDecision {
        self.enqueue_refresh(key, None)
    }

    /// didChange: enter the storm buffer (time-window coalescing; same-file merge / newest version wins).
    /// Returns whether it merged with a same-file event already in the buffer. On buffer overflow, force a batch out first (hand over to the dispatch queue);
    /// never let the core record's internal flush silently swallow events.
    pub fn record_change(&mut self, key: &DocumentKey, version: u64) -> bool {
        // Pre-drain: hand the whole batch over before the buffer fills (the honest latency-for-throughput bound).
        if self.storm.buffered() >= STORM_BUFFER_MAX_FILES {
            self.drain_storm();
            self.counters.storm_forced_flushes += 1;
        }
        let identity = identity_of(key);
        self.storm_roots.entry(identity.clone()).or_insert(key.root);
        self.storm_deadline
            .get_or_insert_with(|| Instant::now() + Duration::from_millis(DID_CHANGE_DEBOUNCE_MS));
        self.storm.record(identity, version, DEPENDENCY_UPDATE)
    }

    /// RUST-082: whole-batch handover on window expiry (max latency fulfilled) -- move only on expiry; before expiry,
    /// never touch anything. Returns the number of entries handed over. Under continuous input, at most one batch per window, never postponed indefinitely.
    pub fn flush_due(&mut self, now: Instant) -> usize {
        match self.storm_deadline {
            Some(deadline) if now >= deadline => {
                let drained = self.drain_storm();
                if drained > 0 {
                    self.counters.storm_deadline_flushes += 1;
                }
                drained
            }
            _ => 0,
        }
    }

    /// Freshen the files a request needs first (the RUST-082 wiring face): the buffered events for that file are handed over to the
    /// dispatch queue immediately, without waiting for the window -- the request entry's subsequent freshen can then execute them. Returns whether
    /// any buffered events were handed over.
    pub fn take_buffered(&mut self, identity: &str) -> bool {
        match self.storm.take_file(identity) {
            Some(event) => {
                let root = self.storm_roots.remove(identity).unwrap_or(RootId(0));
                let enqueued = self.enqueue_identity(identity, root, Some(event.version));
                let _ = enqueued;
                if self.storm.buffered() == 0 {
                    self.storm_deadline = None;
                }
                true
            }
            None => false,
        }
    }

    /// Hand the buffer over to the dispatch queue (whole batch, insertion order stable; StormBuffer.flush yields one entry per file).
    fn drain_storm(&mut self) -> usize {
        let events = self.storm.flush();
        let count = events.len();
        for event in events {
            if let Some(root) = self.storm_roots.remove(&event.file) {
                let enqueued = self.enqueue_identity(&event.file, root, Some(event.version));
                let _ = enqueued;
            }
        }
        self.storm_deadline = None;
        count
    }

    /// Rebuild DocumentKey from the identity and enqueue (the storm handover path; the identity comes from a real key, so parse
    /// failure is unreachable -- no fabricated counters).
    fn enqueue_identity(&mut self, identity: &str, root: RootId, version: Option<u64>) -> bool {
        let Some((_, path)) = identity.split_once(':') else {
            return false;
        };
        let Ok(uri) = CanonicalUri::parse(path) else {
            return false;
        };
        let key = DocumentKey::new(root, uri);
        self.enqueue_refresh(&key, version);
        true
    }

    /// Enqueue one refresh (time-point agnostic: replayed against the truth at execution time). Same-file same-version already
    /// queued merges; a new version yields; stale versions drop; queue-full rejects honestly.
    fn enqueue_refresh(&mut self, key: &DocumentKey, version: Option<u64>) -> EnqueueDecision {
        let identity = identity_of(key);
        let done_log = Rc::clone(&self.done_log);
        let identity_for_log = identity.clone();
        let store = Rc::clone(&self.store);
        let hover = Rc::clone(&self.hover);
        let counts = Rc::clone(&self.ingest_counts);
        let disk_reader = Rc::clone(&self.disk_reader);
        let reads = self.reads.clone();
        let key_for_run = key.clone();
        let wrapped: Box<RunFn> = Box::new(move |token| {
            let run = ingest_refresh_task(store, hover, counts, disk_reader, key_for_run, reads);
            let result = run(token);
            done_log.borrow_mut().push(identity_for_log);
            result
        });
        let outcome = self.sched.enqueue(TaskSpec {
            kind: TaskKind::DependencyUpdate,
            priority: DEPENDENCY_UPDATE,
            file: Some(identity),
            version,
            target: None,
            run: wrapped,
        });
        let identity = identity_of(key);
        match outcome.decision {
            EnqueueDecision::Queued => {
                self.pending.insert(identity, (outcome.id, key.root));
                self.counters.enqueued += 1;
            }
            EnqueueDecision::Merged => {
                self.counters.merged += 1;
            }
            EnqueueDecision::StaleDropped => {
                self.counters.stale_dropped += 1;
            }
            EnqueueDecision::RejectedQueueFull => {
                self.counters.rejected_queue_full += 1;
            }
        }
        outcome.decision
    }

    /// Pump slice: execute at most `max_tasks` entries, returning how many actually ran (the Ran count).
    pub fn pump_budgeted(&mut self, max_tasks: usize) -> usize {
        self.poll_reads();
        let mut ran = 0;
        while ran < max_tasks {
            match self.sched.pump_once() {
                kode_scheduler::Pump::Ran => {
                    ran += 1;
                    self.settle_done();
                }
                _ => break,
            }
        }
        ran
    }

    /// RESP-001: pump slice (wall-clock version): at most `max_tasks` entries **and** never past
    /// `deadline` (a dual bound of entries and time -- entry counts cannot bound response time). The budget is checked between tasks;
    /// a single task overrunning cannot be preempted (the worst-case unresponsive interval = one task's parse duration --
    /// RESP-001b has moved disk reads off-thread). RESP-001b: pump read-thread completions before the slice (a read's
    /// identity re-enqueues, so it can apply within the same slice). Returns how many actually ran.
    pub fn pump_budgeted_until(&mut self, max_tasks: usize, deadline: Instant) -> usize {
        let mut ran = 0;
        loop {
            self.poll_reads();
            if ran >= max_tasks || Instant::now() >= deadline {
                break;
            }
            match self.sched.pump_once() {
                kode_scheduler::Pump::Ran => {
                    ran += 1;
                    self.settle_done();
                }
                // Queue empty but reads in flight: within the slice's remaining budget, let the read thread deliver and apply (request
                // drains can therefore obtain the read-completed index within their own budget instead of waiting for the next tick); with no read
                // in flight there is nothing to do -- finish early.
                kode_scheduler::Pump::Idle => {
                    if self.reads_in_flight() {
                        std::thread::sleep(Duration::from_millis(1));
                    } else {
                        break;
                    }
                }
                _ => break,
            }
        }
        ran
    }

    /// RESP-001b: whether any read is in flight (the pump's waiting criterion; always false with no read thread).
    fn reads_in_flight(&self) -> bool {
        self.reads
            .as_ref()
            .is_some_and(|reads| reads.borrow().any_in_flight())
    }

    /// Freshen the files a request needs first (a narrow open-document interaction > local refresh): if this key has a pending
    /// task, jump the queue and execute it immediately, returning whether it ran. RESP-001b: pump read-thread completions first -- a
    /// task whose read finished and re-enqueued can apply in this very jump (a stash hit).
    pub fn freshen(&mut self, identity: &str) -> bool {
        self.poll_reads();
        let id = match self.pending.get(identity) {
            Some(&(id, _)) => id,
            None => return false,
        };
        let ran = self.sched.promote_and_run(id);
        if ran {
            self.settle_done();
        }
        ran
    }

    /// Root-purge fan-out: remove all pending refreshes under this root (the queue-side extension of RUST-069-W's root-purge cache-clearing semantics --
    /// leftover refresh tasks after a root purge would re-populate the old root's corpus = a revival defect),
    /// and also remove this root's storm-buffered events (the same semantics). RESP-001b: also remove the names of this root's in-flight
    /// reads / already-read stash entries (a late done = unowned, discarded).
    pub fn purge_root(&mut self, root: RootId) -> usize {
        let doomed: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, (_, r))| *r == root)
            .map(|(identity, _)| identity.clone())
            .collect();
        let mut purged = 0;
        for identity in &doomed {
            if let Some(&(id, _)) = self.pending.get(identity) {
                if self.sched.cancel(id, "root removed") {
                    self.pending.remove(identity);
                    purged += 1;
                }
            }
        }
        // RESP-001b: root-level name removal for registered reads -- including identities whose task settled but whose read is still in flight (not in
        // the pending ledger, so the loop above cannot remove them).
        if let Some(reads) = &self.reads {
            reads.borrow_mut().purge_root(root);
        }
        // Storm-buffered events of the same root are removed as well (a buffer handover would re-populate the purged root's corpus).
        let buffered_doomed: Vec<String> = self
            .storm_roots
            .iter()
            .filter(|(_, r)| **r == root)
            .map(|(identity, _)| identity.clone())
            .collect();
        for identity in buffered_doomed {
            self.storm.take_file(&identity);
            self.storm_roots.remove(&identity);
            if let Some(reads) = &self.reads {
                reads.borrow_mut().purge(&identity);
            }
            purged += 1;
        }
        if self.storm.buffered() == 0 {
            self.storm_deadline = None;
        }
        self.counters.purged += purged as u64;
        purged
    }

    /// RUST-131-W: the queue-side extension of single-file cancellation (shared by production file events delete/rename of the old
    /// URI) -- remove all pending refreshes and storm-buffered events for this identity. After a file is deleted/
    /// renamed, a leftover refresh would re-populate the old URI's corpus = the late-revival defect (the same
    /// semantics as purge_root, scoped to a single identity). RESP-001b: also remove the names of in-flight
    /// reads / already-read stash entries. Returns the number removed.
    pub fn purge_key(&mut self, identity: &str) -> usize {
        let mut purged = 0;
        if let Some(&(id, _)) = self.pending.get(identity) {
            if self.sched.cancel(id, "file removed") {
                self.pending.remove(identity);
                purged += 1;
            }
        }
        if let Some(reads) = &self.reads {
            reads.borrow_mut().purge(identity);
        }
        if self.storm_roots.remove(identity).is_some() {
            self.storm.take_file(identity);
            purged += 1;
        }
        if self.storm.buffered() == 0 {
            self.storm_deadline = None;
        }
        self.counters.purged += purged as u64;
        purged
    }

    /// RUST-133: whether this identity still has a pending refresh (scheduled pending, storm buffer, or --
    /// RESP-001b -- a read in flight / awaiting application) -- the criterion for the index gap's stale face (a gap =
    /// a refresh already on its way, not a true gap).
    pub fn has_pending(&self, identity: &str) -> bool {
        self.pending.contains_key(identity)
            || self.storm_roots.contains_key(identity)
            || self
                .reads
                .as_ref()
                .is_some_and(|reads| reads.borrow().in_flight(identity))
    }

    /// Observation snapshot (same source as the health face).
    pub fn snapshot(&self) -> IndexQueueSnapshot {
        let ingest = self.ingest_counts.borrow();
        IndexQueueSnapshot {
            queued: self.sched.status().queued as u64,
            storm_seen: self.storm.events_seen,
            storm_merged: self.storm.merged,
            storm_buffered: self.storm.buffered() as u64,
            ingest_identical: ingest.identical,
            ingest_body_only: ingest.body_only,
            ingest_signature: ingest.signature,
            ingest_removed: ingest.removed,
            ..self.counters
        }
    }

    /// Execution-receipt reconciliation: completed identities leave the ledger.
    fn settle_done(&mut self) {
        for identity in self.done_log.borrow_mut().drain(..) {
            if self.pending.remove(&identity).is_some() {
                self.counters.executed += 1;
            }
        }
    }

    /// RESP-001b: the read-thread completion pump -- ledger check (a purged/unowned read result is discarded, guarding
    /// against late revival) -> **apply directly** per the execution-time truth (an overlay open -> drop the disk read; an on-disk
    /// snapshot must not wash away unsaved revisions; otherwise index it / evict on read failure). It does not re-enter the dispatch core's queue
    /// (the same-file same-version Merged decision would swallow the second beat, a race observed in practice). Each pump slice /
    /// freshen entry goes through here first (read completion latency <= PUMP_TICK). Returns the number applied. With no read
    /// thread (None) = 0; the existing inline semantics are undisturbed.
    fn poll_reads(&mut self) -> usize {
        let Some(reads) = self.reads.clone() else {
            return 0;
        };
        let mut applied = 0;
        loop {
            // Take one completion first, then apply (applying borrows store/hover, so it cannot hold the read-thread borrow).
            let done = {
                let mut rt = reads.borrow_mut();
                loop {
                    let Some(done) = rt.try_recv_done() else {
                        return applied;
                    };
                    if rt.consume_wanted(&done.identity) {
                        break done;
                    }
                    // Unowned read (already purged): discard, take the next one.
                }
            };
            let Some(key) = key_from_identity(&done.identity) else {
                continue;
            };
            // Execution-time truth: an overlay is open -> the disk read yields (the overlay task carries its own truth).
            if self.store.borrow().open_buffer(&key).is_some() {
                continue;
            }
            match done.result {
                Ok(text) => {
                    let change = self.hover.borrow_mut().update(key, &text);
                    record_ingest(&self.ingest_counts, change);
                }
                Err(_) => {
                    self.hover.borrow_mut().remove(&key);
                    self.ingest_counts.borrow_mut().removed += 1;
                }
            }
            applied += 1;
        }
    }
}

/// Build the refresh executor (execution-time-truth replay): overlay first (so an open document's unsaved revisions
/// are not washed away by the on-disk snapshot), fall back to disk, and a failed disk read = a true eviction (close != delete, the VFS-012
/// revision, same stance). RESP-001b: when `reads` carries a read thread, the fallback read only posts to the read thread (application
/// happens in the done pump; the protocol thread never reads the disk inline); None = inline (the existing semantics / existing test stance).
pub(crate) fn ingest_refresh_task(
    store: Rc<RefCell<kode_vfs::DocumentStore>>,
    hover: Rc<RefCell<HoverEngine>>,
    counts: Rc<RefCell<IngestCounts>>,
    disk_reader: DiskReadFn,
    key: DocumentKey,
    reads: Option<Rc<RefCell<IngestReadThread>>>,
) -> Box<RunFn> {
    Box::new(move |_token| {
        if let Some((_, buffer)) = store.borrow().open_buffer(&key) {
            let text = buffer.text().to_string();
            let change = hover.borrow_mut().update(key, &text);
            record_ingest(&counts, change);
        } else if let Some(reads) = &reads {
            // RESP-001b: register + post the read task and return (no applying, no evicting); once read, the
            // done pump (poll_reads) applies directly per the execution-time truth -- application does not happen here,
            // since re-entering the dispatch core's queue would hit the same-file same-version Merged decision.
            let identity = identity_of(&key);
            reads
                .borrow_mut()
                .submit(&identity, &key.uri.to_native_path());
        } else {
            // Disk fallback uses the native path: the canonical `/C:/...` form is not a valid path on Windows
            // (parsed relative to the current drive root); feeding it straight to std::fs always fails = the close-document
            // fallback would always take the eviction arm. RESP-001: reads go through the injection point (production = std::fs).
            match disk_reader(&key.uri.to_native_path()) {
                Ok(text) => {
                    let change = hover.borrow_mut().update(key, &text);
                    record_ingest(&counts, change);
                }
                Err(_) => {
                    hover.borrow_mut().remove(&key);
                    counts.borrow_mut().removed += 1;
                }
            }
        }
        Ok(())
    })
}

/// Rebuild DocumentKey from the identity `root:path` (the read-thread done application path; the same shape as
/// [`replay_key`]). Parse failure is unreachable (the identity comes from a real key).
fn key_from_identity(identity: &str) -> Option<DocumentKey> {
    let (root_raw, path) = identity.split_once(':')?;
    let root = root_raw.parse::<u32>().ok()?;
    let uri = CanonicalUri::parse(path).ok()?;
    Some(DocumentKey::new(RootId(root), uri))
}

/// Replay DocumentKey from a uri (shared by the storm handover side's identity rebuild and test construction).
pub fn replay_key(root: RootId, path: &str) -> Option<DocumentKey> {
    CanonicalUri::parse(path)
        .ok()
        .map(|uri| DocumentKey::new(root, uri))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_vfs::uri::CanonicalUri;

    fn key(root: u32, path: &str) -> DocumentKey {
        DocumentKey::new(RootId(root), CanonicalUri::from_path(path))
    }

    fn test_queue() -> IndexQueue {
        IndexQueue::new(
            Rc::new(RefCell::new(kode_vfs::DocumentStore::new())),
            Rc::new(RefCell::new(HoverEngine::new())),
        )
    }

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn same_file_same_version_merges_and_never_double_counts() {
        let mut q = test_queue();
        let k = key(1, "/w/A.def");
        assert_eq!(q.request_open(&k, 3), EnqueueDecision::Queued);
        assert_eq!(q.request_open(&k, 3), EnqueueDecision::Merged);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.enqueued, snap.merged), (1, 1, 1));
    }

    #[test]
    fn newer_version_displaces_and_older_version_is_stale_dropped() {
        let mut q = test_queue();
        let k = key(1, "/w/A.def");
        assert_eq!(q.request_open(&k, 1), EnqueueDecision::Queued);
        // New version yields: the old task is cancelled, the new task enqueues, and the ledger points at the new id.
        assert_eq!(q.request_open(&k, 2), EnqueueDecision::Queued);
        // Stale version dropped: older than the queued one, not enqueued.
        assert_eq!(q.request_open(&k, 1), EnqueueDecision::StaleDropped);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.stale_dropped), (1, 1));
        // Drain executes only once (storm convergence = at most one pending execution).
        assert_eq!(q.pump_budgeted(16), 1);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.executed), (0, 1));
    }

    #[test]
    fn freshen_runs_named_key_first_and_reports_miss() {
        let mut q = test_queue();
        let a = key(1, "/w/A.def");
        let b = key(1, "/w/B.def");
        q.request_open(&a, 1);
        q.request_open(&b, 1);
        // The named key's enqueued task executes immediately (queue jump).
        let ident_b = identity_of(&b);
        assert!(q.freshen(&ident_b));
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.executed), (1, 1));
        // A key not in the queue returns false and does nothing.
        assert!(!q.freshen("9:/w/none.def"));
        // The rest drain by slices as usual.
        assert_eq!(q.pump_budgeted(16), 1);
        assert_eq!(q.snapshot().executed, 2);
    }

    #[test]
    fn pump_budget_caps_slice_size() {
        let mut q = test_queue();
        for i in 0..5 {
            q.request_open(&key(1, &format!("/w/F{i}.def")), 1);
        }
        assert_eq!(q.pump_budgeted(2), 2);
        assert_eq!(q.snapshot().queued, 3);
        assert_eq!(q.pump_budgeted(2), 2);
        assert_eq!(q.pump_budgeted(2), 1);
        assert_eq!(q.snapshot().queued, 0);
    }

    #[test]
    fn purge_root_drops_only_that_roots_pending_tasks() {
        let mut q = test_queue();
        let keep = key(1, "/w/A.def");
        let drop = key(2, "/w/B.def");
        q.request_open(&keep, 1);
        q.request_open(&drop, 1);
        assert_eq!(q.purge_root(RootId(2)), 1);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.purged), (1, 1));
        // Execute the rest: purged keys do not run.
        assert_eq!(q.pump_budgeted(16), 1);
        let snap = q.snapshot();
        assert_eq!((snap.executed, snap.purged), (1, 1));
    }

    #[test]
    fn queue_full_rejects_new_work_and_counts_honestly() {
        let mut q = test_queue();
        // Bounded queue (CORE-006): new work beyond the cap is honestly rejected (counted), never silently accumulated.
        for i in 0..INDEX_QUEUE_MAX {
            assert_eq!(
                q.request_open(&key(1, &format!("/w/F{i}.def")), 1),
                EnqueueDecision::Queued
            );
        }
        assert_eq!(
            q.request_open(&key(1, "/w/overflow.def"), 1),
            EnqueueDecision::RejectedQueueFull
        );
        let snap = q.snapshot();
        assert_eq!(
            (snap.queued, snap.rejected_queue_full),
            (INDEX_QUEUE_MAX as u64, 1)
        );
    }

    #[test]
    fn ingest_refresh_task_replays_time_of_execution_truth() {
        // Execution-time truth: no overlay at enqueue, open at execution -> take the overlay text;
        // never opened -> read the disk; absent on disk too -> evict. Verified with a real-disk temp def file,
        // with the index face proven by the symbol_count change (symbols exist only once def corpus is filed).
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("T.def");
        std::fs::write(&path, T_DEF).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));

        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));
        // Not opened: execute the disk read -> def corpus filed (symbol_count > 0).
        q.request_open(&k, 1);
        assert_eq!(q.pump_budgeted(4), 1);
        assert!(
            hover.borrow().index.symbol_count() > 0,
            "盘上 def 文件应入索引"
        );

        // Closed but still on disk: fall back to the disk (no eviction).
        store.borrow_mut().close(&k);
        q.request_close(&k);
        assert_eq!(q.pump_budgeted(4), 1);
        assert!(
            hover.borrow().index.symbol_count() > 0,
            "关闭后盘上文件仍应喂补全/悬停"
        );

        // File deleted on disk + closed state: executing = a true eviction (symbol_count back to 0).
        std::fs::remove_file(&path).unwrap();
        q.request_close(&k);
        assert_eq!(q.pump_budgeted(4), 1);
        assert_eq!(hover.borrow().index.symbol_count(), 0, "盘上已删除应逐出");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wall_clock_budget_stops_slice_between_tasks() {
        // RESP-001: within the entry cap, stop when the wall clock expires -- with slow-read injection, a slice never swallows the
        // protocol thread. All three keys take the disk arm (a 40ms-per-read slow injection), deadline=25ms: after the first task
        // runs, the time is up and the slice stops at 1 (the 4-entry bound would not be hit first; the budget is checked between tasks).
        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let slow: DiskReadFn = Rc::new(|_| {
            std::thread::sleep(Duration::from_millis(40));
            Ok("<root>\n</root>\n".to_string())
        });
        let mut q = IndexQueue::with_disk_reader(Rc::clone(&store), Rc::clone(&hover), slow);
        for i in 0..3 {
            let k = key(1, &format!("/w/slow{i}.def"));
            q.request_open(&k, 1);
        }
        let deadline = Instant::now() + Duration::from_millis(25);
        let ran = q.pump_budgeted_until(4, deadline);
        assert_eq!(ran, 1, "墙钟到期应停在首任务后(条数界 4 未到)");
        // The remaining two keys continue in later slices (not lost).
        assert_eq!(
            q.pump_budgeted_until(4, Instant::now() + Duration::from_secs(5)),
            2
        );
    }

    #[test]
    fn injected_disk_reader_supplies_text_without_fs() {
        // RESP-001: the read injection point supplies text: the full ingest chain runs even when the file is absent on disk (the base
        // shape for slow-read simulation); a successful read must not evict (removed==0).
        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let reader: DiskReadFn = Rc::new(|_| {
            Ok("<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n".to_string())
        });
        let mut q = IndexQueue::with_disk_reader(Rc::clone(&store), Rc::clone(&hover), reader);
        let k = key(1, "/w/injected.def");
        q.request_open(&k, 1);
        assert_eq!(q.pump_budgeted(2), 1);
        assert!(hover.borrow().index.symbol_count() > 0, "注入文本应入索引");
        let snap = q.snapshot();
        assert_eq!(snap.ingest_removed, 0, "注入读成功不得逐出");
    }

    /// RESP-001b: pump until the predicate holds (the read-thread round trip has real thread-scheduling latency).
    fn pump_until(
        q: &mut IndexQueue,
        budget_ms: u64,
        wait_ms: u64,
        mut done: impl FnMut(&IndexQueue) -> bool,
    ) -> bool {
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        loop {
            q.pump_budgeted_until(64, Instant::now() + Duration::from_millis(budget_ms));
            if done(q) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn off_thread_read_applies_after_roundtrip() {
        // Two beats: the first round only posts, no applying; once read, the done pump applies directly per the execution-time truth.
        // The read thread's injected reader supplies the text (no fs; a real-thread round trip).
        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        const T_DEF: &str =
            "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n";
        let text = T_DEF.to_string();
        let reader = std::sync::Arc::new(move |_: &str| Ok(text.clone()));
        let mut q =
            IndexQueue::with_off_thread_reader(Rc::clone(&store), Rc::clone(&hover), reader);
        let k = key(1, "/w/offthread.def");
        assert_eq!(q.request_open(&k, 1), EnqueueDecision::Queued);
        // The task executes only once (the posting beat; application bypasses the dispatch core, no re-enqueue = no second execution);
        // the slice waits for the read to deliver within the wall-clock bound; a fast read usually applies within the same slice.
        assert_eq!(
            q.pump_budgeted_until(8, Instant::now() + Duration::from_secs(5)),
            1
        );
        let applied = pump_until(&mut q, 100, 4000, |_| {
            hover.borrow().index.symbol_count() > 0
        });
        assert!(applied, "读毕应经 done 泵直接应用入索引");
        let snap = q.snapshot();
        assert_eq!(snap.ingest_removed, 0, "读成功不得逐出");
        assert!(!q.has_pending(&identity_of(&k)), "读毕在册应清空");
    }

    #[test]
    fn off_thread_purged_read_result_is_dropped() {
        // Cancellation defense: a done arriving after purge removed the name = unowned, discarded -- no re-enqueue, no corpus
        // re-population (the late-revival defense, the same semantics as the pending removal). The reader blocks until after the purge
        // releases, pinning the ordering "the read completes later than the cancellation".
        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let go_rx = std::sync::Mutex::new(go_rx);
        let reader = std::sync::Arc::new(move |_: &str| {
            // The Receiver is not Sync: wrap it in a Mutex (exclusive recv inside the read thread).
            let _ = go_rx.lock().unwrap().recv();
            Ok("<root></root>".to_string())
        });
        let mut q =
            IndexQueue::with_off_thread_reader(Rc::clone(&store), Rc::clone(&hover), reader);
        let k = key(1, "/w/purged.def");
        q.request_open(&k, 1);
        q.pump_budgeted_until(8, Instant::now() + Duration::from_secs(5));
        // Root purge while a read is in flight: remove the ledger name.
        q.purge_root(RootId(1));
        // Release the read thread: the done arrives but has no name -> discarded (even an empty def has file-level symbols, so the
        // assertion keys on "zero ingest after the purge").
        let _ = go_tx.send(());
        let quiesced = pump_until(&mut q, 100, 2000, |q| q.snapshot().queued == 0);
        assert!(quiesced);
        let snap = q.snapshot();
        assert_eq!(
            snap.ingest_identical + snap.ingest_body_only + snap.ingest_signature,
            0,
            "撤销后的读结果不得灌入索引(零 ingest)"
        );
        assert_eq!(snap.ingest_removed, 0, "撤销读也不得逐出");
    }

    #[test]
    fn off_thread_superseded_read_eventually_correct() {
        // FIFO final state is correct: a new version enqueues while the old read is in flight -> both reads are posted (FIFO order preserved),
        // applied one by one; the final state = the last read (the superset version wins, no old text left behind).
        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let reader = std::sync::Arc::new(move |_: &str| {
            let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(if n == 0 {
                "<root>\n\t<Properties>\n\t\t<a>\n\t\t\t<Type> UINT32 </Type>\n\t\t</a>\n\t</Properties>\n</root>\n".to_string()
            } else {
                "<root>\n\t<Properties>\n\t\t<a>\n\t\t\t<Type> UINT32 </Type>\n\t\t</a>\n\t\t<b>\n\t\t\t<Type> UINT32 </Type>\n\t\t</b>\n\t</Properties>\n</root>\n".to_string()
            })
        });
        let mut q =
            IndexQueue::with_off_thread_reader(Rc::clone(&store), Rc::clone(&hover), reader);
        let k = key(1, "/w/superseded.def");
        // Standalone oracle: the final state should equal the second text's symbol count.
        let mut oracle = HoverEngine::new();
        oracle.update(
            key(1, "/oracle.def"),
            "<root>\n\t<Properties>\n\t\t<a>\n\t\t\t<Type> UINT32 </Type>\n\t\t</a>\n\t\t<b>\n\t\t\t<Type> UINT32 </Type>\n\t\t</b>\n\t</Properties>\n</root>\n",
        );
        let target = oracle.index.symbol_count();
        assert!(target > 0);

        q.request_open(&k, 1);
        q.pump_budgeted_until(8, Instant::now() + Duration::from_secs(5));
        // A new version enqueues while the old read is in flight (a stash miss at execution -> post one more).
        q.request_open(&k, 2);
        q.pump_budgeted_until(8, Instant::now() + Duration::from_secs(5));
        let settled = pump_until(&mut q, 100, 4000, |q| {
            !q.has_pending(&identity_of(&k)) && q.snapshot().queued == 0
        });
        assert!(settled, "两份读应都消费完");
        assert_eq!(
            hover.borrow().index.symbol_count(),
            target,
            "终态应为最后一读(新文本)"
        );
    }

    #[test]
    fn off_thread_read_error_evicts_on_apply() {
        // A failed read = a true eviction (close != delete, the VFS-012 stance) -- an off-thread read does not change
        // the eviction semantics, only defers it to the next round's replay. The first read succeeds and indexes; the second read fails -> at application
        // it evicts (removed==1, symbols back to zero).
        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let reader = std::sync::Arc::new(move |_: &str| {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Ok("<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n".to_string())
            } else {
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, "gone"))
            }
        });
        let mut q =
            IndexQueue::with_off_thread_reader(Rc::clone(&store), Rc::clone(&hover), reader);
        let k = key(1, "/w/err.def");
        q.request_open(&k, 1);
        let ingested = pump_until(&mut q, 100, 4000, |_| {
            hover.borrow().index.symbol_count() > 0
        });
        assert!(ingested, "首读应入索引");
        // The second refresh's read fails -> evict.
        q.request_close(&k);
        let evicted = pump_until(&mut q, 100, 4000, |q| {
            let snap = q.snapshot();
            snap.ingest_removed == 1 && hover.borrow().index.symbol_count() == 0
        });
        assert!(evicted, "读失败应逐出且符号归零");
    }

    #[test]
    fn off_thread_slow_read_keeps_pump_slices_responsive() {
        // Responsiveness proof: while slow reads (120ms/file) are in flight, a pump slice returns in milliseconds -- the
        // protocol thread never waits for reads inline (inline = 5 files >=600ms; the 100ms assertion threshold separates the two).
        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let reader = std::sync::Arc::new(|_: &str| {
            std::thread::sleep(Duration::from_millis(120));
            Ok("<root></root>".to_string())
        });
        let mut q =
            IndexQueue::with_off_thread_reader(Rc::clone(&store), Rc::clone(&hover), reader);
        for i in 0..5 {
            q.request_open(&key(1, &format!("/w/slow{i}.def")), 1);
        }
        let start = Instant::now();
        q.pump_budgeted_until(64, start + Duration::from_millis(20));
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(100),
            "泵切片被内联读盘拖住:{elapsed:?}"
        );
    }

    #[test]
    fn ingest_counters_classify_identical_body_only_signature_removed() {
        // RUST-120-W: the executor accounts per class (the same source as the health face's four ingest keys). def corpus:
        // reopening the same text = identical; a trailing note (all registered positions unchanged) = body-only; a property
        // type change = signature; a close after on-disk deletion = removed.
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iqc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("T.def");
        std::fs::write(&path, T_DEF).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));

        // First filing = signature.
        q.request_open(&k, 1);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_signature, 1);

        // Reopening the same text = identical (fingerprint hit, generation untouched).
        let gen0 = hover.borrow().index.generation();
        q.request_open(&k, 2);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_identical, 1);
        assert_eq!(hover.borrow().index.generation(), gen0);

        // Appending a trailing note = body-only (zero invalidations).
        std::fs::write(&path, format!("{T_DEF}\n<!-- tail -->\n")).unwrap();
        q.request_open(&k, 3);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_body_only, 1);
        assert_eq!(hover.borrow().index.generation(), gen0);

        // A property type change = signature (generation bump, the view reflects the new type).
        let t16 = T_DEF.replace("UINT32", "UINT16");
        std::fs::write(&path, &t16).unwrap();
        q.request_open(&k, 4);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_signature, 2);
        assert_eq!(hover.borrow().index.generation(), gen0 + 1);

        // On-disk deletion + close = removed (accounted as an eviction).
        std::fs::remove_file(&path).unwrap();
        q.request_close(&k);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_removed, 1);
        assert_eq!(hover.borrow().index.symbol_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn did_change_same_text_via_storm_take_buffered_classifies_identical() {
        // RUST-120-W E2E shape replication: didOpen v1 -> pump; didChange v2 (a full same-text
        // replacement) -> storm buffer -> request entry take_buffered + freshen -> classed
        // = identical (reconciled with the kodeCoreDifferentialInvalidation e2e).
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iqs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("T.def");
        std::fs::write(&path, T_DEF).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));

        q.request_open(&k, 1);
        assert_eq!(q.pump_budgeted(4), 1);
        assert_eq!(q.snapshot().ingest_signature, 1);

        // didChange v2: a full same-text replacement (overlay text = on-disk text, so the change semantics are equivalent on
        // the classification face) + a storm-buffer record (the same shape as production handle_did_change).
        let ident = identity_of(&k);
        q.record_change(&k, 2);
        assert!(q.take_buffered(&ident), "缓冲中的 v2 应被立即移交");
        assert!(q.freshen(&ident), "移交后 freshen 应执行");
        let snap = q.snapshot();
        assert_eq!(snap.ingest_identical, 1, "同文本 didChange = identical");
        assert_eq!(snap.ingest_signature, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn did_change_storm_buffers_merge_and_flushes_at_deadline() {
        // Time-window coalescing: multiple versions of the same file merge into one (newest wins); before window expiry nothing moves;
        // on expiry the whole batch hands over -> one entry per file enqueued (the newest version), fulfilling max latency.
        let mut q = test_queue();
        let a = key(1, "/w/A.def");
        let b = key(1, "/w/B.def");
        let t0 = Instant::now();
        assert!(!q.record_change(&a, 1), "首条新文件不合并");
        assert!(q.record_change(&a, 2), "同文件第二条合并");
        assert!(q.record_change(&a, 1), "旧版本事件仍合并(缓冲只留最新)");
        assert!(!q.record_change(&b, 5), "另一文件新入缓冲");
        let snap = q.snapshot();
        assert_eq!(
            (snap.storm_seen, snap.storm_merged, snap.storm_buffered),
            (4, 2, 2)
        );
        assert_eq!(q.snapshot().queued, 0, "窗口未到期不入调度队列");
        // Before expiry, nothing moves (waiting is allowed within the max-latency upper bound).
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS - 1)), 0);
        assert_eq!(q.snapshot().storm_buffered, 2);
        // On expiry the whole batch hands over: one entry per file (the newest version), the window accounting books it.
        // deadline = the real clock at record time + the window; sleep two window widths to cross it.
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS * 2)), 2);
        let snap = q.snapshot();
        assert_eq!(
            (
                snap.queued,
                snap.storm_buffered,
                snap.storm_deadline_flushes
            ),
            (2, 0, 1)
        );
        assert_eq!(snap.enqueued, 2, "移交即入队");
        // After expiry the buffer is empty: a further flush_due does not double-book.
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS * 4)), 0);
        assert_eq!(q.snapshot().storm_deadline_flushes, 1);
    }

    #[test]
    fn take_buffered_moves_only_named_file_and_resets_deadline_when_empty() {
        let mut q = test_queue();
        let a = key(1, "/w/A.def");
        let b = key(1, "/w/B.def");
        assert!(!q.record_change(&a, 1));
        assert!(!q.record_change(&b, 1));
        let ident_a = identity_of(&a);
        assert!(q.take_buffered(&ident_a), "指名移交");
        let snap = q.snapshot();
        assert_eq!(
            (snap.queued, snap.storm_buffered),
            (1, 1),
            "a 入队,b 留缓冲"
        );
        assert_eq!(snap.enqueued, 1);
        // The window resets after the buffer empties; a key never buffered returns false.
        assert!(q.take_buffered(&identity_of(&b)));
        assert_eq!(q.snapshot().storm_buffered, 0);
        assert!(!q.take_buffered(&ident_a));
        assert_eq!(q.snapshot().queued, 2);
    }

    #[test]
    fn storm_overflow_forces_batch_handoff_before_core_silent_flush() {
        // Buffer overflow: the wrapper pre-drains before record (handing the whole batch to the dispatch queue), never triggering
        // the core record's internal flush (whose return value is dropped = silently swallowing events).
        let mut q = test_queue();
        for i in 0..STORM_BUFFER_MAX_FILES {
            assert!(!q.record_change(&key(1, &format!("/w/F{i}.def")), 1));
        }
        assert_eq!(q.snapshot().storm_buffered, STORM_BUFFER_MAX_FILES as u64);
        assert_eq!(q.snapshot().storm_forced_flushes, 0);
        // The (MAX+1)-th file triggers the pre-drain: the old batch enqueues entirely, and the new batch owns the buffer alone.
        assert!(!q.record_change(&key(1, "/w/overflow.def"), 1));
        let snap = q.snapshot();
        assert_eq!(snap.enqueued, STORM_BUFFER_MAX_FILES as u64);
        assert_eq!(snap.storm_buffered, 1);
        assert_eq!(snap.storm_forced_flushes, 1);
        assert_eq!(snap.storm_deadline_flushes, 0, "预排水不算窗口到期");
    }

    #[test]
    fn purged_root_drops_buffered_change_events_too() {
        // Root purge: queued tasks + storm-buffered events of the same root are all removed (a handover must not revive purged-root corpus).
        let mut q = test_queue();
        let keep = key(1, "/w/A.def");
        let drop = key(2, "/w/B.def");
        q.request_open(&keep, 1);
        assert!(!q.record_change(&drop, 1));
        assert!(q.record_change(&drop, 2));
        assert_eq!(q.purge_root(RootId(2)), 1, "缓冲中同根事件计 1(合并态)");
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.storm_buffered, snap.purged), (1, 0, 1));
        // Drain: purged-root buffered events do not revive.
        assert_eq!(q.pump_budgeted(16), 1);
        assert_eq!(q.snapshot().executed, 1);
    }

    #[test]
    fn flushed_change_ingests_latest_version_into_engine() {
        // Content level: the ingest executed after the storm-window merge = the newest version's corpus (the newest version's exclusive
        // property is in the engine index).
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<{prop}>\n\t\t\t<Type> UINT32 </Type>\n\t\t</{prop}>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iq-storm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("S.def");
        std::fs::write(&path, T_DEF.replace("{prop}", "v1only")).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));
        let t0 = Instant::now();
        assert!(!q.record_change(&k, 1));
        assert!(q.record_change(&k, 2));
        // The newest version's content is written to disk (no overlay open -> the execution-time truth reads the disk).
        std::fs::write(&path, T_DEF.replace("{prop}", "v3only")).unwrap();
        assert!(q.record_change(&k, 3));
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS * 2)), 1);
        assert_eq!(q.pump_budgeted(4), 1);

        let text = std::fs::read_to_string(&path).unwrap();
        let mk = DocumentKey::new(RootId(1), CanonicalUri::from_path(&path.to_string_lossy()));
        let hover_latest = hover.borrow().hover(&mk, &text, 2, 3);
        assert!(
            hover_latest
                .map(|h| h.symbol.name == "v3only")
                .unwrap_or(false),
            "风暴并一后执行应落最新版本语料"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn enqueue_identity_defense_arms_and_happy_path() {
        let mut q = test_queue();
        // No colon: the split defensive arm (a production identity is always root:path; identity_of cannot produce one).
        assert!(!q.enqueue_identity("nocolon", RootId(1), Some(1)));
        // Non-local uri after the colon: the scheme-face parse-failure defensive arm; no fabricated enqueues.
        assert!(!q.enqueue_identity("1:http://x/y", RootId(1), Some(1)));
        // A legal identity walks the full enqueue_refresh chain, really enqueuing one entry.
        let k = key(1, "/w/A.def");
        assert!(q.enqueue_identity(&identity_of(&k), RootId(1), Some(1)));
        assert_eq!(q.snapshot().queued, 1);
    }

    #[test]
    fn debug_face_exposes_snapshot_and_pending() {
        let mut q = test_queue();
        q.request_open(&key(1, "/w/A.def"), 1);
        let dbg = format!("{q:?}");
        assert!(dbg.contains("IndexQueue"));
        assert!(dbg.contains("snapshot"));
        assert!(dbg.contains("pending"));
    }

    #[test]
    fn replay_key_round_trip_and_bad_path_faces() {
        // Identity rebuild round trip: replaying identity_of's segments equals the original key.
        let k = key(3, "/w/C.def");
        let ident = identity_of(&k);
        let path = ident.split_once(':').unwrap().1;
        assert_eq!(replay_key(RootId(3), path), Some(k));
        // Non-scheme uris and blank inputs are rejected.
        assert_eq!(replay_key(RootId(3), "http://x/y"), None);
        assert_eq!(replay_key(RootId(3), "  "), None);
    }
}
