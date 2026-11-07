//! `$/kode/messageTable/build` dispatch 与消息编号表核心单测。
//!
//! 覆盖(与 TS tests/messageTable.test.ts 移植对应):
//! - 空 def:21 基元占 1-21,无方法无问题,装载通过;
//! - 方法 utype 自动分配按 Cell→Base→Client 顺序连续编号 + 显式 Utype 占号跳过;
//! - 显式 Utype 重复:引擎 Conflict 报错,第二个方法不添加;
//! - 属性 flags→域位注册 + hasClient 判定 + 缺 Flags/未知 Flags 报错;
//! - 组件槽注册(占属性 utype + entity-component 类型占 DataType utype + 域位派生);
//! - aliasID 分配(hasClient 属性按名升序从 4 起,ClientMethods 从 1 起);
//! - types.xml 用户类型(fixed-dict/array/alias)注册与 utype 占号;
//! - 父类/接口 def 递归并入与缺失报错。

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

/// 走完整 `$/kode/rpc` 链路调 `$/kode/messageTable/build`,返回表 JSON。
fn build(params: Value) -> Value {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/messageTable/build", "params": params}),
        ),
    );
    response_of(&out).clone()
}

/// 便捷:单 def(无 types.xml、无父类/接口)建表。
fn build_single(entity: &str, def_text: &str) -> Value {
    build(json!({
        "entityName": entity,
        "defText": def_text,
        "defs": {},
        "paths": {entity: format!("/defs/entitys/{entity}.def")},
    }))
}

fn methods_of(table: &Value) -> &Vec<Value> {
    table.get("methods").unwrap().as_array().unwrap()
}

fn method_named<'a>(table: &'a Value, name: &str) -> &'a Value {
    methods_of(table)
        .iter()
        .find(|m| m.get("name").and_then(|v| v.as_str()) == Some(name))
        .unwrap_or_else(|| panic!("method {name} not found"))
}

fn properties_of(table: &Value) -> &Vec<Value> {
    table.get("properties").unwrap().as_array().unwrap()
}

fn property_named<'a>(table: &'a Value, name: &str) -> &'a Value {
    properties_of(table)
        .iter()
        .find(|p| p.get("name").and_then(|v| v.as_str()) == Some(name))
        .unwrap_or_else(|| panic!("property {name} not found"))
}

fn issues_of_kind<'a>(table: &'a Value, kind: &str) -> Vec<&'a Value> {
    table
        .get("issues")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i.get("kind").and_then(|v| v.as_str()) == Some(kind))
        .collect()
}

fn types_of(table: &Value) -> &Vec<Value> {
    table.get("types").unwrap().as_array().unwrap()
}

