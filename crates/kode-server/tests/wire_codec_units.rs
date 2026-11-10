//! def 线格式编解码器单测(Rust 权威;KBEngine 逐字节兼容)。
//!
//! 覆盖(与 dump_wire_golden 内置自校验互补):
//! - golden 重生成字符串等值(同 flag_domains 模式);
//! - 每 golden 样本双向:hex→decode==value 且 encode(decoded)==hex(属性流/方法/帧亦然);
//! - 畸形/截断逐字节不 panic(全部 kind);
//! - 部分数组流尽早停;STRING 非 ASCII 停;ENTITYCALL 16B 定长;
//! - WireSchema 结构重解析(SKILL_SLOT/POSITION/ITEM_IDS 嵌套+别名+环+未知);
//! - 变长帧 ≥65535 扩展长(u16=65535+u32);

use std::collections::HashMap;

use serde_json::Value;

use kode_server::wire_codec::*;

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
    // Windows autocrlf 会把 golden 检出为 CRLF;dump 输出恒 LF,两侧都剥 \r\n。
    let committed = committed.trim_end_matches(['\r', '\n']);
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
    let value_samples: Vec<&Value> = samples.iter().filter(|s| s["kind"] == "value").collect();
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
        let back = decode_value(&layout, &mut cur).unwrap_or_else(|e| panic!("{name} decode: {e}"));
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
                let entity: EntityRef = serde_json::from_value(input["entity"].clone()).unwrap();
                let mode: PropertyMode = serde_json::from_value(input["mode"].clone()).unwrap();
                let base: BasePropUtype = serde_json::from_value(input["base"].clone()).unwrap();
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
                        map.get(&child)
                            .cloned()
                            .ok_or_else(|| WireError::UnknownType(format!("child {child}")))
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
                let mode: PropertyMode = serde_json::from_value(input["mode"].clone()).unwrap();
                let call: MethodCall = serde_json::from_value(input["call"].clone()).unwrap();
                let hex = s["hex"].as_str().unwrap();

                let arg_layouts_of = {
                    let layouts = call.arg_layouts.clone();
                    move |_component: Option<u8>, _m: MethodRef| Ok(layouts.clone())
                };
                let back = decode_method_args(&from_hex(hex).expect("hex"), mode, arg_layouts_of)
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
                    let layout: WireLayout = serde_json::from_value(s["layout"].clone()).unwrap();
                    let mut cur = WireCursor::new(prefix);
                    let _ = decode_value(&layout, &mut cur);
                }
                "property_stream" => {
                    let input = &s["input"];
                    let mode: PropertyMode = serde_json::from_value(input["mode"].clone()).unwrap();
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
    assert_eq!(to_hex(&out), "ffffffff050000000000000002000700");
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
    let err = encode_property_stream(EntityRef::Full(1), PropertyMode::Alias, &[entry], &mut out)
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
            WireField {
                name: "x".into(),
                layout: WireLayout::F32
            },
            WireField {
                name: "y".into(),
                layout: WireLayout::F32
            },
            WireField {
                name: "z".into(),
                layout: WireLayout::F32
            },
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
    assert!(matches!(schema.resolve("A"), Err(WireError::Cycle(_))));
}

/// 构建容错臂:types/alias XML 非空但无根 → 整段跳过(内建照常可解析);
/// FIXED_DICT 缺 `<Properties>` 子元素 → 空字段 FixedDict。
#[test]
fn wire_schema_from_sources_tolerant_branches() {
    // typesXml 非空但无根 → 解析内建不受影响(schema.rs:49 臂)。
    let schema = WireSchema::from_sources("zzz", "");
    assert_eq!(schema.resolve("UINT32").unwrap(), WireLayout::U32);
    // aliasXml 非空但无根 → 同上(schema.rs:62 臂)。
    let schema = WireSchema::from_sources("", "zzz");
    assert_eq!(schema.resolve("UINT32").unwrap(), WireLayout::U32);
    // FIXED_DICT 无 `<Properties>` → 空字段 FixedDict(schema.rs:165 臂)。
    let schema = WireSchema::from_sources("<root><D> FIXED_DICT </D></root>", "");
    assert_eq!(schema.resolve("D").unwrap(), WireLayout::FixedDict(vec![]));
}

