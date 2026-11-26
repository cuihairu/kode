//! Data model: AST symbol tables / call edges / def-use chains (C-20).
//!
//! Conventions:
//! - Line numbers are always **0-based** (the same semantics as TS `pythonClassIndex` / LSP /
//!   kode-corpus, so wt/parity can be compared directly); columns are 0-based UTF-16 code units
//!   (LSP semantics).
//! - This module holds only pure data shapes and stable literals; the extraction logic lives in
//!   [`crate::symbols`] / [`crate::callgraph`] / [`crate::dataflow`]. The parity face = the data
//!   face; two sets of semantics are not allowed.

/// AST-level symbol tables (single file).
///
/// Isomorphic to kode-corpus's lexical table [`kode_corpus::PythonModule`] but based on the real
/// AST: it can distinguish decorators / async / nested functions and inheritance chains;
/// `to_corpus()` can degrade to the lexical shape for the C-19 consistency check and wt/parity
/// reuse (replacing C-19's home-grown parser).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstSymbols {
    /// Total source line count (same semantics as kode-corpus: a trailing newline yields one extra blank line).
    pub line_count: usize,
    /// Module-level class declarations (nested ones included? No -- this table only takes classes
    /// directly owned by the file; methods / attributes hang off the classes).
    pub classes: Vec<AstClass>,
    /// Module-level functions (`def` outside any class).
    pub functions: Vec<AstFunction>,
    /// `import` / `from ... import ...` bindings (module top level only, the semantic table, same
    /// semantics as the existing consumer faces). Module-top-level bindings are file-wide visible.
    pub imports: Vec<AstImport>,
    /// Function-scope import bindings (call-site visibility is located by line interval). Each
    /// entry = one scope layer's line interval plus the binding names of imports in its subtree.
    /// Call-graph receiver resolution decides visibility by which interval the call site's line
    /// number falls into -- intervals are naturally nested (an outer interval covers nested
    /// bodies, the closure-visibility semantic), while intervals of same-named functions /
    /// comprehensions are disjoint (they do not cover each other).
    pub function_import_bindings: Vec<ScopeImportBindings>,
    /// Module-top-level names that were locally bound (Store assignment) -> most recent line.
    /// The shadow surface for the module import fallback: after a top-level rebind, a same-named
    /// receiver inside a function is not the module (residual from review round nine).
    pub module_shadows: std::collections::BTreeMap<String, usize>,
}

/// Kind of a function scope (models the bare-name resolution chain: function chains participate
/// in resolution; class bodies / comprehensions are independent implicit scopes -- their bindings
/// / shadows do not join the function bare-name chain and only act as isolation for their own layer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeKind {
    /// Function / method / nested def / lambda: joins the bare-name resolution chain.
    Function,
    /// Class body: the bare-name resolution chain does not include the class layer (Python
    /// semantics); it only isolates bindings.
    Class,
    /// Comprehension (the implicit function scope of List/Set/Dict/Generator).
    Comprehension,
}

/// Import bindings of a single function scope (lines 0-based, same semantics as the rest of the repo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeImportBindings {
    pub kind: ScopeKind,
    /// Function start line (the `def` line).
    pub start_line: usize,
    /// Function end line (last line of the body).
    pub end_line: usize,
    /// Binding names of imports inside this function's subtree (including nested def / branch
    /// bodies) -> (most recent import binding line, 0-based; target module basename; target
    /// identity id). An empty basename = the ambiguity marker for conflicting target identities
    /// (the resolution layer drops that edge).
    pub bindings: std::collections::BTreeMap<String, (usize, String, String)>,
    /// Names locally bound in this function's direct scope (parameters + Store assignment
    /// targets) -> most recent local-binding line. Once a local binding exists, the whole scope
    /// is treated as a local name (static locality); coexisting with `bindings` = static
    /// ambiguity, conservatively dropped (prefer missing over wrong).
    pub shadows: std::collections::BTreeMap<String, usize>,
}

/// Class declaration (AST level).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstClass {
    pub name: String,
    /// File-unique qualified name (in this table = `name`; nested classes reserve dot-qualification).
    pub qualified_name: String,
    /// Base class names (only legal dotted identifiers are kept and `object` is excluded; the same
    /// filtering as TS / kode-corpus).
    pub bases: Vec<String>,
    pub start_line: usize,
    pub end_line: usize,
    pub methods: Vec<AstMethod>,
    /// `self.<name> = ...` write sites in the class body (aggregated across methods).
    pub attributes: Vec<AstAttribute>,
    pub decorators: Vec<String>,
}