#[test]
fn empty_def_21_primitives_no_issues() {
    let table = build_single("Empty", "<root></root>");
    assert_eq!(table.get("module").unwrap(), "Empty");
    assert_eq!(methods_of(&table).len(), 0);
    assert_eq!(
        table
            .get("clientMethods")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        table
            .get("clientProperties")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(table.get("issues").unwrap().as_array().unwrap().len(), 0);
    assert_eq!(table.get("loadFailed").unwrap(), false);
    assert_eq!(table.get("fatalCount").unwrap(), 0);
    assert_eq!(table.get("aliasIdEnabled").unwrap(), false);
    assert!(table.get("generatedAt").unwrap().is_string());

    let types = types_of(&table);
    assert_eq!(types.len(), 21);
    assert_eq!(types[0]["name"], "UINT8");
    assert_eq!(types[0]["utype"], 1);
    assert_eq!(types[0]["kind"], "primitive");
    assert_eq!(types[2]["utype"], 3);
    assert_eq!(types[9]["utype"], 10);
    assert_eq!(types[16]["utype"], 17);
    assert_eq!(types[20]["utype"], 21);
    assert!(types[20].get("aliasedTo").unwrap().is_null());
}

#[test]
fn method_utype_auto_assign_cell_base_client_order() {
    let def = "<root>\
      <CellMethods>\
        <onTick></onTick>\
        <onMove><Exposed/></onMove>\
      </CellMethods>\
      <BaseMethods>\
        <reqQuest><Exposed/></reqQuest>\
        <save></save>\
      </BaseMethods>\
      <ClientMethods>\
        <onUpdate></onUpdate>\
      </ClientMethods>\
    </root>";
    let table = build_single("E", def);
    assert_eq!(method_named(&table, "onTick")["utype"], 1);
    assert_eq!(method_named(&table, "onMove")["utype"], 2);
    assert_eq!(method_named(&table, "reqQuest")["utype"], 3);
    assert_eq!(method_named(&table, "save")["utype"], 4);
    assert_eq!(method_named(&table, "onUpdate")["utype"], 5);

    // 客户端可见子集与方向标记
    let client_names: Vec<&str> = table
        .get("clientMethods")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    let mut sorted = client_names.clone();
    sorted.sort();
    assert_eq!(sorted, vec!["onMove", "onUpdate", "reqQuest"]);
    assert_eq!(
        method_named(&table, "onTick")["direction"],
        "server-internal"
    );
    assert_eq!(method_named(&table, "onTick")["visibleToClient"], false);
    assert_eq!(
        method_named(&table, "onMove")["direction"],
        "client-to-server"
    );
    assert_eq!(
        method_named(&table, "onUpdate")["direction"],
        "server-to-client"
    );
    assert_eq!(method_named(&table, "onMove")["visibleToClient"], true);
}

#[test]
fn explicit_utype_conflict_second_not_added() {
    let def = "<root>\
      <CellMethods>\
        <m1><Utype>5</Utype></m1>\
        <m2><Utype>5</Utype></m2>\
        <m3></m3>\
      </CellMethods>\
    </root>";
    let table = build_single("E", def);
    let conflicts = issues_of_kind(&table, "utype-conflict");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(
        conflicts[0]["message"],
        "EntityDef::loadDefCellMethods: E.m2, 'Utype' 5 Conflict(E.m1 'Utype' 5)!"
    );
    assert_eq!(conflicts[0]["fatal"], true);
    let m2 = method_named(&table, "m2");
    assert_eq!(m2["status"], "utype-conflict");
    assert!(m2.get("utype").unwrap().is_null());
    assert_eq!(table.get("loadFailed").unwrap(), true);
    assert_eq!(table.get("fatalCount").unwrap(), 1);
    // 冲突方法不占新号,后续自动分配从最小未占用继续
    assert_eq!(method_named(&table, "m3")["utype"], 1);
}

#[test]
fn property_flags_domain_registration_and_has_client() {
    let def = "<root>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>CELL_PUBLIC_AND_OWN</Flags></hp>\
        <name><Type>STRING</Type><Flags>BASE</Flags></name>\
        <home><Type>VECTOR3</Type><Flags>BASE_AND_CLIENT</Flags></home>\
        <loot><Type>ARRAY<of>UINT8</of></Type><Flags>OWN_CLIENT</Flags></loot>\
      </Properties>\
    </root>";
    let table = build_single("E", def);
    let hp = property_named(&table, "hp");
    assert_eq!(hp["flags"], "CELL_PUBLIC_AND_OWN");
    // CELL_PUBLIC_AND_OWN=0x08 落在 ENTITY_CLIENT_DATA_FLAGS(含 0x08)→ 客户端可见
    assert_eq!(hp["hasClient"], true);
    assert_eq!(hp["typeName"], "UINT32");
    let name = property_named(&table, "name");
    assert_eq!(name["hasClient"], false);
    let home = property_named(&table, "home");
    assert_eq!(home["hasClient"], true);
    let loot = property_named(&table, "loot");
    assert_eq!(loot["hasClient"], true);
    assert_eq!(loot["typeName"], "ARRAY");
    // 属性 utype 独立空间,从 1 起
    assert_eq!(hp["utype"], 1);
    assert_eq!(name["utype"], 2);
    assert_eq!(home["utype"], 3);
    assert_eq!(loot["utype"], 4);
}

#[test]
fn property_flags_missing_and_unknown_report_errors() {
    let def = "<root>\
      <Properties>\
        <bad1><Type>UINT32</Type></bad1>\
        <bad2><Type>UINT32</Type><Flags>NOPE</Flags></bad2>\
        <good><Type>UINT32</Type><Flags>BASE</Flags></good>\
      </Properties>\
    </root>";
    let table = build_single("E", def);
    assert_eq!(issues_of_kind(&table, "property-flags-missing").len(), 1);
    assert_eq!(issues_of_kind(&table, "property-flags-unknown").len(), 1);
    assert_eq!(table.get("loadFailed").unwrap(), true);
    // good 仍正常注册
    assert_eq!(property_named(&table, "good")["utype"], 1);
}

#[test]
fn component_slot_registers_property_and_component_type() {
    let def = "<root>\
      <Components>\
        <healthPack><Type>HealthComp</Type></healthPack>\
      </Components>\
    </root>";
    let table = build_single("E", def);
    let slot = property_named(&table, "healthPack");
    assert_eq!(slot["typeName"], "HealthComp");
    assert_eq!(slot["hasClient"], true);
    assert_eq!(slot["utype"], 1);
    // entity-component 类型占一个 DataType utype
    let comp_type = types_of(&table)
        .iter()
        .find(|t| t["name"] == "HealthComp")
        .expect("component type present");
    assert_eq!(comp_type["kind"], "entity-component");
    assert_eq!(comp_type["utype"], 22);
}

// ---------------------------------------------------------------------------
// IDE-RUST-006 组件语义:槽域 flags 派生 + 组件 def 递归 + Persistent 透出
// ---------------------------------------------------------------------------

/// 组件 def 提供时槽 flags/hasClient 由组件模块域位派生(引擎 L793-808)。
/// 组件 HealthComp:hp(CELL_PUBLIC_AND_OWN→cell+client)、name(BASE→base)、
/// BaseMethods req Exposed、ClientMethods onX → 三域齐 → 派生串 + hasClient。
#[test]
fn component_slot_flags_derived_from_component_def() {
    let comp = "<root>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>CELL_PUBLIC_AND_OWN</Flags></hp>\
        <name><Type>STRING</Type><Flags>BASE</Flags></name>\
      </Properties>\
      <BaseMethods>\
        <req><Exposed/></req>\
      </BaseMethods>\
      <ClientMethods>\
        <onX></onX>\
      </ClientMethods>\
    </root>";
    let def = "<root>\
      <Components>\
        <healthPack><Type>HealthComp</Type></healthPack>\
      </Components>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {"HealthComp": comp},
        "paths": {
            "E": "/defs/entitys/E.def",
            "HealthComp": "/defs/components/HealthComp.def",
        },
    }));
    let slot = property_named(&table, "healthPack");
    assert_eq!(
        slot["flags"],
        "BASE|CELL_PUBLIC|BASE_AND_CLIENT|ENTITY_CLIENT_DATA_FLAGS"
    );
    assert_eq!(slot["hasClient"], true);
    // 客户端可见 → 入 clientProperties
    assert_eq!(
        table
            .get("clientProperties")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// 纯 cell 组件(CELL_PRIVATE 仅 cell 域):派生 CELL_PUBLIC,无客户端可见。
#[test]
fn component_slot_flags_cell_only_no_client() {
    let comp = "<root>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>CELL_PRIVATE</Flags></hp>\
      </Properties>\
    </root>";
    let def = "<root>\
      <Components>\
        <healthPack><Type>HealthComp</Type></healthPack>\
      </Components>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {"HealthComp": comp},
        "paths": {
            "E": "/defs/entitys/E.def",
            "HealthComp": "/defs/components/HealthComp.def",
        },
    }));
    let slot = property_named(&table, "healthPack");
    assert_eq!(slot["flags"], "CELL_PUBLIC");
    assert_eq!(slot["hasClient"], false);
    // 无客户端可见 → 不入 clientProperties
    assert_eq!(
        table
            .get("clientProperties")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

/// 缺失组件 def:报 component-def-missing 且回落硬编码三域(既有行为)。
#[test]
fn component_slot_missing_def_reports_issue_and_falls_back() {
    let def = "<root>\
      <Components>\
        <healthPack><Type>HealthComp</Type></healthPack>\
      </Components>\
    </root>";
    let table = build_single("E", def);
    assert_eq!(issues_of_kind(&table, "component-def-missing").len(), 1);
    let slot = property_named(&table, "healthPack");
    assert_eq!(slot["flags"], "BASE|CELL_PUBLIC|ENTITY_CLIENT_DATA_FLAGS");
    assert_eq!(slot["hasClient"], true);
}

/// 槽 Persistent 透出:false 显式、缺省默认 true(引擎 L689)。
#[test]
fn component_slot_persistent_surfaced() {
    let comp = "<root>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>BASE</Flags></hp>\
      </Properties>\
    </root>";
    let def = "<root>\
      <Components>\
        <nonPersist><Type>HealthComp</Type><Persistent>false</Persistent></nonPersist>\
        <defaultPersist><Type>HealthComp</Type></defaultPersist>\
      </Components>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {"HealthComp": comp},
        "paths": {
            "E": "/defs/entitys/E.def",
            "HealthComp": "/defs/components/HealthComp.def",
        },
    }));
    assert_eq!(property_named(&table, "nonPersist")["persistent"], false);
    assert_eq!(property_named(&table, "defaultPersist")["persistent"], true);
}

