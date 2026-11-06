//! def 驱动线格式编解码器(KBEngine 逐字节兼容,C-15)。
//!
//! message_table.rs 只给消息/属性/方法的 **编号表**(utype/别名 id/组件槽);
//! 本模块补 **字节级编解码**:Datatype 全集、属性更新流、方法调用参数、
//! 消息帧,全部小端(非网络序,memorystream_converter.h:43-48),与 KBEngine
//! 线格式逐字节兼容。黄金样本(`tests/golden/wire-parity.json`)为规范推导并
//! 带 `kbengine` 源 file:line provenance,`dump_wire_golden` 内置往返自校验。
//!
//! 分层:
//! - 纯位置编解码层 [`encode_value`]/[`decode_value`] + [`WireCursor`]:零 def 耦合,
//!   只按 [`WireLayout`] 走字节。标量定宽无 varint(memorystream.h L221-333);
//!   STRING=NUL 结尾无长度前缀(L224-229/L319-330,解码遇 NUL 或**非 ASCII** 停);
//!   UNICODE/BLOB/PYTHON*=uint32 LE 长度+字节(appendBlob memorystream.h:551)。
//! - def 名称解析层 [`WireSchema`]:结构重解析 `types.xml`/`alias.xml` 恢复
//!   FIXED_DICT 字段名与声明序(模型 `TypeNode::FixedDict.field_refs` 丢名折平
//!   <of> 不可用),[`WireSchema::resolve`] 按名取布局 + 环守卫。
//! - 高层入口:属性更新流、方法调用参数、消息帧(见各函数头注)。
//!
//! **PYTHON/PY_DICT/PY_TUPLE/PY_LIST 是不透明字节透传**:u32 长度框架,载荷是
//! `script::Pickler::pickle` 产物(datatype.cpp:1225/1288/1288,PyDict/Tuple/List
//! 继承 PythonType::addToStream 同一 pickle 路径)。kode 非 Python 运行时,
//! pickle 协议版本随嵌入 Python 构建而异(跨语言真实注意点)——本模块对
//! **u32 长度框架**逐字节负责,pickle 字节本身不透明透传。
//!
//! 全小端。`.def` schema 不上线(线上只有 utype/别名引用,entitydef.cpp 装配);
//! 畸形流一律 `Err`(不 panic),ARRAY 解码容忍流尽早停(datatype.cpp:1876-1884)。

use std::collections::BTreeMap;
use std::fmt;

use kode_parser::xml::parse as parse_xml;
use serde::{Deserialize, Serialize};

use crate::rpc::RpcRegistry;

/// ARRAY 解码的元素数上界(DoS 防护;规范流远低于此,超限报 [`WireError::ArraySizeTooLarge`])。
const MAX_ARRAY_ELEMENTS: u32 = 1 << 24;

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

// ---------------------------------------------------------------------------
// 错误(手动 Display + std::error::Error;不引入 thiserror 依赖)
// ---------------------------------------------------------------------------

/// 编解码错误(畸形流一律返回本类型,绝不 panic)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// 类型名未在 schema/内建表注册。
    UnknownType(String),
    /// 解析期类型环。
    Cycle(String),
    /// 值变体与布局不符。
    TypeMismatch {
        expected: &'static str,
        found: &'static str,
    },
    /// 流截断(需 need 字节,实有 have)。
    Truncated { need: usize, have: usize },
    /// 长度前缀超剩余字节(readBlob memorystream.h:425-440 同款)。
    LengthOverflow { length: u32, remaining: usize },
    /// ARRAY 声明/读出元素数超上界。
    ArraySizeTooLarge { size: u32 },
    /// 别名模式要求 ≤255 的 id 溢出。
    AliasIdOverflow(u16),
    /// Method argument count does not match its schema.
    ArgumentCountMismatch { expected: usize, actual: usize },
    /// A method identifier belongs to a different encoding mode.
    MethodModeMismatch,
    /// STRING 值含非 ASCII 字节(线上 STRING 遇非 ASCII 即停)。
    NonAsciiString,
    /// STRING 值含内嵌 NUL(NUL 是线上终止符,写进流解码即截断,静默损坏→拒绝)。
    EmbeddedNulString,
    /// hex 字符串非法。
    InvalidHex(String),
    /// 消息帧扩展长度超 u32。
    MessageTooLarge { size: usize },
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::UnknownType(n) => write!(f, "unknown wire type: {n}"),
            WireError::Cycle(n) => write!(f, "type cycle: {n}"),
            WireError::TypeMismatch { expected, found } => {
                write!(f, "type mismatch: expected {expected}, found {found}")
            }
            WireError::Truncated { need, have } => {
                write!(f, "truncated stream: need {need} bytes, have {have}")
            }
            WireError::LengthOverflow { length, remaining } => write!(
                f,
                "length prefix {length} exceeds remaining {remaining} bytes"
            ),
            WireError::ArraySizeTooLarge { size } => {
                write!(f, "array element count {size} exceeds bound")
            }
            WireError::AliasIdOverflow(id) => {
                write!(f, "alias id {id} exceeds uint8 bound (use utype mode)")
            }
            WireError::ArgumentCountMismatch { expected, actual } => {
                write!(f, "expected {expected} arguments, got {actual}")
            }
            WireError::MethodModeMismatch => {
                write!(f, "method identifier does not match encoding mode")
            }
            WireError::NonAsciiString => write!(f, "STRING value contains non-ASCII bytes"),
            WireError::EmbeddedNulString => write!(f, "STRING value contains embedded NUL byte"),
            WireError::InvalidHex(s) => write!(f, "invalid hex string: {s}"),
            WireError::MessageTooLarge { size } => {
                write!(f, "message size {size} exceeds u32 extended length")
            }
        }
    }
}

impl std::error::Error for WireError {}

// ---------------------------------------------------------------------------
// 游标(全小端)
// ---------------------------------------------------------------------------

