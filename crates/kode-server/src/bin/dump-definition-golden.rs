//! definition parity golden generator: walks the fixture corpus and emits the
//! definition landing-point JSON for every declared symbol in every file
//! (including Parent/Type value probes).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeDefinitionParity.test.ts recomputes with the existing defParser
//! primitives and compares (two-way gate: the Rust test regenerates and
//! compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_definition_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
