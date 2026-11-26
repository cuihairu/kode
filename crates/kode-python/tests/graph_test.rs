//! Call graph aggregation + kode-scheduler reverse index tests (C-20 deliverable 3).

use std::collections::BTreeMap;

use kode_python::callgraph::extract_call_graph;
use kode_python::graph::{build_call_reverse_index, uncertain_cross_process_files, PyCallGraph};
use kode_python::{parse_ast_symbols, ParsedAst};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

fn key(path: &str) -> DocumentKey {
    DocumentKey::new(RootId(0), CanonicalUri::from_path(path))
}

/// Multiple files -> cross-file reverse index (test fixture: parse each file's symbol table + call edges, then aggregate).
fn build_rev(files: &[(&DocumentKey, &str)]) -> kode_python::graph::CallReverseIndex {
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in files {
        let ast = ParsedAst::new(*src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert((*k).clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert((*k).clone(), symbols);
    }
    build_call_reverse_index(&file_edges, &file_symbols)
}

#[test]
fn cross_file_call_builds_reverse_index() {
    let avatar_src = "def heal():\n    pass\n\ndef damage():\n    pass\n";
    let game_src = "from avatar import heal\n\ndef battle():\n    heal()\n";

    let avatar_key = key("scripts/avatar.py");
    let game_key = key("scripts/game.py");

    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&avatar_key, avatar_src), (&game_key, game_src)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        let edges = extract_call_graph(&ast, &symbols);
        file_edges.insert(k.clone(), edges);
        file_symbols.insert(k.clone(), symbols);
    }

    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    // game.py calls heal (defined in avatar.py) -> reverse: avatar.py -> {game.py}
    let dependents = rev.get(&avatar_key).expect("avatar.py 应有反依赖");
    assert!(
        dependents.contains(&game_key),
        "game.py 应是 avatar.py 的调用方"
    );
    // damage is never called -> no extra entry
    assert_eq!(rev.len(), 1);
}

#[test]
fn self_calls_do_not_cross_files() {
    let src = "class A:\n    def f(self):\n        self.g()\n    def g(self):\n        pass\n";
    let a_key = key("scripts/a.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    let ast = ParsedAst::new(src);
    let symbols = parse_ast_symbols(src).symbols;
    file_edges.insert(a_key.clone(), extract_call_graph(&ast, &symbols));
    file_symbols.insert(a_key.clone(), symbols);
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    // self.g() stays in the same file -> no cross-file entry
    assert!(rev.is_empty());
}

#[test]
fn callers_of_sorted_and_deduped_query() {
    let src = r#"
def f():
    a()
    a()
    b()
"#;
    let ast = ParsedAst::new(src);
    let symbols = parse_ast_symbols(src).symbols;
    let graph = PyCallGraph::new(extract_call_graph(&ast, &symbols));
    let callers = graph.callers_of("a");
    assert_eq!(callers.len(), 2);
    assert!(callers.iter().all(|e| e.caller == "f"));
    assert_eq!(graph.calls_of("f").len(), 3);
    assert!(!graph.is_empty());
}

#[test]
fn of_kind_filters_visualization_edges() {
    let src =
        "class E:\n    def m(self):\n        self.allClients.sync()\n        KBEngine.info('x')\n";
    let ast = ParsedAst::new(src);
    let symbols = parse_ast_symbols(src).symbols;
    let graph = PyCallGraph::new(extract_call_graph(&ast, &symbols));
    assert_eq!(graph.of_kind(kode_python::EdgeKind::KbeBroadcast).len(), 1);
    assert_eq!(graph.of_kind(kode_python::EdgeKind::KbeApi).len(), 1);
}

/// KODE-AUD-008: cross-file pseudo-edge guard. zcaller.py defines foo locally and calls `foo()`;
/// afoo.py also defines foo and sorts earlier by key. The old implementation's
/// find_module_function searched the whole project, hit afoo first -> pseudo edge
/// afoo→zcaller (a local call misattributed as cross-file); after the fix a definition
/// in the caller itself counts as local, and no cross-file edge is produced.
#[test]
fn local_bare_name_no_cross_file_pseudo_edge() {
    let zcaller = "def foo():\n    pass\n\ndef caller():\n    foo()\n";
    let afoo = "def foo():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/afoo.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "本地调用 foo() 不应产生跨文件伪边 afoo→zcaller, got {rev:?}"
    );
}

