//! PA-002 reinforcement tests (layout alias/entity all branches / compat all change types / wire sizes
//! and display names / messages fixed-length derivation and project overrides / builder project
//! assembly and configuration tags).
//!
//! Engine semantics per docs/kbengine-wire-protocol.md (PA-001 evidence, baseline bf1a9cd6
//! / v2.5.10); same semantics as schema_units.rs, only filling in the uncovered branches.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kode_kbengine_schema::compat::{check, check_classified, Change, CompatReport};
use kode_kbengine_schema::layout::{
    collect_raw_types, def_file_name, entity_registered, entity_wire_info, is_builtin_type,
    resolve_alias_map, resolve_ref,
};
use kode_kbengine_schema::messages::{
    build_message_table, MessageEntry, MessageLength, MessageTable,
};
use kode_kbengine_schema::schema::{EntityMethodWire, EntityPropertyWire, EntityWireInfo, Schema};
use kode_kbengine_schema::wire::{builtin_wire_type, DictField, WireType, MAX_TYPE_DEPTH};
use kode_kbengine_schema::{build_schema_from_project, BuildOptions};

fn engine_defaults_xml() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/messages_fixed_defaults.xml"
    ))
    .unwrap()
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A unique temporary project root per test (the process id + the caller's name).
fn tmp_project(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kode-schema-cov-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

// ---------------------------------------------------------------------------
// wire: size recursion depth cap / is_variable / display_name / is_resolvable_builtin
// ---------------------------------------------------------------------------

#[test]
fn wire_fixed_size_depth_limit_is_conservative() {
    // 70 levels of nested FIXED_DICT (one field per level) → the self-reference chain is
    // conservatively judged variable at the depth cap
    let mut ty = WireType::UInt8;
    for _ in 0..(MAX_TYPE_DEPTH + 6) {
        ty = WireType::FixedDict {
            module: None,
            fields: vec![DictField {
                name: "next".into(),
                ty: Box::new(ty),
            }],
        };
    }
    // One byte per level, 70 levels total > the cap → None (variable) at the cap, no stack overflow
    assert_eq!(ty.fixed_size(), None);
    assert!(ty.is_variable());
    // Shallow nesting stays exact
    let small = WireType::FixedDict {
        module: None,
        fields: vec![
            DictField {
                name: "a".into(),
                ty: Box::new(WireType::Float),
            },
            DictField {
                name: "b".into(),
                ty: Box::new(WireType::UInt32),
            },
        ],
    };
    assert_eq!(small.fixed_size(), Some(8));
    assert!(!small.is_variable());
}

#[test]
fn wire_display_names_cover_shapes() {
    assert_eq!(WireType::UInt32.display_name(), "UINT32");
    assert_eq!(WireType::String.display_name(), "STRING");
    assert_eq!(WireType::Bool.display_name(), "BOOL");
    assert_eq!(
        WireType::Array {
            of: Box::new(WireType::UInt16)
        }
        .display_name(),
        "ARRAY<UINT16>"
    );
    assert_eq!(
        WireType::FixedDict {
            module: Some("M".into()),
            fields: vec![
                DictField {
                    name: "x".into(),
                    ty: Box::new(WireType::Float),
                },
                DictField {
                    name: "y".into(),
                    ty: Box::new(WireType::Float),
                },
            ],
        }
        .display_name(),
        "FIXED_DICT<x: FLOAT, y: FLOAT>"
    );
    assert_eq!(
        WireType::Unresolved("MYSTERY".into()).display_name(),
        "UNRESOLVED<MYSTERY>"
    );
    assert_eq!(
        WireType::Vector3.display_name(),
        "VECTOR3",
        "非容器/未知类型走 Debug 大写"
    );
    // Nested display names recurse
    assert_eq!(
        WireType::Array {
            of: Box::new(WireType::FixedDict {
                module: None,
                fields: vec![DictField {
                    name: "k".into(),
                    ty: Box::new(WireType::Blob),
                }],
            })
        }
        .display_name(),
        "ARRAY<FIXED_DICT<k: BLOB>>"
    );
}

#[test]
fn wire_resolvable_builtin_matches_map() {
    assert!(kode_kbengine_schema::wire::is_resolvable_builtin("UNICODE"));
    assert!(kode_kbengine_schema::wire::is_resolvable_builtin("UINT32"));
    assert!(kode_kbengine_schema::wire::is_resolvable_builtin(
        "ENTITYCALL"
    ));
    assert!(!kode_kbengine_schema::wire::is_resolvable_builtin(
        "MYSTERY"
    ));
    assert!(!kode_kbengine_schema::wire::is_resolvable_builtin(""));
    // Same semantics as builtin_wire_type
    for n in ["STRING", "BLOB", "DOUBLE", "VECTOR4", "INT64"] {
        assert_eq!(
            kode_kbengine_schema::wire::is_resolvable_builtin(n),
            builtin_wire_type(n).is_some()
        );
    }
}

// ---------------------------------------------------------------------------
// layout: types.xml / alias.xml all branches + the resolve evaluation
// ---------------------------------------------------------------------------

#[test]
fn layout_collect_types_directive_variants() {
    // A builtin text directive / the type attribute fallback / an empty directive skipped / a root
    // child element skipped /
    // an empty implementedBy for FIXED_DICT / the ARRAY of attribute / ARRAY missing of
    let xml = r#"
<root>
  <root>SKIP_ME</root>
  <ITEM_ID> UINT16 </ITEM_ID>
  <VIA_ATTR type="UINT32" />
  <EMPTY_DECL></EMPTY_DECL>
  <FD>
    FIXED_DICT
    <Properties>
      <fieldA><Type> FLOAT </Type></fieldA>
      <fieldB><Type> <of> UINT16 </of> </Type></fieldB>
    </Properties>
    <implementedBy>   </implementedBy>
  </FD>
  <FD_IB>
    FIXED_DICT
    <Properties><p><Type> UINT8 </Type></p></Properties>
    <implementedBy> DEMO.impl </implementedBy>
  </FD_IB>
  <FD_NO_PROPS> FIXED_DICT <implementedBy> X.y </implementedBy></FD_NO_PROPS>
  <ARR_OF_ATTR>
    ARRAY
    <of>  </of>
  </ARR_OF_ATTR>
  <ARR_ATTR_ONLY of="UINT16"> ARRAY </ARR_ATTR_ONLY>
  <ARR_BARE of="UINT16" />
  <ARR_NO_OF> ARRAY </ARR_NO_OF>
</root>
"#;
    let raw = collect_raw_types(xml, None);
    let map = resolve_alias_map(&raw);

    assert_eq!(map["ITEM_ID"], WireType::UInt16);
    assert_eq!(map["VIA_ATTR"], WireType::UInt32);
    // An empty directive is skipped: EMPTY_DECL does not enter the table
    assert!(!map.contains_key("EMPTY_DECL"));
    // A root child element is skipped
    assert!(!map.contains_key("SKIP_ME"));
    // FIXED_DICT: an empty implementedBy → None (the text is not overridden); the <of> element wins
    match &map["FD"] {
        WireType::FixedDict { module, fields } => {
            assert_eq!(module, &None);
            assert_eq!(fields[0].name, "fieldA");
            assert_eq!(*fields[0].ty, WireType::Float);
            assert_eq!(*fields[1].ty, WireType::UInt16);
        }
        other => panic!("expected FixedDict, got {other:?}"),
    }
    match &map["FD_IB"] {
        WireType::FixedDict { module, .. } => assert_eq!(module, &Some("DEMO.impl".into())),
        other => panic!("expected FixedDict, got {other:?}"),
    }
    // A FIXED_DICT with no <Properties> segment → an empty field table (still parsed as a container)
    match &map["FD_NO_PROPS"] {
        WireType::FixedDict { module, fields } => {
            assert_eq!(module, &Some("X.y".into()));
            assert!(fields.is_empty());
            assert_eq!(map["FD_NO_PROPS"].fixed_size(), Some(0));
        }
        other => panic!("expected FixedDict, got {other:?}"),
    }
    // ARRAY: the <of> element text empty → filtered to the empty string; no of attribute → the element
    // stays undetermined and lands as Unresolved
    match &map["ARR_OF_ATTR"] {
        WireType::Array { of } => assert!(matches!(
            **of,
            WireType::Unresolved(ref m) if m == "ARRAY <of> missing"
        )),
        other => panic!("expected Array, got {other:?}"),
    }
    // ARRAY: no <of> child element → the of attribute fallback
    match &map["ARR_ATTR_ONLY"] {
        WireType::Array { of } => assert_eq!(**of, WireType::UInt16),
        other => panic!("expected Array, got {other:?}"),
    }
    // Only the of attribute, no ARRAY directive → no directive, the whole thing is skipped
    assert!(!map.contains_key("ARR_BARE"));
    // ARRAY with no <of> and no of attribute → the container itself is resolved, the element lands as
    // Unresolved ("ARRAY <of> missing")
    match &map["ARR_NO_OF"] {
        WireType::Array { of } => assert!(matches!(
            &**of,
            WireType::Unresolved(msg) if msg.contains("ARRAY <of> missing")
        )),
        other => panic!("expected Array-of-unresolved, got {other:?}"),
    }
}

#[test]
fn layout_alias_xml_all_target_paths() {
    // The <Type> child element wins; Type empty → the first non-Type child element name; both empty →
    // the text fallback;
    // all empty → skipped. alias.xml may reference a declaration from types.xml (the same directive
    // table).
    let types = "<root><ITEM_ID> UINT16 </ITEM_ID></root>";
    let alias = r#"
<root>
  <root><IGNORED> UINT8 </IGNORED></root>
  <ALIAS_TYPE><Type> UINT32 </Type></ALIAS_TYPE>
  <ALIAS_EMPTY_TYPE><Type>   </Type><UINT16> x </UINT16></ALIAS_EMPTY_TYPE>
  <ALIAS_TEXT> ITEM_ID </ALIAS_TEXT>
  <ALIAS_SKIP></ALIAS_SKIP>
</root>
"#;
    let raw = collect_raw_types(types, Some(alias));
    let map = resolve_alias_map(&raw);
    assert_eq!(map["ALIAS_TYPE"], WireType::UInt32);
    // Type empty → fall back to the **name** of the first non-Type child element (UINT16 is the reference)
    assert_eq!(map["ALIAS_EMPTY_TYPE"], WireType::UInt16);
    // The text fallback: ALIAS_TEXT → ITEM_ID (cross-file) → UINT16
    assert_eq!(map["ALIAS_TEXT"], WireType::UInt16);
    assert!(!map.contains_key("ALIAS_SKIP"), "全空指引被跳过");
    // A nested <root> child element is skipped
    assert!(!map.contains_key("IGNORED"));
    // An entry of types.xml itself is visible in the same table
    assert_eq!(map["ITEM_ID"], WireType::UInt16);

    // No root (an empty string) → no panic, an empty table
    let raw = collect_raw_types("", Some(""));
    assert!(resolve_alias_map(&raw).is_empty());
    // The root missing text → no panic
    let raw = collect_raw_types("\u{0}not xml", None);
    assert!(resolve_alias_map(&raw).is_empty());
}

#[test]
fn layout_resolve_ref_paths_and_cycle() {
    // A cycle: A → B → A; the depth limit → renamed "alias cycle"
    let xml = "<root><A> B </A><B> A </B></root>";
    let raw = collect_raw_types(xml, None);
    let map = resolve_alias_map(&raw);
    match &map["A"] {
        WireType::Unresolved(msg) => assert!(msg.contains("alias cycle"), "{msg}"),
        other => panic!("expected Unresolved cycle, got {other:?}"),
    }
    match &map["B"] {
        WireType::Unresolved(msg) => assert!(msg.contains("alias cycle"), "{msg}"),
        other => panic!("expected Unresolved cycle, got {other:?}"),
    }

    // The depth cap reached directly: resolve_ref starting with depth > MAX → Unresolved("depth limit")
    let raw = collect_raw_types("<root><X> UINT8 </X></root>", None);
    let ty = resolve_ref(&raw, "X", MAX_TYPE_DEPTH + 1);
    assert!(matches!(&ty, WireType::Unresolved(m) if m.contains("depth limit")));

    // An unknown name → Unresolved (the original name)
    let ty = resolve_ref(&raw, "NOPE", 0);
    assert!(matches!(&ty, WireType::Unresolved(m) if m == "NOPE"));

    // A builtin name returns directly
    assert_eq!(resolve_ref(&raw, "STRING", 0), WireType::String);
    // The trim takes effect
    assert_eq!(resolve_ref(&raw, "  UINT32  ", 0), WireType::UInt32);
}

#[test]
fn layout_fixed_dict_field_missing_type_is_unresolved() {
    // A FIXED_DICT field with no <Type> → a field-level Unresolved("{name} <Type> missing"),
    // the whole table does not fail
    let xml = r#"
<root>
  <FD>
    FIXED_DICT
    <Properties>
      <ok><Type> UINT8 </Type></ok>
      <bad><Flags> ALL </Flags></bad>
    </Properties>
  </FD>
</root>
"#;
    let raw = collect_raw_types(xml, None);
    let map = resolve_alias_map(&raw);
    match &map["FD"] {
        WireType::FixedDict { fields, .. } => {
            assert_eq!(fields.len(), 2);
            assert_eq!(*fields[0].ty, WireType::UInt8);
            assert!(matches!(
                &*fields[1].ty,
                WireType::Unresolved(m) if m.contains("bad <Type> missing")
            ));
        }
        other => panic!("expected FixedDict, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// layout: the entity wire format (merged_def parent/interface/own) + a missing Type attribute + helpers
// ---------------------------------------------------------------------------

const AVATAR_DEF: &str = r#"
<root>
  <Parent> Base </Parent>
  <Interfaces><interface> ROLE </interface></Interfaces>
  <Volatile><position/> <direction/></Volatile>
  <Properties>
    <name><Type> STRING </Type><Flags> BASE_AND_CLIENT </Flags></name>
    <hp><Type> UINT32 </Type><Flags> ALL_CLIENTS </Flags></hp>
  </Properties>
  <BaseMethods>
    <requestMove><Arg> VECTOR3 </Arg><Exposed> true </Exposed></requestMove>
  </BaseMethods>
  <CellMethods>
    <attack><Arg> UINT32 </Arg></attack>
  </CellMethods>
  <ClientMethods>
    <onDamaged><Arg> UINT16 </Arg></onDamaged>
  </ClientMethods>
</root>
"#;

const BASE_DEF: &str = r#"
<root>
  <Properties>
    <level><Type> UINT16 </Type><Flags> BASE </Flags></level>
  </Properties>
  <BaseMethods>
    <onLevelUp><Arg> UINT8 </Arg></onLevelUp>
  </BaseMethods>
</root>
"#;

const ROLE_DEF: &str = r#"
<root>
  <Properties>
    <roleId><Type> UINT16 </Type><Flags> BASE_AND_CLIENT </Flags></roleId>
  </Properties>
</root>
"#;

#[test]
fn layout_entity_wire_info_merges_parent_interface_own() {
    let raw = collect_raw_types("<root><SKILL><Type> UINT8 </Type></SKILL></root>", None);
    let mut load = |name: &str| -> Option<kode_parser::model::DefFile> {
        Some(kode_parser::model::parse_def(match name {
            "Avatar" => AVATAR_DEF,
            "Base" => BASE_DEF,
            "ROLE" => ROLE_DEF,
            _ => return None,
        }))
    };
    let info = entity_wire_info("Avatar", &mut load, &raw).expect("Avatar wire info");
    assert_eq!(info.name, "Avatar");
    assert_eq!(info.parent.as_deref(), Some("Base"));
    assert_eq!(info.interfaces, vec!["ROLE".to_string()]);
    assert!(info.volatile);

    // Property merge order: the parent's level (first) + the interface's roleId (later) + own
    // name/hp (last)
    let names: Vec<&str> = info.properties.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["level", "roleId", "name", "hp"]);
    // A same-name override: own name would override the interface/parent's same name (there is no
    // same name here, so the types are verified)
    assert_eq!(info.properties[2].ty, WireType::String);
    assert_eq!(info.properties[2].flags, vec!["BASE_AND_CLIENT"]);

    // The method segment merge: the parent's onLevelUp + own requestMove/attack/onDamaged
    let base: Vec<&str> = info.base_methods.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(base, vec!["onLevelUp", "requestMove"]);
    let cell: Vec<&str> = info.cell_methods.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(cell, vec!["attack"]);
    let client: Vec<&str> = info
        .client_methods
        .iter()
        .map(|m| m.name.as_str())
        .collect();
    assert_eq!(client, vec!["onDamaged"]);
    // The argument wire-type evaluation: VECTOR3 fixed width 12
    let rm = &info.base_methods[1];
    assert_eq!(rm.args, vec![WireType::Vector3]);
    assert!(rm.exposed);

    // A missing .def → None (the caller books it under missing_entities)
    let mut load_none = |_: &str| -> Option<kode_parser::model::DefFile> { None };
    assert!(entity_wire_info("Ghost", &mut load_none, &raw).is_none());
    // The own .def exists but the parent is missing → still returns the own part
    let mut load_partial = |name: &str| -> Option<kode_parser::model::DefFile> {
        if name == "Avatar" {
            Some(kode_parser::model::parse_def(AVATAR_DEF))
        } else {
            None
        }
    };
    let info = entity_wire_info("Avatar", &mut load_partial, &raw).expect("partial");
    assert_eq!(info.properties.len(), 2);
}

#[test]
fn layout_entity_property_without_type_is_unresolved() {
    let def = r#"
<root>
  <Properties>
    <mystery><Flags> ALL_CLIENTS </Flags></mystery>
  </Properties>
</root>
"#;
    let raw = collect_raw_types("<root></root>", None);
    let mut load = |_: &str| Some(kode_parser::model::parse_def(def));
    let info = entity_wire_info("E", &mut load, &raw).expect("E");
    assert_eq!(info.properties.len(), 1);
    assert!(matches!(
        &info.properties[0].ty,
        WireType::Unresolved(m) if m.contains("mystery <Type> missing")
    ));
}

#[test]
fn layout_def_file_name_and_builtin() {
    assert_eq!(
        def_file_name(Path::new("Avatar.def")),
        Some("Avatar".into())
    );
    assert_eq!(
        def_file_name(Path::new("dir/interfaces/ROLE.def")),
        Some("ROLE".into())
    );
    assert_eq!(
        def_file_name(Path::new("NoSuffix")),
        Some("NoSuffix".into())
    );
    // An empty path / ".." with no file_name component → None
    assert_eq!(def_file_name(Path::new("")), None);
    assert_eq!(def_file_name(Path::new("..")), None);

    // The builtin classification semantics (consistent with the kode-types forwarding)
    assert!(is_builtin_type("STRING"));
    assert!(is_builtin_type("UINT32"));
    assert!(!is_builtin_type("MYSTERY"));
}

#[test]
fn layout_entity_registered_reads_attributes() {
    let xml = r#"
<root>
  <Account hasAccount="true" hasBase="true"/>
  <Avatar hasBase="true" hasCell="true" hasClient="true"/>
</root>
"#;
    let reg = entity_registered(xml);
    assert_eq!(reg.len(), 2);
    assert_eq!(reg[0].0, "Account");
    let attrs: BTreeMap<&str, &str> = reg[1]
        .1
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(attrs.get("hasCell"), Some(&"true"));
}

// ---------------------------------------------------------------------------
// messages (the fixed table): fixed-length derivation + project overrides + bad id/arg diagnostics
// ---------------------------------------------------------------------------

#[test]
fn message_length_fixed_len_api() {
    assert_eq!(MessageLength::Fixed(8).fixed_len(), Some(8));
    assert_eq!(MessageLength::Fixed(0).fixed_len(), Some(0));
    assert_eq!(MessageLength::Variable.fixed_len(), None);
    assert!(MessageLength::Variable.is_variable());
    assert!(!MessageLength::Fixed(3).is_variable());
}

#[test]
fn message_table_by_id_find() {
    // A synthetic table with unique ids (the by_id semantics); in the engine table several components
    // share one id
    // (Machine::stopserver and Loginapp::login are both 3), and by_id takes only the first one.
    let xml = r#"
<root>
  <A::x><id>7</id><arg> UINT8 </arg></A::x>
  <B::y><id>9</id></B::y>
</root>
"#;
    let table = build_message_table(xml, None);
    let x = table.by_id(7).unwrap();
    assert_eq!(x.name, "A::x");
    assert_eq!(x.length, MessageLength::Fixed(1));
    assert_eq!(x.length.fixed_len(), Some(1));
    let y = table.by_id(9).unwrap();
    assert_eq!(y.name, "B::y");
    assert_eq!(y.length.fixed_len(), Some(0));
    assert_eq!(table.by_id(8), None);
    assert_eq!(table.find("A::x").unwrap().id, 7);
    assert_eq!(table.find("Nope"), None);

    // The engine table: the same-name id lookup and the fixed-length view (see the note above for the id
    // conflict plane)
    let engine = build_message_table(&engine_defaults_xml(), None);
    assert_eq!(engine.find("Loginapp::login").unwrap().id, 3);
    assert!(engine.find("Loginapp::login").unwrap().length.is_variable());
    let import = engine.find("Loginapp::importClientMessages").unwrap();
    assert_eq!(import.length.fixed_len(), Some(0));
}

#[test]
fn message_parse_invalid_id_and_args() {
    // A bad <id>: a non-numeric value and one beyond u16 → a diagnostic + the entry dropped
    let xml = r#"
<root>
  <Bad::Num><id>oops</id></Bad::Num>
  <Bad::Over><id>999999</id></Bad::Over>
  <Good::One><id>900</id><arg> UINT32 </arg></Good::One>
  <Good::Empty><id>901</id><arg>   </arg><arg> UINT16 </arg></Good::Empty>
  <Good::Unknown><id>902</id><arg> NO_SUCH_TYPE </arg></Good::Unknown>
</root>
"#;
    let table = build_message_table(xml, None);
    assert!(table.find("Bad::Num").is_none());
    assert!(table.find("Bad::Over").is_none());
    assert_eq!(
        table.find("Good::One").unwrap().args,
        vec![WireType::UInt32]
    );
    // An empty arg text is skipped; a non-empty UINT16 is kept
    let empty = table.find("Good::Empty").unwrap();
    assert_eq!(empty.args, vec![WireType::UInt16]);
    // An unknown argument type → Unresolved + a diagnostic
    let unknown = table.find("Good::Unknown").unwrap();
    assert!(matches!(&unknown.args[0], WireType::Unresolved(m) if m == "NO_SUCH_TYPE"));
    assert!(unknown.length.is_variable(), "未知参数保守变长");
    assert!(
        table
            .diagnostics
            .iter()
            .any(|d| d.contains("unknown arg type")),
        "diagnostics: {:?}",
        table.diagnostics
    );
    assert!(
        table.diagnostics.iter().any(|d| d.contains("invalid <id>")),
        "diagnostics: {:?}",
        table.diagnostics
    );
}

#[test]
fn message_parse_missing_id_diagnostic() {
    // An engine baseline entry with no <id>: the non-project segment records a diagnostic and produces
    // no entry
    let xml = "<root><NoId::Msg><arg> UINT8 </arg></NoId::Msg></root>";
    let table = build_message_table(xml, None);
    assert!(table.find("NoId::Msg").is_none());
    assert!(table.diagnostics.iter().any(|d| d.contains("missing <id>")));

    // The project override segment (the second argument): a same-name entry without an id is silently
    // ignored (no diagnostic)
    let table = build_message_table(
        &engine_defaults_xml(),
        Some("<root><Loginapp::login></Loginapp::login></root>"),
    );
    assert_eq!(
        table.find("Loginapp::login").unwrap().id,
        3,
        "无 id 项目覆盖忽略"
    );
}

#[test]
fn message_project_override_without_args_keeps_engine_args() {
    // A project override giving only <id> (no <arg>): the engine's original arguments and length are kept
    let project = "<root><Loginapp::login><id>77</id></Loginapp::login></root>";
    let table = build_message_table(&engine_defaults_xml(), Some(project));
    let login = table.find("Loginapp::login").unwrap();
    assert_eq!(login.id, 77);
    // The engine args (STRING/BLOB/STRING/STRING) are kept
    assert_eq!(login.args.len(), 4);
    assert!(matches!(login.args[0], WireType::String));
    assert!(login.length.is_variable(), "保留引擎参数 → 保持变长");

    // An override carrying <arg> replaces the arguments and recomputes the length (a STRING argument →
    // variable)
    let project = "<root><Loginapp::login><id>78</id><arg> UINT16 </arg></Loginapp::login></root>";
    let table = build_message_table(&engine_defaults_xml(), Some(project));
    let login = table.find("Loginapp::login").unwrap();
    assert_eq!(login.id, 78);
    assert_eq!(login.args, vec![WireType::UInt16]);
    assert_eq!(login.length, MessageLength::Fixed(2));

    // A brand-new project entry (not in the table) is added normally
    let project =
        "<root><Demo::new><id>910</id><arg> UINT32 </arg><arg> FLOAT </arg></Demo::new></root>";
    let table = build_message_table(&engine_defaults_xml(), Some(project));
    let new = table.find("Demo::new").unwrap();
    assert_eq!(new.length, MessageLength::Fixed(8));

    // Overriding a parameterless fixed message (only <id>): the empty arguments are kept → recomputed to
    // fixed 0
    let project =
        "<root><Loginapp::importClientMessages><id>55</id></Loginapp::importClientMessages></root>";
    let table = build_message_table(&engine_defaults_xml(), Some(project));
    let import = table.find("Loginapp::importClientMessages").unwrap();
    assert_eq!(import.id, 55);
    assert!(import.args.is_empty());
    assert_eq!(import.length, MessageLength::Fixed(0));
}

#[test]
fn message_overlay_all_fixed_shapes() {
    // The interface-layer corrections (§6): applied only when the XML has no <arg>; containing a variable
    // argument → Variable
    let xml = r#"
<root>
  <Loginapp::hello><id>4</id></Loginapp::hello>
  <Client::onHelloCB><id>521</id></Client::onHelloCB>
  <Baseapp::reloginBaseapp><id>201</id></Baseapp::reloginBaseapp>
</root>
"#;
    let table = build_message_table(xml, None);
    let hello = table.find("Loginapp::hello").unwrap();
    assert_eq!(hello.args.len(), 3); // str + str + blob
    assert!(hello.length.is_variable());
    assert!(
        table
            .diagnostics
            .iter()
            .any(|d| d.contains("args from engine interface overlay")),
        "diagnostics: {:?}",
        table.diagnostics
    );

    let cb = table.find("Client::onHelloCB").unwrap();
    assert_eq!(cb.id, 521);
    assert_eq!(cb.args.len(), 4);
    assert!(cb.length.is_variable());

    let relogin = table.find("Baseapp::reloginBaseapp").unwrap();
    assert_eq!(relogin.args.len(), 4);
    assert!(relogin.length.is_variable());

    // An entry already given <arg> in the XML: the corrections do not override it
    let xml = r#"
<root>
  <Loginapp::hello><id>4</id><arg> UINT16 </arg></Loginapp::hello>
</root>
"#;
    let table = build_message_table(xml, None);
    assert_eq!(
        table.find("Loginapp::hello").unwrap().args,
        vec![WireType::UInt16]
    );
    assert_eq!(
        table.find("Loginapp::hello").unwrap().length,
        MessageLength::Fixed(2)
    );
    assert!(
        !table
            .diagnostics
            .iter()
            .any(|d| d.contains("args from engine interface overlay")),
        "XML 已给参数时不套勘误: {:?}",
        table.diagnostics
    );
}

// ---------------------------------------------------------------------------
// compat: all change types + Display + the compatible/incompatible verdict
// ---------------------------------------------------------------------------

fn msg(name: &str, id: u16, length: MessageLength, args: Vec<WireType>) -> MessageEntry {
    MessageEntry {
        name: name.into(),
        id,
        args,
        length,
    }
}

fn entity(name: &str, props: Vec<(&str, WireType)>) -> EntityWireInfo {
    EntityWireInfo {
        name: name.into(),
        parent: None,
        interfaces: Vec::new(),
        volatile: false,
        properties: props
            .into_iter()
            .map(|(n, t)| EntityPropertyWire {
                name: n.into(),
                ty: t,
                flags: Vec::new(),
            })
            .collect(),
        base_methods: Vec::<EntityMethodWire>::new(),
        cell_methods: Vec::new(),
        client_methods: Vec::new(),
    }
}

fn base_schema() -> Schema {
    let mut messages = MessageTable::default();
    messages.entries.push(msg(
        "Loginapp::login",
        3,
        MessageLength::Variable,
        vec![WireType::String],
    ));
    messages.entries.push(msg(
        "Client::onHelloCB",
        521,
        MessageLength::Fixed(4),
        vec![WireType::Int32],
    ));
    let mut aliases = BTreeMap::new();
    aliases.insert("ITEM_ID".into(), WireType::UInt16);
    aliases.insert("LEVEL".into(), WireType::UInt16);
    let mut entities = BTreeMap::new();
    entities.insert(
        "Account".into(),
        entity("Account", vec![("name", WireType::String)]),
    );
    entities.insert(
        "Avatar".into(),
        entity("Avatar", vec![("hp", WireType::UInt32)]),
    );
    Schema {
        schema_version: 1,
        engine_baseline: "base".into(),
        packet_always_contain_length: false,
        aliases,
        entities,
        missing_entities: Vec::new(),
        messages,
        diagnostics: Vec::new(),
    }
}

#[test]
fn compat_all_change_variants_and_display() {
    let old = base_schema();
    let mut new = old.clone();

    // Message-level breakage: an id drift + a length change + argument changes; login removed; a message
    // added
    let mut messages = MessageTable::default();
    messages.entries.push(msg(
        "Client::onHelloCB",
        522,
        MessageLength::Variable,
        vec![WireType::UInt64],
    ));
    messages.entries.push(msg(
        "Client::onNewMsg",
        900,
        MessageLength::Fixed(0),
        Vec::new(),
    ));
    new.messages = messages;
    // Aliases: ITEM_ID removed, the LEVEL layout changed
    let mut aliases = BTreeMap::new();
    aliases.insert("LEVEL".into(), WireType::UInt32);
    new.aliases = aliases;
    // Entities: Account removed, the Avatar property type changed, Space added
    let mut entities = BTreeMap::new();
    entities.insert(
        "Avatar".into(),
        entity("Avatar", vec![("hp", WireType::Int32)]),
    );
    entities.insert(
        "Space".into(),
        entity("Space", vec![("id", WireType::UInt16)]),
    );
    new.entities = entities;
    // The configuration switch changed
    new.packet_always_contain_length = true;

    let report = check(&old, &new);
    assert!(!report.compatible);
    assert_eq!(report.old_hash, old.hash_hex());
    assert_eq!(report.new_hash, new.hash_hex());
    let kinds: Vec<String> = report.changes.iter().map(|c| format!("{c}")).collect();
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("message removed: Loginapp::login")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("message id changed: Client::onHelloCB 521 -> 522")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("message length shape changed: Client::onHelloCB")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("message args changed: Client::onHelloCB")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("message added: Client::onNewMsg (id 900)")),
        "{kinds:?}"
    );
    assert!(
        kinds.iter().any(|s| s.contains("alias removed: ITEM_ID")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("alias layout changed: LEVEL")),
        "{kinds:?}"
    );
    assert!(
        kinds.iter().any(|s| s.contains("entity removed: Account")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("property type changed: Avatar.hp")),
        "{kinds:?}"
    );
    assert!(
        kinds.iter().any(|s| s.contains("entity added: Space")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|s| s.contains("config changed: packetAlwaysContainLength false -> true")),
        "{kinds:?}"
    );
    assert_eq!(report.changes.len(), 11);
}

#[test]
fn compat_additions_and_entity_removal_are_compatible() {
    // Only a message added / an entity added / an entity removed → compatible (none of them breaks
    // decoding on the old end);
    // the id/length/arguments of existing messages stay untouched.
    let old = base_schema();
    let mut new = old.clone();
    new.messages.entries.push(msg(
        "Client::onAdded",
        901,
        MessageLength::Fixed(0),
        Vec::new(),
    ));
    new.entities.insert(
        "Space".into(),
        entity("Space", vec![("id", WireType::UInt16)]),
    );
    new.entities.remove("Account");
    let report = check(&old, &new);
    assert!(report.compatible);
    assert_eq!(report.changes.len(), 3);
    let kinds: Vec<String> = report.changes.iter().map(|c| format!("{c}")).collect();
    assert!(kinds
        .iter()
        .any(|s| s.contains("message added: Client::onAdded (id 901)")));
    assert!(kinds.iter().any(|s| s.contains("entity added: Space")));
    assert!(
        kinds.iter().any(|s| s.contains("entity removed: Account")),
        "{kinds:?}"
    );
}

#[test]
fn compat_identical_is_compatible_no_changes() {
    let old = base_schema();
    let report = check(&old, &old.clone());
    assert!(report.compatible);
    assert!(report.changes.is_empty());
}

#[test]
fn compat_property_only_in_old_is_not_a_change() {
    // A property unique to the old entity (already deleted in the new one) → booked explicitly since
    // SER-13: PropertyRemoved
    // (a removed property = a merge-order drift, the old end decodes the new stream position by
    // position and misaligns; md5 visible at property.cpp:53-64
    // → the handshake rejects). Still not PropertyTypeChanged (the type did not move).
    let old = base_schema();
    let mut new = old.clone();
    let avatar = new.entities.get_mut("Avatar").unwrap();
    assert_eq!(avatar.properties.len(), 1);
    avatar.properties.clear();
    let report = check(&old, &new);
    assert!(
        !report
            .changes
            .iter()
            .any(|c| matches!(c, Change::PropertyTypeChanged { .. })),
        "missing property is not a type change: {:?}",
        report.changes
    );
    assert!(report.changes.iter().any(|c| matches!(
        c,
        Change::PropertyRemoved { property, .. } if property == "hp"
    )));
    assert!(!report.compatible);
    let classified = check_classified(&old, &new);
    assert!(classified
        .classified
        .iter()
        .any(|c| c.gate == kode_kbengine_schema::compat::EngineGate::HandshakeRejected));
}

#[test]
fn compat_change_variant_equality_and_struct() {
    // The variant structure: directly matchable (the diagnostic/alerting plane)
    let c = Change::PropertyTypeChanged {
        entity: "Avatar".into(),
        property: "hp".into(),
    };
    match c {
        Change::PropertyTypeChanged { entity, property } => {
            assert_eq!(entity, "Avatar");
            assert_eq!(property, "hp");
        }
        other => panic!("unexpected {other:?}"),
    }
    let report = CompatReport {
        compatible: true,
        old_hash: "a".into(),
        new_hash: "b".into(),
        changes: Vec::new(),
    };
    assert!(report.compatible);
}

// ---------------------------------------------------------------------------
// builder: the project assembly (a temporary directory) + the configuration tags + missing entities +
// the error surface
// ---------------------------------------------------------------------------

#[test]
fn builder_error_display_and_non_project_root() {
    // Not an asset root (no scripts/) → Err + a readable Display
    let dir = tmp_project("not-root");
    let r = build_schema_from_project(&dir, None, &BuildOptions::default());
    let err = r.unwrap_err();
    let s = format!("{err}");
    assert!(s.contains("kbengine schema build error: not a KBEngine asset root"));
    // std::error::Error propagation
    let boxed: Box<dyn std::error::Error> = Box::new(err);
    assert!(boxed.to_string().contains("not a KBEngine asset root"));
}

#[test]
fn builder_project_fallback_and_missing_entities() {
    // The project res/server/messages_fixed_defaults.xml fallback (the engine argument None):
    // the fixed table comes from the project file, so no not-provided diagnostic is produced
    let dir = tmp_project("fallback");
    write(
        &dir.join("scripts/entities.xml"),
        "<root><Account hasBase=\"true\"/><Ghost hasBase=\"true\"/></root>",
    );
    write(&dir.join("scripts/entity_defs/types.xml"), "<root></root>");
    write(&dir.join("scripts/entity_defs/alias.xml"), "<root></root>");
    write(
        &dir.join("scripts/entity_defs/Account.def"),
        "<root><Properties><name><Type> STRING </Type></name></Properties></root>",
    );
    write(
        &dir.join("res/server/messages_fixed_defaults.xml"),
        "<root><Loginapp::hello><id>4</id></Loginapp::hello></root>",
    );
    let schema = build_schema_from_project(&dir, None, &BuildOptions::default()).expect("build");
    // Ghost is registered but its .def is missing → missing_entities (no empty entry is fabricated)
    assert_eq!(schema.missing_entities, vec!["Ghost".to_string()]);
    assert!(schema.entities.contains_key("Account"));
    assert!(!schema
        .diagnostics
        .iter()
        .any(|d| d.contains("not provided")));
    assert_eq!(schema.messages.find("Loginapp::hello").unwrap().id, 4);

    // The fallback file is also missing → the not-provided diagnostic + a fixed table = an empty
    // segment (no failure)
    let dir2 = tmp_project("no-defaults");
    write(&dir2.join("scripts/entities.xml"), "<root></root>");
    write(&dir2.join("scripts/entity_defs/types.xml"), "<root></root>");
    write(&dir2.join("scripts/entity_defs/alias.xml"), "<root></root>");
    let schema = build_schema_from_project(&dir2, None, &BuildOptions::default()).expect("build2");
    assert!(schema
        .diagnostics
        .iter()
        .any(|d| d.contains("engine messages_fixed_defaults.xml not provided")));
    assert!(schema.messages.entries.is_empty());
}

#[test]
fn builder_packet_always_contain_length_from_config() {
    let dir = tmp_project("always-len");
    write(&dir.join("scripts/entities.xml"), "<root></root>");
    write(
        &dir.join("scripts/entity_defs/types.xml"),
        "<root><ITEM_ID> UINT16 </ITEM_ID></root>",
    );
    write(
        &dir.join("res/server/kbengine.xml"),
        r#"
<root>
  <packetAlwaysContainLength> true </packetAlwaysContainLength>
</root>
"#,
    );
    let schema =
        build_schema_from_project(&dir, Some(&engine_defaults_xml()), &BuildOptions::default())
            .expect("build");
    assert!(schema.packet_always_contain_length);
    // Every message is modeled as variable (including the originally fixed importClientMessages id=5)
    assert!(schema
        .messages
        .find("Loginapp::importClientMessages")
        .unwrap()
        .length
        .is_variable());

    // The kbengine_defaults.xml fallback read (false semantics): does it override kbengine.xml? — the
    // order:
    // kbengine.xml is read first and defaults, read later, can override it; here defaults alone takes
    // effect
    let dir2 = tmp_project("always-len2");
    write(&dir2.join("scripts/entities.xml"), "<root></root>");
    write(&dir2.join("scripts/entity_defs/types.xml"), "<root></root>");
    write(
        &dir2.join("res/server/kbengine_defaults.xml"),
        r#"
<root>
  <packetAlwaysContainLength> 0 </packetAlwaysContainLength>
</root>
"#,
    );
    let schema = build_schema_from_project(
        &dir2,
        Some(&engine_defaults_xml()),
        &BuildOptions::default(),
    )
    .expect("build2");
    assert!(!schema.packet_always_contain_length);
    assert!(!schema
        .messages
        .find("Loginapp::importClientMessages")
        .unwrap()
        .length
        .is_variable());

    // A missing configuration tag / empty text → the engine default (false)
    let dir3 = tmp_project("always-len3");
    write(&dir3.join("scripts/entities.xml"), "<root></root>");
    write(&dir3.join("scripts/entity_defs/types.xml"), "<root></root>");
    write(
        &dir3.join("res/server/kbengine.xml"),
        r#"
<root>
  <packetAlwaysContainLength>   </packetAlwaysContainLength>
  <Other> x </Other>
</root>
"#,
    );
    let schema = build_schema_from_project(
        &dir3,
        Some(&engine_defaults_xml()),
        &BuildOptions::default(),
    )
    .expect("build3");
    assert!(!schema.packet_always_contain_length);

    // The "false"/"no" semantics also take the false path
    let dir4 = tmp_project("always-len4");
    write(&dir4.join("scripts/entities.xml"), "<root></root>");
    write(&dir4.join("scripts/entity_defs/types.xml"), "<root></root>");
    write(
        &dir4.join("res/server/kbengine.xml"),
        r#"
<root><packetAlwaysContainLength> no </packetAlwaysContainLength></root>
"#,
    );
    let schema = build_schema_from_project(
        &dir4,
        Some(&engine_defaults_xml()),
        &BuildOptions::default(),
    )
    .expect("build4");
    assert!(!schema.packet_always_contain_length);
}

#[test]
fn builder_truthy_variants_via_config() {
    // 1 / true / yes → true;0 / false / no → false
    for (val, want) in [
        ("1", true),
        ("true", true),
        ("yes", true),
        ("0", false),
        ("false", false),
        ("no", false),
    ] {
        let dir = tmp_project(&format!("truthy-{val}"));
        write(&dir.join("scripts/entities.xml"), "<root></root>");
        write(&dir.join("scripts/entity_defs/types.xml"), "<root></root>");
        write(
            &dir.join("res/server/kbengine.xml"),
            &format!("<root><packetAlwaysContainLength>{val}</packetAlwaysContainLength></root>"),
        );
        let schema =
            build_schema_from_project(&dir, Some(&engine_defaults_xml()), &BuildOptions::default())
                .expect("build");
        assert_eq!(schema.packet_always_contain_length, want, "value {val:?}");
    }
}

#[test]
fn builder_unreadable_file_produces_diagnostic() {
    // types.xml is a directory → the read fails → a diagnostic (no panic), the alias field falls back
    // to empty
    let dir = tmp_project("unreadable");
    write(&dir.join("scripts/entities.xml"), "<root></root>");
    write(&dir.join("scripts/entity_defs/alias.xml"), "<root></root>");
    std::fs::create_dir_all(dir.join("scripts/entity_defs/types.xml")).unwrap();
    let schema =
        build_schema_from_project(&dir, Some(&engine_defaults_xml()), &BuildOptions::default())
            .expect("build");
    assert!(
        schema.diagnostics.iter().any(|d| d.contains("unreadable")),
        "diagnostics: {:?}",
        schema.diagnostics
    );
    // The alias table is empty but the build succeeds (a bad file goes to diagnostics, no failure)
    assert!(schema.aliases.is_empty());
}

#[test]
fn builder_entities_xml_missing_is_error() {
    let dir = tmp_project("no-entities");
    write(&dir.join("scripts/entity_defs/types.xml"), "<root></root>");
    let r = build_schema_from_project(&dir, Some(&engine_defaults_xml()), &BuildOptions::default());
    let err = r.unwrap_err();
    assert!(err.0.contains("scripts/entities.xml missing"));
}

// ---------------------------------------------------------------------------
// The summary: real assembly of the demo project + a three-plane parity comparison over
// aliases/entities/messages (the same source as the golden)
// ---------------------------------------------------------------------------

#[test]
fn builder_demo_project_full_assembly() {
    let root = repo_root().join("tests/fixtures/kbengine-demo-assets");
    let schema = build_schema_from_project(
        &root,
        Some(&engine_defaults_xml()),
        &BuildOptions::default(),
    )
    .expect("demo build");
    // The entity registrations ∩ the .def files on disk
    assert!(schema.entities.contains_key("Account"));
    assert!(schema.entities.contains_key("Avatar"));
    // The alias resolution chain: ITEM_ID→UINT16, ITEM_IDS→ARRAY<ITEM_ID>
    assert_eq!(schema.resolve_alias("ITEM_ID"), Some(&WireType::UInt16));
    assert!(matches!(
        schema.resolve_alias("ITEM_IDS"),
        Some(WireType::Array { of }) if matches!(**of, WireType::UInt16)
    ));
    // The message table comes from the engine defaults
    assert_eq!(schema.messages.find("Loginapp::login").unwrap().id, 3);
    // resolve_alias for an unknown name → None
    assert_eq!(schema.resolve_alias("NOPE"), None);
}
