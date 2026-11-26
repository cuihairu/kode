//! Semantics fixture golden generator (RUST-116): whole-surface snapshot JSON
//! produced by the KSEM pure-library face over the demo-assets corpus
//! (doclass/nav/duplicate-three-faces/rename attribution); consumer replay is
//! in tests/semantic_golden.rs.

fn main() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| std::path::Path::new("."));
    print!(
        "{}",
        kode_server::semantics_golden::dump_semantics_golden(repo_root)
    );
}
