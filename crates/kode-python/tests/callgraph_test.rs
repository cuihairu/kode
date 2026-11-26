//! Call-graph + KBEngine specialized-edge tests (C-20 delivery item 1).

use kode_python::callgraph::{extract_call_graph, extract_call_graph_detailed};
use kode_python::{parse_ast_symbols, EdgeKind, ParsedAst, PyCallGraph};

/// KBEngine entity-script sample (covers the four specialized-edge kinds + local/self/API calls).
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
        self.client.notifyView()            # kbe-cross-process (cell→client)
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
    // All inside Avatar.take_damage (7 edges) + Avatar.onDeath (0) + the module-level helper has none
    let methods: Vec<&kode_python::CallEdge> =
        edges.iter().filter(|e| e.caller == "take_damage").collect();
    assert_eq!(methods.len(), 9, "应收集到 9 条调用边: {methods:#?}");

    let kinds: Vec<EdgeKind> = methods.iter().map(|e| e.kind).collect();
    assert!(kinds.contains(&EdgeKind::KbeBroadcast));
    assert!(kinds.contains(&EdgeKind::KbeBaseClients));
    assert!(kinds.contains(&EdgeKind::KbeCrossProcess));
    assert!(kinds.contains(&EdgeKind::KbeApi));
    assert!(kinds.contains(&EdgeKind::Local));
    assert!(kinds.contains(&EdgeKind::SelfMethod));

    // Each edge asserts callee/receiver/kind
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
    assert_eq!(find("notifyView").kind, EdgeKind::KbeCrossProcess);
    assert_eq!(find("notifyView").receiver.as_deref(), Some("self.client"));
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
    // helper: one local function call
    assert_eq!(graph.callers_of("helper").len(), 1);
    // No call -> empty
    assert!(graph.callers_of("nonexistent").is_empty());
}

#[test]
fn module_level_call_edges_captured() {
    let src = "def init():\n    pass\n\ndef setup():\n    init()\n\ninit()\n";
    let edges = edges_of(src);
    // One module-top-level init() call (caller=<module>) and one init() inside setup
    let module_calls: Vec<_> = edges.iter().filter(|e| e.caller == "<module>").collect();
    assert_eq!(module_calls.len(), 1);
    assert_eq!(module_calls[0].callee, "init");
    // init() inside setup -> Local (init is a module-level function of this file)
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
    // Empty file -> 0 edges
    assert!(edges_of("").is_empty());
    // Syntax-error file -> does not panic, best-effort production
    let edges = edges_of("def broken(:\n    pass\n");
    let _ = edges;
}

// ---------------------------------------------------------------------------
// KODE-AUD-008: verification of the call-graph missing-semantics fix.
// Nested def/class used to be skipped wholesale (in-body calls all missed);
// match pattern guards used not to be walked.
// Discriminating: before the fix edges are missing, after the fix the assertions hold.
// ---------------------------------------------------------------------------

/// A nested function (def inner inside def outer's body) as an independent caller: the in-body
/// `foo()` call is recorded with caller="inner" (the old implementation's walk_stmt was a
/// no-op for nested FunctionDef, so all edges were missed); outer-function calls are still
/// recorded by the outer walk, without overlap.
#[test]
fn nested_def_calls_recorded() {
    let src =
        "def foo():\n    pass\n\ndef outer():\n    def inner():\n        foo()\n    return 1\n";
    let es = edges_of(src);
    let hit = es.iter().find(|e| e.caller == "inner" && e.callee == "foo");
    let e = hit.expect("嵌套函数 inner 内 foo() 应有边");
    assert_eq!(e.kind, EdgeKind::Local, "foo 是模块级函数 → Local");
}

