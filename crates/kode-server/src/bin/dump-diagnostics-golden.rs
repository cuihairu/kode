//! diagnostics parity golden generator: walks the fixture corpus and emits the
//! diagnostic surface JSON for each .def (the validateDocument corpus subset,
//! with messages / ranges / severity / order matching TS).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeDiagnosticsParity.test.ts recomputes with the parseDefDocument +
//! kbengineMetadata vocabulary and compares (two-way gate).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_diagnostics_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
