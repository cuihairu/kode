//! Read-only export from the source database (PDC-0201/0202).
//!
//! Interface-layer read/write isolation: [`ReadOnlyExecutor`] exposes only `query`/`execute` (transaction control),
//! with no DML methods at all; before execution [`validate_readonly`] applies an allowlist again
//! (only SELECT/SHOW/DESCRIBE/EXPLAIN + `SET SESSION TRANSACTION READ ONLY` + transaction control) — a double line of defense.
//!
//! Consistency: within one executor/transaction, the main table and all child tables are read by graph DFS
//! (avoiding the main table reading version A while child tables read version B). First `SET SESSION TRANSACTION READ ONLY`,
//! then try `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` (the MySQL 8 form);
//! if the driver does not support that combination, fall back to `START TRANSACTION WITH CONSISTENT SNAPSHOT`
//! (session-level read-only already guarantees write isolation) — consistent with plan §5.2 "use where supported, check driver behavior".
//!
//! Resources: row/byte budgets and wall-clock timeout are checked between queries, plus a cancel flag (PDC-0202);
//! over-budget errors, and cancel/timeout return `cancelled=true` with the caller discarding temporary output — honest truncation, never faked as complete.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{CloneError, CloneResult};
use crate::planner::QueryPlan;
use crate::value::{TypedRow, TypedValue};

/// Bound parameters (the `?` of read-only SELECTs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlValue {
    I64(i64),
    U64(u64),
    Str(String),
}

/// Read-only statement face (PDC-0201): no DML methods; the write path only carries transaction control statements.
pub trait ReadOnlyExecutor {
    /// Parameterized query (SELECT/SHOW/DESCRIBE/EXPLAIN), returns rows of string cells.
    fn query(&self, sql: &str, params: &[SqlValue]) -> CloneResult<Vec<Vec<Option<String>>>>;
    /// Statement (transaction control), no result set.
    fn execute(&self, sql: &str) -> CloneResult<()>;
}

/// Read-only allowlist validation (PDC-0201): non-allowlisted statements are always refused (fail-closed).
pub fn validate_readonly(sql: &str) -> CloneResult<()> {
    let trimmed = sql.trim_start();
    let first_word = trimmed
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = matches!(
        first_word.as_str(),
        "SELECT" | "SHOW" | "DESCRIBE" | "EXPLAIN" | "COMMIT" | "ROLLBACK" | "BEGIN"
    ) || (first_word == "START"
        && (lower.contains("read only") || lower.contains("with consistent snapshot")))
        || (first_word == "SET"
            && lower.contains("session transaction read only")
            && !lower.contains('='));
    if allowed {
        Ok(())
    } else {
        Err(CloneError::UnsupportedDbInterface(format!(
            "statement is not read-only and is refused: {first_word}"
        )))
    }
}

/// Export budget (PDC-0202): row/size caps and wall-clock timeout.
#[derive(Debug, Clone)]
pub struct ExportBudget {
    pub max_rows: u64,
    pub max_bytes: u64,
    pub timeout: Duration,
}

impl ExportBudget {
    pub fn unlimited() -> Self {
        Self {
            max_rows: u64::MAX,
            max_bytes: u64::MAX,
            timeout: Duration::from_secs(3600),
        }
    }
}

/// Cancellation control (cross-thread/signal cancel): checked between queries.
#[derive(Debug, Clone, Default)]
pub struct ExportControl {
    cancel: Arc<AtomicBool>,
}

impl ExportControl {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// Streaming row sink (PDC-0204): one row at a time, never unbounded accumulation.
pub trait RowSink {
    /// Writes one row; returns the row's encoded size (for byte budget accounting).
    fn write_row(&mut self, table: &str, row: &TypedRow) -> CloneResult<u64>;
    /// End-of-table callback (per-table counts, for manifest/verification).
    fn end_table(&mut self, table: &str, count: u64) -> CloneResult<()>;
}

/// Export outcome: success or cancelled (when cancelled, some rows may already be in the sink; the caller decides whether to discard).
#[derive(Debug)]
pub struct ExportOutcome {
    pub stats: ExportStats,
    pub cancelled: bool,
}

/// Per-table/total statistics.
#[derive(Debug, Clone, Default)]
pub struct ExportStats {
    pub per_table: BTreeMap<String, u64>,
    pub total_rows: u64,
    pub total_bytes: u64,
    pub duration: Duration,
}

/// Read-only exporter for the source database.
pub struct SourceReader<'a> {
    executor: &'a dyn ReadOnlyExecutor,
}

