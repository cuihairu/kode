//! 单并发调度核心(与 TS `src/indexScheduler.ts` 行为逐条对齐 + Rust 扩展面)。
//!
//! 对拍面(fixture 驱动,见 [`crate::golden`]):
//! - 同文件同版本合并、优先级取更高者;过期新任务丢弃;队列旧版本取消让位;
//! - 优先级 + seq 公平序(同优先级 FIFO,CORE-006);
//! - 交互任务永远先于后台任务;后台受交互冷却限流(CORE-005/010);
//! - keyed 单例任务:进行中复用、失败/取消后重新入队恢复(不永久 pending);
//! - 取消:按句柄取消 queued 任务、批量取消;运行中不中断。
//!
//! Rust 扩展(TS 无对应,书 §4 能力面):
//! - 有界队列:满时先淘汰最低优/最新序的旧任务;新任务自己最低优则拒入队;
//! - 抗饥饿:后台任务排队超过饥饿上限绕过冷却晋升(CORE-006);
//! - 暂停/恢复:暂停时 pump 不出活,入队照常,恢复后继续;
//! - 逻辑时钟:对拍/测试可注入推进,真实接入时由调用方喂时钟。

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::model::{
    priority, RunningTaskInfo, SchedulerMetrics, SchedulerStatus, TaskKind, TaskState,
};

/// 取消令牌:运行体在协作点轮询;queued 任务取消由调度器直接摘除。
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

/// 任务体:拒绝 = 该次尝试失败(可恢复,不算永久状态,与 TS `run` 语义一致)。
/// 运行体应在协作点检查 [`CancelToken`] 尽早让出。
pub type RunFn = dyn FnOnce(&CancelToken) -> Result<(), String>;

/// 任务入参(与 TS `IndexTaskSpec` 同构;`run` 为同步闭包,本 crate 不引入运行时)。
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

/// 入队决策(对拍面:TS 侧由计数器差分推导出同值决策串)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueDecision {
    /// 正常入队(含同文件旧版本被取消让位——新任务本身入队成功)。
    Queued,
    /// 合并进同文件同版本的在队任务(优先级取更高者)。
    Merged,
    /// 新任务比在队同文件任务旧:丢弃(过期)。
    StaleDropped,
    /// rust_ext:有界队列满且新任务自己最低优,拒绝入队。
    RejectedQueueFull,
}

/// keyed 单例任务决策(TS `ensureTask` 行为面)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureDecision {
    /// 首次入队(或上次已完成后重跑)。
    Queued,
    /// 同 key 进行中,直接复用。
    Reused,
    /// 上次失败/取消后重新入队(计入 recoveries)。
    Recovered,
}

/// 单步 pump 结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pump {
    /// 执行了一个任务至终态。
    Ran,
    /// 队列空(或没有可执行任务)。
    Idle,
    /// 队首后台任务被交互冷却挡住,建议 ms 后再试。
    Postponed { retry_in_ms: u64 },
    /// 已暂停(pause 面不出活)。
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
    #[allow(dead_code)] // 运行体执行后即释放;保留字段对齐 TS 生命周期语义
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
    /// 交互冷却窗口 ms(TS `interactiveCooldownMs`,默认 50)。
    pub interactive_cooldown_ms: u64,
    /// rust_ext:后台任务排队饥饿上限 ms,超过则绕过冷却(CORE-006,默认 5000)。
    pub starvation_limit_ms: u64,
    /// rust_ext:有界队列上限;None = 无界(TS 现状)。
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

/// 入队结果(风暴缓冲消费用)。
#[derive(Debug, Clone)]
pub struct StormEvent {
    pub file: String,
    pub version: u64,
    pub priority: u8,
}

/// 风暴合并缓冲(CORE-017 通知合并决策面):窗口内同文件多事件并一,
/// 最新版本胜出、优先级取更高者;缓冲超限强制落盘(防风暴无限积压)。
#[derive(Debug)]
pub struct StormBuffer {
    events: Vec<StormEvent>,
    max_buffered: usize,
    /// 累计收到的事件数。
    pub events_seen: u64,
    /// 被合并掉的事件数(events_seen - 落队数)。
    pub merged: u64,
    /// 缓冲超限触发强制 flush 的次数。
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

    /// 记录一次变更事件;返回 true = 与缓冲内同文件事件合并(最新版本胜出、
    /// 优先级取更高者),false = 新文件事件入缓冲。
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
                // 防风暴无限积压:缓冲超限先强制落一批(事件不丢,进调度队列)。
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

    /// 取出并清空缓冲(每个文件一条,插入序稳定)。
    pub fn flush(&mut self) -> Vec<StormEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn buffered(&self) -> usize {
        self.events.len()
    }
}