/// 只读游标:全小端,截断即 [`WireError::Truncated`]。编码写入裸 `Vec<u8>`。
#[derive(Debug)]
pub struct WireCursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> WireCursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        WireCursor { data, pos: 0 }
    }

    /// 剩余字节数。
    pub fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        if self.remaining() < n {
            return Err(WireError::Truncated {
                need: n,
                have: self.remaining(),
            });
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn read_u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }

    pub fn read_u16(&mut self) -> Result<u16, WireError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn read_u32(&mut self) -> Result<u32, WireError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn read_u64(&mut self) -> Result<u64, WireError> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn read_i8(&mut self) -> Result<i8, WireError> {
        Ok(self.read_u8()? as i8)
    }

    pub fn read_i16(&mut self) -> Result<i16, WireError> {
        Ok(self.read_u16()? as i16)
    }

    pub fn read_i32(&mut self) -> Result<i32, WireError> {
        Ok(self.read_u32()? as i32)
    }

    pub fn read_i64(&mut self) -> Result<i64, WireError> {
        Ok(self.read_u64()? as i64)
    }

    pub fn read_f32(&mut self) -> Result<f32, WireError> {
        Ok(f32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }

    pub fn read_f64(&mut self) -> Result<f64, WireError> {
        Ok(f64::from_le_bytes(
            self.take(8)?.try_into().expect("8 bytes"),
        ))
    }

    /// STRING(NUL 结尾无前缀;遇 NUL 或**非 ASCII** 字节即停,终止字节被消费)。
    pub fn read_cstring(&mut self) -> Result<String, WireError> {
        let mut out: Vec<u8> = Vec::new();
        while self.remaining() > 0 {
            let c = self.read_u8()?;
            if c == 0 || !c.is_ascii() {
                break;
            }
            out.push(c);
        }
        String::from_utf8(out).map_err(|_| WireError::NonAsciiString)
    }

    /// uint32 长度前缀 + 字节(readBlob memorystream.h:425-440;长度超剩余→LengthOverflow)。
    pub fn read_len_prefixed(&mut self) -> Result<Vec<u8>, WireError> {
        let len = self.read_u32()? as usize;
        if len > self.remaining() {
            return Err(WireError::LengthOverflow {
                length: len as u32,
                remaining: self.remaining(),
            });
        }
        Ok(self.take(len)?.to_vec())
    }
}

// ---------------------------------------------------------------------------
// 编码(写入裸 Vec<u8>,全小端)
// ---------------------------------------------------------------------------

fn push_le_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn push_le_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn push_blob(out: &mut Vec<u8>, bytes: &[u8]) {
    push_le_u32(out, bytes.len() as u32);
    out.extend_from_slice(bytes);
}

/// 按布局编码值(精确宽度;与 KBEngine DataType::addToStream 逐字节对应)。
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

// ---------------------------------------------------------------------------
// Schema(types.xml/alias.xml 结构重解析 → 名→布局)
// ---------------------------------------------------------------------------

/// 结构重解析得到的类型表达式(保留字段名/声明序,环在 resolve 检测)。
#[derive(Debug, Clone, PartialEq)]
enum RawType {
    /// 内建标量(UINT32/STRING/VECTOR3/...)。
    Builtin(String),
    /// 指向另一命名类型(types.xml 别名 directive / alias.xml 目标 / 自定义名)。
    Named(String),
    /// ARRAY <of> 元素表达式。
    Array(Box<RawType>),
    /// FIXED_DICT 字段(名 + 表达式),声明序。
    FixedDict(Vec<(String, RawType)>),
}

/// def 类型 schema:`types.xml` + `alias.xml` → 可解析类型名 → [`WireLayout`]。
/// 自足(结构重解析),不依赖 TypeGraph——graph 的 `field_refs` 丢名折平 <of>。
#[derive(Debug)]
pub struct WireSchema {
    types: BTreeMap<String, RawType>,
}

impl WireSchema {
    /// 从 `types.xml` + `alias.xml` 文本构建(结构重解析,镜像 extract_types)。
    pub fn from_sources(types_xml: &str, alias_xml: &str) -> Self {
        let mut types = BTreeMap::new();
        if !types_xml.is_empty() {
            let doc = parse_xml(types_xml, false);
            if let Some(root) = doc.root() {
                for child in doc.child_elements(root) {
                    let e = doc.element(child);
                    let raw = raw_type_from_element(&doc, child);
                    types.insert(e.name.clone(), raw);
                }
            }
        }
        if !alias_xml.is_empty() {
            let doc = parse_xml(alias_xml, false);
            if let Some(root) = doc.root() {
                for child in doc.child_elements(root) {
                    let e = doc.element(child);
                    let target = alias_target_of(&doc, child);
                    if target.is_empty() {
                        continue;
                    }
                    types.insert(e.name.clone(), RawType::Named(target));
                }
            }
        }
        WireSchema { types }
    }

    /// 按名取布局(递归;环→[`WireError::Cycle`],未注册→[`WireError::UnknownType`])。
    pub fn resolve(&self, name: &str) -> Result<WireLayout, WireError> {
        let mut visiting = BTreeSet::new();
        self.resolve_inner(name, &mut visiting)
    }

    fn resolve_inner(
        &self,
        name: &str,
        visiting: &mut BTreeSet<String>,
    ) -> Result<WireLayout, WireError> {
        if let Some(layout) = builtin_layout(name) {
            return Ok(layout);
        }
        if !visiting.insert(name.to_string()) {
            return Err(WireError::Cycle(name.to_string()));
        }
        let raw = self
            .types
            .get(name)
            .ok_or_else(|| WireError::UnknownType(name.to_string()))?;
        let layout = self.raw_to_layout(raw, visiting)?;
        visiting.remove(name);
        Ok(layout)
    }

    fn raw_to_layout(
        &self,
        raw: &RawType,
        visiting: &mut BTreeSet<String>,
    ) -> Result<WireLayout, WireError> {
        match raw {
            RawType::Builtin(b) => {
                builtin_layout(b).ok_or_else(|| WireError::UnknownType(b.clone()))
            }
            RawType::Named(n) => self.resolve_inner(n, visiting),
            RawType::Array(elem) => Ok(WireLayout::Array(Box::new(
                self.raw_to_layout(elem, visiting)?,
            ))),
            RawType::FixedDict(fields) => {
                let mut ws = Vec::with_capacity(fields.len());
                for (fname, frt) in fields {
                    ws.push(WireField {
                        name: fname.clone(),
                        layout: self.raw_to_layout(frt, visiting)?,
                    });
                }
                Ok(WireLayout::FixedDict(ws))
            }
        }
    }
}

use std::collections::BTreeSet;

/// 内建标量 → 布局(builtin.rs BUILTIN_TYPES 全 21 项;VECTOR 是内建容器标量)。
fn builtin_layout(name: &str) -> Option<WireLayout> {
    Some(match name {
        "UINT8" => WireLayout::U8,
        "UINT16" => WireLayout::U16,
        "UINT32" => WireLayout::U32,
        "UINT64" => WireLayout::U64,
        "INT8" => WireLayout::I8,
        "INT16" => WireLayout::I16,
        "INT32" => WireLayout::I32,
        "INT64" => WireLayout::I64,
        "FLOAT" => WireLayout::F32,
        "DOUBLE" => WireLayout::F64,
        "BOOL" => WireLayout::Bool,
        "STRING" => WireLayout::Str,
        "UNICODE" => WireLayout::Unicode,
        "PYTHON" => WireLayout::Py,
        "PY_DICT" => WireLayout::PyDict,
        "PY_TUPLE" => WireLayout::PyTuple,
        "PY_LIST" => WireLayout::PyList,
        "ENTITYCALL" => WireLayout::EntityCall,
        "BLOB" => WireLayout::Blob,
        "VECTOR2" => WireLayout::Vec2,
        "VECTOR3" => WireLayout::Vec3,
        "VECTOR4" => WireLayout::Vec4,
        _ => return None,
    })
}

