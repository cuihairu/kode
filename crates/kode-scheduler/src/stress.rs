//! 调度器长期压力车道(RUST-083 旧 CORE-018:long-running fuzz/load/stress)。
//!
//! 目标不是测速,是在随机化混合负载下周期性断言调度核的**结构不变量**,
//! 任一不变量被破坏即证明真实缺陷并中止返回结构化诊断:
//!
//! - **无死锁 / 无永久 pending**:有界预算内 [`Scheduler::drain`] 必须把队列排空
//!   (queued 归零、running 归零)。排不掉 = 交互冷却或饥饿路径把任务永久卡住。
//! - **计数守恒**:`completed + failed + cancelled == created`。`created` 只在真正
//!   新建任务时自增(合并/过期丢弃/队列满被拒都不计)。破坏 = 任务凭空消失或重复计数。
//! - **无取消泄漏**:`cancel` 成功 N 次,则 `cancelled` 计数必须 >= N。若一个已取消
//!   的任务又跑完(completed 涨、cancelled 不涨),守恒式仍可能成立,故本条单独断言——
//!   这正是「取消后复活」的泄漏面。
//! - **无界内存闸**:`retained_task_count() <= MAX_RETAINED_TERMINAL_TASKS`。
//!   终态窗口有界化后,长会话高频入队下 `tasks` 表必须保持有界。
//! - **keyed 面无假 pending**:排空后所有 ensure 过的 key 必须落 Completed/Failed/
//!   Cancelled,绝不残留 Queued/Running(= 永不重跑的假 pending)。
//! - **暂停/恢复配平**:每次 pause 必有对应 resume,恢复后车道仍能排空。
//! - **风暴合并不丢事件**:同文件重复事件合并数 = 事件总数 - 落队条数。
//!
//! 随机源是零依赖确定性 xorshift(seed 可复现,失败可按 seed 回放);不引 rand crate
//! (本 crate 铁律:零第三方依赖,仅 workspace 内 kode-index/kode-vfs)。

use crate::scheduler::Scheduler;
use crate::{
    EnqueueDecision, EnsureDecision, SchedulerOptions, TaskKind, TaskState,
    MAX_RETAINED_TERMINAL_TASKS,
};

/// 车道参数(缺省值见 [`StressOptions::default`];bin 侧可由环境变量覆盖)。
#[derive(Debug, Clone, Copy)]
pub struct StressOptions {
    /// 入队操作总数(混合优先级/文件/版本/keyed)。
    pub total_ops: u64,
    /// 有界队列上限;0 = 无界。
    pub max_queued: usize,
    /// 交互冷却窗口 ms。
    pub interactive_cooldown_ms: u64,
    /// 后台抗饥饿上限 ms。
    pub starvation_limit_ms: u64,
    /// 每 N 个操作断言一次全部不变量。
    pub check_every: u64,
    /// 取消操作注入比例(0..=100)。
    pub cancel_rate_pct: u8,
}

impl Default for StressOptions {
    fn default() -> Self {
        StressOptions {
            total_ops: 100_000,
            max_queued: 0,
            interactive_cooldown_ms: 50,
            starvation_limit_ms: 5_000,
            check_every: 1_000,
            cancel_rate_pct: 5,
        }
    }
}

/// 车道观测结果(供 CI/报告消费)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StressReport {
    pub created: u64,
    pub completed: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub cancel_successes: u64,
    /// 队列深度峰值(观测面,非断言)。
    pub peak_queued: usize,
    /// tasks 表条目峰值(内存面观测,断言上界见不变量)。
    pub peak_retained: usize,
    pub checks_run: u64,
    pub pauses: u64,
    pub recoveries: u64,
    pub merged_tasks: u64,
    pub stale_dropped: u64,
    pub anti_starvation_promotions: u64,
}

/// 车道失败:结构化诊断(kind 供 CI 分类,detail 供归因)。
#[derive(Debug)]
pub struct StressViolation {
    pub kind: &'static str,
    pub detail: String,
}

/// 峰值采样面(避免断言函数参数膨胀)。
#[derive(Debug, Default)]
struct Peaks {
    queued: usize,
    retained: usize,
}

