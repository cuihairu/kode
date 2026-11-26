//! Per-file extraction core for return annotations (the RUST-MIGRATION-AUDIT-006 B1 lane,
//! batch 3): a line-for-line port of the extraction face of
//! src/backend/pythonReturnTypeInference.ts -- maskCodeLine (single-line quote / comment masking;
//! multi-line triple-quote bodies are not handled = the pre-existing TS semantics),
//! parseLocalAssignmentCall (the single-hop assignment-call shape; the three regexes
//! ASSIGNMENT/SIMPLE_CALL/ATTRIBUTE_CALL are hand-expanded, including the greedy backtracking
//! semantics of `\s*=\s*(?!=)(.+)$` and the JS `.` line-terminator exclusion),
//! collectFileAnnotationFacts (first definition wins; a def present but `->` missing records a
//! null fact that shadows the stale on-disk annotation; 64-line truncation), extractFileImports
//! (from / bare import bindings, wildcards skipped, relative leading dots stripped with a
//! suffix-match approximation). Columns / lengths are always on a UTF-16 code unit basis; the
//! greedy / backtracking semantics of each hand-expanded regex are argued point by point in each
//! fn's note. A callback face is not part of the production contract (the RPC output is the fact
//! sequence itself); collect returns the Vec in one shot for the caller to bucket. No message /
//! workspace machinery leaves this module.

use crate::self_flow::{is_js_line_terminator, is_js_space, is_name_start, is_word};

/// The single-hop call in one `name = rhs` assignment (a plain call f() or a direct attribute
/// call a.b()).
#[derive(Debug, PartialEq)]
pub struct LocalAssignmentCall {
    /// The assigned variable name (a plain identifier, no dots).
    pub target: String,
    /// The receiver of a direct attribute call (the a of a.b()); None for a plain call f().
    pub receiver: Option<String>,
    /// The called function / method name.
    pub method_name: String,
}

/// One annotation fact (first definition wins; annotation=None = the def is present but `->` is
/// missing, shadowing the disk).
#[derive(Debug, PartialEq)]
pub struct FileAnnotationFact {
    pub name: String,
    pub annotation: Option<String>,
}

/// A `from mod import original as local` binding (keeps the imported original symbol name).
#[derive(Debug, PartialEq)]
pub struct FromImportBindingFace {
    /// The binding name (the alias when present, otherwise the original symbol).
    pub local: String,
    /// The module path (leading dots stripped, `.` -> `/`).
    pub module: String,
    /// The imported original symbol name.
    pub symbol: String,
}

/// An `import X [as Y]` binding (receiver Y/X onto module X).
#[derive(Debug, PartialEq)]
pub struct BareImportBindingFace {
    pub local: String,
    pub module: String,
}

#[derive(Debug, PartialEq)]
pub struct FileImportBindings {
    pub names: Vec<FromImportBindingFace>,
    pub receivers: Vec<BareImportBindingFace>,
}

/// A per-line call fact (line numbers 0-based; input = the whole masked text split on '\n').
#[derive(Debug, PartialEq)]
pub struct LineAssignmentCall {
    pub line: usize,
    pub target: String,
    pub receiver: Option<String>,
    pub method_name: String,
}

fn eq_ascii(text: &[u16], at: usize, word: &str) -> bool {
    let bytes = word.as_bytes();
    if at + bytes.len() > text.len() {
        return false;
    }
    text[at..at + bytes.len()]
        .iter()
        .zip(bytes.iter())
        .all(|(a, b)| *a == u16::from(*b))
}

fn slice3_is(text: &[u16], at: usize, quote: u16) -> bool {
    text.get(at) == Some(&quote)
        && text.get(at + 1) == Some(&quote)
        && text.get(at + 2) == Some(&quote)
}

/// JS `String.prototype.trim`: trim both ends over the full JS `\s` class (including
/// \u2028/\u2029/BOM; a different set from Rust's char::is_whitespace, so it is not
/// substituted)
fn js_trim_range(text: &[u16]) -> (usize, usize) {
    let mut start = 0usize;
    while start < text.len() && is_js_space(text[start]) {
        start += 1;
    }
    let mut end = text.len();
    while end > start && is_js_space(text[end - 1]) {
        end -= 1;
    }
    (start, end)
}

fn js_trim(text: &[u16]) -> Vec<u16> {
    let (start, end) = js_trim_range(text);
    text[start..end].to_vec()
}

fn from_utf16(units: &[u16]) -> String {
    String::from_utf16(units).unwrap_or_default()
}

