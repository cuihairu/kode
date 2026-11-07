//! 过程内 def-use 数据流测试(C-20 交付②,MVP 直线近似)。

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
    // 用 ruff 直接解析出方法体(测试用;不依赖 crate 内部封装)
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
    // 模块级函数体(测试用)
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
    // 形参:去掉 self 后 a, b
    let result = dataflow_for_body(&ast, &["a".to_string(), "b".to_string()], &body);
    let chains = &result.chains;

    // a 是参数:is_param,无 def_line,在 x=a+b 行(0-based 第 3 行)被读
    let a = chain(&result, "a");
    assert!(a.is_param);
    assert_eq!(a.def_line, None);
    assert_eq!(a.use_lines, vec![3]);

    // b 同
    let b = chain(&result, "b");
    assert!(b.is_param);
    assert_eq!(b.use_lines, vec![3]);

    // x 在行 3 定义,行 4(y=x*2)与行 5(z=y+x)被读
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(3));
    assert_eq!(x.use_lines, vec![4, 5]);

    // y 行 4 定义,行 5 被读
    let y = chain(&result, "y");
    assert_eq!(y.def_line, Some(4));
    assert_eq!(y.use_lines, vec![5]);

    // z 行 5 定义,行 6(print)与 7(return)被读
    let z = chain(&result, "z");
    assert_eq!(z.def_line, Some(5));
    assert_eq!(z.use_lines, vec![6, 7]);

    // 链数 = 2 参数 + x/y/z 各一次重定义(无重定义) = 5
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
    // 取模块级 f 的函数体
    let parsed = ruff_python_parser::parse_unchecked_source(src, Default::default());
    let body = match &parsed.syntax().body[0] {
        ruff_python_ast::Stmt::FunctionDef(f) => f.body.to_vec(),
        _ => unreachable!(),
    };
    let result = dataflow_for_body(&ast, &[], &body);
    let xs: Vec<_> = result.chains.iter().filter(|c| c.var == "x").collect();
    // x 两次定值 → 两条链(raw string 首行为空:行 1 = def f():,行 2 = x = 1)
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
    // raw string 首行为空 → 行 1 = class,行 6 = self.hp = self.hp - n;
    // 读 self.hp(无 prior 链,init 不在本函数体)→ 写 self.hp
    assert_eq!(hp.def_line, Some(6));
    // n 参数被读
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
// KODE-AUD-007:数据流 AST 语义缺陷修复验证。
// 5 项语义:AugAssign 读旧值 / del kill / Subscript 写侧读容器 /
// NamedExpr target 定义 / Comprehension generator target 定义。
// 判别性:每项修复前旧实现漏语义,修复后断言成立。
// ---------------------------------------------------------------------------

/// AugAssign `x += v`:target 是 Store 上下文但语义读旧值。旧实现
/// collect_reads 的 Name 分支只认 Load → 漏读旧 x;修复用 collect_reads_of
/// 强制读。断言第一条 x 链(定值于 x=1)在 x+=2 行被读。
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
    // x 两条链:x=1 定值,被 x+=2 读旧值;x+=2 定值新链。
    assert_eq!(xs.len(), 2, "x 应两链: {:?}", result.chains);
    assert_eq!(xs[0].def_line, Some(1));
    assert_eq!(xs[0].use_lines, vec![2], "x+=2 应读旧 x");
    assert_eq!(xs[1].def_line, Some(2));
}

/// `del x` 终结 x 当前链:后续 use(x) 不连旧链。旧实现走 collect_writes
/// 但 del 的 Name ctx 是 Del(非 Store)不认 → 旧链仍被后续读;修复 kill_var
/// 删 live 映射即终结。
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

/// Subscript 写侧 `a[0] = v` 语义读容器 a 与索引。旧实现只 collect_writes
/// s.value(漏读容器);修复写分支先 collect_reads(s.value)+collect_reads(s.slice)。
/// 容器 a 在 subscript 基座是 Load ctx(读容器找元素,不重定义变量 a),故 a
/// 单链:def=1(初值),use=[2(a[0]=5 读容器), 3(use(a) 读)]。判别:修复前 use=[3]
/// (漏行 2 容器读),修复后 [2,3]。
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

