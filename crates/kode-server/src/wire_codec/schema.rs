// ---------------------------------------------------------------------------
// Schema(types.xml/alias.xml 结构重解析 → 名→布局)
// ---------------------------------------------------------------------------

use std::collections::BTreeMap;

use kode_parser::xml::parse as parse_xml;

use super::errors::WireError;
use super::types::WireField;
use super::types::WireLayout;

// ---------------------------------------------------------------------------
// Schema(types.xml/alias.xml 结构重解析 → 名→布局)
// ---------------------------------------------------------------------------

/// 结构重解析得到的类型表达式(保留字段名/声明序,环在 resolve 检测)。
#[derive(Debug, Clone, PartialEq)]
enum RawType {
    /// 内建标量(UINT32/STRING/VECTOR3/...)。
    Builtin(String),
    /// 指向另一命名类型(types.xml 别名 directive / alias.xml 目标 / 自定义名)。
    Named(String),
    /// ARRAY <of> 元素表达式。
    Array(Box<RawType>),
    /// FIXED_DICT 字段(名 + 表达式),声明序。
    FixedDict(Vec<(String, RawType)>),
}

/// def 类型 schema:`types.xml` + `alias.xml` → 可解析类型名 → [`WireLayout`]。
/// 自足(结构重解析),不依赖 TypeGraph——graph 的 `field_refs` 丢名折平 <of>。
#[derive(Debug)]
pub struct WireSchema {
    types: BTreeMap<String, RawType>,
}

impl WireSchema {
    /// 从 `types.xml` + `alias.xml` 文本构建(结构重解析,镜像 extract_types)。
    pub fn from_sources(types_xml: &str, alias_xml: &str) -> Self {
        let mut types = BTreeMap::new();
        if !types_xml.is_empty() {
            let doc = parse_xml(types_xml, false);
            if let Some(root) = doc.root() {
                for child in doc.child_elements(root) {
                    let e = doc.element(child);
                    let raw = raw_type_from_element(&doc, child);
                    types.insert(e.name.clone(), raw);
                }
            }
        }
        if !alias_xml.is_empty() {
            let doc = parse_xml(alias_xml, false);
            if let Some(root) = doc.root() {
                for child in doc.child_elements(root) {
                    let e = doc.element(child);
                    let target = alias_target_of(&doc, child);
                    if target.is_empty() {
                        continue;
                    }
                    types.insert(e.name.clone(), RawType::Named(target));
                }
            }
        }
        WireSchema { types }
    }

    /// 按名取布局(递归;环→[`WireError::Cycle`],未注册→[`WireError::UnknownType`])。
    pub fn resolve(&self, name: &str) -> Result<WireLayout, WireError> {
        let mut visiting = BTreeSet::new();
        self.resolve_inner(name, &mut visiting)
    }

    fn resolve_inner(
        &self,
        name: &str,
        visiting: &mut BTreeSet<String>,
    ) -> Result<WireLayout, WireError> {
        if let Some(layout) = builtin_layout(name) {
            return Ok(layout);
        }
        if !visiting.insert(name.to_string()) {
            return Err(WireError::Cycle(name.to_string()));
        }
        let raw = self
            .types
            .get(name)
            .ok_or_else(|| WireError::UnknownType(name.to_string()))?;
        let layout = self.raw_to_layout(raw, visiting)?;
        visiting.remove(name);
        Ok(layout)
    }

    fn raw_to_layout(
        &self,
        raw: &RawType,
        visiting: &mut BTreeSet<String>,
    ) -> Result<WireLayout, WireError> {
        match raw {
            RawType::Builtin(b) => {
                builtin_layout(b).ok_or_else(|| WireError::UnknownType(b.clone()))
            }
            RawType::Named(n) => self.resolve_inner(n, visiting),
            RawType::Array(elem) => Ok(WireLayout::Array(Box::new(
                self.raw_to_layout(elem, visiting)?,
            ))),
            RawType::FixedDict(fields) => {
                let mut ws = Vec::with_capacity(fields.len());
                for (fname, frt) in fields {
                    ws.push(WireField {
                        name: fname.clone(),
                        layout: self.raw_to_layout(frt, visiting)?,
                    });
                }
                Ok(WireLayout::FixedDict(ws))
            }
        }
    }
}

