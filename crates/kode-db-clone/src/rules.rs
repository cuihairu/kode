//! Explicit rules layer (plan §4.2-C / §5): explicit business relations
//! (Account.characters, guildDBID), identity columns (external identifiers that
//! stay stable across clones), projections (column subsets).
//!
//! Rules are supplied by the caller (loaded from user configuration/declarations
//! when wired into kode-server); this layer only applies them and never guesses
//! from strings. Engine-certain relations (§4.2-A) need no rules.

use crate::error::{CloneError, CloneResult};
use crate::schema::{CloneSchema, DerivedField, DerivedTable};

/// Relation rule action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationRuleAction {
    /// Follow the relation (include in export/import).
    Follow,
    /// Skip (not migrated with the clone, recorded but not an error).
    Skip,
    /// Treat as an error (fail-closed).
    Error,
}

/// Explicit business relation (§4.2-C): declared by the user, not derived from
/// the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationRule {
    /// Declaring entity (e.g. Account).
    pub entity: String,
    /// Declared path (e.g. characters).
    pub property_path: String,
    /// Child table (the referenced side).
    pub child_table: String,
    /// Parent table (the referencing side).
    pub parent_table: String,
    /// Logical column on the child table pointing at the parent.
    pub join_column: String,
    pub action: RelationRuleAction,
    pub note: Option<String>,
}

/// Identity column: an external identifier (account name / guid etc.) whose
/// semantics stay stable across clones; the Phase 3 IDMapper aligns mappings by it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityRule {
    pub entity: String,
    pub table: String,
    pub column: String,
}

/// Projection rule: a column subset within a table (include None means all
/// included; exclude removes).
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

/// Rule set (the application layer's entry point).
#[derive(Debug, Clone, Default)]
pub struct RuleSet {
    pub relations: Vec<RelationRule>,
    pub identities: Vec<IdentityRule>,
    pub projections: Vec<ProjectRule>,
}

impl RuleSet {
    /// Projects a derived table (trims fields per rules; the structural columns
    /// id/parentID/sm_autoLoad are always kept).
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

    /// Applies relation rules (classifying declared relations as
    /// ExplicitBusiness / Skip / Error).
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

    /// Identity column: returns the column declared as this table's identity
    /// carrier, if any.
    pub fn identity_column(&self, table: &str) -> Option<&str> {
        self.identities
            .iter()
            .find(|r| r.table == table)
            .map(|r| r.column.as_str())
    }

    /// Validates rule self-consistency: tables and columns referenced by
    /// projections/identities must exist in the derived schema (fail-closed).
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
        // Undeclared relation → engine-certain path, no explicit rule.
        assert_eq!(rules.apply_relation("Account", "inventory").unwrap(), None);
    }

    #[test]
    fn project_rule_allows_exclude_hit_and_include_none_means_all() {
        // exclude hit → false; include=None semantics = all included (everything
        // not excluded is true).
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
        // Structural columns (id/parentID/sm_autoLoad) are unaffected by exclude and
        // always kept; non-structural columns are trimmed per the rule.
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
        // Projection references an unknown table: fail closed.
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
        // exclude references an unknown column: fail closed.
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
        // Identity rule references an unknown table: fail closed.
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
        // Identity column not in the table: fail closed.
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
        // A valid identity column passes and identity_column can find it.
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
        // include+exclude both reference valid columns of the table: validation
        // passes; an exclude hit on a valid column takes the known-column branch and
        // no longer false-reports.
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
