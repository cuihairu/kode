//! Golden 验收(CLONE-P1 门):代表性 Avatar 虚拟 Fixture → 计划书 §4 的黄金计划。
//!
//! 虚拟 Fixture 不经真实 MySQL(PDC-0003/0007 被阻塞,真实表夹具待用户环境):
//! 派生侧按 kode deriveDatabaseTables 语义手工建模,物理侧按 information_schema
//! 形状构造,断言表序、列清单、SQL 与拒绝/缺失面。证明计划器的行为而不依赖外部库。

use std::collections::BTreeMap;

use kode_db_clone::{
    CloneError, CloneSchema, DerivedField, DerivedTable, ExportPlanner, PhysicalTable, PlanFilter,
    ResolvedCloneSchema, RuleSet, SchemaResolver, SchemaSource, VirtualSchema,
};

/// 派生字段(镜像推导输出 FieldSchema 语义)。
fn field(name: &str, type_label: &str) -> DerivedField {
    DerivedField {
        name: name.into(),
        type_label: type_label.into(),
        identifier: name == "id",
        synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
        source: SchemaSource::Def,
    }
}

/// 引擎合成子表(id/parentID/sm_autoLoad)。
fn child_struct(table: &str, parent: &str, kind: &str) -> DerivedTable {
    DerivedTable {
        name: table.into(),
        kind: kind.into(),
        parent_table_name: Some(parent.into()),
        property_path: Some(table.into()),
        fields: vec![
            field("id", "bigint unsigned"),
            field("parentID", "bigint unsigned"),
            field("sm_autoLoad", "tinyint"),
        ],
    }
}

/// 代表性 Avatar 派生 schema:根表(hasCell → position/direction)+
/// ARRAY(items → mods 二级)+ ARRAY(inventory)+ ENTITY_COMPONENT(gold)。
fn avatar_derived() -> CloneSchema {
    let mut root_fields = vec![
        field("id", "bigint unsigned"),
        field("sm_autoLoad", "tinyint"),
        field("sm_name", "varchar"),
        field("sm_level", "int"),
    ];
    // hasCell → VECTOR3 position + direction(六列,sm_N_<field>)。
    for axis in 0..3 {
        root_fields.push(field(&format!("sm_{axis}_position"), "float"));
    }
    for axis in 0..3 {
        root_fields.push(field(&format!("sm_{axis}_direction"), "float"));
    }
    let root = DerivedTable {
        name: "tbl_Avatar".into(),
        kind: "root".into(),
        parent_table_name: None,
        property_path: Some("Avatar".into()),
        fields: root_fields,
    };

    // ARRAY items 落 sm_value 列;items 内再嵌 ARRAY mods → 二级子表。
    let mut items = child_struct("tbl_Avatar_items", "tbl_Avatar", "array");
    items.fields.push(field("sm_value", "varchar"));
    let mut mods = child_struct("tbl_Avatar_items_mods", "tbl_Avatar_items", "array");
    mods.fields.push(field("sm_value", "varchar"));

    let mut inventory = child_struct("tbl_Avatar_inventory", "tbl_Avatar", "array");
    inventory.fields.push(field("sm_value", "varchar"));

    let mut gold = child_struct("tbl_Avatar_gold", "tbl_Avatar", "component");
    gold.fields.push(field("sm_amount", "int"));

    CloneSchema::new(
        "Avatar".into(),
        vec![root, items, mods, inventory, gold],
    )
    .unwrap()
}

/// 物理侧:与派生完全一致 + kbe_ 内部表 + 一张物理独有表(均须 deny)。
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
            ("sm_level", "int"),
            ("sm_0_position", "float"),
            ("sm_1_position", "float"),
            ("sm_2_position", "float"),
            ("sm_0_direction", "float"),
            ("sm_1_direction", "float"),
            ("sm_2_direction", "float"),
        ],
    );
    add(
        "tbl_Avatar_items",
        &[
            ("id", "bigint(20) unsigned"),
            ("parentID", "bigint(20) unsigned"),
            ("sm_autoLoad", "tinyint"),
            ("sm_value", "varchar(255)"),
        ],
    );
    add(
        "tbl_Avatar_items_mods",
        &[
            ("id", "bigint(20) unsigned"),
            ("parentID", "bigint(20) unsigned"),
            ("sm_autoLoad", "tinyint"),
            ("sm_value", "varchar(255)"),
        ],
    );
    add(
        "tbl_Avatar_inventory",
        &[
            ("id", "bigint(20) unsigned"),
            ("parentID", "bigint(20) unsigned"),
            ("sm_autoLoad", "tinyint"),
            ("sm_value", "varchar(255)"),
        ],
    );
    add(
        "tbl_Avatar_gold",
        &[
            ("id", "bigint(20) unsigned"),
            ("parentID", "bigint(20) unsigned"),
            ("sm_autoLoad", "tinyint"),
            ("sm_amount", "int"),
        ],
    );
    // 引擎内部表:派生侧无,kbe_ 前缀 → deny。
    add("kbe_entitylog", &[("id", "bigint(20) unsigned"), ("log", "text")]);
    // 物理独有未派生表:deny(禁止猜关系)。
    add("tbl_Unknown", &[("id", "bigint(20) unsigned")]);
    v
}

