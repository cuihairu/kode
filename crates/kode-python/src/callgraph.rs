//! 方法级调用图 + KBEngine 特化边(C-20 交付①)。
//!
//! 从 AST 提取每个函数/方法体的调用边,并按 KBEngine 通道语义特化:
//! - `self.allClients.<client-method>(...)` → [`EdgeKind::KbeBroadcast`];
//! - `self.baseClients.<method>(...)` → [`EdgeKind::KbeBaseClients`];
//! - `self.cell.<method>(...)`(base→cell)/ `self.base.<method>(...)`(cell→base)/
//!   `self.client.<method>(...)`(cell→client)→ [`EdgeKind::KbeCrossProcess`]
//!   (进程归属方向由 `receiver` 字段区分,联动 C-17 进程语义);
//! - `KBEngine.<api>(...)` / `kbengine.<api>(...)` → [`EdgeKind::KbeApi`]。
//!
//! 分类是启发式的(动态语言无静态类型):`foo(...)` 在本文件有模块级函数或导入
//! 绑定 → [`EdgeKind::Local`];其余裸名 → [`EdgeKind::Unknown`]。

use std::collections::BTreeSet;

use ruff_python_ast::{self as ast, Expr, Stmt};
use ruff_text_size::Ranged;

use crate::model::{AstSymbols, CallEdge, EdgeKind};
use crate::parse::ParsedAst;

/// 调用上下文(由 AST 符号表派生,用于本地/导入判定)。
#[derive(Debug, Clone, Default)]
pub struct CallContext {
    /// 本文件模块级函数名。
    pub module_functions: BTreeSet<String>,
    /// 本文件导入绑定名(`from x import y` 的 y、`import x` 的 x/asname)。
    pub imported_bindings: BTreeSet<String>,
    /// 本文件导入的模块绑定名(`import os` 的 os、`import numpy as np` 的 np)。
    pub module_bindings: BTreeSet<String>,
}

impl CallContext {
    /// 从 AST 符号表构建(单文件内可解析的本地目标)。
    pub fn from_symbols(symbols: &AstSymbols) -> CallContext {
        let mut ctx = CallContext::default();
        for f in &symbols.functions {
            ctx.module_functions.insert(f.name.clone());
        }
        for i in &symbols.imports {
            if i.is_from {
                ctx.imported_bindings.insert(i.binding.clone());
            } else {
                ctx.module_bindings.insert(i.binding.clone());
            }
        }
        ctx
    }
}

/// 提取单文件全部调用边(类方法 + 模块级函数 + 模块顶层语句)。
pub fn extract_call_graph(ast: &ParsedAst, symbols: &AstSymbols) -> Vec<CallEdge> {
    let ctx = CallContext::from_symbols(symbols);
    let mut out = Vec::new();
    for stmt in &ast.module().body {
        match stmt {
            Stmt::ClassDef(cls) => {
                let class_name = cls.name.as_str().to_string();
                for s in &cls.body {
                    if let Stmt::FunctionDef(f) = s {
                        let caller = f.name.as_str().to_string();
                        walk_body(
                            ast,
                            &ctx,
                            &f.body,
                            Some(&class_name),
                            &caller,
                            &mut |edge, _| out.push(edge),
                        );
                    }
                }
            }
            Stmt::FunctionDef(f) => {
                let caller = f.name.as_str().to_string();
                walk_body(ast, &ctx, &f.body, None, &caller, &mut |edge, _| {
                    out.push(edge)
                });
            }
            _ => {
                walk_stmt(ast, &ctx, stmt, None, MODULE_CALLER, &mut |edge, _| {
                    out.push(edge)
                });
            }
        }
    }
    out
}

/// 调用边 + 调用点列(0-based UTF-16;符号表 per-method `calls` 用)。
///
/// 与 [`extract_call_graph`] 同一条走查(边集逐条相等,顺序一致),仅额外带出
/// 调用点列号——调用图边模型([`CallEdge`])保持只有行号,不为此改动 golden 面。
pub type DetailedCallEdge = (CallEdge, usize);

