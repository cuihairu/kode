//! RUST-075-W worker 执行器装配:执行归属登记 + 真 worker 池。
//!
//! 形态:`$/kode/rpc` 注册面 handler 是纯函数(`fn(Value) -> Result`)、
//! 零 ServerState 依赖(TS 读盘直传,不碰镜像语料)——这类请求走 worker
//! 线程执行,主线程 stdio 泵持续读取/响应,重任务在飞时健康/轻请求照常
//! 先回。准入不变量(交互预留/后台硬顶/总量守恒/释放记账)全部由
//! kode-scheduler `WorkerPoolGate` 持有,本模块只接线不另立决策核。
//!
//! 取消(CORE-007 + RUST-072):排队未启动的 job 即刻摘除回 -32800(容量
//! 未占);在途 job 登记丢弃标记 + 置位该请求的取消令牌——handler 协作点
//! (kode-python cancel 探针)查询令牌提前退出,绝不产出部分结果;终态
//! (含被中断的 Err)一律释放容量,结算按三源裁定 Cancelled(-32800):
//! 弹出前登记表/在途丢弃登记表/handler 自报取消文案(无 span 的 job 以
//! handler 文案为诚实源)。丢弃登记只在确有本池 job(排队摘除命中或
//! submit 登记过 span)时写入——未知 id/重复/迟到取消不入表,表有界。

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

/// 执行归属:顶层 method 臂 → 执行位置决策面。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionLane {
    /// 主线程内联:快速 serving 面(hover/completion/definition/diagnostic/
    /// health/workspace/*)与顺序语义面(initialize/shutdown/exit/wait)。
    Inline,
    /// worker 池:`$/kode/rpc` 纯 handler 面。
    Pool(PoolLane),
}

/// 池内泳道:交互(用户语义请求)或后台(首扫/报表;当前生产无真实后台
/// 调用方,RUST-074-W 落地时在此登记对应内层 method 的泳道)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PoolLane {
    Interactive,
    Background,
}

/// RUST-076-W:真实阻塞 IO / 外部进程等待的内层 method 显式登记表。表内
/// 面归 `LaneGate::Io`(阻塞读盘/子进程 shell-out),其余注册面一律
/// `Cpu`(纯解析)。归属完整性由 tests/executor_ownership.rs 对
/// snapshot.methods() 全量断言:漏登记的面走 Cpu 缺省(仍能跑),表内
/// 登记了已注销的面则红(防陈旧登记)。
const IO_TASK_METHODS: &[&str] = &[
    "$/kode/dbClone/export",
    "$/kode/dbClone/inspectArchive",
    "$/kode/dbClone/readArchiveRows",
    "$/kode/ruff/format",
    "$/kode/ruff/lint",
    "$/kode/workspace/scanAnchors",
];

/// 单一分类源:`$/kode/rpc` 内层 method → (池泳道, LaneGate 类别)。
/// 表内 IO 面 → Background+Io(慢 IO 不占交互预留位);其余 → Interactive
/// +Cpu。cpu_max/io_max 之外,交互请求恒经 WorkerPoolGate 交互预留位准入
/// (LaneGate::Interactive 恒可入),两类硬顶都拦不住交互面。
pub fn rpc_lane_class(inner: &str) -> (PoolLane, TaskLane) {
    if IO_TASK_METHODS.contains(&inner) {
        (PoolLane::Background, TaskLane::Io)
    } else {
        (PoolLane::Interactive, TaskLane::Cpu)
    }
}

/// 池泳道归类(IO 表面归后台泳道,与 RUST-074-W 暖门首扫同池不占交互位)。
pub fn rpc_pool_lane(inner: &str) -> PoolLane {
    rpc_lane_class(inner).0
}

/// LaneGate 准入类别归类(分类单一源的第二投影)。
pub fn rpc_job_kind(inner: &str) -> TaskLane {
    rpc_lane_class(inner).1
}

