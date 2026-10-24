//! completion 请求链单元门禁(判面原语 / 条目集 / 过滤遮蔽 / UTF-16)。
//!
//! 均为纯内存构造:HoverEngine 手工入库语料,不碰磁盘(PR-010 hover_units
//! 同风格)。

use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

use kode_server::HoverEngine;

fn key_of(path: &str) -> DocumentKey {
    DocumentKey::new(RootId::UNROOTED, CanonicalUri::from_path(path))
}

const AVATAR_DEF: &str = "<root>\n\
\t<Parent> BaseApp </Parent>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT32 </Type>\n\
\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n\
\t\t</hp>\n\
\t\t<level>\n\
\t\t\t<Type> UINT16 </Type>\n\
\t\t</level>\n\
\t</Properties>\n\
\t<BaseMethods>\n\
\t\t<reqCastSkill>\n\
\t\t\t<Arg> skillId </Arg>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</reqCastSkill>\n\
\t</BaseMethods>\n\
\t<CellMethods>\n\
\t\t<respawn>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</respawn>\n\
\t</CellMethods>\n\
</root>\n";

const BASEAPP_DEF: &str = "<root>\n\
\t<Properties>\n\
\t\t<hp>\n\
\t\t\t<Type> UINT64 </Type>\n\
\t\t</hp>\n\
\t\t<name>\n\
\t\t\t<Type> STRING </Type>\n\
\t\t</name>\n\
\t</Properties>\n\
\t<BaseMethods>\n\
\t\t<reqCastSkill>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</reqCastSkill>\n\
\t\t<onSpawned>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</onSpawned>\n\
\t\t<onHPChanged>\n\
\t\t\t<Exposed> true </Exposed>\n\
\t\t</onHPChanged>\n\
\t</BaseMethods>\n\
\t<ClientMethods>\n\
\t\t<notify>\n\
\t\t</notify>\n\
\t</ClientMethods>\n\
</root>\n";

const TYPES_XML: &str = "<root>\n\
\t<FIXED_DICT_ITEM> FIXED_DICT \
\t\t<Properties>\
\t\t\t<tox> <Type> UINT8 </Type> </tox>\
\t\t</Properties>\
\t</FIXED_DICT_ITEM>\n\
\t<ITEM_LIST> ARRAY <of> FIXED_DICT_ITEM </of> </ITEM_LIST>\n\
</root>\n";

const ALIAS_XML: &str = "<root>\n\
\t<MY_ALIAS>\n\
\t\t<Type> ITEM_LIST </Type>\n\
\t</MY_ALIAS>\n\
</root>\n";

const ENTITIES_XML: &str = "<root>\n\
\t<Avatar hasBase=\"true\"/>\n\
\t<Monster/>\n\
</root>\n";

/// 入库五件套(def 链 Avatar→BaseApp + types + alias + entities)。
fn loaded_engine() -> HoverEngine {
    let mut engine = HoverEngine::new();
    engine.update(key_of("ws/scripts/entities.xml"), ENTITIES_XML);
    engine.update(key_of("ws/scripts/entity_defs/Avatar.def"), AVATAR_DEF);
    engine.update(key_of("ws/scripts/entity_defs/BaseApp.def"), BASEAPP_DEF);
    engine.update(key_of("ws/scripts/types.xml"), TYPES_XML);
    engine.update(key_of("ws/scripts/alias.xml"), ALIAS_XML);
    engine
}

/// 在行(1 起)第 col 个 char 处请求补全。
fn complete_at(
    engine: &HoverEngine,
    path: &str,
    text: &str,
    line1: usize,
    col: usize,
) -> Option<kode_server::CompletionResponse> {
    engine.completion(&key_of(path), text, line1 as u32 - 1, col as u32)
}

fn labels(response: &kode_server::CompletionResponse) -> Vec<String> {
    response.items.iter().map(|i| i.label.clone()).collect()
}

#[test]
fn parent_value_context_lists_corpus_entities() {
    let engine = loaded_engine();
    // 行 2 = `\t<Parent> BaseApp </Parent>`;取值点(值首 token 末)= col 17。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        2,
        17,
    )
    .expect("Parent 取值位应判面");
    assert_eq!(response.context.kind, "value");
    assert_eq!(response.context.section, "Entity");
    assert_eq!(response.context.entity.as_deref(), Some("Avatar"));
    // 过滤:fragment = BaseApp → 只剩它(detail = 语料路径)。
    assert_eq!(labels(&response), vec!["BaseApp".to_string()]);
    let item = &response.items[0];
    assert_eq!(item.kind, "entity");
    assert_eq!(
        item.detail.as_deref(),
        Some("ws/scripts/entity_defs/BaseApp.def")
    );
    assert_eq!(item.inherited_from, None);
    // 全量点(标签后,col 9)给全部语料实体,按名排序。
    let full = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        2,
        9,
    )
    .expect("Parent 全量位应判面");
    assert_eq!(full.context.fragment, "");
    assert_eq!(
        labels(&full),
        vec!["Avatar".to_string(), "BaseApp".to_string()]
    );
}

