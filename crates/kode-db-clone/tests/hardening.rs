//! CLONE-P6 hardening tests (plan doc §10 matrix closure / Phase 6
//! PDC-0602/0603/0605): tamper-resistant fuzz, deep nesting, scale budget /
//! cancel / timeout, cross-platform paths.
//!
//! Everything goes through the public API with no new dependencies (PDC-0601's
//! real MySQL lives in mysql_real.rs, gated separately). Assertions target "never
//! silently accept corruption" rather than "specific error messages", so that any
//! frame layout change gets caught by this suite.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use kode_db_clone::archive::{Archive, ArchiveWriter};
use kode_db_clone::error::CloneError;
use kode_db_clone::planner::{PlanFilter, PlannedQuery, QueryPlan};
use kode_db_clone::reader::{
    ExportBudget, ExportControl, ReadOnlyExecutor, RowSink, SourceReader, SqlValue,
};
use kode_db_clone::redact::RedactionReport;
use kode_db_clone::relations::{RelationGraph, RelationKind};
use kode_db_clone::schema::{CloneSchema, DerivedField, DerivedTable, SchemaSource};
use kode_db_clone::value::{TypedRow, TypedValue};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "kdp-hard-{tag}-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("main")
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn field(name: &str, type_label: &str) -> DerivedField {
    DerivedField {
        name: name.into(),
        type_label: type_label.into(),
        identifier: name == "id",
        synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
        source: SchemaSource::Def,
    }
}

fn row(table: &str, values: Vec<TypedValue>) -> TypedRow {
    TypedRow {
        table: table.into(),
        values,
    }
}

/// Writes a minimal archive (Avatar root + 1 row), returns the path.
fn write_small_archive(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
    w.write_row(
        "tbl_Avatar",
        &row(
            "tbl_Avatar",
            vec![
                TypedValue::BigUInt(7),
                TypedValue::UInt(1),
                TypedValue::Text("Alice".into()),
            ],
        ),
    )
    .unwrap();
    w.end_table("tbl_Avatar", 1).unwrap();
    w.finalize(&[], &RedactionReport { entries: vec![] })
        .unwrap();
    path
}

// ---------------------------------------------------------------------------
// PDC-0602: tamper-resistant fuzz (every byte of the unencrypted archive is
// authenticated or structurally constrained)
// ---------------------------------------------------------------------------

/// Byte-by-byte flipping: every mutation must be detected — either opening the
/// archive errors, or the opened content matches the original file-by-file
/// (silent acceptance of non-semantic bytes does not count as corruption, but any
/// content change must be rejected).
#[test]
fn archive_single_byte_mutation_never_silently_corrupts() {
    let dir = temp_dir("fuzz-mut");
    let path = write_small_archive(&dir, "orig.kdp");
    let original = std::fs::read(&path).unwrap();
    let pristine = Archive::open(&path, None).unwrap();
    let n = original.len();
    assert!(n > 100, "archive should have real frames, got {n} bytes");

    // Full-byte scan (small archive) + stepped sampling (fallback for large ones).
    let step = (n / 8192).max(1);
    let mut silently_corrupt = Vec::new();
    for i in (0..n).step_by(step) {
        let mut bytes = original.clone();
        bytes[i] ^= 0xFF;
        let mpath = dir.join("mut.kdp");
        std::fs::write(&mpath, &bytes).unwrap();
        match Archive::open(&mpath, None) {
            Err(_) => {}
            Ok(mutated) => {
                // The archive opened: must match the original per logical file
                // (otherwise it is a silent semantic change).
                for f in mutated.meta().files.iter() {
                    if mutated.file(f) != pristine.file(f) {
                        silently_corrupt.push((i, f.clone()));
                    }
                }
            }
        }
    }
    assert!(
        silently_corrupt.is_empty(),
        "{} silent content-changing mutations at bytes {:?}",
        silently_corrupt.len(),
        silently_corrupt
    );
}

