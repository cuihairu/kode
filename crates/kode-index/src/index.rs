//! Symbol index: name inverted index + file-level increments + atomic
//! generation (book §7 basic edition, PR-007).
//!
//! - Reuses kode-parser [`ParseRegistry`](kode_parser::dep): fingerprint hit =
//!   zero rebuild (VFS-011 ParseCache + FNV-1a, IDX-003/004 basic edition) +
//!   reverse dependency index (IDX-002 basic edition); this layer does not
//!   rebuild its own cache or fingerprints;
//! - Name inverted index `name -> slot set` (IDX-006: targeted lookup /
//!   prefix workspace_symbols, never an O(file count) scan);
//! - File-level increment unit `DocumentKey -> symbol slot table`: changing one
//!   file only re-registers that file's symbols, while other files' slots and
//!   inverted entries stay intact (the measured basis for the IDX-013
//!   assertion "only affected files", see [`IndexStats`] for rebuild counts);
//! - [`SymbolIndex::update_batch`] increments the generation once after the
//!   whole batch is applied (IDX-007 atomic generation basic edition);
//!   delete/rename [`SymbolIndex::remove`] cleans up the inverted index /
//!   reverse index / inheritance edges in turn (IDX-014); root-level scoped
//!   invalidation [`SymbolIndex::invalidate_root`](IDX-015);
//! - Inheritance chain queries delegate to kode-parser `resolve_parent_chain`:
//!   cycles are explicitly diagnosed and finitely truncated, never looping
//!   forever (IDX-005 termination guarantee, SEM-004).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use kode_parser::dep::{file_kind_of_uri, FileKind, ParseCacheStats, ParseRegistry};
use kode_parser::diag::Diagnostic;
use kode_parser::model::{resolve_parent_chain, ChainNode};
use kode_vfs::store::{DocumentKey, RootId};

use crate::symbol::{extract_records, Symbol, SymbolId, SymbolKind, SymbolRecord};

/// Measured counters (basis for the zero-rebuild increment assertions and the pr-007.md report).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexStats {
    /// Number of update/update_batch entry invocations (counted per file).
    pub update_calls: u64,
    /// Number of files that actually re-registered symbols (only +1 when the fingerprint misses;
    /// expected value = number of genuinely changed files).
    pub rebuilds: u64,
    /// Number of zero-rebuild fingerprint hits.
    pub cache_hits: u64,
    /// Number of files cleaned up by remove/invalidate_root.
    pub removals: u64,
    /// Number of generation increments (a batch submission only counts +1).
    pub generation_bumps: u64,
    /// RUST-120-W: number of times a reparse with identical signature facts (body-only)
    /// was differentially skipped (no slot swap, no generation bump, all reader snapshots survive).
    pub body_only_skips: u64,
}

/// Change category (the verdict of RUST-120-W differential invalidation):
/// - [`ChangeCategory::Identical`] text unchanged (fingerprint hit, zero rebuild and
///   zero invalidation);
/// - [`ChangeCategory::BodyOnly`] text changed but the signature facts
///   (records + Parent + reference set) are all identical — zero index-state
///   mutation, no generation bump, and no reader holding a snapshot is
///   invalidated;
/// - [`ChangeCategory::Signature`] signature facts changed — re-register + bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeCategory {
    Identical,
    BodyOnly,
    Signature,
}

impl ChangeCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChangeCategory::Identical => "identical",
            ChangeCategory::BodyOnly => "body-only",
            ChangeCategory::Signature => "signature",
        }
    }
}

/// Single-file update receipt (ARCH-004: state clearly what happened).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexUpdateReport {
    /// false = fingerprint hit, zero symbol rebuild.
    pub rebuilt: bool,
    /// Reasons such as non-declaration file (the file produces no symbols).
    pub error: Option<String>,
    /// RUST-120-W: change category (Identical/BodyOnly/Signature).
    pub change: ChangeCategory,
    /// Symbols newly registered this pass (meaningful when rebuilt).
    pub added: usize,
    /// Old symbols displaced this pass (meaningful when rebuilt).
    pub removed: usize,
    /// generation after the update is applied.
    pub generation: u64,
}

/// Batch submission receipt (IDX-007: one generation per whole batch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchReceipt {
    pub generation: u64,
    /// Number of files in the batch.
    pub files: usize,
    /// Files that actually re-registered (fingerprint hits and body-only skips do not count).
    pub rebuilds: u64,
    /// Body-only differential skips in the batch (RUST-120-W; no generation bump).
    pub body_only: u64,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Default, Clone)]
struct FileEntry {
    symbols: Vec<SymbolId>,
}

/// Symbol index.
#[derive(Debug)]
pub struct SymbolIndex {
    registry: ParseRegistry,
    slots: Vec<Option<Symbol>>,
    free: Vec<SymbolId>,
    /// Name inverted index: name -> set of slots holding that name (IDX-006).
    by_name: BTreeMap<String, BTreeSet<SymbolId>>,
    /// File-level increment unit: file -> that file's symbol slot table (document order preserved).
    by_file: BTreeMap<DocumentKey, FileEntry>,
    /// Inheritance edges: (root, def entity name) -> Parent (IDX-002 basic edition;
    /// chain queries IDX-005). Edges for same-named entities across roots neither
    /// overwrite nor cross-chain (KODE-FULL-017).
    entity_parents: HashMap<(RootId, String), String>,
    generation: u64,
    pub stats: IndexStats,
}

