//! dump-symbol-golden CLI 行为门禁:真实 spawn 二进制,断言 stdout 与库内
//! `golden::dump_symbols` 逐字节一致(同一 repo root),并覆盖默认参数 `.` 分支。
//! 这是文档化 CLI 的真实行为测试,不是对内部函数的间接调用。

use std::path::Path;
use std::process::Command;

fn repo_root() -> std::path::PathBuf {
    // crates/kode-index → 上两级 = 仓库根(语料以仓库相对路径收集)。
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn json_shape_ok(stdout: &str) -> bool {
    // 与 golden 序列化器写出的确定形状对拍:generator 头 + 三个顶层计数键。
    stdout.contains("\"generator\":\"kode-index dump-symbol-golden\"")
        && stdout.contains("\"fileCount\":")
        && stdout.contains("\"symbolCount\":")
        && stdout.contains("\"files\":[")
        && stdout.contains("\"name\":\"")
        && stdout.contains("\"facet\":")
        && stdout.contains("\"detail\":")
}

#[test]
fn dump_symbols_binary_with_explicit_repo_root() {
    let root = repo_root();
    let output = Command::new(env!("CARGO_BIN_EXE_dump-symbol-golden"))
        .arg(&root)
        .output()
        .expect("spawn dump-symbol-golden");
    assert!(
        output.status.success(),
        "CLI 退出码非 0: stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout utf8");
    let stdout = stdout.trim_end_matches('\n');
    assert!(!stdout.is_empty(), "stdout 必须非空");

    // 真实行为:二进制 stdout 与库内 dump_symbols(同一 root)逐字节一致。
    let expected = kode_index::golden::dump_symbols(&root);
    assert_eq!(stdout, expected, "CLI stdout 必须与库内 dump_symbols 一致");
    assert!(json_shape_ok(stdout), "JSON 形状不符合 golden 契约");
    // 语料固定 30 文件(与 committed golden 的 fileCount 一致)。
    assert!(stdout.contains("\"fileCount\":30"), "语料文件数必须为 30");
}

#[test]
fn dump_symbols_binary_defaults_to_dot_in_cwd() {
    let root = repo_root();
    // 不带参数:cwd 为 repo root,默认 "." 即相对当前目录 → 同一语料。
    let output = Command::new(env!("CARGO_BIN_EXE_dump-symbol-golden"))
        .current_dir(&root)
        .output()
        .expect("spawn dump-symbol-golden (no arg)");
    assert!(output.status.success(), "无参调用必须成功");
    let stdout = String::from_utf8(output.stdout).expect("stdout utf8");
    let stdout = stdout.trim_end_matches('\n');
    assert!(!stdout.is_empty());
    // 默认 "." 从 cwd 收集,与显式 repo_root 结果一致。
    assert_eq!(
        stdout,
        kode_index::golden::dump_symbols(&root),
        "默认参数 '.' 必须与显式 repo_root 产出一致"
    );
    assert!(json_shape_ok(stdout));
}