/// Length-by-length truncation: no byte string shorter than the original may
/// open.
#[test]
fn archive_truncation_never_opens() {
    let dir = temp_dir("fuzz-trunc");
    let path = write_small_archive(&dir, "orig.kdp");
    let original = std::fs::read(&path).unwrap();
    let n = original.len();
    assert!(Archive::open(&path, None).is_ok());

    // Scan every length.
    let mut opened = Vec::new();
    for len in 0..n {
        let tpath = dir.join("trunc.kdp");
        std::fs::write(&tpath, &original[..len]).unwrap();
        if Archive::open(&tpath, None).is_ok() {
            opened.push(len);
        }
    }
    assert!(
        opened.is_empty(),
        "truncated archive opened at lengths {opened:?}"
    );
}

/// Byte flipping inside a frame (payload area): always detected by frame-level
/// SHA or the manifest checksum.
#[test]
fn archive_payload_mutation_always_detected() {
    let dir = temp_dir("fuzz-payload");
    let path = write_small_archive(&dir, "orig.kdp");
    let original = std::fs::read(&path).unwrap();
    // Start after the header (the header is magic/version/flags, tested
    // separately); covers the whole payload and the frame headers.
    let mut opened = 0usize;
    for i in 42..original.len() {
        let mut bytes = original.clone();
        bytes[i] ^= 0x01;
        let mpath = dir.join("p.kdp");
        std::fs::write(&mpath, &bytes).unwrap();
        if Archive::open(&mpath, None).is_ok() {
            opened += 1;
        }
    }
    assert_eq!(
        opened, 0,
        "{} payload mutations opened successfully (must be authenticated)",
        opened
    );
}

// ---------------------------------------------------------------------------
// PDC-0602: deep nesting (parent chains) and cycles
// ---------------------------------------------------------------------------

/// A 1000-level parent chain: topological order length correct, parents before
/// children, no stack overflow.
#[test]
fn deep_parent_chain_orders_without_overflow() {
    let depth = 1000usize;
    let mut tables = Vec::new();
    for i in 0..depth {
        let parent = if i == 0 {
            None
        } else {
            Some(format!("tbl_C{}", i - 1))
        };
        tables.push(DerivedTable {
            name: format!("tbl_C{i}"),
            kind: if i == 0 { "root" } else { "array" }.into(),
            parent_table_name: parent,
            property_path: Some(format!("c{i}")),
            fields: vec![
                field("id", "bigint unsigned"),
                field("parentID", "bigint unsigned"),
            ],
        });
    }
    let schema = CloneSchema::new("C".into(), tables).unwrap();
    let graph = RelationGraph::build(&schema, &schema.tables).unwrap();
    let order = graph.topological_order(&schema);
    assert_eq!(order.len(), depth);
    // Root first; every child table must appear after its parent.
    assert_eq!(order[0], "tbl_C0");
    let mut pos = BTreeMap::new();
    for (idx, name) in order.iter().enumerate() {
        pos.insert(name.clone(), idx);
    }
    for i in 1..depth {
        let child = format!("tbl_C{i}");
        let parent = format!("tbl_C{}", i - 1);
        assert!(
            pos[&parent] < pos[&child],
            "parent {parent} must precede child {child}"
        );
    }
}

/// A deep cycle is still rejected (fail-closed), never silently output.
#[test]
fn deep_cycle_is_rejected() {
    let mut tables = Vec::new();
    // A→B→C→A cycle.
    for (i, name) in ["tbl_A", "tbl_B", "tbl_C"].iter().enumerate() {
        let parent = match i {
            0 => Some("tbl_C".to_string()),
            1 => Some("tbl_A".to_string()),
            _ => Some("tbl_B".to_string()),
        };
        tables.push(DerivedTable {
            name: name.to_string(),
            kind: if i == 0 { "root" } else { "array" }.into(),
            parent_table_name: parent,
            property_path: Some(format!("p{i}")),
            fields: vec![
                field("id", "bigint unsigned"),
                field("parentID", "bigint unsigned"),
            ],
        });
    }
    let schema = CloneSchema::new("A".into(), tables).unwrap();
    let err = RelationGraph::build(&schema, &schema.tables).unwrap_err();
    assert!(matches!(err, CloneError::CycleDetected(_)), "{err:?}");
}

