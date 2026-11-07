//! PA-003 验收测试(红先行):cursor / codec / 动态消息表 / entity / session。
//!
//! 引擎语义依据 docs/kbengine-wire-protocol.md(PA-001 取证,基准 bf1a9cd6
//! / v2.5.10);固定消息表快照与 PA-002 同源(tests/fixtures)。

use kode_kbengine_protocol::codec::{DecodeLimits, Value};
use kode_kbengine_protocol::cursor::Cursor;
use kode_kbengine_protocol::error::DecodeErrorKind;
use kode_kbengine_protocol::messages::MessageMap;
use kode_kbengine_protocol::session::{ComponentRole, Phase, Session};
use kode_kbengine_schema::messages::{build_message_table, MessageLength};
use kode_kbengine_schema::wire::{DictField, WireType};

fn engine_defaults_xml() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/messages_fixed_defaults.xml"
    ))
    .unwrap()
}

fn static_map() -> MessageMap {
    let table = build_message_table(&engine_defaults_xml(), None);
    MessageMap::from_static(&table)
}

// ---------------------------------------------------------------------------
// cursor:零拷贝标量读取 + 边界(§3)
// ---------------------------------------------------------------------------

#[test]
fn cursor_reads_le_scalars() {
    let data = [0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
    let mut c = Cursor::new(&data);
    assert_eq!(c.read_u8().unwrap(), 0x01);
    assert_eq!(c.read_u16().unwrap(), 0x0302); // 小端
    assert_eq!(c.read_u32().unwrap(), 0x07060504);
    assert_eq!(c.offset(), 7);
    assert!(c.read_u16().is_err()); // 不越界、不 panic
}

#[test]
fn cursor_string_engine_semantics() {
    // STRING:NUL 结尾无前缀;读端遇非 ASCII(≥0x80)提前截断
    // (memorystream.h:319-332)。
    let mut c = Cursor::new(b"abc\0def");
    assert_eq!(c.read_cstring().unwrap(), "abc");
    assert_eq!(c.offset(), 4);

    let mut c = Cursor::new(&[0x61, 0xe4, 0xb8, 0xad, 0x00]);
    assert_eq!(c.read_cstring().unwrap(), "a"); // 0xe4 非 ASCII → 截断
    assert_eq!(c.offset(), 1);

    // 无 NUL 也不 panic:读到尾
    let mut c = Cursor::new(b"tail");
    assert_eq!(c.read_cstring().unwrap(), "tail");
}

#[test]
fn cursor_prefixed_blob_and_eof_never_panic() {
    // UNICODE/BLOB:u32 长度 + 内容(datatype.cpp:1129-1143,1448-1463)
    let mut v = 5u32.to_le_bytes().to_vec();
    v.extend_from_slice(b"hello");
    let mut c = Cursor::new(&v);
    assert_eq!(c.read_blob(&DecodeLimits::default()).unwrap(), b"hello");

    // 长度声明超出剩余 → 错误(带 offset),不 panic、不越界分配
    let mut c = Cursor::new(&[0xffu8, 0xff, 0xff, 0xff]);
    let err = c.read_blob(&DecodeLimits::default()).unwrap_err();
    // u32 长度已读(4B)后才发现越限
    assert_eq!(err.offset, 4);
    assert!(matches!(
        err.kind,
        DecodeErrorKind::UnexpectedEof | DecodeErrorKind::MemoryLimit
    ));
}

// ---------------------------------------------------------------------------
// codec:基础类型 + containers(ARRAY / FIXED_DICT)
// ---------------------------------------------------------------------------

#[test]
fn codec_primitives_roundtrip_shapes() {
    let limits = DecodeLimits::default();
    let mut v = Vec::new();
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&2.5f32.to_le_bytes());
    v.extend_from_slice(&[1]); // bool=1
    let mut c = Cursor::new(&v);
    assert_eq!(
        kode_kbengine_protocol::codec::decode_value(&WireType::UInt32, &mut c, &limits, 0).unwrap(),
        Value::UInt(1)
    );
    let f =
        kode_kbengine_protocol::codec::decode_value(&WireType::Float, &mut c, &limits, 0).unwrap();
    assert!(matches!(f, Value::Float(x) if (x - 2.5).abs() < 1e-6));
    assert_eq!(
        kode_kbengine_protocol::codec::decode_value(&WireType::Bool, &mut c, &limits, 0).unwrap(),
        Value::Bool(true)
    );
}

