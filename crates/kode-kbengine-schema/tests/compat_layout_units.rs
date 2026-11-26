//! KSEM-SER-13: wire layout compatibility changes (the pure core).
//!
//! Plane grouping: ① the engine handshake classification table, all variants pinned down (the
//! [`classify`] criterion = whether the change plane enters
//! the defs-md5 aggregation stream, feed anchors property.cpp:53-64 / method.cpp:28-30,50,66-67 /
//! datatype.cpp:95-96,1716,1782,2097); ② the orthogonality of the two boolean dimensions
//! (wire_compatible = an old end decoding does not misalign under a full redeploy, handshake_safe =
//! internal-channel digest equality — pure additions included, the engine_app digest is a
//! content-equality gate);
//! ③ the field order booked explicitly (the name-matching order difference in an FD / a property
//! declaration-order drift); ④ the Arg layout position by position
//! (the three method segments + the fixed message table); ⑤ the version (the hash fingerprint + the
//! honesty disclaimer).

use std::collections::BTreeMap;

use kode_kbengine_schema::compat::{
    check, check_classified, classify, diff_wire_type, Change, EngineGate, LayoutCompatReport,
    MethodSegment, WireDiff,
};
use kode_kbengine_schema::messages::{MessageEntry, MessageLength, MessageTable};
use kode_kbengine_schema::schema::{EntityMethodWire, EntityPropertyWire, EntityWireInfo, Schema};
use kode_kbengine_schema::wire::{DictField, WireType};

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

fn prop(name: &str, ty: WireType, flags: &[&str]) -> EntityPropertyWire {
    EntityPropertyWire {
        name: name.to_string(),
        ty,
        flags: flags.iter().map(|s| s.to_string()).collect(),
    }
}

fn method(name: &str, args: Vec<WireType>) -> EntityMethodWire {
    EntityMethodWire {
        name: name.to_string(),
        exposed: false,
        args,
    }
}

fn entity(
    props: Vec<EntityPropertyWire>,
    base: Vec<EntityMethodWire>,
    cell: Vec<EntityMethodWire>,
    client: Vec<EntityMethodWire>,
) -> EntityWireInfo {
    EntityWireInfo {
        name: String::new(),
        parent: None,
        interfaces: vec![],
        volatile: false,
        properties: props,
        base_methods: base,
        cell_methods: cell,
        client_methods: client,
    }
}

fn fd(fields: Vec<(&str, WireType)>) -> WireType {
    WireType::FixedDict {
        module: None,
        fields: fields
            .into_iter()
            .map(|(n, t)| DictField {
                name: n.to_string(),
                ty: Box::new(t),
            })
            .collect(),
    }
}

fn msg(id: u16, name: &str, args: Vec<WireType>) -> MessageEntry {
    MessageEntry {
        name: name.to_string(),
        id,
        length: MessageLength::Fixed(
            args.iter()
                .map(|a| a.fixed_size().unwrap_or(0))
                .sum::<u64>() as u32,
        ),
        args,
    }
}

fn schema(
    entities: BTreeMap<&str, EntityWireInfo>,
    aliases: BTreeMap<&str, WireType>,
    messages: Vec<MessageEntry>,
) -> Schema {
    Schema {
        entities: entities
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        aliases: aliases
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        messages: MessageTable {
            entries: messages,
            diagnostics: vec![],
        },
        ..Default::default()
    }
}

fn gate_of(report: &LayoutCompatReport, name: &str) -> EngineGate {
    report
        .classified
        .iter()
        .find(|c| c.change.to_string().contains(name))
        .map(|c| c.gate)
        .unwrap_or_else(|| {
            panic!(
                "no change matching {name}; got: {:?}",
                report
                    .classified
                    .iter()
                    .map(|c| c.change.to_string())
                    .collect::<Vec<_>>()
            )
        })
}

// ---------------------------------------------------------------------------
// ① The engine handshake classification table: all variants pinned down
// ---------------------------------------------------------------------------

