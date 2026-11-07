//! Python 语义模型核心(KODE-MCP-KB-002 P1)。
//!
//! `.def` + `types.xml` + `.py` 是**同一套 Python 类型系统**的三个信息源
//! (用户 2026-11-08 架构令),本面把它们统一成可查询的语义模型:
//!
//! - **类型解析**:def 属性 / types.xml 类型的 `type_name` → Python 类型
//!   表达式(ARRAY→`list[T]`、FIXED_DICT→`dict`/实现类、内建→int/float/
//!   str/bool/bytes、别名链展开),带解析路径 `via`。
//! - **置信度**:已确定(内建标量)/推断(types.xml 结构/implementedBy)/
//!   未知(PYTHON 动态、未解析名)。绝不把动态类型当确定类型返回。
//! - **implementedBy**:FIXED_DICT 的 `implementedBy="MODULE.Class"` 实际
//!   Python 内存对象可能是自定义类;在 `scripts/` 里找同名类并关联。
//! - **统一符号查找**(`find_symbol`):实体/实体属性/types.xml 类型/Python
//!   符号一张表,属性带解析后的 Python 类型。
//! - **索引状态**(`index_status`):扫描面、符号数、置信度分布、解析错误。
//!
//! 边界(诚实):只覆盖 `scripts/` 的 Python 域 + 已解析 def/types.xml 内存
//! 模型(不复解析);调用图/数据流面在 kode-python,本面不重复。Tantivy/
//! SQLite 持久化、增量更新、Excel、向量语义为后续阶段(见设计文档 §12)。

use std::path::Path;

use kode_parser::model::TypeKind;
use serde_json::{json, Value};

use crate::code_index::{collect_symbols, PySymbol};
use crate::kb::AssetKnowledge;

/// 类型置信度(用户令:区分已确定/推断/未知,不向 AI 返回错误确定性结论)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confidence {
    /// 静态确定(内建标量:int/float/str/bool/bytes 等)。
    Determined,
    /// 一致推断(def+types.xml+py 一致可得;types.xml 结构、implementedBy 类)。
    Inferred,
    /// 未知(PYTHON 动态、未解析名、动态属性)。
    Unknown,
}

impl Confidence {
    fn as_str(&self) -> &'static str {
        match self {
            Confidence::Determined => "determined",
            Confidence::Inferred => "inferred",
            Confidence::Unknown => "unknown",
        }
    }
}

/// 解析结果:Python 类型表达式 + 置信度 + 解析路径。
#[derive(Debug, Clone)]
pub struct ResolvedPyType {
    pub display: String,
    pub confidence: Confidence,
    pub via: Vec<String>,
}

/// 内建标量 → Python 类型(已确定)。KBEngine 内建名见 wire_codec builtin.rs
/// 全 21 项;PYTHON 系 = pickle 动态(未知)。
fn builtin_py(name: &str) -> Option<(String, Confidence)> {
    Some(match name {
        "UINT8" | "UINT16" | "UINT32" | "UINT64" => ("int".into(), Confidence::Determined),
        "INT8" | "INT16" | "INT32" | "INT64" => ("int".into(), Confidence::Determined),
        "FLOAT" | "DOUBLE" => ("float".into(), Confidence::Determined),
        "BOOL" => ("bool".into(), Confidence::Determined),
        "STRING" | "UNICODE" => ("str".into(), Confidence::Determined),
        "BLOB" => ("bytes".into(), Confidence::Determined),
        "VECTOR2" => ("Vector2".into(), Confidence::Determined),
        "VECTOR3" => ("Vector3".into(), Confidence::Determined),
        "VECTOR4" => ("Vector4".into(), Confidence::Determined),
        "ENTITYCALL" => ("EntityCall".into(), Confidence::Unknown),
        "PYTHON" | "PY_DICT" | "PY_TUPLE" | "PY_LIST" => ("Any".into(), Confidence::Unknown),
        _ => return None,
    })
}

