//! SemanticTokens decision-core golden generator: synthetic corpus +
//! authoritative probe surface + production output in one file (the TS side
//! tests/kodeSemanticTokensParity.test.ts reads corpus+probes and drives the
//! production function to recompute and compare outcomes).

fn main() {
    print!("{}", kode_server::dump_semantic_tokens_golden());
    println!();
}
