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
    assert!(checks(&redundant).contains(&"redundant-detail-level".to_string()));
    let synced = prop(
        "pos",
        "\t\t\t<Type>VECTOR3</Type>\n\t\t\t<Flags>OTHER_CLIENTS</Flags>\n\t\t\t<DetailLevel>NEAR</DetailLevel>\n",
    );
    assert!(!checks(&synced).contains(&"redundant-detail-level".to_string()));
}

#[test]
fn invalid_identifier_fires_on_python_keyword_and_not_on_normal_name() {
    let keyword = prop(
        "class",
        "\t\t\t<Type>UINT8</Type>\n\t\t\t<Flags>BASE</Flags>\n",
    );
    assert!(checks(&keyword).contains(&"invalid-identifier".to_string()));
    assert!(!checks(CLEAN_PROP).contains(&"invalid-identifier".to_string()));
}

#[test]
fn method_property_collision_fires_and_not_when_disjoint() {
    let colliding = "<root>\n\
\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT8</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\t</Properties>\n\
\t<BaseMethods>\n\t\t<hp>\n\t\t\t<Arg>INT8</Arg>\n\t\t</hp>\n\t</BaseMethods>\n\
</root>\n";
    assert!(checks(colliding).contains(&"method-property-collision".to_string()));
    assert!(!checks(CLEAN_PROP).contains(&"method-property-collision".to_string()));
}

#[test]
fn engine_limited_name_fires_on_limited_and_not_on_normal() {
    let limited = prop(
        "position",
        "\t\t\t<Type>VECTOR3</Type>\n\t\t\t<Flags>BASE</Flags>\n",
    );
    assert!(checks(&limited).contains(&"engine-limited-name".to_string()));
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
    assert!(checks(&bad).contains(&"unknown-flag-value".to_string()));
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

/// KR-AUD-84:'|' 组合形态单独出「引擎不支持」诊断——引擎按单个映射值
/// 整串查表,不拆词;旧实现经 normalize_flag_tokens 拆词后零诊断。
#[test]
fn flag_pipe_form_gets_dedicated_engine_unsupported_finding() {
    let pipe = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE|CELL</Flags>\n",
    );
    let findings = analyze_def(&pipe, &Default::default(), &[]).expect("analyze_def ok");
    let pipe_findings: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "unknown-flag-value")
        .collect();
    assert_eq!(
        pipe_findings.len(),
        1,
        "'|' 形态恰一条 unknown-flag-value: {findings:?}"
    );
    assert!(
        pipe_findings[0].message.contains("不支持 '|' 组合形态"),
        "'|' 形态应为专属「引擎不支持」文案: {findings:?}"
    );
}

/// KR-AUD-84:整串查表——空格/小写混合形态不再被归一折叠放过。
#[test]
fn flag_lookup_is_whole_string_not_normalized_tokens() {
    let spaced = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>all clients</Flags>\n",
    );
    assert!(
        checks(&spaced).contains(&"unknown-flag-value".to_string()),
        "整串查表: 'all clients' 不在引擎词表,应命中"
    );
    // trim+大写后整串命中的仍放行(与引擎/TS 同口径)。
    let tidy = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags> cell_public </Flags>\n",
    );
    assert!(
        !checks(&tidy).contains(&"unknown-flag-value".to_string()),
        "trim+大写整串命中应放行"
    );
}

#[test]
fn unknown_detail_level_fires_and_not_on_known_level() {
    let bad = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t\t<DetailLevel>ULTRA</DetailLevel>\n",
    );
    assert!(checks(&bad).contains(&"unknown-detail-level".to_string()));
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
    let findings = analyze_def(dup, &Default::default(), &[]).expect("analyze_def ok");
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
    assert!(checks(&no_flags).contains(&"missing-flags".to_string()));
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
        !checks_with_known(&ghost, &["GHOST_TYPE"]).contains(&"unknown-type-reference".to_string()),
        "语料已知类型不命中"
    );
}

