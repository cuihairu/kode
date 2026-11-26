//! VFS-007/008/010 workspace scanning: directory exclusion, file classification, safe degradation.
//!
//! - **Exclusion (VFS-007)**: skips `.git`, `node_modules`, `.venv`, build/target/generated and
//!   the like by default; user-added exclusions are supported (whole-component globs, `*` wildcard).
//! - **Classification (VFS-008 base version)**: `.def`, types.xml, entities.xml, alias.xml,
//!   Python, engine sources (paths containing a `kbe`/`kbengine` component). Finer standalone
//!   discovery rules (engine version profiles etc.) land with PR-006 root discovery.
//! - **Safety (VFS-010)**: a failed directory read (permission denied / network FS flakiness) is
//!   skipped and counted, never a panic; directory symlinks are not followed by default
//!   (naturally immune to symlink loops); depth is capped.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Default excluded directories (the VFS-007 list; user exclusions are appended, not substituted).
pub const DEFAULT_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    "target",
    "build",
    "out",
    "dist",
    "generated",
];

/// File categories of KBEngine interest (VFS-008 base version).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FileKind {
    Def,
    TypesXml,
    EntitiesXml,
    AliasXml,
    Python,
    /// xml/py/cpp/h under an engine source tree (path contains a `kbe` or `kbengine` component).
    EngineSource,
    Other,
}

/// Classify one file by path (VFS-008; exact file names are case-sensitive, matching KBEngine conventions).
pub fn classify(path: &Path) -> FileKind {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = match name.as_str() {
        "types.xml" => FileKind::TypesXml,
        "entities.xml" => FileKind::EntitiesXml,
        "alias.xml" => FileKind::AliasXml,
        _ => {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default();
            match ext.as_str() {
                "def" => FileKind::Def,
                "py" => FileKind::Python,
                "xml" | "cpp" | "h" | "hpp" => {
                    if in_engine_tree(path) {
                        FileKind::EngineSource
                    } else {
                        FileKind::Other
                    }
                }
                _ => FileKind::Other,
            }
        }
    };
    kind
}

fn in_engine_tree(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == "kbe" || s == "kbengine"
    })
}

/// Scan configuration.
#[derive(Debug, Clone)]
pub struct WalkOptions {
    /// Excluded directory component names (exact match; appended on top of DEFAULT_EXCLUDED_DIRS).
    pub excluded_dirs: BTreeSet<String>,
    /// User-added wildcard exclusions (whole component match, `*` matches any substring, e.g. `*.generated`).
    pub user_exclude_globs: Vec<String>,
    /// Maximum directory depth (guards against cycles and runaway scans; the root is level 0).
    pub max_depth: usize,
}

impl Default for WalkOptions {
    fn default() -> WalkOptions {
        WalkOptions {
            excluded_dirs: DEFAULT_EXCLUDED_DIRS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            user_exclude_globs: Vec::new(),
            max_depth: 32,
        }
    }
}

/// Scan result statistics (VFS-010: skip reasons stay visible, never silent).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WalkStats {
    pub files: usize,
    /// Number of directories skipped on read failure (permission denied / network FS / vanished in a race).
    pub skipped_dirs: usize,
}

/// One scan hit: path + kind.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ScanEntry {
    pub path: PathBuf,
    pub kind: FileKind,
}

/// Scan one root directory (directory symlinks are not followed; deterministic sorting).
pub fn scan(root: &Path, opts: &WalkOptions) -> (Vec<ScanEntry>, WalkStats) {
    let mut entries = Vec::new();
    let mut stats = WalkStats::default();
    scan_dir(root, 0, opts, &mut entries, &mut stats);
    entries.sort();
    (entries, stats)
}

