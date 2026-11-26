//! Python lexical mask (AUDIT-005 B2 lane batch 2; TS source =
//! src/backend/pythonLexicalMask.ts, a faithful port preserving each semantic).
//!
//! One full-text scan: comments and string literals (plain/triple-quoted/raw/byte-prefixed) are replaced with
//! same-length whitespace; an f-string's `{...}` expression parts stay as visible code while the literal parts
//! are masked. The mask preserves length and lines (newlines are not masked), so all column offsets are unchanged. Word chars = ASCII `[A-Za-z0-9_]`
//! (JS `\w` without the u flag = ASCII; Rust regex defaults to different Unicode semantics, hence hand-written).
//!
//! The product is UTF-16 code units (`Vec<u16>`): TS's `match.index` is a UTF-16 code-unit column
//! (JS strings index by code unit, and `split('')` also splits by code unit), so comparison needs the same base; non-ASCII
//! characters (Chinese comments/strings) are masked as whitespace per code unit (a code unit >=0x80 is neither a word char nor a dot, so it does not affect
//! `self.` matching, only acts as a boundary); byte counting is unusable (multi-byte drift).

/// ASCII word char (JS `\w`; shared decision for the trap family, single-source semantics; code-unit constants = a-z/A-Z/0-9/_)
pub(crate) fn is_word(code: u16) -> bool {
    matches!(code, 0x61..=0x7A | 0x41..=0x5A | 0x30..=0x39 | 0x5F)
}

fn is_quote(code: u16) -> bool {
    code == b'"' as u16 || code == b'\'' as u16
}

/// Whether text[at..] starts with `quote` repeated `count` times (boundary inclusive)
fn quote_run_at(text: &[u16], at: usize, quote: u16, count: usize) -> bool {
    at + count <= text.len() && text[at..at + count].iter().all(|&code| code == quote)
}

/// String prefix before the quote (e.g. r/f/rb/fr; a non-prefix letter string such as an identifier returns the empty string)
fn string_prefix_before(text: &[u16], quote_index: usize) -> &[u16] {
    let mut start = quote_index;
    while start > 0 && is_word(text[start - 1]) {
        start -= 1;
    }
    let run = &text[start..quote_index];
    let valid = run.len() <= 2
        && run
            .iter()
            .all(|&code| matches!((code as u8).to_ascii_lowercase(), b'r' | b'b' | b'f' | b'u'));
    if valid {
        run
    } else {
        &[]
    }
}

/// f-string decision (TS `/f/i.test(prefix)`; no prefix = not an f-string)
fn is_fstring(text: &[u16], quote_index: usize) -> bool {
    string_prefix_before(text, quote_index)
        .iter()
        .any(|&code| matches!(code as u8, b'f' | b'F'))
}

/// Mask one string literal starting at text[start..] (quotes included), returning the index after it ends.
/// f-string: the literal part is masked; on `{` (not `{{`) enter the expression section -- the expression section stays
/// visible; nested strings/comments are masked recursively; a matching `}` returns to the literal section.
fn mask_string_at(text: &[u16], out: &mut [u16], start: usize) -> usize {
    let n = text.len();
    let quote = text[start];
    let fstring = is_fstring(text, start);
    let triple = quote_run_at(text, start, quote, 3);
    let open_len = if triple { 3 } else { 1 };
    blank(text, out, start, start + open_len);
    let mut i = start + open_len;
    let mut fexpr_depth = 0usize;
    while i < n {
        let code = text[i];
        if fexpr_depth > 0 {
            if code == b'{' as u16 {
                fexpr_depth += 1;
                i += 1;
                continue;
            }
            if code == b'}' as u16 {
                fexpr_depth -= 1;
                i += 1;
                continue;
            }
            if code == b'#' as u16 {
                i = mask_comment_at(text, out, i);
                continue;
            }
            if is_quote(code) {
                i = mask_string_at(text, out, i);
                continue;
            }
            i += 1;
            continue;
        }
        if fstring {
            if code == quote && (!triple || quote_run_at(text, i, quote, 3)) {
                let close_len = if triple { 3 } else { 1 };
                blank(text, out, i, i + close_len);
                return i + close_len;
            }
            if code == b'{' as u16 && text.get(i + 1) == Some(&(b'{' as u16)) {
                blank(text, out, i, i + 2);
                i += 2;
                continue;
            }
            if code == b'{' as u16 {
                fexpr_depth = 1;
                i += 1;
                continue;
            }
            if code == b'\\' as u16 {
                blank(text, out, i, i + 2);
                i += 2;
                continue;
            }
            blank(text, out, i, i + 1);
            i += 1;
            continue;
        }
        // Plain string: mask up to the closing quote / end of line (escaped pairs skipped)
        if code == b'\\' as u16 {
            blank(text, out, i, i + 2);
            i += 2;
            continue;
        }
        if code == quote {
            if triple && !quote_run_at(text, i, quote, 3) {
                blank(text, out, i, i + 1); // single quote inside a triple-quoted string, mask 1 char and continue
                i += 1;
                continue;
            }
            blank(text, out, i, i + open_len);
            return i + open_len;
        }
        if !triple && (code == b'\n' as u16 || code == b'\r' as u16) {
            return i; // unclosed single-quoted string ends at end of line (newline not masked)
        }
        blank(text, out, i, i + 1);
        i += 1;
    }
    n
}

/// Mask [from..to) (newline/CR not masked, preserving lines)
fn blank(text: &[u16], out: &mut [u16], from: usize, to: usize) {
    let end = to.min(text.len());
    for k in from..end {
        if text[k] != b'\n' as u16 && text[k] != b'\r' as u16 {
            out[k] = b' ' as u16;
        }
    }
}

