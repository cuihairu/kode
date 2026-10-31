//! `$/kode/databaseSchema/build` —— MySQL 表/列推导核心(IDE-RUST-008)。
//!
//! 边界(镜像 IDE-RUST-007「输入收集留 TS、推导归 Rust」):表/列推导归
//! Rust——入参是 TS 已收集的属性描述符树(properties)+实体名/def 路径/
//! hasCell/表前缀,推导本身不读文件/配置/工作区;属性收集(走查 def 闭包
//! + types.xml 别名解析 + 组件模块域,熔合快照版本清单)仍由 TS 承担。
//!
//! 语义(逐条对齐 TS src/databaseSchemaCore.ts 的 deriveDatabaseTables →
//! buildMysqlTableSchemas → appendPropertyToTable → expandColumnNames /
//! resolveDbTypeLabel / resolveEffectiveDatabaseLength):
//! - 根表 = `{tablePrefix}{entityName}`,固定 id(自增主键)+ sm_autoLoad(索引),
//!   hasCell 时追加 position/direction 六列(EntityTableMysql 建表);
//! - ARRAY → 子表(当前表名+祖先项名链+自身名),元素项落子表顶层,链/FD 前缀重置;
//! - ENTITY_COMPONENT → 子表(容器表名+组件名);实体无 cell 且组件槽无 base 域时
//!   组件连表跳过;FD 内组件项父表即容器表;
//! - ENTITYCALL 不落列;FIXED_DICT → 键名累积进前缀,不建子表;
//! - 叶子:列名按 expandColumnNames(VECTOR2/3/4 → sm_N_name,否则 sm_name),
//!   类型标签按 resolveDbTypeLabel(17 内建 → mysql 型,否则小写),
//!   STRING/UNICODE 未声明或 ≤0 的 DatabaseLength 按引擎默认 255 落列。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Number, Value};

use crate::rpc::RpcRegistry;

const DB_COLUMN_PREFIX: &str = "sm_";

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/databaseSchema/build", build_handler);
}

// ---- 输入(镜像 TS PersistentPropertyDescriptor / DatabaseSchemaDerivationInput)----

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

// ---- 输出(镜像 TS TableSchemaDescriptor / TableFieldDescriptor)----

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
    let table_index: BTreeMap<String, TableSchema> = tables
        .iter()
        .map(|t| (t.name.clone(), t.clone()))
        .collect();
    TablesResult { tables, table_index }
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
            synthetic_field("id", "bigint unsigned", "id", entity_source, Some("PRIMARY")),
            synthetic_field("sm_autoLoad", "tinyint", "autoLoad", entity_source, Some("INDEX")),
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
    parent_table_name: &str,
    name_chain: &[String],
    entity_has_cell: bool,
    fixed_dict_prefix: &str,
) {
    if !property.persistent {
        return;
    }

    match property.type_name.as_str() {
        "ARRAY" => {
            // 子表名 = 当前表名 + 祖先项名链(非空段)+ 自身名;元素项落子表顶层,
            // 链与 FD 前缀均重置(EntityTableItemMysql_ARRAY::initialize)。
            let table_name = build_array_table_name(current_table_name, name_chain, &property.name);
            let child = create_array_table(&table_name, current_table_name, property);
            tables.push(child);
            if let Some(element) = &property.array_element {
                let child_name = table_name.clone();
                append_property_to_table(tables, element, &child_name, &child_name, &[], entity_has_cell, "");
            }
        }
        "ENTITY_COMPONENT" => {
            // 引擎规则(组件表构建循环):实体无 cell 内容且组件槽旗标无 base 域时,
            // 组件连表一起跳过。
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
            // ENTITYCALL 不落列(syncToDB 为空);顶层数组的子表照建,元素列由本分支吞掉。
        }
        "FIXED_DICT" => {
            // FD 键链:只有 FD 键名累积进前缀;FD 作数组元素时项名为空串,前缀不加段。
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
                        parent_table_name,
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

fn build_array_table_name(current_table_name: &str, name_chain: &[String], array_name: &str) -> String {
    let mut table_name = current_table_name.to_string();
    for segment in name_chain {
        if !segment.is_empty() {
            table_name.push('_');
            table_name.push_str(segment);
        }
    }
    // 数组自身名出自标签名或 'value',恒非空。
    table_name.push('_');
    table_name.push_str(if array_name.is_empty() { "values" } else { array_name });
    table_name
}

fn create_array_table(table_name: &str, parent_table_name: &str, property: &PropertyNode) -> TableSchema {
    let source_path = source_path(property);
    TableSchema {
        name: table_name.into(),
        kind: "array".into(),
        title: source_path.clone(),
        source: property.source.clone(),
        parent_table_name: Some(parent_table_name.into()),
        property_path: Some(source_path),
        fields: vec![
            synthetic_field("id", "bigint unsigned", "id", &property.source, Some("PRIMARY")),
            synthetic_field("parentID", "bigint unsigned", "parentID", &property.source, Some("INDEX")),
            synthetic_field("sm_autoLoad", "tinyint", "autoLoad", &property.source, Some("INDEX")),
        ],
    }
}

fn create_component_table(table_name: &str, parent_table_name: &str, property: &PropertyNode) -> TableSchema {
    let source_path = source_path(property);
    TableSchema {
        name: table_name.into(),
        kind: "component".into(),
        title: source_path.clone(),
        source: property.source.clone(),
        parent_table_name: Some(parent_table_name.into()),
        property_path: Some(source_path),
        fields: vec![
            synthetic_field("id", "bigint unsigned", "id", &property.source, Some("PRIMARY")),
            synthetic_field("sm_autoLoad", "tinyint", "autoLoad", &property.source, Some("INDEX")),
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
        default_value: property.default_value.clone(),
        index_type: property.index_type.clone(),
        identifier: property.identifier,
        flags: property.flags.clone(),
        synthetic: None,
    }
}

// 引擎向量命名:index 在前,FD 前缀夹在 index 与项名之间。
fn expand_column_names(property: &PropertyNode, fixed_dict_prefix: &str) -> Vec<String> {
    let count = match property.type_name.as_str() {
        "VECTOR2" => 2,
        "VECTOR3" => 3,
        "VECTOR4" => 4,
        _ => return vec![format!("{DB_COLUMN_PREFIX}{fixed_dict_prefix}{}", property.name)],
    };
    (0..count)
        .map(|index| format!("{DB_COLUMN_PREFIX}{index}_{fixed_dict_prefix}{}", property.name))
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

// STRING/UNICODE 未声明 DatabaseLength(或声明 ≤0)时按引擎默认 255 落列。
fn resolve_effective_database_length(property: &PropertyNode) -> Option<Number> {
    if property.type_name == "STRING" || property.type_name == "UNICODE" {
        let has_declared = property
            .database_length
            .as_ref()
            .and_then(Number::as_f64)
            .map_or(false, |value| value > 0.0);
        if has_declared {
            property.database_length.clone()
        } else {
            Some(Number::from(255))
        }
    } else {
        property.database_length.clone()
    }
}
