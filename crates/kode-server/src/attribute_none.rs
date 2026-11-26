//! attributeNone diagnostic lexical face (AUDIT-005 B2 lane batch 6, LANG-NAR-1
//! self-managed attribute may-be-None diagnostic): the `text` argument is TS
//! pre-masked text (same source as maskPythonNonCode — comments / string
//! literals already replaced with equal-length blanks, so line/column offsets
//! are unchanged); this module only does a lexical scan:
//! `\bself\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)` expanded by hand + built-in receiver
//! (cell/base/client, handled by receiverNone) skip + 0-based line number and
//! member column computation (UTF-16 code-unit base). The flow-sensitive None
//! evidence face was folded into Rust in RUST-MIGRATION-AUDIT-006 batch 1
//! (engine kode-python::self_flow); from batch 2 this face **inlines per-item
//! flow facts** — each response item carries flow:{types,annotation,hasNone,
//! narrowed} (one engine query per (line, attribute), cloned across items; the
//! `versionKey` argument is passed straight through to the KODE-PERF-001
//! version-keyed parse cache), while TS render is demoted to fact validation +
//! whole-face invalidation on same-key contradictions, removing the double-call
//! seam. Line array comes from self_flow::split_crlf (= the TS
//! `maskedText.split(/\r?\n/)` equivalent, masked lines). The member column
//! keeps the TS `match[0].indexOf(member)` first-occurrence semantics aligned
//! literally (including the existing self.<a>.<a> hitting the attr segment).
//! Response shape
//! [{code,line,character,length,attr,member,flow}]; messages never leave Rust.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

pub const CODE_ATTRIBUTE_NONE: &str = "kbengine.attributeNone";

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeAttributeNone", analyze_attribute_none);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct AttributeNoneParams {
    /// TS pre-masked text (maskPythonNonCode output)
    text: String,
    /// KODE-PERF-001 version-keyed parse cache key (produced by TS flowVersionKeyForDocument;
    /// omitted = parse now without caching, same semantics as the flow engine's pure-function fallback)
    version_key: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AttributeNoneItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    attr: String,
    member: String,
}

/// Inline flow fact face (same shape as the `$/kode/python/selfAttributeFlow`
/// output; from batch 2 it ships with each lexical item, so TS render only
/// validates + detects same-key contradictions and no longer issues a second
/// flow query)
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AttributeNoneFlowFace {
    types: Vec<String>,
    annotation: Option<String>,
    has_none: bool,
    narrowed: bool,
}

/// Response item = lexical structure face + inline flow facts (the engine query
/// is always resolvable: the line number comes from a scan of the same text and
/// is always in range, and attr is non-empty; None = contract drift, and the TS
/// side invalidates the whole face)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AttributeNoneItemFace {
    #[serde(flatten)]
    item: AttributeNoneItem,
    flow: Option<AttributeNoneFlowFace>,
}

fn analyze_attribute_none(params: Value) -> Result<Value, String> {
    let params: AttributeNoneParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let items = compute_attribute_none_items(&params.text);
    // RUST-072: cancellation (Err) is settled by the worker as -32800 per the
    // cancellation table; pass it through here and do not emit partial items
    // pretending to be a complete face.
    let faces = attach_flow_faces(&params.text, &items, params.version_key.as_deref())?;
    Ok(json!({ "items": faces }))
}

/// One flow-engine query per (line, attribute) (kode-python::self_flow batch 1
/// engine, same source as typeInlayHints), cloned across items; line array =
/// masked text split_crlf.
fn attach_flow_faces(
    masked_text: &str,
    items: &[AttributeNoneItem],
    version_key: Option<&str>,
) -> Result<Vec<AttributeNoneItemFace>, &'static str> {
    let text: Vec<u16> = masked_text.encode_utf16().collect();
    let lines = kode_python::self_flow::split_crlf(&text);
    let mut cache: std::collections::HashMap<(usize, String), Option<AttributeNoneFlowFace>> =
        std::collections::HashMap::new();
    let mut faces = Vec::with_capacity(items.len());
    for item in items {
        let flow = match cache.get(&(item.line, item.attr.clone())) {
            Some(hit) => hit.clone(),
            None => {
                // RUST-072: cancellation aborts the whole response (Err passes
                // through) and partial state is not cached; the cache lives and
                // dies locally with this call and never spans requests.
                let flow = kode_python::self_flow::infer_self_attribute_flow(
                    &lines,
                    item.line,
                    &item.attr.encode_utf16().collect::<Vec<u16>>(),
                    version_key,
                )?
                .map(|flow| AttributeNoneFlowFace {
                    types: flow.types,
                    annotation: flow.annotation,
                    has_none: flow.has_none,
                    narrowed: flow.narrowed,
                });
                cache.insert((item.line, item.attr.clone()), flow.clone());
                flow
            }
        };
        faces.push(AttributeNoneItemFace {
            item: item.clone(),
            flow,
        });
    }
    Ok(faces)
}

