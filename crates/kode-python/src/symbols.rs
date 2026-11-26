//! AST -> symbol tables (four tables: classes / methods / attributes / imports; C-20 delivery item 4).
//!
//! Isomorphic to kode-corpus's lexical tables but based on the ruff AST: it recognizes decorators,
//! async and inheritance chains correctly, and does not rely on indentation heuristics. It
//! produces [`AstSymbols`], which can be degraded to [`kode_corpus::PythonModule`] via
//! [`AstSymbols::to_corpus`] for the C-19 consistency check and direct wt/parity comparison
//! ("replaces C-19's home-grown parser").

use kode_corpus::{AttributeSymbol, ClassSymbol, ImportSymbol, MethodSymbol, PythonModule};
use ruff_python_ast::{self as ast, Expr, Stmt};

use crate::model::{
    AstAttribute, AstClass, AstFunction, AstImport, AstMethod, AstSymbols, ScopeImportBindings,
    ScopeKind,
};
use crate::parse::ParsedAst;

/// Symbol extraction result (AST symbol tables + parse errors, for the diagnostics face).
#[derive(Debug)]
pub struct AstExtraction {
    pub symbols: AstSymbols,
    /// ruff syntax errors (formatted strings; empty = none).
    pub errors: Vec<String>,
}

/// Parse and extract the AST symbol tables.
pub fn parse_ast_symbols(source: &str) -> AstExtraction {
    let ast = ParsedAst::new(source);
    let errors: Vec<String> = ast.errors().iter().map(|e| format!("{e:?}")).collect();
    let symbols = extract(&ast);
    AstExtraction { symbols, errors }
}

/// Extract symbol tables from an already-parsed AST (pure function, so the incremental face can reuse the same extraction).
pub fn extract(ast: &ParsedAst) -> AstSymbols {
    let mut out = AstSymbols {
        line_count: ast.line_count(),
        classes: Vec::new(),
        functions: Vec::new(),
        imports: Vec::new(),
        function_import_bindings: Default::default(),
        module_shadows: Default::default(),
    };
    let mut all_bindings = ImportBindingCollector {
        ast,
        scope_stack: Vec::new(),
        collected: Vec::new(),
        module_shadows: Default::default(),
    };
    for stmt in &ast.module().body {
        ast::visitor::Visitor::visit_stmt(&mut all_bindings, stmt);
        match stmt {
            Stmt::ClassDef(cls) => out.classes.push(extract_class(ast, cls)),
            Stmt::FunctionDef(f) => out.functions.push(extract_function(ast, f)),
            Stmt::Import(imp) => {
                for alias in &imp.names {
                    // KR-AUD-11: `import a.b` binds the top-level name `a` (Python semantics;
                    // cross-file resolution matches on the top-level name); without an asname we no
                    // longer take the full dotted path "a.b".
                    let binding = alias
                        .asname
                        .as_ref()
                        .map(|n| n.as_str().to_string())
                        .unwrap_or_else(|| top_level_binding(alias.name.as_str()));
                    out.imports.push(AstImport {
                        binding,
                        module: alias.name.as_str().to_string(),
                        symbol: None,
                        line: ast.line_col(imp.range.start().to_u32()).0,
                        is_from: false,
                        aliased: alias.asname.is_some(),
                        level: 0,
                    });
                }
            }
            Stmt::ImportFrom(impf) => {
                let module = impf
                    .module
                    .as_ref()
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                let line = ast.line_col(impf.range.start().to_u32()).0;
                for alias in &impf.names {
                    out.imports.push(AstImport {
                        binding: alias
                            .asname
                            .as_ref()
                            .map(|n| n.as_str().to_string())
                            .unwrap_or_else(|| alias.name.as_str().to_string()),
                        module: module.clone(),
                        symbol: Some(alias.name.as_str().to_string()),
                        line,
                        is_from: true,
                        aliased: alias.asname.is_some(),
                        level: impf.level,
                    });
                }
            }
            _ => {}
        }
    }
    out.function_import_bindings = all_bindings.collected;
    out.module_shadows = all_bindings.module_shadows;
    out
}

/// Binding name of `import x.y.z` (no asname) = the top-level first segment `x` (KR-AUD-11; the
/// asname branch is handled by the caller -- this helper only takes the full dotted path when
/// there is no asname).
fn top_level_binding(name: &str) -> String {
    name.split('.').next().unwrap_or(name).to_string()
}