/// 槽显式 Utype 撞普通属性 utype(域位相交):报 utype-conflict,槽 utype 空。
#[test]
fn component_slot_utype_conflicts_with_property() {
    let comp = "<root>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>\
      </Properties>\
    </root>";
    let def = "<root>\
      <Properties>\
        <foo><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags><Utype>5</Utype></foo>\
      </Properties>\
      <Components>\
        <healthPack><Type>HealthComp</Type><Utype>5</Utype></healthPack>\
      </Components>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {"HealthComp": comp},
        "paths": {
            "E": "/defs/entitys/E.def",
            "HealthComp": "/defs/components/HealthComp.def",
        },
    }));
    let conflicts = issues_of_kind(&table, "utype-conflict");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(
        conflicts[0]["message"],
        "EntityDef::calcDefPropertyUType: E.healthPack, 'Utype' 5 Conflict(E.foo 'Utype' 5)!"
    );
    assert!(property_named(&table, "healthPack")
        .get("utype")
        .unwrap()
        .is_null());
}

/// 组件 def 自身 Parent/Interfaces 递归:父属性 base 域 + 接口 ClientMethods
/// client 域并入组件模块 hasX,驱动槽 flags。
#[test]
fn component_def_parent_interface_recursion() {
    let comp = "<root>\
      <Parent><CompParent/></Parent>\
      <Interfaces>\
        <interface>IComp</interface>\
      </Interfaces>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>\
      </Properties>\
    </root>";
    let comp_parent = "<root>\
      <Properties>\
        <name><Type>STRING</Type><Flags>BASE</Flags></name>\
      </Properties>\
    </root>";
    let comp_iface = "<root>\
      <ClientMethods>\
        <onChange></onChange>\
      </ClientMethods>\
    </root>";
    let def = "<root>\
      <Components>\
        <healthPack><Type>HealthComp</Type></healthPack>\
      </Components>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {
            "HealthComp": comp,
            "CompParent": comp_parent,
            "IComp": comp_iface,
        },
        "paths": {
            "E": "/defs/entitys/E.def",
            "HealthComp": "/defs/components/HealthComp.def",
            "CompParent": "/defs/components/CompParent.def",
            "IComp": "/defs/interfaces/IComp.def",
        },
    }));
    let slot = property_named(&table, "healthPack");
    assert_eq!(
        slot["flags"],
        "BASE|CELL_PUBLIC|BASE_AND_CLIENT|ENTITY_CLIENT_DATA_FLAGS"
    );
    assert_eq!(slot["hasClient"], true);
}

#[test]
fn alias_ids_assigned_when_enabled() {
    let def = "<root>\
      <Properties>\
        <zeta><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></zeta>\
        <alpha><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></alpha>\
      </Properties>\
      <ClientMethods>\
        <onZ></onZ>\
        <onA></onA>\
      </ClientMethods>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {},
        "paths": {"E": "/defs/entitys/E.def"},
        "aliasIdEnabled": true,
    }));
    // hasClient 属性按名升序从 4 起:alpha=4, zeta=5
    assert_eq!(property_named(&table, "alpha")["aliasID"], 4);
    assert_eq!(property_named(&table, "zeta")["aliasID"], 5);
    // ClientMethods 按名升序从 1 起
    assert_eq!(method_named(&table, "onA")["aliasID"], 1);
    assert_eq!(method_named(&table, "onZ")["aliasID"], 2);
}

#[test]
fn alias_ids_disabled_are_null() {
    let def = "<root>\
      <Properties>\
        <p><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></p>\
      </Properties>\
    </root>";
    let table = build_single("E", def);
    assert!(property_named(&table, "p")
        .get("aliasID")
        .unwrap()
        .is_null());
}

#[test]
fn types_xml_registers_user_types() {
    let types_xml = r#"<root>
      <AvatarProps>
        <FIXED_DICT>
          <Properties>
            <hp><Type>UINT32</Type></hp>
          </Properties>
        </FIXED_DICT>
      </AvatarProps>
      <Money>UINT32</Money>
      <ItemList>
        <ARRAY><of>UINT8</of></ARRAY>
      </ItemList>
    </root>"#;
    let def = "<root>\
      <Properties>\
        <bag><Type>AvatarProps</Type><Flags>BASE_AND_CLIENT</Flags></bag>\
      </Properties>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "typesXml": types_xml,
        "defs": {},
        "paths": {"E": "/defs/entitys/E.def"},
    }));
    let types = types_of(&table);
    // 21 基元 + AvatarProps(22) + Money(别名共享 UINT32) + ItemList(23)
    let avatar_props = types.iter().find(|t| t["name"] == "AvatarProps").unwrap();
    assert_eq!(avatar_props["kind"], "fixed-dict");
    assert_eq!(avatar_props["utype"], 22);
    let money = types.iter().find(|t| t["name"] == "Money").unwrap();
    assert_eq!(money["kind"], "alias");
    assert_eq!(money["aliasedTo"], "UINT32");
    assert_eq!(money["utype"], 4);
    let item_list = types.iter().find(|t| t["name"] == "ItemList").unwrap();
    assert_eq!(item_list["kind"], "array");
    assert_eq!(item_list["utype"], 23);
    // 属性用 user type 正常注册
    assert_eq!(property_named(&table, "bag")["utype"], 1);
}

#[test]
fn parent_and_interface_defs_merge_recursively() {
    let parent = "<root>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>\
      </Properties>\
    </root>";
    let interface = "<root>\
      <BaseMethods>\
        <onTeleport><Exposed/></onTeleport>\
      </BaseMethods>\
    </root>";
    let child = "<root>\
      <Parent><Entity/></Parent>\
      <Interfaces>\
        <interface>ICombat</interface>\
      </Interfaces>\
      <Properties>\
        <name><Type>STRING</Type><Flags>BASE</Flags></name>\
      </Properties>\
    </root>";
    let table = build(json!({
        "entityName": "Child",
        "defText": child,
        "defs": {
            "Entity": parent,
            "ICombat": interface,
        },
        "paths": {
            "Child": "/defs/entitys/Child.def",
            "Entity": "/defs/entitys/Entity.def",
            "ICombat": "/defs/interfaces/ICombat.def",
        },
    }));
    // 装配序:每模块先属性后方法,own → interface → parent(与 TS 一致)。
    // own 属性 name 先占 1;父类属性 hp 后占 2;接口方法 onTeleport 为方法首号 1。
    assert_eq!(property_named(&table, "name")["utype"], 1);
    assert_eq!(property_named(&table, "hp")["utype"], 2);
    // 接口方法并入
    assert_eq!(method_named(&table, "onTeleport")["utype"], 1);
    // 装配序:own → interface → parent
    let sources = table.get("sources").unwrap().as_array().unwrap();
    assert_eq!(sources.len(), 3);
    assert_eq!(sources[0]["name"], "Child");
    assert_eq!(sources[0]["kind"], "own");
    assert_eq!(sources[1]["name"], "ICombat");
    assert_eq!(sources[1]["kind"], "interface");
    assert_eq!(sources[2]["name"], "Entity");
    assert_eq!(sources[2]["kind"], "parent");
}