/// NamedExpr(walrus)`(n := v)`的 target 是 Store 上下文,须定义 n。旧实现
/// 只读 value 漏 def target;修复在 Named 分支 collect_writes(target)。
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

/// Comprehension generator target `[x for x in items]` 定义 x。旧实现只
/// collect_reads(iter)漏 def target;修复在 generator 循环 collect_writes(target)。
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
    // KR-AUD-09 语义更新:elt 本身的 `x` 读在 target def 之后,也连上链
    // (旧实现 elt 先读,漏记这次 use)。
    assert_eq!(x.use_lines, vec![1, 2]);
    // items 参数被 iter 读。
    let items = chain(&result, "items");
    assert!(items.is_param);
    assert_eq!(items.use_lines, vec![1]);
}

/// KR-AUD-09:推导式 elt 读先于 generator target 写,elt 内 def-use 断链
/// (`[str(x) for x in xs]` 的 str(x) 读不到 x 链)。修复:先按序走完
/// generators(iter 读/target 写/ifs 读),最后读 elt。
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
    // elt 内 str(x) 的读必须连上 generator target 定义的 x 链。
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(1), "generator target 应定义 x");
    assert_eq!(x.use_lines, vec![1], "elt 内 use 应连上 target 链");
    let xs = chain(&result, "xs");
    assert_eq!(xs.use_lines, vec![1]);
}

/// KR-AUD-10:dataflow 侧 match pattern 捕获名不 def、guard 不读(callgraph
/// 半边已由 KODE-AUD-008 闭合,本测只修 dataflow)。`case [a, b] if b > 0:`
/// 捕获 a/b 各 def 一条链,guard 内 b 的读、case 体内 a 的读均连上链。
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

/// KR-AUD-11:`import a.b` 的绑定名是顶层名 `a`(Python 语义),旧实现取全段
/// "a.b" 造链,后续 `a.attr` 的读断链。修复:无 asname 时取首段。
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

/// KR-AUD-16:`raise err` / `assert cond, msg` / `raise X(e) from c` 的表达式
/// 侧此前整体不走读(Stmt::Raise/Assert 落在无语义分支)。修复:exc/cause/
/// test/msg 全按读走查。
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

/// KR-AUD-17:except 捕获名的 def 行此前记在 try 语句行,应为 handler 自己的行。
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

/// KR-AUD-18:lambda 形参此前不建模遮蔽——`lambda x: x + 1` 体内对 x 的读
/// 连到外层参数 x 的链。修复:lambda 形参入独立子作用域,体内读先查子
/// 作用域,外层链不受影响。
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

/// KR-AUD-19:`global x` / `nonlocal x` 之后的赋值写的是外层绑定,不应建
/// 函数内局部 def 链(旧实现照常 def_var,产假局部链)。
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

/// KR-AUD-19(nonlocal 面):`nonlocal x` 后赋值同样不产局部链;未声明
/// nonlocal 的外层同名变量遮蔽语义不回归。
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
// 覆盖率补充:dataflow_for_module 全文件入口 + walk_stmt / collect_reads /
// collect_writes / collect_reads_of / kill_var / collect_pattern_captures /
// collect_comp_generators / lambda 形参 全分支。
// ---------------------------------------------------------------------------

/// 全文件入口:类方法与模块级函数各产出一条 MethodDataflow,类名/形参/
/// 定值行/使用行逐项对齐(单一口径,委托 method_params)。
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

/// AnnAssign(带值/不带值):`x: int = 1` 定义 x 并读右侧;`y: int` 仅定义。
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

/// If 的 elif/else 分支:各分支 test 按读走查(直线近似,不做交汇合并)。
/// 注:elif 的 test 读记在 If 语句起始行(walk_stmt 的 If 分支对全部
/// elif_else_clauses 复用语句行,与 except handler 的 KR-AUD-17 行定位
/// 口径不同——既有行为,不在此批改动)。
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

