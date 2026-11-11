//! BAS-07 Python 表达式来源。
//!
//! 直接走 Ruff AST(设计 §4「来源」):把 `(line, col)` 位置的表达式归类为
//! 属性读/下标/调用/局部赋值,并按语句位置区分**同行执行顺序**(列序)。
//! 别名重绑定后失效:同名局部赋值按 `(line, col)` 取最近一次,之后的重绑
//! 定即遮蔽(与流面「最近写点胜」同语义)。
//!
//! 未知形态诚实归 [`ExprKind::Unknown`](原因),不猜成任意表达式。

use ruff_python_ast::{self as ast, Expr, Stmt};
use ruff_text_size::{Ranged, TextRange};

use kode_python::ParsedAst;

/// 表达式来源分类。
#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    /// `base.attr`(属性读;base 为接收者文本)。
    Attribute { base: String, attr: String },
    /// `base[key]`(下标读;key 为键文本,可空 = 未知键)。
    Subscript { base: String, key: Option<String> },
    /// `callee(...)`(调用;callee 文本,含 `A.m`/`self.m` 全形态)。
    Call { callee: String },
    /// `target = value`(局部赋值;target 为赋值目标文本)。
    LocalAssign { target: String },
    /// 未知形态(原因;不伪造)。
    Unknown(String),
}

/// 一次局部赋值事件(排序键 = 位置,同行按列序)。
#[derive(Debug, Clone, PartialEq)]
pub struct AssignEvent {
    pub line: usize,
    pub col: usize,
    pub target: String,
    pub value: ExprKind,
}

fn range_contains(r: TextRange, line: usize, col: usize, ast: &ParsedAst) -> bool {
    let (s_line, s_col) = ast.line_col(r.start().to_u32());
    if s_line != line {
        return false;
    }
    // exclusive 末端:end-1 才是最后字符列(空区间除外)。
    if r.is_empty() {
        return s_col <= col;
    }
    let (e_line, e_col) = ast.line_col(r.end().to_u32() - 1);
    if e_line != line {
        return true;
    }
    s_col <= col && col <= e_col
}

fn name_text(e: &Expr) -> Option<String> {
    match e {
        Expr::Name(n) => Some(n.id.to_string()),
        _ => None,
    }
}

/// 解包目标内的绑定名(嵌套 Tuple/List/Starred 展开;叶子记自身 span;
/// 非绑定目标如 `obj.attr` 不产生名)。
fn binding_target_names(e: &Expr, out: &mut Vec<(String, TextRange)>) {
    match e {
        Expr::Tuple(tp) => {
            for t in &tp.elts {
                binding_target_names(t, out);
            }
        }
        Expr::List(l) => {
            for t in &l.elts {
                binding_target_names(t, out);
            }
        }
        Expr::Starred(s) => binding_target_names(&s.value, out),
        _ => {
            if let Some(n) = name_text(e) {
                out.push((n, e.range()));
            }
        }
    }
}

