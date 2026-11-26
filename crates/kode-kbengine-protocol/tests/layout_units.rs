//! Wire layout interpretation (KSEM-SER-12) unit tests:
//! 1) structure assertions for path / type label / offset;
//! 2) error location (threaded path + byte offset + uninterpreted tail boundary);
//! 3) honesty red lines (PYTHON bucket Raw fabricates nothing, EntityCall/Unresolved pass
//!    through, structural_only always true);
//! 4) parity comparison with [`decode_spans`] (same corpus, same Ok/Err, same bytes consumed,
//!    Ok trees deep-equal per node start/len/kind — zero behavior drift between the display and
//!    data planes).

use kode_kbengine_protocol::codec::{decode_spans, DecodeLimits, SpanKind, ValueSpan};
use kode_kbengine_protocol::error::DecodeErrorKind;
use kode_kbengine_protocol::layout::{decode_layout, LayoutNode, LAYOUT_HONESTY_NOTE};
use kode_kbengine_schema::wire::{DictField, WireType};

fn limits() -> DecodeLimits {
    DecodeLimits::default()
}

fn fd(name: &str, ty: WireType) -> DictField {
    DictField {
        name: name.to_string(),
        ty: Box::new(ty),
    }
}

/// Parity: Ok trees deep-equal per node start/len/kind (path/label are display-plane additions and are not compared).
fn assert_span_mirror(node: &LayoutNode, span: &ValueSpan) {
    assert_eq!(node.start, span.start, "start drift at {}", node.path);
    assert_eq!(node.len, span.len, "len drift at {}", node.path);
    assert_eq!(node.kind, span.kind, "kind drift at {}", node.path);
    assert_eq!(
        node.children.len(),
        span.children.len(),
        "children count drift at {}",
        node.path
    );
    for (child, span_child) in node.children.iter().zip(span.children.iter()) {
        assert_span_mirror(child, span_child);
    }
}

/// Parity: same corpus, same Ok/Err; on Err the kind/offset/message match (the layout path is a
/// threaded addition; differences in fields other than the message are not compared).
fn parity(args: &[WireType], payload: &[u8]) {
    let spans = decode_spans(args, payload, &limits());
    let layout = decode_layout(args, payload, &limits());
    match (&spans, &layout.error) {
        (Ok(_), None) => {}
        (Err(se), Some(le)) => {
            assert_eq!(se.kind, le.kind, "error kind drift");
            assert_eq!(se.offset, le.offset, "error offset drift");
            assert_eq!(se.message, le.message, "error message drift");
        }
        _ => panic!("ok/err divergence between spans and layout"),
    }
    if let Ok(span_list) = spans {
        assert_eq!(span_list.len(), layout.nodes.len(), "top arg count drift");
        for (node, span) in layout.nodes.iter().zip(span_list.iter()) {
            assert_span_mirror(node, span);
        }
    }
}

// ---------------------------------------------------------------------------
// Path / type label / offset
// ---------------------------------------------------------------------------

#[test]
fn scalar_paths_labels_offsets() {
    // U8(1) + U32(4) + Double(8)
    let mut payload = Vec::new();
    payload.push(0x11);
    payload.extend_from_slice(&0x44556677u32.to_le_bytes());
    payload.extend_from_slice(&1.5f64.to_le_bytes());
    let args = vec![WireType::UInt8, WireType::UInt32, WireType::Double];
    let out = decode_layout(&args, &payload, &limits());
    assert!(out.error.is_none());
    assert!(out.unresolved_tail_from.is_none());
    assert_eq!(out.nodes.len(), 3);
    assert_eq!(out.nodes[0].path, "arg0");
    assert_eq!(out.nodes[0].type_label, "UINT8");
    assert_eq!((out.nodes[0].start, out.nodes[0].len), (0, 1));
    assert_eq!(out.nodes[1].path, "arg1");
    assert_eq!(out.nodes[1].type_label, "UINT32");
    assert_eq!((out.nodes[1].start, out.nodes[1].len), (1, 4));
    assert_eq!(out.nodes[2].type_label, "DOUBLE");
    assert_eq!((out.nodes[2].start, out.nodes[2].len), (5, 8));
}