#[test]
fn method_encoding_rejects_arity_and_identifier_mode_before_writing() {
    for (mode, method, args, layouts) in [
        (
            PropertyMode::Alias,
            MethodRef::Alias(1),
            vec![WireValue::U8(1), WireValue::U8(2)],
            vec![WireLayout::U8],
        ),
        (
            PropertyMode::Alias,
            MethodRef::Alias(1),
            vec![],
            vec![WireLayout::U8],
        ),
        (PropertyMode::Alias, MethodRef::Utype(257), vec![], vec![]),
        (PropertyMode::Utype, MethodRef::Alias(1), vec![], vec![]),
        // KR-AUD-94 边界:Utype 值 255/256 在 Alias 模式同样必须拒绝(模式不匹配,
        // 非整数截断)——255 恰好塞进 u8 也不能放行,因为 Utype≠Alias 语义不等价。
        (PropertyMode::Alias, MethodRef::Utype(255), vec![], vec![]),
        (PropertyMode::Alias, MethodRef::Utype(256), vec![], vec![]),
        // 反向:Utype 模式下 Alias(1) 同样拒绝。
        (PropertyMode::Utype, MethodRef::Alias(255), vec![], vec![]),
    ] {
        let mut output = vec![42];
        let call = MethodCall {
            component_alias: None,
            method,
            args,
            arg_layouts: layouts,
        };
        assert!(encode_method_args(&call, mode, &mut output).is_err());
        assert_eq!(output, vec![42]);
    }
}

#[test]
fn method_encoding_accepts_legal_mode_id_pairs() {
    // KR-AUD-94 正例:合法模式组合编码成功且不改写输出缓冲前缀。
    // Utype 模式下 Utype(255/256/257) 全部合法(u16 容纳),写入 u16 LE。
    for method in [
        MethodRef::Utype(255),
        MethodRef::Utype(256),
        MethodRef::Utype(257),
    ] {
        let mut output = vec![42];
        let call = MethodCall {
            component_alias: None,
            method,
            args: vec![],
            arg_layouts: vec![],
        };
        encode_method_args(&call, PropertyMode::Utype, &mut output).unwrap();
        assert_eq!(&output[..1], &[42], "既有前缀不得被改写");
        // utype = u16 LE 在前缀之后
        let u = match method {
            MethodRef::Utype(u) => u,
            _ => unreachable!(),
        };
        assert_eq!(&output[1..3], &u.to_le_bytes());
    }
    // Alias 模式下 Alias(255) 合法(u8 容纳):写 component_alias(0)+alias(255)。
    let mut output = vec![42];
    let call = MethodCall {
        component_alias: None,
        method: MethodRef::Alias(255),
        args: vec![],
        arg_layouts: vec![],
    };
    encode_method_args(&call, PropertyMode::Alias, &mut output).unwrap();
    assert_eq!(output, vec![42, 0, 255]);
    // 零参零布局:合法且只写方法 id。
    let mut output = vec![];
    let call = MethodCall {
        component_alias: None,
        method: MethodRef::Alias(1),
        args: vec![],
        arg_layouts: vec![],
    };
    encode_method_args(&call, PropertyMode::Alias, &mut output).unwrap();
    assert_eq!(output, vec![0, 1]);
}

