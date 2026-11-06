//! Golden 验收(CLONE-P3 门,plan §6/§7):代表性 Avatar 虚拟 Fixture →
//! 归档 → 导入计划黄金断言。
//!
//! 虚拟 Fixture 不经真实 MySQL(PDC-0003/0007 被阻塞):归档以 ArchiveWriter
//! 现场构造(真实帧格式/校验和),目标现场以 TargetSnapshot 给出,断言
//! 执行序、占位共享、唯一键重建、策略覆写、账号绑定告警与预演摘要——
//! 计划期全程不触库,语句一律 `?` 参数化。

use std::collections::BTreeMap;

use kode_db_clone::{
    Archive, ArchiveWriter, AutoLoadPolicy, CloneSchema, DerivedField, DerivedTable, IdCategory,
    ImportMode, ImportOptions, ImportPlanner, MappedId, PhysicalTable, PlannedCell, RowSink,
    RuleSet, SchemaResolver, SchemaSource, TargetEnvironment, TargetProfile, TargetSnapshot,
    TypedRow, TypedValue, UniqueKey, VirtualSchema,
};

fn field(name: &str, type_label: &str) -> DerivedField {
    DerivedField {
        name: name.into(),
        type_label: type_label.into(),
        identifier: name == "id",
        synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
        source: SchemaSource::Def,
    }
}

/// 根表 + ARRAY(items)+ ENTITY_COMPONENT(gold)三级代表结构。
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
    let mut items = DerivedTable {
        name: "tbl_Avatar_items".into(),
        kind: "array".into(),
        parent_table_name: Some("tbl_Avatar".into()),
        property_path: Some("items".into()),
        fields: vec![
            field("id", "bigint unsigned"),
            field("parentID", "bigint unsigned"),
        ],
    };
    items.fields.push(field("sm_value", "varchar"));
    let mut gold = DerivedTable {
        name: "tbl_Avatar_gold".into(),
        kind: "component".into(),
        parent_table_name: Some("tbl_Avatar".into()),
        property_path: Some("gold".into()),
        fields: vec![
            field("id", "bigint unsigned"),
            field("parentID", "bigint unsigned"),
        ],
    };
    gold.fields.push(field("sm_amount", "int"));
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

