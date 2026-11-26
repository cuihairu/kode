//! Export planner (plan §4.3): from the resolved schema + relation graph + rules, generates a parent-before-child read-only
//! SELECT sequence (roots by id, child tables by parentID) with honest budget truncation.
//!
//! Phase 1 has no executor: the plan() output is the dry-run face (structure and ordering, column list, denied/missing tables,
//! budget verdicts), for acceptance fixtures and the Phase 2 executor to consume.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::{CloneError, CloneResult};
use crate::relations::RelationGraph;
use crate::rules::RuleSet;
use crate::schema::{CloneSchema, DeniedTable, ResolvedCloneSchema};

/// A single planned query: one table's read-only SELECT and its parameter binding form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct PlannedQuery {
    /// Execution order (parent before child, 0-based).
    pub sequence: usize,
    pub table: String,
    /// For child tables, points at the parent table (the engine's parentID logical relation).
    pub parent_table: Option<String>,
    /// Filter form: root tables by id, child tables by parentID.
    pub filter: PlanFilter,
    /// Explicit column list (after projection; structural columns always included).
    pub columns: Vec<String>,
    /// Derived column types in one-to-one correspondence with the column order (the basis for PDC-0203's typed row encoding).
    pub column_types: Vec<String>,
    /// Read-only SELECT statement (`?` is a bound parameter).
    pub select_sql: String,
    /// Estimated row count for this table (None when there is no estimate).
    pub estimated_rows: Option<u64>,
}

/// Parameter binding form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PlanFilter {
    /// `WHERE id = ?` (root table, entity primary key).
    RootId,
    /// `WHERE parentID = ?` (child table, parent row id).
    ParentId,
}

/// Complete export plan (serializable as a manifest fragment).
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct QueryPlan {
    pub entity_name: String,
    pub row_budget: u64,
    /// Queries within the plan (parent before child).
    pub queries: Vec<PlannedQuery>,
    /// Excluded tables (kbe_/physically-only) and reasons.
    pub denied: Vec<DeniedTable>,
    /// Derived tables missing on the physical side (fail-closed notice, not a guess).
    pub missing: Vec<String>,
    /// Identity column (declared by IdentityRule; input for the Phase 3 IDMapper).
    pub identity: Option<IdentityColumn>,
    /// Total row estimate, when estimates are available.
    pub estimated_rows_total: Option<u64>,
}

/// Identity column declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct IdentityColumn {
    pub table: String,
    pub column: String,
}

/// Dry-run summary (executes nothing; answers "what will happen, how big, is it within budget").
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DryRun {
    pub entity_name: String,
    pub query_count: usize,
    pub tables: Vec<String>,
    pub row_budget: u64,
    pub estimated_rows_total: Option<u64>,
    pub within_budget: bool,
    pub denied: Vec<DeniedTable>,
    pub missing: Vec<String>,
}

/// Export planner.
#[derive(Debug)]
pub struct ExportPlanner {
    row_budget: u64,
}

impl ExportPlanner {
    pub fn new(row_budget: u64) -> Self {
        Self { row_budget }
    }

