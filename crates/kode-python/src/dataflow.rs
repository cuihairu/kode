//! 过程内 def-use 数据流(C-20 交付②,MVP)。
//!
//! MVP 边界(文档化,非本期修复项):
//! - **直线近似**:按源码顺序扫描,进入 `if`/`for`/`while`/`with`/`try` 体时顺序
//!   处理,不做控制流交汇合并(分支后变量的可能集不取并集);
//! - 仅跟踪局部名与 `self.<attr>` 属性写入;全局/内建/自由变量不被跟踪;
//! - 变量重定义会终结旧链(新定值开新链);
//! - `del x` 视作 kill(终结链,不新开链),删除后 `use(x)` 不连旧链(MVP 近似)。
//!
//! KODE-AUD-007:补 AugAssign 读旧值(target 是 Store ctx 语义读)、del kill
//! (Del ctx 非 Store 故旧实现漏)、Subscript 容器元素写侧读容器、NamedExpr(wa-
//! lrus)target 定义、Comprehension generator target 定义。
//!
//! 产出 [`DataflowResult`] 每变量(或其每次重定义)一条 [`DefUseChain`],含
//! 定值行与使用行,参数来源以 `is_param` 标记(「变量来源与传播」的可查询面)。

use std::collections::BTreeMap;

use ruff_python_ast::{self as ast, Expr, ExprContext, Stmt};
use ruff_text_size::Ranged;

use crate::model::{DataflowResult, DefUseChain};
use crate::parse::ParsedAst;

/// 对单个函数/方法体做过程内 def-use(MVP)。
///
/// `params` 为形参名(不含 `self`);`body` 为该函数体语句序列。
pub fn dataflow_for_body(ast: &ParsedAst, params: &[String], body: &[Stmt]) -> DataflowResult {
    let mut state = State::new(params);
    walk_body(ast, &mut state, body);
    // 定值链按首次出现顺序;空链(参数从未使用)也保留(来源可查)。
    DataflowResult {
        chains: state.chains,
    }
}

/// 单方法的 def-use 结果(RPC/消费面用;类方法带类名,模块级函数 `class=None`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodDataflow {
    /// 所属类限定名;模块级函数为 `None`。
    pub class: Option<String>,
    pub method: String,
    /// 形参名(与 [`crate::symbols::method_params`] 同序同过滤,`self` 不计)。
    pub params: Vec<String>,
    pub result: DataflowResult,
}

