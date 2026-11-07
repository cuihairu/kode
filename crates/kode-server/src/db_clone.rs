//! `$/kode/dbClone/*` —— player data clone 桥接面(CLONE-P5 / PDC-0501..0506)。
//!
//! 边界(镜像 database_schema.rs「输入收集留 TS、推导归 Rust」):克隆的
//! 计划/归档纯逻辑在 `kode-db-clone` crate(自包含,无 server 依赖),本模块
//! 只做 JSON wire ↔ crate 类型的机械映射并注册 RPC:
//! - `inspectArchive`:TS 传归档路径 → `Archive::inspect` 清单(不回行值);
//! - `planExport`:TS 传推导输出 + 源库 information_schema 探测的物理表
//!   → `ExportPlanner` 只读 SELECT 计划(执行由 TS 侧 mysql2 只读会话承担);
//! - `export`:TS 传已读出的有类型行 → 落 `.kdpclone`(脱敏默认开,§7);
//! - `planImport`:TS 传归档 + 目标 Profile + 物理表 + 目标快照 → ImportPlanner
//!   计划(语句全 `?` 参数化)。
//!
//! 事务执行(Apply)不在此面:单事务必须独占一条 MySQL 会话,而 Rust 侧无
//! MySQL 客户端——TS 侧 executor 驱动 mysql2 事务,语义对齐 crate `apply.rs`
//! (begin → 逐句 → 失败 rollback → commit,PDC-0402/0405 同款)。这是
//! PDC-0506「与当前已有的 Rust/TS 后端模式兼容」的显式取舍,非疏漏。

use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{to_value, Value};

use kode_db_clone::is_encrypted;
use kode_db_clone::keystore::{
    ensure_key_outside_archive, key_id_for_archive, ArchiveKey, FileKeyStore, KeyStore,
};
use kode_db_clone::redact::{RedactingSink, SensitivityPolicy};
use kode_db_clone::relations_from_plan;
use kode_db_clone::schema::PhysicalTable;
use kode_db_clone::value::{TypedRow, TypedValue};
use kode_db_clone::{
    Archive, ArchiveWriter, AutoLoadPolicy, CloneSchema, ExportPlanner, ImportMode, ImportOptions,
    ImportPlanner, RuleSet, SchemaResolver, TargetEnvironment, TargetProfile, TargetSnapshot,
    UniqueKey, UniquePolicy, VirtualSchema,
};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/dbClone/inspectArchive", inspect_archive);
    reg.register("$/kode/dbClone/planExport", plan_export);
    reg.register("$/kode/dbClone/export", export_archive);
    reg.register("$/kode/dbClone/planImport", plan_import);
    reg.register("$/kode/dbClone/readArchiveRows", read_archive_rows);
}

// ---------------------------------------------------------------------------
// inspectArchive
// ---------------------------------------------------------------------------

/// 物理表 wire 形态(camelCase;`PhysicalTable` 无 serde derive,本层机械映射)。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhysicalTableWire {
    name: String,
    #[serde(default = "default_engine")]
    engine: String,
    columns: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    primary_key: Vec<String>,
    #[serde(default)]
    indexes: Vec<Vec<String>>,
}

fn default_engine() -> String {
    "InnoDB".into()
}

impl PhysicalTableWire {
    fn into_table(self) -> PhysicalTable {
        PhysicalTable {
            name: self.name,
            engine: self.engine,
            columns: self.columns,
            primary_key: self.primary_key,
            indexes: self.indexes,
        }
    }
}

// ---------------------------------------------------------------------------
// 归档加密密钥解析(PDC-0607 §2.2 缺口的接线)
// ---------------------------------------------------------------------------

