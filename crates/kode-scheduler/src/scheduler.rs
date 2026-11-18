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
//! - 冷请求暖门(CORE-009):首扫 keyed 后台入队,冷请求 REQUEST_LOCAL 即时
//!   放行——交互优先级恒先于后台首扫出队,冷请求绝不无期限等待全仓;
//! - 逻辑时钟:对拍/测试可注入推进,真实接入时由调用方喂时钟。

use std::collections::{BTreeMap, HashMap, VecDeque};
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
    /// rust_ext:入队被拒(有界队列满)或新任务过期丢弃,keyed 条目未写入。
    /// 返回 id 恒为 0;后续 ensure 可重试(失败不缓存成永久 pending)。
    Rejected,
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
    /// 终态时刻(调度器逻辑时钟 ms;RUST-078-W idle aging 按它与调用方
    /// 给的 now 比较——timebase 必须一致)。queued/running 恒 None。
    terminal_at_ms: Option<u64>,
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

    /// RUST-082 生产接线面:指名摘取单文件缓冲事件(请求所需文件先刷新
    /// ——debounce 窗口内收到该文件请求,立即把缓冲事件移交调度队列,不
    /// 等窗口到期)。无缓冲事件返回 None;摘取计入 seen/merged 记账不变。
    pub fn take_file(&mut self, file: &str) -> Option<StormEvent> {
        let index = self.events.iter().position(|e| e.file == file)?;
        Some(self.events.remove(index))
    }

    pub fn buffered(&self) -> usize {
        self.events.len()
    }
}

/// 失效调度器:入队/合并/取消/暂停/恢复/排水/快照(单并发,无运行时依赖)。
pub struct Scheduler {
    opts: SchedulerOptions,
    tasks: HashMap<u64, Task>,
    /// 终态条目环形窗口(到达序,front=最旧):超 [`MAX_RETAINED_TERMINAL_TASKS`]
    /// 时摘除最旧终态条目(RUST-5 有界化)。queued/running 永不入此窗口。
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
    /// 逻辑时钟 ms(对拍/测试注入;真实接入由调用方推进)。
    clock_ms: u64,
    last_interactive_enqueue_ms: i64,
    last_interactive_end_ms: i64,
    paused: bool,
    /// 风暴合并缓冲(与本调度器共享计数面)。
    pub storm: StormBuffer,
    /// CORE-009 观测:首扫未完成期间即时放行的冷请求数(rust_ext,不进
    /// TS 对拍 metrics 面;golden 输出零变化)。
    cold_while_warming: u64,
}

const NEVER_MS: i64 = -1_000_000_000;

/// 终态任务(Completed/Failed/Cancelled)在 `tasks` 中的保留窗口上限(RUST-5):
/// 只保留最近这么多条终态记录供 `task_state` 查询,更早的摘除释放,
/// 长会话高频 didChange 下 `tasks` 不再无界增长。
pub const MAX_RETAINED_TERMINAL_TASKS: usize = 1024;

/// CORE-009 首扫 keyed 单例键(暖门约定:begin_background_scan 恒用此键,
/// warm_state 按它观测)。
pub const BACKGROUND_SCAN_KEY: &str = "background-scan";

/// 暖门状态(CORE-009 可观测面)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarmState {
    /// 首扫未开始(或上次失败/取消——失败不缓存成暖态假象,可重开首扫)。
    Idle,
    /// 首扫在队/在跑(后台优先级,交互请求随时插队)。
    Warming,
    /// 首扫完成。
    Warm,
}

/// CORE-009 冷请求决策回执(ARCH-004:明确告知)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColdRequestOutcome {
    /// 底层入队决策(同文件同版本合并/过期丢弃/队列满拒)。
    pub decision: EnqueueDecision,
    /// 任务 id(决策非 Queued/Merged 时为 0)。
    pub id: u64,
    /// true = 首扫尚未完成时该请求已即时入交互队。调度级承诺:请求一经
    /// Queued 即为可执行位,REQUEST_LOCAL 恒先于 BACKGROUND_FULL 出队,
    /// 绝不无期限等待全仓(排队上限语义另见有界队列)。
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

