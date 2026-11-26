//! Intraprocedural def-use dataflow tests (C-20 deliverable 2, MVP straight-line approximation).

use kode_python::dataflow::{dataflow_for_body, dataflow_for_module};
use kode_python::ParsedAst;

fn chain<'a>(result: &'a kode_python::DataflowResult, var: &str) -> &'a kode_python::DefUseChain {
    result
        .chains
        .iter()
        .find(|c| c.var == var)
        .unwrap_or_else(|| panic!("缺变量链 {var}: {:#?}", result.chains))
}

fn body_of_method(src: &str, method: &str) -> (Vec<String>, Vec<ruff_python_ast::Stmt>) {
    // Parse the method body directly with ruff (test-only; does not depend on crate-internal wrappers)
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let module = parsed.syntax();
    for stmt in &module.body {
        if let ruff_python_ast::Stmt::ClassDef(cls) = stmt {
            for s in &cls.body {
                if let ruff_python_ast::Stmt::FunctionDef(f) = s {
                    if f.name.as_str() == method {
                        return (vec![], f.body.to_vec());
                    }
                }
            }
        }
    }
    panic!("method {method} not found");
}

fn body_of_func(src: &str, func: &str) -> Vec<ruff_python_ast::Stmt> {
    // Module-level function body (test-only)
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    for stmt in &parsed.syntax().body {
        if let ruff_python_ast::Stmt::FunctionDef(f) = stmt {
            if f.name.as_str() == func {
                return f.body.to_vec();
            }
        }
    }
    panic!("func {func} not found");
}

fn chain_in<'a>(
    ms: &'a [kode_python::MethodDataflow],
    method: &str,
    var: &str,
) -> &'a kode_python::DefUseChain {
    let m = ms
        .iter()
        .find(|m| m.method == method)
        .unwrap_or_else(|| panic!("缺方法 {method}"));
    m.result
        .chains
        .iter()
        .find(|c| c.var == var)
        .unwrap_or_else(|| panic!("方法 {method} 缺变量链 {var}: {:#?}", m.result.chains))
}

#[test]
fn def_use_chain_straight_line() {
    let src = r#"
class Foo:
    def compute(self, a, b):
        x = a + b
        y = x * 2
        z = y + x
        print(z)
        return z
"#;
    let ast = ParsedAst::new(src);
    let (_, body) = body_of_method(src, "compute");
    // Params: a, b after removing self
    let result = dataflow_for_body(&ast, &["a".to_string(), "b".to_string()], &body);
    let chains = &result.chains;

    // a is a param: is_param, no def_line, read on the x=a+b line (0-based line 3)
    let a = chain(&result, "a");
    assert!(a.is_param);
    assert_eq!(a.def_line, None);
    assert_eq!(a.use_lines, vec![3]);

    // b likewise
    let b = chain(&result, "b");
    assert!(b.is_param);
    assert_eq!(b.use_lines, vec![3]);

    // x defined on line 3, read on line 4 (y=x*2) and line 5 (z=y+x)
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(3));
    assert_eq!(x.use_lines, vec![4, 5]);

    // y defined on line 4, read on line 5
    let y = chain(&result, "y");
    assert_eq!(y.def_line, Some(4));
    assert_eq!(y.use_lines, vec![5]);

    // z defined on line 5, read on line 6 (print) and 7 (return)
    let z = chain(&result, "z");
    assert_eq!(z.def_line, Some(5));
    assert_eq!(z.use_lines, vec![6, 7]);

    // Chain count = 2 params + x/y/z each defined once (no redefinition) = 5
    assert_eq!(chains.len(), 5);
}

#[test]
fn redefinition_starts_new_chain() {
    let src = r#"
def f():
    x = 1
    print(x)
    x = 2
    print(x)
"#;
    let ast = ParsedAst::new(src);
    // Take the body of module-level f
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let xs: Vec<_> = result.chains.iter().filter(|c| c.var == "x").collect();
    // x defined twice -> two chains (the raw string's first line is empty: line 1 = def f():, line 2 = x = 1)
    assert_eq!(xs.len(), 2);
    assert_eq!(xs[0].def_line, Some(2));
    assert_eq!(xs[0].use_lines, vec![3]);
    assert_eq!(xs[1].def_line, Some(4));
    assert_eq!(xs[1].use_lines, vec![5]);
}

#[test]
fn self_attribute_tracked() {
    let src = r#"
class Avatar:
    def init(self):
        self.hp = 100
        self.damage(10)
    def damage(self, n):
        self.hp = self.hp - n
"#;
    let ast = ParsedAst::new(src);
    let (_, body) = body_of_method(src, "damage");
    let result = dataflow_for_body(&ast, &["n".to_string()], &body);
    let hp = chain(&result, "self.hp");
    // The raw string's first line is empty -> line 1 = class, line 6 = self.hp = self.hp - n;
    // reading self.hp (no prior chain; init is not in this function body) -> writing self.hp
    assert_eq!(hp.def_line, Some(6));
    // The n param is read
    let n = chain(&result, "n");
    assert!(n.is_param);
}

