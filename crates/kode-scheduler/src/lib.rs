//! kode-scheduler:失效调度器(kode2 PR-009,书 §4 CORE-005..008/017 +
//! §7 IDX-003/013/015 调度面 + §17 PR-009「reverse DAG、任务优先级与 cancel」基础版)。
//!
//! 模块:
//! - [`model`] 任务模型:kind/五级优先级/状态/指标/状态快照(与 TS `src/indexScheduler.ts`
//!   调度面字段一一对应,对拍面 = 决策面,不允许两套语义);
//! - [`scheduler`] 单并发调度核心:同文件同版本合并、过期版本丢弃/取消、
//!   优先级+seq 公平序、交互冷却限流(CORE-005/006/008/010 基础版)、
//!   抗饥饿晋升、有界队列淘汰、暂停/恢复、取消(cancel token + 批量);
//! - [`invalidation`] 失效图:文件 → 声明名 → 反向受影响集(§17 reverse DAG
//!   基础版,复用 kode-index 名称倒排/反向依赖)+ 分批重建计划(确定性切块);
//! - [`journal`] 崩溃恢复台账:临时文件 + 原子 rename 写入、容错逐行解析、
//!   恢复时按当前版本过滤过期任务;
//! - [`golden`] 与 TS IndexScheduler 调度面对拍 golden:场景 fixture 驱动,
//!   与 PR-005/006/007 双向门禁同构(按 ARCH-012 不做性能对比)。
//!
//! 编号说明:任务单引用「SCHED-001..021(书第 10 章)」;书 §10 实为 KBE-*
//! 工程条目,全篇无 SCHED-* 编号(与 PR-007 遇到的「任务书编号 vs 书条目」
//! 情形一致)。本单按书实际条目落地:调度行为面 = §4 CORE-005/006/007/008/017
//! + §7 IDX-003/013/015 + §17 PR-009;SCHED-001..021 作为本单内部验收清单
//!   落在 docs/kode2/pr-009.md(逐条映射书条目,不冒领书外能力面)。
//!
//! 铁律:零第三方 crate(仅依赖 workspace 内 kode-index/kode-vfs)。

pub mod golden;
pub mod invalidation;
pub mod journal;
pub mod model;
pub mod scheduler;

pub use invalidation::{plan_dependency_tasks, InvalidationGraph};
pub use journal::{load_journal, write_journal, RecoveryReport, TaskRecord};
pub use model::{SchedulerMetrics, SchedulerStatus, TaskKind, TaskState};
pub use scheduler::{
    CancelToken, EnqueueDecision, EnsureDecision, Pump, Scheduler, SchedulerOptions, StormBuffer,
    TaskSpec,
};

pub use kode_index::DocumentKey;
pub use kode_vfs::store::RootId;
