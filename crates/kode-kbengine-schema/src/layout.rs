//! Project-side layout extraction: types.xml / alias.xml → the alias wire-type table;
//! entities.xml + .def → the entity wire-format entries (todo PA-002 "Wire Type Layout").
//!
//! Division of labor with the kode-types type graph: the type graph (`kode_types::graph`)
//! answers script semantics (reference edges / alias chains / inheritance chains); this module
//! evaluates recursively **independently** per the network serialization rules into
//! [`WireType`]. The type graph ≠ the network serialization rules (PA-002 acceptance text); the
//! two do not share evaluation.

use std::collections::BTreeMap;
use std::path::Path;

use kode_parser::model::{parse_entities, DefFile, MethodDef, PropertyDef};
use kode_parser::xml::{self, NodeData};
use kode_types::builtin;

use crate::schema::{EntityMethodWire, EntityPropertyWire, EntityWireInfo};
use crate::wire::{builtin_wire_type, DictField, WireType, MAX_TYPE_DEPTH};

/// The raw alias table (name → wire type; evaluation results are recursively expanded; cycles →
/// Unresolved).
pub type AliasMap = BTreeMap<String, WireType>;

/// The raw declarations from types.xml + alias.xml (XML layer; collect first, evaluate later).
#[derive(Debug, Default)]
pub struct RawTypes {
    /// name → directive (builtin name / FIXED_DICT / ARRAY).
    directives: BTreeMap<String, RawDecl>,
}

#[derive(Debug)]
struct RawDecl {
    directive: String,
    /// FIXED_DICT: field declaration order (field name, type reference or inline ARRAY element
    /// reference).
    dict_fields: Vec<(String, Option<String>)>,
    /// FIXED_DICT: the implementedBy verbatim.
    implemented_by: Option<String>,
    /// ARRAY: the `<of>` element reference.
    of: Option<String>,
}

pub fn collect_raw_types(types_xml: &str, alias_xml: Option<&str>) -> RawTypes {
    let mut out = RawTypes {
        directives: BTreeMap::new(),
    };
    collect_types_xml(types_xml, &mut out);
    if let Some(alias) = alias_xml {
        collect_alias_xml(alias, &mut out);
    }
    out
}

fn collect_types_xml(text: &str, out: &mut RawTypes) {
    let doc = xml::parse(text, false);
    let root = match doc.root() {
        Some(r) => r,
        None => return,
    };
    for child in doc.child_elements(root) {
        let el = doc.element(child);
        let name = el.name.clone();
        if name == "root" {
            continue;
        }
        // The first non-empty text token = the directive (FIXED_DICT/ARRAY/builtin name); if empty,
        // fall back to the type attribute.
        let mut directive = el
            .text(&doc)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        if directive.is_empty() {
            directive = el
                .attribute("type")
                .map(|a| a.value.trim().to_string())
                .unwrap_or_default();
        }
        if directive.is_empty() {
            continue;
        }
        let mut decl = RawDecl {
            directive: directive.to_ascii_uppercase(),
            dict_fields: Vec::new(),
            implemented_by: None,
            of: None,
        };
        if decl.directive == "FIXED_DICT" {
            if let Some(ib) = doc.child_element(child, "implementedBy") {
                let t = doc.element(ib).text(&doc).trim().to_string();
                if !t.is_empty() {
                    decl.implemented_by = Some(t);
                }
            }
            if let Some(props) = doc.child_element(child, "Properties") {
                for &prop in &doc.element(props).children {
                    if let NodeData::Element(prop_el) = &doc.nodes[prop].data {
                        let field_name = prop_el.name.clone();
                        let field_type = doc.child_element(prop, "Type");
                        let field_ref = field_type.and_then(|t| {
                            let te = doc.element(t);
                            // The array element is written as the <of> inside <Type>; otherwise take the first token
                            // of the Type text.
                            doc.child_element(t, "of")
                                .map(|of| doc.element(of).text(&doc).trim().to_string())
                                .filter(|s| !s.is_empty())
                                .or_else(|| {
                                    te.text(&doc).split_whitespace().next().map(str::to_string)
                                })
                        });
                        decl.dict_fields.push((field_name, field_ref));
                    }
                }
            }
        } else if decl.directive == "ARRAY" {
            decl.of = doc
                .child_element(child, "of")
                .map(|of| doc.element(of).text(&doc).trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    el.attribute("of")
                        .map(|a| a.value.trim().to_string())
                        .filter(|s| !s.is_empty())
                });
        }
        out.directives.insert(name, decl);
    }
}

