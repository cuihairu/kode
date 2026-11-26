//! Diagnostic scheduling state machine + four-family layered independent throttling (RUST-142 batch 1, sunk down isomorphic with src/backend/
//! diagnosticScheduler.ts; a pure replay core with zero real clock).
//!
//! The face = TS DiagnosticScheduler's **deterministic state machine** (versioned merge / layered accounting /
//! close generation / input generation / enable gate / five async guards / 12 counters), driven by event-trace replay:
//!   - request (immediate channel: synchronous compute + publish guards) / request_queued + flush
//!     (queued channel: newest version per URI wins; coalescedStale is never executed);
//!   - flush yield boundaries (slice_ms=0 determinism: always yields after each entry) execute duringYield
//!     script events; the yield hook body runs synchronously, and continuations of async computations resolved during it settle in FIFO
//!     before the yield returns (the mirror side's computeAsync returns the gate promise directly
//!     = a single microtask continuation, onOk queues before flush-resume, isomorphic with the TS microtask order);
//!   - Async continuations = five publish guards (null abort -> staleDropped / the task's doc object re-entered and versioned
//!     forward -> staleDropped / close-generation mismatch -> releasedDropped / switch off ->
//!     disabledAsyncDropped / input generation switched -> staleGenerationDropped); failure
//!     -> errored (no rethrow, same stance as KR-AUD-04); **the version guard reads the task's
//!     own captured doc object** (TS document object semantics: a new version = a new request = a new
//!     object; the old task's guard is unaffected by the new request, and publishing writes back its own version marker);
//!   - Four-family layering: LocalSyntax / Semantic / EngineCompat / RuntimeConfig,
//!     one independent scheduler instance per layer (independent throttling = instance isolation, isomorphic with the TS production's
//!     one DiagnosticScheduler instance per family); layers are only a routing and accounting face and do not change
//!     the scheduling semantics (TS options.layer only affects metrics fileKind).
//!
//! golden = {traces, outcomes}: both traces and outcomes are produced by Rust; the TS side's
//! tests/kodeDiagnosticPipelineParity.test.ts reads the golden traces to drive the **production**
//! DiagnosticScheduler (a 4-instance pipeline) to recompute trace by trace, comparing each outcome
//! by deep equality (publish order + final-state stats + residual metrics) -- the TS production scheduler is the semantic source of truth;
//! a red mirror = a porting error; re-derive from the source.
//!
//! Honest boundary: the TS production layer enum still has the two values local|semantic (all 17 families currently schedule as
//! local); the four families are this line's target design, with the layer routing/classification face in this core; the production TS
//! is untouched (wiring left to batch 2). Performance timing (recordLanguageServiceOperation) is not on
//! the comparison face.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

// ---------------------------------------------------------------------------
// Four-family layering
// ---------------------------------------------------------------------------

/// Diagnostic layering (RUST-142's target four families; TS production currently has the two values local|semantic;
/// this enum is the server-side target face; layers only route/account and do not change scheduling semantics).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLayer {
    LocalSyntax,
    Semantic,
    EngineCompat,
    RuntimeConfig,
}

impl DiagnosticLayer {
    pub const ALL: [DiagnosticLayer; 4] = [
        DiagnosticLayer::LocalSyntax,
        DiagnosticLayer::Semantic,
        DiagnosticLayer::EngineCompat,
        DiagnosticLayer::RuntimeConfig,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            DiagnosticLayer::LocalSyntax => "localSyntax",
            DiagnosticLayer::Semantic => "semantic",
            DiagnosticLayer::EngineCompat => "engineCompat",
            DiagnosticLayer::RuntimeConfig => "runtimeConfig",
        }
    }

    pub fn parse(value: &str) -> Option<DiagnosticLayer> {
        DiagnosticLayer::ALL
            .iter()
            .copied()
            .find(|layer| layer.as_str() == value)
    }
}

/// Four families -> existing Rust module anchors (classification face; one family one layer, each anchor a landed module):
/// local syntax=def local validation (diagnostics.rs) / semantic=KSEM semantic index
/// (semantics/) / engine compatibility=the def md5 engine gate (def_md5.rs) /
/// runtime config=config contract (config_rpc.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticFamily {
    DefLocalValidation,
    SemanticsIndex,
    DefMd5Compat,
    ConfigContract,
}

pub fn layer_for_family(family: DiagnosticFamily) -> DiagnosticLayer {
    match family {
        DiagnosticFamily::DefLocalValidation => DiagnosticLayer::LocalSyntax,
        DiagnosticFamily::SemanticsIndex => DiagnosticLayer::Semantic,
        DiagnosticFamily::DefMd5Compat => DiagnosticLayer::EngineCompat,
        DiagnosticFamily::ConfigContract => DiagnosticLayer::RuntimeConfig,
    }
}

// ---------------------------------------------------------------------------
// Stats (isomorphic with the TS DiagnosticSchedulerStats 12 counters)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStats {
    pub requested: u64,
    pub computed: u64,
    pub published: u64,
    pub coalesced_stale: u64,
    pub stale_dropped: u64,
    pub released_dropped: u64,
    pub skipped_current_version: u64,
    pub disabled_skipped: u64,
    pub disabled_async_dropped: u64,
    pub stale_generation_dropped: u64,
    pub errored: u64,
    pub cleared: u64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWorkload {
    pub queued: u64,
    pub in_flight: u64,
}

// ---------------------------------------------------------------------------
// Event traces (embedded in the golden; the TS mirror reads the same traces to drive the production scheduler)
// ---------------------------------------------------------------------------

