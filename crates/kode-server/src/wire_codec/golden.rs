// ---------------------------------------------------------------------------
// 黄金样本(规范推导 + provenance;dump 内置往返自校验)
// ---------------------------------------------------------------------------

use std::collections::BTreeMap;

use super::cursor::WireCursor;
use super::errors::WireError;
use super::hex::to_hex;
use super::message_frame::{decode_message_frame, encode_message_frame};
use super::method_args::{decode_method_args, encode_method_args, MethodCall, MethodRef};
use super::property_stream::{
    decode_property_stream, encode_property_stream, BasePropUtype, EntityRef, EntityRefKind,
    PropKind, PropertyEntry, PropertyMode,
};
use super::schema::WireSchema;
use super::types::{EntityCallValue, WireLayout, WireValue};
use super::values::{decode_value, encode_value};

// ---------------------------------------------------------------------------
// 黄金样本(规范推导 + provenance;dump 内置往返自校验)
// ---------------------------------------------------------------------------

/// 提交侧 golden 相对仓库根路径(与 flag-domains 同约定)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/wire-parity.json";

/// schema 解析夹具(镜像 `tests/fixtures/kbengine-demo-assets/scripts/
/// entity_defs/types.xml` 的声明;内联而非读盘,保证 golden 再生成不依赖 cwd):
/// ITEM_ID→UINT16 别名链、SKILL_SLOT(FD:slot_list ARRAY<UINT32>+count)、
/// POSITION(x,y,z FLOAT)、ITEM_IDS ARRAY<ITEM_ID>。
pub const SCHEMA_FIXTURE_XML: &str = r#"<root>
	<ITEM_ID> UINT16 </ITEM_ID>
	<ITEM_DESC> STRING </ITEM_DESC>
	<SKILL_SLOT>
		FIXED_DICT
		<Properties>
			<slot_list>
				<Type>
					ARRAY
					<of> UINT32 </of>
				</Type>
			</slot_list>
			<count>
				<Type> UINT32 </Type>
			</count>
		</Properties>
	</SKILL_SLOT>
	<POSITION>
		FIXED_DICT
		<Properties>
			<x>
				<Type> FLOAT </Type>
			</x>
			<y>
				<Type> FLOAT </Type>
			</y>
			<z>
				<Type> FLOAT </Type>
			</z>
		</Properties>
	</POSITION>
	<ITEM_IDS>
		ARRAY
		<of> ITEM_ID </of>
	</ITEM_IDS>
</root>"#;