// ---------------------------------------------------------------------------
// PDC-0603: scale (hundred-thousand-level child rows), budget, cancel, timeout
// ---------------------------------------------------------------------------

const SUB_ROWS: u64 = 100_000;

struct FakeExec {
    root_rows: Vec<Vec<Option<String>>>,
    sub_rows: Vec<Vec<Option<String>>>,
}

impl FakeExec {
    fn new(sub_rows: u64) -> Self {
        let mut sub = Vec::with_capacity(sub_rows as usize);
        for i in 0..sub_rows {
            sub.push(vec![
                Some(format!("{}", 1000 + i)),
                Some("7".into()),
                Some(format!("item{i}")),
            ]);
        }
        Self {
            root_rows: vec![vec![
                Some("7".into()),
                Some("0".into()),
                Some("Alice".into()),
            ]],
            sub_rows: sub,
        }
    }
}

impl ReadOnlyExecutor for FakeExec {
    fn query(
        &self,
        sql: &str,
        _params: &[SqlValue],
    ) -> kode_db_clone::CloneResult<Vec<Vec<Option<String>>>> {
        if sql.contains("tbl_Avatar_items") {
            Ok(self.sub_rows.clone())
        } else {
            Ok(self.root_rows.clone())
        }
    }
    fn execute(&self, _sql: &str) -> kode_db_clone::CloneResult<()> {
        Ok(())
    }
}

fn scale_plan() -> QueryPlan {
    QueryPlan {
        entity_name: "Avatar".into(),
        row_budget: u64::MAX,
        queries: vec![
            PlannedQuery {
                sequence: 0,
                table: "tbl_Avatar".into(),
                parent_table: None,
                filter: PlanFilter::RootId,
                columns: vec!["id".into(), "sm_autoLoad".into(), "sm_name".into()],
                column_types: vec![
                    "bigint unsigned".into(),
                    "tinyint".into(),
                    "varchar".into(),
                ],
                select_sql: "SELECT `id`, `sm_autoLoad`, `sm_name` FROM `tbl_Avatar` WHERE `id` = ?"
                    .into(),
                estimated_rows: Some(1),
            },
            PlannedQuery {
                sequence: 1,
                table: "tbl_Avatar_items".into(),
                parent_table: Some("tbl_Avatar".into()),
                filter: PlanFilter::ParentId,
                columns: vec!["id".into(), "parentID".into(), "sm_value".into()],
                column_types: vec![
                    "bigint unsigned".into(),
                    "bigint unsigned".into(),
                    "varchar".into(),
                ],
                select_sql: "SELECT `id`, `parentID`, `sm_value` FROM `tbl_Avatar_items` WHERE `parentID` = ?"
                    .into(),
                estimated_rows: Some(SUB_ROWS),
            },
        ],
        denied: vec![],
        missing: vec![],
        identity: None,
        estimated_rows_total: Some(1 + SUB_ROWS),
    }
}

#[derive(Default)]
struct CollectSink {
    rows: usize,
    counts: BTreeMap<String, u64>,
}

impl RowSink for CollectSink {
    fn write_row(&mut self, table: &str, row: &TypedRow) -> kode_db_clone::CloneResult<u64> {
        assert_eq!(row.table, table);
        self.rows += 1;
        Ok(serde_json::to_vec(row).unwrap().len() as u64)
    }
    fn end_table(&mut self, table: &str, count: u64) -> kode_db_clone::CloneResult<()> {
        self.counts.insert(table.to_string(), count);
        Ok(())
    }
}

