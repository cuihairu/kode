//! Wiring in the existing table-structure derivation output (PDC-0102).
//!
//! kode-server's `$/kode/databaseSchema/build` outputs camelCase JSON
//! `{ tables: [...], tableIndex: {...} }` (the TablesResult of database_schema.rs,
//! already derive Serialize). This module deserializes the same wire shape and
//! mechanically converts it into [`CloneSchema`], so the planner consumes data
//! byte-for-byte identical to the RPC output — the wiring point is "existing
//! derivation output → planner", requiring kode-server to expose no internal
//! types.
//!
//! Only the fields the plan needs are taken
//! (name/kind/parent/propertyPath/fields{name,typeLabel,identifier,synthetic});
//! the other wire fields (title/source/sourcePath/...) are ignored — the planner
//! does not depend on presentation metadata.

use serde::Deserialize;

use crate::error::{CloneError, CloneResult};
use crate::schema::{CloneSchema, DerivedField, DerivedTable, SchemaSource};

/// Wire shape of kode-server's databaseSchema/build output (camelCase).
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

/// Builds a [`CloneSchema`](crate::CloneSchema) from kode-server's derivation
/// output JSON.
impl CloneSchema {
    pub fn from_derivation(json: &str) -> CloneResult<Self> {
        let wire: DerivationWire = serde_json::from_str(json).map_err(|e| {
            CloneError::InvalidRule(format!("cannot parse kode-server derivation output: {e}"))
        })?;
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
                // kode-server's root table kind is "entity" (database_schema.rs);
                // this layer normalizes it to "root" so that CloneSchema::new's
                // "exactly one root table" validation holds.
                let kind = if t.kind == "entity" {
                    "root".to_string()
                } else {
                    t.kind
                };
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

    /// A camelCase JSON snippet shaped like kode-server's databaseSchema/build
    /// output (field names / serde shape per database_schema.rs's output, including
    /// presentation fields to demonstrate they are ignored).
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
        assert_eq!(
            root.kind, "root",
            "kode-server's entity kind normalizes to root"
        );
        let name_field = root
            .fields
            .iter()
            .find(|f| f.name == "sm_name")
            .expect("sm_name field");
        assert!(name_field.identifier, "identifier kept");
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
        let err =
            CloneSchema::from_derivation(r#"{ "tables": [], "tableIndex": {} }"#).unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(_)));
    }

    #[test]
    fn derivation_without_entity_or_root_table_is_rejected_by_one_root_gate() {
        // No entity/root table at all: entity_name falls back to the first table's
        // name (defensive computation), but the "exactly one root table" gate
        // immediately rejects — no guessing of entity boundaries.
        let err = CloneSchema::from_derivation(
            r#"{
              "tables": [
                { "name": "tbl_Guild", "kind": "component", "parentTableName": null,
                  "propertyPath": "Guild",
                  "fields": [ { "name": "id", "typeLabel": "bigint unsigned", "synthetic": true } ] }
              ]
            }"#,
        )
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("expected exactly one root table, found 0"),
            "{err}"
        );
    }
}
