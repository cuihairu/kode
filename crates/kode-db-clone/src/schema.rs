//! Two-level schema (plan §4.1): derived (DefDerivedSchema) + physical
//! (PhysicalSchema) → resolved (ResolvedCloneSchema).
//!
//! The derived side mirrors kode-server's `database_schema` derivation output
//! (identical field semantics; wiring is a mechanical mapping). The physical side
//! is abstracted by the `PhysicalSchema` trait: virtual fixtures use
//! [`VirtualSchema`], a real database is served by the `information_schema` reader
//! (later phase, needs a real MySQL). Any unconfirmed mapping fails closed.

use std::collections::BTreeMap;

use crate::error::{CloneError, CloneResult};

/// Source of a column (plan §5.4 manifest provenance).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SchemaSource {
    /// From `.def`/`types.xml` property declarations.
    Def,
    /// Engine-synthesized column (id/parentID/sm_*), not def-derived.
    Synthetic,
    /// Unknown origin (physical-only, not matched on the derived side).
    Unknown,
}

/// Derived table field (mirrors the semantics of the derivation output's
/// FieldSchema).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DerivedField {
    pub name: String,
    pub type_label: String,
    pub identifier: bool,
    pub synthetic: bool,
    pub source: SchemaSource,
}

/// Derived table (mirrors the semantics of the derivation output's TableSchema).
/// `kind` ∈ {root, array, component}.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DerivedTable {
    pub name: String,
    pub kind: String,
    /// Non-root tables point at their parent (the logical parent of ARRAY /
    /// component child tables).
    pub parent_table_name: Option<String>,
    /// def property path (the child table's property chain); None for the root.
    pub property_path: Option<String>,
    pub fields: Vec<DerivedField>,
}

/// def-derived schema (equivalent of DefDerivedSchema).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneSchema {
    pub entity_name: String,
    pub tables: Vec<DerivedTable>,
    /// table name → table (derived-side index).
    pub table_index: BTreeMap<String, DerivedTable>,
}

impl CloneSchema {
    /// Builds and validates from a table list: exactly one root table, child
    /// parent references valid (no dangling parents).
    pub fn new(entity_name: String, tables: Vec<DerivedTable>) -> CloneResult<Self> {
        let mut table_index = BTreeMap::new();
        for table in &tables {
            if table_index
                .insert(table.name.clone(), table.clone())
                .is_some()
            {
                return Err(CloneError::InvalidRule(format!(
                    "duplicate derived table `{}`",
                    table.name
                )));
            }
        }
        let roots: Vec<&DerivedTable> = tables.iter().filter(|t| t.kind == "root").collect();
        if roots.len() != 1 {
            return Err(CloneError::InvalidRule(format!(
                "expected exactly one root table, found {}",
                roots.len()
            )));
        }
        for table in &tables {
            if let Some(parent) = &table.parent_table_name {
                if !table_index.contains_key(parent) {
                    return Err(CloneError::InvalidRule(format!(
                        "table `{}` references unknown parent `{parent}`",
                        table.name
                    )));
                }
            }
        }
        Ok(Self {
            entity_name,
            tables,
            table_index,
        })
    }
}

/// Physical table (columns / keys / engine info from information_schema).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysicalTable {
    pub name: String,
    /// Storage engine, e.g. `InnoDB`.
    pub engine: String,
    /// column name → normalized column type (e.g. `bigint unsigned`,
    /// `varchar(255)`).
    pub columns: BTreeMap<String, String>,
    /// Primary key columns (if any).
    pub primary_key: Vec<String>,
    /// Index columns (excluding the primary key).
    pub indexes: Vec<Vec<String>>,
}

impl PhysicalTable {
    pub fn is_transactional(&self) -> bool {
        self.engine.eq_ignore_ascii_case("InnoDB")
    }
}

/// Physical schema read abstraction: virtual fixtures use [`VirtualSchema`], a
/// real database uses the information_schema reader.
pub trait PhysicalSchema {
    fn table(&self, name: &str) -> Option<&PhysicalTable>;
    fn table_names(&self) -> Vec<String>;
}

/// Virtual physical schema (for tests and the Phase 1 virtual fixture).
#[derive(Debug, Clone, Default)]
pub struct VirtualSchema {
    pub tables: BTreeMap<String, PhysicalTable>,
}