/// [`extract_call_graph`] 的带列变体(走查复用,产出逐条对齐)。
pub fn extract_call_graph_detailed(ast: &ParsedAst, symbols: &AstSymbols) -> Vec<DetailedCallEdge> {
    let ctx = CallContext::from_symbols(symbols);
    let mut out = Vec::new();
    for stmt in &ast.module().body {
        match stmt {
            Stmt::ClassDef(cls) => {
                let class_name = cls.name.as_str().to_string();
                for s in &cls.body {
                    if let Stmt::FunctionDef(f) = s {
                        let caller = f.name.as_str().to_string();
                        walk_body(
                            ast,
                            &ctx,
                            &f.body,
                            Some(&class_name),
                            &caller,
                            &mut |edge, character| out.push((edge, character)),
                        );
                    }
                }
            }
            Stmt::FunctionDef(f) => {
                let caller = f.name.as_str().to_string();
                walk_body(ast, &ctx, &f.body, None, &caller, &mut |edge, character| {
                    out.push((edge, character))
                });
            }
            _ => {
                walk_stmt(
                    ast,
                    &ctx,
                    stmt,
                    None,
                    MODULE_CALLER,
                    &mut |edge, character| out.push((edge, character)),
                );
            }
        }
    }
    out
}

/// 模块顶层调用边的 caller 占位名。
pub const MODULE_CALLER: &str = "<module>";

fn walk_body(
    ast: &ParsedAst,
    ctx: &CallContext,
    body: &[Stmt],
    caller_class: Option<&str>,
    caller: &str,
    out: &mut impl FnMut(CallEdge, usize),
) {
    for stmt in body {
        walk_stmt(ast, ctx, stmt, caller_class, caller, out);
    }
}

