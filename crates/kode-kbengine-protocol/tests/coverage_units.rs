//! PA-003 supplementary tests (cursor full scalar table / codec all types + limit faces /
//! framing shapes and red lines / dynamic import of every datatype2id / cache compile cache /
//! session bidirectional streams).
//!
//! Engine semantics from docs/kbengine-wire-protocol.md (PA-001 forensics, baseline bf1a9cd6
//! / v2.5.10); same contract as protocol_units.rs, only filling the uncovered branches.

use kode_kbengine_protocol::cache::SchemaCache;
use kode_kbengine_protocol::codec::{decode_value, DecodeLimits, Value, MAX_DECODE_DEPTH};
use kode_kbengine_protocol::cursor::{is_length_prefixed, Cursor};
use kode_kbengine_protocol::entity::property_sync_unsupported;
use kode_kbengine_protocol::error::{DecodeError, DecodeErrorKind};
use kode_kbengine_protocol::framing::{FrameParser, FramingConfig, LengthSpec, UnknownIdPolicy};
use kode_kbengine_protocol::messages::{datatype2id_of, wire_type_from_datatype2id, MessageMap};
use kode_kbengine_protocol::session::{ComponentRole, Direction, Phase, Session};
use kode_kbengine_schema::messages::{build_message_table, MessageLength};
use kode_kbengine_schema::wire::{builtin_wire_type, DictField, WireType};

fn engine_defaults_xml() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/messages_fixed_defaults.xml"
    ))
    .unwrap()
}

fn static_map() -> MessageMap {
    MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None))
}

// ---------------------------------------------------------------------------
// cursor: every scalar read path (per-row LE semantics) + peek / sized-body cap
// ---------------------------------------------------------------------------

#[test]
fn cursor_signed_and_wide_scalars() {
    // i8/i16/i32/i64/u64/f32/f64 aligned item by item with memorystream.h:139-143, 253-317 (LE)
    let mut v = Vec::new();
    v.push(0x80u8); // i8 = -128
    v.extend_from_slice(&(-32768i16).to_le_bytes());
    v.extend_from_slice(&i32::MIN.to_le_bytes());
    v.extend_from_slice(&i64::MIN.to_le_bytes());
    v.extend_from_slice(&u64::MAX.to_le_bytes());
    v.extend_from_slice(&(-1.5f32).to_le_bytes());
    v.extend_from_slice(&2.25f64.to_le_bytes());
    let mut c = Cursor::new(&v);
    assert_eq!(c.read_i8().unwrap(), -128);
    assert_eq!(c.read_i16().unwrap(), -32768);
    assert_eq!(c.read_i32().unwrap(), i32::MIN);
    assert_eq!(c.read_i64().unwrap(), i64::MIN);
    assert_eq!(c.read_u64().unwrap(), u64::MAX);
    let f = c.read_f32().unwrap();
    assert_eq!(f, -1.5f32);
    assert_eq!(c.read_f64().unwrap(), 2.25f64);
    assert!(c.at_end());
    assert_eq!(c.remaining(), 0);
    assert_eq!(c.rest(), b"");

    // Boundary: a positive INT64 keeps its sign through the as conversion
    let max64 = i64::MAX.to_le_bytes();
    let mut c = Cursor::new(&max64);
    assert_eq!(c.read_i64().unwrap(), i64::MAX);
}

#[test]
fn cursor_scalar_eof_paths_carry_offset() {
    // Reading a u32 with fewer than 4B → EOF (offset=0); per-width checkpoints of read_slice
    let mut c = Cursor::new(&[1u8, 2]);
    let e = c.read_u32().unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.offset, 0);
    assert_eq!(e.path, "u32");
    assert!(e.message.contains("need 4 bytes"));

    let mut c = Cursor::new(&[1u8, 2, 3, 4, 5, 6, 7]);
    let e = c.read_u64().unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.offset, 0);
    assert_eq!(e.path, "u64");

    let mut c = Cursor::new(&[1u8, 2, 3, 4, 5, 6, 7]);
    let e = c.read_f64().unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.path, "f64");

    let mut c = Cursor::new(&[]);
    assert!(c.read_u8().unwrap_err().kind == DecodeErrorKind::UnexpectedEof);
    assert!(c.read_i8().unwrap_err().kind == DecodeErrorKind::UnexpectedEof);
    let e = c.read_i16().unwrap_err();
    assert_eq!(e.path, "i16");
    // i32/i64 delegate to read_u32/read_u64 → the path records the underlying unsigned type (matches engine semantics)
    let e = c.read_i32().unwrap_err();
    assert_eq!(e.path, "u32");
    let e = c.read_i64().unwrap_err();
    assert_eq!(e.path, "u64");
    let e = c.read_f32().unwrap_err();
    assert_eq!(e.path, "f32");

    // read_bytes fixed-size block: sufficient/insufficient two ways
    let mut c = Cursor::new(&[9u8, 8, 7]);
    assert_eq!(c.read_bytes(2).unwrap(), &[9, 8]);
    assert_eq!(c.offset(), 2);
    let e = c.read_bytes(2).unwrap_err();
    assert_eq!(e.path, "bytes");
    assert_eq!(e.offset, 2);
}

#[test]
fn cursor_peek_u16_and_sized_body_cap() {
    // peek does not consume: two reads yield the same value; 1B left → EOF
    let mut c = Cursor::new(&[0x34u8, 0x12, 0xAA]);
    assert_eq!(c.peek_u16("probe").unwrap(), 0x1234);
    assert_eq!(c.offset(), 0);
    assert_eq!(c.peek_u16("probe").unwrap(), 0x1234);
    c.read_bytes(2).unwrap();
    let e = c.peek_u16("probe").unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.path, "probe");
    assert_eq!(e.offset, 2);
    assert!(e.message.contains("peek u16"));

    // read_sized_body: declared over cap → MemoryLimit (offset = after the length already read)
    let tight = DecodeLimits {
        max_blob: 4,
        ..DecodeLimits::default()
    };
    let mut c = Cursor::new(&[0x01u8, 0x02]);
    let e = c.read_sized_body(5, &tight, "blob").unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::MemoryLimit);
    assert_eq!(e.offset, 0);
    assert_eq!(e.path, "blob");
    assert!(e.message.contains("declared 5 > cap 4"));
    // Normal read within the cap
    assert_eq!(c.read_sized_body(2, &tight, "blob").unwrap(), &[1, 2]);
}

#[test]
fn cursor_cstring_multibyte_and_offset() {
    // A UTF-8 multibyte string truncates at the first byte ≥0x80 (memorystream.h:319-332 engine
    // semantics); consumption stops on the truncated byte, and the later bytes remain readable.
    let mut c = Cursor::new(&[0x61u8, 0xE4, 0xB8, 0xAD, 0x62]);
    assert_eq!(c.read_cstring().unwrap(), "a");
    assert_eq!(c.offset(), 1);
    // Empty NUL: terminates immediately
    let mut c = Cursor::new(&[0u8, 0x41]);
    assert_eq!(c.read_cstring().unwrap(), "");
    assert_eq!(c.offset(), 1);
}