    /// Generates the plan. `estimates` feed the budget preflight (virtual fixtures / runtime COUNT both work);
    /// given an estimate that exceeds the budget → [`CloneError::BudgetExceeded`](crate::CloneError::BudgetExceeded) (honest refusal, no silent truncation).
    pub fn plan(
        &self,
        schema: &CloneSchema,
        resolved: &ResolvedCloneSchema,
        rules: &RuleSet,
        estimates: Option<&BTreeMap<String, u64>>,
    ) -> CloneResult<QueryPlan> {
        rules.validate(schema)?;

        // The relation graph builds edges only for resolved tables (denied/missing tables stay out of the plan).
        let graph = RelationGraph::build(schema, &resolved.tables)?;
        let order = graph.topological_order(schema);
        let resolved_names: BTreeMap<&str, usize> = resolved
            .tables
            .iter()
            .map(|t| (t.name.as_str(), 0))
            .collect();

        let identity = rules
            .identity_column(
                &schema
                    .tables
                    .iter()
                    .find(|t| t.kind == "root")
                    .map(|t| t.name.clone())
                    .unwrap_or_default(),
            )
            .map(|column| IdentityColumn {
                table: schema
                    .tables
                    .iter()
                    .find(|t| t.kind == "root")
                    .map(|t| t.name.clone())
                    .unwrap_or_default(),
                column: column.to_string(),
            });

        let mut queries = Vec::new();
        let mut estimated_total: u64 = 0;
        let mut has_estimate = false;
        for (seq, name) in order.iter().enumerate() {
            if !resolved_names.contains_key(name.as_str()) {
                continue;
            }
            let table = &schema.table_index[name];
            let projected = rules.project(table);
            let edge = graph.edges.get(name);
            let filter = if edge.is_some() {
                PlanFilter::ParentId
            } else {
                PlanFilter::RootId
            };
            let columns: Vec<String> = projected.fields.iter().map(|f| f.name.clone()).collect();
            let column_types: Vec<String> = projected
                .fields
                .iter()
                .map(|f| f.type_label.clone())
                .collect();
            let select_sql = render_select(name, &columns, filter);
            let estimated_rows = estimates.and_then(|m| m.get(name).copied());
            if let Some(rows) = estimated_rows {
                has_estimate = true;
                estimated_total = estimated_total.saturating_add(rows);
            }
            queries.push(PlannedQuery {
                sequence: seq,
                table: name.clone(),
                parent_table: edge.map(|e| e.parent_table.clone()),
                filter,
                columns,
                column_types,
                select_sql,
                estimated_rows,
            });
        }

        if has_estimate && estimated_total > self.row_budget {
            return Err(CloneError::BudgetExceeded {
                limit: self.row_budget,
                requested: estimated_total,
            });
        }

        Ok(QueryPlan {
            entity_name: schema.entity_name.clone(),
            row_budget: self.row_budget,
            queries,
            denied: resolved.denied.clone(),
            missing: resolved.missing.clone(),
            identity,
            estimated_rows_total: if has_estimate {
                Some(estimated_total)
            } else {
                None
            },
        })
    }

    /// Dry-run summary (internally takes the same plan path, guaranteeing the summary matches the plan).
    pub fn dry_run(
        &self,
        schema: &CloneSchema,
        resolved: &ResolvedCloneSchema,
        rules: &RuleSet,
        estimates: Option<&BTreeMap<String, u64>>,
    ) -> CloneResult<DryRun> {
        let plan = self.plan(schema, resolved, rules, estimates)?;
        let within_budget = plan
            .estimated_rows_total
            .map(|total| total <= plan.row_budget)
            .unwrap_or(true);
        Ok(DryRun {
            entity_name: plan.entity_name,
            query_count: plan.queries.len(),
            tables: plan.queries.iter().map(|q| q.table.clone()).collect(),
            row_budget: plan.row_budget,
            estimated_rows_total: plan.estimated_rows_total,
            within_budget,
            denied: plan.denied,
            missing: plan.missing,
        })
    }
}

