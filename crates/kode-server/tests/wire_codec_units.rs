//! def 线格式编解码器单测(Rust 权威;KBEngine 逐字节兼容)。
//!
//! 覆盖(与 dump_wire_golden 内置自校验互补):
//! - golden 重生成字符串等值(同 flag_domains 模式);
//! - 每 golden 样本双向:hex→decode==value 且 encode(decoded)==hex(属性流/方法/帧亦然);
//! - 畸形/截断逐字节不 panic(全部 kind);
//! - 部分数组流尽早停;STRING 非 ASCII 停;ENTITYCALL 16B 定长;
//! - WireSchema 结构重解析(SKILL_SLOT/POSITION/ITEM_IDS 嵌套+别名+环+未知);
//! - 变长帧 ≥65535 扩展长(u16=65535+u32);
//! - `$/kode/wire/encode|decode` RPC 边界 dispatch 烟测。

use std::collections::HashMap;

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Request, RequestId};
use kode_server::wire_codec::*;
use kode_server::{handle_message, Outgoing, ServerState};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn golden_json() -> Value {
    let regenerated = dump_wire_golden();
    serde_json::from_str(&regenerated).expect("golden JSON 合法")
}

#[test]
fn wire_golden_matches_regenerated_dump() {
    let regenerated = dump_wire_golden();
    let golden_path = repo_root().join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/wire-parity.json");
    let committed = committed.trim_end_matches('\n');
    assert_eq!(
        regenerated, committed,
        "wire golden 与重生成不一致。\n重新运行:\n  cargo run -p kode-server --bin dump-wire-golden > crates/kode-server/tests/golden/wire-parity.json"
    );
    assert!(committed.contains("dump-wire-golden"));
    assert!(committed.contains("prop_stream_account_alias"));
    assert!(committed.contains("method_args_req_create_avatar_alias"));
    assert!(committed.contains("frame_variable_short"));
}

/// 每个 value 样本:hex→decode==value 且 encode(value)==hex(双向无损)。
#[test]
fn wire_golden_value_samples_bidirectional() {
    let value = golden_json();
    let samples = value["samples"].as_array().unwrap();
    let value_samples: Vec<&Value> = samples
        .iter()
        .filter(|s| s["kind"] == "value")
        .collect();
    assert!(!value_samples.is_empty(), "value 样本不应为空");

    for s in &value_samples {
        let name = s["name"].as_str().unwrap();
        let layout: WireLayout =
            serde_json::from_value(s["layout"].clone()).expect("sample layout");
        let sample_value: WireValue =
            serde_json::from_value(s["value"].clone()).expect("sample value");
        let hex = s["hex"].as_str().unwrap();

        // encode(value) → hex
        let mut out = Vec::new();
        encode_value(&layout, &sample_value, &mut out)
            .unwrap_or_else(|e| panic!("{name} encode: {e}"));
        assert_eq!(to_hex(&out), hex, "{name} encode hex");

        // decode(hex) → value
        let raw = from_hex(hex).expect("hex");
        let mut cur = WireCursor::new(&raw);
        let back = decode_value(&layout, &mut cur)
            .unwrap_or_else(|e| panic!("{name} decode: {e}"));
        assert_eq!(back, sample_value, "{name} decode value");

        // 消费干净(无尾随字节)
        assert_eq!(cur.remaining(), 0, "{name} 应消费整段流");
    }
}

