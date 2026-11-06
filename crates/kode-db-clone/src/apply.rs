//! 导入 Apply/Verify 期(plan §6.2/§6.4 / PDC-0401..0408):在**单个事务**内
//! 执行 [`ImportPlan`](crate::import::ImportPlan) 的参数化语句,回填数据库返回的
//! 新主键,提交后按表只读核对,产出可审计的 [`ImportRun`] 与**不自动执行**的
//! 受控清理计划。
//!
//! 真实 MySQL 连接不进本 crate(与 reader/information_schema 同口径):执行面走
//! [`WriteExecutor`] 抽象,事务边界由 applier 严格编排(begin → 逐句 → 任何失败
//! rollback → 全部成功才 commit)。MySQL `AUTO_INCREMENT` 序列间隙不可回滚,
//! 数据行原子性不受影响(§6.2);多库/非事务面不得宣称原子性。
//!
//! 三条铁律的 Apply 期落点:
//! - 重复导入检查(§6.4):同归档指纹再次导入默认拒绝并回显既有映射,
//!   「另建副本」必须显式传 [`ApplyControl::allow_duplicate`]。
//! - 账号绑定(PDC-0306 写侧):无声明规则时**不写任何账号表**,run 报告明确
//!   「未绑定,本地账号不可见」;有声明也只登记绑定事实,凭据类写操作不属本面。
//! - 清理(PDC-0408):只生成按逆拓扑序的 DELETE 计划,永不自动执行;加载中的
//!   实体是否可清理由调用方(引擎侧)判定。
//!
//! 引擎原生加载验证(PDC-0407)在本面只落记录形态:真实引擎环境属 P5 UI 装配
//! (PDC-0003 同因),记录如实标 `attempted: false`,不虚报已验证。

use std::collections::BTreeMap;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::archive::Archive;
use crate::error::{CloneError, CloneResult};
use crate::idmap::{ImportMode, MappedId};
use crate::import::{AutoLoadPolicy, ImportPlan, PlannedCell};
use crate::target::TargetProfile;
use crate::value::{hex_encode, TypedRow, TypedValue};

/// Apply 期执行面(单一事务;调用方保证 MySQL/InnoDB,applier 复核目标门槛)。
pub trait WriteExecutor {
    /// 开启事务(等效 START TRANSACTION)。
    fn begin(&mut self) -> CloneResult<()>;
    /// 执行一条参数化 INSERT,返回数据库分配的新主键(last insert id;
    /// 表无自增时返回 0,调用方按计划判别是否需要)。
    fn execute_insert(&mut self, sql: &str, params: &[TypedValue]) -> CloneResult<u64>;
    /// 事务/会话内只读计数(Verify 用;SELECT COUNT 形态)。
    fn query_count(&mut self, sql: &str, params: &[TypedValue]) -> CloneResult<u64>;
    /// 回滚事务(失败路径)。
    fn rollback(&mut self) -> CloneResult<()>;
    /// 提交事务(全部语句成功后)。
    fn commit(&mut self) -> CloneResult<()>;
}

/// 已导入归档的登记处(重复导入闸 + run 号分配,§6.4)。
pub trait ImportRunStore {
    /// 分配单调 run 号(1 起)。
    fn next_run_id(&mut self) -> u64;
    /// 归档指纹 → 既有 run(含已建立的映射)。
    fn find_by_fingerprint(&self, fingerprint: &str) -> Option<ImportRun>;
    /// 落账一次成功导入。
    fn record(&mut self, run: ImportRun);
}

/// 进程内登记(测试/单次 CLI 面;持久化面由调用方另配)。
#[derive(Debug, Default)]
pub struct MemoryRunStore {
    next: u64,
    runs: Vec<ImportRun>,
}

impl MemoryRunStore {
    pub fn new() -> Self {
        Self {
            next: 1,
            runs: Vec::new(),
        }
    }

    pub fn runs(&self) -> &[ImportRun] {
        &self.runs
    }
}

