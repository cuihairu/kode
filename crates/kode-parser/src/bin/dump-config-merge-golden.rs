//! 配置合并对拍 golden 生成器:遍历 CONFIG_MERGE_PAIRS,输出每对
//! merge(base, override) 树 JSON。
//!
//! golden 由 Rust 产出、TS 侧 tests/configMergeParity.test.ts 用现有
//! parseConfigXml+mergeConfigXml 复算对拍(双向门禁:Rust 测试重生成比对 +
//! vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_parser::json::dump_config_merge_corpus(std::path::Path::new(&repo_root))
    );
    println!();
}
