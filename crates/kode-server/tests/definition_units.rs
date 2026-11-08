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
fn def_property_word_lands_on_entities_registration_line() {
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", ENTITIES_XML),
        ("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF),
    ]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // hp 在第 4 行(1 起),列 3(0 起 UTF-16):按 TS F12 的注册回落,
    // 落 `<Avatar/>` 的注册行(0 基 1)而非本文件声明名字 span。
    let location = engine
        .definition(&key, AVATAR_DEF, 3, 3)
        .expect("hp 声明应有落点");
    assert_eq!(location.uri, "/w/scripts/entities.xml");
    assert_eq!(location.range.start.line, 1);
    assert_eq!(location.range.start.character, 0);
}

#[test]
fn def_method_word_is_null_and_falls_to_ts_script_layer() {
    // 2026-11-08 demo 验收面(def-to-cell/base/client):三方法段声明词
    // Rust 不落注册行(会挡住 TS 下一层的 py 实现落点),返 null 由服务
    // 轨道回落 TS def 调用链取 py 实现。
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", ENTITIES_XML),
        ("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF),
    ]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // `\t\t<onKill>` 在第 10 行(1 起),列 3(0 起 UTF-16)。
    assert!(engine.definition(&key, AVATAR_DEF, 9, 3).is_none());
}

#[test]
fn def_declaration_word_without_registry_falls_back_to_def_head() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    let location = engine
        .definition(&key, AVATAR_DEF, 3, 3)
        .expect("无注册表时仍有兜底落点");
    assert_eq!(location.uri, "/w/scripts/entity_defs/Avatar.def");
    assert_eq!(location.range.start.line, 0);
}

#[test]
fn def_component_word_returns_none_like_ts_provider() {
    // TS provider 链末尾对组件声明词返 null(languageProviders.ts:2344);
    // Rust 不做单侧增强,同 null。
    let text = "<root>\n\t<Components>\n\t\t<Move/>\n\t</Components>\n</root>\n";
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", text)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    assert!(engine.definition(&key, text, 2, 4).is_none());
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

// ---------------------------------------------------------------------------
// DetailLevel 取值 → 本文件 DetailLevels 档位声明行(TS
// findDetailLevelDefinitionInDef 同口径;LSP line 0 基)
// ---------------------------------------------------------------------------

const DETAIL_DEF: &str = "<root>\n\
\t<DetailLevels>\n\
\t\t<LOW/>\n\
\t\t<MEDIUM/>\n\
\t\t<HIGH/>\n\
\t</DetailLevels>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<DetailLevel> MEDIUM </DetailLevel>\n\
\t\t</hp>\n\
\t</Properties>\n\
</root>\n";

#[test]
fn def_detail_level_value_word_lands_on_levels_declaration_line() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", DETAIL_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // `<DetailLevel> MEDIUM </DetailLevel>` 在第 10 行(1 起),词起列 17。
    let location = engine
        .definition(&key, DETAIL_DEF, 9, 17)
        .expect("DetailLevel 取值词应有落点");
    // 落点 = 本文件 `<MEDIUM/>` 档位声明行:1 基第 4 行 → 0 基 line 3。
    assert_eq!(location.uri, "/w/scripts/entity_defs/Avatar.def");
    assert_eq!(
        location.range,
        LspRange {
            start: kode_server::LspPosition {
                line: 3,
                character: 0
            },
            end: kode_server::LspPosition {
                line: 3,
                character: 0
            },
        }
    );
    // 未命中档位名的取值词仍无落点。
    assert!(engine.definition(&key, DETAIL_DEF, 9, 17 - 1).is_none());
}

// ---------------------------------------------------------------------------
// 其他文件种类 / 边界:null 语义
// ---------------------------------------------------------------------------

#[test]
fn definition_other_file_returns_none() {
    let engine = engine_with(&[("/w/notes.txt", "plain text\n")]);
    let key = key_of("/w/notes.txt");
    assert!(engine.definition(&key, "plain text\n", 0, 2).is_none());
    assert!(engine
        .definition_at_line(&key, "plain text\n", 1, "plain")
        .is_none());
}

#[test]
fn alias_declaration_word_lands_on_line_start() {
    let alias_text = "<root>\n\t<HP_ALIAS>\n\t\t<Type> HP </Type>\n\t</HP_ALIAS>\n</root>\n";
    let engine = engine_with(&[("/w/scripts/entity_defs/alias.xml", alias_text)]);
    let key = key_of("/w/scripts/entity_defs/alias.xml");
    let location = engine
        .definition(&key, alias_text, 1, 3)
        .expect("alias 声明落点");
    assert_eq!(location.uri, "/w/scripts/entity_defs/alias.xml");
    // 声明行行首:1 基第 2 行 → 0 基 line 1。
    assert_eq!(location.range.start.line, 1);
    assert_eq!(location.range.start.character, 0);
}