#[test]
fn for_loop_var_is_def() {
    let src = "def f(items):\n    for it in items:\n        use(it)\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &["items".to_string()], &body);
    let it = chain(&result, "it");
    assert_eq!(it.def_line, Some(1));
    assert_eq!(it.use_lines, vec![2]);
}

// ---------------------------------------------------------------------------
// KODE-AUD-007: verification of the dataflow AST semantic defect fixes.
// 5 semantics: AugAssign reads the old value / del kills / Subscript write side reads the container /
// NamedExpr target defines / Comprehension generator target defines.
// Discriminative: before each fix the old implementation missed the semantics; after the fix
// the assertions hold.
// ---------------------------------------------------------------------------

/// AugAssign `x += v`: the target is a Store context but semantically reads the old value. The old
/// implementation's collect_reads Name branch only recognized Load -> the old x read was missed;
/// the fix forces the read via collect_reads_of. Asserts the first x chain (defined at x=1) is read
/// on the x+=2 line.
#[test]
fn augassign_reads_old_value() {
    let src = "def f():\n    x = 1\n    x += 2\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let xs: Vec<_> = result.chains.iter().filter(|c| c.var == "x").collect();
    // Two x chains: x=1 defines and is read as old value by x+=2; x+=2 defines the new chain.
    assert_eq!(xs.len(), 2, "x 应两链: {:?}", result.chains);
    assert_eq!(xs[0].def_line, Some(1));
    assert_eq!(xs[0].use_lines, vec![2], "x+=2 应读旧 x");
    assert_eq!(xs[1].def_line, Some(2));
}

/// `del x` terminates x's current chain: later use(x) does not link to the old chain. The old
/// implementation went through collect_writes, but del's Name ctx is Del (not Store) and was not
/// recognized -> the old chain still absorbed later reads; the fix has kill_var delete the live
/// mapping, which terminates the chain.
#[test]
fn del_kills_chain() {
    let src = "def f():\n    x = 1\n    del x\n    use(x)\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(1));
    assert!(
        x.use_lines.is_empty(),
        "del x 后 use(x) 不应连旧链: {:?}",
        x.use_lines
    );
}

/// Subscript write side `a[0] = v` semantically reads container a and the index. The old
/// implementation only collect_writes'd s.value (missing the container read); the fix's write branch
/// first does collect_reads(s.value)+collect_reads(s.slice).
/// Container a at the subscript base is a Load ctx (reading the container to find the element,
/// not redefining variable a), so a is a single chain: def=1 (initial value),
/// use=[2 (a[0]=5 reads the container), 3 (use(a) reads)]. Discriminative: before the fix use=[3]
/// (missing the line 2 container read), after the fix [2,3].
#[test]
fn subscript_write_reads_container() {
    let src = "def f():\n    a = [1]\n    a[0] = 5\n    use(a)\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let xs: Vec<_> = result.chains.iter().filter(|c| c.var == "a").collect();
    assert_eq!(xs.len(), 1, "a 应单链(容器读不重定义): {:?}", result.chains);
    assert_eq!(xs[0].def_line, Some(1));
    assert_eq!(xs[0].use_lines, vec![2, 3], "a[0]=5 应读容器 a");
}

/// NamedExpr (walrus) `(n := v)`: the target is a Store context and must define n. The old
/// implementation only read the value and missed the target def; the fix does collect_writes(target)
/// in the Named branch.
#[test]
fn namedexpr_target_defined() {
    let src = "def f():\n    (n := 1)\n    use(n)\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let n = chain(&result, "n");
    assert_eq!(n.def_line, Some(1), "walrus 应定义 n");
    assert_eq!(n.use_lines, vec![2]);
}

/// Comprehension generator target `[x for x in items]` defines x. The old implementation only
/// collect_reads(iter) and missed the target def; the fix does collect_writes(target) in the
/// generator loop.
#[test]
fn comprehension_target_defined() {
    let src = "def f(items):\n    vals = [x for x in items]\n    use(x)\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &["items".to_string()], &body);
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(1), "comprehension target 应定义 x");
    // KR-AUD-09 semantics update: the `x` read of elt itself comes after the target def and also
    // links to the chain (the old implementation read elt first and failed to record this use).
    assert_eq!(x.use_lines, vec![1, 2]);
    // The items param is read by iter.
    let items = chain(&result, "items");
    assert!(items.is_param);
    assert_eq!(items.use_lines, vec![1]);
}

