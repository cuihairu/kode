//! Root registration for comparison golden corpora (KBUG-ROOT).
//!
//! Defect: the golden generator used to file all corpus files under [`RootId::UNROOTED`] uniformly,
//! so same-named entities across the four corpus projects (each an independent fixture project) blurred into one root
//! in the engine view, letting a first-seen hit borrow paths across projects. Production semantics are per-workspace-root isolation (VFS-009),
//! so here each corpus project in `PARITY_CORPORA` is registered as an independent resource root with the same stance;
//! the filing/lookup key = each project's own root.

use kode_vfs::store::{DocumentKey, RootRegistry};

/// Register all comparison corpus projects; registration order = [`kode_parser::json::PARITY_CORPORA`] order.
pub(crate) fn corpus_registry() -> RootRegistry {
    let mut registry = RootRegistry::new();
    for corpus in kode_parser::json::PARITY_CORPORA {
        registry.register(corpus);
    }
    registry
}

/// Filing/lookup key for corpus files: root = the corpus project the file belongs to (longest-prefix ownership).
pub(crate) fn corpus_key(registry: &RootRegistry, rel_path: &str) -> DocumentKey {
    let uri = kode_vfs::uri::CanonicalUri::from_path(rel_path);
    DocumentKey::new(registry.root_for(&uri), uri)
}
