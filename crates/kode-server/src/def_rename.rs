//! RUST-141 batch 1: def rename pure core — isomorphic sink of
//! src/backend/defRenamer.ts.
//!
//! Four pure faces (point-for-point isomorphic to the production TS face, zero
//! vscode/EntityMappingManager dependencies):
//! - `resolve_rename_symbol_at_offset`: the renamable symbol at the cursor
//!   (top-level Properties properties / methods of the three method sections;
//!   the cursor word must land inside the symbol element's open/close tag name
//!   range);
//! - `find_def_rename_conflict`: same-file target-name conflict (NAV-008
//!   narrow face: methods only check their own section, properties and
//!   components are mutually exclusive);
//! - `compute_def_rename_edits`: whole-workspace editable-range analysis —
//!   same-named symbols in the target file plus same-named restatements in
//!   descendant defs (including interface mixins), propagation edges aligned
//!   with the engine load path (entitydef.cpp: Parent/interface wrapper takes
//!   its first child node's name, interfaces do not read Parent, dangling
//!   references produce no edge);
//! - `find_def_rename_conflict_in_closure`: pre-check for name occupation on
//!   the same-member naming face across the ancestor/descendant closure
//!   (AUD-061, dedup matrix aligned with ScriptDefModule: component slots
//!   unconditionally / methods same-section / property domain-bit intersection).
//!
//! Coordinate system: all public offsets = **UTF-16 units** (same coordinate
//! system as TS strings). Parser (kode-parser::xml) spans are byte offsets,
//! converted via `Utf16Map`; identifiers/tag names are all ASCII, so word
//! matching has no cross-system ambiguity. When corpus contains CJK comments
//! the two systems' offsets differ, so golden stores UTF-16 offsets throughout
//! and the TS mirror (tests/kodeDefRenameParity.test.ts) imports the production
//! defRenamer functions directly to recompute the same golden for comparison.
//!
//! Batch 1 boundary (same discipline as references/document_symbols/
//! python-call-at): server.rs/rpc.rs concurrently in flight;
//! `textDocument/rename`/`prepareRename` LSP wiring and the python self-access
//! rewrite face (EntityMappingManager, NAV-011/012), the input-version drift
//! face (renameInputsDrifted) are left to batch 2; the production service face
//! is still TS.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use kode_parser::diag::Span;
use kode_parser::model::{flag_domains, normalize_flag_tokens};
use kode_parser::xml::{self, Document as XmlDoc, NodeData};

/// Legal shape of def property/method names (isomorphic to TS
/// DEF_IDENTIFIER_PATTERN; the entity-name leading-uppercase constraint does
/// not apply to members).
pub fn is_def_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Isomorphic to TS DEF_METHOD_SECTIONS.
pub const DEF_METHOD_SECTIONS: &[&str] = &["BaseMethods", "CellMethods", "ClientMethods"];

/// Isomorphic to TS INTERFACE_WRAPPER_NAMES: under `<Interfaces>` the engine
/// only recognizes these four wrapper spellings (entitydef.cpp:563-566, case
/// sensitive); child elements named directly after the interface are not
/// loaded by the engine, and here we likewise do not follow them.
pub const INTERFACE_WRAPPER_NAMES: &[&str] = &["interface", "Interface", "type", "Type"];

// ---------------------------------------------------------------------------
// UTF-16 coordinate mapping (byte span → TS string offsets)
// ---------------------------------------------------------------------------

struct Utf16Map {
    starts: Vec<usize>,
    utf16: Vec<usize>,
}

impl Utf16Map {
    fn new(text: &str) -> Self {
        let cap = text.chars().count() + 1;
        let mut starts = Vec::with_capacity(cap);
        let mut utf16 = Vec::with_capacity(cap);
        let mut units = 0usize;
        for (byte, ch) in text.char_indices() {
            starts.push(byte);
            utf16.push(units);
            units += ch.len_utf16();
        }
        starts.push(text.len());
        utf16.push(units);
        Self { starts, utf16 }
    }

    /// Byte offset → UTF-16 offset; when landing inside a multi-byte char it
    /// clamps to that char's start (parser spans are always on char boundaries,
    /// this arm is purely defensive).
    fn to_u16(&self, byte: usize) -> usize {
        match self.starts.binary_search(&byte) {
            Ok(i) => self.utf16[i],
            Err(i) => self.utf16[i.saturating_sub(1)],
        }
    }
}

fn utf16_offset_to_line(units: &[u16], offset: usize) -> usize {
    // TS offsetToLine = text.slice(0, offset).split('\n').length (1-based).
    let clamped = offset.min(units.len());
    units[..clamped].iter().filter(|&&c| c == 0x0A).count() + 1
}

/// UTF-16 (0-based line, in-line UTF-16 column) → UTF-16 offset (same
/// semantics as TS `document.offsetAt`: out-of-range line/column clamped —
/// a line past the end clamps to end of text, a column past the line end
/// clamps to line end; line separator is always '\n'). Service-face conversion
/// from LSP position to decision-core offset.
pub fn utf16_position_to_offset(units: &[u16], line0: usize, character: usize) -> usize {
    let mut line = 0usize;
    let mut offset = 0usize;
    while offset < units.len() && line < line0 {
        if units[offset] == 0x0A {
            line += 1;
        }
        offset += 1;
    }
    let mut col = 0usize;
    while offset < units.len() && col < character && units[offset] != 0x0A {
        offset += 1;
        col += 1;
    }
    offset
}

/// UTF-16 offset → (0-based line, in-line UTF-16 column) (same semantics as
/// TS `document.positionAt`: out-of-range offset clamps to end of text).
/// Service-face conversion from decision-core offset to the LSP range face.
pub fn utf16_offset_to_position(units: &[u16], offset: usize) -> (usize, usize) {
    let clamped = offset.min(units.len());
    let mut line = 0usize;
    let mut line_start = 0usize;
    for (idx, &unit) in units[..clamped].iter().enumerate() {
        if unit == 0x0A {
            line += 1;
            line_start = idx + 1;
        }
    }
    (line, clamped - line_start)
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

/// Renamable symbol (same shape as TS DefRenameSymbol).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefRenameSymbol {
    /// "property" | "method"
    pub kind: &'static str,
    pub name: String,
    /// The section the method belongs to; None for properties.
    pub section: Option<&'static str>,
    /// The name range at the cursor (UTF-16 offsets, start-inclusive
    /// end-exclusive), for prepareRename.
    pub word_start: usize,
    pub word_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DefRenameEditRange {
    pub start: usize,
    pub end: usize,
}

/// Rename target-name conflict (same shape as TS DefRenameConflict; file_path
/// is carried only by closure conflicts).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefRenameConflict {
    /// Conflict face: same-section method (section name) / Properties / Components.
    pub surface: String,
    pub name: String,
    /// Conflict declaration line (1-based).
    pub line: usize,
    pub file_path: Option<String>,
}

/// Edit computation result for one file (same shape as TS DefRenameFileEdits;
/// edits ascending, ranges in UTF-16 offsets relative to that file's own text).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefRenameFileEdits {
    pub file_path: PathBuf,
    pub edits: Vec<DefRenameEditRange>,
    /// Base text the edits were computed against (consumers convert
    /// line/column from it; golden does not serialize it).
    #[serde(skip_serializing)]
    pub text: String,
}

// ---------------------------------------------------------------------------
// Symbol resolution (isomorphic to resolveRenameSymbolAtOffset)
// ---------------------------------------------------------------------------

fn is_word_unit(c: u16) -> bool {
    matches!(c, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A | 0x5F)
}

fn is_identifier_unit(c: u16) -> bool {
    is_word_unit(c)
}

/// ASCII face of TS \s (corpus is ASCII; CJK comments never enter tag text).
fn is_ts_space(c: u16) -> bool {
    matches!(c, 0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20)
}

/// Isomorphic to TS findIdentifierAtOffset (includes the "one unit right of
/// the word end" tolerance).
fn find_identifier_at_offset(units: &[u16], offset: usize) -> Option<(usize, usize)> {
    if units.is_empty() {
        return None;
    }
    let mut start = offset;
    if start >= units.len() || !is_identifier_unit(units[start]) {
        if start > 0 && is_identifier_unit(units[start - 1]) {
            start -= 1;
        } else {
            return None;
        }
    }
    while start > 0 && is_identifier_unit(units[start - 1]) {
        start -= 1;
    }
    let mut end = start + 1;
    while end < units.len() && is_identifier_unit(units[end]) {
        end += 1;
    }
    Some((start, end))
}

