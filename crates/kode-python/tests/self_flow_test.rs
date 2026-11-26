//! Flow-sensitive `self.<attr>` scan: the two arms whose None guard block
//! **contains the query position**.
//!
//! The existing inline unit tests (guard_narrowing_* / not_none_guard_narrows_inside_block)
//! put their query position **outside** the guard block, so the "stop as soon as the
//! query position is reached inside the block" (`inner.reached_stop` -> early-exit the
//! whole block) path of the guard recursion arm in `scan_sequence` was never exercised:
//! a hit means `return`, so callers receive the in-block state rather than the
//! post-block union state. This arm untested = inlay/diagnostic positions inside a
//! guard block read a wrong type set.
//!
//! Note on the not_none arm: the `not_none_guard` word loop requires whitespace after
//! `self` before the `.`, so the normal Python shape `self.x` never matches (COV-001 has
//! a registered finding; the fix is left to a separate batch's ruling) -- this file drives
//! that arm using `self .x` (valid Python syntax), the only form the predicate accepts
//! today, pinning the **current** semantics as a drift detector, not an endorsement.

use kode_python::self_flow::{infer_self_attribute_flow, SelfAttributeFlow};

fn lines_of(body: &[&str]) -> Vec<Vec<u16>> {
    body.iter().map(|l| l.encode_utf16().collect()).collect()
}

fn flow(body: &[&str], query_line: usize, attr: &str) -> SelfAttributeFlow {
    infer_self_attribute_flow(
        &lines_of(body),
        query_line,
        &attr.encode_utf16().collect::<Vec<u16>>(),
        None,
    )
    .expect("infer not cancelled")
    .expect("flow exists")
}

#[test]
fn none_guard_block_hosting_query_line_stops_inside() {
    // The query position falls inside the `if self.x is None:` block body: the guard arm
    // recurses with "exactly None" as entry state, stops on hitting the query line inside the
    // block and early-exits the whole block -- result = in-block state, not the post-block union.
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.x = None",
        "    def method(self):",
        "        if self.x is None:",
        "            self.x = [1]",
        "            y = self.x",
    ];
    // Line 6 = `y = self.x`, inside the is None guard block body (line 4 is the guard head).
    let f = flow(&body, 6, "x");
    assert_eq!(
        f.types,
        vec!["list"],
        "块内赋值后查询位 = list: {:?}",
        f.types
    );
    assert!(!f.has_none);
    assert_eq!(f.annotation.as_deref(), Some("list"));
}

#[test]
fn not_none_guard_arm_query_inside_block_stops_with_narrowed_entry() {
    // The spaced form `self .x` is the only legal source the predicate accepts today; the query
    // position is inside the block body -> entry state = None removed (narrowed), the in-block
    // assignment is visible, and hitting the query line inside the block stops with early exit.
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.x = None",
        "    def method(self):",
        "        if self .x is not None:",
        "            self.x = [1]",
        "            y = self.x",
    ];
    let f = flow(&body, 6, "x");
    assert_eq!(
        f.types,
        vec!["list"],
        "块内赋值 [1] 的类型集: {:?}",
        f.types
    );
    assert!(
        !f.has_none,
        "守卫块内查询位不得含 None(入口已窄化): {:?}",
        f.types
    );
    assert!(f.narrowed, "基线含 None 而查询位不含 = 窄化生效");
    assert_eq!(f.annotation.as_deref(), Some("list"));
}

#[test]
fn not_none_guard_arm_terminal_and_union_after_block() {
    // The block body early-exits with return: the then side exits, else (x may be None) continues
    // -> after the block the entry state is retained (terminal branch); the block body does not
    // early-exit: after the block = entry ∪ in-block state (else branch).
    // Both forms query after the block, pinning both arms of "post-block union" + continuing to scan the next line.
    let terminal = [
        "class Foo:",
        "    def __init__(self):",
        "        self.x = None",
        "    def m(self):",
        "        if self .x is not None:",
        "            self.x = 1",
        "            return",
        "        y = self.x",
    ];
    let f = flow(&terminal, 7, "x");
    assert_eq!(
        f.types,
        vec!["None"],
        "then 早退:块后保持入口态(可 None): {:?}",
        f.types
    );
    assert!(f.has_none);

    let fallthrough = [
        "class Foo:",
        "    def __init__(self):",
        "        self.x = None",
        "    def m(self):",
        "        if self .x is not None:",
        "            self.x = 1",
        "        y = self.x",
    ];
    let f = flow(&fallthrough, 6, "x");
    assert_eq!(
        f.types,
        vec!["None", "int"],
        "块体落回:块后 = 入口 {{None}} ∪ 块内 {{int}}: {:?}",
        f.types
    );
    assert!(f.has_none);
}
