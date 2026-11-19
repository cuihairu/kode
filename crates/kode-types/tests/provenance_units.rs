//! kode-types 出处面单元测试(SEM-003/RUST-105):declaration/definition/
//! reference source span、原始 root/version、生成映射。全部侧表语义,
//! 节点/边构建零改动(既有 types_units 11+7 钉独立保持)。

use kode_parser::{parse_alias, parse_def, parse_entities, parse_types};
use kode_types::{
    EdgeKind, GenerationKind, GenerationTarget, TypeClass, TypeGraph, TypeId, TypeSourceKind,
};

/// 出处盖章:灌入上下文 root/version 随 add_* 进 origin;来源种类与声明
/// site 按入口区分;add_def 实体名来自文件名,正文无声明 site → span/line
/// 如实 None。
#[test]
fn origin_stamped_with_ingest_context() {
    let mut g = TypeGraph::new();
    g.set_ingest(Some("root-a"), Some(7));
    g.add_types(&parse_types(
        "<root>\n <ITEM_ID> UINT16 </ITEM_ID>\n</root>",
    ));
    g.add_alias(&parse_alias(
        "<root>\n <AL>\n  <Type> ITEM_ID </Type>\n </AL>\n</root>",
    ));
    g.add_def("Hero", &parse_def("<root><Parent>Monster</Parent></root>"));
    g.register_entities(&parse_entities("<root>\n <Monster hasBase=\"true\"/>\n</root>").entities);

    let types_xml = g.by_name["ITEM_ID"];
    let o = g.origin_of(types_xml).expect("types.xml 出处在");
    assert_eq!(o.source, TypeSourceKind::TypesXml);
    assert_eq!(o.root.as_deref(), Some("root-a"));
    assert_eq!(o.version, Some(7));
    assert_eq!(o.line, Some(2));
    let s = o.span.expect("声明名 span 在");
    assert!(s.start < s.end, "非平凡 span");

    let alias_xml = g.by_name["AL"];
    let o = g.origin_of(alias_xml).expect("alias.xml 出处在");
    assert_eq!(o.source, TypeSourceKind::AliasXml);
    assert_eq!(o.line, Some(2));

    let def = g.by_name["Hero"];
    let o = g.origin_of(def).expect("def 出处在");
    assert_eq!(o.source, TypeSourceKind::Def);
    assert_eq!(o.span, None, "实体名来自文件名,正文无 site 不虚构");
    assert_eq!(o.line, None);

    let reg = g.entity_registration_origin("Monster").expect("注册出处");
    assert_eq!(reg.source, TypeSourceKind::EntitiesXml);
    assert_eq!(reg.line, Some(2));
    assert_eq!(reg.root.as_deref(), Some("root-a"));
}

/// 平行表锁步与防御读:push_node 单隘口锁步 → nodes 与 origins 等长;
/// 绕过 push_node 的直接节点表写入不锁步,origin_of 防御性返 None。
#[test]
fn origin_lockstep_and_defensive_reads() {
    let mut g = TypeGraph::new();
    g.set_ingest(Some("root-a"), Some(7));
    g.add_types(&parse_types("<root><A> UINT16 </A><B> UINT32 </B></root>"));
    g.add_def("Hero", &parse_def("<root/>"));
    g.materialize_unknown("Ghost").expect("物化");
    assert_eq!(g.nodes.len(), g.origins.len(), "锁步");
    assert!(g.origin_of(TypeId(99)).is_none(), "越界防御");

    // 绕过 push_node 的直接写入(测试/外部形态)不锁步。
    g.nodes.push(kode_types::TypeNode::UserType {
        name: "Direct".to_string(),
    });
    assert_eq!(
        g.origin_of(TypeId((g.nodes.len() - 1) as u32)),
        None,
        "缺位防御返 None,不虚构出处"
    );
}

