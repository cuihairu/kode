// From repository root: rustc --edition=2021 -Awarnings docs/review/evidence/2026-11-19-responsiveness/single-core-probe.rs -o /tmp/kode-single-core-probe
// /tmp/kode-single-core-probe
#[path = "../../../../crates/kode-scheduler/src/pool.rs"]
mod pool;
fn main() {
    let budget = pool::PoolBudget::from_total(1);
    budget.validate().unwrap();
    let mut gate = pool::WorkerPoolGate::new(budget).unwrap();
    assert!(!gate.try_admit_background());
    assert!(gate.try_admit_interactive());
    assert!(gate.release_interactive());
    assert!(!gate.try_admit_background());
    println!("RESP-005: actual pool gate rejects background even when single worker is idle (background_max=0)");
}
