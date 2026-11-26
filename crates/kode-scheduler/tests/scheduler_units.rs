//! Scheduling-core unit gate (PR-009: the SCHED-004..015/019/020 surface; book §4 the
//! CORE-005/006/007/008/010 baseline).
//!
//! The parity-surface semantics match TS indexScheduler.ts; what is covered here are the Rust
//! extensions with no TS counterpart (bounded queue / anti-starvation / pause-and-resume / storm
//! merging) plus re-verification of the parity decisions (merge / staleness / cancellation /
//! cooldown).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use kode_scheduler::model::priority;
use kode_scheduler::{
    CancelToken, EnqueueDecision, EnsureDecision, Pump, Scheduler, SchedulerOptions, StormBuffer,
    TaskKind, TaskSpec, TaskState, WarmState, MAX_RETAINED_TERMINAL_TASKS,
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
    // After merging, the priority is the higher of the two: only one p0 task remains in the queue.
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
    // Only the new version actually runs (the cancelled old version never enters execution).
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
    // Background is blocked within the cooldown window (the interactive task finished at t=0, the
    // current time is t=10, 40ms remain).
    assert_eq!(s.pump_once(), Pump::Postponed { retry_in_ms: 40 });
    assert_eq!(s.status().metrics.postponed_background, 1);
    assert_eq!(s.status().metrics.background_delay_ms, 40);
    assert_eq!(s.status().queued, 1);
    // After the window elapses, progress resumes.
    s.advance_clock(60);
    assert_eq!(s.pump_once(), Pump::Ran);
    assert_eq!(s.status().completed, 2);
}

