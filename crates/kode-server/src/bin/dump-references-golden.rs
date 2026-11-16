//! references 对拍 golden 生成器:遍历 fixture 语料,输出每文件每符号探针
//! (Parent/Type/Arg/of 取值词、types.xml 顶层声明名)的引用位 JSON。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeReferencesParity.test.ts 用现有
//! defParser 原语复算对拍(双向门禁:Rust 测试重生成比对 + vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_references_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
