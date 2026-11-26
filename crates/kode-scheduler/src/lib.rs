//! kode-scheduler: invalidation scheduler (kode2 PR-009, book §4 CORE-005..008/017 +
//! §7 IDX-003/013/015 scheduling surface + §17 PR-009 "reverse DAG, task priority
//! and cancel" foundation).
//!
//! Modules:
//! - [`model`] task model: kind / five priority levels / state / metrics / state
//!   snapshot (fields correspond one-to-one with the TS `src/indexScheduler.ts`
//!   scheduling surface; the parity surface is the decision surface, two semantics
//!   sets are not allowed);
//! - [`scheduler`] single-concurrency scheduling core: same-file same-version merge,
//!   stale-version discard/cancel, priority+seq fair ordering, interaction
//!   cooldown throttling (CORE-005/006/008/010 foundation), anti-starvation
//!   promotion, bounded-queue eviction, pause/resume, cancel (cancel token +
//!   batch);
//! - [`invalidation`] invalidation graph: file -> declared names -> reverse
//!   affected set (§17 reverse DAG foundation, reuses the kode-index name
//!   inversion / reverse dependency) + batched rebuild plan (deterministic
//!   chunking);
//! - [`journal`] crash-recovery journal: temp file + atomic rename write,
//!   fault-tolerant line-by-line parse, filters stale tasks against the current
//!   version on recovery;
//! - [`golden`] golden for parity with the TS IndexScheduler scheduling surface:
//!   scenario-fixture driven, isomorphic two-way gate with PR-005/006/007 (no
//!   performance comparison per ARCH-012).
//!
//! Numbering note: the task sheet references "SCHED-001..021 (book chapter 10)";
//! book §10 is actually KBE-* engineering items with no SCHED-* numbering
//! (same situation as the "task-sheet numbering vs book items" case in PR-007).
//! This task lands against the book's real items: scheduling behaviour surface =
//! §4 CORE-005/006/007/008/017 + §7 IDX-003/013/015 + §17 PR-009; SCHED-001..021
//! stay as this task's internal acceptance checklist in docs/kode2/pr-009.md
//! (each mapped to a book item, claiming no off-book capability surface).
//!
//! Iron rule: zero third-party crates (only workspace kode-index/kode-vfs deps).

pub mod golden;
pub mod invalidation;
pub mod journal;
pub mod lane;
pub mod model;
pub mod pool;
pub mod results;
pub mod scheduler;
pub mod session;
pub mod stress;

pub use invalidation::{plan_dependency_tasks, CallReverseIndex, InvalidationGraph};
pub use journal::{load_journal, write_journal, RecoveryReport, TaskRecord};
pub use lane::{LaneBudget, LaneBudgetError, LaneGate, TaskLane};
pub use model::{SchedulerMetrics, SchedulerStatus, TaskKind, TaskState};
pub use pool::{PoolBudget, PoolBudgetError, WorkerPoolGate};
pub use results::{paginate, Page, PageCursor, PageLimits, PageLimitsError};
pub use scheduler::{
    CancelToken, ColdRequestOutcome, EnqueueDecision, EnsureDecision, Pump, Scheduler,
    SchedulerOptions, StormBuffer, TaskSpec, WarmState, BACKGROUND_SCAN_KEY,
    MAX_RETAINED_TERMINAL_TASKS,
};
pub use session::{RootInvalidationSink, RootRemoval, WorkspaceSession};

pub use kode_index::DocumentKey;
pub use kode_vfs::store::RootId;
