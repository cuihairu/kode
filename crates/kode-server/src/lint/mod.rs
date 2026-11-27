//! def analysis lint rule registry (uv/ruff style): consolidates .def analysis
//! rules into Rust.
//!
//! Command face `$/kode/lint/analyzeDef` (dispatched as a single arm via
//! `$/kode/rpc`): input `{text, inheritedNames?, knownTypes?}`, output
//! `{findings:[...]}`. Each finding has the same shape as the TS
//! `analyzeDefDocument` output (`check`/`severity`/`line`/`offset`/`length`/
//! `name?`/`message`); the TS side consumes it directly on `ok:true` and falls
//! back to the TS fallback on `ok:false`. `offset`/`length` are UTF-16 code
//! unit offsets (same coordinate system as vscode positionAt); `line` is 1-based.
//!
//! Rules come in two classes:
//! - Analysis advice (analyzeDefDocument face): phantom types / missing Type /
//!   duplicate Type / large-field broadcast to all clients / DetailLevel
//!   redundancy / Python keywords / method-property name clashes /
//!   engine-restricted names / inherited-chain name clashes;
//! - Structural validation (diagnostics.rs corpus-subset face): unknown Type
//!   references / unknown Flags values / unknown DetailLevel / duplicate
//!   definitions (flag-scope pairs of Warning+Info) / properties missing Flags.
//!
//! Rule registration order is stable (registry is a Vec); output is grouped by
//! rule order and does not depend on HashMap order.

pub mod create_params_calls;
pub mod rules;

pub use create_params_calls::{analyze_create_params_calls, EntityFieldSet};

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::Value;

use kode_parser::diag::{LineMap, Span};
use kode_parser::xml::Document;

use crate::rpc::RpcRegistry;

// ---------------------------------------------------------------------------
// Finding (same shape as TS DefAnalysisFinding)
// ---------------------------------------------------------------------------

/// Location range of one lint finding (UTF-16 code units, same coordinate
/// system as offset/length).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct RangeFace {
    pub offset: usize,
    pub length: usize,
}

/// Bidirectional location face (used by the def↔Python consistency rules):
/// target Python file + class name. The consumer (TS) builds
/// vscode.Diagnostic.relatedInformation and CodeAction targets from it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedFace {
    /// Target Python file path (platform path).
    pub file: String,
    /// Target Python class name (entity class of the same name).
    pub class_name: String,
}

/// One lint finding (same shape as the TS `analyzeDefDocument` output; `code`
/// aliases `check`, and `range` is a self-describing location face — both are
/// redundant with `check`/`offset`/`length`, offered for consumers to use as
/// needed and harmless for direct TS consumption).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Finding {
    pub check: &'static str,
    pub code: &'static str,
    pub severity: &'static str,
    /// 1-based line number (for report display).
    pub line: usize,
    /// 0-based UTF-16 code unit offset (for diagnostic location).
    pub offset: usize,
    pub length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub message: String,
    pub range: RangeFace,
    /// Bidirectional location face (def↔Python consistency rules): target
    /// Python file + class name. Other rules leave it unset (omitted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related: Option<RelatedFace>,
}

// ---------------------------------------------------------------------------
// Inherited-chain name-clash input face (JSON form of TS collectInheritedNames)
// ---------------------------------------------------------------------------

/// Declaration aggregate for one name on the ancestor-closure face (union
/// across ancestors).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct InheritedNameInfo {
    pub property_domains: Vec<String>,
    pub component_domains: Vec<String>,
    pub method_sections: Vec<String>,
    pub property_sources: Vec<String>,
    pub component_sources: Vec<String>,
    pub method_sources: Vec<String>,
}

/// Name → ancestor declaration aggregate (optional input to analyzeDefDocument).
pub type InheritedNames = BTreeMap<String, InheritedNameInfo>;

// ---------------------------------------------------------------------------
// def↔Python consistency input face (task C-19: def-method-missing-in-python rule)
// ---------------------------------------------------------------------------

/// Python-side context for a single method section (base/cell/client): the
/// section's owner file + the set of methods implemented inside the class
/// (the minuend of the set difference). Empty `python_file` = cannot verify,
/// the section produces no finding (zero-false-positive discipline).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PythonParitySection {
    /// Owner Python file path of this section (for target location).
    pub python_file: String,
    /// Set of method names implemented inside this section's Python class.
    pub implemented_methods: Vec<String>,
}

/// Input for the def↔Python consistency check (`pythonParity` optional input,
/// passed through by TS). All three sections default to being omittable
/// (omitted sections are not verified); empty `python_class` = the caller
/// provided no context, the rule produces nothing.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PythonParityInput {
    /// Target Python entity class name (for messages and location).
    pub python_class: String,
    pub base: Option<PythonParitySection>,
    pub cell: Option<PythonParitySection>,
    pub client: Option<PythonParitySection>,
}

// ---------------------------------------------------------------------------
// Rule context and trait
// ---------------------------------------------------------------------------

/// Read-only context for rule execution: parsed document view + raw text +
/// line map + inherited face + known types.
#[derive(Debug)]
pub struct RuleContext<'a> {
    pub text: &'a str,
    pub doc: &'a Document,
    pub line_map: &'a LineMap,
    pub inherited: &'a InheritedNames,
    /// Union of known types (builtins ∪ caller-provided corpus).
    pub known_types: &'a BTreeSet<String>,
    /// def↔Python consistency input (C-19); defaults to empty → parity rules
    /// produce nothing.
    pub python: PythonParityInput,
}