/// While test 读 / With 上下文读与 optional_vars 定义。
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

/// 函数体内 import / from-import / 嵌套 def / 嵌套 class 各定义一个绑定。
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

/// match pattern 各形态的捕获 def 与读面:值/单例/序列星号/mapping rest/
/// 类模式关键字/as 名/or 模式。
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
    // 序列模式:x 捕获、*rest 捕获,均在 case 行(7)。
    let x = chain(&result, "x");
    assert_eq!(x.def_line, Some(7));
    let rest = chain(&result, "rest");
    assert_eq!(rest.def_line, Some(7), "*rest 捕获 def");
    // mapping:键表达式与 **rest 捕获均在 case 行(9)。注:裸名键
    // (`{key: m_val}`)ruff 给 Store ctx,collect_reads 的 Name 分支只认
    // Load → 不记读(ruff 模式键解析的既有行为);键值捕获 def 照常。
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
    // 类模式:类名读、位置与关键字捕获(`py=pv` 经 MatchAs 捕获)、as 名,
    // 均在 case 行(11)。(`py=0` 是属性对字面量的匹配,不产捕获。)
    let px = chain(&result, "px");
    assert_eq!(px.def_line, Some(11));
    let pv = chain(&result, "pv");
    assert_eq!(pv.def_line, Some(11), "关键字模式捕获 def");
    let whole = chain(&result, "whole");
    assert_eq!(whole.def_line, Some(11), "as 名 def");
    // or 模式:as 名捕获在 case 行(13)。
    let either = chain(&result, "either");
    assert_eq!(either.def_line, Some(13), "or 模式 as 名 def");
    // 主题读保持。
    let v = chain(&result, "v");
    assert_eq!(v.use_lines, vec![2]);
}

/// 推导式各形态(Set/SetComp/DictComp/Generator/Tuple)与 if 过滤:
/// iter 读 → target 写 → ifs 读 → elt 读(KR-AUD-09 顺序)。
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
    // a 的读:行 2(set 元素)、3(tuple)、4(dict value)、5/6/7/8(各推导式
    // 的 if 与 elt 同行,去重计一次)、4 已含。slice 无 a。
    let a = chain(&result, "a");
    assert_eq!(
        a.use_lines,
        vec![2, 3, 4, 5, 6, 7, 8],
        "a 的读行应覆盖各容器/推导式: {:?}",
        a.use_lines
    );
    // b 只在 tuple 被读。
    let b = chain(&result, "b");
    assert_eq!(b.use_lines, vec![3]);
    // k 在 dict 字面量与 DictComp 的 key 侧被读。
    let k = chain(&result, "k");
    assert_eq!(k.use_lines, vec![4, 7]);
    // items 是四个推导式的 iter 与 slice 基座。
    let items = chain(&result, "items");
    assert_eq!(items.use_lines, vec![5, 6, 7, 8, 9]);
    // 推导式 target 定义 x(四个推导式共享同名 target,重定义各开新链)。
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

/// lambda 形参(posonly 默认值/vararg/kwarg)与体内读遮蔽(KR-AUD-18)。
#[test]
fn lambda_params_and_defaults_are_scoped() {
    let src = "def f(base):\n    g = lambda x=base, *args, **kw: x\n    return g()\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &["base".into()], &body);
    // 默认值在外层作用域求值:base 在 lambda 推层前被读。
    let base = chain(&result, "base");
    assert_eq!(base.use_lines, vec![1], "lambda 默认值读外层 base");
    // lambda 形参 x/args/kw 各一条参数链;体内 x 读连 lambda 形参链。
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
    // g = lambda ... 赋值本身定义 g(非参数链),形参遮蔽断言不受影响。
    let g = chain(&result, "g");
    assert_eq!(g.def_line, Some(1));
    assert!(!g.is_param);
}

/// AugAssign 的 Subscript/Attribute target(读旧值语义,KODE-AUD-007)。
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

/// 非 self 属性写(obj.attr = 1)不产 def 链(对象字段不可静态跟踪)。
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