#[test]
fn length_prefixed_family_matches_schema_rule() {
    // The variable-length prefix family (§3.1): UNICODE/BLOB/PYTHON/ARRAY; fixed-width scalars/VECTORs are not
    assert!(is_length_prefixed(&WireType::Unicode));
    assert!(is_length_prefixed(&WireType::Blob));
    assert!(is_length_prefixed(&WireType::Python));
    assert!(is_length_prefixed(&WireType::Array {
        of: Box::new(WireType::UInt8)
    }));
    assert!(!is_length_prefixed(&WireType::String));
    assert!(!is_length_prefixed(&WireType::UInt32));
    assert!(!is_length_prefixed(&WireType::Vector3));
    assert!(!is_length_prefixed(&WireType::FixedDict {
        module: None,
        fields: Vec::new()
    }));
}

// ---------------------------------------------------------------------------
// codec: every basic type + container limit faces (memory/depth/value count)
// ---------------------------------------------------------------------------

#[test]
fn codec_scalar_full_table_roundtrip() {
    let limits = DecodeLimits::default();
    let mut v = Vec::new();
    v.push(0); // Bool=false
    v.push(255); // UInt8
    v.push(0x80); // Int8 = -128
    v.extend_from_slice(&u16::MAX.to_le_bytes());
    v.extend_from_slice(&(i16::MIN).to_le_bytes());
    v.extend_from_slice(&u32::MAX.to_le_bytes());
    v.extend_from_slice(&i32::MIN.to_le_bytes());
    v.extend_from_slice(&u64::MAX.to_le_bytes());
    v.extend_from_slice(&i64::MIN.to_le_bytes());
    v.extend_from_slice(&0.5f64.to_le_bytes()); // Double
    let mut c = Cursor::new(&v);
    let d = |ty: &WireType, c: &mut Cursor| decode_value(ty, c, &limits, 0).unwrap();
    assert_eq!(d(&WireType::Bool, &mut c), Value::Bool(false));
    assert_eq!(d(&WireType::UInt8, &mut c), Value::UInt(255));
    assert_eq!(d(&WireType::Int8, &mut c), Value::Int(-128));
    assert_eq!(d(&WireType::UInt16, &mut c), Value::UInt(u16::MAX as u64));
    assert_eq!(d(&WireType::Int16, &mut c), Value::Int(i16::MIN as i64));
    assert_eq!(d(&WireType::UInt32, &mut c), Value::UInt(u32::MAX as u64));
    assert_eq!(d(&WireType::Int32, &mut c), Value::Int(i32::MIN as i64));
    assert_eq!(d(&WireType::UInt64, &mut c), Value::UInt(u64::MAX));
    assert_eq!(d(&WireType::Int64, &mut c), Value::Int(i64::MIN));
    assert!(matches!(d(&WireType::Double, &mut c), Value::Float(x) if x == 0.5));
    assert!(c.at_end());
}

#[test]
fn codec_vectors_2_3_4() {
    let limits = DecodeLimits::default();
    let mut v = Vec::new();
    for x in [1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0] {
        v.extend_from_slice(&x.to_le_bytes());
    }
    let mut c = Cursor::new(&v);
    let v2 = decode_value(&WireType::Vector2, &mut c, &limits, 0).unwrap();
    assert_eq!(v2, Value::Array(vec![Value::Float(1.0), Value::Float(2.0)]));
    let v3 = decode_value(&WireType::Vector3, &mut c, &limits, 0).unwrap();
    assert_eq!(
        v3,
        Value::Array(vec![
            Value::Float(3.0),
            Value::Float(4.0),
            Value::Float(5.0)
        ])
    );
    let v4 = decode_value(&WireType::Vector4, &mut c, &limits, 0).unwrap();
    assert_eq!(
        v4,
        Value::Array(vec![
            Value::Float(6.0),
            Value::Float(7.0),
            Value::Float(8.0),
            Value::Float(9.0)
        ])
    );
    assert!(c.at_end());

    // Truncated: Vector3 given only 2 components → EOF (offset=8)
    let mut v = Vec::new();
    v.extend_from_slice(&1.0f32.to_le_bytes());
    v.extend_from_slice(&2.0f32.to_le_bytes());
    let mut c = Cursor::new(&v);
    let e = decode_value(&WireType::Vector3, &mut c, &limits, 0).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.offset, 8);
}

#[test]
fn codec_python_pickle_kept_raw() {
    // PYTHON: u32 length + pickle passthrough (datatype.cpp:1225-1242); the decoding side does not guess the content
    let limits = DecodeLimits::default();
    let mut v = 4u32.to_le_bytes().to_vec();
    v.extend_from_slice(b"\x80\x04K\x01"); // 4 bytes shaped like a pickle header
    let mut c = Cursor::new(&v);
    let r = decode_value(&WireType::Python, &mut c, &limits, 0).unwrap();
    match r {
        Value::Raw(raw) => {
            assert_eq!(raw.bytes, b"\x80\x04K\x01".to_vec());
            assert!(raw.reason.contains("pickle"));
        }
        other => panic!("expected Raw, got {other:?}"),
    }
    assert!(c.at_end());
}

#[test]
fn codec_array_caps_and_min_size_precheck() {
    // Element count cap: declared 3 > cap 2 → MemoryLimit (offset after the count)
    let tight_len = DecodeLimits {
        max_array_len: 2,
        ..DecodeLimits::default()
    };
    let declared3 = 3u32.to_le_bytes();
    let mut c = Cursor::new(&declared3);
    let e = decode_value(
        &WireType::Array {
            of: Box::new(WireType::UInt8),
        },
        &mut c,
        &tight_len,
        0,
    )
    .unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::MemoryLimit);
    assert_eq!(e.offset, 4);
    assert_eq!(e.path, "array");
    assert!(e.message.contains("declared 3 > cap 2"));

    // Minimum-element precheck (only reached when the declared count is within the cap): Vector2 elements are
    // at least 8B, 3 declared but only 2B → EOF, no 3 per-element errors
    let wide_len = DecodeLimits {
        max_array_len: 10,
        ..DecodeLimits::default()
    };
    let mut v = 3u32.to_le_bytes().to_vec();
    v.extend_from_slice(&[1, 2]);
    let mut c = Cursor::new(&v);
    let e = decode_value(
        &WireType::Array {
            of: Box::new(WireType::Vector2),
        },
        &mut c,
        &wide_len,
        0,
    )
    .unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.offset, 4);
    assert!(e.message.contains("declared 3 elements"));

    // Normal decode within the cap (2 UInt8)
    let mut v = 2u32.to_le_bytes().to_vec();
    v.extend_from_slice(&[7, 9]);
    let mut c = Cursor::new(&v);
    let r = decode_value(
        &WireType::Array {
            of: Box::new(WireType::UInt8),
        },
        &mut c,
        &wide_len,
        0,
    )
    .unwrap();
    assert_eq!(r, Value::Array(vec![Value::UInt(7), Value::UInt(9)]));
}