/// One lint rule: stable id + produces findings against the context (each rule
/// keeps its own ordering).
pub trait Rule {
    fn id(&self) -> &'static str;
    fn check(&self, ctx: &RuleContext) -> Vec<Finding>;
}

/// Rule registry: order-stable (Vec), executed in registration order.
pub struct RuleRegistry {
    rules: Vec<Box<dyn Rule>>,
}

impl std::fmt::Debug for RuleRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.rules.iter().map(|r| r.id()))
            .finish()
    }
}

impl RuleRegistry {
    pub fn new() -> Self {
        RuleRegistry { rules: Vec::new() }
    }

    /// Append one rule; registering the same id twice is a programming error —
    /// panic to prevent silent override.
    pub fn push(&mut self, rule: Box<dyn Rule>) {
        assert!(
            !self.rules.iter().any(|r| r.id() == rule.id()),
            "lint rule {} registered twice",
            rule.id()
        );
        self.rules.push(rule);
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Run all rules in registration order, aggregating findings.
    pub fn run(&self, ctx: &RuleContext) -> Vec<Finding> {
        let mut out = Vec::new();
        for rule in &self.rules {
            out.extend(rule.check(ctx));
        }
        out
    }
}

impl Default for RuleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Full rule registry (def analysis advice + structural validation;
/// registration order = stable output order).
pub fn all_rules() -> RuleRegistry {
    let mut reg = RuleRegistry::new();
    rules::register_all(&mut reg);
    reg
}

// ---------------------------------------------------------------------------
// Command face
// ---------------------------------------------------------------------------

/// Register `$/kode/lint/analyzeDef` into the generic RPC face (called from
/// ServerState::new()).
pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeDef", handle_analyze_def);
}

/// `$/kode/lint/analyzeDef` handler: input `{text, inheritedNames?,
/// knownTypes?}`, output `{findings:[...]}`. Err = missing input / internal
/// error (TS fallback path).
fn handle_analyze_def(params: Value) -> Result<Value, String> {
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing text param".to_string())?
        .to_string();
    let inherited: InheritedNames = params
        .get("inheritedNames")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let known_types: Vec<String> = params
        .get("knownTypes")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let known_refs: Vec<&str> = known_types.iter().map(|s| s.as_str()).collect();
    let python: PythonParityInput = params
        .get("pythonParity")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let findings = analyze_def_with_python(&text, &inherited, &known_refs, python)?;
    Ok(serde_json::json!({ "findings": findings }))
}

/// Run the full lint rule set over one .def text (same discipline as the RPC
/// handler, for direct unit-test use; Python consistency input defaults to
/// empty → parity rules produce nothing, existing callers unchanged).
pub fn analyze_def(
    text: &str,
    inherited: &InheritedNames,
    known_types: &[&str],
) -> Result<Vec<Finding>, String> {
    analyze_def_with_python(text, inherited, known_types, PythonParityInput::default())
}

/// Run the full lint rule set over one .def text, with def↔Python consistency
/// input (C-19).
pub fn analyze_def_with_python(
    text: &str,
    inherited: &InheritedNames,
    known_types: &[&str],
    python: PythonParityInput,
) -> Result<Vec<Finding>, String> {
    let doc = kode_parser::xml::parse(text, true);
    if doc.root().is_none() {
        // Rootless document: TS analyzeDefDocument early-returns an empty face,
        // same discipline.
        return Ok(Vec::new());
    }
    let line_map = LineMap::new(text);
    let mut known: BTreeSet<String> = BTreeSet::new();
    for name in crate::definition::BUILTIN_TYPES {
        known.insert(name.to_string());
    }
    for name in known_types {
        known.insert(name.to_string());
    }
    let ctx = RuleContext {
        text,
        doc: &doc,
        line_map: &line_map,
        inherited,
        known_types: &known,
        python,
    };
    Ok(all_rules().run(&ctx))
}

// ---------------------------------------------------------------------------
// Finding construction helpers (shared by rules)
// ---------------------------------------------------------------------------

/// Byte span → UTF-16 code unit offset (same coordinate system as vscode
/// positionAt; spans are on char boundaries, guaranteed by the parser).
pub(crate) fn byte_offset_to_utf16(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    let mut count = 0usize;
    let mut cur = 0usize;
    for ch in text.chars() {
        if cur >= offset {
            break;
        }
        count += ch.len_utf16();
        cur += ch.len_utf8();
    }
    count
}

/// Build a finding from a byte span: converts UTF-16 offset/length and the
/// 1-based line number.
pub(crate) fn make_finding(
    check: &'static str,
    severity: &'static str,
    span: Span,
    name: Option<String>,
    message: String,
    ctx: &RuleContext,
) -> Finding {
    let start = span.start.min(ctx.text.len());
    let end = span.end.min(ctx.text.len());
    let offset = byte_offset_to_utf16(ctx.text, start);
    let offset_end = byte_offset_to_utf16(ctx.text, end);
    let length = offset_end.saturating_sub(offset);
    let line = ctx.line_map.line_of(start);
    Finding {
        check,
        code: check,
        severity,
        line,
        offset,
        length,
        name,
        message,
        range: RangeFace { offset, length },
        related: None,
    }
}
