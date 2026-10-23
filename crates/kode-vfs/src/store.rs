//! VFS-002/003/009/012 文档仓库:身份、overlay、版本转移、根注册、删除失效。
//!
//! - **身份(VFS-002)**:`DocumentKey = (RootId, CanonicalUri)`;open buffer
//!   另带严格递增 version。basename 永远不当身份。
//! - **overlay(VFS-003)**:打开文档内存优先(ARCH-003);didOpen/didChange/
//!   didClose 是仅有的三条 version 转移边,旧 version 一律拒绝(见
//!   [`VersionConflict`]),保证「编辑器最新内容不被旧结果覆盖」(ARCH-005)。
//! - **根注册(VFS-009 基础版)**:注册顺序 = 显式优先顺序;查询取最长前缀,
//!   命中多个根时 [`RootRegistry::overlapping_roots`] 供冲突诊断。
//! - **删除/重命名(VFS-012)**:`remove`/`rename` 返回 [`RemovedDocument`],
//!   下游 index/diagnostics 据此清理过期 symbol 与旧 diagnostics。

use std::collections::HashMap;

use crate::disk::DiskCache;
use crate::line_index::{DocumentBuffer, TextChange};
use crate::uri::CanonicalUri;

/// 资源根 id。0 保留给「不属于任何已注册根」的文档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RootId(pub u32);

impl RootId {
    pub const UNROOTED: RootId = RootId(0);
}

/// VFS-002 查询身份:root + canonical URI。version 只在 open buffer 上存在。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DocumentKey {
    pub root: RootId,
    pub uri: CanonicalUri,
}

impl DocumentKey {
    pub fn new(root: RootId, uri: CanonicalUri) -> DocumentKey {
        DocumentKey { root, uri }
    }
}

/// 资源根注册表(VFS-009 基础版)。
/// id 从 1 起分配:0 恒留给 [`RootId::UNROOTED`](根外文档),不与任何注册根重合。
#[derive(Debug, Clone, Default)]
pub struct RootRegistry {
    roots: Vec<(RootId, String)>,
    next_id: u32,
}

impl RootRegistry {
    pub fn new() -> RootRegistry {
        RootRegistry {
            roots: Vec::new(),
            next_id: 1,
        }
    }

    /// 注册一个根(重复注册同一路径幂等,返回既有 id)。
    /// 注册顺序即显式优先顺序(VFS-009)。
    pub fn register(&mut self, path: &str) -> RootId {
        let canonical = CanonicalUri::from_path(path);
        for (id, existing) in &self.roots {
            if *existing == canonical.as_path() {
                return *id;
            }
        }
        let id = RootId(self.next_id);
        self.next_id += 1;
        self.roots.push((id, canonical.as_path().to_string()));
        id
    }

    pub fn roots(&self) -> &[(RootId, String)] {
        &self.roots
    }

    /// URI 归属:最长前缀的根胜出;无命中 → [`RootId::UNROOTED`]。
    pub fn root_for(&self, uri: &CanonicalUri) -> RootId {
        let path = uri.as_path();
        let mut best: Option<(RootId, usize)> = None;
        for (id, root_path) in &self.roots {
            if let Some(len) = prefix_len_at_boundary(root_path, path) {
                if best.map(|(_, best_len)| len > best_len).unwrap_or(true) {
                    best = Some((*id, len));
                }
            }
        }
        best.map(|(id, _)| id).unwrap_or(RootId::UNROOTED)
    }

    /// 命中该 URI 的全部根(按注册顺序;>1 即根冲突,供 VFS-009 冲突诊断)。
    pub fn overlapping_roots(&self, uri: &CanonicalUri) -> Vec<RootId> {
        let path = uri.as_path();
        self.roots
            .iter()
            .filter(|(_, root_path)| prefix_len_at_boundary(root_path, path).is_some())
            .map(|(id, _)| *id)
            .collect()
    }
}

/// root 是 path 的前缀且断在组件边界(或完整相等)。
fn prefix_len_at_boundary(root: &str, path: &str) -> Option<usize> {
    if path == root {
        return Some(root.len());
    }
    if !path.starts_with(root) {
        return None;
    }
    let rest = &path[root.len()..];
    if rest.starts_with('/') {
        Some(root.len())
    } else {
        None // 兄弟目录:/w/demo 与 /w/demo2 不得互相吞并
    }
}

/// version 转移冲突(VFS-003/013)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionConflict {
    /// 目标文档未 didOpen(didChange 前置缺失)。
    NotOpen,
    /// 来的 version 不比现有新;`current` 为现有 version。
    Stale { current: i64, incoming: i64 },
}

/// 打开文档 overlay 条目。
#[derive(Debug, Clone)]
struct OpenDocument {
    version: i64,
    buffer: DocumentBuffer,
}

/// 快照来源(VFS-003:区分「未保存」与「磁盘」)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentSource {
    /// 内存 overlay(含未保存编辑)。
    OpenOverlay,
    /// 磁盘(经指纹缓存)。
    Disk,
}

