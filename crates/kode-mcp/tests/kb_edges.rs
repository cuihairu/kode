//! AssetKnowledge 边缘面:线格式编解码全布局、组件递归、拓扑清单联动、
//! 装载容错(不可读 def/目录/非 UTF-8 文件名)、别名装载与诊断、搜索截断。
//!
//! 主路径在 tests/units.rs(真实 kbengine-demo-assets);这里用合成根 +
//! 真实夹具补齐纯逻辑面里语料没有走到的分支。

use kode_mcp::AssetKnowledge;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

fn fixture_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // crates/kode-mcp → crates
    p.pop(); // crates → workspace 根
    p.push("tests/fixtures/kbengine-demo-assets");
    p
}

fn temp_root(tag: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("kode-mcp-{}-{tag}-{seq}", std::process::id()));
    let defs = root.join("scripts/entity_defs");
    std::fs::create_dir_all(&defs).unwrap();
    root
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

/// 全标量布局别名 + FIXED_DICT + ARRAY + VECTOR3 + 断链别名,驱动
/// wire_from_json 的每个布局分支与其错误分支。
fn rich_types_xml() -> &'static str {
    "<root>\n\t<T_U8> UINT8 </T_U8>\n\t<T_U16> UINT16 </T_U16>\n\t<T_U32> UINT32 </T_U32>\n\t<T_U64> UINT64 </T_U64>\n\t<T_I8> INT8 </T_I8>\n\t<T_I16> INT16 </T_I16>\n\t<T_I32> INT32 </T_I32>\n\t<T_I64> INT64 </T_I64>\n\t<T_F32> FLOAT </T_F32>\n\t<T_F64> DOUBLE </T_F64>\n\t<T_BOOL> BOOL </T_BOOL>\n\t<T_STR> STRING </T_STR>\n\t<T_UNI> UNICODE </T_UNI>\n\t<T_BLOB> BLOB </T_BLOB>\n\t<V3> VECTOR3 </V3>\n\t<FD>\n\t\tFIXED_DICT\n\t\t<Properties>\n\t\t\t<a>\n\t\t\t\t<Type> UINT32 </Type>\n\t\t\t</a>\n\t\t\t<b>\n\t\t\t\t<Type> T_U8 </Type>\n\t\t\t</b>\n\t\t</Properties>\n\t</FD>\n\t<ARR>\n\t\tARRAY\n\t\t<of> T_U32 </of>\n\t</ARR>\n\t<DANGLING> NOWHERE </DANGLING>\n</root>\n"
}

