//! Diagnostic layering assembly golden generator (RUST-142 batch 2): full
//! lint over the corpus per def file (production-shape knownTypes) -> decision
//! table routing -> per-layer independent scheduler-core replay.
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeDiagnosticLayeringParity.test.ts recomputes the decision table /
//! merge ordering / production seam and compares (two-way gate).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_diagnostic_layering_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
