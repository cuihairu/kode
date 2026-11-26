//! Basic types + containers value decoding (PA-003 "codec basic types",
//! "containers ARRAY+FIXED_DICT").
//!
//! Every rule comes from PA-001 (docs/kbengine-wire-protocol.md §3/§3.1);
//! red lines landed: no panic on failure / memory bounded ([`DecodeLimits`]) / recursion bounded
//! ([`MAX_DECODE_DEPTH`]) / unknown types kept as Raw (no guessing, no dropped bytes).

use kode_kbengine_schema::wire::{WireType, MAX_TYPE_DEPTH};

pub use crate::cursor::read_utf8_body;
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};

/// Runtime decoded value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Bool(bool),
    /// Signed scalar (INT8/16/32/64).
    Int(i64),
    /// Unsigned scalar (UINT8/16/32/64).
    UInt(u64),
    Float(f64),
    Str(String),
    /// BLOB / Raw retained body.
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    /// FIXED_DICT: key/values in declared order (no key names on the wire; names come from the schema).
    Dict(Vec<(String, Value)>),
    /// Cannot be decoded per the schema (unknown type / ENTITYCALL / pickle): raw bytes + reason.
    Raw(RawValue),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawValue {
    pub reason: String,
    pub bytes: Vec<u8>,
}

/// Memory/recursion caps (red-line parameters; defaults suit a parser and callers may tighten them).
#[derive(Debug, Clone)]
pub struct DecodeLimits {
    /// Maximum bytes for a single block (string / byte block / array body).
    pub max_blob: usize,
    /// Maximum elements in a single array.
    pub max_array_len: usize,
    /// Maximum value nodes per single decode (guards against FIXED_DICT big-template amplification).
    pub max_values: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        DecodeLimits {
            max_blob: 8 * 1024 * 1024,
            max_array_len: 1_000_000,
            max_values: 200_000,
        }
    }
}

/// Decode recursion depth cap (same tier as the schema-side MAX_TYPE_DEPTH, an independent line of defense).
pub const MAX_DECODE_DEPTH: usize = MAX_TYPE_DEPTH;

/// Internal counter (caps the number of value nodes; the layout display plane shares the same ledger).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Budget {
    pub(crate) values: usize,
}

impl Budget {
    pub(crate) fn take(&mut self, limits: &DecodeLimits, path: &str) -> Result<(), DecodeError> {
        self.values += 1;
        if self.values > limits.max_values {
            return Err(DecodeError::new(
                DecodeErrorKind::MemoryLimit,
                0,
                path,
                format!("value count over cap {}", limits.max_values),
            ));
        }
        Ok(())
    }
}

/// Decode one value per the schema wire type.
///
/// Unknown types ([`WireType::Unresolved`] / [`WireType::EntityCall`]) consume all remaining bytes
/// of the current region as Raw: downstream decoding stops safely at that boundary, bytes are
/// neither lost nor fabricated (PA-001 TODO-2: the full ENTITYCALL wire format is not
/// forensically pinned).
pub fn decode_value(
    ty: &WireType,
    cur: &mut Cursor,
    limits: &DecodeLimits,
    depth: usize,
) -> Result<Value, DecodeError> {
    let mut budget = Budget { values: 0 };
    let v = decode_inner(ty, cur, limits, depth, &mut budget)?;
    Ok(v)
}