/// 一次查询快照:文本 + 行索引 + 来源 + (打开时)版本。
#[derive(Debug, Clone)]
pub struct DocumentSnapshot {
    pub key: DocumentKey,
    pub version: Option<i64>,
    pub source: ContentSource,
    pub buffer: DocumentBuffer,
}

/// VFS-012:remove/rename 的失效回执,供下游 index/diagnostics 清理。
#[derive(Debug, Clone)]
pub struct RemovedDocument {
    pub key: DocumentKey,
    pub was_open: bool,
    pub last_version: Option<i64>,
    pub last_buffer: Option<DocumentBuffer>,
}

/// 文档仓库:overlay + 磁盘指纹缓存。
#[derive(Debug, Default)]
pub struct DocumentStore {
    overlays: HashMap<DocumentKey, OpenDocument>,
    disk: DiskCache,
}

impl DocumentStore {
    pub fn new() -> DocumentStore {
        DocumentStore::default()
    }

    /// didOpen:登记 overlay。已打开且 incoming version 不比现有新 → 拒绝
    /// (LSP 语义:open 只该出现在未打开文档;防御性忽略旧重放)。
    pub fn open(
        &mut self,
        key: DocumentKey,
        version: i64,
        text: impl Into<String>,
    ) -> Result<DocumentBuffer, VersionConflict> {
        if let Some(existing) = self.overlays.get(&key) {
            if version <= existing.version {
                return Err(VersionConflict::Stale {
                    current: existing.version,
                    incoming: version,
                });
            }
        }
        let buffer = DocumentBuffer::new(text.into());
        self.overlays.insert(
            key,
            OpenDocument {
                version,
                buffer: buffer.clone(),
            },
        );
        Ok(buffer)
    }

    /// didChange:必须已打开;version 严格递增;changes 依序应用
    /// (full sync 一个全文 change,incremental 为若干 ranged change)。
    pub fn change(
        &mut self,
        key: &DocumentKey,
        version: i64,
        changes: Vec<TextChange>,
    ) -> Result<DocumentBuffer, VersionConflict> {
        let Some(open) = self.overlays.get(key) else {
            return Err(VersionConflict::NotOpen);
        };
        if version <= open.version {
            return Err(VersionConflict::Stale {
                current: open.version,
                incoming: version,
            });
        }
        let mut buffer = open.buffer.clone();
        for change in &changes {
            buffer = buffer.apply_change(change);
        }
        self.overlays.insert(
            key.clone(),
            OpenDocument {
                version,
                buffer: buffer.clone(),
            },
        );
        Ok(buffer)
    }

    /// didClose:移除 overlay,文档回落到磁盘真相;未保存内容随 overlay 丢弃
    /// (LSP 语义:close 前客户端应已保存)。返回是否确实打开过。
    pub fn close(&mut self, key: &DocumentKey) -> bool {
        self.overlays.remove(key).is_some()
    }

    /// 查询快照:open overlay 优先(VFS-003),否则磁盘(指纹缓存,VFS-006)。
    /// 文档既未打开也无法从磁盘读取 → `None`(VFS-010 安全降级)。
    pub fn snapshot(&mut self, key: &DocumentKey) -> Option<DocumentSnapshot> {
        if let Some(open) = self.overlays.get(key) {
            return Some(DocumentSnapshot {
                key: key.clone(),
                version: Some(open.version),
                source: ContentSource::OpenOverlay,
                buffer: open.buffer.clone(),
            });
        }
        let path = crate::path_from_uri(key.uri.as_path());
        let buffer = self.disk.load(&path).ok()?;
        Some(DocumentSnapshot {
            key: key.clone(),
            version: None,
            source: ContentSource::Disk,
            buffer,
        })
    }

    /// 只查 open overlay(不触盘;纯内存查询路径)。
    pub fn open_buffer(&self, key: &DocumentKey) -> Option<(i64, DocumentBuffer)> {
        self.overlays
            .get(key)
            .map(|open| (open.version, open.buffer.clone()))
    }

    pub fn is_open(&self, key: &DocumentKey) -> bool {
        self.overlays.contains_key(key)
    }

    pub fn open_count(&self) -> usize {
        self.overlays.len()
    }

    /// 打开文档摘要,按 uri 排序(health 报告确定性输出)。
    pub fn open_summaries(&self) -> Vec<(String, i64)> {
        let mut out: Vec<(String, i64)> = self
            .overlays
            .iter()
            .map(|(key, open)| (key.uri.to_uri_string(), open.version))
            .collect();
        out.sort();
        out
    }

    /// VFS-012:删除失效——移除 overlay 与磁盘缓存,返回清理回执
    /// (下游 index/diagnostics 据此删过期 symbol;文件不存在也返回回执,
    /// 调用方统一走清理逻辑)。
    pub fn remove(&mut self, key: &DocumentKey) -> Option<RemovedDocument> {
        let open = self.overlays.remove(key);
        let path = crate::path_from_uri(key.uri.as_path());
        self.disk.invalidate(&path);
        Some(RemovedDocument {
            key: key.clone(),
            was_open: open.is_some(),
            last_version: open.as_ref().map(|o| o.version),
            last_buffer: open.map(|o| o.buffer),
        })
    }

