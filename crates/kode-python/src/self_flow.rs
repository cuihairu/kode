//! LANG-NAR-1 语义引擎流敏感窄化(RUST-MIGRATION-AUDIT-006 B1 车道批 1)。
//!
//! TS `src/backend/selfAttributeFlowTypes.ts`(567 行)移植:行扫描器/守卫/
//! 类型推导段逐字保真;类跨度提取段在精确性主车道批 A 换道 ruff AST
//! (class_spans_from_ast)——域正确性升级(嵌套类/条件 def 真域、未闭合
//! 文件不再吞尾),行扫描语义仍以 TS 引擎为基准(平铺文件跨度等值,见
//! ClassSpan 注)。TS 引擎冻结为杀开关兜底,不再作字节对拍基准(输出
//! 合法变好,split-parity:未触及维度保留深等,升级维度精度断言)。
//!
//! 移植口径(逐字对齐要点):
//! - 全程 UTF-16 码元(与 JS 字符串索引同基底);行走查器吃调用方原样行
//!   (inlay 路原文/诊断路掩码行,Rust 不二次掩码——与 TS 纯函数同契约);
//! - 类跨度路径 = 行 join('\n') → UTF-8 → ruff 容错解析(部分 AST,半成品
//!   文件尽力产出)→ AST 走查产 ClassSpan{name,start_line,end_line,
//!   method_lines:名→def 名行,method_domains:真实体域}。装饰器不计行号
//!   (ruff class/def range 含 @ 前缀,取 name.range 起点校正);end_line=
//!   语句末字符行+1(排他);嵌套类自成一个 ClassSpan、类体控制块内 def
//!   仍归类(与旧展平口径同员),def 体内不下行(与旧 scope.function 同员);
//! - 正则全部手工展开成扫描器,左优先交替 + 回溯语义逐字保真
//!   (anyBlockOpen 的 `else` 命中后词边界失败不换关键字的 JS 行为等);
//!   `\s` 取 JS 全类(含  /　/﻿ 等),`\w` = `[A-Za-z0-9_]`;
//! - 类型集合 BTreeSet(输出恒排序,与 TS `[...set].sort()` 等值;非 BMP
//!   码点排序差 = 字节序 vs UTF-16 码元序,类型原子皆 ASCII 不触);
//! - `SelfAttributeFlowOptions` 回调面不在 RPC 契约(生产恒 undefined),
//!   Rust 无此参数——调用/裸名解析恒空集(与生产 TS 行为一致);
//! - KODE-PERF-001 版本键 LRU 解析缓存:max=8 触碰移尾/逐最旧,键=TS 传来的
//!   不透明字符串(flowVersionKeyForDocument 产物);无键=现解析不缓存(纯函数
//!   回退逐字节一致)。缓存值只存引擎所需的类跨度(与 TS 缓存整份
//!   ParsedPythonFile 对引擎行为等值)。
//!
//! 诚实边界:类型以原子注解字符串集合表示,推不出即空集(不硬造 Any)。

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use crate::parse::ParsedAst;
use ruff_python_ast as ast;
use ruff_text_size::Ranged;

/// 版本键 LRU 容量(TS PARSE_CACHE_MAX_ENTRIES = 8)
pub const PARSE_CACHE_MAX_ENTRIES: usize = 8;

// ---- 基础字符类(JS 语义) --------------------------------------------------

/// JS `\s` 全类(码元):\t \n \v \f \r 空格      -
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

