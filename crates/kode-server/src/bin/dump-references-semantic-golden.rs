//! references semantic classification golden generator (RUST-138 batch 2):
//! same probe set as batch 1, each probe annotated with the per-site three-way
//! classification (semantic/shadow/dangling + evidence declaration path).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeReferencesSemanticParity.test.ts independently recomputes with
//! defParser primitives and compares (two-way gate: the Rust test regenerates
//! and compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_references_semantic_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
