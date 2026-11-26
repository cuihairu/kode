//! RUST-139 batch 1: def document-symbol (Outline) corpus face -- Properties/the three method sections become
//! container symbols and declarations within a section become child symbols, point-for-point isomorphic with TS KBEngineDocumentSymbolProvider
//! (IDE-NAV-005, src/languageProviders/references.ts).
//!
//! Semantic pins (TS-isomorphic):
//! - Only Properties/BaseMethods/CellMethods/ClientMethods four sections are emitted (after toSectionName
//!   exact-matches the 8 canonical names, filtered by DEF_SYMBOL_SECTIONS; Parent/Interfaces/
//!   Components/Volatile and unknown sections do not enter the Outline);
//! - Section symbol kind = Properties->Struct / method sections->Class; the **direct** element children within a section
//!   = Properties->Field / method sections->Method (no deeper descent into members: TS `new
//!   DocumentSymbol` defaults children=[], so <Arg> etc. inside methods produce no symbols);
//! - range = the element's full span (open-tag start -> closing-tag end; self-closing ends at the open tag's end),
//!   selectionRange = the open-tag span containing the name (always ⊆ range);
//! - detail is always the empty string, order = document order; parse with no root -> None.
//!
//! WorkspaceSymbol (IDE-NAV-006) depends on the entityMapping runtime semantic index
//! (ResolvedDefinitionSemantics inheritance chain / component rebase), left to batch 2; in the meantime the production
//! serving face is still TS; this module lands only the pure library (same boundary as references.rs batch 1).

use kode_parser::xml::{self, NodeData};

use crate::definition::{byte_offset_to_position, LspRange};

/// LSP DocumentSymbol kind (string face, same shape as the TS `vscode.SymbolKind` enum names;
/// golden/mirror compares on these strings; protocol numeric mapping is a TS provider projection detail).
pub const SYMBOL_KIND_STRUCT: &str = "Struct";
pub const SYMBOL_KIND_CLASS: &str = "Class";
pub const SYMBOL_KIND_FIELD: &str = "Field";
pub const SYMBOL_KIND_METHOD: &str = "Method";

/// Isomorphic with TS `toSectionName`: exact match on the 8 canonical section names (case-sensitive, lowercase variants do not count).
fn to_section_name(name: &str) -> Option<&str> {
    match name {
        "Parent" | "Interfaces" | "Components" | "Properties" | "BaseMethods" | "CellMethods"
        | "ClientMethods" | "Volatile" => Some(name),
        _ => None,
    }
}

/// Isomorphic with TS `DEF_SYMBOL_SECTIONS`: the four sections entering the Outline.
fn is_symbol_section(section: &str) -> bool {
    matches!(
        section,
        "Properties" | "BaseMethods" | "CellMethods" | "ClientMethods"
    )
}

/// One document symbol: name / empty detail / kind / full span / open-tag selection span / child symbols.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DocumentSymbolFace {
    pub name: String,
    pub detail: String,
    pub kind: &'static str,
    pub range: LspRange,
    #[serde(rename = "selectionRange")]
    pub selection_range: LspRange,
    pub children: Vec<DocumentSymbolFace>,
}

/// def text -> Outline symbol tree. Parse with no root -> None (same shape as TS parseDefAst failing to null).
pub fn document_symbols(text: &str) -> Option<Vec<DocumentSymbolFace>> {
    let doc = xml::parse(text, true);
    let root = doc.root()?;
    let mut symbols = Vec::new();
    for &child in &doc.element(root).children {
        if !matches!(doc.nodes[child].data, NodeData::Element(_)) {
            continue;
        }
        let el = doc.element(child);
        let Some(section) = to_section_name(&el.name) else {
            continue;
        };
        if !is_symbol_section(section) {
            continue;
        }
        let is_properties = section == "Properties";
        let section_kind = if is_properties {
            SYMBOL_KIND_STRUCT
        } else {
            SYMBOL_KIND_CLASS
        };
        let member_kind = if is_properties {
            SYMBOL_KIND_FIELD
        } else {
            SYMBOL_KIND_METHOD
        };
        let children = doc
            .element(child)
            .children
            .iter()
            .filter(|&&c| matches!(doc.nodes[c].data, NodeData::Element(_)))
            .map(|&c| flat_member_face(text, doc.element(c), member_kind))
            .collect();
        symbols.push(span_face(text, el, section, section_kind, children));
    }
    Some(symbols)
}

/// Section symbol (with child symbols). range=full span, selectionRange=open-tag span.
fn span_face(
    text: &str,
    el: &kode_parser::xml::ElementData,
    name: &str,
    kind: &'static str,
    children: Vec<DocumentSymbolFace>,
) -> DocumentSymbolFace {
    let range = full_range(text, el);
    DocumentSymbolFace {
        name: name.to_string(),
        detail: String::new(),
        kind,
        selection_range: tag_range(text, el),
        range,
        children,
    }
}

