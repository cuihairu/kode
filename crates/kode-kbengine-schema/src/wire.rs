//! 线类型布局 IR(todo PA-002「Wire Type Layout」;独立于 kode-types 类型图)。
//!
//! 类型图描述的是脚本侧语义(引用/继承/别名链);本模块描述的是**网络序列化
//! 规则**——每个类型在字节流上的形状。规则取证自 PA-001(docs/kbengine-wire-protocol.md
//! §3/§3.1,引擎基准 bf1a9cd6 / v2.5.10):
//! - 小端、定宽标量(memorystream.h:139-143,253-317);
//! - STRING = NUL 结尾无前缀(datatype.cpp:1050-1062);
//! - UNICODE/BLOB/PYTHON = u32 长度前缀(datatype.cpp:1129-1143,1448-1463,1225-1242);
//! - ARRAY = u32 元素数 + 逐元素递归(datatype.cpp:1837-1856);
//! - FIXED_DICT = 声明序逐字段、不带键名(datatype.cpp:2592+);
//! - VECTOR2/3/4 = 2/3/4 × f32 连续(datatype.cpp:841-858,946-963)。
//!
//! 未知/不可解析类型落 [`WireType::Unresolved`]:解码端按 Raw 字节保留,绝不猜测。

use serde::{Deserialize, Serialize};

/// FIXED_DICT 字段(声明序;键名仅存 IR,线上不写键名)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DictField {
    pub name: String,
    pub ty: Box<WireType>,
}

/// 递归深度上限(别名链/FIXED_DICT/ARRAY 互嵌的安全阀;超界落 Unresolved,
/// 与「递归类型有界」红线同规)。
pub const MAX_TYPE_DEPTH: usize = 64;

/// 线类型(网络序列化形状;与脚本侧类型图无关)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WireType {
    UInt8,
    UInt16,
    UInt32,
    UInt64,
    Int8,
    Int16,
    Int32,
    Int64,
    Float,
    Double,
    /// bool 按 int8 存取(memorystream.h:224-227)。
    Bool,
    /// std::string:NUL 结尾 UTF-8,无长度前缀;读端遇非 ASCII 字节(≥0x80)
    /// 提前截断(memorystream.h:319-332)。
    String,
    /// EntityDef UNICODE:u32 字节长 + UTF-8,无 NUL(datatype.cpp:1129-1143)。
    Unicode,
    /// u32 字节长 + 原始字节(datatype.cpp:1448-1463)。
    Blob,
    /// u32 长度 + CPython pickle 直通(datatype.cpp:1225-1242)。
    Python,
    Vector2,
    Vector3,
    Vector4,
    /// ENTITYCALL 作属性值的完整线格式未逐字节取证(PA-001 TODO-2);
    /// 解码端按不透明 Raw 保留,不编造字段序。
    EntityCall,
    Array {
        of: Box<WireType>,
    },
    FixedDict {
        /// implementedBy 的「模块.符号」原文(序列化不影响线格式,保留备查)。
        module: Option<String>,
        fields: Vec<DictField>,
    },
    /// 无法解析(未知内建名/别名环/缺引用):解码端 Raw 保留 + 诊断。
    Unresolved(String),
}

impl WireType {
    /// 定长字节数;`None` = 变长(含 Unresolved)。自引用结构按深度上限
    /// 保守判变长,绝不无限递归。
    pub fn fixed_size(&self) -> Option<u64> {
        self.fixed_size_within(0)
    }

