//! 关系分类(plan §4.2):引擎确定(ARRAY/组件子表 + parentID)、真实 FK、业务显式声明、
//! 未明(pickle 内嵌 ID)、外部(kbe_ 表)。
//!
//! 引擎事实(source-evidence §4/§5):子表 `parentID` 是纯逻辑列,无数据库外键;父表先插入,
//! 取 `LAST_INSERT_ID` 再按 `parentID` 写子表。关系图以派生 schema 的表结构为输入。

use std::collections::BTreeMap;

use crate::error::{CloneError, CloneResult};
use crate::schema::{CloneSchema, DerivedTable};

/// 关系类别(plan §4.2 A–E,命名对齐计划书 PDC-0104)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationKind {
    /// 引擎生成(§4.2-A):ARRAY/组件子表 + parentID 列(无 DB 外键,纯逻辑)。
    EngineGenerated,
    /// 真实数据库外键(§4.2-B;引擎当前为空,预留)。
    ForeignKey,
    /// 项目显式声明(§4.2-C:Account.characters、guildDBID 等,由用户声明)。
    ProjectDeclared,
    /// 未明(§4.2-D:pickle blob 内嵌 ID,不触碰)。
    Unresolved,
    /// 外部(§4.2-E:kbe_ 内部表,排除)。
    External,
}

impl RelationKind {
    pub fn label(self) -> &'static str {
        match self {
            RelationKind::EngineGenerated => "engine-generated",
            RelationKind::ForeignKey => "foreign-key",
            RelationKind::ProjectDeclared => "project-declared",
            RelationKind::Unresolved => "unresolved",
            RelationKind::External => "external",
        }
    }
}

/// 一条关系:子表经 parentID 挂到父表(或显式声明)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    pub child_table: String,
    pub parent_table: String,
    pub kind: RelationKind,
    /// 关系来源属性路径(子表 property_path)。
    pub via_property: Option<String>,
    /// 关系携带的载荷列(ARRAY 的 sm_value 等;FK/业务为声明)。
    pub payload_columns: Vec<String>,
}

/// 关系图:以派生 schema 构建,提供遍历顺序(父先子后)与环检测。
#[derive(Debug, Clone, Default)]
pub struct RelationGraph {
    /// 子表 → 关系。
    pub edges: BTreeMap<String, Relation>,
    /// 表 → 直接子表(父先序)。
    pub children: BTreeMap<String, Vec<String>>,
}

impl RelationGraph {
    /// 由已解析 schema 构建关系图。仅对通过 SchemaResolver 校验的表建边
    /// (deny/missing 表不入图)。
    pub fn build(schema: &CloneSchema, tables: &[DerivedTable]) -> CloneResult<Self> {
        let mut edges = BTreeMap::new();
        let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();

        let mut included: BTreeMap<String, &DerivedTable> = BTreeMap::new();
        for t in tables {
            included.insert(t.name.clone(), t);
        }

        for table in tables {
            if let Some(parent) = &table.parent_table_name {
                // 子表父引用必须落在已解析表集内(fail-closed:不猜未校验表)。
                if !included.contains_key(parent) {
                    return Err(CloneError::InvalidRule(format!(
                        "child table `{}` references `{parent}` which was not resolved",
                        table.name
                    )));
                }
                let kind = classify(&table.name, parent, &included);
                let payload = payload_columns(table);
                edges.insert(
                    table.name.clone(),
                    Relation {
                        child_table: table.name.clone(),
                        parent_table: parent.clone(),
                        kind,
                        via_property: table.property_path.clone(),
                        payload_columns: payload,
                    },
                );
                children
                    .entry(parent.clone())
                    .or_default()
                    .push(table.name.clone());
            }
        }

        // 环检测:DFS 三色。引擎规则父先子后,任何环都是非预期(plan §4.3 fail-closed)。
        let mut state: BTreeMap<String, u8> = BTreeMap::new();
        for table in &schema.tables {
            if edges.contains_key(&table.name) {
                visit(&table.name, &edges, &mut state)?;
            }
        }

        Ok(Self { edges, children })
    }

    /// 父先子后的导出/导入遍历序(根表在前,子表沿关系图 DFS 后序即父先)。
    pub fn topological_order(&self, schema: &CloneSchema) -> Vec<String> {
        let root = schema
            .tables
            .iter()
            .find(|t| t.kind == "root")
            .map(|t| t.name.clone());
        let mut order = Vec::new();
        let mut visited = BTreeMap::new();
        if let Some(root) = root {
            self.dfs(&root, &mut visited, &mut order);
        }
        // 孤立的非根表(无 parent 引用且未访问)按名序补齐,保证全量覆盖。
        for table in &schema.tables {
            if !visited.contains_key(&table.name) {
                self.dfs(&table.name, &mut visited, &mut order);
            }
        }
        order
    }

    /// 先序(父先于全部子表):引擎要求父行先插入、子表按 parentID 后写。
    fn dfs(&self, node: &str, visited: &mut BTreeMap<String, bool>, order: &mut Vec<String>) {
        if visited.get(node).copied().unwrap_or(false) {
            return;
        }
        visited.insert(node.to_string(), true);
        order.push(node.to_string());
        if let Some(kids) = self.children.get(node) {
            for child in kids {
                self.dfs(child, visited, order);
            }
        }
    }
}

