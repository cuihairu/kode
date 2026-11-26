//! Diagnostic query face (Phase2 first slice, book section 17 PR-011 diagnostic face / LSP series).
//!
//! The face = the deterministic subset of TS `validateDocument` (.def, all default switches on) replicable under the
//! corpus view, matching text, ranges, and order item-for-item (true alignment, not threshold tweaks):
//!   1. Scalar scan (DFS pre-order): unknown `<Type>` references (outside builtin union corpus entities
//!      union corpus types/aliases -> Error), unknown `<Flags>` values (Error),
//!      unknown `<DetailLevel>` (Error);
//!   2. Structural scan (per section): duplicate definitions (Properties per flag scope, Warning+Info
//!      paired); properties missing `<Type>`/`<Flags>` (Error).
//!
//! Message text, severities, and ranges (node span / value sub-range) are byte-for-byte sourced from TS.
//!
//! Attribution boundary (docs/kode2/phase2-slice-a.md, face definition):
//! - The `missingPythonFile` branch (existence of the user_type Python file behind implementedBy
//!   needs a disk face) is not judged by the Rust corpus view; that Warning is not on this face;
//! - kp-* syntax diagnostics (a kode-parser internal capability) are not on the comparison face (TS validateDocument
//!   produces no syntax dimension); the workspace discovery stance (single-root types.xml/entities.xml discovery)
//!   converges here to the **filed-corpus union**; TS recomputes on the same corpus and stance.
//! - The validateEntitiesXmlDocument face of entities.xml is not in this slice (a separate ticket).

use serde::Serialize;

use kode_parser::dep::FileKind;
use kode_parser::xml::{self, Document};

use crate::definition::{byte_offset_to_position, LspRange};
use crate::hover::HoverEngine;

/// LSP severity (Error=1/Warning=2/Information=3; TS DiagnosticSeverity has the same values).
pub const SEVERITY_ERROR: u32 = 1;
pub const SEVERITY_WARNING: u32 = 2;
pub const SEVERITY_INFORMATION: u32 = 3;

/// One diagnostic (a comparable face for vscode.Diagnostic: range + level + message; no code/source keys,
/// same shape as the TS construction).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnosticFace {
    pub range: LspRange,
    pub severity: u32,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Vocabularies (the same table as TS kbengineMetadata; new entries synced on both sides)
// ---------------------------------------------------------------------------

/// KBENGINE_FLAGS, 12 words (including CELL* alias spellings).
const KNOWN_FLAGS: &[&str] = &[
    "CELL_PUBLIC",
    "CELL_PRIVATE",
    "ALL_CLIENTS",
    "CELL_PUBLIC_AND_OWN",
    "OWN_CLIENT",
    "BASE_AND_CLIENT",
    "BASE",
    "OTHER_CLIENTS",
    "CELL",
    "CELL_AND_CLIENT",
    "CELL_AND_CLIENTS",
    "CELL_AND_OTHER_CLIENTS",
];

/// The three loadDetailLevelInfo tiers.
const DETAIL_LEVELS: &[&str] = &["NEAR", "MEDIUM", "FAR"];

/// Flag -> data-scope set (same table as TS ENTITY_*_DATA_FLAGS; judged after alias normalization,
/// order base/cell/client; misses are dropped).
fn flag_scopes(normalized: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    if matches!(normalized, "BASE" | "BASE_AND_CLIENT") {
        out.push("base");
    }
    if matches!(
        normalized,
        "CELL_PUBLIC"
            | "CELL_PRIVATE"
            | "ALL_CLIENTS"
            | "CELL_PUBLIC_AND_OWN"
            | "OWN_CLIENT"
            | "OTHER_CLIENTS"
    ) {
        out.push("cell");
    }
    if matches!(
        normalized,
        "BASE_AND_CLIENT" | "ALL_CLIENTS" | "CELL_PUBLIC_AND_OWN" | "OWN_CLIENT" | "OTHER_CLIENTS"
    ) {
        out.push("client");
    }
    out
}

const PROPERTY_SCOPE_LABELS: &[(&str, &str)] =
    &[("base", "Base"), ("cell", "Cell"), ("client", "Client")];

fn scope_label(scope: &str) -> &str {
    PROPERTY_SCOPE_LABELS
        .iter()
        .find(|(k, _)| *k == scope)
        .map(|(_, v)| *v)
        .unwrap_or(scope)
}

