//! PDC-0604 安全验证(计划书 §6.1 门槛 / Phase 6):prod→prod 拒绝、源账号写权限
//! 拒绝、SQL 注入标识符中和、敏感值不泄漏进导出。
//!
//! 机制在 src/ 已有单测(target.rs/reader.rs/planner.rs/redact.rs),本文件从
//! 「公开 API 边界」再证 fail-closed:更广的注入载荷(反引号+分号+注释)、
//! reader→RedactingSink 端到端不泄漏。全部经公开接口,无新增依赖。

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
// 1. prod→prod 拒绝:导入目标环境只认 local/test,prod/staging 在解析层即拒。
// ---------------------------------------------------------------------------

#[test]
fn prod_and_staging_import_targets_fail_closed() {
    // 环境枚举无 prod/staging 变体,唯一成形态是 FromStr 解析;解析层拒绝即
    // prod 目标永远无法构造 → prod→prod 克隆不可能成形。
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
            "`{bad}` 必须 ImportRejected"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. 源账号写权限拒绝:非只读语句一律 fail-closed。
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
        assert!(validate_readonly(bad).is_err(), "写语句必须被拒: {bad}");
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
        assert!(validate_readonly(good).is_ok(), "只读语句应放行: {good}");
    }
}

// ---------------------------------------------------------------------------
// 3. SQL 注入:标识符(表/列)含反引号+分号+注释载荷 → render_select 反引号
//    转义,生成的 SELECT 是单一安全语句,无反引号外逃逸字符。
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

/// 扫描 SQL,断言反引号引号段之外的字符不含语句逃逸载体(`;`、`'`、`"`、
/// `--`、换行)。反引号内 ` `` ` 是转义的反引号,不断言。
fn assert_no_breakout(sql: &str) {
    let mut in_backtick = false;
    let mut chars = sql.chars().peekable();
    let mut outside = String::new();
    while let Some(c) = chars.next() {
        if c == '`' {
            if in_backtick && chars.peek() == Some(&'`') {
                // ```` → 转义的反引号,留在引号段内。
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
    assert!(!in_backtick, "反引号未闭合: {sql}");
    for ch in outside.chars() {
        assert!(
            ch != ';' && ch != '\'' && ch != '"' && ch != '\n' && ch != '\r',
            "引号段外出现逃逸载体 `{ch}`: {sql}"
        );
    }
    assert!(!outside.contains("--"), "引号段外出现注释 `--`: {sql}");
}

#[test]
fn sql_injection_identifiers_neutralized() {
    // 表/列名内嵌注入载荷:反引号(需 ```` 转义)、分号(语句逃逸)、注释。
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
    // 反引号转义:单 ` 都成 ````。
    assert!(sql.contains("tbl_Avatar``"), "表名反引号转义: {sql}");
    assert!(sql.contains("id``"), "列名反引号转义: {sql}");
    // 无语句逃逸:反引号外无 `;`/`--`/引号/换行。
    assert_no_breakout(sql);
    assert!(sql.contains("WHERE `id` = ?"), "谓词参数化绑定: {sql}");
}

// ---------------------------------------------------------------------------
// 4. 防秘密泄漏:敏感列(credential/personal)经 reader→RedactingSink 端到端
//    掩码,捕获输出无原始秘密,报告如实记录。
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
    // 报告在 redacting 借用结束前取出(避免 capture 双重借用)。
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
    // 泄漏检查:捕获到的任何行值不得含原始秘密/个人邮箱原文。
    for row in &capture.rows {
        let encoded = serde_json::to_vec(row).unwrap();
        assert!(
            !encoded.windows(b"hunter2".len()).any(|w| w == b"hunter2"),
            "密码原文泄漏: {encoded:?}"
        );
        assert!(
            !encoded
                .windows(b"alice@example.com".len())
                .any(|w| w == b"alice@example.com"),
            "邮箱原文泄漏: {encoded:?}"
        );
    }
    // 报告如实记录敏感列,不含公开列。
    let cols: BTreeMap<_, _> = report
        .entries
        .iter()
        .map(|e| (e.column.as_str(), e.sensitivity.as_str()))
        .collect();
    assert_eq!(cols.get("sm_password"), Some(&"credential"));
    assert_eq!(cols.get("email"), Some(&"personal"));
    assert_eq!(cols.get("sm_name"), None, "公开列不进报告");
    assert_eq!(cols.get("id"), None, "id 不进报告");
}
