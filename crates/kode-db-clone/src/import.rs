//! Import planner (plan §6.2 Prepare / PDC-0302..0308): load archive → reconcile
//! against the target schema → order by the relation DAG → typed IDMap → unique-key
//! dry run → emit a fully auditable parameterized INSERT plan.
//!
//! The planning phase **never touches the database**: the target surface is provided
//! via [`TargetSnapshot`] (filled by a virtual fixture or the information_schema
//! reader); a real connection belongs to the Apply phase (Phase 4). Statements always
//! use `?` placeholders and never embed raw sensitive values (§6.2).
//!
//! Where this module lands on the three iron rules:
//! - Unknown references are not globally rewritten by default (§9 Phase 3 acceptance
//!   gate): reference columns not followed by a declaration pass their original value
//!   through; if the key is missing from the mapping ledger it stays as-is, never
//!   guessed by column name.
//! - Account binding must not claim login capability without a rule (PDC-0306):
//!   [`AccountBindingPlan::login_ready`] is true only when a declaration rule exists,
//!   otherwise the note says explicitly "the character is not visible to any local
//!   account".
//! - Drift between the target schema and archive rows fails closed (PDC-0302):
//!   missing table / wrong column count / wrong type is rejected.

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

/// Target unique keys (provided by the caller from physical indexes / business
/// declarations; the crate does not pretend to read indexes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UniqueKey {
    pub table: String,
    pub column: String,
}

/// Target surface snapshot (dry-run input for the planning phase): existing unique
/// key values + existing primary key values.
#[derive(Debug, Clone, Default)]
pub struct TargetSnapshot {
    /// Unique keys to dry-run.
    pub unique_keys: Vec<UniqueKey>,
    /// (table, column) → values already present in the target (normalized key form;
    /// the import dry run only compares equality, it never reproduces the original).
    pub existing_values: BTreeMap<(String, String), BTreeSet<String>>,
}

impl TargetSnapshot {
    /// Registers an existing target value (dry-run probe face).
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

/// Unique key conflict policy (PDC-0305).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UniquePolicy {
    /// Reject the plan on conflict (fail-closed).
    Reject,
    /// Local rebuild: `{original}_{seed}{n}` increments until unique against both
    /// the target and the archive.
    RebuildSuffix { seed: String },
}

/// `sm_autoLoad` policy (PDC-0308).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoLoadPolicy {
    /// Keep the archive value.
    PreserveArchive,
    /// Explicitly disable (the default recommendation of §6.2 Apply "disable
    /// autoLoad on the live target").
    ForceDisabled,
}

/// Import options.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub mode: ImportMode,
    pub autoload: AutoLoadPolicy,
    pub unique: UniquePolicy,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            // §6.1: default to the new-ID mode to reduce collision risk.
            mode: ImportMode::AllocateNewIds,
            autoload: AutoLoadPolicy::ForceDisabled,
            unique: UniquePolicy::RebuildSuffix {
                seed: "imported".into(),
            },
        }
    }
}

/// Where a cell's value is rendered (audit face: what each `?` in the statement
/// binds to).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PlannedCell {
    /// Archive original value passes through (parameter binding).
    Literal,
    /// New primary key placeholder (backfilled after the Apply-phase database
    /// returns the key).
    NewKey { placeholder: u64 },
    /// parentID / business reference → key pointing at another row within the same
    /// clone set (shares the placeholder of that row's NewKey).
    KeyReference { placeholder: u64 },
    /// Policy override (sm_autoLoad etc.; binds the policy value instead of the
    /// archive value).
    PolicyOverride,
    /// Mapping rewrite (local rebuild of a unique key / business-reference remap).
    Remapped,
}

/// One planned INSERT (all columns parameterized).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedInsert {
    pub sequence: usize,
    pub table: String,
    pub row_index: usize,
    pub columns: Vec<String>,
    /// Binding destinations, one per column.
    pub cells: Vec<PlannedCell>,
    pub insert_sql: String,
}

/// Resolved unique key conflict (audit face).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UniqueConflict {
    pub table: String,
    pub column: String,
    pub old: TypedValue,
    pub rebuilt: TypedValue,
}

