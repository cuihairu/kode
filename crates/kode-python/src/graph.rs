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

/// 解析被调方所在文件(启发式;None = 无法解析/外部)。
fn resolve_callee_file(
    caller_file: &DocumentKey,
    edge: &CallEdge,
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
) -> Option<DocumentKey> {
    let receiver = edge.receiver.as_deref().unwrap_or("");
    if receiver == "self" || receiver.starts_with("self.") {
        // 自身类方法/属性 → 调用方文件(同类,非跨文件;返回自身以便上层折叠)
        return Some(caller_file.clone());
    }
    if receiver.is_empty() {
        // 裸名:模块级函数 → 全项目搜
        return find_module_function(file_symbols, &edge.callee);
    }
    // 模块绑定接收者:`module.func` → 按模块名找文件
    if let Some(module) = receiver.split('.').next() {
        if let Some(f) = find_module_file(file_symbols, module) {
            return Some(f);
        }
    }
    None
}

/// 全项目搜模块级函数 `name`,返回定义文件。
fn find_module_function(
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
    name: &str,
) -> Option<DocumentKey> {
    file_symbols
        .iter()
        .find(|(_, s)| s.functions.iter().any(|f| f.name == name))
        .map(|(k, _)| k.clone())
}

/// 按模块绑定名(如 `os`、`utils`)找文件(basename 去 .py 匹配)。
fn find_module_file(
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
    module: &str,
) -> Option<DocumentKey> {
    file_symbols
        .iter()
        .find(|(k, _)| {
            k.uri
                .basename()
                .strip_suffix(".py")
                .map(|stem| stem == module)
                .unwrap_or(false)
        })
        .map(|(k, _)| k.clone())
}