/// JS 行终止符(`.` 排除集;行内孤立 `\r`/U+2028/U+2029 使 `.+/$` 形失配)
pub(crate) fn is_js_line_terminator(code: u16) -> bool {
    matches!(code, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// TS 词首字符类 `[A-Za-z_]`(不含数字)
pub(crate) fn is_name_start(code: u16) -> bool {
    code == 0x5F || (0x41..=0x5A).contains(&code) || (0x61..=0x7A).contains(&code)
}

/// TS `\w` = `[A-Za-z0-9_]`
pub(crate) fn is_word(code: u16) -> bool {
    is_name_start(code) || (0x30..=0x39).contains(&code)
}



// ---- pythonCodeLines 掩码(pythonParser.ts:26-51 逐字移植) -----------------

/// `content.split(/\r?\n/)`(尾随 `\r` 剥离)。attributeNone 诊断面复用:
/// 掩码文本行数组与 TS `maskedText.split(/\r?\n/)` 同法。
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

// ---- 行基础判定(行扫描器/AST 跨度共用) ------------------------------------

/// 行首 `[ \t]*` 缩进(tab 计 4)
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

/// `^\s*$`(JS \s 全类)
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

// ---- 类跨度提取(ruff AST 派生;精确性主车道批 A) --------------------------

/// 方法真实体域(0 起,含尾):def 名行 .. def 语句末字符行。
#[derive(Debug, Clone)]
pub struct MethodDomain {
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
}

/// 类跨度(引擎所需字段;TS methods 的 character 列引擎不读,不移植)
#[derive(Debug, Clone)]
pub struct ClassSpan {
    pub name: String,
    /// 0 起起始行(class 名行;装饰器不计——ruff range 含 @ 前缀,名行校正)
    pub start_line: usize,
    /// 0 起结束行(不含)= 类语句末字符行 + 1(尾随空行/注释不再计入类;
    /// 未闭合到 EOF 时自然收敛于文末)
    pub end_line: usize,
    /// 方法名 → 0 起 def 名行(同名后者覆盖,与旧 HashMap 语义一致)
    pub method_lines: HashMap<String, usize>,
    /// 方法真实体域(enclosing_method 内含最小域者胜;嵌套类/条件 def 归属修正)
    pub method_domains: Vec<MethodDomain>,
}

/// 语句末字符所在行(0 起;range end 为排他字节 offset,容错空 range 饱和回退)。
fn last_char_line(ast: &ParsedAst, range: ruff_text_size::TextRange) -> usize {
    ast.line_col(range.end().to_u32().saturating_sub(1)).0
}

/// 类跨度 = ruff 容错解析后的 AST 走查(半成品文件尽力产出部分跨度)。
pub fn class_spans_from_ast(ast: &ParsedAst) -> Vec<ClassSpan> {
    let mut classes: Vec<ClassSpan> = Vec::new();
    walk_class_scopes(ast, &ast.module().body, None, &mut classes);
    classes
}

/// 作用域走查:类体直系 + 控制块内 def 仍归属当前类(与旧展平口径同员);
/// def 体内不下行(函数内类/方法不入表,与旧 scope.function 口径同员);
/// 嵌套类自成一个 ClassSpan(其方法归嵌套类,不归外层类)。
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

// ---- 赋值类型索引(精确性主车道批 B:typeOfExpr AST 化) ---------------------

/// 赋值类型索引:键 = (0 起起始行, 目标名),值 = RHS(或无值注解)类型集合。
/// 「键在、值空」= 赋值成立但类型推不出(替换语义:空集覆盖旧值=诚实未知);
/// 「键不在」= 该行无此目标赋值(状态保留)。两义必须分开承载。
#[derive(Debug, Clone, Default)]
pub struct AssignmentTypes {
    map: HashMap<(usize, String), TypeSet>,
}

impl AssignmentTypes {
    fn insert(&mut self, line: usize, name: &str, types: TypeSet) {
        self.map.insert((line, name.to_string()), types);
    }

    /// attr 以 UTF-16 码元查询(与行扫描器同一目标形态)。
    fn get(&self, line: usize, name: &[u16]) -> Option<&TypeSet> {
        let key = String::from_utf16(name).ok()?;
        self.map.get(&(line, key))
    }
}

/// 类体直系赋值索引(基线面):键 = (类起始行, 行, 名)。带类身份——嵌套类
/// 直系条目不进外层类基线(旧引擎靠缩进过滤排除,AST 面以身份键同语义)。
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

/// 表达式类型(字面量面;ruff AST 节点直接推导)。
/// None/bool/int/float/complex/str(bytes/f/t 串分型)/list/set/dict/tuple/
/// ellipsis;walrus→内层;数值/逻辑一元;其余(调用/属性链/裸名/二元运算/
/// 推导式/lambda/ternary)→ 空集(不硬造;调用与裸名归批 C)。
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
                // -x/+x 保型;bool 经 -/+ 落 int(-True == -1);其余不造
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

/// 数值一元操作数分类(直接按 AST 形态;括号被 ruff 剥除,walrus 取内层,
/// 嵌套 +/- 继续下钻)。
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

/// 注解文本原子:源文本按节点字节区间切片 + trim(与旧「`[^=#]+?` 捕获
/// trim」口径一致——引号注解带引号、联合注解整串一个原子);空串不产原子。
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

/// 批 C:in-file 调用/裸名推导(补可推导真值)。RHS 不再止步字面量:
/// - 同文件模块级 def `-> T` 注解(`name(...)` 直取;重名歧义=未知,不取首定义硬猜);
/// - `A.m(...)` 类限定方法注解(同类名多个=歧义不猜);`self.m(...)` 所在类限定;
/// - 链式 `recv.m(...)`:接收者可推导出唯一原子且恰为同类名时取该方法注解;
/// - 方法域内局部裸名赋值链(最近写点胜=替换语义,有界跳数 + visited 防环);
/// - `self.z` 读 → 类属性基线(批 B 收敛基线图,RAW 索引上算,备忘录防重算);
/// - await 壳透明;walrus 目标登记为局部写点(顶层/元素级,更深层诚实漏)。
///
/// 诚实边界:无注解/未知 callee/环/越域 → 空集,绝不猜。
const RESOLVE_MAX_HOPS: usize = 4;

/// 模块级 def 返回注解:Single(注解或无)= 唯一定义;Ambiguous = 同名多个。
#[derive(Debug, Clone)]
pub(crate) enum DefReturn {
    Single(Option<String>),
    Ambiguous,
}

#[derive(Debug, Clone)]
pub(crate) enum CalleeShape {
    /// f(...)
    Name(String),
    /// A.m(...)
    Qualified { class: String, method: String },
    /// self.m(...) —— 所在类限定
    SelfMethod(String),
    /// <expr>.m(...) —— 接收者推导出唯一同类名时取该方法注解
    Chained { receiver: Box<RhsShape>, method: String },
}

/// RHS 形态快照(owned;AST 在解析派生后即弃,只留可推导面)。
#[derive(Debug, Clone)]
pub(crate) enum RhsShape {
    /// 字面量面(批 B)已定型
    Typed(TypeSet),
    Call(CalleeShape),
    /// self.z 读 → 类属性基线
    SelfAttr(String),
    /// 局部裸名(方法域内最近写点链)
    Local(String),
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum EntryKind {
    SelfAttr,
    ClassDirect,
}

/// 批 D localReturnType 面:裸名写点全域表条目(模块/类体/方法体三域同表,
/// 面查询按 matchingAssignments 域门自筛;shape 为 owned 快照)。
#[derive(Debug, Clone)]
pub(crate) struct BareWrite {
    pub(crate) line: usize,
    pub(crate) shape: RhsShape,
    /// 写点所在类(方法体写点;类体直系=该类;模块层=None)
    pub(crate) class_start: Option<usize>,
    pub(crate) method_start: Option<usize>,
}

#[derive(Debug, Clone)]
struct DeferredEntry {
    kind: EntryKind,
    line: usize,
    name: String,
    /// 注解原子(AnnAssign;`X: T` 无值也成立)
    ann: Option<String>,
    value: RhsShape,
    class_start: Option<usize>,
    method_start: Option<usize>,
}

#[derive(Debug, Default)]
struct BuildContext {
    entries: Vec<DeferredEntry>,
    /// 方法域内局部裸名写点:(方法起始行, 名) → [(行, RHS 形态)](源序追加)
    locals: HashMap<(usize, String), Vec<(usize, RhsShape)>>,
    /// 批 D localReturnType 面:裸名写点全域表(名 → 源序写点,三域同表)
    bare_writes: HashMap<String, Vec<BareWrite>>,
    /// def/class 名行集合(域门窄化素材;装饰器不计,与名行口径同)
    header_lines: HashSet<usize>,
    /// 模块级 def `-> T` 表
    def_returns: HashMap<String, DefReturn>,
    /// 类名 → 类名行(同名多个 = 歧义源)
    class_names: HashMap<String, Vec<usize>>,
    /// 类名行 → 方法名 → return 注解收集(>1 个同名方法 = 歧义)
    class_methods: HashMap<usize, HashMap<String, Vec<Option<String>>>>,
}

/// RHS 形态抽取:字面量定型优先(批 B),其余按调用/属性/裸名形态留 owned 快照;
/// await 壳透明(括号已被 ruff 剥除)。
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
                    // self 接收者先行判(self 是 Name,先查接收者再归类限定)
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

/// RHS 内 walrus 目标登记为局部写点(顶层 Named + 元组/列表元素 + await 内层;
/// 更深层嵌套诚实漏,不入链)。
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

/// 全模块赋值走查:收集条目快照(方法级 `self.<attr>` 面 + 类体直系裸名面,
/// 类身份键=类名行——装饰器不计,与 ClassSpan.start_line 同口径)+ 模块级 def/
/// 类名/类方法表/局部写点。同行复合语句头的体不收集(`if c: self.x = 1` 依
/// 条件执行,扫描按行序把它当普通行——与旧引擎「行首非 self 不匹配」同语义)。
/// 收集期产物全量表格(流面与 localReturnType 面同源消费;批 D 起
/// assignments_from_ast 一并交还,FlowParse 携带)。
struct FlowTables {
    assignments: AssignmentTypes,
    class_direct: ClassAssignmentTypes,
    locals: HashMap<(usize, String), Vec<(usize, RhsShape)>>,
    def_returns: HashMap<String, DefReturn>,
    class_names: HashMap<String, Vec<usize>>,
    class_methods: HashMap<usize, HashMap<String, Vec<Option<String>>>>,
    bare_writes: HashMap<String, Vec<BareWrite>>,
    header_lines: HashSet<usize>,
}

fn assignments_from_ast(ast: &ParsedAst, lines: &[Vec<u16>], classes: &[ClassSpan]) -> FlowTables {
    let mut ctx = BuildContext::default();
    // 模块级 def `-> T` 表(控制块内的模块级 def 同员;类/函数体内不入)
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

    // RAW(字面量面)索引:基线图与防环推导都以它为底(推导不叠加推导,
    // 保证基线与条目解耦、无解析顺序依赖)
    let mut raw = AssignmentTypes::default();
    let mut raw_direct = ClassAssignmentTypes::default();
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

    // 推导期:非字面量形态按上下文解析(基线图备忘录/方法表/局部链)
    let mut state = ResolveState {
        lines,
        classes,
        locals: &ctx.locals,
        def_returns: &ctx.def_returns,
        class_names: &ctx.class_names,
        class_methods: &ctx.class_methods,
        bare_writes: &ctx.bare_writes,
        raw: &raw,
        raw_class_direct: &raw_direct,
        baseline_memo: HashMap::new(),
    };
    let mut final_map = AssignmentTypes::default();
    let mut final_direct = ClassAssignmentTypes::default();
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
    FlowTables {
        assignments: final_map,
        class_direct: final_direct,
        locals: ctx.locals,
        def_returns: ctx.def_returns,
        class_names: ctx.class_names,
        class_methods: ctx.class_methods,
        bare_writes: ctx.bare_writes,
        header_lines: ctx.header_lines,
    }
}

/// 模块级 def 收集(控制块内同员;类/函数体内 def 不入裸名调用表)。
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

/// 类体方法表收集(控制块内 def 同员=批 A 成员口径;嵌套类/嵌套函数不入)。
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
        let start_line = stmt_start_line(ast, stmt.range());
        if header_line == Some(start_line) {
            continue; // 同行复合语句体的赋值不收集(条件执行不硬套)
        }
        match stmt {
            ast::Stmt::Assign(a) => index_assign(ast, a, None, ctx, class_start, method_start),
            ast::Stmt::AnnAssign(a) => {
                index_ann_assign(ast, a, None, ctx, class_start, method_start)
            }
            ast::Stmt::ClassDef(cls) => {
                // 类身份 = 类名行(装饰器不计;与 ClassSpan.start_line 同口径,
                // 基线查找才能命中)
                let cls_line = ast.line_col(cls.name.range.start().to_u32()).0;
                ctx.header_lines.insert(cls_line);
                ctx.class_names
                    .entry(cls.name.id.to_string())
                    .or_default()
                    .push(cls_line);
                let mut methods = HashMap::new();
                collect_class_methods(ast, &cls.body, &mut methods);
                ctx.class_methods.insert(cls_line, methods);
                // 类体直系裸名赋值/注解 → class_direct(基线面);嵌套块与
                // 嵌套类体内不入(与旧基线「类体缩进直系行」同域)。
                for direct in &cls.body {
                    let line = stmt_start_line(ast, direct.range());
                    if line == start_line {
                        continue; // `class A: x = 1` 同行直系:基线行域不含类行
                    }
                    match direct {
                        ast::Stmt::Assign(a) => {
                            index_assign(
                                ast,
                                a,
                                Some(cls_line),
                                ctx,
                                Some(cls_line),
                                None,
                            );
                        }
                        ast::Stmt::AnnAssign(a) => {
                            index_ann_assign(ast, a, Some(cls_line), ctx, Some(cls_line), None);
                        }
                        _ => {}
                    }
                }
                // 递归方法体/控制块/嵌套类(直系已在上面收过;此处再走以
                // self.<attr>/嵌套类面继续——类体直系裸名不会重复入表)
                walk_assignments(ast, &cls.body, Some(start_line), ctx, Some(cls_line), None);
            }
            ast::Stmt::FunctionDef(fun) => {
                let fun_line = ast.line_col(fun.name.range.start().to_u32()).0;
                ctx.header_lines.insert(fun_line);
                walk_assignments(ast, &fun.body, Some(start_line), ctx, class_start, Some(fun_line));
            }
            ast::Stmt::If(s) => {
                walk_assignments(ast, &s.body, Some(start_line), ctx, class_start, method_start);
                for clause in &s.elif_else_clauses {
                    let clause_line = stmt_start_line(ast, clause.range);
                    walk_assignments(ast, &clause.body, Some(clause_line), ctx, class_start, method_start);
                }
            }
            ast::Stmt::For(s) => {
                walk_assignments(ast, &s.body, Some(start_line), ctx, class_start, method_start);
                walk_assignments(ast, &s.orelse, None, ctx, class_start, method_start);
            }
            ast::Stmt::While(s) => {
                walk_assignments(ast, &s.body, Some(start_line), ctx, class_start, method_start);
                walk_assignments(ast, &s.orelse, None, ctx, class_start, method_start);
            }
            ast::Stmt::With(s) => {
                walk_assignments(ast, &s.body, Some(start_line), ctx, class_start, method_start);
            }
            ast::Stmt::Try(s) => {
                walk_assignments(ast, &s.body, Some(start_line), ctx, class_start, method_start);
                for h in &s.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    let handler_line = stmt_start_line(ast, inner.range);
                    walk_assignments(ast, &inner.body, Some(handler_line), ctx, class_start, method_start);
                }
                walk_assignments(ast, &s.orelse, None, ctx, class_start, method_start);
                walk_assignments(ast, &s.finalbody, None, ctx, class_start, method_start);
            }
            ast::Stmt::Match(s) => {
                for case in &s.cases {
                    let case_line = stmt_start_line(ast, case.range);
                    walk_assignments(ast, &case.body, Some(case_line), ctx, class_start, method_start);
                }
            }
            _ => {}
        }
    }
}

