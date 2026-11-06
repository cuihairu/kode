//! PDC-0601:testcontainers/MySQL 真实集成测试(差异版本组合)。
//!
//! 用真实 MySQL 容器验证 crate 核心对真实数据库语义的适配:information_schema
//! 解析、只读导出、事务导入(真实 AUTO_INCREMENT / 一致性快照 / 回滚)端到端。
//!
//! 门控:`#[ignore]` + 环境变量 `KODE_DB_CLONE_MYSQL=1`(需 Docker)。默认
//! `cargo test` 不运行(dev-deps 仅在显式启用时生效);运行方式:
//! `KODE_DB_CLONE_MYSQL=1 cargo test -p kode-db-clone --test mysql_real -- --ignored --nocapture`
//!
//! 库 crate 自身保持无 MySQL 驱动依赖(驱动仅此测试的 dev-dependency)。

use std::borrow::Cow;
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use kode_db_clone::apply::{
    ApplyControl, ApplyOutcome, ImportApplier, MemoryRunStore, WriteExecutor,
};
use kode_db_clone::archive::{relations_from_plan, write_archive, Archive};
use kode_db_clone::error::CloneError;
use kode_db_clone::import::{ImportOptions, ImportPlanner, TargetSnapshot};
use kode_db_clone::information_schema::InformationSchemaReader;
use kode_db_clone::planner::ExportPlanner;
use kode_db_clone::reader::{ExportBudget, ExportControl, ReadOnlyExecutor, SqlValue};
use kode_db_clone::redact::SensitivityPolicy;
use kode_db_clone::relations::Relation;
use kode_db_clone::schema::{
    CloneSchema, DerivedField, DerivedTable, SchemaResolver, SchemaSource,
};
use kode_db_clone::target::{TargetEnvironment, TargetProfile};
use kode_db_clone::value::{hex_decode, TypedValue};
use kode_db_clone::RuleSet;
use mysql::prelude::Queryable;
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::SyncRunner;
use testcontainers::{Image, ImageExt};