#[test]
fn codec_unicode_blob_array_fixed_dict() {
    let limits = DecodeLimits::default();

    // UNICODE: u32 len + utf8
    let body = "玩家A".as_bytes();
    let mut v = (body.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(body);
    let mut c = Cursor::new(&v);
    assert_eq!(
        kode_kbengine_protocol::codec::decode_value(&WireType::Unicode, &mut c, &limits, 0)
            .unwrap(),
        Value::Str("玩家A".into())
    );

    // ARRAY<UINT32>: u32 count + elems(datatype.cpp:1837-1856)
    let mut v = 3u32.to_le_bytes().to_vec();
    for i in 0..3u32 {
        v.extend_from_slice(&i.to_le_bytes());
    }
    let mut c = Cursor::new(&v);
    let arr = kode_kbengine_protocol::codec::decode_value(
        &WireType::Array {
            of: Box::new(WireType::UInt32),
        },
        &mut c,
        &limits,
        0,
    )
    .unwrap();
    assert_eq!(
        arr,
        Value::Array(vec![Value::UInt(0), Value::UInt(1), Value::UInt(2)])
    );

    // FIXED_DICT:声明序、不带键名(datatype.cpp:2592+)
    let mut v = Vec::new();
    v.extend_from_slice(&1.0f32.to_le_bytes());
    v.extend_from_slice(&2.0f32.to_le_bytes());
    v.extend_from_slice(&3.0f32.to_le_bytes());
    let dict = WireType::FixedDict {
        module: Some("POSITION_DATA.position_inst".into()),
        fields: vec![
            DictField {
                name: "x".into(),
                ty: Box::new(WireType::Float),
            },
            DictField {
                name: "y".into(),
                ty: Box::new(WireType::Float),
            },
            DictField {
                name: "z".into(),
                ty: Box::new(WireType::Float),
            },
        ],
    };
    let mut c = Cursor::new(&v);
    let d = kode_kbengine_protocol::codec::decode_value(&dict, &mut c, &limits, 0).unwrap();
    match d {
        Value::Dict(fields) => {
            assert_eq!(
                fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
                ["x", "y", "z"]
            );
        }
        other => panic!("expected Dict, got {other:?}"),
    }
}

#[test]
fn codec_unknown_and_entitycall_kept_raw() {
    let limits = DecodeLimits::default();
    // 未知类型:Raw 保留剩余字节(红线:未知类型 Raw 保留)
    let mut c = Cursor::new(&[0xde, 0xad, 0xbe, 0xef]);
    let v = kode_kbengine_protocol::codec::decode_value(
        &WireType::Unresolved("MYSTERY".into()),
        &mut c,
        &limits,
        0,
    )
    .unwrap();
    match v {
        Value::Raw(raw) => {
            assert_eq!(raw.bytes, vec![0xde, 0xad, 0xbe, 0xef]);
            assert!(!raw.reason.is_empty());
        }
        other => panic!("expected Raw, got {other:?}"),
    }
    // ENTITYCALL:PA-001 TODO-2(线格式未逐字节取证)→ Raw 不编造
    let mut c = Cursor::new(&[1, 2, 3, 4]);
    assert!(matches!(
        kode_kbengine_protocol::codec::decode_value(&WireType::EntityCall, &mut c, &limits, 0)
            .unwrap(),
        Value::Raw(_)
    ));
}

#[test]
fn codec_memory_and_depth_limits() {
    let limits = DecodeLimits::default();
    // u32::MAX 数组声明 + 截断输入 → 错误,无爆炸分配
    let mut c = Cursor::new(&[0xffu8, 0xff, 0xff, 0xff, 1, 2, 3]);
    let err = kode_kbengine_protocol::codec::decode_value(
        &WireType::Array {
            of: Box::new(WireType::UInt8),
        },
        &mut c,
        &limits,
        0,
    )
    .unwrap_err();
    assert!(matches!(
        err.kind,
        DecodeErrorKind::UnexpectedEof | DecodeErrorKind::MemoryLimit
    ));

    // 深度递归(ARRAY 套 ARRAY 套 …):限界报错,不栈溢出
    let mut deep = Box::new(WireType::UInt8);
    for _ in 0..10_000 {
        deep = Box::new(WireType::Array { of: deep });
    }
    let mut inner = 1u32.to_le_bytes().to_vec();
    inner.push(7);
    let mut c = Cursor::new(&inner);
    let ty = WireType::Array { of: deep };
    let r = kode_kbengine_protocol::codec::decode_value(&ty, &mut c, &limits, 0);
    // 深链安全:要么递归在计数层先耗尽数据(UnexpectedEof,逐层 u32 count
    // 消费),要么 DepthLimit;任何一种都必须返回且不栈溢出。
    match r {
        Ok(_) => panic!("10k-deep array with 5B data must not decode"),
        Err(e) => assert!(
            matches!(
                e.kind,
                DecodeErrorKind::DepthLimit | DecodeErrorKind::UnexpectedEof
            ),
            "got {e:?}"
        ),
    }
}

// ---------------------------------------------------------------------------
// 动态消息表(§5.2 onImportClientMessages)
// ---------------------------------------------------------------------------

/// 构造一段真实形状的 onImportClientMessages 载荷(§5.2 记录序:
/// u16 count + count × { u16 id, i16 len, str name, i8 argsType, u8 argsize, u8[argoutsize] })。
fn sample_import_payload() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&2u16.to_le_bytes()); // count
                                              // 记录 1:Baseapp::onRemoteMethodCall(增量 id=207+ 风格;此处用演示 id 1001)
    v.extend_from_slice(&1001u16.to_le_bytes());
    v.extend_from_slice(&(-1i16).to_le_bytes()); // 变长
    v.extend_from_slice(b"Baseapp_onRemoteMethodCall\0");
    v.push(-1i8 as u8); // argsType: variable args
    v.push(1); // argsize
    v.push(8); // INT32 (datatype2id: ENTITY_ID/INT32 = 8)
               // 记录 2:定长 UINT32 消息
    v.extend_from_slice(&1002u16.to_le_bytes());
    v.extend_from_slice(&4i16.to_le_bytes());
    v.extend_from_slice(b"Baseapp_demoFixed\0");
    v.push(0); // argsType: fixed
    v.push(1);
    v.push(4); // UINT32 = 4
    v
}