/// KR-AUD-09: comprehension elt reads happened before the generator target write, breaking the
/// def-use chain inside elt (in `[str(x) for x in xs]` the str(x) could not reach x's chain).
/// Fix: walk the generators in order first (iter read / target write / ifs read), then read elt last.
#[test]
fn comprehension_elt_use_links_to_generator_target_kraud09() {
    let src = "def f(xs):\n    r = [str(x) for x in xs]\n    return r\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &["xs".to_string()], &body);
    // The str(x) read inside elt must link to the x chain defined by the generator target.
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(1), "generator target 应定义 x");
    assert_eq!(x.use_lines, vec![1], "elt 内 use 应连上 target 链");
    let xs = chain(&result, "xs");
    assert_eq!(xs.use_lines, vec![1]);
}

/// KR-AUD-10: on the dataflow side, match pattern capture names did not def and the guard did not read
/// (the callgraph half was closed out by KODE-AUD-008; this test only fixes dataflow).
/// `case [a, b] if b > 0:` captures a/b, each defining a chain; the b read in the guard and the
/// a read in the case body both link to the chains.
#[test]
fn match_pattern_captures_def_and_guard_reads_kraud10() {
    let src = "def f(v):\n    match v:\n        case [a, b] if b > 0:\n            return a\n        case _:\n            return None\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &["v".to_string()], &body);
    let a = chain(&result, "a");
    assert_eq!(a.def_line, Some(2), "pattern 捕获 a 应在 case 行 def");
    assert_eq!(a.use_lines, vec![3], "case 体内 return a 应连上捕获链");
    let b = chain(&result, "b");
    assert_eq!(b.def_line, Some(2), "pattern 捕获 b 应在 case 行 def");
    assert_eq!(b.use_lines, vec![2], "guard 内 b 的读应连上捕获链");
    let v = chain(&result, "v");
    assert_eq!(v.use_lines, vec![1], "match subject 读保持");
}

/// KR-AUD-11: the binding name of `import a.b` is the top-level name `a` (Python semantics); the old
/// implementation built the chain from the full dotted "a.b", breaking later `a.attr` reads. Fix:
/// take the first segment when there is no asname.
#[test]
fn dotted_import_binds_top_level_name_kraud11() {
    let src = "def f():\n    import a.b\n    return a.c\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let a = chain(&result, "a");
    assert_eq!(a.def_line, Some(1), "import a.b 应按顶层名 a def");
    assert_eq!(a.use_lines, vec![2], "a.c 的读应连上 import 链");
}

/// KR-AUD-16: the expression sides of `raise err` / `assert cond, msg` / `raise X(e) from c` were
/// never walked as reads before (Stmt::Raise/Assert fell into a branch with no semantics). Fix:
/// exc/cause/test/msg are all walked as reads.
#[test]
fn raise_and_assert_expressions_are_reads_kraud16() {
    let src = "def f(err, cond, msg):\n    raise err\n    assert cond, msg\n    raise ValueError(err) from cond\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &["err".into(), "cond".into(), "msg".into()], &body);
    let err = chain(&result, "err");
    assert_eq!(
        err.use_lines,
        vec![1, 3],
        "raise err 与 raise X(err) 均应读 err"
    );
    let cond = chain(&result, "cond");
    assert_eq!(
        cond.use_lines,
        vec![2, 3],
        "assert test 与 from cause 均应读 cond"
    );
    let msg = chain(&result, "msg");
    assert_eq!(msg.use_lines, vec![2], "assert msg 应读 msg");
}

/// KR-AUD-17: the except capture name's def line was previously recorded on the try statement line; it should be the handler's own line.
#[test]
fn except_capture_def_line_is_handler_line_kraud17() {
    let src = "def f():\n    try:\n        risky()\n    except ValueError as e:\n        log(e)\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let e = chain(&result, "e");
    assert_eq!(e.def_line, Some(3), "except 捕获名 def 行应为 handler 行");
    assert_eq!(e.use_lines, vec![4]);
}

/// KR-AUD-18: lambda params previously had no shadow modeling -- reads of x inside `lambda x: x + 1`'s
/// body linked to the outer parameter x's chain. Fix: lambda params enter an independent sub-scope;
/// body reads consult the sub-scope first and the outer chain is unaffected.
#[test]
fn lambda_param_shadows_outer_var_kraud18() {
    let src = "def f(x):\n    g = lambda x: x + 1\n    return g(x)\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &["x".to_string()], &body);
    let x_chains: Vec<&kode_python::DefUseChain> =
        result.chains.iter().filter(|c| c.var == "x").collect();
    assert_eq!(
        x_chains.len(),
        2,
        "外层参数与 lambda 形参各一条链: {:#?}",
        result.chains
    );
    let outer = x_chains[0];
    assert!(outer.is_param);
    assert_eq!(outer.use_lines, vec![2], "外层 x 只应在 return g(x) 被读");
    let lam = x_chains[1];
    assert!(lam.is_param, "lambda 形参按参数链记");
    assert_eq!(lam.def_line, None);
    assert_eq!(lam.use_lines, vec![1], "lambda 体内读连 lambda 形参链");
}

