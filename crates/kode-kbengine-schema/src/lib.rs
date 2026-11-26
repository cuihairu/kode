//! kode2 KBEngine schema engine (todo PA-002 Phase 1).
//!
//! Generates a complete protocol Schema from a real KBEngine project: project assets
//! (scripts/entities.xml + entity_defs/**/*.def + types.xml/alias.xml) + the engine's fixed
//! message table (messages_fixed_defaults.xml + the project's messages_fixed.xml) →
//! the [`Schema`](schema::Schema) IR (canonical JSON + SHA-256 digest + version compatibility checks).
//!
//! Design boundaries (from the acceptance text):
//! - "Wire Type Layout is independent of the existing type graph": `wire`/`layout` evaluate on
//!   their own and do not consume `kode_types::graph` (the type graph = script semantics; this
//!   crate = network serialization rules, evidence in docs/kbengine-wire-protocol.md, PA-001).
//! - Reuses kode-parser (xml/model) / kode-types (builtin classification) / kode-vfs (disk read cache).
//! - Unknown types are never guessed: they land as `WireType::Unresolved`, and the decoding side
//!   keeps them as Raw.
//!
//! The three-segment model of the complete on-wire message table (static defaults + project
//! overrides + login-time dynamic import): this crate carries the first two segments; the dynamic
//! import (§5.2 onImportClientMessages) is parsed on the stream by kode-kbengine-protocol (PA-003).

pub mod builder;
pub mod compat;
pub mod layout;
pub mod messages;
pub mod schema;
pub mod wire;

pub use builder::{build_schema_from_project, BuildError, BuildOptions};
pub use compat::{check, Change, CompatReport};
pub use messages::{MessageEntry, MessageLength, MessageTable};
pub use schema::{EntityMethodWire, EntityPropertyWire, EntityWireInfo, Schema};
pub use wire::{DictField, WireType};