/// A nested class (class Inner inside a method body)'s method as an independent caller: the
/// `foo()` inside Inner.run is recorded with caller="run", caller_class="Inner" (missed by the
/// old implementation).
#[test]
fn nested_class_method_calls_recorded() {
    let src = "def foo():\n    pass\n\nclass Outer:\n    def method(self):\n        class Inner:\n            def run(self):\n                foo()\n";
    let es = edges_of(src);
    let e = es
        .iter()
        .find(|e| e.caller == "run" && e.callee == "foo")
        .expect("嵌套类 Inner.run 内 foo() 应有边");
    assert_eq!(e.caller_class.as_deref(), Some("Inner"));
    assert_eq!(e.kind, EdgeKind::Local);
}

/// Calls inside a match pattern guard (`case 1 if foo():`): the old implementation walked only
/// the subject and case.body, missing the guard; the fix walks the guard.
#[test]
fn match_guard_calls_recorded() {
    let src = "def foo():\n    pass\n\ndef f(x):\n    match x:\n        case 1 if foo():\n            pass\n";
    let es = edges_of(src);
    assert!(
        es.iter().any(|e| e.caller == "f" && e.callee == "foo"),
        "match guard 内 foo() 应有边, got {es:?}"
    );
}

/// KR-AUD-20 (the residual face of KODE-AUD-008): a def nested inside a method body used to
/// inherit the outer caller_class, producing a spurious (Foo, inner) class-method edge. Fix:
/// the nested def body walk passes caller_class=None -- a nested function is not a method of
/// the outer class.
#[test]
fn nested_def_in_method_has_no_class_method_edge_kraud20() {
    let src = "class Foo:\n    def method(self):\n        def inner():\n            helper()\n        inner()\n\ndef helper():\n    pass\n";
    let es = edges_of(src);
    let fake: Vec<&kode_python::CallEdge> = es
        .iter()
        .filter(|e| e.caller == "inner" && e.caller_class.is_some())
        .collect();
    assert!(fake.is_empty(), "嵌套 def 不应带 caller_class: {fake:#?}");
    let e = es
        .iter()
        .find(|e| e.caller == "inner" && e.callee == "helper")
        .expect("嵌套 def 体内调用边保持");
    assert_eq!(e.caller_class, None);
    // The outer method's call edges are unaffected.
    assert!(
        es.iter()
            .any(|e| e.caller == "method" && e.callee == "inner"),
        "the outer method's walk is preserved"
    );
}

/// KR-AUD-21: semantics unification -- lambda-body calls used to be attributed to the outer
/// caller while nested defs were attributed to themselves (the KODE-AUD-008 contract). Unified
/// so a lambda body likewise uses its own "<lambda>" as caller, caller_class=None (the same
/// contract as KR-AUD-20's nested defs not inheriting caller_class).
#[test]
fn lambda_body_calls_recorded_as_own_caller_kraud21() {
    let src = "def foo():\n    pass\n\ndef outer():\n    f = lambda: foo()\n    return f()\n";
    let es = edges_of(src);
    let e = es
        .iter()
        .find(|e| e.callee == "foo")
        .expect("lambda 体内 foo() 应有边");
    assert_eq!(e.caller, "<lambda>");
    assert_eq!(e.caller_class, None);
    assert!(
        !es.iter().any(|e| e.caller == "outer" && e.callee == "foo"),
        "lambda 体调用不再归外层 caller: {es:?}"
    );
}

// ---------------------------------------------------------------------------
// Coverage supplements: covering the walk_stmt / walk_expr / dotted_chain / classify branches
// one by one. Each assertion pins real semantics (edges present, classification right, call-site
// columns aligned); no empty assertions.
// ---------------------------------------------------------------------------

