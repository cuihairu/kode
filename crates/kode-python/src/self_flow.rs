//! LANG-NAR-1 semantics engine flow-sensitive narrowing (RUST-MIGRATION-AUDIT-006 B1 lane batch 1).
//!
//! Port of TS `src/backend/selfAttributeFlowTypes.ts` (567 lines): the line
//! scanner / guard / type inference sections are kept verbatim; the class span
//! extraction section was rerouted to ruff AST in precision main lane batch A
//! (class_spans_from_ast) - a domain correctness upgrade (true domains for
//! nested classes / conditional def, unterminated files no longer swallow the
//! tail), while line scanning semantics still take the TS engine as the
//! reference (spans equal for flat files, see the ClassSpan note). The TS
//! engine is frozen as a kill-switch fallback and is no longer the byte parity
//! comparison baseline (output may improve legitimately, split-parity:
//! untouched dimensions keep deep equality, upgraded dimensions get precision
//! asserts).
//!
//! Porting contract (verbatim alignment points):
//! - UTF-16 code units throughout (same basis as JS string indexing); the line
//!   walker consumes the caller's lines as given (inlay path raw text /
//!   diagnostics path masked lines, Rust does not mask a second time - same
//!   contract as the TS pure function);
//! - class span path = lines join('\n') -> UTF-8 -> ruff tolerant parse
//!   (partial AST, best effort for half-finished files) -> AST walk producing
//!   ClassSpan{name,start_line,end_line,method_lines:name->def name line,
//!   method_domains:true body domain}. Decorators do not count as lines
//!   (ruff class/def range includes the @ prefix, corrected to the name.range
//!   start); end_line = last statement character line + 1 (exclusive); a nested
//!   class becomes its own ClassSpan, a def inside a class body control block
//!   still belongs to the class (same membership as the old flattened
//!   semantics), no descent into a def body (same membership as the old
//!   scope.function);
//! - every regex is manually expanded into a scanner, leftmost-priority
//!   alternation + backtracking semantics kept verbatim (including the JS
//!   behavior of anyBlockOpen not switching keyword after `else` matches but
//!   fails the word boundary);
//!   `\s` takes the full JS class (including  /　/﻿ etc.), `\w` = `[A-Za-z0-9_]`;
//! - the type collection is a BTreeSet (output always sorted, equal to TS
//!   `[...set].sort()`; the non-BMP code point ordering difference = byte
//!   order vs UTF-16 code unit order, all type atoms are ASCII so untouched);
//! - the `SelfAttributeFlowOptions` callback surface is not in the RPC
//!   contract (always undefined in production), Rust has no such parameter -
//!   call / bare name resolution is always the empty set (consistent with
//!   production TS behavior);
//! - KODE-PERF-001 version keyed LRU parse cache: max=8, touch moves to
//!   tail / evict the oldest, key = the opaque string passed by TS (product of
//!   flowVersionKeyForDocument); no key = parse now without caching (pure
//!   function fallback, byte for byte identical). The cache value stores only
//!   the class spans the engine needs (equivalent in engine behavior to TS
//!   caching the whole ParsedPythonFile).
//!
//! Honest boundary: types are represented as a set of annotation string atoms;
//! when nothing can be inferred the set is empty (never fabricate Any).

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use crate::cancel;
use crate::parse::ParsedAst;
use ruff_python_ast as ast;
use ruff_text_size::Ranged;

/// Version key LRU capacity (TS PARSE_CACHE_MAX_ENTRIES = 8)
pub const PARSE_CACHE_MAX_ENTRIES: usize = 8;

// ---- basic character classes (JS semantics) -------------------------------

/// JS `\s` full class (code units): \t \n \v \f \r space      -
///
pub(crate) fn is_js_space(code: u16) -> bool {
    matches!(code, 0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20)
        || code == 0xA0
        || code == 0x1680
        || (0x2000..=0x200A).contains(&code)
        || code == 0x2028
        || code == 0x2029
        || code == 0x202F
        || code == 0x205F
        || code == 0x3000
        || code == 0xFEFF
}

/// JS line terminators (the `.` exclusion set; a lone `\r`/U+2028/U+2029 inside a line makes the `.+/$` shape mismatch)
pub(crate) fn is_js_line_terminator(code: u16) -> bool {
    matches!(code, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// TS word start character class `[A-Za-z_]` (digits excluded)
pub(crate) fn is_name_start(code: u16) -> bool {
    code == 0x5F || (0x41..=0x5A).contains(&code) || (0x61..=0x7A).contains(&code)
}

/// TS `\w` = `[A-Za-z0-9_]`
pub(crate) fn is_word(code: u16) -> bool {
    is_name_start(code) || (0x30..=0x39).contains(&code)
}

// ---- pythonCodeLines masking (verbatim port of pythonParser.ts:26-51) ------

/// `content.split(/\r?\n/)` (trailing `\r` stripped). Reused by the
/// attributeNone diagnostics surface: the masked text line array is produced
/// the same way as TS `maskedText.split(/\r?\n/)`.
pub fn split_crlf(content: &[u16]) -> Vec<Vec<u16>> {
    let mut lines = Vec::new();
    let mut current = Vec::new();
    let mut i = 0usize;
    while i < content.len() {
        let code = content[i];
        if code == 0x0A {
            if let Some(&0x0D) = current.last() {
                current.pop();
            }
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(code);
        }
        i += 1;
    }
    lines.push(current);
    lines
}

// ---- line level predicates (shared by line scanner and AST spans) ----------

/// Leading `[ \t]*` indentation (tab counts as 4)
fn indent_of(line: &[u16]) -> usize {
    let mut indent = 0usize;
    for &code in line {
        if code == 0x20 {
            indent += 1;
        } else if code == 0x09 {
            indent += 4;
        } else {
            break;
        }
    }
    indent
}

/// `^\s*$` (the full JS \s class)
fn is_blank(line: &[u16]) -> bool {
    line.iter().all(|&code| is_js_space(code))
}

/// `^\s*(#.*)?$`
fn is_comment_only(line: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    i == line.len() || line[i] == 0x23
}

// ---- class span extraction (derived from ruff AST; precision main lane batch A)

/// The true body domain of a method (0 based, inclusive of the tail): from the
/// def name line to the last character line of the def statement.
#[derive(Debug, Clone)]
pub struct MethodDomain {
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
}

/// Class span (the fields the engine needs; the character column of TS
/// methods is never read by the engine, so it is not ported)
#[derive(Debug, Clone)]
pub struct ClassSpan {
    pub name: String,
    /// 0 based start line (the class name line; decorators do not count - the ruff range includes the @ prefix, corrected to the name line)
    pub start_line: usize,
    /// 0 based end line (excluded) = last class statement character line + 1
    /// (trailing blank lines / comments no longer belong to the class; when
    /// the class is not closed before EOF it naturally converges at the end
    /// of the file)
    pub end_line: usize,
    /// method name -> 0 based def name line (for duplicates the later one wins,
    /// consistent with the old HashMap semantics)
    pub method_lines: HashMap<String, usize>,
    /// true method body domains (among the enclosing_method candidates the
    /// innermost domain wins; nested class / conditional def attribution
    /// corrected)
    pub method_domains: Vec<MethodDomain>,
}

/// Line of the last statement character (0 based; range end is an exclusive byte offset, a tolerant saturating fallback for an empty range).
fn last_char_line(ast: &ParsedAst, range: ruff_text_size::TextRange) -> usize {
    ast.line_col(range.end().to_u32().saturating_sub(1)).0
}

/// KBUG-ORDER: 0 based line + 0 based UTF-16 column (same semantics as VSCode
/// Position.character; the line_col product is already a UTF-16 column, a
/// surrogate pair counting as 2). Lexicographic order = source execution order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Pos {
    pub(crate) line: usize,
    pub(crate) col: usize,
}

fn stmt_pos(ast: &ParsedAst, range: ruff_text_size::TextRange) -> Pos {
    let (line, col) = ast.line_col(range.start().to_u32());
    Pos { line, col }
}

fn stmt_end_pos(ast: &ParsedAst, range: ruff_text_size::TextRange) -> Pos {
    let (line, col) = ast.line_col(range.end().to_u32().saturating_sub(1));
    Pos { line, col }
}

/// Class spans = an AST walk over the ruff tolerant parse result (a half-finished file still yields partial spans on a best effort basis).
pub fn class_spans_from_ast(ast: &ParsedAst) -> Vec<ClassSpan> {
    let mut classes: Vec<ClassSpan> = Vec::new();
    walk_class_scopes(ast, &ast.module().body, None, &mut classes);
    classes
}

/// Scope walk: class body direct children plus defs inside control blocks still
/// belong to the current class (same membership as the old flattened
/// semantics); no descent into a def body (classes / methods inside a function
/// are not recorded, same membership as the old scope.function semantics);
/// a nested class becomes its own ClassSpan (its methods belong to the nested
/// class, not to the outer class).
fn walk_class_scopes(
    ast: &ParsedAst,
    body: &[ast::Stmt],
    owner: Option<usize>,
    classes: &mut Vec<ClassSpan>,
) {
    for stmt in body {
        match stmt {
            ast::Stmt::ClassDef(cls) => {
                let start_line = ast.line_col(cls.name.range.start().to_u32()).0;
                classes.push(ClassSpan {
                    name: cls.name.as_str().to_string(),
                    start_line,
                    end_line: last_char_line(ast, cls.range) + 1,
                    method_lines: HashMap::new(),
                    method_domains: Vec::new(),
                });
                let idx = classes.len() - 1;
                walk_class_scopes(ast, &cls.body, Some(idx), classes);
            }
            ast::Stmt::FunctionDef(fun) => {
                if let Some(idx) = owner {
                    let name = fun.name.as_str().to_string();
                    let start_line = ast.line_col(fun.name.range.start().to_u32()).0;
                    let end_line = last_char_line(ast, fun.range);
                    classes[idx].method_lines.insert(name.clone(), start_line);
                    classes[idx].method_domains.push(MethodDomain {
                        name,
                        start_line,
                        end_line,
                    });
                }
            }
            ast::Stmt::If(s) => {
                walk_class_scopes(ast, &s.body, owner, classes);
                for clause in &s.elif_else_clauses {
                    walk_class_scopes(ast, &clause.body, owner, classes);
                }
            }
            ast::Stmt::For(s) => {
                walk_class_scopes(ast, &s.body, owner, classes);
                walk_class_scopes(ast, &s.orelse, owner, classes);
            }
            ast::Stmt::While(s) => {
                walk_class_scopes(ast, &s.body, owner, classes);
                walk_class_scopes(ast, &s.orelse, owner, classes);
            }
            ast::Stmt::With(s) => walk_class_scopes(ast, &s.body, owner, classes),
            ast::Stmt::Try(s) => {
                walk_class_scopes(ast, &s.body, owner, classes);
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    walk_class_scopes(ast, &inner.body, owner, classes);
                }
                walk_class_scopes(ast, &s.orelse, owner, classes);
                walk_class_scopes(ast, &s.finalbody, owner, classes);
            }
            ast::Stmt::Match(s) => {
                for case in &s.cases {
                    walk_class_scopes(ast, &case.body, owner, classes);
                }
            }
            _ => {}
        }
    }
}

// ---- assignment type index (precision main lane batch B: typeOfExpr on the AST)

/// Assignment type index: key = (0 based start line, target name), value = the
/// RHS (or value-less annotation) type set.
/// "Key present, value empty" = the assignment holds but no type can be derived
/// (replacement semantics: the empty set overwrites the old value = honest
/// unknown); "key absent" = that target is not assigned on that line (state
/// preserved). The two meanings must be carried separately.
#[derive(Debug, Clone, Default)]
pub struct AssignmentTypes {
    map: HashMap<(usize, String), TypeSet>,
}

impl AssignmentTypes {
    fn insert(&mut self, line: usize, name: &str, types: TypeSet) {
        self.map.insert((line, name.to_string()), types);
    }

    /// attr is queried in UTF-16 code units (same target shape as the line scanner).
    fn get(&self, line: usize, name: &[u16]) -> Option<&TypeSet> {
        let key = String::from_utf16(name).ok()?;
        self.map.get(&(line, key))
    }
}

/// Class body direct assignment index (baseline surface): key = (class start
/// line, line, name). Carries class identity - nested class direct entries do
/// not enter the outer class baseline (the old engine excluded them via indent
/// filtering; the AST surface achieves the same semantics with an identity
/// key).
#[derive(Debug, Clone, Default)]
pub struct ClassAssignmentTypes {
    map: HashMap<(usize, usize, String), TypeSet>,
}

impl ClassAssignmentTypes {
    fn insert(&mut self, class_start: usize, line: usize, name: &str, types: TypeSet) {
        self.map
            .insert((class_start, line, name.to_string()), types);
    }

    fn get(&self, class_start: usize, line: usize, name: &[u16]) -> Option<&TypeSet> {
        let key = String::from_utf16(name).ok()?;
        self.map.get(&(class_start, line, key))
    }
}

/// Expression types (literal surface; derived directly from ruff AST nodes).
/// None/bool/int/float/complex/str (bytes/f/t strings typed separately)/list/
/// set/dict/tuple/ellipsis; walrus -> the inner expression; numeric / logical
/// unary; everything else (call / attribute chain / bare name / binary op /
/// comprehension / lambda / ternary) -> the empty set (nothing fabricated;
/// calls and bare names belong to batch C).
fn ast_type_of_expr(expr: &ast::Expr) -> TypeSet {
    match expr {
        ast::Expr::NoneLiteral(_) => atom("None"),
        ast::Expr::BooleanLiteral(_) => atom("bool"),
        ast::Expr::NumberLiteral(n) => match &n.value {
            ast::Number::Int(_) => atom("int"),
            ast::Number::Float(_) => atom("float"),
            ast::Number::Complex { .. } => atom("complex"),
        },
        ast::Expr::StringLiteral(_) => atom("str"),
        ast::Expr::BytesLiteral(_) => atom("bytes"),
        ast::Expr::FString(_) => atom("str"),
        ast::Expr::TString(_) => atom("str"),
        ast::Expr::EllipsisLiteral(_) => atom("ellipsis"),
        ast::Expr::List(_) => atom("list"),
        ast::Expr::Set(_) => atom("set"),
        ast::Expr::Dict(_) => atom("dict"),
        ast::Expr::Tuple(_) => atom("tuple"),
        ast::Expr::Named(n) => ast_type_of_expr(&n.value),
        ast::Expr::UnaryOp(u) => match u.op {
            ast::UnaryOp::Not => atom("bool"),
            ast::UnaryOp::UAdd | ast::UnaryOp::USub => match numeric_atom(&u.operand) {
                // -x/+x keeps the type; bool under -/+ lands on int (-True == -1); nothing else is fabricated
                NumericAtom::IntOrBool => atom("int"),
                NumericAtom::Float => atom("float"),
                NumericAtom::Complex => atom("complex"),
                NumericAtom::Unknown => TypeSet::new(),
            },
            ast::UnaryOp::Invert => match numeric_atom(&u.operand) {
                NumericAtom::IntOrBool => atom("int"),
                _ => TypeSet::new(),
            },
        },
        _ => TypeSet::new(),
    }
}

/// Numeric unary operand classification (directly from the AST shape; parens
/// are stripped by ruff, walrus takes the inner expression, nested +/- keep
/// drilling down).
#[derive(Debug, Clone, Copy, PartialEq)]
enum NumericAtom {
    IntOrBool,
    Float,
    Complex,
    Unknown,
}

fn numeric_atom(expr: &ast::Expr) -> NumericAtom {
    match expr {
        ast::Expr::Named(n) => numeric_atom(&n.value),
        ast::Expr::UnaryOp(u) if matches!(u.op, ast::UnaryOp::UAdd | ast::UnaryOp::USub) => {
            numeric_atom(&u.operand)
        }
        ast::Expr::NumberLiteral(n) => match &n.value {
            ast::Number::Int(_) => NumericAtom::IntOrBool,
            ast::Number::Float(_) => NumericAtom::Float,
            ast::Number::Complex { .. } => NumericAtom::Complex,
        },
        ast::Expr::BooleanLiteral(_) => NumericAtom::IntOrBool,
        _ => NumericAtom::Unknown,
    }
}