#[test]
fn receiver_without_import_no_cross_file_pseudo_edge() {
    // KODE-AUD-008 review residual: a non-module receiver (instance variable `avatar.heal()`, the
    // caller has no `import avatar`) is not statically resolvable -- finding a file by module name
    // would misattribute the sole same-named avatar.py as the callee (pseudo cross-file edge).
    // Requirement: if the receiver's first segment is not a caller import binding -> no cross-file edge.
    let zcaller = "def battle():\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "未 import 的实例接收者不应产生跨文件伪边 afoo→zcaller, got {rev:?}"
    );
}

#[test]
fn imported_module_receiver_resolves_cross_file() {
    // Same shape but the caller does have an `import avatar` binding -> the module receiver still
    // resolves to avatar.py (positive regression: the fix must not cut off genuine module calls).
    let zcaller = "import avatar\n\ndef battle():\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "已 import 的模块接收者应解析到 avatar.py, got {rev:?}"
    );
}

#[test]
fn function_scoped_import_receiver_resolves_cross_file() {
    // Review round 2 residual: a function-local import (`def f(): import avatar; avatar.heal()`)
    // is a genuine module binding too -- binding verification that only inspects the module
    // top-level import table would miss the edge decision.
    let zcaller = "def battle():\n    import avatar\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "函数内 import 的模块接收者应解析到 avatar.py, got {rev:?}"
    );
}

#[test]
fn cross_function_import_no_pseudo_edge() {
    // Review round 3 residual: binding ownership must follow scope -- the function-local import in
    // `setup` cannot vouch for `battle`'s instance receiver (avatar is battle's parameter, not a module).
    let zcaller = "def setup():\n    import avatar\n\ndef battle():\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "他函数作用域的 import 不应保放 battle 的实例接收者伪边, got {rev:?}"
    );
}

#[test]
fn same_name_method_import_no_pseudo_edge() {
    // Review round 4 residual (1): bare function-name keys merge unrelated same-named methods -- the
    // function-local import in A.run cannot vouch for B.run's instance receiver. Scope must be
    // located by line range.
    let zcaller = "class A:\n    def run(self):\n        import avatar\n\nclass B:\n    def run(self, avatar):\n        avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "同名方法的他函数 import 不应保放 B.run 实例接收者伪边, got {rev:?}"
    );
}

#[test]
fn outer_import_visible_to_nested_call() {
    // Review round 4 residual (2): outer import, call inside a nested def -- visible through the
    // closure, so an edge should be produced (bindings are attributed by line range; the outer
    // range covers the nested body; missing-edge direction).
    let zcaller = "def outer():\n    import avatar\n\n    def inner():\n        avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "外层 import 应对嵌套 def 内调用可见(闭包), got {rev:?}"
    );
}

#[test]
fn param_shadow_blocks_outer_import_vouch() {
    // Review round 5 residual: an outer import cannot vouch for an inner same-named parameter --
    // inner's avatar is a parameter shadow, not the module imported at the outer level.
    let zcaller =
        "def outer():\n    import avatar\n\n    def inner(avatar):\n        avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "内层参数遮蔽不应让外层 import 保放实例接收者伪边, got {rev:?}"
    );
}

#[test]
fn local_assign_shadow_blocks_outer_import_vouch() {
    // Same family: an inner local assignment (Store) also shadows the outer import -- a local
    // variable receiver is not statically resolvable, so the outer import does not vouch.
    let zcaller = "def outer():\n    import avatar\n\n    def inner():\n        avatar = load()\n        avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "内层局部赋值遮蔽不应让外层 import 保放实例接收者伪边, got {rev:?}"
    );
}

#[test]
fn module_import_does_not_bypass_param_shadow() {
    // Review round 6 residual (1): a module top-level import is the outermost fallback -- the inner
    // parameter shadow must take effect first and must not be short-circuited by the module-level import.
    let zcaller = "import avatar\n\ndef f(avatar):\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "参数遮蔽应阻断模块级 import 的保放, got {rev:?}"
    );
}

#[test]
fn same_scope_conflict_gives_up_edge() {
    // Review round 7 case, semantics revised (round 6 residual (3)): an import and a parameter coexist
    // in the same scope and statics cannot rule on the ordering (needs dataflow) -- conservatively give
    // up the edge (prefer missing over wrong; the pseudo-edge direction is guarded first).
    let zcaller = "def f(avatar):\n    import avatar\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "import+参数并存的静态歧义应放弃该边, got {rev:?}"
    );
}