#[test]
fn codec_array_zero_count_for_every_min_size_shape() {
    // count=0 empty arrays: walk the minimum-bytes table for every element shape (the precheck 0×n=0)
    let limits = DecodeLimits::default();
    let elems = [
        WireType::Bool,
        WireType::UInt8,
        WireType::Int8,
        WireType::UInt16,
        WireType::Int16,
        WireType::UInt32,
        WireType::Int32,
        WireType::Float,
        WireType::UInt64,
        WireType::Int64,
        WireType::Double,
        WireType::Vector2,
        WireType::Vector3,
        WireType::Vector4,
        WireType::String,
        WireType::Unicode,
    ];
    for of in elems {
        let mut v = 0u32.to_le_bytes().to_vec();
        v.push(0xEE); // trailing byte after the array, confirming count=0 consumes nothing
        let mut c = Cursor::new(&v);
        let r = decode_value(
            &WireType::Array {
                of: Box::new(of.clone()),
            },
            &mut c,
            &limits,
            0,
        )
        .unwrap();
        assert_eq!(r, Value::Array(Vec::new()), "empty array for {of:?}");
        assert_eq!(c.remaining(), 1, "trailing byte kept for {of:?}");
    }
}

#[test]
fn codec_fixed_dict_nested_and_missing_type_raw() {
    let limits = DecodeLimits::default();
    // Nested FIXED_DICT: recursively decode in declaration order, all key names preserved
    let ty = WireType::FixedDict {
        module: Some("Demo.Inner".into()),
        fields: vec![
            DictField {
                name: "id".into(),
                ty: Box::new(WireType::UInt32),
            },
            DictField {
                name: "pos".into(),
                ty: Box::new(WireType::FixedDict {
                    module: None,
                    fields: vec![
                        DictField {
                            name: "x".into(),
                            ty: Box::new(WireType::Float),
                        },
                        DictField {
                            name: "y".into(),
                            ty: Box::new(WireType::Float),
                        },
                    ],
                }),
            },
        ],
    };
    let mut v = 9u32.to_le_bytes().to_vec();
    v.extend_from_slice(&1.5f32.to_le_bytes());
    v.extend_from_slice(&(-2.5f32).to_le_bytes());
    let mut c = Cursor::new(&v);
    let d = decode_value(&ty, &mut c, &limits, 0).unwrap();
    assert_eq!(
        d,
        Value::Dict(vec![
            ("id".into(), Value::UInt(9)),
            (
                "pos".into(),
                Value::Dict(vec![
                    ("x".into(), Value::Float(1.5)),
                    ("y".into(), Value::Float(-2.5))
                ])
            )
        ])
    );

    // Field truncated: pos.x Float given only 2B → EOF (offset after the 4B of id)
    let mut v = 9u32.to_le_bytes().to_vec();
    v.extend_from_slice(&[0u8, 0]);
    let mut c = Cursor::new(&v);
    let e = decode_value(&ty, &mut c, &limits, 0).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.offset, 4);
}

#[test]
fn codec_value_budget_and_depth_caps() {
    // Value-count cap: 0 → the very first value is rejected (red line: the FIXED_DICT big-template amplification guard)
    let tight = DecodeLimits {
        max_values: 0,
        ..DecodeLimits::default()
    };
    let mut c = Cursor::new(&[1u8]);
    let e = decode_value(&WireType::UInt8, &mut c, &tight, 0).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::MemoryLimit);
    assert_eq!(e.path, "value");
    assert!(e.message.contains("value count over cap 0"));

    // Depth cap: only triggers at 65 ARRAY levels (MAX_DECODE_DEPTH); the data must be enough to read the count at every level
    let limits = DecodeLimits::default();
    let mut deep = Box::new(WireType::UInt8);
    for _ in 0..(MAX_DECODE_DEPTH + 10) {
        deep = Box::new(WireType::Array { of: deep });
    }
    // One count=1 (u32) per level; one more 1B element inside → the (MAX_DECODE_DEPTH+1)-th level reports DepthLimit
    let mut data = Vec::new();
    for _ in 0..=(MAX_DECODE_DEPTH + 10) {
        data.extend_from_slice(&1u32.to_le_bytes());
    }
    data.push(0x42);
    let mut c = Cursor::new(&data);
    let e = decode_value(&WireType::Array { of: deep }, &mut c, &limits, 0).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::DepthLimit);
    assert_eq!(e.path, "depth");
    assert!(e
        .message
        .contains(&format!("recursion over {MAX_DECODE_DEPTH}")));

    // Triggered from the depth-passing side: decode directly starting at depth=MAX_DECODE_DEPTH+1
    let mut c = Cursor::new(&[1u8]);
    let e = decode_value(&WireType::UInt8, &mut c, &limits, MAX_DECODE_DEPTH + 1).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::DepthLimit);
    assert_eq!(e.offset, 0);
}