impl ImportRunStore for MemoryRunStore {
    fn next_run_id(&mut self) -> u64 {
        let id = self.next;
        self.next += 1;
        id
    }

    fn find_by_fingerprint(&self, fingerprint: &str) -> Option<ImportRun> {
        self.runs
            .iter()
            .rev()
            .find(|r| r.archive_fingerprint == fingerprint)
            .cloned()
    }

    fn record(&mut self, run: ImportRun) {
        self.runs.push(run);
    }
}

/// 空实现(无登记面时的默认:不拦截重复,run 号恒 1)。
#[derive(Debug, Default)]
pub struct NoopRunStore;

impl ImportRunStore for NoopRunStore {
    fn next_run_id(&mut self) -> u64 {
        1
    }
    fn find_by_fingerprint(&self, _fingerprint: &str) -> Option<ImportRun> {
        None
    }
    fn record(&mut self, _run: ImportRun) {}
}

/// Apply 控制项。
#[derive(Debug, Clone, Default)]
pub struct ApplyControl {
    /// 允许「另建副本」式重复导入(默认拒绝同指纹重导)。
    pub allow_duplicate: bool,
    /// 失败注入(第 N 条语句,1 基;PDC-0405 验证面/测试用)。
    pub fail_at_statement: Option<usize>,
}

/// 账号绑定的 Apply 期结果(PDC-0306 写侧)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BindingOutcome {
    pub declaration: Option<String>,
    /// 是否写入了绑定(引擎语义绑定由调用方/引擎侧完成;本面只登记)。
    pub applied: bool,
    pub note: String,
}

/// 逐表只读核对结果(PDC-0406)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VerifyCheck {
    pub table: String,
    pub expected: u64,
    pub found: u64,
    pub ok: bool,
}

/// 提交后核对报告。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VerifyReport {
    pub checks: Vec<VerifyCheck>,
    /// 全部核对通过才为 true。
    pub passed: bool,
}

/// KBEngine 原生加载验证记录(PDC-0407)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadVerification {
    /// 是否真的尝试了引擎加载(v1 crate 内默认 false——引擎环境属 P5 UI 装配)。
    pub attempted: bool,
    pub was_active: Option<bool>,
    pub load_success: Option<bool>,
    /// 主要持久化字段一致性抽查(字段 → 归档值/回读值是否一致)。
    pub field_checks: Vec<FieldConsistency>,
    pub note: String,
}

/// 单字段一致性(归档值 vs 引擎回读值)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldConsistency {
    pub table: String,
    pub column: String,
    pub archive_value: TypedValue,
    pub loaded_value: Option<TypedValue>,
    pub matches: bool,
}

/// 受控清理计划(PDC-0408):只生成,不执行。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CleanupPlan {
    /// 逆拓扑序 DELETE(子先父后),参数化。
    pub steps: Vec<CleanupStatement>,
    /// 执行前必须由引擎侧确认的事项(是否被本地服务器加载等)。
    pub preconditions: Vec<String>,
}

/// 一条清理语句。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CleanupStatement {
    pub sequence: usize,
    pub sql: String,
    pub params: Vec<TypedValue>,
}

/// 一次导入的完整审计记录(PDC-0404)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportRun {
    /// store 分配的单调 run 号(1 起)。
    pub run_id: u64,
    /// manifest 字节的 SHA-256(覆盖全部数据帧校验和)。
    pub archive_fingerprint: String,
    pub mode: ImportMode,
    pub inserted_per_table: BTreeMap<String, u64>,
    /// 计划占位 → 数据库真实新主键(Apply 回填,PDC-0402)。
    pub resolved_ids: BTreeMap<u64, u64>,
    /// 根表新主键(allocate 模式;preserve 模式为归档原值)。
    pub new_root_id: Option<u64>,
    pub binding: BindingOutcome,
    pub verify: VerifyReport,
    pub cleanup: CleanupPlan,
    pub load_verification: LoadVerification,
}

