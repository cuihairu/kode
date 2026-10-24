//! 对拍 golden 生成器:遍历 fixture 语料,输出每文件类型面 + 图级链/环 JSON。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeTypesParity.test.ts 用现有
//! defParser/compositionRoots 原语复算对拍(双向门禁:Rust 测试重生成比对 +
//! vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_types::golden::dump_type_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
