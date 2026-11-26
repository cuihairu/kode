//! Scheduler long-running stress lane (RUST-083's former CORE-018: long-running fuzz/load/stress).
//!
//! The goal is not speed measurement, but periodically asserting the scheduler core's
//! **structural invariants** under a randomized mixed load; any broken invariant proves a
//! genuine defect and aborts with structured diagnostics:
//!
//! - **No deadlock / no permanent pending**: within a bounded budget [`Scheduler::drain`] must
//!   empty the queue (queued down to zero, running down to zero). Failing to drain means the
//!   interactive cooldown or the starvation path has pinned tasks permanently.
//! - **Count conservation**: `completed + failed + cancelled == created`. `created` only
//!   increments when a task is genuinely newly created (merging / stale drop / queue-full
//!   rejection are all excluded). A violation means tasks vanished or were double-counted.
//! - **No cancellation leak**: if `cancel` succeeded N times, the `cancelled` count must be
//!   >= N. If a cancelled task somehow finishes again (completed rises, cancelled does not),
//!   > the conservation formula could still hold, so this is asserted separately — this is
//!   > exactly the "resurrection after cancellation" leak surface.
//! - **Unbounded-memory gate**: `retained_task_count() <= MAX_RETAINED_TERMINAL_TASKS`.
//!   Once the terminal window is bounded, the `tasks` table must stay bounded under
//!   high-frequency enqueueing in long sessions.
//! - **No fake pending on the keyed surface**: after draining, every ensured key must land on
//!   Completed/Failed/Cancelled, never lingering on Queued/Running (= fake pending that will
//!   never rerun).
//! - **Pause/resume balance**: every pause has a matching resume, and the lane can still drain
//!   after resuming.
//! - **Storm merging loses no events**: same-file duplicate events merged count = total events
//!   - landed entries.
//!
//! The random source is a zero-dependency deterministic xorshift (the seed is reproducible and
//! failures can be replayed by seed); no rand crate is pulled in (this crate's iron rule: zero
//! third-party dependencies, only kode-index/kode-vfs from the workspace).

use crate::scheduler::Scheduler;
use crate::{
    EnqueueDecision, EnsureDecision, SchedulerOptions, TaskKind, TaskState,
    MAX_RETAINED_TERMINAL_TASKS,
};

/// Lane parameters (defaults in [`StressOptions::default`]; the bin side may override them via
/// environment variables).
#[derive(Debug, Clone, Copy)]
pub struct StressOptions {
    /// Total enqueue operations (mixed priority / file / version / keyed).
    pub total_ops: u64,
    /// Bounded queue ceiling; 0 = unbounded.
    pub max_queued: usize,
    /// Interactive cooldown window in ms.
    pub interactive_cooldown_ms: u64,
    /// Background anti-starvation ceiling in ms.
    pub starvation_limit_ms: u64,
    /// Assert every invariant once every N operations.
    pub check_every: u64,
    /// Cancellation-operation injection ratio (0..=100).
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

/// Lane observation results (consumed by CI / reports).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StressReport {
    pub created: u64,
    pub completed: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub cancel_successes: u64,
    /// Peak queue depth (observation surface, not an assertion).
    pub peak_queued: usize,
    /// Peak entry count of the tasks table (memory-side observation; the asserted ceiling is
    /// covered by the invariants).
    pub peak_retained: usize,
    pub checks_run: u64,
    pub pauses: u64,
    pub recoveries: u64,
    pub merged_tasks: u64,
    pub stale_dropped: u64,
    pub anti_starvation_promotions: u64,
}

/// Lane failure: structured diagnostics (`kind` for CI classification, `detail` for attribution).
#[derive(Debug)]
pub struct StressViolation {
    pub kind: &'static str,
    pub detail: String,
}

/// Peak-sampling surface (avoids bloating the assertion function's parameter list).
#[derive(Debug, Default)]
struct Peaks {
    queued: usize,
    retained: usize,
}

/// Deterministic xorshift64 (seed is reproducible, zero dependencies, failures can be replayed
/// by seed).
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        // xorshift64's only bad point = 0 (stuck at 0); substitute only for 0, and do not apply
        // |1 — that would fold even seeds onto the same sequence (measured: seed=2 and seed=3
        // both become 3 after |1, which breaks the reproduction surface).
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
    /// Draw from [0, n).
    fn below(&mut self, n: u64) -> u64 {
        if n <= 1 {
            0
        } else {
            self.next() % n
        }
    }
}

