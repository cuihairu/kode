//! definition response chain (Phase2 first slice, book §17 PR-010 definition
//! face / LSP series).
//!
//! Face = **corpus declaration landing spot**: UTF-16 position → word → LSP
//! Location at the declaration. Reuses hover's location infrastructure
//! (word_at) and the HoverEngine corpus view (pure memory, zero IO, ARCH-012
//! red line same as hover). Landing discipline for the four document kinds:
//! - `.def`: layer-by-layer isomorphic to the TS F12 provider chain's
//!   **landing semantics** —
//!   (1) `<DetailLevel>` value word → this file's `<DetailLevels>` level
//!   declaration line;
//!   (2) `Properties` section declaration words → null (withdrawn by the
//!   2026-11-17 regression, same discipline as the three method sections: the
//!   TS F12 property chain's script-implementation layer goes first and the
//!   registry fall-back is TS's last tier; if Rust landed the registry it would
//!   short-circuit the script layer = def cannot jump to the py implementation);
//!   (3) the three method sections' declaration words → null (2026-11-08 demo
//!   acceptance face: the TS next layer = py implementation / def call chain,
//!   Rust does not fabricate landing spots, the service track falls back to TS);
//!   (4) `<Parent>` value word → first line of the parent/interface/component
//!   def file in the corpus (missing → null, never fabricated);
//!   (5) `<Type>`/`<of>` value words → the corpus types.xml declaration line
//!   (builtin types have no definition file, null); (6) `Components` section
//!   declaration words → null (the tail of the TS provider chain is likewise
//!   null, no one-sided enhancement). The property declaration word's Python
//!   script layer and database schema layer are faces Rust has no capability
//!   for (.py face / DB snapshot), null falls back to the full TS chain, no
//!   fabricated landing spots.
//! - `entities.xml`: registry entry word → first line of the same-named def
//!   file in the corpus (same discipline as TS findEntityDefinitionFile);
//! - `types.xml`/`alias.xml`: declaration word → this file's declaration line
//!   (same discipline as TS findCustomTypeDefinition, landing = line start).
//!
//! Remaining differences honestly assigned (Phase2 first-slice boundary,
//! docs/kode2/phase2-slice-a.md §face definitions): the Python script landings,
//! database schema virtual documents, and kbe stubs within the full TS F12
//! surface; the Rust corpus face always nulls and falls back to TS. The Phase2
//! first slice once assigned the difference as "402 declaration-word probes, 401
//! hits / 1 divergence = property-chain script layer"; after the 2026-11-17 user
//! report of the def cannot-jump-to-py-implementation regression it was
//! withdrawn: property declaration words null and fall back to the full TS
//! chain, the script-layer divergence eliminated (golden regenerated in sync).
//!
//! RUST-137 batch 1 (2026-11-16) corpus face completion (the pure-corpus half
//! of TS findDefinitionReferenceInDef fully sunk, zero-IO red line kept):
//! - `<Arg>` value word → first line of the same-named entity def in the corpus
//!   (isomorphic to TS isPositionInsideTagValue 'Arg' + findEntityDefinitionFile;
//!   only a unique candidate scoped by root lands, ambiguity → null);
//! - a word over any element span inside the `<Interfaces>` section → first line
//!   of `<defs_root>/interfaces/<word>.def` (isomorphic to TS
//!   isPositionInsideChildTag + findDefinitionFileByCategory('interface'); TS
//!   interfacesRoot = entityDefsRoot/interfaces single rule);
//! - types.xml miss fallback for `<Type>`/`<of>` value words: component def →
//!   entity def (corpus-ization of TS findTypeValueDefinitionReference's order
//!   type entry → component → entity; components = defs_root/components
//!   directory existence);
//! - the `<Type>` value word face of `types.xml` (isomorphic to TS
//!   findTypeValueDefinitionInTypesXml, no gate): this file's top-level
//!   declaration line → component/entity fallback; the implementedBy value-word
//!   face (py symbol lines) remains a capability boundary, null falls back to TS;
//! - gate alignment: the looksLikeEntityName at the top of TS
//!   findDefinitionReferenceInDef (non-builtin && leading uppercase) uniformly
//!   rejects the four arms Parent/Type/Arg/Interfaces — the pre-existing
//!   Parent/Type arms are now gated the same way (lowercase words produce null
//!   in TS; the earlier one-sided landing was an enhancement, withdrawn this
//!   batch for alignment; golden regeneration audit showed no unexpected diff).
//!
//! Product-face facts: TS registers only DefinitionProvider (config/def/def +
//! corpus/python four routes, activate/languageServices.ts), no separate
//! Declaration/TypeDefinition provider; ledger LSP-004's three method names
//! converge per product reality to the single definition-method full chain.
//! Method-section/property-section declaration words are always null (full TS
//! chain: script-implementation layer first, registry fall-back is TS's last
//! tier); golden probes carry columns (Type/of, Arg value words at the word's
//! first column; Interfaces at the tag's `<` column), so position-judged arms
//! really trigger in the golden context.

