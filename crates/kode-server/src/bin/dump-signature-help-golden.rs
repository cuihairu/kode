//! SignatureHelp decision-core golden generator (RUST-140 batch 2): over the
//! batch 1 full set of lexical hits, each hit group annotated with the
//! signature four-piece (label/parameters/documentation/declaration landing
//! point) plus per-position activeArgument -> activeParameter highlighting.
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeSignatureHelpParity.test.ts independently recomputes with the
//! production lexical face + production annotation chain and compares
//! (two-way gate: the Rust test regenerates and compares + vitest
//! recomputes).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_signature_help_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