/// The detailed variant's output aligns with the base variant item by item (equal edge sets, same
/// order), and columns are >= 0 (call-site columns are 0-based UTF-16; the symbol table's
/// per-method calls consumption face). All three source routes are present: a class-method edge,
/// a module-level-function edge, and a module-top-level-statement edge -- each of the three
/// caller closure write paths has at least one edge it can produce.
#[test]
fn detailed_variant_aligns_with_base_and_has_columns() {
    let src = "def target():\n    pass\n\ndef helper():\n    target()\n\nclass Avatar:\n    def on_damage(self):\n        helper()\n\nclass Empty:\n    x = 1\n\nhelper()\n";
    let ast = ParsedAst::new(src);
    let symbols = parse_ast_symbols(src).symbols;
    let base = extract_call_graph(&ast, &symbols);
    let detailed = extract_call_graph_detailed(&ast, &symbols);
    assert_eq!(detailed.len(), base.len(), "边数应逐条对齐");
    // One per route: helper->target (module-level function), Avatar.on_damage->helper
    // (class method), <module>->helper (top-level statement); Empty has no methods -> the
    // if-let false branch is walked as usual.
    assert_eq!(detailed.len(), 3, "应有 3 条边: {detailed:#?}");
    for (i, (edge, col)) in detailed.iter().enumerate() {
        assert_eq!(edge, &base[i], "第 {i} 条边应与基础变体一致");
        // Call-site columns are 0-based; calls inside a class method or a function body are not
        // at line start, column > 0; the module-top-level helper() is at line start, column can be 0.
        match edge.caller.as_str() {
            "on_damage" | "helper" => assert!(*col > 0, "体内调用列号应为正: {col}"),
            "<module>" => assert_eq!(*col, 0, "模块顶层调用列号应为 0: {col}"),
            other => panic!("意外 caller {other}: {edge:?}"),
        }
    }
    // Caller attribution across the three routes: class methods carry the class name, top-level
    // statements are <module>, module-level functions carry no class name.
    assert!(
        detailed
            .iter()
            .any(|(e, _)| e.caller == "on_damage" && e.caller_class.as_deref() == Some("Avatar")),
        "类方法边应在: {detailed:#?}"
    );
    assert!(
        detailed
            .iter()
            .any(|(e, _)| e.caller == "helper" && e.caller_class.is_none()),
        "模块级函数边应在: {detailed:#?}"
    );
    assert!(
        detailed.iter().any(|(e, _)| e.caller == "<module>"),
        "模块顶层语句边应在: {detailed:#?}"
    );
}

/// walk_stmt's AnnAssign (with/without value), Delete, Raise, Assert, elif, While, With branches:
/// calls inside each construct should be walked and the call sites classified correctly.
#[test]
fn control_flow_and_misc_stmt_calls_walked() {
    let src = r#"
def outer_call():
    pass

def f(x, cond, msg, ctx):
    y: int = outer_call()
    z: int
    del y
    raise ValueError(outer_call())
    assert x, msg
    if x:
        pass
    elif cond:
        outer_call()
    while cond:
        outer_call()
    with ctx() as c:
        outer_call()
"#;
    let es = edges_of(src);
    let f_edges: Vec<&kode_python::CallEdge> = es.iter().filter(|e| e.caller == "f").collect();
    // outer_call 出现在:AnnAssign 值(1)+ raise 实参(1)+ elif 体(1)+ while 体(1)
    // + with 体(1)。del/assert 无调用。
    let outer: Vec<_> = f_edges
        .iter()
        .filter(|e| e.callee == "outer_call")
        .collect();
    assert_eq!(outer.len(), 5, "outer_call 应有 5 条边: {f_edges:#?}");
    // with ctx() as c:ctx 调用是接收者(caller=f, callee=ctx, kind Unknown)
    assert!(
        f_edges.iter().any(|e| e.callee == "ctx"),
        "with 的上下文表达式 ctx() 应被走查: {f_edges:#?}"
    );
    // assert 的消息表达式 msg 是参数读,无调用;raise ValueError(...) 的
    // ValueError 是 Name(被调方),outer_call 是实参。
    assert!(
        f_edges.iter().any(|e| e.callee == "ValueError"),
        "raise ValueError(outer_call()) 的 ValueError 应为被调方: {f_edges:#?}"
    );
}

