//! The Python method-call layered-resolution decision core (RUST-145 batch 1): isomorphic with
//! src/backend/pythonMethodCallQueries.ts -- method-block parsing (the index's first scan /
//! unsaved-document override share it) + outgoing binding resolution (exact file+name -> same-name fallback -> dedup)
//! plus incoming full scanning (process-scope filtering / open-document override / skipping not-yet-indexed open files).
//! Pure library, zero RPC; golden-corpus comparison (tests/python_method_calls_golden.rs regenerates
//! the comparison, driven by the TS-side tests/kodePythonMethodCallsParity.test.ts recomputing the production functions).
//!
//! Fidelity stance (isomorphic path by path with the TS regex):
//! - the full JS `\s` set (including \u00a0/\u2000-\u200a/\u3000/\ufeff, etc.) -- indentation counting and
//!   blank-line detection both use it; a `\u3000` full-width-space line counts as blank under the JS trim semantics;
//! - the def-line regex `^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(`: the async path is tried first
//!   (the greedy optional group); on total failure it falls back to the bare-def path (JS backtracking semantics);
//! - the method-name column = the JS `indexOf(name)` first occurrence in the whole line (not the regex hit position) -- in `def de(self)`
//!   indexOf("de") hits column 0 inside the "def" prefix; an honest isomorphism on both ends;
//! - the self-call regex `\bself\.([A-Za-z_]\w*)\s*\(`: a word boundary (the preceding character is not
//!   [A-Za-z0-9_]), a greedy ident, `\s*(`; if a non-`(` follows the ident, the whole attempt fails and it advances by one;
//!   strings/comments are not seen through (a regex blind spot, consistent on both ends);
//! - the column domain is UTF-16 (the LSP face): CJK prefixes count in code units.
use crate::def_param_hints::{infer_method_section_from_python_file, normalize_file_identity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The full JS `\s` (regex) set; also the whitespace set of JS String.trim (with no extra characters).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_cont(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// JS trim emptiness judgment: every character is JS whitespace (the empty string included).
fn js_trim_empty(line: &str) -> bool {
    line.chars().all(is_js_space)
}

/// The width of the leading `\s*` (JS match[0].length semantics, in UTF-16 units).
fn leading_js_space_units(chars: &[char]) -> usize {
    let mut units = 0;
    for c in chars {
        if !is_js_space(*c) {
            break;
        }
        units += c.len_utf16();
    }
    units
}

/// Byte offset -> UTF-16 column (the LSP face).
fn utf16_col(text: &str, byte_idx: usize) -> usize {
    text[..byte_idx].chars().map(|c| c.len_utf16()).sum()
}

/// Self-call sites (the resolution product, isomorphic in shape with TS IndexedPythonMethodLocation['calls']).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonSelfCall {
    pub method_name: String,
    pub line: u32,
    pub character: u32,
    pub file_path: String,
}

/// Indexed method blocks (method name / 1-based line / name column / indentation-boundary endLine / own-call-site set).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedPythonMethodLocation {
    pub file_path: String,
    pub method_name: String,
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub calls: Vec<PythonSelfCall>,
}

/// An outgoing reference (the four-tuple of the resolved binding, keeping the un-normalized original path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonMethodCallReference {
    pub file_path: String,
    pub method_name: String,
    pub line: u32,
    pub character: u32,
}

/// The incoming caller narrow face (without endLine/calls).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingCaller {
    pub file_path: String,
    pub method_name: String,
    pub line: u32,
    pub character: u32,
}

/// An incoming hit (the caller + the call-site line/column).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingPythonMethodCall {
    pub caller: IncomingCaller,
    pub call_line: u32,
    pub call_character: u32,
}

/// An open-document snapshot (the corpus form of the manager face's collectOpenDocumentTexts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentText {
    pub fs_path: String,
    pub content: String,
}

