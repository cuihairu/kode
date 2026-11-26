//! Intra-procedural def-use dataflow (C-20 delivery item 2, MVP).
//!
//! MVP boundaries (documented, not a fix item of this phase):
//! - **Straight-line approximation**: scanned in source order; entering an `if`/`for`/`while`/
//!   `with`/`try` body is processed sequentially, with no control-flow join merging (the possible
//!   sets of a variable after branches are not unioned);
//! - only local names and `self.<attr>` attribute writes are tracked; globals / builtins / free
//!   variables are not tracked;
//! - redefining a variable terminates the old chain (a new definition starts a new chain);
//! - `del x` is treated as a kill (terminates the chain without starting a new one); after the
//!   delete, `use(x)` does not attach to the old chain (MVP approximation).
//!
//! KODE-AUD-007: added AugAssign's read of the old value (the target is Store ctx but semantically
//! a read), del as kill (its ctx is Del, not Store, so the old implementation missed it),
//! Subscript element writes also reading the container, NamedExpr (walrus) target definitions, and
//! Comprehension generator target definitions.
//!
//! Produces [`DataflowResult`] with one [`DefUseChain`] per variable (or per each of its
//! redefinitions), carrying the definition and use lines; the parameter origin is marked by
//! `is_param` (the queryable face of "variable origin and propagation").

use std::collections::{BTreeMap, BTreeSet};

use ruff_python_ast::{self as ast, Expr, ExprContext, Stmt};
use ruff_text_size::Ranged;

use crate::model::{DataflowResult, DefUseChain};
use crate::parse::ParsedAst;

/// Perform intra-procedural def-use for a single function / method body (MVP).
///
/// `params` is the formal parameter names (excluding `self`); `body` is the statement sequence of
/// that function body.
pub fn dataflow_for_body(ast: &ParsedAst, params: &[String], body: &[Stmt]) -> DataflowResult {
    let mut state = State::new(params);
    walk_body(ast, &mut state, body);
    // Definition chains in order of first appearance; empty chains (a parameter never used) are
    // kept as well (the origin stays queryable).
    DataflowResult {
        chains: state.chains,
    }
}

/// Def-use result of a single method (for the RPC / consumer face; class methods carry the class
/// name, module-level functions have `class=None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodDataflow {
    /// Qualified name of the owning class; `None` for module-level functions.
    pub class: Option<String>,
    pub method: String,
    /// Formal parameter names (same order and filtering as [`crate::symbols::method_params`];
    /// `self` excluded).
    pub params: Vec<String>,
    pub result: DataflowResult,
}

/// File-wide method-level def-use: class methods + module-level functions (the same class ->
/// method walk as [`crate::callgraph`]; parameter names delegated to
/// [`crate::symbols::method_params`], one single semantics).
///
/// Nested def/class is not included in this table (same boundary as the call graph: collected
/// separately by the outer face).
pub fn dataflow_for_module(ast: &ParsedAst) -> Vec<MethodDataflow> {
    let mut out = Vec::new();
    for stmt in &ast.module().body {
        match stmt {
            Stmt::ClassDef(cls) => {
                let class_name = cls.name.as_str().to_string();
                for s in &cls.body {
                    if let Stmt::FunctionDef(f) = s {
                        let params = crate::symbols::method_params(&f.parameters);
                        out.push(MethodDataflow {
                            class: Some(class_name.clone()),
                            method: f.name.as_str().to_string(),
                            params: params.clone(),
                            result: dataflow_for_body(ast, &params, &f.body),
                        });
                    }
                }
            }
            Stmt::FunctionDef(f) => {
                let params = crate::symbols::method_params(&f.parameters);
                out.push(MethodDataflow {
                    class: None,
                    method: f.name.as_str().to_string(),
                    params: params.clone(),
                    result: dataflow_for_body(ast, &params, &f.body),
                });
            }
            _ => {}
        }
    }
    out
}

