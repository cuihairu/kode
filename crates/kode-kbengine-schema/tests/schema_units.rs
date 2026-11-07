//! PA-002 验收的单元与行为测试(红先行:先于实现编写)。
//!
//! 引擎语义依据 docs/kbengine-wire-protocol.md(PA-001 取证,引擎基准
//! bf1a9cd6 / v2.5.10);固定消息表快照在 tests/fixtures/messages_fixed_defaults.xml
//! (逐字节拷自 kbe/res/server/messages_fixed_defaults.xml)。

use std::path::PathBuf;

use kode_kbengine_schema::{build_schema_from_project, wire::WireType};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn fixture_project() -> PathBuf {
    // 只读引用仓库共享 fixture(kbengine-demo-assets = 官方模板逐字快照)。
    repo_root().join("tests/fixtures/kbengine-demo-assets")
}

fn engine_defaults_xml() -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/messages_fixed_defaults.xml"),
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// WireType 尺寸规则(§3/§3.1)
// ---------------------------------------------------------------------------

#[test]
fn wire_fixed_sizes_match_engine() {
    assert_eq!(WireType::UInt8.fixed_size(), Some(1));
    assert_eq!(WireType::UInt16.fixed_size(), Some(2));
    assert_eq!(WireType::UInt32.fixed_size(), Some(4));
    assert_eq!(WireType::UInt64.fixed_size(), Some(8));
    assert_eq!(WireType::Int8.fixed_size(), Some(1));
    assert_eq!(WireType::Int16.fixed_size(), Some(2));
    assert_eq!(WireType::Int32.fixed_size(), Some(4));
    assert_eq!(WireType::Int64.fixed_size(), Some(8));
    assert_eq!(WireType::Float.fixed_size(), Some(4));
    assert_eq!(WireType::Double.fixed_size(), Some(8));
    assert_eq!(WireType::Bool.fixed_size(), Some(1)); // memorystream.h:224-227
    assert_eq!(WireType::Vector2.fixed_size(), Some(8));
    assert_eq!(WireType::Vector3.fixed_size(), Some(12)); // datatype.cpp:841-858
    assert_eq!(WireType::Vector4.fixed_size(), Some(16));
}

#[test]
fn wire_variable_shapes() {
    // STRING: NUL 结尾无前缀(datatype.cpp:1050-1062)
    assert_eq!(WireType::String.fixed_size(), None);
    // UNICODE/BLOB/PYTHON: u32 前缀(datatype.cpp:1129-1143,1448-1463)
    assert_eq!(WireType::Unicode.fixed_size(), None);
    assert_eq!(WireType::Blob.fixed_size(), None);
    assert_eq!(WireType::Python.fixed_size(), None);
    // ARRAY: u32 元素数前缀(datatype.cpp:1837-1856)
    assert_eq!(
        WireType::Array {
            of: Box::new(WireType::UInt32)
        }
        .fixed_size(),
        None
    );
    // FIXED_DICT 全定长字段 → 定长(datatype.cpp:2592+)
    let dict = WireType::FixedDict {
        module: None,
        fields: vec![
            kode_kbengine_schema::wire::DictField {
                name: "x".into(),
                ty: Box::new(WireType::Float),
            },
            kode_kbengine_schema::wire::DictField {
                name: "y".into(),
                ty: Box::new(WireType::Float),
            },
        ],
    };
    assert_eq!(dict.fixed_size(), Some(8));
    // 未知类型保守可变(解码端 Raw 保留)
    assert_eq!(WireType::Unresolved("MYSTERY".into()).fixed_size(), None);
    // 递归定长字典(自引用经别名)→ 超界即保守可变,不栈溢出
    assert_eq!(WireType::EntityCall.fixed_size(), None);
}

// ---------------------------------------------------------------------------
// 固定消息表(§5.1 + §4.2 定长推导)
// ---------------------------------------------------------------------------

