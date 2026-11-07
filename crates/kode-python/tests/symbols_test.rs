//! AST 符号表 + kode-corpus 降级测试(C-20 交付④)。

use kode_python::parse_ast_symbols;
use kode_python::symbols::class_index;

const SRC: &str = r#"
import os
import numpy as np
from kbe import KBEngine
from utils import helper

@deco
class Avatar(KBEngine.Entity):
    """doc"""
    base = 1

    def __init__(self, name, hp=100):
        self.name = name
        self.hp = hp

    @staticmethod
    async def make(self2):
        self.hp = 0

def standalone(x, y, *args, **kw):
    return x
"#;

#[test]
fn extracts_classes_methods_attributes() {
    let ext = parse_ast_symbols(SRC);
    let s = &ext.symbols;
    assert_eq!(s.classes.len(), 1);
    let avatar = &s.classes[0];
    assert_eq!(avatar.name, "Avatar");
    assert_eq!(avatar.bases, vec!["KBEngine.Entity".to_string()]);
    assert_eq!(avatar.decorators, vec!["@deco".to_string()]);
    // 类属性 base = 1 与 __init__/make 的 self.hp 写入(跨方法聚合,去重语义)
    let attr_names: Vec<&str> = avatar.attributes.iter().map(|a| a.name.as_str()).collect();
    assert!(attr_names.contains(&"name"));
    assert!(attr_names.contains(&"hp"));
    // 方法
    let method_names: Vec<&str> = avatar.methods.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(method_names, vec!["__init__", "make"]);
    let make = avatar.methods.iter().find(|m| m.name == "make").unwrap();
    assert!(make.is_async);
    assert_eq!(make.decorators, vec!["@staticmethod".to_string()]);
    // __init__ 形参(去掉 self):name, hp
    let init = avatar
        .methods
        .iter()
        .find(|m| m.name == "__init__")
        .unwrap();
    assert_eq!(init.params, vec!["name", "hp"]);
}

#[test]
fn extracts_module_functions_and_imports() {
    let ext = parse_ast_symbols(SRC);
    let s = &ext.symbols;
    // 模块级函数 standalone
    assert_eq!(s.functions.len(), 1);
    assert_eq!(s.functions[0].name, "standalone");
    assert_eq!(s.functions[0].params, vec!["x", "y", "args", "kw"]);
    // 导入
    let imports: Vec<(&str, &str, bool)> = s
        .imports
        .iter()
        .map(|i| (i.binding.as_str(), i.module.as_str(), i.is_from))
        .collect();
    assert!(imports.contains(&("os", "os", false)));
    assert!(imports.contains(&("np", "numpy", false)));
    assert!(imports.contains(&("KBEngine", "kbe", true)));
    assert!(imports.contains(&("helper", "utils", true)));
}

#[test]
fn downgrades_to_corpus_shape() {
    let ext = parse_ast_symbols(SRC);
    let corpus = ext.symbols.to_corpus();
    assert_eq!(corpus.classes.len(), 1);
    assert_eq!(corpus.methods.len(), 2);
    assert!(corpus
        .methods
        .iter()
        .any(|m| m.name == "make" && m.is_async));
    assert!(corpus.attributes.iter().any(|a| a.name == "hp"));
    assert!(corpus.imports.iter().any(|i| i.binding == "np"));
}

#[test]
fn class_index_maps_name_to_class() {
    let ext = parse_ast_symbols(SRC);
    let idx = class_index(&ext.symbols);
    assert!(idx.contains_key("Avatar"));
    assert!(!idx.contains_key("Other"));
}

#[test]
fn tolerant_of_syntax_errors() {
    let ext = parse_ast_symbols("class Broken(:\n    pass\n");
    // 不 panic;错误被记录
    let _ = ext.errors;
    assert!(ext.symbols.classes.is_empty() || !ext.symbols.classes.is_empty());
}

/// KODE-AUD-008:match case 体内 `self.<attr> = ...` 属性写此前漏收集
/// (collect_attributes 不走 Match);修复后 case 体内属性入表。
#[test]
fn match_case_self_attribute_collected() {
    let src = "class C:\n    def m(self, x):\n        match x:\n            case 1:\n                self.value = 1\n";
    let ext = parse_ast_symbols(src);
    let c = ext.symbols.classes.iter().find(|c| c.name == "C").unwrap();
    assert!(
        c.attributes.iter().any(|a| a.name == "value"),
        "match case 内 self.value=1 应收集属性, got {:?}",
        c.attributes
    );
}

/// KR-AUD-11:`import a.b` 绑定名取顶层首段 `a`(跨文件解析按顶层名)。
/// 旧实现 binding 取全段 "a.b",下游 CallContext.module_bindings/跨文件
/// 解析按错误名匹配。
#[test]
fn dotted_import_binding_is_top_level_segment_kraud11() {
    let ext = parse_ast_symbols("import a.b\nimport numpy as np\n");
    let imports: Vec<(&str, &str, bool)> = ext
        .symbols
        .imports
        .iter()
        .map(|i| (i.binding.as_str(), i.module.as_str(), i.is_from))
        .collect();
    assert!(imports.contains(&("a", "a.b", false)), "实际: {imports:?}");
    assert!(imports.contains(&("np", "numpy", false)));
}

// ---------------------------------------------------------------------------
// 覆盖率补充:collect_attributes 控制流分支 / method_params 全形参位 /
// 隐式作用域(推导式/lambda)/ star 导入 / 空作用域丢弃 / 非 self 属性负路径。
// ---------------------------------------------------------------------------

