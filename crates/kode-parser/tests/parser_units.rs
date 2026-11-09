//! 解析器单测:span 精确性、伪注释、实体解码、属性、错误恢复、语义模型。

use kode_parser::diag::{DiagCode, LineMap, Severity, Span};
use kode_parser::model::{
    canonical_tag, component_types, flag_domains, normalize_flag_tokens, parse_alias, parse_def,
    parse_entities, parse_types, resolve_parent_chain, MethodSection,
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
    // 旧式别名全集(entitydef.cpp:161-164):4 个拼写各落规范位。
    assert_eq!(
        normalize_flag_tokens("CELL_AND_CLIENT"),
        vec!["CELL_PUBLIC_AND_OWN"]
    );
    assert_eq!(
        normalize_flag_tokens("CELL_AND_CLIENTS"),
        vec!["ALL_CLIENTS"]
    );
    assert_eq!(
        normalize_flag_tokens("CELL_AND_OTHER_CLIENTS"),
        vec!["OTHER_CLIENTS"]
    );
    // 别名同样过 trim+大写(引擎 toupper 后查表)。
    assert_eq!(
        normalize_flag_tokens(" cell_and_client "),
        vec!["CELL_PUBLIC_AND_OWN"]
    );
    // 别名域归属随规范名(CELL_AND_CLIENT 落 CELL_PUBLIC_AND_OWN 位,cell+client 面)。
    assert_eq!(
        flag_domains(&normalize_flag_tokens("CELL_AND_CLIENT")),
        vec!["cell", "client"]
    );
    assert_eq!(
        flag_domains(&["BASE_AND_CLIENT".into()]),
        vec!["base", "client"]
    );
    // KR-AUD-87:OWN_CLIENT/OTHER_CLIENTS 同属 cell(common.h:43)。
    assert_eq!(
        flag_domains(&["OTHER_CLIENTS".into()]),
        vec!["cell", "client"]
    );
    assert_eq!(flag_domains(&["OWN_CLIENT".into()]), vec!["cell", "client"]);
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

/// KR-AUD-88(RSV-9):元素形态接口引用——引擎 loadInterfaces
/// (entitydef.cpp:561-585)条目 getKey 必属 {interface,Interface,type,Type},
/// 接口名取条目首个非注释子节点 getKey(trim(Value),xml.cpp:72-95/113-119):
/// `<Interface><MoveIface/></Interface>` 取元素名、`<interface> Text </interface>`
/// 取 trim 文本;非四拼写条目不产出。修前只取直文本,元素形态整体丢失。
#[test]
fn interfaces_element_form_and_wrapper_spellings() {
    let text = "<root><Interfaces><Interface><MoveIface/></Interface><interface> TextIface </interface><Foo> NoIface </Foo><type>TypeIface</type></Interfaces></root>";
    let def = parse_def(text);
    assert_eq!(def.interfaces, vec!["MoveIface", "TextIface", "TypeIface"]);
}

// --- 补覆盖面:PI/声明节点、未闭合 CDATA、标量空值、方法段助手、组件类型 ---

/// `<?...?>` 处理指令与 `<!...>` 声明都保留为节点,span 精确;未闭合 PI/声明
/// 给结构化诊断但不丢树(SYNTAX-002 容错口径)。
#[test]
fn pi_and_declaration_nodes_keep_exact_spans_and_report_unterminated() {
    let text = "<?xml version=\"1.0\" encoding=\"utf-8\"?><root><a/></root><?proc foo?>";
    let doc = parse(text, false);
    let pis: Vec<&Span> = doc
        .nodes
        .iter()
        .filter_map(|n| match &n.data {
            NodeData::ProcessingInstruction { span } => Some(span),
            _ => None,
        })
        .collect();
    assert_eq!(pis.len(), 2, "两条 PI 都应保留");
    assert_eq!(
        &text[pis[0].start..pis[0].end],
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
    );
    assert_eq!(&text[pis[1].start..pis[1].end], "<?proc foo?>");
    assert!(doc.diagnostics.is_empty());

    // 未闭合 PI:诊断 + 节点保留,树不丢。
    let cut = parse("<root><?xml version=\"1.0", false);
    assert!(cut
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::UnterminatedProcessingInstruction));
    assert!(cut.root().is_some());

    // `<!DOCTYPE ...>` 声明节点保留。
    let doctype = parse(
        "<root><!DOCTYPE root [ <!ELEMENT root ANY> ]></root>",
        false,
    );
    assert!(doctype
        .nodes
        .iter()
        .any(|n| matches!(n.data, NodeData::Declaration { .. })));
    assert!(doctype.diagnostics.is_empty());

    // 未闭合 `<!...>`:诊断(复用 UnterminatedComment 码)。
    let cut_doctype = parse("<!DOCTYPE", false);
    assert!(cut_doctype
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::UnterminatedComment));
}

