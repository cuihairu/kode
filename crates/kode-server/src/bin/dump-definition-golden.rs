//! definition 对拍 golden 生成器:遍历 fixture 语料,输出每文件每声明符号
//! (含 Parent/Type 取值探针)的定义落点 JSON。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeDefinitionParity.test.ts 用现有
//! defParser 原语复算对拍(双向门禁:Rust 测试重生成比对 + vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_definition_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
