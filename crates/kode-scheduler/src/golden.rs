//! 与 TS `src/indexScheduler.ts` 调度面对拍 golden(fixture 驱动,ARCH-012:
//! 只对行为决策面,不做性能对比)。
//!
//! 场景 = 一串调度操作(enqueue / ensure / advance / drain / cancel-queued)。
//! Rust 侧 [`replay`] 在逻辑时钟下执行并记录决策面(decisions/runOrder/
//! 终态快照);TS 侧 `tests/kodeSchedulerParity.test.ts` 用真实 `IndexScheduler`
//! 加 vitest fake timers 复算同一串 ops,逐字段比对。
//! golden 由 Rust `dump-scheduler-golden` 产出、TS 复算,双向门禁与
//! PR-005/006/007 同构。

use std::cell::RefCell;
use std::rc::Rc;

use crate::model::TaskKind;
use crate::scheduler::{EnqueueDecision, Scheduler, SchedulerOptions, TaskSpec};

pub const GOLDEN_REL_PATH: &str = "crates/kode-scheduler/tests/golden/scheduler-parity.json";
pub const INTERACTIVE_COOLDOWN_MS: u64 = 50;

/// 对拍场景操作(TS 侧按同名义重放)。
#[derive(Debug, Clone)]
pub enum Op {
    Enqueue {
        kind: &'static str,
        priority: u8,
        file: Option<&'static str>,
        version: Option<u64>,
    },
    Ensure {
        key: &'static str,
        kind: &'static str,
        priority: u8,
        fail: bool,
    },
    Advance {
        ms: u64,
    },
    Drain {
        ms: u64,
    },
    CancelQueued {
        reason: &'static str,
    },
}

#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: &'static str,
    pub ops: Vec<Op>,
}

/// 单场景重放结果(= golden 中的 expected 块)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenarioOutcome {
    pub decisions: Vec<String>,
    pub run_order: Vec<String>,
    pub completed: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub queued: usize,
    pub queued_by_priority: Vec<(u8, usize)>,
    pub keyed_tasks: Vec<(String, String)>,
    pub metrics: crate::model::SchedulerMetrics,
}

