//! 有类型跨度树(PA-006 字段树数据面)单测:
//! ①结构断言(偏移/长度/嵌套);②与 [`kode_kbengine_protocol::codec::decode_value`]
//! 对拍(同语料同 Ok/Err、同消费字节数)——字段树数据面与值解码零行为漂移。

use kode_kbengine_protocol::codec::{decode_spans, decode_value, DecodeLimits, SpanKind, ValueSpan};
use kode_kbengine_protocol::codec::Value;
use kode_kbengine_protocol::cursor::Cursor;
use kode_kbengine_schema::wire::{DictField, WireType};

fn limits() -> DecodeLimits {
    DecodeLimits::default()
}

/// 断言 span 是 kind 的单叶。
fn leaf(span: &ValueSpan, kind: SpanKind) {
    assert_eq!(span.kind, kind, "kind mismatch");
    assert!(span.children.is_empty(), "leaf has children");
    assert!(span.len > 0, "leaf has zero length");
}

// ---------------------------------------------------------------------------
// 结构断言
// ---------------------------------------------------------------------------

#[test]
fn scalars_spans_offsets() {
    // U8(1) + U16(2) + U32(4) + I64(8) + Double(8) + Bool(1) = 24B
    let mut payload = Vec::new();
    payload.push(0x11);
    payload.extend_from_slice(&0x2233u16.to_le_bytes());
    payload.extend_from_slice(&0x44556677u32.to_le_bytes());
    payload.extend_from_slice(&(-2i64).to_le_bytes());
    payload.extend_from_slice(&1.5f64.to_le_bytes());
    payload.push(0x01);
    let args = vec![
        WireType::UInt8,
        WireType::UInt16,
        WireType::UInt32,
        WireType::Int64,
        WireType::Double,
        WireType::Bool,
    ];
    let spans = decode_spans(&args, &payload, &limits()).unwrap();
    assert_eq!(spans.len(), 6);
    leaf(&spans[0], SpanKind::U8);
    assert_eq!((spans[0].start, spans[0].len), (0, 1));
    leaf(&spans[1], SpanKind::U16);
    assert_eq!((spans[1].start, spans[1].len), (1, 2));
    leaf(&spans[2], SpanKind::U32);
    assert_eq!((spans[2].start, spans[2].len), (3, 4));
    leaf(&spans[3], SpanKind::I64);
    assert_eq!((spans[3].start, spans[3].len), (7, 8));
    leaf(&spans[4], SpanKind::F64);
    assert_eq!((spans[4].start, spans[4].len), (15, 8));
    leaf(&spans[5], SpanKind::Bool);
    assert_eq!((spans[5].start, spans[5].len), (23, 1));
}

#[test]
fn cstring_span_includes_nul_and_stops_at_high_byte() {
    // "abc\0..." → Str 覆盖 4B(含 NUL);高字节截断同 decode_value。
    let payload = b"abc\0def";
    let spans = decode_spans(&[WireType::String], payload, &limits()).unwrap();
    leaf(&spans[0], SpanKind::Str);
    assert_eq!((spans[0].start, spans[0].len), (0, 4));

    let payload = [0x61u8, 0xe4, 0xb8, 0xad, 0x00];
    let spans = decode_spans(&[WireType::String], &payload, &limits()).unwrap();
    leaf(&spans[0], SpanKind::Str);
    assert_eq!((spans[0].start, spans[0].len), (0, 1)); // 0xe4 非 ASCII → 截断
}

#[test]
fn prefixed_blocks_two_layer() {
    // Unicode: u32 len + UTF-8 体 → Group{U32(4B), Str(body)}
    let mut payload = Vec::new();
    let body = "你好".as_bytes();
    payload.extend_from_slice(&(body.len() as u32).to_le_bytes());
    payload.extend_from_slice(body);
    let spans = decode_spans(&[WireType::Unicode], &payload, &limits()).unwrap();
    assert_eq!(spans[0].kind, SpanKind::Group);
    assert_eq!((spans[0].start, spans[0].len), (0, 4 + body.len()));
    assert_eq!(spans[0].children.len(), 2);
    leaf(&spans[0].children[0], SpanKind::U32);
    assert_eq!((spans[0].children[0].start, spans[0].children[0].len), (0, 4));
    leaf(&spans[0].children[1], SpanKind::Str);
    assert_eq!(
        (spans[0].children[1].start, spans[0].children[1].len),
        (4, body.len())
    );

    // Blob: 同构,体 Bytes;Python: 体 Raw(pickle 直通)。
    let mut blob = Vec::new();
    let data = [1u8, 2, 3, 4];
    blob.extend_from_slice(&(data.len() as u32).to_le_bytes());
    blob.extend_from_slice(&data);
    let spans = decode_spans(&[WireType::Blob], &blob, &limits()).unwrap();
    assert_eq!(spans[0].children[1].kind, SpanKind::Bytes);

    let spans = decode_spans(&[WireType::Python], &blob, &limits()).unwrap();
    assert_eq!(spans[0].children[1].kind, SpanKind::Raw);
}