/// 写归档:根行 id=7(name=hero)+ items 两行(100/101)+ gold 一行(200)。
fn write_fixture_archive(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("avatar.kdpclone");
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

#[test]
fn golden_import_plan_for_representative_avatar() {
    let dir = std::env::temp_dir().join(format!("kdp-golden-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let derived = avatar_derived();
    let resolved = SchemaResolver::resolve(&derived, &avatar_physical()).unwrap();
    let archive_path = write_fixture_archive(&dir);
    let archive = Archive::open(&archive_path, None).unwrap();

    // 目标现场:sm_name 唯一键,且已占用 hero → 触发本地重建。
    let mut snapshot = TargetSnapshot::default();
    snapshot.unique_keys.push(UniqueKey {
        table: "tbl_Avatar".into(),
        column: "sm_name".into(),
    });
    snapshot.add_existing("tbl_Avatar", "sm_name", TypedValue::Text("hero".into()));

    let plan = ImportPlanner::plan(
        &archive,
        &local_target(),
        &derived,
        &resolved,
        &RuleSet::default(),
        &snapshot,
        &ImportOptions::default(),
    )
    .unwrap();

    // ---- 执行序:父先子后(根表必为首,两张子表都在根之后) ----
    assert_eq!(plan.order.first().map(String::as_str), Some("tbl_Avatar"));
    let root_pos = plan.order.iter().position(|t| t == "tbl_Avatar").unwrap();
    for child in ["tbl_Avatar_items", "tbl_Avatar_gold"] {
        assert!(
            plan.order.iter().position(|t| t == child).unwrap() > root_pos,
            "{child} must come after its parent"
        );
    }

    // ---- 语句面:逐表计数 + 全列参数化 ----
    assert_eq!(plan.statements.len(), 4);
    assert_eq!(
        plan.summary.statements_per_table,
        BTreeMap::from([
            ("tbl_Avatar".to_string(), 1),
            ("tbl_Avatar_items".to_string(), 2),
            ("tbl_Avatar_gold".to_string(), 1),
        ])
    );
    let root_stmt = &plan.statements[0];
    assert_eq!(root_stmt.table, "tbl_Avatar");
    assert_eq!(root_stmt.columns, vec!["id", "sm_autoLoad", "sm_name"]);
    assert_eq!(
        root_stmt.insert_sql,
        "INSERT INTO tbl_Avatar (id, sm_autoLoad, sm_name) VALUES (?, ?, ?)"
    );
    // 新主键占位 / 策略覆写 / 唯一键重建。
    assert_eq!(root_stmt.cells[0], PlannedCell::NewKey { placeholder: 1 });
    assert_eq!(root_stmt.cells[1], PlannedCell::PolicyOverride);
    assert_eq!(root_stmt.cells[2], PlannedCell::Remapped);

    // ---- 子行引用根行同一占位(parentID 列) ----
    let items = &plan.statements[1];
    assert_eq!(items.table, "tbl_Avatar_items");
    assert_eq!(items.cells[0], PlannedCell::NewKey { placeholder: 2 });
    assert_eq!(items.cells[1], PlannedCell::KeyReference { placeholder: 1 });
    let gold = &plan.statements[3];
    assert_eq!(gold.table, "tbl_Avatar_gold");
    assert_eq!(gold.cells[1], PlannedCell::KeyReference { placeholder: 1 });

    // ---- 唯一键冲突:hero → hero_imported1(目标占用驱动) ----
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].table, "tbl_Avatar");
    assert_eq!(plan.conflicts[0].column, "sm_name");
    assert_eq!(
        plan.conflicts[0].rebuilt,
        TypedValue::Text("hero_imported1".into())
    );
    assert_eq!(plan.summary.unique_conflicts, 1);

    // ---- 映射账本:类别与去向(占位单调,父键共享一条) ----
    assert_eq!(
        plan.idmap.get("tbl_Avatar", "id", &TypedValue::BigUInt(7)),
        Some(&MappedId::Allocated { placeholder: 1 })
    );
    assert_eq!(
        plan.idmap
            .get("tbl_Avatar_items", "parentID", &TypedValue::BigUInt(7)),
        Some(&MappedId::Preserved)
    );
    let counts = plan.idmap.counts_by_category();
    assert_eq!(counts.get(&IdCategory::RootKey), Some(&1));
    assert_eq!(counts.get(&IdCategory::ChildRowKey), Some(&3));
    // 两张子表各自的 (表,parentID,7) 键 → 两条映射(表名入键,§6.3)。
    assert_eq!(counts.get(&IdCategory::ParentReference), Some(&2));
    assert_eq!(counts.get(&IdCategory::RebuiltIdentity), Some(&1));

    // ---- 账号绑定:无声明规则 → 不宣称可登录(PDC-0306) ----
    assert!(!plan.account_binding.login_ready);
    assert!(plan
        .account_binding
        .note
        .contains("NOT be visible to any local account"));

    // ---- 版本对账:归档不记源引擎版本,如实陈述 ----
    assert!(plan
        .schema_notes
        .iter()
        .any(|n| n.contains("does not record the source engine version")));

    // ---- 摘要(验收门:逐表逐类别) ----
    assert_eq!(plan.summary.mode, ImportMode::AllocateNewIds);
    assert_eq!(plan.summary.autoload_policy, AutoLoadPolicy::ForceDisabled);
    assert!(!plan.summary.login_ready);
    assert_eq!(plan.summary.unresolved_reference_risks, 0);
    assert_eq!(plan.summary.id_categories.get("root-entity-key"), Some(&1));
    assert_eq!(plan.summary.id_categories.get("child-row-key"), Some(&3));

    // ---- 计划可序列化审计(不内嵌敏感原值,语句全 `?`) ----
    let json = serde_json::to_value(&plan).unwrap();
    assert!(json
        .get("statements")
        .is_some_and(|s| s.as_array().is_some_and(|a| a.len() == 4)));
    assert!(!json.to_string().contains("hero_imported1')"));
    assert!(!plan.statements.iter().any(|s| s.insert_sql.contains('\'')));

    std::fs::remove_dir_all(&dir).unwrap();
}
