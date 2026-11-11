//! BAS-04 结构类型表达式。
//!
//! [`SemType`] 是语义层的类型表达式:标量(内建)/范围(标量值界)/别名/
//! 数组/固定字典/组件/实体引用/可空/联合/未知。字段名、声明序、源码位置
//! 在 [`FieldDef`] 中保留;位置缺失(类型图不携带)以 `None` 诚实标注,不伪造。
//!
//! 转换自 [`kode_types::TypeGraph`](kode_types::TypeGraph):别名链有界解析
//! (环/缺终点 → Unknown{reason}),数组/固定字典形状保持,未知引用降级
//! Unknown 不借用任意类型掩盖(与 kode-types SEM-013 同一诚实纪律)。
//!
//! **产生边界**:类型图只携 Alias/Array/FixedDict/UserType 四节点,故
//! `from_type_graph` 只产生 Builtin/Alias/Array/FixedDict/Entity/Unknown;
//! Range/Component/Nullable/Union 是表达语言面(构造+展示测试钉住),产生点
//! 待后续批(范围解析/组件槽/推导合流)接线。

use kode_types::TypeGraph;

/// 源码位置(0 基行/列;None = 来源未携带位置)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub line: usize,
    pub col: usize,
}

impl Span {
    pub fn new(line: usize, col: usize) -> Self {
        Self { line, col }
    }
}

/// 固定字典字段(保留字段名/声明序/位置)。
#[derive(Debug, Clone, PartialEq)]
pub struct FieldDef {
    pub name: String,
    pub span: Option<Span>,
    pub ty: SemType,
}

impl FieldDef {
    pub fn new(name: impl Into<String>, span: Option<Span>, ty: SemType) -> Self {
        Self { name: name.into(), span, ty }
    }
}

/// 结构类型表达式。
#[derive(Debug, Clone, PartialEq)]
pub enum SemType {
    /// 内建标量/容器名(INT32/FLOAT/VECTOR3/STRING/...;不含容器展开)。
    Builtin(String),
    /// 标量值范围(`<Range>` 等;min/max 原样保留,单位由引用方解释)。
    Range { base: Box<SemType>, min: Option<String>, max: Option<String> },
    /// 别名(名字 + 已解析指向;环/缺终点 → Unknown 原因)。
    Alias(String, Box<SemType>),
    /// 数组元素。
    Array(Box<SemType>),
    /// 固定字典(字段序保留;name = 类型名,无名(匿名 dict)为 None)。
    FixedDict { name: Option<String>, fields: Vec<FieldDef> },
    /// 实体引用(名字;身份绑定由 snapshot 以 SemId 完成)。
    Entity(String),
    /// 组件类型引用(经 ComponentOf 边解析;裸名在类型图不可解析时→Unknown)。
    Component(String),
    /// 可空(可证明 None 合并)。
    Nullable(Box<SemType>),
    /// 联合(多候选/多写者合流;顺序保留)。
    Union(Vec<SemType>),
    /// 未知(原因;绝不用任意类型掩盖缺失)。
    Unknown(String),
}

impl SemType {
    /// 人类可读(诊断/证据;非身份键)。
    pub fn display(&self) -> String {
        match self {
            SemType::Builtin(n) => n.clone(),
            SemType::Range { base, min, max } => {
                let b = base.display();
                match (min, max) {
                    (Some(mn), Some(mx)) => format!("{b}[{mn}..{mx}]"),
                    (Some(mn), None) => format!("{b}[{mn}..]"),
                    (None, Some(mx)) => format!("{b}[..{mx}]"),
                    (None, None) => b,
                }
            }
            SemType::Alias(n, inner) => format!("{n}={}", inner.display()),
            SemType::Array(e) => format!("ARRAY<{}>", e.display()),
            SemType::FixedDict { name, fields } => {
                let body: Vec<String> = fields.iter().map(|f| format!("{}:{}", f.name, f.ty.display())).collect();
                match name {
                    Some(n) => format!("{n}{{{}}}", body.join(",")),
                    None => format!("{{{}}}", body.join(",")),
                }
            }
            SemType::Entity(n) => format!("Entity<{n}>"),
            SemType::Component(n) => format!("Component<{n}>"),
            SemType::Nullable(t) => format!("{}?", t.display()),
            SemType::Union(ts) => format!("Union({})", ts.iter().map(|t| t.display()).collect::<Vec<_>>().join("|")),
            SemType::Unknown(r) => format!("Unknown({r})"),
        }
    }

    /// 从类型图按名解析(有界;未知/环 → Unknown 原因)。
    pub fn from_type_graph(graph: &TypeGraph, name: &str, max_hops: usize) -> SemType {
        Self::resolve(graph, name, max_hops, 0)
    }

