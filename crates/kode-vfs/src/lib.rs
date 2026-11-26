//! kode-vfs — the kode2 virtual filesystem layer (book §5 crates/kode-vfs, PR-004).
//!
//! Coverage (base version, evidence in docs/kode2/pr-004.md):
//! - VFS-001/002 path identity: canonical URI ([`uri`]) plus query identity
//!   `(root_id, uri)` ([`store::DocumentKey`]); indexing by basename is forbidden.
//! - VFS-003 open overlay takes precedence over disk; didOpen/didChange/didClose
//!   use strict version transitions ([`store`]).
//! - VFS-004/005 line index with exact UTF-16 ↔ bytes ↔ line/col conversion
//!   (emoji/CRLF covered; queries never split the whole text, [`line_index`]).
//! - VFS-006 disk fingerprint mtime+size ([`disk`]).
//! - VFS-007/008/010 scan exclusion, KBEngine file classification, IO-safe degradation ([`walk`]).
//! - VFS-009 resource root registration order + longest prefix + conflict diagnostics entry point ([`store::RootRegistry`]).
//! - VFS-011 parse cache: latest valid snapshot + negative cache ([`parse_cache`]).
//! - VFS-012 stale data cleanup interface for deletion/rename/root switching ([`store`]).
//! - VFS-013 scenario tests (100 edits / save races / unsaved changes / root switch) live in
//!   `tests/vfs.rs`; coordinate parity comparison in `tests/coordinates.rs`.
//!
//! Design boundary: purely synchronous, no async; disk IO only inside [`disk`]/[`walk`];
//! coordinate semantics stay isomorphic with the kode-protocol DTOs, with the server side doing a pure conversion.

pub mod disk;
pub mod line_index;
pub mod parse_cache;
pub mod persist_key;
pub mod persist_store;
pub mod store;
pub mod uri;
pub mod walk;

pub use disk::{DiskCache, DiskFingerprint};
pub use line_index::{utf16_len, DocumentBuffer, LineIndex, Position, Range, TextChange};
pub use parse_cache::{content_fingerprint, content_fingerprint_bytes, ParseCache};
pub use persist_store::PersistStore;
pub use store::{
    ContentSource, DocumentKey, DocumentSnapshot, DocumentStore, RemovedDocument, RootId,
    RootRegistry, VersionConflict,
};
pub use uri::{CanonicalUri, UriError};
pub use walk::{classify, scan, FileKind, ScanEntry, WalkOptions, WalkStats};

/// Canonical path -> [`std::path::Path`].
/// The Windows canonical form `/C:/...` drops the leading `/` to restore `C:/...` (other platforms pass through as-is).
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
