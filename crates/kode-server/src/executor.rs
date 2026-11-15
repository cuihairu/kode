//! RUST-075-W worker 执行器装配:执行归属登记 + 真 worker 池。
//!
//! 形态:`$/kode/rpc` 注册面 handler 是纯函数(`fn(Value) -> Result`)、
//! 零 ServerState 依赖(TS 读盘直传,不碰镜像语料)——这类请求走 worker
//! 线程执行,主线程 stdio 泵持续读取/响应,重任务在飞时健康/轻请求照常
//! 先回。准入不变量(交互预留/后台硬顶/总量守恒/释放记账)全部由
//! kode-scheduler `WorkerPoolGate` 持有,本模块只接线不另立决策核。
//!
//! 取消(CORE-007 面):排队未启动的 job 即刻摘除回 -32800(容量未占);
//! 在途 job 打丢弃标记,执行完成后容量释放、结果丢弃回 -32800。计算中断
//! 级传播归 RUST-072,不在本装配面。

use std::collections::{HashSet, VecDeque};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};

use kode_protocol::{error_codes, RequestId, Response};
use kode_scheduler::{PoolBudget, WorkerPoolGate};
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

/// `$/kode/rpc` 内层 method 执行归属登记:全部注册 handler 归池、交互泳道。
/// 归属登记完整性由 tests/executor_ownership.rs 对 snapshot.methods() 全量
/// 断言(漏登记即红);RUST-074-W 引入后台首扫时在此分支出 Background。
pub fn rpc_pool_lane(_inner: &str) -> PoolLane {
    PoolLane::Interactive
}

/// 主分派环入口的执行归属决策。`$/kode/rpc` 按内层 method 归池;params
/// 形状非法(无内层 method)→ Inline,由 server 原样走 INVALID_PARAMS
/// 错误路径(口径不变,不因分类器抢答)。
pub fn execution_lane(method: &str, params: Option<&Value>) -> ExecutionLane {
    if method == "$/kode/rpc" {
        return match params.and_then(|p| p.get("method")).and_then(|m| m.as_str()) {
            Some(inner) => ExecutionLane::Pool(rpc_pool_lane(inner)),
            None => ExecutionLane::Inline,
        };
    }
    ExecutionLane::Inline
}

