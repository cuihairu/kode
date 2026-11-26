//! CodeAction assembly golden generator (RUST-143 batch 2): assembly
//! snapshots for the four synthetic case families (gate / intersection /
//! dedup / ordering); the TS side tests/kodeCodeActionAssemblyParity
//! .test.ts drives the production provider for parity comparison (two-way gate).

fn main() {
    print!("{}", kode_server::dump_code_action_assembly_golden());
    println!();
}