/// TS maskCodeLine (a verbatim port of pythonReturnTypeInference.ts:48-73): single-line quote /
/// comment masking -- inside quotes each code unit becomes whitespace (an escape `\\` occupies
/// two units, a closing quote one unit, a triple open / close three underscore placeholders each),
/// and the tail from `#` is all whitespace. **Multi-line triple-quote bodies are not handled**
/// (the quote state does not span lines and resets each line = the pre-existing TS semantics;
/// the multi-line body is masked by the caller over the whole text, KR-AUD-64). raw[col] is a
/// UTF-16 code-unit access, as is slice(col,col+3).
pub fn mask_code_line(raw: &[u16]) -> Vec<u16> {
    let mut quote: u16 = 0;
    let mut triple = false;
    let mut masked: Vec<u16> = Vec::with_capacity(raw.len());
    let mut col = 0usize;
    while col < raw.len() {
        let ch = raw[col];
        if quote != 0 {
            if ch == 0x5C {
                // `masked += '  '; col += 1; continue;` (+ the loop increment = 2 in total)
                masked.push(0x20);
                masked.push(0x20);
                col += 2;
                continue;
            }
            if triple && slice3_is(raw, col, quote) {
                quote = 0;
                triple = false;
                masked.extend_from_slice(&[0x20, 0x20, 0x20]);
                col += 3;
                continue;
            } else if !triple && ch == quote {
                quote = 0;
                masked.push(0x20);
                col += 1;
                continue;
            } else {
                masked.push(0x20);
                col += 1;
                continue;
            }
        }
        if ch == 0x23 {
            // `masked += ' '.repeat(raw.length - col); break;`
            masked.resize(masked.len() + (raw.len() - col), 0x20);
            break;
        }
        if ch == 0x27 || ch == 0x22 {
            quote = ch;
            triple = slice3_is(raw, col, ch);
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
    masked
}

/// Hand-expansion of `^\s*def\s+([A-Za-z_]\w*)\s*\(`. Backtracking argument: the character
/// following each greedy `\s*` ('d' / the name's first unit / '(' is never whitespace) and the
/// character following the greedy name (a non-word unit) can never be given back, so a single
/// scan pass is equivalent. `\s` is the full JS class (is_js_space).
fn match_def_head(masked: &[u16]) -> Option<Vec<u16>> {
    let mut i = 0usize;
    while i < masked.len() && is_js_space(masked[i]) {
        i += 1;
    }
    if !eq_ascii(masked, i, "def") {
        return None;
    }
    let mut j = i + 3;
    let ws_start = j;
    while j < masked.len() && is_js_space(masked[j]) {
        j += 1;
    }
    if j == ws_start {
        return None; // `\s+` requires at least one whitespace
    }
    if !is_name_start(masked.get(j).copied().unwrap_or(0)) {
        return None;
    }
    let name_start = j;
    j += 1;
    while j < masked.len() && is_word(masked[j]) {
        j += 1;
    }
    let name_end = j;
    while j < masked.len() && is_js_space(masked[j]) {
        j += 1;
    }
    if masked.get(j) != Some(&0x28) {
        return None;
    }
    Some(masked[name_start..name_end].to_vec())
}

/// Hand-expansion of `^(\s*)([A-Za-z_]\w*)\s*=\s*(?!=)(.+)$` (ASSIGNMENT_PATTERN).
/// Semantics of the tail `\s*=\s*(?!=)(.+)$`: the `\s*` after `=` first greedily consumes all the
/// whitespace, and only when the lookahead (not '=') fails does it retreat unit by unit (`x == 5`
/// has no whitespace to retreat from -> the whole match fails; `x =  = 5` retreats one unit -> the
/// capture starts at the last whitespace, including the residual `= 5`); the `.` of `(.+)$`
/// excludes JS line terminators -- if the capture region contains a lone \r/ /  the whole
/// capture fails (matching TS's `(.+)$`). In the normal case where the line holds no terminator,
/// the capture = "from the first position after `=` that is not (the lookahead '=') to end of
/// line".
fn parse_assignment_head(line: &[u16]) -> Option<(Vec<u16>, usize)> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !is_name_start(line.get(i).copied().unwrap_or(0)) {
        return None;
    }
    let name_start = i;
    i += 1;
    while i < line.len() && is_word(line[i]) {
        i += 1;
    }
    let name_end = i;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if line.get(i) != Some(&0x3D) {
        return None;
    }
    let eq = i; // the position of '='
                // `\s*` greedy: consume all whitespace after '='
    let mut e = eq + 1;
    while e < line.len() && is_js_space(line[e]) {
        e += 1;
    }
    let mut rhs_start: Option<usize> = None;
    if e < line.len() && line[e] != 0x3D && first_terminator_from(line, e).is_none() {
        rhs_start = Some(e);
    } else if e > eq + 1 && first_terminator_from(line, e - 1).is_none() {
        // Retreat one unit: line[e-1] is whitespace by construction (not '='); the capture region must
        // hold no terminator
        rhs_start = Some(e - 1);
    }
    let start = rhs_start?;
    Some((line[name_start..name_end].to_vec(), start))
}

fn first_terminator_from(text: &[u16], from: usize) -> Option<usize> {
    (from..text.len()).find(|&i| is_js_line_terminator(text[i]))
}

/// On rhs, `^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(` (ATTRIBUTE_CALL):
/// the characters following the greedy name / whitespace ('.', '.', '?' -- '(' is neither a word
/// unit nor whitespace) can never be given back, so a single scan pass suffices.
fn match_attribute_call(rhs: &[u16]) -> Option<(Vec<u16>, Vec<u16>)> {
    if !is_name_start(rhs.first().copied().unwrap_or(0)) {
        return None;
    }
    let mut i = 1usize;
    while i < rhs.len() && is_word(rhs[i]) {
        i += 1;
    }
    let recv = rhs[..i].to_vec();
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if rhs.get(i) != Some(&0x2E) {
        return None;
    }
    i += 1;
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if !is_name_start(rhs.get(i).copied().unwrap_or(0)) {
        return None;
    }
    let m_start = i;
    i += 1;
    while i < rhs.len() && is_word(rhs[i]) {
        i += 1;
    }
    let method = rhs[m_start..i].to_vec();
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if rhs.get(i) != Some(&0x28) {
        return None;
    }
    Some((recv, method))
}

/// On rhs, `^([A-Za-z_]\w*)\s*\(` (SIMPLE_CALL)
fn match_simple_call(rhs: &[u16]) -> Option<Vec<u16>> {
    if !is_name_start(rhs.first().copied().unwrap_or(0)) {
        return None;
    }
    let mut i = 1usize;
    while i < rhs.len() && is_word(rhs[i]) {
        i += 1;
    }
    let name = rhs[..i].to_vec();
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if rhs.get(i) != Some(&0x28) {
        return None;
    }
    Some(name)
}

fn contains_dot(text: &[u16]) -> bool {
    text.contains(&0x2E)
}

/// parseLocalAssignmentCall (a verbatim port of :79-94): a single-line assignment parse, where
/// the right-hand side must be "one whole single-hop call" (a direct attribute call takes
/// priority, then a plain call with no dot in the rhs); chained / binary / literal -> None. The
/// rhs is masked with maskCodeLine and then trimmed (a `)` inside quotes surfaces, comments are
/// removed).
pub fn parse_local_assignment_call(line: &[u16]) -> Option<LocalAssignmentCall> {
    let (target, rhs_start) = parse_assignment_head(line)?;
    let rhs_raw = &line[rhs_start..];
    let masked = mask_code_line(rhs_raw);
    let rhs = js_trim(&masked);
    let ends_with_paren = rhs.last() == Some(&0x29);
    if let Some((receiver, method)) = match_attribute_call(&rhs) {
        if ends_with_paren {
            return Some(LocalAssignmentCall {
                target: from_utf16(&target),
                receiver: Some(from_utf16(&receiver)),
                method_name: from_utf16(&method),
            });
        }
    }
    if let Some(name) = match_simple_call(&rhs) {
        if ends_with_paren && !contains_dot(&rhs) {
            return Some(LocalAssignmentCall {
                target: from_utf16(&target),
                receiver: None,
                method_name: from_utf16(&name),
            });
        }
    }
    None
}

/// collectFileAnnotationFacts (a verbatim port of :202-236; the callback face becomes a one-shot
/// return of the fact sequence, ordered = the record firing order): first definition wins (a def
/// present but `->` missing records annotation=None); an incomplete signature neither swallows
/// later definitions nor borrows a later colon / annotation; the 64-line truncation drops the
/// current one.
pub fn collect_file_annotation_facts(text: &[u16]) -> Vec<FileAnnotationFact> {
    let mut facts = Vec::new();
    let mut seen: std::collections::HashSet<Vec<u16>> = std::collections::HashSet::new();
    struct Current {
        name: Vec<u16>,
        signature: Vec<u16>,
        depth: usize,
        saw_parens: bool,
        lines: usize,
    }
    let mut current: Option<Current> = None;
    for raw_line in crate::self_flow::split_crlf(text) {
        let masked = mask_code_line(&raw_line);
        let next_def = match_def_head(&masked);
        // An incomplete signature must not swallow later definitions, nor borrow their colon or annotation
        if current.is_some() && next_def.is_some() {
            current = None;
        }
        if current.is_none() {
            let Some(name) = next_def else { continue };
            if seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());
            current = Some(Current {
                name,
                signature: Vec::new(),
                depth: 0,
                saw_parens: false,
                lines: 0,
            });
        }
        let mut closed = false;
        {
            let cur = current.as_mut().expect("current set above");
            cur.lines += 1;
            for &ch in masked.iter() {
                if ch == 0x28 {
                    cur.depth += 1;
                    cur.saw_parens = true;
                } else if ch == 0x29 {
                    cur.depth = cur.depth.saturating_sub(1);
                } else if ch == 0x3A && cur.saw_parens && cur.depth == 0 {
                    let arrow = find_arrow(&cur.signature);
                    let annotation = if arrow < 0 {
                        Vec::new()
                    } else {
                        js_trim(&cur.signature[(arrow as usize + 2)..])
                    };
                    facts.push(FileAnnotationFact {
                        name: from_utf16(&cur.name),
                        annotation: if annotation.is_empty() {
                            None
                        } else {
                            Some(from_utf16(&annotation))
                        },
                    });
                    closed = true;
                    break;
                }
                cur.signature.push(ch);
            }
        }
        if closed {
            current = None;
        } else if let Some(cur) = &current {
            if cur.lines >= 64 {
                current = None;
            }
        }
    }
    facts
}

