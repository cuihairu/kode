//! CodeAction decision core (RUST-143 batch 1): an isomorphic downward
//! port of the editor and decision faces of src/languageProviders/codeAction.ts
//! and the four pure-function modules it depends on (defMethodConsistency /
//! completion / receiverNoneDiagnostics / behaviorLints). Pure library, zero
//! RPC, zero engine state — provider wiring (diagnostic code routing / vscode
//! WorkspaceEdit / l10n) stays in TS, and this module only covers the
//! **computable core** of each action:
//! - stub generation: def_arg_type_to_python_annotation + build_method_stub_code
//!   (signatures and bodies for the two create-missing-implementation providers);
//! - class-block insertion point: find_python_class_insertion_point (shared by
//!   the two providers);
//! - type-replacement candidates: find_registered_type_suggestions (bounded
//!   edit distance);
//! - receiver-range attribution: receiver_from_diagnostic_line (the guard
//!   provider's receiver extraction, UTF-16 coordinate domain);
//! - guard editors: build_receiver_none_guard_edit (early return) /
//!   build_receiver_none_wrap_edit (wrap style, statement-group truncation +
//!   paren balancing);
//! - whole-reassign editor: build_fixed_dict_whole_reassign_edit (idiom
//!   rewrite).
//!
//! golden = {corpus, probes, outcomes}: the corpus (synthetic text,
//! self-contained and deterministic) and the probe surface are authoritatively
//! defined in Rust and produce the outcomes; the TS mirror
//! tests/kodeCodeActionParity.test.ts reads corpus+probes and drives the
//! **production** function to recompute and compare outcomes (a red mirror =
//! a porting mistake, re-derived from the TS source).
//!
//! Coordinate system: the line/character domain is entirely UTF-16 code units
//! (the same domain as TS Range character and regex match.index); text
//! conversion scans after encode_utf16 (the repo has no regex crate, so all
//! regexes are hand-written equivalents).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// def <Arg> type -> Python annotation (isomorphic to defMethodConsistency)
// ---------------------------------------------------------------------------

/// PYTHON_BUILTIN_TYPE_ANNOTATIONS (the same table as the pythonTypeStubs single source of truth).
fn builtin_type_annotation(type_name: &str) -> Option<&'static str> {
    match type_name {
        "UINT8" | "UINT16" | "UINT32" | "UINT64" | "INT8" | "INT16" | "INT32" | "INT64" => {
            Some("int")
        }
        "FLOAT" | "DOUBLE" => Some("float"),
        "STRING" | "UNICODE" => Some("str"),
        "BOOL" => Some("bool"),
        "VECTOR2" => Some("Vector2"),
        "VECTOR3" => Some("Vector3"),
        "VECTOR4" => Some("Vector4"),
        "ENTITYCALL" | "PYTHON" => Some("Any"),
        "PY_DICT" => Some("dict"),
        "PY_TUPLE" => Some("tuple"),
        "PY_LIST" => Some("list"),
        "BLOB" => Some("bytes"),
        _ => None,
    }
}

/// def parameter type text -> Python signature annotation. Only maps **builtin
/// name** annotations (ones that can appear directly in a method signature with
/// no typing import needed; typing generic names such as VECTOR2/3/4/Any need
/// an import, and the skeleton is a pure insertion edit that never touches the
/// file header, so unimported names are not emitted -> None = the caller
/// degrades to a bare argN parameter name).
pub fn def_arg_type_to_python_annotation(type_text: &str) -> Option<&'static str> {
    let trimmed = type_text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let annotation = builtin_type_annotation(trimmed)?;
    // BUILTIN_ANNOTATIONS gate: table values other than int/float/str/bool/bytes
    // (the fixed-length Tuple / Any families) do not enter a signature
    match annotation {
        "int" | "float" | "str" | "bool" | "bytes" => Some(annotation),
        _ => None,
    }
}

/// Stub body shape: pass (empty body) or raise (NotImplementedError).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MethodStubBody {
    Pass,
    Raise,
}

/// Empty-method skeleton (4-space indent): the signature parameters map from
/// <Arg> types (builtin annotations, others bare argN); isomorphic to TS
/// buildMethodStubCode.
pub fn build_method_stub_code(
    method_name: &str,
    arg_types: &[&str],
    body: MethodStubBody,
) -> String {
    let params: Vec<String> = arg_types
        .iter()
        .enumerate()
        .map(
            |(index, type_text)| match def_arg_type_to_python_annotation(type_text) {
                Some(annotation) => format!("arg{}: {}", index, annotation),
                None => format!("arg{}", index),
            },
        )
        .collect();
    let signature = if params.is_empty() {
        "self".to_string()
    } else {
        format!("self, {}", params.join(", "))
    };
    let body_line = match body {
        MethodStubBody::Raise => "        raise NotImplementedError",
        MethodStubBody::Pass => "        pass",
    };
    format!("    def {}({}):\n{}\n", method_name, signature, body_line)
}

// ---------------------------------------------------------------------------
// python class-block insertion point (isomorphic to codeAction.findPythonClassInsertionPoint)
// ---------------------------------------------------------------------------