#[test]
fn def_parent_value_missing_corpus_def_is_null_with_registry() {
    // 有注册表(defs_root 可探)但父 def 未入库 → null,不虚构。
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", ENTITIES_XML),
        ("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF),
    ]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    assert!(engine.definition(&key, AVATAR_DEF, 1, 10).is_none());
}

#[test]
fn component_parent_value_lands_in_components_dir() {
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", "<root>\n\t<Wrench/>\n</root>\n"),
        (
            "/w/scripts/entity_defs/components/Wrench.def",
            "<root>\n\t<Parent>BaseTool</Parent>\n</root>\n",
        ),
        (
            "/w/scripts/entity_defs/components/BaseTool.def",
            "<root>\n\t<Properties>\n\t\t<weight>\n\t\t\t<Type> FLOAT </Type>\n\t\t</weight>\n\t</Properties>\n</root>\n",
        ),
    ]);
    let key = key_of("/w/scripts/entity_defs/components/Wrench.def");
    let text = "<root>\n\t<Parent>BaseTool</Parent>\n</root>\n";
    let location = engine
        .definition(&key, text, 1, 11)
        .expect("组件父取值词应有落点");
    // 组件文件的父按 components/ 目录解析(TS categoryOf 同规则)。
    assert_eq!(
        location.uri,
        "/w/scripts/entity_defs/components/BaseTool.def"
    );
    assert_eq!(location.range.start.line, 0);
}

#[test]
fn def_type_value_without_types_decl_is_null() {
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // `<Type> UNKNOWN_CUSTOM </Type>` 第 4 行,词起列 11;非内建但语料无声明。
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UNKNOWN_CUSTOM </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", ENTITIES_XML),
        ("/w/scripts/entity_defs/Avatar.def", text),
    ]);
    assert!(engine.definition(&key, text, 3, 11).is_none());
}

#[test]
fn def_type_tag_name_word_is_null() {
    // 光标在 `<Type` 标签名词上:元素命中但取值区间外 → null。
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    assert!(engine.definition(&key, AVATAR_DEF, 4, 4).is_none());
}

#[test]
fn definition_beyond_line_end_and_document_is_null() {
    let engine = engine_with(&[("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF)]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    // character 越行尾:clamp 到行尾,词取行尾词,无落点不 panic。
    assert!(engine.definition(&key, AVATAR_DEF, 4, 999).is_none());
    // 末行越界:偏移越过根元素收尾 span,最深元素探测 miss → null。
    assert!(engine.definition(&key, AVATAR_DEF, 14, 999).is_none());
}

#[test]
fn registry_landing_falls_back_when_entity_unregistered() {
    // entities.xml 在库但缺本实体注册:回落本文件首行。
    let engine = engine_with(&[
        ("/w/scripts/entities.xml", "<root>\n\t<Other/>\n</root>\n"),
        ("/w/scripts/entity_defs/Avatar.def", AVATAR_DEF),
    ]);
    let key = key_of("/w/scripts/entity_defs/Avatar.def");
    let location = engine
        .definition(&key, AVATAR_DEF, 3, 3)
        .expect("无注册项仍有兜底");
    assert_eq!(location.uri, "/w/scripts/entity_defs/Avatar.def");
    assert_eq!(location.range.start.line, 0);
}

// ---------------------------------------------------------------------------
// golden dump:alias 语料支路(主语料无实体式 alias.xml,单独喂临时根)
// ---------------------------------------------------------------------------

#[test]
fn definition_golden_dump_processes_alias_corpus() {
    let tmp = std::env::temp_dir().join(format!("kode-def-golden-{}", std::process::id()));
    let corpus = tmp.join("tests/fixtures/kbengine-demo-assets");
    std::fs::create_dir_all(&corpus).expect("mkdir corpus");
    let alias_text = "<root>\n\t<HP_ALIAS>\n\t\t<Type> HP </Type>\n\t</HP_ALIAS>\n</root>\n";
    std::fs::write(corpus.join("alias.xml"), alias_text).expect("write alias.xml");
    let dump = kode_server::dump_definition_golden(&tmp);
    // alias 语料被探针并产出落点(声明行行首)。
    assert!(dump.contains("\"kind\":\"alias\""));
    assert!(dump.contains("\"word\":\"HP_ALIAS\""));
    assert!(dump.contains("\"definitionCount\":1"));
    std::fs::remove_dir_all(&tmp).expect("cleanup");
}