fn decode_inner(
    ty: &WireType,
    cur: &mut Cursor,
    limits: &DecodeLimits,
    depth: usize,
    budget: &mut Budget,
) -> Result<Value, DecodeError> {
    if depth > MAX_DECODE_DEPTH {
        return Err(DecodeError::new(
            DecodeErrorKind::DepthLimit,
            cur.offset(),
            "depth",
            format!("recursion over {MAX_DECODE_DEPTH}"),
        ));
    }
    budget.take(limits, "value")?;
    Ok(match ty {
        WireType::Bool => Value::Bool(cur.read_u8()? != 0),
        WireType::UInt8 => Value::UInt(cur.read_u8()? as u64),
        WireType::Int8 => Value::Int(cur.read_i8()? as i64),
        WireType::UInt16 => Value::UInt(cur.read_u16()? as u64),
        WireType::Int16 => Value::Int(cur.read_i16()? as i64),
        WireType::UInt32 => Value::UInt(cur.read_u32()? as u64),
        WireType::Int32 => Value::Int(cur.read_i32()? as i64),
        WireType::UInt64 => Value::UInt(cur.read_u64()?),
        WireType::Int64 => Value::Int(cur.read_i64()?),
        WireType::Float => Value::Float(cur.read_f32()? as f64),
        WireType::Double => Value::Float(cur.read_f64()?),
        WireType::String => Value::Str(cur.read_cstring()?),
        WireType::Unicode => {
            let len = cur.read_u32()? as usize;
            Value::Str(read_utf8_body(cur, len, limits)?)
        }
        WireType::Blob => Value::Bytes(cur.read_blob(limits)?.to_vec()),
        WireType::Python => {
            let bytes = cur.read_blob(limits)?;
            Value::Raw(RawValue {
                reason: "CPython pickle passthrough (datatype.cpp:1225-1242); not decoded".into(),
                bytes: bytes.to_vec(),
            })
        }
        WireType::Vector2 => {
            let x = cur.read_f32()?;
            let y = cur.read_f32()?;
            Value::Array(vec![Value::Float(x as f64), Value::Float(y as f64)])
        }
        WireType::Vector3 => {
            let (x, y, z) = (cur.read_f32()?, cur.read_f32()?, cur.read_f32()?);
            Value::Array(vec![
                Value::Float(x as f64),
                Value::Float(y as f64),
                Value::Float(z as f64),
            ])
        }
        WireType::Vector4 => {
            let (x, y, z, w) = (
                cur.read_f32()?,
                cur.read_f32()?,
                cur.read_f32()?,
                cur.read_f32()?,
            );
            Value::Array(vec![
                Value::Float(x as f64),
                Value::Float(y as f64),
                Value::Float(z as f64),
                Value::Float(w as f64),
            ])
        }
        WireType::Array { of } => {
            let count = cur.read_u32()? as usize;
            if count > limits.max_array_len {
                return Err(DecodeError::new(
                    DecodeErrorKind::MemoryLimit,
                    cur.offset(),
                    "array",
                    format!("declared {count} > cap {}", limits.max_array_len),
                ));
            }
            // Element minimum-size precheck: declared count × smallest element must be ≤ remaining
            // (prevents a 4G declaration from triggering per-element EOF errors one after another).
            let min_elem = min_element_size(of);
            if min_elem > 0 && count.saturating_mul(min_elem) > cur.remaining() {
                return Err(DecodeError::new(
                    DecodeErrorKind::UnexpectedEof,
                    cur.offset(),
                    "array",
                    format!("declared {count} elements, {} bytes left", cur.remaining()),
                ));
            }
            let mut out = Vec::with_capacity(count.min(4096));
            for i in 0..count {
                let v = decode_inner(of, cur, limits, depth + 1, budget)?;
                out.push(v);
                let _ = i;
            }
            Value::Array(out)
        }
        WireType::FixedDict { fields, .. } => {
            let mut out = Vec::with_capacity(fields.len());
            for f in fields {
                let v = decode_inner(&f.ty, cur, limits, depth + 1, budget)?;
                out.push((f.name.clone(), v));
            }
            Value::Dict(out)
        }
        WireType::EntityCall => Value::Raw(RawValue {
            reason:
                "ENTITYCALL property wire format not forensically pinned (PA-001 TODO-2); raw kept"
                    .into(),
            bytes: cur.rest().to_vec(),
        }),
        WireType::Unresolved(name) => Value::Raw(RawValue {
            reason: format!("unresolved schema type {name:?}; raw kept"),
            bytes: cur.rest().to_vec(),
        }),
    })
}

