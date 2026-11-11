//! BAS-07 Python 表达式来源。
//!
//! 直接走 Ruff AST(设计 §4「来源」):把 `(line, col)` 位置的表达式归类为
//! 属性读/下标/调用/局部赋值,并按语句位置区分**同行执行顺序**(列序)。
//! 别名重绑定后失效:同名局部赋值按 `(line, col)` 取最近一次,之后的重绑
//! 定即遮蔽(与流面「最近写点胜」同语义)。
//!
//! 未知形态诚实归 [`ExprKind::Unknown`](原因),不猜成任意表达式。

use ruff_python_ast::{self as ast, Expr, Ranged, Stmt};
use ruff_text_size::TextRange;

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
        Expr::IfExp(ie) => classify(ast, &ie.body),
        Expr::List(l) => l.elts.first().map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("empty-list".into())),
        Expr::Tuple(t) => t.elts.first().map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("empty-tuple".into())),
        Expr::Set(s) => s.elts.first().map(|v| classify(ast, v)).unwrap_or_else(|| ExprKind::Unknown("empty-set".into())),
        Expr::Dict(d) => d
            .items
            .first()
            .and_then(|i| i.value.as_ref())
            .map(|v| classify(ast, v))
            .unwrap_or_else(|| ExprKind::Unknown("empty-dict".into())),
        Expr::Constant(c) => ExprKind::LocalAssign { target: format!("{:?}", c.value) },
        Expr::Lambda(_) => ExprKind::Unknown("lambda".into()),
        Expr::GeneratorExp(_) | Expr::ListComp(_) | Expr::SetComp(_) | Expr::DictComp(_) => {
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

fn walk_stmt(ast: &ParsedAst, s: &Stmt, out: &mut Vec<AssignEvent>) {
    match s {
        Stmt::Assign(a) => {
            let kind = classify(ast, &a.value);
            for t in &a.targets {
                if let Some(target) = name_text(t) {
                    let r = a.value.range();
                    let (line, col) = ast.line_col(r.start().to_u32());
                    out.push(AssignEvent { line, col, target, value: kind.clone() });
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
            walk_stmts(ast, &i.orelse, out);
        }
        Stmt::With(w) => {
            for item in &w.items {
                walk_expr(ast, &item.context_expr, out);
            }
            walk_stmts(ast, &w.body, out);
        }
        Stmt::Try(t) => {
            walk_stmts(ast, &t.body, out);
            for h in &t.handlers {
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
            walk_expr(ast, &m.subject, out);
            for arm in &m.cases {
                walk_stmts(ast, &arm.body, out);
            }
        }
        _ => {}
    }
}

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
            walk_expr(ast, &c.left, out);
            for o in &c.comparators {
                walk_expr(ast, o, out);
            }
        }
        Expr::IfExp(ie) => {
            walk_expr(ast, &ie.test, out);
            walk_expr(ast, &ie.body, out);
            walk_expr(ast, &ie.orelse, out);
        }
        Expr::Await(a) => walk_expr(ast, &a.value, out),
        Expr::Named(ne) => walk_expr(ast, &ne.value, out),
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
                walk_expr(ast, &i.key, out);
                if let Some(v) = &i.value {
                    walk_expr(ast, v, out);
                }
            }
        }
        Expr::JoinedStr(js) => {
            for v in &js.values {
                walk_expr(ast, v, out);
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
    // 回退:该名在点位之前最近一次赋值。
    let events = collect_assign_events(ast);
    let before: Vec<&AssignEvent> = events.iter().filter(|e| (e.line, e.col) <= (line, col)).collect();
    before.last().map(|e| e.value.clone())
}

/// 局部绑定:点位之前最近一次对 `name` 的赋值(重绑定失效 = 取最近)。
pub fn local_binding_at(ast: &ParsedAst, line: usize, col: usize, name: &str) -> Option<&AssignEvent> {
    collect_assign_events(ast)
        .iter()
        .filter(|e| e.target == name && (e.line, e.col) <= (line, col))
        .last()
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
            find_expr_at(ast, &i.body, line, col).or_else(|| find_expr_at(ast, &i.orelse, line, col))
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
                t.handlers.iter().find_map(|h| find_expr_at(ast, &h.body, line, col))
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
        assert!(matches!(local_binding_at(&a, 0, 5, "x"), Some(AssignEvent { value: ExprKind::Call { .. }, .. })));
    }

    #[test]
    fn rebinding_invalidates() {
        let a = ast("x = 1\nx = build()\n");
        // 点位在第 1 行之后 → 最近一次绑定 = 第 1 行(build 调用)。
        let b = local_binding_at(&a, 1, 5, "x").expect("最近写点胜");
        assert_eq!(b.line, 1);
        assert!(matches!(b.value, ExprKind::Call { .. }));
        // 点位在第 0 行 → 第一次绑定。
        let b0 = local_binding_at(&a, 0, 5, "x").expect("首绑定");
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
