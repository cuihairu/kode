//! Golden acceptance (CLONE-P4 gate, plan §6.2 Apply/Verify + §6.4): a representative
//! Avatar virtual fixture -> import plan -> **single-transaction execution + primary
//! key backfill + post-commit verification + controlled cleanup**.
//!
//! The execution face is a virtual database (a WriteExecutor implementation: staging/
//! committed two levels, rollback drops staging, only commit lands in committed,
//! auto-increment primary keys returned per MySQL semantics); real MySQL connections
//! do not enter this crate (PDC-0003, same-environment reason). Assertions:
//! - transaction shape: begin x1 / commit x1 / rollback on failure, zero visible data
//!   before commit;
//! - placeholder backfill: child row parentID bound value = the real new primary key
//!   returned by the root row execution (PDC-0402);
//! - failure injected at any row -> full rollback, retry starts a fresh run, no silent
//!   duplication (PDC-0405);
//! - duplicate fingerprint rejected by default and echoes the existing mapping;
//!   "create another copy" is an explicit opt-in (§6.4);
//! - Verify per-table count checks + cleanup plan in reverse topological order,
//!   generated but never executed (PDC-0406/0408);
//! - engine load verification honestly recorded attempted=false (PDC-0407,
//!   environment belongs to P5 wiring).

use std::collections::BTreeMap;

use kode_db_clone::{
    archive_fingerprint, ApplyControl, ApplyOutcome, Archive, ArchiveWriter, AutoLoadPolicy,
    CloneError, CloneSchema, DerivedField, DerivedTable, ImportApplier, ImportMode, ImportOptions,
    ImportPlanner, ImportRunStore, MemoryRunStore, PhysicalTable, RowSink, RuleSet, SchemaResolver,
    SchemaSource, TargetEnvironment, TargetProfile, TargetSnapshot, TypedRow, TypedValue,
    UniqueKey, UniquePolicy, VerifyState, VirtualSchema, WriteExecutor,
};

// ---- Avatar three-level representative structure shared with golden_import.rs (integration tests are separate binaries) ----

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

fn avatar_physical() -> VirtualSchema {
    let mut v = VirtualSchema::default();
    let mut add = |name: &str, cols: &[(&str, &str)]| {
        let mut columns = BTreeMap::new();
        for (c, t) in cols {
            columns.insert((*c).to_string(), (*t).to_string());
        }
        v.tables.insert(
            name.to_string(),
            PhysicalTable {
                name: name.to_string(),
                engine: "InnoDB".into(),
                columns,
                primary_key: vec!["id".into()],
                indexes: vec![],
            },
        );
    };
    add(
        "tbl_Avatar",
        &[
            ("id", "bigint(20) unsigned"),
            ("sm_autoLoad", "tinyint"),
            ("sm_name", "varchar(255)"),
        ],
    );
    add(
        "tbl_Avatar_items",
        &[
            ("id", "bigint(20) unsigned"),
            ("parentID", "bigint(20) unsigned"),
            ("sm_value", "varchar(255)"),
        ],
    );
    add(
        "tbl_Avatar_gold",
        &[
            ("id", "bigint(20) unsigned"),
            ("parentID", "bigint(20) unsigned"),
            ("sm_amount", "int"),
        ],
    );
    v
}

fn local_target() -> TargetProfile {
    TargetProfile {
        environment: TargetEnvironment::Local,
        db_interface: "mysql".into(),
        writable: true,
        host: "127.0.0.1".into(),
        port: 3306,
        database: "kbe_local".into(),
        engine_version: None,
    }
}

fn row(table: &str, values: Vec<TypedValue>) -> TypedRow {
    TypedRow {
        table: table.into(),
        values,
    }
}