fn priority_at(rng: &mut Rng) -> u8 {
    // Interactive (0..1) is rarer than background (2..4), closer to a real load distribution.
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
    // 20% fileless tasks (initial scan / full reindex, not part of same-file merging); the
    // rest rotate over 30 files, creating the same-file multi-version surface (merge / stale /
    // yielding).
    if rng.below(100) < 20 {
        return None;
    }
    Some(format!("/workspace/entity_{}.def", rng.below(30)))
}

fn version_at(rng: &mut Rng, op: u64) -> Option<u64> {
    // Most advance with the operation number (monotonic increase → new supersedes old), a few
    // regress (→ stale drop).
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
        // Bounded workload: no real IO, it just makes different task bodies behave differently
        // (a small loop tied to op).
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

/// Run the full stress lane; any broken invariant aborts and returns the diagnostics.
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
    // The maximum task id seen so far: the scheduler allocates ids monotonically, so only an id
    // greater than this is a genuinely new task. "Queued decision but the id is an old task" =
    // same-file same-version merge into an already-queued task (that task was already counted
    // when first enqueued); incrementing again would double-count (final conservation would
    // turn red; a measured gap of 19 was exactly this cause).
    let mut max_seen_id: u64 = 0;

    for op in 1..=opts.total_ops {
        let priority = priority_at(&mut rng);
        let file = file_at(&mut rng);
        let version = version_at(&mut rng, op);
        let kind = kind_at(&mut rng);
        // 8% failing tasks: verify that failures do not get cached as permanent pending
        // (keyed is recoverable).
        let fail = rng.below(100) < 8;
        let want_cancel = rng.below(100) < u64::from(opts.cancel_rate_pct);

        // 10% keyed singleton surface; the rest go through ordinary enqueueing.
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

        // Cancellation injection: batch cancellation (cancel_queued_tasks) and single-point
        // cancellation are covered alternately.
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

        // Pause/resume surface: always in pairs; draining is only possible after resuming.
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

        // Peak sampling (taken before the periodic assertion drains, otherwise always 0).
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

    // Keyed-surface final check: after draining no fake pending may remain.
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

/// Assert every invariant after draining. `at_op` is only for diagnostic positioning.
#[allow(clippy::too_many_arguments)]
fn assert_invariants(
    s: &mut Scheduler,
    at_op: u64,
    created: u64,
    cancel_successes: u64,
    peaks: &mut Peaks,
    checks_run: &mut u64,
) -> Result<(), StressViolation> {
    // Resume before draining: while paused, drain returns immediately, which would misread
    // "currently paused" as a deadlock.
    s.resume();
    // 60s logical budget: far beyond the interactive cooldown (50ms) and the starvation ceiling
    // (5s), guaranteeing that background tasks can be promoted to execution.
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

    // Cancellation leak: the number of successful cancels must be fully absorbed by the
    // cancelled count. If a cancelled task finishes again (completed rises while cancelled does
    // not), this must turn red.
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

/// Accumulation surface for the storm lane (each window is drained, so the counts are
/// monotonic and can be accumulated).
///
/// Note: the merged count is read straight from [`crate::StormBuffer::merged`] (it is already a
/// cumulative value; do not accumulate it again per window); the struct keeps only the two
/// quantities this probe computes itself.
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

/// Land the current buffer and enqueue entry by entry; any event that is not accepted is
/// treated as lost (there is no legal drop under monotonic versions).
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
            // Same-file same-version merged into an already-queued task (that task was already
            // counted) — a legal acceptance.
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

/// Storm-merge surface probe: same-file duplicate events collapse into one, the newest version
/// wins, and merging loses no events.
///
/// Version numbers come from a monotonically increasing sequence (each event is strictly newer
/// than the previous one for the same file), so any "stale drop" becomes a genuine defect
/// signal: if the scheduler judges a newer version stale and drops it, the version comparison
/// is broken.
///
/// As soon as a buffer window fills up it is **drained immediately** (the real integration
/// shape: rebuild promptly after notifications are merged), avoiding one big drain after a
/// full backlog — that would amplify drain's per-task whole-queue scan into O(n²), measuring
/// the lane's own scheduler complexity rather than defects, while still preserving the target
/// surface of "high-density merging within a window".
pub fn stress_storm_probe(
    seed: u64,
    total_events: u64,
) -> Result<(u64, u64, usize), StressViolation> {
    let mut s = Scheduler::new(SchedulerOptions::default());
    let mut rng = Rng::new(seed.wrapping_add(0x9E3779B97F4A7C15));
    let mut buffer = crate::StormBuffer::new(64);
    let mut totals = StormTotals::new();
    let mut version_clock: u64 = 0;

    // Only put events on 8 files: heavy same-file duplication, hence the high-density merging
    // surface.
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
            // Count conservation: the cumulative enqueued count must be fully absorbed by the
            // cumulative terminal states (terminal counts are monotonically cumulative; they
            // must not be zeroed per window — after zeroing they are incomparable with the
            // cumulative values).
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

    // Merging loses no events: total events = cumulative de-duplicated count of the buffer +
    // landed entries (merged is itself a cumulative value, so do not accumulate it again per
    // window — double accumulation would misreport a correct merging surface as lost events).
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

    /// Direct test of StressOptions::default(): the long-running lane's default shape
    /// (never read before).
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

    /// xorshift64's only bad point = 0 (stuck at 0): seed=0 must be substituted with the golden
    /// constant, and the resulting sequence must be exactly the same as passing that golden
    /// constant explicitly (the reproduction surfaces are equivalent).
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
        // below(0)/below(1) are always 0 (division-by-zero guard).
        assert_eq!(Rng::new(7).below(0), 0);
        assert_eq!(Rng::new(7).below(1), 0);
    }

    /// A scheduler that has been drained and retains n terminal entries (for direct tests of
    /// assert_invariants).
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

    /// Count-conservation arm: inflating created → completed+failed+cancelled != created.
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

    /// Cancel-leak arm: inflating the cancel success count → cancelled < cancel_successes.
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

    /// Ok-path peak sampling: after draining, retained terminal entries must be written back
    /// into peaks.retained (the run_stress main loop samples peaks itself first; this arm is
    /// only visible on the direct-test surface).
    #[test]
    fn assert_invariants_ok_updates_peak_retained() {
        let mut s = drained_with_terminals(3);
        let mut peaks = Peaks::default();
        let mut checks = 0u64;
        assert_invariants(&mut s, 1, 3, 0, &mut peaks, &mut checks).expect("守恒成立");
        assert_eq!(checks, 1);
        assert_eq!(peaks.retained, 3, "驻留终态条目数回写峰值");
    }

    /// Drain-failure arm: with the interactive cooldown >> the drain budget (60s) and an even
    /// farther starvation ceiling, background tasks cannot be promoted within the budget →
    /// the detector turns red on "cannot drain = stuck permanently".
    /// (Semantics: this pins down the detector's guard and diagnostic content, not a real
    /// deadlock; production's default cooldown is 50ms << 60s.)
    #[test]
    fn assert_invariants_reports_undrained_queue_as_deadlock() {
        let mut s = Scheduler::new(SchedulerOptions {
            interactive_cooldown_ms: 200_000,
            starvation_limit_ms: 400_000,
            max_queued: None,
        });
        // Run an interactive task first, anchoring the start of the cooldown window.
        s.enqueue(make_spec(
            TaskKind::SingleFileUpdate,
            0,
            Some("/cov/interactive.def"),
            Some(1),
            1,
            false,
        ));
        s.drain(1_000);
        // Then enqueue a background task: within drain(60s) it can neither clear the cooldown
        // nor reach starvation promotion.
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

    /// Detector failure propagates through run_stress: both lanes, the periodic assertion (the
    /// `?` at 310) and the final assertion (the `?` at 321), must hand the Err back to the
    /// caller unchanged.
    ///
    /// The cooldown window is anchored by an interactive task (with no interactive enqueueing,
    /// NEVER_MS leaves background unthrottled), and under 200 ops an interactive task is bound
    /// to be enqueued (deterministic seed, not a probabilistic assertion).
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
        // Periodic assertion: at op=50 the drain budget is exhausted and it turns red.
        let v = run_stress(1, undrainable(50)).expect_err("周期断言必传播失败");
        assert_eq!(v.kind, "deadlock-or-permanent-pending");
        // Final assertion: check_every=0 disables the periodic surface, only the closing `?`
        // runs.
        let v = run_stress(1, undrainable(0)).expect_err("终局断言必传播失败");
        assert_eq!(v.kind, "deadlock-or-permanent-pending");
    }

    /// Storm landing-drop arm: the queue already holds a newer version of the same file (v9)
    /// and the buffer then lands the older one (v5) → StaleDropped → the "storm event not
    /// accepted" red (the surface where the monotonic-version promise is broken).
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
        // Semantics: landed = the number of events that left the buffer and entered the landing
        // flow (counted before the acceptance decision), and whether they were accepted is
        // expressed by the Err; created only increments on a real enqueue.
        assert_eq!(totals.landed, 2);
        assert_eq!(totals.created, 1);
    }
}