#[test]
fn codec_raw_keeps_rest_of_region() {
    // Raw retention = consumes "everything remaining in the current region"; empty input → empty bytes
    let limits = DecodeLimits::default();
    let mut c = Cursor::new(&[]);
    let r = decode_value(&WireType::EntityCall, &mut c, &limits, 0).unwrap();
    match r {
        Value::Raw(raw) => {
            assert!(raw.bytes.is_empty());
            assert!(raw.reason.contains("TODO-2"));
        }
        other => panic!("expected Raw, got {other:?}"),
    }
    let mut c = Cursor::new(&[]);
    let r = decode_value(&WireType::Unresolved("GHOST".into()), &mut c, &limits, 0).unwrap();
    match r {
        Value::Raw(raw) => {
            assert!(raw.bytes.is_empty());
            assert!(raw.reason.contains("GHOST"));
        }
        other => panic!("expected Raw, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// framing: UnknownIdPolicy::AssumeVariable / always-len mismatch / fixed-length over cap /
// buffer-overflow reset
// ---------------------------------------------------------------------------

fn cfg(
    specs: std::collections::BTreeMap<u16, MessageLength>,
    cap: u32,
    always: bool,
) -> FramingConfig {
    FramingConfig {
        specs,
        unknown_id_policy: UnknownIdPolicy::Fail,
        max_message_len: cap,
        packet_always_contain_length: always,
    }
}

/// AssumeVariable policy configuration (unknown ids probed as variable length).
fn cfg_assume(cap: u32) -> FramingConfig {
    FramingConfig {
        specs: std::collections::BTreeMap::new(),
        unknown_id_policy: UnknownIdPolicy::AssumeVariable,
        max_message_len: cap,
        packet_always_contain_length: false,
    }
}

#[test]
fn framing_assume_variable_fits_unknown_ids() {
    // Permissive policy: unknown ids framed by probing as variable length (u16 length) (packet_reader permissive semantics)
    let mut p = FrameParser::new(cfg_assume(1 << 20));
    let mut bytes = 60000u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&3u16.to_le_bytes());
    bytes.extend_from_slice(b"abc");
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].id, 60000);
    assert_eq!(frames[0].payload, b"abc");
    assert_eq!(frames[0].length_spec, LengthSpec::Variable);
    assert_eq!(frames[0].stream_offset, 0);

    // Extended-length shape for an unknown id under the same policy: 65535 sentinel + u32 actual length
    let mut bytes = 60001u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&65535u16.to_le_bytes());
    bytes.extend_from_slice(&5u32.to_le_bytes());
    bytes.extend_from_slice(b"hello");
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].length_spec, LengthSpec::Extended(5));
    assert_eq!(frames[0].payload, b"hello");
    assert_eq!(frames[0].stream_offset, 7); // the previous frame spans 7B in total

    // Fragmented: only 3B after the sentinel (the u32 length is incomplete) → deferred to the next feed
    let mut p = FrameParser::new(cfg_assume(1 << 20));
    let frames = p
        .feed(&[
            0x21u8, 0xEA, // id 60001
            0xFF, 0xFF, // sentinel
            0x05, 0x00, 0x00, // only 3B of the u32 length
        ])
        .unwrap();
    assert_eq!(frames.len(), 0);
    assert_eq!(p.pending_buffer_len(), 7);
    let frames = p.feed(&[0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE]).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].length_spec, LengthSpec::Extended(5));
    assert_eq!(frames[0].payload, &[0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
    assert_eq!(frames[0].stream_offset, 0);
    assert_eq!(p.pending_buffer_len(), 0);
}

#[test]
fn framing_always_len_mismatch_rejected() {
    // §4.3: under always-contain-length a fixed message carries a u16 length; declared ≠ the table's fixed length → rejected
    let mut specs = std::collections::BTreeMap::new();
    specs.insert(900u16, MessageLength::Fixed(8));
    let mut p = FrameParser::new(cfg(specs, 1 << 20, true));
    let mut bytes = 900u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&5u16.to_le_bytes()); // declares 5 ≠ fixed 8
    let e = p.feed(&bytes).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::MemoryLimit);
    assert!(e.message.contains("declared len 5 != fixed 8"));
    assert_eq!(e.offset, 0);

    // Fixed length 0: a 0 length in the table means the declaration is not checked (the engine only compares when
    // `*n > 0`; a 0 length is let through as variable)
    let mut specs = std::collections::BTreeMap::new();
    specs.insert(901u16, MessageLength::Fixed(0));
    let mut p = FrameParser::new(cfg(specs.clone(), 1 << 20, true));
    let mut bytes = 901u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.push(0x41);
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames[0].payload, &[0x41]);
    assert_eq!(frames[0].length_spec, LengthSpec::Variable);

    // Fixed 0 + declared 0 → normal, empty payload
    let mut p = FrameParser::new(cfg(specs, 1 << 20, true));
    let mut bytes = 901u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&0u16.to_le_bytes());
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames[0].payload, b"");
    assert_eq!(frames[0].length_spec, LengthSpec::Variable);

    // Always-len fragmentation: the fixed message is given only 3B (id + the first 1B of the length field) → deferred to the next feed
    let mut specs = std::collections::BTreeMap::new();
    specs.insert(902u16, MessageLength::Fixed(8));
    let mut p = FrameParser::new(cfg(specs, 1 << 20, true));
    let frames = p
        .feed(&[0x86, 0x03, 0x08]) // id 902 + the u16 length has only its low byte
        .unwrap();
    assert_eq!(frames.len(), 0, "长度字段不完整不成帧");
    assert_eq!(p.pending_buffer_len(), 3);
    let mut rest = 0x00u8.to_le_bytes().to_vec();
    rest.extend_from_slice(&[0xAA; 8]); // the length field's high byte + 8B of payload
    let frames = p.feed(&rest).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].length_spec, LengthSpec::Variable);
    assert_eq!(frames[0].payload, vec![0xAA; 8]);
    assert_eq!(frames[0].stream_offset, 0);
}

#[test]
fn framing_fixed_and_variable_declared_rejected_by_cap() {
    // Fixed frame total bytes > cap+8 → MemoryLimit (the aggregate check)
    let mut specs = std::collections::BTreeMap::new();
    specs.insert(900u16, MessageLength::Fixed(16));
    let mut p = FrameParser::new(cfg(specs, 4, false));
    let bytes = 900u16.to_le_bytes().to_vec();
    let e = p.feed(&bytes).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::MemoryLimit);
    assert!(e.message.contains("frame 18 bytes > cap 4"));

    // Variable declared > cap → MemoryLimit (checked after the length is read)
    let mut specs = std::collections::BTreeMap::new();
    specs.insert(901u16, MessageLength::Variable);
    let mut p = FrameParser::new(cfg(specs, 8, false));
    let mut bytes = 901u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&9u16.to_le_bytes());
    let e = p.feed(&bytes).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::MemoryLimit);
    assert!(e.message.contains("declared len 9 > cap 8"));

    // Garbage block (Fail policy): the parse loop yields the more precise error cause (unknown id) ahead of the
    // buffer cap, with the reset semantics unchanged. The old implementation reported a pending-buffer MemoryLimit
    // here (a side effect of "check the cap first": a legal multi-frame block was invalidated wholesale because
    // the total bytes exceeded the cap); this changed with the "resolve frames first, then judge the remainder"
    // fix — the cap branch now constrains the residue after frames are resolved (see the framing_fuzz
    // multi_frame/oversized cases and the abs_base bookkeeping in reset).
    let mut p = FrameParser::new(cfg(std::collections::BTreeMap::new(), 8, false));
    let garbage = [0xA5u8; 32];
    let e = p.feed(&garbage).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnknownMessageId);
    assert_eq!(p.pending_buffer_len(), 0, "状态机复位");

    // The parser stays usable after an error (reset semantics: reopen the analysis, never continue on top of a bad state)
    let ok = p.feed(&[]).unwrap();
    assert!(ok.is_empty());
}

#[test]
fn framing_config_mut_swaps_policy_live() {
    // Switch policy at runtime: Fail → AssumeVariable takes effect on the same parser
    let mut p = FrameParser::new(cfg(std::collections::BTreeMap::new(), 1 << 20, false));
    let mut bytes = 60000u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.push(0x41);
    assert!(p.feed(&bytes).is_err()); // Fail: unknown id rejected
    p.config_mut().unknown_id_policy = UnknownIdPolicy::AssumeVariable;
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, b"A");
}

