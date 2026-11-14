//! 基础类型 + containers 编码值解码(PA-003「codec 基础类型」
//! 「containers ARRAY+FIXED_DICT」)。
//!
//! 规则全部取自 PA-001(docs/kbengine-wire-protocol.md §3/§3.1);
//! 红线落地:失败不 panic / 内存有限([`DecodeLimits`])/ 递归有界
//! ([`MAX_DECODE_DEPTH`])/ 未知类型 Raw 保留(不猜测、不丢字节)。

use kode_kbengine_schema::wire::{WireType, MAX_TYPE_DEPTH};

pub use crate::cursor::read_utf8_body;
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};

/// 运行时解码值。
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Bool(bool),
    /// 有符号标量(INT8/16/32/64)。
    Int(i64),
    /// 无符号标量(UINT8/16/32/64)。
    UInt(u64),
    Float(f64),
    Str(String),
    /// BLOB / Raw 保留体。
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    /// FIXED_DICT:声明序键值(线上无键名,键名来自 schema)。
    Dict(Vec<(String, Value)>),
    /// 无法按 schema 解码(未知类型/ENTITYCALL/pickle):原始字节 + 原因。
    Raw(RawValue),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawValue {
    pub reason: String,
    pub bytes: Vec<u8>,
}

/// 内存/递归上限(红线参数;默认值对齐解析器用途,可按调用方收紧)。
#[derive(Debug, Clone)]
pub struct DecodeLimits {
    /// 单块(字符串/字节块/数组体)最大字节数。
    pub max_blob: usize,
    /// 单数组最大元素数。
    pub max_array_len: usize,
    /// 单次解码最大值节点数(防 FIXED_DICT 大模板放大)。
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

/// 解码递归深度上限(与 schema 侧 MAX_TYPE_DEPTH 同级,独立防线)。
pub const MAX_DECODE_DEPTH: usize = MAX_TYPE_DEPTH;

/// 内部计数器(值节点数限幅;layout 展示面共用同一记账)。
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

/// 按 schema 线类型解码一个值。
///
/// 未知类型([`WireType::Unresolved`]/[`WireType::EntityCall`])消费当前
/// 区域剩余全部字节为 Raw:下游解码在该边界安全停住,字节不丢、不编造
/// (PA-001 TODO-2:ENTITYCALL 完整线格式未取证)。
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
            // 元素最小字节数预检:声明数 × 最小元素必须 ≤ 剩余(防 4G 声明
            // 触发逐元素逐次 EOF 报错放大)。
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

/// 元素最小线字节数(数组预检;变长元素返回 1B 下限:至少能放 0 长度)。
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
// 有类型跨度树(PA-006 插件字段树数据面;additive——不参与上方解码路径,
// 供 Wireshark 插件按注册字段渲染字节区间)。
// ---------------------------------------------------------------------------

/// 跨度种类(插件按此选注册字段;F32/F64 走字节面——libwireshark alpha
/// 未暴露 FT_FLOAT/FT_DOUBLE,如实不解值不编造)。
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
    /// 容器/复合(数组、FIXED_DICT、带长度前缀的 Unicode/Blob/Python、
    /// 定长 Vector)——字节范围 + 子项。
    Group,
}

/// 一次解码的字节跨度:相对载荷起点的偏移/长度,嵌套容器带 children。
/// 只覆盖解码消费的前缀;尾残字节(帧内 arg 之外)不编造跨度。
#[derive(Debug, Clone, PartialEq)]
pub struct ValueSpan {
    /// 相对载荷(payload)起点的字节偏移。
    pub start: usize,
    pub len: usize,
    pub kind: SpanKind,
    pub children: Vec<ValueSpan>,
}

/// 按 schema 线类型解出跨度树:与 [`decode_value`] 同读序、同错误语义、
/// 同限额(预算/深度/数组预检),Ok 时逐参数一个顶层跨度。
///
/// 这是字段树的数据面(插件零解析逻辑,协议 crate 单一来源);与
/// [`decode_value`] 的对拍由 `tests/span_units.rs` 锁定(同语料同 Ok/Err、
/// 同消费字节数)。
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

/// `decode_inner` 的跨度镜像:同一 Cursor 读序、同一限额检查与错误文本;
/// 唯一差异 = 记录消费区间而非值(EntityCall/Unresolved 同 decode_inner
/// 不推进游标,跨度覆盖剩余字节)。
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
    // end 参数化:闭包不捕获 cur,避免与 read_* 可变借用冲突。
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
        // 带 u32 长度前缀的族:前缀 4B + 体,两层(体 Str/Bytes/Raw)。
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
        // EntityCall/Unresolved:同 decode_inner 不推进游标,Raw 覆盖剩余。
        WireType::EntityCall | WireType::Unresolved(_) => ValueSpan {
            start,
            len: cur.rest().len(),
            kind: SpanKind::Raw,
            children: Vec::new(),
        },
    })
}
