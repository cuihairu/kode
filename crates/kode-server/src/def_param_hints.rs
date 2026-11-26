//! def function parameter inlay decision core (RUST-144 batch 1): an
//! isomorphic descent of src/defParamInlayHints.ts — path section detection
//! (inferMethodSectionFromPythonFile) → file parsing (parsePythonFile's
//! class/method surface) → single-line def parsing (parseDefLine) → parameter
//! splitting (splitParams) → inlay item pairing (buildDefParamInlayItems).
//! A pure library with zero RPC; type annotation resolution uses the built-in
//! direct-lookup face (workspaceRoot='' context, isomorphic to
//! resolveEntityAnnotationType's empty-registry branch); the types.xml/alias.xml
//! registry snapshot chain stays in TS (an honest boundary, batch 2). The text
//! coordinate domain is the UTF-16 code unit (the same domain as the TS [col]
//! index and regex match.index); all regexes are hand-written (the repo has no
//! regex crate); provider wiring (switch / EntityMappingManager query / visible
//! range filtering / vscode.InlayHint construction) stays in TS.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Path identity normalization (isomorphic to pathIdentity.normalizeFileIdentity)
// ---------------------------------------------------------------------------

/// File identity key: POSIX case is preserved, Windows drive letters and UNC
/// paths are case-insensitive; `..` is folded lexically (the drive root / UNC
/// boundary cannot be popped).
pub fn normalize_file_identity(file_path: &str) -> String {
    let raw = file_path.replace('\\', "/");
    let unc = raw.starts_with("//");
    let prefix = if unc {
        "//".to_string()
    } else if raw.starts_with('/') {
        "/".to_string()
    } else {
        String::new()
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            let last = parts.last().copied();
            let last_is_drive_root = last.is_some_and(|p| {
                p.len() == 2 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic()
            });
            let unc_floor = if unc { 2 } else { 0 };
            if parts.len() > unc_floor && last != Some("..") && !last_is_drive_root {
                parts.pop();
                continue;
            }
            if (!prefix.is_empty() && parts.len() <= unc_floor) || last_is_drive_root {
                continue;
            }
            parts.push("..");
            continue;
        }
        parts.push(part);
    }
    // The bare-drive-letter tail applies only to prefix-less paths (POSIX `/C:`
    // does not collide with a drive root)
    if prefix.is_empty() && parts.len() == 1 {
        let only = parts[0];
        if only.len() == 2 && only.as_bytes()[1] == b':' && only.as_bytes()[0].is_ascii_alphabetic()
        {
            return format!("{}/", only.to_lowercase());
        }
    }
    let normalized = format!("{}{}", prefix, parts.join("/"));
    let is_drive = normalized.len() >= 3
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/'
        && normalized.as_bytes()[0].is_ascii_alphabetic();
    if is_drive || unc {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

// ---------------------------------------------------------------------------
// Section detection (isomorphic to entityMappingHelpers.inferMethodSectionFromPythonFile)
// ---------------------------------------------------------------------------

/// Entity script section (bots/base/cell/client, four sections with several
/// forms; directories are recognized only at the asset layer — the engine
/// process name is not a directory name).
pub fn infer_method_section_from_python_file(python_file: &str) -> Option<&'static str> {
    let normalized_path = normalize_file_identity(python_file).to_lowercase();

    if normalized_path.contains("/scripts/bots/")
        || normalized_path.contains("/assets/scripts/bots/")
        || normalized_path.starts_with("bots/")
        || normalized_path.contains("/bots/")
    {
        return Some("ClientMethods");
    }
    if normalized_path.contains("/scripts/base/")
        || normalized_path.contains("/assets/scripts/base/")
        || normalized_path.starts_with("base/")
        || normalized_path.contains("/base/")
    {
        return Some("BaseMethods");
    }
    if normalized_path.contains("/scripts/cell/")
        || normalized_path.contains("/assets/scripts/cell/")
        || normalized_path.starts_with("cell/")
        || normalized_path.contains("/cell/")
    {
        return Some("CellMethods");
    }
    if normalized_path.contains("/scripts/client/")
        || normalized_path.contains("/assets/scripts/client/")
        || normalized_path.starts_with("client/")
        || normalized_path.contains("/client/")
    {
        return Some("ClientMethods");
    }
    None
}

// ---------------------------------------------------------------------------
// python masking and statement merging (isomorphic to backend/pythonParser)
// ---------------------------------------------------------------------------

fn is_js_space_unit(unit: u16) -> bool {
    matches!(
        unit,
        0x0020 | 0x0009 | 0x000A | 0x000D | 0x000C | 0x000B | 0x00A0
    )
}

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub(crate) fn units_to_string(slice: &[u16]) -> String {
    String::from_utf16_lossy(slice)
}

/// Isomorphic to TS split(/\r?\n/) (keeps empty lines; a line contains no
/// newline).
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

/// Masks comments and string literals (positions never shift): characters
/// inside quotes → spaces (a triple quote → `___`, occupying three columns),
/// an escape swallows two characters, and `#` through end of line becomes
/// whitespace wholesale. Same domain as the TS raw[col] UTF-16 index.
pub fn python_code_lines(content: &str) -> Vec<String> {
    let mut quote: u16 = 0;
    let mut triple = false;
    let mut out = Vec::new();
    for raw_line in split_lines_keep(content) {
        let raw = units(&raw_line);
        let mut masked: Vec<u16> = Vec::with_capacity(raw.len());
        let mut col = 0usize;
        while col < raw.len() {
            let ch = raw[col];
            if quote != 0 {
                if ch == b'\\' as u16 {
                    masked.push(b' ' as u16);
                    masked.push(b' ' as u16);
                    col += 2;
                    continue;
                }
                let q3 = [quote, quote, quote];
                if triple && col + 3 <= raw.len() && raw[col..col + 3] == q3 {
                    quote = 0;
                    triple = false;
                    masked.extend_from_slice(&[0x20, 0x20, 0x20]);
                    col += 3;
                    continue;
                } else if !triple && ch == quote {
                    quote = 0;
                    masked.push(b' ' as u16);
                } else {
                    masked.push(b' ' as u16);
                }
                col += 1;
                continue;
            }
            if ch == b'#' as u16 {
                while masked.len() < raw.len() {
                    masked.push(b' ' as u16);
                }
                break;
            }
            if ch == b'\'' as u16 || ch == b'"' as u16 {
                let q3 = [ch, ch, ch];
                triple = col + 3 <= raw.len() && raw[col..col + 3] == q3;
                quote = ch;
                if triple {
                    masked.extend_from_slice(&[0x5F, 0x5F, 0x5F]);
                    col += 3;
                } else {
                    masked.push(b'_' as u16);
                    col += 1;
                }
                continue;
            }
            masked.push(ch);
            col += 1;
        }
        out.push(units_to_string(&masked));
    }
    out
}

