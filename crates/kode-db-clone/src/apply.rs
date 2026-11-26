//! Import Apply/Verify phase (plan §6.2/§6.4 / PDC-0401..0408): executes the
//! parameterized statements of [`ImportPlan`](crate::import::ImportPlan) inside
//! a **single transaction**, backfills the new primary keys returned by the
//! database, cross-checks per table read-only after commit, and produces an
//! auditable [`ImportRun`] plus a controlled cleanup plan that is **never
//! executed automatically**.
//!
//! Real MySQL connections stay out of this crate (same policy as
//! reader/information_schema): the execution face goes through the
//! [`WriteExecutor`] abstraction, and transaction boundaries are strictly
//! orchestrated by the applier (begin → statement by statement → any failure
//! rollback → commit only after all succeed). MySQL `AUTO_INCREMENT` sequence
//! gaps cannot be rolled back, but row atomicity is unaffected (§6.2); the
//! multi-database / non-transactional face must not claim atomicity.
//!
//! Where the three iron rules land during Apply:
//! - Duplicate import check (§6.4): re-importing the same archive fingerprint
//!   is rejected by default and the existing mapping is echoed back; building
//!   "a fresh copy" requires explicitly passing
//!   [`ApplyControl::allow_duplicate`].
//! - Account binding (PDC-0306 write side): with no declaration rule, **no
//!   account table is written at all**; the run report states clearly
//!   "not bound, invisible to local accounts"; with a declaration, only the
//!   binding fact is recorded — credential writes are not this face's job.
//! - Cleanup (PDC-0408): only generates a DELETE plan in reverse topological
//!   order, never executes it; whether entities currently loaded may be
//!   cleaned is decided by the caller (engine side).
//!
//! Engine-native load verification (PDC-0407) lands here only in record form:
//! a real engine environment belongs to the P5 UI wiring (same reason as
//! PDC-0003), so the record honestly marks `attempted: false` and never
//! overclaims verification.

use std::collections::BTreeMap;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::archive::Archive;
use crate::error::{CloneError, CloneResult};
use crate::idmap::{ImportMode, MappedId};
use crate::import::{AutoLoadPolicy, ImportPlan, PlannedCell};
use crate::target::TargetProfile;
use crate::value::{hex_encode, TypedRow, TypedValue};

/// Apply-phase execution face (single transaction; the caller guarantees
/// MySQL/InnoDB, the applier re-checks the target gate).
pub trait WriteExecutor {
    /// Begin a transaction (equivalent to START TRANSACTION).
    fn begin(&mut self) -> CloneResult<()>;
    /// Execute one parameterized INSERT and return the new primary key
    /// assigned by the database (last insert id; returns 0 when the table has
    /// no auto-increment — the caller decides from the plan whether it needs it).
    fn execute_insert(&mut self, sql: &str, params: &[TypedValue]) -> CloneResult<u64>;
    /// Read-only count inside the transaction/session (for Verify; a SELECT
    /// COUNT shape).
    fn query_count(&mut self, sql: &str, params: &[TypedValue]) -> CloneResult<u64>;
    /// Roll back the transaction (failure path).
    fn rollback(&mut self) -> CloneResult<()>;
    /// Commit the transaction (after all statements succeeded).
    fn commit(&mut self) -> CloneResult<()>;
}

/// Registry of imported archives (duplicate-import gate + run id allocation, §6.4).
pub trait ImportRunStore {
    /// Allocate a monotonic run id (starting at 1).
    fn next_run_id(&mut self) -> u64;
    /// Archive fingerprint → existing run (including established mappings).
    fn find_by_fingerprint(&self, fingerprint: &str) -> Option<ImportRun>;
    /// Record one successful import.
    fn record(&mut self, run: ImportRun);
    /// Rewrite the existing entry with the same run id to its final state
    /// (KODE-FULL-009 two-phase: after commit succeeds, record
    /// committed/unknown first; after verification ends, upsert the final
    /// state). The default implementation is equivalent to appending;
    /// persistent implementations should rewrite in place by run_id to avoid
    /// double entries for one run.
    fn upsert(&mut self, run: ImportRun) {
        self.record(run)
    }
}

