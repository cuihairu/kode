//! 调用图聚合 + kode-scheduler 反向索引测试(C-20 交付③)。

use std::collections::BTreeMap;

use kode_python::callgraph::extract_call_graph;
use kode_python::graph::{build_call_reverse_index, uncertain_cross_process_files, PyCallGraph};
use kode_python::{parse_ast_symbols, ParsedAst};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

fn key(path: &str) -> DocumentKey {
    DocumentKey::new(RootId(0), CanonicalUri::from_path(path))
}

/// 多文件 → 跨文件反向索引(测试夹具:每文件解析符号表+调用边后聚合)。
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
    // game.py 调 heal(定义在 avatar.py)→ 反向:avatar.py → {game.py}
    let dependents = rev.get(&avatar_key).expect("avatar.py 应有反依赖");
    assert!(
        dependents.contains(&game_key),
        "game.py 应是 avatar.py 的调用方"
    );
    // damage 无人调用 → 不产生额外条目
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
    // self.g() 同文件 → 不产生跨文件条目
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

/// KODE-AUD-008:跨文件伪边防护。zcaller.py 本地定义 foo 并调用 `foo()`;
/// afoo.py 也定义 foo 且键序在前。旧实现 find_module_function 全项目搜先
/// 命中 afoo → 伪边 afoo→zcaller(本地调用被误指跨文件);修复后调用方
/// 自身定义即判本地,不产跨文件边。
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
    // KODE-AUD-008 复审残余:非模块接收者(实例变量 `avatar.heal()`,调用方
    // 未 `import avatar`)不可静态解析——按模块名找文件会把唯一同名文件
    // avatar.py 误指为被调方(伪跨文件边)。要求:接收者首段不是调用方
    // import 绑定 → 不产跨文件边。
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
    // 同形态但调用方确有 `import avatar` 绑定 → 模块接收者照常解析到
    // avatar.py(正向回归:修复不得把真模块调用也切断)。
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
    // 复审第二轮残余:函数内导入(`def f(): import avatar; avatar.heal()`)
    // 同样是真模块绑定——绑定核验若只看模块顶层 import 表会漏判断边。
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
    // 复审第三轮残余:绑定归属必须按作用域——`setup` 里的函数内 import
    // 不能为 `battle` 的实例接收者作保(avatar 是 battle 的参数,不是模块)。
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
    // 复审第四轮残余①:裸函数名键会合并无关同名方法——A.run 里的函数内
    // import 不能为 B.run 的实例接收者作保。作用域必须按行区间定位。
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
    // 复审第四轮残余②:外层 import、嵌套 def 内调用——闭包可见,应产边
    // (绑定按行区间归属,外层区间覆盖嵌套体,漏边方向)。
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
    // 复审第五轮残余:外层 import 不能为内层同名参数作保——inner 的
    // avatar 是参数遮蔽,不是外层导入的模块。
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
    // 同族:内层局部赋值(Store)同样遮蔽外层 import——局部变量接收者
    // 不可静态解析,外层导入不作保。
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
    // 复审第六轮残余①:模块顶层 import 是最外层回退——内层参数遮蔽
    // 必须先生效,不能被模块级 import 短路。
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
    // 复审第七轮用例改口径(第六轮残余③):同作用域 import 与参数并存,
    // 静态不裁决先后(需数据流)——保守放弃该边(宁缺毋滥;伪边向优先防)。
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
    // 复审第六轮残余②:推导式目标是独立隐式作用域,不遮蔽函数局部
    // import——推导式目标的 Store 不应污染函数 shadows。
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
    // 复审第七轮残余②:推导式目标遮蔽其自身的接收者——模块 import 不为
    // 推导式元素内的迭代变量接收者作保(伪边向)。
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
    // 复审第七轮残余③:同作用域 import 后又被本地赋值重绑定——调用点
    // 接收者是本地对象,模块 import 不作保(伪边向)。
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
    // 复审第八轮残余②:多行推导式的迭代变量遮蔽自身元素接收者——元素
    // 调用行仍落推导式区间内,模块 import 不作保。
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
    // 复审第九轮残余①:模块顶层 import 后被本地赋值重绑定——函数内裸名
    // 接收者是该本地对象,模块 import 回退不作保(伪边向)。
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
    // 复审第九轮残余②:`import other as avatar` 的绑定名是 avatar,目标
    // 模块是 other——接收者应解析到 other.py 而非按绑定名误指 avatar.py。
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
    // 复审第十轮残余①:模块回退对无别名 `import a.b` 应取顶层首段 a
    // (绑定的就是包 a),不得取末段 b 把同名无关 b.py 误指为被调方。
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
    // 复审第十轮残余②:同名多次 import 目标不同(other/actual 争 avatar
    // 绑定)——目标身份冲突,静态不裁决,保守放弃该边。
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
    // 复审第十一轮残余①:`import a.b as c` 的绑定 c 指向模块 a.b——回退
    // 应取末段 b(b.py),不得因绑定名恰为顶层首段误取 a.py。
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
    // 复审第十一轮残余②:同 basename 不同目标(pkg.x vs other.x)的
    // from-import 目标身份冲突——basename 相同不足以判定一致,应放弃。
    let px = "def heal():\n    pass\n";
    let ox = "def heal():\n    pass\n";
    let zcaller = "def battle():\n    from pkg import x as avatar\n    from other import x as avatar\n    avatar.heal()\n";
    let pk = key("scripts/x.py");
    let ok = key("scripts/x2.py");
    let zk = key("scripts/zcaller.py");
    // 两个目标文件 basename 都须能命中(同 basename 不同目录在测试里用
    // 同名不可行,改用两个不同文件各含 heal,断言两者都不产边——即完全
    // 放弃)。x.py 与 x2.py basename 不同,保守契约下 from-conflict 放弃
    // 后解析不到任何文件,两处都应无边。
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
    // 复审第十二轮残余:`import a.b as a` 显式别名恰为顶层首段名——绑定 a
    // 指向模块 a.b,回退须按显式别名标志取末段 b(b.py),不得因绑定名等于
    // 首段把「有别名」误判成「绑包本体」而误指无关 a.py。
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
    // 复审第十二轮残余(一致性面):`import a.b` 与 `import a.b as a` 绑定名
    // 同为 a,但目标身份不同(包本体 a vs 末段 b)——别名与否须进目标一致性
    // 检查,冲突即放弃,不按首条误指。
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
    // 复审第十三轮残余:别名与否不是目标身份——`import a` 与 `import a as a`
    // (或 `from p import x` 与 `from p import x as x`)绑定名相同且解析后
    // 目标相同,一致性检查不得因 aliased 标志不同判冲突放弃(漏边向)。
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
    // 复审第十四轮残余:`import a.a`(身份=包 a)与 `import a.a as a`(身份=
    // 模块 a.a)查找 basename 同为 a,但实际目标身份不同——一致性按目标身份
    // 判,应弃边,不得因 basename 相同判一致而误指 a.py。
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
    // 复审第十四轮残余(from 面):`from p import x` 与 `from p import x as x`
    // 绑定名同 x、目标身份同 p.x——不因 aliased 标志不同弃边,真边保留。
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
    // 复审第十五轮残余(测试有效性):from-import 回退按 symbol 取 basename
    // (y → y.py),层级冲突测试必须对唯一 y.py 断言无边——若层级比较失效,
    // 两导入身份判一致会按 y 产边到 y.py,断言即红(可判别)。
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
    // RUST-7:`self.cell.*`/`self.base.*` 跨进程边被调方文件无法静态解析
    // (实体类在另一进程侧文件里)。旧行为:落进 self.* 分支按「同类」折叠
    // 回调用方文件 → 反索引无声丢弃。要求:不产伪边,但调用方文件必须
    // 出现在 uncertain 面(uncertain_cross_process_files),供保守重扫消费。
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

    // 边确实被识别为 KbeCrossProcess(前提:不是 Unknown 混进来的)
    let edges = &file_edges[&base_key];
    assert!(
        edges
            .iter()
            .any(|e| e.kind == kode_python::EdgeKind::KbeCrossProcess),
        "self.cell.recalc() 应分类为 KbeCrossProcess, got {edges:?}"
    );

    // 反索引:跨进程边既不产伪边,也不再无声折叠回调用方自身
    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.is_empty(),
        "跨进程边被调方不可解析,不应产任何反索引条目(含自身折叠), got {rev:?}"
    );

    // uncertain 面:有跨进程边的调用方文件必须被标出(非无声丢弃)
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
    // 内层函数仅 import 无关模块(utils):对 avatar 既无绑定也无遮蔽 →
    // (None,None) 未决继续向外——无关 import 不得截断解析,由模块顶层
    // `import avatar` 保放跨文件边(漏边向:未提及名当作未决而非本地名)。
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
    // `import nothere` 的模块接收者按 basename 全项目找文件;项目里没有
    // nothere.py → 零匹配不产边(宁缺毋滥),也不得误指其他 basename 文件。
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
    // 两个不同目录的同名 avatar.py:basename 匹配不唯一 → 歧义放弃,不
    // 指向任一候选(宁缺毋滥;反依赖指错文件会漏失效/误失效)。
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
    // golden 对拍出口:八种边种类的稳定字面量(wt/parity 面板着色/导出
    // 按此字符串消费,改动即破坏对拍契约)。
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