/// 表达式分类(RHS 值形态)。
pub fn classify(ast: &ParsedAst, e: &Expr) -> ExprKind {
    match e {
        Expr::Attribute(a) => ExprKind::Attribute {
            base: expr_text(ast, &a.value),
            attr: a.attr.to_string(),
        },
        Expr::Subscript(s) => ExprKind::Subscript {
            base: expr_text(ast, &s.value),
            key: Some(expr_text(ast, &s.slice)),
        },
        Expr::Call(c) => ExprKind::Call {
            callee: expr_text(ast, &c.func),
        },
        Expr::Name(n) => ExprKind::LocalAssign { target: n.id.to_string() },
        Expr::Await(a) => classify(ast, &a.value),
        Expr::Named(ne) => classify(ast, &ne.value),
        Expr::BoolOp(b) => {
            let first = b.values.first();
            first.map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("empty-boolop".into()))
        }
        Expr::BinOp(b) => classify(ast, &b.left),
        Expr::UnaryOp(u) => classify(ast, &u.operand),
        Expr::If(ie) => classify(ast, &ie.body),
        Expr::List(l) => l.elts.first().map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("empty-list".into())),
        Expr::Tuple(t) => t.elts.first().map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("empty-tuple".into())),
        Expr::Set(s) => s.elts.first().map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("empty-set".into())),
        Expr::Dict(d) => d
            .items
            .first()
            .map(|i| classify(ast, &i.value))
            .unwrap_or_else(|| ExprKind::Unknown("empty-dict".into())),
        Expr::StringLiteral(c) => ExprKind::LocalAssign { target: c.value.to_str().to_string() },
        Expr::NumberLiteral(c) => ExprKind::LocalAssign {
            target: match &c.value {
                ast::Number::Int(i) => i.to_string(),
                ast::Number::Float(f) => f.to_string(),
                ast::Number::Complex { real, imag } => format!("{real}+{imag}j"),
            },
        },
        Expr::BooleanLiteral(c) => ExprKind::LocalAssign { target: c.value.to_string() },
        Expr::NoneLiteral(_) => ExprKind::LocalAssign { target: "None".into() },
        Expr::BytesLiteral(c) => ExprKind::LocalAssign {
            // 多段隐式拼接的 bytes 也无损失(逐段字面文本串接)。
            target: c
                .value
                .iter()
                .map(|b| String::from_utf8_lossy(b.as_slice()).to_string())
                .collect::<Vec<_>>()
                .join(""),
        },
        Expr::EllipsisLiteral(_) => ExprKind::LocalAssign { target: "...".into() },
        Expr::Lambda(_) => ExprKind::Unknown("lambda".into()),
        Expr::Generator(_) | Expr::ListComp(_) | Expr::SetComp(_) | Expr::DictComp(_) => {
            ExprKind::Unknown("comprehension".into())
        }
        _ => ExprKind::Unknown("unhandled-expr".into()),
    }
}

/// 表达式文本(呈现用;截断 80 字符防爆)。
fn expr_text(ast: &ParsedAst, e: &Expr) -> String {
    let r = e.range();
    let start = r.start().to_u32() as usize;
    let end = r.end().to_u32() as usize;
    if end <= start || end > ast.source.len() {
        return "?".into();
    }
    let mut s = ast.source[start..end].to_string();
    if s.chars().count() > 80 {
        s = s.chars().take(80).collect();
        s.push('…');
    }
    s
}

/// 模块内全部局部赋值事件(递归;按 (line,col) 升序,同行列序)。
pub fn collect_assign_events(ast: &ParsedAst) -> Vec<AssignEvent> {
    let mut out = Vec::new();
    walk_stmts(ast, &ast.module().body, &mut out);
    out.sort_by_key(|e| (e.line, e.col));
    out
}

fn walk_stmts(ast: &ParsedAst, stmts: &[Stmt], out: &mut Vec<AssignEvent>) {
    for s in stmts {
        walk_stmt(ast, s, out);
    }
}

/// 登记一组绑定名(位置 = 各自名 span)。
fn push_names(ast: &ParsedAst, names: Vec<(String, TextRange)>, value: ExprKind, out: &mut Vec<AssignEvent>) {
    for (target, r) in names {
        let (line, col) = ast.line_col(r.start().to_u32());
        out.push(AssignEvent { line, col, target, value: value.clone() });
    }
}

/// 解构模式绑定名(MatchValue 之外的模式均可绑定;As/Star/Mapping rest 是
/// 直接绑定名,Sequence/Or/Class 递归下钻;捕获位置 = 名 span)。
fn pattern_binding_names(p: &ast::Pattern, out: &mut Vec<(String, TextRange)>) {
    use ast::Pattern as P;
    match p {
        P::MatchValue(_) | P::MatchSingleton(_) => {}
        P::MatchSequence(s) => {
            for sub in &s.patterns {
                pattern_binding_names(sub, out);
            }
        }
        P::MatchMapping(m) => {
            if let Some(rest) = &m.rest {
                out.push((rest.as_str().to_string(), rest.range));
            }
            for sub in &m.patterns {
                pattern_binding_names(sub, out);
            }
        }
        P::MatchClass(c) => {
            for sub in &c.arguments.patterns {
                pattern_binding_names(sub, out);
            }
            for kw in &c.arguments.keywords {
                pattern_binding_names(&kw.pattern, out);
            }
        }
        P::MatchStar(s) => {
            if let Some(n) = &s.name {
                out.push((n.as_str().to_string(), n.range));
            }
        }
        P::MatchAs(a) => {
            if let Some(n) = &a.name {
                out.push((n.as_str().to_string(), n.range));
            }
            if let Some(sub) = &a.pattern {
                pattern_binding_names(sub, out);
            }
        }
        P::MatchOr(o) => {
            for sub in &o.patterns {
                pattern_binding_names(sub, out);
            }
        }
    }
}

