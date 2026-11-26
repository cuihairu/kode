//! information_schema reader for PhysicalSchema (PDC-0103).
//!
//! Generates read-only `information_schema.TABLES/COLUMNS/STATISTICS` queries (the schema name is bound
//! via an identifier reference; it comes from connection config, not user input) and assembles [`PhysicalTable`]s row by row.
//! Row access goes through the [`RowSource`] abstraction: real databases use a read-only connection
//! (Phase 2 PDC-0202's REPEATABLE READ read-only transaction); tests/virtual fixtures use an in-memory row source.
//!
//! Drift checking is not in this module (SchemaResolver::resolve handles derived↔physical comparison); this module
//! only turns information_schema rows into physical table structures, without interpreting semantics.

use std::collections::BTreeMap;

use crate::error::{CloneError, CloneResult};
use crate::schema::PhysicalTable;

/// Row source: executes one SQL statement and returns rows of string cells (None when a cell is NULL).
/// The production implementation is provided by the Phase 2 read-only connection; this interface face stays driver-free.
pub trait RowSource {
    fn query(&self, sql: &str) -> CloneResult<Vec<Vec<Option<String>>>>;
}

/// In-memory row source (tests/virtual fixtures): matches canned rows by SQL substring.
#[derive(Debug)]
pub struct VecRowSource(pub Vec<(String, Vec<Vec<Option<String>>>)>);

impl RowSource for VecRowSource {
    fn query(&self, sql: &str) -> CloneResult<Vec<Vec<Option<String>>>> {
        self.0
            .iter()
            .find(|(q, _)| sql.contains(q.as_str()))
            .map(|(_, rows)| rows.clone())
            .ok_or_else(|| CloneError::InvalidRule(format!("no canned rows for query `{sql}`")))
    }
}

/// information_schema reader.
pub struct InformationSchemaReader<'a> {
    rows: &'a dyn RowSource,
    schema_name: String,
}

impl std::fmt::Debug for InformationSchemaReader<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The row source is a dyn, not expanded (avoids requiring RowSource: Debug).
        f.debug_struct("InformationSchemaReader")
            .field("schema_name", &self.schema_name)
            .finish()
    }
}

impl<'a> InformationSchemaReader<'a> {
    pub fn new(rows: &'a dyn RowSource, schema_name: impl Into<String>) -> Self {
        Self {
            rows,
            schema_name: schema_name.into(),
        }
    }

    /// Read-only TABLES query (table name + engine).
    fn tables_sql(&self) -> String {
        format!(
            "SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = {}",
            quote_string(&self.schema_name)
        )
    }

    /// Read-only COLUMNS query (table name + column name + column type, in order).
    fn columns_sql(&self) -> String {
        format!(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME, ORDINAL_POSITION",
            quote_string(&self.schema_name)
        )
    }

    /// Read-only STATISTICS query (table name + index name + column name + non-unique; PRIMARY is the primary key).
    fn statistics_sql(&self) -> String {
        format!(
            "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
            quote_string(&self.schema_name)
        )
    }

    /// Reads the physical table structures of the whole database and wraps them as [`VirtualSchema`](crate::VirtualSchema)
    /// (implements `PhysicalSchema`, ready to hand to SchemaResolver::resolve). Query failure → fail-closed
    /// (never returns an empty set masquerading as "no tables").
    pub fn load(&self) -> CloneResult<crate::schema::VirtualSchema> {
        Ok(crate::schema::VirtualSchema::new(self.read_all()?))
    }