#[test]
fn comprehension_target_does_not_shadow_function_import() {
    // Review round 6 residual (2): a comprehension target is an independent implicit scope and does not
    // shadow a function-local import -- a comprehension target's Store must not pollute the function shadows.
    let zcaller = "def f():\n    import avatar\n    rows = [str(avatar) for avatar in items]\n    return avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "推导式目标不应遮蔽函数局部 import 的真边, got {rev:?}"
    );
}

#[test]
fn comprehension_target_shadow_blocks_module_vouch() {
    // Review round 7 residual (2): a comprehension target shadows its own receiver -- the module import
    // does not vouch for an iteration-variable receiver inside a comprehension element (pseudo-edge direction).
    let zcaller = "import avatar\nrows = [avatar.heal() for avatar in items]\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "推导式目标遮蔽应阻断模块 import 保放迭代变量接收者, got {rev:?}"
    );
}

#[test]
fn rebind_after_import_blocks_vouch() {
    // Review round 7 residual (3): a same-scope import is later rebound by a local assignment -- the
    // receiver at the call site is a local object, so the module import does not vouch (pseudo-edge direction).
    let zcaller = "def f():\n    import avatar\n    avatar = obj\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "import 后的本地重绑定应阻断模块保放, got {rev:?}"
    );
}

#[test]
fn multi_line_comprehension_shadow_blocks_vouch() {
    // Review round 8 residual (2): a multi-line comprehension's iteration variable shadows its own element
    // receiver -- the element call line still falls inside the comprehension range, so the module import does not vouch.
    let zcaller = "import avatar\nrows = [avatar.heal()\n        for avatar in items]\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "多行推导式的迭代变量遮蔽应阻断模块保放, got {rev:?}"
    );
}

#[test]
fn module_rebind_blocks_module_fallback() {
    // Review round 9 residual (1): a module top-level import is later rebound by a local assignment -- the
    // bare-name receiver inside the function is that local object, so the module import fallback does not
    // vouch (pseudo-edge direction).
    let zcaller = "import avatar\navatar = obj\n\ndef battle():\n    avatar.heal()\n";
    let afoo = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, afoo)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "模块顶层重绑定应阻断模块 import 回退保放, got {rev:?}"
    );
}

#[test]
fn aliased_import_resolves_target_module_not_binding_name() {
    // Review round 9 residual (2): for `import other as avatar` the binding name is avatar but the target
    // module is other -- the receiver should resolve to other.py, not be misattributed to avatar.py by
    // binding name.
    let other = "def heal():\n    pass\n";
    let avatar_file = "def heal():\n    pass\n";
    let zcaller = "import other as avatar\n\ndef battle():\n    avatar.heal()\n";
    let ok = key("scripts/other.py");
    let ak = key("scripts/avatar.py");
    let zk = key("scripts/zcaller.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&ok, other), (&ak, avatar_file), (&zk, zcaller)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&ok).map(|s| s.contains(&zk)).unwrap_or(false),
        "别名导入应解析到目标模块 other.py, got {rev:?}"
    );
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "别名导入不得按绑定名误指同名的无关文件 avatar.py, got {rev:?}"
    );
}

#[test]
fn module_fallback_dotted_import_uses_first_segment() {
    // Review round 10 residual (1): for an unaliased `import a.b` the module fallback should take the
    // top-level first segment a (that is what gets bound, the package a); it must not take the last
    // segment b and misattribute the unrelated same-named b.py as the callee.
    let zcaller = "import a.b\n\ndef battle():\n    a.f()\n";
    let amod = "def f():\n    pass\n";
    let bmod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/a.py");
    let bk = key("scripts/b.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, amod), (&bk, bmod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "import a.b 的接收者 a 应解析到 a.py, got {rev:?}"
    );
    assert!(
        !rev.get(&bk).map(|s| s.contains(&zk)).unwrap_or(false),
        "import a.b 不得按末段误指无关 b.py, got {rev:?}"
    );
}