/// walk_expr 全形态:Subscript/BoolOp/Named/UnaryOp/If 表达式/Dict/Set/List/
/// Tuple/ListComp/SetComp/DictComp/Generator/Compare/Starred/Slice/BinOp/
/// 关键字实参/推导式 if 过滤/FString。
/// 每个容器内嵌 outer_call() 并断言其被走查(FString 除外——调用图忽略)。
#[test]
fn expression_forms_all_walked() {
    let src = r#"
def outer_call():
    pass

def cond(x):
    return x

def f(a, b, items):
    x = items[0]
    y = a and outer_call()
    z = (b := outer_call())
    w = -a
    q = outer_call() if a else a
    r = {outer_call(): outer_call()}
    s = {outer_call()}
    t = [outer_call()]
    u = (outer_call(),)
    v = [outer_call() for x in items if cond(x)]
    v2 = {outer_call() for x in items if cond(x)}
    v3 = {x: outer_call() for x in items if cond(x)}
    v4 = (outer_call() for x in items if cond(x))
    c = a < b
    st = [*outer_call()]
    sl = items[1:2:3]
    p = a + outer_call()
    kw = outer_call(x=a)
    fs = f"{outer_call()}"
    g = outer_call()
"#;
    let es = edges_of(src);
    let f_edges: Vec<&kode_python::CallEdge> = es.iter().filter(|e| e.caller == "f").collect();
    // 统计各被调方出现次数(每处调用一条边):
    // outer_call:y(1)+ z(1)+ q(1)+ r 键值(2)+ s(1)+ t(1)+ u(1)+ v elt(1)
    //   + v2 elt(1)+ v3 value(1)+ v4 elt(1)+ st(1)+ p(1)+ kw(1)+ g(1) = 16;
    //   fs 内忽略。cond:四个推导式的 if 过滤各 1 = 4。
    let outer: Vec<_> = f_edges
        .iter()
        .filter(|e| e.callee == "outer_call")
        .collect();
    assert_eq!(outer.len(), 16, "outer_call 应恰 16 条边: {f_edges:#?}");
    let conds: Vec<_> = f_edges.iter().filter(|e| e.callee == "cond").collect();
    assert_eq!(
        conds.len(),
        4,
        "四个推导式 if 过滤各一条 cond 边: {f_edges:#?}"
    );
    // 关键字实参:`outer_call(x=a)` 的 x 是关键字名,不产边;值 a 是参数读。
    assert!(
        !f_edges.iter().any(|e| e.callee == "x"),
        "关键字名不是被调方: {f_edges:#?}"
    );
    // 推导式各形态的 iter 是 Name(items) 读,不产边;elt 的 outer_call 在
    // ListComp/SetComp/Generator 均被走查。
    assert!(
        !f_edges.iter().any(|e| e.callee == "items"),
        "推导式 iter 的 Name 不是调用: {f_edges:#?}"
    );
    // FString 内的调用被忽略:总边数不含它(上面 15 已证)。
}

/// walk_expr 的 Await/Yield/YieldFrom(异步生成器)。
#[test]
fn async_generator_yield_await_walked() {
    let src = r#"
async def outer_async():
    pass

async def af(a):
    await outer_async()
    yield a
    yield from outer_async()
"#;
    let es = edges_of(src);
    let af_edges: Vec<&kode_python::CallEdge> = es.iter().filter(|e| e.caller == "af").collect();
    assert_eq!(
        af_edges.len(),
        2,
        "await 与 yield from 各一条: {af_edges:#?}"
    );
    assert!(af_edges.iter().any(|e| e.callee == "outer_async"));
}

/// dotted_chain 的 Subscript 分支:`(items[0]).g()` —— 接收者链经下标解包为
/// ["items","g"],分类 Method(非 self、非 KBEngine、多段)。
#[test]
fn subscript_receiver_chain_walked() {
    let src = "def f(items):\n    (items[0]).g()\n";
    let es = edges_of(src);
    let e = es
        .iter()
        .find(|e| e.callee == "g")
        .expect("(items[0]).g() 应有边");
    assert_eq!(e.receiver.as_deref(), Some("items"));
    assert_eq!(e.kind, EdgeKind::Method, "下标解包后的接收者按 Method 记");
}