/// Assign 收集:目标 Attribute(self.<attr>) → 方法级面;裸名/元组解包目标
/// (仅类体直系语境)→ class_direct 面。单 Tuple 目标与等长 Tuple 值逐位配对
/// (`self.x, self.y = 1, 2`;可推导真值);否则全目标共享 RHS 推导(推不出=
/// 空集替换)。
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
    // 元组解包配对:单 Tuple 目标 × 等长 Tuple 值,无 starred 元素
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
                    for (target, value) in target_tuple.elts.iter().zip(value_tuple.elts.iter()) {
                        push_entry(
                            line,
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
    for target in &a.targets {
        push_entry(line, target, None, shape.clone(), direct_class, class_start, method_start, ctx);
    }
}

/// AnnAssign 收集:注解文本原子 +(有值时)RHS 推导;无值注解 = 声明知识
/// (与类级 `X: T` 旧口径同语义)。
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
            rhs_shape(v)
        }
        None => RhsShape::Typed(TypeSet::new()),
    };
    push_entry(line, &a.target, ann, value_shape, direct_class, class_start, method_start, ctx);
}

/// 条目落表:`self.<attr>` → 方法级面(类语境=所在类,方法语境=所在方法);
/// 裸名(仅类体直系语境)→ class_direct。其余目标(下标/starred/切片等)不收集。
#[allow(clippy::too_many_arguments)]
fn push_entry(
    line: usize,
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
            // 批 D localReturnType 面:裸名写点全域登记(模块/类体/方法体三域
            // 同表;面查询按域门自筛,不影响既有链面语义)
            ctx.bare_writes
                .entry(name.id.to_string())
                .or_default()
                .push(BareWrite {
                    line,
                    shape: value.clone(),
                    class_start,
                    method_start,
                });
            // 方法域内裸名写点 → 局部链面(最近写点解析的素材);类体直系
            // (method_start=None)不入局部链(类级链不建模,诚实空)
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

/// 推导状态:RAW 索引(字面量面)+ 类跨度 + 收集面表格;基线图备忘录防每条目
/// 重算。表格以引用携带(FlowParse 与收集期 BuildContext 两处同构消费)。
pub(crate) struct ResolveState<'a> {
    pub(crate) lines: &'a [Vec<u16>],
    pub(crate) classes: &'a [ClassSpan],
    pub(crate) locals: &'a HashMap<(usize, String), Vec<(usize, RhsShape)>>,
    pub(crate) def_returns: &'a HashMap<String, DefReturn>,
    pub(crate) class_names: &'a HashMap<String, Vec<usize>>,
    pub(crate) class_methods: &'a HashMap<usize, HashMap<String, Vec<Option<String>>>>,
    pub(crate) bare_writes: &'a HashMap<String, Vec<BareWrite>>,
    pub(crate) raw: &'a AssignmentTypes,
    pub(crate) raw_class_direct: &'a ClassAssignmentTypes,
    pub(crate) baseline_memo: HashMap<(usize, String), TypeSet>,
}

