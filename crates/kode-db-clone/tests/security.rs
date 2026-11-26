//! PDC-0604 security verification (plan doc §6.1 gates / Phase 6): prod→prod
//! rejection, source-account write-permission rejection, SQL injection identifier
//! neutralization, sensitive values never leaking into exports.
//!
//! The mechanisms already have unit tests in src/ (target.rs/reader.rs/planner.rs/
//! redact.rs); this file re-proves fail-closed from the "public API boundary":
//! broader injection payloads (backtick + semicolon + comments), and
//! reader→RedactingSink end-to-end non-leakage. All via public interfaces, no new
//! dependencies.

use std::collections::BTreeMap;

use kode_db_clone::reader::{
    validate_readonly, ExportBudget, ExportControl, ReadOnlyExecutor, RowSink, SourceReader,
    SqlValue,
};
use kode_db_clone::redact::RedactingSink;
use kode_db_clone::{
    CloneError, CloneSchema, DerivedField, DerivedTable, ExportPlanner, PhysicalTable, PlanFilter,
    PlannedQuery, QueryPlan, ResolvedCloneSchema, RuleSet, SchemaResolver, SchemaSource,
    SensitivityPolicy, TargetEnvironment, TypedRow, VirtualSchema,
};

// ---------------------------------------------------------------------------
// 1. prod→prod rejection: import target environments accept only local/test;
// prod/staging is rejected at the parsing layer.
// ---------------------------------------------------------------------------

