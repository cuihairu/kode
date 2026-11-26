//! Symbol parity golden generator: walks the fixture corpus and emits per-file
//! symbol record JSON.
//!
//! The golden file is produced by Rust, and the TS side tests/kodeIndexParity.test.ts
//! recomputes it with the existing defParser primitives for the parity comparison
//! (bidirectional gate: Rust test regeneration comparison + vitest recomputation).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_index::golden::dump_symbols(std::path::Path::new(&repo_root))
    );
    println!();
}