/// Import destination for a declared relation (PDC-0307 audit face).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReferenceOutcome {
    /// `Entity.property` declaration path.
    pub declaration: String,
    pub followed: bool,
    pub note: String,
}

/// Account binding plan (PDC-0306).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountBindingPlan {
    /// The binding declaration that matched (`Entity.property`), None if absent.
    pub declaration: Option<String>,
    /// Always false without a rule: the imported character is not automatically
    /// visible to any local account.
    pub login_ready: bool,
    pub note: String,
}

/// Dry-run summary (§9 Phase 3 acceptance gate: show the change face per table
/// per category).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportSummary {
    pub entity_name: String,
    pub mode: ImportMode,
    pub autoload_policy: AutoLoadPolicy,
    /// table → planned statement count (parents-before-children order).
    pub statements_per_table: BTreeMap<String, usize>,
    /// ID category label → number of changes.
    pub id_categories: BTreeMap<String, usize>,
    pub unique_conflicts: usize,
    pub login_ready: bool,
    /// Number of unresolved reference risks (Skip / outside the clone set /
    /// unclear).
    pub unresolved_reference_risks: usize,
}

/// Complete import plan (serializable for auditing).
#[derive(Debug, Clone, Serialize)]
pub struct ImportPlan {
    pub entity_name: String,
    pub mode: ImportMode,
    pub autoload_policy: AutoLoadPolicy,
    /// Execution order (table names), parents before children.
    pub order: Vec<String>,
    pub statements: Vec<PlannedInsert>,
    pub idmap: IdMap,
    pub conflicts: Vec<UniqueConflict>,
    pub references: Vec<ReferenceOutcome>,
    pub account_binding: AccountBindingPlan,
    /// Schema / version reconciliation notes (honest face: state things
    /// honestly when comparison is not possible).
    pub schema_notes: Vec<String>,
    /// Risks and skips (references not rewritten, relations skipped, version
    /// unknown).
    pub warnings: Vec<String>,
    pub summary: ImportSummary,
}

/// Import planner.
#[derive(Debug, Default)]
pub struct ImportPlanner;

impl ImportPlanner {
    /// Generates the import plan (Prepare phase, no database access).
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

        // ---- PDC-0302: archive tables ⊆ resolved target tables; row width =
        // target projected column count; type compatibility ----
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
                // Row width matches the target projected column count (archive
                // row order = planned query column order, §6.2).
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
        // Tables present in the resolved target but missing from the archive: allowed
        // (the target may contain tables this clone never touches); no fabricated rows.
        let schema_notes = version_notes(target);

        // ---- Generate statements per table, per row (parents before children;
        // parentID references the parent row's placeholder) ----
        let allocate = options.mode == ImportMode::AllocateNewIds;
        let mut idmap = IdMap::new();
        let mut conflicts: Vec<UniqueConflict> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut statements: Vec<PlannedInsert> = Vec::new();

        // Unique-key dry-run inputs: values already in the target ∪ other values in
        // the same archive column ∪ rebuilt values.
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