/// Member symbol (flat: children always empty, same shape as the TS DocumentSymbol default).
fn flat_member_face(
    text: &str,
    el: &kode_parser::xml::ElementData,
    kind: &'static str,
) -> DocumentSymbolFace {
    let name = el.name.clone();
    span_face(text, el, &name, kind, Vec::new())
}

/// Isomorphic with TS elementFullRange: open-tag start -> closing-tag end; self-closing ends at the open tag's end.
fn full_range(text: &str, el: &kode_parser::xml::ElementData) -> LspRange {
    let end = if el.self_closing {
        el.open_span.end
    } else {
        el.close_span.end
    };
    LspRange {
        start: byte_offset_to_position(text, el.open_span.start),
        end: byte_offset_to_position(text, end),
    }
}

/// Isomorphic with TS elementTagRange: the whole open-tag span (where the name lives, always ⊆ full_range).
fn tag_range(text: &str, el: &kode_parser::xml::ElementData) -> LspRange {
    LspRange {
        start: byte_offset_to_position(text, el.open_span.start),
        end: byte_offset_to_position(text, el.open_span.end),
    }
}

// ---------------------------------------------------------------------------
// golden (recomputed comparison against TS tests/kodeDocumentSymbolsParity.test.ts)
// ---------------------------------------------------------------------------

pub const DOCUMENT_SYMBOLS_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/document-symbols-parity.json";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    symbol_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(Debug, serde::Serialize)]
struct GoldenFile {
    file: String,
    kind: &'static str,
    symbols: Vec<DocumentSymbolFace>,
}

/// Walk the fixture corpus and output the Outline symbol-tree JSON per def file (the TS mirror test
/// recomputes the same golden with the existing defParser primitives; bidirectional gate).
pub fn dump_document_symbols_golden(repo_root: &std::path::Path) -> String {
    use kode_parser::json::{collect_corpus, PARITY_CORPORA};

    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let mut dump = GoldenDump {
        generator: "kode-server dump-document-symbols-golden",
        file_count: 0,
        symbol_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        // The TS provider registers only defDocumentSelector; non-def files do not enter the golden.
        if *kind != "def" {
            continue;
        }
        let Some(symbols) = document_symbols(text) else {
            continue;
        };
        dump.symbol_count += count_symbols(&symbols);
        dump.files.push(GoldenFile {
            file: path.clone(),
            kind: "def",
            symbols,
        });
    }
    dump.file_count = dump.files.len();
    serde_json::to_string_pretty(&dump).expect("serialize")
}

fn count_symbols(symbols: &[DocumentSymbolFace]) -> usize {
    symbols.iter().map(|s| 1 + count_symbols(&s.children)).sum()
}