    /// Reads the physical table structures of the whole database (raw table list).
    pub fn read_all(&self) -> CloneResult<Vec<PhysicalTable>> {
        let table_rows = self.rows.query(&self.tables_sql())?;
        let column_rows = self.rows.query(&self.columns_sql())?;
        let stat_rows = self.rows.query(&self.statistics_sql())?;

        let mut tables: BTreeMap<String, PhysicalTable> = BTreeMap::new();
        for row in &table_rows {
            let name = row.first().and_then(|v| v.clone()).unwrap_or_default();
            let engine = row.get(1).and_then(|v| v.clone()).unwrap_or_default();
            tables.insert(
                name.clone(),
                PhysicalTable {
                    name,
                    engine,
                    columns: BTreeMap::new(),
                    primary_key: vec![],
                    indexes: vec![],
                },
            );
        }
        // The table query must cover the column query (a column row with no table row → fail-closed, no guessing).
        for row in &column_rows {
            let name = row
                .first()
                .and_then(|v| v.clone())
                .ok_or_else(|| CloneError::DriftMismatch("column row missing table name".into()))?;
            let table = tables.get_mut(&name).ok_or_else(|| {
                CloneError::DriftMismatch(format!(
                    "column row references table `{name}` absent from TABLES result"
                ))
            })?;
            let column = row.get(1).and_then(|v| v.clone()).ok_or_else(|| {
                CloneError::DriftMismatch(format!("column row missing column name in `{name}`"))
            })?;
            let col_type = row.get(2).and_then(|v| v.clone()).unwrap_or_default();
            table.columns.insert(column, col_type);
        }
        // Indexes: PRIMARY → primary key columns (in order); the rest grouped by INDEX_NAME.
        let mut index_cols: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
        let mut primary_keys: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for row in &stat_rows {
            let name = row.first().and_then(|v| v.clone()).ok_or_else(|| {
                CloneError::DriftMismatch("statistics row missing table name".into())
            })?;
            if !tables.contains_key(&name) {
                return Err(CloneError::DriftMismatch(format!(
                    "statistics row references table `{name}` absent from TABLES result"
                )));
            }
            let index = row.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let column = row.get(2).and_then(|v| v.clone()).unwrap_or_default();
            if index == "PRIMARY" {
                primary_keys.entry(name).or_default().push(column);
            } else {
                index_cols
                    .entry((name.clone(), index))
                    .or_default()
                    .push(column);
            }
        }
        for (name, cols) in primary_keys {
            tables.get_mut(&name).unwrap().primary_key = cols;
        }
        for ((name, _index), cols) in index_cols {
            tables.get_mut(&name).unwrap().indexes.push(cols);
        }
        Ok(tables.into_values().collect())
    }
}

