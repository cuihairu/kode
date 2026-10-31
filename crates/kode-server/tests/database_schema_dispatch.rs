//! `$/kode/databaseSchema/build` 派发与 MySQL 表/列推导核心单测。
//!
//! 覆盖(IDE-RUST-008):
//! - 根表名 = tablePrefix+entityName,固定 id/sm_autoLoad,hasCell 时 position/direction 六列;
//! - 叶子列名 expandColumnNames(VECTOR3 → sm_N_name)、类型标签 resolveDbTypeLabel、
//!   STRING 未声明/≤0 的 DatabaseLength 落默认 255;
//! - ARRAY → 子表(元素列落子表顶层)、ENTITY_COMPONENT → 子表(无 cell 且无 base 域跳过)、
//!   FIXED_DICT → 前缀列不建子表、ENTITYCALL 不落列;
//! - tableIndex 对象、空属性集、畸形入参报错。

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

/// 走完整 `$/kode/rpc` 链路调 `$/kode/databaseSchema/build`,返回推导结果 JSON。
fn build(params: Value) -> Value {
    let mut state = ServerState::new();
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/databaseSchema/build", "params": params}),
        ),
    );
    response_of(&out).clone()
}

fn src(path: &str) -> Value {
    json!({
        "filePath": "/defs/entitys/Gold.def",
        "line": 3,
        "path": path,
        "category": "entity"
    })
}

fn prop(name: &str, type_name: &str) -> Value {
    json!({
        "name": name,
        "typeName": type_name,
        "persistent": true,
        "identifier": false,
        "scopes": ["base"],
        "source": src("Gold")
    })
}

fn full_params() -> Value {
    json!({
        "entityName": "Gold",
        "defFilePath": "/defs/entitys/Gold.def",
        "tablePrefix": "tbl_",
        "hasCellContent": true,
        "properties": [
            prop("gold", "UINT32"),
            json!({
                "name": "uid", "typeName": "INT64", "persistent": true,
                "identifier": true, "indexType": "UNIQUE",
                "flags": "BASE", "scopes": ["base"], "source": src("Gold"),
                "databaseLength": 64, "defaultValue": "0"
            }),
            json!({
                "name": "title", "typeName": "STRING", "persistent": true,
                "identifier": false, "scopes": ["base"], "source": src("Gold"),
                "databaseLength": 128
            }),
            json!({
                "name": "desc", "typeName": "STRING", "persistent": true,
                "identifier": false, "scopes": ["base"], "source": src("Gold")
            }),
            prop("pos", "VECTOR3"),
            json!({
                "name": "scores", "typeName": "ARRAY", "persistent": true,
                "identifier": false, "scopes": ["base"], "source": src("Gold"),
                "arrayElement": json!({
                    "name": "value", "typeName": "FLOAT", "persistent": true,
                    "identifier": false, "scopes": ["base"], "source": src("Gold.scores[]")
                })
            }),
            json!({
                "name": "weapon", "typeName": "ENTITY_COMPONENT", "persistent": true,
                "identifier": false, "scopes": ["base"], "source": src("Gold"),
                "children": [ json!({
                    "name": "ammo", "typeName": "UINT32", "persistent": true,
                    "identifier": false, "scopes": ["base"], "source": src("Gold.weapon.ammo")
                }) ]
            }),
            json!({
                "name": "hiddenComp", "typeName": "ENTITY_COMPONENT", "persistent": true,
                "identifier": false, "scopes": [], "source": src("Gold"),
                "children": [ json!({
                    "name": "x", "typeName": "INT32", "persistent": true,
                    "identifier": false, "scopes": [], "source": src("Gold.hiddenComp.x")
                }) ]
            }),
            json!({
                "name": "dict", "typeName": "FIXED_DICT", "persistent": true,
                "identifier": false, "scopes": ["base"], "source": src("Gold"),
                "children": [
                    json!({
                        "name": "a", "typeName": "FLOAT", "persistent": true,
                        "identifier": false, "scopes": ["base"], "source": src("Gold.dict.a")
                    }),
                    json!({
                        "name": "b", "typeName": "INT32", "persistent": true,
                        "identifier": false, "scopes": ["base"], "source": src("Gold.dict.b")
                    })
                ]
            }),
            prop("call", "ENTITYCALL"),
        ]
    })
}

fn tables_of(result: &Value) -> &Vec<Value> {
    result.get("tables").unwrap().as_array().unwrap()
}

fn table_named<'a>(result: &'a Value, name: &str) -> &'a Value {
    tables_of(result)
        .iter()
        .find(|t| t.get("name").and_then(|v| v.as_str()) == Some(name))
        .unwrap_or_else(|| panic!("table {name} not found"))
}

fn field_names(table: &Value) -> Vec<&str> {
    table
        .get("fields")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.get("name").and_then(|v| v.as_str()).unwrap())
        .collect()
}

