//! 确定性 `.py` 枚举。
//!
//! 直接复用 [`kode_vfs::walk::scan`] 的 VFS-007/010 语义(默认排除、目录 symlink
//! 不跟随、深度封顶、读目录失败跳过),再按 [`FileKind::Python`] 过滤。这样
//! Python 语料层与后续索引层看到的是同一套文件边界,不另造第二套扫描器。

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

use kode_vfs::walk::{self, FileKind, WalkOptions};

/// TS `PY_SCAN_EXCLUDE` 中 VFS 默认集之外的项目(并集后与 TS 同口径)。
///
/// `tests/fixtures/**` 与业务脚本不受影响;排除只为避免把引擎构建树/依赖树
/// 当成语料(实测 30k/117k 文件差异见 `src/pythonClassIndex.ts:56-63`)。
pub const DEFAULT_PY_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "third_party",
    ".git",
    "vcpkg",
    "build",
    "dist",
    "out",
    ".tmp",
    "perf",
    ".venv",
    "venv",
    "site-packages",
    "__pycache__",
];

/// `.py` 枚举选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnumerateOptions {
    /// 排除目录名(精确匹配,在 [`DEFAULT_PY_EXCLUDED_DIRS`] 之上追加)。
    pub excluded_dirs: BTreeSet<String>,
    /// 追加通配排除(整组件匹配,仅支持 `*`)。
    pub user_exclude_globs: Vec<String>,
    /// 最大目录深度(根为 0)。
    pub max_depth: usize,
    /// 排序后截断上限(`None` = 不截断;用于探针/有界扫描)。
    pub max_files: Option<usize>,
}

impl Default for EnumerateOptions {
    fn default() -> EnumerateOptions {
        let base = WalkOptions::default();
        let mut excluded_dirs = base.excluded_dirs;
        excluded_dirs.extend(DEFAULT_PY_EXCLUDED_DIRS.iter().map(|s| (*s).to_string()));
        EnumerateOptions {
            excluded_dirs,
            user_exclude_globs: Vec::new(),
            max_depth: base.max_depth,
            max_files: None,
        }
    }
}

/// 单个 Python 语料文件。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PythonFile {
    /// 文件系统路径(与扫描根同基准)。
    pub path: PathBuf,
    /// 相对扫描根的 `/` 分隔路径(排序键与 golden 稳定标识)。
    pub relative_path: String,
}

/// 枚举统计(跳过原因可见,不静默)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnumerateStats {
    /// 扫描器看到的全部文件数(含非 `.py`)。
    pub visited_files: usize,
    /// 命中的 `.py` 文件数。
    pub matched_files: usize,
    /// 读失败被跳过的目录数。
    pub skipped_dirs: usize,
    /// 是否因 `max_files` 截断。
    pub truncated: bool,
}

/// 一次枚举的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enumeration {
    pub root: PathBuf,
    pub files: Vec<PythonFile>,
    pub stats: EnumerateStats,
}

/// 枚举根目录下的 `.py` 文件(排序遍历 + 相对路径字典序)。
pub fn enumerate_python_files(root: &Path, options: &EnumerateOptions) -> io::Result<Enumeration> {
    let metadata = std::fs::metadata(root)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("corpus root is not a directory: {}", root.display()),
        ));
    }
    let walk_options = WalkOptions {
        excluded_dirs: options.excluded_dirs.clone(),
        user_exclude_globs: options.user_exclude_globs.clone(),
        max_depth: options.max_depth,
    };
    let (entries, walk_stats) = walk::scan(root, &walk_options);
    let mut files: Vec<PythonFile> = entries
        .into_iter()
        .filter(|entry| entry.kind == FileKind::Python)
        .map(|entry| PythonFile {
            relative_path: relative_path(root, &entry.path),
            path: entry.path,
        })
        .collect();
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let matched_files = files.len();
    let truncated = options.max_files.is_some_and(|max| files.len() > max);
    if let Some(max) = options.max_files {
        files.truncate(max);
    }
    Ok(Enumeration {
        root: root.to_path_buf(),
        files,
        stats: EnumerateStats {
            visited_files: walk_stats.files,
            matched_files,
            skipped_dirs: walk_stats.skipped_dirs,
            truncated,
        },
    })
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kode-corpus-enum-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, body: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn enumerates_sorted_python_only() {
        let dir = temp_dir("sorted");
        write(&dir, "z.py", b"class Z: pass\n");
        write(&dir, "a.py", b"class A: pass\n");
        write(&dir, "nested/b.py", b"class B: pass\n");
        write(&dir, "stub.pyi", b"class Stub: ...\n");
        write(&dir, "notes.txt", b"class Nope: pass\n");

        let result = enumerate_python_files(&dir, &EnumerateOptions::default()).unwrap();
        let rels: Vec<&str> = result
            .files
            .iter()
            .map(|f| f.relative_path.as_str())
            .collect();
        assert_eq!(rels, ["a.py", "nested/b.py", "z.py"]);
        assert_eq!(result.stats.visited_files, 5);
        assert_eq!(result.stats.matched_files, 3);
        assert!(!result.stats.truncated);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn applies_python_specific_default_excludes() {
        let dir = temp_dir("excludes");
        write(&dir, "scripts/Avatar.py", b"class Avatar: pass\n");
        for excluded in ["third_party", "vcpkg", "perf", "site-packages"] {
            write(
                &dir,
                &format!("{excluded}/Vendor.py"),
                b"class Vendor: pass\n",
            );
        }
        let result = enumerate_python_files(&dir, &EnumerateOptions::default()).unwrap();
        let rels: Vec<&str> = result
            .files
            .iter()
            .map(|f| f.relative_path.as_str())
            .collect();
        assert_eq!(rels, ["scripts/Avatar.py"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn honors_user_globs_and_max_files_after_sort() {
        let dir = temp_dir("globs");
        write(&dir, "a.py", b"");
        write(&dir, "b.py", b"");
        write(&dir, "c.generated.py", b"");
        let mut options = EnumerateOptions::default();
        options
            .user_exclude_globs
            .push("*.generated.py".to_string());
        options.max_files = Some(1);

        let result = enumerate_python_files(&dir, &options).unwrap();
        let rels: Vec<&str> = result
            .files
            .iter()
            .map(|f| f.relative_path.as_str())
            .collect();
        assert_eq!(rels, ["a.py"]);
        assert_eq!(result.stats.matched_files, 2);
        assert!(result.stats.truncated);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_non_directory_root() {
        let dir = temp_dir("file-root");
        let file = dir.join("a.py");
        std::fs::write(&file, b"").unwrap();
        let err = enumerate_python_files(&file, &EnumerateOptions::default()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