/// KR-AUD-19: assignments after `global x` / `nonlocal x` write the outer binding and must not build a
/// function-local def chain (the old implementation def_var'd as usual, producing a spurious local chain).
#[test]
fn global_declared_assignment_makes_no_local_chain_kraud19() {
    let src = "def f():\n    global counter\n    counter = 1\n    return counter\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    assert!(
        !result.chains.iter().any(|c| c.var == "counter"),
        "global 名不应产局部链: {:#?}",
        result.chains
    );
}

/// KR-AUD-19 (nonlocal face): assignments after `nonlocal x` likewise produce no local chain; the
/// shadowing semantics of an outer same-named variable without a nonlocal declaration must not regress.
#[test]
fn nonlocal_declared_assignment_makes_no_local_chain_kraud19() {
    let src = "def f():\n    nonlocal total\n    total = 0\n    other = 1\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    assert!(!result.chains.iter().any(|c| c.var == "total"));
    assert!(result.chains.iter().any(|c| c.var == "other"));
}

// ---------------------------------------------------------------------------
// Coverage addenda: dataflow_for_module whole-file entry + walk_stmt / collect_reads /
// collect_writes / collect_reads_of / kill_var / collect_pattern_captures /
// collect_comp_generators / lambda params, all branches.
// ---------------------------------------------------------------------------

/// Whole-file entry: class methods and module-level functions each yield one MethodDataflow, with
/// class name / params / def lines / use lines aligned item by item (single semantics, delegating to method_params).
#[test]
fn dataflow_for_module_collects_methods_and_functions() {
    let src = r#"
class Avatar:
    def on_hp(self, n):
        self.hp = self.hp - n
        return self.hp

def standalone(a, b):
    x = a + b
    return x
"#;
    let ast = ParsedAst::new(src);
    let ms = dataflow_for_module(&ast);
    assert_eq!(ms.len(), 2, "类方法与模块级函数各一条: {ms:#?}");
    let m = &ms[0];
    assert_eq!(m.class.as_deref(), Some("Avatar"));
    assert_eq!(m.method, "on_hp");
    assert_eq!(m.params, vec!["n"], "形参过滤 self");
    let hp = chain_in(&ms, "on_hp", "self.hp");
    assert_eq!(hp.def_line, Some(3));
    assert_eq!(hp.use_lines, vec![4]);
    let f = &ms[1];
    assert_eq!(f.class, None, "模块级函数 class=None");
    assert_eq!(f.method, "standalone");
    assert_eq!(f.params, vec!["a", "b"]);
    let x = chain_in(&ms, "standalone", "x");
    assert_eq!(x.def_line, Some(7));
    assert_eq!(x.use_lines, vec![8]);
}

/// AnnAssign (with value / without): `x: int = 1` defines x and reads the right side; `y: int` only defines.
#[test]
fn annassign_defines_with_and_without_value() {
    let src = "def f():\n    x: int = 1\n    use(x)\n    y: int\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(1), "带值 AnnAssign 定义 x");
    assert_eq!(x.use_lines, vec![2]);
    let y = chain(&result, "y");
    assert_eq!(y.def_line, Some(3), "不带值 AnnAssign 仅定义 y");
    assert!(y.use_lines.is_empty());
}

/// If's elif/else branches: each branch's test is walked as a read (straight-line approximation, no
/// merge at join points).
/// Note: an elif's test read is recorded on the If statement's start line (walk_stmt's If branch
/// reuses the statement line for all elif_else_clauses, a different line-attribution contract than the
/// except handler's KR-AUD-17 -- existing behavior, not changed in this batch).
#[test]
fn if_elif_else_tests_are_reads() {
    let src = "def f(a, b):\n    if a:\n        pass\n    elif b:\n        pass\n    else:\n        pass\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["a".into(), "b".into()], &body);
    let a = chain(&result, "a");
    assert_eq!(a.use_lines, vec![1], "if test 读 a");
    let b = chain(&result, "b");
    assert_eq!(b.use_lines, vec![1], "elif test 读 b(记 If 语句行)");
}