/// Mask a comment within one line in top-level code (to end of line)
fn mask_comment_at(text: &[u16], out: &mut [u16], start: usize) -> usize {
    let n = text.len();
    let mut j = start;
    while j < n {
        let code = text[j];
        if code == b'\n' as u16 || code == b'\r' as u16 {
            break;
        }
        out[j] = b' ' as u16;
        j += 1;
    }
    j
}

/// One full-text scan produces the mask (UTF-16 code units, same code-unit length as the input, newlines preserved as-is).
pub fn mask_python_non_code(text: &str) -> Vec<u16> {
    let original: Vec<u16> = text.encode_utf16().collect();
    let mut out = original.clone();
    let n = out.len();
    let mut i = 0usize;
    let mut fexpr_depth = 0usize;
    while i < n {
        let code = original[i];
        if fexpr_depth > 0 {
            if code == b'{' as u16 {
                fexpr_depth += 1;
                i += 1;
                continue;
            }
            if code == b'}' as u16 {
                fexpr_depth -= 1;
                i += 1;
                continue;
            }
            if code == b'#' as u16 {
                i = mask_comment_at(&original, &mut out, i);
                continue;
            }
            if is_quote(code) {
                i = mask_string_at(&original, &mut out, i);
                continue;
            }
            i += 1;
            continue;
        }
        if code == b'#' as u16 {
            i = mask_comment_at(&original, &mut out, i);
            continue;
        }
        if is_quote(code) {
            i = mask_string_at(&original, &mut out, i);
            continue;
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_string(masked: &[u16]) -> String {
        String::from_utf16(masked).unwrap()
    }

    #[test]
    fn masks_comments_and_strings_preserving_length() {
        let text = "x = 1 # comment\nname = 'a,b#c'\nd = f\"{value}, lit\"\n";
        let masked = mask_python_non_code(text);
        assert_eq!(masked.len(), text.encode_utf16().count());
        let masked = to_string(&masked);
        assert!(masked.contains("x = 1 "));
        assert!(!masked.contains("comment"));
        assert!(!masked.contains("a,b"));
        // f-string expression section visible
        assert!(masked.contains("value"));
        assert!(!masked.contains("lit"));
    }

    #[test]
    fn masks_triple_quoted_strings() {
        let text = "x = '''line1\nline2'''\ny = 1\n";
        let masked = to_string(&mask_python_non_code(text));
        assert!(masked.contains("y = 1"));
        assert!(!masked.contains("line1"));
    }

    #[test]
    fn masks_non_ascii_without_panic_and_preserves_code() {
        // Non-ASCII (Chinese comments/strings) masked as whitespace per code unit, no panic, no drift
        let text = "# 中文注释 self.velocity\nprint('速度', self.position)\n";
        let masked = to_string(&mask_python_non_code(text));
        assert!(!masked.contains("velocity"));
        // Visible-code self-access preserved
        assert!(masked.contains("self.position"));
    }

    /// f-string deep arm: {{ literal escapes / comments inside expressions / nested strings / literal-section backslash
    /// escapes / nested braces in expressions -- the literal section is fully masked; in the expression section code stays visible and non-code is masked recursively.
    #[test]
    fn masks_fstring_literal_escapes_and_nested_expression_faces() {
        let text = "d = f\"{{lit}} {a # note\n} {'k'} \\t { {'x': 1} } tail\"\n";
        let masked = to_string(&mask_python_non_code(text));
        // Literal section and escapes fully masked
        assert!(!masked.contains("lit"));
        assert!(!masked.contains("note"), "comment inside f-expr masked");
        assert!(!masked.contains("k"), "nested string inside f-expr masked");
        assert!(!masked.contains("x"), "string in nested braces masked");
        assert!(!masked.contains("tail"));
        // Expression section code visible
        assert!(masked.contains("a"), "f-expr code stays visible");
        assert!(masked.contains("1"), "nested dict value stays visible");
        // Code-unit length conserved
        assert_eq!(masked.encode_utf16().count(), text.encode_utf16().count());
    }

    /// Plain-string deep arm: escape pairs / single quotes nested in triple quotes / quotes with illegal prefixes / unclosed to
    /// end of line and to EOF -- newlines preserved, following code not collateral-damaged.
    #[test]
    fn masks_plain_escapes_embedded_quotes_and_unterminated_strings() {
        let text = concat!(
            "a = 'p\\q'\n",
            "b = '''it's'''\n",
            "c = ab\"cd\"\n",
            "d = 'unterminated\n",
            "z = 1\n"
        );
        let masked = to_string(&mask_python_non_code(text));
        assert!(masked.contains("a ="), "code around strings survives");
        assert!(
            !masked.contains("p\\q"),
            "escaped pair masked as one string"
        );
        assert!(!masked.contains("it's"), "triple-quoted body masked");
        assert!(
            !masked.contains("cd"),
            "invalid-prefix quote still masks body"
        );
        assert!(
            masked.contains("c = ab"),
            "prefix letters are code, stay visible"
        );
        assert!(
            !masked.contains("unterminated"),
            "unterminated masks to EOL"
        );
        assert!(masked.contains("z = 1"), "next line unaffected");
        // Unclosed string without a trailing newline: mask to EOF, no out-of-bounds, no panic.
        let eof_text = "x = \"abc";
        let eof_masked = to_string(&mask_python_non_code(eof_text));
        assert!(!eof_masked.contains("abc"));
        assert_eq!(eof_masked.len(), eof_text.len());
    }
}
