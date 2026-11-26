//! `$/kode/databaseSchema/build` — MySQL table/column derivation core (IDE-RUST-008).
//!
//! Boundary (mirroring IDE-RUST-007 "input collection stays in TS, derivation
//! belongs to Rust"): table/column derivation belongs to Rust — the inputs are
//! the TS-collected property descriptor tree (properties) plus entity name /
//! def path / hasCell / table prefix, and the derivation itself reads no
//! files/config/workspace; property collection (walking the def closure +
//! types.xml alias resolution + component module domains, fused with the
//! snapshot version manifest) is still carried by TS.
//!
//! Semantics (aligned item by item with TS src/databaseSchemaCore.ts's
//! deriveDatabaseTables → buildMysqlTableSchemas → appendPropertyToTable →
//! expandColumnNames / resolveDbTypeLabel / resolveEffectiveDatabaseLength):
//! - Root table = `{tablePrefix}{entityName}`, with a fixed id (auto-increment
//!   primary key) + sm_autoLoad (indexed); when hasCell, the six
//!   position/direction columns are appended (EntityTableMysql table build);
//! - ARRAY → child table (current table name + ancestor item name chain + own
//!   name); the element item lands at the child table's top level, and the
//!   chain/FD prefixes are reset;
//! - ENTITY_COMPONENT → child table (container table name + component name);
//!   when the entity has no cell and the component slot flag has no base
//!   domain, the component and its table are both skipped; a component item
//!   inside an FD has the container table as its parent table;
//! - ENTITYCALL lands no column; FIXED_DICT → key names accumulate into the
//!   prefix, no child table is created;
//! - Leaves: column names follow expandColumnNames (VECTOR2/3/4 → sm_N_name,
//!   otherwise sm_name); type labels follow resolveDbTypeLabel (17 built-ins →
//!   mysql type, otherwise lowercase); STRING/UNICODE with an undeclared or
//!   ≤0 DatabaseLength lands with the engine default of 255.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Number, Value};

use crate::rpc::RpcRegistry;

const DB_COLUMN_PREFIX: &str = "sm_";

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/databaseSchema/build", build_handler);
}

// ---- inputs (mirror TS PersistentPropertyDescriptor / DatabaseSchemaDerivationInput) ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildParams {
    entity_name: String,
    def_file_path: String,
    #[serde(default)]
    properties: Vec<PropertyNode>,
    #[serde(default)]
    has_cell_content: bool,
    #[serde(default)]
    table_prefix: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PropertyNode {
    name: String,
    type_name: String,
    #[serde(default)]
    declared_type: Option<String>,
    #[serde(default)]
    persistent: bool,
    #[serde(default)]
    database_length: Option<Number>,
    #[serde(default)]
    default_value: Option<String>,
    #[serde(default)]
    identifier: bool,
    #[serde(default)]
    index_type: Option<String>,
    #[serde(default)]
    flags: Option<String>,
    #[serde(default)]
    scopes: Vec<String>,
    source: Value,
    #[serde(default)]
    children: Option<Vec<PropertyNode>>,
    #[serde(default)]
    array_element: Option<Box<PropertyNode>>,
}

