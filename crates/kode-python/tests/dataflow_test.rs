//! 过程内 def-use 数据流测试(C-20 交付②,MVP 直线近似)。

use kode_python::dataflow::dataflow_for_body;
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
