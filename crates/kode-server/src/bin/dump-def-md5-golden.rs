//! def MD5 parity golden generator: emits the engine `EntityDef::md5()`
//! replay sample (demo-assets/parity-project/ minimal anchor) as JSON; the
//! built-in normative derivation (provenance citing kbengine source file:line)
//! is authoritative; cross-validation against the engine is best effort
//! (skipped when the linking dependency is heavy, normative derivation stays
//! authoritative, same precedent as wire-probe).

fn main() {
    // repo_root = two levels above the crate (workspace root); cargo runs with the package dir as cwd.
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| std::path::Path::new("."));
    print!("{}", kode_server::def_md5::dump_def_md5_golden(repo_root));
    println!();
}
