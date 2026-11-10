//! Knowledge index orchestration (KODE-MCP-KB-002 P2): Tantivy BM25, SQLite,
//! notify incremental updates, BLAKE3 content addressing, git-state awareness,
//! and unified `search` routing (design doc §6/§8/§9).
//!
//! Routing (design doc §8): exact symbols / types / config keys hit the
//! structure index (SQLite name lookup) with no BM25 scan; term queries hit
//! the BM25 inverted index (Tantivy); natural-language queries would consult
//! the pluggable vector module (P3, deferred) — a [`SemanticRetriever`] seam
//! is left in place and honestly reports "not configured" when unset.
//!
//! Incremental updates (design doc §9): a notify watcher marks touched files
//! (visible via `dirtyPending`), and each reconcile runs a bounded BLAKE3
//! hash sweep — unchanged files are skipped (content-addressed dedup), and
//! git-ignored/generated paths are never indexed (batch `git check-ignore`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::Watcher;
use serde_json::{json, Value};

use crate::extract;
use crate::fts::FtsIndex;
use crate::git_state;
use crate::kb::AssetKnowledge;
use crate::nodes::{content_hash, IndexNode, Reference};
use crate::store::KbStore;

/// Noise directories never indexed (design doc §9 read-only index).
const SKIP_COMMON: &[&str] = &[
    "target",
    "node_modules",
    ".git",
    ".kbengine",
    ".vscode-test",
    "dist",
    "out",
    "build",
    "vendor",
    "third_party",
];

/// P3 seam: pluggable vector semantic retrieval. Not built in P2; a caller
/// may register one and NL queries will fuse its results with BM25.
pub trait SemanticRetriever: Send + Sync + std::fmt::Debug {
    fn name(&self) -> &'static str;
    fn retrieve(&self, query: &str, limit: usize) -> Result<Vec<(String, f32)>, String>;
}

/// Which retrieval route to take.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Route {
    #[default]
    Auto,
    Exact,
    Bm25,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub format: Option<String>,
    pub kind: Option<String>,
    pub limit: usize,
    pub route: Route,
}

/// Result of one reconcile sweep (index_status face).
#[derive(Debug, Clone, Default)]
pub struct ReconcileStats {
    pub files_scanned: usize,
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub ignored_by_git: usize,
    pub git_available: bool,
    pub extract_errors: usize,
    pub errors: Vec<String>,
    pub elapsed_ms: u128,
}

impl ReconcileStats {
    fn to_value(&self) -> Value {
        json!({
            "filesScanned": self.files_scanned,
            "added": self.added,
            "changed": self.changed,
            "removed": self.removed,
            "unchanged": self.unchanged,
            "ignoredByGit": self.ignored_by_git,
            "gitAvailable": self.git_available,
            "extractErrors": self.extract_errors,
            "errors": self.errors,
            "elapsedMs": self.elapsed_ms,
        })
    }
}

/// A single BLAKE3-content-addressed file in the index.
#[derive(Debug, Clone)]
struct FileEntry {
    rel_path: String,
    abs_path: PathBuf,
    blake3: String,
    ext: String,
}

/// The index: SQLite structure store + Tantivy BM25 + notify watcher.
pub struct KnowledgeIndex {
    root: PathBuf,
    project: String,
    store: KbStore,
    fts: FtsIndex,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    dirty: Arc<Mutex<HashSet<String>>>,
    last_stats: Mutex<ReconcileStats>,
    vector: Mutex<Option<Arc<dyn SemanticRetriever>>>,
}

impl std::fmt::Debug for KnowledgeIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KnowledgeIndex")
            .field("root", &self.root)
            .field("project", &self.project)
            .field("store", &self.store)
            .field("fts", &self.fts)
            .finish_non_exhaustive()
    }
}

fn is_skip_component(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| SKIP_COMMON.contains(&s))
            .unwrap_or(false)
    })
}

