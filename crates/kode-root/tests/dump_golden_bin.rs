//! bin 冒烟(ROOT-010):dump-golden 生成器对仓库根产出完整 golden JSON。
//!
//! 集成测试直接跑二进制,验证 main() 的可执行面与产出形状;TS 侧的
//! `kodeRootParity.test.ts` 再对该文件做全量 JSON.parse 复算(双向门禁)。

use std::process::Command;

#[test]
fn dump_golden_bin_emits_json_for_repo_root() {
    let bin = env!("CARGO_BIN_EXE_dump-golden");
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let out = Command::new(bin)
        .arg(repo_root.to_str().unwrap())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(
        text.starts_with("{\n  \"generator\": \"cargo run -p kode-root --bin dump-golden"),
        "{text}"
    );
    // 六棵对拍树逐一名列。
    for tree in [
        "linux_assets",
        "engine_repo",
        "multi_ambiguous",
        "submodule_vendor",
        "sensitive_dirs",
        "deep_nest",
    ] {
        assert!(
            text.contains(&format!("\"name\": \"{tree}\"")),
            "missing {tree}"
        );
    }
    assert!(text.trim_end().ends_with('}'));
}

#[test]
fn dump_golden_bin_defaults_to_repo_root_when_no_args() {
    // 无参调用:默认 "." = 仓库根(cwd 设为仓库根,验证 unwrap_or 兜底分支)。
    let bin = env!("CARGO_BIN_EXE_dump-golden");
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let out = Command::new(bin).current_dir(&repo_root).output().unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.starts_with("{\n  \"generator\": "));
    assert!(text.contains("\"trees\""));
}
