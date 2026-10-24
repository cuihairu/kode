//! fixture 语料门禁:语料全量解析(不 panic/语义自洽)+ golden 重生成比对
//! (Rust 侧真值;TS 侧 tests/kodeParserParity.test.ts 用现有实现复算同一
//! golden,形成双向对拍)。

use kode_parser::json::{collect_corpus, dump_corpus};
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn corpus_parses_with_expected_semantics() {
    let corpus = collect_corpus(&repo_root(), kode_parser::json::PARITY_CORPORA);
    assert!(corpus.len() >= 25, "语料量异常: {}", corpus.len());
    let mut def_count = 0;
    for (path, (kind, text)) in &corpus {
        match *kind {
            "def" => {
                def_count += 1;
                let def = parse_def(text);
                check(path, text.len(), &def.diagnostics);
                assert_eq!(def.root_tag.as_deref(), Some("root"), "{path}");
                for p in &def.properties {
                    assert!(!p.name.is_empty());
                    assert!(p.line >= 1);
                }
            }
            "entities" => {
                let e = parse_entities(text);
                check(path, text.len(), &e.diagnostics);
                assert!(!e.entities.is_empty(), "{path} 实体清单不应为空");
                for ent in &e.entities {
                    assert_ne!(ent.name, "root", "root 伪条目必须排除: {path}");
                }
            }
            "types" => {
                let t = parse_types(text);
                check(path, text.len(), &t.diagnostics);
            }
            "alias" => {
                let a = parse_alias(text);
                check(path, text.len(), &a.diagnostics);
            }
            _ => panic!("unknown kind {kind}"),
        }
    }
    assert!(def_count >= 15, "def 数量异常: {def_count}");
}

fn check(path: &str, len: usize, diags: &[kode_parser::Diagnostic]) {
    for d in diags {
        assert!(d.span.end <= len, "{path}: span 越界 {d:?}");
    }
}

#[test]
fn golden_matches_regenerated_dump() {
    let regenerated = dump_corpus(&repo_root());
    let golden_path = repo_root().join("crates/kode-parser/tests/golden/def-parity.json");
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-parser/tests/golden/def-parity.json");
    // 尾部换行由重定向/dump-golden println! 引入,不参与比对
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        // 给出首个差异位置,便于定位是哪条语义变化
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "golden 与重生成不一致(偏移 {diff_at})。\nRust 侧:…{}\nTS 侧若需更新,重新运行:\n  cargo run -p kode-parser --bin dump-golden -- . > crates/kode-parser/tests/golden/def-parity.json\nRust 重生成:…{}",
            &regenerated[diff_at.saturating_sub(120)..(diff_at + 160).min(regenerated.len())],
            &regenerated[diff_at.saturating_sub(0)..(diff_at + 160).min(regenerated.len())],
        );
    }
    // golden 结构完整性
    assert!(committed.contains("\"fileCount\":"));
    assert!(committed.contains("dump-golden"));
}
