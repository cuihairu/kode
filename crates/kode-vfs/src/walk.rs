//! VFS-007/008/010 工作区扫描:目录排除、文件分类、安全降级。
//!
//! - **排除(VFS-007)**:默认跳过 `.git`、`node_modules`、`.venv`、build/
//!   target/generated 等;支持用户追加排除(整组件通配,`*` 通配符)。
//! - **分类(VFS-008 基础版)**:`.def`、types.xml、entities.xml、alias.xml、
//!   Python、引擎源(路径含 `kbe`/`kbengine` 组件)。精细的独立发现规则
//!   (引擎版本 profile 等)随 PR-006 root discovery 补全。
//! - **安全(VFS-010)**:读目录失败(权限拒绝/网络 FS 抖动)跳过并计数,
//!   不 panic;默认不跟随目录符号链接(符号链接循环天然免疫);深度封顶。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 默认排除目录(VFS-007 名单;用户排除是追加而非替换)。
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

/// KBEngine 关切文件类别(VFS-008 基础版)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FileKind {
    Def,
    TypesXml,
    EntitiesXml,
    AliasXml,
    Python,
    /// 引擎源码树下的 xml/py/cpp/h(路径含 `kbe` 或 `kbengine` 组件)。
    EngineSource,
    Other,
}

/// 按路径分类一个文件(VFS-008;精确文件名大小写敏感,对齐 KBEngine 约定)。
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

/// 扫描配置。
#[derive(Debug, Clone)]
pub struct WalkOptions {
    /// 排除的目录组件名(精确匹配;在 DEFAULT_EXCLUDED_DIRS 之上追加)。
    pub excluded_dirs: BTreeSet<String>,
    /// 用户追加通配排除(整组件匹配,`*` 通配任意子串,如 `*.generated`)。
    pub user_exclude_globs: Vec<String>,
    /// 最大目录深度(防环/防失控;根为 0 层)。
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

/// 扫描结果统计(VFS-010:跳过原因可见,不静默)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WalkStats {
    pub files: usize,
    /// 读失败被跳过的目录数(权限拒绝/网络 FS/竞态消失)。
    pub skipped_dirs: usize,
}

/// 一个扫描命中:路径 + 类别。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ScanEntry {
    pub path: PathBuf,
    pub kind: FileKind,
}

/// 扫描一个根目录(不跟随目录 symlink;确定性排序)。
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
            // 目录符号链接不跟随(循环免疫);文件符号链接按文件收录。
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

/// 整组件通配:只支持 `*`(任意子串),够用且无依赖。
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
    // 尾段必须顶到结尾(除非尾段为空)。
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
        // 普通工程里的 x.xml 不算引擎源。
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
        // 还原权限以便清理。
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
            // 只算 real/ 下的真实文件,loop/ 不展开(循环免疫)。
            assert_eq!(entries.len(), 1);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