/// `signature.indexOf('->')` (a UTF-16 code-unit scan, `-` and `>` adjacent)
fn find_arrow(signature: &[u16]) -> i64 {
    if signature.len() < 2 {
        return -1;
    }
    for i in 0..signature.len() - 1 {
        if signature[i] == 0x2D && signature[i + 1] == 0x3E {
            return i as i64;
        }
    }
    -1
}

/// Hand-expansion of `^\s*from\s+([.\w]+)\s+import\s+([^#]*?)(?:#.*)?$` (FROM_IMPORT):
/// the greedy module `[.\w]+` must be followed by whitespace (a class-internal character can never
/// be given back); whitespace is required after the literal `import`; the lazy capture
/// `([^#]*?)(?:#.*)?$` nets out as "from 'import' + whitespace to the first '#' or end of line"
/// (the capture excludes '#', and the remainder is either empty or starts with '#').
fn match_from_import(line: &[u16]) -> Option<(Vec<u16>, Vec<u16>)> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !eq_ascii(line, i, "from") {
        return None;
    }
    let mut j = i + 4;
    let ws = j;
    while j < line.len() && is_js_space(line[j]) {
        j += 1;
    }
    if j == ws {
        return None;
    }
    let mod_start = j;
    while j < line.len() && (is_word(line[j]) || line[j] == 0x2E) {
        j += 1;
    }
    if j == mod_start {
        return None;
    }
    let module = line[mod_start..j].to_vec();
    let ws = j;
    while j < line.len() && is_js_space(line[j]) {
        j += 1;
    }
    if j == ws || !eq_ascii(line, j, "import") {
        return None;
    }
    let mut k = j + 6;
    let ws = k;
    while k < line.len() && is_js_space(line[k]) {
        k += 1;
    }
    if k == ws {
        return None;
    }
    let capture_end = line[k..]
        .iter()
        .position(|&c| c == 0x23)
        .map_or(line.len(), |off| k + off);
    Some((module, line[k..capture_end].to_vec()))
}

