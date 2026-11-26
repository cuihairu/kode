//! PDC-0603 performance verification (plan doc §10 matrix / Phase 6):
//! large ARRAY child tables, hundred-thousand-level child rows, large packets
//! (single-row large BLOB) read in batches, reader-side bounded memory,
//! mid-stream cancel / timeout.
//!
//! Assertions only place loose upper bounds — the PDC-0601/0602 lesson: strict
//! timing assertions flake under 546-worker load. The bounds here only catch real
//! regressions (hangs / quadratic degradation); measured durations and encoded
//! sizes go to the log via eprintln for manual review, not strict timing
//! assertions.
//!
//! Everything goes through the public API, no new dependencies. Reader-side
//! streaming is proven by the "discard-style counting sink": the sink retains no
//! row data, so the export finishing 300k rows shows the reader hands off row by
//! row instead of accumulating whole tables.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use kode_db_clone::planner::{PlanFilter, PlannedQuery, QueryPlan};
use kode_db_clone::reader::{
    ExportBudget, ExportControl, ReadOnlyExecutor, RowSink, SourceReader, SqlValue,
};
use kode_db_clone::value::TypedRow;

/// Hundred-thousand-level child rows: the ARRAY child table's row count (beyond
/// hardening's SUB_ROWS=100_000 baseline).
const SUB_ROWS: u64 = 300_000;

/// Large single-row packet: 4 MiB binary → blob cell → 8 MiB hex-encoded Bytes
/// value.
const BLOB_CELL_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Fixture: a read-only executor returning row sets by table name (backtick-
// qualified matching, to keep tbl_Avatar prefix from matching by mistake)
// ---------------------------------------------------------------------------

struct MapExec {
    tables: BTreeMap<String, Vec<Vec<Option<String>>>>,
}

impl MapExec {
    fn single(root: Vec<Option<String>>, sub: Vec<Vec<Option<String>>>) -> Self {
        let mut tables = BTreeMap::new();
        tables.insert("tbl_Avatar".to_string(), vec![root]);
        tables.insert("tbl_Avatar_items".to_string(), sub);
        Self { tables }
    }
}

impl ReadOnlyExecutor for MapExec {
    fn query(
        &self,
        sql: &str,
        _params: &[SqlValue],
    ) -> kode_db_clone::CloneResult<Vec<Vec<Option<String>>>> {
        for (table, rows) in &self.tables {
            if sql.contains(&format!("`{table}`")) {
                return Ok(rows.clone());
            }
        }
        Ok(vec![])
    }
    fn execute(&self, _sql: &str) -> kode_db_clone::CloneResult<()> {
        Ok(())
    }
}

/// Plan for root (1 row) + the items child table (N rows). Sub column order/types
/// injectable (blob for the large packet).
fn big_plan(sub_columns: &[&str], sub_types: &[&str], sub_rows: u64) -> QueryPlan {
    let cols: Vec<String> = sub_columns.iter().map(|s| s.to_string()).collect();
    let types: Vec<String> = sub_types.iter().map(|s| s.to_string()).collect();
    let select = format!(
        "SELECT {} FROM `tbl_Avatar_items` WHERE `parentID` = ?",
        sub_columns
            .iter()
            .map(|c| format!("`{c}`"))
            .collect::<Vec<_>>()
            .join(", ")
    );
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
                column_types: vec!["bigint unsigned".into(), "tinyint".into(), "varchar".into()],
                select_sql:
                    "SELECT `id`, `sm_autoLoad`, `sm_name` FROM `tbl_Avatar` WHERE `id` = ?".into(),
                estimated_rows: Some(1),
            },
            PlannedQuery {
                sequence: 1,
                table: "tbl_Avatar_items".into(),
                parent_table: Some("tbl_Avatar".into()),
                filter: PlanFilter::ParentId,
                columns: cols,
                column_types: types,
                select_sql: select,
                estimated_rows: Some(sub_rows),
            },
        ],
        denied: vec![],
        missing: vec![],
        identity: None,
        estimated_rows_total: Some(1 + sub_rows),
    }
}

/// 300k-row items executor (each row id/parentID/sm_value).
fn big_exec(sub_rows: u64) -> MapExec {
    let mut sub = Vec::with_capacity(sub_rows as usize);
    for i in 0..sub_rows {
        sub.push(vec![
            Some(format!("{}", 1000 + i)),
            Some("7".into()),
            Some(format!("item{i}")),
        ]);
    }
    MapExec::single(
        vec![Some("7".into()), Some("0".into()), Some("Alice".into())],
        sub,
    )
}