#[test]
fn component_identity_selects_property_and_method_layouts() {
    let entries = vec![
        PropertyEntry {
            parent: 6,
            child: 1,
            kind: PropKind::Regular {
                layout: WireLayout::U8,
                value: WireValue::U8(7),
            },
        },
        PropertyEntry {
            parent: 7,
            child: 1,
            kind: PropKind::Regular {
                layout: WireLayout::U16,
                value: WireValue::U16(513),
            },
        },
    ];
    let mut bytes = Vec::new();
    encode_property_stream(
        EntityRef::Full(1),
        PropertyMode::Utype,
        &entries,
        &mut bytes,
    )
    .unwrap();
    let (_, actual) = decode_property_stream(
        &bytes,
        EntityRefKind::Full,
        PropertyMode::Utype,
        &BasePropUtype::default(),
        |parent, child| match (parent, child) {
            (6, 1) => Ok(WireLayout::U8),
            (7, 1) => Ok(WireLayout::U16),
            _ => Err(WireError::UnknownType("property".into())),
        },
    )
    .unwrap();
    assert_eq!(actual, entries);
    for (component, layout, value) in [
        (1, WireLayout::U8, WireValue::U8(7)),
        (2, WireLayout::U16, WireValue::U16(513)),
    ] {
        let call = MethodCall {
            component_alias: Some(component),
            method: MethodRef::Alias(1),
            args: vec![value],
            arg_layouts: vec![layout],
        };
        let mut bytes = Vec::new();
        encode_method_args(&call, PropertyMode::Alias, &mut bytes).unwrap();
        let actual = decode_method_args(&bytes, PropertyMode::Alias, |component, method| {
            match (component, method) {
                (Some(1), MethodRef::Alias(1)) => Ok(vec![WireLayout::U8]),
                (Some(2), MethodRef::Alias(1)) => Ok(vec![WireLayout::U16]),
                _ => Err(WireError::UnknownType("method".into())),
            }
        })
        .unwrap();
        assert_eq!(actual, call);
    }
}

// ---------------------------------------------------------------------------
// WireError:全变体 Display/Debug/Clone/PartialEq/Eq(手动 impl 全覆盖)
// ---------------------------------------------------------------------------

/// 每个变体构造一次并断言 Display 文本与派生 trait 行为。
#[test]
fn wire_error_variants_display_and_traits() {
    let cases: Vec<(WireError, &str)> = vec![
        (
            WireError::UnknownType("Foo".to_string()),
            "unknown wire type: Foo",
        ),
        (WireError::Cycle("A".to_string()), "type cycle: A"),
        (
            WireError::TypeMismatch {
                expected: "u8",
                found: "u16",
            },
            "type mismatch: expected u8, found u16",
        ),
        (
            WireError::Truncated { need: 4, have: 2 },
            "truncated stream: need 4 bytes, have 2",
        ),
        (
            WireError::LengthOverflow {
                length: 100,
                remaining: 8,
            },
            "length prefix 100 exceeds remaining 8 bytes",
        ),
        (
            WireError::ArraySizeTooLarge { size: 70000 },
            "array element count 70000 exceeds bound",
        ),
        (
            WireError::AliasIdOverflow(300),
            "alias id 300 exceeds uint8 bound (use utype mode)",
        ),
        (
            WireError::ArgumentCountMismatch {
                expected: 2,
                actual: 3,
            },
            "expected 2 arguments, got 3",
        ),
        (
            WireError::MethodModeMismatch,
            "method identifier does not match encoding mode",
        ),
        (
            WireError::NonAsciiString,
            "STRING value contains non-ASCII bytes",
        ),
        (
            WireError::EmbeddedNulString,
            "STRING value contains embedded NUL byte",
        ),
        (
            WireError::InvalidHex("zz".to_string()),
            "invalid hex string: zz",
        ),
        (
            WireError::MessageTooLarge { size: 99999 },
            "message size 99999 exceeds u32 extended length",
        ),
    ];
    for (err, expected) in cases {
        assert_eq!(err.to_string(), expected, "Display 文本");
        // Debug 非空(手动 derive Debug)
        assert!(!format!("{err:?}").is_empty(), "Debug 非空");
        // Clone + PartialEq + Eq 往返等价
        let cloned = err.clone();
        assert_eq!(cloned, err, "Clone/PartialEq 等价");
        // std::error::Error 的默认 source 为 None(不实现自定义 source)
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(err);
        assert!(boxed.source().is_none(), "默认 source 为 None");
    }
}

// ---------------------------------------------------------------------------
// hex 辅助:to_hex/from_hex 双向 + 畸形
// ---------------------------------------------------------------------------

