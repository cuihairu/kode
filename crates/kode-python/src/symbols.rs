//! AST → 符号表(类/方法/属性/导入四表,C-20 交付④)。
//!
//! 与 kode-corpus 的词法表同构但基于 ruff AST:能正确识别装饰器/async/继承链,
//! 且不依赖缩进启发式。产出 [`AstSymbols`],可经 [`AstSymbols::to_corpus`] 降级为
//! [`kode_corpus::PythonModule`],供 C-19 一致性检查与 wt/parity 直接对拍
//! (「替代 C-19 自建」)。

use kode_corpus::{AttributeSymbol, ClassSymbol, ImportSymbol, MethodSymbol, PythonModule};
use ruff_python_ast::{self as ast, Expr, Stmt};

use crate::model::{AstAttribute, AstClass, AstFunction, AstImport, AstMethod, AstSymbols};
use crate::parse::ParsedAst;

/// 符号抽取结果(AST 符号表 + 解析错误,供诊断面)。
#[derive(Debug)]
pub struct AstExtraction {
    pub symbols: AstSymbols,
    /// ruff 语法错误(格式化字符串;空 = 无)。
    pub errors: Vec<String>,
}

/// 解析并抽取 AST 符号表。
pub fn parse_ast_symbols(source: &str) -> AstExtraction {
    let ast = ParsedAst::new(source);
    let errors: Vec<String> = ast.errors().iter().map(|e| format!("{e:?}")).collect();
    let symbols = extract(&ast);
    AstExtraction { symbols, errors }
}