/// implementedBy 符号 → 实现类。两种形态(用户令:引擎按「模块路径.实现对象」
/// 装载,实现对象可能是类也可能是指向实例的模块级赋值):
/// 1. `MODULE.Class` / `Class` 直接是类名。
/// 2. `MODULE.inst` = 模块级 `inst = Class()` 实例赋值 → 解出 `Class`。
fn find_py_class<'a>(py: &'a [PySymbol], impl_symbol: &str) -> Option<&'a PySymbol> {
    // XML 文本节点可能带空白(<implementedBy> MODULE.inst </implementedBy>)。
    let impl_symbol = impl_symbol.trim();
    let last = impl_symbol.rsplit('.').next().unwrap_or(impl_symbol);
    py.iter().find(|s| s.kind == "class" && s.name == last)
}

/// implementedBy 的类名(类形态或实例赋值形态;找不到 → None,如实)。
fn implemented_by_class(py: &[PySymbol], root: &Path, impl_symbol: &str) -> Option<String> {
    let impl_symbol = impl_symbol.trim();
    if let Some(cls) = find_py_class(py, impl_symbol) {
        return Some(cls.name.clone());
    }
    instance_assigned_class(root, impl_symbol)
}

/// `MODULE.inst` 实例赋值形态:`inst = Class()` → 类名。两种入口:
/// - 带点号(`MODULE.inst`,parser 保留模块):按模块文件定位后扫描。
/// - 无点号(parser 归一为对象名 `inst`):全 scripts 扫对象名(有界)。
///
/// 实例对象名 ≠ 类名(夹具:weapon_skill_slot_list_inst = weapon_skill_slot_list())。
fn instance_assigned_class(root: &Path, impl_symbol: &str) -> Option<String> {
    let impl_symbol = impl_symbol.trim();
    if let Some((module, inst)) = impl_symbol.rsplit_once('.') {
        let file = crate::code_index::find_module(root, module.trim())?;
        let source = std::fs::read_to_string(file).ok()?;
        return crate::code_index::instance_class_in_source(&source, inst);
    }
    crate::code_index::find_instance_class(root, impl_symbol)
}

/// 类型名 → Python 类型表达式(递归展开;深度护栏防环)。
/// `via` 收集解析路径(types.xml/alias.xml 名),供 AI 追因。
fn resolve_py_type(
    kb: &AssetKnowledge,
    py: &[PySymbol],
    root: &Path,
    name: &str,
    depth: usize,
    via: &mut Vec<String>,
) -> ResolvedPyType {
    if depth > 8 {
        return ResolvedPyType {
            display: "Any".into(),
            confidence: Confidence::Unknown,
            via: via.clone(),
        };
    }
    if let Some((display, confidence)) = builtin_py(name) {
        return ResolvedPyType {
            display,
            confidence,
            via: via.clone(),
        };
    }
    if let Some(decl) = kb.types.types.iter().find(|t| t.name == name) {
        via.push(format!("types.xml:{name}"));
        return match decl.kind {
            TypeKind::Builtin => {
                if let Some(target) = &decl.directive {
                    return resolve_py_type(kb, py, root, target, depth + 1, via);
                }
                ResolvedPyType {
                    display: name.into(),
                    confidence: Confidence::Unknown,
                    via: via.clone(),
                }
            }
            TypeKind::Array => {
                let elem = decl.element_ref.as_deref().unwrap_or("STRING");
                let inner = resolve_py_type(kb, py, root, elem, depth + 1, via);
                // ARRAY 容器是 types.xml 结构(非内建)→ 至少推断;元素未知
                // 则整体未知(不虚构 list[Any] 为确定)。
                let confidence = inner.confidence.max(Confidence::Inferred);
                ResolvedPyType {
                    display: format!("list[{}]", inner.display),
                    confidence,
                    via: via.clone(),
                }
            }
            TypeKind::FixedDict => {
                if let Some(impl_symbol) = &decl.implemented_by_symbol {
                    if let Some(cls) = implemented_by_class(py, root, impl_symbol) {
                        // implementedBy → 自定义 Python 类(类形态或实例赋值形态)。
                        via.push(format!("implementedBy:{impl_symbol}"));
                        ResolvedPyType {
                            display: cls,
                            confidence: Confidence::Inferred,
                            via: via.clone(),
                        }
                    } else {
                        // 类型声明已知,实现类未在 scripts/ 找到(如实推断)。
                        via.push(format!("implementedBy:{impl_symbol}(class-not-found)"));
                        ResolvedPyType {
                            display: name.into(),
                            confidence: Confidence::Inferred,
                            via: via.clone(),
                        }
                    }
                } else {
                    ResolvedPyType {
                        display: "dict".into(),
                        confidence: Confidence::Inferred,
                        via: via.clone(),
                    }
                }
            }
        }
    } else if let Some(alias) = kb.alias.aliases.iter().find(|a| a.name == name) {
        via.push(format!("alias.xml:{name}"));
        return resolve_py_type(kb, py, root, &alias.alias_type, depth + 1, via);
    }
    // 未解析:如实未知,不虚构。
    ResolvedPyType {
        display: name.into(),
        confidence: Confidence::Unknown,
        via: via.clone(),
    }
}