use kode_index::symbol::extract_records;
use kode_parser::dep::{file_kind_of_uri, FileKind, ParsedUnit};
use kode_parser::diag::LineMap;
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};
use kode_parser::xml;
use kode_vfs::store::DocumentKey;

use crate::hover::{category_of, word_at, Category, HoverEngine};

// ---------------------------------------------------------------------------
// Response model (same shape as LSP Location; serde camelCase shares keys with the TS parity face)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

/// One definition landing: target file + range (declaration-name span or the file's first line).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DefinitionLocation {
    pub uri: String,
    pub range: LspRange,
}

/// Byte offset → LSP 0-based (line, UTF-16 character) (same semantics as VS Code
/// positionAt: lines split on `\n`, `\r` counted as an in-line character).
pub(crate) fn byte_offset_to_position(text: &str, offset: usize) -> LspPosition {
    let offset = offset.min(text.len());
    let mut line = 0u32;
    let mut line_start = 0usize;
    for (idx, ch) in text.char_indices() {
        if idx >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            line_start = idx + 1;
        }
    }
    let character: u32 = text[line_start..offset]
        .chars()
        .map(|c| c.len_utf16() as u32)
        .sum();
    LspPosition { line, character }
}

/// 1-based line number (of the declaration) → line-start landing (same shape as
/// TS `new Position(line - 1, 0)`).
pub(crate) fn line_start_location(uri: &str, line1: usize) -> DefinitionLocation {
    let pos = LspPosition {
        line: line1 as u32 - 1,
        character: 0,
    };
    DefinitionLocation {
        uri: uri.to_string(),
        range: LspRange {
            start: pos.clone(),
            end: pos,
        },
    }
}

/// File first-line landing (same shape as TS `Location(uri, Position(0, 0))`).
pub(crate) fn file_head_location(uri: &str) -> DefinitionLocation {
    line_start_location(uri, 1)
}

// ---------------------------------------------------------------------------
// Response chain (reuses the HoverEngine corpus view)
// ---------------------------------------------------------------------------

