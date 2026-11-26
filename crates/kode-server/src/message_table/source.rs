//! Def-tree source retrieval (counterpart of TS DefTreeSource).

use std::collections::HashMap;

use kode_parser::diag::DiagCode;
use kode_parser::xml::{parse as parse_xml, Document};

use crate::message_table::views::{parse_def_view_with, DefView};

// ---------------------------------------------------------------------------
// Def-tree source retrieval (counterpart of TS DefTreeSource)
// ---------------------------------------------------------------------------

/// Retrieve sources: the entity's own defText plus other defs by name; paths by name (used for assembly-order sources).
pub(super) struct Source<'a> {
    pub(super) entity_name: &'a str,
    pub(super) def_text: &'a str,
    pub(super) defs: &'a HashMap<String, String>,
    pub(super) paths: &'a HashMap<String, String>,
}

impl Source<'_> {
    /// TS loadDef: fetch text by name and parse; structural errors (unclosed / mismatched closing / stray closing / illegal
    /// tag) follow TS parseLocalDefinition's throw -> handled as null. Other faults keep parsing leniently.
    pub(super) fn load(&self, name: &str) -> Option<DefView> {
        let text = if name == self.entity_name {
            self.def_text
        } else {
            self.defs.get(name)?
        };
        let doc = parse_xml(text, true);
        if is_structural_error(&doc) {
            return None;
        }
        Some(parse_def_view_with(&doc, text))
    }

    /// Component def loading: look up only the defs text table (no special-casing of entity_name; a component type colliding in name with the entity
    /// is a name-collision corner case, treated as missing in the defs table -> fallback).
    pub(super) fn load_component(&self, name: &str) -> Option<DefView> {
        let text = self.defs.get(name)?;
        let doc = parse_xml(text, true);
        if is_structural_error(&doc) {
            return None;
        }
        Some(parse_def_view_with(&doc, text))
    }

    pub(super) fn path_of(&self, name: &str) -> &str {
        self.paths.get(name).map(String::as_str).unwrap_or("")
    }
}

/// Structural-error detection (same stance as client_sdk::is_structural_error): TS fxp throws for
/// unclosed / mismatched closing / stray closing / illegal tags -> loadDef returns null.
pub(super) fn is_structural_error(doc: &Document) -> bool {
    doc.diagnostics.iter().any(|diag| {
        matches!(
            diag.code,
            DiagCode::UnclosedElement
                | DiagCode::MismatchedCloseTag
                | DiagCode::StrayCloseTag
                | DiagCode::InvalidTagName
        )
    })
}
