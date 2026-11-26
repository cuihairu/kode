//! Version compatibility checks (todo PA-002 "version compatibility check" + KSEM-SER-13
//! "wire layout compatibility changes").
//!
//! [`check`]: changes ruled **incompatible** (an old end decoding the new stream would misalign):
//! - message fixed ID drift / length shape change / argument wire type change / message removal;
//! - alias wire type layout change (not equal after expansion);
//! - entity property wire type change / addition or removal / declaration-order drift / flag drift;
//! - entity method additions or removals / argument-table drift (the three segments compared
//!   separately; SER-13 fills in the "Arg layout").
//!
//! Changes ruled **compatible**: adding a message / entity / alias / property.
//!
//! [`check_classified`] (SER-13): on top of [`check`], attaches [`EngineGate`] to each change —
//! whether the change plane enters the engine's defs-md5 aggregation stream decides the class:
//! **actually rejected by the engine handshake** (md5 visible; in a mixed deployment a digest mismatch
//! triggers shutDown, pure additions included — the digest is a content-equality gate and does not
//! understand "compatible evolution") vs **static incompatibility risk** (an md5 blind spot: the engine
//! does not intercept, and the bytes are silently reinterpreted per the old layout) vs ungated
//! additions; and attaches the [`WireDiff`] field order/type/argument-slot detail. The two boolean
//! dimensions are semantically orthogonal: `wire_compatible` (an old end decoding a new stream does
//! not misalign under a full redeploy) ≠ `handshake_safe` (internal-channel digest equality).

use serde::{Deserialize, Serialize};

use crate::schema::Schema;
use crate::wire::WireType;

/// Entity method segment (SER-13: the three argument tables compared separately).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MethodSegment {
    Base,
    Cell,
    Client,
}