fn write_archive(dir: &std::path::Path, name: &str, root_name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
    writer
        .write_row(
            "tbl_Avatar",
            &row(
                "tbl_Avatar",
                vec![
                    TypedValue::BigUInt(7),
                    TypedValue::UInt(1),
                    TypedValue::Text(root_name.into()),
                ],
            ),
        )
        .unwrap();
    writer.end_table("tbl_Avatar", 1).unwrap();
    writer
        .write_row(
            "tbl_Avatar_items",
            &row(
                "tbl_Avatar_items",
                vec![
                    TypedValue::BigUInt(100),
                    TypedValue::BigUInt(7),
                    TypedValue::Text("sword".into()),
                ],
            ),
        )
        .unwrap();
    writer
        .write_row(
            "tbl_Avatar_items",
            &row(
                "tbl_Avatar_items",
                vec![
                    TypedValue::BigUInt(101),
                    TypedValue::BigUInt(7),
                    TypedValue::Text("shield".into()),
                ],
            ),
        )
        .unwrap();
    writer.end_table("tbl_Avatar_items", 2).unwrap();
    writer
        .write_row(
            "tbl_Avatar_gold",
            &row(
                "tbl_Avatar_gold",
                vec![
                    TypedValue::BigUInt(200),
                    TypedValue::BigUInt(7),
                    TypedValue::Int(5000),
                ],
            ),
        )
        .unwrap();
    writer.end_table("tbl_Avatar_gold", 1).unwrap();
    writer
        .finalize(
            &[],
            &kode_db_clone::redact::RedactionReport { entries: vec![] },
        )
        .unwrap();
    path
}

fn occupied_hero_snapshot() -> TargetSnapshot {
    // sm_name is a unique key and "hero" is already occupied → planning triggers a
    // local rebuild (hero_imported1).
    let mut snapshot = TargetSnapshot::default();
    snapshot.unique_keys.push(UniqueKey {
        table: "tbl_Avatar".into(),
        column: "sm_name".into(),
    });
    snapshot.add_existing("tbl_Avatar", "sm_name", TypedValue::Text("hero".into()));
    snapshot
}

fn plan_for(archive: &Archive) -> kode_db_clone::ImportPlan {
    let derived = avatar_derived();
    let resolved = SchemaResolver::resolve(&derived, &avatar_physical()).unwrap();
    ImportPlanner::plan(
        archive,
        &local_target(),
        &derived,
        &resolved,
        &RuleSet::default(),
        &occupied_hero_snapshot(),
        &ImportOptions::default(),
    )
    .unwrap()
}

// ---- Virtual database (staging/committed two levels + MySQL auto-increment
// semantics) ----

#[derive(Default)]
struct VirtualDb {
    next_auto_id: u64,
    staged: BTreeMap<String, Vec<Vec<TypedValue>>>,
    committed: BTreeMap<String, Vec<Vec<TypedValue>>>,
    write_log: Vec<String>,
    begins: usize,
    commits: usize,
    rollbacks: usize,
    /// SQL substring that, when hit, simulates a constraint failure (unique key
    /// conflict).
    fail_needle: Option<String>,
    /// Row count under-reported during verification (verification-failure
    /// injection face).
    undercount_by: u64,
    /// Verification-phase count-query error injection face (KODE-FULL-009).
    verify_error: Option<String>,
}

impl VirtualDb {
    fn new() -> Self {
        Self {
            next_auto_id: 1000,
            ..Self::default()
        }
    }

    fn committed_rows(&self, table: &str) -> usize {
        self.committed.get(table).map(Vec::len).unwrap_or(0)
    }

    fn committed_total(&self) -> usize {
        self.committed.values().map(Vec::len).sum()
    }
}

/// Extracts the table name from "INSERT INTO <t> (…"/"DELETE FROM <t> …"/
/// "SELECT COUNT(*) FROM <t> WHERE …".
fn table_of(sql: &str) -> &str {
    let tokens: Vec<&str> = sql.split_whitespace().collect();
    match tokens.first() {
        // INSERT/DELETE table name is the 3rd word; SELECT COUNT's is the 4th.
        Some(&"SELECT") => tokens.get(3).copied().unwrap_or(""),
        _ => tokens.get(2).copied().unwrap_or(""),
    }
}

