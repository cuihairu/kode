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
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));
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
    assert_eq!(table.get("clientMethods").unwrap().as_array().unwrap().len(), 0);
    assert_eq!(table.get("clientProperties").unwrap().as_array().unwrap().len(), 0);
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
    assert_eq!(method_named(&table, "onTick")["direction"], "server-internal");
    assert_eq!(method_named(&table, "onTick")["visibleToClient"], false);
    assert_eq!(method_named(&table, "onMove")["direction"], "client-to-server");
    assert_eq!(method_named(&table, "onUpdate")["direction"], "server-to-client");
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
    assert!(property_named(&table, "p").get("aliasID").unwrap().is_null());
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
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));
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
