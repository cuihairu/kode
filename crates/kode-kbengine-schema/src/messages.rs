//! The fixed message table (messages_fixed_defaults.xml + the project messages_fixed.xml).
//!
//! Engine semantics (PA-001 §5.1, message_handler.cpp:140-229 / fixed_messages.cpp:29-74):
//! - XML element name = `Component::messageName`, the child element `<id>` = the fixed ID;
//! - each `<arg>` = an argument builtin type name (this baseline v2.5.10 uses `<arg>`);
//! - fixed-length derivation: `msgLen == 0` is computed from `args->dataSize()` at registration;
//!   an argument containing std::string forces a downgrade to variable length (message_handler.cpp:201-215);
//! - the engine assigns IDs incrementally at process startup for messages not in the fixed table —
//!   this cannot be recovered from static evidence (PA-001 §5.2); the complete table of a real
//!   connection comes from the login-time onImportClientMessages dynamic import (consumed by the protocol
//!   engine PA-003); this table carries only the fixed-table segment.

use serde::{Deserialize, Serialize};

use kode_parser::xml::{self, NodeData};

use crate::wire::WireType;

/// Message length shape (§4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageLength {
    /// Fixed: **no** length field on the wire; the receiver looks the length up in the table.
    Fixed(u32),
    /// Variable: carries a u16 msgLen on the wire (= payload byte count, excluding the id+len header);
    /// when the payload ≥65535 the u16 writes the 65535 sentinel + the u32 actual length (§4.2-3).
    Variable,
}

impl MessageLength {
    pub fn is_variable(&self) -> bool {
        matches!(self, MessageLength::Variable)
    }

    /// The fixed value (returns None for variable).
    pub fn fixed_len(&self) -> Option<u32> {
        match self {
            MessageLength::Fixed(n) => Some(*n),
            MessageLength::Variable => None,
        }
    }
}

/// A single fixed-table message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageEntry {
    /// The `Component::messageName` original name (XML element name, keeping `::`).
    pub name: String,
    /// The fixed ID (fixed table `<id>`; the project value when overridden by the project).
    pub id: u16,
    /// Argument wire types (declaration order).
    pub args: Vec<WireType>,
    pub length: MessageLength,
}

/// The fixed message table (id ascending; carries parse diagnostics).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MessageTable {
    pub entries: Vec<MessageEntry>,
    /// Parse diagnostics (table name + inline description; same rule as SYNTAX-005: bad input does
    /// not fail).
    pub diagnostics: Vec<String>,
}

impl MessageTable {
    pub fn find(&self, name: &str) -> Option<&MessageEntry> {
        self.entries.iter().find(|e| e.name == name)
    }