#[test]
fn starvation_promotion_bypasses_cooldown() {
    // The starvation limit (30ms) is shorter than the cooldown window (50ms): background is promoted
    // as soon as its in-window queueing exceeds the limit, proving that interactive pressure
    // cannot postpone background indexing forever (CORE-006).
    let mut s = Scheduler::new(SchedulerOptions {
        interactive_cooldown_ms: 50,
        starvation_limit_ms: 30,
        ..SchedulerOptions::default()
    });
    s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    s.enqueue(spec(TaskKind::SingleFileUpdate, 0, Some("/a.def"), Some(1)));
    // The interactive task runs first (the cooldown timer starts at its completion moment, 0);
    // background starts queueing at t=0.
    s.drain(0);
    assert_eq!(s.status().completed, 1);
    assert_eq!(s.status().queued, 1);
    // At the very moment the interactive task completes, background is blocked by the cooldown once
    // (matching TS pickNext behavior).
    assert_eq!(s.status().metrics.postponed_background, 1);
    // t=30: 30ms of queueing reaches the starvation limit while still inside the cooldown window →
    // promote by bypassing the cooldown.
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
    // Queue full: enqueueing the p1 → evicts the lowest-priority p3 (rather than rejecting the new
    // task).
    let p1 = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/b.def"), Some(1)));
    assert_eq!(p1.decision, EnqueueDecision::Queued);
    assert_eq!(
        s.task_state(bg1.id),
        Some(kode_scheduler::TaskState::Cancelled)
    );
    assert_eq!(s.status().metrics.evicted_queue_full, 1);
    assert_eq!(s.status().queued, 2);
    // Queue full and the incoming task is itself the lowest priority: rejected.
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
    // A task already in a terminal state cannot be cancelled again.
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

    // Failure → the keyed entry falls back to failed → a further ensure re-enqueues it (recovery
    // count +1).
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
fn keyed_ensure_rejected_queue_full_writes_no_fake_entry_and_retries() {
    // rust_ext bounded queue: with max_queued=1, first fill it with a p0 task, then ensure a
    // low-priority (p3) keyed task → RejectedQueueFull.
    let mut s = Scheduler::new(SchedulerOptions {
        max_queued: Some(1),
        ..SchedulerOptions::default()
    });
    s.enqueue(spec(TaskKind::FullReindex, 0, None, None));
    let (d1, id1) = s.ensure("initial-scan", spec(TaskKind::InitialScan, 3, None, None));
    // Rejected: returns Rejected + id=0, and leaves no fake keyed entry at id=0.
    assert_eq!(d1, EnsureDecision::Rejected);
    assert_eq!(id1, 0);
    assert!(!s.is_keyed_complete("initial-scan"));
    assert_eq!(s.status().queued, 1);
    assert_eq!(s.status().metrics.queue_full_rejected, 1);
    // No fake entry → a later ensure is not short-circuited by Reused, it goes back through
    // enqueueing.
    let (d_dup, id_dup) = s.ensure("initial-scan", spec(TaskKind::InitialScan, 3, None, None));
    assert_eq!(d_dup, EnsureDecision::Rejected);
    assert_eq!(id_dup, 0);
    assert_eq!(s.status().metrics.queue_full_rejected, 2);
    // Once the queue frees up a slot: the task really enqueues and executes, no longer stuck as a
    // false pending.
    s.drain(200);
    let ran = Rc::new(Cell::new(0));
    let (d2, id2) = s.ensure(
        "initial-scan",
        counting_spec(TaskKind::InitialScan, 3, None, None, &ran),
    );
    assert_eq!(d2, EnsureDecision::Queued);
    assert_ne!(id2, 0);
    s.drain(200);
    assert_eq!(ran.get(), 1);
    assert!(s.is_keyed_complete("initial-scan"));
    assert_eq!(s.status().metrics.recoveries, 0);
}

#[test]
fn keyed_ensure_stale_dropped_writes_no_fake_entry_and_retries() {
    // The queue already holds /a.def v2; ensuring the same file's older v1 keyed task → StaleDropped.
    let mut s = Scheduler::default();
    let cur = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(2)));
    let (d1, id1) = s.ensure(
        "scan-a",
        spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(1)),
    );
    // Dropped: returns Rejected + id=0, and leaves no fake keyed entry.
    assert_eq!(d1, EnsureDecision::Rejected);
    assert_eq!(id1, 0);
    assert!(!s.is_keyed_complete("scan-a"));
    assert_eq!(s.status().metrics.stale_dropped, 1);
    // No fake entry → a later ensure is not short-circuited by Reused.
    let (d_dup, id_dup) = s.ensure(
        "scan-a",
        spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(1)),
    );
    assert_eq!(d_dup, EnsureDecision::Rejected);
    assert_eq!(id_dup, 0);
    assert_eq!(s.status().metrics.stale_dropped, 2);
    // After a newer version arrives, the same key can really enqueue and execute (the execute write-back
    // hits entry.id).
    s.drain(200);
    assert_eq!(
        s.task_state(cur.id),
        Some(kode_scheduler::TaskState::Completed)
    );
    let (d2, id2) = s.ensure(
        "scan-a",
        spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(3)),
    );
    assert_eq!(d2, EnsureDecision::Queued);
    assert_ne!(id2, 0);
    s.drain(200);
    assert!(s.is_keyed_complete("scan-a"));
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
            // Simulated cooperation point: yield if it has already been flagged externally.
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
    // Storm: 100 events concentrated on 3 files; multiple events for the same file collapse into one,
    // with the newest version / higher priority winning.
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
    // Each file keeps its newest version (i=99 → /f0 v100; i=97 → /f1 v98; i=98 → /f2 v99).
    let by_file: std::collections::BTreeMap<&str, u64> = flushed
        .iter()
        .map(|e| (e.file.as_str(), e.version))
        .collect();
    assert_eq!(by_file.get("/f0.def"), Some(&100));
    assert_eq!(by_file.get("/f1.def"), Some(&98));
    assert_eq!(by_file.get("/f2.def"), Some(&99));

    // Buffer overflow forces a flush: no events are lost (a capacity-2 buffer receiving 5 events →
    // two forced flushes, 1 left over).
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

