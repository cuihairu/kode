//! 符号模型能力面门禁:六类 `SymbolKind::as_str` 字面量与 `MethodFacet::as_str`
//! 是 golden 序列化与查询出口的稳定契约(PR-007 对拍面),`is_indexable` 决定
//! 哪些文件进索引。此处逐字面量断言,保证任何一侧改动都显式暴露。

use kode_index::symbol::is_indexable;
use kode_index::{DocumentKey, MethodFacet, RootId, SymbolKind};
use kode_vfs::uri::CanonicalUri;

fn key(uri_path: &str) -> DocumentKey {
    DocumentKey::new(RootId(1), CanonicalUri::from_path(uri_path))
}

#[test]
fn symbol_kind_as_str_is_stable_golden_literal() {
    // 对拍 golden 与查询出口的字面量必须逐字符稳定(改动即双向门禁红)。
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
    // 声明文件(.def/entities.xml/types.xml/alias.xml)可索引;其余文件不进索引。
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
    // 无文件茎的路径(父目录引用 / 根 / 空串)返回 None。
    assert_eq!(def_entity_name(".."), None, "父目录引用无文件茎");
    assert_eq!(def_entity_name("/"), None, "根路径无文件茎");
    assert_eq!(def_entity_name(""), None, "空路径无文件茎");
}