#[test]
fn fixed_dict_field_paths_in_declaration_order() {
    let mut payload = Vec::new();
    payload.extend_from_slice(&7u16.to_le_bytes());
    payload.extend_from_slice(b"hp\0");
    let args = vec![WireType::FixedDict {
        module: None,
        fields: vec![fd("hp", WireType::UInt16), fd("name", WireType::String)],
    }];
    let out = decode_layout(&args, &payload, &limits());
    assert!(out.error.is_none());
    let root = &out.nodes[0];
    assert_eq!(root.path, "arg0");
    assert!(root.type_label.starts_with("FIXED_DICT<"));
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].path, "arg0.hp");
    assert_eq!(root.children[0].type_label, "UINT16");
    assert_eq!((root.children[0].start, root.children[0].len), (0, 2));
    assert_eq!(root.children[1].path, "arg0.name");
    assert_eq!(root.children[1].type_label, "STRING");
    assert_eq!((root.children[1].start, root.children[1].len), (2, 3));
    // Declaration order = wire order (SER-02 §2): hp before name
    assert!(root.children[0].start < root.children[1].start);
}

#[test]
fn array_element_paths_and_count_prefix() {
    let mut payload = Vec::new();
    payload.extend_from_slice(&2u32.to_le_bytes());
    payload.extend_from_slice(&1u32.to_le_bytes());
    payload.extend_from_slice(&2u32.to_le_bytes());
    let args = vec![WireType::Array {
        of: Box::new(WireType::UInt32),
    }];
    let out = decode_layout(&args, &payload, &limits());
    let root = &out.nodes[0];
    assert_eq!(root.type_label, "ARRAY<UINT32>");
    assert_eq!((root.start, root.len), (0, 12)); // the count prefix lies inside the group range
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].path, "arg0[0]");
    assert_eq!((root.children[0].start, root.children[0].len), (4, 4));
    assert_eq!(root.children[1].path, "arg0[1]");
    assert_eq!((root.children[1].start, root.children[1].len), (8, 4));
}

#[test]
fn nested_paths_array_of_dict_and_dict_of_array() {
    let mut payload = Vec::new();
    // ARRAY<FD{hp:U16}> × 1
    payload.extend_from_slice(&1u32.to_le_bytes());
    payload.extend_from_slice(&9u16.to_le_bytes());
    let args = vec![WireType::Array {
        of: Box::new(WireType::FixedDict {
            module: None,
            fields: vec![fd("hp", WireType::UInt16)],
        }),
    }];
    let out = decode_layout(&args, &payload, &limits());
    let elem = &out.nodes[0].children[0];
    assert_eq!(elem.path, "arg0[0]");
    assert_eq!(elem.children[0].path, "arg0[0].hp");

    // FD{items: ARRAY<U8> ×2}
    let mut payload2 = Vec::new();
    payload2.extend_from_slice(&2u32.to_le_bytes());
    payload2.push(0xAA);
    payload2.push(0xBB);
    let args2 = vec![WireType::FixedDict {
        module: None,
        fields: vec![fd(
            "items",
            WireType::Array {
                of: Box::new(WireType::UInt8),
            },
        )],
    }];
    let out2 = decode_layout(&args2, &payload2, &limits());
    let items = &out2.nodes[0].children[0];
    assert_eq!(items.path, "arg0.items");
    assert_eq!(items.children[0].path, "arg0.items[0]");
    assert_eq!(items.children[1].path, "arg0.items[1]");
}

// ---------------------------------------------------------------------------
// Length-prefixed family / vectors / opaque segments
// ---------------------------------------------------------------------------