fn walk_stmt(
    ast: &ParsedAst,
    ctx: &CallContext,
    stmt: &Stmt,
    caller_class: Option<&str>,
    caller: &str,
    out: &mut impl FnMut(CallEdge, usize),
) {
    match stmt {
        Stmt::Expr(e) => walk_expr(ast, ctx, &e.value, caller_class, caller, out),
        Stmt::Assign(a) => {
            for t in &a.targets {
                walk_expr(ast, ctx, t, caller_class, caller, out);
            }
            walk_expr(ast, ctx, &a.value, caller_class, caller, out);
        }
        Stmt::AnnAssign(a) => {
            walk_expr(ast, ctx, &a.target, caller_class, caller, out);
            if let Some(v) = &a.value {
                walk_expr(ast, ctx, v, caller_class, caller, out);
            }
        }
        Stmt::AugAssign(a) => {
            walk_expr(ast, ctx, &a.target, caller_class, caller, out);
            walk_expr(ast, ctx, &a.value, caller_class, caller, out);
        }
        Stmt::Return(r) => {
            if let Some(v) = &r.value {
                walk_expr(ast, ctx, v, caller_class, caller, out);
            }
        }
        Stmt::Delete(d) => {
            for t in &d.targets {
                walk_expr(ast, ctx, t, caller_class, caller, out);
            }
        }
        Stmt::Raise(r) => {
            if let Some(e) = &r.exc {
                walk_expr(ast, ctx, e, caller_class, caller, out);
            }
        }
        Stmt::Assert(a) => {
            walk_expr(ast, ctx, &a.test, caller_class, caller, out);
            if let Some(m) = &a.msg {
                walk_expr(ast, ctx, m, caller_class, caller, out);
            }
        }
        Stmt::If(i) => {
            walk_expr(ast, ctx, &i.test, caller_class, caller, out);
            walk_body(ast, ctx, &i.body, caller_class, caller, out);
            for clause in &i.elif_else_clauses {
                if let Some(test) = &clause.test {
                    walk_expr(ast, ctx, test, caller_class, caller, out);
                }
                walk_body(ast, ctx, &clause.body, caller_class, caller, out);
            }
        }
        Stmt::For(f) => {
            walk_expr(ast, ctx, &f.iter, caller_class, caller, out);
            walk_body(ast, ctx, &f.body, caller_class, caller, out);
            walk_body(ast, ctx, &f.orelse, caller_class, caller, out);
        }
        Stmt::While(w) => {
            walk_expr(ast, ctx, &w.test, caller_class, caller, out);
            walk_body(ast, ctx, &w.body, caller_class, caller, out);
            walk_body(ast, ctx, &w.orelse, caller_class, caller, out);
        }
        Stmt::With(w) => {
            for item in &w.items {
                walk_expr(ast, ctx, &item.context_expr, caller_class, caller, out);
            }
            walk_body(ast, ctx, &w.body, caller_class, caller, out);
        }
        Stmt::Try(t) => {
            walk_body(ast, ctx, &t.body, caller_class, caller, out);
            for h in &t.handlers {
                let ast::ExceptHandler::ExceptHandler(inner) = h;
                if let Some(typ) = &inner.type_ {
                    walk_expr(ast, ctx, typ, caller_class, caller, out);
                }
                walk_body(ast, ctx, &inner.body, caller_class, caller, out);
            }
            walk_body(ast, ctx, &t.orelse, caller_class, caller, out);
            walk_body(ast, ctx, &t.finalbody, caller_class, caller, out);
        }
        Stmt::Match(m) => {
            walk_expr(ast, ctx, &m.subject, caller_class, caller, out);
            for case in &m.cases {
                // KODE-AUD-008:pattern guard(`case x if foo():`)内调用此前漏走。
                if let Some(g) = &case.guard {
                    walk_expr(ast, ctx, g, caller_class, caller, out);
                }
                walk_body(ast, ctx, &case.body, caller_class, caller, out);
            }
        }
        // KODE-AUD-008:嵌套 def/class 此前整体跳过(体内调用全漏)。现作为独立
        // 调用方记录:嵌套函数以自身名为 caller(外层函数调用仍由外层走查记录,
        // 不重叠);嵌套类的方法以嵌套类名为 caller_class。
        Stmt::FunctionDef(f) => {
            let nested = f.name.as_str().to_string();
            // KR-AUD-20(KODE-AUD-008 残留面):嵌套 def 不是外层类的方法——
            // caller_class 置 None,不再继承外层产伪 (Foo, inner) 类方法边。
            // 嵌套类的方法仍以嵌套类名为 caller_class(下方 ClassDef 分支)。
            walk_body(ast, ctx, &f.body, None, &nested, out);
        }
        Stmt::ClassDef(cls) => {
            let class_name = cls.name.as_str().to_string();
            for s in &cls.body {
                if let Stmt::FunctionDef(f) = s {
                    let m = f.name.as_str().to_string();
                    walk_body(ast, ctx, &f.body, Some(&class_name), &m, out);
                }
            }
        }
        Stmt::Import(_)
        | Stmt::ImportFrom(_)
        | Stmt::Global(_)
        | Stmt::Nonlocal(_)
        | Stmt::Pass(_)
        | Stmt::Break(_)
        | Stmt::Continue(_)
        | Stmt::TypeAlias(_)
        | Stmt::IpyEscapeCommand(_) => {}
    }
}

