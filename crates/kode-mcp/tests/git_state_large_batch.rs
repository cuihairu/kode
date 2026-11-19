//! KODE-FULL-003:批量 git ignore 探测的管道死锁回归。
//!
//! 旧实现「先 write_all 全部候选、写完才 wait_with_output」:git 一边读
//! 路径一边回吐忽略名单,候选量超过管道容量(~64KB)后双方互等,知识索引
//! 永不结束。本文件用 2 万路径(≈240KB,远超管道容量)把窗口拉满——旧实现
//! 下本测试挂死(被收割即红),新实现必须秒级有界结束且混合结果正确。
//! 提前退出/超时路径由 kill+wait 收割子进程,无遗留 git 进程(由实现保证)。

use std::path::PathBuf;
use std::process::Command;

use kode_mcp::git_state::{probe, GitState};

fn git_repo(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("kode-mcp-gitstate-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "t"],
    ] {
        let ok = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(&args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed in temp repo");
    }
    // *.log 兜住 2 万候选;secret.md/ignored/ 与 in-file 测试同款,补混合面。
    std::fs::write(root.join(".gitignore"), "secret.md\nignored/\n*.log\n").unwrap();
    std::fs::write(root.join("visible.md"), "visible\n").unwrap();
    root
}

#[test]
fn twenty_thousand_ignored_paths_finish_bounded_with_mixed_results() {
    let root = git_repo("large-batch");
    let mut candidates = vec![root.join("visible.md"), root.join("secret.md")];
    for i in 0..20_000 {
        candidates.push(root.join(format!("bulk/ignored-{i:05}.log")));
    }
    let start = std::time::Instant::now();
    let state: GitState = probe(&root, &candidates);
    let elapsed = start.elapsed();

    assert!(state.available, "大批量探测必须保持可用(不降级)");
    // 2 万条 .log 全命中 *.log + secret.md 命中;visible.md 不误报。
    assert_eq!(state.ignored.len(), 20_001, "忽略计数与输入一一对应");
    assert!(state.ignored.contains("secret.md"));
    assert!(!state.ignored.contains("visible.md"), "非忽略路径不得混入");
    assert!(
        state.ignored.contains("bulk/ignored-00042.log"),
        "批内路径真实回执(抽样)"
    );
    // 有界结束:真实批次秒级,20s 是含 CI 慢机的极端余量。
    assert!(
        elapsed < std::time::Duration::from_secs(20),
        "大批量探测必须墙钟有界: {elapsed:?}"
    );

    std::fs::remove_dir_all(&root).ok();
}