        // Declared-relation audit (PDC-0307): import destination for Follow/Skip
        // plus out-of-clone-set references are not rewritten.
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
                // The Error action already fails closed in apply_relation (InvalidRule).
                Some(RelationRuleAction::Error) | None => {}
            }
        }
        let unresolved_risks = references
            .iter()
            .filter(|r| !r.followed || r.note.contains("outside this clone"))
            .count();

        // Rules that are Follow and whose referenced table is inside the clone set →
        // (declaring-side table, join column) → referenced table: during row
        // rendering, the column's old value is mapped through the ledger to the new
        // key inside the clone set (PDC-0307).
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

        // Account binding (PDC-0306): a Follow declaration referencing this
        // clone's root table is the binding rule.
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

        // ---- First pass (PDC-0303/0304/0305): full seed mapping ledger ----
        // Primary-key allocation/preservation and unique-key conflict rebuild are
        // recorded first; the render pass only reads the ledger. Business
        // references may point forward to "tables planned later" (the root table
        // references child-table rows), which a single compute-while-reading pass
        // would miss.
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

        // ---- Half-pass one (PDC-0304/0307): record parentID references plus
        // business-reference columns hit by declared Follow (category-count face;
        // the render pass only reads the ledger). ----
        for name in &order {
            let Some(rows) = archived.get(name) else {
                continue;
            };
            let projected = rules.project(&schema.table_index[name]);
            for row in rows {
                for (field, value) in projected.fields.iter().zip(row.values.iter()) {
                    // Register the parentID reference (deduped to one entry for
                    // multiple rows of the same parent; placeholder sharing lives on
                    // the statement face).
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

        // ---- Second pass: render statements (parents before children; all
        // columns `?` parameterized) ----
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

        // ---- Summary (acceptance gate: per table per category) ----
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

/// Single-column render decision (second pass; the ledger is fully seeded, only
/// reads it. Borrow-heavy signature, kept a free function).
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
    // 1) Primary-key column: Allocated → placeholder new key (backfilled by the
    //    Apply-phase database); Preserved → original value passes through;
    //    Rebuilt (id was rebuilt by the unique-key policy) → rewritten value.
    if column == "id" {
        return Ok(match idmap.get(table, column, value) {
            Some(MappedId::Allocated { placeholder }) => PlannedCell::NewKey {
                placeholder: *placeholder,
            },
            Some(MappedId::Rebuilt { .. }) => PlannedCell::Remapped,
            _ => PlannedCell::Literal,
        });
    }

    // 2) parentID: shares the parent row's id placeholder / rewrite (in preserve
    //    mode the original value passes through).
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
            // The seed pass registered all primary keys: not found = the reference
            // points at an un-cloned parent row, fail closed.
            None => {
                return Err(CloneError::DriftMismatch(format!(
                    "parent row id {value:?} of table `{parent}` is not part of this clone"
                )));
            }
        });
    }

    // 3) sm_autoLoad: policy override (PDC-0308).
    if column == "sm_autoLoad" {
        return Ok(match options.autoload {
            AutoLoadPolicy::PreserveArchive => PlannedCell::Literal,
            AutoLoadPolicy::ForceDisabled => PlannedCell::PolicyOverride,
        });
    }

    // 4) Unique-key column: ledger Rebuilt → rewritten value; non-conflicting
    //    ones pass through normally (the reject policy already failed closed in the
    //    seed pass, PDC-0305).
    if let Some(MappedId::Rebuilt { .. }) = idmap.get(table, column, value) {
        return Ok(PlannedCell::Remapped);
    }

    // 5) Declared-Follow business-reference column (PDC-0307): repoint at the new
    //    key inside the clone set; old values the ledger cannot find stay as-is and
    //    warn — unknown references are not globally rewritten by default.
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

    // 6) Remaining columns: any reference not rewritten by a declaration passes
    //    through with its original value.
    Ok(PlannedCell::Literal)
}

/// `{base}_{seed}{n}` (n starts at 1) increments until the probe is false; the
/// 10_000 cap guards against infinite loops.
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
    // Unreachable honest fallback: everything within the probe limit is occupied.
    TypedValue::Text(format!("{base}_{seed}_exhausted"))
}

/// Version reconciliation notes (PDC-0302 honest face: the archive does not
/// record the source engine version).
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

