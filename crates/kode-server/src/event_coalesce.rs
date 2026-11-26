//! INDEX-DISCIPLINE-001 (1): index-rescan event coalescer -- pure decision core (the Rust main path;
//! the TS-side `src/backend/indexEventCoalescer.ts` is only a thin shell holding state + timer, a mirror fallback
//! with the same shape).
//!
//! user order (2026-11-18): "frequently modified files must be coalesced in the queue; coalesce the most recently modified at the queue tail;
//! re-indexing the same file over and over is wrong." Discipline:
//! - **300ms time window**: within the window, N changes to the same file keep only the last one (newest overwrites) --
//!   the caller (thin shell) carries latest-wins in a Map; this core only decides window expiry;
//! - **trailing deferral**: window expired but the file is still being edited (isDirty) -> defer to the next window
//!   (queue-tail coalescing semantics: deferred entries are queued by their last-push time, most recently modified exits last);
//! - **bounded deferral**: dirty deferral has a total cap (max_defer) -- when external disk writes collide with a long editing
//!   session, once the cap is reached flush according to the disk truth; never starve rescans indefinitely.
//!
//! Pure stateless functions: the pending list / clock are all fed in by the caller (single clock truth lives in the TS event
//! layer); this core holds zero internal state -- deterministically unit-testable, no hidden mutable state on the server side.

use crate::rpc::RpcRegistry;
use serde_json::{json, Value};

/// Coalescing window (ms). Multiple events for the same file within the window merge into one; only window expiry enters the rescan queue.
pub const DEFAULT_COALESCE_WINDOW_MS: u64 = 300;

/// Total cap on dirty deferral (ms). The window may defer repeatedly, but measured from the first push it must not exceed this bound
/// (with external disk writes + a long editing session, reaching the bound flushes per the disk truth rather than starving forever).
pub const DEFAULT_COALESCE_MAX_DEFER_MS: u64 = 5000;

/// Pending entries (fed by the caller; `first/lastPushedAtMs` use the TS-side monotonic clock).
#[derive(Debug, Clone)]
pub struct PendingEntry {
    pub file: String,
    pub first_pushed_at_ms: u64,
    pub last_pushed_at_ms: u64,
}

/// Decision result: `flush` in **ascending** last-push order (oldest dequeues first, most recently modified lands
/// at the queue tail); `defer` = window expired but dirty, deferred; `hold` = count of entries whose window has not expired.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoalesceDecision {
    pub flush: Vec<String>,
    pub defer: Vec<String>,
    pub hold: usize,
}

/// Pure decision core: given the pending list + current dirty set + clock, produce this round's decision.
/// Decision order (per file):
/// 1. `now - last < window` -> hold (still coalescing within the window);
/// 2. dirty and `now - first < max_defer` -> defer (trailing deferral, revisit next window);
/// 3. otherwise -> flush (ascending by last, most recently modified last = queue tail).
pub fn decide_coalesce(
    pending: &[PendingEntry],
    dirty: &[String],
    now_ms: u64,
    window_ms: u64,
    max_defer_ms: u64,
) -> CoalesceDecision {
    let mut decision = CoalesceDecision::default();
    let mut flush_with_time: Vec<(u64, String)> = Vec::new();
    for entry in pending {
        let age = now_ms.saturating_sub(entry.last_pushed_at_ms);
        if age < window_ms {
            decision.hold += 1;
        } else if dirty.iter().any(|f| f == &entry.file)
            && now_ms.saturating_sub(entry.first_pushed_at_ms) < max_defer_ms
        {
            decision.defer.push(entry.file.clone());
        } else {
            flush_with_time.push((entry.last_pushed_at_ms, entry.file.clone()));
        }
    }
    // Most recently modified coalesces at the queue tail: ascending by last -> the shell enqueues in order, the most recently touched lands at the tail.
    flush_with_time.sort_by_key(|(at, _)| *at);
    decision.flush = flush_with_time.into_iter().map(|(_, file)| file).collect();
    decision
}

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/events/coalesce", coalesce_handler);
}

