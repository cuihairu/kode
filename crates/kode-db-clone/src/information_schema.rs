//! PhysicalSchema 的 information_schema 读取器(PDC-0103)。
//!
//! 生成只读 `information_schema.TABLES/COLUMNS/STATISTICS` 查询(参数经标识符
//! 引用绑定 schema 名,来自连接配置非用户输入),按行组装 [`PhysicalTable`]。
//! 行获取经 [`RowSource`] 抽象:真实库用只读连接(Phase 2 PDC-0202 的
//! REPEATABLE READ 只读事务),测试/虚拟 Fixture 用内存行源。
//!
//! 漂移检查不在本模块(SchemaResolver::resolve 负责派生↔物理比对);本模块
//! 只把 information_schema 行变成物理表结构,不解释语义。

use std::collections::BTreeMap;

use crate::error::{CloneError, CloneResult};
use crate::schema::PhysicalTable;

/// 行源:执行一条 SQL 返回字符串单元格行(单元格为 NULL 时 None)。
/// 生产实现由 Phase 2 只读连接提供;此处接口面保持无驱动依赖。
pub trait RowSource {
    fn query(&self, sql: &str) -> CloneResult<Vec<Vec<Option<String>>>>;
}

/// 内存行源(测试/虚拟 Fixture):按 SQL 子串匹配预置行。
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

/// information_schema 读取器。
pub struct InformationSchemaReader<'a> {
    rows: &'a dyn RowSource,
    schema_name: String,
}

impl std::fmt::Debug for InformationSchemaReader<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 行源是 dyn,不展开(避免要求 RowSource: Debug)。
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

    /// 只读 TABLES 查询(表名 + 引擎)。
    fn tables_sql(&self) -> String {
        format!(
            "SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = {}",
            quote_string(&self.schema_name)
        )
    }

    /// 只读 COLUMNS 查询(表名 + 列名 + 列型,按序)。
    fn columns_sql(&self) -> String {
        format!(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME, ORDINAL_POSITION",
            quote_string(&self.schema_name)
        )
    }

    /// 只读 STATISTICS 查询(表名 + 索引名 + 列名 + 非唯一;PRIMARY 即主键)。
    fn statistics_sql(&self) -> String {
        format!(
            "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
            quote_string(&self.schema_name)
        )
    }

    /// 读全库物理表结构并包装为 [`VirtualSchema`](crate::VirtualSchema)(实现
    /// `PhysicalSchema`,可直接交 SchemaResolver::resolve)。查询失败 → fail-closed
    /// (不返回空集冒充「无表」)。
    pub fn load(&self) -> CloneResult<crate::schema::VirtualSchema> {
        Ok(crate::schema::VirtualSchema::new(self.read_all()?))
    }

    /// 读全库物理表结构(原始表列表)。
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
        // 表查询必须覆盖列查询(列无表行 → fail-closed,不猜)。
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
        // 索引:PRIMARY → 主键列(按序);其余按 INDEX_NAME 分组。
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

/// 字符串字面量引用(单引号转义):`TABLE_SCHEMA` 等是字符串列,值必须作
/// 字符串字面量比对,不能当反引号标识符(后者在真实 MySQL 报 Unknown column)。
fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成 information_schema 行(模拟真实返回)。
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
        // TABLE_SCHEMA 是字符串列:值必须作单引号字面量(内嵌单引号双写),
        // 不能作反引号标识符(后者在真实 MySQL/MariaDB 报 Unknown column)。
        let rows = canned_rows();
        let reader = InformationSchemaReader::new(&rows, "kbe'game");
        let sql = reader.tables_sql();
        assert!(
            sql.contains("TABLE_SCHEMA = 'kbe''game'"),
            "单引号转义: {sql}"
        );
        assert!(!sql.contains("`kbe"), "schema 值不得作反引号标识符: {sql}");
        for s in [reader.columns_sql(), reader.statistics_sql()] {
            assert!(s.contains("TABLE_SCHEMA = 'kbe''game'"), "单引号转义: {s}");
            assert!(!s.contains("`kbe"), "schema 值不得作反引号标识符: {s}");
        }
    }

    #[test]
    fn read_all_uses_readonly_queries_only() {
        // 读者生成的查询只含 information_schema 读取(SELECT),绝无 DML。
        let rows = canned_rows();
        let reader = InformationSchemaReader::new(&rows, "kbe");
        for sql in [
            reader.tables_sql(),
            reader.columns_sql(),
            reader.statistics_sql(),
        ] {
            assert!(sql.starts_with("SELECT "), "只读 SELECT: {sql}");
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
}