/// alias.xml (`<Name><Type> T </Type></Name>` association table; the kode-parser `parse_alias`
/// semantics as a wire type version: name → target reference).
fn collect_alias_xml(text: &str, out: &mut RawTypes) {
    let doc = xml::parse(text, false);
    let root = match doc.root() {
        Some(r) => r,
        None => return,
    };
    for child in doc.child_elements(root) {
        let el = doc.element(child);
        let name = el.name.clone();
        if name == "root" {
            continue;
        }
        let target = doc
            .child_element(child, "Type")
            .map(|t| doc.element(t).text(&doc).trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                doc.child_elements(child)
                    .into_iter()
                    .find(|&c| doc.element(c).name != "Type")
                    .map(|c| doc.element(c).name.clone())
            })
            .or_else(|| el.text(&doc).split_whitespace().next().map(str::to_string));
        let Some(target) = target else { continue };
        out.directives.insert(
            name,
            RawDecl {
                directive: target,
                dict_fields: Vec::new(),
                implemented_by: None,
                of: None,
            },
        );
    }
}

/// Recursive evaluation: reference name → wire type. Builtin names map directly; custom names
/// look up the declaration table; cycles/missing → Unresolved (depth cap [`MAX_TYPE_DEPTH`], never
/// infinite recursion).
pub fn resolve_ref(raw: &RawTypes, ref_name: &str, depth: usize) -> WireType {
    if depth > MAX_TYPE_DEPTH {
        return WireType::Unresolved(format!("{ref_name} (depth limit)"));
    }
    let trimmed = ref_name.trim();
    if let Some(b) = builtin_wire_type(trimmed) {
        return b;
    }
    match raw.directives.get(trimmed) {
        None => WireType::Unresolved(trimmed.to_string()),
        Some(decl) => match decl.directive.as_str() {
            "ARRAY" => {
                let of = decl
                    .of
                    .as_deref()
                    .map(|o| resolve_ref(raw, o, depth + 1))
                    .unwrap_or_else(|| WireType::Unresolved("ARRAY <of> missing".into()));
                WireType::Array { of: Box::new(of) }
            }
            "FIXED_DICT" => {
                let fields = decl
                    .dict_fields
                    .iter()
                    .map(|(name, ty_ref)| DictField {
                        name: name.clone(),
                        ty: Box::new(match ty_ref {
                            Some(r) => resolve_ref(raw, r, depth + 1),
                            None => WireType::Unresolved(format!("{name} <Type> missing")),
                        }),
                    })
                    .collect();
                WireType::FixedDict {
                    module: decl.implemented_by.clone(),
                    fields,
                }
            }
            // Alias chains (ITEM_ID → UINT16 / custom → custom): keep recursing; cycles fall
            // back to Unresolved via the depth cap.
            other => resolve_ref(raw, other, depth + 1),
        },
    }
}

/// Whole-table evaluation (order = declaration order; diagnostics: cycles/missing land one by one
/// as `Unresolved`, no failure).
pub fn resolve_alias_map(raw: &RawTypes) -> AliasMap {
    let mut out = AliasMap::new();
    for name in raw.directives.keys() {
        let mut ty = resolve_ref(raw, name, 0);
        if let WireType::Unresolved(msg) = &ty {
            if msg.contains("depth limit") {
                ty = WireType::Unresolved(format!("{name} (alias cycle)"));
            }
        }
        out.insert(name.clone(), ty);
    }
    out
}

