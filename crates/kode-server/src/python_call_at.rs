//! RUST-140 batch 1: the SignatureHelp call-site lexical face (isomorphic point for point with batch 159's TS
//! `getPythonCallAtPosition`, src/backend/pythonLanguageUtils.ts).
//!
//! Single-line lexing: covers the `self.base/cell/client.X(...)` and object-call `avatar.X(...)` shapes;
//! the cursor must sit within "'(' and its argument list" (on the method name does not count); a string-aware deep scan
//! of the argument list fixes the top-level comma active argument; a closed call requires the cursor not to pass the closing
//! bracket (an unclosed call is treated as extending to end of line); among multiple calls on one line take the one starting latest.
//!
//! Batch 1 lands only the pure library + golden comparison (isomorphic with TS tests/kodeDocumentSymbolsParity:
//! vitest directly imports the production `getPythonCallAtPosition` to recompute the same golden -- the strongest
//! production-face <-> Rust-face comparison, zero recomputation drift). The `resolveMethodDefinition` def-semantic parsing
//! and the `textDocument/signatureHelp` LSP wiring stay with batch 2 (the same references/RUST-138
//! boundary stance: server.rs/rpc.rs are being edited concurrently, and the production serving face is still TS).
//!
//! Implementation note: the full scan runs on a UTF-16 unit array (`encode_utf16`), matching TS string semantics unit for unit
//! (regex `\b`/character classes, the `i += 1` escape skip, and the `i < character`
//! comparison all share one coordinate system); the matched tokens are all ASCII, with no cross-system conversion.

use std::collections::BTreeMap;

/// One call-resolution face: receiver ('self' or an object variable name) / method name / receiver-section mapping
/// (base->BaseMethods etc.; None for object calls) / the cursor's argument index (0-based).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PythonCallAtFace {
    #[serde(rename = "receiverName")]
    pub receiver_name: String,
    #[serde(rename = "methodName")]
    pub method_name: String,
    pub section: Option<&'static str>,
    #[serde(rename = "activeArgument")]
    pub active_argument: u32,
}

/// Isomorphic with TS `PYTHON_RECEIVER_SECTIONS`.
fn receiver_section(token_second: &str) -> Option<&'static str> {
    match token_second {
        "base" => Some("BaseMethods"),
        "cell" => Some("CellMethods"),
        "client" => Some("ClientMethods"),
        _ => None,
    }
}

fn is_word(c: u16) -> bool {
    c == b'_' as u16
        || (c >= b'0' as u16 && c <= b'9' as u16)
        || (c >= b'a' as u16 && c <= b'z' as u16)
        || (c >= b'A' as u16 && c <= b'Z' as u16)
}

fn is_ident_start(c: u16) -> bool {
    c == b'_' as u16
        || (c >= b'a' as u16 && c <= b'z' as u16)
        || (c >= b'A' as u16 && c <= b'Z' as u16)
}

fn is_ident_continue(c: u16) -> bool {
    is_ident_start(c) || (c >= b'0' as u16 && c <= b'9' as u16)
}

fn units_start_with(units: &[u16], pos: usize, word: &str) -> bool {
    let bytes = word.as_bytes();
    pos + bytes.len() <= units.len()
        && bytes
            .iter()
            .enumerate()
            .all(|(k, &b)| units[pos + k] == b as u16)
}

fn read_ident(units: &[u16], pos: usize) -> Option<(String, usize)> {
    if pos >= units.len() || !is_ident_start(units[pos]) {
        return None;
    }
    let mut end = pos + 1;
    while end < units.len() && is_ident_continue(units[end]) {
        end += 1;
    }
    Some((String::from_utf16_lossy(&units[pos..end]), end))
}

