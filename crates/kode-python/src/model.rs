//! 数据模型:AST 符号表 / 调用边 / def-use 链(C-20)。
//!
//! 约定:
//! - 行号一律 **0-based**(与 TS `pythonClassIndex` / LSP / kode-corpus 同口径,
//!   便于 wt/parity 直接对拍);列号 0-based UTF-16 code unit(LSP 口径)。
//! - 本模块只放纯数据形状与稳定字面量,提取逻辑在 [`crate::symbols`] /
//!   [`crate::callgraph`] / [`crate::dataflow`],对拍面 = 数据面,不允许两套语义。

/// AST 级符号表(单文件)。
///
/// 与 kode-corpus 的词法表 [`kode_corpus::PythonModule`] 同构但基于真实 AST,
/// 能区分装饰器/async/嵌套函数与继承链;`to_corpus()` 可降级到词法形状供
/// C-19 一致性检查与 wt/parity 复用(替代 C-19 自建)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstSymbols {
    /// 源总行数(与 kode-corpus 同口径:末尾换行多一空行)。
    pub line_count: usize,
    /// 模块级类声明(含嵌套?否——本表只收文件直属类,方法/属性挂在类上)。
    pub classes: Vec<AstClass>,
    /// 模块级函数(`def` 不在类内)。
    pub functions: Vec<AstFunction>,
    /// `import` / `from ... import ...` 绑定(仅模块顶层,语义表,与既有
    /// 消费面口径一致)。模块顶层绑定对全文件可见。
    pub imports: Vec<AstImport>,
    /// 函数作用域 import 绑定(按行区间定位调用点可见作用域)。每条 =
    /// 一个函数的行区间与其子树内 import 的绑定名。调用图接收者解析用
    /// 调用点行号落进哪个区间判可见性——不按函数名(同名方法会串;复审
    /// 第四轮残余),区间天然嵌套(外层区间覆盖嵌套体,闭包可见语义)。
    pub function_import_bindings: Vec<ScopeImportBindings>,
}

/// 单个函数作用域的 import 绑定(行 0-based,与仓内口径一致)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeImportBindings {
    /// 函数起始行(def 行)。
    pub start_line: usize,
    /// 函数结束行(体末行)。
    pub end_line: usize,
    /// 该函数子树内(含嵌套 def/分支体)import 的绑定名,排序去重。
    pub bindings: std::collections::BTreeSet<String>,
}

/// 类声明(AST 级)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstClass {
    pub name: String,
    /// 文件内唯一限定名(本表= `name`,嵌套类预留点分)。
    pub qualified_name: String,
    /// 基类名(只保留合法 dotted identifier 且排除 `object`,与 TS/kode-corpus 同过滤)。
    pub bases: Vec<String>,
    pub start_line: usize,
    pub end_line: usize,
    pub methods: Vec<AstMethod>,
    /// 类体内 `self.<name> = ...` 写入位置(跨方法聚合)。
    pub attributes: Vec<AstAttribute>,
    pub decorators: Vec<String>,
}

/// 类直属方法(AST 级)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstMethod {
    /// 所属类限定名。
    pub class: String,
    pub name: String,
    pub line: usize,
    pub character: usize,
    pub is_async: bool,
    /// 紧邻 `def` 的装饰器(含 `@`,源码顺序)。
    pub decorators: Vec<String>,
    /// 形参名(posonly/pos/kwonly/vararg/kwarg 顺序),不含默认值表达式。
    pub params: Vec<String>,
    /// 方法体结束行(不含);无体为 `start_line`。
    pub end_line: usize,
}

/// 模块级函数(AST 级)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstFunction {
    pub name: String,
    pub line: usize,
    pub character: usize,
    pub is_async: bool,
    pub decorators: Vec<String>,
    pub params: Vec<String>,
    pub end_line: usize,
}

/// `self.<name> = ...` 属性写入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstAttribute {
    /// 所属类限定名。
    pub class: String,
    pub name: String,
    pub line: usize,
    pub character: usize,
}

/// 导入绑定(AST 级)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstImport {
    /// 本文件内绑定名。
    pub binding: String,
    /// `from` 的模块名,或 `import` 的目标模块。
    pub module: String,
    /// `from module import symbol` 的 symbol;普通 `import` 为 `None`。
    pub symbol: Option<String>,
    pub line: usize,
    pub is_from: bool,
}

/// 调用边种类(EdgeKind)——KBEngine 特化边与普通本地/外部调用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeKind {
    /// 本地/同名模块级调用:`foo(...)` 且 foo 是本文件模块级函数或导入绑定。
    Local,
    /// 对象方法调用:`obj.method(...)`(obj 非 self 且非 KBEngine 通道)。
    Method,
    /// 自身方法调用:`self.method(...)`。
    SelfMethod,
    /// KBEngine 客户端广播:`self.allClients.<client-method>(...)`(对全部客户端)。
    KbeBroadcast,
    /// KBEngine base 客户端广播:`self.baseClients.<method>(...)`。
    KbeBaseClients,
    /// KBEngine 跨进程:`self.cell.<method>(...)`(base→cell)、`self.base.<method>(...)`(cell→base)
    /// 或 `self.client.<method>(...)`(cell→client)。
    KbeCrossProcess,
    /// KBEngine 引擎 API:`KBEngine.<api>(...)` 或 `kbengine.<api>(...)`。
    KbeApi,
    /// 外部/无法解析的调用。
    Unknown,
}

impl EdgeKind {
    /// 稳定字面量(golden 对拍出口)。
    pub const fn as_str(self) -> &'static str {
        match self {
            EdgeKind::Local => "local",
            EdgeKind::Method => "method",
            EdgeKind::SelfMethod => "self-method",
            EdgeKind::KbeBroadcast => "kbe-broadcast",
            EdgeKind::KbeBaseClients => "kbe-base-clients",
            EdgeKind::KbeCrossProcess => "kbe-cross-process",
            EdgeKind::KbeApi => "kbe-api",
            EdgeKind::Unknown => "unknown",
        }
    }
}

/// 单条调用边。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallEdge {
    /// 调用方(可为空 = 模块级/未挂类)。
    pub caller_class: Option<String>,
    /// 调用方法/函数名(方法名或模块级函数名)。
    pub caller: String,
    /// 调用点行(0-based)。
    pub caller_line: usize,
    /// 被调名(属性链末段)。
    pub callee: String,
    /// 接收者链(如 `self`、`self.cell`、`self.allClients`、`module`);纯名调用为 None。
    pub receiver: Option<String>,
    pub kind: EdgeKind,
}

/// 过程内 def-use 链(MVP:直线近似,不合并控制流分支)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefUseChain {
    /// 变量名(`x` 或 `self.attr`)。
    pub var: String,
    /// 最近一次定值行(0-based);无定值(参数/全局)为 None。
    pub def_line: Option<usize>,
    /// 使用点行(0-based,升序去重)。
    pub use_lines: Vec<usize>,
    /// 参数来源(该变量是形参时为 Some(参数索引),否则 None)。
    pub is_param: bool,
}

/// 过程内数据流结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataflowResult {
    /// 按首次出现顺序的 def-use 链。
    pub chains: Vec<DefUseChain>,
}
