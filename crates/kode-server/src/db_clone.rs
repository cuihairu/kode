//! `$/kode/dbClone/*` — player data clone bridging face (CLONE-P5 / PDC-0501..0506).
//!
//! Boundary (mirroring database_schema.rs's "input collection stays in TS,
//! derivation belongs to Rust"): the pure plan/archive logic of cloning lives
//! in the `kode-db-clone` crate (self-contained, no server dependency); this
//! module only does the mechanical JSON wire ↔ crate type mapping and
//! registers the RPCs:
//! - `inspectArchive`: TS passes the archive path → `Archive::inspect`
//!   manifest (row values are not returned);
//! - `planExport`: TS passes the derivation output plus physical tables probed
//!   from the source database's information_schema → an `ExportPlanner`
//!   read-only SELECT plan (execution is carried by the TS-side mysql2
//!   read-only session);
//! - `export`: TS passes already-read typed rows → lands a `.kdpclone`
//!   (redaction defaults on, §7);
//! - `planImport`: TS passes archive + target Profile + physical tables +
//!   target snapshot → an ImportPlanner plan (all statements `?`
//!   parameterized).
//!
//! Transaction execution (Apply) is not on this face: a single transaction
//! must own one MySQL session exclusively, and the Rust side has no MySQL
//! client — the TS-side executor drives the mysql2 transaction, with semantics
//! aligned to the crate's `apply.rs` (begin → statement by statement →
//! rollback on failure → commit, the same pattern as PDC-0402/0405). This is
//! the explicit trade-off behind PDC-0506 "compatible with the currently
//! existing Rust/TS backend modes", not an oversight.

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

/// Physical table wire shape (camelCase; `PhysicalTable` has no serde derive,
/// this layer maps mechanically).
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
// Archive encryption key resolution (wiring up the PDC-0607 §2.2 gap)
// ---------------------------------------------------------------------------

/// Write side: key root → the key for this archive (generated if absent, stored
/// with 0600). The key directory must not be inside the archive path
/// (structurally guaranteed); id = SHA-256 of the archive's absolute path (see
/// keystore::key_id_for_archive). Key material stays in Rust throughout — TS
/// only passes the key root directory path and never touches key bytes.
fn write_key_from_root(archive_path: &str, key_root: &str) -> Result<ArchiveKey, String> {
    let root = std::path::Path::new(key_root);
    let archive = std::path::Path::new(archive_path);
    ensure_key_outside_archive(root, archive).map_err(|e| e.to_string())?;
    let id = key_id_for_archive(archive);
    FileKeyStore::new(root)
        .get_or_create(&id)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Same-target export mutual exclusion (KODE-FULL-016)
// ---------------------------------------------------------------------------

/// Target lock wait upper bound: if the lock cannot be acquired, report an
/// error honestly rather than blocking the caller forever. If a process
/// crashes, the kernel releases the file lock automatically — no deadlock.
const EXPORT_LOCK_WAIT_MS: u64 = 10_000;

/// Lock guard: held for the whole export (key acquisition → archive writing),
/// unlocked automatically when it leaves scope.
struct ExportLockGuard {
    file: Option<std::fs::File>,
}

impl Drop for ExportLockGuard {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = file.unlock();
        }
    }
}

/// Takes the exclusive export lock for an archive target: the lock file lives
/// in the key root directory (a kode-owned directory, keeping the user's
/// export directory clean) and is named by the archive's absolute-path id
/// (`key_id_for_archive`) — same targets exclude each other, different targets
/// run in parallel. The std file lock (flock/LockFileEx) holds across
/// processes; if the lock-holding process dies, the kernel releases it.
/// Plaintext exports (no keyRoot) have no kode-owned directory to put the lock
/// in and keep the original behavior.
fn lock_export_target(archive_path: &str, key_root: &str) -> Result<ExportLockGuard, String> {
    let root = std::path::Path::new(key_root);
    let archive = std::path::Path::new(archive_path);
    ensure_key_outside_archive(root, archive).map_err(|e| e.to_string())?;
    let id = key_id_for_archive(archive);
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let lock_path = root.join(format!("{id}.export-lock"));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("open export lock `{}`: {e}", lock_path.display()))?;
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(EXPORT_LOCK_WAIT_MS);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(ExportLockGuard { file: Some(file) }),
            Err(std::fs::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "another export to `{archive_path}` is still in progress \
                         (waited {EXPORT_LOCK_WAIT_MS}ms on lock `{}`)",
                        lock_path.display()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(e) => {
                return Err(format!("lock export target `{archive_path}`: {e}"));
            }
        }
    }
}

