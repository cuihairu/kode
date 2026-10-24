//! 解析器单测:span 精确性、伪注释、实体解码、属性、错误恢复、语义模型。

use kode_parser::diag::{DiagCode, LineMap, Severity};
use kode_parser::model::{
    canonical_tag, flag_domains, normalize_flag_tokens, parse_alias, parse_def, parse_entities,
    parse_types, resolve_parent_chain, MethodSection,
};
use kode_parser::xml::{mask_def_pseudo_comments, parse, NodeData};

#[test]
fn byte_spans_are_exact() {
    let text = "<root>\n  <!-- c -->\n  <hp>\n    <Type> UINT32 </Type>\n  </hp>\n</root>";
    let doc = parse(text, false);
    let root = doc.root().expect("root");
    let re = doc.element(root);
    assert_eq!(re.name, "root");
    assert_eq!(&text[re.name_span.start..re.name_span.end], "root");
    assert_eq!(&text[re.open_span.start..re.open_span.end], "<root>");
    assert_eq!(&text[re.close_span.start..re.close_span.end], "</root>");
    let hp = doc.child_element(root, "hp").expect("hp");
    let hpe = doc.element(hp);
    assert_eq!(&text[hpe.open_span.start..hpe.open_span.end], "<hp>");
    assert_eq!(&text[hpe.close_span.start..hpe.close_span.end], "</hp>");
    assert_eq!(hpe.content_span.start, hpe.open_span.end);
    assert_eq!(hpe.content_span.end, hpe.close_span.start);
    let ty = doc.child_element(hp, "Type").expect("Type");
    assert_eq!(doc.element(ty).text(&doc).trim(), "UINT32");
    assert_eq!(doc.diagnostics, vec![]);
}

#[test]
fn attributes_keep_name_and_value_spans() {
    let text = r#"<root><Avatar hasBase="true" hasCell = 'true' bare=1 /></root>"#;
    let doc = parse(text, false);
    let root = doc.root().unwrap();
    let av = doc.element(doc.child_element(root, "Avatar").unwrap());
    let base = av.attribute("hasBase").unwrap();
    assert_eq!(&text[base.name_span.start..base.name_span.end], "hasBase");
    assert_eq!(&text[base.value_span.start..base.value_span.end], "true");
    assert_eq!(av.attribute("hasCell").unwrap().value, "true");
    // 未加引号的值有 warning 诊断,但值照常取出
    let bare = av.attribute("bare").unwrap();
    assert_eq!(bare.value, "1");
    assert!(doc
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::InvalidAttribute && d.severity == Severity::Warning));
    assert!(av.self_closing);
    assert_eq!(
        doc.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Error)
            .count(),
        0
    );
}

#[test]
fn pseudo_comment_mask_is_byte_length_preserving() {
    let text =
        "# <root 80col>\n<root>\n\t<Properties>\n# <Type> UINT32 </Type>\n\t</Properties>\n</root>";
    let masked = mask_def_pseudo_comments(text.as_bytes());
    assert_eq!(masked.len(), text.len());
    // `#` 行内容变空格,换行保留
    assert!(masked[..14].iter().all(|&b| b == b' '));
    assert_eq!(masked[14], b'\n');
    // 标签内的 `#` 不受影响
    let with_hash_tag = "<root><a># keep</a></root>";
    let m2 = mask_def_pseudo_comments(with_hash_tag.as_bytes());
    assert_eq!(m2, with_hash_tag.as_bytes());
    // 掩码后 .def 正常解析,且 `#` 行不产出节点
    let def = parse_def(text);
    assert_eq!(def.root_tag.as_deref(), Some("root"));
    assert!(def.diagnostics.is_empty(), "{:?}", def.diagnostics);
    let doc = parse(text, true);
    assert!(doc.root().is_some());
    // `# <原本 80 列>` 头部伪注释不产生诊断
    let legacy = "# <root> 原本 80 列\n<root>\n</root>\n";
    let d2 = parse_def(legacy);
    assert!(d2.diagnostics.is_empty(), "{:?}", d2.diagnostics);
}

#[test]
fn standalone_hash_line_outside_tag_is_masked() {
    // `#` 行只在标签外掩码;上一行标签已闭合的 `# <comment>` 属于注释行
    let text = "<root>\n  <Type value=\"#n1\">\n  # <comment line>\n  </Type>\n</root>";
    let masked = mask_def_pseudo_comments(text.as_bytes());
    assert_eq!(masked.len(), text.len());
    // 属性值内的 `#` 不受影响
    assert!(std::str::from_utf8(&masked).unwrap().contains("\"#n1\""));
    // 独立 `#` 注释行被掩码
    let line3: String = std::str::from_utf8(&masked)
        .unwrap()
        .lines()
        .nth(2)
        .unwrap()
        .to_string();
    assert!(line3.trim().is_empty(), "第三行应整体掩码: {line3:?}");
}

