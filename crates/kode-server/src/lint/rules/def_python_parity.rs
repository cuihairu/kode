//! def↔Python 方法一致性规则(任务 C-19 交付①)。
//!
//! 规则 id `def-method-missing-in-python`:def 中声明的方法在对应同名
//! Python 实体类中无实现 → warning 诊断。定位在 def 文件方法名行,finding
//! 携带 [`RelatedFace`](super::RelatedFace)(目标 Python 文件 + 类名,双向
//! 定位)。
//!
//! 输入面 [`PythonParityInput`](super::PythonParityInput)(经
//! `$/kode/lint/analyzeDef` 的 `pythonParity` 可选入参,TS 侧已解析好
//! Python 符号表后直传):按段(base/cell/client)给出该段属主 Python 文件与
//! 该类已实现方法集合。规则对三段做集合差:
//! - 该段上下文缺失(None)→ 该段不产 finding(无法核验,零误报);
//! - 该段上下文在位 → 段内方法不在已实现集合 → 产 warning。
//!
//! 反向(Python 有 def 无)不在本规则(任务口径默认关闭可配,防误报),本
//! 规则只做正向(def 有 Python 无)。

use std::collections::BTreeSet;

use kode_parser::xml::Document;

use crate::lint::{make_finding, Finding, Rule};
use crate::lint::{PythonParityInput, PythonParitySection};
use crate::lint::{RelatedFace, RuleContext};

/// 三方法段内 (方法元素下标, 段名) 列表(段序 Base → Cell → Client)。
/// 与 `rules::all_methods_with_section` 同口径;本规则独立持有,避免改动
/// `rules.rs` 的共享面(wt/topology 并行在改 rules.rs)。
fn methods_with_section(doc: &Document) -> Vec<(usize, &'static str)> {
    const SECTIONS: &[(&str, &str)] = &[
        ("BaseMethods", "base"),
        ("CellMethods", "cell"),
        ("ClientMethods", "client"),
    ];
    let Some(root) = doc.root() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for &(tag, section) in SECTIONS {
        if let Some(sec) = doc.child_element(root, tag) {
            for m in doc.child_elements(sec) {
                out.push((m, section));
            }
        }
    }
    out
}

/// 段名 → 该段 Python 上下文(缺失 = 该段无法核验,不产 finding)。
fn section_input<'a>(py: &'a PythonParityInput, section: &str) -> Option<&'a PythonParitySection> {
    match section {
        "base" => py.base.as_ref(),
        "cell" => py.cell.as_ref(),
        "client" => py.client.as_ref(),
        _ => None,
    }
}

/// def↔Python 方法一致性规则(正向:def 有 Python 无)。
#[derive(Debug)]
pub struct DefMethodMissingInPythonRule;

impl Rule for DefMethodMissingInPythonRule {
    fn id(&self) -> &'static str {
        "def-method-missing-in-python"
    }

    fn check(&self, ctx: &RuleContext) -> Vec<Finding> {
        let py = &ctx.python;
        // 调用方未提供任何段上下文 → 无法核验,零产出(兼容既有调用方)。
        if py.python_class.is_empty()
            || (py.base.is_none() && py.cell.is_none() && py.client.is_none())
        {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (method, section) in methods_with_section(ctx.doc) {
            let data = ctx.doc.element(method);
            let Some(sec_input) = section_input(py, section) else {
                continue;
            };
            let implemented: BTreeSet<&str> = sec_input
                .implemented_methods
                .iter()
                .map(String::as_str)
                .collect();
            if implemented.contains(data.name.as_str()) {
                continue;
            }
            let mut finding = make_finding(
                "def-method-missing-in-python",
                "warning",
                data.name_span,
                Some(data.name.clone()),
                format!(
                    "方法 {} 在 Python 类 {} 中未实现(def 有 Python 无);目标文件 {}",
                    data.name, py.python_class, sec_input.python_file
                ),
                ctx,
            );
            finding.related = Some(RelatedFace {
                file: sec_input.python_file.clone(),
                class_name: py.python_class.clone(),
            });
            out.push(finding);
        }
        out
    }
}
