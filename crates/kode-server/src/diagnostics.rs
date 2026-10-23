//! 诊断查询面(Phase2 首片,书 §17 PR-011 诊断面 / LSP 系列)。
//!
//! 面 = TS `validateDocument`(.def,默认开关全开)在**语料视图下可复刻的
//! 确定性子集**,逐条同文案同区间同序(真对齐非改阈值):
//!   ①标量扫描(DFS 先序):未知 `<Type>` 引用(内建 ∪ 语料 entities ∪
//!     语料 types/aliases 之外 → Error)、未知 `<Flags>` 值(Error)、
//!     未知 `<DetailLevel>`(Error);
//!   ②结构扫描(按段):重复定义(Properties 按旗标作用域,Warning+Info
//!     成对)、属性缺 `<Type>`/`<Flags>`(Error)。
//! 消息文案、严重级、区间(节点 span / 取值子区间)与 TS 逐字节同源。
//!
//! 划归边界(docs/kode2/phase2-slice-a.md §面定义):
//! - `missingPythonFile` 分支(implementedBy 的 user_type Python 文件存在性
//!   需磁盘面)Rust 语料视图不判定,该 Warning 不在本面;
//! - kp-* 语法诊断(kode-parser 内部能力)不在对拍面(TS validateDocument
//!   不产出语法维);workspace 发现口径(单根 types.xml/entities.xml 发现)
//!   在本面收敛为**已入库语料并集**,TS 复算按同语料同口径复算。
//! - entities.xml 的 validateEntitiesXmlDocument 面不在本片(独立单)。

use serde::Serialize;

use kode_parser::dep::FileKind;
use kode_parser::xml::{self, Document};

use crate::definition::{byte_offset_to_position, LspRange};
use crate::hover::HoverEngine;

/// LSP 严重级(Error=1/Warning=2/Information=3;TS DiagnosticSeverity 同值)。
pub const SEVERITY_ERROR: u32 = 1;
pub const SEVERITY_WARNING: u32 = 2;
pub const SEVERITY_INFORMATION: u32 = 3;

/// 一条诊断(vscode.Diagnostic 可比面:区间 + 级别 + 文案;无 code/source 键,
/// 与 TS 构造同形)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnosticFace {
    pub range: LspRange,
    pub severity: u32,
    pub message: String,
}

// ---------------------------------------------------------------------------
// 词表(与 TS kbengineMetadata 同表;新增词条双侧同步)
// ---------------------------------------------------------------------------

/// KBENGINE_FLAGS 12 词(含 CELL* 别名拼写)。
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

/// loadDetailLevelInfo 三档。
const DETAIL_LEVELS: &[&str] = &["NEAR", "MEDIUM", "FAR"];

/// 旗标 → 数据作用域集(TS ENTITY_*_DATA_FLAGS 同表;归一化别名后判定,
/// 顺序 base/cell/client,未命中剔除)。
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

/// `<Flags>` 值归一化(TS normalizePropertyFlag 同口径:trim + 大写 + 别名折算)。
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

/// 顶层段白名单(TS toSectionName ∩ ALLOWED_TOP_LEVEL_SECTIONS,精确大小写)。
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
// 取值区间(TS pushDiagnosticForNodeValue / createNodeRange 同规则)
// ---------------------------------------------------------------------------

/// 节点整体区间(tagStart..closeTagEnd;自闭合 closeTagEnd=开标签终点)。
fn node_range(text: &str, data: &xml::ElementData) -> LspRange {
    LspRange {
        start: byte_offset_to_position(text, data.open_span.start),
        end: byte_offset_to_position(text, data.close_span.end),
    }
}

/// 取值子区间:值在 content 内的首个出现;越界/缺失回落 content 区间。
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

/// 直接文本拼接 trim(TS getNodeValue 同语义)。
fn node_value(doc: &Document, idx: usize) -> String {
    doc.element(idx).text(doc).trim().to_string()
}

/// 词法扫描 [A-Za-z_][A-Za-z0-9_]*(TS typeCandidateRegex 同序)。
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
// 语料类型环境(已入库并集口径,见文件头)
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
// 主面:.def 诊断(TS validateDocument 同序同文案)
// ---------------------------------------------------------------------------

impl HoverEngine {
    /// .def 文档诊断面。文档类型非 .def 返回空(本面只覆盖 validateDocument)。
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

    /// 按文档类型分派(非 .def 现为空面;.entities/.types/.alias 专项诊断
    /// 属后续单)。
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

/// ①标量扫描:visitElementNodes DFS 先序,Type/Flags/DetailLevel 三分支互斥。
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
            let normalized = raw.to_uppercase();
            if !normalized.is_empty() && !KNOWN_FLAGS.contains(&normalized.as_str()) {
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

/// 未知 Type 引用:候选词逐个判内建/实体/自定义,未注册 → Error(候选词
/// 子区间;TS pushDiagnosticForNodeValue 同规则)。missingPythonFile 分支
/// 不在本面(见文件头划归)。
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

/// ②结构扫描:按段白名单逐段,段内声明节点先重复判定再属性结构判定。
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
                // 重复定义(按旗标作用域;首见 wins,Warning+Info 成对)。
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
            } else if !seen_symbols.contains_key(&symbol_data.name) {
                seen_symbols.insert(symbol_data.name.clone(), symbol_range.clone());
            } else {
                let existing = seen_symbols
                    .get(&symbol_data.name)
                    .expect("checked")
                    .clone();
                out.push(DiagnosticFace {
                    range: symbol_range.clone(),
                    severity: SEVERITY_WARNING,
                    message: format!("{label}中存在重复定义: {}", symbol_data.name),
                });
                out.push(DiagnosticFace {
                    range: existing,
                    severity: SEVERITY_INFORMATION,
                    message: format!("{} 在 {label} 中已定义", symbol_data.name),
                });
            }
            if is_properties {
                // 属性结构:缺 <Type>/<Flags>(Error,节点整体区间)。
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

/// 属性旗标作用域(base/cell/client 序,仅保留命中的)。
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
// 对拍 golden(只写不读;TS 侧 tests/kodeDiagnosticsParity.test.ts 复算)
// ---------------------------------------------------------------------------

/// golden 文件名(仓库相对)。
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

/// 整个语料的 diagnostics golden JSON(.def 文件逐份诊断面)。
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
