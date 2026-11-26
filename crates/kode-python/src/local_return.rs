//! Batch D return annotation receiver cascade fix (the precision main lane):
//! the body of the `$/kode/python/localReturnType` engine. Same-file receiver
//! typing -- after removing the TS cascade fallback (cascadeAnnotation's global
//! method-name guess, whose cross-class mis-binding was mislead #2 in testing),
//! this face covers the same-file derivable subset:
//!
//! - Domain gate (KBUG-SCOPE lexical scope chain): from the innermost function
//!   domain containing the hover position outward, the first domain that
//!   "binds that name" rules -- parameter binding -> honest empty (shadows the
//!   outer); a write point binding in the domain -> the nearest write point
//!   before the hover line (stop when it cannot be resolved); global/nonlocal
//!   declaration -> pass through outward; chain exhausted -> module domain.
//!   The chain for a direct class-body hover = own class body -> module; a
//!   method body hover skips the class body (the class attribute table is not
//!   on the function lexical chain, and other class bodies cannot be borrowed);
//! - The nearest write point wins (replacement semantics; with several
//!   statements on one line the last one in execution order is taken; stop
//!   when the write point cannot be resolved, no longer borrowing an earlier
//!   answer upward = the R2-F16 semantics);
//! - RHS derivation (the table shared with the flow engine): `x = f(...)` a
//!   same-file module-level def `-> T` (no guess on ambiguous same names) /
//!   `x = self.m(...)` the method annotation of the enclosing class /
//!   `x = A.m(...)` class qualified / `x = recv.m(...)` the receiver's unique
//!   atom is exactly the class name / `x = y` an alias chain recursing in the
//!   same domain;
//! - Honest boundaries: literals, `self.<attr>` attribute reads, class
//!   instantiation (not a return annotation face), no annotation, cycles,
//!   out of range -> None, never guess. The import binding path stays in TS
//!   (already receiver-correct); this face only supplies the same-file
//!   derivable truth.

use std::collections::HashSet;

use crate::self_flow::{
    flow_query_value, resolve_shape, BareWrite, CalleeBinding, CalleeShape, DefReturn, FlowParse,
    FlowVal, FnDomain, Pos, ResolveState, RhsShape,
};

/// Bounded hop count for alias chains (on the same order of magnitude as the
/// flow face's RESOLVE_MAX_HOPS; the domain gate scan strictly descends on
/// every hop, so cycles are naturally bounded -- this is only belt and braces).
const FACE_MAX_HOPS: usize = 4;

/// A localReturnType face answer (target = the hovered word;
/// annotation = the return annotation verbatim; method_name = the name of the
/// call the derivation came from, shaped like the TS
/// formatInferredReturnHover consumer face).
#[derive(Debug, Clone, PartialEq)]
pub struct LocalReturnFace {
    pub target: String,
    pub annotation: String,
    pub method_name: String,
}

/// KBUG-ORDER: the conservative fallback when the query position lacks a column
/// = the column of the first non-blank character of the hover line (consistent
/// with the old engine's semantics for a whole-line cursor hover; never
/// fabricating the line's last write point).
fn first_non_blank_col(line: &[u16]) -> usize {
    line.iter()
        .position(|c| *c != b' ' as u16 && *c != b'\t' as u16)
        .unwrap_or(0)
}

/// Receiver typing resolution entry point (pure function; versionKey protocol
/// identical to the flow face).
/// `hover_column` = 0-based UTF-16 column (the same semantics as VSCode
/// Position.character; None = missing column, falling back conservatively to the
/// line's first non-blank column). None = the hovered word has no derivable
/// return annotation (honest empty).
pub fn local_return_type(
    lines: &[Vec<u16>],
    hover_line: usize,
    hover_column: Option<usize>,
    word: &[u16],
    version_key: Option<&str>,
) -> Result<Option<LocalReturnFace>, &'static str> {
    if word.is_empty() || lines.is_empty() || hover_line >= lines.len() {
        return Ok(None);
    }
    let word = String::from_utf16_lossy(word);
    // The TS Impl's same guard: all-caps/underscore constant names are not
    // queried (the assembly face carries the same guard; belt and braces)
    if is_constant_name(&word) {
        return Ok(None);
    }
    // RUST-072: cancellation (Err) is passed through; never disguised as an
    // honest empty.
    let fp = crate::self_flow::flow_parse(lines, version_key)?;
    let mut state = ResolveState::from_flow_parse(&fp, lines);
    let mut visited = HashSet::new();
    let query = Pos {
        line: hover_line,
        col: hover_column.unwrap_or_else(|| first_non_blank_col(&lines[hover_line])),
    };
    Ok(
        face_scan(&fp, &mut state, lines, query, &word, 0, &mut visited).map(|mut face| {
            face.target = word.clone();
            face
        }),
    )
}