#[test]
fn dynamic_import_updates_message_map() {
    let mut map = static_map();
    let payload = sample_import_payload();
    let summary = map
        .apply_import(&payload, &DecodeLimits::default())
        .unwrap();
    assert_eq!(summary.count, 2);

    let dyn_msg = map.by_id(1001).expect("dynamic id mapped");
    assert_eq!(dyn_msg.name, "Baseapp_onRemoteMethodCall");
    assert!(dyn_msg.length.is_variable());
    let fixed_msg = map.by_id(1002).unwrap();
    assert_eq!(fixed_msg.length, MessageLength::Fixed(4));

    // 静态固定表条目仍在(id=5 importClientMessages 定长 0)
    assert_eq!(map.by_id(5).unwrap().name, "Loginapp::importClientMessages");

    // 坏载荷:count 声明 > 实际 → 错误不 panic
    let mut bad = 9u16.to_le_bytes().to_vec();
    bad.extend_from_slice(&1u16.to_le_bytes());
    assert!(map.apply_import(&bad, &DecodeLimits::default()).is_err());
}

// ---------------------------------------------------------------------------
// session:双 Flow 独立 + 握手状态推进 + 自动应用动态导入
// ---------------------------------------------------------------------------

/// 组帧helper:变长消息 frame(id + u16 len + payload)。
fn var_frame(id: u16, payload: &[u8]) -> Vec<u8> {
    let mut v = id.to_le_bytes().to_vec();
    v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

#[test]
fn session_login_flow_tracks_handshake_and_dynamic_table() {
    let mut session = Session::new(&build_message_table(&engine_defaults_xml(), None));

    // 1. hello(id=4,Loginapp::hello,固定表变长)载荷 = str ver + str scriptVer + blob key
    let mut hello_payload = Vec::new();
    hello_payload.extend_from_slice(b"2.5.10\0");
    hello_payload.extend_from_slice(b"1.0.0\0");
    hello_payload.extend_from_slice(&16u32.to_le_bytes());
    hello_payload.extend_from_slice(&[0u8; 16]);
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(4, &hello_payload))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].name.as_deref(), Some("Loginapp::hello"));
    assert!(matches!(
        session.phase_of(ComponentRole::Loginapp),
        Phase::HelloAckPending
    ));

    // 2. importClientMessages(id=5,定长 0,无长度字段)
    let f = 5u16.to_le_bytes().to_vec();
    let msgs = session.feed(ComponentRole::Loginapp, &f).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0].name.as_deref(),
        Some("Loginapp::importClientMessages")
    );

    // 3. onImportClientMessages(id=518):载荷 = UINT8_ARRAY(blob),先 u32 长度;
    //    session 自动把载荷并入本 Flow 消息表
    let mut import_payload = (sample_import_payload().len() as u32)
        .to_le_bytes()
        .to_vec();
    import_payload.extend_from_slice(&sample_import_payload());
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(518, &import_payload))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0].name.as_deref(),
        Some("Client::onImportClientMessages")
    );
    // 动态条目立即可用
    let map = session.flow(ComponentRole::Loginapp).unwrap();
    assert_eq!(map.by_id(1001).unwrap().name, "Baseapp_onRemoteMethodCall");

    // 4. 用动态 id 组帧 → 能解码出方法载荷(INT32 entityID)
    let mut payload = 42i32.to_le_bytes().to_vec();
    payload.extend_from_slice(&7u32.to_le_bytes());
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(1001, &payload))
        .unwrap();
    assert_eq!(msgs[0].name.as_deref(), Some("Baseapp_onRemoteMethodCall"));
    assert!(matches!(msgs[0].values[0], Value::Int(42)));

    // 双 Flow 独立:baseapp 未收到导入 → 1001 未知
    let r = session.feed(ComponentRole::Baseapp, &var_frame(1001, &payload));
    assert!(r.is_err());
}

