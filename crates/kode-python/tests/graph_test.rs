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

/// KR-AUD-15(RUST-7 残面):`self.<m>()` 恒回调用方文件——继承链(父实体脚本/
/// 混入在另一文件)时,父类方法变更不会失效子类文件(引擎 cell 侧漏报面)。
/// 口径:本地有成员即折叠(原行为);本地无 → 全项目恰一处类成员定义才连。
#[test]
fn kr_aud_15_inherited_self_member_links_parent_file() {
    let parent_src = "class Parent:\n    def inherited(self):\n        pass\n";
    let child_src = "class Child(Parent):\n    def run(self):\n        self.inherited()\n";
    let parent_key = key("scripts/parent.py");
    let child_key = key("scripts/child.py");

    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&parent_key, parent_src), (&child_key, child_src)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }

    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(
        rev.get(&parent_key)
            .map(|s| s.contains(&child_key))
            .unwrap_or(false),
        "self.inherited() 定义在 parent.py,反索引应含 parent→child, got {rev:?}"
    );
}

/// KR-AUD-15 保守面:同名成员在多文件并存(KBEngine 各实体同名 onTimer 常态)
/// → 歧义不产边(宁缺毋滥,避免误失效)。
#[test]
fn kr_aud_15_ambiguous_self_member_produces_no_edge() {
    let caller_src = "class Caller:\n    def run(self):\n        self.onTimer()\n";
    let b_src = "class B:\n    def onTimer(self):\n        pass\n";
    let c_src = "class C:\n    def onTimer(self):\n        pass\n";
    let caller_key = key("scripts/caller.py");
    let b_key = key("scripts/b.py");
    let c_key = key("scripts/c.py");

    let mut file_edges = BTreeMap::new();
    let mut file_symbols = BTreeMap::new();
    for (k, src) in [(&caller_key, caller_src), (&b_key, b_src), (&c_key, c_src)] {
        let ast = ParsedAst::new(src);
        let symbols = parse_ast_symbols(src).symbols;
        file_edges.insert(k.clone(), extract_call_graph(&ast, &symbols));
        file_symbols.insert(k.clone(), symbols);
    }

    let rev = build_call_reverse_index(&file_edges, &file_symbols);
    assert!(rev.is_empty(), "同名成员多处定义应保守不产边, got {rev:?}");
}
