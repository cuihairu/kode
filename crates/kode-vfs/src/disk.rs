//! VFS-006 磁盘指纹:mtime + size 双字段。
//!
//! 只看 mtime 是已知坑(粒度粗、可回拨、网络 FS 不可靠),所以指纹恒带 size。
//! 基础版用 (mtime_secs, mtime_nanos, size) 三元组;内容 hash 增强留接口
//! ([`DiskFingerprint`] 可扩展),调用方语义不变。
//!
//! [`DiskCache`] 缓存「指纹 → 文本缓冲」:指纹未变的重复 snapshot 不重读文件
//! (ARCH-003/热路径禁同步全量读);删除/重命名时整体失效(VFS-012)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::line_index::DocumentBuffer;

/// 磁盘文件指纹(VFS-006:mtime + size,缺一不可)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskFingerprint {
    pub mtime_secs: i64,
    pub mtime_nanos: u32,
    pub size: u64,
}

impl DiskFingerprint {
    /// stat 一次;文件不存在或 stat 失败返回 `Ok(None)`(VFS-010:不可读 ≠ panic)。
    pub fn of_path(path: &Path) -> std::io::Result<Option<DiskFingerprint>> {
        match std::fs::metadata(path) {
            Ok(meta) => {
                let mtime = meta.modified()?;
                let (secs, nanos) = match mtime.duration_since(std::time::UNIX_EPOCH) {
                    Ok(d) => (d.as_secs() as i64, d.subsec_nanos()),
                    Err(err) => {
                        let d = err.duration();
                        // 早于 epoch(罕见):用负秒表示,保证指纹仍可比较。
                        let nanos = d.subsec_nanos();
                        if nanos == 0 {
                            (-(d.as_secs() as i64), 0)
                        } else {
                            (-(d.as_secs() as i64) - 1, 1_000_000_000 - nanos)
                        }
                    }
                };
                Ok(Some(DiskFingerprint {
                    mtime_secs: secs,
                    mtime_nanos: nanos,
                    size: meta.len(),
                }))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }
}

#[derive(Debug)]
struct DiskEntry {
    fingerprint: DiskFingerprint,
    buffer: DocumentBuffer,
}

/// 磁盘文本缓存:指纹命中复用缓冲,未命中重读。
#[derive(Debug, Default)]
pub struct DiskCache {
    entries: HashMap<PathBuf, DiskEntry>,
}

impl DiskCache {
    pub fn new() -> DiskCache {
        DiskCache::default()
    }

    pub fn cached_len(&self) -> usize {
        self.entries.len()
    }

    /// 读取快照:stat → 指纹与缓存一致则复用;否则读文件重建行索引。
    /// 读失败(权限/消失/非 UTF-8)返回 Err,不污染缓存(VFS-010)。
    pub fn load(&mut self, path: &Path) -> std::io::Result<DocumentBuffer> {
        let fingerprint = DiskFingerprint::of_path(path)?
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "file vanished"))?;
        if let Some(entry) = self.entries.get(path) {
            if entry.fingerprint == fingerprint {
                return Ok(entry.buffer.clone());
            }
        }
        let bytes = std::fs::read(path)?;
        let text = String::from_utf8(bytes).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "file is not UTF-8")
        })?;
        let buffer = DocumentBuffer::new(Arc::from(text.as_str()));
        self.entries.insert(
            path.to_path_buf(),
            DiskEntry {
                fingerprint,
                buffer: buffer.clone(),
            },
        );
        Ok(buffer)
    }

    /// VFS-012:删除/重命名时失效对应路径。
    pub fn invalidate(&mut self, path: &Path) {
        self.entries.remove(path);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kode-vfs-{tag}-{}-{}",
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
    fn fingerprint_includes_size_and_mtime() {
        let dir = temp_dir("fp");
        let file = dir.join("a.def");
        std::fs::write(&file, b"abc").unwrap();
        let fp1 = DiskFingerprint::of_path(&file).unwrap().unwrap();
        assert_eq!(fp1.size, 3);
        // 不写入,连 stat 两次 → 指纹稳定。
        let fp_again = DiskFingerprint::of_path(&file).unwrap().unwrap();
        assert_eq!(fp1, fp_again);
        // 改内容(size 变)→ 指纹必变。
        std::fs::write(&file, b"abcd").unwrap();
        let fp3 = DiskFingerprint::of_path(&file).unwrap().unwrap();
        assert_ne!(fp1, fp3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_file_is_none_not_error() {
        let missing = std::env::temp_dir().join("kode-vfs-definitely-missing.def");
        assert_eq!(DiskFingerprint::of_path(&missing).unwrap(), None);
    }

    #[test]
    fn disk_cache_reuses_when_fingerprint_unchanged() {
        let dir = temp_dir("cache");
        let file = dir.join("b.def");
        std::fs::write(&file, "hello").unwrap();
        let mut cache = DiskCache::new();
        let first = cache.load(&file).unwrap();
        assert_eq!(cache.cached_len(), 1);
        let second = cache.load(&file).unwrap();
        assert_eq!(second.text(), "hello");
        // 内容变了 → 重读并更新缓存。
        std::fs::write(&file, "changed").unwrap();
        let third = cache.load(&file).unwrap();
        assert_eq!(third.text(), "changed");
        assert_eq!(first.text(), "hello");
        cache.invalidate(&file);
        assert_eq!(cache.cached_len(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn non_utf8_file_errors_cleanly() {
        let dir = temp_dir("bin");
        let file = dir.join("c.bin");
        std::fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();
        let mut cache = DiskCache::new();
        assert!(cache.load(&file).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
