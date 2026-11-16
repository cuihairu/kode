//! document symbols 对拍 golden 生成器:遍历 fixture 语料 def 文件,输出
//! Outline 符号树(四段容器+段内声明,range/selectionRange 全跨度)JSON。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeDocumentSymbolsParity.test.ts
//! 用现有 defParser 原语复算对拍(双向门禁,definition/references 同构)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_document_symbols_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
