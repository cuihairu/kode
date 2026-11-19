//! SignatureHelp 决策核 golden 生成器(RUST-140 批 2):批 1 词法命中全集
//! 上逐命中组附签名四件(label/形参/documentation/声明落点)与逐位
//! activeArgument→activeParameter 标亮。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeSignatureHelpParity.test.ts
//! 用生产词法面 + 生产注解链独立复算对拍(双向门禁:Rust 测试重生成
//! 比对 + vitest 复算)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_signature_help_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
