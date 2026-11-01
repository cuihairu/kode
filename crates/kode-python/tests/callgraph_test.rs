//! 调用图 + KBEngine 特化边测试(C-20 交付①)。

use kode_python::callgraph::extract_call_graph;
use kode_python::{parse_ast_symbols, EdgeKind, ParsedAst, PyCallGraph};

/// KBEngine 实体脚本样例(覆盖四类特化边 + 本地/自身/API 调用)。
const KB_ENTITY: &str = r#"
import KBEngine
import math

class Avatar(KBEngine.Entity):
    def __init__(self):
        self.hp = 100
        self.mp = 50

    def take_damage(self, amount):
        self.hp -= amount
        self.notify_damage(amount)          # self-method
        self.allClients.onDamage(self.hp)   # kbe-broadcast
        self.baseClients.onSyncHp(self.hp)  # kbe-base-clients
        self.cell.recalc()                  # kbe-cross-process (base→cell)
        self.base.reportHp(self.hp)         # kbe-cross-process (cell→base)
        KBEngine.log("damage")              # kbe-api
        helper(self.hp)                     # local (module-level func)
        self.onDeath()                      # self-method

    def onDeath(self):
        pass

def helper(x):
    return x
"#;

fn edges_of(src: &str) -> Vec<kode_python::CallEdge> {
    let ast = ParsedAst::new(src);
    let symbols = parse_ast_symbols(src).symbols;
    extract_call_graph(&ast, &symbols)
}

#[test]
fn extracts_kbengine_specialized_edges() {
    let edges = edges_of(KB_ENTITY);
    // 全部在 Avatar.take_damage 内(7 条)+ Avatar.onDeath(0)+ 模块级 helper 无
    let methods: Vec<&kode_python::CallEdge> =
        edges.iter().filter(|e| e.caller == "take_damage").collect();
    assert_eq!(methods.len(), 8, "应收集到 8 条调用边: {methods:#?}");

    let kinds: Vec<EdgeKind> = methods.iter().map(|e| e.kind).collect();
    assert!(kinds.contains(&EdgeKind::KbeBroadcast));
    assert!(kinds.contains(&EdgeKind::KbeBaseClients));
    assert!(kinds.contains(&EdgeKind::KbeCrossProcess));
    assert!(kinds.contains(&EdgeKind::KbeApi));
    assert!(kinds.contains(&EdgeKind::Local));
    assert!(kinds.contains(&EdgeKind::SelfMethod));

    // 每条边断言 callee/receiver/kind
    let find = |callee: &str| -> kode_python::CallEdge {
        let edge = methods
            .iter()
            .find(|e| e.callee == callee)
            .unwrap_or_else(|| panic!("缺调用边 {callee}"));
        (*edge).clone()
    };
    assert_eq!(find("onDamage").kind, EdgeKind::KbeBroadcast);
    assert_eq!(
        find("onDamage").receiver.as_deref(),
        Some("self.allClients")
    );
    assert_eq!(find("onSyncHp").kind, EdgeKind::KbeBaseClients);
    assert_eq!(find("recalc").kind, EdgeKind::KbeCrossProcess);
    assert_eq!(find("recalc").receiver.as_deref(), Some("self.cell"));
    assert_eq!(find("reportHp").kind, EdgeKind::KbeCrossProcess);
    assert_eq!(find("reportHp").receiver.as_deref(), Some("self.base"));
    assert_eq!(find("log").kind, EdgeKind::KbeApi);
    assert_eq!(find("helper").kind, EdgeKind::Local);
    assert_eq!(find("helper").receiver, None);
    assert_eq!(find("onDeath").kind, EdgeKind::SelfMethod);
    assert_eq!(find("notify_damage").kind, EdgeKind::SelfMethod);

    // caller 归属正确
    assert!(methods
        .iter()
        .all(|e| e.caller_class.as_deref() == Some("Avatar")));
}

#[test]
fn callers_of_lists_affected_call_sites() {
    let edges = edges_of(KB_ENTITY);
    let graph = PyCallGraph::new(edges);
    // 「改方法签名→受影响调用点全数列出」:onDamage 只有一处调用
    let on_damage = graph.callers_of("onDamage");
    assert_eq!(on_damage.len(), 1);
    assert_eq!(on_damage[0].caller, "take_damage");
    // helper 本地函数调用一处
    assert_eq!(graph.callers_of("helper").len(), 1);
    // 无调用 → 空
    assert!(graph.callers_of("nonexistent").is_empty());
}

#[test]
fn module_level_call_edges_captured() {
    let src = "def init():\n    pass\n\ndef setup():\n    init()\n\ninit()\n";
    let edges = edges_of(src);
    // 模块顶层 init() 调用(caller=<module>)与 setup 内 init() 各一条
    let module_calls: Vec<_> = edges.iter().filter(|e| e.caller == "<module>").collect();
    assert_eq!(module_calls.len(), 1);
    assert_eq!(module_calls[0].callee, "init");
    // setup 内 init() → Local(init 是本文件模块级函数)
    let setup_calls: Vec<_> = edges.iter().filter(|e| e.caller == "setup").collect();
    assert_eq!(setup_calls.len(), 1);
    assert_eq!(setup_calls[0].kind, EdgeKind::Local);
}

#[test]
fn imported_function_is_local() {
    let src = "from utils import run\n\ndef main():\n    run()\n";
    let edges = edges_of(src);
    let main: Vec<_> = edges.iter().filter(|e| e.caller == "main").collect();
    assert_eq!(main.len(), 1);
    assert_eq!(main[0].kind, EdgeKind::Local);
}

#[test]
fn nested_calls_and_control_flow_walked() {
    let src = r#"
def process(items):
    for it in items:
        if it.ok():
            validate(it)
        else:
            skip(it)
    try:
        commit(items)
    except ValueError as e:
        handle(e)
    finally:
        cleanup()
"#;
    let edges = edges_of(src);
    let names: Vec<&str> = edges.iter().map(|e| e.callee.as_str()).collect();
    assert!(names.contains(&"ok"));
    assert!(names.contains(&"validate"));
    assert!(names.contains(&"skip"));
    assert!(names.contains(&"commit"));
    assert!(names.contains(&"handle"));
    assert!(names.contains(&"cleanup"));
}

#[test]
fn unknown_bare_name_not_local() {
    let src = "def f():\n    external_thing()\n";
    let edges = edges_of(src);
    assert_eq!(edges[0].kind, EdgeKind::Unknown);
}

#[test]
fn empty_and_invalid_source_tolerant() {
    // 空文件 → 0 边
    assert!(edges_of("").is_empty());
    // 语法错误文件 → 不 panic,尽力产出
    let edges = edges_of("def broken(:\n    pass\n");
    let _ = edges;
}