impl HoverEngine {
    /// Interaction entry: UTF-16 position → word → declaration landing.
    /// Unopened / unknown word is always None (LSP permits it), no error, no block.
    pub fn definition(
        &self,
        key: &DocumentKey,
        text: &str,
        line: u32,
        character: u32,
    ) -> Option<DefinitionLocation> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let word = word_at(text, line, character)?;
        self.definition_word(key, text, &word, line as usize + 1, line, character)
    }

    /// Declaration-line entry (for golden generation): declaration line number
    /// (1-based) + word → landing.
    pub fn definition_at_line(
        &self,
        key: &DocumentKey,
        text: &str,
        line1: usize,
        word: &str,
    ) -> Option<DefinitionLocation> {
        self.definition_at_position(key, text, line1, 0, word)
    }

    /// Declaration line + column entry (for golden generation; since RUST-137
    /// batch 1, position-judged probes carry the word's first column, so the
    /// `<Type>`/`<of>`/`<Arg>`/`<Interfaces>` arms really trigger in the golden
    /// context).
    pub fn definition_at_position(
        &self,
        key: &DocumentKey,
        text: &str,
        line1: usize,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let line0 = line1 as u32 - 1;
        self.definition_word(key, text, word, line1, line0, character)
    }

    fn definition_word(
        &self,
        key: &DocumentKey,
        text: &str,
        word: &str,
        line1: usize,
        line0: u32,
        character: u32,
    ) -> Option<DefinitionLocation> {
        let path = key.uri.as_path();
        match file_kind_of_uri(&key.uri) {
            FileKind::Def => {
                let def = parse_def(text);
                // (1) `<DetailLevel>` value word → this file's `<DetailLevels>`
                // level declaration line (same discipline as TS
                // findDetailLevelDefinitionInDef; outside the gate, the TS
                // production chain's first arm lands at the same spot).
                if let Some(pos) = self.detail_level_landing(text, path, line0, character) {
                    return Some(pos);
                }
                // gate domain (TS findDefinitionReferenceInDef's top-level
                // looksLikeEntityName rejects the same way: Parent/Type/Arg/
                // Interfaces four arms; builtin types and lowercase words → null).
                let gate = looks_like_entity_name(word);
                // (2) `<Parent>` value word → first line of the parent def in the
                // corpus (the interface/component directory rules come from the
                // same source as chain_face; a missing corpus → null).
                if gate {
                    if let Some(parent) = def.parent.as_deref().filter(|p| !p.is_empty()) {
                        if word == parent {
                            if let Some(pos) = self.parent_landing(path, word) {
                                return Some(pos);
                            }
                        }
                    }
                    // (3) `<Type>`/`<of>` value words → the corpus types declaration
                    // line (builtin → null); on miss, fall back to
                    // component/entity def (RUST-137 batch 1).
                    if let Some(pos) = self.type_value_landing(key, text, line0, character, word) {
                        return Some(pos);
                    }
                }
                // (4) In-section declaration words: Properties and the three method
                // sections' declaration words are always null (capability boundary:
                // the py script layer / def call chain is a TS face, Rust does not
                // fabricate landings, the service track falls back to TS for the py
                // implementation landing — demo def-to-cell/base/client acceptance
                // face; withdrawn by the 2026-11-17 regression: properties used to
                // land on the registry line, short-circuiting the TS F12 property
                // chain's script-implementation layer = def could not jump to the py
                // implementation); the Components section lands at the tail of the TS
                // provider chain which returns null, no landing produced (no
                // one-sided enhancement).
                let (records, _) = extract_records(key, &ParsedUnit::Def(parse_def(text)));
                if records.iter().any(|r| r.name == word && r.line == line1) {
                    return None;
                }
                // (5) `<Arg>` value word → first line of the entity def in the corpus
                // (RUST-137 batch 1; gate domain).
                if gate {
                    if let Some(pos) = self.arg_value_landing(key, text, line0, character, word) {
                        return Some(pos);
                    }
                    // (6) a word inside the `<Interfaces>` section → first line of the
                    // interfaces-directory def (RUST-137 batch 1; gate domain).
                    if let Some(pos) =
                        self.interfaces_segment_landing(text, path, line0, character, word)
                    {
                        return Some(pos);
                    }
                }
                None
            }
            FileKind::Entities => {
                let entities = parse_entities(text);
                let _entry = entities
                    .entities
                    .iter()
                    .find(|e| e.name == word && e.line == line1)?;
                // KBUG-ROOT: candidates are scoped by the querier's root; only a
                // unique candidate lands, same-root same-name multi-candidate
                // ambiguity is not hard-guessed as the first seen → null (the TS
                // face takes over).
                let candidates = self.def_candidates(key.root, word);
                let def_path = if candidates.len() == 1 {
                    Some(&candidates[0])
                } else {
                    None
                }?;
                Some(file_head_location(def_path))
            }
            FileKind::Types => {
                let types = parse_types(text);
                if let Some(decl) = types
                    .types
                    .iter()
                    .find(|t| t.name == word && t.line == line1)
                {
                    // RUST-137 batch 4 reverse edge (the return leg of the
                    // `.def`↔types.xml bidirection): declaration words no longer do a
                    // useless self-jump — land on the first consumer site in the
                    // corpus (the `Type/Arg/of` value usage face, scanned from the
                    // same source as semantic_reference_locations, the semantics face
                    // excludes cross-root same-name different-declaration Shadows by
                    // the same discipline; first hit in path order, in-file reference
                    // spots are not chosen, the consumer site is in a .def). With no
                    // corpus consumer, fall back to this file's declaration line (the
                    // original self-jump behavior).
                    if let Some(consumer) = self
                        .semantic_reference_locations(key, text, line0, character, false)
                        .and_then(|sites| sites.into_iter().find(|loc| loc.uri != path))
                    {
                        return Some(consumer);
                    }
                    return Some(line_start_location(path, decl.line));
                }
                // RUST-137 batch 1: the `<Type>` value word face (isomorphic to TS
                // findTypeValueDefinitionInTypesXml, no gate — the TS types.xml branch
                // does not go through findDefinitionReferenceInDef): this file's
                // top-level declaration line (same discipline as
                // findCurrentDocumentCustomTypeReference; same-root types-entry chains
                // share its effect, merged) → component/entity fallback; no landing →
                // null. The implementedBy value word (py symbol lines) is a capability
                // boundary, does not trigger this arm (position judging only
                // recognizes the `<Type>` element), null falls back to TS.
                if types_type_value_at(text, line0, character) {
                    if let Some(decl) = types.types.iter().find(|t| t.name == word) {
                        return Some(line_start_location(path, decl.line));
                    }
                    return self.category_def_landing(key, word);
                }
                None
            }
            FileKind::Alias => {
                let aliases = parse_alias(text);
                let alias = aliases
                    .aliases
                    .iter()
                    .find(|a| a.name == word && a.line == line1)?;
                Some(line_start_location(path, alias.line))
            }
            FileKind::Other => None,
        }
    }

    /// Inside a `<DetailLevel>` value and the word hits this file's
    /// `<DetailLevels>` level name → line start of the level declaration line
    /// (same discipline as TS findDetailLevelDefinitionInDef).
    fn detail_level_landing(
        &self,
        text: &str,
        path: &str,
        line0: u32,
        character: u32,
    ) -> Option<DefinitionLocation> {
        let doc = xml::parse(text, false);
        let root = doc.root()?;
        let offset = position_to_byte_offset(text, line0, character);
        let node = deepest_element_at(&doc, root, offset)?;
        if !doc.element(node).name.eq_ignore_ascii_case("DetailLevel") {
            return None;
        }
        let levels = doc
            .child_elements(root)
            .into_iter()
            .find(|&c| doc.element(c).name.eq_ignore_ascii_case("DetailLevels"))?;
        let lines = LineMap::new(text);
        let word = word_at(text, line0, character).unwrap_or_default();
        for child in doc.child_elements(levels) {
            let el = doc.element(child);
            // Level text only lands when the word hits (same discipline as TS's
            // word-equality judgment).
            if el.name == word {
                // line_of is a 1-based line number; line_start_location already
                // converts to the 0-based LSP line, so do not +1 again
                // (otherwise the landing drifts to the next line).
                return Some(line_start_location(path, lines.line_of(el.name_span.start)));
            }
        }
        None
    }

    /// `<Parent>` value → first line of the parent def in the corpus. The
    /// directory rules share a source with chain_face: an interface file's parent
    /// falls back to the interfaces directory, a component slot's parent falls
    /// back to the components directory.
    fn parent_landing(&self, path: &str, parent: &str) -> Option<DefinitionLocation> {
        let defs_root = self.defs_root(path)?;
        let parent_dir = match category_of(&defs_root, path) {
            Category::Component => format!("{defs_root}/components"),
            _ => defs_root,
        };
        let parent_path = format!("{parent_dir}/{parent}.def");
        if !self.corpus_defs.contains(&parent_path) {
            return None;
        }
        Some(file_head_location(&parent_path))
    }

    /// Position (UTF-16) inside a `<Type>`/`<of>` value and the word hits a type
    /// name → corpus types.xml declaration line-start landing. Builtin types have
    /// no definition file (engine C++ builtins) → None; on a types miss, fall
    /// back to component/entity def (corpus-ization of TS
    /// findTypeValueDefinitionReference's order type entry → component → entity;
    /// RUST-137 batch 1, the gate is at the caller).
    fn type_value_landing(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        if is_builtin_type(word) {
            return None;
        }
        let byte_offset = position_to_byte_offset(text, line0, character);
        let doc = xml::parse(text, true);
        let root = doc.root()?;
        let node = deepest_element_at(&doc, root, byte_offset)?;
        let name = &doc.element(node).name;
        if name != "Type" && name != "of" {
            return None;
        }
        let content = doc.element(node).content_span;
        if byte_offset < content.start || byte_offset > content.end {
            return None;
        }
        // Corpus types declaration lookup: first seen in path lexicographic order
        // (same discipline as TS's corpus-order first-seen).
        for (tpath, types) in &self.types_files {
            if let Some(decl) = types.types.iter().find(|t| t.name == word) {
                return Some(line_start_location(tpath, decl.line));
            }
        }
        self.category_def_landing(key, word)
    }

    /// A word inside an `<Arg>` value → first line of the same-named entity def
    /// in the corpus (isomorphic to TS isPositionInsideTagValue 'Arg' +
    /// findEntityDefinitionFile; only a unique candidate scoped by root lands,
    /// same-root same-name ambiguity is not hard-guessed → null). The gate is at
    /// the caller (RUST-137 batch 1).
    fn arg_value_landing(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        let byte_offset = position_to_byte_offset(text, line0, character);
        let doc = xml::parse(text, true);
        let root = doc.root()?;
        let node = deepest_element_at(&doc, root, byte_offset)?;
        if doc.element(node).name != "Arg" {
            return None;
        }
        let content = doc.element(node).content_span;
        if byte_offset < content.start || byte_offset > content.end {
            return None;
        }
        let candidates = self.def_candidates(key.root, word);
        let def_path = if candidates.len() == 1 {
            Some(&candidates[0])
        } else {
            None
        }?;
        Some(file_head_location(def_path))
    }

    /// A word inside the `<Interfaces>` section (over any descendant element's
    /// span, including open/close tags) → first line of
    /// `<defs_root>/interfaces/<word>.def` in the corpus. Isomorphic to TS
    /// isPositionInsideChildTag ('Interfaces') +
    /// findDefinitionFileByCategory('interface') (TS interfacesRoot =
    /// entityDefsRoot/interfaces single rule; the fs existence check is
    /// corpus-ized into a corpus_defs judgment). The gate is at the caller
    /// (RUST-137 batch 1).
    fn interfaces_segment_landing(
        &self,
        text: &str,
        path: &str,
        line0: u32,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        let byte_offset = position_to_byte_offset(text, line0, character);
        let doc = xml::parse(text, true);
        let root = doc.root()?;
        let (_hit, chain) = deepest_element_with_chain(&doc, root, byte_offset)?;
        if !chain.iter().any(|&n| doc.element(n).name == "Interfaces") {
            return None;
        }
        let defs_root = self.entity_defs_root(path)?;
        let iface = format!("{defs_root}/interfaces/{word}.def");
        if !self.corpus_defs.contains(&iface) {
            return None;
        }
        Some(file_head_location(&iface))
    }

    /// The component/entity fallback of TS findTypeValueDefinitionReference
    /// (corpus-ized; RUST-137 batch 1): this root's `components/<word>.def` exists
    /// → the file's first line; otherwise the entity def (unique candidate scoped
    /// by root, ambiguity → null — same discipline as the entities face's
    /// def_candidates). TS findEntityDefinitionFile's semantics have already been
    /// parity-compared (the entities face is in use); the components half
    /// corresponds to findDefinitionFileByCategory ('component')'s
    /// layout.componentsRoot/<word>.def existence check.
    fn category_def_landing(&self, key: &DocumentKey, word: &str) -> Option<DefinitionLocation> {
        let path = key.uri.as_path();
        if let Some(defs_root) = self.entity_defs_root(path) {
            let comp = format!("{defs_root}/components/{word}.def");
            if self.corpus_defs.contains(&comp) {
                return Some(file_head_location(&comp));
            }
        }
        let candidates = self.def_candidates(key.root, word);
        if let [only] = candidates {
            return Some(file_head_location(only));
        }
        None
    }

    /// entity_defs root resolution (same discipline as TS layout.entityDefsRoot):
    /// files inside `entity_defs/` already have that directory via defs_root;
    /// non-def files such as types.xml get the entities directory itself from
    /// defs_root, so here it is uniformly converted to
    /// `{entities_dir}/entity_defs` (only counts if the directory exists in the
    /// corpus — the corpus has some def under it). RUST-137 batch 1.
    pub(crate) fn entity_defs_root(&self, path: &str) -> Option<String> {
        let defs_root = self.defs_root(path)?;
        if path.starts_with(&format!("{defs_root}/")) {
            return Some(defs_root.to_string());
        }
        let candidate = format!("{defs_root}/entity_defs");
        if self
            .corpus_defs
            .iter()
            .any(|p| p.starts_with(&format!("{candidate}/")))
        {
            Some(candidate)
        } else {
            None
        }
    }
}

