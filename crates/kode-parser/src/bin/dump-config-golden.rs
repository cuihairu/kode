//! Config-domain parity golden generator: walks the config fixture corpus and emits per-file parse tree JSON.
//!
//! Goldens are produced by Rust; the TS side re-computes them via the existing parseConfigXml
//! in tests/configParity.test.ts (bidirectional gate: Rust test regenerates and compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_parser::json::dump_config_corpus(std::path::Path::new(&repo_root))
    );
    println!();
}