#[test]
fn hex_to_and_from_roundtrip() {
    assert_eq!(to_hex(&[]), "");
    assert_eq!(from_hex("").expect("空串合法"), Vec::<u8>::new());
    assert_eq!(to_hex(&[0xde, 0xad, 0xbe, 0xef]), "deadbeef");
    assert_eq!(
        from_hex("deadbeef").expect("小写解析"),
        vec![0xde, 0xad, 0xbe, 0xef]
    );
    // 大写输入等价
    assert_eq!(
        from_hex("DEADBEEF").expect("大写解析"),
        vec![0xde, 0xad, 0xbe, 0xef]
    );
    // 混合大小写
    assert_eq!(
        from_hex("DeAdBeEf").expect("混合大小写解析"),
        vec![0xde, 0xad, 0xbe, 0xef]
    );
    // 单字节上下界
    assert_eq!(from_hex("00").expect("00"), vec![0x00]);
    assert_eq!(from_hex("ff").expect("ff"), vec![0xff]);
    assert_eq!(from_hex("FF").expect("FF"), vec![0xff]);
}

#[test]
fn hex_from_rejects_malformed() {
    // 奇数长度 → InvalidHex(不 panic)
    assert!(matches!(from_hex("0"), Err(WireError::InvalidHex(_))));
    assert!(matches!(from_hex("abc"), Err(WireError::InvalidHex(_))));
    // 非法字符在高位 → InvalidHex
    assert!(matches!(from_hex("zz00"), Err(WireError::InvalidHex(_))));
    // 非法字符在低位 → InvalidHex
    assert!(matches!(from_hex("0z"), Err(WireError::InvalidHex(_))));
    // 非 hex 但长度合法(如 'g')
    assert!(matches!(from_hex("g0"), Err(WireError::InvalidHex(_))));
}

// ---------------------------------------------------------------------------
// WireSchema:alias.xml + 结构重解析边界(空 directive/type 属性/环)
// ---------------------------------------------------------------------------

/// alias.xml 目标解析三分支 + 空目标跳过;type 属性回落;ARRAY 缺 of;空 directive。
#[test]
fn wire_schema_alias_and_directive_fallbacks() {
    let types_xml = "<root>\
        <ITEM_ID> UINT16 </ITEM_ID>\
        <ARR> ARRAY <of> UINT32 </of> </ARR>\
        <NOOF> ARRAY </NOOF>\
        <DICT> FIXED_DICT <Properties>\
            <a><Type> UINT32 </Type></a>\
            <b></b>\
        </Properties> </DICT>\
        <EMPTY></EMPTY>\
        <ATTRIB type=\"UINT32\"></ATTRIB>\
    </root>";
    let alias_xml = "<root>\
        <MoneyAlias><Type> UINT32 </Type></MoneyAlias>\
        <ItemAlias><Type>   </Type></ItemAlias>\
        <ElementAlias><Other/></ElementAlias>\
        <SelfAlias>ITEM_ID junk</SelfAlias>\
        <EmptyAlias></EmptyAlias>\
    </root>";
    let schema = WireSchema::from_sources(types_xml, alias_xml);

    // alias.xml Type 子元素文本 → Named 目标
    assert_eq!(schema.resolve("MoneyAlias").unwrap(), WireLayout::U32);
    // alias.xml 首个非 Type 子元素标签名 → Named("Other")(未注册 → 未知)
    assert!(matches!(
        schema.resolve("ElementAlias"),
        Err(WireError::UnknownType(_))
    ));
    // alias.xml 自身文本首个 token → ITEM_ID
    assert_eq!(schema.resolve("SelfAlias").unwrap(), WireLayout::U16);
    // 空目标(空白 Type / 空元素)被跳过 → 不可解析
    assert!(matches!(
        schema.resolve("ItemAlias"),
        Err(WireError::UnknownType(_))
    ));
    assert!(matches!(
        schema.resolve("EmptyAlias"),
        Err(WireError::UnknownType(_))
    ));

    // ARRAY 缺 <of> → 元素默认 STRING
    assert_eq!(
        schema.resolve("NOOF").unwrap(),
        WireLayout::Array(Box::new(WireLayout::Str))
    );
    // FIXED_DICT 无 Type 子键被跳过(只留 a)
    assert_eq!(
        schema.resolve("DICT").unwrap(),
        WireLayout::FixedDict(vec![WireField {
            name: "a".into(),
            layout: WireLayout::U32,
        }])
    );
    // 空 directive(无文本无 type 属性)→ Builtin("") → 未知类型
    assert!(matches!(
        schema.resolve("EMPTY"),
        Err(WireError::UnknownType(_))
    ));
    // type 属性回落 → Named("UINT32") → 内建 U32
    assert_eq!(schema.resolve("ATTRIB").unwrap(), WireLayout::U32);
}