impl Default for SymbolIndex {
    fn default() -> Self {
        SymbolIndex {
            registry: ParseRegistry::new(),
            slots: Vec::new(),
            free: Vec::new(),
            by_name: BTreeMap::new(),
            by_file: BTreeMap::new(),
            entity_parents: HashMap::new(),
            generation: 0,
            stats: IndexStats::default(),
        }
    }
}

impl SymbolIndex {
    pub fn new() -> SymbolIndex {
        SymbolIndex::default()
    }

    /// CORE-013 basic edition: index with a parse-layer residency budget. Budget
    /// unit = bytes of the resident parse product's own strings (a lower-bound proxy,
    /// not a direct RSS measure; RUST-129 measured def-shape RSS at roughly this
    /// weight ×3). Over-budget entries are evicted by a second-chance approximate
    /// LRU; an evicted file simply rebuilds on the next update (cache loss loses
    /// no correctness); `new()` stays unbounded, existing behavior unchanged.
    pub fn with_parse_budget(max_bytes: u64) -> SymbolIndex {
        SymbolIndex {
            registry: ParseRegistry::with_resident_budget(max_bytes),
            ..SymbolIndex::default()
        }
    }

    /// Pass-through of the parse residency budget cap (unbounded = None; for the
    /// wiring-side observation surface).
    pub fn parse_budget_bytes(&self) -> Option<u64> {
        self.registry.resident_budget_bytes()
    }

    /// RUST-125: buffer activity notification (the open/edit touch surface) —
    /// grants parse cache entries one round of eviction reprieve (a reprieve, not
    /// a hard pin; see kode-parser ParseRegistry::note_buffer_activity for the
    /// exact contract). Open events are called by the queue wiring layer; didChange
    /// reaches it via update itself.
    pub fn note_buffer_activity(&mut self, key: &DocumentKey) {
        self.registry.note_buffer_activity(key);
    }

    /// RUST-125: parse residency observation (same source as the health-face `parseCache` key).
    pub fn parse_cache_stats(&self) -> ParseCacheStats {
        self.registry.parse_cache_stats()
    }

    /// RUST-133: full enumeration of parse-failed files (the index-gap partial
    /// face) — delegates to the registry negative cache, ordered by (root, path)
    /// lexicographically.
    pub fn negative_entries(&self) -> Vec<(DocumentKey, String)> {
        self.registry.negative_entries()
    }

    /// RUST-133: whether the file is indexed (the tracked predicate, per-URI gap
    /// ruling face; direct by_file lookup, no symbol enumeration).
    pub fn tracks(&self, key: &DocumentKey) -> bool {
        self.by_file.contains_key(key)
    }

    /// RUST-133: whether the file is known to the parse registry (the complete
    /// contract for the tracked predicate — a file that parses successfully but
    /// yields zero symbols is absent from by_file, so tracks would misjudge it as
    /// unindexed; the registry forward table has an entry for every successfully
    /// parsed file, and none for failed/non-declaration files).
    pub fn known_to_registry(&self, key: &DocumentKey) -> bool {
        self.registry.refs_of(key).is_some()
    }

    /// Single-file increment entry (RUST-120-W differential invalidation):
    /// fingerprint hit = Identical with zero rebuild and zero invalidation;
    /// after reparsing, signature facts (records + Parent + reference set) all
    /// identical = BodyOnly, with zero index-state mutation and no generation
    /// bump — every reader holding a snapshot survives; facts changed =
    /// Signature, which alone re-registers + bumps. When the parse cache has
    /// been evicted by LRU the old reference set is unavailable = conservatively
    /// treated as Signature (better to invalidate too often than to miss a report);
    /// the first ingestion, whose old records are empty, is not affected by this
    /// conservative fallback.
    pub fn update(&mut self, key: DocumentKey, text: &str) -> IndexUpdateReport {
        self.stats.update_calls += 1;
        let (rebuilt, change, error, added, removed) = self.ingest_classified(&key, text);
        match change {
            ChangeCategory::Identical => self.stats.cache_hits += 1,
            ChangeCategory::BodyOnly => self.stats.body_only_skips += 1,
            ChangeCategory::Signature => {
                self.stats.rebuilds += 1;
                self.bump();
            }
        }
        let _ = rebuilt;
        IndexUpdateReport {
            rebuilt: rebuilt || change != ChangeCategory::Identical,
            error,
            change,
            added,
            removed,
            generation: self.generation,
        }
    }

    /// Batch submission: the generation increments once after every file is applied
    /// (IDX-007); after classification only Signature triggers a bump
    /// (RUST-120-W: a purely Identical/BodyOnly batch invalidates no reader snapshots).
    pub fn update_batch(&mut self, batch: &[(DocumentKey, String)]) -> BatchReceipt {
        let before_rebuilds = self.stats.rebuilds;
        let before_body_only = self.stats.body_only_skips;
        let mut added = 0usize;
        let mut removed = 0usize;
        for (key, text) in batch {
            self.stats.update_calls += 1;
            let (_rebuilt, change, _error, a, r) = self.ingest_classified(key, text);
            match change {
                ChangeCategory::Identical => self.stats.cache_hits += 1,
                ChangeCategory::BodyOnly => self.stats.body_only_skips += 1,
                ChangeCategory::Signature => self.stats.rebuilds += 1,
            }
            added += a;
            removed += r;
        }
        let rebuilds = self.stats.rebuilds - before_rebuilds;
        let body_only = self.stats.body_only_skips - before_body_only;
        // A batch with zero signature changes does not increment the generation
        // (reader snapshots stay valid; same semantics as the single-file path).
        if rebuilds > 0 {
            self.bump();
        }
        BatchReceipt {
            generation: self.generation,
            files: batch.len(),
            rebuilds,
            added,
            removed,
            body_only,
        }
    }