impl ResolveState<'_> {
    /// FlowParse → 推导状态(localReturnType 面与流面同源)。
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
            raw: &fp.assignments,
            raw_class_direct: &fp.class_direct,
            baseline_memo: HashMap::new(),
        }
    }

    fn class_span(&self, class_start: usize) -> Option<&ClassSpan> {
        self.classes.iter().find(|c| c.start_line == class_start)
    }

    /// 类属性基线(RAW 索引上收敛;备忘录)。
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
            ),
            None => TypeSet::new(),
        };
        self.baseline_memo.insert(key, out.clone());
        out
    }

    /// 方法注解原子(同名方法多个 = 歧义不猜)。
    pub(crate) fn method_atom(&self, class_start: usize, method: &str) -> Option<String> {
        let rets = self.class_methods.get(&class_start)?.get(method)?;
        if rets.len() != 1 {
            return None;
        }
        rets[0].clone()
    }

    /// 唯一同类名(重名类 = 歧义不猜)。
    pub(crate) fn unique_class(&self, name: &str) -> Option<usize> {
        match self.class_names.get(name) {
            Some(v) if v.len() == 1 => Some(v[0]),
            _ => None,
        }
    }

    /// 批 D:裸名 callee 原子——def 注解与唯一同类名二选一,并存=歧义不猜
    /// (类实例化产类名原子;`x = Repo()` 流证据如实)。
    pub(crate) fn callee_atom(&self, name: &str) -> Option<String> {
        let def = self.def_returns.get(name);
        let cls = self.class_names.get(name);
        match (def, cls) {
            (Some(DefReturn::Single(r)), None) => r.clone(),
            (None, Some(v)) if v.len() == 1 => Some(name.to_string()),
            _ => None,
        }
    }
}