/// 确定性 xorshift64(seed 可复现,零依赖,失败可按 seed 回放)。
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        // xorshift64 唯一坏点 = 0(恒 0);只替 0,不做 |1——那会把偶数
        // seed 折叠到同序列(实测 seed=2 与 seed=3 经 |1 都是 3,复现面失效)。
        Rng(if seed == 0 {
            0x9E37_79B9_7F4A_7C15
        } else {
            seed
        })
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    /// 取 [0, n)。
    fn below(&mut self, n: u64) -> u64 {
        if n <= 1 {
            0
        } else {
            self.next() % n
        }
    }
}

fn priority_at(rng: &mut Rng) -> u8 {
    // 交互(0..1)少于后台(2..4),贴近真实负载分布。
    match rng.below(100) {
        0..=6 => 0,
        7..=22 => 1,
        23..=42 => 2,
        43..=72 => 3,
        _ => 4,
    }
}

fn kind_at(rng: &mut Rng) -> TaskKind {
    match rng.below(6) {
        0 => TaskKind::InitialScan,
        1 => TaskKind::SingleFileUpdate,
        2 => TaskKind::DependencyUpdate,
        3 => TaskKind::DeleteCleanup,
        4 => TaskKind::FullReindex,
        _ => TaskKind::NonInteractive,
    }
}

fn file_at(rng: &mut Rng) -> Option<String> {
    // 20% 无文件任务(首扫/全量重建,不参与同文件合并);其余 30 个文件轮转,
    // 制造同文件多版本(合并/过期/让位)面。
    if rng.below(100) < 20 {
        return None;
    }
    Some(format!("/workspace/entity_{}.def", rng.below(30)))
}

fn version_at(rng: &mut Rng, op: u64) -> Option<u64> {
    // 多数随操作推进(单调递增 → 新顶旧),少数回退(→ 过期丢弃)。
    if rng.below(100) < 60 {
        Some(op / 8 + 1)
    } else {
        Some(rng.below(64) + 1)
    }
}

fn make_spec(
    kind: TaskKind,
    priority: u8,
    file: Option<&str>,
    version: Option<u64>,
    op: u64,
    fail: bool,
) -> crate::TaskSpec {
    crate::TaskSpec {
        kind,
        priority,
        file: file.map(str::to_string),
        version,
        target: None,
        // 有界工作量:不真 IO,只让不同任务体行为可区分(与 op 挂钩的小循环)。
        run: Box::new(move |_cancel| {
            if fail {
                Err(format!("stress-fail-{op}"))
            } else {
                let mut acc: u64 = 0;
                for i in 0..(op % 16) {
                    acc = acc.wrapping_add(i);
                }
                let _ = acc;
                Ok(())
            }
        }),
    }
}