/// Minimum wire bytes of an element (array precheck; variable-length elements return the 1B floor: at least a 0 length fits).
pub(crate) fn min_element_size(ty: &WireType) -> usize {
    match ty {
        WireType::Bool | WireType::UInt8 | WireType::Int8 => 1,
        WireType::UInt16 | WireType::Int16 => 2,
        WireType::UInt32 | WireType::Int32 | WireType::Float => 4,
        WireType::UInt64 | WireType::Int64 | WireType::Double => 8,
        WireType::Vector2 => 8,
        WireType::Vector3 => 12,
        WireType::Vector4 => 16,
        _ => 1,
    }
}

// ---------------------------------------------------------------------------
// Typed span tree (PA-006 plugin field tree data plane; additive — not part of the
// decoding path above; lets the Wireshark plugin render byte ranges per registered
// field).
// ---------------------------------------------------------------------------

/// Span kind (the plugin picks a registered field from this; F32/F64 go through the byte
/// plane — the libwireshark alpha does not expose FT_FLOAT/FT_DOUBLE, so values are reported as
/// not decoded rather than fabricated).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanKind {
    Bool,
    U8,
    U16,
    U32,
    U64,
    I8,
    I16,
    I32,
    I64,
    F32,
    F64,
    Str,
    Bytes,
    Raw,
    /// Container/composite (arrays, FIXED_DICT, length-prefixed Unicode/Blob/Python,
    /// fixed-size Vector) — byte range + children.
    Group,
}

/// Byte spans of one decode: offset/length relative to the payload start; nested containers
/// carry children.
/// Covers only the prefix consumed by decoding; trailing residue bytes (outside the frame's args)
/// get no fabricated spans.
#[derive(Debug, Clone, PartialEq)]
pub struct ValueSpan {
    /// Byte offset relative to the payload start.
    pub start: usize,
    pub len: usize,
    pub kind: SpanKind,
    pub children: Vec<ValueSpan>,
}

/// Resolve the span tree from the schema wire types: same read order, same error semantics
/// and same limits (budget / depth / array precheck) as [`decode_value`]; on Ok there is one
/// top-level span per argument.
///
/// This is the data plane of the field tree (the plugin has zero parsing logic; the protocol
/// crate is the single source); the parity comparison with [`decode_value`] is pinned by
/// `tests/span_units.rs` (same corpus, same Ok/Err, same bytes consumed).
pub fn decode_spans(
    args: &[WireType],
    payload: &[u8],
    limits: &DecodeLimits,
) -> Result<Vec<ValueSpan>, DecodeError> {
    let mut cur = Cursor::new(payload);
    let mut budget = Budget { values: 0 };
    let mut out = Vec::with_capacity(args.len());
    for ty in args {
        out.push(span_inner(ty, &mut cur, limits, 0, &mut budget)?);
    }
    Ok(out)
}

