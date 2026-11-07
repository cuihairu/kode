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
}
