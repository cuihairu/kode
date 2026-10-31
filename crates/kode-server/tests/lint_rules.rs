//! 每规则单测:fixture 正例/反例各一。走 `analyze_def`(公共面,与 RPC
//! handler 同口径),按 check 码断言命中/不命中。

use kode_server::lint::analyze_def;

fn checks(text: &str) -> Vec<String> {
    analyze_def(text, &Default::default(), &[])
        .expect("analyze_def ok")
        .into_iter()
        .map(|f| f.check.to_string())
        .collect()
}

fn checks_with_known(text: &str, known: &[&str]) -> Vec<String> {
    analyze_def(text, &Default::default(), known)
        .expect("analyze_def ok")
        .into_iter()
        .map(|f| f.check.to_string())
        .collect()
}

fn prop(name: &str, inner: &str) -> String {
    format!(
        "<root>\n\t<Properties>\n\t\t<{name}>\n{inner}\t\t</{name}>\n\t</Properties>\n</root>\n"
    )
}

const PHANTOM_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>BOOL</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
const CLEAN_PROP: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";

#[test]
fn phantom_type_fires_on_engine_unregistered_name_and_not_on_builtin() {
    assert!(checks(PHANTOM_DEF).contains(&"phantom-type".to_string()));
    assert!(!checks(CLEAN_PROP).contains(&"phantom-type".to_string()));
}

#[test]
fn missing_type_fires_without_type_and_not_with_type() {
    let no_type = prop("hp", "\t\t\t<Flags>BASE</Flags>\n");
    assert!(checks(&no_type).contains(&"missing-type".to_string()));
    assert!(!checks(CLEAN_PROP).contains(&"missing-type".to_string()));
}

#[test]
fn duplicate_type_tag_fires_with_two_types_and_not_with_one() {
    let dup = prop(
        "hp",
        "\t\t\t<Type>UINT8</Type>\n\t\t\t<Type>INT8</Type>\n\t\t\t<Flags>BASE</Flags>\n",
    );
    assert!(checks(&dup).contains(&"duplicate-type-tag".to_string()));
    assert!(!checks(CLEAN_PROP).contains(&"duplicate-type-tag".to_string()));
}

#[test]
fn heavy_sync_broadcast_fires_on_all_clients_heavy_and_not_scalar() {
    let heavy = prop(
        "memo",
        "\t\t\t<Type>UNICODE</Type>\n\t\t\t<Flags>ALL_CLIENTS</Flags>\n",
    );
    assert!(
        checks(&heavy).contains(&"heavy-sync-broadcast".to_string()),
        "大字段 ALL_CLIENTS 应命中"
    );
    assert!(!checks(CLEAN_PROP).contains(&"heavy-sync-broadcast".to_string()));
    let scoped = prop(
        "memo",
        "\t\t\t<Type>STRING</Type>\n\t\t\t<Flags>CELL_PUBLIC</Flags>\n",
    );
    assert!(
        !checks(&scoped).contains(&"heavy-sync-broadcast".to_string()),
        "非全体广播不命中"
    );
}

#[test]
fn redundant_detail_level_fires_without_client_flag_and_not_with_client_flag() {
    let redundant = prop(
        "seed",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>CELL_PRIVATE</Flags>\n\t\t\t<DetailLevel>FAR</DetailLevel>\n",
    );
    assert!(
        checks(&redundant).contains(&"redundant-detail-level".to_string())
    );
    let synced = prop(
        "pos",
        "\t\t\t<Type>VECTOR3</Type>\n\t\t\t<Flags>OTHER_CLIENTS</Flags>\n\t\t\t<DetailLevel>NEAR</DetailLevel>\n",
    );
    assert!(
        !checks(&synced).contains(&"redundant-detail-level".to_string())
    );
}

#[test]
fn invalid_identifier_fires_on_python_keyword_and_not_on_normal_name() {
    let keyword = prop("class", "\t\t\t<Type>UINT8</Type>\n\t\t\t<Flags>BASE</Flags>\n");
    assert!(
        checks(&keyword).contains(&"invalid-identifier".to_string())
    );
    assert!(!checks(CLEAN_PROP).contains(&"invalid-identifier".to_string()));
}

#[test]
fn method_property_collision_fires_and_not_when_disjoint() {
    let colliding = "<root>\n\
\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT8</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\t</Properties>\n\
\t<BaseMethods>\n\t\t<hp>\n\t\t\t<Arg>INT8</Arg>\n\t\t</hp>\n\t</BaseMethods>\n\
</root>\n";
    assert!(
        checks(colliding).contains(&"method-property-collision".to_string())
    );
    assert!(!checks(CLEAN_PROP).contains(&"method-property-collision".to_string()));
}