/// 从 `<Type>` 元素(或顶层 `<NAME>` 元素)重解析出结构类型表达式。
fn raw_type_from_element(doc: &kode_parser::xml::Document, idx: usize) -> RawType {
    let directive = directive_of(doc, idx);
    match directive.as_str() {
        "FIXED_DICT" => {
            let mut fields = Vec::new();
            if let Some(props) = doc.child_element(idx, "Properties") {
                for prop in doc.child_elements(props) {
                    let p = doc.element(prop);
                    let name = p.name.clone();
                    if let Some(t) = doc.child_element(prop, "Type") {
                        fields.push((name, raw_type_from_element(doc, t)));
                    }
                }
            }
            RawType::FixedDict(fields)
        }
        "ARRAY" => {
            let elem = doc
                .child_element(idx, "of")
                .map(|of| raw_type_from_element(doc, of))
                .unwrap_or(RawType::Builtin("STRING".to_string()));
            RawType::Array(Box::new(elem))
        }
        "" => RawType::Builtin(String::new()),
        other => RawType::Named(other.to_string()),
    }
}

/// 类型表达式指引:元素文本首个 token;空则回落 `type` 属性值(extract_types 同款)。
fn directive_of(doc: &kode_parser::xml::Document, idx: usize) -> String {
    let e = doc.element(idx);
    if let Some(t) = e.first_text_token(doc) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    e.attributes
        .iter()
        .find(|a| a.name == "type")
        .map(|a| a.value.trim().to_string())
        .unwrap_or_default()
}

/// alias.xml 条目的目标名:Type 子元素文本 / 首个非 Type 子元素标签名 / 自身文本。
fn alias_target_of(doc: &kode_parser::xml::Document, idx: usize) -> String {
    let e = doc.element(idx);
    if let Some(t) = doc.child_element(idx, "Type") {
        let text = doc.element(t).text(doc).trim().to_string();
        if let Some(tok) = text.split_whitespace().next() {
            if !tok.is_empty() {
                return tok.to_string();
            }
        }
    }
    if let Some(other) = doc
        .child_elements(idx)
        .into_iter()
        .find(|&c| doc.element(c).name != "Type")
    {
        return doc.element(other).name.clone();
    }
    e.first_text_token(doc).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 属性更新流(client_lib/entity.cpp:259-442;entity_macro.h:69-137)
// ---------------------------------------------------------------------------

/// 实体 id 编码:Full=i32(非别名/视图>255/entityAliasID 关);Alias=u8 视图别名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityRef {
    Full(i32),
    Alias(u8),
}

/// 实体 id 编码格式(与属性 id 模式**正交**;引擎由 `entityAliasID()` +
/// 视图大小决定,clientobjectbase.cpp:399-432)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityRefKind {
    Full,
    Alias,
}

impl EntityRefKind {
    pub fn of(r: &EntityRef) -> Self {
        match r {
            EntityRef::Full(_) => EntityRefKind::Full,
            EntityRef::Alias(_) => EntityRefKind::Alias,
        }
    }
}

/// 属性 id 编码模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PropertyMode {
    /// alias: parent/child 各 u8。
    Alias,
    /// utype: parent/child 各 u16。
    Utype,
}

/// 特殊基础属性 **utype 模式** id(alias 模式恒 1/2/3,本结构被忽略)。
/// 默认值来自 `messages_fixed_defaults.xml:387-402`(Property::position/
/// direction/spaceID → 40000/40001/40002);引擎经
/// `FixedMessages::isFixed("Property::...")` 读取(entity_macro.h:1503-1520)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasePropUtype {
    pub position: u16,
    pub direction: u16,
    pub space_id: u16,
}

impl Default for BasePropUtype {
    fn default() -> Self {
        BasePropUtype {
            position: 40000,
            direction: 40001,
            space_id: 40002,
        }
    }
}

/// 特殊基础属性 id 三元组(alias 模式固定 1/2/3 忽略 base;utype 模式用 base)。
fn special_ids(mode: PropertyMode, base: &BasePropUtype) -> (u16, u16, u16) {
    match mode {
        // ENTITY_BASE_PROPERTY_ALIASID_POSITION_XYZ/DIRECTION/SPACEID(common.h:118-120)。
        PropertyMode::Alias => (1, 2, 3),
        PropertyMode::Utype => (base.position, base.direction, base.space_id),
    }
}

/// 属性更新条目的载荷。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PropKind {
    /// POSITION(x,y,z 3×f32)。
    Position { x: f32, y: f32, z: f32 },
    /// DIRECTION(roll,pitch,yaw 3×f32)。
    Direction { roll: f32, pitch: f32, yaw: f32 },
    /// SPACEID(u32)。
    SpaceId(u32),
    /// 普通属性(布局 + 值)。
    Regular {
        layout: WireLayout,
        value: WireValue,
    },
}

/// 属性更新条目(parent/child id + 载荷)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyEntry {
    pub parent: u16,
    pub child: u16,
    pub kind: PropKind,
}

/// 编码属性更新流:ENTITY_ID + 各条目。条目的 parent/child id 与特殊属性载荷
/// 由调用方给出(special 条目须 parent==0 且 child=对应特殊 id)。
pub fn encode_property_stream(
    entity: EntityRef,
    mode: PropertyMode,
    entries: &[PropertyEntry],
    out: &mut Vec<u8>,
) -> Result<(), WireError> {
    match entity {
        EntityRef::Full(id) => push_le_u32(out, id as u32),
        EntityRef::Alias(alias) => out.push(alias),
    }
    for entry in entries {
        write_prop_ref(out, mode, entry.parent, entry.child)?;
        match &entry.kind {
            PropKind::Position { x, y, z } => {
                out.extend_from_slice(&x.to_le_bytes());
                out.extend_from_slice(&y.to_le_bytes());
                out.extend_from_slice(&z.to_le_bytes());
            }
            PropKind::Direction { roll, pitch, yaw } => {
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&pitch.to_le_bytes());
                out.extend_from_slice(&yaw.to_le_bytes());
            }
            PropKind::SpaceId(v) => push_le_u32(out, *v),
            PropKind::Regular { layout, value } => encode_value(layout, value, out)?,
        }
    }
    Ok(())
}