    /// VFS-012:重命名/跨根移动——旧身份整体失效 + 内容迁移到新身份
    /// (若旧文档打开则保持打开状态、版本延续)。
    pub fn rename(&mut self, old: &DocumentKey, new: DocumentKey) -> Option<RemovedDocument> {
        let open = self.overlays.remove(old);
        let old_path = crate::path_from_uri(old.uri.as_path());
        self.disk.invalidate(&old_path);
        let removed = RemovedDocument {
            key: old.clone(),
            was_open: open.is_some(),
            last_version: open.as_ref().map(|o| o.version),
            last_buffer: open.as_ref().map(|o| o.buffer.clone()),
        };
        if let Some(o) = open {
            self.overlays.insert(new, o);
        }
        Some(removed)
    }

    /// 根切换/根移除:整根失效(VFS-013 工作区根切换),返回被清理的文档键。
    pub fn invalidate_root(&mut self, root: RootId) -> Vec<DocumentKey> {
        let mut removed: Vec<DocumentKey> = self
            .overlays
            .keys()
            .filter(|key| key.root == root)
            .cloned()
            .collect();
        for key in &removed {
            let path = crate::path_from_uri(key.uri.as_path());
            self.disk.invalidate(&path);
            self.overlays.remove(key);
        }
        removed.sort();
        removed
    }

    pub fn disk_cache(&mut self) -> &mut DiskCache {
        &mut self.disk
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::line_index::Position;

    fn key(root: u32, path: &str) -> DocumentKey {
        DocumentKey::new(RootId(root), CanonicalUri::from_path(path))
    }

    #[test]
    fn root_registry_longest_prefix_wins_and_respects_boundaries() {
        let mut registry = RootRegistry::new();
        let demo = registry.register("/w/demo");
        let engine = registry.register("/w/demo/kbengine");
        let uri = CanonicalUri::from_path("/w/demo/kbengine/x.def");
        assert_eq!(registry.root_for(&uri), engine);
        let uri = CanonicalUri::from_path("/w/demo/entities/Monster.def");
        assert_eq!(registry.root_for(&uri), demo);
        // 兄弟目录不得吞并。
        let uri = CanonicalUri::from_path("/w/demo2/x.def");
        assert_eq!(registry.root_for(&uri), RootId::UNROOTED);
        assert!(registry.overlapping_roots(&uri).is_empty());
        // 命中两个根 → 冲突诊断入口。
        let uri = CanonicalUri::from_path("/w/demo/kbengine/y.def");
        assert_eq!(registry.overlapping_roots(&uri), vec![demo, engine]);
        // 同一路径重复注册幂等。
        assert_eq!(registry.register("/w/demo"), demo);
    }

    #[test]
    fn did_open_change_close_version_transitions() {
        let mut store = DocumentStore::new();
        let k = key(1, "/w/a.def");
        store.open(k.clone(), 1, "<Entity/>").unwrap();
        store
            .change(&k, 2, vec![TextChange::full("<Entity>v2</Entity>")])
            .unwrap();
        let snap = store.snapshot(&k).unwrap();
        assert_eq!(snap.version, Some(2));
        assert_eq!(snap.source, ContentSource::OpenOverlay);
        // 旧 version 被拒。
        assert!(matches!(
            store.change(&k, 1, vec![TextChange::full("old")]),
            Err(VersionConflict::Stale {
                current: 2,
                incoming: 1
            })
        ));
        assert_eq!(
            store.snapshot(&k).unwrap().buffer.text(),
            "<Entity>v2</Entity>"
        );
        assert!(store.close(&k));
        assert!(!store.close(&k));
    }

    #[test]
    fn change_without_open_is_rejected() {
        let mut store = DocumentStore::new();
        let k = key(1, "/w/never-opened.def");
        assert!(matches!(
            store.change(&k, 2, vec![TextChange::full("x")]),
            Err(VersionConflict::NotOpen)
        ));
    }

    #[test]
    fn ranged_edit_via_store_keeps_versions_monotonic() {
        let mut store = DocumentStore::new();
        let k = key(1, "/w/b.def");
        store.open(k.clone(), 1, "aaa\nbbb\nccc").unwrap();
        store
            .change(
                &k,
                2,
                vec![TextChange::ranged(
                    crate::line_index::Range::new(Position::new(1, 0), Position::new(1, 3)),
                    "BB",
                )],
            )
            .unwrap();
        assert_eq!(store.snapshot(&k).unwrap().buffer.text(), "aaa\nBB\nccc");
    }

    #[test]
    fn unrooted_documents_use_reserved_root_zero() {
        let registry = RootRegistry::new();
        assert_eq!(
            registry.root_for(&CanonicalUri::from_path("/elsewhere/x.def")),
            RootId::UNROOTED
        );
        let mut store = DocumentStore::new();
        let k = key(0, "/elsewhere/x.def");
        store.open(k.clone(), 1, "hi").unwrap();
        assert!(store.is_open(&k));
    }
}