/// Isomorphic to TS looksLikeEntityName: non-builtin type && ASCII uppercase
/// first letter, remaining units ASCII letters/digits/underscore (the gate
/// domain = rejected the same way at the top of TS findDefinitionReferenceInDef;
/// since RUST-137 batch 1 the pre-existing Parent/Type arms also hang the same
/// gate for alignment).
pub(crate) fn looks_like_entity_name(word: &str) -> bool {
    if is_builtin_type(word) {
        return false;
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Position judgment inside the value of a types.xml `<Type>` element
/// (isomorphic to TS isPositionInsideTagValue 'Type'; recognizes only the exact
/// `Type` name — the implementedBy value does not trigger). RUST-137 batch 1.
fn types_type_value_at(text: &str, line0: u32, character: u32) -> bool {
    let byte_offset = position_to_byte_offset(text, line0, character);
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return false;
    };
    let Some(node) = deepest_element_at(&doc, root, byte_offset) else {
        return false;
    };
    if doc.element(node).name != "Type" {
        return false;
    }
    let content = doc.element(node).content_span;
    byte_offset >= content.start && byte_offset <= content.end
}

/// Builtin type table (same table as TS kbengineMetadata::KBENGINE_TYPES,
/// ARRAY/FIXED_DICT containers included).
pub(crate) const BUILTIN_TYPES: &[&str] = &[
    "UINT8",
    "UINT16",
    "UINT32",
    "UINT64",
    "INT8",
    "INT16",
    "INT32",
    "INT64",
    "FLOAT",
    "DOUBLE",
    "STRING",
    "UNICODE",
    "VECTOR2",
    "VECTOR3",
    "VECTOR4",
    "ENTITYCALL",
    "PYTHON",
    "PY_DICT",
    "PY_TUPLE",
    "PY_LIST",
    "BLOB",
    "ARRAY",
    "FIXED_DICT",
];

pub(crate) fn is_builtin_type(name: &str) -> bool {
    BUILTIN_TYPES.contains(&name)
}

/// UTF-16 (line, character) → byte offset (clamps to line end / end of text, no panic).
pub(crate) fn position_to_byte_offset(text: &str, line0: u32, character: u32) -> usize {
    let lines = LineMap::new(text);
    let line_index = (line0 as usize).min(lines.line_count() - 1);
    let line_start = line_start_of(text, line_index);
    let line_end = text[line_start..]
        .find('\n')
        .map(|n| line_start + n)
        .unwrap_or(text.len());
    let mut utf16 = 0u32;
    for (idx, ch) in text[line_start..line_end].char_indices() {
        if utf16 >= character {
            return line_start + idx;
        }
        utf16 += ch.len_utf16() as u32;
    }
    line_end
}

fn line_start_of(text: &str, line_index: usize) -> usize {
    let mut line = 0usize;
    if line == line_index {
        return 0;
    }
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            line += 1;
            if line == line_index {
                return idx + 1;
            }
        }
    }
    text.len()
}

