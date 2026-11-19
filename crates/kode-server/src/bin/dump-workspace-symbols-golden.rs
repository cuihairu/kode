//! WorkspaceSymbol 快速搜索 golden 生成器(RUST-139 批 2):全集符号名
//! 派生确定性前缀探针(原形/小写两字符/原形两字符)+ 负例 + 空前缀,
//! 逐探针记命中全量(rootName/symbolName/kind/section/声明落点/行)。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeWorkspaceSymbolsParity.test.ts
//! 用 defParser 原语独立复算对拍(双向门禁:Rust 测试重生成比对 +
//! vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_workspace_symbols_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