    /// Classified ingest core (does not touch stats/generation; callers bookkeep by
    /// category): fingerprint hit -> Identical; after reparsing the old and new
    /// signature facts are identical -> BodyOnly (zero index-state mutation);
    /// otherwise Signature (differential replacement). Old facts are captured before
    /// the registry update (old reference set via `refs_of`; old records rebuilt
    /// from slots, zero extra residency; old Parent via the inheritance edge table).
    fn ingest_classified(
        &mut self,
        key: &DocumentKey,
        text: &str,
    ) -> (bool, ChangeCategory, Option<String>, usize, usize) {
        let old_refs = self.registry.refs_of(key).cloned();
        let old_records: Vec<SymbolRecord> = self
            .symbols_in_file(key)
            .iter()
            .map(|s| SymbolRecord {
                name: s.name.clone(),
                kind: s.kind,
                line: s.line,
                facet: s.facet,
                detail: s.detail.clone(),
            })
            .collect();
        let old_parent = crate::symbol::def_entity_name(key.uri.as_path())
            .and_then(|entity| self.entity_parents.get(&(key.root, entity)).cloned());
        let had_old_records = self.by_file.contains_key(key);
        let (registry_report, unit) = self.registry.update(key.clone(), text);
        // Registry invariant: rebuilt=true always carries a parse product — both
        // product-less paths (negative cache hit and non-declaration file) return
        // rebuilt=false. So "rebuilt but no product" is inexpressible and exits early
        // through the same branch as a fingerprint hit (Identical, zero index-state
        // mutation).
        let unit = if registry_report.rebuilt {
            unit.as_deref()
        } else {
            None
        };
        let Some(unit) = unit else {
            return (
                false,
                ChangeCategory::Identical,
                registry_report.error,
                0,
                0,
            );
        };
        let (new_records, declaration) = extract_records(key, unit);
        let new_refs = self.registry.refs_of(key).cloned();
        let new_parent = declaration.as_ref().and_then(|(_, p)| p.clone());
        // Old reference set absent while the old file does have records = the parse
        // cache was evicted and the old reference facts are unknown -> conservatively
        // Signature (prefer over-invalidating to under-reporting); the first ingestion
        // (no old records) is exempt.
        let refs_known = old_refs.is_some() || !had_old_records;
        let body_only = refs_known
            && new_records == old_records
            && new_parent == old_parent
            && new_refs == old_refs;
        if body_only {
            return (true, ChangeCategory::BodyOnly, registry_report.error, 0, 0);
        }
        let (added, removed) = self.replace_file_with_records(key, &new_records, declaration);
        (
            true,
            ChangeCategory::Signature,
            registry_report.error,
            added,
            removed,
        )
    }

    /// Delete/rename invalidation (VFS-012/IDX-014): cleans up symbols, the inverted
    /// index, reverse dependencies and inheritance edges in one sweep.
    /// Returns the number of removed symbols. Rename = remove(old) + update(new).
    pub fn remove(&mut self, key: &DocumentKey) -> usize {
        let removed = self.detach_file(key);
        self.registry.invalidate(key);
        if removed > 0 {
            self.stats.removals += 1;
            self.bump();
        }
        removed
    }

    /// Root-level scoped invalidation (IDX-015): touches only that root's files, never
    /// scanning the whole repo. Returns the number of removed symbols.
    pub fn invalidate_root(&mut self, root: RootId) -> usize {
        let keys: Vec<DocumentKey> = self
            .by_file
            .keys()
            .filter(|k| k.root == root)
            .cloned()
            .collect();
        let mut removed = 0usize;
        for key in &keys {
            removed += self.detach_file(key);
            self.registry.invalidate(key);
        }
        if removed > 0 {
            self.stats.removals += 1;
            self.bump();
        }
        removed
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// CORE-014 consistent snapshot read: captures the current generation and returns a
    /// read-only query view.
    ///
    /// While the snapshot lives, the `&mut` mutation paths (update/update_batch/
    /// remove/invalidate_root) are **rejected at compile time** by the borrow checker
    /// — a read/write inconsistency (definition and reference from different
    /// generations) is structurally impossible inside this core. Response-binding
    /// face: the wiring layer pins `generation()` onto the response and late-arriving
    /// stale results are detected via [`SymbolIndex::is_current`] and dropped
    /// (never published).
    pub fn read_snapshot(&self) -> IndexSnapshot<'_> {
        IndexSnapshot {
            index: self,
            generation: self.generation,
        }
    }

    /// Stale response detection: whether `generation` is still the current generation.
    /// Late-arriving results from an older generation (behind) must be dropped and must
    /// never overwrite the newer-generation view (ARCH-005).
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    /// Name-directed lookup (IDX-006; results sorted deterministically by name/kind/file/line).
    pub fn lookup(&self, name: &str) -> Vec<Symbol> {
        self.ids_of_name(name)
            .into_iter()
            .filter_map(|id| self.slots[id].clone())
            .collect()
    }