// RUST-5: terminal-state tasks (Completed/Failed/Cancelled) in the tasks HashMap were never
// removed — unbounded memory growth under long sessions with high-frequency didChange.
// Terminal entries are kept in a ring window of the most recent N; older terminal entries are
// evicted; see MAX_RETAINED_TERMINAL_TASKS for the window ceiling.

#[test]
fn terminal_tasks_stay_bounded_under_did_change_churn() {
    let mut s = Scheduler::default();
    let mut peak = 0usize;
    for v in 1..=3000u64 {
        let file = format!("/f{v}.def");
        let out = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some(&file), Some(v)));
        assert_eq!(out.decision, EnqueueDecision::Queued);
        s.drain(200);
        peak = peak.max(s.retained_task_count());
    }
    assert_eq!(s.status().completed, 3000);
    assert_eq!(s.status().queued, 0);
    assert!(
        peak <= MAX_RETAINED_TERMINAL_TASKS,
        "retained tasks unbounded: {peak}"
    );
}

#[test]
fn cancelled_tasks_stay_bounded_under_version_churn() {
    let mut s = Scheduler::default();
    s.enqueue(spec(
        TaskKind::SingleFileUpdate,
        1,
        Some("/hot.def"),
        Some(0),
    ));
    // Every newer version cancels the older one in its place (stale-version terminal state); the queue
    // length stays 1.
    for v in 1..=3000u64 {
        let out = s.enqueue(spec(
            TaskKind::SingleFileUpdate,
            1,
            Some("/hot.def"),
            Some(v),
        ));
        assert_eq!(out.decision, EnqueueDecision::Queued);
    }
    s.drain(200);
    assert_eq!(s.status().cancelled, 3000);
    assert_eq!(s.status().completed, 1);
    assert!(
        s.retained_task_count() <= MAX_RETAINED_TERMINAL_TASKS,
        "retained tasks unbounded: {}",
        s.retained_task_count()
    );
}

#[test]
fn ensure_reentry_correct_after_terminal_eviction() {
    let mut s = Scheduler::default();
    // The initial scan completes; its terminal entry is subsequently evicted by the window.
    let (d0, id0) = s.ensure("scan", spec(TaskKind::FullReindex, 3, None, None));
    assert_eq!(d0, EnsureDecision::Queued);
    s.drain(200);
    assert_eq!(
        s.task_state(id0),
        Some(kode_scheduler::TaskState::Completed)
    );
    // High-frequency reentry: repeatedly ensure→execute the same key, crossing the retention window
    // (the id0 entry is evicted).
    let mut last_id = 0u64;
    for v in 1..=1100u64 {
        let (d, id) = s.ensure("scan", spec(TaskKind::FullReindex, 3, None, None));
        // The previous round already completed → each round is a brand-new enqueue and must not be
        // short-circuited by Reused (the false-pending lesson, RUST-4).
        assert_eq!(d, EnsureDecision::Queued, "v={v}");
        last_id = id;
        s.drain(200);
    }
    assert!(s.retained_task_count() <= MAX_RETAINED_TERMINAL_TASKS);
    // The old entry is evicted, and the new entry is still queryable.
    assert_eq!(s.task_state(id0), None);
    assert_eq!(
        s.task_state(last_id),
        Some(kode_scheduler::TaskState::Completed)
    );
    // In-flight reuse semantics are unaffected by eviction: ensure enqueues and has not run → a further
    // ensure returns Reused pointing at the real in-flight task.
    let (d_inflight, id_inflight) = s.ensure("scan", spec(TaskKind::FullReindex, 3, None, None));
    assert_eq!(d_inflight, EnsureDecision::Queued);
    let (d_reuse, id_reuse) = s.ensure("scan", spec(TaskKind::FullReindex, 3, None, None));
    assert_eq!(d_reuse, EnsureDecision::Reused);
    assert_eq!(id_reuse, id_inflight);
    s.drain(200);
    assert!(s.is_keyed_complete("scan"));
    assert_eq!(
        s.task_state(id_inflight),
        Some(kode_scheduler::TaskState::Completed)
    );
    assert_eq!(s.status().queued, 0);
    assert_eq!(s.status().completed, 1102);
}