#[test]
fn malformed_xml_yields_empty_findings() {
    assert!(checks("not xml at all").is_empty());
}

#[test]
fn own_client_in_cell_domain_collides_like_engine() {
    // KR-AUD-87 真值:ED_FLAG_OWN_CLIENT(0x10)∈ ENTITY_CELL_DATA_FLAGS
    // (entitydef/common.h:43),引擎 loadDefPropertys 按 hasCellFlags 把
    // OWN_CLIENT 属性注册进 cell map(entitydef.cpp:1288-1290),同名
    // CELL_PUBLIC 属性在 cell map 命中 "is exist!"
    // (scriptdef_module.cpp:588-593)→ 必须判重。
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>OWN_CLIENT</Flags>\n\t\t</hp>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>CELL_PUBLIC</Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let findings = checks(text);
    assert!(
        findings.contains(&"duplicate-definition".to_string()),
        "OWN_CLIENT 入 cell 域后与 CELL_PUBLIC 判重(引擎 cell map 冲突): {findings:?}"
    );
}

#[test]
fn cell_alias_normalizes_to_cell_domain_and_collides() {
    // Flags="CELL" 是 CELL_PUBLIC 的别名(engine 同义)。同名属性一个
    // CELL、一个 CELL_PUBLIC 应判重(cell 域相交)。
    // 旧 flag_scopes 用未归一化 token 比对,CELL 丢域 → 漏报,此断言先红后绿。
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>CELL</Flags>\n\t\t</hp>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>CELL_PUBLIC</Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let findings = checks(text);
    assert!(
        findings.contains(&"duplicate-definition".to_string()),
        "CELL 别名应归一为 CELL_PUBLIC 与后者判重: {findings:?}"
    );
}

// ---------------------------------------------------------------------------
// 边界:无文本 Type / 文本被注释拆断 / 数字起词 / 空值 / 非白名单段
// ---------------------------------------------------------------------------

#[test]
fn type_tag_with_element_child_is_missing_type_and_skips_reference_scan() {
    // Type 只有元素子节点、无文本值 → missing-type;引用扫描跳过该形态。
    let text = prop(
        "hp",
        "\t\t\t<Type><Sub/></Type>\n\t\t\t<Flags>BASE</Flags>\n",
    );
    let found = checks(&text);
    assert!(found.contains(&"missing-type".to_string()), "{found:?}");
    assert!(
        !found.contains(&"unknown-type-reference".to_string()),
        "元素子节点的 Type 不进引用扫描: {found:?}"
    );
}

#[test]
fn empty_type_value_is_missing_type() {
    // Type 仅空白 → 无有效类型;引用扫描对空值跳过。
    let text = prop("hp", "\t\t\t<Type>   </Type>\n\t\t\t<Flags>BASE</Flags>\n");
    let found = checks(&text);
    assert!(found.contains(&"missing-type".to_string()), "{found:?}");
    assert!(!found.contains(&"unknown-type-reference".to_string()));
}

#[test]
fn flag_value_span_falls_back_when_text_split_by_comment() {
    // 注释把 Flags 文本拆成两段:trim 拼接值 "BASECELL" 在原文不连续,
    // 取值区间回落 content 整段(仍产出 unknown-flag-value)。
    let text = prop(
        "hp",
        "\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE<!--gap-->CELL</Flags>\n",
    );
    let findings = analyze_def(&text, &Default::default(), &[]).expect("analyze_def ok");
    let flag_findings: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "unknown-flag-value")
        .collect();
    assert_eq!(flag_findings.len(), 1, "{findings:?}");
    assert!(
        flag_findings[0].message.contains("BASECELL"),
        "整串查表值应为拼接后的 BASECELL: {findings:?}"
    );
}