/// One match attempt: returns (receiver_token, method_name, match_end).
/// Branch order = the TS regex alternation: first the `self.base/cell/client` literal, then
/// the `[A-Za-z_]\w*` generic ident (e.g. `self.foo(` takes the generic arm; receiverToken without a dot
/// -> a non-section receiver).
fn try_match_at(units: &[u16], pos: usize) -> Option<(String, String, usize)> {
    // \b: the start must be a word boundary (the same meaning as TS \b: the preceding neighbor is not \w).
    if pos > 0 && is_word(units[pos - 1]) {
        return None;
    }
    let mut cursor = pos;
    let receiver_token: String;
    let method: String;
    if units_start_with(units, cursor, "self.")
        && (units_start_with(units, cursor + 5, "base.")
            || units_start_with(units, cursor + 5, "cell.")
            || units_start_with(units, cursor + 5, "client."))
    {
        // Branch 1: literal receivers self.base / self.cell / self.client (with the '.' already
        // consumed; the cursor lands directly on the method name).
        let after = units[cursor + 5..].iter().position(|&c| c == b'.' as u16)?;
        let second = String::from_utf16_lossy(&units[cursor + 5..cursor + 5 + after]);
        cursor += 5 + after + 1;
        receiver_token = format!("self.{second}");
        let (ident, end) = read_ident(units, cursor)?;
        method = ident;
        cursor = end;
    } else {
        // Branch 2: a generic ident + `\.` + method (the TS alternation's second arm; e.g.
        // `self.foo(` takes this arm; receiverToken without a dot -> a non-section receiver).
        let (ident, end) = read_ident(units, cursor)?;
        cursor = end;
        receiver_token = ident;
        if cursor >= units.len() || units[cursor] != b'.' as u16 {
            return None;
        }
        cursor += 1;
        let (ident, end) = read_ident(units, cursor)?;
        method = ident;
        cursor = end;
    }
    // `[ \t]*` + `(` (a shared tail for both arms)
    while cursor < units.len() && (units[cursor] == b' ' as u16 || units[cursor] == b'\t' as u16) {
        cursor += 1;
    }
    if cursor >= units.len() || units[cursor] != b'(' as u16 {
        return None;
    }
    Some((receiver_token, method, cursor + 1))
}

/// The TS `getPythonCallAtPosition`-isomorphic body (single line, the UTF-16 unit domain).
/// character is a UTF-16 column (the same coordinate system as TS position.character).
pub fn get_python_call_at_position(line: &str, character: usize) -> Option<PythonCallAtFace> {
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut candidates: Vec<PythonCallAtFace> = Vec::new();
    let mut i = 0usize;
    // Non-overlapping scan (isomorphic with the exec loop: after a hit, continue scanning from the match end).
    while i < units.len() {
        let Some((receiver_token, method_name, match_end)) = try_match_at(&units, i) else {
            i += 1;
            continue;
        };
        let call_open = match_end - 1; // the unit position of '('
        if character < call_open {
            i = match_end;
            continue;
        }
        // A string-aware deep scan of the argument list: top-level commas fix the active argument, and the closing is found along the way.
        let mut depth = 0i32;
        let mut in_string: Option<u16> = None;
        let mut active_argument = 0u32;
        let mut closed = false;
        let mut close_index = 0usize;
        let mut j = call_open;
        while j < units.len() {
            let ch = units[j];
            if let Some(q) = in_string {
                if ch == b'\\' as u16 {
                    j += 1; // skip one unit on escape (the same shape as TS i += 1)
                } else if ch == q {
                    in_string = None;
                }
            } else if ch == b'\'' as u16 || ch == b'"' as u16 {
                in_string = Some(ch);
            } else if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
                depth += 1;
            } else if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
                depth -= 1;
                if depth == 0 {
                    closed = true;
                    close_index = j;
                    break;
                }
            } else if ch == b',' as u16 && depth == 1 && j < character {
                active_argument += 1;
            }
            j += 1;
        }
        // Attribution: a closed call requires the cursor not to pass the closing bracket; an unclosed call is treated as extending to end of line.
        if !(closed && close_index < character) {
            let is_receiver = receiver_token.starts_with("self.");
            let section = if is_receiver {
                receiver_section(receiver_token.split('.').nth(1).unwrap_or(""))
            } else {
                None
            };
            candidates.push(PythonCallAtFace {
                receiver_name: if is_receiver {
                    "self".to_string()
                } else {
                    receiver_token.clone()
                },
                method_name,
                section,
                active_argument,
            });
        }
        i = match_end;
    }
    // For nested/adjacent calls take the one starting latest (match order is callOpen ascending).
    candidates.pop()
}

// ---------------------------------------------------------------------------
// golden (vitest directly imports the production getPythonCallAtPosition for a recomputed comparison)
// ---------------------------------------------------------------------------

pub const PYTHON_CALL_AT_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/python-call-at-parity.json";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenHit {
    line: usize,
    character: usize,
    #[serde(flatten)]
    call: PythonCallAtFace,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    file: String,
    probe_count: usize,
    hits: Vec<GoldenHit>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    probe_count: usize,
    hit_count: usize,
    files: Vec<GoldenFile>,
}

