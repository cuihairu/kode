//! PA-002 补强测试(layout 别名/实体全分支 / compat 全变更类型 / wire 尺寸
//! 与显示名 / messages 定长推导与项目覆盖 / builder 项目装配与配置标签)。
//!
//! 引擎语义依据 docs/kbengine-wire-protocol.md(PA-001 取证,基准 bf1a9cd6
//! / v2.5.10);与 schema_units.rs 同源口径,只补未覆盖分支。

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

/// 每测试唯一临时项目根(进程 id + 调用方名)。
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
// wire:尺寸递归深限 / is_variable / display_name / is_resolvable_builtin
// ---------------------------------------------------------------------------

#[test]
fn wire_fixed_size_depth_limit_is_conservative() {
    // 70 层嵌套 FIXED_DICT(每层单字段)→ 自引用链在深限处保守判变长
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
    // 每层 1 字节,总深 70 层 > 深限 → 深限处返回 None(变长),不栈溢出
    assert_eq!(ty.fixed_size(), None);
    assert!(ty.is_variable());
    // 浅层嵌套仍精确
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
    // 嵌套显示名递归
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
    // 与 builtin_wire_type 同口径
    for n in ["STRING", "BLOB", "DOUBLE", "VECTOR4", "INT64"] {
        assert_eq!(
            kode_kbengine_schema::wire::is_resolvable_builtin(n),
            builtin_wire_type(n).is_some()
        );
    }
}

// ---------------------------------------------------------------------------
// layout:types.xml / alias.xml 全分支 + resolve 求值
// ---------------------------------------------------------------------------

#[test]
fn layout_collect_types_directive_variants() {
    // 内建文本指引 / type 属性回落 / 空指引跳过 / root 子元素跳过 /
    // FIXED_DICT 空 implementedBy / ARRAY of 属性 / ARRAY 缺 of
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
    // 空指引被跳过:EMPTY_DECL 不进入表
    assert!(!map.contains_key("EMPTY_DECL"));
    // root 子元素被跳过
    assert!(!map.contains_key("SKIP_ME"));
    // FIXED_DICT:空 implementedBy → None(不覆盖文本);<of> 元素优先
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
    // FIXED_DICT 无 <Properties> 段 → 空字段表(仍解析为容器)
    match &map["FD_NO_PROPS"] {
        WireType::FixedDict { module, fields } => {
            assert_eq!(module, &Some("X.y".into()));
            assert!(fields.is_empty());
            assert_eq!(map["FD_NO_PROPS"].fixed_size(), Some(0));
        }
        other => panic!("expected FixedDict, got {other:?}"),
    }
    // ARRAY:<of> 元素文本为空 → 过滤为空串;无 of 属性 → 元素未决落 Unresolved
    match &map["ARR_OF_ATTR"] {
        WireType::Array { of } => assert!(matches!(
            **of,
            WireType::Unresolved(ref m) if m == "ARRAY <of> missing"
        )),
        other => panic!("expected Array, got {other:?}"),
    }
    // ARRAY:无 <of> 子元素 → of 属性回落
    match &map["ARR_ATTR_ONLY"] {
        WireType::Array { of } => assert_eq!(**of, WireType::UInt16),
        other => panic!("expected Array, got {other:?}"),
    }
    // 只有 of 属性、无 ARRAY 指引 → 无 directive,整体被跳过
    assert!(!map.contains_key("ARR_BARE"));
    // ARRAY 无 <of> 无 of 属性 → 容器本身已解析,元素落 Unresolved("ARRAY <of> missing")
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
    // <Type> 子元素优先;Type 空 → 首个非 Type 子元素名;两者空 → 文本回落;
    // 全空 → 跳过。alias.xml 可引用 types.xml 里的声明(同一 directive 表)。
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
    // Type 空 → 回落首个非 Type 子元素**名**(UINT16 即引用)
    assert_eq!(map["ALIAS_EMPTY_TYPE"], WireType::UInt16);
    // 文本回落:ALIAS_TEXT → ITEM_ID(跨文件)→ UINT16
    assert_eq!(map["ALIAS_TEXT"], WireType::UInt16);
    assert!(!map.contains_key("ALIAS_SKIP"), "全空指引被跳过");
    // 嵌套 <root> 子元素被跳过
    assert!(!map.contains_key("IGNORED"));
    // types.xml 自身条目同表可见
    assert_eq!(map["ITEM_ID"], WireType::UInt16);

    // 无根(空串)→ 不 panic、表空
    let raw = collect_raw_types("", Some(""));
    assert!(resolve_alias_map(&raw).is_empty());
    // 根缺失文本 → 不 panic
    let raw = collect_raw_types("\u{0}not xml", None);
    assert!(resolve_alias_map(&raw).is_empty());
}