/// Hand-expansion of `^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$` (IMPORT_ALIAS,
/// anchored at both ends): after the greedy name the remainder being empty -> no alias;
/// otherwise `\s+as\s+name` must end exactly at line end (`x as y z` class leftovers fail, as
/// TS judges).
fn match_import_alias(part: &[u16]) -> Option<(Vec<u16>, Option<Vec<u16>>)> {
    if !is_name_start(part.first().copied().unwrap_or(0)) {
        return None;
    }
    let mut i = 1usize;
    while i < part.len() && is_word(part[i]) {
        i += 1;
    }
    let name = part[..i].to_vec();
    if i == part.len() {
        return Some((name, None));
    }
    let ws = i;
    while i < part.len() && is_js_space(part[i]) {
        i += 1;
    }
    if i == ws || !eq_ascii(part, i, "as") {
        return None;
    }
    let mut j = i + 2;
    let ws = j;
    while j < part.len() && is_js_space(part[j]) {
        j += 1;
    }
    if j == ws || !is_name_start(part.get(j).copied().unwrap_or(0)) {
        return None;
    }
    let a_start = j;
    j += 1;
    while j < part.len() && is_word(part[j]) {
        j += 1;
    }
    if j != part.len() {
        return None;
    }
    Some((name, Some(part[a_start..j].to_vec())))
}

