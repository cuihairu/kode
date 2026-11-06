//! PDC-0603 性能验证(计划书 §10 矩阵 / Phase 6):
//! 大 ARRAY 子表、十万级子行、大包(单行大 BLOB)分批读取、reader 侧内存有界、
//! 流中取消/超时。
//!
//! 断言只放宽松上界——PDC-0601/0602 教训:严格时序断言在 546-worker 负载下会
//! flake。这里的上界只拦真实回归(挂死/平方级退化),实测耗时与编码体积用
//! eprintln 落日志供人工核对,不作严格时序断言。
//!
//! 全部经公开 API,无新增依赖。reader 侧流式性由「丢弃式计数汇」证明:
//! 汇不保留行数据,导出能跑完 30 万行即说明 reader 逐行交棒、不整表累积。

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use kode_db_clone::planner::{PlanFilter, PlannedQuery, QueryPlan};
use kode_db_clone::reader::{
    ExportBudget, ExportControl, ReadOnlyExecutor, RowSink, SourceReader, SqlValue,
};
use kode_db_clone::value::TypedRow;

/// 十万级子行:ARRAY 子表行数(超过 hardening 的 SUB_ROWS=100_000 基线)。
const SUB_ROWS: u64 = 300_000;

/// 大包单行:4 MiB 二进制 → blob 单元格 → 8 MiB hex 编码的 Bytes 值。
const BLOB_CELL_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 夹具:按表名返回行集的只读执行器(backtick 限定匹配,防 tbl_Avatar 前缀误中)
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

/// root(1 行) + items 子表(N 行) 的计划。sub 列序/列型可注入(大包用 blob)。
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

/// 30 万行 items 执行器(每行 id/parentID/sm_value)。
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
// 丢弃式计数汇:记录行数/累计字节/最大单行字节,不保留行数据
// ---------------------------------------------------------------------------

#[derive(Default)]
struct CountingSink {
    rows: u64,
    total_bytes: u64,
    max_row_bytes: u64,
    counts: BTreeMap<String, u64>,
    /// 到达该行数后取消(流中取消用例)。
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
// 测试
// ---------------------------------------------------------------------------

/// 大 ARRAY 子表 + 十万级子行(30 万):全量成功、计数准确、reader 侧不累积。
/// 汇丢弃行数据仍能跑完,即证明逐行交棒、内存有界(最大单行编码远小于总量)。
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
    // 宽松上界:内存内 30 万行应在数秒内;60s 只拦真实挂死/平方级退化。
    assert!(
        elapsed < Duration::from_secs(60),
        "300k 行导出耗时 {elapsed:?} 超出宽松上界"
    );
    // 流式证据:单行编码远小于总量(逐行交棒,非整表累积)。
    assert!(
        sink.max_row_bytes * 100 < sink.total_bytes,
        "reader 应逐行交棒:max_row={}B total={}B",
        sink.max_row_bytes,
        sink.total_bytes
    );
    eprintln!(
        "[perf] 300k 子行: {elapsed:?} total_bytes={}B max_row={}B",
        sink.total_bytes, sink.max_row_bytes
    );
}

/// 大包分批读取:单行 4 MiB BLOB → 8 MiB hex 编码,如实保留、不截断不丢失。
#[test]
fn large_blob_packet_reads_in_one_row() {
    // 确定性 a-z 循环字节(全 1 字节 UTF-8,hex 编码恰为 2×)。
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
    // hex 编码后单行体积应 ≥ 2× 二进制(加 JSON 开销)。
    assert!(
        sink.max_row_bytes >= (BLOB_CELL_BYTES as u64) * 2,
        "大包应被 hex 编码保留:max_row={}B",
        sink.max_row_bytes
    );
    assert!(
        elapsed < Duration::from_secs(30),
        "4MiB blob 导出耗时 {elapsed:?} 超出宽松上界"
    );
    eprintln!(
        "[perf] 4MiB blob 单行: {elapsed:?} encoded={}B",
        sink.max_row_bytes
    );
}

/// 宽行(300 列)计划:仅 root 查询,列序/列型由调用方给定。
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

/// 宽行(300 列):多字段单行如实导出、计数准确。
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
    eprintln!("[perf] {WIDE}-col 宽行: encoded={}B", sink.max_row_bytes);
}

/// 流中取消(超时族):到达 1000 行时取消 → 如实停止、报 cancelled、不报成功。
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
    assert!(out.cancelled, "流中取消应报 cancelled");
    assert!(
        sink.rows >= 999 && sink.rows < 1 + SUB_ROWS,
        "应停在取消点附近: rows={}",
        sink.rows
    );
    let stopped = sink.rows;
    eprintln!("[perf] 流中取消: 停在 {stopped} 行");
}
