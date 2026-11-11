//! 批 D 返回注解接收者级联修正(精确性主车道):`$/kode/python/localReturnType`
//! 引擎本体。同文件接收者定型解析——TS 级联兜底(cascadeAnnotation 全局方法名
//! 猜测,跨类误绑实测误导 #2)删除后,同文件可推导子集由本面接住:
//!
//! - 域门(KBUG-SCOPE 词法作用域链):自 hover 位的最内函数域向外,第一个
//!   「绑定该名」的域裁定——参数绑定 → 诚实空(遮蔽外层);域内写点绑定 →
//!   hover 行前最近写点(不可解即止);global/nonlocal 声明 → 向外透传;
//!   域外尽 → 模块域。类体直系 hover 的链 = 本类体 → 模块;方法体 hover
//!   跳过类体(类体属性表不在函数词法链上,他类体亦不可借);
//! - 最近写点胜(替换语义;同行多条语句取执行序最后一条;写点不可解即止,
//!   不再向上借更早答案 = R2-F16 同语义);
//! - RHS 推导(流引擎共享表格):`x = f(...)` 同文件模块级 def `-> T`(重名
//!   歧义不猜)/ `x = self.m(...)` 所在类方法注解 / `x = A.m(...)` 类限定 /
//!   `x = recv.m(...)` 接收者唯一原子恰为同类名 / `x = y` 别名链同域递归;
//! - 诚实边界:字面量、`self.<attr>` 属性读、类实例化(非返回注解面)、
//!   无注解、环、越界 → None,绝不猜。import 绑定路径留在 TS(已接收者
//!   正确),本面只补同文件可推导真值。

use std::collections::HashSet;

use crate::self_flow::{
    flow_query_value, resolve_shape, BareWrite, CalleeBinding, CalleeShape, DefReturn, FlowParse,
    FlowVal, FnDomain, Pos, ResolveState, RhsShape,
};

/// 别名链有界跳数(与流面 RESOLVE_MAX_HOPS 同量级;域门扫描每跳严格下行,
/// 环天然有界,此处只是双保险)。
const FACE_MAX_HOPS: usize = 4;

/// localReturnType 面答案(target=hover 词;annotation=返回注解原文;
/// method_name=推导来源调用名,与 TS formatInferredReturnHover 消费面同形)。
#[derive(Debug, Clone, PartialEq)]
pub struct LocalReturnFace {
    pub target: String,
    pub annotation: String,
    pub method_name: String,
}

/// KBUG-ORDER:查询位缺失列的保守回退 = hover 行首个非空白字符列(与
/// 整行光标悬停的旧引擎口径一致;绝不伪造整行最后写点)。
fn first_non_blank_col(line: &[u16]) -> usize {
    line.iter()
        .position(|c| *c != b' ' as u16 && *c != b'\t' as u16)
        .unwrap_or(0)
}

/// 接收者定型解析入口(纯函数;versionKey 协议与流面同)。
/// `hover_column` = 0 基 UTF-16 列(VSCode Position.character 同口径;None =
/// 缺列,保守回退行首非空白列)。None = hover 词无可推导返回注解(诚实空)。
pub fn local_return_type(
    lines: &[Vec<u16>],
    hover_line: usize,
    hover_column: Option<usize>,
    word: &[u16],
    version_key: Option<&str>,
) -> Option<LocalReturnFace> {
    if word.is_empty() || lines.is_empty() || hover_line >= lines.len() {
        return None;
    }
    let word = String::from_utf16_lossy(word);
    // TS Impl 同款守卫:全大写/下划线常量名不查询(装配面同守卫,双保险)
    if is_constant_name(&word) {
        return None;
    }
    let fp = crate::self_flow::flow_parse(lines, version_key);
    let mut state = ResolveState::from_flow_parse(&fp, lines);
    let mut visited = HashSet::new();
    let query = Pos {
        line: hover_line,
        col: hover_column.unwrap_or_else(|| first_non_blank_col(&lines[hover_line])),
    };
    face_scan(&fp, &mut state, lines, query, &word, 0, &mut visited).map(|mut face| {
        face.target = word.clone();
        face
    })
}

