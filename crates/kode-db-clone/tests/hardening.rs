//! CLONE-P6 硬化测试(计划书 §10 矩阵收口 / Phase 6 PDC-0602/0603/0605):
//! 抗篡改 fuzz、深层嵌套、规模预算/取消/超时、跨平台路径。
//!
//! 全部经公开 API、无新增依赖(PDC-0601 真实 MySQL 属 mysql_real.rs,
//! 独立门控)。断言面向「绝不静默接受损坏」而非「特定错误文案」,
//! 以便任一帧布局变更都能被本套件捕获。

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
// 夹具助手
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

/// 写一个最小归档(Avatar 根 + 1 行),返回路径。
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
// PDC-0602:抗篡改 fuzz(无加密档的每一字节都被认证或结构性约束)
// ---------------------------------------------------------------------------

/// 逐字节翻转:任一变位都必须被检出——或开档报错,或开出的内容与原件
/// 逐文件一致(非语义字节的静默接受不构成损坏,但任何内容变化必须被拒)。
#[test]
fn archive_single_byte_mutation_never_silently_corrupts() {
    let dir = temp_dir("fuzz-mut");
    let path = write_small_archive(&dir, "orig.kdp");
    let original = std::fs::read(&path).unwrap();
    let pristine = Archive::open(&path, None).unwrap();
    let n = original.len();
    assert!(n > 100, "archive should have real frames, got {n} bytes");

    // 全字节扫描(小档) + 步进采样(大档兜底)。
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
                // 开档成功:必须与原件逐逻辑文件一致(否则是静默语义变化)。
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

/// 逐长度截断:任何短于原件的字节串都不能开档。
#[test]
fn archive_truncation_never_opens() {
    let dir = temp_dir("fuzz-trunc");
    let path = write_small_archive(&dir, "orig.kdp");
    let original = std::fs::read(&path).unwrap();
    let n = original.len();
    assert!(Archive::open(&path, None).is_ok());

    // 全长度扫描。
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

/// 帧内字节翻转(载荷区):必然被帧级 SHA 或清单校验和检出。
#[test]
fn archive_payload_mutation_always_detected() {
    let dir = temp_dir("fuzz-payload");
    let path = write_small_archive(&dir, "orig.kdp");
    let original = std::fs::read(&path).unwrap();
    // 从头部之后开始(头部是魔数/版本/旗标,另测);覆盖全部载荷与帧头。
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
// PDC-0602:深层嵌套(父链)与环
// ---------------------------------------------------------------------------

/// 1000 层父链:拓扑序长度正确、父先子后、不爆栈。
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
    // 根在前;每个子表必须出现在其父之后。
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

/// 深层环仍被拒(fail-closed),不静默输出。
#[test]
fn deep_cycle_is_rejected() {
    let mut tables = Vec::new();
    // A→B→C→A 环。
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
// PDC-0603:规模(十万级子行)、预算、取消、超时
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
            root_rows: vec![vec![Some("7".into()), Some("0".into()), Some("Alice".into())]],
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

/// 十万级子行导出:全量成功、计数准确、逐表行数正确。
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

/// 行预算:超限即 BudgetExceeded(诚实拒绝,不静默截断)。
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
    assert!(matches!(err, CloneError::BudgetExceeded { limit: 10, .. }), "{err:?}");
}

/// 预取消:取消旗标在首行前即生效 → cancelled=true,不报成功。
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

/// 零超时:墙钟超时即 cancelled=true。
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
// PDC-0605:跨平台路径与密钥存储
// ---------------------------------------------------------------------------

/// 反斜杠是 Unix 合法文件名字符;归档打开不得依赖目录分隔符假设。
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

/// 点前缀文件名(隐藏/特殊名)可写可开。
#[test]
fn archive_open_handles_dotfile_name() {
    let dir = temp_dir("paths-dot");
    let path = write_small_archive(&dir, ".clone.kdp");
    let a = Archive::open(&path, None).unwrap();
    assert_eq!(a.meta().entity, "Avatar");
}

/// 关系边分类在跨平台下保持稳定(RelationKind 标签不变)。
#[test]
fn relation_kind_label_is_stable() {
    assert_eq!(RelationKind::EngineGenerated.label(), "engine-generated");
    assert_eq!(RelationKind::ForeignKey.label(), "foreign-key");
    assert_eq!(RelationKind::ProjectDeclared.label(), "project-declared");
    assert_eq!(RelationKind::Unresolved.label(), "unresolved");
    assert_eq!(RelationKind::External.label(), "external");
}