/// Annotation text atom: slice the source text by the node byte range + trim
/// (same semantics as the old "`[^=#]+?` capture then trim" - a quoted
/// annotation keeps its quotes, a union annotation is one whole atom); an
/// empty string produces no atom.
fn annotation_text(ast: &ParsedAst, expr: &ast::Expr) -> Option<String> {
    let start = expr.range().start().to_u32() as usize;
    let end = expr.range().end().to_u32() as usize;
    let text = ast.source.get(start..end)?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn is_self_receiver(expr: &ast::Expr) -> bool {
    matches!(expr, ast::Expr::Name(n) if n.id.as_str() == "self")
}

/// Batch C: in-file call / bare name inference (adds genuinely derivable
/// truth). The RHS no longer stops at literals:
/// - same-file module-level def `-> T` annotation (`name(...)` taken
///   directly; duplicated name ambiguity = unknown, never guess the first
///   definition);
/// - `A.m(...)` class qualified method annotation (several classes with the
///   same name = ambiguous, do not guess); `self.m(...)` qualified by the
///   enclosing class;
/// - chained `recv.m(...)`: take that method annotation when the receiver
///   derives to a single atom that happens to be the same class name;
/// - local bare name assignment chain inside the method domain (nearest write
///   site wins = replacement semantics, bounded hops + visited set against
///   cycles);
/// - `self.z` read -> class attribute baseline (batch B converged baseline
///   map, computed over the RAW index, memoized against recomputation);
/// - the await shell is transparent; a walrus target is registered as a local
///   write site (top level / element level, deeper nesting is honestly missed).
///
/// Honest boundary: no annotation / unknown callee / cycle / out of domain ->
/// the empty set, never guess.
const RESOLVE_MAX_HOPS: usize = 4;

/// Return annotation of a module-level def: Single (the annotation, or none) =
/// the only definition; Ambiguous = several with the same name.
#[derive(Debug, Clone)]
pub(crate) enum DefReturn {
    Single(Option<String>),
    Ambiguous,
}

#[derive(Debug, Clone)]
pub(crate) enum CalleeShape {
    /// f(...) - resolved at parse time through
    /// [`ResolveState::callee_atom_at`]: the declaration pre-binding ruling at
    /// the flow position (the def table or the unique class name, whichever;
    /// and if it was already bound by a write site / a local def then the
    /// declaration table is unavailable; None = pre-binding missing /
    /// ambiguous / shadowed by a binding)
    Name(String),
    /// A.m(...)
    Qualified { class: String, method: String },
    /// self.m(...) - qualified by the enclosing class
    SelfMethod(String),
    /// <expr>.m(...) - take that method annotation when the receiver derives to
    /// a unique class name
    Chained {
        receiver: Box<RhsShape>,
        method: String,
    },
}

/// RHS shape snapshot (owned; the AST is discarded right after parse-time derivation, keeping only the derivable surface).
#[derive(Debug, Clone)]
pub(crate) enum RhsShape {
    /// Literal surface (batch B), already finalized
    Typed(TypeSet),
    Call(CalleeShape),
    /// self.z read -> class attribute baseline
    SelfAttr(String),
    /// local bare name (the nearest write site chain within the method domain)
    Local(String),
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum EntryKind {
    SelfAttr,
    ClassDirect,
}

/// Batch D localReturnType surface: entry of the global bare name write site
/// table (module / class body / method body share one table, the surface
/// query filters itself by the scope chain; shape is an owned snapshot).
#[derive(Debug, Clone)]
pub(crate) struct BareWrite {
    pub(crate) line: usize,
    /// KBUG-ORDER: 0 based UTF-16 column of the write site (assignment target / statement head)
    pub(crate) col: usize,
    /// KBUG-ORDER: last character position of the statement holding the write site (the time boundary deciding "has the cursor passed this statement")
    pub(crate) stmt_end: Pos,
    /// KBUG-ORDER-03: RHS start position (the time boundary for alias / RHS
    /// read traceback - only bindings strictly before that position are
    /// visible, self reference / a later write on the same line is invisible)
    pub(crate) rhs_pos: Pos,
    pub(crate) shape: RhsShape,
    /// the class the write site is in (method body write site; class body
    /// direct child = that class; module level = None)
    pub(crate) class_start: Option<usize>,
    /// the innermost def name line the write site belongs to (nested defs
    /// each go to their own; class body direct child / module level = None)
    pub(crate) method_start: Option<usize>,
}

impl BareWrite {
    pub(crate) fn pos(&self) -> Pos {
        Pos {
            line: self.line,
            col: self.col,
        }
    }
}

/// KBUG-SCOPE: function / lambda lexical domain (the AST facts behind the
/// scope chain and parameter shadowing decisions).
/// Every def (module / method / nested) plus directly assigned lambdas are
/// recorded; start/end = the true body domain (0 based, inclusive of the
/// tail; a lambda = the expression line domain; the body first line is the
/// min of the name line to accommodate same-line bodies).
#[derive(Debug, Clone)]
pub(crate) struct FnDomain {
    /// def name line / lambda assignment line (the write site attribution key,
    /// same semantics as BareWrite.method_start)
    pub(crate) header_line: usize,
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    /// the full positional / keyword-only / *args / **kwargs parameter list
    /// (a parameter position always binds in this domain, shadowing the
    /// outer ones)
    pub(crate) params: Vec<String>,
    /// def names direct in this domain (defs inside control blocks have the
    /// same membership; no descent into a nested def body - that belongs to
    /// the inner domain).
    /// A local def is a name binding of this domain (BIND-02: it shadows the
    /// module declaration table)
    pub(crate) def_names: Vec<String>,
    /// `global` declaration names (not bound in this domain; write sites
    /// inside the domain are recorded in the module name space)
    pub(crate) globals: Vec<String>,
    /// `nonlocal` declaration names (not bound in this domain, resolved in
    /// the outer function domain)
    pub(crate) nonlocals: Vec<String>,
}

// ---- KBUG-CFGFLOW: the intra-domain statement flow tree (write site ruling
//      upgraded from "textually nearest" to flow-sensitive reachability) ----

/// Intra-domain statement flow tree snapshot: a def/class head is a straight
/// line step (its body belongs to another domain; a global write site inside
/// it is reached through the span hit, execution order = statement order); a
/// with body is flattened (straight line execution); Try/Match are a
/// conservative union; Loop is conservative (0 iterations + >=1 iterations
/// union); Return/Raise/Break/Continue = termination.
#[derive(Debug, Clone)]
pub(crate) enum FlowStmt {
    Simple {
        start: Pos,
        end: Pos,
    },
    Branch {
        start: Pos,
        end: Pos,
        /// statically provable test truth (boolean / None / numeric / string
        /// literal; names are not folded - they may be rebound, no user code is
        /// executed, the remaining conditions keep their candidates)
        test_const: Option<bool>,
        then_body: Vec<FlowStmt>,
        then_span: (Pos, Pos),
        else_body: Option<Vec<FlowStmt>>,
        else_span: Option<(Pos, Pos)>,
    },
    Loop {
        start: Pos,
        end: Pos,
        body: Vec<FlowStmt>,
        body_span: (Pos, Pos),
        orelse: Vec<FlowStmt>,
    },
    /// Conservative union block for Try/except/else/finally and Match case
    Join {
        start: Pos,
        end: Pos,
        blocks: Vec<(Vec<FlowStmt>, (Pos, Pos))>,
    },
    Terminator {
        pos: Pos,
        end: Pos,
    },
}

impl FlowStmt {
    fn span(&self) -> (Pos, Pos) {
        match self {
            FlowStmt::Simple { start, end } => (*start, *end),
            FlowStmt::Branch { start, end, .. }
            | FlowStmt::Loop { start, end, .. }
            | FlowStmt::Join { start, end, .. } => (*start, *end),
            FlowStmt::Terminator { pos, end } => (*pos, *end),
        }
    }
}

/// Flow value: the reachable write site candidates for that name at the query
/// position (One = uniquely determined; Many = merged several candidates,
/// maybe_unbound = contains an unbound path - honestly unknown, never pick
/// one at will).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FlowVal {
    Unbound,
    One(Pos),
    Many(Vec<Pos>, bool),
}

#[derive(Debug, Clone)]
struct BlockExit {
    val: FlowVal,
    terminated: bool,
}

fn fold_vals(vals: Vec<FlowVal>) -> FlowVal {
    let mut positions: Vec<Pos> = Vec::new();
    let mut maybe_unbound = false;
    for v in &vals {
        match v {
            FlowVal::Unbound => maybe_unbound = true,
            FlowVal::One(p) => positions.push(*p),
            FlowVal::Many(ps, mu) => {
                positions.extend_from_slice(ps);
                maybe_unbound |= *mu;
            }
        }
    }
    positions.sort_unstable();
    positions.dedup();
    if positions.is_empty() {
        FlowVal::Unbound
    } else if positions.len() == 1 && !maybe_unbound {
        FlowVal::One(positions[0])
    } else {
        FlowVal::Many(positions, maybe_unbound)
    }
}

fn tree_span(stmts: &[FlowStmt]) -> (Pos, Pos) {
    match (stmts.first(), stmts.last()) {
        (Some(f), Some(l)) => {
            let (fs, _) = f.span();
            let (_, le) = l.span();
            (fs, le)
        }
        _ => (
            Pos {
                line: usize::MAX,
                col: usize::MAX,
            },
            Pos {
                line: usize::MAX,
                col: usize::MAX,
            },
        ),
    }
}

fn span_has_write(writes: &[&BareWrite], span: (Pos, Pos)) -> bool {
    writes
        .iter()
        .any(|w| w.pos() >= span.0 && w.pos() <= span.1)
}

/// Statically provable test truth: literal folding only (boolean / None /
/// numeric / string / bytes + unary not; names are not folded - they may be
/// rebound; no user code is executed, the remaining conditions keep their
/// candidates).
fn constant_bool(expr: &ast::Expr) -> Option<bool> {
    match expr {
        ast::Expr::BooleanLiteral(b) => Some(b.value),
        ast::Expr::NoneLiteral(_) => Some(false),
        ast::Expr::NumberLiteral(n) => match &n.value {
            ast::Number::Int(i) => i.as_i64().map(|v| v != 0),
            ast::Number::Float(f) => Some(*f != 0.0),
            ast::Number::Complex { real, .. } => Some(*real != 0.0),
        },
        ast::Expr::StringLiteral(s) => Some(!s.value.is_empty()),
        ast::Expr::BytesLiteral(b) => Some(!b.value.is_empty()),
        ast::Expr::UnaryOp(u) if u.op == ast::UnaryOp::Not => constant_bool(&u.operand).map(|b| !b),
        _ => None,
    }
}

fn build_flow_tree(ast: &ParsedAst, body: &[ast::Stmt]) -> Vec<FlowStmt> {
    let mut out = Vec::new();
    for stmt in body {
        let start = stmt_pos(ast, stmt.range());
        let end = stmt_end_pos(ast, stmt.range());
        match stmt {
            ast::Stmt::If(s) => {
                out.push(build_if_chain(ast, &s.test, &s.body, &s.elif_else_clauses));
            }
            ast::Stmt::While(s) => {
                let b = build_flow_tree(ast, &s.body);
                let bs = tree_span(&b);
                out.push(FlowStmt::Loop {
                    start,
                    end,
                    body: b,
                    body_span: bs,
                    orelse: build_flow_tree(ast, &s.orelse),
                });
            }
            ast::Stmt::For(s) => {
                // async for is the same shape (is_async flag; the flow shape is identical)
                let b = build_flow_tree(ast, &s.body);
                let bs = tree_span(&b);
                out.push(FlowStmt::Loop {
                    start,
                    end,
                    body: b,
                    body_span: bs,
                    orelse: build_flow_tree(ast, &s.orelse),
                });
            }
            ast::Stmt::Try(s) => {
                let mut blocks: Vec<(Vec<FlowStmt>, (Pos, Pos))> = Vec::new();
                let b = build_flow_tree(ast, &s.body);
                if !b.is_empty() {
                    let bs = tree_span(&b);
                    blocks.push((b, bs));
                }
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    let hb = build_flow_tree(ast, &inner.body);
                    if !hb.is_empty() {
                        let hs = tree_span(&hb);
                        blocks.push((hb, hs));
                    }
                }
                let oe = build_flow_tree(ast, &s.orelse);
                if !oe.is_empty() {
                    let os = tree_span(&oe);
                    blocks.push((oe, os));
                }
                let fb = build_flow_tree(ast, &s.finalbody);
                if !fb.is_empty() {
                    let fs = tree_span(&fb);
                    blocks.push((fb, fs));
                }
                out.push(FlowStmt::Join { start, end, blocks });
            }
            ast::Stmt::Match(s) => {
                let mut blocks: Vec<(Vec<FlowStmt>, (Pos, Pos))> = Vec::new();
                for case in &s.cases {
                    let cb = build_flow_tree(ast, &case.body);
                    if !cb.is_empty() {
                        let cs = tree_span(&cb);
                        blocks.push((cb, cs));
                    }
                }
                out.push(FlowStmt::Join { start, end, blocks });
            }
            ast::Stmt::With(s) => {
                // with body executes straight: one head step + a flattened body
                out.push(FlowStmt::Simple { start, end: start });
                out.extend(build_flow_tree(ast, &s.body));
            }
            ast::Stmt::Return(_)
            | ast::Stmt::Raise(_)
            | ast::Stmt::Break(_)
            | ast::Stmt::Continue(_) => {
                // a terminator statement spans the whole statement as its domain (the
                // expression position of a dangling return x is still inside the statement,
                // so we do not misjudge "unreachable after termination"; only positions
                // after the statement end are unreachable)
                out.push(FlowStmt::Terminator { pos: start, end });
            }
            _ => out.push(FlowStmt::Simple { start, end }),
        }
    }
    out
}

/// if/elif/else chain construction (ruff flattens elif_else_clauses; rebuilt
/// into nested Branch: with test = elif recursion, without test = else body).
fn build_if_chain(
    ast: &ParsedAst,
    test: &ast::Expr,
    body: &[ast::Stmt],
    clauses: &[ast::ElifElseClause],
) -> FlowStmt {
    let start = stmt_pos(ast, test.range());
    let then_body = build_flow_tree(ast, body);
    let then_span = tree_span(&then_body);
    let (else_body, else_span, end) = match clauses.split_first() {
        None => {
            let end = stmt_end_pos(ast, body.last().map(|s| s.range()).unwrap_or(test.range()));
            (None, None, end)
        }
        Some((first, rest)) => match &first.test {
            Some(t) => {
                let nested = build_if_chain(ast, t, &first.body, rest);
                let ns = nested.span();
                (Some(vec![nested]), Some(ns), ns.1)
            }
            None => {
                let eb = build_flow_tree(ast, &first.body);
                let es = tree_span(&eb);
                let end = stmt_end_pos(
                    ast,
                    first.body.last().map(|s| s.range()).unwrap_or(first.range),
                );
                (Some(eb), Some(es), end)
            }
        },
    };
    FlowStmt::Branch {
        start,
        end,
        test_const: constant_bool(test),
        then_body,
        then_span,
        else_body,
        else_span,
    }
}

/// Evaluate a statement block within the domain: returns (the value at the
/// query landing point [Some when query is inside the block], the block exit).
/// cur = the value of that name at block entry; query = the hover position
/// (usize::MAX line = execute the whole block and take the exit).
fn eval_block(
    stmts: &[FlowStmt],
    writes: &[&BareWrite],
    mut cur: FlowVal,
    query: Pos,
) -> (Option<FlowVal>, BlockExit) {
    for stmt in stmts {
        let (start, end) = stmt.span();
        if start > query {
            break; // the following statements do not execute (execution order = Pos lexicographic strictly increasing)
        }
        if query > end {
            match stmt {
                FlowStmt::Simple { .. } => {
                    // the whole statement has finished executing: every write site inside it
                    // takes effect (in execution order the later write wins; no RHS boundary
                    // concern - query has already passed the whole statement)
                    if let Some(w) = writes
                        .iter()
                        .rev()
                        .find(|w| w.pos() >= start && w.pos() <= end)
                    {
                        cur = FlowVal::One(w.pos());
                    }
                }
                FlowStmt::Terminator { .. } => {
                    return (
                        None,
                        BlockExit {
                            val: cur,
                            terminated: true,
                        },
                    );
                }
                FlowStmt::Branch {
                    test_const,
                    then_body,
                    else_body,
                    ..
                } => {
                    // merge: union of each branch exit; a terminated branch not reaching
                    // past the statement = dropped (CFGFLOW-04); a statically dead branch
                    // produces no exit (CFGFLOW-02); no else = the entry value path
                    // (CFGFLOW-03)
                    let mut live: Vec<FlowVal> = Vec::new();
                    let mut any_live = false;
                    if *test_const != Some(false) {
                        let (_, e) = eval_block(then_body, writes, cur.clone(), END_OF_FILE);
                        if !e.terminated {
                            live.push(e.val);
                            any_live = true;
                        }
                    }
                    match else_body {
                        Some(eb) if *test_const != Some(true) => {
                            let (_, e) = eval_block(eb, writes, cur.clone(), END_OF_FILE);
                            if !e.terminated {
                                live.push(e.val);
                                any_live = true;
                            }
                        }
                        None if *test_const != Some(true) => {
                            live.push(cur.clone());
                            any_live = true;
                        }
                        _ => {}
                    }
                    if !any_live {
                        return (
                            None,
                            BlockExit {
                                val: cur,
                                terminated: true,
                            },
                        );
                    }
                    cur = fold_vals(live);
                }
                FlowStmt::Loop { body, orelse, .. } => {
                    // conservative: 0 iterations (entry value) + >=1 iterations (body exit;
                    // break/continue path values folded in as well - over-approximation =
                    // honestly unknown direction)
                    let (_, be) = eval_block(body, writes, cur.clone(), END_OF_FILE);
                    let mut live = vec![cur.clone(), be.val];
                    if !orelse.is_empty() {
                        let (_, oe) = eval_block(orelse, writes, cur.clone(), END_OF_FILE);
                        live.push(oe.val);
                    }
                    cur = fold_vals(live);
                }
                FlowStmt::Join { blocks, .. } => {
                    let mut live = vec![cur.clone()];
                    for (blk, _) in blocks {
                        let (_, e) = eval_block(blk, writes, cur.clone(), END_OF_FILE);
                        live.push(e.val);
                    }
                    cur = fold_vals(live);
                }
            }
            continue;
        }
        // query falls inside this statement position domain
        match stmt {
            FlowStmt::Simple { .. } => {
                if let Some(w) = writes.iter().find(|w| {
                    w.pos() >= start
                        && w.pos() <= end
                        && w.pos() <= query
                        // KBUG-ORDER time boundary: cursor still inside this write site
                        // statement domain -> hovering the target (before the RHS start
                        // position) = the new value, hovering inside the RHS = the old value;
                        // having passed this statement (a later statement on the same line /
                        // reached via a def head span) = in effect
                        && (query > w.stmt_end || query < w.rhs_pos)
                }) {
                    cur = FlowVal::One(w.pos());
                }
                let exit = BlockExit {
                    val: cur.clone(),
                    terminated: false,
                };
                return (Some(cur), exit);
            }
            FlowStmt::Terminator { .. } => {
                let exit = BlockExit {
                    val: cur.clone(),
                    terminated: true,
                };
                return (Some(cur), exit);
            }
            FlowStmt::Branch {
                test_const,
                then_body,
                then_span,
                else_body,
                else_span,
                ..
            } => {
                if query >= then_span.0 && query <= then_span.1 {
                    if *test_const == Some(false) {
                        // query inside a statically dead branch = unreachable, honestly unbound
                        return (
                            Some(FlowVal::Unbound),
                            BlockExit {
                                val: cur,
                                terminated: true,
                            },
                        );
                    }
                    return eval_block(then_body, writes, cur, query);
                }
                if let (Some(eb), Some(es)) = (else_body, else_span) {
                    if query >= es.0 && query <= es.1 {
                        if *test_const == Some(true) {
                            return (
                                Some(FlowVal::Unbound),
                                BlockExit {
                                    val: cur,
                                    terminated: true,
                                },
                            );
                        }
                        return eval_block(eb, writes, cur, query);
                    }
                }
                // head line / line gap: the statement start value
                let exit = BlockExit {
                    val: cur.clone(),
                    terminated: false,
                };
                return (Some(cur), exit);
            }
            FlowStmt::Loop {
                body, body_span, ..
            } => {
                if query >= body_span.0 && query <= body_span.1 {
                    let (qv, _) = eval_block(body, writes, cur.clone(), query);
                    let qv = qv.unwrap_or_else(|| cur.clone());
                    if span_has_write(writes, *body_span) {
                        // loop-back conservative: any write site of that name in the body is
                        // reachable in >=2 iterations
                        let mut vals = vec![qv];
                        vals.extend(
                            writes
                                .iter()
                                .filter(|w| w.pos() >= body_span.0 && w.pos() <= body_span.1)
                                .map(|w| FlowVal::One(w.pos())),
                        );
                        return (
                            Some(fold_vals(vals)),
                            BlockExit {
                                val: cur,
                                terminated: false,
                            },
                        );
                    }
                    let exit = BlockExit {
                        val: cur.clone(),
                        terminated: false,
                    };
                    return (Some(qv), exit);
                }
                let exit = BlockExit {
                    val: cur.clone(),
                    terminated: false,
                };
                return (Some(cur), exit);
            }
            FlowStmt::Join { blocks, .. } => {
                for (blk, span) in blocks {
                    if query >= span.0 && query <= span.1 {
                        let (qv, _) = eval_block(blk, writes, cur.clone(), query);
                        let qv = qv.unwrap_or_else(|| cur.clone());
                        // exception / match path conservative: kept alongside the entry value
                        let exit = BlockExit {
                            val: cur.clone(),
                            terminated: false,
                        };
                        return (Some(fold_vals(vec![qv, cur])), exit);
                    }
                }
                let exit = BlockExit {
                    val: cur.clone(),
                    terminated: false,
                };
                return (Some(cur), exit);
            }
        }
    }
    (
        None,
        BlockExit {
            val: cur,
            terminated: false,
        },
    )
}

/// The "whole block executed to exit" sentinel position (usize::MAX line; every
/// real write position/span sorts before it, eval_block only compares sizes and
/// never touches the real end of the file).
static END_OF_FILE: Pos = Pos {
    line: usize::MAX,
    col: 0,
};

/// Flow tree query within the domain: the flow-sensitive reachable write site
/// value of that name at the hover position (query after termination =
/// unreachable, honestly unbound; a gap between positions = the previous
/// statement exit value).
pub(crate) fn flow_query_value(tree: &[FlowStmt], writes: &[&BareWrite], query: Pos) -> FlowVal {
    let (qv, exit) = eval_block(tree, writes, FlowVal::Unbound, query);
    match qv {
        Some(v) => v,
        None if exit.terminated => FlowVal::Unbound,
        None => exit.val,
    }
}

#[derive(Debug, Clone)]
struct DeferredEntry {
    kind: EntryKind,
    line: usize,
    name: String,
    /// Annotation atom (AnnAssign; `X: T` without a value also counts)
    ann: Option<String>,
    value: RhsShape,
    class_start: Option<usize>,
    method_start: Option<usize>,
}

#[derive(Debug, Default)]
struct BuildContext {
    entries: Vec<DeferredEntry>,
    /// Local bare name write sites within a method domain: (method start line,
    /// name) -> [(line, RHS shape)] (appended in source order)
    locals: HashMap<(usize, String), Vec<(usize, RhsShape)>>,
    /// Batch D localReturnType surface: the global bare name write site table
    /// (name -> write sites in source order, one table for all three domains)
    bare_writes: HashMap<String, Vec<BareWrite>>,
    /// KBUG-SCOPE: function / lambda lexical domain table (appended in source
    /// order, sorted by body first line at the end of build)
    fn_domains: Vec<FnDomain>,
    /// KBUG-SCOPE: class body `global` declarations (class name line -> names;
    /// class body direct write sites are recorded in the module domain instead)
    scope_globals: HashMap<usize, Vec<String>>,
    /// KBUG-CFGFLOW: function domain statement flow tree (header_line -> tree)
    fn_trees: HashMap<usize, Vec<FlowStmt>>,
    /// KBUG-CFGFLOW: class body statement flow tree (class name line -> tree)
    class_trees: HashMap<usize, Vec<FlowStmt>>,
    /// Module-level def `-> T` table
    def_returns: HashMap<String, DefReturn>,
    /// Class name -> class name line (several with the same name = ambiguity source)
    class_names: HashMap<String, Vec<usize>>,
    /// Class name line -> method name -> collected return annotations (>1 method
    /// with the same name = ambiguous)
    class_methods: HashMap<usize, HashMap<String, Vec<Option<String>>>>,
}

