//! Symbol model capability-face gate: the six `SymbolKind::as_str` literals and
//! `MethodFacet::as_str` are the stable contract for golden serialization and the
//! query exports (the PR-007 parity face), and `is_indexable` decides which files
//! enter the index. Asserting each literal verbatim here makes any change on either
//! side show up explicitly.

use kode_index::symbol::is_indexable;
use kode_index::{DocumentKey, MethodFacet, RootId, SymbolKind};
use kode_vfs::uri::CanonicalUri;

fn key(uri_path: &str) -> DocumentKey {
    DocumentKey::new(RootId(1), CanonicalUri::from_path(uri_path))
}

#[test]
fn symbol_kind_as_str_is_stable_golden_literal() {
    // The literals used by the parity golden and the query exports must be stable
    // character for character (any change turns the bidirectional gate red).
    assert_eq!(SymbolKind::Entity.as_str(), "entity");
    assert_eq!(SymbolKind::Property.as_str(), "property");
    assert_eq!(SymbolKind::Method.as_str(), "method");
    assert_eq!(SymbolKind::Type.as_str(), "type");
    assert_eq!(SymbolKind::Alias.as_str(), "alias");
    assert_eq!(SymbolKind::Component.as_str(), "component");
}

#[test]
fn method_facet_as_str_is_stable_golden_literal() {
    assert_eq!(MethodFacet::Base.as_str(), "base");
    assert_eq!(MethodFacet::Cell.as_str(), "cell");
    assert_eq!(MethodFacet::Client.as_str(), "client");
}

#[test]
fn is_indexable_distinguishes_declaration_files() {
    // Declaration files (.def/entities.xml/types.xml/alias.xml) are indexable; other
    // files do not enter the index.
    assert!(
        is_indexable(&key("/proj/entities/Avatar.def")),
        "def 可索引"
    );
    assert!(
        is_indexable(&key("/proj/entities.xml")),
        "entities.xml 可索引"
    );
    assert!(is_indexable(&key("/proj/types.xml")), "types.xml 可索引");
    assert!(is_indexable(&key("/proj/alias.xml")), "alias.xml 可索引");
    assert!(
        !is_indexable(&key("/proj/notes.txt")),
        "非声明文件(.txt)不可索引"
    );
    assert!(
        !is_indexable(&key("/proj/readme.md")),
        "非声明文件(.md)不可索引"
    );
}

#[test]
fn def_entity_name_takes_stem_and_ignores_missing() {
    use kode_index::def_entity_name;
    assert_eq!(
        def_entity_name("/x/entities/Avatar.def"),
        Some("Avatar".into())
    );
    assert_eq!(def_entity_name("Car.def"), Some("Car".into()));
    // Paths with no file stem (parent-directory reference / root / empty string)
    // return None.
    assert_eq!(def_entity_name(".."), None, "父目录引用无文件茎");
    assert_eq!(def_entity_name("/"), None, "根路径无文件茎");
    assert_eq!(def_entity_name(""), None, "空路径无文件茎");
}
