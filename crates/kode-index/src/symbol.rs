//! Symbol model: six kinds of declaration symbols + locations + extraction records
//! (book §7 IDX-001 layer 3 "symbol/type index", PR-007 capability face =
//! entity/property/method/type/alias/component).
//!
//! - [`SymbolKind`]: the six symbol kinds; `as_str` is the stable literal used by the
//!   parity golden and the query exports;
//! - [`MethodFacet`]: Base/Cell/Client method facets (SEM-006/007 foundation);
//! - [`SymbolRecord`]: one extraction record (index ingestion and golden serialization
//!   share the same shape, keeping "parity face = index face"; two extraction logics
//!   are not allowed);
//! - [`extract_records`]: ParsedUnit -> symbol records (pure function, no IO);
//! - [`SymbolId`]: arena slot number, only meaningful while the index holds a consistent
//!   generation snapshot; query exports return owned [`Symbol`](the cross-process
//!   semantics of the SEM-001 stable id follow PR-008).

use kode_parser::dep::{file_kind_of_uri, FileKind, ParsedUnit};
use kode_vfs::store::DocumentKey;

/// Symbol kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SymbolKind {
    /// Entity (entities.xml registration entry and the .def entity body itself).
    Entity,
    /// .def property.
    Property,
    /// .def method (the Base/Cell/Client facet is distinguished by [`MethodFacet`]).
    Method,
    /// types.xml custom type.
    Type,
    /// alias.xml alias.
    Alias,
    /// .def component slot.
    Component,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymbolKind::Entity => "entity",
            SymbolKind::Property => "property",
            SymbolKind::Method => "method",
            SymbolKind::Type => "type",
            SymbolKind::Alias => "alias",
            SymbolKind::Component => "component",
        }
    }
}

/// Method facet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MethodFacet {
    Base,
    Cell,
    Client,
}

impl MethodFacet {
    pub fn as_str(self) -> &'static str {
        match self {
            MethodFacet::Base => "base",
            MethodFacet::Cell => "cell",
            MethodFacet::Client => "client",
        }
    }
}

/// Arena slot number (slots are reused after deletion; callers must not cache across generations).
pub type SymbolId = usize;

/// Indexed symbol (query exports return an owned copy and never expose the internal arena/inverted structures).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Symbol {
    pub id: SymbolId,
    pub name: String,
    pub kind: SymbolKind,
    pub file: DocumentKey,
    /// 1-based line number; the .def entity body (a file-level symbol with no line position) is by convention 1.
    pub line: usize,
    pub facet: Option<MethodFacet>,
    pub detail: Option<String>,
}

/// Extraction record (field-for-field identical to the golden serialization: name/kind/line/facet/detail).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolRecord {
    pub name: String,
    pub kind: SymbolKind,
    pub line: usize,
    pub facet: Option<MethodFacet>,
    pub detail: Option<String>,
}

impl SymbolRecord {
    fn new(name: String, kind: SymbolKind, line: usize, detail: Option<String>) -> SymbolRecord {
        SymbolRecord {
            name,
            kind,
            line,
            facet: None,
            detail,
        }
    }
}

/// Entity name from a `.def` file path/URI (file stem; same semantics as the TS basename minus .def).
pub fn def_entity_name(uri_path: &str) -> Option<String> {
    std::path::Path::new(uri_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// ParsedUnit -> (sequence of symbol records, .def entity declaration).
///
/// The returned record order = document order (def: entity body -> Properties ->
/// Components -> Base/Cell/Client method sections, matching the DefFile field order),
/// shared by both golden and the index.
/// The second return value exists only for .def: `(entity name, Parent)` (inheritance
/// edge, IDX-002).
pub fn extract_records(
    key: &DocumentKey,
    unit: &ParsedUnit,
) -> (Vec<SymbolRecord>, Option<(String, Option<String>)>) {
    match unit {
        ParsedUnit::Def(def) => {
            let path = key.uri.as_path();
            let mut out = Vec::new();
            if let Some(entity) = def_entity_name(path) {
                out.push(SymbolRecord::new(entity, SymbolKind::Entity, 1, None));
            }
            for p in &def.properties {
                out.push(SymbolRecord::new(
                    p.name.clone(),
                    SymbolKind::Property,
                    p.line,
                    p.type_name.clone(),
                ));
            }
            for c in &def.components {
                out.push(SymbolRecord::new(
                    c.name.clone(),
                    SymbolKind::Component,
                    c.line,
                    c.component_type.clone(),
                ));
            }
            let sections = [
                (MethodFacet::Base, &def.base_methods),
                (MethodFacet::Cell, &def.cell_methods),
                (MethodFacet::Client, &def.client_methods),
            ];
            for (facet, methods) in sections {
                for m in methods {
                    let mut record = SymbolRecord::new(
                        m.name.clone(),
                        SymbolKind::Method,
                        m.line,
                        if m.args.is_empty() {
                            None
                        } else {
                            Some(m.args.join(","))
                        },
                    );
                    record.facet = Some(facet);
                    out.push(record);
                }
            }
            let declaration = def_entity_name(path).map(|name| (name, def.parent.clone()));
            (out, declaration)
        }
        ParsedUnit::Entities(entities) => {
            let out = entities
                .entities
                .iter()
                .map(|e| SymbolRecord::new(e.name.clone(), SymbolKind::Entity, e.line, None))
                .collect();
            (out, None)
        }
        ParsedUnit::Types(types) => {
            let out = types
                .types
                .iter()
                .map(|t| {
                    let detail = match t.kind {
                        kode_parser::model::TypeKind::FixedDict => "fixed_dict",
                        kode_parser::model::TypeKind::Array => "array",
                        kode_parser::model::TypeKind::Builtin => "builtin",
                    };
                    SymbolRecord::new(
                        t.name.clone(),
                        SymbolKind::Type,
                        t.line,
                        Some(detail.to_string()),
                    )
                })
                .collect();
            (out, None)
        }
        ParsedUnit::Alias(alias) => {
            let out = alias
                .aliases
                .iter()
                .map(|a| {
                    SymbolRecord::new(
                        a.name.clone(),
                        SymbolKind::Alias,
                        a.line,
                        Some(a.alias_type.clone()),
                    )
                })
                .collect();
            (out, None)
        }
    }
}

/// Declaration file-kind predicate (non-declaration files yield no symbols; same test as dep.rs).
pub fn is_indexable(key: &DocumentKey) -> bool {
    !matches!(file_kind_of_uri(&key.uri), FileKind::Other)
}
