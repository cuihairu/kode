//! The PA-002 acceptance unit and behavior tests (red first: written before the implementation).
//!
//! Engine semantics per docs/kbengine-wire-protocol.md (PA-001 evidence, engine baseline
//! bf1a9cd6 / v2.5.10); the fixed message table snapshot is
//! tests/fixtures/messages_fixed_defaults.xml (copied byte for byte from
//! kbe/res/server/messages_fixed_defaults.xml).

use std::path::PathBuf;

use kode_kbengine_schema::{build_schema_from_project, wire::WireType};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn fixture_project() -> PathBuf {
    // Read-only reference to the repository-shared fixture (kbengine-demo-assets = a verbatim
    // snapshot of the official template).
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
// WireType size rules (§3/§3.1)
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
    // STRING: NUL terminated, no prefix (datatype.cpp:1050-1062)
    assert_eq!(WireType::String.fixed_size(), None);
    // UNICODE/BLOB/PYTHON: a u32 prefix (datatype.cpp:1129-1143, 1448-1463)
    assert_eq!(WireType::Unicode.fixed_size(), None);
    assert_eq!(WireType::Blob.fixed_size(), None);
    assert_eq!(WireType::Python.fixed_size(), None);
    // ARRAY: a u32 element-count prefix (datatype.cpp:1837-1856)
    assert_eq!(
        WireType::Array {
            of: Box::new(WireType::UInt32)
        }
        .fixed_size(),
        None
    );
    // FIXED_DICT with all fixed-size fields → fixed size (datatype.cpp:2592+)
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
    // An unknown type is conservatively variable (the decoder keeps it as Raw)
    assert_eq!(WireType::Unresolved("MYSTERY".into()).fixed_size(), None);
    // A recursive fixed dict (a self reference via an alias) → variable once over the limit, no
    // stack overflow
    assert_eq!(WireType::EntityCall.fixed_size(), None);
}

// ---------------------------------------------------------------------------
// The fixed message table (§5.1 + the §4.2 fixed-length derivation)
// ---------------------------------------------------------------------------

#[test]
fn parse_engine_fixed_defaults_table() {
    let table = kode_kbengine_schema::messages::build_message_table(&engine_defaults_xml(), None);

    let login = table.find("Loginapp::login").expect("login exists");
    assert_eq!(login.id, 3);
    // The fixed-table XML semantics: STRING clientType + UINT8_ARRAY blob + STRING account + STRING
    // password
    assert_eq!(login.args.len(), 4);
    assert!(matches!(login.args[0], WireType::String)); // the front-end category (the fixed table's STRING)
    assert!(matches!(login.args[1], WireType::Blob)); // UINT8_ARRAY
                                                      // contains STRING/BLOB → variable length (message_handler.cpp:201-215)
    assert!(login.length.is_variable());

    let import = table
        .find("Loginapp::importClientMessages")
        .expect("import");
    assert_eq!(import.id, 5);
    assert!(import.args.is_empty());
    assert!(!import.length.is_variable()); // fixed 0: no length field on the wire

    let ok = table.find("Client::onLoginSuccessfully").expect("onLogin");
    assert_eq!(ok.id, 502);
    // STRING STRING UINT16 UINT8_ARRAY (§6 step 7); STRING → variable on the wire
    assert!(ok.length.is_variable());

    let hello = table.find("Client::onHelloCB").expect("onHelloCB");
    assert_eq!(hello.id, 521);
    // §6 step 3 (str+str+str+i32, the loginapp.cpp:1361-1377 interface-layer semantics) → variable
    assert!(hello.length.is_variable());
    assert_eq!(hello.args.len(), 4);

    // The hello missing <arg> in the XML: the interface-layer correction (str ver + str script + blob
    // key) → variable
    let hello_up = table.find("Loginapp::hello").unwrap();
    assert!(hello_up.length.is_variable());
    // A parameterless message with no <arg> in the XML and no interface semantics: fixed 0 (no
    // length field on the wire, §4.2-1)
    let import = table.find("Loginapp::importClientMessages").unwrap();
    assert!(!import.length.is_variable());
}

#[test]
fn project_override_replaces_engine_id() {
    let project = "<root>\n  <Loginapp::login>\n    <id>99</id>\n  </Loginapp::login>\n</root>\n";
    let table =
        kode_kbengine_schema::messages::build_message_table(&engine_defaults_xml(), Some(project));
    assert_eq!(table.find("Loginapp::login").unwrap().id, 99);
    // Non-overridden entries keep their engine values
    assert_eq!(table.find("Loginapp::hello").unwrap().id, 4);
}