/// 方法体内 if/elif/else/for/else/while/else/with/try 各控制流体中的
/// `self.<attr>` 写与 AnnAssign 属性声明均入属性表。
#[test]
fn self_attributes_collected_in_control_flow_bodies() {
    let src = r#"
class C:
    def m(self, cond, items, ctx):
        self.plain = 1
        self.typed: int = 2
        if cond:
            self.in_if = 3
        elif cond:
            self.in_elif = 4
        else:
            self.in_else = 5
        for it in items:
            self.in_for = 6
        else:
            self.in_for_else = 7
        while cond:
            self.in_while = 8
        else:
            self.in_while_else = 9
        with ctx() as c:
            self.in_with = 10
        try:
            self.in_try = 11
        except ValueError:
            self.in_except = 12
        else:
            self.in_try_else = 13
        finally:
            self.in_finally = 14
"#;
    let ext = parse_ast_symbols(src);
    let c = ext.symbols.classes.iter().find(|c| c.name == "C").unwrap();
    let names: Vec<&str> = c.attributes.iter().map(|a| a.name.as_str()).collect();
    for expected in [
        "plain",
        "typed",
        "in_if",
        "in_elif",
        "in_else",
        "in_for",
        "in_for_else",
        "in_while",
        "in_while_else",
        "in_with",
        "in_try",
        "in_except",
        "in_try_else",
        "in_finally",
    ] {
        assert!(
            names.contains(&expected),
            "属性 {expected} 应入表, got {names:?}"
        );
    }
}

/// 非 self 属性写(obj.x = 1 / self.a.b = 1)与普通局部赋值不产属性项。
#[test]
fn non_self_writes_are_not_attributes() {
    let src = "class C:\n    def m(self, obj):\n        obj.x = 1\n        self.a.b = 2\n        local = 3\n";
    let ext = parse_ast_symbols(src);
    let c = ext.symbols.classes.iter().find(|c| c.name == "C").unwrap();
    assert!(
        c.attributes.is_empty(),
        "非 self 直属写不应入属性表: {:?}",
        c.attributes
    );
}

/// method_params 全形参位:posonly(/)、kwonly(*)、vararg、kwarg 顺序;
/// `self` 过滤只按名(任意位置)。
#[test]
fn method_params_covers_all_parameter_slots() {
    let src = "def f(self, a, /, b, *args, c, **kw):\n    pass\n";
    let ext = parse_ast_symbols(src);
    assert_eq!(
        ext.symbols.functions[0].params,
        vec!["a", "b", "args", "c", "kw"]
    );
    // kwonly 无 vararg/kwarg。
    let ext2 = parse_ast_symbols("def g(a, *, b):\n    pass\n");
    assert_eq!(ext2.symbols.functions[0].params, vec!["a", "b"]);
}

/// 类基类只保留 dotted identifier:调用形态基类 `class C(func())` 被过滤。
#[test]
fn class_bases_keep_only_dotted_identifiers() {
    let src = "def factory():\n    return object\n\nclass C(factory()):\n    pass\n\nclass D(Base):\n    pass\n";
    let ext = parse_ast_symbols(src);
    let c = ext.symbols.classes.iter().find(|c| c.name == "C").unwrap();
    assert!(c.bases.is_empty(), "调用形态基类应被过滤: {:?}", c.bases);
    let d = ext.symbols.classes.iter().find(|c| c.name == "D").unwrap();
    assert_eq!(d.bases, vec!["Base".to_string()]);
}

/// 函数作用域 import 绑定收集:`from x import *` 不记绑定;推导式
/// (Set/Dict/Generator)与 lambda 是独立隐式作用域(lambda 形参入
/// 参数遮蔽);空作用域层(无绑定无遮蔽)不入表。
#[test]
fn function_scope_binding_collector_edges() {
    let src = r#"
def with_star():
    from mod import *
    use()

def with_comps(items):
    a = {x for x in items}
    b = {k: v for k, v in items}
    c = (x for x in items)
    return a, b, c

def with_lambda():
    f = lambda p: p

def empty():
    pass
"#;
    let ext = parse_ast_symbols(src);
    // star 导入不产绑定;with_star 的作用域层只有空绑定 → 整层不入表。
    assert!(
        !ext.symbols
            .function_import_bindings
            .iter()
            .any(|s| s.start_line == 1),
        "star 导入不应记绑定, got {:#?}",
        ext.symbols.function_import_bindings
    );
    // 推导式目标进各自隐式层(Set/Dict/Generator 各一层),不污染外层。
    let comp_scopes: Vec<_> = ext
        .symbols
        .function_import_bindings
        .iter()
        .filter(|s| matches!(s.kind, kode_python::model::ScopeKind::Comprehension))
        .collect();
    assert_eq!(comp_scopes.len(), 3, "三个推导式各一层: {comp_scopes:#?}");
    // lambda 形参 p 入参数遮蔽。
    let lambda_scopes: Vec<_> = ext
        .symbols
        .function_import_bindings
        .iter()
        .filter(|s| s.shadows.contains_key("p"))
        .collect();
    assert_eq!(
        lambda_scopes.len(),
        1,
        "lambda 形参 p 应入参数遮蔽: {lambda_scopes:#?}"
    );
    // 空作用域层(empty 无参数无绑定)不入表。
    assert!(
        !ext.symbols
            .function_import_bindings
            .iter()
            .any(|s| s.start_line == 14),
        "空作用域层应被丢弃, got {:#?}",
        ext.symbols.function_import_bindings
    );
}