#[test]
fn missing_parent_reports_file_missing() {
    let child = "<root>\
      <Parent><Missing/></Parent>\
    </root>";
    let table = build(json!({
        "entityName": "Child",
        "defText": child,
        "defs": {},
        "paths": {"Child": "/defs/entitys/Child.def"},
    }));
    let missing = issues_of_kind(&table, "parent-file-missing");
    assert_eq!(missing.len(), 1);
    assert_eq!(
        missing[0]["message"],
        "EntityDef::loadDefInfo: failed to load entity:Missing parentClass."
    );
    assert_eq!(missing[0]["fatal"], true);
}

#[test]
fn empty_def_text_builds_empty_table() {
    // TS parseLocalDefinition('') 无根节点 → 非 null 空语义 → 空表(21 基元)。
    let table = build(json!({
        "entityName": "Ghost",
        "defText": "",
        "defs": {},
        "paths": {},
    }));
    assert_eq!(table.get("module").unwrap(), "Ghost");
    assert_eq!(types_of(&table).len(), 21);
    assert_eq!(methods_of(&table).len(), 0);
    assert_eq!(table.get("issues").unwrap().as_array().unwrap().len(), 0);
    assert_eq!(table.get("loadFailed").unwrap(), false);
}

#[test]
fn missing_def_text_is_param_error() {
    // 契约:defText 缺失 → 参数校验错误(非 null result);TS 侧缺文件在调
    // Rust 前已由 loadDef 返回 null 短路,此错误仅防御性。
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/messageTable/build", "params": {"entityName": "Ghost"}}),
        ),
    );
    match &out[0] {
        Outgoing::Response(response) => assert!(
            response.error.is_some(),
            "expected error response for missing defText"
        ),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

// ---------------------------------------------------------------------------
// 方法实参链(parse_method_arg / parse_array_of_type)+ 方法名冲突三臂
// ---------------------------------------------------------------------------

/// 合法实参渲染 + ARRAY inline 类型注册 + 嵌套 ARRAY(of-of 递归)。
#[test]
fn method_args_render_and_inline_array_types() {
    let def = "<root>\
      <CellMethods>\
        <plain><Arg>UINT32</Arg></plain>\
        <list><Arg>ARRAY<of>UINT32</of></Arg></list>\
        <nested><Arg>ARRAY<of>ARRAY<of>UINT8</of></of></Arg></nested>\
      </CellMethods>\
    </root>";
    let table = build_single("E", def);
    let plain = method_named(&table, "plain");
    assert_eq!(plain["status"], "ok");
    assert_eq!(plain["args"].as_array().unwrap().len(), 1);
    assert_eq!(plain["args"][0]["name"], "UINT32");
    assert_eq!(plain["args"][0]["utype"], 4);
    assert!(plain["args"][0].get("ofType").unwrap().is_null());

    // ARRAY 实参:inline 类型 E_m 占基元后首号 22,实参 utype 同号
    let list = method_named(&table, "list");
    assert_eq!(list["args"][0]["name"], "ARRAY");
    assert_eq!(list["args"][0]["utype"], 22);
    let list_elem = &list["args"][0]["ofType"];
    assert_eq!(list_elem["name"], "UINT32");
    assert_eq!(list_elem["utype"], 4);
    let list_type = types_of(&table)
        .iter()
        .find(|t| t["name"] == "E_list")
        .expect("inline array type");
    assert_eq!(list_type["kind"], "inline-array");
    assert_eq!(list_type["utype"], 22);

    // 嵌套 ARRAY:外层 E_nested 占 23,子层 _E_nested_ArrayType 占 24
    let nested = method_named(&table, "nested");
    assert_eq!(nested["args"][0]["name"], "ARRAY");
    assert_eq!(nested["args"][0]["utype"], 23);
    let nested_elem = &nested["args"][0]["ofType"];
    assert_eq!(nested_elem["name"], "ARRAY");
    assert_eq!(nested_elem["utype"], 24);
    assert_eq!(nested_elem["ofType"]["name"], "UINT8");
    let child_type = types_of(&table)
        .iter()
        .find(|t| t["name"] == "_E_nested_ArrayType")
        .expect("nested inline array type");
    assert_eq!(child_type["utype"], 24);
}

/// 实参类型未注册 → unknown-arg-type + 方法 arg-load-failed(不分配 utype)。
#[test]
fn method_unknown_arg_type_fails_arg_load() {
    let def = "<root>\
      <CellMethods>\
        <bad><Arg>NOPE</Arg></bad>\
        <good></good>\
      </CellMethods>\
    </root>";
    let table = build_single("E", def);
    let unknowns = issues_of_kind(&table, "unknown-arg-type");
    assert_eq!(unknowns.len(), 1);
    assert_eq!(
        unknowns[0]["message"],
        "EntityDef::loadDefCellMethods: dataType[NOPE] not found, in bad!"
    );
    let bad = method_named(&table, "bad");
    assert_eq!(bad["status"], "arg-load-failed");
    assert_eq!(bad["args"][0]["utype"], serde_json::Value::Null);
    assert!(bad.get("utype").unwrap().is_null(), "arg 失败不分配 utype");
    // good 不受影响,吃掉首号
    assert_eq!(method_named(&table, "good")["utype"], 1);
}

/// ARRAY 实参畸形:缺 of / of 未知 / of 空 / 元素形态 Arg(直接文本空被跳过)。
#[test]
fn method_array_arg_malformed_branches() {
    let def = "<root>\
      <CellMethods>\
        <noOf><Arg>ARRAY</Arg></noOf>\
        <badOf><Arg>ARRAY<of>NOPE</of></Arg></badOf>\
        <emptyOf><Arg>ARRAY<of></of></Arg></emptyOf>\
        <nestedNoOf><Arg>ARRAY<of>ARRAY</of></Arg></nestedNoOf>\
        <elemForm><Arg><ARRAY><of>UINT32</of></ARRAY></Arg></elemForm>\
      </CellMethods>\
    </root>";
    let table = build_single("E", def);
    // 缺 of:array-of-missing + unknown-arg-type(ARRAY)
    assert_eq!(issues_of_kind(&table, "array-of-missing").len(), 2);
    let unknowns = issues_of_kind(&table, "unknown-arg-type");
    // noOf/badOf/emptyOf/nestedNoOf 各 1(元素形态直接文本空被跳过不产实参)
    assert_eq!(unknowns.len(), 4);
    // of 未知:array-of-unknown-type(空 of 同臂,of_name="")
    assert_eq!(issues_of_kind(&table, "array-of-unknown-type").len(), 2);
    // 嵌套 ARRAY 无 of:inline 子类型已注册但初始化失败
    assert_eq!(issues_of_kind(&table, "array-init-failed").len(), 1);
    for name in ["noOf", "badOf", "emptyOf", "nestedNoOf"] {
        assert_eq!(
            method_named(&table, name)["status"],
            "arg-load-failed",
            "{name}"
        );
    }
    // 元素形态 `<Arg><ARRAY/></Arg>`:TS parseArgType 直接文本空 → 无实参
    let elem = method_named(&table, "elemForm");
    assert_eq!(elem["args"].as_array().unwrap().len(), 0);
    assert_eq!(elem["status"], "ok");
}

/// 方法名冲突三臂:撞属性名 / 撞组件名 / 段内重名。
#[test]
fn method_name_conflict_arms() {
    // 撞属性名:同模块属性先装载,后装载同名方法触发
    let table = build_single(
        "E",
        "<root>\
      <Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties>\
      <CellMethods><hp></hp></CellMethods>\
    </root>",
    );
    let conflicts = issues_of_kind(&table, "method-property-name-conflict");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(
        conflicts[0]["message"],
        "ScriptDefModule::addCellMethodDescription: There is a property[hp] name conflict!"
    );
    assert_eq!(method_named(&table, "hp")["status"], "name-conflict");
    assert!(method_named(&table, "hp").get("utype").unwrap().is_null());

    // 段内重名:第二个同名方法触发 method-name-conflict
    let table = build_single(
        "E",
        "<root><CellMethods><m></m><m></m></CellMethods></root>",
    );
    let conflicts = issues_of_kind(&table, "method-name-conflict");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(
        conflicts[0]["message"],
        "ScriptDefModule::addCellMethodDescription: [m] is exist!"
    );
    assert_eq!(method_named(&table, "m")["utype"], 1, "首个 m 正常占号");

    // 撞组件名:槽名先进 component_names 而不入 all_property_names(槽撞自身
    // 方法名被拒),父类方法同名触发 method-component-name-conflict
    let comp = "<root><Properties>\
      <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>\
    </Properties></root>";
    let own = "<root><Parent><P/></Parent>\
      <CellMethods><pack></pack></CellMethods>\
      <Components><pack><Type>Comp</Type></pack></Components>\
    </root>";
    let parent = "<root><CellMethods><pack></pack></CellMethods></root>";
    let table = build(json!({
        "entityName": "E",
        "defText": own,
        "defs": {"Comp": comp, "P": parent},
        "paths": {
            "E": "/defs/entitys/E.def",
            "Comp": "/defs/components/Comp.def",
            "P": "/defs/entitys/P.def",
        },
    }));
    let conflicts = issues_of_kind(&table, "method-component-name-conflict");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(
        conflicts[0]["message"],
        "ScriptDefModule::addCellMethodDescription: There is a component[pack] name conflict!"
    );
    // own 槽 pack 撞方法名 pack(property-method-name-conflict)在父类方法前先发
    assert_eq!(
        issues_of_kind(&table, "property-method-name-conflict").len(),
        1
    );
}

/// 方法 Utype 越界(>65535)与自动计数跳过显式占用号。
#[test]
fn method_utype_overflow_and_auto_skip() {
    let def = "<root>\
      <CellMethods>\
        <over><Utype>70000</Utype></over>\
        <held><Utype>1</Utype></held>\
        <auto></auto>\
      </CellMethods>\
    </root>";
    let table = build_single("E", def);
    let overflows = issues_of_kind(&table, "utype-overflow");
    assert_eq!(overflows.len(), 1);
    assert_eq!(
        overflows[0]["message"],
        "EntityDef::loadDefCellMethods: 'Utype' has overflowed(70000 > 65535), is E.over!"
    );
    assert_eq!(method_named(&table, "over")["status"], "utype-overflow");
    // held 占 1 → auto 跳过 1 落 2
    assert_eq!(method_named(&table, "held")["utype"], 1);
    assert_eq!(method_named(&table, "auto")["utype"], 2);
}

// ---------------------------------------------------------------------------
// types.xml 装载错误分支(load_types_xml)
// ---------------------------------------------------------------------------

/// types.xml 全错误分支:非法 XML / 无根 / `_` 前缀 / 重复别名(fixed-dict、
/// array、plain)/ FIXED_DICT 缺 Properties / ARRAY 缺 of / ARRAY of 未知 /
/// plain 别名目标未知。
#[test]
fn types_xml_error_branches() {
    // 非法 XML(未闭合)→ types-parse-error 单条,不装载
    let table = build(json!({
        "entityName": "E",
        "defText": "<root></root>",
        "typesXml": "<root><Money>",
        "defs": {},
        "paths": {"E": "/defs/entitys/E.def"},
    }));
    let parse_errors = issues_of_kind(&table, "types-parse-error");
    assert_eq!(parse_errors.len(), 1);
    assert_eq!(
        parse_errors[0]["message"],
        "DataTypes::loadTypes: types.xml 解析失败(非法 XML)"
    );

    // 空串(无根)→ 静默返回,无 issue
    let table = build(json!({
        "entityName": "E",
        "defText": "<root></root>",
        "typesXml": "",
        "defs": {},
        "paths": {"E": "/defs/entitys/E.def"},
    }));
    assert_eq!(table.get("issues").unwrap().as_array().unwrap().len(), 0);
    assert_eq!(types_of(&table).len(), 21);

    let types_xml = r#"<root>
      <_bad>UINT32</_bad>
      <Money>UINT32</Money>
      <money>UINT32</money>
      <AvatarProps>
        <FIXED_DICT><Properties><hp><Type>UINT32</Type></hp></Properties></FIXED_DICT>
      </AvatarProps>
      <avatarprops>
        <FIXED_DICT><Properties><hp><Type>UINT32</Type></hp></Properties></FIXED_DICT>
      </avatarprops>
      <ItemList>
        <ARRAY><of>UINT8</of></ARRAY>
      </ItemList>
      <itemlist>
        <ARRAY><of>UINT8</of></ARRAY>
      </itemlist>
      <NoProps>
        <FIXED_DICT><Other>x</Other></FIXED_DICT>
      </NoProps>
      <NoOf>
        <ARRAY><Other>x</Other></ARRAY>
      </NoOf>
      <BadOf>
        <ARRAY><of>MISSING_TYPE</of></ARRAY>
      </BadOf>
      <Ghost>MISSING_TYPE</Ghost>
    </root>"#;
    let table = build(json!({
        "entityName": "E",
        "defText": "<root></root>",
        "typesXml": types_xml,
        "defs": {},
        "paths": {"E": "/defs/entitys/E.def"},
    }));
    // `_` 前缀
    let invalids = issues_of_kind(&table, "invalid-type-alias-name");
    assert_eq!(invalids.len(), 1);
    assert_eq!(
        invalids[0]["message"],
        "DataTypes::loadTypes: Not allowed to use the prefix \"_\"! aliasName=_bad"
    );
    // 大小写不敏感重复别名:fixed-dict / array / plain 各 1
    let dupes = issues_of_kind(&table, "duplicate-type-alias");
    assert_eq!(dupes.len(), 3);
    assert_eq!(dupes[0]["fatal"], false);
    assert_eq!(
        dupes[0]["message"],
        "DataTypes::addDataType(name): name money exist."
    );
    // FIXED_DICT 缺 Properties:两条 types-parse-error;ARRAY 缺 of / of 未知
    // 各再补一条 types-parse-error → 共 4
    let parse_errors = issues_of_kind(&table, "types-parse-error");
    assert_eq!(parse_errors.len(), 4);
    let has = |suffix: &str| {
        parse_errors
            .iter()
            .any(|e| e["message"].as_str().unwrap().contains(suffix))
    };
    assert!(has("not found \"Properties\""), "FixedDict 缺 Properties");
    assert!(has("parse FIXED_DICT [NoProps] error!"), "NoProps 收尾");
    assert!(has("parse ARRAY [NoOf] error!"), "NoOf 收尾");
    assert!(has("parse ARRAY [BadOf] error!"), "BadOf 收尾");
    // ARRAY 缺 of:array-of-missing + types-parse-error
    let no_of = issues_of_kind(&table, "array-of-missing");
    assert_eq!(no_of.len(), 1);
    assert_eq!(
        no_of[0]["message"],
        "FixedArrayType::initialize: not found \"of\"."
    );
    // ARRAY of 未知:array-of-unknown-type + types-parse-error
    let bad_of = issues_of_kind(&table, "array-of-unknown-type");
    assert_eq!(bad_of.len(), 1);
    assert_eq!(
        bad_of[0]["message"],
        "FixedArrayType::initialize: key[ARRAY] did not find type[MISSING_TYPE]!"
    );
    // plain 别名目标未知:unknown-aliased-type
    let ghosts = issues_of_kind(&table, "unknown-aliased-type");
    assert_eq!(ghosts.len(), 1);
    assert_eq!(
        ghosts[0]["message"],
        "DataTypes::loadTypes: can't fount type MISSING_TYPE by alias[Ghost]."
    );
    // 装载失败的别名占号(consume):基元 21 + Money 22 + avatarprops 23 +
    // AvatarProps 24(共享 UINT32 不占)+ itemlist 25 + NoProps 26 + NoOf 27 +
    // BadOf 28;合法 ItemList 29
    let find = |name: &str| {
        types_of(&table)
            .iter()
            .find(|t| t["name"] == name)
            .unwrap_or_else(|| panic!("type {name}"))
            .clone()
    };
    // 别名 Money 共享 UINT32(4);首载 AvatarProps 占 22,后续 consume 顺次占号
    assert_eq!(find("Money")["utype"], 4);
    assert_eq!(find("AvatarProps")["utype"], 22);
    assert_eq!(
        find("avatarprops")["utype"],
        23,
        "重复 fixed-dict consume 占号"
    );
    assert_eq!(find("ItemList")["utype"], 24);
    assert_eq!(find("itemlist")["utype"], 25, "重复 array consume 占号");
    assert_eq!(find("NoProps")["utype"], 26);
    assert_eq!(find("NoOf")["utype"], 27);
    assert_eq!(find("BadOf")["utype"], 28);
}

// ---------------------------------------------------------------------------
// 属性错误分支(simulate_property)+ 名冲突三臂 + Utype 越界/跳号
// ---------------------------------------------------------------------------

/// 保留属性名 / 缺 Type / 空 Type / 未知 Type / 显式 Utype 越界 / Utype 跳号。
#[test]
fn property_error_branches_and_utype_edges() {
    let def = "<root>\
      <Properties>\
        <id><Type>UINT32</Type><Flags>BASE</Flags></id>\
        <noType><Flags>BASE</Flags></noType>\
        <emptyType><Type></Type><Flags>BASE</Flags></emptyType>\
        <badType><Type>NOPE</Type><Flags>BASE</Flags></badType>\
        <over><Type>UINT32</Type><Flags>BASE</Flags><Utype>70000</Utype></over>\
        <held><Type>UINT32</Type><Flags>BASE</Flags><Utype>1</Utype></held>\
        <auto><Type>UINT32</Type><Flags>BASE</Flags></auto>\
      </Properties>\
    </root>";
    let table = build_single("E", def);
    // 保留名:直接 return,无 Flags/Type 后续报错
    let limited = issues_of_kind(&table, "property-name-limited");
    assert_eq!(limited.len(), 1);
    assert_eq!(
        limited[0]["message"],
        "EntityDef::loadDefPropertys: 'id' is limited, in module(E)!"
    );
    assert_eq!(property_named(&table, "id")["flags"], "");
    // 缺 Type
    let missing = issues_of_kind(&table, "property-type-missing");
    assert_eq!(missing.len(), 2, "缺 Type 与空 Type 同臂");
    assert_eq!(
        missing[0]["message"],
        "EntityDef::loadDefPropertys: not fount TypeNode, is E.noType!"
    );
    // 未知 Type
    let unknown = issues_of_kind(&table, "property-type-unknown");
    assert_eq!(unknown.len(), 1);
    // Utype 越界
    let overflows = issues_of_kind(&table, "utype-overflow");
    assert_eq!(overflows.len(), 1);
    assert_eq!(
        overflows[0]["message"],
        "EntityDef::calcDefPropertyUType: 'Utype' has overflowed(70000 > 65535), is E.over!"
    );
    // held 占 1 → auto 跳过落 2
    assert_eq!(property_named(&table, "held")["utype"], 1);
    assert_eq!(property_named(&table, "auto")["utype"], 2);
    // 失败属性不占号
    assert!(property_named(&table, "over")
        .get("utype")
        .unwrap()
        .is_null());
    assert!(property_named(&table, "noType")
        .get("utype")
        .unwrap()
        .is_null());
}

/// 属性名冲突三臂:撞方法名 / 撞组件名 / 域内重名(cell+base+client 三域文案)。
#[test]
fn property_name_conflict_arms() {
    let own = "<root>\
      <Parent><P/></Parent>\
      <Properties>\
        <p><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></p>\
        <q><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></q>\
      </Properties>\
      <CellMethods><ping></ping></CellMethods>\
      <Components><bag><Type>Comp</Type></bag></Components>\
    </root>";
    let comp = "<root><Properties>\
      <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>\
    </Properties></root>";
    let parent = "<P>\
      <Properties>\
        <ping><Type>UINT32</Type><Flags>BASE</Flags></ping>\
        <bag><Type>UINT32</Type><Flags>BASE</Flags></bag>\
        <p><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></p>\
        <q><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></q>\
      </Properties>\
    </P>";
    let table = build(json!({
        "entityName": "E",
        "defText": own,
        "defs": {"Comp": comp, "P": parent},
        "paths": {
            "E": "/defs/entitys/E.def",
            "Comp": "/defs/components/Comp.def",
            "P": "/defs/entitys/P.def",
        },
    }));
    // 撞方法名(own CellMethods ping 先装载)
    let mc = issues_of_kind(&table, "property-method-name-conflict");
    assert_eq!(mc.len(), 2, "addPropertyDescription 失败双条");
    assert_eq!(
        mc[0]["message"],
        "ScriptDefModule::addPropertyDescription: There is a method[ping] name conflict! componentType=6."
    );
    assert_eq!(mc[1]["message"], "EntityDef::addPropertyDescription(E): P.");
    // 撞组件名(own 组件槽 bag 先装载)
    let cc = issues_of_kind(&table, "property-component-name-conflict");
    assert_eq!(cc.len(), 2);
    assert_eq!(
        cc[0]["message"],
        "ScriptDefModule::addPropertyDescription: There is a component[bag] name conflict!"
    );
    // 域内重名:p 撞 cell 域(componentType=5),q 撞 base+client 两域(6/7)
    let nc = issues_of_kind(&table, "property-name-conflict");
    // p: cell 单条 + 收尾; q: base+client 两条 + 收尾 = 5
    assert_eq!(nc.len(), 5);
    assert_eq!(
        nc[0]["message"],
        "ScriptDefModule::addPropertyDescription: [p] is exist! componentType=5."
    );
    assert_eq!(nc[1]["message"], "EntityDef::addPropertyDescription(E): P.");
    assert_eq!(
        nc[2]["message"],
        "ScriptDefModule::addPropertyDescription: [q] is exist! componentType=6."
    );
    assert_eq!(
        nc[3]["message"],
        "ScriptDefModule::addPropertyDescription: [q] is exist! componentType=7."
    );
    assert_eq!(nc[4]["message"], "EntityDef::addPropertyDescription(E): P.");
}

// ---------------------------------------------------------------------------
// 组件槽错误分支(register_component_slot)
// ---------------------------------------------------------------------------

/// 组件槽:保留名 / 撞方法名 / 撞组件名 / 域内重名 / 组件 def 面分析 continue。
#[test]
fn component_slot_name_conflict_arms() {
    let own = "<root>\
      <Properties>\
        <p><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></p>\
      </Properties>\
      <CellMethods><ping></ping></CellMethods>\
      <Components>\
        <id><Type>Comp</Type></id>\
        <ping><Type>Comp</Type></ping>\
        <bag><Type>Comp</Type></bag>\
        <bag><Type>Comp</Type></bag>\
        <p><Type>Comp</Type></p>\
      </Components>\
    </root>";
    // 组件 def:无 Flags 属性(continue)+ 未知 Flags(continue)+
    // CellMethods 暴露与不暴露(has_cell/base_exposed/cell_exposed 全臂)
    let comp = "<root>\
      <Properties>\
        <noflags><Type>UINT32</Type></noflags>\
        <badflags><Type>UINT32</Type><Flags>NOPE</Flags></badflags>\
        <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>\
      </Properties>\
      <CellMethods>\
        <tick></tick>\
        <fire><Exposed/></fire>\
      </CellMethods>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": own,
        "defs": {"Comp": comp},
        "paths": {
            "E": "/defs/entitys/E.def",
            "Comp": "/defs/components/Comp.def",
        },
    }));
    // 保留名
    let limited = issues_of_kind(&table, "property-name-limited");
    assert_eq!(limited.len(), 1);
    assert_eq!(
        limited[0]["message"],
        "EntityDef::loadComponents: 'id' is limited, in module(E)!"
    );
    // 撞方法名(componentType=5 cell 域文案)
    let mc = issues_of_kind(&table, "property-method-name-conflict");
    assert_eq!(mc.len(), 1);
    assert_eq!(
        mc[0]["message"],
        "ScriptDefModule::addPropertyDescription: There is a method[ping] name conflict! componentType=5."
    );
    // 撞组件名(同名槽第二个)
    let cc = issues_of_kind(&table, "property-component-name-conflict");
    assert_eq!(cc.len(), 1);
    assert_eq!(
        cc[0]["message"],
        "ScriptDefModule::addPropertyDescription: There is a component[bag] name conflict!"
    );
    // 域内重名(槽 p 撞属性 p 的 cell 域)
    let nc = issues_of_kind(&table, "property-name-conflict");
    assert_eq!(nc.len(), 1);
    assert_eq!(
        nc[0]["message"],
        "ScriptDefModule::addPropertyDescription: [p] is exist! componentType=5."
    );
    // 槽 utype 在名字检查前分配:p 属性占 1,ping 2,bag 3,重复 bag 4,p 槽 5
    assert_eq!(property_named(&table, "ping")["utype"], 2);
    assert_eq!(property_named(&table, "bag")["utype"], 3);
    let p_entries: Vec<&Value> = properties_of(&table)
        .iter()
        .filter(|p| p["name"] == "p")
        .collect();
    assert_eq!(p_entries.len(), 2, "属性 p 与槽 p 并存");
    assert_eq!(p_entries[0]["utype"], 1, "属性 p 先占 1");
    assert_eq!(p_entries[1]["utype"], 5, "槽 p 名字检查前已分配 5");
}