// ---------------------------------------------------------------------------
// messages: the full datatype2id table + bidirectional mapping + import sentinels
// ---------------------------------------------------------------------------

#[test]
fn datatype2id_table_round_trip_all_ids() {
    // The measured table at common.cpp:20-70 item by item: id → type → reverse-lookup id (round trip)
    let cases: &[(u8, &str)] = &[
        (1, "STRING"),
        (2, "UINT8"),
        (3, "UINT16"),
        (4, "UINT32"),
        (5, "UINT64"),
        (6, "INT8"),
        (7, "INT16"),
        (8, "INT32"),
        (9, "INT64"),
        (10, "PYTHON"),
        (11, "BLOB"),
        (12, "UNICODE"),
        (13, "FLOAT"),
        (14, "DOUBLE"),
        (15, "VECTOR2"),
        (16, "VECTOR3"),
        (17, "VECTOR4"),
    ];
    for (id, name) in cases {
        let ty = wire_type_from_datatype2id(*id).unwrap_or_else(|| panic!("id {id} missing"));
        let back = datatype2id_of(name).unwrap_or_else(|| panic!("{name} missing"));
        assert_eq!(back, *id, "{name} round trip");
        // Shape check: every entry maps to a resolvable builtin (not Unresolved)
        assert!(
            !matches!(ty, WireType::Unresolved(_)),
            "id {id} must map to a builtin, got {ty:?}"
        );
    }
    // FIXED_DICT/ARRAY/ENTITYCALL: shape unknown at import time → Unresolved/EntityCall retained
    assert!(matches!(
        wire_type_from_datatype2id(18).unwrap(),
        WireType::Unresolved(_)
    ));
    assert!(matches!(
        wire_type_from_datatype2id(19).unwrap(),
        WireType::Unresolved(_)
    ));
    assert!(matches!(
        wire_type_from_datatype2id(20).unwrap(),
        WireType::EntityCall
    ));
    // Out-of-table id → None (the caller falls back to Unresolved)
    assert!(wire_type_from_datatype2id(0).is_none());
    assert!(wire_type_from_datatype2id(21).is_none());
    assert!(wire_type_from_datatype2id(255).is_none());

    // Aliases and special names: STD::STRING / UINT8_ARRAY share the STRING/BLOB table entries;
    // PY_DICT/PY_TUPLE/PY_LIST share PYTHON's wire type but the datatype2id table has no dedicated name → 0
    assert_eq!(datatype2id_of("STD::STRING"), Some(1));
    assert_eq!(datatype2id_of("UINT8_ARRAY"), Some(11));
    assert_eq!(datatype2id_of("PY_DICT"), Some(0));
    assert_eq!(datatype2id_of("PY_TUPLE"), Some(0));
    assert_eq!(datatype2id_of("PY_LIST"), Some(0));
    // Names builtin_wire_type knows but the datatype2id table has no entry for → 0 (the in-table `_` fallback)
    assert_eq!(datatype2id_of("EntityCall"), Some(0));
    assert_eq!(datatype2id_of("DBID"), Some(0));
    assert_eq!(datatype2id_of("VECTOR4"), Some(17));
    assert_eq!(datatype2id_of("TOTALLY_UNKNOWN"), None);
}

#[test]
fn import_payload_with_every_datatype2id() {
    // 20 records cover datatype2id 1..=20 (including the out-of-table 0): the dynamic table lands the right shape per record
    let ids: Vec<u8> = (1u8..=20).chain([0]).collect();
    let mut v = (ids.len() as u16).to_le_bytes().to_vec();
    for (i, tid) in ids.iter().enumerate() {
        v.extend_from_slice(&(3000u16 + i as u16).to_le_bytes());
        v.extend_from_slice(&(-1i16).to_le_bytes()); // variable length
        v.extend_from_slice(format!("Demo::arg{i}\0").as_bytes());
        v.push(0); // argsType
        v.push(1); // argsize
        v.push(*tid);
    }
    let mut map = static_map();
    let summary = map.apply_import(&v, &DecodeLimits::default()).unwrap();
    assert_eq!(summary.count, ids.len() as u16);
    assert_eq!(summary.variable, ids.len() as u16);
    assert_eq!(summary.fixed, 0);

    let want: &[WireType] = &[
        WireType::String,
        WireType::UInt8,
        WireType::UInt16,
        WireType::UInt32,
        WireType::UInt64,
        WireType::Int8,
        WireType::Int16,
        WireType::Int32,
        WireType::Int64,
        WireType::Python,
        WireType::Blob,
        WireType::Unicode,
        WireType::Float,
        WireType::Double,
        WireType::Vector2,
        WireType::Vector3,
        WireType::Vector4,
    ];
    for (i, expected) in want.iter().enumerate() {
        let spec = map.by_id(3000 + i as u16).unwrap();
        assert_eq!(&spec.args[0], expected, "arg of record {i}");
    }
    // 18/19 → Unresolved (shape unknown at import time); 20 → EntityCall; 0 → Unresolved (out of table)
    assert!(matches!(
        map.by_id(3000 + 17).unwrap().args[0],
        WireType::Unresolved(_)
    ));
    assert!(matches!(
        map.by_id(3000 + 18).unwrap().args[0],
        WireType::Unresolved(_)
    ));
    assert!(matches!(
        map.by_id(3000 + 19).unwrap().args[0],
        WireType::EntityCall
    ));
    assert!(matches!(
        map.by_id(3000 + 20).unwrap().args[0],
        WireType::Unresolved(_)
    ));
}

