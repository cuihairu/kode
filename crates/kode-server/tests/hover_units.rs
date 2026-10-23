//! hover 响应链单元门禁(PR-010:定位/签名/继承成员/词提取)。
//!
//! 覆盖面:word_at 坐标(UTF-16/emoji/CRLF)、六类符号签名面、`<Parent>`
//! 继承链面(链/接口/组件平铺/环截断/缺父)、成员展开、engine.remove 清理。

use kode_server::hover::{word_at, HoverEngine, HoverResponse};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

fn key(uri_path: &str) -> DocumentKey {
    DocumentKey::new(RootId(1), CanonicalUri::from_path(uri_path))
}

/// 在文本中找词起点(0 起行/列)。
fn locate(text: &str, word: &str) -> (u32, u32) {
    for (line0, line) in text.lines().enumerate() {
        if let Some(col) = line.find(word) {
            return (line0 as u32, col as u32);
        }
    }
    panic!("word not found: {word}");
}

fn hover_on(
    engine: &HoverEngine,
    key: &DocumentKey,
    text: &str,
    word: &str,
) -> Option<HoverResponse> {
    let (line, col) = locate(text, word);
    engine.hover(key, text, line, col)
}

const AVATAR_DEF: &str = "<root>\n\
\t<Interfaces>\n\
\t\t<interface> ROLE </interface>\n\
\t</Interfaces>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n\
\t\t\t<DetailLevel> MEDIUM </DetailLevel>\n\
\t\t\t<Persistent> true </Persistent>\n\
\t\t</hp>\n\
\t</Properties>\n\
\t<Components>\n\
\t\t<inventory>\n\
\t\t\t<Type> Inventory </Type>\n\
\t\t\t<Persistent> true </Persistent>\n\
\t\t</inventory>\n\
\t</Components>\n\
\t<BaseMethods>\n\
\t\t<onRpc>\n\
\t\t\t<Arg> UINT32 </Arg>\n\
\t\t\t<Arg> STRING </Arg>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</onRpc>\n\
\t</BaseMethods>\n\
\t<ClientMethods>\n\
\t\t<onHint>\n\
\t\t\t<Exposed> false </Exposed>\n\
\t\t</onHint>\n\
\t</ClientMethods>\n\
</root>\n";

const MONSTER_DEF: &str = "<root>\n\t<Parent>Avatar</Parent>\n\
\t<Properties>\n\t\t<ferocity>\n\t\t\t<Type> UINT16 </Type>\n\t\t</ferocity>\n\t</Properties>\n</root>\n";

fn feed(engine: &mut HoverEngine, path: &str, text: &str) {
    engine.update(key(path), text);
}

fn workspace() -> HoverEngine {
    let mut engine = HoverEngine::new();
    feed(
        &mut engine,
        "/proj/scripts/entities.xml",
        "<root>\n\t<Avatar/>\n\t<Monster/>\n\t<Ghost/>\n</root>\n",
    );
    feed(
        &mut engine,
        "/proj/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
    );
    feed(
        &mut engine,
        "/proj/scripts/entity_defs/Monster.def",
        MONSTER_DEF,
    );
    feed(
        &mut engine,
        "/proj/scripts/entity_defs/interfaces/ROLE.def",
        "<root>\n\t<CellMethods>\n\t\t<onMove>\n\t\t\t<Arg> VECTOR3 </Arg>\n\t\t</onMove>\n\t</CellMethods>\n</root>\n",
    );
    feed(
        &mut engine,
        "/proj/scripts/entity_defs/components/Inventory.def",
        "<root>\n\t<Properties>\n\t\t<gold>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Persistent> true </Persistent>\n\t\t</gold>\n\t</Properties>\n</root>\n",
    );
    engine
}

// ---------------------------------------------------------------------------
// 词提取(HOVER 定位层)
// ---------------------------------------------------------------------------

