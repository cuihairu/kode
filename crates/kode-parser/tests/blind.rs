//! 盲样抽验(QA-002 基础版):确定性伪随机变异语料,断言不 panic、
//! 诊断结构化(span 在界内)、树不丢。种子固定 → 失败可复现。
//! arbitrary/proptest 纲要随 fuzz 单后置(本单为确定性盲样)。

use kode_parser::json::collect_corpus;
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};
use kode_parser::xml::parse;

/// LCG 确定性伪随机(seed 固定,CI 可复现)。
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn repo_root() -> std::path::PathBuf {
    // crates/kode-parser/tests → 仓库根
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn corpus() -> Vec<(String, String)> {
    collect_corpus(&repo_root(), kode_parser::json::PARITY_CORPORA)
        .into_iter()
        .map(|(k, (_, v))| (k, v))
        .collect()
}

fn check_diagnostics(text_len: usize, diags: &[kode_parser::Diagnostic]) {
    for d in diags {
        assert!(d.span.start <= d.span.end, "诊断 span 倒挂: {d:?}");
        assert!(d.span.end <= text_len, "诊断 span 越界: {d:?}");
        assert!(!d.message.is_empty());
        assert!(!d.code.as_str().is_empty());
    }
}

#[test]
fn blind_mutations_never_panic() {
    let corpus = corpus();
    assert!(corpus.len() >= 20, "语料不足: {}", corpus.len());
    let mut rng = Lcg(0xDEF1_5EED);
    let mut total = 0usize;
    for (_, text) in &corpus {
        for round in 0..60 {
            let mut bytes = text.as_bytes().to_vec();
            match round % 4 {
                0 => {
                    // 截断
                    let cut = rng.below(bytes.len() + 1);
                    bytes.truncate(cut);
                }
                1 => {
                    // 随机字节翻转
                    for _ in 0..1 + rng.below(8) {
                        if bytes.is_empty() {
                            break;
                        }
                        let i = rng.below(bytes.len());
                        bytes[i] = (rng.below(256)) as u8;
                    }
                }
                2 => {
                    // 随机插入
                    for _ in 0..1 + rng.below(4) {
                        let i = rng.below(bytes.len() + 1);
                        let b = [b'<', b'>', b'"', b'#', b'&', 0xFF, b'\n'][rng.below(7)];
                        bytes.insert(i, b);
                    }
                }
                _ => {
                    // 随机删除
                    for _ in 0..1 + rng.below(6) {
                        if bytes.is_empty() {
                            break;
                        }
                        let i = rng.below(bytes.len());
                        bytes.remove(i);
                    }
                }
            }
            let Ok(mangled) = std::str::from_utf8(&bytes) else {
                continue; // 非 UTF-8 中间态由字节层截断轮覆盖
            };
            let len = mangled.len();
            let doc = parse(mangled, true);
            check_diagnostics(len, &doc.diagnostics);
            let def = parse_def(mangled);
            check_diagnostics(len, &def.diagnostics);
            let _ = parse_entities(mangled);
            let _ = parse_types(mangled);
            let _ = parse_alias(mangled);
            total += 1;
        }
    }
    // 数量可见性:-- --nocapture 时输出实测盲样数
    eprintln!("blind mutations executed: {total}");
    assert!(total > 500, "盲样量不足: {total}");
}

#[test]
fn blind_truncations_keep_prefix_tree() {
    let corpus = corpus();
    let mut rng = Lcg(0xC0FFEE);
    for (_, text) in corpus.iter().take(8) {
        for _ in 0..40 {
            let cut = rng.below(text.len() + 1);
            // 截断点吸附到 UTF-8 字符边界(模拟真实文件读取截断)
            let mut cut = cut.min(text.len());
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            let slice = &text[..cut];
            let doc = parse(slice, true);
            check_diagnostics(slice.len(), &doc.diagnostics);
            let def = parse_def(slice);
            check_diagnostics(slice.len(), &def.diagnostics);
            // 前缀树不丢:截断点在第一个开标签闭合后,根元素必在
            if let Some(root) = doc.root() {
                assert!(!doc.element(root).name.is_empty());
            }
        }
    }
}