impl VirtualSchema {
    pub fn new(tables: Vec<PhysicalTable>) -> Self {
        let mut map = BTreeMap::new();
        for t in tables {
            map.insert(t.name.clone(), t);
        }
        Self { tables: map }
    }
}

impl PhysicalSchema for VirtualSchema {
    fn table(&self, name: &str) -> Option<&PhysicalTable> {
        self.tables.get(name)
    }
    fn table_names(&self) -> Vec<String> {
        self.tables.keys().cloned().collect()
    }
}

/// Resolved clone schema: contains only tables matched on both sides and approved
/// by rules (plan §4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCloneSchema {
    /// Tables that matched on both derived and physical sides (root table and
    /// engine-certain child tables included).
    pub tables: Vec<DerivedTable>,
    /// Rejected tables (kbe_ internal tables, physical-only underived tables) with
    /// reasons.
    pub denied: Vec<DeniedTable>,
    /// Derived tables missing on the physical side (unknown tables; no guessing by
    /// prefix) — recorded as errors fail-closed.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeniedTable {
    pub name: String,
    pub reason: String,
}

/// Schema resolver: matches derived ↔ physical, validates types/engine, applies
/// allow/deny (kbe_ denied).
#[derive(Debug)]
pub struct SchemaResolver;

/// Engine internal table prefix (plan §2/§4.1: kbe_ internal tables excluded by
/// default).
const KBE_PREFIX: &str = "kbe_";

impl SchemaResolver {
    /// Resolves and validates. A derived table must exist on the physical side
    /// with compatible field types, otherwise fail closed. `kbe_`-prefixed tables
    /// and physical-only underived tables → deny (excluded).
    pub fn resolve<S: PhysicalSchema>(
        derived: &CloneSchema,
        physical: &S,
    ) -> CloneResult<ResolvedCloneSchema> {
        let mut tables = Vec::new();
        let mut denied = Vec::new();
        let mut missing = Vec::new();

        for table in &derived.tables {
            if table.name.starts_with(KBE_PREFIX) {
                denied.push(DeniedTable {
                    name: table.name.clone(),
                    reason: "kbe_ internal table is excluded from clone by default".into(),
                });
                continue;
            }
            let physical_table = match physical.table(&table.name) {
                Some(pt) => pt,
                None => {
                    missing.push(table.name.clone());
                    continue;
                }
            };
            if !physical_table.is_transactional() {
                return Err(CloneError::NonTransactionalTable(table.name.clone()));
            }
            for field in &table.fields {
                let phys = physical_table.columns.get(&field.name).ok_or_else(|| {
                    CloneError::UnknownColumn {
                        table: table.name.clone(),
                        column: field.name.clone(),
                    }
                })?;
                if !type_compatible(&field.type_label, phys) {
                    return Err(CloneError::DriftMismatch(format!(
                        "table `{}` column `{}` derived `{}` vs physical `{phys}`",
                        table.name, field.name, field.type_label
                    )));
                }
            }
            tables.push(table.clone());
        }

        // Physical-only tables absent from the derived side: engine internal /
        // unknown tables, deny instead of guessing.
        for name in physical.table_names() {
            if !derived.table_index.contains_key(&name) {
                denied.push(DeniedTable {
                    name,
                    reason:
                        "physical-only table not in derived schema; refusing to guess a relation"
                            .into(),
                });
            }
        }

        Ok(ResolvedCloneSchema {
            tables,
            denied,
            missing,
        })
    }
}

/// Whether the derived column type is compatible with the physical one
/// (case-insensitive, ignoring display width and charset differences).
fn type_compatible(derived: &str, physical: &str) -> bool {
    let d = normalize_type(derived);
    let p = normalize_type(physical);
    d == p
}

