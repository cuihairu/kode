//! Git-state awareness for the index (KODE-MCP-KB-002 P2, design doc §9).
//!
//! Per the design's incremental-update contract, generated/vendor/gitignored
//! files are never indexed. `git check-ignore` is consulted in one batched
//! call per reconcile; when the root is not a git repository or git is
//! unavailable, filtering is honestly reported as off (`available: false`)
//! rather than silently pretending everything is clean.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Result of probing git ignore state for a set of candidate files.
#[derive(Debug)]
pub struct GitState {
    /// Whether git is available AND the root is inside a git repository.
    pub available: bool,
    /// Relative paths (forward slashes) that git reports as ignored.
    pub ignored: std::collections::HashSet<String>,
}

impl GitState {
    pub fn disabled() -> GitState {
        GitState {
            available: false,
            ignored: std::collections::HashSet::new(),
        }
    }
}

/// A root is inside a git repository if it (or an ancestor) has a real `.git`
/// entry: a `.git` file (gitlink/submodule) or a `.git` directory carrying
/// `HEAD` (git's own discovery requires the latter — an empty `.git` dir is
/// not a repository). Cheap directory check, avoids spawning git needlessly.
pub fn has_git_dir(root: &Path) -> bool {
    let mut cur = Some(root.to_path_buf());
    while let Some(dir) = cur {
        let dot = dir.join(".git");
        if dot.exists() && (dot.is_file() || dot.join("HEAD").exists()) {
            return true;
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    false
}

/// 批量探测的墙钟上限:git 卡死/挂起时到点 kill+wait 并降级,探测永不
/// 无限阻塞知识索引(2 万路径量级的真实批次在秒级完成,30s 是极端余量)。
const PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

/// Batch `git check-ignore --stdin -z` over `candidates` (relative paths).
/// Returns the set of ignored relative paths (forward slashes). Any git
/// failure (missing binary, not a repo, unreadable, or overruning the
/// deadline) degrades to [`GitState::disabled`] so indexing never blocks on
/// git.
pub fn probe(root: &Path, candidates: &[PathBuf]) -> GitState {
    if candidates.is_empty() || !has_git_dir(root) {
        return GitState::disabled();
    }
    let mut input: Vec<u8> = Vec::new();
    for c in candidates {
        let rel = c.strip_prefix(root).unwrap_or(c);
        input.extend_from_slice(rel.to_string_lossy().replace('\\', "/").as_bytes());
        input.push(0);
    }
    let mut child = match Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return GitState::disabled(),
    };
    // KODE-FULL-003:写 stdin 与排空 stdout 必须并发。git check-ignore 一边
    // 读路径一边回吐忽略名单——任一方塞满管道就会停读对方,旧的「先
    // write_all 全部候选、写完才 wait_with_output」在候选量超过管道容量
    // (~64KB)时双方互等死锁,知识索引永不结束。写线程闭包结束 drop 掉
    // stdin(EOF),git 才会收尾;broken pipe(git 提前退出)只忽略写入误差。
    let stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        use std::io::Write;
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&input);
        }
    });
    let mut stdout = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<Vec<u8>>>();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let result = match stdout.as_mut() {
            Some(pipe) => std::io::Read::read_to_end(pipe, &mut buf).map(|_| buf),
            None => Ok(buf),
        };
        let _ = tx.send(result);
    });
    // 有界排空 stdout:到点 kill+wait,绝无遗留进程,如实降级。
    let drained = match rx.recv_timeout(PROBE_DEADLINE) {
        Ok(Ok(bytes)) => Some(bytes),
        Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => None,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    };
    // 写线程必能返回:要么写完,要么管道破裂出误差(已忽略)。
    let _ = writer.join();
    let _ = reader.join();
    let Some(stdout_bytes) = drained else {
        return GitState::disabled();
    };
    let deadline = std::time::Instant::now() + PROBE_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => break None,
        }
    };
    let Some(status) = status else {
        return GitState::disabled();
    };
    // Exit codes: 0 = some paths ignored, 1 = none ignored, 128 = fatal
    // (not a repo / bad args). 128 means git could not answer → disabled.
    if status.code() == Some(128) {
        return GitState::disabled();
    }
    let mut ignored = std::collections::HashSet::new();
    for chunk in stdout_bytes.split(|b| *b == 0) {
        if chunk.is_empty() {
            continue;
        }
        if let Ok(s) = std::str::from_utf8(chunk) {
            ignored.insert(s.to_string());
        }
    }
    GitState {
        available: true,
        ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a temp git repo with a .gitignore; returns the root.
    fn git_repo(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-gitstate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // `git init` + identity so commands behave in CI and locally.
        for cmd in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "t"],
        ] {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(&cmd)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {cmd:?} failed in temp repo");
        }
        std::fs::write(root.join(".gitignore"), "secret.md\nignored/\n").unwrap();
        std::fs::write(root.join("visible.md"), "visible\n").unwrap();
        std::fs::write(root.join("secret.md"), "secret\n").unwrap();
        std::fs::create_dir_all(root.join("ignored")).unwrap();
        std::fs::write(root.join("ignored/inner.md"), "inner\n").unwrap();
        root
    }

    #[test]
    fn has_git_dir_true_for_repo_and_false_for_plain_dir() {
        let repo = git_repo("hasgit");
        assert!(has_git_dir(&repo));
        let plain = std::env::temp_dir().join(format!("kode-mcp-plain-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!has_git_dir(&plain));
        std::fs::remove_dir_all(&repo).ok();
        std::fs::remove_dir_all(&plain).ok();
    }

    #[test]
    fn probe_flags_gitignored_files() {
        let root = git_repo("probe");
        let candidates = vec![
            root.join("visible.md"),
            root.join("secret.md"),
            root.join("ignored/inner.md"),
        ];
        let state = probe(&root, &candidates);
        assert!(state.available, "git must be available in the temp repo");
        assert!(state.ignored.contains("secret.md"));
        assert!(state.ignored.contains("ignored/inner.md"));
        assert!(!state.ignored.contains("visible.md"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn probe_disabled_outside_git_repo() {
        let plain = std::env::temp_dir().join(format!("kode-mcp-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("a.md"), "x").unwrap();
        let state = probe(&plain, &[plain.join("a.md")]);
        assert!(!state.available);
        assert!(state.ignored.is_empty());
        std::fs::remove_dir_all(&plain).ok();
    }

    #[test]
    fn probe_empty_candidates_is_disabled() {
        let repo = git_repo("empty");
        let state = probe(&repo, &[]);
        assert!(!state.available);
        std::fs::remove_dir_all(&repo).ok();
    }

    /// `.git/HEAD` 存在(has_git_dir 过)但内容非法:git check-ignore 以
    /// 128 fatal 退出 → 降级 disabled,索引绝不因 git 卡死。
    #[test]
    fn probe_disabled_when_git_fatals_on_broken_head() {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-gitstate-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("HEAD"), "garbage\n").unwrap();
        let state = probe(&root, &[root.join("a.py")]);
        assert!(
            !state.available,
            "git exit 128 (fatal) must degrade to disabled"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
