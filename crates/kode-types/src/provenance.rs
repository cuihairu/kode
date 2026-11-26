//! Type provenance face (SEM-003/RUST-105): for each type its
//! declaration/definition/reference source span, the original root/version,
//! and generation links.
//!
//! Everything here is a parallel side table / registry and **does not change
//! node/edge construction semantics** (the existing 11+7 pins and the
//! consuming sides are unaffected):
//! - [`TypeOrigin`] runs parallel to node indices, stamped in lockstep through
//!   the single `push_node` chokepoint; direct node-table writes that bypass
//!   `push_node` (e.g. the rpcargs test helper) are not kept in lockstep, and
//!   the read side [`TypeGraph::origin_of`] defensively returns `None`;
//! - The reference-site anchor is uniformly **the referencing side's declared
//!   name span** (the parser exposes no independent span for inner types.xml
//!   `<of>`/`<Type>` text or alias targets; def properties/components are
//!   anchored on their declared names) — registered as-is, without inventing
//!   a span of the referenced text itself;
//! - Division of labor between declaration/definition: types.xml/alias.xml
//!   entries = declaration origin (node origin); an entity .def = definition
//!   origin (node origin); entities.xml registration = registration origin
//!   (no node; existing semantics, stored in the
//!   [`TypeGraph::entity_registration_origin`] side table);
//! - Generation links are an opt-in registry (the generation pipeline
//!   currently lives on the TS side as pythonTypeStubs/entityTypeStubs, Rust
//!   consumption pending wiring); the builder never auto-populates them.
//!
//! root/version is supplied through the [`TypeGraph::set_ingest`] context
//! (set by the wiring party before ingestion; the pure library face has no
//! automatic source).

use kode_parser::Span;

use crate::graph::{EdgeKind, TypeId};

/// Source kind (one-to-one with the ingestion entries).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeSourceKind {
    /// A types.xml entry (declaration origin).
    TypesXml,
    /// An alias.xml entry (declaration origin).
    AliasXml,
    /// An entity .def (definition origin; name = file name minus .def).
    Def,
    /// An entities.xml registration (registration origin, no node).
    EntitiesXml,
    /// Direct construction (tests/materialization/rejection marking, no source
    /// file).
    Direct,
}

impl TypeSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TypeSourceKind::TypesXml => "types_xml",
            TypeSourceKind::AliasXml => "alias_xml",
            TypeSourceKind::Def => "def",
            TypeSourceKind::EntitiesXml => "entities_xml",
            TypeSourceKind::Direct => "direct",
        }
    }
}

/// Node origin: declaration/definition site + original root/version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeOrigin {
    pub source: TypeSourceKind,
    /// 0-based byte range of the declared/defined name (parser `name_span`;
    /// Direct = None).
    pub span: Option<Span>,
    /// Declaration/definition line (parser 1-based `line`; Direct = None).
    pub line: Option<usize>,
    /// root identity supplied by the wiring party at ingestion (opaque string
    /// key; None when unset).
    pub root: Option<String>,
    /// Document version supplied by the wiring party at ingestion.
    pub version: Option<u64>,
}

impl TypeOrigin {
    /// Construct a direct origin (no source file).
    pub fn direct() -> TypeOrigin {
        TypeOrigin {
            source: TypeSourceKind::Direct,
            span: None,
            line: None,
            root: None,
            version: None,
        }
    }
}

/// Reference-site record: the `from` node references `name` via a `kind`
/// edge, anchored on the referencing side's declared name span (unified
/// semantics in the module doc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeRefSite {
    pub from: TypeId,
    pub kind: EdgeKind,
    pub name: String,
    pub span: Option<Span>,
    pub line: Option<usize>,
}

/// Ingest context: set by the wiring party before the add_* calls; every
/// subsequent origin stamp carries it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IngestContext {
    pub root: Option<String>,
    pub version: Option<u64>,
}

/// Generated artifact (SEM-003 generation mapping; opt-in registration, no
/// auto-population).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerationKind {
    /// kbe_types custom type stub from pythonTypeStubs.
    PyiStub,
    /// Entity stub from entityTypeStubs.
    EntityStub,
}

impl GenerationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            GenerationKind::PyiStub => "pyi_stub",
            GenerationKind::EntityStub => "entity_stub",
        }
    }
}

/// One generation mapping: type name -> generated artifact (kind + artifact
/// path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationTarget {
    pub kind: GenerationKind,
    pub path: String,
}

impl crate::graph::TypeGraph {
    /// Set the ingest context (root/version supplied by the wiring party; the
    /// pure library face has no automatic source). Every origin stamp of the
    /// subsequent `add_types`/`add_alias`/`add_def`/`register_entities` calls
    /// carries it; data already in the graph is not affected.
    pub fn set_ingest(&mut self, root: Option<&str>, version: Option<u64>) {
        self.ingest = IngestContext {
            root: root.map(|r| r.to_string()),
            version,
        };
    }

    /// Clear the ingest context (origins of later ingests get root/version =
    /// None).
    pub fn clear_ingest(&mut self) {
        self.ingest = IngestContext::default();
    }

    /// Node origin (index-parallel; direct node-table writes bypassing
    /// `push_node` are not in lockstep, so out-of-range/absent slots
    /// defensively return `None`).
    pub fn origin_of(&self, id: TypeId) -> Option<&TypeOrigin> {
        self.origins.get(id.0 as usize)
    }

    /// entities.xml registration origin (`None` for unregistered names).
    pub fn entity_registration_origin(&self, name: &str) -> Option<&TypeOrigin> {
        self.entity_registrations.get(name)
    }

    /// Reference sites filtered by the referenced name (output in
    /// registration order = ingestion order, stable).
    pub fn reference_sites(&self, name: &str) -> Vec<&TypeRefSite> {
        self.ref_sites.iter().filter(|s| s.name == name).collect()
    }

    /// Register a generation mapping (opt-in; a type may have multiple
    /// artifacts, kept in registration order).
    pub fn link_generation(&mut self, name: &str, target: GenerationTarget) {
        self.generation_links
            .entry(name.to_string())
            .or_default()
            .push(target);
    }

    /// Look up generation mappings (unregistered = empty slice).
    pub fn generation_targets(&self, name: &str) -> &[GenerationTarget] {
        self.generation_links
            .get(name)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }
}
