//! The wire-type layout IR (todo PA-002 "Wire Type Layout"; independent of the kode-types type graph).
//!
//! The type graph describes script-side semantics (references / inheritance / alias chains); this
//! module describes the **network serialization rules** — the shape each type has in the byte stream.
//! The rules are evidenced from PA-001 (docs/kbengine-wire-protocol.md §3/§3.1, engine baseline
//! bf1a9cd6 / v2.5.10):
//! - little-endian, fixed-width scalars (memorystream.h:139-143, 253-317);
//! - STRING = NUL terminated, no prefix (datatype.cpp:1050-1062);
//! - UNICODE/BLOB/PYTHON = a u32 length prefix (datatype.cpp:1129-1143, 1448-1463, 1225-1242);
//! - ARRAY = a u32 element count + a per-element recursion (datatype.cpp:1837-1856);
//! - FIXED_DICT = per field in declaration order, with no key names (datatype.cpp:2592+);
//! - VECTOR2/3/4 = 2/3/4 × f32 contiguous (datatype.cpp:841-858, 946-963).
//!
//! Unknown/unparsable types land as [`WireType::Unresolved`]: the decoder keeps them as Raw bytes and
//! never guesses.

use serde::{Deserialize, Serialize};

/// A FIXED_DICT field (declaration order; the key name exists only in the IR, no key name is written
/// on the wire).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DictField {
    pub name: String,
    pub ty: Box<WireType>,
}

/// The recursion depth cap (a safety valve for alias chains / FIXED_DICT / ARRAY nested in each
/// other; over the limit lands as Unresolved, under the same rule as the "recursive types bounded"
/// red line).
pub const MAX_TYPE_DEPTH: usize = 64;

/// Wire types (network serialization shapes; unrelated to the script-side type graph).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WireType {
    UInt8,
    UInt16,
    UInt32,
    UInt64,
    Int8,
    Int16,
    Int32,
    Int64,
    Float,
    Double,
    /// bool is stored as an int8 (memorystream.h:224-227).
    Bool,
    /// std::string: NUL-terminated UTF-8 with no length prefix; the reader truncates early on a
    /// non-ASCII byte (≥0x80) (memorystream.h:319-332).
    String,
    /// EntityDef UNICODE: a u32 byte length + UTF-8, no NUL (datatype.cpp:1129-1143).
    Unicode,
    /// A u32 byte length + the raw bytes (datatype.cpp:1448-1463).
    Blob,
    /// A u32 length + CPython pickle pass-through (datatype.cpp:1225-1242).
    Python,
    Vector2,
    Vector3,
    Vector4,
    /// The complete wire format of ENTITYCALL as a property value is not evidenced byte by byte
    /// (PA-001 TODO-2); the decoder keeps it as an opaque Raw and does not fabricate a field order.
    EntityCall,
    Array {
        of: Box<WireType>,
    },
    FixedDict {
        /// The "module.symbol" text of implementedBy (serialization does not affect the wire format; kept
        /// for reference).
        module: Option<String>,
        fields: Vec<DictField>,
    },
    /// Unresolvable (an unknown builtin name / an alias cycle / a missing reference): the decoder keeps
    /// it as Raw + a diagnostic.
    Unresolved(String),
}

impl WireType {
    /// The fixed byte count; `None` = variable (including Unresolved). Self-referential structures are
    /// conservatively judged variable at the depth cap and never recurse infinitely.
    pub fn fixed_size(&self) -> Option<u64> {
        self.fixed_size_within(0)
    }

