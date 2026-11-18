//! RUST-074-W:暖门接入——真实生产首扫(TS 语料镜像)与按需解析的暖态
//! 状态机,接 CORE-009 keyed 单例(`begin_background_scan`)。
//!
//! 服务端全 handler 是 text-in 纯函数,不存在服务端自走盘扫;真实生产首扫
//! = TS 语料镜像(kodeCoreCorpusMirror:枚举 → 逐文件 didOpen → complete)。
//! 本模块把镜像全程映射为暖门状态机:begin=标记任务入队(Warming),
//! complete=泵至终态(Warm),cancel=取消排队任务(Idle,不留假 pending);
//! 失败/取消不缓存暖态假象(scheduler 同口径,重开即可再暖;Warm 后再
//! begin=全新入队,刷新循环成立)。Warming 期抵达的真实 RPC(池派发面)
//! 记入 cold_while_warming 观测——「请求不等首扫」由池交互优先级兑现
//! (RUST-075-W);scheduler.cold_request 入队形态随解析缓存消费者接线
//! (RUST-070/071/073)启用,此处不伪造入队。
//!
//! 走顶层请求臂而非 RpcRegistry:四个面要动 `&mut ServerState` 里的状态机
//! (root_lifecycle 同先例);请求面带回执供装配/E2E 断言真实迁移发生。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use kode_protocol::{error_codes, Request, Response};
use kode_scheduler::{
    model::priority::BACKGROUND_FULL, EnsureDecision, Scheduler, SchedulerOptions, TaskKind,
    TaskSpec, WarmState,
};

use crate::server::{self_rss_bytes, ServerState};

/// RUST-078-W:暖门调度器驻留预算(排队上限)。`SchedulerOptions::default`
/// 的 `max_queued: None` 是 TS 对拍基线形态(无界=TS 现状);生产进程驻留
/// 的服务必须带预算构造——暖门调度器只承载首扫标记任务(单 keyed 键),
/// 64 远超真实并发需求,预算在场即结构性杜绝无界排队。
pub const WARM_QUEUE_BUDGET: usize = 64;
/// RUST-078-W:idle aging——终态记录空闲超过该时长即摘除(墙钟 ms)。
pub const IDLE_TERMINAL_MAX_MS: u64 = 60_000;
/// RUST-078-W:内存压力采样节流(墙钟 ms)——两次 RSS 采样最小间隔。
pub const PRESSURE_CHECK_INTERVAL_MS: u64 = 5_000;
/// RUST-078-W:内存压力阈值(RSS 字节)——超过即主动回收终态历史。
pub const PRESSURE_RSS_BUDGET_BYTES: u64 = 768 * 1024 * 1024;

