//! 方法 utype/参数链模拟(TS addMethodDescription)。

use crate::message_table::assembly::{AsmArg, AsmIssue, AsmMethod, AsmType, Assembly};
use crate::message_table::constants::{origin_label, section_name, METHOD_UTYPE_MAX};
use crate::message_table::types::lookup_type;
use crate::message_table::views::{ArgView, MethodView};

// ---------------------------------------------------------------------------

pub(super) fn simulate_method(
    module_name: &str,
    method: &MethodView,
    origin_kind: &'static str,
    asm: &mut Assembly,
) {
    let section_label = section_name(method.section);
    let origin = origin_label(module_name, origin_kind);
    let direction = if method.section == "ClientMethods" {
        "server-to-client"
    } else if method.exposed {
        "client-to-server"
    } else {
        "server-internal"
    };
    let visible_to_client = method.section == "ClientMethods" || method.exposed;
    let entry = AsmMethod {
        name: method.name.clone(),
        section: method.section,
        direction,
        visible_to_client,
        exposed: method.exposed,
        args: Vec::new(),
        declared_utype: None,
        utype: None,
        alias_id: None,
        status: "ok",
        origin: origin.clone(),
        origin_kind,
        line: method.line,
    };
    asm.methods.push(entry);

    let mut args_ok = true;
    for arg in &method.args {
        let arg_entry = parse_method_arg(method, arg, &origin, asm);
        asm.methods.last_mut().unwrap().args.push(arg_entry);
        if asm
            .methods
            .last()
            .unwrap()
            .args
            .last()
            .unwrap()
            .utype
            .is_none()
        {
            args_ok = false;
        }
    }
    if !args_ok {
        asm.methods.last_mut().unwrap().status = "arg-load-failed";
        return;
    }

    if asm.all_property_names.contains(&method.name) {
        asm.issues.push(AsmIssue {
            kind: "method-property-name-conflict",
            fatal: true,
            line: Some(method.line),
            message: format!(
                "ScriptDefModule::add{section_label}MethodDescription: There is a property[{}] name conflict!",
                method.name
            ),
        });
        asm.methods.last_mut().unwrap().status = "name-conflict";
        return;
    }
    if asm.component_names.contains(&method.name) {
        asm.issues.push(AsmIssue {
            kind: "method-component-name-conflict",
            fatal: true,
            line: Some(method.line),
            message: format!(
                "ScriptDefModule::add{section_label}MethodDescription: There is a component[{}] name conflict!",
                method.name
            ),
        });
        asm.methods.last_mut().unwrap().status = "name-conflict";
        return;
    }
    if asm
        .method_names_by_section
        .get(method.section)
        .unwrap()
        .contains(&method.name)
    {
        asm.issues.push(AsmIssue {
            kind: "method-name-conflict",
            fatal: true,
            line: Some(method.line),
            message: format!(
                "ScriptDefModule::add{section_label}MethodDescription: [{}] is exist!",
                method.name
            ),
        });
        asm.methods.last_mut().unwrap().status = "name-conflict";
        return;
    }

    let declared = if method.utype > 0 {
        Some(method.utype)
    } else {
        None
    };
    asm.methods.last_mut().unwrap().declared_utype = declared;
    let resolved_utype = match declared {
        Some(declared) => {
            if declared > METHOD_UTYPE_MAX {
                asm.issues.push(AsmIssue {
                    kind: "utype-overflow",
                    fatal: true,
                    line: Some(method.line),
                    message: format!(
                        "EntityDef::loadDef{section_label}Methods: 'Utype' has overflowed({declared} > {METHOD_UTYPE_MAX}), is {}.{}!",
                        asm.entity_name, method.name
                    ),
                });
                asm.methods.last_mut().unwrap().status = "utype-overflow";
                return;
            }
            asm.used_utypes.insert(declared);
            if let Some(holder_name) = asm.holders.get(&declared) {
                asm.issues.push(AsmIssue {
                    kind: "utype-conflict",
                    fatal: true,
                    line: Some(method.line),
                    message: format!(
                        "EntityDef::loadDef{section_label}Methods: {}.{}, 'Utype' {declared} Conflict({}.{} 'Utype' {declared})!",
                        asm.entity_name, method.name, asm.entity_name, holder_name
                    ),
                });
                asm.methods.last_mut().unwrap().status = "utype-conflict";
                return;
            }
            declared
        }
        None => {
            while asm.used_utypes.contains(&asm.auto_counter) {
                asm.auto_counter += 1;
            }
            let utype = asm.auto_counter;
            asm.auto_counter += 1;
            asm.used_utypes.insert(utype);
            utype
        }
    };
    asm.methods.last_mut().unwrap().utype = Some(resolved_utype);
    asm.holders.insert(resolved_utype, method.name.clone());
    asm.method_names_by_section
        .get_mut(method.section)
        .unwrap()
        .insert(method.name.clone());
    asm.all_method_names.insert(method.name.clone());
}

