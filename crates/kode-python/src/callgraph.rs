//! Method-level call graph + KBEngine-specialized edges (C-20 delivery item 1).
//!
//! Extracts the call edges of every function / method body from the AST, specialized by KBEngine
//! channel semantics:
//! - `self.allClients.<client-method>(...)` -> [`EdgeKind::KbeBroadcast`];
//! - `self.baseClients.<method>(...)` -> [`EdgeKind::KbeBaseClients`];
//! - `self.cell.<method>(...)` (base->cell) / `self.base.<method>(...)` (cell->base) /
//!   `self.client.<method>(...)` (cell->client) -> [`EdgeKind::KbeCrossProcess`]
//!   (the process-ownership direction is carried by the `receiver` field, interplaying with C-17
//!   process semantics);
//! - `KBEngine.<api>(...)` / `kbengine.<api>(...)` -> [`EdgeKind::KbeApi`].
//!
//! Classification is heuristic (a dynamic language has no static types): `foo(...)` with a
//! module-level function or import binding in this file -> [`EdgeKind::Local`]; remaining bare
//! names -> [`EdgeKind::Unknown`].

use std::collections::BTreeSet;

use ruff_python_ast::{self as ast, Expr, Stmt};
use ruff_text_size::Ranged;

use crate::model::{AstSymbols, CallEdge, EdgeKind};
use crate::parse::ParsedAst;

/// Call context (derived from the AST symbol tables, used for local / import determination).
#[derive(Debug, Clone, Default)]
pub struct CallContext {
    /// Names of the module-level functions of this file.
    pub module_functions: BTreeSet<String>,
    /// Import binding names of this file (`y` of `from x import y`, `x` / the asname of `import x`).
    pub imported_bindings: BTreeSet<String>,
    /// Module binding names imported by this file (`os` of `import os`, `np` of `import numpy as np`).
    pub module_bindings: BTreeSet<String>,
}

impl CallContext {
    /// Build from the AST symbol tables (local targets resolvable within a single file).
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

/// Extract all call edges of a single file (class methods + module-level functions + module
/// top-level statements).
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

/// Call edge + the call-site column (0-based UTF-16; used by the symbol tables' per-method
/// `calls`).
///
/// Same walk as [`extract_call_graph`] (the edge sets are equal item by item, in the same order),
/// just additionally emitting the call-site column -- the call-graph edge model ([`CallEdge`])
/// keeps line numbers only, and the golden face is not changed for this.
pub type DetailedCallEdge = (CallEdge, usize);

/// The column-carrying variant of [`extract_call_graph`] (walk reused, output aligned item by item).
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

/// Caller placeholder name for module top-level call edges.
pub const MODULE_CALLER: &str = "<module>";

/// Caller placeholder name for call edges inside a lambda body (KR-AUD-21: unified with the nested
/// def "is its own caller" semantics; several lambdas share this name, so call sites are told apart
/// by caller_line).
pub const LAMBDA_CALLER: &str = "<lambda>";

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
                // KODE-AUD-008: calls inside a pattern guard (`case x if foo():`) were previously not walked.
                if let Some(g) = &case.guard {
                    walk_expr(ast, ctx, g, caller_class, caller, out);
                }
                walk_body(ast, ctx, &case.body, caller_class, caller, out);
            }
        }
        // KODE-AUD-008: nested def/class was previously skipped as a whole (calls inside were all missed).
        // It is now recorded as an independent caller: a nested function uses its own name as
        // caller (the outer function call is still recorded by the outer walk, so there is no
        // overlap); a nested class's methods use the nested class name as caller_class.
        Stmt::FunctionDef(f) => {
            let nested = f.name.as_str().to_string();
            // KR-AUD-20 (residual of KODE-AUD-008): a nested def is not a method of the outer
            // class -- caller_class is set to None, so it no longer inherits the outer and
            // produces a fake (Foo, inner) class-method edge.
            // A nested class's methods still use the nested class name as caller_class (the
            // ClassDef branch below).
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
            // Nested calls (sub-expressions of the callee itself, arguments, keyword values).
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
        // KR-AUD-21: calls inside a lambda body use "<lambda>" itself as the caller and
        // caller_class = None -- unified with the nested def (KODE-AUD-008) "independent caller"
        // semantics, so they are no longer attributed to the outer caller.
        Lambda(l) => walk_expr(ast, ctx, &l.body, None, LAMBDA_CALLER, out),
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
        // Nested calls inside an f-string can be ignored in the call graph (MVP; expression-evaluation
        // side effects are out of scope for a method-level call graph).
        FString(_) => {}
        // Literals / names: no sub-calls (names as callees are already recorded in the Call branch)
        Name(_) | StringLiteral(_) | BytesLiteral(_) | NumberLiteral(_) | BooleanLiteral(_)
        | NoneLiteral(_) | EllipsisLiteral(_) | TString(_) | IpyEscapeCommand(_) => {}
    }
}

/// Record one call edge: resolve the callee target chain and classify it.
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

/// Resolve the dotted attribute chain (`self.cell.xxx` -> `["self","cell","xxx"]`).
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

/// Classify according to KBEngine channel semantics.
fn classify(chain: &Option<Vec<String>>, callee: &str, ctx: &CallContext) -> EdgeKind {
    let Some(v) = chain else {
        return EdgeKind::Unknown;
    };
    if v.is_empty() {
        return EdgeKind::Unknown;
    }
    match v[0].as_str() {
        "self" => match v.len() {
            1 => EdgeKind::SelfMethod, // `self(...)` (rare; recorded as a self call)
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
                // Imported-module calls (`mod.func`) and object method calls (`obj.method`) are both
                // recorded as Method (a dynamic language has no type information; a finer split is
                // inter-procedural analysis, out of MVP scope).
                EdgeKind::Method
            }
        }
    }
}
