//! 诊断分级装配 golden 生成器(RUST-142 批 2):语料逐 def 文件全量 lint
//! (production-shape knownTypes)→ 决策表路由 → 逐层独立调度核回放。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeDiagnosticLayeringParity.test.ts
//! 复算决策表/合流序/production seam 对拍(双向门禁)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_diagnostic_layering_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
