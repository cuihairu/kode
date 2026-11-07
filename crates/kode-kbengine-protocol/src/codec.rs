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

/// 内部计数器(值节点数限幅)。
#[derive(Debug, Clone, Copy)]
struct Budget {
    values: usize,
}

impl Budget {
    fn take(&mut self, limits: &DecodeLimits, path: &str) -> Result<(), DecodeError> {
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
fn min_element_size(ty: &WireType) -> usize {
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