fn walk_stmt(ast: &ParsedAst, s: &Stmt, out: &mut Vec<AssignEvent>) {
    match s {
        Stmt::Assign(a) => {
            let kind = classify(ast, &a.value);
            for t in &a.targets {
                match t {
                    // 解包目标逐名登记(位置 = 各自名 span,同行按列序可分)。
                    Expr::Tuple(_) | Expr::List(_) | Expr::Starred(_) => {
                        let mut names = Vec::new();
                        binding_target_names(t, &mut names);
                        push_names(ast, names, kind.clone(), out);
                    }
                    _ => {
                        if let Some(target) = name_text(t) {
                            let r = a.value.range();
                            let (line, col) = ast.line_col(r.start().to_u32());
                            out.push(AssignEvent { line, col, target, value: kind.clone() });
                        }
                    }
                }
            }
            walk_expr(ast, &a.value, out);
        }
        Stmt::AnnAssign(a) => {
            let kind = a.value.as_ref().map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("annassign-no-value".into()));
            if let Some(target) = name_text(&a.target) {
                let r = a.target.range();
                let (line, col) = ast.line_col(r.start().to_u32());
                out.push(AssignEvent { line, col, target, value: kind });
            }
            if let Some(v) = &a.value {
                walk_expr(ast, v, out);
            }
        }
        Stmt::AugAssign(a) => {
            if let Some(target) = name_text(&a.target) {
                let r = a.target.range();
                let (line, col) = ast.line_col(r.start().to_u32());
                out.push(AssignEvent { line, col, target, value: classify(ast, &a.value) });
            }
            walk_expr(ast, &a.value, out);
        }
        Stmt::Expr(e) => walk_expr(ast, &e.value, out),
        Stmt::For(f) => {
            // 循环变量 = 迭代元素形态(解构目标展开)。
            let kind = classify(ast, &f.iter);
            let mut names = Vec::new();
            binding_target_names(&f.target, &mut names);
            push_names(ast, names, kind, out);
            walk_expr(ast, &f.iter, out);
            walk_stmts(ast, &f.body, out);
            walk_stmts(ast, &f.orelse, out);
        }
        Stmt::While(w) => {
            walk_expr(ast, &w.test, out);
            walk_stmts(ast, &w.body, out);
            walk_stmts(ast, &w.orelse, out);
        }
        Stmt::If(i) => {
            walk_expr(ast, &i.test, out);
            walk_stmts(ast, &i.body, out);
            for clause in &i.elif_else_clauses {
                if let Some(t) = &clause.test {
                    walk_expr(ast, t, out);
                }
                walk_stmts(ast, &clause.body, out);
            }
        }
        Stmt::With(w) => {
            for item in &w.items {
                // as 变量 = 上下文表达式形态(解构目标展开)。
                if let Some(v) = &item.optional_vars {
                    let mut names = Vec::new();
                    binding_target_names(v, &mut names);
                    push_names(ast, names, classify(ast, &item.context_expr), out);
                }
                walk_expr(ast, &item.context_expr, out);
            }
            walk_stmts(ast, &w.body, out);
        }
        Stmt::Try(t) => {
            walk_stmts(ast, &t.body, out);
            for h in &t.handlers {
                let ast::ExceptHandler::ExceptHandler(h) = h;
                // except E as e:异常变量 = 异常类型表达式形态;裸 except 无类型。
                if let Some(n) = &h.name {
                    let kind = h
                        .type_
                        .as_ref()
                        .map(|te| classify(ast, te))
                        .unwrap_or_else(|| ExprKind::Unknown("bare-except".into()));
                    let (line, col) = ast.line_col(n.range.start().to_u32());
                    out.push(AssignEvent { line, col, target: n.as_str().to_string(), value: kind });
                }
                walk_stmts(ast, &h.body, out);
            }
            walk_stmts(ast, &t.orelse, out);
            walk_stmts(ast, &t.finalbody, out);
        }
        Stmt::Return(r) => {
            if let Some(v) = &r.value {
                walk_expr(ast, v, out);
            }
        }
        Stmt::FunctionDef(f) => walk_stmts(ast, &f.body, out),
        Stmt::ClassDef(c) => walk_stmts(ast, &c.body, out),
        Stmt::Match(m) => {
            let kind = classify(ast, &m.subject);
            walk_expr(ast, &m.subject, out);
            for arm in &m.cases {
                // case 模式绑定 = 被检者形态(解构模式展开)。
                let mut names = Vec::new();
                pattern_binding_names(&arm.pattern, &mut names);
                push_names(ast, names, kind.clone(), out);
                walk_stmts(ast, &arm.body, out);
            }
        }
        _ => {}
    }
}

