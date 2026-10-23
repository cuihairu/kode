//! definition 响应链单测:UTF-16 定位、四类文档落点口径、null 边界。

use kode_server::{HoverEngine, LspRange};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

fn key_of(path: &str) -> DocumentKey {
    DocumentKey::new(RootId::UNROOTED, CanonicalUri::from_path(path))
}

const AVATAR_DEF: &str = "<root>\n\
\t<Parent> Mob </Parent>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> SHADOW_TYPE </Type>\n\
\t\t\t<Flags> BASE </Flags>\n\
\t\t</hp>\n\
\t</Properties>\n\
\t<BaseMethods>\n\
\t\t<onKill>\n\
\t\t\t<Arg> UINT32 </Arg>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</onKill>\n\
\t</BaseMethods>\n\
</root>\n";

const MOB_DEF: &str = "<root>\n\t<Properties>\n\t\t<level>\n\t\t\t<Type> UINT32 </Type>\n\t\t</level>\n\t</Properties>\n</root>\n";

const TYPES_XML: &str = "<root>\n\t<SHADOW_TYPE> UINT32 </SHADOW_TYPE>\n</root>\n";

const ENTITIES_XML: &str = "<root>\n\t<Avatar/>\n</root>\n";

fn engine_with(defs: &[(&str, &str)]) -> HoverEngine {
    let mut engine = HoverEngine::new();
    for (path, text) in defs {
        engine.update(key_of(path), text);
    }
    engine
}

#[test]
fn def_declaration_word_lands_on_own_name_span() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // hp 在第 4 行(1 起),列 3(0 起 UTF-16):`\t\t<hp>` 的名字 span = 3..5。
    let location = engine
        .definition(&key, AVATAR_DEF, 3, 3)
        .expect("hp 声明应有落点");
    assert_eq!(location.uri, "/w/scripts/entity_defs/Avatar.def");
    assert_eq!(location.range.start.line, 3);
    assert_eq!(location.range.start.character, 3);
    assert_eq!(location.range.end.character, 5);
    // 方法声明同口径:`\t\t<onKill>` 名字 span = 3..9(0 基行 9)。
    let location = engine
        .definition(&key, AVATAR_DEF, 9, 3)
        .expect("onKill 落点");
    assert_eq!(location.range.start.line, 9);
    assert_eq!(location.range.start.character, 3);
    assert_eq!(location.range.end.character, 9);
}

#[test]
fn def_parent_value_word_lands_on_corpus_parent_def_head() {
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", "<root>\n\t<Avatar/>\n</root>\n"),
        ("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF),
        ("/w/scripts/entity_defs/Mob.def", MOB_DEF),
    ]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    let location = engine
        .definition(&key, AVATAR_DEF, 1, 11)
        .expect("Parent 取值词应有落点");
    assert_eq!(location.uri, "/w/scripts/entity_defs/Mob.def");
    assert_eq!(location.range.start.line, 0);
    assert_eq!(location.range.start.character, 0);
}

#[test]
fn def_parent_value_without_corpus_def_is_null() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    assert!(engine.definition(&key, AVATAR_DEF, 1, 10).is_none());
}

#[test]
fn def_type_value_word_lands_on_types_xml_declaration_line() {
    let engine = engine_with(&[
        ("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF),
        ("/w/scripts/entity_defs/types.xml", TYPES_XML),
    ]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // `<Type> SHADOW_TYPE </Type>` 在第 5 行,词起于列 11。
    let location = engine
        .definition(&key, AVATAR_DEF, 4, 11)
        .expect("类型引用词应有落点");
    assert_eq!(location.uri, "/w/scripts/entity_defs/types.xml");
    assert_eq!(location.range.start.line, 1);
    assert_eq!(location.range.start.character, 0);
}

#[test]
fn def_builtin_type_value_is_null() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // `<Arg> UINT32 </Arg>` 第 11 行(1 起),词起列 9;内建类型无定义文件。
    assert!(engine.definition(&key, AVATAR_DEF, 10, 9).is_none());
}

#[test]
fn entities_registry_word_lands_on_corpus_def_head() {
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", ENTITIES_XML),
        ("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF),
    ]);
    let key = key_of("/w/scripts/entities.xml");
    let location = engine
        .definition(&key, ENTITIES_XML, 1, 2)
        .expect("注册项落点");
    assert_eq!(location.uri, "/w/scripts/entity_defs/Avatar.def");
    assert_eq!(location.range.start.line, 0);
}

#[test]
fn types_declaration_word_lands_on_line_start() {
    let engine = engine_with(&[("/w/scripts/entity_defs/types.xml", TYPES_XML)]);
    let key = key_of("/w/scripts/entity_defs/types.xml");
    let location = engine
        .definition(&key, TYPES_XML, 1, 2)
        .expect("types 声明落点");
    assert_eq!(location.uri, "/w/scripts/entity_defs/types.xml");
    assert_eq!(location.range.start.line, 1);
    assert_eq!(location.range.start.character, 0);
    assert_eq!(
        location.range,
        LspRange {
            start: kode_server::LspPosition {
                line: 1,
                character: 0
            },
            end: kode_server::LspPosition {
                line: 1,
                character: 0
            },
        }
    );
}

#[test]
fn utf16_position_crosses_astral_boundary() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // astral 字符占两个 UTF-16 单位:词定位不得错位。
    let text = "<root>\n\t<😀name>\n</root>\n";
    // 😀 = 2 单位,光标落在 'name' 的 'a' 上(character 4 = 😀(2)+n(1)+…):
    // word_at 应提取 `name`。definition 无声明 → null,但不 panic。
    let _ = engine.definition(&key, text, 1, 4);
}

#[test]
fn unopened_or_unknown_words_are_null() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // 未知词。
    assert!(engine.definition(&key, AVATAR_DEF, 0, 1).is_none());
    // 标签名词(Type)无落点。
    assert!(engine.definition(&key, AVATAR_DEF, 4, 3).is_none());
}
