//! 导出计划器(plan §4.3):由已解析 schema + 关系图 + 规则生成父先子后的只读
//! SELECT 序列(根按 id,子表按 parentID),预算检查诚实截断。
//!
//! Phase 1 无执行器:plan() 产物即 dry-run 面(结构与顺序、列清单、拒绝/缺失表、
//! 预算判定),供验收 Fixture 与 Phase 2 执行器消费。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::{CloneError, CloneResult};
use crate::relations::RelationGraph;
use crate::rules::RuleSet;
use crate::schema::{CloneSchema, DeniedTable, ResolvedCloneSchema};

/// 单条计划查询:一张表的只读 SELECT 及其参数绑定形态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedQuery {
    /// 执行序(父先子后,0 起)。
    pub sequence: usize,
    pub table: String,
    /// 子表时指向父表(引擎 parentID 逻辑关系)。
    pub parent_table: Option<String>,
    /// 过滤形态:根表按 id,子表按 parentID。
    pub filter: PlanFilter,
    /// 显式列清单(投影后;结构列恒含)。
    pub columns: Vec<String>,
    /// 只读 SELECT 语句(`?` 为绑定参数)。
    pub select_sql: String,
    /// 该表估计行数(无估计时为 None)。
    pub estimated_rows: Option<u64>,
}

/// 参数绑定形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PlanFilter {
    /// `WHERE id = ?`(根表,实体主键)。
    RootId,
    /// `WHERE parentID = ?`(子表,父行 id)。
    ParentId,
}

/// 完整导出计划(可序列化为 manifest 片段)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryPlan {
    pub entity_name: String,
    pub row_budget: u64,
    /// 计划内查询(父先子后)。
    pub queries: Vec<PlannedQuery>,
    /// 被排除表(kbe_/物理独有)及原因。
    pub denied: Vec<DeniedTable>,
    /// 物理侧缺失的派生表(fail-closed 提示,非猜测)。
    pub missing: Vec<String>,
    /// 身份列(IdentityRule 声明;Phase 3 IDMapper 输入)。
    pub identity: Option<IdentityColumn>,
    /// 有估计时的总行数估计。
    pub estimated_rows_total: Option<u64>,
}

/// 身份列声明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdentityColumn {
    pub table: String,
    pub column: String,
}

/// dry-run 摘要(不执行,只回答「会做什么、多大、是否在预算内」)。
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

/// 导出计划器。
#[derive(Debug)]
pub struct ExportPlanner {
    row_budget: u64,
}

impl ExportPlanner {
    pub fn new(row_budget: u64) -> Self {
        Self { row_budget }
    }

    /// 生成计划。`estimates` 供预算预检(虚拟 Fixture/执行期 COUNT 均可);
    /// 给出估计且超预算 → [`CloneError::BudgetExceeded`](crate::CloneError::BudgetExceeded)(诚实拒绝,不静默截断)。
    pub fn plan(
        &self,
        schema: &CloneSchema,
        resolved: &ResolvedCloneSchema,
        rules: &RuleSet,
        estimates: Option<&BTreeMap<String, u64>>,
    ) -> CloneResult<QueryPlan> {
        rules.validate(schema)?;

        // 关系图只对已解析表建边(拒绝/缺失表不入计划)。
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

    /// dry-run 摘要(内部走同一 plan 路径,保证摘要与计划一致)。
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

/// 渲染只读 SELECT:显式反引号列 + `?` 绑定参数。仅生成 SELECT(白名单语句面)。
fn render_select(table: &str, columns: &[String], filter: PlanFilter) -> String {
    let quoted: Vec<String> = columns.iter().map(|c| format!("`{c}`")).collect();
    let predicate = match filter {
        PlanFilter::RootId => "`id` = ?",
        PlanFilter::ParentId => "`parentID` = ?",
    };
    format!("SELECT {} FROM `{table}` WHERE {predicate}", quoted.join(", "))
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
        let phys = physical(&[
            "tbl_Avatar",
            "tbl_Avatar_items",
            "tbl_Avatar_items_mods",
        ]);
        let resolved = SchemaResolver::resolve(&schema, &phys).unwrap();
        (schema, resolved)
    }

    #[test]
    fn plan_orders_parent_first_and_binds_parent_id() {
        let (schema, resolved) = resolved();
        let planner = ExportPlanner::new(1000);
        let plan = planner.plan(&schema, &resolved, &RuleSet::default(), None).unwrap();
        let tables: Vec<&str> = plan.queries.iter().map(|q| q.table.as_str()).collect();
        assert_eq!(
            tables,
            vec!["tbl_Avatar", "tbl_Avatar_items", "tbl_Avatar_items_mods"]
        );
        assert_eq!(plan.queries[0].filter, PlanFilter::RootId);
        assert_eq!(plan.queries[1].filter, PlanFilter::ParentId);
        assert_eq!(plan.queries[1].parent_table.as_deref(), Some("tbl_Avatar"));
        assert_eq!(plan.queries[2].parent_table.as_deref(), Some("tbl_Avatar_items"));
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
        // 物理侧缺 ghost 表;kbe_ 表物理存在但派生侧无 → denied。
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
        let plan = planner.plan(&schema, &resolved, &RuleSet::default(), None).unwrap();
        assert_eq!(plan.missing, vec!["tbl_Avatar_ghost".to_string()]);
        assert!(plan.denied.iter().any(|d| d.name == "kbe_entitylog"));
        // 缺失表不入查询序列。
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
        let items = plan.queries.iter().find(|q| q.table == "tbl_Avatar_items").unwrap();
        assert_eq!(items.columns, vec!["id", "parentID", "sm_autoLoad", "sm_value"]);
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
}