/// DFS 三色环检测(0 未访/1 在访/2 已访)。
fn visit(
    node: &str,
    edges: &BTreeMap<String, Relation>,
    state: &mut BTreeMap<String, u8>,
) -> CloneResult<()> {
    if state.get(node) == Some(&1) {
        return Err(CloneError::CycleDetected(format!("cycle through `{node}`")));
    }
    if state.get(node) == Some(&2) {
        return Ok(());
    }
    state.insert(node.to_string(), 1);
    if let Some(rel) = edges.get(node) {
        visit(&rel.parent_table, edges, state)?;
    }
    state.insert(node.to_string(), 2);
    Ok(())
}

/// 分类:表名 `kbe_` → External;否则子表由 parentID 挂载 → EngineGenerated
/// (引擎无 DB 外键,source-evidence §5)。显式业务关系由 rules 层单独声明,
/// 此处不做字符串猜测。
fn classify(
    child: &str,
    _parent: &str,
    _included: &BTreeMap<String, &DerivedTable>,
) -> RelationKind {
    if child.starts_with("kbe_") {
        RelationKind::External
    } else {
        RelationKind::EngineGenerated
    }
}

/// 关系载荷列:子表去掉 id/parentID/sm_autoLoad 后的业务列。
fn payload_columns(table: &DerivedTable) -> Vec<String> {
    table
        .fields
        .iter()
        .filter(|f| !matches!(f.name.as_str(), "id" | "parentID" | "sm_autoLoad"))
        .map(|f| f.name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, ty: &str) -> crate::schema::DerivedField {
        crate::schema::DerivedField {
            name: name.into(),
            type_label: ty.into(),
            identifier: name == "id",
            synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
            source: crate::schema::SchemaSource::Def,
        }
    }

    fn table(name: &str, kind: &str, parent: Option<&str>) -> DerivedTable {
        let mut fields = vec![
            field("id", "bigint unsigned"),
            field("sm_autoLoad", "tinyint"),
        ];
        if parent.is_some() {
            fields.insert(1, field("parentID", "bigint unsigned"));
            fields.push(field("sm_value", "varchar"));
        }
        DerivedTable {
            name: name.into(),
            kind: kind.into(),
            parent_table_name: parent.map(str::to_string),
            property_path: Some(name.into()),
            fields,
        }
    }

    #[test]
    fn builds_parent_first_order() {
        let schema = CloneSchema::new(
            "Avatar".into(),
            vec![
                table("tbl_Avatar", "root", None),
                table("tbl_Avatar_items", "array", Some("tbl_Avatar")),
                table("tbl_Avatar_items_mods", "array", Some("tbl_Avatar_items")),
            ],
        )
        .unwrap();
        let graph = RelationGraph::build(&schema, &schema.tables).unwrap();
        let order = graph.topological_order(&schema);
        assert_eq!(
            order,
            vec!["tbl_Avatar", "tbl_Avatar_items", "tbl_Avatar_items_mods"]
        );
        assert_eq!(
            graph.edges["tbl_Avatar_items"].kind,
            RelationKind::EngineGenerated
        );
        assert_eq!(
            graph.edges["tbl_Avatar_items"].payload_columns,
            vec!["sm_value"]
        );
    }

    #[test]
    fn rejects_cycle() {
        // a↔b 互为父:CloneSchema::new 允许(父引用存在),RelationGraph 环检测须拒绝。
        let schema = CloneSchema::new(
            "Avatar".into(),
            vec![
                table("tbl_Avatar", "root", None),
                table("tbl_Avatar_a", "array", Some("tbl_Avatar_b")),
                table("tbl_Avatar_b", "array", Some("tbl_Avatar_a")),
            ],
        )
        .unwrap();
        let err = RelationGraph::build(&schema, &schema.tables).unwrap_err();
        assert!(matches!(err, CloneError::CycleDetected(_)));
    }

    #[test]
    fn fail_closed_on_unresolved_parent() {
        let schema = CloneSchema::new(
            "Avatar".into(),
            vec![
                table("tbl_Avatar", "root", None),
                table("tbl_Avatar_items", "array", Some("tbl_Avatar")),
            ],
        )
        .unwrap();
        // 只把子表纳入 resolved:其父(根)不在已解析集内 → fail-closed,不猜关系。
        let resolved = vec![schema.tables[1].clone()];
        let err = RelationGraph::build(&schema, &resolved).unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(_)));
    }

    #[test]
    fn external_kbe_table_classified() {
        let schema = CloneSchema::new(
            "Avatar".into(),
            vec![
                table("tbl_Avatar", "root", None),
                table("kbe_accountinfos", "array", Some("tbl_Avatar")),
            ],
        )
        .unwrap();
        let graph = RelationGraph::build(&schema, &schema.tables).unwrap();
        assert_eq!(graph.edges["kbe_accountinfos"].kind, RelationKind::External);
    }
}