pub(super) fn parse_method_arg(
    method: &MethodView,
    arg: &ArgView,
    origin: &str,
    asm: &mut Assembly,
) -> AsmArg {
    let line = method.line;
    let section_label = section_name(method.section);
    if arg.name != "ARRAY" {
        let utype = lookup_type(&arg.name, asm);
        if utype.is_none() {
            asm.issues.push(AsmIssue {
                kind: "unknown-arg-type",
                fatal: true,
                line: Some(line),
                message: format!(
                    "EntityDef::loadDef{section_label}Methods: dataType[{}] not found, in {}!",
                    arg.name, method.name
                ),
            });
        }
        return AsmArg {
            name: arg.name.clone(),
            of_type: None,
            utype,
            line,
        };
    }

    let inline_name = format!("{}_{}", asm.entity_name, method.name);
    let array_utype = asm.next_type_utype;
    asm.next_type_utype += 1;
    asm.types.push(AsmType {
        name: inline_name.clone(),
        utype: array_utype,
        kind: "inline-array",
        aliased_to: None,
        line: Some(line),
        origin: origin.to_string(),
    });

    let Some(of_type) = arg.of_type.as_deref() else {
        asm.issues.push(AsmIssue {
            kind: "array-of-missing",
            fatal: true,
            line: Some(line),
            message: "FixedArrayType::initialize: not found \"of\".".to_string(),
        });
        asm.issues.push(AsmIssue {
            kind: "unknown-arg-type",
            fatal: true,
            line: Some(line),
            message: format!(
                "EntityDef::loadDef{section_label}Methods: dataType[ARRAY] not found, in {}!",
                method.name
            ),
        });
        return AsmArg {
            name: "ARRAY".to_string(),
            of_type: None,
            utype: None,
            line,
        };
    };

    let element_entry = parse_array_of_type(method, of_type, &inline_name, origin, asm);
    let Some(element_entry) = element_entry else {
        asm.issues.push(AsmIssue {
            kind: "unknown-arg-type",
            fatal: true,
            line: Some(line),
            message: format!(
                "EntityDef::loadDef{section_label}Methods: dataType[ARRAY] not found, in {}!",
                method.name
            ),
        });
        return AsmArg {
            name: "ARRAY".to_string(),
            of_type: None,
            utype: None,
            line,
        };
    };
    AsmArg {
        name: "ARRAY".to_string(),
        of_type: Some(Box::new(element_entry)),
        utype: Some(array_utype),
        line,
    }
}

pub(super) fn parse_array_of_type(
    method: &MethodView,
    of_type: &ArgView,
    parent_name: &str,
    origin: &str,
    asm: &mut Assembly,
) -> Option<AsmArg> {
    let line = method.line;
    if of_type.name == "ARRAY" {
        let child_name = format!("_{parent_name}_ArrayType");
        let child_utype = asm.next_type_utype;
        asm.next_type_utype += 1;
        asm.types.push(AsmType {
            name: child_name.clone(),
            utype: child_utype,
            kind: "inline-array",
            aliased_to: None,
            line: Some(line),
            origin: origin.to_string(),
        });
        if of_type.of_type.is_none() {
            asm.issues.push(AsmIssue {
                kind: "array-of-missing",
                fatal: true,
                line: Some(line),
                message: "FixedArrayType::initialize: not found \"of\".".to_string(),
            });
        }
        let nested = match of_type.of_type.as_deref() {
            Some(inner) => parse_array_of_type(method, inner, &child_name, origin, asm),
            None => None,
        };
        let Some(nested) = nested else {
            asm.issues.push(AsmIssue {
                kind: "array-init-failed",
                fatal: true,
                line: Some(line),
                message: "FixedArrayType::initialize: Array is wrong.".to_string(),
            });
            return None;
        };
        return Some(AsmArg {
            name: "ARRAY".to_string(),
            of_type: Some(Box::new(nested)),
            utype: Some(child_utype),
            line,
        });
    }

    let element_utype = lookup_type(&of_type.name, asm);
    if element_utype.is_none() {
        asm.issues.push(AsmIssue {
            kind: "array-of-unknown-type",
            fatal: true,
            line: Some(line),
            message: format!(
                "FixedArrayType::initialize: key[ARRAY] did not find type[{}]!",
                of_type.name
            ),
        });
        return None;
    }
    Some(AsmArg {
        name: of_type.name.clone(),
        of_type: None,
        utype: element_utype,
        line,
    })
}
