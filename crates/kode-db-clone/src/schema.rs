//! 两级 Schema(plan §4.1):派生(DefDerivedSchema)+ 物理(PhysicalSchema)→ 已解析(ResolvedCloneSchema)。
//!
//! 派生侧数据镜像 kode-server `database_schema` 推导输出(字段语义一致,接入为机械映射)。
//! 物理侧经 `PhysicalSchema` trait 抽象:虚拟 Fixture 用 [`VirtualSchema`],真实库由
//! `information_schema` 读取器(Phase 后续,依赖真实 MySQL)实现。任何未确认映射 fail-closed。

use std::collections::BTreeMap;

use crate::error::{CloneError, CloneResult};

/// 列的来源(plan §5.4 manifest 溯源)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SchemaSource {
    /// 来自 `.def`/`types.xml` 属性声明。
    Def,
    /// 引擎合成列(id/parentID/sm_*),非 def 推导。
    Synthetic,
    /// 未知来源(物理层独有,未在派生侧匹配)。
    Unknown,
}

/// 派生表字段(镜像推导输出 FieldSchema 的语义)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DerivedField {
    pub name: String,
    pub type_label: String,
    pub identifier: bool,
    pub synthetic: bool,
    pub source: SchemaSource,
}

/// 派生表(镜像推导输出 TableSchema 的语义)。`kind` ∈ {root, array, component}。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DerivedTable {
    pub name: String,
    pub kind: String,
    /// 非根表指向父表(ARRAY/组件子表的逻辑父)。
    pub parent_table_name: Option<String>,
    /// def 属性路径(子表对应属性链),根表为 None。
    pub property_path: Option<String>,
    pub fields: Vec<DerivedField>,
}

/// def 派生 schema(DefDerivedSchema 等价)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneSchema {
    pub entity_name: String,
    pub tables: Vec<DerivedTable>,
    /// 表名 → 表(派生侧索引)。
    pub table_index: BTreeMap<String, DerivedTable>,
}

impl CloneSchema {
    /// 由表列表构建并校验:根表唯一、子表父引用有效(无悬空父)。
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

/// 物理表(来自 information_schema 的列/键/引擎信息)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysicalTable {
    pub name: String,
    /// 存储引擎,如 `InnoDB`。
    pub engine: String,
    /// 列名 → 规范化列类型(如 `bigint unsigned`、`varchar(255)`)。
    pub columns: BTreeMap<String, String>,
    /// 主键列(若有)。
    pub primary_key: Vec<String>,
    /// 索引列(不含主键)。
    pub indexes: Vec<Vec<String>>,
}

impl PhysicalTable {
    pub fn is_transactional(&self) -> bool {
        self.engine.eq_ignore_ascii_case("InnoDB")
    }
}

/// 物理 schema 读取抽象:虚拟 Fixture 用 [`VirtualSchema`],真实库用 information_schema 读取器。
pub trait PhysicalSchema {
    fn table(&self, name: &str) -> Option<&PhysicalTable>;
    fn table_names(&self) -> Vec<String>;
}

/// 虚拟物理 schema(测试与 Phase 1 虚拟 Fixture 用)。
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

/// 已解析克隆 schema:仅含两侧匹配并经规则批准的表(plan §4.1)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCloneSchema {
    /// 通过派生+物理两侧匹配的表(含根表与引擎确定子表)。
    pub tables: Vec<DerivedTable>,
    /// 被拒绝的表(kbe_ 内部表、物理独有未派生表)与原因。
    pub denied: Vec<DeniedTable>,
    /// 派生表在物理侧缺失(未知表,禁止前缀猜测)——按 fail-closed 记为错误。
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeniedTable {
    pub name: String,
    pub reason: String,
}

/// Schema 解析器:匹配派生↔物理,校验类型/引擎,应用 allow/deny(kbe_ deny)。
#[derive(Debug)]
pub struct SchemaResolver;

/// 引擎内部表前缀(plan §2/§4.1:kbe_ 内部表默认排除)。
const KBE_PREFIX: &str = "kbe_";

impl SchemaResolver {
    /// 解析并校验。派生表必须在物理侧存在且字段类型兼容,否则 fail-closed。
    /// `kbe_` 前缀表与物理独有未派生表 → deny(排除)。
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

        // 物理独有、未在派生侧的表:引擎内部表/未知表,deny 而非猜测。
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

/// 派生列型与物理列型是否兼容(大小写无关,忽略显示宽度与字符集差异)。
fn type_compatible(derived: &str, physical: &str) -> bool {
    let d = normalize_type(derived);
    let p = normalize_type(physical);
    d == p
}

/// 规范化列型:`varchar(255)`→`varchar`、`bigint(20) unsigned`→`bigint unsigned` 等。
fn normalize_type(t: &str) -> String {
    let lower = t.trim().to_ascii_lowercase();
    // 去除括号内显示宽度/长度参数,保留 `unsigned` 等后缀。
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
                ("sm_autoLoad".into(), "bigint".into()), // 型不兼容
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
}