impl KnowledgeIndex {
    /// Open the index over `root`. Persistent state lives in the system temp
    /// dir (keyed by the canonical root), keeping the user's tree clean; the
    /// directory is per-process to avoid cross-process SQLite contention when
    /// several MCP servers index the same root concurrently.
    pub fn open(root: &Path) -> Result<KnowledgeIndex, String> {
        let base = std::env::temp_dir().join("kode-mcp-kb-index");
        let dir = base.join(format!(
            "{}-{}",
            crate::nodes::root_key(root),
            std::process::id()
        ));
        Self::open_at(root, &dir)
    }

    /// Open at an explicit directory (unit/integration tests control it).
    pub fn open_at(root: &Path, dir: &Path) -> Result<KnowledgeIndex, String> {
        let store = KbStore::open(&dir.join("kb.sqlite")).or_else(|e| {
            // Read-only tree or unwritable temp: degrade to memory, honestly.
            KbStore::in_memory().map_err(|m| format!("{e}; memory fallback also failed: {m}"))
        })?;
        let fts = FtsIndex::open(&dir.join("tantivy"))?;
        let project = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .to_string();
        Ok(KnowledgeIndex {
            root: root.to_path_buf(),
            project,
            store,
            fts,
            watcher: Mutex::new(None),
            dirty: Arc::new(Mutex::new(HashSet::new())),
            last_stats: Mutex::new(ReconcileStats::default()),
            vector: Mutex::new(None),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Register a P3 vector retriever (fused on NL queries).
    pub fn set_vector_retriever(&self, retriever: Arc<dyn SemanticRetriever>) {
        *self.vector.lock().expect("vector lock") = Some(retriever);
    }

    /// Files that will be considered by the sweep, in deterministic order,
    /// with the extension group they belong to.
    fn scan_files(&self) -> Vec<FileEntry> {
        let root = &self.root;
        let mut paths: Vec<(PathBuf, String)> = Vec::new();
        let mut push_scan = |exts: &[&str], roots: &[PathBuf]| {
            for ext in exts {
                let scan = crate::bounded_scan::collect(roots, ext, SKIP_COMMON, 5000);
                for p in scan.files {
                    paths.push((p, ext.to_string()));
                }
            }
        };
        push_scan(&["md"], std::slice::from_ref(root));
        push_scan(&["py"], &[root.join("scripts")]);
        push_scan(
            &["xlsx", "xlsm", "xls", "ods", "xlsb"],
            std::slice::from_ref(root),
        );
        // def/xml under scripts (def files + types/alias/entities xml).
        push_scan(&["def", "xml"], &[root.join("scripts")]);
        // Deterministic order + dedup (a file matches one extension).
        paths.sort();
        paths.dedup();
        let mut out = Vec::new();
        for (abs, ext) in paths {
            let meta = match std::fs::metadata(&abs) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() || meta.len() > 1_000_000 {
                continue;
            }
            let bytes = match std::fs::read(&abs) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let rel = crate::nodes::rel_path(root, &abs);
            out.push(FileEntry {
                rel_path: rel,
                abs_path: abs,
                blake3: content_hash(&bytes),
                ext,
            });
        }
        out
    }

    /// Full incremental sweep: BLAKE3 diff + per-file re-extraction. Files
    /// git-ignored are never indexed. Content-addressed dedup skips
    /// unchanged files. def/xml nodes come from a freshly parsed model,
    /// loaded here so the sweep always sees the on-disk truth.
    pub fn reconcile(&self) -> ReconcileStats {
        let started = std::time::Instant::now();
        let entries = self.scan_files();
        let disk: HashSet<String> = entries.iter().map(|e| e.rel_path.clone()).collect();
        let stored = self.store.file_hashes();
        let mut stats = ReconcileStats {
            files_scanned: entries.len(),
            ..Default::default()
        };

        // Git ignore state: batch check-ignore over all candidates.
        let cands: Vec<PathBuf> = entries.iter().map(|e| e.abs_path.clone()).collect();
        let git = git_state::probe(&self.root, &cands);
        stats.git_available = git.available;
        stats.ignored_by_git = git.ignored.len();

        let mut changed_files: Vec<FileEntry> = Vec::new();
        let mut to_remove: Vec<String> = Vec::new();

        for e in &entries {
            if git.available && git.ignored.contains(&e.rel_path) {
                continue; // never index gitignored/generated paths
            }
            match stored.get(&e.rel_path) {
                Some(hash) if hash == &e.blake3 => stats.unchanged += 1,
                Some(_) => {
                    stats.changed += 1;
                    changed_files.push(e.clone());
                }
                None => {
                    stats.added += 1;
                    changed_files.push(e.clone());
                }
            }
        }
        for path in stored.keys() {
            if !disk.contains(path) {
                stats.removed += 1;
                to_remove.push(path.clone());
            }
        }

        // Removals first (frees ids before re-insert).
        for path in &to_remove {
            let _ = self.store.remove_file(path);
            let _ = self.fts.remove_file(path);
        }

        // Re-extract changed files. Python/markdown/excel are per-file;
        // def/xml come from the freshly parsed model.
        let mut changed_rel: HashSet<String> =
            changed_files.iter().map(|e| e.rel_path.clone()).collect();
        for e in &changed_files {
            let ext = e.ext.as_str();
            if matches!(ext, "md" | "py" | "xlsx" | "xlsm" | "xls" | "ods" | "xlsb") {
                match extract::extract_file(&self.project, &self.root, &e.abs_path) {
                    Ok(nodes) => {
                        let _ = self.store.replace_file_nodes(&e.rel_path, &nodes);
                        if let Err(err) = self.fts.replace_file(&e.rel_path, &nodes) {
                            stats.extract_errors += 1;
                            stats.errors.push(format!("{}: {err}", e.rel_path));
                        }
                        let _ = self.store.set_file(&e.rel_path, &e.blake3);
                    }
                    Err(err) => {
                        stats.extract_errors += 1;
                        stats.errors.push(err);
                        // Keep the old nodes on a failed re-extract rather
                        // than silently dropping them (visible in errors).
                        let _ = self.store.set_file(&e.rel_path, &e.blake3);
                    }
                }
                changed_rel.remove(&e.rel_path);
            }
        }

        // def/xml changed (or any def/xml removal): rebuild model-backed nodes.
        let def_xml_dirty = changed_rel
            .iter()
            .any(|p| p.ends_with(".def") || p.ends_with(".xml"));
        if def_xml_dirty || !to_remove.is_empty() {
            let kb = AssetKnowledge::load(&self.root);
            let model_nodes = extract::def_xml_nodes(&kb, &self.project);
            let mut by_file: HashMap<String, Vec<IndexNode>> = HashMap::new();
            for n in &model_nodes {
                by_file
                    .entry(n.file_path.clone())
                    .or_default()
                    .push(n.clone());
            }
            // Replace every model-backed file currently present on disk.
            let model_files: Vec<String> = disk
                .iter()
                .filter(|p| p.ends_with(".def") || p.ends_with(".xml"))
                .cloned()
                .collect();
            for rel in &model_files {
                let nodes = by_file.remove(rel).unwrap_or_default();
                let _ = self.store.replace_file_nodes(rel, &nodes);
                if let Err(err) = self.fts.replace_file(rel, &nodes) {
                    stats.extract_errors += 1;
                    stats.errors.push(format!("{rel}: {err}"));
                }
            }
            // Rebuild edges from the fresh model (P1 rules, persisted).
            let py = crate::code_index::collect_symbols(&self.root);
            let edges = self.semantic_edges(&kb, &py);
            let _ = self.store.replace_edges(&edges);
            // Update hashes for all model-backed files (they were "changed").
            for e in &entries {
                if e.rel_path.ends_with(".def") || e.rel_path.ends_with(".xml") {
                    let _ = self.store.set_file(&e.rel_path, &e.blake3);
                }
            }
        }

        // Config catalog nodes: indexed once, never from disk.
        self.ensure_catalog_nodes();

        // Clear the watcher dirty set (already folded into the sweep).
        self.dirty.lock().expect("dirty lock").clear();
        stats.elapsed_ms = started.elapsed().as_millis();
        *self.last_stats.lock().expect("stats lock") = stats.clone();
        stats
    }

    /// Build (full sweep) from a fresh model load; used at server start.
    pub fn build(&self) -> ReconcileStats {
        self.reconcile()
    }

    fn ensure_catalog_nodes(&self) {
        let rel = "catalog/server-config";
        // Present already (persisted from a previous run / build).
        if !self.store.exact_lookup("baseapp.archivePeriod").is_empty() {
            return;
        }
        let nodes = extract::config_catalog_nodes();
        if nodes.is_empty() {
            return;
        }
        let _ = self.store.replace_file_nodes(rel, &nodes);
        if let Err(e) = self.fts.replace_file(rel, &nodes) {
            if let Ok(mut stats) = self.last_stats.lock() {
                stats.extract_errors += 1;
                stats.errors.push(format!("catalog: {e}"));
            }
        }
    }

    fn semantic_edges(
        &self,
        kb: &AssetKnowledge,
        py: &[crate::code_index::PySymbol],
    ) -> Vec<Reference> {
        crate::semantic_model::semantic_edge_rows(kb, py, &self.root)
            .into_iter()
            .map(|r| crate::store::semantic_edge(&r.from, &r.to, r.relation, r.rule, r.confidence))
            .collect()
    }

    /// Start the notify watcher over the root (recursive, noise-filtered).
    /// Failure is reported (some environments lack inotify) but never fatal:
    /// the BLAKE3 sweep keeps the index correct without events.
    pub fn start_watch(&self) -> Result<(), String> {
        if self.watcher.lock().expect("watcher lock").is_some() {
            return Ok(()); // already watching
        }
        let root = self.root.clone();
        let dirty = self.dirty.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for path in &event.paths {
                    if path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(extract::is_indexable_ext)
                        .unwrap_or(false)
                        && !is_skip_component(path)
                    {
                        let rel = crate::nodes::rel_path(&root, path);
                        dirty.lock().expect("dirty lock").insert(rel);
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
        watcher
            .watch(&self.root, notify::RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        *self.watcher.lock().expect("watcher lock") = Some(watcher);
        Ok(())
    }

    pub fn watcher_active(&self) -> bool {
        self.watcher.lock().expect("watcher lock").is_some()
    }

    pub fn dirty_pending(&self) -> usize {
        self.dirty.lock().expect("dirty lock").len()
    }

    /// Unified search: routes exact → structure index, term → BM25, and
    /// returns deterministic ranked results (design doc §8).
    pub fn search(&self, query: &str, opts: &SearchOptions) -> Result<Value, String> {
        let q = query.trim();
        if q.is_empty() {
            return Err("empty search query".to_string());
        }
        let limit = opts.limit.clamp(1, 500);
        let is_identifier = !q.contains(char::is_whitespace);
        let route = match opts.route {
            Route::Exact => Route::Exact,
            Route::Bm25 => Route::Bm25,
            Route::Auto => {
                if is_identifier && !self.store.exact_lookup(q).is_empty() {
                    Route::Exact
                } else {
                    Route::Bm25
                }
            }
        };

        let format_filter = opts.format.as_deref().map(str::to_lowercase);
        let kind_filter = opts.kind.as_deref().map(str::to_lowercase);

        let mut rows: Vec<Value> = Vec::new();
        let mut scores: Vec<f32> = Vec::new();
        let mut sort_keys: Vec<(u32, String, String)> = Vec::new();

        if route == Route::Exact {
            for node in self.store.exact_lookup(q) {
                if !matches_filter(&node, format_filter.as_deref(), kind_filter.as_deref()) {
                    continue;
                }
                sort_keys.push((node.kind.rank(), node.file_path.clone(), node.name.clone()));
                rows.push(node_row(&node, None));
                scores.push(0.0);
                if rows.len() >= limit {
                    break;
                }
            }
        } else {
            let hits = self.fts.search(q, limit * 4)?;
            let mut by_id: HashMap<String, f32> = HashMap::new();
            for (id, score) in hits {
                by_id.insert(id, score);
            }
            let mut nodes: Vec<IndexNode> = Vec::new();
            for id in by_id.keys() {
                if let Some(node) = self.store.node_by_id(id) {
                    if !matches_filter(&node, format_filter.as_deref(), kind_filter.as_deref()) {
                        continue;
                    }
                    nodes.push(node);
                }
            }
            // Deterministic: score desc, kind rank, file, name.
            nodes.sort_by(|a, b| {
                let sa = by_id.get(&a.id).copied().unwrap_or(0.0);
                let sb = by_id.get(&b.id).copied().unwrap_or(0.0);
                sb.partial_cmp(&sa)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.kind.rank().cmp(&b.kind.rank()))
                    .then(a.file_path.cmp(&b.file_path))
                    .then(a.name.cmp(&b.name))
            });
            for node in nodes.into_iter().take(limit) {
                let score = by_id.get(&node.id).copied().unwrap_or(0.0);
                sort_keys.push((node.kind.rank(), node.file_path.clone(), node.name.clone()));
                rows.push(node_row(&node, Some(score)));
                scores.push(score);
            }
        }
        let route_str = if route == Route::Exact {
            "exact"
        } else {
            "bm25"
        };

        // Natural-language / fuzzy → vector seam (P3, deferred).
        let vector_info = if looks_natural_language(q) {
            let retriever = self.vector.lock().expect("vector lock").clone();
            match retriever {
                Some(r) => {
                    let mut merged = rows.len();
                    if let Ok(hits) = r.retrieve(q, limit) {
                        for (id, score) in hits {
                            if merged >= limit {
                                break;
                            }
                            if let Some(node) = self.store.node_by_id(&id) {
                                rows.push(node_row(&node, Some(score)));
                                sort_keys.push((node.kind.rank(), node.file_path, node.name));
                                merged += 1;
                            }
                        }
                    }
                    json!({ "configured": true, "engine": r.name() })
                }
                None => json!({ "configured": false, "deferred": "P3 pluggable module not built" }),
            }
        } else {
            Value::Null
        };

        let _ = sort_keys;
        Ok(json!({
            "query": q,
            "route": route_str,
            "count": rows.len(),
            "matches": rows,
            "vector": vector_info,
            "deterministic": true,
        }))
    }

    /// index_status storage face (merged by the server into the P1 status).
    pub fn status(&self) -> Value {
        let (nodes, edges, by_format) = self.store.stats();
        let stats = self.last_stats.lock().expect("stats lock").clone();
        json!({
            "nodes": nodes,
            "edges": edges,
            "byFormat": by_format,
            "ftsDocs": self.fts.doc_count(),
            "storageMode": self.store.mode,
            "storagePath": self.store.path.to_string_lossy(),
            "watcherActive": self.watcher_active(),
            "dirtyPending": self.dirty_pending(),
            "gitAvailable": stats.git_available,
            "gitIgnoredLast": stats.ignored_by_git,
            "contentAddressingIntact": self.store.content_addressing_intact(),
            "lastReconcile": stats.to_value(),
        })
    }

    /// Storage handle for direct tests (BLAKE3 addressing, reopen).
    pub fn store(&self) -> &KbStore {
        &self.store
    }

    /// FTS handle for direct tests.
    pub fn fts(&self) -> &FtsIndex {
        &self.fts
    }
}

fn matches_filter(node: &IndexNode, format: Option<&str>, kind: Option<&str>) -> bool {
    if let Some(f) = format {
        if node.kind.format() != f {
            return false;
        }
    }
    if let Some(k) = kind {
        if node.kind.as_str() != k {
            return false;
        }
    }
    true
}

fn node_row(node: &IndexNode, score: Option<f32>) -> Value {
    let mut row = json!({
        "id": node.id,
        "kind": node.kind.as_str(),
        "format": node.kind.format(),
        "name": node.name,
        "file": node.file_path,
        "location": node.location.display(),
        "confidence": node.confidence.as_str(),
        "snippet": node.content.chars().take(200).collect::<String>(),
    });
    if let Some(score) = score {
        row["score"] = json!(score);
    }
    row
}

/// Heuristic natural-language shape (spaces + several words, or CJK phrases
/// with spaces). Only used to decide whether to consult the vector seam.
fn looks_natural_language(q: &str) -> bool {
    let has_space = q.contains(char::is_whitespace);
    if !has_space {
        return false;
    }
    let words = q.split_whitespace().count();
    let has_cjk = q.chars().any(|c| (0x4E00..=0x9FFF).contains(&(c as u32)));
    words >= 2 && (has_cjk || words >= 4)
}
