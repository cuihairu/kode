// ---------------------------------------------------------------------------
// 线上模型类型
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/// 纯位置布局(零 def 耦合,逐字节编码用)。FixedDict 键序=types.xml 声明序。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireLayout {
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
    Bool,
    Str,
    Unicode,
    Blob,
    /// PYTHON(载荷=pickle 字节,透传)。
    Py,
    /// PY_DICT(pickle 字节,透传)。
    PyDict,
    /// PY_TUPLE(pickle 字节,透传)。
    PyTuple,
    /// PY_LIST(pickle 字节,透传)。
    PyList,
    /// ENTITYCALL:16 字节定长结构(id i32 + component_id u64 + call_type u16 + script_uid u16)。
    EntityCall,
    Vec2,
    Vec3,
    Vec4,
    Array(Box<WireLayout>),
    FixedDict(Vec<WireField>),
}

/// FIXED_DICT 字段(名 + 布局),按 types.xml 声明序。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireField {
    pub name: String,
    pub layout: WireLayout,
}

/// 带标签值(往返无损;容器位置序保证逐字节精确)。PYTHON 系=不透明 pickle 字节。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WireValue {
    U8(u8),
    U16(u16),
    U32(u32),
    U64(u64),
    I8(i8),
    I16(i16),
    I32(i32),
    I64(i64),
    F32(f32),
    F64(f64),
    Bool(bool),
    /// STRING(ASCII 子集,NUL 结尾;解码遇非 ASCII 停)。
    Str(String),
    /// UNICODE(u32 长度 + UTF-8 字节)。
    Unicode(Vec<u8>),
    /// BLOB(u32 长度 + 字节)。
    Blob(Vec<u8>),
    /// PYTHON(u32 长度 + pickle 字节)。
    Py(Vec<u8>),
    /// PY_DICT(u32 长度 + pickle 字节)。
    PyDict(Vec<u8>),
    /// PY_TUPLE(u32 长度 + pickle 字节)。
    PyTuple(Vec<u8>),
    /// PY_LIST(u32 长度 + pickle 字节)。
    PyList(Vec<u8>),
    /// ENTITYCALL(id, component_id, call_type, script_uid)——16 字节定长。
    EntityCall(EntityCallValue),
    Vec2([f32; 2]),
    Vec3([f32; 3]),
    Vec4([f32; 4]),
    Array(Vec<WireValue>),
    FixedDict(Vec<WireValue>),
}

/// ENTITYCALL 值(id i32 + component_id u64 + call_type u16 + script_uid u16)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EntityCallValue {
    pub id: i32,
    pub component_id: u64,
    pub call_type: u16,
    pub script_uid: u16,
}
