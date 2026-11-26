//! Typed ID mapping (plan §6.3 / PDC-0304): the oldID → newID key must distinguish
//! physical table + primary key column; duplicate numbering across different tables must never cross-contaminate.
//! New primary keys are returned by the database after the target insert —
//! the plan phase (Prepare) only assigns **placeholders**; Apply (Phase 4) backfills with real values.
//!
//! The value domain uses [`TypedValue`] to preserve precision (full bigint unsigned range), with no arithmetic offset
//! (§6.3: all related fields use the mapping result, not an offset).
//!
//! Business permanently-stable IDs (item templates/skill configs/maps) do not enter the mapping: not being inserted means the original value stays,
//! and "unknown references are not globally replaced by default" is carried by omission, not by a sentinel value.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Serialize, Serializer};

use crate::value::TypedValue;

/// Total-order projection (TypedValue contains Float so Ord cannot be derived; the mapping key only needs a deterministic total order,
/// while equivalence semantics remain carried precisely by TypedValue's PartialEq).
pub(crate) fn value_rank(v: &TypedValue) -> (u8, String) {
    match v {
        TypedValue::Null => (0, String::new()),
        TypedValue::Int(x) => (1, x.to_string()),
        TypedValue::UInt(x) => (2, x.to_string()),
        TypedValue::BigUInt(x) => (3, x.to_string()),
        TypedValue::Float(x) => (4, format!("{:016x}", x.to_bits())),
        TypedValue::Double(x) => (5, format!("{:016x}", x.to_bits())),
        TypedValue::Decimal(x) => (6, x.clone()),
        TypedValue::Bytes(x) => (7, x.clone()),
        TypedValue::Text(x) => (8, x.clone()),
        TypedValue::DateTime {
            value,
            offset_minutes,
        } => (9, format!("{value}|{offset_minutes:?}")),
    }
}

/// Canonical key for set probing (the flat form of the same projection as value_rank).
pub(crate) fn value_key(v: &TypedValue) -> String {
    let (disc, payload) = value_rank(v);
    format!("{disc}:{payload}")
}

/// Import ID mode (§6.1/PDC-0303): an empty target preserves original DBIDs / an existing test DB allocates new IDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportMode {
    /// `preserve-id-if-empty`: keep the archive's original values (requires the target IDs to be free; the rehearsal checks for conflicts).
    PreserveIfEmpty,
    /// `allocate-new-ids`: reassign all primary keys/references (recommended default, lowers collision risk).
    AllocateNewIds,
}

/// Mapping key (§6.3: the database interface + Entity type are constrained by the plan as a whole; this carries the
/// physical table + primary key column + old value triple; serde flattens it into an auditable form).
#[derive(Debug, Clone, PartialEq)]
pub struct IdMapKey {
    pub table: String,
    pub column: String,
    pub old: TypedValue,
}

// Eq is std's prerequisite bound for Ord; the marker holds (the keys are dominated by
// integers/text, and lookup is governed by the injective projection of Ord).
impl Eq for IdMapKey {}

impl Ord for IdMapKey {
    fn cmp(&self, other: &Self) -> Ordering {
        (
            self.table.as_str(),
            self.column.as_str(),
            value_rank(&self.old),
        )
            .cmp(&(
                other.table.as_str(),
                other.column.as_str(),
                value_rank(&other.old),
            ))
    }
}

impl PartialOrd for IdMapKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// Hand-written serialization (keys into the audit face: table/column/old value, the old value in TypedValue's native form).
impl Serialize for IdMapKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("table", &self.table)?;
        map.serialize_entry("column", &self.column)?;
        map.serialize_entry("old", &self.old)?;
        map.end()
    }
}

/// Where an old value maps to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MappedId {
    /// Preserves the archive's original value (preserve-mode primary keys/structural references).
    Preserved,
    /// Apply gets the new primary key back from the database; planning only places a placeholder (the number is referenced within statements).
    Allocated { placeholder: u64 },
    /// Rewrite value already determined at planning time (unique-key local rebuild, PDC-0305).
    Rebuilt { value: TypedValue },
}

/// ID category (acceptance gate: the rehearsal must present the change face by category).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IdCategory {
    /// Root-table entity primary key.
    RootKey,
    /// Child-table row primary key.
    ChildRowKey,
    /// Child-table parentID (references a parent row within the same clone set).
    ParentReference,
    /// Declared-following business reference column (Follow rule, remapped).
    BusinessReference,
    /// Unique-key local rebuild (nickname/login name).
    RebuiltIdentity,
}

impl IdCategory {
    pub fn label(self) -> &'static str {
        match self {
            IdCategory::RootKey => "root-entity-key",
            IdCategory::ChildRowKey => "child-row-key",
            IdCategory::ParentReference => "parent-reference",
            IdCategory::BusinessReference => "business-reference",
            IdCategory::RebuiltIdentity => "rebuilt-identity",
        }
    }
}

