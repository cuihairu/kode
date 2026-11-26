//! VFS-002/003/009/012 document store: identity, overlay, version transitions, root registration, removal invalidation.
//!
//! - **Identity (VFS-002)**: `DocumentKey = (RootId, CanonicalUri)`; an open buffer
//!   also carries a strictly increasing version. A basename is never the identity.
//! - **Overlay (VFS-003)**: open documents prefer memory (ARCH-003); didOpen/didChange/
//!   didClose are the only three version transition edges, and an older version is
//!   always rejected (see [`VersionConflict`]), guaranteeing "the editor's latest
//!   content is never overwritten by an older result" (ARCH-005).
//! - **Root registration (VFS-009 base version)**: registration order = explicit
//!   preference order; a query takes the longest prefix, and
//!   [`RootRegistry::overlapping_roots`] is exposed for conflict diagnostics when
//!   multiple roots are hit.
//! - **Deletion/rename (VFS-012)**: `remove`/`rename` return [`RemovedDocument`],
//!   letting the downstream index/diagnostics clean stale symbols and old diagnostics.

use std::collections::HashMap;

use crate::disk::DiskCache;
use crate::line_index::{DocumentBuffer, TextChange};
use crate::uri::CanonicalUri;

/// Resource root id. 0 is reserved for documents belonging to no registered root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RootId(pub u32);

impl RootId {
    pub const UNROOTED: RootId = RootId(0);
}

/// VFS-002 query identity: root + canonical URI. The version exists only on an open buffer.
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

/// Resource root registry (VFS-009 base version).
/// Ids start at 1: 0 is always left for [`RootId::UNROOTED`](documents outside any registered root) and never coincides with a registered root.
#[derive(Debug, Clone)]
pub struct RootRegistry {
    roots: Vec<(RootId, String)>,
    next_id: u32,
}

impl Default for RootRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RootRegistry {
    pub fn new() -> RootRegistry {
        RootRegistry {
            roots: Vec::new(),
            next_id: 1,
        }
    }

    /// Register one root (re-registering the same path is idempotent and returns the existing id).
    /// Registration order is the explicit preference order (VFS-009).
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

    /// Unregister one root (CORE-004 session surface): the entry is removed, and its id is
    /// **never reused** (next_id is monotonic) — re-registering the same path after
    /// unregistering always yields a new id, so the cache identities of the new and old
    /// incarnations never coincide (the isolation premise of a controlled shared cache).
    /// An unknown path returns None, making no change at all.
    pub fn unregister(&mut self, path: &str) -> Option<RootId> {
        let canonical = CanonicalUri::from_path(path);
        let pos = self
            .roots
            .iter()
            .position(|(_, existing)| *existing == canonical.as_path())?;
        Some(self.roots.remove(pos).0)
    }

    pub fn roots(&self) -> &[(RootId, String)] {
        &self.roots
    }

    /// URI ownership: the longest-prefix root wins; a miss -> [`RootId::UNROOTED`].
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

    /// All roots hitting that URI (in registration order; >1 means a root conflict, for VFS-009 conflict diagnostics).
    pub fn overlapping_roots(&self, uri: &CanonicalUri) -> Vec<RootId> {
        let path = uri.as_path();
        self.roots
            .iter()
            .filter(|(_, root_path)| prefix_len_at_boundary(root_path, path).is_some())
            .map(|(id, _)| *id)
            .collect()
    }
}

/// root is a prefix of path that ends on a component boundary (or the two are exactly equal).
fn prefix_len_at_boundary(root: &str, path: &str) -> Option<usize> {
    if path == root {
        return Some(root.len());
    }
    if !path.starts_with(root) {
        return None;
    }
    let rest = &path[root.len()..];
    if root.ends_with('/') || rest.starts_with('/') {
        Some(root.len())
    } else {
        None // Sibling directories: /w/demo and /w/demo2 must not swallow each other
    }
}

/// Version transition conflict (VFS-003/013).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionConflict {
    /// The target document was never didOpen (the didChange prerequisite is missing).
    NotOpen,
    /// The incoming version is not newer than the existing one; `current` is the existing version.
    Stale { current: i64, incoming: i64 },
}