impl WriteExecutor for VirtualDb {
    fn begin(&mut self) -> kode_db_clone::CloneResult<()> {
        self.begins += 1;
        self.staged.clear();
        Ok(())
    }

    fn execute_insert(
        &mut self,
        sql: &str,
        params: &[TypedValue],
    ) -> kode_db_clone::CloneResult<u64> {
        if let Some(needle) = &self.fail_needle {
            if sql.contains(needle.as_str()) {
                return Err(CloneError::ImportConflict(
                    "duplicate entry 'hero_imported1' for key 'sm_name'".into(),
                ));
            }
        }
        let new_id = self.next_auto_id;
        self.next_auto_id += 1;
        // MySQL semantics: an auto-increment primary key bound as NULL is allocated
        // by the database and backfilled into the stored row.
        let mut stored = params.to_vec();
        if stored.first() == Some(&TypedValue::Null) {
            stored[0] = TypedValue::BigUInt(new_id);
        }
        self.staged
            .entry(table_of(sql).to_string())
            .or_default()
            .push(stored);
        self.write_log.push(sql.to_string());
        Ok(new_id)
    }

    fn query_count(&mut self, sql: &str, params: &[TypedValue]) -> kode_db_clone::CloneResult<u64> {
        if let Some(msg) = &self.verify_error {
            return Err(CloneError::ImportRejected(msg.clone()));
        }
        let table = table_of(sql);
        let ids: Vec<&TypedValue> = params.iter().collect();
        Ok(self
            .committed
            .get(table)
            .map(|rows| {
                rows.iter()
                    .filter(|r| r.first().is_some_and(|id| ids.contains(&id)))
                    .count() as u64
            })
            .unwrap_or(0)
            .saturating_sub(self.undercount_by))
    }

    fn rollback(&mut self) -> kode_db_clone::CloneResult<()> {
        self.rollbacks += 1;
        self.staged.clear();
        Ok(())
    }

    fn commit(&mut self) -> kode_db_clone::CloneResult<()> {
        self.commits += 1;
        for (table, rows) in std::mem::take(&mut self.staged) {
            self.committed.entry(table).or_default().extend(rows);
        }
        Ok(())
    }
}