#[test]
fn type_value_context_lists_types_then_aliases() {
    let engine = loaded_engine();
    // 行 5 = `\t\t\t<Type> UINT32 </Type>`;全量点 = 标签后(col 9)。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        5,
        9,
    )
    .expect("Type 取值位应判面");
    assert_eq!(response.context.kind, "value");
    assert_eq!(response.context.section, "Types");
    let kinds: Vec<&str> = response.items.iter().map(|i| i.kind).collect();
    assert_eq!(kinds, vec!["type", "type", "alias"]);
    assert_eq!(response.items[0].label, "FIXED_DICT_ITEM");
    assert_eq!(response.items[0].detail.as_deref(), Some("fixedDict"));
    assert_eq!(response.items[1].label, "ITEM_LIST");
    assert_eq!(response.items[1].detail.as_deref(), Some("array"));
    assert_eq!(response.items[2].label, "MY_ALIAS");
    assert_eq!(response.items[2].detail.as_deref(), Some("ITEM_LIST"));
    // 过滤点(值首 token 末):fragment = UINT32 → 无命中但判面成立。
    let filtered = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        5,
        16,
    )
    .expect("Type 过滤位应判面");
    assert_eq!(filtered.context.fragment, "UINT32");
    assert!(filtered.items.is_empty());
}

#[test]
fn properties_open_tag_lists_own_then_inherited_with_shadowing() {
    let engine = loaded_engine();
    // 行 4 = `\t\t<hp>`;全量点 = `<` 后(col 3)。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        4,
        3,
    )
    .expect("Properties 开标签位应判面");
    assert_eq!(response.context.kind, "openTag");
    assert_eq!(response.context.section, "Properties");
    assert_eq!(response.context.entity.as_deref(), Some("Avatar"));
    let ls = labels(&response);
    // 本类在前(声明序);BaseApp 的 hp 被本类同名遮蔽,name 追加。
    assert_eq!(
        ls,
        vec!["hp".to_string(), "level".to_string(), "name".to_string()]
    );
    assert_eq!(response.items[0].inherited_from, None);
    assert_eq!(response.items[0].detail.as_deref(), Some("UINT32"));
    assert_eq!(response.items[2].inherited_from.as_deref(), Some("BaseApp"));
    assert_eq!(response.items[2].detail.as_deref(), Some("STRING"));
}

#[test]
fn methods_context_filters_by_facet_and_marks_inherited_from() {
    let engine = loaded_engine();
    // 行 13 = `\t\t<reqCastSkill>`(BaseMethods);全量点 = col 2。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        13,
        3,
    )
    .expect("BaseMethods 开标签位应判面");
    assert_eq!(response.context.section, "BaseMethods");
    assert_eq!(response.context.facet, Some("base"));
    let ls = labels(&response);
    // 本类 base 方法在前;BaseApp 的 reqCastSkill 被遮蔽,onSpawned/onHPChanged 继承。
    assert_eq!(ls, vec!["reqCastSkill", "onSpawned", "onHPChanged"]);
    assert_eq!(response.items[1].inherited_from.as_deref(), Some("BaseApp"));
    assert_eq!(response.items[1].facet, Some("base"));
    // Cell 分面只给 cell 方法(本类 respawn;BaseApp 无 cell 方法)。
    // 行 19 = `\t\t<respawn>`(CellMethods)。
    let cell = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        19,
        3,
    )
    .expect("CellMethods 开标签位应判面");
    assert_eq!(cell.context.facet, Some("cell"));
    assert_eq!(labels(&cell), vec!["respawn".to_string()]);
}

#[test]
fn fragment_filters_items() {
    let engine = loaded_engine();
    // 行 4 `\t\t<hp>`:名前 2 字符过滤点(col 5,前缀 `\t\t<hp`)。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        4,
        5,
    )
    .expect("过滤点应判面");
    assert_eq!(response.context.fragment, "hp");
    assert_eq!(labels(&response), vec!["hp".to_string()]);
}

