//! Invalidation graph + batched-rebuild gate (PR-009: the SCHED-016/017 surface; book §17
//! PR-009 reverse DAG + the §7 IDX-002/006/013 baseline).
//!
//! Assertion semantics: changing one file → the affected set = itself + the reverse-dependent
//! files (via kode-index dependents_of), and batching cuts it deterministically; type-alias and
//! inheritance edges trigger reverse invalidation the same way.

use std::cell::RefCell;
use std::rc::Rc;

use kode_index::{DocumentKey, RootId, SymbolIndex};
use kode_scheduler::{plan_dependency_tasks, InvalidationGraph, TaskKind};
use kode_vfs::uri::CanonicalUri;

fn key(uri_path: &str) -> DocumentKey {
    DocumentKey::new(RootId(1), CanonicalUri::from_path(uri_path))
}

fn def_text(parent: Option<&str>, prop: &str, prop_type: &str) -> String {
    let mut s = String::from("<root>\n");
    if let Some(p) = parent {
        s.push_str(&format!("  <Parent>{p}</Parent>\n"));
    }
    s.push_str(&format!(
        "  <Properties>\n    <{prop}>\n      <Type>{prop_type}</Type>\n      <Flags>BASE</Flags>\n    </{prop}>\n  </Properties>\n</root>\n"
    ));
    s
}

/// Six-file workspace: Avatar (the base class) ← Monster (inheritance + a PARITY_LIST property
/// type).
fn indexed_workspace() -> SymbolIndex {
    let mut index = SymbolIndex::new();
    let files = vec![
        (key("/proj/entities/Avatar.def"), def_text(None, "hp", "UINT32")),
        (
            key("/proj/entities/Monster.def"),
            def_text(Some("Avatar"), "ferocity", "PARITY_LIST"),
        ),
        (key("/proj/entities.xml"), "<root>\n  <Avatar/>\n  <Monster/>\n</root>\n".to_string()),
        (key("/proj/types.xml"), "<root>\n  <JSONDATA>UINT32</JSONDATA>\n</root>\n".to_string()),
        (
            key("/proj/alias.xml"),
            "<root>\n  <PARITY_LIST>\n    <Type>ARRAY</Type>\n    <of>UINT32</of>\n  </PARITY_LIST>\n</root>\n".to_string(),
        ),
    ];
    index.update_batch(&files);
    index
}

#[test]
fn affected_set_includes_reverse_dependents_via_inheritance() {
    let index = indexed_workspace();
    let graph = InvalidationGraph::new(&index);
    let affected = graph.affected_by(&key("/proj/entities/Avatar.def"));
    let paths: Vec<String> = affected
        .iter()
        .map(|k| k.uri.as_path().to_string())
        .collect();
    // Itself + the inheriting Monster + the registry entities.xml all depend on the Avatar name.
    assert!(paths.contains(&"/proj/entities/Avatar.def".to_string()));
    assert!(paths.contains(&"/proj/entities/Monster.def".to_string()));
    assert!(paths.contains(&"/proj/entities.xml".to_string()));
    // Unrelated files are untouched (only the relevant nodes; the IDEX-013 semantics).
    assert!(!paths
        .iter()
        .any(|p| p.ends_with("types.xml") || p.ends_with("alias.xml")));
}

#[test]
fn affected_set_via_type_alias_dependency() {
    let index = indexed_workspace();
    let graph = InvalidationGraph::new(&index);
    // alias.xml declares PARITY_LIST; Monster's property type references it → reverse-affected.
    let affected = graph.affected_by(&key("/proj/alias.xml"));
    let paths: Vec<String> = affected
        .iter()
        .map(|k| k.uri.as_path().to_string())
        .collect();
    assert!(paths.contains(&"/proj/alias.xml".to_string()));
    assert!(paths.contains(&"/proj/entities/Monster.def".to_string()));
}