/// 环经 ARRAY 穿透:A=ARRAY<of>B,B=A → Cycle(非栈溢出)。
#[test]
fn wire_schema_cycle_through_array() {
    let schema = WireSchema::from_sources("<root><A>ARRAY<of>B</of></A><B>A</B></root>", "");
    assert!(matches!(schema.resolve("A"), Err(WireError::Cycle(_))));
    assert!(matches!(schema.resolve("B"), Err(WireError::Cycle(_))));
}

/// 全部 21 内建名 resolve 到对应布局;未知内建前缀 → UnknownType。
#[test]
fn wire_schema_resolves_all_builtins() {
    let schema = WireSchema::from_sources("", "");
    for (name, layout) in [
        ("UINT8", WireLayout::U8),
        ("UINT16", WireLayout::U16),
        ("UINT32", WireLayout::U32),
        ("UINT64", WireLayout::U64),
        ("INT8", WireLayout::I8),
        ("INT16", WireLayout::I16),
        ("INT32", WireLayout::I32),
        ("INT64", WireLayout::I64),
        ("FLOAT", WireLayout::F32),
        ("DOUBLE", WireLayout::F64),
        ("BOOL", WireLayout::Bool),
        ("STRING", WireLayout::Str),
        ("UNICODE", WireLayout::Unicode),
        ("PYTHON", WireLayout::Py),
        ("PY_DICT", WireLayout::PyDict),
        ("PY_TUPLE", WireLayout::PyTuple),
        ("PY_LIST", WireLayout::PyList),
        ("ENTITYCALL", WireLayout::EntityCall),
        ("BLOB", WireLayout::Blob),
        ("VECTOR2", WireLayout::Vec2),
        ("VECTOR3", WireLayout::Vec3),
        ("VECTOR4", WireLayout::Vec4),
    ] {
        assert_eq!(schema.resolve(name).unwrap(), layout, "{name}");
    }
    assert!(matches!(
        schema.resolve("NOPE"),
        Err(WireError::UnknownType(_))
    ));
}

// ---------------------------------------------------------------------------
// WireLayout/WireValue serde 往返(全变体,覆盖 derive 代码)
// ---------------------------------------------------------------------------

