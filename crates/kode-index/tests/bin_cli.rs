//! dump-symbol-golden CLI behaviour gate: really spawns the binary and asserts stdout
//! is byte-for-byte identical to the in-library `golden::dump_symbols` (the same repo
//! root), and also covers the default argument `.` branch.
//! This is a real behaviour test of the documented CLI, not an indirect call into an
//! internal function.

use std::path::Path;
use std::process::Command;

fn repo_root() -> std::path::PathBuf {
    // crates/kode-index -> two levels up = repo root (the corpus is collected with
    // repo-relative paths).
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn json_shape_ok(stdout: &str) -> bool {
    // Parity comparison against the deterministic shape written by the golden
    // serializer: the generator header + the three top-level counting keys.
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

    // Real behaviour: the binary's stdout is byte-for-byte identical to the in-library
    // dump_symbols (the same root).
    let expected = kode_index::golden::dump_symbols(&root);
    assert_eq!(stdout, expected, "CLI stdout 必须与库内 dump_symbols 一致");
    assert!(json_shape_ok(stdout), "JSON 形状不符合 golden 契约");
    // The corpus is fixed at 30 files (matching the committed golden's fileCount).
    assert!(stdout.contains("\"fileCount\":30"), "语料文件数必须为 30");
}

#[test]
fn dump_symbols_binary_defaults_to_dot_in_cwd() {
    let root = repo_root();
    // No argument: cwd is the repo root, so the default "." means relative to the current
    // directory -> the same corpus.
    let output = Command::new(env!("CARGO_BIN_EXE_dump-symbol-golden"))
        .current_dir(&root)
        .output()
        .expect("spawn dump-symbol-golden (no arg)");
    assert!(output.status.success(), "无参调用必须成功");
    let stdout = String::from_utf8(output.stdout).expect("stdout utf8");
    let stdout = stdout.trim_end_matches('\n');
    assert!(!stdout.is_empty());
    // The default "." collects from cwd, matching the explicit repo_root result.
    assert_eq!(
        stdout,
        kode_index::golden::dump_symbols(&root),
        "默认参数 '.' 必须与显式 repo_root 产出一致"
    );
    assert!(json_shape_ok(stdout));
}