/// Depth-first search for the deepest element containing the byte offset
/// (offset within [open_span.start, close_span.end]).
fn deepest_element_at(doc: &xml::Document, node: usize, offset: usize) -> Option<usize> {
    let data = doc.element(node);
    if offset < data.open_span.start || offset > data.close_span.end {
        return None;
    }
    for &child in &data.children {
        if let NodeHit::Element(found) = probe_node(doc, child, offset) {
            if let Some(deeper) = deepest_element_at(doc, found, offset) {
                return Some(deeper);
            }
            return Some(found);
        }
    }
    Some(node)
}

/// Same as deepest_element_at, with the root→self ancestor chain attached
/// (element-node order; the same domain as TS findAncestorElement's
/// self-inclusive ancestor judgment). RUST-137 batch 1 (`<Interfaces>`
/// section judgment).
pub(crate) fn deepest_element_with_chain(
    doc: &xml::Document,
    node: usize,
    offset: usize,
) -> Option<(usize, Vec<usize>)> {
    let data = doc.element(node);
    if offset < data.open_span.start || offset > data.close_span.end {
        return None;
    }
    for &child in &data.children {
        if let NodeHit::Element(found) = probe_node(doc, child, offset) {
            let (hit, chain) =
                deepest_element_with_chain(doc, found, offset).unwrap_or((found, vec![found]));
            let mut full = vec![node];
            full.extend(chain);
            return Some((hit, full));
        }
    }
    Some((node, vec![node]))
}