    /// Name + kind directed lookup.
    pub fn lookup_kind(&self, name: &str, kind: SymbolKind) -> Vec<Symbol> {
        self.ids_of_name(name)
            .into_iter()
            .filter_map(|id| self.slots[id].clone())
            .filter(|s| s.kind == kind)
            .collect()
    }

    /// Prefix scan (workspace symbol; an empty `prefix` means all; `limit` 0 means unlimited).
    /// Walks the BTreeMap ordered range instead of linearly scanning the total symbol count.
    pub fn workspace_symbols(&self, prefix: &str, limit: usize) -> Vec<Symbol> {
        let mut out = Vec::new();
        for (name, ids) in self.by_name.range(prefix.to_string()..) {
            if !name.starts_with(prefix) {
                break;
            }
            for id in ids {
                if let Some(sym) = self.slots[*id].as_ref() {
                    out.push(sym.clone());
                }
                if limit > 0 && out.len() >= limit {
                    out.sort();
                    return out;
                }
            }
        }
        out.sort();
        out
    }

    /// Symbols within a file (document order; the observation point of file-level increments).
    pub fn symbols_in_file(&self, key: &DocumentKey) -> Vec<Symbol> {
        self.by_file
            .get(key)
            .map(|entry| {
                entry
                    .symbols
                    .iter()
                    .filter_map(|id| self.slots[*id].clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reverse dependencies: which files reference the symbol `name` (type/Parent/
    /// component/interface/registration; reuses the parser RefSet, IDX-002 basic
    /// edition).
    pub fn dependents_of(&self, name: &str) -> Vec<DocumentKey> {
        self.registry.dependents_of(name)
    }

    /// Entity inheritance chain (IDX-005: cycles are explicitly diagnosed and truncated,
    /// terminating in finitely many steps). Inheritance edges are isolated per root
    /// (KODE-FULL-017): Parent edges for same-named entities in other roots do not
    /// participate in this root's chain resolution.
    pub fn entity_chain(&self, root: RootId, entity: &str) -> (Vec<ChainNode>, Option<Diagnostic>) {
        resolve_parent_chain(entity, &self.scoped_parents(root))
    }

    pub fn symbol_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }

    pub fn tracked_files(&self) -> usize {
        self.by_file.len()
    }

    /// Inventory of entities with registered inheritance edges (for observation/tests;
    /// isolated per root, KODE-FULL-017).
    pub fn entity_declarations_in(&self, root: RootId) -> HashMap<String, String> {
        self.scoped_parents(root)
    }

    /// Single-root inheritance edge view: name -> Parent (chain resolution and
    /// observation share the same isolation semantics).
    fn scoped_parents(&self, root: RootId) -> HashMap<String, String> {
        self.entity_parents
            .iter()
            .filter(|((r, _), _)| *r == root)
            .map(|((_, entity), parent)| (entity.clone(), parent.clone()))
            .collect()
    }

    // ---- internal: file-level differential replacement ----

    // (Since RUST-120-W the None arm goes straight to detach_file from
    //  ingest_classified; the old dispatch shell replace_file was removed.)

    /// Install already-extracted records (records/declaration were extracted by the
    /// classification path, so no second extraction pass is needed).
    fn replace_file_with_records(
        &mut self,
        key: &DocumentKey,
        records: &[SymbolRecord],
        declaration: Option<(String, Option<String>)>,
    ) -> (usize, usize) {
        let removed = self.detach_file(key);
        let added = records.len();
        let mut entry = FileEntry::default();
        for record in records {
            let id = self.attach_record(key, record.clone());
            entry.symbols.push(id);
        }
        if let Some((entity, Some(parent))) = declaration {
            self.entity_parents.insert((key.root, entity), parent);
        }
        self.by_file.insert(key.clone(), entry);
        (added, removed)
    }

    /// Detach all symbols of one file (differentially clears the inverted index, recycles
    /// slots). Returns the number detached.
    fn detach_file(&mut self, key: &DocumentKey) -> usize {
        let Some(entry) = self.by_file.remove(key) else {
            return 0;
        };
        for id in &entry.symbols {
            if let Some(sym) = self.slots[*id].take() {
                if let Some(set) = self.by_name.get_mut(&sym.name) {
                    set.remove(id);
                    if set.is_empty() {
                        self.by_name.remove(&sym.name);
                    }
                }
                self.free.push(*id);
            }
        }
        // Inheritance edges are detached along with the def file (rename/delete implies
        // invalidation, IDX-014); detach per (root, entity), so edges of same-named
        // entities in other roots are untouched (KODE-FULL-017).
        if file_kind_of_uri(&key.uri) == FileKind::Def {
            if let Some(entity) = crate::symbol::def_entity_name(key.uri.as_path()) {
                self.entity_parents.remove(&(key.root, entity));
            }
        }
        entry.symbols.len()
    }

    fn attach_record(&mut self, key: &DocumentKey, record: SymbolRecord) -> SymbolId {
        let id = match self.free.pop() {
            Some(id) => id,
            None => {
                self.slots.push(None);
                self.slots.len() - 1
            }
        };
        let name = record.name.clone();
        self.slots[id] = Some(Symbol {
            id,
            name,
            kind: record.kind,
            file: key.clone(),
            line: record.line,
            facet: record.facet,
            detail: record.detail,
        });
        self.by_name.entry(record.name).or_default().insert(id);
        id
    }

    fn bump(&mut self) {
        self.generation += 1;
        self.stats.generation_bumps += 1;
    }

    fn ids_of_name(&self, name: &str) -> Vec<SymbolId> {
        self.by_name
            .get(name)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }
}

/// CORE-014 consistent snapshot read view (see [`SymbolIndex::read_snapshot`]).
#[derive(Debug)]
pub struct IndexSnapshot<'a> {
    index: &'a SymbolIndex,
    generation: u64,
}

impl IndexSnapshot<'_> {
    /// The generation at capture time (the value used for response binding and staleness checks).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Name lookup (forwards to [`SymbolIndex::lookup`], the same deterministic ordering).
    pub fn lookup(&self, name: &str) -> Vec<Symbol> {
        self.index.lookup(name)
    }

    /// Name + kind directed lookup.
    pub fn lookup_kind(&self, name: &str, kind: SymbolKind) -> Vec<Symbol> {
        self.index.lookup_kind(name, kind)
    }

    /// Symbols within a file.
    pub fn symbols_in_file(&self, key: &DocumentKey) -> Vec<Symbol> {
        self.index.symbols_in_file(key)
    }

    /// Reverse affected set.
    pub fn dependents_of(&self, name: &str) -> Vec<DocumentKey> {
        self.index.dependents_of(name)
    }

    /// Total symbol count.
    pub fn symbol_count(&self) -> usize {
        self.index.symbol_count()
    }
}

#[cfg(test)]
mod tests {
    use kode_vfs::store::{DocumentKey, RootId};
    use kode_vfs::uri::CanonicalUri;

    use super::{ChangeCategory, SymbolIndex};
    use crate::symbol::SymbolKind;

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(RootId(1), CanonicalUri::from_path(path))
    }

    // ---- CORE-014 consistent snapshot read ----

    #[test]
    fn snapshot_captures_generation_and_queries_frozen_view() {
        let mut index = SymbolIndex::new();
        let text = "<root>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n    </hp>\n  </Properties>\n</root>\n";
        index.update(key("/proj/A.def"), text);
        index.update(key("/proj/B.def"), text);
        let gen = index.generation();
        {
            let snapshot = index.read_snapshot();
            assert_eq!(snapshot.generation(), gen, "快照钉住捕获时点代际");
            assert_eq!(snapshot.lookup("hp").len(), 2, "只读视图照常可查");
            assert_eq!(snapshot.symbol_count(), index.symbol_count());
            // Structural guarantee from the borrow checker: while the snapshot is
            // alive the &mut paths update/remove/update_batch/invalidate_root are
            // rejected at compile time (a read/write inconsistency is impossible
            // inside the core); the borrow ends when the scope does.
        }
        index.update(key("/proj/C.def"), text);
        // The captured generation is already stale: is_current recognises the older
        // generation, and late-arriving older-generation results must be dropped.
        assert!(!index.is_current(gen), "变更后旧代必须被判陈旧");
        assert!(index.is_current(index.generation()));
    }

    #[test]
    fn zero_rebuild_update_does_not_bump_generation() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), "<root>\n</root>\n");
        let gen = index.generation();
        // Same key, same text: fingerprint hit, zero rebuild, generation unchanged
        // (the established semantics for document changes).
        let report = index.update(k.clone(), "<root>\n</root>\n");
        assert!(!report.rebuilt);
        assert_eq!(index.generation(), gen, "零重建不 bump generation");
        assert!(index.is_current(gen));
    }

    #[test]
    fn stale_generation_rejects_late_results() {
        let mut index = SymbolIndex::new();
        index.update(key("/proj/A.def"), "<root>\n</root>\n");
        let pinned = index.generation();
        // Simulates the wiring layer pinning `pinned` on a response while the index
        // advances another generation in the meantime.
        index.update(key("/proj/B.def"), "<root>\n</root>\n");
        // A late response carrying `pinned`: judged stale -> the caller must drop it
        // and must not overwrite the newer-generation view.
        assert!(!index.is_current(pinned));
        assert_eq!(index.generation(), pinned + 1);
    }

    /// Detachment contract (the old replace_file(key, None) face): detaches only old
    /// symbols with zero additions, returning (added=0, removed=old symbol count),
    /// and cleans up the inverted index / inheritance edges / by_file in turn. The
    /// production paths update/update_batch only pass Some when the registry rebuilt,
    /// so this branch is verified against the function's own contract directly (unit
    /// level precision).
    #[test]
    fn replace_file_with_none_unit_only_detaches_old_symbols() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/entities/Avatar.def");
        let text = "<root>\n  <Parent>Base</Parent>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n      <Flags>BASE</Flags>\n    </hp>\n  </Properties>\n  <BaseMethods>\n    <onRpc>\n      <Arg>UINT32</Arg>\n    </onRpc>\n  </BaseMethods>\n</root>\n";
        let report = index.update(k.clone(), text);
        assert!(report.rebuilt);
        assert_eq!(index.symbol_count(), 3, "Avatar.def = 实体 + hp + onRpc");
        assert_eq!(
            index
                .entity_declarations_in(k.root)
                .get("Avatar")
                .map(String::as_str),
            Some("Base"),
            "带 Parent 的 def 先登记继承边"
        );

        let removed = index.detach_file(&k);
        assert_eq!(removed, 3, "摘除旧文件全部符号,零新增");
        assert_eq!(index.symbol_count(), 0);
        assert!(index.symbols_in_file(&k).is_empty(), "文件摘除后符号表清空");
        assert!(index.lookup("hp").is_empty(), "倒排连带清空");
        assert!(index.lookup("onRpc").is_empty());
        assert_eq!(index.tracked_files(), 0, "by_file 条目摘除");
        assert!(
            !index.entity_declarations_in(k.root).contains_key("Avatar"),
            ".def 继承边跟随摘除(IDX-014)"
        );
    }

    /// The two defensive arms of detach_file: under the public API "by_file entry ->
    /// slot always occupied, inverted index always contains the attached id" is an
    /// invariant (attach/detach maintain them in lockstep), so both arms only serve as
    /// a fallback when internal state has been corrupted — per the repo precedent
    /// (defensive arms are verified directly by constructing state inside the test),
    /// pinning "detachment does not panic and counts are returned faithfully".
    #[test]
    fn detach_file_defensive_arms_tolerate_broken_internal_state() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        assert_eq!(index.symbol_count(), 2, "实体 + hp");

        // Arm one: the inverted index lost the name (the slot is still there) —
        // detachment proceeds as usual and the count is faithful.
        assert!(index.by_name.remove("hp").is_some(), "先摘掉倒排键");
        assert_eq!(index.detach_file(&k), 2);
        assert!(index.lookup("hp").is_empty());

        // Arm two: the slot is dangling (the by_file entry is still present) —
        // detachment skips the dangling id.
        index.update(k.clone(), &def_with_property("UINT16"));
        let ids: Vec<usize> = index.symbols_in_file(&k).iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), 2);
        index.slots[ids[0]] = None;
        assert_eq!(
            index.detach_file(&k),
            2,
            "悬空槽位不 panic,计数按 by_file 条目如实"
        );
        assert_eq!(index.tracked_files(), 0, "by_file 条目摘除");

        // Detaching an unindexed key: the let-else early-returns with a zero count
        // (the remove contract face).
        assert_eq!(index.detach_file(&key("/proj/ghost.def")), 0);
        assert_eq!(index.remove(&key("/proj/ghost.def")), 0);
    }

    #[test]
    fn parse_budget_preserves_lookup_correctness() {
        // Budget of 1 byte: every product exceeds it, so insertion evicts immediately —
        // the query surface must stay intact under this most conservative shape.
        let mut index = SymbolIndex::with_parse_budget(1);
        let mut keys = Vec::new();
        for i in 0..5 {
            let k = DocumentKey::new(
                RootId(1),
                CanonicalUri::from_path(&format!("/w/entities/E{i}.def")),
            );
            keys.push(k.clone());
            index.update(k, "<root><Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties></root>");
        }
        // Everything evicted: the symbol table still holds each file's product (the
        // symbol layer is independent of the parse cache), and lookup works normally.
        let found = index.lookup("hp");
        assert_eq!(found.len(), 5, "符号层不受解析缓存驱逐影响");
        // Re-updating the evicted file: a rebuild (the parse-layer cache-loss face), and
        // symbol results are not duplicated.
        let report = index.update(
            keys[2].clone(),
            "<root><Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties></root>",
        );
        assert!(report.rebuilt, "被驱逐条目必须重建");
        let again = index.lookup("hp");
        assert_eq!(again.len(), 5, "重建后符号不重复");
    }

    // ---- access surface and pass-through delegation ----

    #[test]
    fn change_category_as_str_is_stable_golden_literal() {
        assert_eq!(ChangeCategory::Identical.as_str(), "identical");
        assert_eq!(ChangeCategory::BodyOnly.as_str(), "body-only");
        assert_eq!(ChangeCategory::Signature.as_str(), "signature");
    }

    #[test]
    fn parse_budget_bytes_passthrough_none_when_unbounded() {
        assert_eq!(SymbolIndex::new().parse_budget_bytes(), None);
        assert_eq!(
            SymbolIndex::with_parse_budget(4096).parse_budget_bytes(),
            Some(4096),
            "预算上限透传注册表观测面"
        );
    }

    #[test]
    fn negative_entries_list_non_declaration_files_sorted() {
        let mut index = SymbolIndex::new();
        let notes = key("/proj/notes.py");
        let readme = key("/proj/readme.txt");
        for k in [&notes, &readme] {
            let report = index.update(k.clone(), "hello\n");
            assert!(!report.rebuilt, "非声明文件零重建");
            assert!(report.error.is_some(), "原因回执");
            assert_eq!(report.change, ChangeCategory::Identical);
        }
        let entries = index.negative_entries();
        assert_eq!(entries.len(), 2);
        let keys: Vec<DocumentKey> = entries.iter().map(|(k, _)| k.clone()).collect();
        assert_eq!(keys, vec![notes, readme], "按 (root, 路径) 字典序");
        assert!(
            entries.iter().all(|(_, reason)| !reason.is_empty()),
            "负缓存原因透传"
        );
    }

    #[test]
    fn tracks_and_known_to_registry_cover_file_states() {
        let mut index = SymbolIndex::new();
        // A file with symbols: both faces accept it.
        let avatar = key("/proj/entities/Avatar.def");
        index.update(
            avatar.clone(),
            "<root>\n<Properties>\n<hp>\n<Type>UINT32</Type>\n</hp>\n</Properties>\n</root>\n",
        );
        assert!(index.tracks(&avatar));
        assert!(index.known_to_registry(&avatar));

        // A key never seen before: neither face accepts it.
        let ghost = key("/proj/Ghost.def");
        assert!(!index.tracks(&ghost));
        assert!(!index.known_to_registry(&ghost));

        // A non-declaration file: no by_file entry and no forward registration in the
        // registry, so neither face accepts it.
        let notes = key("/proj/notes.py");
        index.update(notes.clone(), "x = 1\n");
        assert!(!index.tracks(&notes));
        assert!(!index.known_to_registry(&notes));
    }

    #[test]
    fn snapshot_query_delegations_mirror_index_surface() {
        let mut index = SymbolIndex::new();
        let avatar = key("/proj/entities/Avatar.def");
        let monster = key("/proj/entities/Monster.def");
        index.update(
            avatar.clone(),
            "<root>\n<Parent>Base</Parent>\n<Properties>\n<hp>\n<Type>UINT32</Type>\n</hp>\n</Properties>\n</root>\n",
        );
        index.update(
            monster.clone(),
            "<root>\n<Parent>Avatar</Parent>\n</root>\n",
        );
        let snapshot = index.read_snapshot();
        // Name + kind directed lookup.
        let hp = snapshot.lookup_kind("hp", SymbolKind::Property);
        assert_eq!(hp.len(), 1);
        assert_eq!(hp[0].file, avatar);
        // Symbols within a file: Avatar = the entity body itself + hp (document order).
        let in_file = snapshot.symbols_in_file(&avatar);
        assert_eq!(in_file.len(), 2);
        assert_eq!(in_file[0].kind, SymbolKind::Entity);
        // Reverse affected set: Monster references Avatar via Parent.
        assert_eq!(snapshot.dependents_of("Avatar"), vec![monster]);
        // An unknown name: all three faces empty.
        assert!(snapshot
            .lookup_kind("ghost", SymbolKind::Property)
            .is_empty());
        assert!(snapshot.symbols_in_file(&key("/proj/ghost.def")).is_empty());
        assert!(snapshot.dependents_of("ghost").is_empty());
    }

    // ---- RUST-120-W change-classification differential invalidation ----

    fn def_with_property(dtype: &str) -> String {
        format!(
            "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> {dtype} </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n"
        )
    }

    #[test]
    fn parse_cache_stats_forward_budget_resident_and_evictions() {
        // Unbounded construction: budget None, resident always 0 (not tracked).
        let stats = SymbolIndex::new().parse_cache_stats();
        assert_eq!(stats.budget_bytes, None);
        assert_eq!(stats.resident_bytes, 0);
        assert_eq!(stats.evictions, 0);
        // Budgeted construction: the budget passes through; resident/valid grow after
        // ingestion.
        let mut index = SymbolIndex::with_parse_budget(4096);
        let stats = index.parse_cache_stats();
        assert_eq!(stats.budget_bytes, Some(4096));
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let stats = index.parse_cache_stats();
        assert!(stats.resident_bytes > 0, "入库后驻留权重必须增长");
        assert_eq!(stats.valid, 1);
        assert_eq!(stats.negative, 0);
        // A tiny budget: insertion evicts immediately (a single entry already exceeds
        // it), and the eviction count passes through; touching an invalid entry is a
        // no-op that does not panic.
        let mut tiny = SymbolIndex::with_parse_budget(1);
        tiny.update(key("/proj/T.def"), &def_with_property("UINT32"));
        assert!(tiny.parse_cache_stats().evictions >= 1);
        tiny.note_buffer_activity(&key("/proj/ghost.def"));
    }

    #[test]
    fn identical_text_reports_identical_and_keeps_generation() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let gen = index.generation();
        let report = index.update(k.clone(), &def_with_property("UINT32"));
        assert_eq!(report.change, ChangeCategory::Identical);
        assert!(!report.rebuilt);
        assert_eq!(index.generation(), gen, "指纹命中零失效");
        assert_eq!(index.stats.body_only_skips, 0);
    }

    #[test]
    fn body_only_trailing_comment_skips_bump_and_mutation() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let gen = index.generation();
        let records_before = index.symbols_in_file(&k).len();
        // The trailing comment shifts no captured element's line number: the model is
        // fully identical -> BodyOnly (zero index-state mutation).
        let body_only_text = format!(
            "{}<!-- trailing comment, model identical -->\n",
            def_with_property("UINT32")
        );
        let report = index.update(k.clone(), &body_only_text);
        assert_eq!(report.change, ChangeCategory::BodyOnly, "尾注 = body-only");
        assert!(report.rebuilt, "文本确实变了(重解析发生)");
        assert_eq!((report.added, report.removed), (0, 0), "索引态零变异");
        assert_eq!(index.generation(), gen, "body-only 不 bump,读者快照全存活");
        assert!(index.is_current(gen));
        assert_eq!(index.symbols_in_file(&k).len(), records_before);
        assert_eq!(index.stats.body_only_skips, 1);
    }

    #[test]
    fn property_type_change_is_signature_and_bumps() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let gen = index.generation();
        let report = index.update(k.clone(), &def_with_property("UINT64"));
        assert_eq!(report.change, ChangeCategory::Signature);
        assert_eq!(index.generation(), gen + 1, "签名变化才 bump");
        // The file-level entity symbol + the hp property = 2 records fully re-registered.
        assert_eq!((report.added, report.removed), (2, 2));
        let hp = index.lookup("hp");
        assert_eq!(hp.len(), 1);
        assert_eq!(hp[0].detail.as_deref(), Some("UINT64"), "新类型已入索引");
    }

    #[test]
    fn parent_change_is_signature_via_declaration_face() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/Boss.def");
        let v1 = "<root>\n\t<Parent> Monster </Parent>\n</root>\n";
        index.update(k.clone(), v1);
        assert_eq!(
            index
                .entity_declarations_in(k.root)
                .get("Boss")
                .map(String::as_str),
            Some("Monster")
        );
        let gen = index.generation();
        // The variant with a trailing note: records and the reference set are both
        // equal, only Parent changes -> the declaration face judges Signature.
        let v2 = "<root>\n\t<Parent> Dragon </Parent>\n</root>\n";
        let report = index.update(k.clone(), v2);
        assert_eq!(
            report.change,
            ChangeCategory::Signature,
            "Parent 变 = 签名事实变"
        );
        assert_eq!(index.generation(), gen + 1);
        assert_eq!(
            index
                .entity_declarations_in(k.root)
                .get("Boss")
                .map(String::as_str),
            Some("Dragon"),
            "继承边同步更新"
        );
    }

    #[test]
    fn interfaces_only_change_is_signature_via_reference_face() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/C.def");
        index.update(k.clone(), "<root>\n</root>\n");
        let gen = index.generation();
        // records (empty) and Parent (none) are both equal; only the interface_defs
        // reference changes -> the RefSet reference face judges Signature.
        let v2 = "<root>\n\t<Interfaces>\n\t\t<interface> BaseInterface </interface>\n\t</Interfaces>\n</root>\n";
        let report = index.update(k.clone(), v2);
        assert_eq!(
            report.change,
            ChangeCategory::Signature,
            "接口引用变 = 引用集变"
        );
        assert_eq!(index.generation(), gen + 1);
        let deps = index.dependents_of("BaseInterface");
        assert!(deps.contains(&k), "反向依赖面登记新引用");
    }

    #[test]
    fn evicted_parse_reparse_still_classifies_body_only() {
        // After the parse cache is evicted (tiny budget: a single entry exceeds it and
        // is evicted immediately, plus a second file squeezing it out), updating the same
        // text again: the fingerprint misses so a reparse happens, but the reference table
        // outlives the parse cache -> the old signature facts are still obtainable ->
        // judged BodyOnly, so reader snapshots are not falsely invalidated by the cache
        // eviction. (The "old reference set absent -> conservative Signature" guard in
        // ingest_classified is defense in depth — unreachable through the public API
        // today: the refs table is only cleaned up together with remove/invalidate_root,
        // and those two paths detach records at the same time.)
        let mut index = SymbolIndex::with_parse_budget(1);
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        // Squeeze-out: inserting B evicts A's parse cache (the symbol layer is unaffected).
        index.update(key("/proj/B.def"), &def_with_property("UINT16").repeat(20));
        let gen = index.generation();
        let rebuilds_before = index.stats.rebuilds;
        let report = index.update(k.clone(), &def_with_property("UINT32"));
        assert_eq!(report.change, ChangeCategory::BodyOnly, "重解析但事实全等");
        assert!(report.rebuilt, "驱逐后指纹未命中,重解析确实发生");
        assert_eq!(
            index.stats.rebuilds, rebuilds_before,
            "body-only 不计重登记(零索引态变异)"
        );
        assert_eq!(index.stats.body_only_skips, 1);
        assert_eq!(index.generation(), gen, "事实全等不失效读者");
    }

    #[test]
    fn batch_with_only_identical_and_body_only_never_bumps() {
        let mut index = SymbolIndex::new();
        let a = key("/proj/A.def");
        let b = key("/proj/B.def");
        index.update(a.clone(), &def_with_property("UINT32"));
        index.update(b.clone(), &def_with_property("UINT16"));
        let gen = index.generation();
        // Identical text (Identical) + a trailing note (BodyOnly): zero signature change
        // -> no bump.
        let body_only_b = format!("{}<!-- note -->\n", def_with_property("UINT16"));
        let receipt = index.update_batch(&[
            (a.clone(), def_with_property("UINT32")),
            (b.clone(), body_only_b),
        ]);
        assert_eq!(receipt.rebuilds, 0, "零 Signature 重登记");
        assert_eq!(receipt.body_only, 1, "BodyOnly 计入回执");
        assert_eq!(
            index.generation(),
            gen,
            "纯 Identical/BodyOnly 批不失效读者"
        );
    }

    #[test]
    fn batch_bumps_once_for_any_signature_change() {
        let mut index = SymbolIndex::new();
        let a = key("/proj/A.def");
        let b = key("/proj/B.def");
        index.update(a.clone(), &def_with_property("UINT32"));
        index.update(b.clone(), &def_with_property("UINT16"));
        let gen = index.generation();
        let receipt = index.update_batch(&[
            (a.clone(), def_with_property("UINT64")),
            (b.clone(), def_with_property("UINT16")),
        ]);
        assert_eq!(receipt.rebuilds, 1);
        assert_eq!(receipt.body_only, 0);
        assert_eq!(index.generation(), gen + 1, "整批一次 bump");
        assert_eq!(index.lookup("hp")[0].detail.as_deref(), Some("UINT64"));
    }
}