#[test]
fn golden_plan_for_representative_avatar() {
    let derived = avatar_derived();
    let physical = avatar_physical();

    let resolved: ResolvedCloneSchema = SchemaResolver::resolve(&derived, &physical).unwrap();
    assert_eq!(resolved.tables.len(), 5, "五张派生表全部通过匹配");
    assert_eq!(resolved.missing.len(), 0, "无缺失");

    let planner = ExportPlanner::new(10_000);
    let plan = planner
        .plan(&derived, &resolved, &RuleSet::default(), None)
        .unwrap();

    // 黄金序:根表 → 引擎子表(先序,父先子后)。
    let tables: Vec<&str> = plan.queries.iter().map(|q| q.table.as_str()).collect();
    assert_eq!(
        tables,
        vec![
            "tbl_Avatar",
            "tbl_Avatar_items",
            "tbl_Avatar_items_mods",
            "tbl_Avatar_inventory",
            "tbl_Avatar_gold",
        ]
    );

    // 根表按 id;全部子表按 parentID 挂父。
    assert_eq!(plan.queries[0].filter, PlanFilter::RootId);
    for q in &plan.queries[1..] {
        assert_eq!(q.filter, PlanFilter::ParentId);
    }
    assert_eq!(plan.queries[1].parent_table.as_deref(), Some("tbl_Avatar"));
    assert_eq!(
        plan.queries[2].parent_table.as_deref(),
        Some("tbl_Avatar_items")
    );

    // 黄金 SQL:显式列、反引号、`?` 绑定;仅 SELECT(只读面)。
    assert_eq!(
        plan.queries[0].select_sql,
        "SELECT `id`, `sm_autoLoad`, `sm_name`, `sm_level`, `sm_0_position`, `sm_1_position`, \
         `sm_2_position`, `sm_0_direction`, `sm_1_direction`, `sm_2_direction` FROM `tbl_Avatar` \
         WHERE `id` = ?"
    );
    assert_eq!(
        plan.queries[1].select_sql,
        "SELECT `id`, `parentID`, `sm_autoLoad`, `sm_value` FROM `tbl_Avatar_items` \
         WHERE `parentID` = ?"
    );
    assert_eq!(
        plan.queries[3].select_sql,
        "SELECT `id`, `parentID`, `sm_autoLoad`, `sm_value` FROM `tbl_Avatar_inventory` \
         WHERE `parentID` = ?"
    );
    // 组件子表同形(parentID 亦为逻辑列,source-evidence §4)。
    assert_eq!(
        plan.queries[4].select_sql,
        "SELECT `id`, `parentID`, `sm_autoLoad`, `sm_amount` FROM `tbl_Avatar_gold` \
         WHERE `parentID` = ?"
    );

    // 拒绝面:kbe_ 内部表 + 物理独有表,带原因,不静默。
    let denied: Vec<(&str, &str)> = plan
        .denied
        .iter()
        .map(|d| (d.name.as_str(), d.reason.as_str()))
        .collect();
    assert!(denied.iter().any(|(n, _)| *n == "kbe_entitylog"));
    assert!(denied.iter().any(|(n, _)| *n == "tbl_Unknown"));
    assert!(denied.iter().all(|(_, r)| !r.is_empty()));
}

#[test]
fn golden_dry_run_reports_budget() {
    let derived = avatar_derived();
    let physical = avatar_physical();
    let resolved = SchemaResolver::resolve(&derived, &physical).unwrap();

    // 无估计 → within_budget 未知(无估计即不预判,执行期实际计数)。
    let planner = ExportPlanner::new(10_000);
    let dry = planner
        .dry_run(&derived, &resolved, &RuleSet::default(), None)
        .unwrap();
    assert_eq!(dry.query_count, 5);
    assert_eq!(dry.estimated_rows_total, None);
    assert!(dry.within_budget);

    // 估计超预算 → 诚实错误(拒绝而非静默截断)。
    let estimates = BTreeMap::from([
        ("tbl_Avatar".to_string(), 1u64),
        ("tbl_Avatar_items".to_string(), 50u64),
        ("tbl_Avatar_items_mods".to_string(), 120u64),
        ("tbl_Avatar_inventory".to_string(), 30u64),
        ("tbl_Avatar_gold".to_string(), 1u64),
    ]);
    let tight = ExportPlanner::new(200);
    let err = tight
        .plan(&derived, &resolved, &RuleSet::default(), Some(&estimates))
        .unwrap_err();
    assert!(matches!(
        err,
        CloneError::BudgetExceeded {
            limit: 200,
            requested: 202
        }
    ));
}