struct State {
    /// Scope stack: per layer var -> the index of the currently active chain (the most recent
    /// definition); the top of the stack is the innermost layer.
    /// The base layer is the function body itself; since KR-AUD-18 a lambda body pushes an
    /// independent sub-layer (parameter shadowing).
    scopes: Vec<BTreeMap<String, usize>>,
    /// Names declared via `global`/`nonlocal` (KR-AUD-19): an assignment to such a name writes an
    /// outer binding, so no local def chain is built.
    global_names: BTreeSet<String>,
    chains: Vec<DefUseChain>,
}

impl State {
    fn new(params: &[String]) -> State {
        let mut state = State {
            scopes: vec![BTreeMap::new()],
            global_names: BTreeSet::new(),
            chains: Vec::new(),
        };
        state.push_param_scope(params);
        state
    }

    /// Push a scope layer and record `params` as that layer's parameter chains (is_param, no
    /// def_line; empty chains are kept too, so the origin stays queryable). Shared by the base
    /// layer (`new`) and lambda sub-scopes (KR-AUD-18).
    fn push_param_scope(&mut self, params: &[String]) {
        let mut scope = BTreeMap::new();
        for p in params {
            let idx = self.chains.len();
            self.chains.push(DefUseChain {
                var: p.clone(),
                def_line: None,
                use_lines: Vec::new(),
                is_param: true,
            });
            scope.insert(p.clone(), idx);
        }
        self.scopes.push(scope);
    }

    fn use_var(&mut self, var: &str, line: usize) {
        // Look up from the innermost scope outward (KR-AUD-18: lambda parameters shadow outer same-named variables).
        for scope in self.scopes.iter().rev() {
            if let Some(&idx) = scope.get(var) {
                let chain = &mut self.chains[idx];
                if chain.use_lines.last() != Some(&line) {
                    chain.use_lines.push(line);
                }
                return;
            }
        }
    }

    fn def_var(&mut self, var: &str, line: usize) {
        // KR-AUD-19: an assignment to a global/nonlocal declared name writes an outer binding; no local chain is built.
        if self.global_names.contains(var) {
            return;
        }
        let idx = self.chains.len();
        self.chains.push(DefUseChain {
            var: var.to_string(),
            def_line: Some(line),
            use_lines: Vec::new(),
            is_param: false,
        });
        if let Some(scope) = self.scopes.last_mut() {
            scope.insert(var.to_string(), idx);
        }
    }
}

fn walk_body(ast: &ParsedAst, state: &mut State, body: &[Stmt]) {
    for stmt in body {
        walk_stmt(ast, state, stmt);
    }
}