/// `$/kode/events/coalesce` bridge: pending/dirty/clock are all fed in by the TS thin shell; this face
/// only returns the decision. Missing payload fields honestly Err (never silently swallowed into an empty decision -- an empty decision would make the shell believe
/// everything flushed, breaking the dirty-deferral discipline).
fn coalesce_handler(params: Value) -> Result<Value, String> {
    let now_ms = params
        .get("nowMs")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "coalesce: nowMs (u64) required".to_string())?;
    let window_ms = params
        .get("windowMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_COALESCE_WINDOW_MS);
    let max_defer_ms = params
        .get("maxDeferMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_COALESCE_MAX_DEFER_MS);
    let pending_json = params
        .get("pending")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "coalesce: pending array required".to_string())?;
    let mut pending: Vec<PendingEntry> = Vec::with_capacity(pending_json.len());
    for item in pending_json {
        let file = item
            .get("file")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "coalesce: pending[].file required".to_string())?
            .to_string();
        let first_pushed_at_ms = item
            .get("firstPushedAtMs")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "coalesce: pending[].firstPushedAtMs required".to_string())?;
        let last_pushed_at_ms = item
            .get("lastPushedAtMs")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "coalesce: pending[].lastPushedAtMs required".to_string())?;
        pending.push(PendingEntry {
            file,
            first_pushed_at_ms,
            last_pushed_at_ms,
        });
    }
    let dirty: Vec<String> = params
        .get("dirtyFiles")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let decision = decide_coalesce(&pending, &dirty, now_ms, window_ms, max_defer_ms);
    Ok(json!({
        "flush": decision.flush,
        "defer": decision.defer,
        "hold": decision.hold,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: u64 = 300;
    const MAX_DEFER: u64 = 5000;

    fn entry(file: &str, first: u64, last: u64) -> PendingEntry {
        PendingEntry {
            file: file.to_string(),
            first_pushed_at_ms: first,
            last_pushed_at_ms: last,
        }
    }

    #[test]
    fn window_hold_then_flush() {
        // Pin (1): hold inside the window, flush outside it (N pushes of the same file are merged by the shell's Map,
        // so this core always sees the single merged entry).
        let pending = [entry("a.py", 0, 1000)];
        let at_1100 = decide_coalesce(&pending, &[], 1100, WINDOW, MAX_DEFER);
        assert_eq!(at_1100.hold, 1);
        assert!(at_1100.flush.is_empty());
        let at_1301 = decide_coalesce(&pending, &[], 1301, WINDOW, MAX_DEFER);
        assert_eq!(at_1301.flush, vec!["a.py".to_string()]);
        assert_eq!(at_1301.hold, 0);
    }

    #[test]
    fn dirty_defers_within_max() {
        // Pin (2): window expired but dirty -> defer; beyond the max_defer bound, no more deferral.
        let pending = [entry("a.py", 0, 0)];
        let dirty = vec!["a.py".to_string()];
        let at_301 = decide_coalesce(&pending, &dirty, 301, WINDOW, MAX_DEFER);
        assert_eq!(at_301.defer, vec!["a.py".to_string()]);
        assert!(at_301.flush.is_empty());
        // first=0, now=5500 > max_defer=5000: flush per the disk truth.
        let at_5501 = decide_coalesce(&pending, &dirty, 5501, WINDOW, MAX_DEFER);
        assert_eq!(at_5501.flush, vec!["a.py".to_string()]);
        assert!(at_5501.defer.is_empty());
    }

    #[test]
    fn flush_order_most_recent_last() {
        // "Most recently modified coalesces at the queue tail": both files expired; the later-touched one is placed at the flush tail.
        let pending = [entry("older.py", 0, 100), entry("newer.py", 0, 900)];
        let decision = decide_coalesce(&pending, &[], 2000, WINDOW, MAX_DEFER);
        assert_eq!(
            decision.flush,
            vec!["older.py".to_string(), "newer.py".to_string()]
        );
    }

    #[test]
    fn clean_file_never_defers() {
        // A non-dirty file flushes as soon as its window expires, zero deferral.
        let pending = [entry("a.py", 0, 0)];
        let decision = decide_coalesce(&pending, &[], 301, WINDOW, MAX_DEFER);
        assert_eq!(decision.flush.len(), 1);
        assert!(decision.defer.is_empty());
    }

    #[test]
    fn handler_rejects_missing_now() {
        // Missing nowMs in the payload honestly Errs (not swallowed into a full flush).
        let err = coalesce_handler(serde_json::json!({ "pending": [] })).unwrap_err();
        assert!(err.contains("nowMs"));
    }

    #[test]
    fn handler_roundtrip() {
        let params = serde_json::json!({
            "nowMs": 10_000,
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [
                { "file": "a.py", "firstPushedAtMs": 6000, "lastPushedAtMs": 6000 },
                { "file": "b.py", "firstPushedAtMs": 8500, "lastPushedAtMs": 9000 }
            ],
            "dirtyFiles": ["a.py"]
        });
        let out = coalesce_handler(params).unwrap();
        assert_eq!(out["flush"][0], "b.py");
        assert_eq!(out["defer"][0], "a.py");
        assert_eq!(out["hold"], 0);
    }
}