#[test]
fn vector_and_array_nesting() {
    // Vector3: 12B, 3×F32 子项。
    let mut v = Vec::new();
    for f in [1.0f32, 2.0, 3.0] {
        v.extend_from_slice(&f.to_le_bytes());
    }
    let spans = decode_spans(&[WireType::Vector3], &v, &limits()).unwrap();
    assert_eq!(spans[0].kind, SpanKind::Group);
    assert_eq!((spans[0].start, spans[0].len), (0, 12));
    assert_eq!(spans[0].children.len(), 3);
    for (i, c) in spans[0].children.iter().enumerate() {
        leaf(c, SpanKind::F32);
        assert_eq!((c.start, c.len), (i * 4, 4));
    }

    // Array: u32 count + 元素;元素 U16 各 2B。
    let mut a = Vec::new();
    a.extend_from_slice(&3u32.to_le_bytes());
    a.extend_from_slice(&0x0102u16.to_le_bytes());
    a.extend_from_slice(&0x0304u16.to_le_bytes());
    a.extend_from_slice(&0x0506u16.to_le_bytes());
    let spans = decode_spans(
        &[WireType::Array { of: Box::new(WireType::UInt16) }],
        &a,
        &limits(),
    )
    .unwrap();
    assert_eq!(spans[0].kind, SpanKind::Group);
    assert_eq!((spans[0].start, spans[0].len), (0, 4 + 6));
    assert_eq!(spans[0].children.len(), 3);
    for (i, c) in spans[0].children.iter().enumerate() {
        leaf(c, SpanKind::U16);
        assert_eq!((c.start, c.len), (4 + i * 2, 2));
    }
}

#[test]
fn fixed_dict_nested_offsets() {
    // FIXED_DICT { u8 key, str key }:字段声明序、嵌套偏移。
    let mut d = Vec::new();
    d.push(0x42);
    d.extend_from_slice(b"ok\0");
    let fields = vec![
        DictField {
            name: "a".into(),
            ty: Box::new(WireType::UInt8),
        },
        DictField {
            name: "b".into(),
            ty: Box::new(WireType::String),
        },
    ];
    let spans = decode_spans(
        &[WireType::FixedDict {
            module: None,
            fields,
        }],
        &d,
        &limits(),
    )
    .unwrap();
    assert_eq!(spans[0].kind, SpanKind::Group);
    assert_eq!((spans[0].start, spans[0].len), (0, 4));
    assert_eq!(spans[0].children.len(), 2);
    leaf(&spans[0].children[0], SpanKind::U8);
    assert_eq!((spans[0].children[0].start, spans[0].children[0].len), (0, 1));
    leaf(&spans[0].children[1], SpanKind::Str);
    assert_eq!((spans[0].children[1].start, spans[0].children[1].len), (1, 3));
}

#[test]
fn raw_keeps_cursor_and_spans_cover_rest() {
    // EntityCall 中段:不推进游标(同 decode_value),后续 arg 重读同字节。
    // 跨度量与值解码一致。
    let payload = [0xAAu8, 0xBB, 0xCC];
    let args = vec![WireType::UInt8, WireType::EntityCall, WireType::UInt8];
    let spans = decode_spans(&args, &payload, &limits()).unwrap();
    assert_eq!(spans.len(), 3);
    leaf(&spans[0], SpanKind::U8);
    assert_eq!((spans[0].start, spans[0].len), (0, 1));
    leaf(&spans[1], SpanKind::Raw);
    assert_eq!((spans[1].start, spans[1].len), (1, 2)); // 剩余 2B,不消费
    leaf(&spans[2], SpanKind::U8);
    assert_eq!((spans[2].start, spans[2].len), (1, 1)); // 从同一偏移重读

    // Unresolved 同名。
    let spans = decode_spans(
        &[WireType::Unresolved("Missing".into())],
        &payload,
        &limits(),
    )
    .unwrap();
    leaf(&spans[0], SpanKind::Raw);
    assert_eq!((spans[0].start, spans[0].len), (0, 3));
}