/// RHS shape extraction: literal typing first (batch B), everything else kept
/// as an owned snapshot by call / attribute / bare name shape; the await shell
/// is transparent (parens are already stripped by ruff).
fn rhs_shape(expr: &ast::Expr) -> RhsShape {
    let typed = ast_type_of_expr(expr);
    if !typed.is_empty() {
        return RhsShape::Typed(typed);
    }
    match expr {
        ast::Expr::Call(c) => {
            RhsShape::Call(match &*c.func {
                ast::Expr::Name(n) => CalleeShape::Name(n.id.to_string()),
                ast::Expr::Attribute(a) => {
                    // judge the self receiver first (self is a Name, check the receiver
                    // before classifying the qualification)
                    let recv = &*a.value;
                    if is_self_receiver(recv) {
                        CalleeShape::SelfMethod(a.attr.to_string())
                    } else if let ast::Expr::Name(cn) = recv {
                        CalleeShape::Qualified {
                            class: cn.id.to_string(),
                            method: a.attr.to_string(),
                        }
                    } else {
                        CalleeShape::Chained {
                            receiver: Box::new(rhs_shape(recv)),
                            method: a.attr.to_string(),
                        }
                    }
                }
                _ => return RhsShape::Unknown,
            })
        }
        ast::Expr::Attribute(a) if is_self_receiver(&a.value) => {
            RhsShape::SelfAttr(a.attr.to_string())
        }
        ast::Expr::Name(n) => RhsShape::Local(n.id.to_string()),
        ast::Expr::Await(aw) => rhs_shape(&aw.value),
        ast::Expr::Named(n) => rhs_shape(&n.value),
        _ => RhsShape::Unknown,
    }
}

/// Walrus targets inside the RHS are registered as local write sites (top level
/// Named + tuple/list elements + await inner layer; deeper nesting is honestly
/// missed and does not enter the chain).
fn record_walrus_locals(
    expr: &ast::Expr,
    line: usize,
    method_start: Option<usize>,
    ctx: &mut BuildContext,
) {
    let Some(ms) = method_start else {
        return;
    };
    match expr {
        ast::Expr::Named(n) => {
            if let ast::Expr::Name(t) = &*n.target {
                ctx.locals
                    .entry((ms, t.id.to_string()))
                    .or_default()
                    .push((line, rhs_shape(&n.value)));
            }
        }
        ast::Expr::Await(aw) => record_walrus_locals(&aw.value, line, method_start, ctx),
        ast::Expr::Tuple(t) => {
            for e in &t.elts {
                record_walrus_locals(e, line, method_start, ctx);
            }
        }
        ast::Expr::List(l) => {
            for e in &l.elts {
                record_walrus_locals(e, line, method_start, ctx);
            }
        }
        _ => {}
    }
}

/// KBUG-SCOPE: lexical domain registration for a directly assigned lambda
/// (header = the assignment line = the write site attribution key; body domain
/// = the lambda expression line domain; no global/nonlocal surface).
fn record_lambda_domain(ast: &ParsedAst, l: &ast::ExprLambda, line: usize, ctx: &mut BuildContext) {
    let start_line = ast.line_col(l.range.start().to_u32()).0;
    let end_line = last_char_line(ast, l.range);
    ctx.fn_domains.push(FnDomain {
        header_line: line,
        start_line,
        end_line: end_line.max(line),
        params: l
            .parameters
            .as_ref()
            .map(|p| param_names(p))
            .unwrap_or_default(),
        def_names: Vec::new(),
        globals: Vec::new(),
        nonlocals: Vec::new(),
    });
}

/// The full parameter name list (positional / positional-only / keyword-only /
/// vararg / kwarg; annotations and defaults are irrelevant - a parameter
/// position always binds in this domain).
fn param_names(parameters: &ast::Parameters) -> Vec<String> {
    parameters.iter().map(|p| p.name().id.to_string()).collect()
}

/// `global`/`nonlocal` declaration names in a function / class body (a
/// declaration inside a control block still belongs to the direct host domain;
/// no descent into nested def/class - a declaration belongs only to its direct
/// host).
fn declared_names(body: &[ast::Stmt], global: bool, nonlocal: bool) -> Vec<String> {
    let mut out = Vec::new();
    collect_declared(body, global, nonlocal, &mut out);
    out
}

/// def names direct in this domain (the BIND-02 local def binding material;
/// defs inside control blocks have the same membership, no descent into a
/// nested def body - that belongs to the inner domain).
fn declared_def_names(body: &[ast::Stmt]) -> Vec<String> {
    let mut out = Vec::new();
    collect_declared_def_names(body, &mut out);
    out
}

fn collect_declared_def_names(body: &[ast::Stmt], out: &mut Vec<String>) {
    for stmt in body {
        match stmt {
            ast::Stmt::FunctionDef(fun) => out.push(fun.name.id.to_string()),
            ast::Stmt::If(s) => {
                collect_declared_def_names(&s.body, out);
                for clause in &s.elif_else_clauses {
                    collect_declared_def_names(&clause.body, out);
                }
            }
            ast::Stmt::For(s) => {
                collect_declared_def_names(&s.body, out);
                collect_declared_def_names(&s.orelse, out);
            }
            ast::Stmt::While(s) => {
                collect_declared_def_names(&s.body, out);
                collect_declared_def_names(&s.orelse, out);
            }
            ast::Stmt::With(s) => collect_declared_def_names(&s.body, out),
            ast::Stmt::Try(s) => {
                collect_declared_def_names(&s.body, out);
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    collect_declared_def_names(&inner.body, out);
                }
                collect_declared_def_names(&s.orelse, out);
                collect_declared_def_names(&s.finalbody, out);
            }
            ast::Stmt::Match(s) => {
                for case in &s.cases {
                    collect_declared_def_names(&case.body, out);
                }
            }
            _ => {}
        }
    }
}

fn collect_declared(body: &[ast::Stmt], global: bool, nonlocal: bool, out: &mut Vec<String>) {
    for stmt in body {
        match stmt {
            ast::Stmt::Global(s) if global => out.extend(s.names.iter().map(|n| n.id.to_string())),
            ast::Stmt::Nonlocal(s) if nonlocal => {
                out.extend(s.names.iter().map(|n| n.id.to_string()))
            }
            ast::Stmt::If(s) => {
                collect_declared(&s.body, global, nonlocal, out);
                for clause in &s.elif_else_clauses {
                    collect_declared(&clause.body, global, nonlocal, out);
                }
            }
            ast::Stmt::For(s) => {
                collect_declared(&s.body, global, nonlocal, out);
                collect_declared(&s.orelse, global, nonlocal, out);
            }
            ast::Stmt::While(s) => {
                collect_declared(&s.body, global, nonlocal, out);
                collect_declared(&s.orelse, global, nonlocal, out);
            }
            ast::Stmt::With(s) => collect_declared(&s.body, global, nonlocal, out),
            ast::Stmt::Try(s) => {
                collect_declared(&s.body, global, nonlocal, out);
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    collect_declared(&inner.body, global, nonlocal, out);
                }
                collect_declared(&s.orelse, global, nonlocal, out);
                collect_declared(&s.finalbody, global, nonlocal, out);
            }
            ast::Stmt::Match(s) => {
                for case in &s.cases {
                    collect_declared(&case.body, global, nonlocal, out);
                }
            }
            _ => {}
        }
    }
}

/// Whole-module assignment walk: collect entry snapshots (the method-level
/// `self.<attr>` surface + the class body direct bare name surface, class
/// identity key = the class name line - decorators do not count, same
/// semantics as ClassSpan.start_line) plus the module-level def / class name /
/// class method tables / local write sites. The body of a same-line composite
/// statement head is not collected (`if c: self.x = 1` runs conditionally, and
/// the scan treats it as an ordinary line in line order - the same semantics
/// as the old engine's "the line does not start with self").
/// The collection products are full tables (consumed by the flow surface and
/// the localReturnType surface from the same source; from batch D on,
/// assignments_from_ast hands them back together and FlowParse carries them).
struct FlowTables {
    assignments: AssignmentTypes,
    class_direct: ClassAssignmentTypes,
    locals: HashMap<(usize, String), Vec<(usize, RhsShape)>>,
    def_returns: HashMap<String, DefReturn>,
    class_names: HashMap<String, Vec<usize>>,
    class_methods: HashMap<usize, HashMap<String, Vec<Option<String>>>>,
    bare_writes: HashMap<String, Vec<BareWrite>>,
    fn_domains: Vec<FnDomain>,
    scope_globals: HashMap<usize, Vec<String>>,
    fn_trees: HashMap<usize, Vec<FlowStmt>>,
    class_trees: HashMap<usize, Vec<FlowStmt>>,
    module_tree: Vec<FlowStmt>,
}

fn assignments_from_ast(
    ast: &ParsedAst,
    lines: &[Vec<u16>],
    classes: &[ClassSpan],
) -> Result<FlowTables, &'static str> {
    let mut ctx = BuildContext::default();
    // module-level def `-> T` table (module-level defs inside control blocks
    // have the same membership; defs inside a class / function body do not enter)
    let mut module_defs: HashMap<String, Vec<Option<String>>> = HashMap::new();
    collect_module_defs(ast, &ast.module().body, &mut module_defs);
    for (name, rets) in module_defs {
        let entry = if rets.len() == 1 {
            DefReturn::Single(rets.into_iter().next().unwrap())
        } else {
            DefReturn::Ambiguous
        };
        ctx.def_returns.insert(name, entry);
    }
    walk_assignments(ast, &ast.module().body, None, &mut ctx, None, None);

    // RAW (literal surface) index: both the baseline map and the cycle-safe
    // derivation rest on it (derivation never stacks on derivation, keeping the
    // baseline decoupled from the entries and free of parse order dependence)
    let mut raw = AssignmentTypes::default();
    let mut raw_direct = ClassAssignmentTypes::default();
    cancel::check_point()?;
    for e in &ctx.entries {
        let mut types = TypeSet::new();
        if let Some(a) = &e.ann {
            types.insert(a.clone());
        }
        if let RhsShape::Typed(t) = &e.value {
            types.extend(t.iter().cloned());
        }
        match e.kind {
            EntryKind::SelfAttr => raw.insert(e.line, &e.name, types),
            EntryKind::ClassDirect => {
                raw_direct.insert(e.class_start.unwrap(), e.line, &e.name, types)
            }
        }
    }

    // derivation phase: non-literal shapes are resolved by context (baseline
    // map memo / method table / local chain)
    let mut state = ResolveState {
        lines,
        classes,
        locals: &ctx.locals,
        def_returns: &ctx.def_returns,
        class_names: &ctx.class_names,
        class_methods: &ctx.class_methods,
        bare_writes: &ctx.bare_writes,
        fn_domains: &ctx.fn_domains,
        raw: &raw,
        raw_class_direct: &raw_direct,
        baseline_memo: HashMap::new(),
    };
    let mut final_map = AssignmentTypes::default();
    let mut final_direct = ClassAssignmentTypes::default();
    cancel::check_point()?;
    for e in &ctx.entries {
        let mut types = TypeSet::new();
        if let Some(a) = &e.ann {
            types.insert(a.clone());
        }
        types.extend(resolve_shape(
            &mut state,
            &e.value,
            e.line,
            e.class_start,
            e.method_start,
            0,
            &mut HashSet::new(),
        ));
        match e.kind {
            EntryKind::SelfAttr => final_map.insert(e.line, &e.name, types),
            EntryKind::ClassDirect => {
                final_direct.insert(e.class_start.unwrap(), e.line, &e.name, types)
            }
        }
    }
    // RUST-072: final check - cancellation landing in the last entry derivation still
    // yields no partial table.
    cancel::check_point()?;
    Ok(FlowTables {
        assignments: final_map,
        class_direct: final_direct,
        locals: ctx.locals,
        def_returns: ctx.def_returns,
        class_names: ctx.class_names,
        class_methods: ctx.class_methods,
        bare_writes: ctx.bare_writes,
        fn_domains: {
            // body first line order (nested domains nest by line domain;
            // chain construction takes the innermost by start_line descending)
            let mut domains = ctx.fn_domains;
            domains.sort_by_key(|d| (d.start_line, d.end_line));
            domains
        },
        scope_globals: ctx.scope_globals,
        fn_trees: ctx.fn_trees,
        class_trees: ctx.class_trees,
        module_tree: build_flow_tree(ast, &ast.module().body),
    })
}

/// Module-level def collection (defs inside control blocks have the same
/// membership; defs inside a class / function body do not enter the bare name
/// call table).
fn collect_module_defs(
    ast: &ParsedAst,
    body: &[ast::Stmt],
    out: &mut HashMap<String, Vec<Option<String>>>,
) {
    for stmt in body {
        match stmt {
            ast::Stmt::FunctionDef(fun) => {
                let ret = fun.returns.as_ref().and_then(|e| annotation_text(ast, e));
                out.entry(fun.name.id.to_string()).or_default().push(ret);
            }
            ast::Stmt::ClassDef(_) => {}
            ast::Stmt::If(s) => {
                collect_module_defs(ast, &s.body, out);
                for clause in &s.elif_else_clauses {
                    collect_module_defs(ast, &clause.body, out);
                }
            }
            ast::Stmt::For(s) => {
                collect_module_defs(ast, &s.body, out);
                collect_module_defs(ast, &s.orelse, out);
            }
            ast::Stmt::While(s) => {
                collect_module_defs(ast, &s.body, out);
                collect_module_defs(ast, &s.orelse, out);
            }
            ast::Stmt::With(s) => collect_module_defs(ast, &s.body, out),
            ast::Stmt::Try(s) => {
                collect_module_defs(ast, &s.body, out);
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    collect_module_defs(ast, &inner.body, out);
                }
                collect_module_defs(ast, &s.orelse, out);
                collect_module_defs(ast, &s.finalbody, out);
            }
            ast::Stmt::Match(s) => {
                for case in &s.cases {
                    collect_module_defs(ast, &case.body, out);
                }
            }
            _ => {}
        }
    }
}

/// Class body method table collection (defs inside control blocks have the
/// same membership = batch A membership semantics; nested classes / nested
/// functions do not enter).
fn collect_class_methods(
    ast: &ParsedAst,
    body: &[ast::Stmt],
    out: &mut HashMap<String, Vec<Option<String>>>,
) {
    for stmt in body {
        match stmt {
            ast::Stmt::FunctionDef(fun) => {
                let ret = fun.returns.as_ref().and_then(|e| annotation_text(ast, e));
                out.entry(fun.name.id.to_string()).or_default().push(ret);
            }
            ast::Stmt::ClassDef(_) => {}
            ast::Stmt::If(s) => {
                collect_class_methods(ast, &s.body, out);
                for clause in &s.elif_else_clauses {
                    collect_class_methods(ast, &clause.body, out);
                }
            }
            ast::Stmt::For(s) => {
                collect_class_methods(ast, &s.body, out);
                collect_class_methods(ast, &s.orelse, out);
            }
            ast::Stmt::While(s) => {
                collect_class_methods(ast, &s.body, out);
                collect_class_methods(ast, &s.orelse, out);
            }
            ast::Stmt::With(s) => collect_class_methods(ast, &s.body, out),
            ast::Stmt::Try(s) => {
                collect_class_methods(ast, &s.body, out);
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    collect_class_methods(ast, &inner.body, out);
                }
                collect_class_methods(ast, &s.orelse, out);
                collect_class_methods(ast, &s.finalbody, out);
            }
            ast::Stmt::Match(s) => {
                for case in &s.cases {
                    collect_class_methods(ast, &case.body, out);
                }
            }
            _ => {}
        }
    }
}

fn stmt_start_line(ast: &ParsedAst, range: ruff_text_size::TextRange) -> usize {
    ast.line_col(range.start().to_u32()).0
}

fn walk_assignments(
    ast: &ParsedAst,
    body: &[ast::Stmt],
    header_line: Option<usize>,
    ctx: &mut BuildContext,
    class_start: Option<usize>,
    method_start: Option<usize>,
) {
    for stmt in body {
        // RUST-072: once cancelled, short circuit silently (signature unchanged; the outer
        // cooperation point stops any partial table from being produced)
        if cancel::is_cancelled() {
            return;
        }
        let start_line = stmt_start_line(ast, stmt.range());
        if header_line == Some(start_line) {
            continue; // assignments in the body of a same line composite statement are not collected (conditional execution, not force-applied)
        }
        match stmt {
            ast::Stmt::Assign(a) => index_assign(ast, a, None, ctx, class_start, method_start),
            ast::Stmt::AnnAssign(a) => {
                index_ann_assign(ast, a, None, ctx, class_start, method_start)
            }
            ast::Stmt::ClassDef(cls) => {
                // class identity = the class name line (decorators do not count; same
                // semantics as ClassSpan.start_line, so the baseline lookup can hit)
                let cls_line = ast.line_col(cls.name.range.start().to_u32()).0;
                ctx.class_names
                    .entry(cls.name.id.to_string())
                    .or_default()
                    .push(cls_line);
                let mut methods = HashMap::new();
                collect_class_methods(ast, &cls.body, &mut methods);
                ctx.class_methods.insert(cls_line, methods);
                // KBUG-SCOPE: class body `global` declaration -> class body direct
                // write sites are recorded in the module name space instead (the read
                // side uses this to allow module bindings; nested defs are not descended
                // into, the declaration belongs to its direct host).
                let cls_globals = declared_names(&cls.body, true, false);
                if !cls_globals.is_empty() {
                    ctx.scope_globals.insert(cls_line, cls_globals);
                }
                // KBUG-CFGFLOW: class body direct statement flow tree (the flow sensitive
                // ruling of class body direct reads)
                ctx.class_trees
                    .insert(cls_line, build_flow_tree(ast, &cls.body));
                // class body direct bare name assignment / annotation ->
                // class_direct (the baseline surface); nested blocks and nested class
                // bodies do not enter (same domain as the old baseline "class body
                // indented direct lines").
                for direct in &cls.body {
                    let line = stmt_start_line(ast, direct.range());
                    if line == start_line {
                        continue; // `class A: x = 1` same line direct child: the baseline line domain excludes the class line
                    }
                    match direct {
                        ast::Stmt::Assign(a) => {
                            index_assign(ast, a, Some(cls_line), ctx, Some(cls_line), None);
                        }
                        ast::Stmt::AnnAssign(a) => {
                            index_ann_assign(ast, a, Some(cls_line), ctx, Some(cls_line), None);
                        }
                        _ => {}
                    }
                }
                // recurse into method bodies / control blocks / nested classes (direct
                // children were already collected above; this walk continues the
                // self.<attr> / nested class surfaces - class body direct bare names
                // are not double recorded)
                walk_assignments(ast, &cls.body, Some(start_line), ctx, Some(cls_line), None);
            }
            ast::Stmt::FunctionDef(fun) => {
                let fun_line = ast.line_col(fun.name.range.start().to_u32()).0;
                // KBUG-SCOPE: lexical domain registration (body domain + the full
                // parameter list + global/nonlocal declarations; a nested def forms its
                // own domain, nesting with the outer domain by line domain).
                let body_start = fun
                    .body
                    .first()
                    .map(|s| stmt_start_line(ast, s.range()))
                    .unwrap_or(fun_line);
                let body_end = fun
                    .body
                    .last()
                    .map(|s| last_char_line(ast, s.range()))
                    .unwrap_or(fun_line);
                ctx.fn_domains.push(FnDomain {
                    header_line: fun_line,
                    start_line: body_start.min(fun_line),
                    end_line: body_end.max(fun_line),
                    params: param_names(&fun.parameters),
                    def_names: declared_def_names(&fun.body),
                    globals: declared_names(&fun.body, true, false),
                    nonlocals: declared_names(&fun.body, false, true),
                });
                // KBUG-CFGFLOW: the direct statement flow tree of this domain (material for
                // the flow sensitive write site ruling)
                ctx.fn_trees
                    .insert(fun_line, build_flow_tree(ast, &fun.body));
                walk_assignments(
                    ast,
                    &fun.body,
                    Some(start_line),
                    ctx,
                    class_start,
                    Some(fun_line),
                );
            }
            ast::Stmt::If(s) => {
                walk_assignments(
                    ast,
                    &s.body,
                    Some(start_line),
                    ctx,
                    class_start,
                    method_start,
                );
                for clause in &s.elif_else_clauses {
                    let clause_line = stmt_start_line(ast, clause.range);
                    walk_assignments(
                        ast,
                        &clause.body,
                        Some(clause_line),
                        ctx,
                        class_start,
                        method_start,
                    );
                }
            }
            ast::Stmt::For(s) => {
                walk_assignments(
                    ast,
                    &s.body,
                    Some(start_line),
                    ctx,
                    class_start,
                    method_start,
                );
                walk_assignments(ast, &s.orelse, None, ctx, class_start, method_start);
            }
            ast::Stmt::While(s) => {
                walk_assignments(
                    ast,
                    &s.body,
                    Some(start_line),
                    ctx,
                    class_start,
                    method_start,
                );
                walk_assignments(ast, &s.orelse, None, ctx, class_start, method_start);
            }
            ast::Stmt::With(s) => {
                walk_assignments(
                    ast,
                    &s.body,
                    Some(start_line),
                    ctx,
                    class_start,
                    method_start,
                );
            }
            ast::Stmt::Try(s) => {
                walk_assignments(
                    ast,
                    &s.body,
                    Some(start_line),
                    ctx,
                    class_start,
                    method_start,
                );
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    let handler_line = stmt_start_line(ast, inner.range);
                    walk_assignments(
                        ast,
                        &inner.body,
                        Some(handler_line),
                        ctx,
                        class_start,
                        method_start,
                    );
                }
                walk_assignments(ast, &s.orelse, None, ctx, class_start, method_start);
                walk_assignments(ast, &s.finalbody, None, ctx, class_start, method_start);
            }
            ast::Stmt::Match(s) => {
                for case in &s.cases {
                    let case_line = stmt_start_line(ast, case.range);
                    walk_assignments(
                        ast,
                        &case.body,
                        Some(case_line),
                        ctx,
                        class_start,
                        method_start,
                    );
                }
            }
            _ => {}
        }
    }
}