/// 组件域面分析:接口重复声明(visited 跳过)+ 父类成环(visited 跳过)。
#[test]
fn component_face_visited_guards() {
    let comp = "<root>\
      <Parent><LoopComp/></Parent>\
      <Interfaces>\
        <interface>IDup</interface>\
        <interface>IDup</interface>\
      </Interfaces>\
      <Properties>\
        <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>\
      </Properties>\
    </root>";
    let iface = "<root>\
      <Properties>\
        <mana><Type>UINT32</Type><Flags>BASE</Flags></mana>\
      </Properties>\
    </root>";
    let def = "<root>\
      <Components><pack><Type>LoopComp</Type></pack></Components>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {"LoopComp": comp, "IDup": iface},
        "paths": {
            "E": "/defs/entitys/E.def",
            "LoopComp": "/defs/components/LoopComp.def",
            "IDup": "/defs/interfaces/IDup.def",
        },
    }));
    // visited 守卫截断重复接口与父类环,槽仍注册(自身 cell 域 + 接口 base 域)
    assert_eq!(issues_of_kind(&table, "component-def-missing").len(), 0);
    let slot = property_named(&table, "pack");
    assert_eq!(slot["flags"], "BASE|CELL_PUBLIC");
    assert_eq!(slot["hasClient"], false);
}

