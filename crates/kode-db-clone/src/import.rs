//! 导入计划器(plan §6.2 Prepare / PDC-0302..0308):加载归档 → 目标 schema 对账 →
//! 关系 DAG 排序 → 类型化 IDMap → 唯一键预演 → 输出完全可审计的参数化 INSERT 计划。
//!
//! 计划期**不触库**:目标现场以 [`TargetSnapshot`](虚拟 Fixture 或 information_schema
//! 读取器填充)提供,真实连接属 Apply 期(Phase 4)。语句一律 `?` 占位,
//! 不内嵌原始敏感值(§6.2)。
//!
//! 三条铁律的本模块落点:
//! - 未知引用不默认全局替换(§9 Phase 3 验收门):未被声明跟随的引用列原值直通,
//!   映射表里没有的键查不到就保持原样,绝不按列名猜测。
//! - 账号绑定无规则时不得宣称登录可用(PDC-0306):[`AccountBindingPlan::login_ready`]
//!   仅在声明规则存在时为真,否则 note 明确「本地账号看不到该角色」。
//! - 目标 schema 与归档行漂移 fail-closed(PDC-0302):表缺/列数不符/类型不符即拒。

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::archive::Archive;
use crate::error::{CloneError, CloneResult};
use crate::idmap::{IdCategory, IdMap, IdMapKey, ImportMode, MappedId};
use crate::relations::RelationGraph;
use crate::rules::{RelationRuleAction, RuleSet};
use crate::schema::{CloneSchema, ResolvedCloneSchema};
use crate::target::TargetProfile;
use crate::value::TypedValue;

/// 目标唯一键(调用方按目标物理索引/业务声明提供;crate 不假装读取索引)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UniqueKey {
    pub table: String,
    pub column: String,
}

/// 目标现场快照(计划期预演输入):唯一键既有值 + 既有主键值。
#[derive(Debug, Clone, Default)]
pub struct TargetSnapshot {
    /// 需要预演的唯一键清单。
    pub unique_keys: Vec<UniqueKey>,
    /// (表,列) → 目标已有值(规范键形态;导入预演只比对相等性,不重现原值)。
    pub existing_values: BTreeMap<(String, String), BTreeSet<String>>,
}

impl TargetSnapshot {
    /// 登记一个目标既有值(预演探测面)。
    pub fn add_existing(&mut self, table: &str, column: &str, value: TypedValue) {
        self.existing_values
            .entry((table.to_string(), column.to_string()))
            .or_default()
            .insert(crate::idmap::value_key(&value));
    }

    pub fn contains(&self, table: &str, column: &str, value: &TypedValue) -> bool {
        self.existing_values
            .get(&(table.to_string(), column.to_string()))
            .is_some_and(|set| set.contains(&crate::idmap::value_key(value)))
    }
}

/// 唯一键冲突策略(PDC-0305)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UniquePolicy {
    /// 冲突即拒绝计划(fail-closed)。
    Reject,
    /// 本地重建:`{原值}_{seed}{n}` 递增到目标与归档内均唯一。
    RebuildSuffix { seed: String },
}

/// `sm_autoLoad` 策略(PDC-0308)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoLoadPolicy {
    /// 保留归档原值。
    PreserveArchive,
    /// 显式禁用(§6.2 Apply「禁用线上 autoLoad」的默认建议)。
    ForceDisabled,
}

/// 导入选项。
#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub mode: ImportMode,
    pub autoload: AutoLoadPolicy,
    pub unique: UniquePolicy,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            // §6.1:默认建议新 ID 模式,降低碰撞风险。
            mode: ImportMode::AllocateNewIds,
            autoload: AutoLoadPolicy::ForceDisabled,
            unique: UniquePolicy::RebuildSuffix {
                seed: "imported".into(),
            },
        }
    }
}

/// 单元格渲染去向(审计面:语句里每个 `?` 绑定什么)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PlannedCell {
    /// 归档原值直通(参数绑定)。
    Literal,
    /// 新主键占位(Apply 期数据库返回后回填映射)。
    NewKey { placeholder: u64 },
    /// parentID/业务引用 → 指向同克隆集内另一行的键(与该行 NewKey 同占位)。
    KeyReference { placeholder: u64 },
    /// 策略覆写(sm_autoLoad 等;绑定策略值而非归档值)。
    PolicyOverride,
    /// 映射重写(唯一键本地重建/业务引用重映射)。
    Remapped,
}

/// 一条计划 INSERT(全列参数化)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedInsert {
    pub sequence: usize,
    pub table: String,
    pub row_index: usize,
    pub columns: Vec<String>,
    /// 与列序一一对应的绑定去向。
    pub cells: Vec<PlannedCell>,
    pub insert_sql: String,
}

/// 已解决的唯一键冲突(审计面)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UniqueConflict {
    pub table: String,
    pub column: String,
    pub old: TypedValue,
    pub rebuilt: TypedValue,
}

/// 声明关系的导入去向(PDC-0307 审计面)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReferenceOutcome {
    /// `Entity.property` 声明路径。
    pub declaration: String,
    pub followed: bool,
    pub note: String,
}

/// 账号绑定计划(PDC-0306)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountBindingPlan {
    /// 命中的绑定声明(`Entity.property`),无则为 None。
    pub declaration: Option<String>,
    /// 无规则时恒为 false:导入的角色不会自动对任何本地账号可见。
    pub login_ready: bool,
    pub note: String,
}

/// 预演摘要(§9 Phase 3 验收门:逐表逐类别展示变更面)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportSummary {
    pub entity_name: String,
    pub mode: ImportMode,
    pub autoload_policy: AutoLoadPolicy,
    /// 表 → 计划语句数(父先子后序)。
    pub statements_per_table: BTreeMap<String, usize>,
    /// ID 类别标签 → 变更条数。
    pub id_categories: BTreeMap<String, usize>,
    pub unique_conflicts: usize,
    pub login_ready: bool,
    /// 未解决引用风险数(Skip/克隆集外/未明)。
    pub unresolved_reference_risks: usize,
}

/// 完整导入计划(可序列化审计)。
#[derive(Debug, Clone, Serialize)]
pub struct ImportPlan {
    pub entity_name: String,
    pub mode: ImportMode,
    pub autoload_policy: AutoLoadPolicy,
    /// 父先子后执行序(表名)。
    pub order: Vec<String>,
    pub statements: Vec<PlannedInsert>,
    pub idmap: IdMap,
    pub conflicts: Vec<UniqueConflict>,
    pub references: Vec<ReferenceOutcome>,
    pub account_binding: AccountBindingPlan,
    /// schema/版本对账备注(诚实面:不可比对时如实说明)。
    pub schema_notes: Vec<String>,
    /// 风险与跳过项(引用未重写、关系跳过、版本未知)。
    pub warnings: Vec<String>,
    pub summary: ImportSummary,
}

