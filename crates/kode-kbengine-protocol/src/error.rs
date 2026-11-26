//! Offset-locating diagnostics (PA-003 "diagnostics offset locating"): every decode
//! error carries an absolute byte offset + field path; failures never panic (red line).

use std::fmt;

/// Error category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeErrorKind {
    /// Input ended while more bytes were needed (a frame fragment waiting for the
    /// next packet also falls here).
    UnexpectedEof,
    /// Illegal length field (declared out of bounds / exceeding the memory cap).
    MemoryLimit,
    /// Message ID not present in any installed table segment.
    UnknownMessageId,
    /// Recursion depth exceeded (red line: recursive types bounded).
    DepthLimit,
    /// Illegal string/scalar semantics (missing NUL, broken UTF-8 and the like do
    /// not raise this when handled with engine tolerance; only reported when
    /// decoding cannot continue).
    InvalidString,
}

/// Decode error (with absolute offset + path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    pub kind: DecodeErrorKind,
    /// Absolute byte offset within the stream (diagnostic locating semantics).
    pub offset: usize,
    /// Field path (`Loginapp::login.account` style).
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
