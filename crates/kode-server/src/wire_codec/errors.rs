// ---------------------------------------------------------------------------
// 错误(手动 Display + std::error::Error;不引入 thiserror 依赖)
// ---------------------------------------------------------------------------

use std::fmt;

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
