//! Parity golden generator for the scheduling surface: replays the 10 scheduling scenarios and
//! emits the decision-surface JSON.
//!
//! The golden file is produced by the Rust side, and the TS side
//! tests/kodeSchedulerParity.test.ts recomputes the parity with a real IndexScheduler + fake
//! timers (a two-way gate: the Rust test regenerates and compares + the vitest recompute;
//! ARCH-012: only the decision surface, no performance comparison).

fn main() {
    print!("{}", kode_scheduler::golden::dump_golden());
}