fn walk_stmt(ast: &ParsedAst, state: &mut State, stmt: &Stmt) {
    let line = ast.line_col(stmt.range().start().to_u32()).0;
    match stmt {
        Stmt::Assign(a) => {
            collect_reads(state, &a.value, line);
            for t in &a.targets {
                collect_writes(state, t, line);
            }
        }
        Stmt::AnnAssign(a) => {
            if let Some(v) = &a.value {
                collect_reads(state, v, line);
            }
            collect_writes(state, &a.target, line);
        }
        Stmt::AugAssign(a) => {
            // KODE-AUD-007: the target of `x += v` is a Store context, but it semantically reads the old value
            // and then writes the new one. The Name branch of collect_reads only recognizes a Load
            // ctx and would miss reading the old x, so collect_reads_of forces reading the target's
            // underlying name (reading the old value), then collect_writes writes the new chain.
            collect_reads_of(state, &a.target, line);
            collect_reads(state, &a.value, line);
            collect_writes(state, &a.target, line);
        }
        Stmt::Expr(e) => collect_reads(state, &e.value, line),
        Stmt::Return(r) => {
            if let Some(v) = &r.value {
                collect_reads(state, v, line);
            }
        }
        Stmt::Delete(d) => {
            for t in &d.targets {
                // KODE-AUD-007: `del x` terminates x's current chain (treated as a kill); later use(x) does not
                // attach to the old chain. The old implementation went through collect_writes, but
                // del's Name ctx is Del (not Store) so the Name branch rejects it -> the old chain
                // was never terminated and was still read afterwards. kill_var removes the live
                // mapping, which terminates the chain.
                kill_var(state, t, line);
            }
        }
        Stmt::If(i) => {
            collect_reads(state, &i.test, line);
            walk_body(ast, state, &i.body);
            for clause in &i.elif_else_clauses {
                if let Some(test) = &clause.test {
                    collect_reads(state, test, line);
                }
                walk_body(ast, state, &clause.body);
            }
        }
        Stmt::For(f) => {
            collect_reads(state, &f.iter, line);
            collect_writes(state, &f.target, line);
            walk_body(ast, state, &f.body);
            walk_body(ast, state, &f.orelse);
        }
        Stmt::While(w) => {
            collect_reads(state, &w.test, line);
            walk_body(ast, state, &w.body);
            walk_body(ast, state, &w.orelse);
        }
        Stmt::With(w) => {
            for item in &w.items {
                collect_reads(state, &item.context_expr, line);
                if let Some(vars) = &item.optional_vars {
                    collect_writes(state, vars, line);
                }
            }
            walk_body(ast, state, &w.body);
        }
        Stmt::Try(t) => {
            walk_body(ast, state, &t.body);
            for h in &t.handlers {
                let ast::ExceptHandler::ExceptHandler(inner) = h;
                // KR-AUD-17: the type_ read and the captured-name def use the handler's own line (the old
                // implementation recorded everything on the try statement line, distorting the def
                // line location).
                let handler_line = ast.line_col(inner.range.start().to_u32()).0;
                if let Some(typ) = &inner.type_ {
                    collect_reads(state, typ, handler_line);
                }
                if let Some(name) = &inner.name {
                    state.def_var(name.as_str(), handler_line);
                }
                walk_body(ast, state, &inner.body);
            }
            walk_body(ast, state, &t.orelse);
            walk_body(ast, state, &t.finalbody);
        }
        Stmt::Match(m) => {
            collect_reads(state, &m.subject, line);
            for case in &m.cases {
                // KR-AUD-10: the dataflow side -- pattern captured-name defs and guard reads.
                // Capture defs come before the guard read (a guard may reference captures, e.g.
                // `case [a,b] if a > 0`).
                let case_line = ast.line_col(case.pattern.range().start().to_u32()).0;
                collect_pattern_captures(state, &case.pattern, case_line);
                if let Some(g) = &case.guard {
                    collect_reads(state, g, case_line);
                }
                walk_body(ast, state, &case.body);
            }
        }
        Stmt::Import(imp) => {
            for alias in &imp.names {
                // KR-AUD-11: `import a.b` binds the top-level name `a` (same semantics as symbols.rs); without an
                // asname we no longer build a chain for the full path "a.b" (later reads of
                // `a.attr` then do not break the chain).
                let binding = alias
                    .asname
                    .as_ref()
                    .map(|n| n.as_str().to_string())
                    .unwrap_or_else(|| {
                        alias
                            .name
                            .as_str()
                            .split('.')
                            .next()
                            .unwrap_or("")
                            .to_string()
                    });
                state.def_var(&binding, line);
            }
        }
        Stmt::ImportFrom(impf) => {
            for alias in &impf.names {
                let binding = alias
                    .asname
                    .as_ref()
                    .map(|n| n.as_str().to_string())
                    .unwrap_or_else(|| alias.name.as_str().to_string());
                state.def_var(&binding, line);
            }
        }
        Stmt::FunctionDef(f) => state.def_var(f.name.as_str(), line),
        Stmt::ClassDef(c) => state.def_var(c.name.as_str(), line),
        // KR-AUD-16: the expression side of raise/assert is walked as reads (exc/cause/test/msg),
        // instead of falling wholesale into the no-semantics branch.
        Stmt::Raise(r) => {
            if let Some(e) = &r.exc {
                collect_reads(state, e, line);
            }
            if let Some(c) = &r.cause {
                collect_reads(state, c, line);
            }
        }
        Stmt::Assert(a) => {
            collect_reads(state, &a.test, line);
            if let Some(m) = &a.msg {
                collect_reads(state, m, line);
            }
        }
        // KR-AUD-19: register the global/nonlocal names; later assignments to them build no local def
        // chain (they write outer bindings; the read side never tracked globals / closure free
        // variables in the first place).
        Stmt::Global(g) => {
            for n in &g.names {
                state.global_names.insert(n.as_str().to_string());
            }
        }
        Stmt::Nonlocal(n) => {
            for name in &n.names {
                state.global_names.insert(name.as_str().to_string());
            }
        }
        Stmt::Pass(_)
        | Stmt::Break(_)
        | Stmt::Continue(_)
        | Stmt::TypeAlias(_)
        | Stmt::IpyEscapeCommand(_) => {}
    }
}