#[test]
fn layout_resolve_ref_paths_and_cycle() {
    // 环:A → B → A;深度限 → "alias cycle" 重命名
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

    // 深限直达:resolve_ref 以 depth > MAX 起步 → Unresolved("depth limit")
    let raw = collect_raw_types("<root><X> UINT8 </X></root>", None);
    let ty = resolve_ref(&raw, "X", MAX_TYPE_DEPTH + 1);
    assert!(matches!(&ty, WireType::Unresolved(m) if m.contains("depth limit")));

    // 未知名 → Unresolved(原名)
    let ty = resolve_ref(&raw, "NOPE", 0);
    assert!(matches!(&ty, WireType::Unresolved(m) if m == "NOPE"));

    // 内建名直接返回
    assert_eq!(resolve_ref(&raw, "STRING", 0), WireType::String);
    // trim 生效
    assert_eq!(resolve_ref(&raw, "  UINT32  ", 0), WireType::UInt32);
}

#[test]
fn layout_fixed_dict_field_missing_type_is_unresolved() {
    // FIXED_DICT 字段无 <Type> → 字段级 Unresolved("{name} <Type> missing"),
    // 不整表失败
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
// layout:实体线格式(merged_def 父/接口/自身)+ 缺失 Type 属性 + 工具函数
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

    // 属性合并序:父 level(先) + 接口 roleId(后) + 自身 name/hp(最后)
    let names: Vec<&str> = info.properties.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["level", "roleId", "name", "hp"]);
    // 同名覆盖:自身 name 覆盖接口/父同名(此处无同名,校验类型)
    assert_eq!(info.properties[2].ty, WireType::String);
    assert_eq!(info.properties[2].flags, vec!["BASE_AND_CLIENT"]);

    // 方法段合并:父 onLevelUp + 自身 requestMove/attack/onDamaged
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
    // 参数线类型求值:VECTOR3 定宽 12
    let rm = &info.base_methods[1];
    assert_eq!(rm.args, vec![WireType::Vector3]);
    assert!(rm.exposed);

    // 缺失 .def → None(调用方落 missing_entities)
    let mut load_none = |_: &str| -> Option<kode_parser::model::DefFile> { None };
    assert!(entity_wire_info("Ghost", &mut load_none, &raw).is_none());
    // 自身 .def 存在但父缺失 → 仍返回自身部分
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
    // 空路径 / ".." 无 file_name 组件 → None
    assert_eq!(def_file_name(Path::new("")), None);
    assert_eq!(def_file_name(Path::new("..")), None);

    // 内建分类口径(与 kode-types 转发一致)
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
// messages(固定表):定长推导 + 项目覆盖 + 坏 id/arg 诊断
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
    // id 唯一的合成表(by_id 语义);引擎表里多组件共用同一 id
    // (Machine::stopserver 与 Loginapp::login 同为 3),by_id 只取首条。
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

    // 引擎表:同名查 id 与定长视图(id 冲突面见上注)
    let engine = build_message_table(&engine_defaults_xml(), None);
    assert_eq!(engine.find("Loginapp::login").unwrap().id, 3);
    assert!(engine.find("Loginapp::login").unwrap().length.is_variable());
    let import = engine.find("Loginapp::importClientMessages").unwrap();
    assert_eq!(import.length.fixed_len(), Some(0));
}

