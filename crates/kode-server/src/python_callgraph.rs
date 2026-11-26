//! `$/kode/python/callgraph` + `$/kode/python/symbols` -- the Python call graph / symbol table
//! RPC (C-20 full delivery part 2; consumers = src/pythonCallGraphRust.ts and the dependency-graph panel).
//!
//! - callgraph: a file set (source text passed through) -> nodes / call edges / cross-file reverse index /
//!   intra-procedural data flow / process roles / statistics. The cross-file reverse index feeds kode-scheduler's
//!   `with_call_dependents` (changing a callee file -> recompute the caller files).
//! - symbols: a file set -> per-file AST symbol tables (classes / methods / functions / imports plus each method's own
//!   self-calls), for C-19 method-consistency reuse (replaces the TS parsePythonMethodBlocks+parsePythonSelfCalls).
//!
//! Line-number stance: kode-python is 0-based (both line and column 0-based UTF-16); the RPC passes them through as-is;
//! 1-based conversion happens at the TS consumption point (aligned with C-19's existing IndexedPythonMethodLocation).
//! Fault tolerance: a per-file syntax error does not fail the whole run (the ruff tolerant path); errors go into `stats.errorCount`
//! / the symbols' `errors`, and the parseable part is still produced (friendly to half-finished scripts).
//!
//! Boundary: callee resolution is heuristic (a dynamic language); unknown calls keep the `unknown` edge class and are not fabricated.

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
// Input
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
    /// RUST-077-W: the cursor for resuming edge pagination (a CORE-012 input-order offset). Defaults to 0 = the first page;
    /// the same input with the same cursor always yields the same page (a text-in pure-function handler, deterministic reruns). Old
    /// callers that omit this key = the full set (zero change to the small-result contract).
    #[serde(default)]
    edge_offset: usize,
    /// RUST-077-W: the pagination cursor for the node array (same semantics).
    #[serde(default)]
    node_offset: usize,
    /// RUST-077-W: the pagination cursor for the data-flow array (same semantics).
    #[serde(default)]
    dataflow_offset: usize,
    /// RUST-077-W: the pagination cursor for cross-file reverse-index entries (BTreeMap key-order determinism; an entry =
    /// a {callee: callers} key-value pair; slicing does not change the object shape).
    #[serde(default)]
    reverse_offset: usize,
}

/// RUST-077-W: the per-page edge cap (a server-side policy constant; the configurable wiring lands with RUST-078-W's budget
/// construction; this batch does not fabricate a configuration face). The entry hard cap guards against extremely fragmented pages; the byte hard cap =
/// the real serde serialization bytes (measured edge by edge, not a weight estimate). 256 KiB: the known large production face
/// (the ten-thousand-file workspace callgraph) far exceeds this in a single response, so pagination genuinely takes effect in production.
const EDGE_PAGE_MAX_ITEMS: usize = 20_000;
const EDGE_PAGE_MAX_BYTES: usize = 256 * 1024;

/// RUST-077-W: slice one page from an array by the CORE-012 pure core (shared by edges / nodes / data flow). weight =
/// the per-entry real serde serialization bytes (the literal reading of the "real output byte limit"); the cooperative-cancellation
/// bridge = the worker-thread probe (kode_python::cancel) firing the scheduler CancelToken at the per-entry
/// measurement point -- the triggering entry is kept and intake stops at the next checkpoint, matching the pure-core documentation semantics.
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

/// RUST-077-W: reverse-index entry slicing (BTreeMap key-order determinism -> the input-order-offset semantics hold;
/// each entry serializes as a single-key object {callee: callers}, with the same shape as the full set).
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

/// Pagination metadata Pagination metadata (the response's `edgePage` key; full small results omit this key = zero change to the old contract).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EdgePageMeta {
    offset: usize,
    next_offset: Option<usize>,
    oversized_at: Option<usize>,
    cancelled: bool,
    /// The real serialized byte total of this page (the same source as the slicing measurement).
    bytes_estimate: usize,
    /// The total edge count (for consumers to reconcile their resume progress).
    total: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SymbolsParams {
    #[serde(default)]
    files: Vec<FileInput>,
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeOut {
    /// Method `Class.method` / module-level function `<stem>::func` / module pseudo-node `<stem>`.
    id: String,
    /// "method" | "function" | "module"。
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_name: Option<String>,
    name: String,
    file_path: String,
    /// 0-based (passed through as-is; converted at the TS consumption point).
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
    /// Fixed keys for all 8 edge classes (zero counts are kept too, keeping the panel legend stable).
    by_kind: BTreeMap<&'static str, usize>,
}

// ---------------------------------------------------------------------------
// Per-file analysis
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
    // KR-AUD-89: path separation only accepts '/'; slash normalization is done at the upstream RPC boundary
    // (the TS normalizeCallGraphPath) -- this assertion pins the contract; a missed normalization turns red immediately.
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

/// basename with `.py` stripped (path separation only accepts `/`; the Windows face is slash-normalized by the caller).
fn file_stem(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.strip_suffix(".py").unwrap_or(base)
}

/// The fixed key table for all 8 edge classes.
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
    // RUST-077-W: pagination for large results goes to production -- the four large dimensions (edges / nodes / data flow / reverse index)
    // are sliced by the CORE-012 pure core, keeping the per-page payload bounded; the same input with the same cursor always yields the same page (pure
    // -function determinism), so resume semantics hold. Sliced dimensions carry the `*Page` metadata key.
    if let Some(obj) = result.as_object_mut() {
        // (response key, cursor, slicer) handled per dimension; any dimension that is not the first page / not at the end / has a cancellation /
        // has an oversized entry inserts its `*Page` metadata; the full-set dimension carries no key (zero change to the old contract).
        for (key, page_key, offset, sliced) in [
            (
                "edges",
                "edgePage",
                input.edge_offset,
                SliceKind::Array(
                    obj.get("edges")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
                ),
            ),
            (
                "nodes",
                "nodePage",
                input.node_offset,
                SliceKind::Array(
                    obj.get("nodes")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
                ),
            ),
            (
                "dataflow",
                "dataflowPage",
                input.dataflow_offset,
                SliceKind::Array(
                    obj.get("dataflow")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
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
            // A full small result (first page and at the end and no cancellation / oversized entry) carries no `*Page` key;
            // a non-first page (offset>0) carries it honestly even at the end (resuming the tail page).
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

/// RUST-077-W: the payload of a paginated dimension (an array dimension or the reverse-index mapping dimension).
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

    // Nodes: class methods + module-level functions; a module pseudo-node only when the file has top-level call edges.
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

    // Cross-file reverse index (callee file -> the set of caller files), keys mapped back to path strings.
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

    // Data flow (per-method def-use).
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

/// Deduplicate the manifest's `<process role="...">` roles (ascending; the manifest defaults to empty).
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
    /// 0-based (the same-source conversion point as the C-19 TS face).
    line: usize,
    character: usize,
}

/// Property writes of the form `self.<name> = ...` inside a class body (the kode-python model has no Serialize, hence an explicit mapping).
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
    /// The method's own self-calls (self-method edges, including call-site columns).
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
    /// ruff syntax errors (formatted strings; empty = none).
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
    // Single parse: both the symbol table and the errors come from the same ParsedAst (no second parse_ast_symbols).
    let ast = ParsedAst::new(text);
    let symbols = extract(&ast);
    // Self-calls (self-method edges) carry call-site columns; grouped and filed by (class, method).
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