/// Assign collection: an Attribute target (self.<attr>) -> the method level
/// surface; bare name / tuple unpack targets (only in the class body direct
/// context) -> the class_direct surface. A single Tuple target paired position
/// by position with an equal length Tuple value (`self.x, self.y = 1, 2`; a
/// derivable truth); otherwise all targets share the RHS derivation
/// (underivable = replacement by the empty set).
fn index_assign(
    ast: &ParsedAst,
    a: &ast::StmtAssign,
    direct_class: Option<usize>,
    ctx: &mut BuildContext,
    class_start: Option<usize>,
    method_start: Option<usize>,
) {
    let line = stmt_start_line(ast, a.range);
    record_walrus_locals(&a.value, line, method_start, ctx);
    // KBUG-SCOPE: a directly assigned lambda forms its own domain (parameter
    // shadowing decision; nested lambdas inside a call / comprehension do not
    // enter the table - their body has no bare name write site, an out of range
    // read is honestly treated as unbound).
    if let ast::Expr::Lambda(l) = &*a.value {
        record_lambda_domain(ast, l, line, ctx);
    }
    // tuple unpack pairing: a single Tuple target x an equal length Tuple
    // value, no starred elements (KBUG-ORDER: record positions element by
    // element - target position / RHS element position, the "read the old value
    // when swapped" boundary is ruled per element)
    if let ast::Expr::Tuple(value_tuple) = &*a.value {
        if a.targets.len() == 1 {
            if let ast::Expr::Tuple(target_tuple) = &a.targets[0] {
                if target_tuple.elts.len() == value_tuple.elts.len()
                    && target_tuple
                        .elts
                        .iter()
                        .chain(value_tuple.elts.iter())
                        .all(|e| !matches!(e, ast::Expr::Starred(_)))
                {
                    let stmt_end = stmt_end_pos(ast, a.range);
                    // simultaneous assignment: all targets bind together when the whole
                    // statement completes - the RHS boundary uniformly takes the start
                    // position of the whole value tuple (hovering inside the RHS domain
                    // always reads the old value, no per element release)
                    let tuple_rhs = stmt_pos(ast, value_tuple.range());
                    for (target, value) in target_tuple.elts.iter().zip(value_tuple.elts.iter()) {
                        push_entry(
                            line,
                            stmt_pos(ast, target.range()),
                            stmt_end,
                            tuple_rhs,
                            target,
                            None,
                            rhs_shape(value),
                            direct_class,
                            class_start,
                            method_start,
                            ctx,
                        );
                    }
                    return;
                }
            }
        }
    }
    let shape = rhs_shape(&a.value);
    let rhs_pos = stmt_pos(ast, a.value.range());
    let stmt_end = stmt_end_pos(ast, a.range);
    for target in &a.targets {
        // chained assignment `x = y = v`: each target records its own position, the
        // same RHS start position
        push_entry(
            line,
            stmt_pos(ast, target.range()),
            stmt_end,
            rhs_pos,
            target,
            None,
            shape.clone(),
            direct_class,
            class_start,
            method_start,
            ctx,
        );
    }
}

/// AnnAssign collection: the annotation text atom plus (when valued) the RHS
/// derivation; a value-less annotation = declaration knowledge (same semantics
/// as the old class level `X: T`).
fn index_ann_assign(
    ast: &ParsedAst,
    a: &ast::StmtAnnAssign,
    direct_class: Option<usize>,
    ctx: &mut BuildContext,
    class_start: Option<usize>,
    method_start: Option<usize>,
) {
    let line = stmt_start_line(ast, a.range);
    let ann = annotation_text(ast, &a.annotation);
    let value_shape = match &a.value {
        Some(v) => {
            record_walrus_locals(v, line, method_start, ctx);
            // KBUG-SCOPE: an annotated assignment lambda enters the domain table with
            // the same membership
            if let ast::Expr::Lambda(l) = v.as_ref() {
                record_lambda_domain(ast, l, line, ctx);
            }
            rhs_shape(v)
        }
        None => RhsShape::Typed(TypeSet::new()),
    };
    let rhs_pos = match &a.value {
        Some(v) => stmt_pos(ast, v.range()),
        // a value-less annotation = declaration knowledge, no RHS read boundary
        // (effective before the annotation tail)
        None => stmt_end_pos(ast, a.annotation.range()),
    };
    push_entry(
        line,
        stmt_pos(ast, a.target.range()),
        stmt_end_pos(ast, a.range),
        rhs_pos,
        &a.target,
        ann,
        value_shape,
        direct_class,
        class_start,
        method_start,
        ctx,
    );
}

/// Entry recording: `self.<attr>` -> the method level surface (class context =
/// the enclosing class, method context = the enclosing method); a bare name
/// (only in the class body direct context) -> class_direct. Other targets
/// (subscript / starred / slice etc.) are not collected.
/// `pos` / `stmt_end` / `rhs_pos` = the KBUG-ORDER write site position /
/// statement tail position / RHS start position (the three pieces of the bare
/// name surface time boundary).
#[allow(clippy::too_many_arguments)]
fn push_entry(
    line: usize,
    pos: Pos,
    stmt_end: Pos,
    rhs_pos: Pos,
    target: &ast::Expr,
    ann: Option<String>,
    value: RhsShape,
    direct_class: Option<usize>,
    class_start: Option<usize>,
    method_start: Option<usize>,
    ctx: &mut BuildContext,
) {
    match target {
        ast::Expr::Attribute(attr) => {
            if is_self_receiver(&attr.value) {
                ctx.entries.push(DeferredEntry {
                    kind: EntryKind::SelfAttr,
                    line,
                    name: attr.attr.to_string(),
                    ann,
                    value,
                    class_start,
                    method_start,
                });
            }
        }
        ast::Expr::Name(name) => {
            // Batch D localReturnType surface: register the bare name write site
            // globally (module / class body / method body share one table; the
            // surface query filters by its domain gate, leaving the existing chain
            // surface semantics untouched)
            ctx.bare_writes
                .entry(name.id.to_string())
                .or_default()
                .push(BareWrite {
                    line,
                    col: pos.col,
                    stmt_end,
                    rhs_pos,
                    shape: value.clone(),
                    class_start,
                    method_start,
                });
            // bare name write site inside a method domain -> the local chain
            // surface (material for nearest write site resolution); class body
            // direct (method_start=None) does not enter the local chain (a class
            // level chain is not modelled, honestly empty)
            if let Some(ms) = method_start {
                ctx.locals
                    .entry((ms, name.id.to_string()))
                    .or_default()
                    .push((line, value.clone()));
            }
            if let Some(dc) = direct_class {
                ctx.entries.push(DeferredEntry {
                    kind: EntryKind::ClassDirect,
                    line,
                    name: name.id.to_string(),
                    ann,
                    value,
                    class_start: Some(dc),
                    method_start: None,
                });
            }
        }
        _ => {}
    }
}

/// Derivation state: RAW index (literal surface) + class spans + the collected
/// surface tables; a baseline map memo prevents recomputing per entry. The
/// tables are carried by reference (consumed isomorphically by both FlowParse
/// and the collection phase BuildContext).
pub(crate) struct ResolveState<'a> {
    pub(crate) lines: &'a [Vec<u16>],
    pub(crate) classes: &'a [ClassSpan],
    pub(crate) locals: &'a HashMap<(usize, String), Vec<(usize, RhsShape)>>,
    pub(crate) def_returns: &'a HashMap<String, DefReturn>,
    pub(crate) class_names: &'a HashMap<String, Vec<usize>>,
    pub(crate) class_methods: &'a HashMap<usize, HashMap<String, Vec<Option<String>>>>,
    pub(crate) bare_writes: &'a HashMap<String, Vec<BareWrite>>,
    pub(crate) fn_domains: &'a [FnDomain],
    pub(crate) raw: &'a AssignmentTypes,
    pub(crate) raw_class_direct: &'a ClassAssignmentTypes,
    pub(crate) baseline_memo: HashMap<(usize, String), TypeSet>,
}

/// Name binding fact: whether that name is bound before / at the flow
/// position, and its value atom.
/// None = a domain parameter / local def / global (nonlocal passthrough) /
/// rebinding ambiguity -> the declaration table is unavailable;
/// Some = not bound (usable) or bound to a known value (an alias).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CalleeBinding {
    /// not bound (a preceding def / class name is still usable)
    Unbound,
    /// bound; the value atom (Some for a single atom, otherwise / unsolvable = None)
    Bound(Option<String>),
}

impl ResolveState<'_> {
    /// FlowParse -> derivation state (the localReturnType surface and the flow surface share the source).
    pub(crate) fn from_flow_parse<'a>(
        fp: &'a FlowParse,
        lines: &'a [Vec<u16>],
    ) -> ResolveState<'a> {
        ResolveState {
            lines,
            classes: &fp.classes,
            locals: &fp.locals,
            def_returns: &fp.def_returns,
            class_names: &fp.class_names,
            class_methods: &fp.class_methods,
            bare_writes: &fp.bare_writes,
            fn_domains: &fp.fn_domains,
            raw: &fp.assignments,
            raw_class_direct: &fp.class_direct,
            baseline_memo: HashMap::new(),
        }
    }

    fn class_span(&self, class_start: usize) -> Option<&ClassSpan> {
        self.classes.iter().find(|c| c.start_line == class_start)
    }

    /// Class attribute baseline (converged over the RAW index; memoized).
    fn baseline(&mut self, class_start: usize, attr: &str) -> TypeSet {
        let key = (class_start, attr.to_string());
        if let Some(t) = self.baseline_memo.get(&key) {
            return t.clone();
        }
        let out = match self.class_span(class_start) {
            Some(cls) => converged_baseline(
                self.raw_class_direct,
                self.raw,
                self.lines,
                cls,
                &attr.encode_utf16().collect::<Vec<u16>>(),
            )
            // RUST-072: cancellation yields an empty set placeholder - the outer
            // derivation loop head check_point errors immediately, the memo dies
            // with this local ResolveState, and no partial value leaks out.
            .unwrap_or_default(),
            None => TypeSet::new(),
        };
        self.baseline_memo.insert(key, out.clone());
        out
    }

    /// Method annotation atom (several methods with the same name = ambiguous,
    /// do not guess).
    pub(crate) fn method_atom(&self, class_start: usize, method: &str) -> Option<String> {
        let rets = self.class_methods.get(&class_start)?.get(method)?;
        if rets.len() != 1 {
            return None;
        }
        rets[0].clone()
    }

    /// Unique class of that name (duplicate class names = ambiguous, do not
    /// guess).
    pub(crate) fn unique_class(&self, name: &str) -> Option<usize> {
        match self.class_names.get(name) {
            Some(v) if v.len() == 1 => Some(v[0]),
            _ => None,
        }
    }

    /// Batch D: bare name callee atom - either the def annotation or the unique
    /// class name; both present = ambiguous, do not guess (class instantiation
    /// yields a class name atom; `x = Repo()` is flow evidence as it stands).
    pub(crate) fn callee_atom(&self, name: &str) -> Option<String> {
        let def = self.def_returns.get(name);
        let cls = self.class_names.get(name);
        match (def, cls) {
            (Some(DefReturn::Single(r)), None) => r.clone(),
            (None, Some(v)) if v.len() == 1 => Some(name.to_string()),
            _ => None,
        }
    }

    /// KBUG-BIND: pre-binding of a bare name declaration - rule whether that name
    /// is bound by the **lexical scope chain** of the flow position (the same chain
    /// as the SCOPE value lookup; the `callee_atom` declaration table is usable
    /// only when `Unbound`). Class body direct / module domain: a bare name goes
    /// through the declaration table as usual (a module binding of a class name
    /// A=B only shadows the bare name A, a class qualified A.load() still goes to
    /// the original class - legitimate in a real import scenario).
    /// global/nonlocal declaration domains pass through (the name belongs to the
    /// module / outer name space, the declaration table is usable).
    pub(crate) fn callee_binding(&self, name: &str, flow_line: usize) -> CalleeBinding {
        use CalleeBinding::*;
        // binding inside the domain: function domains on the chain that contain
        // flow_line (body first line descending, innermost first)
        let mut chain: Vec<&FnDomain> = self
            .fn_domains
            .iter()
            .filter(|d| d.start_line <= flow_line && flow_line <= d.end_line)
            .collect();
        chain.sort_by(|a, b| {
            b.start_line
                .cmp(&a.start_line)
                .then(a.end_line.cmp(&b.end_line))
        });
        for domain in &chain {
            if domain.globals.iter().any(|n| n == name)
                || domain.nonlocals.iter().any(|n| n == name)
            {
                continue; // global/nonlocal: the name belongs to the module / outer name space, the declaration table is usable
            }
            if domain.params.iter().any(|n| n == name) || domain.def_names.iter().any(|n| n == name)
            {
                return Bound(None); // parameter / local def call target undetermined -> the declaration table is unavailable
            }
            // write site binding inside the domain (the read precedes the write =
            // the call position comes first, the declaration table is usable)
            let writes = self.bare_writes.get(name).map(Vec::as_slice).unwrap_or(&[]);
            if writes
                .iter()
                .any(|w| w.method_start == Some(domain.header_line))
            {
                // bound value = the nearest preceding write site in the domain
                // (alias chain: a Local shape collects the value; a call / attribute
                // shape is not guessed from the declaration table, collect None)
                return match writes
                    .iter()
                    .rev()
                    .find(|w| w.method_start == Some(domain.header_line) && w.line < flow_line)
                {
                    Some(w) => match &w.shape {
                        RhsShape::Local(alias) => match self.local_atom(alias, w.line) {
                            Some(a) => Bound(Some(a)),
                            None => Bound(None),
                        },
                        _ => Bound(None),
                    },
                    None => Unbound, // bound in the domain but the call position comes first -> the declaration table as usual
                };
            }
        }
        // class body direct position (inside no function domain): binding in this
        // class body (direct write sites / direct defs)
        let class_direct = self
            .classes
            .iter()
            .filter(|c| c.start_line <= flow_line && flow_line < c.end_line)
            .max_by_key(|c| c.start_line);
        if let Some(cls) = class_direct {
            let writes = self.bare_writes.get(name).map(Vec::as_slice).unwrap_or(&[]);
            let in_class =
                |w: &BareWrite| w.method_start.is_none() && w.class_start == Some(cls.start_line);
            let bound = writes.iter().any(in_class)
                || self.fn_domains.iter().any(|d| {
                    d.header_line == cls.start_line && d.def_names.iter().any(|n| n == name)
                });
            if bound {
                return match writes
                    .iter()
                    .rev()
                    .find(|w| in_class(w) && w.line < flow_line)
                {
                    Some(w) => match &w.shape {
                        RhsShape::Local(alias) => Bound(self.local_atom(alias, w.line)),
                        _ => Bound(None),
                    },
                    None => Unbound, // bound after the call position -> the declaration table as usual
                };
            }
            // not bound in the class body -> fall through to the module
        }
        // module domain (KBUG-BIND-03: a module level rebinding A=B / A=unknown
        // likewise shadows the declaration table; a binding after the call
        // position = a forward reference, the declaration table is as usual)
        let writes = self.bare_writes.get(name).map(Vec::as_slice).unwrap_or(&[]);
        let in_module = |w: &BareWrite| w.method_start.is_none() && w.class_start.is_none();
        if writes.iter().any(in_module) {
            return match writes
                .iter()
                .rev()
                .find(|w| in_module(w) && w.line < flow_line)
            {
                Some(w) => match &w.shape {
                    RhsShape::Local(alias) => Bound(self.local_atom(alias, w.line)),
                    _ => Bound(None),
                },
                None => Unbound, // bound after the call position -> the declaration table as usual
            };
        }
        Unbound
    }

    /// Bare name **identity atom** chain (one recursion): the unique class name /
    /// the function name itself when it has a def declaration (not its return
    /// annotation - the annotation surface is looked up by name again on the
    /// consumer side; a flow surface consumer applying callee_atom to a function
    /// name gets the return annotation atom, a class name is an instantiation
    /// atom).
    fn local_atom(&self, name: &str, flow_line: usize) -> Option<String> {
        // the nearest preceding write site at module level (an alias)
        if let Some(w) = self
            .bare_writes
            .get(name)
            .and_then(|ws| {
                ws.iter()
                    .rev()
                    .find(|w| w.line < flow_line && w.method_start.is_none())
            })
            .filter(|w| w.class_start.is_none())
        {
            if let RhsShape::Local(alias) = &w.shape {
                return self.local_atom(alias, w.line);
            }
            return None;
        }
        let is_unique_class = self
            .class_names
            .get(name)
            .map(|v| v.len() == 1)
            .unwrap_or(false);
        if is_unique_class {
            return Some(name.to_string());
        }
        if matches!(self.def_returns.get(name), Some(DefReturn::Single(_))) {
            return Some(name.to_string());
        }
        None
    }
}

/// RHS shape derivation (bounded; cycle guarded; out of domain / unknown ->
/// the empty set). flow_line = the current flow position (the nearest local
/// chain write site = the nearest one before that position).
pub(crate) fn resolve_shape(
    state: &mut ResolveState,
    shape: &RhsShape,
    flow_line: usize,
    class_start: Option<usize>,
    method_start: Option<usize>,
    depth: usize,
    visited: &mut HashSet<(usize, String)>,
) -> TypeSet {
    if depth > RESOLVE_MAX_HOPS {
        return TypeSet::new();
    }
    match shape {
        RhsShape::Typed(t) => t.clone(),
        RhsShape::SelfAttr(attr) => match class_start {
            Some(cls) => state.baseline(cls, attr),
            None => TypeSet::new(),
        },
        RhsShape::Local(name) => {
            if !visited.insert((method_start.unwrap_or(usize::MAX), name.clone())) {
                return TypeSet::new(); // cycle
            }
            // the nearest write site inside a method domain (class body direct with
            // method_start=None has no local chain - the module level fallback can
            // still resolve it, see below)
            let method_found = method_start.and_then(|ms| {
                state.locals.get(&(ms, name.clone())).and_then(|v| {
                    v.iter()
                        .rev()
                        .find(|(l, _)| *l < flow_line)
                        .map(|(l, s)| (*l, s))
                })
            });
            let found = method_found.or_else(|| {
                // module level write site fallback (batch D): module domain bare
                // names are visible to method / class bodies (Python read
                // semantics); only module level write sites count (a class body
                // instance write site is invisible to the method body, honestly
                // missed)
                state.bare_writes.get(name).and_then(|v| {
                    v.iter()
                        .rev()
                        .find(|w| {
                            w.line < flow_line
                                && w.method_start.is_none()
                                && w.class_start.is_none()
                        })
                        .map(|w| (w.line, &w.shape))
                })
            });
            match found {
                Some((l, s)) => {
                    resolve_shape(state, s, l, class_start, method_start, depth + 1, visited)
                }
                None => TypeSet::new(),
            }
        }
        RhsShape::Call(callee) => resolve_callee(
            state,
            callee,
            flow_line,
            class_start,
            method_start,
            depth,
            visited,
        ),
        RhsShape::Unknown => TypeSet::new(),
    }
}

