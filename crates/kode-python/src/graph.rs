//! Call-graph aggregation + the reverse index for kode-scheduler's invalidation DAG to consume
//! (C-20 delivery item 3).
//!
//! - [`PyCallGraph`]: the call-edge set of one file (or an aggregate), providing the query faces:
//!   `callers_of` (callee name -> call-site list, i.e. "change a method's signature -> list every
//!   affected call site") and `calls_of` (caller -> outgoing edges);
//! - [`CallReverseIndex`]: callee file -> set of caller files, fed directly into kode-scheduler's
//!   `InvalidationGraph::with_call_dependents` (the cross-file reverse dependency, so that
//!   `affected_by` includes "change the callee file -> recompute the caller files").
//!
//! Cross-file callee resolution is heuristic (dynamic language): bare name -> project-wide
//! module-level functions; `self.*` -> the caller's own file; module-bound receiver -> resolve the
//! module by file name; unknown -> produce no reverse dependency (prefer missing over wrong, to
//! avoid spurious invalidation).

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use kode_vfs::store::DocumentKey;

use crate::model::{AstImport, AstSymbols, CallEdge};

/// Call graph (grouped per file or aggregated).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PyCallGraph {
    pub edges: Vec<CallEdge>,
}

impl PyCallGraph {
    pub fn new(edges: Vec<CallEdge>) -> PyCallGraph {
        PyCallGraph { edges }
    }

    /// Callee name -> call sites (ascending; "change a method's signature -> list every affected call site").
    pub fn callers_of(&self, callee: &str) -> Vec<&CallEdge> {
        let mut v: Vec<&CallEdge> = self.edges.iter().filter(|e| e.callee == callee).collect();
        v.sort_by_key(|e| (e.caller.clone(), e.caller_line));
        v
    }

    /// Caller -> outgoing edges (ascending; none for that caller -> empty).
    pub fn calls_of(&self, caller: &str) -> Vec<&CallEdge> {
        let mut v: Vec<&CallEdge> = self.edges.iter().filter(|e| e.caller == caller).collect();
        v.sort_by_key(|e| e.caller_line);
        v
    }

    /// Edges of a given EdgeKind (for the visualization panel to color by category).
    pub fn of_kind(&self, kind: crate::model::EdgeKind) -> Vec<&CallEdge> {
        self.edges.iter().filter(|e| e.kind == kind).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }
}

/// Callee file -> set of caller files (the cross-file reverse dependency that kode-scheduler consumes).
pub type CallReverseIndex = BTreeMap<DocumentKey, BTreeSet<DocumentKey>>;

/// Build the cross-file call reverse dependencies.
///
/// - `file_edges`: the call edges of each file (from [`crate::callgraph::extract_call_graph`]);
/// - `file_symbols`: the AST symbol tables of each file (used by cross-file callee resolution).
///
/// Heuristic resolution (see the module header); returns callee file -> set of caller files, which
/// can serve as input to `InvalidationGraph::with_call_dependents`.
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

/// Set of caller files that own cross-process edges (`self.cell.*`/`self.base.*`/`self.client.*`)
/// (the RUST-7 uncertain face).
///
/// These callers have cross-process call edges, but the callee file cannot be resolved statically
/// (see the KbeCrossProcess short-circuit in [`resolve_callee_file`]), so they do not enter the
/// reverse invalidation index of [`build_call_reverse_index`] -- a change on the other process
/// side will not trigger a rescan of these files via a call edge. Consumers can fold this set into
/// a conservative rescan face (e.g. rescan these files in full when a profile / configuration
/// changes).
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