/// RUST-076-W:worker 数 → LaneGate 预算。结构性约束:io+cpu ≤ total-1
/// (恒留 ≥1 个 worker 给交互预留位;WorkerPoolGate 的 interactive 配额
/// 是准入闸,LaneGate 预算是 worker 占用闸,两层叠加)。库
/// `LaneBudget::from_total` 在 N=2 会给出 io_max=0(饿死 2 核 CI 的 IO
/// 面),此处自定:≥2 核 io ≥ 1;1 核机两泳道皆 0(全给交互)。
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

/// 主分派环入口的执行归属决策。`$/kode/rpc` 按内层 method 归池;params
/// 形状非法(无内层 method)→ Inline,由 server 原样走 INVALID_PARAMS
/// 错误路径(口径不变,不因分类器抢答)。
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

/// 池记账快照(健康面 `$/kode/health` 的 `pool` 键;无执行器装配时省略)。
/// RUST-076-W:`ioRunning`/`cpuRunning` = LaneGate 泳道在飞(准入/释放
/// 观测;交互预留位经 WorkerPoolGate interactive 口径呈现,不重复计)。
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

/// 一个待执行 job(纯 handler 调用;worker 零共享状态)。
#[derive(Debug)]
pub struct Job {
    pub id: RequestId,
    pub method: String,
    pub params: Value,
    pub lane: PoolLane,
    /// RUST-076-W:LaneGate 准入类别(真实 IO/外部进程等待 = Io,CPU 解析
    /// = Cpu)。生产路径经 `rpc_job_kind` 分类;交互队列 job 的准入恒走
    /// Interactive 预留位(kind 只作登记,CPU/IO 硬顶绝不拦交互)。
    pub kind: TaskLane,
    /// RUST-068-W:跨任务追踪 id(TS 请求入口生成,信封级透传;缺省 None
    /// =无 span 的纯服务端发起调用)。日志面只印 span 不印 params(脱敏)。
    pub span: Option<String>,
}

/// 执行终态:Done=成功回值 / Failed=handler Err(映射 -32602 或 -32601) /
/// Cancelled=取消(排队摘除或在途丢弃,映射 -32800)。
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
    /// RUST-068-W:回包侧日志携带同一 span(与 Job 同源透传)。
    pub span: Option<String>,
}

/// 终态 → LSP 响应映射:与 server.rs `handle_rpc` 同口径(Err 文案
/// "method not found" 开头 → -32601,其余 → -32602;取消 → -32800,与
/// `$/kode/wait` 取消语义一致)。集中一处防双写漂移。
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
    /// RUST-076-W:IO/CPU 泳道准入记账(真实阻塞面与 CPU 解析面各持独立
    /// 硬顶,io+cpu ≤ workers-1 结构性保交互预留)。准入/释放全在此锁内,
    /// 与队列同锁——无锁跨线程重排。
    lane_gate: LaneGate,
    interactive: VecDeque<Job>,
    background: VecDeque<Job>,
    /// 取消时在途(或刚弹出未启动)的 job id;执行前/后按此丢弃。
    running_cancelled: HashSet<RequestId>,
    /// RUST-068-W:在途/排队 job 的 span 表(submit 插入,终态摘除)——
    /// 取消/回包日志按 id 回捞 span;容量=未决 job 数,天然有界。
    spans: std::collections::HashMap<RequestId, String>,
    /// RUST-072:在途 job 的取消令牌(worker 弹出时登记,终态摘除)——
    /// cancel 命中即置位,handler 经 kode-python 探针协作点提前退出;
    /// 容量=在途 job 数,天然有界。
    running_tokens: HashMap<RequestId, Arc<AtomicBool>>,
    draining: bool,
}

/// worker 池执行器:main 线程持有,worker 数 = 预算总量。
pub struct PoolExecutor {
    shared: Arc<ExecShared>,
    /// 线程句柄 Drop 时 join(shutdown 语义:不再受理,排空后退出)。
    handles: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

impl std::fmt::Debug for PoolExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // worker/记账面经健康 pool 键对账,Debug 只报身份不展开内部锁。
        f.debug_struct("PoolExecutor").finish_non_exhaustive()
    }
}

impl PoolExecutor {
    /// 装配执行器:预算不自洽即 panic(绝不带病运行,与 gate 口径一致)。
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