/// A def-line match (a hand-written scanner with the regex `^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(`).
/// Returns (the indent UTF-16 width, the name byte start [the character backing-off position], the name).
/// The name column is not fixed here: the TS face = `indexOf(name)`'s first occurrence in the whole line (it may fall inside the "def" prefix),
/// computed uniformly by the parse layer.
fn match_def_line(line: &str) -> Option<(usize, usize, String)> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() && is_js_space(chars[i]) {
        i += 1;
    }
    let indent = leading_js_space_units(&chars[..i]);

    let try_match = |p: usize| -> Option<(usize, String)> {
        // def
        if p + 3 > chars.len() || chars[p] != 'd' || chars[p + 1] != 'e' || chars[p + 2] != 'f' {
            return None;
        }
        // \s+(at least one)
        let mut q = p + 3;
        let mut any = false;
        while q < chars.len() && is_js_space(chars[q]) {
            q += 1;
            any = true;
        }
        if !any || q >= chars.len() || !is_ident_start(chars[q]) {
            return None;
        }
        // a greedy ident (no backtracking: \s*( does not eat ident chars, so shortening must fail)
        let start = q;
        q += 1;
        while q < chars.len() && is_ident_cont(chars[q]) {
            q += 1;
        }
        // \s*(
        let mut r = q;
        while r < chars.len() && is_js_space(chars[r]) {
            r += 1;
        }
        if r < chars.len() && chars[r] == '(' {
            Some((start, chars[start..q].iter().collect()))
        } else {
            None
        }
    };

    // The JS greedy optional group: the async path is tried first; on failure it falls back to the bare-def path.
    if chars[i..].starts_with(&['a', 's', 'y', 'n', 'c'])
        && i + 5 < chars.len()
        && is_js_space(chars[i + 5])
    {
        let mut p = i + 5;
        while p < chars.len() && is_js_space(chars[p]) {
            p += 1;
        }
        if let Some((name_start, name)) = try_match(p) {
            let byte_start: usize = chars[..name_start].iter().map(|c| c.len_utf8()).sum();
            return Some((indent, byte_start, name));
        }
    }
    let (name_start, name) = try_match(i)?;
    let byte_start: usize = chars[..name_start].iter().map(|c| c.len_utf8()).sum();
    Some((indent, byte_start, name))
}

/// Self-call scanning (hand-written, the regex `\bself\.([A-Za-z_]\w*)\s*\(` isomorphic path by path).
/// startLine is the 1-based line number of bodyLines[0] (TS face: index+2).
fn parse_python_self_calls(
    body_lines: &[&str],
    start_line: u32,
    python_file: &str,
) -> Vec<PythonSelfCall> {
    let mut calls = Vec::new();
    for (offset, line) in body_lines.iter().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        // (byte_idx, char_idx) advance in lockstep
        let mut i = 0;
        while i < chars.len() {
            let word_boundary = i == 0 || !is_ident_cont(chars[i - 1]);
            let is_self_dot = chars[i] == 's'
                && i + 5 <= chars.len()
                && chars[i + 1] == 'e'
                && chars[i + 2] == 'l'
                && chars[i + 3] == 'f'
                && chars[i + 4] == '.';
            if !word_boundary || !is_self_dot {
                i += 1;
                continue;
            }
            let name_start = i + 5;
            if name_start >= chars.len() || !is_ident_start(chars[name_start]) {
                i += 1;
                continue;
            }
            let mut q = name_start + 1;
            while q < chars.len() && is_ident_cont(chars[q]) {
                q += 1;
            }
            let mut r = q;
            while r < chars.len() && is_js_space(chars[r]) {
                r += 1;
            }
            if r < chars.len() && chars[r] == '(' {
                let name: String = chars[name_start..q].iter().collect();
                let byte_idx: usize = chars[..i].iter().map(|c| c.len_utf8()).sum();
                calls.push(PythonSelfCall {
                    method_name: name,
                    line: start_line + offset as u32,
                    character: (utf16_col(line, byte_idx) + "self.".len()) as u32,
                    file_path: python_file.to_string(),
                });
                // JS lastIndex = the match end (one past the closing paren)
                i = r + 1;
            } else {
                i += 1;
            }
        }
    }
    calls
}