    fn fixed_size_within(&self, depth: usize) -> Option<u64> {
        if depth > MAX_TYPE_DEPTH {
            return None;
        }
        let d = depth + 1;
        Some(match self {
            WireType::UInt8 | WireType::Int8 | WireType::Bool => 1,
            WireType::UInt16 | WireType::Int16 => 2,
            WireType::UInt32 | WireType::Int32 | WireType::Float => 4,
            WireType::UInt64 | WireType::Int64 | WireType::Double => 8,
            WireType::Vector2 => 8,
            WireType::Vector3 => 12,
            WireType::Vector4 => 16,
            WireType::Array { of } => {
                // The u32 element-count prefix is itself variable; even fixed-size elements are not fixed
                // (the count is on the wire).
                let _ = of.fixed_size_within(d)?;
                return None;
            }
            WireType::FixedDict { fields, .. } => {
                let mut total = 0u64;
                for f in fields {
                    total += f.ty.fixed_size_within(d)?;
                }
                total
            }
            // STRING/UNICODE/BLOB/PYTHON/EntityCall/Unresolved are all variable or opaque.
            _ => return None,
        })
    }

    pub fn is_variable(&self) -> bool {
        self.fixed_size().is_none()
    }

    /// The type display name (for diagnostics/JSON).
    pub fn display_name(&self) -> String {
        match self {
            WireType::Array { of } => format!("ARRAY<{}>", of.display_name()),
            WireType::FixedDict { fields, .. } => {
                let inner: Vec<String> = fields
                    .iter()
                    .map(|f| format!("{}: {}", f.name, f.ty.display_name()))
                    .collect();
                format!("FIXED_DICT<{}>", inner.join(", "))
            }
            WireType::Unresolved(name) => format!("UNRESOLVED<{name}>"),
            other => format!("{other:?}").to_uppercase(),
        }
    }
}

/// Builtin type name → wire type (the engine `datatype2id` native-category mapping semantics,
/// kbe/src/lib/server/common.cpp:20-70; taking its native widths and encoding rules).
pub fn builtin_wire_type(name: &str) -> Option<WireType> {
    let upper = name.trim().to_ascii_uppercase();
    Some(match upper.as_str() {
        "STRING" | "STD::STRING" => WireType::String,
        // Dedicated to protocol arguments: a variable byte block (§5.2 argsize/argoutsize semantics;
        // the JS SDK reads it as a buffer)
        "UINT8_ARRAY" => WireType::Blob,
        "UNICODE" => WireType::Unicode,
        "BLOB" => WireType::Blob,
        "PYTHON" | "PY_DICT" | "PY_TUPLE" | "PY_LIST" => WireType::Python,
        "BOOL" => WireType::Bool,
        "UINT8" | "CHAR" | "DATATYPE" | "DETAIL_TYPE" | "ENTITYCALL_CALL_TYPE" => WireType::UInt8,
        "UINT16"
        | "UNSIGNED SHORT"
        | "SERVER_ERROR_CODE"
        | "ENTITY_TYPE"
        | "ENTITY_PROPERTY_UID"
        | "ENTITY_METHOD_UID"
        | "ENTITY_SCRIPT_UID"
        | "DATATYPE_UID" => WireType::UInt16,
        "UINT32" | "UINT" | "UNSIGNED INT" | "ARRAYSIZE" | "SPACE_ID" | "GAME_TIME"
        | "TIMER_ID" => WireType::UInt32,
        "UINT64" | "DBID" | "COMPONENT_ID" => WireType::UInt64,
        "INT8" | "COMPONENT_ORDER" => WireType::Int8,
        "INT16" | "SHORT" => WireType::Int16,
        "INT32" | "INT" | "ENTITY_ID" | "CALLBACK_ID" | "COMPONENT_TYPE" => WireType::Int32,
        "INT64" => WireType::Int64,
        "FLOAT" => WireType::Float,
        "DOUBLE" => WireType::Double,
        "VECTOR2" => WireType::Vector2,
        "VECTOR3" => WireType::Vector3,
        "VECTOR4" => WireType::Vector4,
        "ENTITYCALL" => WireType::EntityCall,
        _ => return None,
    })
}

/// Whether a builtin type is resolvable (true when builtin_wire_type has a mapping).
pub fn is_resolvable_builtin(name: &str) -> bool {
    builtin_wire_type(name).is_some()
}