/// 解码属性更新流:ENTITY_ID + 各条目(parent==0&&child 特殊 → 隐式布局)。
/// 实体 id 格式由 [`EntityRefKind`] 独立给出(与属性 id 模式正交)。
pub fn decode_property_stream<F>(
    data: &[u8],
    entity_kind: EntityRefKind,
    mode: PropertyMode,
    base: &BasePropUtype,
    layout_of_child: F,
) -> Result<(EntityRef, Vec<PropertyEntry>), WireError>
where
    F: Fn(u16, u16) -> Result<WireLayout, WireError>,
{
    let mut cur = WireCursor::new(data);
    let entity = match entity_kind {
        EntityRefKind::Full => EntityRef::Full(cur.read_i32()?),
        EntityRefKind::Alias => EntityRef::Alias(cur.read_u8()?),
    };
    let mut entries = Vec::new();
    let (pos_id, dir_id, space_id) = special_ids(mode, base);
    while cur.remaining() > 0 {
        let (parent, child) = read_prop_ref(&mut cur, mode)?;
        let kind = if parent == 0 {
            match child {
                c if c == pos_id => PropKind::Position {
                    x: cur.read_f32()?,
                    y: cur.read_f32()?,
                    z: cur.read_f32()?,
                },
                c if c == dir_id => PropKind::Direction {
                    roll: cur.read_f32()?,
                    pitch: cur.read_f32()?,
                    yaw: cur.read_f32()?,
                },
                c if c == space_id => PropKind::SpaceId(cur.read_u32()?),
                c => {
                    let layout = layout_of_child(parent, c)?;
                    let value = decode_value(&layout, &mut cur)?;
                    PropKind::Regular { layout, value }
                }
            }
        } else {
            // 组件子属性(parent≠0):子属性 id → 布局由调用方经闭包映射。
            let layout = layout_of_child(parent, child)?;
            let value = decode_value(&layout, &mut cur)?;
            PropKind::Regular { layout, value }
        };
        entries.push(PropertyEntry {
            parent,
            child,
            kind,
        });
    }
    Ok((entity, entries))
}

fn write_prop_ref(
    out: &mut Vec<u8>,
    mode: PropertyMode,
    parent: u16,
    child: u16,
) -> Result<(), WireError> {
    match mode {
        PropertyMode::Alias => {
            if parent > u8::MAX as u16 || child > u8::MAX as u16 {
                return Err(WireError::AliasIdOverflow(parent.max(child)));
            }
            out.push(parent as u8);
            out.push(child as u8);
        }
        PropertyMode::Utype => {
            push_le_u16(out, parent);
            push_le_u16(out, child);
        }
    }
    Ok(())
}

fn read_prop_ref(cur: &mut WireCursor, mode: PropertyMode) -> Result<(u16, u16), WireError> {
    match mode {
        PropertyMode::Alias => Ok((u16::from(cur.read_u8()?), u16::from(cur.read_u8()?))),
        PropertyMode::Utype => Ok((cur.read_u16()?, cur.read_u16()?)),
    }
}

// ---------------------------------------------------------------------------
// 方法调用参数(client_lib/entity.cpp:155-248;entitydef/method.cpp:146-176)
// ---------------------------------------------------------------------------

/// 方法 id 编码:别名=u8;utype=u16。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MethodRef {
    Alias(u8),
    Utype(u16),
}

/// 调用方法体(实体 id 由调用方读,本帧 = [componentAliasID?]+methodID+实参)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MethodCall {
    /// 别名模式:u8 componentPropertyAliasID(>0=组件方法);utype 模式不读(恒 0)。
    pub component_alias: Option<u8>,
    pub method: MethodRef,
    pub args: Vec<WireValue>,
    pub arg_layouts: Vec<WireLayout>,
}

/// 编码方法调用实参帧:别名=u8 componentAliasID+u8 methodAliasID+args;
/// utype=u16 methodUtype+args(component uid 不写)。
pub fn encode_method_args(
    call: &MethodCall,
    mode: PropertyMode,
    out: &mut Vec<u8>,
) -> Result<(), WireError> {
    if call.arg_layouts.len() != call.args.len() {
        return Err(WireError::ArgumentCountMismatch {
            expected: call.arg_layouts.len(),
            actual: call.args.len(),
        });
    }
    if !matches!(
        (mode, call.method),
        (PropertyMode::Alias, MethodRef::Alias(_)) | (PropertyMode::Utype, MethodRef::Utype(_))
    ) {
        return Err(WireError::MethodModeMismatch);
    }
    match mode {
        PropertyMode::Alias => {
            out.push(call.component_alias.unwrap_or(0));
            let alias = match call.method {
                MethodRef::Alias(a) => a,
                MethodRef::Utype(u) => u as u8,
            };
            out.push(alias);
        }
        PropertyMode::Utype => {
            let utype = match call.method {
                MethodRef::Alias(a) => u16::from(a),
                MethodRef::Utype(u) => u,
            };
            push_le_u16(out, utype);
        }
    }
    for (layout, value) in call.arg_layouts.iter().zip(call.args.iter()) {
        encode_value(layout, value, out)?;
    }
    Ok(())
}

/// 解码方法调用实参帧:别名=u8 componentAliasID(0=本实体)+u8 methodAliasID+args;
/// utype=u16 methodUtype+args。args 布局经闭包按 method id 解析。
pub fn decode_method_args<F>(
    data: &[u8],
    mode: PropertyMode,
    arg_layouts_of: F,
) -> Result<MethodCall, WireError>
where
    F: Fn(Option<u8>, MethodRef) -> Result<Vec<WireLayout>, WireError>,
{
    let mut cur = WireCursor::new(data);
    let (component_alias, method) = match mode {
        PropertyMode::Alias => {
            let comp = cur.read_u8()?;
            let comp = if comp > 0 { Some(comp) } else { None };
            let alias = cur.read_u8()?;
            (comp, MethodRef::Alias(alias))
        }
        PropertyMode::Utype => {
            let utype = cur.read_u16()?;
            (None, MethodRef::Utype(utype))
        }
    };
    let arg_layouts = arg_layouts_of(component_alias, method)?;
    let mut args = Vec::with_capacity(arg_layouts.len());
    for layout in &arg_layouts {
        args.push(decode_value(layout, &mut cur)?);
    }
    Ok(MethodCall {
        component_alias,
        method,
        args,
        arg_layouts,
    })
}

// ---------------------------------------------------------------------------
// 消息帧(network/bundle.cpp:273-395;common.h:88-92)
// ---------------------------------------------------------------------------

