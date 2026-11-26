//! Parity golden generator (ROOT-010): scans the fixture trees and emits the anchor
//! set JSON.
//!
//! Usage (from the repo root):
//!   cargo run -p kode-root --bin dump-golden -- . \
//!     > crates/kode-root/tests/golden/root-parity.json

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    let fixtures = std::path::Path::new(&repo_root).join("crates/kode-root/tests/fixtures");
    print!("{}", kode_root::golden::dump_golden(&fixtures));
}