/// Read side: an explicit keyHex wins (backwards compatible with older
/// payloads); otherwise an unencrypted archive → None, and an encrypted one
/// takes its key by key root — a missing key is reported honestly (naming the
/// key root and the id so operators can locate it), never silently replaced
/// by a newly generated key (that would only produce a wrong key that can
/// never open the archive).
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
    /// Key of an encrypted archive (64 hex chars; omitted for plaintext ones).
    #[serde(default)]
    key_hex: Option<String>,
    /// Key store root directory (when keyHex is absent, the id is derived from
    /// the archive path and the key is taken from there; the TS side passes
    /// the clone-keys directory under globalStorage, so keys never land in the
    /// workspace/VCS).
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
    /// kode-server databaseSchema/build derivation output (tables/tableIndex,
    /// passed through as is).
    derivation: Value,
    /// Physical tables probed from the source database's information_schema
    /// (collected by the TS-side read-only session).
    physical_tables: Vec<PhysicalTableWire>,
    /// Row budget (defaults to 100_000; going over it is refused honestly).
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
    /// Typed rows read out of the source database (per table).
    rows: Vec<TypedRow>,
    /// Redaction switch (defaults to true: credential/personal columns are
    /// masked, §7 "never show passwords/tokens by default").
    #[serde(default = "default_true")]
    redact_sensitive: bool,
    /// Column order of the plan used for the export (needed so redaction can
    /// classify by column name; omitting it means no redaction).
    #[serde(default)]
    plan: Option<Value>,
    /// Key store root directory: when passed, the archive is written encrypted
    /// (chacha20poly1305, key stored separately by FileKeyStore with 0600,
    /// never co-located with the archive); by default a plaintext archive is
    /// written (backwards compatible).
    #[serde(default)]
    key_root: Option<String>,
}

fn default_true() -> bool {
    true
}