#[test]
fn wire_roundtrips_every_scalar_layout_with_plain_json() {
    let root = temp_root("scalar");
    write(&root, "scripts/entity_defs/types.xml", rich_types_xml());
    let kb = AssetKnowledge::load(&root);

    let cases: Vec<(&str, Value)> = vec![
        ("T_U8", json!(7)),
        ("T_U16", json!(700)),
        ("T_U32", json!(70_000)),
        ("T_U64", json!(5_000_000_000u64)),
        ("T_I8", json!(-7)),
        ("T_I16", json!(-700)),
        ("T_I32", json!(-70_000)),
        ("T_I64", json!(-5_000_000_000i64)),
        ("T_F32", json!(1.5)),
        ("T_F64", json!(-2.25)),
        ("T_BOOL", json!(true)),
        ("T_STR", json!("hello")),
        ("T_UNI", json!("你好")),
        ("T_BLOB", json!("bytes-here")),
    ];
    for (type_name, value) in cases {
        let sample = kb
            .encode_decode_sample(type_name, &value)
            .unwrap_or_else(|e| {
                panic!("{type_name} roundtrip failed: {e}");
            });
        assert_eq!(sample["type"], type_name);
        assert!(sample["byteLen"].as_u64().unwrap() > 0);
        // 回解码是带标签 serde 形状,与输入语义一致。
        let decoded = &sample["decoded"];
        let tagged_ok = decoded.as_object().is_some();
        assert!(tagged_ok, "{type_name} decoded shape: {decoded}");
    }
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn wire_accepts_tagged_form_and_reports_payload_mismatch() {
    let root = temp_root("tagged");
    write(&root, "scripts/entity_defs/types.xml", rich_types_xml());
    let kb = AssetKnowledge::load(&root);

    // 带标签形式直取 WireValue 变体(与布局一致时编码成功)。
    for (type_name, tagged) in [
        ("T_U8", json!({"U8": 5})),
        ("T_U16", json!({"U16": 5})),
        ("T_U32", json!({"U32": 5})),
        ("T_U64", json!({"U64": 5})),
        ("T_I8", json!({"I8": -5})),
        ("T_I16", json!({"I16": -5})),
        ("T_I32", json!({"I32": -5})),
        ("T_I64", json!({"I64": -5})),
        ("T_F32", json!({"F32": 1.5})),
        ("T_F64", json!({"F64": -1.5})),
        ("T_BOOL", json!({"Bool": true})),
        ("T_STR", json!({"Str": "hi"})),
    ] {
        assert!(
            kb.encode_decode_sample(type_name, &tagged).is_ok(),
            "{type_name} tagged {tagged} should roundtrip"
        );
    }
    // 带标签但载荷类型不符 → 明确报错,不猜测。
    assert!(kb
        .encode_decode_sample("T_U8", &json!({"U8": "x"}))
        .is_err());
    // 带未知标签的对象 → serde 兜底失败并如实报错。
    assert!(kb
        .encode_decode_sample("T_U8", &json!({"NoSuchTag": {"x": 1}}))
        .is_err());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn wire_reports_structural_mismatches_precisely() {
    let root = temp_root("mismatch");
    write(&root, "scripts/entity_defs/types.xml", rich_types_xml());
    let kb = AssetKnowledge::load(&root);

    // 标量布局配错型值。
    assert!(kb.encode_decode_sample("T_U8", &json!("nope")).is_err());
    assert!(kb.encode_decode_sample("T_I8", &json!(1.5)).is_err());
    assert!(kb.encode_decode_sample("T_F32", &json!(false)).is_err());
    assert!(kb.encode_decode_sample("T_BOOL", &json!(1)).is_err());
    assert!(kb.encode_decode_sample("T_STR", &json!(42)).is_err());
    // FIXED_DICT:非对象 / 缺字段。
    assert!(kb.encode_decode_sample("FD", &json!(5)).is_err());
    assert!(kb.encode_decode_sample("FD", &json!({"a": 1})).is_err());
    // FD 全字段成功(嵌套布局:字段 b 是 T_U8 别名)。
    assert!(kb
        .encode_decode_sample("FD", &json!({"a": 1, "b": 2}))
        .is_ok());
    // ARRAY:非数组 / 元素型错误 / 正常数组。
    assert!(kb.encode_decode_sample("ARR", &json!(5)).is_err());
    assert!(kb.encode_decode_sample("ARR", &json!([1, "x"])).is_err());
    assert!(kb.encode_decode_sample("ARR", &json!([1, 2, 3])).is_ok());
    // VECTOR3 等结构布局不支持朴素 JSON 输入,要求带标签形式。
    let err = kb
        .encode_decode_sample("V3", &json!({"x": 1.0}))
        .unwrap_err();
    assert!(
        err.contains("not supported") || err.contains("tagged"),
        "{err}"
    );
    // 断链别名:解析期就报错。
    assert!(kb.encode_decode_sample("DANGLING", &json!(1)).is_err());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn component_slots_walk_deep_and_skip_untyped_slots() {
    let kb = AssetKnowledge::load(&fixture_root());
    // Avatar 有 bag → Inventory 组件;Inventory def 本体存在 → 递归解析出 file 与子组件表。
    let model = kb.get_entity_model("Avatar").unwrap();
    let ownership = &model["processOwnership"];
    assert!(!ownership["componentTypes"].as_array().unwrap().is_empty());
    let slot = &ownership["componentTypes"][0];
    assert_eq!(slot["slot"], "bag");
    assert_eq!(slot["type"], "Inventory");
    assert!(slot["file"].as_str().unwrap().contains("Inventory"));
    // 组件 def 自身没有更深的组件 → componentTypes 为空数组(递归基例)。
    assert_eq!(slot["componentTypes"].as_array().unwrap().len(), 0);

    // 无 <Type> 的组件槽:跳过,不 panic(合成根验证)。
    let root = temp_root("untyped-slot");
    write(
        &root,
        "scripts/entity_defs/Bare.def",
        "<root>\n\t<Components>\n\t\t<mystery>\n\t\t</mystery>\n\t</Components>\n</root>\n",
    );
    let local = AssetKnowledge::load(&root);
    let model = local.get_entity_model("Bare").unwrap();
    assert!(model["processOwnership"]["componentTypes"]
        .as_array()
        .unwrap()
        .is_empty());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn search_truncates_at_limit_and_counts_all_defs() {
    let kb = AssetKnowledge::load(&fixture_root());
    let limited = kb.search_entities("monster", 1);
    assert_eq!(limited["matches"].as_array().unwrap().len(), 1);
    assert!(
        limited["totalDefs"].as_u64().unwrap() > 1,
        "totalDefs 是全量 def 数,不受 limit 影响"
    );
}

#[test]
fn message_entry_without_filter_returns_full_table() {
    let kb = AssetKnowledge::load(&fixture_root());
    let all = kb.get_message_entry("Account", None).unwrap();
    assert_eq!(all["entity"], "Account");
    // loadFailed 是布尔、issues 是数组(同源形状契约)。
    assert!(all["loadFailed"].is_boolean());
    assert!(all["issues"].is_array());
    assert!(!all["entries"].as_array().unwrap().is_empty());
    let filtered = kb
        .get_message_entry("Account", Some("reqCreateAvatar"))
        .unwrap();
    assert!(
        filtered["entries"].as_array().unwrap().len() <= all["entries"].as_array().unwrap().len()
    );
}

#[test]
fn validate_defs_reports_def_and_types_diagnostics_and_runs_topology() {
    let root = temp_root("diag");
    // types.xml 带语法错(内层错闭合)→ 解析诊断。
    write(
        &root,
        "scripts/entity_defs/types.xml",
        "<root>\n\t<T_U16> UINT16 </T_U8>\n</root>\n",
    );
    // def 带语法错(Type 未闭合)→ 解析诊断。
    write(
        &root,
        "scripts/entity_defs/Broken.def",
        "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </hp>\n\t\t</Type>\n\t</Properties>\n</root>\n",
    );
    // 带 cell 内容的实体 + entities.xml 注册 → 单 loginapp 拓扑必产生角色缺发现。
    write(
        &root,
        "scripts/entity_defs/CellOnly.def",
        "<root>\n\t<CellMethods>\n\t\t<onUpdate>\n\t\t\t<Arg> UINT32 </Arg>\n\t\t</onUpdate>\n\t</CellMethods>\n</root>\n",
    );
    write(
        &root,
        "scripts/entities.xml",
        "<root>\n\t<CellOnly hasCell=\"true\"></CellOnly>\n</root>\n",
    );
    let kb = AssetKnowledge::load(&root);
    let findings = kb.validate_defs(None)["findings"]
        .as_array()
        .unwrap()
        .clone();
    assert!(
        findings
            .iter()
            .any(|f| f["file"].as_str().unwrap().contains("Broken.def")),
        "def 诊断带文件名: {findings:?}"
    );
    assert!(
        findings
            .iter()
            .any(|f| f["file"] == "scripts/entity_defs/types.xml"),
        "types.xml 诊断带固定相对路径: {findings:?}"
    );

    // 可读清单 → 进程拓扑校验执行(缺 cellapp 角色等发现进 processTopology)。
    write(
        &root,
        "manifest.xml",
        "<topology>\n\t<process name=\"loginapp\" role=\"loginapp\"/>\n</topology>\n",
    );
    let manifest = root.join("manifest.xml").to_string_lossy().to_string();
    let out = kb.validate_defs(Some(&manifest));
    assert!(
        !out["processTopology"].as_array().unwrap().is_empty(),
        "单 loginapp 拓扑应产生角色缺发现: {out}"
    );
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn type_graph_carries_alias_and_element_edges_with_diagnostics() {
    let root = temp_root("graph");
    write(
        &root,
        "scripts/entity_defs/alias.xml",
        "<root>\n\t<Hp>\n\t\t<Type> UINT32 </Type>\n\t</Hp>\n</root>\n",
    );
    write(&root, "scripts/entity_defs/types.xml", rich_types_xml());
    let kb = AssetKnowledge::load(&root);
    let graph = kb.get_type_graph();

    // alias.xml 装载:aliases 列表 + 别名边。
    assert!(graph["aliases"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["name"] == "Hp"));
    assert!(graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["from"] == "Hp" && e["kind"] == "alias"));
    // types.xml 别名边(T_U8 → UINT8 等 builtin directive)与数组元素边。
    let edges = graph["edges"].as_array().unwrap();
    assert!(edges
        .iter()
        .any(|e| e["from"] == "T_U8" && e["to"] == "UINT8"));
    assert!(edges
        .iter()
        .any(|e| e["from"] == "ARR" && e["kind"] == "element" && e["to"] == "T_U32"));
    // FD 字段边。
    assert!(edges
        .iter()
        .any(|e| e["from"] == "FD" && e["kind"] == "field" && e["to"] == "T_U8"));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn load_tolerates_unreadable_files_dirs_and_non_utf8_names() {
    use std::os::unix::fs::PermissionsExt;

    let root = temp_root("tolerant");
    write(&root, "scripts/entity_defs/Good.def", "<root></root>\n");
    // 不可读的 def 文件 → 记 load_errors,不中断。
    let locked_def = root.join("scripts/entity_defs/Locked.def");
    std::fs::write(&locked_def, "<root></root>\n").unwrap();
    std::fs::set_permissions(&locked_def, std::fs::Permissions::from_mode(0o000)).unwrap();
    // 不可读子目录 → 记 load_errors。
    let locked_dir = root.join("scripts/entity_defs/locked_dir");
    std::fs::create_dir_all(&locked_dir).unwrap();
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
    // 非 UTF-8 文件名 → 跳过。
    use std::os::unix::ffi::OsStrExt;
    let weird = root
        .join("scripts/entity_defs")
        .join(std::ffi::OsStr::from_bytes(&[0xff, b'.', b'd', b'e', b'f']));
    std::fs::write(&weird, b"<root></root>").unwrap();

    let kb = AssetKnowledge::load(&root);
    assert!(kb.defs.contains_key("Good"));
    assert!(!kb.defs.contains_key("Locked"));
    assert!(
        kb.load_errors.iter().any(|e| e.contains("Locked.def")),
        "{:?}",
        kb.load_errors
    );
    assert!(
        kb.load_errors.iter().any(|e| e.contains("locked_dir")),
        "{:?}",
        kb.load_errors
    );

    // 恢复权限以便清理。
    std::fs::set_permissions(&locked_def, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}