fn walk_expr(
    ast: &ParsedAst,
    ctx: &CallContext,
    expr: &Expr,
    caller_class: Option<&str>,
    caller: &str,
    out: &mut impl FnMut(CallEdge, usize),
) {
    use Expr::*;
    match expr {
        Call(c) => {
            record_call(ast, ctx, c, caller_class, caller, out);
            // 嵌套调用(callee 自身的子表达式、实参、关键字值)
            walk_expr(ast, ctx, &c.func, caller_class, caller, out);
            for a in &c.arguments.args {
                walk_expr(ast, ctx, a, caller_class, caller, out);
            }
            for k in &c.arguments.keywords {
                walk_expr(ast, ctx, &k.value, caller_class, caller, out);
            }
        }
        Attribute(a) => walk_expr(ast, ctx, &a.value, caller_class, caller, out),
        Subscript(s) => {
            walk_expr(ast, ctx, &s.value, caller_class, caller, out);
            walk_expr(ast, ctx, &s.slice, caller_class, caller, out);
        }
        BoolOp(b) => {
            for v in &b.values {
                walk_expr(ast, ctx, v, caller_class, caller, out);
            }
        }
        Named(n) => walk_expr(ast, ctx, &n.value, caller_class, caller, out),
        BinOp(b) => {
            walk_expr(ast, ctx, &b.left, caller_class, caller, out);
            walk_expr(ast, ctx, &b.right, caller_class, caller, out);
        }
        UnaryOp(u) => walk_expr(ast, ctx, &u.operand, caller_class, caller, out),
        Lambda(l) => walk_expr(ast, ctx, &l.body, caller_class, caller, out),
        If(e) => {
            walk_expr(ast, ctx, &e.test, caller_class, caller, out);
            walk_expr(ast, ctx, &e.body, caller_class, caller, out);
            walk_expr(ast, ctx, &e.orelse, caller_class, caller, out);
        }
        Dict(d) => {
            for item in &d.items {
                if let Some(k) = &item.key {
                    walk_expr(ast, ctx, k, caller_class, caller, out);
                }
                walk_expr(ast, ctx, &item.value, caller_class, caller, out);
            }
        }
        Set(s) => {
            for e in &s.elts {
                walk_expr(ast, ctx, e, caller_class, caller, out);
            }
        }
        List(l) => {
            for e in &l.elts {
                walk_expr(ast, ctx, e, caller_class, caller, out);
            }
        }
        Tuple(t) => {
            for e in &t.elts {
                walk_expr(ast, ctx, e, caller_class, caller, out);
            }
        }
        ListComp(c) => {
            walk_expr(ast, ctx, &c.elt, caller_class, caller, out);
            for gen in &c.generators {
                walk_expr(ast, ctx, &gen.iter, caller_class, caller, out);
                for if_ in &gen.ifs {
                    walk_expr(ast, ctx, if_, caller_class, caller, out);
                }
            }
        }
        SetComp(c) => {
            walk_expr(ast, ctx, &c.elt, caller_class, caller, out);
            for gen in &c.generators {
                walk_expr(ast, ctx, &gen.iter, caller_class, caller, out);
                for if_ in &gen.ifs {
                    walk_expr(ast, ctx, if_, caller_class, caller, out);
                }
            }
        }
        DictComp(c) => {
            if let Some(k) = &c.key {
                walk_expr(ast, ctx, k, caller_class, caller, out);
            }
            walk_expr(ast, ctx, &c.value, caller_class, caller, out);
            for gen in &c.generators {
                walk_expr(ast, ctx, &gen.iter, caller_class, caller, out);
                for if_ in &gen.ifs {
                    walk_expr(ast, ctx, if_, caller_class, caller, out);
                }
            }
        }
        Generator(c) => {
            walk_expr(ast, ctx, &c.elt, caller_class, caller, out);
            for gen in &c.generators {
                walk_expr(ast, ctx, &gen.iter, caller_class, caller, out);
                for if_ in &gen.ifs {
                    walk_expr(ast, ctx, if_, caller_class, caller, out);
                }
            }
        }
        Await(a) => walk_expr(ast, ctx, &a.value, caller_class, caller, out),
        Yield(y) => {
            if let Some(v) = &y.value {
                walk_expr(ast, ctx, v, caller_class, caller, out);
            }
        }
        YieldFrom(y) => walk_expr(ast, ctx, &y.value, caller_class, caller, out),
        Compare(c) => {
            for operand in &c.operands {
                walk_expr(ast, ctx, operand, caller_class, caller, out);
            }
        }
        Starred(s) => walk_expr(ast, ctx, &s.value, caller_class, caller, out),
        Slice(s) => {
            if let Some(l) = &s.lower {
                walk_expr(ast, ctx, l, caller_class, caller, out);
            }
            if let Some(u) = &s.upper {
                walk_expr(ast, ctx, u, caller_class, caller, out);
            }
            if let Some(st) = &s.step {
                walk_expr(ast, ctx, st, caller_class, caller, out);
            }
        }
        // f-string 内的嵌套调用在调用图中可忽略(MVP;表达式求值副作用不在
        // 方法级调用图范围)。
        FString(_) => {}
        // 字面量/名字:无子调用(名字作为被调方在 Call 分支已记录)
        Name(_) | StringLiteral(_) | BytesLiteral(_) | NumberLiteral(_) | BooleanLiteral(_)
        | NoneLiteral(_) | EllipsisLiteral(_) | TString(_) | IpyEscapeCommand(_) => {}
    }
}