/// Compatibility between archive values and the target column type (PDC-0302;
/// ignores display width / charset, same basis as schema.rs).
fn type_fits(value: &TypedValue, column_type: &str) -> bool {
    let ty = column_type.trim().to_ascii_lowercase();
    // Take the first type word before the parenthesis (strip display width and
    // the unsigned/zerofill suffix words, same normalization basis as schema.rs:
    // `bigint(20) unsigned` → `bigint`).
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
                // Business-reference column sample (declared Avatar.petRef →
                // tbl_Avatar_items, PDC-0307).
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

    /// Writes a minimal archive: one root row (id=7, autoLoad=1, name=hero,
    /// petID=pet) + two items rows (parentID=7).
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
        // Parents before children.
        assert_eq!(plan.order, vec!["tbl_Avatar", "tbl_Avatar_items"]);
        // Root row first, child rows reference the same placeholder.
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
        // sm_autoLoad policy override (disabled by default).
        assert_eq!(plan.statements[0].cells[1], PlannedCell::PolicyOverride);
        // Summary: statements per table + category counts.
        assert_eq!(
            plan.summary.statements_per_table,
            BTreeMap::from([
                ("tbl_Avatar".to_string(), 1),
                ("tbl_Avatar_items".to_string(), 2),
            ])
        );
        assert_eq!(plan.summary.id_categories.get("root-entity-key"), Some(&1));
        assert_eq!(plan.summary.id_categories.get("child-row-key"), Some(&2));
        // Two child-table rows reference the same parent key → the ledger dedupes
        // them into one (table, column, old-value) entry; the reference count is
        // carried by KeyReference placeholder sharing on the statement face.
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
        // The target already has "hero"; the archive row is also "hero" → conflict
        // rebuild.
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
        // Reference audit: the referenced table (tbl_Avatar) is inside the clone
        // set → followed.
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
        // Schema and target physical side agree (resolve works); the archive
        // carries a ghost table the target does not have → rejected at planning
        // time, no column mapping guessed.
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
        // Declared Avatar.petRef → tbl_Avatar_items (Follow): sm_petID=100 hits an
        // items row inside the clone set → shares that row's new-key placeholder
        // (recorded as BusinessReference).
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
        // items row id=100 → placeholder 2 (first items row); sm_petID shares it.
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
        // petID=999 is not in the clone set (items only has 100/101) → original
        // value passes through + warning, never guessed replacement (§9 Phase 3
        // acceptance gate).
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
        // Archive row width ≠ target projected column count: no column mapping
        // guessed, fail closed (§6.2).
        let dir = std::env::temp_dir().join(format!("kode-imp-w-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wide.kdpclone");
        let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        // Only 3 values given (the target projects 4 columns).
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
        // Archive value type ≠ target column type: no conversion guessed, fail
        // closed (PDC-0302).
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
                        // Text into a bigint column: type mismatch.
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
        // Follow but the referenced table is outside the clone set → note honestly
        // records it (values kept as-is); Skip rule → not followed and counted as a
        // risk. Both paths land in the reference audit (PDC-0307).
        let dir = std::env::temp_dir().join(format!("kode-imp-fo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rules = RuleSet {
            relations: vec![
                crate::rules::RelationRule {
                    entity: "Avatar".into(),
                    property_path: "guildRef".into(),
                    child_table: "tbl_Guild".into(), // outside the clone set
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
        // Unique key conflict but the value is not text: the rebuild policy cannot
        // apply, reject instead of guessing (PDC-0305).
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
            &ImportOptions::default(), // RebuildSuffix but the value is not text
        )
        .unwrap_err();
        assert!(matches!(err, CloneError::ImportConflict(ref m) if m.contains("not text")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn second_colliding_rebuild_picks_next_free_suffix() {
        // Two rows collide on the same unique key: the first rebuilds to
        // hero_imported1, the second probes an occupied value and keeps incrementing
        // to hero_imported2 (honest increment, never a silent dedupe).
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
        // The derived schema has an items table but the archive does not: allowed,
        // no fabricated rows (§6.2: the target may contain tables this clone never
        // touches); statements only cover archived tables.
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
        // items row parentID=999 has no matching root row: the idmap cannot find
        // the parent row, fail closed (the seed pass registered all primary keys;
        // not found = the reference points at an un-cloned parent row).
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
                        TypedValue::BigUInt(999), // dangling parent reference
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
        // The table has parentID values but the relation graph has no edge for it
        // (no parent_table_name): defensive rejection, orphan rows are never
        // silently attached to the root.
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
            parent_table_name: None, // no parent edge
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
        // Honest fallback: everything within the probe limit (10_000) is occupied →
        // `{base}_{seed}_exhausted`, never an infinite loop nor silently returning
        // an occupied value.
        let result = rebuild_unique("hero", "i", |_| true);
        assert_eq!(result, TypedValue::Text("hero_i_exhausted".into()));
        // The first unoccupied candidate hits directly.
        let first = rebuild_unique("hero", "i", |_| false);
        assert_eq!(first, TypedValue::Text("hero_i1".into()));
    }

    #[test]
    fn type_fits_matches_value_kinds_to_column_bases() {
        // Type-compatibility face: same basis as schema.rs, strip display width /
        // unsigned words, match base types by value kind.
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