/// Built-in receiver attributes (handled by receiverNone; skipped here to avoid duplication / diverging criteria)
const BUILTIN_RECEIVERS: [&str; 3] = ["cell", "base", "client"];

/// TS word-start character class `[A-Za-z_]` (no digits)
fn is_name_start(code: u16) -> bool {
    code == 0x5F || (0x41..=0x5A).contains(&code) || (0x61..=0x7A).contains(&code)
}

/// TS `\w` = `[A-Za-z0-9_]`
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
            None => return true, // word exhausted = prefix holds
        }
    }
    expected.next().is_none()
}

/// `\bself\.` scan (pre-masked text, UTF-16 code-unit base). When the greedy attr
/// eats all word characters and the next code unit is not `.`, backtracking is
/// futile (shortening attr only leaves word characters behind; `.` still does
/// not hold) -> no backtracking is needed; an empty member means the whole
/// position fails to match and the engine advances by 1 (same semantics as the
/// `g` regex lastIndex).
fn compute_attribute_none_items(masked_text: &str) -> Vec<AttributeNoneItem> {
    let text: Vec<u16> = masked_text.encode_utf16().collect();
    // Line-start offset table (one position after each '\n'; equal to TS buildLineStarts)
    let mut line_starts: Vec<usize> = vec![0];
    for (idx, code) in text.iter().enumerate() {
        if *code == 10 {
            line_starts.push(idx + 1);
        }
    }
    let mut items: Vec<AttributeNoneItem> = Vec::new();
    let mut line_idx = 0usize;
    let mut i = 0usize;
    while i < text.len() {
        // `\b` left boundary: line start / previous code unit is not a word char; 'self' code unit by code unit; '.' immediately after
        let self_dot = i == 0 || !is_name_char(text[i - 1]);
        if self_dot && starts_with(&text, i, "self") && text.get(i + 4) == Some(&0x2E) {
            // attr: starts with [A-Za-z_], greedy word chars
            let attr_start = i + 5;
            if let Some(&first) = text.get(attr_start) {
                if is_name_start(first) {
                    let mut j = attr_start;
                    while j < text.len() && is_name_char(text[j]) {
                        j += 1;
                    }
                    // require '.' after the greedy attr (backtracking is futile; see module docs)
                    if text.get(j) == Some(&0x2E) {
                        // member: starts with [A-Za-z_], greedy word chars
                        let member_start = j + 1;
                        if let Some(&mfirst) = text.get(member_start) {
                            if is_name_start(mfirst) {
                                let mut k = member_start;
                                while k < text.len() && is_name_char(text[k]) {
                                    k += 1;
                                }
                                let attr =
                                    String::from_utf16(&text[attr_start..j]).unwrap_or_default();
                                let member =
                                    String::from_utf16(&text[member_start..k]).unwrap_or_default();
                                // Skip built-in receivers (by attr name set)
                                let attr_u16: Vec<u16> = attr.encode_utf16().collect();
                                let is_builtin = BUILTIN_RECEIVERS.iter().any(|name| {
                                    attr_u16.as_slice()
                                        == name.encode_utf16().collect::<Vec<u16>>().as_slice()
                                });
                                if !is_builtin {
                                    while line_idx + 1 < line_starts.len()
                                        && line_starts[line_idx + 1] <= i
                                    {
                                        line_idx += 1;
                                    }
                                    // Member column = match start + first occurrence of member
                                    // inside the matched span (literal alignment with TS `match[0].indexOf(member)`)
                                    let member_u16: Vec<u16> = member.encode_utf16().collect();
                                    let mut offset = 0usize;
                                    for s in i..=(k - member_u16.len()) {
                                        if text[s..s + member_u16.len()] == member_u16[..] {
                                            offset = s - i;
                                            break;
                                        }
                                    }
                                    items.push(AttributeNoneItem {
                                        code: CODE_ATTRIBUTE_NONE,
                                        line: line_idx,
                                        character: i + offset,
                                        length: member_u16.len(),
                                        attr,
                                        member,
                                    });
                                }
                                // `g` regex lastIndex: on a successful match skip past the whole span (including built-in skips)
                                i = k;
                                continue;
                            }
                        }
                    }
                }
            }
        }
        // This position fails: engine advances by 1
        i += 1;
    }
    items
}