/// KR-AUD-22: a panic in the run closure had no catch_unwind before — the panic knocked the pump
/// over, the task got stuck in Running, and the scheduler deadlocked. Fix: a panic is booked as the
/// Failed terminal state, and later tasks execute as usual.
#[test]
fn run_body_panic_lands_failed_and_scheduler_stays_live_kraud22() {
    let mut s = Scheduler::default();
    let boom = s.enqueue(TaskSpec {
        kind: TaskKind::SingleFileUpdate,
        priority: 0,
        file: Some("/a.def".to_string()),
        version: Some(1),
        target: None,
        run: Box::new(|_| panic!("boom")),
    });
    let after = s.enqueue(spec(TaskKind::SingleFileUpdate, 0, Some("/b.def"), Some(1)));
    s.drain(200);
    assert_eq!(
        s.task_state(boom.id),
        Some(kode_scheduler::TaskState::Failed),
        "panic 应按 Failed 终态落账"
    );
    assert_eq!(
        s.task_state(after.id),
        Some(kode_scheduler::TaskState::Completed),
        "panic 后调度器不应卡死"
    );
    assert_eq!(s.status().failed, 1);
    assert_eq!(s.status().completed, 1);
}
/// KR-AUD-90 (RUST-5): after a keyed task is cancelled by stale-version/queue-full eviction,
/// `cancel_queued` must write back to the keyed ledger — execute will never run, and an entry stuck
/// in Queued would make every later ensure return Reused (a dead id; the task never re-runs).
#[test]
fn keyed_cancelled_by_newer_version_writes_back_ledger() {
    let mut s = Scheduler::new(SchedulerOptions::default());
    let (d1, id1) = s.ensure(
        "initial-scan",
        spec(TaskKind::InitialScan, 3, Some("/a.def"), Some(1)),
    );
    assert_eq!(d1, EnsureDecision::Queued);

    // A newer version enqueues → the same file's older keyed task (just enqueued via ensure) is
    // cancelled as stale-version.
    let _ = s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(2)));

    assert_eq!(
        s.status()
            .keyed_tasks
            .get("initial-scan")
            .map(String::as_str),
        Some("cancelled"),
        "cancel 路径必须回写 keyed 台账(KR-AUD-90)"
    );

    let (d2, id2) = s.ensure(
        "initial-scan",
        spec(TaskKind::InitialScan, 3, Some("/a.def"), Some(3)),
    );
    assert_eq!(d2, EnsureDecision::Recovered, "后续 ensure 走恢复路径");
    assert_ne!(id2, id1, "必须是新任务,而不是死 id 复用");
}

#[test]
fn cancel_token_default_matches_new() {
    // `CancelToken::default()` takes the new branch: initially uncancelled, readable once cancelled.
    let token = CancelToken::default();
    assert!(!token.is_cancelled());
    token.cancel();
    assert!(token.is_cancelled());
}

#[test]
fn scheduler_debug_format_is_human_readable() {
    let mut s = Scheduler::default();
    let dbg = format!("{s:?}");
    assert!(dbg.contains("Scheduler"), "{dbg}");
    assert!(dbg.contains("clock_ms"), "{dbg}");
    assert!(dbg.contains("queued"), "{dbg}");
    // With content present, the debug format reflects it faithfully: queued=1 after enqueueing.
    s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(1)));
    let dbg2 = format!("{s:?}");
    assert!(dbg2.contains("queued: 1"), "{dbg2}");
}

