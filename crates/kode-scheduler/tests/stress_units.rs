//! RUST-083(旧 CORE-018)压力车道默认门禁:小规模不变量车道进 cargo test
//! (长跑 lane 见 src/bin/kode-scheduler-stress.rs 与 CI)。
//!
//! 检测面与长跑同源(同 `kode_scheduler::stress` 入口),窗口收紧使 debug
//! 构建下秒级完成;任一不变量破坏(死锁/永久 pending/计数不守恒/取消泄漏/
//! 内存无界/keyed 假 pending)即测试红。

use kode_scheduler::stress::{run_stress, stress_storm_probe, StressOptions};
use kode_scheduler::MAX_RETAINED_TERMINAL_TASKS;

fn small_opts(total_ops: u64) -> StressOptions {
    StressOptions {
        total_ops,
        max_queued: 0,
        interactive_cooldown_ms: 50,
        starvation_limit_ms: 5_000,
        // 小窗口高频检查:队列保持浅,debug 构建秒级完成且检查面覆盖率高。
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
    // 高取消率:取消泄漏(取消后复活/计数丢失)在此压力下最易暴露。
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
    // 有界队列(max_queued=64):队列满淘汰面 + 内存闸共存。
    let opts = StressOptions {
        max_queued: 64,
        ..small_opts(4_000)
    };
    let report = run_stress(9, opts).expect("有界队列下不变量成立");
    assert!(report.peak_retained <= 64 + MAX_RETAINED_TERMINAL_TASKS);
}

#[test]
fn stress_lane_seeds_diverge() {
    // seed 复现面:不同 seed 必须产生不同负载(此前 |1 折叠偶数 seed 的缺陷)。
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
    // 单调版本下任何丢弃都是缺陷:长跑抽 20 万事件面做默认门。
    let (seen, merged, landed) = stress_storm_probe(11, 200_000).expect("风暴面无事件丢失");
    assert_eq!(seen, merged + landed as u64, "事件总数 = 合并数 + 落盘数");
    assert!(merged > 0, "8 文件高密度下必然产生合并");
}
