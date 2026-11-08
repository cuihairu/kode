//! `read_node`(KODE-MCP-KB-002 P1 收口):精确读取已解析模型的定义节点。
//!
//! 设计 docs/design/kode-mcp-knowledge-index.md §7/§12:read_node 只在已
//! 解析数据给出精确位置的面交付——
//! - **Python 符号**带 start..end 精确块(1 基,含块尾);
//! - **def 属性 / types.xml 类型 / alias.xml 别名 / 实体**带 1 基行 +
//!   字节 `name_span`(XML 面),无块尾 → 给行锚定有界窗口并如实标注
//!   (`endLine` 缺省、`excerptTruncated` 如实)。
//!
//! 匹配口径:节点名大小写不敏感**全等**(非子串——读取面要「精确读」,
//! 模糊定位交给 find_symbol / search_symbols)。excerpt 有双重封顶
//! (行数 + 字节),截断如实回报,不静默装完整。

use std::path::Path;

use serde_json::{json, Value};

use crate::code_index::{collect_symbols, PySymbol};
use crate::kb::AssetKnowledge;

/// excerpt 缺省行数上限(server.rs 派发缺省与此处同源)。
pub(crate) const DEFAULT_LIMIT_LINES: usize = 120;
/// excerpt 行数硬上限(防一次调用拖回整文件)。
const MAX_LIMIT_LINES: usize = 400;
/// 无块尾节点的行锚定窗口行数(def 属性/类型/别名/实体)。
const WINDOW_LINES: usize = 12;
/// 单条 excerpt 字节上限。
const MAX_EXCERPT_BYTES: usize = 16_000;
/// 单文件读上限(与 search_symbols/docs_index 同口径)。
const MAX_FILE_BYTES: u64 = 1_000_000;
/// 匹配条数上限(超出具实报 resultsLimited)。
const MAX_MATCHES: usize = 20;

/// 读文件(1MB 封顶;超限/不可读 → None,由调用方如实跳过)。
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// 从 `start_line`(1 基)取至多 `max_lines` 行;行数/字节封顶即提前返回。
/// 返回 (excerpt, hit_cap):`hit_cap` = 因封顶提前停(源里可能还有更多行),
/// 是否真截断由调用方按语义判定——精确块的块尾封顶不算截断,窗口封顶算。
fn excerpt(text: &str, start_line: usize, max_lines: usize) -> (String, bool) {
    let mut out = String::new();
    let mut bytes = 0usize;
    for (taken, line) in text.lines().skip(start_line.saturating_sub(1)).enumerate() {
        if taken >= max_lines {
            return (out, true);
        }
        if bytes + line.len() + 1 > MAX_EXCERPT_BYTES {
            return (out, true);
        }
        out.push_str(line);
        out.push('\n');
        bytes += line.len() + 1;
    }
    (out, false)
}

/// Python 符号匹配条目:file + 1 基 start..end 精确块 + excerpt。
fn py_entry(root: &Path, sym: &PySymbol, max_lines: usize) -> Option<Value> {
    let text = read_text(&sym.file)?;
    // 精确块:行数由 end_line 封顶(非窗口猜测);块尾封顶不算截断,
    // 仅请求上限小于块本身时才如实回报截断。
    let block_lines = sym.end_line.saturating_sub(sym.line) + 1;
    let (body, hit_cap) = excerpt(&text, sym.line, block_lines.min(max_lines));
    let truncated = hit_cap && block_lines > max_lines;
    let rel = sym
        .file
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| sym.file.to_string_lossy().to_string());
    let mut entry = json!({
        "kind": sym.kind,
        "name": sym.name,
        "file": rel,
        "line": sym.line,
        "endLine": sym.end_line,
        "excerpt": body,
        "excerptTruncated": truncated,
    });
    if let Some(class) = &sym.class {
        entry["class"] = Value::String(class.clone());
    }
    Some(entry)
}

