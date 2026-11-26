//! def wire-format parity golden generator: emits the full-sample JSON for the
//! wire_codec.rs codecs (scalars/containers/property streams/method frames/
//! message frames), with built-in round-trip self-check.
//!
//! The golden is produced by Rust as the normative derivation (provenance
//! citing kbengine source file:line); tests/wire_codec_units.rs regenerates
//! and compares + malformed streams must not panic (same pattern as
//! flag-domains).

fn main() {
    print!("{}", kode_server::wire_codec::dump_wire_golden());
    println!();
}