/// Resolve the file the callee lives in (heuristic; None = unresolvable / external / ambiguous).
fn resolve_callee_file(
    caller_file: &DocumentKey,
    edge: &CallEdge,
    file_symbols: &BTreeMap<DocumentKey, AstSymbols>,
) -> Option<DocumentKey> {
    let receiver = edge.receiver.as_deref().unwrap_or("");
    // KbeCrossProcess (`self.cell.*`/`self.base.*`/`self.client.*`): base<->cell<->client are only
    // linked indirectly via configuration, so the callee file cannot be resolved statically (the
    // entity class lives in a file on the other process side, and the edge carries no class name /
    // file name). The older implementation fell into the `self.` branch below and folded it back
    // to the caller file as "same class", silently dropping the cross-process edge. RUST-7: return
    // None explicitly (behaviour unchanged: the reverse index yields no edge), but the semantics no
    // longer masquerade as a same-class call; the uncertain face is marked separately by
    // [`uncertain_cross_process_files`], which consumers can use for a conservative rescan.
    // TODO (current design): there is no logging facade (the workspace keeps its strict
    // zero-third-party-dependency rule), so the warn is replaced by a query face; if logging is
    // wired in later, emit a warn here.
    if edge.kind == crate::model::EdgeKind::KbeCrossProcess {
        return None;
    }
    if receiver == "self" || receiver.starts_with("self.") {
        // Own class method / attribute -> the caller file (same class, not cross-file; return
        // itself so the caller can fold it).
        return Some(caller_file.clone());
    }
    if receiver.is_empty() {
        // KODE-AUD-008: bare-name call -- if the caller file itself defines that module-level
        // function, it is a local call and no cross-file edge is produced (anti-false-edge: the
        // older implementation searched the whole project and would hit the file holding a
        // same-named function first, misattributing a local call as cross-file).
        if caller_defines_function(caller_file, file_symbols, &edge.callee) {
            return None;
        }
        return find_module_function(file_symbols, &edge.callee, caller_file);
    }
    // Module-bound receiver: `module.func` -> find the file by the target module basename (excluding
    // the caller itself). Residual from the KODE-AUD-008 review: the first segment of the receiver
    // can also be an instance variable (`avatar.heal()`, where avatar is a local object, not a
    // module) -- looking up a file by basename without checking the import binding would point the
    // unique same-named file at as the callee (a false cross-file edge).
    //
    // Binding-verification contract (conservative: ambiguity means giving up; finalized in review
    // rounds seven/eight/nine): walk the Function/Comprehension scope layers containing the call
    // site, innermost out --
    // - a layer with an import binding ONLY and the call line not earlier than the binding line ->
    //   module binding; run the uniqueness check on the target module basename (for an alias use
    //   the target module name, not the binding name);
    // - a layer with a local binding (parameter / Store assignment; the same when it overlaps an
    //   import -- static ambiguity) -> no edge;
    // - the name is not mentioned in the layer -> continue outward;
    // - the whole chain undecidable -> module-top-level fallback: the name was rebound by a top-
    //   level Store assignment -> no edge (residual from round nine, item 1); otherwise run the
    //   uniqueness check on the target basename of the top-level import.
    // Known granularity limits (the conservative, edge-missing direction, recorded honestly):
    // lambda-parameter shadowing on the same line is indistinguishable from the granularity of the
    // outer call line; when the call line is earlier than a function-local import line, fall back
    // outward (at runtime that call is already UnboundLocal, so the edge is meaningless).
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
                // Innermost first (larger start line); adjudicate within a layer, continue outward if undecidable.
                in_scope.sort_by_key(|sc| std::cmp::Reverse(sc.start_line));
                let mut resolved: Option<Option<String>> = None;
                for sc in in_scope {
                    match (sc.bindings.get(module), sc.shadows.get(module)) {
                        // A local binding present means it is a local name (Python static
                        // locality); overlapping with an import = static ambiguity, give up
                        // conservatively.
                        (Some(_), Some(_)) => resolved = Some(None),
                        (Some(&(bl, ref base, _)), None) => {
                            // An empty basename = the ambiguity marker for conflicting target identity.
                            if base.is_empty() {
                                resolved = Some(None);
                            } else if edge.caller_line >= bl {
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
                        // Some(None) = local / ambiguous, no edge; Some(Some(base)) = run the
                        // uniqueness check on the target basename.
                        basename.and_then(|base| find_module_file(file_symbols, &base, caller_file))
                    }
                    // The scope chain was undecidable -> module-top-level fallback: first check the
                    // top-level rebind shadow, then run the uniqueness check on the target basename
                    // of the top-level import.
                    None => {
                        if s.module_shadows.contains_key(module) {
                            return None;
                        }
                        let hits: Vec<_> =
                            s.imports.iter().filter(|i| i.binding == module).collect();
                        if hits.is_empty() {
                            return None;
                        }
                        // The same name imported several times with different targets = conflicting target identity,
                        // statically undecidable -> give up (residual from review rounds ten/twelve).
                        // Consistency is judged by the **actual target identity** (residual from
                        // review round fourteen): from = (level, module, symbol); an unaliased plain
                        // import binds the package itself = the top-level first-segment identity; an
                        // aliased plain import binds the whole module = the full-segment identity.
                        // File lookup still uses resolve_base's basename (the lookup semantics and
                        // the identity semantics are kept separate): `import a.a` (identity a) and
                        // `import a.a as a` (identity a.a) share the basename a but differ in target
                        // -> drop the edge; `import a` and `import a as a` (identity a for both) do
                        // not drop the edge.
                        let resolve_target = |i: &AstImport| -> String {
                            if i.is_from {
                                format!(
                                    "{}|{}|{}",
                                    i.level,
                                    i.module,
                                    i.symbol.clone().unwrap_or_default()
                                )
                            } else if !i.aliased {
                                i.module.split('.').next().unwrap_or("").to_string()
                            } else {
                                i.module.clone()
                            }
                        };
                        let resolve_base = |i: &AstImport| -> String {
                            if i.is_from {
                                i.symbol.clone().unwrap_or_else(|| i.binding.clone())
                            } else if !i.aliased {
                                i.module.split('.').next().unwrap_or("").to_string()
                            } else {
                                i.module.rsplit('.').next().unwrap_or("").to_string()
                            }
                        };
                        let first = hits[0];
                        let consistent = hits
                            .iter()
                            .all(|t| resolve_target(t) == resolve_target(first));
                        if !consistent {
                            return None;
                        }
                        let base = resolve_base(first);
                        find_module_file(file_symbols, &base, caller_file)
                    }
                }
            })
            .unwrap_or(None);
        // resolved_file has already been qualified by the uniqueness-check outcome on the target basename.
        return resolved_file;
    }
    None
}

/// Does the caller file define the module-level function `name` (local-call determination).
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

/// Search the whole project for the module-level function `name` (excluding the caller file
/// `exclude`); exactly one definition -> Some; zero or several (ambiguous, prefer missing over
/// wrong to avoid spurious invalidation) -> None.
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

/// Find a file by module binding name (e.g. `os`, `utils`): match the basename with the `.py`
/// suffix stripped, excluding the caller file `exclude` itself; exactly one match -> Some,
/// ambiguous / zero -> None.
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
