//! 显式规则层(plan §4.2-C / §5):业务显式关系(Account.characters、guildDBID)、
//! 身份列(跨克隆稳定的外部标识)、投影(列子集)。
//!
//! 规则由调用方(接入 kode-server 时从用户配置/声明加载)提供;本层只应用,
//! 不做字符串猜测。引擎确定关系(§4.2-A)不需要规则。

use crate::error::{CloneError, CloneResult};
use crate::schema::{CloneSchema, DerivedField, DerivedTable};

/// 关系规则动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationRuleAction {
    /// 跟随该关系(纳入导出/导入)。
    Follow,
    /// 跳过(不随克隆迁移,记录但不报错)。
    Skip,
    /// 视作错误(fail-closed)。
    Error,
}

/// 业务显式关系(§4.2-C):由用户声明,非引擎派生。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationRule {
    /// 声明方实体(如 Account)。
    pub entity: String,
    /// 声明路径(如 characters)。
    pub property_path: String,
    /// 子表(被引用侧)。
    pub child_table: String,
    /// 父表(引用侧)。
    pub parent_table: String,
    /// 子表上指向父表的逻辑列。
    pub join_column: String,
    pub action: RelationRuleAction,
    pub note: Option<String>,
}

/// 身份列:跨克隆保持稳定语义的外部标识(如账号名/guid),Phase 3 IDMapper 据此对映射。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityRule {
    pub entity: String,
    pub table: String,
    pub column: String,
}

/// 投影规则:表内列子集(include 为 None 表示全含;exclude 剔除)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRule {
    pub table: String,
    pub include_columns: Option<Vec<String>>,
    pub exclude_columns: Vec<String>,
}

impl ProjectRule {
    pub fn allows(&self, column: &str) -> bool {
        if self.exclude_columns.iter().any(|c| c == column) {
            return false;
        }
        match &self.include_columns {
            Some(included) => included.iter().any(|c| c == column),
            None => true,
        }
    }
}

/// 规则集(应用层入口)。
#[derive(Debug, Clone, Default)]
pub struct RuleSet {
    pub relations: Vec<RelationRule>,
    pub identities: Vec<IdentityRule>,
    pub projections: Vec<ProjectRule>,
}

impl RuleSet {
    /// 投影一张派生表(按规则裁剪字段;恒保留 id/parentID/sm_autoLoad 结构列)。
    pub fn project(&self, table: &DerivedTable) -> DerivedTable {
        let Some(rule) = self.projections.iter().find(|r| r.table == table.name) else {
            return table.clone();
        };
        let mut fields: Vec<DerivedField> = Vec::new();
        for field in &table.fields {
            let structural = matches!(field.name.as_str(), "id" | "parentID" | "sm_autoLoad");
            if structural || rule.allows(&field.name) {
                fields.push(field.clone());
            }
        }
        let mut projected = table.clone();
        projected.fields = fields;
        projected
    }

    /// 应用关系规则(把声明的关系归为 ExplicitBusiness / Skip / Error)。
    pub fn apply_relation(
        &self,
        entity: &str,
        property_path: &str,
    ) -> CloneResult<Option<RelationRuleAction>> {
        for rule in &self.relations {
            if rule.entity == entity && rule.property_path == property_path {
                return match rule.action {
                    RelationRuleAction::Error => Err(CloneError::InvalidRule(format!(
                        "relation rule for {entity}.{property_path} declares an error"
                    ))),
                    action => Ok(Some(action)),
                };
            }
        }
        Ok(None)
    }

    /// 身份列:返回该表被声明为身份载体的列(若有)。
    pub fn identity_column(&self, table: &str) -> Option<&str> {
        self.identities
            .iter()
            .find(|r| r.table == table)
            .map(|r| r.column.as_str())
    }

