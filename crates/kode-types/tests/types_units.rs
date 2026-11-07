//! kode-types 单元测试:类型 IR、别名链、继承链、环检测(SEM-002/004/005/007/013 基础面)。
//! 环与缺失均为显式诊断 + 有限截断;样例同时作为文档样例(pr-008.md 引用)。

use kode_parser::model::{parse_alias, parse_types};
use kode_types::{ChainStatus, EdgeKind, TypeClass, TypeGraph, TypeId, TypeNode};

fn graph_with_types(xml: &str) -> TypeGraph {
    let mut g = TypeGraph::new();
    g.add_types(&parse_types(xml));
    g
}

/// SEM-002/SEM-005:types.xml 三种条目 → 节点与边(容器/字段/别名指向)。
#[test]
fn types_xml_builds_containers_and_alias_nodes() {
    let g = graph_with_types(
        "<root>\n\
         \x20 <ITEM_ID> UINT16 </ITEM_ID>\n\
         \x20 <ITEM_IDS>\n ARRAY\n <of> ITEM_ID </of>\n </ITEM_IDS>\n\
         \x20 <POSITION>\n FIXED_DICT\n\
         \x20   <Properties>\n\
         \x20     <x><Type> FLOAT </Type></x>\n\
         \x20     <slot_list><Type> ARRAY <of> UINT32 </of></Type></slot_list>\n\
         \x20   </Properties>\n\
         \x20   <implementedBy> POSITION_DATA.position_inst </implementedBy>\n\
         \x20 </POSITION>\n\
         </root>",
    );
    assert_eq!(g.nodes.len(), 3, "别名/数组/FixedDict 各一节点");
    assert_eq!(g.classify("ITEM_ID"), TypeClass::Alias);
    assert_eq!(g.classify("ITEM_IDS"), TypeClass::Array);
    assert_eq!(g.classify("POSITION"), TypeClass::FixedDict);
    assert_eq!(g.classify("UINT16"), TypeClass::Builtin);
    assert_eq!(g.classify("NOPE"), TypeClass::Unknown);

    // 别名链:ITEM_ID → UINT16(内建终点,resolved)。
    let chain = g.resolve_alias_chain("ITEM_ID");
    assert_eq!(chain.chain, ["ITEM_ID", "UINT16"]);
    assert_eq!(chain.status, ChainStatus::Resolved);

    // 数组元素边 + FixedDict 字段边(嵌套 ARRAY of 也进字段引用)。
    let arr = g.by_name["ITEM_IDS"];
    assert!(g
        .edges
        .iter()
        .any(|e| e.from == arr && e.kind == EdgeKind::ArrayElement && e.to == "ITEM_ID"));
    let fd = g.by_name["POSITION"];
    let fields: Vec<&str> = g
        .edges
        .iter()
        .filter(|e| e.from == fd && e.kind == EdgeKind::Field)
        .map(|e| e.to.as_str())
        .collect();
    assert_eq!(fields, ["FLOAT", "UINT32"]);
    if let TypeNode::FixedDict { implemented_by, .. } = &g.nodes[fd.0 as usize] {
        assert_eq!(implemented_by.as_deref(), Some("position_inst"));
    } else {
        panic!("POSITION 应为 FixedDict 节点");
    }

    // 数组元素本身是别名:ITEM_ID 既有入边(数组元素),又有出边(别名指向 UINT16)。
    let into: Vec<&str> = g
        .edges
        .iter()
        .filter(|e| e.to == "ITEM_ID")
        .map(|e| e.kind.as_str())
        .collect();
    assert_eq!(into, ["array_element"]);
    let item_id = g.by_name["ITEM_ID"];
    assert!(g
        .edges
        .iter()
        .any(|e| e.from == item_id && e.kind == EdgeKind::AliasTarget && e.to == "UINT16"));
}

/// SEM-004:alias.xml 别名链 + types.xml 重定向链互通。
#[test]
fn alias_xml_and_types_xml_chains_interoperate() {
    let mut g = graph_with_types("<root><ITEM_ID> UINT16 </ITEM_ID></root>");
    g.add_alias(&parse_alias(
        "<root>\n <ITEM_KEYS> ITEM_ID </ITEM_KEYS>\n <BROKEN> GHOST_TYPE </BROKEN>\n</root>",
    ));
    let chain = g.resolve_alias_chain("ITEM_KEYS");
    assert_eq!(chain.chain, ["ITEM_KEYS", "ITEM_ID", "UINT16"]);
    assert_eq!(chain.status, ChainStatus::Resolved);

    // 终端查无注册 → Unknown(理由 = 终点名,SEM-013 不冒充内建)。
    let broken = g.resolve_alias_chain("BROKEN");
    assert_eq!(broken.chain, ["BROKEN", "GHOST_TYPE"]);
    assert_eq!(broken.status, ChainStatus::Unknown);
}