/// 运行完整压力车道;任一不变量破坏即中止并返回诊断。
pub fn run_stress(seed: u64, opts: StressOptions) -> Result<StressReport, StressViolation> {
    let scheduler_opts = SchedulerOptions {
        interactive_cooldown_ms: opts.interactive_cooldown_ms,
        starvation_limit_ms: opts.starvation_limit_ms,
        max_queued: if opts.max_queued == 0 {
            None
        } else {
            Some(opts.max_queued)
        },
    };
    let mut s = Scheduler::new(scheduler_opts);
    let mut rng = Rng::new(seed);
    let mut peaks = Peaks::default();

    let mut created: u64 = 0;
    let mut cancel_successes: u64 = 0;
    let mut checks_run: u64 = 0;
    let mut pauses: u64 = 0;
    let mut inflight: Vec<u64> = Vec::with_capacity(4096);
    // 全程最大已见任务 id:新任务的 id 由调度器单调分配,id 大于它才是真新建。
    // 「Queued 决策但 id 是旧任务」= 同文件同版本合并到在队任务(该任务当初
    // 入队时已计过),再 +1 就会重复计数(终局守恒必红,实测差 19 即此因)。
    let mut max_seen_id: u64 = 0;

    for op in 1..=opts.total_ops {
        let priority = priority_at(&mut rng);
        let file = file_at(&mut rng);
        let version = version_at(&mut rng, op);
        let kind = kind_at(&mut rng);
        // 8% 失败任务:验证失败不缓存成永久 pending(keyed 可恢复)。
        let fail = rng.below(100) < 8;
        let want_cancel = rng.below(100) < u64::from(opts.cancel_rate_pct);

        // 10% keyed 单例面;其余走普通入队。
        if rng.below(100) < 10 {
            let key = format!("key-{}", op % 64);
            let (decision, id) = s.ensure(
                &key,
                make_spec(kind, priority, file.as_deref(), version, op, fail),
            );
            let is_fresh = matches!(decision, EnsureDecision::Queued | EnsureDecision::Recovered)
                && id > max_seen_id;
            if is_fresh {
                created += 1;
                max_seen_id = id;
                if want_cancel {
                    inflight.push(id);
                }
            }
        } else {
            let out = s.enqueue(make_spec(
                kind,
                priority,
                file.as_deref(),
                version,
                op,
                fail,
            ));
            let is_fresh = out.decision == EnqueueDecision::Queued && out.id > max_seen_id;
            if is_fresh {
                created += 1;
                max_seen_id = out.id;
                if want_cancel {
                    inflight.push(out.id);
                }
            }
        }

        // 取消注入:批量取消(cancel_queued_tasks)与单点取消交替覆盖。
        if want_cancel && !inflight.is_empty() && rng.below(100) < 30 {
            if rng.below(100) < 20 {
                let n = s.cancel_queued_tasks("stress-cancel-batch");
                cancel_successes += n as u64;
                inflight.clear();
            } else {
                let pick = rng.below(inflight.len() as u64) as usize;
                let id = inflight[pick];
                if s.cancel(id, "stress-cancel") {
                    cancel_successes += 1;
                    inflight.swap_remove(pick);
                }
            }
        }

        // 暂停/恢复面:成对出现,恢复后才能排空。
        if rng.below(1000) < 3 {
            s.pause();
            pauses += 1;
            s.resume();
            if s.is_paused() {
                return Err(StressViolation {
                    kind: "pause-imbalance",
                    detail: format!("op={op} pause/resume 后仍为 paused(配平被破坏)"),
                });
            }
        }

        // 峰值采样(在周期断言排空前采,否则恒为 0)。
        let queued = s.status().queued;
        if queued > peaks.queued {
            peaks.queued = queued;
        }
        let retained = s.retained_task_count();
        if retained > peaks.retained {
            peaks.retained = retained;
        }

        if opts.check_every > 0 && op % opts.check_every == 0 {
            assert_invariants(
                &mut s,
                op,
                created,
                cancel_successes,
                &mut peaks,
                &mut checks_run,
            )?;
        }
    }

    assert_invariants(
        &mut s,
        opts.total_ops,
        created,
        cancel_successes,
        &mut peaks,
        &mut checks_run,
    )?;

    // keyed 面终检:排空后不得残留假 pending。
    for (key, state) in s.status().keyed_tasks.iter() {
        if state == TaskState::Queued.as_str() || state == TaskState::Running.as_str() {
            return Err(StressViolation {
                kind: "keyed-stuck-pending",
                detail: format!("key={key} 排空后仍停留 {state}(永久 pending,永不重跑)"),
            });
        }
    }

    let status = s.status();
    let metrics = status.metrics;
    Ok(StressReport {
        created,
        completed: status.completed,
        failed: status.failed,
        cancelled: status.cancelled,
        cancel_successes,
        peak_queued: peaks.queued,
        peak_retained: peaks.retained,
        checks_run,
        pauses,
        recoveries: metrics.recoveries,
        merged_tasks: metrics.merged_tasks,
        stale_dropped: metrics.stale_dropped,
        anti_starvation_promotions: metrics.anti_starvation_promotions,
    })
}

/// 排空后断言全部不变量。`at_op` 仅作诊断定位。
#[allow(clippy::too_many_arguments)]
fn assert_invariants(
    s: &mut Scheduler,
    at_op: u64,
    created: u64,
    cancel_successes: u64,
    peaks: &mut Peaks,
    checks_run: &mut u64,
) -> Result<(), StressViolation> {
    // 恢复后再排空:暂停中 drain 立即返回,会把「正在暂停」误判成死锁。
    s.resume();
    // 60s 逻辑预算:远超交互冷却(50ms)与饥饿上限(5s),保证后台任务可被晋升执行。
    s.drain(60_000);
    *checks_run += 1;

    let status = s.status();

    if status.queued != 0 || status.running.is_some() {
        return Err(StressViolation {
            kind: "deadlock-or-permanent-pending",
            detail: format!(
                "op={at_op} drain(60s) 后 queued={} running={:?}(排空失败=任务被永久卡住)",
                status.queued,
                status.running.map(|r| r.id)
            ),
        });
    }

    let accounted = status.completed + status.failed + status.cancelled;
    if accounted != created {
        return Err(StressViolation {
            kind: "count-violation",
            detail: format!(
                "op={at_op} 计数不守恒:completed+failed+cancelled={accounted} != created={created}"
            ),
        });
    }

    // 取消泄漏:cancel 成功次数必须被 cancelled 计数完整承接。
    // 已取消任务若又跑完(completed 涨而 cancelled 不涨),此处必然红。
    if status.cancelled < cancel_successes {
        return Err(StressViolation {
            kind: "cancel-leak",
            detail: format!(
                "op={at_op} cancel 成功 {cancel_successes} 次但 cancelled 仅 {cancelled}(取消后复活)",
                cancelled = status.cancelled
            ),
        });
    }

    let retained = s.retained_task_count();
    if retained > MAX_RETAINED_TERMINAL_TASKS {
        return Err(StressViolation {
            kind: "unbounded-memory",
            detail: format!(
                "op={at_op} tasks 表条目 retained={retained} > 终态窗口上限 {MAX_RETAINED_TERMINAL_TASKS}(内存无界)"
            ),
        });
    }
    if retained > peaks.retained {
        peaks.retained = retained;
    }
    if status.queued > peaks.queued {
        peaks.queued = status.queued;
    }

    Ok(())
}

