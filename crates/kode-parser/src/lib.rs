//! kode-parser: byte-faithful parser for KBEngine `.def` / entities.xml / types.xml / alias.xml
//! (kode2 PR-005, book §6.1/§17 PR-005 baseline).
//!
//! Modules:
//! - [`xml`]: byte-level XML state machine, arena tree + exact spans + fault-tolerant recovery (SYNTAX-002/003);
//! - [`diag`]: structured diagnostics / Span / LineMap;
//! - [`model`]: `.def` semantics (properties/flags/methods/components/inheritance), entities/types/alias
//!   extraction, unknown-field preservation (SYNTAX-005, SEM-006..008 baseline);
//! - [`dep`]: incremental reparsing registry (fingerprint-based zero rebuild + reverse dependency index, reused for VFS-011);
//! - [`def_format`]: native `.def` formatting core (KODE-SYN-006: depth-based indentation + span-faithful
//!   rewrite + line-level minimal edit set, safe fallback to original text on any parse diagnostic);
//! - [`json`]: golden serialization for parity comparison (dependency-free JSON writer).
//!
//! Iron rules: no third-party crates except cryptography (this crate only depends on the workspace-local kode-vfs);
//! no panics on any input (see tests/blind.rs mutation sampling).

pub mod config;
pub mod config_derive;
pub mod def_format;
pub mod dep;
pub mod diag;
pub mod json;
pub mod model;
pub mod xml;

pub use def_format::{
    format_def_edits, format_def_report, format_def_text, DefFormatEdit, DefFormatOptions,
    DefFormatReport,
};
pub use dep::{FileKind, ParseRegistry, ParsedUnit, RefSet, UpdateReport};
pub use diag::{DiagCode, Diagnostic, LineMap, Severity, Span};
pub use model::{
    parse_alias, parse_def, parse_entities, parse_types, AliasDecl, AliasFile, ChainNode,
    ComponentDef, DefFile, EntitiesFile, EntityEntry, MethodDef, MethodSection, PropertyDef,
    TypeDecl, TypeKind, TypesFile,
};
pub use xml::{mask_def_pseudo_comments, parse, Attribute, Document, ElementData, Node, NodeData};