/// 全变体 serde 往返:每对 (layout,value) 序列化再反序列化等值。
#[test]
fn wire_types_serde_roundtrip_all_variants() {
    let cases: Vec<(WireLayout, WireValue)> = vec![
        (WireLayout::U8, WireValue::U8(0xff)),
        (WireLayout::U16, WireValue::U16(0xffff)),
        (WireLayout::U32, WireValue::U32(0xffff_ffff)),
        (WireLayout::U64, WireValue::U64(0xffff_ffff_ffff_ffff)),
        (WireLayout::I8, WireValue::I8(-128)),
        (WireLayout::I16, WireValue::I16(-32768)),
        (WireLayout::I32, WireValue::I32(-2147483648)),
        (WireLayout::I64, WireValue::I64(-9223372036854775808)),
        (WireLayout::F32, WireValue::F32(1.5)),
        (WireLayout::F64, WireValue::F64(3.25)),
        (WireLayout::Bool, WireValue::Bool(true)),
        (WireLayout::Str, WireValue::Str("s".into())),
        (WireLayout::Unicode, WireValue::Unicode(vec![1, 2])),
        (WireLayout::Blob, WireValue::Blob(vec![3, 4])),
        (WireLayout::Py, WireValue::Py(vec![5])),
        (WireLayout::PyDict, WireValue::PyDict(vec![6])),
        (WireLayout::PyTuple, WireValue::PyTuple(vec![7])),
        (WireLayout::PyList, WireValue::PyList(vec![8])),
        (
            WireLayout::EntityCall,
            WireValue::EntityCall(EntityCallValue {
                id: -7,
                component_id: 9,
                call_type: 3,
                script_uid: 4,
            }),
        ),
        (WireLayout::Vec2, WireValue::Vec2([1.0, 2.0])),
        (WireLayout::Vec3, WireValue::Vec3([1.0, 2.0, 3.0])),
        (WireLayout::Vec4, WireValue::Vec4([1.0, 2.0, 3.0, 4.0])),
        (
            WireLayout::Array(Box::new(WireLayout::U8)),
            WireValue::Array(vec![WireValue::U8(1), WireValue::U8(2)]),
        ),
        (
            WireLayout::FixedDict(vec![WireField {
                name: "x".into(),
                layout: WireLayout::U32,
            }]),
            WireValue::FixedDict(vec![WireValue::U32(42)]),
        ),
    ];
    for (layout, value) in cases {
        let layout_json = serde_json::to_string(&layout).expect("layout serialize");
        let layout_back: WireLayout =
            serde_json::from_str(&layout_json).expect("layout deserialize");
        assert_eq!(layout_back, layout, "layout 往返");
        let value_json = serde_json::to_string(&value).expect("value serialize");
        let value_back: WireValue = serde_json::from_str(&value_json).expect("value deserialize");
        assert_eq!(value_back, value, "value 往返");
    }
    // EntityCallValue Default + serde 标签名抽查
    let ec = EntityCallValue::default();
    assert_eq!(ec.id, 0);
    assert_eq!(
        serde_json::from_str::<EntityCallValue>(
            "{\"id\":1,\"component_id\":2,\"call_type\":3,\"script_uid\":4}"
        )
        .expect("entitycall deserialize"),
        EntityCallValue {
            id: 1,
            component_id: 2,
            call_type: 3,
            script_uid: 4,
        }
    );
    // WireField serde
    let f = WireField {
        name: "n".into(),
        layout: WireLayout::Bool,
    };
    let fj = serde_json::to_string(&f).unwrap();
    assert_eq!(serde_json::from_str::<WireField>(&fj).unwrap(), f);
}

// ---------------------------------------------------------------------------
// encode_value/decode_value:类型失配与数组上界(全 layout_kind/value_kind 臂)
// ---------------------------------------------------------------------------

