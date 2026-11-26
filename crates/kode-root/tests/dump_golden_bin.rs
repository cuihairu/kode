//! bin smoke test (ROOT-010): the dump-golden generator emits the complete golden
//! JSON for the repo root.
//!
//! The integration test runs the binary directly, covering main()'s executable surface
//! and output shape; the TS-side `kodeRootParity.test.ts` then does a full JSON.parse
//! recomputation of that file (bidirectional gate).

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
    // All six parity trees are listed by name.
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
    // No-arg invocation: the default "." = repo root (cwd is the repo root, covering
    // the unwrap_or fallback branch).
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