/// 全大写/数字/下划线常量名守卫(TS `/^[A-Z_][A-Z0-9_]*$/` 同语义)。
fn is_constant_name(word: &str) -> bool {
    let mut chars = word.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// 域门扫描(KBUG-SCOPE 词法作用域链重铸,替代旧缩进回溯):Python 名字
/// 解析模型——自 hover 位的最内函数域向外,链上第一个「绑定该名」的域裁定:
/// - 参数绑定 → 诚实空(参数无返回注解面,且遮蔽外层同名绑定);
/// - 域内写点绑定 → hover 位前(含)最近有效写点 → 解析(不可解即止,不外借);
/// - global/nonlocal 声明 → 本域不绑定该名,解向外层;
/// - 链外尽 → 模块域(见 `is_module_binding`)。
///
/// 类体直系 hover(不在任何函数域内)的链 = 本类体 → 模块:本类体写点可读;
/// 方法体 hover 的链不含类体(KBUG-SCOPE-04:类体属性表不在函数词法链上,
/// 他类体写点亦不可借)。写点行域判定取代缩进窄化——def 体写点不再被
/// def 结束后的模块层读借用,嵌套函数体写点不再外溢。
/// KBUG-ORDER:`query` = hover 位(行+UTF-16 列;链/类包含仍按行,同行
/// 读写不混、RHS 内读回旧值由流求值裁定)。
fn face_scan(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    query: Pos,
    word: &str,
    depth: usize,
    visited: &mut HashSet<(usize, usize, String)>,
) -> Option<LocalReturnFace> {
    if depth > FACE_MAX_HOPS {
        return None;
    }
    let start = query.line.min(lines.len() - 1);
    // hover 位的作用域链:含 hover 行的函数域,体首行降序(最内先行;
    // 同首行时体更小者先行 = 嵌套域)
    let mut chain: Vec<&FnDomain> = fp
        .fn_domains
        .iter()
        .filter(|d| d.start_line <= start && start <= d.end_line)
        .collect();
    chain.sort_by(|a, b| {
        b.start_line
            .cmp(&a.start_line)
            .then(a.end_line.cmp(&b.end_line))
    });
    for domain in &chain {
        if domain.globals.iter().any(|n| n == word)
            || domain.nonlocals.iter().any(|n| n == word)
        {
            continue; // global/nonlocal:本域不绑定该名,解向外层
        }
        if domain.params.iter().any(|n| n == word) {
            return None; // 参数绑定:无返回注解面,遮蔽外层同名绑定
        }
        // 本域写点 = 该名在本域局部(Python 函数级静态绑定):写点值经
        // 语句流树流敏感裁定(KBUG-CFGFLOW:if False/终止后写点不污染,
        // 合流多候选全同才答;KBUG-ORDER:同行按列,悬停 RHS 内读旧值);
        // 无可达写点 → UnboundLocal 位,诚实空,绝不外借模块/外层绑定
        // (KBUG-SCOPE-02)。
        let domain_writes = fp
            .bare_writes
            .get(word)
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        let binds_here = |w: &BareWrite| w.method_start == Some(domain.header_line);
        if domain_writes.iter().any(binds_here) {
            let domain_write_refs: Vec<&BareWrite> =
                domain_writes.iter().filter(|w| binds_here(w)).collect();
            let val = match fp.fn_trees.get(&domain.header_line) {
                Some(tree) => flow_query_value(tree, &domain_write_refs, query),
                // 无树域(直接赋值 lambda 等;其体内无裸名写点):退文本序位
                None => match domain_write_refs.iter().rev().find(|w| w.pos() <= query) {
                    Some(w) => FlowVal::One(w.pos()),
                    None => FlowVal::Unbound,
                },
            };
            return resolve_flow_val(fp, state, lines, val, &domain_write_refs, word, depth, visited);
        }
        // 本域无该名绑定 → 向外层函数域继续
    }
    // 类体直系 hover:本类体绑定(类体 `global` 声明名除外)
    let hover_class = if chain.is_empty() {
        fp.classes
            .iter()
            .filter(|c| c.start_line <= start && start < c.end_line)
            .max_by_key(|c| c.start_line)
    } else {
        None
    };
    if let Some(cls) = hover_class {
        let declared_global = fp
            .scope_globals
            .get(&cls.start_line)
            .map(|names| names.iter().any(|n| n == word))
            .unwrap_or(false);
        if !declared_global {
            let class_writes: Vec<&BareWrite> = fp
                .bare_writes
                .get(word)
                .map(|ws| {
                    ws.iter()
                        .filter(|w| {
                            w.method_start.is_none() && w.class_start == Some(cls.start_line)
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !class_writes.is_empty() {
                let val = match fp.class_trees.get(&cls.start_line) {
                    Some(tree) => flow_query_value(tree, &class_writes, query),
                    None => match class_writes.iter().rev().find(|w| w.pos() <= query) {
                        Some(w) => FlowVal::One(w.pos()),
                        None => FlowVal::Unbound,
                    },
                };
                return resolve_flow_val(fp, state, lines, val, &class_writes, word, depth, visited);
            }
            // 本类体未绑定 → 落模块域(类体执行期可见模块名)
        }
    }
    // 模块域绑定:非函数域写点;类体直系写点须其类体声明过 `global`;
    // 函数域写点须其函数域声明过 `global`(写点重定向模块名空间)。
    // 写点值经模块语句流树流敏感裁定(KBUG-CFGFLOW;main-guard 等条件块
    // 内写点是候选而非确定)。
    let is_module_binding = |w: &BareWrite| -> bool {
        match w.method_start {
            Some(header) => fp
                .fn_domains
                .iter()
                .find(|d| d.header_line == header)
                .map(|d| d.globals.iter().any(|n| n == word))
                .unwrap_or(false),
            None => match w.class_start {
                None => true,
                Some(cls) => fp
                    .scope_globals
                    .get(&cls)
                    .map(|names| names.iter().any(|n| n == word))
                    .unwrap_or(false),
            },
        }
    };
    let module_writes: Vec<&BareWrite> = fp
        .bare_writes
        .get(word)
        .map(|ws| ws.iter().filter(|w| is_module_binding(w)).collect())
        .unwrap_or_default();
    if !module_writes.is_empty() {
        let val = flow_query_value(&fp.module_tree, &module_writes, query);
        return resolve_flow_val(fp, state, lines, val, &module_writes, word, depth, visited);
    }
    None
}

/// 流值 → 面答案:One 直解;Many 逐候选解析——候选面全同 = 该面,不同 =
/// 未知,绝不按源码先后任取(KBUG-CFGFLOW-03);maybe_unbound = 合流含
/// 未绑定路径 → 诚实空(可能 NameError);Unbound = 无可达写点(UnboundLocal
/// /不可达位)。
#[allow(clippy::too_many_arguments)]
fn resolve_flow_val(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    val: FlowVal,
    writes: &[&BareWrite],
    word: &str,
    depth: usize,
    visited: &mut HashSet<(usize, usize, String)>,
) -> Option<LocalReturnFace> {
    match val {
        FlowVal::Unbound => None,
        FlowVal::One(l) => {
            let write = writes.iter().copied().find(|w| w.pos() == l)?;
            if !visited.insert((write.line, write.col, word.to_string())) {
                return None; // `x = x` 身份链/重复解同一写点 → 诚实空
            }
            resolve_face_shape(fp, state, lines, write, depth, visited)
        }
        FlowVal::Many(cands, maybe_unbound) => {
            if maybe_unbound {
                return None;
            }
            let mut face: Option<LocalReturnFace> = None;
            for l in &cands {
                let Some(write) = writes.iter().copied().find(|w| w.pos() == *l) else {
                    continue;
                };
                if !visited.insert((write.line, write.col, word.to_string())) {
                    continue;
                }
                let f = resolve_face_shape(fp, state, lines, write, depth, visited);
                face = match (face, f) {
                    (None, f0) => f0,
                    (Some(prev), Some(f0)) if prev == f0 => Some(prev),
                    _ => return None, // 候选结果不同 → 未知
                };
            }
            face
        }
    }
}

/// 最近写点 RHS → 面答案。调用形态直取注解;别名链同域递归;其余形态
/// (字面量/属性读/未知)诚实空。
fn resolve_face_shape(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    write: &BareWrite,
    depth: usize,
    visited: &mut HashSet<(usize, usize, String)>,
) -> Option<LocalReturnFace> {
    match &write.shape {
        RhsShape::Call(callee) => face_from_callee(fp, state, write, callee),
        RhsShape::Local(alias) => {
            // 别名链:同域口径解别名名的最近写点(每跳严格下行,天然有界)。
            // KBUG-ORDER-03:查询位 = 本写点 RHS 起始位——别名读只见严格
            // 先行的绑定,自引用/同行后写不可见(`y = a(); x = y; y = b()`
            // 悬 x 解 y 的 a 写点,不吞后续 b 写点)。
            face_scan(fp, state, lines, write.rhs_pos, alias, depth + 1, visited)
        }
        _ => None,
    }
}

/// 调用形态 → (注解原文, 调用名)。
fn face_from_callee(
    fp: &FlowParse,
    state: &mut ResolveState,
    write: &BareWrite,
    callee: &CalleeShape,
) -> Option<LocalReturnFace> {
    let (annotation, method_name) = match callee {
        CalleeShape::Name(f) => {
            // 同文件模块级 def 注解(重名歧义/无注解/类实例化 → 诚实空:
            // 实例化的类名不是返回注解,面语义不答)。
            // KBUG-BIND-01/02:调用位置的绑定事实先于声明表——参数/局部
            // def/域内先行写点绑定 → 诚实空;模块别名绑定透传值链注解
            // (与流面 resolve_callee 同规则;绑定值为类名原子 → 实例化
            // 语义,非返回注解面,诚实空)
            let declared = |name: &str| match fp.def_returns.get(name)? {
                DefReturn::Single(Some(ann)) => Some(ann.clone()),
                _ => None,
            };
            match state.callee_binding(f, write.line) {
                CalleeBinding::Bound(Some(atom)) => {
                    if state.unique_class(&atom).is_some() {
                        return None; // 绑定到类名 = 实例化/静态语义,非注解面
                    }
                    (declared(&atom)?, f.clone())
                }
                CalleeBinding::Bound(None) => return None,
                CalleeBinding::Unbound => (declared(f)?, f.clone()),
            }
        }
        CalleeShape::SelfMethod(m) => {
            // 所在类方法表;类体直系/模块域写点无类语境 → 诚实空
            let cls = write.class_start?;
            (state.method_atom(cls, m)?, m.clone())
        }
        CalleeShape::Qualified { class, method } => {
            // KBUG-BIND-04:原始类静态方法仅在名**未绑定**时命中(A=B /
            // A=unknown 后 A.load 不沿用原类);名被绑定或类限定未命中 →
            // 变量原子链裁定(与流面 resolve_callee 同优先级:类限定先,
            // 变量链后;多候选不任取首项)
            let static_hit = state
                .unique_class(class)
                .and_then(|cls| state.method_atom(cls, method))
                .map(|ann| (ann, method.to_string()));
            match static_hit {
                Some(hit)
                    if state.callee_binding(class, write.line)
                        == CalleeBinding::Unbound =>
                {
                    hit
                }
                _ => {
                    let var = RhsShape::Local(class.clone());
                    let atoms = resolve_shape(
                        state,
                        &var,
                        write.line,
                        write.class_start,
                        write.method_start,
                        0,
                        &mut HashSet::new(),
                    );
                    if atoms.len() != 1 {
                        return None;
                    }
                    let atom = atoms.into_iter().next().unwrap();
                    let cls = state.unique_class(&atom)?;
                    (state.method_atom(cls, method)?, method.clone())
                }
            }
        }
        CalleeShape::Chained { receiver, method } => {
            // 接收者唯一原子且恰为同类名(流引擎共享推导,含局部链/实例化原子;
            // 类体直系写点 method_start=None,链面诚实空 = 流面同语义)
            let atoms = resolve_shape(
                state,
                receiver,
                write.line,
                write.class_start,
                write.method_start,
                0,
                &mut HashSet::new(),
            );
            if atoms.len() != 1 {
                return None;
            }
            let atom = atoms.into_iter().next().unwrap();
            let cls = state.unique_class(&atom)?;
            (state.method_atom(cls, method)?, method.clone())
        }
    };
    Some(LocalReturnFace {
        target: String::new(),
        annotation,
        method_name,
    })
}

// ---- 单测(面语义钉;跨类误绑/诚实边界/链式/别名/域门) ----------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(text: &str) -> Vec<Vec<u16>> {
        text.lines().map(|l| l.encode_utf16().collect()).collect()
    }

    #[test]
    fn module_def_call_annotation_hit() {
        let lines = lines_of(
            "def make_repo() -> Repo:\n    return None\n\ndata = make_repo()\n",
        );
        let face = local_return_type(&lines, 3, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("同文件 def 注解应命中");
        assert_eq!(face.annotation, "Repo");
        assert_eq!(face.method_name, "make_repo");
        assert_eq!(face.target, "data");
    }

    #[test]
    fn self_method_call_in_method_body() {
        let lines = lines_of(
            "class A:\n    def get(self) -> Row:\n        return None\n\n    def tick(self):\n        data = self.get()\n        return data\n",
        );
        let face = local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("self.m() 所在类限定应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "get");
    }

    #[test]
    fn qualified_class_method_call() {
        let lines = lines_of(
            "class Repo:\n    @staticmethod\n    def load() -> Row:\n        return None\n\nr = Repo.load()\n",
        );
        let face = local_return_type(&lines, 5, None, &"r".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("类限定方法应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    /// 用户点名误导面:两个类各有同名方法,类限定各答各的,不跨类误绑。
    #[test]
    fn same_name_methods_in_two_classes_bind_to_their_own_class() {
        let lines = lines_of(
            "class A:\n    def get(self) -> X:\n        return None\n\nclass B:\n    def get(self) -> Y:\n        return None\n\na = A()\na_val = A.get(a)\nb_val = B.get(a)\n",
        );
        let face_a =
            local_return_type(&lines, 9, None, &"a_val".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("A.get 应命中");
        assert_eq!(face_a.annotation, "X");
        let face_b =
            local_return_type(&lines, 10, None, &"b_val".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("B.get 应命中");
        assert_eq!(face_b.annotation, "Y");
    }

    #[test]
    fn chained_call_via_local_alias_receiver() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\ndef make_repo() -> Repo:\n    return None\n\nrepo = make_repo()\nrow = repo.load()\n",
        );
        let face = local_return_type(&lines, 8, None, &"row".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("局部接收者链应命中(Repo 原子 → load 注解)");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    #[test]
    fn chained_call_inline_receiver() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\ndef make_repo() -> Repo:\n    return None\n\nrow = make_repo().load()\n",
        );
        let face = local_return_type(&lines, 7, None, &"row".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("内联链 f().g() 应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    /// 别名链:x = y;y = f() → x 面答 f 注解。
    #[test]
    fn alias_chain_resolves_through() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nt = make()\nx = t\n",
        );
        let face = local_return_type(&lines, 4, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("别名链应穿透到 f 注解");
        assert_eq!(face.annotation, "Tree");
        assert_eq!(face.method_name, "make");
    }

    /// `x = x` 身份链 → 诚实空(环防)。
    #[test]
    fn identity_alias_honest_empty() {
        let lines = lines_of("x = x\n");
        assert!(
            local_return_type(&lines, 0, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// 最近写点胜且不可解即止:重赋值字面量后不再借更早调用答案(R2-F16 同语义)。
    #[test]
    fn overwritten_by_literal_stops_earlier_answer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\ndata = 1\n",
        );
        assert!(
            local_return_type(&lines, 4, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 域门:兄弟方法体的同名写点不借;方法内 hover 只认本方法体写点。
    #[test]
    fn sibling_method_write_not_borrowed() {
        let lines = lines_of(
            "class A:\n    def m(self):\n        data = 1\n\n    def n(self):\n        return data\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 模块层写点放行:hover 在方法体、写点在模块层(def/class 头窄化后域内)。
    #[test]
    fn module_write_visible_from_method_body() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\n\nclass A:\n    def n(self):\n        return data\n",
        );
        let face = local_return_type(&lines, 7, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("模块层写点应被方法体 hover 借到(外层域放行)");
        assert_eq!(face.annotation, "Tree");
    }

    /// KBUG-SCOPE-04 语义重钉(账本推翻旧口径):方法体裸名不读所属类体的
    /// 属性表——`data` 在方法 `n` 内是自由名,类体写点不可借,诚实空
    /// (旧「类头窄化放行」口径答 make() 是误导;类体直系读走
    /// same_class_body_hover_reads_own_class_write)。
    #[test]
    fn method_body_does_not_read_class_body_table() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nclass A:\n    data = make()\n\n    def n(self):\n        return data\n",
        );
        assert!(
            local_return_type(&lines, 6, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// hover 行上的写点即候选(TS `line <= hoverLine` 含端)。
    #[test]
    fn write_on_hover_line_counts() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\ndata = make()\n");
        let face =
            local_return_type(&lines, 3, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("写点行即 hover 行应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// 无注解 def → 诚实空(不硬造)。
    #[test]
    fn unannotated_def_honest_empty() {
        let lines = lines_of("def make():\n    return None\n\ndata = make()\n");
        assert!(
            local_return_type(&lines, 3, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 重名 def 歧义 → 诚实空(不取首定义硬猜)。
    #[test]
    fn ambiguous_def_honest_empty() {
        let lines = lines_of(
            "def make() -> A:\n    return None\n\ndef make() -> B:\n    return None\n\ndata = make()\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 类实例化不是返回注解面:`data = Repo()` → 诚实空(流面产原子,本面不答)。
    #[test]
    fn class_instantiation_not_a_return_annotation() {
        let lines = lines_of("class Repo:\n    pass\n\ndata = Repo()\n");
        assert!(
            local_return_type(&lines, 3, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// self.属性读不是调用:诚实空(与旧 TS 同为 null,零回退)。
    #[test]
    fn self_attr_read_honest_empty() {
        let lines = lines_of(
            "class A:\n    def __init__(self):\n        self.counter = 1\n\n    def n(self):\n        data = self.counter\n        return data\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 常量名守卫(全大写)不查询。
    #[test]
    fn constant_name_skipped() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\nDATA = make()\n");
        assert!(
            local_return_type(&lines, 3, None, &"DATA".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 接收者推不出唯一类原子 → 诚实空(不猜方法名)。
    #[test]
    fn unknown_receiver_chained_honest_empty() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\nrow = mystery.load()\n",
        );
        assert!(
            local_return_type(&lines, 4, None, &"row".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 前向引用:hovers 行在写点之前 → 诚实空(流序)。
    #[test]
    fn forward_reference_honest_empty() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\nprint(data)\ndata = make()\n");
        assert!(
            local_return_type(&lines, 3, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 装饰器 def 名行域门:装饰器行不窄化,名行窄化(与名行口径同)。
    #[test]
    fn decorated_def_header_narrows_at_name_line() {
        let lines = lines_of(
            "def deco(fn):\n    return fn\n\n@deco\ndef make() -> Tree:\n    return None\n\ndata = make()\n",
        );
        let face = local_return_type(&lines, 7, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("装饰器 def 的注解应命中(名行登记)");
        assert_eq!(face.annotation, "Tree");
    }

    /// 三引号字符串体里的伪赋值不产写点(AST 真语句;旧行扫描的假象面消除)。
    #[test]
    fn string_body_fake_write_not_registered() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nDOC = '''\ndata = make()\n'''\n",
        );
        assert!(
            local_return_type(&lines, 4, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// hover 行越界 → None(与流面同守卫)。
    #[test]
    fn out_of_range_hover_line() {
        let lines = lines_of("data = 1\n");
        assert!(
            local_return_type(&lines, 9, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 别名链环:`x = y` 与 `y = x` 互指 → 诚实空(每跳严格下行,天然有界;
    /// 防环 visited 双保险)。
    #[test]
    fn mutual_alias_cycle_honest_empty() {
        let lines = lines_of("x = y\ny = x\n");
        assert!(
            local_return_type(&lines, 1, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// 版本键缓存协议:同键同文命中缓存(两次查询同值)。
    #[test]
    fn version_key_cache_hit() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\ndata = make()\n");
        let key = "local-return:cache-hit";
        let first = local_return_type(&lines, 3, None, &"data".encode_utf16().collect::<Vec<u16>>(), Some(key))
            .expect("首查命中");
        let second = local_return_type(&lines, 3, None, &"data".encode_utf16().collect::<Vec<u16>>(), Some(key))
            .expect("缓存复用命中");
        assert_eq!(first, second);
        crate::self_flow::reset_self_attribute_flow_parse_cache_for_tests();
    }

    // ---- KBUG-SCOPE(词法作用域链:参数遮蔽/边界/global/nonlocal)----

    /// SCOPE-01:模块层 `x = make()` 不得借给 `def run(x)` 参数位。
    #[test]
    fn kbug_scope_param_shadow_blocks_module_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run(x):\n    return x\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// SCOPE-01:vararg/仅关键字/kwarg 参数同员遮蔽(全参数位一律本域绑定)。
    #[test]
    fn kbug_scope_vararg_kwonly_kwarg_params_block() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run(a: Widget, *rest, x=None, **kw):\n    return x\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// SCOPE-02:读前于写(UnboundLocal 位)不借模块层同名绑定。
    #[test]
    fn kbug_scope_unbound_local_position_not_borrow_outer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run():\n    return x\n\n    x = mystery()\n",
        );
        assert!(
            local_return_type(&lines, 6, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// SCOPE-02:函数内写点不可解即止,不退借外层有类型绑定。
    #[test]
    fn kbug_scope_local_unresolvable_write_blocks_module() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run():\n    x = mystery()\n    return x\n",
        );
        assert!(
            local_return_type(&lines, 6, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// SCOPE-02:lambda 参数遮蔽模块层绑定(直接赋值 lambda 自成一域)。
    #[test]
    fn kbug_scope_lambda_param_shadow_blocks() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\nfn = lambda x: x\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// SCOPE-02:嵌套函数参数遮蔽(祖先链上参数同样阻断外层解)。
    #[test]
    fn kbug_scope_nested_fn_param_blocks() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef outer():\n    def inner(x):\n        return x\n    return inner\n",
        );
        assert!(
            local_return_type(&lines, 6, None, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// SCOPE-02:嵌套函数体内的写点不得被外层行借(函数边界,不外溢)。
    #[test]
    fn kbug_scope_nested_fn_write_not_visible_from_outer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef outer():\n    def inner():\n        data = make()\n    return data\n",
        );
        assert!(
            local_return_type(&lines, 6, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// SCOPE-02:def 体写点不得借给 def 结束后的模块层读。
    #[test]
    fn kbug_scope_def_body_write_not_borrowed_after_def() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef run():\n    data = make()\n\nprint(data)\n",
        );
        assert!(
            local_return_type(&lines, 6, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// SCOPE-03:global 声明的读透传模块绑定(合法借位保留)。
    #[test]
    fn kbug_scope_global_read_passes_to_module() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\n\ndef run():\n    global data\n    return data\n",
        );
        let face =
            local_return_type(&lines, 7, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("global 声明的读应透传模块层写点");
        assert_eq!(face.annotation, "Tree");
    }

    /// SCOPE-03:global 声明的函数内重赋值按模块名空间最近写点裁定
    /// (重赋值为字面量 → 诚实空,不回借更早答案)。
    #[test]
    fn kbug_scope_global_reassigned_literal_stops_earlier() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\n\ndef run():\n    global data\n    data = 1\n    return data\n",
        );
        assert!(
            local_return_type(&lines, 8, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// SCOPE-03:nonlocal 透传外层函数域写点(闭包链合法读保留)。
    #[test]
    fn kbug_scope_nonlocal_reads_enclosing_function_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef outer():\n    data = make()\n    def inner():\n        nonlocal data\n        return data\n    return inner\n",
        );
        let face =
            local_return_type(&lines, 7, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("nonlocal 读应解向外层函数域写点");
        assert_eq!(face.annotation, "Tree");
    }

    /// SCOPE-04:类体直系读读本类体写点(执行期顺序命名空间,合法保留)。
    #[test]
    fn kbug_scope_class_body_hover_reads_own_class_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nclass A:\n    data = make()\n    more = data\n",
        );
        let face =
            local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("类体直系读应读本类体写点");
        assert_eq!(face.annotation, "Tree");
    }

    /// SCOPE-04:他类类体写点不借(B 体读不到 A 体)。
    #[test]
    fn kbug_scope_other_class_body_not_borrowed() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nclass A:\n    data = make()\n\nclass B:\n    more = data\n",
        );
        assert!(
            local_return_type(&lines, 7, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    // ---- KBUG-BIND(调用目标绑定先于声明表)----

    /// BIND-01:被调名被参数遮蔽——`def run(make)` 内 `make()` 不借模块
    /// def 注解(动态 callable 未知)。
    #[test]
    fn kbug_bind_param_shadow_blocks_def_annotation() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef run(make):\n    data = make()\n    return data\n",
        );
        assert!(
            local_return_type(&lines, 4, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// BIND-01 守卫:未遮蔽的 `make()` 照常命中模块 def 注解。
    #[test]
    fn kbug_bind_unshadowed_call_still_hits() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef run():\n    data = make()\n    return data\n",
        );
        let face =
            local_return_type(&lines, 4, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("未遮蔽调用应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// BIND-02:裸名调用先解析当前位置绑定——域内先行赋值(`fetch =
    /// mystery`)遮蔽模块 def 声明表(mystery 无声明 → 诚实空)。
    #[test]
    fn kbug_bind_local_rebind_by_assignment_blocks_def_table() {
        let lines = lines_of(
            "def fetch() -> Tree:\n    return None\n\ndef run():\n    fetch = mystery\n    data = fetch()\n    return data\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// BIND-02:域内局部 def 遮蔽模块同名声明表(无注解局部 def → 诚实空)。
    #[test]
    fn kbug_bind_local_def_shadows_module_def() {
        let lines = lines_of(
            "def fetch() -> Tree:\n    return None\n\ndef run():\n    def fetch():\n        pass\n    data = fetch()\n    return data\n",
        );
        assert!(
            local_return_type(&lines, 6, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// BIND-02 守卫:调用位置在绑定之前 → 声明表照常(前向合法,不因
    /// 域内存在绑定就一刀切)。
    #[test]
    fn kbug_bind_call_before_binding_still_declared() {
        let lines = lines_of(
            "def fetch() -> Tree:\n    return None\n\ndef run():\n    data = fetch()\n    fetch = mystery\n    return data\n",
        );
        let face =
            local_return_type(&lines, 4, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("绑定前的调用应照常走声明表");
        assert_eq!(face.annotation, "Tree");
    }

    /// BIND-02:别名透传——`fetch = real`(real 有注解)后 `fetch()` 命中
    /// real 的注解面(绑定值为函数名身份原子)。
    #[test]
    fn kbug_bind_alias_to_annotated_fn_passes_through() {
        let lines = lines_of(
            "def real() -> Tree:\n    return None\n\ndef run():\n    fetch = real\n    data = fetch()\n    return data\n",
        );
        let face =
            local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("别名绑定到有注解函数应透传注解");
        assert_eq!(face.annotation, "Tree");
    }

    /// BIND-03:模块层类名重绑定 `A = B` 后 `A.load()` 不沿用旧 A 注解
    /// (绑定值原子为 B;B 类值链解不出方法面 → 诚实空,绝不含旧 int)。
    #[test]
    fn kbug_bind_module_class_rebind_does_not_keep_old_annotation() {
        let lines = lines_of(
            "class A:\n    def load(self) -> int:\n        return None\n\nclass B:\n    def load(self) -> str:\n        return None\n\nA = B\ndata = A.load(A())\n",
        );
        assert!(
            local_return_type(&lines, 9, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// BIND-03:模块层重绑定为未知名 `A = unknown` 后同样不沿用原类。
    #[test]
    fn kbug_bind_module_rebind_to_unknown_honest() {
        let lines = lines_of(
            "class A:\n    def load(self) -> int:\n        return None\n\nA = unknown\ndata = A.load(A())\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// BIND-04 守卫:原始类静态方法(名未绑定)照常命中类限定面。
    #[test]
    fn kbug_bind_original_class_qualified_still_hits() {
        let lines = lines_of(
            "class Repo:\n    @staticmethod\n    def load() -> Row:\n        return None\n\nr = Repo.load()\n",
        );
        let face =
            local_return_type(&lines, 5, None, &"r".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("未绑定类名的类限定调用应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    /// BIND-03(裸名形态):模块层 `make = mystery` 重绑定后 `make()` 不借
    /// 模块 def 注解。
    #[test]
    fn kbug_bind_module_name_rebind_blocks_def_annotation() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nmake = mystery\ndata = make()\n",
        );
        assert!(
            local_return_type(&lines, 4, None, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    // ---- KBUG-CFGFLOW(分支可达性/合流/终止/循环异常保守/查询位)----

    /// CFGFLOW-01/02:`if False` 内 str 写点不污染外部 int 面(静态死分支
    /// 不可达,不产出口)。
    #[test]
    fn kbug_cfgflow_if_false_write_not_pollute() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif False:\n    x = other()\nprint(x)\n",
        );
        let face = local_return_type(
            &lines,
            9,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("可达 int 写点应命中");
        assert_eq!(face.annotation, "Tree");
        assert_eq!(face.method_name, "make");
    }

    /// CFGFLOW-01 守卫:`if True` = 静态确定分支,str 写点确定生效。
    #[test]
    fn kbug_cfgflow_if_true_definite_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif True:\n    x = other()\nprint(x)\n",
        );
        let face = local_return_type(
            &lines,
            9,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("if True 确定写点应命中");
        assert_eq!(face.annotation, "Rock");
    }

    /// CFGFLOW-03 守卫:if/else 两支同面(同调用)→ 合流仍命中。
    #[test]
    fn kbug_cfgflow_if_else_same_face_confluence() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nif cond:\n    x = make()\nelse:\n    x = make()\nprint(x)\n",
        );
        let face = local_return_type(
            &lines,
            7,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("两支同面合流应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// CFGFLOW-03:if/else 两支不同面 → 未知,不按源码先后任取最后一支。
    #[test]
    fn kbug_cfgflow_if_else_differ_honest_unknown() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nif cond:\n    x = make()\nelse:\n    x = other()\nprint(x)\n",
        );
        assert!(
            local_return_type(&lines, 10, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "两支不同面应未知"
        );
    }

    /// CFGFLOW-03:无 else 条件分支 → 入口值路径并入,候选不同 → 未知。
    #[test]
    fn kbug_cfgflow_no_else_differ_honest() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif cond:\n    x = other()\nprint(x)\n",
        );
        assert!(
            local_return_type(&lines, 9, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "无 else 分支候选不同应未知"
        );
    }

    /// CFGFLOW-03:仅条件分支赋值(无入口写点)→ 可能未绑定,诚实空。
    #[test]
    fn kbug_cfgflow_cond_only_write_maybe_unbound() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nif cond:\n    x = make()\nprint(x)\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "可能未绑定路径应诚实空"
        );
    }

    /// CFGFLOW-04:终止分支(return)出口不达语句后 → 只合流可达路径。
    #[test]
    fn kbug_cfgflow_terminated_branch_excluded() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\ndef run():\n    x = make()\n    if cond:\n        x = other()\n        return\n    print(x)\n",
        );
        let face = local_return_type(
            &lines,
            11,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("终止分支剔除后应命中可达路径");
        assert_eq!(face.annotation, "Tree");
    }

    /// CFGFLOW-04:嵌套 def 的 return 不终止外层路径(函数边界清楚)。
    #[test]
    fn kbug_cfgflow_nested_def_return_not_terminate_outer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\ndef run():\n    x = make()\n    if cond:\n        def inner():\n            return\n        x = other()\n    print(x)\n",
        );
        assert!(
            local_return_type(&lines, 12, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "嵌套 return 不终止外层:两支候选不同应未知"
        );
    }

    /// CFGFLOW-02:前序无条件终止后的写点不可达;不可达位查询诚实空。
    #[test]
    fn kbug_cfgflow_after_return_unreachable_honest() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\ndef run():\n    x = make()\n    return\n    x = other()\n    print(x)\n",
        );
        assert!(
            local_return_type(&lines, 10, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "终止后不可达写点不应命中"
        );
    }

    /// CFGFLOW-05:循环保守(0 次执行入口值 + ≥1 次体出口并集),候选不同
    /// → 未知,绝不回退最后文本写点。
    #[test]
    fn kbug_cfgflow_loop_conservative() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nfor i in items:\n    x = other()\nprint(x)\n",
        );
        assert!(
            local_return_type(&lines, 9, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "循环后候选不同应未知"
        );
    }

    /// CFGFLOW-05:循环体内读位前于写点 → 环回保守(≥2 次迭代可见前轮
    /// 写点),未知,绝不回退文本首写点。
    #[test]
    fn kbug_cfgflow_loop_body_read_before_write_conservative() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nfor i in items:\n    print(x)\n    x = other()\n",
        );
        assert!(
            local_return_type(&lines, 8, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "循环体环回候选应未知"
        );
    }

    /// CFGFLOW-05:try/except 保守并集(异常路径入口值 + try 体出口),
    /// 候选不同 → 未知。
    #[test]
    fn kbug_cfgflow_try_conservative() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\ntry:\n    x = other()\nexcept ValueError:\n    pass\nprint(x)\n",
        );
        assert!(
            local_return_type(&lines, 11, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "try 保守候选不同应未知"
        );
    }

    /// CFGFLOW-06:查询位流敏感——分支前/分支内/合流后各得路径结果;
    /// 直线推断保持通过。
    #[test]
    fn kbug_cfgflow_positions_flow_sensitive() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif cond:\n    print(x)\n    x = other()\ny = x\n",
        );
        // 分支前:直线确定
        let face = local_return_type(
            &lines,
            6,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("分支前直线写点应命中");
        assert_eq!(face.annotation, "Tree");
        // 分支内读位前于写:入口值直达
        let face = local_return_type(
            &lines,
            8,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("分支内入口值应命中");
        assert_eq!(face.annotation, "Tree");
        // 合流后:候选不同 → 未知
        assert!(
            local_return_type(&lines, 10, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "合流后候选不同应未知"
        );
    }

    /// CFGFLOW-01/02:静态死分支内查询 = 不可达位,诚实空(绝不解析死写点)。
    #[test]
    fn kbug_cfgflow_query_in_dead_branch_honest() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nif False:\n    x = make()\n    print(x)\n",
        );
        assert!(
            local_return_type(&lines, 5, None, &"x".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none(),
            "死分支内查询应诚实空"
        );
    }

    // ---- KBUG-ORDER:同行赋值顺序 / 查询列精度(流值以 Pos(行,UTF-16 列)裁定)----

    fn wu16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect::<Vec<u16>>()
    }

    /// ORDER-01:同行别名不吞未来写点。`y = a(); x = y; y = b()` 同行,x 的
    /// 别名回溯只见其 RHS 之前的 y 绑定(a 的 int),同行后续 `y = b()` 不可见;
    /// 反转语句顺序后答案随真实执行序改变。
    #[test]
    fn kbug_order_same_line_alias_future_value() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    y = a(); x = y; y = b()\n    return x\n",
        );
        // 悬 return x 的 x(行 8 列 11):x 写点在同行 y=b() 之前,别名解 y=a() 的 int
        let face = local_return_type(&lines, 8, Some(11), &wu16("x"), None)
            .expect("同行别名应命中 a 的 int");
        assert_eq!(face.annotation, "int");
        assert_eq!(face.method_name, "a");

        // 反转:y = b(); x = y; y = a() → str(随真实执行序)
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    y = b(); x = y; y = a()\n    return x\n",
        );
        let face = local_return_type(&lines, 8, Some(11), &wu16("x"), None)
            .expect("同行别名应命中 b 的 str");
        assert_eq!(face.annotation, "str");
        assert_eq!(face.method_name, "b");
    }

    /// ORDER-01 分行版:别名回溯不越过写点 RHS 之后的新绑定。
    #[test]
    fn kbug_order_multiline_alias_future_value() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    y = a()\n    x = y\n    y = b()\n    return x\n",
        );
        let face = local_return_type(&lines, 10, Some(11), &wu16("x"), None)
            .expect("别名应命中 a 的 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-05:同行读前于写不混。`print(x); x = b()`——悬 print 内 x(显式
    /// 列)= 读前写点,诚实空;悬 x 目标 = 新值 str;悬 RHS 内 b 前 x = 旧值
    /// (此处无旧绑定,诚实空);缺列 = 保守回退行首非空白列(诚实空),绝不
    /// 默认整行末写点。
    #[test]
    fn kbug_order_read_before_write_same_line() {
        let lines = lines_of(
            "def b() -> str:\n    return None\n\ndef run():\n    print(x); x = b()\n",
        );
        // 悬 print(x) 的 x(列 10):写点未执行 → UnboundLocal 诚实空
        assert!(
            local_return_type(&lines, 4, Some(10), &wu16("x"), None).is_none(),
            "读前写点应诚实空"
        );
        // 悬 x 目标(列 14):目标位先于 RHS = 新值 str
        let face = local_return_type(&lines, 4, Some(14), &wu16("x"), None)
            .expect("悬目标应见新值");
        assert_eq!(face.annotation, "str");
        // 悬 x = b() 的 RHS 内(列 18):语句内读旧值 → 无旧绑定诚实空
        assert!(
            local_return_type(&lines, 4, Some(18), &wu16("x"), None).is_none(),
            "RHS 内读应见旧值(此处未绑定)"
        );
        // 缺列:保守回退行首非空白列(列 4 = print 语句内)→ 诚实空
        assert!(
            local_return_type(&lines, 4, None, &wu16("x"), None).is_none(),
            "缺列应保守,不得默认整行末写点"
        );
        // 写后读(下一行):str 照常命中
        let lines2 = lines_of(
            "def b() -> str:\n    return None\n\ndef run():\n    print(x); x = b()\n    return x\n",
        );
        let face = local_return_type(&lines2, 5, Some(11), &wu16("x"), None)
            .expect("写后读应命中 str");
        assert_eq!(face.annotation, "str");
    }

    /// ORDER-05:写后读同行不混。`x = a(); print(x)` 悬 print 内 x → int。
    #[test]
    fn kbug_order_write_then_read_same_line() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef run():\n    x = a(); print(x)\n",
        );
        // `    x = a(); print(x)`:print 内 x 列 14
        let face = local_return_type(&lines, 4, Some(14), &wu16("x"), None)
            .expect("写后读应命中 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-03:元组同时赋值。`x, y = y, x` 交换——悬 x 目标 = 旧 y 的面(str),
    /// 悬 y 目标 = 旧 x 的面(int);同行内互读按 RHS 元素位裁定,不吞对方。
    #[test]
    fn kbug_order_tuple_swap_reads_pre_values() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\nx = a()\ny = b()\nx, y = y, x\n",
        );
        // 悬 x 目标(行 8 列 0):解旧 y → str
        let face = local_return_type(&lines, 8, Some(0), &wu16("x"), None)
            .expect("交换悬 x 应见旧 y 的 str");
        assert_eq!(face.annotation, "str");
        // 悬 y 目标(行 8 列 3):解旧 x → int
        let face = local_return_type(&lines, 8, Some(3), &wu16("y"), None)
            .expect("交换悬 y 应见旧 x 的 int");
        assert_eq!(face.annotation, "int");
        // 悬同行 RHS 元素区(行 8 列 9,x 元素前):同时赋值未完成 → 旧值
        // (x=a() 的 int),不吞本句新绑定
        let face = local_return_type(&lines, 8, Some(9), &wu16("x"), None)
            .expect("交换 RHS 域内读旧值应见 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-03:链式赋值 `x = y = make()`——各目标同 RHS,先后悬两目标均 Tree;
    /// 后续别名 z = y 照常透传。
    #[test]
    fn kbug_order_chained_assignment_targets() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = y = make()\nz = y\n",
        );
        let face = local_return_type(&lines, 3, Some(0), &wu16("x"), None)
            .expect("链式 x 应命中");
        assert_eq!(face.annotation, "Tree");
        let face = local_return_type(&lines, 3, Some(4), &wu16("y"), None)
            .expect("链式 y 应命中");
        assert_eq!(face.annotation, "Tree");
        let face = local_return_type(&lines, 4, Some(0), &wu16("z"), None)
            .expect("链式后别名应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// ORDER-03 自引用:`x = x` 不吞本写点——RHS 读旧值,此前绑定的面保留
    /// (旧引擎线粒度把自己写点选为最近解 → 环防诚实空;现按 RHS 位时间边界
    /// 解出前值)。
    #[test]
    fn kbug_order_self_reference_reads_prior_binding() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\nx = a()\nx = x\n",
        );
        // 悬 x = x 的目标(列 0):新值 = 旧值 = int(自引用保面)
        let face = local_return_type(&lines, 3, Some(0), &wu16("x"), None)
            .expect("自引用应保留前值 int");
        assert_eq!(face.annotation, "int");
        // 悬下一行(写后):同 int
        let face = local_return_type(&lines, 4, Some(0), &wu16("x"), None)
            .expect("自引用后读应命中 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-05:多行 RHS——悬续行(语句未完)= 语句内读旧值(前一绑定 int);
    /// 悬语句后 = 新值 Tree。
    #[test]
    fn kbug_order_multiline_rhs_reads_old_then_new() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef make() -> Tree:\n    return None\n\nx = a()\nx = make(\n    1, 2)\nprint(x)\n",
        );
        // 悬 RHS 首行 (7,4):x = make( 语句域内且过 RHS 起始位 → 旧值 int
        let face = local_return_type(&lines, 7, Some(4), &wu16("x"), None)
            .expect("多行 RHS 内读应见旧值 int");
        assert_eq!(face.annotation, "int");
        // 悬续行参数区 (8,5):语句仍未完成 → 旧值 int
        let face = local_return_type(&lines, 8, Some(5), &wu16("x"), None)
            .expect("续行参数区读应见旧值 int");
        assert_eq!(face.annotation, "int");
        // 悬语句完成后的 print(x)(行 9 列 6):新值 Tree
        let face = local_return_type(&lines, 9, Some(6), &wu16("x"), None)
            .expect("语句后读应见新值 Tree");
        assert_eq!(face.annotation, "Tree");
    }

    /// ORDER-05:emoji 行 UTF-16 列(代理对计 2)——同行多写点按 UTF-16 列
    /// 分序,字符数口径会错位。
    #[test]
    fn kbug_order_emoji_utf16_columns() {
        // `    d = "🚀"; x = a(); x = b()`:d=4, 🚀 占 UTF-16 两单元(9-10),
        // 第一个 x=14,第二个 x=23(字符口径会算成 22)
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    d = \"🚀\"; x = a(); x = b()\n",
        );
        // 悬第一个 x 目标(列 14)→ int
        let face = local_return_type(&lines, 7, Some(14), &wu16("x"), None)
            .expect("emoji 行第一写点应命中 int");
        assert_eq!(face.annotation, "int");
        // 悬第二个 x 前空位(列 22):x = b() 未到 → 仍 int
        let face = local_return_type(&lines, 7, Some(22), &wu16("x"), None)
            .expect("列 22 应仍在第一写点 int");
        assert_eq!(face.annotation, "int");
        // 悬第二个 x 目标(列 23,UTF-16)→ str
        let face = local_return_type(&lines, 7, Some(23), &wu16("x"), None)
            .expect("emoji 行第二写点应命中 str");
        assert_eq!(face.annotation, "str");
    }

    /// ORDER-05:行尾注释——悬注释内 x(语句早已完成)= 新值生效(注释非
    /// 语句域,不判 RHS 边界)。
    #[test]
    fn kbug_order_comment_hover_after_statement() {
        let lines = lines_of("def a() -> int:\n    return None\n\nx = a()  # x\n");
        // `x = a()  # x`:注释内 x 列 11
        let face = local_return_type(&lines, 3, Some(11), &wu16("x"), None)
            .expect("注释悬停应见已生效写点");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-03 未支持形态明确未知:`x, y = pair`(右非等长元组字面量)走
    /// 通用形态,交换配对不成立时不硬造对应面(悬 x 解 RHS 整体形态——
    /// 未支持 = 诚实空)。
    #[test]
    fn kbug_order_unsupported_tuple_shape_honest() {
        let lines = lines_of("def pair() -> tuple:\n    return None\n\nx, y = pair()\n");
        assert!(
            local_return_type(&lines, 3, Some(0), &wu16("x"), None).is_none(),
            "非配对元组解包应诚实空"
        );
    }
}
