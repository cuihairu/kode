//! 项目侧布局抽取:types.xml / alias.xml → 别名线类型表;
//! entities.xml + .def → 实体线格式条目(todo PA-002「Wire Type Layout」)。
//!
//! 与 kode-types 类型图的分工:类型图(`kode_types::graph`)回答脚本语义
//! (引用边/别名链/继承链);本模块**独立**按网络序列化规则递归求值出
//! [`WireType`]。类型图 ≠ 网络序列化规则(PA-002 验收原文),两者不共用求值。

use std::collections::BTreeMap;
use std::path::Path;

use kode_parser::model::{parse_entities, DefFile, MethodDef, PropertyDef};
use kode_parser::xml::{self, NodeData};
use kode_types::builtin;

use crate::schema::{EntityMethodWire, EntityPropertyWire, EntityWireInfo};
use crate::wire::{builtin_wire_type, DictField, WireType, MAX_TYPE_DEPTH};

/// 原始别名表(名字 → 线类型;求值结果已递归展开;环 → Unresolved)。
pub type AliasMap = BTreeMap<String, WireType>;

/// types.xml + alias.xml 的原始声明(XML 层;先收集后求值)。
#[derive(Debug, Default)]
pub struct RawTypes {
    /// 名字 → 指引(内建名 / FIXED_DICT / ARRAY)。
    directives: BTreeMap<String, RawDecl>,
}

#[derive(Debug)]
struct RawDecl {
    directive: String,
    /// FIXED_DICT:字段声明序(字段名, 类型引用或内嵌 ARRAY 元素引用)。
    dict_fields: Vec<(String, Option<String>)>,
    /// FIXED_DICT:implementedBy 原文。
    implemented_by: Option<String>,
    /// ARRAY:`<of>` 元素引用。
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
        // 首个非空文本 token = 指引(FIXED_DICT/ARRAY/内建名);空则回落 type 属性。
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
                            // 数组元素写在 <Type> 内的 <of>;否则取 Type 文本首 token。
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

/// alias.xml(`<Name><Type> T </Type></Name>` 关联表;kode-parser `parse_alias`
/// 语义的线类型版:名字 → 目标引用)。
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

/// 递归求值:引用名 → 线类型。内建名直接映射;自定义名查声明表;
/// 环/缺失 → Unresolved(深度上限 [`MAX_TYPE_DEPTH`],绝不无限递归)。
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
            // 别名链(ITEM_ID → UINT16 / 自定义 → 自定义):继续递归求值,
            // 环由深度上限兜底落 Unresolved。
            other => resolve_ref(raw, other, depth + 1),
        },
    }
}

/// 全表求值(顺序 = 声明序;诊断:环/缺失逐条落 `Unresolved`,不失败)。
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
// .def → 实体线格式
// ---------------------------------------------------------------------------

/// 合并序:父 .def → 接口 .def → 自身(引擎 EntityDef 加载序;
/// 同名属性先到先得,自身覆盖父)。
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

/// 一个 .def 语义视图 → 实体线格式条目(属性/方法参数全部递归求值为线类型)。
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

/// 加载 .def 语义的辅助:文件名(去目录去后缀)→ 实体/接口名。
pub fn def_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.strip_suffix(".def").unwrap_or(n).to_string())
}

/// 实体注册属性(hasClient 等)读取(entities.xml attributes)。
pub fn entity_registered(entities_xml: &str) -> Vec<(String, Vec<(String, String)>)> {
    parse_entities(entities_xml)
        .entities
        .iter()
        .map(|e| (e.name.clone(), e.attributes.clone()))
        .collect()
}

/// builtin 透明转发(kode-types 复用面;保证 alias 分类口径一致)。
pub fn is_builtin_type(name: &str) -> bool {
    builtin::is_builtin(name)
}