fn contains_range(outer: (usize, usize), inner: (usize, usize)) -> bool {
    inner.0 >= outer.0 && inner.1 <= outer.1
}

/// Exact range of the name inside an element tag (isomorphic to TS
/// getTagNameRange: the tokenizer allows `< hp>`/`</ hp>` whitespace forms,
/// so one cannot blindly take the name span — it must be re-matched on tag
/// text; a handwritten equivalent of the TS regex `^<\s*/?\s*name\b`, all on
/// UTF-16 units). A self-closing element's close span is an empty range and
/// is naturally excluded.
fn get_tag_name_range(
    doc: &XmlDoc,
    units: &[u16],
    map: &Utf16Map,
    idx: usize,
    part: TagPart,
) -> Option<(usize, usize)> {
    let el = doc.element(idx);
    let span: Span = match part {
        TagPart::Open => el.open_span,
        TagPart::Close => el.close_span,
    };
    if span.end <= span.start {
        return None;
    }
    let tag_start = map.to_u16(span.start);
    let tag_end = map.to_u16(span.end);
    let mut i = tag_start;
    if units.get(i).copied() != Some(u16::from(b'<')) {
        return None;
    }
    i += 1;
    while i < tag_end && is_ts_space(units[i]) {
        i += 1;
    }
    if i < tag_end && units[i] == u16::from(b'/') {
        i += 1;
        while i < tag_end && is_ts_space(units[i]) {
            i += 1;
        }
    }
    let name_units: Vec<u16> = el.name.encode_utf16().collect();
    if i + name_units.len() > tag_end || units[i..i + name_units.len()] != name_units[..] {
        return None;
    }
    let after = i + name_units.len();
    // \b: the unit after the name is a non-word char (or the tag slice ends).
    if after < tag_end && is_word_unit(units[after]) {
        return None;
    }
    Some((i, after))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TagPart {
    Open,
    Close,
}

fn method_section_of(name: &str) -> Option<&'static str> {
    DEF_METHOD_SECTIONS.iter().copied().find(|s| *s == name)
}

