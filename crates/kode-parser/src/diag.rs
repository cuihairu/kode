//! Structured diagnostics and byte spans (SYNTAX-002/003).
//!
//! All parse failures produce a [`Diagnostic`]; never panic, never abort the whole tree by throwing;
//! spans are always 0-based byte offsets, valid against the original input (including the
//! same-length bytes produced by pseudo-comment masking).

/// 0-based byte range `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Span {
        Span {
            start: start.min(end),
            end: end.max(start),
        }
    }

    pub fn len(&self) -> usize {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

/// Diagnostic severity (aligned with the TS-side defAnalyzer's error/warning/info).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// Stable diagnostic codes (`kp-` prefix, passable straight through at the protocol layer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[allow(dead_code)]
pub enum DiagCode {
    /// Unclosed element (stack non-empty at EOF).
    UnclosedElement,
    /// Close tag does not match the stack top.
    MismatchedCloseTag,
    /// Stray close tag (no matching element on the stack).
    StrayCloseTag,
    /// Invalid tag name.
    InvalidTagName,
    /// Invalid attribute name or missing `=`.
    InvalidAttribute,
    /// Unterminated attribute value.
    UnterminatedAttributeValue,
    /// Unterminated comment.
    UnterminatedComment,
    /// Unterminated CDATA.
    UnterminatedCdata,
    /// Unterminated processing instruction.
    UnterminatedProcessingInstruction,
    /// Unknown/malformed entity reference.
    InvalidEntity,
    /// Duplicate attribute on one element (first kept).
    DuplicateAttribute,
    /// `<` is not followed by any recognizable construct.
    UnexpectedLt,
    /// Top-level garbage bytes outside pseudo-comments have been skipped.
    SkippedGarbage,
    /// Cycle in the inheritance/alias chain (semantic layer).
    InheritanceCycle,
}

impl DiagCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            DiagCode::UnclosedElement => "kp-unclosed-element",
            DiagCode::MismatchedCloseTag => "kp-mismatched-close-tag",
            DiagCode::StrayCloseTag => "kp-stray-close-tag",
            DiagCode::InvalidTagName => "kp-invalid-tag-name",
            DiagCode::InvalidAttribute => "kp-invalid-attribute",
            DiagCode::UnterminatedAttributeValue => "kp-unterminated-attribute-value",
            DiagCode::UnterminatedComment => "kp-unterminated-comment",
            DiagCode::UnterminatedCdata => "kp-unterminated-cdata",
            DiagCode::UnterminatedProcessingInstruction => "kp-unterminated-pi",
            DiagCode::InvalidEntity => "kp-invalid-entity",
            DiagCode::DuplicateAttribute => "kp-duplicate-attribute",
            DiagCode::UnexpectedLt => "kp-unexpected-lt",
            DiagCode::SkippedGarbage => "kp-skipped-garbage",
            DiagCode::InheritanceCycle => "kp-inheritance-cycle",
        }
    }
}

/// Structured diagnostic: code + severity + byte span + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: DiagCode,
    pub severity: Severity,
    pub span: Span,
    pub message: String,
}

impl Diagnostic {
    pub fn new(
        code: DiagCode,
        severity: Severity,
        span: Span,
        message: impl Into<String>,
    ) -> Diagnostic {
        Diagnostic {
            code,
            severity,
            span,
            message: message.into(),
        }
    }
}

/// Line-start table (for 1-based line number queries; masking does not change byte length, so it holds for the original file too).
#[derive(Debug, Clone)]
pub struct LineMap {
    line_starts: Vec<usize>,
}

impl LineMap {
    pub fn new(text: &str) -> LineMap {
        let mut line_starts = vec![0usize];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }
        LineMap { line_starts }
    }

    /// 1-based line number (out-of-range offsets clamp to the last line, no panic).
    pub fn line_of(&self, offset: usize) -> usize {
        let offset = offset.min(self.last_start());
        let mut lo = 0usize;
        let mut hi = self.line_starts.len() - 1;
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if self.line_starts[mid] <= offset {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo + 1
    }

    fn last_start(&self) -> usize {
        *self.line_starts.last().unwrap_or(&0)
    }

    pub fn line_count(&self) -> usize {
        self.line_starts.len()
    }
}