fn scan_dir(
    dir: &Path,
    depth: usize,
    opts: &WalkOptions,
    entries: &mut Vec<ScanEntry>,
    stats: &mut WalkStats,
) {
    if depth > opts.max_depth {
        return;
    }
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(_) => {
            stats.skipped_dirs += 1;
            return;
        }
    };
    for item in read.flatten() {
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if file_type.is_symlink() {
            // Directory symlinks are not followed (loop immune); file symlinks are
            // collected as files.
            let target_is_dir = std::fs::metadata(&path)
                .map(|meta| meta.is_dir())
                .unwrap_or(false);
            if !target_is_dir && !is_user_excluded(&name, opts) {
                stats.files += 1;
                let kind = classify(&path);
                entries.push(ScanEntry { path, kind });
            }
        } else if file_type.is_dir() {
            if is_excluded_dir(&name, opts) {
                continue;
            }
            scan_dir(&path, depth + 1, opts, entries, stats);
        } else if !is_user_excluded(&name, opts) {
            stats.files += 1;
            let kind = classify(&path);
            entries.push(ScanEntry { path, kind });
        }
    }
}

fn is_excluded_dir(name: &str, opts: &WalkOptions) -> bool {
    opts.excluded_dirs.contains(name)
        || opts
            .user_exclude_globs
            .iter()
            .any(|glob| glob_match_component(glob, name))
}

fn is_user_excluded(name: &str, opts: &WalkOptions) -> bool {
    opts.user_exclude_globs
        .iter()
        .any(|glob| glob_match_component(glob, name))
}

