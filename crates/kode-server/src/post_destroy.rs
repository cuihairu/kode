//! postDestroy diagnostics absorption (AUDIT-005 B2 lane batch 4): `$/kode/lint/analyzePostDestroy`.
//!
//! The TS source = src/backend/postDestroyDiagnostics.ts, ported faithfully semantically (comparison discipline):
//!   - the whole scan runs on the UTF-16 code-unit face (`Vec<u16>`, encode_utf16) -- the TS
//!     `match.index`/`indexOf` are both UTF-16 code-unit columns; on a non-ASCII line the byte face would drift;
//!   - the line mask = an equivalent port of pythonCodeLines (comments / strings / f-strings **masked as a whole segment**,
//!     a different semantics from the "f-string expressions kept" of mask_python_non_code used by receiverNone;
//!     quote state carries across lines, a backslash escape counts double, and triple-quote open/close count 3) -- note this
//!     module masks text itself, consistent with the TS-side pythonCodeLines comparison;
//!   - the statement face (text/line/endLine/indent after mask concatenation) is supplied by the TS side
//!     (pythonStatements is the shared upstream, and parsePythonFile is built on it too) -- this module
//!     does not redo statement splitting, it only does block / destroy / early-exit / access-point analysis;
//!   - every regex is hand-expanded: the `\b` left boundary = the preceding code unit is not a word unit or start of text; a word unit =
//!     `[A-Za-z0-9_]`; `\s` = the JS whitespace class; the anchored prefix shapes are tested unit by unit;
//!   - no messages leave Rust: only the structural face comes back (line/character/length/member + destroyLine/
//!     destroyColumn); the l10n rendering stays with TS (a malformed whole face is discarded).
//!
//! Input `{text, destroyDeclared,
//! statements:[{text,line,endLine,indent},…]}` (text is the mask-concatenated text);
//! output `{items:[{line,character,length,member,destroyLine,destroyColumn}]}`.
//! The face / dynamic-dispatch gate (pathFace/defFaces/destroyDeclared short-circuits) lives in the TS wiring layer,
//! and this module keeps the destroyDeclared guard line (contract fidelity).

use serde::Deserialize;
use serde_json::{json, Value};

use crate::python_lexical_mask::is_word;
use crate::rpc::RpcRegistry;

pub const CODE_POST_DESTROY: &str = "kbengine.postDestroy";

/// TS SAFE_MEMBERS: members still readable/harmless after destruction (identity, state, repeated destroy).
const SAFE_MEMBERS: [&str; 4] = ["id", "isDestroyed", "className", "destroy"];

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzePostDestroy", analyze_post_destroy);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PostDestroyParams {
    text: String,
    /// a def declaring destroy (the dynamic-dispatch boundary) -> zero output (the TS wiring layer already short-circuits; this is a guard line)
    #[serde(default)]
    destroy_declared: bool,
    /// The TS pythonStatements product (mask-concatenated text + first-line coordinates/indent)
    #[serde(default)]
    statements: Vec<StatementInput>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StatementInput {
    #[serde(default)]
    text: String,
    #[serde(default)]
    line: usize,
    #[serde(default)]
    end_line: usize,
    #[serde(default)]
    indent: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PostDestroyItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    member: String,
    destroy_line: usize,
    destroy_column: usize,
}

fn analyze_post_destroy(params: Value) -> Result<Value, String> {
    let params: PostDestroyParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let items =
        compute_post_destroy_items(&params.text, params.destroy_declared, &params.statements);
    Ok(json!({ "items": items }))
}

// ---- basic word-unit / whitespace tests -------------------------------------------------------