/// record_call 的 chain=None 分支:`(lambda: 1)()` 的 func 是 Lambda,非
/// Name/Attribute/Subscript → dotted_chain None → callee 空串、kind Unknown。
#[test]
fn non_name_callee_records_empty_callee() {
    let src = "def f():\n    (lambda: 1)()\n";
    let es = edges_of(src);
    let e = es
        .iter()
        .find(|e| e.caller == "f")
        .expect("lambda 调用应有边");
    assert_eq!(e.callee, "", "非名字被调方 callee 为空串");
    assert_eq!(e.receiver, None);
    assert_eq!(e.kind, EdgeKind::Unknown);
}

/// classify 的 `self(...)`(v.len()==1)分支:括号内自名调用按自身方法记。
#[test]
fn self_bare_call_is_self_method() {
    let src = "class A:\n    def m(self):\n        self()\n";
    let es = edges_of(src);
    let e = es
        .iter()
        .find(|e| e.caller == "m" && e.callee == "self")
        .expect("self() 应有边");
    assert_eq!(e.kind, EdgeKind::SelfMethod);
    assert_eq!(e.receiver, None);
}

/// classify 的 self.other.method(...)(v[1] 非 KBEngine 通道)按普通 Method 记。
#[test]
fn self_nested_attr_is_method() {
    let src = "class A:\n    def m(self):\n        self.other.method()\n";
    let es = edges_of(src);
    let e = es
        .iter()
        .find(|e| e.caller == "m" && e.callee == "method")
        .expect("self.other.method() 应有边");
    assert_eq!(e.kind, EdgeKind::Method);
    assert_eq!(e.receiver.as_deref(), Some("self.other"));
}

/// classify 的 KBEngine/kbengine 小写别名分支(小写 kbengine 亦为引擎 API)。
#[test]
fn kbengine_lowercase_alias_is_kbe_api() {
    let src = "def f():\n    kbengine.info('x')\n";
    let es = edges_of(src);
    let e = es
        .iter()
        .find(|e| e.callee == "info")
        .expect("kbengine.info 应有边");
    assert_eq!(e.kind, EdgeKind::KbeApi);
    assert_eq!(e.receiver.as_deref(), Some("kbengine"));
}

/// 模块顶层语句中的控制流(If/For/While/With)调用:caller=<module>。
#[test]
fn module_level_control_flow_walked() {
    let src = "def f():\n    pass\n\nif True:\n    f()\n";
    let es = edges_of(src);
    let module_calls: Vec<_> = es
        .iter()
        .filter(|e| e.caller == "<module>" && e.callee == "f")
        .collect();
    assert_eq!(module_calls.len(), 1, "模块级 if 体内调用应归属 <module>");
    assert_eq!(module_calls[0].kind, EdgeKind::Local);
}

/// 嵌套类(非方法体内)内嵌调用走查边界:类体内直接嵌套的类(非 def 内)
/// 其方法不入调用图(extract_call_graph/walk_stmt 的 ClassDef 分支都只走
/// 直属 FunctionDef)。此处断言既有的方法直属收集语义不回归。
#[test]
fn class_direct_methods_walked_nested_class_body_skipped() {
    let src = "class Outer:\n    def run(self):\n        helper()\n\n    class Inner:\n        def deep(self):\n            helper()\n\ndef helper():\n    pass\n";
    let es = edges_of(src);
    assert!(
        es.iter().any(|e| e.caller == "run" && e.callee == "helper"),
        "类直属方法 Outer.run 应入调用图"
    );
    // 类体内直接嵌套类的方法不在本调用图边界内(见 KODE-AUD-008 注:仅
    // 函数体内的嵌套类走独立 caller_class 路径)。
    assert!(
        !es.iter().any(|e| e.caller == "deep"),
        "类内直接嵌套类的方法不属于本图边界: {es:?}"
    );
}
