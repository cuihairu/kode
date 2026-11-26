//! Component-module face analysis and slot registration (TS loadComponents).

use std::collections::HashSet;

use crate::message_table::assembly::{AsmIssue, AsmProperty, AsmType, Assembly};
use crate::message_table::constants::{
    domain_component_type, origin_label, ENTITY_BASE_DATA_FLAGS, ENTITY_CELL_DATA_FLAGS,
    ENTITY_CLIENT_DATA_FLAGS, LIMITED_PROPERTY_NAMES,
};
use crate::message_table::properties::{allocate_property_utype, flag_bits_of};
use crate::message_table::source::Source;
use crate::message_table::views::{CompView, DefView};

// ---------------------------------------------------------------------------

/// Component-module face (approximation of the engine's isComponentModule ScriptDefModule hasX flags).
/// Script-file face of autoMatchCompOwn (scripts/{base,cell}/components/<name>.py)
/// is invisible to pure functions, so approximate from def sections: a non-empty property domain / method section means the corresponding domain is present.
pub(super) struct ComponentModuleFace {
    has_base: bool,
    has_cell: bool,
    has_client: bool,
    base_exposed: bool,
    cell_exposed: bool,
}

impl ComponentModuleFace {
    fn merge(&mut self, other: ComponentModuleFace) {
        self.has_base |= other.has_base;
        self.has_cell |= other.has_cell;
        self.has_client |= other.has_client;
        self.base_exposed |= other.base_exposed;
        self.cell_exposed |= other.cell_exposed;
    }
}

/// Component-module domain face: accumulated recursively from own + interfaces + parents (under components/).
/// Engine load order: loadAllDefDescriptions -> loadInterfaces -> loadParentClass
/// -> autoMatchCompOwn; property domain bits (loadDefPropertys L1150-1160) plus method sections
/// (addBase/Cell/ClientMethodDescription setters) accumulate hasX; autoMatchCompOwn
/// L322-328 approximation: exposed base/cell methods promote client onto the final hasBase/hasCell.
pub(super) fn analyze_component_module(
    type_name: &str,
    source: &Source,
    visited: &mut HashSet<String>,
) -> Option<ComponentModuleFace> {
    let local = source.load_component(type_name)?;
    visited.insert(type_name.to_string());
    let mut face = ComponentModuleFace {
        has_base: false,
        has_cell: false,
        has_client: false,
        base_exposed: false,
        cell_exposed: false,
    };
    merge_def_view_face(&local, &mut face);
    for iface in &local.interfaces {
        if !visited.contains(iface) {
            if let Some(iv) = analyze_component_module(iface, source, visited) {
                face.merge(iv);
            }
        }
    }
    if let Some(parent) = &local.parent {
        if !visited.contains(parent) {
            if let Some(pv) = analyze_component_module(parent, source, visited) {
                face.merge(pv);
            }
        }
    }
    if (face.has_base && face.base_exposed) || (face.has_cell && face.cell_exposed) {
        face.has_client = true;
    }
    Some(face)
}

/// Merge a single component def view into the domain face (property Flags bits + method sections).
pub(super) fn merge_def_view_face(local: &DefView, face: &mut ComponentModuleFace) {
    for property in &local.properties {
        let Some(flags_text) = property.flags.as_deref() else {
            continue;
        };
        let Some(bits) = flag_bits_of(&flags_text.trim().to_ascii_uppercase()) else {
            continue;
        };
        if bits & ENTITY_BASE_DATA_FLAGS > 0 {
            face.has_base = true;
        }
        if bits & ENTITY_CELL_DATA_FLAGS > 0 {
            face.has_cell = true;
        }
        if bits & ENTITY_CLIENT_DATA_FLAGS > 0 {
            face.has_client = true;
        }
    }
    for method in &local.methods {
        match method.section {
            "BaseMethods" => {
                face.has_base = true;
                if method.exposed {
                    face.base_exposed = true;
                }
            }
            "CellMethods" => {
                face.has_cell = true;
                if method.exposed {
                    face.cell_exposed = true;
                }
            }
            "ClientMethods" => {
                face.has_client = true;
            }
            _ => {}
        }
    }
}

/// Engine loadComponents L793-808 fresh-load branch: derive the slot flags string.
/// Starting from ED_FLAG_UNKOWN: hasBase -> BASE (0x40), hasCell -> CELL_PUBLIC (0x01),
/// hasClient→hasBase?BASE_AND_CLIENT(0x20)+hasCell?ENTITY_CLIENT_DATA_FLAGS
/// bit group (0x04|0x08|0x80|0x10).
pub(super) fn derive_component_slot_flags(
    has_base: bool,
    has_cell: bool,
    has_client: bool,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if has_base {
        parts.push("BASE");
    }
    if has_cell {
        parts.push("CELL_PUBLIC");
    }
    if has_client {
        if has_base {
            parts.push("BASE_AND_CLIENT");
        }
        if has_cell {
            parts.push("ENTITY_CLIENT_DATA_FLAGS");
        }
    }
    parts.join("|")
}