// ---- Unit tests ------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn items_of(text: &str) -> Vec<AttributeNoneItem> {
        compute_attribute_none_items(text)
    }

    #[test]
    fn bare_access_reports() {
        let items = items_of("    self.TalentTree.get(0)\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].code, CODE_ATTRIBUTE_NONE);
        assert_eq!(items[0].line, 0);
        // column = match start (4) + indexOf('get') within 'self.TalentTree.get' = 16
        assert_eq!(items[0].character, 20);
        assert_eq!(items[0].length, 3);
        assert_eq!(items[0].attr, "TalentTree");
        assert_eq!(items[0].member, "get");
    }

    #[test]
    fn builtin_receivers_skipped() {
        assert!(items_of("self.cell.tick()\n").is_empty());
        assert!(items_of("self.base.create()\n").is_empty());
        assert!(items_of("self.client.req()\n").is_empty());
    }

    #[test]
    fn same_line_two_members_both_report() {
        let items = items_of("self.x.a(1); self.x.b(2)\n");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].member, "a");
        assert_eq!(items[1].member, "b");
        assert_eq!(items[0].character, 7);
        // second match start 13 + indexOf('b') within 'self.x.b' = 7
        assert_eq!(items[1].character, 20);
    }

    #[test]
    fn member_column_uses_first_occurrence_semantics() {
        // TS `match[0].indexOf(member)`: indexOf('id') on self.id.id = 5 (inside the
        // start of the attr segment) -> character = match start + 5 (existing
        // criteria aligned literally; not the member's real position)
        let items = items_of("self.id.id\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].character, 5);
        assert_eq!(items[0].length, 2);
    }

    #[test]
    fn member_column_first_occurrence_in_self_word() {
        // member='lf' first hits inside the 'self' segment (indexOf = 2)
        let items = items_of("self.ab.lf\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].character, 2);
    }

    #[test]
    fn attr_empty_no_match() {
        // self.5x / self.( -> attr shape mismatch, zero matches
        assert!(items_of("self.5x.y\n").is_empty());
        assert!(items_of("self.(x.y\n").is_empty());
    }

    #[test]
    fn member_empty_whole_match_fails() {
        // self.x.() member shape mismatch -> the whole position fails (not an attr-only report)
        assert!(items_of("self.x.(1)\n").is_empty());
    }

    #[test]
    fn attr_without_member_dot_no_match() {
        assert!(items_of("self.x\n").is_empty());
    }

    #[test]
    fn left_word_boundary_respected() {
        // myself.x.y: \b fails; _self.x.y: previous code unit is a word char, fails
        assert!(items_of("myself.x.y\n").is_empty());
        assert!(items_of("_self.x.y\n").is_empty());
    }

    #[test]
    fn line_number_tracks_newlines() {
        let items = items_of("a = 1\nb = 2\nself.foo.bar()\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 2);
        // match start 12 + indexOf('bar') within 'self.foo.bar' = 9
        assert_eq!(items[0].character, 21);
    }

    #[test]
    fn non_ascii_prefix_column_is_utf16() {
        // After masking, the CJK string placeholder has equal length (UTF-16 code units); the column is counted in code units
        let items = items_of("s = \"庆祝\" ; self.cfg.load()\n");
        assert_eq!(items.len(), 1);
        // match start 11 (masked equal-length placeholder, UTF-16 code-unit column)
        // + indexOf('load') within 'self.cfg.load' = 9
        assert_eq!(items[0].character, 20);
    }

    #[test]
    fn multiple_lines_sequential() {
        let items = items_of("self.a.one()\nself.b.two()\n");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].line, 0);
        assert_eq!(items[1].line, 1);
        assert_eq!(items[1].attr, "b");
    }

    #[test]
    fn encoded_shape_is_camel_case() {
        let items = items_of("self.v.read()\n");
        let encoded = serde_json::to_value(&items[0]).unwrap();
        assert_eq!(encoded["code"], json!("kbengine.attributeNone"));
        assert_eq!(encoded["line"], json!(0));
        // indexOf('read') within 'self.v.read' = 7
        assert_eq!(encoded["character"], json!(7));
        assert_eq!(encoded["length"], json!(4));
        assert_eq!(encoded["attr"], json!("v"));
        assert_eq!(encoded["member"], json!("read"));
    }
    // ---- batch 2: inline flow facts ------------------------------------------

    #[test]
    fn flow_face_none_evidence_inline() {
        // __init__ only assigns None, no guard -> hasNone true
        let text = "class Foo:\n    def __init__(self):\n        self.TalentTree = None\n    def method(self):\n        self.TalentTree.get(0)\n";
        let items = compute_attribute_none_items(text);
        let faces = attach_flow_faces(text, &items, None).expect("not cancelled");
        assert_eq!(faces.len(), 1);
        let flow = faces[0].flow.as_ref().expect("flow face present");
        assert!(flow.has_none);
        assert!(!flow.narrowed);
        assert_eq!(flow.annotation.as_deref(), Some("None"));
    }

    #[test]
    fn flow_face_narrowed_inline() {
        // narrowed after the guard -> hasNone false / narrowed true; the item's flow facts are the adjudication basis
        let text = "class Foo:\n    def __init__(self):\n        self.TalentTree = None\n    def method(self):\n        if self.TalentTree is None:\n            self.TalentTree = make_tree()\n        self.TalentTree.get(0)\n";
        let items = compute_attribute_none_items(text);
        let faces = attach_flow_faces(text, &items, None).expect("not cancelled");
        let flow = faces[0].flow.as_ref().expect("flow face present");
        assert!(!flow.has_none);
        assert!(flow.narrowed);
    }

    #[test]
    fn flow_face_shared_across_same_line_attr() {
        // Two items on the same line and attribute share one engine query (hasNone agrees, same value cloned)
        let text = "class Foo:\n    def __init__(self):\n        self.x = None\n    def m(self):\n        self.x.a(); self.x.b()\n";
        let items = compute_attribute_none_items(text);
        assert_eq!(items.len(), 2);
        let faces = attach_flow_faces(text, &items, None).expect("not cancelled");
        let f0 = faces[0].flow.as_ref().unwrap();
        let f1 = faces[1].flow.as_ref().unwrap();
        assert!(f0.has_none && f1.has_none);
    }

    #[test]
    fn flow_face_encoded_shape_is_camel_case() {
        let text = "class Foo:\n    def __init__(self):\n        self.v = None\n    def m(self):\n        self.v.read()\n";
        let items = compute_attribute_none_items(text);
        let faces = attach_flow_faces(text, &items, None).expect("not cancelled");
        let encoded = serde_json::to_value(&faces[0]).unwrap();
        assert_eq!(encoded["flow"]["hasNone"], json!(true));
        assert_eq!(encoded["flow"]["narrowed"], json!(false));
        assert_eq!(encoded["flow"]["annotation"], json!("None"));
        assert_eq!(encoded["flow"]["types"], json!(["None"]));
    }

    #[test]
    fn analyze_entry_roundtrip_and_type_mismatch_rejected() {
        // RPC entry called directly: well-formed parameters round-trip (items array
        // + lexical fields); a type mismatch takes the serde rejection arm
        // (text expects String but gets a number).
        let ok = analyze_attribute_none(json!({
            "text": "self.hero.level\n",
            "versionKey": null,
        }))
        .expect("良形参数应 Ok");
        let items = ok
            .get("items")
            .and_then(|v| v.as_array())
            .expect("items 数组");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["attr"], json!("hero"));
        assert_eq!(items[0]["member"], json!("level"));
        assert_eq!(items[0]["code"], json!(CODE_ATTRIBUTE_NONE));
        assert!(
            analyze_attribute_none(json!({ "text": 123 })).is_err(),
            "text 类型错配应拒绝"
        );
    }

    #[test]
    fn analyze_cancel_err_aborts_whole_face() {
        // RUST-072: cancellation passes through the flow engine's Err and aborts the whole
        // response; no partial items pretending to be a complete face.
        // Probe global state: restore before asserting so a failure cannot
        // leave it set.
        kode_python::cancel::set_probe(Some(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(true),
        )));
        let result = analyze_attribute_none(json!({ "text": "self.a.b\n" }));
        kode_python::cancel::set_probe(None);
        assert!(matches!(result, Err(e) if e == kode_python::cancel::CANCELLED_MSG));
    }

    #[test]
    fn eof_truncated_shapes_and_starts_with_tail() {
        // EOF truncation: attr/member start positions out of bounds -> the if-let None arm, the whole position fails.
        assert!(items_of("self.").is_empty(), "attr 起始越界");
        assert!(items_of("self.x.").is_empty(), "member 起始越界");
        // starts_with tail: the text runs out before the word -> false; exactly the same length, both exhausted -> true.
        let text: Vec<u16> = "sel".encode_utf16().collect();
        assert!(!starts_with(&text, 0, "self"));
        assert!(starts_with(&text, 0, "sel"));
    }
}