#[test]
fn entity_decoding_in_text_and_attributes() {
    let text = r#"<root><v>a &lt; b &amp; c &#65; &#x42;</v><a t="x&quot;y"/></root>"#;
    let doc = parse(text, false);
    let root = doc.root().unwrap();
    let v = doc.element(doc.child_element(root, "v").unwrap());
    assert_eq!(v.text(&doc), "a < b & c A B");
    let a = doc.element(doc.child_element(root, "a").unwrap());
    assert_eq!(a.attribute("t").unwrap().value, "x\"y");
    assert!(doc.diagnostics.is_empty());
}

#[test]
fn unknown_entity_keeps_literal_with_diag() {
    let text = "<root><v>&nope;</v></root>";
    let doc = parse(text, false);
    let root = doc.root().unwrap();
    let v = doc.element(doc.child_element(root, "v").unwrap());
    assert_eq!(v.text(&doc), "&nope;");
    assert!(doc
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::InvalidEntity));
}

#[test]
fn error_recovery_truncated_never_panics_never_drops_tree() {
    // 活编辑器中途不完整:前缀逐字节截断,树的前缀部分始终可用
    let full = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>";
    for cut in 0..full.len() {
        let slice = &full[..cut];
        let doc = parse(slice, true);
        // 截到 "<root>" 之后,root 元素始终存在
        if cut >= 6 {
            let root = doc.root().expect("截断输入也必须保住已解析的树");
            assert_eq!(doc.element(root).name, "root");
        }
        // 所有诊断 span 必须在输入范围内且 start<=end
        for d in &doc.diagnostics {
            assert!(d.span.end <= slice.len(), "span 越界: {d:?}");
            assert!(d.span.start <= d.span.end);
        }
    }
    // 尾部有未闭合元素时必须有诊断
    let doc = parse("<root><hp>", true);
    assert!(doc
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::UnclosedElement));
}

#[test]
fn mismatched_and_stray_close_recover() {
    let doc = parse("<root><a><b></a></root>", false);
    assert!(doc
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::MismatchedCloseTag));
    let root = doc.root().unwrap();
    assert_eq!(doc.element(root).name, "root");

    let doc2 = parse("<root></nope></root>", false);
    assert!(doc2
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::StrayCloseTag));
    let root2 = doc2.root().unwrap();
    assert_eq!(doc.element(root2).name, "root");
    assert!(!doc2
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::UnexpectedLt));
}

#[test]
fn unterminated_comment_and_cdata_report_but_keep_tree() {
    let doc = parse("<root><!-- 截断", false);
    assert!(doc
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::UnterminatedComment));
    let doc2 = parse("<root><v><![CDATA[raw < text ]]></v></root>", false);
    let root = doc2.root().unwrap();
    assert!(doc2.child_element(root, "v").is_some());
}

#[test]
fn duplicate_attribute_keeps_first() {
    let text = r#"<root><e k="1" k="2"/></root>"#;
    let doc = parse(text, false);
    let e = doc.element(doc.child_element(doc.root().unwrap(), "e").unwrap());
    assert_eq!(e.attributes.len(), 1);
    assert_eq!(e.attributes[0].value, "1");
    assert!(doc
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::DuplicateAttribute));
}