/// Slot domain-bit registration set (engine addComponentProperty L864-874: cell -> base -> client,
/// only domains whose flags bits hit get registered).
pub(super) fn slot_domains(has_base: bool, has_cell: bool, has_client: bool) -> Vec<&'static str> {
    let mut domains = Vec::new();
    if has_cell {
        domains.push("cell");
    }
    if has_base {
        domains.push("base");
    }
    if has_client {
        domains.push("client");
    }
    domains
}

pub(super) fn register_component_slot(
    module_name: &str,
    component: &CompView,
    source: &Source,
    asm: &mut Assembly,
) {
    if LIMITED_PROPERTY_NAMES.contains(&component.slot_name.as_str()) {
        asm.issues.push(AsmIssue {
            kind: "property-name-limited",
            fatal: true,
            line: Some(component.line),
            message: format!(
                "EntityDef::loadComponents: '{}' is limited, in module({})!",
                component.slot_name, asm.entity_name
            ),
        });
        return;
    }

    // Component def domain face (missing/structural error -> report issue + fall back to the existing hardcoded three domains, continue leniently
    // same stance as missing parent/interface; the engine fails the whole table in that case, here we follow message_table's
    // existing lenient stance: report issue and continue).
    let (flags, has_client, domains) =
        match analyze_component_module(&component.type_name, source, &mut HashSet::new()) {
            Some(face) => (
                derive_component_slot_flags(face.has_base, face.has_cell, face.has_client),
                face.has_client,
                slot_domains(face.has_base, face.has_cell, face.has_client),
            ),
            None => {
                asm.issues.push(AsmIssue {
                    kind: "component-def-missing",
                    fatal: true,
                    line: Some(component.line),
                    message: format!(
                    "EntityDef::loadComponents: failed to load component:{} (components/{}.def).",
                    component.type_name, component.type_name
                ),
                });
                (
                    "BASE|CELL_PUBLIC|ENTITY_CLIENT_DATA_FLAGS".to_string(),
                    true,
                    vec!["cell", "base", "client"],
                )
            }
        };

    let origin = origin_label(module_name, "own");
    let entry = AsmProperty {
        name: component.slot_name.clone(),
        type_name: Some(component.type_name.clone()),
        flags,
        has_client,
        utype: None,
        declared_utype: None,
        alias_id: None,
        persistent: Some(component.persistent.unwrap_or(true)),
        origin: origin.clone(),
        origin_kind: "own",
        line: component.line,
    };
    asm.properties.push(entry);

    if !asm.seen_component_types.contains(&component.type_name) {
        asm.seen_component_types.insert(component.type_name.clone());
        let utype = asm.next_type_utype;
        asm.next_type_utype += 1;
        asm.types.push(AsmType {
            name: component.type_name.clone(),
            utype,
            kind: "entity-component",
            aliased_to: None,
            line: Some(component.line),
            origin: module_name.to_string(),
        });
    }

    let declared = if component.utype > 0 {
        Some(component.utype)
    } else {
        None
    };
    asm.properties.last_mut().unwrap().declared_utype = declared;
    let Some(utype) = allocate_property_utype(
        declared,
        &component.slot_name,
        &domains,
        component.line,
        asm,
    ) else {
        return;
    };
    asm.properties.last_mut().unwrap().utype = Some(utype);

    if asm.all_method_names.contains(&component.slot_name) {
        asm.issues.push(AsmIssue {
            kind: "property-method-name-conflict",
            fatal: true,
            line: Some(component.line),
            message: format!(
                "ScriptDefModule::addPropertyDescription: There is a method[{}] name conflict! componentType={}.",
                component.slot_name,
                domain_component_type("cell")
            ),
        });
    } else if asm.component_names.contains(&component.slot_name) {
        asm.issues.push(AsmIssue {
            kind: "property-component-name-conflict",
            fatal: true,
            line: Some(component.line),
            message: format!(
                "ScriptDefModule::addPropertyDescription: There is a component[{}] name conflict!",
                component.slot_name
            ),
        });
    } else {
        let mut registered = false;
        for domain in &domains {
            if asm
                .property_domains
                .get_mut(domain)
                .unwrap()
                .contains(&component.slot_name)
            {
                asm.issues.push(AsmIssue {
                    kind: "property-name-conflict",
                    fatal: true,
                    line: Some(component.line),
                    message: format!(
                        "ScriptDefModule::addPropertyDescription: [{}] is exist! componentType={}.",
                        component.slot_name,
                        domain_component_type(domain)
                    ),
                });
                continue;
            }
            asm.property_domains
                .get_mut(domain)
                .unwrap()
                .insert(component.slot_name.clone());
            registered = true;
        }
        if registered {
            asm.all_property_names.insert(component.slot_name.clone());
        }
    }
    asm.component_names.insert(component.slot_name.clone());
}
