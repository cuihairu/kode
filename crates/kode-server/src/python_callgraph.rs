//! `$/kode/python/callgraph` + `$/kode/python/symbols` —— Python 调用图/符号表
//! RPC(C-20 完整交付②;消费面 = src/pythonCallGraphRust.ts 与依赖图面板)。
//!
//! - callgraph:文件集(原文直传)→ 节点/调用边/跨文件反索引/过程内数据流/
//!   进程角色/统计。跨文件反索引喂 kode-scheduler `with_call_dependents`
//!   (改被调方文件 → 重算调用方文件)。
//! - symbols:文件集 → 每文件 AST 符号表(类/方法/函数/导入 + 每方法自身调用),
//!   供 C-19 方法一致性复用(替代 TS parsePythonMethodBlocks+parsePythonSelfCalls)。
//!
//! 行号口径:kode-python 0-based(行/列均 0-based UTF-16),RPC 原样透出;
//! 1-based 换算在 TS 消费点做(与 C-19 既有 IndexedPythonMethodLocation 对齐)。
//! 容错:单文件语法错误不整体失败(ruff 容错路径),错误进 `stats.errorCount`
//! / symbols 的 `errors`,能解析部分照常产出(半成品脚本友好)。
//!
//! 边界:被调方解析是启发式(动态语言),未知调用保持 `unknown` 类边,不虚构。

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::Value;

