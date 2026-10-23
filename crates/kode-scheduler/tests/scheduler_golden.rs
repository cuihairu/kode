//! 调度面对拍 golden 双向门禁(PR-009;与 PR-005/006/007 同构)。
//!
//! - 正本:`crates/kode-scheduler/tests/golden/scheduler-parity.json`
//!   (由 `cargo run -p kode-scheduler --bin dump-scheduler-golden` 生成);
//! - 本测试重生成比对(防 golden 与实现漂移)+ 结构完整性断言;
//! - TS 侧复算:`tests/kodeSchedulerParity.test.ts`(真实 IndexScheduler +
//!   fake timers 重放同一串 ops,逐字段比对)。

use kode_scheduler::golden::{build_scenarios, dump_golden, replay, GOLDEN_REL_PATH};

#[test]
fn golden_matches_regenerated_dump() {
    // GOLDEN_REL_PATH 以仓库根为基准(与 dump-scheduler-golden 的落盘路径一致)。
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest
        .parent()
        .and_then(|p| p.parent())
        .expect("crate under <root>/crates");
    let path = repo_root.join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&path).expect("golden file committed");
    assert_eq!(
        dump_golden(),
        committed,
        "golden 漂移:重新运行 dump-scheduler-golden 并提交"
    );
}

#[test]
fn golden_covers_ten_scenarios_with_decisions() {
    let scenarios = build_scenarios();
    assert_eq!(scenarios.len(), 10);
    for scenario in &scenarios {
        let outcome = replay(scenario);
        assert!(
            !outcome.decisions.is_empty(),
            "scenario {} must record decisions",
            scenario.name
        );
        // 决策面口径:每个 enqueue/ensure 恰好一条决策。
        let decision_ops = scenario
            .ops
            .iter()
            .filter(|op| {
                matches!(
                    op,
                    kode_scheduler::golden::Op::Enqueue { .. }
                        | kode_scheduler::golden::Op::Ensure { .. }
                )
            })
            .count()
            + scenario
                .ops
                .iter()
                .filter(|op| matches!(op, kode_scheduler::golden::Op::CancelQueued { .. }))
                .count();
        assert_eq!(
            outcome.decisions.len(),
            decision_ops,
            "scenario {}",
            scenario.name
        );
    }
}

#[test]
fn golden_key_scenarios_assert_expected_semantics() {
    let by_name = |name: &str| {
        build_scenarios()
            .into_iter()
            .find(|s| s.name == name)
            .expect("scenario exists")
    };
    let merged = replay(&by_name("same-file-same-version-merges"));
    assert_eq!(
        merged.decisions,
        vec!["queued".to_string(), "merged".to_string()]
    );
    assert_eq!(merged.metrics.merged_tasks, 1);
    assert_eq!(merged.run_order.len(), 1);

    let cooldown = replay(&by_name("interactive-cooldown-postpones-background"));
    assert_eq!(cooldown.metrics.postponed_background, 1);
    assert_eq!(
        cooldown.run_order,
        vec![
            "single-file-update:/a.def:1".to_string(),
            "full-reindex::".to_string()
        ]
    );

    let priority = replay(&by_name("priority-order"));
    assert_eq!(
        priority.run_order,
        vec![
            "single-file-update:/a.def:1".to_string(),
            "dependency-update:/b.def:1".to_string(),
            "full-reindex::".to_string()
        ]
    );
}