#[test]
fn engine_limited_name_fires_on_limited_and_not_on_normal() {
    let limited = prop(
        "position",
        "\t\t\t<Type>VECTOR3</Type>\n\t\t\t<Flags>BASE</Flags>\n",
    );
    assert!(
        checks(&limited).contains(&"engine-limited-name".to_string())
    );
    assert!(!checks(CLEAN_PROP).contains(&"engine-limited-name".to_string()));
}

#[test]
fn inherited_name_collision_fires_on_ancestor_method_and_not_on_clean() {
    use kode_server::lint::InheritedNames;
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let mut inherited = InheritedNames::default();
    inherited.insert(
        "hp".to_string(),
        kode_server::lint::InheritedNameInfo {
            property_domains: vec![],
            component_domains: vec![],
            method_sections: vec!["base".to_string()],
            property_sources: vec![],
            component_sources: vec![],
            method_sources: vec!["Base.def".to_string()],
        },
    );
    let findings = analyze_def(text, &inherited, &[])
        .expect("analyze_def ok")
        .into_iter()
        .map(|f| f.check.to_string())
        .collect::<Vec<_>>();
    assert!(
        findings.contains(&"inherited-name-collision".to_string()),
        "{findings:?}"
    );
    assert!(!checks(CLEAN_PROP).contains(&"inherited-name-collision".to_string()));
}

#[test]
fn unknown_flag_value_fires_and_not_on_known_aliases() {
    let bad = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>NOT_A_FLAG</Flags>\n",
    );
    assert!(
        checks(&bad).contains(&"unknown-flag-value".to_string())
    );
    // CELL 别名(12 词表内)不命中。
    let alias = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>CELL</Flags>\n",
    );
    assert!(
        !checks(&alias).contains(&"unknown-flag-value".to_string()),
        "CELL 别名应被 12 词表接受"
    );
}

#[test]
fn unknown_detail_level_fires_and_not_on_known_level() {
    let bad = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t\t<DetailLevel>ULTRA</DetailLevel>\n",
    );
    assert!(
        checks(&bad).contains(&"unknown-detail-level".to_string())
    );
    assert!(!checks(CLEAN_PROP).contains(&"unknown-detail-level".to_string()));
}

#[test]
fn duplicate_definition_fires_warning_info_pair_and_not_on_distinct_scopes() {
    let dup = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\
\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    let findings = analyze_def(dup, &Default::default(), &[])
        .expect("analyze_def ok");
    let dup_count = findings
        .iter()
        .filter(|f| f.check == "duplicate-definition")
        .count();
    assert_eq!(dup_count, 2, "Warning+Info 成对: {findings:?}");
    let sev: Vec<&str> = findings
        .iter()
        .filter(|f| f.check == "duplicate-definition")
        .map(|f| f.severity)
        .collect();
    assert_eq!(sev, vec!["warning", "info"], "{findings:?}");

    let distinct = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\
\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>CELL_PUBLIC</Flags>\n\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    assert!(
        !checks(distinct).contains(&"duplicate-definition".to_string()),
        "不同作用域不算重复"
    );
}

#[test]
fn missing_flags_fires_without_flags_and_not_with_flags() {
    let no_flags = prop("hp", "\t\t\t<Type>UINT32</Type>\n");
    assert!(
        checks(&no_flags).contains(&"missing-flags".to_string())
    );
    assert!(!checks(CLEAN_PROP).contains(&"missing-flags".to_string()));
}

#[test]
fn unknown_type_reference_fires_without_corpus_and_not_with_known_type() {
    let ghost = prop(
        "hp",
        "\t\t\t<Type>GHOST_TYPE</Type>\n\t\t\t<Flags>BASE</Flags>\n",
    );
    assert!(
        checks(&ghost).contains(&"unknown-type-reference".to_string()),
        "未注册类型应命中"
    );
    assert!(!checks(CLEAN_PROP).contains(&"unknown-type-reference".to_string()));
    // 语料提供 GHOST_TYPE 后不再报。
    assert!(
        !checks_with_known(&ghost, &["GHOST_TYPE"])
            .contains(&"unknown-type-reference".to_string()),
        "语料已知类型不命中"
    );
}

#[test]
fn malformed_xml_yields_empty_findings() {
    assert!(checks("not xml at all").is_empty());
}
