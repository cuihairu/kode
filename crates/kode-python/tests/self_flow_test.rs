//! 流敏感 `self.<attr>` 扫描:两种 None 守卫块**内含查询位**的臂。
//!
//! 既有 inline 单测(guard_narrowing_* / not_none_guard_narrows_inside_block)
//! 的查询位都在守卫块**之外**,故 `scan_sequence` 的守卫递归臂里「块内到达
//! 查询位即停」(`inner.reached_stop` → 整块早退)此前从未被触达:命中即
//! `return`,调用方拿到的是块内态而非块后并集态。此臂漏测 = 守卫块内的
//! inlay/诊断位读到错误的类型集。
//!
//! not_none 臂注记:`not_none_guard` 词循环要求 `self` 后有空白再 `.`,
//! 正常 Python 形态 `self.x` 永假(COV-001 已登记 finding,修复归独立批
//! 拍板)——本文件以谓词今日唯一接受的合法形态 `self .x`(Python 语法
//! 合法)驱动该臂,锁**现状**语义作漂移探测器,非背书。

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
    // 查询位落在 `if self.x is None:` 块体内:守卫臂以「恰为 None」为入口态
    // 递归,块内命中查询行即停并整块早退——结果 = 块内态,非块后并集。
    let body = [
        "class Foo:",
        "    def __init__(self):",
        "        self.x = None",
        "    def method(self):",
        "        if self.x is None:",
        "            self.x = [1]",
        "            y = self.x",
    ];
    // 行 6 = `y = self.x`,在 is None 守卫块体内(行 4 是守卫头)。
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
    // 空格形态 `self .x` 是谓词今日唯一接受的合法源;查询位在块体内 →
    // 入口态 = 去 None(窄化),块内赋值可见,块内命中查询行即停早退。
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
    // 块体以 return 早退:then 侧退出、else(x 可 None)继续 → 块后保持
    // 入口态(terminal 分支);块体非早退:块后 = 入口 ∪ 块内态(else 分支)。
    // 两形查询位都在块后,锁「块后并集」两臂 + 继续扫下一行。
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