// ---------------------------------------------------------------------------
// Unit pins (synthetic text; the golden side is covered by an independent test isomorphic with references_golden)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn names(symbols: &[DocumentSymbolFace]) -> Vec<&str> {
        symbols.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn section_filter_and_kinds() {
        // Parent/Interfaces/Components/Volatile/unknown/lowercase do not enter the Outline;
        // Properties=Struct+Field, method sections=Class+Method, document order.
        let text = "<root>\n\
            <Parent> Avatar </Parent>\n\
            <Volatile>\n<ghost/>\n</Volatile>\n\
            <Interfaces>\n<interface> ROLE </interface>\n</Interfaces>\n\
            <Components>\n<Bag/>\n</Components>\n\
            <properties>\n<lowercase/>\n</properties>\n\
            <Properties>\n<hp/>\n<level/>\n</Properties>\n\
            <BaseMethods>\n<doSpell/>\n</BaseMethods>\n\
            <CellMethods>\n<onEnterCell/>\n</CellMethods>\n\
            <ClientMethods>\n<onLevelUp/>\n</ClientMethods>\n\
            </root>";
        let symbols = document_symbols(text).expect("root");
        assert_eq!(
            names(&symbols),
            vec!["Properties", "BaseMethods", "CellMethods", "ClientMethods"]
        );
        assert_eq!(symbols[0].kind, SYMBOL_KIND_STRUCT);
        assert_eq!(symbols[1].kind, SYMBOL_KIND_CLASS);
        assert_eq!(
            symbols[0]
                .children
                .iter()
                .map(|s| s.kind)
                .collect::<Vec<_>>(),
            vec![SYMBOL_KIND_FIELD, SYMBOL_KIND_FIELD]
        );
        assert_eq!(
            symbols[1]
                .children
                .iter()
                .map(|s| s.kind)
                .collect::<Vec<_>>(),
            vec![SYMBOL_KIND_METHOD]
        );
        assert_eq!(
            symbols[1]
                .children
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["doSpell"]
        );
    }

    #[test]
    fn member_children_always_empty() {
        // <Arg> inside method members does not descend (TS new DocumentSymbol defaults children=[]).
        let text = "<root>\n\
            <BaseMethods>\n\
            <doSpell>\n<Arg><Type> UINT32 </Type></Arg>\n</doSpell>\n\
            </BaseMethods>\n\
            </root>";
        let symbols = document_symbols(text).expect("root");
        assert_eq!(symbols.len(), 1);
        assert_eq!(names(&symbols[0].children), vec!["doSpell"]);
        assert!(symbols[0].children[0].children.is_empty());
    }

    #[test]
    fn ranges_full_vs_selection_and_self_closing() {
        let text = "<root>\n\
            <Properties>\n\
            <hp>\n<Type> UINT32 </Type>\n</hp>\n\
            <bag/>\n\
            </Properties>\n\
            </root>";
        let symbols = document_symbols(text).expect("root");
        let section = &symbols[0];
        // Section: open-tag start (1,0) -> closing-tag end (6,13); `</Properties>` ends at column 13.
        assert_eq!(
            section.range.start,
            crate::definition::LspPosition {
                line: 1,
                character: 0
            }
        );
        assert_eq!(
            section.range.end,
            crate::definition::LspPosition {
                line: 6,
                character: 13
            }
        );
        // selectionRange = open-tag span (1,0)-(1,12).
        assert_eq!(
            section.selection_range,
            crate::definition::LspRange {
                start: crate::definition::LspPosition {
                    line: 1,
                    character: 0
                },
                end: crate::definition::LspPosition {
                    line: 1,
                    character: 12
                },
            }
        );
        let hp = &section.children[0];
        assert_eq!(
            hp.range.start,
            crate::definition::LspPosition {
                line: 2,
                character: 0
            }
        );
        assert_eq!(
            hp.range.end,
            crate::definition::LspPosition {
                line: 4,
                character: 5
            }
        );
        // Self-closing: range end = open-tag end (5,6).
        let bag = &section.children[1];
        assert_eq!(
            bag.range.start,
            crate::definition::LspPosition {
                line: 5,
                character: 0
            }
        );
        assert_eq!(
            bag.range.end,
            crate::definition::LspPosition {
                line: 5,
                character: 6
            }
        );
        assert_eq!(bag.selection_range, bag.range);
    }

    #[test]
    fn detail_empty_and_empty_section_kept() {
        // Empty section (no members) still emitted (the TS section symbol pushes unconditionally); detail always the empty string.
        let text = "<root>\n<CellMethods>\n</CellMethods>\n</root>";
        let symbols = document_symbols(text).expect("root");
        assert_eq!(names(&symbols), vec!["CellMethods"]);
        assert!(symbols[0].children.is_empty());
        assert_eq!(symbols[0].detail, "");
    }

    #[test]
    fn no_root_returns_none() {
        assert!(document_symbols("").is_none());
        assert!(document_symbols("not xml at all").is_none());
    }

    #[test]
    fn text_children_are_not_symbols() {
        // Text/comment child nodes within a section produce no symbols (only element children).
        let text = "<root>\n\
            <Properties>\n\
            stray text\n\
            <!-- comment -->\n\
            <hp/>\n\
            </Properties>\n\
            </root>";
        let symbols = document_symbols(text).expect("root");
        assert_eq!(names(&symbols[0].children), vec!["hp"]);
    }

    /// RUST-149 cross-cutting registration (pure face): this face is a text->tree pure function, structurally
    /// carrier-free on all four dimensions -- cancel (synchronous, zero awaits, no cancellation point) / cold (no workspace index
    /// or cache, cold and hot share one path) / root (per-document face, no root state; unroot semantics belong to
    /// the index faces' references/workspace_symbols pins). stale has no cache carrier; pin its
    /// observable contract: repeated evaluation of the same text is deterministic with no drift; a new text generation means a new tree.
    #[test]
    fn rust_149_recompute_swaps_tree_and_is_stateless() {
        let v1 = "<root>\n<Properties>\n<hp/>\n</Properties>\n</root>";
        let first = document_symbols(v1).expect("root");
        let second = document_symbols(v1).expect("root");
        assert_eq!(first, second, "同文本重复求值确定性(无隐藏状态漂移)");

        let v2 = "<root>\n<Properties>\n<hp/>\n</Properties>\n\
            <BaseMethods>\n<onTalk/>\n</BaseMethods>\n</root>";
        let swapped = document_symbols(v2).expect("root");
        assert_ne!(first, swapped, "文本换代即换树,不服务旧树");
        assert_eq!(names(&swapped), vec!["Properties", "BaseMethods"]);
        assert_eq!(names(&swapped[1].children), vec!["onTalk"]);
    }
}
