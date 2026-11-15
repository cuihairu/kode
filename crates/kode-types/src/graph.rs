//! 类型图:节点 IR、边、别名链/继承链求值、全图环检测(书 §6.2 SEM-002/004/005/013)。
//!
//! 构建入口按输入种类递增灌入([`TypeGraph::add_types`] 等),查询面纯读。
//! 所有遍历均为有限步(visited 集合截断),环显式诊断,绝不死循环(IDX-005 同款保障)。

use std::collections::{BTreeMap, BTreeSet};

use kode_parser::model::{AliasFile, DefFile, EntityEntry, TypeKind, TypesFile};
use kode_parser::Span;

use crate::builtin::is_known_terminal;
use crate::provenance::{GenerationTarget, IngestContext, TypeOrigin, TypeRefSite, TypeSourceKind};

/// 稳定节点 id = 节点表下标(构建完成后不变;SEM-001 的 TypeId 基础版)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TypeId(pub u32);

/// 类型节点 IR(SEM-002;Builtin 不建节点,以引用终点表示)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeNode {
    /// 重定向类型:types.xml 非 FIXED_DICT/ARRAY 条目(directive 即指向)、
    /// alias.xml 条目。引擎 addDataType 语义:别名注册,存储/网络层用别名名。
    Alias { name: String, target: String },
    /// 数组容器:`ARRAY <of> 元素 </of>`。
    Array {
        name: String,
        element: Option<String>,
    },
    /// FixedDict 容器:键字段引用(扁平,顺序保留)+ implementedBy 末段符号。
    FixedDict {
        name: String,
        implemented_by: Option<String>,
        field_refs: Vec<String>,
    },
    /// 用户类型:实体 .def(可被属性类型/组件/继承引用)。
    UserType { name: String },
    /// 未注册引用终点(RUST-104-W;SEM-013 Unknown 的 IR 节点形态):名字
    /// 被引用但不在任何注册表。引擎侧该名不可用——别名目标查无 = loadTypes
    /// 整体失败 abort(datatypes.cpp:170),def 属性查无 = DataType is NULL
    /// (property.cpp:70)。**opt-in 物化**:构建器永不自动建此节点
    /// (first-write-wins 与链求值语义不变),由 [`TypeGraph::materialize_unknown`]
    /// 或直接构造进入图;物化后分类仍为 [`TypeClass::Unknown`]、链求值终点
    /// 不算「已知」([`TypeGraph::known_terminal`] 对其返 false)。
    Unknown { name: String },
    /// 引擎拒收形态(RUST-104-W):结构上存在但引擎 load 即 abort 的类型
    /// (理由见 [`TypeErrorReason`] 引擎锚)。同样 opt-in(构建器不自动建);
    /// 分类为 [`TypeClass::Unknown`](引擎拒收 = 该名在运行引擎中不存在,
    /// 不是可用类型类),诊断面经 [`TypeGraph::engine_conformance_reports`]
    /// 如实枚举。
    Error {
        name: String,
        reason: TypeErrorReason,
    },
}

/// 引擎拒收理由(RUST-104-W;「以真实 KBEngine 支持语义落地」——每变体
/// 括注引擎真源锚点,全部 = 引擎 load 阶段 abort,该形态不可用)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeErrorReason {
    /// 名以前缀 `_`:引擎禁用(datatypes.cpp:43-50 validTypeName;
    /// :124-127 非法名 abort)。
    ReservedUnderscorePrefix,
    /// 别名/重定向指向为空:引擎目标查无即 loadTypes 整体失败 abort
    /// (datatypes.cpp:170-177)。解析器对空 directive 条目已跳过 →
    /// 此形态仅直接灌图的容错输入可达(既有钉测试语义保留)。
    EmptyTarget,
    /// ARRAY 缺 `<of>`(datatype.cpp:1665 `not found "of"` abort)。
    ArrayMissingOf,
    /// FIXED_DICT 缺 `Properties` 子节点(datatype.cpp:2053 abort)。
    /// 图内不可与「Properties 存在但为空」区分(均 = field_refs 空)
    /// → 符合性报告不谎报此理由,仅供直接构造标注。
    FixedDictMissingProperties,
    /// FIXED_DICT 键引用未注册类型(datatype.cpp:2153
    /// `key[N] did not find type[X]` abort)。`target` = 类型引用名;
    /// 键名在 IR 中已折平丢失(wire_codec 同口径),如实只报类型名。
    FixedDictKeyUnknownType { target: String },
}