/// SEM-004/IDX-005:别名环显式诊断 + 有限截断(A→B→C→A)。
#[test]
fn alias_cycle_is_diagnosed_and_terminates() {
    let mut g = TypeGraph::new();
    g.add_alias(&parse_alias("<root><A> B </A><B> C </B><C> A </C></root>"));
    let chain = g.resolve_alias_chain("A");
    assert_eq!(chain.status, ChainStatus::Cycle);
    assert_eq!(chain.chain, ["A", "B", "C"], "环截断在重复点前");
    // 从环中任一点进入都能终止且同判环。
    for start in ["B", "C"] {
        assert_eq!(g.resolve_alias_chain(start).status, ChainStatus::Cycle);
    }
    // 全图环检测恰好报告该环。
    let cycles = g.find_cycles();
    assert_eq!(
        cycles,
        [vec![
            "A".to_string(),
            "B".to_string(),
            "C".to_string(),
            "A".to_string()
        ]]
    );
}

/// SEM-007:实体继承链(父链解析 + Parent 未注册 missing + 互为 Parent 环)。
#[test]
fn inheritance_chain_missing_and_cycle() {
    let mut g = TypeGraph::new();
    let def = |parent: Option<&str>| {
        kode_parser::model::parse_def(&match parent {
            Some(p) => format!("<root><Parent>{p}</Parent></root>"),
            None => "<root/>".to_string(),
        })
    };
    g.add_def("EliteMonster", &def(Some("TrainingMonster")));
    g.add_def("TrainingMonster", &def(Some("Monster")));
    g.add_def("Monster", &def(Some("Avatar")));
    g.add_def("Avatar", &def(None));
    g.add_def("Orphan", &def(Some("GhostParent")));
    g.add_def("LoopA", &def(Some("LoopB")));
    g.add_def("LoopB", &def(Some("LoopA")));

    let chain = g.resolve_inheritance("EliteMonster");
    assert_eq!(
        chain.chain,
        ["EliteMonster", "TrainingMonster", "Monster", "Avatar"]
    );
    assert_eq!(chain.status, ChainStatus::Resolved);

    let orphan = g.resolve_inheritance("Orphan");
    assert_eq!(orphan.chain, ["Orphan", "GhostParent"]);
    assert_eq!(orphan.status, ChainStatus::Missing);

    let looper = g.resolve_inheritance("LoopA");
    assert_eq!(looper.chain, ["LoopA", "LoopB"]);
    assert_eq!(looper.status, ChainStatus::Cycle);

    // entities.xml 注册名也计入「已知实体」(注册无 def:链到此为止,不算 missing)。
    g.register_entities(&[kode_parser::model::EntityEntry {
        name: "Avatar".into(),
        name_span: kode_parser::diag::Span { start: 0, end: 0 },
        line: 1,
        attributes: vec![],
    }]);
    assert_eq!(g.classify("Avatar"), TypeClass::Entity);
    assert_eq!(
        g.resolve_inheritance("Avatar").status,
        ChainStatus::Resolved
    );
}

/// 全图环检测:继承环、别名环、自环并列;结果确定且去重。
#[test]
fn find_cycles_reports_each_graph_cycle() {
    let mut g = TypeGraph::new();
    g.add_alias(&parse_alias("<root><SELF> SELF </SELF><P> Q </P></root>"));
    let def = |parent: &str| {
        kode_parser::model::parse_def(&format!("<root><Parent>{parent}</Parent></root>"))
    };
    g.add_def("EA", &def("EB"));
    g.add_def("EB", &def("EA"));
    let mut cycles = g.find_cycles();
    cycles.sort();
    assert_eq!(
        cycles,
        [
            vec!["EA".to_string(), "EB".to_string(), "EA".to_string()],
            vec!["SELF".to_string(), "SELF".to_string()],
        ]
    );
}

/// 边种/名称分类的字符串面:golden 与报告消费这些拼写,必须稳定。
#[test]
fn edge_kind_and_type_class_labels_are_stable() {
    assert_eq!(EdgeKind::AliasTarget.as_str(), "alias_target");
    assert_eq!(EdgeKind::ArrayElement.as_str(), "array_element");
    assert_eq!(EdgeKind::Field.as_str(), "field");
    assert_eq!(EdgeKind::TypeRef.as_str(), "type_ref");
    assert_eq!(EdgeKind::ComponentOf.as_str(), "component_of");
    assert_eq!(EdgeKind::Inherits.as_str(), "inherits");

    assert_eq!(TypeClass::Builtin.as_str(), "builtin");
    assert_eq!(TypeClass::Alias.as_str(), "alias");
    assert_eq!(TypeClass::Array.as_str(), "array");
    assert_eq!(TypeClass::FixedDict.as_str(), "fixed_dict");
    assert_eq!(TypeClass::Entity.as_str(), "entity");
    assert_eq!(TypeClass::Unknown.as_str(), "unknown");
}

