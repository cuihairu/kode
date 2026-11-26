//! `$/kode/dependency/graph` -- def dependency-graph derivation (IDE-RUST-007).
//!
//! Starting from entities registered in entities.xml -> entity def -> Parent (inheritance) / Interfaces (is-a) /
//! Components (has-a slots) / property types (property-type) -> types.xml object classes -> ImplementedBy
//! python implementations (implements) and def method sections -> python implementation files (method-impl).
//! All edges are reverse-indexable (reverseEdges); outputs three paths (entities.xml/defsRoot/types.xml).
//!
//! Boundary: graph-topology derivation belongs to Rust; python file path resolution (script-directory convention + ImplementedBy
//! module resolution, config/filesystem aware) is resolved by TS into a map passed in, not duplicated here.
//!
//! Resolution stance:
//! - def Parent/Interfaces use the Document dual form (text/element, mirroring message_table's
//!   node_value + four-spelling wrapper filtering) -- kode-parser extract_def only recognizes the text form,
//!   the element form (`<Parent><X/></Parent>`) is covered here, same as TS entityDependency.
//! - types.xml object-class dual-form detection (the element form `<X><FIXED_DICT>…` mirrors message_table
//!   load_types_xml; the text form `<X> FIXED_DICT …` follows kode-parser extract_types'
//!   text directive -- the primary form of the real asset types.xml; recognizing only the element form would lose everything).

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Value};

use kode_parser::model::{extract_def, parse_types, TypeKind};
use kode_parser::xml::{parse as parse_xml, Document};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/dependency/graph", graph_handler);
}

fn graph_handler(params: Value) -> Result<Value, String> {
    Ok(build_graph(&params))
}

// ---------------------------------------------------------------------------
// Input extraction (mirrors message_table.rs's defs/paths map pattern)
// ---------------------------------------------------------------------------

fn opt_str(params: &Value, key: &str) -> String {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn string_map(params: &Value, key: &str) -> HashMap<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default()
}

/// pythonFiles value shape: String (single file) or Array (multiple files, one each for base/cell/client).
fn string_list_map(params: &Value, key: &str) -> HashMap<String, Vec<String>> {
    params
        .get(key)
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| {
                    let list = match v {
                        Value::String(s) => vec![s.clone()],
                        Value::Array(arr) => arr
                            .iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect(),
                        _ => Vec::new(),
                    };
                    (k.clone(), list)
                })
                .filter(|(_, list)| !list.is_empty())
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// xml helpers (mirror message_table.rs scalar_child/node_value)
// ---------------------------------------------------------------------------

/// Trim the child element text; empty falls back to the first child element's name; still empty -> None.
fn node_value(doc: &Document, idx: usize, name: &str) -> Option<String> {
    let child = doc.child_element(idx, name)?;
    let text = doc.element(child).text(doc).trim().to_string();
    if !text.is_empty() {
        return Some(text);
    }
    doc.child_elements(child)
        .first()
        .map(|&c| doc.element(c).name.clone())
}

