//! RUST-083 (formerly CORE-018) stress-lane default gate: the small-scale invariant lane runs
//! inside cargo test (for the long-running lane see src/bin/kode-scheduler-stress.rs and CI).
//!
//! The detection surface shares its origin with the long run (the same `kode_scheduler::stress`
//! entry point), and the tightened window finishes in seconds under a debug build; any broken
//! invariant (deadlock / permanently pending / non-conserved counts / cancellation leak /
//! unbounded memory / keyed false-pending) turns the test red.

use kode_scheduler::stress::{run_stress, stress_storm_probe, StressOptions};
use kode_scheduler::MAX_RETAINED_TERMINAL_TASKS;

fn small_opts(total_ops: u64) -> StressOptions {
    StressOptions {
        total_ops,
        max_queued: 0,
        interactive_cooldown_ms: 50,
        starvation_limit_ms: 5_000,
        // Small window, high check frequency: the queue stays shallow, a debug build finishes in
        // seconds, and the check-surface coverage is high.
        check_every: 200,
        cancel_rate_pct: 5,
    }
}

#[test]
fn stress_lane_small_seed_holds_all_invariants() {
    let report = run_stress(1, small_opts(5_000)).expect("不变量成立");
    assert_eq!(
        report.completed + report.failed + report.cancelled,
        report.created,
        "计数守恒"
    );
    assert!(report.checks_run >= 20, "checks_run={}", report.checks_run);
    assert!(
        report.peak_retained <= report.peak_queued + MAX_RETAINED_TERMINAL_TASKS,
        "peak_retained={} peak_queued={}",
        report.peak_retained,
        report.peak_queued
    );
}

#[test]
fn stress_lane_cancel_heavy_holds_conservation() {
    // High cancellation rate: cancellation leaks (a cancelled task reviving / lost counts) are
    // most likely to surface under this pressure.
    let opts = StressOptions {
        cancel_rate_pct: 40,
        ..small_opts(5_000)
    };
    let report = run_stress(7, opts).expect("高取消率下不变量仍成立");
    assert_eq!(
        report.completed + report.failed + report.cancelled,
        report.created,
        "计数守恒"
    );
    assert!(
        report.cancel_successes <= report.cancelled,
        "cancel 成功 {} 次 > cancelled {}(取消面失真)",
        report.cancel_successes,
        report.cancelled
    );
}

#[test]
fn stress_lane_bounded_queue_holds_memory_ceiling() {
    // Bounded queue (max_queued=64): the queue-full eviction surface and the memory gate coexist.
    let opts = StressOptions {
        max_queued: 64,
        ..small_opts(4_000)
    };
    let report = run_stress(9, opts).expect("有界队列下不变量成立");
    assert!(report.peak_retained <= 64 + MAX_RETAINED_TERMINAL_TASKS);
}

#[test]
fn stress_lane_seeds_diverge() {
    // Seed reproduction surface: different seeds must produce different loads (there was a prior
    // defect where |1 collapsed even seeds).
    let a = run_stress(2, small_opts(2_000)).expect("seed=2");
    let b = run_stress(3, small_opts(2_000)).expect("seed=3");
    assert_ne!(
        (a.created, a.completed, a.cancelled),
        (b.created, b.completed, b.cancelled),
        "不同 seed 产生完全相同统计(随机源折叠)"
    );
}

#[test]
fn storm_probe_monotone_versions_never_drop_events() {
    // Under monotonic versions any drop is a defect: the default gate samples the 200k-event
    // storm surface from the long run.
    let (seen, merged, landed) = stress_storm_probe(11, 200_000).expect("风暴面无事件丢失");
    assert_eq!(seen, merged + landed as u64, "事件总数 = 合并数 + 落盘数");
    assert!(merged > 0, "8 文件高密度下必然产生合并");
}

#[test]
fn stress_dense_sampling_captures_queued_peak() {
    // check_every=1 samples on every operation: the transient queue depth at enqueue time reaches
    // the peak surface (otherwise the peak would stay 0 and the sampling arm would be useless).
    let opts = StressOptions {
        total_ops: 2_000,
        max_queued: 0,
        interactive_cooldown_ms: 50,
        starvation_limit_ms: 5_000,
        check_every: 1,
        cancel_rate_pct: 5,
    };
    let report = run_stress(7, opts).expect("不变量成立");
    assert!(report.peak_queued >= 1, "密集采样必须捕获到排队峰值");
}