#[test]
fn length_prefixed_families_segment_children() {
    let mut payload = Vec::new();
    payload.extend_from_slice(&3u32.to_le_bytes());
    payload.extend_from_slice(b"abc");
    let args = vec![WireType::Blob];
    let out = decode_layout(&args, &payload, &limits());
    let root = &out.nodes[0];
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].path, "arg0.len");
    assert_eq!(root.children[0].type_label, "u32 length");
    assert_eq!((root.children[0].start, root.children[0].len), (0, 4));
    assert_eq!(root.children[1].path, "arg0.body");
    assert_eq!(root.children[1].kind, SpanKind::Bytes);
    assert_eq!(root.children[1].type_label, "bytes body");

    let py = decode_layout(&[WireType::Python], &payload, &limits());
    let body = &py.nodes[0].children[1];
    assert_eq!(body.kind, SpanKind::Raw);
    assert_eq!(body.type_label, "pickle body (opaque)");
    assert!(body.children.is_empty(), "pickle 体不编造结构");

    let uni = decode_layout(&[WireType::Unicode], &payload, &limits());
    assert_eq!(uni.nodes[0].children[1].kind, SpanKind::Str);
    assert_eq!(uni.nodes[0].children[1].type_label, "utf-8 body");
}

#[test]
fn vector_components_indexed() {
    let mut payload = Vec::new();
    for v in [1.0f32, 2.0, 3.0] {
        payload.extend_from_slice(&v.to_le_bytes());
    }
    let out = decode_layout(&[WireType::Vector3], &payload, &limits());
    let root = &out.nodes[0];
    assert_eq!(root.children.len(), 3);
    assert_eq!(root.children[0].path, "arg0[0]");
    assert_eq!(root.children[2].path, "arg0[2]");
    assert_eq!((root.children[2].start, root.children[2].len), (8, 4));
}

#[test]
fn entity_call_and_unresolved_raw_passthrough_no_advance() {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[1, 2, 3, 4, 5, 6]);
    let args = vec![WireType::EntityCall];
    let out = decode_layout(&args, &payload, &limits());
    let root = &out.nodes[0];
    assert_eq!(root.kind, SpanKind::Raw);
    assert_eq!(root.type_label, "ENTITYCALL");
    assert_eq!((root.start, root.len), (0, 6)); // covers the remainder, no fabricated field order

    let un = decode_layout(
        &[WireType::Unresolved("Ghost".to_string())],
        &payload,
        &limits(),
    );
    assert_eq!(un.nodes[0].type_label, "UNRESOLVED<Ghost>");
    assert_eq!(un.nodes[0].kind, SpanKind::Raw);
}

// ---------------------------------------------------------------------------
// Error location (threaded path + offset + uninterpreted tail boundary)
// ---------------------------------------------------------------------------