impl TypeErrorReason {
    pub fn as_str(&self) -> &str {
        match self {
            TypeErrorReason::ReservedUnderscorePrefix => "reserved_underscore_prefix",
            TypeErrorReason::EmptyTarget => "empty_target",
            TypeErrorReason::ArrayMissingOf => "array_missing_of",
            TypeErrorReason::FixedDictMissingProperties => "fixed_dict_missing_properties",
            TypeErrorReason::FixedDictKeyUnknownType { .. } => "fixed_dict_key_unknown_type",
        }
    }
}

impl TypeNode {
    pub fn name(&self) -> &str {
        match self {
            TypeNode::Alias { name, .. }
            | TypeNode::Array { name, .. }
            | TypeNode::FixedDict { name, .. }
            | TypeNode::UserType { name }
            | TypeNode::Unknown { name } => name,
            TypeNode::Error { name, .. } => name,
        }
    }
}

/// 边种类(SEM-002 的 EntityRef/Component 以边表达;IDX-002 补充继承边)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeKind {
    /// 别名 → 指向。
    AliasTarget,
    /// 数组 → 元素类型。
    ArrayElement,
    /// FixedDict → 键字段类型。
    Field,
    /// 实体属性 → 属性类型引用。
    TypeRef,
    /// 实体 → 组件类型。
    ComponentOf,
    /// 实体 → Parent。
    Inherits,
}

impl EdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::AliasTarget => "alias_target",
            EdgeKind::ArrayElement => "array_element",
            EdgeKind::Field => "field",
            EdgeKind::TypeRef => "type_ref",
            EdgeKind::ComponentOf => "component_of",
            EdgeKind::Inherits => "inherits",
        }
    }
}

/// 有向边:from 节点 → to 名称(to 可能是内建/未知,不强制成节点)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeEdge {
    pub from: TypeId,
    pub kind: EdgeKind,
    pub to: String,
}

/// 名称分类(SEM-013:Unknown 保留,不冒充内建)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeClass {
    Builtin,
    Alias,
    Array,
    FixedDict,
    Entity,
    Unknown,
}

impl TypeClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            TypeClass::Builtin => "builtin",
            TypeClass::Alias => "alias",
            TypeClass::Array => "array",
            TypeClass::FixedDict => "fixed_dict",
            TypeClass::Entity => "entity",
            TypeClass::Unknown => "unknown",
        }
    }
}

/// 链求值状态(cycle/missing 均为显式诊断,链保留已走部分)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainStatus {
    Resolved,
    Cycle,
    /// 别名链:终点类型未在任何注册表(SEM-013 理由 = 终点名)。
    Unknown,
    /// 继承链:某级 Parent 不是已注册实体。
    Missing,
}

/// 别名链求值结果(SEM-004)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasChain {
    pub chain: Vec<String>,
    pub status: ChainStatus,
}

/// 实体继承链求值结果(SEM-007 继承面基础版)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InheritanceChain {
    pub chain: Vec<String>,
    pub status: ChainStatus,
}

/// Optionality 所在的结构槽位(RUST-104-W)。引擎没有 Optional 类型节点
/// ——可选性只存在于槽位,且两义分明,按引擎真源分类:
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionalSlot {
    /// FIXED_DICT 的 `implementedBy` 缺席:**引擎可选**(官方 types.md
    /// "Optional implementation" —— 缺席 = 字典内存表示,自定义类仅接管
    /// 序列化)。图内每个 `implemented_by: None` 的 FixedDict 均属此形态。
    FixedDictImplementedBy,
    /// ARRAY 的 `<of>` 缺席:**引擎拒收**(datatype.cpp:1665 abort)。
    /// IR 的 Option 槽承接容错半成品输入(既有钉:保留节点不产边),
    /// 此槽位不代表引擎可用形态,诊断归 [`TypeErrorReason::ArrayMissingOf`]。
    ArrayElement,
}

impl OptionalSlot {
    pub fn as_str(&self) -> &'static str {
        match self {
            OptionalSlot::FixedDictImplementedBy => "fixed_dict_implemented_by",
            OptionalSlot::ArrayElement => "array_element",
        }
    }
}

/// Optionality 面:节点 + 槽位(查询面枚举,不发明 Optional 节点歪曲引擎)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionalFace {
    pub node: TypeId,
    pub name: String,
    pub slot: OptionalSlot,
}

