//! PDC-0601: testcontainers/MySQL real integration tests (differing version
//! combinations).
//!
//! Uses real MySQL containers to verify the crate core's fit with real database
//! semantics: information_schema parsing, read-only export, transactional import
//! (real AUTO_INCREMENT / consistent snapshot / rollback) end to end.
//!
//! Gating: `#[ignore]` + environment variable `KODE_DB_CLONE_MYSQL=1` (needs
//! Docker). A default `cargo test` does not run them (dev-deps only take effect
//! when explicitly enabled); to run:
//! `KODE_DB_CLONE_MYSQL=1 cargo test -p kode-db-clone --test mysql_real -- --ignored --nocapture`
//!
//! The library crate itself stays free of MySQL driver dependencies (the driver is
//! only this test's dev-dependency).

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
// KBEngine-derived DDL (source-evidence §3/§4): Avatar main table + ARRAY child
// table + component child table. Column types / primary keys / indexes per the
// ETM.cpp facts; column order aligned with golden_apply's avatar_derived so that
// the physical ↔ derived comparison takes the same decision path.
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

/// A self-implemented MySQL image: the mysql module of testcontainers-modules
/// uses wait conditions containing "X Plugin ready" (5.7 does not ship the X Plugin
/// by default) and expects the mysqld line to carry a /usr/sbin/ prefix (5.7 logs
/// carry no prefix); neither is ever satisfied on 5.7 → StartupTimeout. Hence only
/// the cross-version-stable substring "ready for connections" (stderr), which
/// both print, is used as the readiness condition.
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

/// Converts any mysql value losslessly to the string face (consistent with the
/// crate's string protocol). NULL→None; Int/UInt/Float/Double→to_string;
/// Bytes→UTF-8 lossy.
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
            // Bytes is hex-encoded; the parameter must restore the original
            // bytes.
            TypedValue::Bytes(hex) => mysql::Value::Bytes(hex_decode(hex).unwrap_or_default()),
            TypedValue::Text(s) => mysql::Value::Bytes(s.clone().into_bytes()),
            TypedValue::DateTime { .. } => mysql::Value::Bytes(b"1970-01-01 00:00:00".to_vec()),
        })
        .collect()
}

/// Shared connection: RowSource/ReadOnlyExecutor use `&self` methods, so interior
/// mutability is required; WriteExecutor uses `&mut self`; RefCell is compatible
/// with both.
type SharedConn = Rc<RefCell<mysql::Conn>>;

/// Connect with retry: on a MySQL container's first start (empty datadir) the
/// initialization phase briefly prints "ready for connections" while the real
/// server is not yet listening on TCP; a log-line readiness condition is
/// unreliable, so `Conn::new` is retried in a loop until success or `tries` is
/// exhausted.
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

// Information-source adapter (information_schema reads): RowSource.
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

// Read-only executor (export): ReadOnlyExecutor.
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

// Write executor (import): WriteExecutor (real transaction / auto-increment /
// counts).
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

/// Runs the full round trip on the given MySQL version image.
fn roundtrip_on(tag: &str) -> Result<(), Box<dyn std::error::Error>> {
    let node = MysqlImage { tag: tag.into() }
        .with_startup_timeout(std::time::Duration::from_secs(240))
        .start()?;
    let host = node.get_host()?;
    let port = node.get_host_port_ipv4(3306.tcp())?;
    // get_host() often returns Domain("localhost"); the rust mysql crate's
    // resolution of localhost is unstable under container networking (manual
    // 127.0.0.1/localhost both work, but localhost inside tests intermittently
    // hits server disconnected). So connections uniformly go through an explicit
    // 127.0.0.1 (the mapping is always on loopback).
    let url = format!("mysql://root@127.0.0.1:{port}/test");
    // The readiness condition "ready for connections" gets printed during MySQL's
    // first-start initialization (empty DATADIR) by the temporary initialization
    // server, at which point the real server is not yet listening on TCP 3306 → a
    // direct connect hits server disconnected. Hence "retry until really
    // connected" covers the first-start window, without relying on the log line.
    let opts = mysql::Opts::from_url(&url)?;
    let conn: SharedConn = Rc::new(RefCell::new(connect_with_retry(opts.clone(), 60)?));
    // Target connection: a separate writable connection for the import write-back
    // (in production, export/import naturally use different connections).
    let dst: SharedConn = Rc::new(RefCell::new(connect_with_retry(opts, 60)?));

    {
        let mut c = conn.borrow_mut();
        for ddl in DDL {
            c.query_drop(ddl)?;
        }
    }

    // Seed data: root + 2 ARRAY rows + 1 component row (real AUTO_INCREMENT).
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

    // 1) Real information_schema parsing → physical schema.
    let derived = avatar_derived();
    let physical = {
        let rows = MysqlRows { conn: conn.clone() };
        InformationSchemaReader::new(&rows, "test").load()?
    };
    let resolved = SchemaResolver::resolve(&derived, &physical)?;
    assert_eq!(resolved.missing.len(), 0, "no derived table may be missing");

    // 2) Read-only export plan.
    let rules = RuleSet::default();
    let plan = ExportPlanner::new(1_000_000).plan(&derived, &resolved, &rules, None)?;

    // 3) Read-only export → archive (a real REPEATABLE READ read-only
    // transaction).
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

    // 4) Import plan (target = the same database, local, writable; empty unique
    // key snapshot).
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

    // 5) Single-transaction import (real auto-increment backfill + COMMIT +
    // per-table COUNT verification).
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

    // 6) The target now holds both the original and the new copy (target-side
    // read-only queries may still go through the write connection).
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
    // The imported items all point at the new root (new parentID).
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

/// Real MySQL 8.0 full round trip.
#[test]
#[ignore = "requires docker; set KODE_DB_CLONE_MYSQL=1 to run"]
fn mysql_real_roundtrip_mysql80() {
    if std::env::var("KODE_DB_CLONE_MYSQL").as_deref() != Ok("1") {
        eprintln!("skip: set KODE_DB_CLONE_MYSQL=1 (docker required)");
        return;
    }
    roundtrip_on("8.0").expect("mysql 8.0 round-trip");
}

/// Real MySQL 5.7 full round trip (differing version combination).
#[test]
#[ignore = "requires docker; set KODE_DB_CLONE_MYSQL=1 to run"]
fn mysql_real_roundtrip_mysql57() {
    if std::env::var("KODE_DB_CLONE_MYSQL").as_deref() != Ok("1") {
        eprintln!("skip: set KODE_DB_CLONE_MYSQL=1 (docker required)");
        return;
    }
    roundtrip_on("5.7").expect("mysql 5.7 round-trip");
}