/// 递归下钻嵌套表达式,登记 **Expr 层局部写点**(海象赋值 `x := v`);
/// 纯读表达式(属性/下标/调用/字面量)不产生事件,由 [`find_expr_at`]
/// 的点位查询负责。元组解包写点在语句层([`walk_stmt`] Assign 臂)登记。
fn walk_expr(ast: &ParsedAst, e: &Expr, out: &mut Vec<AssignEvent>) {
    match e {
        Expr::Attribute(a) => walk_expr(ast, &a.value, out),
        Expr::Subscript(s) => {
            walk_expr(ast, &s.value, out);
            walk_expr(ast, &s.slice, out);
        }
        Expr::Call(c) => {
            walk_expr(ast, &c.func, out);
            for a in &c.arguments.args {
                walk_expr(ast, a, out);
            }
            for k in &c.arguments.keywords {
                walk_expr(ast, &k.value, out);
            }
        }
        Expr::BinOp(b) => {
            walk_expr(ast, &b.left, out);
            walk_expr(ast, &b.right, out);
        }
        Expr::UnaryOp(u) => walk_expr(ast, &u.operand, out),
        Expr::BoolOp(b) => {
            for v in &b.values {
                walk_expr(ast, v, out);
            }
        }
        Expr::Compare(c) => {
            for op in &c.operands {
                walk_expr(ast, op, out);
            }
        }
        Expr::If(ie) => {
            walk_expr(ast, &ie.test, out);
            walk_expr(ast, &ie.body, out);
            walk_expr(ast, &ie.orelse, out);
        }
        Expr::Await(a) => walk_expr(ast, &a.value, out),
        Expr::Named(ne) => {
            // 海象赋值 = Expr 层局部写点(目标名 span 键,同行列序成立)。
            let mut names = Vec::new();
            binding_target_names(&ne.target, &mut names);
            for (target, r) in names {
                let (line, col) = ast.line_col(r.start().to_u32());
                out.push(AssignEvent { line, col, target, value: classify(ast, &ne.value) });
            }
            walk_expr(ast, &ne.value, out);
        }
        Expr::List(l) => {
            for v in &l.elts {
                walk_expr(ast, v, out);
            }
        }
        Expr::Tuple(t) => {
            for v in &t.elts {
                walk_expr(ast, v, out);
            }
        }
        Expr::Set(s) => {
            for v in &s.elts {
                walk_expr(ast, v, out);
            }
        }
        Expr::Dict(d) => {
            for i in &d.items {
                if let Some(k) = &i.key {
                    walk_expr(ast, k, out);
                }
                walk_expr(ast, &i.value, out);
            }
        }
        Expr::FString(fs) => {
            if let Some(single) = fs.as_single_part_fstring() {
                for e in single.elements.interpolations() {
                    walk_expr(ast, &e.expression, out);
                }
            }
        }
        _ => {}
    }
}