/// In-process registry (tests / one-shot CLI face; the caller wires a
/// persistent one separately).
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

    fn upsert(&mut self, run: ImportRun) {
        // Rewrite in place by run id (two-phase accounting leaves no double
        // entries); unseen run ids are appended.
        match self.runs.iter_mut().find(|r| r.run_id == run.run_id) {
            Some(slot) => *slot = run,
            None => self.runs.push(run),
        }
    }
}

/// No-op implementation (the default when no registry face is present: does
/// not intercept duplicates, run id is always 1).
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

/// Apply control knobs.
#[derive(Debug, Clone, Default)]
pub struct ApplyControl {
    /// Allow "fresh copy" style duplicate imports (same-fingerprint re-imports
    /// are rejected by default).
    pub allow_duplicate: bool,
    /// Failure injection (at statement N, 1-based; for the PDC-0405
    /// verification face / tests).
    pub fail_at_statement: Option<usize>,
}

/// Apply-phase result of account binding (PDC-0306 write side).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BindingOutcome {
    pub declaration: Option<String>,
    /// Whether a binding was written (engine-semantic binding is done by the
    /// caller / engine side; this face only records).
    pub applied: bool,
    pub note: String,
}

/// Per-table read-only verification result (PDC-0406).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VerifyCheck {
    pub table: String,
    pub expected: u64,
    pub found: u64,
    pub ok: bool,
}

/// Three-state verification conclusion (KODE-FULL-009).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyState {
    /// Committed but verification incomplete (count query interrupted by an
    /// error): the data being in the database is a fact, the count is unknown.
    Unknown,
    /// Verification completed and per-table counts all match.
    Passed,
    /// Verification completed and some table counts disagree.
    Failed,
}

/// Post-commit verification report.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VerifyReport {
    pub checks: Vec<VerifyCheck>,
    /// True only when all checks pass; always false while verification is
    /// incomplete (state=unknown).
    pub passed: bool,
    /// Three-state verification (KODE-FULL-009): explicit distinction
    /// between "count unknown" and "count mismatch".
    pub state: VerifyState,
    /// Raw count-query error (only set when state=unknown).
    pub error: Option<String>,
}

/// KBEngine-native load verification record (PDC-0407).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadVerification {
    /// Whether engine loading was really attempted (false by default in the
    /// v1 crate — engine environments belong to the P5 UI wiring).
    pub attempted: bool,
    pub was_active: Option<bool>,
    pub load_success: Option<bool>,
    /// Spot check of major persisted fields (field → whether archive value /
    /// read-back value agree).
    pub field_checks: Vec<FieldConsistency>,
    pub note: String,
}

/// Single-field consistency (archive value vs engine read-back value).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldConsistency {
    pub table: String,
    pub column: String,
    pub archive_value: TypedValue,
    pub loaded_value: Option<TypedValue>,
    pub matches: bool,
}

/// Controlled cleanup plan (PDC-0408): generate only, never execute.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CleanupPlan {
    /// Reverse-topological-order DELETE (children before parents),
    /// parameterized.
    pub steps: Vec<CleanupStatement>,
    /// Matters the engine side must confirm before execution (whether it is
    /// loaded by a local server, etc.).
    pub preconditions: Vec<String>,
}

/// One cleanup statement.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CleanupStatement {
    pub sequence: usize,
    pub sql: String,
    pub params: Vec<TypedValue>,
}

/// Complete audit record of one import (PDC-0404).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportRun {
    /// Monotonic run id allocated by the store (starting at 1).
    pub run_id: u64,
    /// SHA-256 over the manifest bytes (which cover every data frame checksum).
    pub archive_fingerprint: String,
    pub mode: ImportMode,
    pub inserted_per_table: BTreeMap<String, u64>,
    /// Plan placeholder → real new primary key from the database (backfilled
    /// by Apply, PDC-0402).
    pub resolved_ids: BTreeMap<u64, u64>,
    /// New root-table primary key (allocate mode; the original archive value
    /// in preserve mode).
    pub new_root_id: Option<u64>,
    pub binding: BindingOutcome,
    pub verify: VerifyReport,
    pub cleanup: CleanupPlan,
    pub load_verification: LoadVerification,
}

/// Prior facts about a duplicate import (§6.4: echo the mapping back, do not
/// build the role twice).
#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateImport {
    pub prior_run: ImportRun,
}

/// Apply result.
#[derive(Debug, Clone, PartialEq)]
pub enum ApplyOutcome {
    Applied(ImportRun),
    DuplicateRejected(DuplicateImport),
}