/// 墙钟毫秒(维护面 timebase;与调度器逻辑钟同步用)。
pub fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 暖门状态机:scheduler keyed 单例持排队/在飞/终态,镜像计数(总数/
/// 完成/失败)与冷请求观测在本层记账。
pub struct WarmGate {
    scheduler: Scheduler,
    /// RUST-078-W:构造选项留档(观测面;预算常量同源)。
    opts: SchedulerOptions,
    /// 最近一次 begin 声明的语料总数(镜像面自报;从未 begin = None)。
    total: Option<u64>,
    done: u64,
    failed: u64,
    /// Warming 期经池派发的真实 RPC 数(main 泵分派点记账)。
    cold_while_warming: u64,
    /// RUST-078-W 维护记账:idle aging 累计摘除数。
    aged_terminal: u64,
    /// 内存压力主动回收次数(节流窗口内至多一次)。
    pressure_reclaims: u64,
    /// 最近一次压力采样的 RSS 字节(从未采样 = None;非 Linux 恒 None,
    /// 绝不伪造零值)。
    last_rss_bytes: Option<u64>,
    /// 最近一次压力采样墙钟 ms(节流)。
    last_pressure_check_ms: Option<u64>,
    /// 上次逻辑钟同步的墙钟 ms(逻辑钟追赶墙钟,aging timebase 对齐)。
    last_clock_sync_ms: Option<u64>,
}

/// 暖门快照(健康面 `warm` 键 / warmState 回执同源)。
#[derive(Debug, Clone, Copy)]
pub struct WarmSnapshot {
    pub state: &'static str,
    pub cold_while_warming: u64,
    pub done: u64,
    pub failed: u64,
    pub total: Option<u64>,
}

impl WarmGate {
    pub fn new() -> Self {
        WarmGate {
            // RUST-078-W:生产驻留带预算构造(排队上限;default None 无界
            // 是 TS 对拍基线,生产绝不无界)。
            opts: SchedulerOptions {
                max_queued: Some(WARM_QUEUE_BUDGET),
                ..SchedulerOptions::default()
            },
            scheduler: Scheduler::new(SchedulerOptions {
                max_queued: Some(WARM_QUEUE_BUDGET),
                ..SchedulerOptions::default()
            }),
            total: None,
            done: 0,
            failed: 0,
            cold_while_warming: 0,
            aged_terminal: 0,
            pressure_reclaims: 0,
            last_rss_bytes: None,
            last_pressure_check_ms: None,
            last_clock_sync_ms: None,
        }
    }

    /// 调度器选项观测面(单测断言预算在场;Copy 值)。
    pub fn options(&self) -> SchedulerOptions {
        self.opts
    }

    fn state_name(&self) -> &'static str {
        match self.scheduler.warm_state() {
            WarmState::Idle => "idle",
            WarmState::Warming => "warming",
            WarmState::Warm => "warm",
        }
    }

    fn decision_name(decision: EnsureDecision) -> &'static str {
        match decision {
            EnsureDecision::Queued => "queued",
            EnsureDecision::Reused => "reused",
            EnsureDecision::Recovered => "recovered",
            EnsureDecision::Rejected => "rejected",
        }
    }

    /// 首扫开始:标记任务以 BACKGROUND_FULL 入队(进行中复用;失败/取消后
    /// 重开 = recovered;Warm 后 = 全新入队,刷新循环)。返回
    /// `(state, decision, scanId)`。
    pub fn begin(&mut self, total: u64) -> (&'static str, &'static str, u64) {
        self.sync_clock(unix_now_ms());
        let (decision, id) = self.scheduler.begin_background_scan(TaskSpec {
            kind: TaskKind::InitialScan,
            priority: BACKGROUND_FULL,
            file: None,
            version: None,
            target: None,
            // 标记任务:首扫的实体工作(TS 镜像 didOpen 入库)发生在镜像
            // 全程;此任务承载 keyed 状态机生命周期,泵至终态即 Warm。
            run: Box::new(|_token| Ok(())),
        });
        self.total = Some(total);
        (self.state_name(), Self::decision_name(decision), id)
    }

    /// 首扫完成:仅 Warming 期有效;泵标记任务至终态 → Warm。迟到 complete
    /// (已 Warm/已取消/从未 begin)诚实报错,绝不把 Warm 假账补写到别处。
    pub fn complete(&mut self, done: u64, failed: u64) -> Result<&'static str, &'static str> {
        if self.scheduler.warm_state() != WarmState::Warming {
            return Err("no background scan in progress");
        }
        self.sync_clock(unix_now_ms());
        // 唯一后台任务、无交互入队(本调度器无其他生产者)→ 首泵即终态;
        // 预算内未到 Warm 视为状态机故障,诚实报错(不谎报 warm)。
        self.scheduler.drain(200);
        if self.scheduler.warm_state() != WarmState::Warm {
            return Err("background scan task did not reach terminal state");
        }
        self.done = done;
        self.failed = failed;
        Ok(self.state_name())
    }

    /// 首扫取消(镜像中断/轨道切走):取消排队任务 → Idle,不留假 pending。
    /// 非 Warming 期幂等(返回当前真实状态,不报错)。
    pub fn cancel(&mut self) -> &'static str {
        self.sync_clock(unix_now_ms());
        if self.scheduler.warm_state() == WarmState::Warming {
            self.scheduler
                .cancel_queued_tasks("background scan cancelled");
        }
        self.state_name()
    }

    /// Warming 期真实 RPC 派发记账(main 泵池分派点调用;非 Warming 期不计)。
    pub fn note_cold_request(&mut self) {
        if self.scheduler.warm_state() == WarmState::Warming {
            self.cold_while_warming += 1;
        }
    }

    /// 快照(健康面 warm 键 / warmState 回执同源)。
    pub fn snapshot(&self) -> WarmSnapshot {
        WarmSnapshot {
            state: self.state_name(),
            cold_while_warming: self.cold_while_warming,
            done: self.done,
            failed: self.failed,
            total: self.total,
        }
    }

    /// 逻辑钟同步到墙钟(aging 的 now 与终态时刻同 timebase;暖门调度器
    /// 无交互冷却/饥饿语义,钟推进零副作用)。begin/complete/cancel/maintain
    /// 全入口同步——终态戳记必须落在墙钟,否则首维即假超龄。
    fn sync_clock(&mut self, now_ms: u64) {
        let delta = match self.last_clock_sync_ms {
            None => now_ms,
            Some(last) => now_ms.saturating_sub(last),
        };
        self.scheduler.advance_clock(delta);
        self.last_clock_sync_ms = Some(now_ms);
    }

    /// RUST-078-W:驻留维护(idle aging + 内存压力主动回收)。生产触发面 =
    /// 暖门四臂 + main.rs 池分派点;`now_ms` 墙钟(逻辑钟同步追赶),
    /// `rss_bytes` 由调用方采样(`/proc`;None = 非 Linux/读失败,压力面
    /// 不动作绝不伪造)。红线:queued/running 永不动,keyed 台账永不动
    /// (暖门状态机零影响),metrics/golden 对拍面零变化。
    pub fn maintain(&mut self, now_ms: u64, rss_bytes: Option<u64>) {
        self.sync_clock(now_ms);
        let aged = self
            .scheduler
            .age_out_terminal(now_ms, IDLE_TERMINAL_MAX_MS);
        self.aged_terminal += aged as u64;

        let due = match self.last_pressure_check_ms {
            None => true,
            Some(last) => now_ms.saturating_sub(last) >= PRESSURE_CHECK_INTERVAL_MS,
        };
        if due {
            self.last_pressure_check_ms = Some(now_ms);
            if let Some(rss) = rss_bytes {
                self.last_rss_bytes = Some(rss);
                if rss > PRESSURE_RSS_BUDGET_BYTES {
                    let _ = self.scheduler.reclaim_history();
                    self.pressure_reclaims += 1;
                }
            }
        }
    }

    /// 维护观测快照(健康面 `maintenance` 键同源)。
    pub fn maintenance_snapshot(&self) -> MaintenanceSnapshot {
        MaintenanceSnapshot {
            aged_terminal: self.aged_terminal,
            pressure_reclaims: self.pressure_reclaims,
            last_rss_bytes: self.last_rss_bytes,
        }
    }
}