/// 重复导入的既有事实(§6.4:回显映射,不重复建角色)。
#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateImport {
    pub prior_run: ImportRun,
}

/// Apply 结果。
#[derive(Debug, Clone, PartialEq)]
pub enum ApplyOutcome {
    Applied(ImportRun),
    DuplicateRejected(DuplicateImport),
}

/// 归档指纹:manifest 覆盖全部帧校验和,对其字节取 SHA-256。
pub fn archive_fingerprint(archive: &Archive) -> CloneResult<String> {
    let manifest = archive
        .file("manifest.json")
        .ok_or_else(|| CloneError::ArchiveError("archive has no manifest.json frame".into()))?;
    Ok(hex_encode(Sha256::digest(manifest).as_slice()))
}

/// 导入执行器(Prepare 产物 → 单事务 Apply → 提交后 Verify)。
#[derive(Debug, Default)]
pub struct ImportApplier;

impl ImportApplier {
    /// 执行导入。失败路径保证 rollback 且无半套数据(PDC-0405)。
    #[allow(clippy::too_many_arguments)]
    pub fn apply(
        &self,
        plan: &ImportPlan,
        archive: &Archive,
        target: &TargetProfile,
        executor: &mut dyn WriteExecutor,
        store: &mut dyn ImportRunStore,
        control: &ApplyControl,
    ) -> CloneResult<ApplyOutcome> {
        // PDC-0401:仅 MySQL/单库可写;目标门槛与 Prepare 同闸复核。
        target.validate_for_import()?;

        // PDC-0404/§6.4:重复导入闸(同指纹默认拒绝,回显既有映射)。
        let fingerprint = archive_fingerprint(archive)?;
        if !control.allow_duplicate {
            if let Some(prior) = store.find_by_fingerprint(&fingerprint) {
                return Ok(ApplyOutcome::DuplicateRejected(DuplicateImport {
                    prior_run: prior,
                }));
            }
        }

        // 行值面:计划只带绑定去向,Apply 按语句的 (表,行号) 取归档原值。
        let mut rows_by_table: BTreeMap<String, Vec<TypedRow>> = BTreeMap::new();
        for meta in &archive.meta().tables {
            rows_by_table.insert(meta.name.clone(), archive.table_rows(&meta.name)?);
        }

        executor.begin()?;
        let mut inserted_per_table: BTreeMap<String, u64> = BTreeMap::new();
        let mut resolved_ids: BTreeMap<u64, u64> = BTreeMap::new();

        for (index, stmt) in plan.statements.iter().enumerate() {
            // PDC-0405:失败注入点(rollback 后无半套;重试走全新 run,不静默续写)。
            if control.fail_at_statement == Some(index + 1) {
                executor.rollback()?;
                return Err(CloneError::ImportRejected(format!(
                    "injected failure at statement {} of {}; transaction rolled back, nothing committed",
                    index + 1,
                    plan.statements.len()
                )));
            }
            let rows = rows_by_table.get(&stmt.table).ok_or_else(|| {
                CloneError::DriftMismatch(format!(
                    "statement references table `{}` which is absent from the archive",
                    stmt.table
                ))
            })?;
            let row = rows.get(stmt.row_index).ok_or_else(|| {
                CloneError::DriftMismatch(format!(
                    "statement references row {} of `{}` which is absent from the archive",
                    stmt.row_index, stmt.table
                ))
            })?;
            let mut params: Vec<TypedValue> = Vec::with_capacity(stmt.cells.len());
            for ((cell, column), value) in stmt
                .cells
                .iter()
                .zip(stmt.columns.iter())
                .zip(row.values.iter())
            {
                params.push(resolve_param(
                    cell,
                    column,
                    value,
                    &stmt.table,
                    plan,
                    &resolved_ids,
                )?);
            }
            let new_id = match executor.execute_insert(&stmt.insert_sql, &params) {
                Ok(id) => id,
                Err(e) => {
                    // 语句失败(约束/连接):先回滚再上报;回滚失败不掩盖原始错误。
                    let _ = executor.rollback();
                    return Err(e);
                }
            };
            // 占位回填:该语句的 NewKey 占位 → 数据库返回的真实主键(PDC-0402)。
            for cell in &stmt.cells {
                if let PlannedCell::NewKey { placeholder } = cell {
                    resolved_ids.insert(*placeholder, new_id);
                }
            }
            *inserted_per_table.entry(stmt.table.clone()).or_insert(0) += 1;
        }

        executor.commit()?;

        // ---- Verify(PDC-0406):提交后按表只读核对(新主键必须逐行可查) ----
        let mut checks: Vec<VerifyCheck> = Vec::new();
        for name in &plan.order {
            let expected = inserted_per_table.get(name).copied().unwrap_or(0);
            if expected == 0 {
                continue;
            }
            let ids = new_ids_for_table(plan, &resolved_ids, name);
            let sql = count_by_ids(name, &ids);
            let found = executor.query_count(&sql, &ids)?;
            checks.push(VerifyCheck {
                table: name.clone(),
                expected,
                found,
                ok: found == expected,
            });
        }
        let passed = checks.iter().all(|c| c.ok);

        // ---- 账号绑定写侧(PDC-0306):只登记事实,不写凭据/账号表 ----
        let binding = match &plan.account_binding.declaration {
            Some(declaration) => BindingOutcome {
                declaration: Some(declaration.clone()),
                applied: false,
                note: format!(
                    "binding rule `{declaration}` recorded; engine-side binding (no credential writes) is applied by the caller during load verification"
                ),
            },
            None => BindingOutcome {
                declaration: None,
                applied: false,
                note: "no account binding rule; the imported entity is not visible to any local account".into(),
            },
        };

        // ---- 清理计划(PDC-0408):逆拓扑序,只生成不执行 ----
        let mut steps: Vec<CleanupStatement> = Vec::new();
        for name in plan.order.iter().rev() {
            let ids = new_ids_for_table(plan, &resolved_ids, name);
            if ids.is_empty() {
                continue;
            }
            steps.push(CleanupStatement {
                sequence: steps.len(),
                sql: delete_by_ids(name, &ids),
                params: ids,
            });
        }
        let cleanup = CleanupPlan {
            steps,
            preconditions: vec![
                "confirm the entity is not currently loaded by a local KBEngine server".into(),
                "confirm no other test data references the imported rows".into(),
            ],
        };

        // ---- 根表新主键(allocate 模式的对外句柄,§7 UI 展示面) ----
        let root_table = plan.order.first().cloned();
        let new_root_id = root_table.as_ref().and_then(|root| {
            plan.statements
                .iter()
                .find(|s| s.table == *root)
                .and_then(|s| {
                    s.cells.iter().find_map(|c| match c {
                        PlannedCell::NewKey { placeholder } => {
                            resolved_ids.get(placeholder).copied()
                        }
                        _ => None,
                    })
                })
        });

        let run = ImportRun {
            run_id: store.next_run_id(),
            archive_fingerprint: fingerprint,
            mode: plan.mode,
            inserted_per_table,
            resolved_ids,
            new_root_id,
            binding,
            verify: VerifyReport { checks, passed },
            cleanup,
            load_verification: LoadVerification {
                attempted: false,
                was_active: None,
                load_success: None,
                field_checks: Vec::new(),
                note: "engine load verification not attempted: local KBEngine wiring is applied at the UI phase (PDC-0003 environment)".into(),
            },
        };
        if !run.verify.passed {
            // 数据已提交(原子完整);核对失败如实上报,不回滚已提交事务,
            // 清理计划随错误对象之外的 run 报告由调用方取回处理。
            return Err(CloneError::DriftMismatch(format!(
                "post-commit verification failed: {:?}",
                run.verify
                    .checks
                    .iter()
                    .filter(|c| !c.ok)
                    .collect::<Vec<_>>()
            )));
        }
        store.record(run.clone());
        Ok(ApplyOutcome::Applied(run))
    }
}