/// 属性流/方法/消息帧样本:decode(hex)==input 且 encode(input)==hex。
#[test]
fn wire_golden_stream_samples_bidirectional() {
    let value = golden_json();
    let samples = value["samples"].as_array().unwrap();

    for s in samples {
        match s["kind"].as_str().unwrap() {
            "value" => {}
            "property_stream" => {
                let name = s["name"].as_str().unwrap();
                let input = &s["input"];
                let entity: EntityRef =
                    serde_json::from_value(input["entity"].clone()).unwrap();
                let mode: PropertyMode =
                    serde_json::from_value(input["mode"].clone()).unwrap();
                let base: BasePropUtype =
                    serde_json::from_value(input["base"].clone()).unwrap();
                let entries: Vec<PropertyEntry> =
                    serde_json::from_value(input["entries"].clone()).unwrap();
                let entity_kind = EntityRefKind::of(&entity);
                let hex = s["hex"].as_str().unwrap();

                let layout_of_child = {
                    let mut map: HashMap<u16, WireLayout> = HashMap::new();
                    for e in &entries {
                        if let PropKind::Regular { layout, .. } = &e.kind {
                            map.insert(e.child, layout.clone());
                        }
                    }
                    move |_parent: u16, child: u16| {
                        map.get(&child).cloned().ok_or_else(|| {
                            WireError::UnknownType(format!("child {child}"))
                        })
                    }
                };

                let (got_entity, got_entries) = decode_property_stream(
                    &from_hex(hex).expect("hex"),
                    entity_kind,
                    mode,
                    &base,
                    layout_of_child,
                )
                .unwrap_or_else(|e| panic!("{name} decode: {e}"));
                assert_eq!(got_entity, entity, "{name} entity");
                assert_eq!(got_entries, entries, "{name} entries");

                let mut out = Vec::new();
                encode_property_stream(got_entity, mode, &got_entries, &mut out)
                    .unwrap_or_else(|e| panic!("{name} encode: {e}"));
                assert_eq!(to_hex(&out), hex, "{name} re-encode hex");
            }
            "method_call" => {
                let name = s["name"].as_str().unwrap();
                let input = &s["input"];
                let mode: PropertyMode =
                    serde_json::from_value(input["mode"].clone()).unwrap();
                let call: MethodCall =
                    serde_json::from_value(input["call"].clone()).unwrap();
                let hex = s["hex"].as_str().unwrap();

                let arg_layouts_of = {
                    let layouts = call.arg_layouts.clone();
                    move |_component: Option<u8>, _m: MethodRef| Ok(layouts.clone())
                };
                let back = decode_method_args(
                    &from_hex(hex).expect("hex"),
                    mode,
                    arg_layouts_of,
                )
                .unwrap_or_else(|e| panic!("{name} decode: {e}"));
                assert_eq!(back, call, "{name} method call");

                let mut out = Vec::new();
                encode_method_args(&back, mode, &mut out)
                    .unwrap_or_else(|e| panic!("{name} encode: {e}"));
                assert_eq!(to_hex(&out), hex, "{name} re-encode hex");
            }
            "message_frame" => {
                let name = s["name"].as_str().unwrap();
                let input = &s["input"];
                let msg_id = input["msg_id"].as_u64().unwrap() as u16;
                let variable = input["variable_length"].as_bool().unwrap();
                let body = from_hex(input["body_hex"].as_str().unwrap()).unwrap();
                let hex = s["hex"].as_str().unwrap();

                let raw = from_hex(hex).expect("hex");
                let mut cur = WireCursor::new(&raw);
                let (back_id, back_body) = decode_message_frame(
                    &mut cur,
                    variable,
                    if variable { None } else { Some(body.len()) },
                )
                .unwrap_or_else(|e| panic!("{name} decode: {e}"));
                assert_eq!(back_id, msg_id, "{name} msg id");
                assert_eq!(back_body, body, "{name} body");
                assert_eq!(cur.remaining(), 0, "{name} 消费整段流");
            }
            other => panic!("未知样本 kind: {other}"),
        }
    }
}

/// 畸形流不 panic:每个样本的 hex 逐字节截断(0..=len)全解码路径。
#[test]
fn wire_golden_no_panic_on_truncation() {
    let value = golden_json();
    let samples = value["samples"].as_array().unwrap();

    for s in samples {
        let bytes = from_hex(s["hex"].as_str().unwrap()).expect("hex");
        for cut in 0..=bytes.len() {
            let prefix = &bytes[..cut];
            match s["kind"].as_str().unwrap() {
                "value" => {
                    let layout: WireLayout =
                        serde_json::from_value(s["layout"].clone()).unwrap();
                    let mut cur = WireCursor::new(prefix);
                    let _ = decode_value(&layout, &mut cur);
                }
                "property_stream" => {
                    let input = &s["input"];
                    let mode: PropertyMode =
                        serde_json::from_value(input["mode"].clone()).unwrap();
                    let base: BasePropUtype =
                        serde_json::from_value(input["base"].clone()).unwrap();
                    let entity: EntityRef =
                        serde_json::from_value(input["entity"].clone()).unwrap();
                    let _ = decode_property_stream(
                        prefix,
                        EntityRefKind::of(&entity),
                        mode,
                        &base,
                        |_parent, _c| Err(WireError::UnknownType("trunc".to_string())),
                    );
                }
                "method_call" => {
                    let mode: PropertyMode =
                        serde_json::from_value(s["input"]["mode"].clone()).unwrap();
                    let _ = decode_method_args(prefix, mode, |_component, _m| {
                        Err(WireError::UnknownType("trunc".to_string()))
                    });
                }
                "message_frame" => {
                    let input = &s["input"];
                    let variable = input["variable_length"].as_bool().unwrap();
                    let body_len = if variable {
                        None
                    } else {
                        Some(from_hex(input["body_hex"].as_str().unwrap()).unwrap().len())
                    };
                    let mut cur = WireCursor::new(prefix);
                    let _ = decode_message_frame(&mut cur, variable, body_len);
                }
                _ => {}
            }
        }
    }
}

