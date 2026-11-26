//! Native .def formatting (Rust core, KODE-SYN-006): see the evaluation
//! conclusion in docs/design/def-formatter-evaluation.md plan B — formatting
//! converges onto kode-parser's exact span face, with the TS side only doing a
//! thin provider adaptation (zero external dependencies, no TS-side XML
//! re-layout).
//!
//! Command face `$/kode/def/format` (dispatched through the `$/kode/rpc` single
//! arm): input `{content: string, indentSize?: u64, start?: u64, end?: u64}`,
//! output `{edits, diagnostics}`.
//!
//! - **Pure computation, no spawn**: the formatting core inside kode-parser
//!   returns synchronously — no subprocess, no IO, no workspace writes
//!   (unlike ruff's shell-out face, so it takes no IO lane).
//! - **`edits` is a minimal line-level edit set** (`[start, end)` replaced by
//!   `text`), with ranges in the byte coordinate system of the **original
//!   text**; applying them (in reverse order) is byte-for-byte identical to the
//!   full render (pinned by `format_def_edits`' roundtrip unit test). A render
//!   identical to the source → empty edit set (idempotent landing point).
//! - **Selection**: when `start`/`end` are given as a pair, only edits
//!   "intersecting the selection" come back (line-level edits are not clipped
//!   at the boundary; a line crossing the boundary is replaced whole — the
//!   usual convention of line-aligned formatters).
//! - **Any parse diagnostic → empty edit set**, never a half-format (broken
//!   XML is the normal state inside a live editor, not an error); the
//!   `diagnostics` count comes back so TS can honestly tell "formatted" from
//!   "unparseable, safe retreat" — zero edits is never silent.

use serde_json::{json, Value};

use crate::rpc::RpcRegistry;
use kode_parser::def_format::{format_def_report, DefFormatOptions};

const METHOD: &str = "$/kode/def/format";

pub fn register(reg: &mut RpcRegistry) {
    reg.register(METHOD, def_format_handler);
}

/// Reasonable upper bound for the indent size (anything larger is a mistake;
/// reported honestly as a bad-parameter Err, never silently tightened).
const INDENT_SIZE_MAX: u64 = 64;

fn def_format_handler(params: Value) -> Result<Value, String> {
    let content = params
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "def format: missing content".to_string())?;
    let indent_size = params
        .get("indentSize")
        .and_then(|v| v.as_u64())
        .unwrap_or(DefFormatOptions::default().indent_size as u64);
    if indent_size == 0 || indent_size > INDENT_SIZE_MAX {
        return Err(format!(
            "def format: indentSize must be in 1..={INDENT_SIZE_MAX}, got {indent_size}"
        ));
    }
    let range = selection_range(&params, content.len())?;
    let report = format_def_report(
        content,
        &DefFormatOptions {
            indent_size: indent_size as usize,
        },
    );
    let edits = report
        .edits
        .into_iter()
        .filter(|edit| match range.as_ref() {
            Some(&(start, end)) => edit_intersects(edit, start, end),
            None => true,
        })
        .map(|edit| {
            json!({
                "start": edit.start,
                "end": edit.end,
                "text": edit.text,
            })
        })
        .collect::<Vec<Value>>();
    Ok(json!({ "edits": edits, "diagnostics": report.diagnostics }))
}

/// Line-level edits are not clipped by the selection: an intersection adopts
/// the whole edit (a zero-width selection = the cursor position, taking the
/// line covering it).
fn edit_intersects(edit: &kode_parser::DefFormatEdit, start: usize, end: usize) -> bool {
    if start == end {
        edit.start <= start && edit.end >= start
    } else {
        edit.start < end && edit.end > start
    }
}