#[test]
fn def_model_extracts_sections() {
    let text = "<root>\n\t<Parent> Base </Parent>\n\t<Interfaces>\n\t\t<interface> I1 </interface>\n\t</Interfaces>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> ALL_CLIENTS </Flags>\n\t\t\t<DetailLevel> MEDIUM </DetailLevel>\n\t\t\t<Persistent> true </Persistent>\n\t\t\t<Sensitive> true </Sensitive>\n\t\t\t<CustomExt> x </CustomExt>\n\t\t</hp>\n\t\t<bag>\n\t\t\t<Type>\n\t\t\t\tARRAY\n\t\t\t\t<of> ITEM </of>\n\t\t\t</Type>\n\t\t</bag>\n\t</Properties>\n\t<Components>\n\t\t<inv>\n\t\t\t<Type> Inventory </Type>\n\t\t\t<Persistent> true </Persistent>\n\t\t</inv>\n\t</Components>\n\t<BaseMethods>\n\t\t<req>\n\t\t\t<Exposed> true </Exposed>\n\t\t\t<Arg> UINT32 </Arg>\n\t\t\t<Arg> STRING </Arg>\n\t\t</req>\n\t</BaseMethods>\n\t<ClientMethods>\n\t\t<onX>\n\t\t</onX>\n\t</ClientMethods>\n\t<DetailLevels>\n\t\t<NEAR>\n\t\t\t<radius> 10 </radius>\n\t\t</NEAR>\n\t</DetailLevels>\n</root>";
    let def = parse_def(text);
    assert_eq!(def.parent.as_deref(), Some("Base"));
    assert_eq!(def.interfaces, vec!["I1"]);
    assert!(!def.volatile);
    assert_eq!(def.properties.len(), 2);
    let hp = &def.properties[0];
    assert_eq!(hp.type_name.as_deref(), Some("UINT32"));
    assert_eq!(hp.type_refs, vec!["UINT32"]);
    assert_eq!(hp.flags, vec!["ALL_CLIENTS"]);
    assert_eq!(hp.detail_level.as_deref(), Some("MEDIUM"));
    assert_eq!(hp.persistent, Some(true));
    assert!(hp.sensitive);
    // 未知标签保留(SYNTAX-005),不失败
    assert_eq!(hp.extra_tags.len(), 1);
    assert_eq!(hp.extra_tags[0].0, "CustomExt");
    // 行号 1 基、与 hp 元素实际行一致(root=1,Parent=2,Interfaces=3..5,Properties=6,hp=7)
    assert_eq!(hp.line, 7);
    let bag = &def.properties[1];
    assert_eq!(bag.type_name.as_deref(), Some("ARRAY"));
    assert_eq!(bag.type_refs, vec!["ITEM"]);
    assert_eq!(def.components.len(), 1);
    assert_eq!(
        def.components[0].component_type.as_deref(),
        Some("Inventory")
    );
    assert_eq!(def.methods(MethodSection::Base).len(), 1);
    let req = &def.methods(MethodSection::Base)[0];
    assert!(req.exposed);
    assert_eq!(req.args, vec!["UINT32", "STRING"]);
    assert!(!def.methods(MethodSection::Client)[0].exposed);
    // DetailLevels 不是已知段落 → extra 保留
    assert_eq!(def.extra_sections.len(), 1);
    assert_eq!(def.extra_sections[0].0, "DetailLevels");
    assert!(def.diagnostics.is_empty());
}

#[test]
fn legacy_tag_and_flag_spellings_are_tolerated() {
    // 遗留拼写:Detaillevel / Client Flags / All Clients
    let text = "<root><Properties><s>\n<Type> UINT16 </Type>\n<Client Flags> ALL_CLIENTS </Client Flags>\n<Detaillevel> LOW </Detaillevel>\n</s>\n<t><Flags> All Clients|CELL </Flags></t>\n</Properties></root>";
    let def = parse_def(text);
    assert!(def.diagnostics.is_empty(), "{:?}", def.diagnostics);
    let s = &def.properties[0];
    assert_eq!(s.detail_level.as_deref(), Some("LOW"));
    assert_eq!(s.flags, vec!["ALL_CLIENTS"]);
    let t = &def.properties[1];
    // All Clients → ALL_CLIENTS;CELL → CELL_PUBLIC;去重保序
    assert_eq!(t.flags, vec!["ALL_CLIENTS", "CELL_PUBLIC"]);
    assert_eq!(flag_domains(&t.flags), vec!["cell", "client"]);
}

#[test]
fn flag_normalization_and_domains() {
    assert_eq!(
        normalize_flag_tokens("a | ALL_CLIENTS | all clients | ALL_CLIENTS"),
        vec!["A", "ALL_CLIENTS"]
    );
    assert_eq!(normalize_flag_tokens("CELL")[0], "CELL_PUBLIC");
    assert_eq!(
        flag_domains(&["BASE_AND_CLIENT".into()]),
        vec!["base", "client"]
    );
    assert_eq!(flag_domains(&["OTHER_CLIENTS".into()]), vec!["client"]);
    assert!(flag_domains(&["UNKNOWN_FLAG".into()]).is_empty());
    assert_eq!(canonical_tag("Client Flags"), "clientflags");
    assert_eq!(canonical_tag("Detail-Level_"), "detaillevel");
}