/// Statement-level info (isomorphic to pythonStatements): bracket/backslash
/// line continuations merged, coordinates taken from the first line.
#[derive(Debug)]
pub struct StatementEntry {
    pub text: String,
    pub line: usize,
    pub end_line: usize,
    pub indent: usize,
}

/// Bracket/continuation merging (`text` is masked text; indent is the first
/// line's leading whitespace, with \t counted as 4 spaces).
pub fn python_statements(content: &str) -> Vec<StatementEntry> {
    let mut statements = Vec::new();
    let mut depth = 0isize;
    let mut pending = String::new();
    let mut start = 0usize;
    let mut indent = 0usize;
    for (line, masked) in python_code_lines(content).into_iter().enumerate() {
        let has_content = !masked.trim().is_empty();
        if pending.is_empty() && !has_content {
            continue;
        }
        if pending.is_empty() {
            start = line;
            let leading: String = masked
                .chars()
                .take_while(|c| *c == ' ' || *c == '\t')
                .collect();
            indent = leading.replace('\t', "    ").chars().count();
        }
        for ch in masked.chars() {
            if "([{".contains(ch) {
                depth += 1;
            }
            if ")]}".contains(ch) {
                depth = (depth - 1).max(0);
            }
        }
        // TS /\\\s*$/: a `\` followed only by whitespace to end of line means a
        // continuation; strip the `\` plus the trailing whitespace
        let trimmed_end = masked.trim_end();
        let trailing_ws = masked.len() - trimmed_end.len();
        let continued = trimmed_end.ends_with('\\');
        let stripped = if continued {
            &masked[..masked.len() - trailing_ws - 1]
        } else {
            &masked[..]
        };
        if !pending.is_empty() {
            pending.push(' ');
        }
        pending.push_str(stripped);
        if depth == 0 && !continued {
            statements.push(StatementEntry {
                text: std::mem::take(&mut pending),
                line: start,
                end_line: line,
                indent,
            });
        }
    }
    statements
}

// ---------------------------------------------------------------------------
// File parsing (parsePythonFile's class/method surface)
// ---------------------------------------------------------------------------

/// Class definitions (method name → line/column; only the faces this batch
/// consumes are produced — imports/instanceAssignments are not emitted, a pure
/// output trim with stack behavior unchanged).
#[derive(Debug)]
pub struct PythonClassDef {
    pub name: String,
    pub qualified_name: String,
    pub start_line: usize,
    pub end_line: usize,
    /// Method name → (line 0-based, column UTF-16)
    pub methods: Vec<(String, usize, usize)>,
}

struct ScopeFrame {
    indent: usize,
    cls: Option<usize>,
    function: bool,
}

fn class_header_of(text: &str) -> Option<(String, String)> {
    // /^\s*class\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*:/ — `.*` greedy
    // backtracking: enumerate right-to-left from the rightmost `)` and the
    // first one followed by `\s*:` closes (same backtracking order as the TS
    // regex engine; lines with multiple `)` are unambiguous).
    let u = units(text);
    let mut cursor = 0usize;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    let class_word: Vec<u16> = "class".chars().map(|c| c as u16).collect();
    if !u[cursor..].starts_with(&class_word[..]) {
        return None;
    }
    cursor += class_word.len();
    let space_start = cursor;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor == space_start || cursor >= u.len() || !is_ident_start(u[cursor]) {
        return None;
    }
    let name_start = cursor;
    while cursor < u.len() && is_ident_unit(u[cursor]) {
        cursor += 1;
    }
    let name = units_to_string(&u[name_start..cursor]);
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    let mut bases = String::new();
    if cursor < u.len() && u[cursor] == b'(' as u16 {
        // Enumerate `)` candidates right-to-left; the first one followed only by
        // whitespace + ':' closes
        let mut close = None;
        for candidate in (cursor + 1..u.len()).rev() {
            if u[candidate] != b')' as u16 {
                continue;
            }
            let mut after = candidate + 1;
            while after < u.len() && is_js_space_unit(u[after]) {
                after += 1;
            }
            if after < u.len() && u[after] == b':' as u16 {
                close = Some(candidate);
                break;
            }
        }
        let close = close?;
        bases = units_to_string(&u[cursor + 1..close]);
        cursor = close + 1;
    }
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor >= u.len() || u[cursor] != b':' as u16 {
        return None;
    }
    Some((name, bases))
}

pub(crate) fn is_ident_start(u: u16) -> bool {
    u == b'_' as u16
        || (u >= b'a' as u16 && u <= b'z' as u16)
        || (u >= b'A' as u16 && u <= b'Z' as u16)
}

pub(crate) fn is_ident_unit(u: u16) -> bool {
    is_ident_start(u) || (u >= b'0' as u16 && u <= b'9' as u16)
}

fn def_header_of(text: &str) -> Option<String> {
    // /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
    let u = units(text);
    let mut cursor = 0usize;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    let def_word: Vec<u16> = "def".chars().map(|c| c as u16).collect();
    let async_word: Vec<u16> = "async".chars().map(|c| c as u16).collect();
    if u[cursor..].starts_with(&async_word[..]) {
        cursor += async_word.len();
        let space_start = cursor;
        while cursor < u.len() && is_js_space_unit(u[cursor]) {
            cursor += 1;
        }
        if cursor == space_start {
            return None;
        }
    }
    if !u[cursor..].starts_with(&def_word[..]) {
        return None;
    }
    cursor += def_word.len();
    let space_start = cursor;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor == space_start || cursor >= u.len() || !is_ident_start(u[cursor]) {
        return None;
    }
    let name_start = cursor;
    while cursor < u.len() && is_ident_unit(u[cursor]) {
        cursor += 1;
    }
    let name = units_to_string(&u[name_start..cursor]);
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor >= u.len() || u[cursor] != b'(' as u16 {
        return None;
    }
    Some(name)
}

/// Isomorphic to TS text.indexOf(name, text.indexOf('def') + 3): from after
/// the `def` word, find the name's first column (UTF-16; on masked text).
pub(crate) fn index_from(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let h = units(haystack);
    let n = units(needle);
    if from > h.len() {
        return None;
    }
    let mut cursor = from;
    while cursor + n.len() <= h.len() {
        if h[cursor..cursor + n.len()] == n[..] {
            return Some(cursor);
        }
        cursor += 1;
    }
    None
}

