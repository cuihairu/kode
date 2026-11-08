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

use std::collections::HashMap;
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

/// types.xml 类型名 → **完整** implementedBy 符号(`MODULE.Class` /
/// `MODULE.inst`)。parser 把 `implemented_by_symbol` 归一成末段(丢模块前缀,
/// model.rs 口径),这里从原始 types.xml 文本恢复模块前缀——否则 `a.factory`
/// 与 `b.factory` 被当成同一符号,同名类首者胜(见实现注释)。
fn implemented_by_full(kb: &AssetKnowledge) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(text) = &kb.types_text else {
        return map;
    };
    let doc = kode_parser::xml::parse(text, false);
    let Some(root) = doc.root() else {
        return map;
    };
    for child in doc.child_elements(root) {
        let e = doc.element(child);
        if let Some(full) = doc.scalar_child_value(child, "implementedBy") {
            let full = full.trim().to_string();
            if !full.is_empty() {
                map.insert(e.name.clone(), full);
            }
        }
    }
    map
}

/// 全局按裸类名找类(回落;仅在无模块前缀或模块文件缺失时用)。
fn find_py_class<'a>(py: &'a [PySymbol], impl_symbol: &str) -> Option<&'a PySymbol> {
    let impl_symbol = impl_symbol.trim();
    let last = impl_symbol.rsplit('.').next().unwrap_or(impl_symbol);
    py.iter().find(|s| s.kind == "class" && s.name == last)
}

/// implementedBy → 实现类名。`full_symbol` = 恢复的完整符号
/// (`MODULE.Class` / `MODULE.inst`)。两种形态(用户令:引擎按「模块路径.
/// 实现对象」装载,实现对象可能是类也可能是指向实例的模块级赋值):
/// 1. `MODULE.Class`:类必须在该模块文件内(不凭同名类名在全局任意找)。
/// 2. `MODULE.inst` = 模块级 `inst = Class()`:在该模块文件内扫赋值。
///
/// 无模块前缀或模块缺失 → 回落全局同名类/全 scripts 扫对象名(有界);
/// 找不到 → None(如实,不猜)。
fn implemented_by_class(py: &[PySymbol], root: &Path, full_symbol: &str) -> Option<String> {
    let full_symbol = full_symbol.trim();
    if let Some((module, name)) = full_symbol.rsplit_once('.') {
        let module = module.trim();
        let name = name.trim();
        if let Some(file) = crate::code_index::find_module(root, module) {
            // 类形态:类必须在模块内。
            if let Some(cls) = crate::code_index::class_in_file(&file, name) {
                return Some(cls);
            }
            // 实例形态:模块内 `inst = Class()`。
            if let Ok(source) = std::fs::read_to_string(&file) {
                if let Some(cls) = crate::code_index::instance_class_in_source(&source, name) {
                    return Some(cls);
                }
            }
            // 模块在但两类形态都不命中 → 无法归因(如实 None,不跨模块猜)。
            return None;
        }
        // 模块文件未找到:name 可能是裸类名,也可能是归一化丢模块的实例名。
        if let Some(cls) = find_py_class(py, name) {
            return Some(cls.name.clone());
        }
        return crate::code_index::find_instance_class(root, name);
    }
    // 无点号(类型声明里本就是裸名):全局同名类;否则可能是丢模块的实例名。
    if let Some(cls) = find_py_class(py, full_symbol) {
        return Some(cls.name.clone());
    }
    crate::code_index::find_instance_class(root, full_symbol)
}

/// 类型名 → Python 类型表达式(递归展开;深度护栏防环)。
/// `via` 收集解析路径(types.xml/alias.xml 名),供 AI 追因。
/// `impl_full` = types.xml 类型名 → 完整 implementedBy 符号(见
/// [`implemented_by_full`];调用方按查询构建一次复用)。
fn resolve_py_type(
    kb: &AssetKnowledge,
    py: &[PySymbol],
    root: &Path,
    name: &str,
    depth: usize,
    via: &mut Vec<String>,
    impl_full: &HashMap<String, String>,
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
                    return resolve_py_type(kb, py, root, target, depth + 1, via, impl_full);
                }
                ResolvedPyType {
                    display: name.into(),
                    confidence: Confidence::Unknown,
                    via: via.clone(),
                }
            }
            TypeKind::Array => {
                let elem = decl.element_ref.as_deref().unwrap_or("STRING");
                let inner = resolve_py_type(kb, py, root, elem, depth + 1, via, impl_full);
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
                    // 优先用恢复的完整符号(MODULE.Class/MODULE.inst),保模块身份。
                    let full = impl_full
                        .get(name)
                        .map(|s| s.as_str())
                        .unwrap_or(impl_symbol.as_str());
                    if let Some(cls) = implemented_by_class(py, root, full) {
                        // implementedBy → 自定义 Python 类(类形态或实例赋值形态)。
                        via.push(format!("implementedBy:{full}"));
                        ResolvedPyType {
                            display: cls,
                            confidence: Confidence::Inferred,
                            via: via.clone(),
                        }
                    } else {
                        // 类型声明已知,实现类在对应模块/scripts 未找到 → 静态
                        // 不可得,如实 Unknown(绝不把未解析类当推断返回)。
                        via.push(format!("implementedBy:{full}(class-not-found)"));
                        ResolvedPyType {
                            display: name.into(),
                            confidence: Confidence::Unknown,
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
        };
    } else if let Some(alias) = kb.alias.aliases.iter().find(|a| a.name == name) {
        via.push(format!("alias.xml:{name}"));
        return resolve_py_type(kb, py, root, &alias.alias_type, depth + 1, via, impl_full);
    }
    // 未解析:如实未知,不虚构。
    ResolvedPyType {
        display: name.into(),
        confidence: Confidence::Unknown,
        via: via.clone(),
    }
}