/// Identifier quoting (backtick escaping): table/column names come from the derived schema, but identifiers containing
/// backticks still need escaping, otherwise a malformed/injectable SELECT is generated (same policy as information_schema).
fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// Renders a read-only SELECT: explicit backtick columns + `?` bound parameters. Generates only SELECT (the allowlisted statement face).
fn render_select(table: &str, columns: &[String], filter: PlanFilter) -> String {
    let quoted: Vec<String> = columns.iter().map(|c| quote_ident(c)).collect();
    let predicate = match filter {
        PlanFilter::RootId => "`id` = ?",
        PlanFilter::ParentId => "`parentID` = ?",
    };
    format!(
        "SELECT {} FROM {} WHERE {predicate}",
        quoted.join(", "),
        quote_ident(table)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{
        DerivedField, DerivedTable, PhysicalTable, SchemaResolver, SchemaSource, VirtualSchema,
    };

    fn field(name: &str, ty: &str) -> DerivedField {
        DerivedField {
            name: name.into(),
            type_label: ty.into(),
            identifier: name == "id",
            synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
            source: SchemaSource::Def,
        }
    }

    fn root() -> DerivedTable {
        DerivedTable {
            name: "tbl_Avatar".into(),
            kind: "root".into(),
            parent_table_name: None,
            property_path: None,
            fields: vec![
                field("id", "bigint unsigned"),
                field("sm_autoLoad", "tinyint"),
                field("sm_name", "varchar"),
            ],
        }
    }

    fn child(name: &str, parent: &str) -> DerivedTable {
        DerivedTable {
            name: name.into(),
            kind: "array".into(),
            parent_table_name: Some(parent.into()),
            property_path: Some(name.into()),
            fields: vec![
                field("id", "bigint unsigned"),
                field("parentID", "bigint unsigned"),
                field("sm_autoLoad", "tinyint"),
                field("sm_value", "varchar"),
            ],
        }
    }

    fn physical(tables: &[&str]) -> VirtualSchema {
        let mut schema = VirtualSchema::default();
        for name in tables {
            let mut columns = BTreeMap::from([
                ("id".to_string(), "bigint(20) unsigned".into()),
                ("sm_autoLoad".to_string(), "tinyint".into()),
            ]);
            if *name != "tbl_Avatar" {
                columns.insert("parentID".to_string(), "bigint(20) unsigned".into());
                columns.insert("sm_value".to_string(), "varchar(255)".into());
            } else {
                columns.insert("sm_name".to_string(), "varchar(255)".into());
            }
            schema.tables.insert(
                name.to_string(),
                PhysicalTable {
                    name: name.to_string(),
                    engine: "InnoDB".into(),
                    columns,
                    primary_key: vec!["id".into()],
                    indexes: vec![],
                },
            );
        }
        schema
    }

    fn resolved() -> (CloneSchema, ResolvedCloneSchema) {
        let schema = CloneSchema::new(
            "Avatar".into(),
            vec![
                root(),
                child("tbl_Avatar_items", "tbl_Avatar"),
                child("tbl_Avatar_items_mods", "tbl_Avatar_items"),
            ],
        )
        .unwrap();
        let phys = physical(&["tbl_Avatar", "tbl_Avatar_items", "tbl_Avatar_items_mods"]);
        let resolved = SchemaResolver::resolve(&schema, &phys).unwrap();
        (schema, resolved)
    }

    #[test]
    fn plan_orders_parent_first_and_binds_parent_id() {
        let (schema, resolved) = resolved();
        let planner = ExportPlanner::new(1000);
        let plan = planner
            .plan(&schema, &resolved, &RuleSet::default(), None)
            .unwrap();
        let tables: Vec<&str> = plan.queries.iter().map(|q| q.table.as_str()).collect();
        assert_eq!(
            tables,
            vec!["tbl_Avatar", "tbl_Avatar_items", "tbl_Avatar_items_mods"]
        );
        assert_eq!(plan.queries[0].filter, PlanFilter::RootId);
        assert_eq!(plan.queries[1].filter, PlanFilter::ParentId);
        assert_eq!(plan.queries[1].parent_table.as_deref(), Some("tbl_Avatar"));
        assert_eq!(
            plan.queries[2].parent_table.as_deref(),
            Some("tbl_Avatar_items")
        );
        assert_eq!(
            plan.queries[0].select_sql,
            "SELECT `id`, `sm_autoLoad`, `sm_name` FROM `tbl_Avatar` WHERE `id` = ?"
        );
        assert_eq!(
            plan.queries[1].select_sql,
            "SELECT `id`, `parentID`, `sm_autoLoad`, `sm_value` FROM `tbl_Avatar_items` WHERE `parentID` = ?"
        );
    }

    #[test]
    fn budget_exceeded_is_honest_error() {
        let (schema, resolved) = resolved();
        let planner = ExportPlanner::new(10);
        let estimates = BTreeMap::from([
            ("tbl_Avatar".to_string(), 1u64),
            ("tbl_Avatar_items".to_string(), 20u64),
            ("tbl_Avatar_items_mods".to_string(), 50u64),
        ]);
        let err = planner
            .plan(&schema, &resolved, &RuleSet::default(), Some(&estimates))
            .unwrap_err();
        assert!(matches!(
            err,
            CloneError::BudgetExceeded {
                limit: 10,
                requested: 71
            }
        ));
    }

    #[test]
    fn dry_run_summarizes_and_within_budget() {
        let (schema, resolved) = resolved();
        let planner = ExportPlanner::new(1000);
        let estimates = BTreeMap::from([
            ("tbl_Avatar".to_string(), 1u64),
            ("tbl_Avatar_items".to_string(), 5u64),
            ("tbl_Avatar_items_mods".to_string(), 10u64),
        ]);
        let dry = planner
            .dry_run(&schema, &resolved, &RuleSet::default(), Some(&estimates))
            .unwrap();
        assert_eq!(dry.query_count, 3);
        assert_eq!(dry.estimated_rows_total, Some(16));
        assert!(dry.within_budget);
    }

    #[test]
    fn denied_and_missing_surface_in_plan() {
        let schema = CloneSchema::new(
            "Avatar".into(),
            vec![root(), child("tbl_Avatar_ghost", "tbl_Avatar")],
        )
        .unwrap();
        // The ghost table is missing on the physical side; the kbe_ table exists physically but not on the derived side → denied.
        let mut phys = physical(&["tbl_Avatar"]);
        phys.tables.insert(
            "kbe_entitylog".into(),
            PhysicalTable {
                name: "kbe_entitylog".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::new(),
                primary_key: vec![],
                indexes: vec![],
            },
        );
        let resolved = SchemaResolver::resolve(&schema, &phys).unwrap();
        let planner = ExportPlanner::new(1000);
        let plan = planner
            .plan(&schema, &resolved, &RuleSet::default(), None)
            .unwrap();
        assert_eq!(plan.missing, vec!["tbl_Avatar_ghost".to_string()]);
        assert!(plan.denied.iter().any(|d| d.name == "kbe_entitylog"));
        // Missing tables stay out of the query sequence.
        assert_eq!(plan.queries.len(), 1);
    }

    #[test]
    fn projection_applied_but_structural_columns_kept() {
        let (schema, resolved) = resolved();
        let rules = RuleSet {
            projections: vec![crate::rules::ProjectRule {
                table: "tbl_Avatar_items".into(),
                include_columns: Some(vec!["sm_value".into()]),
                exclude_columns: vec![],
            }],
            ..Default::default()
        };
        let planner = ExportPlanner::new(1000);
        let plan = planner.plan(&schema, &resolved, &rules, None).unwrap();
        let items = plan
            .queries
            .iter()
            .find(|q| q.table == "tbl_Avatar_items")
            .unwrap();
        assert_eq!(
            items.columns,
            vec!["id", "parentID", "sm_autoLoad", "sm_value"]
        );
    }

    #[test]
    fn identity_rule_carried_into_plan() {
        let (schema, resolved) = resolved();
        let rules = RuleSet {
            identities: vec![crate::rules::IdentityRule {
                entity: "Avatar".into(),
                table: "tbl_Avatar".into(),
                column: "sm_name".into(),
            }],
            ..Default::default()
        };
        let planner = ExportPlanner::new(1000);
        let plan = planner.plan(&schema, &resolved, &rules, None).unwrap();
        assert_eq!(
            plan.identity,
            Some(IdentityColumn {
                table: "tbl_Avatar".into(),
                column: "sm_name".into()
            })
        );
    }
    #[test]
    fn render_select_escapes_backticks_in_identifiers() {
        // Table/column names containing backticks: escaped as ````, otherwise a malformed/injectable SELECT is generated.
        let sql = render_select(
            "tbl`Avatar",
            &["id".into(), "weird`col".into()],
            PlanFilter::RootId,
        );
        assert!(
            sql.contains("FROM `tbl``Avatar`"),
            "table name backtick escaped: {sql}"
        );
        assert!(
            sql.contains("`weird``col`"),
            "column name backtick escaped: {sql}"
        );
        assert!(sql.contains("WHERE `id` = ?"), "predicate unchanged: {sql}");
        let parent = render_select("tbl_Bag", &["parentID".into()], PlanFilter::ParentId);
        assert!(
            parent.contains("WHERE `parentID` = ?"),
            "child-table predicate unchanged: {parent}"
        );
    }
}