#[test]
fn classification_table_locked() {
    let table: Vec<(Change, EngineGate)> = vec![
        (
            Change::MessageRemoved {
                name: "m".into(),
                old_id: 1,
            },
            EngineGate::SilentRisk,
        ),
        (
            Change::MessageAdded {
                name: "m".into(),
                new_id: 2,
            },
            EngineGate::UnGated,
        ),
        (
            Change::MessageIdChanged {
                name: "m".into(),
                old_id: 1,
                new_id: 2,
            },
            EngineGate::SilentRisk,
        ),
        (
            Change::MessageLengthChanged { name: "m".into() },
            EngineGate::SilentRisk,
        ),
        (
            Change::MessageArgsChanged { name: "m".into() },
            EngineGate::SilentRisk,
        ),
        (
            Change::AliasChanged {
                name: "ITEM".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::AliasRemoved {
                name: "ITEM".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::EntityRemoved {
                name: "Avatar".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::EntityAdded {
                name: "Avatar".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::PropertyTypeChanged {
                entity: "Avatar".into(),
                property: "hp".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::PropertyAdded {
                entity: "Avatar".into(),
                property: "mp".into(),
                index: 2,
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::PropertyRemoved {
                entity: "Avatar".into(),
                property: "mp".into(),
                old_index: 2,
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::PropertyReordered {
                entity: "Avatar".into(),
                property: "hp".into(),
                old_index: 0,
                new_index: 1,
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::PropertyFlagsChanged {
                entity: "Avatar".into(),
                property: "hp".into(),
                old: vec!["ALL_CLIENTS".into()],
                new: vec!["BASE".into()],
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::MethodAdded {
                entity: "Avatar".into(),
                segment: MethodSegment::Client,
                method: "req".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::MethodRemoved {
                entity: "Avatar".into(),
                segment: MethodSegment::Cell,
                method: "onEnter".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::MethodArgsChanged {
                entity: "Avatar".into(),
                segment: MethodSegment::Base,
                method: "onGetBase".into(),
            },
            EngineGate::HandshakeRejected,
        ),
        (
            Change::ConfigChanged {
                key: "packetAlwaysContainLength".into(),
                old: "false".into(),
                new: "true".into(),
            },
            EngineGate::SilentRisk,
        ),
    ];
    for (change, gate) in table {
        assert_eq!(classify(&change), gate, "classify drift at {change}");
    }
}

// ---------------------------------------------------------------------------
// ② The orthogonality of the two boolean dimensions (acceptance: static risk vs actually rejected by
// the engine handshake)
// ---------------------------------------------------------------------------

#[test]
fn entity_added_is_wire_compatible_but_handshake_rejected() {
    // A purely added entity: the digest is a content-equality gate → shutDown in a mixed deployment;
    // wire-additive under a full redeploy.
    let old = schema(BTreeMap::new(), BTreeMap::new(), vec![]);
    let mut new_entities = BTreeMap::new();
    new_entities.insert("Avatar", entity(vec![], vec![], vec![], vec![]));
    let new = schema(new_entities, BTreeMap::new(), vec![]);
    let report = check_classified(&old, &new);
    assert!(report.wire_compatible, "additive on the wire dimension");
    assert!(!report.handshake_safe, "digest gate is content-equality");
    assert_eq!(gate_of(&report, "Avatar"), EngineGate::HandshakeRejected);
}

#[test]
fn message_args_silent_risk_boots_mixed_and_breaks_wire() {
    // A fixed message table argument drift: an md5 blind spot → the engine does not intercept, a mixed
    // deployment starts normally, the bytes are reinterpreted
    // (the most dangerous class: no runtime line of defense at all).
    let old = schema(
        BTreeMap::new(),
        BTreeMap::new(),
        vec![msg(
            10,
            "Loginapp::login",
            vec![WireType::UInt32, WireType::String],
        )],
    );
    let new = schema(
        BTreeMap::new(),
        BTreeMap::new(),
        vec![msg(
            10,
            "Loginapp::login",
            vec![WireType::UInt32, WireType::UInt16],
        )],
    );
    let report = check_classified(&old, &new);
    assert!(!report.wire_compatible);
    assert!(
        report.handshake_safe,
        "md5-blind surface: engine boots mixed"
    );
    assert_eq!(gate_of(&report, "Loginapp::login"), EngineGate::SilentRisk);
    let diffs = &report
        .classified
        .iter()
        .find(|c| matches!(c.change, Change::MessageArgsChanged { .. }))
        .unwrap()
        .wire_diffs;
    assert_eq!(
        diffs,
        &vec![WireDiff::ArgChanged {
            path: "Loginapp::login".to_string(),
            index: 1,
            old: "STRING".to_string(),
            new: "UINT16".to_string(),
        }]
    );
}

#[test]
fn message_added_is_ungated() {
    let old = schema(BTreeMap::new(), BTreeMap::new(), vec![]);
    let new = schema(
        BTreeMap::new(),
        BTreeMap::new(),
        vec![msg(90, "Cellapp::newMsg", vec![WireType::UInt8])],
    );
    let report = check_classified(&old, &new);
    assert!(report.wire_compatible && report.handshake_safe);
    assert_eq!(gate_of(&report, "newMsg"), EngineGate::UnGated);
}

// ---------------------------------------------------------------------------
// ③ The field order booked explicitly (the acceptance item "field order")
// ---------------------------------------------------------------------------

#[test]
fn fixed_dict_field_reorder_is_explicit_not_generic() {
    let old = schema(
        BTreeMap::new(),
        BTreeMap::from([(
            "ITEM",
            fd(vec![("hp", WireType::UInt32), ("name", WireType::String)]),
        )]),
        vec![],
    );
    let new = schema(
        BTreeMap::new(),
        BTreeMap::from([(
            "ITEM",
            fd(vec![("name", WireType::String), ("hp", WireType::UInt32)]),
        )]),
        vec![],
    );
    let report = check_classified(&old, &new);
    assert_eq!(gate_of(&report, "ITEM"), EngineGate::HandshakeRejected);
    let diffs = &report.classified[0].wire_diffs;
    assert_eq!(
        diffs,
        &vec![
            WireDiff::FieldReordered {
                path: "ITEM".to_string(),
                field: "hp".to_string(),
                old_index: 0,
                new_index: 1,
            },
            WireDiff::FieldReordered {
                path: "ITEM".to_string(),
                field: "name".to_string(),
                old_index: 1,
                new_index: 0,
            },
        ],
        "同名同型仅序差:只落 Reordered,不落类型漂移"
    );
    assert!(!report.wire_compatible, "声明序 = wire 序,序差即破位");
}

#[test]
fn fixed_dict_type_change_and_field_add_remove_paths() {
    let base = |fields: Vec<(&str, WireType)>| {
        schema(
            BTreeMap::new(),
            BTreeMap::from([("ITEM", fd(fields))]),
            vec![],
        )
    };
    // A leaf type drift: path = alias.field
    let report = check_classified(
        &base(vec![("hp", WireType::UInt32)]),
        &base(vec![("hp", WireType::UInt16)]),
    );
    assert_eq!(
        report.classified[0].wire_diffs,
        vec![WireDiff::FieldTypeChanged {
            path: "ITEM.hp".to_string(),
            old: "UINT32".to_string(),
            new: "UINT16".to_string(),
        }]
    );
    // A field removed/added: old_index / new_index are each kept
    let report = check_classified(
        &base(vec![("hp", WireType::UInt32), ("nm", WireType::String)]),
        &base(vec![("hp", WireType::UInt32)]),
    );
    assert_eq!(
        report.classified[0].wire_diffs,
        vec![WireDiff::FieldRemoved {
            path: "ITEM".to_string(),
            field: "nm".to_string(),
            old_index: 1,
        }]
    );
    let report = check_classified(
        &base(vec![("hp", WireType::UInt32)]),
        &base(vec![("hp", WireType::UInt32), ("nm", WireType::String)]),
    );
    assert_eq!(
        report.classified[0].wire_diffs,
        vec![WireDiff::FieldAdded {
            path: "ITEM".to_string(),
            field: "nm".to_string(),
            index: 1,
        }]
    );
    // An order difference in a nested FD: the path threaded down to the container level
    let report = check_classified(
        &base(vec![(
            "cfg",
            fd(vec![("a", WireType::UInt8), ("b", WireType::UInt8)]),
        )]),
        &base(vec![(
            "cfg",
            fd(vec![("b", WireType::UInt8), ("a", WireType::UInt8)]),
        )]),
    );
    let diffs = &report.classified[0].wire_diffs;
    assert!(diffs
        .iter()
        .all(|d| matches!(d, WireDiff::FieldReordered { path, .. } if path == "ITEM.cfg")));
}

#[test]
fn property_order_flags_faces_from_check() {
    let avatar = |props: Vec<EntityPropertyWire>| {
        let mut e = BTreeMap::new();
        e.insert("Avatar", entity(props, vec![], vec![], vec![]));
        schema(e, BTreeMap::new(), vec![])
    };
    // A pure order difference (all types identical) → a single PropertyReordered
    let report = check_classified(
        &avatar(vec![
            prop("hp", WireType::UInt32, &["ALL_CLIENTS"]),
            prop("name", WireType::String, &["ALL_CLIENTS"]),
        ]),
        &avatar(vec![
            prop("name", WireType::String, &["ALL_CLIENTS"]),
            prop("hp", WireType::UInt32, &["ALL_CLIENTS"]),
        ]),
    );
    assert_eq!(gate_of(&report, "reordered"), EngineGate::HandshakeRejected);
    assert!(report
        .classified
        .iter()
        .any(|c| c.change.to_string() == "property reordered: Avatar.hp (index 0 -> 1)"));
    // A flag drift: md5 visible (property.cpp:57) and it decides the sync plane
    let report = check_classified(
        &avatar(vec![prop("hp", WireType::UInt32, &["ALL_CLIENTS"])]),
        &avatar(vec![prop("hp", WireType::UInt32, &["BASE"])]),
    );
    assert_eq!(gate_of(&report, "flags"), EngineGate::HandshakeRejected);
    assert!(report.classified.iter().any(|c| c
        .change
        .to_string()
        .contains("property flags changed: Avatar.hp")));
    // Property additions/removals booked (the old check silently ignored them, SER-13 fills them in)
    let report = check_classified(
        &avatar(vec![prop("hp", WireType::UInt32, &["ALL_CLIENTS"])]),
        &avatar(vec![
            prop("hp", WireType::UInt32, &["ALL_CLIENTS"]),
            prop("mp", WireType::UInt32, &["ALL_CLIENTS"]),
        ]),
    );
    assert_eq!(gate_of(&report, "mp"), EngineGate::HandshakeRejected);
}

// ---------------------------------------------------------------------------
// ④ The Arg layout (the acceptance item "Arg layout/version": the three method segments + the
// position-by-position diff)
// ---------------------------------------------------------------------------

#[test]
fn entity_method_args_changed_all_three_segments() {
    let avatar = |client: Vec<EntityMethodWire>| {
        let mut e = BTreeMap::new();
        e.insert(
            "Avatar",
            entity(
                vec![],
                vec![method("onGetBase", vec![WireType::UInt64])],
                vec![method("onEnter", vec![])],
                client,
            ),
        );
        schema(e, BTreeMap::new(), vec![])
    };
    let report = check_classified(
        &avatar(vec![method("req", vec![WireType::String])]),
        &avatar(vec![method("req", vec![WireType::UInt16])]),
    );
    assert_eq!(
        gate_of(&report, "Avatar.client.req"),
        EngineGate::HandshakeRejected
    );
    assert_eq!(
        report.classified[0].wire_diffs,
        vec![WireDiff::ArgChanged {
            path: "Avatar.client.req".to_string(),
            index: 0,
            old: "STRING".to_string(),
            new: "UINT16".to_string(),
        }]
    );
    // An argument added: position is the semantics, booked as ArgAdded (index = the new argument slot)
    let report = check_classified(
        &avatar(vec![method("req", vec![])]),
        &avatar(vec![method("req", vec![WireType::String])]),
    );
    assert_eq!(
        report.classified[0].wire_diffs,
        vec![WireDiff::ArgAdded {
            path: "Avatar.client.req".to_string(),
            index: 0,
        }]
    );
    // An argument removed
    let report = check_classified(
        &avatar(vec![method("req", vec![WireType::String, WireType::UInt8])]),
        &avatar(vec![method("req", vec![WireType::String])]),
    );
    assert_eq!(
        report.classified[0].wire_diffs,
        vec![WireDiff::ArgRemoved {
            path: "Avatar.client.req".to_string(),
            index: 1,
        }]
    );
}

// ---------------------------------------------------------------------------
// ⑤ The version and zero differences + the honesty disclaimer
// ---------------------------------------------------------------------------

#[test]
fn identical_schema_zero_changes_and_safe() {
    let mut entities = BTreeMap::new();
    entities.insert(
        "Avatar",
        entity(
            vec![prop("hp", WireType::UInt32, &["ALL_CLIENTS"])],
            vec![],
            vec![],
            vec![method("req", vec![WireType::String])],
        ),
    );
    let s = schema(
        entities,
        BTreeMap::from([("ITEM", fd(vec![("hp", WireType::UInt32)]))]),
        vec![],
    );
    let report = check_classified(&s, &s);
    assert!(report.wire_compatible && report.handshake_safe);
    assert!(report.classified.is_empty());
    assert_eq!(report.old_hash, report.new_hash);
    assert_eq!(report.old_hash.len(), 64);
    assert!(report.note.contains("entity_app.h:1250-1257"));
    assert!(report.note.contains("非引擎 defs-md5"));
    assert!(report.note.contains("外部通道"));
}

#[test]
fn changed_schema_hashes_differ() {
    let old = schema(
        BTreeMap::new(),
        BTreeMap::from([("ITEM", fd(vec![("hp", WireType::UInt32)]))]),
        vec![],
    );
    let new = schema(
        BTreeMap::new(),
        BTreeMap::from([("ITEM", fd(vec![("hp", WireType::UInt16)]))]),
        vec![],
    );
    let report = check_classified(&old, &new);
    assert_ne!(report.old_hash, report.new_hash);
}

#[test]
fn report_json_roundtrip() {
    let old = schema(
        BTreeMap::new(),
        BTreeMap::new(),
        vec![msg(10, "m", vec![WireType::UInt8])],
    );
    let mut new = old.clone();
    new.messages.entries[0].args = vec![WireType::UInt16];
    let report = check_classified(&old, &new);
    let json = serde_json::to_string(&report).expect("serialize");
    let back: LayoutCompatReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(report, back);
}

// ---------------------------------------------------------------------------
// ⑥ The direct diff_wire_type surface (the array drill-down / an identical type yielding zero
// differences)
// ---------------------------------------------------------------------------

#[test]
fn diff_wire_type_unit_faces() {
    // An identical type → empty
    assert!(diff_wire_type("X", &WireType::UInt32, &WireType::UInt32).is_empty());
    // A scalar drift → one entry at the leaf position
    assert_eq!(
        diff_wire_type("X", &WireType::UInt32, &WireType::UInt64),
        vec![WireDiff::FieldTypeChanged {
            path: "X".to_string(),
            old: "UINT32".to_string(),
            new: "UINT64".to_string(),
        }]
    );
    // An array element drift: drilling down at `X[]`
    assert_eq!(
        diff_wire_type(
            "X",
            &WireType::Array {
                of: Box::new(WireType::UInt8)
            },
            &WireType::Array {
                of: Box::new(WireType::UInt16)
            },
        ),
        vec![WireDiff::FieldTypeChanged {
            path: "X[]".to_string(),
            old: "UINT8".to_string(),
            new: "UINT16".to_string(),
        }]
    );
    // A structural shape difference (an FD vs a scalar) → one entry at the top level, no field guessing
    assert_eq!(
        diff_wire_type("X", &fd(vec![("a", WireType::UInt8)]), &WireType::UInt8),
        vec![WireDiff::FieldTypeChanged {
            path: "X".to_string(),
            old: "FIXED_DICT<a: UINT8>".to_string(),
            new: "UINT8".to_string(),
        }]
    );
}

// ---------------------------------------------------------------------------
// ⑥ The COV-010 residual arms: the two method addition/removal arms of check + the Display rendering
// surface + check_classified
//    and the property type / method argument (base/cell segment) detail arms
// ---------------------------------------------------------------------------

/// The two method addition/removal arms of check() (one per segment) + the corresponding Display
/// rendering (including the labeled
/// base/cell arms).
#[test]
fn check_method_add_remove_and_display_labels() {
    let old = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![],
                vec![method("login", vec![])],
                vec![method("tick", vec![])],
                vec![],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let new = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![],
                vec![method("summon", vec![])],
                vec![],
                vec![method("onPing", vec![])],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let report = check(&old, &new);
    let texts: Vec<String> = report.changes.iter().map(|c| c.to_string()).collect();
    assert!(
        texts.contains(&"method removed: Avatar.base.login".to_string()),
        "{texts:?}"
    );
    assert!(
        texts.contains(&"method removed: Avatar.cell.tick".to_string()),
        "{texts:?}"
    );
    assert!(
        texts.contains(&"method added: Avatar.base.summon".to_string()),
        "{texts:?}"
    );
    assert!(
        texts.contains(&"method added: Avatar.client.onPing".to_string()),
        "{texts:?}"
    );
    assert!(
        !report.compatible,
        "方法增删不在兼容白名单 → wire 维也不兼容"
    );
    // Directly constructing the MethodArgsChanged rendering for the base/cell segments (the two
    // labeled arms):
    assert_eq!(
        Change::MethodArgsChanged {
            entity: "Avatar".into(),
            segment: MethodSegment::Base,
            method: "login".into(),
        }
        .to_string(),
        "method args changed: Avatar.base.login"
    );
    assert_eq!(
        Change::MethodArgsChanged {
            entity: "Avatar".into(),
            segment: MethodSegment::Cell,
            method: "tick".into(),
        }
        .to_string(),
        "method args changed: Avatar.cell.tick"
    );
}

/// The property removal / flag drift of check() + the corresponding Display rendering.
#[test]
fn check_property_removed_and_flags_changed_display() {
    let old = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![
                    prop("hp", WireType::UInt8, &["BASE_AND_CLIENT"]),
                    prop("mp", WireType::UInt8, &[]),
                ],
                vec![],
                vec![],
                vec![],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let new = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![prop("hp", WireType::UInt8, &["ALL_CLIENTS"])],
                vec![],
                vec![],
                vec![],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let report = check(&old, &new);
    let texts: Vec<String> = report.changes.iter().map(|c| c.to_string()).collect();
    assert!(
        texts.contains(&"property removed: Avatar.mp (was index 1)".to_string()),
        "{texts:?}"
    );
    let flags_expected = format!(
        "property flags changed: Avatar.hp {:?} -> {:?}",
        vec!["BASE_AND_CLIENT"],
        vec!["ALL_CLIENTS"]
    );
    assert!(texts.contains(&flags_expected), "{texts:?}");
    assert!(!report.compatible);
}

/// The Display labels of the three EngineGate planes (rendering for the report surface).
#[test]
fn engine_gate_display_labels() {
    assert_eq!(
        EngineGate::HandshakeRejected.to_string(),
        "handshake-rejected"
    );
    assert_eq!(EngineGate::SilentRisk.to_string(), "silent-risk");
    assert_eq!(EngineGate::UnGated.to_string(), "ungated");
}

/// The PropertyTypeChanged detail arm of check_classified: a scalar drift + the recursive FD
/// drill-down.
#[test]
fn check_classified_property_type_change_wire_details() {
    let old = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![
                    prop("pos", WireType::UInt8, &[]),
                    prop(
                        "cfg",
                        fd(vec![("a", WireType::UInt8), ("b", WireType::UInt16)]),
                        &[],
                    ),
                ],
                vec![],
                vec![],
                vec![],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let new = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![
                    prop("pos", WireType::String, &[]),
                    prop(
                        "cfg",
                        fd(vec![("a", WireType::String), ("b", WireType::UInt16)]),
                        &[],
                    ),
                ],
                vec![],
                vec![],
                vec![],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let report = check_classified(&old, &new);
    assert!(!report.handshake_safe);
    let pos = report
        .classified
        .iter()
        .find(|c| {
            c.change
                .to_string()
                .contains("property type changed: Avatar.pos")
        })
        .expect("pos type change");
    assert_eq!(
        pos.wire_diffs,
        vec![WireDiff::FieldTypeChanged {
            path: "Avatar.pos".to_string(),
            old: WireType::UInt8.display_name(),
            new: WireType::String.display_name(),
        }]
    );
    let cfg = report
        .classified
        .iter()
        .find(|c| {
            c.change
                .to_string()
                .contains("property type changed: Avatar.cfg")
        })
        .expect("cfg type change");
    assert_eq!(
        cfg.wire_diffs,
        vec![WireDiff::FieldTypeChanged {
            path: "Avatar.cfg.a".to_string(),
            old: WireType::UInt8.display_name(),
            new: WireType::String.display_name(),
        }]
    );
}

/// The MethodArgsChanged detail arm of check_classified: the base/cell segments (covering
/// the base/cell lookup arms of method_args) + every shape of ArgChanged/ArgAdded/ArgRemoved.
#[test]
fn check_classified_method_args_base_and_cell_segments() {
    let old = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![],
                vec![method("login", vec![WireType::UInt8, WireType::Int8])],
                vec![method("tick", vec![WireType::Int8])],
                vec![],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let new = schema(
        BTreeMap::from([(
            "Avatar",
            entity(
                vec![],
                vec![method("login", vec![WireType::String])],
                vec![method("tick", vec![WireType::Int8, WireType::UInt8])],
                vec![],
            ),
        )]),
        BTreeMap::new(),
        vec![],
    );
    let report = check_classified(&old, &new);
    let base = report
        .classified
        .iter()
        .find(|c| c.change.to_string() == "method args changed: Avatar.base.login")
        .expect("base args change");
    assert_eq!(
        base.wire_diffs,
        vec![
            WireDiff::ArgChanged {
                path: "Avatar.base.login".to_string(),
                index: 0,
                old: WireType::UInt8.display_name(),
                new: WireType::String.display_name(),
            },
            WireDiff::ArgRemoved {
                path: "Avatar.base.login".to_string(),
                index: 1,
            },
        ]
    );
    let cell = report
        .classified
        .iter()
        .find(|c| c.change.to_string() == "method args changed: Avatar.cell.tick")
        .expect("cell args change");
    assert_eq!(
        cell.wire_diffs,
        vec![WireDiff::ArgAdded {
            path: "Avatar.cell.tick".to_string(),
            index: 1,
        }]
    );
    assert!(!report.handshake_safe);
}
