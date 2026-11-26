//! Wire layout interpretation (KSEM-SER-12): on top of the existing codec/span
//! results (same read order, same limits, same error semantics as
//! [`crate::codec::decode_spans`]), it produces a field path / type label / byte
//! offset tree plus the first error location.
//!
//! Red line (SER-12 acceptance item 3): a span tree only proves the bytes can be
//! walked per the schema — **bytes parse ≠ business object type is correct**;
//! PYTHON bucket bodies = opaque pickle Raw (same boundary as SER-11), and
//! EntityCall/Unresolved fabricate no field order (same boundary as PA-001 TODO-2).
//!
//! Division of labor with `decode_spans`: span tree = data plane (the Wireshark
//! plugin renders registered fields); layout tree = display plane (nodes carry a path
//! and type label, errors located down to `arg1.members[2]` granularity — `span_inner`
//! does not thread the path, so this plane builds its own mirror with the same read
//! order; the parity comparison is pinned by `tests/layout_units.rs`: same corpus,
//! same Ok/Err, same bytes consumed, and Ok trees deep-equal per node
//! start/len/kind).

use crate::codec::{min_element_size, Budget, DecodeLimits, SpanKind, MAX_DECODE_DEPTH};
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};
use kode_kbengine_schema::wire::WireType;

/// Layout interpretation node: path + type label + byte range (relative to the payload start) + children.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutNode {
    /// Field path (`arg0` / `arg1.members[2]` / `arg0.cfg.hp` style).
    pub path: String,
    /// Type label (the schema [`WireType::display_name`]; a segment label for synthesized segments).
    pub type_label: String,
    /// Byte offset relative to the payload start.
    pub start: usize,
    pub len: usize,
    pub kind: SpanKind,
    pub children: Vec<LayoutNode>,
}

/// One layout interpretation: successful nodes + the first error (location and path)
/// + the start of the uninterpreted trailing bytes after that first error.
///
/// Stop at the first error: after the error the cursor sits at a half-read position,
/// so the byte interpretation of later args is unreliable — nothing is fabricated
/// (on the engine side a type error is an OUT_TYPE_ERROR failing the whole frame;
/// same semantics).
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutExplanation {
    pub nodes: Vec<LayoutNode>,
    pub error: Option<DecodeError>,
    /// Cursor offset at the first error; bytes after it are uninterpreted. None when there is no error.
    pub unresolved_tail_from: Option<usize>,
    /// Always true: this tree only proves the bytes can be walked per the schema,
    /// **not that the business object type is correct** (SER-12 acceptance red line;
    /// the display plane must carry this disclaimer and consumers must not use it to
    /// declare an object correct).
    pub structural_only: bool,
}

/// The verbatim honesty disclaimer of layout interpretation (the display plane may quote it directly).
pub const LAYOUT_HONESTY_NOTE: &str =
    "布局解释只证明字节按 schema 可走读,不证明业务对象类型正确;pickle/EntityCall 段不透明。";

/// Resolve the layout interpretation tree from the schema wire types: same read order,
/// limit checks and error semantics as [`crate::codec::decode_spans`]; on Ok there is one
/// top-level node per arg, on Err the result lands in [`LayoutExplanation::error`]
/// (location = payload offset at the failing read point, path = the threaded field path).
pub fn decode_layout(
    args: &[WireType],
    payload: &[u8],
    limits: &DecodeLimits,
) -> LayoutExplanation {
    let mut cur = Cursor::new(payload);
    let mut budget = Budget { values: 0 };
    let mut nodes = Vec::with_capacity(args.len());
    for (i, ty) in args.iter().enumerate() {
        match layout_inner(ty, &format!("arg{i}"), &mut cur, limits, 0, &mut budget) {
            Ok(node) => nodes.push(node),
            Err(err) => {
                let tail = cur.offset();
                return LayoutExplanation {
                    nodes,
                    error: Some(err),
                    unresolved_tail_from: Some(tail),
                    structural_only: true,
                };
            }
        }
    }
    LayoutExplanation {
        nodes,
        error: None,
        unresolved_tail_from: None,
        structural_only: true,
    }
}

