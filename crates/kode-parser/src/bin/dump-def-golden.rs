//! Parity golden generator: walks the fixture corpus and emits per-file semantic record JSON.
//!
//! Goldens are produced by Rust; the TS side re-computes them via the existing
//! defParser implementation in tests/kodeParserParity.test.ts (bidirectional gate:
//! Rust test regenerates and compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_parser::json::dump_corpus(std::path::Path::new(&repo_root))
    );
    println!();
}
