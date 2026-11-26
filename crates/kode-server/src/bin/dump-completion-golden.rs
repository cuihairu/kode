//! Completion parity golden generator: walks the fixture corpus and emits the
//! completion response JSON for every scenario point in every file (decision
//! surface + item set).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeCompletionParity.test.ts recomputes with the existing
//! defParser/defChain primitives and compares (two-way gate: the Rust test
//! regenerates and compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_completion_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
