//! dump-type-golden 可执行面:子进程跑 main(),断言 stdout 是 golden JSON
//! 形状(generator/fileCount/typeNodeCount/files/graph;与库函数输出一致)。

use std::process::Command;

/// 仓库根(语料路径 tests/fixtures/... 相对仓库根;kode-types 在 crates/ 下)。
fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn dump_type_golden_bin_prints_golden_shape() {
    let out = Command::new(env!("CARGO_BIN_EXE_dump-type-golden"))
        .arg(repo_root())
        .output()
        .expect("spawn dump-type-golden");
    assert!(out.status.success(), "exit code {:?}", out.status);
    let stdout = String::from_utf8(out.stdout).expect("stdout is utf-8");
    assert!(
        !stdout.trim().is_empty(),
        "stdout 非空(stderr: {})",
        String::from_utf8_lossy(&out.stderr)
    );
    // main 末尾 println! 带一个换行;去掉后应与库函数逐字节一致。
    assert!(
        stdout.ends_with('\n'),
        "尾部换行由 println! 引入: {stdout:?}"
    );
    let body = stdout.trim_end_matches('\n');

    // 文档形状:{"generator":"kode-types dump-type-golden","fileCount":N,
    // "typeNodeCount":N,"files":[...],"graph":{"classifications":[...],
    // "aliasChains":[...],"inheritanceChains":[...],"cycles":[...]}}。
    assert!(
        body.starts_with("{\"generator\":\"kode-types dump-type-golden\",\"fileCount\":"),
        "generator + fileCount 打头: {}",
        &body[..120.min(body.len())]
    );
    assert!(body.contains("\"typeNodeCount\":"), "{body}");
    assert!(body.contains("\"files\":[{"), "files 数组非空: {body}");
    for section in [
        "\"classifications\":[",
        "\"aliasChains\":[",
        "\"inheritanceChains\":[",
        "\"cycles\":[",
    ] {
        assert!(body.contains(section), "graph.{section} 在: {body}");
    }

    // 与库函数同参输出逐字节一致(bin 只是薄壳)。
    let expected = kode_types::golden::dump_type_golden(&repo_root());
    assert_eq!(body, expected, "bin 输出 = dump_type_golden(repo_root)");
    assert!(
        out.stderr.is_empty(),
        "stderr 应为空: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