/// 写侧:密钥根 → 该归档的密钥(无则生成,0600 落盘)。密钥目录不得在归档
/// 路径内(结构性保证);id = 归档绝对路径 SHA-256(见 keystore::key_id_for_archive)。
/// 密钥材料全程留 Rust——TS 只传密钥根目录路径,永不接触密钥字节。
fn write_key_from_root(archive_path: &str, key_root: &str) -> Result<ArchiveKey, String> {
    let root = std::path::Path::new(key_root);
    let archive = std::path::Path::new(archive_path);
    ensure_key_outside_archive(root, archive).map_err(|e| e.to_string())?;
    let id = key_id_for_archive(archive);
    FileKeyStore::new(root)
        .get_or_create(&id)
        .map_err(|e| e.to_string())
}

/// 读侧:显式 keyHex 优先(向后兼容旧载荷);否则未加密档 → None,加密档按
/// 密钥根取钥——钥匙缺失如实报错(点名密钥根与 id,便于运维定位),绝不
/// 静默生成新钥(那只会造出永远解不开档的错误钥匙)。
fn resolve_read_key(
    archive_path: &str,
    key_hex: Option<&str>,
    key_root: Option<&str>,
) -> Result<Option<ArchiveKey>, String> {
    if key_hex.is_some() {
        return decode_key(key_hex);
    }
    let Some(root) = key_root else {
        return Ok(None);
    };
    let path = std::path::Path::new(archive_path);
    if !is_encrypted(path).map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let id = key_id_for_archive(path);
    let store = FileKeyStore::new(root);
    if !store.exists(&id) {
        return Err(format!(
            "archive is encrypted; its key is missing from the key store (root `{root}`, id `{id}`) — copy the key from the machine that created the archive, or re-export it there"
        ));
    }
    store
        .get_or_create(&id)
        .map_err(|e| e.to_string())
        .map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectParams {
    path: String,
    /// 加密归档的密钥(64 位 hex;明文归档省略)。
    #[serde(default)]
    key_hex: Option<String>,
    /// 密钥存储根目录(keyHex 缺省时按归档路径推导 id 取钥;TS 侧传
    /// globalStorage 下的 clone-keys 目录,密钥不落工作区/VCS)。
    #[serde(default)]
    key_root: Option<String>,
}

fn inspect_archive(params: Value) -> Result<Value, String> {
    let params: InspectParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let key = resolve_read_key(
        &params.path,
        params.key_hex.as_deref(),
        params.key_root.as_deref(),
    )?;
    let meta = Archive::inspect(std::path::Path::new(&params.path), key.as_ref())
        .map_err(|e| e.to_string())?;
    to_value(meta).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// planExport
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanExportParams {
    /// kode-server databaseSchema/build 推导输出(tables/tableIndex,原样透传)。
    derivation: Value,
    /// 源库 information_schema 探测的物理表(TS 侧只读会话收集)。
    physical_tables: Vec<PhysicalTableWire>,
    /// 行预算(默认 100_000,超限诚实拒绝)。
    #[serde(default = "default_row_budget")]
    row_budget: u64,
}

fn default_row_budget() -> u64 {
    100_000
}

fn plan_export(params: Value) -> Result<Value, String> {
    let params: PlanExportParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let schema = schema_from_derivation(&params.derivation)?;
    let physical = VirtualSchema::new(
        params
            .physical_tables
            .into_iter()
            .map(PhysicalTableWire::into_table)
            .collect(),
    );
    let resolved = SchemaResolver::resolve(&schema, &physical).map_err(|e| e.to_string())?;
    let plan = ExportPlanner::new(params.row_budget)
        .plan(&schema, &resolved, &RuleSet::default(), None)
        .map_err(|e| e.to_string())?;
    to_value(plan).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportParams {
    path: String,
    entity: String,
    /// 源库读出的有类型行(按表)。
    rows: Vec<TypedRow>,
    /// 脱敏开关(默认 true:credential/personal 列掩码,§7「默认不展示密码/token」)。
    #[serde(default = "default_true")]
    redact_sensitive: bool,
    /// 导出所用计划列序(脱敏按列名归类必需;省略则不脱敏)。
    #[serde(default)]
    plan: Option<Value>,
    /// 密钥存储根目录:传了即加密落盘(chacha20poly1305,钥经 FileKeyStore
    /// 0600 独立存,不跟归档同处);缺省写明文归档(向后兼容)。
    #[serde(default)]
    key_root: Option<String>,
}

fn default_true() -> bool {
    true
}

fn export_archive(params: Value) -> Result<Value, String> {
    let params: ExportParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let key = match &params.key_root {
        Some(root) => Some(write_key_from_root(&params.path, root)?),
        None => None,
    };
    let mut writer = ArchiveWriter::new(
        std::path::Path::new(&params.path),
        key,
        params.entity.as_str(),
    )
    .map_err(|e| e.to_string())?;

    // 按表计数分组(end_table 需要逐表行数)。
    let mut rows_by_table: std::collections::BTreeMap<String, Vec<TypedRow>> =
        std::collections::BTreeMap::new();
    for row in params.rows {
        rows_by_table
            .entry(row.table.clone())
            .or_default()
            .push(row);
    }

    let plan = match (&params.plan, params.redact_sensitive) {
        (Some(plan_value), true) => Some(
            serde_json::from_value::<kode_db_clone::QueryPlan>(plan_value.clone())
                .map_err(|e| e.to_string())?,
        ),
        (None, true) => {
            // 脱敏按列名归类必须知道列序;缺计划时静默不脱敏等于假保护。
            return Err(
                "redactSensitive requires the export plan (column order) — pass the planExport result"
                    .to_string(),
            );
        }
        (_, false) => None,
    };
    let policy = SensitivityPolicy::default();
    let mut redaction = kode_db_clone::redact::RedactionReport { entries: vec![] };

    for (table, rows) in &rows_by_table {
        match &plan {
            Some(plan) => {
                let mut sink = RedactingSink::new(&mut writer, &policy, plan);
                for row in rows {
                    kode_db_clone::RowSink::write_row(&mut sink, table, row)
                        .map_err(|e| e.to_string())?;
                }
                redaction = sink.report();
            }
            None => {
                for row in rows {
                    kode_db_clone::RowSink::write_row(&mut writer, table, row)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        kode_db_clone::RowSink::end_table(&mut writer, table, rows.len() as u64)
            .map_err(|e| e.to_string())?;
    }

    let relations = plan.as_ref().map(relations_from_plan).unwrap_or_default();
    let meta = writer
        .finalize(&relations, &redaction)
        .map_err(|e| e.to_string())?;
    to_value(meta).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// planImport
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanImportParams {
    path: String,
    #[serde(default)]
    key_hex: Option<String>,
    #[serde(default)]
    key_root: Option<String>,
    target: TargetWire,
    derivation: Value,
    physical_tables: Vec<PhysicalTableWire>,
    snapshot: SnapshotWire,
    #[serde(default)]
    options: OptionsWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetWire {
    environment: String,
    db_interface: String,
    writable: bool,
    host: String,
    port: u16,
    database: String,
    #[serde(default)]
    engine_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotWire {
    unique_keys: Vec<UniqueKeyWire>,
    #[serde(default)]
    existing_values: Vec<ExistingValueWire>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UniqueKeyWire {
    table: String,
    column: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExistingValueWire {
    table: String,
    column: String,
    value: TypedValue,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct OptionsWire {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    autoload: Option<String>,
    #[serde(default)]
    unique_seed: Option<String>,
}

fn plan_import(params: Value) -> Result<Value, String> {
    let params: PlanImportParams = serde_json::from_value(params).map_err(|e| e.to_string())?;

    let key = resolve_read_key(
        &params.path,
        params.key_hex.as_deref(),
        params.key_root.as_deref(),
    )?;
    let archive = Archive::open(std::path::Path::new(&params.path), key.as_ref())
        .map_err(|e| e.to_string())?;

    let schema = schema_from_derivation(&params.derivation)?;
    let physical = VirtualSchema::new(
        params
            .physical_tables
            .into_iter()
            .map(PhysicalTableWire::into_table)
            .collect(),
    );
    let resolved = SchemaResolver::resolve(&schema, &physical).map_err(|e| e.to_string())?;

    // 目标 Profile:环境仅 local/test(其余值在 validate_for_import fail-closed)。
    let target = TargetProfile {
        environment: parse_environment(&params.target.environment)?,
        db_interface: params.target.db_interface,
        writable: params.target.writable,
        host: params.target.host,
        port: params.target.port,
        database: params.target.database,
        engine_version: params.target.engine_version,
    };

    // 目标快照:唯一键清单 + 既有值(预演冲突比对;TS 侧只读探测收集)。
    let mut snapshot = TargetSnapshot::default();
    for unique in &params.snapshot.unique_keys {
        snapshot.unique_keys.push(UniqueKey {
            table: unique.table.clone(),
            column: unique.column.clone(),
        });
    }
    for existing in &params.snapshot.existing_values {
        snapshot.add_existing(&existing.table, &existing.column, existing.value.clone());
    }

    let options = ImportOptions {
        mode: parse_mode(params.options.mode.as_deref())?,
        autoload: parse_autoload(params.options.autoload.as_deref())?,
        unique: match params.options.unique_seed.as_deref() {
            Some("reject") => UniquePolicy::Reject,
            Some(seed) => UniquePolicy::RebuildSuffix {
                seed: seed.to_string(),
            },
            None => UniquePolicy::RebuildSuffix {
                seed: "imported".into(),
            },
        },
    };

    let plan = ImportPlanner::plan(
        &archive,
        &target,
        &schema,
        &resolved,
        &RuleSet::default(),
        &snapshot,
        &options,
    )
    .map_err(|e| e.to_string())?;
    to_value(plan).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// readArchiveRows
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRowsParams {
    path: String,
    #[serde(default)]
    key_hex: Option<String>,
    #[serde(default)]
    key_root: Option<String>,
}

/// 归档行读取(Apply 期 TS 侧绑定字面值/唯一键探测的输入;单玩家量级)。
fn read_archive_rows(params: Value) -> Result<Value, String> {
    let params: ReadRowsParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let key = resolve_read_key(
        &params.path,
        params.key_hex.as_deref(),
        params.key_root.as_deref(),
    )?;
    let archive = Archive::open(std::path::Path::new(&params.path), key.as_ref())
        .map_err(|e| e.to_string())?;
    let mut tables = Vec::new();
    for meta in &archive.meta().tables {
        let rows = archive.table_rows(&meta.name).map_err(|e| e.to_string())?;
        tables.push(serde_json::json!({ "name": meta.name, "rows": rows }));
    }
    to_value(serde_json::json!({ "tables": tables })).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// wire 映射辅助
// ---------------------------------------------------------------------------

fn schema_from_derivation(derivation: &Value) -> Result<CloneSchema, String> {
    let json = serde_json::to_string(derivation).map_err(|e| e.to_string())?;
    CloneSchema::from_derivation(&json).map_err(|e| e.to_string())
}

fn decode_key(key_hex: Option<&str>) -> Result<Option<[u8; 32]>, String> {
    let Some(hex) = key_hex else {
        return Ok(None);
    };
    let bytes = kode_db_clone::value::hex_decode(hex)?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "keyHex must decode to 32 bytes".to_string())?;
    Ok(Some(key))
}

fn parse_environment(value: &str) -> Result<TargetEnvironment, String> {
    TargetEnvironment::from_str(value).map_err(|e| e.to_string())
}

fn parse_mode(value: Option<&str>) -> Result<ImportMode, String> {
    match value {
        None | Some("allocate-new-ids") => Ok(ImportMode::AllocateNewIds),
        Some("preserve-id-if-empty") => Ok(ImportMode::PreserveIfEmpty),
        Some(other) => Err(format!("unknown import mode `{other}`")),
    }
}

fn parse_autoload(value: Option<&str>) -> Result<AutoLoadPolicy, String> {
    match value {
        None | Some("force-disabled") => Ok(AutoLoadPolicy::ForceDisabled),
        Some("preserve-archive") => Ok(AutoLoadPolicy::PreserveArchive),
        Some(other) => Err(format!("unknown autoload policy `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 与 databaseSchema/build 输出同形的迷你推导(根表 + ARRAY 子表)。
    fn mini_derivation() -> Value {
        json!({
            "tables": [
                {
                    "name": "tbl_Avatar",
                    "kind": "entity",
                    "propertyPath": "Avatar",
                    "fields": [
                        { "name": "id", "typeLabel": "bigint unsigned", "synthetic": true },
                        { "name": "sm_autoLoad", "typeLabel": "tinyint", "synthetic": true },
                        { "name": "sm_name", "typeLabel": "varchar", "identifier": true }
                    ]
                },
                {
                    "name": "tbl_Avatar_items",
                    "kind": "array",
                    "parentTableName": "tbl_Avatar",
                    "propertyPath": "Avatar.items",
                    "fields": [
                        { "name": "id", "typeLabel": "bigint unsigned", "synthetic": true },
                        { "name": "parentID", "typeLabel": "bigint unsigned", "synthetic": true },
                        { "name": "sm_value", "typeLabel": "varchar" }
                    ]
                }
            ]
        })
    }

    fn mini_physical() -> Vec<PhysicalTableWire> {
        let make = |name: &str, cols: &[(&str, &str)]| PhysicalTableWire {
            name: name.to_string(),
            engine: "InnoDB".into(),
            columns: cols
                .iter()
                .map(|(c, t)| ((*c).to_string(), (*t).to_string()))
                .collect(),
            primary_key: vec!["id".into()],
            indexes: vec![],
        };
        vec![
            make(
                "tbl_Avatar",
                &[
                    ("id", "bigint(20) unsigned"),
                    ("sm_autoLoad", "tinyint"),
                    ("sm_name", "varchar(255)"),
                ],
            ),
            make(
                "tbl_Avatar_items",
                &[
                    ("id", "bigint(20) unsigned"),
                    ("parentID", "bigint(20) unsigned"),
                    ("sm_value", "varchar(255)"),
                ],
            ),
        ]
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kode-dbclone-rpc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rpc_surface_round_trips_export_inspect_and_plan_import() {
        let dir = temp_dir("round");

        // planExport:推导+物理 → 只读 SELECT 计划。
        let plan_value = plan_export(json!({
            "derivation": mini_derivation(),
            "physicalTables": mini_physical()
        }))
        .unwrap();
        assert_eq!(
            plan_value["queries"][0]["table"].as_str(),
            Some("tbl_Avatar")
        );
        assert_eq!(plan_value["queries"][0]["filter"]["kind"], "root-id");
        assert_eq!(plan_value["queries"][1]["filter"]["kind"], "parent-id");

        // export:行值 + 计划(脱敏默认开)→ .kdpclone。
        let archive_path = dir.join("avatar.kdpclone");
        let meta = export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": true,
            "plan": plan_value,
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":"9007199254740993"}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ]},
                { "table": "tbl_Avatar_items", "values": [
                    {"t":"big-u-int","v":"18446744073709551615"}, {"t":"big-u-int","v":"9007199254740993"}, {"t":"text","v":"sword"}
                ]}
            ]
        }))
        .unwrap();
        assert_eq!(meta["entity"].as_str(), Some("Avatar"));
        assert_eq!(meta["total_rows"].as_u64(), Some(2));

        let rows = read_archive_rows(json!({ "path": archive_path.to_string_lossy() })).unwrap();
        let encoded = rows.to_string();
        assert!(encoded.contains("9007199254740993"));
        assert!(encoded.contains("18446744073709551615"));

        // inspectArchive:只回清单不回行值。
        let inspected = inspect_archive(json!({
            "path": archive_path.to_string_lossy()
        }))
        .unwrap();
        assert_eq!(inspected["entity"].as_str(), Some("Avatar"));
        assert_eq!(inspected["tables"].as_array().map(Vec::len), Some(2));
        assert!(inspected.get("rows").is_none());

        // planImport:归档 + 目标(local/mysql/可写)+ 物理表 + 快照(hero 占用)→ 计划。
        let plan = plan_import(json!({
            "path": archive_path.to_string_lossy(),
            "target": {
                "environment": "local",
                "dbInterface": "mysql",
                "writable": true,
                "host": "127.0.0.1",
                "port": 3306,
                "database": "kbe_local"
            },
            "derivation": mini_derivation(),
            "physicalTables": mini_physical(),
            "snapshot": {
                "uniqueKeys": [ { "table": "tbl_Avatar", "column": "sm_name" } ],
                "existingValues": [
                    { "table": "tbl_Avatar", "column": "sm_name", "value": {"t":"text","v":"hero"} }
                ]
            }
        }))
        .unwrap();
        assert_eq!(plan["statements"].as_array().map(Vec::len), Some(2));
        assert_eq!(plan["summary"]["unique_conflicts"].as_u64(), Some(1));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn export_with_key_root_encrypts_and_reads_back_through_all_handlers() {
        let dir = temp_dir("enc");
        let keys = dir.join("clone-keys");
        let archive_path = dir.join("avatar.kdpclone");

        let plan_value = plan_export(json!({
            "derivation": mini_derivation(),
            "physicalTables": mini_physical()
        }))
        .unwrap();

        // export 带 keyRoot:加密落盘 + 密钥 0600 独立存于密钥根。
        let meta = export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": true,
            "plan": plan_value,
            "keyRoot": keys.to_string_lossy(),
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":7}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ]}
            ]
        }))
        .unwrap();
        assert_eq!(
            meta["encrypted"].as_bool(),
            Some(true),
            "keyRoot 导出必须加密"
        );
        let key_files: Vec<_> = std::fs::read_dir(&keys)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".key"))
            .collect();
        assert_eq!(key_files.len(), 1, "一归档一钥,落密钥根");

        // 静态证明:归档字节里没有明文**载荷**(行值 hero 不得明文出现)。
        // 帧名(如 tables/tbl_Avatar.json)在帧头明文是格式设计——头部整体
        // 作 AEAD 关联数据(认证不加密),解密前须先按名定位帧;帧名属元数据
        // (类似加密 zip 的文件名),不含行值。
        let raw = std::fs::read(&archive_path).unwrap();
        assert!(
            !raw.windows(b"hero".len()).any(|w| w == b"hero"),
            "归档明文含敏感载荷 hero:加密未生效"
        );

        // inspect 带 keyRoot:清单可读,encrypted 如实 true。
        let inspected = inspect_archive(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy()
        }))
        .unwrap();
        assert_eq!(inspected["encrypted"].as_bool(), Some(true));

        // inspect 无钥无 keyRoot:如实报加密档需钥。
        let no_key = inspect_archive(json!({
            "path": archive_path.to_string_lossy()
        }))
        .unwrap_err();
        assert!(
            no_key.contains("its key is required"),
            "缺钥错误话术: {no_key}"
        );

        // readArchiveRows 带 keyRoot:行值可读回(导入 Apply 期输入面)。
        let rows = read_archive_rows(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy()
        }))
        .unwrap();
        assert_eq!(rows["tables"].as_array().map(Vec::len), Some(1));

        // planImport 带 keyRoot:归档可开,计划可出。
        let plan = plan_import(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy(),
            "target": {
                "environment": "local",
                "dbInterface": "mysql",
                "writable": true,
                "host": "127.0.0.1",
                "port": 3306,
                "database": "kbe_local"
            },
            "derivation": mini_derivation(),
            "physicalTables": mini_physical(),
            "snapshot": { "uniqueKeys": [], "existingValues": [] }
        }))
        .unwrap();
        assert!(plan["statements"].as_array().is_some(), "计划成形");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_key_reports_honest_error_naming_store() {
        let dir = temp_dir("enc-miss");
        let keys = dir.join("clone-keys");
        let archive_path = dir.join("avatar.kdpclone");

        let plan_value = plan_export(json!({
            "derivation": mini_derivation(),
            "physicalTables": mini_physical()
        }))
        .unwrap();
        export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": true,
            "plan": plan_value,
            "keyRoot": keys.to_string_lossy(),
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":7}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ]}
            ]
        }))
        .unwrap();

        // 密钥丢失(如跨机拷归档):读侧绝不静默生成新钥,点名根与 id 如实报。
        std::fs::remove_dir_all(&keys).unwrap();
        let err = inspect_archive(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy()
        }))
        .unwrap_err();
        assert!(
            err.contains("key is missing from the key store"),
            "缺钥话术: {err}"
        );
        assert!(
            err.contains("clone-keys"),
            "话术点名密钥根便于运维定位: {err}"
        );
        let rows_err = read_archive_rows(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy()
        }))
        .unwrap_err();
        assert!(
            rows_err.contains("key is missing from the key store"),
            "readArchiveRows 同话术: {rows_err}"
        );
        // 静默生成新钥会让归档永远解不开还装作正常——密钥根必须仍空。
        assert!(!keys.exists(), "读侧不得静默生成密钥");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn key_root_inside_archive_path_is_rejected() {
        let dir = temp_dir("enc-inside");
        let archive_path = dir.join("avatar.kdpclone");
        // 密钥根=归档路径本身:结构性拒绝(密钥不跟归档同存)。
        let err = export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": false,
            "rows": [],
            "keyRoot": archive_path.to_string_lossy()
        }))
        .unwrap_err();
        assert!(
            err.contains("must not live inside"),
            "结构性拒绝话术: {err}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn export_redaction_without_plan_is_rejected_not_silent() {
        let dir = temp_dir("redact");
        let err = export_archive(json!({
            "path": dir.join("a.kdpclone").to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": true,
            "rows": []
        }))
        .unwrap_err();
        assert!(err.contains("requires the export plan"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn plan_import_rejects_non_local_target() {
        let dir = temp_dir("target");
        let archive_path = dir.join("avatar.kdpclone");
        export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": false,
            "rows": [
                { "table": "tbl_Avatar", "values": [ {"t":"big-u-int","v":7}, {"t":"u-int","v":1}, {"t":"text","v":"hero"} ] }
            ]
        }))
        .unwrap();
        let err = plan_import(json!({
            "path": archive_path.to_string_lossy(),
            "target": {
                "environment": "prod",
                "dbInterface": "mysql",
                "writable": true,
                "host": "db.prod", "port": 3306, "database": "kbe"
            },
            "derivation": mini_derivation(),
            "physicalTables": mini_physical(),
            "snapshot": { "uniqueKeys": [], "existingValues": [] }
        }))
        .unwrap_err();
        assert!(err.contains("prod"), "prod/staging must fail closed: {err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_archive_rows_returns_typed_rows_in_table_order() {
        let dir = temp_dir("rows");
        let archive_path = dir.join("avatar.kdpclone");
        export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": false,
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":7}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ]},
                { "table": "tbl_Avatar_items", "values": [
                    {"t":"big-u-int","v":100}, {"t":"big-u-int","v":7}, {"t":"text","v":"sword"}
                ]}
            ]
        }))
        .unwrap();

        let rows = read_archive_rows(json!({ "path": archive_path.to_string_lossy() })).unwrap();
        let tables = rows["tables"].as_array().unwrap();
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0]["name"].as_str(), Some("tbl_Avatar"));
        assert_eq!(tables[0]["rows"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            tables[0]["rows"][0]["values"][2]["v"].as_str(),
            Some("hero")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn decode_key_requires_64_hex_chars() {
        assert!(decode_key(None).unwrap().is_none());
        assert!(decode_key(Some("zz")).is_err());
        assert!(decode_key(Some(&"0".repeat(64))).is_ok());
    }
}
