//! 失效图 + 分批重建门禁(PR-009:SCHED-016/017 面;书 §17 PR-009 reverse DAG
//! + §7 IDX-002/006/013 基础版)。
//!
//! 断言口径:改一个文件 → 受影响集 = 自身 + 反向依赖文件(经 kode-index
//! dependents_of),分批确定性切块;类型别名/继承边同样触发反向失效。

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

/// 六文件工作区:Avatar(基类)← Monster(继承 + PARITY_LIST 属性类型)。
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
    // 自身 + 继承方 Monster + 注册表 entities.xml 都依赖 Avatar 名字。
    assert!(paths.contains(&"/proj/entities/Avatar.def".to_string()));
    assert!(paths.contains(&"/proj/entities/Monster.def".to_string()));
    assert!(paths.contains(&"/proj/entities.xml".to_string()));
    // 不相关文件不受影响(仅相关节点,IDEX-013 口径)。
    assert!(!paths
        .iter()
        .any(|p| p.ends_with("types.xml") || p.ends_with("alias.xml")));
}

#[test]
fn affected_set_via_type_alias_dependency() {
    let index = indexed_workspace();
    let graph = InvalidationGraph::new(&index);
    // alias.xml 声明 PARITY_LIST;Monster 的属性类型引用它 → 反向受影响。
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
    // 确定性:两批并集 = 受影响集,且批内按 (root, 路径) 升序。
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
    // 每文件一批:变更文件本身 single-file-update,依赖文件 dependency-update。
    let mut kinds: Vec<(TaskKind, u8)> = specs
        .iter()
        .map(|s| {
            let _ = s.target;
            (s.kind, s.priority)
        })
        .collect();
    kinds.sort();
    assert_eq!(
        kinds,
        vec![
            (TaskKind::SingleFileUpdate, 0),
            (TaskKind::DependencyUpdate, 2),
        ]
    );
    // 执行面:任务体拿到各自批的文件清单。
    for spec in specs {
        (spec.run)(&kode_scheduler::CancelToken::new()).unwrap();
    }
    let executed = exec.borrow().clone();
    assert_eq!(executed.len(), 2);
}