/// One registration: key + mapping + category (audit face).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IdMapEntry {
    pub key: IdMapKey,
    pub mapped: MappedId,
    pub category: IdCategory,
}

/// The ID mapping ledger for this import (BTreeMap deterministic order; JSON keys must be strings,
/// so it serializes as an entry array in key order — equally auditable and free of key-projection distortion).
#[derive(Debug, Clone, Default)]
pub struct IdMap {
    entries: BTreeMap<IdMapKey, IdMapEntry>,
    next_placeholder: u64,
}

impl Serialize for IdMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = serializer.serialize_seq(Some(self.entries.len()))?;
        for entry in self.entries.values() {
            seq.serialize_element(entry)?;
        }
        seq.end()
    }
}

impl IdMap {
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            next_placeholder: 1,
        }
    }

    /// Registers a "preserve original value" entry.
    pub fn preserve(&mut self, key: IdMapKey, category: IdCategory) {
        self.insert(key, MappedId::Preserved, category);
    }

    /// Registers a placeholder new key (placeholders increase monotonically; planning never guesses the real value).
    pub fn allocate(&mut self, key: IdMapKey, category: IdCategory) -> MappedId {
        let placeholder = self.next_placeholder;
        self.next_placeholder += 1;
        let mapped = MappedId::Allocated { placeholder };
        self.insert(key, mapped.clone(), category);
        mapped
    }

    /// Registers a planning-time rewrite value (unique-key rebuild).
    pub fn rebuild(&mut self, key: IdMapKey, value: TypedValue, category: IdCategory) {
        self.insert(key, MappedId::Rebuilt { value }, category);
    }

    fn insert(&mut self, key: IdMapKey, mapped: MappedId, category: IdCategory) {
        // Duplicate registration of the same key overwrites per BTreeMap semantics; callers (the import
        // planner) register exactly once per row order, so a duplicate is an upstream logic bug, locked by tests.
        self.entries.insert(
            key.clone(),
            IdMapEntry {
                key,
                mapped,
                category,
            },
        );
    }

    /// Looks up where an old value maps (structural column rendering references the same mapping; nothing is computed separately).
    pub fn get(&self, table: &str, column: &str, old: &TypedValue) -> Option<&MappedId> {
        self.entries
            .get(&IdMapKey {
                table: table.into(),
                column: column.into(),
                old: old.clone(),
            })
            .map(|e| &e.mapped)
    }

    /// Placeholder → key (statement rendering aligns NewKey placeholders with the mapping ledger; used for Apply backfill).
    pub fn key_for_placeholder(&self, placeholder: u64) -> Option<&IdMapKey> {
        self.entries
            .values()
            .find(|e| e.mapped == MappedId::Allocated { placeholder })
            .map(|e| &e.key)
    }

    /// Counts by category (rehearsal summary face).
    pub fn counts_by_category(&self) -> BTreeMap<IdCategory, usize> {
        let mut out = BTreeMap::new();
        for entry in self.entries.values() {
            *out.entry(entry.category).or_insert(0) += 1;
        }
        out
    }

    /// All registrations (deterministic order, audit/test assertion face).
    pub fn entries(&self) -> impl Iterator<Item = &IdMapEntry> {
        self.entries.values()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(table: &str, column: &str, old: u64) -> IdMapKey {
        IdMapKey {
            table: table.into(),
            column: column.into(),
            old: TypedValue::BigUInt(old),
        }
    }

    #[test]
    fn keys_are_typed_per_table_and_column() {
        // §6.3: same-valued old keys in different tables/columns never cross-contaminate.
        let mut map = IdMap::new();
        map.allocate(key("tbl_Avatar", "id", 7), IdCategory::RootKey);
        map.preserve(key("tbl_Account", "id", 7), IdCategory::RootKey);
        assert_eq!(
            map.get("tbl_Avatar", "id", &TypedValue::BigUInt(7)),
            Some(&MappedId::Allocated { placeholder: 1 })
        );
        assert_eq!(
            map.get("tbl_Account", "id", &TypedValue::BigUInt(7)),
            Some(&MappedId::Preserved)
        );
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn placeholders_are_monotonic_and_resolvable() {
        let mut map = IdMap::new();
        map.allocate(key("tbl_Avatar", "id", 1), IdCategory::RootKey);
        map.allocate(key("tbl_Avatar_items", "id", 2), IdCategory::ChildRowKey);
        map.allocate(key("tbl_Avatar_items", "id", 3), IdCategory::ChildRowKey);
        assert_eq!(
            map.get("tbl_Avatar_items", "id", &TypedValue::BigUInt(3)),
            Some(&MappedId::Allocated { placeholder: 3 })
        );
        assert_eq!(
            map.key_for_placeholder(2).map(|k| k.table.as_str()),
            Some("tbl_Avatar_items")
        );
        assert!(map.key_for_placeholder(9).is_none());
    }

    #[test]
    fn counts_by_category_for_preview() {
        let mut map = IdMap::new();
        map.allocate(key("tbl_Avatar", "id", 1), IdCategory::RootKey);
        map.allocate(key("tbl_Avatar_items", "id", 2), IdCategory::ChildRowKey);
        map.preserve(
            key("tbl_Avatar_items", "parentID", 1),
            IdCategory::ParentReference,
        );
        map.rebuild(
            IdMapKey {
                table: "tbl_Avatar".into(),
                column: "sm_name".into(),
                old: TypedValue::Text("hero".into()),
            },
            TypedValue::Text("hero_imported1".into()),
            IdCategory::RebuiltIdentity,
        );
        let counts = map.counts_by_category();
        assert_eq!(counts.get(&IdCategory::RootKey), Some(&1));
        assert_eq!(counts.get(&IdCategory::ChildRowKey), Some(&1));
        assert_eq!(counts.get(&IdCategory::ParentReference), Some(&1));
        assert_eq!(counts.get(&IdCategory::RebuiltIdentity), Some(&1));
        assert_eq!(counts.get(&IdCategory::BusinessReference), None);
    }

    #[test]
    fn missing_key_is_none_not_default() {
        let map = IdMap::new();
        // An unregistered reference returns no mapping (callers must keep the original value, not replace it by default).
        assert!(map
            .get("tbl_Avatar", "sm_templateId", &TypedValue::BigUInt(42))
            .is_none());
    }

    #[test]
    fn value_rank_and_key_cover_all_value_kinds_deterministically() {
        // Order projection: Null < integer family < float family < decimal < bytes < text < datetime,
        // ordered by payload within a family; value_key is the flat form of the same projection (auditable string).
        let mut keys: Vec<String> = [
            TypedValue::Null,
            TypedValue::Int(-5),
            TypedValue::UInt(5),
            TypedValue::BigUInt(5),
            TypedValue::Float(1.5),
            TypedValue::Double(2.5),
            TypedValue::Decimal("1.23".into()),
            TypedValue::Bytes("0a".into()),
            TypedValue::Text("abc".into()),
            TypedValue::DateTime {
                value: "2026-01-01".into(),
                offset_minutes: Some(480),
            },
        ]
        .iter()
        .map(value_key)
        .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(
            keys, sorted,
            "rank order matches the enum declaration order"
        );
        assert_eq!(keys[0], "0:");
        assert!(keys[1].starts_with("1:-5"));
        assert!(keys[2].starts_with("2:5"));
        assert!(keys[3].starts_with("3:5"));
        assert!(keys[4].starts_with("4:"));
        assert!(keys[5].starts_with("5:"));
        assert!(keys[6].starts_with("6:1.23"));
        assert!(keys[7].starts_with("7:0a"));
        assert_eq!(keys[8], "8:abc");
        assert!(keys[9].starts_with("9:2026-01-01|Some(480)"));
        keys.dedup();
        assert_eq!(
            keys.len(),
            10,
            "the keys of the ten value kinds are all distinct"
        );
    }

    #[test]
    fn id_map_key_orders_by_table_then_column_then_value() {
        // Total order: table → column → value rank; partial_cmp agrees with cmp (Ord precondition).
        let a = IdMapKey {
            table: "tbl_A".into(),
            column: "id".into(),
            old: TypedValue::BigUInt(1),
        };
        let b = IdMapKey {
            table: "tbl_A".into(),
            column: "id".into(),
            old: TypedValue::Text("x".into()),
        };
        let c = IdMapKey {
            table: "tbl_B".into(),
            column: "id".into(),
            old: TypedValue::BigUInt(1),
        };
        assert!(a < b, "same table and column: numeric rank < text rank");
        assert!(b < c, "table name order decides the cross-table order");
        assert_eq!(a.cmp(&a), std::cmp::Ordering::Equal);
        assert_eq!(a.partial_cmp(&b), Some(a.cmp(&b)));
        assert!(a == a.clone());
    }

    #[test]
    fn id_map_len_and_is_empty_track_entries() {
        let mut map = IdMap::new();
        assert!(map.is_empty());
        assert_eq!(map.len(), 0);
        map.preserve(key("tbl_Avatar", "id", 7), IdCategory::RootKey);
        assert!(!map.is_empty());
        assert_eq!(map.len(), 1);
        assert_eq!(map.entries().count(), 1);
    }
}