/// While test reads / With context reads and optional_vars definitions.
#[test]
fn while_and_with_are_walked() {
    let src =
        "def f(cond, ctx):\n    while cond:\n        pass\n    with ctx() as c:\n        use(c)\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["cond".into(), "ctx".into()], &body);
    let cond = chain(&result, "cond");
    assert_eq!(cond.use_lines, vec![1], "while test 读 cond");
    let ctx = chain(&result, "ctx");
    assert_eq!(ctx.use_lines, vec![3], "with 上下文表达式读 ctx");
    let c = chain(&result, "c");
    assert_eq!(c.def_line, Some(3), "with as c 定义 c");
    assert_eq!(c.use_lines, vec![4], "体 内 use(c) 连链");
}

/// Function-body import / from-import / nested def / nested class each define one binding.
#[test]
fn local_import_and_nested_defs_define_bindings() {
    let src = "def f():\n    import a.b\n    from kbe import KBEngine\n    def inner():\n        pass\n    class C:\n        pass\n    return a\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    let a = chain(&result, "a");
    assert_eq!(a.def_line, Some(1), "import a.b 绑顶层名 a");
    assert_eq!(a.use_lines, vec![7], "return a 连 import 链");
    let kbe = chain(&result, "KBEngine");
    assert_eq!(kbe.def_line, Some(2), "from-import 绑 KBEngine");
    let inner = chain(&result, "inner");
    assert_eq!(inner.def_line, Some(3), "嵌套 def 定义 inner");
    let c = chain(&result, "C");
    assert_eq!(c.def_line, Some(5), "嵌套 class 定义 C");
}

/// Capture defs and read faces for each match pattern form: value/singleton/sequence star/
/// mapping rest/class-pattern keyword/as name/or pattern.
#[test]
fn match_pattern_variants_capture_and_read() {
    let src = r#"
def f(v, key):
    match v:
        case 1:
            pass
        case None:
            pass
        case [x, *rest]:
            pass
        case {key: m_val, **m_rest}:
            pass
        case Point(px, py=pv) as whole:
            pass
        case First() | Second() as either:
            pass
"#;
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["v".into(), "key".into()], &body);
    // Sequence pattern: x capture, *rest capture, both on the case line (7).
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(7));
    let rest = chain(&result, "rest");
    assert_eq!(rest.def_line, Some(7), "*rest 捕获 def");
    // mapping: key expressions and the **rest capture are both on the case line (9). Note: for a
    // bare name key (`{key: m_val}`) ruff gives a Store ctx, and collect_reads's Name branch only
    // recognizes Load -> no read recorded (existing behavior of ruff's pattern-key parsing); the
    // key value capture def is normal.
    let key = chain(&result, "key");
    assert!(
        key.use_lines.is_empty(),
        "裸名映射键不按 Load 读: {:?}",
        key.use_lines
    );
    let m_val = chain(&result, "m_val");
    assert_eq!(m_val.def_line, Some(9));
    let m_rest = chain(&result, "m_rest");
    assert_eq!(m_rest.def_line, Some(9), "**rest 捕获 def");
    // Class pattern: class name read, positional and keyword captures (`py=pv` captured via
    // MatchAs), and the as name are all on the case line (11). (`py=0` is an attribute-against-
    // literal match and produces no capture.)
    let px = chain(&result, "px");
    assert_eq!(px.def_line, Some(11));
    let pv = chain(&result, "pv");
    assert_eq!(pv.def_line, Some(11), "关键字模式捕获 def");
    let whole = chain(&result, "whole");
    assert_eq!(whole.def_line, Some(11), "as 名 def");
    // or pattern: the as-name capture is on the case line (13).
    let either = chain(&result, "either");
    assert_eq!(either.def_line, Some(13), "or 模式 as 名 def");
    // The subject read is preserved.
    let v = chain(&result, "v");
    assert_eq!(v.use_lines, vec![2]);
}

/// Comprehension forms (Set/SetComp/DictComp/Generator/Tuple) with if filters:
/// iter read -> target write -> ifs read -> elt read (KR-AUD-09 order).
#[test]
fn comprehension_and_container_forms_are_walked() {
    let src = r#"
def f(a, b, items, k):
    s = {a}
    t = (a, b)
    d = {k: a}
    c1 = [a for x in items if a]
    c2 = {a for x in items if a}
    c3 = {k: a for x in items if a}
    c4 = (a for x in items if a)
    sl = items[1:2:3]
"#;
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(
        &ast,
        &["a".into(), "b".into(), "items".into(), "k".into()],
        &body,
    );
    // Reads of a: line 2 (set element), 3 (tuple), 4 (dict value), 5/6/7/8 (each
    // comprehension's if and elt share a line, deduplicated to one count); 4 is
    // already included. The slice has no a.
    let a = chain(&result, "a");
    assert_eq!(
        a.use_lines,
        vec![2, 3, 4, 5, 6, 7, 8],
        "a 的读行应覆盖各容器/推导式: {:?}",
        a.use_lines
    );
    // b is read only in the tuple.
    let b = chain(&result, "b");
    assert_eq!(b.use_lines, vec![3]);
    // k is read in the dict literal and on the DictComp key side.
    let k = chain(&result, "k");
    assert_eq!(k.use_lines, vec![4, 7]);
    // items is the iter and the slice base of the four comprehensions.
    let items = chain(&result, "items");
    assert_eq!(items.use_lines, vec![5, 6, 7, 8, 9]);
    // Comprehension targets define x (the four comprehensions share the same target name; each
    // redefinition opens a new chain).
    let xs: Vec<_> = result.chains.iter().filter(|c| c.var == "x").collect();
    assert_eq!(
        xs.len(),
        4,
        "四个推导式 target 各一条 x 链: {:#?}",
        result.chains
    );
    assert_eq!(xs[0].def_line, Some(5));
    assert_eq!(xs[3].def_line, Some(8));
}

