//! diagnostics 对拍 golden 生成器:遍历 fixture 语料,输出每份 .def 的
//! 诊断面 JSON(validateDocument 语料子集,消息/区间/级别/顺序同 TS)。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeDiagnosticsParity.test.ts 用
//! parseDefDocument + kbengineMetadata 词表复算对拍(双向门禁)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_diagnostics_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