    pub fn by_id(&self, id: u16) -> Option<&MessageEntry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

/// All arguments fixed → Some(sum of bytes); any argument variable/unknown → None (conservatively
/// variable).
fn sum_fixed_sizes(args: &[WireType]) -> Option<u32> {
    let mut total: u64 = 0;
    for a in args {
        total = total.checked_add(a.fixed_size()?)?;
    }
    u32::try_from(total).ok()
}

/// Engine interface-layer argument corrections (PA-001 §6 C++ parse-code semantics; applied only
/// when the fixed-table XML gives no `<arg>` — the arguments of these messages are registered in the
/// engine's C++ interface macros and the XML only gives the id):
/// - hello: str verInfo + str scriptVerInfo + blob encryptedKey
///   (serverapp.cpp:504-539 / clientapp.cpp:399-415) → variable on the wire;
/// - onHelloCB: str serverVersion + str scriptVersion + str messagesDigest +
///   i32 componentType (loginapp.cpp:1361-1377) → variable;
/// - reloginBaseapp: str name + str password + u32 rndUUID + i32 entityID
///   (clientobjectbase.cpp:655-670) → variable.
const ENGINE_INTERFACE_OVERLAY: &[(&str, &[&str])] = &[
    ("Loginapp::hello", &["STRING", "STRING", "UINT8_ARRAY"]),
    ("Baseapp::hello", &["STRING", "STRING", "UINT8_ARRAY"]),
    (
        "Client::onHelloCB",
        &["STRING", "STRING", "STRING", "INT32"],
    ),
    (
        "Baseapp::reloginBaseapp",
        &["STRING", "STRING", "UINT32", "INT32"],
    ),
];

/// Builds the fixed message table.
///
/// `defaults_xml` = the engine `kbe/res/server/messages_fixed_defaults.xml`;
/// `project_xml` = the project `res/server/messages_fixed.xml` (optional; same-name messages
/// override engine entries, with the engine's notFoundError=false semantics).
pub fn build_message_table(defaults_xml: &str, project_xml: Option<&str>) -> MessageTable {
    let mut table = MessageTable::default();
    parse_fixed_xml(defaults_xml, false, &mut table);
    if let Some(project) = project_xml {
        parse_fixed_xml(project, true, &mut table);
    }
    // Interface-layer corrections: known interface messages with no <arg> in the XML are modeled with
    // the arguments registered in the engine code (entries with <arg> take the XML as authoritative and
    // are not overridden).
    for (name, arg_names) in ENGINE_INTERFACE_OVERLAY {
        if let Some(slot) = table.entries.iter_mut().find(|e| e.name == *name) {
            if !slot.args.is_empty() {
                continue;
            }
            let mut args = Vec::with_capacity(arg_names.len());
            for raw in *arg_names {
                match crate::wire::builtin_wire_type(raw) {
                    Some(t) => args.push(t),
                    None => args.push(WireType::Unresolved((*raw).to_string())),
                }
            }
            slot.length = match sum_fixed_sizes(&args) {
                Some(total) => MessageLength::Fixed(total),
                None => MessageLength::Variable,
            };
            slot.args = args;
            table.diagnostics.push(format!(
                "{name}: args from engine interface overlay (PA-001 §6)"
            ));
        }
    }
    table.entries.sort_by_key(|e| e.id);
    table
}

fn parse_fixed_xml(text: &str, is_project_override: bool, table: &mut MessageTable) {
    let doc = xml::parse(text, false);
    let root = match doc.root() {
        Some(r) => r,
        None => {
            table
                .diagnostics
                .push("fixed messages XML has no root element".to_string());
            return;
        }
    };
    for child in doc.child_elements(root) {
        let el = doc.element(child);
        let name = el.name.clone();
        let mut id: Option<u64> = None;
        let mut args: Vec<WireType> = Vec::new();
        let mut arg_names: Vec<String> = Vec::new();
        for &sub in &el.children {
            if let NodeData::Element(sub_el) = &doc.nodes[sub].data {
                match sub_el.name.as_str() {
                    "id" => {
                        let raw = doc.element(sub).text(&doc).trim().to_string();
                        match raw.parse::<u64>() {
                            Ok(v) if v <= u16::MAX as u64 => id = Some(v),
                            _ => table
                                .diagnostics
                                .push(format!("{name}: invalid <id> {raw:?} (dropped)")),
                        }
                    }
                    "arg" | "argType" | "Arg" => {
                        let raw = doc.element(sub).text(&doc).trim().to_string();
                        if raw.is_empty() {
                            continue;
                        }
                        arg_names.push(raw.clone());
                        match crate::wire::builtin_wire_type(&raw) {
                            Some(t) => args.push(t),
                            None => {
                                // Unknown argument type: conservatively variable + kept as Unresolved, not guessed.
                                args.push(WireType::Unresolved(raw.clone()));
                                table
                                    .diagnostics
                                    .push(format!("{name}: unknown arg type {raw:?}"));
                            }
                        }
                    }
                    // descr/other child elements do not enter the IR.
                    _ => {}
                }
            }
        }
        let Some(id) = id else {
            if !is_project_override {
                // Every entry in the engine baseline carries <id>; a missing id is recorded as a diagnostic
                // and produces no entry.
                table.diagnostics.push(format!("{name}: missing <id>"));
            }
            continue;
        };
        // Fixed-length derivation: all arguments fixed → Fixed(sum size); any argument variable →
        // Variable.
        let length = match sum_fixed_sizes(&args) {
            Some(total) => MessageLength::Fixed(total),
            None => MessageLength::Variable,
        };
        let entry = MessageEntry {
            name,
            id: id as u16,
            args,
            length,
        };
        // Project override: same-name messages replace the engine entry (keeping the engine's original
        // arguments when `<arg>` is absent).
        if let Some(slot) = table.entries.iter_mut().find(|e| e.name == entry.name) {
            let args = if entry.args.is_empty() {
                slot.args.clone()
            } else {
                entry.args.clone()
            };
            let length = if entry.args.is_empty() {
                match sum_fixed_sizes(&args) {
                    Some(total) => MessageLength::Fixed(total),
                    None => MessageLength::Variable,
                }
            } else {
                entry.length
            };
            slot.id = entry.id;
            slot.args = args;
            slot.length = length;
        } else {
            table.entries.push(entry);
        }
        let _ = arg_names;
    }
}