/// Function-scope import binding collector (recursive ruff visitor, carrying a stack of line
/// intervals). Complements the top-level `imports` table: that table is the semantic face
/// (module-level bindings are visible file-wide), whereas this collector attributes import
/// bindings inside function bodies by "inner-function line interval" -- call-graph resolution
/// decides visibility by whether the call site's line number falls in the interval: an outer
/// interval covers nested bodies (closure visibility), while sibling / same-named function
/// intervals are disjoint (they do not cover each other). Not keyed by function name (a bare
/// name is not a scope-unique identifier; residual from the fourth review round).
struct ImportBindingCollector<'a> {
    ast: &'a ParsedAst,
    /// Stack of current scope layers (outer first).
    scope_stack: Vec<ScopeImportBindings>,
    /// Completed scope records (moved off the stack when a layer exits).
    collected: Vec<ScopeImportBindings>,
    /// Module-top-level Store assignment shadow surface (push_shadow lands here with an empty stack).
    module_shadows: std::collections::BTreeMap<String, usize>,
}

impl<'a> ImportBindingCollector<'a> {
    fn push_scope_layer(&mut self, kind: ScopeKind, start: usize, end: usize) {
        self.scope_stack.push(ScopeImportBindings {
            kind,
            start_line: start,
            end_line: end,
            bindings: Default::default(),
            shadows: Default::default(),
        });
    }

    /// Exit the current scope layer: move its record off the stack (empty layers are dropped --
    /// a layer with neither bindings nor shadows has no effect on resolution).
    fn pop_scope_layer(&mut self) {
        if let Some(scope) = self.scope_stack.pop() {
            if !scope.bindings.is_empty() || !scope.shadows.is_empty() {
                self.collected.push(scope);
            }
        }
    }

    fn push_binding(&mut self, binding: &str, line: usize, basename: &str, target_id: &str) {
        // Record into the innermost scope layer, keeping the most recent binding (a rebind inside the
        // same scope takes the later one; an outer interval covers nested bodies, and the
        // call-site line-number containment test implements closure-visibility semantics).
        // The same name imported multiple times with different targets (basename or target
        // identity id) = statically undecidable -> record an empty-basename ambiguity marker
        // (the resolution layer drops that edge; residual from review rounds ten/eleven).
        if let Some(top) = self.scope_stack.last_mut() {
            let base = match top.bindings.get(binding) {
                Some((_, existing_base, existing_tid))
                    if existing_base != basename || existing_tid != target_id =>
                {
                    String::new()
                }
                _ => basename.to_string(),
            };
            top.bindings
                .insert(binding.to_string(), (line, base, target_id.to_string()));
        }
    }

    fn push_shadow(&mut self, name: &str, line: usize) {
        match self.scope_stack.last_mut() {
            Some(top) => {
                top.shadows.insert(name.to_string(), line);
            }
            // Module-top-level Store assignment = the module-level shadow surface (when the function chain
            // is undecidable, the module import fallback must consult this table first --
            // residual from review round nine, item 1).
            None => {
                self.module_shadows.insert(name.to_string(), line);
            }
        }
    }

    fn collect_param_shadows(&mut self, parameters: &ast::Parameters) {
        for pwd in parameters
            .posonlyargs
            .iter()
            .chain(parameters.args.iter())
            .chain(parameters.kwonlyargs.iter())
        {
            let line = self.ast.line_col(pwd.parameter.range.start().to_u32()).0;
            self.push_shadow(pwd.parameter.name.as_str(), line);
        }
        if let Some(p) = &parameters.vararg {
            let line = self.ast.line_col(p.range.start().to_u32()).0;
            self.push_shadow(p.name.as_str(), line);
        }
        if let Some(p) = &parameters.kwarg {
            let line = self.ast.line_col(p.range.start().to_u32()).0;
            self.push_shadow(p.name.as_str(), line);
        }
    }
}

