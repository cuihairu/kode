//! 结构化诊断与字节 Span(SYNTAX-002/003)。
//!
//! 所有解析失败都产出 [`Diagnostic`],绝不 panic、绝不抛错中断整棵树;
//! span 一律 0 基字节偏移,对原始输入(含伪注释掩码后的同长度字节)有效。

/// 0 基字节区间 `[start, end)`。
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

/// 诊断严重级(与 TS 侧 defAnalyzer 的 error/warning/info 对齐)。
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

/// 稳定诊断码(`kp-` 前缀,协议层可直接透传)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[allow(dead_code)]
pub enum DiagCode {
    /// 未闭合元素(EOF 时栈非空)。
    UnclosedElement,
    /// 闭合标签与栈顶不匹配。
    MismatchedCloseTag,
    /// 游离闭合标签(栈内无对应元素)。
    StrayCloseTag,
    /// 标签名非法。
    InvalidTagName,
    /// 属性名非法或缺 `=`。
    InvalidAttribute,
    /// 属性值未闭合。
    UnterminatedAttributeValue,
    /// 注释未闭合。
    UnterminatedComment,
    /// CDATA 未闭合。
    UnterminatedCdata,
    /// 处理指令未闭合。
    UnterminatedProcessingInstruction,
    /// 未知/残缺实体引用。
    InvalidEntity,
    /// 同元素重复属性(保留首个)。
    DuplicateAttribute,
    /// `<` 后不是任何可识别构造。
    UnexpectedLt,
    /// 伪注释之外的顶层垃圾字节已被跳过。
    SkippedGarbage,
    /// 继承/别名链存在环(语义层)。
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

/// 结构化诊断:码 + 级别 + 字节 span + 消息。
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

/// 行起点表(1 基行号查询;掩码不改字节长度,故对原文件同样成立)。
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

    /// 1 基行号(越界 clamp 到末行,不 panic)。
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