/// 组件 def 结构错误 → component-def-missing + 硬编码三域回落(source.rs 分支)。
#[test]
fn component_def_structural_error_falls_back() {
    let def = "<root>\
      <Components><pack><Type>Broken</Type></pack></Components>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {"Broken": "<root><Properties>"},
        "paths": {
            "E": "/defs/entitys/E.def",
            "Broken": "/defs/components/Broken.def",
        },
    }));
    let missing = issues_of_kind(&table, "component-def-missing");
    assert_eq!(missing.len(), 1);
    assert_eq!(
        missing[0]["message"],
        "EntityDef::loadComponents: failed to load component:Broken (components/Broken.def)."
    );
    assert_eq!(
        property_named(&table, "pack")["flags"],
        "BASE|CELL_PUBLIC|ENTITY_CLIENT_DATA_FLAGS"
    );
}

// ---------------------------------------------------------------------------
// 装配流程分支:own 结构错误 → null;父类环;接口缺失;结构错误四码
// ---------------------------------------------------------------------------

/// own def 结构错误 → loadDef 抛错同路,返回 null(不产表)。
#[test]
fn own_def_structural_error_returns_null() {
    // 四种结构错误码:未闭合 / 闭合不匹配 / 游离闭合 / 非法标签名
    for (label, broken) in [
        ("unclosed", "<root><Properties>"),
        ("mismatched", "<root><a></b></root>"),
        ("stray", "<root><a></a></root></x>"),
        ("invalid-tag", "<root><1a></1a></root>"),
    ] {
        let table = build(json!({
            "entityName": "E",
            "defText": broken,
            "defs": {},
            "paths": {"E": "/defs/entitys/E.def"},
        }));
        assert!(table.is_null(), "{label} 应返回 null");
    }
}

