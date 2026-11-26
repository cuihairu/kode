//! File-level incremental Python corpus index.
//!
//! The index is bounded by the VFS enumeration result and uses a content fingerprint to decide
//! whether encoding detection and lexical table extraction must run again. Unchanged files reuse
//! the previous round's result; read failures, unsupported encodings and decode failures land in
//! [`issues`], so no mojibake entry is produced silently.
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

/// Content fingerprint (FNV-1a 64-bit, dependency free and stable across platforms).
pub fn content_fingerprint(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// One indexed Python file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedPythonFile {
    pub path: PathBuf,
    pub relative_path: String,
    pub fingerprint: u64,
    pub byte_len: usize,
    pub detection: EncodingDetection,
    /// The decoded source (kept for the P1/P2 definition and hover layers).
    pub source: String,
    pub module: PythonModule,
}

/// Classification of index issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexIssueKind {
    Read,
    Decode,
}

/// Why one file did not make it into the index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexIssue {
    pub relative_path: String,
    pub kind: IndexIssueKind,
    pub message: String,
}

/// Statistics for one refresh round.
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

/// Incremental Python corpus index.
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

    /// Refresh the index against the current directory state. Unchanged files are reused by `(fingerprint, byte_len)`.
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

/// Build the index in one shot.
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

    #[test]
    fn accessors_expose_root_stats_files_and_emptiness() {
        // Accessors: root/stats/files/len/is_empty expose the full state before and
        // after a refresh.
        let root = temp_dir("accessors");
        write(&root, "a.py", "class A:\n    pass\n");
        write(&root, "b.py", "class B:\n    pass\n");
        let mut index = PythonCorpusIndex::new(&root);
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);

        let stats = index.refresh(&EnumerateOptions::default()).unwrap();
        assert_eq!(index.root(), root.as_path());
        assert_eq!(index.stats(), stats);
        assert_eq!(index.stats().enumerated_files, 2);
        assert_eq!(index.len(), 2);
        assert!(!index.is_empty());
        let rels: Vec<&str> = index
            .files()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert_eq!(rels, ["a.py", "b.py"]);
        assert!(index.get("a.py").is_some());
        assert_eq!(index.get("missing.py"), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removed_files_are_counted_and_dropped_from_index() {
        // A file deleted between two refresh rounds: counted in removed_files, and the
        // stale entry is no longer queryable.
        let root = temp_dir("removed");
        write(&root, "a.py", "class A:\n    pass\n");
        write(&root, "gone.py", "class Gone:\n    pass\n");
        let mut index = PythonCorpusIndex::new(&root);
        index.refresh(&EnumerateOptions::default()).unwrap();
        fs::remove_file(root.join("gone.py")).unwrap();

        let stats = index.refresh(&EnumerateOptions::default()).unwrap();
        assert_eq!(stats.removed_files, 1);
        assert_eq!(stats.reused_files, 1);
        assert_eq!(stats.enumerated_files, 1);
        assert_eq!(index.get("gone.py"), None);
        assert_eq!(index.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn truncation_flag_propagates_from_enumeration() {
        // Truncation by max_files: truncated in the stats stays consistent with index size.
        let root = temp_dir("truncated");
        write(&root, "a.py", "class A:\n    pass\n");
        write(&root, "b.py", "class B:\n    pass\n");
        let options = EnumerateOptions {
            max_files: Some(1),
            ..EnumerateOptions::default()
        };
        let mut index = PythonCorpusIndex::new(&root);
        let stats = index.refresh(&options).unwrap();

        assert!(stats.truncated);
        assert_eq!(stats.enumerated_files, 2);
        assert_eq!(index.len(), 1);
        assert_eq!(index.get("a.py").unwrap().relative_path, "a.py");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn read_failures_are_recorded_as_issues_without_aborting() {
        // A dangling symlink is collected by enumeration as a file, but the read fails
        // -> recorded as a Read issue, without aborting the whole refresh and
        // without silently producing an empty entry.
        let root = temp_dir("read-error");
        write(&root, "good.py", "class Good:\n    pass\n");
        std::os::unix::fs::symlink(root.join("gone.py"), root.join("dangling.py")).unwrap();
        let mut index = PythonCorpusIndex::new(&root);
        let stats = index.refresh(&EnumerateOptions::default()).unwrap();

        assert_eq!(stats.enumerated_files, 2);
        assert_eq!(stats.indexed_files, 1);
        assert_eq!(stats.read_errors, 1);
        assert_eq!(stats.decode_errors, 0);
        assert_eq!(index.issues().len(), 1);
        assert_eq!(index.issues()[0].relative_path, "dangling.py");
        assert_eq!(index.issues()[0].kind, IndexIssueKind::Read);
        assert!(index.issues()[0].message.contains("No such file"));
        assert_eq!(index.get("dangling.py"), None);
        assert!(index.get("good.py").is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