/// 引用点锚统一 = 引用方声明 name span:types.xml 容器字段/数组元素/别名
/// 指向锚在其声明名;def 属性/组件锚在其声明名;Parent 无 span 如实 None。
/// 查询按被引用名过滤,序 = 灌入序。
#[test]
fn reference_sites_anchor_at_referencing_declaration() {
    let mut g = TypeGraph::new();
    g.add_types(&parse_types(
        "<root>\n <BAG_LIST>\n ARRAY\n <of> ITEM_ID </of>\n </BAG_LIST>\n</root>",
    ));
    g.add_alias(&parse_alias(
        "<root>\n <AL>\n  <Type> ITEM_ID </Type>\n </AL>\n</root>",
    ));
    g.add_def(
        "Hero",
        &parse_def(
            "<root>\n <Properties>\n  <bag><Type> ITEM_ID </Type></bag>\n </Properties>\n\
             <Components>\n  <inv><Type> InventoryComp </Type></inv>\n </Components>\n\
             <Parent> Monster </Parent>\n</root>",
        ),
    );

    let item_refs = g.reference_sites("ITEM_ID");
    assert_eq!(item_refs.len(), 3, "数组元素/别名指向/def 属性各一");
    assert_eq!(item_refs[0].kind, EdgeKind::ArrayElement);
    assert_eq!(item_refs[0].line, Some(2), "锚在 BAG_LIST 声明行");
    assert_eq!(item_refs[1].kind, EdgeKind::AliasTarget);
    assert_eq!(item_refs[1].line, Some(2), "锚在 AL 声明行");
    assert_eq!(item_refs[2].kind, EdgeKind::TypeRef);
    assert_eq!(item_refs[2].line, Some(3), "锚在 bag 属性声明行");
    assert!(item_refs[2].span.is_some());
    assert!(item_refs[2].from == g.by_name["Hero"]);

    let comp_refs = g.reference_sites("InventoryComp");
    assert_eq!(comp_refs.len(), 1);
    assert_eq!(comp_refs[0].kind, EdgeKind::ComponentOf);
    assert_eq!(comp_refs[0].line, Some(6), "锚在 inv 组件槽声明行");

    let parent_refs = g.reference_sites("Monster");
    assert_eq!(parent_refs.len(), 1);
    assert_eq!(parent_refs[0].kind, EdgeKind::Inherits);
    assert_eq!(parent_refs[0].span, None, "Parent 无 span 如实 None");
    assert_eq!(parent_refs[0].line, None);

    assert!(g.reference_sites("NoSuchRef").is_empty());
}

/// entities.xml 注册出处:同名先到先得(多 root 重注册不改首录);未注册
/// 名 None;注册面不产节点,分类口径不变。
#[test]
fn entity_registration_first_wins_and_no_nodes() {
    let mut g = TypeGraph::new();
    g.set_ingest(Some("root-a"), Some(1));
    g.register_entities(&parse_entities("<root><Avatar/></root>").entities);
    g.set_ingest(Some("root-b"), Some(2));
    g.register_entities(&parse_entities("<root><Avatar/></root>").entities);
    let o = g.entity_registration_origin("Avatar").expect("首录在");
    assert_eq!(o.root.as_deref(), Some("root-a"), "先到先得");
    assert_eq!(o.version, Some(1));
    assert!(!g.by_name.contains_key("Avatar"), "注册面无节点(既有口径)");
    assert_eq!(g.classify("Avatar"), TypeClass::Entity, "分类口径不变");
    assert!(g.entity_registration_origin("Ghost").is_none());
}

/// 生成映射:opt-in 注册,同类型多产物按登记序;未登记 = 空;灌入上下文
/// 不自动填充(构建器永不自动)。
#[test]
fn generation_links_are_opt_in_registry() {
    let mut g = TypeGraph::new();
    g.set_ingest(Some("root-a"), Some(7));
    g.add_types(&parse_types(
        "<root><POSITION> FIXED_DICT </POSITION></root>",
    ));
    assert!(
        g.generation_targets("POSITION").is_empty(),
        "灌入不自动产生成映射"
    );
    g.link_generation(
        "POSITION",
        GenerationTarget {
            kind: GenerationKind::PyiStub,
            path: ".kbengine/stubs/kbe_types/POSITION.pyi".to_string(),
        },
    );
    g.link_generation(
        "POSITION",
        GenerationTarget {
            kind: GenerationKind::PyiStub,
            path: "out/kbe_types.d.ts".to_string(),
        },
    );
    let targets = g.generation_targets("POSITION");
    assert_eq!(targets.len(), 2, "多产物按登记序");
    assert_eq!(targets[0].path, ".kbengine/stubs/kbe_types/POSITION.pyi");
    assert_eq!(targets[1].kind.as_str(), "pyi_stub");
    assert!(g.generation_targets("UNLINKED").is_empty());
}

/// 上下文复位:set → 灌入 → clear → 灌入,后者 root/version = None,
/// 来源种类/声明 site 不受影响。
#[test]
fn ingest_context_reset_leaves_source_site_intact() {
    let mut g = TypeGraph::new();
    g.set_ingest(Some("root-a"), Some(7));
    g.add_types(&parse_types("<root><A> UINT16 </A></root>"));
    g.clear_ingest();
    g.add_types(&parse_types("<root><B> UINT32 </B></root>"));
    let a = g.origin_of(g.by_name["A"]).unwrap();
    let b = g.origin_of(g.by_name["B"]).unwrap();
    assert_eq!(a.root.as_deref(), Some("root-a"));
    assert_eq!(b.root, None, "clear 后 root 不携带");
    assert_eq!(b.version, None);
    assert_eq!(b.source, TypeSourceKind::TypesXml, "来源种类不受影响");
    assert_eq!(b.line, Some(1), "声明 site 不受影响");
}