#[test]
fn entities_types_alias_models() {
    let entities = parse_entities(
        "<root>\n<!-- c -->\n<Account hasClient=\"true\"></Account>\n<Monster hasCell=\"true\"></Monster>\n</root>",
    );
    assert_eq!(entities.entities.len(), 2);
    assert_eq!(entities.entities[0].name, "Account");
    assert_eq!(
        entities.entities[0].attributes,
        vec![("hasClient".to_string(), "true".to_string())]
    );
    assert_eq!(entities.entities[1].line, 4);
    // root 伪条目排除
    let with_pseudo = parse_entities("<root><root/><A/></root>");
    assert_eq!(with_pseudo.entities.len(), 1);

    let types = parse_types(
        "<root>\n<ID> UINT16 </ID>\n<LISTS>\n\tARRAY\n\t<of> ID </of>\n</LISTS>\n<FD>\n\tFIXED_DICT\n\t<Properties>\n\t\t<x>\n\t\t\t<Type>\n\t\t\t\tARRAY\n\t\t\t\t<of> FLOAT </of>\n\t\t\t</Type>\n\t\t</x>\n\t</Properties>\n\t<implementedBy> M.Sym </implementedBy>\n</FD>\n</root>",
    );
    assert_eq!(types.types.len(), 3);
    assert_eq!(types.types[0].name, "ID");
    let arr = &types.types[1];
    assert_eq!(arr.element_ref.as_deref(), Some("ID"));
    let fd = &types.types[2];
    assert_eq!(fd.implemented_by_symbol.as_deref(), Some("Sym"));
    assert_eq!(fd.field_refs, vec!["FLOAT"]);

    // alias:文本式 / Type 式 / 纯属性式(属性式单独归类)
    let alias = parse_alias(
        "<root>\n<A1> UINT16 </A1>\n<A2>\n<Type>\nARRAY\n<of> A1 </of>\n</Type>\n</A2>\n<A3 type=\"ARRAY\" of=\"UINT8\"/>\n</root>",
    );
    assert_eq!(alias.aliases.len(), 2);
    assert_eq!(alias.aliases[0].alias_type, "UINT16");
    assert_eq!(alias.aliases[1].alias_type, "ARRAY");
    assert_eq!(alias.attribute_aliases.len(), 1);
    assert_eq!(alias.attribute_aliases[0].0, "A3");
}

#[test]
fn empty_alias_entry_is_skipped_like_ts() {
    // TS buildAliasXmlCustomTypeInfo:无子元素且无非空文本 → null
    let alias = parse_alias("<root>\n<EMPTY></EMPTY>\n<OK> UINT8 </OK>\n</root>");
    assert_eq!(alias.aliases.len(), 1);
    assert_eq!(alias.aliases[0].name, "OK");
}

#[test]
fn parent_chain_and_cycle_detection() {
    let mut parents = std::collections::HashMap::new();
    parents.insert("Monster".to_string(), "Avatar".to_string());
    parents.insert("Avatar".to_string(), "Base".to_string());
    let (chain, cycle) = resolve_parent_chain("Monster", &parents);
    assert_eq!(chain.len(), 3);
    assert_eq!(chain[0].entity, "Monster");
    assert!(cycle.is_none());
    parents.insert("Base".to_string(), "Monster".to_string());
    let (chain2, cycle2) = resolve_parent_chain("Monster", &parents);
    assert!(cycle2.is_some(), "环必须显式诊断");
    assert_eq!(cycle2.unwrap().code, DiagCode::InheritanceCycle);
    // 环不吞已解析部分
    assert!(!chain2.is_empty());
}

#[test]
fn line_map_line_numbers() {
    let lm = LineMap::new("a\nbb\nccc");
    assert_eq!(lm.line_of(0), 1);
    assert_eq!(lm.line_of(2), 2);
    assert_eq!(lm.line_of(5), 3);
    assert_eq!(lm.line_of(100), 3, "越界 clamp 不 panic");
    assert_eq!(lm.line_count(), 3);
}

#[test]
fn text_and_cdata_nodes_are_distinguishable() {
    let doc = parse("<root><v><![CDATA[<raw>]]>tail</v></root>", false);
    let root = doc.root().unwrap();
    let v = doc.child_element(root, "v").unwrap();
    let kinds: Vec<&str> = doc
        .element(v)
        .children
        .iter()
        .map(|&c| match &doc.nodes[c].data {
            NodeData::Cdata { .. } => "cdata",
            NodeData::Text { .. } => "text",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, vec!["cdata", "text"]);
}
