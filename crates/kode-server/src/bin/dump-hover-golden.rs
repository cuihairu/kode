//! hover parity golden generator: walks the fixture corpus and emits the hover
//! response chain JSON for every declared symbol in every file.
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeHoverParity.test.ts recomputes with the existing
//! defParser/compositionRoots/buildDefChain and compares (two-way gate: the
//! Rust test regenerates and compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_hover_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
