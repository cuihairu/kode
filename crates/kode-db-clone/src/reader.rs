//! 源库只读导出(PDC-0201/0202)。
//!
//! 接口层读写隔离:[`ReadOnlyExecutor`] 只暴露 `query`/`execute`(事务控制),
//! 无任何 DML 方法;执行前再经 [`validate_readonly`] 白名单(仅 SELECT/SHOW/
//! DESCRIBE/EXPLAIN + `SET SESSION TRANSACTION READ ONLY` + 事务控制),双层防线。
//!
//! 一致性:同一执行器/事务内按关系图 DFS 读主表与全部子表(避免主表读版本 A、
//! 子表读版本 B)。先 `SET SESSION TRANSACTION READ ONLY`,再尝试
//! `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`(MySQL 8 形态);
//! 驱动不支持该组合时回退 `START TRANSACTION WITH CONSISTENT SNAPSHOT`
//! (会话级只读已保证写隔离)——与计划 §5.2「在支持条件下使用,检查驱动行为」一致。
//!
//! 资源:行数/字节预算与墙钟超时在查询间检查,取消旗标(PDC-0202);
//! 超预算报错、取消/超时返回 `cancelled=true` 且调用方丢弃临时产物——诚实截断不伪完整。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{CloneError, CloneResult};
use crate::planner::QueryPlan;
use crate::value::{TypedRow, TypedValue};

/// 绑定参数(只读 SELECT 的 `?`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlValue {
    I64(i64),
    U64(u64),
    Str(String),
}

/// 只读语句面(PDC-0201):无 DML 方法;写路径仅事务控制语句。
pub trait ReadOnlyExecutor {
    /// 参数化查询(SELECT/SHOW/DESCRIBE/EXPLAIN),返回字符串单元格行。
    fn query(&self, sql: &str, params: &[SqlValue]) -> CloneResult<Vec<Vec<Option<String>>>>;
    /// 语句(事务控制),无结果集。
    fn execute(&self, sql: &str) -> CloneResult<()>;
}

/// 只读白名单校验(PDC-0201):非白名单语句一律拒绝(fail-closed)。
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

/// 导出预算(PDC-0202):行数/体积上限与墙钟超时。
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

/// 取消控制(跨线程/信号取消):查询间检查。
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

/// 行流式汇(PDC-0204):一次一行,不无上限累积。
pub trait RowSink {
    /// 写一行;返回该行编码体积(供字节预算记账)。
    fn write_row(&mut self, table: &str, row: &TypedRow) -> CloneResult<u64>;
    /// 表读完回调(逐表计数,供 manifest/校验)。
    fn end_table(&mut self, table: &str, count: u64) -> CloneResult<()>;
}

/// 导出结果:成功或取消(取消时部分行可能已进汇,调用方决定丢弃)。
#[derive(Debug)]
pub struct ExportOutcome {
    pub stats: ExportStats,
    pub cancelled: bool,
}

/// 逐表/总量统计。
#[derive(Debug, Clone, Default)]
pub struct ExportStats {
    pub per_table: BTreeMap<String, u64>,
    pub total_rows: u64,
    pub total_bytes: u64,
    pub duration: Duration,
}

/// 源库只读导出器。
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

    /// 执行计划:单事务内按关系图 DFS 读根表+全部子表(父先子后)。
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

        // 只读会话 + 一致性快照事务(带回退)。
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
                children.entry(parent.clone()).or_default().push(q.table.clone());
            }
        }
        let root = plan
            .queries
            .first()
            .ok_or_else(|| CloneError::UnknownTable("plan has no root query".into()))?
            .table
            .clone();

        let result = self.walk(plan, &root, root_id, &children, sink, budget, control, started, &mut stats);
        match result {
            Ok(cancelled) => {
                let _ = self.executor.execute(if cancelled { "ROLLBACK" } else { "COMMIT" });
                stats.duration = started.elapsed();
                Ok(ExportOutcome { stats, cancelled })
            }
            Err(e) => {
                // 任何错误路径:回滚(保证事务不悬挂),错误信息经日志脱敏由调用方处理。
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
        let rows = self.executor.query(&query.select_sql, std::slice::from_ref(&param))?;
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
                    if self.walk(plan, kid, child_id, children, sink, budget, control, started, stats)? {
                        return Ok(true);
                    }
                }
            }
        }
        sink.end_table(table, count)?;
        Ok(control.is_cancelled() || started.elapsed() > budget.timeout)
    }

    /// 行 → 类型化行:按计划列序,列型用派生列型(PDC-0203 有类型编码)。
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

