//! Player Data Clone core: schema resolution, relation classification and export planning.
//!
//! Self-contained crate (no kode-server dependency): the def-derived table
//! schema is consumed as data, mirroring the shape of kode-server's
//! `database_schema` derivation output so the wiring (kode-server → here) is a
//! mechanical field mapping. See docs/player-clone/source-evidence.md for the
//! engine facts (parentID, child tables, autoLoad) this encodes.

pub mod apply;
pub mod archive;
pub mod error;
pub mod idmap;
pub mod import;
pub mod information_schema;
pub mod keystore;
pub mod planner;
pub mod reader;
pub mod redact;
pub mod relations;
pub mod rules;
pub mod schema;
pub mod target;
pub mod value;
pub mod wire;

pub use apply::{
    archive_fingerprint, ApplyControl, ApplyOutcome, BindingOutcome, CleanupPlan, CleanupStatement,
    DuplicateImport, FieldConsistency, ImportApplier, ImportRun, ImportRunStore, LoadVerification,
    MemoryRunStore, NoopRunStore, VerifyCheck, VerifyReport, WriteExecutor,
};
pub use archive::{relations_from_plan, write_archive, Archive, ArchiveMeta, ArchiveWriter};
pub use error::{CloneError, CloneResult};
pub use idmap::{IdCategory, IdMap, IdMapEntry, IdMapKey, ImportMode, MappedId};
pub use import::{
    AccountBindingPlan, AutoLoadPolicy, ImportOptions, ImportPlan, ImportPlanner, ImportSummary,
    PlannedCell, PlannedInsert, ReferenceOutcome, TargetSnapshot, UniqueConflict, UniqueKey,
    UniquePolicy,
};
pub use information_schema::{InformationSchemaReader, RowSource};
pub use planner::{DryRun, ExportPlanner, IdentityColumn, PlanFilter, PlannedQuery, QueryPlan};
pub use reader::RowSink;
pub use redact::{Sensitivity, SensitivityPolicy};
pub use relations::{Relation, RelationGraph, RelationKind};
pub use rules::{IdentityRule, ProjectRule, RelationRule, RelationRuleAction, RuleSet};
pub use schema::{
    CloneSchema, DerivedField, DerivedTable, PhysicalSchema, PhysicalTable, ResolvedCloneSchema,
    SchemaResolver, SchemaSource, VirtualSchema,
};
pub use target::{TargetEnvironment, TargetProfile};
pub use value::{TypedRow, TypedValue};