impl MethodSegment {
    fn label(self) -> &'static str {
        match self {
            MethodSegment::Base => "base",
            MethodSegment::Cell => "cell",
            MethodSegment::Client => "client",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    MessageRemoved {
        name: String,
        old_id: u16,
    },
    MessageAdded {
        name: String,
        new_id: u16,
    },
    MessageIdChanged {
        name: String,
        old_id: u16,
        new_id: u16,
    },
    MessageLengthChanged {
        name: String,
    },
    MessageArgsChanged {
        name: String,
    },
    AliasChanged {
        name: String,
    },
    AliasRemoved {
        name: String,
    },
    EntityRemoved {
        name: String,
    },
    EntityAdded {
        name: String,
    },
    PropertyTypeChanged {
        entity: String,
        property: String,
    },
    PropertyAdded {
        entity: String,
        property: String,
        index: usize,
    },
    PropertyRemoved {
        entity: String,
        property: String,
        old_index: usize,
    },
    /// Declaration-order drift (declaration order = wire order, SER-02 §2; the old check matched by
    /// name and ignored order, SER-13 fills in the acceptance item "field order").
    PropertyReordered {
        entity: String,
        property: String,
        old_index: usize,
        new_index: usize,
    },
    /// Sync flag drift (BASE_AND_CLIENT / ALL_CLIENTS / ...; md5 visible via the property.cpp:57 flags
    /// feed, and it decides the sync plane).
    PropertyFlagsChanged {
        entity: String,
        property: String,
        old: Vec<String>,
        new: Vec<String>,
    },
    MethodAdded {
        entity: String,
        segment: MethodSegment,
        method: String,
    },
    MethodRemoved {
        entity: String,
        segment: MethodSegment,
        method: String,
    },
    /// Method argument-table drift (each of the three segments; md5 visible via the per-argument feed at method.cpp:66-67).
    MethodArgsChanged {
        entity: String,
        segment: MethodSegment,
        method: String,
    },
    ConfigChanged {
        key: String,
        old: String,
        new: String,
    },
}

impl std::fmt::Display for Change {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Change::MessageRemoved { name, old_id } => {
                write!(f, "message removed: {name} (was id {old_id})")
            }
            Change::MessageAdded { name, new_id } => {
                write!(f, "message added: {name} (id {new_id})")
            }
            Change::MessageIdChanged {
                name,
                old_id,
                new_id,
            } => {
                write!(f, "message id changed: {name} {old_id} -> {new_id}")
            }
            Change::MessageLengthChanged { name } => {
                write!(f, "message length shape changed: {name}")
            }
            Change::MessageArgsChanged { name } => write!(f, "message args changed: {name}"),
            Change::AliasChanged { name } => write!(f, "alias layout changed: {name}"),
            Change::AliasRemoved { name } => write!(f, "alias removed: {name}"),
            Change::EntityRemoved { name } => write!(f, "entity removed: {name}"),
            Change::EntityAdded { name } => write!(f, "entity added: {name}"),
            Change::PropertyTypeChanged { entity, property } => {
                write!(f, "property type changed: {entity}.{property}")
            }
            Change::PropertyAdded {
                entity,
                property,
                index,
            } => {
                write!(f, "property added: {entity}.{property} (index {index})")
            }
            Change::PropertyRemoved {
                entity,
                property,
                old_index,
            } => {
                write!(
                    f,
                    "property removed: {entity}.{property} (was index {old_index})"
                )
            }
            Change::PropertyReordered {
                entity,
                property,
                old_index,
                new_index,
            } => {
                write!(
                    f,
                    "property reordered: {entity}.{property} (index {old_index} -> {new_index})"
                )
            }
            Change::PropertyFlagsChanged {
                entity,
                property,
                old,
                new,
            } => {
                write!(
                    f,
                    "property flags changed: {entity}.{property} {old:?} -> {new:?}"
                )
            }
            Change::MethodAdded {
                entity,
                segment,
                method,
            } => {
                write!(f, "method added: {}.{}.{}", entity, segment.label(), method)
            }
            Change::MethodRemoved {
                entity,
                segment,
                method,
            } => {
                write!(
                    f,
                    "method removed: {}.{}.{}",
                    entity,
                    segment.label(),
                    method
                )
            }
            Change::MethodArgsChanged {
                entity,
                segment,
                method,
            } => {
                write!(
                    f,
                    "method args changed: {}.{}.{}",
                    entity,
                    segment.label(),
                    method
                )
            }
            Change::ConfigChanged { key, old, new } => {
                write!(f, "config changed: {key} {old} -> {new}")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompatReport {
    pub compatible: bool,
    pub old_hash: String,
    pub new_hash: String,
    pub changes: Vec<Change>,
}

/// old = the published schema, new = the recomputed schema.
pub fn check(old: &Schema, new: &Schema) -> CompatReport {
    let mut changes: Vec<Change> = Vec::new();

    if old.packet_always_contain_length != new.packet_always_contain_length {
        changes.push(Change::ConfigChanged {
            key: "packetAlwaysContainLength".into(),
            old: old.packet_always_contain_length.to_string(),
            new: new.packet_always_contain_length.to_string(),
        });
    }

    for m in &old.messages.entries {
        match new.messages.find(&m.name) {
            None => changes.push(Change::MessageRemoved {
                name: m.name.clone(),
                old_id: m.id,
            }),
            Some(nm) => {
                if nm.id != m.id {
                    changes.push(Change::MessageIdChanged {
                        name: m.name.clone(),
                        old_id: m.id,
                        new_id: nm.id,
                    });
                }
                if nm.length != m.length {
                    changes.push(Change::MessageLengthChanged {
                        name: m.name.clone(),
                    });
                }
                if nm.args != m.args {
                    changes.push(Change::MessageArgsChanged {
                        name: m.name.clone(),
                    });
                }
            }
        }
    }
    for m in &new.messages.entries {
        if old.messages.find(&m.name).is_none() {
            changes.push(Change::MessageAdded {
                name: m.name.clone(),
                new_id: m.id,
            });
        }
    }

    for (name, ty) in &old.aliases {
        match new.aliases.get(name) {
            None => changes.push(Change::AliasRemoved { name: name.clone() }),
            Some(n) if n != ty => changes.push(Change::AliasChanged { name: name.clone() }),
            _ => {}
        }
    }

    for (name, ent) in &old.entities {
        match new.entities.get(name) {
            None => changes.push(Change::EntityRemoved { name: name.clone() }),
            Some(ne) => {
                // Property plane: matched by name; declaration order is the wire order (SER-02 §2), and
                // order/flags/additions-removals are booked item by item (md5 visible: property.cpp:53-64, SER-13).
                for (oi, p) in ent.properties.iter().enumerate() {
                    match ne.properties.iter().position(|q| q.name == p.name) {
                        None => changes.push(Change::PropertyRemoved {
                            entity: name.clone(),
                            property: p.name.clone(),
                            old_index: oi,
                        }),
                        Some(ni) => {
                            let np = &ne.properties[ni];
                            if ni != oi {
                                changes.push(Change::PropertyReordered {
                                    entity: name.clone(),
                                    property: p.name.clone(),
                                    old_index: oi,
                                    new_index: ni,
                                });
                            }
                            if np.ty != p.ty {
                                changes.push(Change::PropertyTypeChanged {
                                    entity: name.clone(),
                                    property: p.name.clone(),
                                });
                            }
                            if np.flags != p.flags {
                                changes.push(Change::PropertyFlagsChanged {
                                    entity: name.clone(),
                                    property: p.name.clone(),
                                    old: p.flags.clone(),
                                    new: np.flags.clone(),
                                });
                            }
                        }
                    }
                }
                for (ni, np) in ne.properties.iter().enumerate() {
                    if !ent.properties.iter().any(|q| q.name == np.name) {
                        changes.push(Change::PropertyAdded {
                            entity: name.clone(),
                            property: np.name.clone(),
                            index: ni,
                        });
                    }
                }

                // The three method segments: the argument tables compared segment by segment (md5 visible:
                // method.cpp:28-30/:66-67; the old check did not compare the method plane, SER-13 fills in
                // the acceptance item "Arg layout").
                for (old_ms, new_ms, segment) in [
                    (
                        ent.base_methods.as_slice(),
                        ne.base_methods.as_slice(),
                        MethodSegment::Base,
                    ),
                    (
                        ent.cell_methods.as_slice(),
                        ne.cell_methods.as_slice(),
                        MethodSegment::Cell,
                    ),
                    (
                        ent.client_methods.as_slice(),
                        ne.client_methods.as_slice(),
                        MethodSegment::Client,
                    ),
                ] {
                    for om in old_ms {
                        match new_ms.iter().find(|m| m.name == om.name) {
                            None => changes.push(Change::MethodRemoved {
                                entity: name.clone(),
                                segment,
                                method: om.name.clone(),
                            }),
                            Some(nm) => {
                                if nm.args != om.args {
                                    changes.push(Change::MethodArgsChanged {
                                        entity: name.clone(),
                                        segment,
                                        method: om.name.clone(),
                                    });
                                }
                            }
                        }
                    }
                    for nm in new_ms {
                        if !old_ms.iter().any(|m| m.name == nm.name) {
                            changes.push(Change::MethodAdded {
                                entity: name.clone(),
                                segment,
                                method: nm.name.clone(),
                            });
                        }
                    }
                }
            }
        }
    }
    for name in new.entities.keys() {
        if !old.entities.contains_key(name) {
            changes.push(Change::EntityAdded { name: name.clone() });
        }
    }

    let compatible = changes.iter().all(|c| {
        matches!(
            c,
            Change::MessageAdded { .. } | Change::EntityAdded { .. } | Change::EntityRemoved { .. }
        )
    });

    CompatReport {
        compatible,
        old_hash: old.hash_hex(),
        new_hash: new.hash_hex(),
        changes,
    }
}

// ---------------------------------------------------------------------------
// SER-13: engine handshake classification (static incompatibility risk vs actually rejected by the
// engine handshake) + wire detail
// ---------------------------------------------------------------------------

/// The engine plane a change falls into (SER-13 acceptance: distinguishes static incompatibility risk
/// from the conditions under which the engine handshake actually rejects).
///
/// Criterion = whether the change plane enters the engine's defs-md5 aggregation stream (feed anchors,
/// KBEngine bf1a9cd6):
/// - properties: property.cpp:53-64 (name / default string / type name / utype / flags / persistent /
///   identifier / databaseLength / detailLevel / datatype uid);
/// - methods: method.cpp:28-30 (name / utype / exposed) + :50 (the setExposed append)
///   + :66-67 (the per-argument datatype uid, **append order = argument order**);
/// - data types: datatype.cpp:95-96 (registered name / uid), :1716/:1782/:2097
///   (FIXED_DICT/FixedArray per-field uid + type name, **append order = declaration order**);
/// - final: entitydef.cpp:243; handshake: entity_app.h:1250-1257 — a digest mismatch means
///   ERROR_MSG + `shutDown()`, internal channel only (isExternal returns early), and the digest is
///   distributed by dbmgr (sync_app_datas_handler.cpp:97, including the 3-second registration wait gate).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineGate {
    /// Visible in defs-md5: a mixed deployment is always rejected at the handshake — **pure additions
    /// included** (the digest is a content-equality gate and does not understand "compatible evolution";
    /// the old `compatible` marking EntityAdded/Removed as compatible is the wire dimension, not the
    /// handshake dimension). Under a full redeploy, look at the `wire_compatible` dimension separately.
    HandshakeRejected,
    /// An md5 blind spot but visible on the wire: the engine does not intercept, a mixed deployment
    /// starts normally, and the bytes are reinterpreted per the old layout (fixed message table id/length/
    /// arguments, and engine configuration belong to the config layer and do not enter the defs
    /// aggregation stream) — **the most dangerous class: no runtime line of defense at all**.
    SilentRisk,
    /// An md5 blind spot and wire-additive: adding a fixed message; the old end does not recognize the new id and does not reinterpret old bytes.
    UnGated,
}

impl std::fmt::Display for EngineGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineGate::HandshakeRejected => write!(f, "handshake-rejected"),
            EngineGate::SilentRisk => write!(f, "silent-risk"),
            EngineGate::UnGated => write!(f, "ungated"),
        }
    }
}