/// Resolve the renamable symbol at the offset (isomorphic to TS
/// resolveRenameSymbolAtOffset). Requires the cursor word to land inside the
/// open/close tag name range of a symbol element (top-level Properties /
/// direct children of method sections); otherwise None.
pub fn resolve_rename_symbol_at_offset(text: &str, offset: usize) -> Option<DefRenameSymbol> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let map = Utf16Map::new(text);
    let word = find_identifier_at_offset(&units, offset)?;
    let doc = xml::parse(text, true);
    let root = doc.root()?;
    let word_str = String::from_utf16_lossy(&units[word.0..word.1]);

    for section in doc.child_elements(root) {
        let section_el = doc.element(section);
        let is_property_section = section_el.name == "Properties";
        let is_method_section = method_section_of(&section_el.name).is_some();
        if !is_property_section && !is_method_section {
            continue;
        }
        for child in doc.child_elements(section) {
            if doc.element(child).name != word_str {
                continue;
            }
            for part in [TagPart::Open, TagPart::Close] {
                let Some(name_range) = get_tag_name_range(&doc, &units, &map, child, part) else {
                    continue;
                };
                if contains_range(name_range, word) {
                    return Some(DefRenameSymbol {
                        kind: if is_property_section {
                            "property"
                        } else {
                            "method"
                        },
                        name: word_str.clone(),
                        section: if is_property_section {
                            None
                        } else {
                            method_section_of(&section_el.name)
                        },
                        word_start: name_range.0,
                        word_end: name_range.1,
                    });
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Same-file conflict (NAV-008 narrow face)
// ---------------------------------------------------------------------------

/// Isomorphic to TS findDefRenameConflict. Method name clashes only check the
/// symbol's own section (same names across sections are legal); properties and
/// components share the entity-member naming face, so either occupying the
/// name is a conflict. Invalid name / rename to the same name → None.
pub fn find_def_rename_conflict(
    text: &str,
    symbol: &DefRenameSymbol,
    new_name: &str,
) -> Option<DefRenameConflict> {
    if !is_def_identifier(new_name) || new_name == symbol.name {
        return None;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let map = Utf16Map::new(text);
    let doc = xml::parse(text, true);
    let root = doc.root()?;

    if symbol.kind == "method" {
        for section in doc.child_elements(root) {
            let section_name = doc.element(section).name.clone();
            if Some(section_name.as_str()) != symbol.section {
                continue;
            }
            for child in doc.child_elements(section) {
                let el = doc.element(child);
                if el.name == new_name {
                    return Some(DefRenameConflict {
                        surface: section_name.clone(),
                        name: new_name.to_string(),
                        line: utf16_offset_to_line(&units, map.to_u16(el.open_span.start)),
                        file_path: None,
                    });
                }
            }
        }
        return None;
    }

    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.clone();
        if section_name != "Properties" && section_name != "Components" {
            continue;
        }
        for child in doc.child_elements(section) {
            let el = doc.element(child);
            if el.name == new_name {
                return Some(DefRenameConflict {
                    surface: section_name.clone(),
                    name: new_name.to_string(),
                    line: utf16_offset_to_line(&units, map.to_u16(el.open_span.start)),
                    file_path: None,
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Member declaration face (closure dedup)
// ---------------------------------------------------------------------------

/// Renamable member declarations of top-level direct children in one def text
/// (the engine loads parent/interface/component descriptions into the same
/// ScriptDefModule for dedup; members are taken here on the same naming face).
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenameMemberDecl {
    kind: &'static str,
    name: String,
    section: Option<&'static str>,
    domains: BTreeSet<String>,
    line: usize,
}

/// Flags text → domain-bit set (same discipline as TS flagDomainsOfNode: the
/// first text child splits on '|', and after normalization each token's domain
/// bits are unioned).
fn flag_domains_of_element(doc: &XmlDoc, idx: usize) -> BTreeSet<String> {
    let Some(flags_idx) = doc.child_element(idx, "Flags") else {
        return BTreeSet::new();
    };
    let flags_text =
        doc.element(flags_idx)
            .children
            .iter()
            .find_map(|&c| match &doc.nodes[c].data {
                NodeData::Text { decoded, .. } => Some(decoded.clone()),
                _ => None,
            });
    let flags_raw = flags_text.unwrap_or_default();
    let tokens: Vec<&str> = flags_raw
        .split('|')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    let mut domains = BTreeSet::new();
    for token in normalize_flag_tokens(&tokens.join("|")) {
        for domain in flag_domains(std::slice::from_ref(&token)) {
            domains.insert(domain.to_string());
        }
    }
    domains
}

fn collect_own_member_decls(
    doc: &XmlDoc,
    units: &[u16],
    map: &Utf16Map,
    root: usize,
) -> Vec<RenameMemberDecl> {
    let mut decls = Vec::new();
    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.clone();
        if section_name == "Properties" || section_name == "Components" {
            for child in doc.child_elements(section) {
                let el = doc.element(child);
                decls.push(RenameMemberDecl {
                    kind: if section_name == "Properties" {
                        "property"
                    } else {
                        "component"
                    },
                    name: el.name.clone(),
                    section: None,
                    domains: flag_domains_of_element(doc, child),
                    line: utf16_offset_to_line(units, map.to_u16(el.open_span.start)),
                });
            }
        } else if let Some(section_str) = method_section_of(&section_name) {
            for child in doc.child_elements(section) {
                let el = doc.element(child);
                decls.push(RenameMemberDecl {
                    kind: "method",
                    name: el.name.clone(),
                    section: Some(section_str),
                    domains: BTreeSet::new(),
                    line: utf16_offset_to_line(units, map.to_u16(el.open_span.start)),
                });
            }
        }
    }
    decls
}

/// Engine dedup matrix (same semantics as defAnalyzer, scriptdef_module.cpp):
/// - component slots go through addComponentProperty into
///   addPropertyDescription, conflicting unconditionally with any same-named
///   declaration;
/// - method vs method conflicts only within the same section (the section is
///   the namespace);
/// - method vs property/component: globally rejected, unconditional conflict;
/// - property vs property/component: looked up by domain, conflicts only when
///   domain bits intersect.
fn member_conflicts(own: &RenameMemberDecl, inherited: &RenameMemberDecl) -> bool {
    if own.kind == "component" || inherited.kind == "component" {
        return true;
    }
    if own.kind == "method" && inherited.kind == "method" {
        return own.section == inherited.section;
    }
    if own.kind != inherited.kind {
        return true;
    }
    own.domains.iter().any(|d| inherited.domains.contains(d))
}

/// The new declaration face of the target symbol after rename (used to dedup
/// against closure files).
fn resolve_target_rename_decl(
    doc: &XmlDoc,
    root: usize,
    symbol: &DefRenameSymbol,
) -> Option<RenameMemberDecl> {
    if symbol.kind == "method" {
        return Some(RenameMemberDecl {
            kind: "method",
            name: symbol.name.clone(),
            section: symbol.section,
            domains: BTreeSet::new(),
            line: 0,
        });
    }
    for section in doc.child_elements(root) {
        if doc.element(section).name != "Properties" {
            continue;
        }
        for child in doc.child_elements(section) {
            let el = doc.element(child);
            if el.name == symbol.name {
                return Some(RenameMemberDecl {
                    kind: "property",
                    name: symbol.name.clone(),
                    section: None,
                    domains: flag_domains_of_element(doc, child),
                    line: 0,
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Engine naming semantics + def semantics face
// ---------------------------------------------------------------------------

/// Engine naming semantics (entitydef.cpp takes the **first child node** of
/// `<Parent>`/interface wrappers, tinyxml getKey: text nodes take their text,
/// elements take their tag name; purely whitespace text nodes are skipped per
/// the engine's condenseWhiteSpace discipline; mixed content takes the first
/// non-whitespace child, text preferred).
pub fn get_reference_target_name(doc: &XmlDoc, idx: usize) -> String {
    for &child in &doc.element(idx).children {
        match &doc.nodes[child].data {
            NodeData::Text { decoded, .. } => {
                let text = decoded.trim();
                if !text.is_empty() {
                    return text.to_string();
                }
            }
            NodeData::Element(_) => return doc.element(child).name.trim().to_string(),
            _ => {}
        }
    }
    String::new()
}

/// Direct semantics face of a def file: Parent name + Interfaces reference
/// names (aligned with the engine load grammar; the rename closure consumes
/// only these two faces — the component-slot Type face belongs to the method
/// implementation candidate chain and is not in this core).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefFileSemantics {
    pub parent_name: Option<String>,
    pub interface_names: Vec<String>,
}

pub fn parse_def_file_semantics(content: &str) -> Option<DefFileSemantics> {
    let doc = xml::parse(content, true);
    let root = doc.root()?;
    let parent_name = doc
        .child_element(root, "Parent")
        .map(|idx| get_reference_target_name(&doc, idx))
        .filter(|n| !n.is_empty());
    let mut interface_names = Vec::new();
    for section in doc.child_elements(root) {
        if doc.element(section).name != "Interfaces" {
            continue;
        }
        for reference in doc.child_elements(section) {
            if !INTERFACE_WRAPPER_NAMES.contains(&doc.element(reference).name.as_str()) {
                continue;
            }
            // Self-closing/empty wrappers yield an empty name, equivalent to a
            // dangling reference, skipped.
            let name = get_reference_target_name(&doc, reference);
            if !name.is_empty() {
                interface_names.push(name);
            }
        }
    }
    Some(DefFileSemantics {
        parent_name,
        interface_names,
    })
}

// ---------------------------------------------------------------------------
// Workspace walk (definition root location / file enumeration / owner closure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DefOwnerCategory {
    Entity,
    Interface,
    Component,
}

#[derive(Debug, Clone)]
struct DefFileEntry {
    file_path: PathBuf,
    category: DefOwnerCategory,
    #[allow(dead_code)]
    name: String,
}

fn is_path_inside(base_dir: &Path, target: &Path) -> bool {
    target.strip_prefix(base_dir).is_ok()
}

/// Derive the entity_defs definition root upward from the target file
/// (isomorphic to TS findEntityDefsRootFromFile: after hitting a directory
/// containing entities.xml, confirm the target file actually sits under its
/// entity_defs subtree, otherwise take the directory itself; no entities.xml
/// found returns None).
pub fn find_entity_defs_root_from_file(file_path: &Path) -> Option<PathBuf> {
    let resolved = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let mut dir = resolved.parent()?.to_path_buf();
    loop {
        if dir.join("entities.xml").exists() {
            let defs_root = dir.join("entity_defs");
            if is_path_inside(&defs_root, &resolved) {
                return Some(defs_root);
            }
            return Some(dir);
        }
        let parent = dir.parent()?;
        if parent == dir {
            return None;
        }
        dir = parent.to_path_buf();
    }
}

/// Callers guarantee file_path is inside defs_root (the root is derived upward
/// from the target file itself / built by enumeration).
fn classify_def_file(defs_root: &Path, file_path: &Path) -> DefFileEntry {
    let resolved = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let base = std::fs::canonicalize(defs_root).unwrap_or_else(|_| defs_root.to_path_buf());
    let mut category = DefOwnerCategory::Entity;
    if let Ok(relative) = resolved.strip_prefix(&base) {
        for component in relative.components() {
            let seg = component.as_os_str().to_string_lossy();
            if seg == "interfaces" {
                category = DefOwnerCategory::Interface;
            } else if seg == "components" {
                category = DefOwnerCategory::Component;
            }
        }
    }
    DefFileEntry {
        name: resolved
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        file_path: resolved,
        category,
    }
}

fn list_def_files_recursive(defs_root: &Path) -> Vec<DefFileEntry> {
    let mut entries = Vec::new();
    fn walk(dir: &Path, defs_root: &Path, out: &mut Vec<DefFileEntry>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                walk(&path, defs_root, out);
            } else if path.is_file()
                && path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase().ends_with(".def"))
                    .unwrap_or(false)
            {
                out.push(classify_def_file(defs_root, &path));
            }
        }
    }
    walk(defs_root, defs_root, &mut entries);
    entries.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    entries
}

struct DefLinkPaths {
    parent_path: Option<PathBuf>,
    interface_paths: Vec<PathBuf>,
}

/// The engine's edge-resolution face (entitydef.cpp): entity Parent sits flat
/// in the definition root; interfaces are fixed in the interfaces/ subdirectory;
/// a component def's Parent resolves inside components/. Interface files do not
/// read Parent at load time (loadInterfaces does not go through
/// loadParentClass) — no edge is produced.
fn resolve_link_paths(
    defs_root: &Path,
    entry: &DefFileEntry,
    semantics: &DefFileSemantics,
) -> DefLinkPaths {
    let interface_paths = semantics
        .interface_names
        .iter()
        .map(|name| defs_root.join("interfaces").join(format!("{name}.def")))
        .collect();
    let mut parent_path = None;
    if let Some(parent_name) = &semantics.parent_name {
        if entry.category != DefOwnerCategory::Interface {
            let parent_dir = if entry.category == DefOwnerCategory::Component {
                defs_root.join("components")
            } else {
                defs_root.to_path_buf()
            };
            parent_path = Some(parent_dir.join(format!("{parent_name}.def")));
        }
    }
    DefLinkPaths {
        parent_path,
        interface_paths,
    }
}

/// The file owner's ancestor closure (Parent chain + Interfaces mixins,
/// transitive) — resolved precisely along the engine load path; dangling
/// references produce no edge.
fn collect_owner_closure(
    entry: &DefFileEntry,
    defs_root: &Path,
    file_index: &BTreeMap<PathBuf, DefFileEntry>,
    read_content: &dyn Fn(&Path) -> Option<String>,
) -> BTreeSet<PathBuf> {
    let mut closure = BTreeSet::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    seen.insert(entry.file_path.clone());
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(entry.clone());
    while let Some(current) = queue.pop_front() {
        let Some(content) = read_content(&current.file_path) else {
            continue;
        };
        let Some(semantics) = parse_def_file_semantics(&content) else {
            continue;
        };
        let links = resolve_link_paths(defs_root, &current, &semantics);
        for target_path in links.parent_path.into_iter().chain(links.interface_paths) {
            let Some(target_entry) = file_index.get(&target_path) else {
                continue;
            };
            closure.insert(target_entry.file_path.clone());
            if !seen.contains(&target_entry.file_path) {
                seen.insert(target_entry.file_path.clone());
                queue.push_back(target_entry.clone());
            }
        }
    }
    closure
}

// ---------------------------------------------------------------------------
// Edit range collection + whole-workspace edit computation
// ---------------------------------------------------------------------------

/// Collect all name ranges of the symbol in one def text (open tag +
/// non-self-closing close tag).
pub fn collect_rename_edits_in_text(
    text: &str,
    symbol: &DefRenameSymbol,
) -> Vec<DefRenameEditRange> {
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return Vec::new();
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let map = Utf16Map::new(text);
    let mut ranges = Vec::new();
    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.as_str();
        let section_matches = if symbol.kind == "method" {
            Some(section_name) == symbol.section
        } else {
            section_name == "Properties"
        };
        if !section_matches {
            continue;
        }
        for child in doc.child_elements(section) {
            if doc.element(child).name != symbol.name {
                continue;
            }
            if let Some(open) = get_tag_name_range(&doc, &units, &map, child, TagPart::Open) {
                ranges.push(DefRenameEditRange {
                    start: open.0,
                    end: open.1,
                });
            }
            if let Some(close) = get_tag_name_range(&doc, &units, &map, child, TagPart::Close) {
                ranges.push(DefRenameEditRange {
                    start: close.0,
                    end: close.1,
                });
            }
        }
    }
    ranges.sort_by_key(|r| r.start);
    ranges
}

type CrossFileReader<'a> = &'a dyn Fn(&Path) -> Option<String>;

/// Compute all edits for a rename (isomorphic to TS computeDefRenameEdits):
/// same-named symbols in the target file + same-named restatements in
/// descendant defs (closure includes the target). Returns an empty array when
/// the new name is invalid or identical to the original, or the target file
/// cannot be parsed.
pub fn compute_def_rename_edits(
    target_file_path: &Path,
    target_text: &str,
    symbol: &DefRenameSymbol,
    new_name: &str,
    read_cross_file_content: CrossFileReader,
) -> Vec<DefRenameFileEdits> {
    if !is_def_identifier(new_name) || new_name == symbol.name {
        return Vec::new();
    }
    let resolved_target =
        std::fs::canonicalize(target_file_path).unwrap_or_else(|_| target_file_path.to_path_buf());
    let target_edits = collect_rename_edits_in_text(target_text, symbol);
    let mut results: Vec<DefRenameFileEdits> = if target_edits.is_empty() {
        return Vec::new();
    } else {
        vec![DefRenameFileEdits {
            file_path: resolved_target.clone(),
            edits: target_edits,
            text: target_text.to_string(),
        }]
    };

    let Some(defs_root) = find_entity_defs_root_from_file(&resolved_target) else {
        return results;
    };

    let files = list_def_files_recursive(&defs_root);
    let mut file_index = BTreeMap::new();
    for entry in files {
        file_index.insert(entry.file_path.clone(), entry);
    }

    for entry in file_index.values() {
        if entry.file_path == resolved_target {
            continue;
        }
        let Some(content) = read_cross_file_content(&entry.file_path) else {
            continue;
        };
        let closure =
            collect_owner_closure(entry, &defs_root, &file_index, read_cross_file_content);
        if !closure.contains(&resolved_target) {
            continue;
        }
        let edits = collect_rename_edits_in_text(&content, symbol);
        if !edits.is_empty() {
            results.push(DefRenameFileEdits {
                file_path: entry.file_path.clone(),
                edits,
                text: content,
            });
        }
    }

    results.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    results
}

// ---------------------------------------------------------------------------
// Closure conflict pre-check (AUD-061)
// ---------------------------------------------------------------------------

/// Isomorphic to TS findDefRenameConflictInClosure. Beyond NAV-008's
/// declaration-file check, also checks whether the target owner's ancestor
/// closure (Parent chain + Interfaces mixins) and all descendants (whose
/// ancestor closure includes the target) already occupy newName under the
/// engine's global dedup; occupied → returns the conflict location (face +
/// 1-based line + file path). No definition root found, target unresolvable,
/// name invalid / rename to the same name → None.
pub fn find_def_rename_conflict_in_closure(
    target_file_path: &Path,
    target_text: &str,
    symbol: &DefRenameSymbol,
    new_name: &str,
    read_cross_file_content: CrossFileReader,
) -> Option<DefRenameConflict> {
    if !is_def_identifier(new_name) || new_name == symbol.name {
        return None;
    }
    let resolved_target =
        std::fs::canonicalize(target_file_path).unwrap_or_else(|_| target_file_path.to_path_buf());
    let defs_root = find_entity_defs_root_from_file(&resolved_target)?;
    let target_doc = xml::parse(target_text, true);
    let target_root = target_doc.root()?;
    let target_decl = resolve_target_rename_decl(&target_doc, target_root, symbol)?;

    let files = list_def_files_recursive(&defs_root);
    let mut file_index = BTreeMap::new();
    for entry in files {
        file_index.insert(entry.file_path.clone(), entry);
    }

    let target_entry = classify_def_file(&defs_root, &resolved_target);
    let ancestor_closure = collect_owner_closure(
        &target_entry,
        &defs_root,
        &file_index,
        read_cross_file_content,
    );

    for entry in file_index.values() {
        if entry.file_path == resolved_target {
            continue;
        }
        let Some(content) = read_cross_file_content(&entry.file_path) else {
            continue;
        };
        let is_ancestor = ancestor_closure.contains(&entry.file_path);
        let is_descendant =
            collect_owner_closure(entry, &defs_root, &file_index, read_cross_file_content)
                .contains(&resolved_target);
        if !is_ancestor && !is_descendant {
            continue;
        }
        let doc = xml::parse(&content, true);
        let Some(root) = doc.root() else {
            continue;
        };
        let units: Vec<u16> = content.encode_utf16().collect();
        let map = Utf16Map::new(&content);
        for decl in collect_own_member_decls(&doc, &units, &map, root) {
            if decl.name != new_name {
                continue;
            }
            if member_conflicts(&decl, &target_decl) {
                return Some(DefRenameConflict {
                    surface: decl.section.map(str::to_string).unwrap_or_else(|| {
                        if decl.kind == "property" {
                            "Properties".to_string()
                        } else {
                            "Components".to_string()
                        }
                    }),
                    name: new_name.to_string(),
                    line: decl.line,
                    file_path: Some(entry.file_path.to_string_lossy().into_owned()),
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// golden (vitest imports the production defRenamer functions directly to recompute for comparison)
// ---------------------------------------------------------------------------

pub const DEF_RENAME_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/def-rename-parity.json";

/// Closure-conflict probe name: a legal identifier that appears in no corpus
/// file — walks the whole workspace and is always null, pinning the
/// "no-conflict path"; the conflict paths are driven by existing member-name
/// candidates.
const PROBE_NEW_NAME: &str = "zzRenameProbeNew";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenHit {
    offset: usize,
    kind: &'static str,
    section: Option<&'static str>,
    name: String,
    word_start: usize,
    word_end: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCheck {
    new_name: String,
    conflict: Option<GoldenConflict>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenConflict {
    surface: String,
    name: String,
    line: usize,
    file_path: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct GoldenEditFile {
    file: String,
    ranges: Vec<(usize, usize)>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenAnalysis {
    kind: &'static str,
    section: Option<&'static str>,
    name: String,
    conflict_checks: Vec<GoldenCheck>,
    edits: Vec<GoldenEditFile>,
    closure_checks: Vec<GoldenCheck>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFileEntry {
    file: String,
    probe_count: usize,
    symbol_hits: Vec<GoldenHit>,
    analyses: Vec<GoldenAnalysis>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenWorkspace {
    root: Option<String>,
    files: Vec<GoldenFileEntry>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    workspace_count: usize,
    def_file_count: usize,
    symbol_hit_count: usize,
    analysis_count: usize,
    closure_check_count: usize,
    workspaces: Vec<GoldenWorkspace>,
}

fn to_repo_rel(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// .def corpus collection (same roots as PARITY_CORPORA, only .def collected,
/// BTreeMap lexicographic determinism).
fn collect_def_corpus(repo_root: &Path) -> BTreeMap<String, String> {
    fn walk(dir: &Path, rel_prefix: &str, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let rel = format!("{rel_prefix}/{name}");
            if path.is_dir() {
                walk(&path, &rel, out);
                continue;
            }
            if name.to_lowercase().ends_with(".def") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.insert(rel, text);
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    for corpus in kode_parser::json::PARITY_CORPORA {
        walk(&repo_root.join(corpus), corpus, &mut out);
    }
    out
}

/// Top-level member names of one def text (direct children of
/// Properties/Components/the three method sections).
fn member_names_of(text: &str) -> BTreeSet<String> {
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return BTreeSet::new();
    };
    let mut names = BTreeSet::new();
    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.clone();
        let is_member_section = section_name == "Properties"
            || section_name == "Components"
            || method_section_of(&section_name).is_some();
        if !is_member_section {
            continue;
        }
        for child in doc.child_elements(section) {
            names.insert(doc.element(child).name.clone());
        }
    }
    names
}

/// Walk the .def corpus: per file, per offset probe symbol resolution (non-empty
/// hits enter golden); for each resolvable symbol run same-file conflict ×
/// same-file member-name candidates, whole-workspace edit computation, and
/// closure conflict × "member names declared in other files" candidates (names
/// declared only in the target file are always null for the closure check —
/// production only checks non-target files, so absent means always null; hence
/// the candidate universe is "names declared in other files ∪ probe name", same
/// rule on both sides; the pure-walk null path is pinned by the probe name).
pub fn dump_def_rename_golden(repo_root: &Path) -> String {
    // to_repo_rel strips the prefix against the canonical root; relative-path
    // input (e.g. ".") is normalized first.
    let repo_root = &repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    let corpus = collect_def_corpus(repo_root);
    let reader = |p: &Path| std::fs::read_to_string(p).ok();

    // Group by definition root (Option<String>: None < Some, Rust ordering).
    let mut groups: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    for rel in corpus.keys() {
        let abs = repo_root.join(rel);
        let root = find_entity_defs_root_from_file(&abs);
        let key = root.map(|r| to_repo_rel(repo_root, &r));
        groups.entry(key).or_default().push(rel.clone());
    }

    let mut dump = GoldenDump {
        generator: "kode-server dump-def-rename-golden",
        workspace_count: groups.len(),
        def_file_count: corpus.len(),
        symbol_hit_count: 0,
        analysis_count: 0,
        closure_check_count: 0,
        workspaces: Vec::new(),
    };

    for (root_key, files) in &groups {
        // Per-file member-name set (for candidate universe computation).
        let member_names: BTreeMap<&str, BTreeSet<String>> = files
            .iter()
            .map(|rel| (rel.as_str(), member_names_of(&corpus[rel])))
            .collect();

        let mut golden_files = Vec::new();
        for rel in files {
            let text = &corpus[rel];
            let units: Vec<u16> = text.encode_utf16().collect();
            let abs = repo_root.join(rel);

            // Per-offset probe of symbol resolution.
            let mut hits = Vec::new();
            let mut analysis_keys: Vec<(&'static str, Option<&'static str>, String)> = Vec::new();
            for offset in 0..=units.len() {
                if let Some(symbol) = resolve_rename_symbol_at_offset(text, offset) {
                    let key = (symbol.kind, symbol.section, symbol.name.clone());
                    if !analysis_keys.contains(&key) {
                        analysis_keys.push(key.clone());
                    }
                    hits.push(GoldenHit {
                        offset,
                        kind: symbol.kind,
                        section: symbol.section,
                        name: symbol.name.clone(),
                        word_start: symbol.word_start,
                        word_end: symbol.word_end,
                    });
                }
            }

            let same_file_names = member_names.get(rel.as_str()).cloned().unwrap_or_default();
            let other_names: BTreeSet<String> = member_names
                .iter()
                .filter(|(f, _)| **f != rel.as_str())
                .flat_map(|(_, names)| names.iter().cloned())
                .collect();

            let mut analyses = Vec::new();
            for (kind, section, name) in &analysis_keys {
                let symbol = DefRenameSymbol {
                    kind,
                    name: name.clone(),
                    section: *section,
                    word_start: 0,
                    word_end: 0,
                };

                // Same-file conflict × this file's member names ∪ probe name.
                let mut conflict_candidates = same_file_names.clone();
                conflict_candidates.insert(PROBE_NEW_NAME.to_string());
                let conflict_checks: Vec<GoldenCheck> = conflict_candidates
                    .into_iter()
                    .map(|candidate| GoldenCheck {
                        new_name: candidate.clone(),
                        conflict: find_def_rename_conflict(text, &symbol, &candidate).map(|c| {
                            GoldenConflict {
                                surface: c.surface,
                                name: c.name,
                                line: c.line,
                                file_path: None,
                            }
                        }),
                    })
                    .collect();

                // Whole-workspace edit computation.
                let edits = compute_def_rename_edits(&abs, text, &symbol, PROBE_NEW_NAME, &reader)
                    .into_iter()
                    .map(|fe| GoldenEditFile {
                        file: to_repo_rel(repo_root, &fe.file_path),
                        ranges: fe.edits.into_iter().map(|e| (e.start, e.end)).collect(),
                    })
                    .collect();

                // Closure conflict × member names declared in other files ∪ probe name.
                let mut closure_candidates = other_names.clone();
                closure_candidates.insert(PROBE_NEW_NAME.to_string());
                let closure_checks: Vec<GoldenCheck> = closure_candidates
                    .into_iter()
                    .map(|candidate| {
                        let conflict = find_def_rename_conflict_in_closure(
                            &abs, text, &symbol, &candidate, &reader,
                        );
                        dump.closure_check_count += 1;
                        GoldenCheck {
                            new_name: candidate.clone(),
                            conflict: conflict.map(|c| GoldenConflict {
                                surface: c.surface,
                                name: c.name,
                                line: c.line,
                                file_path: c
                                    .file_path
                                    .map(|p| to_repo_rel(repo_root, Path::new(&p))),
                            }),
                        }
                    })
                    .collect();

                analyses.push(GoldenAnalysis {
                    kind,
                    section: *section,
                    name: name.clone(),
                    conflict_checks,
                    edits,
                    closure_checks,
                });
            }
            dump.analysis_count += analyses.len();
            golden_files.push(GoldenFileEntry {
                file: rel.clone(),
                probe_count: units.len() + 1,
                symbol_hits: hits,
                analyses,
            });
        }
        dump.workspaces.push(GoldenWorkspace {
            root: root_key.clone(),
            files: golden_files,
        });
    }
    dump.symbol_hit_count = dump
        .workspaces
        .iter()
        .map(|w| w.files.iter().map(|f| f.symbol_hits.len()).sum::<usize>())
        .sum();
    serde_json::to_string_pretty(&dump).expect("serialize")
}

// ---------------------------------------------------------------------------
// Unit pins
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const HERO_DEF: &str = "<root>\n  <Properties>\n    <hp>\n      <Type> UINT32 </Type>\n      <Flags> BASE_AND_CLIENT </Flags>\n    </hp>\n  </Properties>\n  <CellMethods>\n    <reqAttack>\n      <Exposed> true </Exposed>\n    </reqAttack>\n  </CellMethods>\n</root>\n";

    /// Temporary workspace construction: files = (relative path, content);
    /// returns the root directory.
    fn tmp_workspace(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "kode-def-rename-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (rel, content) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
            std::fs::write(&path, content).expect("write");
        }
        root
    }

    #[test]
    fn resolve_symbol_open_close_and_tolerance_faces() {
        let open = HERO_DEF.find("<hp>").unwrap();
        // Inside the open-tag word.
        let hit = resolve_rename_symbol_at_offset(HERO_DEF, open + 2).expect("开标签词中解析");
        assert_eq!(hit.kind, "property");
        assert_eq!(hit.name, "hp");
        assert_eq!(hit.section, None);
        assert_eq!(&HERO_DEF[hit.word_start..hit.word_end], "hp");
        // On the close tag: the word range points at the close-tag name.
        let close = HERO_DEF.find("</hp>").unwrap();
        let hit2 = resolve_rename_symbol_at_offset(HERO_DEF, close + 3).expect("闭标签解析");
        assert_eq!(hit2.word_start, close + 2);
        // One-unit-right-of-word-end tolerance (at '>' it steps back one and hits hp).
        assert!(resolve_rename_symbol_at_offset(HERO_DEF, open + 3).is_some());
        // Method symbols carry their section.
        let method = HERO_DEF.find("reqAttack").unwrap();
        let hit3 = resolve_rename_symbol_at_offset(HERO_DEF, method).expect("方法解析");
        assert_eq!(hit3.kind, "method");
        assert_eq!(hit3.section, Some("CellMethods"));
        // Flags values, nested child-element names, and whitespace are not renamable symbols.
        assert!(
            resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("UINT32").unwrap()).is_none()
        );
        assert!(
            resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("Exposed").unwrap()).is_none()
        );
        assert!(resolve_rename_symbol_at_offset(HERO_DEF, 0).is_none());
        // Bad text: no root.
        assert!(resolve_rename_symbol_at_offset("plain text", 2).is_none());
    }

    #[test]
    fn conflict_method_same_section_and_property_component_faces() {
        let method_pos = HERO_DEF.find("reqAttack").unwrap();
        let symbol = resolve_rename_symbol_at_offset(HERO_DEF, method_pos).unwrap();
        // No same name means no conflict (method face: no reqAttack2 in the same section).
        assert!(find_def_rename_conflict(HERO_DEF, &symbol, "reqAttack2").is_none());
        // Same-section duplicate: declaring cellSkill again in CellMethods, the
        // method rename collides with an existing member of the same section.
        let with_dup = HERO_DEF.replace(
            "  </CellMethods>",
            "    <cellSkill>\n    </cellSkill>\n  </CellMethods>",
        );
        let dup_symbol = with_dup
            .find("cellSkill")
            .and_then(|p| resolve_rename_symbol_at_offset(&with_dup, p));
        assert!(dup_symbol.is_some());
        // Method renamed to an existing same-section name → conflict with a 1-based line.
        let m = resolve_rename_symbol_at_offset(&with_dup, with_dup.find("reqAttack").unwrap())
            .unwrap();
        let hit = find_def_rename_conflict(&with_dup, &m, "cellSkill").expect("同段冲突");
        assert_eq!(hit.surface, "CellMethods");
        assert_eq!(hit.name, "cellSkill");
        assert!(hit.line >= 1);
        // Same name across sections is legal: a same-named member in BaseMethods does not conflict.
        let cross = HERO_DEF.replace(
            "<root>",
            "<root>\n  <BaseMethods>\n    <cellSkill>\n    </cellSkill>\n  </BaseMethods>",
        );
        let m2 = resolve_rename_symbol_at_offset(&cross, cross.find("reqAttack").unwrap()).unwrap();
        assert!(
            find_def_rename_conflict(&cross, &m2, "cellSkill").is_none(),
            "跨段同名合法"
        );
        // Invalid name / rename to the same name → None.
        assert!(find_def_rename_conflict(&cross, &m2, "1bad").is_none());
        assert!(find_def_rename_conflict(&cross, &m2, "reqAttack").is_none());
        // Property vs component are mutually exclusive.
        let with_comp = HERO_DEF.replace(
            "  <CellMethods>",
            "  <Components>\n    <bag>\n      <Type> Inventory </Type>\n    </bag>\n  </Components>\n  <CellMethods>",
        );
        let hp = resolve_rename_symbol_at_offset(&with_comp, with_comp.find("<hp>").unwrap() + 2)
            .unwrap();
        let hit2 = find_def_rename_conflict(&with_comp, &hp, "bag").expect("属性撞组件");
        assert_eq!(hit2.surface, "Components");
    }

    #[test]
    fn identifier_gate_and_reference_target_name_forms() {
        // Invalid new name: edit computation is empty.
        let hp_pos = HERO_DEF.find("<hp>").unwrap() + 2;
        let symbol = resolve_rename_symbol_at_offset(HERO_DEF, hp_pos).unwrap();
        assert!(
            collect_rename_edits_in_text(HERO_DEF, &symbol).len() == 2,
            "开+闭标签两区间"
        );
        // Engine naming semantics: text form and element form (first child node;
        // text nodes take their text / elements take their tag name).
        let text_doc = "<root><Parent> Hero </Parent><Interfaces><interface> ROLE </interface></Interfaces></root>";
        let doc = xml::parse(text_doc, true);
        let root = doc.root().unwrap();
        let parent = doc.child_element(root, "Parent").unwrap();
        assert_eq!(get_reference_target_name(&doc, parent), "Hero");
        let interfaces = doc.child_element(root, "Interfaces").unwrap();
        let iface = doc.child_elements(interfaces)[0];
        assert_eq!(get_reference_target_name(&doc, iface), "ROLE");
        // Element form: <Parent><Hero/></Parent> takes the tag name.
        let elem_doc = xml::parse("<root><Parent><Hero/></Parent></root>", true);
        let elem_root = elem_doc.root().unwrap();
        let elem_parent = elem_doc.child_element(elem_root, "Parent").unwrap();
        assert_eq!(
            get_reference_target_name(&elem_doc, elem_parent),
            "Hero",
            "元素形态取标签名"
        );
        // A dangling (empty-content) wrapper yields an empty name.
        let empty_doc = xml::parse(
            "<root><Interfaces><interface>   </interface></Interfaces></root>",
            true,
        );
        let r2 = empty_doc.root().unwrap();
        let ifaces2 = empty_doc.child_element(r2, "Interfaces").unwrap();
        let w2 = empty_doc.child_elements(ifaces2)[0];
        assert_eq!(get_reference_target_name(&empty_doc, w2), "");
        // Semantics face: Parent + Interfaces.
        let sem = parse_def_file_semantics(text_doc).unwrap();
        assert_eq!(sem.parent_name.as_deref(), Some("Hero"));
        assert_eq!(sem.interface_names, vec!["ROLE".to_string()]);
        // An interface file's Parent is not followed (resolve_link_paths face).
        let entry = DefFileEntry {
            file_path: PathBuf::from("/x/interfaces/ROLE.def"),
            category: DefOwnerCategory::Interface,
            name: "ROLE".to_string(),
        };
        let sem2 = DefFileSemantics {
            parent_name: Some("Hero".to_string()),
            interface_names: Vec::new(),
        };
        let links = resolve_link_paths(Path::new("/x"), &entry, &sem2);
        assert!(links.parent_path.is_none(), "接口不读 Parent");
    }

    #[test]
    fn workspace_edits_cover_descendant_and_interface_closure() {
        let root = tmp_workspace(
            "edits",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root>\n  <Interfaces><interface> ROLE </interface></Interfaces>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root>\n  <Parent>Hero</Parent>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
                (
                    "entity_defs/interfaces/ROLE.def",
                    "<root>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
                (
                    "entity_defs/Unrelated.def",
                    "<root>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
            ],
        );
        let target = root.join("entity_defs/Hero.def");
        let text = std::fs::read_to_string(&target).unwrap();
        let symbol =
            resolve_rename_symbol_at_offset(&text, text.find("<hp>").unwrap() + 2).unwrap();
        let reader = |p: &Path| std::fs::read_to_string(p).ok();
        let edits = compute_def_rename_edits(&target, &text, &symbol, "vigor", &reader);
        let files: Vec<String> = edits
            .iter()
            .map(|e| {
                e.file_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        // Edits only propagate to descendants: Monster (Parent Hero) restatement
        // enters the edits; the interface ROLE is an ancestor and not in this face
        // (covered by "initiating from the interface file"); unrelated entities
        // untouched.
        assert_eq!(
            files,
            vec!["Hero.def".to_string(), "Monster.def".to_string()],
            "后代复述进编辑,祖先接口与无关实体不动"
        );
        // Two ranges per file (open + close tags).
        for fe in &edits {
            assert_eq!(fe.edits.len(), 2);
            assert!(fe.edits[0].start < fe.edits[1].start);
        }
        // Initiating from the interface source: mixed-in entities and their entity
        // descendants both enter the edits (Interfaces transitive closure).
        let role = root.join("entity_defs/interfaces/ROLE.def");
        let role_text = std::fs::read_to_string(&role).unwrap();
        let role_symbol =
            resolve_rename_symbol_at_offset(&role_text, role_text.find("<hp>").unwrap() + 2)
                .unwrap();
        let role_edits =
            compute_def_rename_edits(&role, &role_text, &role_symbol, "vigor", &reader);
        let role_files: Vec<String> = role_edits
            .iter()
            .map(|e| {
                e.file_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(
            role_files,
            vec![
                "Hero.def".to_string(),
                "Monster.def".to_string(),
                "ROLE.def".to_string()
            ],
            "从接口发起:混入实体 Hero 与后代 Monster 都进编辑"
        );
        // New name invalid / same as original → empty.
        assert!(compute_def_rename_edits(&target, &text, &symbol, "1x", &reader).is_empty());
        assert!(compute_def_rename_edits(&target, &text, &symbol, "hp", &reader).is_empty());
        // Component Parent resolves inside components/; a dangling Parent produces no edge.
        let dangling = tmp_workspace(
            "dangling",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Lone.def",
                    "<root><Parent>Ghost</Parent><Properties><hp><Flags> BASE </Flags></hp></Properties></root>\n",
                ),
            ],
        );
        let lone = dangling.join("entity_defs/Lone.def");
        let lone_text = std::fs::read_to_string(&lone).unwrap();
        let lone_symbol =
            resolve_rename_symbol_at_offset(&lone_text, lone_text.find("<hp>").unwrap() + 2)
                .unwrap();
        let lone_edits =
            compute_def_rename_edits(&lone, &lone_text, &lone_symbol, "vigor", &reader);
        assert_eq!(lone_edits.len(), 1, "悬空 Parent 只改自己");
    }

    #[test]
    fn closure_conflict_ancestor_and_descendant_directions() {
        let reader = |p: &Path| std::fs::read_to_string(p).ok();
        let root = tmp_workspace(
            "closure",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n    <vigor>\n      <Flags> CELL_PUBLIC </Flags>\n    </vigor>\n  </Properties>\n  <CellMethods>\n    <onMove>\n    </onMove>\n  </CellMethods>\n</root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root>\n  <Parent>Hero</Parent>\n  <Properties>\n    <ferocity>\n      <Flags> BASE </Flags>\n    </ferocity>\n  </Properties>\n</root>\n",
                ),
            ],
        );
        // Descendant direction: Hero.hp → vigor clashes with descendants? Monster
        // has no vigor → no conflict; but Hero.hp → ferocity hits descendant
        // Monster.ferocity (BASE intersects) → conflict with file.
        let hero = root.join("entity_defs/Hero.def");
        let hero_text = std::fs::read_to_string(&hero).unwrap();
        let hp = resolve_rename_symbol_at_offset(&hero_text, hero_text.find("<hp>").unwrap() + 2)
            .unwrap();
        let hit = find_def_rename_conflict_in_closure(&hero, &hero_text, &hp, "ferocity", &reader)
            .expect("后代占名冲突");
        assert_eq!(hit.surface, "Properties");
        assert_eq!(hit.name, "ferocity");
        assert!(hit.file_path.as_deref().unwrap().ends_with("Monster.def"));
        // Disjoint domain bits do not conflict: Hero.hp (BASE) → vigor? vigor is a
        // same-named symbol in the file itself → the same-name gate; onMove? kinds
        // differ (method face) → method vs property conflicts unconditionally.
        let m =
            resolve_rename_symbol_at_offset(&hero_text, hero_text.find("onMove").unwrap()).unwrap();
        let hit2 = find_def_rename_conflict_in_closure(&hero, &hero_text, &m, "ferocity", &reader)
            .expect("方法 vs 后代属性无条件冲突");
        assert_eq!(hit2.surface, "Properties");
        // Ancestor direction: Monster.ferocity → hp hits ancestor Hero.hp → conflict.
        let monster = root.join("entity_defs/Monster.def");
        let monster_text = std::fs::read_to_string(&monster).unwrap();
        let ferocity =
            resolve_rename_symbol_at_offset(&monster_text, monster_text.find("ferocity").unwrap())
                .unwrap();
        let hit3 =
            find_def_rename_conflict_in_closure(&monster, &monster_text, &ferocity, "hp", &reader)
                .expect("祖先占名冲突");
        assert!(hit3.file_path.as_deref().unwrap().ends_with("Hero.def"));
        // Unrelated name (probe name only) → null after the full walk.
        assert!(find_def_rename_conflict_in_closure(
            &hero,
            &hero_text,
            &hp,
            PROBE_NEW_NAME,
            &reader
        )
        .is_none());
        // No definition root → None.
        let lone_dir = tmp_workspace("noroot", &[("Lone.def", HERO_DEF)]);
        let lone = lone_dir.join("Lone.def");
        let lone_text = std::fs::read_to_string(&lone).unwrap();
        let lone_symbol =
            resolve_rename_symbol_at_offset(&lone_text, lone_text.find("<hp>").unwrap() + 2)
                .unwrap();
        assert!(find_def_rename_conflict_in_closure(
            &lone,
            &lone_text,
            &lone_symbol,
            "vigor",
            &reader
        )
        .is_none());
    }

    #[test]
    fn flag_domain_overlap_gates_property_conflict() {
        // BASE({base}) vs CELL_PUBLIC({cell}) disjoint domain bits → descendant
        // name occupation does not conflict; BASE_AND_CLIENT({base,client}) vs
        // ALL_CLIENTS({cell,client}) intersect on client → conflict.
        let reader = |p: &Path| std::fs::read_to_string(p).ok();
        let root1 = tmp_workspace(
            "domains",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root><Properties><hp><Flags> BASE </Flags></hp></Properties></root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root><Parent>Hero</Parent><Properties><sight><Flags> CELL_PUBLIC </Flags></sight></Properties></root>\n",
                ),
            ],
        );
        // Hero.hp (BASE) → sight (Monster, CELL_PUBLIC): disjoint → null.
        let hero1 = root1.join("entity_defs/Hero.def");
        let text1 = std::fs::read_to_string(&hero1).unwrap();
        let sym1 =
            resolve_rename_symbol_at_offset(&text1, text1.find("<hp>").unwrap() + 2).unwrap();
        assert!(
            find_def_rename_conflict_in_closure(&hero1, &text1, &sym1, "sight", &reader).is_none(),
            "域位不相交不冲突"
        );
        let root2 = tmp_workspace(
            "domains2",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root><Properties><hp><Flags> BASE_AND_CLIENT </Flags></hp></Properties></root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root><Parent>Hero</Parent><Properties><mp><Flags> ALL_CLIENTS </Flags></mp></Properties></root>\n",
                ),
            ],
        );
        // Hero.hp (BASE_AND_CLIENT) → mp (Monster, ALL_CLIENTS): intersect → conflict.
        let hero2 = root2.join("entity_defs/Hero.def");
        let text2 = std::fs::read_to_string(&hero2).unwrap();
        let sym2 =
            resolve_rename_symbol_at_offset(&text2, text2.find("<hp>").unwrap() + 2).unwrap();
        let hit = find_def_rename_conflict_in_closure(&hero2, &text2, &sym2, "mp", &reader)
            .expect("域位相交冲突");
        assert_eq!(hit.surface, "Properties");
        assert!(hit.file_path.as_deref().unwrap().ends_with("Monster.def"));
    }

    // ---- COV-039: direct calls into defensive/boundary arms and workspace fixtures -----

    #[test]
    fn cov_utf16_map_interior_and_identifier_empty() {
        // 83: a byte offset inside a multi-byte char clamps to that char's UTF-16
        // start (defensive face direct call).
        let map = Utf16Map::new("a中b");
        let mid = "a中b".find('中').unwrap() + 1;
        assert_eq!(map.to_u16(mid), 1);
        assert_eq!(map.to_u16(0), 0);
        // 162: empty text / no word at the offset → None.
        assert_eq!(find_identifier_at_offset(&[], 0), None);
        let blanks: Vec<u16> = "  ".encode_utf16().collect();
        assert_eq!(find_identifier_at_offset(&blanks, 0), None);
    }

    #[test]
    fn cov_tag_self_closing_and_miss_faces() {
        // 203: self-closing element's close span is empty → close range None, edits
        // contain only the open range.
        // Note: the Rust tokenizer's recover mode directly discards the `< hp>`/
        // `</ hp>` whitespace forms (measured: the Properties child keeps only the
        // inner Type), so get_tag_name_range's whitespace-skip arms (213/214/218/219)
        // are unreachable in the Rust input space — structural slack in the same
        // class as 209/223/228.
        let self_closing = "<root>\n  <Properties>\n    <mp/>\n  </Properties>\n</root>\n";
        let sym = resolve_rename_symbol_at_offset(self_closing, self_closing.find("mp").unwrap())
            .expect("自闭合属性可解析");
        assert_eq!(sym.kind, "property");
        assert_eq!(sym.name, "mp");
        assert_eq!(collect_rename_edits_in_text(self_closing, &sym).len(), 1);
        // 267: hit outside Properties/method sections → None; 478: no hit anywhere → None.
        let odd = "<root>\n  <Unknown>\n    <zz/>\n  </Unknown>\n</root>\n";
        assert_eq!(
            resolve_rename_symbol_at_offset(odd, odd.find("zz").unwrap()),
            None
        );
        assert_eq!(
            resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("</root>").unwrap()),
            None
        );
    }

    #[test]
    fn cov_flags_element_child_and_reference_faces() {
        // 375: Flags section holding an element child (not text) → find_map None
        // takes the empty-flags face.
        let odd_flags = "<root>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n      <Flags><BASE_AND_CLIENT/></Flags>\n    </hp>\n  </Properties>\n</root>\n";
        let hit = resolve_rename_symbol_at_offset(odd_flags, odd_flags.find("<hp>").unwrap() + 2)
            .expect("元素形态 Flags 仍可解析");
        assert_eq!(hit.name, "hp");
        // 498: Parent mixed content skips non-text/non-element nodes; 526: empty
        // wrapper skipped.
        let sem_text = "<root>\n  <Parent><!--c--><Base/></Parent>\n  <Interfaces>\n    <Interface/>\n    <Interface>IFoo</Interface>\n  </Interfaces>\n</root>\n";
        let sem = parse_def_file_semantics(sem_text).expect("语义面可解析");
        assert_eq!(sem.parent_name.as_deref(), Some("Base"));
        assert_eq!(sem.interface_names, vec!["IFoo".to_string()]);
    }

    #[test]
    fn cov_root_walk_classify_list_and_component_parent() {
        // 580: no entities.xml walking up to the filesystem root → None (tmp's
        // depth of 3 hops suffices).
        let lonely = tmp_workspace("lonely", &[("entity_defs/Hero.def", HERO_DEF)]);
        assert_eq!(
            find_entity_defs_root_from_file(&lonely.join("entity_defs/Hero.def")),
            None
        );
        // 600: target not in the defs_root subtree → strip_prefix fails, category
        // stays Entity.
        let other_root = tmp_workspace("other", &[("elsewhere/Monster.def", HERO_DEF)]);
        let entry = classify_def_file(
            &lonely.join("entity_defs"),
            &other_root.join("elsewhere/Monster.def"),
        );
        assert_eq!(entry.category, DefOwnerCategory::Entity);
        // 615: recursively enumerating a nonexistent directory → empty.
        assert!(list_def_files_recursive(&lonely.join("nope")).is_empty());
        // 655: a Component-category Parent resolves into the components/ subdirectory.
        let comp_path = lonely.join("entity_defs/components/Slot.def");
        std::fs::create_dir_all(comp_path.parent().unwrap()).unwrap();
        std::fs::write(&comp_path, "<root>\n  <Parent>Base</Parent>\n</root>\n").unwrap();
        let comp = classify_def_file(&lonely.join("entity_defs"), &comp_path);
        assert_eq!(comp.category, DefOwnerCategory::Component);
        let sem = parse_def_file_semantics("<root>\n  <Parent>Base</Parent>\n</root>\n").unwrap();
        let links = resolve_link_paths(&lonely.join("entity_defs"), &comp, &sem);
        assert_eq!(
            links.parent_path,
            Some(lonely.join("entity_defs/components/Base.def"))
        );
    }

    #[test]
    fn cov_owner_closure_skip_arms() {
        // 683: start file unreadable; 686: content has no root element; 695:
        // dangling Parent reference produces no edge.
        let root = tmp_workspace("closure", &[("entity_defs/Hero.def", HERO_DEF)]);
        let defs = root.join("entity_defs");
        let hero = classify_def_file(&defs, &defs.join("Hero.def"));
        let mut index = std::collections::BTreeMap::new();
        index.insert(hero.file_path.clone(), hero.clone());
        let none_reader: CrossFileReader = &|_: &Path| None;
        assert!(collect_owner_closure(&hero, &defs, &index, none_reader).is_empty());
        let garbage_reader: CrossFileReader = &|_: &Path| Some("garbage".to_string());
        assert!(collect_owner_closure(&hero, &defs, &index, garbage_reader).is_empty());
        let dangling_reader: CrossFileReader = &|p: &Path| {
            if p.ends_with("Hero.def") {
                Some("<root>\n  <Parent>Ghost</Parent>\n</root>\n".to_string())
            } else {
                None
            }
        };
        assert!(collect_owner_closure(&hero, &defs, &index, dangling_reader).is_empty());
    }

    #[test]
    fn cov_collect_compute_and_corpus_edges() {
        // 715/1022: rootless text face → empty; 771: invalid new name → empty edits.
        let sym =
            resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("<hp>").unwrap() + 2).unwrap();
        assert!(collect_rename_edits_in_text("", &sym).is_empty());
        assert!(member_names_of("").is_empty());
        let hero_path = tmp_workspace("edges", &[("entity_defs/Hero.def", HERO_DEF)])
            .join("entity_defs/Hero.def");
        let fs_reader: CrossFileReader = &|p: &Path| std::fs::read_to_string(p).ok();
        assert!(compute_def_rename_edits(&hero_path, HERO_DEF, &sym, "1bad", fs_reader).is_empty());
        // 991: corpus directory missing → empty collection; 997: non-UTF-8 file
        // names skipped.
        let corpus_root = tmp_workspace("corpus", &[]);
        assert!(collect_def_corpus(&corpus_root).is_empty());
        let first = kode_parser::json::PARITY_CORPORA[0];
        let dir = corpus_root.join(first);
        std::fs::create_dir_all(&dir).unwrap();
        // The non-UTF-8 file-name arm is only constructible on Linux: Windows has
        // no unix byte-name API, and macOS APFS rejects non-UTF-8 file names
        // (write always fails; verified by the 2026-11-19 nightly darwin run
        // where the unwrap blew up); the corpus.len()==1 assertion is equally
        // true on all sides, kept unconditional.
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::ffi::OsStrExt;
            let bad = std::ffi::OsStr::from_bytes(b"\xff\xfe.def");
            std::fs::write(dir.join(bad), "<root/>").unwrap();
        }
        std::fs::write(
            dir.join("ok.def"),
            "<root>\n  <Properties>\n    <hp/>\n  </Properties>\n</root>\n",
        )
        .unwrap();
        let corpus = collect_def_corpus(&corpus_root);
        assert_eq!(corpus.len(), 1, "只收合法文件名 def: {corpus:?}");
    }

    #[test]
    fn cov_workspace_loop_skip_arms() {
        // 795: the compute loop skips the target itself; 856: an ancestor def with
        // a bad XML root (None) is skipped;
        // 866: a def that is neither ancestor nor descendant is skipped in the
        // conflict loop; the descendant arm is exercised.
        let hero_text = "<root>\n  <Parent>Base</Parent>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n    </hp>\n  </Properties>\n</root>\n";
        let alien_text = "<root>\n  <Parent>Hero</Parent>\n  <Properties>\n    <zz9>\n      <Type>UINT32</Type>\n      <Flags><BASE_AND_CLIENT/></Flags>\n    </zz9>\n  </Properties>\n</root>\n";
        let root = tmp_workspace(
            "loops",
            &[
                ("entities.xml", "<root/>"),
                ("entity_defs/Hero.def", hero_text),
                ("entity_defs/Base.def", "not xml <<<"),
                (
                    "entity_defs/Ghost2.def",
                    "<root>\n  <Properties>\n    <mana>UINT32</mana>\n  </Properties>\n</root>\n",
                ),
                ("entity_defs/Alien.def", alien_text),
            ],
        );
        let hero = root.join("entity_defs/Hero.def");
        let text = std::fs::read_to_string(&hero).unwrap();
        let sym = resolve_rename_symbol_at_offset(&text, text.find("<hp>").unwrap() + 2).unwrap();
        let fs_reader: CrossFileReader = &|p: &Path| std::fs::read_to_string(p).ok();
        let edits = compute_def_rename_edits(&hero, &text, &sym, "mp2", fs_reader);
        assert!(
            edits.iter().any(|e| e.file_path.ends_with("Hero.def")),
            "目标文件自身编辑在场: {edits:?}"
        );
        // 856: the ancestor Base with bad XML is skipped; Alien (descendant) has a
        // zz9 method and an hp property face of different kinds, member_conflicts
        // does not bite → no conflict.
        assert!(
            find_def_rename_conflict_in_closure(&hero, &text, &sym, "zz9", fs_reader).is_none(),
            "无占用冲突"
        );
    }
}