#[test]
fn full_fixture_builds_root_and_child_tables() {
    let result = build(full_params());
    let root = table_named(&result, "tbl_Gold");

    assert_eq!(root.get("kind").and_then(|v| v.as_str()), Some("entity"));
    assert_eq!(root.get("title").and_then(|v| v.as_str()), Some("Gold"));
    assert_eq!(root.get("propertyPath").and_then(|v| v.as_str()), Some("Gold"));
    assert_eq!(root.get("source").unwrap().get("line"), Some(&json!(1)));

    // 根表列:固定 id/sm_autoLoad + hasCell 六列 + 属性列(标量/向量/FD 前缀列)。
    let names = field_names(root);
    assert_eq!(
        names,
        vec![
            "id", "sm_autoLoad",
            "sm_0_position", "sm_1_position", "sm_2_position",
            "sm_0_direction", "sm_1_direction", "sm_2_direction",
            "sm_gold", "sm_uid", "sm_title", "sm_desc",
            "sm_0_pos", "sm_1_pos", "sm_2_pos",
            "sm_dict_a", "sm_dict_b",
        ]
    );

    let gold = &root.get("fields").unwrap().as_array().unwrap()[8];
    assert_eq!(gold.get("typeLabel").and_then(|v| v.as_str()), Some("int unsigned"));

    let uid = &root.get("fields").unwrap().as_array().unwrap()[9];
    assert_eq!(uid.get("identifier"), Some(&json!(true)));
    assert_eq!(uid.get("indexType").and_then(|v| v.as_str()), Some("UNIQUE"));
    assert_eq!(uid.get("databaseLength"), Some(&json!(64)));
    assert_eq!(uid.get("defaultValue").and_then(|v| v.as_str()), Some("0"));
    assert_eq!(uid.get("sourcePath").and_then(|v| v.as_str()), Some("Gold"));

    // STRING 声明 128 保真;未声明落引擎默认 255。
    let title = &root.get("fields").unwrap().as_array().unwrap()[10];
    assert_eq!(title.get("typeLabel").and_then(|v| v.as_str()), Some("varchar"));
    assert_eq!(title.get("databaseLength"), Some(&json!(128)));
    let desc = &root.get("fields").unwrap().as_array().unwrap()[11];
    assert_eq!(desc.get("databaseLength"), Some(&json!(255)));

    // VECTOR3 三列同 typeLabel vector3。
    let pos0 = &root.get("fields").unwrap().as_array().unwrap()[12];
    assert_eq!(pos0.get("typeLabel").and_then(|v| v.as_str()), Some("vector3"));

    // FD 键列落在根表(sm_dict_a/sm_dict_b),sourcePath 为子键路径。
    let dict_a = &root.get("fields").unwrap().as_array().unwrap()[15];
    assert_eq!(dict_a.get("sourcePath").and_then(|v| v.as_str()), Some("Gold.dict.a"));

    // 数组子表:parentID 存在、元素列落子表顶层。
    let scores = table_named(&result, "tbl_Gold_scores");
    assert_eq!(scores.get("kind").and_then(|v| v.as_str()), Some("array"));
    assert_eq!(scores.get("parentTableName").and_then(|v| v.as_str()), Some("tbl_Gold"));
    assert_eq!(
        field_names(scores),
        vec!["id", "parentID", "sm_autoLoad", "sm_value"]
    );
    let elem = &scores.get("fields").unwrap().as_array().unwrap()[3];
    assert_eq!(elem.get("typeLabel").and_then(|v| v.as_str()), Some("float"));
    assert_eq!(elem.get("sourcePath").and_then(|v| v.as_str()), Some("Gold.scores[]"));

    // 组件子表:无 parentID,子键列在组件表内。
    let weapon = table_named(&result, "tbl_Gold_weapon");
    assert_eq!(weapon.get("kind").and_then(|v| v.as_str()), Some("component"));
    assert_eq!(field_names(weapon), vec!["id", "sm_autoLoad", "sm_ammo"]);

    // hasCell=true ⇒ hiddenComp(base 无 cell 域)不跳过。
    assert!(table_named(&result, "tbl_Gold_hiddenComp").get("name").is_some());

    // ENTITYCALL 不落列(无 sm_call)。
    assert!(!field_names(root).contains(&"sm_call"));

    // tableIndex 覆盖全部表。
    let index = result.get("tableIndex").unwrap().as_object().unwrap();
    assert!(index.contains_key("tbl_Gold"));
    assert!(index.contains_key("tbl_Gold_scores"));
    assert!(index.contains_key("tbl_Gold_weapon"));
    assert!(index.contains_key("tbl_Gold_hiddenComp"));
    assert_eq!(index.len(), 4);
}

#[test]
fn no_cell_skips_base_less_component_and_position_columns() {
    let mut params = full_params();
    params["hasCellContent"] = json!(false);
    let result = build(params);
    let root = table_named(&result, "tbl_Gold");

    let names = field_names(root);
    assert!(!names.contains(&"sm_0_position"));
    assert!(!names.contains(&"sm_0_direction"));
    // 无 cell 且组件槽无 base 域 ⇒ 组件连表跳过。
    assert!(!tables_of(&result).iter().any(|t| {
        t.get("name").and_then(|v| v.as_str()) == Some("tbl_Gold_hiddenComp")
    }));
    // 有 base 域的组件照建。
    assert!(table_named(&result, "tbl_Gold_weapon").get("name").is_some());
}

#[test]
fn empty_properties_yield_fixed_root_columns() {
    let result = build(json!({
        "entityName": "Gold",
        "defFilePath": "/defs/entitys/Gold.def",
        "tablePrefix": "tbl_",
        "hasCellContent": true,
        "properties": []
    }));
    let root = table_named(&result, "tbl_Gold");
    assert_eq!(field_names(root).len(), 8); // id + autoLoad + 六列
    assert_eq!(tables_of(&result).len(), 1);
}

#[test]
fn empty_prefix_uses_entity_name_only() {
    let mut params = full_params();
    params["tablePrefix"] = json!("");
    let result = build(params);
    assert!(table_named(&result, "Gold").get("name").is_some());
}

#[test]
fn malformed_params_yield_error() {
    let mut state = ServerState::new();
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/databaseSchema/build", "params": json!({
                "entityName": "Gold",
                "properties": []
            })}),
        ),
    );
    let result = match &out[0] {
        Outgoing::Response(response) => response.result.as_ref(),
        Outgoing::Notification(_) => panic!("expected response"),
    };
    assert!(result.is_none(), "missing defFilePath should be an error");
}