/// Lambda params (posonly defaults / vararg / kwarg) and in-body read shadowing (KR-AUD-18).
#[test]
fn lambda_params_and_defaults_are_scoped() {
    let src = "def f(base):\n    g = lambda x=base, *args, **kw: x\n    return g()\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["base".into()], &body);
    // The default value is evaluated in the outer scope: base is read before the lambda pushes its layer.
    let base = chain(&result, "base");
    assert_eq!(base.use_lines, vec![1], "lambda 默认值读外层 base");
    // Lambda params x/args/kw each have one param chain; the in-body x read links to the lambda param chain.
    let xs: Vec<_> = result.chains.iter().filter(|c| c.var == "x").collect();
    assert_eq!(xs.len(), 1, "x 只有 lambda 形参链: {:#?}", result.chains);
    assert!(xs[0].is_param);
    assert_eq!(xs[0].def_line, None);
    assert_eq!(xs[0].use_lines, vec![1], "lambda 体内 x 读连形参链");
    let args = chain(&result, "args");
    assert!(args.is_param);
    assert!(args.use_lines.is_empty(), "vararg 未使用也保留空链");
    let kw = chain(&result, "kw");
    assert!(kw.is_param);
    assert!(kw.use_lines.is_empty());
    // The `g = lambda ...` assignment itself defines g (not a param chain); the param-shadowing assertions are unaffected.
    let g = chain(&result, "g");
    assert_eq!(g.def_line, Some(1));
    assert!(!g.is_param);
}

/// AugAssign with Subscript/Attribute targets (read-old-value semantics, KODE-AUD-007).
#[test]
fn augassign_subscript_and_attribute_read_old_value() {
    let src = "def f(self):\n    a = [1]\n    a[0] += 1\n    self.x += 1\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    let a = chain(&result, "a");
    assert_eq!(a.def_line, Some(1));
    assert_eq!(a.use_lines, vec![2], "a[0] += 1 应读容器 a");
    let hp = chain(&result, "self.x");
    assert_eq!(hp.def_line, Some(3), "self.x += 1 开新属性链");
    assert!(hp.use_lines.is_empty());
}

/// Non-self attribute writes (obj.attr = 1) produce no def chain (object fields are not statically trackable).
#[test]
fn non_self_attribute_write_makes_no_chain() {
    let src = "def f(obj):\n    obj.attr = 1\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["obj".into()], &body);
    assert!(
        !result.chains.iter().any(|c| c.var == "obj.attr"),
        "非 self 属性写不应产链: {:#?}",
        result.chains
    );
    assert!(
        !result.chains.iter().any(|c| c.var == "attr"),
        "属性名不落局部链: {:#?}",
        result.chains
    );
}

/// Tuple/list/starred unpack writes (each element of a Store tuple unpack defs).
#[test]
fn tuple_list_starred_unpack_writes() {
    let src = "def f():\n    (a, b) = (1, 2)\n    [c, d] = (3, 4)\n    e, *rest = (5, 6)\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    for (var, line) in [
        ("a", 1),
        ("b", 1),
        ("c", 2),
        ("d", 2),
        ("e", 3),
        ("rest", 3),
    ] {
        let ch = chain(&result, var);
        assert_eq!(ch.def_line, Some(line), "{var} 应在行 {line} 定义");
    }
}

