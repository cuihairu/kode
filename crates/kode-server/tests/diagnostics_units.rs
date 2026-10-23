//! diagnostics 面单测:TS validateDocument 语料子集的逐条口径
//! (消息/严重级/区间/顺序),含跨行与多字节区间的 UTF-16 换算。

use kode_server::{HoverEngine, SEVERITY_ERROR, SEVERITY_INFORMATION, SEVERITY_WARNING};

fn engine_with(defs: &[(&str, &str)]) -> HoverEngine {
    let mut engine = HoverEngine::new();
    for (path, text) in defs {
        engine.update(
            kode_vfs::DocumentKey::new(
                kode_vfs::store::RootId::UNROOTED,
                kode_vfs::uri::CanonicalUri::from_path(path),
            ),
            text,
        );
    }
    engine
}

fn messages_of(engine: &HoverEngine, text: &str) -> Vec<String> {
    engine
        .def_diagnostics(text)
        .into_iter()
        .map(|d| d.message)
        .collect()
}

const UNKNOWN_TYPE_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> GHOST_TYPE </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

#[test]
fn unknown_type_reference_is_error_with_candidate_range() {
    let engine = engine_with(&[]);
    let diagnostics = engine.def_diagnostics(UNKNOWN_TYPE_DEF);
    assert_eq!(diagnostics.len(), 1, "只应有未知类型一条: {diagnostics:?}");
    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.severity, SEVERITY_ERROR);
    assert_eq!(
        diagnostic.message,
        "自定义类型 GHOST_TYPE 未在 types.xml 中注册，请先在 types.xml 注册后再引用"
    );
    // 候选词子区间:`\t\t\t<Type> GHOST_TYPE </Type>` 的 GHOST_TYPE = 列 10..20。
    assert_eq!(diagnostic.range.start.line, 3);
    assert_eq!(diagnostic.range.start.character, 10);
    assert_eq!(diagnostic.range.end.character, 20);
}

#[test]
fn type_known_via_types_or_entities_corpus_is_clean() {
    let types = "<root>\n\t<GHOST_TYPE> UINT32 </GHOST_TYPE>\n</root>\n";
    let engine = engine_with(&[("/w/scripts/entity_defs/types.xml", types)]);
    assert!(engine.def_diagnostics(UNKNOWN_TYPE_DEF).is_empty());

    let entities = "<root>\n\t<GHOST_TYPE/>\n</root>\n";
    let engine = engine_with(&[("/w/scripts/entities.xml", entities)]);
    assert!(engine.def_diagnostics(UNKNOWN_TYPE_DEF).is_empty());
}

#[test]
fn builtin_and_alias_names_are_known_types() {
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 ALIAS_OK </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let alias = "<root>\n\t<ALIAS_OK> UINT32 </ALIAS_OK>\n</root>\n";
    let engine = engine_with(&[("/w/scripts/entity_defs/alias.xml", alias)]);
    assert!(
        engine.def_diagnostics(text).is_empty(),
        "内建 + 别名都算已知"
    );
    // 属性式别名不产出条目(TS buildAliasXmlCustomTypeInfo 同口径)。
    let attribute_alias = "<root>\n\t<ALIAS_OK type=\"ARRAY\" of=\"UINT32\"/>\n</root>\n";
    let engine = engine_with(&[("/w/scripts/entity_defs/alias.xml", attribute_alias)]);
    let messages = messages_of(&engine, text);
    assert_eq!(messages.len(), 1, "属性式别名不算已知: {messages:?}");
}

#[test]
fn unknown_flags_value_is_error_with_verbatim_raw() {
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> NOT_A_FLAG </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let engine = engine_with(&[]);
    let diagnostics = engine.def_diagnostics(text);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].severity, SEVERITY_ERROR);
    assert_eq!(
        diagnostics[0].message,
        "未知的 KBEngine Flags 值: NOT_A_FLAG。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。"
    );
    // 区间 = 值原文出现处(列 11..21,不含空格)。
    assert_eq!(diagnostics[0].range.start.character, 11);
    assert_eq!(diagnostics[0].range.end.character, 21);
}

#[test]
fn flag_aliases_and_case_folding_are_known() {
    // CELL(别名)、cell_and_client(小写归一)都在 12 词表内。
    for flag in ["CELL", "cell_and_client", "BASE"] {
        let text = format!(
            "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> {flag} </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n"
        );
        let engine = engine_with(&[]);
        assert!(
            engine.def_diagnostics(&text).is_empty(),
            "{flag} 应为已知旗标"
        );
    }
}