#[test]
fn task_spec_debug_format_is_human_readable() {
    let spec = spec(TaskKind::SingleFileUpdate, 2, Some("/a.def"), Some(7));
    let dbg = format!("{spec:?}");
    assert!(dbg.contains("TaskSpec"), "{dbg}");
    assert!(dbg.contains("SingleFileUpdate"), "{dbg}");
    assert!(dbg.contains("priority: 2"), "{dbg}");
    assert!(dbg.contains("\"/a.def\""), "{dbg}");
    assert!(dbg.contains("version: Some(7)"), "{dbg}");
}

#[test]
fn storm_buffer_merge_upgrades_priority_and_preserves_newer_version() {
    let mut b = StormBuffer::new(2);
    assert!(!b.record("/a.def", 1, 3), "首条入缓冲不合并");
    assert!(b.record("/a.def", 2, 1), "同文件第二条合并");
    let ev = b.flush();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].file, "/a.def");
    assert_eq!(ev[0].version, 2, "合并取更高版本");
    assert_eq!(ev[0].priority, 1, "合并取更低优先级(更紧急)");
}

#[test]
fn storm_buffer_merge_never_downgrades_version() {
    let mut b = StormBuffer::new(2);
    assert!(!b.record("/a.def", 5, 3));
    assert!(b.record("/a.def", 4, 1), "旧版本事件仍合并(缓冲只留最新)");
    let ev = b.flush();
    assert_eq!(ev[0].version, 5, "版本只升不降");
    assert_eq!(ev[0].priority, 1);
}

#[test]
fn storm_buffer_take_file_moves_exactly_the_named_event() {
    let mut b = StormBuffer::new(4);
    b.record("/a.def", 1, 3);
    b.record("/b.def", 2, 3);
    assert!(b.record("/a.def", 3, 3), "同文件合并");
    // Named fetch: take the newest-version event for a; b is unaffected.
    let ev = b.take_file("/a.def").expect("named event");
    assert_eq!((ev.file.as_str(), ev.version), ("/a.def", 3));
    assert_eq!(b.buffered(), 1, "其余文件不受影响");
    assert_eq!(b.flush()[0].file, "/b.def");
    // No buffered events → None; fetching again after a fetch is None.
    assert!(b.take_file("/a.def").is_none());
    assert!(b.take_file("/none.def").is_none());
}

#[test]
fn clock_ms_getter_reflects_advance() {
    let mut s = Scheduler::default();
    assert_eq!(s.clock_ms(), 0);
    s.advance_clock(15);
    assert_eq!(s.clock_ms(), 15);
    s.advance_clock(5);
    assert_eq!(s.clock_ms(), 20);
}

#[test]
fn run_panic_string_payload_becomes_failed() {
    let mut s = Scheduler::default();
    let out = s.enqueue(TaskSpec {
        kind: TaskKind::SingleFileUpdate,
        priority: 3,
        file: None,
        version: None,
        target: None,
        run: Box::new(|_| std::panic::panic_any(String::from("boom-string"))),
    });
    assert_eq!(s.pump_once(), Pump::Ran);
    assert_eq!(
        s.task_state(out.id),
        Some(kode_scheduler::TaskState::Failed)
    );
    assert_eq!(s.status().failed, 1);
    assert_eq!(s.status().completed, 0);
}

#[test]
fn run_panic_non_string_payload_becomes_failed() {
    let mut s = Scheduler::default();
    let out = s.enqueue(TaskSpec {
        kind: TaskKind::FullReindex,
        priority: 3,
        file: None,
        version: None,
        target: None,
        run: Box::new(|_| std::panic::panic_any(42u32)),
    });
    assert_eq!(s.pump_once(), Pump::Ran);
    assert_eq!(
        s.task_state(out.id),
        Some(kode_scheduler::TaskState::Failed)
    );
    assert_eq!(s.status().failed, 1);
}

