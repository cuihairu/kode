//! ROOT-010 parity golden serialization: dependency-free JSON, write-only (reading is
//! left to the TS JSON.parse).
//!
//! The output shape must match the TS recomputer in `tests/kodeRootParity.test.ts`
//! field by field; any change on either side must regenerate the golden and make both
//! gates pass. Anchor paths are relative to each fixture tree root, `/` separated,
//! sorted and de-duplicated (erasing readdir order differences); scanVisited is an exact
//! count (the TS walk counts per entry, so both sides must be equal).

use std::fmt::Write as _;
use std::path::Path;

use crate::scan::{scan_workspace_anchors, ScanOptions};

/// Parity fixture trees (beneath `crates/kode-root/tests/fixtures/`, repo-relative).
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

/// Generate the golden (ROOT-010): each tree's anchor set + visited/truncation flags.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_json_covers_every_escape_arm() {
        // Quotes/backslashes/control characters are escaped one by one; plain
        // characters are kept as they are.
        assert_eq!(escape_json("plain"), "plain");
        assert_eq!(escape_json("a\"b"), "a\\\"b");
        assert_eq!(escape_json("a\\b"), "a\\\\b");
        assert_eq!(escape_json("a\nb\rc\td"), "a\\nb\\rc\\td");
        // Other < 0x20 control characters take the \\u form.
        assert_eq!(escape_json("a\u{1}b"), "a\\u0001b");
        assert_eq!(escape_json("a\u{7}b"), "a\\u0007b");
        // Non-ASCII is kept as-is (the golden surface does not re-encode).
        assert_eq!(escape_json("怪物"), "怪物");
    }

    #[test]
    fn dump_golden_emits_complete_parity_shape() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let text = dump_golden(&fixtures);
        assert!(
            text.starts_with("{\n  \"generator\": \"cargo run -p kode-root --bin dump-golden"),
            "{text}"
        );
        assert!(text.contains("\"fixturesDir\": \"crates/kode-root/tests/fixtures\""));
        // All six parity trees are listed by name, each carrying visited/truncation
        // flags.
        for tree in PARITY_TREES {
            assert!(
                text.contains(&format!("\"name\": \"{tree}\"")),
                "missing {tree}"
            );
        }
        assert!(text.contains("\"scanVisited\""));
        assert!(text.contains("\"scanTruncated\""));
        assert!(text.trim_end().ends_with('}'));
        // Brace balance (the dependency-free JSON shape precondition; the TS side
        // does a full JSON.parse recomputation).
        let open = text.matches('{').count();
        let close = text.matches('}').count();
        assert_eq!(open, close, "golden braces must balance");
        assert!(text.contains("\"entityDefs\""), "{text}");
    }
}
