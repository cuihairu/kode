//! Unified index node model + edges (KODE-MCP-KB-002 P2, design doc §5).
//!
//! One node table over the four indexed source formats; nodes are
//! content-addressed by BLAKE3 (same content → same hash; changed content →
//! new hash). Edges are maintained separately from nodes, each edge carries
//! the project rule that produced it (design doc §10) so the AI gets the
//! parsed reason, not an inference to trust blindly.

use std::path::Path;

use crate::semantic_model::Confidence;

/// Stable node id: `kind:rel_path:name` (rel path is forward-slash, relative
/// to the index root). Readable and deterministic; duplicates within a file
/// are disambiguated by an appended `#N` ordinal in the extractor.
pub fn node_id(kind: &NodeKind, rel_path: &str, name: &str) -> String {
    format!("{}:{rel_path}:{name}", kind.as_str())
}

/// Node kinds indexed by P2. `PythonAttribute` is declared per design doc §5
/// but not yet produced: kode-python's symbol extraction has no attribute
/// face (only class/function/method), so it is honestly never constructed
/// until that face lands. Kept in the enum to match the design's node model.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum NodeKind {
    Document,
    Section,
    ExcelSheet,
    ExcelColumn,
    ExcelRow,
    PythonClass,
    PythonFunction,
    PythonMethod,
    #[allow(dead_code)] // Not produced yet (kode-python has no attribute face).
    PythonAttribute,
    Entity,
    EntityProperty,
    EntityMethod,
    XmlType,
    XmlElement,
    XmlAttribute,
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Document => "document",
            NodeKind::Section => "section",
            NodeKind::ExcelSheet => "excel-sheet",
            NodeKind::ExcelColumn => "excel-column",
            NodeKind::ExcelRow => "excel-row",
            NodeKind::PythonClass => "python-class",
            NodeKind::PythonFunction => "python-function",
            NodeKind::PythonMethod => "python-method",
            NodeKind::PythonAttribute => "python-attribute",
            NodeKind::Entity => "entity",
            NodeKind::EntityProperty => "entity-property",
            NodeKind::EntityMethod => "entity-method",
            NodeKind::XmlType => "xml-type",
            NodeKind::XmlElement => "xml-element",
            NodeKind::XmlAttribute => "xml-attribute",
        }
    }

    /// Source format this node kind belongs to (for the `format` filter).
    pub fn format(&self) -> &'static str {
        match self {
            NodeKind::Document | NodeKind::Section => "markdown",
            NodeKind::ExcelSheet | NodeKind::ExcelColumn | NodeKind::ExcelRow => "excel",
            NodeKind::PythonClass
            | NodeKind::PythonFunction
            | NodeKind::PythonMethod
            | NodeKind::PythonAttribute => "python",
            NodeKind::Entity | NodeKind::EntityProperty | NodeKind::EntityMethod => "def",
            NodeKind::XmlType | NodeKind::XmlElement | NodeKind::XmlAttribute => "xml",
        }
    }

    /// Deterministic rank for exact-route tiebreak (structure first).
    pub fn rank(&self) -> u32 {
        match self {
            NodeKind::Entity => 0,
            NodeKind::XmlType => 1,
            NodeKind::EntityProperty => 2,
            NodeKind::EntityMethod => 3,
            NodeKind::XmlElement => 4,
            NodeKind::XmlAttribute => 5,
            NodeKind::PythonClass => 6,
            NodeKind::PythonFunction => 7,
            NodeKind::PythonMethod => 8,
            NodeKind::Section => 9,
            NodeKind::Document => 10,
            NodeKind::ExcelSheet => 11,
            NodeKind::ExcelColumn => 12,
            NodeKind::ExcelRow => 13,
            NodeKind::PythonAttribute => 14,
        }
    }

    pub fn from_kind_str(s: &str) -> Option<NodeKind> {
        Some(match s {
            "document" => NodeKind::Document,
            "section" => NodeKind::Section,
            "excel-sheet" => NodeKind::ExcelSheet,
            "excel-column" => NodeKind::ExcelColumn,
            "excel-row" => NodeKind::ExcelRow,
            "python-class" => NodeKind::PythonClass,
            "python-function" => NodeKind::PythonFunction,
            "python-method" => NodeKind::PythonMethod,
            "python-attribute" => NodeKind::PythonAttribute,
            "entity" => NodeKind::Entity,
            "entity-property" => NodeKind::EntityProperty,
            "entity-method" => NodeKind::EntityMethod,
            "xml-type" => NodeKind::XmlType,
            "xml-element" => NodeKind::XmlElement,
            "xml-attribute" => NodeKind::XmlAttribute,
            _ => return None,
        })
    }
}

/// 1-based line span, Excel range, or XML XPath-style path + line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceLocation {
    Lines { start: usize, end: usize },
    Excel { sheet: String, range: String },
    Xml { path: String, line: usize },
}