/// RUST-078-W:驻留维护观测(健康面 `maintenance` 键)。
#[derive(Debug, Clone, Copy)]
pub struct MaintenanceSnapshot {
    pub aged_terminal: u64,
    pub pressure_reclaims: u64,
    /// 最近一次压力采样 RSS(从未采样/非 Linux = None)。
    pub last_rss_bytes: Option<u64>,
}

impl Default for WarmGate {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for WarmGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let snapshot = self.snapshot();
        f.debug_struct("WarmGate")
            .field("state", &snapshot.state)
            .field("cold_while_warming", &snapshot.cold_while_warming)
            .field("done", &snapshot.done)
            .field("failed", &snapshot.failed)
            .field("total", &snapshot.total)
            .finish_non_exhaustive()
    }
}

fn u64_param(params: Option<&Value>, key: &str) -> Option<u64> {
    params.and_then(|p| p.get(key)).and_then(|v| v.as_u64())
}

/// `$/kode/index/beginBackgroundScan` `{ total }` → `{ state, decision, scanId }`。
pub fn handle_begin_background_scan(state: &mut ServerState, request: Request) -> Response {
    // RUST-078-W:暖门臂即维护点(驻留老化+压力回收随生产流量推进)。
    state.warm.maintain(unix_now_ms(), self_rss_bytes());
    let Some(total) = u64_param(request.params.as_ref(), "total") else {
        return Response::error(
            Some(request.id),
            error_codes::INVALID_PARAMS,
            "beginBackgroundScan requires numeric `total`",
        );
    };
    let (warm_state, decision, scan_id) = state.warm.begin(total);
    Response::success(
        request.id,
        json!({ "state": warm_state, "decision": decision, "scanId": scan_id }),
    )
}

/// `$/kode/index/scanComplete` `{ done, failed }` → `{ state, done, failed }`;
/// 无进行中首扫 → -32602(迟到回执诚实拒,不留假 pending)。
pub fn handle_scan_complete(state: &mut ServerState, request: Request) -> Response {
    // RUST-078-W:暖门臂即维护点(驻留老化+压力回收随生产流量推进)。
    state.warm.maintain(unix_now_ms(), self_rss_bytes());
    let (Some(done), Some(failed)) = (
        u64_param(request.params.as_ref(), "done"),
        u64_param(request.params.as_ref(), "failed"),
    ) else {
        return Response::error(
            Some(request.id),
            error_codes::INVALID_PARAMS,
            "scanComplete requires numeric `done` and `failed`",
        );
    };
    match state.warm.complete(done, failed) {
        Ok(warm_state) => Response::success(
            request.id,
            json!({ "state": warm_state, "done": done, "failed": failed }),
        ),
        Err(message) => Response::error(Some(request.id), error_codes::INVALID_PARAMS, message),
    }
}