/// One change → classification into the engine handshake plane (see the [`EngineGate`] module anchors for the criteria).
pub fn classify(change: &Change) -> EngineGate {
    match change {
        Change::PropertyTypeChanged { .. }
        | Change::PropertyAdded { .. }
        | Change::PropertyRemoved { .. }
        | Change::PropertyReordered { .. }
        | Change::PropertyFlagsChanged { .. }
        | Change::MethodAdded { .. }
        | Change::MethodRemoved { .. }
        | Change::MethodArgsChanged { .. }
        | Change::AliasChanged { .. }
        | Change::AliasRemoved { .. }
        | Change::EntityRemoved { .. }
        | Change::EntityAdded { .. } => EngineGate::HandshakeRejected,
        Change::MessageRemoved { .. }
        | Change::MessageIdChanged { .. }
        | Change::MessageLengthChanged { .. }
        | Change::MessageArgsChanged { .. }
        | Change::ConfigChanged { .. } => EngineGate::SilentRisk,
        Change::MessageAdded { .. } => EngineGate::UnGated,
    }
}

/// Wire detail diffs (SER-13 acceptance: field order / type / Arg layout booked position by position).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireDiff {
    /// Declaration-order drift of same-name fields in a FIXED_DICT (declaration order = wire order, SER-02 §2):
    /// even when every field type is identical, re-reading the bytes misaligns.
    FieldReordered {
        path: String,
        field: String,
        old_index: usize,
        new_index: usize,
    },
    /// Leaf wire type drift (counted by display_name; path = the alias or the `alias.field` leaf position).
    FieldTypeChanged {
        path: String,
        old: String,
        new: String,
    },
    FieldAdded {
        path: String,
        field: String,
        index: usize,
    },
    FieldRemoved {
        path: String,
        field: String,
        old_index: usize,
    },
    /// Arguments compared position by position: a wire type drift at the same slot (position is the semantics).
    ArgChanged {
        path: String,
        index: usize,
        old: String,
        new: String,
    },
    ArgAdded {
        path: String,
        index: usize,
    },
    ArgRemoved {
        path: String,
        index: usize,
    },
}