/// `^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$`
/// Hand-expansion (BARE_IMPORT): after the greedy dotted segments, first try the aliased form
/// (`\s+as\s+name`) then the non-aliased one (`\s*(?:#.*)?$`); retreating the segment count is the
/// regex's `(\.\w+)*` loop backtracking (a `\w*` truncation inside a segment always leaves a word
/// unit, so it cannot be given back -- only the '.' boundaries need enumerating).
fn match_bare_import(line: &[u16]) -> Option<(Vec<u16>, Option<Vec<u16>>)> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !eq_ascii(line, i, "import") {
        return None;
    }
    let mut j = i + 6;
    let ws = j;
    while j < line.len() && is_js_space(line[j]) {
        j += 1;
    }
    if j == ws {
        return None;
    }
    // First segment [A-Za-z_]\w*
    if !is_name_start(line.get(j).copied().unwrap_or(0)) {
        return None;
    }
    let first_start = j;
    j += 1;
    while j < line.len() && is_word(line[j]) {
        j += 1;
    }
    // Greedily collect the '.'+name segment boundaries (each segment's endpoint)
    let mut seg_ends: Vec<usize> = vec![j];
    while j < line.len() && line[j] == 0x2E {
        let mut k = j + 1;
        if !is_name_start(line.get(k).copied().unwrap_or(0)) {
            break;
        }
        k += 1;
        while k < line.len() && is_word(line[k]) {
            k += 1;
        }
        seg_ends.push(k);
        j = k;
    }
    let first_seg_end = seg_ends[0];
    // Segment count from many to few (greedy backtracking); for a fixed count, try the aliased form
    // first, then the non-aliased one.
    for &mod_end in seg_ends.iter().rev() {
        // Aliased: \s+ 'as' \s+ name -> \s* (?:#.*)? $
        let mut t = mod_end;
        let ws = t;
        while t < line.len() && is_js_space(line[t]) {
            t += 1;
        }
        if t > ws && eq_ascii(line, t, "as") {
            let mut u = t + 2;
            let ws = u;
            while u < line.len() && is_js_space(line[u]) {
                u += 1;
            }
            if u > ws && is_name_start(line.get(u).copied().unwrap_or(0)) {
                let a_start = u;
                u += 1;
                while u < line.len() && is_word(line[u]) {
                    u += 1;
                }
                if tail_matches(line, u) {
                    return Some((
                        line[first_start..mod_end].to_vec(),
                        Some(line[a_start..u].to_vec()),
                    ));
                }
            }
        }
        // Non-aliased: \s* (?:#.*)? $
        let mut t = mod_end;
        while t < line.len() && is_js_space(line[t]) {
            t += 1;
        }
        if tail_matches(line, t) {
            return Some((line[first_start..mod_end].to_vec(), None));
        }
    }
    let _ = first_seg_end;
    None
}

/// The `\s*(?:#.*)?$` tail criterion: after skipping whitespace, either a '#' comment or straight
/// to end of line
fn tail_matches(line: &[u16], mut t: usize) -> bool {
    while t < line.len() && is_js_space(line[t]) {
        t += 1;
    }
    t == line.len() || line[t] == 0x23
}

