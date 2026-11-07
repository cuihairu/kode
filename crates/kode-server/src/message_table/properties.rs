//! 属性 utype/域位/组件槽模拟(TS addPropertyDescription)。

use crate::message_table::assembly::{AsmIssue, AsmProperty, AsmType, Assembly};
use crate::message_table::constants::{
    domain_bits_of, domain_component_type, origin_label, ENTITY_BASE_DATA_FLAGS,
    ENTITY_CELL_DATA_FLAGS, ENTITY_CLIENT_DATA_FLAGS, LIMITED_PROPERTY_NAMES, METHOD_UTYPE_MAX,
    PROPERTY_FLAG_BITS,
};
use crate::message_table::types::lookup_type;
use crate::message_table::views::PropView;

// ---------------------------------------------------------------------------

pub(super) fn simulate_property(
    module_name: &str,
    property: &PropView,
    origin_kind: &'static str,
    root_name: &str,
    asm: &mut Assembly,
) {
    let origin = origin_label(module_name, origin_kind);
    let entry = AsmProperty {
        name: property.name.clone(),
        type_name: property.type_name.clone(),
        flags: String::new(),
        has_client: false,
        utype: None,
        declared_utype: None,
        alias_id: None,
        persistent: None,
        origin: origin.clone(),
        origin_kind,
        line: property.line,
    };
    asm.properties.push(entry);

    if LIMITED_PROPERTY_NAMES.contains(&property.name.as_str()) {
        asm.issues.push(AsmIssue {
            kind: "property-name-limited",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: '{}' is limited, in module({})!",
                property.name, asm.entity_name
            ),
        });
        return;
    }

    let Some(flags_text) = property.flags.as_deref() else {
        asm.issues.push(AsmIssue {
            kind: "property-flags-missing",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount flagsNode, is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    };
    let flags_upper = flags_text.trim().to_ascii_uppercase();
    asm.properties.last_mut().unwrap().flags = flags_upper.clone();
    let Some(flag_bits) = flag_bits_of(&flags_upper) else {
        asm.issues.push(AsmIssue {
            kind: "property-flags-unknown",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount flags[{flags_upper}], is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    };
    // 引擎保留此臂(hasBaseFlags<=0 && hasCellFlags<=0 报错),但 g_entityFlagMapping
    // 全部 12 表项均落在 base∪cell 位集内,查表成功者恒过此关;照形状保留。
    if flag_bits & ENTITY_BASE_DATA_FLAGS <= 0 && flag_bits & ENTITY_CELL_DATA_FLAGS <= 0 {
        asm.issues.push(AsmIssue {
            kind: "property-flags-no-base-cell",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount flags[{flags_upper}], is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    }
    let has_client = flag_bits & ENTITY_CLIENT_DATA_FLAGS > 0;
    let registered_domains: Vec<&'static str> = ["cell", "base", "client"]
        .into_iter()
        .filter(|domain| flag_bits & domain_bits_of(domain) > 0)
        .collect();
    asm.properties.last_mut().unwrap().has_client = has_client;

    let Some(type_name) = property.type_name.as_deref() else {
        asm.issues.push(AsmIssue {
            kind: "property-type-missing",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount TypeNode, is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    };
    if type_name == "ARRAY" {
        let utype = asm.next_type_utype;
        asm.next_type_utype += 1;
        asm.types.push(AsmType {
            name: format!("{}_{}", asm.entity_name, property.name),
            utype,
            kind: "inline-array",
            aliased_to: None,
            line: Some(property.line),
            origin,
        });
    } else if lookup_type(type_name, asm).is_none() {
        asm.issues.push(AsmIssue {
            kind: "property-type-unknown",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "属性 {} 的类型 {} 未注册(types.xml 与基元表均无),引擎静默 return false(无 ERROR_MSG)",
                property.name, type_name
            ),
        });
        return;
    }

    let declared = if property.utype > 0 {
        Some(property.utype)
    } else {
        None
    };
    asm.properties.last_mut().unwrap().declared_utype = declared;
    let utype = allocate_property_utype(
        declared,
        &property.name,
        &registered_domains,
        property.line,
        asm,
    );
    let Some(utype) = utype else {
        return;
    };
    asm.properties.last_mut().unwrap().utype = Some(utype);

    // addPropertyDescription 名字三查,逐域添加时触发
    let first_domain = registered_domains[0];
    let report_add_failure = |asm: &mut Assembly, kind: &'static str, message: String| {
        asm.issues.push(AsmIssue {
            kind,
            fatal: true,
            line: Some(property.line),
            message,
        });
        asm.issues.push(AsmIssue {
            kind,
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::addPropertyDescription({}): {root_name}.",
                asm.entity_name
            ),
        });
    };

    if asm.all_method_names.contains(&property.name) {
        report_add_failure(
            asm,
            "property-method-name-conflict",
            format!(
                "ScriptDefModule::addPropertyDescription: There is a method[{}] name conflict! componentType={}.",
                property.name,
                domain_component_type(first_domain)
            ),
        );
        return;
    }
    if asm.component_names.contains(&property.name) {
        report_add_failure(
            asm,
            "property-component-name-conflict",
            format!(
                "ScriptDefModule::addPropertyDescription: There is a component[{}] name conflict!",
                property.name
            ),
        );
        return;
    }

    let mut name_rejected = false;
    for domain in &registered_domains {
        if asm
            .property_domains
            .get_mut(domain)
            .unwrap()
            .contains(&property.name)
        {
            asm.issues.push(AsmIssue {
                kind: "property-name-conflict",
                fatal: true,
                line: Some(property.line),
                message: format!(
                    "ScriptDefModule::addPropertyDescription: [{}] is exist! componentType={}.",
                    property.name,
                    domain_component_type(domain)
                ),
            });
            name_rejected = true;
            continue;
        }
        asm.property_domains
            .get_mut(domain)
            .unwrap()
            .insert(property.name.clone());
    }
    if name_rejected {
        asm.issues.push(AsmIssue {
            kind: "property-name-conflict",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::addPropertyDescription({}): {root_name}.",
                asm.entity_name
            ),
        });
        return;
    }
    asm.all_property_names.insert(property.name.clone());
}

pub(super) fn flag_bits_of(text: &str) -> Option<i64> {
    PROPERTY_FLAG_BITS
        .iter()
        .find(|(key, _)| *key == text)
        .map(|(_, bits)| *bits)
}

pub(super) fn allocate_property_utype(
    declared: Option<i64>,
    name: &str,
    domains: &[&'static str],
    line: usize,
    asm: &mut Assembly,
) -> Option<i64> {
    if let Some(declared) = declared {
        if declared > METHOD_UTYPE_MAX {
            asm.issues.push(AsmIssue {
                kind: "utype-overflow",
                fatal: true,
                line: Some(line),
                message: format!(
                    "EntityDef::calcDefPropertyUType: 'Utype' has overflowed({declared} > {METHOD_UTYPE_MAX}), is {}.{name}!",
                    asm.entity_name
                ),
            });
            return None;
        }
        if let Some((holder_name, holder_domains)) = asm.property_holders.get(&declared) {
            for domain in domains {
                if holder_domains.contains(domain) {
                    asm.issues.push(AsmIssue {
                        kind: "utype-conflict",
                        fatal: true,
                        line: Some(line),
                        message: format!(
                            "EntityDef::calcDefPropertyUType: {}.{name}, 'Utype' {declared} Conflict({}.{} 'Utype' {declared})!",
                            asm.entity_name, asm.entity_name, holder_name
                        ),
                    });
                }
            }
            return None;
        }
        asm.property_used_utypes.insert(declared);
        asm.property_holders.insert(
            declared,
            (name.to_string(), domains.iter().copied().collect()),
        );
        return Some(declared);
    }
    while asm
        .property_used_utypes
        .contains(&asm.property_auto_counter)
    {
        asm.property_auto_counter += 1;
    }
    let utype = asm.property_auto_counter;
    asm.property_auto_counter += 1;
    asm.property_used_utypes.insert(utype);
    asm.property_holders
        .insert(utype, (name.to_string(), domains.iter().copied().collect()));
    Some(utype)
}
