//! bin 三入口冒烟:CARGO_BIN_EXE 真进程跑通 golden 生成器主路径
//! (golden 重生成比对走 lib 面 fixtures_golden;此处只钉「bin 可执行、
//! 参数约定 repo_root、输出 JSON 顶层键」这一层)。

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn dump_bins_execute_against_repo_root() {
    let cases = [
        (
            env!("CARGO_BIN_EXE_dump-def-golden"),
            "\"files\"",
            "dump-def-golden",
        ),
        (
            env!("CARGO_BIN_EXE_dump-config-golden"),
            "\"files\"",
            "dump-config-golden",
        ),
        (
            env!("CARGO_BIN_EXE_dump-config-merge-golden"),
            "\"pairs\"",
            "dump-config-merge-golden",
        ),
    ];
    for (bin, key, name) in cases {
        let out = std::process::Command::new(bin)
            .arg(repo_root())
            .output()
            .unwrap_or_else(|e| panic!("spawn {name}: {e}"));
        assert!(out.status.success(), "{name} 退出码异常: {:?}", out.status);
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains(&format!("\"generator\":\"kode-parser {name}\"")),
            "{name} 溯源头缺失: {}",
            &stdout[..stdout.len().min(120)]
        );
        assert!(stdout.contains(key), "{name} 顶层键 {key} 缺失");
        assert!(stdout.trim_end().ends_with('}'), "{name} 应以 JSON 收尾");
    }
}
