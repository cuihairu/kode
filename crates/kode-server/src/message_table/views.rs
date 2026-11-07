//! def XML 到轻量视图的解析层。

use kode_parser::diag::LineMap;
use kode_parser::xml::Document;

use crate::message_table::constants::METHOD_LOAD_ORDER;

// ---------------------------------------------------------------------------
// def 视图(xml Document 提取;TS parseLocalDefinition 相关字段)
// ---------------------------------------------------------------------------

pub(super) struct DefView {
    pub(super) parent: Option<String>,
    pub(super) parent_line: Option<usize>,
    pub(super) interfaces: Vec<String>,
    pub(super) root_name: String,
    pub(super) properties: Vec<PropView>,
    pub(super) methods: Vec<MethodView>,
    pub(super) components: Vec<CompView>,
}

pub(super) struct PropView {
    pub(super) name: String,
    pub(super) line: usize,
    pub(super) type_name: Option<String>,
    pub(super) flags: Option<String>,
    pub(super) utype: i64,
}

pub(super) struct MethodView {
    pub(super) name: String,
    pub(super) line: usize,
    pub(super) section: &'static str,
    pub(super) args: Vec<ArgView>,
    pub(super) exposed: bool,
    pub(super) utype: i64,
}

pub(super) struct ArgView {
    pub(super) name: String,
    pub(super) of_type: Option<Box<ArgView>>,
}

pub(super) struct CompView {
    pub(super) slot_name: String,
    pub(super) type_name: String,
    pub(super) line: usize,
    pub(super) utype: i64,
    /// `<Persistent>`(truthy);缺省 None = 引擎默认 true(entitydef.cpp L689)。
    pub(super) persistent: Option<bool>,
}

/// TS getScalarChildValue:首个匹配子元素直接文本 trim;空 → None。
pub(super) fn scalar_child(doc: &Document, idx: usize, name: &str) -> Option<String> {
    let child = doc.child_element(idx, name)?;
    let value = doc.element(child).text(doc).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// TS getNodeValue:子元素文本 trim;空回落首个子元素名;仍空 → None。
pub(super) fn node_value(doc: &Document, idx: usize, name: &str) -> Option<String> {
    let child = doc.child_element(idx, name)?;
    let text = doc.element(child).text(doc).trim().to_string();
    if !text.is_empty() {
        return Some(text);
    }
    doc.child_elements(child)
        .first()
        .map(|&c| doc.element(c).name.clone())
}

/// TS parseUtypeValue:非数字文本得 0(视同未设置,自动分配)。
pub(super) fn parse_utype(text: Option<&str>) -> i64 {
    text.and_then(|t| t.trim().parse::<i64>().ok()).unwrap_or(0)
}

/// 已解析 doc 上构造视图(Source::load 复用同一 doc,免二次解析)。
pub(super) fn parse_def_view_with(doc: &Document, text: &str) -> DefView {
    let lines = LineMap::new(text);

    let root = doc.root();
    let parent = root.and_then(|r| node_value(doc, r, "Parent"));
    let parent_line = root
        .and_then(|r| doc.child_element(r, "Parent"))
        .map(|p| lines.line_of(doc.element(p).name_span.start));
    // 引擎 loadInterfaces(entitydef.cpp L559-561)只装载 wrapper 标签为
    // interface/Interface/type/Type 四拼写的子元素(大小写敏感精确比对),
    // 其余 continue;取名与 <Parent> 同:文本取文本、元素取标签名。
    let interfaces = root
        .and_then(|r| doc.child_element(r, "Interfaces"))
        .map(|ifaces| {
            doc.child_elements(ifaces)
                .iter()
                .filter(|&&child| {
                    matches!(
                        doc.element(child).name.as_str(),
                        "interface" | "Interface" | "type" | "Type"
                    )
                })
                .filter_map(|&child| {
                    let text = doc.element(child).text(doc).trim().to_string();
                    if !text.is_empty() {
                        return Some(text);
                    }
                    doc.child_elements(child)
                        .first()
                        .map(|&grandchild| doc.element(grandchild).name.clone())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut properties = Vec::new();
    let mut methods = Vec::new();
    let mut components = Vec::new();
    if let Some(root) = root {
        if let Some(props) = doc.child_element(root, "Properties") {
            for child in doc.child_elements(props) {
                properties.push(parse_prop(doc, &lines, child));
            }
        }
        for section in METHOD_LOAD_ORDER {
            if let Some(sec) = doc.child_element(root, section) {
                for child in doc.child_elements(sec) {
                    methods.push(parse_method(doc, &lines, child, section));
                }
            }
        }
        if let Some(comps) = doc.child_element(root, "Components") {
            for child in doc.child_elements(comps) {
                if let Some(cv) = parse_comp(doc, &lines, child) {
                    components.push(cv);
                }
            }
        }
    }

    DefView {
        parent,
        parent_line,
        interfaces,
        root_name: root
            .map(|r| doc.element(r).name.clone())
            .unwrap_or_default(),
        properties,
        methods,
        components,
    }
}

pub(super) fn parse_prop(doc: &Document, lines: &LineMap, child: usize) -> PropView {
    let e = doc.element(child);
    PropView {
        name: e.name.clone(),
        line: lines.line_of(e.name_span.start),
        type_name: scalar_child(doc, child, "Type"),
        flags: scalar_child(doc, child, "Flags"),
        utype: parse_utype(scalar_child(doc, child, "Utype").as_deref()),
    }
}

pub(super) fn parse_method(
    doc: &Document,
    lines: &LineMap,
    child: usize,
    section: &'static str,
) -> MethodView {
    let e = doc.element(child);
    let mut args = Vec::new();
    for arg_node in doc.child_elements_named(child, "Arg") {
        let arg_name = doc.element(arg_node).text(doc).trim().to_string();
        if arg_name.is_empty() {
            continue;
        }
        args.push(parse_arg(doc, arg_node, &arg_name));
    }
    MethodView {
        name: e.name.clone(),
        line: lines.line_of(e.name_span.start),
        section,
        args,
        exposed: doc.truthy_child(child, "Exposed"),
        utype: parse_utype(scalar_child(doc, child, "Utype").as_deref()),
    }
}

/// TS parseArgType:ARRAY 走 `<of>` 递归;缺 of / 空 of 按 TS 语义保留。
pub(super) fn parse_arg(doc: &Document, arg_node: usize, name: &str) -> ArgView {
    if name != "ARRAY" {
        return ArgView {
            name: name.to_string(),
            of_type: None,
        };
    }
    match doc.child_element(arg_node, "of") {
        None => ArgView {
            name: name.to_string(),
            of_type: None,
        },
        Some(of_idx) => {
            let of_name = doc.element(of_idx).text(doc).trim().to_string();
            let of_type = if of_name.is_empty() {
                Some(Box::new(ArgView {
                    name: String::new(),
                    of_type: None,
                }))
            } else {
                Some(Box::new(parse_arg(doc, of_idx, &of_name)))
            };
            ArgView {
                name: name.to_string(),
                of_type,
            }
        }
    }
}

pub(super) fn parse_comp(doc: &Document, lines: &LineMap, child: usize) -> Option<CompView> {
    let e = doc.element(child);
    let type_name = node_value(doc, child, "Type")?;
    Some(CompView {
        slot_name: e.name.clone(),
        line: lines.line_of(e.name_span.start),
        type_name,
        utype: parse_utype(scalar_child(doc, child, "Utype").as_deref()),
        persistent: doc
            .child_element(child, "Persistent")
            .map(|_| doc.truthy_child(child, "Persistent")),
    })
}