/// Method-block parsing (isomorphic with TS parsePythonMethodBlocks; the index's first scan / the unsaved-document override share it).
pub fn parse_python_method_blocks(
    content: &str,
    python_file: &str,
) -> Vec<IndexedPythonMethodLocation> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut methods = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        let Some((indent, name_byte_start, method_name)) = match_def_line(line) else {
            continue;
        };
        // On the TS face character = `lineText.indexOf(name)`'s first occurrence in the whole line -- it may fall inside "def"
        // (def de( -> "de" hits "def"), not the regex hit position.
        let character = match line.find(&method_name) {
            Some(byte_idx) => utf16_col(line, byte_idx),
            None => utf16_col(line, name_byte_start), // unreachable: the name was taken from this line
        };
        let mut end_line = lines.len();
        for (next, next_text) in lines.iter().enumerate().skip(index + 1) {
            if js_trim_empty(next_text) {
                continue;
            }
            let next_chars: Vec<char> = next_text.chars().collect();
            let next_indent = leading_js_space_units(&next_chars);
            if next_indent <= indent {
                end_line = next;
                break;
            }
        }
        let body_lines: Vec<&str> = lines[index + 1..end_line].to_vec();
        methods.push(IndexedPythonMethodLocation {
            file_path: python_file.to_string(),
            method_name,
            line: (index + 1) as u32,
            character: character as u32,
            end_line: end_line as u32,
            calls: parse_python_self_calls(&body_lines, (index + 2) as u32, python_file),
        });
    }
    methods
}

/// Outgoing resolution: target location (path-identity normalization) -> per-call-site binding (exact file+name,
/// a same-name any-file fallback) -> dedup (normalized path:name:line:column).
pub fn resolve_outgoing_python_method_calls(
    methods: &[IndexedPythonMethodLocation],
    python_file: &str,
    method_name: &str,
) -> Vec<PythonMethodCallReference> {
    let Some(target) = methods.iter().find(|m| {
        normalize_file_identity(&m.file_path) == normalize_file_identity(python_file)
            && m.method_name == method_name
    }) else {
        return Vec::new();
    };

    let mut references = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for reference in &target.calls {
        let binding = methods.iter().find(|candidate| {
            normalize_file_identity(&candidate.file_path)
                == normalize_file_identity(&reference.file_path)
                && candidate.method_name == reference.method_name
        });
        let resolved = binding.or_else(|| {
            methods
                .iter()
                .find(|candidate| candidate.method_name == reference.method_name)
        });
        let Some(resolved) = resolved else {
            continue;
        };
        let key = format!(
            "{}:{}:{}:{}",
            normalize_file_identity(&resolved.file_path),
            resolved.method_name,
            resolved.line,
            resolved.character
        );
        if !seen.insert(key) {
            continue;
        }
        references.push(PythonMethodCallReference {
            file_path: resolved.file_path.clone(),
            method_name: resolved.method_name.clone(),
            line: resolved.line,
            character: resolved.character,
        });
    }
    references
}