/// The layout diff between two wire types: FIXED_DICT matches by name (an order difference =
/// [`WireDiff::FieldReordered`], a type difference drills down recursively); ARRAY element differences
/// drill down at `path[]`; leaves are compared by [`WireType::display_name`].
pub fn diff_wire_type(path: &str, old: &WireType, new: &WireType) -> Vec<WireDiff> {
    let mut out = Vec::new();
    diff_type(path, old, new, &mut out);
    out
}

fn diff_type(path: &str, old: &WireType, new: &WireType, out: &mut Vec<WireDiff>) {
    if old == new {
        return;
    }
    match (old, new) {
        (
            WireType::FixedDict {
                fields: of,
                module: _,
            },
            WireType::FixedDict {
                fields: nf,
                module: _,
            },
        ) => {
            for (oi, f) in of.iter().enumerate() {
                match nf.iter().position(|g| g.name == f.name) {
                    None => out.push(WireDiff::FieldRemoved {
                        path: path.to_string(),
                        field: f.name.clone(),
                        old_index: oi,
                    }),
                    Some(ni) => {
                        if ni != oi {
                            out.push(WireDiff::FieldReordered {
                                path: path.to_string(),
                                field: f.name.clone(),
                                old_index: oi,
                                new_index: ni,
                            });
                        }
                        diff_type(&format!("{path}.{}", f.name), &f.ty, &nf[ni].ty, out);
                    }
                }
            }
            for (ni, g) in nf.iter().enumerate() {
                if !of.iter().any(|f| f.name == g.name) {
                    out.push(WireDiff::FieldAdded {
                        path: path.to_string(),
                        field: g.name.clone(),
                        index: ni,
                    });
                }
            }
        }
        (WireType::Array { of: oe }, WireType::Array { of: ne }) => {
            diff_type(&format!("{path}[]"), oe, ne, out);
        }
        _ => out.push(WireDiff::FieldTypeChanged {
            path: path.to_string(),
            old: old.display_name(),
            new: new.display_name(),
        }),
    }
}

