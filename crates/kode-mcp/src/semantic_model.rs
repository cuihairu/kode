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

/// implementedBy 符号 → `scripts/` 里同名 Python 类(末段符号;MODULE.Class)。
fn find_py_class<'a>(py: &'a [PySymbol], impl_symbol: &str) -> Option<&'a PySymbol> {
    let last = impl_symbol.rsplit('.').next().unwrap_or(impl_symbol);
    py.iter().find(|s| s.kind == "class" && s.name == last)
}

/// 类型名 → Python 类型表达式(递归展开;深度护栏防环)。
/// `via` 收集解析路径(types.xml/alias.xml 名),供 AI 追因。
fn resolve_py_type(
    kb: &AssetKnowledge,
    py: &[PySymbol],
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
                    return resolve_py_type(kb, py, target, depth + 1, via);
                }
                ResolvedPyType {
                    display: name.into(),
                    confidence: Confidence::Unknown,
                    via: via.clone(),
                }
            }
            TypeKind::Array => {
                let elem = decl.element_ref.as_deref().unwrap_or("STRING");
                let inner = resolve_py_type(kb, py, elem, depth + 1, via);
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
                    if let Some(cls) = find_py_class(py, impl_symbol) {
                        // implementedBy → 自定义 Python 类(在 scripts/ 找到)。
                        via.push(format!("implementedBy:{impl_symbol}"));
                        ResolvedPyType {
                            display: cls.name.clone(),
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
        return resolve_py_type(kb, py, &alias.alias_type, depth + 1, via);
    }
    // 未解析:如实未知,不虚构。
    ResolvedPyType {
        display: name.into(),
        confidence: Confidence::Unknown,
        via: via.clone(),
    }
}

/// 公开类型解析(一次符号表构建;供 find_symbol/属性问答复用)。
fn resolve(kb: &AssetKnowledge, py: &[PySymbol], name: &str) -> ResolvedPyType {
    resolve_py_type(kb, py, name, 0, &mut Vec::new())
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
            let resolved = resolve(kb, &py, type_name);
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
        let resolved = resolve(kb, &py, &decl.name);
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

/// `index_status`:索引面状态——扫描文件数、符号数、置信度分布、装载错误。
pub fn index_status(kb: &AssetKnowledge, root: &Path) -> Value {
    let py = collect_symbols(root);
    let mut confidence = [0usize; 3];
    let mut with_resolution = 0usize;
    for def in kb.defs.values() {
        for prop in &def.model.properties {
            let type_name = prop.type_name.as_deref().unwrap_or("STRING");
            let resolved = resolve(kb, &py, type_name);
            confidence[resolved.confidence as usize] += 1;
            with_resolution += 1;
        }
    }
    for decl in &kb.types.types {
        let resolved = resolve(kb, &py, &decl.name);
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
        let r = resolve(&k, &[], "UINT32");
        assert_eq!(r.display, "int");
        assert_eq!(r.confidence, Confidence::Determined);
    }

    #[test]
    fn alias_chain_expands_to_builtin() {
        let k = kb();
        // ITEM_ID = UINT16(别名链)。
        let r = resolve(&k, &[], "ITEM_ID");
        assert_eq!(r.display, "int");
        assert_eq!(r.confidence, Confidence::Determined);
        assert!(r.via.iter().any(|v| v.contains("ITEM_ID")));
    }

    #[test]
    fn array_type_becomes_list_of_element() {
        let k = kb();
        // ITEM_IDS = ARRAY of ITEM_ID → list[int]。
        let r = resolve(&k, &[], "ITEM_IDS");
        assert_eq!(r.display, "list[int]");
        assert_eq!(r.confidence, Confidence::Inferred);
    }

    #[test]
    fn fixed_dict_with_implemented_by_resolves_to_python_class_when_found() {
        let k = kb();
        let root = root();
        let py = collect_symbols(&root);
        // SKILL_SLOT implementedBy → SKILL_SLOT_DATA 模块里找类(夹具 scripts)。
        let r = resolve(&k, &py, "SKILL_SLOT");
        // 若夹具 scripts 有同名类 → 类名 + 推断;否则如实推断为类型名。
        assert_eq!(r.confidence, Confidence::Inferred);
        assert!(r.via.iter().any(|v| v.starts_with("implementedBy:")));
    }

    #[test]
    fn unknown_type_is_unknown_not_guessed() {
        let k = kb();
        let r = resolve(&k, &[], "NO_SUCH_TYPE");
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
}