/// 部分数组流尽早停:count=3 但仅 2 元素 → 返回部分数组(非错误)。
#[test]
fn wire_partial_array_early_stop() {
    // count=3 + 元素 1,2(缺第 3 元素)
    let bytes = from_hex("030000000100000002000000").unwrap();
    let mut cur = WireCursor::new(&bytes);
    let v = decode_value(&WireLayout::Array(Box::new(WireLayout::U32)), &mut cur)
        .expect("partial array 应返回 Ok");
    assert_eq!(
        v,
        WireValue::Array(vec![WireValue::U32(1), WireValue::U32(2)])
    );
}

/// STRING 解码遇非 ASCII 即停(终止字节被消费;memorystream.h:319-330)。
#[test]
fn wire_string_non_ascii_stop() {
    let bytes = [b'a', b'b', 0xff, 0x00];
    let mut cur = WireCursor::new(&bytes);
    let v = decode_value(&WireLayout::Str, &mut cur).expect("非 ASCII 停非错误");
    assert_eq!(v, WireValue::Str("ab".to_string()));
    assert_eq!(cur.remaining(), 1, "0xff 被消费,剩 0x00");
}

/// STRING 编码拒绝内嵌 NUL(KODE-AUD-010):NUL 是线上终止符,写进流
/// 解码在首 NUL 截断——"a\0b" 往返变 "a" 属静默损坏,编码期如实报错。
#[test]
fn wire_string_embedded_nul_rejected() {
    let mut out = Vec::new();
    let err = encode_value(
        &WireLayout::Str,
        &WireValue::Str("a\0b".to_string()),
        &mut out,
    )
    .expect_err("内嵌 NUL 必须拒绝");
    assert!(matches!(err, WireError::EmbeddedNulString), "got: {err}");
    assert!(out.is_empty(), "拒绝时不写部分字节");
}

/// STRING 正常 ASCII 往返无损(NUL 终止,单字节无长度前缀)。
#[test]
fn wire_string_ascii_roundtrip() {
    let v = WireValue::Str("hello world".to_string());
    let mut out = Vec::new();
    encode_value(&WireLayout::Str, &v, &mut out).expect("encode ascii string");
    assert_eq!(out, b"hello world\0", "NUL 终止,无长度前缀");
    let mut cur = WireCursor::new(&out);
    let back = decode_value(&WireLayout::Str, &mut cur).expect("decode ascii string");
    assert_eq!(back, v);
    assert_eq!(cur.remaining(), 0, "终止字节被消费");
}

/// ENTITYCALL 恒 16 字节定长(id i32 + component_id u64 + call_type u16 + script_uid u16)。
#[test]
fn wire_entity_call_is_16_bytes() {
    let layout = WireLayout::EntityCall;
    let v = WireValue::EntityCall(EntityCallValue {
        id: -1,
        component_id: 5,
        call_type: 2,
        script_uid: 7,
    });
    let mut out = Vec::new();
    encode_value(&layout, &v, &mut out).expect("encode entity call");
    assert_eq!(out.len(), 16);
    assert_eq!(
        to_hex(&out),
        "ffffffff050000000000000002000700"
    );
    let mut cur = WireCursor::new(&out);
    let back = decode_value(&layout, &mut cur).expect("decode entity call");
    assert_eq!(back, v);
}