#[test]
fn rebuild_batches_are_deterministic_and_capped() {
    let index = indexed_workspace();
    let graph = InvalidationGraph::new(&index);
    let affected = graph.affected_by(&key("/proj/entities/Avatar.def"));
    let batches = graph.plan_rebuild_batches(&affected, 2);
    assert!(!batches.is_empty());
    assert!(batches.iter().all(|b| b.len() <= 2));
    // Determinism: the union of the batches = the affected set, and within a batch the keys are in
    // (root, path) ascending order.
    let mut seen: Vec<String> = batches
        .iter()
        .flatten()
        .map(|k| k.uri.as_path().to_string())
        .collect();
    let mut sorted = seen.clone();
    sorted.sort();
    assert_eq!(seen, sorted);
    seen.dedup();
    assert_eq!(seen.len(), affected.len());
}

#[test]
fn dependency_task_planning_labels_changed_file_and_batches() {
    let index = indexed_workspace();
    let graph = InvalidationGraph::new(&index);
    let changed = key("/proj/alias.xml");
    let exec: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let exec_for_run = exec.clone();
    let specs = plan_dependency_tasks(&graph, &changed, 0, 2, 1, move |batch| {
        let mut paths: Vec<String> = batch.iter().map(|k| k.uri.as_path().to_string()).collect();
        let sink = exec_for_run.clone();
        Box::new(move |_| {
            sink.borrow_mut().append(&mut paths);
            Ok(())
        })
    });
    // One batch per file: the changed file itself is a single-file-update, dependent files are
    // dependency-updates (the RUST-6 transitive closure: Monster + entities.xml are both
    // affected, 3 tasks in total).
    let mut kinds: Vec<(TaskKind, u8)> = specs
        .iter()
        .map(|s| {
            let _ = s.target;
            (s.kind, s.priority)
        })
        .collect();
    kinds.sort();
    let mut expected = vec![
        (TaskKind::SingleFileUpdate, 0),
        (TaskKind::DependencyUpdate, 2),
        (TaskKind::DependencyUpdate, 2),
    ];
    expected.sort();
    assert_eq!(kinds, expected);
    // Execution surface: each task body receives the file list of its batch.
    for spec in specs {
        (spec.run)(&kode_scheduler::CancelToken::new()).unwrap();
    }
    let executed = exec.borrow().clone();
    assert_eq!(executed.len(), 3);
}

// RUST-6: the affected_by transitive closure — A references B and B references C; after C
// changes, the affected set contains B **and A**.
#[test]
fn affected_set_propagates_transitive_chain() {
    let mut index = SymbolIndex::new();
    // C.def declares the name "C"; B.def has Parent=C (depends on C, declares "B"); A.def has
    // Parent=B (depends on B).
    index.update_batch(&[
        (key("/proj/chain/C.def"), def_text(None, "hc", "UINT32")),
        (
            key("/proj/chain/B.def"),
            def_text(Some("C"), "hb", "UINT32"),
        ),
        (
            key("/proj/chain/A.def"),
            def_text(Some("B"), "ha", "UINT32"),
        ),
    ]);
    let graph = InvalidationGraph::new(&index);
    let affected = graph.affected_by(&key("/proj/chain/C.def"));
    assert!(
        affected.contains(&key("/proj/chain/B.def")),
        "单级:B 必须入集"
    );
    assert!(
        affected.contains(&key("/proj/chain/A.def")),
        "闭包:A 必须经 B 传播入集"
    );
    assert!(affected.contains(&key("/proj/chain/C.def")));
}

// RUST-6: the cycle scenario A ⇄ B (call reverse-dependency) does not loop forever — it
// terminates in a finite number of steps with the right set.
#[test]
fn affected_set_terminates_on_dependency_cycle() {
    let index = SymbolIndex::new();
    let a = key("/proj/scripts/a.py");
    let b = key("/proj/scripts/b.py");
    let mut call: kode_scheduler::CallReverseIndex = Default::default();
    call.entry(a.clone()).or_default().insert(b.clone());
    call.entry(b.clone()).or_default().insert(a.clone());
    let graph = InvalidationGraph::with_call_dependents(&index, &call);
    let affected = graph.affected_by(&a); // The old implementation had no visited set and could not guarantee termination (guards against new iteration logic deadlooping); the new one is cut off by the visited set.
    assert_eq!(affected.len(), 2);
    assert!(affected.contains(&a) && affected.contains(&b));
}