/// String-literal quoting (single-quote escaped): `TABLE_SCHEMA` and friends are string columns, so values must be
/// compared as string literals, not backtick identifiers (the latter errors with Unknown column on real MySQL).
fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic information_schema rows (mimics a real return).
    fn canned_rows() -> VecRowSource {
        VecRowSource(vec![
            (
                "FROM information_schema.TABLES".into(),
                vec![
                    vec![Some("tbl_Avatar".into()), Some("InnoDB".into())],
                    vec![Some("tbl_Avatar_items".into()), Some("InnoDB".into())],
                    vec![Some("kbe_entitylog".into()), Some("InnoDB".into())],
                    vec![Some("tbl_MyISAM".into()), Some("MyISAM".into())],
                ],
            ),
            (
                "FROM information_schema.COLUMNS".into(),
                vec![
                    vec![
                        Some("tbl_Avatar".into()),
                        Some("id".into()),
                        Some("bigint(20) unsigned".into()),
                    ],
                    vec![
                        Some("tbl_Avatar".into()),
                        Some("sm_autoLoad".into()),
                        Some("tinyint".into()),
                    ],
                    vec![
                        Some("tbl_Avatar_items".into()),
                        Some("id".into()),
                        Some("bigint(20) unsigned".into()),
                    ],
                    vec![
                        Some("tbl_Avatar_items".into()),
                        Some("parentID".into()),
                        Some("bigint(20) unsigned".into()),
                    ],
                    vec![
                        Some("kbe_entitylog".into()),
                        Some("id".into()),
                        Some("bigint(20) unsigned".into()),
                    ],
                    vec![
                        Some("tbl_MyISAM".into()),
                        Some("id".into()),
                        Some("bigint(20) unsigned".into()),
                    ],
                ],
            ),
            (
                "FROM information_schema.STATISTICS".into(),
                vec![
                    vec![
                        Some("tbl_Avatar".into()),
                        Some("PRIMARY".into()),
                        Some("id".into()),
                        Some("0".into()),
                    ],
                    vec![
                        Some("tbl_Avatar".into()),
                        Some("idx_autoLoad".into()),
                        Some("sm_autoLoad".into()),
                        Some("1".into()),
                    ],
                    vec![
                        Some("tbl_Avatar_items".into()),
                        Some("PRIMARY".into()),
                        Some("id".into()),
                        Some("0".into()),
                    ],
                    vec![
                        Some("tbl_Avatar_items".into()),
                        Some("idx_parent".into()),
                        Some("parentID".into()),
                        Some("1".into()),
                    ],
                ],
            ),
        ])
    }

    #[test]
    fn load_wraps_snapshot_resolvable_by_schema_resolver() {
        let rows = canned_rows();
        let reader = InformationSchemaReader::new(&rows, "kbe");
        let phys = reader.load().unwrap();
        use crate::schema::PhysicalSchema as _;
        assert!(phys.table("tbl_Avatar").is_some());
        assert_eq!(phys.table_names().len(), 4);
    }

    #[test]
    fn builds_physical_tables_from_rows() {
        let rows = canned_rows();
        let reader = InformationSchemaReader::new(&rows, "kbe");
        let tables = reader.read_all().unwrap();
        assert_eq!(tables.len(), 4);
        let avatar = tables.iter().find(|t| t.name == "tbl_Avatar").unwrap();
        assert!(avatar.is_transactional());
        assert_eq!(avatar.columns.len(), 2);
        assert_eq!(avatar.primary_key, vec!["id"]);
        assert_eq!(avatar.indexes, vec![vec!["sm_autoLoad"]]);
        let items = tables
            .iter()
            .find(|t| t.name == "tbl_Avatar_items")
            .unwrap();
        assert_eq!(items.primary_key, vec!["id"]);
        assert_eq!(items.indexes, vec![vec!["parentID"]]);
        let myisam = tables.iter().find(|t| t.name == "tbl_MyISAM").unwrap();
        assert!(!myisam.is_transactional());
    }

    #[test]
    fn quotes_schema_as_string_literal() {
        // TABLE_SCHEMA is a string column: values must be single-quoted literals (embedded single quotes doubled),
        // never backtick identifiers (the latter errors with Unknown column on real MySQL/MariaDB).
        let rows = canned_rows();
        let reader = InformationSchemaReader::new(&rows, "kbe'game");
        let sql = reader.tables_sql();
        assert!(
            sql.contains("TABLE_SCHEMA = 'kbe''game'"),
            "single-quote escaping: {sql}"
        );
        assert!(
            !sql.contains("`kbe"),
            "schema values must not be backtick identifiers: {sql}"
        );
        for s in [reader.columns_sql(), reader.statistics_sql()] {
            assert!(
                s.contains("TABLE_SCHEMA = 'kbe''game'"),
                "single-quote escaping: {s}"
            );
            assert!(
                !s.contains("`kbe"),
                "schema values must not be backtick identifiers: {s}"
            );
        }
    }

    #[test]
    fn read_all_uses_readonly_queries_only() {
        // Queries the reader generates contain only information_schema reads (SELECT), never DML.
        let rows = canned_rows();
        let reader = InformationSchemaReader::new(&rows, "kbe");
        for sql in [
            reader.tables_sql(),
            reader.columns_sql(),
            reader.statistics_sql(),
        ] {
            assert!(sql.starts_with("SELECT "), "read-only SELECT: {sql}");
            assert!(!sql.contains("INSERT") && !sql.contains("UPDATE") && !sql.contains("DELETE"));
        }
    }

    #[test]
    fn fail_closed_when_column_row_has_no_table() {
        let rows = VecRowSource(vec![
            (
                "FROM information_schema.TABLES".into(),
                vec![vec![Some("tbl_Avatar".into()), Some("InnoDB".into())]],
            ),
            (
                "FROM information_schema.COLUMNS".into(),
                vec![vec![None, Some("id".into()), Some("bigint".into())]],
            ),
            ("FROM information_schema.STATISTICS".into(), vec![]),
        ]);
        let reader = InformationSchemaReader::new(&rows, "kbe");
        let err = reader.read_all().unwrap_err();
        assert!(matches!(err, CloneError::DriftMismatch(_)));
    }

    fn rows_with(
        tables: Vec<Vec<Option<String>>>,
        columns: Vec<Vec<Option<String>>>,
        stats: Vec<Vec<Option<String>>>,
    ) -> VecRowSource {
        VecRowSource(vec![
            ("FROM information_schema.TABLES".into(), tables),
            ("FROM information_schema.COLUMNS".into(), columns),
            ("FROM information_schema.STATISTICS".into(), stats),
        ])
    }

    #[test]
    fn column_row_for_table_absent_from_tables_result_is_drift() {
        // The column query yields a table TABLES does not have: fail-closed, no guessing at table structure.
        let rows = rows_with(
            vec![vec![Some("tbl_Avatar".into()), Some("InnoDB".into())]],
            vec![vec![
                Some("tbl_Ghost".into()),
                Some("id".into()),
                Some("bigint".into()),
            ]],
            vec![],
        );
        let err = InformationSchemaReader::new(&rows, "kbe")
            .read_all()
            .unwrap_err();
        assert!(
            matches!(err, CloneError::DriftMismatch(ref m) if m.contains("tbl_Ghost")),
            "{err}"
        );
    }

    #[test]
    fn column_row_missing_column_name_is_drift() {
        // Column row missing its column name (NULL): fail-closed.
        let rows = rows_with(
            vec![vec![Some("tbl_Avatar".into()), Some("InnoDB".into())]],
            vec![vec![Some("tbl_Avatar".into()), None, Some("bigint".into())]],
            vec![],
        );
        let err = InformationSchemaReader::new(&rows, "kbe")
            .read_all()
            .unwrap_err();
        assert!(
            matches!(err, CloneError::DriftMismatch(ref m) if m.contains("missing column name")),
            "{err}"
        );
    }

    #[test]
    fn statistics_row_missing_table_name_is_drift() {
        // Index row missing its table name (NULL): fail-closed.
        let rows = rows_with(
            vec![vec![Some("tbl_Avatar".into()), Some("InnoDB".into())]],
            vec![],
            vec![vec![
                None,
                Some("PRIMARY".into()),
                Some("id".into()),
                Some("0".into()),
            ]],
        );
        let err = InformationSchemaReader::new(&rows, "kbe")
            .read_all()
            .unwrap_err();
        assert!(
            matches!(err, CloneError::DriftMismatch(ref m) if m.contains("missing table name")),
            "{err}"
        );
    }

    #[test]
    fn statistics_row_for_table_absent_from_tables_result_is_drift() {
        // The index query yields a table TABLES does not have: fail-closed.
        let rows = rows_with(
            vec![vec![Some("tbl_Avatar".into()), Some("InnoDB".into())]],
            vec![],
            vec![vec![
                Some("tbl_Ghost".into()),
                Some("PRIMARY".into()),
                Some("id".into()),
                Some("0".into()),
            ]],
        );
        let err = InformationSchemaReader::new(&rows, "kbe")
            .read_all()
            .unwrap_err();
        assert!(
            matches!(err, CloneError::DriftMismatch(ref m) if m.contains("tbl_Ghost")),
            "{err}"
        );
    }

    #[test]
    fn reader_debug_renders_schema_name_only() {
        // Debug is the log face: shows the schema name; the row source is a dyn and is not expanded.
        let rows = canned_rows();
        let reader = InformationSchemaReader::new(&rows, "kbe_game");
        let rendered = format!("{reader:?}");
        assert!(rendered.contains("InformationSchemaReader"), "{rendered}");
        assert!(rendered.contains("kbe_game"), "{rendered}");
        assert!(
            !rendered.contains("tbl_Avatar"),
            "row source not expanded: {rendered}"
        );
    }
}