/// Exporting a hundred-thousand-level child row count: full success, exact
/// counts, per-table row counts correct.
#[test]
fn large_subtable_exports_with_correct_counts() {
    let exec = FakeExec::new(SUB_ROWS);
    let reader = SourceReader::new(&exec);
    let mut sink = CollectSink::default();
    let out = reader
        .export(
            &scale_plan(),
            7,
            &mut sink,
            &ExportBudget::unlimited(),
            &ExportControl::new(),
        )
        .unwrap();
    assert!(!out.cancelled);
    assert_eq!(out.stats.total_rows, 1 + SUB_ROWS);
    assert_eq!(sink.rows, (1 + SUB_ROWS) as usize);
    assert_eq!(sink.counts["tbl_Avatar"], 1);
    assert_eq!(sink.counts["tbl_Avatar_items"], SUB_ROWS);
}

/// Row budget: exceeding it is BudgetExceeded (honest rejection, no silent
/// truncation).
#[test]
fn large_subtable_exceeding_row_budget_fails_closed() {
    let exec = FakeExec::new(SUB_ROWS);
    let reader = SourceReader::new(&exec);
    let mut sink = CollectSink::default();
    let budget = ExportBudget {
        max_rows: 10,
        max_bytes: u64::MAX,
        timeout: Duration::from_secs(3600),
    };
    let err = reader
        .export(&scale_plan(), 7, &mut sink, &budget, &ExportControl::new())
        .unwrap_err();
    assert!(
        matches!(err, CloneError::BudgetExceeded { limit: 10, .. }),
        "{err:?}"
    );
}

/// Pre-cancelled: the cancel flag takes effect before the first row →
/// cancelled=true, no success reported.
#[test]
fn pre_cancelled_export_reports_cancelled() {
    let exec = FakeExec::new(SUB_ROWS);
    let reader = SourceReader::new(&exec);
    let mut sink = CollectSink::default();
    let control = ExportControl::new();
    control.cancel();
    let out = reader
        .export(
            &scale_plan(),
            7,
            &mut sink,
            &ExportBudget::unlimited(),
            &control,
        )
        .unwrap();
    assert!(out.cancelled);
}

/// Zero timeout: a wall-clock timeout means cancelled=true.
#[test]
fn timed_out_export_reports_cancelled() {
    let exec = FakeExec::new(SUB_ROWS);
    let reader = SourceReader::new(&exec);
    let mut sink = CollectSink::default();
    let budget = ExportBudget {
        max_rows: u64::MAX,
        max_bytes: u64::MAX,
        timeout: Duration::ZERO,
    };
    let out = reader
        .export(&scale_plan(), 7, &mut sink, &budget, &ExportControl::new())
        .unwrap();
    assert!(out.cancelled);
}

// ---------------------------------------------------------------------------
// PDC-0605: cross-platform paths and key storage
// ---------------------------------------------------------------------------

/// A backslash is a legal Unix filename character; opening an archive must not
/// depend on directory-separator assumptions.
#[test]
fn archive_open_handles_backslash_in_name() {
    let dir = temp_dir("paths");
    let path = write_small_archive(&dir, "clone\\backup.kdp");
    let a = Archive::open(&path, None).unwrap();
    assert_eq!(a.meta().entity, "Avatar");
    assert_eq!(a.meta().total_rows, 1);
    let rows = a.table_rows("tbl_Avatar").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].values[0], TypedValue::BigUInt(7));
}

/// Dot-prefixed filenames (hidden / special names) can be written and opened.
#[test]
fn archive_open_handles_dotfile_name() {
    let dir = temp_dir("paths-dot");
    let path = write_small_archive(&dir, ".clone.kdp");
    let a = Archive::open(&path, None).unwrap();
    assert_eq!(a.meta().entity, "Avatar");
}

/// Relation-edge classification stays stable cross-platform (RelationKind labels
/// unchanged).
#[test]
fn relation_kind_label_is_stable() {
    assert_eq!(RelationKind::EngineGenerated.label(), "engine-generated");
    assert_eq!(RelationKind::ForeignKey.label(), "foreign-key");
    assert_eq!(RelationKind::ProjectDeclared.label(), "project-declared");
    assert_eq!(RelationKind::Unresolved.label(), "unresolved");
    assert_eq!(RelationKind::External.label(), "external");
}