/// Re-entrant orchestration within a compute body (side effects inside the TS compute/computeAsync closures):
/// MutateVersion=rewrite the version of the doc object this task captured; Release=re-enter releaseDocument.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum SideEffect {
    MutateVersion { version: i64 },
    Release { uri: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum AsyncOutcome {
    Items { items: Vec<u32> },
    Null,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum TraceEvent {
    Request {
        uri: String,
        version: Option<i64>,
        items: Vec<u32>,
        #[serde(default)]
        async_compute: bool,
        #[serde(default)]
        side_effects: Vec<SideEffect>,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    RequestQueued {
        uri: String,
        version: Option<i64>,
        items: Vec<u32>,
        #[serde(default)]
        async_compute: bool,
        #[serde(default)]
        side_effects: Vec<SideEffect>,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    Flush {
        #[serde(default = "default_slice_ms")]
        slice_ms: u64,
        #[serde(default)]
        during_yields: Vec<TraceEvent>,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    ResolveAsync {
        async_id: usize,
        outcome: AsyncOutcome,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    AwaitMacrotask {
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    Release {
        uri: String,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    SetEnabled {
        enabled: bool,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    Invalidate {
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
}

fn default_layer() -> DiagnosticLayer {
    DiagnosticLayer::LocalSyntax
}

fn default_slice_ms() -> u64 {
    // TS FLUSH_SLICE_MS huge-value domain = never yields (deterministic; the real value 25ms depends on the clock,
    // so comparison only walks the two deterministic domains: 0 = always yields per entry, huge = zero yields)
    1_000_000_000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCorpusEntry {
    pub name: String,
    pub events: Vec<TraceEvent>,
}

// ---------------------------------------------------------------------------
// Scheduler core (isomorphic with the TS DiagnosticScheduler state machine; items = scripted u32)
// ---------------------------------------------------------------------------

/// Document version cell (one per request task, supporting re-entrant re-versioning inside a synchronous compute -- the TS side's compute
/// closure rewriting the document.version object semantics).
#[derive(Debug, Clone)]
struct DocCell {
    version: std::cell::Cell<Option<i64>>,
}

type SharedDoc = std::rc::Rc<DocCell>;

#[derive(Debug, Clone)]
pub struct TaskSpec {
    pub items: Vec<u32>,
    /// Async computation id (registered into pending; None = synchronous path)
    pub async_id: Option<usize>,
    pub side_effects: Vec<SideEffect>,
}

#[derive(Debug, Clone)]
struct QueuedTask {
    key: String,
    doc: SharedDoc,
    task: TaskSpec,
    version: Option<i64>,
    release_epoch: u64,
}

#[derive(Debug, Default)]
struct UriState {
    published_version: Option<i64>,
    published_generation: i64,
    queued: Option<QueuedTask>,
}

/// Publish-face record (comparable in the golden; same shape as the TS mirror).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum PublishRecord {
    Publish {
        layer: DiagnosticLayer,
        uri: String,
        items: Vec<u32>,
    },
    ClearAll {
        layer: DiagnosticLayer,
    },
}

/// In-flight async computation (continuation data; a structuring of the TS .then(onOk, onErr) closure-capture face).
#[derive(Debug)]
struct PendingAsync {
    key: String,
    doc: SharedDoc,
    task: TaskSpec,
    version: Option<i64>,
    release_epoch: u64,
    started_generation: i64,
}

/// Microtask model (a structuring of the TS production continuation chain): Body = the async fn body-resume segment
/// (`await gate` returns; re-entrant side effects inside the compute body; an Error rejection skips the body's remainder),
/// then OkItems/OkNull/Err are queued by outcome; Ok*/Err = the onOk/onErr segments
/// (counters + five guards + publish/accounting), removed from pending once run. settle = drain all
/// microtasks (after events / at yield boundaries, before the flush-resume macrotask).
#[derive(Debug, Clone)]
enum MicroTask {
    Body(usize),
    OkItems(usize, Vec<u32>),
    OkNull(usize),
    Err(usize),
}

/// Diagnostic scheduling core (single layer; the four-family pipeline = one instance per layer).
/// State iteration order = TS Map insertion order (Vec + index; the flush batch order is comparable).
#[derive(Debug)]
pub struct DiagnosticSchedulerCore {
    generation: i64,
    enabled: bool,
    states: Vec<(String, UriState)>,
    state_index: BTreeMap<String, usize>,
    /// In-flight async computations (removed as soon as Ok/Err finishes running, same stance as the TS pending Set; in_flight = its length)
    pending: Vec<PendingAsync>,
    /// Resolved continuations awaiting settlement (async_id; the outcome is carried by outcomes)
    resolved: BTreeMap<usize, AsyncOutcome>,
    /// Microtask queue (isomorphic with the TS microtask FIFO; the flush yield boundary includes the FlushResume sentinel)
    microtasks: VecDeque<MicroTask>,
    next_async_id: usize,
    epochs: BTreeMap<String, u64>,
    /// Publish collection (the sink equivalent injected by the replay face)
    sink: Vec<PublishRecord>,
    layer: DiagnosticLayer,
    stats: SchedulerStats,
}

impl DiagnosticSchedulerCore {
    pub fn new(layer: DiagnosticLayer) -> DiagnosticSchedulerCore {
        DiagnosticSchedulerCore {
            generation: 0,
            enabled: true,
            states: Vec::new(),
            state_index: BTreeMap::new(),
            pending: Vec::new(),
            resolved: BTreeMap::new(),
            microtasks: VecDeque::new(),
            next_async_id: 0,
            epochs: BTreeMap::new(),
            sink: Vec::new(),
            layer,
            stats: SchedulerStats::default(),
        }
    }

    pub fn stats(&self) -> &SchedulerStats {
        &self.stats
    }

    pub fn sink(&self) -> &[PublishRecord] {
        &self.sink
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn has_queued_tasks(&self) -> bool {
        self.states.iter().any(|(_, s)| s.queued.is_some())
    }

    /// Residual workload metric (TS pendingWorkload; queued = number of queued URIs,
    /// in_flight = number of unsettled async computations).
    pub fn pending_workload(&self) -> PendingWorkload {
        let queued = self
            .states
            .iter()
            .filter(|(_, s)| s.queued.is_some())
            .count() as u64;
        PendingWorkload {
            queued,
            in_flight: self.pending.len() as u64,
        }
    }

    /// Switch toggle (A6-4; clear_all goes through the publish face's ClearAll record).
    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        if !enabled {
            self.sink
                .push(PublishRecord::ClearAll { layer: self.layer });
            self.stats.cleared += 1;
            // Version markers published during closure are all invalidated: after reopening, the same version must recompute once
            for (_, state) in self.states.iter_mut() {
                state.published_version = None;
            }
        } else {
            self.invalidate_all();
        }
    }

    /// Diagnostic input-generation switch (sub-switch / semantic index invalidation): forces published documents to recompute.
    pub fn invalidate_all(&mut self) {
        self.generation += 1;
        for (_, state) in self.states.iter_mut() {
            state.published_version = None;
        }
    }

    /// TS stateFor: create state in an insertion-ordered map + increment the close generation (reopen = all in-flight tasks of the old generation are invalidated).
    /// Returns the state slot (borrow discipline: while the slot borrow is held, no &self method may be called again).
    fn state_for(&mut self, key: &str) -> usize {
        if let Some(&index) = self.state_index.get(key) {
            return index;
        }
        self.states.push((key.to_string(), UriState::default()));
        let index = self.states.len() - 1;
        self.state_index.insert(key.to_string(), index);
        let epoch = self.epochs.entry(key.to_string()).or_insert(0);
        *epoch += 1;
        index
    }

    fn epoch_of(&self, key: &str) -> u64 {
        self.epochs.get(key).copied().unwrap_or(0)
    }

    /// Immediate channel: synchronous compute + publish guards (version / close generation).
    pub fn request(&mut self, uri: &str, version: Option<i64>, task: TaskSpec) {
        self.stats.requested += 1;
        if !self.enabled {
            self.stats.disabled_skipped += 1;
            return;
        }
        let doc = SharedDoc::new(DocCell {
            version: std::cell::Cell::new(version),
        });
        let index = self.state_for(uri);
        let (published_version, published_generation) = {
            let state = &self.states[index].1;
            (state.published_version, state.published_generation)
        };
        let skip = version.is_some()
            && published_version == version
            && published_generation == self.generation;
        if skip {
            self.stats.skipped_current_version += 1;
            return;
        }
        self.compute_and_publish(uri, doc, version, task);
    }

    /// Queued channel (A6-1): per URI keep only the newest-version task (older versions coalescedStale).
    pub fn request_queued(&mut self, uri: &str, version: Option<i64>, task: TaskSpec) {
        self.stats.requested += 1;
        if !self.enabled {
            self.stats.disabled_skipped += 1;
            return;
        }
        let doc = SharedDoc::new(DocCell {
            version: std::cell::Cell::new(version),
        });
        let index = self.state_for(uri);
        let replace_stale = match &self.states[index].1.queued {
            Some(queued) => {
                queued.version.is_some() && version.is_some() && queued.version != version
            }
            None => false,
        };
        let release_epoch = self.epoch_of(uri);
        if replace_stale {
            // Different version = "continuous editing coalesces stale tasks"; same-version replacement does not count as coalescing
            self.stats.coalesced_stale += 1;
        }
        self.states[index].1.queued = Some(QueuedTask {
            key: uri.to_string(),
            doc,
            task,
            version,
            release_epoch,
        });
    }

    /// Flush queued tasks: at most one per URI (the newest version), re-verifying the version token before publishing.
    /// slice_ms=0 = always yields after each entry (deterministic; a TS performance.now difference >= 0 is always true),
    /// huge-value domain = zero yields; yield = run one duringYields script event + settle all continuations within the boundary,
    /// The production-order rationale: the yielding face defaults to the setImmediate macrotask boundary; script events
    /// (an external worker callback resolving) are macrotask rounds within the yield window; the gate continuation chain
    /// (async fn body resume -> onOk publish) is microtasks, drained before the flush-resume macrotask,
    /// so an async resolved within the yield window publishes before the flush resumes. Having yielded = collect one more round
    /// (coalescing tasks newly queued within the window).
    fn flush_round(&mut self, slice_ms: u64, script: &mut std::vec::IntoIter<TraceEvent>) {
        if !self.enabled {
            return;
        }
        loop {
            let batch = self.collect_queued();
            if batch.is_empty() {
                return;
            }
            let mut sliced = false;
            let last = batch.len() - 1;
            for (index, queued) in batch.into_iter().enumerate() {
                self.process_queued_entry(queued);
                if index == last {
                    break;
                }
                if slice_ms == 0 {
                    // Yield hook body: run one script event synchronously, then settle continuations
                    // (microtask drain precedes the flush-resume macrotask)
                    if let Some(event) = script.next() {
                        self.run_event(event, script);
                    }
                    self.settle();
                    // Switch turned off within the yield window: remaining entries are not computed (reopen's invalidateAll forces recompute)
                    if !self.enabled {
                        return;
                    }
                    sliced = true;
                }
            }
            // Zero yields = finish synchronously and atomically; having yielded = collect one more round
            if !sliced {
                return;
            }
        }
    }

    /// Dequeue: take all queued tasks in insertion order (ownership transfer, isomorphic with TS collectQueued).
    fn collect_queued(&mut self) -> Vec<QueuedTask> {
        let mut batch = Vec::new();
        for (_, state) in self.states.iter_mut() {
            if let Some(queued) = state.queued.take() {
                batch.push(queued);
            }
        }
        batch
    }

    /// Process one dequeued entry: only after processing-time guards (close-generation mismatch / task doc re-versioned) does it compute and publish.
    fn process_queued_entry(&mut self, queued: QueuedTask) {
        // Document closed after enqueueing (including closed within the yield window) -> zero compute, dropped outright
        if self.epoch_of(&queued.key) != queued.release_epoch {
            self.stats.released_dropped += 1;
            return;
        }
        // At processing time the task's doc object has advanced to a newer version than at enqueue -> dropped as stale
        let current = queued.doc.version.get();
        if queued.version.is_some() && current != queued.version {
            self.stats.stale_dropped += 1;
            return;
        }
        let skip = self
            .states
            .iter()
            .find(|(k, _)| *k == queued.key)
            .map(|(_, s)| {
                queued.version.is_some()
                    && s.published_version == queued.version
                    && s.published_generation == self.generation
            })
            .unwrap_or(false);
        if skip {
            self.stats.skipped_current_version += 1;
            return;
        }
        self.compute_and_publish(&queued.key, queued.doc, queued.version, queued.task);
    }

    /// Compute and publish: synchronous path (in-body side effects -> guards -> publish) / async path
    /// (registered in flight; its continuation is driven by settle through the same guard set).
    fn compute_and_publish(
        &mut self,
        key: &str,
        doc: SharedDoc,
        version: Option<i64>,
        task: TaskSpec,
    ) {
        // TS: capture the current close generation and the originating generation -- closing or re-generating while in flight both mismatch
        let release_epoch = self.epoch_of(key);
        let started_generation = self.generation;
        match task.async_id {
            Some(_id) => {
                self.pending.push(PendingAsync {
                    key: key.to_string(),
                    doc,
                    task,
                    version,
                    release_epoch,
                    started_generation,
                });
            }
            None => {
                // Synchronous compute (re-entrant in-body side effects: re-version / re-entrant close)
                for effect in &task.side_effects {
                    self.apply_side_effect(effect, Some(&doc));
                }
                self.stats.computed += 1;
                // Publish guard: the document advanced during compute (re-entrant mutateVersion)
                if version.is_some() && doc.version.get() != version {
                    self.stats.stale_dropped += 1;
                    return;
                }
                // Publish guard: the synchronous compute re-entered and closed the document
                if self.epoch_of(key) != release_epoch {
                    self.stats.released_dropped += 1;
                    return;
                }
                self.publish(key, version, task.items);
            }
        }
    }

    fn publish(&mut self, key: &str, version: Option<i64>, items: Vec<u32>) {
        self.sink.push(PublishRecord::Publish {
            layer: self.layer,
            uri: key.to_string(),
            items,
        });
        let generation = self.generation;
        let index = self.state_for(key);
        let state = &mut self.states[index].1;
        state.published_version = version;
        state.published_generation = generation;
        self.stats.published += 1;
    }

    /// Document close: release version markers and leftover queued tasks; increment the close generation (all late results invalidated).
    pub fn release_document(&mut self, uri: &str) {
        let Some(index) = self.state_index.get(uri).copied() else {
            return;
        };
        if self.states[index].1.queued.is_some() {
            self.stats.coalesced_stale += 1;
        }
        self.states.remove(index);
        // Rebuild the index (a TS Map delete leaves the remaining insertion order alone; Vec remove is the same)
        self.state_index.clear();
        for (position, (key, _)) in self.states.iter().enumerate() {
            self.state_index.insert(key.clone(), position);
        }
        let epoch = self.epochs.entry(uri.to_string()).or_insert(0);
        *epoch += 1;
        self.stats.cleared += 1;
    }

    /// Async resolution (event): record the outcome and queue the Body segment (async fn body resume --
    /// the moment the TS gate resolves; guards/publishing live in the Ok segment the Body produces).
    pub fn resolve_async(&mut self, async_id: usize, outcome: AsyncOutcome) {
        if !self
            .pending
            .iter()
            .any(|p| p.task.async_id == Some(async_id))
        {
            return;
        }
        self.resolved.insert(async_id, outcome);
        self.microtasks.push_back(MicroTask::Body(async_id));
    }

    /// Settle: drain the microtask queue (isomorphic with the TS interpreter awaiting setImmediate per event;
    /// FIFO = queue order; the yield boundary precedes the flush-resume macrotask).
    pub fn settle(&mut self) {
        while let Some(task) = self.microtasks.pop_front() {
            self.run_microtask(task);
        }
    }

    /// Execute a single microtask.
    fn run_microtask(&mut self, task: MicroTask) {
        match task {
            MicroTask::Body(id) => {
                let Some(outcome) = self.resolved.remove(&id) else {
                    return;
                };
                match outcome {
                    // async fn body's `await gate` rejected -> the body's remainder (side effects) does not run
                    AsyncOutcome::Error => self.microtasks.push_back(MicroTask::Err(id)),
                    AsyncOutcome::Null => {
                        // Body-resume segment: re-entrant side effects inside the compute body (after the await returns, before return null)
                        self.apply_pending_effects(id);
                        self.microtasks.push_back(MicroTask::OkNull(id));
                    }
                    AsyncOutcome::Items { items } => {
                        self.apply_pending_effects(id);
                        self.microtasks.push_back(MicroTask::OkItems(id, items));
                    }
                }
            }
            MicroTask::OkNull(id) => {
                let Some(pending) = self.take_pending(id) else {
                    return;
                };
                // TS onOk(null): record computed first; null = abort, recorded as stale, not published
                self.stats.computed += 1;
                self.stats.stale_dropped += 1;
                let _ = pending;
            }
            MicroTask::Err(id) => {
                let pending = self.take_pending(id);
                // KR-AUD-04: failure does not rethrow; account it in errored, computed does not increase
                self.stats.errored += 1;
                let _ = pending;
            }
            MicroTask::OkItems(id, items) => {
                let Some(pending) = self.take_pending(id) else {
                    return;
                };
                // TS onOk first line: record computed first (before the null check and all guards)
                self.stats.computed += 1;
                // Publish guard: the document advanced during compute (the task's doc object was re-entered and re-versioned)
                if pending.version.is_some() && pending.doc.version.get() != pending.version {
                    self.stats.stale_dropped += 1;
                    return;
                }
                // Publish guard: the document was closed during compute (or reopened into a new generation after closing)
                if self.epoch_of(&pending.key) != pending.release_epoch {
                    self.stats.released_dropped += 1;
                    return;
                }
                // Publish guard: the switch was turned off while the compute was in flight
                if !self.enabled {
                    self.stats.disabled_async_dropped += 1;
                    return;
                }
                // Publish guard: the generation switched while the compute was in flight (do not publish, and do not mark the new generation published)
                if self.generation != pending.started_generation {
                    self.stats.stale_generation_dropped += 1;
                    return;
                }
                self.publish(&pending.key, pending.version, items);
            }
        }
    }

    /// Re-entrant side effects of the async fn body-resume segment (run after the gate settles normally; an Error rejection skips them).
    fn apply_pending_effects(&mut self, id: usize) {
        let (effects, doc) = self
            .pending
            .iter()
            .find(|p| p.task.async_id == Some(id))
            .map(|p| (p.task.side_effects.clone(), Some(p.doc.clone())))
            .unwrap_or((Vec::new(), None));
        for effect in &effects {
            self.apply_side_effect(effect, doc.as_ref());
        }
    }

    /// TS pending.delete: removed from in-flight as soon as the onOk/onErr segment starts running.
    fn take_pending(&mut self, id: usize) -> Option<PendingAsync> {
        let position = self
            .pending
            .iter()
            .position(|p| p.task.async_id == Some(id))?;
        Some(self.pending.remove(position))
    }

    fn apply_side_effect(&mut self, effect: &SideEffect, doc: Option<&SharedDoc>) {
        match effect {
            SideEffect::MutateVersion { version } => {
                if let Some(doc) = doc {
                    doc.version.set(Some(*version));
                }
            }
            SideEffect::Release { uri } => self.release_document(uri),
        }
    }

    fn make_task(
        &mut self,
        items: Vec<u32>,
        async_compute: bool,
        side_effects: Vec<SideEffect>,
    ) -> TaskSpec {
        let async_id = if async_compute {
            let id = self.next_async_id;
            self.next_async_id += 1;
            Some(id)
        } else {
            None
        };
        TaskSpec {
            items,
            async_id,
            side_effects,
        }
    }

    /// Event-replay entry (event-to-layer routing is the replay face's job; only single-layer semantics run here).
    fn run_event(&mut self, event: TraceEvent, _script: &mut std::vec::IntoIter<TraceEvent>) {
        match event {
            TraceEvent::Request {
                uri,
                version,
                items,
                async_compute,
                side_effects,
                layer: _,
            } => {
                let task = self.make_task(items, async_compute, side_effects);
                self.request(&uri, version, task);
            }
            TraceEvent::RequestQueued {
                uri,
                version,
                items,
                async_compute,
                side_effects,
                layer: _,
            } => {
                let task = self.make_task(items, async_compute, side_effects);
                self.request_queued(&uri, version, task);
            }
            TraceEvent::Flush {
                slice_ms,
                during_yields,
                layer: _,
            } => {
                let mut script_iter = during_yields.into_iter();
                self.flush_round(slice_ms, &mut script_iter);
            }
            TraceEvent::ResolveAsync {
                async_id,
                outcome,
                layer: _,
            } => self.resolve_async(async_id, outcome),
            TraceEvent::AwaitMacrotask { layer: _ } => self.settle(),
            TraceEvent::Release { uri, layer: _ } => self.release_document(&uri),
            TraceEvent::SetEnabled { enabled, layer: _ } => self.set_enabled(enabled),
            TraceEvent::Invalidate { layer: _ } => self.invalidate_all(),
        }
    }
}

// ---------------------------------------------------------------------------
// Replay face (four-family pipeline; one independent scheduler per layer = independent throttling)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceOutcome {
    pub name: String,
    pub publish_log: Vec<PublishRecord>,
    pub stats: BTreeMap<String, SchedulerStats>,
    pub workload: BTreeMap<String, PendingWorkload>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineGolden {
    pub generator: &'static str,
    pub trace_count: usize,
    pub traces: Vec<TraceCorpusEntry>,
    pub outcomes: Vec<TraceOutcome>,
}

/// Replay: four-family pipeline (one independent scheduler per layer); events route by layer and continuations settle after each event
/// (isomorphic with the TS interpreter draining microtasks via await setImmediate per event).
pub fn replay_trace(trace: &TraceCorpusEntry) -> TraceOutcome {
    let mut schedulers: BTreeMap<String, DiagnosticSchedulerCore> = BTreeMap::new();
    for layer in DiagnosticLayer::ALL {
        schedulers.insert(
            layer.as_str().to_string(),
            DiagnosticSchedulerCore::new(layer),
        );
    }
    for event in &trace.events {
        let layer = layer_of_event(event);
        let scheduler = schedulers
            .get_mut(layer.as_str())
            .expect("layer routed scheduler");
        let mut empty_script = Vec::new().into_iter();
        scheduler.run_event(event.clone(), &mut empty_script);
        // Settle after each event (the TS interpreter uniformly awaits to drain microtasks)
        scheduler.settle();
    }
    let mut stats = BTreeMap::new();
    let mut workload = BTreeMap::new();
    let mut publish_log = Vec::new();
    for (name, scheduler) in &schedulers {
        stats.insert(name.clone(), scheduler.stats().clone());
        workload.insert(name.clone(), scheduler.pending_workload());
        publish_log.extend(scheduler.sink().iter().cloned());
    }
    TraceOutcome {
        name: trace.name.clone(),
        publish_log,
        stats,
        workload,
    }
}

fn layer_of_event(event: &TraceEvent) -> DiagnosticLayer {
    match event {
        TraceEvent::Request { layer, .. }
        | TraceEvent::RequestQueued { layer, .. }
        | TraceEvent::Flush { layer, .. }
        | TraceEvent::ResolveAsync { layer, .. }
        | TraceEvent::AwaitMacrotask { layer }
        | TraceEvent::Release { layer, .. }
        | TraceEvent::SetEnabled { layer, .. }
        | TraceEvent::Invalidate { layer } => *layer,
    }
}

// ---------------------------------------------------------------------------
// golden corpus (traces are authoritatively defined by this function; the TS mirror recomputes from the golden traces)
// ---------------------------------------------------------------------------

pub const DIAGNOSTIC_PIPELINE_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/diagnostic-pipeline-parity.json";

fn corpus() -> Vec<TraceCorpusEntry> {
    let a = "file:///a.def";
    let b = "file:///b.def";
    let c = "file:///c.def";
    let d = "file:///d.def";
    let req = |uri: &str, version: i64, items: Vec<u32>| TraceEvent::Request {
        uri: uri.to_string(),
        version: Some(version),
        items,
        async_compute: false,
        side_effects: Vec::new(),
        layer: DiagnosticLayer::LocalSyntax,
    };
    let req_async = |uri: &str, version: i64, items: Vec<u32>| TraceEvent::Request {
        uri: uri.to_string(),
        version: Some(version),
        items,
        async_compute: true,
        side_effects: Vec::new(),
        layer: DiagnosticLayer::LocalSyntax,
    };
    let queued = |uri: &str, version: i64, items: Vec<u32>| TraceEvent::RequestQueued {
        uri: uri.to_string(),
        version: Some(version),
        items,
        async_compute: false,
        side_effects: Vec::new(),
        layer: DiagnosticLayer::LocalSyntax,
    };
    let macro_task = || TraceEvent::AwaitMacrotask {
        layer: DiagnosticLayer::LocalSyntax,
    };
    vec![
        // T1 immediate channel: publish / same-version same-generation skip / version advance recompute
        TraceCorpusEntry {
            name: "sync_request_publish_version_skip".into(),
            events: vec![req(a, 1, vec![1]), req(a, 1, vec![1]), req(a, 2, vec![2])],
        },
        // T2 enable gate: off -> clearAll+cleared+disabledSkipped; on -> invalidateAll recompute
        TraceCorpusEntry {
            name: "disabled_gate_roundtrip".into(),
            events: vec![
                req(a, 1, vec![1]),
                TraceEvent::SetEnabled {
                    enabled: false,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                req(a, 1, vec![1]),
                TraceEvent::SetEnabled {
                    enabled: true,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                req(a, 1, vec![1]),
            ],
        },
        // T3 queued coalescing: newest version per URI wins (coalescedStale=1); flush computes only v2
        TraceCorpusEntry {
            name: "queued_coalesce_latest_wins".into(),
            events: vec![
                queued(a, 1, vec![1]),
                queued(a, 2, vec![2]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T4 yield window: yield between batches runs the script (enqueue a new task -> re-collect a second round;
        // release an already-batched task -> close-generation mismatch at processing, releasedDropped)
        TraceCorpusEntry {
            name: "flush_yield_recollect_and_release".into(),
            events: vec![
                queued(a, 1, vec![1]),
                queued(b, 1, vec![2]),
                queued(c, 1, vec![3]),
                TraceEvent::Flush {
                    slice_ms: 0,
                    during_yields: vec![
                        queued(d, 1, vec![4]),
                        TraceEvent::Release {
                            uri: c.to_string(),
                            layer: DiagnosticLayer::LocalSyntax,
                        },
                    ],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T5 async + new-version request: the task's doc object is unaffected by the new request; the late reply still publishes
        // (TS document object semantics: the guard only reads the task's own captured object; the publish writes back
        // its own version marker, overwriting the new request's marker)
        TraceCorpusEntry {
            name: "async_own_doc_object_publishes_late".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                req(a, 2, vec![2]),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T6 async null abort (computed is recorded before the null check, staleDropped)
        TraceCorpusEntry {
            name: "async_null_abort".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Null,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T7 async in-flight close: the late reply does not publish (releasedDropped)
        TraceCorpusEntry {
            name: "async_release_midflight".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::Release {
                    uri: a.to_string(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T8 async in-flight switch-off: the old result is not written back (disabledAsyncDropped)
        TraceCorpusEntry {
            name: "async_disable_midflight".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::SetEnabled {
                    enabled: false,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T9 async in-flight generation switch: the old config result is discarded (not published and not marked published -> reopening the same version must recompute)
        TraceCorpusEntry {
            name: "async_invalidate_midflight".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::Invalidate {
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
                req(a, 1, vec![9]),
            ],
        },
        // T10 async failure: accounted in errored, computed does not increase, no publish
        TraceCorpusEntry {
            name: "async_error_accounted".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Error,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T11 async double in-flight FIFO settlement: publish order = resolution order (b resolves before a)
        TraceCorpusEntry {
            name: "async_fifo_settle_order".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                req_async(b, 1, vec![2]),
                TraceEvent::ResolveAsync {
                    async_id: 1,
                    outcome: AsyncOutcome::Items { items: vec![2] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T12 same-version re-queue after publish: the guard at flush processing yields skippedCurrentVersion
        TraceCorpusEntry {
            name: "flush_repeat_skips_published_version".into(),
            events: vec![
                queued(a, 1, vec![1]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
                queued(a, 1, vec![1]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T13 synchronous compute re-enters and re-versions: the guard reads the new version -> staleDropped (computed already recorded)
        TraceCorpusEntry {
            name: "sync_compute_reentrant_mutate_version".into(),
            events: vec![TraceEvent::Request {
                uri: a.to_string(),
                version: Some(1),
                items: vec![1],
                async_compute: false,
                side_effects: vec![SideEffect::MutateVersion { version: 9 }],
                layer: DiagnosticLayer::LocalSyntax,
            }],
        },
        // T14 synchronous compute re-enters close (via release itself): releasedDropped
        TraceCorpusEntry {
            name: "sync_compute_reentrant_release".into(),
            events: vec![TraceEvent::Request {
                uri: a.to_string(),
                version: Some(1),
                items: vec![1],
                async_compute: false,
                side_effects: vec![SideEffect::Release { uri: a.to_string() }],
                layer: DiagnosticLayer::LocalSyntax,
            }],
        },
        // T15 queued task whose doc re-versions at processing: staleDropped (a release re-entry after
        // enqueue but before flush via another event is unreachable -- enqueue within a yield window + a second yield
        // cannot mutate the captured doc, so this trace instead re-queues the same version after an Invalidate inside the flush yield window
        // to cover the publishedGeneration guard path)
        TraceCorpusEntry {
            name: "queued_flush_after_invalidate_recomputes".into(),
            events: vec![
                queued(a, 1, vec![1]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Invalidate {
                    layer: DiagnosticLayer::LocalSyntax,
                },
                queued(a, 1, vec![7]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T16 four-family pipeline independent throttling: the same URI schedules in each of the four layers independently; turning off localSyntax does not affect
        // the other layers' compute and publish (clearAll lands only on the localSyntax publish face)
        TraceCorpusEntry {
            name: "pipeline_layers_independent_throttle".into(),
            events: vec![
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![1],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![2],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::Semantic,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![3],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::EngineCompat,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![4],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::RuntimeConfig,
                },
                TraceEvent::SetEnabled {
                    enabled: false,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(2),
                    items: vec![5],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(2),
                    items: vec![6],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::Semantic,
                },
                TraceEvent::RequestQueued {
                    uri: b.to_string(),
                    version: Some(1),
                    items: vec![7],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::RuntimeConfig,
                },
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::RuntimeConfig,
                },
            ],
        },
        // T17 a queued task resolved within the yield window while an async is in flight: the continuation settles at the yield boundary,
        // the publish lands inside the flush batch (the TS microtask order where onOk drains before flush-resume)
        TraceCorpusEntry {
            name: "yield_resolves_async_publish_inside_flush".into(),
            events: vec![
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![1],
                    async_compute: true,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                queued(b, 1, vec![2]),
                queued(c, 1, vec![3]),
                TraceEvent::Flush {
                    slice_ms: 0,
                    during_yields: vec![TraceEvent::ResolveAsync {
                        async_id: 0,
                        outcome: AsyncOutcome::Items { items: vec![1] },
                        layer: DiagnosticLayer::LocalSyntax,
                    }],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
    ]
}

/// golden generation (authoritative traces + replay outputs; traces and outcomes share one file; the TS mirror reads
/// traces to drive the production scheduler, comparing outcomes item by item).
pub fn dump_diagnostic_pipeline_golden() -> String {
    let traces = corpus();
    let outcomes: Vec<TraceOutcome> = traces.iter().map(replay_trace).collect();
    let golden = PipelineGolden {
        generator: "dump-diagnostic-pipeline-golden",
        trace_count: traces.len(),
        traces,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden serialize")
}

// ---------------------------------------------------------------------------
// Unit pins (independent assertions on core semantics; the golden's outcomes being produced by the same code is self-consistent,
// so these pins assert the scheduling core's semantics directly, guarding against golden tautology)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sync_task(items: Vec<u32>) -> TaskSpec {
        TaskSpec {
            items,
            async_id: None,
            side_effects: Vec::new(),
        }
    }

    fn async_task(id: usize, items: Vec<u32>) -> TaskSpec {
        TaskSpec {
            items,
            async_id: Some(id),
            side_effects: Vec::new(),
        }
    }

    #[test]
    fn coalesce_and_latest_version_wins() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("a", Some(1), sync_task(vec![1]));
        core.request_queued("a", Some(2), sync_task(vec![2]));
        assert_eq!(core.stats().coalesced_stale, 1);
        core.flush_round(1_000_000_000, &mut Vec::new().into_iter());
        assert_eq!(core.stats().published, 1);
        assert_eq!(
            core.sink(),
            &[PublishRecord::Publish {
                layer: DiagnosticLayer::LocalSyntax,
                uri: "a".into(),
                items: vec![2],
            }]
        );
    }

    #[test]
    fn same_version_replacement_is_not_coalesced() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("a", Some(1), sync_task(vec![1]));
        core.request_queued("a", Some(1), sync_task(vec![1]));
        assert_eq!(core.stats().coalesced_stale, 0);
        assert_eq!(core.stats().requested, 2);
    }

    #[test]
    fn release_drops_queued_task_and_late_async_result() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("a", Some(1), sync_task(vec![1]));
        core.release_document("a");
        assert_eq!(core.stats().coalesced_stale, 1, "关闭时排队任务记合并");
        assert_eq!(core.stats().cleared, 1);
        assert!(!core.has_queued_tasks(), "关闭后队列清空");
        core.flush_round(1_000_000_000, &mut Vec::new().into_iter());
        assert_eq!(core.stats().published, 0, "已释放任务不发布");
        // In-flight async: close-generation mismatch, the late reply does not publish
        core.request("a", Some(1), async_task(0, vec![1]));
        core.release_document("a");
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(core.stats().released_dropped, 1);
        assert_eq!(core.stats().published, 0);
        assert_eq!(core.pending_workload().in_flight, 0, "结算后在途摘除");
    }

    #[test]
    fn generation_switch_drops_and_does_not_mark_published() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request("a", Some(1), async_task(0, vec![1]));
        core.invalidate_all();
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(core.stats().stale_generation_dropped, 1);
        assert_eq!(core.stats().published, 0);
        // Key semantics: do not mark the new generation published -- same-version recompute does not skip
        core.request("a", Some(1), sync_task(vec![9]));
        assert_eq!(core.stats().skipped_current_version, 0);
        assert_eq!(core.stats().published, 1);
    }

    #[test]
    fn disable_drops_inflight_and_reopen_forces_recompute() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request("a", Some(1), sync_task(vec![1]));
        core.set_enabled(false);
        assert_eq!(core.stats().cleared, 1);
        core.request("a", Some(1), sync_task(vec![1]));
        assert_eq!(core.stats().disabled_skipped, 1);
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(core.stats().disabled_async_dropped, 0, "关前未注册异步");
        // In-flight async resolving after close
        let mut core2 = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core2.request("a", Some(1), async_task(0, vec![1]));
        core2.set_enabled(false);
        core2.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core2.settle();
        assert_eq!(core2.stats().disabled_async_dropped, 1);
        // Reopen: invalidateAll forces published documents to recompute (same version does not skip)
        core.set_enabled(true);
        core.request("a", Some(1), sync_task(vec![1]));
        assert_eq!(core.stats().skipped_current_version, 0);
        assert_eq!(core.stats().published, 2);
    }

    #[test]
    fn settle_order_is_resolution_fifo() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request("a", Some(1), async_task(0, vec![1]));
        core.request("b", Some(1), async_task(1, vec![2]));
        core.resolve_async(1, AsyncOutcome::Items { items: vec![2] });
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(
            core.sink(),
            &[
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "b".into(),
                    items: vec![2],
                },
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "a".into(),
                    items: vec![1],
                },
            ]
        );
    }

    #[test]
    fn flush_batch_follows_insertion_order_and_recollects_after_yield() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("zz", Some(1), sync_task(vec![1]));
        core.request_queued("aa", Some(1), sync_task(vec![2]));
        // Insertion-order batches: zz before aa (not lexicographic); slice=0 yields between batches, the script enqueues a new task
        core.request_queued("mm", Some(1), sync_task(vec![3]));
        let mut script = vec![TraceEvent::RequestQueued {
            uri: "bb".into(),
            version: Some(1),
            items: vec![4],
            async_compute: false,
            side_effects: Vec::new(),
            layer: DiagnosticLayer::LocalSyntax,
        }]
        .into_iter();
        core.flush_round(0, &mut script);
        let uris: Vec<&str> = core
            .sink()
            .iter()
            .filter_map(|r| match r {
                PublishRecord::Publish { uri, .. } => Some(uri.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(uris, vec!["zz", "aa", "mm", "bb"], "插入序批+让出窗口收编");
    }

    #[test]
    fn yield_window_async_publishes_before_flush_resume() {
        // T17 semantics: the yielding face defaults to the setImmediate macrotask boundary; a continuation chain resolved within the yield window
        // (async fn body resume -> onOk publish) is microtasks, drained before the flush-resume
        // macrotask -- the async publish lands first, the flush's synchronous entries land after.
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("b", Some(1), async_task(0, vec![1]));
        core.request_queued("c", Some(1), sync_task(vec![3]));
        let mut script = vec![TraceEvent::ResolveAsync {
            async_id: 0,
            outcome: AsyncOutcome::Items { items: vec![1] },
            layer: DiagnosticLayer::LocalSyntax,
        }]
        .into_iter();
        core.flush_round(0, &mut script);
        core.settle();
        assert_eq!(
            core.sink(),
            &[
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "b".into(),
                    items: vec![1],
                },
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "c".into(),
                    items: vec![3],
                },
            ],
            "让出窗口异步先发布,flush 同步条目后发布"
        );
        assert_eq!(core.stats().computed, 2, "异步 onOk 与同步计算各计一次");
        assert_eq!(core.stats().published, 2);
        assert_eq!(core.stats().stale_dropped, 0);
    }

    #[test]
    fn sync_reentrant_mutate_version_drops_publish() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request(
            "a",
            Some(1),
            TaskSpec {
                items: vec![1],
                async_id: None,
                side_effects: vec![SideEffect::MutateVersion { version: 9 }],
            },
        );
        assert_eq!(core.stats().computed, 1);
        assert_eq!(core.stats().stale_dropped, 1);
        assert_eq!(core.stats().published, 0);
    }

    #[test]
    fn layer_pipeline_routes_independently() {
        assert_eq!(
            layer_for_family(DiagnosticFamily::DefLocalValidation),
            DiagnosticLayer::LocalSyntax
        );
        assert_eq!(
            layer_for_family(DiagnosticFamily::SemanticsIndex),
            DiagnosticLayer::Semantic
        );
        assert_eq!(
            layer_for_family(DiagnosticFamily::DefMd5Compat),
            DiagnosticLayer::EngineCompat
        );
        assert_eq!(
            layer_for_family(DiagnosticFamily::ConfigContract),
            DiagnosticLayer::RuntimeConfig
        );
        assert_eq!(
            DiagnosticLayer::parse("localSyntax"),
            Some(DiagnosticLayer::LocalSyntax)
        );
        assert_eq!(
            DiagnosticLayer::parse("runtimeConfig"),
            Some(DiagnosticLayer::RuntimeConfig)
        );
        assert_eq!(DiagnosticLayer::parse("nope"), None);
        // Independent throttling: turning off one layer does not affect the other layers' compute
        let mut local = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        let mut semantic = DiagnosticSchedulerCore::new(DiagnosticLayer::Semantic);
        local.request("a", Some(1), sync_task(vec![1]));
        semantic.request("a", Some(1), sync_task(vec![2]));
        local.set_enabled(false);
        local.request("a", Some(2), sync_task(vec![3]));
        semantic.request("a", Some(2), sync_task(vec![4]));
        assert_eq!(local.stats().disabled_skipped, 1);
        assert_eq!(semantic.stats().published, 2);
    }
}