/// 每 layout 配一个失配 value → TypeMismatch,断言 expected/found 标签
/// (覆盖 layout_kind/value_kind 全臂)。
#[test]
fn wire_value_type_mismatch_arms() {
    let cases: Vec<(WireLayout, WireValue, &str, &str)> = vec![
        (WireLayout::U8, WireValue::U16(1), "u8", "u16"),
        (WireLayout::U16, WireValue::U32(1), "u16", "u32"),
        (WireLayout::U32, WireValue::U64(1), "u32", "u64"),
        (WireLayout::U64, WireValue::I8(1), "u64", "i8"),
        (WireLayout::I8, WireValue::I16(1), "i8", "i16"),
        (WireLayout::I16, WireValue::I32(1), "i16", "i32"),
        (WireLayout::I32, WireValue::I64(1), "i32", "i64"),
        (WireLayout::I64, WireValue::F32(1.0), "i64", "f32"),
        (WireLayout::F32, WireValue::F64(1.0), "f32", "f64"),
        (WireLayout::F64, WireValue::Bool(true), "f64", "bool"),
        (
            WireLayout::Bool,
            WireValue::Str("x".into()),
            "bool",
            "string",
        ),
        (
            WireLayout::Str,
            WireValue::Unicode(vec![]),
            "string",
            "unicode",
        ),
        (
            WireLayout::Unicode,
            WireValue::Blob(vec![]),
            "unicode",
            "blob",
        ),
        (WireLayout::Blob, WireValue::Py(vec![]), "blob", "python"),
        (
            WireLayout::Py,
            WireValue::PyDict(vec![]),
            "python",
            "py_dict",
        ),
        (
            WireLayout::PyDict,
            WireValue::PyTuple(vec![]),
            "py_dict",
            "py_tuple",
        ),
        (
            WireLayout::PyTuple,
            WireValue::PyList(vec![]),
            "py_tuple",
            "py_list",
        ),
        (
            WireLayout::PyList,
            WireValue::EntityCall(EntityCallValue::default()),
            "py_list",
            "entity_call",
        ),
        (
            WireLayout::EntityCall,
            WireValue::Vec2([0.0, 0.0]),
            "entity_call",
            "vector2",
        ),
        (
            WireLayout::Vec2,
            WireValue::Vec3([0.0; 3]),
            "vector2",
            "vector3",
        ),
        (
            WireLayout::Vec3,
            WireValue::Vec4([0.0; 4]),
            "vector3",
            "vector4",
        ),
        (
            WireLayout::Vec4,
            WireValue::Array(vec![]),
            "vector4",
            "array",
        ),
        (
            WireLayout::Array(Box::new(WireLayout::U8)),
            WireValue::FixedDict(vec![]),
            "array",
            "fixed_dict",
        ),
        (
            WireLayout::FixedDict(vec![]),
            WireValue::U8(1),
            "fixed_dict",
            "u8",
        ),
    ];
    for (layout, value, expected, found) in cases {
        let mut out = vec![9u8];
        let err = encode_value(&layout, &value, &mut out).expect_err("失配必须报错");
        assert_eq!(
            err,
            WireError::TypeMismatch { expected, found },
            "{expected} vs {found}"
        );
        // 失配时不写任何字节(前缀原样)
        assert_eq!(out, vec![9u8], "失配不写字节");
        assert!(
            err.to_string().contains(expected) && err.to_string().contains(found),
            "Display 含 expected/found"
        );
    }
}

/// FIXED_DICT 编码 arity 失配 → TypeMismatch(fixed-dict arity / value arity)。
#[test]
fn wire_fixed_dict_arity_mismatch() {
    let layout = WireLayout::FixedDict(vec![
        WireField {
            name: "a".into(),
            layout: WireLayout::U8,
        },
        WireField {
            name: "b".into(),
            layout: WireLayout::U8,
        },
    ]);
    let value = WireValue::FixedDict(vec![WireValue::U8(1)]);
    let mut out = Vec::new();
    let err = encode_value(&layout, &value, &mut out).expect_err("arity 失配");
    assert_eq!(
        err,
        WireError::TypeMismatch {
            expected: "fixed-dict arity",
            found: "value arity",
        }
    );
}

/// 解码数组元素数超 1<<24 上界 → ArraySizeTooLarge(不分配不 panic)。
#[test]
fn wire_decode_array_size_too_large() {
    // count = 0x02000000 (33554432) > 1<<24
    let bytes = from_hex("00000002").expect("count LE");
    let mut cur = WireCursor::new(&bytes);
    let err = decode_value(&WireLayout::Array(Box::new(WireLayout::U8)), &mut cur)
        .expect_err("超上界必须报错");
    assert_eq!(err, WireError::ArraySizeTooLarge { size: 0x0200_0000 });
}

// ---------------------------------------------------------------------------
// 方法实参:解码布局闭包错误传播 + utype 模式 component_alias 忽略
// ---------------------------------------------------------------------------

/// 解码期 arg_layouts_of 返回 Err → 整体 Err(布局解析失败传播)。
#[test]
fn wire_method_args_decode_layout_error_propagates() {
    // alias 模式:comp(0) + alias(1)
    let data = [0u8, 1u8];
    let err = decode_method_args(&data, PropertyMode::Alias, |_component, _m| {
        Err(WireError::UnknownType("missing".into()))
    })
    .expect_err("布局闭包错误必须传播");
    assert_eq!(err, WireError::UnknownType("missing".into()));
}