fn is_js_space(code: u16) -> bool {
    matches!(
        code,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

fn is_name_start(code: u16) -> bool {
    code == 0x5F || (0x41..=0x5A).contains(&code) || (0x61..=0x7A).contains(&code)
}

fn is_name_char(code: u16) -> bool {
    is_name_start(code) || (0x30..=0x39).contains(&code)
}

fn starts_with(text: &[u16], at: usize, word: &str) -> bool {
    let mut expected = word.encode_utf16();
    for &code in text.get(at..).unwrap_or(&[]) {
        match expected.next() {
            Some(want) => {
                if code != want {
                    return false;
                }
            }
            None => return true, // word units exhausted = the prefix holds
        }
    }
    expected.next().is_none()
}

fn eq_u16(text: &[u16], word: &str) -> bool {
    text.len() == word.encode_utf16().count() && text.iter().copied().eq(word.encode_utf16())
}

/// Line splitting = `\r?\n` (stripping at most one `\r` before `\n`), the same semantics as TS `split(/\r?\n/)`.
fn split_lines(text: &[u16]) -> Vec<Vec<u16>> {
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    let mut i = 0usize;
    while i < text.len() {
        let code = text[i];
        if code == 0x0A {
            if let Some(last) = current.last() {
                if *last == 0x0D {
                    current.pop();
                }
            }
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(code);
        }
        i += 1;
    }
    if let Some(last) = current.last() {
        if *last == 0x0D {
            current.pop();
        }
    }
    lines.push(current);
    lines
}

/// Trims leading and trailing JS whitespace (the equivalent form of doing the anchored test after TS `trimStart()`: the
/// anchored `^` only looks at the leading side; trailing whitespace does not affect prefix matching -- this still trims fully for reuse).
fn trim_u16(text: &[u16]) -> &[u16] {
    let mut start = 0usize;
    while start < text.len() && is_js_space(text[start]) {
        start += 1;
    }
    let mut end = text.len();
    while end > start && is_js_space(text[end - 1]) {
        end -= 1;
    }
    &text[start..end]
}

// ---- an equivalent port of pythonCodeLines (quote state carries across lines; length and position preserved) ----------------------
//
// The TS per-code-unit state machine: inside quotes -> spaces (a backslash escape counts double; a single-quote close counts 1; a
// triple-quote close counts 3); an open quote -> `_` (a triple quote `___`); `#` -> all spaces to the end of line; quote state carries
// across lines (an unclosed single quote continues to the next line). f-strings get no special case = the expression is masked as a whole segment.

fn python_code_lines(text: &[u16]) -> Vec<Vec<u16>> {
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut quote: Option<u16> = None;
    let mut triple = false;
    for raw in split_lines(text) {
        let mut masked: Vec<u16> = Vec::with_capacity(raw.len());
        let mut col = 0usize;
        while col < raw.len() {
            let ch = raw[col];
            if let Some(q) = quote {
                if ch == 0x5C {
                    // TS: `masked += '  '; col += 1; continue;` (the loop adds another +1 = two columns, two code units)
                    masked.push(0x20);
                    masked.push(0x20);
                    col += 2;
                    continue;
                }
                let triple_close = triple
                    && col + 3 <= raw.len()
                    && raw[col] == q
                    && raw[col + 1] == q
                    && raw[col + 2] == q;
                if triple_close {
                    quote = None;
                    triple = false;
                    masked.extend_from_slice(&[0x20, 0x20, 0x20]);
                    col += 3;
                } else if !triple && ch == q {
                    quote = None;
                    masked.push(0x20);
                    col += 1;
                } else {
                    masked.push(0x20);
                    col += 1;
                }
                continue;
            }
            if ch == 0x23 {
                while masked.len() < raw.len() {
                    masked.push(0x20);
                }
                break;
            }
            if ch == 0x27 || ch == 0x22 {
                let triple_open = col + 3 <= raw.len() && raw[col + 1] == ch && raw[col + 2] == ch;
                quote = Some(ch);
                triple = triple_open;
                if triple {
                    masked.extend_from_slice(&[0x5F, 0x5F, 0x5F]);
                    col += 3;
                } else {
                    masked.push(0x5F);
                    col += 1;
                }
                continue;
            }
            masked.push(ch);
            col += 1;
        }
        lines.push(masked);
    }
    lines
}

// ---- statement shape tests (the TS regex hand-expanded) ------------------------------------------

/// `^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(`
fn function_header(text: &[u16]) -> bool {
    let mut i = 0usize;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if starts_with(text, i, "async") {
        let mut j = i + 5;
        let ws_start = j;
        while j < text.len() && is_js_space(text[j]) {
            j += 1;
        }
        if j > ws_start {
            i = j;
        }
        // no whitespace after async -> the optional group does not hold (falling back to testing def from i, which must fail, the same
        // semantics as regex backtracking)
    }
    if !starts_with(text, i, "def") {
        return false;
    }
    let mut j = i + 3;
    let ws_start = j;
    while j < text.len() && is_js_space(text[j]) {
        j += 1;
    }
    if j == ws_start {
        return false; // at least 1 whitespace is required after def
    }
    if j >= text.len() || !is_name_start(text[j]) {
        return false;
    }
    j += 1;
    while j < text.len() && is_name_char(text[j]) {
        j += 1;
    }
    while j < text.len() && is_js_space(text[j]) {
        j += 1;
    }
    j < text.len() && text[j] == 0x28
}

/// `self\.destroy\s*\(` at `at` (the prefix shape is guaranteed by the caller)
fn destroy_call_at(text: &[u16], at: usize) -> bool {
    if !starts_with(text, at, "self.destroy") {
        return false;
    }
    let mut j = at + "self.destroy".len();
    while j < text.len() && is_js_space(text[j]) {
        j += 1;
    }
    j < text.len() && text[j] == 0x28
}

/// `^(?:[A-Za-z_]\w*\s*=\s*)?self\.destroy\s*\(` (tested after trimStart)
fn destroy_statement(trimmed: &[u16]) -> bool {
    if destroy_call_at(trimmed, 0) {
        return true;
    }
    // The assignment-prefix shape: name + \s* + '=' + \s* (it may fall back to no prefix, which was tried first)
    if trimmed.is_empty() || !is_name_start(trimmed[0]) {
        return false;
    }
    let mut k = 1usize;
    while k < trimmed.len() && is_name_char(trimmed[k]) {
        k += 1;
    }
    while k < trimmed.len() && is_js_space(trimmed[k]) {
        k += 1;
    }
    if k >= trimmed.len() || trimmed[k] != 0x3D {
        return false;
    }
    k += 1;
    while k < trimmed.len() && is_js_space(trimmed[k]) {
        k += 1;
    }
    destroy_call_at(trimmed, k)
}

/// `^(?:return|break|continue|raise)\b` (tested after trimStart; \b = followed by a non-word unit or end of text)
fn early_exit_statement(trimmed: &[u16]) -> bool {
    for word in ["return", "break", "continue", "raise"] {
        if starts_with(trimmed, 0, word) {
            let end = word.len();
            if end >= trimmed.len() || !is_word(trimmed[end]) {
                return true;
            }
        }
    }
    false
}

/// `\bself\.` exists in the statement text (no trailing boundary; the word-unit maximal property is guaranteed by the left boundary)
fn contains_self_access(text: &[u16]) -> bool {
    let mut i = 0usize;
    while i + 5 <= text.len() {
        if starts_with(text, i, "self.") && (i == 0 || !is_word(text[i - 1])) {
            return true;
        }
        i += 1;
    }
    false
}

/// `\bself\.(\w+)/g` hit by hit (on masked rows; (start, name start, name length); when the \w+ match fails, the engine
/// advances one step, here the same semantics as `pos = i + 1`)
fn access_matches(masked: &[u16]) -> Vec<(usize, usize, usize)> {
    let mut hits: Vec<(usize, usize, usize)> = Vec::new();
    let mut pos = 0usize;
    while pos + 5 <= masked.len() {
        let mut found: Option<usize> = None;
        let mut i = pos;
        while i + 5 <= masked.len() {
            if starts_with(masked, i, "self.") && (i == 0 || !is_word(masked[i - 1])) {
                found = Some(i);
                break;
            }
            i += 1;
        }
        let Some(start) = found else { break };
        let name_start = start + 5;
        let mut name_end = name_start;
        while name_end < masked.len() && is_name_char(masked[name_end]) {
            name_end += 1;
        }
        if name_end == name_start {
            pos = start + 1;
            continue;
        }
        hits.push((start, name_start, name_end - name_start));
        pos = name_end;
    }
    hits
}

/// `indexOf('self.destroy')` (no hit -> TS `Math.max(0, -1)` = 0)
fn destroy_column_of(masked: &[u16]) -> Option<usize> {
    let word: Vec<u16> = "self.destroy".encode_utf16().collect();
    if masked.len() < word.len() {
        return None;
    }
    for i in 0..=masked.len() - word.len() {
        if masked[i..i + word.len()]
            .iter()
            .copied()
            .eq(word.iter().copied())
        {
            return Some(i);
        }
    }
    None
}

// ---- block / destroy / early-exit analysis (isomorphic with TS findPostDestroyFindings) ----------------------

/// The same function body and the same block: the same indent, and no statement with an indent < this level between the two (no dedent)
fn same_block(from: &StatementInput, to: &StatementInput, body: &[&StatementInput]) -> bool {
    if from.indent != to.indent {
        return false;
    }
    for stmt in body {
        if stmt.line <= from.line {
            continue;
        }
        if stmt.line >= to.line {
            break;
        }
        if stmt.indent < from.indent {
            return false;
        }
    }
    true
}

fn compute_post_destroy_items(
    text: &str,
    destroy_declared: bool,
    statements: &[StatementInput],
) -> Vec<PostDestroyItem> {
    if destroy_declared {
        return Vec::new();
    }
    let text_u16: Vec<u16> = text.encode_utf16().collect();
    let masked_lines = python_code_lines(&text_u16);
    let mut findings: Vec<PostDestroyItem> = Vec::new();

    // Only inside function bodies is analyzed (a module/class body has no self; a top-level match does not hold)
    for s in 0..statements.len() {
        let header = &statements[s];
        let header_text: Vec<u16> = header.text.encode_utf16().collect();
        if !function_header(&header_text) {
            continue;
        }
        // The function body = the statements after it with an indent > the def's indent
        let body_start = s + 1;
        let mut body_end = statements.len();
        for (t, stmt) in statements.iter().enumerate().skip(body_start) {
            if stmt.indent <= header.indent {
                body_end = t;
                break;
            }
        }
        let body: Vec<&StatementInput> = statements[body_start..body_end].iter().collect();

        // Within the same block, find the destroy statement before each access statement
        for (a_idx, access) in body.iter().enumerate() {
            let access_text: Vec<u16> = access.text.encode_utf16().collect();
            if !contains_self_access(&access_text) {
                continue;
            }
            let mut destroy: Option<&StatementInput> = None;
            for d in 0..a_idx {
                let candidate = body[d];
                let candidate_text: Vec<u16> = candidate.text.encode_utf16().collect();
                if !destroy_statement(trim_u16(&candidate_text)) {
                    continue;
                }
                if !same_block(candidate, access, &body) {
                    continue;
                }
                // A same-level early exit (return/break/continue/raise) between the destroy and the access -> the access is dead code
                let mut dead = false;
                for mid in body.iter().take(a_idx).skip(d + 1) {
                    let mid_text: Vec<u16> = mid.text.encode_utf16().collect();
                    if mid.indent == access.indent && early_exit_statement(trim_u16(&mid_text)) {
                        dead = true;
                        break;
                    }
                }
                if !dead {
                    destroy = Some(candidate);
                    break;
                }
            }
            let Some(destroy) = destroy else { continue };
            // Hit `self.<member>` one by one (member not in the safe set): scan the masked rows (the mask preserves the
            // source positions, so pseudo-accesses inside strings/comments do not hit)
            let destroy_column = masked_lines
                .get(destroy.line)
                .and_then(|line| destroy_column_of(line))
                .unwrap_or(0);
            let mut ln = access.line;
            while ln <= access.end_line {
                if let Some(masked) = masked_lines.get(ln) {
                    for (start, name_start, name_len) in access_matches(masked) {
                        let member_slice = &masked[name_start..name_start + name_len];
                        if SAFE_MEMBERS.iter().any(|m| eq_u16(member_slice, m)) {
                            continue;
                        }
                        findings.push(PostDestroyItem {
                            code: CODE_POST_DESTROY,
                            line: ln,
                            character: start,
                            length: name_start + name_len - start,
                            member: String::from_utf16_lossy(member_slice),
                            destroy_line: destroy.line,
                            destroy_column,
                        });
                    }
                }
                ln += 1;
            }
        }
    }
    // Dedup: a nested function body is analyzed both with the outer function and as its own function, so the same hit repeats
    let mut seen: Vec<(usize, usize, String)> = Vec::new();
    let mut deduped: Vec<PostDestroyItem> = Vec::new();
    for finding in findings {
        let key = (finding.line, finding.character, finding.member.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        deduped.push(finding);
    }
    deduped
}

// ---- unit tests (the shape face; the behavior face is compared by tests/postDestroyRustParity.test.ts) --------

#[cfg(test)]
mod tests {
    use super::*;

    fn stmt(text: &str, line: usize, end_line: usize, indent: usize) -> StatementInput {
        StatementInput {
            text: text.to_string(),
            line,
            end_line,
            indent,
        }
    }

    #[test]
    fn bare_destroy_then_access_reports() {
        let text = "class A:\n    def f(self):\n        self.destroy()\n        self.hp\n";
        let statements = vec![
            stmt("class A:", 0, 0, 0),
            stmt("def f(self):", 1, 1, 4),
            stmt("self.destroy()", 2, 2, 8),
            stmt("self.hp", 3, 3, 8),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 3);
        assert_eq!(items[0].character, 8);
        assert_eq!(items[0].length, "self.hp".len());
        assert_eq!(items[0].member, "hp");
        assert_eq!(items[0].destroy_line, 2);
        assert_eq!(items[0].destroy_column, 8);
    }

    #[test]
    fn assignment_form_destroy_reports() {
        let text = "def f(self):\n    result = self.destroy()\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("result = self.destroy()", 1, 1, 4),
            stmt("self.hp", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].destroy_line, 1);
    }

    #[test]
    fn safe_members_are_skipped() {
        let text = "def f(self):\n    self.destroy()\n    a = [self.id, self.isDestroyed, self.className, self.destroy]\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt(
                "a = [self.id, self.isDestroyed, self.className, self.destroy]",
                2,
                2,
                4,
            ),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn same_level_early_exit_makes_access_dead() {
        let text = "def f(self):\n    self.destroy()\n    return\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("return", 2, 2, 4),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn deeper_early_exit_does_not_kill_proof() {
        let text = "def f(self):\n    self.destroy()\n    if x: return\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("if x: return", 2, 2, 4),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        // "if x: return" is a single statement (the text prefix is not return) -> it does not constitute an early exit
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn dedent_between_breaks_same_block() {
        let text = "def f(self):\n    self.destroy()\n  x = 1\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("x = 1", 2, 2, 2),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn destroy_after_access_not_reported() {
        let text = "def f(self):\n    self.hp\n    self.destroy()\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.hp", 1, 1, 4),
            stmt("self.destroy()", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn masked_string_statement_no_false_hit() {
        // Strings are masked as a whole segment (the statement text supplied by the TS side is already masked): a string containing
        // self.hp does not constitute an access; the masked-row scan likewise does not hit
        let text = "def f(self):\n    self.destroy()\n    s = \"self.hp\"\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("s = _________", 2, 2, 4), // the masked form of "self.hp" (9 code units)
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn multiline_access_scans_each_line() {
        let text = "def f(self):\n    self.destroy()\n    total = (self.hp +\n        self.mp)\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("total = (self.hp +         self.mp)", 2, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].line, 2);
        assert_eq!(items[0].member, "hp");
        assert_eq!(items[1].line, 3);
        assert_eq!(items[1].member, "mp");
        assert_eq!(items[1].character, 8);
    }

    #[test]
    fn nested_def_deeper_access_not_cross_reported() {
        let text = "def f(self):\n    self.destroy()\n    def g():\n        self.hp\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("def g():", 2, 2, 4),
            stmt("self.hp", 3, 3, 8),
            stmt("self.hp", 4, 4, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        // line3 is in g's body (indent 8): the destroy is in f's body (indent 4) -> same-block indents differ, so it does not cross blocks;
        // g's body itself has no destroy -> not reported. Only line4, entering the same level directly, reports 1.
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 4);
    }

    #[test]
    fn destroy_declared_zero_items() {
        let text = "def f(self):\n    self.destroy()\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("self.hp", 2, 2, 4),
        ];
        assert!(compute_post_destroy_items(text, true, &statements).is_empty());
    }

    #[test]
    fn async_header_recognized() {
        let text = "async def f(self):\n    self.destroy()\n    self.hp\n";
        let statements = vec![
            stmt("async def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("self.hp", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn mask_preserves_positions_across_quote_lines() {
        // Quote state across lines: an unclosed single quote continues to the next line; an open quote counts 1 as `_`; a space inside quotes;
        // the closing quote counts 1 as a space; a backslash escape counts double
        let text = "s = 'abc\ndef\n' + self.hp\n";
        let lines = python_code_lines(&text.encode_utf16().collect::<Vec<u16>>());
        assert_eq!(lines.len(), 4); // the trailing \n -> an empty final line (the same split semantics)
        assert_eq!(String::from_utf16_lossy(&lines[0]), "s = _   ");
        assert_eq!(String::from_utf16_lossy(&lines[1]), "   ");
        assert_eq!(String::from_utf16_lossy(&lines[2]), "  + self.hp");
        let escaped = "\"a\\\"b\" self.hp";
        let lines = python_code_lines(&escaped.encode_utf16().collect::<Vec<u16>>());
        // The open quote `_` + inside quotes ('a' a space, the escape counting double, 'b' a space) + the closing quote a space + a space
        assert_eq!(String::from_utf16_lossy(&lines[0]), "_      self.hp");
    }

    #[test]
    fn params_round_trip() {
        let params: PostDestroyParams = serde_json::from_value(json!({
            "text": "def f(self):\n    self.destroy()\n    self.hp\n",
            "destroyDeclared": false,
            "statements": [
                { "text": "def f(self):", "line": 0, "endLine": 0, "indent": 0 },
                { "text": "self.destroy()", "line": 1, "endLine": 1, "indent": 4 },
                { "text": "self.hp", "line": 2, "endLine": 2, "indent": 4 }
            ]
        }))
        .expect("params decode");
        let items =
            compute_post_destroy_items(&params.text, params.destroy_declared, &params.statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].member, "hp");
        let encoded = serde_json::to_value(&items[0]).expect("item encode");
        assert_eq!(encoded["line"], json!(2));
        assert_eq!(encoded["character"], json!(4));
        assert_eq!(encoded["member"], json!("hp"));
        assert_eq!(encoded["destroyLine"], json!(1));
        assert_eq!(encoded["destroyColumn"], json!(4));
        assert_eq!(encoded["length"], json!(7));
    }

    // ---- entry / underlying shape faces (added by the COV batch) -------------------------------------------

    /// RPC entry called directly: well-shaped parameters round-trip + non-object parameters honestly Err.
    #[test]
    fn rpc_entry_round_trip_and_bad_shape_is_error() {
        let v = analyze_post_destroy(json!({
            "text": "def f(self):\n    self.destroy()\n    self.hp\n",
            "destroyDeclared": false,
            "statements": [
                { "text": "def f(self):", "line": 0, "endLine": 0, "indent": 0 },
                { "text": "self.destroy()", "line": 1, "endLine": 1, "indent": 4 },
                { "text": "self.hp", "line": 2, "endLine": 2, "indent": 4 }
            ]
        }))
        .expect("valid params decode");
        assert_eq!(v["items"][0]["member"], json!("hp"));
        assert!(analyze_post_destroy(json!(7)).is_err());
    }

    /// The full JS whitespace class: trimming in both directions + the leading-indent test both go by the full class (NBSP / full-width / the line
    /// separator / ZWNBSP all count as whitespace; the narrow ASCII class would diverge from TS).
    #[test]
    fn js_space_class_full_width_faces_trim_and_header() {
        let spaced: Vec<u16> =
            "\u{00a0}\u{1680}\u{2003}\u{2028}\u{2029}\u{3000}\u{FEFF}self.destroy()\u{205F}"
                .encode_utf16()
                .collect();
        assert!(destroy_statement(trim_u16(&spaced)));
        let hdr: Vec<u16> = "\u{00a0}async def foo(self):".encode_utf16().collect();
        assert!(function_header(&hdr), "NBSP 缩进 + async + 多字符名");
    }

    /// The function_header rejection face: no whitespace after def / the name does not start with a name-start / text ends right after def.
    #[test]
    fn function_header_reject_faces() {
        let s = |t: &str| t.encode_utf16().collect::<Vec<u16>>();
        assert!(!function_header(&s("def(self):")));
        assert!(!function_header(&s("def 1x(")));
        assert!(!function_header(&s("async def")));
        assert!(function_header(&s("def foo (self):")));
    }

    /// The mask face: comments turned into all spaces for the line, a triple-quote open (___), the body (spaces), the close (spaces x3),
    /// CRLF pair-stripping, and a lone trailing \r on the last line stripped (the same split semantics).
    #[test]
    fn masking_comments_triple_quotes_and_crlf_split() {
        let text = "# note\r\n\ns = '''abc'''\r\nself.hp\r";
        let lines = python_code_lines(&text.encode_utf16().collect::<Vec<u16>>());
        assert_eq!(lines.len(), 4);
        assert_eq!(String::from_utf16_lossy(&lines[0]), "      ");
        // An empty line (\n immediately after \r\n): current is empty at the split; the last() None path
        assert_eq!(String::from_utf16_lossy(&lines[1]), "");
        // The open quote is ___; the body (abc) and the closing quote are each masked as spaces (only the open quote is _)
        assert_eq!(String::from_utf16_lossy(&lines[2]), "s = ___      ");
        assert_eq!(String::from_utf16_lossy(&lines[3]), "self.hp");
    }

    /// The destroy-call shape: whitespace before the paren still holds; a candidate statement whose prefix is not an assignable name (starting
    /// with ( ) is vetoed before destroy (a non-destroy statement goes down the assignment-prefix rejection arm).
    #[test]
    fn destroy_call_space_before_paren_and_nonassignable_candidate() {
        let text = "def f(self):\n    (x)\n    self.destroy ()\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("(x)", 1, 1, 4),
            stmt("self.destroy ()", 2, 2, 4),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].destroy_line, 2);
        assert_eq!(items[0].destroy_column, 4);
    }

    /// A word-boundary failure: the "returnx" prefix hits return but a trailing word unit follows -> not an early exit,
    /// and the access still gets reported.
    #[test]
    fn return_suffixed_word_is_not_early_exit() {
        let text = "def f(self):\n    self.destroy()\n    returnx\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("returnx", 2, 2, 4),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
    }

    /// No name after `self.` (whitespace): the access statement holds (it contains \bself\.) but the hit-by-hit scan finds zero
    /// hits; endLine crossing past the text's last line (masked rows absent) likewise finds zero hits without panicking.
    #[test]
    fn self_dot_without_name_scans_no_hits_beyond_end() {
        let text = "def f(self):\n    self.destroy()\n    self. hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("self. hp", 2, 9, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    /// destroy_column fallback: when the statement's declared face mismatches the original line (the line too short / the line long enough but
    /// without the self.destroy substring), it honestly returns 0 and does not fabricate.
    #[test]
    fn destroy_column_falls_back_when_masked_line_lacks_call() {
        let short = "def f(self):\nzz\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("self.hp", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(short, false, &statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].destroy_column, 0);

        let long_no_call = "def f(self):\n    zzzzzzzzzzzzzz\n    self.hp\n";
        let items2 = compute_post_destroy_items(long_no_call, false, &statements);
        assert_eq!(items2.len(), 1);
        assert_eq!(items2[0].destroy_column, 0);
    }

    /// A nested function body is analyzed both with the outer one and as its own: the same hit enters findings twice; after dedup
    /// it is reported only once.
    #[test]
    fn nested_body_analyzed_twice_reports_once() {
        let text = "def f(self):\n    def g():\n        self.destroy()\n        self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("def g():", 1, 1, 4),
            stmt("self.destroy()", 2, 2, 8),
            stmt("self.hp", 3, 3, 8),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 3);
        assert_eq!(items[0].character, 8);
    }
}
