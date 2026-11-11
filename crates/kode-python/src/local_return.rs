//! 批 D 返回注解接收者级联修正(精确性主车道):`$/kode/python/localReturnType`
//! 引擎本体。同文件接收者定型解析——TS 级联兜底(cascadeAnnotation 全局方法名
//! 猜测,跨类误绑实测误导 #2)删除后,同文件可推导子集由本面接住:
//!
//! - 域门:自 hover 行向上、def/class 名行缩进窄化(TS matchingAssignments
//!   同域口径——方法体 → 类体 → 模块层逐级放行,兄弟方法体/深层块不借);
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
    resolve_shape, BareWrite, CalleeShape, DefReturn, FlowParse, ResolveState, RhsShape,
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

/// 接收者定型解析入口(纯函数;versionKey 协议与流面同)。
/// None = hover 词无可推导返回注解(诚实空,不显示)。
pub fn local_return_type(
    lines: &[Vec<u16>],
    hover_line: usize,
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
    face_scan(&fp, &mut state, lines, hover_line, &word, 0, &mut visited).map(|mut face| {
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

/// 行首缩进(空格/Tab 计数;TS `text.length - trimStart().length` 同口径——
/// 代码行首部只有空白,掩码不改缩进)。
fn line_indent(line: &[u16]) -> usize {
    line.iter().take_while(|&&c| c == 0x20 || c == 0x09).count()
}

/// 域门扫描(matchingAssignments 镜像):自 start 行向上;`indent < limit` 才
/// 视为域内候选;def/class 名行把 limit 窄化到 `行缩进 + 1`(放行外层域)。
/// 写点判定在头行窄化之前(同行复合语句与 TS 同序)。
fn face_scan(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    start_line: usize,
    word: &str,
    depth: usize,
    visited: &mut HashSet<(usize, String)>,
) -> Option<LocalReturnFace> {
    if depth > FACE_MAX_HOPS {
        return None;
    }
    let writes = fp.bare_writes.get(word)?;
    let start = start_line.min(lines.len() - 1);
    let mut scope_indent_limit = usize::MAX;
    for line in (0..=start).rev() {
        let indent = line_indent(&lines[line]);
        if indent < scope_indent_limit {
            // 该行该词的写点(同行多条语句源序取最后 = 执行序最近写)
            if let Some(write) = writes.iter().rev().find(|w| w.line == line) {
                if !visited.insert((line, word.to_string())) {
                    return None; // `x = x` 身份链/重复解同一写点 → 诚实空
                }
                return resolve_face_shape(fp, state, lines, write, depth, visited);
            }
        }
        if fp.header_lines.contains(&line) {
            scope_indent_limit = scope_indent_limit.min(indent + 1);
        }
    }
    None
}

/// 最近写点 RHS → 面答案。调用形态直取注解;别名链同域递归;其余形态
/// (字面量/属性读/未知)诚实空。
fn resolve_face_shape(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    write: &BareWrite,
    depth: usize,
    visited: &mut HashSet<(usize, String)>,
) -> Option<LocalReturnFace> {
    match &write.shape {
        RhsShape::Call(callee) => face_from_callee(fp, state, write, callee),
        RhsShape::Local(alias) => {
            // 别名链:同域口径解别名名的最近写点(每跳严格下行,天然有界)
            face_scan(fp, state, lines, write.line, alias, depth + 1, visited)
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
            // 实例化的类名不是返回注解,面语义不答)
            match fp.def_returns.get(f)? {
                DefReturn::Single(Some(ann)) => (ann.clone(), f.clone()),
                _ => return None,
            }
        }
        CalleeShape::SelfMethod(m) => {
            // 所在类方法表;类体直系/模块域写点无类语境 → 诚实空
            let cls = write.class_start?;
            (state.method_atom(cls, m)?, m.clone())
        }
        CalleeShape::Qualified { class, method } => {
            if let Some(cls) = state.unique_class(class) {
                (state.method_atom(cls, method)?, method.clone())
            } else {
                // 裸名接收者二义(批 D):非类名 → 局部/模块变量原子链
                // (与流面 resolve_callee 同优先级:类限定先,变量链后)
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
                let atom = atoms.iter().next().unwrap();
                let cls = state.unique_class(atom)?;
                (state.method_atom(cls, method)?, method.clone())
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
            let atom = atoms.iter().next().unwrap();
            let cls = state.unique_class(atom)?;
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
        let face = local_return_type(&lines, 3, &"data".encode_utf16().collect::<Vec<u16>>(), None)
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
        let face = local_return_type(&lines, 5, &"data".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("self.m() 所在类限定应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "get");
    }

    #[test]
    fn qualified_class_method_call() {
        let lines = lines_of(
            "class Repo:\n    @staticmethod\n    def load() -> Row:\n        return None\n\nr = Repo.load()\n",
        );
        let face = local_return_type(&lines, 5, &"r".encode_utf16().collect::<Vec<u16>>(), None)
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
            local_return_type(&lines, 9, &"a_val".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("A.get 应命中");
        assert_eq!(face_a.annotation, "X");
        let face_b =
            local_return_type(&lines, 10, &"b_val".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("B.get 应命中");
        assert_eq!(face_b.annotation, "Y");
    }

    #[test]
    fn chained_call_via_local_alias_receiver() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\ndef make_repo() -> Repo:\n    return None\n\nrepo = make_repo()\nrow = repo.load()\n",
        );
        let face = local_return_type(&lines, 8, &"row".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("局部接收者链应命中(Repo 原子 → load 注解)");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    #[test]
    fn chained_call_inline_receiver() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\ndef make_repo() -> Repo:\n    return None\n\nrow = make_repo().load()\n",
        );
        let face = local_return_type(&lines, 7, &"row".encode_utf16().collect::<Vec<u16>>(), None)
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
        let face = local_return_type(&lines, 4, &"x".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("别名链应穿透到 f 注解");
        assert_eq!(face.annotation, "Tree");
        assert_eq!(face.method_name, "make");
    }

    /// `x = x` 身份链 → 诚实空(环防)。
    #[test]
    fn identity_alias_honest_empty() {
        let lines = lines_of("x = x\n");
        assert!(
            local_return_type(&lines, 0, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// 最近写点胜且不可解即止:重赋值字面量后不再借更早调用答案(R2-F16 同语义)。
    #[test]
    fn overwritten_by_literal_stops_earlier_answer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\ndata = 1\n",
        );
        assert!(
            local_return_type(&lines, 4, &"data".encode_utf16().collect::<Vec<u16>>(), None)
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
            local_return_type(&lines, 5, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 模块层写点放行:hover 在方法体、写点在模块层(def/class 头窄化后域内)。
    #[test]
    fn module_write_visible_from_method_body() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\n\nclass A:\n    def n(self):\n        return data\n",
        );
        let face = local_return_type(&lines, 7, &"data".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("模块层写点应被方法体 hover 借到(外层域放行)");
        assert_eq!(face.annotation, "Tree");
    }

    /// 类体直系写点同样放行(类头窄化到类体域)。
    #[test]
    fn class_body_write_visible_from_method_body() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nclass A:\n    data = make()\n\n    def n(self):\n        return data\n",
        );
        let face = local_return_type(&lines, 6, &"data".encode_utf16().collect::<Vec<u16>>(), None)
            .expect("类体直系写点应被方法体 hover 借到");
        assert_eq!(face.annotation, "Tree");
    }

    /// hover 行上的写点即候选(TS `line <= hoverLine` 含端)。
    #[test]
    fn write_on_hover_line_counts() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\ndata = make()\n");
        let face =
            local_return_type(&lines, 3, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .expect("写点行即 hover 行应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// 无注解 def → 诚实空(不硬造)。
    #[test]
    fn unannotated_def_honest_empty() {
        let lines = lines_of("def make():\n    return None\n\ndata = make()\n");
        assert!(
            local_return_type(&lines, 3, &"data".encode_utf16().collect::<Vec<u16>>(), None)
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
            local_return_type(&lines, 5, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 类实例化不是返回注解面:`data = Repo()` → 诚实空(流面产原子,本面不答)。
    #[test]
    fn class_instantiation_not_a_return_annotation() {
        let lines = lines_of("class Repo:\n    pass\n\ndata = Repo()\n");
        assert!(
            local_return_type(&lines, 3, &"data".encode_utf16().collect::<Vec<u16>>(), None)
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
            local_return_type(&lines, 5, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 常量名守卫(全大写)不查询。
    #[test]
    fn constant_name_skipped() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\nDATA = make()\n");
        assert!(
            local_return_type(&lines, 3, &"DATA".encode_utf16().collect::<Vec<u16>>(), None)
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
            local_return_type(&lines, 4, &"row".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 前向引用:hovers 行在写点之前 → 诚实空(流序)。
    #[test]
    fn forward_reference_honest_empty() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\nprint(data)\ndata = make()\n");
        assert!(
            local_return_type(&lines, 3, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 装饰器 def 名行域门:装饰器行不窄化,名行窄化(与名行口径同)。
    #[test]
    fn decorated_def_header_narrows_at_name_line() {
        let lines = lines_of(
            "def deco(fn):\n    return fn\n\n@deco\ndef make() -> Tree:\n    return None\n\ndata = make()\n",
        );
        let face = local_return_type(&lines, 7, &"data".encode_utf16().collect::<Vec<u16>>(), None)
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
            local_return_type(&lines, 4, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// hover 行越界 → None(与流面同守卫)。
    #[test]
    fn out_of_range_hover_line() {
        let lines = lines_of("data = 1\n");
        assert!(
            local_return_type(&lines, 9, &"data".encode_utf16().collect::<Vec<u16>>(), None)
                .is_none()
        );
    }

    /// 别名链环:`x = y` 与 `y = x` 互指 → 诚实空(每跳严格下行,天然有界;
    /// 防环 visited 双保险)。
    #[test]
    fn mutual_alias_cycle_honest_empty() {
        let lines = lines_of("x = y\ny = x\n");
        assert!(
            local_return_type(&lines, 1, &"x".encode_utf16().collect::<Vec<u16>>(), None).is_none()
        );
    }

    /// 版本键缓存协议:同键同文命中缓存(两次查询同值)。
    #[test]
    fn version_key_cache_hit() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\ndata = make()\n");
        let key = "local-return:cache-hit";
        let first = local_return_type(&lines, 3, &"data".encode_utf16().collect::<Vec<u16>>(), Some(key))
            .expect("首查命中");
        let second = local_return_type(&lines, 3, &"data".encode_utf16().collect::<Vec<u16>>(), Some(key))
            .expect("缓存复用命中");
        assert_eq!(first, second);
        crate::self_flow::reset_self_attribute_flow_parse_cache_for_tests();
    }
}