    /// 健康面共享的记账快照 cell(ServerState.pool_stats 指向同一份)。
    pub fn stats_cell(&self) -> Arc<Mutex<PoolStats>> {
        Arc::clone(&self.shared.stats_cell)
    }

    /// 提交一个 job;draining(退出中)静默弃置——唯一提交方是主循环泵,
    /// 它先于 shutdown 停摆,此分支只兜极窄的收尾竞态窗。
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

    /// 取消一个请求:排队未启动 → 摘除回 -32800(容量未占,不入丢弃登记
    /// ——离队 job 永不执行,登记无人结算);在途 → 置位取消令牌 + 丢弃
    /// 标记,执行完成后容量照常释放、结果丢弃回 -32800。未知/重复/迟到
    /// id 不入任何表(RUST-072 有界化,长跑不膨胀)。
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
            // RUST-072:在途令牌命中即置位(handler 协作点查询提前退出)。
            if let Some(token) = state.running_tokens.get(id) {
                token.store(true, Ordering::SeqCst);
            }
            // RUST-072 有界化:丢弃标记只在 job 仍可能被执行时写入——在途
            // 令牌表命中,或弹出未登记令牌的窄窗(已离队但 worker 手里,
            // span 表命中)。排队摘除的 job 已离队永不执行,不入表(否则
            // 登记无人结算摘除,长跑排队取消泄漏);未知 id(内联请求/重复/
            // 迟到取消)同样不入表。表容量 ≤ 在途 job 数,长跑有界。
            if state.running_tokens.contains_key(id)
                || (!removed.is_some() && state.spans.contains_key(id))
            {
                state.running_cancelled.insert(id.clone());
            }
            // RUST-068-W:span 回捞两态——排队摘除=终态即本回执,span 随表
            // 摘除随回执携带;在途丢弃=终态在 worker 结算段,span 留表
            // (worker 回包携带),取消留痕只读克隆。此前在途也无条件摘表:
            // worker 结算捞空 → 终态回执丢 span(排队摘除与 worker 弹出的
            // 竞窗内必现,win32-arm64 夜构建 span_table 用例实红)。
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

    /// 未决 job 的 span 表深度(测试/健康对账口;终态即摘除,天然有界)。
    pub fn outstanding_spans_for_tests(&self) -> usize {
        self.shared
            .state
            .lock()
            .expect("pool state lock")
            .spans
            .len()
    }

    /// RUST-072:取消丢弃登记表深度(测试口;验收「长跑登记表有界」——
    /// 未知 id/迟到取消不入表,终态即摘除,容量 ≤ 未决+在途 job 数)。
    pub fn pending_cancel_registrations_for_tests(&self) -> usize {
        self.shared
            .state
            .lock()
            .expect("pool state lock")
            .running_cancelled
            .len()
    }