#[test]
fn drain_budget_exhausted_breaks_after_cooldown_postpone() {
    let mut s = Scheduler::new(SchedulerOptions {
        interactive_cooldown_ms: 1000,
        ..SchedulerOptions::default()
    });
    // The interactive task runs to completion first (the cooldown timer starts at its completion
    // moment, 0).
    s.enqueue(spec(TaskKind::SingleFileUpdate, 0, None, None));
    s.drain(0);
    assert_eq!(s.status().completed, 1);
    // The background task is Postponed inside the cooldown window (retry window = 1000ms left).
    s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    assert_eq!(s.pump_once(), Pump::Postponed { retry_in_ms: 1000 });
    // The drain budget exactly equals the retry window: advance to the deadline then break, with no
    // idle spinning.
    s.drain(1000);
    assert_eq!(s.clock_ms(), 1000);
    assert_eq!(s.status().queued, 1, "预算耗尽时后台仍未执行");
    // The window has elapsed; a later drain actually executes the background task.
    s.drain(200);
    assert_eq!(s.status().completed, 2);
    assert_eq!(s.status().queued, 0);
}

#[test]
fn task_kind_and_state_as_str_cover_all_variants() {
    // as_str is the stable protocol surface for the ledger/golden: every variant is checked one by one
    // (including those not exercised by existing tests).
    assert_eq!(
        kode_scheduler::TaskKind::DependencyUpdate.as_str(),
        "dependency-update"
    );
    assert_eq!(
        kode_scheduler::TaskKind::NonInteractive.as_str(),
        "non-interactive"
    );
    assert_eq!(kode_scheduler::TaskState::Running.as_str(), "running");
}

#[test]
fn pending_records_sort_by_priority_then_file() {
    let mut s = Scheduler::default();
    s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/b.def"), Some(1)));
    s.enqueue(spec(TaskKind::SingleFileUpdate, 1, Some("/a.def"), Some(2)));
    s.enqueue(spec(TaskKind::FullReindex, 3, None, None));
    let recs = s.pending_records();
    assert_eq!(recs.len(), 3);
    // Priority ascending; within the same priority, files in lexicographic order (/a before /b).
    assert_eq!(recs[0].file.as_deref(), Some("/a.def"));
    assert_eq!(recs[1].file.as_deref(), Some("/b.def"));
    assert_eq!(recs[2].priority, 3);
    assert!(recs[2].file.is_none());
}

// ---- CORE-009 cold-request warm gate ----

#[test]
fn cold_request_never_waits_for_pending_background_scan() {
    let mut sched = Scheduler::new(SchedulerOptions::default());
    // The initial scan is backgrounded: enqueued at background priority (not yet executed).
    let (d, scan_id) = sched.begin_background_scan(spec(
        TaskKind::InitialScan,
        priority::BACKGROUND_FULL,
        None,
        None,
    ));
    assert_eq!(d, EnsureDecision::Queued);
    assert_eq!(sched.warm_state(), WarmState::Warming);
    // A cold request arrives: it enters the interactive queue immediately and never queues behind the
    // initial scan waiting for the whole workspace.
    let cold_ran = Rc::new(Cell::new(0));
    let outcome = sched.cold_request(
        "/w/alpha/Hot.def",
        1,
        Box::new({
            let ran = cold_ran.clone();
            move |_| {
                ran.set(ran.get() + 1);
                Ok(())
            }
        }),
    );
    assert_eq!(outcome.decision, EnqueueDecision::Queued);
    assert!(outcome.while_warming, "首扫在途 → while_warming 位必须亮");
    // The first pump must run the cold request; the initial scan stays in the queue.
    assert!(matches!(sched.pump_once(), Pump::Ran));
    assert_eq!(cold_ran.get(), 1, "冷请求先于首扫执行");
    assert_eq!(sched.task_state(scan_id), Some(TaskState::Queued));
    assert_eq!(sched.cold_while_warming_count(), 1);
    assert_eq!(sched.warm_state(), WarmState::Warming);
    // Get past the interactive cooldown window (the cold request just ran, so the background initial
    // scan must wait out the cooldown) and pump again: the initial scan completes → Warm.
    sched.advance_clock(50);
    assert!(matches!(sched.pump_once(), Pump::Ran));
    assert_eq!(sched.warm_state(), WarmState::Warm);
}