/// Archive fingerprint: SHA-256 over the manifest bytes, which themselves
/// cover every frame checksum.
pub fn archive_fingerprint(archive: &Archive) -> CloneResult<String> {
    let manifest = archive
        .file("manifest.json")
        .ok_or_else(|| CloneError::ArchiveError("archive has no manifest.json frame".into()))?;
    Ok(hex_encode(Sha256::digest(manifest).as_slice()))
}

/// Transaction guard (KODE-FULL-010): any error return between begin..commit
/// (including a `?` passing straight through) rolls back in Drop — no need
/// for hand-written rollback on every error path, and the window where an
/// error after begin could bypass rollback is closed by the type system.
struct TxnGuard<'a> {
    executor: &'a mut dyn WriteExecutor,
    done: bool,
}

impl Drop for TxnGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.executor.rollback();
        }
    }
}

/// Import executor (Prepare product → single-transaction Apply → post-commit Verify).
#[derive(Debug, Default)]
pub struct ImportApplier;

impl ImportApplier {
    /// Execute the import. The failure path guarantees rollback and leaves
    /// no half-applied data (PDC-0405).
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
        // PDC-0401: only MySQL/single-database writes; the target gate is
        // re-checked with the same gate Prepare uses.
        target.validate_for_import()?;

        // PDC-0404/§6.4: duplicate-import gate (same fingerprint rejected by
        // default, existing mapping echoed back).
        let fingerprint = archive_fingerprint(archive)?;
        if !control.allow_duplicate {
            if let Some(prior) = store.find_by_fingerprint(&fingerprint) {
                return Ok(ApplyOutcome::DuplicateRejected(DuplicateImport {
                    prior_run: prior,
                }));
            }
        }

        // Row-value face: the plan only carries binding destinations; Apply
        // takes the archived original value by the statement's (table, row).
        let mut rows_by_table: BTreeMap<String, Vec<TypedRow>> = BTreeMap::new();
        for meta in &archive.meta().tables {
            rows_by_table.insert(meta.name.clone(), archive.table_rows(&meta.name)?);
        }

        // ---- Validate before opening the transaction (KODE-FULL-010):
        // pure data validation of tables/rows/column widths moves before
        // begin ----
        // any error return after begin must roll back; under the old policy
        // these two `?` pass-throughs could bypass rollback, leaving drift
        // errors inside an already-open transaction. After the move the only
        // things that can fail inside the transaction are execution/binding,
        // which TxnGuard covers uniformly.
        for (index, stmt) in plan.statements.iter().enumerate() {
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
            if stmt.cells.len() != stmt.columns.len() || stmt.cells.len() != row.values.len() {
                return Err(CloneError::DriftMismatch(format!(
                    "statement {} of `{}` column arity mismatch: {} cells, {} columns, {} archived values",
                    index + 1,
                    stmt.table,
                    stmt.cells.len(),
                    stmt.columns.len(),
                    row.values.len()
                )));
            }
        }

        executor.begin()?;
        let mut txn = TxnGuard {
            executor: &mut *executor,
            done: false,
        };
        let mut inserted_per_table: BTreeMap<String, u64> = BTreeMap::new();
        let mut resolved_ids: BTreeMap<u64, u64> = BTreeMap::new();

        for (index, stmt) in plan.statements.iter().enumerate() {
            // PDC-0405: failure injection point (the guard rolls back, no
            // half-applied set; a retry takes a fresh run and never resumes
            // silently).
            if control.fail_at_statement == Some(index + 1) {
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
                // Binding failures (order violations, etc.) share the gate
                // with statement failures: guard Drop rolls back, leaving no
                // half-applied set of earlier statements' buffered rows.
                let bound = resolve_param(cell, column, value, &stmt.table, plan, &resolved_ids)?;
                params.push(bound);
            }
            let new_id = txn.executor.execute_insert(&stmt.insert_sql, &params)?;
            // Placeholder backfill: this statement's NewKey placeholders →
            // the real primary key returned by the database (PDC-0402).
            for cell in &stmt.cells {
                if let PlannedCell::NewKey { placeholder } = cell {
                    resolved_ids.insert(*placeholder, new_id);
                }
            }
            *inserted_per_table.entry(stmt.table.clone()).or_insert(0) += 1;
        }

