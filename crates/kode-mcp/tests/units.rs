//! kode-mcp 同源单测(MCP-001):AssetKnowledge 纯逻辑面,夹具用
//! kbengine-demo-assets(实体/接口/组件/types.xml FIXED_DICT+ARRAY 齐)。
//!
//! 覆盖:装载面(def 全收+接口归类+容错不 panic)、search_entities 名/标签
//! 双路、get_entity_model 全模型(Flags 域/进程归属/组件)、get_type_graph
//! (别名/数组/FIXED_DICT+边)、validate_defs(净夹具零发现+拓扑清单联动)、
//! get_message_entry(kode-server C-15 同源直调)、encode_decode_sample
//! (hex+回解码)、db_schema_preview(C-16 同源直调)。

use std::path::PathBuf;

use kode_mcp::AssetKnowledge;
use serde_json::Value;

fn fixture_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // crates/kode-mcp → crates
    p.pop(); // crates → workspace 根
    p.push("tests/fixtures/kbengine-demo-assets");
    p
}

fn kb() -> AssetKnowledge {
    AssetKnowledge::load(&fixture_root())
}

#[test]
fn loads_defs_with_categories_and_tolerates_missing_dirs() {
    let knowledge = kb();
    // demo-assets 主体实体 + 接口 + 组件都在。
    for name in ["Avatar", "Monster", "Account", "TrainingAvatar"] {
        assert!(knowledge.defs.contains_key(name), "missing {name}");
    }
    assert_eq!(knowledge.defs["ROLE"].category, "interface");
    assert_eq!(knowledge.defs["Inventory"].category, "component");
    assert_eq!(knowledge.defs["Avatar"].category, "entity");
    assert!(knowledge.types_text.is_some(), "types.xml loaded");
    // 不存在的根=空库不 panic。
    let empty = AssetKnowledge::load(std::path::Path::new("/definitely/not/a/root"));
    assert!(empty.defs.is_empty());
    assert!(!empty
        .search_entities("Avatar", 20)
        .to_string()
        .contains("Avatar"));
}

#[test]
fn search_entities_matches_names_and_tags() {
    let knowledge = kb();
    // 按名:子串大小写不敏感。
    let by_name = knowledge.search_entities("avatar", 20);
    let names: Vec<&str> = by_name["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Avatar"));
    assert!(names.contains(&"TrainingAvatar"));
    // 审核发现:旧断言 `!contains || contains` 恒真,零覆盖。按查询语义
    // "avatar" 不命中 TrainingMonster——如实断言不命中。
    assert!(!names.contains(&"TrainingMonster"), "{names:?}");
    // 按标签:属性名命中,matchedTags 非空。
    let by_tag = knowledge.search_entities("accountName", 20);
    let first = &by_tag["matches"].as_array().unwrap()[0];
    assert_eq!(first["name"], "Account");
    assert_eq!(first["nameMatch"], false);
    assert_eq!(first["matchedTags"][0]["name"], "accountName");
}

#[test]
fn entity_model_carries_flags_domains_and_process_ownership() {
    let knowledge = kb();
    let model = knowledge.get_entity_model("Account").unwrap();
    let account_name = &model["properties"][0];
    assert_eq!(account_name["name"], "accountName");
    assert_eq!(account_name["type"], "STRING");
    assert_eq!(
        account_name["flags"].as_array().unwrap()[0],
        "BASE_AND_CLIENT"
    );
    assert!(account_name["domains"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d == "base"));
    assert!(account_name["domains"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d == "client"));
    // 方法分节带 section 标记。
    let base = model["baseMethods"].as_array().unwrap();
    assert!(base
        .iter()
        .any(|m| m["name"] == "reqCreateAvatar" && m["exposed"] == true));
    // 未知实体=错误串(工具层转 is_error 结果)。
    assert!(knowledge.get_entity_model("NoSuchEntity").is_err());
}

#[test]
fn type_graph_resolves_alias_array_and_fixed_dict() {
    let knowledge = kb();
    let graph = knowledge.get_type_graph();
    let find = |name: &str| -> Value {
        graph["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("type {name} missing"))
    };
    let slot = find("SKILL_SLOT");
    assert_eq!(slot["kind"], "FixedDict");
    assert!(slot["fieldRefs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "UINT32"));
    // 别名链(alias.xml 或 types.xml 别名)进边。
    let alias_names: Vec<&str> = graph["aliases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert!(
        alias_names.contains(&"ITEM_ID")
            || graph["edges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["from"] == "ITEM_ID")
    );
}

#[test]
fn validate_defs_clean_fixture_zero_findings_and_topology_hook() {
    let knowledge = kb();
    let plain = knowledge.validate_defs(None);
    assert!(
        plain["findings"].as_array().unwrap().is_empty(),
        "clean fixture must validate clean"
    );
    // 拓扑清单不可读=如实归 finding(不 panic、不静默)。
    let broken = knowledge.validate_defs(Some("/definitely/not/manifest.xml"));
    let findings = broken["findings"].as_array().unwrap();
    assert!(findings.iter().any(|f| f["code"] == "ManifestUnreadable"));
}

#[test]
fn message_entry_same_source_with_kode_server() {
    let knowledge = kb();
    let table = knowledge
        .get_message_entry("Account", Some("reqCreateAvatar"))
        .unwrap();
    let entries = table["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert!(entry["name"].as_str().unwrap().contains("reqCreateAvatar"));
    assert!(entry["utype"].is_i64() || entry["utype"].is_null() || entry["utype"].is_u64());
    // 方法过滤不命中=空 entries 而非错误。
    let none = knowledge
        .get_message_entry("Account", Some("noSuchMethod"))
        .unwrap();
    assert!(none["entries"].as_array().unwrap().is_empty());
    assert!(knowledge.get_message_entry("NoSuchEntity", None).is_err());
}

#[test]
fn wire_sample_roundtrips_alias_type() {
    let knowledge = kb();
    // ITEM_ID 是 types.xml 别名(UINT16)——hex 长度与回解码自洽。
    let sample = knowledge
        .encode_decode_sample("ITEM_ID", &serde_json::json!(7))
        .unwrap();
    assert_eq!(sample["type"], "ITEM_ID");
    assert_eq!(sample["byteLen"], 2);
    let hex_str = sample["hex"].as_str().unwrap();
    assert_eq!(hex_str, "0700");
    // 回解码是 WireValue 的带标签 serde 形状(往返无损)。
    assert_eq!(sample["decoded"], serde_json::json!({"U16": 7}));
    // 未知类型=错误串。
    assert!(knowledge
        .encode_decode_sample("NO_SUCH_TYPE", &serde_json::json!(1))
        .is_err());
}

#[test]
fn db_schema_preview_derives_persistent_tables() {
    let knowledge = kb();
    let preview = knowledge.db_schema_preview(Some("Account")).unwrap();
    let tables = preview["tables"].as_array().unwrap();
    assert!(
        tables
            .iter()
            .any(|t| t["name"] == "Account" && t["kind"] == "entity"),
        "root table Account expected, got: {tables:?}"
    );
    // 未知实体=错误串。
    assert!(knowledge.db_schema_preview(Some("NoSuchEntity")).is_err());
    // 全量模式可用(每个实体都出表)。
    let all = knowledge.db_schema_preview(None).unwrap();
    assert!(all["tables"].as_array().unwrap().len() >= tables.len());
}