enum NodeHit {
    Element(usize),
    Miss,
}

fn probe_node(doc: &xml::Document, node: usize, offset: usize) -> NodeHit {
    match &doc.nodes[node].data {
        xml::NodeData::Element(data) => {
            if offset >= data.open_span.start && offset <= data.close_span.end {
                NodeHit::Element(node)
            } else {
                NodeHit::Miss
            }
        }
        _ => NodeHit::Miss,
    }
}

// ---------------------------------------------------------------------------
// Parity golden (write-only; the TS side tests/kodeDefinitionParity.test.ts recomputes)
// ---------------------------------------------------------------------------

/// Golden file name (repo-relative).
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/definition-parity.json";

#[derive(Debug, serde::Serialize)]
struct GoldenDefinition {
    line: usize,
    character: u32,
    word: String,
    definition: DefinitionLocation,
}

/// Golden probes: (1-based line, UTF-16 column, word). Position-judged arms
/// (Type/of, Arg value words, Interfaces-section words) carry the word's/tag's
/// first column; word-compared arms (Parent, declaration words) use column = 0.
#[derive(Debug, Clone, PartialEq, Eq)]
struct GoldenProbe {
    line: usize,
    character: u32,
    word: String,
}

/// Probe of the first token of an element's text content (word-start line/column;
/// TS mirror `getElementText(node).trim().split(/\s+/)[0]` + the same
/// contentStart leading-whitespace arithmetic).
fn value_token_probe(doc: &xml::Document, node: usize, text: &str) -> Option<GoldenProbe> {
    let el = doc.element(node);
    let content = text.get(el.content_span.start..el.content_span.end)?;
    let trimmed = content.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let token_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let lead = content.len() - trimmed.len();
    let pos = byte_offset_to_position(text, el.content_span.start + lead);
    Some(GoldenProbe {
        line: pos.line as usize + 1,
        character: pos.character,
        word: trimmed[..token_end].to_string(),
    })
}

