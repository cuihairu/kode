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

/// Batch `git check-ignore --stdin -z` over `candidates` (relative paths).
/// Returns the set of ignored relative paths (forward slashes). Any git
/// failure (missing binary, not a repo, unreadable) degrades to
/// [`GitState::disabled`] so indexing never blocks on git.
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
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                // Broken pipe (git exits early) must not fail the probe.
                let _ = stdin.write_all(&input);
            }
            child.wait_with_output()
        });
    let Ok(output) = output else {
        return GitState::disabled();
    };
    // Exit codes: 0 = some paths ignored, 1 = none ignored, 128 = fatal
    // (not a repo / bad args). 128 means git could not answer → disabled.
    if output.status.code() == Some(128) {
        return GitState::disabled();
    }
    let mut ignored = std::collections::HashSet::new();
    for chunk in output.stdout.split(|b| *b == 0) {
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
}