#[test]
fn message_parse_invalid_id_and_args() {
    // 坏 <id>:非数字与超 u16 → 诊断 + 条目丢弃
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
    // 空 arg 文本跳过;非空 UINT16 保留
    let empty = table.find("Good::Empty").unwrap();
    assert_eq!(empty.args, vec![WireType::UInt16]);
    // 未知参数类型 → Unresolved + 诊断
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
    // 引擎基线条目缺 <id>:非项目段记诊断不产条目
    let xml = "<root><NoId::Msg><arg> UINT8 </arg></NoId::Msg></root>";
    let table = build_message_table(xml, None);
    assert!(table.find("NoId::Msg").is_none());
    assert!(table.diagnostics.iter().any(|d| d.contains("missing <id>")));

    // 项目覆盖段(第二参):同名无 id 条目被静默忽略(不诊断)
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
    // 项目覆盖只给 <id>(无 <arg>):保留引擎原参数与长度
    let project = "<root><Loginapp::login><id>77</id></Loginapp::login></root>";
    let table = build_message_table(&engine_defaults_xml(), Some(project));
    let login = table.find("Loginapp::login").unwrap();
    assert_eq!(login.id, 77);
    // 引擎 args(STRING/BLOB/STRING/STRING)保留
    assert_eq!(login.args.len(), 4);
    assert!(matches!(login.args[0], WireType::String));
    assert!(login.length.is_variable(), "保留引擎参数 → 保持变长");

    // 覆盖带 <arg> 则替换参数并重算长度(STRING 参数 → 变长)
    let project = "<root><Loginapp::login><id>78</id><arg> UINT16 </arg></Loginapp::login></root>";
    let table = build_message_table(&engine_defaults_xml(), Some(project));
    let login = table.find("Loginapp::login").unwrap();
    assert_eq!(login.id, 78);
    assert_eq!(login.args, vec![WireType::UInt16]);
    assert_eq!(login.length, MessageLength::Fixed(2));

    // 全新项目条目(表外)正常加入
    let project =
        "<root><Demo::new><id>910</id><arg> UINT32 </arg><arg> FLOAT </arg></Demo::new></root>";
    let table = build_message_table(&engine_defaults_xml(), Some(project));
    let new = table.find("Demo::new").unwrap();
    assert_eq!(new.length, MessageLength::Fixed(8));

    // 覆盖无参定长消息(仅 <id>):保留空参数 → 重算定长 0
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
    // 接口层勘误(§6):仅当 XML 无 <arg> 时套用;含变长参数 → Variable
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

    // XML 已给 <arg> 的条目:勘误不覆盖
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
// compat:全变更类型 + Display + 兼容/不兼容判定
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

    // 消息级破坏:id 漂移 + 长度变 + 参数变;login 删除;新增消息
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
    // 别名:ITEM_ID 删除,LEVEL 布局变
    let mut aliases = BTreeMap::new();
    aliases.insert("LEVEL".into(), WireType::UInt32);
    new.aliases = aliases;
    // 实体:Account 删除,Avatar 属性类型变,新增 Space
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
    // 配置开关变
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
    // 仅新增消息 / 新增实体 / 删除实体 → 兼容(都不破坏旧端解码);
    // 既有消息的 id/长度/参数保持不动。
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
    // 旧实体独有属性(新实体已删)→ SER-13 起显式落账:PropertyRemoved
    // (属性删=合并序漂移,旧端按位解码新流错位;md5 可见 property.cpp:53-64
    // → 握手拒绝)。仍不是 PropertyTypeChanged(类型未动)。
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
    // 变体结构:可直接匹配(诊断/告警面)
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
// builder:项目装配(临时目录)+ 配置标签 + 缺失实体 + 错误面
// ---------------------------------------------------------------------------

#[test]
fn builder_error_display_and_non_project_root() {
    // 非资产根(无 scripts/)→ Err + Display 可读
    let dir = tmp_project("not-root");
    let r = build_schema_from_project(&dir, None, &BuildOptions::default());
    let err = r.unwrap_err();
    let s = format!("{err}");
    assert!(s.contains("kbengine schema build error: not a KBEngine asset root"));
    // std::error::Error 上抛
    let boxed: Box<dyn std::error::Error> = Box::new(err);
    assert!(boxed.to_string().contains("not a KBEngine asset root"));
}

#[test]
fn builder_project_fallback_and_missing_entities() {
    // 项目 res/server/messages_fixed_defaults.xml 兜底(engine 参数 None):
    // 固定表来自项目文件,不产生 not-provided 诊断
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
    // Ghost 已注册但 .def 缺失 → missing_entities(不编造空条目)
    assert_eq!(schema.missing_entities, vec!["Ghost".to_string()]);
    assert!(schema.entities.contains_key("Account"));
    assert!(!schema
        .diagnostics
        .iter()
        .any(|d| d.contains("not provided")));
    assert_eq!(schema.messages.find("Loginapp::hello").unwrap().id, 4);

    // 兜底文件也缺失 → not-provided 诊断 + 固定表 = 空段(不失败)
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
    // 所有消息按变长建模(含原定长 importClientMessages id=5)
    assert!(schema
        .messages
        .find("Loginapp::importClientMessages")
        .unwrap()
        .length
        .is_variable());

    // kbengine_defaults.xml 兜底读取(false 语义):覆盖 kbengine.xml?——顺序:
    // kbengine.xml 先读,defaults 后读可覆盖;此处 defaults 单独生效
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

    // 配置标签缺失 / 空文本 → 引擎默认(false)
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

    // "false"/"no" 语义也走 false 面
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
    // types.xml 为目录 → 读取失败 → 诊断(不 panic),别名字段回退空
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
    // 别名表为空但构建成功(坏文件走诊断不失败)
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
// 汇总:demo 项目真实装配 + 别名/实体/消息三面对拍(与 golden 同源)
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
    // 实体注册 ∩ .def 落盘
    assert!(schema.entities.contains_key("Account"));
    assert!(schema.entities.contains_key("Avatar"));
    // 别名解析链:ITEM_ID→UINT16,ITEM_IDS→ARRAY<ITEM_ID>
    assert_eq!(schema.resolve_alias("ITEM_ID"), Some(&WireType::UInt16));
    assert!(matches!(
        schema.resolve_alias("ITEM_IDS"),
        Some(WireType::Array { of }) if matches!(**of, WireType::UInt16)
    ));
    // 消息表来自引擎默认
    assert_eq!(schema.messages.find("Loginapp::login").unwrap().id, 3);
    // resolve_alias 未知名 → None
    assert_eq!(schema.resolve_alias("NOPE"), None);
}
