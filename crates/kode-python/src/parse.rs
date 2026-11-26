//! Source -> AST entry point (ruff_python_parser wrapper) + line locations.
//!
//! This module is only a thin "parse + locate" wrapper: it holds no analysis
//! semantics. Analysis lives in [`crate::symbols`] / [`crate::callgraph`] /
//! [`crate::dataflow`].
//!
//! Failure strategy: Python is a dynamic language and KBEngine scripts often carry
//! syntax errors (half-finished files), yet the call graph / symbol tables should still
//! yield "the parseable portion". So this crate never throws outward:
//! [`parse_module`] returns [`ParsedAst`] (which carries the parse error list); each
//! analysis face extracts best-effort from the AST; `errors` is only for the
//! diagnostics face to consume.

use kode_vfs::LineIndex;
use ruff_python_ast::{ModModule, PySourceType};
use ruff_python_parser::{parse_unchecked_source, ParseError, Parsed};

/// Parse result (always "has an AST or a partial AST"; never fails wholesale on syntax errors).
#[derive(Debug)]
pub struct ParsedAst {
    /// Raw source (used by analysis faces for location fallback and column computation).
    pub source: String,
    /// Line index (0-based line / UTF-16 code unit column).
    pub lines: LineIndex,
    /// ruff parse output (including the token stream and errors).
    parsed: Parsed<ModModule>,
}

impl ParsedAst {
    /// Parse Python source; syntax errors do not block the return, they are listed in [`Self::errors`].
    ///
    /// Uses `parse_unchecked_source` (the tolerant path): ruff's error recovery yields a partial
    /// AST, and syntax errors are recorded in `errors()` rather than failing the whole parse
    /// (KBEngine scripts often contain half-finished files, so symbols / the call graph should be
    /// produced best-effort).
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

    /// Module AST.
    pub fn module(&self) -> &ModModule {
        self.parsed.syntax()
    }

    /// Parse errors (ruff's syntax errors; empty = no errors).
    pub fn errors(&self) -> &[ParseError] {
        self.parsed.errors()
    }

    pub fn has_syntax_errors(&self) -> bool {
        !self.parsed.errors().is_empty()
    }

    /// Byte offset -> (0-based line, 0-based UTF-16 column).
    pub fn line_col(&self, offset: u32) -> (usize, usize) {
        let pos = self.lines.position_of(&self.source, offset as usize);
        (pos.line as usize, pos.character as usize)
    }

    /// Line count (same semantics as kode-corpus: a trailing newline yields one extra blank line).
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
        // Does not panic; the error is recorded.
        let _ = ast.errors();
        assert!(ast.has_syntax_errors() || ast.module().body.is_empty());
    }

    #[test]
    fn utf16_columns() {
        // One CJK character = one UTF-16 code unit (LSP column semantics).
        let ast = ParsedAst::new("x = '中'\n");
        // The `x = '` before `中` totals 5 UTF-16 units -> column 5.
        let src = ast.source.as_str();
        let offset = src.find('中').unwrap() as u32;
        let (_line, col) = ast.line_col(offset);
        assert_eq!(col, 5);
    }
}