/// extractFileImports (a verbatim port of :799-826): iterate in line order, keeping the from
/// bindings (wildcards skipped, module leading dots stripped + dot -> slash) and the bare bindings
/// (an alias binds the full dotted path, no alias keeps a single segment) in separate lists; the
/// same-name duplicate set-overwrite semantics are absorbed by the caller's Map, so insertion order
/// is preserved here.
pub fn extract_file_imports(lines: &[Vec<u16>]) -> FileImportBindings {
    let mut names: Vec<FromImportBindingFace> = Vec::new();
    let mut receivers: Vec<BareImportBindingFace> = Vec::new();
    for raw in lines {
        let line = raw;
        if let Some((module_raw, capture)) = match_from_import(line) {
            // replace(/^[.]+/, '').replace(/\./g, '/')
            let mut m_start = 0usize;
            while m_start < module_raw.len() && module_raw[m_start] == 0x2E {
                m_start += 1;
            }
            let mut module: Vec<u16> = Vec::new();
            for &c in &module_raw[m_start..] {
                module.push(if c == 0x2E { 0x2F } else { c });
            }
            if module.is_empty() || capture.contains(&0x2A) {
                continue;
            }
            // capture.split(','): trim each part, then IMPORT_ALIAS
            let mut part_start = 0usize;
            loop {
                let split = capture[part_start..]
                    .iter()
                    .position(|&c| c == 0x2C)
                    .map_or(capture.len(), |off| part_start + off);
                let part = &capture[part_start..split];
                let trimmed = js_trim(part);
                if let Some((name, alias)) = match_import_alias(&trimmed) {
                    let local = alias.clone().unwrap_or_else(|| name.clone());
                    names.push(FromImportBindingFace {
                        local: from_utf16(&local),
                        module: from_utf16(&module),
                        symbol: from_utf16(&name),
                    });
                }
                if split == capture.len() {
                    break;
                }
                part_start = split + 1;
            }
            continue;
        }
        if let Some((dotted, alias)) = match_bare_import(line) {
            // firstSegment = dotted.split('.')[0]
            let first_end = dotted
                .iter()
                .position(|&c| c == 0x2E)
                .unwrap_or(dotted.len());
            let first_segment = &dotted[..first_end];
            let module: Vec<u16> = if alias.is_some() {
                dotted
                    .iter()
                    .map(|&c| if c == 0x2E { 0x2F } else { c })
                    .collect()
            } else {
                first_segment.to_vec()
            };
            let local = alias.unwrap_or_else(|| first_segment.to_vec());
            receivers.push(BareImportBindingFace {
                local: from_utf16(&local),
                module: from_utf16(&module),
            });
        }
    }
    FileImportBindings { names, receivers }
}

