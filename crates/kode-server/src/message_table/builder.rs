//! Main MessageTable build and recursive def loading flow.

use std::collections::HashMap;

use serde_json::Value;

use crate::message_table::aliases::assign_alias_ids;
use crate::message_table::assembly::{AsmIssue, AsmSource, AsmType, Assembly};
use crate::message_table::components::register_component_slot;
use crate::message_table::constants::{
    normalize_source_key, METHOD_LOAD_ORDER, PRIMITIVE_TYPE_UTYPES,
};
use crate::message_table::json::{
    IssueJson, MethodJson, PropertyJson, SourceJson, TableJson, TypeJson,
};
use crate::message_table::methods::simulate_method;
use crate::message_table::properties::simulate_property;
use crate::message_table::render::{iso_now, method_to_json, property_to_json};
use crate::message_table::source::Source;
use crate::message_table::types::load_types_xml;
use crate::message_table::views::DefView;

// ---------------------------------------------------------------------------
// Main build
// ---------------------------------------------------------------------------

/// TS buildMessageTable: primitive table registration -> types.xml user types -> recursive merge of own def
/// -> aliasID assignment -> aggregated JSON. Structural error in own def -> null (same path as TS loadDef
/// throwing; no table produced).
pub(super) fn build_table(params: &Value) -> Result<Value, String> {
    let entity_name = params
        .get("entityName")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "messageTable/build: missing entityName".to_string())?;
    let def_text = params
        .get("defText")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "messageTable/build: missing defText".to_string())?;
    let types_xml = params.get("typesXml").and_then(|v| v.as_str());
    let defs = params
        .get("defs")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let paths = params
        .get("paths")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let alias_id_enabled = params
        .get("aliasIdEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let source = Source {
        entity_name,
        def_text,
        defs: &defs,
        paths: &paths,
    };

    // Structural error in own def: TS source.loadDef(entityName,'entity') throws -> null (no table produced)
    let Some(own) = source.load(entity_name) else {
        return Ok(Value::Null);
    };

    let mut asm = Assembly::new(entity_name);
    for (name, utype) in PRIMITIVE_TYPE_UTYPES {
        asm.registry.insert(name.to_string(), *utype);
        asm.types.push(AsmType {
            name: (*name).to_string(),
            utype: *utype,
            kind: "primitive",
            aliased_to: None,
            line: None,
            origin: String::new(),
        });
    }
    asm.next_type_utype = PRIMITIVE_TYPE_UTYPES.len() as i64 + 1;
    if let Some(xml) = types_xml {
        load_types_xml(entity_name, xml, &mut asm);
    }

    load_def_into_module(entity_name, own, "own", &source, &mut asm);
    assign_alias_ids(&mut asm, alias_id_enabled);

    let fatal_count = asm.issues.iter().filter(|i| i.fatal).count();
    let methods: Vec<MethodJson> = asm.methods.iter().map(method_to_json).collect();
    let properties: Vec<PropertyJson> = asm.properties.iter().map(property_to_json).collect();
    let types: Vec<TypeJson> = asm
        .types
        .iter()
        .map(|t| TypeJson {
            name: t.name.clone(),
            utype: t.utype,
            kind: t.kind.to_string(),
            aliased_to: t.aliased_to.clone(),
            line: t.line,
            origin: t.origin.clone(),
        })
        .collect();
    let table = TableJson {
        module: entity_name.to_string(),
        generated_at: iso_now(),
        alias_id_enabled,
        load_failed: fatal_count > 0,
        fatal_count,
        sources: asm
            .sources
            .iter()
            .map(|s| SourceJson {
                name: s.name.clone(),
                kind: s.kind.to_string(),
                file_path: s.file_path.clone(),
            })
            .collect(),
        client_methods: methods
            .iter()
            .filter(|m| m.visible_to_client)
            .cloned()
            .collect(),
        methods,
        client_properties: properties
            .iter()
            .filter(|p| p.has_client)
            .cloned()
            .collect(),
        properties,
        types,
        issues: asm
            .issues
            .iter()
            .map(|i| IssueJson {
                kind: i.kind.to_string(),
                message: i.message.clone(),
                fatal: i.fatal,
                line: i.line,
            })
            .collect(),
    };
    serde_json::to_value(&table).map_err(|e| e.to_string())
}

/// Merge a single def into the module (TS loadDefIntoModule): properties -> Cell -> Base -> client methods
/// -> (non-interface) recursion in interface declaration order -> component slots -> parent recursion.
pub(super) fn load_def_into_module(
    module_name: &str,
    local: DefView,
    origin_kind: &'static str,
    source: &Source,
    asm: &mut Assembly,
) {
    let visit_key = normalize_source_key(source.path_of(module_name));
    // Cycle guard only covers entities (own + parent chain); interfaces are not covered (engine loadInterfaces re-declares
    // fully on each load; name collision reports [X] is exist!; the early return at the interface tail leaves no cycle risk).
    if origin_kind != "interface" && asm.visited.contains(&visit_key) {
        asm.issues.push(AsmIssue {
            kind: "parent-cycle",
            fatal: true,
            line: local.parent_line,
            message: format!(
                "父类链成环:{} 装载中重入 {}(引擎递归装载无法终止,kode 截断该分支)",
                asm.entity_name, module_name
            ),
        });
        return;
    }
    asm.sources.push(AsmSource {
        name: module_name.to_string(),
        kind: origin_kind,
        file_path: source.path_of(module_name).to_string(),
    });
    if origin_kind != "interface" {
        asm.visited.insert(visit_key);
    }

    let root_name = local.root_name.clone();
    for property in &local.properties {
        simulate_property(module_name, property, origin_kind, &root_name, asm);
    }
    for section in METHOD_LOAD_ORDER {
        for method in local.methods.iter().filter(|m| m.section == *section) {
            simulate_method(module_name, method, origin_kind, asm);
        }
    }

    // Interface defs only merge properties + methods (engine loadInterfaces does not recurse into the interface itself)
    if origin_kind == "interface" {
        return;
    }

    for interface_ref in &local.interfaces {
        if let Some(interface_local) = source.load(interface_ref) {
            load_def_into_module(interface_ref, interface_local, "interface", source, asm);
        } else {
            asm.issues.push(AsmIssue {
                kind: "interface-file-missing",
                fatal: true,
                line: None,
                message: format!(
                    "EntityDef::loadDefInfo: failed to load entity:{interface_ref} interface."
                ),
            });
        }
    }

    // Component slot registration (loadComponents runs after interfaces, before parents)
    for component in &local.components {
        register_component_slot(module_name, component, source, asm);
    }

    if let Some(parent_name) = &local.parent {
        if let Some(parent_local) = source.load(parent_name) {
            load_def_into_module(parent_name, parent_local, "parent", source, asm);
        } else {
            asm.issues.push(AsmIssue {
                kind: "parent-file-missing",
                fatal: true,
                line: None,
                message: format!(
                    "EntityDef::loadDefInfo: failed to load entity:{parent_name} parentClass."
                ),
            });
        }
    }
}