#[test]
fn word_at_finds_words_at_cursor_and_word_end() {
    let text = "<root>\n\t<Type> UINT32 </Type>\n</root>\n";
    // 词内(cursor 在 U 上)。
    let (line, _) = locate(text, "UINT32");
    let col = text.lines().nth(1).unwrap().find("UINT32").unwrap() as u32 + 1;
    assert_eq!(word_at(text, line, col).as_deref(), Some("UINT32"));
    // 词尾紧贴(光标在最后一个字符之后)。
    let end_col = text.lines().nth(1).unwrap().find("UINT32").unwrap() as u32 + 6;
    assert_eq!(word_at(text, line, end_col).as_deref(), Some("UINT32"));
    // 空白处无词。
    assert_eq!(word_at(text, 0, 0), None);
    // 越界行无词。
    assert_eq!(word_at(text, 99, 0), None);
}

#[test]
fn word_at_handles_emoji_utf16_and_crlf() {
    // emoji 占 2 个 UTF-16 单位;hp 的 UTF-16 列 = 2(emoji) + 1(空格) = 3。
    let text = "🎁 hp\r\n";
    assert_eq!(word_at(text, 0, 3).as_deref(), Some("hp"));
    // 光标落在 emoji 的第二个 UTF-16 单位上:不是词字符,前一个字符也非词 → None。
    assert_eq!(word_at(text, 0, 1), None);
}

// ---------------------------------------------------------------------------
// 签名面:六类符号
// ---------------------------------------------------------------------------