/// 风暴车道累计面(逐窗口排空,故各计数单调可累加)。
///
/// 注:合并数直接读 [`crate::StormBuffer::merged`](它是累计值,勿按窗口重复累加);
/// 结构体只留两个本探针自算的量。
struct StormTotals {
    landed: u64,
    created: u64,
}

impl StormTotals {
    fn new() -> Self {
        StormTotals {
            landed: 0,
            created: 0,
        }
    }
}

/// 落盘当前缓冲并逐条入队;任一事件未被接受即视为丢失(单调版本下无合法丢弃)。
fn flush_storm_buffer(
    s: &mut Scheduler,
    buffer: &mut crate::StormBuffer,
    totals: &mut StormTotals,
) -> Result<(), StressViolation> {
    let events = buffer.flush();
    for event in events {
        totals.landed += 1;
        let spec = make_spec(
            TaskKind::SingleFileUpdate,
            event.priority,
            Some(&event.file),
            Some(event.version),
            totals.landed,
            false,
        );
        let out = s.enqueue(spec);
        match out.decision {
            EnqueueDecision::Queued => totals.created += 1,
            // 同文件同版本合并到在队任务(该任务已计过)——合法接受。
            EnqueueDecision::Merged => {}
            EnqueueDecision::StaleDropped | EnqueueDecision::RejectedQueueFull => {
                return Err(StressViolation {
                    kind: "storm-event-dropped",
                    detail: format!(
                        "风暴事件 {} v{} 未被接受(decision={:?},单调版本下不应丢弃)",
                        event.file, event.version, out.decision
                    ),
                });
            }
        }
    }
    Ok(())
}

