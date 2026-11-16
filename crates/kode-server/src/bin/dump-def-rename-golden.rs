//! def 重命名对拍 golden 生成器:遍历 fixture .def 语料,逐文件逐偏移探测
//! 符号解析面(非空命中入 golden),对每个可解析符号跑同文件冲突候选、
//! 全工作区编辑计算与闭包冲突候选(候选宇宙规则见 dump_def_rename_golden
//! 头注)。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeDefRenameParity.test.ts 直接
//! import 生产 defRenamer 函数复算对拍(双向门禁)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_def_rename_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