        txn.executor.commit()?;
        txn.done = true;
        drop(txn);

        // ---- Ledger before verification I/O (KODE-FULL-009): record the run
        // as soon as the commit succeeds ----
        // that the data has been committed is an accomplished fact; the
        // subsequent verification is only read-only counting, and no
        // exception/interruption may blind the fingerprint gate (:249
        // find_by_fingerprint) to this import — otherwise retrying the same
        // archive would bypass the gate and insert a second data set. Record
        // the run first with the known facts (row counts / mapping / cleanup
        // plan), mark the verification area state=unknown, then upsert the
        // final state once verification completes. Statement failure paths
        // never reach here (rollback happens before commit), so the ledger
        // cannot show the false entry of "recorded before committed".

        // ---- Account binding write side (PDC-0306): record facts only, no
        // credential/account table writes ----
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

        // ---- Cleanup plan (PDC-0408): reverse topological order, generate
        // only, never execute ----
        let mut steps: Vec<CleanupStatement> = Vec::new();
        for name in plan.order.iter().rev() {
            let ids = new_ids_for_table(plan, &resolved_ids, &rows_by_table, name);
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

        // ---- Root-table new primary key (the external handle, §7 UI display
        // face): the database-assigned value in allocate mode, the archived
        // original in preserve mode (contract: "in preserve mode the archived
        // original value").
        let root_table = plan.order.first().cloned();
        let new_root_id = root_table.as_ref().and_then(|root| {
            new_ids_for_table(plan, &resolved_ids, &rows_by_table, root)
                .first()
                .and_then(typed_id_to_u64)
        });

        let mut run = ImportRun {
            run_id: store.next_run_id(),
            archive_fingerprint: fingerprint,
            mode: plan.mode,
            inserted_per_table: inserted_per_table.clone(),
            resolved_ids: resolved_ids.clone(),
            new_root_id,
            binding,
            verify: VerifyReport {
                checks: Vec::new(),
                passed: false,
                state: VerifyState::Unknown,
                error: None,
            },
            cleanup,
            load_verification: LoadVerification {
                attempted: false,
                was_active: None,
                load_success: None,
                field_checks: Vec::new(),
                note: "engine load verification not attempted: local KBEngine wiring is applied at the UI phase (PDC-0003 environment)".into(),
            },
        };
        store.record(run.clone());

        // ---- Verify (PDC-0406): post-commit per-table read-only
        // cross-check (each new primary key must be row-by-row queryable) ----
        // count-query errors no longer pass straight through with `?`
        // (KODE-FULL-009): the ledger entry is already recorded, the error is
        // recorded as unknown and a recoverable report is raised; retries go
        // through the gate and echo the mapping back, never re-inserting data.
        let mut checks: Vec<VerifyCheck> = Vec::new();
        let mut verify_error: Option<CloneError> = None;
        for name in &plan.order {
            let expected = inserted_per_table.get(name).copied().unwrap_or(0);
            if expected == 0 {
                continue;
            }
            let ids = new_ids_for_table(plan, &resolved_ids, &rows_by_table, name);
            let sql = count_by_ids(name, &ids);
            match executor.query_count(&sql, &ids) {
                Ok(found) => checks.push(VerifyCheck {
                    table: name.clone(),
                    expected,
                    found,
                    ok: found == expected,
                }),
                // A count-query error ≠ the data being absent: the commit
                // fact stands, verification records unknown.
                Err(e) => {
                    verify_error = Some(e);
                    break;
                }
            }
        }
        run.verify = match verify_error.as_ref() {
            Some(e) => VerifyReport {
                checks,
                passed: false,
                state: VerifyState::Unknown,
                error: Some(e.to_string()),
            },
            None => {
                let passed = checks.iter().all(|c| c.ok);
                VerifyReport {
                    passed,
                    state: if passed {
                        VerifyState::Passed
                    } else {
                        VerifyState::Failed
                    },
                    checks,
                    error: None,
                }
            }
        };
        // Final-state rewrite into the same run id entry (two-phase:
        // unknown → passed/failed/unknown).
        store.upsert(run.clone());
        if let Some(e) = verify_error.as_ref() {
            // Recoverable report: the data is committed and the run is
            // recorded by fingerprint; retrying the same archive goes through
            // the duplicate-import gate and echoes prior_run (mapping and
            // cleanup plan intact). The count check can be completed manually
            // from resolved_ids; no automatic re-insertion.
            return Err(CloneError::ImportRejected(format!(
                "post-commit verification errored: {e}; data is committed and run {} is recorded, retry of the same archive returns the prior run instead of re-inserting",
                run.run_id
            )));
        }
        if !run.verify.passed {
            // The data is committed (atomically complete); a verification
            // failure is reported honestly — the committed transaction is not
            // rolled back. The cleanup plan travels with the run report, which
            // the caller retrieves outside the error object.
            return Err(CloneError::DriftMismatch(format!(
                "post-commit verification failed: {:?}",
                run.verify
                    .checks
                    .iter()
                    .filter(|c| !c.ok)
                    .collect::<Vec<_>>()
            )));
        }
        Ok(ApplyOutcome::Applied(run))
    }
}