/// .py corpus collection (same roots as PARITY_CORPORA; collect_corpus only takes def/xml, so this face
/// collects .py itself, with BTreeMap lexicographic determinism).
pub(crate) fn collect_python_corpus(repo_root: &std::path::Path) -> BTreeMap<String, String> {
    fn walk(dir: &std::path::Path, rel_prefix: &str, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<std::path::PathBuf> =
            rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let rel = format!("{rel_prefix}/{name}");
            if path.is_dir() {
                walk(&path, &rel, out);
                continue;
            }
            if name.ends_with(".py") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.insert(rel, text);
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    for corpus in kode_parser::json::PARITY_CORPORA {
        walk(&repo_root.join(corpus), corpus, &mut out);
    }
    out
}

/// Walk the .py corpus Walk the .py corpus, probing line by line and position by position (all positions 0..=line length); non-empty hits enter the golden.
/// Files with empty results Files with empty results also enter the list (probeCount reconciliation; vitest probes the same full set, and empty <-> empty is trivially equal,
/// but full-set coverage but full-set coverage guards against missed probes).
pub fn dump_python_call_at_golden(repo_root: &std::path::Path) -> String {
    let corpus = collect_python_corpus(repo_root);
    let mut dump = GoldenDump {
        generator: "kode-server dump-python-call-at-golden",
        file_count: corpus.len(),
        probe_count: 0,
        hit_count: 0,
        files: Vec::new(),
    };
    for (path, text) in &corpus {
        let mut golden_file = GoldenFile {
            file: path.clone(),
            probe_count: 0,
            hits: Vec::new(),
        };
        // Line splitting = '\n', with the line content's trailing '\r' stripped (the same semantics as VS Code lineAt).
        for (idx, raw_line) in text.split('\n').enumerate() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            let units: Vec<u16> = line.encode_utf16().collect();
            // A line with no receiver-call shape has zero hits (trivially null at every position; not stored position by position
            // into the golden; probeCount still counts -- the TS side probes the same full set for reconciliation).
            let mut any_call = false;
            {
                let mut i = 0usize;
                while i < units.len() {
                    if try_match_at(&units, i).is_some() {
                        any_call = true;
                        break;
                    }
                    i += 1;
                }
            }
            if !any_call {
                golden_file.probe_count += units.len() + 1;
                continue;
            }
            for character in 0..=units.len() {
                golden_file.probe_count += 1;
                if let Some(call) = get_python_call_at_position(line, character) {
                    dump.hit_count += 1;
                    golden_file.hits.push(GoldenHit {
                        line: idx + 1,
                        character,
                        call,
                    });
                }
            }
        }
        dump.probe_count += golden_file.probe_count;
        dump.files.push(golden_file);
    }
    serde_json::to_string_pretty(&dump).expect("serialize")
}

