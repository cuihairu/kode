//! 对拍 golden 生成器(ROOT-010):扫 fixture 树,输出锚点集 JSON。
//!
//! 用法(仓库根):
//!   cargo run -p kode-root --bin dump-golden -- . \
//!     > crates/kode-root/tests/golden/root-parity.json

fn main() {
    let repo_root = std::env::args().nth(1).unwrap_or_else(|| String::from("."));
    let fixtures = std::path::Path::new(&repo_root).join("crates/kode-root/tests/fixtures");
    print!("{}", kode_root::golden::dump_golden(&fixtures));
}