#[test]
fn type_reference_tokens_do_not_start_with_digits() {
    // 词法以字母/下划线起:数字开头不构词,"9ABC" 不整体成词,"ABC" 独立成词。
    let text = prop(
        "hp",
        "\t\t\t<Type> 9ABC GHOST_TYPE </Type>\n\t\t\t<Flags>BASE</Flags>\n",
    );
    let findings = analyze_def(&text, &Default::default(), &[]).expect("analyze_def ok");
    let msgs: Vec<String> = findings
        .iter()
        .filter(|f| f.check == "unknown-type-reference")
        .map(|f| f.message.clone())
        .collect();
    assert!(
        msgs.iter().any(|m| m.contains("自定义类型 ABC")),
        "{msgs:?}"
    );
    assert!(
        msgs.iter().any(|m| m.contains("自定义类型 GHOST_TYPE")),
        "{msgs:?}"
    );
    assert!(!msgs.iter().any(|m| m.contains("9ABC")), "{msgs:?}");
}

#[test]
fn non_whitelisted_top_level_section_is_skipped_by_duplicate_scan() {
    // DetailLevels 不是白名单段:段内同名声明不判重。
    let text = "<root>\n\
\t<DetailLevels>\n\t\t<FAR/>\n\t\t<FAR/>\n\t</DetailLevels>\n\
\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\t</Properties>\n\
</root>\n";
    assert!(
        !checks(text).contains(&"duplicate-definition".to_string()),
        "非白名单段不进判重扫描"
    );
}

// ---------------------------------------------------------------------------
// 重复定义:client 作用域 / Volatile 段 / 方法段(Warning+Info 成对)
// ---------------------------------------------------------------------------

#[test]
fn duplicate_definition_client_scope_reports_client_label() {
    let dup = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>ALL_CLIENTS</Flags>\n\t\t</hp>\n\
\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>ALL_CLIENTS</Flags>\n\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    let findings = analyze_def(dup, &Default::default(), &[]).expect("analyze_def ok");
    let msgs: Vec<String> = findings
        .iter()
        .filter(|f| f.check == "duplicate-definition")
        .map(|f| f.message.clone())
        .collect();
    // ALL_CLIENTS 同时落 cell 与 client 两个作用域账:两个域各一对
    // Warning+Info(重复声明 + 首个声明位置提示)。
    assert_eq!(msgs.len(), 4, "Cell/Client 各一对: {findings:?}");
    assert!(msgs.iter().any(|m| m.contains("(Cell)")), "{msgs:?}");
    assert!(msgs.iter().any(|m| m.contains("(Client)")), "{msgs:?}");
    assert!(
        msgs.iter().any(|m| m.contains("已在 Client 作用域定义")),
        "{msgs:?}"
    );
}

#[test]
fn duplicate_methods_in_volatile_and_method_sections() {
    // Volatile 段同名判重(易变同步区块标签)。
    let vol = "<root>\n\t<Volatile>\n\t\t<pos/>\n\t\t<pos/>\n\t</Volatile>\n</root>\n";
    let findings = analyze_def(vol, &Default::default(), &[]).expect("analyze_def ok");
    let msgs: Vec<String> = findings
        .iter()
        .filter(|f| f.check == "duplicate-definition")
        .map(|f| f.message.clone())
        .collect();
    assert_eq!(msgs.len(), 2, "Warning+Info 成对: {findings:?}");
    assert!(msgs.iter().all(|m| m.contains("易变同步区块")), "{msgs:?}");
    // 方法段同名判重(方法区块标签)。
    let methods = "<root>\n\t<BaseMethods>\n\t\t<onKill>\n\t\t\t<Arg>INT8</Arg>\n\t\t</onKill>\n\t\t<onKill>\n\t\t\t<Arg>INT8</Arg>\n\t\t</onKill>\n\t</BaseMethods>\n</root>\n";
    let findings = analyze_def(methods, &Default::default(), &[]).expect("analyze_def ok");
    let msgs: Vec<String> = findings
        .iter()
        .filter(|f| f.check == "duplicate-definition")
        .map(|f| f.message.clone())
        .collect();
    assert_eq!(msgs.len(), 2, "Warning+Info 成对: {findings:?}");
    assert!(msgs.iter().all(|m| m.contains("方法区块")), "{msgs:?}");
}

