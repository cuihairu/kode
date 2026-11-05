//! 接入现有表结构推导输出(PDC-0102)。
//!
//! kode-server 的 `$/kode/databaseSchema/build` 以 camelCase JSON 输出
//! `{ tables: [...], tableIndex: {...} }`(database_schema.rs 的 TablesResult,
//! 已 derive Serialize)。本模块按同一 wire 形状反序列化,机械转换为
//! [`CloneSchema`],使计划器消费的是与 RPC 输出逐字节同源的数据——接入点
//! 即「现有推导输出 → 计划器」,无需 kode-server 公开内部类型。
//!
//! 只取计划所需字段(name/kind/parent/propertyPath/fields{name,typeLabel,identifier,synthetic}),
//! 其余 wire 字段(title/source/sourcePath/...)忽略——计划器不依赖展示元数据。

use serde::Deserialize;

use crate::error::{CloneError, CloneResult};
use crate::schema::{CloneSchema, DerivedField, DerivedTable, SchemaSource};

/// kode-server databaseSchema/build 输出的 wire 形状(camelCase)。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationWire {
    pub tables: Vec<WireTable>,
    #[serde(default)]
    pub table_index: std::collections::BTreeMap<String, WireTable>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTable {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub parent_table_name: Option<String>,
    #[serde(default)]
    pub property_path: Option<String>,
    pub fields: Vec<WireField>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireField {
    pub name: String,
    pub type_label: String,
    #[serde(default)]
    pub identifier: bool,
    #[serde(default)]
    pub synthetic: Option<bool>,
}

/// 从 kode-server 推导输出 JSON 构建 [`CloneSchema`](crate::CloneSchema)。
impl CloneSchema {
    pub fn from_derivation(json: &str) -> CloneResult<Self> {
        let wire: DerivationWire =
            serde_json::from_str(json).map_err(|e| CloneError::InvalidRule(format!(
                "cannot parse kode-server derivation output: {e}"
            )))?;
        if wire.tables.is_empty() {
            return Err(CloneError::InvalidRule(
                "derivation output has no tables".into(),
            ));
        }
        let entity_name = wire
            .tables
            .iter()
            .find(|t| t.kind == "entity" || t.kind == "root")
            .and_then(|t| t.property_path.clone())
            .unwrap_or_else(|| {
                wire.tables
                    .first()
                    .map(|t| t.name.clone())
                    .unwrap_or_default()
            });

        let tables: Vec<DerivedTable> = wire
            .tables
            .into_iter()
            .map(|t| {
                let fields = t
                    .fields
                    .into_iter()
                    .map(|f| DerivedField {
                        name: f.name,
                        type_label: f.type_label,
                        identifier: f.identifier,
                        synthetic: f.synthetic.unwrap_or(false),
                        source: if f.synthetic.unwrap_or(false) {
                            SchemaSource::Synthetic
                        } else {
                            SchemaSource::Def
                        },
                    })
                    .collect();
                // kode-server 根表 kind 为 "entity"(database_schema.rs),本层以
                // "root" 归一,使 CloneSchema::new 的「恰一根表」校验成立。
                let kind = if t.kind == "entity" { "root".to_string() } else { t.kind };
                DerivedTable {
                    name: t.name,
                    kind,
                    parent_table_name: t.parent_table_name,
                    property_path: t.property_path,
                    fields,
                }
            })
            .collect();

        CloneSchema::new(entity_name, tables)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一段与 kode-server databaseSchema/build 输出同形的 camelCase JSON
    /// (字段名/serde 形状照 database_schema.rs 的输出,含展示字段以示忽略)。
    const DERIVATION_JSON: &str = r#"
    {
      "tables": [
        {
          "name": "tbl_Avatar",
          "kind": "entity",
          "title": "Avatar",
          "source": { "filePath": "entities/Avatar.def", "line": 1, "path": "Avatar", "category": "entity" },
          "parentTableName": null,
          "propertyPath": "Avatar",
          "fields": [
            { "name": "id", "typeLabel": "bigint unsigned", "sourcePath": "id", "source": {}, "identifier": false, "synthetic": true },
            { "name": "sm_autoLoad", "typeLabel": "tinyint", "sourcePath": "autoLoad", "source": {}, "identifier": false, "synthetic": true },
            { "name": "sm_name", "typeLabel": "varchar", "declaredType": "STRING", "sourcePath": "name", "source": {}, "databaseLength": 255, "identifier": true, "synthetic": null }
          ]
        },
        {
          "name": "tbl_Avatar_items",
          "kind": "array",
          "title": "Avatar.items",
          "source": { "filePath": "entities/Avatar.def", "line": 12, "path": "items", "category": "property" },
          "parentTableName": "tbl_Avatar",
          "propertyPath": "Avatar.items",
          "fields": [
            { "name": "id", "typeLabel": "bigint unsigned", "sourcePath": "id", "source": {}, "identifier": false, "synthetic": true },
            { "name": "parentID", "typeLabel": "bigint unsigned", "sourcePath": "parentID", "source": {}, "identifier": false, "synthetic": true },
            { "name": "sm_autoLoad", "typeLabel": "tinyint", "sourcePath": "autoLoad", "source": {}, "identifier": false, "synthetic": true },
            { "name": "sm_value", "typeLabel": "varchar", "declaredType": "STRING", "sourcePath": "items.value", "source": {}, "databaseLength": 255, "identifier": false, "synthetic": null }
          ]
        }
      ],
      "tableIndex": {
        "tbl_Avatar": { "name": "tbl_Avatar", "kind": "entity", "title": "Avatar", "fields": [] },
        "tbl_Avatar_items": { "name": "tbl_Avatar_items", "kind": "array", "title": "Avatar.items", "fields": [] }
      }
    }
    "#;

    #[test]
    fn ingests_kode_server_derivation_output() {
        let schema = CloneSchema::from_derivation(DERIVATION_JSON).unwrap();
        assert_eq!(schema.entity_name, "Avatar");
        assert_eq!(schema.tables.len(), 2);
        let root = &schema.tables[0];
        assert_eq!(root.name, "tbl_Avatar");
        assert_eq!(root.kind, "root", "kode-server 的 entity kind 归一为 root");
        let name_field = root
            .fields
            .iter()
            .find(|f| f.name == "sm_name")
            .expect("sm_name field");
        assert!(name_field.identifier, "identifier 保留");
        assert_eq!(name_field.source, SchemaSource::Def);
        let id_field = root.fields.iter().find(|f| f.name == "id").unwrap();
        assert_eq!(id_field.source, SchemaSource::Synthetic);
        let items = &schema.tables[1];
        assert_eq!(items.parent_table_name.as_deref(), Some("tbl_Avatar"));
        assert_eq!(items.kind, "array");
    }

    #[test]
    fn rejects_invalid_json() {
        let err = CloneSchema::from_derivation("{ not json").unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(_)));
    }

    #[test]
    fn rejects_empty_tables() {
        let err = CloneSchema::from_derivation(r#"{ "tables": [], "tableIndex": {} }"#).unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(_)));
    }
}
