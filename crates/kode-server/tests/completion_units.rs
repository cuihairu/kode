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
    let lsp = kode_server::to_lsp_items(&response, RootId::UNROOTED);
    assert_eq!(lsp["isIncomplete"], serde_json::json!(false));
    assert_eq!(lsp["items"][2]["label"], serde_json::json!("MY_ALIAS"));
    assert_eq!(lsp["items"][2]["kind"], serde_json::json!(7));
    assert_eq!(lsp["items"][2]["detail"], serde_json::json!("ITEM_LIST"));
}

// ---------------------------------------------------------------------------
// 取值位/开标签位的否定判定:余文非空白、头部不匹配、种类无臂 → None
// ---------------------------------------------------------------------------

#[test]
fn parent_head_with_trailing_content_is_not_a_value_site() {
    let engine = loaded_engine();
    // 光标在 "Xyz " 之后(col 13):fragment 空,head 余文 "Xyz" 非纯空白
    // → 非取值位,返回 None。
    let text = "<root>\n\t<Parent>Xyz </Parent>\n</root>\n";
    assert!(
        complete_at(&engine, "ws/scripts/entity_defs/Avatar.def", text, 2, 13).is_none(),
        "Parent 余文非空白 → None"
    );
}

#[test]
fn type_head_with_trailing_content_is_not_a_value_site() {
    let engine = loaded_engine();
    let text = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n";
    // col 16 = "UINT32 " 之后:fragment 空,head 余文 "UINT32" 非空白 → None。
    assert!(
        complete_at(&engine, "ws/scripts/entity_defs/Avatar.def", text, 4, 16).is_none(),
        "Type 余文非空白 → None"
    );
}

#[test]
fn unrecognized_head_element_is_not_a_value_site() {
    let engine = loaded_engine();
    // 行尾在 `<hp>` 上:head 不以 Parent/Type/Arg/of 开头 → None。
    assert!(
        complete_at(
            &engine,
            "ws/scripts/entity_defs/Avatar.def",
            AVATAR_DEF,
            4,
            7
        )
        .is_none(),
        "`<hp>` 头部不匹配取值标签 → None"
    );
}

#[test]
fn open_tag_context_on_alias_documents_yields_none() {
    let engine = loaded_engine();
    // alias.xml 开标签位:open-tag 判面只认 Def/Entities,alias → None。
    let alias = "<root>\n\t<HP_ALIAS>\n\t\t<Type> HP </Type>\n\t</HP_ALIAS>\n</root>\n";
    assert!(
        complete_at(&engine, "ws/scripts/entity_defs/alias.xml", alias, 2, 2).is_none(),
        "alias 开标签位无臂 → None"
    );
}

#[test]
fn value_context_on_alias_documents_lists_types_without_entity() {
    // alias.xml 的 <Type> 取值位:文件种类非 Def → def_entity_name 缺省 None
    // (209),仍出 type/alias 候选(kind="value")。
    let response = complete_at(
        &loaded_engine(),
        "ws/scripts/entity_defs/alias.xml",
        ALIAS_XML,
        3,
        10,
    );
    let response = response.expect("alias value context yields completion");
    assert_eq!(response.context.kind, "value");
    assert!(
        !response.items.is_empty(),
        "alias 取值位至少给出类型/别名候选"
    );
}

// ---------------------------------------------------------------------------
// RUST-134:py `self.` 实体成员面(共享 def 链查询)
// ---------------------------------------------------------------------------

const AVATAR_PY: &str = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tself.\n";

