//! Invalidation graph + batched rebuild planning (book §17 PR-009 "reverse DAG" + §7
//! IDX-002/006/013 surfaces).
//!
//! - Invalidation graph: file → declared names (entity / type / alias / attribute / method /
//!   component) → reverse affected-file set (reusing kode-index's name inverted index and reverse
//!   dependency index; no graph is built twice);
//! - Batched rebuild: the affected set is deterministically sorted and then chunked by the cap,
//!   one `dependency-update` task per batch (priority inherited from the changed-file surface),
//!   the whole batch going through [`crate::Scheduler`]'s batch/merge surface.

use std::collections::{BTreeMap, BTreeSet};

use kode_index::{DocumentKey, SymbolIndex};

use crate::model::{priority, TaskKind};
use crate::scheduler::{RunFn, TaskSpec};

/// Cross-file call reverse dependencies: callee file → set of caller files.
///
/// Produced by kode-python's [`kode_python::graph::build_call_reverse_index`] and fed into the
/// invalidation DAG via [`InvalidationGraph::with_call_dependents`], so that "changing the callee
/// file → recompute the caller files". This crate stays free of third-party and language coupling:
/// it only consumes the generic `BTreeMap` and does not depend on kode-python (the call-graph
/// surface lives in the language integration layer).
pub type CallReverseIndex = BTreeMap<DocumentKey, BTreeSet<DocumentKey>>;

/// Reverse invalidation view over the symbol index (read-only; the graph is a projection of the
/// index and copies no data).
///
/// Optionally carries a call reverse-dependency overlay (C-20 deliverable 3: the Python call
/// graph enters the DAG).
#[derive(Debug, Clone, Copy)]
pub struct InvalidationGraph<'a> {
    index: &'a SymbolIndex,
    call_dependents: Option<&'a CallReverseIndex>,
}

impl<'a> InvalidationGraph<'a> {
    pub fn new(index: &'a SymbolIndex) -> InvalidationGraph<'a> {
        InvalidationGraph {
            index,
            call_dependents: None,
        }
    }

    /// Invalidation graph with call reverse dependencies (name inverted index + reverse
    /// projection of call edges).
    pub fn with_call_dependents(
        index: &'a SymbolIndex,
        call_dependents: &'a CallReverseIndex,
    ) -> InvalidationGraph<'a> {
        InvalidationGraph {
            index,
            call_dependents: Some(call_dependents),
        }
    }

    /// Names declared by this file (deduplicated, ascending; entity / attribute / method / type /
    /// alias / component).
    pub fn declared_names(&self, key: &DocumentKey) -> Vec<String> {
        let mut names: Vec<String> = self
            .index
            .symbols_in_file(key)
            .into_iter()
            .map(|s| s.name)
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// Transitive-closure affected set of changing this file = itself ∪ ⋃(files depending on its
    /// declared names) ∪ ⋃(files calling its defined methods), and propagation continues along
    /// reverse edges to a fixed point: when A calls B and B calls C, changing C pulls A into the
    /// set too (otherwise A's index / call graph stays stale).
    /// Cycle protection: the visited set guarantees an already-processed file never re-enters, so
    /// termination is finite.
    /// Determinism: DocumentKey carries Ord, the result is a sorted set, and duplicate
    /// dependencies fold automatically.
    pub fn affected_by(&self, key: &DocumentKey) -> BTreeSet<DocumentKey> {
        let mut affected: BTreeSet<DocumentKey> = BTreeSet::new();
        affected.insert(key.clone());
        let mut processed: BTreeSet<DocumentKey> = BTreeSet::new();
        let mut frontier: Vec<DocumentKey> = vec![key.clone()];
        while let Some(current) = frontier.pop() {
            if !processed.insert(current.clone()) {
                continue; // Already expanded (cycle / duplicate edge): no re-entry, finite
                          // termination.
            }
            for name in self.declared_names(&current) {
                for dependent in self.index.dependents_of(&name) {
                    if affected.insert(dependent.clone()) {
                        frontier.push(dependent);
                    }
                }
            }
            if let Some(call) = self.call_dependents {
                if let Some(dependents) = call.get(&current) {
                    for dependent in dependents {
                        if affected.insert(dependent.clone()) {
                            frontier.push(dependent.clone());
                        }
                    }
                }
            }
        }
        affected
    }

    /// Chunk the affected set (deterministic: sorted by (root_id, path) ascending before
    /// chunking).
    pub fn plan_rebuild_batches(
        &self,
        affected: &BTreeSet<DocumentKey>,
        max_batch: usize,
    ) -> Vec<Vec<DocumentKey>> {
        plan_batches(affected, max_batch)
    }
}

/// Chunk the affected set (a standalone function, also reused by the batch-commit surface).
pub fn plan_batches(affected: &BTreeSet<DocumentKey>, max_batch: usize) -> Vec<Vec<DocumentKey>> {
    let max_batch = max_batch.max(1);
    let mut ordered: Vec<&DocumentKey> = {
        let mut keys: Vec<&DocumentKey> = affected.iter().collect();
        keys.sort_by_key(|k| (k.root.0, k.uri.as_path().to_string()));
        keys
    };
    let mut batches = Vec::new();
    while !ordered.is_empty() {
        let take = ordered.len().min(max_batch);
        let batch: Vec<DocumentKey> = ordered.drain(..take).cloned().collect();
        batches.push(batch);
    }
    batches
}

/// Turn one file change into scheduling tasks: one `single-file-update` for the changed file
/// itself, and `dependency-update` tasks for the affected dependents, split by batch
/// (priority = the dependency-update surface).
/// `make_run` supplies the rebuild closure from the caller (this crate does not bind a concrete
/// index implementation).
pub fn plan_dependency_tasks<F>(
    graph: &InvalidationGraph<'_>,
    changed: &DocumentKey,
    changed_priority: u8,
    dep_priority: u8,
    max_batch: usize,
    mut make_run: F,
) -> Vec<TaskSpec>
where
    F: FnMut(Vec<DocumentKey>) -> Box<RunFn>,
{
    let mut specs: Vec<TaskSpec> = Vec::new();
    let mut affected = graph.affected_by(changed);
    // KR-AUD-23: changed is forced into its own batch — the old implementation mixed changed
    // into the affected set and chunked them together, so with a large enough max_batch, changed
    // shared a batch with its dependents and the SingleFileUpdate high priority was lost (the
    // whole batch downgraded to DependencyUpdate). Pick changed out and send it alone first,
    // then chunk the remainder.
    affected.remove(changed);
    specs.push(TaskSpec {
        kind: TaskKind::SingleFileUpdate,
        priority: changed_priority.min(priority::NON_INTERACTIVE),
        file: None,
        version: None,
        target: Some("batch:1:1".to_string()),
        run: make_run(vec![changed.clone()]),
    });
    let batches = plan_batches(&affected, max_batch);
    for (i, batch) in batches.into_iter().enumerate() {
        let (kind, prio) = (TaskKind::DependencyUpdate, dep_priority);
        let target = Some(format!("batch:{}:{}", i + 2, batch.len()));
        specs.push(TaskSpec {
            kind,
            priority: prio.min(priority::NON_INTERACTIVE),
            file: None,
            version: None,
            target,
            run: make_run(batch),
        });
    }
    specs
}