/// 父类链成环:visited 守卫截断,parent-cycle 单条 fatal。
#[test]
fn parent_cycle_reports_and_truncates() {
    let a = "<root><Parent><B/></Parent>\
      <Properties><pa><Type>UINT32</Type><Flags>BASE</Flags></pa></Properties></root>";
    let b = "<root><Parent><A/></Parent>\
      <Properties><pb><Type>UINT32</Type><Flags>BASE</Flags></pb></Properties></root>";
    let table = build(json!({
        "entityName": "A",
        "defText": a,
        "defs": {"B": b},
        "paths": {
            "A": "/defs/entitys/A.def",
            "B": "/defs/entitys/B.def",
        },
    }));
    let cycles = issues_of_kind(&table, "parent-cycle");
    assert_eq!(cycles.len(), 1);
    assert_eq!(cycles[0]["fatal"], true);
    assert_eq!(
        cycles[0]["message"],
        "父类链成环:A 装载中重入 A(引擎递归装载无法终止,kode 截断该分支)"
    );
    assert_eq!(property_named(&table, "pa")["utype"], 1);
    assert_eq!(property_named(&table, "pb")["utype"], 2);
}

/// 接口缺失:interface-file-missing fatal(组件槽/父类照常续行)。
#[test]
fn interface_missing_reports_issue() {
    let def = "<root>\
      <Interfaces><interface>Missing</interface></Interfaces>\
      <Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties>\
    </root>";
    let table = build_single("E", def);
    let missing = issues_of_kind(&table, "interface-file-missing");
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0]["fatal"], true);
    assert_eq!(
        missing[0]["message"],
        "EntityDef::loadDefInfo: failed to load entity:Missing interface."
    );
    assert_eq!(property_named(&table, "hp")["utype"], 1);
}