/// 风暴合并面探针:同文件重复事件并一、最新版本胜出、合并不丢事件。
///
/// 版本号取单调递增序列(每次事件严格比同文件上一条新),使任何「过期丢弃」都
/// 成为真缺陷信号:若调度器把更新版本判成过期而丢弃,说明版本比较被破坏。
///
/// 每攒满一个缓冲窗口就**立即排空**(真实接入形态:通知合并后及时重建),避免
/// 全量堆积后一次排空——那会把 drain 的逐任务全队列选择放大成 O(n²),测的
/// 是车道自身的调度器复杂度而非缺陷;同时保留「窗口内高密度合并」这一目标面。
pub fn stress_storm_probe(
    seed: u64,
    total_events: u64,
) -> Result<(u64, u64, usize), StressViolation> {
    let mut s = Scheduler::new(SchedulerOptions::default());
    let mut rng = Rng::new(seed.wrapping_add(0x9E3779B97F4A7C15));
    let mut buffer = crate::StormBuffer::new(64);
    let mut totals = StormTotals::new();
    let mut version_clock: u64 = 0;

    // 只在 8 个文件上打事件:大量同文件重复 → 高密度合并面。
    for _ in 0..total_events {
        version_clock += 1;
        buffer.record(
            format!("/storm/file_{}.py", rng.below(8)),
            version_clock,
            priority_at(&mut rng),
        );
        if buffer.buffered() >= 8 {
            flush_storm_buffer(&mut s, &mut buffer, &mut totals)?;
            s.resume();
            s.drain(60_000);
            let status = s.status();
            if status.queued != 0 || status.running.is_some() {
                return Err(StressViolation {
                    kind: "storm-not-drained",
                    detail: format!(
                        "窗口落盘后仍 queued={} running={:?}",
                        status.queued,
                        status.running.map(|r| r.id)
                    ),
                });
            }
            // 计数守恒:累计入队数必须被累计终态完整承接(终态计数是单调累计,
            // 不可按窗口清零——清零后与累计值不可比)。
            let accounted = status.completed + status.failed + status.cancelled;
            if accounted != totals.created {
                return Err(StressViolation {
                    kind: "storm-count-violation",
                    detail: format!(
                        "风暴计数不守恒:累计终态={accounted} != 累计入队={created}",
                        created = totals.created
                    ),
                });
            }
        }
    }
    if buffer.buffered() > 0 {
        flush_storm_buffer(&mut s, &mut buffer, &mut totals)?;
        s.resume();
        s.drain(60_000);
    }

    // 合并不丢事件:事件总数 = 缓冲累计并一数 + 落盘条数(merged 本身就是
    // 累计值,勿按窗口重复累加——重复累加会把正确的合并面误报成丢失)。
    let seen = buffer.events_seen;
    if seen != buffer.merged + totals.landed {
        return Err(StressViolation {
            kind: "storm-event-lost",
            detail: format!(
                "events_seen={seen} != merged({}) + 落盘({landed})(事件被悄悄丢掉)",
                buffer.merged,
                landed = totals.landed
            ),
        });
    }
    Ok((seen, buffer.merged, totals.landed as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// StressOptions::default() 直测:长跑车道缺省形状(此前从未被读)。
    #[test]
    fn stress_options_default_matches_long_lane_shape() {
        let d = StressOptions::default();
        assert_eq!(d.total_ops, 100_000);
        assert_eq!(d.max_queued, 0);
        assert_eq!(d.interactive_cooldown_ms, 50);
        assert_eq!(d.starvation_limit_ms, 5_000);
        assert_eq!(d.check_every, 1_000);
        assert_eq!(d.cancel_rate_pct, 5);
    }

    /// xorshift64 唯一坏点 = 0(恒 0):seed=0 必须替换成金常数,
    /// 且与显式传入该金常数完全同序列(复现面等价)。
    #[test]
    fn rng_seed_zero_substitutes_golden_constant() {
        const GOLDEN: u64 = 0x9E37_79B9_7F4A_7C15;
        assert_eq!(Rng::new(0).0, GOLDEN);
        let mut a = Rng::new(0);
        let mut b = Rng::new(GOLDEN);
        for _ in 0..8 {
            assert_eq!(a.next(), b.next());
            assert_eq!(a.below(97), b.below(97));
        }
        // below(0)/below(1) 恒 0(除零守卫)。
        assert_eq!(Rng::new(7).below(0), 0);
        assert_eq!(Rng::new(7).below(1), 0);
    }

    /// 已排空、带 n 个终态驻留条目的调度器(直测 assert_invariants 用)。
    fn drained_with_terminals(n: u64) -> Scheduler {
        let mut s = Scheduler::new(SchedulerOptions::default());
        for op in 1..=n {
            s.enqueue(make_spec(
                TaskKind::SingleFileUpdate,
                3,
                Some(&format!("/cov/term-{op}.def")),
                Some(op),
                op,
                false,
            ));
            s.drain(1_000);
        }
        s
    }

    fn probe(s: &mut Scheduler, created: u64, cancel_successes: u64) -> StressViolation {
        let mut peaks = Peaks::default();
        let mut checks = 0u64;
        assert_invariants(s, 1, created, cancel_successes, &mut peaks, &mut checks)
            .expect_err("上述参数组合必然破坏对应不变量")
    }

    /// 计数不守恒臂:虚报 created → completed+failed+cancelled != created。
    #[test]
    fn assert_invariants_flags_count_violation() {
        let mut s = drained_with_terminals(3);
        let v = probe(&mut s, 4, 0);
        assert_eq!(v.kind, "count-violation");
        assert!(
            v.detail
                .contains("completed+failed+cancelled=3 != created=4"),
            "{}",
            v.detail
        );
    }

    /// 取消泄漏臂:cancel 成功数虚报 → cancelled < cancel_successes。
    #[test]
    fn assert_invariants_flags_cancel_leak() {
        let mut s = drained_with_terminals(2);
        let v = probe(&mut s, 2, 1);
        assert_eq!(v.kind, "cancel-leak");
        assert!(
            v.detail.contains("cancel 成功 1 次但 cancelled 仅 0"),
            "{}",
            v.detail
        );
    }

    /// Ok 路径峰值采样:排空后驻留终态条目要回写 peaks.retained
    /// (run_stress 主循环先自采峰值,此臂只在直测面可见)。
    #[test]
    fn assert_invariants_ok_updates_peak_retained() {
        let mut s = drained_with_terminals(3);
        let mut peaks = Peaks::default();
        let mut checks = 0u64;
        assert_invariants(&mut s, 1, 3, 0, &mut peaks, &mut checks).expect("守恒成立");
        assert_eq!(checks, 1);
        assert_eq!(peaks.retained, 3, "驻留终态条目数回写峰值");
    }

    /// 排空失败臂:交互冷却 >> drain 预算(60s)且抗饥饿上限更远时,
    /// 后台任务在预算内无法晋升 → 检测器按「排不掉 = 永久卡住」红。
    /// (口径:钉检测器守卫与诊断内容,不是真死锁;生产缺省冷却 50ms << 60s。)
    #[test]
    fn assert_invariants_reports_undrained_queue_as_deadlock() {
        let mut s = Scheduler::new(SchedulerOptions {
            interactive_cooldown_ms: 200_000,
            starvation_limit_ms: 400_000,
            max_queued: None,
        });
        // 先跑一个交互任务,锚定冷却窗口起点。
        s.enqueue(make_spec(
            TaskKind::SingleFileUpdate,
            0,
            Some("/cov/interactive.def"),
            Some(1),
            1,
            false,
        ));
        s.drain(1_000);
        // 再入队后台任务:drain(60s) 内既过不了冷却也够不着饥饿晋升。
        s.enqueue(make_spec(
            TaskKind::SingleFileUpdate,
            3,
            Some("/cov/background.def"),
            Some(2),
            2,
            false,
        ));
        let v = probe(&mut s, 2, 0);
        assert_eq!(v.kind, "deadlock-or-permanent-pending");
        assert!(v.detail.contains("queued=1"), "{}", v.detail);
    }

    /// 检测器失败经 run_stress 传播:周期断言(310 的 `?`)与终局断言
    /// (321 的 `?`)两条车道都必须把 Err 原样带回调用方。
    ///
    /// 冷却窗口由交互任务锚定(无交互入队时 NEVER_MS 使后台不受节流),
    /// 200 ops 下必有交互任务入队(确定性 seed,非概率断言)。
    #[test]
    fn run_stress_propagates_detector_failure_from_periodic_and_final_checks() {
        let undrainable = |check_every: u64| StressOptions {
            total_ops: 200,
            max_queued: 0,
            interactive_cooldown_ms: 200_000,
            starvation_limit_ms: 400_000,
            check_every,
            cancel_rate_pct: 0,
        };
        // 周期断言:op=50 时 drain 预算耗尽即红。
        let v = run_stress(1, undrainable(50)).expect_err("周期断言必传播失败");
        assert_eq!(v.kind, "deadlock-or-permanent-pending");
        // 终局断言:check_every=0 关掉周期面,只走收尾 `?`。
        let v = run_stress(1, undrainable(0)).expect_err("终局断言必传播失败");
        assert_eq!(v.kind, "deadlock-or-permanent-pending");
    }

    /// 风暴落盘丢弃臂:队列里已有同文件新版本(v9),缓冲再落旧版本(v5)
    /// → StaleDropped → 「风暴事件未被接受」红(单调版本承诺被破坏面)。
    #[test]
    fn flush_storm_buffer_reports_stale_drop() {
        let mut s = Scheduler::new(SchedulerOptions::default());
        let mut buffer = crate::StormBuffer::new(64);
        let mut totals = StormTotals::new();
        buffer.record("/cov/storm.py".to_string(), 9, 3);
        flush_storm_buffer(&mut s, &mut buffer, &mut totals).expect("首条新鲜事件必被接受");
        buffer.record("/cov/storm.py".to_string(), 5, 3);
        let v = flush_storm_buffer(&mut s, &mut buffer, &mut totals)
            .expect_err("旧版本必然 StaleDropped");
        assert_eq!(v.kind, "storm-event-dropped");
        assert!(
            v.detail.contains("v5 未被接受(decision=StaleDropped"),
            "{}",
            v.detail
        );
        // 口径:landed = 离开缓冲进入落盘流程的事件数(先计数后判收),
        // 接受与否由 Err 表达;created 只在真入队时 +1。
        assert_eq!(totals.landed, 2);
        assert_eq!(totals.created, 1);
    }
}
