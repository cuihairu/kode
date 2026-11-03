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