/// Selection convention: `start`/`end` must be given as a pair (one alone is a
/// bad-parameter Err, half a range is never guessed), out-of-range values clamp
/// to the document boundary. Returns `(start, end)` or `None` (whole document).
fn selection_range(params: &Value, content_len: usize) -> Result<Option<(usize, usize)>, String> {
    let start = params.get("start").and_then(|v| v.as_u64());
    let end = params.get("end").and_then(|v| v.as_u64());
    match (start, end) {
        (None, None) => Ok(None),
        (Some(s), Some(e)) => {
            let s = (s as usize).min(content_len);
            let e = (e as usize).min(content_len).max(s);
            Ok(Some((s, e)))
        }
        _ => Err("def format: start and end must be given together".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSY: &str =
        "<root>\n<Properties>\n<hp>\n<Type>UINT32</Type>\n</hp>\n</Properties>\n</root>";

    /// Whole-document face: non-empty edit set, 0 diagnostics; applying in
    /// reverse order is byte-for-byte identical to the full render.
    #[test]
    fn whole_document_returns_edit_set_and_zero_diagnostics() {
        let face = def_format_handler(json!({ "content": MESSY })).expect("整文档面");
        let edits = face["edits"].as_array().expect("edits 是数组");
        assert!(!edits.is_empty(), "未格式化文档必须有编辑");
        assert_eq!(face["diagnostics"], 0);
        // Applying the edit set in reverse → identical to the render output
        // (the payload lands self-consistently back onto the original text)
        let rendered = kode_parser::format_def_text(MESSY, &DefFormatOptions::default());
        let mut out = String::from(MESSY);
        let mut max_start = usize::MAX;
        for edit in edits.iter().rev() {
            let start = edit["start"].as_u64().unwrap() as usize;
            assert!(
                edit["end"].as_u64().unwrap() as usize <= max_start,
                "编辑区间不得重叠"
            );
            out.replace_range(
                start..edit["end"].as_u64().unwrap() as usize,
                edit["text"].as_str().unwrap(),
            );
            max_start = start;
        }
        assert_eq!(out, rendered);
    }

    /// Already formatted → zero edits, zero diagnostics (idempotent landing
    /// point; the front end writes no document on this basis).
    #[test]
    fn already_formatted_document_reports_zero_edits() {
        let rendered = kode_parser::format_def_text(MESSY, &DefFormatOptions::default());
        let face = def_format_handler(json!({ "content": rendered })).expect("幂等面");
        assert_eq!(face["edits"], json!([]));
        assert_eq!(face["diagnostics"], 0);
    }

    /// Incomplete XML → zero edits **and** the diagnostic count comes back
    /// honestly (never silently treated as "already formatted").
    #[test]
    fn incomplete_xml_returns_no_edits_with_diagnostics() {
        let face = def_format_handler(json!({ "content": "<root><a></b>" })).expect("残缺面");
        assert_eq!(face["edits"], json!([]));
        assert!(
            face["diagnostics"].as_u64().unwrap() > 0,
            "残缺文档必须带诊断条数,供前端区分口径"
        );
    }

    /// Selection face: only edits intersecting the selection come back, and a
    /// pair missing one half is a bad-parameter Err.
    #[test]
    fn selection_range_filters_and_half_range_is_rejected() {
        // Half a selection is a bad-parameter Err (the other end is never guessed)
        assert!(def_format_handler(json!({ "content": MESSY, "start": 4 })).is_err());
        assert!(def_format_handler(json!({ "content": MESSY, "end": 4 })).is_err());

        let whole = def_format_handler(json!({ "content": MESSY })).unwrap();
        let whole_count = whole["edits"].as_array().unwrap().len();
        assert!(whole_count > 0, "未格式化文档必须有编辑");

        // Selection = the first line (unchanged after rendering) → zero edits:
        // proves the filter is a real filter, not a whole-document passthrough
        let first_line = "<root>\n".len();
        let face =
            def_format_handler(json!({ "content": MESSY, "start": 0, "end": first_line })).unwrap();
        assert_eq!(face["edits"], json!([]), "未变行上的选区不得回带编辑");

        // Selection = whole document → the same count as the whole-document face
        // (the filter drops no edits)
        let full = def_format_handler(json!({
            "content": MESSY,
            "start": 0,
            "end": MESSY.len()
        }))
        .unwrap();
        assert_eq!(full["edits"].as_array().unwrap().len(), whole_count);

        // Mid-document selection: non-intersecting edits must not appear
        let mid = first_line + "<Properties>\n".len();
        let mid_face =
            def_format_handler(json!({ "content": MESSY, "start": 0, "end": mid })).unwrap();
        for edit in mid_face["edits"].as_array().unwrap() {
            let s = edit["start"].as_u64().unwrap() as usize;
            let e = edit["end"].as_u64().unwrap() as usize;
            assert!(s < mid && e > 0, "选区外的编辑不得回带: [{s},{e})");
        }

        // Fully out-of-range clamps to the document tail: not an Err, handled as
        // "the cursor rests at end of document" (if the last line is being edited,
        // the edit still comes back)
        let clamped =
            def_format_handler(json!({ "content": MESSY, "start": 10_000, "end": 20_000 }))
                .unwrap();
        assert_eq!(
            clamped["edits"].as_array().unwrap().len(),
            whole_count,
            "clamp 后的零宽区间=文档尾光标,不得静默丢编辑"
        );

        // A zero-width selection on an unchanged line → zero edits (the cursor
        // does not drag in unrelated lines)
        let cursor = def_format_handler(json!({ "content": MESSY, "start": 3, "end": 3 })).unwrap();
        assert_eq!(cursor["edits"], json!([]));
    }

    /// Bad parameters reported honestly as Err: missing content / non-string
    /// content / out-of-range indentSize.
    #[test]
    fn bad_params_are_rejected_honestly() {
        assert!(def_format_handler(json!({})).is_err());
        assert!(def_format_handler(json!({ "content": 7 })).is_err());
        assert!(def_format_handler(json!({ "content": MESSY, "indentSize": 0 })).is_err());
        assert!(
            def_format_handler(json!({ "content": MESSY, "indentSize": INDENT_SIZE_MAX + 1 }))
                .is_err()
        );
        // A valid indent size takes effect as given (never silently tightened,
        // never ignored)
        let face = def_format_handler(json!({ "content": MESSY, "indentSize": 2 })).unwrap();
        assert!(
            face["edits"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["text"].as_str().unwrap().contains("  <Properties>")),
            "indentSize 必须透传到渲染"
        );
    }

    /// Registration without a duplicate name: the METHOD constant is the
    /// registration key.
    #[test]
    fn registers_under_the_def_format_method_name() {
        let mut reg = RpcRegistry::new();
        register(&mut reg);
        assert!(reg.dispatch(METHOD, json!({ "content": MESSY })).is_ok());
        assert!(reg.snapshot().methods().any(|m| m == METHOD));
    }
}