/// 目标位置的表达式归类:先找包含 `(line,col)` 的最内层赋值/调用表达式,
/// 找不到时回退到最近一次 `(line,col)` 之前的局部赋值事件(别名重绑定
/// 语义:取最近一次,之后重绑即遮蔽)。
pub fn expr_kind_at(ast: &ParsedAst, line: usize, col: usize) -> Option<ExprKind> {
    // 直接点中表达式:递归在语句体内找包含点位的表达式。
    if let Some(kind) = find_expr_at(ast, &ast.module().body, line, col) {
        return Some(kind);
    }
    // 回退:点位之前最近一次赋值(全名,不限目标)。
    collect_assign_events(ast)
        .into_iter()
        .rfind(|e| (e.line, e.col) <= (line, col))
        .map(|e| e.value)
}

/// 局部绑定:点位之前最近一次对 `name` 的赋值(重绑定失效 = 取最近)。
///
/// `events` 须为 [`collect_assign_events`] 的产物(已按 `(line,col)` 升序,
/// 故「最近」= 最后一个匹配项)。
pub fn local_binding_at<'a>(
    events: &'a [AssignEvent],
    line: usize,
    col: usize,
    name: &str,
) -> Option<&'a AssignEvent> {
    events
        .iter()
        .rfind(|e| e.target == name && (e.line, e.col) <= (line, col))
}

fn find_expr_at(ast: &ParsedAst, stmts: &[Stmt], line: usize, col: usize) -> Option<ExprKind> {
    for s in stmts {
        if let Some(kind) = find_expr_in_stmt(ast, s, line, col) {
            return Some(kind);
        }
    }
    None
}

fn find_expr_in_stmt(ast: &ParsedAst, s: &Stmt, line: usize, col: usize) -> Option<ExprKind> {
    match s {
        Stmt::Assign(a) => {
            if range_contains(a.value.range(), line, col, ast) {
                return Some(classify(ast, &a.value));
            }
            find_expr_in_list(ast, &[&a.value], line, col)
        }
        Stmt::AnnAssign(a) => {
            if let Some(v) = &a.value {
                if range_contains(v.range(), line, col, ast) {
                    return Some(classify(ast, v));
                }
                return find_expr_in_list(ast, &[v], line, col);
            }
            None
        }
        Stmt::AugAssign(a) => {
            if range_contains(a.value.range(), line, col, ast) {
                return Some(classify(ast, &a.value));
            }
            None
        }
        Stmt::Expr(e) => {
            if range_contains(e.value.range(), line, col, ast) {
                return Some(classify(ast, &e.value));
            }
            find_expr_in_list(ast, &[&e.value], line, col)
        }
        Stmt::For(f) => {
            if range_contains(f.iter.range(), line, col, ast) {
                return Some(classify(ast, &f.iter));
            }
            find_expr_at(ast, &f.body, line, col).or_else(|| find_expr_at(ast, &f.orelse, line, col))
        }
        Stmt::While(w) => {
            if range_contains(w.test.range(), line, col, ast) {
                return Some(classify(ast, &w.test));
            }
            find_expr_at(ast, &w.body, line, col)
        }
        Stmt::If(i) => {
            if range_contains(i.test.range(), line, col, ast) {
                return Some(classify(ast, &i.test));
            }
            if let Some(kind) = find_expr_at(ast, &i.body, line, col) {
                return Some(kind);
            }
            for clause in &i.elif_else_clauses {
                if let Some(t) = &clause.test {
                    if range_contains(t.range(), line, col, ast) {
                        return Some(classify(ast, t));
                    }
                }
                if let Some(kind) = find_expr_at(ast, &clause.body, line, col) {
                    return Some(kind);
                }
            }
            None
        }
        Stmt::With(w) => {
            for item in &w.items {
                if range_contains(item.context_expr.range(), line, col, ast) {
                    return Some(classify(ast, &item.context_expr));
                }
            }
            find_expr_at(ast, &w.body, line, col)
        }
        Stmt::Return(r) => r.value.as_ref().and_then(|v| {
            if range_contains(v.range(), line, col, ast) {
                Some(classify(ast, v))
            } else {
                find_expr_in_list(ast, &[v], line, col)
            }
        }),
        Stmt::FunctionDef(f) => find_expr_at(ast, &f.body, line, col),
        Stmt::ClassDef(c) => find_expr_at(ast, &c.body, line, col),
        Stmt::Try(t) => find_expr_at(ast, &t.body, line, col)
            .or_else(|| {
                t.handlers.iter().find_map(|h| {
                    let ast::ExceptHandler::ExceptHandler(h) = h;
                    find_expr_at(ast, &h.body, line, col)
                })
            })
            .or_else(|| find_expr_at(ast, &t.orelse, line, col))
            .or_else(|| find_expr_at(ast, &t.finalbody, line, col)),
        _ => None,
    }
}

