//! 偏移定位诊断(PA-003「diagnostics 偏移定位」):每个解码错误带绝对字节
//! 偏移 + 字段路径,失败绝不 panic(红线)。

use std::fmt;

/// 错误类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeErrorKind {
    /// 输入在需要更多字节时结束(帧片段等待下个包也归此)。
    UnexpectedEof,
    /// 长度字段非法(声明越界/超出内存上限)。
    MemoryLimit,
    /// 消息 ID 不在任何已装表的段。
    UnknownMessageId,
    /// 递归深度超限(红线:递归类型有界)。
    DepthLimit,
    /// 字符串/标量语义非法(NUL 缺失、UTF-8 坏等按引擎容错处理时不产生此错;
    /// 只有无法继续才报)。
    InvalidString,
}

/// 解码错误(带绝对偏移 + 路径)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    pub kind: DecodeErrorKind,
    /// 流内绝对字节偏移(诊断定位口径)。
    pub offset: usize,
    /// 字段路径(`Loginapp::login.account` 风格)。
    pub path: String,
    pub message: String,
}

impl DecodeError {
    pub fn new(
        kind: DecodeErrorKind,
        offset: usize,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        DecodeError {
            kind,
            offset,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:?} at byte {} [{}]: {}",
            self.kind, self.offset, self.path, self.message
        )
    }
}
impl std::error::Error for DecodeError {}