#[test]
fn unknown_detail_level_is_error() {
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t\t<DetailLevel> ULTRA </DetailLevel>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let engine = engine_with(&[]);
    let diagnostics = engine.def_diagnostics(text);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].message, "未知的 DetailLevel: ULTRA");
    assert_eq!(diagnostics[0].severity, SEVERITY_ERROR);
}

#[test]
fn scalar_checks_run_over_whole_tree_in_dfs_order() {
    // DetailLevels 段下的 Type/Flags 也被扫到(TS visitElementNodes 全树先序),
    // 且按文档序输出。
    let text = "<root>\n\
\t<DetailLevels>\n\
\t\t<NEAR>\n\
\t\t\t<Flags> BAD_A </Flags>\n\
\t\t</NEAR>\n\
\t\t<MEDIUM>\n\
\t\t\t<DetailLevel> BAD_B </DetailLevel>\n\
\t\t</MEDIUM>\n\
\t</DetailLevels>\n\
</root>\n";
    let engine = engine_with(&[]);
    let messages = messages_of(&engine, text);
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert!(messages[0].contains("BAD_A"));
    assert!(messages[1].contains("BAD_B"));
}

#[test]
fn duplicate_methods_and_components_are_warning_plus_info() {
    let text = "<root>\n\
\t<BaseMethods>\n\
\t\t<onTick>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</onTick>\n\
\t\t<onTick>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</onTick>\n\
\t</BaseMethods>\n\
</root>\n";
    let engine = engine_with(&[]);
    let diagnostics = engine.def_diagnostics(text);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0].severity, SEVERITY_WARNING);
    assert_eq!(diagnostics[0].message, "方法区块中存在重复定义: onTick");
    // Info 落在首见节点区间(第 3 行,1 起;0 基 = 2)。
    assert_eq!(diagnostics[1].severity, SEVERITY_INFORMATION);
    assert_eq!(diagnostics[1].message, "onTick 在 方法区块 中已定义");
    assert_eq!(diagnostics[1].range.start.line, 2);
}

#[test]
fn duplicate_properties_are_scope_aware() {
    // 同名同旗标(BASE)→ dup;不同作用域(BASE vs CELL_PUBLIC)→ 不算 dup。
    let text = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    let engine = engine_with(&[]);
    let diagnostics = engine.def_diagnostics(text);
    // Warning(现节点)+ Info(首见节点)成对。
    assert_eq!(diagnostics.len(), 2, "{diagnostics:?}");
    assert_eq!(diagnostics[0].message, "属性区块中存在重复定义: hp (Base)");
    assert_eq!(
        diagnostics[1].message,
        "hp 在 属性区块 中已在 Base 作用域定义"
    );
    assert_eq!(diagnostics[0].severity, SEVERITY_WARNING);
    assert_eq!(diagnostics[1].severity, SEVERITY_INFORMATION);

    let different_scope = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> CELL_PUBLIC </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    assert!(
        engine.def_diagnostics(different_scope).is_empty(),
        "不同作用域不算重复"
    );
}

#[test]
fn missing_property_fields_are_errors_on_node_range() {
    let text = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";
    let engine = engine_with(&[]);
    let diagnostics = engine.def_diagnostics(text);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].message, "属性 hp 缺少 <Flags> 定义");
    // 节点整体区间:`\t\t<hp>` 起于列 2,`</hp>` 止于第 3 行。
    assert_eq!(diagnostics[0].range.start.line, 2);
    assert_eq!(diagnostics[0].range.start.character, 2);
    assert_eq!(diagnostics[0].range.end.line, 4);
}

#[test]
fn malformed_xml_yields_no_diagnostics_like_ts_null_ast() {
    // TS parseDefAst 无 root 时 validateDocument 早退;Rust 同口径回空面。
    let engine = engine_with(&[]);
    assert!(engine.def_diagnostics("not xml at all").is_empty());
}

#[test]
fn non_def_documents_get_empty_face() {
    let engine = engine_with(&[]);
    assert!(engine
        .diagnostics("/w/scripts/entities.xml", "<root>\n\t<A/>\n</root>\n")
        .is_empty());
}