/// AugAssign with tuple/list/starred targets (ruff syntax-recovery forms): read the old value
/// (collect_reads_of's Tuple/List/Starred branches) before opening a new chain.
#[test]
fn augassign_tuple_list_targets_read_elements() {
    let src =
        "def f():\n    a = 1\n    b = 2\n    (a, b) += 1\n    [a, b] += 2\n    (c, *d) += 3\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    // Line numbers: def f(0), a=1(1), b=2(2), (a,b)+=1(3), [a,b]+=2(4),
    // (c,*d)+=3(5).
    let as_: Vec<_> = result.chains.iter().filter(|c| c.var == "a").collect();
    assert_eq!(
        as_.len(),
        3,
        "a 应三链(初值/元组写/列表写): {:#?}",
        result.chains
    );
    assert_eq!(as_[0].def_line, Some(1));
    assert_eq!(as_[0].use_lines, vec![3], "(a, b) += 1 读旧 a");
    assert_eq!(as_[1].def_line, Some(3));
    assert_eq!(as_[1].use_lines, vec![4], "[a, b] += 2 读上一链 a");
    assert_eq!(as_[2].def_line, Some(4));
    let bs: Vec<_> = result.chains.iter().filter(|c| c.var == "b").collect();
    assert_eq!(bs.len(), 3);
    assert_eq!(bs[0].def_line, Some(2));
    assert_eq!(bs[0].use_lines, vec![3], "(a, b) += 1 读旧 b");
    assert_eq!(bs[1].def_line, Some(3));
    assert_eq!(bs[1].use_lines, vec![4]);
    // (c, *d) += 3: c and *d each open a new chain (old-value reads -- neither was previously defined,
    // so no reads to record).
    let c = chain(&result, "c");
    assert_eq!(c.def_line, Some(5));
    let d = chain(&result, "d");
    assert_eq!(d.def_line, Some(5), "星号 target 亦 def");
}

/// kill forms: del name / del self.attr / del a[i] / del tuple / del list /
/// del starred -- after deletion, use no longer links to the old chain (KODE-AUD-007 kill semantics).
#[test]
fn del_variants_kill_chains() {
    let src = r#"
def f(self):
    x = 1
    del x
    use(x)
    self.attr = 1
    del self.attr
    use(self.attr)
    a = [1]
    del a[0]
    use(a)
    (p, q) = (1, 2)
    del (p, q)
    use(p)
    (r, s) = (1, 2)
    del [r, s]
    (t, u) = (1, 2)
    del t, u
    use(t)
"#;
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    // Line numbers (raw string's first line is empty): x=1(line 2), del x(3), use(x)(4),
    // self.attr=1(5), del(6), use(7), a=[1](8), del a[0](9), use(a)(10),
    // (p,q)=(11), del(p,q)(12), use(p)(13), (r,s)=(14), del[r,s](15),
    // (t,u)=(16), del t,u(17), use(t)(18).
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(2));
    assert!(
        x.use_lines.is_empty(),
        "del x 后 use(x) 不连旧链: {:?}",
        x.use_lines
    );
    let attr = chain(&result, "self.attr");
    assert_eq!(attr.def_line, Some(5));
    assert!(
        attr.use_lines.is_empty(),
        "del self.attr 后读不连旧链: {:?}",
        attr.use_lines
    );
    let a = chain(&result, "a");
    assert_eq!(a.def_line, Some(8));
    // del a[0] reads container a (to find the element) before terminating, so use records the del
    // line; later use(a) does not link.
    assert_eq!(
        a.use_lines,
        vec![9],
        "del a[0] 读容器后终结: {:?}",
        a.use_lines
    );
    let p = chain(&result, "p");
    assert_eq!(p.def_line, Some(11));
    assert!(
        p.use_lines.is_empty(),
        "del (p, q) 终结 p: {:?}",
        p.use_lines
    );
    let r = chain(&result, "r");
    assert_eq!(r.def_line, Some(14));
    assert!(
        r.use_lines.is_empty(),
        "del [r, s] 终结 r: {:?}",
        r.use_lines
    );
    let t = chain(&result, "t");
    assert_eq!(t.def_line, Some(16));
    assert!(t.use_lines.is_empty(), "del t, u 终结 t: {:?}", t.use_lines);
    let u = chain(&result, "u");
    assert_eq!(u.def_line, Some(16));
    assert!(u.use_lines.is_empty(), "del t, u 终结 u: {:?}", u.use_lines);
}

/// Remaining kill forms: an undefined name (scope exhausted), a starred target, a non-self attribute,
/// and the `del (a + b)` syntax-recovery form (the unrecognized target is skipped whole, no panic).
#[test]
fn del_unbound_and_starred_and_unhandled_targets() {
    let src = r#"
def f(self, obj):
    del notdefined
    del self.notdefined
    del obj.attr
    a = 1
    b = 2
    del a, *b
    del (c + d)
"#;
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    // Line numbers (raw first line empty): del notdefined(2), del self.notdefined(3),
    // del obj.attr(4), a=1(5), b=2(6), del a,*b(7), del (c+d)(8).
    let a = chain(&result, "a");
    assert_eq!(a.def_line, Some(5));
    assert!(a.use_lines.is_empty(), "del a 终结 a: {:?}", a.use_lines);
    let b = chain(&result, "b");
    assert_eq!(b.def_line, Some(6));
    assert!(b.use_lines.is_empty(), "del *b 终结 b: {:?}", b.use_lines);
    // An unrecognized BinOp target produces no chain and no panic.
    assert!(
        !result.chains.iter().any(|c| c.var == "c" || c.var == "d"),
        "del (c + d) 不应产 c/d 链: {:#?}",
        result.chains
    );
}

