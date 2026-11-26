//! kode-index: symbol index (kode2 PR-007, book §7 IDX basic edition / §17 PR-007).
//!
//! Modules:
//! - [`symbol`]: six-kind symbol model (entity/property/method/type/alias/component) + pure extraction functions;
//! - [`index`]: [`SymbolIndex`] name inverted index + file-level increments (zero rebuild via fingerprint) + atomic
//!   generation + deletion/root-level invalidation cleanup + inheritance chain cycle termination;
//! - [`golden`]: parity golden serialization against the TS symbolIndex capability face (fixture-driven,
//!   not the ARCH-012 performance comparison).
//!
//! Iron rule: zero third-party crates (depends only on workspace-internal kode-parser/kode-vfs).

pub mod golden;
pub mod index;
pub mod symbol;

pub use index::{BatchReceipt, ChangeCategory, IndexStats, IndexUpdateReport, SymbolIndex};
pub use symbol::{
    def_entity_name, extract_records, MethodFacet, Symbol, SymbolId, SymbolKind, SymbolRecord,
};

pub use kode_parser::dep::ParseCacheStats;
pub use kode_parser::diag::Diagnostic;
pub use kode_parser::model::ChainNode;
pub use kode_vfs::store::{DocumentKey, RootId};