/// Incoming resolution: bucket by file (insertion order) -> open-document override (overriding only buckets already in the index,
/// with the override keeping the original bucket order) -> full scanning (name hit + target in column + process-scope filtering: when both blocks
/// are known and different, skip; when unknown, keep conservatively).
pub fn resolve_incoming_python_method_calls(
    methods: &[IndexedPythonMethodLocation],
    open_texts: &[OpenDocumentText],
    python_file: &str,
    method_name: &str,
) -> Vec<IncomingPythonMethodCall> {
    let normalized_target = normalize_file_identity(python_file);
    let target_section = infer_method_section_from_python_file(&normalized_target);

    // Bucketing: the JS Map insertion order (an existing set key keeps its position) + per-bucket override.
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<IndexedPythonMethodLocation>> = HashMap::new();
    for method in methods {
        let key = normalize_file_identity(&method.file_path);
        match buckets.get_mut(&key) {
            Some(bucket) => bucket.push(method.clone()),
            None => {
                order.push(key.clone());
                buckets.insert(key, vec![method.clone()]);
            }
        }
    }
    for open in open_texts {
        let key = normalize_file_identity(&open.fs_path);
        let Some(bucket) = buckets.get(&key) else {
            continue;
        };
        let file_path = bucket[0].file_path.clone();
        buckets.insert(key, parse_python_method_blocks(&open.content, &file_path));
    }
    let mut flat: Vec<IndexedPythonMethodLocation> = Vec::new();
    for key in &order {
        if let Some(bucket) = buckets.get(key) {
            flat.extend(bucket.iter().cloned());
        }
    }

    let mut incoming = Vec::new();
    for method in &flat {
        for call in &method.calls {
            if call.method_name != method_name {
                continue;
            }
            if flat
                .iter()
                .find(|candidate| {
                    candidate.method_name == call.method_name
                        && normalize_file_identity(&candidate.file_path) == normalized_target
                })
                .is_none()
            {
                continue;
            }
            let caller_section = infer_method_section_from_python_file(&method.file_path);
            if let (Some(target), Some(caller)) = (target_section, caller_section) {
                if caller != target {
                    continue;
                }
            }
            incoming.push(IncomingPythonMethodCall {
                caller: IncomingCaller {
                    file_path: method.file_path.clone(),
                    method_name: method.method_name.clone(),
                    line: method.line,
                    character: method.character,
                },
                call_line: call.line,
                call_character: call.character,
            });
        }
    }
    incoming
}

// ---------------------------------------------------------------------------
// golden corpus / probe / dump (the TS-side parity drives the same set)
// ---------------------------------------------------------------------------

/// Corpus entries: entries with in_index=false serve only as open-document override text and are not indexed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodCallsCorpusEntry {
    pub name: String,
    pub text: String,
    pub in_index: bool,
    pub fs_path: String,
}

/// The probe face: outgoing / incoming (open_texts reference corpus entries as override text).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum MethodCallsProbe {
    // only a variant-level rename_all lands in the field (a container-level one only changes the variant name)
    #[serde(rename_all = "camelCase")]
    Outgoing {
        target_file: String,
        target_method: String,
    },
    #[serde(rename_all = "camelCase")]
    Incoming {
        target_file: String,
        target_method: String,
        #[serde(default)]
        open_texts: Vec<OpenTextRef>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTextRef {
    pub corpus: String,
    pub fs_path: String,
}

/// The produce face (one-to-one with Probe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum MethodCallsProbeOutcome {
    Outgoing {
        references: Vec<PythonMethodCallReference>,
    },
    Incoming {
        incoming: Vec<IncomingPythonMethodCall>,
    },
}

/// The golden-file form.
#[derive(Debug, Serialize, Deserialize)]
pub struct PythonMethodCallsGolden {
    pub generator: String,
    pub corpus: Vec<MethodCallsCorpusEntry>,
    pub probes: Vec<MethodCallsProbe>,
    pub outcomes: Vec<MethodCallsProbeOutcome>,
}

pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/python-method-calls-parity.json";