/// 行锚定条目(def/类型/别名/实体):1 基行 + 可选字节 span + 窗口 excerpt。
fn line_entry(
    kind: &str,
    name: &str,
    file: &str,
    line: usize,
    span: Option<(usize, usize)>,
    text: Option<&str>,
    max_lines: usize,
) -> Value {
    let window = if kind == "entity" {
        max_lines
    } else {
        WINDOW_LINES
    };
    let (body, truncated) = match text {
        Some(t) => excerpt(t, line, window),
        None => (String::new(), true),
    };
    let mut entry = json!({
        "kind": kind,
        "name": name,
        "file": file,
        "line": line,
        "excerpt": body,
        "excerptTruncated": truncated,
    });
    if let Some((start, end)) = span {
        entry["span"] = json!({"start": start, "end": end});
    }
    entry
}

/// `read_node`:按节点名(大小写不敏感全等)精读定义位置。覆盖实体 /
/// 实体属性 / types.xml 类型 / alias.xml 别名 / Python 类·函数·方法。
/// 无命中 → 空集如实;空 locator → Err。
pub fn read_node(
    kb: &AssetKnowledge,
    root: &Path,
    node: &str,
    limit: usize,
) -> Result<Value, String> {
    let node = node.trim();
    if node.is_empty() {
        return Err("empty node locator".to_string());
    }
    let limit = limit.clamp(1, MAX_LIMIT_LINES);
    let q = node.to_lowercase();
    let py = collect_symbols(root);
    let mut matches: Vec<Value> = Vec::new();
    let mut results_limited = false;
    let push = |entry: Value, matches: &mut Vec<Value>| -> bool {
        if matches.len() >= MAX_MATCHES {
            return true;
        }
        matches.push(entry);
        matches.len() >= MAX_MATCHES
    };

    // 实体(def 文件名 = 实体名;文本在内存,行 1 起)。
    for def in kb.defs.values() {
        if def.name.to_lowercase() != q {
            continue;
        }
        let entry = line_entry(
            "entity",
            &def.name,
            &def.rel_path,
            1,
            None,
            Some(&def.text),
            limit,
        );
        if push(entry, &mut matches) {
            results_limited = true;
            break;
        }
    }
    if !results_limited {
        // 实体属性(行锚定窗口;类型/置信度等解析面走 find_symbol)。
        for def in kb.defs.values() {
            for prop in &def.model.properties {
                if prop.name.to_lowercase() != q {
                    continue;
                }
                let mut entry = line_entry(
                    "entity-property",
                    &prop.name,
                    &def.rel_path,
                    prop.line,
                    None,
                    Some(&def.text),
                    limit,
                );
                entry["entity"] = Value::String(def.name.clone());
                if push(entry, &mut matches) {
                    results_limited = true;
                    break;
                }
            }
            if results_limited {
                break;
            }
        }
    }
    if !results_limited {
        // types.xml 类型(行 + 字节 name_span)。
        for decl in &kb.types.types {
            if decl.name.to_lowercase() != q {
                continue;
            }
            let entry = line_entry(
                "type",
                &decl.name,
                "scripts/entity_defs/types.xml",
                decl.line,
                Some((decl.name_span.start, decl.name_span.end)),
                kb.types_text.as_deref(),
                limit,
            );
            if push(entry, &mut matches) {
                results_limited = true;
                break;
            }
        }
    }
    if !results_limited {
        // alias.xml 别名(行 + 字节 name_span)。
        for alias in &kb.alias.aliases {
            if alias.name.to_lowercase() != q {
                continue;
            }
            let entry = line_entry(
                "alias",
                &alias.name,
                "scripts/entity_defs/alias.xml",
                alias.line,
                Some((alias.name_span.start, alias.name_span.end)),
                kb.alias_text.as_deref(),
                limit,
            );
            if push(entry, &mut matches) {
                results_limited = true;
                break;
            }
        }
    }
    if !results_limited {
        // Python 符号(精确块 start..end)。
        for sym in &py {
            if sym.name.to_lowercase() != q {
                continue;
            }
            let Some(entry) = py_entry(root, sym, limit) else {
                continue;
            };
            if push(entry, &mut matches) {
                results_limited = true;
                break;
            }
        }
    }

    Ok(json!({
        "node": node,
        "count": matches.len(),
        "resultsLimited": results_limited,
        "matches": matches,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kb::ParsedDef;

    /// 纯 Python 夹具根(只写 scripts/,无 def)。
    fn py_root(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("kode-mcp-read-{tag}-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        for (name, src) in files {
            std::fs::write(scripts.join(name), src).unwrap();
        }
        root
    }

    /// 内存知识库:不落盘,直接装 def/types/alias 解析产物。
    fn kb_with_def(text: &str) -> AssetKnowledge {
        let mut k = AssetKnowledge::default();
        k.defs.insert(
            "Avatar".into(),
            ParsedDef {
                name: "Avatar".into(),
                category: "entity".into(),
                rel_path: "scripts/entity_defs/Avatar.def".into(),
                text: text.into(),
                model: kode_parser::model::parse_def(text),
            },
        );
        let types_text = "<root>\n<ITEM_ID> UINT16 </ITEM_ID>\n</root>";
        k.types_text = Some(types_text.into());
        k.types = kode_parser::model::parse_types(types_text);
        let alias_text = "<root>\n<ITEM_ID><Type>UINT16</Type></ITEM_ID>\n</root>";
        k.alias_text = Some(alias_text.into());
        k.alias = kode_parser::model::parse_alias(alias_text);
        k
    }

    #[test]
    fn empty_locator_is_error() {
        let k = AssetKnowledge::default();
        let root = py_root("empty", &[]);
        assert!(read_node(&k, &root, "  ", 120).is_err());
    }

    #[test]
    fn missing_node_is_honest_empty() {
        let k = AssetKnowledge::default();
        let root = py_root("missing", &[("a.py", "x = 1\n")]);
        let out = read_node(&k, &root, "nope", 120).unwrap();
        assert_eq!(out["count"], 0);
        assert!(out["matches"].as_array().unwrap().is_empty());
    }

    #[test]
    fn python_class_block_is_precise_start_to_end() {
        // 精确块:endLine 覆盖类体最后方法,不含其后的模块级尾码。
        let src = "class Avatar:\n    def make(self):\n        pass\n\n    def kill(self):\n        pass\n\nx = 1\n";
        let root = py_root("cls-block", &[("avatar.py", src)]);
        let k = AssetKnowledge::default();
        let out = read_node(&k, &root, "avatar", 120).unwrap();
        assert_eq!(out["count"], 1);
        let m = &out["matches"][0];
        assert_eq!(m["kind"], "class");
        assert_eq!(m["name"], "Avatar");
        assert_eq!(m["line"], 1);
        assert_eq!(m["endLine"], 6);
        let body = m["excerpt"].as_str().unwrap();
        assert!(body.contains("def kill"), "excerpt should cover class tail");
        assert!(
            !body.contains("x = 1"),
            "excerpt must not include module tail"
        );
        assert_eq!(m["excerptTruncated"], false);
    }

    #[test]
    fn python_method_block_carries_class_and_own_range() {
        let src = "class Avatar:\n    def make(self):\n        pass\n\ndef helper():\n    pass\n";
        let root = py_root("method-block", &[("avatar.py", src)]);
        let k = AssetKnowledge::default();
        let out = read_node(&k, &root, "make", 120).unwrap();
        assert_eq!(out["count"], 1);
        let m = &out["matches"][0];
        assert_eq!(m["kind"], "method");
        assert_eq!(m["class"], "Avatar");
        assert_eq!(m["line"], 2);
        assert_eq!(m["endLine"], 3);
        // 同名不串扰:helper 不出现在 make 的匹配里。
        let out2 = read_node(&k, &root, "helper", 120).unwrap();
        assert_eq!(out2["matches"][0]["kind"], "function");
    }

    #[test]
    fn def_property_window_is_line_anchored_without_endline() {
        // def 属性:无块尾 → 无 endLine、有窗口 excerpt、截断如实。
        let text = "<root>\n<Properties>\n<hp>\n<Type>UINT32</Type>\n<Flags>BASE</Flags>\n</hp>\n</Properties>\n</root>\n";
        let k = kb_with_def(text);
        let root = py_root("prop-window", &[]);
        let out = read_node(&k, &root, "hp", 120).unwrap();
        assert_eq!(out["count"], 1);
        let m = &out["matches"][0];
        assert_eq!(m["kind"], "entity-property");
        assert_eq!(m["entity"], "Avatar");
        assert_eq!(m["file"], "scripts/entity_defs/Avatar.def");
        // 属性行 = `<hp>` 标签所在 1 基行(line1 root / line2 Properties / line3 hp)。
        assert_eq!(m["line"], 3);
        assert!(m.get("endLine").is_none(), "windowed entry has no endLine");
        let body = m["excerpt"].as_str().unwrap();
        assert!(body.contains("<Type>UINT32</Type>"));
        assert_eq!(m["excerptTruncated"], false);
    }

    #[test]
    fn type_and_alias_entries_carry_byte_span() {
        let k = kb_with_def("<root><Properties /></root>");
        let root = py_root("span", &[]);
        let out = read_node(&k, &root, "ITEM_ID", 120).unwrap();
        // ITEM_ID 同时是 types.xml 类型与 alias.xml 别名 → 两条各自带 span。
        assert_eq!(out["count"], 2);
        let kinds: Vec<&str> = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["kind"].as_str().unwrap())
            .collect();
        assert!(kinds.contains(&"type"));
        assert!(kinds.contains(&"alias"));
        for m in out["matches"].as_array().unwrap() {
            assert!(m["span"]["start"].as_u64().is_some(), "byte span present");
            assert_eq!(m["excerptTruncated"], false);
        }
        let t = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == "type")
            .unwrap();
        assert_eq!(t["file"], "scripts/entity_defs/types.xml");
        // span 指向类型名文本:excerpt 与 span 都非空才可信。
        assert!(t["span"]["end"].as_u64().unwrap() > t["span"]["start"].as_u64().unwrap());
    }

    #[test]
    fn entity_entry_reads_from_line_one_with_limit_cap() {
        let mut text = String::from("<root>\n<Properties>\n");
        for i in 0..30 {
            text.push_str(&format!("<p{i}><Type>UINT32</Type></p{i}>\n"));
        }
        text.push_str("</Properties>\n</root>\n");
        let k = kb_with_def(&text);
        let root = py_root("entity-cap", &[]);
        let out = read_node(&k, &root, "Avatar", 10).unwrap();
        assert_eq!(out["count"], 1);
        let m = &out["matches"][0];
        assert_eq!(m["kind"], "entity");
        assert_eq!(m["line"], 1);
        // limit=10 → 恰 10 行且如实标截断(源 35 行)。
        assert_eq!(m["excerpt"].as_str().unwrap().lines().count(), 10);
        assert_eq!(m["excerptTruncated"], true);
    }

    #[test]
    fn case_insensitive_exact_but_never_substring() {
        let src = "class Avatar:\n    pass\n";
        let root = py_root("ci-exact", &[("avatar.py", src)]);
        let k = AssetKnowledge::default();
        // 大小写不敏感全等命中。
        let out = read_node(&k, &root, "AVATAR", 120).unwrap();
        assert_eq!(out["count"], 1);
        // 子串不算命中(读取面要精确;模糊面是 find_symbol/search_symbols)。
        let out2 = read_node(&k, &root, "Avat", 120).unwrap();
        assert_eq!(out2["count"], 0);
    }

    #[test]
    fn oversized_python_file_is_skipped_not_fabricated() {
        // 单文件 >1MB:跳过该匹配(如实少报),不虚构空 excerpt。
        let mut src = String::from("class Avatar:\n    pass\n# ");
        src.push_str(&"x".repeat(1_000_001));
        let root = py_root("oversize", &[("avatar.py", &src)]);
        let k = AssetKnowledge::default();
        let out = read_node(&k, &root, "Avatar", 120).unwrap();
        assert_eq!(out["count"], 0);
    }

    #[test]
    fn limit_is_clamped_to_hard_cap() {
        // limit=100000 被钳到 400;1 行类不截断。
        let src = "class Avatar:\n    pass\n";
        let root = py_root("clamp", &[("avatar.py", src)]);
        let k = AssetKnowledge::default();
        let out = read_node(&k, &root, "Avatar", 100_000).unwrap();
        assert_eq!(out["matches"][0]["excerptTruncated"], false);
    }
}
