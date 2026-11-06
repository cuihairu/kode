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
    fn virtual_schema_still_usable() {
        let _ = VirtualSchema::default();
    }
}