#[test]
fn import_replaces_existing_spec_and_keeps_trailing_sentinel() {
    // Record level: a second import under the same id overrides name/length (the engine's incremental allocation
    // semantics; args keep their old values)
    let mut payload = 1u16.to_le_bytes().to_vec();
    payload.extend_from_slice(&1001u16.to_le_bytes());
    payload.extend_from_slice(&4i16.to_le_bytes());
    payload.extend_from_slice(b"Demo::first\0");
    payload.push(0);
    payload.push(1);
    payload.push(8); // INT32

    let mut map = static_map();
    map.apply_import(&payload, &DecodeLimits::default())
        .unwrap();
    assert_eq!(map.by_id(1001).unwrap().name, "Demo::first");
    assert_eq!(map.by_id(1001).unwrap().length, MessageLength::Fixed(4));

    // Re-import the same id as variable with the same name but different length: overrides name/length; argsize=0 →
    // args is emptied (apply_import's trailing set_args unconditionally installs the new table, an empty one included)
    let mut second = 1u16.to_le_bytes().to_vec();
    second.extend_from_slice(&1001u16.to_le_bytes());
    second.extend_from_slice(&(-1i16).to_le_bytes());
    second.extend_from_slice(b"Demo::second\0");
    second.push(0);
    second.push(0);
    let summary = map.apply_import(&second, &DecodeLimits::default()).unwrap();
    assert_eq!(summary.count, 1);
    let spec = map.by_id(1001).unwrap();
    assert_eq!(spec.name, "Demo::second");
    assert!(spec.length.is_variable());
    assert!(spec.args.is_empty(), "argsize=0 的导入覆盖旧 args");

    // insert_spec retention semantics (not via import, swapping the spec directly): the old args are inherited as-is
    map.insert_spec(1001, "Demo::third".into(), MessageLength::Fixed(12));
    let spec = map.by_id(1001).unwrap();
    assert_eq!(spec.name, "Demo::third");
    assert_eq!(spec.length, MessageLength::Fixed(12));
    assert!(spec.args.is_empty(), "旧规格 args 为空则继承空");

    // Trailing sentinel: residue left after the declared count is fully consumed → UnexpectedEof + the remaining byte count
    let mut bad = 1u16.to_le_bytes().to_vec();
    bad.extend_from_slice(&1002u16.to_le_bytes());
    bad.extend_from_slice(&0i16.to_le_bytes());
    bad.extend_from_slice(b"Demo::zero\0");
    bad.push(0);
    bad.push(0);
    bad.push(0xCA);
    bad.push(0xFE);
    let e = map
        .apply_import(&bad, &DecodeLimits::default())
        .unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.path, "import");
    assert!(e.message.contains("trailing 2 bytes after 1 records"));

    // An empty payload where even the count cannot be read → EOF
    let e = map.apply_import(&[], &DecodeLimits::default()).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
}

#[test]
fn message_map_defaults_entry_and_alias_ops() {
    // from_defaults_xml convenience entry + len/is_empty + set_args as a no-op for unknown ids
    let map = MessageMap::from_defaults_xml(&engine_defaults_xml(), None);
    assert!(!map.is_empty());
    // Snapshot of the fixed-table entry count (a verbatim snapshot, not the full engine table)
    assert_eq!(map.len(), 73);
    assert!(MessageMap::default().is_empty());

    let mut map = static_map();
    // Project-override segment same-name entry: the engine's fixed value is replaced (from_defaults_xml's second parameter)
    let with_override = MessageMap::from_defaults_xml(
        &engine_defaults_xml(),
        Some("<root><Loginapp::login><id>300</id></Loginapp::login></root>"),
    );
    assert_eq!(with_override.by_id(300).unwrap().name, "Loginapp::login");

    // set_args: takes effect for installed ids; silently no-ops for uninstalled ids (no panic, no entry created)
    map.set_args(5, vec![WireType::UInt32]);
    assert_eq!(map.by_id(5).unwrap().args, vec![WireType::UInt32]);
    map.set_args(59999, vec![WireType::UInt8]);
    assert!(map.by_id(59999).is_none(), "no phantom entry");

    // insert_spec's second call preserves the old args (likewise true on the from_static plane)
    map.insert_spec(5, "Renamed::import".into(), MessageLength::Variable);
    let spec = map.by_id(5).unwrap();
    assert_eq!(spec.name, "Renamed::import");
    assert!(spec.length.is_variable());
    assert_eq!(spec.args, vec![WireType::UInt32]);

    // Alias segment: insert + lookup (§6 step 10)
    map.insert_alias(77, "ITEM_ID".into());
    assert_eq!(map.alias_by_uid(77), Some("ITEM_ID"));
    assert_eq!(map.alias_by_uid(78), None);
    // Overwrite under the same uid
    map.insert_alias(77, "ITEM_ID_V2".into());
    assert_eq!(map.alias_by_uid(77), Some("ITEM_ID_V2"));
}

// ---------------------------------------------------------------------------
// cache: schema hash → compiled-product reuse (PA-003 "schema compile cache")
// ---------------------------------------------------------------------------

fn demo_schema() -> kode_kbengine_schema::Schema {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/kbengine-demo-assets");
    kode_kbengine_schema::build_schema_from_project(
        &root,
        Some(&engine_defaults_xml()),
        &kode_kbengine_schema::BuildOptions::default(),
    )
    .expect("demo schema build")
}

#[test]
fn cache_reuses_compiled_schema_by_hash() {
    let schema = demo_schema();
    let mut cache = SchemaCache::new();
    assert!(cache.is_empty());
    assert_eq!(cache.len(), 0);

    let first = cache.get_or_compile(&schema);
    assert_eq!(first.hash_hex, schema.hash_hex());
    assert!(!first.statics.is_empty());
    assert_eq!(
        first.packet_always_contain_length,
        schema.packet_always_contain_length
    );
    // The static segment holds known fixed-table entries
    let login = first.statics.by_id(3).expect("login in compiled statics");
    assert_eq!(login.name, "Loginapp::login");
    assert_eq!(cache.len(), 1);

    // Hit: the same hash returns the same Arc (zero duplicate compilation)
    let second = cache.get_or_compile(&schema);
    assert!(std::sync::Arc::ptr_eq(&first, &second));
    assert_eq!(cache.len(), 1);

    // Different hash (flipping packetAlwaysContainLength changes the canonical JSON) → a new entry
    let mut other = schema.clone();
    other.packet_always_contain_length = true;
    assert_ne!(other.hash_hex(), schema.hash_hex());
    let third = cache.get_or_compile(&other);
    assert_ne!(first.hash_hex, third.hash_hex);
    assert!(third.packet_always_contain_length);
    assert_eq!(cache.len(), 2);
    // The Debug impl exists (the diagnostic plane)
    assert!(format!("{cache:?}").contains("SchemaCache"));
}

// ---------------------------------------------------------------------------
// session: bidirectional independent framing + with_limits + reset_flow + phase-branch coverage
// ---------------------------------------------------------------------------

fn var_frame(id: u16, payload: &[u8]) -> Vec<u8> {
    let mut v = id.to_le_bytes().to_vec();
    v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

/// A Loginapp::hello payload: str ver + str script + blob key (length adjustable).
fn hello_payload(blob_len: u32) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"2.5.10\0");
    v.extend_from_slice(b"1.0.0\0");
    v.extend_from_slice(&blob_len.to_le_bytes());
    v.extend_from_slice(&vec![0u8; blob_len as usize]);
    v
}