#[test]
fn prod_and_staging_import_targets_fail_closed() {
    // The environment enum has no prod/staging variant; the only construction path
    // is FromStr parsing; rejection at the parsing layer means a prod target can
    // never be constructed → a prod→prod clone cannot take shape.
    for bad in [
        "prod",
        "staging",
        "PROD",
        "Production",
        "Staging",
        "pRoD",
        " prod ",
    ] {
        let err = bad.parse::<TargetEnvironment>().unwrap_err();
        assert!(
            matches!(err, CloneError::ImportRejected(_)),
            "`{bad}` must be ImportRejected"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Source-account write-permission rejection: any non-read-only statement fails
// closed.
// ---------------------------------------------------------------------------

#[test]
fn source_write_statements_fail_closed() {
    let writes = [
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "DELETE FROM t",
        "DROP TABLE t",
        "ALTER TABLE t ADD c INT",
        "REPLACE INTO t VALUES (1)",
        "CREATE TABLE t (a INT)",
        "TRUNCATE TABLE t",
        "GRANT ALL ON *.* TO 'x'",
        "SET autocommit = 1",
    ];
    for bad in writes {
        assert!(
            validate_readonly(bad).is_err(),
            "write statements must be rejected: {bad}"
        );
    }
    let read_only = [
        "SELECT * FROM t",
        "SHOW TABLES",
        "DESCRIBE t",
        "EXPLAIN SELECT 1",
        "SET SESSION TRANSACTION READ ONLY",
        "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
        "COMMIT",
        "ROLLBACK",
    ];
    for good in read_only {
        assert!(
            validate_readonly(good).is_ok(),
            "read-only statements should pass: {good}"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. SQL injection: identifiers (tables/columns) carrying backtick + semicolon +
//    comment payloads → render_select escapes backticks, the generated SELECT is a
//    single safe statement with no breakout characters outside the quoting.
// ---------------------------------------------------------------------------

fn field(name: &str, type_label: &str) -> DerivedField {
    DerivedField {
        name: name.into(),
        type_label: type_label.into(),
        identifier: name == "id",
        synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
        source: SchemaSource::Def,
    }
}

/// Scans the SQL, asserting that characters outside backtick-quoted spans carry no
/// statement-breakout vehicles (`;`, `'`, `"`, `--`, newlines). Inside backticks,
/// ` `` ` is an escaped backtick and is not asserted.
fn assert_no_breakout(sql: &str) {
    let mut in_backtick = false;
    let mut chars = sql.chars().peekable();
    let mut outside = String::new();
    while let Some(c) = chars.next() {
        if c == '`' {
            if in_backtick && chars.peek() == Some(&'`') {
                // ```` → an escaped backtick, stays inside the quoted span.
                chars.next();
                continue;
            }
            in_backtick = !in_backtick;
            continue;
        }
        if !in_backtick {
            outside.push(c);
        }
    }
    assert!(!in_backtick, "backticks not closed: {sql}");
    for ch in outside.chars() {
        assert!(
            ch != ';' && ch != '\'' && ch != '"' && ch != '\n' && ch != '\r',
            "breakout vehicle `{ch}` outside quoted spans: {sql}"
        );
    }
    assert!(
        !outside.contains("--"),
        "comment `--` outside quoted spans: {sql}"
    );
}

#[test]
fn sql_injection_identifiers_neutralized() {
    // Injection payloads embedded in table/column names: backtick (needs ````
    // escaping), semicolon (statement breakout), comments.
    let evil_table = "tbl_Avatar`; DROP TABLE users; --";
    let evil_col = "id`; SELECT 1; --";
    let derived = CloneSchema::new(
        "Avatar".into(),
        vec![DerivedTable {
            name: evil_table.into(),
            kind: "root".into(),
            parent_table_name: None,
            property_path: Some("Avatar".into()),
            fields: vec![field("id", "bigint unsigned"), field(evil_col, "varchar")],
        }],
    )
    .unwrap();
    let mut physical = VirtualSchema::default();
    let mut cols = BTreeMap::new();
    cols.insert("id".into(), "bigint(20) unsigned".into());
    cols.insert(evil_col.into(), "varchar(255)".into());
    physical.tables.insert(
        evil_table.into(),
        PhysicalTable {
            name: evil_table.into(),
            engine: "InnoDB".into(),
            columns: cols,
            primary_key: vec!["id".into()],
            indexes: vec![],
        },
    );
    let resolved: ResolvedCloneSchema = SchemaResolver::resolve(&derived, &physical).unwrap();
    let planner = ExportPlanner::new(1000);
    let plan = planner
        .plan(&derived, &resolved, &RuleSet::default(), None)
        .unwrap();
    let sql = &plan.queries[0].select_sql;
    // Backtick escaping: every lone ` becomes ````.
    assert!(
        sql.contains("tbl_Avatar``"),
        "table-name backtick escaping: {sql}"
    );
    assert!(sql.contains("id``"), "column-name backtick escaping: {sql}");
    // No statement breakout: no `;`/`--`/quotes/newlines outside the backticks.
    assert_no_breakout(sql);
    assert!(
        sql.contains("WHERE `id` = ?"),
        "predicate parameterized binding: {sql}"
    );
}

// ---------------------------------------------------------------------------
// 4. Secret-leak prevention: sensitive columns (credential/personal) are masked
//    end to end through reader→RedactingSink; the captured output holds no raw
//    secrets and the report records things honestly.
// ---------------------------------------------------------------------------

struct SecretExec {
    root: Vec<Vec<Option<String>>>,
}

impl ReadOnlyExecutor for SecretExec {
    fn query(
        &self,
        _sql: &str,
        _params: &[SqlValue],
    ) -> kode_db_clone::CloneResult<Vec<Vec<Option<String>>>> {
        Ok(self.root.clone())
    }
    fn execute(&self, _sql: &str) -> kode_db_clone::CloneResult<()> {
        Ok(())
    }
}

#[derive(Default)]
struct CaptureSink {
    rows: Vec<TypedRow>,
}

impl RowSink for CaptureSink {
    fn write_row(&mut self, table: &str, row: &TypedRow) -> kode_db_clone::CloneResult<u64> {
        assert_eq!(row.table, table);
        let n = serde_json::to_vec(row).unwrap().len() as u64;
        self.rows.push(row.clone());
        Ok(n)
    }
    fn end_table(&mut self, _table: &str, _count: u64) -> kode_db_clone::CloneResult<()> {
        Ok(())
    }
}

fn secret_plan() -> QueryPlan {
    let columns = ["id", "sm_name", "email", "sm_password"];
    QueryPlan {
        entity_name: "Avatar".into(),
        row_budget: u64::MAX,
        queries: vec![PlannedQuery {
            sequence: 0,
            table: "tbl_Avatar".into(),
            parent_table: None,
            filter: PlanFilter::RootId,
            columns: columns.iter().map(|s| s.to_string()).collect(),
            column_types: columns.iter().map(|_| "varchar".to_string()).collect(),
            select_sql:
                "SELECT `id`, `sm_name`, `email`, `sm_password` FROM `tbl_Avatar` WHERE `id` = ?"
                    .into(),
            estimated_rows: Some(1),
        }],
        denied: vec![],
        missing: vec![],
        identity: None,
        estimated_rows_total: Some(1),
    }
}

#[test]
fn sensitive_values_do_not_leak_into_export() {
    let exec = SecretExec {
        root: vec![vec![
            Some("7".into()),
            Some("Alice".into()),
            Some("alice@example.com".into()),
            Some("hunter2".into()),
        ]],
    };
    let reader = SourceReader::new(&exec);
    let plan = secret_plan();
    let mut capture = CaptureSink::default();
    let policy = SensitivityPolicy::default();
    // The report is taken before the redacting borrow ends (avoids double-borrowing
    // capture).
    let report = {
        let mut redacting = RedactingSink::new(&mut capture, &policy, &plan);
        let out = reader
            .export(
                &plan,
                7,
                &mut redacting,
                &ExportBudget::unlimited(),
                &ExportControl::new(),
            )
            .unwrap();
        assert!(!out.cancelled);
        redacting.report()
    };
    // Leak check: no captured row value may contain the raw secret / the personal
    // email verbatim.
    for row in &capture.rows {
        let encoded = serde_json::to_vec(row).unwrap();
        assert!(
            !encoded.windows(b"hunter2".len()).any(|w| w == b"hunter2"),
            "raw password leaked: {encoded:?}"
        );
        assert!(
            !encoded
                .windows(b"alice@example.com".len())
                .any(|w| w == b"alice@example.com"),
            "raw email leaked: {encoded:?}"
        );
    }
    // The report honestly records the sensitive columns and holds no public
    // columns.
    let cols: BTreeMap<_, _> = report
        .entries
        .iter()
        .map(|e| (e.column.as_str(), e.sensitivity.as_str()))
        .collect();
    assert_eq!(cols.get("sm_password"), Some(&"credential"));
    assert_eq!(cols.get("email"), Some(&"personal"));
    assert_eq!(
        cols.get("sm_name"),
        None,
        "public columns stay out of the report"
    );
    assert_eq!(cols.get("id"), None, "id stays out of the report");
}
