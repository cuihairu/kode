//! Player Data Clone core: schema resolution, relation classification and export planning.
//!
//! Self-contained crate (no kode-server dependency): the def-derived table
//! schema is consumed as data, mirroring the shape of kode-server's
//! `database_schema` derivation output so the wiring (kode-server → here) is a
//! mechanical field mapping. See docs/player-clone/source-evidence.md for the
//! engine facts (parentID, child tables, autoLoad) this encodes.

pub mod error;
pub mod information_schema;
pub mod planner;
pub mod redact;
pub mod relations;
pub mod rules;
pub mod schema;
pub mod wire;

pub use error::{CloneError, CloneResult};
pub use information_schema::{InformationSchemaReader, RowSource};
pub use planner::{DryRun, ExportPlanner, IdentityColumn, PlanFilter, PlannedQuery, QueryPlan};
pub use redact::{Sensitivity, SensitivityPolicy};
pub use relations::{Relation, RelationGraph, RelationKind};
pub use rules::{IdentityRule, ProjectRule, RelationRule, RelationRuleAction, RuleSet};
pub use schema::{
    CloneSchema, DerivedField, DerivedTable, PhysicalSchema, PhysicalTable, ResolvedCloneSchema,
    SchemaResolver, SchemaSource, VirtualSchema,
};