/// 黄金样本(规范推导,kbengine 源引在 provenance)。每样本先编码成 hex,
/// 再解码回放并断言与输入一致(往返自校验,镜像 flag_domains CANONICAL 断言)。
pub fn dump_wire_golden() -> String {
    let mut samples: Vec<serde_json::Value> = Vec::new();

    // -- 标量/内建往返(边界值;每条独立 provenance)--
    let scalar_cases: &[(&str, &str, WireLayout, WireValue)] = &[
        (
            "u8_min_max",
            "memorystream.h:259-263 uint8 LE 1B(datatype.cpp:199)",
            WireLayout::U8,
            WireValue::U8(255),
        ),
        (
            "u16_max",
            "memorystream.h:265-269 uint16 LE 2B",
            WireLayout::U16,
            WireValue::U16(65535),
        ),
        (
            "u32_max",
            "memorystream.h:271-275 uint32 LE 4B",
            WireLayout::U32,
            WireValue::U32(4294967295),
        ),
        (
            "u64_max",
            "memorystream.h:277-281 uint64 LE 8B",
            WireLayout::U64,
            WireValue::U64(18446744073709551615),
        ),
        (
            "i8_min",
            "memorystream.h:283-287 int8 LE 1B",
            WireLayout::I8,
            WireValue::I8(-128),
        ),
        (
            "i16_min",
            "memorystream.h:289-293 int16 LE 2B",
            WireLayout::I16,
            WireValue::I16(-32768),
        ),
        (
            "i32_min",
            "memorystream.h:295-299 int32 LE 4B(ENTITY_ID 同宽 platform.h:342)",
            WireLayout::I32,
            WireValue::I32(-2147483648),
        ),
        (
            "i64_min",
            "memorystream.h:301-305 int64 LE 8B",
            WireLayout::I64,
            WireValue::I64(-9223372036854775808),
        ),
        (
            "f32_negative_sub",
            "memorystream.h:307-311 float IEEE754 LE(datatype.cpp:540)",
            WireLayout::F32,
            WireValue::F32(-0.25),
        ),
        (
            "f64_pi",
            "memorystream.h:313-317 double IEEE754 LE(datatype.cpp:630)",
            WireLayout::F64,
            WireValue::F64(std::f64::consts::PI),
        ),
        (
            "bool_true_false",
            "memorystream.h:247-251 bool=1B int8 非零→true",
            WireLayout::Bool,
            WireValue::Bool(true),
        ),
        (
            "string_ascii",
            "memorystream.h:224-229 编码=字节+0x00;无长度前缀",
            WireLayout::Str,
            WireValue::Str("hello".to_string()),
        ),
        (
            "string_empty",
            "memorystream.h:224-229 空串=单字节 0x00",
            WireLayout::Str,
            WireValue::Str(String::new()),
        ),
        (
            "unicode_utf8",
            "datatype.cpp:1129-1142 UNICODE=u32 长度+UTF-8 字节(appendBlob)",
            WireLayout::Unicode,
            WireValue::Unicode("你好".as_bytes().to_vec()),
        ),
        (
            "blob_short",
            "memorystream.h:551-556 appendBlob=u32 长度+字节",
            WireLayout::Blob,
            WireValue::Blob(vec![0xde, 0xad, 0xbe, 0xef]),
        ),
        (
            "python_pickle_frame",
            "datatype.cpp:1225-1229 PYTHON=pickle 字节走 appendBlob;字节不透明透传",
            WireLayout::Py,
            WireValue::Py(vec![0x80, 0x04, 0x95, 0x02, 0x00, 0x00, 0x00, 0x4b, 0x2e]),
        ),
        (
            "py_dict_pickle_frame",
            "datatype.cpp:1288-1296 PyDict=同 pickle 框架",
            WireLayout::PyDict,
            WireValue::PyDict(vec![
                0x80, 0x04, 0x95, 0x04, 0x00, 0x00, 0x00, 0x7d, 0x94, 0x2e,
            ]),
        ),
        (
            "py_tuple_pickle_frame",
            "datatype.cpp:1344-1352 PyTuple=同 pickle 框架",
            WireLayout::PyTuple,
            WireValue::PyTuple(vec![
                0x80, 0x04, 0x95, 0x04, 0x00, 0x00, 0x00, 0x29, 0x94, 0x2e,
            ]),
        ),
        (
            "py_list_pickle_frame",
            "datatype.cpp:1400-1408 PyList=同 pickle 框架",
            WireLayout::PyList,
            WireValue::PyList(vec![
                0x80, 0x04, 0x95, 0x04, 0x00, 0x00, 0x00, 0x5d, 0x94, 0x2e,
            ]),
        ),
        (
            "entitycall_full",
            "datatype.cpp:1512-1573 id(i32)+cid(u64 platform.h:345)+type(u16)+utype(u16)=16B 定长",
            WireLayout::EntityCall,
            WireValue::EntityCall(EntityCallValue {
                id: 1001,
                component_id: 0x0000_0000_0000_0020,
                call_type: 1,
                script_uid: 5,
            }),
        ),
        (
            "entitycall_null",
            "datatype.cpp:1540-1552 pyValue==None → 全零字段仍 16B",
            WireLayout::EntityCall,
            WireValue::EntityCall(EntityCallValue::default()),
        ),
        (
            "vector2",
            "datatype.cpp:737 VECTOR2=2×float 连续 LE 无前缀",
            WireLayout::Vec2,
            WireValue::Vec2([1.5, -2.25]),
        ),
        (
            "vector3",
            "datatype.cpp:841 VECTOR3=3×float LE",
            WireLayout::Vec3,
            WireValue::Vec3([1.0, 2.0, 3.0]),
        ),
        (
            "vector4",
            "datatype.cpp:946 VECTOR4=4×float LE",
            WireLayout::Vec4,
            WireValue::Vec4([0.5, 0.25, 0.125, 0.0625]),
        ),
    ];
    for (name, provenance, layout, value) in scalar_cases {
        let mut out = Vec::new();
        encode_value(layout, value, &mut out).expect("golden scalar encode");
        let mut cur = WireCursor::new(&out);
        let back = decode_value(layout, &mut cur).expect("golden scalar decode round-trip");
        assert_eq!(&back, value, "golden sample {name} round-trip mismatch");
        samples.push(serde_json::json!({
            "name": name,
            "provenance": provenance,
            "kind": "value",
            "layout": layout,
            "value": value,
            "hex": to_hex(&out),
        }));
    }

    // -- 容器(schema 解析的 SKILL_SLOT/POSITION/ITEM_IDS 布局逐字节)--
    let schema = WireSchema::from_sources(SCHEMA_FIXTURE_XML, "");
    let skill_slot_layout = schema.resolve("SKILL_SLOT").expect("resolve SKILL_SLOT");
    let skill_slot_value = WireValue::FixedDict(vec![
        WireValue::Array(vec![WireValue::U32(10), WireValue::U32(20)]),
        WireValue::U32(2),
    ]);
    let mut out = Vec::new();
    encode_value(&skill_slot_layout, &skill_slot_value, &mut out)
        .expect("golden SKILL_SLOT encode");
    let mut cur = WireCursor::new(&out);
    let back = decode_value(&skill_slot_layout, &mut cur).expect("golden SKILL_SLOT decode");
    assert_eq!(back, skill_slot_value, "SKILL_SLOT round-trip mismatch");
    samples.push(serde_json::json!({
        "name": "fixed_dict_skill_slot",
        "provenance": "datatype.cpp:2592-2660 FixedDict=声明序逐键(无键名/无计数);键序=vector push 序 datatype.h:691;夹具=tests/fixtures/kbengine-demo-assets/scripts/entity_defs/types.xml SKILL_SLOT",
        "kind": "value",
        "layout": skill_slot_layout,
        "value": skill_slot_value,
        "hex": to_hex(&out),
    }));

    let item_ids_layout = schema.resolve("ITEM_IDS").expect("resolve ITEM_IDS");
    let item_ids_value = WireValue::Array(vec![WireValue::U16(7), WireValue::U16(9)]);
    let mut out = Vec::new();
    encode_value(&item_ids_layout, &item_ids_value, &mut out).expect("golden ITEM_IDS encode");
    let mut cur = WireCursor::new(&out);
    let back = decode_value(&item_ids_layout, &mut cur).expect("golden ITEM_IDS decode");
    assert_eq!(back, item_ids_value, "ITEM_IDS round-trip mismatch");
    samples.push(serde_json::json!({
        "name": "array_of_alias_item_ids",
        "provenance": "datatype.cpp:1837-1846 ARRAY=u32 元素数+各元素按 <of>;元素走别名 ITEM_ID→UINT16;夹具=tests/fixtures/kbengine-demo-assets/scripts/entity_defs/types.xml ITEM_IDS",
        "kind": "value",
        "layout": item_ids_layout,
        "value": item_ids_value,
        "hex": to_hex(&out),
    }));

    // -- 属性更新流(Account.def 字母序快照;别名/utype 两模式 + special base)--
    let account_entries_alias: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 4, // 别名 id:accountName(字母序属性别名从 4 起)
            kind: PropKind::Regular {
                layout: WireLayout::Str,
                value: WireValue::Str("player1".to_string()),
            },
        },
        PropertyEntry {
            parent: 0,
            child: 5, // 别名 id:lastLoginTime
            kind: PropKind::Regular {
                layout: WireLayout::U32,
                value: WireValue::U32(1735689600),
            },
        },
    ];
    let (out, entity, mode, base) = {
        let mut out = Vec::new();
        encode_property_stream(
            EntityRef::Full(100),
            PropertyMode::Alias,
            &account_entries_alias,
            &mut out,
        )
        .expect("golden prop stream alias encode");
        (
            out,
            EntityRef::Full(100),
            PropertyMode::Alias,
            BasePropUtype::default(),
        )
    };
    {
        let layouts: BTreeMap<u16, WireLayout> = account_entries_alias
            .iter()
            .filter_map(|e| match &e.kind {
                PropKind::Regular { layout, .. } => Some((e.child, layout.clone())),
                _ => None,
            })
            .collect();
        let (back_entity, back_entries) =
            decode_property_stream(&out, EntityRefKind::Full, mode, &base, |_parent, child| {
                layouts
                    .get(&child)
                    .cloned()
                    .ok_or_else(|| WireError::UnknownType(format!("child {child}")))
            })
            .expect("golden prop stream alias decode");
        assert_eq!(back_entity, entity, "prop stream entity round-trip");
        assert_eq!(
            back_entries, account_entries_alias,
            "prop stream alias entries"
        );
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_account_alias",
        "provenance": "clientobjectbase.cpp:1113-1119 ENTITY_ID=int32;client_lib/entity.cpp:271-276 别名=parent u8+child u8;全量快照按属性名字母序(getClientPropertyDescriptions 是 std::map);Account.def 夹具 accountName/lastLoginTime BASE_AND_CLIENT",
        "kind": "property_stream",
        "input": {
            "entity": entity,
            "mode": mode,
            "base": base,
            "entries": account_entries_alias,
        },
        "hex": to_hex(&out),
    }));

    let account_entries_utype: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 1, // utype:def 解析序 accountName=1
            kind: PropKind::Regular {
                layout: WireLayout::Str,
                value: WireValue::Str("player1".to_string()),
            },
        },
        PropertyEntry {
            parent: 0,
            child: 2, // utype:lastLoginTime=2
            kind: PropKind::Regular {
                layout: WireLayout::U32,
                value: WireValue::U32(1735689600),
            },
        },
    ];
    let mut out = Vec::new();
    encode_property_stream(
        EntityRef::Full(100),
        PropertyMode::Utype,
        &account_entries_utype,
        &mut out,
    )
    .expect("golden prop stream utype encode");
    {
        let layouts: BTreeMap<u16, WireLayout> = account_entries_utype
            .iter()
            .filter_map(|e| match &e.kind {
                PropKind::Regular { layout, .. } => Some((e.child, layout.clone())),
                _ => None,
            })
            .collect();
        let (back_entity, back_entries) = decode_property_stream(
            &out,
            EntityRefKind::Full,
            PropertyMode::Utype,
            &BasePropUtype::default(),
            |_parent, child| {
                layouts
                    .get(&child)
                    .cloned()
                    .ok_or_else(|| WireError::UnknownType(format!("child {child}")))
            },
        )
        .expect("golden prop stream utype decode");
        assert_eq!(back_entity, EntityRef::Full(100));
        assert_eq!(
            back_entries, account_entries_utype,
            "prop stream utype entries"
        );
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_account_utype",
        "provenance": "client_lib/entity.cpp:277-280 非=alias:parent u16+child u16(ENTITY_PROPERTY_UID uint16 common.h:80);属性 utype def 解析序从 1(entitydef.cpp:1020-1094)",
        "kind": "property_stream",
        "input": {
            "entity": EntityRef::Full(100),
            "mode": PropertyMode::Utype,
            "base": BasePropUtype::default(),
            "entries": account_entries_utype,
        },
        "hex": to_hex(&out),
    }));

    // special base props:position/direction/spaceID(alias 模式恒 1/2/3)+
    // 普通属性混排(普通条目跟在 special 后,child 4 起)。
    let special_entries: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 1,
            kind: PropKind::Position {
                x: 1.5,
                y: 2.5,
                z: 3.5,
            },
        },
        PropertyEntry {
            parent: 0,
            child: 2,
            kind: PropKind::Direction {
                roll: 0.0,
                pitch: std::f32::consts::FRAC_PI_2,
                yaw: std::f32::consts::PI,
            },
        },
        PropertyEntry {
            parent: 0,
            child: 3,
            kind: PropKind::SpaceId(42),
        },
    ];
    let mut out = Vec::new();
    encode_property_stream(
        EntityRef::Alias(7),
        PropertyMode::Alias,
        &special_entries,
        &mut out,
    )
    .expect("golden prop stream special encode");
    {
        let (back_entity, back_entries) = decode_property_stream(
            &out,
            EntityRefKind::Alias,
            PropertyMode::Alias,
            &BasePropUtype::default(),
            |_parent, child| Err(WireError::UnknownType(format!("child {child}"))),
        )
        .expect("golden prop stream special decode");
        assert_eq!(
            back_entity,
            EntityRef::Alias(7),
            "alias entity id round-trip"
        );
        assert_eq!(back_entries, special_entries, "special base prop entries");
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_special_base_alias",
        "provenance": "entity_macro.h:125-129 ADD_POS_DIR_TO_STREAM_ALIASID=u8 0+aliasID+3×f32(pos→1 dir→2,common.h:118-120);spaceID u32(entity.cpp:343-348);*Optimized 实体 id=u8 视图别名 clientobjectbase.cpp:1121-1126/399-432",
        "kind": "property_stream",
        "input": {
            "entity": EntityRef::Alias(7),
            "mode": PropertyMode::Alias,
            "base": BasePropUtype::default(),
            "entries": special_entries,
        },
        "hex": to_hex(&out),
    }));

    // utype 模式 special(fixed_messages 默认 40000/40001/40002)+ 组件属性(parent≠0)。
    let special_utype_entries: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 40000, // Property::position fixed msgid(messages_fixed_defaults.xml:388)
            kind: PropKind::Position {
                x: -1.0,
                y: 0.0,
                z: 8.25,
            },
        },
        PropertyEntry {
            parent: 6, // 组件属性 utype(此处示意 6)
            child: 1,  // 组件内子属性 utype
            kind: PropKind::Regular {
                layout: WireLayout::U16,
                value: WireValue::U16(910),
            },
        },
    ];
    let mut out = Vec::new();
    encode_property_stream(
        EntityRef::Full(200),
        PropertyMode::Utype,
        &special_utype_entries,
        &mut out,
    )
    .expect("golden prop stream special utype encode");
    {
        let (back_entity, back_entries) = decode_property_stream(
            &out,
            EntityRefKind::Full,
            PropertyMode::Utype,
            &BasePropUtype::default(),
            |_parent, child| {
                if child == 1 {
                    Ok(WireLayout::U16)
                } else {
                    Err(WireError::UnknownType(format!("child {child}")))
                }
            },
        )
        .expect("golden prop stream special utype decode");
        assert_eq!(back_entity, EntityRef::Full(200));
        assert_eq!(back_entries, special_utype_entries, "special utype entries");
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_special_and_component_utype",
        "provenance": "entity_macro.h:120-122 ADD_POS_DIR_TO_STREAM=u16 0+utype+3×f32;组件条目 parent≠0(entity.cpp:370-390);utype 模式特殊 id=FixedMessages::isFixed(\"Property::position/direction/spaceID\") 默认 40000/40001/40002(messages_fixed_defaults.xml:387-402)",
        "kind": "property_stream",
        "input": {
            "entity": EntityRef::Full(200),
            "mode": PropertyMode::Utype,
            "base": BasePropUtype::default(),
            "entries": special_utype_entries,
        },
        "hex": to_hex(&out),
    }));

    // -- 方法调用参数(Account.def reqCreateAvatar Exposed Arg STRING)--
    let call_alias = MethodCall {
        component_alias: None,
        method: MethodRef::Alias(1), // ClientMethods 别名从 1 起
        args: vec![WireValue::Str("warrior".to_string())],
        arg_layouts: vec![WireLayout::Str],
    };
    let mut out = Vec::new();
    encode_method_args(&call_alias, PropertyMode::Alias, &mut out)
        .expect("golden method alias encode");
    {
        let back = decode_method_args(&out, PropertyMode::Alias, |_component, m| match m {
            MethodRef::Alias(1) => Ok(vec![WireLayout::Str]),
            other => Err(WireError::UnknownType(format!("method {other:?}"))),
        })
        .expect("golden method alias decode");
        assert_eq!(back, call_alias, "method alias round-trip");
    }
    samples.push(serde_json::json!({
        "name": "method_args_req_create_avatar_alias",
        "provenance": "client_lib/entity.cpp:169-182 别名=u8 componentPropertyAliasID(0=本实体)+u8 aliasID;实参无计数前缀 method.cpp:146-176;Account.def reqCreateAvatar Exposed Arg STRING",
        "kind": "method_call",
        "input": { "mode": PropertyMode::Alias, "call": call_alias },
        "hex": to_hex(&out),
    }));

    let call_utype = MethodCall {
        component_alias: None,
        method: MethodRef::Utype(1),
        args: vec![WireValue::Str("archer".to_string())],
        arg_layouts: vec![WireLayout::Str],
    };
    let mut out = Vec::new();
    encode_method_args(&call_utype, PropertyMode::Utype, &mut out)
        .expect("golden method utype encode");
    {
        let back = decode_method_args(&out, PropertyMode::Utype, |_component, m| match m {
            MethodRef::Utype(1) => Ok(vec![WireLayout::Str]),
            other => Err(WireError::UnknownType(format!("method {other:?}"))),
        })
        .expect("golden method utype decode");
        assert_eq!(back, call_utype, "method utype round-trip");
    }
    samples.push(serde_json::json!({
        "name": "method_args_req_create_avatar_utype",
        "provenance": "client_lib/entity.cpp:184-190 非=alias:u16 utype(component uid 恒 0 不读流,entity.cpp:170-181);方法 utype=uint16",
        "kind": "method_call",
        "input": { "mode": PropertyMode::Utype, "call": call_utype },
        "hex": to_hex(&out),
    }));

    // -- 消息帧(变长;<65535;定长)--
    let frame_bodies: &[(&str, &str, u16, Vec<u8>, bool)] = &[
        (
            "frame_variable_short",
            "bundle.cpp:273-395 msgid u16+变长 u16 长度(=载荷不含 4 头字节)",
            9,
            vec![0x01, 0x02, 0x03],
            true,
        ),
        (
            "frame_variable_empty",
            "bundle.cpp:346-347 回填长度=currMsgLength_-ID_SIZE-LENGTH_SIZE",
            1000,
            Vec::new(),
            true,
        ),
        (
            "frame_fixed",
            "bundle.cpp:304-309 定长消息无长度字段",
            5,
            vec![0xAA, 0xBB],
            false,
        ),
    ];
    for (name, provenance, msg_id, body, variable) in frame_bodies {
        let mut out = Vec::new();
        encode_message_frame(*msg_id, body, *variable, &mut out).expect("golden frame encode");
        let mut cur = WireCursor::new(&out);
        let (back_id, back_body) = decode_message_frame(&mut cur, *variable, Some(body.len()))
            .expect("golden frame decode");
        assert_eq!(back_id, *msg_id, "frame id round-trip {name}");
        assert_eq!(&back_body, body, "frame body round-trip {name}");
        samples.push(serde_json::json!({
            "name": name,
            "provenance": provenance,
            "kind": "message_frame",
            "input": {
                "msg_id": msg_id,
                "variable_length": variable,
                "body_hex": to_hex(body),
            },
            "hex": to_hex(&out),
        }));
    }
    // 注:≥65535 扩展长帧(bundle.cpp:358-371,u16=65535+u32 扩展)体量 64KiB+,
    // 不入 golden(保持单行 JSON 紧凑),由 wire_codec_units.rs 单测覆盖。

    let value = serde_json::json!({
        "generator": "kode-server dump-wire-golden",
        "samples": samples,
    });
    serde_json::to_string(&value).expect("serialize wire golden")
}
