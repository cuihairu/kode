//! golden 重生成比对(Rust 侧真值;TS 侧 tests/kodeIndexParity.test.ts 用现有
//! defParser 原语复算同一 golden,形成双向对拍,PR-005 同构)。

use kode_index::golden::{dump_symbols, GOLDEN_REL_PATH};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn symbol_golden_matches_regenerated_dump() {
    let regenerated = dump_symbols(&repo_root());
    let golden_path = repo_root().join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-index/tests/golden/symbol-parity.json");
    // 尾部换行由重定向/dump-symbol-golden println! 引入,不参与比对
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "symbol golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-index --bin dump-symbol-golden -- . > crates/kode-index/tests/golden/symbol-parity.json\nRust 重生成:…{}",
            &regenerated[diff_at.saturating_sub(120)..(diff_at + 160).min(regenerated.len())],
        );
    }
    assert!(committed.contains("\"symbolCount\":"));
    assert!(committed.contains("dump-symbol-golden"));
}

#[test]
fn symbol_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(repo_root().join(GOLDEN_REL_PATH)).expect("golden");
    let value = parse_json(committed.trim_end_matches('\n'));
    assert!(
        value.file_count >= 25,
        "语料文件数异常: {}",
        value.file_count
    );
    assert_eq!(
        value.symbols.len(),
        value.symbol_count,
        "symbolCount 与实际不符"
    );
    for sym in &value.symbols {
        assert!(sym.line >= 1, "行号非法: {sym:?}");
        assert!(
            matches!(
                sym.kind.as_str(),
                "entity" | "property" | "method" | "type" | "alias" | "component"
            ),
            "未知种类: {}",
            sym.kind
        );
        if sym.kind == "method" {
            assert!(sym.facet.is_some(), "方法缺少分面: {sym:?}");
        }
    }
    // 能力面:六类符号中,语料可表达五类(alias 语料仅有 TS 同口径之外的
    // 属性式别名,不计入 golden;alias 记录由 index_units 用合成文件覆盖)。
    let kinds: std::collections::BTreeSet<&str> =
        value.symbols.iter().map(|s| s.kind.as_str()).collect();
    for expected in ["entity", "property", "method", "type", "component"] {
        assert!(kinds.contains(expected), "golden 缺少种类 {expected}");
    }
}

// --- 极小 JSON 读取器(测试专用;golden 是本 crate 自己写出的确定形状) ---

#[derive(Default)]
struct Value {
    file_count: usize,
    symbol_count: usize,
    symbols: Vec<Rec>,
}

#[derive(Debug)]
struct Rec {
    kind: String,
    line: usize,
    facet: Option<String>,
}

fn parse_json(text: &str) -> Value {
    let mut out = Value::default();
    for cap in text.split("{\"name\":").skip(1) {
        let get = |key: &str| -> Option<String> {
            let marker = format!("\"{key}\":");
            let rest = cap.split(marker.as_str()).nth(1)?;
            let rest = rest.trim_start();
            if rest.starts_with('"') {
                Some(rest.strip_prefix('"')?.split('"').next().unwrap_or("").to_string())
            } else {
                let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if num.is_empty() {
                    None
                } else {
                    Some(num)
                }
            }
        };
        out.symbols.push(Rec {
            kind: get("kind").unwrap_or_default(),
            line: get("line").and_then(|v| v.parse().ok()).unwrap_or(0),
            facet: get("facet"),
        });
    }
    let take_num = |key: &str| -> usize {
        text.split(&format!("\"{key}\":"))
            .nth(1)
            .map(|rest| {
                rest.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    };
    out.file_count = take_num("fileCount");
    out.symbol_count = take_num("symbolCount");
    out
}
