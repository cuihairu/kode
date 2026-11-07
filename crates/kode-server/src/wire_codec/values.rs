// ---------------------------------------------------------------------------
// 值编解码(写入/读取裸字节,全小端)
// ---------------------------------------------------------------------------

use super::bytes::{push_blob, push_le_u16, push_le_u32};
use super::cursor::WireCursor;
use super::errors::WireError;
use super::types::{EntityCallValue, WireLayout, WireValue};

const MAX_ARRAY_ELEMENTS: u32 = 1 << 24;

pub fn encode_value(
    layout: &WireLayout,
    value: &WireValue,
    out: &mut Vec<u8>,
) -> Result<(), WireError> {
    match (layout, value) {
        (WireLayout::U8, WireValue::U8(v)) => out.push(*v),
        (WireLayout::U16, WireValue::U16(v)) => push_le_u16(out, *v),
        (WireLayout::U32, WireValue::U32(v)) => push_le_u32(out, *v),
        (WireLayout::U64, WireValue::U64(v)) => out.extend_from_slice(&v.to_le_bytes()),
        (WireLayout::I8, WireValue::I8(v)) => out.push(*v as u8),
        (WireLayout::I16, WireValue::I16(v)) => push_le_u16(out, *v as u16),
        (WireLayout::I32, WireValue::I32(v)) => push_le_u32(out, *v as u32),
        (WireLayout::I64, WireValue::I64(v)) => out.extend_from_slice(&(*v as u64).to_le_bytes()),
        (WireLayout::F32, WireValue::F32(v)) => out.extend_from_slice(&v.to_le_bytes()),
        (WireLayout::F64, WireValue::F64(v)) => out.extend_from_slice(&v.to_le_bytes()),
        (WireLayout::Bool, WireValue::Bool(v)) => out.push(*v as u8),
        (WireLayout::Str, WireValue::Str(s)) => {
            if !s.is_ascii() {
                return Err(WireError::NonAsciiString);
            }
            // 内嵌 NUL 是线上终止符:写出后解码在首 NUL 截断,往返静默
            // 损坏("a\0b"→"a")——宁可拒绝编码,不做静默截断(KODE-AUD-010)。
            if s.contains('\0') {
                return Err(WireError::EmbeddedNulString);
            }
            out.extend_from_slice(s.as_bytes());
            out.push(0);
        }
        (WireLayout::Unicode, WireValue::Unicode(b))
        | (WireLayout::Blob, WireValue::Blob(b))
        | (WireLayout::Py, WireValue::Py(b))
        | (WireLayout::PyDict, WireValue::PyDict(b))
        | (WireLayout::PyTuple, WireValue::PyTuple(b))
        | (WireLayout::PyList, WireValue::PyList(b)) => push_blob(out, b),
        (WireLayout::EntityCall, WireValue::EntityCall(ec)) => {
            push_le_u32(out, ec.id as u32);
            out.extend_from_slice(&ec.component_id.to_le_bytes());
            push_le_u16(out, ec.call_type);
            push_le_u16(out, ec.script_uid);
        }
        (WireLayout::Vec2, WireValue::Vec2(v)) => {
            out.extend_from_slice(&v[0].to_le_bytes());
            out.extend_from_slice(&v[1].to_le_bytes());
        }
        (WireLayout::Vec3, WireValue::Vec3(v)) => {
            for f in v {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        (WireLayout::Vec4, WireValue::Vec4(v)) => {
            for f in v {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        (WireLayout::Array(elem), WireValue::Array(items)) => {
            if items.len() as u64 > u64::from(u32::MAX) {
                return Err(WireError::ArraySizeTooLarge { size: u32::MAX });
            }
            push_le_u32(out, items.len() as u32);
            for item in items {
                encode_value(elem, item, out)?;
            }
        }
        (WireLayout::FixedDict(fields), WireValue::FixedDict(values)) => {
            if fields.len() != values.len() {
                return Err(WireError::TypeMismatch {
                    expected: "fixed-dict arity",
                    found: "value arity",
                });
            }
            for (f, v) in fields.iter().zip(values.iter()) {
                encode_value(&f.layout, v, out)?;
            }
        }
        (_, _) => {
            return Err(WireError::TypeMismatch {
                expected: layout_kind(layout),
                found: value_kind(value),
            })
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

/// 按布局解码值(ARRAY 流尽早停:剩余耗尽即截断返回部分,datatype.cpp:1876-1884)。
pub fn decode_value(layout: &WireLayout, cur: &mut WireCursor) -> Result<WireValue, WireError> {
    Ok(match layout {
        WireLayout::U8 => WireValue::U8(cur.read_u8()?),
        WireLayout::U16 => WireValue::U16(cur.read_u16()?),
        WireLayout::U32 => WireValue::U32(cur.read_u32()?),
        WireLayout::U64 => WireValue::U64(cur.read_u64()?),
        WireLayout::I8 => WireValue::I8(cur.read_i8()?),
        WireLayout::I16 => WireValue::I16(cur.read_i16()?),
        WireLayout::I32 => WireValue::I32(cur.read_i32()?),
        WireLayout::I64 => WireValue::I64(cur.read_i64()?),
        WireLayout::F32 => WireValue::F32(cur.read_f32()?),
        WireLayout::F64 => WireValue::F64(cur.read_f64()?),
        WireLayout::Bool => WireValue::Bool(cur.read_u8()? != 0),
        WireLayout::Str => WireValue::Str(cur.read_cstring()?),
        WireLayout::Unicode => WireValue::Unicode(cur.read_len_prefixed()?),
        WireLayout::Blob => WireValue::Blob(cur.read_len_prefixed()?),
        WireLayout::Py => WireValue::Py(cur.read_len_prefixed()?),
        WireLayout::PyDict => WireValue::PyDict(cur.read_len_prefixed()?),
        WireLayout::PyTuple => WireValue::PyTuple(cur.read_len_prefixed()?),
        WireLayout::PyList => WireValue::PyList(cur.read_len_prefixed()?),
        WireLayout::EntityCall => WireValue::EntityCall(EntityCallValue {
            id: cur.read_i32()?,
            component_id: cur.read_u64()?,
            call_type: cur.read_u16()?,
            script_uid: cur.read_u16()?,
        }),
        WireLayout::Vec2 => WireValue::Vec2([cur.read_f32()?, cur.read_f32()?]),
        WireLayout::Vec3 => WireValue::Vec3([cur.read_f32()?, cur.read_f32()?, cur.read_f32()?]),
        WireLayout::Vec4 => WireValue::Vec4([
            cur.read_f32()?,
            cur.read_f32()?,
            cur.read_f32()?,
            cur.read_f32()?,
        ]),
        WireLayout::Array(elem) => {
            let size = cur.read_u32()?;
            if size > MAX_ARRAY_ELEMENTS {
                return Err(WireError::ArraySizeTooLarge { size });
            }
            let mut items = Vec::with_capacity(size.min(64) as usize);
            for _ in 0..size {
                if cur.remaining() == 0 {
                    break; // 流尽早停,部分数组 OK(datatype.cpp:1876-1884)
                }
                items.push(decode_value(elem, cur)?);
            }
            WireValue::Array(items)
        }
        WireLayout::FixedDict(fields) => {
            let mut values = Vec::with_capacity(fields.len());
            for f in fields {
                values.push(decode_value(&f.layout, cur)?);
            }
            WireValue::FixedDict(values)
        }
    })
}

// ---------------------------------------------------------------------------
// 描述(错误用)
// ---------------------------------------------------------------------------

fn layout_kind(l: &WireLayout) -> &'static str {
    match l {
        WireLayout::U8 => "u8",
        WireLayout::U16 => "u16",
        WireLayout::U32 => "u32",
        WireLayout::U64 => "u64",
        WireLayout::I8 => "i8",
        WireLayout::I16 => "i16",
        WireLayout::I32 => "i32",
        WireLayout::I64 => "i64",
        WireLayout::F32 => "f32",
        WireLayout::F64 => "f64",
        WireLayout::Bool => "bool",
        WireLayout::Str => "string",
        WireLayout::Unicode => "unicode",
        WireLayout::Blob => "blob",
        WireLayout::Py => "python",
        WireLayout::PyDict => "py_dict",
        WireLayout::PyTuple => "py_tuple",
        WireLayout::PyList => "py_list",
        WireLayout::EntityCall => "entity_call",
        WireLayout::Vec2 => "vector2",
        WireLayout::Vec3 => "vector3",
        WireLayout::Vec4 => "vector4",
        WireLayout::Array(_) => "array",
        WireLayout::FixedDict(_) => "fixed_dict",
    }
}

fn value_kind(v: &WireValue) -> &'static str {
    match v {
        WireValue::U8(_) => "u8",
        WireValue::U16(_) => "u16",
        WireValue::U32(_) => "u32",
        WireValue::U64(_) => "u64",
        WireValue::I8(_) => "i8",
        WireValue::I16(_) => "i16",
        WireValue::I32(_) => "i32",
        WireValue::I64(_) => "i64",
        WireValue::F32(_) => "f32",
        WireValue::F64(_) => "f64",
        WireValue::Bool(_) => "bool",
        WireValue::Str(_) => "string",
        WireValue::Unicode(_) => "unicode",
        WireValue::Blob(_) => "blob",
        WireValue::Py(_) => "python",
        WireValue::PyDict(_) => "py_dict",
        WireValue::PyTuple(_) => "py_tuple",
        WireValue::PyList(_) => "py_list",
        WireValue::EntityCall(_) => "entity_call",
        WireValue::Vec2(_) => "vector2",
        WireValue::Vec3(_) => "vector3",
        WireValue::Vec4(_) => "vector4",
        WireValue::Array(_) => "array",
        WireValue::FixedDict(_) => "fixed_dict",
    }
}