impl ast::visitor::Visitor<'_> for ImportBindingCollector<'_> {
    fn visit_stmt(&mut self, stmt: &Stmt) {
        match stmt {
            Stmt::FunctionDef(f) => {
                let start = self.ast.line_col(f.range.start().to_u32()).0;
                let end = self.ast.line_col(f.range.end().to_u32()).0;
                self.push_scope_layer(ScopeKind::Function, start, end);
                self.collect_param_shadows(&f.parameters);
                ast::visitor::walk_stmt(self, stmt);
                self.pop_scope_layer();
                return;
            }
            Stmt::ClassDef(cls) => {
                // The class body is its own scope layer: Store names inside the class do not pollute the outer
                // function's shadows (Python's bare-name resolution chain does not include the
                // class layer; graph.rs filters by kind and skips it).
                let start = self.ast.line_col(cls.range.start().to_u32()).0;
                let end = self.ast.line_col(cls.range.end().to_u32()).0;
                self.push_scope_layer(ScopeKind::Class, start, end);
                ast::visitor::walk_stmt(self, stmt);
                self.pop_scope_layer();
                return;
            }
            Stmt::Import(imp) => {
                let line = self.ast.line_col(imp.range.start().to_u32()).0;
                for alias in &imp.names {
                    let binding = alias
                        .asname
                        .as_ref()
                        .map(|n| n.as_str().to_string())
                        .unwrap_or_else(|| top_level_binding(alias.name.as_str()));
                    // Target module basename: without an alias it binds the top-level first segment (import a.b
                    // binds a, file a.py); with an alias it binds the last segment (for import
                    // a.b as c, c = b.py).
                    let basename = if alias.asname.is_some() {
                        alias
                            .name
                            .as_str()
                            .rsplit('.')
                            .next()
                            .unwrap_or("")
                            .to_string()
                    } else {
                        top_level_binding(alias.name.as_str())
                    };
                    let target_id = alias.name.as_str().to_string();
                    self.push_binding(&binding, line, &basename, &target_id);
                }
            }
            Stmt::ImportFrom(impf) => {
                let line = self.ast.line_col(impf.range.start().to_u32()).0;
                for alias in &impf.names {
                    // For `from pkg import x` the binding name is `x` itself (no asname), and the target module
                    // basename is also x (pkg/x.py); `*` imports are not recorded.
                    if alias.name.as_str() == "*" {
                        continue;
                    }
                    let binding = alias
                        .asname
                        .as_ref()
                        .map(|n| n.as_str().to_string())
                        .unwrap_or_else(|| alias.name.as_str().to_string());
                    let basename = alias.name.as_str().to_string();
                    // Target identity id: module.x (relative imports carry `level` leading dots; same-named targets
                    // at different levels must not be conflated).
                    let target_id = format!(
                        "{}{}.{}",
                        ".".repeat(impf.level as usize),
                        impf.module.as_ref().map(|m| m.as_str()).unwrap_or(""),
                        alias.name.as_str()
                    );
                    self.push_binding(&binding, line, &basename, &target_id);
                }
            }
            _ => {}
        }
        ast::visitor::walk_stmt(self, stmt);
    }

    fn visit_expr(&mut self, expr: &Expr) {
        // Comprehensions and lambdas are independent implicit scopes: their target Store names go into
        // their own layer and do not pollute the outer function's shadows (residual from review
        // round six, item 2).
        match expr {
            // Comprehensions: enter_comp_scope walks the whole subtree and exits that layer
            // internally, then we return directly, preventing the outer walk_expr from walking it
            // again and leaking targets into the outer shadows.
            Expr::ListComp(e) => return self.enter_comp_scope(e.range, expr),
            Expr::SetComp(e) => return self.enter_comp_scope(e.range, expr),
            Expr::DictComp(e) => return self.enter_comp_scope(e.range, expr),
            Expr::Generator(e) => return self.enter_comp_scope(e.range, expr),
            Expr::Lambda(e) => {
                let start = self.ast.line_col(e.range.start().to_u32()).0;
                let end = self.ast.line_col(e.range.end().to_u32()).0;
                self.push_scope_layer(ScopeKind::Function, start, end);
                if let Some(params) = &e.parameters {
                    self.collect_param_shadows(params);
                }
                ast::visitor::walk_expr(self, expr);
                self.pop_scope_layer();
                return;
            }
            // A Name in Store context = a local binding (assignment / augmented assignment / walrus /
            // for / with / comprehension target) -- counted into the current layer's shadow set
            // (with line number, so it can be adjudicated by position against import bindings).
            Expr::Name(n) if n.ctx.is_store() => {
                let line = self.ast.line_col(n.range.start().to_u32()).0;
                self.push_shadow(n.id.as_str(), line);
            }
            _ => {}
        }
        ast::visitor::walk_expr(self, expr);
    }
}

