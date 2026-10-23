//! ROOT-010 对拍 golden 序列化:零依赖 JSON 只写不读(读取交 TS JSON.parse)。
//!
//! 输出形状须与 `tests/kodeRootParity.test.ts` 的 TS 复算器逐字段一致;
//! 任何一侧改动都要重新生成 golden 并让两侧门禁同时过。锚点路径相对各
//! fixture 树根、`/` 分隔、排序去重(消除 readdir 序差);scanVisited 为
//! 精确计数(TS walk 逐条目计数,两侧必须完全相等)。

use std::fmt::Write as _;
use std::path::Path;

use crate::scan::{scan_workspace_anchors, ScanOptions};

/// 对拍 fixture 树(仓库相对 `crates/kode-root/tests/fixtures/` 之下)。
pub const PARITY_TREES: &[&str] = &[
    "linux_assets",
    "engine_repo",
    "multi_ambiguous",
    "submodule_vendor",
    "sensitive_dirs",
    "deep_nest",
];

fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

fn dump_str_list(out: &mut String, key: &str, values: &[std::path::PathBuf]) {
    let _ = write!(
        out,
        "\"{}\": [{}]",
        key,
        values
            .iter()
            .map(|p| format!("\"{}\"", escape_json(&p.to_string_lossy())))
            .collect::<Vec<_>>()
            .join(", ")
    );
}

/// 生成 golden(ROOT-010):每树锚点集 + visited/截断旗标。
pub fn dump_golden(fixtures_dir: &Path) -> String {
    let mut out = String::new();
    out.push_str(
        "{\n  \"generator\": \"cargo run -p kode-root --bin dump-golden -- <repo-root>\",\n",
    );
    let _ = writeln!(
        out,
        "  \"fixturesDir\": \"crates/kode-root/tests/fixtures\","
    );
    out.push_str("  \"trees\": [\n");
    for (idx, tree) in PARITY_TREES.iter().enumerate() {
        let root = fixtures_dir.join(tree);
        let scan = scan_workspace_anchors(&root, &ScanOptions::default());
        let view = scan.sorted_view();
        let rel = |p: &std::path::Path| {
            p.strip_prefix(&root)
                .unwrap_or(p)
                .to_string_lossy()
                .replace('\\', "/")
        };
        let _ = writeln!(out, "    {{");
        let _ = writeln!(out, "      \"name\": \"{}\",", escape_json(tree));
        let lists = [
            ("entityDefs", &view.entity_defs),
            ("entitiesXml", &view.entities_xml),
            ("typesXml", &view.types_xml),
            ("kbeSourceRoots", &view.kbe_source_roots),
            ("messagesXml", &view.messages_xml),
            ("configRoots", &view.config_roots),
        ];
        for (key, values) in lists.iter() {
            let rel_values: Vec<std::path::PathBuf> = values
                .iter()
                .map(|p| rel(p))
                .map(std::path::PathBuf::from)
                .collect();
            out.push_str("      ");
            dump_str_list(&mut out, key, &rel_values);
            out.push_str(",\n");
        }
        let _ = writeln!(out, "      \"scanVisited\": {},", scan.scan_visited);
        let _ = writeln!(out, "      \"scanTruncated\": {}", scan.scan_truncated);
        let _ = write!(out, "    }}");
        if idx + 1 < PARITY_TREES.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str("  ]\n}\n");
    out
}
