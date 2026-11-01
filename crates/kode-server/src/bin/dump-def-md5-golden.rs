//! def MD5 对拍 golden 生成器:输出引擎 `EntityDef::md5()` 重放样本
//! (demo-assets/parity-project/最小锚点)JSON,内置规范推导(provenance 引
//! kbengine 源 file:line)为权威;与引擎交叉验证尽力(链接依赖重则跳过,
//! 规范推导保持权威,同 wire-probe 先例)。

fn main() {
    // repo_root = crate 的上级上级(workspace 根),cargo 以 package dir 为 cwd。
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| std::path::Path::new("."));
    print!("{}", kode_server::def_md5::dump_def_md5_golden(repo_root));
    println!();
}
