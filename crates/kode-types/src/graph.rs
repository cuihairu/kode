//! 类型图:节点 IR、边、别名链/继承链求值、全图环检测(书 §6.2 SEM-002/004/005/013)。
//!
//! 构建入口按输入种类递增灌入([`TypeGraph::add_types`] 等),查询面纯读。
//! 所有遍历均为有限步(visited 集合截断),环显式诊断,绝不死循环(IDX-005 同款保障)。

use std::collections::{BTreeMap, BTreeSet};

use kode_parser::model::{AliasFile, DefFile, EntityEntry, TypeKind, TypesFile};

use crate::builtin::is_known_terminal;

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
}

impl TypeNode {
    pub fn name(&self) -> &str {
        match self {
            TypeNode::Alias { name, .. }
            | TypeNode::Array { name, .. }
            | TypeNode::FixedDict { name, .. }
            | TypeNode::UserType { name } => name,
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
}

impl TypeGraph {
    pub fn new() -> TypeGraph {
        TypeGraph::default()
    }

    /// 节点入图;同名先到先得(与 TS 侧 Map 首写优先同口径),重复返回 None
    /// 且其边一并跳过(声明与边同源,避免双份)。
    fn push_node(&mut self, node: TypeNode) -> Option<TypeId> {
        let name = node.name().to_string();
        if self.by_name.contains_key(&name) {
            return None;
        }
        let id = TypeId(self.nodes.len() as u32);
        self.nodes.push(node);
        self.by_name.insert(name, id);
        Some(id)
    }

    /// 灌入 types.xml(kode_parser::model::parse_types 输出)。
    ///
    /// 口径:FixedDict/Array 建容器节点;其余条目的 directive 视为重定向目标
    /// 建 Alias 节点(引擎 addDataType 别名注册语义,与 TS parseTypesXml 的
    /// `kind: 'builtin'` 条目一一对应)。空 directive 条目 parser 已跳过。
    pub fn add_types(&mut self, types: &TypesFile) {
        for decl in &types.types {
            let Some(id) = (match &decl.kind {
                TypeKind::FixedDict => self.push_node(TypeNode::FixedDict {
                    name: decl.name.clone(),
                    implemented_by: decl.implemented_by_symbol.clone(),
                    field_refs: decl.field_refs.clone(),
                }),
                TypeKind::Array => self.push_node(TypeNode::Array {
                    name: decl.name.clone(),
                    element: decl.element_ref.clone(),
                }),
                TypeKind::Builtin => self.push_node(TypeNode::Alias {
                    name: decl.name.clone(),
                    // directive 首 token 即重定向目标;取不到时按无指向别名保留。
                    target: decl.directive.clone().unwrap_or_default(),
                }),
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
                                to: r,
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
            let Some(id) = self.push_node(TypeNode::Alias {
                name: decl.name.clone(),
                target: decl.alias_type.clone(),
            }) else {
                continue;
            };
            if !decl.alias_type.is_empty() {
                self.edges.push(TypeEdge {
                    from: id,
                    kind: EdgeKind::AliasTarget,
                    to: decl.alias_type.clone(),
                });
            }
        }
    }

    /// 灌入实体 .def(name = 文件名去 .def,与 kode-index::def_entity_name 同口径)。
    pub fn add_def(&mut self, name: &str, def: &DefFile) {
        let Some(id) = self.push_node(TypeNode::UserType {
            name: name.to_string(),
        }) else {
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
        }
        for comp in &def.components {
            if let Some(t) = &comp.component_type {
                self.edges.push(TypeEdge {
                    from: id,
                    kind: EdgeKind::ComponentOf,
                    to: t.clone(),
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
            }
        }
    }

    /// 灌入 entities.xml 注册面(解析输出已排除 root 伪条目)。
    pub fn register_entities(&mut self, entries: &[EntityEntry]) {
        for e in entries {
            self.registered_entities.insert(e.name.clone());
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

    fn known_terminal(&self, name: &str) -> bool {
        is_known_terminal(name)
            || self.by_name.contains_key(name)
            || self.registered_entities.contains(name)
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