/// Pre-order walk over all element nodes (text nodes not recursed).
fn walk_elements(doc: &xml::Document, node: usize, visit: &mut impl FnMut(usize)) {
    visit(node);
    for &child in &doc.element(node).children {
        if matches!(doc.nodes[child].data, xml::NodeData::Element(_)) {
            walk_elements(doc, child, visit);
        }
    }
}

/// Probe ordering ((line, column, word) total order; TS mirror same keys) +
/// dedup of adjacent equal items.
fn order_probes(mut probes: Vec<GoldenProbe>) -> Vec<GoldenProbe> {
    probes.sort_by(|a, b| (&a.line, &a.character, &a.word).cmp(&(&b.line, &b.character, &b.word)));
    probes.dedup();
    probes
}

#[derive(Debug, serde::Serialize)]
struct GoldenFile {
    file: String,
    kind: String,
    definitions: Vec<GoldenDefinition>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    definition_count: usize,
    files: Vec<GoldenFile>,
}

/// Definition golden JSON for the whole corpus (per file: declaration symbols +
/// Parent/Type value probes).
pub fn dump_definition_golden(repo_root: &std::path::Path) -> String {
    use kode_parser::json::{collect_corpus, PARITY_CORPORA};

    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let registry = crate::golden_corpus::corpus_registry();
    let mut engine = HoverEngine::new();
    // Load everything first (lexicographic order = TS corpus order; keys = each
    // corpus project root, KBUG-ROOT isolation).
    for (path, (_kind, text)) in &files {
        engine.update(crate::golden_corpus::corpus_key(&registry, path), text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-definition-golden",
        file_count: files.len(),
        definition_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        let key = crate::golden_corpus::corpus_key(&registry, path);
        let mut probes: Vec<GoldenProbe> = Vec::new();
        match *kind {
            "def" => {
                let def = parse_def(text);
                if let Some(parent) = &def.parent {
                    if !parent.is_empty() {
                        // Probe line = the line where `<Parent>` appears (value-word
                        // trigger face; word-compared arm, column 0).
                        if let Some(idx) = text.lines().position(|l| l.contains(parent)) {
                            probes.push(GoldenProbe {
                                line: idx + 1,
                                character: 0,
                                word: parent.clone(),
                            });
                        }
                    }
                }
                let unit = ParsedUnit::Def(parse_def(text));
                let (records, _) = extract_records(&key, &unit);
                for record in &records {
                    probes.push(GoldenProbe {
                        line: record.line,
                        character: 0,
                        word: record.name.clone(),
                    });
                }
                // RUST-137 batch 1 position-judged probes: whole-tree
                // `<Type>`/`<of>`/`<Arg>` value words + the content-first word of
                // elements inside the `<Interfaces>` section (word-start line/column;
                // the production trigger face is the value word, not the element
                // name) — the pre-existing property Type word probe (declaration line
                // + column 0) is replaced by this collection, so the type-landing
                // face really triggers in the golden context.
                let doc = xml::parse(text, true);
                if let Some(root) = doc.root() {
                    let mut value_tags: Vec<usize> = Vec::new();
                    let mut interface_segments: Vec<usize> = Vec::new();
                    walk_elements(
                        &doc,
                        root,
                        &mut |node| match doc.element(node).name.as_str() {
                            "Type" | "of" | "Arg" => value_tags.push(node),
                            "Interfaces" => interface_segments.push(node),
                            _ => {}
                        },
                    );
                    for node in value_tags {
                        if let Some(probe) = value_token_probe(&doc, node, text) {
                            probes.push(probe);
                        }
                    }
                    for segment in interface_segments {
                        // Production arm semantics = the value word (cursor on ROLE in
                        // `<interface> ROLE </interface>`, F12 word=ROLE); the probe
                        // takes the content-first word of in-section elements — the
                        // element name itself (interface, lowercase) would be rejected
                        // by the gate, not a production trigger face.
                        walk_elements(&doc, segment, &mut |inner| {
                            if inner != segment {
                                if let Some(probe) = value_token_probe(&doc, inner, text) {
                                    probes.push(probe);
                                }
                            }
                        });
                    }
                }
            }
            "entities" => {
                for entry in parse_entities(text).entities {
                    probes.push(GoldenProbe {
                        line: entry.line,
                        character: 0,
                        word: entry.name,
                    });
                }
            }
            "types" => {
                for decl in parse_types(text).types {
                    // RUST-137 batch 4: declaration-word probes upgraded to the
                    // word's first column (batch 1 ruling: position-judged faces must
                    // really trigger). Column 0 lands on `<`, where the semantics-face
                    // symbol resolution fails and only the fallback arm runs; the
                    // word's first column (the element name's first character) is
                    // what triggers the reverse-edge arm.
                    let character = text
                        .lines()
                        .nth(decl.line - 1)
                        .and_then(|l| {
                            let idx = l.find('<')?;
                            Some(
                                l[..idx + 1]
                                    .chars()
                                    .map(|c| c.len_utf16() as u32)
                                    .sum::<u32>(),
                            )
                        })
                        .unwrap_or(0);
                    probes.push(GoldenProbe {
                        line: decl.line,
                        character,
                        word: decl.name,
                    });
                }
                // RUST-137 batch 1: whole-tree `<Type>` value-word probes (nested
                // FIXED_DICT fields; word-start line/column,
                // findTypeValueDefinitionInTypesXml trigger face).
                let doc = xml::parse(text, true);
                if let Some(root) = doc.root() {
                    walk_elements(&doc, root, &mut |node| {
                        if doc.element(node).name == "Type" {
                            if let Some(probe) = value_token_probe(&doc, node, text) {
                                probes.push(probe);
                            }
                        }
                    });
                }
            }
            "alias" => {
                for alias in parse_alias(text).aliases {
                    probes.push(GoldenProbe {
                        line: alias.line,
                        character: 0,
                        word: alias.name,
                    });
                }
            }
            _ => {}
        }
        let probes = order_probes(probes);
        let mut definitions = Vec::new();
        for probe in probes {
            if let Some(definition) =
                engine.definition_at_position(&key, text, probe.line, probe.character, &probe.word)
            {
                definitions.push(GoldenDefinition {
                    line: probe.line,
                    character: probe.character,
                    word: probe.word,
                    definition,
                });
            }
        }
        dump.definition_count += definitions.len();
        dump.files.push(GoldenFile {
            file: path.clone(),
            kind: kind.to_string(),
            definitions,
        });
    }
    serde_json::to_string(&dump).expect("serialize definition golden")
}
