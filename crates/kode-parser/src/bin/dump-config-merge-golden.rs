//! Config-merge parity golden generator: walks CONFIG_MERGE_PAIRS and emits the
//! merge(base, override) tree JSON for each pair.
//!
//! Goldens are produced by Rust; the TS side re-computes them via the existing
//! parseConfigXml+mergeConfigXml in tests/configMergeParity.test.ts (bidirectional gate:
//! Rust test regenerates and compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_parser::json::dump_config_merge_corpus(std::path::Path::new(&repo_root))
    );
    println!();
}
