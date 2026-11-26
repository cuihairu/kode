//! WorkspaceSymbol quick-search golden generator (RUST-139 batch 2):
//! deterministic prefix probes derived from the full symbol-name set
//! (original form / lowercase two chars / original-form two chars) + negative
//! cases + empty prefix, recording the full hit set per probe (rootName/
//! symbolName/kind/section/declaration landing point/line).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeWorkspaceSymbolsParity.test.ts independently recomputes with
//! defParser primitives and compares (two-way gate: the Rust test regenerates
//! and compares + vitest recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_workspace_symbols_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