/// `$/kode/index/scanCancel` `{}` → `{ state }`(幂等:非 Warming 期返回
/// 当前真实状态)。
pub fn handle_scan_cancel(state: &mut ServerState, request: Request) -> Response {
    // RUST-078-W:暖门臂即维护点(驻留老化+压力回收随生产流量推进)。
    state.warm.maintain(unix_now_ms(), self_rss_bytes());
    let warm_state = state.warm.cancel();
    Response::success(request.id, json!({ "state": warm_state }))
}

/// `$/kode/index/warmState` `{}` → `{ state, coldWhileWarming, done, failed, total }`。
pub fn handle_warm_state(state: &mut ServerState, request: Request) -> Response {
    // RUST-078-W:暖门臂即维护点(驻留老化+压力回收随生产流量推进)。
    state.warm.maintain(unix_now_ms(), self_rss_bytes());
    let snapshot = state.warm.snapshot();
    Response::success(
        request.id,
        json!({
            "state": snapshot.state,
            "coldWhileWarming": snapshot.cold_while_warming,
            "done": snapshot.done,
            "failed": snapshot.failed,
            "total": snapshot.total,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_protocol::RequestId;

    fn req(id: i64, params: Value) -> Request {
        Request {
            jsonrpc: "2.0".to_string(),
            id: RequestId::Number(id),
            method: "$/kode/index/test".to_string(),
            params: Some(params),
        }
    }

    fn result_of(response: Response) -> Value {
        assert!(response.error.is_none(), "unexpected error: {response:?}");
        response.result.expect("success response carries result")
    }

    fn error_of(response: Response) -> String {
        response
            .error
            .expect("expected error response")
            .message
            .to_string()
    }

    #[test]
    fn begin_enters_warming_and_reuses_in_flight_scan() {
        let mut state = ServerState::new();
        let (warm_state, decision, scan_id) = state.warm.begin(10);
        assert_eq!(warm_state, "warming");
        assert_eq!(decision, "queued");
        assert_eq!(scan_id, 1);
        // 进行中复用:同 key 第二次 begin 不重入队、id 不变。
        let (warm_state, decision, scan_id) = state.warm.begin(10);
        assert_eq!(warm_state, "warming");
        assert_eq!(decision, "reused");
        assert_eq!(scan_id, 1);
    }

    #[test]
    fn complete_without_begin_is_error() {
        let mut gate = WarmGate::new();
        assert_eq!(gate.complete(0, 0), Err("no background scan in progress"));
    }

    #[test]
    fn complete_pumps_to_warm_and_records_counts() {
        let mut state = ServerState::new();
        state.warm.begin(10);
        assert_eq!(state.warm.complete(7, 3), Ok("warm"));
        let snapshot = state.warm.snapshot();
        assert_eq!(snapshot.state, "warm");
        assert_eq!(snapshot.done, 7);
        assert_eq!(snapshot.failed, 3);
        assert_eq!(snapshot.total, Some(10));
    }

    #[test]
    fn cancel_returns_to_idle_reopen_recovered_late_complete_refused() {
        let mut gate = WarmGate::new();
        gate.begin(5);
        assert_eq!(gate.cancel(), "idle");
        assert_eq!(gate.snapshot().state, "idle");
        // 取消后重开:scheduler 记 recovered(不缓存取消态假象)。
        let (_, decision, _) = gate.begin(5);
        assert_eq!(decision, "recovered");
        gate.cancel();
        // 迟到 complete(取消后到达):诚实报错,不把 Warm 补写到已取消态。
        assert_eq!(gate.complete(5, 0), Err("no background scan in progress"));
        assert_eq!(gate.snapshot().state, "idle");
    }

    #[test]
    fn begin_after_warm_queues_fresh_scan_refresh_loop() {
        let mut gate = WarmGate::new();
        gate.begin(10);
        gate.complete(10, 0).expect("first scan completes");
        // Warm 后再 begin(根变化 → 重镜像):全新入队,刷新循环成立。
        let (warm_state, decision, _) = gate.begin(12);
        assert_eq!(warm_state, "warming");
        assert_eq!(decision, "queued");
        assert_eq!(gate.complete(12, 1), Ok("warm"));
        let snapshot = gate.snapshot();
        assert_eq!(snapshot.done, 12);
        assert_eq!(snapshot.failed, 1);
        assert_eq!(snapshot.total, Some(12));
    }

    #[test]
    fn cold_requests_counted_only_while_warming_and_survive_reset() {
        let mut gate = WarmGate::new();
        gate.note_cold_request();
        assert_eq!(gate.snapshot().cold_while_warming, 0);
        gate.begin(3);
        gate.note_cold_request();
        gate.note_cold_request();
        gate.complete(3, 0).expect("completes");
        gate.note_cold_request();
        assert_eq!(gate.snapshot().cold_while_warming, 2);
        // 观测累计面:取消/重开不抹账(观测是会话级,不是单轮扫描级)。
        gate.cancel();
        assert_eq!(gate.snapshot().cold_while_warming, 2);
    }

    #[test]
    fn handler_warm_state_reports_full_snapshot() {
        let mut state = ServerState::new();
        let value = result_of(handle_warm_state(&mut state, req(1, json!({}))));
        assert_eq!(
            value,
            json!({ "state": "idle", "coldWhileWarming": 0, "done": 0, "failed": 0, "total": null })
        );
    }

    #[test]
    fn handler_begin_requires_numeric_total() {
        let mut state = ServerState::new();
        let message = error_of(handle_begin_background_scan(&mut state, req(1, json!({}))));
        assert!(message.contains("requires numeric `total`"), "{message}");
    }

    #[test]
    fn handler_complete_requires_done_and_failed() {
        let mut state = ServerState::new();
        let message = error_of(handle_scan_complete(
            &mut state,
            req(1, json!({ "done": 1 })),
        ));
        assert!(message.contains("`done` and `failed`"), "{message}");
    }

    #[test]
    fn handler_round_trip_begin_reused_complete_then_late_complete_refused() {
        let mut state = ServerState::new();
        let value = result_of(handle_begin_background_scan(
            &mut state,
            req(1, json!({ "total": 1000 })),
        ));
        assert_eq!(
            value,
            json!({ "state": "warming", "decision": "queued", "scanId": 1 })
        );
        let value = result_of(handle_begin_background_scan(
            &mut state,
            req(2, json!({ "total": 1000 })),
        ));
        assert_eq!(
            value,
            json!({ "state": "warming", "decision": "reused", "scanId": 1 })
        );
        let value = result_of(handle_scan_complete(
            &mut state,
            req(3, json!({ "done": 1000, "failed": 0 })),
        ));
        assert_eq!(value, json!({ "state": "warm", "done": 1000, "failed": 0 }));
        // 迟到 complete(Warm 态再 complete)诚实拒。
        let message = error_of(handle_scan_complete(
            &mut state,
            req(4, json!({ "done": 1, "failed": 1 })),
        ));
        assert!(
            message.contains("no background scan in progress"),
            "{message}"
        );
        // 幂等 cancel:非 Warming 期返回当前真实状态。
        let value = result_of(handle_scan_cancel(&mut state, req(5, json!({}))));
        assert_eq!(value, json!({ "state": "warm" }));
    }

    /// RUST-078-W:生产驻留带预算构造——max_queued 恒 Some(WARM_QUEUE_BUDGET),
    /// 绝不复用 TS 无界基线形态。
    #[test]
    fn warm_gate_constructs_with_queue_budget() {
        let gate = WarmGate::new();
        assert_eq!(gate.options().max_queued, Some(WARM_QUEUE_BUDGET));
    }

    /// RUST-078-W:idle aging——超龄终态记录摘除,warm 态(keyed 台账)不受
    /// 影响,aged 计数如实。
    #[test]
    fn maintain_ages_expired_terminal_records_without_touching_warm_state() {
        let mut state = ServerState::new();
        state.warm.begin(10);
        assert_eq!(state.warm.complete(7, 3), Ok("warm"));
        // complete 后 tasks 表留 Completed 终态记录。
        assert!(state.warm.scheduler.retained_task_count() >= 1);
        // 新鲜窗口(60s 内)不摘。
        state.warm.maintain(unix_now_ms(), None);
        assert_eq!(state.warm.maintenance_snapshot().aged_terminal, 0);
        // 超龄(now 推进 60s+1)摘除;keyed 台账原样 → warm 态保持。
        let later = unix_now_ms() + IDLE_TERMINAL_MAX_MS + 1;
        state.warm.maintain(later, None);
        assert!(
            state.warm.maintenance_snapshot().aged_terminal >= 1,
            "超龄终态必须老化摘除"
        );
        assert_eq!(state.warm.snapshot().state, "warm", "keyed 台账永不动");
    }

    /// RUST-078-W:内存压力主动回收——超阈值 RSS 触发终态历史回收;节流窗
    /// 口内不重复采样;lastRssBytes 如实记录;None(非 Linux/读失败)不动作。
    #[test]
    fn maintain_reclaims_history_under_memory_pressure_with_throttle() {
        let mut state = ServerState::new();
        state.warm.begin(10);
        assert_eq!(state.warm.complete(7, 3), Ok("warm"));
        let now = unix_now_ms();
        // 首次采样超预算 → 回收一次,历史清零,RSS 记账。
        state
            .warm
            .maintain(now, Some(PRESSURE_RSS_BUDGET_BYTES + 1));
        let snap = state.warm.maintenance_snapshot();
        assert_eq!(snap.pressure_reclaims, 1);
        assert_eq!(snap.last_rss_bytes, Some(PRESSURE_RSS_BUDGET_BYTES + 1));
        assert_eq!(
            state.warm.scheduler.retained_task_count(),
            0,
            "终态历史全摘"
        );
        assert_eq!(state.warm.snapshot().state, "warm", "keyed/暖态零影响");
        // 节流窗(<5s)内再超预算不复查。
        state
            .warm
            .maintain(now + 1_000, Some(PRESSURE_RSS_BUDGET_BYTES + 2));
        assert_eq!(state.warm.maintenance_snapshot().pressure_reclaims, 1);
        // 窗口过后再超预算 → 第二次回收事件(历史已空,0 条可摘)。
        state.warm.maintain(
            now + PRESSURE_CHECK_INTERVAL_MS,
            Some(PRESSURE_RSS_BUDGET_BYTES + 3),
        );
        assert_eq!(state.warm.maintenance_snapshot().pressure_reclaims, 2);
        // 采样 None(非 Linux/读失败):不动作、不覆盖 lastRssBytes。
        state
            .warm
            .maintain(now + 2 * PRESSURE_CHECK_INTERVAL_MS, None);
        assert_eq!(
            state.warm.maintenance_snapshot().last_rss_bytes,
            Some(PRESSURE_RSS_BUDGET_BYTES + 3),
            "None 采样绝不伪造清零"
        );
    }

    /// RUST-078-W:Warming 期维护红线——queued/running 任务永不被老化/回收
    /// 摘除,状态机零影响。
    #[test]
    fn maintain_never_touches_live_tasks_while_warming() {
        let mut state = ServerState::new();
        state.warm.begin(10);
        assert_eq!(state.warm.snapshot().state, "warming");
        let now = unix_now_ms();
        state
            .warm
            .maintain(now, Some(PRESSURE_RSS_BUDGET_BYTES + 100));
        assert_eq!(
            state.warm.snapshot().state,
            "warming",
            "在飞首扫不受压力回收影响"
        );
        assert!(
            state.warm.scheduler.retained_task_count() >= 1,
            "queued/running 任务永不动"
        );
        assert_eq!(state.warm.maintenance_snapshot().aged_terminal, 0);
    }

    /// 队满(64 帽)时 begin 诚实拒绝:不写 keyed 假 pending,warm 态仍 idle;
    /// Default 与 new 同构;Debug 输出携带观测字段。
    #[test]
    fn begin_rejects_when_queue_saturated_and_default_debug_faces() {
        let mut state = ServerState::new();
        for i in 0..WARM_QUEUE_BUDGET {
            state
                .warm
                .scheduler
                .cold_request(format!("f{i}.py"), 1, Box::new(|_token| Ok(())));
        }
        let (state_name, decision, _id) = state.warm.begin(10);
        assert_eq!(decision, "rejected", "队满时入队被拒不造假 pending");
        assert_eq!(state_name, "idle", "拒绝不写 keyed,warm 态仍 idle");
        let gate = WarmGate::default();
        assert_eq!(gate.options().max_queued, Some(WARM_QUEUE_BUDGET));
        let dbg = format!("{gate:?}");
        assert!(dbg.contains("WarmGate"), "{dbg}");
        assert!(dbg.contains("state"), "{dbg}");
    }
}