/// 公开类型解析(一次符号表构建;供 find_symbol/属性问答复用)。
fn resolve(kb: &AssetKnowledge, py: &[PySymbol], root: &Path, name: &str) -> ResolvedPyType {
    resolve_py_type(kb, py, root, name, 0, &mut Vec::new())
}

fn py_match_json(sym: &PySymbol) -> Value {
    let mut entry = json!({
        "name": sym.name,
        "kind": sym.kind,
        "file": sym.file.to_string_lossy(),
        "line": sym.line,
    });
    if let Some(class) = &sym.class {
        entry["class"] = Value::String(class.clone());
    }
    entry
}

/// `find_symbol`:统一符号查找——实体 / 实体属性 / types.xml 类型 /
/// Python 符号一张表。属性带解析后的 Python 类型 + 置信度 + 解析路径。
pub fn find_symbol(
    kb: &AssetKnowledge,
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty symbol query".to_string());
    }
    let q = query.to_lowercase();
    let py = collect_symbols(root);
    let mut matches: Vec<Value> = Vec::new();
    let push = |m: Value, matches: &mut Vec<Value>| -> bool {
        matches.push(m);
        matches.len() >= limit
    };

    // 实体(def 文件名 = 实体名)。
    for def in kb.defs.values() {
        if !def.name.to_lowercase().contains(&q) {
            continue;
        }
        if push(
            json!({
                "name": def.name,
                "kind": "entity",
                "file": def.rel_path,
                "line": 1,
                "propertyCount": def.model.properties.len(),
            }),
            &mut matches,
        ) {
            return Ok(json!({"query": query, "count": matches.len(), "matches": matches}));
        }
    }

    // 实体属性(def 属性 → Python 类型解析)。
    for def in kb.defs.values() {
        for prop in &def.model.properties {
            if !prop.name.to_lowercase().contains(&q) {
                continue;
            }
            let type_name = prop.type_name.as_deref().unwrap_or("STRING");
            let resolved = resolve(kb, &py, root, type_name);
            if push(
                json!({
                    "name": prop.name,
                    "kind": "entity-property",
                    "entity": def.name,
                    "file": def.rel_path,
                    "line": prop.line,
                    "declaredType": type_name,
                    "pyType": resolved.display,
                    "confidence": resolved.confidence.as_str(),
                    "via": resolved.via,
                }),
                &mut matches,
            ) {
                return Ok(json!({"query": query, "count": matches.len(), "matches": matches}));
            }
        }
    }

    // types.xml 类型。
    for decl in &kb.types.types {
        if !decl.name.to_lowercase().contains(&q) {
            continue;
        }
        let resolved = resolve(kb, &py, root, &decl.name);
        if push(
            json!({
                "name": decl.name,
                "kind": "type",
                "file": "scripts/entity_defs/types.xml",
                "line": decl.line,
                "kindOf": format!("{:?}", decl.kind),
                "implementedBy": decl.implemented_by_symbol,
                "pyType": resolved.display,
                "confidence": resolved.confidence.as_str(),
            }),
            &mut matches,
        ) {
            return Ok(json!({"query": query, "count": matches.len(), "matches": matches}));
        }
    }

    // Python 符号。
    for sym in &py {
        if !sym.name.to_lowercase().contains(&q) {
            continue;
        }
        if push(py_match_json(sym), &mut matches) {
            return Ok(json!({"query": query, "count": matches.len(), "matches": matches}));
        }
    }

    Ok(json!({"query": query, "count": matches.len(), "matches": matches}))
}