#[test]
fn session_feed_direction_isolates_two_byte_streams() {
    let table = build_message_table(&engine_defaults_xml(), None);
    let mut session = Session::new(&table);

    // Uplink (c2s) fragmentation: a half-frame stays in the c2s stream and does not affect the downlink
    let full = var_frame(4, &hello_payload(0));
    let first_half = &full[..2];
    let msgs = session
        .feed_direction(
            ComponentRole::Loginapp,
            Direction::ClientToServer,
            first_half,
        )
        .unwrap();
    assert_eq!(msgs.len(), 0, "半帧不产消息");
    let msgs = session
        .feed_direction(
            ComponentRole::Loginapp,
            Direction::ClientToServer,
            &full[2..],
        )
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].name.as_deref(), Some("Loginapp::hello"));
    assert_eq!(msgs[0].role, ComponentRole::Loginapp);

    // Downlink (s2c) independent framer: Loginapp::hello also travels in the downlink direction
    let msgs = session
        .feed_direction(ComponentRole::Loginapp, Direction::ServerToClient, &full)
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].name.as_deref(), Some("Loginapp::hello"));

    // Direction labels
    assert_eq!(Direction::ClientToServer.as_str(), "c2s");
    assert_eq!(Direction::ServerToClient.as_str(), "s2c");

    // The baseapp Flow is likewise bidirectional (independent table)
    let msgs = session
        .feed_direction(ComponentRole::Baseapp, Direction::ServerToClient, &full)
        .unwrap();
    assert_eq!(msgs[0].name.as_deref(), Some("Loginapp::hello"));
}

#[test]
fn session_with_limits_and_reset_flow() {
    // with_limits: after tightening the caps, a truncated payload → a decode error, no panic
    let table = build_message_table(&engine_defaults_xml(), None);
    let tight = DecodeLimits {
        max_blob: 4,
        max_array_len: 4,
        max_values: 4,
    };
    let mut session = Session::with_limits(&table, tight);

    // Loginapp::hello = str + str + blob; the blob declares 16 > cap 4 → MemoryLimit
    let e = session
        .feed(ComponentRole::Loginapp, &var_frame(4, &hello_payload(16)))
        .unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::MemoryLimit);
    assert_eq!(e.offset, 17);

    // reset_flow: rebuild the Flow from the same table, phase reset to Connected; the tightened caps remain
    // (session-level), and switching to a within-cap blob (4B) lets the handshake run again
    session.reset_flow(ComponentRole::Loginapp, &table);
    assert_eq!(session.phase_of(ComponentRole::Loginapp), Phase::Connected);
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(4, &hello_payload(4)))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        session.phase_of(ComponentRole::Loginapp),
        Phase::HelloAckPending
    );
    // flow_mut can alter the table (add aliases on the flow plane)
    session
        .flow_mut(ComponentRole::Loginapp)
        .unwrap()
        .map
        .insert_alias(5, "DEMO_ALIAS".into());
    assert_eq!(
        session
            .flow(ComponentRole::Loginapp)
            .unwrap()
            .alias_by_uid(5),
        Some("DEMO_ALIAS")
    );
}

#[test]
fn session_on_hello_cb_and_empty_entitydef_branches() {
    let table = build_message_table(&engine_defaults_xml(), None);
    let mut session = Session::new(&table);

    // Client::onHelloCB (id=521, variable: str+str+str+i32) → HelloAcked
    let mut cb = Vec::new();
    cb.extend_from_slice(b"2.5.10\0");
    cb.extend_from_slice(b"1.0.0\0");
    cb.extend_from_slice(b"digest\0");
    cb.extend_from_slice(&1i32.to_le_bytes());
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(521, &cb))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].name.as_deref(), Some("Client::onHelloCB"));
    assert_eq!(session.phase_of(ComponentRole::Loginapp), Phase::HelloAcked);

    // onImportClientEntityDef: aliassize=0 → the phase does not advance (the alias segment is empty)
    let body = 0u16.to_le_bytes().to_vec();
    let mut payload = (body.len() as u32).to_le_bytes().to_vec();
    payload.extend_from_slice(&body);
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(519, &payload))
        .unwrap();
    assert_eq!(
        msgs[0].name.as_deref(),
        Some("Client::onImportClientEntityDef")
    );
    assert_eq!(session.phase_of(ComponentRole::Loginapp), Phase::HelloAcked);

    // Baseapp::hello (fixed table id=200; Loginapp::hello is id=4) → HelloAckPending
    let msgs = session
        .feed(ComponentRole::Baseapp, &var_frame(200, &hello_payload(0)))
        .unwrap();
    assert_eq!(msgs[0].name.as_deref(), Some("Baseapp::hello"));
    assert_eq!(
        session.phase_of(ComponentRole::Baseapp),
        Phase::HelloAckPending
    );

    // Ordinary (non-handshake) messages do not advance the phase (login payload = str + blob + str + str)
    let mut login = Vec::new();
    login.extend_from_slice(b"client\0");
    login.extend_from_slice(&0u32.to_le_bytes());
    login.extend_from_slice(b"account\0");
    login.extend_from_slice(b"pass\0");
    let msgs = session
        .feed(ComponentRole::Baseapp, &var_frame(3, &login))
        .unwrap();
    assert_eq!(msgs[0].name.as_deref(), Some("Loginapp::login"));
    assert_eq!(
        session.phase_of(ComponentRole::Baseapp),
        Phase::HelloAckPending
    );
}

#[test]
fn session_entitydef_alias_entries_land_in_map() {
    let table = build_message_table(&engine_defaults_xml(), None);
    let mut session = Session::new(&table);
    // Multiple aliases: u16 aliassize + entries (uid, str name, str aliasName)
    let mut body = 2u16.to_le_bytes().to_vec();
    body.extend_from_slice(&10u16.to_le_bytes());
    body.extend_from_slice(b"UINT32\0");
    body.extend_from_slice(b"HP\0");
    body.extend_from_slice(&11u16.to_le_bytes());
    body.extend_from_slice(b"UINT16\0");
    body.extend_from_slice(b"LEVEL\0");
    let mut payload = (body.len() as u32).to_le_bytes().to_vec();
    payload.extend_from_slice(&body);
    let msgs = session
        .feed(ComponentRole::Baseapp, &var_frame(519, &payload))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    let map = session.flow(ComponentRole::Baseapp).unwrap();
    assert_eq!(map.alias_by_uid(10), Some("HP"));
    assert_eq!(map.alias_by_uid(11), Some("LEVEL"));
    assert_eq!(map.alias_by_uid(12), None);
    assert_eq!(
        session.phase_of(ComponentRole::Baseapp),
        Phase::EntityDefImported
    );
}