/// The all-caps/digit/underscore constant name guard (same semantics as the TS
/// `/^[A-Z_][A-Z0-9_]*$/`).
fn is_constant_name(word: &str) -> bool {
    let mut chars = word.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Domain gate scan (the KBUG-SCOPE lexical scope chain recast, replacing the
/// old indentation traceback): the Python name resolution model -- from the
/// innermost function domain at the hover position outward, the first domain
/// on the chain that "binds that name" rules:
/// - parameter binding -> honest empty (parameters have no return annotation
///   face, and they shadow a same-named outer binding);
/// - a write point binding inside the domain -> the nearest valid write point
///   at or before the hover position -> resolved (stop when it cannot be
///   resolved, no borrowing from outside);
/// - global/nonlocal declaration -> the domain does not bind that name, so
///   resolution goes outward;
/// - the chain exhausted -> the module domain (see `is_module_binding`).
///
/// A direct class body hover (not inside any function domain) has the chain =
/// own class body -> module: write points of the own class body are readable;
/// a method body hover's chain excludes the class body (KBUG-SCOPE-04: the
/// class attribute table is not on the function lexical chain, and another
/// class body's write points cannot be borrowed either). Write point line-domain
/// judgment replaces indentation narrowing -- write points in a def body are no
/// longer borrowed by module-level reads after the def ends, and write points
/// in a nested function body no longer leak outward.
/// KBUG-ORDER: `query` = the hover position (line + UTF-16 column; chain/class
/// containment is still by line, same-line reads and writes are not mixed, and
/// reading back the old value inside an RHS is settled by flow evaluation).
fn face_scan(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    query: Pos,
    word: &str,
    depth: usize,
    visited: &mut HashSet<(usize, usize, String)>,
) -> Option<LocalReturnFace> {
    if depth > FACE_MAX_HOPS {
        return None;
    }
    let start = query.line.min(lines.len() - 1);
    // The scope chain at the hover position: function domains containing the
    // hover line, sorted by descending body first line (innermost first;
    // on the same first line, the smaller body comes first = nested domain)
    let mut chain: Vec<&FnDomain> = fp
        .fn_domains
        .iter()
        .filter(|d| d.start_line <= start && start <= d.end_line)
        .collect();
    chain.sort_by(|a, b| {
        b.start_line
            .cmp(&a.start_line)
            .then(a.end_line.cmp(&b.end_line))
    });
    for domain in &chain {
        if domain.globals.iter().any(|n| n == word) || domain.nonlocals.iter().any(|n| n == word) {
            continue; // global/nonlocal: the domain does not bind that name, resolve outward
        }
        if domain.params.iter().any(|n| n == word) {
            return None; // parameter binding: no return annotation face, shadows the outer binding
        }
        // A write point in this domain = the name is local to this domain
        // (Python's function-level static binding): the write point value is
        // settled flow-sensitively through the statement flow tree
        // (KBUG-CFGFLOW: writes inside `if False` or after termination do not
        // pollute; at a join, answer only when every candidate agrees;
        // KBUG-ORDER: on the same line, decide by column, and a hover inside an
        // RHS reads the old value);
        // no reachable write point -> an UnboundLocal position, honest empty,
        // never borrowing a module/outer binding (KBUG-SCOPE-02).
        let domain_writes = fp.bare_writes.get(word).map(Vec::as_slice).unwrap_or(&[]);

        let binds_here = |w: &BareWrite| w.method_start == Some(domain.header_line);
        if domain_writes.iter().any(binds_here) {
            let domain_write_refs: Vec<&BareWrite> =
                domain_writes.iter().filter(|w| binds_here(w)).collect();
            let val = match fp.fn_trees.get(&domain.header_line) {
                Some(tree) => flow_query_value(tree, &domain_write_refs, query),
                // A domain without a tree (a directly assigned lambda, etc.; no bare-name
                // write point inside its body): fall back to the text-order position
                None => match domain_write_refs.iter().rev().find(|w| w.pos() <= query) {
                    Some(w) => FlowVal::One(w.pos()),
                    None => FlowVal::Unbound,
                },
            };
            return resolve_flow_val(
                fp,
                state,
                lines,
                val,
                &domain_write_refs,
                word,
                depth,
                visited,
            );
        }
        // No binding for that name in this domain -> continue to the outer function domain
    }
    // A direct class body hover: a binding in the own class body (excluding names
    // declared `global` in the class body)
    let hover_class = if chain.is_empty() {
        fp.classes
            .iter()
            .filter(|c| c.start_line <= start && start < c.end_line)
            .max_by_key(|c| c.start_line)
    } else {
        None
    };
    if let Some(cls) = hover_class {
        let declared_global = fp
            .scope_globals
            .get(&cls.start_line)
            .map(|names| names.iter().any(|n| n == word))
            .unwrap_or(false);
        if !declared_global {
            let class_writes: Vec<&BareWrite> = fp
                .bare_writes
                .get(word)
                .map(|ws| {
                    ws.iter()
                        .filter(|w| {
                            w.method_start.is_none() && w.class_start == Some(cls.start_line)
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !class_writes.is_empty() {
                let val = match fp.class_trees.get(&cls.start_line) {
                    Some(tree) => flow_query_value(tree, &class_writes, query),
                    None => match class_writes.iter().rev().find(|w| w.pos() <= query) {
                        Some(w) => FlowVal::One(w.pos()),
                        None => FlowVal::Unbound,
                    },
                };
                return resolve_flow_val(
                    fp,
                    state,
                    lines,
                    val,
                    &class_writes,
                    word,
                    depth,
                    visited,
                );
            }
            // Not bound in this class body -> fall through to the module domain
            // (module names are visible during class body execution)
        }
    }
    // A module domain binding: a write point outside any function domain; a direct
    // class body write point requires its class body to have declared `global`;
    // a function domain write point requires its function domain to have
    // declared `global` (the write point redirects the module name space).
    // The write point value is settled flow-sensitively through the module
    // statement flow tree (KBUG-CFGFLOW; a write point inside a conditional
    // block such as a main-guard is a candidate, not a certainty).
    let is_module_binding = |w: &BareWrite| -> bool {
        match w.method_start {
            Some(header) => fp
                .fn_domains
                .iter()
                .find(|d| d.header_line == header)
                .map(|d| d.globals.iter().any(|n| n == word))
                .unwrap_or(false),
            None => match w.class_start {
                None => true,
                Some(cls) => fp
                    .scope_globals
                    .get(&cls)
                    .map(|names| names.iter().any(|n| n == word))
                    .unwrap_or(false),
            },
        }
    };
    let module_writes: Vec<&BareWrite> = fp
        .bare_writes
        .get(word)
        .map(|ws| ws.iter().filter(|w| is_module_binding(w)).collect())
        .unwrap_or_default();
    if !module_writes.is_empty() {
        let val = flow_query_value(&fp.module_tree, &module_writes, query);
        return resolve_flow_val(fp, state, lines, val, &module_writes, word, depth, visited);
    }
    None
}

/// Flow value -> face answer: `One` is resolved directly; `Many` resolves each
/// candidate in turn -- all candidates sharing one face = that face, differing
/// faces = unknown, never picking one by source order (KBUG-CFGFLOW-03);
/// maybe_unbound = the join contains an unbound path -> honest empty (a
/// possible NameError); `Unbound` = no reachable write point (an UnboundLocal
/// or unreachable position).
#[allow(clippy::too_many_arguments)]
fn resolve_flow_val(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    val: FlowVal,
    writes: &[&BareWrite],
    word: &str,
    depth: usize,
    visited: &mut HashSet<(usize, usize, String)>,
) -> Option<LocalReturnFace> {
    match val {
        FlowVal::Unbound => None,
        FlowVal::One(l) => {
            let write = writes.iter().copied().find(|w| w.pos() == l)?;
            if !visited.insert((write.line, write.col, word.to_string())) {
                return None; // `x = x` identity chain / resolving the same write point twice -> honest empty
            }
            resolve_face_shape(fp, state, lines, write, depth, visited)
        }
        FlowVal::Many(cands, maybe_unbound) => {
            if maybe_unbound {
                return None;
            }
            let mut face: Option<LocalReturnFace> = None;
            for l in &cands {
                let Some(write) = writes.iter().copied().find(|w| w.pos() == *l) else {
                    continue;
                };
                if !visited.insert((write.line, write.col, word.to_string())) {
                    continue;
                }
                let f = resolve_face_shape(fp, state, lines, write, depth, visited);
                face = match (face, f) {
                    (None, f0) => f0,
                    (Some(prev), Some(f0)) if prev == f0 => Some(prev),
                    _ => return None, // the candidate results differ -> unknown
                };
            }
            face
        }
    }
}

/// The nearest write point's RHS -> face answer. A call form takes the
/// annotation directly; an alias chain recurses within the same domain; any
/// other form (literal / attribute read / unknown) is honest empty.
fn resolve_face_shape(
    fp: &FlowParse,
    state: &mut ResolveState,
    lines: &[Vec<u16>],
    write: &BareWrite,
    depth: usize,
    visited: &mut HashSet<(usize, usize, String)>,
) -> Option<LocalReturnFace> {
    match &write.shape {
        RhsShape::Call(callee) => face_from_callee(fp, state, write, callee),
        RhsShape::Local(alias) => {
            // Alias chain: resolve the alias name's nearest write point under the same
            // domain semantics (every hop strictly descends, so it is naturally
            // bounded).
            // KBUG-ORDER-03: the query position = this write point's RHS start
            // position -- an alias read only sees strictly preceding bindings;
            // self-reference and later writes on the same line are invisible
            // (hovering x in `y = a(); x = y; y = b()` resolves y's a write
            // point, without swallowing the later b write point).
            face_scan(fp, state, lines, write.rhs_pos, alias, depth + 1, visited)
        }
        _ => None,
    }
}

/// A call form -> (the annotation verbatim, the call name).
fn face_from_callee(
    fp: &FlowParse,
    state: &mut ResolveState,
    write: &BareWrite,
    callee: &CalleeShape,
) -> Option<LocalReturnFace> {
    let (annotation, method_name) = match callee {
        CalleeShape::Name(f) => {
            // The same-file module-level def annotation (an ambiguous same name / no
            // annotation / class instantiation -> honest empty: an instantiated
            // class name is not a return annotation, and the face semantics
            // does not answer it).
            // KBUG-BIND-01/02: the binding fact at the call position takes
            // precedence over the declaration table -- a parameter / local def /
            // an earlier write point binding in the domain -> honest empty; a
            // module alias binding passes the value chain annotation through
            // (the same rule as the flow face's resolve_callee; a binding whose
            // value is a class name atom -> instantiation semantics, not a
            // return annotation face, honest empty)
            let declared = |name: &str| match fp.def_returns.get(name)? {
                DefReturn::Single(Some(ann)) => Some(ann.clone()),
                _ => None,
            };
            match state.callee_binding(f, write.line) {
                CalleeBinding::Bound(Some(atom)) => {
                    if state.unique_class(&atom).is_some() {
                        return None; // bound to a class name = instantiation / static semantics, not an annotation face
                    }
                    (declared(&atom)?, f.clone())
                }
                CalleeBinding::Bound(None) => return None,
                CalleeBinding::Unbound => (declared(f)?, f.clone()),
            }
        }
        CalleeShape::SelfMethod(m) => {
            // The enclosing class's method table; a direct class body / module domain
            // write point has no class context -> honest empty
            let cls = write.class_start?;
            (state.method_atom(cls, m)?, m.clone())
        }
        CalleeShape::Qualified { class, method } => {
            // KBUG-BIND-04: the original class's static method only hits while the name is
            // **unbound** (after `A = B` / `A = unknown`, `A.load` no longer
            // follows the original class); a bound name or a class-qualified
            // miss -> the variable atom chain decides (the same priority as the
            // flow face's resolve_callee: class-qualified first, the variable
            // chain second; several candidates never take the first one)
            let static_hit = state
                .unique_class(class)
                .and_then(|cls| state.method_atom(cls, method))
                .map(|ann| (ann, method.to_string()));
            match static_hit {
                Some(hit) if state.callee_binding(class, write.line) == CalleeBinding::Unbound => {
                    hit
                }
                _ => {
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
                    let atom = atoms.into_iter().next().unwrap();
                    let cls = state.unique_class(&atom)?;
                    (state.method_atom(cls, method)?, method.clone())
                }
            }
        }
        CalleeShape::Chained { receiver, method } => {
            // The receiver's unique atom, which is exactly a class name (derivation shared
            // with the flow engine, covering local chains and instantiation
            // atoms; a direct class body write point has method_start=None, so
            // the chain face is honest empty = the same semantics as the flow face)
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
            let atom = atoms.into_iter().next().unwrap();
            let cls = state.unique_class(&atom)?;
            (state.method_atom(cls, method)?, method.clone())
        }
    };
    Some(LocalReturnFace {
        target: String::new(),
        annotation,
        method_name,
    })
}

// ---- Unit tests (pinning face semantics; cross-class mis-binding / honest
// boundaries / chaining / aliases / domain gate) ----------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(text: &str) -> Vec<Vec<u16>> {
        text.lines().map(|l| l.encode_utf16().collect()).collect()
    }

    #[test]
    fn module_def_call_annotation_hit() {
        let lines = lines_of("def make_repo() -> Repo:\n    return None\n\ndata = make_repo()\n");
        let face = local_return_type(
            &lines,
            3,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
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
        let face = local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("self.m() 所在类限定应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "get");
    }

    #[test]
    fn qualified_class_method_call() {
        let lines = lines_of(
            "class Repo:\n    @staticmethod\n    def load() -> Row:\n        return None\n\nr = Repo.load()\n",
        );
        let face = local_return_type(
            &lines,
            5,
            None,
            &"r".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("类限定方法应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    /// The user-named mislead face: two classes each have a method of the same
    /// name; class qualification answers each with its own, with no cross-class
    /// mis-binding.
    #[test]
    fn same_name_methods_in_two_classes_bind_to_their_own_class() {
        let lines = lines_of(
            "class A:\n    def get(self) -> X:\n        return None\n\nclass B:\n    def get(self) -> Y:\n        return None\n\na = A()\na_val = A.get(a)\nb_val = B.get(a)\n",
        );
        let face_a = local_return_type(
            &lines,
            9,
            None,
            &"a_val".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("A.get 应命中");
        assert_eq!(face_a.annotation, "X");
        let face_b = local_return_type(
            &lines,
            10,
            None,
            &"b_val".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("B.get 应命中");
        assert_eq!(face_b.annotation, "Y");
    }

    #[test]
    fn chained_call_via_local_alias_receiver() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\ndef make_repo() -> Repo:\n    return None\n\nrepo = make_repo()\nrow = repo.load()\n",
        );
        let face = local_return_type(
            &lines,
            8,
            None,
            &"row".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("局部接收者链应命中(Repo 原子 → load 注解)");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    #[test]
    fn chained_call_inline_receiver() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\ndef make_repo() -> Repo:\n    return None\n\nrow = make_repo().load()\n",
        );
        let face = local_return_type(
            &lines,
            7,
            None,
            &"row".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("内联链 f().g() 应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    /// Alias chain: `x = y; y = f()` -> x's face answers with f's annotation.
    #[test]
    fn alias_chain_resolves_through() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\nt = make()\nx = t\n");
        let face = local_return_type(
            &lines,
            4,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("别名链应穿透到 f 注解");
        assert_eq!(face.annotation, "Tree");
        assert_eq!(face.method_name, "make");
    }

    /// `x = x` identity chain -> honest empty (cycle protection).
    #[test]
    fn identity_alias_honest_empty() {
        let lines = lines_of("x = x\n");
        assert!(local_return_type(
            &lines,
            0,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// The nearest write point wins and resolution stops when unsolvable: after a
    /// reassignment to a literal, an earlier call answer is no longer borrowed
    /// (the R2-F16 semantics).
    #[test]
    fn overwritten_by_literal_stops_earlier_answer() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\ndata = make()\ndata = 1\n");
        assert!(local_return_type(
            &lines,
            4,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// Domain gate: a same-named write point in a sibling method body is not
    /// borrowed; a hover inside a method only recognizes the write points of
    /// that method body.
    #[test]
    fn sibling_method_write_not_borrowed() {
        let lines = lines_of(
            "class A:\n    def m(self):\n        data = 1\n\n    def n(self):\n        return data\n",
        );
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// A module-level write point passes through: the hover is in a method body
    /// while the write point is at module level (inside the domain after
    /// def/class header narrowing).
    #[test]
    fn module_write_visible_from_method_body() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\n\nclass A:\n    def n(self):\n        return data\n",
        );
        let face = local_return_type(
            &lines,
            7,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("模块层写点应被方法体 hover 借到(外层域放行)");
        assert_eq!(face.annotation, "Tree");
    }

    /// KBUG-SCOPE-04 semantics re-pinned (the ledger overturned the old
    /// contract): a bare name in a method body does not read the enclosing
    /// class body's attribute table -- `data` inside method `n` is a free name,
    /// the class body write point cannot be borrowed, honest empty
    /// (the old "class header narrowing passes through" contract answering
    /// make() was a mislead; direct class body reads go through
    /// same_class_body_hover_reads_own_class_write).
    #[test]
    fn method_body_does_not_read_class_body_table() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nclass A:\n    data = make()\n\n    def n(self):\n        return data\n",
        );
        assert!(local_return_type(
            &lines,
            6,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// A write point on the hover line is itself a candidate (the TS
    /// `line <= hoverLine` is inclusive).
    #[test]
    fn write_on_hover_line_counts() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\ndata = make()\n");
        let face = local_return_type(
            &lines,
            3,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("写点行即 hover 行应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// An unannotated def -> honest empty (nothing fabricated).
    #[test]
    fn unannotated_def_honest_empty() {
        let lines = lines_of("def make():\n    return None\n\ndata = make()\n");
        assert!(local_return_type(
            &lines,
            3,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// Same-name def ambiguity -> honest empty (no forced guess on the first
    /// definition).
    #[test]
    fn ambiguous_def_honest_empty() {
        let lines = lines_of(
            "def make() -> A:\n    return None\n\ndef make() -> B:\n    return None\n\ndata = make()\n",
        );
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// A class instantiation is not a return annotation face:
    /// `data = Repo()` -> honest empty (the flow face produces an atom; this
    /// face does not answer).
    #[test]
    fn class_instantiation_not_a_return_annotation() {
        let lines = lines_of("class Repo:\n    pass\n\ndata = Repo()\n");
        assert!(local_return_type(
            &lines,
            3,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// A `self.<attr>` read is not a call: honest empty (same null as the old
    /// TS, zero regression).
    #[test]
    fn self_attr_read_honest_empty() {
        let lines = lines_of(
            "class A:\n    def __init__(self):\n        self.counter = 1\n\n    def n(self):\n        data = self.counter\n        return data\n",
        );
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// The constant name guard (all caps) is not queried.
    #[test]
    fn constant_name_skipped() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\nDATA = make()\n");
        assert!(local_return_type(
            &lines,
            3,
            None,
            &"DATA".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// When no unique class atom can be derived for the receiver -> honest empty
    /// (no method-name guessing).
    #[test]
    fn unknown_receiver_chained_honest_empty() {
        let lines = lines_of(
            "class Repo:\n    def load(self) -> Row:\n        return None\n\nrow = mystery.load()\n",
        );
        assert!(local_return_type(
            &lines,
            4,
            None,
            &"row".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// Forward reference: the hover line precedes the write point -> honest empty
    /// (flow order).
    #[test]
    fn forward_reference_honest_empty() {
        let lines =
            lines_of("def make() -> Tree:\n    return None\n\nprint(data)\ndata = make()\n");
        assert!(local_return_type(
            &lines,
            3,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// Domain gate on a decorated def's name line: the decorator line does not
    /// narrow, the name line does (same contract as the name line).
    #[test]
    fn decorated_def_header_narrows_at_name_line() {
        let lines = lines_of(
            "def deco(fn):\n    return fn\n\n@deco\ndef make() -> Tree:\n    return None\n\ndata = make()\n",
        );
        let face = local_return_type(
            &lines,
            7,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("装饰器 def 的注解应命中(名行登记)");
        assert_eq!(face.annotation, "Tree");
    }

    /// A fake assignment inside a triple-quoted string body produces no write
    /// point (real AST statements; the old line-scan artefact face is gone).
    #[test]
    fn string_body_fake_write_not_registered() {
        let lines =
            lines_of("def make() -> Tree:\n    return None\n\nDOC = '''\ndata = make()\n'''\n");
        assert!(local_return_type(
            &lines,
            4,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// An out-of-range hover line -> None (the same guard as the flow face).
    #[test]
    fn out_of_range_hover_line() {
        let lines = lines_of("data = 1\n");
        assert!(local_return_type(
            &lines,
            9,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// An alias chain cycle: `x = y` and `y = x` point at each other -> honest
    /// empty (every hop strictly descends, so it is naturally bounded; the
    /// anti-cycle visited set is belt and braces).
    #[test]
    fn mutual_alias_cycle_honest_empty() {
        let lines = lines_of("x = y\ny = x\n");
        assert!(local_return_type(
            &lines,
            1,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// The version key cache protocol: the same key with the same text hits the
    /// cache (both queries return the same value).
    #[test]
    fn version_key_cache_hit() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\ndata = make()\n");
        let key = "local-return:cache-hit";
        let first = local_return_type(
            &lines,
            3,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            Some(key),
        )
        .expect("not cancelled")
        .expect("首查命中");
        let second = local_return_type(
            &lines,
            3,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            Some(key),
        )
        .expect("not cancelled")
        .expect("缓存复用命中");
        assert_eq!(first, second);
        crate::self_flow::reset_self_attribute_flow_parse_cache_for_tests();
    }

    // ---- KBUG-SCOPE (lexical scope chain: parameter shadowing / boundaries /
    // global / nonlocal) ----

    /// SCOPE-01: a module-level `x = make()` must not be borrowed by the
    /// parameter position of `def run(x)`.
    #[test]
    fn kbug_scope_param_shadow_blocks_module_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run(x):\n    return x\n",
        );
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-01: vararg / keyword-only / kwarg parameters shadow the same way
    /// (every parameter position is bound in its own domain).
    #[test]
    fn kbug_scope_vararg_kwonly_kwarg_params_block() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run(a: Widget, *rest, x=None, **kw):\n    return x\n",
        );
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-02: a read that comes before the write (an UnboundLocal position)
    /// does not borrow a same-named module-level binding.
    #[test]
    fn kbug_scope_unbound_local_position_not_borrow_outer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run():\n    return x\n\n    x = mystery()\n",
        );
        assert!(local_return_type(
            &lines,
            6,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-02: a write point inside a function that cannot be resolved stops
    /// immediately, without falling back to an outer typed binding.
    #[test]
    fn kbug_scope_local_unresolvable_write_blocks_module() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef run():\n    x = mystery()\n    return x\n",
        );
        assert!(local_return_type(
            &lines,
            6,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-02: a lambda parameter shadows the module-level binding (a directly
    /// assigned lambda forms its own domain).
    #[test]
    fn kbug_scope_lambda_param_shadow_blocks() {
        let lines =
            lines_of("def make() -> Tree:\n    return None\n\nx = make()\n\nfn = lambda x: x\n");
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-02: a nested function's parameter shadows (parameters on the
    /// ancestor chain block the outer resolution the same way).
    #[test]
    fn kbug_scope_nested_fn_param_blocks() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nx = make()\n\ndef outer():\n    def inner(x):\n        return x\n    return inner\n",
        );
        assert!(local_return_type(
            &lines,
            6,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-02: a write point in a nested function body must not be borrowed by
    /// an outer line (function boundary; no leakage outward).
    #[test]
    fn kbug_scope_nested_fn_write_not_visible_from_outer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef outer():\n    def inner():\n        data = make()\n    return data\n",
        );
        assert!(local_return_type(
            &lines,
            6,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-02: a write point in a def body must not be borrowed by a
    /// module-level read after the def ends.
    #[test]
    fn kbug_scope_def_body_write_not_borrowed_after_def() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef run():\n    data = make()\n\nprint(data)\n",
        );
        assert!(local_return_type(
            &lines,
            6,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-03: a read of a `global`-declared name passes through to the module
    /// binding (a legal borrow is retained).
    #[test]
    fn kbug_scope_global_read_passes_to_module() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\n\ndef run():\n    global data\n    return data\n",
        );
        let face = local_return_type(
            &lines,
            7,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("global 声明的读应透传模块层写点");
        assert_eq!(face.annotation, "Tree");
    }

    /// SCOPE-03: a reassignment of a `global`-declared name inside a function is
    /// settled by the nearest write point in the module name space
    /// (a literal reassignment -> honest empty, without borrowing back an
    /// earlier answer).
    #[test]
    fn kbug_scope_global_reassigned_literal_stops_earlier() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndata = make()\n\ndef run():\n    global data\n    data = 1\n    return data\n",
        );
        assert!(local_return_type(
            &lines,
            8,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// SCOPE-03: `nonlocal` passes through to the enclosing function domain's
    /// write point (a legal closure-chain read is retained).
    #[test]
    fn kbug_scope_nonlocal_reads_enclosing_function_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef outer():\n    data = make()\n    def inner():\n        nonlocal data\n        return data\n    return inner\n",
        );
        let face = local_return_type(
            &lines,
            7,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("nonlocal 读应解向外层函数域写点");
        assert_eq!(face.annotation, "Tree");
    }

    /// SCOPE-04: a direct class body read reads the own class body's write point
    /// (the execution-ordered name space; a legal case is retained).
    #[test]
    fn kbug_scope_class_body_hover_reads_own_class_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nclass A:\n    data = make()\n    more = data\n",
        );
        let face = local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("类体直系读应读本类体写点");
        assert_eq!(face.annotation, "Tree");
    }

    /// SCOPE-04: another class's class body write point is not borrowed
    /// (B's body cannot read A's body).
    #[test]
    fn kbug_scope_other_class_body_not_borrowed() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nclass A:\n    data = make()\n\nclass B:\n    more = data\n",
        );
        assert!(local_return_type(
            &lines,
            7,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    // ---- KBUG-BIND (a call target's binding takes precedence over the
    // declaration table) ----

    /// BIND-01: the callee name is shadowed by a parameter -- `make()` inside
    /// `def run(make)` does not borrow the module def annotation (a dynamic
    /// callable is unknown).
    #[test]
    fn kbug_bind_param_shadow_blocks_def_annotation() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef run(make):\n    data = make()\n    return data\n",
        );
        assert!(local_return_type(
            &lines,
            4,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// BIND-01 guard: an unshadowed `make()` still hits the module def
    /// annotation as usual.
    #[test]
    fn kbug_bind_unshadowed_call_still_hits() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef run():\n    data = make()\n    return data\n",
        );
        let face = local_return_type(
            &lines,
            4,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("未遮蔽调用应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// BIND-02: a bare-name call resolves the binding at the current position
    /// first -- an earlier assignment in the domain (`fetch = mystery`) shadows
    /// the module def declaration table (mystery has no declaration -> honest
    /// empty).
    #[test]
    fn kbug_bind_local_rebind_by_assignment_blocks_def_table() {
        let lines = lines_of(
            "def fetch() -> Tree:\n    return None\n\ndef run():\n    fetch = mystery\n    data = fetch()\n    return data\n",
        );
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// BIND-02: a local def in the domain shadows the same-named module
    /// declaration table (an unannotated local def -> honest empty).
    #[test]
    fn kbug_bind_local_def_shadows_module_def() {
        let lines = lines_of(
            "def fetch() -> Tree:\n    return None\n\ndef run():\n    def fetch():\n        pass\n    data = fetch()\n    return data\n",
        );
        assert!(local_return_type(
            &lines,
            6,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// BIND-02 guard: a call position before the binding -> the declaration
    /// table applies as usual (a forward reference is legal; do not blanket
    /// exclude just because a binding exists somewhere in the domain).
    #[test]
    fn kbug_bind_call_before_binding_still_declared() {
        let lines = lines_of(
            "def fetch() -> Tree:\n    return None\n\ndef run():\n    data = fetch()\n    fetch = mystery\n    return data\n",
        );
        let face = local_return_type(
            &lines,
            4,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("绑定前的调用应照常走声明表");
        assert_eq!(face.annotation, "Tree");
    }

    /// BIND-02: alias pass-through -- after `fetch = real` (real is annotated),
    /// `fetch()` hits real's annotation face (the binding value is a function
    /// name identity atom).
    #[test]
    fn kbug_bind_alias_to_annotated_fn_passes_through() {
        let lines = lines_of(
            "def real() -> Tree:\n    return None\n\ndef run():\n    fetch = real\n    data = fetch()\n    return data\n",
        );
        let face = local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("别名绑定到有注解函数应透传注解");
        assert_eq!(face.annotation, "Tree");
    }

    /// BIND-03: after a module-level class name rebind `A = B`, `A.load()` no
    /// longer follows the old A annotation (the binding value atom is B; B's
    /// class value chain cannot resolve a method face -> honest empty, never
    /// containing the old int).
    #[test]
    fn kbug_bind_module_class_rebind_does_not_keep_old_annotation() {
        let lines = lines_of(
            "class A:\n    def load(self) -> int:\n        return None\n\nclass B:\n    def load(self) -> str:\n        return None\n\nA = B\ndata = A.load(A())\n",
        );
        assert!(local_return_type(
            &lines,
            9,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// BIND-03: a module-level rebind to an unknown name `A = unknown` likewise
    /// does not follow the original class.
    #[test]
    fn kbug_bind_module_rebind_to_unknown_honest() {
        let lines = lines_of(
            "class A:\n    def load(self) -> int:\n        return None\n\nA = unknown\ndata = A.load(A())\n",
        );
        assert!(local_return_type(
            &lines,
            5,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    /// BIND-04 guard: the original class's static method (the name is unbound)
    /// still hits the class-qualified face as usual.
    #[test]
    fn kbug_bind_original_class_qualified_still_hits() {
        let lines = lines_of(
            "class Repo:\n    @staticmethod\n    def load() -> Row:\n        return None\n\nr = Repo.load()\n",
        );
        let face = local_return_type(
            &lines,
            5,
            None,
            &"r".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("未绑定类名的类限定调用应命中");
        assert_eq!(face.annotation, "Row");
        assert_eq!(face.method_name, "load");
    }

    /// BIND-03 (bare-name form): after a module-level `make = mystery` rebind,
    /// `make()` does not borrow the module def annotation.
    #[test]
    fn kbug_bind_module_name_rebind_blocks_def_annotation() {
        let lines =
            lines_of("def make() -> Tree:\n    return None\n\nmake = mystery\ndata = make()\n");
        assert!(local_return_type(
            &lines,
            4,
            None,
            &"data".encode_utf16().collect::<Vec<u16>>(),
            None
        )
        .expect("not cancelled")
        .is_none());
    }

    // ---- KBUG-CFGFLOW (branch reachability / joins / termination /
    // conservative loop and exception handling / the query position) ----

    /// CFGFLOW-01/02: a str write point inside `if False` does not pollute the
    /// outer int face (a statically dead branch is unreachable and produces no
    /// exit).
    #[test]
    fn kbug_cfgflow_if_false_write_not_pollute() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif False:\n    x = other()\nprint(x)\n",
        );
        let face = local_return_type(
            &lines,
            9,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("可达 int 写点应命中");
        assert_eq!(face.annotation, "Tree");
        assert_eq!(face.method_name, "make");
    }

    /// CFGFLOW-01 guard: `if True` = a statically definite branch, so the str
    /// write point definitely takes effect.
    #[test]
    fn kbug_cfgflow_if_true_definite_write() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif True:\n    x = other()\nprint(x)\n",
        );
        let face = local_return_type(
            &lines,
            9,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("if True 确定写点应命中");
        assert_eq!(face.annotation, "Rock");
    }

    /// CFGFLOW-03 guard: both if/else branches share the same face (the same
    /// call) -> the join still hits.
    #[test]
    fn kbug_cfgflow_if_else_same_face_confluence() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nif cond:\n    x = make()\nelse:\n    x = make()\nprint(x)\n",
        );
        let face = local_return_type(
            &lines,
            7,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("两支同面合流应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// CFGFLOW-03: the if/else branches have different faces -> unknown; never
    /// take the last branch by source order.
    #[test]
    fn kbug_cfgflow_if_else_differ_honest_unknown() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nif cond:\n    x = make()\nelse:\n    x = other()\nprint(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                10,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "两支不同面应未知"
        );
    }

    /// CFGFLOW-03: a conditional branch without else -> the entry value path
    /// joins in; different candidates -> unknown.
    #[test]
    fn kbug_cfgflow_no_else_differ_honest() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif cond:\n    x = other()\nprint(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                9,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "无 else 分支候选不同应未知"
        );
    }

    /// CFGFLOW-03: a conditional branch assignment only (no entry write point)
    /// -> possibly unbound, honest empty.
    #[test]
    fn kbug_cfgflow_cond_only_write_maybe_unbound() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nif cond:\n    x = make()\nprint(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                5,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "可能未绑定路径应诚实空"
        );
    }

    /// CFGFLOW-04: a terminated branch's (return) exit does not reach the
    /// statement after it -> only reachable paths join.
    #[test]
    fn kbug_cfgflow_terminated_branch_excluded() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\ndef run():\n    x = make()\n    if cond:\n        x = other()\n        return\n    print(x)\n",
        );
        let face = local_return_type(
            &lines,
            11,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("终止分支剔除后应命中可达路径");
        assert_eq!(face.annotation, "Tree");
    }

    /// CFGFLOW-04: a nested def's return does not terminate the outer path (the
    /// function boundary is respected).
    #[test]
    fn kbug_cfgflow_nested_def_return_not_terminate_outer() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\ndef run():\n    x = make()\n    if cond:\n        def inner():\n            return\n        x = other()\n    print(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                12,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "嵌套 return 不终止外层:两支候选不同应未知"
        );
    }

    /// CFGFLOW-02: a write point after an unconditional termination is
    /// unreachable; querying an unreachable position is honest empty.
    #[test]
    fn kbug_cfgflow_after_return_unreachable_honest() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\ndef run():\n    x = make()\n    return\n    x = other()\n    print(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                10,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "终止后不可达写点不应命中"
        );
    }

    /// CFGFLOW-05: loop conservatism (the 0-iteration entry value unioned with
    /// the >=1-iteration body exit); different candidates -> unknown, never
    /// falling back to the last textual write point.
    #[test]
    fn kbug_cfgflow_loop_conservative() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nfor i in items:\n    x = other()\nprint(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                9,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "循环后候选不同应未知"
        );
    }

    /// CFGFLOW-05: a read inside a loop body before the write point -> conservative
    /// about the loop back edge (>= 2 iterations see the previous round's write
    /// point); unknown, never falling back to the first textual write point.
    #[test]
    fn kbug_cfgflow_loop_body_read_before_write_conservative() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nfor i in items:\n    print(x)\n    x = other()\n",
        );
        assert!(
            local_return_type(
                &lines,
                8,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "循环体环回候选应未知"
        );
    }

    /// CFGFLOW-05: try/except conservative union (the exception path's entry
    /// value plus the try body exit); different candidates -> unknown.
    #[test]
    fn kbug_cfgflow_try_conservative() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\ntry:\n    x = other()\nexcept ValueError:\n    pass\nprint(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                11,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "try 保守候选不同应未知"
        );
    }

    /// CFGFLOW-06: the query position is flow sensitive -- before the branch,
    /// inside the branch, and after the join each get their path result;
    /// straight-line inference keeps passing.
    #[test]
    fn kbug_cfgflow_positions_flow_sensitive() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\ndef other() -> Rock:\n    return None\n\nx = make()\nif cond:\n    print(x)\n    x = other()\ny = x\n",
        );
        // Before the branch: straight-line and definite
        let face = local_return_type(
            &lines,
            6,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("分支前直线写点应命中");
        assert_eq!(face.annotation, "Tree");
        // Inside the branch, the read position precedes the write: the entry value
        // applies directly
        let face = local_return_type(
            &lines,
            8,
            None,
            &"x".encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .expect("not cancelled")
        .expect("分支内入口值应命中");
        assert_eq!(face.annotation, "Tree");
        // After the join: different candidates -> unknown
        assert!(
            local_return_type(
                &lines,
                10,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "合流后候选不同应未知"
        );
    }

    /// CFGFLOW-01/02: a query inside a statically dead branch = an unreachable
    /// position, honest empty (never resolve a dead write point).
    #[test]
    fn kbug_cfgflow_query_in_dead_branch_honest() {
        let lines = lines_of(
            "def make() -> Tree:\n    return None\n\nif False:\n    x = make()\n    print(x)\n",
        );
        assert!(
            local_return_type(
                &lines,
                5,
                None,
                &"x".encode_utf16().collect::<Vec<u16>>(),
                None
            )
            .expect("not cancelled")
            .is_none(),
            "死分支内查询应诚实空"
        );
    }

    // ---- KBUG-ORDER: same-line assignment order / query column precision
    // (flow values are settled by Pos(line, UTF-16 column)) ----

    fn wu16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect::<Vec<u16>>()
    }

    /// ORDER-01: a same-line alias does not swallow a future write point. On one
    /// line `y = a(); x = y; y = b()`, x's alias traceback only sees the y
    /// binding before its own RHS (a's int); the later same-line `y = b()` is
    /// invisible; reversing the statement order changes the answer with the
    /// real execution order.
    #[test]
    fn kbug_order_same_line_alias_future_value() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    y = a(); x = y; y = b()\n    return x\n",
        );
        // Hovering the x of `return x` (line 8, col 11): x's write point precedes the
        // same-line y=b(), so the alias resolves y=a()'s int
        let face = local_return_type(&lines, 8, Some(11), &wu16("x"), None)
            .expect("not cancelled")
            .expect("同行别名应命中 a 的 int");
        assert_eq!(face.annotation, "int");
        assert_eq!(face.method_name, "a");

        // Reversed: y = b(); x = y; y = a() -> str (following the real execution order)
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    y = b(); x = y; y = a()\n    return x\n",
        );
        let face = local_return_type(&lines, 8, Some(11), &wu16("x"), None)
            .expect("not cancelled")
            .expect("同行别名应命中 b 的 str");
        assert_eq!(face.annotation, "str");
        assert_eq!(face.method_name, "b");
    }

    /// ORDER-01 split-line version: the alias traceback does not cross past a new
    /// binding made after the write point's RHS.
    #[test]
    fn kbug_order_multiline_alias_future_value() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    y = a()\n    x = y\n    y = b()\n    return x\n",
        );
        let face = local_return_type(&lines, 10, Some(11), &wu16("x"), None)
            .expect("not cancelled")
            .expect("别名应命中 a 的 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-05: on one line, a read before the write is not mixed up.
    /// `print(x); x = b()` -- hovering x inside print (explicit column) = a read
    /// before the write point, honest empty; hovering the x target = the new
    /// value str; hovering x before b inside the RHS = the old value (no old
    /// binding here, honest empty); a missing column = the conservative fallback
    /// to the line's first non-blank column (honest empty), never defaulting to
    /// the line's last write point.
    #[test]
    fn kbug_order_read_before_write_same_line() {
        let lines =
            lines_of("def b() -> str:\n    return None\n\ndef run():\n    print(x); x = b()\n");
        // Hovering the x of print(x) (col 10): the write point has not executed yet ->
        // UnboundLocal, honest empty
        assert!(
            local_return_type(&lines, 4, Some(10), &wu16("x"), None)
                .expect("not cancelled")
                .is_none(),
            "读前写点应诚实空"
        );
        // Hovering the x target (col 14): the target position precedes the RHS = the
        // new value str
        let face = local_return_type(&lines, 4, Some(14), &wu16("x"), None)
            .expect("not cancelled")
            .expect("悬目标应见新值");
        assert_eq!(face.annotation, "str");
        // Hovering inside the RHS of x = b() (col 18): an in-statement read of the old
        // value -> no old binding, honest empty
        assert!(
            local_return_type(&lines, 4, Some(18), &wu16("x"), None)
                .expect("not cancelled")
                .is_none(),
            "RHS 内读应见旧值(此处未绑定)"
        );
        // Missing column: the conservative fallback to the first non-blank column
        // (col 4 = inside the print statement) -> honest empty
        assert!(
            local_return_type(&lines, 4, None, &wu16("x"), None)
                .expect("not cancelled")
                .is_none(),
            "缺列应保守,不得默认整行末写点"
        );
        // A read after the write (the next line): str hits as usual
        let lines2 = lines_of(
            "def b() -> str:\n    return None\n\ndef run():\n    print(x); x = b()\n    return x\n",
        );
        let face = local_return_type(&lines2, 5, Some(11), &wu16("x"), None)
            .expect("not cancelled")
            .expect("写后读应命中 str");
        assert_eq!(face.annotation, "str");
    }

    /// ORDER-05: a read after a write on the same line is not mixed up.
    /// `x = a(); print(x)` -- hovering the x inside print -> int.
    #[test]
    fn kbug_order_write_then_read_same_line() {
        let lines =
            lines_of("def a() -> int:\n    return None\n\ndef run():\n    x = a(); print(x)\n");
        // `    x = a(); print(x)`: the x inside print is at col 14
        let face = local_return_type(&lines, 4, Some(14), &wu16("x"), None)
            .expect("not cancelled")
            .expect("写后读应命中 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-03: simultaneous tuple assignment. The `x, y = y, x` swap -- hovering
    /// the x target = the old y's face (str), hovering the y target = the old
    /// x's face (int); mutual reads on the same line are settled by the RHS
    /// element position, without swallowing the other side.
    #[test]
    fn kbug_order_tuple_swap_reads_pre_values() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\nx = a()\ny = b()\nx, y = y, x\n",
        );
        // Hovering the x target (line 8, col 0): resolves the old y -> str
        let face = local_return_type(&lines, 8, Some(0), &wu16("x"), None)
            .expect("not cancelled")
            .expect("交换悬 x 应见旧 y 的 str");
        assert_eq!(face.annotation, "str");
        // Hovering the y target (line 8, col 3): resolves the old x -> int
        let face = local_return_type(&lines, 8, Some(3), &wu16("y"), None)
            .expect("not cancelled")
            .expect("交换悬 y 应见旧 x 的 int");
        assert_eq!(face.annotation, "int");
        // Hovering the same-line RHS element region (line 8, col 9, before the x
        // element): the simultaneous assignment is incomplete -> the old value
        // (a()'s int), not swallowing this statement's new binding
        let face = local_return_type(&lines, 8, Some(9), &wu16("x"), None)
            .expect("not cancelled")
            .expect("交换 RHS 域内读旧值应见 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-03: chained assignment `x = y = make()` -- each target shares the
    /// same RHS, so hovering the two targets in order both give Tree; the later
    /// alias z = y passes through as usual.
    #[test]
    fn kbug_order_chained_assignment_targets() {
        let lines = lines_of("def make() -> Tree:\n    return None\n\nx = y = make()\nz = y\n");
        let face = local_return_type(&lines, 3, Some(0), &wu16("x"), None)
            .expect("not cancelled")
            .expect("链式 x 应命中");
        assert_eq!(face.annotation, "Tree");
        let face = local_return_type(&lines, 3, Some(4), &wu16("y"), None)
            .expect("not cancelled")
            .expect("链式 y 应命中");
        assert_eq!(face.annotation, "Tree");
        let face = local_return_type(&lines, 4, Some(0), &wu16("z"), None)
            .expect("not cancelled")
            .expect("链式后别名应命中");
        assert_eq!(face.annotation, "Tree");
    }

    /// ORDER-03 self-reference: `x = x` does not swallow its own write point --
    /// the RHS reads the old value and the previously bound face is retained
    /// (the old line-granular engine picked its own write point as the nearest
    /// resolution -> cycle protection, honest empty; now resolved against the
    /// RHS position time boundary to the prior value).
    #[test]
    fn kbug_order_self_reference_reads_prior_binding() {
        let lines = lines_of("def a() -> int:\n    return None\n\nx = a()\nx = x\n");
        // Hovering the target of x = x (col 0): new value = old value = int
        // (a self-reference keeps the face)
        let face = local_return_type(&lines, 3, Some(0), &wu16("x"), None)
            .expect("not cancelled")
            .expect("自引用应保留前值 int");
        assert_eq!(face.annotation, "int");
        // Hovering the next line (after the write): the same int
        let face = local_return_type(&lines, 4, Some(0), &wu16("x"), None)
            .expect("not cancelled")
            .expect("自引用后读应命中 int");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-05: a multi-line RHS -- hovering the continuation line (the
    /// statement incomplete) = an in-statement read of the old value (the prior
    /// binding, int); hovering after the statement = the new value Tree.
    #[test]
    fn kbug_order_multiline_rhs_reads_old_then_new() {
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef make() -> Tree:\n    return None\n\nx = a()\nx = make(\n    1, 2)\nprint(x)\n",
        );
        // Hovering the RHS first line (7,4): inside the x = make( statement and
        // past the RHS start position -> the old value int
        let face = local_return_type(&lines, 7, Some(4), &wu16("x"), None)
            .expect("not cancelled")
            .expect("多行 RHS 内读应见旧值 int");
        assert_eq!(face.annotation, "int");
        // Hovering the continuation line's argument area (8,5): the statement is
        // still incomplete -> the old value int
        let face = local_return_type(&lines, 8, Some(5), &wu16("x"), None)
            .expect("not cancelled")
            .expect("续行参数区读应见旧值 int");
        assert_eq!(face.annotation, "int");
        // Hovering the print(x) after the statement completed (line 9, col 6):
        // the new value Tree
        let face = local_return_type(&lines, 9, Some(6), &wu16("x"), None)
            .expect("not cancelled")
            .expect("语句后读应见新值 Tree");
        assert_eq!(face.annotation, "Tree");
    }

    /// ORDER-05: UTF-16 columns on an emoji line (a surrogate pair counts 2) --
    /// multiple write points on one line are ordered by UTF-16 column; a
    /// character-count contract would misalign them.
    #[test]
    fn kbug_order_emoji_utf16_columns() {
        // `    d = "🚀"; x = a(); x = b()`: d=4, 🚀 occupies two UTF-16 units (9-10),
        // the first x=14, the second x=23 (a character-count contract would
        // compute 22)
        let lines = lines_of(
            "def a() -> int:\n    return None\n\ndef b() -> str:\n    return None\n\ndef run():\n    d = \"🚀\"; x = a(); x = b()\n",
        );
        // Hovering the first x target (col 14) -> int
        let face = local_return_type(&lines, 7, Some(14), &wu16("x"), None)
            .expect("not cancelled")
            .expect("emoji 行第一写点应命中 int");
        assert_eq!(face.annotation, "int");
        // Hovering the blank space before the second x (col 22): x = b() has not
        // been reached yet -> still int
        let face = local_return_type(&lines, 7, Some(22), &wu16("x"), None)
            .expect("not cancelled")
            .expect("列 22 应仍在第一写点 int");
        assert_eq!(face.annotation, "int");
        // Hovering the second x target (col 23, UTF-16) -> str
        let face = local_return_type(&lines, 7, Some(23), &wu16("x"), None)
            .expect("not cancelled")
            .expect("emoji 行第二写点应命中 str");
        assert_eq!(face.annotation, "str");
    }

    /// ORDER-05: a trailing comment -- hovering x inside the comment (the
    /// statement has long completed) = the new value is in effect (a comment is
    /// not statement territory, so no RHS boundary is judged).
    #[test]
    fn kbug_order_comment_hover_after_statement() {
        let lines = lines_of("def a() -> int:\n    return None\n\nx = a()  # x\n");
        // `x = a()  # x`: the x inside the comment is at col 11
        let face = local_return_type(&lines, 3, Some(11), &wu16("x"), None)
            .expect("not cancelled")
            .expect("注释悬停应见已生效写点");
        assert_eq!(face.annotation, "int");
    }

    /// ORDER-03 an explicitly unknown unsupported form: `x, y = pair` (the
    /// right side is not an equal-length tuple literal) goes through the generic
    /// form; when the swap pairing does not hold, do not fabricate a matching
    /// face (hovering x resolves the whole RHS shape -- unsupported = honest
    /// empty).
    #[test]
    fn kbug_order_unsupported_tuple_shape_honest() {
        let lines = lines_of("def pair() -> tuple:\n    return None\n\nx, y = pair()\n");
        assert!(
            local_return_type(&lines, 3, Some(0), &wu16("x"), None)
                .expect("not cancelled")
                .is_none(),
            "非配对元组解包应诚实空"
        );
    }

    // ---- COV-1 round 2 (2026-11-19): driving the self_flow statement flow tree
    // ---- evaluation arms (eval_block query positions 820-973) and the binding
    // ---- machine (1895-2210) through this entry point ----

    fn face_is(lines: &[&str], line: usize, word: &str) -> Option<String> {
        let ls = lines_of(&lines.join("\n"));
        local_return_type(&ls, line, None, &wu16(word), None)
            .expect("not cancelled")
            .map(|f| f.annotation)
    }

    #[test]
    fn cov_tree_then_span_query_keeps_block_value() {
        // The query lands inside the then block (898): a literal write point has
        // no annotation face -> None (the arm already executed)
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    if c:",
            "        v = 1",
            "        v = 2",
            "    return v",
        ];
        assert_eq!(face_is(&lines, 4, "v"), None);
    }

    #[test]
    fn cov_tree_dead_else_query_unbound_honest() {
        // A query inside the else block of a const-true (899-913) -> unreachable
        // = honest empty
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    if True:",
            "        v = 1",
            "    else:",
            "        v = 2",
        ];
        assert_eq!(face_is(&lines, 5, "v"), None);
    }

    #[test]
    fn cov_tree_if_header_query_keeps_entry() {
        // The query in the if header line gap (915-919): the entry literal has no
        // annotation face -> None (the arm already executed)
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    if c:",
            "        v = 1",
            "    return v",
        ];
        assert_eq!(face_is(&lines, 2, "v"), None);
    }

    #[test]
    fn cov_tree_loop_body_and_header_queries() {
        // A query inside the body (943-948) / a header line position query
        // (950-954): a literal has no face -> None (the arm already executed)
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    while c:",
            "        v = 1",
            "    return v",
        ];
        assert_eq!(face_is(&lines, 3, "v"), None);
        assert_eq!(face_is(&lines, 2, "v"), None);
    }

    #[test]
    fn cov_tree_join_case_and_gap_queries() {
        // A query inside a case block (958-967) / a non-case position in the match
        // domain (969-973)
        let lines = [
            "def m(x):",
            "    v = 'init'",
            "    match x:",
            "        case 1:",
            "            v = 1",
            "        case _:",
            "            v = 2",
            "    return v",
        ];
        assert_eq!(face_is(&lines, 4, "v"), None);
        assert_eq!(face_is(&lines, 2, "v"), None);
    }

    #[test]
    fn cov_tree_both_branches_terminated_after_query() {
        // Both branches terminated at the join (820-826): any_live=false -> the
        // terminated exit
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    if c:",
            "        return",
            "    else:",
            "        return",
            "    v = 1",
        ];
        assert_eq!(face_is(&lines, 6, "v"), None);
    }

    #[test]
    fn cov_tree_while_else_folds_into_exit() {
        // The while-else exit folds in (836-837)
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    while c:",
            "        v = 1",
            "    else:",
            "        v = 's'",
            "    return v",
        ];
        // The while-else folds into the exit; a literal write point has no
        // annotation face -> None (verified by test)
        assert_eq!(face_is(&lines, 6, "v"), None);
    }

    #[test]
    fn cov_tree_many_of_many_nested_branch_in_loop() {
        // Multiple branch write points inside the loop -> Many nested flattening
        // (558-561)
        let lines = [
            "def m(c, d):",
            "    v = 'init'",
            "    while c:",
            "        if d:",
            "            v = 1",
            "        else:",
            "            v = 2",
            "    return v",
        ];
        assert_eq!(face_is(&lines, 7, "v"), None);
    }

    #[test]
    fn cov_tree_unbound_fold_in_no_else_branch() {
        // The no-else fold merges into the entry Unbound (567) -> maybe_unbound,
        // honest empty
        let lines = ["def m(c):", "    if c:", "        v = 1", "    return v"];
        assert_eq!(face_is(&lines, 3, "v"), None);
    }

    #[test]
    fn cov_class_direct_alias_binding() {
        // Class-body direct binding + Local alias recursion (2004-2019): alias is not a
        // call, no annotation face -> None (the binding-resolution arm already executed)
        let lines = [
            "def make() -> Repo:",
            "    return None",
            "class K:",
            "    helper = make",
            "    x = helper",
        ];
        assert_eq!(face_is(&lines, 4, "helper"), None);
    }

    #[test]
    fn cov_module_alias_binding() {
        // Module-level bare-write alias (2053-2062): not a call, no face -> None (the arm already executed)
        let lines = [
            "def make() -> Repo:",
            "    return None",
            "alias = make",
            "def use():",
            "    data = alias",
        ];
        assert_eq!(face_is(&lines, 4, "alias"), None);
    }

    #[test]
    fn cov_binding_after_query_unbound() {
        // Binding after the query position (2019/2038) -> Unbound, honest empty
        let lines = ["def m():", "    a = v", "    v = 1"];
        assert_eq!(face_is(&lines, 1, "v"), None);
    }

    #[test]
    fn cov_global_declaration_redirects_to_module() {
        // In-domain global declaration yields (1965) + write point redirects to the module
        let lines = [
            "g = 5",
            "def m():",
            "    global g",
            "    g = 6",
            "    x = g",
        ];
        // After the global yields, the binding lands on the module; a literal has no
        // annotation face -> None (verified by test)
        assert_eq!(face_is(&lines, 4, "g"), None);
    }

    #[test]
    fn cov_numeric_unary_atom_faces() {
        // Unary numeric arm: complex (326/357) / Invert unknown (331) / walrus (350) / nested unary (351-352)
        let lines = [
            "def m(x):",
            "    a = -1j",
            "    b = ~x",
            "    c = (n := 5)",
            "    d = --5",
            "    e = +1j",
            "    return a",
        ];
        // Unary numeric shapes: face = annotation face, numeric literals have no
        // annotation -> all None (verified by test; the numeric type lands in the
        // write-point shape, consumed by the flow face)
        assert_eq!(face_is(&lines, 6, "a"), None);
        assert_eq!(face_is(&lines, 6, "b"), None);
        assert_eq!(face_is(&lines, 6, "c"), None);
        assert_eq!(face_is(&lines, 6, "d"), None);
        assert_eq!(face_is(&lines, 6, "e"), None);
    }

    #[test]
    fn cov_unknown_callee_honest_none() {
        // Unknown-name callee (around 2097/2157): resolution does not extrapolate
        let lines = ["def m():", "    v = nope()", "    return v"];
        assert_eq!(face_is(&lines, 2, "v"), None);
    }

    #[test]
    fn cov_unknown_receiver_not_guessed() {
        // Receiver not unique / unknown: no guessing (2207)
        let lines = ["def m():", "    v = other.get()", "    return v"];
        assert_eq!(face_is(&lines, 2, "v"), None);
    }

    // ---- COV-1 round three: column-exact position query (910-919) / loop body without write (943-948) /
    // ---- all-Unbound fold (567) / binding-machine deep arms (1957-2062/2166-2207) /
    // ---- method annotation ambiguity (1918) / baseline memo hit (1895) / lambda callee (1067) ----

    fn face_at(lines: &[&str], line: usize, col: usize, word: &str) -> Option<String> {
        let ls = lines_of(&lines.join("\n"));
        local_return_type(&ls, line, Some(col), &wu16(word), None)
            .expect("not cancelled")
            .map(|f| f.annotation)
    }

    #[test]
    fn cov_tree_if_header_col_query_entry_value() {
        // Query position = the if-line test-expression column (>= Branch start) -> the header-line gap arm (915-919)
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    if c:",
            "        v = 1",
            "    return v",
        ];
        assert_eq!(face_at(&lines, 2, 7, "v"), None);
    }

    #[test]
    fn cov_tree_else_span_non_const_query() {
        // Position query inside the non-constant else block (910-913): enters the else-body evaluation
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    if c:",
            "        v = 1",
            "    else:",
            "        v = 2",
        ];
        assert_eq!(face_at(&lines, 5, 8, "v"), None);
    }

    #[test]
    fn cov_tree_loop_body_without_hovered_write() {
        // Query inside the loop body but no write point for that name in the body (943-948)
        let lines = [
            "def m(c):",
            "    v = 'init'",
            "    while c:",
            "        x = 1",
            "    return v",
        ];
        assert_eq!(face_at(&lines, 3, 8, "v"), None);
    }

    #[test]
    fn cov_fold_all_unbound_branch() {
        // No else and the then exit is also unbound -> folds to all Unbound (567)
        let lines = ["def m(c):", "    if c:", "        x = 1", "    return v"];
        assert_eq!(face_is(&lines, 3, "v"), None);
    }

    #[test]
    fn cov_nested_def_chain_sort() {
        // Nested def: scope-chain two-domain sort (1957-1960)
        let lines = [
            "def outer(c):",
            "    def inner():",
            "        v = nope()",
            "    return v",
        ];
        assert_eq!(face_is(&lines, 3, "v"), None);
    }

    #[test]
    fn cov_class_alias_chain_resolves_class_binding() {
        // Class-body alias chain: local_atom takes the class-body binding arm (2004-2019)
        let lines = [
            "class K:",
            "    b = 5",
            "    a1 = b",
            "    a2 = a1",
            "    a3 = a2",
        ];
        assert_eq!(face_is(&lines, 4, "a2"), None);
    }

    #[test]
    fn cov_class_alias_bound_after_query_unbound() {
        // Class-body binding after the query position (2019)
        let lines = ["class K:", "    u = a1", "    a1 = b", "    b = 5"];
        assert_eq!(face_is(&lines, 1, "a1"), None);
    }

    #[test]
    fn cov_method_alias_chain_and_bound_after() {
        // Method-domain alias chain (2029-2036) and binding after (2038)
        let lines = ["def m():", "    w1 = w2", "    w2 = 5", "    return w1"];
        assert_eq!(face_is(&lines, 3, "w1"), None);
        let after = [
            "def m():",
            "    w1 = w2",
            "    w2 = 5",
            "    q = w1",
            "    return q",
        ];
        assert_eq!(face_is(&after, 4, "q"), None);
    }

    #[test]
    fn cov_callee_alias_call_bound_atom() {
        // Alias callee: CalleeBinding::Bound(Some) -> callee_atom (2166) -> annotation face
        let lines = [
            "def make() -> Repo:",
            "    return None",
            "def use():",
            "    mk = make",
            "    v = mk()",
            "    return v",
        ];
        assert_eq!(face_is(&lines, 5, "v").as_deref(), Some("Repo"));
    }

    #[test]
    fn cov_callee_alias_literal_bound_none() {
        // Literal alias callee: Bound(None) (2167) -> honest empty
        let lines = ["def use():", "    mk = 5", "    v = mk()", "    return v"];
        assert_eq!(face_is(&lines, 3, "v"), None);
    }

    #[test]
    fn cov_receiver_not_unique_no_guess() {
        // Receiver type not unique -> no guessing (2207)
        let lines = [
            "class K:",
            "    def m(self, c):",
            "        if c:",
            "            self.h = A()",
            "        else:",
            "            self.h = B()",
            "        v = self.h.get()",
            "        return v",
        ];
        assert_eq!(face_is(&lines, 7, "v"), None);
    }

    #[test]
    fn cov_ambiguous_same_name_method_atom_none() {
        // Same-named methods in the same class with multiple annotations -> ambiguous, no guessing (1918)
        let lines = [
            "class K:",
            "    def get(self) -> A:",
            "        return None",
            "    def get(self) -> B:",
            "        return None",
            "    def m(self):",
            "        v = self.get()",
            "        return v",
        ];
        assert_eq!(face_is(&lines, 7, "v"), None);
    }

    #[test]
    fn cov_baseline_memo_hit_via_many_candidates() {
        // Confluence with many candidates on the same receiver -> baseline memo second-visit hit (1895)
        let lines = [
            "class K:",
            "    def __init__(self):",
            "        self.src = S()",
            "    def m(self, c):",
            "        if c:",
            "            v = self.src.get()",
            "        else:",
            "            v = self.src.get()",
            "        return v",
        ];
        // Two candidates on the same receiver: baseline memo second-visit hit; S is undeclared -> no face (verified by test)
        assert_eq!(face_is(&lines, 8, "v"), None);
    }

    #[test]
    fn cov_lambda_callee_shape_unknown() {
        // Callee = lambda call form -> RhsShape::Unknown (1067)
        let lines = ["def m():", "    v = (lambda: 1)()", "    return v"];
        assert_eq!(face_is(&lines, 2, "v"), None);
    }

    // ---- COV-1 round four: callee_binding class/module arms (2004-2062),
    // ---- Bound(Some/None) consumption (2166-2167), chain comparator (1957-1960),
    // ---- global domain penetration, tuple unpack pairing (1700-1702) ----

    #[test]
    fn cov_nested_def_hover_inside_inner_chain_sort() {
        // Hover position inside a nested def body -> chain with two domains, comparator exercised (1957-1960)
        let lines = [
            "def outer(c):",
            "    def inner():",
            "        v = 1",
            "    return c",
        ];
        assert_eq!(face_is(&lines, 2, "v"), None);
    }

    #[test]
    fn cov_class_body_callee_alias_call() {
        // Class-body direct alias callee: callee_binding class-body arm (2004-2019)
        let lines = [
            "def make() -> Repo:",
            "    return None",
            "class K:",
            "    mk = make",
            "    v = mk()",
        ];
        assert_eq!(face_is(&lines, 4, "v").as_deref(), Some("Repo"));
    }

    #[test]
    fn cov_class_body_callee_bound_after_and_literal() {
        // Class-body binding after (2019/2038) and literal binding (2036)
        let after = [
            "def make() -> Repo:",
            "    return None",
            "class K:",
            "    v = mk2()",
            "    mk2 = make",
        ];
        assert_eq!(face_is(&after, 3, "v"), None);
        let lit = ["class K:", "    mk = 5", "    v = mk()"];
        assert_eq!(face_is(&lit, 2, "v"), None);
    }

    #[test]
    fn cov_module_plain_alias_and_alias_chain() {
        // Module bare-name alias (2053-2056, not Local, ends at 2062) and alias of an alias (2059-2060)
        let one = ["one = 5", "two = one", "three = 2"];
        assert_eq!(face_is(&one, 2, "two"), None);
        let chain = ["one = 5", "two = one", "three = two"];
        assert_eq!(face_is(&chain, 2, "three"), None);
    }

    #[test]
    fn cov_module_level_callee_alias_call() {
        // Module-level call through an alias: Bound consumption arm (2166-2167)
        let lines = [
            "def make() -> Repo:",
            "    return None",
            "alias = make",
            "v = alias()",
        ];
        assert_eq!(face_is(&lines, 3, "v").as_deref(), Some("Repo"));
    }

    #[test]
    fn cov_global_and_nonlocal_domain_penetration() {
        // global declaration in an fn domain penetrates the domain binding (1965); nonlocal is the same face
        let lines = [
            "g = 5",
            "def m():",
            "    global g",
            "    g = 6",
            "    x = g",
        ];
        assert_eq!(face_is(&lines, 4, "g"), None);
        let nl = [
            "def outer():",
            "    v = 1",
            "    def inner():",
            "        nonlocal v",
            "        v = 2",
            "        x = v",
            "    return outer",
        ];
        assert_eq!(face_is(&nl, 5, "v"), None);
    }

    #[test]
    fn cov_tuple_unpack_paired_entries() {
        // Equal-length tuple unpack pairs enter the table (1700-1702 return)
        let lines = ["def m():", "    x, y = 1, 's'", "    return x"];
        assert_eq!(face_is(&lines, 2, "x"), None);
        assert_eq!(face_is(&lines, 2, "y"), None);
    }

    #[test]
    fn cov_callee_nested_def_chain_sort_and_outer_binding() {
        // Call inside a nested def: domain-chain two-domain sort (1957-1960) + outer-domain binding resolution
        let lines = [
            "def make() -> Repo:",
            "    return None",
            "def outer():",
            "    mk = make",
            "    def inner():",
            "        v = mk()",
            "    return inner",
        ];
        assert_eq!(face_is(&lines, 5, "v").as_deref(), Some("Repo"));
    }

    #[test]
    fn cov_callee_global_declared_domain_penetration() {
        // Callee name with an in-domain global declaration: penetrates the domain binding (1965) -> module declaration table
        let lines = [
            "def make() -> Repo:",
            "    return None",
            "g = make",
            "def m():",
            "    global g",
            "    v = g()",
        ];
        // The global-declared name penetrates the domain binding -> module declaration table -> annotation face (verified by test)
        assert_eq!(face_is(&lines, 5, "v").as_deref(), Some("Repo"));
    }

    // ---- COV-044: face-scan remaining arms hit directly --------------------

    #[test]
    fn alias_chain_beyond_hop_cap_returns_none() {
        // Chain longer than FACE_MAX_HOPS (=4): a0 -> a1 -> ... -> a5, six names; querying a5 needs 5 hops,
        // and the 5th hop enters face_scan with depth=5 > 4 -> honest empty.
        // Lines 0..7: def/return/a0..a5; query position = the target alias's own write line (write already in effect)
        let lines = [
            "def src() -> Src:",
            "    return None",
            "a0 = src()",
            "a1 = a0",
            "a2 = a1",
            "a3 = a2",
            "a4 = a3",
            "a5 = a4",
        ];
        assert_eq!(face_is(&lines, 7, "a5"), None, "超跳链应诚实空");
        // Querying a3 on the same chain: the call face is reachable within 4 hops and the
        // annotation still hits (negative control, proving the cap arm does not swallow the
        // whole chain)
        assert_eq!(face_is(&lines, 5, "a3").as_deref(), Some("Src"));
    }

    #[test]
    fn identity_alias_revisit_returns_none() {
        // `x = x` identity chain: after the first resolution of x's write point, the alias face
        // rescans x and hits the same write point -> intercepted by visited -> honest empty
        // (the write-point RHS read position still sees its own LHS position).
        // Honest empty for the loop family: the self-referencing RHS read position of `x = x`
        // cannot see its own write; for the tuple swap `x, y = y, x`, after recording the
        // position element by element, the y hop's read position is still inside the same
        // statement and the pre-swap value is not visible -> Unbound. A loop has no solution
        // under alias semantics, so neither form may yield a face.
        let lines = ["x, y = y, x", "z = 1"];
        assert_eq!(face_is(&lines, 1, "x"), None, "交换环应诚实空");
        assert_eq!(face_is(&lines, 1, "y"), None, "交换环双向同语义");
    }

    #[test]
    fn alias_bound_to_class_is_instantiation_not_face() {
        // Call position bound to a class name: after `ctor = Widget`, `w = ctor()` is instantiation
        // semantics, not a return annotation face -> honest empty (class-name atom consumption arm;
        // contrast with the def-atom pass-through arm of cov_module_level_callee_alias_call).
        let lines = ["class Widget:", "    pass", "ctor = Widget", "w = ctor()"];
        assert_eq!(face_is(&lines, 3, "w"), None, "实例化语义不应出注解面");
    }
}