/// 记录一条调用边:解析被调目标链并分类。
fn record_call(
    ast: &ParsedAst,
    ctx: &CallContext,
    call: &ast::ExprCall,
    caller_class: Option<&str>,
    caller: &str,
    out: &mut impl FnMut(CallEdge, usize),
) {
    let chain = dotted_chain(&call.func);
    let (receiver, callee) = match &chain {
        Some(v) if !v.is_empty() => {
            let callee = v.last().cloned().unwrap_or_default();
            let receiver = if v.len() >= 2 {
                Some(v[..v.len() - 1].join("."))
            } else {
                None
            };
            (receiver, callee)
        }
        _ => (None, String::new()),
    };
    let kind = classify(&chain, &callee, ctx);
    let (caller_line, caller_column) = ast.line_col(call.range().start().to_u32());
    out(
        CallEdge {
            caller_class: caller_class.map(str::to_string),
            caller: caller.to_string(),
            caller_line,
            callee,
            receiver,
            kind,
        },
        caller_column,
    );
}

/// 解析 dotted attribute 链(`self.cell.xxx` → `["self","cell","xxx"]`)。
fn dotted_chain(expr: &Expr) -> Option<Vec<String>> {
    match expr {
        Expr::Name(n) => Some(vec![n.id.as_str().to_string()]),
        Expr::Attribute(a) => {
            let mut base = dotted_chain(&a.value)?;
            base.push(a.attr.as_str().to_string());
            Some(base)
        }
        Expr::Subscript(s) => dotted_chain(&s.value),
        _ => None,
    }
}

/// 按 KBEngine 通道语义分类。
fn classify(chain: &Option<Vec<String>>, callee: &str, ctx: &CallContext) -> EdgeKind {
    let Some(v) = chain else {
        return EdgeKind::Unknown;
    };
    if v.is_empty() {
        return EdgeKind::Unknown;
    }
    match v[0].as_str() {
        "self" => match v.len() {
            1 => EdgeKind::SelfMethod, // `self(...)`(罕见;按自身调用记)
            2 => EdgeKind::SelfMethod,
            _ => match v[1].as_str() {
                "allClients" => EdgeKind::KbeBroadcast,
                "baseClients" => EdgeKind::KbeBaseClients,
                "cell" | "base" | "client" => EdgeKind::KbeCrossProcess,
                _ => EdgeKind::Method,
            },
        },
        "KBEngine" | "kbengine" => EdgeKind::KbeApi,
        _ => {
            if v.len() == 1 {
                if ctx.module_functions.contains(callee) || ctx.imported_bindings.contains(callee) {
                    EdgeKind::Local
                } else {
                    EdgeKind::Unknown
                }
            } else {
                // 导入模块调用(`mod.func`)与对象方法调用(`obj.method`)统一按
                // Method 记(动态语言无类型信息,细分类属过程间分析,不在 MVP)
                EdgeKind::Method
            }
        }
    }
}