/// Collect the captured-name defs of a match pattern (KR-AUD-10): the a/b of `case [a, b]:`,
/// `*rest`, mapping `**rest`, and the y of `case X() as y` each def one chain.
/// Also a read face: the class name Point of `case Point(x, 0):` and the value expression of
/// `case V(x):` are recorded as Load reads (the same collect_reads channel as guard / subject).
fn collect_pattern_captures(state: &mut State, pattern: &ast::Pattern, line: usize) {
    use ast::Pattern;
    match pattern {
        Pattern::MatchValue(v) => collect_reads(state, &v.value, line),
        Pattern::MatchSingleton(_) => {}
        Pattern::MatchSequence(s) => {
            for p in &s.patterns {
                collect_pattern_captures(state, p, line);
            }
        }
        Pattern::MatchMapping(m) => {
            for k in &m.keys {
                collect_reads(state, k, line);
            }
            for p in &m.patterns {
                collect_pattern_captures(state, p, line);
            }
            if let Some(rest) = &m.rest {
                state.def_var(rest.as_str(), line);
            }
        }
        Pattern::MatchClass(c) => {
            collect_reads(state, &c.cls, line);
            for p in &c.arguments.patterns {
                collect_pattern_captures(state, p, line);
            }
            for kw in &c.arguments.keywords {
                collect_pattern_captures(state, &kw.pattern, line);
            }
        }
        Pattern::MatchStar(s) => {
            if let Some(name) = &s.name {
                state.def_var(name.as_str(), line);
            }
        }
        Pattern::MatchAs(a) => {
            if let Some(inner) = &a.pattern {
                collect_pattern_captures(state, inner, line);
            }
            if let Some(name) = &a.name {
                state.def_var(name.as_str(), line);
            }
        }
        Pattern::MatchOr(o) => {
            for p in &o.patterns {
                collect_pattern_captures(state, p, line);
            }
        }
    }
}

/// Walk a comprehension's generators in order: iter read -> target write -> ifs read (KR-AUD-09:
/// the elt read must come after those, so it can attach to the target's def chain).
fn collect_comp_generators(state: &mut State, generators: &[ast::Comprehension], line: usize) {
    for gen in generators {
        collect_reads(state, &gen.iter, line);
        collect_writes(state, &gen.target, line);
        for if_ in &gen.ifs {
            collect_reads(state, if_, line);
        }
    }
}

