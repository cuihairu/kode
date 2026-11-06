//! 调用图聚合 + 供 kode-scheduler 失效 DAG 消费的反向索引(C-20 交付③)。
//!
//! - [`PyCallGraph`] 单文件(或聚合)调用边集合,提供查询面:
//!   `callers_of`(被调名 → 调用点列表,即「改方法签名→受影响调用点全数列出」)、
//!   `calls_of`(调用方 → 出边);
//! - [`CallReverseIndex`] 被调方文件 → 调用方文件集,直接喂给
//!   kode-scheduler 的 `InvalidationGraph::with_call_dependents`(跨文件反依赖,
//!   使 `affected_by` 纳入「改被调方文件 → 重算调用方文件」)。
//!
//! 跨文件被调方解析是启发式(动态语言):裸名 → 全项目模块级函数;`self.*` →
//! 调用方自身文件;模块绑定接收者 → 按文件名解析模块;未知 → 不产反依赖
//! (宁缺毋滥,避免误失效)。

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use kode_vfs::store::DocumentKey;

use crate::model::{AstSymbols, CallEdge};

/// 调用图(按文件分组或聚合)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PyCallGraph {
    pub edges: Vec<CallEdge>,
}

impl PyCallGraph {
    pub fn new(edges: Vec<CallEdge>) -> PyCallGraph {
        PyCallGraph { edges }
    }

    /// 被调名 → 调用点(升序;「改方法签名→受影响调用点全数列出」)。
    pub fn callers_of(&self, callee: &str) -> Vec<&CallEdge> {
        let mut v: Vec<&CallEdge> = self.edges.iter().filter(|e| e.callee == callee).collect();
        v.sort_by_key(|e| (e.caller.clone(), e.caller_line));
        v
    }

    /// 调用方 → 出边(升序;无该调用方 → 空)。
    pub fn calls_of(&self, caller: &str) -> Vec<&CallEdge> {
        let mut v: Vec<&CallEdge> = self.edges.iter().filter(|e| e.caller == caller).collect();
        v.sort_by_key(|e| e.caller_line);
        v
    }

    /// 特定 EdgeKind 的边(可视化面板按类别着色用)。
    pub fn of_kind(&self, kind: crate::model::EdgeKind) -> Vec<&CallEdge> {
        self.edges.iter().filter(|e| e.kind == kind).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }
}

/// 被调方文件 → 调用方文件集(kode-scheduler 消费的跨文件反依赖)。
pub type CallReverseIndex = BTreeMap<DocumentKey, BTreeSet<DocumentKey>>;

/// 构建跨文件调用反依赖。
///
/// - `file_edges`:每文件的调用边(来自 [`crate::callgraph::extract_call_graph`]);
/// - `file_symbols`:每文件 AST 符号表(跨文件被调方解析用)。
///
/// 启发式解析(见模块头);返回被调方文件 → 调用方文件集,可作
/// `InvalidationGraph::with_call_dependents` 的输入。
pub fn build_call_reverse_index(
    file_edges: &BTreeMap<DocumentKey, Vec<CallEdge>>,
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
) -> CallReverseIndex {
    let mut rev: CallReverseIndex = BTreeMap::new();
    for (caller_file, edges) in file_edges {
        for edge in edges {
            let callee_file = resolve_callee_file(caller_file, edge, file_symbols);
            if let Some(callee_file) = callee_file {
                if callee_file != *caller_file {
                    rev.entry(callee_file)
                        .or_default()
                        .insert(caller_file.clone());
                }
            }
        }
    }
    rev
}

/// 跨进程边(`self.cell.*`/`self.base.*`/`self.client.*`)所在调用方文件集(RUST-7 uncertain 面)。
///
/// 这些调用方有跨进程调用边,但被调方文件无法静态解析(见
/// [`resolve_callee_file`] 的 KbeCrossProcess 短路),故不进
/// [`build_call_reverse_index`] 的反向失效索引——另一进程侧文件变更不会
/// 经调用边触发这些文件重扫。消费方可将本集并入保守重扫面(如 profile/
/// 配置变更时全量重扫这些文件)。
pub fn uncertain_cross_process_files(
    file_edges: &BTreeMap<DocumentKey, Vec<CallEdge>>,
) -> BTreeSet<DocumentKey> {
    file_edges
        .iter()
        .filter(|(_, edges)| {
            edges
                .iter()
                .any(|e| e.kind == crate::model::EdgeKind::KbeCrossProcess)
        })
        .map(|(k, _)| k.clone())
        .collect()
}