/// The overlay entry for an open document.
#[derive(Debug, Clone)]
struct OpenDocument {
    version: i64,
    buffer: DocumentBuffer,
}

/// Snapshot source (VFS-003: distinguishing "unsaved" from "disk").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentSource {
    /// In-memory overlay (including unsaved edits).
    OpenOverlay,
    /// Disk (via the fingerprint cache).
    Disk,
}

/// One query snapshot: text + line index + source + (when open) version.
#[derive(Debug, Clone)]
pub struct DocumentSnapshot {
    pub key: DocumentKey,
    pub version: Option<i64>,
    pub source: ContentSource,
    pub buffer: DocumentBuffer,
}

/// VFS-012: the removal receipt of remove/rename, for downstream index/diagnostics cleanup.
#[derive(Debug, Clone)]
pub struct RemovedDocument {
    pub key: DocumentKey,
    pub was_open: bool,
    pub last_version: Option<i64>,
    pub last_buffer: Option<DocumentBuffer>,
}

/// Document store: overlay + disk fingerprint cache.
#[derive(Debug, Default)]
pub struct DocumentStore {
    overlays: HashMap<DocumentKey, OpenDocument>,
    disk: DiskCache,
}

impl DocumentStore {
    pub fn new() -> DocumentStore {
        DocumentStore::default()
    }

    /// didOpen: registers an overlay. Already open with an incoming version that is not
    /// newer -> rejected
    /// (LSP semantics: open only ever targets an unopened document; old replays are
    /// defensively ignored).
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

    /// didChange: must already be open; version strictly increasing; changes applied in order
    /// (full sync is one whole-text change, incremental is several ranged changes).
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

    /// didClose: removes the overlay and the document falls back to the on-disk truth;
    /// unsaved content is dropped with the overlay
    /// (LSP semantics: the client should have saved before close). Returns whether the
    /// document was actually open.
    pub fn close(&mut self, key: &DocumentKey) -> bool {
        self.overlays.remove(key).is_some()
    }

    /// Query a snapshot: open overlay first (VFS-003), otherwise disk (fingerprint cache, VFS-006).
    /// Document neither open nor readable from disk -> `None` (VFS-010 safe degradation).
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

    /// Query only the open overlay (no disk access; the pure in-memory query path).
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

    /// Open document summaries, sorted by uri (deterministic health report output).
    pub fn open_summaries(&self) -> Vec<(String, i64)> {
        let mut out: Vec<(String, i64)> = self
            .overlays
            .iter()
            .map(|(key, open)| (key.uri.to_uri_string(), open.version))
            .collect();
        out.sort();
        out
    }

    /// VFS-012: delete invalidation — removes the overlay and the disk cache entry, returning a cleanup receipt
    /// (the downstream index/diagnostics uses it to delete stale symbols; a receipt is returned even when
    /// the file does not exist, so the caller always runs the same cleanup logic).
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

    /// VFS-012: rename/cross-root move — the old identity is invalidated as a whole and the
    /// content migrates to the new identity
    /// (if the old document was open it stays open, with its version carried over).
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