// ---------------------------------------------------------------------------
// 与 decode_value 对拍:同语料同 Ok/Err、同消费字节数
// ---------------------------------------------------------------------------

fn corpus() -> Vec<(Vec<WireType>, Vec<u8>)> {
    let mut cases: Vec<(Vec<WireType>, Vec<u8>)> = Vec::new();
    // 全标量序列 + 完整载荷。
    let mut p = Vec::new();
    p.extend_from_slice(&0x01020304u32.to_le_bytes());
    p.extend_from_slice(&(-5i16).to_le_bytes());
    p.push(1);
    p.extend_from_slice(b"hello\0");
    cases.push((
        vec![
            WireType::UInt32,
            WireType::Int16,
            WireType::Bool,
            WireType::String,
        ],
        p,
    ));
    // 嵌套 dict + array。
    let mut p = Vec::new();
    p.extend_from_slice(&2u32.to_le_bytes()); // array count
    p.extend_from_slice(&7u8.to_le_bytes());
    p.extend_from_slice(&8u8.to_le_bytes());
    cases.push((
        vec![WireType::Array {
            of: Box::new(WireType::UInt8),
        }],
        p,
    ));
    let mut p = Vec::new();
    p.push(1);
    p.extend_from_slice(&9u32.to_le_bytes());
    cases.push((
        vec![WireType::FixedDict {
            module: None,
            fields: vec![
                DictField {
                    name: "x".into(),
                    ty: Box::new(WireType::UInt8),
                },
                DictField {
                    name: "y".into(),
                    ty: Box::new(WireType::UInt32),
                },
            ],
        }],
        p,
    ));
    // Unicode/blob。
    let mut p = Vec::new();
    let body = "引擎".as_bytes();
    p.extend_from_slice(&(body.len() as u32).to_le_bytes());
    p.extend_from_slice(body);
    cases.push((vec![WireType::Unicode], p));
    // 截断(EOF):声明数组数超剩余。
    let mut p = Vec::new();
    p.extend_from_slice(&1000u32.to_le_bytes());
    p.push(1);
    cases.push((vec![WireType::Array { of: Box::new(WireType::UInt8) }], p));
    // 截断:标量不足。
    cases.push((vec![WireType::UInt64], vec![0x01, 0x02]));
    // EntityCall 中段。
    cases.push((vec![WireType::UInt8, WireType::EntityCall], vec![0xAA, 0xBB, 0xCC]));
    cases
}

#[test]
fn spans_parity_with_value_decode() {
    for (args, payload) in corpus() {
        let lim = limits();
        let mut cur1 = Cursor::new(&payload);
        let value_res: Result<Vec<Value>, _> = args
            .iter()
            .map(|t| decode_value(t, &mut cur1, &lim, 0))
            .collect();
        let span_res = decode_spans(&args, &payload, &lim);
        let consumed = cur1.offset();

        // Ok/Err 一致性。
        assert_eq!(
            value_res.is_ok(),
            span_res.is_ok(),
            "Ok/Err mismatch for args={args:?} payload={payload:?}"
        );
        if let (Ok(spans), Ok(_)) = (&span_res, &value_res) {
            // 消费字节数一致(不含 Raw 参数:EntityCall/Unresolved 不推进游标,
            // 但 span 覆盖剩余字节——该口径由 raw_keeps_cursor 专测)。
            let has_raw = args
                .iter()
                .any(|t| matches!(t, WireType::EntityCall | WireType::Unresolved(_)));
            if !has_raw {
                let last_end = spans.last().map(|s| s.start + s.len).unwrap_or(0);
                assert_eq!(
                    last_end, consumed,
                    "consumed mismatch args={args:?} payload={payload:?}"
                );
            }
        }
    }
}

#[test]
fn depth_limit_errors_identically() {
    // 深嵌套数组超过 MAX_DECODE_DEPTH(64):两边同 Err。
    let mut ty = WireType::UInt8;
    for _ in 0..80 {
        ty = WireType::Array {
            of: Box::new(ty),
        };
    }
    // 构造 payload:每层 u32 计数 1 + 末层 1B。
    let mut p = Vec::new();
    for _ in 0..80 {
        p.extend_from_slice(&1u32.to_le_bytes());
    }
    p.push(0x01);
    let lim = limits();
    let mut cur = Cursor::new(&p);
    let v = decode_value(&ty, &mut cur, &lim, 0);
    let s = decode_spans(&[ty], &p, &lim);
    assert!(v.is_err());
    assert!(s.is_err());
}