/// 跨格式引用边(可配置项目规则产出,非同名自动认定;P1 面从已解析数据)。
struct RefEdge {
    from: String,
    to: String,
    relation: &'static str,
    rule: &'static str,
    confidence: Confidence,
    from_file: String,
    from_line: usize,
    to_file: Option<String>,
    to_line: Option<usize>,
}

/// 全量语义引用边(有界:defs × 属性/方法 + types × implementedBy)。
fn build_edges(kb: &AssetKnowledge, py: &[PySymbol], root: &Path) -> Vec<RefEdge> {
    let mut edges = Vec::new();
    for def in kb.defs.values() {
        // 实体 ↔ 同名 Python 类(实体名 = def 文件名去 .def)。
        if let Some(cls) = py.iter().find(|s| s.kind == "class" && s.name == def.name) {
            edges.push(RefEdge {
                from: format!("def:{}.def", def.name),
                to: format!("py:{}", cls.name),
                relation: "implements",
                rule: "entity-class-name",
                confidence: Confidence::Inferred,
                from_file: def.rel_path.clone(),
                from_line: 1,
                to_file: Some(cls.file.to_string_lossy().into_owned()),
                to_line: Some(cls.line),
            });
        }
        // 属性 → types.xml/alias 类型。
        for prop in &def.model.properties {
            let type_name = prop.type_name.as_deref().unwrap_or("STRING");
            let resolved = resolve(kb, py, root, type_name);
            if resolved.via.iter().any(|v| v.contains("types.xml:") || v.contains("alias.xml:")) {
                edges.push(RefEdge {
                    from: format!("def:{}.{}", def.name, prop.name),
                    to: format!("types:{}", type_name),
                    relation: "references",
                    rule: "types.xml type-reference",
                    confidence: resolved.confidence,
                    from_file: def.rel_path.clone(),
                    from_line: prop.line,
                    to_file: Some("scripts/entity_defs/types.xml".into()),
                    to_line: None,
                });
            }
            // implementedBy → Python 类(类形态或实例赋值形态)。
            if let Some(decl) = kb.types.types.iter().find(|t| t.name == type_name) {
                if let Some(impl_sym) = &decl.implemented_by_symbol {
                    if let Some(cls) = implemented_by_class(py, root, impl_sym) {
                        let sym = py.iter().find(|s| s.kind == "class" && s.name == cls);
                        edges.push(RefEdge {
                            from: format!("def:{}.{}", def.name, prop.name),
                            to: format!("py:{cls}"),
                            relation: "implements",
                            rule: "implementedBy",
                            confidence: Confidence::Inferred,
                            from_file: def.rel_path.clone(),
                            from_line: prop.line,
                            to_file: sym.map(|s| s.file.to_string_lossy().into_owned()),
                            to_line: sym.map(|s| s.line),
                        });
                    }
                }
            }
        }
        // 远程方法 → Python 同名方法(实体类内)。
        for m in def
            .model
            .base_methods
            .iter()
            .chain(&def.model.cell_methods)
            .chain(&def.model.client_methods)
        {
            if let Some(method) = py.iter().find(|s| {
                s.kind == "method"
                    && s.class.as_deref() == Some(def.name.as_str())
                    && s.name == m.name
            }) {
                edges.push(RefEdge {
                    from: format!("def:{}.{}", def.name, m.name),
                    to: format!("py:{}.{}", def.name, m.name),
                    relation: "implements",
                    rule: "def-method-name",
                    confidence: Confidence::Inferred,
                    from_file: def.rel_path.clone(),
                    from_line: m.line,
                    to_file: Some(method.file.to_string_lossy().into_owned()),
                    to_line: Some(method.line),
                });
            }
        }
    }
    // types.xml implementedBy → Python 类(独立于 def 属性引用)。
    for decl in &kb.types.types {
        if let Some(impl_sym) = &decl.implemented_by_symbol {
            if let Some(cls) = implemented_by_class(py, root, impl_sym) {
                let sym = py.iter().find(|s| s.kind == "class" && s.name == cls);
                edges.push(RefEdge {
                    from: format!("types:{}", decl.name),
                    to: format!("py:{cls}"),
                    relation: "implements",
                    rule: "implementedBy",
                    confidence: Confidence::Inferred,
                    from_file: "scripts/entity_defs/types.xml".into(),
                    from_line: decl.line,
                    to_file: sym.map(|s| s.file.to_string_lossy().into_owned()),
                    to_line: sym.map(|s| s.line),
                });
            }
        }
    }
    edges
}