/// utype 模式编码忽略 component_alias(引擎不写 component uid)。
#[test]
fn wire_method_args_utype_ignores_component_alias() {
    let call = MethodCall {
        component_alias: Some(7),
        method: MethodRef::Utype(300),
        args: vec![WireValue::U8(5)],
        arg_layouts: vec![WireLayout::U8],
    };
    let mut out = Vec::new();
    encode_method_args(&call, PropertyMode::Utype, &mut out).expect("utype 编码");
    // u16 utype(300) + u8 arg(5),无 component 字节
    assert_eq!(out, vec![0x2c, 0x01, 5]);
    // 解码:component_alias 恒 None
    let back = decode_method_args(&out, PropertyMode::Utype, |_c, m| {
        assert_eq!(m, MethodRef::Utype(300));
        Ok(vec![WireLayout::U8])
    })
    .expect("utype 解码");
    assert_eq!(back.component_alias, None);
    assert_eq!(back.args, vec![WireValue::U8(5)]);
}

// ---------------------------------------------------------------------------
// 属性更新流:别名 id 上界(父/子双臂)+ 布局闭包错误传播
// ---------------------------------------------------------------------------

/// 别名模式 parent>255 → AliasIdOverflow(parent.max(child))。
#[test]
fn wire_property_stream_alias_parent_overflow() {
    let entry = PropertyEntry {
        parent: 300,
        child: 1,
        kind: PropKind::Regular {
            layout: WireLayout::U8,
            value: WireValue::U8(1),
        },
    };
    let mut out = Vec::new();
    let err = encode_property_stream(EntityRef::Full(1), PropertyMode::Alias, &[entry], &mut out)
        .expect_err("parent 300 超 uint8");
    assert_eq!(err, WireError::AliasIdOverflow(300));
    // parent 300 且 child 400 → 取 max
    let entry = PropertyEntry {
        parent: 300,
        child: 400,
        kind: PropKind::Regular {
            layout: WireLayout::U8,
            value: WireValue::U8(1),
        },
    };
    let err = encode_property_stream(EntityRef::Full(1), PropertyMode::Alias, &[entry], &mut out)
        .expect_err("child 400 超 uint8");
    assert_eq!(err, WireError::AliasIdOverflow(400));
}

/// 解码期 layout_of_child 返回 Err → 整体 Err(组件子属性布局解析失败传播)。
#[test]
fn wire_property_stream_decode_layout_error_propagates() {
    // 先编码一条合法流,再用布局闭包 Err 解码:闭包错误必须传播而非吞掉。
    // parent≠0(组件子属性)→ 解码必然走 layout_of_child 闭包。
    let entry = PropertyEntry {
        parent: 5,
        child: 1,
        kind: PropKind::Regular {
            layout: WireLayout::U8,
            value: WireValue::U8(5),
        },
    };
    let mut out = Vec::new();
    encode_property_stream(EntityRef::Full(1), PropertyMode::Alias, &[entry], &mut out)
        .expect("编码合法流");
    assert!(!out.is_empty());
    let err = decode_property_stream(
        &out,
        EntityRefKind::Full,
        PropertyMode::Alias,
        &BasePropUtype::default(),
        |_parent, _child| Err(WireError::UnknownType("no-layout".into())),
    )
    .expect_err("布局闭包错误必须传播");
    assert_eq!(err, WireError::UnknownType("no-layout".into()));
}

/// STRING 编码拒绝非 ASCII(KODE-AUD-010 同族;嵌入 NUL 已有样例覆盖)。
#[test]
fn wire_value_str_rejects_non_ascii() {
    let mut out = Vec::new();
    let err = encode_value(&WireLayout::Str, &WireValue::Str("é".into()), &mut out)
        .expect_err("非 ASCII 必须报错");
    assert_eq!(err, WireError::NonAsciiString);
    assert_eq!(out, Vec::<u8>::new(), "失败不写字节");
}
