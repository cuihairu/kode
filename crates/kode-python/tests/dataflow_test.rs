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