/// `find_references`:查引用某符号/配置的跨格式边(来源节点、目标节点、
/// 关系、产出规则、置信度、双端 file:line)。答「改这个会影响哪些地方」。
pub fn find_references(
    kb: &AssetKnowledge,
    root: &Path,
    symbol: &str,
    limit: usize,
) -> Result<Value, String> {
    let symbol = symbol.trim();
    if symbol.is_empty() {
        return Err("empty symbol query".to_string());
    }
    let q = symbol.to_lowercase();
    let py = collect_symbols(root);
    let mut matches = Vec::new();
    for edge in build_edges(kb, &py, root) {
        let hit = edge.from.to_lowercase().contains(&q)
            || edge.to.to_lowercase().contains(&q)
            || edge.from.split(':').next_back().unwrap_or("").to_lowercase().contains(&q)
            || edge.to.split(':').next_back().unwrap_or("").to_lowercase().contains(&q);
        if !hit {
            continue;
        }
        let mut entry = json!({
            "from": edge.from,
            "to": edge.to,
            "relation": edge.relation,
            "rule": edge.rule,
            "confidence": edge.confidence.as_str(),
            "fromFile": edge.from_file,
            "fromLine": edge.from_line,
        });
        if let Some(f) = &edge.to_file {
            entry["toFile"] = Value::String(f.clone());
        }
        if let Some(l) = edge.to_line {
            entry["toLine"] = Value::from(l);
        }
        matches.push(entry);
        if matches.len() >= limit {
            break;
        }
    }
    Ok(json!({
        "symbol": symbol,
        "count": matches.len(),
        "matches": matches,
    }))
}

/// `index_status`:索引面状态——扫描文件数、符号数、置信度分布、装载错误。
pub fn index_status(kb: &AssetKnowledge, root: &Path) -> Value {
    let py = collect_symbols(root);
    let mut confidence = [0usize; 3];
    let mut with_resolution = 0usize;
    for def in kb.defs.values() {
        for prop in &def.model.properties {
            let type_name = prop.type_name.as_deref().unwrap_or("STRING");
            let resolved = resolve(kb, &py, root, type_name);
            confidence[resolved.confidence as usize] += 1;
            with_resolution += 1;
        }
    }
    for decl in &kb.types.types {
        let resolved = resolve(kb, &py, root, &decl.name);
        confidence[resolved.confidence as usize] += 1;
        with_resolution += 1;
    }
    json!({
        "pythonFiles": {
            "symbols": py.len(),
        },
        "schema": {
            "defs": kb.defs.len(),
            "types": kb.types.types.len(),
            "aliases": kb.alias.aliases.len(),
        },
        "resolution": {
            "resolvedTypes": with_resolution,
            "determined": confidence[0],
            "inferred": confidence[1],
            "unknown": confidence[2],
        },
        "loadErrors": kb.load_errors,
    })
}