// ---- outputs (mirror TS TableSchemaDescriptor / TableFieldDescriptor) ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TablesResult {
    tables: Vec<TableSchema>,
    table_index: BTreeMap<String, TableSchema>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableSchema {
    name: String,
    kind: String,
    title: String,
    source: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_table_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    property_path: Option<String>,
    fields: Vec<FieldSchema>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FieldSchema {
    name: String,
    type_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    declared_type: Option<String>,
    source_path: String,
    source: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    database_length: Option<Number>,
    // Whether the declaration site explicitly configures DatabaseLength (>0) —
    // the IDE-DB-001 capacity hint distinguishes "configured N" from "not
    // configured → engine default 255"; same-name mirror of the TS
    // TableFieldDescriptor field
    #[serde(skip_serializing_if = "Option::is_none")]
    database_length_specified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index_type: Option<String>,
    identifier: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    flags: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    synthetic: Option<bool>,
}

fn build_handler(params: Value) -> Result<Value, String> {
    let input: BuildParams =
        serde_json::from_value(params).map_err(|e| format!("databaseSchema/build params: {e}"))?;
    let result = derive_database_tables(input);
    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn derive_database_tables(input: BuildParams) -> TablesResult {
    let entity_source = json!({
        "filePath": input.def_file_path,
        "line": 1,
        "path": input.entity_name,
        "category": "entity",
    });
    let tables = build_mysql_table_schemas(
        &input.entity_name,
        &entity_source,
        &input.properties,
        input.has_cell_content,
        &input.table_prefix,
    );
    let table_index: BTreeMap<String, TableSchema> =
        tables.iter().map(|t| (t.name.clone(), t.clone())).collect();
    TablesResult {
        tables,
        table_index,
    }
}

fn build_mysql_table_schemas(
    entity_name: &str,
    entity_source: &Value,
    properties: &[PropertyNode],
    has_cell_content: bool,
    table_prefix: &str,
) -> Vec<TableSchema> {
    let root_table_name = format!("{table_prefix}{entity_name}");
    let mut root_table = TableSchema {
        name: root_table_name.clone(),
        kind: "entity".into(),
        title: entity_name.into(),
        source: entity_source.clone(),
        parent_table_name: None,
        property_path: Some(entity_name.into()),
        fields: vec![
            synthetic_field(
                "id",
                "bigint unsigned",
                "id",
                entity_source,
                Some("PRIMARY"),
            ),
            synthetic_field(
                "sm_autoLoad",
                "tinyint",
                "autoLoad",
                entity_source,
                Some("INDEX"),
            ),
        ],
    };

    if has_cell_content {
        for (axis, coord) in ["x", "y", "z"].iter().enumerate() {
            root_table.fields.push(synthetic_field(
                &format!("sm_{axis}_position"),
                "float",
                &format!("position.{coord}"),
                entity_source,
                None,
            ));
        }
        for (axis, angle) in ["roll", "pitch", "yaw"].iter().enumerate() {
            root_table.fields.push(synthetic_field(
                &format!("sm_{axis}_direction"),
                "float",
                &format!("direction.{angle}"),
                entity_source,
                None,
            ));
        }
    }

    let mut tables = vec![root_table];
    for property in properties {
        append_property_to_table(
            &mut tables,
            property,
            &root_table_name,
            &root_table_name,
            &[],
            has_cell_content,
            "",
        );
    }
    tables
}

#[allow(clippy::too_many_arguments)]
fn append_property_to_table(
    tables: &mut Vec<TableSchema>,
    property: &PropertyNode,
    current_table_name: &str,
    _parent_table_name: &str,
    name_chain: &[String],
    entity_has_cell: bool,
    fixed_dict_prefix: &str,
) {
    if !property.persistent {
        return;
    }

    match property.type_name.as_str() {
        "ARRAY" => {
            // Child table name = current table name + ancestor item name chain
            // (non-empty segments) + own name; the element item lands at the
            // child table's top level, and both the chain and the FD prefix are
            // reset (EntityTableItemMysql_ARRAY::initialize).
            let table_name = build_array_table_name(current_table_name, name_chain, &property.name);
            let child = create_array_table(&table_name, current_table_name, property);
            tables.push(child);
            if let Some(element) = &property.array_element {
                let child_name = table_name.clone();
                append_property_to_table(
                    tables,
                    element,
                    &child_name,
                    &child_name,
                    &[],
                    entity_has_cell,
                    "",
                );
            }
        }
        "ENTITY_COMPONENT" => {
            // Engine rule (component table build loop): when the entity has no
            // cell content and the component slot flag has no base domain, the
            // component and its table are both skipped.
            if !entity_has_cell && !property.scopes.iter().any(|s| s == "base") {
                return;
            }
            let child_table_name = format!("{current_table_name}_{}", property.name);
            let child = create_component_table(&child_table_name, current_table_name, property);
            tables.push(child);
            if let Some(children) = &property.children {
                let child_name = child_table_name.clone();
                for child_property in children {
                    append_property_to_table(
                        tables,
                        child_property,
                        &child_name,
                        &child_name,
                        &[],
                        entity_has_cell,
                        "",
                    );
                }
            }
        }
        "ENTITYCALL" => {
            // ENTITYCALL lands no column (syncToDB is empty); a top-level
            // array's child table is still built, and its element columns are
            // swallowed by this branch.
        }
        "FIXED_DICT" => {
            // FD key chain: only FD key names accumulate into the prefix; when
            // an FD is an array element the item name is the empty string and
            // no segment is added to the prefix.
            let next_prefix = if property.name.is_empty() {
                fixed_dict_prefix.to_string()
            } else {
                format!("{fixed_dict_prefix}{}_", property.name)
            };
            let mut chain = name_chain.to_vec();
            chain.push(property.name.clone());
            if let Some(children) = &property.children {
                for child_property in children {
                    append_property_to_table(
                        tables,
                        child_property,
                        current_table_name,
                        _parent_table_name,
                        &chain,
                        entity_has_cell,
                        &next_prefix,
                    );
                }
            }
        }
        _ => {
            let table = tables.iter_mut().find(|t| t.name == current_table_name);
            if let Some(table) = table {
                for field_name in expand_column_names(property, fixed_dict_prefix) {
                    if table.fields.iter().any(|f| f.name == field_name) {
                        continue;
                    }
                    table.fields.push(leaf_field(property, field_name));
                }
            }
        }
    }
}

fn build_array_table_name(
    current_table_name: &str,
    name_chain: &[String],
    array_name: &str,
) -> String {
    let mut table_name = current_table_name.to_string();
    for segment in name_chain {
        if !segment.is_empty() {
            table_name.push('_');
            table_name.push_str(segment);
        }
    }
    // The array's own name comes from the label name or 'value'; always non-empty.
    table_name.push('_');
    table_name.push_str(if array_name.is_empty() {
        "values"
    } else {
        array_name
    });
    table_name
}

fn create_array_table(
    table_name: &str,
    parent_table_name: &str,
    property: &PropertyNode,
) -> TableSchema {
    let source_path = source_path(property);
    TableSchema {
        name: table_name.into(),
        kind: "array".into(),
        title: source_path.clone(),
        source: property.source.clone(),
        parent_table_name: Some(parent_table_name.into()),
        property_path: Some(source_path),
        fields: vec![
            synthetic_field(
                "id",
                "bigint unsigned",
                "id",
                &property.source,
                Some("PRIMARY"),
            ),
            synthetic_field(
                "parentID",
                "bigint unsigned",
                "parentID",
                &property.source,
                Some("INDEX"),
            ),
            synthetic_field(
                "sm_autoLoad",
                "tinyint",
                "autoLoad",
                &property.source,
                Some("INDEX"),
            ),
        ],
    }
}

fn create_component_table(
    table_name: &str,
    parent_table_name: &str,
    property: &PropertyNode,
) -> TableSchema {
    let source_path = source_path(property);
    TableSchema {
        name: table_name.into(),
        kind: "component".into(),
        title: source_path.clone(),
        source: property.source.clone(),
        parent_table_name: Some(parent_table_name.into()),
        property_path: Some(source_path),
        fields: vec![
            synthetic_field(
                "id",
                "bigint unsigned",
                "id",
                &property.source,
                Some("PRIMARY"),
            ),
            // Component child tables are also engine child tables
            // (isChild(true), entity_table_mysql.cpp:1525): syncToDB appends
            // the parentID structural column to every child table
            // (entity_table_mysql.cpp:379-380), same shape as ARRAY child
            // tables — the TS derivation already covers this; this fills it in
            // for parity (parity bug #1).
            synthetic_field(
                "parentID",
                "bigint unsigned",
                "parentID",
                &property.source,
                Some("INDEX"),
            ),
            synthetic_field(
                "sm_autoLoad",
                "tinyint",
                "autoLoad",
                &property.source,
                Some("INDEX"),
            ),
        ],
    }
}

fn source_path(property: &PropertyNode) -> String {
    property
        .source
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn synthetic_field(
    name: &str,
    type_label: &str,
    source_path: &str,
    source: &Value,
    index_type: Option<&str>,
) -> FieldSchema {
    FieldSchema {
        name: name.into(),
        type_label: type_label.into(),
        declared_type: None,
        source_path: source_path.into(),
        source: source.clone(),
        database_length: None,
        database_length_specified: None,
        default_value: None,
        index_type: index_type.map(str::to_string),
        identifier: false,
        flags: None,
        synthetic: Some(true),
    }
}

fn leaf_field(property: &PropertyNode, field_name: String) -> FieldSchema {
    FieldSchema {
        name: field_name,
        type_label: resolve_db_type_label(&property.type_name),
        declared_type: property.declared_type.clone(),
        source_path: source_path(property),
        source: property.source.clone(),
        database_length: resolve_effective_database_length(property),
        database_length_specified: Some(declared_database_length(property)),
        default_value: property.default_value.clone(),
        index_type: property.index_type.clone(),
        identifier: property.identifier,
        flags: property.flags.clone(),
        synthetic: None,
    }
}

// Engine vector naming: index comes first, the FD prefix sits between the
// index and the item name.
fn expand_column_names(property: &PropertyNode, fixed_dict_prefix: &str) -> Vec<String> {
    let count = match property.type_name.as_str() {
        "VECTOR2" => 2,
        "VECTOR3" => 3,
        "VECTOR4" => 4,
        _ => {
            return vec![format!(
                "{DB_COLUMN_PREFIX}{fixed_dict_prefix}{}",
                property.name
            )]
        }
    };
    (0..count)
        .map(|index| {
            format!(
                "{DB_COLUMN_PREFIX}{index}_{fixed_dict_prefix}{}",
                property.name
            )
        })
        .collect()
}

fn resolve_db_type_label(type_name: &str) -> String {
    let label = match type_name {
        "INT8" => "tinyint",
        "INT16" => "smallint",
        "INT32" => "int",
        "INT64" => "bigint",
        "UINT8" => "tinyint unsigned",
        "UINT16" => "smallint unsigned",
        "UINT32" => "int unsigned",
        "UINT64" => "bigint unsigned",
        "FLOAT" => "float",
        "DOUBLE" => "double",
        "STRING" => "varchar",
        "UNICODE" => "varchar",
        "PYTHON" => "blob",
        "PY_DICT" => "blob",
        "PY_TUPLE" => "blob",
        "PY_LIST" => "blob",
        "BLOB" => "blob",
        "ENTITYCALL" => "blob",
        _ => return type_name.to_lowercase(),
    };
    label.to_string()
}

// When STRING/UNICODE declares no DatabaseLength (or declares ≤0), the column
// lands with the engine default of 255.
fn resolve_effective_database_length(property: &PropertyNode) -> Option<Number> {
    if property.type_name == "STRING" || property.type_name == "UNICODE" {
        let has_declared = declared_database_length(property);
        if has_declared {
            property.database_length.clone()
        } else {
            Some(Number::from(255))
        }
    } else {
        property.database_length.clone()
    }
}

// Whether the declaration site explicitly configures DatabaseLength (>0): the
// effective length has already been folded to the default 255; whether it was
// declared is tracked separately (for the IDE-DB-001 capacity hint).
fn declared_database_length(property: &PropertyNode) -> bool {
    property
        .database_length
        .as_ref()
        .and_then(Number::as_f64)
        .is_some_and(|value| value > 0.0)
}