    /// 停止受理新 job,worker 排空已受理队列后退出(受理即欠回包,不弃置),
    /// join 全部 worker(退出路径;阻塞至在途 handler 完成)。
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

/// RUST-068-W:取消留痕(span 缺省印 `-`;只印 id/span,不印 params——脱敏)。
fn log_cancel(id: &RequestId, span: Option<&str>) {
    eprintln!(
        "[kode-server] request {id} cancelled (pool span={})",
        span.unwrap_or("-")
    );
}

/// 从队列摘除目标 id 的排队 job(取消路径;容量未占,无需记账释放)。
fn remove_queued(queue: &mut VecDeque<Job>, id: &RequestId) -> Option<Job> {
    let index = queue.iter().position(|job| &job.id == id)?;
    queue.remove(index)
}

/// 按闭包改记账并同步健康面 cell(gate 与 lane_gate 运行数在每次记账变更
/// 后刷新;cell 只在队列锁内短持,健康路径只持 cell 锁,无反向持锁)。
/// RUST-076-W:交互在飞经 WorkerPoolGate interactive 口径呈现,LaneGate
/// 的 Interactive 记数不重复出表;io/cpu 两泳道由 LaneGate 直接对账。
fn bump_stats(cell: &Mutex<PoolStats>, state: &ExecState, f: impl FnOnce(&mut PoolStats)) {
    if let Ok(mut stats) = cell.lock() {
        stats.interactive_running = state.gate.interactive_running();
        stats.background_running = state.gate.background_running();
        stats.io_running = state.lane_gate.running(TaskLane::Io);
        stats.cpu_running = state.lane_gate.running(TaskLane::Cpu);
        f(&mut stats);
    }
}

fn worker_loop(shared: Arc<ExecShared>) {
    loop {
        // 取 job 段:锁内只做队列摘取与准入记账,handler 在锁外执行。
        // RUST-076-W:准入分两层——LaneGate(IO/CPU/交互泳道记账,先)+
        // WorkerPoolGate(交互预留位配额,后);任一层拒即按已准入侧回滚,
        // job 如实回队等容量(condvar wait,不忙旋)。
        let (job, admitted_lane) = {
            let mut state = shared.state.lock().expect("pool state lock");
            'pick: loop {
                // draining(退出中):排空已受理队列再退——受理过的请求都欠
                // 回包,静默弃置会破坏与内联路径的回包平价。
                if state.draining && state.interactive.is_empty() && state.background.is_empty() {
                    return;
                }
                // 交互优先:预留位语义——后台满载/排队也拦不住交互请求。
                // 交互面准入恒走 LaneGate::Interactive(恒可入,直至总量
                // 满),kind 只是登记,CPU/IO 硬顶绝不拦交互。
                if let Some(job) = state.interactive.pop_front() {
                    let lane_admitted = state.lane_gate.try_admit(TaskLane::Interactive);
                    let gate_admitted = lane_admitted && state.gate.try_admit_interactive();
                    if gate_admitted {
                        bump_stats(&shared.stats_cell, &state, |_| {});
                        break 'pick (job, TaskLane::Interactive);
                    }
                    // 理论不可达(worker=total,空闲线程弹出时必有余位);
                    // 如实回队等容量,绝不越记账(已准入侧先回滚)。
                    if lane_admitted && !gate_admitted {
                        state.lane_gate.release(TaskLane::Interactive);
                    }
                    state.interactive.push_front(job);
                } else if let Some(&head_kind) = state.background.front().map(|job| &job.kind) {
                    // 后台队:按队头 job 的 kind 准入泳道(IO/CPU 各持硬顶,
                    // 分离语义——IO 饱和不压 CPU,反之亦然),再过 gate 配额。
                    // 队头不动(FIFO 保序),泳道拒绝即整队等待——不重排
                    // 不插队,与空队列同走 condvar wait。
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
        // RUST-072:登记本 job 取消令牌(锁内登记,cancel 三查窗口一致)并
        // 设进本线程探针——handler 协作点(kode-python)据此提前退出。
        let cancel_token = Arc::new(AtomicBool::new(false));
        {
            let mut state = shared.state.lock().expect("pool state lock");
            state
                .running_tokens
                .insert(job.id.clone(), Arc::clone(&cancel_token));
        }
        kode_python::cancel::set_probe(Some(Arc::clone(&cancel_token)));
        // RUST-068-W:worker 侧起跑留痕(跨任务追踪面;只印 id/method/span)。
        eprintln!(
            "[kode-server] pool job {} {} start (span={})",
            job.id,
            job.method,
            job.span.as_deref().unwrap_or("-")
        );
        // 弹出前已取消(排队摘除窗口外)的 id:按取消短路,不执行 handler。
        let cancelled_before = {
            let mut state = shared.state.lock().expect("pool state lock");
            state.running_cancelled.remove(&job.id)
        };
        let outcome_status = if cancelled_before {
            JobStatus::Cancelled
        } else {
            // 纯 handler 执行(锁外;worker 零共享状态)。
            match shared.snapshot.dispatch(&job.method, job.params) {
                Ok(value) => JobStatus::Done(value),
                Err(msg) => JobStatus::Failed(msg),
            }
        };
        // 结算段:释放记账 + 终态计数 + 回包(在途取消在此丢弃结果)。
        // RUST-072:取消裁定三源并列——弹出前登记表、在途丢弃登记表、
        // handler 自报取消文案(协作点 Err;无 span 的 job 不经 span 表,
        // 以 handler 文案为诚实源,绝不落 -32602 冒充参数错)。
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
        // RUST-076-W:泳道位与 gate 配额同批释放(取消/失败照常释放——
        // 无占位泄漏;release 拒下溢即准入/释放错配 = 装配 bug)。
        let lane_released = state.lane_gate.release(admitted_lane);
        if !released || !lane_released {
            // 准入/释放错配 = 装配 bug:stderr 留痕不 panic(server 健壮性)。
            eprintln!("[kode-server] pool release without admission (bug)");
        }
        bump_stats(&shared.stats_cell, &state, |stats| match final_status {
            JobStatus::Done(_) => stats.jobs_done += 1,
            JobStatus::Failed(_) => stats.jobs_failed += 1,
            JobStatus::Cancelled => stats.jobs_cancelled += 1,
        });
        // span/令牌表随终态摘除(容量=未决/在途 job 数,天然有界)。
        let span = state.spans.remove(&job.id);
        state.running_tokens.remove(&job.id);
        drop(state);
        // RUST-072:清本线程探针(worker 线程复用,防串 job)。
        kode_python::cancel::set_probe(None);
        let _ = shared.done_tx.send(JobOutcome {
            id: job.id,
            lane: job.lane,
            status: final_status,
            span,
        });
        // 容量已释放:等待中的后台/交互可以取 job。
        shared.signal.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::RpcRegistry;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    /// 测试慢 handler 协调器:静态位(fn 指针不能捕获)。各测试用互不重叠
    /// 的 ticket 段,跨测试零串扰(cargo test 并行安全)。
    fn hold() -> &'static (Mutex<Vec<u32>>, Condvar) {
        static HOLD: std::sync::OnceLock<(Mutex<Vec<u32>>, Condvar)> = std::sync::OnceLock::new();
        HOLD.get_or_init(|| (Mutex::new(Vec::new()), Condvar::new()))
    }

    /// PoisonError 容错:worker panic 中毒后,测试协调面照常拿锁工作,
    /// 不让单个测试的 panic 连坐整组(PoisonError 连坐前科:CI 实红)。
    fn hold_lock() -> std::sync::MutexGuard<'static, Vec<u32>> {
        hold().0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 慢机容忍:有界等待的拍数上限环境感知。缺省 3000 与历史口径一致
    /// (20ms 拍≈60s);CI 慢机由 workflow 设 KODE_TEST_TICK_BUDGET=9000 放宽。
    fn tick_budget() -> usize {
        std::env::var("KODE_TEST_TICK_BUDGET")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000)
    }

    /// fn 指针 handler:登记 ticket 后阻塞,直到放行号(ticket+1000)出现。
    /// notify 驱动的真等待:单拍到 deadline,release 的 notify_all 提前唤醒
    /// (spurious wakeup 由 contains 循环吸收),无逐拍轮询;总时长有界
    /// (tick_budget×20ms,缺省 60s/CI 180s)——测试侧 panic 后孤儿 worker
    /// 也能自行超时退出,不挂死 CI(纯 wait() 无界版实测挂死)。
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

    /// 放行指定 ticket(测试协调面)。
    fn release(ticket: u32) {
        let mut waiting = hold_lock();
        waiting.push(ticket + 1000);
        drop(waiting);
        hold().1.notify_all();
    }

    /// RUST-072 可取消 handler:登记 ticket 后轮询本线程取消探针(与生产
    /// kode-python 协作点同一查询通道);取消 → Err(取消文案),否则等放行。
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

    /// 等到 handler 登记了指定 ticket(worker 真正开跑的可观察面)。
    /// 有界等待:调度面回归(交互永不入)时红而非挂死。
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
        // 缺省 kind 与生产分类同构:后台队列=Io 面,交互队列=Cpu 面
        // (交互准入恒走 Interactive 预留位,kind 只登记)。
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
        // 结构性约束:io+cpu ≤ workers-1(恒留交互预留位);≥2 核 io ≥ 1
        // (库 from_total 在 N=2 给 io=0 会饿死 IO 面);1 核全给交互。
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
        // IO 表五面 → Background+Io(慢 IO 不占交互位)。
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
        // 其余注册面缺省 Interactive+Cpu(纯解析)。
        assert_eq!(
            rpc_lane_class("$/kode/echo"),
            (PoolLane::Interactive, TaskLane::Cpu)
        );
        assert_eq!(
            rpc_lane_class("$/kode/python/selfAttributeFlow"),
            (PoolLane::Interactive, TaskLane::Cpu)
        );
        // 单一分类源的两投影一致。
        for method in ["$/kode/ruff/lint", "$/kode/echo"] {
            assert_eq!(rpc_pool_lane(method), rpc_lane_class(method).0);
            assert_eq!(rpc_job_kind(method), rpc_lane_class(method).1);
        }
    }

    #[test]
    fn io_saturation_does_not_block_cpu_and_interactive_lanes() {
        // total=4 → io_max=1, cpu_max=2。IO 满 + CPU 满 + 交互在飞同时成立
        // (4 worker 全占),且 CPU 满载后第 4 个 CPU job 排队——交互仍立入。
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
        // 第 4 个 CPU job:CPU 泳道硬顶(2)与 gate 后台配额(3)双双满载
        // ——排队等容量,绝不越记账(80ms 静置观察期;若越权启动,505 交互
        // 将无 worker 可用,wait_started 红即越权面)。
        executor.submit(job_with_kind(
            504,
            "$/kode/test/blocking",
            PoolLane::Background,
            TaskLane::Cpu,
        ));
        std::thread::sleep(Duration::from_millis(80));
        // 交互面在 CPU 满 + IO 满时仍立即可入(预留位语义)。
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
        // CPU 位释放:排队 CPU job 依序入(IO 位仍满不拦 CPU)。
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
        // total=2 → io_max=1。排队 IO job 取消:即刻回 -32800,泳道零占位;
        // 后续 IO job 在位释放后照常准入(无占位泄漏)。
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
        // 泳道位已释放:新 IO job 可执行(取消不留占位)。
        executor.submit(job(603, "$/kode/test/blocking", PoolLane::Background));
        wait_started(603);
        assert_eq!(stats_of(&executor).io_running, 1);
        release(603);
        drop(executor);
    }

    #[test]
    fn failing_io_job_releases_lane_slot() {
        // IO job 失败(handler Err):泳道位照常释放,后续 IO job 不饿死。
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
        // 确定性排队:701/703 两张 wait_started 占满 total=2 的两个 worker,
        // 702 提交时准入必拒(交互预留位也满),必走「排队→取消摘除」路径。
        // 不再依赖主线程 cancel 抢在 worker 唤醒前拿锁的竞速——CI 慢机
        // 实红前科:worker 先弹起则 702 在途,cancel 走在途路径 span 留表,
        // 断言 2≠1 必红(try_admit_interactive「总占用<total 恒放行交互」)。
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
        // 通道里三张回执到达序不定:按 id 分捡齐(701/703 完成+702 取消)。
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
        // 回归钉:在途丢弃路径的取消不得从 span 表摘走 span——终态回执由
        // worker 结算段产出,span 留表才能随回包携带(排队摘除路径已由
        // span_table 用例覆盖;此前的无条件摘表让 worker 结算捞空,win32
        // 夜构建实红)。确定性:起跑后再取消,不走排队竞窗。
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        // ticket 841:独立段(cancellable 用例同段 801 曾撞车——全局 hold
        // 登记表跨池共享,票号重叠会让 wait_started 被他人登记误触发)。
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
        // PoisonError 容错:与 hold 面同款,panic 后记账观察不连坐。
        *executor
            .shared
            .stats_cell
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 等到记账进入期望运行态(轮询,超时即断言失败)。
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
        // 形状非法:回 Inline,由 server 走原 INVALID_PARAMS 路径。
        assert_eq!(
            execution_lane("$/kode/rpc", Some(&serde_json::json!({}))),
            ExecutionLane::Inline
        );
        assert_eq!(execution_lane("$/kode/rpc", None), ExecutionLane::Inline);
        // 顶层 serving 面恒 Inline。
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
        // 先占掉唯一后台位,再排一个后台,最后排交互:交互必须越过排队后台。
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
        // 空出的后台位让排队 job 102 得以执行。
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
        // 后台满载:交互仍立即可入(预留位语义)。
        executor.submit(job(209, "$/kode/test/blocking", PoolLane::Interactive));
        wait_started(209);
        wait_running(&executor, 1, 1);
        release(209);
        release(201);
        // 空出的后台位:排队 job 依序入。
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
        // 302 排队中取消:即刻回 -32800,不占容量。
        executor.cancel(&RequestId::Number(302));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Cancelled));
        let stats = stats_of(&executor);
        assert_eq!(stats.jobs_cancelled, 1);
        assert_eq!(stats.interactive_running, 1, "在途 301 未受影响");
        // 放行 301:302 不得复活。
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
        // 释放后容量恢复:新 job 可执行。
        executor.submit(job(402, "$/kode/echo", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Done(_)));
        drop(executor);
    }

    #[test]
    fn cancel_running_flips_token_handler_exits_early_and_settles_cancelled() {
        // RUST-072 核心面:在途取消 → cancel 置位令牌 → handler 协作点探针
        // 提前退出(真中断,不等 handler 自然跑完)→ 结算 Cancelled(-32800),
        // 容量即刻回收,轻请求不被占用。
        let (executor, rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(1));
        executor.submit(job(801, "$/kode/test/cancellable", PoolLane::Interactive));
        wait_started(801);
        let cancel_at = std::time::Instant::now();
        executor.cancel(&RequestId::Number(801));
        let outcome = recv_outcome(&rx);
        // handler 每 10ms 查一次探针:提前退出应在秒级内到账(自然跑完也
        // 有界,但取消路径必须明显快于放行路径——这里没有放行,唯一出口
        // 就是取消)。
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
        // 回收后轻请求照常立即可入。
        executor.submit(job(802, "$/kode/echo", PoolLane::Interactive));
        let outcome = recv_outcome(&rx);
        assert!(matches!(outcome.status, JobStatus::Done(_)));
        drop(executor);
    }

    #[test]
    fn cancel_handler_message_settles_cancelled_even_without_span() {
        // 无 span 的 job(submit 未带 span → span 表无登记):在途取消的
        // 裁定走在途令牌表(worker 弹出即登记,与 span 无关)——结算
        // Cancelled,不落 Failed(-32602)。
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
        // 结算三源的诚实源臂可观察面:executor 从未取消(令牌表/丢弃表双
        // 缺),handler 自己经探针观测取消并报取消文案 → 结算 Cancelled,
        // 绝不落 Failed(-32602)冒充参数错。
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
    fn cancel_unknown_and_duplicate_ids_never_grow_registration_table() {
        // 验收「长跑登记表有界」:未知 id(内联请求/没提交过的 id)、排队
        // 摘除(离队即永不执行,登记无人结算不入表)、终态后重复/迟到取消
        // 都不入表——表容量 ≤ 在途 job 数,长跑不膨胀。
        let (executor, _rx) =
            PoolExecutor::spawn(registry_with_test_handlers(), PoolBudget::from_total(2));
        // 占满两个 worker:821/823 在途,822 排队。
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
        // 排队摘除:job 离队永不执行,登记不入表(泄漏臂——旧口径在此入表
        // 且无人结算,长跑排队取消无限膨胀)。
        executor.cancel(&RequestId::Number(822));
        assert_eq!(
            executor.pending_cancel_registrations_for_tests(),
            0,
            "排队摘除不入表(离队即永不执行)"
        );
        // 在途取消:命中登记,终态(协作中断)即摘除;其后重复取消(未知
        // id 臂)不再膨胀。
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
        // 迟到取消(终态后):表已摘除,取消落「未知 id」臂,不入表。
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
        // 未知 method 同口径 -32601。
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
}