impl<'a> ImportBindingCollector<'a> {
    /// Enter the comprehension's implicit scope layer, walk the entire expression, then exit
    /// (paired, no leftover layers).
    fn enter_comp_scope(&mut self, range: ruff_text_size::TextRange, expr: &Expr) {
        let start = self.ast.line_col(range.start().to_u32()).0;
        let end = self.ast.line_col(range.end().to_u32()).0;
        self.push_scope_layer(ScopeKind::Comprehension, start, end);
        ast::visitor::walk_expr(self, expr);
        self.pop_scope_layer();
    }
}

/// Class name -> class index (for C-19 / wt-parity to look up class methods).
pub fn class_index(symbols: &AstSymbols) -> std::collections::BTreeMap<&str, &AstClass> {
    symbols
        .classes
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect()
}

fn extract_class(ast: &ParsedAst, cls: &ast::StmtClassDef) -> AstClass {
    let (start_line, _start_char) = ast.line_col(cls.range.start().to_u32());
    let end_line = ast.line_col(cls.range.end().to_u32()).0;
    let name = cls.name.as_str().to_string();
    let bases: Vec<String> = cls
        .arguments
        .as_ref()
        .map(|args| {
            args.args
                .iter()
                .filter_map(dotted_name)
                .filter(|b| b != "object")
                .collect()
        })
        .unwrap_or_default();
    let decorators = decorators(ast, &cls.decorator_list);

    let mut methods = Vec::new();
    let mut attributes = Vec::new();
    for stmt in &cls.body {
        if let Stmt::FunctionDef(f) = stmt {
            methods.push(extract_method(ast, &name, f));
            collect_attributes(ast, &name, &f.body, &mut attributes);
        }
    }
    AstClass {
        name: name.clone(),
        qualified_name: name,
        bases,
        start_line,
        end_line,
        methods,
        attributes,
        decorators,
    }
}

fn extract_method(ast: &ParsedAst, class: &str, f: &ast::StmtFunctionDef) -> AstMethod {
    let (line, character) = ast.line_col(f.range.start().to_u32());
    let end_line = ast.line_col(f.range.end().to_u32()).0;
    AstMethod {
        class: class.to_string(),
        name: f.name.as_str().to_string(),
        line,
        character,
        is_async: f.is_async,
        decorators: decorators(ast, &f.decorator_list),
        params: method_params(&f.parameters),
        end_line,
    }
}

fn extract_function(ast: &ParsedAst, f: &ast::StmtFunctionDef) -> AstFunction {
    let (line, character) = ast.line_col(f.range.start().to_u32());
    let end_line = ast.line_col(f.range.end().to_u32()).0;
    AstFunction {
        name: f.name.as_str().to_string(),
        line,
        character,
        is_async: f.is_async,
        decorators: decorators(ast, &f.decorator_list),
        params: method_params(&f.parameters),
        end_line,
    }
}

/// Formal parameter names (posonly -> pos -> vararg -> kwonly -> kwarg order; `self` is excluded).
///
/// Public so kode-server's dataflow consumer face can reuse it (the same ordering semantics, so
/// the two implementations cannot drift apart).
pub fn method_params(p: &ast::Parameters) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |name: &str| {
        if name != "self" {
            out.push(name.to_string());
        }
    };
    for a in &p.posonlyargs {
        push(a.parameter.name.as_str());
    }
    for a in &p.args {
        push(a.parameter.name.as_str());
    }
    if let Some(v) = &p.vararg {
        push(v.name.as_str());
    }
    for a in &p.kwonlyargs {
        push(a.parameter.name.as_str());
    }
    if let Some(k) = &p.kwarg {
        push(k.name.as_str());
    }
    out
}

/// Decorator source text (ruff's Decorator range already includes `@`; in source order).
fn decorators(ast: &ParsedAst, list: &[ast::Decorator]) -> Vec<String> {
    list.iter()
        .map(|d| {
            let range = d.range;
            let start = range.start().to_u32() as usize;
            let end = range.end().to_u32() as usize;
            ast.source
                .get(start..end)
                .unwrap_or("")
                .trim_end()
                .to_string()
        })
        .collect()
}

