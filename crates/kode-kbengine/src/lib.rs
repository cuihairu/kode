//! kode2 KBEngine CLI (todo PA-004 Phase 3; bin `kode-kbengine`).
//!
//! Acceptance text: `schema validate/build/diff/inspect, decode --hex, capture analyze (with
//! streaming pcap input on stdin); the PCAP input layer first reuses TShark's mature capabilities`.
//!
//! Module boundaries:
//! - [`cli`]: hand-written argument parsing (zero clap, so the repository adds no third-party
//!   dependency);
//! - [`records`]: decoded records + anomaly records (the single data shape from the decode face to
//!   the analysis face; the PA-005 analysis engine consumes JSON of the same shape);
//! - [`tshark`]: PCAP input layer (reuses TShark; streams pcap bytes on stdin);
//! - `commands`: subcommand implementations.
//!
//! Parsing engine = kode-kbengine-protocol (PA-003 session, per-Flow standalone message table +
//! handshake/dynamic-import side effects); schema face = kode-kbengine-schema (PA-002 IR).

pub mod cli;
pub mod commands;
pub mod records;
pub mod tshark;

pub use cli::{parse_args, Args, Command, Parsed, USAGE};
pub use records::{Anomaly, Record};
