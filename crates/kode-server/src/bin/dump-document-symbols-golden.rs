//! document symbols parity golden generator: walks the fixture corpus def
//! files and emits the Outline symbol tree (four-section containers + in-section
//! declarations, full-span range/selectionRange) JSON.
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeDocumentSymbolsParity.test.ts recomputes with the existing
//! defParser primitives and compares (two-way gate, isomorphic with
//! definition/references).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_document_symbols_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
