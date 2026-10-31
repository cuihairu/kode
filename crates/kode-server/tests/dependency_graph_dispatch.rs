//! `$/kode/dependency/graph` dispatch 与 def 依赖图核心单测。
//!
//! 覆盖(IDE-RUST-007):
//! - 起点=entities.xml 登记实体 → entity 节点(types 从 hasBase/hasCell/hasClient 派生);
//! - registration 边(entity→def)、inheritance(Parent)、is-a(Interfaces)、has-a(组件槽);
//! - property-type(属性→types.xml 对象类 / 属性→实体 def)、implements(ImplementedBy→python)、
//!   method-impl(def→python 实现文件);
//! - 反向索引 reverseEdges、三路径 paths、环守卫、缺 def 文本 stub、空参确定性。

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn response_of(out: &[Outgoing]) -> &Value {
    match &out[0] {
        Outgoing::Response(response) => response.result.as_ref().unwrap(),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

/// 走完整 `$/kode/rpc` 链路调 `$/kode/dependency/graph`,返回图 JSON。
fn graph(params: Value) -> Value {
    let mut state = ServerState::new();
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/dependency/graph", "params": params}),
        ),
    );
    response_of(&out).clone()
}

fn nodes_of(graph: &Value) -> &Vec<Value> {
    graph.get("nodes").unwrap().as_array().unwrap()
}

fn node_named<'a>(graph: &'a Value, id: &str) -> &'a Value {
    nodes_of(graph)
        .iter()
        .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(id))
        .unwrap_or_else(|| panic!("node {id} not found"))
}

fn edges_of(graph: &Value) -> &Vec<Value> {
    graph.get("edges").unwrap().as_array().unwrap()
}

fn has_edge(graph: &Value, from: &str, to: &str, kind: &str) -> bool {
    edges_of(graph).iter().any(|e| {
        e.get("from").and_then(|v| v.as_str()) == Some(from)
            && e.get("to").and_then(|v| v.as_str()) == Some(to)
            && e.get("kind").and_then(|v| v.as_str()) == Some(kind)
    })
}

fn reverse_of<'a>(graph: &'a Value, to: &str) -> &'a Vec<Value> {
    graph
        .get("reverseEdges")
        .unwrap()
        .get(to)
        .and_then(|v| v.as_array())
        .unwrap_or_else(|| panic!("reverseEdges[{to}] not found"))
}

/// 全量 fixture:entities.xml(Hero 三域 + Monster 仅 cell)、Hero.def(继承 Monster、
/// 接口 IMove、组件槽 weapon→CWeapon、属性 pos:Vec3 + arr:ARRAY of Hero、三方法段)、
/// Monster.def、IMove.def(接口)、CWeapon.def(组件)、types.xml(FIXED_DICT Vec3 带 implementedBy)。
fn full_fixture() -> Value {
    let entities_xml = r#"<root>
      <Hero hasBase="true" hasCell="true" hasClient="true"/>
      <Monster hasCell="true"/>
    </root>"#;
    let types_xml = r#"<root>
      <Vec3>
        <FIXED_DICT>
          <implementedBy>game.Position</implementedBy>
          <Properties>
            <x><Type>FLOAT</Type></x>
          </Properties>
        </FIXED_DICT>
      </Vec3>
    </root>"#;
    let hero_def = "<root>\
      <Parent><Monster/></Parent>\
      <Interfaces><interface>IMove</interface></Interfaces>\
      <Properties>\
        <pos><Type>Vec3</Type><Flags>BASE_AND_CLIENT</Flags></pos>\
        <arr><Type>ARRAY<of>Hero</of></Type><Flags>CELL_PUBLIC</Flags></arr>\
      </Properties>\
      <Components><weapon><Type>CWeapon</Type></weapon></Components>\
      <BaseMethods><reqQuest><Exposed/></reqQuest></BaseMethods>\
      <CellMethods><onTick></onTick></CellMethods>\
      <ClientMethods><onUpdate></onUpdate></ClientMethods>\
    </root>";
    let monster_def = "<root>\
      <Properties><hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp></Properties>\
    </root>";
    let imove_def = "<root>\
      <BaseMethods><onMove><Exposed/></onMove></BaseMethods>\
    </root>";
    let cweapon_def = "<root>\
      <Properties><ammo><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></ammo></Properties>\
    </root>";
    json!({
        "entitiesXml": entities_xml,
        "typesXml": types_xml,
        "defsRoot": "/defs/entitys",
        "entitiesXmlPath": "/scripts/entities.xml",
        "typesXmlPath": "/defs/entitys/types.xml",
        "defs": {
            "Hero": hero_def,
            "Monster": monster_def,
            "IMove": imove_def,
            "CWeapon": cweapon_def,
        },
        "paths": {
            "Hero": "/defs/entitys/Hero.def",
            "Monster": "/defs/entitys/Monster.def",
            "IMove": "/defs/interfaces/IMove.def",
            "CWeapon": "/defs/components/CWeapon.def",
        },
        "categories": {
            "Hero": "entity",
            "Monster": "entity",
            "IMove": "interface",
            "CWeapon": "component",
        },
        "pythonFiles": {
            "Hero": ["/scripts/entities/Hero.py", "/scripts/base/Hero.py"],
            "CWeapon": ["/scripts/base/components/CWeapon.py"],
        },
        "typeImpls": {"Vec3": "/scripts/types/Vec3.py"},
    })
}