#[test]
fn top_level_error_position_and_tail() {
    // arg1 needs 4B, only 1B given
    let payload = vec![0x11, 0x22];
    let args = vec![WireType::UInt8, WireType::UInt32];
    let out = decode_layout(&args, &payload, &limits());
    let err = out.error.expect("expected error");
    assert_eq!(err.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(err.offset, 1); // where the cursor reached = the error byte position
    assert_eq!(err.path, "arg1");
    assert_eq!(out.unresolved_tail_from, Some(1));
    assert_eq!(out.nodes.len(), 1); // arg0 already interpreted
    assert!(out.structural_only);
}

#[test]
fn nested_error_paths_dict_field_and_array_element() {
    // FD.hp truncated: the failed u16 read consumes nothing → error position = current cursor (0); needs 2B, only 1B
    let args = vec![WireType::FixedDict {
        module: None,
        fields: vec![fd("hp", WireType::UInt16)],
    }];
    let out = decode_layout(&args, &[0x11], &limits());
    let err = out.error.expect("expected error");
    assert_eq!(err.path, "arg0.hp");
    assert_eq!(err.offset, 0);

    // Array precheck: 3 U32 elements declared, only 8B left → array-level path + offset after the count is read
    let mut payload = Vec::new();
    payload.extend_from_slice(&3u32.to_le_bytes());
    payload.extend_from_slice(&1u32.to_le_bytes());
    payload.extend_from_slice(&2u32.to_le_bytes());
    let args2 = vec![WireType::Array {
        of: Box::new(WireType::UInt32),
    }];
    let out2 = decode_layout(&args2, &payload, &limits());
    let err2 = out2.error.expect("expected error");
    assert_eq!(err2.path, "arg0");
    assert!(err2.message.contains("declared 3 elements"));
    assert_eq!(err2.offset, 4);
    assert_eq!(out2.unresolved_tail_from, Some(4));

    // Element-level threaded path: after the precheck (min=1) passes, the 2nd FD element's hp is truncated
    let mut payload3 = Vec::new();
    payload3.extend_from_slice(&2u32.to_le_bytes());
    payload3.extend_from_slice(&[0x11, 0x22]);
    let args3 = vec![WireType::Array {
        of: Box::new(WireType::FixedDict {
            module: None,
            fields: vec![fd("hp", WireType::UInt16)],
        }),
    }];
    let out3 = decode_layout(&args3, &payload3, &limits());
    let err3 = out3.error.expect("expected error");
    assert_eq!(err3.path, "arg0[1].hp");
    assert_eq!(err3.offset, 6);
    assert_eq!(out3.unresolved_tail_from, Some(6));
}

#[test]
fn array_declared_over_cap_and_over_remaining() {
    // Declared 5 > cap 4 → MemoryLimit, offset = after the count is read
    let tight = DecodeLimits {
        max_array_len: 4,
        ..DecodeLimits::default()
    };
    let mut payload = Vec::new();
    payload.extend_from_slice(&5u32.to_le_bytes());
    let out = decode_layout(
        &[WireType::Array {
            of: Box::new(WireType::UInt8),
        }],
        &payload,
        &tight,
    );
    let err = out.error.expect("expected error");
    assert_eq!(err.kind, DecodeErrorKind::MemoryLimit);
    assert_eq!(err.path, "arg0");
    assert_eq!(err.offset, 4);

    // 4 U32 elements declared, only 4B left → precheck UnexpectedEof (the min_elem precheck matches codec)
    let mut payload2 = Vec::new();
    payload2.extend_from_slice(&4u32.to_le_bytes());
    payload2.extend_from_slice(&1u32.to_le_bytes());
    let out2 = decode_layout(
        &[WireType::Array {
            of: Box::new(WireType::UInt32),
        }],
        &payload2,
        &limits(),
    );
    let err2 = out2.error.expect("expected error");
    assert_eq!(err2.kind, DecodeErrorKind::UnexpectedEof);
    assert!(err2.message.contains("declared 4 elements"));
}

#[test]
fn depth_limit_hits_at_threaded_path() {
    // 65 levels of nested FD (single-field chain) exceed MAX_DECODE_DEPTH=64
    let mut ty = WireType::UInt8;
    for _ in 0..65 {
        ty = WireType::FixedDict {
            module: None,
            fields: vec![fd("x", ty)],
        };
    }
    let payload = vec![0x01];
    let out = decode_layout(&[ty], &payload, &limits());
    let err = out.error.expect("expected depth error");
    assert_eq!(err.kind, DecodeErrorKind::DepthLimit);
    assert!(err.path.starts_with("arg0"));
    assert!(
        err.path.matches('.').count() >= 64,
        "threaded path expected"
    );
}

// ---------------------------------------------------------------------------
// Honesty red lines
// ---------------------------------------------------------------------------

#[test]
fn structural_only_flag_and_note_are_carried() {
    let out = decode_layout(&[WireType::UInt8], &[1], &limits());
    assert!(out.structural_only);
    assert!(!LAYOUT_HONESTY_NOTE.is_empty());
    assert!(LAYOUT_HONESTY_NOTE.contains("不证明业务对象类型正确"));
}

// ---------------------------------------------------------------------------
// Parity with decode_spans (zero behavior drift)
// ---------------------------------------------------------------------------

#[test]
fn parity_with_decode_spans_ok_corpus() {
    let mut payload = Vec::new();
    payload.push(0x01);
    payload.extend_from_slice(&2u32.to_le_bytes());
    payload.extend_from_slice(&10u16.to_le_bytes());
    payload.extend_from_slice(&20u16.to_le_bytes());
    payload.extend_from_slice(&3u32.to_le_bytes());
    payload.extend_from_slice(b"abc");
    payload.extend_from_slice(&[1.0f32.to_le_bytes(), 2.0f32.to_le_bytes()].concat());
    let args = vec![
        WireType::Bool,
        WireType::Array {
            of: Box::new(WireType::UInt16),
        },
        WireType::FixedDict {
            module: Some("proj.m".to_string()),
            fields: vec![
                fd("body", WireType::Blob),
                fd("pos", WireType::Vector2),
                fd("tag", WireType::String),
            ],
        },
    ];
    parity(&args, &payload);
}

#[test]
fn parity_with_decode_spans_err_corpus() {
    // Truncated: U64 given only 3B
    parity(&[WireType::UInt64], &[1, 2, 3]);
    // FD second field truncated
    let args = vec![WireType::FixedDict {
        module: None,
        fields: vec![fd("a", WireType::UInt8), fd("b", WireType::UInt32)],
    }];
    parity(&args, &[1, 2, 3, 4]);
    // Array declared beyond the remainder
    parity(
        &[WireType::Array {
            of: Box::new(WireType::UInt16),
        }],
        &[3, 0, 0, 0, 1, 0],
    );
    // Unicode body over cap
    let tight = DecodeLimits {
        max_blob: 2,
        ..DecodeLimits::default()
    };
    let mut payload = Vec::new();
    payload.extend_from_slice(&9u32.to_le_bytes());
    payload.extend_from_slice(b"abcdef");
    let spans = decode_spans(&[WireType::Unicode], &payload, &tight);
    let layout = decode_layout(&[WireType::Unicode], &payload, &tight);
    assert!(spans.is_err() && layout.error.is_some());
    assert_eq!(spans.unwrap_err().offset, layout.error.unwrap().offset);
}

#[test]
fn parity_entity_call_overlap_semantics_locked() {
    // EntityCall does not advance the cursor: later args overlap the Raw span — the parity of both planes pins this same semantics
    let mut payload = Vec::new();
    payload.extend_from_slice(&[1, 2, 3, 4]);
    let args = vec![WireType::EntityCall, WireType::UInt8];
    parity(&args, &payload);
    let out = decode_layout(&args, &payload, &limits());
    assert_eq!(out.nodes[0].len, 4);
    assert_eq!(out.nodes[1].start, 0, "重叠语义 = span_inner 同款");
}

#[test]
fn remaining_scalar_and_vector4_layout_nodes_mirror_spans() {
    // Layout display plane shares the read order with the data plane: fill in the I8/I16/I32/U64/I64/F32
    // and Vector4 arms — each scalar arm's read_* and node lines must run once (a display-plane branch
    // that never runs = zero assertions on that arm's path threading and type label). The parity
    // comparison pins zero behavior drift between the two planes.
    let mut payload = Vec::new();
    payload.extend_from_slice(&(-7i8).to_le_bytes());
    payload.extend_from_slice(&(-300i16).to_le_bytes());
    payload.extend_from_slice(&(-123_456i32).to_le_bytes());
    payload.extend_from_slice(&0x11_22_33_44_55_66_77_88u64.to_le_bytes());
    payload.extend_from_slice(&(-2i64).to_le_bytes());
    payload.extend_from_slice(&2.5f32.to_le_bytes());
    for f in [1.0f32, 2.0, 3.0, 4.0] {
        payload.extend_from_slice(&f.to_le_bytes());
    }
    let args = vec![
        WireType::Int8,
        WireType::Int16,
        WireType::Int32,
        WireType::UInt64,
        WireType::Int64,
        WireType::Float,
        WireType::Vector4,
    ];
    parity(&args, &payload);
    let out = decode_layout(&args, &payload, &limits());
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.nodes.len(), 7);
    assert!(out.structural_only, "展示面必须携带诚实声明");
    // Path threading: top level arg{i}; Vector4 children arg6[i]
    assert_eq!(out.nodes[0].path, "arg0");
    assert_eq!(out.nodes[5].path, "arg5");
    assert_eq!(out.nodes[6].children.len(), 4);
    assert_eq!(out.nodes[6].children[2].path, "arg6[2]");
    assert_eq!(out.nodes[6].children[2].type_label, "f32");
    // Type labels come from the schema (display_name); the display plane must not invent them
    assert_eq!(out.nodes[0].type_label, WireType::Int8.display_name());
    assert_eq!(out.nodes[6].type_label, WireType::Vector4.display_name());
}