/// Layout mirror of `span_inner`: same Cursor read order, same limit checks and error
/// text; the difference = path threading throughout + nodes carrying path/type label.
/// Errors produced at this level get their path rewritten to the threaded path (kind/
/// offset/message preserved); errors from deeper levels are forwarded as-is (the deepest
/// path is the true location).
fn layout_inner(
    ty: &WireType,
    path: &str,
    cur: &mut Cursor,
    limits: &DecodeLimits,
    depth: usize,
    budget: &mut Budget,
) -> Result<LayoutNode, DecodeError> {
    if depth > MAX_DECODE_DEPTH {
        return Err(DecodeError::new(
            DecodeErrorKind::DepthLimit,
            cur.offset(),
            path,
            format!("recursion over {MAX_DECODE_DEPTH}"),
        ));
    }
    budget.take(limits, path)?;
    let start = cur.offset();
    let type_label = ty.display_name();
    let node = |kind: SpanKind, end: usize, children: Vec<LayoutNode>| LayoutNode {
        path: path.to_string(),
        type_label: type_label.clone(),
        start,
        len: end - start,
        kind,
        children,
    };
    Ok(match ty {
        WireType::Bool => {
            cur.read_u8().map_err(|e| with_path(e, path))?;
            node(SpanKind::Bool, cur.offset(), Vec::new())
        }
        WireType::UInt8 => {
            cur.read_u8().map_err(|e| with_path(e, path))?;
            node(SpanKind::U8, cur.offset(), Vec::new())
        }
        WireType::Int8 => {
            cur.read_i8().map_err(|e| with_path(e, path))?;
            node(SpanKind::I8, cur.offset(), Vec::new())
        }
        WireType::UInt16 => {
            cur.read_u16().map_err(|e| with_path(e, path))?;
            node(SpanKind::U16, cur.offset(), Vec::new())
        }
        WireType::Int16 => {
            cur.read_i16().map_err(|e| with_path(e, path))?;
            node(SpanKind::I16, cur.offset(), Vec::new())
        }
        WireType::UInt32 => {
            cur.read_u32().map_err(|e| with_path(e, path))?;
            node(SpanKind::U32, cur.offset(), Vec::new())
        }
        WireType::Int32 => {
            cur.read_i32().map_err(|e| with_path(e, path))?;
            node(SpanKind::I32, cur.offset(), Vec::new())
        }
        WireType::UInt64 => {
            cur.read_u64().map_err(|e| with_path(e, path))?;
            node(SpanKind::U64, cur.offset(), Vec::new())
        }
        WireType::Int64 => {
            cur.read_i64().map_err(|e| with_path(e, path))?;
            node(SpanKind::I64, cur.offset(), Vec::new())
        }
        WireType::Float => {
            cur.read_f32().map_err(|e| with_path(e, path))?;
            node(SpanKind::F32, cur.offset(), Vec::new())
        }
        WireType::Double => {
            cur.read_f64().map_err(|e| with_path(e, path))?;
            node(SpanKind::F64, cur.offset(), Vec::new())
        }
        WireType::String => {
            let _ = cur.read_cstring();
            node(SpanKind::Str, cur.offset(), Vec::new())
        }
        // The u32 length-prefixed family: 4B prefix + body, two levels (body Str/Bytes/Raw).
        WireType::Unicode | WireType::Blob | WireType::Python => {
            let body_start = start + 4;
            cur.read_blob(limits).map_err(|e| with_path(e, path))?;
            let (body_kind, body_label) = match ty {
                WireType::Python => (SpanKind::Raw, "pickle body (opaque)"),
                WireType::Unicode => (SpanKind::Str, "utf-8 body"),
                _ => (SpanKind::Bytes, "bytes body"),
            };
            node(
                SpanKind::Group,
                cur.offset(),
                vec![
                    LayoutNode {
                        path: format!("{path}.len"),
                        type_label: "u32 length".to_string(),
                        start,
                        len: 4,
                        kind: SpanKind::U32,
                        children: Vec::new(),
                    },
                    LayoutNode {
                        path: format!("{path}.body"),
                        type_label: body_label.to_string(),
                        start: body_start,
                        len: cur.offset() - body_start,
                        kind: body_kind,
                        children: Vec::new(),
                    },
                ],
            )
        }
        WireType::Vector2 | WireType::Vector3 | WireType::Vector4 => {
            let n = match ty {
                WireType::Vector2 => 2,
                WireType::Vector3 => 3,
                _ => 4,
            };
            for _ in 0..n {
                cur.read_f32().map_err(|e| with_path(e, path))?;
            }
            let children = (0..n)
                .map(|i| LayoutNode {
                    path: format!("{path}[{i}]"),
                    type_label: "f32".to_string(),
                    start: start + i * 4,
                    len: 4,
                    kind: SpanKind::F32,
                    children: Vec::new(),
                })
                .collect();
            node(SpanKind::Group, cur.offset(), children)
        }
        WireType::Array { of } => {
            let count = cur.read_u32().map_err(|e| with_path(e, path))? as usize;
            if count > limits.max_array_len {
                return Err(DecodeError::new(
                    DecodeErrorKind::MemoryLimit,
                    cur.offset(),
                    path,
                    format!("declared {count} > cap {}", limits.max_array_len),
                ));
            }
            let min_elem = min_element_size(of);
            if min_elem > 0 && count.saturating_mul(min_elem) > cur.remaining() {
                return Err(DecodeError::new(
                    DecodeErrorKind::UnexpectedEof,
                    cur.offset(),
                    path,
                    format!("declared {count} elements, {} bytes left", cur.remaining()),
                ));
            }
            let mut children = Vec::with_capacity(count.min(4096));
            for i in 0..count {
                children.push(layout_inner(
                    of,
                    &format!("{path}[{i}]"),
                    cur,
                    limits,
                    depth + 1,
                    budget,
                )?);
            }
            node(SpanKind::Group, cur.offset(), children)
        }
        WireType::FixedDict { fields, .. } => {
            let mut children = Vec::with_capacity(fields.len());
            for f in fields {
                children.push(layout_inner(
                    &f.ty,
                    &format!("{path}.{}", f.name),
                    cur,
                    limits,
                    depth + 1,
                    budget,
                )?);
            }
            node(SpanKind::Group, cur.offset(), children)
        }
        // EntityCall/Unresolved: like span_inner, no cursor advance; Raw covers the remainder.
        WireType::EntityCall | WireType::Unresolved(_) => {
            let len = cur.rest().len();
            node(SpanKind::Raw, start + len, Vec::new())
        }
    })
}

/// Error path rewrite: keep kind/offset/message, swap the path for the threaded field path.
fn with_path(err: DecodeError, path: &str) -> DecodeError {
    DecodeError::new(err.kind, err.offset, path, err.message)
}