#[test]
fn entities_root_context_lists_registered_entities() {
    let engine = loaded_engine();
    // 行 2 = `\t<Avatar hasBase="true"/>`;全量点(col 2 = `<` 后)。
    let response = complete_at(&engine, "ws/scripts/entities.xml", ENTITIES_XML, 2, 2)
        .expect("entities root 开标签位应判面");
    assert_eq!(response.context.kind, "openTag");
    assert_eq!(response.context.section, "Entities");
    assert_eq!(response.context.entity, None);
    // 条目集 = def 语料注册名(Avatar/BaseApp),与 entities.xml 注册行无关。
    assert_eq!(
        labels(&response),
        vec!["Avatar".to_string(), "BaseApp".to_string()]
    );
    assert_eq!(
        response.items[0].detail.as_deref(),
        Some("ws/scripts/entity_defs/Avatar.def")
    );
}

#[test]
fn components_context_lists_entity_items() {
    let engine = loaded_engine();
    const WITH_COMP: &str = "<root>\n\
\t<Components>\n\
\t\t<bag>\n\
\t\t\t<Type> Inventory </Type>\n\
\t\t\t<Persistent> true </Persistent>\n\
\t\t</bag>\n\
\t</Components>\n\
</root>\n";
    // 行 3 = `\t\t<bag>`;全量点 col 3。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        WITH_COMP,
        3,
        3,
    )
    .expect("Components 开标签位应判面");
    assert_eq!(response.context.section, "Components");
    assert_eq!(
        labels(&response),
        vec!["Avatar".to_string(), "BaseApp".to_string()]
    );
}

#[test]
fn unknown_contexts_yield_none() {
    let engine = loaded_engine();
    // def 顶层(行 1)开标签:不接管。
    assert!(complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        1,
        2
    )
    .is_none());
    // `<Flags>` 子标签位(行 6,col 4 = `<` 后):栈顶是属性条目,不接管。
    assert!(complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        6,
        4
    )
    .is_none());
    // `<Arg>` 值位走类型面而非方法面。
    let arg = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        14,
        9,
    )
    .expect("Arg 取值位应判面");
    assert_eq!(arg.context.section, "Types");
    // 未知文件种类(.py)不接管。
    assert!(complete_at(&engine, "ws/scripts/entity/Avatar.py", "x", 1, 1).is_none());
}

#[test]
fn utf16_position_cuts_prefix_on_astral_chars_without_panic() {
    let engine = HoverEngine::new();
    // 行内含 astral 字符(𝄞 占 2 个 UTF-16 单位):character=5 切在 'h' 后,
    // 词法/列换算不 panic;语料为空 → 无条目上下文不可达 → None。
    let text = "\t𝄞<hp>";
    assert!(engine
        .completion(&key_of("ws/entity_defs/A.def"), text, 0, 5)
        .is_none());
}

#[test]
fn inheritance_cycle_terminates_in_members_face() {
    let mut engine = HoverEngine::new();
    const LOOP_A: &str = "<root>\n\
\t<Parent> LoopB </Parent>\n\
\t<Properties>\n\
\t\t<a>\n\
\t\t\t<Type> UINT8 </Type>\n\
\t\t</a>\n\
\t</Properties>\n\
</root>\n";
    const LOOP_B: &str = "<root>\n\
\t<Parent> LoopA </Parent>\n\
\t<Properties>\n\
\t\t<b>\n\
\t\t\t<Type> UINT8 </Type>\n\
\t\t</b>\n\
\t</Properties>\n\
</root>\n";
    engine.update(key_of("ws/entities.xml"), "<root>\n</root>\n");
    engine.update(key_of("ws/entity_defs/LoopA.def"), LOOP_A);
    engine.update(key_of("ws/entity_defs/LoopB.def"), LOOP_B);
    // 有限步终止且不重复展开(hover chain_face 同环截断)。
    let response = complete_at(&engine, "ws/entity_defs/LoopA.def", LOOP_A, 4, 3)
        .expect("环语料 Properties 位应判面");
    assert_eq!(labels(&response), vec!["a".to_string(), "b".to_string()]);
    assert_eq!(response.items[1].inherited_from.as_deref(), Some("LoopB"));
}

#[test]
fn lsp_projection_maps_kinds_and_details() {
    let engine = loaded_engine();
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        5,
        9,
    )
    .expect("Type 取值位");
    let lsp = kode_server::to_lsp_items(&response);
    assert_eq!(lsp["isIncomplete"], serde_json::json!(false));
    assert_eq!(lsp["items"][2]["label"], serde_json::json!("MY_ALIAS"));
    assert_eq!(lsp["items"][2]["kind"], serde_json::json!(7));
    assert_eq!(lsp["items"][2]["detail"], serde_json::json!("ITEM_LIST"));
}
