//! kode2 KBEngine protocol engine (todo PA-003 Phase 2).
//!
//! KBEngine protocol parsing library fully independent of Wireshark; MVP = Client↔Server.
//! Module boundaries (from the acceptance text):
//! - `cursor`: zero-copy bounds-checked reads (engine string semantics aligned item by item, PA-001 §3.1);
//! - `framing`: three length shapes + TCP sticky-packet/split-packet handling (packet_reader.cpp:31-250 state machine);
//! - `messages`: static message ID segment + dynamically imported segment (onImportClientMessages, §5.2);
//! - `codec`: basic types + ARRAY/FIXED_DICT containers;
//! - `entity`: entity method payload decoding (property sync stream TODO-3 not yet evidenced → kept as Raw, not fabricated);
//! - `session`: per-Flow (loginapp/baseapp) independent tables + handshake phase observation;
//! - `cache`: schema hash → compiled artifact cache.
//!
//! Red lines (from the acceptance text, all covered by tests): no panic on failure /
//! no out-of-bounds access / memory bounded ([`codec::DecodeLimits`] + `FramingConfig::max_message_len`)
//! / recursive types bounded (depth cap) / unknown types kept as Raw.
//!
//! Evidence basis: docs/kbengine-wire-protocol.md (PA-001, engine baseline bf1a9cd6 / v2.5.10).

pub mod cache;
pub mod codec;
pub mod cursor;
pub mod entity;
pub mod error;
pub mod framing;
pub mod layout;
pub mod messages;
pub mod session;

pub use codec::{decode_spans, DecodeLimits, SpanKind, ValueSpan};
pub use error::{DecodeError, DecodeErrorKind};
pub use framing::{Frame, FrameParser, FramingConfig, LengthSpec};
pub use messages::{ImportSummary, MessageMap, MessageSpec};
pub use session::{ComponentRole, DecodedMessage, Direction, Flow, Phase, Session};