    /// 校验规则自洽:投影/身份引用的表与列须在派生 schema 内存在(fail-closed)。
    pub fn validate(&self, schema: &CloneSchema) -> CloneResult<()> {
        for rule in &self.projections {
            let table = schema.table_index.get(&rule.table).ok_or_else(|| {
                CloneError::InvalidRule(format!(
                    "projection references unknown table `{}`",
                    rule.table
                ))
            })?;
            let known: Vec<&str> = table.fields.iter().map(|f| f.name.as_str()).collect();
            if let Some(included) = &rule.include_columns {
                for col in included {
                    if !known.contains(&col.as_str()) {
                        return Err(CloneError::InvalidRule(format!(
                            "projection includes unknown column `{col}` of table `{}`",
                            rule.table
                        )));
                    }
                }
            }
            for col in &rule.exclude_columns {
                if !known.contains(&col.as_str()) {
                    return Err(CloneError::InvalidRule(format!(
                        "projection excludes unknown column `{col}` of table `{}`",
                        rule.table
                    )));
                }
            }
        }
        for rule in &self.identities {
            let table = schema.table_index.get(&rule.table).ok_or_else(|| {
                CloneError::InvalidRule(format!(
                    "identity references unknown table `{}`",
                    rule.table
                ))
            })?;
            if !table.fields.iter().any(|f| f.name == rule.column) {
                return Err(CloneError::InvalidRule(format!(
                    "identity column `{}` not in table `{}`",
                    rule.column, rule.table
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{SchemaSource, VirtualSchema};

    fn field(name: &str) -> DerivedField {
        DerivedField {
            name: name.into(),
            type_label: "varchar".into(),
            identifier: name == "id",
            synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
            source: SchemaSource::Def,
        }
    }

    fn table(name: &str) -> DerivedTable {
        DerivedTable {
            name: name.into(),
            kind: "root".into(),
            parent_table_name: None,
            property_path: None,
            fields: vec![
                field("id"),
                field("sm_autoLoad"),
                field("name"),
                field("level"),
                field("hp"),
            ],
        }
    }

    #[test]
    fn project_keeps_structural_and_included() {
        let t = table("tbl_Avatar");
        let rules = RuleSet {
            projections: vec![ProjectRule {
                table: "tbl_Avatar".into(),
                include_columns: Some(vec!["name".into(), "level".into()]),
                exclude_columns: vec![],
            }],
            ..Default::default()
        };
        let projected = rules.project(&t);
        let names: Vec<&str> = projected.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "sm_autoLoad", "name", "level"]);
    }

    #[test]
    fn validate_rejects_unknown_column() {
        let schema = CloneSchema::new("Avatar".into(), vec![table("tbl_Avatar")]).unwrap();
        let rules = RuleSet {
            projections: vec![ProjectRule {
                table: "tbl_Avatar".into(),
                include_columns: Some(vec!["not_a_column".into()]),
                exclude_columns: vec![],
            }],
            ..Default::default()
        };
        let err = rules.validate(&schema).unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(_)));
    }

    #[test]
    fn relation_rule_error_action_fails_closed() {
        let rules = RuleSet {
            relations: vec![RelationRule {
                entity: "Account".into(),
                property_path: "characters".into(),
                child_table: "tbl_Account_characters".into(),
                parent_table: "tbl_Account".into(),
                join_column: "parentID".into(),
                action: RelationRuleAction::Error,
                note: None,
            }],
            ..Default::default()
        };
        let err = rules.apply_relation("Account", "characters").unwrap_err();
        assert!(matches!(err, CloneError::InvalidRule(_)));
    }

    #[test]
    fn relation_rule_follow_action_ok() {
        let rules = RuleSet {
            relations: vec![RelationRule {
                entity: "Account".into(),
                property_path: "characters".into(),
                child_table: "tbl_Account_characters".into(),
                parent_table: "tbl_Account".into(),
                join_column: "parentID".into(),
                action: RelationRuleAction::Follow,
                note: None,
            }],
            ..Default::default()
        };
        assert_eq!(
            rules.apply_relation("Account", "characters").unwrap(),
            Some(RelationRuleAction::Follow)
        );
        // 未声明关系 → 引擎确定路径,无显式规则。
        assert_eq!(rules.apply_relation("Account", "inventory").unwrap(), None);
    }

    #[test]
    fn project_rule_allows_exclude_hit_and_include_none_means_all() {
        // exclude 命中 → false;include=None 语义 = 全含(未被 exclude 的都 true)。
        let rule = ProjectRule {
            table: "tbl_Avatar".into(),
            include_columns: None,
            exclude_columns: vec!["hp".into()],
        };
        assert!(!rule.allows("hp"));
        assert!(rule.allows("name"));
        assert!(rule.allows("level"));
    }

    #[test]
    fn project_exclude_trims_column_but_structural_columns_survive() {
        // 结构列(id/parentID/sm_autoLoad)不受 exclude 影响,恒保留;
        // 非结构列按规则剔除。
        let t = table("tbl_Avatar");
        let rules = RuleSet {
            projections: vec![ProjectRule {
                table: "tbl_Avatar".into(),
                include_columns: None,
                exclude_columns: vec!["hp".into()],
            }],
            ..Default::default()
        };
        let projected = rules.project(&t);
        let names: Vec<&str> = projected.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "sm_autoLoad", "name", "level"]);
    }

