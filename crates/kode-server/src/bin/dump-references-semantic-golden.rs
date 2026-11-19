//! references 语义分类 golden 生成器(RUST-138 批 2):批 1 同探针集,
//! 逐探针附逐站点三分类(semantic/shadow/dangling + 证据声明路径)。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeReferencesSemanticParity.test.ts
//! 用 defParser 原语独立复算对拍(双向门禁:Rust 测试重生成比对 +
//! vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_references_semantic_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
