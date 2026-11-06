//! Golden 验收(CLONE-P4 门,plan §6.2 Apply/Verify + §6.4):代表性 Avatar
//! 虚拟 Fixture → 导入计划 → **单事务执行 + 主键回填 + 提交后核对 + 受控清理**。
//!
//! 执行面是虚拟数据库(WriteExecutor 实现:staging/committed 两级,rollback 丢
//! staging,commit 才落 committed,自增主键按 MySQL 语义返回);真实 MySQL 连接
//! 不进本 crate(PDC-0003 环境同因)。断言面:
//! - 事务形状:begin ×1 / commit ×1 / 失败路径 rollback,提交前零可见数据;
//! - 占位回填:子行 parentID 绑定值 = 根行执行返回的真实新主键(PDC-0402);
//! - 失败注入任意行 → 全量回滚,重试全新 run,不静默重复(PDC-0405);
//! - 重复指纹默认拒绝并回显既有映射,「另建副本」显式放行(§6.4);
//! - Verify 逐表计数核对 + 清理计划逆拓扑序只生成不执行(PDC-0406/0408);
//! - 引擎加载验证记录如实 attempted=false(PDC-0407,环境属 P5 装配)。

use std::collections::BTreeMap;

use kode_db_clone::{
    archive_fingerprint, ApplyControl, ApplyOutcome, Archive, ArchiveWriter, CloneError,
    CloneSchema, DerivedField, DerivedTable, ImportApplier, ImportMode, ImportOptions,
    ImportPlanner, MemoryRunStore, PhysicalTable, RowSink, RuleSet, SchemaResolver, SchemaSource,
    TargetEnvironment, TargetProfile, TargetSnapshot, TypedRow, TypedValue, UniqueKey,
    VirtualSchema, WriteExecutor,
};

// ---- 与 golden_import.rs 同源的 Avatar 三级代表结构(集成测试独立二进制) ----

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
    // sm_name 唯一键且 hero 已占用 → 计划期触发本地重建(hero_imported1)。
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

// ---- 虚拟数据库(staging/committed 两级 + MySQL 自增语义) ----

#[derive(Default)]
struct VirtualDb {
    next_auto_id: u64,
    staged: BTreeMap<String, Vec<Vec<TypedValue>>>,
    committed: BTreeMap<String, Vec<Vec<TypedValue>>>,
    write_log: Vec<String>,
    begins: usize,
    commits: usize,
    rollbacks: usize,
    /// 命中即模拟约束失败(唯一键冲突)的 SQL 子串。
    fail_needle: Option<String>,
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

/// 从 "INSERT INTO <t> (…"/"DELETE FROM <t> …"/"SELECT COUNT(*) FROM <t> WHERE …"
/// 提取表名。
fn table_of(sql: &str) -> &str {
    let tokens: Vec<&str> = sql.split_whitespace().collect();
    match tokens.first() {
        // INSERT/DELETE 的表名在第 3 词,SELECT COUNT 的在第 4 词。
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
        // MySQL 语义:绑 NULL 的自增主键由库分配,回填进落库行。
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
            .unwrap_or(0))
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

    // ---- 事务形状:一开一提零回滚;执行序父先子后 ----
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

    // ---- 落库值:根行 = 新主键 1000 + autoLoad 禁用 0 + 重建名 hero_imported1 ----
    assert_eq!(
        db.committed.get("tbl_Avatar"),
        Some(&vec![vec![
            TypedValue::BigUInt(1000),
            TypedValue::UInt(0),
            TypedValue::Text("hero_imported1".into()),
        ]])
    );
    // 子行 parentID 绑定根行真实新主键(占位回填,PDC-0402)。
    let items = db.committed.get("tbl_Avatar_items").unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0][1], TypedValue::BigUInt(1000));
    assert_eq!(items[1][1], TypedValue::BigUInt(1000));
    let gold = db.committed.get("tbl_Avatar_gold").unwrap();
    assert_eq!(gold[0][1], TypedValue::BigUInt(1000));

    // ---- Run 审计:计数/回填映射/根句柄/指纹 ----
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

    // ---- Verify:逐表 found == expected,全过 ----
    assert!(run.verify.passed);
    assert_eq!(run.verify.checks.len(), 3);
    for check in &run.verify.checks {
        assert!(check.ok, "{:?} not ok", check);
    }

    // ---- 清理计划:逆拓扑序(子先父后),只生成不执行 ----
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
    // 执行面从未出现 DELETE(永不自动清理)。
    assert!(!db.write_log.iter().any(|s| s.contains("DELETE")));

    // ---- 账号绑定/加载验证的诚实面 ----
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

    // ---- Run 可序列化审计 ----
    let json = serde_json::to_value(&run).unwrap();
    assert!(json.get("resolved_ids").is_some());
    assert!(json.get("cleanup").is_some());

    // ---- 指纹内容敏感:另一份归档(根名不同)指纹不同 ----
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

    // 第 3 条(第二行 items)注入失败:回滚后零提交、零登记。
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

    // 重试(无注入,同执行器):全新事务成功,恰好一套数据,不静默续写。
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
    // 唯一键冲突原样上抛(PDC-0403:唯一错误不静默吞)。
    assert!(matches!(err, CloneError::ImportConflict(_)));
    assert_eq!(db.rollbacks, 1);
    assert_eq!(db.committed_total(), 0);
    // 根表那条已执行过(随后回滚),子表一条都没到执行面。
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

    // 同归档第二次:默认拒绝,回显既有映射(§6.4),一条新语句都不发。
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

    // 显式「另建副本」:放行,第二套数据、run 2。
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
