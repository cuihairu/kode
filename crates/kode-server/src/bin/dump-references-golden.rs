//! references parity golden generator: walks the fixture corpus and emits the
//! reference positions JSON for every symbol probe in every file (Parent/Type/
//! Arg/of value words, types.xml top-level declaration names).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeReferencesParity.test.ts recomputes with the existing defParser
//! primitives and compares (two-way gate: the Rust test regenerates and
//! compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_references_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
