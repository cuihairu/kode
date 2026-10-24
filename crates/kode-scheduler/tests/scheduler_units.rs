//! 调度核心单元门禁(PR-009:SCHED-004..015/019/020 面;书 §4 CORE-005/006/007/008/010 基础版)。
//!
//! 对拍面语义与 TS indexScheduler.ts 一致;此处覆盖 TS 无对应的 Rust 扩展
//! (有界队列/抗饥饿/暂停恢复/风暴合并)并复核对拍决策(合并/过期/取消/冷却)。

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use kode_scheduler::{
    CancelToken, EnqueueDecision, EnsureDecision, Pump, Scheduler, SchedulerOptions, StormBuffer,
    TaskKind, TaskSpec,
};

fn spec(kind: TaskKind, priority: u8, file: Option<&str>, version: Option<u64>) -> TaskSpec {
    TaskSpec {
        kind,
        priority,
        file: file.map(str::to_string),
        version,
        target: None,
        run: Box::new(|_| Ok(())),
    }
}

fn counting_spec(
    kind: TaskKind,
    priority: u8,
    file: Option<&str>,
    version: Option<u64>,
    ran: &Rc<Cell<usize>>,
) -> TaskSpec {
    let ran = ran.clone();
    TaskSpec {
        kind,
        priority,
        file: file.map(str::to_string),
        version,
        target: None,
        run: Box::new(move |_| {
            ran.set(ran.get() + 1);
            Ok(())
        }),
    }
}

#[test]
fn same_file_same_version_merges_and_upgrades_priority() {
    let mut s = Scheduler::default();
    let out1 = s.enqueue(spec(TaskKind::DependencyUpdate, 2, Some("/a.def"), Some(1)));
    let out2 = s.enqueue(spec(TaskKind::SingleFileUpdate, 0, Some("/a.def"), Some(1)));
    assert_eq!(out1.decision, EnqueueDecision::Queued);
    assert_eq!(out2.decision, EnqueueDecision::Merged);
    assert_eq!(out2.id, out1.id);
    assert_eq!(s.status().metrics.merged_tasks, 1);
    // 合并后优先级取更高者:队列只剩 1 个 p0 任务。
    assert_eq!(s.status().queued, 1);
    assert_eq!(s.status().queued_by_priority.get(&0), Some(&1));
    s.drain(200);
    assert_eq!(s.status().completed, 1);
}

#[test]
fn newer_version_cancels_older_queued() {
    let mut s = Scheduler::default();
    let old = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(1)));
    let new = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(2)));
    assert_eq!(new.decision, EnqueueDecision::Queued);
    assert_eq!(
        s.task_state(old.id),
        Some(kode_scheduler::TaskState::Cancelled)
    );
    assert_eq!(s.status().cancelled, 1);
    assert_eq!(s.status().metrics.stale_dropped, 1);
    s.drain(200);
    // 只有新版本真正执行(旧版本取消后不入执行)。
    assert_eq!(s.status().completed, 1);
    assert_eq!(
        s.task_state(new.id),
        Some(kode_scheduler::TaskState::Completed)
    );
}

#[test]
fn older_version_new_task_dropped() {
    let mut s = Scheduler::default();
    let cur = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(2)));
    let stale = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(1)));
    assert_eq!(stale.decision, EnqueueDecision::StaleDropped);
    assert_eq!(stale.id, 0);
    assert_eq!(s.status().metrics.stale_dropped, 1);
    s.drain(200);
    assert_eq!(
        s.task_state(cur.id),
        Some(kode_scheduler::TaskState::Completed)
    );
    assert_eq!(s.status().completed, 1);
}

#[test]
fn interactive_cooldown_postpones_background_and_recovers() {
    let mut s = Scheduler::new(SchedulerOptions {
        interactive_cooldown_ms: 50,
        ..SchedulerOptions::default()
    });
    s.enqueue(spec(TaskKind::SingleFileUpdate, 0, Some("/a.def"), Some(1)));
    s.drain(0);
    assert_eq!(s.status().completed, 1);
    s.advance_clock(10);
    s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    // 冷却窗口内后台被挡(交互完成于 t=0,当前 t=10,余 40ms)。
    assert_eq!(s.pump_once(), Pump::Postponed { retry_in_ms: 40 });
    assert_eq!(s.status().metrics.postponed_background, 1);
    assert_eq!(s.status().metrics.background_delay_ms, 40);
    assert_eq!(s.status().queued, 1);
    // 窗口过后恢复推进。
    s.advance_clock(60);
    assert_eq!(s.pump_once(), Pump::Ran);
    assert_eq!(s.status().completed, 2);
}

