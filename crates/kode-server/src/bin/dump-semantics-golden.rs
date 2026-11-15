//! 语义 fixture 金标生成器(RUST-116):demo-assets 语料上 KSEM 纯库面
//! 产出整体快照(doclass/nav/重复三面/rename 归属)JSON;消费方重放见
//! tests/semantic_golden.rs。

fn main() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| std::path::Path::new("."));
    print!("{}", kode_server::semantics_golden::dump_semantics_golden(repo_root));
}