/// 单元格 → 具体绑定值(表/列入 idmap 键,§6.3)。
fn resolve_param(
    cell: &PlannedCell,
    column: &str,
    value: &TypedValue,
    table: &str,
    plan: &ImportPlan,
    resolved: &BTreeMap<u64, u64>,
) -> CloneResult<TypedValue> {
    Ok(match cell {
        // 新主键:绑 NULL,由目标 AUTO_INCREMENT 分配,真实值随 execute_insert 返回。
        PlannedCell::NewKey { .. } => TypedValue::Null,
        PlannedCell::KeyReference { placeholder } => {
            let id = resolved.get(placeholder).ok_or_else(|| {
                CloneError::InvalidRule(format!(
                    "key reference placeholder {placeholder} resolved before its row was inserted (order violation)"
                ))
            })?;
            TypedValue::BigUInt(*id)
        }
        PlannedCell::Literal => value.clone(),
        // 策略覆写:绑定策略值(ForceDisabled → 0,§6.2「禁用线上 autoLoad」)。
        PlannedCell::PolicyOverride => match plan.autoload_policy {
            AutoLoadPolicy::PreserveArchive => value.clone(),
            AutoLoadPolicy::ForceDisabled => TypedValue::UInt(0),
        },
        // 计划期已定的重建值(唯一键本地重建;键 = 表+列+旧值)。
        PlannedCell::Remapped => match plan.idmap.get(table, column, value) {
            Some(MappedId::Rebuilt { value: rebuilt }) => rebuilt.clone(),
            _ => value.clone(),
        },
    })
}

