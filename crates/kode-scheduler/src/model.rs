//! Task model: kind / priority / state / metrics / status snapshot.
//!
//! Field-by-field alignment with TS `src/indexScheduler.ts`'s `IndexTaskKind` /
//! `IndexTaskPriority` / `IndexTaskState` / `SchedulerMetrics` / `SchedulerStatus`
//! (the parity surface = the decision surface; field names / values / thresholds must not carry
//! two sets of semantics).
//! Fields marked `rust_ext` are Rust-side extensions (the CORE-006/010 capability surface),
//! outside the TS parity surface and serialized separately.

use std::collections::BTreeMap;

/// Task kind = lifecycle phase (TS `IndexTaskKind`, same names, same order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TaskKind {
    InitialScan,
    SingleFileUpdate,
    DependencyUpdate,
    DeleteCleanup,
    FullReindex,
    NonInteractive,
}

impl TaskKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            TaskKind::InitialScan => "initial-scan",
            TaskKind::SingleFileUpdate => "single-file-update",
            TaskKind::DependencyUpdate => "dependency-update",
            TaskKind::DeleteCleanup => "delete-cleanup",
            TaskKind::FullReindex => "full-reindex",
            TaskKind::NonInteractive => "non-interactive",
        }
    }

    /// For ledger/golden deserialization; unknown kinds are rejected (tolerant lines count as
    /// corrupt).
    pub fn parse(s: &str) -> Option<TaskKind> {
        match s {
            "initial-scan" => Some(TaskKind::InitialScan),
            "single-file-update" => Some(TaskKind::SingleFileUpdate),
            "dependency-update" => Some(TaskKind::DependencyUpdate),
            "delete-cleanup" => Some(TaskKind::DeleteCleanup),
            "full-reindex" => Some(TaskKind::FullReindex),
            "non-interactive" => Some(TaskKind::NonInteractive),
            _ => None,
        }
    }
}

/// Priority (TS `IndexTaskPriority`, same values: smaller numbers go first).
pub mod priority {
    /// Light parse of the currently open file.
    pub const CURRENT_FILE_LIGHT: u8 = 0;
    /// Local index needed by the current request.
    pub const REQUEST_LOCAL: u8 = 1;
    /// Update of affected dependencies.
    pub const DEPENDENCY_UPDATE: u8 = 2;
    /// Background full indexing.
    pub const BACKGROUND_FULL: u8 = 3;
    /// Non-interactive whole-project analysis.
    pub const NON_INTERACTIVE: u8 = 4;

    /// Interactive tasks = the kinds the user is waiting for inside a session (TS
    /// `isInteractivePriority`, same threshold).
    pub const fn is_interactive(priority: u8) -> bool {
        priority < BACKGROUND_FULL
    }
}

/// Task state (TS `IndexTaskState`, same values).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TaskState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    pub const fn as_str(self) -> &'static str {
        match self {
            TaskState::Queued => "queued",
            TaskState::Running => "running",
            TaskState::Completed => "completed",
            TaskState::Failed => "failed",
            TaskState::Cancelled => "cancelled",
        }
    }
}

/// Scheduling metrics. The first five fields share name and meaning with TS `SchedulerMetrics`
/// (the parity surface); the last three are Rust extensions (bounded queue / anti-starvation),
/// outside the TS parity surface.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SchedulerMetrics {
    /// Number of duplicate tasks merged away for the same file and version (TS `mergedTasks`).
    pub merged_tasks: u64,
    /// Number of stale-version tasks cancelled / dropped (TS `staleDropped`).
    pub stale_dropped: u64,
    /// Number of background tasks whose start was postponed by the interactive cooldown (TS
    /// `postponedBackground`).
    pub postponed_background: u64,
    /// Cumulative waiting time in ms yielded by background tasks due to interactive throttling (TS
    /// `backgroundDelayMs`).
    pub background_delay_ms: u64,
    /// Number of re-enqueue recoveries after a task failure / crash (TS `recoveries`).
    pub recoveries: u64,
    /// rust_ext: the bounded queue was full, so low-priority old tasks were evicted to free slots.
    pub evicted_queue_full: u64,
    /// rust_ext: the bounded queue was full and the new task was itself the lowest priority, so
    /// its enqueueing was rejected.
    pub queue_full_rejected: u64,
    /// rust_ext: a background task waited past the starvation ceiling and was promoted to run,
    /// bypassing the cooldown (CORE-006).
    pub anti_starvation_promotions: u64,
}

/// Snapshot of the running task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningTaskInfo {
    pub id: u64,
    pub kind: TaskKind,
    pub priority: u8,
    pub file: Option<String>,
}

/// Status snapshot (isomorphic to TS `SchedulerStatus`; keyed tasks in lexicographic key order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulerStatus {
    pub queued: usize,
    pub queued_by_priority: BTreeMap<u8, usize>,
    pub running: Option<RunningTaskInfo>,
    pub completed: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub keyed_tasks: BTreeMap<String, String>,
    pub metrics: SchedulerMetrics,
}
