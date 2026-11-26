//! flag -> domain parity golden generator: emits the combined truth table JSON
//! for `normalize_flag_tokens` + `flag_domains` from kode-parser model.rs.
//!
//! The golden is produced by Rust; the TS side `src/generated/flagDomains.ts`
//! derives from it, and `tests/flagDomainsParity.test.ts` recomputes and
//! compares (two-way gate: the Rust test regenerates and compares + vitest
//! recomputes, same pattern as the hover/completion goldens).

fn main() {
    print!("{}", kode_server::dump_flag_domains_golden());
    println!();
}
