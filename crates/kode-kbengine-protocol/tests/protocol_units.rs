//! PA-003 acceptance tests (red first): cursor / codec / dynamic message table / entity / session.
//!
//! Engine semantics from docs/kbengine-wire-protocol.md (PA-001 forensics, baseline bf1a9cd6
//! / v2.5.10); the fixed message table snapshot shares its source with PA-002 (tests/fixtures).

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
// cursor: zero-copy scalar reads + bounds (§3)
// ---------------------------------------------------------------------------

#[test]
fn cursor_reads_le_scalars() {
    let data = [0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
    let mut c = Cursor::new(&data);
    assert_eq!(c.read_u8().unwrap(), 0x01);
    assert_eq!(c.read_u16().unwrap(), 0x0302); // little-endian
    assert_eq!(c.read_u32().unwrap(), 0x07060504);
    assert_eq!(c.offset(), 7);
    assert!(c.read_u16().is_err()); // no out-of-bounds, no panic
}

#[test]
fn cursor_string_engine_semantics() {
    // STRING: NUL-terminated with no prefix; the reading end truncates early on non-ASCII (≥0x80)
    // (memorystream.h:319-332).
    let mut c = Cursor::new(b"abc\0def");
    assert_eq!(c.read_cstring().unwrap(), "abc");
    assert_eq!(c.offset(), 4);

    let mut c = Cursor::new(&[0x61, 0xe4, 0xb8, 0xad, 0x00]);
    assert_eq!(c.read_cstring().unwrap(), "a"); // 0xe4 is non-ASCII → truncate
    assert_eq!(c.offset(), 1);

    // No NUL still does not panic: read to the end
    let mut c = Cursor::new(b"tail");
    assert_eq!(c.read_cstring().unwrap(), "tail");
}

#[test]
fn cursor_prefixed_blob_and_eof_never_panic() {
    // UNICODE/BLOB: u32 length + content (datatype.cpp:1129-1143, 1448-1463)
    let mut v = 5u32.to_le_bytes().to_vec();
    v.extend_from_slice(b"hello");
    let mut c = Cursor::new(&v);
    assert_eq!(c.read_blob(&DecodeLimits::default()).unwrap(), b"hello");

    // Declared length exceeds the remainder → error (with offset), no panic, no out-of-bounds allocation
    let mut c = Cursor::new(&[0xffu8, 0xff, 0xff, 0xff]);
    let err = c.read_blob(&DecodeLimits::default()).unwrap_err();
    // Over-cap is only detected after the u32 length has been read (4B)
    assert_eq!(err.offset, 4);
    assert!(matches!(
        err.kind,
        DecodeErrorKind::UnexpectedEof | DecodeErrorKind::MemoryLimit
    ));
}

// ---------------------------------------------------------------------------
// codec: basic types + containers (ARRAY / FIXED_DICT)
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

    // ARRAY<UINT32>: u32 count + elems (datatype.cpp:1837-1856)
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

    // FIXED_DICT: declaration order, no key names on the wire (datatype.cpp:2592+)
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
    // Unknown type: Raw keeps the remaining bytes (red line: unknown types retained as Raw)
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
    // ENTITYCALL: PA-001 TODO-2 (wire format not pinned byte-for-byte) → Raw, nothing fabricated
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
    // u32::MAX array declaration + truncated input → error, no exploding allocation
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

    // Deep recursion (ARRAY nested in ARRAY nested in ...): bounded error, no stack overflow
    let mut deep = Box::new(WireType::UInt8);
    for _ in 0..10_000 {
        deep = Box::new(WireType::Array { of: deep });
    }
    let mut inner = 1u32.to_le_bytes().to_vec();
    inner.push(7);
    let mut c = Cursor::new(&inner);
    let ty = WireType::Array { of: deep };
    let r = kode_kbengine_protocol::codec::decode_value(&ty, &mut c, &limits, 0);
    // Deep-chain safety: either the recursion exhausts the data at the counting layer first
    // (UnexpectedEof, consuming the per-level u32 count) or DepthLimit; either way it must
    // return and not overflow the stack.
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
// Dynamic message table (§5.2 onImportClientMessages)
// ---------------------------------------------------------------------------

/// Build an onImportClientMessages payload of real shape (§5.2 record order:
/// u16 count + count × { u16 id, i16 len, str name, i8 argsType, u8 argsize, u8[argoutsize] }).
fn sample_import_payload() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&2u16.to_le_bytes()); // count
                                              // Record 1: Baseapp::onRemoteMethodCall (incremental id=207+ style; demo id 1001 used here)
    v.extend_from_slice(&1001u16.to_le_bytes());
    v.extend_from_slice(&(-1i16).to_le_bytes()); // variable length
    v.extend_from_slice(b"Baseapp_onRemoteMethodCall\0");
    v.push(-1i8 as u8); // argsType: variable args
    v.push(1); // argsize
    v.push(8); // INT32 (datatype2id: ENTITY_ID/INT32 = 8)
               // Record 2: fixed-length UINT32 message
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

    // The static fixed-table entry is still there (id=5 importClientMessages, fixed length 0)
    assert_eq!(map.by_id(5).unwrap().name, "Loginapp::importClientMessages");

    // Bad payload: declared count > actual → error, no panic
    let mut bad = 9u16.to_le_bytes().to_vec();
    bad.extend_from_slice(&1u16.to_le_bytes());
    assert!(map.apply_import(&bad, &DecodeLimits::default()).is_err());
}