/// Isomorphic to parsePythonFile: class/method surface
/// (imports/instanceAssignments not produced).
pub fn parse_python_file(content: &str) -> Vec<PythonClassDef> {
    let mut classes: Vec<PythonClassDef> = Vec::new();
    let total_lines = split_lines_keep(content).len();
    let mut stack: Vec<ScopeFrame> = Vec::new();
    for statement in python_statements(content) {
        let text = statement.text.clone();
        let line = statement.line;
        let indent = statement.indent;
        if text.trim().is_empty() {
            continue;
        }
        while let Some(top) = stack.last() {
            if top.indent >= indent {
                let frame = stack.pop().expect("checked non-empty");
                if let Some(cls_index) = frame.cls {
                    classes[cls_index].end_line = line;
                }
            } else {
                break;
            }
        }
        // A class inside a function body is a local runtime class; it does not
        // enter the workspace symbol table
        if stack.iter().any(|scope| scope.function) {
            continue;
        }
        if let Some((name, _bases)) = class_header_of(&text) {
            let parent = stack.iter().rev().find_map(|scope| scope.cls);
            let qualified_name = match parent {
                Some(parent_index) => format!("{}.{}", classes[parent_index].qualified_name, name),
                None => name.clone(),
            };
            classes.push(PythonClassDef {
                name,
                qualified_name,
                start_line: line,
                end_line: total_lines,
                methods: Vec::new(),
            });
            stack.push(ScopeFrame {
                indent,
                cls: Some(classes.len() - 1),
                function: false,
            });
            continue;
        }
        if let Some(name) = def_header_of(&text) {
            // Only a class's direct functions are methods; closures are not
            if let Some(top) = stack.last() {
                if let Some(cls_index) = top.cls {
                    let def_at = index_from(&text, "def", 0).unwrap_or(0);
                    let character = index_from(&text, &name, def_at + 3).unwrap_or(0);
                    classes[cls_index].methods.push((name, line, character));
                }
            }
            stack.push(ScopeFrame {
                indent,
                cls: None,
                function: true,
            });
            continue;
        }
    }
    classes
}

// ---------------------------------------------------------------------------
// Single-line def parsing and parameter splitting (isomorphic to
// defParamInlayHints.parseDefLine/splitParams)
// ---------------------------------------------------------------------------

/// Parameter position (the definition point; start/end are 0-based columns,
/// absolute within the line).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefParamSiteParam {
    pub start: usize,
    pub end: usize,
    /// The line holding the parameter name (0-based) — since KODE-SYN-004 a
    /// signature may span lines, so a parameter can land on a continuation line
    pub line: usize,
    pub name: String,
    pub has_annotation: bool,
    pub is_star: bool,
}

/// A definition-point site.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefParamSite {
    pub line: usize,
    pub method_name: String,
    pub section: String,
    pub params: Vec<DefParamSiteParam>,
    /// The parameter list's closing-bracket line (0-based) — since KODE-SYN-004
    /// the closing bracket may sit on a continuation line
    pub close_paren_line: usize,
    pub close_paren_character: usize,
}

/// Cross-line def signature parsing (KODE-SYN-004): the single source of truth
/// is the python_code_lines masked line domain (columns do not shift; quotes /
/// strings / comments are already neutralized, so bracket and comma scanning is
/// free of string interference). From the first '(' after the method name
/// token, bracket pairing continues across lines down to the depth-0 ')'; an
/// unclosed signature (mid-edit / truncated at EOF) returns None and yields
/// honestly. The parameter positions (name token line/column, UTF-16 domain)
/// are shared with the inlay/semantic_tokens consumer faces; `/` and a bare `*`
/// are only Python parameter markers and occupy no `<Arg>` slot, so they are
/// excluded from the sequence; `*args`/`**kwargs` keep their is_star bit.
/// Isomorphic to the TS parseDefSignature, position by position.
pub(crate) fn parse_def_signature(
    masked_lines: &[String],
    start_line: usize,
    method_name: &str,
    name_character: usize,
    section: &str,
) -> Option<DefParamSite> {
    let first_units = masked_lines.get(start_line).map(|l| units(l));
    let u = first_units?;
    let mut open = name_character + method_name.chars().map(|c| c.len_utf16()).sum::<usize>();
    // Isomorphic to TS indexOf('(', from): from that point, the first '('
    while open < u.len() && u[open] != b'(' as u16 {
        open += 1;
    }
    if open >= u.len() {
        return None;
    }
    // Segment across lines: split at depth-1 commas (depth 1 = the parameter
    // list's top level, the open bracket already counted), each segment
    // records its (line, col, ch) unit stream
    let mut segments: Vec<Vec<(usize, usize, u16)>> = vec![Vec::new()];
    let mut depth: isize = 1;
    let mut close_paren_line: Option<usize> = None;
    let mut close_paren_character: Option<usize> = None;
    'scan: for (line_index, line) in masked_lines.iter().enumerate().skip(start_line) {
        let lu = units(line);
        let from = if line_index == start_line {
            open + 1
        } else {
            0
        };
        let mut col = from;
        while col < lu.len() {
            let ch = lu[col];
            if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
                depth += 1;
                segments
                    .last_mut()
                    .expect("非空")
                    .push((line_index, col, ch));
            } else if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
                depth -= 1;
                if depth == 0 && ch == b')' as u16 {
                    close_paren_line = Some(line_index);
                    close_paren_character = Some(col);
                    break 'scan;
                }
                segments
                    .last_mut()
                    .expect("非空")
                    .push((line_index, col, ch));
            } else if ch == b',' as u16 && depth == 1 {
                // depth 1 = the parameter list's top level; a comma inside a
                // nested default value is at depth ≥2 and does not split
                segments.push(Vec::new());
            } else {
                segments
                    .last_mut()
                    .expect("非空")
                    .push((line_index, col, ch));
            }
            col += 1;
        }
    }
    // Mid-edit unclosed signature: brackets never pair down to the depth-0 ')'
    // → no output
    let (close_paren_line, close_paren_character) = match (close_paren_line, close_paren_character)
    {
        (Some(l), Some(c)) => (l, c),
        _ => return None,
    };
    let mut params: Vec<DefParamSiteParam> = Vec::new();
    for segment in &segments {
        if let Some(param) = flush_segment(segment, masked_lines) {
            params.push(param);
        }
    }
    // The first argument self/cls does not participate (engine entity methods
    // are always self; class-method cls is likewise not an RPC parameter)
    let meaningful: Vec<DefParamSiteParam> =
        if !params.is_empty() && (params[0].name == "self" || params[0].name == "cls") {
            params[1..].to_vec()
        } else {
            params
        };
    Some(DefParamSite {
        line: start_line,
        method_name: method_name.to_string(),
        section: section.to_string(),
        params: meaningful,
        close_paren_line,
        close_paren_character,
    })
}