/// Unrecognized write-target forms (ruff syntax recovery): `(a + b) = 1` / `f() = 1` produce no chain.
#[test]
fn assign_unhandled_targets_are_ignored() {
    let src = "def f():\n    (a + b) = 1\n    f() = 2\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    assert!(
        !result.chains.iter().any(|c| c.var == "a" || c.var == "b"),
        "BinOp 写 target 不产链: {:#?}",
        result.chains
    );
    assert!(
        !result.chains.iter().any(|c| c.var == "f"),
        "Call 写 target 不产链: {:#?}",
        result.chains
    );
}

/// AugAssign with an unrecognized target (ruff syntax recovery): `(a + b) += 1` goes through the
/// collect_reads fallback branch (the expression's Load reads are recorded as usual), no panic.
#[test]
fn augassign_unhandled_target_falls_back_to_reads() {
    let src = "def f(a, b):\n    (a + b) += 1\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["a".into(), "b".into()], &body);
    let a = chain(&result, "a");
    assert_eq!(a.use_lines, vec![1], "(a + b) += 1 的 BinOp 左值按读兜底");
    let b = chain(&result, "b");
    assert_eq!(b.use_lines, vec![1]);
    // A BinOp target opens no new chain.
    let as_: Vec<_> = result.chains.iter().filter(|c| c.var == "a").collect();
    assert_eq!(as_.len(), 1, "未识别 target 不重定义 a");
}

/// AugAssign with a non-self attribute target (`obj.attr += 1` reads obj's chain; the write produces no chain).
#[test]
fn augassign_non_self_attribute_reads_base() {
    let src = "def f(obj):\n    obj.attr += 1\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["obj".into()], &body);
    let obj = chain(&result, "obj");
    assert_eq!(obj.use_lines, vec![1], "非 self 属性增强赋值递归读 obj");
    assert!(
        !result.chains.iter().any(|c| c.var == "obj.attr"),
        "非 self 属性写不产链: {:#?}",
        result.chains
    );
}

/// Remaining read-side forms: keyword argument values, BoolOp, UnaryOp, conditional expressions, Starred.
#[test]
fn read_side_expression_forms() {
    let src = r#"
def f(a, b, items):
    use(x=a)
    y = a and b
    w = -a
    q = a if b else a
    st = [*items]
"#;
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["a".into(), "b".into(), "items".into()], &body);
    // Line numbers: use(x=a)(2), y(3), w(4), q(5), st(6).
    let a = chain(&result, "a");
    assert_eq!(
        a.use_lines,
        vec![2, 3, 4, 5],
        "a:关键字值/BoolOp/一元/条件各读一次: {:?}",
        a.use_lines
    );
    let b = chain(&result, "b");
    assert_eq!(b.use_lines, vec![3, 5], "b:BoolOp 与条件 test 各读一次");
    let items = chain(&result, "items");
    assert_eq!(items.use_lines, vec![6], "Starred 读 items");
    // The keyword name x is not a read.
    assert!(
        !result.chains.iter().any(|c| c.var == "x"),
        "关键字名不产链: {:#?}",
        result.chains
    );
}

/// async generators: await / yield / yield from values are walked as reads.
#[test]
fn async_generator_reads_are_collected() {
    let src = "async def af(a):\n    await a\n    yield a\n    yield from a\n";
    let ast = ParsedAst::new(src);
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &["a".into()], &body);
    let a = chain(&result, "a");
    assert_eq!(
        a.use_lines,
        vec![1, 2, 3],
        "await/yield/yield from 各读一次 a: {:?}",
        a.use_lines
    );
}

/// dataflow_for_module ignores module-level non-class/def statements (only methods and functions are collected).
#[test]
fn module_level_plain_statements_are_skipped() {
    let src = "X = 1\n\ndef f():\n    return X\n\nclass C:\n    def m(self):\n        pass\n";
    let ast = ParsedAst::new(src);
    let ms = dataflow_for_module(&ast);
    assert_eq!(ms.len(), 2, "只收模块级函数与类方法: {ms:#?}");
    assert_eq!(ms[0].method, "f");
    assert_eq!(ms[1].method, "m");
    assert_eq!(ms[1].class.as_deref(), Some("C"));
}