/// Position-by-position diff of an argument table (position is the semantics; path = the message name or `entity.segment.method`).
fn diff_args(path: &str, old: &[WireType], new: &[WireType], out: &mut Vec<WireDiff>) {
    for i in 0..old.len().min(new.len()) {
        if old[i] != new[i] {
            out.push(WireDiff::ArgChanged {
                path: path.to_string(),
                index: i,
                old: old[i].display_name(),
                new: new[i].display_name(),
            });
        }
    }
    for i in old.len().min(new.len())..new.len() {
        out.push(WireDiff::ArgAdded {
            path: path.to_string(),
            index: i,
        });
    }
    for i in new.len().min(old.len())..old.len() {
        out.push(WireDiff::ArgRemoved {
            path: path.to_string(),
            index: i,
        });
    }
}

/// The argument table of a given method in a given entity segment (entity/method missing → None).
fn method_args<'a>(
    entity: Option<&'a crate::schema::EntityWireInfo>,
    segment: MethodSegment,
    method: &str,
) -> Option<&'a [WireType]> {
    let e = entity?;
    let m = match segment {
        MethodSegment::Base => e.base_methods.iter().find(|m| m.name == method),
        MethodSegment::Cell => e.cell_methods.iter().find(|m| m.name == method),
        MethodSegment::Client => e.client_methods.iter().find(|m| m.name == method),
    }?;
    Some(&m.args)
}

/// One classified change: the change itself + the engine handshake plane + the wire detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClassifiedChange {
    pub change: Change,
    pub gate: EngineGate,
    pub wire_diffs: Vec<WireDiff>,
}