// C-20 deliverable (3): the call reverse-dependency overlay enters the invalidation DAG — "change the callee's file → recompute the callers' files".
#[test]
fn affected_set_includes_call_dependents_overlay() {
    let index = indexed_workspace();
    let callee = key("/proj/scripts/combat.py");
    let caller = key("/proj/scripts/game.py");
    let mut call: kode_scheduler::CallReverseIndex = Default::default();
    call.entry(callee.clone())
        .or_default()
        .insert(caller.clone());

    // Without the overlay: only the callee itself.
    let plain = InvalidationGraph::new(&index);
    assert!(!plain.affected_by(&callee).contains(&caller));

    // With the overlay: the caller is included.
    let graph = InvalidationGraph::with_call_dependents(&index, &call);
    let affected = graph.affected_by(&callee);
    assert!(affected.contains(&caller));
    assert!(affected.contains(&callee));
}

// C-20 deliverable (3): multiple callers collapse into one entry + the callee itself is excluded
// (a call within the same file produces no cross-file entry).
#[test]
fn call_dependents_overlay_dedupes_and_skips_self() {
    let index = indexed_workspace();
    let callee = key("/proj/scripts/combat.py");
    let a = key("/proj/scripts/a.py");
    let b = key("/proj/scripts/b.py");
    let mut call: kode_scheduler::CallReverseIndex = Default::default();
    call.entry(callee.clone()).or_default().insert(a.clone());
    call.entry(callee.clone()).or_default().insert(b.clone());
    call.entry(callee.clone())
        .or_default()
        .insert(callee.clone());

    let graph = InvalidationGraph::with_call_dependents(&index, &call);
    let affected = graph.affected_by(&callee);
    assert!(affected.contains(&a));
    assert!(affected.contains(&b));
    // After the affected set is deduplicated, the callee itself appears exactly once.
    assert_eq!(affected.iter().filter(|k| **k == callee).count(), 1);
}

/// KR-AUD-23: the old plan_dependency_tasks implementation sorted the changed file together with
/// the dependents for chunking; when max_batch was large enough the changed file was mixed into a
/// dependent batch and the high priority of the SingleFileUpdate was lost.
/// Fix: the changed file is forced into its own batch, always SingleFileUpdate + changed_priority.
#[test]
fn changed_file_always_gets_own_single_file_batch_kraud23() {
    let index = indexed_workspace();
    let graph = InvalidationGraph::new(&index);
    let changed = key("/proj/alias.xml");
    let exec: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let exec_for_run = exec.clone();
    let specs = plan_dependency_tasks(&graph, &changed, 0, 2, 10, move |batch| {
        let mut paths: Vec<String> = batch.iter().map(|k| k.uri.as_path().to_string()).collect();
        let sink = exec_for_run.clone();
        Box::new(move |_| {
            sink.borrow_mut().append(&mut paths);
            Ok(())
        })
    });
    let single_count = specs
        .iter()
        .filter(|s| s.kind == TaskKind::SingleFileUpdate)
        .count();
    let single_priority = specs
        .iter()
        .find(|s| s.kind == TaskKind::SingleFileUpdate)
        .map(|s| s.priority);
    assert_eq!(single_count, 1, "changed 恒单独成批: {specs:?}");
    assert_eq!(single_priority, Some(0), "changed 批保持 changed_priority");
    // Execution surface: the changed file appears in exactly one batch.
    for spec in specs {
        (spec.run)(&kode_scheduler::CancelToken::new()).unwrap();
    }
    let executed = exec.borrow();
    assert_eq!(
        executed.iter().filter(|p| p.ends_with("alias.xml")).count(),
        1,
        "alias.xml 只在一个批出现"
    );
}