#[test]
fn property_hover_carries_type_flags_detaillevel_persistent() {
    let engine = workspace();
    let doc_key = key("/proj/scripts/entity_defs/Avatar.def");
    let hover = hover_on(&engine, &doc_key, AVATAR_DEF, "hp").expect("property hover");
    assert_eq!(hover.symbol.kind, "property");
    assert_eq!(hover.symbol.section, "Properties");
    assert_eq!(hover.signature.r#type.as_deref(), Some("UINT32"));
    assert_eq!(hover.signature.flags.as_deref(), Some("BASE_AND_CLIENT"));
    assert_eq!(hover.signature.detail_level.as_deref(), Some("MEDIUM"));
    assert_eq!(hover.signature.persistent, Some(true));
    assert!(hover.inherited.is_none());
}

#[test]
fn method_hover_carries_facet_args_exposed() {
    let engine = workspace();
    let doc_key = key("/proj/scripts/entity_defs/Avatar.def");
    let hover = hover_on(&engine, &doc_key, AVATAR_DEF, "onRpc").expect("method hover");
    assert_eq!(hover.symbol.section, "BaseMethods");
    assert_eq!(hover.symbol.facet.as_deref(), Some("base"));
    assert_eq!(hover.signature.arg_count, Some(2));
    assert_eq!(
        hover.signature.args,
        Some(vec!["UINT32".to_string(), "STRING".to_string()])
    );
    assert_eq!(hover.signature.exposed, Some(true));

    let hover = hover_on(&engine, &doc_key, AVATAR_DEF, "onHint").expect("client method hover");
    assert_eq!(hover.symbol.section, "ClientMethods");
    assert_eq!(hover.signature.exposed, Some(false));
}

#[test]
fn component_hover_carries_component_type_and_persistent() {
    let engine = workspace();
    let doc_key = key("/proj/scripts/entity_defs/Avatar.def");
    let hover = hover_on(&engine, &doc_key, AVATAR_DEF, "inventory").expect("component hover");
    assert_eq!(hover.symbol.section, "Components");
    assert_eq!(hover.signature.component_type.as_deref(), Some("Inventory"));
    assert_eq!(hover.signature.persistent, Some(true));
}

#[test]
fn types_and_alias_hover_carry_kind_and_alias_targets() {
    let mut engine = HoverEngine::new();
    let types_text = "<root>\n\
\t<PY_LIST>\n\t\tFIXED_DICT\n\t\t<implementedBy> mod.impl </implementedBy>\n\
\t\t<Properties>\n\t\t\t<k>\n\t\t\t\t<Type> UINT8 </Type>\n\t\t\t</k>\n\t\t</Properties>\n\
\t</PY_LIST>\n\
\t<ITEMS>\n\t\tARRAY\n\t\t<of> UINT32 </of>\n\t</ITEMS>\n\
\t<HP>\n\t\tUINT16\n\t</HP>\n\
</root>\n";
    feed(&mut engine, "/proj/scripts/types.xml", types_text);
    feed(
        &mut engine,
        "/proj/scripts/alias.xml",
        "<root>\n\t<HP_ALIAS>\n\t\t<Type> HP </Type>\n\t</HP_ALIAS>\n</root>\n",
    );
    let doc_key = key("/proj/scripts/types.xml");
    let fixed_dict = hover_on(&engine, &doc_key, types_text, "PY_LIST").expect("type hover");
    assert_eq!(fixed_dict.signature.type_kind.as_deref(), Some("fixedDict"));
    assert_eq!(fixed_dict.signature.alias_target, None);

    let array = hover_on(&engine, &doc_key, types_text, "ITEMS").expect("array hover");
    assert_eq!(array.signature.type_kind.as_deref(), Some("array"));

    let redirect = hover_on(&engine, &doc_key, types_text, "HP").expect("redirect hover");
    assert_eq!(redirect.signature.type_kind.as_deref(), Some("builtin"));
    assert_eq!(redirect.signature.alias_target.as_deref(), Some("UINT16"));

    let alias_key = key("/proj/scripts/alias.xml");
    let alias_text = "<root>\n\t<HP_ALIAS>\n\t\t<Type> HP </Type>\n\t</HP_ALIAS>\n</root>\n";
    let alias = hover_on(&engine, &alias_key, alias_text, "HP_ALIAS").expect("alias hover");
    assert_eq!(alias.symbol.kind, "alias");
    assert_eq!(alias.signature.alias_type.as_deref(), Some("HP"));
}

#[test]
fn entities_registration_hover_reports_def_existence() {
    let engine = workspace();
    let entities_text = "<root>\n\t<Avatar/>\n\t<Missing/>\n</root>\n";
    let doc_key = key("/proj/scripts/entities.xml");
    let hover = hover_on(&engine, &doc_key, entities_text, "Avatar").expect("entity hover");
    assert_eq!(hover.symbol.section, "Entities");
    assert_eq!(hover.signature.def_exists, Some(true));
    assert!(hover
        .signature
        .def_file
        .as_deref()
        .unwrap()
        .ends_with("Avatar.def"));
    let hover = hover_on(&engine, &doc_key, entities_text, "Missing").expect("missing hover");
    assert_eq!(hover.signature.def_exists, Some(false));
    assert_eq!(hover.signature.def_file.as_deref(), Some("Missing.def"));
}

// ---------------------------------------------------------------------------
// 继承链面:parent 链 / interfaces / components 平铺 / 环 / 缺父 / 成员
// ---------------------------------------------------------------------------

#[test]
fn def_entity_hover_carries_chain_and_members() {
    let mut engine = workspace();
    feed(
        &mut engine,
        "/proj/scripts/entity_defs/EliteMonster.def",
        "<root>\n\t<Parent>Monster</Parent>\n\t<Properties>\n\t\t<rage>\n\t\t\t<Type> UINT8 </Type>\n\t\t</rage>\n\t</Properties>\n</root>\n",
    );
    let text = "<root>\n\t<Parent>Monster</Parent>\n</root>\n";
    let doc_key = key("/proj/scripts/entity_defs/EliteMonster.def");
    // 实体名不在文本内(file stem),走声明行入口(与 golden 同路径)。
    let hover = engine
        .hover_at_line(&doc_key, text, 1, "EliteMonster")
        .expect("entity hover");
    let chain = hover.inherited.as_ref().expect("chain face");
    let names: Vec<&str> = chain.parent_chain.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, vec!["Monster", "Avatar"]);
    let interfaces: Vec<&str> = chain.interfaces.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(interfaces, vec!["ROLE"]);
    let components: Vec<&str> = chain.components.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(components, vec!["Inventory"]);
    assert!(!chain.cycle_truncated);
    // 成员展开:Monster(rage)+ Avatar(hp),方法带分面。
    assert_eq!(chain.members.len(), 2);
    assert_eq!(chain.members[0].entity, "Monster");
    assert_eq!(chain.members[0].properties[0].name, "ferocity");
    assert_eq!(chain.members[1].entity, "Avatar");
    assert_eq!(chain.members[1].properties[0].name, "hp");
    let avatar_methods: Vec<&str> = chain.members[1]
        .methods
        .iter()
        .map(|m| m.name.as_str())
        .collect();
    assert_eq!(avatar_methods, vec!["onRpc", "onHint"]);
    assert_eq!(chain.members[1].methods[0].facet, "base");
    // 签名面带 Parent。
    assert_eq!(hover.signature.parent.as_deref(), Some("Monster"));
}