/// 全文件方法级 def-use:类方法 + 模块级函数(与 [`crate::callgraph`] 同一
/// 类→方法走查,委托 [`crate::symbols::method_params`] 取形参,单一口径)。
///
/// 嵌套 def/class 不入本表(与调用图同边界:由外层面另行收集)。
pub fn dataflow_for_module(ast: &ParsedAst) -> Vec<MethodDataflow> {
    let mut out = Vec::new();
    for stmt in &ast.module().body {
        match stmt {
            Stmt::ClassDef(cls) => {
                let class_name = cls.name.as_str().to_string();
                for s in &cls.body {
                    if let Stmt::FunctionDef(f) = s {
                        let params =
                            crate::symbols::method_params(&f.parameters);
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
    /// var → 当前活跃链下标(最近一次定值)。
    live: BTreeMap<String, usize>,
    chains: Vec<DefUseChain>,
}

impl State {
    fn new(params: &[String]) -> State {
        let mut chains = Vec::new();
        let mut live = BTreeMap::new();
        for p in params {
            let idx = chains.len();
            chains.push(DefUseChain {
                var: p.clone(),
                def_line: None,
                use_lines: Vec::new(),
                is_param: true,
            });
            live.insert(p.clone(), idx);
        }
        State { live, chains }
    }

    fn use_var(&mut self, var: &str, line: usize) {
        if let Some(&idx) = self.live.get(var) {
            let chain = &mut self.chains[idx];
            if chain.use_lines.last() != Some(&line) {
                chain.use_lines.push(line);
            }
        }
    }

    fn def_var(&mut self, var: &str, line: usize) {
        let idx = self.chains.len();
        self.chains.push(DefUseChain {
            var: var.to_string(),
            def_line: Some(line),
            use_lines: Vec::new(),
            is_param: false,
        });
        self.live.insert(var.to_string(), idx);
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
            // KODE-AUD-007:`x += v` 的 target 是 Store 上下文,但语义读旧值再写新值。
            // collect_reads 的 Name 分支只认 Load ctx 会漏读旧 x,故用 collect_reads_of
            // 强制读 target 底层名(读旧值),再 collect_writes 写新链。
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
                // KODE-AUD-007:`del x` 终结 x 当前链(视作 kill),后续 use(x) 不连旧链。
                // 旧实现走 collect_writes,但 del 的 Name ctx 是 Del(非 Store),Name 分支
                // 不认 → 旧链未终结仍被后续读。kill_var 删 live 映射即终结。
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
                if let Some(typ) = &inner.type_ {
                    collect_reads(state, typ, line);
                }
                if let Some(name) = &inner.name {
                    state.def_var(name.as_str(), line);
                }
                walk_body(ast, state, &inner.body);
            }
            walk_body(ast, state, &t.orelse);
            walk_body(ast, state, &t.finalbody);
        }
        Stmt::Match(m) => {
            collect_reads(state, &m.subject, line);
            for case in &m.cases {
                walk_body(ast, state, &case.body);
            }
        }
        Stmt::Import(imp) => {
            for alias in &imp.names {
                let binding = alias
                    .asname
                    .as_ref()
                    .map(|n| n.as_str().to_string())
                    .unwrap_or_else(|| alias.name.as_str().to_string());
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
        // 其余无 def-use 语义
        Stmt::Raise(_)
        | Stmt::Assert(_)
        | Stmt::Global(_)
        | Stmt::Nonlocal(_)
        | Stmt::Pass(_)
        | Stmt::Break(_)
        | Stmt::Continue(_)
        | Stmt::TypeAlias(_)
        | Stmt::IpyEscapeCommand(_) => {}
    }
}

/// 收集读(Load 上下文的名字与 `self.<attr>` 属性读)。
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
            // KODE-AUD-007:walrus `(x := v)` 的 target 是 Store 上下文,须在此定义 x
            // (旧实现只读 value,漏 def target)。
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
        ListComp(c) => {
            collect_reads(state, &c.elt, line);
            for gen in &c.generators {
                collect_reads(state, &gen.iter, line);
                collect_writes(state, &gen.target, line);
                for if_ in &gen.ifs {
                    collect_reads(state, if_, line);
                }
            }
        }
        SetComp(c) => {
            collect_reads(state, &c.elt, line);
            for gen in &c.generators {
                collect_reads(state, &gen.iter, line);
                collect_writes(state, &gen.target, line);
                for if_ in &gen.ifs {
                    collect_reads(state, if_, line);
                }
            }
        }
        DictComp(c) => {
            if let Some(k) = &c.key {
                collect_reads(state, k, line);
            }
            collect_reads(state, &c.value, line);
            for gen in &c.generators {
                collect_reads(state, &gen.iter, line);
                collect_writes(state, &gen.target, line);
                for if_ in &gen.ifs {
                    collect_reads(state, if_, line);
                }
            }
        }
        Generator(c) => {
            collect_reads(state, &c.elt, line);
            for gen in &c.generators {
                collect_reads(state, &gen.iter, line);
                collect_writes(state, &gen.target, line);
                for if_ in &gen.ifs {
                    collect_reads(state, if_, line);
                }
            }
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
        Lambda(l) => collect_reads(state, &l.body, line),
        // 字面量/字符串/名字(Load 已在 Name 分支处理)
        StringLiteral(_) | BytesLiteral(_) | NumberLiteral(_) | BooleanLiteral(_)
        | NoneLiteral(_) | EllipsisLiteral(_) | TString(_) | FString(_) | IpyEscapeCommand(_) => {}
    }
}

/// 收集写(Store 上下文的名字与 `self.<attr>` 属性写、元组解包)。
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
            // KODE-AUD-007:`a[0] = v` 写侧须读容器 a 与索引(旧实现只写 s.value 漏读)。
            collect_reads(state, &s.value, line);
            collect_reads(state, &s.slice, line);
            collect_writes(state, &s.value, line);
        }
        _ => {}
    }
}

/// 强制读 target 底层名(不看 ctx):用于 AugAssign 的 target——它是 Store 上下文
/// 但语义读旧值(`x += v` 先读旧 x)。对 Name 无条件 use;对 Subscript/Attribute 递归。
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

/// 终结 var 当前链:`del x` 语义——后续 use(x) 不应连旧链。MVP 视作 kill(删 live
/// 映射),不新开链(删除后 x 未定义,非重定义)。del 的 Name ctx 是 Del(非 Store),
/// collect_writes 的 Name 分支不认,故单独处理。
fn kill_var(state: &mut State, target: &Expr, line: usize) {
    use Expr::*;
    match target {
        Name(n) => {
            state.live.remove(n.id.as_str());
        }
        Attribute(a) => {
            if is_self(&a.value) {
                state.live.remove(&format!("self.{}", a.attr.as_str()));
            }
        }
        Subscript(s) => {
            // `del a[i]` 读容器 a 与索引,再终结容器链(对容器递归 kill)。
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

/// `expr` 是否为 `self` 名。
fn is_self(expr: &Expr) -> bool {
    matches!(expr, Expr::Name(n) if n.id.as_str() == "self")
}
