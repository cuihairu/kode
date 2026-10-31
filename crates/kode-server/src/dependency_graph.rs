//! `$/kode/dependency/graph` —— def 依赖图推导(IDE-RUST-007)。
//!
//! 从 entities.xml 登记实体出发 → 实体 def → Parent(继承)/Interfaces(is-a)/
//! Components(has-a 槽)/属性类型(property-type)→ types.xml 对象类 → ImplementedBy
//! python 实现(implements)与 def 方法段 → python 实现文件(method-impl)。
//! 全部边反向可索引(reverseEdges);输出三路径(entities.xml/defsRoot/types.xml)。
//!
//! 边界:图拓扑推导归 Rust;python 文件路径解析(脚本目录约定 + ImplementedBy
//! 模块解析,配置/文件系统感知)由 TS 解析成 map 传入,不在此重复。
//!
//! 解析口径:
//! - def Parent/Interfaces 用 Document 双形态(文本/元素,镜像 message_table 的
//!   node_value + wrapper 四拼写过滤)——kode-parser extract_def 只认文本形态,
//!   元素形态(`<Parent><X/></Parent>`)在此覆盖,与 TS entityDependency 同。
//! - types.xml 对象类用元素形态检测(`<X><FIXED_DICT>…` / `<X><ARRAY>…`,镜像
//!   message_table load_types_xml)——kode-parser extract_types 只认文本指引。

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Value};

use kode_parser::model::extract_def;
use kode_parser::xml::{parse as parse_xml, Document};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/dependency/graph", graph_handler);
}

fn graph_handler(params: Value) -> Result<Value, String> {
    Ok(build_graph(&params))
}

// ---------------------------------------------------------------------------
// 入参提取(镜像 message_table.rs 的 defs/paths map 模式)
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

/// pythonFiles 值形态:String(单文件)或 Array(多文件,base/cell/client 各一)。
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
// xml 辅助(镜像 message_table.rs scalar_child/node_value)
// ---------------------------------------------------------------------------

/// 子元素文本 trim;空回落首个子元素名;仍空 → None。
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

/// Interfaces 段:引擎只认 wrapper 四拼写,取名文本取文本、元素取标签名。
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

/// types.xml 对象类名(FIXED_DICT/ARRAY 元素子节点,与 message_table 同检测)。
fn object_class_names(types_xml: &str) -> HashSet<String> {
    let doc = parse_xml(types_xml, false);
    let mut names = HashSet::new();
    let Some(root) = doc.root() else {
        return names;
    };
    for child in doc.child_elements(root) {
        let name = doc.element(child).name.clone();
        let is_obj = doc.child_element(child, "FIXED_DICT").is_some()
            || doc.child_element(child, "ARRAY").is_some();
        if is_obj {
            names.insert(name);
        }
    }
    names
}

// ---------------------------------------------------------------------------
// 图模型
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
    /// 节点 id(有序)→ 节点 JSON。
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
    /// types.xml 对象类名。
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

    /// categories 查表,缺省回落 hint。
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
        let key = (from.to_string(), to.to_string(), kind, label.map(|s| s.to_string()));
        if self.edge_seen.insert(key) {
            self.edges
                .push((from.to_string(), to.to_string(), kind, label.map(|s| s.to_string())));
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
            return; // 环守卫:已走过
        }
        let text = match self.defs.get(name) {
            Some(t) => t.clone(),
            None => return, // 缺 def 文本:仅 stub 节点,不递归
        };
        let kind = self.resolve_kind(name, hint);
        let from_id = format!("{}:{name}", kind.as_str());

        let doc = parse_xml(&text, true);
        let d = extract_def(&doc, &text);
        // Parent/Interfaces 双形态覆盖(kode-parser extract_def 只认文本形态)。
        let parent = doc.root().and_then(|r| node_value(&doc, r, "Parent"));
        let interfaces = doc.root().map(|r| parse_interfaces(&doc, r)).unwrap_or_default();

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
            self.ensure_node(&to_id, NodeKind::Interface, iface, &self.def_path_of(iface), None);
            self.push_edge(&from_id, &to_id, "is-a", None);
            self.walk_def(iface, NodeKind::Interface);
        }

        // Components → has-a(槽名 label)
        for comp in &d.components {
            let t = comp.component_type.clone().unwrap_or_else(|| comp.name.clone());
            let ck = self.resolve_kind(&t, NodeKind::Component);
            let to_id = format!("{}:{t}", ck.as_str());
            self.ensure_node(&to_id, NodeKind::Component, &t, &self.def_path_of(&t), None);
            self.push_edge(&from_id, &to_id, "has-a", Some(&comp.name));
            self.walk_def(&t, NodeKind::Component);
        }

        // Properties → property-type(types.xml 对象类或实体 def)
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

        // 方法段 → python 实现文件
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

        // 起点:登记实体 → entity 节点 + def 节点 + registration 边 + walk_def
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

        // ImplementedBy → python 实现(type 节点反向边)
        let impls: Vec<(String, String)> = self
            .type_impls
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (type_name, py) in impls {
            if !self.object_classes.contains(&type_name) {
                continue;
            }
            let py_id = format!("python:{py}");
            let py_name = basename_of(&py);
            self.ensure_node(&py_id, NodeKind::Python, &py_name, &py, None);
            self.push_edge(&format!("type:{type_name}"), &py_id, "implements", None);
        }

        self.finish()
    }

    fn finish(self) -> Value {
        // 反向索引
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

        // stats:各 kind 计数
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