fn export_archive(params: Value) -> Result<Value, String> {
    let params: ExportParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    // KODE-FULL-016: same-target exports are mutually exclusive — take the
    // target lock first, then acquire/create the key and write the archive;
    // the guard lives until the function returns, serializing the whole write
    // (two concurrent first-time creations still yield only one key and one
    // complete archive). Plaintext exports have no keyRoot to take a lock on
    // and keep the original behavior.
    let _export_lock = params
        .key_root
        .as_ref()
        .map(|root| lock_export_target(&params.path, root))
        .transpose()?;
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

    // Group by table with a row count (end_table needs the per-table row count).
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
            // Redaction by column name requires knowing the column order;
            // silently skipping redaction when the plan is missing would be
            // fake protection.
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

    // Target Profile: the environment is only local/test (all other values are
    // fail-closed in validate_for_import).
    let target = TargetProfile {
        environment: parse_environment(&params.target.environment)?,
        db_interface: params.target.db_interface,
        writable: params.target.writable,
        host: params.target.host,
        port: params.target.port,
        database: params.target.database,
        engine_version: params.target.engine_version,
    };

    // Target snapshot: unique-key list + existing values (for dry-run conflict
    // comparison; collected by the TS-side read-only probing).
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

/// Archive row reads (the input for the TS-side literal binding / unique-key
/// probing during Apply; single-player scale).
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
// wire mapping helpers
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

    /// Mini derivation with the same shape as the databaseSchema/build output
    /// (root table + ARRAY child table).
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

        // planExport: derivation + physical → read-only SELECT plan.
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

        // export: row values + plan (redaction defaults on) → .kdpclone.
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

        // inspectArchive: returns only the manifest, never row values.
        let inspected = inspect_archive(json!({
            "path": archive_path.to_string_lossy()
        }))
        .unwrap();
        assert_eq!(inspected["entity"].as_str(), Some("Avatar"));
        assert_eq!(inspected["tables"].as_array().map(Vec::len), Some(2));
        assert!(inspected.get("rows").is_none());

        // planImport: archive + target (local/mysql/writable) + physical tables
        // + snapshot (hero taken) → plan.
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

        // export with keyRoot: lands encrypted + the key stored separately with
        // 0600 in the key root.
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

        // Static proof: the archive bytes contain no plaintext **payload**
        // (the row values of hero must not appear in plaintext).
        // Frame names (e.g. tables/tbl_Avatar.json) being plaintext in the
        // frame header is a format design decision — the header as a whole
        // serves as AEAD associated data (authenticated, not encrypted), and a
        // frame must be located by name before decryption; frame names are
        // metadata (like file names inside an encrypted zip), not row values.
        let raw = std::fs::read(&archive_path).unwrap();
        assert!(
            !raw.windows(b"hero".len()).any(|w| w == b"hero"),
            "归档明文含敏感载荷 hero:加密未生效"
        );

        // inspect with keyRoot: the manifest is readable, encrypted honestly true.
        let inspected = inspect_archive(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy()
        }))
        .unwrap();
        assert_eq!(inspected["encrypted"].as_bool(), Some(true));

        // inspect with no key and no keyRoot: reports honestly that an
        // encrypted archive needs its key.
        let no_key = inspect_archive(json!({
            "path": archive_path.to_string_lossy()
        }))
        .unwrap_err();
        assert!(
            no_key.contains("its key is required"),
            "缺钥错误话术: {no_key}"
        );

        // readArchiveRows with keyRoot: row values can be read back (the input
        // face for the import Apply phase).
        let rows = read_archive_rows(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy()
        }))
        .unwrap();
        assert_eq!(rows["tables"].as_array().map(Vec::len), Some(1));

        // planImport with keyRoot: the archive opens and the plan comes out.
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

        // Key lost (e.g. archive copied across machines): the read side never
        // silently generates a new key; it reports honestly naming the root and
        // the id.
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
        // Silently generating a new key would leave the archive unopenable
        // forever while pretending to be fine — the key root must still be empty.
        assert!(!keys.exists(), "读侧不得静默生成密钥");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn key_root_inside_archive_path_is_rejected() {
        let dir = temp_dir("enc-inside");
        let archive_path = dir.join("avatar.kdpclone");
        // Key root = the archive path itself: structurally refused (keys never
        // live next to the archive).
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

    /// PhysicalTableWire.engine absent → InnoDB (serde default = default_engine).
    #[test]
    fn physical_table_wire_defaults_engine_to_innodb() {
        let plan = plan_export(json!({
            "derivation": mini_derivation(),
            "physicalTables": [{
                "name": "tbl_Avatar",
                "columns": {"id": "bigint(20) unsigned", "sm_autoLoad": "tinyint", "sm_name": "varchar(255)"},
                "primaryKey": ["id"],
                "indexes": []
            }, {
                "name": "tbl_Avatar_items",
                "columns": {"id": "bigint(20) unsigned", "parentID": "bigint(20) unsigned", "sm_value": "varchar(255)"},
                "primaryKey": ["id"],
                "indexes": []
            }]
        }))
        .unwrap();
        assert_eq!(plan["queries"].as_array().map(Vec::len), Some(2));
    }

    /// Plaintext archive + keyRoot: the keyRoot branch sees is_encrypted=false
    /// → Ok(None), reads as usual.
    /// Plaintext archive + explicit keyHex: the keyHex-priority channel, key
    /// mismatched with plaintext → honest error.
    #[test]
    fn read_side_tolerates_key_root_on_plain_archive() {
        let dir = temp_dir("plain-root");
        let archive_path = dir.join("avatar.kdpclone");
        export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": false,
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":7}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ] }
            ]
        }))
        .unwrap();

        let rows = read_archive_rows(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": dir.join("clone-keys").to_string_lossy()
        }))
        .unwrap();
        assert!(
            rows.to_string().contains("hero"),
            "明文档带 keyRoot 应照常读"
        );

        let inspected = inspect_archive(json!({
            "path": archive_path.to_string_lossy(),
            "keyHex": "00".repeat(32)
        }));
        assert!(
            inspected.is_err(),
            "明文档配显式钥必须如实拒绝(钥不匹配明文)"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// redactSensitive defaults to true: omitting the field with no plan →
    /// refused (proves the default is true; with a default of false the export
    /// would succeed silently).
    #[test]
    fn export_redact_sensitive_defaults_to_true() {
        let dir = temp_dir("redact-default");
        let err = export_archive(json!({
            "path": dir.join("a.kdpclone").to_string_lossy(),
            "entity": "Avatar",
            "rows": []
        }))
        .unwrap_err();
        assert!(err.contains("requires the export plan"), "话术: {err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// With an encrypted archive's key lost, planImport reports honestly before
    /// opening the archive (resolve_read_key's `?`).
    #[test]
    fn plan_import_reports_missing_key_store_honestly() {
        let dir = temp_dir("plan-miss");
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
                ] }
            ]
        }))
        .unwrap();
        std::fs::remove_dir_all(&keys).unwrap();

        let err = plan_import(json!({
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
        .unwrap_err();
        assert!(
            err.contains("key is missing from the key store"),
            "planImport 缺钥话术: {err}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Mode/autoload parsing: documented values are accepted, unknown values
    /// are reported honestly.
    #[test]
    fn parse_mode_and_autoload_accept_documented_values_only() {
        assert_eq!(parse_mode(None).unwrap(), ImportMode::AllocateNewIds);
        assert_eq!(
            parse_mode(Some("allocate-new-ids")).unwrap(),
            ImportMode::AllocateNewIds
        );
        assert_eq!(
            parse_mode(Some("preserve-id-if-empty")).unwrap(),
            ImportMode::PreserveIfEmpty
        );
        assert!(parse_mode(Some("bogus"))
            .unwrap_err()
            .contains("unknown import mode `bogus`"));

        assert_eq!(parse_autoload(None).unwrap(), AutoLoadPolicy::ForceDisabled);
        assert_eq!(
            parse_autoload(Some("force-disabled")).unwrap(),
            AutoLoadPolicy::ForceDisabled
        );
        assert_eq!(
            parse_autoload(Some("preserve-archive")).unwrap(),
            AutoLoadPolicy::PreserveArchive
        );
        assert!(parse_autoload(Some("bogus"))
            .unwrap_err()
            .contains("unknown autoload policy `bogus`"));
    }

    /// planImport options: unique-seed reject/custom and the documented
    /// mode/autoload values flow through the wire end to end (a plan takes
    /// shape).
    #[test]
    fn plan_import_options_variants_shape_plans() {
        let dir = temp_dir("options");
        let archive_path = dir.join("avatar.kdpclone");
        export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": false,
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":7}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ] }
            ]
        }))
        .unwrap();

        let base = |options: serde_json::Value| {
            json!({
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
                "snapshot": { "uniqueKeys": [], "existingValues": [] },
                "options": options
            })
        };

        let plan = plan_import(base(json!({ "unique-seed": "reject" }))).unwrap();
        assert!(plan["statements"].as_array().is_some());
        let plan = plan_import(base(json!({ "unique-seed": "copy-1" }))).unwrap();
        assert!(plan["statements"].as_array().is_some());
        let plan = plan_import(base(json!({
            "mode": "preserve-id-if-empty",
            "autoload": "preserve-archive"
        })))
        .unwrap();
        assert!(plan["statements"].as_array().is_some());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_same_target_exports_serialize_and_archive_stays_openable() {
        // KODE-FULL-016: the barrier starts several same-target exports at
        // once — the target lock serializes the writes, every lane converges on
        // the same key (atomic first creation), and the final archive is
        // complete and openable with the stored key.
        // The probe only asserts outcomes; it never prints key material.
        let dir = temp_dir("export-race");
        let keys = dir.join("clone-keys");
        let archive_path = dir.join("avatar.kdpclone");

        const LANES: usize = 4;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(LANES));
        let handles: Vec<_> = (0..LANES)
            .map(|round| {
                let barrier = std::sync::Arc::clone(&barrier);
                let path = archive_path.to_string_lossy().into_owned();
                let key_root = keys.to_string_lossy().into_owned();
                std::thread::spawn(move || {
                    barrier.wait();
                    export_archive(json!({
                        "path": path,
                        "entity": "Avatar",
                        "redactSensitive": false,
                        "keyRoot": key_root,
                        "rows": [
                            { "table": "tbl_Avatar", "values": [
                                {"t":"big-u-int","v":"9007199254740993"}, {"t":"u-int","v":1}, {"t":"text","v": format!("hero-{round}")}
                            ]}
                        ]
                    }))
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        // Opening the final archive with the stored key: inspect succeeds,
        // encrypted is honestly true, and the entity matches.
        let inspected = inspect_archive(json!({
            "path": archive_path.to_string_lossy(),
            "keyRoot": keys.to_string_lossy()
        }))
        .unwrap();
        assert_eq!(inspected["encrypted"].as_bool(), Some(true));
        assert_eq!(inspected["entity"].as_str(), Some("Avatar"));

        // Exactly one key in the key root (4 lanes converging on first
        // creation) + one target lock; the lock never lands in the user's
        // export directory.
        let mut key_count = 0;
        let mut lock_count = 0;
        for entry in std::fs::read_dir(&keys).unwrap().filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".key") {
                key_count += 1;
            } else if name.ends_with(".export-lock") {
                lock_count += 1;
            }
        }
        assert_eq!(key_count, 1, "4 路并发首建必须收敛到一把钥");
        assert_eq!(lock_count, 1, "一目标一锁");
        assert!(
            !dir.join("avatar.kdpclone.export-lock").exists(),
            "锁文件不得落用户导出目录"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn export_lock_times_out_with_clear_error_when_held() {
        // KODE-FULL-016: while the lock is held, a second same-target export
        // waits a bounded time and then reports an error honestly, never
        // blocking forever; once the lock is released the same target can be
        // exported again right away.
        let dir = temp_dir("export-lock");
        let keys = dir.join("clone-keys");
        let archive_path = dir.join("avatar.kdpclone");

        let _held =
            lock_export_target(&archive_path.to_string_lossy(), &keys.to_string_lossy()).unwrap();
        let start = std::time::Instant::now();
        let blocked = export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": false,
            "keyRoot": keys.to_string_lossy(),
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":"9007199254740993"}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ]}
            ]
        }))
        .unwrap_err();
        assert!(
            blocked.contains("another export") && blocked.contains("in progress"),
            "有界等待话术: {blocked}"
        );
        // The wait is genuinely bounded (hard sanity upper bound well above the
        // limit: no more than 60s; measured slightly above the limit because the
        // lock wait precedes other work).
        assert!(start.elapsed().as_secs() < 60);

        drop(_held);
        let after = export_archive(json!({
            "path": archive_path.to_string_lossy(),
            "entity": "Avatar",
            "redactSensitive": false,
            "keyRoot": keys.to_string_lossy(),
            "rows": [
                { "table": "tbl_Avatar", "values": [
                    {"t":"big-u-int","v":"9007199254740993"}, {"t":"u-int","v":1}, {"t":"text","v":"hero"}
                ]}
            ]
        }))
        .unwrap();
        assert_eq!(after["encrypted"].as_bool(), Some(true));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
