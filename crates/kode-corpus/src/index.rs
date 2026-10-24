//! 文件级增量 Python 语料索引。
//!
//! 索引以 VFS 枚举结果为边界,用内容指纹判断是否需要重新探测编码和抽取词法表。
//! 未变化文件直接复用上一轮结果;读失败、编码不支持或解码失败会进入 [`issues`],
//! 不会静默产生乱码条目。
//!
//! [`issues`]: PythonCorpusIndex::issues

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::{
    decode_source, enumerate_python_files, parse_python_module, EncodingDetection,
    EnumerateOptions, PythonModule,
};

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// 内容指纹(FNV-1a 64-bit,零依赖且跨平台稳定)。
pub fn content_fingerprint(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// 一个已索引的 Python 文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedPythonFile {
    pub path: PathBuf,
    pub relative_path: String,
    pub fingerprint: u64,
    pub byte_len: usize,
    pub detection: EncodingDetection,
    /// 解码后的源码(保留给 P1/P2 的落点与悬停层)。
    pub source: String,
    pub module: PythonModule,
}

/// 索引问题分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexIssueKind {
    Read,
    Decode,
}

/// 单个文件未进入索引的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexIssue {
    pub relative_path: String,
    pub kind: IndexIssueKind,
    pub message: String,
}

/// 一轮刷新的统计。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexStats {
    pub enumerated_files: usize,
    pub indexed_files: usize,
    pub reused_files: usize,
    pub removed_files: usize,
    pub read_errors: usize,
    pub decode_errors: usize,
    pub skipped_dirs: usize,
    pub truncated: bool,
}

/// 增量 Python 语料索引。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonCorpusIndex {
    root: PathBuf,
    files: BTreeMap<String, IndexedPythonFile>,
    issues: Vec<IndexIssue>,
    stats: IndexStats,
}

impl PythonCorpusIndex {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            files: BTreeMap::new(),
            issues: Vec::new(),
            stats: IndexStats::default(),
        }
    }

    /// 按当前目录状态刷新索引。未变化文件按 `(fingerprint, byte_len)` 复用。
    pub fn refresh(&mut self, options: &EnumerateOptions) -> io::Result<IndexStats> {
        let enumeration = enumerate_python_files(&self.root, options)?;
        let mut previous = std::mem::take(&mut self.files);
        let mut next = BTreeMap::new();
        let mut issues = Vec::new();
        let mut reused_files = 0;
        let mut indexed_files = 0;
        let mut read_errors = 0;
        let mut decode_errors = 0;

        for file in enumeration.files {
            let relative_path = file.relative_path;
            let bytes = match fs::read(&file.path) {
                Ok(bytes) => bytes,
                Err(err) => {
                    read_errors += 1;
                    issues.push(IndexIssue {
                        relative_path,
                        kind: IndexIssueKind::Read,
                        message: err.to_string(),
                    });
                    continue;
                }
            };
            let fingerprint = content_fingerprint(&bytes);
            if let Some(previous_file) = previous.remove(&relative_path) {
                if previous_file.fingerprint == fingerprint && previous_file.byte_len == bytes.len()
                {
                    reused_files += 1;
                    next.insert(relative_path, previous_file);
                    continue;
                }
            }

            let decoded = match decode_source(&bytes) {
                Ok(decoded) => decoded,
                Err(err) => {
                    decode_errors += 1;
                    issues.push(IndexIssue {
                        relative_path,
                        kind: IndexIssueKind::Decode,
                        message: err.to_string(),
                    });
                    continue;
                }
            };
            let module = parse_python_module(&decoded.text);
            indexed_files += 1;
            next.insert(
                relative_path.clone(),
                IndexedPythonFile {
                    path: file.path,
                    relative_path,
                    fingerprint,
                    byte_len: bytes.len(),
                    detection: decoded.detection,
                    source: decoded.text,
                    module,
                },
            );
        }

        self.files = next;
        self.issues = issues;
        self.stats = IndexStats {
            enumerated_files: enumeration.stats.matched_files,
            indexed_files,
            reused_files,
            removed_files: previous.len(),
            read_errors,
            decode_errors,
            skipped_dirs: enumeration.stats.skipped_dirs,
            truncated: enumeration.stats.truncated,
        };
        Ok(self.stats)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn stats(&self) -> IndexStats {
        self.stats
    }

    pub fn issues(&self) -> &[IndexIssue] {
        &self.issues
    }

    pub fn get(&self, relative_path: &str) -> Option<&IndexedPythonFile> {
        self.files.get(relative_path)
    }

    pub fn files(&self) -> impl Iterator<Item = &IndexedPythonFile> {
        self.files.values()
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// 一次性建立索引。
pub fn index_python_corpus(
    root: &Path,
    options: &EnumerateOptions,
) -> io::Result<PythonCorpusIndex> {
    let mut index = PythonCorpusIndex::new(root);
    index.refresh(options)?;
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kode-corpus-index-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, body: impl AsRef<[u8]>) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn reuses_unchanged_files_by_content_fingerprint() {
        let root = temp_dir("reuse");
        write(&root, "scripts/Avatar.py", "class Avatar:\n    pass\n");
        write(&root, "scripts/helper.pyi", "class Stub: ...\n");
        let mut index = PythonCorpusIndex::new(&root);

        let first = index.refresh(&EnumerateOptions::default()).unwrap();
        assert_eq!(first.enumerated_files, 1);
        assert_eq!(first.indexed_files, 1);
        assert_eq!(first.reused_files, 0);
        assert_eq!(index.len(), 1);
        let fingerprint = index.get("scripts/Avatar.py").unwrap().fingerprint;

        let second = index.refresh(&EnumerateOptions::default()).unwrap();
        assert_eq!(second.indexed_files, 0);
        assert_eq!(second.reused_files, 1);
        assert_eq!(
            index.get("scripts/Avatar.py").unwrap().fingerprint,
            fingerprint
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reparses_only_changed_content() {
        let root = temp_dir("changed");
        write(&root, "a.py", "class A:\n    pass\n");
        write(&root, "b.py", "class B:\n    pass\n");
        let mut index = PythonCorpusIndex::new(&root);
        index.refresh(&EnumerateOptions::default()).unwrap();

        write(&root, "a.py", "class C:\n    pass\n");
        let stats = index.refresh(&EnumerateOptions::default()).unwrap();
        assert_eq!(stats.indexed_files, 1);
        assert_eq!(stats.reused_files, 1);
        assert_eq!(index.get("a.py").unwrap().module.classes[0].name, "C");
        assert_eq!(index.get("b.py").unwrap().module.classes[0].name, "B");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_decode_failures_without_indexing_mojibake() {
        let root = temp_dir("decode-error");
        write(&root, "good.py", "class Good:\n    pass\n");
        write(&root, "bad.py", b"# coding: gbk\nclass Bad:\n    pass\n");
        let mut index = PythonCorpusIndex::new(&root);
        let stats = index.refresh(&EnumerateOptions::default()).unwrap();

        assert_eq!(stats.indexed_files, 1);
        assert_eq!(stats.decode_errors, 1);
        assert_eq!(index.get("bad.py"), None);
        assert_eq!(index.issues().len(), 1);
        assert_eq!(index.issues()[0].relative_path, "bad.py");
        assert_eq!(index.issues()[0].kind, IndexIssueKind::Decode);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        assert_eq!(content_fingerprint(b""), FNV_OFFSET_BASIS);
        assert_ne!(content_fingerprint(b"a"), content_fingerprint(b"b"));
        assert_eq!(
            content_fingerprint(b"avatar"),
            content_fingerprint(b"avatar")
        );
    }
}