/// 引擎符合性报告:图内引擎 load 即拒收的形态(纯查询,构建语义零改动)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConformanceReport {
    pub node: TypeId,
    pub name: String,
    pub reason: TypeErrorReason,
}

/// 类型图。
#[derive(Debug, Clone, Default)]
pub struct TypeGraph {
    pub nodes: Vec<TypeNode>,
    pub by_name: BTreeMap<String, TypeId>,
    pub edges: Vec<TypeEdge>,
    /// 实体名 → Parent 声明(来自 .def;无 Parent 不入表)。
    pub entity_parents: BTreeMap<String, String>,
    /// entities.xml 注册名(注册面;可与 .def 交叠)。
    pub registered_entities: BTreeSet<String>,
    /// 节点出处平行表(RUST-105;`push_node` 单隘口锁步;绕过 push_node
    /// 直接写节点表不锁步,读面 [`TypeGraph::origin_of`] 防御性返 None)。
    pub origins: Vec<TypeOrigin>,
    /// 引用点记录(RUST-105;锚 = 引用方声明 name span,统一口径见
    /// [`crate::provenance`] 模块doc)。
    pub ref_sites: Vec<TypeRefSite>,
    /// entities.xml 注册出处(RUST-105;注册面无节点,纯侧表,同名先到先得)。
    pub entity_registrations: BTreeMap<String, TypeOrigin>,
    /// 生成映射(RUST-105;opt-in 注册,构建器永不自动填充)。
    pub generation_links: BTreeMap<String, Vec<GenerationTarget>>,
    /// 灌入上下文([`TypeGraph::set_ingest`] 设置;add_* 盖章携带)。
    pub(crate) ingest: IngestContext,
}

impl TypeGraph {
    pub fn new() -> TypeGraph {
        TypeGraph::default()
    }

    /// 节点入图;同名先到先得(与 TS 侧 Map 首写优先同口径),重复返回 None
    /// 且其边一并跳过(声明与边同源,避免双份)。出处随入 [`TypeOrigin`]
    /// 平行表(下标锁步)。
    fn push_node(&mut self, node: TypeNode, origin: TypeOrigin) -> Option<TypeId> {
        let name = node.name().to_string();
        if self.by_name.contains_key(&name) {
            return None;
        }
        let id = TypeId(self.nodes.len() as u32);
        self.nodes.push(node);
        self.origins.push(origin);
        self.by_name.insert(name, id);
        Some(id)
    }

    /// 出处盖章:灌入上下文(root/version)+ 来源种类 + 声明 site。
    fn origin_for(
        &self,
        source: TypeSourceKind,
        span: Option<Span>,
        line: Option<usize>,
    ) -> TypeOrigin {
        TypeOrigin {
            source,
            span,
            line,
            root: self.ingest.root.clone(),
            version: self.ingest.version,
        }
    }