/// 全量点:本类属性(带类型)→ 三分面方法(base/cell/client,声明序)→
/// 继承链成员(近祖先优先;同名被本类/先出项遮蔽,`inheritedFrom` 标注)。
/// context 面 kind="self" section="Entity" entity=文件 stem 归属实体。
#[test]
fn py_self_completion_lists_own_then_facet_methods_then_chain() {
    let engine = loaded_engine();
    // 行 6(1 起)= `\t\tself.`,col 7 = 行尾全量点。
    let response =
        complete_at(&engine, "ws/scripts/base/Avatar.py", AVATAR_PY, 6, 7)
            .expect("py self. 位应判面");
    assert_eq!(response.context.kind, "self");
    assert_eq!(response.context.section, "Entity");
    assert_eq!(response.context.entity.as_deref(), Some("Avatar"));
    assert_eq!(response.context.fragment, "");
    // 本类 hp(UINT32)/level(UINT16)→ reqCastSkill(base)/respawn(cell)
    // → 继承:name/onSpawned/onHPChanged/notify(BaseApp;hp·reqCastSkill
    // 同名被本类遮蔽不出)。
    assert_eq!(
        labels(&response),
        vec![
            "hp".to_string(),
            "level".to_string(),
            "reqCastSkill".to_string(),
            "respawn".to_string(),
            "name".to_string(),
            "onSpawned".to_string(),
            "onHPChanged".to_string(),
            "notify".to_string(),
        ]
    );
    // 本类属性 detail=类型;同名遮蔽:hp 是本类 UINT32,非父 UINT64。
    assert_eq!(response.items[0].kind, "property");
    assert_eq!(response.items[0].detail.as_deref(), Some("UINT32"));
    assert_eq!(response.items[0].inherited_from, None);
    // 方法三分面 facet 标注归属。
    assert_eq!(response.items[2].kind, "method");
    assert_eq!(response.items[2].facet, Some("base"));
    assert_eq!(response.items[3].facet, Some("cell"));
    // 继承成员:inheritedFrom=BaseApp;name 本类无声明照常出项。
    assert_eq!(response.items[4].kind, "property");
    assert_eq!(response.items[4].detail.as_deref(), Some("STRING"));
    assert_eq!(response.items[4].inherited_from.as_deref(), Some("BaseApp"));
    assert_eq!(response.items[7].facet, Some("client"));
    assert_eq!(response.items[7].inherited_from.as_deref(), Some("BaseApp"));
}

/// 过滤:片段大小写不敏感前缀(TS python 面同口径);命中本类时仍出
/// 本类版本(遮蔽在过滤后同样生效)。
#[test]
fn py_self_completion_filters_fragment_case_insensitively() {
    let engine = loaded_engine();
    let py = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tself.HP\n";
    // col 9 = `self.HP` 行尾,fragment="HP"。
    let response =
        complete_at(&engine, "ws/scripts/base/Avatar.py", py, 6, 9)
            .expect("过滤位应判面");
    assert_eq!(response.context.fragment, "HP");
    assert_eq!(labels(&response), vec!["hp".to_string()]);
    assert_eq!(response.items[0].detail.as_deref(), Some("UINT32"));
    assert_eq!(response.items[0].inherited_from, None);
    // 无命中:片段存在但判面成立(items 空,不是 None)。
    let py_none = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tself.zzz\n";
    let response =
        complete_at(&engine, "ws/scripts/base/Avatar.py", py_none, 6, 10)
            .expect("无命中也是判面成立");
    assert!(response.items.is_empty());
}

/// 诚实让位:嵌套 `self.a.` 多段路径不接管(TS nested 面语义);非 self
/// 接收者不接管;非实体 py(无同 stem 语料 def)不接管;scripts/ 之外的
/// py 不接管。
#[test]
fn py_self_completion_yields_none_outside_first_self_segment() {
    let engine = loaded_engine();
    let nested = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tself.pos.x\n";
    assert!(
        complete_at(&engine, "ws/scripts/base/Avatar.py", nested, 6, 12).is_none(),
        "self.pos.x 嵌套段不接管"
    );
    let other = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tmonster.\n";
    assert!(
        complete_at(&engine, "ws/scripts/base/Avatar.py", other, 6, 12).is_none(),
        "非 self 接收者不接管"
    );
    // 无 Helper.def 语料:stem 归属落空 → None。
    assert!(
        complete_at(&engine, "ws/scripts/base/Helper.py", AVATAR_PY, 6, 7).is_none(),
        "非实体 py 不接管"
    );
    // scripts/ 之外:路径面不符 → None。
    assert!(
        complete_at(&engine, "ws/entity_defs/Avatar.py", AVATAR_PY, 6, 7).is_none(),
        "scripts/ 外 py 不接管"
    );
}