#[test]
fn conflicting_import_targets_give_up_edge() {
    // Review round 10 residual (2): repeated same-named imports with different targets (other/actual
    // competing for the avatar binding) -- conflicting target identity; statics do not adjudicate, so
    // conservatively give up the edge.
    let other = "def heal():\n    pass\n";
    let actual = "def heal():\n    pass\n";
    let avatar_file = "def heal():\n    pass\n";
    let zcaller =
        "import other as avatar\nimport actual as avatar\n\ndef battle():\n    avatar.heal()\n";
    let ok = key("scripts/other.py");
    let act = key("scripts/actual.py");
    let ak = key("scripts/avatar.py");
    let zk = key("scripts/zcaller.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [
        (&ok, other),
        (&act, actual),
        (&ak, avatar_file),
        (&zk, zcaller),
    ] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ok).map(|s| s.contains(&zk)).unwrap_or(false)
            && !rev.get(&act).map(|s| s.contains(&zk)).unwrap_or(false)
            && !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "目标冲突的 import 绑定应放弃该边, got {rev:?}"
    );
}

#[test]
fn module_fallback_aliased_dotted_import_uses_last_segment() {
    // Review round 11 residual (1): the binding c of `import a.b as c` points at module a.b -- the
    // fallback should take the last segment b (b.py), not mistakenly take a.py just because the
    // binding name happens to equal the top-level first segment.
    let zcaller = "import a.b as c\n\ndef battle():\n    c.f()\n";
    let bmod = "def f():\n    pass\n";
    let amod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let bk = key("scripts/b.py");
    let ak = key("scripts/a.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&bk, bmod), (&ak, amod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&bk).map(|s| s.contains(&zk)).unwrap_or(false),
        "import a.b as c 的接收者 c 应解析到 b.py, got {rev:?}"
    );
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "import a.b as c 不得误指 a.py, got {rev:?}"
    );
}

#[test]
fn function_layer_from_import_conflict_gives_up_edge() {
    // Review round 11 residual (2): from-imports with the same basename but different targets (pkg.x vs
    // other.x) conflict in target identity -- an identical basename is not enough to judge them
    // consistent, so give up.
    let px = "def heal():\n    pass\n";
    let ox = "def heal():\n    pass\n";
    let zcaller = "def battle():\n    from pkg import x as avatar\n    from other import x as avatar\n    avatar.heal()\n";
    let pk = key("scripts/x.py");
    let ok = key("scripts/x2.py");
    let zk = key("scripts/zcaller.py");
    // Both target files' basenames must be hit (same basename in different directories is not feasible
    // in this test, so two distinct files each containing heal are used instead, asserting that neither
    // produces an edge -- i.e. fully given up). x.py and x2.py differ in basename; under the conservative
    // contract, once the from-conflict gives up nothing resolves, so both should have no edge.
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&pk, px), (&ok, ox), (&zk, zcaller)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&pk).map(|s| s.contains(&zk)).unwrap_or(false)
            && !rev.get(&ok).map(|s| s.contains(&zk)).unwrap_or(false),
        "from-import 目标身份冲突应放弃该边, got {rev:?}"
    );
}

#[test]
fn aliased_dotted_import_alias_equals_first_segment_uses_last_segment() {
    // Review round 12 residual: `import a.b as a` where the explicit alias happens to equal the top-level
    // first segment name -- binding a points at module a.b, so the fallback must take the last segment b
    // (b.py) per the explicit-alias flag; it must not misjudge "has alias" as "binds the package itself"
    // because the binding name equals the first segment and misattribute the unrelated a.py.
    let zcaller = "import a.b as a\n\ndef battle():\n    a.f()\n";
    let bmod = "def f():\n    pass\n";
    let amod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let bk = key("scripts/b.py");
    let ak = key("scripts/a.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&bk, bmod), (&ak, amod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&bk).map(|s| s.contains(&zk)).unwrap_or(false),
        "import a.b as a 的接收者应解析到 b.py, got {rev:?}"
    );
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "import a.b as a 不得误指无关 a.py, got {rev:?}"
    );
}

#[test]
fn aliased_and_unaliased_same_binding_conflict_gives_up_edge() {
    // Review round 12 residual (consistency face): `import a.b` and `import a.b as a` share the binding
    // name a but differ in target identity (the package a itself vs the last segment b) -- aliased-or-not
    // must enter the target consistency check; on conflict, give up rather than misattribute by the first entry.
    let zcaller = "import a.b\nimport a.b as a\n\ndef battle():\n    a.f()\n";
    let bmod = "def f():\n    pass\n";
    let amod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let bk = key("scripts/b.py");
    let ak = key("scripts/a.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&bk, bmod), (&ak, amod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&bk).map(|s| s.contains(&zk)).unwrap_or(false)
            && !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "别名与否冲突的同名绑定应放弃该边, got {rev:?}"
    );
}