impl SourceLocation {
    /// Human-readable one-line location (for search result rows).
    pub fn display(&self) -> String {
        match self {
            SourceLocation::Lines { start, end } => {
                if start == end {
                    format!("line {start}")
                } else {
                    format!("lines {start}-{end}")
                }
            }
            SourceLocation::Excel { sheet, range } => format!("sheet {sheet} {range}"),
            SourceLocation::Xml { path, line } => format!("{path} (line {line})"),
        }
    }

    pub fn start_line(&self) -> Option<usize> {
        match self {
            SourceLocation::Lines { start, .. } => Some(*start),
            SourceLocation::Xml { line, .. } => Some(*line),
            SourceLocation::Excel { .. } => None,
        }
    }
}

/// One indexable node (design doc §5).
#[derive(Debug, Clone)]
pub struct IndexNode {
    pub id: String,
    pub project: String,
    pub file_path: String,
    pub kind: NodeKind,
    pub name: String,
    /// Bounded content indexed for BM25; full content is read on demand.
    pub content: String,
    pub location: SourceLocation,
    pub content_hash: String,
    pub confidence: Confidence,
}

/// Edge relation (design doc §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Defines,
    References,
    Imports,
    Contains,
    Configures,
    Implements,
    Calls,
}

impl Relation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Relation::Defines => "defines",
            Relation::References => "references",
            Relation::Imports => "imports",
            Relation::Contains => "contains",
            Relation::Configures => "configures",
            Relation::Implements => "implements",
            Relation::Calls => "calls",
        }
    }

    /// Inverse of [`Relation::as_str`] (unknown names degrade to References,
    /// mirroring [`crate::store::semantic_edge`]).
    pub fn from_name(name: &str) -> Relation {
        match name {
            "defines" => Relation::Defines,
            "imports" => Relation::Imports,
            "contains" => Relation::Contains,
            "configures" => Relation::Configures,
            "implements" => Relation::Implements,
            "calls" => Relation::Calls,
            _ => Relation::References,
        }
    }
}

/// Cross-format reference edge (design doc §5/§10).
#[derive(Debug, Clone)]
pub struct Reference {
    pub source_node: String,
    pub target_node: String,
    pub relation: Relation,
    pub confidence: Confidence,
    pub rule: String,
}

/// BLAKE3 hex content hash of `bytes` (content addressing).
pub fn content_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// BLAKE3 of the canonical absolute root path, used to key the persistent
/// index directory in the system temp dir (keeps the user's tree clean).
pub fn root_key(root: &Path) -> String {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let hex = content_hash(canonical.to_string_lossy().as_bytes());
    hex.chars().take(16).collect()
}

/// Relative path with forward slashes (stable cross-platform key).
pub fn rel_path(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_is_stable_and_readable() {
        let id = node_id(
            &NodeKind::Entity,
            "scripts/entity_defs/Avatar.def",
            "Avatar",
        );
        assert_eq!(id, "entity:scripts/entity_defs/Avatar.def:Avatar");
        // Same inputs → same id (determinism).
        let again = node_id(
            &NodeKind::Entity,
            "scripts/entity_defs/Avatar.def",
            "Avatar",
        );
        assert_eq!(id, again);
    }

    #[test]
    fn content_hash_is_content_addressed() {
        // Same content → same hash; changed content → different hash.
        let a = content_hash(b"def hello():\n    pass\n");
        let b = content_hash(b"def hello():\n    pass\n");
        let c = content_hash(b"def hello():\n    return 1\n");
        assert_eq!(a, b);
        assert_ne!(a, c);
        // Hex 64 chars (BLAKE3-256).
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn rel_path_uses_forward_slashes_and_strips_root() {
        let root = std::path::Path::new("/tmp/root");
        let p = std::path::Path::new("/tmp/root/scripts/base/account.py");
        assert_eq!(rel_path(root, p), "scripts/base/account.py");
    }

    #[test]
    fn root_key_is_deterministic_hex() {
        let a = root_key(std::path::Path::new("/tmp/xyz"));
        let b = root_key(std::path::Path::new("/tmp/xyz"));
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn kind_format_roundtrip_and_rank() {
        // All kinds map to a format and roundtrip from string.
        let kinds = [
            NodeKind::Document,
            NodeKind::Section,
            NodeKind::ExcelSheet,
            NodeKind::ExcelColumn,
            NodeKind::ExcelRow,
            NodeKind::PythonClass,
            NodeKind::PythonFunction,
            NodeKind::PythonMethod,
            NodeKind::PythonAttribute,
            NodeKind::Entity,
            NodeKind::EntityProperty,
            NodeKind::EntityMethod,
            NodeKind::XmlType,
            NodeKind::XmlElement,
            NodeKind::XmlAttribute,
        ];
        for k in &kinds {
            assert_eq!(NodeKind::from_kind_str(k.as_str()), Some(k.clone()));
            assert!(!k.format().is_empty());
        }
        // Structure kinds rank before document kinds (exact-route determinism).
        assert!(NodeKind::Entity.rank() < NodeKind::Document.rank());
    }
}