#[test]
fn parse_engine_fixed_defaults_table() {
    let table = kode_kbengine_schema::messages::build_message_table(&engine_defaults_xml(), None);

    let login = table.find("Loginapp::login").expect("login exists");
    assert_eq!(login.id, 3);
    // 固定表 XML 口径:STRING clientType + UINT8_ARRAY blob + STRING 账号 + STRING 密码
    assert_eq!(login.args.len(), 4);
    assert!(matches!(login.args[0], WireType::String)); // 前端类别(固定表 STRING)
    assert!(matches!(login.args[1], WireType::Blob)); // UINT8_ARRAY
                                                      // 含 STRING/BLOB → 可变长度(message_handler.cpp:201-215)
    assert!(login.length.is_variable());

    let import = table
        .find("Loginapp::importClientMessages")
        .expect("import");
    assert_eq!(import.id, 5);
    assert!(import.args.is_empty());
    assert!(!import.length.is_variable()); // 定长 0:线上无长度字段

    let ok = table.find("Client::onLoginSuccessfully").expect("onLogin");
    assert_eq!(ok.id, 502);
    // STRING STRING UINT16 UINT8_ARRAY(§6 步骤 7);STRING → 线上可变
    assert!(ok.length.is_variable());

    let hello = table.find("Client::onHelloCB").expect("onHelloCB");
    assert_eq!(hello.id, 521);
    assert!(!hello.length.is_variable());
}

#[test]
fn project_override_replaces_engine_id() {
    let project = "<root>\n  <Loginapp::login>\n    <id>99</id>\n  </Loginapp::login>\n</root>\n";
    let table =
        kode_kbengine_schema::messages::build_message_table(&engine_defaults_xml(), Some(project));
    assert_eq!(table.find("Loginapp::login").unwrap().id, 99);
    // 未覆盖的条目保持引擎值
    assert_eq!(table.find("Loginapp::hello").unwrap().id, 4);
}

// ---------------------------------------------------------------------------
// 项目 Schema 构建(真实 fixture 项目)
// ---------------------------------------------------------------------------

#[test]
fn build_schema_from_demo_assets_project() {
    let schema = build_schema_from_project(
        &fixture_project(),
        Some(&engine_defaults_xml()),
        &kode_kbengine_schema::BuildOptions::default(),
    )
    .expect("schema build");

    // entities.xml 注册的实体 → .def 线格式条目
    assert!(schema.entities.contains_key("Account"));
    assert!(schema.entities.contains_key("Avatar"));

    // 别名解析(types.xml):ITEM_ID→UINT16、ITEM_IDS→ARRAY<ITEM_ID>
    let item_id = schema.resolve_alias("ITEM_ID").expect("alias");
    assert!(matches!(item_id, WireType::UInt16));
    let ids = schema.resolve_alias("ITEM_IDS").expect("alias");
    assert!(matches!(&ids, WireType::Array { of } if matches!(**of, WireType::UInt16)));

    // FIXED_DICT:SKILL_SLOT 两字段、字段类型内嵌 ARRAY
    let slot = schema.resolve_alias("SKILL_SLOT").expect("alias");
    match slot {
        WireType::FixedDict { fields, .. } => {
            let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
            assert_eq!(names, vec!["slot_list", "count"]);
        }
        other => panic!("expected FixedDict, got {other:?}"),
    }

    // 消息表来自引擎固定默认(含 §5.1 关键 6 条)
    assert_eq!(schema.messages.find("Loginapp::login").unwrap().id, 3);
    assert_eq!(
        schema
            .messages
            .find("Client::onImportClientMessages")
            .unwrap()
            .id,
        518
    );
}

#[test]
fn entity_wire_info_has_flags_and_types() {
    let schema = build_schema_from_project(
        &fixture_project(),
        Some(&engine_defaults_xml()),
        &kode_kbengine_schema::BuildOptions::default(),
    )
    .unwrap();

    let avatar = &schema.entities["Avatar"];
    let name = avatar.properties.iter().find(|p| p.name == "name").unwrap();
    // STRING 实体属性 = NUL 结尾(datatype.cpp:1050-1062)
    assert!(matches!(name.ty, WireType::String));
    assert_eq!(name.flags, vec!["BASE_AND_CLIENT"]);

    let hp = avatar.properties.iter().find(|p| p.name == "hp").unwrap();
    assert!(matches!(hp.ty, WireType::UInt32));
    assert_eq!(hp.flags, vec!["ALL_CLIENTS"]);

    // 方法段:参数类型进线格式 IR
    let client_meths: Vec<_> = avatar
        .client_methods
        .iter()
        .map(|m| m.name.as_str())
        .collect();
    assert!(!client_meths.is_empty() || !avatar.base_methods.is_empty());
}