impl std::fmt::Debug for SourceReader<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceReader").finish_non_exhaustive()
    }
}

impl<'a> SourceReader<'a> {
    pub fn new(executor: &'a dyn ReadOnlyExecutor) -> Self {
        Self { executor }
    }

    /// Executes the plan: within a single transaction, reads the root table + all child tables via graph DFS (parent before child).
    pub fn export(
        &self,
        plan: &QueryPlan,
        root_id: u64,
        sink: &mut dyn RowSink,
        budget: &ExportBudget,
        control: &ExportControl,
    ) -> CloneResult<ExportOutcome> {
        let started = Instant::now();
        for q in &plan.queries {
            validate_readonly(&q.select_sql)?;
        }

        // Read-only session + consistent snapshot transaction (with fallback).
        self.executor.execute("SET SESSION TRANSACTION READ ONLY")?;
        match self
            .executor
            .execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        {
            Ok(()) => {}
            Err(_) => self
                .executor
                .execute("START TRANSACTION WITH CONSISTENT SNAPSHOT")?,
        }

        let mut stats = ExportStats::default();
        let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for q in &plan.queries {
            if let Some(parent) = &q.parent_table {
                children
                    .entry(parent.clone())
                    .or_default()
                    .push(q.table.clone());
            }
        }
        let root = plan
            .queries
            .first()
            .ok_or_else(|| CloneError::UnknownTable("plan has no root query".into()))?
            .table
            .clone();

        let result = self.walk(
            plan, &root, root_id, &children, sink, budget, control, started, &mut stats,
        );
        match result {
            Ok(cancelled) => {
                let _ = self
                    .executor
                    .execute(if cancelled { "ROLLBACK" } else { "COMMIT" });
                stats.duration = started.elapsed();
                Ok(ExportOutcome { stats, cancelled })
            }
            Err(e) => {
                // Any error path: roll back (guarantees the transaction never hangs); error text goes through log redaction handled by the caller.
                let _ = self.executor.execute("ROLLBACK");
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn walk(
        &self,
        plan: &QueryPlan,
        table: &str,
        parent_id: u64,
        children: &BTreeMap<String, Vec<String>>,
        sink: &mut dyn RowSink,
        budget: &ExportBudget,
        control: &ExportControl,
        started: Instant,
        stats: &mut ExportStats,
    ) -> CloneResult<bool> {
        let query = plan
            .queries
            .iter()
            .find(|q| q.table == table)
            .ok_or_else(|| CloneError::UnknownTable(table.to_string()))?;
        let param = SqlValue::U64(parent_id);
        let rows = self
            .executor
            .query(&query.select_sql, std::slice::from_ref(&param))?;
        let mut count = 0u64;
        for row in rows {
            if control.is_cancelled() || started.elapsed() > budget.timeout {
                break;
            }
            if stats.total_rows >= budget.max_rows {
                return Err(CloneError::BudgetExceeded {
                    limit: budget.max_rows,
                    requested: stats.total_rows + 1,
                });
            }
            let typed = self.typed_row(table, &row, &query.columns, &query.column_types)?;
            let encoded = serde_json::to_vec(&typed)
                .map_err(|e| CloneError::InvalidRule(format!("encode row: {e}")))?
                .len() as u64;
            stats.total_bytes += encoded;
            if stats.total_bytes > budget.max_bytes {
                return Err(CloneError::BudgetExceeded {
                    limit: budget.max_bytes,
                    requested: stats.total_bytes,
                });
            }
            sink.write_row(table, &typed)?;
            stats.total_rows += 1;
            count += 1;
            stats.per_table.insert(table.to_string(), count);
            let child_id = child_id_of(&typed);
            if let Some(kids) = children.get(table) {
                for kid in kids {
                    if self.walk(
                        plan, kid, child_id, children, sink, budget, control, started, stats,
                    )? {
                        return Ok(true);
                    }
                }
            }
        }
        sink.end_table(table, count)?;
        Ok(control.is_cancelled() || started.elapsed() > budget.timeout)
    }

    /// Row → typed row: in plan column order, with column types from the derived types (PDC-0203 typed encoding).
    fn typed_row(
        &self,
        table: &str,
        row: &[Option<String>],
        columns: &[String],
        column_types: &[String],
    ) -> CloneResult<TypedRow> {
        if row.len() != columns.len() {
            return Err(CloneError::DriftMismatch(format!(
                "table `{table}` row arity {} != columns {}",
                row.len(),
                columns.len()
            )));
        }
        let values = row
            .iter()
            .enumerate()
            .map(|(i, cell)| TypedValue::parse(cell.as_deref(), &column_types[i]))
            .collect();
        Ok(TypedRow {
            table: table.to_string(),
            values,
        })
    }
}

/// The id column within a row (plan column order starts with id; missing records 0 — the import side reconciles via the parentID relation).
fn child_id_of(row: &TypedRow) -> u64 {
    match row.values.first() {
        Some(TypedValue::UInt(v)) => *v,
        Some(TypedValue::Int(v)) => *v as u64,
        Some(TypedValue::BigUInt(v)) => *v,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::ExportPlanner;
    use crate::rules::RuleSet;
    use crate::schema::{
        CloneSchema, DerivedField, DerivedTable, PhysicalTable, SchemaResolver, SchemaSource,
        VirtualSchema,
    };
    use std::cell::RefCell;

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

    fn fixture() -> (QueryPlan, CloneSchema) {
        let schema = CloneSchema::new(
            "Avatar".into(),
            vec![
                root(),
                child("tbl_Avatar_items", "tbl_Avatar"),
                child("tbl_Avatar_items_mods", "tbl_Avatar_items"),
            ],
        )
        .unwrap();
        let mut phys = VirtualSchema::default();
        for (name, cols) in [
            (
                "tbl_Avatar",
                vec![
                    ("id", "bigint unsigned"),
                    ("sm_autoLoad", "tinyint"),
                    ("sm_name", "varchar(255)"),
                ],
            ),
            (
                "tbl_Avatar_items",
                vec![
                    ("id", "bigint unsigned"),
                    ("parentID", "bigint unsigned"),
                    ("sm_autoLoad", "tinyint"),
                    ("sm_value", "varchar(255)"),
                ],
            ),
            (
                "tbl_Avatar_items_mods",
                vec![
                    ("id", "bigint unsigned"),
                    ("parentID", "bigint unsigned"),
                    ("sm_autoLoad", "tinyint"),
                    ("sm_value", "varchar(255)"),
                ],
            ),
        ] {
            phys.tables.insert(
                name.to_string(),
                PhysicalTable {
                    name: name.to_string(),
                    engine: "InnoDB".into(),
                    columns: cols
                        .iter()
                        .map(|(c, t)| ((*c).to_string(), (*t).to_string()))
                        .collect(),
                    primary_key: vec!["id".into()],
                    indexes: vec![],
                },
            );
        }
        let resolved = SchemaResolver::resolve(&schema, &phys).unwrap();
        let plan = ExportPlanner::new(10_000)
            .plan(&schema, &resolved, &RuleSet::default(), None)
            .unwrap();
        (plan, schema)
    }

    /// In-memory executor: records statements and parameters, asserts zero DML.
    struct FakeExecutor {
        rows: BTreeMap<String, Vec<Vec<Option<String>>>>,
        statements: RefCell<Vec<String>>,
        selects: RefCell<Vec<(String, Vec<SqlValue>)>>,
        commits: RefCell<usize>,
        rollbacks: RefCell<usize>,
        fail_combined_start: RefCell<bool>,
    }

    impl FakeExecutor {
        fn new(rows: BTreeMap<String, Vec<Vec<Option<String>>>>) -> Self {
            Self {
                rows,
                statements: RefCell::new(vec![]),
                selects: RefCell::new(vec![]),
                commits: RefCell::new(0),
                rollbacks: RefCell::new(0),
                fail_combined_start: RefCell::new(false),
            }
        }
        fn write_count(&self) -> usize {
            self.statements
                .borrow()
                .iter()
                .filter(|s| {
                    let w = s.trim_start().to_ascii_uppercase();
                    w.starts_with("INSERT")
                        || w.starts_with("UPDATE")
                        || w.starts_with("DELETE")
                        || w.starts_with("DROP")
                        || w.starts_with("ALTER")
                        || w.starts_with("CREATE")
                })
                .count()
        }
    }

    impl ReadOnlyExecutor for FakeExecutor {
        fn query(&self, sql: &str, params: &[SqlValue]) -> CloneResult<Vec<Vec<Option<String>>>> {
            self.selects
                .borrow_mut()
                .push((sql.to_string(), params.to_vec()));
            let table = sql
                .split("FROM `")
                .nth(1)
                .and_then(|s| s.split('`').next())
                .unwrap_or("")
                .to_string();
            // Filters rows by bound parameters (mimicking real `?` semantics): a row is kept if any cell equals a parameter value.
            let all = self.rows.get(&table).cloned().unwrap_or_default();
            let filtered: Vec<_> = all
                .into_iter()
                .filter(|row| {
                    params.iter().all(|p| {
                        let want = match p {
                            SqlValue::U64(v) => v.to_string(),
                            SqlValue::I64(v) => v.to_string(),
                            SqlValue::Str(s) => s.clone(),
                        };
                        row.iter()
                            .any(|cell| cell.as_deref() == Some(want.as_str()))
                    })
                })
                .collect();
            Ok(filtered)
        }
        fn execute(&self, sql: &str) -> CloneResult<()> {
            let w = sql.trim_start().to_ascii_uppercase();
            if w.starts_with("COMMIT") {
                *self.commits.borrow_mut() += 1;
            }
            if w.starts_with("ROLLBACK") {
                *self.rollbacks.borrow_mut() += 1;
            }
            if *self.fail_combined_start.borrow()
                && w.starts_with("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
            {
                return Err(CloneError::UnsupportedDbInterface(
                    "combined form unsupported".into(),
                ));
            }
            self.statements.borrow_mut().push(sql.to_string());
            Ok(())
        }
    }

    /// Collecting row sink.
    struct CollectSink {
        rows: Vec<TypedRow>,
        counts: BTreeMap<String, u64>,
    }
    impl RowSink for CollectSink {
        fn write_row(&mut self, table: &str, row: &TypedRow) -> CloneResult<u64> {
            assert_eq!(row.table, table);
            self.rows.push(row.clone());
            Ok(serde_json::to_vec(row).unwrap().len() as u64)
        }
        fn end_table(&mut self, table: &str, count: u64) -> CloneResult<()> {
            self.counts.insert(table.to_string(), count);
            Ok(())
        }
    }

    #[test]
    fn export_reads_all_tables_read_only_and_commits() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([
            (
                "tbl_Avatar".to_string(),
                vec![vec![
                    Some("100".into()),
                    Some("0".into()),
                    Some("Alice".into()),
                ]],
            ),
            (
                "tbl_Avatar_items".to_string(),
                vec![
                    vec![
                        Some("1001".into()),
                        Some("100".into()),
                        Some("0".into()),
                        Some("sword".into()),
                    ],
                    vec![
                        Some("1002".into()),
                        Some("100".into()),
                        Some("0".into()),
                        Some("shield".into()),
                    ],
                ],
            ),
            (
                "tbl_Avatar_items_mods".to_string(),
                vec![vec![
                    Some("9001".into()),
                    Some("1001".into()),
                    Some("0".into()),
                    Some("sharp".into()),
                ]],
            ),
        ]);
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink {
            rows: vec![],
            counts: BTreeMap::new(),
        };
        let out = reader
            .export(
                &plan,
                100,
                &mut sink,
                &ExportBudget::unlimited(),
                &ExportControl::new(),
            )
            .unwrap();
        assert!(!out.cancelled);
        assert_eq!(out.stats.total_rows, 4);
        assert_eq!(out.stats.per_table["tbl_Avatar_items"], 2);
        assert_eq!(out.stats.per_table["tbl_Avatar_items_mods"], 1);
        // Read order: root first, children after (DFS).
        assert_eq!(sink.rows[0].values[2], TypedValue::Text("Alice".into()));
        assert_eq!(exec.write_count(), 0, "zero DML statements");
        assert_eq!(*exec.commits.borrow(), 1);
        assert_eq!(*exec.rollbacks.borrow(), 0);
        // All SQL passes the allowlist.
        for s in exec.statements.borrow().iter() {
            validate_readonly(s).unwrap();
        }
        for (sql, _) in exec.selects.borrow().iter() {
            validate_readonly(sql).unwrap();
        }
    }

    #[test]
    fn validate_readonly_refuses_dml() {
        for bad in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET x=1",
            "DELETE FROM t",
            "DROP TABLE t",
            "ALTER TABLE t ADD c int",
            "CREATE TABLE t (id int)",
        ] {
            assert!(validate_readonly(bad).is_err(), "refuse: {bad}");
        }
        for good in [
            "SELECT 1",
            "SHOW TABLES",
            "DESCRIBE t",
            "EXPLAIN SELECT 1",
            "SET SESSION TRANSACTION READ ONLY",
            "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
            "COMMIT",
            "ROLLBACK",
        ] {
            assert!(validate_readonly(good).is_ok(), "allow: {good}");
        }
    }

    #[test]
    fn budget_exceeded_rolls_back() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([
            (
                "tbl_Avatar".to_string(),
                vec![vec![
                    Some("100".into()),
                    Some("0".into()),
                    Some("Alice".into()),
                ]],
            ),
            (
                "tbl_Avatar_items".to_string(),
                vec![vec![
                    Some("1001".into()),
                    Some("100".into()),
                    Some("0".into()),
                    Some("sword".into()),
                ]],
            ),
        ]);
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink {
            rows: vec![],
            counts: BTreeMap::new(),
        };
        let budget = ExportBudget {
            max_rows: 1,
            max_bytes: u64::MAX,
            timeout: Duration::from_secs(10),
        };
        let err = reader
            .export(&plan, 100, &mut sink, &budget, &ExportControl::new())
            .unwrap_err();
        assert!(matches!(err, CloneError::BudgetExceeded { .. }));
        assert_eq!(*exec.rollbacks.borrow(), 1, "over budget must roll back");
        assert_eq!(*exec.commits.borrow(), 0);
    }

    #[test]
    fn cancel_returns_cancelled_and_rolls_back() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([
            (
                "tbl_Avatar".to_string(),
                vec![vec![
                    Some("100".into()),
                    Some("0".into()),
                    Some("Alice".into()),
                ]],
            ),
            (
                "tbl_Avatar_items".to_string(),
                vec![vec![
                    Some("1001".into()),
                    Some("100".into()),
                    Some("0".into()),
                    Some("sword".into()),
                ]],
            ),
        ]);
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink {
            rows: vec![],
            counts: BTreeMap::new(),
        };
        let control = ExportControl::new();
        control.cancel();
        let out = reader
            .export(&plan, 100, &mut sink, &ExportBudget::unlimited(), &control)
            .unwrap();
        assert!(out.cancelled);
        assert_eq!(*exec.rollbacks.borrow(), 1, "cancel must roll back");
        assert_eq!(*exec.commits.borrow(), 0);
    }

    #[test]
    fn combined_start_falls_back_to_plain_snapshot() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([(
            "tbl_Avatar".to_string(),
            vec![vec![
                Some("100".into()),
                Some("0".into()),
                Some("Alice".into()),
            ]],
        )]);
        let exec = FakeExecutor::new(rows);
        *exec.fail_combined_start.borrow_mut() = true;
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink {
            rows: vec![],
            counts: BTreeMap::new(),
        };
        let out = reader
            .export(
                &plan,
                100,
                &mut sink,
                &ExportBudget::unlimited(),
                &ExportControl::new(),
            )
            .unwrap();
        assert!(!out.cancelled);
        assert!(
            exec.statements
                .borrow()
                .iter()
                .any(|s| s == "START TRANSACTION WITH CONSISTENT SNAPSHOT"),
            "falls back to the non-combined form"
        );
    }