    /// 灌入 types.xml(kode_parser::model::parse_types 输出)。
    ///
    /// 口径:FixedDict/Array 建容器节点;其余条目的 directive 视为重定向目标
    /// 建 Alias 节点(引擎 addDataType 别名注册语义,与 TS parseTypesXml 的
    /// `kind: 'builtin'` 条目一一对应)。空 directive 条目 parser 已跳过。
    pub fn add_types(&mut self, types: &TypesFile) {
        for decl in &types.types {
            let origin = self.origin_for(
                TypeSourceKind::TypesXml,
                Some(decl.name_span),
                Some(decl.line),
            );
            let Some(id) = (match &decl.kind {
                TypeKind::FixedDict => self.push_node(
                    TypeNode::FixedDict {
                        name: decl.name.clone(),
                        implemented_by: decl.implemented_by_symbol.clone(),
                        field_refs: decl.field_refs.clone(),
                    },
                    origin,
                ),
                TypeKind::Array => self.push_node(
                    TypeNode::Array {
                        name: decl.name.clone(),
                        element: decl.element_ref.clone(),
                    },
                    origin,
                ),
                TypeKind::Builtin => self.push_node(
                    TypeNode::Alias {
                        name: decl.name.clone(),
                        // directive 首 token 即重定向目标;取不到时按无指向别名保留。
                        target: decl.directive.clone().unwrap_or_default(),
                    },
                    origin,
                ),
            }) else {
                continue;
            };
            match &decl.kind {
                TypeKind::FixedDict => {
                    let node = &self.nodes[id.0 as usize];
                    if let TypeNode::FixedDict { field_refs, .. } = node {
                        for r in field_refs.clone() {
                            self.edges.push(TypeEdge {
                                from: id,
                                kind: EdgeKind::Field,
                                to: r.clone(),
                            });
                            self.ref_sites.push(TypeRefSite {
                                from: id,
                                kind: EdgeKind::Field,
                                name: r,
                                // 锚 = 引用方(容器)声明名;parser 不暴露
                                // `<Type>` 文本独立 span。
                                span: Some(decl.name_span),
                                line: Some(decl.line),
                            });
                        }
                    }
                }
                TypeKind::Array => {
                    if let Some(element) = &decl.element_ref {
                        if !element.is_empty() {
                            self.edges.push(TypeEdge {
                                from: id,
                                kind: EdgeKind::ArrayElement,
                                to: element.clone(),
                            });
                            self.ref_sites.push(TypeRefSite {
                                from: id,
                                kind: EdgeKind::ArrayElement,
                                name: element.clone(),
                                span: Some(decl.name_span),
                                line: Some(decl.line),
                            });
                        }
                    }
                }
                TypeKind::Builtin => {
                    let node = &self.nodes[id.0 as usize];
                    if let TypeNode::Alias { target, .. } = node {
                        if !target.is_empty() {
                            self.edges.push(TypeEdge {
                                from: id,
                                kind: EdgeKind::AliasTarget,
                                to: target.clone(),
                            });
                            self.ref_sites.push(TypeRefSite {
                                from: id,
                                kind: EdgeKind::AliasTarget,
                                name: target.clone(),
                                span: Some(decl.name_span),
                                line: Some(decl.line),
                            });
                        }
                    }
                }
            }
        }
    }

    /// 灌入 alias.xml(kode_parser::model::parse_alias 输出;属性式条目
    /// parser 已结构化隔离,不进图,与 TS 现实现同口径)。
    pub fn add_alias(&mut self, alias: &AliasFile) {
        for decl in &alias.aliases {
            let origin = self.origin_for(
                TypeSourceKind::AliasXml,
                Some(decl.name_span),
                Some(decl.line),
            );
            let Some(id) = self.push_node(
                TypeNode::Alias {
                    name: decl.name.clone(),
                    target: decl.alias_type.clone(),
                },
                origin,
            ) else {
                continue;
            };
            if !decl.alias_type.is_empty() {
                self.edges.push(TypeEdge {
                    from: id,
                    kind: EdgeKind::AliasTarget,
                    to: decl.alias_type.clone(),
                });
                self.ref_sites.push(TypeRefSite {
                    from: id,
                    kind: EdgeKind::AliasTarget,
                    name: decl.alias_type.clone(),
                    span: Some(decl.name_span),
                    line: Some(decl.line),
                });
            }
        }
    }

    /// 灌入实体 .def(name = 文件名去 .def,与 kode-index::def_entity_name 同口径)。
    /// 出处 = 定义出处;实体名来自文件名,正文无声明 site → span/line 为
    /// None(不虚构)。
    pub fn add_def(&mut self, name: &str, def: &DefFile) {
        let origin = self.origin_for(TypeSourceKind::Def, None, None);
        let Some(id) = self.push_node(
            TypeNode::UserType {
                name: name.to_string(),
            },
            origin,
        ) else {
            return;
        };
        if let Some(parent) = &def.parent {
            self.entity_parents
                .entry(name.to_string())
                .or_insert_with(|| parent.clone());
            self.edges.push(TypeEdge {
                from: id,
                kind: EdgeKind::Inherits,
                to: parent.clone(),
            });
            // DefFile.parent 不带 span,引用点如实无锚。
            self.ref_sites.push(TypeRefSite {
                from: id,
                kind: EdgeKind::Inherits,
                name: parent.clone(),
                span: None,
                line: None,
            });
        }
        for comp in &def.components {
            if let Some(t) = &comp.component_type {
                self.edges.push(TypeEdge {
                    from: id,
                    kind: EdgeKind::ComponentOf,
                    to: t.clone(),
                });
                // 锚 = 引用方(组件槽)声明名。
                self.ref_sites.push(TypeRefSite {
                    from: id,
                    kind: EdgeKind::ComponentOf,
                    name: t.clone(),
                    span: Some(comp.name_span),
                    line: Some(comp.line),
                });
            }
        }
        for prop in &def.properties {
            for r in &prop.type_refs {
                self.edges.push(TypeEdge {
                    from: id,
                    kind: EdgeKind::TypeRef,
                    to: r.clone(),
                });
                // 锚 = 引用方(属性)声明名;`<Type>` 文本无独立 span。
                self.ref_sites.push(TypeRefSite {
                    from: id,
                    kind: EdgeKind::TypeRef,
                    name: r.clone(),
                    span: Some(prop.name_span),
                    line: Some(prop.line),
                });
            }
        }
    }