#[test]
fn same_target_import_with_and_without_alias_keeps_edge() {
    // Review round 13 residual: aliased-or-not is not target identity -- `import a` and `import a as a`
    // (or `from p import x` and `from p import x as x`) share the binding name and resolve to the same
    // target; the consistency check must not declare a conflict and give up over a differing aliased
    // flag (missing-edge direction).
    let zcaller = "import a\nimport a as a\n\ndef battle():\n    a.f()\n";
    let amod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/a.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, amod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "同目标的别名/无别名重复 import 应保留真边, got {rev:?}"
    );
}

#[test]
fn conflicting_target_identity_same_basename_gives_up_edge() {
    // Review round 14 residual: `import a.a` (identity = package a) and `import a.a as a` (identity =
    // module a.a) share the lookup basename a but differ in actual target identity -- consistency is
    // judged by target identity, so the edge should be dropped; do not judge them consistent over the
    // shared basename and misattribute a.py.
    let zcaller = "import a.a\nimport a.a as a\n\ndef battle():\n    a.f()\n";
    let amod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/a.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&ak, amod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "目标身份冲突(包 vs 模块)应弃边, got {rev:?}"
    );
}

#[test]
fn same_target_from_import_with_and_without_alias_keeps_edge() {
    // Review round 14 residual (from face): `from p import x` and `from p import x as x` share binding
    // name x and target identity p.x -- do not drop the edge over a differing aliased flag; the genuine edge is kept.
    let zcaller = "from p import x\nfrom p import x as x\n\ndef battle():\n    x.f()\n";
    let xmod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let xk = key("scripts/x.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&xk, xmod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&xk).map(|s| s.contains(&zk)).unwrap_or(false),
        "同目标 from-import 别名/无别名重复应保留真边, got {rev:?}"
    );
}

#[test]
fn different_relative_level_from_import_gives_up_edge() {
    // Review round 15 residual (test validity): the from-import fallback takes the basename from the
    // symbol (y -> y.py), so the level-conflict test must assert no edge against the unique y.py -- if
    // the level comparison broke, the two imports would be judged identity-consistent and produce an
    // edge to y.py via y, turning the assertion red (discriminative).
    let zcaller = "from .x import y\nfrom ..x import y\n\ndef battle():\n    y.f()\n";
    let ymod = "def f():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let yk = key("scripts/y.py");
    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&zk, zcaller), (&yk, ymod)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        !rev.get(&yk).map(|s| s.contains(&zk)).unwrap_or(false),
        "相对层级不同的同名 from-import 应弃边, got {rev:?}"
    );
}

#[test]
fn rust7_cross_process_edge_marked_uncertain_not_silent() {
    // RUST-7: for `self.cell.*`/`self.base.*` cross-process edges the callee file is not statically
    // resolvable (the entity class lives in a file on the other process side). Old behavior: falling into
    // the self.* branch folded it back into the caller file as "same class" -> silently dropped from the
    // reverse index. Requirement: produce no pseudo edge, but the caller file must appear in the uncertain
    // face (uncertain_cross_process_files) for the conservative rescan to consume.
    let base_src = "class Avatar:\n    def onHpChanged(self):\n        self.cell.recalc()\n";
    let plain_src = "def unrelated():\n    pass\n";
    let base_key = key("scripts/entities/avatar_base.py");
    let plain_key = key("scripts/utils.py");

    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&base_key, base_src), (&plain_key, plain_src)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }

    // The edge is indeed classified KbeCrossProcess (precondition: not something Unknown slipped in as)
    let edges = &file_edges[&base_key];
    assert!(
        edges
            .iter()
            .any(|e| e.kind == kode_python::EdgeKind::KbeCrossProcess),
        "self.cell.recalc() 应分类为 KbeCrossProcess, got {edges:?}"
    );

    // Reverse index: cross-process edges produce no pseudo edge and are no longer silently folded back into the caller itself
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.is_empty(),
        "跨进程边被调方不可解析,不应产任何反索引条目(含自身折叠), got {rev:?}"
    );

    // Uncertain face: caller files with cross-process edges must be flagged (not silently dropped)
    let uncertain = uncertain_cross_process_files(&file_edges);
    assert!(
        uncertain.contains(&base_key),
        "有跨进程边的 avatar_base.py 应进 uncertain 面, got {uncertain:?}"
    );
    assert!(
        !uncertain.contains(&plain_key),
        "无跨进程边的 utils.py 不应进 uncertain 面"
    );
    assert_eq!(uncertain.len(), 1);
}

