//! Schema IR + canonical JSON + the SHA-256 digest (todo PA-002 "JSON+Hash").

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::messages::MessageTable;
use crate::wire::WireType;

/// One entity wire-format entry (properties + the three method segments, all as wire types).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EntityWireInfo {
    pub name: String,
    pub parent: Option<String>,
    pub interfaces: Vec<String>,
    pub volatile: bool,
    /// Merge order: parent → interfaces → own; flags keep their normalized tokens.
    pub properties: Vec<EntityPropertyWire>,
    pub base_methods: Vec<EntityMethodWire>,
    pub cell_methods: Vec<EntityMethodWire>,
    pub client_methods: Vec<EntityMethodWire>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntityPropertyWire {
    pub name: String,
    pub ty: WireType,
    /// Normalized flags (BASE_AND_CLIENT / ALL_CLIENTS / ...; used by the sync plane).
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntityMethodWire {
    pub name: String,
    pub exposed: bool,
    pub args: Vec<WireType>,
}

/// The Schema IR (project level; canonical order: BTreeMap + Vec ascending by id).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Schema {
    /// IR version (bumped when the structure evolves).
    pub schema_version: u32,
    /// The engine baseline taken as evidence (PA-001: bf1a9cd6 / v2.5.10).
    pub engine_baseline: String,
    /// §4.3 packetAlwaysContainLength (engine default false).
    pub packet_always_contain_length: bool,
    /// The alias wire-type table (types.xml + alias.xml; name → the expanded wire type).
    pub aliases: BTreeMap<String, WireType>,
    /// Entity wire formats (entities.xml registrations ∩ .def on disk).
    pub entities: BTreeMap<String, EntityWireInfo>,
    /// Registered in entities.xml but the .def is missing (kept as a diagnostic; no empty entry is fabricated).
    pub missing_entities: Vec<String>,
    pub messages: MessageTable,
    /// Build diagnostics (same rule as SYNTAX-005: bad input does not fail, each item locatable).
    pub diagnostics: Vec<String>,
}

impl Schema {
    pub const SCHEMA_VERSION: u32 = 1;
    pub const ENGINE_BASELINE: &str = "kbengine bf1a9cd6f4a82dd715fcf4a69697382ed531b4c0 (v2.5.10)";

    /// The expanded alias wire type (types.xml/alias.xml; unknown names return None).
    pub fn resolve_alias(&self, name: &str) -> Option<&WireType> {
        self.aliases.get(name)
    }

    /// Canonical JSON: serde_json structural order + BTreeMap lexicographic order + Vec ascending by id;
    /// byte-identical for identical input (no unstable fields such as timestamps/paths).
    pub fn to_canonical_json(&self) -> String {
        // The entry order is already sorted at build time; sort once more here as a fallback (a defense
        // against hand-built values).
        let mut sorted = self.clone();
        sorted
            .messages
            .entries
            .sort_by(|a, b| a.id.cmp(&b.id).then(a.name.cmp(&b.name)));
        serde_json::to_string(&sorted).expect("Schema is JSON-serializable")
    }

    /// SHA-256 (the canonical JSON UTF-8 bytes); lowercase hex.
    pub fn hash_hex(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.to_canonical_json().as_bytes());
        let d = h.finalize();
        let mut out = String::with_capacity(64);
        for b in d {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }
}
