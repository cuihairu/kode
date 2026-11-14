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
use super::types::{EntityCallValue, WireField, WireLayout, WireValue};
use super::values::{decode_value, encode_value};

// ---------------------------------------------------------------------------
// 黄金样本(规范推导 + provenance;dump 内置往返自校验)
// ---------------------------------------------------------------------------

/// 提交侧 golden 相对仓库根路径(与 flag-domains 同约定)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/wire-parity.json";

/// schema 解析夹具(镜像 `tests/fixtures/kbengine-demo-assets/scripts/
/// entity_defs/types.xml` 的声明;内联而非读盘,保证 golden 再生成不依赖 cwd):
/// ITEM_ID→UINT16 别名链、SKILL_SLOT(FD:slot_list ARRAY<UINT32>+count)、
/// POSITION(x,y,z FLOAT)、ITEM_IDS ARRAY<ITEM_ID>;SER-14 增补面=
/// ITEM_CODE→ITEM_ID 深别名链、ROW/MATRIX 命名嵌套数组、MATRIX_INLINE
/// 内联嵌套(<of>ARRAY 递归,FixedArrayType::initialize 同构)、PROFILE
/// 嵌套 FD(POSITION 内嵌)、AVATAR_DATA(implementedBy 自定义转换,wire
/// 形不变 datatype.cpp:2169-2172)。
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
	<ITEM_CODE> ITEM_ID </ITEM_CODE>
	<ITEM_CODES>
		ARRAY
		<of> ITEM_CODE </of>
	</ITEM_CODES>
	<ROW>
		ARRAY
		<of> UINT8 </of>
	</ROW>
	<MATRIX>
		ARRAY
		<of> ROW </of>
	</MATRIX>
	<MATRIX_INLINE>
		ARRAY
		<of>
			ARRAY
			<of> UINT8 </of>
		</of>
	</MATRIX_INLINE>
	<PROFILE>
		FIXED_DICT
		<Properties>
			<pos>
				<Type> POSITION </Type>
			</pos>
			<badge>
				<Type> UNICODE </Type>
			</badge>
		</Properties>
	</PROFILE>
	<AVATAR_DATA>
		FIXED_DICT
		<implementedBy> proj.avatar_data.AvatarData </implementedBy>
		<Properties>
			<level>
				<Type> UINT32 </Type>
			</level>
			<code>
				<Type> ITEM_CODE </Type>
			</code>
		</Properties>
	</AVATAR_DATA>
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

    // -- SER-14:嵌套 ARRAY/FD、深别名链、自定义转换、容器内边界值--

    // 命名嵌套:ARRAY<ROW>,ROW=ARRAY<UINT8>;内嵌边界值 u8 max。
    let matrix_layout = schema.resolve("MATRIX").expect("resolve MATRIX");
    let matrix_value = WireValue::Array(vec![
        WireValue::Array(vec![WireValue::U8(255), WireValue::U8(0)]),
        WireValue::Array(vec![WireValue::U8(254), WireValue::U8(1)]),
    ]);
    let mut out = Vec::new();
    encode_value(&matrix_layout, &matrix_value, &mut out).expect("golden MATRIX encode");
    {
        let mut cur = WireCursor::new(&out);
        let back = decode_value(&matrix_layout, &mut cur).expect("golden MATRIX decode");
        assert_eq!(back, matrix_value, "MATRIX round-trip mismatch");
    }
    let matrix_hex = to_hex(&out);
    samples.push(serde_json::json!({
        "name": "nested_array_matrix_named",
        "provenance": "datatype.cpp FixedArrayType::initialize:<of> 命名类型按 DataTypes::getDataType 递归;夹具=ROW/MATRIX 命名两跳;u8=255 边界值内嵌",
        "kind": "value",
        "layout": matrix_layout,
        "value": matrix_value,
        "hex": matrix_hex,
    }));

    // 内联嵌套(<of>ARRAY 递归)与命名嵌套同布局同字节——两条路一条线。
    let matrix_inline_layout = schema
        .resolve("MATRIX_INLINE")
        .expect("resolve MATRIX_INLINE");
    let mut out = Vec::new();
    encode_value(&matrix_inline_layout, &matrix_value, &mut out)
        .expect("golden MATRIX_INLINE encode");
    {
        let mut cur = WireCursor::new(&out);
        let back =
            decode_value(&matrix_inline_layout, &mut cur).expect("golden MATRIX_INLINE decode");
        assert_eq!(back, matrix_value, "MATRIX_INLINE round-trip mismatch");
    }
    let inline_hex = to_hex(&out);
    assert_eq!(inline_hex, matrix_hex, "内联与命名嵌套布局必须同字节");
    samples.push(serde_json::json!({
        "name": "nested_array_inline_parity",
        "provenance": "datatype.cpp FixedArrayType::initialize:strType==\"ARRAY\" 即内联递归(与命名同构);布局重解析两条路(schema.rs raw_type_from_element ARRAY 臂递归)同字节",
        "kind": "value",
        "layout": matrix_inline_layout,
        "value": matrix_value,
        "hex": inline_hex,
    }));

    // 空数组边界:count=0,仅 4B 计数前缀。
    let mut out = Vec::new();
    encode_value(&item_ids_layout, &WireValue::Array(vec![]), &mut out)
        .expect("golden empty ARRAY encode");
    {
        let mut cur = WireCursor::new(&out);
        let back = decode_value(&item_ids_layout, &mut cur).expect("golden empty ARRAY decode");
        assert_eq!(back, WireValue::Array(vec![]), "empty ARRAY round-trip");
    }
    samples.push(serde_json::json!({
        "name": "empty_array_count_zero",
        "provenance": "datatype.cpp:1837-1846 ARRAY=u32 元素数(0 合法)+无元素字节;u16 max/0 边界值不入此样本(见 alias_chain_array)",
        "kind": "value",
        "layout": item_ids_layout,
        "value": WireValue::Array(vec![]),
        "hex": to_hex(&out),
    }));

    // 深别名链:ARRAY<ITEM_CODES 元素 ITEM_CODE→ITEM_ID→UINT16>;链端边界值。
    let codes_layout = schema.resolve("ITEM_CODES").expect("resolve ITEM_CODES");
    let codes_value = WireValue::Array(vec![WireValue::U16(65535), WireValue::U16(0)]);
    let mut out = Vec::new();
    encode_value(&codes_layout, &codes_value, &mut out).expect("golden ITEM_CODES encode");
    {
        let mut cur = WireCursor::new(&out);
        let back = decode_value(&codes_layout, &mut cur).expect("golden ITEM_CODES decode");
        assert_eq!(back, codes_value, "alias chain round-trip");
    }
    samples.push(serde_json::json!({
        "name": "alias_chain_two_hop",
        "provenance": "datatype.cpp resolve 别名链逐跳 DataTypes::getDataType(ITEM_CODE→ITEM_ID→UINT16);链端 u16 max/0 边界值;夹具=ITEM_CODE/ITEM_CODES",
        "kind": "value",
        "layout": codes_layout,
        "value": codes_value,
        "hex": to_hex(&out),
    }));

    // 嵌套 FIXED_DICT:FD 字段引用命名 FD(POSITION),声明序逐键无键名。
    let profile_layout = schema.resolve("PROFILE").expect("resolve PROFILE");
    let profile_value = WireValue::FixedDict(vec![
        WireValue::FixedDict(vec![
            WireValue::F32(1.5),
            WireValue::F32(2.5),
            WireValue::F32(3.5),
        ]),
        WireValue::Unicode("✓".as_bytes().to_vec()),
    ]);
    let mut out = Vec::new();
    encode_value(&profile_layout, &profile_value, &mut out).expect("golden PROFILE encode");
    {
        let mut cur = WireCursor::new(&out);
        let back = decode_value(&profile_layout, &mut cur).expect("golden PROFILE decode");
        assert_eq!(back, profile_value, "PROFILE round-trip");
    }
    samples.push(serde_json::json!({
        "name": "nested_fixed_dict_profile",
        "provenance": "datatype.cpp:2592-2660 FixedDict=声明序逐键(嵌套键无键名);内嵌 UNICODE=u32 长度+UTF-8(「✓」3B 多字节边界);夹具=PROFILE(pos=POSITION,badge)",
        "kind": "value",
        "layout": profile_layout,
        "value": profile_value,
        "hex": to_hex(&out),
    }));

    // 自定义转换(implementedBy):wire 形=FD 布局原样(datatype.cpp:2169-2172
    // implementedBy 只登记转换,wire 不变);布局重解析必须无视 implementedBy
    // 元素,链端字段走别名 ITEM_CODE;u32 max 边界值内嵌。
    let avatar_layout = schema.resolve("AVATAR_DATA").expect("resolve AVATAR_DATA");
    assert_eq!(
        avatar_layout,
        WireLayout::FixedDict(vec![
            WireField {
                name: "level".to_string(),
                layout: WireLayout::U32,
            },
            WireField {
                name: "code".to_string(),
                layout: WireLayout::U16,
            },
        ]),
        "implementedBy 不得改变 wire 布局"
    );
    let avatar_value = WireValue::FixedDict(vec![WireValue::U32(4294967295), WireValue::U16(7)]);
    let mut out = Vec::new();
    encode_value(&avatar_layout, &avatar_value, &mut out).expect("golden AVATAR_DATA encode");
    {
        let mut cur = WireCursor::new(&out);
        let back = decode_value(&avatar_layout, &mut cur).expect("golden AVATAR_DATA decode");
        assert_eq!(back, avatar_value, "AVATAR_DATA round-trip");
    }
    samples.push(serde_json::json!({
        "name": "implemented_by_conversion_wire_unchanged",
        "provenance": "datatype.cpp:2169-2172/:2203-2208 implementedBy=内存侧转换登记(STRUCT-07:内存形式=实现类,键位面=传输形式);wire 形=FD 声明序原样,字段链 ITEM_CODE→UINT16;u32 max 边界值",
        "kind": "value",
        "layout": avatar_layout,
        "value": avatar_value,
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
        // SER-14 诚实声明(验收:引擎未运行的项不标成真实往返通过):
        // 全部样本 = 规范推导(引擎源码锚在 provenance)的编解码自洽往返;
        // 「往返通过」= codec 双向自一致 + 源码读序锚,**非引擎执行捕获**。
        // 引擎实测字节捕获(真跑 KBEngine dump 线上流)= 独立车道,未执行。
        "engine_execution": "not-run: canonical-derivation self-round-trips only (engine source anchors in provenance); no engine-executed capture",
        "samples": samples,
    });
    serde_json::to_string(&value).expect("serialize wire golden")
}
