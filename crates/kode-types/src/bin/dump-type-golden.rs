//! Parity golden generator: walks the fixture corpus and emits per-file type
//! face + graph-level chain/cycle JSON.
//!
//! The golden file is produced by Rust; the TS side tests/kodeTypesParity.test.ts
//! recomputes it with the existing defParser/compositionRoots primitives for
//! the parity comparison (bidirectional gate: the Rust test regenerates and
//! compares + the vitest recomputation).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_types::golden::dump_type_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