/// 别名模式属性 id >255 → AliasIdOverflow(引擎该模式禁用别名走 utype)。
#[test]
fn wire_alias_mode_id_overflow() {
    let entry = PropertyEntry {
        parent: 0,
        child: 300,
        kind: PropKind::Regular {
            layout: WireLayout::U32,
            value: WireValue::U32(1),
        },
    };
    let mut out = Vec::new();
    let err = encode_property_stream(
        EntityRef::Full(1),
        PropertyMode::Alias,
        &[entry],
        &mut out,
    )
    .expect_err("child 300 超 uint8 应报错");
    assert_eq!(err, WireError::AliasIdOverflow(300));
}

/// 变长帧 ≥65535:u16 长度=65535 + 后插 u32 扩展长(bundle.cpp:358-371)。
#[test]
fn wire_message_frame_extended_length() {
    let body = vec![0xABu8; 65535];
    let mut out = Vec::new();
    encode_message_frame(9, &body, true, &mut out).expect("encode extended frame");
    assert_eq!(out.len(), 2 + 2 + 4 + 65535);
    // msgid=9;长度占位=65535;扩展长=65535 LE
    assert_eq!(&out[0..2], &[9, 0]);
    assert_eq!(&out[2..4], &[0xff, 0xff]);
    assert_eq!(&out[4..8], &[0xff, 0xff, 0x00, 0x00]);

    let mut cur = WireCursor::new(&out);
    let (id, back) = decode_message_frame(&mut cur, true, None).expect("decode extended");
    assert_eq!(id, 9);
    assert_eq!(back.len(), 65535);
    assert!(back.iter().all(|b| *b == 0xAB));
}

/// WireSchema 结构重解析:嵌套 FIXED_DICT / ARRAY-of-别名 / 内建 / 环 / 未知。
#[test]
fn wire_schema_resolves_fixture() {
    let schema = WireSchema::from_sources(SCHEMA_FIXTURE_XML, "");
    assert_eq!(schema.resolve("UINT32").unwrap(), WireLayout::U32);
    assert_eq!(schema.resolve("ITEM_DESC").unwrap(), WireLayout::Str);
    // 别名链 ITEM_ID→UINT16,ITEM_IDS=ARRAY<ITEM_ID>
    assert_eq!(schema.resolve("ITEM_ID").unwrap(), WireLayout::U16);
    assert_eq!(
        schema.resolve("ITEM_IDS").unwrap(),
        WireLayout::Array(Box::new(WireLayout::U16))
    );
    // SKILL_SLOT:slot_list ARRAY<UINT32> + count UINT32(声明序)
    assert_eq!(
        schema.resolve("SKILL_SLOT").unwrap(),
        WireLayout::FixedDict(vec![
            WireField {
                name: "slot_list".into(),
                layout: WireLayout::Array(Box::new(WireLayout::U32)),
            },
            WireField {
                name: "count".into(),
                layout: WireLayout::U32,
            },
        ])
    );
    // POSITION:x,y,z FLOAT(声明序,非字母序)
    assert_eq!(
        schema.resolve("POSITION").unwrap(),
        WireLayout::FixedDict(vec![
            WireField { name: "x".into(), layout: WireLayout::F32 },
            WireField { name: "y".into(), layout: WireLayout::F32 },
            WireField { name: "z".into(), layout: WireLayout::F32 },
        ])
    );
    // 未注册 → UnknownType
    assert!(matches!(
        schema.resolve("NOPE"),
        Err(WireError::UnknownType(_))
    ));
}

/// 类型环(A→B→A)→ Cycle,不无限递归。
#[test]
fn wire_schema_cycle_detected() {
    let schema = WireSchema::from_sources("<root><A>B</A><B>A</B></root>", "");
    assert!(matches!(
        schema.resolve("A"),
        Err(WireError::Cycle(_))
    ));
}

// ---------------------------------------------------------------------------
// RPC 边界(`$/kode/wire/encode|decode`)dispatch 烟测
// ---------------------------------------------------------------------------

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

