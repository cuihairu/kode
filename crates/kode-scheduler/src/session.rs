//! CORE-004 workspace session (baseline): a single-instance session = **single root registry** +
//! **controlled shared-cache fan-out**.
//!
//! - **Single instance**: every `RootId` can only be issued through this session's root
//!   registry (0 is always [`RootId::UNROOTED`] and never allocated) — structurally there is
//!   no second issuer, and a multi-root session is still one session. No process-level
//!   singleton hard gate: that would break embedder composition and tests; single-instance
//!   status is guaranteed by the assembly surface (the server holds exactly one session).
//! - **Root id incarnation isolation**: `remove_root` goes through [`RootRegistry::unregister`];
//!   ids are never reused, so re-registering the same path after removal must yield a new id,
//!   and cache entries of the old incarnation can never be treated as valid identity of the
//!   new incarnation (fan-out clears synchronously on removal for double assurance).
//! - **Controlled shared cache**: shared caches (symbol index / document store / parse
//!   registry) each expose a root-level invalidation entry; this session registers them as
//!   [`RootInvalidationSink`] and fans out on root removal in registration order, returning a
//!   receipt ([`RootRemoval`], ARCH-004: explicitly tell each consumer surface how many entries
//!   it cleared); keys can only be minted via [`WorkspaceSession::key_for`], out-of-root paths
//!   are rejected (None), and keys are never minted for UNROOTED — cache identity never leaves
//!   a registered root.
//!
//! The built-in `RootInvalidationSink` impls only cover this crate's dependency surfaces
//! ([`SymbolIndex`] / [`DocumentStore`]); the parse registry (PARSE side) adapter belongs to
//! server assembly wiring and is wired together with the provider, out of scope here.

use std::cell::RefCell;
use std::rc::Rc;

use kode_index::SymbolIndex;
use kode_vfs::store::{DocumentKey, DocumentStore, RootId, RootRegistry};
use kode_vfs::uri::CanonicalUri;

/// Root-level invalidation surface of a controlled shared cache: fanned out by the session in
/// registration order when a root is removed.
pub trait RootInvalidationSink {
    /// Clear every resident entry of that root and return the number cleared (used by the
    /// receipt ledger).
    fn invalidate_root(&mut self, root: RootId) -> usize;
    /// Identity label of the consumer surface, used in receipts.
    fn sink_name(&self) -> &'static str;
}

impl RootInvalidationSink for SymbolIndex {
    fn invalidate_root(&mut self, root: RootId) -> usize {
        SymbolIndex::invalidate_root(self, root)
    }
    fn sink_name(&self) -> &'static str {
        "symbol-index"
    }
}

impl RootInvalidationSink for DocumentStore {
    fn invalidate_root(&mut self, root: RootId) -> usize {
        DocumentStore::invalidate_root(self, root).len()
    }
    fn sink_name(&self) -> &'static str {
        "document-store"
    }
}

/// Root-removal receipt (ARCH-004): the root id + how many entries each consumer surface
/// cleared (in registration order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootRemoval {
    pub root: RootId,
    pub invalidated: Vec<(&'static str, usize)>,
}

/// Single-instance workspace session (see module docs).
#[derive(Default)]
pub struct WorkspaceSession {
    registry: RootRegistry,
    sinks: Vec<Rc<RefCell<dyn RootInvalidationSink>>>,
}

impl std::fmt::Debug for WorkspaceSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Do not print sinks (may be huge), only root/consumer-surface counts.
        f.debug_struct("WorkspaceSession")
            .field("roots", &self.registry.roots().len())
            .field("sinks", &self.sinks.len())
            .finish()
    }
}

impl WorkspaceSession {
    pub fn new() -> WorkspaceSession {
        WorkspaceSession::default()
    }

    /// Register a shared-cache consumer surface (root-removal fan-out follows registration
    /// order); the same instance may be registered repeatedly (each registration receives
    /// fan-out). Returns the current consumer-surface count.
    pub fn register_sink(&mut self, sink: Rc<RefCell<dyn RootInvalidationSink>>) -> usize {
        self.sinks.push(sink);
        self.sinks.len()
    }

    pub fn sink_count(&self) -> usize {
        self.sinks.len()
    }

    /// Register a root (re-registering the same path is idempotent and returns the existing id).
    pub fn add_root(&mut self, path: &str) -> RootId {
        self.registry.register(path)
    }

    /// Remove a root: unregister from the registry + fan out root-level invalidation to all
    /// consumer surfaces in registration order. An unknown path returns None and fans out
    /// nothing.
    pub fn remove_root(&mut self, path: &str) -> Option<RootRemoval> {
        let root = self.registry.unregister(path)?;
        let mut invalidated = Vec::new();
        for sink in &self.sinks {
            let mut sink = sink.borrow_mut();
            let cleared = sink.invalidate_root(root);
            invalidated.push((sink.sink_name(), cleared));
        }
        Some(RootRemoval { root, invalidated })
    }