    fn resolve(graph: &TypeGraph, name: &str, max_hops: usize, depth: usize) -> SemType {
        if depth > max_hops {
            return SemType::Unknown(format!("alias-chain-overflow:{name}"));
        }
        if kode_types::is_builtin(name) {
            return SemType::Builtin(name.to_string());
        }
        let Some(&id) = graph.by_name.get(name) else {
            return SemType::Unknown(format!("unresolved:{name}"));
        };
        match &graph.nodes[id.0 as usize] {
            kode_types::TypeNode::Alias { target, .. } => {
                let inner = Self::resolve(graph, target, max_hops, depth + 1);
                // 环整体不可信:超限 Unknown 不再逐层包 Alias,直传顶层。
                if let SemType::Unknown(ref r) = inner {
                    if r.starts_with("alias-chain-overflow") {
                        return inner;
                    }
                }
                SemType::Alias(name.to_string(), Box::new(inner))
            }
            kode_types::TypeNode::Array { element, .. } => {
                let inner = match element.as_deref() {
                    Some(e) if !e.is_empty() => Self::resolve(graph, e, max_hops, depth + 1),
                    _ => SemType::Unknown("array-no-element".into()),
                };
                SemType::Array(Box::new(inner))
            }
            kode_types::TypeNode::FixedDict { field_refs, .. } => {
                let fields = field_refs
                    .iter()
                    .map(|r| FieldDef::new(r.clone(), None, Self::resolve(graph, r, max_hops, depth + 1)))
                    .collect();
                SemType::FixedDict { name: Some(name.to_string()), fields }
            }
            // 用户类型节点 = 实体 .def 引用 → 实体引用。
            kode_types::TypeNode::UserType { .. } => SemType::Entity(name.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_parser::model::{AliasDecl, AliasFile, TypeDecl, TypeKind, TypesFile};

    #[test]
    fn builtin_direct() {
        let g = TypeGraph::new();
        let t = SemType::from_type_graph(&g, "INT32", 4);
        assert_eq!(t, SemType::Builtin("INT32".into()));
    }

    #[test]
    fn unresolved_is_unknown_not_fabricated() {
        let g = TypeGraph::new();
        let t = SemType::from_type_graph(&g, "NoSuchType", 4);
        assert!(matches!(t, SemType::Unknown(_)), "未知引用必须降级 Unknown 不伪造");
        assert!(t.display().contains("unresolved"));
    }

    #[test]
    fn alias_chain_resolves_to_builtin() {
        let mut g = TypeGraph::new();
        let mk = |name: &str, tgt: &str| AliasDecl {
            name: name.into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 1,
            alias_type: tgt.into(),
        };
        g.add_alias(&AliasFile { aliases: vec![mk("A", "B"), mk("B", "INT32")], ..Default::default() });
        let t = SemType::from_type_graph(&g, "A", 4);
        match t {
            SemType::Alias(_, inner) => match *inner {
                SemType::Alias(_, inner2) => assert!(matches!(*inner2, SemType::Builtin(_))),
                other => panic!("expected Alias, got {other:?}"),
            },
            other => panic!("expected Alias, got {other:?}"),
        }
    }

    #[test]
    fn fixed_dict_preserves_field_order_and_names() {
        let mut g = TypeGraph::new();
        let decl = TypeDecl {
            name: "Pos".into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 1,
            kind: TypeKind::FixedDict,
            directive: Some("FIXED_DICT".into()),
            implemented_by_symbol: None,
            field_refs: vec!["x".into(), "y".into(), "z".into()],
            element_ref: None,
        };
        g.add_types(&TypesFile { types: vec![decl], ..Default::default() });
        let t = SemType::from_type_graph(&g, "Pos", 4);
        match t {
            SemType::FixedDict { fields, .. } => {
                assert_eq!(fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["x", "y", "z"]);
            }
            other => panic!("expected FixedDict, got {other:?}"),
        }
    }

    #[test]
    fn array_shape_preserved() {
        let mut g = TypeGraph::new();
        let decl = TypeDecl {
            name: "Ints".into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 1,
            kind: TypeKind::Array,
            directive: Some("ARRAY".into()),
            implemented_by_symbol: None,
            field_refs: vec![],
            element_ref: Some("UINT32".into()),
        };
        g.add_types(&TypesFile { types: vec![decl], ..Default::default() });
        let t = SemType::from_type_graph(&g, "Ints", 4);
        assert!(matches!(t, SemType::Array(e) if matches!(&*e, SemType::Builtin(n) if n == "UINT32")));
    }

    #[test]
    fn nullable_and_union_display() {
        assert_eq!(SemType::Nullable(Box::new(SemType::Builtin("INT32".into()))).display(), "INT32?");
        let u = SemType::Union(vec![SemType::Builtin("INT32".into()), SemType::Builtin("STRING".into())]);
        assert_eq!(u.display(), "Union(INT32|STRING)");
    }

    #[test]
    fn alias_cycle_reports_overflow() {
        let mut g = TypeGraph::new();
        let mk = |name: &str, tgt: &str| AliasDecl {
            name: name.into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 1,
            alias_type: tgt.into(),
        };
        g.add_alias(&AliasFile { aliases: vec![mk("A", "B"), mk("B", "A")], ..Default::default() });
        let t = SemType::from_type_graph(&g, "A", 4);
        assert!(matches!(t, SemType::Unknown(r) if r.contains("alias-chain-overflow")));
    }

    // Range/Component 类型图无产生点(类型图只携 Alias/Array/FixedDict/
    // UserType 四节点);表达面以构造+展示钉住,产生面待后续批接线。
    #[test]
    fn range_display_keeps_bounds() {
        let r = SemType::Range {
            base: Box::new(SemType::Builtin("UINT8".into())),
            min: Some("0".into()),
            max: Some("100".into()),
        };
        assert_eq!(r.display(), "UINT8[0..100]");
        assert_eq!(
            SemType::Range { base: Box::new(SemType::Builtin("INT32".into())), min: None, max: Some("5".into()) }
                .display(),
            "INT32[..5]"
        );
    }

    #[test]
    fn component_and_entity_display() {
        assert_eq!(SemType::Component("Weapon".into()).display(), "Component<Weapon>");
        assert_eq!(SemType::Entity("Avatar".into()).display(), "Entity<Avatar>");
    }
}