/// 消息帧:msgid + 变长长度(载荷不含 4 头字节;≥65535→长度=65535+u32 扩展)。
pub fn encode_message_frame(
    msg_id: u16,
    body: &[u8],
    variable_length: bool,
    out: &mut Vec<u8>,
) -> Result<(), WireError> {
    push_le_u16(out, msg_id);
    if !variable_length {
        out.extend_from_slice(body);
        return Ok(());
    }
    let payload = body.len();
    if payload > u32::MAX as usize {
        return Err(WireError::MessageTooLarge { size: payload });
    }
    if payload >= 65535 {
        // 长度字段=65535 + 后插 u32 扩展长(bundle.cpp:358-371)。
        push_le_u16(out, 65535);
        push_le_u32(out, payload as u32);
    } else {
        push_le_u16(out, payload as u16);
    }
    out.extend_from_slice(body);
    Ok(())
}

/// 解码消息帧:定长=读固定 body;变长=读 u16 长度(==65535 则再读 u32 扩展)。
pub fn decode_message_frame(
    cur: &mut WireCursor,
    variable_length: bool,
    fixed_len: Option<usize>,
) -> Result<(u16, Vec<u8>), WireError> {
    let msg_id = cur.read_u16()?;
    if !variable_length {
        let len = fixed_len.unwrap_or(0);
        let body = cur.take(len)?.to_vec();
        return Ok((msg_id, body));
    }
    let mut len = cur.read_u16()? as usize;
    if len == 65535 {
        len = cur.read_u32()? as usize;
    }
    let body = cur.take(len)?.to_vec();
    Ok((msg_id, body))
}

// ---------------------------------------------------------------------------
// hex 辅助(golden/RPC 边界用)
// ---------------------------------------------------------------------------