fn resolve_callee(
    state: &mut ResolveState,
    callee: &CalleeShape,
    flow_line: usize,
    class_start: Option<usize>,
    method_start: Option<usize>,
    depth: usize,
    visited: &mut HashSet<(usize, String)>,
) -> TypeSet {
    if depth > RESOLVE_MAX_HOPS {
        return TypeSet::new();
    }
    let ann = match callee {
        // KBUG-BIND-02: resolve the binding fact at the call position first -
        // a parameter / local def / a preceding write site in the domain / an
        // alias binding shadows the module declaration table; only when Unbound
        // does the declaration table apply as usual (an unknown dynamic callable
        // is not settled by a same-named declaration).
        CalleeShape::Name(n) => match state.callee_binding(n, flow_line) {
            // bound value = an identity atom (class name / function name): the flow
            // atom goes through the declaration table again by that name (function
            // name -> its return annotation; class name -> the instantiation atom)
            CalleeBinding::Bound(Some(atom)) => state.callee_atom(&atom),
            CalleeBinding::Bound(None) => None,
            CalleeBinding::Unbound => state.callee_atom(n),
        },
        CalleeShape::Qualified { class, method } => state
            .unique_class(class)
            .and_then(|cls| state.method_atom(cls, method))
            .or_else(|| {
                // bare name receiver ambiguity (batch D): besides the class
                // qualification of `A.m(...)`, there is also "a local / module
                // variable.m(...)" - decided by the variable atom chain (class
                // qualification first, a variable only when it is not a class name;
                // when a same-named class and variable coexist the class reading
                // wins)
                let var = RhsShape::Local(class.clone());
                let atoms = resolve_shape(
                    state,
                    &var,
                    flow_line,
                    class_start,
                    method_start,
                    depth + 1,
                    visited,
                );
                if atoms.len() != 1 {
                    return None;
                }
                let atom = atoms.iter().next().unwrap();
                state
                    .unique_class(atom)
                    .and_then(|cls| state.method_atom(cls, method))
            }),
        CalleeShape::SelfMethod(m) => class_start.and_then(|cls| state.method_atom(cls, m)),
        CalleeShape::Chained { receiver, method } => {
            let recv = resolve_shape(
                state,
                receiver,
                flow_line,
                class_start,
                method_start,
                depth + 1,
                visited,
            );
            if recv.len() != 1 {
                return TypeSet::new(); // the receiver is not unique / unknown -> do not guess
            }
            let atom = recv.iter().next().unwrap();
            state
                .unique_class(atom)
                .and_then(|cls| state.method_atom(cls, method))
        }
    };
    match ann {
        Some(text) => atom(&text),
        None => TypeSet::new(),
    }
}

// ---- version key LRU parse cache (KODE-PERF-001 semantics alignment) -------

/// The full derivation of one parse (class spans + assignment type index +
/// collected surface tables), cached by versionKey.
#[derive(Debug, Clone)]
pub struct FlowParse {
    pub classes: Vec<ClassSpan>,
    /// Method level `self.<attr>` assignment types (key = start line; nested
    /// function bodies included - the scan indent filtering keeps them from
    /// polluting the outer flow, they only hit at the write site query position)
    pub assignments: AssignmentTypes,
    /// Class body direct bare name assignment / annotation types (the baseline
    /// surface; nested blocks / nested class bodies do not enter, isolated by
    /// class identity)
    pub class_direct: ClassAssignmentTypes,
    /// Batch D localReturnType surface: the global bare name write site table
    /// (name -> write sites in source order)
    pub(crate) bare_writes: HashMap<String, Vec<BareWrite>>,
    /// KBUG-SCOPE: function / lambda lexical domain table (body first line order;
    /// material for the scope chain / parameter shadowing)
    pub(crate) fn_domains: Vec<FnDomain>,
    /// KBUG-SCOPE: class body `global` declarations (class name line -> names)
    pub(crate) scope_globals: HashMap<usize, Vec<String>>,
    /// KBUG-CFGFLOW: function domain statement flow tree (header_line -> tree)
    pub(crate) fn_trees: HashMap<usize, Vec<FlowStmt>>,
    /// KBUG-CFGFLOW: class body statement flow tree (class name line -> tree)
    pub(crate) class_trees: HashMap<usize, Vec<FlowStmt>>,
    /// KBUG-CFGFLOW: module statement flow tree
    pub(crate) module_tree: Vec<FlowStmt>,
    /// Module-level def `-> T` table
    pub(crate) def_returns: HashMap<String, DefReturn>,
    /// Class name -> class name line
    pub(crate) class_names: HashMap<String, Vec<usize>>,
    /// Class name line -> method name -> collected return annotations
    pub(crate) class_methods: HashMap<usize, HashMap<String, Vec<Option<String>>>>,
    /// Local bare name write sites within a method domain (batch C chain
    /// material; shared by surface and flow)
    pub(crate) locals: HashMap<(usize, String), Vec<(usize, RhsShape)>>,
}

struct ParseCacheEntry {
    map: HashMap<String, FlowParse>,
    order: VecDeque<String>,
}

static PARSE_CACHE: Mutex<Option<ParseCacheEntry>> = Mutex::new(None);

/// Line list -> parse derivation (UTF-16 lines join('\n') -> String -> ruff
/// tolerant parse).
fn flow_parse_from_lines(lines: &[Vec<u16>]) -> Result<FlowParse, &'static str> {
    let mut content: Vec<u16> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if idx > 0 {
            content.push(0x0A);
        }
        content.extend_from_slice(line);
    }
    cancel::check_point()?;
    let source = String::from_utf16_lossy(&content);
    let parsed = ParsedAst::new(source);
    cancel::check_point()?;
    let classes = class_spans_from_ast(&parsed);
    cancel::check_point()?;
    let tables = assignments_from_ast(&parsed, lines, &classes)?;
    Ok(FlowParse {
        classes,
        assignments: tables.assignments,
        class_direct: tables.class_direct,
        bare_writes: tables.bare_writes,
        fn_domains: tables.fn_domains,
        scope_globals: tables.scope_globals,
        fn_trees: tables.fn_trees,
        class_trees: tables.class_trees,
        module_tree: tables.module_tree,
        def_returns: tables.def_returns,
        class_names: tables.class_names,
        class_methods: tables.class_methods,
        locals: tables.locals,
    })
}

/// Line list -> full derivation (localReturnType surface entry; the versionKey
/// protocol is the same as the flow surface).
pub fn flow_parse(
    lines: &[Vec<u16>],
    version_key: Option<&str>,
) -> Result<FlowParse, &'static str> {
    parse_with_version_cache(lines, version_key)
}

fn parse_with_version_cache(
    lines: &[Vec<u16>],
    version_key: Option<&str>,
) -> Result<FlowParse, &'static str> {
    let key = match version_key {
        Some(key) => key,
        None => {
            // no key = parse now without caching (the pure function fallback)
            return flow_parse_from_lines(lines);
        }
    };
    let mut guard = PARSE_CACHE.lock().unwrap();
    let entry = guard.get_or_insert(ParseCacheEntry {
        map: HashMap::new(),
        order: VecDeque::new(),
    });
    if let Some(cached) = entry.map.get(key) {
        let cached = cached.clone();
        // LRU touch: move to the tail (most recently used)
        if let Some(pos) = entry.order.iter().position(|k| k == key) {
            entry.order.remove(pos);
        }
        entry.order.push_back(key.to_string());
        return Ok(cached);
    }
    // RUST-072: cancellation (Err) passes through early - a partial parse never
    // enters the cache.
    let parsed = flow_parse_from_lines(lines)?;
    entry.map.insert(key.to_string(), parsed.clone());
    entry.order.push_back(key.to_string());
    while entry.order.len() > PARSE_CACHE_MAX_ENTRIES {
        if let Some(oldest) = entry.order.pop_front() {
            entry.map.remove(&oldest);
        }
    }
    Ok(parsed)
}

/// Clear the cache (a test injection point; unused in production)
pub fn reset_self_attribute_flow_parse_cache_for_tests() {
    *PARSE_CACHE.lock().unwrap() = None;
}

// ---- flow type set operations ----------------------------------------------

#[derive(Debug)]
pub struct SelfAttributeFlow {
    /// Deduplicated sorted atom type names; empty = undeterminable
    pub types: Vec<String>,
    /// The formatted annotation string ('list | None') or None (types empty)
    pub annotation: Option<String>,
    pub has_none: bool,
    /// The narrowing took effect: the baseline contains None while the query
    /// position does not
    pub narrowed: bool,
}

pub(crate) type TypeSet = BTreeSet<String>;

fn union_types(sets: &[&TypeSet]) -> TypeSet {
    let mut out = TypeSet::new();
    for set in sets {
        for item in *set {
            out.insert(item.clone());
        }
    }
    out
}

fn without_none(types: &TypeSet) -> TypeSet {
    types
        .iter()
        .filter(|t| t.as_str() != "None")
        .cloned()
        .collect()
}

/// Sort + join with ` | ` (iterating a BTreeSet is already ascending; an empty
/// set -> None)
fn format_types(types: &TypeSet) -> Option<String> {
    if types.is_empty() {
        return None;
    }
    Some(types.iter().cloned().collect::<Vec<_>>().join(" | "))
}

// ---- line shape scanner (regexes manually expanded, leftmost priority +
//      backtracking semantics) -----------------------------------------------

/// `^\s*if\s+self\.ESC\s+is\s+None\s*:`
fn none_guard(line: &[u16], attr: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    for &byte in b"if" {
        if line.get(i) != Some(&(byte as u16)) {
            return false;
        }
        i += 1;
    }
    // \s+
    let ws = i;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if i == ws {
        return false;
    }
    for &byte in b"self" {
        if line.get(i) != Some(&(byte as u16)) {
            return false;
        }
        i += 1;
    }
    if line.get(i) != Some(&0x2Eu16) {
        return false;
    }
    i += 1;
    if line.len() - i < attr.len() || &line[i..i + attr.len()] != attr {
        return false;
    }
    i += attr.len();
    // \s+ is \s+ None \s* :
    for word in [&b"is"[..], &b"None"[..]] {
        let ws = i;
        while i < line.len() && is_js_space(line[i]) {
            i += 1;
        }
        if i == ws {
            return false;
        }
        for &byte in word.iter() {
            if line.get(i) != Some(&(byte as u16)) {
                return false;
            }
            i += 1;
        }
    }
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    line.get(i) == Some(&0x3Au16)
}

/// `^\s*if\s+self\.ESC\s+is\s+not\s+None\s*:`
fn not_none_guard(line: &[u16], attr: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    for word in [&b"if"[..], &b"self"[..]] {
        for &byte in word {
            if line.get(i) != Some(&(byte as u16)) {
                return false;
            }
            i += 1;
        }
        let ws = i;
        while i < line.len() && is_js_space(line[i]) {
            i += 1;
        }
        if i == ws {
            return false;
        }
    }
    // a '.' should follow 'self'
    if line.get(i) != Some(&0x2Eu16) {
        return false;
    }
    i += 1;
    if line.len() - i < attr.len() || &line[i..i + attr.len()] != attr {
        return false;
    }
    i += attr.len();
    for word in [&b"is"[..], &b"not"[..], &b"None"[..]] {
        let ws = i;
        while i < line.len() && is_js_space(line[i]) {
            i += 1;
        }
        if i == ws {
            return false;
        }
        for &byte in word.iter() {
            if line.get(i) != Some(&(byte as u16)) {
                return false;
            }
            i += 1;
        }
    }
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    line.get(i) == Some(&0x3Au16)
}

/// Block opening keyword alternation (leftmost priority order, same order as
/// the TS regex): if|elif|else|for|while|try|except|finally|with + `\b` word
/// boundary. JS behavior preserved: when a keyword matches but the word
/// boundary fails, keep trying the **subsequent** alternatives (e.g.
/// `elsewhere`: 'else' fails the word boundary, the rest do not match -> the
/// whole thing is rejected).
fn any_block_open(line: &[u16]) -> bool {
    const KEYWORDS: [&[u8]; 9] = [
        b"if", b"elif", b"else", b"for", b"while", b"try", b"except", b"finally", b"with",
    ];
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    'outer: for keyword in KEYWORDS {
        if line.len() - i < keyword.len() {
            continue;
        }
        for (offset, &byte) in keyword.iter().enumerate() {
            if line[i + offset] != byte as u16 {
                continue 'outer;
            }
        }
        let after = i + keyword.len();
        // \b: the boundary after the token (end of line = boundary; a non \w = boundary)
        if after == line.len() || !is_word(line[after]) {
            return true;
        }
    }
    false
}

/// `^\s*(return|raise)\b`
fn terminal_line(line: &[u16]) -> bool {
    const KEYWORDS: [&[u8]; 2] = [b"return", b"raise"];
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    'outer: for keyword in KEYWORDS {
        if line.len() - i < keyword.len() {
            continue;
        }
        for (offset, &byte) in keyword.iter().enumerate() {
            if line[i + offset] != byte as u16 {
                continue 'outer;
            }
        }
        let after = i + keyword.len();
        if after == line.len() || !is_word(line[after]) {
            return true;
        }
    }
    false
}

fn atom(name: &str) -> TypeSet {
    let mut set = TypeSet::new();
    set.insert(name.to_string());
    set
}

// ---- method domain location and the flow walker ----------------------------

struct MethodSpan {
    start_line: usize,
    end_line: usize,
}

/// Method body bounds (0 based, inclusive of the tail): the true AST body
/// domain; among the set of all classes the **innermost domain** that contains
/// the query line wins (nested class lines belong to the nested class method,
/// a conditional def domain no longer overreaches and swallows its neighbors;
/// outside a class / a gap between methods -> None - a gap line is not a use
/// position, missing is the honest answer).
fn enclosing_method(classes: &[ClassSpan], line: usize) -> Option<(MethodSpan, usize)> {
    let mut best: Option<(MethodSpan, usize)> = None;
    for (idx, cls) in classes.iter().enumerate() {
        for domain in &cls.method_domains {
            if line < domain.start_line || line > domain.end_line {
                continue;
            }
            let better = match &best {
                None => true,
                Some((current, _)) => {
                    domain.end_line - domain.start_line < current.end_line - current.start_line
                }
            };
            if better {
                best = Some((
                    MethodSpan {
                        start_line: domain.start_line,
                        end_line: domain.end_line,
                    },
                    idx,
                ));
            }
        }
    }
    best
}

/// Method body base indent: the indent of the first non-empty line after the
/// method line; no body line = the method line indent + 1
fn method_base_indent(lines: &[Vec<u16>], method: &MethodSpan) -> usize {
    let method_indent = lines
        .get(method.start_line)
        .map(|l| indent_of(l))
        .unwrap_or(0);
    for j in method.start_line + 1..=method.end_line {
        if let Some(text) = lines.get(j) {
            if is_blank(text) || is_comment_only(text) {
                continue;
            }
            return indent_of(text);
        }
    }
    method_indent + 1
}

struct ScanResult {
    state: TypeSet,
    /// the then branch terminates with return/raise (does not fall past the block)
    terminal: bool,
    /// the scan stops before stopAtLine (the query position is inside this block)
    reached_stop: bool,
}

/// Sequential scan (at the same indent level): assignment override / the two
/// None guards / generic block union / return raise termination.
/// When stop is non-empty, stop upon reaching the query line (when the write
/// site is exactly the assignment line, first apply the RHS semantics, then
/// stop). Assignment types come from the AST index (batch B): key present = the
/// assignment holds (an empty set = unknown, replacement semantics); key
/// absent = no such assignment on that line, state preserved.
#[allow(clippy::too_many_arguments)]
fn scan_sequence(
    assignments: &AssignmentTypes,
    lines: &[Vec<u16>],
    start_line: usize,
    end_line: usize,
    indent: usize,
    attr: &[u16],
    initial_state: &TypeSet,
    stop_at_line: Option<usize>,
) -> ScanResult {
    let mut state = initial_state.clone();
    let mut line = start_line;
    while line <= end_line {
        if let Some(stop) = stop_at_line {
            if line >= stop {
                // query position: first apply the assignment semantics (the write site
                // inlay shows the RHS type), then stop
                if let Some(types) = assignments.get(line, attr) {
                    return ScanResult {
                        state: types.clone(),
                        terminal: false,
                        reached_stop: true,
                    };
                }
                return ScanResult {
                    state,
                    terminal: false,
                    reached_stop: true,
                };
            }
        }
        let empty: Vec<u16> = Vec::new();
        let text = lines.get(line).unwrap_or(&empty);
        if is_blank(text) || is_comment_only(text) {
            line += 1;
            continue;
        }
        let this_indent = indent_of(text);
        if this_indent < indent {
            break; // dedent: this sequence ends
        }
        if this_indent > indent {
            line += 1; // a deeper indent (a block body) does not belong to this level, skip it
            continue;
        }
        if let Some(types) = assignments.get(line, attr) {
            state = types.clone();
            line += 1;
            continue;
        }
        if none_guard(text, attr) {
            let block_end = find_block_end(lines, line, end_line, this_indent);
            let body_indent = block_body_indent(lines, line, block_end);
            let none_set = atom("None");
            let inner = scan_sequence(
                assignments,
                lines,
                line + 1,
                block_end,
                body_indent,
                attr,
                &none_set,
                stop_at_line,
            );
            if inner.terminal {
                // early exit: the then branch does not fall past the block; the else path
                // continues -> None removed
                state = union_types(&[&without_none(&state)]);
            } else {
                state = union_types(&[&without_none(&state), &inner.state]);
            }
            if inner.reached_stop {
                return ScanResult {
                    state: inner.state,
                    terminal: inner.terminal,
                    reached_stop: true,
                };
            }
            line = block_end + 1;
            continue;
        }
        if not_none_guard(text, attr) {
            let block_end = find_block_end(lines, line, end_line, this_indent);
            let body_indent = block_body_indent(lines, line, block_end);
            let entry = without_none(&state);
            let inner = scan_sequence(
                assignments,
                lines,
                line + 1,
                block_end,
                body_indent,
                attr,
                &entry,
                stop_at_line,
            );
            if inner.terminal {
                // early exit on the non-None block: the then branch exits, else (X may be
                // None) continues -> the entry state
                state = union_types(&[&state]);
            } else {
                state = union_types(&[&state, &inner.state]);
            }
            if inner.reached_stop {
                return ScanResult {
                    state: inner.state,
                    terminal: inner.terminal,
                    reached_stop: true,
                };
            }
            line = block_end + 1;
            continue;
        }
        if any_block_open(text) {
            let block_end = find_block_end(lines, line, end_line, this_indent);
            let body_indent = block_body_indent(lines, line, block_end);
            let inner = scan_sequence(
                assignments,
                lines,
                line + 1,
                block_end,
                body_indent,
                attr,
                &state,
                stop_at_line,
            );
            if inner.terminal {
                state = union_types(&[&state]);
            } else {
                state = union_types(&[&state, &inner.state]);
            }
            if inner.reached_stop {
                return ScanResult {
                    state: inner.state,
                    terminal: inner.terminal,
                    reached_stop: true,
                };
            }
            line = block_end + 1;
            continue;
        }
        if terminal_line(text) {
            return ScanResult {
                state,
                terminal: true,
                reached_stop: false,
            };
        }
        line += 1;
    }
    ScanResult {
        state,
        terminal: false,
        reached_stop: false,
    }
}