// ---------------------------------------------------------------------------
// Unit pins
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn call_at(line: &str, character: usize) -> Option<PythonCallAtFace> {
        get_python_call_at_position(line, character)
    }

    #[test]
    fn section_receiver_faces() {
        // The self.base/cell/client three-section mapping; on the method name (character < callOpen) it does not recognize.
        let line = "self.base.doSpell(1, 2)";
        let open = line.find('(').unwrap();
        assert!(call_at(line, open - 1).is_none(), "方法名上不触发");
        let hit = call_at(line, open).expect("'(' 上触发");
        assert_eq!(hit.receiver_name, "self");
        assert_eq!(hit.method_name, "doSpell");
        assert_eq!(hit.section, Some("BaseMethods"));
        assert_eq!(hit.active_argument, 0);
        let hit2 = call_at(line, open + 2).expect("首实参中段");
        assert_eq!(hit2.active_argument, 0);
        let hit3 = call_at(line, open + 5).expect("第二实参");
        assert_eq!(hit3.active_argument, 1);
        // The comma test = i < character: at character = the comma position it has not passed (0); +1 passes (1).
        let comma = line.find(',').unwrap();
        assert_eq!(call_at(line, comma).unwrap().active_argument, 0);
        assert_eq!(call_at(line, comma + 1).unwrap().active_argument, 1);
    }

    #[test]
    fn cell_and_client_sections_and_object_receiver() {
        let cell = call_at("self.cell.onEnterCell(", "self.cell.onEnterCell(".len()).unwrap();
        assert_eq!(cell.section, Some("CellMethods"));
        let client = call_at("self.client.onLevelUp(", "self.client.onLevelUp(".len()).unwrap();
        assert_eq!(client.section, Some("ClientMethods"));
        // Object call: receiverName = the variable name, section = None.
        let obj = call_at("avatar.learnSkill(1)", "avatar.learnSkill(".len()).unwrap();
        assert_eq!(obj.receiver_name, "avatar");
        assert_eq!(obj.method_name, "learnSkill");
        assert_eq!(obj.section, None);
        // self.<non-section> (self.foo( ): takes the generic ident arm; receiverName=self with no section.
        let plain = call_at("self.foo(", "self.foo(".len()).unwrap();
        assert_eq!(plain.receiver_name, "self");
        assert_eq!(plain.method_name, "foo");
        assert_eq!(plain.section, None);
    }

    #[test]
    fn string_aware_commas_and_escape() {
        // Commas/brackets inside strings do not count for depth; an escaped quote does not close the string.
        // Line = self.base.say("a,b(c", 2): the comma at 17 inside the string does not count; only the top-level comma at 21 does.
        let line = r#"self.base.say("a,b(c", 2)"#;
        let top_comma = line.rfind(',').unwrap();
        assert_eq!(call_at(line, top_comma).unwrap().active_argument, 0);
        assert_eq!(call_at(line, top_comma + 1).unwrap().active_argument, 1);
        let escaped = r#"self.base.say("it\'s, x", 3)"#;
        let comma2 = escaped.rfind(',').unwrap();
        assert_eq!(call_at(escaped, comma2 + 2).unwrap().active_argument, 1);
    }

    #[test]
    fn nested_brackets_depth() {
        // Commas inside nested brackets do not count as top-level; after the closing bracket returns to top level, comma counting resumes.
        let line = "self.base.go(a(1,2), 3)";
        let outer_comma = line.rfind(", 3").unwrap();
        assert_eq!(call_at(line, outer_comma + 2).unwrap().active_argument, 1);
        let inner_comma = line.find("1,2").unwrap() + 1;
        assert_eq!(call_at(line, inner_comma).unwrap().active_argument, 0);
    }

    #[test]
    fn unclosed_extends_and_closed_rejects_after_close() {
        // Unclosed (requesting help mid-typing) is treated as extending to end of line: a hit still lands at the line end.
        let unclosed = call_at("self.base.x(1, 2", 16).unwrap();
        assert_eq!(unclosed.active_argument, 1);
        // A closed call with the cursor past the closing bracket -> not recognized.
        let line = "self.base.x(1) ; rest";
        assert!(call_at(line, line.len()).is_none());
        assert!(call_at(line, line.find(')').unwrap()).is_some());
    }

    #[test]
    fn two_calls_pick_latest_start() {
        // Two calls on one line: with the cursor inside the second call's arguments, take the second call (the one starting latest).
        let line = "self.base.a(1) self.cell.b(2, 3)";
        let second_open = line.rfind('(').unwrap();
        let hit = call_at(line, second_open + 3).unwrap();
        assert_eq!(hit.method_name, "b");
        assert_eq!(hit.section, Some("CellMethods"));
        assert_eq!(hit.active_argument, 1);
    }

    #[test]
    fn property_read_and_plain_calls_rejected() {
        // Property reads (the name not followed by '(') are not recognized; a bare function call f( ) without a receiver dot is not recognized.
        assert!(call_at("self.base.x", 11).is_none());
        assert!(call_at("doSpell(1)", 8).is_none());
    }

    #[test]
    fn nested_calls_innermost_wins() {
        // Nested double-active: outer self.base.a( ... inner self.cell.b( ...); with the cursor inside the
        // inner layer's arguments both candidates are alive (neither the inner nor the outer closing bracket passed) -> take the one starting
        // latest = the inner one (the tightest containment, the same meaning as TS).
        let line = "self.base.a(self.cell.b(1), 3)";
        let probe = line.find("b(").unwrap() + 2;
        let hit = call_at(line, probe).expect("嵌套实参内命中");
        assert_eq!(hit.method_name, "b");
        assert_eq!(hit.section, Some("CellMethods"));
        assert_eq!(hit.active_argument, 0);
    }

    #[test]
    fn word_boundary_no_midword_match() {
        // \b: at position 0 the ident of xself.y( swallows the whole "xself" (receiverName=xself);
        // at position 1 "self.y(" has the word char 'x' as its preceding neighbor -> \b rejects -> no second candidate. If \b were
        // removed, position 1 would add a candidate and, on a callOpen tie, the later-scanned one would win -> the winner would become
        // "self", turning this pin red (\b's observable face = word-interior candidates participate in the tie-break).
        // \b's observable face: at position 0 of myself.cell.y( the branch attempt ("myself" ident ->
        // a '.cell.' tail not followed by '(' fails), then the scan advances to position 1 "self.cell.y(" -- with the word char 'm'
        // as its preceding neighbor -> \b rejects; finally position 6 "cell.y(" hits legitimately at a word boundary ->
        // receiver=cell. If \b were removed, position 1's literal arm would hit falsely and, on a callOpen tie, the later-scanned
        // one would win -> the winner would become self, turning this pin red.
        let line = "myself.cell.y(1)";
        let hit = call_at(line, line.find("y(").unwrap() + 2).expect("实参区内命中");
        assert_eq!(hit.receiver_name, "cell");
        assert_eq!(hit.method_name, "y");
        assert_eq!(hit.section, None);
        // An anchor for normal hits outside word boundaries (in x.self.y( the self's preceding neighbor is a dot; the literal arm does not accept client
        // or other section names, so it takes the generic arm; receiverName=self with no section).
        let ok = "x.self.y(";
        let hit2 = call_at(ok, ok.len() - 1).expect("点后词边界合法命中");
        assert_eq!(hit2.receiver_name, "self");
        assert_eq!(hit2.method_name, "y");
        assert_eq!(hit2.section, None);
    }
}
