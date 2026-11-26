//! python call-at parity golden generator: walks the fixture .py corpus and
//! probes the receiver-call resolution surface line by line and position by
//! position (non-empty hits enter the golden, with probeCount reconciled over
//! the full set).
//!
//! The golden file is produced by Rust; the TS side
//! tests/kodePythonCallAtParity.test.ts imports the production
//! getPythonCallAtPosition directly and recomputes position by position
//! (two-way gate).

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_python_call_at_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