/// 对拍场景全集(10 个;每个 op 语义见 docs/kode2/pr-009.md)。
pub fn build_scenarios() -> Vec<Scenario> {
    let enq =
        |kind: &'static str, priority: u8, file: Option<&'static str>, version: Option<u64>| {
            Op::Enqueue {
                kind,
                priority,
                file,
                version,
            }
        };
    vec![
        Scenario {
            name: "priority-order",
            ops: vec![
                enq("full-reindex", 3, None, None),
                enq("single-file-update", 0, Some("/a.def"), Some(1)),
                enq("dependency-update", 2, Some("/b.def"), Some(1)),
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "same-file-same-version-merges",
            ops: vec![
                enq("dependency-update", 2, Some("/a.def"), Some(1)),
                enq("single-file-update", 0, Some("/a.def"), Some(1)),
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "newer-version-cancels-older",
            ops: vec![
                enq("single-file-update", 1, Some("/a.def"), Some(1)),
                enq("single-file-update", 1, Some("/a.def"), Some(2)),
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "older-version-dropped",
            ops: vec![
                enq("single-file-update", 1, Some("/a.def"), Some(2)),
                enq("single-file-update", 1, Some("/a.def"), Some(1)),
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "interactive-cooldown-postpones-background",
            ops: vec![
                enq("single-file-update", 0, Some("/a.def"), Some(1)),
                Op::Drain { ms: 0 },
                Op::Advance { ms: 10 },
                enq("full-reindex", 3, None, None),
                Op::Drain { ms: 0 },
                Op::Advance { ms: 60 },
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "keyed-singleton-reuse",
            ops: vec![
                Op::Ensure {
                    key: "initial-scan",
                    kind: "initial-scan",
                    priority: 3,
                    fail: false,
                },
                Op::Ensure {
                    key: "initial-scan",
                    kind: "initial-scan",
                    priority: 3,
                    fail: false,
                },
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "keyed-failure-recovers",
            ops: vec![
                Op::Ensure {
                    key: "initial-scan",
                    kind: "initial-scan",
                    priority: 3,
                    fail: true,
                },
                Op::Drain { ms: 200 },
                Op::Ensure {
                    key: "initial-scan",
                    kind: "initial-scan",
                    priority: 3,
                    fail: false,
                },
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "cancel-queued-batch",
            ops: vec![
                enq("full-reindex", 3, None, None),
                enq("full-reindex", 3, None, None),
                enq("full-reindex", 3, None, None),
                Op::CancelQueued {
                    reason: "test-reset",
                },
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "same-priority-fair-order",
            ops: vec![
                enq("single-file-update", 1, Some("/a1.def"), Some(1)),
                enq("single-file-update", 1, Some("/a2.def"), Some(1)),
                enq("single-file-update", 1, Some("/a3.def"), Some(1)),
                Op::Drain { ms: 200 },
            ],
        },
        Scenario {
            name: "mixed-storm-surface",
            ops: vec![
                enq("dependency-update", 2, Some("/a.def"), Some(1)),
                enq("single-file-update", 1, Some("/a.def"), Some(1)),
                enq("dependency-update", 2, Some("/a.def"), Some(2)),
                enq("full-reindex", 3, None, None),
                enq("single-file-update", 1, Some("/a.def"), Some(0)),
                enq("single-file-update", 0, Some("/c.def"), Some(1)),
                Op::Drain { ms: 200 },
                enq("full-reindex", 3, Some("/b.def"), Some(2)),
            ],
        },
    ]
}

fn descriptor(kind: &str, file: Option<&str>, version: Option<u64>) -> String {
    format!(
        "{}:{}:{}",
        kind,
        file.unwrap_or(""),
        version.map(|v| v.to_string()).unwrap_or_default()
    )
}

/// 在全新调度器上重放一个场景(逻辑时钟;交互冷却与 TS 默认一致)。
pub fn replay(scenario: &Scenario) -> ScenarioOutcome {
    let mut sched = Scheduler::new(SchedulerOptions {
        interactive_cooldown_ms: INTERACTIVE_COOLDOWN_MS,
        ..SchedulerOptions::default()
    });
    let run_order: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let mut decisions: Vec<String> = Vec::new();

    for op in &scenario.ops {
        match op {
            Op::Enqueue {
                kind,
                priority,
                file,
                version,
            } => {
                let pre = sched.status();
                let desc = descriptor(kind, *file, *version);
                let order = run_order.clone();
                let kind = TaskKind::parse(kind).expect("golden kinds are valid");
                let spec = TaskSpec {
                    kind,
                    priority: *priority,
                    file: (*file).map(str::to_string),
                    version: *version,
                    target: None,
                    run: Box::new(move |_| {
                        order.borrow_mut().push(desc.clone());
                        Ok(())
                    }),
                };
                let outcome = sched.enqueue(spec);
                let post = sched.status();
                let decision = if post.metrics.merged_tasks > pre.metrics.merged_tasks {
                    "merged"
                } else if outcome.decision == EnqueueDecision::StaleDropped {
                    "stale-dropped"
                } else if post.cancelled > pre.cancelled {
                    "stale-cancel"
                } else {
                    "queued"
                };
                decisions.push(decision.to_string());
            }
            Op::Ensure {
                key,
                kind,
                priority,
                fail,
            } => {
                let prev = sched.status().keyed_tasks.get(*key).cloned();
                let desc = descriptor(kind, None, None);
                let order = run_order.clone();
                let fail = *fail;
                let kind = TaskKind::parse(kind).expect("golden kinds are valid");
                let spec = TaskSpec {
                    kind,
                    priority: *priority,
                    file: None,
                    version: None,
                    target: None,
                    run: Box::new(move |_| {
                        order.borrow_mut().push(desc.clone());
                        if fail {
                            Err("boom".to_string())
                        } else {
                            Ok(())
                        }
                    }),
                };
                let _ = sched.ensure(key, spec);
                let decision = match prev.as_deref() {
                    None | Some("completed") => "queued",
                    Some("queued") | Some("running") => "reused",
                    _ => "recovered",
                };
                decisions.push(decision.to_string());
            }
            Op::Advance { ms } => sched.advance_clock(*ms),
            Op::Drain { ms } => sched.drain(*ms),
            Op::CancelQueued { reason } => {
                let n = sched.cancel_queued_tasks(reason);
                decisions.push(format!("cancelled:{n}"));
            }
        }
    }

    let status = sched.status();
    let outcome = ScenarioOutcome {
        decisions,
        run_order: run_order.borrow().clone(),
        completed: status.completed,
        failed: status.failed,
        cancelled: status.cancelled,
        queued: status.queued,
        queued_by_priority: status.queued_by_priority.clone().into_iter().collect(),
        keyed_tasks: status.keyed_tasks.clone().into_iter().collect(),
        metrics: status.metrics,
    };
    outcome
}

// ---- JSON 序列化(零依赖;TS 侧 JSON.parse 消费) ----

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out.push(',');
    out
}

fn json_opt_str(v: &Option<&str>) -> Option<String> {
    v.map(|s| format!("\"file\":{}", json_str(s).trim_end_matches(',')))
}

fn json_opt_num(v: &Option<u64>) -> Option<String> {
    v.map(|n| format!("\"version\":{n}"))
}

fn op_json(op: &Op) -> String {
    match op {
        Op::Enqueue {
            kind,
            priority,
            file,
            version,
        } => {
            let mut parts = vec![
                "\"op\":\"enqueue\"".to_string(),
                format!("\"kind\":{}", json_str(kind).trim_end_matches(',')),
                format!("\"priority\":{priority}"),
            ];
            if let Some(f) = json_opt_str(file) {
                parts.push(f);
            }
            if let Some(v) = json_opt_num(version) {
                parts.push(v);
            }
            format!("{{{}}}", parts.join(","))
        }
        Op::Ensure {
            key,
            kind,
            priority,
            fail,
        } => format!(
            "{{\"op\":\"ensure\",\"key\":{},\"kind\":{},\"priority\":{priority},\"fail\":{fail}}}",
            json_str(key).trim_end_matches(','),
            json_str(kind).trim_end_matches(',')
        ),
        Op::Advance { ms } => format!("{{\"op\":\"advance\",\"ms\":{ms}}}"),
        Op::Drain { ms } => format!("{{\"op\":\"drain\",\"ms\":{ms}}}"),
        Op::CancelQueued { reason } => format!(
            "{{\"op\":\"cancel-queued\",\"reason\":{}}}",
            json_str(reason).trim_end_matches(',')
        ),
    }
}

fn str_list_json(items: &[String]) -> String {
    let inner: Vec<String> = items
        .iter()
        .map(|s| json_str(s).trim_end_matches(',').to_string())
        .collect();
    format!("[{}]", inner.join(","))
}

fn str_pairs_json(pairs: &[(String, String)]) -> String {
    let inner: Vec<String> = pairs
        .iter()
        .map(|(k, v)| {
            format!(
                "{}:{}",
                json_str(k).trim_end_matches(','),
                json_str(v).trim_end_matches(',')
            )
        })
        .collect();
    format!("{{{}}}", inner.join(","))
}

fn num_pairs_json(pairs: &[(String, u64)]) -> String {
    let inner: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{}:{v}", json_str(k).trim_end_matches(',')))
        .collect();
    format!("{{{}}}", inner.join(","))
}

fn metrics_json(m: &crate::model::SchedulerMetrics) -> String {
    format!(
        "{{\"mergedTasks\":{},\"staleDropped\":{},\"postponedBackground\":{},\"backgroundDelayMs\":{},\"recoveries\":{},\"evictedQueueFull\":{},\"queueFullRejected\":{},\"antiStarvationPromotions\":{}}}",
        m.merged_tasks,
        m.stale_dropped,
        m.postponed_background,
        m.background_delay_ms,
        m.recoveries,
        m.evicted_queue_full,
        m.queue_full_rejected,
        m.anti_starvation_promotions
    )
}

fn outcome_json(name: &str, scenario: &Scenario, outcome: &ScenarioOutcome) -> String {
    let ops: Vec<String> = scenario.ops.iter().map(op_json).collect();
    let keyed: Vec<(String, String)> = outcome
        .keyed_tasks
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let qbp: Vec<(String, u64)> = outcome
        .queued_by_priority
        .iter()
        .map(|(k, v)| (format!("{k}"), *v as u64))
        .collect();
    let expected = format!(
        "{{\"decisions\":{},\"runOrder\":{},\"completed\":{},\"failed\":{},\"cancelled\":{},\"queued\":{},\"queuedByPriority\":{},\"keyedTasks\":{},\"metrics\":{}}}",
        str_list_json(&outcome.decisions),
        str_list_json(&outcome.run_order),
        outcome.completed,
        outcome.failed,
        outcome.cancelled,
        outcome.queued,
        num_pairs_json(&qbp),
        str_pairs_json(&keyed),
        metrics_json(&outcome.metrics)
    );
    format!(
        "{{\"name\":{},\"ops\":[{}],\"expected\":{}}}",
        json_str(name).trim_end_matches(','),
        ops.join(","),
        expected
    )
}

/// golden 全文(由 `dump-scheduler-golden` 落盘,TS 复算对拍)。
pub fn dump_golden() -> String {
    let scenarios = build_scenarios();
    let bodies: Vec<String> = scenarios
        .iter()
        .map(|s| outcome_json(s.name, s, &replay(s)))
        .collect();
    format!(
        "{{\n  \"generator\": {},\n  \"note\": {},\n  \"interactiveCooldownMs\": {},\n  \"scenarioCount\": {},\n  \"scenarios\": [\n    {}\n  ]\n}}\n",
        json_str("kode-scheduler dump-scheduler-golden").trim_end_matches(','),
        json_str("decision-surface parity with src/indexScheduler.ts (ARCH-012: no perf comparison)").trim_end_matches(','),
        INTERACTIVE_COOLDOWN_MS,
        scenarios.len(),
        bodies.join(",\n    ")
    )
}