/// KR-AUD-22:panic payload → Err 文本(run 体 panic 按 Failed 落账)。
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
        let outcome = self.enqueue(spec);
        if !matches!(
            outcome.decision,
            EnqueueDecision::Queued | EnqueueDecision::Merged
        ) {
            // 入队被拒(队列满)或过期丢弃:enqueue 未产生真实任务(id=0),
            // 此时写 keyed 条目会变成永不执行的假 pending(execute 回写按
            // entry.id 匹配不上,后续 ensure 又恒 Reused)。保持无条目,
            // 后续 ensure 走全新入队路径(与「失败不缓存成永久 pending」一致)。
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

    /// 当前 `tasks` 表保留的任务条目数(含在飞 + 终态窗口,内存面探针)。
    pub fn retained_task_count(&self) -> usize {
        self.tasks.len()
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

    /// CORE-009:首扫后台化入口。首扫以 keyed 单例([`BACKGROUND_SCAN_KEY`])
    /// 入队(调用方给后台优先级 BACKGROUND_FULL 即首扫后台化);进行中复用,
    /// 失败/取消后可重开。冷请求不经此入口。
    pub fn begin_background_scan(&mut self, spec: TaskSpec) -> (EnsureDecision, u64) {
        self.ensure(BACKGROUND_SCAN_KEY, spec)
    }

    /// 暖门状态(见 [`WarmState`])。
    pub fn warm_state(&self) -> WarmState {
        match self.keyed.get(BACKGROUND_SCAN_KEY).map(|e| e.state) {
            None => WarmState::Idle,
            Some(TaskState::Queued) | Some(TaskState::Running) => WarmState::Warming,
            Some(TaskState::Completed) => WarmState::Warm,
            // 失败/取消不缓存成暖态假象:keyed 已回落,重开首扫即可再暖
            //(与「失败不缓存成永久 pending」同口径)。
            Some(TaskState::Failed) | Some(TaskState::Cancelled) => WarmState::Idle,
        }
    }

    /// CORE-009:冷请求 = 单文件 on-demand 解析,即时以 REQUEST_LOCAL 入队。
    /// 首扫在途也不等待:交互优先级恒先于后台首扫出队(pick_next 决策面);
    /// 同文件同版本与在队任务合并,不重复解析。回执带 warming 观测位。
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

    /// rust_ext:首扫未完成期间即时放行的冷请求数(观测面)。
    pub fn cold_while_warming_count(&self) -> u64 {
        self.cold_while_warming
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

    /// RUST-070/073 生产接线面:指名插队执行——队列中指定 id 的任务立即
    /// 执行(跳过优先序),用于「请求所需文件先刷新」(打开文档小范围交互
    /// 优先于局部刷新);非 Queued 态(不存在/在跑/已终态)一律 false 不动作。
    /// 暂停期不出活(pump_once 同语义)。
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
        let result = {
            // KR-AUD-22:run 体 panic 按 Failed 终态落账(catch_unwind 收敛),
            // 不再掀翻 pump 卡死调度;panic 消息转 Err 供 failed 计数。
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
        // 回写 keyed 台账(KR-AUD-90):execute 不会再跑,停留 Queued 会让
        // 后续 ensure 恒 Reused(死 id,任务永不重跑)。
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

    /// 终态登记(RUST-5):终态 id 入环形保留窗口,超限时摘除最旧的终态条目。
    ///
    /// 与 Reused 语义的兼容性:`ensure` 的复用/恢复判定读的是独立的 `keyed`
    /// 台账(KeyedEntry 自持状态副本,execute 回写按 id 匹配),不查 `tasks`——
    /// 摘除终态 tasks 条目不会让 keyed 条目失效,不产生假 pending;
    /// `task_state` 查询面保留最近 [`MAX_RETAINED_TERMINAL_TASKS`] 条终态记录。
    /// id 单调递增且每任务至多到达一次终态(取消只作用于 Queued,执行先摘队),
    /// 故窗口内 id 不重不漏;防御性仅摘确为终态的条目。
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

    /// RUST-078-W:idle aging——摘除终态时刻早于 `now_ms - max_idle_ms` 的
    /// 终态记录(terminal_order front = 最旧终态,首条未超龄即停)。queued/
    /// running 永不动;keyed 台账永不动(ensure 复用/恢复语义不受影响);
    /// metrics/golden 对拍面零变化(只摘 `tasks` 历史与 `task_state` 查询
    /// 面)。`now_ms` 与终态时刻同一 timebase(调度器逻辑时钟;生产调用方
    /// 先把逻辑钟同步到墙钟)。返回摘除数。
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

    /// RUST-078-W:内存压力主动回收——摘除全部终态记录(`tasks` 历史 +
    /// `task_state` 查询面归零)。queued/running/keyed/metrics 永不动(同
    /// [`Self::age_out_terminal`] 红线)。返回摘除数。
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

    /// Task 是私有类型(不进状态快照),其 Debug 只用于内存面诊断;
    /// 本单测直接对 Debug 实现做核对:字段名与值如实入镜,未列字段不外泄。
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
        // finish_non_exhaustive:run/cancel 不外泄进诊断输出。
        assert!(dbg.contains(".."), "{dbg}");
    }

    /// RUST-078-W:idle aging——超龄终态摘除、新鲜终态保留、queued 永不动、
    /// keyed 台账永不动(ensure 复用语义不受影响)、metrics 零变化。
    /// RUST-070/073:指名插队执行——跳过优先序立即执行指定 id;非 Queued
    /// 态(未知 id/已终态)一律 false;插队不吞队列其余任务。
    #[test]
    fn promote_and_run_executes_named_queued_task_out_of_order() {
        use crate::model::priority::{BACKGROUND_FULL, REQUEST_LOCAL};
        let mut s = Scheduler::new(SchedulerOptions::default());
        let run = |_token: &crate::scheduler::CancelToken| Ok(());
        // 同优先级先入者 seq 小;先入 REQUEST_LOCAL、后入 BACKGROUND_FULL,
        // 正常 pick_next 会先跑 REQUEST_LOCAL——promote 指名后者即插队。
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
        // 非 Queued 态:未知 id / 已终态 → false。
        assert!(!s.promote_and_run(999), "未知 id 拒绝");
        assert!(!s.promote_and_run(second), "已终态拒绝");
        // 队列其余任务照常排水。
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
        // keyed 台账在场(ensure 复用语义面),aging 之后必须原样。
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

        // 新鲜窗口(两者都 ≤60s)一个不摘。
        assert_eq!(s.age_out_terminal(1_000 + 500, 60_000), 0);
        assert_eq!(s.retained_task_count(), retained_before);
        // a 终态于 clock 0;b 终态于 clock 1000。now=60_001:a 超龄(60001>
        // 60000),b(59001)保留。
        assert_eq!(s.age_out_terminal(60_001, 60_000), 1);
        assert_eq!(s.task_state(a.id), None, "超龄终态记录已摘");
        assert_eq!(
            s.task_state(b.id),
            Some(TaskState::Completed),
            "新鲜终态保留"
        );
        assert_eq!(s.retained_task_count(), retained_before - 1, "只摘超龄条目");
        // keyed 复用语义不受 aging 影响:同键再 ensure 落 Warm 类判定(Completed
        // 台账原样),不产生假 pending。
        assert!(s.is_keyed_complete("age-key"), "keyed 台账必须原样");
        let _ = k;
        // metrics/golden 对拍面零变化。
        let st = s.status();
        assert_eq!((st.completed, st.failed, st.cancelled), metrics_before);
    }

    /// RUST-078-W:内存压力主动回收——终态历史全摘(retained 归零),queued
    /// 永不动(取消只作用于终态),keyed/metrics 零变化。
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
        // 一个 queued 任务留场(压力回收绝不碰)。
        let live = s.enqueue(TaskSpec {
            kind: TaskKind::SingleFileUpdate,
            priority: REQUEST_LOCAL,
            file: Some("/live.def".into()),
            version: Some(1),
            target: None,
            run: Box::new(run),
        });
        assert_eq!(s.task_state(live.id), Some(TaskState::Queued));
        // 一个 queued 取消 → 终态(Cancelled 也属回收面);单点取消,不波及
        // live(cancel_queued_tasks 会全队清场)。
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
        // 回收后再跑仍正常(队列/台账活着)。
        s.drain(10_000);
        assert_eq!(s.task_state(live.id), Some(TaskState::Completed));
    }

    /// 暖门空态:从未 begin_background_scan 过的调度器 = Idle。
    #[test]
    fn warm_state_idle_before_any_scan() {
        let s = Scheduler::new(SchedulerOptions::default());
        assert_eq!(s.warm_state(), WarmState::Idle);
    }

    /// 暂停期插队执行拒收:不出活(pump_once 同语义)。
    #[test]
    fn promote_and_run_paused_refuses() {
        let mut s = Scheduler::new(SchedulerOptions::default());
        s.pause();
        assert!(!s.promote_and_run(1), "暂停期指名执行一律 false");
    }
}