// ---------------------------------------------------------------------------
// KBEngine 派生 DDL(source-evidence §3/§4):Avatar 主表 + ARRAY 子表 + 组件子表。
// 列型/主键/索引按 ETM.cpp 事实;列序与 golden_apply avatar_derived 对齐,
// 使物理↔派生比较走同一判定。
// ---------------------------------------------------------------------------
const DDL: [&str; 3] = [
    "CREATE TABLE IF NOT EXISTS tbl_Avatar (\
       id bigint(20) unsigned NOT NULL AUTO_INCREMENT,\
       sm_autoLoad tinyint NOT NULL DEFAULT 0,\
       sm_name varchar(255) NOT NULL DEFAULT '',\
       PRIMARY KEY (id),\
       KEY sync_autoload_item_index (sm_autoLoad)\
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE IF NOT EXISTS tbl_Avatar_items (\
       id bigint(20) unsigned NOT NULL AUTO_INCREMENT,\
       parentID bigint(20) unsigned NOT NULL,\
       sm_value varchar(255) NOT NULL DEFAULT '',\
       PRIMARY KEY (id),\
       KEY parentID (parentID)\
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE IF NOT EXISTS tbl_Avatar_gold (\
       id bigint(20) unsigned NOT NULL AUTO_INCREMENT,\
       parentID bigint(20) unsigned NOT NULL,\
       sm_amount int NOT NULL DEFAULT 0,\
       PRIMARY KEY (id),\
       KEY parentID (parentID)\
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

/// 自实现 MySQL 镜像:testcontainers-modules 的 mysql 模块等待条件含
/// "X Plugin ready"(5.7 默认不装 X Plugin)且 mysqld 行带 /usr/sbin/ 前缀
/// (5.7 日志无前缀),两者对 5.7 永不满足 → StartupTimeout。故只用跨版本
/// 稳定且两者都出现的子串 "ready for connections"(stderr)作就绪条件。
#[derive(Debug, Clone)]
struct MysqlImage {
    tag: String,
}

impl Image for MysqlImage {
    fn name(&self) -> &str {
        "mysql"
    }
    fn tag(&self) -> &str {
        &self.tag
    }
    fn ready_conditions(&self) -> Vec<WaitFor> {
        vec![WaitFor::message_on_stderr("ready for connections")]
    }
    fn env_vars(
        &self,
    ) -> impl IntoIterator<Item = (impl Into<Cow<'_, str>>, impl Into<Cow<'_, str>>)> {
        [
            ("MYSQL_DATABASE", "test"),
            ("MYSQL_ALLOW_EMPTY_PASSWORD", "yes"),
        ]
    }
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

fn avatar_derived() -> CloneSchema {
    let root = DerivedTable {
        name: "tbl_Avatar".into(),
        kind: "root".into(),
        parent_table_name: None,
        property_path: Some("Avatar".into()),
        fields: vec![
            field("id", "bigint unsigned"),
            field("sm_autoLoad", "tinyint"),
            field("sm_name", "varchar"),
        ],
    };
    let items = DerivedTable {
        name: "tbl_Avatar_items".into(),
        kind: "array".into(),
        parent_table_name: Some("tbl_Avatar".into()),
        property_path: Some("items".into()),
        fields: vec![
            field("id", "bigint unsigned"),
            field("parentID", "bigint unsigned"),
            field("sm_value", "varchar"),
        ],
    };
    let gold = DerivedTable {
        name: "tbl_Avatar_gold".into(),
        kind: "component".into(),
        parent_table_name: Some("tbl_Avatar".into()),
        property_path: Some("gold".into()),
        fields: vec![
            field("id", "bigint unsigned"),
            field("parentID", "bigint unsigned"),
            field("sm_amount", "int"),
        ],
    };
    CloneSchema::new("Avatar".into(), vec![root, items, gold]).unwrap()
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kdp-mysql-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 把任一 mysql 值无损转成字符串面(与 crate 的字符串协议一致)。
/// NULL→None;Int/UInt/Float/Double→to_string;Bytes→UTF-8 lossy。
fn cell_string(row: &mysql::Row, i: usize) -> Option<String> {
    use mysql::Value;
    let v: Value = row.get::<Value, usize>(i).unwrap_or(Value::NULL);
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(&b).into_owned()),
        Value::Int(n) => Some(n.to_string()),
        Value::UInt(n) => Some(n.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, m, d, hh, mm, ss, us) => Some(format!(
            "{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}.{us:06}"
        )),
        Value::Time(neg, days, hh, mm, ss, us) => {
            let sign = if neg { "-" } else { "" };
            Some(format!("{sign}{days} {hh:02}:{mm:02}:{ss:02}.{us:06}"))
        }
    }
}

fn to_mysql_params(params: &[SqlValue]) -> Vec<mysql::Value> {
    params
        .iter()
        .map(|v| match v {
            SqlValue::I64(x) => mysql::Value::Int(*x),
            SqlValue::U64(x) => mysql::Value::UInt(*x),
            SqlValue::Str(s) => mysql::Value::Bytes(s.clone().into_bytes()),
        })
        .collect()
}

fn to_mysql_typed(params: &[TypedValue]) -> Vec<mysql::Value> {
    params
        .iter()
        .map(|v| match v {
            TypedValue::Null => mysql::Value::NULL,
            TypedValue::Int(x) => mysql::Value::Int(*x),
            TypedValue::UInt(x) => mysql::Value::UInt(*x),
            TypedValue::BigUInt(x) => mysql::Value::UInt(*x),
            TypedValue::Float(x) => mysql::Value::Float(*x),
            TypedValue::Double(x) => mysql::Value::Double(*x),
            TypedValue::Decimal(s) => mysql::Value::Bytes(s.clone().into_bytes()),
            // Bytes 为十六进制编码,入参须还原原始字节。
            TypedValue::Bytes(hex) => mysql::Value::Bytes(hex_decode(hex).unwrap_or_default()),
            TypedValue::Text(s) => mysql::Value::Bytes(s.clone().into_bytes()),
            TypedValue::DateTime { .. } => mysql::Value::Bytes(b"1970-01-01 00:00:00".to_vec()),
        })
        .collect()
}

/// 共享连接:RowSource/ReadOnlyExecutor 用 `&self` 方法,故须内部可变;
/// WriteExecutor 用 `&mut self`,RefCell 对两者都兼容。
type SharedConn = Rc<RefCell<mysql::Conn>>;

/// 带重试的连接:MySQL 容器首启(空 datadir)时初始化阶段会短暂打印
/// "ready for connections" 但真实 server 尚未监听 TCP;日志行就绪条件不
/// 可靠,故循环尝试 `Conn::new` 直到成功或 `tries` 次耗尽。
fn connect_with_retry(
    opts: mysql::Opts,
    tries: usize,
) -> Result<mysql::Conn, Box<dyn std::error::Error>> {
    let mut last: Option<String> = None;
    for _ in 0..tries {
        match mysql::Conn::new(opts.clone()) {
            Ok(c) => return Ok(c),
            Err(e) => {
                last = Some(format!("{e:?}"));
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    }
    Err(format!("mysql connect failed after {tries} tries: {last:?}").into())
}

// 信息源适配(信息_schema 读取):RowSource。
struct MysqlRows {
    conn: SharedConn,
}

impl kode_db_clone::information_schema::RowSource for MysqlRows {
    fn query(&self, sql: &str) -> kode_db_clone::CloneResult<Vec<Vec<Option<String>>>> {
        let mut conn = self.conn.borrow_mut();
        let rows: Vec<mysql::Row> = conn.query(sql).map_err(|e| {
            CloneError::ArchiveError(format!("information_schema query failed: {e}"))
        })?;
        Ok(rows
            .iter()
            .map(|r| (0..r.len()).map(|i| cell_string(r, i)).collect())
            .collect())
    }
}

// 只读执行器(导出):ReadOnlyExecutor。
struct MysqlRead {
    conn: SharedConn,
}

impl ReadOnlyExecutor for MysqlRead {
    fn query(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> kode_db_clone::CloneResult<Vec<Vec<Option<String>>>> {
        let mut conn = self.conn.borrow_mut();
        let rows: Vec<mysql::Row> = conn
            .exec(sql, to_mysql_params(params))
            .map_err(|e| CloneError::ArchiveError(format!("read query failed: {e}")))?;
        Ok(rows
            .iter()
            .map(|r| (0..r.len()).map(|i| cell_string(r, i)).collect())
            .collect())
    }

    fn execute(&self, sql: &str) -> kode_db_clone::CloneResult<()> {
        let mut conn = self.conn.borrow_mut();
        conn.query_drop(sql)
            .map_err(|e| CloneError::ArchiveError(format!("read control failed: {e}")))?;
        Ok(())
    }
}

// 写执行器(导入):WriteExecutor(真实事务/自增/计数)。
struct MysqlWrite {
    conn: SharedConn,
}

impl WriteExecutor for MysqlWrite {
    fn begin(&mut self) -> kode_db_clone::CloneResult<()> {
        let mut conn = self.conn.borrow_mut();
        conn.query_drop("BEGIN")
            .map_err(|e| CloneError::ArchiveError(format!("begin failed: {e}")))
    }
    fn execute_insert(
        &mut self,
        sql: &str,
        params: &[TypedValue],
    ) -> kode_db_clone::CloneResult<u64> {
        let mut conn = self.conn.borrow_mut();
        conn.exec_drop(sql, to_mysql_typed(params))
            .map_err(|e| CloneError::ArchiveError(format!("insert failed: {e}")))?;
        Ok(conn.last_insert_id())
    }
    fn query_count(&mut self, sql: &str, params: &[TypedValue]) -> kode_db_clone::CloneResult<u64> {
        let mut conn = self.conn.borrow_mut();
        conn.exec_first::<u64, _, _>(sql, to_mysql_typed(params))
            .map_err(|e| CloneError::ArchiveError(format!("count query failed: {e}")))?
            .ok_or_else(|| CloneError::ArchiveError("count query returned no row".into()))
    }
    fn rollback(&mut self) -> kode_db_clone::CloneResult<()> {
        let mut conn = self.conn.borrow_mut();
        conn.query_drop("ROLLBACK")
            .map_err(|e| CloneError::ArchiveError(format!("rollback failed: {e}")))
    }
    fn commit(&mut self) -> kode_db_clone::CloneResult<()> {
        let mut conn = self.conn.borrow_mut();
        conn.query_drop("COMMIT")
            .map_err(|e| CloneError::ArchiveError(format!("commit failed: {e}")))
    }
}

/// 在指定 MySQL 版本镜像上跑完整往返。
fn roundtrip_on(tag: &str) -> Result<(), Box<dyn std::error::Error>> {
    let node = MysqlImage { tag: tag.into() }
        .with_startup_timeout(std::time::Duration::from_secs(240))
        .start()?;
    let host = node.get_host()?;
    let port = node.get_host_port_ipv4(3306.tcp())?;
    // get_host() 常返回 Domain("localhost");rust mysql crate 对 localhost 的
    // 解析在容器网络下不稳定(手动 127.0.0.1/localhost 皆可,测试内 localhost
    // 偶发 server disconnected)。故连接统一走显式 127.0.0.1(映射必在回环)。
    let url = format!("mysql://root@127.0.0.1:{port}/test");
    // 就绪条件 "ready for connections" 在 MySQL 首启初始化(DATADIR 为空)时会被
    // 临时初始化阶段的 server 打印,此时真实 server 尚未监听 TCP 3306 → 直连会
    // server disconnected。故用「重试直到真连上」兜住首启窗口,不依赖日志行。
    let opts = mysql::Opts::from_url(&url)?;
    let conn: SharedConn = Rc::new(RefCell::new(connect_with_retry(opts.clone(), 60)?));
    // 目标连接:独立可写连接,导入回写(生产里导出/导入本就分属不同连接)。
    let dst: SharedConn = Rc::new(RefCell::new(connect_with_retry(opts, 60)?));

    {
        let mut c = conn.borrow_mut();
        for ddl in DDL {
            c.query_drop(ddl)?;
        }
    }

    // 造数:根 + 2 个 ARRAY 行 + 1 个组件行(真实 AUTO_INCREMENT)。
    let root_id: u64 = {
        let mut c = conn.borrow_mut();
        c.exec_drop(
            "INSERT INTO tbl_Avatar (sm_autoLoad, sm_name) VALUES (0, ?)",
            ("Alice",),
        )?;
        let id = c.last_insert_id();
        assert!(id >= 1);
        c.exec_drop(
            "INSERT INTO tbl_Avatar_items (parentID, sm_value) VALUES (?, ?)",
            (id, "sword"),
        )?;
        c.exec_drop(
            "INSERT INTO tbl_Avatar_items (parentID, sm_value) VALUES (?, ?)",
            (id, "shield"),
        )?;
        c.exec_drop(
            "INSERT INTO tbl_Avatar_gold (parentID, sm_amount) VALUES (?, ?)",
            (id, 5000),
        )?;
        id
    };

    // 1) 真实 information_schema 解析 → 物理 schema。
    let derived = avatar_derived();
    let physical = {
        let rows = MysqlRows { conn: conn.clone() };
        InformationSchemaReader::new(&rows, "test").load()?
    };
    let resolved = SchemaResolver::resolve(&derived, &physical)?;
    assert_eq!(resolved.missing.len(), 0, "no derived table may be missing");

    // 2) 只读导出计划。
    let rules = RuleSet::default();
    let plan = ExportPlanner::new(1_000_000).plan(&derived, &resolved, &rules, None)?;

    // 3) 只读导出 → 归档(真实 REPEATABLE READ 只读事务)。
    let dir = temp_dir(tag);
    let archive_path = dir.join("avatar.kdp");
    {
        let exec = MysqlRead { conn: conn.clone() };
        let rels: Vec<Relation> = relations_from_plan(&plan);
        write_archive(
            &archive_path,
            &plan,
            &rels,
            root_id,
            &exec,
            &SensitivityPolicy::default(),
            None,
            &ExportBudget::unlimited(),
            &ExportControl::new(),
        )?;
    }
    let archive = Archive::open(&archive_path, None)?;
    assert_eq!(archive.meta().entity, "Avatar");
    assert_eq!(archive.meta().total_rows, 4, "root 1 + items 2 + gold 1");
    let items_rows = archive.table_rows("tbl_Avatar_items")?;
    assert_eq!(items_rows.len(), 2);

    // 4) 导入计划(目标=同库 local 可写;空唯一键快照)。
    let target = TargetProfile {
        environment: TargetEnvironment::Local,
        db_interface: "mysql".into(),
        writable: true,
        host: host.to_string(),
        port,
        database: "test".into(),
        engine_version: None,
    };
    let snapshot = TargetSnapshot::default();
    let import_plan = ImportPlanner::plan(
        &archive,
        &target,
        &derived,
        &resolved,
        &rules,
        &snapshot,
        &ImportOptions::default(),
    )?;

    // 5) 单事务导入(真实自增回填 + COMMIT + 逐表 COUNT 校验)。
    let mut store = MemoryRunStore::default();
    let outcome = {
        let mut w = MysqlWrite { conn: dst.clone() };
        ImportApplier.apply(
            &import_plan,
            &archive,
            &target,
            &mut w,
            &mut store,
            &ApplyControl {
                allow_duplicate: false,
                fail_at_statement: None,
            },
        )?
    };
    let run = match outcome {
        ApplyOutcome::Applied(r) => r,
        ApplyOutcome::DuplicateRejected(d) => {
            panic!("fresh import must not be duplicate-rejected: {d:?}")
        }
    };
    assert_eq!(run.run_id, 0, "fresh MemoryRunStore starts at 0");
    assert!(run.verify.passed, "COUNT verify must pass");
    assert_eq!(run.new_root_id, Some(root_id + 1), "next AUTO_INCREMENT");

    // 6) 目标已含原 + 新各一份(目标侧只读查询仍可走写连接)。
    let count: u64 = dst
        .borrow_mut()
        .query_first("SELECT COUNT(*) FROM tbl_Avatar")?
        .unwrap();
    assert_eq!(count, 2, "original + imported root");
    let items: u64 = dst
        .borrow_mut()
        .query_first("SELECT COUNT(*) FROM tbl_Avatar_items")?
        .unwrap();
    assert_eq!(items, 4, "original 2 + imported 2");
    // 导入的 items 都指向新根(新 parentID)。
    let new_root: u64 = root_id + 1;
    let linked: u64 = dst
        .borrow_mut()
        .exec_first::<u64, _, _>(
            "SELECT COUNT(*) FROM tbl_Avatar_items WHERE parentID = ?",
            (new_root,),
        )?
        .unwrap();
    assert_eq!(linked, 2, "both imported items link to the new root");

    Ok(())
}

/// 真实 MySQL 8.0 全往返。
#[test]
#[ignore = "requires docker; set KODE_DB_CLONE_MYSQL=1 to run"]
fn mysql_real_roundtrip_mysql80() {
    if std::env::var("KODE_DB_CLONE_MYSQL").as_deref() != Ok("1") {
        eprintln!("skip: set KODE_DB_CLONE_MYSQL=1 (docker required)");
        return;
    }
    roundtrip_on("8.0").expect("mysql 8.0 round-trip");
}

/// 真实 MySQL 5.7 全往返(差异版本组合)。
#[test]
#[ignore = "requires docker; set KODE_DB_CLONE_MYSQL=1 to run"]
fn mysql_real_roundtrip_mysql57() {
    if std::env::var("KODE_DB_CLONE_MYSQL").as_deref() != Ok("1") {
        eprintln!("skip: set KODE_DB_CLONE_MYSQL=1 (docker required)");
        return;
    }
    roundtrip_on("5.7").expect("mysql 5.7 round-trip");
}