use std::collections::BTreeSet;

/// 内建标量 → 布局(builtin.rs BUILTIN_TYPES 全 21 项;VECTOR 是内建容器标量)。
fn builtin_layout(name: &str) -> Option<WireLayout> {
    Some(match name {
        "UINT8" => WireLayout::U8,
        "UINT16" => WireLayout::U16,
        "UINT32" => WireLayout::U32,
        "UINT64" => WireLayout::U64,
        "INT8" => WireLayout::I8,
        "INT16" => WireLayout::I16,
        "INT32" => WireLayout::I32,
        "INT64" => WireLayout::I64,
        "FLOAT" => WireLayout::F32,
        "DOUBLE" => WireLayout::F64,
        "BOOL" => WireLayout::Bool,
        "STRING" => WireLayout::Str,
        "UNICODE" => WireLayout::Unicode,
        "PYTHON" => WireLayout::Py,
        "PY_DICT" => WireLayout::PyDict,
        "PY_TUPLE" => WireLayout::PyTuple,
        "PY_LIST" => WireLayout::PyList,
        "ENTITYCALL" => WireLayout::EntityCall,
        "BLOB" => WireLayout::Blob,
        "VECTOR2" => WireLayout::Vec2,
        "VECTOR3" => WireLayout::Vec3,
        "VECTOR4" => WireLayout::Vec4,
        _ => return None,
    })
}

/// 从 `<Type>` 元素(或顶层 `<NAME>` 元素)重解析出结构类型表达式。
fn raw_type_from_element(doc: &kode_parser::xml::Document, idx: usize) -> RawType {
    let directive = directive_of(doc, idx);
    match directive.as_str() {
        "FIXED_DICT" => {
            let mut fields = Vec::new();
            if let Some(props) = doc.child_element(idx, "Properties") {
                for prop in doc.child_elements(props) {
                    let p = doc.element(prop);
                    let name = p.name.clone();
                    if let Some(t) = doc.child_element(prop, "Type") {
                        fields.push((name, raw_type_from_element(doc, t)));
                    }
                }
            }
            RawType::FixedDict(fields)
        }
        "ARRAY" => {
            let elem = doc
                .child_element(idx, "of")
                .map(|of| raw_type_from_element(doc, of))
                .unwrap_or(RawType::Builtin("STRING".to_string()));
            RawType::Array(Box::new(elem))
        }
        "" => RawType::Builtin(String::new()),
        other => RawType::Named(other.to_string()),
    }
}

/// 类型表达式指引:元素文本首个 token;空则回落 `type` 属性值(extract_types 同款)。
fn directive_of(doc: &kode_parser::xml::Document, idx: usize) -> String {
    let e = doc.element(idx);
    if let Some(t) = e.first_text_token(doc) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    e.attributes
        .iter()
        .find(|a| a.name == "type")
        .map(|a| a.value.trim().to_string())
        .unwrap_or_default()
}

/// alias.xml 条目的目标名:Type 子元素文本 / 首个非 Type 子元素标签名 / 自身文本。
fn alias_target_of(doc: &kode_parser::xml::Document, idx: usize) -> String {
    let e = doc.element(idx);
    if let Some(t) = doc.child_element(idx, "Type") {
        let text = doc.element(t).text(doc).trim().to_string();
        if let Some(tok) = text.split_whitespace().next() {
            if !tok.is_empty() {
                return tok.to_string();
            }
        }
    }
    if let Some(other) = doc
        .child_elements(idx)
        .into_iter()
        .find(|&c| doc.element(c).name != "Type")
    {
        return doc.element(other).name.clone();
    }
    e.first_text_token(doc).unwrap_or_default()
}