/// `query_xml`:按元素路径导航解析后的 XML 知识结构(KODE-MCP-KB-001 ⑤)。
/// 支持:
/// - `types.<Name>` — types.xml 类型声明(含 kind/implementedBy/字段)。
/// - `entity.<Name>` — def 实体(属性/方法摘要)。
/// - `entity.<Name>.Properties.<prop>` — 单个属性(含解析后 Python 类型)。
///
/// 配置键的「含义」面由 why_setting/list_config_settings/get_final_config
/// 承担(本面只管 XML 元素结构,不重复配置问答)。
pub fn query_xml(kb: &AssetKnowledge, path: &str) -> Result<Value, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("empty path".to_string());
    }
    let parts: Vec<&str> = path.split('.').collect();
    match parts.as_slice() {
        ["types", name] => {
            let decl = kb
                .types
                .types
                .iter()
                .find(|t| t.name == *name)
                .ok_or_else(|| format!("type not found: {name}"))?;
            Ok(json!({
                "node": "type",
                "name": decl.name,
                "kind": format!("{:?}", decl.kind),
                "line": decl.line,
                "file": "scripts/entity_defs/types.xml",
                "implementedBy": decl.implemented_by_symbol,
                "directive": decl.directive,
                "fields": decl.field_refs,
                "element": decl.element_ref,
            }))
        }
        ["entity", name] => {
            let def = kb
                .defs
                .get(*name)
                .ok_or_else(|| format!("entity not found: {name}"))?;
            let props: Vec<Value> = def
                .model
                .properties
                .iter()
                .map(|p| json!({"name": p.name, "line": p.line, "type": p.type_name}))
                .collect();
            Ok(json!({
                "node": "entity",
                "name": def.name,
                "file": def.rel_path,
                "category": def.category,
                "propertyCount": def.model.properties.len(),
                "baseMethodCount": def.model.base_methods.len(),
                "cellMethodCount": def.model.cell_methods.len(),
                "clientMethodCount": def.model.client_methods.len(),
                "parent": def.model.parent,
                "properties": props,
            }))
        }
        ["entity", name, "Properties", prop] => {
            let def = kb
                .defs
                .get(*name)
                .ok_or_else(|| format!("entity not found: {name}"))?;
            let p = def
                .model
                .properties
                .iter()
                .find(|p| p.name == *prop)
                .ok_or_else(|| format!("property not found: {name}.{prop}"))?;
            let type_name = p.type_name.as_deref().unwrap_or("STRING");
            let resolved = resolve(kb, &[], Path::new("."), type_name);
            Ok(json!({
                "node": "property",
                "entity": def.name,
                "name": p.name,
                "line": p.line,
                "file": def.rel_path,
                "declaredType": type_name,
                "pyType": resolved.display,
                "confidence": resolved.confidence.as_str(),
                "flags": p.flags,
                "persistent": p.persistent,
                "defaultValue": p.default_value,
            }))
        }
        _ => Err(format!(
            "unrecognized path: {path} (expected types.<Name> | entity.<Name> | entity.<Name>.Properties.<prop>)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb() -> AssetKnowledge {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/fixtures/kbengine-demo-assets");
        AssetKnowledge::load(&root)
    }

    fn root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/fixtures/kbengine-demo-assets")
    }

    #[test]
    fn builtin_resolves_determined() {
        let k = kb();
        let r = resolve(&k, &[], &root(), "UINT32");
        assert_eq!(r.display, "int");
        assert_eq!(r.confidence, Confidence::Determined);
    }

    #[test]
    fn alias_chain_expands_to_builtin() {
        let k = kb();
        // ITEM_ID = UINT16(别名链)。
        let r = resolve(&k, &[], &root(), "ITEM_ID");
        assert_eq!(r.display, "int");
        assert_eq!(r.confidence, Confidence::Determined);
        assert!(r.via.iter().any(|v| v.contains("ITEM_ID")));
    }

    #[test]
    fn array_type_becomes_list_of_element() {
        let k = kb();
        // ITEM_IDS = ARRAY of ITEM_ID → list[int]。
        let r = resolve(&k, &[], &root(), "ITEM_IDS");
        assert_eq!(r.display, "list[int]");
        assert_eq!(r.confidence, Confidence::Inferred);
    }

    #[test]
    fn fixed_dict_with_implemented_by_resolves_to_python_class_when_found() {
        let k = kb();
        let root = root();
        let py = collect_symbols(&root);
        // SKILL_SLOT implementedBy → SKILL_SLOT_DATA 模块里找类(夹具 scripts)。
        // 实例赋值形态(weapon_skill_slot_list_inst = weapon_skill_slot_list())
        // 应解出类名,而非类型名。
        let r = resolve(&k, &py, &root, "SKILL_SLOT");
        assert_eq!(r.confidence, Confidence::Inferred);
        assert!(r.via.iter().any(|v| v.starts_with("implementedBy:")));
        // 实例赋值解析成功 → 显示解出的类名(不再是类型名)。
        assert_eq!(r.display, "weapon_skill_slot_list");
    }

    #[test]
    fn unknown_type_is_unknown_not_guessed() {
        let k = kb();
        let r = resolve(&k, &[], &root(), "NO_SUCH_TYPE");
        assert_eq!(r.confidence, Confidence::Unknown);
        assert_eq!(r.display, "NO_SUCH_TYPE");
    }

    #[test]
    fn find_symbol_looks_up_entity_property_and_type() {
        let k = kb();
        let root = root();
        let out = find_symbol(&k, &root, "level", 20).expect("answer");
        // 夹具 Avatar.def 有 level 属性(UINT32)→ 实体属性命中,int 已确定。
        let m = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == "entity-property")
            .expect("property");
        assert_eq!(m["entity"], "Avatar");
        assert_eq!(m["pyType"], "int");
        assert_eq!(m["confidence"], "determined");
    }

    #[test]
    fn find_references_traces_implemented_by_to_python_class() {
        let k = kb();
        let root = root();
        // SKILL_SLOT(types.xml FIXED_DICT + implementedBy)的引用边。
        let out = find_references(&k, &root, "SKILL_SLOT", 20).expect("answer");
        assert!(out["count"].as_u64().unwrap() >= 1);
        // 至少一条 implements 边(implementedBy 规则)指向 Python 类。
        let implements = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["rule"] == "implementedBy" && m["relation"] == "implements");
        assert!(implements, "expected an implementedBy edge");
    }

    #[test]
    fn find_references_empty_query_is_error() {
        let k = kb();
        let root = root();
        assert!(find_references(&k, &root, " ", 20).is_err());
    }

    #[test]
    fn index_status_reports_confidence_distribution() {
        let k = kb();
        let root = root();
        let out = index_status(&k, &root);
        assert!(out["schema"]["defs"].as_u64().unwrap() >= 1);
        assert!(out["resolution"]["resolvedTypes"].as_u64().unwrap() >= 1);
        // 分布三项存在且总和 = 解析数。
        let total = out["resolution"]["determined"].as_u64().unwrap()
            + out["resolution"]["inferred"].as_u64().unwrap()
            + out["resolution"]["unknown"].as_u64().unwrap();
        assert_eq!(total, out["resolution"]["resolvedTypes"].as_u64().unwrap());
    }

    #[test]
    fn query_xml_navigates_type_entity_and_property() {
        let k = kb();
        // types.<Name>:SKILL_SLOT 类型声明(implementedBy 在)。
        let t = query_xml(&k, "types.SKILL_SLOT").expect("type");
        assert_eq!(t["node"], "type");
        assert_eq!(t["kind"], "FixedDict");
        assert!(t["implementedBy"].as_str().is_some());

        // entity.<Name>:Avatar def 摘要。
        let e = query_xml(&k, "entity.Avatar").expect("entity");
        assert_eq!(e["name"], "Avatar");
        assert!(e["propertyCount"].as_u64().unwrap() >= 1);

        // entity.<Name>.Properties.<prop>:属性(带解析后 Python 类型)。
        let p = query_xml(&k, "entity.Avatar.Properties.level").expect("property");
        assert_eq!(p["name"], "level");
        assert_eq!(p["declaredType"], "UINT32");
        assert_eq!(p["pyType"], "int");
        assert_eq!(p["confidence"], "determined");
    }

    #[test]
    fn query_xml_unknown_path_is_error() {
        let k = kb();
        assert!(query_xml(&k, "types.NoSuch").is_err());
        assert!(query_xml(&k, "entity.NoSuch").is_err());
        assert!(query_xml(&k, "entity.Avatar.Properties.NoSuch").is_err());
        assert!(query_xml(&k, "garbage").is_err());
    }
}