/// Match `class\s+<name>(\s|\(|:|$)` at the line start (the regex is
/// hand-written; TS interpolates className into the regex, and here the
/// string is exactly equivalent — a class name is an identifier with no regex
/// metacharacter injection surface).
fn class_header_matches(line: &str, class_name: &str) -> bool {
    let units: Vec<u16> = line.encode_utf16().collect();
    if !starts_with_keyword(&units, 0, "class") {
        return false;
    }
    let mut cursor = "class".len();
    let space_start = cursor;
    while cursor < units.len() && is_js_space(units[cursor]) {
        cursor += 1;
    }
    if cursor == space_start {
        return false; // \s+ requires at least one
    }
    let name_units: Vec<u16> = class_name.encode_utf16().collect();
    if units.len() < cursor + name_units.len() {
        return false;
    }
    if units[cursor..cursor + name_units.len()] != name_units[..] {
        return false;
    }
    cursor += name_units.len();
    // (\s|\(|:|$): the next char is whitespace / left paren / colon / line end
    match units.get(cursor) {
        None => true,
        Some(&u) => is_js_space(u) || u == b'(' as u16 || u == b':' as u16,
    }
}

/// Python class-block insertion point (IDE-NAV-014): from after the class
/// header to the first non-empty line with indent <4 is the class body; the
/// insertion point is the line after the last non-empty body line (0-based line
/// number; an empty body = the line after the class header with no blank line
/// prefix, a non-empty body gets one blank line separator). A class block not
/// found -> None (never guesses).
pub fn find_python_class_insertion_point(content: &str, class_name: &str) -> Option<(usize, bool)> {
    let lines = split_lines_keep(content);
    let mut class_line = None;
    for (index, line) in lines.iter().enumerate() {
        if class_header_matches(line, class_name) {
            class_line = Some(index);
            break;
        }
    }
    let class_line = class_line?;
    let mut last_body_line = class_line;
    // TS assigns the real line number (index); blank / comment lines do not advance it
    for (index, line) in lines.iter().enumerate().skip(class_line + 1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = leading_space_tabs(line).len();
        // TS /^\s*/ counts leading whitespace (\t counts as 1); indent <4 means leaving the body
        if indent < 4 {
            break;
        }
        last_body_line = index;
    }
    Some((last_body_line + 1, last_body_line > class_line))
}

// ---------------------------------------------------------------------------
// Type-replacement candidates (isomorphic to completion.findRegisteredTypeSuggestions)
// ---------------------------------------------------------------------------

pub const TYPE_SUGGESTION_MAX_DISTANCE: usize = 2;
pub const TYPE_SUGGESTION_LIMIT: usize = 5;

/// Bounded edit distance (column DP + row-min early exit; >max -> None).
/// Isomorphic to TS boundedEditDistance (UTF-16 code-unit domain; when type
/// names are all ASCII this matches the byte domain).
pub fn bounded_edit_distance(left: &str, right: &str, max: usize) -> Option<usize> {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    if left.len().abs_diff(right.len()) > max {
        return None;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for row in 1..=left.len() {
        let mut current = vec![row];
        let mut row_min = row;
        for column in 1..=right.len() {
            let substitution =
                previous[column - 1] + usize::from(left[row - 1] != right[column - 1]);
            let cost = substitution
                .min(previous[column] + 1)
                .min(current[column - 1] + 1);
            current.push(cost);
            row_min = row_min.min(cost);
        }
        if row_min > max {
            return None;
        }
        previous = current;
    }
    let distance = previous[right.len()];
    if distance > max {
        None
    } else {
        Some(distance)
    }
}

/// Correction candidates for the unregistered-type diagnostic: registered types
/// (builtins + types.xml customs + entities) sorted by distance ascending, ties
/// broken by name byte order, truncated to TYPE_SUGGESTION_LIMIT; a name equal
/// to the original text is skipped.
pub fn find_registered_type_suggestions(unknown_name: &str, registered: &[&str]) -> Vec<String> {
    let target = unknown_name.to_lowercase();
    let mut hits: Vec<(String, usize)> = Vec::new();
    for candidate in registered {
        if *candidate == unknown_name {
            continue;
        }
        let Some(distance) = bounded_edit_distance(
            &target,
            &candidate.to_lowercase(),
            TYPE_SUGGESTION_MAX_DISTANCE,
        ) else {
            continue;
        };
        hits.push(((*candidate).to_string(), distance));
    }
    hits.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    hits.truncate(TYPE_SUGGESTION_LIMIT);
    hits.into_iter().map(|(name, _)| name).collect()
}

// ---------------------------------------------------------------------------
// Receiver-range attribution (isomorphic to codeAction.receiverFromDiagnosticLine)
// ---------------------------------------------------------------------------

/// `self.<cell|base|client>.<method>` scan: take the receiver whose method-name
/// token intersects the diagnostic range `[start_char, end_char)`; cannot be
/// extracted -> None (never guesses). The coordinate domain is UTF-16 code
/// units (the diagnostic range uses the same domain).
pub fn receiver_from_diagnostic_line(
    line_text: &str,
    start_char: usize,
    end_char: usize,
) -> Option<&'static str> {
    let units: Vec<u16> = line_text.encode_utf16().collect();
    let mut cursor = 0usize;
    while cursor < units.len() {
        // \bself\. : word boundary (previous char is not a word char, or line start) + literal self.
        if !starts_with_keyword(&units, cursor, "self.")
            || (cursor > 0 && is_word_unit(units[cursor - 1]))
        {
            cursor += 1;
            continue;
        }
        let mut after_self = cursor + "self.".len();
        // receiver word (cell|base|client)
        let receiver = ["cell", "base", "client"]
            .into_iter()
            .find(|word| starts_with_keyword(&units, after_self, word));
        let Some(receiver) = receiver else {
            cursor += 1;
            continue;
        };
        after_self += receiver.len();
        // \s*\.\s*
        while after_self < units.len() && is_js_space(units[after_self]) {
            after_self += 1;
        }
        if units.get(after_self) != Some(&(b'.' as u16)) {
            cursor += 1;
            continue;
        }
        after_self += 1;
        while after_self < units.len() && is_js_space(units[after_self]) {
            after_self += 1;
        }
        // method name [A-Za-z_][A-Za-z0-9_]*
        if !units.get(after_self).copied().is_some_and(is_name_start) {
            cursor += 1;
            continue;
        }
        let method_start = after_self;
        let mut method_end = method_start + 1;
        while method_end < units.len() && is_word_unit(units[method_end]) {
            method_end += 1;
        }
        // Range-intersection attribution (TS: startChar < methodEnd && endChar > methodStart)
        if start_char < method_end && end_char > method_start {
            return Some(match receiver {
                "cell" => "cell",
                "base" => "base",
                _ => "client",
            });
        }
        cursor = method_end;
    }
    None
}