/// SER-13 report-oriented: [`check`] plus the engine handshake classification and the wire detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutCompatReport {
    /// Same semantics as [`check`]'s `compatible`: under full-redeploy semantics an old end decoding a new
    /// stream does not misalign. **Not** a handshake verdict — see `handshake_safe`.
    pub wire_compatible: bool,
    /// The engine's internal-channel handshake plane: any [`EngineGate::HandshakeRejected`] change makes it
    /// false (pure additions included); only zero differences yield true. Clients/bots go through the external
    /// channel and are not subject to this gate (isExternal returns early); the static comparison is the only
    /// line of defense on that side.
    pub handshake_safe: bool,
    /// Version dimension: canonical JSON SHA-256 tool fingerprint (old / new) — an identical fingerprint
    /// ⇔ byte-identical canonical content; **not** the engine's defs-md5 (see `note`).
    pub old_hash: String,
    pub new_hash: String,
    pub classified: Vec<ClassifiedChange>,
    pub note: String,
}

/// The report's honesty disclaimer: the classification criteria anchors + the hash nature + the external-channel semantics.
pub const COMPAT_HONESTY_NOTE: &str = "分类依据引擎 defs-md5 聚合流(feed 锚:property.cpp:53-64 / method.cpp:28-30,50,66-67 / datatype.cpp:95-96,1716,1782,2097;final entitydef.cpp:243;握手 entity_app.h:1250-1257 仅内部通道,digest 由 dbmgr 分发 sync_app_datas_handler.cpp:97)。hash 为 canonical JSON SHA-256 工具指纹,非引擎 defs-md5,握手以引擎自身聚合为准;客户端走外部通道不吃此闸,静态比对是那侧唯一防线。";

/// old = the published schema, new = the recomputed schema.
pub fn check_classified(old: &Schema, new: &Schema) -> LayoutCompatReport {
    let report = check(old, new);
    let mut classified = Vec::with_capacity(report.changes.len());
    for change in &report.changes {
        let wire_diffs = match change {
            Change::AliasChanged { name } => match (old.aliases.get(name), new.aliases.get(name)) {
                (Some(o), Some(n)) => diff_wire_type(name, o, n),
                _ => Vec::new(),
            },
            Change::PropertyTypeChanged { entity, property } => {
                let old_ty = old
                    .entities
                    .get(entity)
                    .and_then(|e| e.properties.iter().find(|p| p.name == property.as_str()))
                    .map(|p| &p.ty);
                let new_ty = new
                    .entities
                    .get(entity)
                    .and_then(|e| e.properties.iter().find(|p| p.name == property.as_str()))
                    .map(|p| &p.ty);
                match (old_ty, new_ty) {
                    (Some(o), Some(n)) => diff_wire_type(&format!("{entity}.{property}"), o, n),
                    _ => Vec::new(),
                }
            }
            Change::MethodArgsChanged {
                entity,
                segment,
                method,
            } => {
                match (
                    method_args(old.entities.get(entity), *segment, method),
                    method_args(new.entities.get(entity), *segment, method),
                ) {
                    (Some(o), Some(n)) => {
                        let mut out = Vec::new();
                        diff_args(
                            &format!("{entity}.{}.{}", segment.label(), method),
                            o,
                            n,
                            &mut out,
                        );
                        out
                    }
                    _ => Vec::new(),
                }
            }
            Change::MessageArgsChanged { name } => {
                match (old.messages.find(name), new.messages.find(name)) {
                    (Some(o), Some(n)) => {
                        let mut out = Vec::new();
                        diff_args(name, &o.args, &n.args, &mut out);
                        out
                    }
                    _ => Vec::new(),
                }
            }
            _ => Vec::new(),
        };
        let gate = classify(change);
        classified.push(ClassifiedChange {
            change: change.clone(),
            gate,
            wire_diffs,
        });
    }
    let handshake_safe = !classified
        .iter()
        .any(|c| c.gate == EngineGate::HandshakeRejected);
    LayoutCompatReport {
        wire_compatible: report.compatible,
        handshake_safe,
        old_hash: old.hash_hex(),
        new_hash: new.hash_hex(),
        classified,
        note: COMPAT_HONESTY_NOTE.to_string(),
    }
}