/// 导入计划器。
#[derive(Debug, Default)]
pub struct ImportPlanner;

impl ImportPlanner {
    /// 生成导入计划(Prepare 期,不触库)。
    pub fn plan(
        archive: &Archive,
        target: &TargetProfile,
        schema: &CloneSchema,
        resolved: &ResolvedCloneSchema,
        rules: &RuleSet,
        snapshot: &TargetSnapshot,
        options: &ImportOptions,
    ) -> CloneResult<ImportPlan> {
        target.validate_for_import()?;
        rules.validate(schema)?;

        let graph = RelationGraph::build(schema, &resolved.tables)?;
        let order = graph.topological_order(schema);
        let root_table = schema
            .tables
            .iter()
            .find(|t| t.kind == "root")
            .map(|t| t.name.clone())
            .unwrap_or_default();

        // ---- PDC-0302:归档表 ⊆ 目标已解析表;行宽 = 目标投影列数;类型相容 ----
        let resolved_names: BTreeMap<&str, usize> = resolved
            .tables
            .iter()
            .map(|t| (t.name.as_str(), t.fields.len()))
            .collect();
        let mut archived: BTreeMap<String, Vec<crate::value::TypedRow>> = BTreeMap::new();
        for table_meta in &archive.meta().tables {
            if !resolved_names.contains_key(table_meta.name.as_str()) {
                return Err(CloneError::UnknownTable(format!(
                    "archive table `{}` is not present in the resolved target schema",
                    table_meta.name
                )));
            }
            let rows = archive.table_rows(&table_meta.name)?;
            let projected = rules.project(&schema.table_index[&table_meta.name]);
            for row in &rows {
                // 行宽与目标投影列数一致(归档行序 = 计划查询列序,§6.2)。
                if row.values.len() != projected.fields.len() {
                    return Err(CloneError::DriftMismatch(format!(
                        "archived row of `{}` has {} values but the resolved target projects {} columns",
                        table_meta.name,
                        row.values.len(),
                        projected.fields.len()
                    )));
                }
                for (value, field) in row.values.iter().zip(projected.fields.iter()) {
                    if !type_fits(value, &field.type_label) {
                        return Err(CloneError::DriftMismatch(format!(
                            "archived value for `{}`.`{}` does not fit target column type `{}`",
                            table_meta.name, field.name, field.type_label
                        )));
                    }
                }
            }
            archived.insert(table_meta.name.clone(), rows);
        }
        // 目标已解析但归档没有的表:允许(目标可含本克隆未触及的表),不伪造行。
        let schema_notes = version_notes(target);

        // ---- 逐表逐行生成语句(父先子后;parentID 引用父行占位) ----
        let allocate = options.mode == ImportMode::AllocateNewIds;
        let mut idmap = IdMap::new();
        let mut conflicts: Vec<UniqueConflict> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut statements: Vec<PlannedInsert> = Vec::new();

        // 唯一键预演输入:目标已有值 ∪ 归档内同列其他值 ∪ 已重建值。
        let mut archive_values: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
        for (table, rows) in &archived {
            let projected = rules.project(&schema.table_index[table.as_str()]);
            for row in rows {
                for (field, value) in projected.fields.iter().zip(row.values.iter()) {
                    archive_values
                        .entry((table.clone(), field.name.clone()))
                        .or_default()
                        .insert(crate::idmap::value_key(value));
                }
            }
        }
        let unique_keys: BTreeSet<(String, String)> = snapshot
            .unique_keys
            .iter()
            .map(|k| (k.table.clone(), k.column.clone()))
            .collect();

        // 声明关系审计(PDC-0307):Follow/Skip 的导入去向 + 克隆集外引用不重写。
        let mut references: Vec<ReferenceOutcome> = Vec::new();
        for rule in &rules.relations {
            let declaration = format!("{}.{}", rule.entity, rule.property_path);
            match rules.apply_relation(&rule.entity, &rule.property_path)? {
                Some(RelationRuleAction::Follow) => {
                    let referenced_in_clone =
                        resolved_names.contains_key(rule.child_table.as_str());
                    references.push(ReferenceOutcome {
                        declaration: declaration.clone(),
                        followed: true,
                        note: if referenced_in_clone {
                            "followed; join values remap through the clone idmap".into()
                        } else {
                            format!(
                                "followed, but referenced table `{}` is outside this clone; values kept as-is",
                                rule.child_table
                            )
                        },
                    });
                }
                Some(RelationRuleAction::Skip) => {
                    references.push(ReferenceOutcome {
                        declaration,
                        followed: false,
                        note: "skipped by rule; referenced rows are not linked by this import"
                            .into(),
                    });
                }
                // Error 动作在 apply_relation 已 fail-closed(InvalidRule)。
                Some(RelationRuleAction::Error) | None => {}
            }
        }
        let unresolved_risks = references
            .iter()
            .filter(|r| !r.followed || r.note.contains("outside this clone"))
            .count();

        // Follow 且被引用表在克隆集内的规则 → (声明侧表, join 列) → 被引用表:
        // 行渲染时把该列旧值经映射账本改指向克隆集内新键(PDC-0307)。
        let mut follow_joins: BTreeMap<(String, String), String> = BTreeMap::new();
        for rule in &rules.relations {
            if rules.apply_relation(&rule.entity, &rule.property_path)?
                != Some(RelationRuleAction::Follow)
            {
                continue;
            }
            if archived.contains_key(&rule.child_table) {
                follow_joins.insert(
                    (rule.parent_table.clone(), rule.join_column.clone()),
                    rule.child_table.clone(),
                );
            }
        }

        // 账号绑定(PDC-0306):引用本克隆根表的 Follow 声明 = 绑定规则。
        let binding_rule = rules.relations.iter().find(|r| {
            r.child_table == root_table
                && rules
                    .apply_relation(&r.entity, &r.property_path)
                    .ok()
                    .flatten()
                    == Some(RelationRuleAction::Follow)
        });
        let account_binding = match binding_rule {
            Some(rule) => AccountBindingPlan {
                declaration: Some(format!("{}.{}", rule.entity, rule.property_path)),
                login_ready: true,
                note: format!(
                    "binding rule declared via {}.{}; applied at import apply time",
                    rule.entity, rule.property_path
                ),
            },
            None => AccountBindingPlan {
                declaration: None,
                login_ready: false,
                note: "no account binding rule declared; the imported entity will NOT be visible to any local account automatically".into(),
            },
        };

        // ---- 第一遍(PDC-0303/0304/0305):全量种子映射账本 ----
        // 主键分配/保留与唯一键冲突重建先行落账;渲染遍只查表。业务引用
        // 可能前向指向「后计划的表」(根表引用子表行),单遍边算边查会漏。
        for name in &order {
            let Some(rows) = archived.get(name) else {
                continue;
            };
            let projected = rules.project(&schema.table_index[name]);
            let category = if graph.edges.contains_key(name) {
                IdCategory::ChildRowKey
            } else {
                IdCategory::RootKey
            };
            for row in rows {
                for (field, value) in projected.fields.iter().zip(row.values.iter()) {
                    if field.name == "id" {
                        let key = IdMapKey {
                            table: name.clone(),
                            column: "id".into(),
                            old: value.clone(),
                        };
                        if allocate {
                            idmap.allocate(key, category);
                        } else {
                            idmap.preserve(key, category);
                        }
                        continue;
                    }
                    if unique_keys.contains(&(name.clone(), field.name.clone()))
                        && snapshot.contains(name, &field.name, value)
                    {
                        match &options.unique {
                            UniquePolicy::Reject => {
                                return Err(CloneError::ImportConflict(format!(
                                    "value for unique key `{name}`.`{}` already exists in the target",
                                    field.name
                                )));
                            }
                            UniquePolicy::RebuildSuffix { seed } => {
                                let TypedValue::Text(base) = value else {
                                    return Err(CloneError::ImportConflict(format!(
                                        "unique key `{name}`.`{}` collides but its value is not text; rebuild policy cannot apply",
                                        field.name
                                    )));
                                };
                                let column = field.name.clone();
                                let rebuilt = rebuild_unique(base, seed, |candidate| {
                                    snapshot.contains(name, &column, candidate)
                                        || archive_values
                                            .get(&(name.clone(), column.clone()))
                                            .is_some_and(|set| {
                                                set.contains(&crate::idmap::value_key(candidate))
                                            })
                                        || idmap.entries().any(|e| {
                                            matches!(&e.mapped, MappedId::Rebuilt { value } if value == candidate)
                                        })
                                });
                                idmap.rebuild(
                                    IdMapKey {
                                        table: name.clone(),
                                        column: column.clone(),
                                        old: value.clone(),
                                    },
                                    rebuilt.clone(),
                                    IdCategory::RebuiltIdentity,
                                );
                                conflicts.push(UniqueConflict {
                                    table: name.clone(),
                                    column,
                                    old: value.clone(),
                                    rebuilt,
                                });
                            }
                        }
                    }
                }
            }
        }

        // ---- 第一遍半(PDC-0304/0307):parentID 引用与声明跟随且命中的
        // 业务引用列落账(类别计数面;渲染遍只读查表)。 ----
        for name in &order {
            let Some(rows) = archived.get(name) else {
                continue;
            };
            let projected = rules.project(&schema.table_index[name]);
            for row in rows {
                for (field, value) in projected.fields.iter().zip(row.values.iter()) {
                    // parentID 引用登记(同父多行去重为一条,占位共享在语句面)。
                    if field.name == "parentID" && idmap.get(name, "parentID", value).is_none() {
                        idmap.preserve(
                            IdMapKey {
                                table: name.clone(),
                                column: "parentID".into(),
                                old: value.clone(),
                            },
                            IdCategory::ParentReference,
                        );
                    }
                    let Some(referenced) = follow_joins.get(&(name.clone(), field.name.clone()))
                    else {
                        continue;
                    };
                    if idmap.get(referenced, "id", value).is_some()
                        && idmap.get(name, &field.name, value).is_none()
                    {
                        idmap.preserve(
                            IdMapKey {
                                table: name.clone(),
                                column: field.name.clone(),
                                old: value.clone(),
                            },
                            IdCategory::BusinessReference,
                        );
                    }
                }
            }
        }

        // ---- 第二遍:渲染语句(父先子后;全列 `?` 参数化) ----
        for name in &order {
            let Some(rows) = archived.get(name) else {
                continue;
            };
            let table = &schema.table_index[name];
            let projected = rules.project(table);
            let edge = graph.edges.get(name);
            let columns: Vec<String> = projected.fields.iter().map(|f| f.name.clone()).collect();

            for (row_index, row) in rows.iter().enumerate() {
                let mut cells: Vec<PlannedCell> = Vec::with_capacity(columns.len());
                for (field, value) in projected.fields.iter().zip(row.values.iter()) {
                    let cell = plan_cell(
                        field.name.as_str(),
                        value,
                        name,
                        edge.map(|e| e.parent_table.as_str()),
                        &follow_joins,
                        options,
                        &idmap,
                        &mut warnings,
                    )?;
                    cells.push(cell);
                }
                let binds: Vec<&str> = vec!["?"; columns.len()];
                let insert_sql = format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    name,
                    columns.join(", "),
                    binds.join(", ")
                );
                statements.push(PlannedInsert {
                    sequence: statements.len(),
                    table: name.clone(),
                    row_index,
                    columns: columns.clone(),
                    cells,
                    insert_sql,
                });
            }
        }

