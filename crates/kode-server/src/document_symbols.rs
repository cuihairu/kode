//! RUST-139 批 1:def 文档符号(Outline)语料面——Properties/三方法段作
//! 容器符号、段内声明作子符号,与 TS KBEngineDocumentSymbolProvider
//! (IDE-NAV-005,src/languageProviders/references.ts)逐点同构。
//!
//! 语义钉(TS 同构):
//! - 只出 Properties/BaseMethods/CellMethods/ClientMethods 四段(toSectionName
//!   精确匹配 8 规范名后按 DEF_SYMBOL_SECTIONS 过滤;Parent/Interfaces/
//!   Components/Volatile 与未知段不进 Outline);
//! - 段符号 kind = Properties→Struct / 方法段→Class;段内**直接**元素子节点
//!   = Properties→Field / 方法段→Method(成员不再下钻:TS `new
//!   DocumentSymbol` 默认 children=[],方法内 <Arg> 等不产生符号);
//! - range = 元素全跨度(开标签头 → 闭合标签尾;自闭合到开标签尾),
//!   selectionRange = 名字所在开标签跨度(恒 ⊆ range);
//! - detail 恒空串,序 = 文档序;解析无根 → None。
//!
//! WorkspaceSymbol(IDE-NAV-006)依赖 entityMapping 运行时语义索引
//! (ResolvedDefinitionSemantics 继承链/组件 rebase),留批 2;期间生产
//! 服务面仍是 TS,本模块只落纯库(同 references.rs 批 1 边界)。

use kode_parser::xml::{self, NodeData};

use crate::definition::{byte_offset_to_position, LspRange};

/// LSP DocumentSymbol kind(字符串面,与 TS `vscode.SymbolKind` 枚举名同形;
/// golden/镜像以此字符串对拍,协议数值映射属 TS provider 投影细节)。
pub const SYMBOL_KIND_STRUCT: &str = "Struct";
pub const SYMBOL_KIND_CLASS: &str = "Class";
pub const SYMBOL_KIND_FIELD: &str = "Field";
pub const SYMBOL_KIND_METHOD: &str = "Method";

/// TS `toSectionName` 同构:8 规范段名精确匹配(大小写敏感,小写变体不算)。
fn to_section_name(name: &str) -> Option<&str> {
    match name {
        "Parent" | "Interfaces" | "Components" | "Properties" | "BaseMethods" | "CellMethods"
        | "ClientMethods" | "Volatile" => Some(name),
        _ => None,
    }
}

/// TS `DEF_SYMBOL_SECTIONS` 同构:进 Outline 的四段。
fn is_symbol_section(section: &str) -> bool {
    matches!(
        section,
        "Properties" | "BaseMethods" | "CellMethods" | "ClientMethods"
    )
}

/// 一条文档符号:名字/空 detail/kind/全跨度/开标签选择跨度/子符号。
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

/// def 文本 → Outline 符号树。解析无根 → None(TS parseDefAst 失败 null 同形)。
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

/// 段符号(带子符号)。range=全跨度,selectionRange=开标签跨度。
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

/// 成员符号(平面:children 恒空,TS DocumentSymbol 默认值同形)。
fn flat_member_face(
    text: &str,
    el: &kode_parser::xml::ElementData,
    kind: &'static str,
) -> DocumentSymbolFace {
    let name = el.name.clone();
    span_face(text, el, &name, kind, Vec::new())
}

/// TS elementFullRange 同构:开标签头 → 闭合标签尾;自闭合到开标签尾。
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

/// TS elementTagRange 同构:开标签整体跨度(名字所在,恒 ⊆ full_range)。
fn tag_range(text: &str, el: &kode_parser::xml::ElementData) -> LspRange {
    LspRange {
        start: byte_offset_to_position(text, el.open_span.start),
        end: byte_offset_to_position(text, el.open_span.end),
    }
}

// ---------------------------------------------------------------------------
// golden(TS tests/kodeDocumentSymbolsParity.test.ts 复算对拍)
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

/// 遍历 fixture 语料,逐 def 文件输出 Outline 符号树 JSON(TS 镜像测试
/// 用现有 defParser 原语复算同一 golden,双向门禁)。
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
        // TS provider 只注册 defDocumentSelector;非 def 文件不进 golden。
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
// 单元钉(合成文本;golden 侧由 references_golden 同构的独立测试盖)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn names(symbols: &[DocumentSymbolFace]) -> Vec<&str> {
        symbols.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn section_filter_and_kinds() {
        // Parent/Interfaces/Components/Volatile/未知/小写不进 Outline;
        // Properties=Struct+Field,方法段=Class+Method,文档序。
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
        // 方法成员内 <Arg> 不下钻(TS new DocumentSymbol 默认 children=[])。
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
        // 段:开标签头(1,0) → 闭标签尾(6,13)「</Properties>」13 字符终位。
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
        // selectionRange = 开标签跨度(1,0)-(1,12)。
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
        // 自闭合:range 终 = 开标签尾(5,6)。
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
        // 空段(无成员)照出(TS 段符号无条件 push),detail 恒空串。
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
        // 段内文本/注释子节点不产生符号(只元素子节点)。
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

    /// RUST-149 横切登记(纯面):本 face 是 text→树 纯函数,四维结构性
    /// 无载体——cancel(同步零 await 无取消位)/cold(无 workspace 索引
    /// 与缓存,冷热同路)/root(per-document 面,无根状态,撤根语义归
    /// 索引面 references/workspace_symbols 钉)。stale 无缓存载体,钉其
    /// 可观察契约:同文本重复求值确定性无漂移,文本换代即换树。
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
