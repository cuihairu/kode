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
    // 模块绑定接收者:`module.func` → 按目标模块 basename 找文件(排除调
    // 用方自身)。KODE-AUD-008 复审残余:接收者首段也可能是实例变量
    // (`avatar.heal()`,avatar 是局部对象而非模块)——不经 import 绑定核
    // 验就按 basename 找文件,会把唯一同名文件误指为被调方(伪跨文件边)。
    //
    // 绑定核验契约(保守歧义即放弃,复审第七/八/九轮定版):沿调用点所在
    // 的 Function/Comprehension 作用域层自内向外走查——
    // · 层内「只有」import 绑定且调用行不早于绑定行 → 模块绑定,按目标
    //   模块 basename(别名取目标模块名,非绑定名)放行唯一性核验;
    // · 层内有本地绑定(参数/Store 赋值;叠加 import 亦然——静态歧义)
    //   → 不产边;
    // · 层内未提及该名 → 继续向外;
    // · 全链未决 → 模块顶层回退:顶层 Store 重绑定过该名 → 不产边(第九
    //   轮残余①);否则按顶层 import 的目标 basename 唯一性核验。
    // 已知粒度限制(保守漏边向,如实记录):同一行内 lambda 参数遮蔽与
    // 外层调用行粒度不可分;调用行早于函数内 import 行时向外回退(该调用
    // 在运行时本就 UnboundLocal,边无意义)。
    if let Some(module) = receiver.split('.').next() {
        let resolved_file: Option<DocumentKey> = file_symbols
            .get(caller_file)
            .map(|s| {
                let mut in_scope: Vec<&crate::model::ScopeImportBindings> = s
                    .function_import_bindings
                    .iter()
                    .filter(|sc| {
                        sc.kind != crate::model::ScopeKind::Class
                            && sc.start_line <= edge.caller_line
                            && edge.caller_line <= sc.end_line
                    })
                    .collect();
                // 内层(起始行更大)先看;层内裁决,未决继续向外。
                in_scope.sort_by_key(|sc| std::cmp::Reverse(sc.start_line));
                let mut resolved: Option<Option<String>> = None;
                for sc in in_scope {
                    match (sc.bindings.get(module), sc.shadows.get(module)) {
                        // 本地绑定存在即本地名(Python 静态局部性);叠加
                        // import = 静态歧义,保守放弃。
                        (Some(_), Some(_)) => resolved = Some(None),
                        (Some(&(bl, ref base)), None) => {
                            if edge.caller_line >= bl {
                                resolved = Some(Some(base.clone()));
                            }
                        }
                        (None, Some(_)) => resolved = Some(None),
                        (None, None) => {}
                    }
                    if resolved.is_some() {
                        break;
                    }
                }
                match resolved {
                    Some(basename) => {
                        // Some(None)=本地/歧义不产边;Some(Some(base))=按目标
                        // basename 唯一性核验。
                        basename.and_then(|base| find_module_file(file_symbols, &base, caller_file))
                    }
                    // 作用域链未决 → 模块顶层回退:先查顶层重绑定遮蔽,再
                    // 按顶层 import 的目标 basename 唯一性核验。
                    None => {
                        if s.module_shadows.contains_key(module) {
                            return None;
                        }
                        let basename = s.imports.iter().find(|i| i.binding == module).map(
                            |imp| {
                                if imp.is_from {
                                    imp.symbol
                                        .clone()
                                        .unwrap_or_else(|| module.to_string())
                                } else {
                                    imp.module.rsplit('.').next().unwrap_or("").to_string()
                                }
                            },
                        );
                        match basename {
                            Some(base) => find_module_file(file_symbols, &base, caller_file),
                            None => None,
                        }
                    }
                }
            })
            .unwrap_or(None);
        // resolved_file 已按目标 basename 的唯一性核验结果定性。
        return resolved_file;
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