    #[test]
    fn validate_rejects_projection_unknown_table_and_excluded_column() {
        let schema = CloneSchema::new("Avatar".into(), vec![table("tbl_Avatar")]).unwrap();
        // 投影引用未知表:fail-closed。
        let unknown_table = RuleSet {
            projections: vec![ProjectRule {
                table: "tbl_Ghost".into(),
                include_columns: None,
                exclude_columns: vec![],
            }],
            ..Default::default()
        };
        let err = unknown_table.validate(&schema).unwrap_err();
        assert!(
            err.to_string()
                .contains("projection references unknown table `tbl_Ghost`"),
            "{err}"
        );
        // exclude 引用未知列:fail-closed。
        let unknown_column = RuleSet {
            projections: vec![ProjectRule {
                table: "tbl_Avatar".into(),
                include_columns: None,
                exclude_columns: vec!["ghost_col".into()],
            }],
            ..Default::default()
        };
        let err = unknown_column.validate(&schema).unwrap_err();
        assert!(
            err.to_string()
                .contains("projection excludes unknown column `ghost_col` of table `tbl_Avatar`"),
            "{err}"
        );
    }

    #[test]
    fn validate_rejects_identity_unknown_table_and_column() {
        let schema = CloneSchema::new("Avatar".into(), vec![table("tbl_Avatar")]).unwrap();
        // 身份规则引用未知表:fail-closed。
        let unknown_table = RuleSet {
            identities: vec![IdentityRule {
                entity: "Avatar".into(),
                table: "tbl_Ghost".into(),
                column: "id".into(),
            }],
            ..Default::default()
        };
        let err = unknown_table.validate(&schema).unwrap_err();
        assert!(
            err.to_string()
                .contains("identity references unknown table `tbl_Ghost`"),
            "{err}"
        );
        // 身份列不在表内:fail-closed。
        let unknown_column = RuleSet {
            identities: vec![IdentityRule {
                entity: "Avatar".into(),
                table: "tbl_Avatar".into(),
                column: "ghost".into(),
            }],
            ..Default::default()
        };
        let err = unknown_column.validate(&schema).unwrap_err();
        assert!(
            err.to_string()
                .contains("identity column `ghost` not in table `tbl_Avatar`"),
            "{err}"
        );
        // 合法身份列通过,且 identity_column 查得到。
        let ok = RuleSet {
            identities: vec![IdentityRule {
                entity: "Avatar".into(),
                table: "tbl_Avatar".into(),
                column: "id".into(),
            }],
            ..Default::default()
        };
        assert!(ok.validate(&schema).is_ok());
        assert_eq!(ok.identity_column("tbl_Avatar"), Some("id"));
        assert_eq!(ok.identity_column("tbl_Other"), None);
    }

    #[test]
    fn virtual_schema_still_usable() {
        let _ = VirtualSchema::default();
    }

    #[test]
    fn validate_passes_for_projection_with_valid_include_and_exclude() {
        // include+exclude 都引用表内合法列:校验通过;exclude 命中合法列即
        // 走已知列分支,不再误报。
        let schema = CloneSchema::new("Avatar".into(), vec![table("tbl_Avatar")]).unwrap();
        let rules = RuleSet {
            projections: vec![ProjectRule {
                table: "tbl_Avatar".into(),
                include_columns: Some(vec!["name".into(), "level".into()]),
                exclude_columns: vec!["hp".into()],
            }],
            ..Default::default()
        };
        assert!(rules.validate(&schema).is_ok());
    }
}
