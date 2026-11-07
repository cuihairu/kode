//! 调用图 + KBEngine 特化边测试(C-20 交付①)。

use kode_python::callgraph::{extract_call_graph, extract_call_graph_detailed};
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
    // 全部在 Avatar.take_damage 内(7 条)+ Avatar.onDeath(0)+ 模块级 helper 无
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

// ---------------------------------------------------------------------------
// KODE-AUD-008:调用图遗漏语义修复验证。
// 嵌套 def/class 此前整体跳过(体内调用全漏)、match pattern guard 此前不走查。
// 判别性:修复前边缺失,修复后断言成立。
// ---------------------------------------------------------------------------

/// 嵌套函数(def inner 于 def outer 体内)作为独立调用方:体内 `foo()` 调用
/// 以 caller="inner" 记录(旧实现 walk_stmt 对嵌套 FunctionDef 整体 no-op,
/// 边全漏);外层函数调用仍由外层走查记录,不重叠。
#[test]
fn nested_def_calls_recorded() {
    let src =
        "def foo():\n    pass\n\ndef outer():\n    def inner():\n        foo()\n    return 1\n";
    let es = edges_of(src);
    let hit = es.iter().find(|e| e.caller == "inner" && e.callee == "foo");
    let e = hit.expect("嵌套函数 inner 内 foo() 应有边");
    assert_eq!(e.kind, EdgeKind::Local, "foo 是模块级函数 → Local");
}

/// 嵌套类(方法体内 class Inner)的方法作为独立调用方:Inner.run 体内
/// `foo()` 以 caller="run"、caller_class="Inner" 记录(旧实现漏)。
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

/// match pattern guard(`case 1 if foo():`)内调用:旧实现只走 subject 与
/// case.body,guard 漏;修复走查 guard。
#[test]
fn match_guard_calls_recorded() {
    let src = "def foo():\n    pass\n\ndef f(x):\n    match x:\n        case 1 if foo():\n            pass\n";
    let es = edges_of(src);
    assert!(
        es.iter().any(|e| e.caller == "f" && e.callee == "foo"),
        "match guard 内 foo() 应有边, got {es:?}"
    );
}

/// KR-AUD-20(KODE-AUD-008 残留面):方法体内嵌套 def 此前继承外层
/// caller_class,产伪 (Foo, inner) 类方法边。修复:嵌套 def 体走查传
/// caller_class=None——嵌套函数不是外层类的方法。
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
    // 外层方法的调用边不受影响。
    assert!(
        es.iter()
            .any(|e| e.caller == "method" && e.callee == "inner"),
        "外层方法走查保持"
    );
}

/// KR-AUD-21:口径统一——lambda 体内调用此前归外层 caller,嵌套 def 归自身
/// (KODE-AUD-008 口径)。统一为 lambda 体同样以自身 "<lambda>" 为 caller,
/// caller_class=None(与 KR-AUD-20 嵌套 def 不继承 caller_class 同口径)。
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
// 覆盖率补充:逐条覆盖 walk_stmt / walk_expr / dotted_chain / classify 分支。
// 每条断言真实语义(边存在、分类正确、调用点列号对齐),不做空断言。
// ---------------------------------------------------------------------------

/// 详细变体与基础变体产出逐条对齐(边集相等、顺序一致),且列号 ≥ 0
/// (调用点列号 0-based UTF-16;符号表 per-method calls 消费面)。
/// 源码三路齐备:类方法边、模块级函数边、模块顶层语句边——三类 caller
/// 的闭包写入路径各有至少一条边可产。
#[test]
fn detailed_variant_aligns_with_base_and_has_columns() {
    let src = "def target():\n    pass\n\ndef helper():\n    target()\n\nclass Avatar:\n    def on_damage(self):\n        helper()\n\nclass Empty:\n    x = 1\n\nhelper()\n";
    let ast = ParsedAst::new(src);
    let symbols = parse_ast_symbols(src).symbols;
    let base = extract_call_graph(&ast, &symbols);
    let detailed = extract_call_graph_detailed(&ast, &symbols);
    assert_eq!(detailed.len(), base.len(), "边数应逐条对齐");
    // 三路各一条:helper→target(模块级函数)、Avatar.on_damage→helper(类方法)、
    // <module>→helper(顶层语句);Empty 无方法 → if let 假分支照常走完。
    assert_eq!(detailed.len(), 3, "应有 3 条边: {detailed:#?}");
    for (i, (edge, col)) in detailed.iter().enumerate() {
        assert_eq!(edge, &base[i], "第 {i} 条边应与基础变体一致");
        // 调用点列号 0-based;类方法内与函数体内调用非行首,列号 > 0;
        // 模块顶层 helper() 在行首,列号可为 0。
        match edge.caller.as_str() {
            "on_damage" | "helper" => assert!(*col > 0, "体内调用列号应为正: {col}"),
            "<module>" => assert_eq!(*col, 0, "模块顶层调用列号应为 0: {col}"),
            other => panic!("意外 caller {other}: {edge:?}"),
        }
    }
    // 三路 caller 归属:类方法带类名,顶层语句是 <module>,模块级函数无类名。
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

/// walk_stmt 的 AnnAssign(带值/不带值)、Delete、Raise、Assert、elif、
/// While、With 分支:各构造内调用应被走查,调用点分类正确。
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