/// KBEngine. 模块别名面不被 py self 臂回归:module face 优先保持。
#[test]
fn py_module_alias_face_still_wins_over_self_arm() {
    let engine = loaded_engine();
    let py = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tKBEngine.\n";
    let response = complete_at(&engine, "ws/scripts/base/Avatar.py", py, 6, 13)
        .expect("KBEngine. 位应判面");
    assert_eq!(response.context.kind, "module");
    assert_eq!(response.context.section, "KBEngine");
}

// ---------------------------------------------------------------------------
// RUST-135:LSP 投影增补面(sortText/filterText/snippet/data)+ resolve 延迟补详情
// ---------------------------------------------------------------------------

#[test]
fn lsp_projection_locks_order_and_emits_def_resolve_data() {
    let engine = loaded_engine();
    // 行 4 = `\t\t<hp>`:Properties 开标签全量点(本类 + 继承链)。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        4,
        3,
    )
    .expect("Properties 开标签位应判面");
    let lsp = kode_server::to_lsp_items(&response, RootId::UNROOTED);
    let items = lsp["items"].as_array().expect("items");
    // sortText = 零填充响应序(声明序/链序锁死,客户端不按 label 重排);
    // filterText = label。
    for (seq, item) in items.iter().enumerate() {
        assert_eq!(item["sortText"], serde_json::json!(format!("{:04}", seq)));
        assert_eq!(item["filterText"], item["label"]);
    }
    // 本类属性 data:source=def + 实体归属 + 类型;无 snippet(XML 面)。
    let hp = items.iter().find(|i| i["label"] == serde_json::json!("hp")).unwrap();
    assert_eq!(hp["data"]["source"], serde_json::json!("def"));
    assert_eq!(hp["data"]["root"], serde_json::json!(0));
    assert_eq!(hp["data"]["entity"], serde_json::json!("Avatar"));
    assert_eq!(hp["data"]["typeKind"], serde_json::json!("UINT32"));
    assert_eq!(hp["data"]["inheritedFrom"], serde_json::Value::Null);
    assert!(hp.get("insertText").is_none(), "def XML 面无 snippet");
    // 继承属性 data:inheritedFrom 定位祖先。
    let name = items.iter().find(|i| i["label"] == serde_json::json!("name")).unwrap();
    assert_eq!(name["data"]["inheritedFrom"], serde_json::json!("BaseApp"));
}

#[test]
fn lsp_projection_py_self_and_module_method_items_get_snippets() {
    let engine = loaded_engine();
    // py self 面:method 条目 snippet `name($0)`(format 2),property plain。
    let py = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tself.\n";
    let response = complete_at(&engine, "ws/scripts/base/Avatar.py", py, 6, 7)
        .expect("py self. 位应判面");
    let lsp = kode_server::to_lsp_items(&response, RootId::UNROOTED);
    let items = lsp["items"].as_array().expect("items");
    let method = items.iter().find(|i| i["kind"] == serde_json::json!(2)).unwrap();
    assert_eq!(method["insertTextFormat"], serde_json::json!(2));
    assert_eq!(method["insertText"], serde_json::json!(format!("{}($0)", method["label"].as_str().unwrap())));
    let prop = items.iter().find(|i| i["kind"] == serde_json::json!(10)).unwrap();
    assert!(prop.get("insertText").is_none(), "属性条目 plain");
    // module 面:function 条目 snippet + signature 进 data。
    let py_mod = "import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tKBEngine.\n";
    let response = complete_at(&engine, "ws/scripts/base/Avatar.py", py_mod, 6, 13)
        .expect("KBEngine. 位应判面");
    let lsp = kode_server::to_lsp_items(&response, RootId::UNROOTED);
    let items = lsp["items"].as_array().expect("items");
    let function = items.iter().find(|i| i["kind"] == serde_json::json!(3)).unwrap();
    assert_eq!(function["insertTextFormat"], serde_json::json!(2));
    assert_eq!(function["data"]["source"], serde_json::json!("module"));
    assert_eq!(function["data"]["process"], serde_json::json!("base"));
    assert!(function["data"]["signature"].is_string(), "签名进 data");
}