use kode_python::callgraph::{extract_call_graph, extract_call_graph_detailed, MODULE_CALLER};
use kode_python::graph::build_call_reverse_index;
use kode_python::model::{AstSymbols, CallEdge, EdgeKind};
use kode_python::parse::ParsedAst;
use kode_python::symbols::extract;
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::CanonicalUri;

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/python/callgraph", build_handler);
    reg.register("$/kode/python/symbols", symbols_handler);
}

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileInput {
    path: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallgraphParams {
    #[serde(default)]
    files: Vec<FileInput>,
    #[serde(default)]
    manifest_xml_text: Option<String>,
    /// RUST-077-W:边分页续取游标(CORE-012 输入序偏移)。缺省 0 = 首页;
    /// 同输入同游标必得同页(handler text-in 纯函数,确定性重跑)。旧调用
    /// 方不发此键 = 全量(小结果契约零变化)。
    #[serde(default)]
    edge_offset: usize,
    /// RUST-077-W:节点数组分页游标(同语义)。
    #[serde(default)]
    node_offset: usize,
    /// RUST-077-W:数据流数组分页游标(同语义)。
    #[serde(default)]
    dataflow_offset: usize,
    /// RUST-077-W:跨文件反索引条目分页游标(BTreeMap 键序确定性;条目 =
    /// {callee: callers} 键值对,切片不改对象形状)。
    #[serde(default)]
    reverse_offset: usize,
}

/// RUST-077-W:单页边限额(服务端策略常量;配置化接线随 RUST-078-W 预算
/// 构造落,本批不伪造配置面)。条目硬限防极端碎片页,字节硬限 = 真实
/// serde 序列化字节(逐边实测,非权重估算)。256 KiB:已知生产大面
/// (万文件工作区 callgraph)单响应远超此限,分页在生产真实生效。
const EDGE_PAGE_MAX_ITEMS: usize = 20_000;
const EDGE_PAGE_MAX_BYTES: usize = 256 * 1024;

/// RUST-077-W:按 CORE-012 纯核切一页数组(边/节点/数据流通用)。weight =
/// 逐条真实 serde 序列化字节(「真实输出字节限制」的字面口径);协作取消
/// 桥 = worker 线程探针(kode_python::cancel)在逐条计量点拉响 scheduler
/// CancelToken——触发条目保留、下一检查点停收,与纯核文档语义一致。
fn slice_json_page(
    items: &[Value],
    offset: usize,
    cancel_probe: bool,
) -> (Vec<Value>, EdgePageMeta) {
    use kode_scheduler::results::{paginate, PageCursor, PageLimits};
    use kode_scheduler::scheduler::CancelToken;
    let bridge = CancelToken::new();
    let weight = |item: &Value| {
        if cancel_probe && kode_python::cancel::is_cancelled() && !bridge.is_cancelled() {
            bridge.cancel();
        }
        serde_json::to_string(item).map(|s| s.len()).unwrap_or(0)
    };
    let page = paginate(
        items,
        PageCursor { offset },
        PageLimits {
            max_items: EDGE_PAGE_MAX_ITEMS,
            max_bytes: EDGE_PAGE_MAX_BYTES,
        },
        weight,
        &bridge,
    );
    let meta = EdgePageMeta {
        offset: page.offset,
        next_offset: page.next_offset,
        oversized_at: page.oversized_at,
        cancelled: page.cancelled,
        bytes_estimate: page.bytes_estimate,
        total: items.len(),
    };
    (page.items, meta)
}

/// RUST-077-W:反索引条目切片(BTreeMap 键序确定性 → 输入序偏移语义成立;
/// 条目序列化为单键对象 {callee: callers},形状与全量一致)。
fn slice_reverse_page(
    reverse_index: &BTreeMap<String, Vec<String>>,
    offset: usize,
    cancel_probe: bool,
) -> (BTreeMap<String, Vec<String>>, EdgePageMeta) {
    let entries: Vec<Value> = reverse_index
        .iter()
        .map(|(callee, callers)| serde_json::json!({ callee: callers }))
        .collect();
    let (paged, meta) = slice_json_page(&entries, offset, cancel_probe);
    let mut out = BTreeMap::new();
    for entry in &paged {
        if let Some(obj) = entry.as_object() {
            for (callee, callers) in obj {
                if let Ok(callers) = serde_json::from_value::<Vec<String>>(callers.clone()) {
                    out.insert(callee.clone(), callers);
                }
            }
        }
    }
    (out, meta)
}

/// 分页元信息(响应 `edgePage` 键;全量小结果不携带此键 = 旧契约零变化)。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EdgePageMeta {
    offset: usize,
    next_offset: Option<usize>,
    oversized_at: Option<usize>,
    cancelled: bool,
    /// 本页真实序列化字节合计(与切页计量同源)。
    bytes_estimate: usize,
    /// 全量边数(消费方续取进度对账)。
    total: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SymbolsParams {
    #[serde(default)]
    files: Vec<FileInput>,
}

// ---------------------------------------------------------------------------
// 输出形状
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeOut {
    /// 方法 `Class.method` / 模块级函数 `<stem>::func` / 模块伪节点 `<stem>`。
    id: String,
    /// "method" | "function" | "module"。
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_name: Option<String>,
    name: String,
    file_path: String,
    /// 0-based(透出原样,TS 消费点换算)。
    line: usize,
    is_async: bool,
    params: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EdgeOut {
    caller_id: String,
    callee_id: String,
    caller: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    caller_class: Option<String>,
    caller_line: usize,
    callee: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    receiver: Option<String>,
    kind: &'static str,
    file_path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChainOut {
    var: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    def_line: Option<usize>,
    use_lines: Vec<usize>,
    is_param: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DataflowOut {
    file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    class: Option<String>,
    method: String,
    chains: Vec<ChainOut>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsOut {
    file_count: usize,
    node_count: usize,
    edge_count: usize,
    dataflow_count: usize,
    error_count: usize,
    /// 全 8 类边固定键(0 计数也保留,面板图例稳定)。
    by_kind: BTreeMap<&'static str, usize>,
}

// ---------------------------------------------------------------------------
// 单文件分析
// ---------------------------------------------------------------------------

struct FileAnalysis {
    path: String,
    stem: String,
    symbols: AstSymbols,
    error_count: usize,
    edges: Vec<CallEdge>,
    dataflow: Vec<kode_python::MethodDataflow>,
}

fn analyze(path: &str, text: &str) -> FileAnalysis {
    // KR-AUD-89:路径分隔只认 '/',斜杠归一在上游 RPC 边界完成
    // (TS normalizeCallGraphPath)——断言锁死契约,漏归一即红。
    debug_assert!(
        !path.contains('\\'),
        "KR-AUD-89: callgraph path must be '/'-separated upstream: {path}"
    );
    let ast = ParsedAst::new(text);
    let symbols = extract(&ast);
    let error_count = ast.errors().len();
    let edges = extract_call_graph(&ast, &symbols);
    let dataflow = kode_python::dataflow_for_module(&ast);
    FileAnalysis {
        stem: file_stem(path).to_string(),
        path: path.to_string(),
        symbols,
        error_count,
        edges,
        dataflow,
    }
}

/// basename 去 `.py`(路径分隔只认 `/`;Windows 面由调用方统一斜杠)。
fn file_stem(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.strip_suffix(".py").unwrap_or(base)
}

/// 全 8 类边固定键表。
fn kind_table() -> BTreeMap<&'static str, usize> {
    let kinds = [
        EdgeKind::Local,
        EdgeKind::Method,
        EdgeKind::SelfMethod,
        EdgeKind::KbeBroadcast,
        EdgeKind::KbeBaseClients,
        EdgeKind::KbeCrossProcess,
        EdgeKind::KbeApi,
        EdgeKind::Unknown,
    ];
    kinds.into_iter().map(|k| (k.as_str(), 0)).collect()
}

// ---------------------------------------------------------------------------
// `$/kode/python/callgraph`
// ---------------------------------------------------------------------------

fn build_handler(params: Value) -> Result<Value, String> {
    let input: CallgraphParams =
        serde_json::from_value(params).map_err(|e| format!("python/callgraph params: {e}"))?;
    let cancel_probe = kode_python::cancel::is_cancelled();
    let mut result = serde_json::to_value(build_callgraph(&input)).map_err(|e| e.to_string())?;
    // RUST-077-W:大结果分页接生产——四个大维度(边/节点/数据流/反索引)
    // 按 CORE-012 纯核切片,单页 payload 有界;同输入同游标必得同页(纯
    // 函数确定性),续取语义成立。被切片的维度携带 `*Page` 元信息键。
    if let Some(obj) = result.as_object_mut() {
        // (响应键, 游标, 切片器)逐维处理;任一维非首页/未到底/有取消/
        // 超大条目即插入对应 `*Page` 元信息,全量维不携带键(旧契约零变)。
        for (key, page_key, offset, sliced) in [
            (
                "edges",
                "edgePage",
                input.edge_offset,
                SliceKind::Array(
                    obj.get("edges").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
                ),
            ),
            (
                "nodes",
                "nodePage",
                input.node_offset,
                SliceKind::Array(
                    obj.get("nodes").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
                ),
            ),
            (
                "dataflow",
                "dataflowPage",
                input.dataflow_offset,
                SliceKind::Array(
                    obj.get("dataflow").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
                ),
            ),
            (
                "reverseIndex",
                "reversePage",
                input.reverse_offset,
                SliceKind::Reverse(
                    serde_json::from_value::<BTreeMap<String, Vec<String>>>(
                        obj.get("reverseIndex").cloned().unwrap_or(Value::Null),
                    )
                    .unwrap_or_default(),
                ),
            ),
        ] {
            let (value, meta) = match sliced {
                SliceKind::Array(items) => {
                    let (paged, meta) = slice_json_page(&items, offset, cancel_probe);
                    (Value::Array(paged), meta)
                }
                SliceKind::Reverse(map) => {
                    let (paged, meta) = slice_reverse_page(&map, offset, cancel_probe);
                    (
                        serde_json::to_value(paged).map_err(|e| e.to_string())?,
                        meta,
                    )
                }
            };
            // 全量小结果(首页且到底且无取消/超大条目)不携带 `*Page` 键;
            // 非首页(offset>0)即使到底也如实携带(续取尾页)。
            let full_page = offset == 0
                && meta.next_offset.is_none()
                && meta.oversized_at.is_none()
                && !meta.cancelled;
            if !full_page {
                obj.insert(key.to_string(), value);
                obj.insert(
                    page_key.to_string(),
                    serde_json::to_value(meta).map_err(|e| e.to_string())?,
                );
            }
        }
    }
    Ok(result)
}

/// RUST-077-W:分页维度载荷(数组维或反索引映射维)。
enum SliceKind {
    Array(Vec<Value>),
    Reverse(BTreeMap<String, Vec<String>>),
}

fn symbol_id(path: &str, kind: &str, scope: &str, name: &str) -> String {
    fn hex(s: &str) -> String {
        s.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }
    format!("sym_{}_{}_{}_{}", hex(path), kind, hex(scope), hex(name))
}

fn build_callgraph(input: &CallgraphParams) -> Value {
    let analyses: Vec<FileAnalysis> = input
        .files
        .iter()
        .map(|f| analyze(&f.path, &f.text))
        .collect();

    // 节点:类方法 + 模块级函数;模块伪节点仅当该文件有顶层调用边。
    let mut nodes: Vec<NodeOut> = Vec::new();
    let mut edges: Vec<EdgeOut> = Vec::new();
    let mut by_kind = kind_table();
    for a in &analyses {
        for class in &a.symbols.classes {
            for m in &class.methods {
                nodes.push(NodeOut {
                    id: symbol_id(&a.path, "method", &class.name, &m.name),
                    kind: "method",
                    class_name: Some(class.name.clone()),
                    name: m.name.clone(),
                    file_path: a.path.clone(),
                    line: m.line,
                    is_async: m.is_async,
                    params: m.params.clone(),
                });
            }
        }
        for f in &a.symbols.functions {
            nodes.push(NodeOut {
                id: symbol_id(&a.path, "function", "", &f.name),
                kind: "function",
                class_name: None,
                name: f.name.clone(),
                file_path: a.path.clone(),
                line: f.line,
                is_async: f.is_async,
                params: f.params.clone(),
            });
        }
        let has_module_edges = a.edges.iter().any(|e| e.caller == MODULE_CALLER);
        if has_module_edges {
            nodes.push(NodeOut {
                id: symbol_id(&a.path, "module", "", ""),
                kind: "module",
                class_name: None,
                name: a.stem.clone(),
                file_path: a.path.clone(),
                line: 0,
                is_async: false,
                params: Vec::new(),
            });
        }
        for e in &a.edges {
            *by_kind.entry(e.kind.as_str()).or_insert(0) += 1;
            let caller_id = if let Some(class) = &e.caller_class {
                symbol_id(&a.path, "method", class, &e.caller)
            } else if e.caller == MODULE_CALLER {
                symbol_id(&a.path, "module", "", "")
            } else {
                symbol_id(&a.path, "function", "", &e.caller)
            };
            let callee_id = match e.kind {
                EdgeKind::SelfMethod => symbol_id(
                    &a.path,
                    "method",
                    e.caller_class.as_deref().unwrap_or(""),
                    &e.callee,
                ),
                EdgeKind::Local => symbol_id(&a.path, "function", "", &e.callee),
                _ => symbol_id(
                    &a.path,
                    "external",
                    e.receiver.as_deref().unwrap_or(""),
                    &e.callee,
                ),
            };
            edges.push(EdgeOut {
                caller_id,
                callee_id,
                caller: e.caller.clone(),
                caller_class: e.caller_class.clone(),
                caller_line: e.caller_line,
                callee: e.callee.clone(),
                receiver: e.receiver.clone(),
                kind: e.kind.as_str(),
                file_path: a.path.clone(),
            });
        }
    }

    // 跨文件反索引(被调方文件 → 调用方文件集),键映射回 path 字符串。
    let mut file_edges: BTreeMap<DocumentKey, Vec<CallEdge>> = BTreeMap::new();
    let mut file_symbols: BTreeMap<DocumentKey, AstSymbols> = BTreeMap::new();
    let mut key_to_path: BTreeMap<DocumentKey, String> = BTreeMap::new();
    for a in &analyses {
        let key = DocumentKey::new(RootId::UNROOTED, CanonicalUri::from_path(&a.path));
        key_to_path.insert(key.clone(), a.path.clone());
        file_edges.insert(key.clone(), a.edges.clone());
        file_symbols.insert(key, a.symbols.clone());
    }
    let reverse = build_call_reverse_index(&file_edges, &file_symbols);
    let mut reverse_index: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (callee, callers) in &reverse {
        let callee_path = key_to_path.get(callee).cloned().unwrap_or_default();
        let caller_paths: Vec<String> = callers
            .iter()
            .filter_map(|k| key_to_path.get(k).cloned())
            .collect();
        reverse_index.insert(callee_path, caller_paths);
    }

    // 数据流(每方法 def-use)。
    let dataflow: Vec<DataflowOut> = analyses
        .iter()
        .flat_map(|a| {
            a.dataflow.iter().map(|m| DataflowOut {
                file_path: a.path.clone(),
                class: m.class.clone(),
                method: m.method.clone(),
                chains: m
                    .result
                    .chains
                    .iter()
                    .map(|c| ChainOut {
                        var: c.var.clone(),
                        def_line: c.def_line,
                        use_lines: c.use_lines.clone(),
                        is_param: c.is_param,
                    })
                    .collect(),
            })
        })
        .collect();

    let process_roles = input
        .manifest_xml_text
        .as_deref()
        .map(parse_process_roles)
        .unwrap_or_default();

    let stats = StatsOut {
        file_count: analyses.len(),
        node_count: nodes.len(),
        edge_count: edges.len(),
        dataflow_count: dataflow.len(),
        error_count: analyses.iter().map(|a| a.error_count).sum(),
        by_kind,
    };

    serde_json::json!({
        "nodes": nodes,
        "edges": edges,
        "reverseIndex": reverse_index,
        "dataflow": dataflow,
        "processRoles": process_roles,
        "stats": stats,
    })
}

/// 清单 `<process role="...">` 角色去重(升序;清单缺省=空)。
fn parse_process_roles(text: &str) -> Vec<String> {
    let doc = kode_parser::xml::parse(text, true);
    let mut roles = BTreeSet::new();
    if let Some(root) = doc.root() {
        for child in doc.child_elements(root) {
            if doc.element(child).name == "process" {
                if let Some(role) = doc
                    .element(child)
                    .attribute("role")
                    .map(|a| a.value.trim().to_string())
                    .filter(|v| !v.is_empty())
                {
                    roles.insert(role);
                }
            }
        }
    }
    roles.into_iter().collect()
}

// ---------------------------------------------------------------------------
// `$/kode/python/symbols`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CallRefOut {
    method_name: String,
    /// 0-based(与 C-19 TS 面同源换算点)。
    line: usize,
    character: usize,
}

/// 类体内 `self.<name> = ...` 属性写入(kode-python 模型无 Serialize,显式映射)。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AttrSymOut {
    name: String,
    line: usize,
    character: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MethodSymOut {
    name: String,
    line: usize,
    character: usize,
    is_async: bool,
    decorators: Vec<String>,
    params: Vec<String>,
    end_line: usize,
    /// 该方法的自身调用(self-method 边,含调用点列)。
    calls: Vec<CallRefOut>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassSymOut {
    name: String,
    qualified_name: String,
    bases: Vec<String>,
    start_line: usize,
    end_line: usize,
    decorators: Vec<String>,
    methods: Vec<MethodSymOut>,
    attributes: Vec<AttrSymOut>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FuncSymOut {
    name: String,
    line: usize,
    character: usize,
    is_async: bool,
    decorators: Vec<String>,
    params: Vec<String>,
    end_line: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportSymOut {
    binding: String,
    module: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
    line: usize,
    is_from: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSymbolsOut {
    file_path: String,
    line_count: usize,
    classes: Vec<ClassSymOut>,
    functions: Vec<FuncSymOut>,
    imports: Vec<ImportSymOut>,
    /// ruff 语法错误(格式化字符串;空 = 无)。
    errors: Vec<String>,
}

fn symbols_handler(params: Value) -> Result<Value, String> {
    let input: SymbolsParams =
        serde_json::from_value(params).map_err(|e| format!("python/symbols params: {e}"))?;
    let files: Vec<FileSymbolsOut> = input
        .files
        .iter()
        .map(|f| file_symbols(&f.path, &f.text))
        .collect();
    serde_json::to_value(files).map_err(|e| e.to_string())
}

fn file_symbols(path: &str, text: &str) -> FileSymbolsOut {
    // 单次解析:符号表与错误都从同一 ParsedAst 取(不二次 parse_ast_symbols)。
    let ast = ParsedAst::new(text);
    let symbols = extract(&ast);
    // 自身调用(self-method 边)带调用点列;按 (类, 方法) 分组入账。
    let detailed = extract_call_graph_detailed(&ast, &symbols);
    let mut calls_by: BTreeMap<(String, String), Vec<CallRefOut>> = BTreeMap::new();
    for (edge, column) in detailed {
        if edge.kind == EdgeKind::SelfMethod {
            let class = edge.caller_class.clone().unwrap_or_default();
            calls_by
                .entry((class, edge.caller.clone()))
                .or_default()
                .push(CallRefOut {
                    method_name: edge.callee.clone(),
                    line: edge.caller_line,
                    character: column,
                });
        }
    }
    FileSymbolsOut {
        file_path: path.to_string(),
        line_count: symbols.line_count,
        classes: symbols
            .classes
            .iter()
            .map(|class| ClassSymOut {
                name: class.name.clone(),
                qualified_name: class.qualified_name.clone(),
                bases: class.bases.clone(),
                start_line: class.start_line,
                end_line: class.end_line,
                decorators: class.decorators.clone(),
                methods: class
                    .methods
                    .iter()
                    .map(|m| MethodSymOut {
                        name: m.name.clone(),
                        line: m.line,
                        character: m.character,
                        is_async: m.is_async,
                        decorators: m.decorators.clone(),
                        params: m.params.clone(),
                        end_line: m.end_line,
                        calls: calls_by
                            .get(&(class.qualified_name.clone(), m.name.clone()))
                            .cloned()
                            .unwrap_or_default(),
                    })
                    .collect(),
                attributes: class
                    .attributes
                    .iter()
                    .map(|attr| AttrSymOut {
                        name: attr.name.clone(),
                        line: attr.line,
                        character: attr.character,
                    })
                    .collect(),
            })
            .collect(),
        functions: symbols
            .functions
            .iter()
            .map(|f| FuncSymOut {
                name: f.name.clone(),
                line: f.line,
                character: f.character,
                is_async: f.is_async,
                decorators: f.decorators.clone(),
                params: f.params.clone(),
                end_line: f.end_line,
            })
            .collect(),
        imports: symbols
            .imports
            .iter()
            .map(|i| ImportSymOut {
                binding: i.binding.clone(),
                module: i.module.clone(),
                symbol: i.symbol.clone(),
                line: i.line,
                is_from: i.is_from,
            })
            .collect(),
        errors: ast.errors().iter().map(|e| format!("{e:?}")).collect(),
    }
}