#[test]
fn cold_request_merges_same_file_same_version_while_warming() {
    let mut sched = Scheduler::new(SchedulerOptions::default());
    sched.begin_background_scan(spec(
        TaskKind::InitialScan,
        priority::BACKGROUND_FULL,
        None,
        None,
    ));
    let parsed = Rc::new(Cell::new(0));
    let first = sched.cold_request(
        "/w/alpha/A.def",
        7,
        Box::new({
            let parsed = parsed.clone();
            move |_| {
                parsed.set(parsed.get() + 1);
                Ok(())
            }
        }),
    );
    assert_eq!(first.decision, EnqueueDecision::Queued);
    // Same file, same version: the second request merges into the already-queued task (no duplicate
    // parsing).
    let second = sched.cold_request("/w/alpha/A.def", 7, Box::new(|_| Ok(())));
    assert_eq!(second.decision, EnqueueDecision::Merged);
    assert_eq!(second.id, first.id, "合并必须指回同一条在队任务");
    assert!(matches!(sched.pump_once(), Pump::Ran));
    assert_eq!(parsed.get(), 1, "同文件同版本只解析一次");
}

#[test]
fn failed_background_scan_does_not_cache_warm_state() {
    let mut sched = Scheduler::new(SchedulerOptions::default());
    let mut scan = spec(TaskKind::InitialScan, priority::BACKGROUND_FULL, None, None);
    scan.run = Box::new(|_| Err("boom".into()));
    sched.begin_background_scan(scan);
    assert_eq!(sched.warm_state(), WarmState::Warming);
    assert!(matches!(sched.pump_once(), Pump::Ran));
    // A failure is not cached as a fake warm state: the keyed entry falls back and the initial scan can
    // be reopened.
    assert_eq!(sched.warm_state(), WarmState::Idle);
    let (d, _) = sched.begin_background_scan(spec(
        TaskKind::InitialScan,
        priority::BACKGROUND_FULL,
        None,
        None,
    ));
    assert_eq!(d, EnsureDecision::Recovered);
    assert!(matches!(sched.pump_once(), Pump::Ran));
    assert_eq!(sched.warm_state(), WarmState::Warm);
}

#[test]
fn cold_request_after_warm_is_immediate_and_unmarked() {
    let mut sched = Scheduler::new(SchedulerOptions::default());
    sched.begin_background_scan(spec(
        TaskKind::InitialScan,
        priority::BACKGROUND_FULL,
        None,
        None,
    ));
    assert!(matches!(sched.pump_once(), Pump::Ran));
    assert_eq!(sched.warm_state(), WarmState::Warm);
    let outcome = sched.cold_request("/w/beta/B.def", 2, Box::new(|_| Ok(())));
    assert_eq!(outcome.decision, EnqueueDecision::Queued);
    assert!(!outcome.while_warming, "暖态冷请求不得亮 warming 位");
    assert_eq!(sched.cold_while_warming_count(), 0);
}

#[test]
fn terminal_retention_window_evicts_oldest_beyond_cap() {
    // Terminal-state ring window: once MAX_RETAINED_TERMINAL_TASKS is exceeded, the oldest terminal
    // entries must be evicted (the execution face of the bounded-memory promise, not just the
    // assertion face).
    let mut s = Scheduler::default();
    for i in 0..(MAX_RETAINED_TERMINAL_TASKS + 2) {
        s.enqueue(spec(
            TaskKind::DependencyUpdate,
            2,
            Some(&format!("/f{i}.def")),
            Some(1),
        ));
        s.drain(0);
    }
    let retained = s.retained_task_count();
    assert!(
        retained <= MAX_RETAINED_TERMINAL_TASKS,
        "终态窗口有界: {retained}"
    );
    assert!(
        retained >= MAX_RETAINED_TERMINAL_TASKS,
        "满窗才触发摘除: {retained}"
    );
}