/// Normalizes a column type: `varchar(255)`→`varchar`, `bigint(20) unsigned`→
/// `bigint unsigned`, etc.
fn normalize_type(t: &str) -> String {
    let lower = t.trim().to_ascii_lowercase();
    // Drop display width/length parameters inside parentheses, keep suffixes like
    // `unsigned`.
    let base = lower
        .split_once('(')
        .map(|(head, _rest)| head.trim().to_string())
        .unwrap_or(lower.clone());
    let mut out = base;
    if lower.contains("unsigned") && !out.contains("unsigned") {
        out.push_str(" unsigned");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, ty: &str) -> DerivedField {
        DerivedField {
            name: name.into(),
            type_label: ty.into(),
            identifier: name == "id",
            synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
            source: SchemaSource::Def,
        }
    }

    fn root(name: &str) -> DerivedTable {
        DerivedTable {
            name: name.into(),
            kind: "root".into(),
            parent_table_name: None,
            property_path: None,
            fields: vec![
                field("id", "bigint unsigned"),
                field("sm_autoLoad", "tinyint"),
            ],
        }
    }

    fn child(name: &str, parent: &str) -> DerivedTable {
        DerivedTable {
            name: name.into(),
            kind: "array".into(),
            parent_table_name: Some(parent.into()),
            property_path: Some(name.into()),
            fields: vec![
                field("id", "bigint unsigned"),
                field("parentID", "bigint unsigned"),
                field("sm_value", "varchar"),
            ],
        }
    }

    #[test]
    fn resolve_matches_derived_and_physical() {
        let derived = CloneSchema::new(
            "Avatar".into(),
            vec![root("tbl_Avatar"), child("tbl_Avatar_items", "tbl_Avatar")],
        )
        .unwrap();
        let physical = VirtualSchema::new(vec![
            PhysicalTable {
                name: "tbl_Avatar".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::from([
                    ("id".into(), "bigint(20) unsigned".into()),
                    ("sm_autoLoad".into(), "tinyint".into()),
                ]),
                primary_key: vec!["id".into()],
                indexes: vec![vec!["sm_autoLoad".into()]],
            },
            PhysicalTable {
                name: "tbl_Avatar_items".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::from([
                    ("id".into(), "bigint(20) unsigned".into()),
                    ("parentID".into(), "bigint(20) unsigned".into()),
                    ("sm_value".into(), "varchar(255)".into()),
                ]),
                primary_key: vec!["id".into()],
                indexes: vec![vec!["parentID".into()]],
            },
        ]);
        let resolved = SchemaResolver::resolve(&derived, &physical).unwrap();
        assert_eq!(resolved.tables.len(), 2);
        assert!(resolved.denied.is_empty());
        assert!(resolved.missing.is_empty());
    }

    #[test]
    fn fail_closed_on_missing_physical_table() {
        let derived = CloneSchema::new("Avatar".into(), vec![root("tbl_Avatar")]).unwrap();
        let physical = VirtualSchema::new(vec![]);
        let resolved = SchemaResolver::resolve(&derived, &physical).unwrap();
        assert_eq!(resolved.missing, vec!["tbl_Avatar".to_string()]);
    }

    #[test]
    fn deny_kbe_and_physical_only() {
        let derived = CloneSchema::new("Avatar".into(), vec![root("tbl_Avatar")]).unwrap();
        let physical = VirtualSchema::new(vec![
            PhysicalTable {
                name: "tbl_Avatar".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::from([
                    ("id".into(), "bigint unsigned".into()),
                    ("sm_autoLoad".into(), "tinyint".into()),
                ]),
                primary_key: vec!["id".into()],
                indexes: vec![],
            },
            PhysicalTable {
                name: "kbe_accountinfos".into(),
                engine: "InnoDB".into(),
                columns: BTreeMap::new(),
                primary_key: vec![],
                indexes: vec![],
            },
        ]);
        let resolved = SchemaResolver::resolve(&derived, &physical).unwrap();
        let denied_names: Vec<&str> = resolved.denied.iter().map(|d| d.name.as_str()).collect();
        assert!(denied_names.contains(&"kbe_accountinfos"));
    }

    #[test]
    fn fail_closed_on_type_mismatch() {
        let derived = CloneSchema::new("Avatar".into(), vec![root("tbl_Avatar")]).unwrap();
        let physical = VirtualSchema::new(vec![PhysicalTable {
            name: "tbl_Avatar".into(),
            engine: "InnoDB".into(),
            columns: BTreeMap::from([
                ("id".into(), "bigint unsigned".into()),
                ("sm_autoLoad".into(), "bigint".into()), // incompatible type
            ]),
            primary_key: vec!["id".into()],
            indexes: vec![],
        }]);
        let err = SchemaResolver::resolve(&derived, &physical).unwrap_err();
        assert!(matches!(err, CloneError::DriftMismatch(_)));
    }

    #[test]
    fn reject_non_transactional_table() {
        let derived = CloneSchema::new("Avatar".into(), vec![root("tbl_Avatar")]).unwrap();
        let physical = VirtualSchema::new(vec![PhysicalTable {
            name: "tbl_Avatar".into(),
            engine: "MyISAM".into(),
            columns: BTreeMap::from([
                ("id".into(), "bigint unsigned".into()),
                ("sm_autoLoad".into(), "tinyint".into()),
            ]),
            primary_key: vec!["id".into()],
            indexes: vec![],
        }]);
        let err = SchemaResolver::resolve(&derived, &physical).unwrap_err();
        assert!(matches!(err, CloneError::NonTransactionalTable(_)));
    }

    #[test]
    fn duplicate_table_rejected() {
        let err = CloneSchema::new(
            "Avatar".into(),
            vec![root("tbl_Avatar"), root("tbl_Avatar")],
        )
        .unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(_)));
    }

    #[test]
    fn rejects_schema_without_exactly_one_root() {
        // Both zero root tables (all children) and two root tables are rejected:
        // engine cloning is bounded to a single entity.
        let no_root = CloneSchema::new(
            "Avatar".into(),
            vec![child("tbl_Avatar_items", "tbl_Avatar")],
        )
        .unwrap_err();
        assert!(
            no_root
                .to_string()
                .contains("expected exactly one root table, found 0"),
            "{no_root}"
        );
        let two_roots = CloneSchema::new(
            "Avatar".into(),
            vec![root("tbl_Avatar"), root("tbl_Account")],
        )
        .unwrap_err();
        assert!(
            two_roots
                .to_string()
                .contains("expected exactly one root table, found 2"),
            "{two_roots}"
        );
    }

    #[test]
    fn rejects_child_referencing_unknown_parent() {
        // Child parent reference dangling: fail closed, no guessed relation.
        let err = CloneSchema::new(
            "Avatar".into(),
            vec![root("tbl_Avatar"), child("tbl_Items", "tbl_Ghost")],
        )
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("references unknown parent `tbl_Ghost`"),
            "{err}"
        );
    }

    #[test]
    fn resolve_denies_kbe_prefixed_derived_table() {
        // kbe_ internal tables: excluded into denied by default (with a reason),
        // not resolved.
        let mut kbe = root("kbe_mail");
        kbe.kind = "array".into();
        let derived = CloneSchema::new("Avatar".into(), vec![root("tbl_Avatar"), kbe]).unwrap();
        let physical = VirtualSchema::new(vec![PhysicalTable {
            name: "tbl_Avatar".into(),
            engine: "InnoDB".into(),
            columns: BTreeMap::from([
                ("id".into(), "bigint(20) unsigned".into()),
                ("sm_autoLoad".into(), "tinyint".into()),
            ]),
            primary_key: vec!["id".into()],
            indexes: vec![],
        }]);
        let resolved = SchemaResolver::resolve(&derived, &physical).unwrap();
        assert_eq!(resolved.tables.len(), 1);
        assert_eq!(resolved.denied.len(), 1);
        assert_eq!(resolved.denied[0].name, "kbe_mail");
        assert!(resolved.denied[0].reason.contains("kbe_"));
    }

    #[test]
    fn resolve_fails_closed_on_derived_column_missing_from_physical() {
        // Derived column missing on the physical side: UnknownColumn, no default
        // type guessed.
        let derived = CloneSchema::new("Avatar".into(), vec![root("tbl_Avatar")]).unwrap();
        let physical = VirtualSchema::new(vec![PhysicalTable {
            name: "tbl_Avatar".into(),
            engine: "InnoDB".into(),
            // Missing the sm_autoLoad column.
            columns: BTreeMap::from([("id".into(), "bigint(20) unsigned".into())]),
            primary_key: vec!["id".into()],
            indexes: vec![],
        }]);
        let err = SchemaResolver::resolve(&derived, &physical).unwrap_err();
        assert!(matches!(err, CloneError::UnknownColumn { .. }), "{err}");
    }
}