// ---------------------------------------------------------------------------
// Guard editors (isomorphic to receiverNoneDiagnostics)
// ---------------------------------------------------------------------------

/// Early-return guard insertion edit (two lines inserted before the line
/// start): `if not self.<receiver>:` + an indented return. An out-of-range or
/// empty line -> None.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverNoneGuardEdit {
    pub line: usize,
    pub text: String,
}

/// Wrap-style guard replacement edit: `if self.<receiver>:` wraps "the
/// consecutive statements that use this receiver" (including multi-line
/// continuations, where an unclosed bracket is not interrupted by blank lines /
/// comments; the group truncates at the first sibling statement that does not
/// reference this receiver), with the whole block indented one extra level
/// (relative depth preserved).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverNoneWrapEdit {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

fn is_js_space(code: u16) -> bool {
    // The full JS \s set (Space \t \n \v \f \r NBSP); after splitting, a line
    // contains no \n \r,
    // listed here only to stay in the same domain as the regex semantics; it changes no in-line decision.
    matches!(
        code,
        0x0020 | 0x0009 | 0x000A | 0x000D | 0x000C | 0x000B | 0x00A0
    )
}

fn is_word_unit(code: u16) -> bool {
    code == b'_' as u16
        || (b'a' as u16..=b'z' as u16).contains(&code)
        || (b'A' as u16..=b'Z' as u16).contains(&code)
        || (b'0' as u16..=b'9' as u16).contains(&code)
}

fn is_name_start(code: u16) -> bool {
    code == b'_' as u16
        || (b'a' as u16..=b'z' as u16).contains(&code)
        || (b'A' as u16..=b'Z' as u16).contains(&code)
}

fn starts_with_keyword(units: &[u16], at: usize, word: &str) -> bool {
    let word: Vec<u16> = word.encode_utf16().collect();
    units.len() >= at + word.len() && units[at..at + word.len()] == word[..]
}