fn fixture(dir: &std::path::Path) -> (kode_db_clone::ImportPlan, Archive) {
    let path = write_archive(dir, "avatar.kdpclone", "hero");
    let archive = Archive::open(&path, None).unwrap();
    let plan = plan_for(&archive);
    (plan, archive)
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kdp-golden-apply-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn golden_apply_single_transaction_with_pk_backfill_and_verify() {
    let dir = temp_dir("main");
    let (plan, archive) = fixture(&dir);

    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let outcome = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap();

    let run = match outcome {
        ApplyOutcome::Applied(run) => run,
        ApplyOutcome::DuplicateRejected(_) => panic!("first import must apply"),
    };

    // ---- Transaction shape: one begin, one commit, zero rollbacks; execution
    // order parents before children ----
    assert_eq!(db.begins, 1);
    assert_eq!(db.commits, 1);
    assert_eq!(db.rollbacks, 0);
    let order: Vec<&str> = db.write_log.iter().map(|s| table_of(s)).collect();
    assert_eq!(
        order,
        vec![
            "tbl_Avatar",
            "tbl_Avatar_items",
            "tbl_Avatar_items",
            "tbl_Avatar_gold"
        ]
    );

    // ---- Stored values: root row = new primary key 1000 + autoLoad disabled 0 +
    // rebuilt name hero_imported1 ----
    assert_eq!(
        db.committed.get("tbl_Avatar"),
        Some(&vec![vec![
            TypedValue::BigUInt(1000),
            TypedValue::UInt(0),
            TypedValue::Text("hero_imported1".into()),
        ]])
    );
    // Child rows' parentID binds the root row's real new primary key (placeholder
    // backfill, PDC-0402).
    let items = db.committed.get("tbl_Avatar_items").unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0][1], TypedValue::BigUInt(1000));
    assert_eq!(items[1][1], TypedValue::BigUInt(1000));
    let gold = db.committed.get("tbl_Avatar_gold").unwrap();
    assert_eq!(gold[0][1], TypedValue::BigUInt(1000));

    // ---- Run audit: counts / backfill mapping / root handle / fingerprint ----
    assert_eq!(run.run_id, 1);
    assert_eq!(run.mode, ImportMode::AllocateNewIds);
    assert_eq!(
        run.inserted_per_table,
        BTreeMap::from([
            ("tbl_Avatar".to_string(), 1),
            ("tbl_Avatar_items".to_string(), 2),
            ("tbl_Avatar_gold".to_string(), 1),
        ])
    );
    assert_eq!(
        run.resolved_ids,
        BTreeMap::from([(1, 1000), (2, 1001), (3, 1002), (4, 1003)])
    );
    assert_eq!(run.new_root_id, Some(1000));
    assert_eq!(
        run.archive_fingerprint,
        archive_fingerprint(&archive).unwrap()
    );
    assert_eq!(store.runs().len(), 1);

    // ---- Verify: per table found == expected, all pass ----
    assert!(run.verify.passed);
    assert_eq!(run.verify.checks.len(), 3);
    for check in &run.verify.checks {
        assert!(check.ok, "{:?} not ok", check);
    }

    // ---- Cleanup plan: reverse topological order (children before parents),
    // generated but never executed ----
    let tables: Vec<&str> = run.cleanup.steps.iter().map(|s| table_of(&s.sql)).collect();
    assert_eq!(
        tables,
        vec!["tbl_Avatar_gold", "tbl_Avatar_items", "tbl_Avatar"]
    );
    assert_eq!(
        run.cleanup.steps[2].sql,
        "DELETE FROM tbl_Avatar WHERE id IN (?)"
    );
    assert_eq!(run.cleanup.steps[2].params, vec![TypedValue::BigUInt(1000)]);
    assert!(run
        .cleanup
        .preconditions
        .iter()
        .any(|p| p.contains("not currently loaded by a local KBEngine server")));
    // The execution face never sees a DELETE (cleanup is never automatic).
    assert!(!db.write_log.iter().any(|s| s.contains("DELETE")));

    // ---- Account binding / load verification honest face ----
    assert!(!run.binding.applied);
    assert!(run
        .binding
        .note
        .contains("not visible to any local account"));
    assert!(!run.load_verification.attempted);
    assert!(run
        .load_verification
        .note
        .contains("not attempted: local KBEngine wiring"));

    // ---- Run serializable audit ----
    let json = serde_json::to_value(&run).unwrap();
    assert!(json.get("resolved_ids").is_some());
    assert!(json.get("cleanup").is_some());

    // ---- Fingerprint is content-sensitive: another archive (different root
    // name) yields a different fingerprint ----
    let other = write_archive(&dir, "other.kdpclone", "rival");
    let other_archive = Archive::open(&other, None).unwrap();
    assert_ne!(
        archive_fingerprint(&other_archive).unwrap(),
        run.archive_fingerprint
    );

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn injected_failure_at_any_row_rolls_back_and_retry_is_clean() {
    let dir = temp_dir("fail");
    let (plan, archive) = fixture(&dir);

    // Inject failure at statement 3 (the second items row): after rollback, zero
    // commits and zero run records.
    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let control = ApplyControl {
        fail_at_statement: Some(3),
        ..ApplyControl::default()
    };
    let err = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &control,
        )
        .unwrap_err();
    assert!(err.to_string().contains("injected failure at statement 3"));
    assert!(err.to_string().contains("nothing committed"));
    assert_eq!(db.begins, 1);
    assert_eq!(db.rollbacks, 1);
    assert_eq!(db.commits, 0);
    assert_eq!(db.committed_total(), 0);
    assert!(store.runs().is_empty());

    // Retry (no injection, same executor): a fresh transaction succeeds with exactly
    // one copy of the data, no silent continuation.
    let outcome = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap();
    assert!(matches!(outcome, ApplyOutcome::Applied(_)));
    assert_eq!(db.begins, 2);
    assert_eq!(db.commits, 1);
    assert_eq!(db.committed_total(), 4);
    assert_eq!(store.runs().len(), 1);

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn executor_constraint_error_midway_rolls_back() {
    let dir = temp_dir("conflict");
    let (plan, archive) = fixture(&dir);

    let mut db = VirtualDb::new();
    db.fail_needle = Some("tbl_Avatar_items".into());
    let mut store = MemoryRunStore::new();
    let err = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap_err();
    // The unique key conflict is propagated as-is (PDC-0403: unique errors are
    // never silently swallowed).
    assert!(matches!(err, CloneError::ImportConflict(_)));
    assert_eq!(db.rollbacks, 1);
    assert_eq!(db.committed_total(), 0);
    // The root-table statement did execute (then rolled back); not a single child
    // statement reached the execution face.
    assert_eq!(db.write_log.len(), 1);
    assert!(store.runs().is_empty());

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn duplicate_fingerprint_rejected_until_explicitly_allowed() {
    let dir = temp_dir("dup");
    let (plan, archive) = fixture(&dir);

    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let first = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap();
    let first_run = match first {
        ApplyOutcome::Applied(run) => run,
        _ => panic!("first import must apply"),
    };
    assert_eq!(first_run.run_id, 1);
    let writes_after_first = db.write_log.len();

    // Second run of the same archive: rejected by default, echoing the existing
    // mapping (§6.4), without sending a single new statement.
    let second = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap();
    match &second {
        ApplyOutcome::DuplicateRejected(dup) => {
            assert_eq!(dup.prior_run.run_id, 1);
            assert_eq!(dup.prior_run.new_root_id, Some(1000));
        }
        _ => panic!("same fingerprint must be rejected by default"),
    }
    assert_eq!(db.write_log.len(), writes_after_first);
    assert_eq!(db.begins, 1);

    // Explicit "create another copy": allowed, second copy of the data, run 2.
    let third = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl {
                allow_duplicate: true,
                ..ApplyControl::default()
            },
        )
        .unwrap();
    match third {
        ApplyOutcome::Applied(run) => {
            assert_eq!(run.run_id, 2);
            assert_eq!(run.new_root_id, Some(1004));
        }
        _ => panic!("explicit allow_duplicate must apply a second copy"),
    }
    assert_eq!(db.committed_rows("tbl_Avatar"), 2);
    assert_eq!(db.committed_total(), 8);

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn apply_of_plan_with_statementless_tables_skips_verify_and_cleanup_for_them() {
    // The archive has only the root row: items/gold appear in order but have no
    // statements → Verify skips them at 0, and the cleanup plan generates no steps
    // for tables without new keys (answerable only for tables actually imported).
    let dir = temp_dir("root-only");
    let path = write_archive_root_only(&dir, "root-only.kdpclone");
    let archive = Archive::open(&path, None).unwrap();
    let plan = plan_for(&archive);
    assert_eq!(plan.statements.len(), 1);
    assert_eq!(plan.order.len(), 3);

    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let outcome = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap();
    let run = match outcome {
        ApplyOutcome::Applied(run) => run,
        _ => panic!("root-only import must apply"),
    };
    assert_eq!(run.inserted_per_table.get("tbl_Avatar"), Some(&1));
    assert!(!run.inserted_per_table.contains_key("tbl_Avatar_items"));
    // Verify: only tables with statements are checked.
    assert_eq!(run.verify.checks.len(), 1);
    assert_eq!(run.verify.checks[0].table, "tbl_Avatar");
    assert!(run.verify.passed);
    // Cleanup plan: DELETE steps generated only for tables with new primary keys.
    assert_eq!(run.cleanup.steps.len(), 1);
    assert!(run.cleanup.steps[0].sql.contains("tbl_Avatar"));
    assert_eq!(db.committed_total(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

fn write_archive_root_only(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    let mut writer = ArchiveWriter::new(&path, None, "Avatar").unwrap();
    writer
        .write_row(
            "tbl_Avatar",
            &row(
                "tbl_Avatar",
                vec![
                    TypedValue::BigUInt(7),
                    TypedValue::UInt(1),
                    TypedValue::Text("hero".into()),
                ],
            ),
        )
        .unwrap();
    writer.end_table("tbl_Avatar", 1).unwrap();
    writer
        .finalize(
            &[],
            &kode_db_clone::redact::RedactionReport { entries: vec![] },
        )
        .unwrap();
    path
}

#[test]
fn apply_records_declared_account_binding_without_credential_writes() {
    // An account binding rule is declared: Apply only records the fact
    // (declaration / applied=false), never writing credentials or account tables
    // (PDC-0306).
    let dir = temp_dir("binding");
    let (mut plan, archive) = fixture(&dir);
    plan.account_binding = kode_db_clone::AccountBindingPlan {
        declaration: Some("Account.characters".into()),
        login_ready: true,
        note: "binding rule declared via Account.characters".into(),
    };

    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let outcome = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap();
    let run = match outcome {
        ApplyOutcome::Applied(run) => run,
        _ => panic!("binding import must apply"),
    };
    assert_eq!(
        run.binding.declaration.as_deref(),
        Some("Account.characters")
    );
    assert!(!run.binding.applied);
    assert!(run.binding.note.contains("recorded"));
    // Binding produces no extra write statements: the write log holds only the 4
    // INSERTs.
    assert_eq!(db.write_log.len(), 4);
    assert!(db
        .write_log
        .iter()
        .all(|sql| sql.starts_with("INSERT INTO")));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn verify_undercount_surfaces_post_commit_drift_and_records_run() {
    // Post-commit verification fails: DriftMismatch reported honestly; the data is
    // already atomically committed and the run is recorded as usual (the duplicate
    // import gate :249 identifies retries of the same import by fingerprint —
    // verification failures are recorded too, otherwise a retry would duplicate the
    // data while the gate does not recognize it; forced re-import goes through the
    // allow_duplicate face).
    let dir = temp_dir("undercount");
    let (plan, archive) = fixture(&dir);

    let mut db = VirtualDb::new();
    db.undercount_by = 1; // verification under-reports one row → found != expected
    let mut store = MemoryRunStore::new();
    let err = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap_err();
    assert!(
        matches!(err, CloneError::DriftMismatch(ref m) if m.contains("post-commit verification failed")),
        "{err:?}"
    );
    // The data is committed (atomically complete, committed transactions are not
    // rolled back); the run is recorded so the retry gate can identify it.
    assert_eq!(db.committed_total(), 4);
    assert_eq!(db.begins, 1);
    assert_eq!(db.commits, 1);
    let fingerprint = archive_fingerprint(&archive).unwrap();
    assert!(store.find_by_fingerprint(&fingerprint).is_some());

    // Retrying the same import (allow_duplicate off) → the duplicate import gate
    // rejects it now; the database is not written a second time.
    match ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .expect("retry must be rejected as duplicate")
    {
        ApplyOutcome::DuplicateRejected(dup) => {
            assert!(!dup.prior_run.verify.passed);
        }
        other => panic!("expected DuplicateRejected, got {other:?}"),
    }
    // The retry wrote nothing (the gate fires before writing)
    assert_eq!(db.commits, 1);

    // Only allow_duplicate lets it through (the forced re-import face is
    // unaffected)
    let mut store2 = MemoryRunStore::new();
    let err2 = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store2,
            &ApplyControl {
                allow_duplicate: true,
                ..ApplyControl::default()
            },
        )
        .unwrap_err();
    assert!(
        matches!(err2, CloneError::DriftMismatch(ref m) if m.contains("post-commit verification failed")),
        "{err2:?}"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn pre_begin_validation_rejects_drift_before_transaction_opens() {
    // KODE-FULL-010: table/row/column-width validation moved before begin — drift
    // errors no longer land inside an already-opened transaction (the old basis let
    // `?` pass straight through after begin, bypassing rollback); remaining
    // in-transaction error paths are uniformly rolled back by TxnGuard.
    let dir = temp_dir("prebegin");
    let (mut plan, archive) = fixture(&dir);

    // Arm 1: a statement references a table absent from the archive — rejected
    // before begin, zero transaction overhead.
    plan.statements[0].table = "tbl_Missing".into();
    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let err = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap_err();
    assert!(
        matches!(err, CloneError::DriftMismatch(ref m) if m.contains("tbl_Missing")
            && m.contains("absent from the archive")),
        "{err:?}"
    );
    assert_eq!(
        db.begins, 0,
        "validation happens before begin; no transaction opened"
    );
    assert_eq!(db.rollbacks, 0);
    assert_eq!(db.committed_total(), 0);
    assert!(store.runs().is_empty());

    // Arm 2: three-way column width mismatch (cells/columns/archive row values) —
    // rejected by the same gate up front; the old basis's silently truncating zip
    // would have become a locally misaligned insert.
    let (mut plan2, archive2) = fixture(&dir);
    plan2.statements[0].columns.push("sm_extra".into());
    let mut db2 = VirtualDb::new();
    let err2 = ImportApplier
        .apply(
            &plan2,
            &archive2,
            &local_target(),
            &mut db2,
            &mut MemoryRunStore::new(),
            &ApplyControl::default(),
        )
        .unwrap_err();
    assert!(
        matches!(err2, CloneError::DriftMismatch(ref m) if m.contains("column arity mismatch")),
        "{err2:?}"
    );
    assert_eq!(db2.begins, 0);

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn verify_query_error_after_commit_still_records_run_for_retry() {
    // KODE-FULL-009: the count query errors after a successful commit — the run
    // must already be recorded by fingerprint (the ledger precedes verification
    // I/O, no more `?` punching straight through and losing the record), verify
    // state = unknown; retrying the same archive goes through the duplicate import
    // gate echoing prior_run, so the database data is not duplicated.
    let dir = temp_dir("verr");
    let (plan, archive) = fixture(&dir);

    let mut db = VirtualDb::new();
    db.verify_error = Some("verify connection lost".into());
    let mut store = MemoryRunStore::new();
    let err = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap_err();
    assert!(
        matches!(err, CloneError::ImportRejected(ref m) if m.contains("post-commit verification errored")),
        "{err:?}"
    );
    assert!(err.to_string().contains("is recorded"));
    // The data is committed (atomically complete); the verification error does not
    // roll it back.
    assert_eq!(db.committed_total(), 4);
    assert_eq!(db.begins, 1);
    assert_eq!(db.commits, 1);
    // Recorded: the fingerprint gate can retrieve it; verify state unknown
    // (≠ failed), mapping / cleanup plan intact.
    let fingerprint = archive_fingerprint(&archive).unwrap();
    let recorded = store
        .find_by_fingerprint(&fingerprint)
        .expect("run must be recorded even when verify errored");
    assert_eq!(recorded.verify.state, VerifyState::Unknown);
    assert!(!recorded.verify.passed);
    assert!(recorded
        .verify
        .error
        .as_deref()
        .is_some_and(|e| e.contains("verify connection lost")));
    assert!(!recorded.resolved_ids.is_empty());
    assert!(!recorded.cleanup.steps.is_empty());

    // Retrying the same archive: the gate fires before writing, echoing the same
    // run; the database data is not duplicated.
    match ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .expect("retry must hit the duplicate gate, not re-insert")
    {
        ApplyOutcome::DuplicateRejected(dup) => {
            assert_eq!(dup.prior_run.run_id, recorded.run_id);
            assert_eq!(dup.prior_run.verify.state, VerifyState::Unknown);
            assert!(!dup.prior_run.resolved_ids.is_empty());
        }
        other => panic!("expected DuplicateRejected, got {other:?}"),
    }
    assert_eq!(db.committed_total(), 4, "retry must not insert twice");
    assert_eq!(db.commits, 1, "retry opened no new transaction");

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn preserve_mode_verify_finds_archived_ids_and_root_handle() {
    // PreserveIfEmpty end-to-end contract (plan §6.1): primary keys/references land
    // in the database with the archive's original values; post-commit verification
    // and the root handle must take the "archive original values" — verification
    // found == expected (no false DriftMismatch), new_root_id = the archive's
    // original id (not None).
    let dir = temp_dir("preserve");
    let path = write_archive(&dir, "preserve.kdpclone", "hero");
    let archive = Archive::open(&path, None).unwrap();
    let derived = avatar_derived();
    let resolved = SchemaResolver::resolve(&derived, &avatar_physical()).unwrap();
    let plan = ImportPlanner::plan(
        &archive,
        &local_target(),
        &derived,
        &resolved,
        &RuleSet::default(),
        &TargetSnapshot::default(),
        &ImportOptions {
            mode: ImportMode::PreserveIfEmpty,
            autoload: AutoLoadPolicy::PreserveArchive,
            unique: UniquePolicy::Reject,
        },
    )
    .unwrap();

    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let outcome = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap();
    let run = match outcome {
        ApplyOutcome::Applied(run) => run,
        ApplyOutcome::DuplicateRejected(_) => panic!("preserve import must apply"),
    };

    // Archive original values land in the database (id 7 / 100 / 101 / 200,
    // autoLoad keeps its original 1).
    assert_eq!(run.mode, ImportMode::PreserveIfEmpty);
    assert_eq!(
        db.committed.get("tbl_Avatar"),
        Some(&vec![vec![
            TypedValue::BigUInt(7),
            TypedValue::UInt(1),
            TypedValue::Text("hero".into()),
        ]])
    );

    // Verify: per table found == expected (the archive's original ids are
    // queryable row by row), all pass with no false report.
    assert!(run.verify.passed);
    assert_eq!(run.verify.checks.len(), 3);
    for check in &run.verify.checks {
        assert!(check.ok, "{:?} not ok", check);
        assert_eq!(check.found, check.expected);
    }

    // Root handle = the archive's original id (contract "in preserve mode it is the
    // archive's original value"; must not be None).
    assert_eq!(run.new_root_id, Some(7));

    // The cleanup plan likewise references the archive's original id (generated,
    // never executed).
    assert_eq!(run.cleanup.steps.len(), 3);
    assert_eq!(run.cleanup.steps[2].params, vec![TypedValue::BigUInt(7)]);
    assert!(!db.write_log.iter().any(|s| s.contains("DELETE")));

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn order_violation_gate_rolls_back_staged_rows() {
    // The plan is externally shuffled (child rows before parent rows): placeholder
    // order violation → fail closed, and the staged rows of earlier statements must
    // be rolled back with no half-copy left (the failure path guarantees rollback).
    let dir = temp_dir("order-violation");
    let (mut plan, archive) = fixture(&dir);
    assert_eq!(plan.statements.len(), 4);
    plan.statements.swap(0, 1); // moves the items statement ahead of the root one

    let mut db = VirtualDb::new();
    let mut store = MemoryRunStore::new();
    let err = ImportApplier
        .apply(
            &plan,
            &archive,
            &local_target(),
            &mut db,
            &mut store,
            &ApplyControl::default(),
        )
        .unwrap_err();
    assert!(
        matches!(err, CloneError::InvalidRule(ref m) if m.contains("order violation")),
        "{err:?}"
    );
    assert_eq!(db.rollbacks, 1);
    assert_eq!(db.committed_total(), 0);
    std::fs::remove_dir_all(&dir).unwrap();
}