#[test]
fn resolve_enriches_def_property_and_inherited_member_documentation() {
    let engine = loaded_engine();
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        4,
        3,
    )
    .expect("Properties 开标签位应判面");
    let lsp = kode_server::to_lsp_items(&response, RootId::UNROOTED);
    // 本类属性:类型 + 来源 def 路径。
    let hp = lsp["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["label"] == serde_json::json!("hp"))
        .unwrap()
        .clone();
    let resolved = kode_server::resolve_item(&engine, &hp);
    let doc = resolved["documentation"]["value"].as_str().expect("documentation");
    assert!(doc.contains("**hp**"), "标题: {doc}");
    assert!(doc.contains("`UINT32`"), "类型面: {doc}");
    assert!(doc.contains("`BASE_AND_CLIENT`"), "Flags 面: {doc}");
    assert!(doc.contains("ws/scripts/entity_defs/Avatar.def"), "来源路径: {doc}");
    // 继承成员:定位祖先 def,文档带「继承自」+ 祖先来源。
    let name = lsp["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["label"] == serde_json::json!("name"))
        .unwrap()
        .clone();
    let resolved = kode_server::resolve_item(&engine, &name);
    let doc = resolved["documentation"]["value"].as_str().expect("documentation");
    assert!(doc.contains("`STRING`"), "祖先类型: {doc}");
    assert!(doc.contains("继承自 BaseApp"), "继承标注: {doc}");
    assert!(doc.contains("ws/scripts/entity_defs/BaseApp.def"), "祖先来源: {doc}");
}

#[test]
fn resolve_enriches_method_signature_and_facet_documentation() {
    let engine = loaded_engine();
    // 行 13(1 起)= `\t\t<reqCastSkill>`:BaseMethods 开标签全量点 col 3。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        13,
        3,
    )
    .expect("BaseMethods 开标签位应判面");
    assert_eq!(response.context.section, "BaseMethods");
    let lsp = kode_server::to_lsp_items(&response, RootId::UNROOTED);
    let item = lsp["items"][0].clone();
    assert_eq!(item["label"], serde_json::json!("reqCastSkill"));
    let resolved = kode_server::resolve_item(&engine, &item);
    let doc = resolved["documentation"]["value"].as_str().expect("documentation");
    assert!(doc.contains("分面:base"), "分面: {doc}");
    assert!(doc.contains("reqCastSkill(skillId)"), "签名(带 Arg): {doc}");
    assert!(doc.contains("来源:"), "来源: {doc}");
}

#[test]
fn resolve_enriches_type_alias_entity_documentation() {
    let engine = loaded_engine();
    // 类型/别名:Type 取值位 fragment=UINT32 → 无命中空集,改全量点。
    let response = complete_at(
        &engine,
        "ws/scripts/entity_defs/Avatar.def",
        AVATAR_DEF,
        2,
        9,
    )
    .expect("Parent 取值位应判面");
    let lsp = kode_server::to_lsp_items(&response, RootId::UNROOTED);
    let item = lsp["items"][0].clone();
    assert_eq!(item["data"]["source"], serde_json::json!("entity"));
    let resolved = kode_server::resolve_item(&engine, &item);
    let doc = resolved["documentation"]["value"].as_str().expect("documentation");
    assert!(doc.contains("实体声明:"), "实体文档: {doc}");
    assert!(doc.contains(".def"), "声明路径: {doc}");
}

#[test]
fn resolve_without_usable_payload_echoes_input_unchanged() {
    let engine = loaded_engine();
    let base = serde_json::json!({ "label": "mystery", "kind": 7 });
    let resolved = kode_server::resolve_item(&engine, &base);
    assert_eq!(resolved, base, "无 data → 原样返回");
    let bad = serde_json::json!({ "label": "x", "kind": 7, "data": { "source": "elsewhere" } });
    let resolved = kode_server::resolve_item(&engine, &bad);
    assert_eq!(resolved, bad, "未知 source → 原样返回");
    // 语料缺位(def 归属落空)→ 原样返回,不装空文档。
    let ghost = serde_json::json!({
        "label": "hp", "kind": 10,
        "data": { "source": "def", "root": 7, "entity": "Ghost", "name": "hp" }
    });
    let resolved = kode_server::resolve_item(&engine, &ghost);
    assert_eq!(resolved, ghost, "语料缺位 → 原样返回");
}