/// Shaping one segment: skip whitespace (a continuation line's leading
/// indentation) → `*` marker → name token (ASCII identifier + non-ASCII name
/// units); annotation detection uses the first ':'/'=' at depth 0 within the
/// segment (separators inside nested default values don't count). `/` and a
/// bare `*` (followed by no identifier) are Python parameter markers and
/// produce no parameter slot. Isomorphic to the TS flushSegment.
fn flush_segment(
    segment: &[(usize, usize, u16)],
    masked_lines: &[String],
) -> Option<DefParamSiteParam> {
    let mut index = 0usize;
    while index < segment.len() && is_js_space_unit(segment[index].2) {
        index += 1;
    }
    if index >= segment.len() {
        return None; // a trailing-comma empty segment produces no parameter slot
    }
    let mut is_star = false;
    while index < segment.len() && segment[index].2 == b'*' as u16 {
        is_star = true;
        index += 1;
    }
    let (name_line, name_col, _) = *segment.get(index)?;
    let line_u = units(masked_lines.get(name_line)?);
    if name_col >= line_u.len() {
        return None;
    }
    // ASCII units go through identifier detection; non-ASCII units (CJK and
    // other Unicode names, PEP 3131) are kept as name units. Markers like `/`
    // are ASCII non-identifiers and produce no parameter slot as before.
    if !is_ident_start(line_u[name_col]) && line_u[name_col] < 0x80 {
        return None; // ASCII non-identifier segments such as `/` (positional-only marker) produce no parameter slot
    }
    let mut name_len = 1usize;
    while name_col + name_len < line_u.len()
        && (is_ident_unit(line_u[name_col + name_len]) || line_u[name_col + name_len] >= 0x80)
    {
        name_len += 1;
    }
    let name = units_to_string(&line_u[name_col..name_col + name_len]);
    // The first depth-0 separator after the name token is ':' for it to count
    // as annotated (a ':' inside a default-value dict literal sits at depth ≥1
    // and doesn't count)
    let mut seg_depth: isize = 0;
    let mut has_annotation = false;
    let mut after_name = false;
    for &(unit_line, unit_col, ch) in segment {
        if !after_name {
            if unit_line == name_line && unit_col == name_col + name_len {
                after_name = true; // the hit unit itself may also be a separator (`a: int`), falls through to the check below
            } else {
                continue;
            }
        }
        if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
            seg_depth += 1;
        } else if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
            seg_depth -= 1;
        } else if seg_depth == 0 && ch == b':' as u16 {
            has_annotation = true;
            break;
        } else if seg_depth == 0 && ch == b'=' as u16 {
            break;
        }
    }
    Some(DefParamSiteParam {
        start: name_col,
        end: name_col + name_len,
        line: name_line,
        name,
        has_annotation,
        is_star,
    })
}

// ---------------------------------------------------------------------------
// Definition-point site face (pure function entry)
// ---------------------------------------------------------------------------

/// Extracting definition points: only defs inside section files, inside class
/// bodies, with same-line closing brackets are recognized.
pub fn find_def_param_sites(text: &str, file_path: &str) -> Vec<DefParamSite> {
    let section = match infer_method_section_from_python_file(file_path) {
        Some(section) => section,
        // A plain method outside a section produces no output (no inference is done)
        None => return Vec::new(),
    };
    // KODE-SYN-004: the single source of truth = the python_code_lines masked
    // line domain (columns do not shift, quotes/comments are naturally
    // neutralized) — cross-line signature parsing and semantic_tokens
    // parameter coloring walk the same masked lines, isomorphic to the TS
    // parseDefSignature position by position
    let masked_lines = python_code_lines(text);
    let mut sites = Vec::new();
    for cls in parse_python_file(text) {
        for (method_name, method_line, character) in &cls.methods {
            if masked_lines.get(*method_line).is_none() {
                continue;
            }
            if let Some(site) = parse_def_signature(
                &masked_lines,
                *method_line,
                method_name,
                *character,
                section,
            ) {
                sites.push(site);
            }
        }
    }
    sites
}

// ---------------------------------------------------------------------------
// Builtin annotation direct lookup (isomorphic to the pythonTypeStubs empty-registry branch)
// ---------------------------------------------------------------------------

/// KBENGINE_TYPE_ALIASES = {Address, WatcherValue}: referenced by name in
/// registry-missing contexts.
fn kbengine_type_alias(name: &str) -> bool {
    matches!(name, "Address" | "WatcherValue")
}

/// PYTHON_BUILTIN_TYPE_ANNOTATIONS 22 keys, **direct lookup without a gate**
/// (isomorphic to the pythonTypeStubs table; different from code_action's
/// skeleton gate — the signature skeleton only emits builtin names that are
/// usable bare, while the inlay type hint still emits VECTOR2→Vector2).
fn builtin_table_lookup(name: &str) -> Option<&'static str> {
    match name {
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

/// Isomorphic to resolveEntityAnnotationType(workspaceRoot='', raw): builtin
/// direct lookup + engine aliases referenced by name; everything else falls to
/// Any. Returns None = the production face emits Any (this slot is skipped).
pub fn resolve_annotation_direct(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "ALIAS" {
        return None;
    }
    if let Some(builtin) = builtin_table_lookup(trimmed) {
        return Some(builtin.to_string());
    }
    if kbengine_type_alias(trimmed) {
        return Some(trimmed.to_string());
    }
    None
}

// ---------------------------------------------------------------------------
// Inlay item pairing (isomorphic to buildDefParamInlayItems)
// ---------------------------------------------------------------------------

/// Inlay item (pure data; position has the same shape as the TS {line, character}).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefParamInlayItem {
    pub position: InlayPosition,
    pub text: String,
    pub kind: String,
}

/// In-line absolute position (0-based line / 0-based column, UTF-16 unit domain).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InlayPosition {
    pub line: usize,
    pub character: usize,
}

/// def declaration face (sub-shape consumed by EntityMethodDefinitionLocation).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationFace {
    pub declared_args: Option<Vec<String>>,
    pub declared_return_type: Option<String>,
}

/// Inlay items for one definition site: unannotated parameters pair slot by
/// slot with def <Arg> (min(declaration count, parameter count)); when
/// <ReturnType> exists and resolves, `-> <Type>` after the closing paren.
pub fn build_def_param_inlay_items(
    site: &DefParamSite,
    declaration: &DeclarationFace,
) -> Vec<DefParamInlayItem> {
    let mut items = Vec::new();
    let declared_args = declaration.declared_args.clone().unwrap_or_default();
    let paired = declared_args.len().min(site.params.len());
    for (index, declared_raw) in declared_args.iter().enumerate().take(paired) {
        let param = &site.params[index];
        let declared = declared_raw.trim().to_string();
        if declared.is_empty() || param.has_annotation || param.is_star {
            continue;
        }
        // TS annotation === PYTHON_TYPE_STUB_FALLBACK('Any') → this slot is skipped
        let annotation = match resolve_annotation_direct(&declared) {
            Some(annotation) if annotation != "Any" => annotation,
            _ => continue,
        };
        items.push(DefParamInlayItem {
            // KODE-SYN-004: a parameter hint anchors to its own line (each hint
            // in a multi-line signature lands on its own line)
            position: InlayPosition {
                line: param.line,
                character: param.end,
            },
            text: format!(": {}", annotation),
            kind: "Parameter".to_string(),
        });
    }
    let declared_return = declaration
        .declared_return_type
        .as_ref()
        .map(|t| t.trim().to_string());
    if let Some(declared_return) = declared_return {
        if !declared_return.is_empty() {
            if let Some(return_annotation) = resolve_annotation_direct(&declared_return) {
                if return_annotation != "Any" {
                    items.push(DefParamInlayItem {
                        // the closing paren may be on another line (KODE-SYN-004),
                        // anchor to the closing paren's line
                        position: InlayPosition {
                            line: site.close_paren_line,
                            character: site.close_paren_character + 1,
                        },
                        text: format!(" -> {}", return_annotation),
                        kind: "Type".to_string(),
                    });
                }
            }
        }
    }
    items
}