/// Isomorphic to TS split(/\r?\n/) (keeps empty lines; a line contains no newline).
fn split_lines_keep(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch == '\n' {
            if current.ends_with('\r') {
                current.pop();
            }
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    lines.push(current);
    lines
}

/// Leading whitespace of a line (isomorphic to TS /^[ \t]*/; byte = unit = char since the prefix is all ASCII).
fn leading_space_tabs(line: &str) -> &str {
    let byte_end = line
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    &line[..byte_end]
}

/// TS indentOf: lineText.length - trimStart().length = the leading whitespace count (UTF-16 unit domain).
fn indent_of(line: &str) -> usize {
    let units: Vec<u16> = line.encode_utf16().collect();
    units.iter().take_while(|u| is_js_space(**u)).count()
}

/// Comment line or empty line (isomorphic to TS /^\s*(#.*)?$/: all whitespace, or whitespace prefix then # to end of line).
fn comment_only(line: &str) -> bool {
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut seen_content = false;
    for unit in &units {
        if is_js_space(*unit) {
            continue;
        }
        if !seen_content {
            if *unit == b'#' as u16 {
                return true;
            }
            seen_content = true;
        }
    }
    !seen_content
}

/// In-line unclosed-bracket delta (the continuation test).
fn delimiter_delta(line: &str) -> isize {
    let mut delta = 0isize;
    for ch in line.chars() {
        match ch {
            '(' | '[' | '{' => delta += 1,
            ')' | ']' | '}' => delta -= 1,
            _ => {}
        }
    }
    delta
}

/// In-line `\bself\.<receiver>\b` (the wrap-style statement-group truncation criterion; hand-written scan).
fn line_references_receiver(line: &str, receiver: &str) -> bool {
    let units: Vec<u16> = line.encode_utf16().collect();
    let needle: Vec<u16> = format!("self.{}", receiver).encode_utf16().collect();
    let mut cursor = 0usize;
    while cursor + needle.len() <= units.len() {
        if units[cursor..cursor + needle.len()] == needle[..]
            && (cursor == 0 || !is_word_unit(units[cursor - 1]))
            && (cursor + needle.len() == units.len() || !is_word_unit(units[cursor + needle.len()]))
        {
            return true;
        }
        cursor += 1;
    }
    false
}

pub fn build_receiver_none_guard_edit(
    text: &str,
    line: usize,
    receiver: &str,
) -> Option<ReceiverNoneGuardEdit> {
    if text.is_empty() {
        return None;
    }
    let lines = split_lines_keep(text);
    let use_line = lines.get(line)?;
    if use_line.trim().is_empty() {
        return None;
    }
    let leading = leading_space_tabs(use_line);
    let inner = if leading.contains('\t') {
        format!("{}\t", leading)
    } else {
        format!("{}    ", leading)
    };
    Some(ReceiverNoneGuardEdit {
        line,
        text: format!("{}if not self.{}:\n{}return\n", leading, receiver, inner),
    })
}

pub fn build_receiver_none_wrap_edit(
    text: &str,
    line: usize,
    receiver: &str,
) -> Option<ReceiverNoneWrapEdit> {
    if text.is_empty() {
        return None;
    }
    let lines = split_lines_keep(text);
    let use_line = lines.get(line)?;
    if use_line.trim().is_empty() {
        return None;
    }
    let leading = leading_space_tabs(use_line);
    let inner = if leading.contains('\t') {
        format!("{}\t", leading)
    } else {
        format!("{}    ", leading)
    };
    let use_indent = indent_of(use_line);
    // Statement-group truncation: wrap only "the consecutive statements that use
    // this receiver" (continuation lines with an unclosed bracket are not
    // interrupted by blank lines / comments; stop at the first sibling
    // statement that does not reference this receiver)
    let mut end = line + 1;
    let mut balance = delimiter_delta(use_line);
    while end < lines.len() {
        let current = &lines[end];
        if comment_only(current) {
            // Inside a multi-statement continuation, blank lines / comments do not interrupt; otherwise the statement group ends
            if balance > 0 {
                end += 1;
                continue;
            }
            break;
        }
        if indent_of(current) < use_indent {
            break;
        }
        if !line_references_receiver(current, receiver) && balance <= 0 {
            break;
        }
        balance += delimiter_delta(current);
        end += 1;
    }
    let leading_units: Vec<u16> = leading.encode_utf16().collect();
    let body: Vec<String> = lines[line..end]
        .iter()
        .map(|entry| {
            if comment_only(entry) {
                entry.clone()
            } else {
                let units: Vec<u16> = entry.encode_utf16().collect();
                format!(
                    "{}{}",
                    inner,
                    String::from_utf16_lossy(&units[leading_units.len()..])
                )
            }
        })
        .collect();
    Some(ReceiverNoneWrapEdit {
        start_line: line,
        end_line: end,
        text: format!("{}if self.{}:\n{}", leading, receiver, body.join("\n")),
    })
}

// ---------------------------------------------------------------------------
// Whole-reassign editor (isomorphic to behaviorLints.buildFixedDictWholeReassignEdit)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedDictWholeReassignEdit {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

/// `^([ \t]*)(self\.[A-Za-z_]\w*)((?:\s*\[[^\]\n]*\]\s*)+)(?:(\*\*|//|>>|<<|
/// [+\-*/%&|^]))?=(?!=)(.*)$` hand-written equivalent: leading whitespace ->
/// self. identifier -> one or more subscript groups (from `[` to `]` with no
/// `]` or newline inside, whitespace allowed between groups) -> optional
/// operator (**|//|>>|<<| single char) -> `=` (next char is not `=`) -> the
/// rest is captured (to end of line).
fn match_subscript_store_line(
    line: &str,
) -> Option<(String, String, String, Option<String>, String)> {
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut cursor = 0usize;
    // leading whitespace
    let indent_start = cursor;
    while cursor < units.len() && (units[cursor] == b' ' as u16 || units[cursor] == b'\t' as u16) {
        cursor += 1;
    }
    let indent = String::from_utf16_lossy(&units[indent_start..cursor]);
    // self. (TS capture group 2 includes the self. prefix)
    if !starts_with_keyword(&units, cursor, "self.") {
        return None;
    }
    let base_start = cursor;
    cursor += "self.".len();
    // identifier
    if !units.get(cursor).copied().is_some_and(is_name_start) {
        return None;
    }
    cursor += 1;
    while cursor < units.len() && is_word_unit(units[cursor]) {
        cursor += 1;
    }
    let base = String::from_utf16_lossy(&units[base_start..cursor]);
    // one or more groups of (\s* \[ [^\]\n]* \] \s*)
    let subscripts_start = cursor;
    let mut groups = 0usize;
    loop {
        let group_start = cursor;
        while cursor < units.len() && is_js_space(units[cursor]) {
            cursor += 1;
        }
        if units.get(cursor) != Some(&(b'[' as u16)) {
            cursor = group_start;
            break;
        }
        cursor += 1;
        while cursor < units.len() && units[cursor] != b']' as u16 && units[cursor] != b'\n' as u16
        {
            cursor += 1;
        }
        if units.get(cursor) != Some(&(b']' as u16)) {
            cursor = group_start;
            break;
        }
        cursor += 1;
        while cursor < units.len() && is_js_space(units[cursor]) {
            cursor += 1;
        }
        groups += 1;
    }
    if groups == 0 {
        return None;
    }
    // Trailing whitespace trim (TS subscripts.replace(/\s+$/, '') done on the captured string)
    let mut subscripts_end = cursor;
    while subscripts_end > subscripts_start && is_js_space(units[subscripts_end - 1]) {
        subscripts_end -= 1;
    }
    let subscripts = String::from_utf16_lossy(&units[subscripts_start..subscripts_end]);
    // optional operator (two-char ops first)
    let mut operator = None;
    for two in ["**", "//", ">>", "<<"] {
        if starts_with_keyword(&units, cursor, two) {
            operator = Some((*two).to_string());
            cursor += 2;
            break;
        }
    }
    if operator.is_none() {
        if let Some(&u) = units.get(cursor) {
            let ch = char::from_u32(u as u32);
            if ch.is_some_and(|c| "+-*/%&|^".contains(c)) {
                operator = Some(ch.unwrap().to_string());
                cursor += 1;
            }
        }
    }
    // = (next char is not =)
    if units.get(cursor) != Some(&(b'=' as u16)) {
        return None;
    }
    if units.get(cursor + 1) == Some(&(b'=' as u16)) {
        return None;
    }
    cursor += 1;
    // The rest is captured ($: must already reach end of line — .*)$ is greedy
    // to the end, so anything remaining goes into the rhs)
    let rhs = String::from_utf16_lossy(&units[cursor..]);
    Some((indent, base, subscripts, operator, rhs))
}

pub fn build_fixed_dict_whole_reassign_edit(
    text: &str,
    line: usize,
) -> Option<FixedDictWholeReassignEdit> {
    if text.is_empty() {
        return None;
    }
    let lines = split_lines_keep(text);
    let source = lines.get(line)?;
    if source.trim().is_empty() {
        return None;
    }
    let (indent, base, subscripts, operator, rhs) = match_subscript_store_line(source)?;
    let tail = rhs.trim();
    Some(FixedDictWholeReassignEdit {
        start_line: line,
        end_line: line + 1,
        text: format!(
            "{}_fd = {}\n{}_fd{} {}= {}\n{}{} = _fd",
            indent,
            base,
            indent,
            subscripts,
            operator.as_deref().unwrap_or(""),
            tail,
            indent,
            base
        ),
    })
}

// ---------------------------------------------------------------------------
// golden corpus and replay
// ---------------------------------------------------------------------------

/// Synthetic corpus entry (self-contained and deterministic; covers boundary shapes of the editors and the insertion point).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusEntry {
    pub name: String,
    pub text: String,
}