    fn fixed_size_within(&self, depth: usize) -> Option<u64> {
        if depth > MAX_TYPE_DEPTH {
            return None;
        }
        let d = depth + 1;
        Some(match self {
            WireType::UInt8 | WireType::Int8 | WireType::Bool => 1,
            WireType::UInt16 | WireType::Int16 => 2,
            WireType::UInt32 | WireType::Int32 | WireType::Float => 4,
            WireType::UInt64 | WireType::Int64 | WireType::Double => 8,
            WireType::Vector2 => 8,
            WireType::Vector3 => 12,
            WireType::Vector4 => 16,
            WireType::Array { of } => {
                // u32 元素数前缀本身可变;元素定长也不定长(数量在线上)。
                let _ = of.fixed_size_within(d)?;
                return None;
            }
            WireType::FixedDict { fields, .. } => {
                let mut total = 0u64;
                for f in fields {
                    total += f.ty.fixed_size_within(d)?;
                }
                total
            }
            // STRING/UNICODE/BLOB/PYTHON/EntityCall/Unresolved 全部变长或不透明。
            _ => return None,
        })
    }

    pub fn is_variable(&self) -> bool {
        self.fixed_size().is_none()
    }

    /// 类型显示名(诊断/JSON 用)。
    pub fn display_name(&self) -> String {
        match self {
            WireType::Array { of } => format!("ARRAY<{}>", of.display_name()),
            WireType::FixedDict { fields, .. } => {
                let inner: Vec<String> = fields
                    .iter()
                    .map(|f| format!("{}: {}", f.name, f.ty.display_name()))
                    .collect();
                format!("FIXED_DICT<{}>", inner.join(", "))
            }
            WireType::Unresolved(name) => format!("UNRESOLVED<{name}>"),
            other => format!("{other:?}").to_uppercase(),
        }
    }
}

/// 内建类型名 → 线类型(引擎 `datatype2id` 的原生类别映射口径,
/// kbe/src/lib/server/common.cpp:20-70;取其原生宽度与编码规则)。
pub fn builtin_wire_type(name: &str) -> Option<WireType> {
    let upper = name.trim().to_ascii_uppercase();
    Some(match upper.as_str() {
        "STRING" | "STD::STRING" => WireType::String,
        // 协议参数专用:可变字节块(§5.2 argsize/argoutsize 语义;JS SDK 读作 buffer)
        "UINT8_ARRAY" => WireType::Blob,
        "UNICODE" => WireType::Unicode,
        "BLOB" => WireType::Blob,
        "PYTHON" | "PY_DICT" | "PY_TUPLE" | "PY_LIST" => WireType::Python,
        "BOOL" => WireType::Bool,
        "UINT8" | "CHAR" | "DATATYPE" | "DETAIL_TYPE" | "ENTITYCALL_CALL_TYPE" => WireType::UInt8,
        "UINT16"
        | "UNSIGNED SHORT"
        | "SERVER_ERROR_CODE"
        | "ENTITY_TYPE"
        | "ENTITY_PROPERTY_UID"
        | "ENTITY_METHOD_UID"
        | "ENTITY_SCRIPT_UID"
        | "DATATYPE_UID" => WireType::UInt16,
        "UINT32" | "UINT" | "UNSIGNED INT" | "ARRAYSIZE" | "SPACE_ID" | "GAME_TIME"
        | "TIMER_ID" => WireType::UInt32,
        "UINT64" | "DBID" | "COMPONENT_ID" => WireType::UInt64,
        "INT8" | "COMPONENT_ORDER" => WireType::Int8,
        "INT16" | "SHORT" => WireType::Int16,
        "INT32" | "INT" | "ENTITY_ID" | "CALLBACK_ID" | "COMPONENT_TYPE" => WireType::Int32,
        "INT64" => WireType::Int64,
        "FLOAT" => WireType::Float,
        "DOUBLE" => WireType::Double,
        "VECTOR2" => WireType::Vector2,
        "VECTOR3" => WireType::Vector3,
        "VECTOR4" => WireType::Vector4,
        "ENTITYCALL" => WireType::EntityCall,
        _ => return None,
    })
}

/// 是否内建可解析类型(builtin_wire_type 有映射即真)。
pub fn is_resolvable_builtin(name: &str) -> bool {
    builtin_wire_type(name).is_some()
}