        // ---- 摘要(验收门:逐表逐类别) ----
        let mut statements_per_table: BTreeMap<String, usize> = BTreeMap::new();
        for stmt in &statements {
            *statements_per_table.entry(stmt.table.clone()).or_insert(0) += 1;
        }
        let id_categories: BTreeMap<String, usize> = idmap
            .counts_by_category()
            .into_iter()
            .map(|(k, v)| (k.label().to_string(), v))
            .collect();
        let summary = ImportSummary {
            entity_name: schema.entity_name.clone(),
            mode: options.mode,
            autoload_policy: options.autoload,
            statements_per_table,
            id_categories,
            unique_conflicts: conflicts.len(),
            login_ready: account_binding.login_ready,
            unresolved_reference_risks: unresolved_risks,
        };

        Ok(ImportPlan {
            entity_name: schema.entity_name.clone(),
            mode: options.mode,
            autoload_policy: options.autoload,
            order,
            statements,
            idmap,
            conflicts,
            references,
            account_binding,
            schema_notes,
            warnings,
            summary,
        })
    }
}

/// 单列渲染决策(第二遍;账本已全量种子,只读查表。借用多面,保持自由函数)。
#[allow(clippy::too_many_arguments)]
fn plan_cell(
    column: &str,
    value: &TypedValue,
    table: &str,
    parent_table: Option<&str>,
    follow_joins: &BTreeMap<(String, String), String>,
    options: &ImportOptions,
    idmap: &IdMap,
    warnings: &mut Vec<String>,
) -> CloneResult<PlannedCell> {
    // 1) 主键列:Allocated → 占位新键(Apply 期数据库回填);Preserved →
    //    原值直通;Rebuilt(id 被唯一键策略重建时)→ 改写值。
    if column == "id" {
        return Ok(match idmap.get(table, column, value) {
            Some(MappedId::Allocated { placeholder }) => PlannedCell::NewKey {
                placeholder: *placeholder,
            },
            Some(MappedId::Rebuilt { .. }) => PlannedCell::Remapped,
            _ => PlannedCell::Literal,
        });
    }

    // 2) parentID:与父行 id 同一占位/同一改写(preserve 模式原值直通)。
    if column == "parentID" {
        let parent = parent_table.ok_or_else(|| {
            CloneError::InvalidRule(format!(
                "table `{table}` has a parentID value but no relation edge"
            ))
        })?;
        return Ok(match idmap.get(parent, "id", value) {
            Some(MappedId::Allocated { placeholder }) => PlannedCell::KeyReference {
                placeholder: *placeholder,
            },
            Some(MappedId::Rebuilt { .. }) => PlannedCell::Remapped,
            Some(MappedId::Preserved) => PlannedCell::Literal,
            // 种子遍已登记全部主键:查不到 = 引用了未克隆的父行,fail-closed。
            None => {
                return Err(CloneError::DriftMismatch(format!(
                    "parent row id {value:?} of table `{parent}` is not part of this clone"
                )));
            }
        });
    }

    // 3) sm_autoLoad:策略覆写(PDC-0308)。
    if column == "sm_autoLoad" {
        return Ok(match options.autoload {
            AutoLoadPolicy::PreserveArchive => PlannedCell::Literal,
            AutoLoadPolicy::ForceDisabled => PlannedCell::PolicyOverride,
        });
    }

    // 4) 唯一键列:账本 Rebuilt → 改写值;未冲突的照常直通
    //    (拒绝策略已在种子遍 fail-closed,PDC-0305)。
    if let Some(MappedId::Rebuilt { .. }) = idmap.get(table, column, value) {
        return Ok(PlannedCell::Remapped);
    }

    // 5) 声明跟随的业务引用列(PDC-0307):改指克隆集内新键;账本查不到的
    //    旧值保持原样并告警——未知引用不默认全局替换。
    if let Some(referenced) = follow_joins.get(&(table.to_string(), column.to_string())) {
        return Ok(match idmap.get(referenced, "id", value) {
            Some(MappedId::Allocated { placeholder }) => PlannedCell::KeyReference {
                placeholder: *placeholder,
            },
            Some(MappedId::Rebuilt { .. }) => PlannedCell::Remapped,
            _ => {
                warnings.push(format!(
                    "business reference `{table}`.`{column}` value is not among the cloned `{referenced}` rows; kept as-is"
                ));
                PlannedCell::Literal
            }
        });
    }

    // 6) 其余列:未被声明重写的引用一律原值直通。
    Ok(PlannedCell::Literal)
}