/// 同名重复声明:先到先得,重复条目的节点与边一并跳过(不叠加双份)。
#[test]
fn duplicate_declarations_keep_the_first() {
    let mut g = TypeGraph::new();
    g.add_alias(&parse_alias("<root><X> UINT16 </X></root>"));
    // 同名 alias.xml 再声明 → 跳过。
    g.add_alias(&parse_alias("<root><X> INT32 </X></root>"));
    // types.xml 同名条目同样跳过。
    g.add_types(&parse_types("<root><X> STRING </X></root>"));

    assert_eq!(g.nodes.len(), 1, "同名只建一个节点");
    assert_eq!(g.edges.len(), 1, "重复条目的边不叠加");
    let chain = g.resolve_alias_chain("X");
    assert_eq!(chain.chain, ["X", "UINT16"], "保留首个声明的指向");
    assert_eq!(chain.status, ChainStatus::Resolved);
}

/// 从非别名节点(容器/实体)发起别名链:无指向,链即自身且自身已知(已解析)。
#[test]
fn alias_chain_from_non_alias_node_is_a_single_known_element() {
    let mut g = graph_with_types(
        "<root>\n\
         \x20 <IDS>\n ARRAY\n <of> UINT32 </of>\n </IDS>\n\
         \x20 <POS>\n FIXED_DICT\n <Properties><x><Type> FLOAT </Type></x></Properties>\n </POS>\n\
         </root>",
    );
    g.add_def("Hero", &kode_parser::model::parse_def("<root/>"));
    for name in ["IDS", "POS", "Hero"] {
        let chain = g.resolve_alias_chain(name);
        assert_eq!(chain.chain, [name], "{name} 无别名指向");
        assert_eq!(
            chain.status,
            ChainStatus::Resolved,
            "{name} 是图内已注册节点"
        );
    }
}

/// 数组无 `<of>` 元素:节点保留,但无数组元素边(缺元素类型是真实语料形态)。
#[test]
fn array_without_of_element_keeps_node_without_element_edge() {
    let g = graph_with_types("<root><NOELEM>\n ARRAY\n </NOELEM></root>");
    assert_eq!(g.nodes.len(), 1);
    assert_eq!(g.classify("NOELEM"), TypeClass::Array);
    let id = g.by_name["NOELEM"];
    assert!(
        !g.edges
            .iter()
            .any(|e| e.from == id && e.kind == EdgeKind::ArrayElement),
        "无 <of> 就不产数组元素边"
    );
}

/// 空指向别名:链在空指向处终止(不空转),自身为图内节点 → 已解析。
#[test]
fn alias_with_empty_target_stops_walking_and_stays_resolved() {
    // 空指向别名只能由直接灌图构造(解析器侧空条目/空 Type 均已跳过)。
    let mut g = TypeGraph::new();
    g.nodes.push(TypeNode::Alias {
        name: String::from("BARE"),
        target: String::new(),
    });
    g.by_name.insert(String::from("BARE"), TypeId(0));
    let chain = g.resolve_alias_chain("BARE");
    assert_eq!(chain.chain, ["BARE"], "空指向终止链,不产生后续元素");
    assert_eq!(chain.status, ChainStatus::Resolved);
}

/// 组件边与属性类型引用边(实体 → 组件/类型引用,IDX-002 面)。
#[test]
fn def_components_and_property_refs_become_edges() {
    let mut g = TypeGraph::new();
    let def = kode_parser::model::parse_def(
        "<root>\n <Properties>\n  <bag><Type> ARRAY <of> ITEM_ID </of> </Type></bag>\n </Properties>\n\
         <Components>\n  <Inventory><Type> InventoryComp </Type></Inventory>\n </Components>\n</root>",
    );
    g.add_def("Hero", &def);
    g.add_types(&parse_types("<root><ITEM_ID> UINT16 </ITEM_ID></root>"));
    let hero = g.by_name["Hero"];
    let kinds: Vec<(&str, &str)> = g
        .edges
        .iter()
        .filter(|e| e.from == hero)
        .map(|e| (e.kind.as_str(), e.to.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [("component_of", "InventoryComp"), ("type_ref", "ITEM_ID")]
    );
    assert_eq!(g.classify("InventoryComp"), TypeClass::Unknown);
}