// ---------------------------------------------------------------------------
// .def → entity wire format
// ---------------------------------------------------------------------------

/// Merge order: parent .def → interface .def → own (the engine's EntityDef load order; first-come
/// for same-name properties, own overrides parent).
fn merged_def(
    entity_name: &str,
    load_def: &mut dyn FnMut(&str) -> Option<DefFile>,
) -> Option<DefFile> {
    let own = load_def(entity_name)?;
    let mut props: Vec<PropertyDef> = Vec::new();
    let mut base: Vec<MethodDef> = Vec::new();
    let mut cell: Vec<MethodDef> = Vec::new();
    let mut client: Vec<MethodDef> = Vec::new();

    let mut push_def = |d: &DefFile, props: &mut Vec<PropertyDef>| {
        for p in &d.properties {
            if !props.iter().any(|q| q.name == p.name) {
                props.push(p.clone());
            }
        }
        for (src, dst) in [
            (&d.base_methods, &mut base),
            (&d.cell_methods, &mut cell),
            (&d.client_methods, &mut client),
        ] {
            for m in src {
                if !dst.iter().any(|q| q.name == m.name) {
                    dst.push(m.clone());
                }
            }
        }
    };

    if let Some(parent) = &own.parent {
        if let Some(pd) = load_def(parent) {
            push_def(&pd, &mut props);
        }
    }
    for iface in &own.interfaces {
        if let Some(id) = load_def(iface) {
            push_def(&id, &mut props);
        }
    }
    push_def(&own, &mut props);

    let mut out = own.clone();
    out.properties = props;
    out.base_methods = base;
    out.cell_methods = cell;
    out.client_methods = client;
    Some(out)
}

/// One .def semantic view → the entity wire-format entry (properties/method arguments all
/// recursively evaluated to wire types).
pub fn entity_wire_info(
    entity_name: &str,
    load_def: &mut dyn FnMut(&str) -> Option<DefFile>,
    raw: &RawTypes,
) -> Option<EntityWireInfo> {
    let def = merged_def(entity_name, load_def)?;
    let ty = |ref_name: &str| resolve_ref(raw, ref_name, 0);

    let properties = def
        .properties
        .iter()
        .map(|p| EntityPropertyWire {
            name: p.name.clone(),
            ty: p
                .type_refs
                .first()
                .map(|r| ty(r))
                .unwrap_or_else(|| WireType::Unresolved(format!("{} <Type> missing", p.name))),
            flags: p.flags.clone(),
        })
        .collect();

    let conv = |ms: &[MethodDef]| -> Vec<EntityMethodWire> {
        ms.iter()
            .map(|m| EntityMethodWire {
                name: m.name.clone(),
                exposed: m.exposed,
                args: m.args.iter().map(|a| ty(a)).collect(),
            })
            .collect()
    };

    Some(EntityWireInfo {
        name: entity_name.to_string(),
        parent: def.parent.clone(),
        interfaces: def.interfaces.clone(),
        volatile: def.volatile,
        properties,
        base_methods: conv(&def.base_methods),
        cell_methods: conv(&def.cell_methods),
        client_methods: conv(&def.client_methods),
    })
}

/// Helper for loading .def semantics: file name (without directory, without suffix) → the
/// entity/interface name.
pub fn def_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.strip_suffix(".def").unwrap_or(n).to_string())
}

/// Reads the entity registration attributes (hasClient and the like) from entities.xml.
pub fn entity_registered(entities_xml: &str) -> Vec<(String, Vec<(String, String)>)> {
    parse_entities(entities_xml)
        .entities
        .iter()
        .map(|e| (e.name.clone(), e.attributes.clone()))
        .collect()
}

/// Builtin transparent forwarding (the kode-types reuse surface; keeps the alias classification
/// semantics consistent).
pub fn is_builtin_type(name: &str) -> bool {
    builtin::is_builtin(name)
}