/// 失效调度器:入队/合并/取消/暂停/恢复/排水/快照(单并发,无运行时依赖)。
pub struct Scheduler {
    opts: SchedulerOptions,
    tasks: HashMap<u64, Task>,
    queue_order: Vec<u64>,
    running: Option<u64>,
    next_id: u64,
    next_seq: u64,
    completed: u64,
    failed: u64,
    cancelled: u64,
    keyed: BTreeMap<String, KeyedEntry>,
    pub(crate) metrics: SchedulerMetrics,
    /// 逻辑时钟 ms(对拍/测试注入;真实接入由调用方推进)。
    clock_ms: u64,
    last_interactive_enqueue_ms: i64,
    last_interactive_end_ms: i64,
    paused: bool,
    /// 风暴合并缓冲(与本调度器共享计数面)。
    pub storm: StormBuffer,
}

const NEVER_MS: i64 = -1_000_000_000;

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

impl Scheduler {
    pub fn new(opts: SchedulerOptions) -> Scheduler {
        Scheduler {
            opts,
            tasks: HashMap::new(),
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
        }
    }

    /// 推进逻辑时钟(对拍 advance op;不触发任何任务)。
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

    /// 入队一个任务(合并/过期判定/有界队列后落队)。
    pub fn enqueue(&mut self, spec: TaskSpec) -> EnqueueOutcome {
        if priority::is_interactive(spec.priority) {
            self.last_interactive_enqueue_ms = self.clock_ms as i64;
        }

        // 同文件合并/过期判定:只对带 file 的任务生效(首扫等无文件任务不合并)。
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
                // 同文件同版本:合并为一条,优先级取更高者(数值更小)。
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
                // 新任务比队列里已有的同文件任务旧:丢弃新任务(过期)。
                self.metrics.stale_dropped += 1;
                return EnqueueOutcome {
                    decision: EnqueueDecision::StaleDropped,
                    id: 0,
                };
            }

            // 队列里有同文件的更旧版本任务:取消丢弃,让位新版本。
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

        // rust_ext 有界队列:满时先淘汰最低优/最新序旧任务;新任务自己最低优则拒。
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

    /// keyed 单例任务(首扫等):同 key 进行中直接复用;上次失败/取消后重新入队
    /// ——失败不缓存成永久 pending,后续请求可恢复(与 TS `ensureTask` 一致)。
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
        if recovered {
            self.metrics.recoveries += 1;
        }
        let outcome = self.enqueue(spec);
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

    /// keyed 任务是否已完成(状态查询便捷面,与 TS `isKeyedComplete` 一致)。
    pub fn is_keyed_complete(&self, key: &str) -> bool {
        self.keyed
            .get(key)
            .is_some_and(|e| e.state == TaskState::Completed)
    }

    /// 任务状态查询。
    pub fn task_state(&self, id: u64) -> Option<TaskState> {
        self.tasks.get(&id).map(|t| t.state)
    }

    /// 取消一个 queued 任务(运行中不中断;返回是否确实取消了)。
    pub fn cancel(&mut self, id: u64, reason: &str) -> bool {
        self.cancel_queued(id, reason)
    }

    /// 取消所有排队任务(运行中的不中断);返回取消数(与 TS 同口径)。
    pub fn cancel_queued_tasks(&mut self, reason: &str) -> usize {
        let ids: Vec<u64> = self.queue_order.clone();
        let count = ids.len();
        for id in ids {
            self.cancel_queued(id, reason);
        }
        count
    }

    /// 单步执行:取队首可执行任务并同步跑至终态。
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

    /// 排水:连续执行直至队列空/暂停/冷却阻塞;冷却阻塞时按建议推进逻辑时钟,
    /// 但不超过 `max_wait_ms` 预算(对拍 drain op)。
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

    /// 状态快照。
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

    /// 台账导出:当前 queued 任务的恢复记录(崩溃恢复写盘面)。
    /// 排序 = (priority, file),恢复入队顺序与调度优先序一致。
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
            // 优先级顺序:交互任务永远先于后台任务。
            return Pick::Task(head_id);
        }
        // 后台限流:交互冷却窗口内不启动后台任务。
        let since = self.clock_ms as i64 - self.last_interactive_ms();
        if since < self.opts.interactive_cooldown_ms as i64 {
            let waited = self
                .clock_ms
                .saturating_sub(self.tasks.get(&head_id).map(|t| t.enqueued_ms).unwrap_or(0));
            if waited >= self.opts.starvation_limit_ms {
                // rust_ext 抗饥饿:排队超过上限,绕过冷却晋升(CORE-006)。
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
        let result = run(&cancel);
        let interactive = self
            .tasks
            .get(&id)
            .is_some_and(|t| priority::is_interactive(t.priority));
        let final_state = if result.is_ok() {
            self.completed += 1;
            TaskState::Completed
        } else {
            // 失败不缓存「已扫描」假象:keyed 条目回落 failed,后续请求重跑。
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
        if reason == "stale-version" {
            self.metrics.stale_dropped += 1;
        }
        true
    }
}

enum Pick {
    None,
    Task(u64),
    Postponed { retry_in_ms: u64 },
}