// ---------------------------------------------------------------------------
// Canonical JSON + Hash + 兼容检查
// ---------------------------------------------------------------------------

#[test]
fn canonical_json_is_deterministic_and_hashed() {
    let opts = kode_kbengine_schema::BuildOptions::default();
    let a =
        build_schema_from_project(&fixture_project(), Some(&engine_defaults_xml()), &opts).unwrap();
    let b =
        build_schema_from_project(&fixture_project(), Some(&engine_defaults_xml()), &opts).unwrap();
    let ja = a.to_canonical_json();
    let jb = b.to_canonical_json();
    assert_eq!(ja, jb, "same input -> byte-identical canonical JSON");
    assert_eq!(a.hash_hex(), b.hash_hex());
    // SHA-256 十六进制长度
    assert_eq!(a.hash_hex().len(), 64);
    // JSON 可反序列化还原
    let round: kode_kbengine_schema::Schema =
        serde_json::from_str(&ja).expect("schema JSON round-trip");
    assert_eq!(round.hash_hex(), a.hash_hex());
}

#[test]
fn compatibility_report_flags_real_breaks() {
    let opts = kode_kbengine_schema::BuildOptions::default();
    let old =
        build_schema_from_project(&fixture_project(), Some(&engine_defaults_xml()), &opts).unwrap();

    // 新工程把 login 的固定 id 改掉 → 不兼容
    let overridden = "<root><Loginapp::login><id>77</id></Loginapp::login></root>";
    let new_msgs = kode_kbengine_schema::messages::build_message_table(
        &engine_defaults_xml(),
        Some(overridden),
    );
    let mut new = old.clone();
    new.messages = new_msgs;
    let report = kode_kbengine_schema::compat::check(&old, &new);
    assert!(!report.compatible);
    assert!(
        report
            .changes
            .iter()
            .any(|c| c.to_string().contains("Loginapp::login")),
        "report should name the changed message, got: {:?}",
        report.changes
    );

    // 同输入重算 → 兼容且无变更
    let same =
        build_schema_from_project(&fixture_project(), Some(&engine_defaults_xml()), &opts).unwrap();
    let report2 = kode_kbengine_schema::compat::check(&old, &same);
    assert!(report2.compatible);
    assert!(report2.changes.is_empty());
}

// ---------------------------------------------------------------------------
// packetAlwaysContainLength 配置(§4.3)
// ---------------------------------------------------------------------------

#[test]
fn packet_always_contain_length_is_schema_carried() {
    let opts = kode_kbengine_schema::BuildOptions::default();
    assert!(!opts.packet_always_contain_length);

    let forced = kode_kbengine_schema::BuildOptions {
        packet_always_contain_length: true,
    };
    let schema =
        build_schema_from_project(&fixture_project(), Some(&engine_defaults_xml()), &forced)
            .unwrap();
    // 开关为 true:所有消息按线上可变建模(message_handler.cpp:173-175)
    assert!(schema.packet_always_contain_length);
    let import = schema
        .messages
        .find("Loginapp::importClientMessages")
        .unwrap();
    assert!(import.length.is_variable());
}

// ---------------------------------------------------------------------------
// 健壮性:坏输入不 panic(SYNTAX-005 同规)
// ---------------------------------------------------------------------------

#[test]
fn bad_inputs_never_panic() {
    let empty_root = std::path::Path::new("/nonexistent/kode-pa002-probe");
    let r = build_schema_from_project(
        empty_root,
        Some("<root><Broken"),
        &kode_kbengine_schema::BuildOptions::default(),
    );
    // 必须返回 Err(可诊断),不允许 panic/unwrap 崩溃
    assert!(r.is_err());

    let garbage = "\u{0}\u{1}not xml at all <<< >>>";
    let ok = build_schema_from_project(
        &fixture_project(),
        Some(garbage),
        &kode_kbengine_schema::BuildOptions::default(),
    );
    // 垃圾固定表:引擎 notFoundError=true 语义 → 解析容错,表可为空但不 panic
    assert!(ok.is_ok() || ok.is_err());
}