    /// 灌入 entities.xml 注册面(解析输出已排除 root 伪条目)。注册出处
    /// 落 [`TypeGraph::entity_registrations`] 侧表(同名先到先得)。
    pub fn register_entities(&mut self, entries: &[EntityEntry]) {
        for e in entries {
            self.registered_entities.insert(e.name.clone());
            let origin =
                self.origin_for(TypeSourceKind::EntitiesXml, Some(e.name_span), Some(e.line));
            self.entity_registrations
                .entry(e.name.clone())
                .or_insert(origin);
        }
    }

    /// 名称分类(SEM-013:查无去处 → Unknown)。
    pub fn classify(&self, name: &str) -> TypeClass {
        if crate::builtin::is_builtin(name) {
            return TypeClass::Builtin;
        }
        match self.by_name.get(name) {
            None => {
                if self.registered_entities.contains(name) {
                    TypeClass::Entity
                } else {
                    TypeClass::Unknown
                }
            }
            Some(id) => match &self.nodes[id.0 as usize] {
                TypeNode::Alias { .. } => TypeClass::Alias,
                TypeNode::Array { .. } => TypeClass::Array,
                TypeNode::FixedDict { .. } => TypeClass::FixedDict,
                TypeNode::UserType { .. } => TypeClass::Entity,
                // Unknown/Error 节点(物化/标注形态)都不是可用类型类:
                // Unknown = 未注册;Error = 引擎 load 即 abort。
                TypeNode::Unknown { .. } | TypeNode::Error { .. } => TypeClass::Unknown,
            },
        }
    }

    fn alias_target(&self, name: &str) -> Option<&str> {
        let id = self.by_name.get(name)?;
        match &self.nodes[id.0 as usize] {
            TypeNode::Alias { target, .. } => Some(target),
            _ => None,
        }
    }

    /// 终点已知性(变体感知,RUST-104-W):物化的 Unknown/Error 节点虽在
    /// `by_name`,但不是「已知终点」——否则链求值会把未注册/拒收形态判成
    /// Resolved(撒谎);既有四类节点与注册实体语义不变。
    fn known_terminal(&self, name: &str) -> bool {
        if is_known_terminal(name) || self.registered_entities.contains(name) {
            return true;
        }
        match self.by_name.get(name).map(|id| &self.nodes[id.0 as usize]) {
            Some(TypeNode::Unknown { .. }) | Some(TypeNode::Error { .. }) => false,
            Some(_) => true,
            None => false,
        }
    }

    /// 显式物化 Unknown 节点(RUST-104-W;opt-in,构建器永不自动调用):
    /// 名字非空、非内置终点、无节点、非注册实体 → 建 [`TypeNode::Unknown`]
    /// 入图;否则 `None`(已知名重复物化拒绝)。物化前后分类/链求值语义
    /// 一致(仍 Unknown),只是 IR 里有了显式节点形态供诊断枚举。
    pub fn materialize_unknown(&mut self, name: &str) -> Option<TypeId> {
        if name.is_empty()
            || is_known_terminal(name)
            || self.by_name.contains_key(name)
            || self.registered_entities.contains(name)
        {
            return None;
        }
        self.push_node(
            TypeNode::Unknown {
                name: name.to_string(),
            },
            TypeOrigin::direct(),
        )
    }

    /// 显式登记引擎拒收形态(RUST-104-W;opt-in,带 [`TypeErrorReason`]
    /// 引擎锚)。同名先到先得(与 [`TypeGraph::push_node`] 同口径)。
    pub fn push_error_node(&mut self, name: &str, reason: TypeErrorReason) -> Option<TypeId> {
        if name.is_empty() {
            return None;
        }
        self.push_node(
            TypeNode::Error {
                name: name.to_string(),
                reason,
            },
            TypeOrigin::direct(),
        )
    }