/// Golden corpus: three processes isomorphic (same-named methods spanning base/cell) + the common unknown block +
/// an honest regex-blind-spot face (string/comment hits, the myself word boundary, self.self chains) +
/// an indentation boundary (full-width-space blank line / zero-indent comment truncation) + a CJK column domain + the def de first-occurrence column.
#[allow(clippy::needless_raw_string_hashes)]
fn method_calls_corpus() -> Vec<MethodCallsCorpusEntry> {
    vec![
        MethodCallsCorpusEntry {
            name: "base_avatar".into(),
            fs_path: "ws/scripts/base/avatar.py".into(),
            in_index: true,
            text: concat!(
                "class Avatar(BaseAvatar):\n",
                "    \"\"\"base avatar\"\"\"\n",
                "\n",
                "    def onEnterWorld(self, y):\n",
                "        self.prepare(y)\n",
                "        self.helper()\n",
                "        self.remoteOnly()\n",
                "\n",
                "    def prepare(self, y):\n",
                "        self.helper()\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "base_forms".into(),
            fs_path: "ws/scripts/base/forms.py".into(),
            in_index: true,
            text: concat!(
                "class Forms:\n",
                "    async def run(self):\n",
                "        self.step()\n",
                "        myself.step()\n",
                "        s = 'self.step()'\n",
                "        print(s)  # self.step()\n",
                "\n",
                "    def step(self):\n",
                "        self.self.x()\n",
                "\n",
                "    def de(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "base_cjk".into(),
            fs_path: "ws/scripts/base/cjk.py".into(),
            in_index: true,
            text: concat!(
                "class Cjk:\n",
                "    def Fire(self):\n",
                "        \u{72b6}\u{6001} = 1  # \u{4e2d}\u{6587} self.Helper()\n",
                "        self.Helper()\n",
                "\n",
                "    def Helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "base_gap".into(),
            fs_path: "ws/scripts/base/gap.py".into(),
            in_index: true,
            text: concat!(
                "class Gap:\n",
                "    def wide(self):\n",
                "        self.narrow()\n",
                "\u{3000}\n",
                "        self.tail()\n",
                "# \u{96f6}\u{7f29}\u{8fdb}\u{6ce8}\u{91ca}\u{622a}\u{65ad}\u{65b9}\u{6cd5}\u{5757}\n",
                "    def narrow(self):\n",
                "        pass\n",
                "    def tail(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "cell_avatar".into(),
            fs_path: "ws/scripts/cell/avatar.py".into(),
            in_index: true,
            text: concat!(
                "class Avatar:\n",
                "    def onEnterWorld(self, y):\n",
                "        self.prepare(y)\n",
                "\n",
                "    def prepare(self, y):\n",
                "        pass\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
                "\n",
                "    def remoteOnly(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "common_util".into(),
            fs_path: "ws/scripts/common/util.py".into(),
            in_index: true,
            text: concat!(
                "class Util:\n",
                "    def onEnterWorld(self, y):\n",
                "        self.prepare(y)\n",
                "        self.helper()\n",
                "\n",
                "    def prepare(self, y):\n",
                "        pass\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "open_base_avatar_stripped".into(),
            fs_path: "ws/scripts/base/avatar.py".into(),
            in_index: false,
            text: concat!(
                "class Avatar(BaseAvatar):\n",
                "    \"\"\"base avatar\"\"\"\n",
                "\n",
                "    def onEnterWorld(self, y):\n",
                "        self.helper()\n",
                "        self.remoteOnly()\n",
                "\n",
                "    def prepare(self, y):\n",
                "        self.helper()\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "open_ghost".into(),
            fs_path: "ws/scripts/base/ghost.py".into(),
            in_index: false,
            text: concat!(
                "class Ghost:\n",
                "    def prepare(self):\n",
                "        self.helper()\n",
            ).into(),
        },
    ]
}

fn method_calls_probes() -> Vec<MethodCallsProbe> {
    vec![
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "onEnterWorld".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "helper".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "prepare".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "missingMethod".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/forms.py".into(),
            target_method: "run".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/forms.py".into(),
            target_method: "step".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/cjk.py".into(),
            target_method: "Fire".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/gap.py".into(),
            target_method: "wide".into(),
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "prepare".into(),
            open_texts: vec![],
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/common/util.py".into(),
            target_method: "prepare".into(),
            open_texts: vec![],
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "prepare".into(),
            open_texts: vec![
                OpenTextRef {
                    corpus: "open_base_avatar_stripped".into(),
                    fs_path: "ws/scripts/base/avatar.py".into(),
                },
                OpenTextRef {
                    corpus: "open_ghost".into(),
                    fs_path: "ws/scripts/base/ghost.py".into(),
                },
            ],
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/cell/avatar.py".into(),
            target_method: "helper".into(),
            open_texts: vec![],
        },
    ]
}

/// Indexing = parsing the in_index entries in order (isomorphic with the TS parity driver).
fn build_index_from_corpus(corpus: &[MethodCallsCorpusEntry]) -> Vec<IndexedPythonMethodLocation> {
    let mut methods = Vec::new();
    for entry in corpus.iter().filter(|e| e.in_index) {
        methods.extend(parse_python_method_blocks(&entry.text, &entry.fs_path));
    }
    methods
}

fn run_method_calls_probe(probe: &MethodCallsProbe) -> MethodCallsProbeOutcome {
    let corpus = method_calls_corpus();
    let index = build_index_from_corpus(&corpus);
    match probe {
        MethodCallsProbe::Outgoing {
            target_file,
            target_method,
        } => MethodCallsProbeOutcome::Outgoing {
            references: resolve_outgoing_python_method_calls(&index, target_file, target_method),
        },
        MethodCallsProbe::Incoming {
            target_file,
            target_method,
            open_texts,
        } => {
            let open_docs: Vec<OpenDocumentText> = open_texts
                .iter()
                .map(|reference| {
                    let entry = corpus
                        .iter()
                        .find(|entry| entry.name == reference.corpus)
                        .unwrap_or_else(|| panic!("corpus 缺失: {}", reference.corpus));
                    OpenDocumentText {
                        fs_path: reference.fs_path.clone(),
                        content: entry.text.clone(),
                    }
                })
                .collect();
            MethodCallsProbeOutcome::Incoming {
                incoming: resolve_incoming_python_method_calls(
                    &index,
                    &open_docs,
                    target_file,
                    target_method,
                ),
            }
        }
    }
}

pub fn dump_python_method_calls_golden() -> String {
    let probes = method_calls_probes();
    let outcomes: Vec<MethodCallsProbeOutcome> =
        probes.iter().map(run_method_calls_probe).collect();
    let golden = PythonMethodCallsGolden {
        generator: "dump-python-method-calls-golden".into(),
        corpus: method_calls_corpus(),
        probes,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blocks_indent_endline_and_edges() {
        let blocks = parse_python_method_blocks(
            concat!(
                "class A:\n",
                "    async def run(self):\n",
                "        self.step()\n",
                "\u{3000}\n",
                "        self.tail2()\n",
                "# zero indent comment\n",
                "    def step(self):\n",
                "        pass\n",
                "    def tail2(self):\n",
                "        pass\n",
            ),
            "ws/scripts/base/a.py",
        );
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].method_name, "run");
        assert_eq!(blocks[0].line, 2);
        // A \u3000 full-width-space line is blank under the JS trim semantics, so skip it; a zero-indent comment line terminates the
        assert_eq!(blocks[0].end_line, 5);
        assert_eq!(blocks[0].calls.len(), 2);
        assert_eq!(blocks[0].calls[0].method_name, "step");
        assert_eq!(blocks[0].calls[0].line, 3);
        assert_eq!(blocks[0].calls[0].character, 13);
        // // skip: after skipping the blank line the trailing call is still captured (a blank-line termination would drop the trailing call -- pinned)
        assert_eq!(blocks[0].calls[1].method_name, "tail2");
        assert_eq!(blocks[0].calls[1].line, 5);
        assert_eq!(blocks[0].calls[1].character, 13);
        assert_eq!(blocks[1].method_name, "step");
        assert_eq!(blocks[1].line, 7);
        assert_eq!(blocks[2].method_name, "tail2");
        assert_eq!(blocks[2].line, 9);
    }

    #[test]
    fn parse_def_edge_first_occurrence_and_cjk_columns() {
        // def de(...): indexOf("de") hits inside the "def" prefix (column 4 after the 4-space indent; the JS indexOf is isomorphic)
        let blocks = parse_python_method_blocks("    def de(self):\n        pass\n", "f.py");
        assert_eq!(blocks[0].method_name, "de");
        assert_eq!(blocks[0].character, 4);

        // The CJK-prefix call-site column = the UTF-16 column (status = 1  # <CJK literal> self.Helper())
        let line = "        \u{72b6}\u{6001} = 1  # \u{4e2d}\u{6587} self.Helper()\n";
        let blocks = parse_python_method_blocks(
            &format!("class C:\n    def Fire(self):\n{}\n", line),
            "c.py",
        );
        let call = &blocks[0].calls[0];
        assert_eq!(call.method_name, "Helper");
        // 8-space indent + status (2) + " = 1  # " (9, a double space after 1) + the CJK literal (2) + a space (1) = 22; self. +5 = 27? Actual count: spaces 0-7, status 8-9, a space 10, 11 =, a space 12, 13 1, a double space 14-15, 16 #, a space 17, 18-19 the CJK literal, a space 20, self.=21-25 -> column 26 for H
        assert_eq!(call.character, 26);
    }

    #[test]
    fn parse_self_call_word_boundary_and_chain() {
        let blocks = parse_python_method_blocks(
            concat!(
                "class F:\n",
                "    def run(self):\n",
                "        myself.step()\n",
                "        s = 'self.step()'\n",
                "        self.self.x()\n",
                "        self.step ( )\n",
            ),
            "f.py",
        );
        let calls: Vec<&str> = blocks[0]
            .calls
            .iter()
            .map(|c| c.method_name.as_str())
            .collect();
        // myself does not match (the word boundary); strings/comments still match (a regex blind spot, honest on both ends);
        // self.self.x -> the ident x from the second self. on matches; self.step ( ) with whitespace still matches
        assert_eq!(calls, vec!["step", "x", "step"]);
        assert_eq!(blocks[0].calls[1].method_name, "x");
    }

    #[test]
    fn outgoing_binding_fallback_and_dedup() {
        let index = vec![
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 5,
                calls: vec![
                    PythonSelfCall {
                        method_name: "same".into(),
                        line: 3,
                        character: 13,
                        file_path: "ws/scripts/base/a.py".into(),
                    },
                    PythonSelfCall {
                        method_name: "same".into(),
                        line: 4,
                        character: 13,
                        file_path: "ws/scripts/base/a.py".into(),
                    },
                    PythonSelfCall {
                        method_name: "elsewhere".into(),
                        line: 5,
                        character: 13,
                        file_path: "ws/scripts/base/a.py".into(),
                    },
                ],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "same".into(),
                line: 7,
                character: 8,
                end_line: 8,
                calls: vec![],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/cell/a.py".into(),
                method_name: "elsewhere".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/common/a.py".into(),
                method_name: "elsewhere".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![],
            },
        ];
        let references =
            resolve_outgoing_python_method_calls(&index, "ws/scripts/base/a.py", "caller");
        // Duplicate calls on the same file are deduped to one; elsewhere this file has none -> the same-name fallback takes the first occurrence (cell)
        assert_eq!(references.len(), 2);
        assert_eq!(references[0].file_path, "ws/scripts/base/a.py");
        assert_eq!(references[0].method_name, "same");
        assert_eq!(references[1].file_path, "ws/scripts/cell/a.py");
        // target absent -> empty
        assert!(
            resolve_outgoing_python_method_calls(&index, "ws/scripts/base/a.py", "nope").is_empty()
        );
    }

    #[test]
    fn incoming_section_filter_and_unknown_retention() {
        let index = vec![
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall {
                    method_name: "work".into(),
                    line: 3,
                    character: 13,
                    file_path: "ws/scripts/base/a.py".into(),
                }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/cell/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall {
                    method_name: "work".into(),
                    line: 3,
                    character: 13,
                    file_path: "ws/scripts/cell/a.py".into(),
                }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/common/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall {
                    method_name: "work".into(),
                    line: 3,
                    character: 13,
                    file_path: "ws/scripts/common/a.py".into(),
                }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "work".into(),
                line: 5,
                character: 8,
                end_line: 6,
                calls: vec![],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/common/a.py".into(),
                method_name: "work".into(),
                line: 5,
                character: 8,
                end_line: 6,
                calls: vec![],
            },
        ];
        // target base:cell callers are filtered by scope; common (the unknown block) is kept conservatively
        let incoming =
            resolve_incoming_python_method_calls(&index, &[], "ws/scripts/base/a.py", "work");
        assert_eq!(incoming.len(), 2);
        assert_eq!(incoming[0].caller.file_path, "ws/scripts/base/a.py");
        assert_eq!(incoming[1].caller.file_path, "ws/scripts/common/a.py");
        // the target block is unknown (common): keep everything
        let all =
            resolve_incoming_python_method_calls(&index, &[], "ws/scripts/common/a.py", "work");
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn incoming_open_text_override_and_missing_bucket() {
        let index = vec![
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall {
                    method_name: "work".into(),
                    line: 3,
                    character: 13,
                    file_path: "ws/scripts/base/a.py".into(),
                }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "work".into(),
                line: 5,
                character: 8,
                end_line: 6,
                calls: vec![],
            },
        ];
        // overriding an indexed bucket: the call sites vanish with the buffer -> empty
        let stripped =
            "class A:\n    def caller(self):\n        pass\n    def work(self):\n        pass\n";
        let incoming = resolve_incoming_python_method_calls(
            &index,
            &[OpenDocumentText {
                fs_path: "ws/scripts/base/a.py".into(),
                content: stripped.into(),
            }],
            "ws/scripts/base/a.py",
            "work",
        );
        assert!(incoming.is_empty());
        // an open file not yet indexed is not added to the scan (skipped)
        let incoming2 = resolve_incoming_python_method_calls(
            &index,
            &[OpenDocumentText {
                fs_path: "ws/scripts/base/ghost.py".into(),
                content: "class Ghost:\n    def caller(self):\n        self.work()\n".into(),
            }],
            "ws/scripts/base/a.py",
            "work",
        );
        assert_eq!(incoming2.len(), 1);
        assert_eq!(incoming2[0].caller.file_path, "ws/scripts/base/a.py");
    }

    #[test]
    fn golden_probes_cover_both_faces() {
        let probes = method_calls_probes();
        assert!(probes.len() >= 12);
        let outgoing = probes
            .iter()
            .filter(|p| matches!(p, MethodCallsProbe::Outgoing { .. }))
            .count();
        let incoming = probes
            .iter()
            .filter(|p| matches!(p, MethodCallsProbe::Incoming { .. }))
            .count();
        assert!(outgoing >= 8, "outgoing 探测面规模");
        assert!(incoming >= 4, "incoming 探测面规模");
        // the override-text probe exists and references a real corpus entry
        let corpus = method_calls_corpus();
        for probe in &probes {
            if let MethodCallsProbe::Incoming { open_texts, .. } = probe {
                for reference in open_texts {
                    assert!(
                        corpus
                            .iter()
                            .any(|entry| entry.name == reference.corpus && !entry.in_index),
                        "覆盖文本条目须在 corpus 且不入索引: {}",
                        reference.corpus
                    );
                }
            }
        }
    }
}