/// Block closing line: the line before the first non-empty line whose indent is
/// <= the block line indent; none = endLine
fn find_block_end(lines: &[Vec<u16>], start_line: usize, end_line: usize, indent: usize) -> usize {
    for j in start_line + 1..=end_line {
        if let Some(text) = lines.get(j) {
            if is_blank(text) || is_comment_only(text) {
                continue;
            }
            if indent_of(text) <= indent {
                return j - 1;
            }
        }
    }
    end_line
}

/// The actual block body indent: the indent of the first non-empty line after
/// the block line; no body line = the block line indent + 1
fn block_body_indent(lines: &[Vec<u16>], start_line: usize, end_line: usize) -> usize {
    for j in start_line + 1..=end_line {
        if let Some(text) = lines.get(j) {
            if is_blank(text) || is_comment_only(text) {
                continue;
            }
            return indent_of(text);
        }
    }
    lines.get(start_line).map(|l| indent_of(l)).unwrap_or(0) + 1
}

/// Converged baseline: class level declarations (annotation `X: T` with T first
/// + assignment `X = ...` derivation) union the final state of the __init__
///
/// body flow scan (the tail assignment overrides)
fn converged_baseline(
    class_direct: &ClassAssignmentTypes,
    assignments: &AssignmentTypes,
    lines: &[Vec<u16>],
    cls: &ClassSpan,
    attr: &[u16],
) -> Result<TypeSet, &'static str> {
    let mut baseline = TypeSet::new();
    let first_method_line = cls
        .method_lines
        .values()
        .copied()
        .min()
        .unwrap_or(cls.end_line.saturating_sub(1));
    // class body direct assignment / annotation (the AST collection surface;
    // `X: T` without a value = the annotation text atom, `X: T = v` = the
    // annotation + the RHS derivation)
    let mut j = cls.start_line + 1;
    while j < first_method_line && j < cls.end_line {
        cancel::check_point()?;
        if let Some(types) = class_direct.get(cls.start_line, j, attr) {
            baseline.extend(types.iter().cloned());
        }
        j += 1;
    }
    if let Some(&init_line) = cls.method_lines.get("__init__") {
        let init_method = MethodSpan {
            start_line: init_line,
            end_line: cls.end_line.saturating_sub(1),
        };
        let base_indent = method_base_indent(lines, &init_method);
        let result = scan_sequence(
            assignments,
            lines,
            init_line + 1,
            init_method.end_line,
            base_indent,
            attr,
            &baseline,
            None,
        );
        baseline = result.state;
    }
    Ok(baseline)
}

/// The flow-sensitive type of a self-managed attribute at the query position (a
/// pure function; equal to TS inferSelfAttributeFlow).
/// None when: attr is empty / the query line is out of bounds.
pub fn infer_self_attribute_flow(
    lines: &[Vec<u16>],
    query_line: usize,
    attr: &[u16],
    version_key: Option<&str>,
) -> Result<Option<SelfAttributeFlow>, &'static str> {
    if attr.is_empty() || query_line >= lines.len() {
        return Ok(None);
    }
    let flow_parse = parse_with_version_cache(lines, version_key)?;
    let classes = &flow_parse.classes;
    let enclosing = enclosing_method(classes, query_line);
    let (flow, baseline) = if let Some((method, cls_idx)) = enclosing {
        let baseline = converged_baseline(
            &flow_parse.class_direct,
            &flow_parse.assignments,
            lines,
            &classes[cls_idx],
            attr,
        )?;
        let base_indent = method_base_indent(lines, &method);
        let result = scan_sequence(
            &flow_parse.assignments,
            lines,
            method.start_line + 1,
            method.end_line,
            base_indent,
            attr,
            &baseline,
            Some(query_line),
        );
        (result.state, baseline)
    } else {
        // class body / module level: no method flow, use the converged baseline
        // directly (the innermost containing class wins - nested class attribution
        // is correct)
        let cls = classes
            .iter()
            .filter(|c| query_line >= c.start_line && query_line < c.end_line)
            .min_by_key(|c| c.end_line - c.start_line);
        match cls {
            Some(cls) => {
                let baseline = converged_baseline(
                    &flow_parse.class_direct,
                    &flow_parse.assignments,
                    lines,
                    cls,
                    attr,
                )?;
                (baseline.clone(), baseline)
            }
            None => (TypeSet::new(), TypeSet::new()),
        }
    };
    let has_none = flow.contains("None");
    let narrowed = baseline.contains("None") && !has_none;
    Ok(Some(SelfAttributeFlow {
        types: flow.iter().cloned().collect(),
        annotation: format_types(&flow),
        has_none,
        narrowed,
    }))
}

