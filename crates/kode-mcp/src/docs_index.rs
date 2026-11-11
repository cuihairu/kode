//! 项目 Markdown 文档索引(KODE-MCP-KB-001 ⑥):`search_docs` 工具。
//!
//! 在资产根 + 配置的额外路径(CLI 附加参数,游戏配置需求文档等)下递归
//! 收集 `.md` 文件并做大小写不敏感全文检索,答「项目文档里讲了什么」。
//! 与 `explain`(编译期内嵌 docs/knowledge 机制文章)互补:本面索引的是
//! **用户自己的项目文档**,不是 kode 内嵌知识文章。
//!
//! 边界(诚实):单文件读上限 1MB、文件数上限 5000、跳过 target/
//! node_modules/.git/.kbengine 等噪音目录;命中给 file/title/headings/
//! snippet,不整篇回传(大文档按需另读)。Excel 数据未纳入——需解析依赖
//! (calamine 类),KODE-CFG-016 已以 Excel 派生 schema 另面承接。root 是
//! 资产根时,项目根旁的常规文档目录(docs/、doc/)自动并入扫描根
//! (KODE-MCP-DOCS-001,用户令 2026-11-11「把项目根目录下的 docs 之类的
//! 目录扫描进去」)——CLI 附加参数之外的零配置兜底。

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

/// 常规文档目录名(存在才收;只认这两个,不发明更多)。
const CONVENTIONAL_DOC_DIRS: &[&str] = &["docs", "doc"];

/// root 旁可自动并入的项目文档目录。
///
/// 只在「root 确是资产根」时向上探一层(父目录 = 项目根,docs 挂那里是
/// KBEngine 工程惯例):root 名为 assets/server_assets/asset,或 root 过
/// 引擎装载探针 `res/server/kbengine.xml`(与扩展资产根验收同源)。其余
/// 形态(root=项目根本身、任意目录、临时目录)绝不向上逃逸——root=项目
/// 根时 docs 已在 root 内,父旁的 docs 属于别的工程。返回按目录名定序。
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

/// 递归收集资产根 + 额外路径 + 常规项目文档目录下的 `.md` 文件(确定序、
/// 去重、封顶;重复根经 bounded_scan canonical visited 集合只走一次)。
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

/// 文档标题:首个 ATX `# ` 或 Setext 一级标题(标题行 + `===`/`---` 下划
/// 线;空则空串)。
fn title_of(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        if t.starts_with("# ") {
            return t.trim_start_matches("# ").trim().to_string();
        }
        // Setext:标题行后紧跟 `===`/`---`(纯符号行)。
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

/// 命中行的前文片段(取首个含查询的行,trim 截断——避免字节索引错位)。
fn snippet_of(text: &str, query_lower: &str) -> String {
    text.lines()
        .find(|l| l.to_lowercase().contains(query_lower))
        .map(|l| l.trim().chars().take(160).collect())
        .unwrap_or_default()
}

/// Markdown 标题行判定:一个或多个 `#` 后随空格或行尾(#/##/###...,含空
/// 标题行)。
fn is_heading(line: &str) -> bool {
    let t = line.trim_start();
    if !t.starts_with('#') {
        return false;
    }
    let after = t.trim_start_matches('#');
    after.is_empty() || after.starts_with(' ')
}

/// 全部 Markdown 标题(截 8 条)。
fn headings_of(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| is_heading(l))
        .map(|l| l.trim().to_string())
        .take(8)
        .collect()
}

/// `search_docs`:在资产根 + 额外路径的 `.md` 里大小写不敏感检索 query,
/// 返回命中文件的事实(file/title/headings/snippet)。空 query → Err;
/// 无命中 → 空集如实。limit 缺省 20。
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
    // 每次调用重走(有界:文件数封顶、读文件封顶 1MB);进程根+额外路径
    // 固定,走查代价是目录枚举,非内容读,可接受且无陈旧索引风险。
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
        assert!(m["file"].as_str().unwrap().ends_with("docs/design.md"));
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
        // root = <proj>/assets(名字命中):项目根旁 docs/ 自动并入
        // (KODE-MCP-DOCS-001,用户令「项目根目录下的 docs 之类的目录」)。
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
            .ends_with("docs/design.md"));
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn engine_probe_root_and_doc_dir_also_auto_include() {
        // 探针形态:root 名不叫 assets,但 root/res/server/kbengine.xml 在
        // ——同样认定为资产根(与扩展资产根验收同源);doc/ 备用名同样收。
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
            .ends_with("doc/guide.md"));
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn no_parent_escape_without_assets_marker() {
        // root 不是资产根(名字不命中、无探针):绝不向上逃逸——root=项目
        // 根时父旁的 docs 属于别的工程,并入是污染。
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
        // 显式 CLI 附加参数与自动并入的兄弟 docs 同目录:canonical visited
        // 去重,scanned 不翻倍。
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
        // Setext 一级标题:`===` 下划线。
        std::fs::write(dir.join("a.md"), "网络设计\n===\n\n登录流程细节。\n").unwrap();
        let out = search_docs(&root, &[], "登录", 20).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["title"], "网络设计");
        // 超 1MB 文件:跳过并计入 scan_errors(不静默);a.md 无此词 → 空集如实。
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
        // 无标题 → 空串;`#` 无空格不是 ATX 标题;有下一行但非下划线 → 非
        // Setext,继续回落空串。
        assert_eq!(title_of("just text\n"), "");
        assert_eq!(title_of("#no-space\n"), "");
        assert_eq!(title_of("hello\nworld\n"), "");
        // is_heading:空标题行(`#`)算标题。
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