/// 表的全部新主键(按计划该表 NewKey 占位的回填值)。
fn new_ids_for_table(
    plan: &ImportPlan,
    resolved: &BTreeMap<u64, u64>,
    table: &str,
) -> Vec<TypedValue> {
    let mut ids = Vec::new();
    for stmt in &plan.statements {
        if stmt.table != table {
            continue;
        }
        for cell in &stmt.cells {
            if let PlannedCell::NewKey { placeholder } = cell {
                if let Some(id) = resolved.get(placeholder) {
                    ids.push(TypedValue::BigUInt(*id));
                }
            }
        }
    }
    ids
}

fn count_by_ids(table: &str, ids: &[TypedValue]) -> String {
    format!(
        "SELECT COUNT(*) FROM {table} WHERE id IN ({})",
        placeholders(ids.len())
    )
}

fn delete_by_ids(table: &str, ids: &[TypedValue]) -> String {
    format!(
        "DELETE FROM {table} WHERE id IN ({})",
        placeholders(ids.len())
    )
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_plan() -> ImportPlan {
        let mut idmap = crate::idmap::IdMap::new();
        idmap.rebuild(
            crate::idmap::IdMapKey {
                table: "tbl_Avatar".into(),
                column: "sm_name".into(),
                old: TypedValue::Text("hero".into()),
            },
            TypedValue::Text("hero_imported1".into()),
            crate::idmap::IdCategory::RebuiltIdentity,
        );
        ImportPlan {
            entity_name: "Avatar".into(),
            mode: ImportMode::AllocateNewIds,
            autoload_policy: AutoLoadPolicy::ForceDisabled,
            order: vec!["tbl_Avatar".into()],
            statements: vec![],
            idmap,
            conflicts: vec![],
            references: vec![],
            account_binding: crate::import::AccountBindingPlan {
                declaration: None,
                login_ready: false,
                note: String::new(),
            },
            schema_notes: vec![],
            warnings: vec![],
            summary: crate::import::ImportSummary {
                entity_name: "Avatar".into(),
                mode: ImportMode::AllocateNewIds,
                autoload_policy: AutoLoadPolicy::ForceDisabled,
                statements_per_table: BTreeMap::new(),
                id_categories: BTreeMap::new(),
                unique_conflicts: 0,
                login_ready: false,
                unresolved_reference_risks: 0,
            },
        }
    }

    #[test]
    fn resolve_param_branches() {
        let mut plan = test_plan();
        // NewKey → NULL(交给目标分配)。
        assert_eq!(
            resolve_param(
                &PlannedCell::NewKey { placeholder: 1 },
                "id",
                &TypedValue::BigUInt(7),
                "tbl_Avatar",
                &plan,
                &BTreeMap::new(),
            )
            .unwrap(),
            TypedValue::Null
        );
        // KeyReference 已回填 → 真实新主键;未回填 → 顺序违规报错。
        let resolved = BTreeMap::from([(1u64, 1000u64)]);
        assert_eq!(
            resolve_param(
                &PlannedCell::KeyReference { placeholder: 1 },
                "parentID",
                &TypedValue::BigUInt(7),
                "tbl_Avatar_items",
                &plan,
                &resolved,
            )
            .unwrap(),
            TypedValue::BigUInt(1000)
        );
        assert!(resolve_param(
            &PlannedCell::KeyReference { placeholder: 9 },
            "parentID",
            &TypedValue::BigUInt(7),
            "tbl_Avatar_items",
            &plan,
            &BTreeMap::new(),
        )
        .is_err());
        // PolicyOverride:默认策略 ForceDisabled → 0;PreserveArchive → 原值。
        assert_eq!(
            resolve_param(
                &PlannedCell::PolicyOverride,
                "sm_autoLoad",
                &TypedValue::UInt(1),
                "tbl_Avatar",
                &plan,
                &BTreeMap::new(),
            )
            .unwrap(),
            TypedValue::UInt(0)
        );
        plan.autoload_policy = AutoLoadPolicy::PreserveArchive;
        assert_eq!(
            resolve_param(
                &PlannedCell::PolicyOverride,
                "sm_autoLoad",
                &TypedValue::UInt(1),
                "tbl_Avatar",
                &plan,
                &BTreeMap::new(),
            )
            .unwrap(),
            TypedValue::UInt(1)
        );
        // Remapped:取 idmap 重建值(hero → hero_imported1);Literal 原值直通。
        assert_eq!(
            resolve_param(
                &PlannedCell::Remapped,
                "sm_name",
                &TypedValue::Text("hero".into()),
                "tbl_Avatar",
                &plan,
                &BTreeMap::new(),
            )
            .unwrap(),
            TypedValue::Text("hero_imported1".into())
        );
        assert_eq!(
            resolve_param(
                &PlannedCell::Literal,
                "sm_value",
                &TypedValue::Text("sword".into()),
                "tbl_Avatar_items",
                &plan,
                &BTreeMap::new(),
            )
            .unwrap(),
            TypedValue::Text("sword".into())
        );
    }

    #[test]
    fn noop_run_store_never_intercepts() {
        // NoopRunStore:恒 1 号、不拦截、不落账。
        let mut noop = NoopRunStore;
        assert_eq!(noop.next_run_id(), 1);
        assert!(noop.find_by_fingerprint("x").is_none());
        noop.record(dummy_run("x"));
        assert!(noop.find_by_fingerprint("x").is_none());
    }

    fn dummy_run(fingerprint: &str) -> ImportRun {
        ImportRun {
            run_id: 1,
            archive_fingerprint: fingerprint.into(),
            mode: ImportMode::AllocateNewIds,
            inserted_per_table: BTreeMap::new(),
            resolved_ids: BTreeMap::new(),
            new_root_id: None,
            binding: BindingOutcome {
                declaration: None,
                applied: false,
                note: String::new(),
            },
            verify: VerifyReport {
                checks: vec![],
                passed: true,
            },
            cleanup: CleanupPlan {
                steps: vec![],
                preconditions: vec![],
            },
            load_verification: LoadVerification {
                attempted: false,
                was_active: None,
                load_success: None,
                field_checks: vec![],
                note: String::new(),
            },
        }
    }
}
