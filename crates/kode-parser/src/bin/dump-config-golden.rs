//! 配置域对拍 golden 生成器:遍历配置 fixture 语料,输出每文件解析树 JSON。
//!
//! golden 由 Rust 产出、TS 侧 tests/configParity.test.ts 用现有 parseConfigXml
//! 复算对拍(双向门禁:Rust 测试重生成比对 + vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_parser::json::dump_config_corpus(std::path::Path::new(&repo_root))
    );
    println!();
}