fn find_expr_in_list(ast: &ParsedAst, exprs: &[&Expr], line: usize, col: usize) -> Option<ExprKind> {
    for e in exprs {
        if range_contains(e.range(), line, col, ast) {
            return Some(classify(ast, e));
        }
        // 下钻容器/调用参数。
        let inner = match e {
            Expr::Attribute(a) => Some(&a.value),
            Expr::Subscript(s) => Some(&s.value),
            Expr::Call(c) => Some(&c.func),
            _ => None,
        };
        if let Some(i) = inner {
            if range_contains(i.range(), line, col, ast) {
                return Some(classify(ast, i));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ast(src: &str) -> ParsedAst {
        ParsedAst::new(src)
    }

    #[test]
    fn classifies_call_subscript_attribute() {
        let a = ast("x = repo.load()\ny = data['hp']\nz = self.cell\n");
        // x 行:调用。
        assert!(matches!(expr_kind_at(&a, 0, 4), Some(ExprKind::Call { .. })));
        // y 行:下标。
        assert!(matches!(expr_kind_at(&a, 1, 4), Some(ExprKind::Subscript { .. })));
        // z 行:属性读。
        assert!(matches!(expr_kind_at(&a, 2, 4), Some(ExprKind::Attribute { .. })));
    }

    #[test]
    fn local_assign_recognized() {
        let a = ast("x = build()\n");
        let ev = collect_assign_events(&a);
        assert!(matches!(local_binding_at(&ev, 0, 5, "x"), Some(AssignEvent { value: ExprKind::Call { .. }, .. })));
    }

    #[test]
    fn rebinding_invalidates() {
        let a = ast("x = 1\nx = build()\n");
        let ev = collect_assign_events(&a);
        // 点位在第 1 行之后 → 最近一次绑定 = 第 1 行(build 调用)。
        let b = local_binding_at(&ev, 1, 5, "x").expect("最近写点胜");
        assert_eq!(b.line, 1);
        assert!(matches!(b.value, ExprKind::Call { .. }));
        // 点位在第 0 行 → 第一次绑定。
        let b0 = local_binding_at(&ev, 0, 5, "x").expect("首绑定");
        assert_eq!(b0.line, 0);
    }

    #[test]
    fn same_line_ordered_by_column() {
        let a = ast("x = 1; y = 2\n");
        let events = collect_assign_events(&a);
        assert_eq!(events.len(), 2);
        assert!(events[0].col < events[1].col, "同行按列序");
        assert_eq!(events[0].target, "x");
        assert_eq!(events[1].target, "y");
    }

    #[test]
    fn tuple_unpack_registers_each_target() {
        let a = ast("a, b = 1, 2\n");
        let events = collect_assign_events(&a);
        assert_eq!(events.len(), 2, "解包逐名登记");
        assert_eq!(events[0].target, "a");
        assert_eq!(events[1].target, "b");
        assert!(events[0].col < events[1].col, "同行按列序");
        assert!(matches!(events[0].value, ExprKind::LocalAssign { .. }), "字面量 RHS");
    }

    #[test]
    fn nested_unpack_and_starred() {
        let a = ast("a, (b, *rest) = shape\n");
        let events = collect_assign_events(&a);
        let targets: Vec<&str> = events.iter().map(|e| e.target.as_str()).collect();
        assert_eq!(targets, ["a", "b", "rest"], "嵌套/Starred 展开登记");
        assert!(events.iter().all(|e| matches!(e.value, ExprKind::LocalAssign { .. })));
    }

    #[test]
    fn walrus_write_registered() {
        let a = ast("if (n := len(data)) > 0:\n    pass\n");
        let events = collect_assign_events(&a);
        assert_eq!(events.len(), 1, "海象 = Expr 层局部写点");
        assert_eq!(events[0].target, "n");
        assert!(matches!(events[0].value, ExprKind::Call { .. }));
    }

    #[test]
    fn multi_target_assign_all_registered() {
        let a = ast("x = y = build()\n");
        let events = collect_assign_events(&a);
        assert_eq!(events.len(), 2, "链式多目标逐名登记");
        assert!(events.iter().all(|e| matches!(e.value, ExprKind::Call { .. })));
        assert_eq!(events[0].target, "x");
        assert_eq!(events[1].target, "y");
    }

    #[test]
    fn for_target_and_unpack_registered() {
        let a = ast("for i in items:\n    pass\nfor k, v in pairs:\n    pass\n");
        let events = collect_assign_events(&a);
        let targets: Vec<&str> = events.iter().map(|e| e.target.as_str()).collect();
        assert_eq!(targets, ["i", "k", "v"], "循环变量与解构展开");
        assert!(matches!(events[0].value, ExprKind::LocalAssign { .. }), "iter 名归局部赋值形态");
    }

    #[test]
    fn match_case_bindings_registered() {
        let a = ast("match point:\n    case (x, y):\n        pass\n    case [a, *rest]:\n        pass\n    case {'k': v}:\n        pass\n    case C():\n        pass\n    case str() as s:\n        pass\n    case _:\n        pass\n");
        let events = collect_assign_events(&a);
        let targets: Vec<&str> = events.iter().map(|e| e.target.as_str()).collect();
        // 每个命中 case 的绑定都登记(case 间可能同名,顺序 = 模式序)。
        assert!(targets.contains(&"x"), "序列模式绑定:x in {targets:?}");
        assert!(targets.contains(&"y"), "序列模式绑定:y in {targets:?}");
        assert!(targets.contains(&"a"), "列表模式绑定:a in {targets:?}");
        assert!(targets.contains(&"rest"), "Star 模式绑定:rest in {targets:?}");
        assert!(targets.contains(&"v"), "映射模式值绑定:v in {targets:?}");
        assert!(targets.contains(&"s"), "As 捕获:s in {targets:?}");
        assert!(!targets.contains(&"_"), "通配 `_` 不产生绑定");
    }

    #[test]
    fn with_as_and_except_as_registered() {
        let a = ast("with open(p) as f:\n    pass\ntry:\n    pass\nexcept ValueError as e:\n    pass\n");
        let events = collect_assign_events(&a);
        let targets: Vec<&str> = events.iter().map(|e| e.target.as_str()).collect();
        assert_eq!(targets, ["f", "e"], "with-as/except-as 均为局部绑定");
        assert!(matches!(events[0].value, ExprKind::Call { .. }), "as 值形态=上下文表达式");
        assert!(matches!(&events[1].value, ExprKind::LocalAssign { target } if target == "ValueError"), "except 值形态=异常类型名表达式");
    }

    #[test]
    fn unknown_form_not_fabricated() {
        let a = ast("x = lambda: 1\n");
        assert!(matches!(expr_kind_at(&a, 0, 4), Some(ExprKind::Unknown(_))));
    }

    #[test]
    fn call_receiver_text_preserved() {
        let a = ast("v = self.mgr.fetch()\n");
        if let Some(ExprKind::Call { callee }) = expr_kind_at(&a, 0, 4) {
            assert!(callee.contains("self.mgr.fetch"), "callee 全形态保留: {callee}");
        } else {
            panic!("必须 Call");
        }
    }
}