#[test]
fn wire_rpc_dispatch_smoke() {
    let mut state = ServerState::new();
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));

    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/wire/encode", "params": {"layout": "U32", "value": {"U32": 5}}}),
        ),
    );
    assert_eq!(response_of(&out)["hex"], "05000000");

    let out = handle_message(
        &mut state,
        request(
            2,
            "$/kode/rpc",
            json!({"method": "$/kode/wire/decode", "params": {"layout": "U32", "hex": "05000000"}}),
        ),
    );
    assert_eq!(response_of(&out), &json!({"U32": 5}));

    // 固定字典经 RPC 边界(数组+字段名往返)
    let out = handle_message(
        &mut state,
        request(
            3,
            "$/kode/rpc",
            json!({
                "method": "$/kode/wire/encode",
                "params": {
                    "layout": {"FixedDict": [
                        {"name": "x", "layout": "F32"},
                        {"name": "count", "layout": "U32"},
                    ]},
                    "value": {"FixedDict": [{"F32": 1.5}, {"U32": 2}]},
                }
            }),
        ),
    );
    let hex = response_of(&out)["hex"].as_str().unwrap().to_string();
    // x=1.5 → 0000c03f;count=2 → 02000000
    assert_eq!(hex, "0000c03f02000000");

    let out = handle_message(
        &mut state,
        request(
            4,
            "$/kode/rpc",
            json!({
                "method": "$/kode/wire/decode",
                "params": {
                    "layout": {"FixedDict": [
                        {"name": "x", "layout": "F32"},
                        {"name": "count", "layout": "U32"},
                    ]},
                    "hex": hex,
                }
            }),
        ),
    );
    assert_eq!(
        response_of(&out),
        &json!({"FixedDict": [{"F32": 1.5}, {"U32": 2}]})
    );
}

#[test]
fn method_encoding_rejects_arity_and_identifier_mode_before_writing() {
    for (mode, method, args, layouts) in [
        (PropertyMode::Alias, MethodRef::Alias(1), vec![WireValue::U8(1), WireValue::U8(2)], vec![WireLayout::U8]),
        (PropertyMode::Alias, MethodRef::Alias(1), vec![], vec![WireLayout::U8]),
        (PropertyMode::Alias, MethodRef::Utype(257), vec![], vec![]),
        (PropertyMode::Utype, MethodRef::Alias(1), vec![], vec![]),
    ] {
        let mut output = vec![42];
        let call = MethodCall { component_alias: None, method, args, arg_layouts: layouts };
        assert!(encode_method_args(&call, mode, &mut output).is_err());
        assert_eq!(output, vec![42]);
    }
}

#[test]
fn component_identity_selects_property_and_method_layouts() {
    let entries = vec![
        PropertyEntry { parent: 6, child: 1, kind: PropKind::Regular { layout: WireLayout::U8, value: WireValue::U8(7) } },
        PropertyEntry { parent: 7, child: 1, kind: PropKind::Regular { layout: WireLayout::U16, value: WireValue::U16(513) } },
    ];
    let mut bytes = Vec::new();
    encode_property_stream(EntityRef::Full(1), PropertyMode::Utype, &entries, &mut bytes).unwrap();
    let (_, actual) = decode_property_stream(&bytes, EntityRefKind::Full, PropertyMode::Utype, &BasePropUtype::default(), |parent, child| match (parent, child) {
        (6, 1) => Ok(WireLayout::U8), (7, 1) => Ok(WireLayout::U16), _ => Err(WireError::UnknownType("property".into())),
    }).unwrap();
    assert_eq!(actual, entries);
    for (component, layout, value) in [(1, WireLayout::U8, WireValue::U8(7)), (2, WireLayout::U16, WireValue::U16(513))] {
        let call = MethodCall { component_alias: Some(component), method: MethodRef::Alias(1), args: vec![value], arg_layouts: vec![layout] };
        let mut bytes = Vec::new();
        encode_method_args(&call, PropertyMode::Alias, &mut bytes).unwrap();
        let actual = decode_method_args(&bytes, PropertyMode::Alias, |component, method| match (component, method) {
            (Some(1), MethodRef::Alias(1)) => Ok(vec![WireLayout::U8]),
            (Some(2), MethodRef::Alias(1)) => Ok(vec![WireLayout::U16]),
            _ => Err(WireError::UnknownType("method".into())),
        }).unwrap();
        assert_eq!(actual, call);
    }
}