/// Collect reads (names in Load context and `self.<attr>` attribute reads).
fn collect_reads(state: &mut State, expr: &Expr, line: usize) {
    use Expr::*;
    match expr {
        Attribute(a) => {
            if is_self(&a.value) {
                state.use_var(&format!("self.{}", a.attr.as_str()), line);
            } else {
                collect_reads(state, &a.value, line);
            }
        }
        Name(n) => {
            if n.ctx == ExprContext::Load {
                state.use_var(n.id.as_str(), line);
            }
        }
        Call(c) => {
            collect_reads(state, &c.func, line);
            for a in &c.arguments.args {
                collect_reads(state, a, line);
            }
            for k in &c.arguments.keywords {
                collect_reads(state, &k.value, line);
            }
        }
        Subscript(s) => {
            collect_reads(state, &s.value, line);
            collect_reads(state, &s.slice, line);
        }
        BoolOp(b) => {
            for v in &b.values {
                collect_reads(state, v, line);
            }
        }
        Named(n) => {
            // KODE-AUD-007: the target of the walrus `(x := v)` is a Store context; x must be defined here
            // (the old implementation only read the value and missed the target's def).
            collect_reads(state, &n.value, line);
            collect_writes(state, &n.target, line);
        }
        BinOp(b) => {
            collect_reads(state, &b.left, line);
            collect_reads(state, &b.right, line);
        }
        UnaryOp(u) => collect_reads(state, &u.operand, line),
        If(e) => {
            collect_reads(state, &e.test, line);
            collect_reads(state, &e.body, line);
            collect_reads(state, &e.orelse, line);
        }
        Dict(d) => {
            for item in &d.items {
                if let Some(k) = &item.key {
                    collect_reads(state, k, line);
                }
                collect_reads(state, &item.value, line);
            }
        }
        Set(s) => {
            for e in &s.elts {
                collect_reads(state, e, line);
            }
        }
        List(l) => {
            for e in &l.elts {
                collect_reads(state, e, line);
            }
        }
        Tuple(t) => {
            for e in &t.elts {
                collect_reads(state, e, line);
            }
        }
        // KR-AUD-09: walk the generators to completion in order first (iter read / target write / ifs
        // read), then read the elt -- the old implementation read elt first, at which point the
        // generator target was not yet def'd, so uses of the target inside elt broke their chain
        // (the str(x) of `[str(x) for x in xs]` had no chain).
        ListComp(c) => {
            collect_comp_generators(state, &c.generators, line);
            collect_reads(state, &c.elt, line);
        }
        SetComp(c) => {
            collect_comp_generators(state, &c.generators, line);
            collect_reads(state, &c.elt, line);
        }
        DictComp(c) => {
            collect_comp_generators(state, &c.generators, line);
            if let Some(k) = &c.key {
                collect_reads(state, k, line);
            }
            collect_reads(state, &c.value, line);
        }
        Generator(c) => {
            collect_comp_generators(state, &c.generators, line);
            collect_reads(state, &c.elt, line);
        }
        Await(a) => collect_reads(state, &a.value, line),
        Yield(y) => {
            if let Some(v) = &y.value {
                collect_reads(state, v, line);
            }
        }
        YieldFrom(y) => collect_reads(state, &y.value, line),
        Compare(c) => {
            for operand in &c.operands {
                collect_reads(state, operand, line);
            }
        }
        Starred(s) => collect_reads(state, &s.value, line),
        Slice(s) => {
            if let Some(l) = &s.lower {
                collect_reads(state, l, line);
            }
            if let Some(u) = &s.upper {
                collect_reads(state, u, line);
            }
            if let Some(st) = &s.step {
                collect_reads(state, st, line);
            }
        }
        Lambda(l) => {
            // KR-AUD-18: lambda parameters enter an independent sub-scope (shadowing outer same-named
            // variables); the default values are evaluated in the outer scope and read before the
            // layer is pushed. Reads inside the body only consult the sub-scope -> the outer scope,
            // and after exit the outer scope is restored, so outer chains are unaffected by
            // definitions inside the lambda.
            for arg in l
                .parameters
                .as_ref()
                .map(|p| p.posonlyargs.iter().chain(&p.args))
                .into_iter()
                .flatten()
            {
                if let Some(d) = &arg.default {
                    collect_reads(state, d, line);
                }
            }
            let names: Vec<String> = l
                .parameters
                .as_ref()
                .map(|p| lambda_param_names(p))
                .unwrap_or_default();
            state.push_param_scope(&names);
            collect_reads(state, &l.body, line);
            state.scopes.pop();
        }
        // Literals / strings / names (Load is already handled in the Name branch)
        StringLiteral(_) | BytesLiteral(_) | NumberLiteral(_) | BooleanLiteral(_)
        | NoneLiteral(_) | EllipsisLiteral(_) | TString(_) | FString(_) | IpyEscapeCommand(_) => {}
    }
}