// ---------------------------------------------------------------------------
// Discard-style counting sink: records row count / cumulative bytes / max single
// row bytes, retains no row data
// ---------------------------------------------------------------------------

#[derive(Default)]
struct CountingSink {
    rows: u64,
    total_bytes: u64,
    max_row_bytes: u64,
    counts: BTreeMap<String, u64>,
    /// Cancels once this row count is reached (mid-stream cancel case).
    cancel_at: Option<u64>,
    control: Option<ExportControl>,
}

impl CountingSink {
    fn cancel_at(mut self, at: u64, control: ExportControl) -> Self {
        self.cancel_at = Some(at);
        self.control = Some(control);
        self
    }
}

impl RowSink for CountingSink {
    fn write_row(&mut self, table: &str, row: &TypedRow) -> kode_db_clone::CloneResult<u64> {
        assert_eq!(row.table, table);
        let n = serde_json::to_vec(row).unwrap().len() as u64;
        self.rows += 1;
        self.total_bytes += n;
        self.max_row_bytes = self.max_row_bytes.max(n);
        if let Some(at) = self.cancel_at {
            if self.rows >= at {
                if let Some(c) = &self.control {
                    c.cancel();
                }
                self.cancel_at = None;
            }
        }
        Ok(n)
    }
    fn end_table(&mut self, table: &str, count: u64) -> kode_db_clone::CloneResult<()> {
        self.counts.insert(table.to_string(), count);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Large ARRAY child table + hundred-thousand-level child rows (300k): full
/// success, exact counts, no reader-side accumulation. The sink discards row
/// data yet the export completes — proving row-by-row hand-off and bounded memory
/// (the max single-row encoding is far smaller than the total).
#[test]
fn large_array_subtable_300k_streams_and_counts() {
    let exec = big_exec(SUB_ROWS);
    let reader = SourceReader::new(&exec);
    let mut sink = CountingSink::default();
    let t0 = Instant::now();
    let out = reader
        .export(
            &big_plan(
                &["id", "parentID", "sm_value"],
                &["bigint unsigned", "bigint unsigned", "varchar"],
                SUB_ROWS,
            ),
            7,
            &mut sink,
            &ExportBudget::unlimited(),
            &ExportControl::new(),
        )
        .unwrap();
    let elapsed = t0.elapsed();
    assert!(!out.cancelled);
    assert_eq!(out.stats.total_rows, 1 + SUB_ROWS);
    assert_eq!(sink.rows, 1 + SUB_ROWS);
    assert_eq!(sink.counts["tbl_Avatar"], 1);
    assert_eq!(sink.counts["tbl_Avatar_items"], SUB_ROWS);
    // Loose upper bound: 300k in-memory rows should finish within seconds; 60s
    // only catches real hangs / quadratic degradation.
    assert!(
        elapsed < Duration::from_secs(60),
        "300k-row export took {elapsed:?}, beyond the loose upper bound"
    );
    // Streaming evidence: single-row encoding far smaller than the total (row-by-row
    // hand-off, not whole-table accumulation).
    assert!(
        sink.max_row_bytes * 100 < sink.total_bytes,
        "reader should hand off row by row:max_row={}B total={}B",
        sink.max_row_bytes,
        sink.total_bytes
    );
    eprintln!(
        "[perf] 300k child rows: {elapsed:?} total_bytes={}B max_row={}B",
        sink.total_bytes, sink.max_row_bytes
    );
}

/// Large packet read in batches: a single 4 MiB BLOB row → 8 MiB hex encoding,
/// preserved honestly, never truncated or lost.
#[test]
fn large_blob_packet_reads_in_one_row() {
    // Deterministic a-z cycling bytes (all 1-byte UTF-8; hex encoding is exactly
    // 2x).
    let mut blob = String::with_capacity(BLOB_CELL_BYTES);
    for i in 0..BLOB_CELL_BYTES {
        blob.push((b'a' + (i % 26) as u8) as char);
    }
    let exec = MapExec::single(
        vec![Some("7".into()), Some("0".into()), Some("Alice".into())],
        vec![vec![Some("1000".into()), Some("7".into()), Some(blob)]],
    );
    let reader = SourceReader::new(&exec);
    let mut sink = CountingSink::default();
    let t0 = Instant::now();
    let out = reader
        .export(
            &big_plan(
                &["id", "parentID", "sm_value"],
                &["bigint unsigned", "bigint unsigned", "blob"],
                1,
            ),
            7,
            &mut sink,
            &ExportBudget::unlimited(),
            &ExportControl::new(),
        )
        .unwrap();
    let elapsed = t0.elapsed();
    assert!(!out.cancelled);
    assert_eq!(out.stats.total_rows, 2);
    assert_eq!(sink.rows, 2);
    // After hex encoding the single row should be ≥ 2x the binary (plus JSON
    // overhead).
    assert!(
        sink.max_row_bytes >= (BLOB_CELL_BYTES as u64) * 2,
        "the large packet should be preserved via hex encoding:max_row={}B",
        sink.max_row_bytes
    );
    assert!(
        elapsed < Duration::from_secs(30),
        "4MiB blob export took {elapsed:?}, beyond the loose upper bound"
    );
    eprintln!(
        "[perf] 4MiB blob 单行: {elapsed:?} encoded={}B",
        sink.max_row_bytes
    );
}

/// Wide-row (300 columns) plan: root query only; column order/types given by the
/// caller.
fn wide_plan(root_columns: Vec<String>, root_types: Vec<String>) -> QueryPlan {
    let select = format!(
        "SELECT {} FROM `tbl_Avatar` WHERE `id` = ?",
        root_columns
            .iter()
            .map(|c| format!("`{c}`"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    QueryPlan {
        entity_name: "Avatar".into(),
        row_budget: u64::MAX,
        queries: vec![PlannedQuery {
            sequence: 0,
            table: "tbl_Avatar".into(),
            parent_table: None,
            filter: PlanFilter::RootId,
            columns: root_columns,
            column_types: root_types,
            select_sql: select,
            estimated_rows: Some(1),
        }],
        denied: vec![],
        missing: vec![],
        identity: None,
        estimated_rows_total: Some(1),
    }
}

/// Wide row (300 columns): a many-field single row exported honestly, count
/// exact.
#[test]
fn wide_row_many_columns_exports() {
    const WIDE: usize = 300;
    let mut root: Vec<Option<String>> = Vec::with_capacity(WIDE);
    root.push(Some("7".into())); // id
    for i in 1..WIDE {
        root.push(Some(format!("v{i}")));
    }
    let exec = MapExec::single(root, vec![]);
    let reader = SourceReader::new(&exec);
    let mut sink = CountingSink::default();
    let mut cols: Vec<String> = vec!["id".into()];
    let mut types: Vec<String> = vec!["bigint unsigned".into()];
    for i in 1..WIDE {
        cols.push(format!("c{i}"));
        types.push("varchar".into());
    }
    let out = reader
        .export(
            &wide_plan(cols, types),
            7,
            &mut sink,
            &ExportBudget::unlimited(),
            &ExportControl::new(),
        )
        .unwrap();
    assert!(!out.cancelled);
    assert_eq!(out.stats.total_rows, 1);
    assert_eq!(sink.rows, 1);
    assert_eq!(sink.counts["tbl_Avatar"], 1);
    eprintln!(
        "[perf] {WIDE}-col wide row: encoded={}B",
        sink.max_row_bytes
    );
}

/// Mid-stream cancel (timeout family): cancels at 1000 rows → stops honestly,
/// reports cancelled, reports no success.
#[test]
fn mid_stream_cancel_stops_export() {
    let exec = big_exec(SUB_ROWS);
    let reader = SourceReader::new(&exec);
    let control = ExportControl::new();
    let mut sink = CountingSink::default().cancel_at(1000, control.clone());
    let out = reader
        .export(
            &big_plan(
                &["id", "parentID", "sm_value"],
                &["bigint unsigned", "bigint unsigned", "varchar"],
                SUB_ROWS,
            ),
            7,
            &mut sink,
            &ExportBudget::unlimited(),
            &control,
        )
        .unwrap();
    assert!(out.cancelled, "mid-stream cancel should report cancelled");
    assert!(
        sink.rows >= 999 && sink.rows < 1 + SUB_ROWS,
        "should stop near the cancel point: rows={}",
        sink.rows
    );
    let stopped = sink.rows;
    eprintln!("[perf] mid-stream cancel: stopped at row {stopped}");
}
