//! Golden acceptance (CLONE-P1 gate): representative Avatar virtual fixture → the
//! golden plan of plan doc §4.
//!
//! The virtual fixture does not go through a real MySQL (PDC-0003/0007 are blocked;
//! real-table fixtures await the user's environment): the derived side is modeled
//! by hand per kode deriveDatabaseTables semantics, the physical side is built in
//! the information_schema shape, asserting table order, column lists, SQL and the
//! denied/missing faces. Proves the planner's behavior without depending on an
//! external database.

use std::collections::BTreeMap;

use kode_db_clone::{
    CloneError, CloneSchema, DerivedField, DerivedTable, ExportPlanner, PhysicalTable, PlanFilter,
    ResolvedCloneSchema, RuleSet, SchemaResolver, SchemaSource, VirtualSchema,
};

/// Derived field (mirrors the derivation output's FieldSchema semantics).
fn field(name: &str, type_label: &str) -> DerivedField {
    DerivedField {
        name: name.into(),
        type_label: type_label.into(),
        identifier: name == "id",
        synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
        source: SchemaSource::Def,
    }
}

/// Engine-synthesized child table (id/parentID/sm_autoLoad).
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

/// Representative Avatar derived schema: root (hasCell → position/direction) +
/// ARRAY (items → nested mods) + ARRAY (inventory) + ENTITY_COMPONENT (gold).
fn avatar_derived() -> CloneSchema {
    let mut root_fields = vec![
        field("id", "bigint unsigned"),
        field("sm_autoLoad", "tinyint"),
        field("sm_name", "varchar"),
        field("sm_level", "int"),
    ];
    // hasCell → VECTOR3 position + direction (six columns, sm_N_<field>).
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

    // ARRAY items lands an sm_value column; items nests another ARRAY mods → a
    // second-level child table.
    let mut items = child_struct("tbl_Avatar_items", "tbl_Avatar", "array");
    items.fields.push(field("sm_value", "varchar"));
    let mut mods = child_struct("tbl_Avatar_items_mods", "tbl_Avatar_items", "array");
    mods.fields.push(field("sm_value", "varchar"));

    let mut inventory = child_struct("tbl_Avatar_inventory", "tbl_Avatar", "array");
    inventory.fields.push(field("sm_value", "varchar"));

    let mut gold = child_struct("tbl_Avatar_gold", "tbl_Avatar", "component");
    gold.fields.push(field("sm_amount", "int"));

    CloneSchema::new("Avatar".into(), vec![root, items, mods, inventory, gold]).unwrap()
}

/// Physical side: fully consistent with derived + a kbe_ internal table + one
/// physical-only table (all must be denied).
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
    // Engine internal table: absent on the derived side, kbe_ prefix → deny.
    add(
        "kbe_entitylog",
        &[("id", "bigint(20) unsigned"), ("log", "text")],
    );
    // Physical-only underived table: deny (no guessing relations).
    add("tbl_Unknown", &[("id", "bigint(20) unsigned")]);
    v
}

#[test]
fn golden_plan_for_representative_avatar() {
    let derived = avatar_derived();
    let physical = avatar_physical();

    let resolved: ResolvedCloneSchema = SchemaResolver::resolve(&derived, &physical).unwrap();
    assert_eq!(resolved.tables.len(), 5, "all five derived tables matched");
    assert_eq!(resolved.missing.len(), 0, "nothing missing");

    let planner = ExportPlanner::new(10_000);
    let plan = planner
        .plan(&derived, &resolved, &RuleSet::default(), None)
        .unwrap();

    // Golden order: root table → engine child tables (pre-order, parents before
    // children).
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

    // Root table by id; all child tables attach to their parent by parentID.
    assert_eq!(plan.queries[0].filter, PlanFilter::RootId);
    for q in &plan.queries[1..] {
        assert_eq!(q.filter, PlanFilter::ParentId);
    }
    assert_eq!(plan.queries[1].parent_table.as_deref(), Some("tbl_Avatar"));
    assert_eq!(
        plan.queries[2].parent_table.as_deref(),
        Some("tbl_Avatar_items")
    );

    // Golden SQL: explicit columns, backticks, `?` bindings; SELECT only (read-only
    // face).
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
    // Component child tables share the same shape (parentID is a logical column
    // there too, source-evidence §4).
    assert_eq!(
        plan.queries[4].select_sql,
        "SELECT `id`, `parentID`, `sm_autoLoad`, `sm_amount` FROM `tbl_Avatar_gold` \
         WHERE `parentID` = ?"
    );

    // Denied face: kbe_ internal table + physical-only table, with reasons, never
    // silent.
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

    // No estimates → within_budget unknown (no estimates means no prediction; the
    // execution phase counts for real).
    let planner = ExportPlanner::new(10_000);
    let dry = planner
        .dry_run(&derived, &resolved, &RuleSet::default(), None)
        .unwrap();
    assert_eq!(dry.query_count, 5);
    assert_eq!(dry.estimated_rows_total, None);
    assert!(dry.within_budget);

    // Estimates over budget → honest error (reject rather than silently truncate).
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