/// Whole-component wildcard: only `*` (any substring) is supported; sufficient and dependency free.
fn glob_match_component(glob: &str, name: &str) -> bool {
    if !glob.contains('*') {
        return glob == name;
    }
    let parts: Vec<&str> = glob.split('*').collect();
    let mut rest = name;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        match if i == 0 {
            if rest.starts_with(part) {
                Some(part.len())
            } else {
                None
            }
        } else {
            rest.find(part).map(|pos| pos + part.len())
        } {
            Some(consumed) => rest = &rest[consumed..],
            None => return false,
        }
    }
    // The tail segment must reach the end (unless it is empty).
    parts
        .last()
        .map(|last| last.is_empty() || rest.is_empty())
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kode-vfs-walk-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classification_covers_kbengine_kinds() {
        assert_eq!(
            classify(Path::new("/w/entities/Monster.def")),
            FileKind::Def
        );
        assert_eq!(classify(Path::new("/w/types.xml")), FileKind::TypesXml);
        assert_eq!(
            classify(Path::new("/w/entities.xml")),
            FileKind::EntitiesXml
        );
        assert_eq!(classify(Path::new("/w/alias.xml")), FileKind::AliasXml);
        assert_eq!(
            classify(Path::new("/w/entities/Avatar.py")),
            FileKind::Python
        );
        assert_eq!(
            classify(Path::new(
                "/srv/kbengine/kbe/res/server/kbengine_defaults.xml"
            )),
            FileKind::EngineSource
        );
        assert_eq!(classify(Path::new("/w/other.xml")), FileKind::Other);
        // An x.xml inside a plain project is not an engine source.
        assert_eq!(classify(Path::new("/w/config/x.xml")), FileKind::Other);
    }

    #[test]
    fn scan_excludes_default_dirs_and_honors_user_globs() {
        let dir = temp_dir("excl");
        for sub in [".git", "node_modules", ".venv", "build", "assets"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        std::fs::write(dir.join("assets/Monster.def"), "").unwrap();
        std::fs::write(dir.join("assets/temp.generated"), "").unwrap();
        std::fs::write(dir.join("assets/readme.md"), "").unwrap();
        std::fs::write(dir.join(".git/x"), "").unwrap();

        let mut opts = WalkOptions::default();
        opts.user_exclude_globs.push("*.generated".to_string());
        let (entries, stats) = scan(&dir, &opts);
        let paths: Vec<&Path> = entries.iter().map(|e| e.path.as_path()).collect();
        assert_eq!(paths.len(), 2, "got {paths:?}");
        assert!(paths.iter().any(|p| p.ends_with("Monster.def")));
        assert!(paths.iter().any(|p| p.ends_with("readme.md")));
        assert_eq!(stats.files, 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn scan_survives_unreadable_dir() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perm");
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(dir.join("ok.def"), "").unwrap();
        let mut perms = std::fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o000);
        std::fs::set_permissions(&locked, perms).unwrap();
        let (entries, stats) = scan(&dir, &WalkOptions::default());
        assert_eq!(entries.len(), 1);
        assert_eq!(stats.skipped_dirs, 1);
        // Restore permissions so the directory can be cleaned up.
        let mut perms = std::fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&locked, perms).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn glob_component_matching() {
        assert!(glob_match_component("*.generated", "temp.generated"));
        assert!(glob_match_component("exact", "exact"));
        assert!(!glob_match_component("exact", "exact2"));
        assert!(!glob_match_component("*.generated", "temp.generatedx"));
    }

    #[test]
    fn symlinked_directories_are_not_followed() {
        let dir = temp_dir("symlink");
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::fs::write(dir.join("real/a.def"), "").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("real"), dir.join("loop")).unwrap();
            let (entries, _) = scan(&dir, &WalkOptions::default());
            // Only real files under real/ are counted; loop/ is not expanded (loop immune).
            assert_eq!(entries.len(), 1);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn max_depth_zero_stops_descending() {
        // Depth cap: level 0 is visible, sub/ is truncated as a whole (guards against
        // cycles and runaway scans).
        let dir = temp_dir("depth");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("top.def"), "").unwrap();
        std::fs::write(dir.join("sub/deep.def"), "").unwrap();
        let opts = WalkOptions {
            max_depth: 0,
            ..Default::default()
        };
        let (entries, _) = scan(&dir, &opts);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert!(entries[0].path.ends_with("top.def"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn file_symlinks_are_included_but_dir_symlinks_not_expanded() {
        let dir = temp_dir("flink");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/target.def"), "").unwrap();
        // File symlink: collected as a file (classification looks at the extension of the link path).
        std::os::unix::fs::symlink(dir.join("sub/target.def"), dir.join("link.def")).unwrap();
        // Dangling symlink: metadata fails -> not a directory, still collected as a file.
        std::os::unix::fs::symlink(dir.join("gone.def"), dir.join("dangling.def")).unwrap();
        // Directory symlink: not expanded.
        std::os::unix::fs::symlink(dir.join("sub"), dir.join("dirlink")).unwrap();

        let (entries, stats) = scan(&dir, &WalkOptions::default());
        let names: Vec<String> = entries
            .iter()
            .map(|e| e.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"link.def".to_string()), "{names:?}");
        assert!(names.contains(&"dangling.def".to_string()), "{names:?}");
        // target.def is collected only once, via sub/ (a real directory); dirlink/ is not expanded.
        assert_eq!(
            names.iter().filter(|n| *n == "target.def").count(),
            1,
            "{names:?}"
        );
        assert!(
            !entries
                .iter()
                .any(|e| e.path.to_string_lossy().contains("dirlink")),
            "{entries:?}"
        );
        assert_eq!(stats.files, 3, "{names:?}");
        let link = entries
            .iter()
            .find(|e| e.path.ends_with("link.def"))
            .unwrap();
        assert_eq!(link.kind, FileKind::Def);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn glob_prefix_and_suffix_parts_match_whole_component() {
        // The first segment (prefix) must start at the component's beginning.
        assert!(glob_match_component("tmp*", "tmp123"));
        assert!(!glob_match_component("tmp*", "xtmp123"));
        // Middle segments are searched anywhere, but the tail must reach the end.
        assert!(glob_match_component("a*b", "axb"));
        assert!(!glob_match_component("a*b", "axbx"));
        // A bare '*' matches any component.
        assert!(glob_match_component("*", "whatever"));
    }
}