/// 元组/列表/星号解包写(Store 元组解包各元素 def)。
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

/// 元组/列表/星号 target 的 AugAssign(ruff 语法恢复形态):读旧值
/// (collect_reads_of 的 Tuple/List/Starred 分支)后再开新链。
#[test]
fn augassign_tuple_list_targets_read_elements() {
    let src =
        "def f():\n    a = 1\n    b = 2\n    (a, b) += 1\n    [a, b] += 2\n    (c, *d) += 3\n";
    let ast = ParsedAst::new(src);
    let body = body_of_func(src, "f");
    let result = dataflow_for_body(&ast, &[], &body);
    // 行号:def f(0)、a=1(1)、b=2(2)、(a,b)+=1(3)、[a,b]+=2(4)、
    // (c,*d)+=3(5)。
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
    // (c, *d) += 3:c 与 *d 各开新链(读旧值——两者先前未定义,无读可记)。
    let c = chain(&result, "c");
    assert_eq!(c.def_line, Some(5));
    let d = chain(&result, "d");
    assert_eq!(d.def_line, Some(5), "星号 target 亦 def");
}

/// kill 各形态:del 名 / del self.attr / del a[i] / del 元组 / del 列表 /
/// del 星号——删除后 use 不连旧链(KODE-AUD-007 kill 语义)。
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
    // 行号(raw string 首行空):x=1(行2)、del x(3)、use(x)(4)、
    // self.attr=1(5)、del(6)、use(7)、a=[1](8)、del a[0](9)、use(a)(10)、
    // (p,q)=(11)、del(p,q)(12)、use(p)(13)、(r,s)=(14)、del[r,s](15)、
    // (t,u)=(16)、del t,u(17)、use(t)(18)。
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
    // del a[0] 在终结前读容器 a(找元素),故 use 记 del 行;后续 use(a) 不连。
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

/// kill 其余形态:未定义名(作用域穷尽)、星号 target、非 self 属性、
/// 以及 `del (a + b)` 的语法恢复形态(未识别 target 整体跳过,不 panic)。
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
    // 行号(raw 首行空):del notdefined(2)、del self.notdefined(3)、
    // del obj.attr(4)、a=1(5)、b=2(6)、del a,*b(7)、del (c+d)(8)。
    let a = chain(&result, "a");
    assert_eq!(a.def_line, Some(5));
    assert!(a.use_lines.is_empty(), "del a 终结 a: {:?}", a.use_lines);
    let b = chain(&result, "b");
    assert_eq!(b.def_line, Some(6));
    assert!(b.use_lines.is_empty(), "del *b 终结 b: {:?}", b.use_lines);
    // 未识别的 BinOp target 不产链、不 panic。
    assert!(
        !result.chains.iter().any(|c| c.var == "c" || c.var == "d"),
        "del (c + d) 不应产 c/d 链: {:#?}",
        result.chains
    );
}

/// 写 target 的未识别形态(ruff 语法恢复):`(a + b) = 1` / `f() = 1` 不产链。
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

/// AugAssign 的未识别 target(ruff 语法恢复):`(a + b) += 1` 走 collect_reads
/// 兜底分支(表达式的 Load 读照常记),不 panic。
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
    // BinOp target 不开新链。
    let as_: Vec<_> = result.chains.iter().filter(|c| c.var == "a").collect();
    assert_eq!(as_.len(), 1, "未识别 target 不重定义 a");
}

/// AugAssign 非 self 属性 target(`obj.attr += 1` 读 obj 链,写不产链)。
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

/// 读侧剩余形态:关键字实参值、BoolOp、UnaryOp、条件表达式、Starred。
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
    // 行号:use(x=a)(2)、y(3)、w(4)、q(5)、st(6)。
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
    // 关键字名 x 不是读。
    assert!(
        !result.chains.iter().any(|c| c.var == "x"),
        "关键字名不产链: {:#?}",
        result.chains
    );
}

/// async 生成器:await / yield / yield from 的值按读走查。
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

/// dataflow_for_module 忽略模块级非 class/def 语句(仅收集方法与函数)。
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