#[test]
fn framing_default_config_and_envelope_caps() {
    // FramingConfig::default: a conservative 1MiB cap + the Fail policy + no table
    let d = FramingConfig::default();
    assert_eq!(d.max_message_len, 1 << 20);
    assert_eq!(d.unknown_id_policy, UnknownIdPolicy::Fail);
    assert!(!d.packet_always_contain_length);
    assert!(d.specs.is_empty());

    // Encrypted envelope: encLen declares 65535 (under the 1MiB cap) → falls to EOF (the declared body is insufficient)
    let mut big = (0xFFFFu16).to_le_bytes().to_vec();
    big.push(7);
    let e = kode_kbengine_protocol::framing::parse_encrypted_envelope(&big).unwrap_err();
    assert_eq!(e.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(e.offset, 3);
    assert!(e.message.contains("declared 65535, have 0"));
}

#[test]
fn error_display_and_trait_object() {
    // Display diagnostic plane (offset + path + message) + the std::error::Error trait impl
    let e = DecodeError::new(
        DecodeErrorKind::UnexpectedEof,
        42,
        "Loginapp::login.account",
        "need 4 bytes, have 2",
    );
    let s = format!("{e}");
    assert!(s.contains("UnexpectedEof at byte 42 [Loginapp::login.account]"));
    assert!(s.contains("need 4 bytes, have 2"));
    // Thrown as a trait object: Box<dyn Error> is constructible (the protocol engine's error type)
    let boxed: Box<dyn std::error::Error> = Box::new(e.clone());
    assert!(boxed.to_string().contains("byte 42"));
    // Clone/PartialEq/Eq (diagnostic caches/test-double comparisons)
    let e2 = e.clone();
    assert_eq!(e, e2);
}

#[test]
fn entity_property_sync_placeholder_is_informative() {
    // PA-001 TODO-3: the property sync stream is not forensically pinned byte-for-byte → placeholder diagnostics (no format guessing)
    let e = property_sync_unsupported(7);
    assert_eq!(e.kind, DecodeErrorKind::InvalidString);
    assert_eq!(e.offset, 7);
    assert_eq!(e.path, "property_sync");
    assert!(e.message.contains("TODO-3"));
}

#[test]
fn session_entitydef_with_non_blob_arg_skips_alias() {
    // onImportClientEntityDef's first argument is not Bytes (the table has been swapped to scalars) → the guard
    // skips the alias segment parsing (no panic, EntityDefImported not advanced)
    let table = build_message_table(&engine_defaults_xml(), None);
    let mut session = Session::new(&table);
    {
        let flow = session.flow_mut(ComponentRole::Baseapp).unwrap();
        flow.map.insert_spec(
            519,
            "Client::onImportClientEntityDef".into(),
            MessageLength::Variable,
        );
        flow.map.set_args(519, vec![WireType::UInt32]);
    }
    let payload = 3u32.to_le_bytes().to_vec();
    let msgs = session
        .feed(ComponentRole::Baseapp, &var_frame(519, &payload))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0].name.as_deref(),
        Some("Client::onImportClientEntityDef")
    );
    assert!(matches!(msgs[0].values[0], Value::UInt(3)));
    assert_eq!(
        session.phase_of(ComponentRole::Baseapp),
        Phase::Connected,
        "非 Bytes 载荷不触发 EntityDef 阶段推进"
    );

    // flow_mut / reset_flow work the same for Baseapp (independent table)
    session
        .flow_mut(ComponentRole::Baseapp)
        .unwrap()
        .map
        .insert_alias(9, "BASE_ALIAS".into());
    assert_eq!(
        session
            .flow(ComponentRole::Baseapp)
            .unwrap()
            .alias_by_uid(9),
        Some("BASE_ALIAS")
    );
    session.reset_flow(ComponentRole::Baseapp, &table);
    assert_eq!(session.phase_of(ComponentRole::Baseapp), Phase::Connected);
    assert_eq!(
        session
            .flow(ComponentRole::Baseapp)
            .unwrap()
            .alias_by_uid(9),
        None,
        "reset 后别名表清空"
    );
}

#[test]
fn session_import_with_non_blob_arg_skips_apply() {
    // onImportClientMessages' first argument is not Bytes (the table has been swapped to scalars) → the guard skips
    // apply_import (no panic, ProtocolImported not advanced)
    let table = build_message_table(&engine_defaults_xml(), None);
    let mut session = Session::new(&table);
    {
        let flow = session.flow_mut(ComponentRole::Loginapp).unwrap();
        flow.map.insert_spec(
            518,
            "Client::onImportClientMessages".into(),
            MessageLength::Variable,
        );
        flow.map.set_args(518, vec![WireType::UInt32]);
    }
    let scalar_payload = 1u32.to_le_bytes().to_vec();
    let msgs = session
        .feed(ComponentRole::Loginapp, &var_frame(518, &scalar_payload))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0].name.as_deref(),
        Some("Client::onImportClientMessages")
    );
    assert!(matches!(msgs[0].values[0], Value::UInt(1)));
    assert_eq!(
        session.phase_of(ComponentRole::Loginapp),
        Phase::Connected,
        "非 Bytes 载荷不触发导入阶段推进"
    );
}

#[test]
fn builtin_wire_type_aliases_resolution() {
    // The full set of builtin aliases (§3/§5.2 parameter-name semantics): the parser-side same-name classification is compared per item
    let cases: &[(&str, WireType)] = &[
        ("CHAR", WireType::UInt8),
        ("DATATYPE", WireType::UInt8),
        ("DETAIL_TYPE", WireType::UInt8),
        ("ENTITYCALL_CALL_TYPE", WireType::UInt8),
        ("UNSIGNED SHORT", WireType::UInt16),
        ("SERVER_ERROR_CODE", WireType::UInt16),
        ("ENTITY_TYPE", WireType::UInt16),
        ("ENTITY_PROPERTY_UID", WireType::UInt16),
        ("ENTITY_METHOD_UID", WireType::UInt16),
        ("ENTITY_SCRIPT_UID", WireType::UInt16),
        ("DATATYPE_UID", WireType::UInt16),
        ("UINT", WireType::UInt32),
        ("UNSIGNED INT", WireType::UInt32),
        ("ARRAYSIZE", WireType::UInt32),
        ("SPACE_ID", WireType::UInt32),
        ("GAME_TIME", WireType::UInt32),
        ("TIMER_ID", WireType::UInt32),
        ("DBID", WireType::UInt64),
        ("COMPONENT_ID", WireType::UInt64),
        ("COMPONENT_ORDER", WireType::Int8),
        ("SHORT", WireType::Int16),
        ("INT", WireType::Int32),
        ("ENTITY_ID", WireType::Int32),
        ("CALLBACK_ID", WireType::Int32),
        ("COMPONENT_TYPE", WireType::Int32),
        ("ENTITYCALL", WireType::EntityCall),
        ("PY_DICT", WireType::Python),
        ("PY_TUPLE", WireType::Python),
        ("PY_LIST", WireType::Python),
    ];
    for (name, want) in cases {
        assert_eq!(builtin_wire_type(name).as_ref(), Some(want), "{name}");
        // case-insensitive + trim
        assert_eq!(
            builtin_wire_type(&format!(" {name} ").to_lowercase()).as_ref(),
            Some(want),
            "{name} case-insensitive"
        );
    }
    assert_eq!(builtin_wire_type("NO_SUCH_TYPE"), None);
    assert_eq!(builtin_wire_type(""), None);
    // is_resolvable_builtin shares the same semantics as builtin_wire_type
    assert!(kode_kbengine_schema::wire::is_resolvable_builtin("UNICODE"));
    assert!(!kode_kbengine_schema::wire::is_resolvable_builtin(
        "MYSTERY"
    ));
}
