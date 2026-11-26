//! Relation classification (plan §4.2): engine-certain (ARRAY/component child
//! tables + parentID), real FKs, explicit business declarations, unresolved (IDs
//! embedded in pickles), external (kbe_ tables).
//!
//! Engine facts (source-evidence §4/§5): the child table's `parentID` is a purely
//! logical column with no database foreign key; the parent row is inserted first,
//! `LAST_INSERT_ID` is taken, then the child table is written keyed by `parentID`.
//! The relation graph takes the derived schema's table structure as input.

use std::collections::BTreeMap;

use crate::error::{CloneError, CloneResult};
use crate::schema::{CloneSchema, DerivedTable};

/// Relation kinds (plan §4.2 A–E, naming aligned with the plan doc PDC-0104).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RelationKind {
    /// Engine generated (§4.2-A): ARRAY/component child tables + parentID column
    /// (no DB foreign key, purely logical).
    EngineGenerated,
    /// Real database foreign key (§4.2-B; currently empty in the engine,
    /// reserved).
    ForeignKey,
    /// Project explicit declaration (§4.2-C: Account.characters, guildDBID etc.,
    /// declared by the user).
    ProjectDeclared,
    /// Unresolved (§4.2-D: IDs embedded in pickle blobs, untouched).
    Unresolved,
    /// External (§4.2-E: kbe_ internal tables, excluded).
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

/// One relation: a child table attached to a parent via parentID (or an explicit
/// declaration).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Relation {
    pub child_table: String,
    pub parent_table: String,
    pub kind: RelationKind,
    /// Source property path of the relation (the child table's property_path).
    pub via_property: Option<String>,
    /// Payload columns carried by the relation (sm_value for ARRAY etc.; FK /
    /// business ones come from declarations).
    pub payload_columns: Vec<String>,
}

/// Relation graph: built from the derived schema, provides traversal order
/// (parents before children) and cycle detection.
#[derive(Debug, Clone, Default)]
pub struct RelationGraph {
    /// child table → relation.
    pub edges: BTreeMap<String, Relation>,
    /// table → direct children (parents-first order).
    pub children: BTreeMap<String, Vec<String>>,
}

impl RelationGraph {
    /// Builds the relation graph from a resolved schema. Edges are created only
    /// for tables that passed SchemaResolver validation (deny/missing tables do
    /// not enter the graph).
    pub fn build(schema: &CloneSchema, tables: &[DerivedTable]) -> CloneResult<Self> {
        let mut edges = BTreeMap::new();
        let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();

        let mut included: BTreeMap<String, &DerivedTable> = BTreeMap::new();
        for t in tables {
            included.insert(t.name.clone(), t);
        }

        for table in tables {
            if let Some(parent) = &table.parent_table_name {
                // The child table's parent reference must land inside the resolved
                // table set (fail-closed: no guessing about unvalidated tables).
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

        // Cycle detection: three-color DFS. Engine rules are parents-before-children;
        // any cycle is unexpected (plan §4.3 fail-closed).
        let mut state: BTreeMap<String, u8> = BTreeMap::new();
        for table in &schema.tables {
            if edges.contains_key(&table.name) {
                visit(&table.name, &edges, &mut state)?;
            }
        }

        Ok(Self { edges, children })
    }

    /// Export/import traversal order, parents before children (root table first;
    /// child tables follow the relation graph's DFS order, i.e. parents first).
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
        // Orphan non-root tables (no parent reference and not yet visited) are
        // appended in name order to guarantee full coverage.
        for table in &schema.tables {
            if !visited.contains_key(&table.name) {
                self.dfs(&table.name, &mut visited, &mut order);
            }
        }
        order
    }

    /// Pre-order (parents before all their children): the engine requires parent
    /// rows to be inserted first, child tables written later keyed by parentID.
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

/// Three-color DFS cycle detection (0 unvisited / 1 in-progress / 2 done).
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

/// Classification: table name starting with `kbe_` → External; otherwise the
/// child table is attached via parentID → EngineGenerated (the engine has no DB
/// foreign keys, source-evidence §5). Explicit business relations are declared
/// separately by the rules layer; no string guessing here.
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

/// Relation payload columns: the child table's business columns with
/// id/parentID/sm_autoLoad removed.
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
        // a↔b are each other's parents: CloneSchema::new allows it (the parent
        // references exist), RelationGraph cycle detection must reject it.
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
        // Only the child table is included in resolved: its parent (the root) is
        // not in the resolved set → fail closed, no guessed relation.
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