// ---- unit tests (key examples ported from TS
// ---- tests/selfAttributeFlowTypes.test.ts; callback surface cases stay on the
// ---- TS side - the production contract has no callbacks) -------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(body: &[&str]) -> Vec<Vec<u16>> {
        body.iter().map(|l| l.encode_utf16().collect()).collect()
    }

    fn attr_u16(name: &str) -> Vec<u16> {
        name.encode_utf16().collect()
    }

    fn flow(body: &[&str], query_line: usize, attr: &str) -> SelfAttributeFlow {
        infer_self_attribute_flow(
            &lines_of(body),
            query_line,
            &attr.encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("infer not cancelled")
        .expect("flow exists")
    }

    #[test]
    fn guard_narrowing_without_call_annotation() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "    def method(self):",
            "        if self.TalentTree is None:",
            "            self.TalentTree = make_tree()",
            "        x = self.TalentTree",
        ];
        let f = flow(&body, 6, "TalentTree");
        assert!(!f.has_none);
        assert!(f.narrowed);
        assert_eq!(f.annotation, None); // the call annotation cannot be resolved -> the empty set, no fabricated Any
    }

    #[test]
    fn init_override_converges_to_list() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "        self.TalentTree = []",
            "    def method(self):",
            "        x = self.TalentTree",
        ];
        let f = flow(&body, 5, "TalentTree");
        assert!(!f.has_none);
        assert_eq!(f.annotation.as_deref(), Some("list"));
    }

    #[test]
    fn bare_none_keeps_none_evidence() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "    def method(self):",
            "        self.TalentTree.get(0)",
        ];
        let f = flow(&body, 4, "TalentTree");
        assert!(f.has_none);
        assert!(!f.narrowed);
        assert_eq!(f.annotation.as_deref(), Some("None"));
    }

    #[test]
    fn class_level_none_reports() {
        let body = [
            "class Foo:",
            "    TalentTree = None",
            "    def method(self):",
            "        self.TalentTree.get(0)",
        ];
        assert!(flow(&body, 3, "TalentTree").has_none);
    }

    #[test]
    fn not_none_guard_narrows_inside_block() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "        self.TalentTree = []",
            "    def method(self):",
            "        if self.TalentTree is not None:",
            "            self.TalentTree.get(0)",
        ];
        assert!(!flow(&body, 6, "TalentTree").has_none);
    }

    #[test]
    fn early_exit_guard_removes_none() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "    def method(self):",
            "        if self.TalentTree is None:",
            "            return",
            "        self.TalentTree.get(0)",
        ];
        let f = flow(&body, 6, "TalentTree");
        assert!(!f.has_none);
        assert!(f.narrowed);
    }

    #[test]
    fn sibling_attribute_unaffected() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.Alpha = None",
            "        self.Beta = None",
            "    def method(self):",
            "        if self.Alpha is None:",
            "            self.Alpha = []",
            "        x = self.Beta",
        ];
        assert!(flow(&body, 7, "Beta").has_none);
    }

    #[test]
    fn literal_annotations() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.A = [1, 2, 3]",
            "        self.B = {\"k\": 1}",
            "        self.C = \"hi\"",
            "        self.D = 7",
        ];
        assert_eq!(flow(&body, 2, "A").annotation.as_deref(), Some("list"));
        assert_eq!(flow(&body, 3, "B").annotation.as_deref(), Some("dict"));
        assert_eq!(flow(&body, 4, "C").annotation.as_deref(), Some("str"));
        assert_eq!(flow(&body, 5, "D").annotation.as_deref(), Some("int"));
    }

    #[test]
    fn guard_union_drops_none() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.X = None",
            "        self.X = []",
            "    def method(self):",
            "        if self.X is None:",
            "            self.X = [1]",
            "        y = self.X",
        ];
        assert!(!flow(&body, 7, "X").has_none);
    }

    #[test]
    fn kode_aud_004_else_body_joins_union() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.X = None",
            "    def method(self):",
            "        if cond:",
            "            self.X = None",
            "        else:",
            "            self.X = [2]",
            "        y = self.X",
        ];
        let f = flow(&body, 8, "X");
        assert!(f.types.iter().any(|t| t == "None"));
        assert!(f.types.iter().any(|t| t == "list"));
    }

    #[test]
    fn kode_aud_004_if_elif_else_three_sides() {
        let body = [
            "class Foo:",
            "    def method(self):",
            "        if a:",
            "            self.X = None",
            "        elif b:",
            "            self.X = [1]",
            "        else:",
            "            self.X = \"s\"",
            "        y = self.X",
        ];
        let f = flow(&body, 8, "X");
        assert!(f.types.iter().any(|t| t == "None"));
        assert!(f.types.iter().any(|t| t == "list"));
        assert!(f.types.iter().any(|t| t == "str"));
    }

    #[test]
    fn kode_aud_004_try_except_else_finally() {
        let body = [
            "class Foo:",
            "    def method(self):",
            "        try:",
            "            self.X = [1]",
            "        except ValueError:",
            "            self.X = None",
            "        else:",
            "            self.X = [2]",
            "        finally:",
            "            cleanup()",
            "        y = self.X",
        ];
        let f = flow(&body, 10, "X");
        assert!(f.types.iter().any(|t| t == "list"));
        assert!(f.types.iter().any(|t| t == "None"));
    }

    #[test]
    fn kode_aud_004_early_return_branch_not_after_block() {
        let body = [
            "class Foo:",
            "    def method(self):",
            "        if self.X is None:",
            "            return",
            "        else:",
            "            self.X = [2]",
            "        y = self.X",
        ];
        let f = flow(&body, 6, "X");
        assert!(!f.has_none);
        assert!(f.types.iter().any(|t| t == "list"));
    }

    #[test]
    fn kode_aud_004_bytes_prefixes() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.B = b'abc'",
            "        self.BR = br'abc'",
            "        self.RB = rb'abc'",
            "        self.S = 'abc'",
            "        self.R = r'abc'",
            "        self.F = f'{x}'",
        ];
        assert_eq!(flow(&body, 2, "B").annotation.as_deref(), Some("bytes"));
        assert_eq!(flow(&body, 3, "BR").annotation.as_deref(), Some("bytes"));
        assert_eq!(flow(&body, 4, "RB").annotation.as_deref(), Some("bytes"));
        assert_eq!(flow(&body, 5, "S").annotation.as_deref(), Some("str"));
        assert_eq!(flow(&body, 6, "R").annotation.as_deref(), Some("str"));
        assert_eq!(flow(&body, 7, "F").annotation.as_deref(), Some("str"));
    }

    #[test]
    fn kr_aud_59_augmented_assignment_not_captured() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = []",
            "    def add(self):",
            "        self.items += [1]",
            "    def use(self):",
            "        x = self.items",
        ];
        let f = flow(&body, 6, "items");
        assert_eq!(f.annotation.as_deref(), Some("list"));
        assert!(!f.has_none);
    }

    #[test]
    fn kr_aud_59_augmented_keeps_none() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = None",
            "    def use(self):",
            "        self.items += [1]",
            "        x = self.items",
        ];
        assert!(flow(&body, 5, "items").has_none);
    }

    #[test]
    fn kr_aud_59_comparison_not_captured() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = None",
            "    def use(self):",
            "        self.items != []",
            "        x = self.items",
        ];
        assert!(flow(&body, 5, "items").has_none);
    }

    #[test]
    fn kr_aud_59_plain_assignment_overrides() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = None",
            "    def use(self):",
            "        self.items = []",
            "        x = self.items",
        ];
        let f = flow(&body, 5, "items");
        assert!(!f.has_none);
        assert_eq!(f.annotation.as_deref(), Some("list"));
    }

    #[test]
    fn write_point_atomic_faces() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        pass",
            "    def method(self):",
            "        self.a = 1 # 整数注释",
            "        self.b = # 只剩注释",
            "        self.c = True",
            "        self.d = 3.14",
            "        self.e = (1, 2)",
            "        self.f = self.g",
            "        self.j = a[0]",
        ];
        assert_eq!(flow(&body, 4, "a").annotation.as_deref(), Some("int"));
        assert_eq!(flow(&body, 5, "b").annotation, None);
        assert_eq!(flow(&body, 6, "c").types, vec!["bool"]);
        assert_eq!(flow(&body, 7, "d").types, vec!["float"]);
        assert_eq!(flow(&body, 8, "e").types, vec!["tuple"]);
        assert_eq!(flow(&body, 9, "f").annotation, None); // the self chain is not recursive
        assert_eq!(flow(&body, 10, "j").annotation, None); // the subscript shape falls back to the empty set
    }

    #[test]
    fn invalid_inputs_return_none() {
        let lines = lines_of(&["class Foo:", "    def m(self):", "        self.x = 1"]);
        assert!(infer_self_attribute_flow(&lines, 1, &[], None)
            .expect("infer not cancelled")
            .is_none());
        assert!(
            infer_self_attribute_flow(&lines, usize::MAX, &attr_u16("x"), None)
                .expect("not cancelled")
                .is_none()
        );
    }

    #[test]
    fn outside_class_and_docstring_positions() {
        let outside = lines_of(&[
            "class A:",
            "    def m(self):",
            "        pass",
            "def free():",
            "    pass",
            "class B:",
            "    def n(self):",
            "        pass",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&outside, 4, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            None
        );
        let docstring = lines_of(&[
            "class Foo:",
            "    \"\"\"类文档串\"\"\"",
            "    def m(self):",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&docstring, 1, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            None
        );
    }

    #[test]
    fn method_body_indent_fallbacks() {
        let commented = lines_of(&[
            "class Foo:",
            "    def m(self):",
            "        # 先注释",
            "        self.x = 1",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&commented, 4, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let empty_body = lines_of(&[
            "class Foo:",
            "    def m1(self):",
            "    def m2(self):",
            "        self.x = 1",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&empty_body, 4, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let blank_body = lines_of(&[
            "class Foo:",
            "    def m1(self):",
            "",
            "    def m2(self):",
            "        self.x = 1",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&blank_body, 2, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            None
        );
    }

    #[test]
    fn is_not_none_guard_terminal_and_block_stop() {
        let terminal = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if self.x is not None:",
            "            return",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&terminal, 6, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let block_stop = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if self.x is not None:",
            "            self.x = \"s\"",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 6, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 5, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("str".to_string())
        );
    }

    #[test]
    fn plain_block_blank_lines_do_not_close_block() {
        let terminal = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if other:",
            "            return",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&terminal, 6, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let block_stop = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if other:",
            "",
            "            self.x = \"s\"",
            "",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 6, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("str".to_string())
        );
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 8, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
    }

    #[test]
    fn bodyless_block_does_not_panic() {
        let lines = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "        if other:",
            "",
        ]);
        assert!(infer_self_attribute_flow(&lines, 4, &attr_u16("x"), None)
            .expect("not cancelled")
            .is_some());
    }

    #[test]
    fn deeper_indented_stray_lines_skipped() {
        let lines = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        pass",
            "    def m(self):",
            "        self.x = 1",
            "            stray = 2",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&lines, 6, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
    }

    #[test]
    fn class_level_annotated_declarations() {
        let annotated = lines_of(&[
            "class Foo:",
            "",
            "    x: str = \"d\"",
            "        weird = 2",
            "    def __init__(self):",
            "        pass",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&annotated, 5, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .types,
            vec!["str"]
        );
        let bare_annotated = lines_of(&[
            "class Foo:",
            "    x: list",
            "    def __init__(self):",
            "        pass",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&bare_annotated, 3, &attr_u16("x"), None)
                .expect("not cancelled")
                .unwrap()
                .types,
            vec!["list"]
        );
    }

    #[test]
    fn version_key_cache_reuses_parse() {
        reset_self_attribute_flow_parse_cache_for_tests();
        let lines = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.X = None",
            "        self.X = []",
            "    def m(self):",
            "        y = self.X",
        ]);
        let key = "file:///a.py|9";
        let a = infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some(key))
            .expect("not cancelled")
            .unwrap();
        let b = infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some(key))
            .expect("not cancelled")
            .unwrap();
        assert_eq!(a.annotation, b.annotation);
        // a different key / no key proceeds as usual
        assert!(
            infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some("file:///a.py|10"))
                .expect("not cancelled")
                .is_some()
        );
        assert!(infer_self_attribute_flow(&lines, 5, &attr_u16("X"), None)
            .expect("not cancelled")
            .is_some());
    }

    // ---- precision main lane batch A: the true AST domains ------------------

    #[test]
    fn ast_span_shape_flat_and_nested() {
        let src = [
            "class Outer:",
            "    def m(self):",
            "        pass",
            "    class Inner:",
            "        pass",
        ]
        .join("\n");
        let spans = class_spans_from_ast(&ParsedAst::new(src));
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].name, "Outer");
        assert_eq!(spans[0].start_line, 0);
        assert_eq!(spans[0].end_line, 5);
        assert_eq!(spans[0].method_lines.get("m"), Some(&1));
        assert_eq!(spans[0].method_domains.len(), 1);
        assert_eq!(spans[0].method_domains[0].start_line, 1);
        assert_eq!(spans[0].method_domains[0].end_line, 2);
        assert_eq!(spans[1].name, "Inner");
        assert_eq!(spans[1].start_line, 3);
        assert_eq!(spans[1].end_line, 5);
        assert!(spans[1].method_domains.is_empty());
    }

    #[test]
    fn decorated_class_and_def_lines_exclude_decorator() {
        // the ruff class/def range includes the @ prefix; after correcting to the
        // name line this matches the old "def name line" semantics
        let src = "@deco\nclass A:\n    @prop\n    def m(self):\n        pass\n";
        let spans = class_spans_from_ast(&ParsedAst::new(src.to_string()));
        assert_eq!(spans[0].name, "A");
        assert_eq!(spans[0].start_line, 1);
        assert_eq!(spans[0].method_domains[0].name, "m");
        assert_eq!(spans[0].method_domains[0].start_line, 3);
        assert_eq!(spans[0].method_domains[0].end_line, 4);
    }

    #[test]
    fn nested_class_lines_attributed_to_inner_class() {
        // old engine: a query line inside a nested class body was swallowed by the
        // outer class (first container wins + the next method start - 1), so self.y
        // was wrongly bound to the Outer.m flow; with the true domains it belongs to
        // Inner.n, and querying x within the Inner domain no longer force-applies
        // across classes.
        let body = [
            "class Outer:",
            "    def m(self):",
            "        self.x = 1",
            "    class Inner:",
            "        def n(self):",
            "            self.y = 2",
            "            return self.y",
        ];
        assert_eq!(flow(&body, 6, "y").types, vec!["int"]);
        assert_eq!(flow(&body, 6, "x").types, Vec::<String>::new());
    }

    #[test]
    fn trailing_class_body_lines_leave_method_domain() {
        // the old engine swallowed the class tail line into the last method domain
        // (next method start - 1 -> the class tail); with the true domains a class
        // level line no longer inherits the method flow (querying m still yields the
        // int write site, a class level line falls to the baseline = honestly empty).
        let body = [
            "class A:",
            "    def m(self):",
            "        self.x = 1",
            "    y = 2",
        ];
        assert_eq!(flow(&body, 2, "x").types, vec!["int"]);
        assert_eq!(flow(&body, 3, "x").types, Vec::<String>::new());
    }

    #[test]
    fn decorator_lines_are_not_method_domain() {
        // decorator lines are inside no method domain (same as the old engine: the
        // class body branch = the baseline)
        let body = [
            "class A:",
            "    @property",
            "    def m(self):",
            "        self.x = 1",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 4, "x").types, vec!["int"]);
        assert_eq!(flow(&body, 1, "x").types, Vec::<String>::new());
    }

    #[test]
    fn conditional_def_stays_within_its_true_body() {
        // defs inside an if TYPE_CHECKING body: membership goes to the class (same
        // membership as the old flattened semantics), the domain is the true body
        let body = [
            "class A:",
            "    if TYPE_CHECKING:",
            "        def helper(self):",
            "            self.x = \"t\"",
            "    def real(self):",
            "        self.x = 1",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 3, "x").types, vec!["str"]);
        assert_eq!(flow(&body, 6, "x").types, vec!["int"]);
    }

    // ---- batch B: typeOfExpr on the AST (literal surface inference upgrade) -

    #[test]
    fn set_literal_not_dict() {
        // misleading behavior ledger #1: {1,2} was misjudged as dict by first/last
        // character sniffing; with the AST Set -> set, an empty dict {} is still dict,
        // and a call to set() is still underivable (batch C).
        let body = [
            "class A:",
            "    def m(self):",
            "        self.s = {1, 2}",
            "        self.d = {}",
            "        self.c = set()",
            "        return self.s",
        ];
        assert_eq!(flow(&body, 5, "s").types, vec!["set"]);
        assert_eq!(flow(&body, 5, "d").types, vec!["dict"]);
        assert_eq!(flow(&body, 5, "c").types, Vec::<String>::new());
    }

    #[test]
    fn paren_number_not_tuple() {
        // the old engine judged tuple by the first/last characters `(x)`: parens are
        // dropped by ruff, (5) is simply an int.
        let body = [
            "class A:",
            "    def m(self):",
            "        self.a = (5)",
            "        self.b = ((5))",
            "        self.c = (1, 2)",
            "        return self.a",
        ];
        assert_eq!(flow(&body, 5, "a").types, vec!["int"]);
        assert_eq!(flow(&body, 5, "b").types, vec!["int"]);
        assert_eq!(flow(&body, 5, "c").types, vec!["tuple"]);
    }

    #[test]
    fn walrus_yields_inner_type() {
        let body = [
            "class A:",
            "    def m(self):",
            "        self.n = (v := 10)",
            "        return self.n",
        ];
        assert_eq!(flow(&body, 3, "n").types, vec!["int"]);
    }

    #[test]
    fn multiline_rhs_fully_typed() {
        // the old engine truncated the RHS at the line end, so a parenthesized span
        // across lines could not be resolved; the AST takes the whole expression node.
        let body = [
            "class A:",
            "    def m(self):",
            "        self.t = (",
            "            1,",
            "        )",
            "        return self.t",
        ];
        assert_eq!(flow(&body, 5, "t").types, vec!["tuple"]);
    }

    #[test]
    fn numeric_unary_operators() {
        let body = [
            "class A:",
            "    def m(self):",
            "        self.a = -1.5",
            "        self.b = +0x10",
            "        self.c = not flag",
            "        self.d = -True",
            "        self.e = ~3",
            "        self.f = -'str'",
            "        return self.a",
        ];
        assert_eq!(flow(&body, 8, "a").types, vec!["float"]);
        assert_eq!(flow(&body, 8, "b").types, vec!["int"]);
        assert_eq!(flow(&body, 8, "c").types, vec!["bool"]);
        assert_eq!(flow(&body, 8, "d").types, vec!["int"]);
        assert_eq!(flow(&body, 8, "e").types, vec!["int"]);
        assert_eq!(flow(&body, 8, "f").types, Vec::<String>::new());
    }

    #[test]
    fn hex_scientific_and_bool_literals() {
        let body = [
            "class A:",
            "    def m(self):",
            "        self.a = 0xFF",
            "        self.b = 1e3",
            "        self.c = 0b101",
            "        self.d = True",
            "        self.e = ...",
            "        return self.a",
        ];
        assert_eq!(flow(&body, 7, "a").types, vec!["int"]);
        assert_eq!(flow(&body, 7, "b").types, vec!["float"]);
        assert_eq!(flow(&body, 7, "c").types, vec!["int"]);
        assert_eq!(flow(&body, 7, "d").types, vec!["bool"]);
        assert_eq!(flow(&body, 7, "e").types, vec!["ellipsis"]);
    }

    #[test]
    fn same_line_compound_not_typed() {
        // `if c: self.x = 1` runs conditionally and is not force-applied (the same
        // semantics as the old engine "the line does not start with self"): the scan
        // treats it as an ordinary line in line order and does not collect it.
        let body = [
            "class A:",
            "    def m(self, c):",
            "        if c: self.x = 1",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 3, "x").types, Vec::<String>::new());
    }

    #[test]
    fn tuple_targets_pair_with_value_tuple() {
        let body = [
            "class A:",
            "    def m(self):",
            "        self.x, self.y = 1, 2",
            "        self.a, self.b = f()",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 4, "x").types, vec!["int"]);
        assert_eq!(flow(&body, 4, "y").types, vec!["int"]);
        // the RHS is underivable: the replacement semantics holds (the empty set
        // overwrites), the old value is not backfilled
        assert_eq!(flow(&body, 4, "a").types, Vec::<String>::new());
        assert_eq!(flow(&body, 4, "b").types, Vec::<String>::new());
    }

    #[test]
    fn chained_targets_all_typed() {
        // the old engine only took the first RHS capture; with the AST each target of
        // a multi-target assignment enters the index
        let body = [
            "class A:",
            "    def m(self):",
            "        self.x = self.y = 1",
            "        return self.y",
        ];
        assert_eq!(flow(&body, 3, "x").types, vec!["int"]);
        assert_eq!(flow(&body, 3, "y").types, vec!["int"]);
    }

    #[test]
    fn annotated_method_body_assignments() {
        let body = [
            "class A:",
            "    def m(self):",
            "        self.x: MyClass = None",
            "        self.y: int",
            "        return self.x",
        ];
        // the annotation atom + the RHS derivation coexist (the same semantics as a
        // class level AnnAssign)
        assert_eq!(flow(&body, 4, "x").types, vec!["MyClass", "None"]);
        assert_eq!(flow(&body, 4, "y").types, vec!["int"]);
    }

    #[test]
    fn bytes_fstring_prefixes() {
        let body = [
            "class A:",
            "    def m(self):",
            "        self.a = b'raw'",
            "        self.b = f'{v}'",
            "        self.c = r'regex'",
            "        return self.a",
        ];
        assert_eq!(flow(&body, 5, "a").types, vec!["bytes"]);
        assert_eq!(flow(&body, 5, "b").types, vec!["str"]);
        assert_eq!(flow(&body, 5, "c").types, vec!["str"]);
    }

    #[test]
    fn docstring_assignment_not_fabricated() {
        // the old engine scanned text line by line: `self.x = 1` inside a docstring
        // was taken as a real assignment (int).
        // With the AST it is a StringLiteral statement and produces no assignment -
        // the illusion is gone, honestly empty.
        let body = [
            "class A:",
            "    def m(self):",
            "        \"\"\"",
            "        self.x = 1",
            "        \"\"\"",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 5, "x").types, Vec::<String>::new());
    }

    #[test]
    fn semicolon_combo_each_typed() {
        // the old engine swallowed the RHS capture to the line end (`1; self.b = 2`
        // treated as one whole RHS); the AST splits by statement and derives each.
        let body = [
            "class A:",
            "    def m(self):",
            "        self.a = 1; self.b = 's'",
            "        return self.a",
        ];
        assert_eq!(flow(&body, 3, "a").types, vec!["int"]);
        assert_eq!(flow(&body, 3, "b").types, vec!["str"]);
    }

    #[test]
    fn module_call_annotation_hit() {
        // batch C: take the same-file def `-> T` annotation directly (the bare name
        // call surface)
        let body = [
            "def make_tree() -> Tree:",
            "    return None",
            "",
            "class A:",
            "    def __init__(self):",
            "        self.t = None",
            "    def load(self):",
            "        self.t = make_tree()",
            "        return self.t",
        ];
        let f = flow(&body, 8, "t");
        assert_eq!(f.types, vec!["Tree"]);
        assert!(!f.has_none);
        assert!(f.narrowed); // the baseline None is overwritten by a derivable call -> the narrowing is faithful
    }

    #[test]
    fn module_call_quoted_annotation_kept_raw() {
        // a string annotation slice keeps its quotes (consistent with the old
        // annotation atom semantics)
        let body = [
            "def make_cfg() -> \"Config\":",
            "    return None",
            "",
            "class A:",
            "    def m(self):",
            "        self.c = make_cfg()",
            "        return self.c",
        ];
        assert_eq!(flow(&body, 5, "c").types, vec!["\"Config\""]);
    }

    #[test]
    fn module_call_no_annotation_honest_empty() {
        let body = [
            "def make_thing():",
            "    return None",
            "",
            "class A:",
            "    def m(self):",
            "        self.x = make_thing()",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 5, "x").types, Vec::<String>::new());
    }

    #[test]
    fn module_call_ambiguous_name_not_guessed() {
        // two module-level defs with the same name: ambiguous = unknown, never guess
        // the first definition
        let body = [
            "def make() -> Foo:",
            "    return None",
            "",
            "def make() -> Bar:",
            "    return None",
            "",
            "class A:",
            "    def m(self):",
            "        self.x = make()",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 8, "x").types, Vec::<String>::new());
    }

    #[test]
    fn self_method_call_resolved_in_own_class() {
        let body = [
            "class A:",
            "    def helper(self) -> int:",
            "        return 1",
            "    def m(self):",
            "        self.n = self.helper()",
            "        return self.n",
        ];
        assert_eq!(flow(&body, 5, "n").types, vec!["int"]);
    }

    #[test]
    fn qualified_class_method_call() {
        let body = [
            "class Repo:",
            "    def load(self) -> Row:",
            "        return None",
            "",
            "class A:",
            "    def m(self):",
            "        self.r = Repo.load(Repo)",
            "        return self.r",
        ];
        assert_eq!(flow(&body, 6, "r").types, vec!["Row"]);
    }

    #[test]
    fn qualified_class_ambiguous_not_guessed() {
        // two classes with the same name: class qualified resolution is ambiguous ->
        // honestly empty
        let body = [
            "class Repo:",
            "    def load(self) -> Row:",
            "        return None",
            "",
            "class Repo:",
            "    pass",
            "",
            "class A:",
            "    def m(self):",
            "        self.r = Repo.load(Repo)",
            "        return self.r",
        ];
        assert_eq!(flow(&body, 8, "r").types, Vec::<String>::new());
    }

    #[test]
    fn chained_call_via_class_atom() {
        // chained f().g(): the f annotation is exactly a class name -> that class
        // method annotation (misleading behavior ledger #5)
        let body = [
            "class Repo:",
            "    def load(self) -> Row:",
            "        return None",
            "",
            "def make_repo() -> Repo:",
            "    return None",
            "",
            "class A:",
            "    def m(self):",
            "        self.r = make_repo().load()",
            "        return self.r",
        ];
        assert_eq!(flow(&body, 8, "r").types, vec!["Row"]);
    }

    #[test]
    fn chained_receiver_not_class_atom_honest_empty() {
        // the receiver atom is not a class name (int) -> do not guess
        let body = [
            "class Repo:",
            "    def load(self) -> Row:",
            "        return None",
            "",
            "def make_count() -> int:",
            "    return None",
            "",
            "class A:",
            "    def m(self):",
            "        self.r = make_count().load()",
            "        return self.r",
        ];
        assert_eq!(flow(&body, 8, "r").types, Vec::<String>::new());
    }

    #[test]
    fn instantiation_flows_class_atom() {
        // batch D: callee atom surface completion - class instantiation yields a class
        // name atom (`x = Repo()` is flow evidence as it stands)
        let body = [
            "class Repo:",
            "    pass",
            "",
            "class A:",
            "    def __init__(self):",
            "        self.r = Repo()",
            "        return self.r",
        ];
        assert_eq!(flow(&body, 5, "r").types, vec!["Repo"]);
    }

    #[test]
    fn class_and_def_same_name_callee_atom_ambiguous() {
        // batch D: a def and a unique same-named class coexisting = ambiguous, do
        // not guess (honestly empty)
        let body = [
            "class Repo:",
            "    pass",
            "",
            "def Repo() -> int:",
            "    return None",
            "",
            "class A:",
            "    def __init__(self):",
            "        self.r = Repo()",
            "        return self.r",
        ];
        assert_eq!(flow(&body, 8, "r").types, Vec::<String>::new());
    }

    #[test]
    fn qualified_bare_name_variable_receiver_in_flow() {
        // batch D: bare name receiver ambiguity - a non class name goes through the
        // variable atom chain (module `repo` -> the Repo atom)
        let body = [
            "class Repo:",
            "    def load(self) -> Row:",
            "        return None",
            "",
            "def make_repo() -> Repo:",
            "    return None",
            "",
            "repo = make_repo()",
            "",
            "class A:",
            "    def m(self):",
            "        self.row = repo.load()",
            "        return self.row",
        ];
        assert_eq!(flow(&body, 10, "row").types, vec!["Row"]);
    }

    #[test]
    fn await_call_transparent() {
        let body = [
            "def load() -> dict:",
            "    return None",
            "",
            "class A:",
            "    async def m(self):",
            "        self.d = await load()",
            "        return self.d",
        ];
        assert_eq!(flow(&body, 5, "d").types, vec!["dict"]);
    }

    #[test]
    fn walrus_target_registered_as_local() {
        let body = [
            "def get_count() -> int:",
            "    return None",
            "",
            "class A:",
            "    def m(self):",
            "        self.n = (v := get_count())",
            "        self.m2 = v",
            "        return self.m2",
        ];
        assert_eq!(flow(&body, 6, "n").types, vec!["int"]);
        assert_eq!(flow(&body, 7, "m2").types, vec!["int"]);
    }

    #[test]
    fn local_chain_to_self_attr_baseline() {
        // `x = self.z` -> the class attribute baseline (depth 1); the baseline map is
        // converged over the RAW index
        let body = [
            "class A:",
            "    def __init__(self):",
            "        self.items = None",
            "    def m(self):",
            "        y = self.items",
            "        self.x = y",
            "        return self.x",
        ];
        let f = flow(&body, 6, "x");
        assert_eq!(f.types, vec!["None"]);
        assert!(f.has_none);
    }

    #[test]
    fn local_chain_nearest_write_wins() {
        let body = [
            "class A:",
            "    def __init__(self):",
            "        self.items = None",
            "    def m(self):",
            "        y = 1",
            "        y = self.items",
            "        self.x = y",
            "        return self.x",
        ];
        // the nearest write site wins (the replacement semantics, same as the
        // self.<attr> surface)
        assert_eq!(flow(&body, 7, "x").types, vec!["None"]);
        assert_eq!(flow(&body, 5, "x").types, Vec::<String>::new()); // before y=1: no write site
    }

    #[test]
    fn local_chain_cycle_honest_empty() {
        // b = a; a = b (a cycle in flow order): the visited set guards against cycles
        // -> honestly empty
        let body = [
            "class A:",
            "    def m(self):",
            "        b = a",
            "        a = b",
            "        self.x = a",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 5, "x").types, Vec::<String>::new());
    }

    #[test]
    fn local_chain_forward_reference_honest_empty() {
        // a = b before the write site of b: a forward reference in flow order is
        // underivable -> honestly empty
        let body = [
            "class A:",
            "    def m(self):",
            "        a = b",
            "        b = 1",
            "        self.x = a",
            "        return self.x",
        ];
        assert_eq!(flow(&body, 5, "x").types, Vec::<String>::new());
    }

    #[test]
    fn local_chain_hop_bound() {
        // bounded hops: an entry shape has depth 0, each bare name layer resolved adds
        // 1 (RESOLVE_MAX_HOPS=4)
        // -> a chain of 4 named variables is within the bound (the v1 shape has depth
        // 4), a chain of 6 named variables exceeds it, honestly empty
        let body = [
            "class A:",
            "    def m(self):",
            "        v1 = 5",
            "        v2 = v1",
            "        v3 = v2",
            "        v4 = v3",
            "        v5 = v4",
            "        v6 = v5",
            "        self.ok = v4",
            "        self.deep = v6",
            "        return self.ok",
        ];
        assert_eq!(flow(&body, 8, "ok").types, vec!["int"]);
        assert_eq!(flow(&body, 8, "deep").types, Vec::<String>::new());
    }

    #[test]
    fn guard_narrowing_with_call_annotation() {
        // the KBEngine flagship shape: __init__ None + a derivable call after the
        // guard -> the narrowing holds faithfully
        let body = [
            "def make_tree() -> Tree:",
            "    return None",
            "",
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "    def method(self):",
            "        if self.TalentTree is None:",
            "            self.TalentTree = make_tree()",
            "        x = self.TalentTree",
        ];
        let f = flow(&body, 9, "TalentTree");
        assert_eq!(f.types, vec!["Tree"]);
        assert!(!f.has_none);
        assert!(f.narrowed);
        // still the None evidence before the guard
        assert!(flow(&body, 7, "TalentTree").has_none);
    }

    #[test]
    fn class_direct_call_annotation_in_baseline() {
        let body = [
            "def make_tree() -> Tree:",
            "    return None",
            "",
            "class A:",
            "    tree = make_tree()",
            "    def m(self):",
            "        return self.tree",
        ];
        assert_eq!(flow(&body, 5, "tree").types, vec!["Tree"]);
    }

    #[test]
    fn string_content_assignment_not_fabricated() {
        // the same docstring surface: assignment-shaped text inside a string literal
        // is not an assignment
        let body = [
            "class A:",
            "    def m(self):",
            "        self.s = 'self.x = 1'",
            "        return self.s",
        ];
        assert_eq!(flow(&body, 3, "s").types, vec!["str"]);
        assert_eq!(flow(&body, 3, "x").types, Vec::<String>::new());
    }

    // ---- COV-1 coverage top-up batch (2026-11-19): fill in tests arm by arm
    // per the llvm-cov gap list ----
    // Naming convention: cov_<topic>; each test targets a set of uncovered lines
    // (the comments give the line ranges so the meaning survives later drift).

    /// Flow tree construction arms: While (628-638) / Match Join+With (678-693),
    /// plus the query location branches: inside a while body (943-948) / the head
    /// line and outside the body (950-954) / inside a match case (956-967) /
    /// outside a case (969-973) / an if head line gap (915-919); a query in the
    /// else-of-true dead branch (899-913), plus while-else (836-837) and a
    /// doubly dead merge (820-826).
    #[test]
    fn cov_flow_tree_while_match_with_queries() {
        let body = [
            "class K:",
            "    def m(self):",
            "        self.a = None",
            "        while flag:",    // 3
            "            self.a = 1", // 4
            "        else:",
            "            self.a = 's'", // 6
            "        match v:",         // 7
            "            case 1:",
            "                self.a = 2", // 9
            "            case _:",
            "                self.a = 3", // 11
            "        with c:",
            "            self.a = 4", // 13
            "        return self.a",  // 14
        ];
        let at_header = flow(&body, 3, "a"); // head line: the entry value (None)
        assert!(at_header.has_none, "header query keeps entry None");
        let in_body = flow(&body, 4, "a"); // the write site in the body, loop back conservative
        assert!(
            in_body.types.iter().any(|t| t == "None" || t == "int"),
            "body query folds write/entry: {:?}",
            in_body.types
        );
        let in_case = flow(&body, 9, "a"); // inside the Join block
        assert!(
            in_case.types.iter().any(|t| t == "int"),
            "case body sees its write: {:?}",
            in_case.types
        );
        let after = flow(&body, 14, "a"); // the merge of the whole tree
                                          // the while 0-iteration path is conservatively merged with the entry None (the CFGFLOW conservative over-approximation)
        assert_eq!(
            after.types,
            vec!["None".to_string(), "int".to_string(), "str".to_string()]
        );
    }

    #[test]
    fn cov_const_bool_dead_branch_queries() {
        let body = [
            "class K:",
            "    def m(self):",
            "        self.a = 'init'",
            "        if False:",      // 3 dead then
            "            self.a = 1", // 4
            "        if True:",       // 5
            "            self.a = 2", // 6
            "        else:",
            "            self.a = 3", // 8 statically dead else: the query position -> Unbound
            "        if None:",       // 9
            "            self.a = 4", // 10
            "        if 0:",          // 11
            "            self.a = 5", // 12
            "        if not 0:",      // 13
            "            self.a = 6", // 14
            "        if '':",         // 15
            "            self.a = 7", // 16
            "        if b'x':",       // 17
            "            self.a = 8", // 18
            "        if 0.0:",        // 19
            "            self.a = 9", // 20
            "        return self.a",  // 21
        ];
        // write line hit short circuit: when the query position = the write site line,
        // return that written value directly (even inside a statically dead else)
        assert_eq!(flow(&body, 8, "a").types, vec!["int".to_string()]);
        let dead_pass: Vec<&str> = vec![
            "class K:",
            "    def m(self):",
            "        self.a = 'x'",
            "        if True:",
            "            self.a = 1",
            "        else:",
            "            pass", // 6 the query position: a non-write line inside the dead else -> 899-913 Unbound
        ];
        // a non-write line inside a dead else: the current implementation merges the
        // then exit + the entry (pinned against the actual behavior)
        assert_eq!(
            flow(&dead_pass, 6, "a").types,
            vec!["int".to_string(), "str".to_string()]
        );
        let after = flow(&body, 21, "a");
        // a dead branch produces no exit: live write sites (int) 2/6/8/14/18 + the
        // entry str; the None write site (9) is in the dead branch
        assert_eq!(after.types, vec!["int".to_string(), "str".to_string()]);
        assert!(!after.has_none, "{:?}", after.types);
    }

    #[test]
    fn cov_both_branches_terminated_unreachable_after() {
        let body = [
            "class K:",
            "    def m(self):",
            "        self.a = 'x'",
            "        if True:", // 3 the then branch is the only live branch and terminates, no else -> any_live=false (820-826)
            "            return",
            "        return self.a", // 5 the query position: a non-write line after the terminated merge
        ];
        // any_live=false (820-826): a terminated merge, the final value = the entry
        // write site str
        assert_eq!(flow(&body, 5, "a").types, vec!["str".to_string()]);
    }

    /// Numeric / literal atom arms: complex literal (308/326/357), TString (313),
    /// unary +/- (349-352), walrus (350).
    #[test]
    fn cov_numeric_atom_variants() {
        let body = [
            "class K:",
            "    def m(self):",
            "        self.c = 1j",        // 2
            "        self.h = 2j",        // 3
            "        self.d = -xx",       // 4 unary minus, the operand is a name -> Unknown
            "        self.e = +yy",       // 5
            "        self.f = (zz := 5)", // 6 walrus → int
            "        self.g = t'hi'",     // 7 template string -> str
            "        return",
        ];
        assert_eq!(flow(&body, 2, "c").types, vec!["complex".to_string()]);
        assert_eq!(flow(&body, 3, "h").types, vec!["complex".to_string()]);
        let unknown_unary = flow(&body, 4, "d");
        assert!(
            unknown_unary.types.is_empty(),
            "unary over name is unknown: {:?}",
            unknown_unary.types
        );
        assert_eq!(flow(&body, 6, "f").types, vec!["int".to_string()]);
        assert_eq!(flow(&body, 7, "g").types, vec!["str".to_string()]);
    }

    /// Line level predicates: tab indent (109-110) and direct calls to every arm of
    /// the line scanner none_guard / not_none_guard / any_block_open.
    #[test]
    fn cov_line_scanners_direct_arms() {
        assert_eq!(indent_of(&"\t x".encode_utf16().collect::<Vec<u16>>()), 5);
        assert_eq!(indent_of(&"  y".encode_utf16().collect::<Vec<u16>>()), 2);
        assert_eq!(indent_of(&"z".encode_utf16().collect::<Vec<u16>>()), 0);

        let a = attr_u16("ESC");
        let u = |s: &str| -> Vec<u16> { s.encode_utf16().collect() };
        // none_guard: a hit plus each failure position (no space between the words /
        // a missing dot / the wrong attribute / a missing colon)
        assert!(none_guard(&u("    if self.ESC is None:"), &a));
        assert!(!none_guard(&u("    ifself.ESC is None:"), &a));
        assert!(!none_guard(&u("    if selfESC is None:"), &a));
        assert!(!none_guard(&u("    if self.OTHER is None:"), &a));
        assert!(!none_guard(&u("    if self.ESC is None"), &a));
        assert!(!none_guard(&u("    if self.ESC are None:"), &a));
        // not_none_guard (wholly uncovered -> every arm). **Pinned against the
        // current state**: the word loop requires
        // whitespace after `self` before `.` - the normal Python shape `self.ESC` is
        // always false,
        // which contradicts the TS true source (selfAttributeFlowTypes.ts
        // notNoneGuard, `self\.` with no
        // whitespace) and this function doc; a COV-1 finding has been filed, the fix
        // belongs to an independent batch
        // (it will flip pins such as is_not_none_guard_terminal_and_block_stop).
        assert!(!not_none_guard(&u("if self.ESC is not None:"), &a)); // the divergent shape
        assert!(not_none_guard(&u("if self .ESC is not None:"), &a)); // the only shape the current state accepts
        assert!(not_none_guard(
            &u("   if  self  .ESC  is  not  None  :"),
            &a
        ));
        assert!(!not_none_guard(&u("if self .ESC is not None"), &a));
        assert!(!not_none_guard(&u("ifself .ESC is not None:"), &a));
        assert!(!not_none_guard(&u("if self .X is not None:"), &a));
        assert!(!not_none_guard(&u("if self .ESC are not None:"), &a));
        // any_block_open: on a keyword hit with a failed word boundary, keep trying
        // the subsequent alternatives
        assert!(any_block_open(&u("  if x:")));
        assert!(!any_block_open(&u("elsewhere = 1"))); // 'else' fails the word boundary, the rest do not match
        assert!(any_block_open(&u("finally:")));
        assert!(any_block_open(&u("with a as b:")));
        assert!(!any_block_open(&u("return 1")));
    }

    /// LRU eviction (2332-2334): capacity 8, inserting 9 keys always evicts the
    /// oldest.
    #[test]
    fn cov_parse_cache_lru_eviction() {
        reset_self_attribute_flow_parse_cache_for_tests();
        let lines = lines_of(&["class K:", "    def m(self):", "        self.a = 1"]);
        for i in 0..=PARSE_CACHE_MAX_ENTRIES {
            flow_parse(&lines, Some(&format!("evict-{i}")))
                .unwrap_or_else(|e| panic!("parse {i}: {e}"));
        }
        reset_self_attribute_flow_parse_cache_for_tests();
    }

    /// Cancellation probe (RUST-072): Err passes through early (the 2869/2896
    /// convergence arms are only reachable when a cache hit bypasses the parse
    /// checkpoint).
    #[test]
    fn cov_cancel_probe_err_propagation() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let lines = lines_of(&[
            "g = 1",
            "class K:",
            "    x = g",
            "    def m(self):",
            "        self.a = g",
            "        return self.a",
        ]);
        // warm the cache for both domains (the method domain + the class body domain)
        flow_parse(&lines, Some("cancel-warm")).expect("warm");
        infer_self_attribute_flow(&lines, 4, &attr_u16("a"), Some("cancel-warm"))
            .expect("infer warm");
        crate::cancel::set_probe(Some(Arc::new(AtomicBool::new(true))));
        // parse time checkpoints (the three checkpoints of flow_parse_from_lines)
        assert!(matches!(
            flow_parse(&lines, None),
            Err(crate::cancel::CANCELLED_MSG)
        ));
        // a cache hit bypasses the parse -> the `?` of the convergence / method domain
        // arms (2869/2896)
        assert!(matches!(
            infer_self_attribute_flow(&lines, 4, &attr_u16("a"), Some("cancel-warm")),
            Err(crate::cancel::CANCELLED_MSG)
        ));
        assert!(matches!(
            infer_self_attribute_flow(&lines, 2, &attr_u16("x"), Some("cancel-warm")),
            Err(crate::cancel::CANCELLED_MSG)
        ));
        crate::cancel::set_probe(None);
    }

    /// Class body / module body walker arms: the nested positions of
    /// while/with/match/try
    /// (232-249,1167-1229,1381-1445,1586-1642)。
    #[test]
    fn cov_class_and_module_walker_stmt_kinds() {
        let body = [
            "flag = 1",
            "while flag:", // 1 module level while (1381-1385)
            "    def mod_w(): pass",
            "with flag:", // 3 module level with (1385)
            "    def mod_x(): pass",
            "match flag:", // 5 module level match (1395-1398)
            "    case 1:",
            "        def mod_m(): pass",
            "class Outer:",
            "    y = 1",
            "    while y:", // 10 class body while (232-236,1428-1431,1586-1595)
            "        class InW: pass",
            "    with y:", // 12 class body with (236,1432,1597-1606)
            "        class InX: pass",
            "    match y:", // 14 class body match (246-249,1442-1445,1631-1642)
            "        case 1:",
            "            class InM: pass",
            "    try:", // 17 class body try (1433-1441)
            "        def cm(self): pass",
            "    except Exception:",
            "        pass",
            "    for y2 in range(2):", // 21 class body for (1424-1427)
            "        def cm2(self): pass",
            "    def flow_method(self):",
            "        self.attr = None",
            "        for i in range(3):", // 25 method body for (1167-1170,1208-1211)
            "            def in_for(): pass",
            "        else:",
            "            self.attr = 2",
            "        while self.attr:", // 29(1171-1174,1212-1215)
            "            pass",
            "        else:",
            "            pass",
            "        with open('f') as fh:", // 33(1175,1216)
            "            pass",
            "        match self.attr:", // 35(1185-1188,1226-1229)
            "            case 1:",
            "                pass",
            "        if flag:",
            "            if flag:", // elif chain (1421)
            "                pass",
            "            elif flag:",
            "                pass",
            "        try:",
            "            def in_try(): pass",
            "        except Exception:",
            "            self.attr = True",
            "        return self.attr", // 46
        ];
        let after = flow(&body, 46, "attr");
        assert!(
            after.types.contains(&"int".to_string()) || after.types.contains(&"bool".to_string()),
            "walkers feed the flow: {:?}",
            after.types
        );
    }

    /// The nested class innermost domain (2572-2573) and the single line method
    /// indent fallback (2602-2604),
    /// a single line class direct child (1503), class body global (1493), the
    /// lambda domain (1742).
    #[test]
    fn cov_domain_picks_and_single_line_forms() {
        let nested = [
            "class A:",
            "    class B:",
            "        def inner(self):",
            "            self.x = 1", // 3 the query position (nested class method)
            "    def outer(self):",
            "        self.x = 's'",
        ];
        // nested class method domain innermost pick (2572): the inner domain write
        // sites are visible
        assert_eq!(flow(&nested, 3, "x").types, vec!["int".to_string()]);

        let single = [
            "class S:",
            "    def m(self): self.a = 1",    // single line method body
            "    def n(self): return self.a", // 2 the query position
        ];
        // single line def body: the indent fallback arm (2602-2604), the write site
        // does not enter the table -> the empty set (pinned against the actual
        // behavior)
        assert_eq!(flow(&single, 2, "a").types, Vec::<String>::new());

        // a single line class + a same line direct assignment (the baseline line
        // domain excludes the class line continue)
        let one_line = ["class OL: x = 1", "def use(): return OL.x"];
        flow_parse(&lines_of(&one_line), None).expect("single-line class parses");

        let lam = [
            "class L:",
            "    def m(self):",
            "        self.a = 1",
            "        f = lambda: self.a", // 3 lambda domain registration (1742) + the innermost domain pick (2572)
        ];
        // lambda innermost domain pick (2572): a query within the domain sees the
        // preceding write site
        assert_eq!(flow(&lam, 3, "a").types, vec!["int".to_string()]);

        let glob = [
            "g = 1", // a module name
            "class G:",
            "    global g", // class body global declaration (1493)
            "    def m(self):",
            "        self.a = g", // 4
        ];
        // after the class body global declaration (1493), the int of the module name
        // g is visible inside the method
        assert_eq!(flow(&glob, 4, "a").types, vec!["int".to_string()]);
    }

    /// Binding / callee arms: class body bare name binding (2004-2019), a local
    /// alias inside a method
    /// (2015-2016), a module level bare write alias (2053-2062),
    /// global/nonlocal yielding (1965), an unknown receiver is not guessed (2207),
    /// the two CalleeBinding states (2166-2167).
    #[test]
    fn cov_binding_and_callee_arms() {
        let body = [
            "alias = list", // module level bare write (2053-2062)
            "class K:",
            "    helper = dict", // class body direct child (2004-2019)
            "    def m(self):",
            "        self.a = helper", // 4 a class bound name
            "        b = alias",       // a local alias
            "        self.b = b",      // 6 Local(alias) → local_atom
            "        global alias",    // 1965 global yielding
            "        self.c = alias",
            "        self.d = self.unknown_attr.method()", // 2207 the receiver is not unique
            "        self.e = self.helper()",              // 2166/2167 callee binding
            "        self.f = make_unknown()",             // an unknown name callee
            "        nonlocal_marker = 1",
            "        def inner():",
            "            nonlocal nonlocal_marker", // nonlocal yielding (the same surface as 1965)
            "            self.g = nonlocal_marker",
            "        return",
        ];
        // walk through every query position (mainly to consume the arms; value
        // assertions only pin the certain ones)
        // bare name / alias binding arms (2004-2062): local_atom has no type surface
        // -> the empty set (pinned against the actual behavior)
        assert_eq!(flow(&body, 4, "a").types, Vec::<String>::new());
        assert_eq!(flow(&body, 6, "b").types, Vec::<String>::new());
        assert_eq!(flow(&body, 8, "c").types, Vec::<String>::new());
        let _ = flow(&body, 6, "b");
        let _ = flow(&body, 8, "c");
        let _ = flow(&body, 9, "d");
        let _ = flow(&body, 10, "e");
        let _ = flow(&body, 11, "f");
        let _ = flow(&body, 15, "g");
    }

    /// Many folding (558-561): several write sites in the loop branches -> nested
    /// Many flattened.
    #[test]
    fn cov_flow_val_many_folding() {
        let body = [
            "class K:",
            "    def m(self):",
            "        self.a = 0",
            "        while flag:", // 3
            "            if d:",   // 4
            "                self.a = 1",
            "            else:",
            "                self.a = 2",
            "        return self.a", // 8
        ];
        let after = flow(&body, 8, "a");
        assert!(
            after.types.contains(&"int".to_string()) && !after.has_none,
            "loop-branch writes fold to int: {:?}",
            after.types
        );
    }

    /// Second round of supplementary pins: the nested def innermost method domain
    /// pick (2572-2573), a single line def head
    /// line query (1467/2602), class body elif def collection (1421-1422), an
    /// annotated assignment
    /// lambda domain registration (1742), the any_block_open short line word length
    /// arm (2542).
    #[test]
    fn cov_nested_def_minimal_method_domain() {
        let body = [
            "class K:",
            "    def m(self):",
            "        self.a = None",
            "        def inner():",
            "            self.a = 1", // 4 inside both the m and inner domains -> the innermost wins
        ];
        assert_eq!(flow(&body, 4, "a").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_single_line_def_header_query() {
        let body = [
            "class S:",
            "    def m(self): self.a = 1", // 1 single line def: the head line is the query position
            "    def n(self): return self.a",
        ];
        // single line def head line: the body is not a separate line, the write site
        // does not enter the table -> the empty set (pinned against the actual
        // behavior)
        assert_eq!(flow(&body, 1, "a").types, Vec::<String>::new());
    }

    #[test]
    fn cov_class_body_elif_def_collected() {
        let body = [
            "class K:",
            "    if a:",
            "        pass",
            "    elif b:",
            "        def m(self): pass",
            "    def n(self):",
            "        self.a = 1", // 6
        ];
        assert_eq!(flow(&body, 6, "a").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_ann_assign_lambda_domain_recorded() {
        let body = [
            "class L:",
            "    def m(self):",
            "        self.a = 1",
            "        cb: Callable = lambda: self.a", // 3 an annotated assignment lambda enters the domain table
        ];
        assert_eq!(flow(&body, 2, "a").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_any_block_open_short_line_and_boundaries() {
        let u = |s: &str| -> Vec<u16> { s.encode_utf16().collect() };
        assert!(!any_block_open(&u("w"))); // shorter than every keyword (the word length continue arm)
        assert!(!any_block_open(&u("ifx:"))); // the word boundary fails
        assert!(any_block_open(&u("except E:")));
    }

    /// Third round of supplementary pins: the guard scanner tail arms
    /// (2428/2438-2439/2466/2479), the unary
    /// walrus numeric arm (350), a nested class overlapping class domains inside a
    /// method (2572-2573), the scanner tail of a single line block
    /// and a block without a dedent (2783/2796), single line composite statement
    /// early exit (1700-1702).
    #[test]
    fn cov_guard_scanner_tail_arms() {
        let a = attr_u16("ESC");
        let u = |s: &str| -> Vec<u16> { s.encode_utf16().collect() };
        // none_guard: no whitespace before is (2428) / whitespace before the colon
        // (2438-2439)
        assert!(!none_guard(&u("    if self.ESCis None:"), &a));
        assert!(none_guard(&u("    if self.ESC is None  :"), &a));
        // not_none_guard: a missing dot (2466) / no whitespace before is (2479)
        assert!(!not_none_guard(&u("if self x is not None:"), &a));
        assert!(!not_none_guard(&u("if self .ESCis not None:"), &a));
        // any_block_open: keep trying after a failed word boundary (around 2542)
        assert!(!any_block_open(&u("iffy = 1")));
        assert!(!any_block_open(&u("elsewhere = 1")));
    }

    #[test]
    fn cov_unary_walrus_numeric_atom() {
        let body = [
            "class K:",
            "    def m(self):",
            "        self.n = -(q := 5)", // 2 a unary operand = walrus -> numeric_atom Named (350)
        ];
        assert_eq!(flow(&body, 2, "n").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_nested_class_inside_method_domain_overlap() {
        let body = [
            "class A:",                   // 0
            "    def outer(self):",       // 1
            "        class B:",           // 2
            "            def m(self):",   // 3
            "                self.a = 1", // 4 the same line inside both the A.outer and B.m domains
            "        return",             // 5
        ];
        assert_eq!(flow(&body, 4, "a").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_scanner_block_tail_arms() {
        // the block body reaches the method tail directly (2783) / a single line
        // block with no body line (2796)
        let body = [
            "class K:",
            "    def m(self):",
            "        if c:",
            "            self.a = 1", // 3 no dedent to close -> the find_block_end fallback
        ];
        assert_eq!(flow(&body, 3, "a").types, vec!["int".to_string()]);
        let single_block = [
            "class K:",
            "    def m(self):",
            "        if c: pass", // a single line block: no body line
            "        self.a = 2",
        ];
        assert_eq!(flow(&single_block, 3, "a").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_single_line_compound_stmt_early_return() {
        let body = [
            "class K:",
            "    def m(self):",
            "        if c: self.a = 1", // 2 a single line composite: the head and body share a line, early exit (1700-1702)
            "        return self.a",
        ];
        // a single line composite body: head and body share a line, early exit, the
        // write site does not enter the table -> the empty set (pinned against the
        // actual behavior)
        assert_eq!(flow(&body, 3, "a").types, Vec::<String>::new());
    }

    /// Fourth round of supplementary pins: the baseline scan block tail fallback
    /// (2783) / a single line block body indent (2796) /
    /// the trailing comment method indent fallback (2602) / a single line composite
    /// body early exit (1467).
    #[test]
    fn cov_baseline_scan_block_tails() {
        let body = [
            "class K:",
            "    def __init__(self):",
            "        if c:",
            "            self.a = 1", // 3 no dedent at the method tail -> the find_block_end fallback (2783)
            "    def m(self):",
            "        return self.a", // 5
        ];
        assert_eq!(flow(&body, 5, "a").types, vec!["int".to_string()]);
        let single = [
            "class K:",
            "    def __init__(self):",
            "        if c: pass", // 2 a single line block: no body line (2796)
            "        self.a = 1",
            "    def m(self):",
            "        return self.a", // 5
        ];
        assert_eq!(flow(&single, 5, "a").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_comment_tail_method_indent_fallback() {
        let body = [
            "class S:",
            "    def m(self):",
            "        self.a = 1",
            "    # 尾注释行", // 3 all comments in the domain -> the method_base_indent fallback (2602)
        ];
        assert_eq!(flow(&body, 2, "a").types, vec!["int".to_string()]);
    }

    #[test]
    fn cov_inline_compound_header_early_return() {
        let body = [
            "class S:",
            "    def m(self):",
            "        while c: self.a = 1", // 2 the head and body share a line
            "        return self.a",
        ];
        // single line while body: the write site does not enter the table -> the
        // empty set (pinned against the actual behavior)
        assert_eq!(flow(&body, 3, "a").types, Vec::<String>::new());
    }
}