#[test]
fn session_baseapp_entitydef_import_marks_phase() {
    let mut session = Session::new(&build_message_table(&engine_defaults_xml(), None));
    // onImportClientEntityDef(id=519,载荷 = UINT8_ARRAY blob):别名段
    // u16 aliassize + 条目(uid, str name, str aliasName)
    let mut body = Vec::new();
    body.extend_from_slice(&1u16.to_le_bytes());
    body.extend_from_slice(&100u16.to_le_bytes());
    body.extend_from_slice(b"UINT32\0");
    body.extend_from_slice(b"ITEM_ID\0");
    let mut payload = (body.len() as u32).to_le_bytes().to_vec();
    payload.extend_from_slice(&body);
    let msgs = session
        .feed(ComponentRole::Baseapp, &var_frame(519, &payload))
        .unwrap();
    assert_eq!(
        msgs[0].name.as_deref(),
        Some("Client::onImportClientEntityDef")
    );
    assert!(matches!(
        session.phase_of(ComponentRole::Baseapp),
        Phase::EntityDefImported
    ));
    let map = session.flow(ComponentRole::Baseapp).unwrap();
    assert_eq!(map.alias_by_uid(100), Some("ITEM_ID"));
}

// ---------------------------------------------------------------------------
// entity 方法载荷 + 加密信封 framing
// ---------------------------------------------------------------------------