/// 行内 id 列(计划列序以 id 起头;缺失记 0——导入侧按 parentID 关系对账)。
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
    use std::cell::RefCell;
    use crate::planner::ExportPlanner;
    use crate::rules::RuleSet;
    use crate::schema::{CloneSchema, DerivedField, DerivedTable, PhysicalTable, SchemaResolver, SchemaSource, VirtualSchema};

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
            ("tbl_Avatar", vec![("id", "bigint unsigned"), ("sm_autoLoad", "tinyint"), ("sm_name", "varchar(255)")]),
            ("tbl_Avatar_items", vec![("id", "bigint unsigned"), ("parentID", "bigint unsigned"), ("sm_autoLoad", "tinyint"), ("sm_value", "varchar(255)")]),
            ("tbl_Avatar_items_mods", vec![("id", "bigint unsigned"), ("parentID", "bigint unsigned"), ("sm_autoLoad", "tinyint"), ("sm_value", "varchar(255)")]),
        ] {
            phys.tables.insert(
                name.to_string(),
                PhysicalTable {
                    name: name.to_string(),
                    engine: "InnoDB".into(),
                    columns: cols.iter().map(|(c, t)| ((*c).to_string(), (*t).to_string())).collect(),
                    primary_key: vec!["id".into()],
                    indexes: vec![],
                },
            );
        }
        let resolved = SchemaResolver::resolve(&schema, &phys).unwrap();
        let plan = ExportPlanner::new(10_000).plan(&schema, &resolved, &RuleSet::default(), None).unwrap();
        (plan, schema)
    }

    /// 内存执行器:记录语句与参数,断言零 DML。
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
            Self { rows, statements: RefCell::new(vec![]), selects: RefCell::new(vec![]), commits: RefCell::new(0), rollbacks: RefCell::new(0), fail_combined_start: RefCell::new(false) }
        }
        fn write_count(&self) -> usize {
            self.statements.borrow().iter().filter(|s| {
                let w = s.trim_start().to_ascii_uppercase();
                w.starts_with("INSERT") || w.starts_with("UPDATE") || w.starts_with("DELETE") || w.starts_with("DROP") || w.starts_with("ALTER") || w.starts_with("CREATE")
            }).count()
        }
    }

    impl ReadOnlyExecutor for FakeExecutor {
        fn query(&self, sql: &str, params: &[SqlValue]) -> CloneResult<Vec<Vec<Option<String>>>> {
            self.selects.borrow_mut().push((sql.to_string(), params.to_vec()));
            let table = sql.split("FROM `").nth(1).and_then(|s| s.split('`').next()).unwrap_or("").to_string();
            // 按绑定参数过滤行(模拟真实 `?` 语义):任一单元格等于参数值即保留。
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
                        row.iter().any(|cell| cell.as_deref() == Some(want.as_str()))
                    })
                })
                .collect();
            Ok(filtered)
        }
        fn execute(&self, sql: &str) -> CloneResult<()> {
            let w = sql.trim_start().to_ascii_uppercase();
            if w.starts_with("COMMIT") { *self.commits.borrow_mut() += 1; }
            if w.starts_with("ROLLBACK") { *self.rollbacks.borrow_mut() += 1; }
            if *self.fail_combined_start.borrow() && w.starts_with("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY") {
                return Err(CloneError::UnsupportedDbInterface("combined form unsupported".into()));
            }
            self.statements.borrow_mut().push(sql.to_string());
            Ok(())
        }
    }

    /// 收集型行汇。
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
            ("tbl_Avatar".to_string(), vec![vec![Some("100".into()), Some("0".into()), Some("Alice".into())]]),
            ("tbl_Avatar_items".to_string(), vec![vec![Some("1001".into()), Some("100".into()), Some("0".into()), Some("sword".into())], vec![Some("1002".into()), Some("100".into()), Some("0".into()), Some("shield".into())]]),
            ("tbl_Avatar_items_mods".to_string(), vec![vec![Some("9001".into()), Some("1001".into()), Some("0".into()), Some("sharp".into())]]),
        ]);
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink { rows: vec![], counts: BTreeMap::new() };
        let out = reader.export(&plan, 100, &mut sink, &ExportBudget::unlimited(), &ExportControl::new()).unwrap();
        assert!(!out.cancelled);
        assert_eq!(out.stats.total_rows, 4);
        assert_eq!(out.stats.per_table["tbl_Avatar_items"], 2);
        assert_eq!(out.stats.per_table["tbl_Avatar_items_mods"], 1);
        // 读序:根先,子后(DFS)。
        assert_eq!(sink.rows[0].values[2], TypedValue::Text("Alice".into()));
        assert_eq!(exec.write_count(), 0, "零 DML 语句");
        assert_eq!(*exec.commits.borrow(), 1);
        assert_eq!(*exec.rollbacks.borrow(), 0);
        // 全部 SQL 过白名单。
        for s in exec.statements.borrow().iter() {
            validate_readonly(s).unwrap();
        }
        for (sql, _) in exec.selects.borrow().iter() {
            validate_readonly(sql).unwrap();
        }
    }

    #[test]
    fn validate_readonly_refuses_dml() {
        for bad in ["INSERT INTO t VALUES (1)", "UPDATE t SET x=1", "DELETE FROM t", "DROP TABLE t", "ALTER TABLE t ADD c int", "CREATE TABLE t (id int)"] {
            assert!(validate_readonly(bad).is_err(), "refuse: {bad}");
        }
        for good in ["SELECT 1", "SHOW TABLES", "DESCRIBE t", "EXPLAIN SELECT 1", "SET SESSION TRANSACTION READ ONLY", "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", "COMMIT", "ROLLBACK"] {
            assert!(validate_readonly(good).is_ok(), "allow: {good}");
        }
    }

    #[test]
    fn budget_exceeded_rolls_back() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([
            ("tbl_Avatar".to_string(), vec![vec![Some("100".into()), Some("0".into()), Some("Alice".into())]]),
            ("tbl_Avatar_items".to_string(), vec![vec![Some("1001".into()), Some("100".into()), Some("0".into()), Some("sword".into())]]),
        ]);
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink { rows: vec![], counts: BTreeMap::new() };
        let budget = ExportBudget { max_rows: 1, max_bytes: u64::MAX, timeout: Duration::from_secs(10) };
        let err = reader.export(&plan, 100, &mut sink, &budget, &ExportControl::new()).unwrap_err();
        assert!(matches!(err, CloneError::BudgetExceeded { .. }));
        assert_eq!(*exec.rollbacks.borrow(), 1, "预算超限必须回滚");
        assert_eq!(*exec.commits.borrow(), 0);
    }

    #[test]
    fn cancel_returns_cancelled_and_rolls_back() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([
            ("tbl_Avatar".to_string(), vec![vec![Some("100".into()), Some("0".into()), Some("Alice".into())]]),
            ("tbl_Avatar_items".to_string(), vec![vec![Some("1001".into()), Some("100".into()), Some("0".into()), Some("sword".into())]]),
        ]);
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink { rows: vec![], counts: BTreeMap::new() };
        let control = ExportControl::new();
        control.cancel();
        let out = reader.export(&plan, 100, &mut sink, &ExportBudget::unlimited(), &control).unwrap();
        assert!(out.cancelled);
        assert_eq!(*exec.rollbacks.borrow(), 1, "取消必须回滚");
        assert_eq!(*exec.commits.borrow(), 0);
    }

    #[test]
    fn combined_start_falls_back_to_plain_snapshot() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([("tbl_Avatar".to_string(), vec![vec![Some("100".into()), Some("0".into()), Some("Alice".into())]])]);
        let exec = FakeExecutor::new(rows);
        *exec.fail_combined_start.borrow_mut() = true;
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink { rows: vec![], counts: BTreeMap::new() };
        let out = reader.export(&plan, 100, &mut sink, &ExportBudget::unlimited(), &ExportControl::new()).unwrap();
        assert!(!out.cancelled);
        assert!(exec.statements.borrow().iter().any(|s| s == "START TRANSACTION WITH CONSISTENT SNAPSHOT"), "回退到非组合形态");
    }

    #[test]
    fn row_arity_mismatch_is_drift_error() {
        let (plan, _schema) = fixture();
        let rows = BTreeMap::from([("tbl_Avatar".to_string(), vec![vec![Some("100".into()), Some("0".into())]])]); // 3 列计划,2 值
        let exec = FakeExecutor::new(rows);
        let reader = SourceReader::new(&exec);
        let mut sink = CollectSink { rows: vec![], counts: BTreeMap::new() };
        let err = reader.export(&plan, 100, &mut sink, &ExportBudget::unlimited(), &ExportControl::new()).unwrap_err();
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
}