// ---------------------------------------------------------------------------
// session: two independent Flows + handshake phase advancement + dynamic import applied automatically
// ---------------------------------------------------------------------------

/// Framing helper: variable-length message frame (id + u16 len + payload).
fn var_frame(id: u16, payload: &[u8]) -> Vec<u8> {
    let mut v = id.to_le_bytes().to_vec();
    v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

#[test]
fn session_login_flow_tracks_handshake_and_dynamic_table() {
    let mut session = Session::new(&build_message_table(&engine_defaults_xml(), None));

    // 1. hello (id=4, Loginapp::hello, variable in the fixed table); payload = str ver + str scriptVer + blob key
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

    // 2. importClientMessages (id=5, fixed length 0, no length field)
    let f = 5u16.to_le_bytes().to_vec();
    let msgs = session.feed(ComponentRole::Loginapp, &f).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0].name.as_deref(),
        Some("Loginapp::importClientMessages")
    );

    // 3. onImportClientMessages (id=518): payload = UINT8_ARRAY(blob), u32 length first;
    //    the session merges the payload into this Flow's message table automatically
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
    // Dynamic entries usable immediately
    let map = session.flow(ComponentRole::Loginapp).unwrap();
    assert_eq!(map.by_id(1001).unwrap().name, "Baseapp_onRemoteMethodCall");

    // 4. Frame with the dynamic id → the method payload decodes (INT32 entityID)
    let mut payload = 42i32.to_le_bytes().to_vec();
    payload.extend_from_slice(&7u32.to_le_bytes());
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(1001, &payload))
        .unwrap();
    assert_eq!(msgs[0].name.as_deref(), Some("Baseapp_onRemoteMethodCall"));
    assert!(matches!(msgs[0].values[0], Value::Int(42)));

    // Flows are independent: baseapp never got the import → 1001 unknown
    let r = session.feed(ComponentRole::Baseapp, &var_frame(1001, &payload));
    assert!(r.is_err());
}

#[test]
fn session_baseapp_entitydef_import_marks_phase() {
    let mut session = Session::new(&build_message_table(&engine_defaults_xml(), None));
    // onImportClientEntityDef (id=519, payload = UINT8_ARRAY blob): alias segment
    // u16 aliassize + entries (uid, str name, str aliasName)
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
// entity method payloads + encrypted envelope framing
// ---------------------------------------------------------------------------

#[test]
fn entity_remote_method_call_decode() {
    // §7: i32 entityID + one value per argument (remote_entity_method.cpp:62-88)
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

    // Not enough arguments → error, no panic
    assert!(kode_kbengine_protocol::entity::decode_remote_method_call(
        &[77i32.to_le_bytes().as_slice(), &[0]].concat(),
        &[WireType::UInt32, WireType::UInt32],
        &DecodeLimits::default(),
    )
    .is_err());
}

#[test]
fn encrypted_envelope_framed_without_crypto() {
    // §8: encrypted frame = u16 encLen + u8 padSize + Blowfish-ECB ciphertext;
    // outside the engine we only locate the envelope; decryption is out of scope for the protocol
    // engine (zero third-party dependencies).
    let payload = [0xaau8; 8 + 3]; // 8B ciphertext + 3B padding indicated by padSize
    let mut v = (payload.len() as u16).to_le_bytes().to_vec();
    v.push(3); // padSize
    v.extend_from_slice(&payload);
    let env = kode_kbengine_protocol::framing::parse_encrypted_envelope(&v).unwrap();
    assert_eq!(env.pad_size, 3);
    assert_eq!(env.ciphertext.len(), 11);
    assert_eq!(env.declared_plaintext_len, 10); // encLen = plaintext length + 1 (encryption_filter.cpp:56-66)

    // Truncated → error with offset
    let err = kode_kbengine_protocol::framing::parse_encrypted_envelope(&v[..5]).unwrap_err();
    assert!(err.offset > 0 || matches!(err.kind, DecodeErrorKind::UnexpectedEof));
}

// ---------------------------------------------------------------------------
// Diagnostics: offset locating
// ---------------------------------------------------------------------------

#[test]
fn decode_errors_carry_offsets() {
    let limits = DecodeLimits::default();
    // Error offset = the absolute byte position at the failure (the diagnostics module semantics)
    let mut v = 1u32.to_le_bytes().to_vec(); // UNICODE declares 1 byte
    v.push(0x41); // exactly 1 byte of content (sufficient)
    v.push(0x42); // extra? declares 1B → the cursor leaves 1B unconsumed, no error
    let mut c = Cursor::new(&v);
    let r = kode_kbengine_protocol::codec::decode_value(&WireType::Unicode, &mut c, &limits, 0);
    assert!(r.is_ok());

    // Truncated: 10B declared, only 2B given
    let head = 10u32.to_le_bytes().to_vec();
    let mut c = Cursor::new(&head);
    let _ = c.read_bytes(2).unwrap();
    let err = kode_kbengine_protocol::codec::read_utf8_body(&mut c, 10, &limits).unwrap_err();
    assert!(err.offset > 0);
    assert_eq!(err.kind, DecodeErrorKind::UnexpectedEof);
}
