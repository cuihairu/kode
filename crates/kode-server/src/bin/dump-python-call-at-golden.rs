//! python call-at 对拍 golden 生成器:遍历 fixture .py 语料,逐行逐位置探测
//! 接收者调用解析面(非空命中入 golden,probeCount 全集对账)。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodePythonCallAtParity.test.ts 直接
//! import 生产 getPythonCallAtPosition 逐位置复算对拍(双向门禁)。

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    print!(
        "{}",
        kode_server::dump_python_call_at_golden(std::path::Path::new(&repo_root))
    );
    println!();
}