/// 未闭合 CDATA:诊断 + 树保留(与注释同容错口径)。
#[test]
fn unterminated_cdata_reports_but_keeps_tree() {
    let doc = parse("<root><v><![CDATA[raw < text", false);
    assert!(doc
        .diagnostics
        .iter()
        .any(|d| d.code == DiagCode::UnterminatedCdata));
    let root = doc.root().expect("树不丢");
    assert!(doc.child_element(root, "v").is_some());
}

/// `scalar_child_value`:空文本视作无值(TS getScalarChildValue 口径)。
#[test]
fn scalar_child_value_empty_text_is_none() {
    let doc = parse("<root><v>   </v><w> x </w></root>", false);
    let root = doc.root().unwrap();
    assert_eq!(doc.scalar_child_value(root, "v"), None);
    assert_eq!(doc.scalar_child_value(root, "w"), Some("x".to_string()));
    // 缺子元素也是 None
    assert_eq!(doc.scalar_child_value(root, "missing"), None);
}

/// 接口条目首个非注释子节点若是 PI/声明形态(非元素/文本),按空名跳过
/// (KR-AUD-88:只认元素形态与文本形态)。
#[test]
fn interface_entry_with_pi_only_child_is_skipped() {
    let text = "<root><Interfaces><Interface><?pi x?></Interface><interface> TextIface </interface></Interfaces></root>";
    let def = parse_def(text);
    assert_eq!(def.interfaces, vec!["TextIface"]);
}

/// `Client Flags` + `Flags` 双标签合并(遗留拼写):flags_raw 用 `|` 拼接保序。
#[test]
fn legacy_client_flags_and_flags_tags_merge() {
    let text = "<root><Properties><s><Type> UINT16 </Type><Client Flags> CELL </Client Flags><Flags> ALL_CLIENTS </Flags></s></Properties></root>";
    let def = parse_def(text);
    assert!(def.diagnostics.is_empty(), "{:?}", def.diagnostics);
    let s = &def.properties[0];
    // flags_raw 保留原始拼写、以 `|` 拼接;flags 走规范化(CELL → CELL_PUBLIC)去重保序。
    assert_eq!(s.flags_raw.as_deref(), Some("CELL|ALL_CLIENTS"));
    assert_eq!(s.flags, vec!["CELL_PUBLIC", "ALL_CLIENTS"]);
}

/// `<Identifier>` 提取(TS symbolInfo.identifier 同口径)。
#[test]
fn property_identifier_extracted() {
    let text = "<root><Properties><id><Type> UINT32 </Type><Identifier> sm_id </Identifier></id></Properties></root>";
    let def = parse_def(text);
    assert_eq!(def.properties[0].identifier.as_deref(), Some("sm_id"));
}

/// 方法段助手:as_str / section_tag / extract_methods_of 三向一致。
#[test]
fn method_section_helpers_all_sections() {
    assert_eq!(MethodSection::Base.as_str(), "base");
    assert_eq!(MethodSection::Cell.as_str(), "cell");
    assert_eq!(MethodSection::Client.as_str(), "client");
    let text = "<root><BaseMethods><b1><Arg> UINT32 </Arg></b1></BaseMethods><CellMethods><c1/></CellMethods><ClientMethods><cl1><Exposed> true </Exposed></cl1></ClientMethods></root>";
    let doc = parse(text, true);
    let root = doc.root().unwrap();
    let base = MethodSection::Base.extract_methods_of(&doc, root);
    assert_eq!(base.len(), 1);
    assert_eq!(doc.element(base[0]).name, "b1");
    assert_eq!(MethodSection::Cell.extract_methods_of(&doc, root).len(), 1);
    assert_eq!(
        MethodSection::Client.extract_methods_of(&doc, root).len(),
        1
    );
    // 缺段 → 空
    let no_cell = parse_def("<root><BaseMethods/></root>");
    assert!(no_cell.methods(MethodSection::Cell).is_empty());
}