/// Collect writes (names in Store context, `self.<attr>` attribute writes, tuple unpacking).
fn collect_writes(state: &mut State, target: &Expr, line: usize) {
    use Expr::*;
    match target {
        Attribute(a) => {
            if is_self(&a.value) {
                state.def_var(&format!("self.{}", a.attr.as_str()), line);
            } else {
                collect_writes(state, &a.value, line);
            }
        }
        Name(n) => {
            if n.ctx == ExprContext::Store {
                state.def_var(n.id.as_str(), line);
            }
        }
        Tuple(t) => {
            for e in &t.elts {
                collect_writes(state, e, line);
            }
        }
        List(l) => {
            for e in &l.elts {
                collect_writes(state, e, line);
            }
        }
        Starred(s) => collect_writes(state, &s.value, line),
        Subscript(s) => {
            // KODE-AUD-007: the write side of `a[0] = v` must read the container a and the index (the old
            // implementation only wrote s.value and missed the reads).
            collect_reads(state, &s.value, line);
            collect_reads(state, &s.slice, line);
            collect_writes(state, &s.value, line);
        }
        _ => {}
    }
}

/// Force a read of the target's underlying name (ignoring ctx): used for the target of an
/// AugAssign -- it is a Store context but semantically reads the old value (`x += v` reads the old
/// x first). For a Name it unconditionally uses; for Subscript/Attribute it recurses.
fn collect_reads_of(state: &mut State, expr: &Expr, line: usize) {
    use Expr::*;
    match expr {
        Name(n) => state.use_var(n.id.as_str(), line),
        Subscript(s) => {
            collect_reads(state, &s.value, line);
            collect_reads(state, &s.slice, line);
        }
        Attribute(a) => {
            if is_self(&a.value) {
                state.use_var(&format!("self.{}", a.attr.as_str()), line);
            } else {
                collect_reads_of(state, &a.value, line);
            }
        }
        Tuple(t) => {
            for e in &t.elts {
                collect_reads_of(state, e, line);
            }
        }
        List(l) => {
            for e in &l.elts {
                collect_reads_of(state, e, line);
            }
        }
        Starred(s) => collect_reads_of(state, &s.value, line),
        _ => collect_reads(state, expr, line),
    }
}

/// Terminate var's current chain: the semantics of `del x` -- a later use(x) should not attach to
/// the old chain. The MVP treats it as a kill (removing the live mapping) and does not start a new
/// chain (after deletion x is undefined, not redefined). del's Name ctx is Del (not Store) and
/// collect_writes' Name branch rejects it, so it is handled separately.
fn kill_var(state: &mut State, target: &Expr, line: usize) {
    use Expr::*;
    match target {
        Name(n) => {
            // A del is treated as a kill: removing the mapping from the innermost scope terminates
            // the chain (including lambda sub-scopes).
            for scope in state.scopes.iter_mut().rev() {
                if scope.remove(n.id.as_str()).is_some() {
                    break;
                }
            }
        }
        Attribute(a) => {
            if is_self(&a.value) {
                let key = format!("self.{}", a.attr.as_str());
                for scope in state.scopes.iter_mut().rev() {
                    if scope.remove(&key).is_some() {
                        break;
                    }
                }
            }
        }
        Subscript(s) => {
            // `del a[i]` reads the container a and the index, then terminates the container's chain (a
            // recursive kill on the container).
            collect_reads(state, &s.value, line);
            collect_reads(state, &s.slice, line);
            kill_var(state, &s.value, line);
        }
        Tuple(t) => {
            for e in &t.elts {
                kill_var(state, e, line);
            }
        }
        List(l) => {
            for e in &l.elts {
                kill_var(state, e, line);
            }
        }
        Starred(s) => kill_var(state, &s.value, line),
        _ => {}
    }
}

/// Lambda parameter names (posonly -> pos -> vararg -> kwonly -> kwarg; `self` is not filtered out
/// -- lambda parameters are all plain names). KR-AUD-18.
fn lambda_param_names(p: &ast::Parameters) -> Vec<String> {
    let mut out: Vec<String> = p
        .posonlyargs
        .iter()
        .chain(&p.args)
        .chain(&p.kwonlyargs)
        .map(|a| a.parameter.name.as_str().to_string())
        .collect();
    if let Some(v) = &p.vararg {
        out.push(v.name.as_str().to_string());
    }
    if let Some(k) = &p.kwarg {
        out.push(k.name.as_str().to_string());
    }
    out
}

/// Whether `expr` is the name `self`.
fn is_self(expr: &Expr) -> bool {
    matches!(expr, Expr::Name(n) if n.id.as_str() == "self")
}