/// Cell → concrete bound value (table/column joins into the idmap key, §6.3).
fn resolve_param(
    cell: &PlannedCell,
    column: &str,
    value: &TypedValue,
    table: &str,
    plan: &ImportPlan,
    resolved: &BTreeMap<u64, u64>,
) -> CloneResult<TypedValue> {
    Ok(match cell {
        // New primary key: bind NULL, let the target AUTO_INCREMENT assign it;
        // the real value comes back from execute_insert.
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
        // Policy override: bind the policy value (ForceDisabled → 0, §6.2
        // "disable autoLoad online").
        PlannedCell::PolicyOverride => match plan.autoload_policy {
            AutoLoadPolicy::PreserveArchive => value.clone(),
            AutoLoadPolicy::ForceDisabled => TypedValue::UInt(0),
        },
        // Rebuild value decided at plan time (unique keys rebuilt locally;
        // key = table+column+old value).
        PlannedCell::Remapped => match plan.idmap.get(table, column, value) {
            Some(MappedId::Rebuilt { value: rebuilt }) => rebuilt.clone(),
            _ => value.clone(),
        },
    })
}

/// All new primary keys of a table (the actual bound values of the plan's
/// primary-key column for that table): NewKey placeholders take the database
/// backfilled value (allocate); a Literal primary-key column takes the
/// archived original value (preserve — the plan produces no placeholder, so
/// recognizing placeholders only would yield an empty set, making verification
/// falsely report DriftMismatch and the root handle always None).
fn new_ids_for_table(
    plan: &ImportPlan,
    resolved: &BTreeMap<u64, u64>,
    rows: &BTreeMap<String, Vec<TypedRow>>,
    table: &str,
) -> Vec<TypedValue> {
    let mut ids = Vec::new();
    for stmt in &plan.statements {
        if stmt.table != table {
            continue;
        }
        let id_col = stmt.columns.iter().position(|c| c == "id");
        for (idx, cell) in stmt.cells.iter().enumerate() {
            match cell {
                PlannedCell::NewKey { placeholder } => {
                    if let Some(id) = resolved.get(placeholder) {
                        ids.push(TypedValue::BigUInt(*id));
                    }
                }
                PlannedCell::Literal if id_col == Some(idx) => {
                    if let Some(value) = rows
                        .get(table)
                        .and_then(|table_rows| table_rows.get(stmt.row_index))
                        .and_then(|row| row.values.get(idx))
                    {
                        ids.push(value.clone());
                    }
                }
                _ => {}
            }
        }
    }
    ids
}

/// Primary-key bound value → scalar u64 (verification/cleanup parameters stay
/// TypedValue; the root handle takes the numeric value).
fn typed_id_to_u64(value: &TypedValue) -> Option<u64> {
    match value {
        TypedValue::BigUInt(x) => Some(*x),
        TypedValue::UInt(x) => Some(*x),
        TypedValue::Int(x) => Some(*x as u64),
        _ => None,
    }
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
        // NewKey → NULL (left to the target to assign).
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
        // KeyReference already backfilled → the real new primary key; not yet
        // backfilled → an order-violation error.
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
        // PolicyOverride: default policy ForceDisabled → 0;
        // PreserveArchive → the original value.
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
        // Remapped: take the idmap rebuild value (hero → hero_imported1);
        // Literal passes the original value through.
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
        // NoopRunStore: always run id 1, intercepts nothing, records nothing.
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
                state: VerifyState::Passed,
                error: None,
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