#[test]
fn full_graph_nodes_edges_reverse_and_paths() {
    let g = graph(full_fixture());

    // 节点 kinds 齐:entity/def/interface/component/type/python
    let hero = node_named(&g, "entity:Hero");
    assert_eq!(hero["kind"], "entity");
    assert_eq!(hero["filePath"], "/scripts/entities.xml");
    let types: Vec<&str> = hero["types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert_eq!(types, vec!["Base", "Cell", "Client"]);
    assert_eq!(node_named(&g, "def:Hero")["kind"], "def");
    assert_eq!(node_named(&g, "def:Hero")["filePath"], "/defs/entitys/Hero.def");
    assert_eq!(node_named(&g, "def:Monster")["kind"], "def");
    assert_eq!(node_named(&g, "interface:IMove")["kind"], "interface");
    assert_eq!(node_named(&g, "component:CWeapon")["kind"], "component");
    assert_eq!(node_named(&g, "type:Vec3")["kind"], "type");
    assert_eq!(node_named(&g, "type:Vec3")["filePath"], "/defs/entitys/types.xml");
    assert_eq!(node_named(&g, "python:/scripts/types/Vec3.py")["kind"], "python");
    assert_eq!(node_named(&g, "python:/scripts/entities/Hero.py")["kind"], "python");
    // Monster 仅 cell 域
    assert_eq!(
        node_named(&g, "entity:Monster")["types"].as_array().unwrap().len(),
        1
    );

    // 七种边
    assert!(has_edge(&g, "entity:Hero", "def:Hero", "registration"));
    assert!(has_edge(&g, "def:Hero", "def:Monster", "inheritance"));
    assert!(has_edge(&g, "def:Hero", "interface:IMove", "is-a"));
    assert!(has_edge(&g, "def:Hero", "component:CWeapon", "has-a"));
    assert!(has_edge(&g, "def:Hero", "type:Vec3", "property-type"));
    assert!(has_edge(&g, "def:Hero", "def:Hero", "property-type")); // arr 引用 Hero 自身
    assert!(has_edge(&g, "type:Vec3", "python:/scripts/types/Vec3.py", "implements"));
    assert!(has_edge(&g, "def:Hero", "python:/scripts/entities/Hero.py", "method-impl"));
    // 组件槽边 label=槽名,属性边 label=属性名
    let weapon_edge = edges_of(&g)
        .iter()
        .find(|e| e.get("kind").and_then(|v| v.as_str()) == Some("has-a"))
        .unwrap();
    assert_eq!(weapon_edge["label"], "weapon");
    let pos_edge = edges_of(&g)
        .iter()
        .find(|e| e.get("label").and_then(|v| v.as_str()) == Some("pos"))
        .unwrap();
    assert_eq!(pos_edge["kind"], "property-type");

    // 反向索引
    assert!(reverse_of(&g, "def:Hero")
        .iter()
        .any(|e| e.get("from").and_then(|v| v.as_str()) == Some("entity:Hero")
            && e.get("kind").and_then(|v| v.as_str()) == Some("registration")));
    assert!(reverse_of(&g, "type:Vec3")
        .iter()
        .any(|e| e.get("from").and_then(|v| v.as_str()) == Some("def:Hero")
            && e.get("kind").and_then(|v| v.as_str()) == Some("property-type")));
    assert!(reverse_of(&g, "python:/scripts/types/Vec3.py")
        .iter()
        .any(|e| e.get("from").and_then(|v| v.as_str()) == Some("type:Vec3")
            && e.get("kind").and_then(|v| v.as_str()) == Some("implements")));
    assert!(reverse_of(&g, "python:/scripts/entities/Hero.py")
        .iter()
        .any(|e| e.get("from").and_then(|v| v.as_str()) == Some("def:Hero")
            && e.get("kind").and_then(|v| v.as_str()) == Some("method-impl")));

    // 三路径
    let paths = &g["paths"];
    assert_eq!(paths["entitiesXml"], "/scripts/entities.xml");
    assert_eq!(paths["defsRoot"], "/defs/entitys");
    assert_eq!(paths["typesXml"], "/defs/entitys/types.xml");

    // stats
    assert!(g["stats"]["nodeCount"].as_i64().unwrap() > 0);
    assert!(g["stats"]["entityCount"].as_i64().unwrap() >= 2);
}

#[test]
fn cycle_guard_terminates_without_duplicate_edges() {
    let a = "<root><Parent><B/></Parent></root>";
    let b = "<root><Parent><A/></Parent></root>";
    let g = graph(json!({
        "entitiesXml": "<root><A hasBase=\"true\"/></root>",
        "defs": {"A": a, "B": b},
        "paths": {"A": "/defs/entitys/A.def", "B": "/defs/entitys/B.def"},
        "categories": {"A": "entity", "B": "entity"},
    }));
    // 终止,两 def 节点,inheritance 边各一条
    assert_eq!(node_named(&g, "def:A")["kind"], "def");
    assert_eq!(node_named(&g, "def:B")["kind"], "def");
    let inh = edges_of(&g)
        .iter()
        .filter(|e| e.get("kind").and_then(|v| v.as_str()) == Some("inheritance"))
        .count();
    assert_eq!(inh, 2);
}

#[test]
fn missing_def_text_keeps_stub_node_and_registration_edge() {
    let g = graph(json!({
        "entitiesXml": "<root><Ghost hasBase=\"true\"/></root>",
        "defs": {},
        "paths": {"Ghost": "/defs/entitys/Ghost.def"},
        "categories": {"Ghost": "entity"},
    }));
    assert_eq!(node_named(&g, "entity:Ghost")["kind"], "entity");
    assert_eq!(node_named(&g, "def:Ghost")["kind"], "def");
    assert!(has_edge(&g, "entity:Ghost", "def:Ghost", "registration"));
    // 无 def 文本 → 不递归,也无其他边
    assert_eq!(edges_of(&g).len(), 1);
}

#[test]
fn empty_params_yields_deterministic_empty_graph() {
    let g = graph(json!({}));
    assert_eq!(nodes_of(&g).len(), 0);
    assert_eq!(edges_of(&g).len(), 0);
    assert!(g.get("reverseEdges").unwrap().is_object());
    assert_eq!(g["stats"]["nodeCount"], 0);
}