/// 接口元素形态声明(`<Interface><I/></Interface>`)取子元素标签名为接口名。
#[test]
fn interface_element_form_name_fallback() {
    let iface = "<root>\
      <BaseMethods><onTeleport><Exposed/></onTeleport></BaseMethods>\
    </root>";
    let def = "<root>\
      <Interfaces><Interface><ITeleport/></Interface></Interfaces>\
    </root>";
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {"ITeleport": iface},
        "paths": {
            "E": "/defs/entitys/E.def",
            "ITeleport": "/defs/interfaces/ITeleport.def",
        },
    }));
    assert_eq!(method_named(&table, "onTeleport")["utype"], 1);
    let sources = table.get("sources").unwrap().as_array().unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[1]["name"], "ITeleport");
    assert_eq!(sources[1]["kind"], "interface");
}

// ---------------------------------------------------------------------------
// aliasID 上界回退(-1)
// ---------------------------------------------------------------------------

/// 客户端可见属性/方法超 255 → 全部 aliasID 回退 -1(引擎 aliasID 关闭同效)。
#[test]
fn alias_id_overflow_resets_to_minus_one() {
    let mut props = String::new();
    let mut methods = String::new();
    for i in 0..260 {
        props.push_str(&format!(
            "<p{i}><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></p{i}>"
        ));
        methods.push_str(&format!("<m{i}></m{i}>"));
    }
    let def = format!(
        "<root><Properties>{props}</Properties><ClientMethods>{methods}</ClientMethods></root>"
    );
    let table = build(json!({
        "entityName": "E",
        "defText": def,
        "defs": {},
        "paths": {"E": "/defs/entitys/E.def"},
        "aliasIdEnabled": true,
    }));
    // 260 个客户端可见属性:4..263 越界 → 全部 -1
    assert_eq!(property_named(&table, "p0")["aliasID"], -1);
    assert_eq!(property_named(&table, "p259")["aliasID"], -1);
    // 260 个 ClientMethods:1..260 越界 → 全部 -1
    assert_eq!(method_named(&table, "m0")["aliasID"], -1);
    assert_eq!(method_named(&table, "m259")["aliasID"], -1);
}
