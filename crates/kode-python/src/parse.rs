//! 源 → AST 入口(ruff_python_parser 封装)+ 行定位。
//!
//! 本模块只做「解析 + 定位」的薄封装:不持有任何分析语义。分析在
//! [`crate::symbols`] / [`crate::callgraph`] / [`crate::dataflow`]。
//!
//! 失败策略:Python 是动态语言,KBEngine 脚本常带语法错误(半成品文件),
//! 但调用图/符号表仍应产出「能解析的部分」。故本 crate 对外不抛错:
//! [`parse_module`] 返回 [`ParsedAst`](其携带解析错误列表),由各分析面
//! 在 AST 上尽力抽取;`errors` 仅供诊断面消费。

use kode_vfs::LineIndex;
use ruff_python_ast::{ModModule, PySourceType};
use ruff_python_parser::{parse_unchecked_source, ParseError, Parsed};

/// 解析结果(总是「有 AST 或部分 AST」,不因语法错误而整体失败)。
#[derive(Debug)]
pub struct ParsedAst {
    /// 原始源(分析面用于定位回退与列计算)。
    pub source: String,
    /// 行索引(0-based line / UTF-16 code unit column)。
    pub lines: LineIndex,
    /// ruff 解析产物(含 token 流与错误)。
    parsed: Parsed<ModModule>,
}

impl ParsedAst {
    /// 解析 Python 源;语法错误不阻止返回,列在 [`Self::errors`]。
    ///
    /// 用 `parse_unchecked_source`(容错路径):ruff 的错误恢复会产出部分 AST,
    /// 语法错误记录在 `errors()` 而非整体失败(KBEngine 脚本常带半成品文件,
    /// 符号/调用图应尽力产出)。
    pub fn new(source: impl Into<String>) -> ParsedAst {
        let source: String = source.into();
        let lines = LineIndex::new(&source);
        let parsed = parse_unchecked_source(&source, PySourceType::default());
        ParsedAst {
            source,
            lines,
            parsed,
        }
    }

    /// 模块 AST。
    pub fn module(&self) -> &ModModule {
        self.parsed.syntax()
    }

    /// 解析错误(ruff 的语法错误;空 = 无错误)。
    pub fn errors(&self) -> &[ParseError] {
        self.parsed.errors()
    }

    pub fn has_syntax_errors(&self) -> bool {
        !self.parsed.errors().is_empty()
    }

    /// 字节 offset → (0-based line, 0-based UTF-16 column)。
    pub fn line_col(&self, offset: u32) -> (usize, usize) {
        let pos = self.lines.position_of(&self.source, offset as usize);
        (pos.line as usize, pos.character as usize)
    }

    /// 行数(与 kode-corpus 同口径:末尾换行多一空行)。
    pub fn line_count(&self) -> usize {
        self.lines.line_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_module() {
        let ast = ParsedAst::new("def foo():\n    return 1\n");
        assert!(!ast.has_syntax_errors());
        assert_eq!(ast.line_count(), 3);
        assert_eq!(ast.line_col(0), (0, 0));
    }

    #[test]
    fn tolerant_of_syntax_errors() {
        let ast = ParsedAst::new("def broken(:\n    pass\n");
        // 不 panic,错误被记录
        let _ = ast.errors();
        assert!(ast.has_syntax_errors() || ast.module().body.is_empty());
    }

    #[test]
    fn utf16_columns() {
        // 中文 1 字符 = 1 UTF-16 code unit(LSP 列口径)
        let ast = ParsedAst::new("x = '中'\n");
        // `中` 前的 `x = '` 共 5 个 UTF-16 unit → 列 5
        let src = ast.source.as_str();
        let offset = src.find('中').unwrap() as u32;
        let (_line, col) = ast.line_col(offset);
        assert_eq!(col, 5);
    }
}