/// Interfaces section: the engine only accepts the four wrapper spellings; naming takes text for text, tag name for elements.
fn parse_interfaces(doc: &Document, root: usize) -> Vec<String> {
    doc.child_element(root, "Interfaces")
        .map(|ifaces| {
            doc.child_elements(ifaces)
                .iter()
                .filter(|&&c| {
                    matches!(
                        doc.element(c).name.as_str(),
                        "interface" | "Interface" | "type" | "Type"
                    )
                })
                .filter_map(|&c| {
                    let text = doc.element(c).text(doc).trim().to_string();
                    if !text.is_empty() {
                        return Some(text);
                    }
                    doc.child_elements(c)
                        .first()
                        .map(|&g| doc.element(g).name.clone())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// types.xml object-class names (FIXED_DICT/ARRAY declarations), union of both forms:
/// - element form (`<X><FIXED_DICT>…`, same detection as message_table load_types_xml);
/// - text form (`<X> FIXED_DICT …`, the engine template's primary form, matching kode-parser
///   extract_types' text directive). Previously only the element form was recognized -- the real asset types.xml
///   is entirely text-form (FIXED_DICT is a text directive, not a child element) -> the object-class set came back empty,
///   losing all property-type/type nodes (found by AUDIT-002 comparison in practice).
fn object_class_names(types_xml: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let doc = parse_xml(types_xml, false);
    if let Some(root) = doc.root() {
        for child in doc.child_elements(root) {
            let name = doc.element(child).name.clone();
            let is_obj = doc.child_element(child, "FIXED_DICT").is_some()
                || doc.child_element(child, "ARRAY").is_some();
            if is_obj {
                names.insert(name);
            }
        }
    }
    for t in parse_types(types_xml).types {
        if matches!(t.kind, TypeKind::FixedDict | TypeKind::Array) {
            names.insert(t.name);
        }
    }
    names
}

// ---------------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Entity,
    Def,
    Interface,
    Component,
    Type,
    Python,
}

impl NodeKind {
    fn as_str(self) -> &'static str {
        match self {
            NodeKind::Entity => "entity",
            NodeKind::Def => "def",
            NodeKind::Interface => "interface",
            NodeKind::Component => "component",
            NodeKind::Type => "type",
            NodeKind::Python => "python",
        }
    }
}

struct Builder {
    /// Node id (ordered) -> node JSON.
    nodes: BTreeMap<String, Value>,
    /// (from, to, kind, label)。
    edges: Vec<(String, String, &'static str, Option<String>)>,
    edge_seen: HashSet<(String, String, &'static str, Option<String>)>,
    visited: HashSet<String>,

    defs: HashMap<String, String>,
    paths: HashMap<String, String>,
    categories: HashMap<String, String>,
    python_files: HashMap<String, Vec<String>>,
    type_impls: HashMap<String, String>,
    /// types.xml object-class name.
    object_classes: HashSet<String>,
    registered: HashSet<String>,

    defs_root: String,
    entities_xml_path: String,
    types_xml_path: String,
}

fn basename_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

impl Builder {
    fn new(params: &Value) -> Self {
        Builder {
            nodes: BTreeMap::new(),
            edges: Vec::new(),
            edge_seen: HashSet::new(),
            visited: HashSet::new(),
            defs: string_map(params, "defs"),
            paths: string_map(params, "paths"),
            categories: string_map(params, "categories"),
            python_files: string_list_map(params, "pythonFiles"),
            type_impls: string_map(params, "typeImpls"),
            object_classes: HashSet::new(),
            registered: HashSet::new(),
            defs_root: opt_str(params, "defsRoot"),
            entities_xml_path: opt_str(params, "entitiesXmlPath"),
            types_xml_path: opt_str(params, "typesXmlPath"),
        }
    }

    fn def_path_of(&self, name: &str) -> String {
        self.paths
            .get(name)
            .cloned()
            .unwrap_or_else(|| format!("{}/{name}.def", self.defs_root))
    }

    /// Looked up in categories; defaults to falling back to hint.
    fn resolve_kind(&self, name: &str, hint: NodeKind) -> NodeKind {
        match self.categories.get(name).map(|s| s.as_str()) {
            Some("entity") | Some("def") => NodeKind::Def,
            Some("interface") => NodeKind::Interface,
            Some("component") => NodeKind::Component,
            _ => hint,
        }
    }

    fn ensure_node(
        &mut self,
        id: &str,
        kind: NodeKind,
        name: &str,
        file_path: &str,
        extra: Option<Value>,
    ) {
        if self.nodes.contains_key(id) {
            return;
        }
        let mut node = json!({
            "id": id,
            "kind": kind.as_str(),
            "name": name,
            "filePath": file_path,
        });
        if let Some(extra) = extra {
            if let Some(obj) = node.as_object_mut() {
                if let Some(extra_obj) = extra.as_object() {
                    for (k, v) in extra_obj {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        self.nodes.insert(id.to_string(), node);
    }

    fn push_edge(&mut self, from: &str, to: &str, kind: &'static str, label: Option<&str>) {
        let key = (
            from.to_string(),
            to.to_string(),
            kind,
            label.map(|s| s.to_string()),
        );
        if self.edge_seen.insert(key) {
            self.edges.push((
                from.to_string(),
                to.to_string(),
                kind,
                label.map(|s| s.to_string()),
            ));
        }
    }

    fn ensure_entity_node(&mut self, name: &str, types: Vec<&str>) {
        let id = format!("entity:{name}");
        let extra = json!({ "types": types });
        let path = self.entities_xml_path.clone();
        self.ensure_node(&id, NodeKind::Entity, name, &path, Some(extra));
    }

    fn ensure_def_node(&mut self, name: &str, hint: NodeKind) {
        let kind = self.resolve_kind(name, hint);
        let id = format!("{}:{name}", kind.as_str());
        let path = self.def_path_of(name);
        self.ensure_node(&id, kind, name, &path, None);
    }

    fn walk_def(&mut self, name: &str, hint: NodeKind) {
        if !self.visited.insert(name.to_string()) {
            return; // cycle guard: already visited
        }
        let text = match self.defs.get(name) {
            Some(t) => t.clone(),
            None => return, // def text missing: stub node only, no recursion
        };
        let kind = self.resolve_kind(name, hint);
        let from_id = format!("{}:{name}", kind.as_str());

        let doc = parse_xml(&text, true);
        let d = extract_def(&doc, &text);
        // Parent/Interfaces dual-form coverage (kode-parser extract_def only recognizes the text form).
        let parent = doc.root().and_then(|r| node_value(&doc, r, "Parent"));
        let interfaces = doc
            .root()
            .map(|r| parse_interfaces(&doc, r))
            .unwrap_or_default();

        // Parent → inheritance
        if let Some(parent) = parent {
            self.ensure_def_node(&parent, NodeKind::Def);
            let pk = self.resolve_kind(&parent, NodeKind::Def);
            let to_id = format!("{}:{parent}", pk.as_str());
            self.push_edge(&from_id, &to_id, "inheritance", None);
            self.walk_def(&parent, NodeKind::Def);
        }

        // Interfaces → is-a
        for iface in &interfaces {
            let ik = self.resolve_kind(iface, NodeKind::Interface);
            let to_id = format!("{}:{iface}", ik.as_str());
            self.ensure_node(
                &to_id,
                NodeKind::Interface,
                iface,
                &self.def_path_of(iface),
                None,
            );
            self.push_edge(&from_id, &to_id, "is-a", None);
            self.walk_def(iface, NodeKind::Interface);
        }

        // Components -> has-a (slot name as label)
        for comp in &d.components {
            let t = comp
                .component_type
                .clone()
                .unwrap_or_else(|| comp.name.clone());
            let ck = self.resolve_kind(&t, NodeKind::Component);
            let to_id = format!("{}:{t}", ck.as_str());
            self.ensure_node(&to_id, NodeKind::Component, &t, &self.def_path_of(&t), None);
            self.push_edge(&from_id, &to_id, "has-a", Some(&comp.name));
            self.walk_def(&t, NodeKind::Component);
        }

        // Properties -> property-type (types.xml object class or entity def)
        for prop in &d.properties {
            for tr in &prop.type_refs {
                if self.object_classes.contains(tr) {
                    let to_id = format!("type:{tr}");
                    let type_path = self.types_xml_path.clone();
                    self.ensure_node(&to_id, NodeKind::Type, tr, &type_path, None);
                    self.push_edge(&from_id, &to_id, "property-type", Some(&prop.name));
                } else if self.defs.contains_key(tr)
                    && !matches!(
                        self.categories.get(tr).map(|s| s.as_str()),
                        Some("interface") | Some("component")
                    )
                {
                    self.ensure_def_node(tr, NodeKind::Def);
                    let dk = self.resolve_kind(tr, NodeKind::Def);
                    let to_id = format!("{}:{tr}", dk.as_str());
                    self.push_edge(&from_id, &to_id, "property-type", Some(&prop.name));
                    self.walk_def(tr, NodeKind::Def);
                }
            }
        }

        // Method sections -> python implementation files
        let has_methods = !d.base_methods.is_empty()
            || !d.cell_methods.is_empty()
            || !d.client_methods.is_empty();
        if has_methods {
            let pys = self.python_files.get(name).cloned().unwrap_or_default();
            for py in pys {
                let py_id = format!("python:{py}");
                let py_name = basename_of(&py);
                self.ensure_node(&py_id, NodeKind::Python, &py_name, &py, None);
                self.push_edge(&from_id, &py_id, "method-impl", None);
            }
        }
    }

    fn build(mut self, params: &Value) -> Value {
        let entities_xml = opt_str(params, "entitiesXml");
        let types_xml = opt_str(params, "typesXml");

        let entities_file = kode_parser::model::parse_entities(&entities_xml);
        self.object_classes = object_class_names(&types_xml);
        for e in &entities_file.entities {
            self.registered.insert(e.name.clone());
        }

        // Starting points: registered entities -> entity node + def node + registration edge + walk_def
        for e in &entities_file.entities {
            let mut types = Vec::new();
            let attr = |key: &str| {
                e.attributes
                    .iter()
                    .find(|(n, _)| n == key)
                    .map(|(_, v)| v == "true" || v == "1" || v.eq_ignore_ascii_case("true"))
                    .unwrap_or(false)
            };
            if attr("hasBase") {
                types.push("Base");
            }
            if attr("hasCell") {
                types.push("Cell");
            }
            if attr("hasClient") {
                types.push("Client");
            }
            self.ensure_entity_node(&e.name, types);
            self.ensure_def_node(&e.name, NodeKind::Def);
            let def_id = format!("def:{}", e.name);
            self.push_edge(&format!("entity:{}", e.name), &def_id, "registration", None);
            self.walk_def(&e.name, NodeKind::Def);
        }

        // ImplementedBy -> python implementation (reverse edge from the type node)
        let impls: Vec<(String, String)> = self
            .type_impls
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (type_name, py) in impls {
            if !self.object_classes.contains(&type_name) {
                continue;
            }
            // Ensure the type:{name} node exists: only the property-type reference path creates type nodes,
            // so if the type is referenced only by ImplementedBy (attached to no entity property), the from end would dangle,
            // rendering as an unstyled implicit node in the frontend mermaid -- create it first, then push the edge.
            let type_id = format!("type:{type_name}");
            let type_path = self.types_xml_path.clone();
            self.ensure_node(&type_id, NodeKind::Type, &type_name, &type_path, None);
            let py_id = format!("python:{py}");
            let py_name = basename_of(&py);
            self.ensure_node(&py_id, NodeKind::Python, &py_name, &py, None);
            self.push_edge(&type_id, &py_id, "implements", None);
        }

        self.finish()
    }

    fn finish(self) -> Value {
        // Reverse index
        let mut reverse: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for (from, to, kind, label) in &self.edges {
            let mut entry = json!({ "from": from, "kind": kind });
            if let Some(label) = label {
                entry["label"] = Value::String(label.clone());
            }
            reverse.entry(to.clone()).or_default().push(entry);
        }

        let nodes: Vec<Value> = self.nodes.values().cloned().collect();
        let edges: Vec<Value> = self
            .edges
            .iter()
            .map(|(from, to, kind, label)| {
                let mut e = json!({ "from": from, "to": to, "kind": kind });
                if let Some(label) = label {
                    e["label"] = Value::String(label.clone());
                }
                e
            })
            .collect();

        // stats: per-kind counts
        let mut c_entity = 0i64;
        let mut c_def = 0i64;
        let mut c_interface = 0i64;
        let mut c_component = 0i64;
        let mut c_type = 0i64;
        let mut c_python = 0i64;
        for n in &nodes {
            match n.get("kind").and_then(|v| v.as_str()).unwrap_or("") {
                "entity" => c_entity += 1,
                "def" => c_def += 1,
                "interface" => c_interface += 1,
                "component" => c_component += 1,
                "type" => c_type += 1,
                "python" => c_python += 1,
                _ => {}
            }
        }
        let stats = json!({
            "nodeCount": nodes.len(),
            "edgeCount": edges.len(),
            "entityCount": c_entity,
            "defCount": c_def,
            "interfaceCount": c_interface,
            "componentCount": c_component,
            "typeCount": c_type,
            "pythonCount": c_python,
        });

        json!({
            "nodes": nodes,
            "edges": edges,
            "reverseEdges": reverse,
            "paths": {
                "entitiesXml": self.entities_xml_path,
                "defsRoot": self.defs_root,
                "typesXml": self.types_xml_path,
            },
            "stats": stats,
        })
    }
}

fn build_graph(params: &Value) -> Value {
    Builder::new(params).build(params)
}