/// Probe surface (authoritative definition; the TS mirror drives the matching production function per face).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum Probe {
    /// Class-block insertion point
    Insertion { corpus: String, class_name: String },
    /// Method skeleton
    Stub {
        method_name: String,
        arg_types: Vec<String>,
        body: MethodStubBody,
    },
    /// Type-replacement candidates
    Suggestions {
        unknown: String,
        registered: Vec<String>,
    },
    /// Receiver-range attribution
    ReceiverFace {
        corpus: String,
        line: usize,
        start_char: usize,
        end_char: usize,
    },
    /// Early-return guard edit
    GuardEdit {
        corpus: String,
        line: usize,
        receiver: String,
    },
    /// Wrap-style guard edit
    WrapEdit {
        corpus: String,
        line: usize,
        receiver: String,
    },
    /// Whole-reassign edit
    FdEdit { corpus: String, line: usize },
}

/// Probe output (one-to-one with Probe; the tag=face shape matches).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum ProbeOutcome {
    Insertion {
        result: Option<InsertionPoint>,
    },
    Stub {
        code: String,
    },
    Suggestions {
        hits: Vec<String>,
    },
    ReceiverFace {
        receiver: Option<&'static str>,
    },
    GuardEdit {
        edit: Option<ReceiverNoneGuardEdit>,
    },
    WrapEdit {
        edit: Option<ReceiverNoneWrapEdit>,
    },
    FdEdit {
        edit: Option<FixedDictWholeReassignEdit>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertionPoint {
    /// Insertion line (0-based)
    pub line: usize,
    /// Non-empty body = true (the edit text needs a leading blank line)
    pub blank_prefix: bool,
}

pub fn run_probe(corpus: &BTreeMap<String, CorpusEntry>, probe: &Probe) -> ProbeOutcome {
    match probe {
        Probe::Insertion {
            corpus: name,
            class_name,
        } => {
            let entry = corpus.get(name).expect("corpus entry exists");
            ProbeOutcome::Insertion {
                result: find_python_class_insertion_point(&entry.text, class_name)
                    .map(|(line, blank_prefix)| InsertionPoint { line, blank_prefix }),
            }
        }
        Probe::Stub {
            method_name,
            arg_types,
            body,
        } => {
            let refs: Vec<&str> = arg_types.iter().map(String::as_str).collect();
            ProbeOutcome::Stub {
                code: build_method_stub_code(method_name, &refs, *body),
            }
        }
        Probe::Suggestions {
            unknown,
            registered,
        } => {
            let refs: Vec<&str> = registered.iter().map(String::as_str).collect();
            ProbeOutcome::Suggestions {
                hits: find_registered_type_suggestions(unknown, &refs),
            }
        }
        Probe::ReceiverFace {
            corpus: name,
            line,
            start_char,
            end_char,
        } => {
            let entry = corpus.get(name).expect("corpus entry exists");
            let lines = split_lines_keep(&entry.text);
            let line_text = lines.get(*line).map(String::as_str).unwrap_or("");
            ProbeOutcome::ReceiverFace {
                receiver: receiver_from_diagnostic_line(line_text, *start_char, *end_char),
            }
        }
        Probe::GuardEdit {
            corpus: name,
            line,
            receiver,
        } => {
            let entry = corpus.get(name).expect("corpus entry exists");
            ProbeOutcome::GuardEdit {
                edit: build_receiver_none_guard_edit(&entry.text, *line, receiver),
            }
        }
        Probe::WrapEdit {
            corpus: name,
            line,
            receiver,
        } => {
            let entry = corpus.get(name).expect("corpus entry exists");
            ProbeOutcome::WrapEdit {
                edit: build_receiver_none_wrap_edit(&entry.text, *line, receiver),
            }
        }
        Probe::FdEdit { corpus: name, line } => {
            let entry = corpus.get(name).expect("corpus entry exists");
            ProbeOutcome::FdEdit {
                edit: build_fixed_dict_whole_reassign_edit(&entry.text, *line),
            }
        }
    }
}

/// Synthetic corpus (authoritative definition; each family's boundary shapes covered).
pub fn corpus() -> Vec<CorpusEntry> {
    vec![
        CorpusEntry {
            name: "class-basic".into(),
            text: "class Avatar:\n    def onEnterSpace(self, baseEntity):\n        pass\n\n    def onLeaveSpace(self, baseEntity):\n        pass\n\nclass Monster:\n    pass\n".into(),
        },
        CorpusEntry {
            name: "class-nested-comment-blank".into(),
            text: "class Tower:\n\n    # comment inside body\n\n    def shoot(self):\n        pass\n\n        # deeper comment\n        return 0\n\nclass Empty:\nclass Tail:\n    x = 1\n".into(),
        },
        CorpusEntry {
            name: "class-crlf-tabs".into(),
            text: "class Gate:\r\n\tdef open(self):\r\n\t\tpass\r\n\tdef close(self):\r\n\t\tpass\r\n\r\nclass After:\r\n\tpass\r\n".into(),
        },
        CorpusEntry {
            name: "guard-shapes".into(),
            text: "    def onUse(self):\n        self.cell.useItem(1)\n        self.cell.recharge(2, True)\n        # idle comment\n\n        self.base.report(\"done\")\n        if self.client.ready(\n            1,\n            2,\n        ):\n            self.client.play()\n        self.cell.sync()\n        deeper = self.cell.lookup(\n            # comment inside call\n            42,\n        )\n        self.base.notify()\n".into(),
        },
        CorpusEntry {
            name: "receiver-two-oneline".into(),
            text: "        self.cell.pickup(); self.base.drop()\n        return\n".into(),
        },
        CorpusEntry {
            name: "fd-shapes".into(),
            text: "_fd = self.attr\nself.profile[\"name\"] = \"张三\"\nself.grid[0][1] = 5\nself.count += 1\nself.count+=1\nself.m[ \"k\" ] = v\nself.m[\"k\"] == v\nself.total **= 2\nself.ratio //= 3\nself.bits |= mask\nself.n[\"a\"] =\nself.m[\"k\"] = 值 + 1\n        self.deep[\"x\"] = 1\nself.plain = 3\n".into(),
        },
        CorpusEntry {
            name: "cjk-receiver".into(),
            text: "        # 中文注释:self.cell 假前缀\n        self.cell.攻击(\"怪\")\n        self.base.撤退()\n".into(),
        },
        CorpusEntry {
            name: "class-eof-header".into(),
            text: "class Lonely:".into(),
        },
        CorpusEntry {
            name: "wrap-eof-blank-comment".into(),
            text: "def f():\n    self.base.save(x,\n\n    # trailing comment in call\n    y)\n    self.base.flush()\n".into(),
        },
        CorpusEntry {
            name: "indent-dedent".into(),
            text: "    if True:\n        self.cell.a()\n    self.base.b()\n        self.cell.c()\n".into(),
        },
        CorpusEntry {
            name: "tabs-guard".into(),
            text: "\tdef m(self):\n\t\tself.cell.hit(1)\n\t\tself.base.miss(2)\n".into(),
        },
    ]
}

/// Class-name probe table (per corpus: several real in-body names + missing names).
pub fn insertion_probes(entries: &[CorpusEntry]) -> Vec<Probe> {
    let mut probes = Vec::new();
    let known: BTreeMap<&str, Vec<&str>> = BTreeMap::from([
        (
            "class-basic",
            vec!["Avatar", "Monster", "NotFound", "Avata"],
        ),
        (
            "class-nested-comment-blank",
            vec!["Tower", "Empty", "Tail", "NotFound"],
        ),
        ("class-crlf-tabs", vec!["Gate", "After", "NotFound"]),
        ("class-eof-header", vec!["Lonely", "NotFound"]),
    ]);
    for entry in entries {
        let Some(names) = known.get(entry.name.as_str()) else {
            continue;
        };
        for name in names {
            probes.push(Probe::Insertion {
                corpus: entry.name.clone(),
                class_name: (*name).to_string(),
            });
        }
    }
    probes
}

/// Skeleton probes (full-table scan of parameter types + unknown + whitespace trim + empty table; both body shapes).
pub fn stub_probes() -> Vec<Probe> {
    let full_table = [
        "UINT8",
        "UINT16",
        "UINT32",
        "UINT64",
        "INT8",
        "INT16",
        "INT32",
        "INT64",
        "FLOAT",
        "DOUBLE",
        "STRING",
        "UNICODE",
        "BOOL",
        "VECTOR2",
        "VECTOR3",
        "VECTOR4",
        "ENTITYCALL",
        "PYTHON",
        "PY_DICT",
        "PY_TUPLE",
        "PY_LIST",
        "BLOB",
    ];
    let mut probes = Vec::new();
    for body in [MethodStubBody::Pass, MethodStubBody::Raise] {
        probes.push(Probe::Stub {
            method_name: "noArgs".into(),
            arg_types: vec![],
            body,
        });
        probes.push(Probe::Stub {
            method_name: "fullSweep".into(),
            arg_types: full_table.iter().map(|s| s.to_string()).collect(),
            body,
        });
        probes.push(Probe::Stub {
            method_name: "mixed".into(),
            arg_types: vec![
                "UINT32".into(),
                "UNKNOWN_TYPE".into(),
                "  UINT16  ".into(),
                "".into(),
                "py_dict".into(),
                "VECTOR3".into(),
            ],
            body,
        });
        probes.push(Probe::Stub {
            method_name: "lowercaseUnknown".into(),
            arg_types: vec!["string".into(), "bool".into()],
            body,
        });
    }
    probes
}

/// Type-candidate probes (casing / distance boundary / tie ordering / truncation).
pub fn suggestion_probes() -> Vec<Probe> {
    let registered = [
        "Avatar",
        "Avatar2",
        "AvatarProxy",
        "Monster",
        "NPC",
        "MailBox",
        "ACCOUNT",
    ];
    let unknowns = [
        "Avtar", "avatar", "AVATAR", "Avatar22", "Monstr", "NCP", "Mailbox", "accout", "XYZQW", "",
        "Avatar",
    ];
    let mut probes = Vec::new();
    for unknown in unknowns {
        probes.push(Probe::Suggestions {
            unknown: unknown.to_string(),
            registered: registered.iter().map(|s| s.to_string()).collect(),
        });
    }
    probes.push(Probe::Suggestions {
        unknown: "LongName".into(),
        registered: vec![
            "LongNam".into(),
            "longnameX".into(),
            "LonName".into(),
            "xxxxxxxxxx".into(),
        ],
    });
    probes
}

/// Line-level probes: guard/wrap/receiverFace/fdEdit over a line x receiver / range grid.
pub fn line_probes(entries: &[CorpusEntry]) -> Vec<Probe> {
    let mut probes = Vec::new();
    let receivers = ["cell", "base", "client"];
    for entry in entries {
        let lines = split_lines_keep(&entry.text);
        for (line, _entry_line) in lines.iter().enumerate() {
            for receiver in receivers {
                probes.push(Probe::GuardEdit {
                    corpus: entry.name.clone(),
                    line,
                    receiver: receiver.to_string(),
                });
                probes.push(Probe::WrapEdit {
                    corpus: entry.name.clone(),
                    line,
                    receiver: receiver.to_string(),
                });
            }
            probes.push(Probe::FdEdit {
                corpus: entry.name.clone(),
                line,
            });
            // Receiver-range attribution: full line + sliding window (step 3, width 2; within 60 units of the first line)
            let units: usize = lines[line].encode_utf16().count();
            probes.push(Probe::ReceiverFace {
                corpus: entry.name.clone(),
                line,
                start_char: 0,
                end_char: units,
            });
            let mut start = 0usize;
            while start + 2 <= units && start < 90 {
                probes.push(Probe::ReceiverFace {
                    corpus: entry.name.clone(),
                    line,
                    start_char: start,
                    end_char: start + 2,
                });
                start += 3;
            }
        }
    }
    probes
}

/// The authoritative probe set.
pub fn probes() -> (BTreeMap<String, CorpusEntry>, Vec<Probe>) {
    let entries = corpus();
    let table: BTreeMap<String, CorpusEntry> = entries
        .iter()
        .map(|entry| (entry.name.clone(), entry.clone()))
        .collect();
    let mut all = Vec::new();
    all.extend(insertion_probes(&entries));
    all.extend(stub_probes());
    all.extend(suggestion_probes());
    all.extend(line_probes(&entries));
    (table, all)
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeActionGolden {
    pub generator: &'static str,
    pub corpus: Vec<CorpusEntry>,
    pub probes: Vec<Probe>,
    pub outcomes: Vec<ProbeOutcome>,
}

pub const CODE_ACTION_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/code-action-parity.json";

/// golden generation (pure JSON with no trailing newline; the bin side adds println).
pub fn dump_code_action_golden() -> String {
    let (table, probes) = probes();
    let outcomes: Vec<ProbeOutcome> = probes
        .iter()
        .map(|probe| run_probe(&table, probe))
        .collect();
    let golden = CodeActionGolden {
        generator: "dump-code-action-golden",
        corpus: corpus(),
        probes,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

// ---------------------------------------------------------------------------
// Unit pins (guard against the golden being a self-consistent tautology)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotation_builtin_gate() {
        // a table value but not in the builtin-annotation family -> None (typing generics do not enter signatures)
        assert_eq!(def_arg_type_to_python_annotation("UINT32"), Some("int"));
        assert_eq!(def_arg_type_to_python_annotation(" VECTOR3 "), None);
        assert_eq!(def_arg_type_to_python_annotation("PY_DICT"), None);
        assert_eq!(def_arg_type_to_python_annotation("BLOB"), Some("bytes"));
        assert_eq!(def_arg_type_to_python_annotation("py_dict"), None);
        assert_eq!(def_arg_type_to_python_annotation(""), None);
    }

    #[test]
    fn stub_signature_shape() {
        assert_eq!(
            build_method_stub_code("shoot", &["UINT32", "UNKNOWN"], MethodStubBody::Raise),
            "    def shoot(self, arg0: int, arg1):\n        raise NotImplementedError\n"
        );
        assert_eq!(
            build_method_stub_code("plain", &[], MethodStubBody::Pass),
            "    def plain(self):\n        pass\n"
        );
    }

    #[test]
    fn insertion_point_body_boundary() {
        // line 0 = class A, line 1 = last non-empty body line -> insertion point line 2
        // (blank line 2 still exists, so the skeleton with a blank-line prefix
        // lands before it)
        let text = "class A:\n    x = 1\n\nclass B:\n    y = 2\n";
        assert_eq!(
            find_python_class_insertion_point(text, "A"),
            Some((2, true))
        );
        assert_eq!(
            find_python_class_insertion_point(text, "B"),
            Some((5, true))
        );
        assert_eq!(find_python_class_insertion_point(text, "Missing"), None);
        // empty body = the line after the class header and no blank-line prefix
        assert_eq!(
            find_python_class_insertion_point("class C:", "C"),
            Some((1, false))
        );
        // next char is not a word char: Avat does not recognize the Avatar line
        assert_eq!(
            find_python_class_insertion_point("class Avatar:\n    pass\n", "Avat"),
            None
        );
        // blank line separating body lines: last body line = actual index 3 (a naive counter would wrongly give 2; the prove-red target)
        assert_eq!(
            find_python_class_insertion_point(
                "class A:\n    x = 1\n\n    y = 2\n\nclass B:\n",
                "A"
            ),
            Some((4, true))
        );
    }

    #[test]
    fn suggestions_distance_and_order() {
        let registered = vec!["Avatar", "Avatar2", "Monster", "NPC"];
        // distance ascending, ties by name byte order; all within the bound are kept (Avtar->Avatar distance 1, Avatar2 distance 2)
        assert_eq!(
            find_registered_type_suggestions("Avtar", &registered),
            vec!["Avatar", "Avatar2"]
        );
        assert_eq!(
            find_registered_type_suggestions("avatar", &registered),
            vec!["Avatar", "Avatar2"]
        );
        // equal to the original text is skipped
        assert_eq!(
            find_registered_type_suggestions("NPC", &registered),
            Vec::<String>::new()
        );
        // outside the distance bound (length diff > 2) is not kept
        assert_eq!(
            find_registered_type_suggestions("TotallyDifferent", &registered),
            Vec::<String>::new()
        );
    }

    #[test]
    fn receiver_interval_attribution() {
        let line = "        self.cell.pickup(); self.base.drop()";
        // method-name token range attribution; two receivers on the same line do not bleed into each other
        let units: Vec<u16> = line.encode_utf16().collect();
        let find = |needle: &str| {
            let n: Vec<u16> = needle.encode_utf16().collect();
            units
                .windows(n.len())
                .position(|w| *w == n[..])
                .map(|p| (p, p + n.len()))
        };
        let (s, e) = find("pickup").unwrap();
        assert_eq!(receiver_from_diagnostic_line(line, s, e), Some("cell"));
        let (s, e) = find("drop").unwrap();
        assert_eq!(receiver_from_diagnostic_line(line, s, e), Some("base"));
        // wide range = attribution by the first intersecting
        assert_eq!(
            receiver_from_diagnostic_line(line, 0, units.len()),
            Some("cell")
        );
        // word boundary: xself. is not recognized
        assert_eq!(receiver_from_diagnostic_line("xself.cell.a()", 0, 12), None);
        // CJK line: a Chinese method name (identifier start is non-ASCII -> not recognized, never guesses)
        assert_eq!(
            receiver_from_diagnostic_line("self.cell.攻击()", 0, 16),
            None
        );
    }

    #[test]
    fn guard_edit_shape_and_blank_refusal() {
        let text = "    self.cell.a()\n\n    self.base.b()\n";
        let edit = build_receiver_none_guard_edit(text, 0, "cell").unwrap();
        assert_eq!(edit.line, 0);
        assert_eq!(edit.text, "    if not self.cell:\n        return\n");
        // empty lines produce nothing
        assert_eq!(build_receiver_none_guard_edit(text, 1, "cell"), None);
        assert_eq!(build_receiver_none_guard_edit(text, 99, "cell"), None);
        assert_eq!(build_receiver_none_guard_edit("", 0, "cell"), None);
        // tab leading: inner is leading + \t
        let tabs = "\tself.cell.a()";
        let edit = build_receiver_none_guard_edit(tabs, 0, "cell").unwrap();
        assert_eq!(edit.text, "\tif not self.cell:\n\t\treturn\n");
    }

    #[test]
    fn wrap_edit_truncates_statement_group() {
        // truncates at the first sibling statement not referencing the receiver; blank lines / comments inside a bracketed continuation do not interrupt
        let text = "    self.cell.a()\n    self.base.b()\n";
        let edit = build_receiver_none_wrap_edit(text, 0, "cell").unwrap();
        assert_eq!(edit.start_line, 0);
        assert_eq!(edit.end_line, 1);
        // TS join has no trailing newline (the provider handles the trailingNewline face)
        assert_eq!(edit.text, "    if self.cell:\n        self.cell.a()");
        // bracketed continuation: comments / blank lines do not interrupt; after closing, a sibling not referencing stops it
        let multi = "    self.cell.x(\n\n    # c\n    1)\n    self.base.b()\n";
        let edit = build_receiver_none_wrap_edit(multi, 0, "cell").unwrap();
        assert_eq!(edit.end_line, 4);
        assert!(edit.text.contains("        1)"));
    }

    #[test]
    fn fd_edit_requires_subscripts_and_bare_eq() {
        let text = "self.m[\"k\"] = v\nself.count += 1\nself.m[\"k\"] == v\nself.plain = 3\n";
        let edit = build_fixed_dict_whole_reassign_edit(text, 0).unwrap();
        assert_eq!(edit.text, "_fd = self.m\n_fd[\"k\"] = v\nself.m = _fd");
        // no subscript, not recognized
        assert_eq!(build_fixed_dict_whole_reassign_edit(text, 1), None);
        assert_eq!(build_fixed_dict_whole_reassign_edit(text, 2), None);
        assert_eq!(build_fixed_dict_whole_reassign_edit(text, 3), None);
        // operator variants (with a subscript group; without one, e.g. self.total **= 2, both ends are None)
        let pow = "self.m[\"k\"] **= 2";
        let edit = build_fixed_dict_whole_reassign_edit(pow, 0).unwrap();
        assert!(edit.text.contains("_fd[\"k\"] **= 2"), "{}", edit.text);
        assert_eq!(
            build_fixed_dict_whole_reassign_edit("self.total **= 2", 0),
            None
        );
        // operator with no subscript right after: the required group rejects (deleting the guard would turn it Some; the prove-red target)
        assert_eq!(
            build_fixed_dict_whole_reassign_edit("self.count+=1", 0),
            None
        );
    }
}