/// 小写 hex(无分隔)。
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 解析小写/大写 hex。
pub fn from_hex(s: &str) -> Result<Vec<u8>, WireError> {
    if !s.len().is_multiple_of(2) {
        return Err(WireError::InvalidHex(s.to_string()));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_val(bytes[i]).ok_or_else(|| WireError::InvalidHex(s.to_string()))?;
        let lo = hex_val(bytes[i + 1]).ok_or_else(|| WireError::InvalidHex(s.to_string()))?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 黄金样本(规范推导 + provenance;dump 内置往返自校验)
// ---------------------------------------------------------------------------

/// 提交侧 golden 相对仓库根路径(与 flag-domains 同约定)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/wire-parity.json";

/// schema 解析夹具(镜像 `tests/fixtures/kbengine-demo-assets/scripts/
/// entity_defs/types.xml` 的声明;内联而非读盘,保证 golden 再生成不依赖 cwd):
/// ITEM_ID→UINT16 别名链、SKILL_SLOT(FD:slot_list ARRAY<UINT32>+count)、
/// POSITION(x,y,z FLOAT)、ITEM_IDS ARRAY<ITEM_ID>。
pub const SCHEMA_FIXTURE_XML: &str = r#"<root>
	<ITEM_ID> UINT16 </ITEM_ID>
	<ITEM_DESC> STRING </ITEM_DESC>
	<SKILL_SLOT>
		FIXED_DICT
		<Properties>
			<slot_list>
				<Type>
					ARRAY
					<of> UINT32 </of>
				</Type>
			</slot_list>
			<count>
				<Type> UINT32 </Type>
			</count>
		</Properties>
	</SKILL_SLOT>
	<POSITION>
		FIXED_DICT
		<Properties>
			<x>
				<Type> FLOAT </Type>
			</x>
			<y>
				<Type> FLOAT </Type>
			</y>
			<z>
				<Type> FLOAT </Type>
			</z>
		</Properties>
	</POSITION>
	<ITEM_IDS>
		ARRAY
		<of> ITEM_ID </of>
	</ITEM_IDS>
</root>"#;

/// 黄金样本(规范推导,kbengine 源引在 provenance)。每样本先编码成 hex,
/// 再解码回放并断言与输入一致(往返自校验,镜像 flag_domains CANONICAL 断言)。
pub fn dump_wire_golden() -> String {
    let mut samples: Vec<serde_json::Value> = Vec::new();

    // -- 标量/内建往返(边界值;每条独立 provenance)--
    let scalar_cases: &[(&str, &str, WireLayout, WireValue)] = &[
        (
            "u8_min_max",
            "memorystream.h:259-263 uint8 LE 1B(datatype.cpp:199)",
            WireLayout::U8,
            WireValue::U8(255),
        ),
        (
            "u16_max",
            "memorystream.h:265-269 uint16 LE 2B",
            WireLayout::U16,
            WireValue::U16(65535),
        ),
        (
            "u32_max",
            "memorystream.h:271-275 uint32 LE 4B",
            WireLayout::U32,
            WireValue::U32(4294967295),
        ),
        (
            "u64_max",
            "memorystream.h:277-281 uint64 LE 8B",
            WireLayout::U64,
            WireValue::U64(18446744073709551615),
        ),
        (
            "i8_min",
            "memorystream.h:283-287 int8 LE 1B",
            WireLayout::I8,
            WireValue::I8(-128),
        ),
        (
            "i16_min",
            "memorystream.h:289-293 int16 LE 2B",
            WireLayout::I16,
            WireValue::I16(-32768),
        ),
        (
            "i32_min",
            "memorystream.h:295-299 int32 LE 4B(ENTITY_ID 同宽 platform.h:342)",
            WireLayout::I32,
            WireValue::I32(-2147483648),
        ),
        (
            "i64_min",
            "memorystream.h:301-305 int64 LE 8B",
            WireLayout::I64,
            WireValue::I64(-9223372036854775808),
        ),
        (
            "f32_negative_sub",
            "memorystream.h:307-311 float IEEE754 LE(datatype.cpp:540)",
            WireLayout::F32,
            WireValue::F32(-0.25),
        ),
        (
            "f64_pi",
            "memorystream.h:313-317 double IEEE754 LE(datatype.cpp:630)",
            WireLayout::F64,
            WireValue::F64(std::f64::consts::PI),
        ),
        (
            "bool_true_false",
            "memorystream.h:247-251 bool=1B int8 非零→true",
            WireLayout::Bool,
            WireValue::Bool(true),
        ),
        (
            "string_ascii",
            "memorystream.h:224-229 编码=字节+0x00;无长度前缀",
            WireLayout::Str,
            WireValue::Str("hello".to_string()),
        ),
        (
            "string_empty",
            "memorystream.h:224-229 空串=单字节 0x00",
            WireLayout::Str,
            WireValue::Str(String::new()),
        ),
        (
            "unicode_utf8",
            "datatype.cpp:1129-1142 UNICODE=u32 长度+UTF-8 字节(appendBlob)",
            WireLayout::Unicode,
            WireValue::Unicode("你好".as_bytes().to_vec()),
        ),
        (
            "blob_short",
            "memorystream.h:551-556 appendBlob=u32 长度+字节",
            WireLayout::Blob,
            WireValue::Blob(vec![0xde, 0xad, 0xbe, 0xef]),
        ),
        (
            "python_pickle_frame",
            "datatype.cpp:1225-1229 PYTHON=pickle 字节走 appendBlob;字节不透明透传",
            WireLayout::Py,
            WireValue::Py(vec![0x80, 0x04, 0x95, 0x02, 0x00, 0x00, 0x00, 0x4b, 0x2e]),
        ),
        (
            "py_dict_pickle_frame",
            "datatype.cpp:1288-1296 PyDict=同 pickle 框架",
            WireLayout::PyDict,
            WireValue::PyDict(vec![
                0x80, 0x04, 0x95, 0x04, 0x00, 0x00, 0x00, 0x7d, 0x94, 0x2e,
            ]),
        ),
        (
            "py_tuple_pickle_frame",
            "datatype.cpp:1344-1352 PyTuple=同 pickle 框架",
            WireLayout::PyTuple,
            WireValue::PyTuple(vec![
                0x80, 0x04, 0x95, 0x04, 0x00, 0x00, 0x00, 0x29, 0x94, 0x2e,
            ]),
        ),
        (
            "py_list_pickle_frame",
            "datatype.cpp:1400-1408 PyList=同 pickle 框架",
            WireLayout::PyList,
            WireValue::PyList(vec![
                0x80, 0x04, 0x95, 0x04, 0x00, 0x00, 0x00, 0x5d, 0x94, 0x2e,
            ]),
        ),
        (
            "entitycall_full",
            "datatype.cpp:1512-1573 id(i32)+cid(u64 platform.h:345)+type(u16)+utype(u16)=16B 定长",
            WireLayout::EntityCall,
            WireValue::EntityCall(EntityCallValue {
                id: 1001,
                component_id: 0x0000_0000_0000_0020,
                call_type: 1,
                script_uid: 5,
            }),
        ),
        (
            "entitycall_null",
            "datatype.cpp:1540-1552 pyValue==None → 全零字段仍 16B",
            WireLayout::EntityCall,
            WireValue::EntityCall(EntityCallValue::default()),
        ),
        (
            "vector2",
            "datatype.cpp:737 VECTOR2=2×float 连续 LE 无前缀",
            WireLayout::Vec2,
            WireValue::Vec2([1.5, -2.25]),
        ),
        (
            "vector3",
            "datatype.cpp:841 VECTOR3=3×float LE",
            WireLayout::Vec3,
            WireValue::Vec3([1.0, 2.0, 3.0]),
        ),
        (
            "vector4",
            "datatype.cpp:946 VECTOR4=4×float LE",
            WireLayout::Vec4,
            WireValue::Vec4([0.5, 0.25, 0.125, 0.0625]),
        ),
    ];
    for (name, provenance, layout, value) in scalar_cases {
        let mut out = Vec::new();
        encode_value(layout, value, &mut out).expect("golden scalar encode");
        let mut cur = WireCursor::new(&out);
        let back = decode_value(layout, &mut cur).expect("golden scalar decode round-trip");
        assert_eq!(&back, value, "golden sample {name} round-trip mismatch");
        samples.push(serde_json::json!({
            "name": name,
            "provenance": provenance,
            "kind": "value",
            "layout": layout,
            "value": value,
            "hex": to_hex(&out),
        }));
    }

    // -- 容器(schema 解析的 SKILL_SLOT/POSITION/ITEM_IDS 布局逐字节)--
    let schema = WireSchema::from_sources(SCHEMA_FIXTURE_XML, "");
    let skill_slot_layout = schema.resolve("SKILL_SLOT").expect("resolve SKILL_SLOT");
    let skill_slot_value = WireValue::FixedDict(vec![
        WireValue::Array(vec![WireValue::U32(10), WireValue::U32(20)]),
        WireValue::U32(2),
    ]);
    let mut out = Vec::new();
    encode_value(&skill_slot_layout, &skill_slot_value, &mut out)
        .expect("golden SKILL_SLOT encode");
    let mut cur = WireCursor::new(&out);
    let back = decode_value(&skill_slot_layout, &mut cur).expect("golden SKILL_SLOT decode");
    assert_eq!(back, skill_slot_value, "SKILL_SLOT round-trip mismatch");
    samples.push(serde_json::json!({
        "name": "fixed_dict_skill_slot",
        "provenance": "datatype.cpp:2592-2660 FixedDict=声明序逐键(无键名/无计数);键序=vector push 序 datatype.h:691;夹具=tests/fixtures/kbengine-demo-assets/scripts/entity_defs/types.xml SKILL_SLOT",
        "kind": "value",
        "layout": skill_slot_layout,
        "value": skill_slot_value,
        "hex": to_hex(&out),
    }));

    let item_ids_layout = schema.resolve("ITEM_IDS").expect("resolve ITEM_IDS");
    let item_ids_value = WireValue::Array(vec![WireValue::U16(7), WireValue::U16(9)]);
    let mut out = Vec::new();
    encode_value(&item_ids_layout, &item_ids_value, &mut out).expect("golden ITEM_IDS encode");
    let mut cur = WireCursor::new(&out);
    let back = decode_value(&item_ids_layout, &mut cur).expect("golden ITEM_IDS decode");
    assert_eq!(back, item_ids_value, "ITEM_IDS round-trip mismatch");
    samples.push(serde_json::json!({
        "name": "array_of_alias_item_ids",
        "provenance": "datatype.cpp:1837-1846 ARRAY=u32 元素数+各元素按 <of>;元素走别名 ITEM_ID→UINT16;夹具=tests/fixtures/kbengine-demo-assets/scripts/entity_defs/types.xml ITEM_IDS",
        "kind": "value",
        "layout": item_ids_layout,
        "value": item_ids_value,
        "hex": to_hex(&out),
    }));

    // -- 属性更新流(Account.def 字母序快照;别名/utype 两模式 + special base)--
    let account_entries_alias: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 4, // 别名 id:accountName(字母序属性别名从 4 起)
            kind: PropKind::Regular {
                layout: WireLayout::Str,
                value: WireValue::Str("player1".to_string()),
            },
        },
        PropertyEntry {
            parent: 0,
            child: 5, // 别名 id:lastLoginTime
            kind: PropKind::Regular {
                layout: WireLayout::U32,
                value: WireValue::U32(1735689600),
            },
        },
    ];
    let (out, entity, mode, base) = {
        let mut out = Vec::new();
        encode_property_stream(
            EntityRef::Full(100),
            PropertyMode::Alias,
            &account_entries_alias,
            &mut out,
        )
        .expect("golden prop stream alias encode");
        (
            out,
            EntityRef::Full(100),
            PropertyMode::Alias,
            BasePropUtype::default(),
        )
    };
    {
        let layouts: BTreeMap<u16, WireLayout> = account_entries_alias
            .iter()
            .filter_map(|e| match &e.kind {
                PropKind::Regular { layout, .. } => Some((e.child, layout.clone())),
                _ => None,
            })
            .collect();
        let (back_entity, back_entries) =
            decode_property_stream(&out, EntityRefKind::Full, mode, &base, |_parent, child| {
                layouts
                    .get(&child)
                    .cloned()
                    .ok_or_else(|| WireError::UnknownType(format!("child {child}")))
            })
            .expect("golden prop stream alias decode");
        assert_eq!(back_entity, entity, "prop stream entity round-trip");
        assert_eq!(
            back_entries, account_entries_alias,
            "prop stream alias entries"
        );
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_account_alias",
        "provenance": "clientobjectbase.cpp:1113-1119 ENTITY_ID=int32;client_lib/entity.cpp:271-276 别名=parent u8+child u8;全量快照按属性名字母序(getClientPropertyDescriptions 是 std::map);Account.def 夹具 accountName/lastLoginTime BASE_AND_CLIENT",
        "kind": "property_stream",
        "input": {
            "entity": entity,
            "mode": mode,
            "base": base,
            "entries": account_entries_alias,
        },
        "hex": to_hex(&out),
    }));

    let account_entries_utype: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 1, // utype:def 解析序 accountName=1
            kind: PropKind::Regular {
                layout: WireLayout::Str,
                value: WireValue::Str("player1".to_string()),
            },
        },
        PropertyEntry {
            parent: 0,
            child: 2, // utype:lastLoginTime=2
            kind: PropKind::Regular {
                layout: WireLayout::U32,
                value: WireValue::U32(1735689600),
            },
        },
    ];
    let mut out = Vec::new();
    encode_property_stream(
        EntityRef::Full(100),
        PropertyMode::Utype,
        &account_entries_utype,
        &mut out,
    )
    .expect("golden prop stream utype encode");
    {
        let layouts: BTreeMap<u16, WireLayout> = account_entries_utype
            .iter()
            .filter_map(|e| match &e.kind {
                PropKind::Regular { layout, .. } => Some((e.child, layout.clone())),
                _ => None,
            })
            .collect();
        let (back_entity, back_entries) = decode_property_stream(
            &out,
            EntityRefKind::Full,
            PropertyMode::Utype,
            &BasePropUtype::default(),
            |_parent, child| {
                layouts
                    .get(&child)
                    .cloned()
                    .ok_or_else(|| WireError::UnknownType(format!("child {child}")))
            },
        )
        .expect("golden prop stream utype decode");
        assert_eq!(back_entity, EntityRef::Full(100));
        assert_eq!(
            back_entries, account_entries_utype,
            "prop stream utype entries"
        );
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_account_utype",
        "provenance": "client_lib/entity.cpp:277-280 非=alias:parent u16+child u16(ENTITY_PROPERTY_UID uint16 common.h:80);属性 utype def 解析序从 1(entitydef.cpp:1020-1094)",
        "kind": "property_stream",
        "input": {
            "entity": EntityRef::Full(100),
            "mode": PropertyMode::Utype,
            "base": BasePropUtype::default(),
            "entries": account_entries_utype,
        },
        "hex": to_hex(&out),
    }));

    // special base props:position/direction/spaceID(alias 模式恒 1/2/3)+
    // 普通属性混排(普通条目跟在 special 后,child 4 起)。
    let special_entries: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 1,
            kind: PropKind::Position {
                x: 1.5,
                y: 2.5,
                z: 3.5,
            },
        },
        PropertyEntry {
            parent: 0,
            child: 2,
            kind: PropKind::Direction {
                roll: 0.0,
                pitch: std::f32::consts::FRAC_PI_2,
                yaw: std::f32::consts::PI,
            },
        },
        PropertyEntry {
            parent: 0,
            child: 3,
            kind: PropKind::SpaceId(42),
        },
    ];
    let mut out = Vec::new();
    encode_property_stream(
        EntityRef::Alias(7),
        PropertyMode::Alias,
        &special_entries,
        &mut out,
    )
    .expect("golden prop stream special encode");
    {
        let (back_entity, back_entries) = decode_property_stream(
            &out,
            EntityRefKind::Alias,
            PropertyMode::Alias,
            &BasePropUtype::default(),
            |_parent, child| Err(WireError::UnknownType(format!("child {child}"))),
        )
        .expect("golden prop stream special decode");
        assert_eq!(
            back_entity,
            EntityRef::Alias(7),
            "alias entity id round-trip"
        );
        assert_eq!(back_entries, special_entries, "special base prop entries");
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_special_base_alias",
        "provenance": "entity_macro.h:125-129 ADD_POS_DIR_TO_STREAM_ALIASID=u8 0+aliasID+3×f32(pos→1 dir→2,common.h:118-120);spaceID u32(entity.cpp:343-348);*Optimized 实体 id=u8 视图别名 clientobjectbase.cpp:1121-1126/399-432",
        "kind": "property_stream",
        "input": {
            "entity": EntityRef::Alias(7),
            "mode": PropertyMode::Alias,
            "base": BasePropUtype::default(),
            "entries": special_entries,
        },
        "hex": to_hex(&out),
    }));

    // utype 模式 special(fixed_messages 默认 40000/40001/40002)+ 组件属性(parent≠0)。
    let special_utype_entries: Vec<PropertyEntry> = vec![
        PropertyEntry {
            parent: 0,
            child: 40000, // Property::position fixed msgid(messages_fixed_defaults.xml:388)
            kind: PropKind::Position {
                x: -1.0,
                y: 0.0,
                z: 8.25,
            },
        },
        PropertyEntry {
            parent: 6, // 组件属性 utype(此处示意 6)
            child: 1,  // 组件内子属性 utype
            kind: PropKind::Regular {
                layout: WireLayout::U16,
                value: WireValue::U16(910),
            },
        },
    ];
    let mut out = Vec::new();
    encode_property_stream(
        EntityRef::Full(200),
        PropertyMode::Utype,
        &special_utype_entries,
        &mut out,
    )
    .expect("golden prop stream special utype encode");
    {
        let (back_entity, back_entries) = decode_property_stream(
            &out,
            EntityRefKind::Full,
            PropertyMode::Utype,
            &BasePropUtype::default(),
            |_parent, child| {
                if child == 1 {
                    Ok(WireLayout::U16)
                } else {
                    Err(WireError::UnknownType(format!("child {child}")))
                }
            },
        )
        .expect("golden prop stream special utype decode");
        assert_eq!(back_entity, EntityRef::Full(200));
        assert_eq!(back_entries, special_utype_entries, "special utype entries");
    }
    samples.push(serde_json::json!({
        "name": "prop_stream_special_and_component_utype",
        "provenance": "entity_macro.h:120-122 ADD_POS_DIR_TO_STREAM=u16 0+utype+3×f32;组件条目 parent≠0(entity.cpp:370-390);utype 模式特殊 id=FixedMessages::isFixed(\"Property::position/direction/spaceID\") 默认 40000/40001/40002(messages_fixed_defaults.xml:387-402)",
        "kind": "property_stream",
        "input": {
            "entity": EntityRef::Full(200),
            "mode": PropertyMode::Utype,
            "base": BasePropUtype::default(),
            "entries": special_utype_entries,
        },
        "hex": to_hex(&out),
    }));

    // -- 方法调用参数(Account.def reqCreateAvatar Exposed Arg STRING)--
    let call_alias = MethodCall {
        component_alias: None,
        method: MethodRef::Alias(1), // ClientMethods 别名从 1 起
        args: vec![WireValue::Str("warrior".to_string())],
        arg_layouts: vec![WireLayout::Str],
    };
    let mut out = Vec::new();
    encode_method_args(&call_alias, PropertyMode::Alias, &mut out)
        .expect("golden method alias encode");
    {
        let back = decode_method_args(&out, PropertyMode::Alias, |_component, m| match m {
            MethodRef::Alias(1) => Ok(vec![WireLayout::Str]),
            other => Err(WireError::UnknownType(format!("method {other:?}"))),
        })
        .expect("golden method alias decode");
        assert_eq!(back, call_alias, "method alias round-trip");
    }
    samples.push(serde_json::json!({
        "name": "method_args_req_create_avatar_alias",
        "provenance": "client_lib/entity.cpp:169-182 别名=u8 componentPropertyAliasID(0=本实体)+u8 aliasID;实参无计数前缀 method.cpp:146-176;Account.def reqCreateAvatar Exposed Arg STRING",
        "kind": "method_call",
        "input": { "mode": PropertyMode::Alias, "call": call_alias },
        "hex": to_hex(&out),
    }));

    let call_utype = MethodCall {
        component_alias: None,
        method: MethodRef::Utype(1),
        args: vec![WireValue::Str("archer".to_string())],
        arg_layouts: vec![WireLayout::Str],
    };
    let mut out = Vec::new();
    encode_method_args(&call_utype, PropertyMode::Utype, &mut out)
        .expect("golden method utype encode");
    {
        let back = decode_method_args(&out, PropertyMode::Utype, |_component, m| match m {
            MethodRef::Utype(1) => Ok(vec![WireLayout::Str]),
            other => Err(WireError::UnknownType(format!("method {other:?}"))),
        })
        .expect("golden method utype decode");
        assert_eq!(back, call_utype, "method utype round-trip");
    }
    samples.push(serde_json::json!({
        "name": "method_args_req_create_avatar_utype",
        "provenance": "client_lib/entity.cpp:184-190 非=alias:u16 utype(component uid 恒 0 不读流,entity.cpp:170-181);方法 utype=uint16",
        "kind": "method_call",
        "input": { "mode": PropertyMode::Utype, "call": call_utype },
        "hex": to_hex(&out),
    }));

    // -- 消息帧(变长;<65535;定长)--
    let frame_bodies: &[(&str, &str, u16, Vec<u8>, bool)] = &[
        (
            "frame_variable_short",
            "bundle.cpp:273-395 msgid u16+变长 u16 长度(=载荷不含 4 头字节)",
            9,
            vec![0x01, 0x02, 0x03],
            true,
        ),
        (
            "frame_variable_empty",
            "bundle.cpp:346-347 回填长度=currMsgLength_-ID_SIZE-LENGTH_SIZE",
            1000,
            Vec::new(),
            true,
        ),
        (
            "frame_fixed",
            "bundle.cpp:304-309 定长消息无长度字段",
            5,
            vec![0xAA, 0xBB],
            false,
        ),
    ];
    for (name, provenance, msg_id, body, variable) in frame_bodies {
        let mut out = Vec::new();
        encode_message_frame(*msg_id, body, *variable, &mut out).expect("golden frame encode");
        let mut cur = WireCursor::new(&out);
        let (back_id, back_body) = decode_message_frame(&mut cur, *variable, Some(body.len()))
            .expect("golden frame decode");
        assert_eq!(back_id, *msg_id, "frame id round-trip {name}");
        assert_eq!(&back_body, body, "frame body round-trip {name}");
        samples.push(serde_json::json!({
            "name": name,
            "provenance": provenance,
            "kind": "message_frame",
            "input": {
                "msg_id": msg_id,
                "variable_length": variable,
                "body_hex": to_hex(body),
            },
            "hex": to_hex(&out),
        }));
    }
    // 注:≥65535 扩展长帧(bundle.cpp:358-371,u16=65535+u32 扩展)体量 64KiB+,
    // 不入 golden(保持单行 JSON 紧凑),由 wire_codec_units.rs 单测覆盖。

    let value = serde_json::json!({
        "generator": "kode-server dump-wire-golden",
        "samples": samples,
    });
    serde_json::to_string(&value).expect("serialize wire golden")
}

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/wire/encode", encode_handler);
    reg.register("$/kode/wire/decode", decode_handler);
}

fn encode_handler(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let layout: WireLayout =
        serde_json::from_value(params.get("layout").cloned().unwrap_or_default())
            .map_err(|e| e.to_string())?;
    let value: WireValue = serde_json::from_value(params.get("value").cloned().unwrap_or_default())
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    encode_value(&layout, &value, &mut out).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "hex": to_hex(&out) }))
}

fn decode_handler(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let layout: WireLayout =
        serde_json::from_value(params.get("layout").cloned().unwrap_or_default())
            .map_err(|e| e.to_string())?;
    let hex = params
        .get("hex")
        .and_then(|v| v.as_str())
        .ok_or("missing hex")?;
    let bytes = from_hex(hex).map_err(|e| e.to_string())?;
    let mut cur = WireCursor::new(&bytes);
    let value = decode_value(&layout, &mut cur).map_err(|e| e.to_string())?;
    serde_json::to_value(&value).map_err(|e| e.to_string())
}
