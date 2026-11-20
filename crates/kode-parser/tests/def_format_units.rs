//! `.def` 格式化核单测(KODE-SYN-006):幂等 / 语义相等 / 伪注释逐字 /
//! 残缺 XML 零编辑 / 大文件预算 / 编辑集自洽。

use kode_parser::def_format::{format_def_edits, format_def_text, DefFormatOptions};
use kode_parser::model::parse_def;
use kode_parser::xml::{parse, NodeData};

const OPTS: DefFormatOptions = DefFormatOptions { indent_size: 4 };

const MESSY: &str = "<root>\n<Properties>\n<hp>\n<Type>UINT32</Type>\n<Flags>BASE_AND_CLIENT</Flags>\n<Default>100</Default>\n</hp>\n</Properties>\n</root>";

const CLEAN: &str = "<root>\n    <Properties>\n        <hp>\n            <Type>UINT32</Type>\n            <Flags>BASE_AND_CLIENT</Flags>\n            <Default>100</Default>\n        </hp>\n    </Properties>\n</root>\n";

#[test]
fn indents_blocks_by_depth() {
    assert_eq!(format_def_text(MESSY, &OPTS), CLEAN);
}

#[test]
fn formatted_output_is_idempotent() {
    let once = format_def_text(MESSY, &OPTS);
    assert_eq!(format_def_text(&once, &OPTS), once);
    assert_eq!(format_def_edits(&once, &OPTS), vec![]);
}

/// 语义相等:元素名/属性名值/文本 token 逐元素比对(引擎只消费这些)。
#[test]
fn formatting_preserves_engine_semantics() {
    let before = parse_def(MESSY);
    let after = parse_def(&format_def_text(MESSY, &OPTS));
    // 解析诊断同为零(不引入新告警)
    assert!(before.diagnostics.is_empty(), "{:?}", before.diagnostics);
    assert!(after.diagnostics.is_empty(), "{:?}", after.diagnostics);
    assert_eq!(before.properties.len(), after.properties.len());
    assert_eq!(before.base_methods.len(), after.base_methods.len());
    assert_eq!(before.components.len(), after.components.len());
    for (a, b) in before.properties.iter().zip(after.properties.iter()) {
        assert_eq!(a.name, b.name);
        assert_eq!(a.type_name, b.type_name);
        assert_eq!(a.flags_raw, b.flags_raw);
        assert_eq!(a.flags, b.flags);
        assert_eq!(a.default_value, b.default_value);
        assert_eq!(a.identifier, b.identifier);
    }
    for (a, b) in before.base_methods.iter().zip(after.base_methods.iter()) {
        assert_eq!(a.name, b.name);
    }
    assert_eq!(semantic_fingerprint(MESSY), semantic_fingerprint(CLEAN));
}

fn semantic_fingerprint(text: &str) -> Vec<String> {
    let doc = parse(text, true);
    fn walk(doc: &kode_parser::xml::Document, idx: usize, out: &mut Vec<String>) {
        let e = doc.element(idx);
        let mut attrs: Vec<String> = e
            .attributes
            .iter()
            .map(|a| format!("{}={}", a.name, a.value))
            .collect();
        attrs.sort();
        out.push(format!(
            "{}[{}]={}",
            e.name,
            attrs.join(","),
            e.text(doc).split_whitespace().collect::<Vec<_>>().join(" ")
        ));
        for child in doc.child_elements(idx) {
            walk(doc, child, out);
        }
    }
    let mut out = Vec::new();
    if let Some(root) = doc.root() {
        walk(&doc, root, &mut out);
    }
    out
}

#[test]
fn inline_value_elements_stay_on_one_line() {
    let messy = "<root>\n  <Type>\n    ARRAY\n    <of>UINT32</of>\n  </Type>\n  <Flags>\n    CELL_PUBLIC\n  </Flags>\n</root>";
    let clean = format_def_text(messy, &OPTS);
    assert!(clean.contains("    <Flags>CELL_PUBLIC</Flags>"), "{clean}");
    assert!(clean.contains("    <Type>"), "{clean}");
    assert!(clean.contains("        <of>UINT32</of>"), "{clean}");
    assert_eq!(format_def_text(&clean, &OPTS), clean);
}

