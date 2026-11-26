//! Bounded, non-following directory discovery shared by MCP searches.
use std::collections::HashSet;
use std::path::PathBuf;

pub struct Scan {
    pub files: Vec<PathBuf>,
    pub truncated: bool,
    pub errors: usize,
}

pub fn collect(roots: &[PathBuf], extension: &str, skipped: &[&str], limit: usize) -> Scan {
    let mut scan = Scan {
        files: Vec::new(),
        truncated: false,
        errors: 0,
    };
    let mut stack = roots.to_vec();
    let mut visited = HashSet::new();
    let mut entries_seen = 0usize;
    // File limits alone do not bound directories containing no matching files.
    let entry_limit = limit.saturating_mul(100).max(1);
    while let Some(dir) = stack.pop() {
        let canonical = match std::fs::canonicalize(&dir) {
            Ok(path) => path,
            Err(_) => {
                scan.errors += 1;
                continue;
            }
        };
        if !visited.insert(canonical) {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                scan.errors += 1;
                continue;
            }
        };
        for entry in entries {
            entries_seen += 1;
            if entries_seen > entry_limit {
                scan.truncated = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    scan.errors += 1;
                    continue;
                }
            };
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => {
                    scan.errors += 1;
                    continue;
                }
            };
            let path = entry.path();
            // Never follow nested symlinks, including links to ancestor directories.
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !skipped.contains(&name) {
                    stack.push(path);
                }
            } else if kind.is_file() && path.extension().and_then(|e| e.to_str()) == Some(extension)
            {
                if scan.files.len() >= limit {
                    scan.truncated = true;
                    break;
                }
                scan.files.push(path);
            }
        }
        if scan.truncated {
            break;
        }
    }
    scan.files.sort();
    scan.files.dedup();
    scan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_single_directory_and_deduplicates_roots() {
        let root = std::env::temp_dir().join(format!("kode-mcp-scan-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..4 {
            std::fs::write(root.join(format!("{i}.md")), "test").unwrap();
        }
        let scan = collect(&[root.clone(), root.clone()], "md", &[], 2);
        assert_eq!(scan.files.len(), 2);
        assert!(scan.truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlink_cycles() {
        let root = std::env::temp_dir().join(format!("kode-mcp-cycle-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "test").unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        let scan = collect(std::slice::from_ref(&root), "md", &[], 5);
        assert_eq!(scan.files.len(), 1);
        assert!(!scan.truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_roots_are_visited_once_without_truncation() {
        // The same root given twice (non-truncation scenario): the second
        // canonical is already visited → skipped, files not duplicated.
        let root = std::env::temp_dir().join(format!("kode-mcp-scan2-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "test").unwrap();
        std::fs::write(root.join("b.md"), "test").unwrap();
        let scan = collect(&[root.clone(), root.clone()], "md", &[], 10);
        assert_eq!(scan.files.len(), 2);
        assert!(!scan.truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn root_that_is_a_file_counts_as_scan_error() {
        // A root that is a file rather than a directory: canonicalize
        // succeeds, read_dir fails → errors +1.
        let root = std::env::temp_dir().join(format!("kode-mcp-scanfile-{}", std::process::id()));
        std::fs::write(&root, "not a dir").unwrap();
        let scan = collect(std::slice::from_ref(&root), "md", &[], 10);
        assert_eq!(scan.files.len(), 0);
        assert_eq!(scan.errors, 1);
        std::fs::remove_file(root).unwrap();
    }

    #[test]
    fn entry_limit_truncates_even_without_matching_files() {
        // entry_limit (limit×100) applies before the file cap: even an
        // entirely non-matching extension set truncates, so a directory with
        // no matching files is not walked indefinitely.
        let root = std::env::temp_dir().join(format!("kode-mcp-scanlim-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..101 {
            std::fs::write(root.join(format!("{i}.txt")), "noise").unwrap();
        }
        let scan = collect(std::slice::from_ref(&root), "md", &[], 1);
        assert!(scan.truncated);
        assert_eq!(scan.files.len(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A mid-walk walkdir entry error (unreadable subdirectory): errors +1
    /// and the walk continues, it does not blow up the scan.
    #[cfg(unix)]
    #[test]
    fn unreadable_subdirectory_counts_as_scan_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("kode-mcp-scanlock-{}", std::process::id()));
        let sub = root.join("locked");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("a.md"), "x").unwrap();
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o000)).unwrap();
        let scan = collect(std::slice::from_ref(&root), "md", &[], 10);
        // Restore permissions before asserting so cleanup stays possible.
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(scan.files.len(), 0, "locked dir yields no files");
        assert_eq!(
            scan.errors, 1,
            "mid-walk unreadable subdir must surface as a scan error"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
