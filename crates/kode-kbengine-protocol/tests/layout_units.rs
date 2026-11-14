//! wire 布局解释(KSEM-SER-12)单测:
//! ①路径/类型标签/偏移结构断言;②错误位置(线程化路径 + 字节偏移 +
//! 未解释尾界);③诚实红线(PYTHON 桶 Raw 不编造、EntityCall/Unresolved
//! 透传、structural_only 恒真);④与 [`decode_spans`] 对拍(同语料同
//! Ok/Err、同消费字节数、Ok 树逐节点 start/len/kind 深等——展示面与
//! 数据面零行为漂移)。

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

/// 对拍:Ok 树逐节点 start/len/kind 深等(路径/标签是展示面增量,不比)。
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

/// 对拍:同语料同 Ok/Err;Err 时 kind/offset/message 同(layout 路径为
/// 线程化增量,不比 message 之外的字段差异)。
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
// 路径 / 类型标签 / 偏移
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
    // 声明序 = wire 序(SER-02 §2):hp 先于 name
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
    assert_eq!((root.start, root.len), (0, 12)); // 计数前缀在组区间内
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
// 长度前缀族 / 向量 / 不透明段
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
    assert_eq!((root.start, root.len), (0, 6)); // 覆盖剩余,不编造字段序

    let un = decode_layout(
        &[WireType::Unresolved("Ghost".to_string())],
        &payload,
        &limits(),
    );
    assert_eq!(un.nodes[0].type_label, "UNRESOLVED<Ghost>");
    assert_eq!(un.nodes[0].kind, SpanKind::Raw);
}

// ---------------------------------------------------------------------------
// 错误位置(线程化路径 + 偏移 + 未解释尾界)
// ---------------------------------------------------------------------------

#[test]
fn top_level_error_position_and_tail() {
    // arg1 需要 4B,只有 1B
    let payload = vec![0x11, 0x22];
    let args = vec![WireType::UInt8, WireType::UInt32];
    let out = decode_layout(&args, &payload, &limits());
    let err = out.error.expect("expected error");
    assert_eq!(err.kind, DecodeErrorKind::UnexpectedEof);
    assert_eq!(err.offset, 1); // 游标到达处 = 错误字节位
    assert_eq!(err.path, "arg1");
    assert_eq!(out.unresolved_tail_from, Some(1));
    assert_eq!(out.nodes.len(), 1); // arg0 已解释
    assert!(out.structural_only);
}

#[test]
fn nested_error_paths_dict_field_and_array_element() {
    // FD.hp 截断:读 u16 失败不消费 → 错误位 = 当前游标(0),需 2B 只有 1B
    let args = vec![WireType::FixedDict {
        module: None,
        fields: vec![fd("hp", WireType::UInt16)],
    }];
    let out = decode_layout(&args, &[0x11], &limits());
    let err = out.error.expect("expected error");
    assert_eq!(err.path, "arg0.hp");
    assert_eq!(err.offset, 0);

    // 数组预检:声明 3 元素 U32 只剩 8B → 数组级路径 + 计数读完后偏移
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

    // 元素级线程化路径:预检(min=1)放行后,第 2 个 FD 元素 hp 截断
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
    // 声明 5 > cap 4 → MemoryLimit,offset = 计数读完后
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

    // 声明 4 元素 U32 只剩 4B → 预检 UnexpectedEof(min_elem 预检同 codec)
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
    // 65 层嵌套 FD(单字段链)超过 MAX_DECODE_DEPTH=64
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
// 诚实红线
// ---------------------------------------------------------------------------

#[test]
fn structural_only_flag_and_note_are_carried() {
    let out = decode_layout(&[WireType::UInt8], &[1], &limits());
    assert!(out.structural_only);
    assert!(!LAYOUT_HONESTY_NOTE.is_empty());
    assert!(LAYOUT_HONESTY_NOTE.contains("不证明业务对象类型正确"));
}

// ---------------------------------------------------------------------------
// 与 decode_spans 对拍(零行为漂移)
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
    // 截断:U64 只给 3B
    parity(&[WireType::UInt64], &[1, 2, 3]);
    // FD 第二字段截断
    let args = vec![WireType::FixedDict {
        module: None,
        fields: vec![fd("a", WireType::UInt8), fd("b", WireType::UInt32)],
    }];
    parity(&args, &[1, 2, 3, 4]);
    // 数组声明超剩
    parity(
        &[WireType::Array {
            of: Box::new(WireType::UInt16),
        }],
        &[3, 0, 0, 0, 1, 0],
    );
    // Unicode 体超 cap
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
    // EntityCall 不推进游标:后续 arg 与 Raw 跨度重叠——两面对拍锁同一语义
    let mut payload = Vec::new();
    payload.extend_from_slice(&[1, 2, 3, 4]);
    let args = vec![WireType::EntityCall, WireType::UInt8];
    parity(&args, &payload);
    let out = decode_layout(&args, &payload, &limits());
    assert_eq!(out.nodes[0].len, 4);
    assert_eq!(out.nodes[1].start, 0, "重叠语义 = span_inner 同款");
}
