//! Project Markdown doc index (KODE-MCP-KB-001 ⑥): the `search_docs` tool.
//!
//! Recursively collects `.md` files under the asset root + configured extra
//! paths (CLI extra arguments, game design requirement docs, etc.) and runs a
//! case-insensitive full-text search, answering "what do the project docs say".
//! Complementary to `explain` (the compile-time embedded docs/knowledge
//! mechanism articles): this face indexes **the user's own project docs**, not
//! kode's embedded knowledge articles.
//!
//! Boundaries (honest): 1MB per-file read cap, 5000-file cap, skip noise dirs
//! like target/node_modules/.git/.kbengine; hits give file/title/headings/
//! snippet, not the whole document (large docs read separately on demand).
//! Excel data is not covered — it needs a parsing dependency (calamine-class);
//! KODE-CFG-016 already handles it on another face via Excel-derived schema.
//! When root is the asset root, conventional doc directories beside the project
//! root (docs/, doc/) are folded into the scan roots automatically
//! (KODE-MCP-DOCS-001, user order 2026-11-11 "scan in directories like docs
//! under the project root") — a zero-config fallback beyond the CLI extra
//! arguments.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const MAX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 1_000_000;
const SKIP_DIRS: &[&str] = &[
    "target",
    "node_modules",
    ".git",
    ".kbengine",
    ".vscode-test",
    "dist",
    "out",
    "build",
];

/// Conventional doc directory names (only collected when they exist; just these
/// two, no inventions).
const CONVENTIONAL_DOC_DIRS: &[&str] = &["docs", "doc"];

/// Project doc directories beside root that can be folded in automatically.
///
/// Probes one level up only when "root really is the asset root" (the parent
/// directory = project root; docs hanging there is KBEngine project
/// convention): root is named assets/server_assets/asset, or root passes the
/// engine load probe `res/server/kbengine.xml` (same source as the extension's
/// asset-root acceptance). Any other shape (root = the project root itself, an
/// arbitrary directory, a temp dir) never escapes upward — when root = the
/// project root, docs is already inside root and a parent-side docs belongs to
/// a different project. Returns ordered by directory name.
fn conventional_doc_roots(root: &Path) -> Vec<PathBuf> {
    let root_is_assets = matches!(
        root.file_name().and_then(|name| name.to_str()),
        Some("assets") | Some("server_assets") | Some("asset")
    ) || root
        .join("res")
        .join("server")
        .join("kbengine.xml")
        .is_file();
    if !root_is_assets {
        return Vec::new();
    }
    let Some(parent) = root.parent() else {
        return Vec::new();
    };
    CONVENTIONAL_DOC_DIRS
        .iter()
        .map(|name| parent.join(name))
        .filter(|candidate| candidate.is_dir())
        .collect()
}

/// Recursively collects `.md` files under the asset root + extra paths +
/// conventional project doc directories (deterministic order, dedup, capped;
/// duplicate roots are walked once via bounded_scan's canonical visited set).
fn collect_md(root: &Path, extra: &[PathBuf]) -> crate::bounded_scan::Scan {
    let mut roots = vec![root.to_path_buf()];
    roots.extend_from_slice(extra);
    roots.extend(conventional_doc_roots(root));
    crate::bounded_scan::collect(&roots, "md", SKIP_DIRS, MAX_FILES)
}

fn read_capped(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Doc title: the first ATX `# ` or Setext level-1 heading (heading line +
/// `===`/`---` underline; empty string when absent).
fn title_of(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        if t.starts_with("# ") {
            return t.trim_start_matches("# ").trim().to_string();
        }
        // Setext: a `===`/`---` (pure-symbol line) immediately after the heading line.
        if let Some(next) = lines.get(i + 1) {
            let n = next.trim();
            if (n.starts_with('=') && n.bytes().all(|b| b == b'='))
                || (n.starts_with('-') && n.bytes().all(|b| b == b'-'))
            {
                return t.trim().to_string();
            }
        }
    }
    String::new()
}

/// Snippet around the hit (first line containing the query, trimmed and
/// truncated — avoiding byte-index misalignment).
fn snippet_of(text: &str, query_lower: &str) -> String {
    text.lines()
        .find(|l| l.to_lowercase().contains(query_lower))
        .map(|l| l.trim().chars().take(160).collect())
        .unwrap_or_default()
}

/// Markdown heading-line test: one or more `#` followed by a space or end of
/// line (#/##/###..., including empty heading lines).
fn is_heading(line: &str) -> bool {
    let t = line.trim_start();
    if !t.starts_with('#') {
        return false;
    }
    let after = t.trim_start_matches('#');
    after.is_empty() || after.starts_with(' ')
}

/// All Markdown headings (capped at 8).
fn headings_of(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| is_heading(l))
        .map(|l| l.trim().to_string())
        .take(8)
        .collect()
}

