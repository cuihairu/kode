//! 任务模型:kind / 优先级 / 状态 / 指标 / 状态快照。
//!
//! 与 TS `src/indexScheduler.ts` 的 `IndexTaskKind` / `IndexTaskPriority` /
//! `IndexTaskState` / `SchedulerMetrics` / `SchedulerStatus` 逐字段对齐
//! (对拍面 = 决策面;字段名/取值/阈值不允许两套语义)。
//! 带 `rust_ext` 注记的字段是 Rust 侧扩展(CORE-006/010 能力面),
//! 不在 TS 对拍范围,序列化时单列。

use std::collections::BTreeMap;

/// 任务类别 = 生命周期阶段(TS `IndexTaskKind` 同名同序)。
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

    /// 台账/golden 反序列化用;未知 kind 拒绝(容错行按损坏计)。
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

/// 优先级(TS `IndexTaskPriority` 同值:数值越小越先)。
pub mod priority {
    /// 当前打开文件的轻量解析。
    pub const CURRENT_FILE_LIGHT: u8 = 0;
    /// 当前请求需要的局部索引。
    pub const REQUEST_LOCAL: u8 = 1;
    /// 受影响依赖更新。
    pub const DEPENDENCY_UPDATE: u8 = 2;
    /// 后台全量索引。
    pub const BACKGROUND_FULL: u8 = 3;
    /// 非交互式全项目分析。
    pub const NON_INTERACTIVE: u8 = 4;

    /// 交互任务 = 会话内用户在等的那几类(TS `isInteractivePriority` 同阈值)。
    pub const fn is_interactive(priority: u8) -> bool {
        priority < BACKGROUND_FULL
    }
}

/// 任务状态(TS `IndexTaskState` 同值)。
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

/// 调度指标。前 5 个字段与 TS `SchedulerMetrics` 同名同义(对拍面);
/// 后 3 个是 Rust 扩展(有界队列/抗饥饿),不在 TS 对拍范围。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SchedulerMetrics {
    /// 同文件同版本合并掉的重复任务数(TS `mergedTasks`)。
    pub merged_tasks: u64,
    /// 过期版本任务取消/丢弃数(TS `staleDropped`)。
    pub stale_dropped: u64,
    /// 后台任务因交互冷却被推迟启动的次数(TS `postponedBackground`)。
    pub postponed_background: u64,
    /// 后台任务因交互限流累计让出的等待时长 ms(TS `backgroundDelayMs`)。
    pub background_delay_ms: u64,
    /// 任务失败/崩溃后重新入队恢复的次数(TS `recoveries`)。
    pub recoveries: u64,
    /// rust_ext:有界队列满,淘汰低优旧任务腾位的次数。
    pub evicted_queue_full: u64,
    /// rust_ext:有界队列满且新任务自己就是最低优,入队被拒的次数。
    pub queue_full_rejected: u64,
    /// rust_ext:后台任务等待超过饥饿上限,绕过冷却晋升执行的次数(CORE-006)。
    pub anti_starvation_promotions: u64,
}

/// 运行中任务快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningTaskInfo {
    pub id: u64,
    pub kind: TaskKind,
    pub priority: u8,
    pub file: Option<String>,
}

/// 状态快照(TS `SchedulerStatus` 同构;keyed 任务按 key 字典序)。
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