#[test]
fn parent_tag_hover_triggers_chain_face() {
    let engine = workspace();
    let doc_key = key("/proj/scripts/entity_defs/Monster.def");
    // `<Parent>` 标签名上悬停。
    let hover = hover_on(&engine, &doc_key, MONSTER_DEF, "Parent").expect("parent hover");
    assert!(hover.inherited.is_some());
    // 父取值上悬停同面。
    let hover = hover_on(&engine, &doc_key, MONSTER_DEF, "Avatar").expect("parent value hover");
    assert!(hover.inherited.is_some());
    // 无 Parent 标签的 def:没有 `<Parent>` 词可悬停,非符号词命中 None。
    let doc_key = key("/proj/scripts/entity_defs/Avatar.def");
    assert!(hover_on(&engine, &doc_key, AVATAR_DEF, "Interfaces").is_none());
}

#[test]
fn chain_cycle_is_truncated_and_reported() {
    let mut engine = HoverEngine::new();
    feed(
        &mut engine,
        "/loop/scripts/entities.xml",
        "<root>\n\t<LoopA/>\n\t<LoopB/>\n</root>\n",
    );
    feed(
        &mut engine,
        "/loop/scripts/entity_defs/LoopA.def",
        "<root>\n\t<Parent>LoopB</Parent>\n</root>\n",
    );
    feed(
        &mut engine,
        "/loop/scripts/entity_defs/LoopB.def",
        "<root>\n\t<Parent>LoopA</Parent>\n</root>\n",
    );
    let text = "<root>\n\t<Parent>LoopB</Parent>\n</root>\n";
    let doc_key = key("/loop/scripts/entity_defs/LoopA.def");
    let hover = engine
        .hover_at_line(&doc_key, text, 1, "LoopA")
        .expect("entity hover");
    let chain = hover.inherited.expect("chain face");
    let names: Vec<&str> = chain.parent_chain.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, vec!["LoopB", "LoopA"]);
    assert!(chain.cycle_truncated);
}

#[test]
fn missing_parent_is_marked_not_invented() {
    let mut engine = workspace();
    feed(
        &mut engine,
        "/proj/scripts/entity_defs/Lost.def",
        "<root>\n\t<Parent>Nobody</Parent>\n</root>\n",
    );
    let text = "<root>\n\t<Parent>Nobody</Parent>\n</root>\n";
    let doc_key = key("/proj/scripts/entity_defs/Lost.def");
    let hover = engine
        .hover_at_line(&doc_key, text, 1, "Lost")
        .expect("entity hover");
    let chain = hover.inherited.expect("chain face");
    assert_eq!(chain.parent_chain.len(), 1);
    assert_eq!(chain.parent_chain[0].name, "Nobody");
    assert!(!chain.parent_chain[0].exists);
    // 缺父成员如实标 exists=false,不虚构内容。
    assert_eq!(chain.members.len(), 1);
    assert!(!chain.members[0].exists);
    assert!(chain.members[0].properties.is_empty());
}

#[test]
fn remove_drops_corpus_view_and_symbols() {
    let mut engine = workspace();
    let doc_key = key("/proj/scripts/entity_defs/Monster.def");
    assert_eq!(engine.remove(&doc_key), 2); // entity + property
                                            // entities.xml 注册项的 def 存在性随移除失效(VFS-012 下游清理)。
    let entities_text = "<root>\n\t<Monster/>\n</root>\n";
    let doc_key = key("/proj/scripts/entities.xml");
    let hover = hover_on(&engine, &doc_key, entities_text, "Monster").expect("hover");
    assert_eq!(hover.signature.def_exists, Some(false));
}

#[test]
fn non_declaration_files_have_no_hover() {
    let mut engine = HoverEngine::new();
    let text = "plain text hover_target here\n";
    feed(&mut engine, "/proj/notes.txt", text);
    let doc_key = key("/proj/notes.txt");
    assert!(hover_on(&engine, &doc_key, text, "hover_target").is_none());
}
