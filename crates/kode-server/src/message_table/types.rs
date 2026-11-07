//! types.xml 用户类型装载与查找。

use kode_parser::diag::LineMap;
use kode_parser::xml::parse as parse_xml;

use crate::message_table::assembly::{AsmIssue, AsmType, Assembly};
use crate::message_table::source::is_structural_error;

// ---------------------------------------------------------------------------

pub(super) fn load_types_xml(origin: &str, types_xml: &str, asm: &mut Assembly) {
    let doc = parse_xml(types_xml, false);
    if is_structural_error(&doc) {
        asm.issues.push(AsmIssue {
            kind: "types-parse-error",
            fatal: true,
            line: None,
            message: "DataTypes::loadTypes: types.xml 解析失败(非法 XML)".to_string(),
        });
        return;
    }
    let lines = LineMap::new(types_xml);
    let Some(root) = doc.root() else {
        return;
    };

    for alias_node in doc.child_elements(root) {
        let alias_name = doc.element(alias_node).name.clone();
        let line = lines.line_of(doc.element(alias_node).name_span.start);
        if alias_name.starts_with('_') {
            asm.issues.push(AsmIssue {
                kind: "invalid-type-alias-name",
                fatal: true,
                line: Some(line),
                message: format!(
                    "DataTypes::loadTypes: Not allowed to use the prefix \"_\"! aliasName={alias_name}"
                ),
            });
            continue;
        }

        let fixed_dict_node = doc.child_element(alias_node, "FIXED_DICT");
        let array_node = doc.child_element(alias_node, "ARRAY");
        let child_text = doc.element(alias_node).text(&doc).trim().to_string();
        if has_alias_name(asm, &alias_name) {
            asm.issues.push(AsmIssue {
                kind: "duplicate-type-alias",
                fatal: false,
                line: Some(line),
                message: format!("DataTypes::addDataType(name): name {alias_name} exist."),
            });
            if fixed_dict_node.is_some() {
                consume_user_type(asm, &alias_name, Some(line), "fixed-dict", origin);
            } else if array_node.is_some() {
                consume_user_type(asm, &alias_name, Some(line), "array", origin);
            }
            continue;
        }

        if let Some(fd) = fixed_dict_node {
            if doc.child_element(fd, "Properties").is_none() {
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: "FixedDictType::initialize: not found \"Properties\".".to_string(),
                });
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: format!(
                        "DataTypes::loadTypes: parse FIXED_DICT [{alias_name}] error!"
                    ),
                });
                consume_user_type(asm, &alias_name, Some(line), "fixed-dict", origin);
                continue;
            }
            register_user_type(asm, &alias_name, Some(line), "fixed-dict", None, origin);
            continue;
        }
        if let Some(arr) = array_node {
            let Some(of_node) = doc.child_element(arr, "of") else {
                asm.issues.push(AsmIssue {
                    kind: "array-of-missing",
                    fatal: true,
                    line: Some(line),
                    message: "FixedArrayType::initialize: not found \"of\".".to_string(),
                });
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: format!("DataTypes::loadTypes: parse ARRAY [{alias_name}] error!"),
                });
                consume_user_type(asm, &alias_name, Some(line), "array", origin);
                continue;
            };
            let of_name = doc.element(of_node).text(&doc).trim().to_string();
            if lookup_type(&of_name, asm).is_none() {
                asm.issues.push(AsmIssue {
                    kind: "array-of-unknown-type",
                    fatal: true,
                    line: Some(line),
                    message: format!(
                        "FixedArrayType::initialize: key[ARRAY] did not find type[{of_name}]!"
                    ),
                });
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: format!("DataTypes::loadTypes: parse ARRAY [{alias_name}] error!"),
                });
                consume_user_type(asm, &alias_name, Some(line), "array", origin);
                continue;
            }
            register_user_type(asm, &alias_name, Some(line), "array", None, origin);
            continue;
        }

        if lookup_type(&child_text, asm).is_none() {
            asm.issues.push(AsmIssue {
                kind: "unknown-aliased-type",
                fatal: true,
                line: Some(line),
                message: format!(
                    "DataTypes::loadTypes: can't fount type {child_text} by alias[{alias_name}]."
                ),
            });
            continue;
        }
        register_user_type(
            asm,
            &alias_name,
            Some(line),
            "alias",
            Some(&child_text),
            origin,
        );
    }
}

pub(super) fn has_alias_name(asm: &Assembly, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    asm.registry
        .keys()
        .any(|known| known.to_ascii_lowercase() == lower)
}

pub(super) fn register_user_type(
    asm: &mut Assembly,
    name: &str,
    line: Option<usize>,
    kind: &'static str,
    aliased_to: Option<&str>,
    origin: &str,
) {
    let utype = match aliased_to {
        None => {
            let u = asm.next_type_utype;
            asm.next_type_utype += 1;
            u
        }
        Some(target) => lookup_type(target, asm).expect("aliased type must exist"),
    };
    asm.registry.insert(name.to_string(), utype);
    asm.types.push(AsmType {
        name: name.to_string(),
        utype,
        kind,
        aliased_to: aliased_to.map(str::to_string),
        line,
        origin: origin.to_string(),
    });
}

pub(super) fn consume_user_type(
    asm: &mut Assembly,
    name: &str,
    line: Option<usize>,
    kind: &'static str,
    origin: &str,
) {
    let utype = asm.next_type_utype;
    asm.next_type_utype += 1;
    asm.types.push(AsmType {
        name: name.to_string(),
        utype,
        kind,
        aliased_to: None,
        line,
        origin: origin.to_string(),
    });
}

pub(super) fn lookup_type(name: &str, asm: &Assembly) -> Option<i64> {
    asm.registry.get(name).copied()
}