    /// 全图悬挂引用枚举(RUST-104-W;SEM-013 Unknown 保留不冒充):每条边
    /// 的 `to` 名,凡非内置终点、无节点、非注册实体 → Unknown。引擎侧该名
    /// load 即不可用(别名目标 datatypes.cpp:170 / def 属性 property.cpp:70)。
    /// 输出按字母序去重;纯查询,不自动物化。
    pub fn unknown_terminals(&self) -> Vec<String> {
        let mut out: BTreeSet<String> = BTreeSet::new();
        for edge in &self.edges {
            let n = &edge.to;
            if !n.is_empty()
                && !is_known_terminal(n)
                && !self.by_name.contains_key(n)
                && !self.registered_entities.contains(n)
            {
                out.insert(n.clone());
            }
        }
        out.into_iter().collect()
    }

    /// Optionality 面枚举(RUST-104-W):图内全部 `Option` 结构槽位,按
    /// [`OptionalSlot`] 的引擎真源两义标注。输出按节点序稳定。
    pub fn optional_faces(&self) -> Vec<OptionalFace> {
        let mut out = Vec::new();
        for (i, node) in self.nodes.iter().enumerate() {
            let face = match node {
                TypeNode::FixedDict {
                    name,
                    implemented_by: None,
                    ..
                } => OptionalFace {
                    node: TypeId(i as u32),
                    name: name.clone(),
                    slot: OptionalSlot::FixedDictImplementedBy,
                },
                TypeNode::Array {
                    name,
                    element: None,
                } => OptionalFace {
                    node: TypeId(i as u32),
                    name: name.clone(),
                    slot: OptionalSlot::ArrayElement,
                },
                _ => continue,
            };
            out.push(face);
        }
        out
    }

