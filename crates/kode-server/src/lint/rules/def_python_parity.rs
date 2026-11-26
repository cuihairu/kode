//! def<->Python method parity rule (task C-19 deliverable 1).
//!
//! Rule id `def-method-missing-in-python`: a method declared in the def has no implementation in the corresponding
//! same-named Python entity class -> warning diagnostic. Anchored at the method-name line in the def file; the finding
//! carries [`RelatedFace`](super::RelatedFace) (target Python file + class name, bidirectional
//! location).
//!
//! Input face [`PythonParityInput`](super::PythonParityInput) (via
//! the `pythonParity` optional input of `$/kode/lint/analyzeDef`; the TS side has already parsed the
//! Python symbol table and passes it straight through): per section (base/cell/client) it gives the section owner's Python file and
//! that class's set of implemented methods. The rule takes the set difference over the three sections:
//! - Section context missing (None) -> that section produces no finding (unverifiable, zero false positives);
//! - Section context present -> a section method absent from the implemented set -> warning.
//!
//! The reverse direction (Python has it, def does not) is not in this rule (task scope: off by default, configurable, to avoid false positives);
//! this rule only does the forward direction (def has it, Python does not).

use std::collections::BTreeSet;

use kode_parser::xml::Document;

use crate::lint::{make_finding, Finding, Rule};
use crate::lint::{PythonParityInput, PythonParitySection};
use crate::lint::{RelatedFace, RuleContext};

/// List of (method element index, section name) within the three method sections (section order Base -> Cell -> Client).
/// Same stance as `rules::all_methods_with_section`; this rule holds its own copy to avoid touching
/// the shared surface of `rules.rs` (wt/topology sessions are editing rules.rs in parallel).
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

/// Section name -> that section's Python context (missing = that section is unverifiable, no finding).
fn section_input<'a>(py: &'a PythonParityInput, section: &str) -> Option<&'a PythonParitySection> {
    match section {
        "base" => py.base.as_ref(),
        "cell" => py.cell.as_ref(),
        "client" => py.client.as_ref(),
        _ => None,
    }
}

/// def<->Python method parity rule (forward: def has it, Python does not).
#[derive(Debug)]
pub struct DefMethodMissingInPythonRule;

impl Rule for DefMethodMissingInPythonRule {
    fn id(&self) -> &'static str {
        "def-method-missing-in-python"
    }

    fn check(&self, ctx: &RuleContext) -> Vec<Finding> {
        let py = &ctx.python;
        // Caller provided no section context at all -> unverifiable, zero output (compatible with existing callers).
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