    /// Root switch/root removal: the whole root is invalidated (VFS-013 workspace root switch), returning the cleaned document keys.
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
    fn unregister_then_reregister_same_path_gets_fresh_id() {
        let mut registry = RootRegistry::new();
        let first = registry.register("/w/alpha");
        assert_ne!(first, RootId::UNROOTED);
        assert_eq!(registry.unregister("/w/alpha"), Some(first));
        // Unregistering an unknown path: None, zero changes.
        assert_eq!(registry.unregister("/w/alpha"), None);
        assert_eq!(registry.unregister("/w/other"), None);
        // Re-registering the same path must yield a new id: the cache identities of
        // the new and old incarnations never coincide (CORE-004).
        let second = registry.register("/w/alpha");
        assert_ne!(first, second, "id 不得复用,化身必须隔离");
        assert_eq!(registry.roots().len(), 1);
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
        // Sibling directories must not swallow each other.
        let uri = CanonicalUri::from_path("/w/demo2/x.def");
        assert_eq!(registry.root_for(&uri), RootId::UNROOTED);
        assert!(registry.overlapping_roots(&uri).is_empty());
        // Two roots hit -> conflict diagnostics entry point.
        let uri = CanonicalUri::from_path("/w/demo/kbengine/y.def");
        assert_eq!(registry.overlapping_roots(&uri), vec![demo, engine]);
        // Registering the same path twice is idempotent.
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
        // An old version is rejected.
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

    #[test]
    fn reopen_with_newer_version_replaces_overlay() {
        let mut store = DocumentStore::new();
        let k = key(1, "/w/reopen.def");
        store.open(k.clone(), 1, "v1").unwrap();
        // A same-version replay is rejected (open only belongs to an unopened document).
        assert!(matches!(
            store.open(k.clone(), 1, "again"),
            Err(VersionConflict::Stale {
                current: 1,
                incoming: 1
            })
        ));
        // Reopen with a newer version: the overlay is replaced as a whole.
        store.open(k.clone(), 3, "v3").unwrap();
        let snap = store.snapshot(&k).unwrap();
        assert_eq!(snap.version, Some(3));
        assert_eq!(snap.buffer.text(), "v3");
    }

    #[test]
    fn snapshot_of_missing_document_is_none() {
        let mut store = DocumentStore::new();
        let k = key(1, "/w/never-writes.def");
        assert!(store.snapshot(&k).is_none());
    }

    #[test]
    fn remove_reports_closed_documents_without_version() {
        let mut store = DocumentStore::new();
        let k = key(1, "/w/never-opened-remove.def");
        let removed = store.remove(&k).unwrap();
        assert!(!removed.was_open);
        assert_eq!(removed.last_version, None);
        assert!(removed.last_buffer.is_none());
        assert_eq!(removed.key, k);
    }

    #[test]
    fn invalidate_root_with_no_documents_is_empty() {
        let mut store = DocumentStore::new();
        assert!(store.invalidate_root(RootId(42)).is_empty());
    }

    #[test]
    fn open_count_and_open_summaries_report_overlay_state() {
        let mut store = DocumentStore::new();
        assert_eq!(store.open_count(), 0);
        assert!(store.open_summaries().is_empty());
        let a = key(1, "/w/a.def");
        let b = key(1, "/w/b.def");
        store.open(b.clone(), 5, "b").unwrap();
        store.open(a.clone(), 2, "a").unwrap();
        assert_eq!(store.open_count(), 2);
        // Sorted by uri (deterministic health report output); insertion order b,a
        // does not affect the output order.
        assert_eq!(
            store.open_summaries(),
            vec![
                ("file:///w/a.def".to_string(), 2),
                ("file:///w/b.def".to_string(), 5),
            ]
        );
        // After close, the count and summaries fall back in sync.
        store.close(&a);
        assert_eq!(store.open_count(), 1);
        assert_eq!(
            store.open_summaries(),
            vec![("file:///w/b.def".to_string(), 5)]
        );
    }

    #[test]
    fn disk_cache_is_reachable_and_clearable() {
        let dir = std::env::temp_dir().join(format!("kode-vfs-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cache.def");
        std::fs::write(&p, "from disk").unwrap();

        let mut store = DocumentStore::new();
        let dk = key(1, &p.to_string_lossy());
        let snap = store.snapshot(&dk).unwrap();
        assert_eq!(snap.source, ContentSource::Disk);
        assert_eq!(snap.buffer.text(), "from disk");
        // The invalidate + clear surface is reachable (shared by delete/rename/root switch).
        store.disk_cache().invalidate(&p);
        store.disk_cache().clear();
        // The Default implementation equals new (empty roots, ids start at 1).
        let registry = RootRegistry::default();
        assert!(registry.roots().is_empty());
        assert_eq!(
            registry.root_for(&CanonicalUri::from_path("/w/x.def")),
            RootId::UNROOTED
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