/// 从已解析 AST 抽取符号表(纯函数,供增量面复用同一抽取)。
pub fn extract(ast: &ParsedAst) -> AstSymbols {
    let mut out = AstSymbols {
        line_count: ast.line_count(),
        classes: Vec::new(),
        functions: Vec::new(),
        imports: Vec::new(),
    };
    for stmt in &ast.module().body {
        match stmt {
            Stmt::ClassDef(cls) => out.classes.push(extract_class(ast, cls)),
            Stmt::FunctionDef(f) => out.functions.push(extract_function(ast, f)),
            Stmt::Import(imp) => {
                for alias in &imp.names {
                    out.imports.push(AstImport {
                        binding: alias
                            .asname
                            .as_ref()
                            .map(|n| n.as_str().to_string())
                            .unwrap_or_else(|| alias.name.as_str().to_string()),
                        module: alias.name.as_str().to_string(),
                        symbol: None,
                        line: ast.line_col(imp.range.start().to_u32()).0,
                        is_from: false,
                    });
                }
            }
            Stmt::ImportFrom(impf) => {
                let module = impf
                    .module
                    .as_ref()
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                let line = ast.line_col(impf.range.start().to_u32()).0;
                for alias in &impf.names {
                    out.imports.push(AstImport {
                        binding: alias
                            .asname
                            .as_ref()
                            .map(|n| n.as_str().to_string())
                            .unwrap_or_else(|| alias.name.as_str().to_string()),
                        module: module.clone(),
                        symbol: Some(alias.name.as_str().to_string()),
                        line,
                        is_from: true,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// 类名 → 类索引(供 C-19/wt-parity 查类方法)。
pub fn class_index(symbols: &AstSymbols) -> std::collections::BTreeMap<&str, &AstClass> {
    symbols
        .classes
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect()
}

fn extract_class(ast: &ParsedAst, cls: &ast::StmtClassDef) -> AstClass {
    let (start_line, _start_char) = ast.line_col(cls.range.start().to_u32());
    let end_line = ast.line_col(cls.range.end().to_u32()).0;
    let name = cls.name.as_str().to_string();
    let bases: Vec<String> = cls
        .arguments
        .as_ref()
        .map(|args| {
            args.args
                .iter()
                .filter_map(dotted_name)
                .filter(|b| b != "object")
                .collect()
        })
        .unwrap_or_default();
    let decorators = decorators(ast, &cls.decorator_list);

    let mut methods = Vec::new();
    let mut attributes = Vec::new();
    for stmt in &cls.body {
        if let Stmt::FunctionDef(f) = stmt {
            methods.push(extract_method(ast, &name, f));
            collect_attributes(ast, &name, &f.body, &mut attributes);
        }
    }
    AstClass {
        name: name.clone(),
        qualified_name: name,
        bases,
        start_line,
        end_line,
        methods,
        attributes,
        decorators,
    }
}

fn extract_method(ast: &ParsedAst, class: &str, f: &ast::StmtFunctionDef) -> AstMethod {
    let (line, character) = ast.line_col(f.range.start().to_u32());
    let end_line = ast.line_col(f.range.end().to_u32()).0;
    AstMethod {
        class: class.to_string(),
        name: f.name.as_str().to_string(),
        line,
        character,
        is_async: f.is_async,
        decorators: decorators(ast, &f.decorator_list),
        params: method_params(&f.parameters),
        end_line,
    }
}

fn extract_function(ast: &ParsedAst, f: &ast::StmtFunctionDef) -> AstFunction {
    let (line, character) = ast.line_col(f.range.start().to_u32());
    let end_line = ast.line_col(f.range.end().to_u32()).0;
    AstFunction {
        name: f.name.as_str().to_string(),
        line,
        character,
        is_async: f.is_async,
        decorators: decorators(ast, &f.decorator_list),
        params: method_params(&f.parameters),
        end_line,
    }
}

/// 形参名(posonly → pos → kwonly → vararg → kwarg 顺序;`self` 不计入)。
///
/// 公开供 kode-server 的 dataflow 消费面复用(同一排序口径,防两套语义漂移)。
pub fn method_params(p: &ast::Parameters) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |name: &str| {
        if name != "self" {
            out.push(name.to_string());
        }
    };
    for a in &p.posonlyargs {
        push(a.parameter.name.as_str());
    }
    for a in &p.args {
        push(a.parameter.name.as_str());
    }
    if let Some(v) = &p.vararg {
        push(v.name.as_str());
    }
    for a in &p.kwonlyargs {
        push(a.parameter.name.as_str());
    }
    if let Some(k) = &p.kwarg {
        push(k.name.as_str());
    }
    out
}

/// 装饰器源码文本(ruff 的 Decorator range 已含 `@`,按源码顺序)。
fn decorators(ast: &ParsedAst, list: &[ast::Decorator]) -> Vec<String> {
    list.iter()
        .map(|d| {
            let range = d.range;
            let start = range.start().to_u32() as usize;
            let end = range.end().to_u32() as usize;
            ast.source
                .get(start..end)
                .unwrap_or("")
                .trim_end()
                .to_string()
        })
        .collect()
}

/// 递归收集方法体内 `self.<name> = ...` 属性写入。
fn collect_attributes(ast: &ParsedAst, class: &str, body: &[Stmt], out: &mut Vec<AstAttribute>) {
    for stmt in body {
        match stmt {
            Stmt::Assign(a) => {
                for target in &a.targets {
                    if let Some(name) = self_attribute(ast, target) {
                        out.push(AstAttribute {
                            class: class.to_string(),
                            name,
                            line: ast.line_col(a.range.start().to_u32()).0,
                            character: ast.line_col(a.range.start().to_u32()).1,
                        });
                    }
                }
            }
            Stmt::AnnAssign(a) => {
                if let Some(name) = self_attribute(ast, &a.target) {
                    out.push(AstAttribute {
                        class: class.to_string(),
                        name,
                        line: ast.line_col(a.range.start().to_u32()).0,
                        character: ast.line_col(a.range.start().to_u32()).1,
                    });
                }
            }
            Stmt::AugAssign(a) => {
                if let Some(name) = self_attribute(ast, &a.target) {
                    out.push(AstAttribute {
                        class: class.to_string(),
                        name,
                        line: ast.line_col(a.range.start().to_u32()).0,
                        character: ast.line_col(a.range.start().to_u32()).1,
                    });
                }
            }
            Stmt::If(i) => {
                collect_attributes(ast, class, &i.body, out);
                for clause in &i.elif_else_clauses {
                    collect_attributes(ast, class, &clause.body, out);
                }
            }
            Stmt::For(f) => {
                collect_attributes(ast, class, &f.body, out);
                collect_attributes(ast, class, &f.orelse, out);
            }
            Stmt::While(w) => {
                collect_attributes(ast, class, &w.body, out);
                collect_attributes(ast, class, &w.orelse, out);
            }
            Stmt::With(w) => {
                collect_attributes(ast, class, &w.body, out);
            }
            Stmt::Try(t) => {
                collect_attributes(ast, class, &t.body, out);
                for h in &t.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    collect_attributes(ast, class, &inner.body, out);
                }
                collect_attributes(ast, class, &t.orelse, out);
                collect_attributes(ast, class, &t.finalbody, out);
            }
            Stmt::FunctionDef(_) | Stmt::ClassDef(_) => {
                // 嵌套 def/class 不收集(与 kode-corpus「类直属」口径一致)
            }
            _ => {}
        }
    }
}

/// target 是 `self.<name>` 时返回 `<name>`。
fn self_attribute(_ast: &ParsedAst, expr: &Expr) -> Option<String> {
    if let Expr::Attribute(attr) = expr {
        if let Expr::Name(n) = attr.value.as_ref() {
            if n.id.as_str() == "self" {
                return Some(attr.attr.as_str().to_string());
            }
        }
    }
    None
}

/// 取表达式为 dotted identifier(如 `Base`、`kbe.Entity`);非标识符 → None。
fn dotted_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Name(n) => Some(n.id.as_str().to_string()),
        Expr::Attribute(a) => {
            let base = dotted_name(&a.value)?;
            Some(format!("{base}.{}", a.attr.as_str()))
        }
        _ => None,
    }
}

/// 降级为 kode-corpus 词法表(C-19 / wt/parity 复用面)。
impl AstSymbols {
    pub fn to_corpus(&self) -> PythonModule {
        let mut classes = Vec::new();
        let mut methods = Vec::new();
        let mut attributes = Vec::new();
        for c in &self.classes {
            classes.push(ClassSymbol {
                name: c.name.clone(),
                qualified_name: c.qualified_name.clone(),
                bases: c.bases.clone(),
                start_line: c.start_line,
                end_line: c.end_line,
            });
            for m in &c.methods {
                methods.push(MethodSymbol {
                    class: m.class.clone(),
                    name: m.name.clone(),
                    line: m.line,
                    character: m.character,
                    is_async: m.is_async,
                    decorators: m.decorators.clone(),
                });
            }
            for a in &c.attributes {
                attributes.push(AttributeSymbol {
                    class: a.class.clone(),
                    name: a.name.clone(),
                    line: a.line,
                    character: a.character,
                });
            }
        }
        let imports = self
            .imports
            .iter()
            .map(|i| ImportSymbol {
                binding: i.binding.clone(),
                module: i.module.clone(),
                symbol: i.symbol.clone(),
                line: i.line,
                is_from: i.is_from,
            })
            .collect();
        PythonModule {
            line_count: self.line_count,
            classes,
            methods,
            attributes,
            imports,
            instances: Vec::new(),
        }
    }
}