/// 池记账快照(健康面 `$/kode/health` 的 `pool` 键;无执行器装配时省略)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStats {
    pub workers: usize,
    pub interactive_running: usize,
    pub background_running: usize,
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
    interactive: VecDeque<Job>,
    background: VecDeque<Job>,
    /// 取消时在途(或刚弹出未启动)的 job id;执行前/后按此丢弃。
    running_cancelled: HashSet<RequestId>,
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
                interactive: VecDeque::new(),
                background: VecDeque::new(),
                running_cancelled: HashSet::new(),
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
        match job.lane {
            PoolLane::Interactive => state.interactive.push_back(job),
            PoolLane::Background => state.background.push_back(job),
        }
        self.shared.signal.notify_all();
    }

    /// 取消一个请求:排队未启动 → 摘除回 -32800(容量未占);在途 → 丢弃
    /// 标记,执行完成后容量照常释放、结果丢弃回 -32800。未提交的 id 登记
    /// 无害(弹出时按取消短路,不执行 handler)。
    pub fn cancel(&self, id: &RequestId) {
        let removed = {
            let mut state = self.shared.state.lock().expect("pool state lock");
            let removed = remove_queued(&mut state.interactive, id)
                .or_else(|| remove_queued(&mut state.background, id));
            if removed.is_some() {
                bump_stats(&self.shared.stats_cell, &state, |stats| {
                    stats.jobs_cancelled += 1;
                });
            } else {
                state.running_cancelled.insert(id.clone());
            }
            removed
        };
        if let Some(job) = removed {
            let _ = self.shared.done_tx.send(JobOutcome {
                id: id.clone(),
                lane: job.lane,
                status: JobStatus::Cancelled,
            });
        }
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

/// 从队列摘除目标 id 的排队 job(取消路径;容量未占,无需记账释放)。
fn remove_queued(queue: &mut VecDeque<Job>, id: &RequestId) -> Option<Job> {
    let index = queue.iter().position(|job| &job.id == id)?;
    queue.remove(index)
}

/// 按闭包改记账并同步健康面 cell(gate 运行数在每次记账变更后刷新;
/// cell 只在队列锁内短持,健康路径只持 cell 锁,无反向持锁)。
fn bump_stats(cell: &Mutex<PoolStats>, state: &ExecState, f: impl FnOnce(&mut PoolStats)) {
    if let Ok(mut stats) = cell.lock() {
        stats.interactive_running = state.gate.interactive_running();
        stats.background_running = state.gate.background_running();
        f(&mut stats);
    }
}

fn worker_loop(shared: Arc<ExecShared>) {
    loop {
        // 取 job 段:锁内只做队列摘取与准入记账,handler 在锁外执行。
        let job = {
            let mut state = shared.state.lock().expect("pool state lock");
            'pick: loop {
                // draining(退出中):排空已受理队列再退——受理过的请求都欠
                // 回包,静默弃置会破坏与内联路径的回包平价。
                if state.draining && state.interactive.is_empty() && state.background.is_empty()
                {
                    return;
                }
                // 交互优先:预留位语义——后台满载/排队也拦不住交互请求。
                if let Some(job) = state.interactive.pop_front() {
                    if state.gate.try_admit_interactive() {
                        bump_stats(&shared.stats_cell, &state, |_| {});
                        break 'pick job;
                    }
                    // 理论不可达(worker=total,空闲线程弹出时必有余位);
                    // 如实回队等容量,绝不越记账。
                    state.interactive.push_front(job);
                } else if !state.background.is_empty() && state.gate.try_admit_background()
                {
                    let job = state
                        .background
                        .pop_front()
                        .expect("background non-empty checked");
                    bump_stats(&shared.stats_cell, &state, |_| {});
                    break 'pick job;
                }
                state = shared
                    .signal
                    .wait(state)
                    .expect("pool state lock poisoned");
            }
        };
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
        let mut state = shared.state.lock().expect("pool state lock");
        let cancelled = cancelled_before || state.running_cancelled.remove(&job.id);
        let final_status = if cancelled {
            JobStatus::Cancelled
        } else {
            outcome_status
        };
        let released = match job.lane {
            PoolLane::Interactive => state.gate.release_interactive(),
            PoolLane::Background => state.gate.release_background(),
        };
        if !released {
            // 准入/释放错配 = 装配 bug:stderr 留痕不 panic(server 健壮性)。
            eprintln!("[kode-server] pool release without admission (bug)");
        }
        bump_stats(&shared.stats_cell, &state, |stats| match final_status {
            JobStatus::Done(_) => stats.jobs_done += 1,
            JobStatus::Failed(_) => stats.jobs_failed += 1,
            JobStatus::Cancelled => stats.jobs_cancelled += 1,
        });
        drop(state);
        let _ = shared.done_tx.send(JobOutcome {
            id: job.id,
            lane: job.lane,
            status: final_status,
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
    use std::time::Duration;

    /// 测试慢 handler 协调器:静态位(fn 指针不能捕获)。各测试用互不重叠
    /// 的 ticket 段,跨测试零串扰(cargo test 并行安全)。
    fn hold() -> &'static (Mutex<Vec<u32>>, Condvar) {
        static HOLD: std::sync::OnceLock<(Mutex<Vec<u32>>, Condvar)> =
            std::sync::OnceLock::new();
        HOLD.get_or_init(|| (Mutex::new(Vec::new()), Condvar::new()))
    }

    /// fn 指针 handler:登记 ticket 后阻塞,直到放行号(ticket+1000)出现。
    /// 有界等待(回归时红而非挂死 CI)。
    fn blocking_handler(params: Value) -> Result<Value, String> {
        let ticket = params.get("ticket").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        {
            let mut waiting = hold().0.lock().expect("hold lock");
            waiting.push(ticket);
        }
        hold().1.notify_all();
        let mut waiting = hold().0.lock().expect("hold lock");
        let mut ticks = 0usize;
        loop {
            if waiting.contains(&(ticket + 1000)) {
                break;
            }
            assert!(ticks < 3000, "handler ticket {ticket} never released");
            let (next, _) = hold()
                .1
                .wait_timeout(waiting, Duration::from_millis(20))
                .expect("hold lock");
            waiting = next;
            ticks += 1;
        }
        waiting.retain(|t| *t != ticket);
        Ok(serde_json::json!({ "ticket": ticket }))
    }

    /// 放行指定 ticket(测试协调面)。
    fn release(ticket: u32) {
        let mut waiting = hold().0.lock().expect("hold lock");
        waiting.push(ticket + 1000);
        drop(waiting);
        hold().1.notify_all();
    }

    /// 等到 handler 登记了指定 ticket(worker 真正开跑的可观察面)。
    /// 有界等待:调度面回归(交互永不入)时红而非挂死。
    fn wait_started(ticket: u32) {
        let mut waiting = hold().0.lock().expect("hold lock");
        let mut ticks = 0usize;
        loop {
            if waiting.contains(&ticket) {
                return;
            }
            assert!(ticks < 3000, "worker never started ticket {ticket}");
            let (next, _) = hold()
                .1
                .wait_timeout(waiting, Duration::from_millis(20))
                .expect("hold lock");
            waiting = next;
            ticks += 1;
        }
    }

    fn registry_with_test_handlers() -> RegistrySnapshot {
        let mut reg = RpcRegistry::new();
        reg.register("$/kode/test/blocking", blocking_handler);
        reg.register(
            "$/kode/test/failing",
            |_params: Value| -> Result<Value, String> {
                Err("boom: deliberate test failure".to_string())
            },
        );
        reg.snapshot()
    }

    fn job(id: u32, method: &str, lane: PoolLane) -> Job {
        Job {
            id: RequestId::Number(id as i64),
            method: method.to_string(),
            params: serde_json::json!({ "ticket": id }),
            lane,
        }
    }

    fn stats_of(executor: &PoolExecutor) -> PoolStats {
        *executor
            .shared
            .stats_cell
            .lock()
            .expect("stats lock")
    }

    /// 等到记账进入期望运行态(轮询,超时即断言失败)。
    fn wait_running(executor: &PoolExecutor, interactive: usize, background: usize) {
        for _ in 0..300 {
            let stats = stats_of(executor);
            if stats.interactive_running == interactive
                && stats.background_running == background
            {
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
        let (executor, rx) = PoolExecutor::spawn(
            registry_with_test_handlers(),
            PoolBudget::from_total(1),
        );
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
        let (executor, rx) = PoolExecutor::spawn(
            registry_with_test_handlers(),
            PoolBudget::from_total(1),
        );
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
    fn failed_job_maps_error_and_releases_capacity() {
        let (executor, rx) = PoolExecutor::spawn(
            registry_with_test_handlers(),
            PoolBudget::from_total(2),
        );
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
        assert_eq!(snapshot.len(), 3, "echo 内建 + 两个测试 handler");
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
