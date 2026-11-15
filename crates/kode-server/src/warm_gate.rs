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

use serde_json::{json, Value};

use kode_protocol::{Request, Response, error_codes};
use kode_scheduler::{
    EnsureDecision, Scheduler, SchedulerOptions, TaskKind, TaskSpec, WarmState,
    model::priority::BACKGROUND_FULL,
};

use crate::server::ServerState;

/// 暖门状态机:scheduler keyed 单例持排队/在飞/终态,镜像计数(总数/
/// 完成/失败)与冷请求观测在本层记账。
pub struct WarmGate {
    scheduler: Scheduler,
    /// 最近一次 begin 声明的语料总数(镜像面自报;从未 begin = None)。
    total: Option<u64>,
    done: u64,
    failed: u64,
    /// Warming 期经池派发的真实 RPC 数(main 泵分派点记账)。
    cold_while_warming: u64,
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
            scheduler: Scheduler::new(SchedulerOptions::default()),
            total: None,
            done: 0,
            failed: 0,
            cold_while_warming: 0,
        }
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
        if self.scheduler.warm_state() == WarmState::Warming {
            self.scheduler.cancel_queued_tasks("background scan cancelled");
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
    let warm_state = state.warm.cancel();
    Response::success(request.id, json!({ "state": warm_state }))
}

/// `$/kode/index/warmState` `{}` → `{ state, coldWhileWarming, done, failed, total }`。
pub fn handle_warm_state(state: &mut ServerState, request: Request) -> Response {
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
        let message = error_of(handle_scan_complete(&mut state, req(1, json!({ "done": 1 }))));
        assert!(message.contains("`done` and `failed`"), "{message}");
    }

    #[test]
    fn handler_round_trip_begin_reused_complete_then_late_complete_refused() {
        let mut state = ServerState::new();
        let value = result_of(handle_begin_background_scan(&mut state, req(1, json!({ "total": 1000 }))));
        assert_eq!(
            value,
            json!({ "state": "warming", "decision": "queued", "scanId": 1 })
        );
        let value = result_of(handle_begin_background_scan(&mut state, req(2, json!({ "total": 1000 }))));
        assert_eq!(
            value,
            json!({ "state": "warming", "decision": "reused", "scanId": 1 })
        );
        let value = result_of(handle_scan_complete(&mut state, req(3, json!({ "done": 1000, "failed": 0 }))));
        assert_eq!(value, json!({ "state": "warm", "done": 1000, "failed": 0 }));
        // 迟到 complete(Warm 态再 complete)诚实拒。
        let message = error_of(handle_scan_complete(&mut state, req(4, json!({ "done": 1, "failed": 1 }))));
        assert!(message.contains("no background scan in progress"), "{message}");
        // 幂等 cancel:非 Warming 期返回当前真实状态。
        let value = result_of(handle_scan_cancel(&mut state, req(5, json!({}))));
        assert_eq!(value, json!({ "state": "warm" }));
    }
}