// ---------------------------------------------------------------------------
// Python 关键字方法名(invalid-identifier 方法支路)
// ---------------------------------------------------------------------------

#[test]
fn invalid_identifier_fires_on_python_keyword_method_name() {
    let text = "<root>\n\t<ClientMethods>\n\t\t<lambda>\n\t\t\t<Exposed>true</Exposed>\n\t\t</lambda>\n\t</ClientMethods>\n</root>\n";
    let findings = analyze_def(text, &Default::default(), &[]).expect("analyze_def ok");
    let kw: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "invalid-identifier")
        .collect();
    assert_eq!(kw.len(), 1, "{findings:?}");
    assert_eq!(kw[0].name.as_deref(), Some("lambda"));
    assert!(kw[0].message.contains("Python 关键字"));
}

// ---------------------------------------------------------------------------
// 继承链同名:属性同域 / 方法同段 / 方法×属性 / 组件槽 + 不相交不判重
// ---------------------------------------------------------------------------

use kode_server::lint::{all_rules, InheritedNameInfo, InheritedNames, RuleContext};

fn inherited_info(domains: &[&str], sources: &[&str]) -> InheritedNameInfo {
    InheritedNameInfo {
        property_domains: domains.iter().map(|s| s.to_string()).collect(),
        component_domains: Vec::new(),
        method_sections: Vec::new(),
        property_sources: sources.iter().map(|s| s.to_string()).collect(),
        component_sources: Vec::new(),
        method_sources: Vec::new(),
    }
}

#[test]
fn inherited_property_domain_overlap_collides_and_disjoint_does_not() {
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>BASE</Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let mut inherited = InheritedNames::default();
    inherited.insert("hp".to_string(), inherited_info(&["base"], &["Parent.def"]));
    let findings = analyze_def(text, &inherited, &[]).expect("analyze_def ok");
    let hits: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "inherited-name-collision")
        .collect();
    assert_eq!(hits.len(), 1, "{findings:?}");
    assert!(hits[0].message.contains("同域位同名"), "{hits:?}");
    assert!(
        hits[0].message.contains("(继承自 Parent.def)"),
        "引用来源应进文案: {hits:?}"
    );

    // 作用域不相交(base vs client)→ 不判重。
    let mut disjoint = InheritedNames::default();
    disjoint.insert(
        "hp".to_string(),
        inherited_info(&["client"], &["Parent.def"]),
    );
    assert!(
        !analyze_def(text, &disjoint, &[])
            .expect("analyze_def ok")
            .iter()
            .any(|f| f.check == "inherited-name-collision"),
        "域位不相交不判重"
    );
}