// ---------------------------------------------------------------------------
// The project Schema build (a real fixture project)
// ---------------------------------------------------------------------------

#[test]
fn build_schema_from_demo_assets_project() {
    let schema = build_schema_from_project(
        &fixture_project(),
        Some(&engine_defaults_xml()),
        &kode_kbengine_schema::BuildOptions::default(),
    )
    .expect("schema build");

    // The entities registered in entities.xml → the .def wire-format entries
    assert!(schema.entities.contains_key("Account"));
    assert!(schema.entities.contains_key("Avatar"));

    // Alias resolution (types.xml): ITEM_ID→UINT16, ITEM_IDS→ARRAY<ITEM_ID>
    let item_id = schema.resolve_alias("ITEM_ID").expect("alias");
    assert!(matches!(item_id, WireType::UInt16));
    let ids = schema.resolve_alias("ITEM_IDS").expect("alias");
    assert!(matches!(&ids, WireType::Array { of } if matches!(**of, WireType::UInt16)));

    // FIXED_DICT: the two SKILL_SLOT fields, the field types nesting an ARRAY
    let slot = schema.resolve_alias("SKILL_SLOT").expect("alias");
    match slot {
        WireType::FixedDict { fields, .. } => {
            let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
            assert_eq!(names, vec!["slot_list", "count"]);
        }
        other => panic!("expected FixedDict, got {other:?}"),
    }

    // The message table comes from the engine fixed defaults (including the six key ones of §5.1)
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
    // A STRING entity property = NUL terminated (datatype.cpp:1050-1062)
    assert!(matches!(name.ty, WireType::String));
    assert_eq!(name.flags, vec!["BASE_AND_CLIENT"]);

    let hp = avatar.properties.iter().find(|p| p.name == "hp").unwrap();
    assert!(matches!(hp.ty, WireType::UInt32));
    assert_eq!(hp.flags, vec!["ALL_CLIENTS"]);

    // The method segments: argument types enter the wire-format IR
    let client_meths: Vec<_> = avatar
        .client_methods
        .iter()
        .map(|m| m.name.as_str())
        .collect();
    assert!(!client_meths.is_empty() || !avatar.base_methods.is_empty());
}

// ---------------------------------------------------------------------------
// Canonical JSON + Hash + the compatibility check
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
    // The SHA-256 hex length
    assert_eq!(a.hash_hex().len(), 64);
    // The JSON deserializes back to the same schema
    let round: kode_kbengine_schema::Schema =
        serde_json::from_str(&ja).expect("schema JSON round-trip");
    assert_eq!(round.hash_hex(), a.hash_hex());
}

#[test]
fn compatibility_report_flags_real_breaks() {
    let opts = kode_kbengine_schema::BuildOptions::default();
    let old =
        build_schema_from_project(&fixture_project(), Some(&engine_defaults_xml()), &opts).unwrap();

    // The new project changes login's fixed id → incompatible
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

    // Recomputing the same input → compatible and no changes
    let same =
        build_schema_from_project(&fixture_project(), Some(&engine_defaults_xml()), &opts).unwrap();
    let report2 = kode_kbengine_schema::compat::check(&old, &same);
    assert!(report2.compatible);
    assert!(report2.changes.is_empty());
}

// ---------------------------------------------------------------------------
// The packetAlwaysContainLength configuration (§4.3)
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
    // The switch on true: every message is modeled as variable on the wire (message_handler.cpp:173-175)
    assert!(schema.packet_always_contain_length);
    let import = schema
        .messages
        .find("Loginapp::importClientMessages")
        .unwrap();
    assert!(import.length.is_variable());
}

// ---------------------------------------------------------------------------
// Robustness: bad input never panics (same rule as SYNTAX-005)
// ---------------------------------------------------------------------------

#[test]
fn bad_inputs_never_panic() {
    let empty_root = std::path::Path::new("/nonexistent/kode-pa002-probe");
    let r = build_schema_from_project(
        empty_root,
        Some("<root><Broken"),
        &kode_kbengine_schema::BuildOptions::default(),
    );
    // Must return an Err (a diagnosable one); panics/unwrap crashes are not allowed
    assert!(r.is_err());

    let garbage = "\u{0}\u{1}not xml at all <<< >>>";
    let ok = build_schema_from_project(
        &fixture_project(),
        Some(garbage),
        &kode_kbengine_schema::BuildOptions::default(),
    );
    // A garbage fixed table: the engine's notFoundError=true semantics → the parsing is
    // tolerant, the table may end up empty but never panics
    assert!(ok.is_ok() || ok.is_err());
}