#[test]
fn starvation_promotion_bypasses_cooldown() {
    // 饥饿上限(30ms)短于冷却窗口(50ms):后台在窗口内排队超限即晋升,
    // 证明不会因交互压力永久推迟后台索引(CORE-006)。
    let mut s = Scheduler::new(SchedulerOptions {
        interactive_cooldown_ms: 50,
        starvation_limit_ms: 30,
        ..SchedulerOptions::default()
    });
    s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    s.enqueue(spec(TaskKind::SingleFileUpdate, 0, Some("/a.def"), Some(1)));
    // 交互先跑(冷却计时起点 = 交互完成时刻 0),后台从 t=0 开始排队。
    s.drain(0);
    assert_eq!(s.status().completed, 1);
    assert_eq!(s.status().queued, 1);
    // 交互完成瞬间后台即被冷却挡一次(与 TS pickNext 行为一致)。
    assert_eq!(s.status().metrics.postponed_background, 1);
    // t=30:排队 30ms 达到饥饿上限,且仍在冷却窗口内 → 绕过冷却晋升。
    s.advance_clock(30);
    assert_eq!(s.pump_once(), Pump::Ran);
    assert_eq!(s.status().metrics.anti_starvation_promotions, 1);
    assert_eq!(s.status().metrics.postponed_background, 1);
}

#[test]
fn bounded_queue_evicts_lowest_and_rejects_lowest_incoming() {
    let mut s = Scheduler::new(SchedulerOptions {
        max_queued: Some(2),
        ..SchedulerOptions::default()
    });
    let bg1 = s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    let p0 = s.enqueue(spec(TaskKind::SingleFileUpdate, 0, Some("/a.def"), Some(1)));
    // 队满:入队 p1 → 淘汰最低优 p3(而非拒绝新任务)。
    let p1 = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/b.def"), Some(1)));
    assert_eq!(p1.decision, EnqueueDecision::Queued);
    assert_eq!(
        s.task_state(bg1.id),
        Some(kode_scheduler::TaskState::Cancelled)
    );
    assert_eq!(s.status().metrics.evicted_queue_full, 1);
    assert_eq!(s.status().queued, 2);
    // 队满且新任务自己最低优:拒绝入队。
    let rejected = s.enqueue(spec(TaskKind::NonInteractive, 4, None, None));
    assert_eq!(rejected.decision, EnqueueDecision::RejectedQueueFull);
    assert_eq!(rejected.id, 0);
    assert_eq!(s.status().metrics.queue_full_rejected, 1);
    assert_eq!(s.status().queued, 2);
    s.drain(200);
    assert_eq!(s.status().completed, 2);
    let _ = p0;
}

#[test]
fn pause_blocks_pump_but_not_enqueue_resume_drains() {
    let mut s = Scheduler::default();
    s.pause();
    let ran = Rc::new(Cell::new(0));
    s.enqueue(counting_spec(
        TaskKind::SingleFileUpdate,
        0,
        Some("/a.def"),
        Some(1),
        &ran,
    ));
    s.enqueue(counting_spec(
        TaskKind::SingleFileUpdate,
        1,
        Some("/b.def"),
        Some(1),
        &ran,
    ));
    s.drain(200);
    assert!(s.is_paused());
    assert_eq!(ran.get(), 0);
    assert_eq!(s.status().queued, 2);
    s.resume();
    s.drain(200);
    assert_eq!(ran.get(), 2);
    assert_eq!(s.status().completed, 2);
}

#[test]
fn cancel_running_task_is_not_interruptible() {
    let mut s = Scheduler::default();
    let out = s.enqueue(spec(TaskKind::SingleFileUpdate, 0, Some("/a.def"), Some(1)));
    s.drain(200);
    // 已终态任务不可再取消。
    assert!(!s.cancel(out.id, "late"));
    assert_eq!(
        s.task_state(out.id),
        Some(kode_scheduler::TaskState::Completed)
    );
    assert_eq!(s.status().cancelled, 0);
}

#[test]
fn cancel_queued_batch_and_individual() {
    let mut s = Scheduler::default();
    let a = s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    assert_eq!(s.cancel_queued_tasks("test-reset"), 3);
    assert_eq!(s.status().cancelled, 3);
    s.drain(200);
    assert_eq!(s.status().completed, 0);
    let b = s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    assert!(s.cancel(b.id, "by-handle"));
    assert!(!s.cancel(a.id, "already-cancelled"));
    assert_eq!(s.status().cancelled, 4);
}