#[test]
fn inner_scope_unrelated_import_falls_through_to_outer_resolution() {
    // The inner function imports only an unrelated module (utils): no binding and no shadow for avatar ->
    // (None, None) unresolved, keep walking outward. An unrelated import must not truncate resolution; the
    // module top-level `import avatar` vouches for the cross-file edge (missing-edge direction: a name that
    // is never mentioned is treated as unresolved, not as a local name).
    let utils_src = "def load():\n    pass\n";
    let avatar_src = "def heal():\n    pass\n";
    let zcaller =
        "import avatar\n\ndef outer():\n    def inner():\n        import utils\n        avatar.heal()\n";
    let zk = key("scripts/zcaller.py");
    let ak = key("scripts/avatar.py");
    let uk = key("scripts/utils.py");
    let rev = build_rev(&[(&zk, zcaller), (&ak, avatar_src), (&uk, utils_src)]);
    assert!(
        rev.get(&ak).map(|s| s.contains(&zk)).unwrap_or(false),
        "内层无关 import 不应阻断模块 import 对 avatar 接收者的保放, got {rev:?}"
    );
}

#[test]
fn unresolved_module_import_no_edge_when_file_missing() {
    // The module receiver of `import nothere` searches the whole project for a file by basename; no
    // nothere.py exists in the project -> zero matches produce no edge (prefer missing over wrong),
    // and no other basename's file may be misattributed either.
    let zcaller = "import nothere\n\ndef battle():\n    nothere.act()\n";
    let other_src = "def act():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let ok = key("scripts/other.py");
    let rev = build_rev(&[(&zk, zcaller), (&ok, other_src)]);
    assert!(
        rev.is_empty(),
        "零匹配的模块接收者不应产任何反索引条目, got {rev:?}"
    );
}

#[test]
fn ambiguous_same_basename_files_give_up_edge() {
    // Same-named avatar.py in two different directories: the basename match is not unique -> give up on
    // ambiguity and point at neither candidate (prefer missing over wrong; a reverse dependency pointing at
    // the wrong file causes missed or spurious invalidation).
    let zcaller = "import avatar\n\ndef battle():\n    avatar.heal()\n";
    let a1 = "def heal():\n    pass\n";
    let a2 = "def heal():\n    pass\n";
    let zk = key("scripts/zcaller.py");
    let k1 = key("scripts/pkg1/avatar.py");
    let k2 = key("scripts/pkg2/avatar.py");
    let rev = build_rev(&[(&zk, zcaller), (&k1, a1), (&k2, a2)]);
    assert!(
        !rev.get(&k1).map(|s| s.contains(&zk)).unwrap_or(false)
            && !rev.get(&k2).map(|s| s.contains(&zk)).unwrap_or(false),
        "同名 basename 歧义应放弃该边, got {rev:?}"
    );
}

#[test]
fn edge_kind_as_str_stable_literals() {
    // Golden parity-comparison exit: stable literals for the eight edge kinds (wt/parity panel
    // coloring/export consume these strings; changing them breaks the parity contract).
    assert_eq!(kode_python::EdgeKind::Local.as_str(), "local");
    assert_eq!(kode_python::EdgeKind::Method.as_str(), "method");
    assert_eq!(kode_python::EdgeKind::SelfMethod.as_str(), "self-method");
    assert_eq!(
        kode_python::EdgeKind::KbeBroadcast.as_str(),
        "kbe-broadcast"
    );
    assert_eq!(
        kode_python::EdgeKind::KbeBaseClients.as_str(),
        "kbe-base-clients"
    );
    assert_eq!(
        kode_python::EdgeKind::KbeCrossProcess.as_str(),
        "kbe-cross-process"
    );
    assert_eq!(kode_python::EdgeKind::KbeApi.as_str(), "kbe-api");
    assert_eq!(kode_python::EdgeKind::Unknown.as_str(), "unknown");
}
