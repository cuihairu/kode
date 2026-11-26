//! .def method metadata face (SEM-006/RUST-108): method arguments, return type
//! declarations, Cell/Base/Client facets, Property flags, invocation
//! permission metadata.
//!
//! - Facet = the three .def sections (BaseMethods/CellMethods/ClientMethods);
//!   each method records its declaration site (name span + 1-based line) plus
//!   its origin (root/version carried through the
//!   [`crate::graph::TypeGraph::set_ingest`] context, same provenance
//!   semantics);
//! - Args = `<Arg>` raw text + type references (same semantics as kode-parser
//!   collect_type_refs: ARRAY/FIXED_DICT directive stripping + `<of>` text);
//!   **engine RPC parameters are unnamed**, so no argument names are invented;
//!   an Arg occupied solely by a directive yields an empty ref, as-is;
//! - Return type = the raw text declaration of def `<ReturnType>` (same
//!   semantics as TS definitionSemantics getScalarChildValue; the def format has
//!   no return value network serialization, and this declaration is consumed by
//!   inlay/navigation — Python inference lives on the RUST-PRECISION face, and
//!   the two complement each other without mixing);
//! - Invocation permission = `Exposed` truthy + facet: Exposed on the
//!   Base/Cell facets = callable from the client (engine exposedMethods); the
//!   Client facet = server→client direction and is not unreachable merely
//!   because it lacks Exposed — the fact is recorded here, interpretation
//!   belongs to the consuming side;
//! - Property flags: `DefFile.properties[].flags` (normalized tokens) is
//!   already carried by kode-parser, so this module does not model it again
//!   (def flag semantics live on the defAnalyzer/CELL-08 faces).
//!
//! Registration timing: methods are registered one by one when `add_def`
//! ingests; a repeated add_def for an entity with the same name is skipped as a
//! whole (nodes follow the same first-write-wins semantics), so no duplicate
//! method entries arise.

use kode_parser::Span;

use crate::graph::TypeGraph;
use crate::provenance::{TypeOrigin, TypeSourceKind};

/// Method facet (the three .def sections).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodFacet {
    Base,
    Cell,
    Client,
}

impl MethodFacet {
    pub fn as_str(&self) -> &'static str {
        match self {
            MethodFacet::Base => "base",
            MethodFacet::Cell => "cell",
            MethodFacet::Client => "client",
        }
    }
}

/// Method argument: raw text + type references (order preserved; unnamed,
/// since engine RPC parameters have no names).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodArg {
    pub text: String,
    pub type_refs: Vec<String>,
}

/// Method metadata (one entry = one method declaration of an entity on a facet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodMeta {
    /// Owning entity (the `name` argument of add_def, = file name minus .def).
    pub entity: String,
    pub facet: MethodFacet,
    pub name: String,
    pub args: Vec<MethodArg>,
    /// Raw text declaration of def `<ReturnType>`; missing/empty = None
    /// (as-is, no guessing).
    pub return_type: Option<String>,
    /// `<Exposed>` truthy (the invocation permission fact; semantics in the
    /// module doc).
    pub exposed: bool,
    /// 0-based byte range of the method declaration name (parser name_span).
    pub span: Span,
    /// Method declaration line (1-based per the parser).
    pub line: usize,
    /// Origin (carries the ingestion context: root/version).
    pub origin: TypeOrigin,
}

impl TypeGraph {
    /// All methods of an entity (facet registration order = def file section
    /// order, stable).
    pub fn entity_methods(&self, entity: &str) -> Vec<&MethodMeta> {
        self.methods.iter().filter(|m| m.entity == entity).collect()
    }

    /// Methods of an entity on a given facet.
    pub fn methods_by_facet(&self, entity: &str, facet: MethodFacet) -> Vec<&MethodMeta> {
        self.methods
            .iter()
            .filter(|m| m.entity == entity && m.facet == facet)
            .collect()
    }

    /// Invocation permission face: methods of an entity whose Exposed is
    /// truthy (across facets, registration order).
    pub fn exposed_methods(&self, entity: &str) -> Vec<&MethodMeta> {
        self.methods
            .iter()
            .filter(|m| m.entity == entity && m.exposed)
            .collect()
    }

    /// Ingest method metadata from a .def (called inside add_def; kept
    /// pub(crate) so the origin context cannot be bypassed). A duplicated
    /// entity (its add_def node rejected by first-write-wins) never reaches
    /// here, so no duplicate entries arise.
    pub(crate) fn record_methods(&mut self, entity: &str, def: &kode_parser::model::DefFile) {
        for (facet, ms) in [
            (MethodFacet::Base, &def.base_methods),
            (MethodFacet::Cell, &def.cell_methods),
            (MethodFacet::Client, &def.client_methods),
        ] {
            for m in ms {
                let origin = self.origin_for(TypeSourceKind::Def, Some(m.name_span), Some(m.line));
                self.methods.push(MethodMeta {
                    entity: entity.to_string(),
                    facet,
                    name: m.name.clone(),
                    args: m
                        .args
                        .iter()
                        .cloned()
                        .zip(&m.arg_type_refs)
                        .map(|(text, refs)| MethodArg {
                            text,
                            type_refs: refs.clone(),
                        })
                        .collect(),
                    return_type: m.return_type.clone(),
                    exposed: m.exposed,
                    span: m.name_span,
                    line: m.line,
                    origin,
                });
            }
        }
    }
}
