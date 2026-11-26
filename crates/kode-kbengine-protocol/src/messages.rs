//! Message ID mapping: static segment (fixed table) + project override segment + dynamic
//! import segment (PA-003 "message ID static + dynamic mapping"; PA-001 §5: three-segment
//! merge model — the static table does not hold on a real connection, since incrementally
//! allocated ids can only be obtained from the onImportClientMessages import frame).

use kode_kbengine_schema::messages::{build_message_table, MessageLength, MessageTable};
use kode_kbengine_schema::wire::{builtin_wire_type, WireType};

use crate::codec::DecodeLimits;
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};

/// Spec of a single message (decode plane).
#[derive(Debug, Clone, PartialEq)]
pub struct MessageSpec {
    pub id: u16,
    pub name: String,
    pub length: MessageLength,
    pub args: Vec<WireType>,
}

/// id → spec (including the dynamic import segment; an owned structure for hand-off between threads).
#[derive(Debug, Clone, Default)]
pub struct MessageMap {
    by_id: std::collections::BTreeMap<u16, MessageSpec>,
    /// EntityDef alias segment (uid → alias name; §6 step 10 alias section).
    aliases: std::collections::BTreeMap<u16, String>,
}

impl MessageMap {
    /// Static segment: the engine's fixed default table (+ project overrides, already merged by the caller in the MessageTable).
    pub fn from_static(table: &MessageTable) -> Self {
        let mut map = MessageMap::default();
        for e in &table.entries {
            map.insert_spec(e.id, e.name.clone(), e.length);
            map.set_args(e.id, e.args.clone());
        }
        map
    }

    /// Build directly from the engine's fixed default XML (convenience entry).
    pub fn from_defaults_xml(defaults_xml: &str, project_xml: Option<&str>) -> Self {
        Self::from_static(&build_message_table(defaults_xml, project_xml))
    }

    pub fn insert_spec(&mut self, id: u16, name: String, length: MessageLength) {
        let mut spec = MessageSpec {
            id,
            name,
            length,
            args: Vec::new(),
        };
        if let Some(old) = self.by_id.remove(&id) {
            spec.args = old.args;
        }
        self.by_id.insert(id, spec);
    }

    pub fn set_args(&mut self, id: u16, args: Vec<WireType>) {
        if let Some(spec) = self.by_id.get_mut(&id) {
            spec.args = args;
        }
    }

    pub fn by_id(&self, id: u16) -> Option<&MessageSpec> {
        self.by_id.get(&id)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// (id → length spec) snapshot used by framing.
    pub fn clone_specs(&self) -> std::collections::BTreeMap<u16, MessageLength> {
        self.by_id.iter().map(|(id, s)| (*id, s.length)).collect()
    }

    /// Alias segment imported with the EntityDef (uid → name; §6 step 10).
    pub fn alias_by_uid(&self, uid: u16) -> Option<&str> {
        self.aliases.get(&uid).map(String::as_str)
    }

    /// Merge in one alias (onImportClientEntityDef alias section).
    pub fn insert_alias(&mut self, uid: u16, name: String) {
        self.aliases.insert(uid, name);
    }
}

/// Dynamic import summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSummary {
    pub count: u16,
    pub variable: u16,
    pub fixed: u16,
}

/// datatype2id (the engine's measured table at kbe/src/lib/server/common.cpp:20-70;
/// used by the argTypes field of onImportClientMessages) → wire type.
pub fn wire_type_from_datatype2id(id: u8) -> Option<WireType> {
    Some(match id {
        1 => WireType::String,
        2 => WireType::UInt8,
        3 => WireType::UInt16,
        4 => WireType::UInt32,
        5 => WireType::UInt64,
        6 => WireType::Int8,
        7 => WireType::Int16,
        8 => WireType::Int32,
        9 => WireType::Int64,
        10 => WireType::Python,
        11 => WireType::Blob,
        12 => WireType::Unicode,
        13 => WireType::Float,
        14 => WireType::Double,
        15 => WireType::Vector2,
        16 => WireType::Vector3,
        17 => WireType::Vector4,
        18 => WireType::Unresolved("FIXED_DICT (import-time shape unknown)".into()),
        19 => WireType::Unresolved("ARRAY (import-time element unknown)".into()),
        20 => WireType::EntityCall,
        _ => return None,
    })
}

/// Builtin name → datatype2id (for build tests/tools).
pub fn datatype2id_of(name: &str) -> Option<u8> {
    builtin_wire_type(name)?;
    Some(match name.to_ascii_uppercase().as_str() {
        "STRING" | "STD::STRING" => 1,
        "UINT8" => 2,
        "UINT16" => 3,
        "UINT32" => 4,
        "UINT64" => 5,
        "INT8" => 6,
        "INT16" => 7,
        "INT32" => 8,
        "INT64" => 9,
        "PYTHON" => 10,
        "BLOB" | "UINT8_ARRAY" => 11,
        "UNICODE" => 12,
        "FLOAT" => 13,
        "DOUBLE" => 14,
        "VECTOR2" => 15,
        "VECTOR3" => 16,
        "VECTOR4" => 17,
        _ => 0,
    })
}

impl MessageMap {
    /// Parse an onImportClientMessages payload and **merge it into this table** (§5.2; loginapp
    /// returns ClientInterface+Loginapp exposed while baseapp returns only Baseapp exposed —
    /// the two processes have different tables, so it is applied once per Flow).
    ///
    /// Record order (loginapp.cpp:1471-1481 write order = JS kbengine.js:3841-3863 read order):
    /// `u16 count + count × { u16 msgID, i16 msgLen, str msgName,
    /// i8 argsType, u8 argsize, u8[argoutsize] }`.
    pub fn apply_import(
        &mut self,
        payload: &[u8],
        limits: &DecodeLimits,
    ) -> Result<ImportSummary, DecodeError> {
        let mut cur = Cursor::new(payload);
        let count = cur.read_u16()?;
        let mut summary = ImportSummary {
            count,
            variable: 0,
            fixed: 0,
        };
        for i in 0..count as usize {
            let path = format!("import[{i}]");
            let id = cur.read_u16()?;
            let msg_len = cur.read_i16()?;
            let name = cur.read_cstring()?;
            let _args_type = cur.read_i8()?;
            let arg_out_size = cur.read_u8()? as usize;
            let mut args = Vec::with_capacity(arg_out_size);
            for j in 0..arg_out_size {
                let tid = cur.read_u8()?;
                let _arg_path = format!("{path}.arg[{j}]");
                match wire_type_from_datatype2id(tid) {
                    Some(t) => args.push(t),
                    None => {
                        args.push(WireType::Unresolved(format!("datatype2id:{tid}")));
                    }
                }
            }
            let length = if msg_len < 0 {
                summary.variable += 1;
                MessageLength::Variable
            } else {
                summary.fixed += 1;
                MessageLength::Fixed(msg_len as u32)
            };
            self.insert_spec(id, name, length);
            self.set_args(id, args);
        }
        // Declared count left unconsumed / stream cut short: the EOF error was already raised
        // by the reads; this is an extra sentinel — the payload must be consumed exactly (the
        // engine writes a fixed-size block).
        if !cur.at_end() {
            return Err(DecodeError::new(
                DecodeErrorKind::UnexpectedEof,
                cur.offset(),
                "import",
                format!("trailing {} bytes after {count} records", cur.remaining()),
            ));
        }
        let _ = limits;
        Ok(summary)
    }
}