    pub fn roots(&self) -> &[(RootId, String)] {
        self.registry.roots()
    }

    /// URI ownership (the longest-prefix root wins; outside any root = [`RootId::UNROOTED`]).
    pub fn root_for(&self, uri: &CanonicalUri) -> RootId {
        self.registry.root_for(uri)
    }

    /// Every root that claims this URI (>1 means a root conflict, for conflict diagnostics).
    pub fn overlapping_roots(&self, uri: &CanonicalUri) -> Vec<RootId> {
        self.registry.overlapping_roots(uri)
    }

    /// Controlled key-minting entry: out-of-root paths are rejected (None), and keys are
    /// never minted for UNROOTED — shared-cache entry identity never leaves a registered root.
    pub fn key_for(&self, uri: &CanonicalUri) -> Option<DocumentKey> {
        let root = self.registry.root_for(uri);
        if root == RootId::UNROOTED {
            None
        } else {
            Some(DocumentKey::new(root, uri.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_index::SymbolKind;
    use std::cell::RefCell;

    /// A fake sink that records fan-out calls (its name is customizable, for registration-order
    /// assertions).
    struct NamedLog {
        name: &'static str,
        calls: Vec<u32>,
        cleared_per_call: usize,
    }
    impl NamedLog {
        fn new(name: &'static str) -> NamedLog {
            NamedLog {
                name,
                calls: Vec::new(),
                cleared_per_call: 1,
            }
        }
    }
    impl RootInvalidationSink for NamedLog {
        fn invalidate_root(&mut self, root: RootId) -> usize {
            self.calls.push(root.0);
            self.cleared_per_call
        }
        fn sink_name(&self) -> &'static str {
            self.name
        }
    }

    fn uri(path: &str) -> CanonicalUri {
        CanonicalUri::from_path(path)
    }

    #[test]
    fn multi_roots_get_distinct_ids_and_unrooted_reserved() {
        let mut session = WorkspaceSession::new();
        let a = session.add_root("/w/alpha");
        let b = session.add_root("/w/beta");
        let a2 = session.add_root("/w/alpha");
        assert_ne!(a, b);
        assert_eq!(a, a2, "重复注册同一路径幂等");
        assert_ne!(a, RootId::UNROOTED);
        assert_ne!(b, RootId::UNROOTED);
    }

    #[test]
    fn remove_root_fans_out_in_registration_order_with_receipt() {
        let mut session = WorkspaceSession::new();
        let root = session.add_root("/w/proj");
        let first = Rc::new(RefCell::new(NamedLog::new("sink-a")));
        let second = Rc::new(RefCell::new(NamedLog::new("sink-b")));
        assert_eq!(session.register_sink(first.clone()), 1);
        assert_eq!(session.register_sink(second.clone()), 2);
        let removal = session.remove_root("/w/proj").expect("已注册根必可撤");
        assert_eq!(removal.root, root);
        assert_eq!(
            removal.invalidated,
            vec![("sink-a", 1), ("sink-b", 1)],
            "回执按注册序列出每个消费面的清除数"
        );
        assert_eq!(first.borrow().calls, vec![root.0]);
        assert_eq!(second.borrow().calls, vec![root.0]);
        // The registry no longer holds it: removing the same path again = None.
        assert!(session.remove_root("/w/proj").is_none());
    }

    #[test]
    fn remove_unknown_root_is_none_and_does_not_fan_out() {
        let mut session = WorkspaceSession::new();
        session.add_root("/w/real");
        let log = Rc::new(RefCell::new(NamedLog::new("sink")));
        session.register_sink(log.clone());
        assert!(session.remove_root("/w/ghost").is_none());
        assert!(log.borrow().calls.is_empty(), "未知根撤销不得扇出");
    }

    #[test]
    fn key_for_rejects_unrooted_and_mints_registered_key() {
        let mut session = WorkspaceSession::new();
        let root = session.add_root("/w/proj");
        assert!(
            session.key_for(&uri("/elsewhere/x.def")).is_none(),
            "根外路径拒绝铸键"
        );
        let key = session
            .key_for(&uri("/w/proj/entities/Monster.def"))
            .expect("注册根内必可铸键");
        assert_eq!(key.root, root);
        assert_eq!(session.root_for(&uri("/elsewhere/x.def")), RootId::UNROOTED);
    }

    #[test]
    fn incarnation_isolation_fresh_id_after_removal() {
        let mut session = WorkspaceSession::new();
        let first = session.add_root("/w/alpha");
        let key_a = session
            .key_for(&uri("/w/alpha/x.def"))
            .expect("第一化身铸键");
        session.remove_root("/w/alpha").expect("撤根");
        assert!(
            session.key_for(&uri("/w/alpha/x.def")).is_none(),
            "撤根后路径出根"
        );
        let second = session.add_root("/w/alpha");
        assert_ne!(first, second, "id 永不复用:新旧化身隔离");
        let key_b = session
            .key_for(&uri("/w/alpha/x.def"))
            .expect("第二化身铸键");
        assert_ne!(key_a, key_b, "新旧化身缓存身份永不重合");
    }

    #[test]
    fn symbol_index_sink_clears_only_removed_root() {
        let mut session = WorkspaceSession::new();
        let a = session.add_root("/w/alpha");
        let b = session.add_root("/w/beta");
        // Same-named entity, one copy per root: the real isolation proving ground inside a
        // shared cache (the entity name is taken from the file stem).
        let text = "<root>\n</root>";
        let index = Rc::new(RefCell::new(SymbolIndex::new()));
        index.borrow_mut().update(
            kode_index::DocumentKey::new(a, uri("/w/alpha/Monster.def")),
            text,
        );
        index.borrow_mut().update(
            kode_index::DocumentKey::new(b, uri("/w/beta/Monster.def")),
            text,
        );
        assert_eq!(
            index
                .borrow()
                .lookup_kind("Monster", SymbolKind::Entity)
                .len(),
            2
        );
        session.register_sink(index.clone());
        let removal = session.remove_root("/w/alpha").expect("撤 alpha");
        assert_eq!(removal.invalidated, vec![("symbol-index", 1)]);
        // beta's same-named entity must survive: fan-out only clears the removed root.
        let survivors = index.borrow().lookup_kind("Monster", SymbolKind::Entity);
        assert_eq!(survivors.len(), 1, "只剩 beta 一份");
        assert_eq!(survivors[0].file.root, b, "幸存者必须属于 beta 根");
    }

    #[test]
    fn debug_shows_counts_not_sink_values() {
        let mut session = WorkspaceSession::new();
        session.add_root("/w/alpha");
        session.register_sink(Rc::new(RefCell::new(NamedLog::new("sink-a"))));
        let dbg = format!("{session:?}");
        assert!(dbg.contains("roots: 1"), "{dbg}");
        assert!(dbg.contains("sinks: 1"), "{dbg}");
        assert!(!dbg.contains("sink-a"), "sink 内部不得泄漏进 Debug");
    }

    /// DocumentStore built-in consumer surface: receipt name + clears only the resident
    /// documents of the removed root.
    #[test]
    fn document_store_sink_receipt_and_root_isolation() {
        let mut session = WorkspaceSession::new();
        let a = session.add_root("/w/alpha");
        let b = session.add_root("/w/beta");
        let store = Rc::new(RefCell::new(DocumentStore::new()));
        store
            .borrow_mut()
            .open(
                DocumentKey::new(a, uri("/w/alpha/Avatar.def")),
                1,
                "<root/>",
            )
            .expect("open alpha doc");
        store
            .borrow_mut()
            .open(
                DocumentKey::new(b, uri("/w/beta/Monster.def")),
                1,
                "<root/>",
            )
            .expect("open beta doc");
        session.register_sink(store.clone());
        let removal = session.remove_root("/w/alpha").expect("撤 alpha");
        assert_eq!(removal.invalidated, vec![("document-store", 1)]);
        // The beta document must survive: fan-out only clears the removed root's resident
        // entries.
        assert!(store
            .borrow()
            .is_open(&DocumentKey::new(b, uri("/w/beta/Monster.def"))));
        assert!(!store
            .borrow()
            .is_open(&DocumentKey::new(a, uri("/w/alpha/Avatar.def"))));
    }

    /// Three query-side pieces: sink_count / the roots listing / overlapping_roots
    /// (nested-root conflict).
    #[test]
    fn sink_count_roots_listing_and_overlapping_roots() {
        let mut session = WorkspaceSession::new();
        assert_eq!(session.sink_count(), 0);
        session.register_sink(Rc::new(RefCell::new(NamedLog::new("a"))));
        session.register_sink(Rc::new(RefCell::new(NamedLog::new("b"))));
        assert_eq!(session.sink_count(), 2);

        let a = session.add_root("/w/alpha");
        let nested = session.add_root("/w/alpha/nested");
        let listing = session.roots();
        assert_eq!(listing.len(), 2);
        assert!(listing.contains(&(a, "/w/alpha".to_string())));
        assert!(listing.contains(&(nested, "/w/alpha/nested".to_string())));

        // Nested roots both claim the same URI: >1 means the root-conflict surface.
        let hits = session.overlapping_roots(&uri("/w/alpha/nested/Monster.def"));
        assert_eq!(hits.len(), 2, "内外两层根都命中");
        assert!(hits.contains(&a) && hits.contains(&nested));
        // Out-of-root paths get no hits.
        assert!(session
            .overlapping_roots(&uri("/elsewhere/x.def"))
            .is_empty());
    }
}