#[test]
fn empty_elements_normalize_to_self_closing() {
    let messy = "<root>\n<Properties>\n</Properties>\n<BaseMethods></BaseMethods>\n</root>";
    let clean = format_def_text(messy, &OPTS);
    assert_eq!(
        clean,
        "<root>\n    <Properties/>\n    <BaseMethods/>\n</root>\n"
    );
    assert_eq!(format_def_text(&clean, &OPTS), clean);
}

#[test]
fn comments_and_cdata_copied_verbatim() {
    let messy = "<root>\n<!-- keep  this   exact -->\n<Properties>\n<Type><![CDATA[ a < b ]]></Type>\n</Properties>\n</root>";
    let clean = format_def_text(messy, &OPTS);
    assert!(clean.contains("    <!-- keep  this   exact -->"), "{clean}");
    assert!(clean.contains("<![CDATA[ a < b ]]>"), "{clean}");
    assert_eq!(format_def_text(&clean, &OPTS), clean);
}

#[test]
fn attribute_values_keep_original_quoting() {
    let messy =
        "<root>\n<Property name=\"level\" type='UINT8' />\n<Flag hasBase = \"true\"/>\n</root>";
    let clean = format_def_text(messy, &OPTS);
    assert!(
        clean.contains(r#"<Property name="level" type='UINT8'/>"#),
        "{clean}"
    );
    assert!(clean.contains(r#"<Flag hasBase="true"/>"#), "{clean}");
    // 实体不在格式化面上重编码
    let entity = "<root>\n<a b=\"x &amp; y\"/>\n</root>";
    assert!(format_def_text(entity, &OPTS).contains("b=\"x &amp; y\""));
}

#[test]
fn pseudo_comment_lines_are_kept_verbatim() {
    let messy = "<root>\n# <原本 80 列> 截断头  \n<Properties>\n# 属性段\n<hp>\n<Type>UINT32</Type>\n</hp>\n</Properties>\n</root>";
    let clean = format_def_text(messy, &OPTS);
    assert!(clean.contains("# <原本 80 列> 截断头  \n"), "{clean}");
    assert!(clean.contains("    # 属性段\n"), "{clean}");
    // 伪注释行不因掩码被当空白丢,也不破坏 idempotence
    assert_eq!(format_def_text(&clean, &OPTS), clean);
    let reparsed = parse(&clean, true);
    assert!(
        reparsed.diagnostics.is_empty(),
        "{:?}",
        reparsed.diagnostics
    );
}

#[test]
fn blank_line_runs_collapse_but_single_blanks_stay() {
    let messy = "<root>\n\n\n<Properties>\n\n\n\n<hp>\n<Type>U</Type>\n\n\n</hp>\n\n</Properties>\n\n</root>\n\n";
    let clean = format_def_text(messy, &OPTS);
    assert!(!clean.contains("\n\n\n"), "{clean}");
    assert!(clean.contains("    </Properties>\n\n</root>"), "{clean}");
    assert_eq!(format_def_text(&clean, &OPTS), clean);
}

#[test]
fn incomplete_xml_yields_no_edits_and_no_panic() {
    for bad in [
        "<root><Properties><hp><Type>UINT32",
        "<root><a></b></root>",
        "<root><x/ attr=>\n</root>",
        "<root><!-- open",
        "not xml at all <<<",
    ] {
        assert_eq!(
            format_def_edits(bad, &OPTS),
            vec![],
            "残缺输入必须零编辑: {bad}"
        );
        assert_eq!(format_def_text(bad, &OPTS), bad, "残缺输入原样返回: {bad}");
    }
}

#[test]
fn parse_diagnostics_refuse_to_format() {
    // 引擎伪 XML 的容忍形态(未加引号的值 / 重复属性)都带解析诊断 →
    // 整档退回:不改,也不 panic(诊断立案面在解析侧,不是本核的责任)。
    for messy in [
        "<root><x bare=9/></root>",
        "<root><x a=\"1\" a=\"2\"/></root>",
    ] {
        assert_eq!(format_def_edits(messy, &OPTS), vec![], "{messy}");
        assert_eq!(format_def_text(messy, &OPTS), *messy, "{messy}");
    }
}

#[test]
fn unknown_inputs_never_panic() {
    // 变异抽验:随机字节序列不 panic(与 tests/blind.rs 同口径的最小面)
    let samples = [
        "",
        "\u{feff}<root/>",
        "<root>\r\n\t<a>\r\n\t</a>\r\n</root>\r\n",
        "<root><a>文本 & 未知实体 &bad;</a></root>",
        "<root/>trailing garbage",
        "\u{0}\u{1}<root/>",
    ];
    for sample in samples {
        let _ = format_def_text(sample, &OPTS);
        let _ = format_def_edits(sample, &OPTS);
    }
}

#[test]
fn edits_apply_back_to_the_same_text() {
    let cases = [
        MESSY,
        "<root>\n <a>x</a>\n</root>",
        "<root>\n</root>",
        "<root>\n\n\n</root>",
    ];
    for text in cases {
        let expected = format_def_text(text, &OPTS);
        let mut out = text.to_string();
        let mut edits = format_def_edits(text, &OPTS);
        // 逆序应用(尾→头),区间互不重叠
        edits.sort_by_key(|e| std::cmp::Reverse(e.start));
        let mut last_start = usize::MAX;
        for edit in &edits {
            assert!(edit.end <= last_start, "编辑区间不得重叠");
            out.replace_range(edit.start..edit.end, &edit.text);
            last_start = edit.start;
        }
        assert_eq!(out, expected, "编辑集应用后必须等于渲染结果");
    }
}

#[test]
fn large_file_stays_within_budget() {
    // 60 实体 × (1 属性 + 2 方法)≈ 2400 行 × 5 层:格式化核本身应是
    // 线性量级(< 1s 宽松上限;CI 慢机留余量)
    let mut text = String::from("<root>\n<Properties>\n");
    for i in 0..60 {
        text.push_str(&format!(
            "<p{i}>\n<Type>UINT32</Type>\n<Flags>BASE</Flags>\n<Default>{i}</Default>\n</p{i}>\n"
        ));
    }
    text.push_str("</Properties>\n<BaseMethods>\n");
    for i in 0..60 {
        for m in 0..2 {
            text.push_str(&format!(
                "<m{i}_{m}>\n<Arg>UINT32</Arg>\n<Exposed/>\n</m{i}_{m}>\n"
            ));
        }
    }
    text.push_str("</BaseMethods>\n</root>");
    let started = std::time::Instant::now();
    let clean = format_def_text(&text, &OPTS);
    let elapsed = started.elapsed();
    assert!(clean.lines().count() > 700, "{}", clean.lines().count());
    assert!(elapsed.as_secs() < 1, "格式化核超预算: {elapsed:?}");
    assert_eq!(format_def_text(&clean, &OPTS), clean);
    assert_eq!(semantic_fingerprint(&text), semantic_fingerprint(&clean));
}

#[test]
fn self_closing_and_pi_declarations_survive() {
    let messy = "<?xml version=\"1.0\"?>\n<!DOCTYPE root>\n<root>\n<Exposed/>\n</root>";
    let clean = format_def_text(messy, &OPTS);
    assert!(clean.starts_with("<?xml version=\"1.0\"?>\n"), "{clean}");
    assert!(clean.contains("<!DOCTYPE root>"), "{clean}");
    assert!(clean.contains("    <Exposed/>"), "{clean}");
    assert_eq!(format_def_text(&clean, &OPTS), clean);
}

#[test]
fn text_nodes_are_not_dropped_from_the_tree() {
    // 掩码把伪注释变空白——解析树里它们是文本节点;渲染不得让它们落成空内容
    let text = "<root>\n# keep me\n</root>";
    let doc = parse(text, true);
    let root = doc.root().unwrap();
    assert!(doc
        .element(root)
        .children
        .iter()
        .any(|&c| matches!(doc.nodes[c].data, NodeData::Text { .. })));
    let clean = format_def_text(text, &OPTS);
    assert_eq!(clean, "<root>\n    # keep me\n</root>\n");
}