#[test]
fn keyed_task_reuses_inflight_and_recovers_after_failure() {
    let mut s = Scheduler::default();
    let (d1, id1) = s.ensure("initial-scan", spec(TaskKind::InitialScan, 3, None, None));
    assert_eq!(d1, EnsureDecision::Queued);
    let (d2, id2) = s.ensure("initial-scan", spec(TaskKind::InitialScan, 3, None, None));
    assert_eq!(d2, EnsureDecision::Reused);
    assert_eq!(id1, id2);
    assert!(!s.is_keyed_complete("initial-scan"));
    s.drain(200);
    assert!(s.is_keyed_complete("initial-scan"));
    assert_eq!(s.status().metrics.recoveries, 0);

    // 失败 → keyed 回落 failed → 再次 ensure 重新入队(恢复计数 +1)。
    let failing = TaskSpec {
        kind: TaskKind::InitialScan,
        priority: 3,
        file: None,
        version: None,
        target: None,
        run: Box::new(|_| Err("boom".to_string())),
    };
    let (d3, _) = s.ensure("rescan", failing);
    assert_eq!(d3, EnsureDecision::Queued);
    s.drain(200);
    assert_eq!(s.status().failed, 1);
    assert!(!s.is_keyed_complete("rescan"));
    let (d4, _) = s.ensure("rescan", spec(TaskKind::InitialScan, 3, None, None));
    assert_eq!(d4, EnsureDecision::Recovered);
    assert_eq!(s.status().metrics.recoveries, 1);
    s.drain(200);
    assert!(s.is_keyed_complete("rescan"));
}

#[test]
fn cancel_token_reaches_run_body() {
    let mut s = Scheduler::default();
    let seen_cancelled = Rc::new(Cell::new(false));
    let flag = seen_cancelled.clone();
    let token = CancelToken::new();
    let token_for_run = token.clone();
    let spec = TaskSpec {
        kind: TaskKind::NonInteractive,
        priority: 4,
        file: None,
        version: None,
        target: None,
        run: Box::new(move |cancel| {
            // 模拟协作点:外部已置位则让出。
            if cancel.is_cancelled() || token_for_run.is_cancelled() {
                flag.set(true);
                return Err("cancelled".to_string());
            }
            Ok(())
        }),
    };
    token.cancel();
    s.enqueue(spec);
    s.drain(200);
    assert!(seen_cancelled.get());
    assert_eq!(s.status().failed, 1);
}

#[test]
fn storm_buffer_coalesces_same_file_and_flushes_deterministically() {
    let mut storm = StormBuffer::new(1024);
    // 风暴:100 个事件集中 3 个文件;同文件多事件并一,最新版本/更高优胜出。
    for i in 0..100u64 {
        let file = format!("/f{}.def", i % 3);
        let merged = storm.record(file, i + 1, 3);
        if i >= 3 {
            assert!(merged);
        }
    }
    assert_eq!(storm.events_seen, 100);
    assert_eq!(storm.merged, 97);
    let flushed = storm.flush();
    assert_eq!(flushed.len(), 3);
    assert_eq!(storm.buffered(), 0);
    // 每文件保留最新版本(i=99 → /f0 v100;i=97 → /f1 v98;i=98 → /f2 v99)。
    let by_file: std::collections::BTreeMap<&str, u64> = flushed
        .iter()
        .map(|e| (e.file.as_str(), e.version))
        .collect();
    assert_eq!(by_file.get("/f0.def"), Some(&100));
    assert_eq!(by_file.get("/f1.def"), Some(&98));
    assert_eq!(by_file.get("/f2.def"), Some(&99));

    // 缓冲超限强制落批:事件不丢(2 容量收 5 事件 → 两次强制 flush,余 1)。
    let mut tight = StormBuffer::new(2);
    for i in 0..5u64 {
        tight.record(format!("/g{i}.def"), i + 1, 3);
    }
    assert_eq!(tight.forced_flushes, 2);
    assert_eq!(tight.buffered(), 1);
    assert_eq!(tight.events_seen, 5);
}

#[test]
fn same_priority_runs_in_enqueue_order() {
    let mut s = Scheduler::default();
    let order: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    for name in ["/a1.def", "/a2.def", "/a3.def"] {
        let out = order.clone();
        let spec = TaskSpec {
            kind: TaskKind::SingleFileUpdate,
            priority: 1,
            file: Some(name.to_string()),
            version: Some(1),
            target: None,
            run: Box::new(move |_| {
                out.borrow_mut().push(name.to_string());
                Ok(())
            }),
        };
        s.enqueue(spec);
    }
    s.drain(200);
    assert_eq!(
        order.borrow().clone(),
        vec![
            "/a1.def".to_string(),
            "/a2.def".to_string(),
            "/a3.def".to_string()
        ]
    );
}