/// 带完整 implementedBy 符号表的一次解析(查询级构建一次 `impl_full` 复用)。
fn resolve_with(
    kb: &AssetKnowledge,
    py: &[PySymbol],
    root: &Path,
    name: &str,
    impl_full: &HashMap<String, String>,
) -> ResolvedPyType {
    resolve_py_type(kb, py, root, name, 0, &mut Vec::new(), impl_full)
}

/// 属性类型解析:处理 def 属性**内联容器**(`<Type>ARRAY<of>UINT32</of></Type>`
/// 的 `type_name` 是 `ARRAY` 而元素在 `type_refs[0]`;`FIXED_DICT` 内联 → dict)。
/// 命名类型(自定义名/内建)走 [`resolve_with`]。
fn resolve_prop(
    kb: &AssetKnowledge,
    py: &[PySymbol],
    root: &Path,
    prop: &kode_parser::model::PropertyDef,
    impl_full: &HashMap<String, String>,
) -> ResolvedPyType {
    let type_name = prop.type_name.as_deref().unwrap_or("STRING");
    if type_name == "ARRAY" {
        if let Some(elem) = prop.type_refs.first() {
            let inner = resolve_with(kb, py, root, elem, impl_full);
            // 内联 ARRAY 容器 → 至少推断(元素未知则整体未知)。
            return ResolvedPyType {
                display: format!("list[{}]", inner.display),
                confidence: inner.confidence.max(Confidence::Inferred),
                via: inner.via,
            };
        }
    }
    if type_name == "FIXED_DICT" {
        return ResolvedPyType {
            display: "dict".into(),
            confidence: Confidence::Inferred,
            via: vec!["inline-FIXED_DICT".into()],
        };
    }
    resolve_with(kb, py, root, type_name, impl_full)
}