/// Recursively collect `self.<name> = ...` attribute writes inside a method body.
fn collect_attributes(ast: &ParsedAst, class: &str, body: &[Stmt], out: &mut Vec<AstAttribute>) {
    for stmt in body {
        match stmt {
            Stmt::Assign(a) => {
                for target in &a.targets {
                    if let Some(name) = self_attribute(ast, target) {
                        out.push(AstAttribute {
                            class: class.to_string(),
                            name,
                            line: ast.line_col(a.range.start().to_u32()).0,
                            character: ast.line_col(a.range.start().to_u32()).1,
                        });
                    }
                }
            }
            Stmt::AnnAssign(a) => {
                if let Some(name) = self_attribute(ast, &a.target) {
                    out.push(AstAttribute {
                        class: class.to_string(),
                        name,
                        line: ast.line_col(a.range.start().to_u32()).0,
                        character: ast.line_col(a.range.start().to_u32()).1,
                    });
                }
            }
            Stmt::AugAssign(a) => {
                if let Some(name) = self_attribute(ast, &a.target) {
                    out.push(AstAttribute {
                        class: class.to_string(),
                        name,
                        line: ast.line_col(a.range.start().to_u32()).0,
                        character: ast.line_col(a.range.start().to_u32()).1,
                    });
                }
            }
            Stmt::If(i) => {
                collect_attributes(ast, class, &i.body, out);
                for clause in &i.elif_else_clauses {
                    collect_attributes(ast, class, &clause.body, out);
                }
            }
            Stmt::For(f) => {
                collect_attributes(ast, class, &f.body, out);
                collect_attributes(ast, class, &f.orelse, out);
            }
            Stmt::While(w) => {
                collect_attributes(ast, class, &w.body, out);
                collect_attributes(ast, class, &w.orelse, out);
            }
            Stmt::With(w) => {
                collect_attributes(ast, class, &w.body, out);
            }
            Stmt::Try(t) => {
                collect_attributes(ast, class, &t.body, out);
                for h in &t.handlers {
                    let ast::ExceptHandler::ExceptHandler(inner) = h;
                    collect_attributes(ast, class, &inner.body, out);
                }
                collect_attributes(ast, class, &t.orelse, out);
                collect_attributes(ast, class, &t.finalbody, out);
            }
            Stmt::Match(m) => {
                // KODE-AUD-008: self.<attr> = ... inside match case bodies was previously missed.
                for case in &m.cases {
                    collect_attributes(ast, class, &case.body, out);
                }
            }
            Stmt::FunctionDef(_) | Stmt::ClassDef(_) => {
                // Nested def/class bodies are not collected (same semantics as kode-corpus's "directly owned by the class").
            }
            _ => {}
        }
    }
}

/// Returns `<name>` when target is `self.<name>`.
fn self_attribute(_ast: &ParsedAst, expr: &Expr) -> Option<String> {
    if let Expr::Attribute(attr) = expr {
        if let Expr::Name(n) = attr.value.as_ref() {
            if n.id.as_str() == "self" {
                return Some(attr.attr.as_str().to_string());
            }
        }
    }
    None
}

/// Reads the expression as a dotted identifier (e.g. `Base`, `kbe.Entity`); non-identifier -> None.
fn dotted_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Name(n) => Some(n.id.as_str().to_string()),
        Expr::Attribute(a) => {
            let base = dotted_name(&a.value)?;
            Some(format!("{base}.{}", a.attr.as_str()))
        }
        _ => None,
    }
}

/// Degrade to kode-corpus's lexical tables (the C-19 / wt/parity reuse face).
impl AstSymbols {
    pub fn to_corpus(&self) -> PythonModule {
        let mut classes = Vec::new();
        let mut methods = Vec::new();
        let mut attributes = Vec::new();
        for c in &self.classes {
            classes.push(ClassSymbol {
                name: c.name.clone(),
                qualified_name: c.qualified_name.clone(),
                bases: c.bases.clone(),
                start_line: c.start_line,
                end_line: c.end_line,
            });
            for m in &c.methods {
                methods.push(MethodSymbol {
                    class: m.class.clone(),
                    name: m.name.clone(),
                    line: m.line,
                    character: m.character,
                    is_async: m.is_async,
                    decorators: m.decorators.clone(),
                });
            }
            for a in &c.attributes {
                attributes.push(AttributeSymbol {
                    class: a.class.clone(),
                    name: a.name.clone(),
                    line: a.line,
                    character: a.character,
                });
            }
        }
        let imports = self
            .imports
            .iter()
            .map(|i| ImportSymbol {
                binding: i.binding.clone(),
                module: i.module.clone(),
                symbol: i.symbol.clone(),
                line: i.line,
                is_from: i.is_from,
            })
            .collect();
        PythonModule {
            line_count: self.line_count,
            classes,
            methods,
            attributes,
            imports,
            instances: Vec::new(),
        }
    }
}
