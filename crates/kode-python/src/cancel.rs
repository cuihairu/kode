//! Cooperative cancellation probe (RUST-072): a cancellation-aware channel for the long
//! loops of the parse / flow engines.
//!
//! Semantics: before a worker thread runs a job it installs that request's cancellation token
//! into this thread's probe; the engine queries it at cooperation points (between parse phases /
//! the class-table build loop / the convergence iteration head). Once cancelled it propagates
//! `Err("cancelled by request")` upward -- it never returns a partial result masquerading as
//! complete (ARCH-004 semantics); the cache path skips writing on cancellation (a partial
//! parse is never cached). With no probe (standalone calls / tests / direct TS fallback calls)
//! the state is never cancelled, so behaviour is exactly as in the older version.
//!
//! Cross-thread: the token is an `Arc<AtomicBool>`; the canceller (main-thread
//! executor.cancel) and the querier (worker-thread engine loop) share the same heap object, so
//! no lock is needed.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

thread_local! {
    static PROBE: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}

/// Stable wording of the handler cancellation error (the worker's settlement decides the
/// terminal state from the cancellation table; the wording is only used for log
/// reconciliation -- changing it requires syncing the executor unit-test assertions).
pub const CANCELLED_MSG: &str = "cancelled by request";

/// Set / clear this thread's cancellation token (worker sets `Some` before each job starts and
/// `None` after it reaches a terminal state, so reused threads do not leak jobs across runs).
/// Non-worker threads never set it.
pub fn set_probe(token: Option<Arc<AtomicBool>>) {
    PROBE.with(|probe| *probe.borrow_mut() = token);
}

/// This thread's cancellation state; no probe = false.
pub fn is_cancelled() -> bool {
    PROBE.with(|probe| {
        probe
            .borrow()
            .as_ref()
            .map(|token| token.load(Ordering::SeqCst))
            .unwrap_or(false)
    })
}

/// Cooperation point: cancelled -> Err (propagates up the call chain; the engine yields no result).
pub fn check_point() -> Result<(), &'static str> {
    if is_cancelled() {
        Err(CANCELLED_MSG)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_probe_is_never_cancelled() {
        set_probe(None);
        assert!(!is_cancelled());
        assert_eq!(check_point(), Ok(()));
    }

    #[test]
    fn probe_flag_flips_cancel_state() {
        let token = Arc::new(AtomicBool::new(false));
        set_probe(Some(Arc::clone(&token)));
        assert!(!is_cancelled());
        token.store(true, Ordering::SeqCst);
        assert!(is_cancelled());
        assert_eq!(check_point(), Err(CANCELLED_MSG));
        set_probe(None);
        assert!(!is_cancelled());
    }

    #[test]
    fn cancellation_is_visible_across_threads() {
        let token = Arc::new(AtomicBool::new(false));
        set_probe(Some(Arc::clone(&token)));
        // The main thread sets the flag; this thread's (= simulated worker) probe can see it.
        let writer = Arc::clone(&token);
        std::thread::spawn(move || writer.store(true, Ordering::SeqCst))
            .join()
            .expect("writer thread");
        assert!(is_cancelled());
        set_probe(None);
    }
}