/// 测试用单次解析(构建完整 implementedBy 符号表)。
#[cfg(test)]
fn res(kb: &AssetKnowledge, py: &[PySymbol], root: &Path, name: &str) -> ResolvedPyType {
    let impl_full = implemented_by_full(kb);
    resolve_with(kb, py, root, name, &impl_full)
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
    let impl_full = implemented_by_full(kb);
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
            let resolved = resolve_prop(kb, &py, root, prop, &impl_full);
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
        let resolved = resolve_with(kb, &py, root, &decl.name, &impl_full);
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
/// 同名启发边(实体↔类、方法↔方法)只按名,未做签名/域校验 → 按设计
/// 标 `Unknown`(绝不 `Determined`;见设计文档 §10)。implementedBy 边按
/// 模块身份解析(模块内类/实例赋值),非全局同名任意猜。
fn build_edges(kb: &AssetKnowledge, py: &[PySymbol], root: &Path) -> Vec<RefEdge> {
    let impl_full = implemented_by_full(kb);
    let mut edges = Vec::new();
    for def in kb.defs.values() {
        // 实体 ↔ 同名 Python 类(实体名 = def 文件名去 .def;同名启发边 → Unknown)。
        if let Some(cls) = py.iter().find(|s| s.kind == "class" && s.name == def.name) {
            edges.push(RefEdge {
                from: format!("def:{}.def", def.name),
                to: format!("py:{}", cls.name),
                relation: "implements",
                rule: "entity-class-name",
                confidence: Confidence::Unknown,
                from_file: def.rel_path.clone(),
                from_line: 1,
                to_file: Some(cls.file.to_string_lossy().into_owned()),
                to_line: Some(cls.line),
            });
        }
        // 属性 → types.xml/alias 类型。
        for prop in &def.model.properties {
            let type_name = prop.type_name.as_deref().unwrap_or("STRING");
            let resolved = resolve_prop(kb, py, root, prop, &impl_full);
            if resolved
                .via
                .iter()
                .any(|v| v.contains("types.xml:") || v.contains("alias.xml:"))
            {
                // 目标行 = types.xml/alias.xml 声明行(精确定位,不省略)。
                let to_line = kb
                    .types
                    .types
                    .iter()
                    .find(|t| t.name == type_name)
                    .map(|t| t.line);
                edges.push(RefEdge {
                    from: format!("def:{}.{}", def.name, prop.name),
                    to: format!("types:{}", type_name),
                    relation: "references",
                    rule: "types.xml type-reference",
                    confidence: resolved.confidence,
                    from_file: def.rel_path.clone(),
                    from_line: prop.line,
                    to_file: Some("scripts/entity_defs/types.xml".into()),
                    to_line,
                });
            }
            // implementedBy → Python 类(类形态或实例赋值形态,按模块身份)。
            if let Some(decl) = kb.types.types.iter().find(|t| t.name == type_name) {
                if let Some(impl_sym) = &decl.implemented_by_symbol {
                    let full = impl_full
                        .get(type_name)
                        .map(|s| s.as_str())
                        .unwrap_or(impl_sym.as_str());
                    if let Some(cls) = implemented_by_class(py, root, full) {
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
        // 远程方法 → Python 同名方法(实体类内;同名启发边 → Unknown)。
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
                    confidence: Confidence::Unknown,
                    from_file: def.rel_path.clone(),
                    from_line: m.line,
                    to_file: Some(method.file.to_string_lossy().into_owned()),
                    to_line: Some(method.line),
                });
            }
        }
    }
    // types.xml implementedBy → Python 类(独立于 def 属性引用,按模块身份)。
    for decl in &kb.types.types {
        if let Some(impl_sym) = &decl.implemented_by_symbol {
            let full = impl_full
                .get(&decl.name)
                .map(|s| s.as_str())
                .unwrap_or(impl_sym.as_str());
            if let Some(cls) = implemented_by_class(py, root, full) {
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
            || edge
                .from
                .split(':')
                .next_back()
                .unwrap_or("")
                .to_lowercase()
                .contains(&q)
            || edge
                .to
                .split(':')
                .next_back()
                .unwrap_or("")
                .to_lowercase()
                .contains(&q);
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
/// Python 扫描面如实报告文件数/截断/扫描错误(截断或坏文件不掩盖成"健康")。
pub fn index_status(kb: &AssetKnowledge, root: &Path) -> Value {
    let py = collect_symbols(root);
    let impl_full = implemented_by_full(kb);
    let scan = crate::bounded_scan::collect(
        &[root.join("scripts")],
        "py",
        crate::code_index::SKIP_DIRS,
        crate::code_index::MAX_FILES,
    );
    let mut confidence = [0usize; 3];
    let mut with_resolution = 0usize;
    for def in kb.defs.values() {
        for prop in &def.model.properties {
            let resolved = resolve_prop(kb, &py, root, prop, &impl_full);
            confidence[resolved.confidence as usize] += 1;
            with_resolution += 1;
        }
    }
    for decl in &kb.types.types {
        let resolved = resolve_with(kb, &py, root, &decl.name, &impl_full);
        confidence[resolved.confidence as usize] += 1;
        with_resolution += 1;
    }
    json!({
        "pythonFiles": {
            "files": scan.files.len(),
            "symbols": py.len(),
            "truncated": scan.truncated,
            "scanErrors": scan.errors,
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
/// 属性解析与 [`find_symbol`] 同一套(传 `root`,implementedBy 按模块身份
/// 解析,不被空符号表退化成类型名)。配置键的「含义」面由
/// why_setting/list_config_settings/get_final_config 承担(本面只管 XML
/// 元素结构,不重复配置问答)。
pub fn query_xml(kb: &AssetKnowledge, root: &Path, path: &str) -> Result<Value, String> {
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
            let py = collect_symbols(root);
            let impl_full = implemented_by_full(kb);
            let resolved = resolve_prop(kb, &py, root, p, &impl_full);
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
        let r = res(&k, &[], &root(), "UINT32");
        assert_eq!(r.display, "int");
        assert_eq!(r.confidence, Confidence::Determined);
    }

    #[test]
    fn alias_chain_expands_to_builtin() {
        let k = kb();
        // ITEM_ID = UINT16(别名链)。
        let r = res(&k, &[], &root(), "ITEM_ID");
        assert_eq!(r.display, "int");
        assert_eq!(r.confidence, Confidence::Determined);
        assert!(r.via.iter().any(|v| v.contains("ITEM_ID")));
    }

    #[test]
    fn array_type_becomes_list_of_element() {
        let k = kb();
        // ITEM_IDS = ARRAY of ITEM_ID → list[int]。
        let r = res(&k, &[], &root(), "ITEM_IDS");
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
        let r = res(&k, &py, &root, "SKILL_SLOT");
        assert_eq!(r.confidence, Confidence::Inferred);
        assert!(r.via.iter().any(|v| v.starts_with("implementedBy:")));
        // 实例赋值解析成功 → 显示解出的类名(不再是类型名)。
        assert_eq!(r.display, "weapon_skill_slot_list");
    }

    #[test]
    fn unknown_type_is_unknown_not_guessed() {
        let k = kb();
        let r = res(&k, &[], &root(), "NO_SUCH_TYPE");
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
        let t = query_xml(&k, &root(), "types.SKILL_SLOT").expect("type");
        assert_eq!(t["node"], "type");
        assert_eq!(t["kind"], "FixedDict");
        assert!(t["implementedBy"].as_str().is_some());

        // entity.<Name>:Avatar def 摘要。
        let e = query_xml(&k, &root(), "entity.Avatar").expect("entity");
        assert_eq!(e["name"], "Avatar");
        assert!(e["propertyCount"].as_u64().unwrap() >= 1);

        // entity.<Name>.Properties.<prop>:属性(带解析后 Python 类型)。
        let p = query_xml(&k, &root(), "entity.Avatar.Properties.level").expect("property");
        assert_eq!(p["name"], "level");
        assert_eq!(p["declaredType"], "UINT32");
        assert_eq!(p["pyType"], "int");
        assert_eq!(p["confidence"], "determined");
    }

    #[test]
    fn query_xml_unknown_path_is_error() {
        let k = kb();
        assert!(query_xml(&k, &root(), "types.NoSuch").is_err());
        assert!(query_xml(&k, &root(), "entity.NoSuch").is_err());
        assert!(query_xml(&k, &root(), "entity.Avatar.Properties.NoSuch").is_err());
        assert!(query_xml(&k, &root(), "garbage").is_err());
        // 空路径 → 明确错误(与空 query 同诚实面)。
        assert!(query_xml(&k, &root(), "   ").is_err());
    }

    // ---- implementedBy 模块身份(prove-red:旧码按裸名全局任意找,`mod_b.factory`
    //      会错误命中 `mod_a` 的同名类)。----
    #[test]
    fn implemented_by_requires_class_in_declared_module() {
        let root = std::env::temp_dir().join(format!("kode-mcp-mod-id-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("mod_a.py"), "class factory:\n    pass\n").unwrap();
        std::fs::write(scripts.join("mod_b.py"), "class unrelated:\n    pass\n").unwrap();
        let py = collect_symbols(&root);
        // mod_a.factory:类在该模块内 → 解析成功。
        assert_eq!(
            implemented_by_class(&py, &root, "mod_a.factory").as_deref(),
            Some("factory")
        );
        // mod_b.factory:模块在但无该类、无该实例赋值 → 如实 None,绝不回落
        // 全局同名类(mod_a 的 factory)。
        assert_eq!(implemented_by_class(&py, &root, "mod_b.factory"), None);
        // 无点号裸类名:全局同名类。
        assert_eq!(
            implemented_by_class(&py, &root, "factory").as_deref(),
            Some("factory")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    // ---- 内联容器元素类型(prove-red:旧码 `resolve("ARRAY")` → Unknown "ARRAY")。----
    #[test]
    fn inline_array_property_resolves_element_type() {
        let k = kb();
        let root = root();
        let py = collect_symbols(&root);
        // Avatar.skillSlots = `<Type>ARRAY<of>SKILL_SLOT</of></Type>`:type_name
        // 是 "ARRAY",元素在 type_refs[0] = SKILL_SLOT(其自身 implementedBy)。
        let prop = k
            .defs
            .get("Avatar")
            .unwrap()
            .model
            .properties
            .iter()
            .find(|p| p.name == "skillSlots")
            .expect("skillSlots prop");
        let r = resolve_prop(&k, &py, &root, prop, &implemented_by_full(&k));
        // list[weapon_skill_slot_list] = 元素类型(SKILL_SLOT 的 implementedBy 类)。
        assert_eq!(r.display, "list[weapon_skill_slot_list]");
        assert_eq!(r.confidence, Confidence::Inferred);
    }

    // ---- 同名启发边标 Unknown(prove-red:旧码标 Inferred,违反设计 §10)。----
    #[test]
    fn heuristic_edges_are_unknown_confidence() {
        let k = kb();
        let root = root();
        let py = collect_symbols(&root);
        let edges = build_edges(&k, &py, &root);
        let mut saw_entity = false;
        let mut saw_method = false;
        for e in &edges {
            if e.rule == "entity-class-name" {
                saw_entity = true;
                assert_eq!(e.confidence, Confidence::Unknown);
            }
            if e.rule == "def-method-name" {
                saw_method = true;
                assert_eq!(e.confidence, Confidence::Unknown);
            }
            if e.rule == "implementedBy" {
                // implementedBy 是模块身份解析出的关联 → Inferred。
                assert_eq!(e.confidence, Confidence::Inferred);
            }
        }
        assert!(saw_entity, "fixture should yield an entity-class-name edge");
        assert!(saw_method, "fixture should yield a def-method-name edge");
    }

    // ---- query_xml 属性解析与 find_symbol 一致(prove-red:旧码传空符号表 +
    //      Path("."),implementedBy 退化成类型名)。----
    #[test]
    fn query_xml_property_resolves_implemented_by_consistently() {
        let k = kb();
        let p = query_xml(&k, &root(), "entity.Avatar.Properties.skillSlots").expect("prop");
        // 同一套解析:内联 ARRAY of SKILL_SLOT → list[实现类],而非裸 "ARRAY"。
        assert_eq!(p["pyType"], "list[weapon_skill_slot_list]");
        assert_eq!(p["confidence"], "inferred");
    }

    // ---- index_status 如实报告扫描面(prove-red:旧码只报 symbols,无 files/
    //      truncated/scanErrors,截断被掩盖成健康)。----
    #[test]
    fn index_status_reports_scan_facts() {
        let k = kb();
        let st = index_status(&k, &root());
        assert!(st["pythonFiles"]["files"].is_number());
        assert!(st["pythonFiles"]["truncated"].is_boolean());
        assert!(st["pythonFiles"]["scanErrors"].is_number());
        assert!(st["pythonFiles"]["symbols"].as_u64().unwrap() > 0);
    }

    // ---- 内建标量全谱(覆盖 builtin_py 全部 22 分支;via 恒空)。----
    #[test]
    fn builtin_scalars_map_with_honest_confidence() {
        let k = AssetKnowledge::default();
        let root = root();
        let cases: &[(&str, &str, Confidence)] = &[
            ("UINT8", "int", Confidence::Determined),
            ("UINT16", "int", Confidence::Determined),
            ("UINT32", "int", Confidence::Determined),
            ("UINT64", "int", Confidence::Determined),
            ("INT8", "int", Confidence::Determined),
            ("INT16", "int", Confidence::Determined),
            ("INT32", "int", Confidence::Determined),
            ("INT64", "int", Confidence::Determined),
            ("FLOAT", "float", Confidence::Determined),
            ("DOUBLE", "float", Confidence::Determined),
            ("BOOL", "bool", Confidence::Determined),
            ("STRING", "str", Confidence::Determined),
            ("UNICODE", "str", Confidence::Determined),
            ("BLOB", "bytes", Confidence::Determined),
            ("VECTOR2", "Vector2", Confidence::Determined),
            ("VECTOR3", "Vector3", Confidence::Determined),
            ("VECTOR4", "Vector4", Confidence::Determined),
            ("ENTITYCALL", "EntityCall", Confidence::Unknown),
            ("PYTHON", "Any", Confidence::Unknown),
            ("PY_DICT", "Any", Confidence::Unknown),
            ("PY_TUPLE", "Any", Confidence::Unknown),
            ("PY_LIST", "Any", Confidence::Unknown),
        ];
        for (name, display, conf) in cases {
            let r = res(&k, &[], &root, name);
            assert_eq!(r.display, *display, "{name}");
            assert_eq!(r.confidence, *conf, "{name}");
            assert!(r.via.is_empty(), "{name} via should be empty");
        }
    }

    #[test]
    fn confidence_as_str_maps_each_variant() {
        assert_eq!(Confidence::Determined.as_str(), "determined");
        assert_eq!(Confidence::Inferred.as_str(), "inferred");
        assert_eq!(Confidence::Unknown.as_str(), "unknown");
    }

    // ---- 合成 TypeDecl 构造(直接建 kb.types.types,不依赖夹具形态)。----
    fn td(
        name: &str,
        kind: TypeKind,
        directive: Option<&str>,
        impl_sym: Option<&str>,
        element: Option<&str>,
    ) -> kode_parser::model::TypeDecl {
        kode_parser::model::TypeDecl {
            name: name.into(),
            name_span: kode_parser::diag::Span { start: 0, end: 0 },
            line: 1,
            kind,
            directive: directive.map(str::to_string),
            implemented_by_symbol: impl_sym.map(str::to_string),
            field_refs: vec![],
            element_ref: element.map(str::to_string),
        }
    }

    fn py_root(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("kode-mcp-{tag}-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        for (name, src) in files {
            std::fs::write(scripts.join(name), src).unwrap();
        }
        root
    }

    #[test]
    fn builtin_alias_without_target_is_unknown_own_name() {
        let mut k = AssetKnowledge::default();
        k.types
            .types
            .push(td("ODD", TypeKind::Builtin, None, None, None));
        let r = res(&k, &[], &root(), "ODD");
        assert_eq!(r.display, "ODD");
        assert_eq!(r.confidence, Confidence::Unknown);
        assert!(r.via.iter().any(|v| v == "types.xml:ODD"));
    }

    #[test]
    fn alias_chain_deeper_than_guard_is_unknown_any() {
        // A0→A1→…→A10(11 层):第 10 层深度 >8 → 守卫返回 Unknown Any,
        // 绝不无限递归(深度护栏防环)。
        let mut k = AssetKnowledge::default();
        for i in 0..11 {
            let directive = if i < 10 {
                Some(format!("A{}", i + 1))
            } else {
                None
            };
            k.types.types.push(kode_parser::model::TypeDecl {
                name: format!("A{i}"),
                name_span: kode_parser::diag::Span { start: 0, end: 0 },
                line: 1,
                kind: TypeKind::Builtin,
                directive,
                implemented_by_symbol: None,
                field_refs: vec![],
                element_ref: None,
            });
        }
        let r = res(&k, &[], &root(), "A0");
        assert_eq!(r.display, "Any");
        assert_eq!(r.confidence, Confidence::Unknown);
        assert!(
            r.via.len() >= 9,
            "path should record the chain, got {:?}",
            r.via
        );
    }

    #[test]
    fn fixed_dict_without_implemented_by_is_plain_dict() {
        let mut k = AssetKnowledge::default();
        k.types
            .types
            .push(td("PLAIN_FD", TypeKind::FixedDict, None, None, None));
        let r = res(&k, &[], &root(), "PLAIN_FD");
        assert_eq!(r.display, "dict");
        assert_eq!(r.confidence, Confidence::Inferred);
    }

    #[test]
    fn fixed_dict_class_not_found_is_unknown_with_trace() {
        // implementedBy 指向不存在模块/类 → 静态不可得 → Unknown,via 带
        // (class-not-found) 追因(绝不把未解析类当推断返回)。
        let mut k = AssetKnowledge::default();
        k.types.types.push(td(
            "GHOST_FD",
            TypeKind::FixedDict,
            None,
            Some("GHOST_DATA.ghost"),
            None,
        ));
        let r = res(&k, &[], &root(), "GHOST_FD");
        assert_eq!(r.display, "GHOST_FD");
        assert_eq!(r.confidence, Confidence::Unknown);
        assert!(r.via.iter().any(|v| v.ends_with("(class-not-found)")));
    }

    #[test]
    fn array_without_element_ref_defaults_to_str_element() {
        let mut k = AssetKnowledge::default();
        k.types
            .types
            .push(td("LOOSE_ARR", TypeKind::Array, None, None, None));
        let r = res(&k, &[], &root(), "LOOSE_ARR");
        assert_eq!(r.display, "list[str]");
        assert_eq!(r.confidence, Confidence::Inferred);
    }

    #[test]
    fn array_of_unknown_element_stays_unknown() {
        let mut k = AssetKnowledge::default();
        k.types.types.push(td(
            "ARR_GHOST",
            TypeKind::Array,
            None,
            None,
            Some("GHOST_ELEM"),
        ));
        let r = res(&k, &[], &root(), "ARR_GHOST");
        assert_eq!(r.display, "list[GHOST_ELEM]");
        assert_eq!(r.confidence, Confidence::Unknown);
    }

    #[test]
    fn implemented_by_full_is_empty_without_types_text_or_root() {
        // 无 types_text → 空表;有 text 但无根元素 → 空表(如实,不猜)。
        let k = AssetKnowledge::default();
        assert!(implemented_by_full(&k).is_empty());
        let mut k2 = AssetKnowledge::default();
        k2.types_text = Some("".into());
        assert!(implemented_by_full(&k2).is_empty());
    }

    #[test]
    fn module_missing_falls_back_to_global_class_and_instance_scan() {
        let root = py_root(
            "mfall",
            &[("mod.py", "class factory:\n    pass\n\ninst = Weapon()\n")],
        );
        let py = collect_symbols(&root);
        // 模块文件缺失 → 回落全局同名类(不因模块缺失而失联)。
        assert_eq!(
            implemented_by_class(&py, &root, "ghost_module.factory").as_deref(),
            Some("factory")
        );
        // 无点号实例名 → 全 scripts 扫模块级 `inst = Class()`。
        assert_eq!(
            implemented_by_class(&py, &root, "inst").as_deref(),
            Some("Weapon")
        );
        // 完全不可解析 → None。
        assert_eq!(
            implemented_by_class(&py, &root, "ghost_module.nothere"),
            None
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn find_symbol_empty_query_is_error() {
        let k = kb();
        assert!(find_symbol(&k, &root(), "  ", 20).is_err());
    }

    #[test]
    fn find_symbol_entity_kind_matched_first() {
        let k = kb();
        let out = find_symbol(&k, &root(), "avatar", 20).expect("answer");
        let m = &out["matches"][0];
        assert_eq!(m["kind"], "entity");
        assert_eq!(m["name"], "Avatar");
    }

    #[test]
    fn find_symbol_limit_stops_early() {
        let k = kb();
        let out = find_symbol(&k, &root(), "a", 1).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn find_symbol_python_method_carries_class() {
        let k = kb();
        let root = py_root(
            "pymeth",
            &[(
                "mod.py",
                "class Account:\n    def login(self):\n        pass\n",
            )],
        );
        let out = find_symbol(&k, &root, "login", 20).expect("answer");
        let m = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == "method")
            .expect("method");
        assert_eq!(m["name"], "login");
        assert_eq!(m["class"], "Account");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn find_references_limit_breaks_early() {
        let k = kb();
        let out = find_references(&k, &root(), "SKILL_SLOT", 1).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn find_references_instance_only_class_omits_location() {
        // 实例赋值形态解出类名,但 scripts 无该类符号 → 如实省略 toFile/toLine
        // (不虚构定位)。
        let mut k = AssetKnowledge::default();
        k.types.types.push(td(
            "INST_FD",
            TypeKind::FixedDict,
            None,
            Some("m.inst"),
            None,
        ));
        let root = py_root("instonly", &[("m.py", "inst = Weapon()\n")]);
        let out = find_references(&k, &root, "INST_FD", 20).expect("answer");
        let e = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["rule"] == "implementedBy")
            .expect("implementedBy edge");
        assert_eq!(e["to"], "py:Weapon");
        assert!(e.get("toFile").is_none());
        assert!(e.get("toLine").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_prop_inline_fixed_dict_is_dict() {
        let k = kb();
        let root = root();
        let py = collect_symbols(&root);
        let mut prop = k.defs["Avatar"]
            .model
            .properties
            .iter()
            .find(|p| p.name == "level")
            .unwrap()
            .clone();
        prop.type_name = Some("FIXED_DICT".into());
        prop.type_refs = vec![];
        let r = resolve_prop(&k, &py, &root, &prop, &implemented_by_full(&k));
        assert_eq!(r.display, "dict");
        assert_eq!(r.confidence, Confidence::Inferred);
        assert!(r.via.iter().any(|v| v == "inline-FIXED_DICT"));
    }

    #[test]
    fn resolve_prop_array_without_element_is_unknown_array() {
        let k = kb();
        let root = root();
        let py = collect_symbols(&root);
        let mut prop = k.defs["Avatar"]
            .model
            .properties
            .iter()
            .find(|p| p.name == "skillSlots")
            .unwrap()
            .clone();
        // 内联 ARRAY 但无 <of>(type_refs 空)→ 不虚构 list[Any],如实 Unknown。
        prop.type_refs = vec![];
        let r = resolve_prop(&k, &py, &root, &prop, &implemented_by_full(&k));
        assert_eq!(r.display, "ARRAY");
        assert_eq!(r.confidence, Confidence::Unknown);
    }

    #[test]
    fn build_edges_property_implemented_by_edge() {
        // def 属性类型名恰为 implementedBy 类型 → property 引用边带实现类定位。
        let mut k = kb();
        let text =
            "<root><Properties><slot><Type> SKILL_SLOT </Type><Flags> BASE </Flags></slot></Properties></root>";
        let model = kode_parser::model::parse_def(text);
        k.defs.insert(
            "Synthetic".into(),
            crate::kb::ParsedDef {
                name: "Synthetic".into(),
                category: "entity".into(),
                rel_path: "scripts/entity_defs/Synthetic.def".into(),
                text: text.into(),
                model,
            },
        );
        let root = root();
        let py = collect_symbols(&root);
        let edges = build_edges(&k, &py, &root);
        let e = edges
            .iter()
            .find(|e| e.rule == "implementedBy" && e.from == "def:Synthetic.slot")
            .expect("property implementedBy edge");
        assert_eq!(e.to, "py:weapon_skill_slot_list");
        assert_eq!(e.confidence, Confidence::Inferred);
        assert!(
            e.to_file.is_some(),
            "implementedBy edge should carry a location"
        );
        assert!(e.to_line.is_some());
    }

    // ---- 收口:alias.xml 分支、implementedBy 模块在场但无形态、find_symbol
    //      三类循环各自的提前截断、build_edges 对不可解析实现类的如实跳过。----

    #[test]
    fn alias_branch_resolves_through_alias_xml() {
        let mut k = AssetKnowledge::default();
        k.alias.aliases.push(kode_parser::model::AliasDecl {
            name: "MY_ALIAS".into(),
            name_span: kode_parser::diag::Span { start: 0, end: 0 },
            line: 1,
            alias_type: "UINT32".into(),
        });
        let root = py_root("alias-branch", &[]);
        let resolved = resolve_with(&k, &[], &root, "MY_ALIAS", &Default::default());
        assert_eq!(resolved.display, "int");
        assert_eq!(resolved.confidence, Confidence::Determined);
        assert!(resolved.via.iter().any(|v| v == "alias.xml:MY_ALIAS"));
    }

    #[test]
    fn implemented_by_module_present_without_class_or_instance_is_unknown() {
        // 模块文件在,但类形态与实例赋值形态都不命中 → 如实 Unknown +
        // (class-not-found),绝不跨模块猜。
        let root = py_root("impl-mod-nocls", &[("bare.py", "x = 1\n")]);
        let mut k = AssetKnowledge::default();
        k.types.types.push(td(
            "GHOST_M",
            TypeKind::FixedDict,
            None,
            Some("bare.Missing"),
            None,
        ));
        let resolved = resolve_with(&k, &[], &root, "GHOST_M", &Default::default());
        assert_eq!(resolved.display, "GHOST_M");
        assert_eq!(resolved.confidence, Confidence::Unknown);
        assert!(resolved.via.iter().any(|v| v.contains("class-not-found")));
    }

    #[test]
    fn implemented_by_unreadable_module_is_unknown_not_panic() {
        // 模块文件在但不可按 UTF-8 读取:类形态读失败 → None,实例形态读
        // 失败 → None → 如实 Unknown + (class-not-found),不 panic。
        let root =
            std::env::temp_dir().join(format!("kode-mcp-impl-badutf-{}", std::process::id()));
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts").join("bad.py"), [0xFF, 0xFE, 0x00]).unwrap();
        let mut k = AssetKnowledge::default();
        k.types.types.push(td(
            "GHOST_B",
            TypeKind::FixedDict,
            None,
            Some("bad.Missing"),
            None,
        ));
        let resolved = resolve_with(&k, &[], &root, "GHOST_B", &Default::default());
        assert_eq!(resolved.display, "GHOST_B");
        assert_eq!(resolved.confidence, Confidence::Unknown);
        assert!(resolved.via.iter().any(|v| v.contains("class-not-found")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn find_symbol_early_returns_per_loop() {
        let k = kb();
        let root = root();
        // 属性循环命中即截断(query 只匹配属性名,def 名循环不命中)。
        let out = find_symbol(&k, &root, "skillSlots", 1).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["kind"], "entity-property");
        // types.xml 循环:query 只匹配类型名。
        let out = find_symbol(&k, &root, "skill_slot", 1).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["kind"], "type");
        assert_eq!(out["matches"][0]["name"], "SKILL_SLOT");
        // Python 符号循环:query 只匹配 py 符号。
        let out = find_symbol(&k, &root, "weapon_skill", 1).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["kind"], "class");
        // limit 未到 → 类型循环正常续行(不提前截断),py 符号亦命中。
        let out = find_symbol(&k, &root, "skill_slot", 20).expect("answer");
        assert_eq!(out["count"], 2);
        assert!(out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["kind"] == "type"));
        assert!(out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["kind"] == "class"));
    }

    #[test]
    fn build_edges_skips_unresolvable_implemented_by() {
        // 类型声明在场但实现类不可解析:不产 implementedBy 边(绝不把未解析
        // 类当实现);无 implementedBy 的 FixedDict 走 plain-dict 分支。两条
        // 路径同样覆盖 types.xml 独立循环里的不可解析跳过。
        let root = py_root("edges-ghost", &[("w.py", "class Weapon:\n    pass\n")]);
        let mut k = AssetKnowledge::default();
        k.types
            .types
            .push(td("PLAIN_FD", TypeKind::FixedDict, None, None, None));
        k.types.types.push(td(
            "GHOST_FD",
            TypeKind::FixedDict,
            None,
            Some("ghost.Ghost"),
            None,
        ));
        let text = "<root><Properties><p><Type> PLAIN_FD </Type><Flags> BASE </Flags></p>\
                    <q><Type> GHOST_FD </Type><Flags> BASE </Flags></q></Properties></root>";
        let model = kode_parser::model::parse_def(text);
        k.defs.insert(
            "Synthetic".into(),
            crate::kb::ParsedDef {
                name: "Synthetic".into(),
                category: "entity".into(),
                rel_path: "scripts/entity_defs/Synthetic.def".into(),
                text: text.into(),
                model,
            },
        );
        let py = collect_symbols(&root);
        let edges = build_edges(&k, &py, &root);
        assert!(
            !edges
                .iter()
                .any(|e| e.rule == "implementedBy" && e.to.contains("Ghost")),
            "unresolvable implementedBy must not fabricate an edge"
        );
        // PLAIN_FD 属性仍产出类型引用边(类型声明在场)。
        assert!(
            edges
                .iter()
                .any(|e| e.rule == "types.xml type-reference" && e.from == "def:Synthetic.p"),
            "type-reference edge for present declaration"
        );
    }
}
