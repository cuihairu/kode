//! def rename parity golden generator: walks the fixture .def corpus, probing
//! the symbol-resolution surface file by file and offset by offset (non-empty
//! hits enter the golden), and for each resolvable symbol runs same-file
//! conflict candidates, workspace-wide edit computation, and closure conflict
//! candidates (candidate-universe rules in the dump_def_rename_golden header).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodeDefRenameParity.test.ts imports the production defRenamer
//! function directly and recomputes for comparison (two-way gate).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_def_rename_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