/// `search_docs`: case-insensitive search for the query across `.md` files under
/// the asset root + extra paths, returning facts for hit files
/// (file/title/headings/snippet). Empty query → Err; no hits → an honest empty
/// set. limit defaults to 20.
pub fn search_docs(
    root: &Path,
    extra: &[PathBuf],
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty search query".to_string());
    }
    let q = query.to_lowercase();
    // Re-walk on every call (bounded: file count capped, reads capped at 1MB per
    // file); the process root + extra paths are fixed, the walk cost is directory
    // enumeration, not content reads — acceptable and free of stale-index risk.
    let scan = collect_md(root, extra);
    let scanned = scan.files.len();
    let mut errors = scan.errors;
    let truncated = scan.truncated;
    let mut matches: Vec<Value> = Vec::new();
    let mut results_limited = false;
    for file in scan.files {
        let Some(text) = read_capped(&file) else {
            errors += 1;
            continue;
        };
        if !text.to_lowercase().contains(&q) {
            continue;
        }
        matches.push(json!({
            "file": file.to_string_lossy(),
            "title": title_of(&text),
            "headings": headings_of(&text),
            "snippet": snippet_of(&text, &q),
        }));
        if matches.len() >= limit {
            results_limited = true;
            break;
        }
    }
    Ok(json!({
        "query": query,
        "scanned": scanned,
        "truncated": truncated,
        "results_limited": results_limited,
        "scan_errors": errors,
        "count": matches.len(),
        "matches": matches,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_is_error() {
        assert!(search_docs(Path::new("."), &[], "   ", 20).is_err());
    }

    #[test]
    fn missing_root_is_reported_as_scan_error() {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-missing-docs-{}", std::process::id()));
        let result = search_docs(&root, &[], "anything", 20).unwrap();
        assert_eq!(result["count"], 0);
        assert_eq!(result["scan_errors"], 1);
        assert_eq!(result["truncated"], false);
    }

    #[test]
    fn no_match_is_honest_empty() {
        let root = std::env::temp_dir().join(format!("kode-mcp-docs-none-{}", std::process::id()));
        let dir = root.join("docs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "# Title\n\nhello world\n").unwrap();
        let out = search_docs(&root, &[], "zzz-no-such", 20).expect("answer");
        assert_eq!(out["count"], 0);
        assert!(out["matches"].as_array().unwrap().is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn matches_file_title_headings_and_snippet() {
        let root = std::env::temp_dir().join(format!("kode-mcp-docs-hit-{}", std::process::id()));
        let dir = root.join("docs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("design.md"),
            "# 设计文档\n\n## 网络\n\n客户端登录流程说明。\n\n## 数据库\n\n查询语句示例。\n",
        )
        .unwrap();
        let out = search_docs(&root, &[], "登录", 20).expect("answer");
        assert_eq!(out["count"], 1);
        let m = &out["matches"][0];
        assert!(m["file"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("docs/design.md"));
        assert_eq!(m["title"], "设计文档");
        assert!(m["headings"].as_array().unwrap().len() >= 2);
        assert!(m["snippet"].as_str().unwrap().contains("登录流程"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn extra_path_is_searched_in_addition_to_root() {
        let root = std::env::temp_dir().join(format!("kode-mcp-docs-extra-{}", std::process::id()));
        let extra =
            std::env::temp_dir().join(format!("kode-mcp-docs-extra-dir-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&extra).unwrap();
        std::fs::write(root.join("root.md"), "# Root\n\nroot content\n").unwrap();
        std::fs::write(
            extra.join("game-req.md"),
            "# 游戏配置需求\n\n数值平衡说明。\n",
        )
        .unwrap();
        let out = search_docs(&root, std::slice::from_ref(&extra), "数值平衡", 20).expect("answer");
        assert_eq!(out["count"], 1);
        assert!(out["matches"][0]["file"]
            .as_str()
            .unwrap()
            .ends_with("game-req.md"));
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&extra).ok();
    }

    #[test]
    fn sibling_project_docs_are_auto_included_for_assets_root() {
        // root = <proj>/assets (name match): docs/ beside the project root folds in
        // automatically (KODE-MCP-DOCS-001, user order "directories like docs under
        // the project root").
        let proj = std::env::temp_dir().join(format!("kode-mcp-docs-sib-{}", std::process::id()));
        let assets = proj.join("assets");
        let docs = proj.join("docs");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("design.md"), "# 项目设计\n\n副本玩法说明。\n").unwrap();
        let out = search_docs(&assets, &[], "副本玩法", 20).expect("answer");
        assert_eq!(out["count"], 1);
        assert!(out["matches"][0]["file"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("docs/design.md"));
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn engine_probe_root_and_doc_dir_also_auto_include() {
        // Probe shape: root is not named assets, but root/res/server/kbengine.xml
        // exists — still recognized as the asset root (same source as the
        // extension's asset-root acceptance); the doc/ alternate name folds in too.
        let proj = std::env::temp_dir().join(format!("kode-mcp-docs-probe-{}", std::process::id()));
        let assets = proj.join("server_root");
        let probe = assets.join("res").join("server");
        let doc = proj.join("doc");
        std::fs::create_dir_all(&probe).unwrap();
        std::fs::create_dir_all(&doc).unwrap();
        std::fs::write(probe.join("kbengine.xml"), "<root/>\n").unwrap();
        std::fs::write(doc.join("guide.md"), "# 指南\n\n安装步骤。\n").unwrap();
        let out = search_docs(&assets, &[], "安装步骤", 20).expect("answer");
        assert_eq!(out["count"], 1);
        assert!(out["matches"][0]["file"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("doc/guide.md"));
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn no_parent_escape_without_assets_marker() {
        // root is not the asset root (no name match, no probe): never escapes
        // upward — when root = the project root, a parent-side docs belongs to a
        // different project and folding it in would be pollution.
        let proj = std::env::temp_dir().join(format!("kode-mcp-docs-noesc-{}", std::process::id()));
        let root = proj.join("plain");
        let docs = proj.join("docs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("design.md"), "# 别的文档\n\n其他工程说明。\n").unwrap();
        let out = search_docs(&root, &[], "其他工程", 20).expect("answer");
        assert_eq!(out["count"], 0);
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn explicit_extra_matching_sibling_docs_is_not_double_counted() {
        // An explicit CLI extra path coinciding with the auto-folded sibling docs:
        // canonical visited dedup, scanned does not double.
        let proj = std::env::temp_dir().join(format!("kode-mcp-docs-dup-{}", std::process::id()));
        let assets = proj.join("assets");
        let docs = proj.join("docs");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("a.md"), "alpha\n").unwrap();
        let out = search_docs(&assets, std::slice::from_ref(&docs), "alpha", 20).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["scanned"], 1);
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn setext_title_and_oversized_file_handling() {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-docs-setext-{}", std::process::id()));
        let dir = root.join("docs");
        std::fs::create_dir_all(&dir).unwrap();
        // Setext level-1 heading: `===` underline.
        std::fs::write(dir.join("a.md"), "网络设计\n===\n\n登录流程细节。\n").unwrap();
        let out = search_docs(&root, &[], "登录", 20).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["title"], "网络设计");
        // Files over 1MB: skipped and counted in scan_errors (not silently); a.md
        // lacks the term → an honest empty set.
        let mut big = String::from("needle\n");
        big.push_str(&"x".repeat(1_000_001));
        std::fs::write(dir.join("big.md"), &big).unwrap();
        let out = search_docs(&root, &[], "needle", 20).expect("answer");
        assert_eq!(out["count"], 0);
        assert_eq!(out["scan_errors"], 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn setext_dash_underline_and_title_edges() {
        assert_eq!(title_of("标题\n---\ntext\n"), "标题");
        // No title → empty string; `#` without a space is not an ATX heading; a next
        // line exists but is not an underline → not Setext, still falls back to the
        // empty string.
        assert_eq!(title_of("just text\n"), "");
        assert_eq!(title_of("#no-space\n"), "");
        assert_eq!(title_of("hello\nworld\n"), "");
        // is_heading: an empty heading line (`#`) still counts as a heading.
        assert!(is_heading("#"));
        assert!(is_heading("## x"));
        assert!(!is_heading("#no"));
    }

    #[test]
    fn limit_truncates_results_and_flags_it() {
        let root = std::env::temp_dir().join(format!("kode-mcp-docs-lim-{}", std::process::id()));
        let dir = root.join("docs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "hit alpha\n").unwrap();
        std::fs::write(dir.join("b.md"), "hit beta\n").unwrap();
        let out = search_docs(&root, &[], "hit", 1).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["results_limited"], true);
        std::fs::remove_dir_all(&root).ok();
    }
}