#[test]
fn entity_remote_method_call_decode() {
    // §7:i32 entityID + 逐参数(remote_entity_method.cpp:62-88)
    let mut payload = 77i32.to_le_bytes().to_vec();
    payload.extend_from_slice(&3u32.to_le_bytes()); // ARRAY<UINT32> count
    payload.extend_from_slice(&1u32.to_le_bytes());
    payload.extend_from_slice(&2u32.to_le_bytes());
    payload.extend_from_slice(&3u32.to_le_bytes());
    let m = kode_kbengine_protocol::entity::decode_remote_method_call(
        &payload,
        &[WireType::Array {
            of: Box::new(WireType::UInt32),
        }],
        &DecodeLimits::default(),
    )
    .unwrap();
    assert_eq!(m.entity_id, 77);
    assert_eq!(m.args.len(), 1);
    assert_eq!(
        m.args[0],
        Value::Array(vec![Value::UInt(1), Value::UInt(2), Value::UInt(3)])
    );

    // 参数不足 → 错误不 panic
    assert!(kode_kbengine_protocol::entity::decode_remote_method_call(
        &[77i32.to_le_bytes().as_slice(), &[0]].concat(),
        &[WireType::UInt32, WireType::UInt32],
        &DecodeLimits::default(),
    )
    .is_err());
}

#[test]
fn encrypted_envelope_framed_without_crypto() {
    // §8:加密帧 = u16 encLen + u8 padSize + Blowfish-ECB 密文;
    // 引擎外只做信封定位,解密不在协议引擎范围(零第三方依赖)。
    let payload = [0xaau8; 8 + 3]; // 8B 密文 + padSize 表示的 3B padding
    let mut v = (payload.len() as u16).to_le_bytes().to_vec();
    v.push(3); // padSize
    v.extend_from_slice(&payload);
    let env = kode_kbengine_protocol::framing::parse_encrypted_envelope(&v).unwrap();
    assert_eq!(env.pad_size, 3);
    assert_eq!(env.ciphertext.len(), 11);
    assert_eq!(env.declared_plaintext_len, 10); // encLen = 明文长 + 1(encryption_filter.cpp:56-66)

    // 截断 → 错误带 offset
    let err = kode_kbengine_protocol::framing::parse_encrypted_envelope(&v[..5]).unwrap_err();
    assert!(err.offset > 0 || matches!(err.kind, DecodeErrorKind::UnexpectedEof));
}

// ---------------------------------------------------------------------------
// 诊断:偏移定位
// ---------------------------------------------------------------------------

#[test]
fn decode_errors_carry_offsets() {
    let limits = DecodeLimits::default();
    // 错误偏移 = 失败处的绝对字节位(诊断模块口径)
    let mut v = 1u32.to_le_bytes().to_vec(); // UNICODE 声明 1 字节
    v.push(0x41); // 只有 1 字节内容(够)
    v.push(0x42); // 多余?声明 1B → cursor 剩 1B 未消费,无错
    let mut c = Cursor::new(&v);
    let r = kode_kbengine_protocol::codec::decode_value(&WireType::Unicode, &mut c, &limits, 0);
    assert!(r.is_ok());

    // 截断:声明 10B 只给 2B
    let head = 10u32.to_le_bytes().to_vec();
    let mut c = Cursor::new(&head);
    let _ = c.read_bytes(2).unwrap();
    let err = kode_kbengine_protocol::codec::read_utf8_body(&mut c, 10, &limits).unwrap_err();
    assert!(err.offset > 0);
    assert_eq!(err.kind, DecodeErrorKind::UnexpectedEof);
}