// ---- unit tests -----------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn u(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn parse(line: &str) -> Option<LocalAssignmentCall> {
        parse_local_assignment_call(&u(line))
    }

    // ---- maskCodeLine ----

    #[test]
    fn mask_string_literal_same_length() {
        assert_eq!(mask_code_line(&u("\"abc\"")), u("_    "));
        assert_eq!(mask_code_line(&u("'x'")), u("_  "));
    }

    #[test]
    fn mask_triple_opener_three_underscores() {
        assert_eq!(mask_code_line(&u("x = \"\"\"abc")), u("x = ___   "));
    }

    #[test]
    fn mask_escape_two_spaces() {
        assert_eq!(mask_code_line(&u("\"a\\\"b\"")), u("_     "));
    }

    #[test]
    fn mask_comment_tail_all_spaces() {
        assert_eq!(mask_code_line(&u("x = 1 # hi")), u("x = 1     "));
    }

    // ---- parseLocalAssignmentCall ----

    #[test]
    fn attribute_call_hit() {
        assert_eq!(
            parse("data = activity_data.get_data()"),
            Some(LocalAssignmentCall {
                target: "data".into(),
                receiver: Some("activity_data".into()),
                method_name: "get_data".into(),
            })
        );
    }

    #[test]
    fn simple_call_hit() {
        assert_eq!(
            parse("x = make()"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: None,
                method_name: "make".into(),
            })
        );
    }

    #[test]
    fn chained_call_rejected() {
        assert_eq!(parse("x = f().g()"), None);
    }

    #[test]
    fn equality_not_assignment() {
        assert_eq!(parse("x == 5"), None);
    }

    #[test]
    fn plain_rhs_rejected() {
        assert_eq!(parse("x = 5"), None);
        assert_eq!(parse("x = (a)"), None);
        assert_eq!(parse("x ="), None);
    }

    #[test]
    fn spaced_attribute_form_hit() {
        assert_eq!(
            parse("x = obj . m ()"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: Some("obj".into()),
                method_name: "m".into(),
            })
        );
    }

    #[test]
    fn quoted_rhs_masked_then_call_visible() {
        // After the quote body is masked the `)` surfaces, so the plain call matches
        assert_eq!(
            parse("x = f(\"s\")"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: None,
                method_name: "f".into(),
            })
        );
    }

    #[test]
    fn comment_stripped_from_rhs() {
        assert_eq!(
            parse("x = f() # note"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: None,
                method_name: "f".into(),
            })
        );
    }

    #[test]
    fn assignment_with_stray_eq_still_matches_head() {
        // `x =  = 5`: back up one char to capture "= 5" -> not a call, None (but the assignment head still holds)
        assert_eq!(parse("x =  = 5"), None);
    }

    #[test]
    fn lone_cr_in_rhs_fails_whole_match() {
        // A lone in-line \r makes `(.+)$` fail as a whole (JS `.` excludes line terminators)
        let text = "x = f(\rx)";
        assert_eq!(parse(text), None);
    }

    #[test]
    fn dotted_target_rejected() {
        assert_eq!(parse("x.y = f()"), None);
    }

    // ---- collectFileAnnotationFacts ----

    #[test]
    fn facts_annotation_and_missing() {
        let text = u("def a() -> int:\n    return 1\ndef b():\n    return 2\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].name, "a");
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
        assert_eq!(facts[1].name, "b");
        assert_eq!(facts[1].annotation, None);
    }

    #[test]
    fn facts_first_definition_wins() {
        let text = u("def a() -> int:\n    pass\ndef a() -> str:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    #[test]
    fn facts_multiline_signature() {
        let text = u("def a(x: int,\n    y: str) -> JSONDATA:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].annotation.as_deref(), Some("JSONDATA"));
    }

    #[test]
    fn facts_truncated_signature_does_not_borrow_next() {
        // The first signature, unclosed, is cut off by the second def: the first name has no fact
        // (interrupted, not within the 64-line truncation), the second name carries the annotation
        let mut text = String::from("def a(\n");
        for _ in 0..3 {
            text.push_str("    param,\n");
        }
        text.push_str("def b() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&u(&text));
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "b");
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    #[test]
    fn facts_sixty_four_line_cap_drops() {
        let mut text = String::from("def a(\n");
        for _ in 0..70 {
            text.push_str("    param,\n");
        }
        text.push_str("def b() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&u(&text));
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "b");
    }

    #[test]
    fn facts_def_in_string_masked_out() {
        let text = u("s = \"def fake() -> Ghost:\"\ndef real() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "real");
    }

    #[test]
    fn facts_comment_mention_masked_out() {
        let text = u("# def fake() -> Ghost:\ndef real() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "real");
    }

    #[test]
    fn facts_crlf_split() {
        let text = u("def a() -> int:\r\n    pass\r\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    // ---- extractFileImports ----

    #[test]
    fn from_import_with_alias_and_plain() {
        let lines = vec![u("from mods import Good as G, Bad")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.names.len(), 2);
        assert_eq!(out.names[0].local, "G");
        assert_eq!(out.names[0].module, "mods");
        assert_eq!(out.names[0].symbol, "Good");
        assert_eq!(out.names[1].local, "Bad");
        assert_eq!(out.names[1].symbol, "Bad");
        assert!(out.receivers.is_empty());
    }

    #[test]
    fn relative_dots_stripped_and_slashed() {
        let lines = vec![u("from .rel.path import x")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.names[0].module, "rel/path");
    }

    #[test]
    fn wildcard_skipped() {
        let lines = vec![u("from m import *")];
        let out = extract_file_imports(&lines);
        assert!(out.names.is_empty());
    }

    #[test]
    fn comment_after_capture_stripped() {
        let lines = vec![u("from m import x # note")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.names[0].local, "x");
    }

    #[test]
    fn bare_import_alias_binds_full_dotted_path() {
        let lines = vec![u("import pkg.good as g")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers[0].local, "g");
        assert_eq!(out.receivers[0].module, "pkg/good");
    }

    #[test]
    fn bare_import_no_alias_single_segment() {
        let lines = vec![u("import pkg.good")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers[0].local, "pkg");
        assert_eq!(out.receivers[0].module, "pkg");
    }

    #[test]
    fn bare_import_with_comment() {
        let lines = vec![u("import time # as note")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers[0].local, "time");
        assert_eq!(out.receivers[0].module, "time");
    }

    #[test]
    fn malformed_imports_rejected() {
        let lines = vec![
            u("import a..b"),
            u("import a as"),
            u("import a as b c"),
            u("from a import"),
            u("from import x"),
        ];
        let out = extract_file_imports(&lines);
        assert!(out.names.is_empty());
        assert!(out.receivers.is_empty());
    }

    #[test]
    fn mixed_names_and_receivers_order() {
        let lines = vec![u("import base"), u("from mods import Good"), u("x = 1")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers.len(), 1);
        assert_eq!(out.names.len(), 1);
        assert_eq!(out.names[0].local, "Good");
    }

    // ---- COV-043: direct hits on the mask/matcher residual arms ------------

    #[test]
    fn mask_triple_quote_opens_and_closes_in_one_line() {
        // Triple quotes opening and closing on one line: open = three underscores placeholder,
        // body = per-code-unit blanks, close = three blanks
        let masked = mask_code_line(&u("s = \"\"\"abc\"\"\""));
        assert_eq!(from_utf16(&masked), "s = ___      ");
    }

    #[test]
    fn def_head_failure_and_space_tolerant_arms() {
        // No whitespace after the keyword (defg) / name's first unit not a word char (def 1x) /
        // no paren after the name (def q:) each fall to None; whitespace before the paren
        // (def f (x)) is a legitimate hit and the annotation is extracted as usual
        let text = u("defg(x):\ndef 1x():\ndef q:\ndef f (x) -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1, "{facts:?}");
        assert_eq!(facts[0].name, "f");
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    #[test]
    fn assignment_head_leading_space_and_bad_name_arms() {
        // Indented assignment (x = f() inside an indented block) is legitimate; a name whose
        // first unit is not a word char falls to None
        let hit = parse("    x = f()");
        assert_eq!(
            hit.map(|c| (c.target, c.receiver, c.method_name)),
            Some(("x".to_string(), None, "f".to_string()))
        );
        assert!(parse("1x = f()").is_none());
    }

    #[test]
    fn call_matcher_residual_arms() {
        // Direct attribute call: first unit after the dot not a name char / no paren after the
        // method -> None
        assert!(parse("x = a.1b()").is_none());
        assert!(parse("x = a.b").is_none());
        // Plain call: whitespace between the name and the paren is a legitimate hit; no paren
        // after the name -> None
        let spaced = parse("x = f ()");
        assert_eq!(
            spaced.map(|c| (c.target, c.method_name)),
            Some(("x".to_string(), "f".to_string()))
        );
        assert!(parse("x = f").is_none());
        // The attribute-call prefix hits but the RHS does not end at `)` (a binary expression)
        // -> None as a whole
        assert!(parse("x = a.b() + 1").is_none());
    }

    #[test]
    fn facts_truncate_after_64_unclosed_lines() {
        // Signature spans 64 lines unclosed: truncation drops the current one (f must not be
        // produced); later definitions are collected as usual
        let mut text = String::from("def f(\n");
        for _ in 0..63 {
            text.push_str("    filler\n");
        }
        text.push_str("def g() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&u(&text));
        assert_eq!(facts.len(), 1, "{facts:?}");
        assert_eq!(facts[0].name, "g");
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    #[test]
    fn from_import_leading_space_and_module_arms() {
        // An indented from import is legitimate; no whitespace after from / an empty module
        // segment each fall to None
        let out = extract_file_imports(&[u("    from m import x")]);
        assert_eq!(out.names.len(), 1);
        assert_eq!(out.names[0].local, "x");
        let bad = extract_file_imports(&[u("frommod import x"), u("from # import y")]);
        assert!(bad.names.is_empty() && bad.receivers.is_empty());
    }

    #[test]
    fn import_alias_residual_arms() {
        let lines = vec![
            u("from m import 1x"),       // name's first unit not a word char
            u("from m import x y"),      // residual segment is not `as`
            u("from m import x as"),     // no name after `as`
            u("from m import x as yz"),  // multi-char alias
            u("from m import x as y z"), // residual segment after the alias
        ];
        let out = extract_file_imports(&lines);
        assert_eq!(out.names.len(), 1, "{:?}", out.names);
        assert_eq!(out.names[0].local, "yz");
        assert_eq!(out.names[0].symbol, "x");
        assert_eq!(out.names[0].module, "m");
    }

    #[test]
    fn bare_import_residual_arms() {
        let lines = vec![
            u("    import time"),  // indented bare import
            u("importx"),          // no whitespace after import
            u("import 1x"),        // segment starts with a non-word char
            u("import a.b as cd"), // multi-char alias
        ];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers.len(), 2, "{:?}", out.receivers);
        assert_eq!(out.receivers[0].local, "time");
        assert_eq!(out.receivers[0].module, "time");
        assert_eq!(out.receivers[1].local, "cd");
        assert_eq!(out.receivers[1].module, "a/b");
    }
}