#[test]
fn inherited_method_same_section_and_property_collisions() {
    let text = "<root>\n\t<BaseMethods>\n\t\t<onKill>\n\t\t\t<Arg>INT8</Arg>\n\t\t</onKill>\n\t</BaseMethods>\n\t<ClientMethods>\n\t\t<onHint/>\n\t</ClientMethods>\n</root>\n";
    let mut inherited = InheritedNames::default();
    // onKill 与祖先 base 段方法同名 → 同段判重。
    inherited.insert(
        "onKill".to_string(),
        InheritedNameInfo {
            method_sections: vec!["base".to_string()],
            method_sources: vec!["Parent.def".to_string()],
            ..Default::default()
        },
    );
    // onHint 与祖先属性同名 → hasPropertyName 全局拒绝。
    inherited.insert("onHint".to_string(), inherited_info(&[], &["Parent.def"]));
    let findings = analyze_def(text, &inherited, &[]).expect("analyze_def ok");
    let msgs: Vec<String> = findings
        .iter()
        .filter(|f| f.check == "inherited-name-collision")
        .map(|f| f.message.clone())
        .collect();
    assert_eq!(msgs.len(), 2, "{findings:?}");
    assert!(
        msgs.iter()
            .any(|m| m.contains("onKill 与继承链上的方法同段同名")),
        "{msgs:?}"
    );
    assert!(
        msgs.iter()
            .any(|m| m.contains("onHint 与继承链上的属性/组件同名")),
        "{msgs:?}"
    );

    // 祖先方法只在其它段(cell)时:base 段同名不判重(段隔离)。
    let mut other_section = InheritedNames::default();
    other_section.insert(
        "onKill".to_string(),
        InheritedNameInfo {
            method_sections: vec!["cell".to_string()],
            method_sources: vec!["Parent.def".to_string()],
            ..Default::default()
        },
    );
    assert!(
        !analyze_def(text, &other_section, &[])
            .expect("analyze_def ok")
            .iter()
            .any(|f| f.check == "inherited-name-collision"),
        "段隔离:祖先 cell 段方法不与本文件 base 段判重"
    );
}

#[test]
fn inherited_component_slot_name_collides() {
    let text = "<root>\n\t<Components>\n\t\t<inv>\n\t\t\t<Type>Inventory</Type>\n\t\t</inv>\n\t</Components>\n</root>\n";
    let mut inherited = InheritedNames::default();
    inherited.insert(
        "inv".to_string(),
        InheritedNameInfo {
            component_sources: vec!["Parent.def".to_string()],
            ..Default::default()
        },
    );
    let findings = analyze_def(text, &inherited, &[]).expect("analyze_def ok");
    let hits: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "inherited-name-collision")
        .collect();
    assert_eq!(hits.len(), 1, "{findings:?}");
    assert!(
        hits[0].message.contains("组件槽 inv 与继承链上的声明同名"),
        "{hits:?}"
    );
}

// ---------------------------------------------------------------------------
// 注册表面:规则数/顺序/Debug 面/重复注册 panic/无根文档直跑
// ---------------------------------------------------------------------------

#[test]
fn rule_registry_reports_len_order_and_debug() {
    let reg = all_rules();
    assert!(!reg.is_empty());
    assert_eq!(reg.len(), 15);
    let debug = format!("{reg:?}");
    assert!(debug.starts_with('['), "{debug}");
    let ids: Vec<String> = debug
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(", ")
        .map(|s| s.trim_matches('"').to_string())
        .collect();
    // 注册序 = 稳定输出序:phantom-type 领头,def↔Python 一致性规则收尾。
    assert_eq!(ids.first().map(String::as_str), Some("phantom-type"));
    assert_eq!(
        ids.last().map(String::as_str),
        Some("def-method-missing-in-python")
    );
}

#[test]
fn empty_rule_registry_is_empty() {
    let reg = kode_server::lint::RuleRegistry::default();
    assert!(reg.is_empty());
    assert_eq!(reg.len(), 0);
}

#[test]
#[should_panic(expected = "registered twice")]
fn rule_registry_rejects_duplicate_rule_id() {
    use kode_server::lint::{rules, RuleRegistry};
    let mut reg = RuleRegistry::new();
    reg.push(Box::new(rules::PhantomTypeRule));
    reg.push(Box::new(rules::PhantomTypeRule));
}

#[test]
fn rules_on_rootless_document_produce_nothing() {
    let text = "not xml at all";
    let doc = kode_parser::xml::parse(text, true);
    assert!(doc.root().is_none(), "无标签文本不应产出根元素");
    let line_map = kode_parser::diag::LineMap::new(text);
    let ctx = RuleContext {
        text,
        doc: &doc,
        line_map: &line_map,
        inherited: &InheritedNames::default(),
        known_types: &Default::default(),
        python: Default::default(),
    };
    assert!(all_rules().run(&ctx).is_empty());
}