// ---------------------------------------------------------------------------
// golden (corpus + authoritative probe face + outcomes; TS mirror tests/kodeDefParamHintsParity.test.ts)
// ---------------------------------------------------------------------------

/// Corpus entry: the path participates in section decisions (text is python source).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusEntry {
    pub name: String,
    pub path: String,
    pub text: String,
}

/// Probe face: the decision core's two entry points (sites extraction / items inlay pairing).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum Probe {
    Sites {
        corpus: String,
    },
    Items {
        corpus: String,
        site_index: usize,
        declared_args: Option<Vec<String>>,
        declared_return_type: Option<String>,
    },
}

/// Outcome face (one-to-one with Probe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum ProbeOutcome {
    Sites { sites: Vec<DefParamSite> },
    Items { items: Vec<DefParamInlayItem> },
}

/// Golden file shape.
#[derive(Debug, Serialize, Deserialize)]
pub struct DefParamHintsGolden {
    pub generator: String,
    pub corpus: Vec<CorpusEntry>,
    pub probes: Vec<Probe>,
    pub outcomes: Vec<ProbeOutcome>,
}

pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/def-param-hints-parity.json";

fn corpus() -> Vec<CorpusEntry> {
    vec![
        CorpusEntry {
            name: "cell_multimethod".into(),
            path: "/p/scripts/cell/avatar.py".into(),
            text: concat!(
                "import base\n",
                "\n",
                "class Avatar:\n",
                "    def foo(self, a, b):\n",
                "        pass\n",
                "\n",
                "    def annotated(self, a: int, b: str = \"x\"):\n",
                "        pass\n",
                "\n",
                "    def starred(self, a, *args, **kwargs):\n",
                "        pass\n",
                "\n",
                "    def tricky(self, a, b=\"s,d\", c={'k': 1}):\n",
                "        pass\n",
                "\n",
                "    async def late(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "base_methods".into(),
            path: "/p/scripts/base/mailbox.py".into(),
            text: concat!(
                "class Mailbox:\n",
                "    def deliver(self, a, b):\n",
                "        pass\n",
                "\n",
                "    def withReturn(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "bots_section".into(),
            path: "/p/scripts/bots/robot.py".into(),
            text: "class Robot:\n    def think(self, a):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "client_section".into(),
            path: "/p/scripts/client/ui.py".into(),
            text: "class Ui:\n    def show(self, a, b, c):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "outside_section".into(),
            path: "/p/scripts/common/util.py".into(),
            text: "class Util:\n    def helper(self, a):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "nested_class".into(),
            path: "/p/scripts/cell/nest.py".into(),
            text: concat!(
                "class Outer:\n",
                "    class Inner:\n",
                "        def inside(self, a):\n",
                "            pass\n",
                "\n",
                "    def plain(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "inner_class_skip".into(),
            path: "/p/scripts/base/factory.py".into(),
            text: concat!(
                "class Factory:\n",
                "    def builder(self):\n",
                "        def inner():\n",
                "            pass\n",
                "        class Local:\n",
                "            def hidden(self, a):\n",
                "                pass\n",
                "        return Local\n",
                "\n",
                "    def visible(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "crossline_def".into(),
            path: "/p/scripts/cell/bridge.py".into(),
            text: concat!(
                "class Bridge:\n",
                "    def cross(self, a,\n",
                "              b):\n",
                "        pass\n",
                "\n",
                "    def ok(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "cjk_params".into(),
            path: "/p/scripts/cell/cjk.py".into(),
            text: "class Cjk:\n    def attack(self, \u{76ee}\u{6807}, \u{6b21}\u{6570}):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "cls_first".into(),
            path: "/p/scripts/base/cache.py".into(),
            text: "class Cache:\n    @classmethod\n    def load(cls, a):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "deep_default".into(),
            path: "/p/scripts/cell/deep.py".into(),
            text: concat!(
                "class Deep:\n",
                "    def defaults(self, a=(1, 2), b=\"x:y\", c=[3, 4], d={'k': 'v'}):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "assets_scripts_cell".into(),
            path: "/p/assets/scripts/cell/x.py".into(),
            text: "class X:\n    def go(self, a):\n        pass\n".into(),
        },
        // KODE-SYN-004 acceptance corpus: multi-line async + `/`/`*` markers +
        // CJK + non-BMP (astral surrogate pairs) + cross-line nested default
        // values (a ':' inside a dict at depth ≥2 is not misjudged as
        // annotated; a cross-line comma inside a segment at depth ≥2 does not split)
        CorpusEntry {
            name: "multiline_rich".into(),
            path: "/p/scripts/cell/summon.py".into(),
            text: concat!(
                "class Rich:\n",
                "    async def summon(\n",
                "        self,\n",
                "        \u{76ee}\u{6807},\n",
                "        /,\n",
                "        power,\n",
                "        *,\n",
                "        options={\"delay\": 1, \"rows\": [\n",
                "            1, 2\n",
                "        ]},\n",
                "        note,\n",
                "    ):\n",
                "        pass\n",
            )
            .into(),
        },
        // Mid-edit unclosed signature: brackets never pair down to the depth-0 ')',
        // honestly yields with zero sites
        CorpusEntry {
            name: "unclosed_sig".into(),
            path: "/p/scripts/cell/torn.py".into(),
            text: concat!(
                "class Torn:\n",
                "    def part(self, a):\n",
                "        pass\n",
                "\n",
                "    def torn(self,\n",
                "        b,\n",
            )
            .into(),
        },
    ]
}

fn probes() -> Vec<Probe> {
    let args_a = vec![
        "UINT8".to_string(),
        "VECTOR3".to_string(),
        "UNKNOWN_X".to_string(),
        "STRING".to_string(),
        "BOOL".to_string(),
    ];
    let args_b = vec!["STRING".to_string()];
    let args_c = vec!["ENTITYCALL".to_string(), "PY_DICT".to_string()];
    let mut probes = Vec::new();
    for entry in corpus() {
        probes.push(Probe::Sites {
            corpus: entry.name.clone(),
        });
    }
    // cell_multimethod: 5 sites × 4 declaration faces
    for site_index in 0..5usize {
        for (args, ret) in [
            (Some(args_a.clone()), None),
            (Some(args_b.clone()), Some("BOOL".to_string())),
            (Some(args_c.clone()), Some("ENTITYCALL".to_string())),
            (None, None),
        ] {
            probes.push(Probe::Items {
                corpus: "cell_multimethod".into(),
                site_index,
                declared_args: args,
                declared_return_type: ret,
            });
        }
    }
    for (corpus, site_index, args, ret) in [
        ("base_methods", 0usize, Some(args_b.clone()), None),
        (
            "base_methods",
            1,
            Some(args_c.clone()),
            Some("BOOL".to_string()),
        ),
        ("bots_section", 0, Some(args_a.clone()), None),
        ("client_section", 0, Some(args_a.clone()), None),
        ("client_section", 0, Some(args_c.clone()), None),
        ("outside_section", 0, Some(args_a.clone()), None),
        ("nested_class", 0, Some(args_a.clone()), None),
        ("nested_class", 1, Some(args_a.clone()), None),
        ("inner_class_skip", 0, Some(args_b.clone()), None),
        ("crossline_def", 0, Some(args_a.clone()), None),
        (
            "cjk_params",
            0,
            Some(vec!["UINT8".to_string(), "UINT16".to_string()]),
            None,
        ),
        ("cls_first", 0, Some(vec!["UINT8".to_string()]), None),
        (
            "deep_default",
            0,
            Some(vec![
                "UINT8".to_string(),
                "STRING".to_string(),
                "PY_LIST".to_string(),
                "PY_DICT".to_string(),
            ]),
            Some("BOOL".to_string()),
        ),
        ("assets_scripts_cell", 0, Some(args_a.clone()), None),
        // KODE-SYN-004: multi-line signature sites × declaration faces
        // (slot-by-slot pairing / no declarations → zero hints)
        (
            "multiline_rich",
            0,
            Some(vec![
                "UINT16".to_string(),
                "UINT8".to_string(),
                "PY_DICT".to_string(),
                "STRING".to_string(),
            ]),
            None,
        ),
        (
            "multiline_rich",
            0,
            Some(vec![
                "UINT16".to_string(),
                "UINT8".to_string(),
                "PY_DICT".to_string(),
                "STRING".to_string(),
            ]),
            Some("BOOL".to_string()),
        ),
        ("multiline_rich", 0, None, None),
    ] {
        probes.push(Probe::Items {
            corpus: corpus.into(),
            site_index,
            declared_args: args,
            declared_return_type: ret,
        });
    }
    probes
}

fn run_probe(
    table: &std::collections::HashMap<String, CorpusEntry>,
    probe: &Probe,
) -> ProbeOutcome {
    match probe {
        Probe::Sites { corpus } => {
            let entry = table.get(corpus).expect("corpus 名必在表");
            ProbeOutcome::Sites {
                sites: find_def_param_sites(&entry.text, &entry.path),
            }
        }
        Probe::Items {
            corpus,
            site_index,
            declared_args,
            declared_return_type,
        } => {
            let entry = table.get(corpus).expect("corpus 名必在表");
            let sites = find_def_param_sites(&entry.text, &entry.path);
            let items = sites
                .get(*site_index)
                .map(|site| {
                    build_def_param_inlay_items(
                        site,
                        &DeclarationFace {
                            declared_args: declared_args.clone(),
                            declared_return_type: declared_return_type.clone(),
                        },
                    )
                })
                .unwrap_or_default();
            ProbeOutcome::Items { items }
        }
    }
}

pub fn dump_def_param_hints_golden() -> String {
    let list = probes();
    let table: std::collections::HashMap<String, CorpusEntry> = corpus()
        .into_iter()
        .map(|entry| (entry.name.clone(), entry))
        .collect();
    let outcomes: Vec<ProbeOutcome> = list.iter().map(|probe| run_probe(&table, probe)).collect();
    let golden = DefParamHintsGolden {
        generator: "dump-def-param-hints-golden".into(),
        corpus: corpus(),
        probes: list,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_strings_and_comments_position_invariant() {
        let text = "def f(self, a=\"x,y\", b): # note\n    pass\n";
        let masked = python_code_lines(text);
        let lines = split_lines_keep(text);
        assert_eq!(masked.len(), lines.len());
        for (m, r) in masked.iter().zip(lines.iter()) {
            assert_eq!(
                m.encode_utf16().count(),
                r.encode_utf16().count(),
                "掩码不位移: {m:?} vs {r:?}"
            );
        }
        // Literals: opening quote _ remaining units spaces (positions unchanged),
        // comments blanked to end of line
        assert_eq!(masked[0], "def f(self, a=_    , b):       ");
        // Escaped quotes do not close (the escape swallows two units)
        let esc = python_code_lines("s = 'a\\'b,c'\nd(self, x)\n");
        assert_eq!(esc[0], "s = _       ");
        // Triple-quote opening occupies three columns of _, closing three columns of spaces
        let tri = python_code_lines("t = \"\"\"ab\nc\"\"\"\n");
        assert_eq!(tri[0], "t = ___  ");
        assert_eq!(tri[1], "    ");
    }

    #[test]
    fn statement_merges_continuations() {
        let text = "class A(\n    Base,\n):\n    def m(self):\n        pass\n";
        let st = python_statements(text);
        assert_eq!(st.len(), 3, "class 合并 1 条 + def + pass");
        assert_eq!(st[0].text, "class A(     Base, ):");
        assert_eq!(st[0].line, 0);
        assert_eq!(st[0].end_line, 2);
        assert_eq!(st[0].indent, 0);
        assert_eq!(st[1].line, 3);
        assert_eq!(st[2].line, 4);
        // Backslash continuation stripped \
        let bs = python_statements("x = 1 + \\\n    2\n");
        assert_eq!(bs.len(), 1);
        assert_eq!(bs[0].text, "x = 1 +      2");
        // \t indentation counts as 4
        let tab = python_statements("\tdef m(self):\n");
        assert_eq!(tab[0].indent, 4);
    }

    #[test]
    fn parse_python_file_class_method_table() {
        let text = "import base\n\nclass Avatar(Base):\n    def foo(self):\n        pass\n\n    async def bar(self):\n        pass\n\n    def notAMethod(self):\n        pass\n\n    def inner():\n        class Local:\n            def hidden(self):\n                pass\n\nclass Other:\n    def baz(self, a):\n        pass\n";
        let classes = parse_python_file(text);
        assert_eq!(classes.len(), 2, "函数体内的 Local 类不进表");
        assert_eq!(classes[0].name, "Avatar");
        assert_eq!(classes[0].qualified_name, "Avatar");
        let names: Vec<&str> = classes[0]
            .methods
            .iter()
            .map(|(n, _, _)| n.as_str())
            .collect();
        assert_eq!(
            names,
            vec!["foo", "bar", "notAMethod", "inner"],
            "async def 同表;Local.hidden 闭包不是方法"
        );
        assert_eq!(classes[1].qualified_name, "Other");
        // Nested classes (class inside a class body): qualifiedName chain
        let nested = parse_python_file(
            "class Outer:\n    class Inner:\n        def m(self):\n            pass\n",
        );
        assert_eq!(nested.len(), 2);
        assert_eq!(nested[1].qualified_name, "Outer.Inner");
    }

    #[test]
    fn section_inference_multiform() {
        assert_eq!(
            infer_method_section_from_python_file("/p/assets/scripts/cell/a.py"),
            Some("CellMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/base/a.py"),
            Some("BaseMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/bots/a.py"),
            Some("ClientMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/client/a.py"),
            Some("ClientMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("base/a.py"),
            Some("BaseMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/../scripts/cell/a.py"),
            Some("CellMethods"),
            ".. 词法折叠"
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/common/util.py"),
            None,
            "区块外"
        );
        // Case: Windows drive-letter identity is lowercased
        assert_eq!(
            infer_method_section_from_python_file("C:/Proj/Scripts/Cell/a.py"),
            Some("CellMethods")
        );
    }

    #[test]
    fn parse_def_signature_boundaries() {
        // self stripping / closing-paren column (KODE-SYN-004: masked-line
        // domain cross-line core)
        let masked = python_code_lines("    def foo(self, a, b):\n");
        let site = parse_def_signature(&masked, 0, "foo", 8, "CellMethods").unwrap();
        assert_eq!(site.line, 0);
        assert_eq!(site.method_name, "foo");
        assert_eq!(site.params.len(), 2);
        assert_eq!(site.params[0].name, "a");
        assert_eq!(site.params[0].start, 18);
        assert_eq!(site.params[0].line, 0);
        assert_eq!(site.params[1].name, "b");
        assert_eq!(site.close_paren_line, 0);
        assert_eq!(site.close_paren_character, 22);
        // First parameter not self: keep all
        let masked = python_code_lines("def m(x, y):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "BaseMethods").unwrap();
        assert_eq!(site.params.len(), 2);
        // Mid-edit unclosed signature (not closed across lines) produces nothing
        let masked = python_code_lines("def m(self, a,\n");
        assert_eq!(parse_def_signature(&masked, 0, "m", 4, "CellMethods"), None);
        // No '(' after the name produces nothing
        let masked = python_code_lines("def m:\n");
        assert_eq!(parse_def_signature(&masked, 0, "m", 4, "CellMethods"), None);
    }

    #[test]
    fn signature_masking_defaults_and_markers() {
        // Commas/colons inside strings are neutralized by masking; a colon
        // inside a default-value dict does not count as annotated
        let masked = python_code_lines("def m(self, a, b=\"x,y\", c={'k': 1}, d: int = 2):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "BaseMethods").unwrap();
        assert_eq!(site.params.len(), 4);
        assert_eq!(site.params[1].name, "b");
        assert!(!site.params[1].has_annotation);
        assert_eq!(site.params[2].name, "c");
        assert!(
            !site.params[2].has_annotation,
            "默认值字面量内冒号不算已标注"
        );
        assert_eq!(site.params[3].name, "d");
        assert!(site.params[3].has_annotation);
        // Name column with CJK prefix (UTF-16 domain)
        let masked = python_code_lines("def m(self, 中文, x):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert_eq!(site.params[0].name, "中文");
        assert_eq!(site.params[0].start, 12);
        assert_eq!(site.params[0].end, 14, "UTF-16 单元域");
        assert_eq!(
            site.params[1].start, 16,
            "x 在 UTF-16 全域 index 16(两 CJK 各 1 单元)"
        );
        // star parameters keep is_star
        let masked = python_code_lines("def m(self, *args, **kwargs):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert!(site.params[0].is_star);
        assert_eq!(site.params[0].name, "args");
        assert!(site.params[1].is_star);
        assert_eq!(site.params[1].name, "kwargs");
        // `/` and bare `*` markers are skipped from the sequence (parameters
        // before/after keyword-only still align slot by slot)
        let masked = python_code_lines("def m(self, a, /, b, *, c):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        let names: Vec<&str> = site.params.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"], "标记 `/` 与裸 `*` 不产形参位");
        assert!(!site.params.iter().any(|p| p.is_star));
    }

    /// KODE-SYN-004 acceptance face: multi-line async / nested default values /
    /// CJK + non-BMP coordinates / unclosed.
    #[test]
    fn multiline_signature_acceptance_arms() {
        // Multi-line async: parameters land on their own lines, closing-paren
        // line honestly reported
        let masked = python_code_lines(
            "    async def multi(\n        self,\n        a,\n        b: str = \"x,y\",\n    ):\n        pass\n",
        );
        let site = parse_def_signature(&masked, 0, "multi", 14, "ClientMethods").unwrap();
        assert_eq!(site.params.len(), 2);
        assert_eq!(site.params[0].name, "a");
        assert_eq!(site.params[0].line, 2);
        assert_eq!(site.params[0].start, 8);
        assert_eq!(site.params[1].name, "b");
        assert_eq!(site.params[1].line, 3);
        assert!(
            site.params[1].has_annotation,
            "真实标注 :str 认出;默认值字符串内逗号不切段"
        );
        assert_eq!(site.close_paren_line, 4);
        assert_eq!(site.close_paren_character, 4);
        // Nested default values across lines + in-segment comments (whitespace
        // after masking) do not mis-split
        let masked = python_code_lines(
            "    def nested(self, a={\n        \"k\": [1, 2]},\n        b):\n        pass\n",
        );
        let site = parse_def_signature(&masked, 0, "nested", 8, "ClientMethods").unwrap();
        assert_eq!(site.params.len(), 2);
        assert_eq!(site.params[0].name, "a");
        assert_eq!(site.params[0].line, 0);
        assert!(
            !site.params[0].has_annotation,
            "嵌套默认值里的 ':' 在 depth ≥1"
        );
        assert_eq!(site.params[1].name, "b");
        assert_eq!(site.params[1].line, 2);
        assert_eq!(site.close_paren_line, 2);
        // Coordinates after a CJK parameter + non-BMP (astral surrogate pair, 2 units)
        let masked = python_code_lines("def m(self, 中文, \u{1D11E}note):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert_eq!(site.params[0].name, "中文");
        assert_eq!(site.params[0].start, 12);
        assert_eq!(site.params[1].name, "\u{1D11E}note");
        assert_eq!(site.params[1].start, 16, "astral 名起在 UTF-16 index 16");
        assert_eq!(site.params[1].end, 22, "𝄞 占 2 单元 + note 4 单元");
        // Multi-line mid-edit unclosed signature: EOF truncation produces nothing
        let masked = python_code_lines("    def broken(self,\n        a,\n");
        assert_eq!(
            parse_def_signature(&masked, 0, "broken", 8, "CellMethods"),
            None
        );
    }

    /// Empty parameter segments (trailing commas) are honestly skipped and
    /// produce no phantom parameters.
    #[test]
    fn trailing_comma_skips_empty_segment() {
        let masked = python_code_lines("def m(self, a, ):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert_eq!(site.params.len(), 1);
        assert_eq!(site.params[0].name, "a");
    }

    #[test]
    fn inlay_items_pairing_rules() {
        // Pairing min(declarations, parameters); annotated/star/Any are skipped
        let text = "class Avatar:\n    def foo(self, a, b, c):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        assert_eq!(sites.len(), 1);
        let site = &sites[0];
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT8".into(), "VECTOR3".into(), "UNKNOWN_X".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(site, &decl);
        assert_eq!(items.len(), 2, "UNKNOWN_X 落 Any 不出");
        assert_eq!(
            items[0].position,
            InlayPosition {
                line: 1,
                character: site.params[0].end
            }
        );
        assert_eq!(items[0].text, ": int");
        assert_eq!(items[0].kind, "Parameter");
        assert_eq!(items[1].text, ": Vector3", "VECTOR2/3 直查无闸照出");
        // Annotated parameters are not overwritten
        let text = "class Avatar:\n    def foo(self, a: str, b):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "a 已标注跳过;b 配 VECTOR3 照出");
        assert_eq!(items[0].text, ": Vector3");
        assert_eq!(
            items[0].position,
            InlayPosition {
                line: 1,
                character: sites[0].params[1].end
            }
        );
        // ReturnType
        let text = "class Avatar:\n    def foo(self, a):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT16".into()]),
            declared_return_type: Some("BOOL".into()),
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].text, " -> bool");
        assert_eq!(items[1].kind, "Type");
        assert_eq!(
            items[1].position,
            InlayPosition {
                line: 1,
                character: sites[0].close_paren_character + 1
            }
        );
        // ReturnType falling to Any produces nothing
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT16".into()]),
            declared_return_type: Some("ENTITYCALL".into()),
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "ENTITYCALL 表值 Any 与 fallback 同串不出");
        // More declarations than parameters: pair min
        let text = "class Avatar:\n    def foo(self, a):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT8".into(), "UINT16".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1);
        // A Parameter slot with an Any table value (ENTITYCALL/PYTHON) is skipped
        let text = "class Avatar:\n    def foo(self, a, b):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["ENTITYCALL".into(), "PY_DICT".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "ENTITYCALL 位落 Any 不出;PY_DICT→dict 照出");
        assert_eq!(items[0].text, ": dict");
        // A star slot produces nothing
        let text = "class Avatar:\n    def foo(self, a, *args):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT8".into(), "UINT16".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "*args 位不出");
    }

    #[test]
    fn builtin_direct_gate() {
        assert_eq!(resolve_annotation_direct("UINT8").as_deref(), Some("int"));
        assert_eq!(
            resolve_annotation_direct(" VECTOR3 ").as_deref(),
            Some("Vector3")
        );
        assert_eq!(
            resolve_annotation_direct("Address").as_deref(),
            Some("Address")
        );
        assert_eq!(
            resolve_annotation_direct("ENTITYCALL").as_deref(),
            Some("Any")
        );
        assert_eq!(resolve_annotation_direct("UNKNOWN_X").as_deref(), None);
        assert_eq!(resolve_annotation_direct("ALIAS").as_deref(), None);
        assert_eq!(resolve_annotation_direct("  ").as_deref(), None);
    }

    #[test]
    fn find_def_param_sites_section_gate() {
        // Files outside the sections yield zero sites
        let text = "class Avatar:\n    def foo(self, a):\n        pass\n";
        assert!(find_def_param_sites(text, "/p/scripts/common/util.py").is_empty());
        assert!(find_def_param_sites(text, "/p/scripts/cell/avatar.py").len() == 1);
        // Inside a section with no class: zero sites
        assert!(
            find_def_param_sites("def foo(self):\n    pass\n", "/p/scripts/cell/a.py").is_empty()
        );
    }

    // ---- identity folding / header rejection / lookup boundary faces (COV batch supplement) ----

    /// Path identity folding: UNC prefix / UNC root bound not popped / drive
    /// root not popped / leading .. kept / bare drive lowercased with trailing
    /// slash / POSIX case preserved.
    #[test]
    fn normalize_file_identity_unc_drive_and_dotdot_folds() {
        // UNC prefix + UNC root bound (the srv/share two segments are the floor,
        // .. does not pop through)
        assert_eq!(normalize_file_identity("//Srv/Share/.."), "//srv/share");
        // POSIX absolute root: .. does not pierce the root
        assert_eq!(normalize_file_identity("/.."), "/");
        // Drive root: .. does not pop away C:
        assert_eq!(normalize_file_identity("C:/.."), "c:/");
        // Leading .. without prefix: honestly kept (relative-path identity)
        assert_eq!(normalize_file_identity("a/../../x"), "../x");
        // Bare drive: lowercased + trailing /
        assert_eq!(normalize_file_identity("C:"), "c:/");
        // POSIX keeps case (only drive/unc fold to lowercase)
        assert_eq!(normalize_file_identity("/Scripts/Base"), "/Scripts/Base");
    }

    /// Class-header rejection face and the complete forms with bases / whitespace.
    #[test]
    fn class_header_reject_and_bases_faces() {
        assert_eq!(class_header_of("class"), None);
        assert_eq!(class_header_of("class 1X:"), None);
        assert_eq!(class_header_of("class A(Base)"), None, "缺收尾冒号");
        assert_eq!(
            class_header_of("class A (Base) :"),
            Some(("A".to_string(), "Base".to_string()))
        );
        assert_eq!(
            class_header_of("class A:"),
            Some(("A".to_string(), String::new()))
        );
    }

    /// def-header rejection face: async without whitespace fails / whitespace
    /// between name and paren succeeds / no paren rejected.
    #[test]
    fn def_header_reject_and_space_faces() {
        assert_eq!(def_header_of("asyncdef foo(x)"), None);
        assert_eq!(def_header_of("def foo:"), None);
        assert_eq!(def_header_of("def foo (x):"), Some("foo".to_string()));
    }

    /// index_from boundaries: start out of bounds / no hit / first occurrence after start.
    #[test]
    fn index_from_bounds_and_miss() {
        assert_eq!(index_from("abc", "a", 99), None);
        assert_eq!(index_from("abc", "z", 0), None);
        assert_eq!(index_from("abcabc", "b", 3), Some(4));
    }

    /// crlf text full chain: splitting strips \r, sites still emitted.
    #[test]
    fn crlf_text_still_yields_sites() {
        let text = "class A:\r\n    def f(self, a):\r\n        pass\r\n";
        let sites = find_def_param_sites(text, "/p/scripts/base/mod.py");
        assert_eq!(sites.len(), 1);
        // After stripping the leading self, only a remains
        assert_eq!(sites[0].params.len(), 1);
        assert_eq!(sites[0].params[0].name, "a");
    }

    /// Three return-annotation rejection faces: empty string / ALIAS / Any table
    /// value all produce nothing; engine aliases still emit.
    #[test]
    fn return_annotation_reject_faces_and_alias_emits() {
        let text = "class A:\n    def f(self):\n        pass\n";
        let site = &find_def_param_sites(text, "/p/scripts/cell/a.py")[0];
        for bad in ["", "  ", "ALIAS", "ENTITYCALL"] {
            let decl = DeclarationFace {
                declared_args: None,
                declared_return_type: Some(bad.to_string()),
            };
            assert!(
                build_def_param_inlay_items(site, &decl).is_empty(),
                "{bad:?} 不出返回注解"
            );
        }
        let decl = DeclarationFace {
            declared_args: None,
            declared_return_type: Some("Address".to_string()),
        };
        let items = build_def_param_inlay_items(site, &decl);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, " -> Address");
        assert_eq!(items[0].kind, "Type");
    }
}