/// Method directly owned by a class (AST level).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstMethod {
    /// Qualified name of the owning class.
    pub class: String,
    pub name: String,
    pub line: usize,
    pub character: usize,
    pub is_async: bool,
    /// Decorators immediately above the `def` (including `@`, in source order).
    pub decorators: Vec<String>,
    /// Formal parameter names (posonly/pos/kwonly/vararg/kwarg order); default value expressions excluded.
    pub params: Vec<String>,
    /// End line of the method body (exclusive); `start_line` when there is no body.
    pub end_line: usize,
}

/// Module-level function (AST level).
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

/// A `self.<name> = ...` attribute write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstAttribute {
    /// Qualified name of the owning class.
    pub class: String,
    pub name: String,
    pub line: usize,
    pub character: usize,
}

/// Import binding (AST level).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstImport {
    /// Binding name inside this file.
    pub binding: String,
    /// The module name of a `from`, or the target module of an `import`.
    pub module: String,
    /// The symbol of `from module import symbol`; `None` for a plain `import`.
    pub symbol: Option<String>,
    /// Whether an explicit alias is present (`import a.b as c` / `from p import x as y`). The
    /// basename fallback must distinguish "binds the package itself (no alias = top-level first
    /// segment)" from "binds the target module (with alias = last segment)"; it must not
    /// approximate with binding name == first segment -- the alias of `import a.b as a` is exactly
    /// the first-segment name, and the approximation would point at an unrelated a.py (residual
    /// from review round twelve).
    pub aliased: bool,
    /// Relative level of the from-import (`from .x import y` = 1). Needed by the target-identity
    /// consistency check: same-named targets at different levels (`.x.y` vs `..x.y`) must not be
    /// conflated (residual from review round fourteen).
    pub level: u32,
    pub line: usize,
    pub is_from: bool,
}

/// Call edge kinds (EdgeKind) -- KBEngine-specialized edges as well as ordinary local / external calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeKind {
    /// Local / same-name module-level call: `foo(...)` where foo is a module-level function of this
    /// file or an import binding.
    Local,
    /// Object method call: `obj.method(...)` (obj is neither self nor a KBEngine channel).
    Method,
    /// Self method call: `self.method(...)`.
    SelfMethod,
    /// KBEngine client broadcast: `self.allClients.<client-method>(...)` (to all clients).
    KbeBroadcast,
    /// KBEngine base client broadcast: `self.baseClients.<method>(...)`.
    KbeBaseClients,
    /// KBEngine cross-process: `self.cell.<method>(...)` (base->cell), `self.base.<method>(...)`
    /// (cell->base), or `self.client.<method>(...)` (cell->client).
    KbeCrossProcess,
    /// KBEngine engine API: `KBEngine.<api>(...)` or `kbengine.<api>(...)`.
    KbeApi,
    /// External / unresolvable call.
    Unknown,
}

impl EdgeKind {
    /// Stable literals (the golden parity-comparison output).
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

/// A single call edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallEdge {
    /// Caller (may be empty = module-level / not attached to a class).
    pub caller_class: Option<String>,
    /// Caller method / function name (a method name or a module-level function name).
    pub caller: String,
    /// Call site line (0-based).
    pub caller_line: usize,
    /// Callee name (last segment of the attribute chain).
    pub callee: String,
    /// Receiver chain (e.g. `self`, `self.cell`, `self.allClients`, `module`); None for a bare name call.
    pub receiver: Option<String>,
    pub kind: EdgeKind,
}

/// Intra-procedural def-use chain (MVP: straight-line approximation, does not merge control-flow branches).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefUseChain {
    /// Variable name (`x` or `self.attr`).
    pub var: String,
    /// Most recent definition line (0-based); None when undefined (parameter / global).
    pub def_line: Option<usize>,
    /// Use site lines (0-based, ascending, deduplicated).
    pub use_lines: Vec<usize>,
    /// Parameter origin (Some(parameter index) when the variable is a formal parameter, else None).
    pub is_param: bool,
}

/// Intra-procedural dataflow result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataflowResult {
    /// Def-use chains in order of first appearance.
    pub chains: Vec<DefUseChain>,
}
