//! kode-types 方法元数据单元测试(RUST-108):分面注册、调用权限面、
//! 出处携带、参数/返回类型透传、重复实体不重复登记。

use kode_parser::{parse_def, parse_types};
use kode_types::{MethodFacet, TypeGraph, TypeSourceKind};

fn def_with_methods() -> kode_parser::model::DefFile {
    parse_def(
        "<root>\n <Properties>\n  <hp><Type> UINT16 </Type><Flags> CELL_PUBLIC </Flags></hp>\n\
         \x20 </Properties>\n\
         \x20 <BaseMethods>\n\
         \x20  <reqQuest>\n   <Arg> UINT32 </Arg>\n   <ReturnType> BOOL </ReturnType>\n   <Exposed/>\n  </reqQuest>\n\
         \x20  <secret><Arg> UINT8 </Arg></secret>\n\
         \x20 </BaseMethods>\n\
         \x20 <CellMethods>\n\
         \x20  <dash><Exposed/></dash>\n\
         \x20 </CellMethods>\n\
         \x20 <ClientMethods>\n\
         \x20  <onHit><Arg> ARRAY <of> UINT32 </of> </Arg></onHit>\n\
         \x20 </ClientMethods>\n\
         </root>",
    )
}

/// 分面注册:三段逐方法登记,段序稳定;参数/返回类型/Exposed 透传;
/// 出处携带灌入上下文。
#[test]
fn methods_registered_by_facet_with_metadata() {
    let mut g = TypeGraph::new();
    g.set_ingest(Some("root-a"), Some(3));
    g.add_types(&parse_types("<root><ITEM_ID> UINT16 </ITEM_ID></root>"));
    g.add_def("Hero", &def_with_methods());

    let all = g.entity_methods("Hero");
    assert_eq!(all.len(), 4, "Base 2 + Cell 1 + Client 1");
    assert_eq!(
        all.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        ["reqQuest", "secret", "dash", "onHit"],
        "段序 = Base/Cell/Client,段内 = 声明序"
    );

    let base = g.methods_by_facet("Hero", MethodFacet::Base);
    assert_eq!(base.len(), 2);
    assert_eq!(base[0].return_type.as_deref(), Some("BOOL"));
    assert_eq!(base[0].args.len(), 1);
    assert_eq!(base[0].args[0].type_refs, ["UINT32"]);
    assert!(base[0].exposed);
    assert!(!base[1].exposed, "无 Exposed = false");

    let client = g.methods_by_facet("Hero", MethodFacet::Client);
    assert_eq!(client[0].args[0].type_refs, ["UINT32"], "ARRAY <of> 剥指令");
    assert_eq!(client[0].facet.as_str(), "client");

    let m = &g.entity_methods("Hero")[0];
    assert_eq!(m.origin.source, TypeSourceKind::Def);
    assert_eq!(m.origin.root.as_deref(), Some("root-a"));
    assert_eq!(m.origin.version, Some(3));
    assert_eq!(m.origin.line, Some(6), "reqQuest 声明行");
    let s = m.origin.span.expect("方法声明 span 在");
    assert!(s.start < s.end);
}

/// 调用权限面:Exposed truthy 跨分面枚举;Client 分面方法不因无 Exposed
/// 而缺席(方向语义见模块doc,事实面只记 Exposed)。
#[test]
fn exposed_methods_enumerate_across_facets() {
    let mut g = TypeGraph::new();
    g.add_def("Hero", &def_with_methods());
    let exposed = g.exposed_methods("Hero");
    assert_eq!(
        exposed.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        ["reqQuest", "dash"],
        "Base Exposed + Cell Exposed,按登记序"
    );
    assert_eq!(g.entity_methods("Hero").len(), 4, "Client 分面不缺席");
    assert!(g.exposed_methods("Ghost").is_empty());
}

/// 重复 add_def 同名实体:节点 first-write-wins 拒绝 → 方法不重复登记。
#[test]
fn duplicate_def_does_not_duplicate_methods() {
    let mut g = TypeGraph::new();
    g.add_def("Hero", &def_with_methods());
    g.add_def("Hero", &def_with_methods());
    assert_eq!(g.entity_methods("Hero").len(), 4, "不产生重复条目");
}

/// 类型节点与方法元数据并存:同一图上 RUST-105 出处面(RUST-104-W 节点
/// 形态)与 RUST-108 方法面互不干扰。
#[test]
fn method_registry_coexists_with_type_graph_faces() {
    let mut g = TypeGraph::new();
    g.add_types(&parse_types("<root><ITEM_ID> UINT16 </ITEM_ID></root>"));
    g.add_def("Hero", &def_with_methods());
    g.materialize_unknown("Ghost").expect("物化");
    assert_eq!(g.nodes.len(), g.origins.len(), "出处锁步不受方法面影响");
    assert_eq!(g.entity_methods("Hero").len(), 4);
    assert_eq!(g.classify("ITEM_ID"), kode_types::TypeClass::Alias);
}

/// 稳定协议面:方法分面 as_str 三变体钉板。
#[test]
fn method_facet_as_str_all_variants() {
    assert_eq!(MethodFacet::Base.as_str(), "base");
    assert_eq!(MethodFacet::Cell.as_str(), "cell");
    assert_eq!(MethodFacet::Client.as_str(), "client");
}
