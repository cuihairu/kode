//! kode-vfs — kode2 虚拟文件系统层(书 §5 crates/kode-vfs,PR-004)。
//!
//! 覆盖(基础版,证据见 docs/kode2/pr-004.md):
//! - VFS-001/002 路径身份:canonical URI([`uri`]) + 查询身份
//!   `(root_id, uri)`([`store::DocumentKey`]),禁 basename 索引。
//! - VFS-003 open overlay 优先磁盘;didOpen/didChange/didClose 严格
//!   version 转移([`store`])。
//! - VFS-004/005 行索引与 UTF-16 ↔ bytes ↔ line/col 精确转换
//!   (emoji/CRLF 覆盖,查询不做全文 split,[`line_index`])。
//! - VFS-006 磁盘指纹 mtime+size([`disk`])。
//! - VFS-007/008/010 扫描排除、KBEngine 文件分类、IO 安全降级([`walk`])。
//! - VFS-009 资源根注册顺序 + 最长前缀 + 冲突诊断入口([`store::RootRegistry`])。
//! - VFS-011 解析缓存:最新有效快照 + 负缓存([`parse_cache`])。
//! - VFS-012 删除/重命名/根切换的过期数据清理接口([`store`])。
//! - VFS-013 场景测试(100 次编辑/保存竞态/未保存变更/根切换)在
//!   `tests/vfs.rs`;坐标对拍在 `tests/coordinates.rs`。
//!
//! 设计边界:纯同步、无 async;磁盘 IO 只在 [`disk`]/[`walk`] 内;
//! 坐标语义与 kode-protocol DTO 保持同形,server 侧做纯转换。

pub mod disk;
pub mod line_index;
pub mod parse_cache;
pub mod store;
pub mod uri;
pub mod walk;

pub use disk::{DiskCache, DiskFingerprint};
pub use line_index::{utf16_len, DocumentBuffer, LineIndex, Position, Range, TextChange};
pub use parse_cache::{content_fingerprint, ParseCache};
pub use store::{
    ContentSource, DocumentKey, DocumentSnapshot, DocumentStore, RemovedDocument, RootId,
    RootRegistry, VersionConflict,
};
pub use uri::{CanonicalUri, UriError};
pub use walk::{classify, scan, FileKind, ScanEntry, WalkOptions, WalkStats};

/// canonical 路径 → [`std::path::Path`]。
/// Windows 规范形态 `/C:/...` 去掉前导 `/` 还原成 `C:/...`(其余平台原样)。
pub(crate) fn path_from_uri(canonical_path: &str) -> std::path::PathBuf {
    let bytes = canonical_path.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' {
        std::path::PathBuf::from(&canonical_path[1..])
    } else {
        std::path::PathBuf::from(canonical_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_canonical_path_maps_back_to_drive_path() {
        assert_eq!(
            path_from_uri("/C:/w/x.def"),
            std::path::PathBuf::from("C:/w/x.def")
        );
        assert_eq!(
            path_from_uri("/w/x.def"),
            std::path::PathBuf::from("/w/x.def")
        );
    }
}