/// 组件类型列表助手(浅层)。
#[test]
fn component_types_helper_lists_types() {
    let def = parse_def(
        "<root><Components><inv><Type> Inventory </Type></inv><bag><Type> Bag </Type></bag><x><Type>  </Type></x></Components></root>",
    );
    assert_eq!(component_types(&def), vec!["Inventory", "Bag"]);
}

/// `element()` 对非元素节点触发不可变借用守卫(调试面断言,非静默错读)。
#[test]
#[should_panic(expected = "element() called on non-element")]
fn element_guard_panics_on_non_element_node() {
    let doc = parse("<root>text</root>", false);
    let root = doc.root().unwrap();
    let text_idx = doc
        .nodes
        .iter()
        .position(|n| matches!(n.data, NodeData::Text { .. }))
        .expect("文本节点存在");
    let _ = doc.element(text_idx);
    let _ = root;
}

// --- diag:Span 助手 / Severity / DiagCode 字符串面 ---

#[test]
fn span_len_empty_and_normalization() {
    let s = Span::new(3, 7);
    assert_eq!(s.len(), 4);
    assert!(!s.is_empty());
    let empty = Span::new(5, 5);
    assert_eq!(empty.len(), 0);
    assert!(empty.is_empty());
    // 反向入参归一化(不 panic,start<=end)
    let inv = Span::new(9, 4);
    assert_eq!(inv.start, 4);
    assert_eq!(inv.end, 9);
    assert_eq!(inv.len(), 5);
    assert!(!inv.is_empty());
}

#[test]
fn severity_as_str_all_levels() {
    assert_eq!(Severity::Error.as_str(), "error");
    assert_eq!(Severity::Warning.as_str(), "warning");
    assert_eq!(Severity::Info.as_str(), "info");
}

#[test]
fn diag_code_as_str_is_stable_for_all_variants() {
    // 稳定协议面:每个码都有唯一非空字符串(blind.rs 仅随机抽验,此处全覆盖)。
    let codes = [
        DiagCode::UnclosedElement,
        DiagCode::MismatchedCloseTag,
        DiagCode::StrayCloseTag,
        DiagCode::InvalidTagName,
        DiagCode::InvalidAttribute,
        DiagCode::UnterminatedAttributeValue,
        DiagCode::UnterminatedComment,
        DiagCode::UnterminatedCdata,
        DiagCode::UnterminatedProcessingInstruction,
        DiagCode::InvalidEntity,
        DiagCode::DuplicateAttribute,
        DiagCode::UnexpectedLt,
        DiagCode::SkippedGarbage,
        DiagCode::InheritanceCycle,
    ];
    let mut seen = std::collections::HashSet::new();
    for c in codes {
        let s = c.as_str();
        assert!(s.starts_with("kp-"), "{s}");
        assert!(seen.insert(s), "码重复: {s}");
    }
    assert_eq!(seen.len(), codes.len());
}

/// `child_elements_named`:按名过滤全部直接元素子节点(保序)。
#[test]
fn child_elements_named_filters_by_name_preserving_order() {
    let doc = parse("<root><a/><b/><a/></root>", false);
    let root = doc.root().unwrap();
    let all = doc.child_elements(root);
    assert_eq!(all.len(), 3);
    let named = doc.child_elements_named(root, "a");
    assert_eq!(named.len(), 2);
    for n in &named {
        assert_eq!(doc.element(*n).name, "a");
    }
    // 名字不在场 → 空
    assert!(doc.child_elements_named(root, "z").is_empty());
}

/// `truthy_child`:缺子元素即 false(None 分支),不 panic。
#[test]
fn truthy_child_missing_child_is_false() {
    let doc = parse("<root><flag> true </flag></root>", false);
    let root = doc.root().unwrap();
    assert!(doc.truthy_child(root, "flag"));
    assert!(!doc.truthy_child(root, "absent"));
}

/// `normalize_flag_tokens`:空段(`|` 相邻/首尾)跳过,不产空 token。
#[test]
fn normalize_flag_tokens_skips_empty_segments() {
    assert_eq!(
        normalize_flag_tokens("CELL||ALL_CLIENTS"),
        vec!["CELL_PUBLIC", "ALL_CLIENTS"]
    );
    assert_eq!(normalize_flag_tokens("|"), Vec::<String>::new());
    assert_eq!(
        normalize_flag_tokens("CELL_PUBLIC|CELL_PUBLIC"),
        vec!["CELL_PUBLIC"]
    );
}
