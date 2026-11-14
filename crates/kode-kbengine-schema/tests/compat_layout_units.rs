//! KSEM-SER-13:wire 布局兼容变化(纯核心)。
//!
//! 面分组:①引擎握手分类表全变体锁定([`classify`] 判据 = 变更面是否进
//! defs-md5 聚合流,feed 锚 property.cpp:53-64 / method.cpp:28-30,50,66-67 /
//! datatype.cpp:95-96,1716,1782,2097);②两个布尔维度的正交性
//! (wire_compatible = full-redeploy 旧端解码不破位,handshake_safe =
//! 内部通道 digest 等值——含纯新增,engine_app digest 是内容等值闸);
//! ③字段顺序显式落账(FD 按名匹配序差 / 属性声明序漂移);④Arg 布局按位
//! (方法三段 + 固定消息表);⑤版本(hash 指纹 + 诚实声明)。

use std::collections::BTreeMap;

use kode_kbengine_schema::compat::{
    check_classified, classify, diff_wire_type, Change, EngineGate, LayoutCompatReport,
    MethodSegment, WireDiff,
};
use kode_kbengine_schema::messages::{MessageEntry, MessageLength, MessageTable};
use kode_kbengine_schema::schema::{EntityMethodWire, EntityPropertyWire, EntityWireInfo, Schema};
use kode_kbengine_schema::wire::{DictField, WireType};

// ---------------------------------------------------------------------------
// 夹具
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
// ① 引擎握手分类表:全变体锁定
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
// ② 两个布尔维度的正交性(验收:静态风险 vs 引擎握手实际拒绝)
// ---------------------------------------------------------------------------

#[test]
fn entity_added_is_wire_compatible_but_handshake_rejected() {
    // 纯新增实体:digest 是内容等值闸 → 混合部署 shutDown;full-redeploy 下 wire 加性。
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
    // 固定消息表参数漂移:md5 盲区 → 引擎不拦,混合部署照常启动,字节重释
    // (最危险类:无任何运行时防线)。
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
// ③ 字段顺序显式落账(验收「字段顺序」)
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
    // 叶子类型漂移:path = 别名.字段
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
    // 字段删/增:old_index / new_index 各自保留
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
    // 嵌套 FD 序差:path 线程化到容器层
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
    // 纯序差(类型全同)→ PropertyReordered 单条
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
    // 旗标漂移:md5 可见(property.cpp:57)且决定同步面
    let report = check_classified(
        &avatar(vec![prop("hp", WireType::UInt32, &["ALL_CLIENTS"])]),
        &avatar(vec![prop("hp", WireType::UInt32, &["BASE"])]),
    );
    assert_eq!(gate_of(&report, "flags"), EngineGate::HandshakeRejected);
    assert!(report.classified.iter().any(|c| c
        .change
        .to_string()
        .contains("property flags changed: Avatar.hp")));
    // 属性增/删落账(旧 check 静默忽略,SER-13 补齐)
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
// ④ Arg 布局(验收「Arg 布局/版本」:方法三段 + 按位差异)
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
    // 增参:位置即语义,落 ArgAdded(index = 新参位)
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
    // 删参
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
// ⑤ 版本与零差异 + 诚实声明
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
// ⑥ diff_wire_type 直查面(数组下钻 / 等型零差异)
// ---------------------------------------------------------------------------

#[test]
fn diff_wire_type_unit_faces() {
    // 等型 → 空
    assert!(diff_wire_type("X", &WireType::UInt32, &WireType::UInt32).is_empty());
    // 标量漂移 → 叶位一条
    assert_eq!(
        diff_wire_type("X", &WireType::UInt32, &WireType::UInt64),
        vec![WireDiff::FieldTypeChanged {
            path: "X".to_string(),
            old: "UINT32".to_string(),
            new: "UINT64".to_string(),
        }]
    );
    // 数组元素漂移:下钻 `X[]`
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
    // 结构异形(FD vs 标量)→ 顶层一条,不猜字段
    assert_eq!(
        diff_wire_type("X", &fd(vec![("a", WireType::UInt8)]), &WireType::UInt8),
        vec![WireDiff::FieldTypeChanged {
            path: "X".to_string(),
            old: "FIXED_DICT<a: UINT8>".to_string(),
            new: "UINT8".to_string(),
        }]
    );
}