/// 解析被调方所在文件(启发式;None = 无法解析/外部/歧义)。
fn resolve_callee_file(
    caller_file: &DocumentKey,
    edge: &CallEdge,
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
) -> Option<DocumentKey> {
    let receiver = edge.receiver.as_deref().unwrap_or("");
    // KbeCrossProcess(`self.cell.*`/`self.base.*`/`self.client.*`):base↔cell↔client 间接经配置关联,
    // 被调方文件无法静态解析(实体类在另一进程侧的文件里,边里没有类名/文件名)。
    // 旧实现落进下方 `self.` 分支按「同类」折叠回调用方文件,等于把跨进程边
    // 无声丢弃。RUST-7:显式短路返回 None(行为不变:反索引不产边),但语义
    // 不再冒充同类调用;uncertain 面由 [`uncertain_cross_process_files`]
    // 单独标出,消费方可用它做保守重扫。TODO(设计现状):无日志门面(workspace
    // 零第三方依赖铁律),warn 以查询面代替;若未来接入日志,在此处记 warn。
    if edge.kind == crate::model::EdgeKind::KbeCrossProcess {
        return None;
    }
    if receiver == "self" || receiver.starts_with("self.") {
        // 自身类方法/属性 → 调用方文件(同类,非跨文件;返回自身以便上层折叠)
        return Some(caller_file.clone());
    }
    if receiver.is_empty() {
        // KODE-AUD-008:裸名调用——若调用方文件自身定义了该模块级函数,
        // 则为本地调用,不产跨文件边(防伪边:旧实现全项目搜会先命中
        // 同名函数所在文件,把本地调用误指为跨文件)。
        if caller_defines_function(caller_file, file_symbols, &edge.callee) {
            return None;
        }
        return find_module_function(file_symbols, &edge.callee, caller_file);
    }
    // 模块绑定接收者:`module.func` → 按模块名找文件(排除调用方自身)。
    // KODE-AUD-008 复审残余:接收者首段也可能是实例变量(`avatar.heal()`,
    // avatar 是局部对象而非模块)——不经 import 绑定核验就按 basename 找
    // 文件,会把唯一同名文件误指为被调方(伪跨文件边)。绑定核验按调用点
    // 可见作用域:模块顶层绑定(imports 表,全文件可见)+调用方函数自身
    // 子树的 import(函数内 `import avatar` 也是真绑定;文件级合并会让
    // 无关函数的导入为实例接收者作保,复审第三轮残余)。未绑定 → 静态
    // 不可解析,宁缺毋滥不产边。
    if let Some(module) = receiver.split('.').next() {
        let imported = file_symbols
            .get(caller_file)
            .map(|s| {
                s.imports.iter().any(|i| i.binding == module)
                    || s.function_import_bindings.iter().any(|scope| {
                        scope.start_line <= edge.caller_line
                            && edge.caller_line <= scope.end_line
                            && scope.bindings.contains(module)
                    })
            })
            .unwrap_or(false);
        if imported {
            return find_module_file(file_symbols, module, caller_file);
        }
        return None;
    }
    None
}

/// 调用方文件是否定义模块级函数 `name`(本地调用判定)。
fn caller_defines_function(
    caller_file: &DocumentKey,
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
    name: &str,
) -> bool {
    file_symbols
        .get(caller_file)
        .map(|s| s.functions.iter().any(|f| f.name == name))
        .unwrap_or(false)
}

/// 全项目搜模块级函数 `name`(排除 `exclude` 调用方文件),恰一个定义 → 有;
/// 零个或多个(歧义,宁缺毋滥避免误失效)→ None。
fn find_module_function(
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
    name: &str,
    exclude: &DocumentKey,
) -> Option<DocumentKey> {
    let mut found: Vec<DocumentKey> = file_symbols
        .iter()
        .filter(|(k, _)| *k != exclude)
        .filter(|(_, s)| s.functions.iter().any(|f| f.name == name))
        .map(|(k, _)| k.clone())
        .collect();
    if found.len() == 1 {
        found.pop()
    } else {
        None
    }
}

/// 按模块绑定名(如 `os`、`utils`)找文件(basename 去 .py 匹配,排除
/// `exclude` 调用方自身);恰一个匹配 → 有,歧义/零 → None。
fn find_module_file(
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
    module: &str,
    exclude: &DocumentKey,
) -> Option<DocumentKey> {
    let mut found: Vec<DocumentKey> = file_symbols
        .iter()
        .filter(|(k, _)| *k != exclude)
        .filter(|(k, _)| {
            k.uri
                .basename()
                .strip_suffix(".py")
                .map(|stem| stem == module)
                .unwrap_or(false)
        })
        .map(|(k, _)| k.clone())
        .collect();
    if found.len() == 1 {
        found.pop()
    } else {
        None
    }
}