    #[test]
    fn row_arity_mismatch_is_drift_error() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([(
            "tbl_Avatar".to_string(),
            vec![vec![Some("100".into()), Some("0".into())]],
        )]); // plan has 3 columns, row has 2 values
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink {
            rows: vec![],
            counts: BTreeMap::new(),
        };
        let err = reader
            .export(
                &plan,
                100,
                &mut sink,
                &ExportBudget::unlimited(),
                &ExportControl::new(),
            )
            .unwrap_err();
        assert!(matches!(err, CloneError::DriftMismatch(_)));
    }

    #[test]
    fn typed_row_uses_column_types() {
        let row = vec![Some("18446744073709551615".into()), Some("3.5".into())];
        let cols = vec!["id".to_string(), "level".to_string()];
        let types = vec!["bigint unsigned".to_string(), "double".to_string()];
        let exec = FakeExecutor::new(BTreeMap::new());
        let reader = SourceReader::new(&exec);
        let t = reader.typed_row("t", &row, &cols, &types).unwrap();
        assert_eq!(t.values[0], TypedValue::BigUInt(u64::MAX));
        assert_eq!(t.values[1], TypedValue::Double(3.5));
    }

    #[test]
    fn source_reader_debug_renders_type_name_only() {
        // Debug is the log face: exposes only the type name, never dumps executor internal state.
        let exec = FakeExecutor::new(BTreeMap::new());
        let reader = SourceReader::new(&exec);
        let rendered = format!("{reader:?}");
        assert!(rendered.starts_with("SourceReader"), "{rendered}");
    }

    #[test]
    fn byte_budget_exceeded_reports_limit_and_rolls_back() {
        // Byte budget: the first row's encoding already exceeds the cap → BudgetExceeded (honestly carrying limit/requested),
        // rolling back with no half-done set left behind.
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([(
            "tbl_Avatar".to_string(),
            vec![vec![
                Some("100".into()),
                Some("0".into()),
                Some("Alice-AAAAAAAAAAAAAAAAAAAA".into()),
            ]],
        )]);
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink {
            rows: vec![],
            counts: BTreeMap::new(),
        };
        let budget = ExportBudget {
            max_rows: u64::MAX,
            max_bytes: 1,
            timeout: Duration::from_secs(10),
        };
        let err = reader
            .export(&plan, 100, &mut sink, &budget, &ExportControl::new())
            .unwrap_err();
        match err {
            CloneError::BudgetExceeded { limit, requested } => {
                assert_eq!(limit, 1);
                assert!(
                    requested > 1,
                    "requested must be the real cumulative byte count"
                );
            }
            other => panic!("expected BudgetExceeded, got {other:?}"),
        }
        assert_eq!(
            *exec.rollbacks.borrow(),
            1,
            "byte budget overrun must roll back"
        );
        assert_eq!(*exec.commits.borrow(), 0);
    }

    #[test]
    fn child_id_of_reads_first_column_across_id_kinds() {
        // id column kinds: UInt/Int/BigUInt take the raw value; non-numeric (missing column/text) records 0,
        // with the import side reconciling via the parentID relation.
        let row = |v: TypedValue| TypedRow {
            table: "t".into(),
            values: vec![v, TypedValue::Text("x".into())],
        };
        assert_eq!(child_id_of(&row(TypedValue::UInt(9))), 9);
        assert_eq!(child_id_of(&row(TypedValue::Int(-3))), (-3i64) as u64);
        assert_eq!(child_id_of(&row(TypedValue::BigUInt(7))), 7);
        assert_eq!(child_id_of(&row(TypedValue::Text("7".into()))), 0);
        let empty = TypedRow {
            table: "t".into(),
            values: vec![],
        };
        assert_eq!(child_id_of(&empty), 0);
    }

    #[test]
    fn fake_executor_filters_rows_by_i64_and_str_params() {
        // The fake's `?` semantics: a row is kept if any cell equals the stringified parameter value (same rule for I64/Str).
        let rows = BTreeMap::from([(
            "tbl_Avatar".to_string(),
            vec![
                vec![Some("7".into()), Some("hero".into())],
                vec![Some("8".into()), Some("side".into())],
            ],
        )]);
        let exec = FakeExecutor::new(rows);
        // I64: numeric-form match hits one row; a nonexistent value hits zero rows.
        let got = exec
            .query("SELECT * FROM `tbl_Avatar`", &[SqlValue::I64(8)])
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0][1].as_deref(), Some("side"));
        assert!(exec
            .query("SELECT * FROM `tbl_Avatar`", &[SqlValue::I64(-7)])
            .unwrap()
            .is_empty());
        // Str: text match hits one row.
        let got = exec
            .query(
                "SELECT * FROM `tbl_Avatar`",
                &[SqlValue::Str("hero".into())],
            )
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0][0].as_deref(), Some("7"));
    }
}