    /// 全图引擎符合性报告(RUST-104-W;纯查询,构建语义零改动):枚举图内
    /// 引擎 load 即拒收的形态。只认图内数据可证的检测面——`_` 前缀名
    /// (datatypes.cpp:43-50)、空指向别名(容错输入,datatypes.cpp:170)、
    /// ARRAY 缺 `<of>`(datatype.cpp:1665)、FIXED_DICT 键类型引用未注册
    /// (datatype.cpp:2153,键名 IR 已折平只报类型名)。FIXED_DICT 缺
    /// Properties(datatype.cpp:2053)与「Properties 为空」在图内同形,
    /// 不可区分 → 不谎报。输出按节点序稳定。
    pub fn engine_conformance_reports(&self) -> Vec<ConformanceReport> {
        let mut out = Vec::new();
        for (i, node) in self.nodes.iter().enumerate() {
            let id = TypeId(i as u32);
            let name = node.name();
            if name.starts_with('_') {
                out.push(ConformanceReport {
                    node: id,
                    name: name.to_string(),
                    reason: TypeErrorReason::ReservedUnderscorePrefix,
                });
            }
            match node {
                TypeNode::Alias { target, .. } if target.is_empty() => {
                    out.push(ConformanceReport {
                        node: id,
                        name: name.to_string(),
                        reason: TypeErrorReason::EmptyTarget,
                    });
                }
                TypeNode::Array { element, .. } if element.as_deref().is_none_or(str::is_empty) => {
                    out.push(ConformanceReport {
                        node: id,
                        name: name.to_string(),
                        reason: TypeErrorReason::ArrayMissingOf,
                    });
                }
                TypeNode::FixedDict { field_refs, .. } => {
                    for target in field_refs {
                        if target.is_empty()
                            || is_known_terminal(target)
                            || self.by_name.contains_key(target)
                            || self.registered_entities.contains(target)
                        {
                            continue;
                        }
                        out.push(ConformanceReport {
                            node: id,
                            name: name.to_string(),
                            reason: TypeErrorReason::FixedDictKeyUnknownType {
                                target: target.clone(),
                            },
                        });
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// 别名链(SEM-004):从别名名沿 AliasTarget 走到非别名终点。
    /// 环 → [`ChainStatus::Cycle`] 并截断在重复点前;终点查无注册 →
    /// [`ChainStatus::Unknown`](理由 = 终点名)。
    pub fn resolve_alias_chain(&self, name: &str) -> AliasChain {
        let mut chain = vec![name.to_string()];
        let mut seen: BTreeSet<String> = BTreeSet::from([name.to_string()]);
        let mut cycle = false;
        let mut current = name;
        while let Some(target) = self.alias_target(current) {
            if !target.is_empty() && seen.contains(target) {
                cycle = true;
                break;
            }
            if target.is_empty() {
                break;
            }
            chain.push(target.to_string());
            seen.insert(target.to_string());
            current = target;
        }
        let status = if cycle {
            ChainStatus::Cycle
        } else if self.known_terminal(current) {
            ChainStatus::Resolved
        } else {
            ChainStatus::Unknown
        };
        AliasChain { chain, status }
    }

    /// 实体继承链(SEM-007 基础版):从实体沿 Parent 走到根。
    /// 环 → [`ChainStatus::Cycle`];某级 Parent 未注册 →
    /// [`ChainStatus::Missing`](理由 = 该级名);否则 [`ChainStatus::Resolved`]。
    pub fn resolve_inheritance(&self, entity: &str) -> InheritanceChain {
        let mut chain = vec![entity.to_string()];
        let mut seen: BTreeSet<String> = BTreeSet::from([entity.to_string()]);
        let mut status = ChainStatus::Resolved;
        let mut current = entity;
        while let Some(parent) = self.entity_parents.get(current) {
            if seen.contains(parent) {
                status = ChainStatus::Cycle;
                break;
            }
            chain.push(parent.clone());
            seen.insert(parent.clone());
            if !self.known_entity(parent) {
                status = ChainStatus::Missing;
                break;
            }
            current = parent.as_str();
        }
        InheritanceChain { chain, status }
    }

    fn known_entity(&self, name: &str) -> bool {
        self.entity_parents.contains_key(name)
            || self.registered_entities.contains(name)
            || matches!(
                self.by_name.get(name).map(|id| &self.nodes[id.0 as usize]),
                Some(TypeNode::UserType { .. })
            )
    }

    /// 全图环检测:对全部「终点能解析成节点」的边做迭代式三色 DFS,
    /// 每条回边报告一条环路径(自环报告单元素环)。输出按发现顺序去重,
    /// 节点序/邻接序确定 → 结果确定。
    pub fn find_cycles(&self) -> Vec<Vec<String>> {
        // 邻接表:node id → (目标名,目标 id)。
        let mut adj: BTreeMap<u32, Vec<(String, u32)>> = BTreeMap::new();
        for edge in &self.edges {
            if let Some(to_id) = self.by_name.get(&edge.to) {
                adj.entry(edge.from.0)
                    .or_default()
                    .push((edge.to.clone(), to_id.0));
            }
        }
        const WHITE: u8 = 0;
        const GREY: u8 = 1;
        const BLACK: u8 = 2;
        let mut color = vec![WHITE; self.nodes.len()];
        let mut cycles: Vec<Vec<String>> = Vec::new();
        let mut seen_cycles: BTreeSet<Vec<String>> = BTreeSet::new();

        for start in 0..self.nodes.len() {
            if color[start] != WHITE {
                continue;
            }
            // 迭代 DFS:栈元素 = (节点, 已展开的邻接游标)。
            let mut stack: Vec<(u32, usize)> = vec![(start as u32, 0)];
            let mut path: Vec<u32> = vec![start as u32];
            color[start] = GREY;
            while let Some((node, cursor)) = stack.last_mut() {
                let node = *node;
                let neighbours = adj.get(&node).cloned().unwrap_or_default();
                if *cursor >= neighbours.len() {
                    color[node as usize] = BLACK;
                    stack.pop();
                    path.pop();
                    continue;
                }
                let (to_name, to_id) = neighbours[*cursor].clone();
                *cursor += 1;
                match color[to_id as usize] {
                    GREY => {
                        // 回边:路径上 to_id 首次出现处 → 当前构成环。
                        let pos = path.iter().position(|n| *n == to_id).unwrap_or(0);
                        let cycle: Vec<String> = path[pos..]
                            .iter()
                            .map(|n| self.nodes[*n as usize].name().to_string())
                            .chain(std::iter::once(to_name))
                            .collect();
                        if seen_cycles.insert(cycle.clone()) {
                            cycles.push(cycle);
                        }
                    }
                    WHITE => {
                        color[to_id as usize] = GREY;
                        stack.push((to_id, 0));
                        path.push(to_id);
                    }
                    _ => {}
                }
            }
        }
        cycles
    }
}