/// `{base}_{seed}{n}`(n 从 1)递增到 probe 为假;上限 10_000 防死循环。
fn rebuild_unique(
    base: &str,
    seed: &str,
    mut occupied: impl FnMut(&TypedValue) -> bool,
) -> TypedValue {
    for n in 1..=10_000u32 {
        let candidate = TypedValue::Text(format!("{base}_{seed}{n}"));
        if !occupied(&candidate) {
            return candidate;
        }
    }
    // 不可达的诚实兜底:探测上限内全被占。
    TypedValue::Text(format!("{base}_{seed}_exhausted"))
}

/// 版本对账备注(PDC-0302 诚实面:归档未记录源引擎版本)。
fn version_notes(target: &TargetProfile) -> Vec<String> {
    let mut notes = Vec::new();
    notes.push(
        "archive format does not record the source engine version; target comparison is by table/column/type only"
            .to_string(),
    );
    match &target.engine_version {
        Some(v) => notes.push(format!("target engine version declared as {v}")),
        None => notes.push(
            "target engine version unknown; version compatibility could not be checked".to_string(),
        ),
    }
    notes
}

/// 归档值与目标列类型相容性(PDC-0302;忽略显示宽度/字符集,同 schema.rs 口径)。
fn type_fits(value: &TypedValue, column_type: &str) -> bool {
    let ty = column_type.trim().to_ascii_lowercase();
    // 取括号前的首个类型词(剥显示宽度与 unsigned/zerofill 后缀词,
    // 同 schema.rs 归一化口径:`bigint(20) unsigned` → `bigint`)。
    let base = ty
        .split('(')
        .next()
        .unwrap_or(ty.as_str())
        .split_whitespace()
        .next()
        .unwrap_or("");
    match value {
        TypedValue::Null => true,
        TypedValue::Int(_) | TypedValue::UInt(_) | TypedValue::BigUInt(_) => {
            matches!(
                base,
                "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint"
            )
        }
        TypedValue::Float(_) => base == "float",
        TypedValue::Double(_) => base == "double",
        TypedValue::Decimal(_) => base == "decimal" || base == "numeric",
        TypedValue::Bytes(_) => matches!(
            base,
            "blob" | "binary" | "varbinary" | "tinyblob" | "mediumblob" | "longblob"
        ),
        TypedValue::Text(_) => matches!(
            base,
            "varchar" | "char" | "text" | "tinytext" | "mediumtext" | "longtext"
        ),
        TypedValue::DateTime { .. } => {
            matches!(base, "datetime" | "timestamp" | "date" | "time" | "year")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::ArchiveWriter;
    use crate::reader::RowSink;
    use crate::schema::{DerivedField, DerivedTable, SchemaResolver, SchemaSource, VirtualSchema};
    use crate::target::TargetEnvironment;
    use std::collections::BTreeMap;

    fn field(name: &str, ty: &str) -> DerivedField {
        DerivedField {
            name: name.into(),
            type_label: ty.into(),
            identifier: name == "id",
            synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
            source: SchemaSource::Def,
        }
    }

    fn mini_schema() -> CloneSchema {
        let root = DerivedTable {
            name: "tbl_Avatar".into(),
            kind: "root".into(),
            parent_table_name: None,
            property_path: None,
            fields: vec![
                field("id", "bigint unsigned"),
                field("sm_autoLoad", "tinyint"),
                field("sm_name", "varchar"),
                // 业务引用列样例(声明 Avatar.petRef → tbl_Avatar_items,PDC-0307)。
                field("sm_petID", "bigint unsigned"),
            ],
        };
        let items = DerivedTable {
            name: "tbl_Avatar_items".into(),
            kind: "array".into(),
            parent_table_name: Some("tbl_Avatar".into()),
            property_path: Some("items".into()),
            fields: vec![
                field("id", "bigint unsigned"),
                field("parentID", "bigint unsigned"),
                field("sm_value", "varchar"),
            ],
        };
        CloneSchema::new("Avatar".into(), vec![root, items]).unwrap()
    }

    fn mini_physical() -> VirtualSchema {
        VirtualSchema::new(vec![
            crate::schema::PhysicalTable {
                name: "tbl_Avatar".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::from([
                    ("id".into(), "bigint(20) unsigned".into()),
                    ("sm_autoLoad".into(), "tinyint".into()),
                    ("sm_name".into(), "varchar(255)".into()),
                    ("sm_petID".into(), "bigint(20) unsigned".into()),
                ]),
                primary_key: vec!["id".into()],
                indexes: vec![],
            },
            crate::schema::PhysicalTable {
                name: "tbl_Avatar_items".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::from([
                    ("id".into(), "bigint(20) unsigned".into()),
                    ("parentID".into(), "bigint(20) unsigned".into()),
                    ("sm_value".into(), "varchar(255)".into()),
                ]),
                primary_key: vec!["id".into()],
                indexes: vec![],
            },
        ])
    }

    fn mini_target() -> TargetProfile {
        TargetProfile {
            environment: TargetEnvironment::Local,
            db_interface: "mysql".into(),
            writable: true,
            host: "127.0.0.1".into(),
            port: 3306,
            database: "kbe_local".into(),
            engine_version: Some("0.2.0".into()),
        }
    }

    /// 写一个最小归档:根行(id=7, autoLoad=1, name=hero, petID=pet)+ 两行 items(parentID=7)。
    fn mini_archive(dir: &std::path::Path) -> std::path::PathBuf {
        mini_archive_pet(dir, 100)
    }

    fn mini_archive_pet(dir: &std::path::Path, pet: u64) -> std::path::PathBuf {
        let path = dir.join("mini.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        writer
            .write_row(
                "tbl_Avatar",
                &crate::value::TypedRow {
                    table: "tbl_Avatar".into(),
                    values: vec![
                        TypedValue::BigUInt(7),
                        TypedValue::UInt(1),
                        TypedValue::Text("hero".into()),
                        TypedValue::BigUInt(pet),
                    ],
                },
            )
            .unwrap();
        writer.end_table("tbl_Avatar", 1).unwrap();
        for (id, val) in [(100u64, "sword"), (101, "shield")] {
            writer
                .write_row(
                    "tbl_Avatar_items",
                    &crate::value::TypedRow {
                        table: "tbl_Avatar_items".into(),
                        values: vec![
                            TypedValue::BigUInt(id),
                            TypedValue::BigUInt(7),
                            TypedValue::Text(val.into()),
                        ],
                    },
                )
                .unwrap();
        }
        writer.end_table("tbl_Avatar_items", 2).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        path
    }

    fn plan_fixture(
        dir: &std::path::Path,
        options: &ImportOptions,
        snapshot: &TargetSnapshot,
        rules: &RuleSet,
    ) -> ImportPlan {
        let path = mini_archive(dir);
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let physical = mini_physical();
        let resolved = SchemaResolver::resolve(&schema, &physical).unwrap();
        ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            rules,
            snapshot,
            options,
        )
        .unwrap()
    }

    #[test]
    fn allocate_mode_places_parent_first_with_shared_placeholders() {
        let dir = std::env::temp_dir().join(format!("kode-imp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plan = plan_fixture(
            &dir,
            &ImportOptions::default(),
            &TargetSnapshot::default(),
            &RuleSet::default(),
        );
        // 父先子后。
        assert_eq!(plan.order, vec!["tbl_Avatar", "tbl_Avatar_items"]);
        // 根行在前,子行引用同一占位。
        assert_eq!(plan.statements[0].table, "tbl_Avatar");
        assert_eq!(
            plan.statements[0].cells[0],
            PlannedCell::NewKey { placeholder: 1 }
        );
        assert_eq!(plan.statements[1].table, "tbl_Avatar_items");
        assert!(matches!(
            plan.statements[1].cells[1],
            PlannedCell::KeyReference { placeholder: 1 }
        ));
        // sm_autoLoad 策略覆写(默认禁用)。
        assert_eq!(plan.statements[0].cells[1], PlannedCell::PolicyOverride);
        // 摘要:逐表语句数 + 类别计数。
        assert_eq!(
            plan.summary.statements_per_table,
            BTreeMap::from([
                ("tbl_Avatar".to_string(), 1),
                ("tbl_Avatar_items".to_string(), 2),
            ])
        );
        assert_eq!(plan.summary.id_categories.get("root-entity-key"), Some(&1));
        assert_eq!(plan.summary.id_categories.get("child-row-key"), Some(&2));
        // 两行子表引用同一父键 → 账本按 (表,列,旧值) 去重为一条映射,
        // 引用次数由语句面的 KeyReference 占位共享承载。
        assert_eq!(plan.summary.id_categories.get("parent-reference"), Some(&1));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn preserve_mode_keeps_ids_and_sm_autoload() {
        let dir = std::env::temp_dir().join(format!("kode-imp-p-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plan = plan_fixture(
            &dir,
            &ImportOptions {
                mode: ImportMode::PreserveIfEmpty,
                autoload: AutoLoadPolicy::PreserveArchive,
                unique: UniquePolicy::Reject,
            },
            &TargetSnapshot::default(),
            &RuleSet::default(),
        );
        assert_eq!(plan.statements[0].cells[0], PlannedCell::Literal);
        assert_eq!(plan.statements[0].cells[1], PlannedCell::Literal);
        assert!(plan
            .idmap
            .get("tbl_Avatar", "id", &TypedValue::BigUInt(7))
            .is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unique_conflict_rebuilds_against_target_and_archive() {
        let dir = std::env::temp_dir().join(format!("kode-imp-u-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut snapshot = TargetSnapshot::default();
        snapshot.unique_keys.push(UniqueKey {
            table: "tbl_Avatar".into(),
            column: "sm_name".into(),
        });
        // 目标已有 hero;归档行也叫 hero → 冲突重建。
        snapshot.add_existing("tbl_Avatar", "sm_name", TypedValue::Text("hero".into()));
        let plan = plan_fixture(
            &dir,
            &ImportOptions::default(),
            &snapshot,
            &RuleSet::default(),
        );
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(
            plan.conflicts[0].rebuilt,
            TypedValue::Text("hero_imported1".into())
        );
        assert_eq!(plan.statements[0].cells[2], PlannedCell::Remapped);
        assert_eq!(plan.summary.unique_conflicts, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unique_conflict_reject_policy_fails_closed() {
        let dir = std::env::temp_dir().join(format!("kode-imp-r-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = mini_archive(&dir);
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let mut snapshot = TargetSnapshot::default();
        snapshot.unique_keys.push(UniqueKey {
            table: "tbl_Avatar".into(),
            column: "sm_name".into(),
        });
        snapshot.add_existing("tbl_Avatar", "sm_name", TypedValue::Text("hero".into()));
        let err = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &snapshot,
            &ImportOptions {
                unique: UniquePolicy::Reject,
                ..ImportOptions::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, CloneError::ImportConflict(_)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn account_binding_without_rule_is_not_login_ready() {
        let dir = std::env::temp_dir().join(format!("kode-imp-b-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plan = plan_fixture(
            &dir,
            &ImportOptions::default(),
            &TargetSnapshot::default(),
            &RuleSet::default(),
        );
        assert!(!plan.account_binding.login_ready);
        assert!(plan
            .account_binding
            .note
            .contains("NOT be visible to any local account"));
    }

    #[test]
    fn account_binding_with_follow_rule_declares_binding() {
        let dir = std::env::temp_dir().join(format!("kode-imp-bf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rules = RuleSet {
            relations: vec![crate::rules::RelationRule {
                entity: "Account".into(),
                property_path: "characters".into(),
                child_table: "tbl_Avatar".into(),
                parent_table: "tbl_Account".into(),
                join_column: "sm_avatarID".into(),
                action: RelationRuleAction::Follow,
                note: None,
            }],
            ..Default::default()
        };
        let plan = plan_fixture(
            &dir,
            &ImportOptions::default(),
            &TargetSnapshot::default(),
            &rules,
        );
        assert!(plan.account_binding.login_ready);
        assert_eq!(
            plan.account_binding.declaration.as_deref(),
            Some("Account.characters")
        );
        // 引用审计:被引用表(tbl_Avatar)在克隆集内 → followed。
        assert_eq!(plan.references.len(), 1);
        assert!(plan.references[0].followed);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn skipped_relation_counts_as_unresolved_risk() {
        let dir = std::env::temp_dir().join(format!("kode-imp-s-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rules = RuleSet {
            relations: vec![crate::rules::RelationRule {
                entity: "Avatar".into(),
                property_path: "guildRef".into(),
                child_table: "tbl_Guild".into(),
                parent_table: "tbl_Avatar".into(),
                join_column: "sm_guildDBID".into(),
                action: RelationRuleAction::Skip,
                note: None,
            }],
            ..Default::default()
        };
        let plan = plan_fixture(
            &dir,
            &ImportOptions::default(),
            &TargetSnapshot::default(),
            &rules,
        );
        assert_eq!(plan.summary.unresolved_reference_risks, 1);
        assert!(!plan.references[0].followed);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn archive_table_missing_in_target_fails_closed() {
        let dir = std::env::temp_dir().join(format!("kode-imp-m-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // schema 与目标物理两侧一致(可正常 resolve);归档里多出一张
        // 目标没有的幽灵表 → 计划期拒绝,不猜测列映射。
        let path = dir.join("ghost.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        writer
            .write_row(
                "tbl_Ghost",
                &crate::value::TypedRow {
                    table: "tbl_Ghost".into(),
                    values: vec![TypedValue::BigUInt(1)],
                },
            )
            .unwrap();
        writer.end_table("tbl_Ghost", 1).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let err = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap_err();
        assert!(matches!(err, CloneError::UnknownTable(_)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn readonly_target_is_rejected_before_any_planning() {
        let dir = std::env::temp_dir().join(format!("kode-imp-ro-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = mini_archive(&dir);
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let mut target = mini_target();
        target.writable = false;
        let err = ImportPlanner::plan(
            &archive,
            &target,
            &schema,
            &resolved,
            &RuleSet::default(),
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap_err();
        assert!(matches!(err, CloneError::ImportRejected(_)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn followed_business_reference_remaps_through_idmap() {
        let dir = std::env::temp_dir().join(format!("kode-imp-pet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 声明 Avatar.petRef → tbl_Avatar_items(Follow):sm_petID=100 命中
        // 克隆集内 items 行 → 与该行新键共享占位(BusinessReference 落账)。
        let rules = RuleSet {
            relations: vec![crate::rules::RelationRule {
                entity: "Avatar".into(),
                property_path: "petRef".into(),
                child_table: "tbl_Avatar_items".into(),
                parent_table: "tbl_Avatar".into(),
                join_column: "sm_petID".into(),
                action: RelationRuleAction::Follow,
                note: None,
            }],
            ..Default::default()
        };
        let plan = plan_fixture(
            &dir,
            &ImportOptions::default(),
            &TargetSnapshot::default(),
            &rules,
        );
        assert_eq!(plan.statements[0].table, "tbl_Avatar");
        // items 行 id=100 → 占位 2(items 首行);sm_petID 与之共享。
        assert_eq!(
            plan.statements[0].cells[3],
            PlannedCell::KeyReference { placeholder: 2 }
        );
        assert_eq!(
            plan.summary.id_categories.get("business-reference"),
            Some(&1)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unknown_business_reference_is_kept_as_is_with_warning() {
        let dir = std::env::temp_dir().join(format!("kode-imp-pet9-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rules = RuleSet {
            relations: vec![crate::rules::RelationRule {
                entity: "Avatar".into(),
                property_path: "petRef".into(),
                child_table: "tbl_Avatar_items".into(),
                parent_table: "tbl_Avatar".into(),
                join_column: "sm_petID".into(),
                action: RelationRuleAction::Follow,
                note: None,
            }],
            ..Default::default()
        };
        // petID=999 不在克隆集(items 只有 100/101)→ 原值直通 + 告警,
        // 绝不猜测替换(§9 Phase 3 验收门)。
        let path = mini_archive_pet(&dir, 999);
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let plan = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &rules,
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap();
        assert_eq!(plan.statements[0].cells[3], PlannedCell::Literal);
        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("sm_petID") && w.contains("kept as-is")));
        assert_eq!(plan.summary.id_categories.get("business-reference"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn archived_row_width_mismatch_is_drift() {
        // 归档行宽 ≠ 目标投影列数:不猜列映射,fail-closed(§6.2)。
        let dir = std::env::temp_dir().join(format!("kode-imp-w-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wide.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        // 只给 3 个值(目标投影 4 列)。
        writer
            .write_row(
                "tbl_Avatar",
                &crate::value::TypedRow {
                    table: "tbl_Avatar".into(),
                    values: vec![
                        TypedValue::BigUInt(7),
                        TypedValue::UInt(1),
                        TypedValue::Text("hero".into()),
                    ],
                },
            )
            .unwrap();
        writer.end_table("tbl_Avatar", 1).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let err = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap_err();
        assert!(
            matches!(err, CloneError::DriftMismatch(ref m) if m.contains("projects 4 columns"))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn archived_value_type_mismatch_is_drift() {
        // 归档值类型 ≠ 目标列类型:不猜测转换,fail-closed(PDC-0302)。
        let dir = std::env::temp_dir().join(format!("kode-imp-t-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("type.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        writer
            .write_row(
                "tbl_Avatar",
                &crate::value::TypedRow {
                    table: "tbl_Avatar".into(),
                    values: vec![
                        TypedValue::BigUInt(7),
                        TypedValue::UInt(1),
                        TypedValue::Text("hero".into()),
                        // bigint 列塞文本:类型不合。
                        TypedValue::Text("oops".into()),
                    ],
                },
            )
            .unwrap();
        writer.end_table("tbl_Avatar", 1).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let err = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap_err();
        assert!(
            matches!(err, CloneError::DriftMismatch(ref m) if m.contains("does not fit target column type")),
            "{err:?}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn follow_rule_outside_clone_set_notes_kept_as_is_and_skip_rule_is_unfollowed() {
        // Follow 但被引用表不在克隆集 → 如实记 note(值保持原样);
        // Skip 规则 → 不跟随且计数为风险。两路都进引用审计(PDC-0307)。
        let dir = std::env::temp_dir().join(format!("kode-imp-fo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rules = RuleSet {
            relations: vec![
                crate::rules::RelationRule {
                    entity: "Avatar".into(),
                    property_path: "guildRef".into(),
                    child_table: "tbl_Guild".into(), // 不在克隆集
                    parent_table: "tbl_Avatar".into(),
                    join_column: "sm_guildDBID".into(),
                    action: RelationRuleAction::Follow,
                    note: None,
                },
                crate::rules::RelationRule {
                    entity: "Avatar".into(),
                    property_path: "inventory".into(),
                    child_table: "tbl_Inventory".into(),
                    parent_table: "tbl_Avatar".into(),
                    join_column: "parentID".into(),
                    action: RelationRuleAction::Skip,
                    note: None,
                },
            ],
            ..Default::default()
        };
        let plan = plan_fixture(
            &dir,
            &ImportOptions::default(),
            &TargetSnapshot::default(),
            &rules,
        );
        assert_eq!(plan.references.len(), 2);
        let follow = &plan.references[0];
        assert!(follow.followed);
        assert!(follow.note.contains("outside this clone"));
        assert!(!plan.references[1].followed);
        assert_eq!(plan.summary.unresolved_reference_risks, 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unique_conflict_on_non_text_value_fails_closed() {
        // 唯一键冲突但值非文本:重建策略无法应用,拒绝而非猜测(PDC-0305)。
        let dir = std::env::temp_dir().join(format!("kode-imp-nt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut snapshot = TargetSnapshot::default();
        snapshot.unique_keys.push(UniqueKey {
            table: "tbl_Avatar".into(),
            column: "sm_petID".into(),
        });
        snapshot.add_existing("tbl_Avatar", "sm_petID", TypedValue::BigUInt(100));
        let path = mini_archive(&dir);
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let err = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &snapshot,
            &ImportOptions::default(), // RebuildSuffix 但值非文本
        )
        .unwrap_err();
        assert!(matches!(err, CloneError::ImportConflict(ref m) if m.contains("not text")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn second_colliding_rebuild_picks_next_free_suffix() {
        // 同一唯一键两行冲突:第一行重建为 hero_imported1,第二行探测被占用
        // 后继续递增到 hero_imported2(诚实递增,绝不静默去重)。
        let dir = std::env::temp_dir().join(format!("kode-imp-2c-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut snapshot = TargetSnapshot::default();
        snapshot.unique_keys.push(UniqueKey {
            table: "tbl_Avatar".into(),
            column: "sm_name".into(),
        });
        snapshot.add_existing("tbl_Avatar", "sm_name", TypedValue::Text("hero".into()));
        let path = dir.join("two.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        for id in [7u64, 8] {
            writer
                .write_row(
                    "tbl_Avatar",
                    &crate::value::TypedRow {
                        table: "tbl_Avatar".into(),
                        values: vec![
                            TypedValue::BigUInt(id),
                            TypedValue::UInt(1),
                            TypedValue::Text("hero".into()),
                            TypedValue::BigUInt(100),
                        ],
                    },
                )
                .unwrap();
        }
        writer.end_table("tbl_Avatar", 2).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let plan = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &snapshot,
            &ImportOptions::default(),
        )
        .unwrap();
        assert_eq!(plan.conflicts.len(), 2);
        assert_eq!(
            plan.conflicts[0].rebuilt,
            TypedValue::Text("hero_imported1".into())
        );
        assert_eq!(
            plan.conflicts[1].rebuilt,
            TypedValue::Text("hero_imported2".into())
        );
        assert_eq!(plan.summary.unique_conflicts, 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn archived_table_absent_from_schema_order_is_skipped() {
        // 派生 schema 含 items 表但归档没有:允许,不伪造行(§6.2 目标可含本克隆
        // 未触及的表);语句只含归档表。
        let dir = std::env::temp_dir().join(format!("kode-imp-abs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("root-only.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        writer
            .write_row(
                "tbl_Avatar",
                &crate::value::TypedRow {
                    table: "tbl_Avatar".into(),
                    values: vec![
                        TypedValue::BigUInt(7),
                        TypedValue::UInt(1),
                        TypedValue::Text("hero".into()),
                        TypedValue::BigUInt(100),
                    ],
                },
            )
            .unwrap();
        writer.end_table("tbl_Avatar", 1).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let plan = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap();
        assert_eq!(plan.statements.len(), 1);
        assert_eq!(plan.statements[0].table, "tbl_Avatar");
        assert!(!plan
            .summary
            .statements_per_table
            .contains_key("tbl_Avatar_items"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parent_reference_to_row_outside_clone_fails_closed() {
        // items 行 parentID=999 没有对应根行:idmap 查不到父行,fail-closed
        // (种子遍已登记全部主键;查不到 = 引用了未克隆的父行)。
        let dir = std::env::temp_dir().join(format!("kode-imp-po-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orphan.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        writer
            .write_row(
                "tbl_Avatar",
                &crate::value::TypedRow {
                    table: "tbl_Avatar".into(),
                    values: vec![
                        TypedValue::BigUInt(7),
                        TypedValue::UInt(1),
                        TypedValue::Text("hero".into()),
                        TypedValue::BigUInt(100),
                    ],
                },
            )
            .unwrap();
        writer.end_table("tbl_Avatar", 1).unwrap();
        writer
            .write_row(
                "tbl_Avatar_items",
                &crate::value::TypedRow {
                    table: "tbl_Avatar_items".into(),
                    values: vec![
                        TypedValue::BigUInt(100),
                        TypedValue::BigUInt(999), // 悬空父引用
                        TypedValue::Text("sword".into()),
                    ],
                },
            )
            .unwrap();
        writer.end_table("tbl_Avatar_items", 1).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        let archive = Archive::open(&path, None).unwrap();
        let schema = mini_schema();
        let resolved = SchemaResolver::resolve(&schema, &mini_physical()).unwrap();
        let err = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap_err();
        assert!(
            matches!(err, CloneError::DriftMismatch(ref m) if m.contains("not part of this clone"))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parent_id_value_without_relation_edge_is_invalid_rule() {
        // 表有 parentID 值但关系图无该表的边(无 parent_table_name):防御性拒绝,
        // 绝不把孤儿行静默挂到根。
        let dir = std::env::temp_dir().join(format!("kode-imp-oe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = DerivedTable {
            name: "tbl_Avatar".into(),
            kind: "root".into(),
            parent_table_name: None,
            property_path: None,
            fields: vec![field("id", "bigint unsigned"), field("sm_name", "varchar")],
        };
        let orphan = DerivedTable {
            name: "tbl_Orphan".into(),
            kind: "array".into(),
            parent_table_name: None, // 无父边
            property_path: None,
            fields: vec![
                field("id", "bigint unsigned"),
                field("parentID", "bigint unsigned"),
            ],
        };
        let schema = CloneSchema::new("Avatar".into(), vec![root, orphan]).unwrap();
        let physical = VirtualSchema::new(vec![
            crate::schema::PhysicalTable {
                name: "tbl_Avatar".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::from([
                    ("id".into(), "bigint(20) unsigned".into()),
                    ("sm_name".into(), "varchar(255)".into()),
                ]),
                primary_key: vec!["id".into()],
                indexes: vec![],
            },
            crate::schema::PhysicalTable {
                name: "tbl_Orphan".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::from([
                    ("id".into(), "bigint(20) unsigned".into()),
                    ("parentID".into(), "bigint(20) unsigned".into()),
                ]),
                primary_key: vec!["id".into()],
                indexes: vec![],
            },
        ]);
        let resolved = SchemaResolver::resolve(&schema, &physical).unwrap();
        let path = dir.join("orphan-edge.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        writer
            .write_row(
                "tbl_Avatar",
                &crate::value::TypedRow {
                    table: "tbl_Avatar".into(),
                    values: vec![TypedValue::BigUInt(7), TypedValue::Text("hero".into())],
                },
            )
            .unwrap();
        writer.end_table("tbl_Avatar", 1).unwrap();
        writer
            .write_row(
                "tbl_Orphan",
                &crate::value::TypedRow {
                    table: "tbl_Orphan".into(),
                    values: vec![TypedValue::BigUInt(1), TypedValue::BigUInt(7)],
                },
            )
            .unwrap();
        writer.end_table("tbl_Orphan", 1).unwrap();
        writer
            .finalize(&[], &crate::redact::RedactionReport { entries: vec![] })
            .unwrap();
        let archive = Archive::open(&path, None).unwrap();
        let err = ImportPlanner::plan(
            &archive,
            &mini_target(),
            &schema,
            &resolved,
            &RuleSet::default(),
            &TargetSnapshot::default(),
            &ImportOptions::default(),
        )
        .unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(ref m) if m.contains("no relation edge")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rebuild_unique_falls_back_after_probe_limit() {
        // 诚实兜底:探测上限(10_000)内全被占 → `{base}_{seed}_exhausted`,
        // 绝不无限循环也不静默返回被占值。
        let result = rebuild_unique("hero", "i", |_| true);
        assert_eq!(result, TypedValue::Text("hero_i_exhausted".into()));
        // 首个未占候选直接命中。
        let first = rebuild_unique("hero", "i", |_| false);
        assert_eq!(first, TypedValue::Text("hero_i1".into()));
    }

    #[test]
    fn type_fits_matches_value_kinds_to_column_bases() {
        // 类型相容面:同 schema.rs 口径,剥显示宽度/unsigned 词,按值种类匹配基型。
        assert!(type_fits(&TypedValue::Null, "varchar"));
        assert!(type_fits(&TypedValue::BigUInt(7), "bigint unsigned"));
        assert!(type_fits(&TypedValue::Int(-1), "int"));
        assert!(type_fits(&TypedValue::UInt(3), "mediumint"));
        assert!(!type_fits(&TypedValue::Int(1), "varchar"));
        assert!(type_fits(&TypedValue::Float(1.5), "float"));
        assert!(!type_fits(&TypedValue::Float(1.5), "double"));
        assert!(type_fits(&TypedValue::Double(1.5), "double"));
        assert!(type_fits(&TypedValue::Decimal("12.34".into()), "decimal"));
        assert!(type_fits(&TypedValue::Decimal("12.34".into()), "numeric"));
        assert!(!type_fits(&TypedValue::Decimal("12.34".into()), "float"));
        assert!(type_fits(&TypedValue::Bytes("0102".into()), "blob"));
        assert!(type_fits(
            &TypedValue::Bytes("0102".into()),
            "varbinary(64)"
        ));
        assert!(!type_fits(&TypedValue::Bytes("0102".into()), "text"));
        assert!(type_fits(&TypedValue::Text("hi".into()), "varchar(255)"));
        assert!(type_fits(&TypedValue::Text("hi".into()), "longtext"));
        assert!(!type_fits(&TypedValue::Text("hi".into()), "bigint"));
        let dt = TypedValue::DateTime {
            value: "2026-01-01 00:00:00".into(),
            offset_minutes: None,
        };
        assert!(type_fits(&dt, "datetime"));
        assert!(type_fits(&dt, "timestamp"));
        assert!(!type_fits(&dt, "varchar"));
    }
}