/// RHS 形态推导(有界;环防;越域/未知 → 空集)。flow_line = 当前流位置
/// (局部链最近写点 = 该位置之前最近一条)。
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
                return TypeSet::new(); // 环
            }
            // 方法域内最近写点(类体直系 method_start=None 无局部链——模块层
            // 回退仍可解,见下)
            let method_found = method_start.and_then(|ms| {
                state
                    .locals
                    .get(&(ms, name.clone()))
                    .and_then(|v| {
                        v.iter()
                            .rev()
                            .find(|(l, _)| *l < flow_line)
                            .map(|(l, s)| (*l, s))
                    })
            });
            let found = method_found.or_else(|| {
                // 模块层写点回退(批 D):模块域裸名对方法体/类体可见(Python
                // 读语义);只认模块层写点(类体实例写点对方法体不可见,诚实漏)
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
                Some((l, s)) => resolve_shape(
                    state,
                    s,
                    l,
                    class_start,
                    method_start,
                    depth + 1,
                    visited,
                ),
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
        CalleeShape::Name(n) => state.callee_atom(n),
        CalleeShape::Qualified { class, method } => state
            .unique_class(class)
            .and_then(|cls| state.method_atom(cls, method))
            .or_else(|| {
                // 裸名接收者二义(批 D):`A.m(...)` 类限定之外还有「局部/模块
                // 变量.m(...)」——变量原子链裁定(先类限定,非类名才走变量;
                // 同名类与变量并存时类解释优先)
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
                return TypeSet::new(); // 接收者不唯一/未知 → 不猜
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

// ---- 版本键 LRU 解析缓存(KODE-PERF-001 语义对齐) --------------------------

/// 一次解析的全量派生(类跨度 + 赋值类型索引 + 收集面表格),按 versionKey 缓存。
#[derive(Debug, Clone)]
pub struct FlowParse {
    pub classes: Vec<ClassSpan>,
    /// 方法级 `self.<attr>` 赋值类型(键=起始行;含嵌套函数体——扫描的缩进
    /// 过滤使其不污染外层流,只在写点查询位命中)
    pub assignments: AssignmentTypes,
    /// 类体直系裸名赋值/注解类型(基线面;嵌套块/嵌套类体内不入,按类身份隔离)
    pub class_direct: ClassAssignmentTypes,
    /// 批 D localReturnType 面:裸名写点全域表(名 → 源序写点)
    pub(crate) bare_writes: HashMap<String, Vec<BareWrite>>,
    /// def/class 名行集合(域门窄化素材)
    pub(crate) header_lines: HashSet<usize>,
    /// 模块级 def `-> T` 表
    pub(crate) def_returns: HashMap<String, DefReturn>,
    /// 类名 → 类名行
    pub(crate) class_names: HashMap<String, Vec<usize>>,
    /// 类名行 → 方法名 → return 注解收集
    pub(crate) class_methods: HashMap<usize, HashMap<String, Vec<Option<String>>>>,
    /// 方法域内局部裸名写点(批 C 链素材;面与流共享)
    pub(crate) locals: HashMap<(usize, String), Vec<(usize, RhsShape)>>,
}

struct ParseCacheEntry {
    map: HashMap<String, FlowParse>,
    order: VecDeque<String>,
}

static PARSE_CACHE: Mutex<Option<ParseCacheEntry>> = Mutex::new(None);

/// 行列表 → 解析派生(UTF-16 行 join('\n') → String → ruff 容错解析)。
fn flow_parse_from_lines(lines: &[Vec<u16>]) -> FlowParse {
    let mut content: Vec<u16> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if idx > 0 {
            content.push(0x0A);
        }
        content.extend_from_slice(line);
    }
    let source = String::from_utf16_lossy(&content);
    let parsed = ParsedAst::new(source);
    let classes = class_spans_from_ast(&parsed);
    let tables = assignments_from_ast(&parsed, lines, &classes);
    FlowParse {
        classes,
        assignments: tables.assignments,
        class_direct: tables.class_direct,
        bare_writes: tables.bare_writes,
        header_lines: tables.header_lines,
        def_returns: tables.def_returns,
        class_names: tables.class_names,
        class_methods: tables.class_methods,
        locals: tables.locals,
    }
}

/// 行列表 → 全量派生(localReturnType 面 entry;versionKey 协议同流面)。
pub fn flow_parse(lines: &[Vec<u16>], version_key: Option<&str>) -> FlowParse {
    parse_with_version_cache(lines, version_key)
}

fn parse_with_version_cache(lines: &[Vec<u16>], version_key: Option<&str>) -> FlowParse {
    let key = match version_key {
        Some(key) => key,
        None => {
            // 无键 = 现解析不缓存(纯函数回退)
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
        // LRU 触碰:移到尾(最近使用)
        if let Some(pos) = entry.order.iter().position(|k| k == key) {
            entry.order.remove(pos);
        }
        entry.order.push_back(key.to_string());
        return cached;
    }
    let parsed = flow_parse_from_lines(lines);
    entry.map.insert(key.to_string(), parsed.clone());
    entry.order.push_back(key.to_string());
    while entry.order.len() > PARSE_CACHE_MAX_ENTRIES {
        if let Some(oldest) = entry.order.pop_front() {
            entry.map.remove(&oldest);
        }
    }
    parsed
}

/// 清缓存(测试注入口;生产不用)
pub fn reset_self_attribute_flow_parse_cache_for_tests() {
    *PARSE_CACHE.lock().unwrap() = None;
}

// ---- 流类型集合运算 ---------------------------------------------------------

#[derive(Debug)]
pub struct SelfAttributeFlow {
    /// 去重排序的原子类型名;空 = 无法确定
    pub types: Vec<String>,
    /// 格式化注解串('list | None')或 None(types 空)
    pub annotation: Option<String>,
    pub has_none: bool,
    /// 窄化生效:基类含 None 而查询位不含
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
    types.iter().filter(|t| t.as_str() != "None").cloned().collect()
}

/// 排序 + ` | ` 联接(BTreeSet 迭代即升序;空集 → None)
fn format_types(types: &TypeSet) -> Option<String> {
    if types.is_empty() {
        return None;
    }
    Some(types.iter().cloned().collect::<Vec<_>>().join(" | "))
}

// ---- 行形态扫描器(正则手工展开,左优先 + 回溯语义) -------------------------



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
    // 'self' 后应为 '.'
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

/// 块开关键字交替(左优先序,与 TS 正则同序):if|elif|else|for|while|try|
/// except|finally|with + `\b` 词界。JS 行为保真:某关键字命中但词界失败时,
/// 继续试**后续**交替(如 `elsewhere`:'else' 词界失败,余者不匹配 → 整体否)。
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
        // \b:词元后界(行尾 = 界;非 \w = 界)
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


// ---- 方法域定位与流走查器 ---------------------------------------------------

struct MethodSpan {
    start_line: usize,
    end_line: usize,
}

/// 方法体界(0 起,含尾):AST 真实体域,全类集合中内含查询行的**最小域**
/// 者胜(嵌套类行归嵌套类方法、条件 def 域不再越界吞邻;类外/方法间空隙 →
/// None——空隙行不是使用位,落空即诚实)。
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
                    domain.end_line - domain.start_line
                        < current.end_line - current.start_line
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

/// 方法体基础缩进:方法行后首个非空行缩进;无体行 = 方法行缩进 + 1
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
    /// then 分支以 return/raise 终止(不落到块后)
    terminal: bool,
    /// 扫描在 stopAtLine 前停住(查询位在本块内)
    reached_stop: bool,
}

/// 顺序扫描(同缩进层):赋值覆盖/两种 None 守卫/通用块并集/return raise 终止。
/// stop 非空时到达查询行前停(写点恰是赋值行先落 RHS 语义再停)。赋值类型
/// 取自 AST 索引(批 B):键在=赋值成立(空集=未知,替换语义);键不在=该行
/// 无此赋值,状态保留。
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
                // 查询位:先落赋值语义(写点 inlay 显 RHS 类型)再停
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
            break; // 去缩进:本序列结束
        }
        if this_indent > indent {
            line += 1; // 更深缩进(块体)不属本层,跳过
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
                // 早退:then 不落到块后;else 路径继续 → 去 None
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
                // 早退非 None 块:then 退出,else(X 可 None)继续 → 入口态
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

/// 块闭合行:首个缩进 <= 块行缩进的非空行前一行;无 = endLine
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

/// 块体实际缩进:块行后首个非空行缩进;无体行 = 块行缩进 + 1
fn block_body_indent(lines: &[Vec<u16>], start_line: usize, end_line: usize) -> usize {
    for j in start_line + 1..=end_line {
        if let Some(text) = lines.get(j) {
            if is_blank(text) || is_comment_only(text) {
                continue;
            }
            return indent_of(text);
        }
    }
    lines
        .get(start_line)
        .map(|l| indent_of(l))
        .unwrap_or(0)
        + 1
}

/// 收敛基类:类级声明(注解 `X: T` T 优先 + 赋值 `X = ...` 推导)∪ __init__
/// 体流扫描末态(尾部赋值覆盖)
fn converged_baseline(
    class_direct: &ClassAssignmentTypes,
    assignments: &AssignmentTypes,
    lines: &[Vec<u16>],
    cls: &ClassSpan,
    attr: &[u16],
) -> TypeSet {
    let mut baseline = TypeSet::new();
    let first_method_line = cls
        .method_lines
        .values()
        .copied()
        .min()
        .unwrap_or(cls.end_line.saturating_sub(1));
    // 类体直系赋值/注解(AST 收集面;`X: T` 无值=注解文本原子,`X: T = v`
    // = 注解 + RHS 推导)
    let mut j = cls.start_line + 1;
    while j < first_method_line && j < cls.end_line {
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
    baseline
}



/// 查询位自管属性流敏感类型(纯函数;与 TS inferSelfAttributeFlow 等值)。
/// None 当:attr 空 / 查询行越界。
pub fn infer_self_attribute_flow(
    lines: &[Vec<u16>],
    query_line: usize,
    attr: &[u16],
    version_key: Option<&str>,
) -> Option<SelfAttributeFlow> {
    if attr.is_empty() || query_line >= lines.len() {
        return None;
    }
    let flow_parse = parse_with_version_cache(lines, version_key);
    let classes = &flow_parse.classes;
    let enclosing = enclosing_method(classes, query_line);
    let (flow, baseline) = if let Some((method, cls_idx)) = enclosing {
        let baseline = converged_baseline(
            &flow_parse.class_direct,
            &flow_parse.assignments,
            lines,
            &classes[cls_idx],
            attr,
        );
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
        // 类体/模块层:无方法流,直接用收敛基类(内含最小类者胜——嵌套类归属正确)
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
                );
                (baseline.clone(), baseline)
            }
            None => (TypeSet::new(), TypeSet::new()),
        }
    };
    let has_none = flow.contains("None");
    let narrowed = baseline.contains("None") && !has_none;
    Some(SelfAttributeFlow {
        types: flow.iter().cloned().collect(),
        annotation: format_types(&flow),
        has_none,
        narrowed,
    })
}

// ---- 单测(TS tests/selfAttributeFlowTypes.test.ts 关键例移植;回调面用例
// ---- 留 TS 侧——生产契约无回调) -------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(body: &[&str]) -> Vec<Vec<u16>> {
        body.iter()
            .map(|l| l.encode_utf16().collect())
            .collect()
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
        .unwrap()
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
        assert_eq!(f.annotation, None); // 调用注解解不出 → 空集,不硬造 Any
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
        assert_eq!(flow(&body, 9, "f").annotation, None); // self 链不递归
        assert_eq!(flow(&body, 10, "j").annotation, None); // 下标形态回落空集
    }

    #[test]
    fn invalid_inputs_return_none() {
        let lines = lines_of(&["class Foo:", "    def m(self):", "        self.x = 1"]);
        assert!(infer_self_attribute_flow(&lines, 1, &[], None).is_none());
        assert!(infer_self_attribute_flow(&lines, usize::MAX, &attr_u16("x"), None).is_none());
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
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 5, &attr_u16("x"), None)
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
                .unwrap()
                .annotation,
            Some("str".to_string())
        );
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 8, &attr_u16("x"), None)
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
        assert!(infer_self_attribute_flow(&lines, 4, &attr_u16("x"), None).is_some());
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
        let a = infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some(key)).unwrap();
        let b = infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some(key)).unwrap();
        assert_eq!(a.annotation, b.annotation);
        // 异键/无键照常
        assert!(infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some("file:///a.py|10"))
            .is_some());
        assert!(infer_self_attribute_flow(&lines, 5, &attr_u16("X"), None).is_some());
    }

    // ---- 精确性主车道批 A:AST 真域 ------------------------------------

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
        // ruff class/def range 含 @ 前缀;名行校正后与旧「def 名行」口径一致
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
        // 旧引擎:嵌套类体内查询行被外层类吞(先含者胜+下一方法起点−1),self.y
        // 误绑到 Outer.m 的流;真域后归 Inner.n,且 Inner 域内查 x 不跨类硬套。
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
        // 旧引擎把类尾行吞进最后方法域(下一方法起点−1→类尾);真域后类级行
        // 不再继承方法流(查询 m 的写点仍得 int,类级行落基线=诚实空)。
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
        // 装饰器行不在任何方法域(与旧引擎同:类体分支=基线)
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
        // if TYPE_CHECKING 体内 def:成员归属类(旧展平口径同员),域取真实体
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

    // ---- 批 B:typeOfExpr AST 化(字面量面推导升级) -------------------------

    #[test]
    fn set_literal_not_dict() {
        // 实测误导账本 #1:{1,2} 首尾字符嗅探误判 dict;AST 后 Set→set,
        // 空 dict {} 仍 dict,调用 set() 仍不可推导(批 C)。
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
        // 旧引擎按首尾字符 `(x)` 判 tuple:括号被 ruff 丢弃,(5) 就是 int。
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
        // 旧引擎 RHS 截到行尾,跨行括号串解不出;AST 取整个表达式节点。
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
        // `if c: self.x = 1` 条件执行不硬套(与旧引擎「行首非 self 不匹配」
        // 同语义):按行序扫描把它当普通行,不收集。
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
        // RHS 不可推导:替换语义保留(空集覆盖),不回填旧值
        assert_eq!(flow(&body, 4, "a").types, Vec::<String>::new());
        assert_eq!(flow(&body, 4, "b").types, Vec::<String>::new());
    }

    #[test]
    fn chained_targets_all_typed() {
        // 旧引擎只取首个 RHS 捕获;AST 多目标各自入索引
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
        // 注解原子 + RHS 推导并存(与类级 AnnAssign 同口径)
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
        // 旧引擎逐行文本扫描:docstring 里的 `self.x = 1` 被当真赋值(int)。
        // AST 后它是 StringLiteral 语句,不产赋值——假象消除,诚实空。
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
        // 旧引擎 RHS 捕获吞到行尾(`1; self.b = 2` 整段当一个 RHS);AST 按
        // 语句切分,各自推导。
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
        // 批 C:同文件 def `-> T` 注解直取(裸名调用面)
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
        assert!(f.narrowed); // 基线 None 被可推导调用覆盖 → 窄化如实
    }

    #[test]
    fn module_call_quoted_annotation_kept_raw() {
        // 字符串注解切片带引号保留(与旧注解原子口径一致)
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
        // 同名两个模块级 def:歧义=未知,不取首定义硬猜
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
        // 同名类两个:类限定解析歧义 → 诚实空
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
        // 链式 f().g():f 注解恰为同类名 → 该类方法注解(实测误导账本 #5)
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
        // 接收者原子不是同类名(int)→ 不猜
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
        // 批 D:callee 原子面补全——类实例化产类名原子(`x = Repo()` 流证据如实)
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
        // 批 D:def 与唯一同类名并存 = 歧义,不猜(诚实空)
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
        // 批 D:裸名接收者二义——非类名走变量原子链(模块 `repo` → Repo 原子)
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
        // `x = self.z` → 类属性基线(深度 1);基线图在 RAW 索引上收敛
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
        // 最近写点胜(替换语义同 self.<attr> 面)
        assert_eq!(flow(&body, 7, "x").types, vec!["None"]);
        assert_eq!(flow(&body, 5, "x").types, Vec::<String>::new()); // y=1 之前:无写点
    }

    #[test]
    fn local_chain_cycle_honest_empty() {
        // b = a; a = b(流序环):visited 防环 → 诚实空
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
        // a = b 在 b 写点之前:流序前向引用不可推导 → 诚实空
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
        // 有界跳数:条目形态深度 0,每解一层裸名 +1(RESOLVE_MAX_HOPS=4)
        // → 4 具名变量链在界内(v1 形态深度 4),6 具名变量链越界诚实空
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
        // KBEngine 旗舰形态:__init__ None + 守卫后可推导调用 → 窄化如实
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
        // 守卫前仍是 None 证据
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
        // 同 docstring 面:字符串字面量内容里的赋值形文本不是赋值
        let body = [
            "class A:",
            "    def m(self):",
            "        self.s = 'self.x = 1'",
            "        return self.s",
        ];
        assert_eq!(flow(&body, 3, "s").types, vec!["str"]);
        assert_eq!(flow(&body, 3, "x").types, Vec::<String>::new());
    }


}