/// `<Flags>` value normalization (same stance as TS normalizePropertyFlag: trim + uppercase + alias folding).
fn normalize_property_flag(raw: Option<String>) -> Option<String> {
    let upper = raw?.trim().to_uppercase();
    if upper.is_empty() {
        return None;
    }
    Some(match upper.as_str() {
        "CELL_AND_CLIENT" => "CELL_PUBLIC_AND_OWN".to_string(),
        "CELL_AND_CLIENTS" => "ALL_CLIENTS".to_string(),
        "CELL_AND_OTHER_CLIENTS" => "OTHER_CLIENTS".to_string(),
        _ => upper,
    })
}

/// Top-level section whitelist (TS toSectionName intersect ALLOWED_TOP_LEVEL_SECTIONS, exact case).
fn section_label_of(name: &str) -> Option<&'static str> {
    match name {
        "Parent" => Some("父类区块"),
        "Interfaces" => Some("接口区块"),
        "Components" => Some("组件区块"),
        "Properties" => Some("属性区块"),
        "BaseMethods" | "CellMethods" | "ClientMethods" => Some("方法区块"),
        "Volatile" => Some("易变同步区块"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Value range (same rules as TS pushDiagnosticForNodeValue / createNodeRange)
// ---------------------------------------------------------------------------

/// The node's overall range (tagStart..closeTagEnd; for self-closing tags closeTagEnd = the end of the open tag).
fn node_range(text: &str, data: &xml::ElementData) -> LspRange {
    LspRange {
        start: byte_offset_to_position(text, data.open_span.start),
        end: byte_offset_to_position(text, data.close_span.end),
    }
}

/// The value's sub-range: the value's first occurrence within the content; out-of-range/missing falls back to the content range.
fn value_range(text: &str, data: &xml::ElementData, value: &str) -> LspRange {
    let content_start = data.content_span.start;
    let content_end = data.content_span.end;
    let found = text[content_start..]
        .find(value)
        .map(|rel| content_start + rel)
        .filter(|&offset| offset <= content_end);
    match found {
        Some(offset) => LspRange {
            start: byte_offset_to_position(text, offset),
            end: byte_offset_to_position(text, offset + value.len()),
        },
        None => LspRange {
            start: byte_offset_to_position(text, content_start),
            end: byte_offset_to_position(text, content_end),
        },
    }
}

/// Trimmed direct text concatenation (same semantics as TS getNodeValue).
fn node_value(doc: &Document, idx: usize) -> String {
    doc.element(idx).text(doc).trim().to_string()
}

/// Lexical scan [A-Za-z_][A-Za-z0-9_]* (same order as TS typeCandidateRegex).
fn word_tokens(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
        } else {
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Corpus type environment (filed-union stance, see the file header)
// ---------------------------------------------------------------------------

pub(crate) struct TypeContext {
    pub entity_types: std::collections::BTreeSet<String>,
    pub custom_types: std::collections::BTreeSet<String>,
}

impl HoverEngine {
    pub(crate) fn type_context(&self) -> TypeContext {
        let mut entity_types = std::collections::BTreeSet::new();
        for entities in self.entities_files().values() {
            for entry in &entities.entities {
                entity_types.insert(entry.name.clone());
            }
        }
        let mut custom_types = std::collections::BTreeSet::new();
        for types in self.types_files.values() {
            for decl in &types.types {
                custom_types.insert(decl.name.clone());
            }
        }
        for aliases in self.alias_files.values() {
            for alias in &aliases.aliases {
                custom_types.insert(alias.name.clone());
            }
        }
        TypeContext {
            entity_types,
            custom_types,
        }
    }
}

// ---------------------------------------------------------------------------
// Main face: .def diagnostics (same order and text as TS validateDocument)
// ---------------------------------------------------------------------------

impl HoverEngine {
    /// The .def document diagnostic face. Non-.def document types return empty (this face covers only validateDocument).
    pub fn def_diagnostics(&self, text: &str) -> Vec<DiagnosticFace> {
        let mut out = Vec::new();
        let doc = xml::parse(text, true);
        let Some(root) = doc.root() else {
            return out;
        };
        let ctx = self.type_context();
        scalar_pass(text, &doc, root, &ctx, &mut out);
        structure_pass(text, &doc, root, &mut out);
        out
    }

    /// Dispatch by document type (non-.def is currently an empty face; .entities/.types/.alias dedicated diagnostics
    /// belong to later tickets).
    pub fn diagnostics(&self, key_uri_path: &str, text: &str) -> Vec<DiagnosticFace> {
        let kind = kode_parser::dep::file_kind_of_uri(&kode_vfs::uri::CanonicalUri::from_path(
            key_uri_path,
        ));
        match kind {
            FileKind::Def => self.def_diagnostics(text),
            _ => Vec::new(),
        }
    }
}

/// 1. Scalar scan: visitElementNodes DFS pre-order, Type/Flags/DetailLevel three mutually exclusive branches.
fn scalar_pass(
    text: &str,
    doc: &Document,
    node: usize,
    ctx: &TypeContext,
    out: &mut Vec<DiagnosticFace>,
) {
    let data = doc.element(node);
    match data.name.as_str() {
        "Type" => validate_type_node(text, doc, node, ctx, out),
        "Flags" => {
            let raw = node_value(doc, node);
            // KR-AUD-84: whole-string lookup; the '|' combined form gets a separate "engine does not support" diagnostic
            // (same text in all three places: here, lint/rules.rs UnknownFlagValueRule, and TS validateScalarTagValues
            // ).
            let normalized = raw.to_uppercase();
            if raw.contains('|') {
                out.push(DiagnosticFace {
                    range: value_range(text, data, &raw),
                    severity: SEVERITY_ERROR,
                    message: format!(
                        "未知的 KBEngine Flags 值: {raw}。引擎按单个映射值整串查表，不支持 '|' 组合形态；请改为单个词表值。"
                    ),
                });
            } else if !normalized.is_empty() && !KNOWN_FLAGS.contains(&normalized.as_str()) {
                out.push(DiagnosticFace {
                    range: value_range(text, data, &raw),
                    severity: SEVERITY_ERROR,
                    message: format!(
                        "未知的 KBEngine Flags 值: {raw}。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。"
                    ),
                });
            }
        }
        "DetailLevel" => {
            let value = node_value(doc, node);
            if !value.is_empty() && !DETAIL_LEVELS.contains(&value.as_str()) {
                out.push(DiagnosticFace {
                    range: value_range(text, data, &value),
                    severity: SEVERITY_ERROR,
                    message: format!("未知的 DetailLevel: {value}"),
                });
            }
        }
        _ => {}
    }
    for child in doc.child_elements(node) {
        scalar_pass(text, doc, child, ctx, out);
    }
}

/// Unknown Type references: each candidate word is judged builtin/entity/custom; unregistered -> Error (the candidate-word
/// sub-range; same rule as TS pushDiagnosticForNodeValue). The missingPythonFile branch
/// is not on this face (see the attribution boundary in the file header; on the serving track that disk-probe branch is kept by the TS side).
/// TS unverifiable tier, same stance: when the types.xml/alias.xml registries are empty (no registered
/// view) nothing can be adjudicated, so always stay silent (resolveCustomTypeReference's `!customTypes.size`
/// has the same semantics); never misreport an unregistered view as "unregistered".
fn validate_type_node(
    text: &str,
    doc: &Document,
    node: usize,
    ctx: &TypeContext,
    out: &mut Vec<DiagnosticFace>,
) {
    let data = doc.element(node);
    let value = node_value(doc, node);
    if value.is_empty() || !doc.child_elements(node).is_empty() {
        return;
    }
    if ctx.custom_types.is_empty() {
        return;
    }
    for candidate in word_tokens(&value) {
        if crate::definition::is_builtin_type(&candidate)
            || ctx.entity_types.contains(&candidate)
            || ctx.custom_types.contains(&candidate)
        {
            continue;
        }
        out.push(DiagnosticFace {
            range: value_range(text, data, &candidate),
            severity: SEVERITY_ERROR,
            message: format!(
                "自定义类型 {candidate} 未在 types.xml 中注册，请先在 types.xml 注册后再引用"
            ),
        });
    }
}

/// 2. Structural scan: per section whitelist; within a section, duplicate judgement first, then property-structure judgement.
fn structure_pass(text: &str, doc: &Document, root: usize, out: &mut Vec<DiagnosticFace>) {
    for section in doc.child_elements(root) {
        let section_data = doc.element(section);
        let Some(label) = section_label_of(&section_data.name) else {
            continue;
        };
        let is_properties = section_data.name == "Properties";
        let mut seen_symbols: std::collections::BTreeMap<String, LspRange> =
            std::collections::BTreeMap::new();
        let mut seen_scopes: std::collections::BTreeMap<
            String,
            std::collections::BTreeMap<String, LspRange>,
        > = std::collections::BTreeMap::new();
        for symbol in doc.child_elements(section) {
            let symbol_data = doc.element(symbol);
            let symbol_range = node_range(text, symbol_data);
            if is_properties {
                // Duplicate definition (per flag scope; first-seen wins, Warning+Info paired).
                let scopes = flag_scopes_owned(doc, symbol);
                if !scopes.is_empty() {
                    let empty = std::collections::BTreeMap::new();
                    let known = seen_scopes.get(&symbol_data.name).unwrap_or(&empty);
                    let hits: Vec<String> = scopes
                        .iter()
                        .filter(|s| known.contains_key(*s))
                        .cloned()
                        .collect();
                    for scope in &hits {
                        out.push(DiagnosticFace {
                            range: symbol_range.clone(),
                            severity: SEVERITY_WARNING,
                            message: format!(
                                "{label}中存在重复定义: {} ({})",
                                symbol_data.name,
                                scope_label(scope)
                            ),
                        });
                        let existing = known.get(scope).expect("scope checked");
                        out.push(DiagnosticFace {
                            range: existing.clone(),
                            severity: SEVERITY_INFORMATION,
                            message: format!(
                                "{} 在 {label} 中已在 {} 作用域定义",
                                symbol_data.name,
                                scope_label(scope)
                            ),
                        });
                    }
                    let entry = seen_scopes.entry(symbol_data.name.clone()).or_default();
                    for scope in &scopes {
                        entry
                            .entry(scope.clone())
                            .or_insert_with(|| symbol_range.clone());
                    }
                }
            } else {
                // Interface-block entries are in text form (`<interface>Name</interface>`; the tag is only
                // one of the four spellings): identity takes the node value (the interface name), not the tag name -- the same tag with different interfaces
                // is a legal shape (an entity may carry multiple interfaces); judging duplicates by tag name would falsely report
                // the second interface as a duplicate (same source as TS validateSectionStructure).
                let identity = if section_data.name == "Interfaces" {
                    node_value(doc, symbol)
                } else {
                    symbol_data.name.clone()
                };
                if !seen_symbols.contains_key(&identity) {
                    seen_symbols.insert(identity.clone(), symbol_range.clone());
                } else {
                    let existing = seen_symbols.get(&identity).expect("checked").clone();
                    out.push(DiagnosticFace {
                        range: symbol_range.clone(),
                        severity: SEVERITY_WARNING,
                        message: format!("{label}中存在重复定义: {}", identity),
                    });
                    out.push(DiagnosticFace {
                        range: existing,
                        severity: SEVERITY_INFORMATION,
                        message: format!("{} 在 {label} 中已定义", identity),
                    });
                }
            }
            if is_properties {
                // Property structure: missing <Type>/<Flags> (Error, the node's overall range).
                if doc.child_element(symbol, "Type").is_none() {
                    out.push(DiagnosticFace {
                        range: symbol_range.clone(),
                        severity: SEVERITY_ERROR,
                        message: format!("属性 {} 缺少 <Type> 定义", symbol_data.name),
                    });
                }
                if doc.child_element(symbol, "Flags").is_none() {
                    out.push(DiagnosticFace {
                        range: symbol_range.clone(),
                        severity: SEVERITY_ERROR,
                        message: format!("属性 {} 缺少 <Flags> 定义", symbol_data.name),
                    });
                }
            }
        }
    }
}

/// Property flag scopes (base/cell/client order, keeping only the hits).
fn flag_scopes_owned(doc: &Document, symbol: usize) -> Vec<String> {
    normalize_property_flag(doc.scalar_child_value(symbol, "Flags"))
        .map(|normalized| {
            flag_scopes(&normalized)
                .into_iter()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Comparison golden (write-only, never read back; recomputed by the TS side's tests/kodeDiagnosticsParity.test.ts)
// ---------------------------------------------------------------------------

/// Golden file name (relative to the repo root).
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/diagnostics-parity.json";

#[derive(Debug, Serialize)]
struct GoldenFile {
    file: String,
    diagnostics: Vec<DiagnosticFace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    diagnostic_count: usize,
    files: Vec<GoldenFile>,
}

/// Diagnostics golden JSON for the whole corpus (per-.def-file diagnostic faces).
pub fn dump_diagnostics_golden(repo_root: &std::path::Path) -> String {
    use kode_parser::json::{collect_corpus, PARITY_CORPORA};

    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let mut engine = HoverEngine::new();
    for (path, (_kind, text)) in &files {
        let key = kode_vfs::DocumentKey::new(
            kode_vfs::store::RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        engine.update(key, text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-diagnostics-golden",
        file_count: 0,
        diagnostic_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        if *kind != "def" {
            continue;
        }
        let diagnostics = engine.def_diagnostics(text);
        dump.diagnostic_count += diagnostics.len();
        dump.file_count += 1;
        dump.files.push(GoldenFile {
            file: path.clone(),
            diagnostics,
        });
    }
    serde_json::to_string(&dump).expect("serialize diagnostics golden")
}