/// Span mirror of `decode_inner`: same Cursor read order, same limit checks and error text;
/// the only difference = it records the consumed range instead of the value (EntityCall/
/// Unresolved, like decode_inner, do not advance the cursor; the span covers the remaining bytes).
fn span_inner(
    ty: &WireType,
    cur: &mut Cursor,
    limits: &DecodeLimits,
    depth: usize,
    budget: &mut Budget,
) -> Result<ValueSpan, DecodeError> {
    if depth > MAX_DECODE_DEPTH {
        return Err(DecodeError::new(
            DecodeErrorKind::DepthLimit,
            cur.offset(),
            "depth",
            format!("recursion over {MAX_DECODE_DEPTH}"),
        ));
    }
    budget.take(limits, "value")?;
    let start = cur.offset();
    // end is parameterized: the closure does not capture cur, avoiding a conflict with the read_* mutable borrows.
    let leaf = |kind: SpanKind, end: usize| ValueSpan {
        start,
        len: end - start,
        kind,
        children: Vec::new(),
    };
    Ok(match ty {
        WireType::Bool => {
            cur.read_u8()?;
            leaf(SpanKind::Bool, cur.offset())
        }
        WireType::UInt8 => {
            cur.read_u8()?;
            leaf(SpanKind::U8, cur.offset())
        }
        WireType::Int8 => {
            cur.read_i8()?;
            leaf(SpanKind::I8, cur.offset())
        }
        WireType::UInt16 => {
            cur.read_u16()?;
            leaf(SpanKind::U16, cur.offset())
        }
        WireType::Int16 => {
            cur.read_i16()?;
            leaf(SpanKind::I16, cur.offset())
        }
        WireType::UInt32 => {
            cur.read_u32()?;
            leaf(SpanKind::U32, cur.offset())
        }
        WireType::Int32 => {
            cur.read_i32()?;
            leaf(SpanKind::I32, cur.offset())
        }
        WireType::UInt64 => {
            cur.read_u64()?;
            leaf(SpanKind::U64, cur.offset())
        }
        WireType::Int64 => {
            cur.read_i64()?;
            leaf(SpanKind::I64, cur.offset())
        }
        WireType::Float => {
            cur.read_f32()?;
            leaf(SpanKind::F32, cur.offset())
        }
        WireType::Double => {
            cur.read_f64()?;
            leaf(SpanKind::F64, cur.offset())
        }
        WireType::String => {
            cur.read_cstring()?;
            leaf(SpanKind::Str, cur.offset())
        }
        // The u32 length-prefixed family: 4B prefix + body, two levels (body Str/Bytes/Raw).
        WireType::Unicode | WireType::Blob | WireType::Python => {
            let body_start = start + 4;
            cur.read_blob(limits)?;
            let body_kind = match ty {
                WireType::Python => SpanKind::Raw,
                WireType::Unicode => SpanKind::Str,
                _ => SpanKind::Bytes,
            };
            ValueSpan {
                start,
                len: cur.offset() - start,
                kind: SpanKind::Group,
                children: vec![
                    ValueSpan {
                        start,
                        len: 4,
                        kind: SpanKind::U32,
                        children: Vec::new(),
                    },
                    ValueSpan {
                        start: body_start,
                        len: cur.offset() - body_start,
                        kind: body_kind,
                        children: Vec::new(),
                    },
                ],
            }
        }
        WireType::Vector2 | WireType::Vector3 | WireType::Vector4 => {
            let n = match ty {
                WireType::Vector2 => 2,
                WireType::Vector3 => 3,
                _ => 4,
            };
            for _ in 0..n {
                cur.read_f32()?;
            }
            let children = (0..n)
                .map(|i| ValueSpan {
                    start: start + i * 4,
                    len: 4,
                    kind: SpanKind::F32,
                    children: Vec::new(),
                })
                .collect();
            ValueSpan {
                start,
                len: cur.offset() - start,
                kind: SpanKind::Group,
                children,
            }
        }
        WireType::Array { of } => {
            let count = cur.read_u32()? as usize;
            if count > limits.max_array_len {
                return Err(DecodeError::new(
                    DecodeErrorKind::MemoryLimit,
                    cur.offset(),
                    "array",
                    format!("declared {count} > cap {}", limits.max_array_len),
                ));
            }
            let min_elem = min_element_size(of);
            if min_elem > 0 && count.saturating_mul(min_elem) > cur.remaining() {
                return Err(DecodeError::new(
                    DecodeErrorKind::UnexpectedEof,
                    cur.offset(),
                    "array",
                    format!("declared {count} elements, {} bytes left", cur.remaining()),
                ));
            }
            let mut children = Vec::with_capacity(count.min(4096));
            for i in 0..count {
                children.push(span_inner(of, cur, limits, depth + 1, budget)?);
                let _ = i;
            }
            ValueSpan {
                start,
                len: cur.offset() - start,
                kind: SpanKind::Group,
                children,
            }
        }
        WireType::FixedDict { fields, .. } => {
            let mut children = Vec::with_capacity(fields.len());
            for f in fields {
                children.push(span_inner(&f.ty, cur, limits, depth + 1, budget)?);
            }
            ValueSpan {
                start,
                len: cur.offset() - start,
                kind: SpanKind::Group,
                children,
            }
        }
        // EntityCall/Unresolved: like decode_inner, no cursor advance; Raw covers the remainder.
        WireType::EntityCall | WireType::Unresolved(_) => ValueSpan {
            start,
            len: cur.rest().len(),
            kind: SpanKind::Raw,
            children: Vec::new(),
        },
    })
}
